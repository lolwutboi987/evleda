import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  approvalRecordSchema,
  artifactRecordSchema,
  designRevisionSchema,
  designRunSchema,
  evidenceRecordSchema,
  projectSchema
} from "../contracts/results.js";
import { canonicalJson, contentIdentity } from "../core/canonical.js";
import { DomainError } from "../domain/errors.js";
import { toolInvocationRecordSchema } from "../domain/invocation-ledger.js";
import type { ApprovedNativeProcessContractRegistryV2 } from "../domain/native-process-plan.js";
import {
  assertWorkflowStateSnapshot,
  assertWorkflowStateTransitions
} from "../domain/state-transitions.js";
import {
  replaceFileAtomically,
  syncContainingDirectory,
  syncFileHandle,
  type DurabilityBarrierObserver
} from "./durability.js";
import { acquireExclusiveFileLock, reclaimStaleExactFileLock } from "./file-lock.js";
import type {
  ApprovalRecord,
  ArtifactRecord,
  DesignRevision,
  DesignRun,
  EvidenceRecord,
  Project,
  ToolInvocationRecord
} from "../domain/types.js";
import {
  EVLEDA_AUDIT_OUTBOX_SCHEMA_VERSION,
  type AuditEvent
} from "./audit-log.js";

export const LEGACY_EVLEDA_STATE_SCHEMA_VERSION = "evleda.state.v1" as const;
export const LEGACY_EVLEDA_STATE_V2_SCHEMA_VERSION = "evleda.state.v2" as const;
export const LEGACY_EVLEDA_STATE_V3_SCHEMA_VERSION = "evleda.state.v3" as const;
export const EVLEDA_STATE_SCHEMA_VERSION = "evleda.state.v4" as const;

export type StateStoreCommitPhase =
  | "replacement"
  | "directory_sync"
  | "temporary_cleanup"
  | "lock_release";

export type TransactionPostCommitPhase =
  | Exclude<StateStoreCommitPhase, "replacement">
  | "journal_update";

export interface AtomicStateStoreOptions {
  /** Test/embedding hook. Throwing at replacement is pre-commit; later phases are post-commit. */
  readonly phaseHook?: (phase: StateStoreCommitPhase) => void | Promise<void>;
  /** Counts barriers without replacing or weakening them. */
  readonly durabilityObserver?: DurabilityBarrierObserver;
  /** Trusted operation-specific command validators required to read a nonempty invocation ledger. */
  readonly approvedNativeProcessContracts?: ApprovedNativeProcessContractRegistryV2;
}

interface StateMaintenanceJournal {
  readonly schemaVersion: "evleda.state-maintenance.v1";
  readonly status: "prepared" | "repair_required";
  readonly transactionId: string;
  readonly stateRevision: number;
  readonly stateIdentity: ReturnType<typeof contentIdentity>;
  readonly lockIdentity: ReturnType<typeof contentIdentity>;
  readonly temporaryBasename: string;
}

export interface CommittedStateTransaction<Result> {
  readonly state: EvlEdaState;
  readonly result: Result;
}

interface PendingPostCommitMaintenance {
  readonly phase: TransactionPostCommitPhase;
  readonly cause: unknown;
  readonly repair: () => Promise<void>;
}

export interface CommittedStateTransactionFailure<Result = unknown> extends DomainError {
  readonly transactionOutcome: "committed_repair_required";
  readonly committed: CommittedStateTransaction<Result>;
  readonly maintenancePhases: readonly TransactionPostCommitPhase[];
  readonly maintenanceRepairStatus: "pending" | "succeeded" | "failed";
  readonly maintenanceRepairFailure: unknown;
  readonly auditRepairStatus: "not_attempted" | "succeeded" | "failed";
  readonly auditRepairFailure: unknown;
  repairMaintenance(): Promise<void>;
  recordAuditRepair(status: "succeeded" | "failed", failure?: unknown): void;
}

const authenticCommittedFailures = new WeakSet<object>();

class AuthenticCommittedStateTransactionError<Result = unknown> extends DomainError
  implements CommittedStateTransactionFailure<Result> {
  public readonly transactionOutcome = "committed_repair_required" as const;
  public maintenanceRepairStatus: "pending" | "succeeded" | "failed" = "pending";
  public maintenanceRepairFailure: unknown;
  public auditRepairStatus: "not_attempted" | "succeeded" | "failed" = "not_attempted";
  public auditRepairFailure: unknown;
  #repairPromise: Promise<void> | undefined;

  public constructor(
    public readonly committed: CommittedStateTransaction<Result>,
    private readonly maintenance: readonly PendingPostCommitMaintenance[],
    private readonly completeRepair: () => Promise<void>
  ) {
    super(
      "ARTIFACT_INTEGRITY_ERROR",
      "State transaction committed, but post-commit maintenance failed: " +
        maintenance.map((failure) =>
          `${failure.phase}: ${failure.cause instanceof Error ? failure.cause.message : String(failure.cause)}`
        ).join("; ") +
        "; retry the exact command to recover its durable result",
      {
        transactionOutcome: "committed_repair_required",
        stateRevision: committed.state.revision,
        phases: maintenance.map((failure) => failure.phase),
        failures: maintenance.map((failure) => ({
          phase: failure.phase,
          message: failure.cause instanceof Error ? failure.cause.message : String(failure.cause)
        })),
        requiredAction: "Retry the exact command and idempotency key; do not issue a different mutation."
      },
      true
    );
    this.name = "CommittedStateTransactionError";
    authenticCommittedFailures.add(this);
  }

  public get maintenancePhases(): readonly TransactionPostCommitPhase[] {
    return this.maintenance.map((failure) => failure.phase);
  }

  public async repairMaintenance(): Promise<void> {
    if (this.maintenanceRepairStatus === "succeeded") return;
    if (this.#repairPromise !== undefined) return this.#repairPromise;
    const pendingRepair = (async () => {
      try {
        await this.completeRepair();
      } catch (error) {
        this.maintenanceRepairStatus = "failed";
        this.maintenanceRepairFailure = error;
        throw this.maintenanceRepairFailure;
      }
      this.maintenanceRepairStatus = "succeeded";
      this.maintenanceRepairFailure = undefined;
    })();
    this.#repairPromise = pendingRepair;
    try {
      await pendingRepair;
    } catch (error) {
      if (this.#repairPromise === pendingRepair) this.#repairPromise = undefined;
      throw error;
    }
  }

  public recordAuditRepair(status: "succeeded" | "failed", failure?: unknown): void {
    this.auditRepairStatus = status;
    this.auditRepairFailure = failure;
  }
}

const committedStateTransactionFailure = <Result>(
  committed: CommittedStateTransaction<Result>,
  maintenance: readonly PendingPostCommitMaintenance[],
  completeRepair: () => Promise<void>
): CommittedStateTransactionFailure<Result> =>
  new AuthenticCommittedStateTransactionError(committed, maintenance, completeRepair);

export const isCommittedStateTransactionError = (
  value: unknown
): value is CommittedStateTransactionFailure =>
  typeof value === "object" && value !== null && authenticCommittedFailures.has(value);

export interface IdempotencyRecord {
  readonly key: string;
  readonly requestDigest: string;
  readonly operation: string;
  readonly result: unknown;
  readonly createdAt: string;
}

export interface EvlEdaState {
  readonly schemaVersion: typeof EVLEDA_STATE_SCHEMA_VERSION;
  readonly revision: number;
  readonly projects: Readonly<Record<string, Project>>;
  readonly runs: Readonly<Record<string, DesignRun>>;
  readonly revisions: Readonly<Record<string, DesignRevision>>;
  readonly artifacts: Readonly<Record<string, ArtifactRecord>>;
  readonly evidence: Readonly<Record<string, EvidenceRecord>>;
  readonly approvals: Readonly<Record<string, ApprovalRecord>>;
  readonly invocations: Readonly<Record<string, ToolInvocationRecord>>;
  readonly idempotency: Readonly<Record<string, IdempotencyRecord>>;
  readonly auditOutboxSchemaVersion?: typeof EVLEDA_AUDIT_OUTBOX_SCHEMA_VERSION;
  readonly auditOutbox: Readonly<Record<string, AuditEvent>>;
}

export interface MutableEvlEdaState {
  schemaVersion: typeof EVLEDA_STATE_SCHEMA_VERSION;
  revision: number;
  projects: Record<string, Project>;
  runs: Record<string, DesignRun>;
  revisions: Record<string, DesignRevision>;
  artifacts: Record<string, ArtifactRecord>;
  evidence: Record<string, EvidenceRecord>;
  approvals: Record<string, ApprovalRecord>;
  invocations: Record<string, ToolInvocationRecord>;
  idempotency: Record<string, IdempotencyRecord>;
  auditOutboxSchemaVersion?: typeof EVLEDA_AUDIT_OUTBOX_SCHEMA_VERSION;
  auditOutbox: Record<string, AuditEvent>;
}

const emptyState = (): EvlEdaState => ({
  schemaVersion: EVLEDA_STATE_SCHEMA_VERSION,
  revision: 0,
  projects: {},
  runs: {},
  revisions: {},
  artifacts: {},
  evidence: {},
  approvals: {},
  invocations: {},
  idempotency: {},
  auditOutboxSchemaVersion: EVLEDA_AUDIT_OUTBOX_SCHEMA_VERSION,
  auditOutbox: {}
});

const cloneState = (state: EvlEdaState): MutableEvlEdaState =>
  structuredClone(state) as MutableEvlEdaState;

const assertPlainRecord = (name: string, value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError("ARTIFACT_INTEGRITY_ERROR", `State file has an invalid ${name} map`);
  }
  const record = value as Record<string, unknown>;
  const ownNames = Object.getOwnPropertyNames(record);
  if (
    (Object.getPrototypeOf(record) !== Object.prototype && Object.getPrototypeOf(record) !== null) ||
    Object.getOwnPropertySymbols(record).length !== 0 ||
    ownNames.length !== Object.keys(record).length ||
    ownNames.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      return descriptor?.enumerable !== true || descriptor.get !== undefined || descriptor.set !== undefined;
    })
  ) {
    throw new DomainError("ARTIFACT_INTEGRITY_ERROR", `State ${name} map is not plain enumerable data`);
  }
  return record;
};

class PersistedJsonScanner {
  #index = 0;
  #depth = 0;

  public constructor(private readonly text: string) {}

  public scan(): void {
    this.#skipWhitespace();
    this.#scanValue();
    this.#skipWhitespace();
    if (this.#index !== this.text.length) this.#malformed();
  }

  #malformed(): never {
    throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "State file contains invalid JSON");
  }

  #skipWhitespace(): void {
    while (this.#index < this.text.length) {
      const code = this.text.charCodeAt(this.#index);
      if (code !== 0x09 && code !== 0x0a && code !== 0x0d && code !== 0x20) break;
      this.#index += 1;
    }
  }

  #scanValue(): void {
    this.#depth += 1;
    if (this.#depth > 512) this.#malformed();
    const character = this.text[this.#index];
    if (character === '"') {
      this.#scanString(false);
    } else if (character === "{") {
      this.#scanObject();
    } else if (character === "[") {
      this.#scanArray();
    } else if (character === "t") {
      this.#consume("true");
    } else if (character === "f") {
      this.#consume("false");
    } else if (character === "n") {
      this.#consume("null");
    } else if (
      character === "-" ||
      (character !== undefined && character >= "0" && character <= "9")
    ) {
      this.#scanNumber();
    } else {
      this.#malformed();
    }
    this.#depth -= 1;
  }

  #consume(literal: string): void {
    if (!this.text.startsWith(literal, this.#index)) this.#malformed();
    this.#index += literal.length;
  }

  #scanString(decode: boolean): string {
    const start = this.#index;
    const contentStart = start + 1;
    let escaped = false;
    this.#index += 1;
    while (this.#index < this.text.length) {
      const character = this.text[this.#index]!;
      const code = character.charCodeAt(0);
      if (character === '"') {
        this.#index += 1;
        if (!decode) return "";
        if (!escaped) return this.text.slice(contentStart, this.#index - 1);
        try {
          return JSON.parse(this.text.slice(start, this.#index)) as string;
        } catch {
          return this.#malformed();
        }
      }
      if (code < 0x20) this.#malformed();
      if (character === "\\") {
        escaped = true;
        this.#index += 1;
        const escape = this.text[this.#index];
        if (escape === undefined || !/["\\/bfnrtu]/u.test(escape)) this.#malformed();
        if (escape === "u") {
          const digits = this.text.slice(this.#index + 1, this.#index + 5);
          if (!/^[0-9a-fA-F]{4}$/u.test(digits)) this.#malformed();
          this.#index += 4;
        }
      }
      this.#index += 1;
    }
    return this.#malformed();
  }

  #scanNumber(): void {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(
      this.text.slice(this.#index)
    );
    if (match === null) this.#malformed();
    if (!Number.isFinite(Number(match[0]))) this.#malformed();
    this.#index += match[0].length;
  }

  #scanArray(): void {
    this.#index += 1;
    this.#skipWhitespace();
    if (this.text[this.#index] === "]") {
      this.#index += 1;
      return;
    }
    for (;;) {
      this.#scanValue();
      this.#skipWhitespace();
      const separator = this.text[this.#index];
      this.#index += 1;
      if (separator === "]") return;
      if (separator !== ",") this.#malformed();
      this.#skipWhitespace();
    }
  }

  #scanObject(): void {
    this.#index += 1;
    this.#skipWhitespace();
    const members = new Set<string>();
    if (this.text[this.#index] === "}") {
      this.#index += 1;
      return;
    }
    for (;;) {
      if (this.text[this.#index] !== '"') this.#malformed();
      const key = this.#scanString(true);
      if (members.has(key)) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "State file contains a duplicate JSON object member",
          { key }
        );
      }
      members.add(key);
      this.#skipWhitespace();
      if (this.text[this.#index] !== ":") this.#malformed();
      this.#index += 1;
      this.#skipWhitespace();
      this.#scanValue();
      this.#skipWhitespace();
      const separator = this.text[this.#index];
      this.#index += 1;
      if (separator === "}") return;
      if (separator !== ",") this.#malformed();
      this.#skipWhitespace();
    }
  }
}

const STATE_REQUIRED_KEYS = Object.freeze([
  "approvals",
  "artifacts",
  "auditOutbox",
  "evidence",
  "idempotency",
  "invocations",
  "projects",
  "revision",
  "revisions",
  "runs",
  "schemaVersion"
]);

const assertStateEnvelope = (state: EvlEdaState): void => {
  const root = assertPlainRecord("root", state);
  const keys = Object.keys(root);
  const allowed = new Set([...STATE_REQUIRED_KEYS, "auditOutboxSchemaVersion"]);
  if (
    state.schemaVersion !== EVLEDA_STATE_SCHEMA_VERSION ||
    STATE_REQUIRED_KEYS.some((key) => !Object.hasOwn(root, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "State file has an invalid v4 envelope", {
      actualSchemaVersion: state.schemaVersion,
      keys
    });
  }
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) {
    throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "State file has an invalid revision", {
      revision: state.revision
    });
  }
  assertPlainRecord("idempotency", state.idempotency);
  assertPlainRecord("audit outbox", state.auditOutbox);
};

const assertWorkflowRecordSchemas = (
  state: EvlEdaState,
  approvedNativeProcessContracts?: ApprovedNativeProcessContractRegistryV2
): void => {
  assertStateEnvelope(state);
  const recordSchemas = [
    ["projects", state.projects, projectSchema],
    ["runs", state.runs, designRunSchema],
    ["revisions", state.revisions, designRevisionSchema],
    ["artifacts", state.artifacts, artifactRecordSchema],
    ["evidence", state.evidence, evidenceRecordSchema],
    ["approvals", state.approvals, approvalRecordSchema],
    ["invocations", state.invocations, toolInvocationRecordSchema]
  ] as const;
  for (const [name, value, schema] of recordSchemas) {
    const record = assertPlainRecord(name, value);
    for (const [key, entry] of Object.entries(record)) {
      const result = schema.safeParse(entry);
      if (!result.success) {
        throw new DomainError("ARTIFACT_INTEGRITY_ERROR", `State ${name} record is invalid`, {
          key,
          issues: result.error.issues.slice(0, 10).map((issue) => ({
            path: issue.path,
            code: issue.code,
            message: issue.message
          }))
        });
      }
    }
  }
  assertWorkflowStateSnapshot(
    state,
    approvedNativeProcessContracts === undefined ? {} : { approvedNativeProcessContracts }
  );
};

const migrateLegacyState = (
  parsed: Readonly<Record<string, unknown>>,
  actualSchemaVersion:
    | typeof LEGACY_EVLEDA_STATE_SCHEMA_VERSION
    | typeof LEGACY_EVLEDA_STATE_V2_SCHEMA_VERSION
    | typeof LEGACY_EVLEDA_STATE_V3_SCHEMA_VERSION
): EvlEdaState => {
  const legacyInvocations = assertPlainRecord("legacy invocations", parsed.invocations);
  if (Object.keys(legacyInvocations).length !== 0) {
    throw new DomainError(
      "ARTIFACT_INTEGRITY_ERROR",
      "Legacy state contains unauthenticated invocation records that cannot be migrated",
      {
        actualSchemaVersion,
        invocationCount: Object.keys(legacyInvocations).length,
        requiredAction: "Remove or explicitly re-import legacy invocation records through a trusted migration tool."
      }
    );
  }
  // Only the state envelope version changes. Older invocation records were
  // pre-production and cannot be upcast: record V2 used plans without output
  // ceilings, while record V3 reused the legacy invocation-identity domain.
  // Existing revision, artifact, and evidence records (including every stored
  // identity) remain byte-for-byte values from the parsed legacy document; no
  // identity is recomputed here.
  return {
    ...parsed,
    schemaVersion: EVLEDA_STATE_SCHEMA_VERSION,
    invocations: {}
  } as unknown as EvlEdaState;
};

const serializeState = (state: EvlEdaState): string => `${canonicalJson(state)}\n`;

export class AtomicStateStore {
  readonly #file: string;
  readonly #lockFile: string;
  readonly #maintenanceFile: string;
  readonly #maintenanceLockFile: string;
  #tail: Promise<void> = Promise.resolve();

  public constructor(
    public readonly root: string,
    private readonly options: AtomicStateStoreOptions = {}
  ) {
    this.#file = path.join(root, "state.json");
    this.#lockFile = path.join(root, "state.lock");
    this.#maintenanceFile = path.join(root, "state-maintenance.json");
    this.#maintenanceLockFile = path.join(root, "state-maintenance.lock");
  }

  public initialize(): Promise<void> {
    return this.#initialize(true);
  }

  async #initialize(allowActivePrepared: boolean): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await this.#recoverMaintenanceJournalIfPresent(allowActivePrepared);
    try {
      await this.#readExisting();
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const release = await acquireExclusiveFileLock(this.#lockFile, {
        ...(this.options.durabilityObserver === undefined
          ? {}
          : { durabilityObserver: this.options.durabilityObserver })
      });
      try {
        try {
          await this.#readExisting();
        } catch (lockedError) {
          if ((lockedError as NodeJS.ErrnoException).code !== "ENOENT") {
            throw lockedError;
          }
          const maintenance = await this.#writeSerialized(serializeState(emptyState()));
          for (const pending of maintenance) await pending.repair();
        }
      } finally {
        await release();
      }
    }
  }

  async #recoverMaintenanceJournalIfPresent(allowActivePrepared: boolean): Promise<void> {
    try {
      await readFile(this.#maintenanceFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    try {
      await this.#recoverMaintenanceJournal(allowActivePrepared);
    } catch (error) {
      if (
        allowActivePrepared &&
        error instanceof DomainError &&
        error.code === "STAGE_ALREADY_RUNNING"
      ) {
        return;
      }
      throw error;
    }
  }

  public async read(): Promise<EvlEdaState> {
    await this.initialize();
    return this.#readExisting();
  }

  async #readExisting(): Promise<EvlEdaState> {
    const raw = await readFile(this.#file, "utf8");
    let parsed: unknown;
    try {
      new PersistedJsonScanner(raw).scan();
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "State file contains invalid JSON");
    }
    if (typeof parsed !== "object" || parsed === null || !("schemaVersion" in parsed)) {
      throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "State file has an unsupported schema", {
        actualSchemaVersion: undefined,
        supportedSchemaVersions: [
          EVLEDA_STATE_SCHEMA_VERSION,
          LEGACY_EVLEDA_STATE_V3_SCHEMA_VERSION,
          LEGACY_EVLEDA_STATE_V2_SCHEMA_VERSION,
          LEGACY_EVLEDA_STATE_SCHEMA_VERSION
        ]
      });
    }
    if (
      parsed.schemaVersion !== EVLEDA_STATE_SCHEMA_VERSION &&
      parsed.schemaVersion !== LEGACY_EVLEDA_STATE_V3_SCHEMA_VERSION &&
      parsed.schemaVersion !== LEGACY_EVLEDA_STATE_V2_SCHEMA_VERSION &&
      parsed.schemaVersion !== LEGACY_EVLEDA_STATE_SCHEMA_VERSION
    ) {
      throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "State file has an unsupported schema", {
        actualSchemaVersion: parsed.schemaVersion,
        supportedSchemaVersions: [
          EVLEDA_STATE_SCHEMA_VERSION,
          LEGACY_EVLEDA_STATE_V3_SCHEMA_VERSION,
          LEGACY_EVLEDA_STATE_V2_SCHEMA_VERSION,
          LEGACY_EVLEDA_STATE_SCHEMA_VERSION
        ]
      });
    }
    const state = parsed.schemaVersion === LEGACY_EVLEDA_STATE_SCHEMA_VERSION ||
      parsed.schemaVersion === LEGACY_EVLEDA_STATE_V2_SCHEMA_VERSION ||
      parsed.schemaVersion === LEGACY_EVLEDA_STATE_V3_SCHEMA_VERSION
      ? migrateLegacyState(
          parsed as Readonly<Record<string, unknown>>,
          parsed.schemaVersion
        )
      : parsed as EvlEdaState;
    const candidate = state as Partial<EvlEdaState>;
    if (!Number.isSafeInteger(candidate.revision) || (candidate.revision ?? -1) < 0) {
      throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "State file has an invalid revision", {
        revision: candidate.revision
      });
    }
    if (
      candidate.auditOutboxSchemaVersion !== undefined &&
      candidate.auditOutboxSchemaVersion !== EVLEDA_AUDIT_OUTBOX_SCHEMA_VERSION
    ) {
      throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "State file has an unsupported audit outbox schema", {
        actualSchemaVersion: candidate.auditOutboxSchemaVersion,
        supportedSchemaVersions: ["legacy-v1", EVLEDA_AUDIT_OUTBOX_SCHEMA_VERSION]
      });
    }
    if (
      typeof candidate.auditOutbox !== "object" ||
      candidate.auditOutbox === null ||
      Array.isArray(candidate.auditOutbox)
    ) {
      throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "State file has an invalid audit outbox");
    }
    assertWorkflowRecordSchemas(state, this.options.approvedNativeProcessContracts);
    return state;
  }

  async #writeMaintenanceJournal(journal: StateMaintenanceJournal): Promise<void> {
    const serialized = `${canonicalJson(journal)}\n`;
    const staging = path.join(this.root, `.state-maintenance-${randomUUID()}.tmp`);
    const handle = await open(staging, "wx");
    try {
      await handle.writeFile(serialized, "utf8");
      await syncFileHandle(handle, staging, this.options.durabilityObserver);
    } finally {
      await handle.close();
    }
    try {
      await replaceFileAtomically(staging, this.#maintenanceFile, serialized);
      await syncContainingDirectory(
        this.#maintenanceFile,
        this.options.durabilityObserver
      );
    } finally {
      await rm(staging, { force: true });
    }
  }

  async #clearMaintenanceJournalUnlocked(): Promise<void> {
    await rm(this.#maintenanceFile, { force: true });
    await syncContainingDirectory(
      this.#maintenanceFile,
      this.options.durabilityObserver
    );
  }

  async #discardPreparedMaintenanceJournalUnlocked(expectedTransactionId: string): Promise<void> {
    let current: StateMaintenanceJournal;
    try {
      current = JSON.parse(await readFile(this.#maintenanceFile, "utf8")) as StateMaintenanceJournal;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (current.transactionId !== expectedTransactionId) return;
    if (current.status !== "prepared") {
      throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Cannot discard published state repair debt");
    }
    await rm(path.join(this.root, current.temporaryBasename), { force: true });
    await this.#clearMaintenanceJournalUnlocked();
  }

  async #recoverMaintenanceJournal(
    allowActivePrepared = false,
    expectedTransactionId?: string
  ): Promise<void> {
    if (expectedTransactionId !== undefined) {
      try {
        const observed = JSON.parse(
          await readFile(this.#maintenanceFile, "utf8")
        ) as Partial<StateMaintenanceJournal>;
        if (observed.transactionId !== expectedTransactionId) return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }
    const releaseMaintenance = await acquireExclusiveFileLock(this.#maintenanceLockFile, {
      ...(allowActivePrepared ? { timeoutMs: 0 } : {}),
      ...(this.options.durabilityObserver === undefined
        ? {}
        : { durabilityObserver: this.options.durabilityObserver })
    });
    try {
      await this.#recoverMaintenanceJournalUnlocked(allowActivePrepared, expectedTransactionId);
    } finally {
      await releaseMaintenance();
    }
  }

  async #recoverMaintenanceJournalUnlocked(
    allowActivePrepared: boolean,
    expectedTransactionId?: string
  ): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.#maintenanceFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let journal: StateMaintenanceJournal;
    try {
      journal = JSON.parse(raw) as StateMaintenanceJournal;
    } catch {
      throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "State maintenance journal is invalid JSON");
    }
    if (
      expectedTransactionId !== undefined &&
      journal.transactionId !== expectedTransactionId
    ) {
      return;
    }
    if (
      journal.schemaVersion !== "evleda.state-maintenance.v1" ||
      !["prepared", "repair_required"].includes(journal.status) ||
      !Number.isSafeInteger(journal.stateRevision) ||
      journal.stateRevision < 1 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        journal.transactionId
      ) ||
      !/^\.state-[0-9a-f-]+\.tmp$/u.test(journal.temporaryBasename) ||
      journal.stateIdentity?.algorithm !== "sha256" ||
      !/^[0-9a-f]{64}$/u.test(journal.stateIdentity?.digest ?? "") ||
      !Number.isSafeInteger(journal.stateIdentity?.size) ||
      (journal.stateIdentity?.size ?? -1) < 0 ||
      journal.lockIdentity?.algorithm !== "sha256" ||
      !/^[0-9a-f]{64}$/u.test(journal.lockIdentity?.digest ?? "") ||
      !Number.isSafeInteger(journal.lockIdentity?.size) ||
      (journal.lockIdentity?.size ?? -1) < 0
    ) {
      throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "State maintenance journal is malformed");
    }
    const temporary = path.join(this.root, journal.temporaryBasename);
    let stateBytes: Buffer | undefined;
    let lockBytes: Buffer | undefined;
    try { stateBytes = await readFile(this.#file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try { lockBytes = await readFile(this.#lockFile); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const hadStateLock = lockBytes !== undefined;
    const actualState = stateBytes === undefined ? undefined : contentIdentity(stateBytes);
    const stateMatches = actualState !== undefined &&
      actualState.digest === journal.stateIdentity.digest &&
      actualState.size === journal.stateIdentity.size;
    if (journal.status === "prepared" && !stateMatches && lockBytes !== undefined) {
      const actualLock = contentIdentity(lockBytes);
      if (
        actualLock.digest !== journal.lockIdentity.digest ||
        actualLock.size !== journal.lockIdentity.size
      ) {
        throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Prepared state lock ownership changed");
      }
      try {
        await reclaimStaleExactFileLock(
          this.#lockFile,
          lockBytes,
          120_000,
          this.options.durabilityObserver
        );
      } catch (error) {
        if (
          allowActivePrepared &&
          error instanceof DomainError &&
          error.code === "STAGE_ALREADY_RUNNING"
        ) {
          return;
        }
        throw error;
      }
      lockBytes = undefined;
    }
    if (!stateMatches) {
      if (journal.status === "repair_required" || !hadStateLock) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Committed state no longer matches its durable repair journal",
          { transactionId: journal.transactionId, stateRevision: journal.stateRevision }
        );
      }
      if (lockBytes !== undefined) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "State maintenance journal does not match the current state while its lock remains live"
        );
      }
      await this.options.phaseHook?.("temporary_cleanup");
      await rm(temporary, { force: true });
      await this.#clearMaintenanceJournalUnlocked();
      return;
    }
    const parsed = JSON.parse(stateBytes!.toString("utf8")) as { readonly revision?: unknown };
    if (parsed.revision !== journal.stateRevision) {
      throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "State maintenance revision binding changed");
    }
    await this.options.phaseHook?.("directory_sync");
    await syncContainingDirectory(this.#file, this.options.durabilityObserver);
    if (lockBytes !== undefined) {
      const actualLock = contentIdentity(lockBytes);
      if (
        actualLock.digest !== journal.lockIdentity.digest ||
        actualLock.size !== journal.lockIdentity.size
      ) {
        throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "State maintenance lock ownership changed");
      }
      await this.options.phaseHook?.("lock_release");
      await rm(this.#lockFile).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
    await this.options.phaseHook?.("temporary_cleanup");
    await rm(temporary, { force: true });
    await this.#clearMaintenanceJournalUnlocked();
  }

  async #waitForPriorMaintenanceFinalization(): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      try {
        await readFile(this.#maintenanceFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      await delay(25);
    }
    throw new DomainError(
      "STAGE_ALREADY_RUNNING",
      "Timed out waiting for the previous state transaction to finalize its maintenance journal",
      { maintenanceFile: this.#maintenanceFile },
      true
    );
  }

  public async transaction<Result>(
    expectedRevision: number | undefined,
    mutate: (state: MutableEvlEdaState) => Result | Promise<Result>
  ): Promise<CommittedStateTransaction<Result>> {
    await this.#initialize(true);
    let release: (() => void) | undefined;
    const waitForPrevious = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await waitForPrevious;

    let releaseFileLock: (() => Promise<void>) | undefined;
    let releaseMaintenanceLock: (() => Promise<void>) | undefined;
    let committed: CommittedStateTransaction<Result> | undefined;
    let lockIdentity: ReturnType<typeof contentIdentity> | undefined;
    let transactionId: string | undefined;
    let hasDefinitelyNotCommittedFailure = false;
    let definitelyNotCommittedFailure: unknown;
    const postCommitMaintenance: PendingPostCommitMaintenance[] = [];
    const releaseHeldMaintenanceLock = async (): Promise<void> => {
      if (releaseMaintenanceLock === undefined) return;
      const pending = releaseMaintenanceLock;
      await pending();
      if (releaseMaintenanceLock === pending) releaseMaintenanceLock = undefined;
    };
    const completeCommittedRepair = async (): Promise<void> => {
      await releaseHeldMaintenanceLock();
      await this.#recoverMaintenanceJournal(false, transactionId!);
    };
    try {
      await mkdir(this.root, { recursive: true });
      releaseFileLock = await acquireExclusiveFileLock(this.#lockFile, {
        ...(this.options.durabilityObserver === undefined
          ? {}
          : { durabilityObserver: this.options.durabilityObserver })
      });
      await this.#waitForPriorMaintenanceFinalization();
      releaseMaintenanceLock = await acquireExclusiveFileLock(this.#maintenanceLockFile, {
        ...(this.options.durabilityObserver === undefined
          ? {}
          : { durabilityObserver: this.options.durabilityObserver })
      });
      lockIdentity = contentIdentity(await readFile(this.#lockFile));
      const current = await this.#readExisting();
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new DomainError("REVISION_CONFLICT", "State revision is stale", {
          expectedRevision,
          actualRevision: current.revision
        });
      }
      const mutable = cloneState(current);
      const result = await mutate(mutable);
      mutable.revision = current.revision + 1;
      let detached: MutableEvlEdaState;
      try {
        detached = structuredClone(mutable) as MutableEvlEdaState;
      } catch (error) {
        throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "State mutation is not detached plain data", {
          cause: error instanceof Error ? error.message : String(error)
        });
      }
      const next = detached as unknown as EvlEdaState;
      assertWorkflowRecordSchemas(next, this.options.approvedNativeProcessContracts);
      assertWorkflowStateTransitions(
        current,
        next,
        this.options.approvedNativeProcessContracts === undefined
          ? {}
          : { approvedNativeProcessContracts: this.options.approvedNativeProcessContracts }
      );
      const serialized = serializeState(next);
      transactionId = randomUUID();
      postCommitMaintenance.push(...await this.#writeSerialized(
        serialized,
        next.revision,
        lockIdentity,
        transactionId
      ));
      committed = { state: next, result };
    } catch (error) {
      hasDefinitelyNotCommittedFailure = true;
      definitelyNotCommittedFailure = isCommittedStateTransactionError(error)
        ? new DomainError(
            "ARTIFACT_INTEGRITY_ERROR",
            "A committed outcome from another transaction cannot authenticate this uncommitted transaction",
            { transactionOutcome: "definitely_not_committed" }
          )
        : error;
    } finally {
      try {
        if (releaseFileLock !== undefined) {
          try {
            await this.options.phaseHook?.("lock_release");
            await releaseFileLock();
          } catch (error) {
            if (committed === undefined) {
              if (!hasDefinitelyNotCommittedFailure) {
                hasDefinitelyNotCommittedFailure = true;
                definitelyNotCommittedFailure = error;
              }
            } else {
              postCommitMaintenance.push({
                phase: "lock_release",
                cause: error,
                repair: async () => {
                  await this.options.phaseHook?.("lock_release");
                  await releaseFileLock!();
                }
              });
            }
          }
        }
      } finally {
        release?.();
      }
    }

    if (hasDefinitelyNotCommittedFailure) {
      if (transactionId !== undefined && releaseMaintenanceLock !== undefined) {
        await this.#discardPreparedMaintenanceJournalUnlocked(transactionId).catch(() => undefined);
      }
      await releaseHeldMaintenanceLock().catch(() => undefined);
      throw definitelyNotCommittedFailure;
    }
    if (committed === undefined) {
      throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "State transaction ended without an outcome");
    }
    if (postCommitMaintenance.length > 0) {
      try {
        await releaseHeldMaintenanceLock();
      } catch (error) {
        postCommitMaintenance.push({
          phase: "lock_release",
          cause: error,
          repair: releaseHeldMaintenanceLock
        });
      }
      throw committedStateTransactionFailure(
        committed,
        postCommitMaintenance,
        completeCommittedRepair
      );
    }
    try {
      await this.#discardPreparedMaintenanceJournalUnlocked(transactionId!);
    } catch (error) {
      postCommitMaintenance.push({
        phase: "temporary_cleanup",
        cause: error,
        repair: () => this.#recoverMaintenanceJournal(false, transactionId!)
      });
    }
    try {
      await releaseHeldMaintenanceLock();
    } catch (error) {
      postCommitMaintenance.push({
        phase: "lock_release",
        cause: error,
        repair: releaseHeldMaintenanceLock
      });
    }
    if (postCommitMaintenance.length > 0) {
      throw committedStateTransactionFailure(
        committed,
        postCommitMaintenance,
        completeCommittedRepair
      );
    }
    return committed;
  }

  async #writeSerialized(
    serialized: string,
    stateRevision?: number,
    lockIdentity?: ReturnType<typeof contentIdentity>,
    transactionId?: string
  ): Promise<readonly PendingPostCommitMaintenance[]> {
    await mkdir(this.root, { recursive: true });
    const temporary = path.join(this.root, `.state-${randomUUID()}.tmp`);
    const postCommitMaintenance: PendingPostCommitMaintenance[] = [];
    let replacementCompleted = false;
    let hasDefinitelyNotCommittedFailure = false;
    let definitelyNotCommittedFailure: unknown;
    try {
      if (stateRevision !== undefined && lockIdentity !== undefined) {
        if (transactionId === undefined) {
          throw new DomainError(
            "ARTIFACT_INTEGRITY_ERROR",
            "State transaction maintenance journal lacks an ownership identity"
          );
        }
        await this.#writeMaintenanceJournal({
          schemaVersion: "evleda.state-maintenance.v1",
          status: "prepared",
          transactionId,
          stateRevision,
          stateIdentity: contentIdentity(serialized),
          lockIdentity,
          temporaryBasename: path.basename(temporary)
        });
      }
      const handle = await open(temporary, "wx");
      try {
        await handle.writeFile(serialized, "utf8");
        await syncFileHandle(handle, temporary, this.options.durabilityObserver);
      } finally {
        await handle.close();
      }
      await this.options.phaseHook?.("replacement");
      await replaceFileAtomically(temporary, this.#file, serialized);
      replacementCompleted = true;
      try {
        await this.options.phaseHook?.("directory_sync");
        await syncContainingDirectory(this.#file, this.options.durabilityObserver);
      } catch (error) {
        postCommitMaintenance.push({
          phase: "directory_sync",
          cause: error,
          repair: async () => {
            await this.options.phaseHook?.("directory_sync");
            await syncContainingDirectory(this.#file);
          }
        });
      }
    } catch (error) {
      hasDefinitelyNotCommittedFailure = true;
      definitelyNotCommittedFailure = error;
    } finally {
      try {
        await this.options.phaseHook?.("temporary_cleanup");
        await rm(temporary, { force: true });
      } catch (error) {
        if (!replacementCompleted) {
          if (!hasDefinitelyNotCommittedFailure) {
            hasDefinitelyNotCommittedFailure = true;
            definitelyNotCommittedFailure = error;
          }
        } else {
          postCommitMaintenance.push({
            phase: "temporary_cleanup",
            cause: error,
            repair: () => rm(temporary, { force: true })
          });
        }
      }
    }
    if (hasDefinitelyNotCommittedFailure) throw definitelyNotCommittedFailure;
    return postCommitMaintenance;
  }
}
