import { access, mkdir, open, readFile, truncate } from "node:fs/promises";
import path from "node:path";
import { canonicalIdentity, canonicalJson } from "../core/canonical.js";
import { DomainError } from "../domain/errors.js";
import {
  syncContainingDirectory,
  syncFileHandle,
  type DurabilityBarrierObserver
} from "./durability.js";
import { acquireExclusiveFileLock } from "./file-lock.js";

export const EVLEDA_AUDIT_ENVELOPE_SCHEMA_VERSION = "evleda.audit-event.v1" as const;
export const EVLEDA_AUDIT_EVENT_SCHEMA_VERSION = "evleda.audit-state-transition.v2" as const;
export const EVLEDA_AUDIT_OUTBOX_SCHEMA_VERSION = "evleda.audit-outbox.v2" as const;

export interface AuditEvent {
  readonly eventSchemaVersion?: typeof EVLEDA_AUDIT_EVENT_SCHEMA_VERSION;
  readonly type: string;
  readonly actorType: "system" | "model" | "human" | "tool";
  readonly actorId: string;
  readonly projectId?: string;
  readonly runId?: string;
  readonly subjectDigest?: string;
  readonly occurredAt: string;
  readonly payload: unknown;
}

export interface AuditEnvelope {
  readonly schemaVersion: typeof EVLEDA_AUDIT_ENVELOPE_SCHEMA_VERSION;
  readonly sequence: number;
  readonly previousDigest: string | null;
  readonly event: AuditEvent;
  readonly digest: string;
}

export interface AuditOutboxSnapshot {
  readonly stateRevision: number;
  readonly outboxSchemaVersion?: typeof EVLEDA_AUDIT_OUTBOX_SCHEMA_VERSION;
  readonly outbox: Readonly<Record<string, AuditEvent>>;
}

export type AuditLogDurabilityPhase = "file_sync" | "directory_sync" | "lock_release";

export interface HashChainAuditLogOptions {
  readonly phaseHook?: (phase: AuditLogDurabilityPhase) => void | Promise<void>;
  /** Counts barriers without replacing or weakening them. */
  readonly durabilityObserver?: DurabilityBarrierObserver;
}

interface AuditReadResult {
  readonly envelopes: readonly AuditEnvelope[];
  readonly completeByteLength: number;
  readonly partialTail?: Buffer;
}

const identityPayload = (envelope: Omit<AuditEnvelope, "digest">): string =>
  canonicalIdentity(envelope, "evleda.audit-envelope.v1").digest;

const eventIdentity = (event: AuditEvent): string =>
  canonicalIdentity(event, "evleda.audit-state-event.v1").digest;

const stateRevisionOf = (event: AuditEvent): number => {
  const candidate = event as unknown as Partial<AuditEvent> | null;
  const optionalString = (value: unknown): boolean => value === undefined || typeof value === "string";
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    (candidate.eventSchemaVersion !== undefined &&
      candidate.eventSchemaVersion !== EVLEDA_AUDIT_EVENT_SCHEMA_VERSION) ||
    typeof candidate.type !== "string" ||
    candidate.type.length === 0 ||
    !["system", "model", "human", "tool"].includes(candidate.actorType ?? "") ||
    typeof candidate.actorId !== "string" ||
    candidate.actorId.length === 0 ||
    typeof candidate.occurredAt !== "string" ||
    candidate.occurredAt.length === 0 ||
    !optionalString(candidate.projectId) ||
    !optionalString(candidate.runId) ||
    !optionalString(candidate.subjectDigest)
  ) {
    throw new DomainError(
      "ARTIFACT_INTEGRITY_ERROR",
      "Audit event has an invalid durable schema"
    );
  }
  const payload = candidate.payload;
  const stateRevision =
    typeof payload === "object" && payload !== null && "stateRevision" in payload
      ? (payload as { readonly stateRevision?: unknown }).stateRevision
      : undefined;
  if (!Number.isSafeInteger(stateRevision) || (stateRevision as number) < 1) {
    throw new DomainError(
      "ARTIFACT_INTEGRITY_ERROR",
      "Audit event is missing a positive integer state revision",
      { type: event.type, stateRevision }
    );
  }
  return stateRevision as number;
};

const isLegacyRecoveryEvent = (event: AuditEvent): boolean => {
  const payload = event.payload;
  return event.eventSchemaVersion === undefined &&
    event.type.endsWith(".recovered") &&
    typeof payload === "object" &&
    payload !== null &&
    "crashRecovered" in payload &&
    payload.crashRecovered === true;
};

const KNOWN_LEGACY_EVENT_PAIRS: Readonly<Record<string, readonly string[]>> = {
  "command.create_project.committed.recovered": ["project.created"],
  "command.start_design_run.committed.recovered": [
    "run.awaiting_requirements_approval",
    "run.requirements_blocked"
  ],
  "command.approve_requirements.committed.recovered": ["requirements.approved"],
  "command.submit_external_evidence.committed.recovered": ["evidence.external_submitted"],
  "command.qualify_revision.committed.recovered": ["revision.qualified"],
  "command.authorize_manufacturing_release.committed.recovered": [
    "revision.manufacturing_release_authorized"
  ],
  "command.revoke_attestation.committed.recovered": ["attestation.revoked"],
  "command.export_candidate_bundle.committed.recovered": ["bundle.candidate_exported"],
  "command.export_prototype_bundle.committed.recovered": ["bundle.prototype_exported"],
  "command.generate_bringup_plan.committed.recovered": ["generation.bringup_plan_created"],
  "command.generate_firmware_scaffold.committed.recovered": [
    "generation.firmware_scaffold_created"
  ],
  "command.resume_run.reserved.recovered": ["command.resume_run.reserved"],
  "command.rerun_stage.reserved.recovered": ["command.rerun_stage.reserved"],
  "run.resume_finished.recovered": ["run.resume_finished"],
  "run.completed.recovered": ["run.completed"],
  "stage.rerun_prepared.recovered": ["stage.rerun_prepared"],
  "stage.rerun_finished.recovered": ["stage.rerun_finished"],
  "stage.rerun_recorded.recovered": ["stage.rerun_recorded"],
  "stage.started.recovered": ["stage.started"],
  "stage.blocked.recovered": ["stage.blocked"],
  "stage.succeeded.recovered": ["stage.succeeded"]
};

const assertKnownLegacyEquivalent = (
  existing: AuditEvent,
  requested: AuditEvent,
  stateRevision: number
): void => {
  const fail = (reason: string): never => {
    throw new DomainError(
      "ARTIFACT_INTEGRITY_ERROR",
      "Legacy audit event equivalence cannot be proven; explicit migration is required",
      { stateRevision, existingType: existing.type, recoveredType: requested.type, reason }
    );
  };
  if (
    existing.eventSchemaVersion !== undefined ||
    requested.eventSchemaVersion !== undefined ||
    !isLegacyRecoveryEvent(requested)
  ) {
    fail("events are not an unversioned legacy pair");
  }
  const allowedBusinessTypes = KNOWN_LEGACY_EVENT_PAIRS[requested.type];
  if (allowedBusinessTypes === undefined || !allowedBusinessTypes.includes(existing.type)) {
    fail("recovered and business event types are not a known pair");
  }
  if (existing.actorType !== requested.actorType || existing.actorId !== requested.actorId) {
    fail("actor binding differs");
  }
  for (const binding of ["projectId", "runId", "subjectDigest"] as const) {
    const required = requested[binding];
    if (required !== undefined && existing[binding] !== required) {
      fail(`${binding} differs or is missing`);
    }
  }
  const existingPayload = existing.payload as Readonly<Record<string, unknown>>;
  const requestedPayload = requested.payload as Readonly<Record<string, unknown>>;
  for (const [key, value] of Object.entries(requestedPayload)) {
    if (key === "crashRecovered" || key === "stateRevision") {
      continue;
    }
    if (!(key in existingPayload) || canonicalJson(existingPayload[key]) !== canonicalJson(value)) {
      fail(`payload binding ${key} differs or is missing`);
    }
  }
};

const assertSameEvent = (
  existing: AuditEnvelope,
  requested: AuditEvent,
  stateRevision: number,
  allowLegacyRecoveryMismatch = false
): void => {
  const existingIdentity = eventIdentity(existing.event);
  const requestedIdentity = eventIdentity(requested);
  if (existingIdentity !== requestedIdentity) {
    if (
      allowLegacyRecoveryMismatch &&
      isLegacyRecoveryEvent(requested)
    ) {
      assertKnownLegacyEquivalent(existing.event, requested, stateRevision);
      return;
    }
    throw new DomainError(
      "ARTIFACT_INTEGRITY_ERROR",
      "Audit state revision is already bound to a different event",
      { stateRevision, existingIdentity, requestedIdentity }
    );
  }
};

export class HashChainAuditLog {
  readonly #file: string;
  readonly #lockFile: string;
  #tail: Promise<void> = Promise.resolve();
  #durabilityRepairRequired = false;

  public constructor(
    public readonly root: string,
    private readonly options: HashChainAuditLogOptions = {}
  ) {
    this.#file = path.join(root, "audit.jsonl");
    this.#lockFile = path.join(root, "audit.lock");
  }

  public async append(event: AuditEvent): Promise<AuditEnvelope> {
    return this.#exclusive(async () => {
      const stateRevision = stateRevisionOf(event);
      const read = await this.#readAuditUnlocked();
      const envelopes = [...read.envelopes];
      if (read.partialTail !== undefined) {
        if (stateRevision !== envelopes.length + 1) {
          throw new DomainError(
            "ARTIFACT_INTEGRITY_ERROR",
            "Audit log has a partial trailing record for a different state revision",
            { stateRevision, partialRevision: envelopes.length + 1 }
          );
        }
        this.#assertPartialTail(read.partialTail, event, envelopes.at(-1));
        await this.#discardPartialTail(read.completeByteLength);
      }
      const existing = envelopes[stateRevision - 1];
      if (existing !== undefined) {
        assertSameEvent(existing, event, stateRevision);
        // A different instance may have published these complete bytes and
        // failed before acknowledging fsync. Exact-event replay is the durable
        // repair signal, so re-sync before acknowledging it.
        await this.#syncDurabilityUnlocked();
        return existing;
      }
      if (stateRevision !== envelopes.length + 1) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Audit append would create a state-revision gap",
          { stateRevision, expectedRevision: envelopes.length + 1 }
        );
      }
      return this.#appendUnlocked(event, envelopes.at(-1));
    });
  }

  public async drain(
    loadSnapshot: () => Promise<AuditOutboxSnapshot>
  ): Promise<readonly AuditEnvelope[]> {
    const current = await this.#readEmptyCurrentWithoutWriter(loadSnapshot);
    if (current !== undefined) return current;
    return this.#exclusive(async () => {
      const {
        outbox,
        outboxSchemaVersion,
        stateRevision: throughStateRevision
      } = await loadSnapshot();
      this.#assertOutbox(outbox, throughStateRevision, outboxSchemaVersion);
      const read = await this.#readAuditUnlocked();
      const envelopes = [...read.envelopes];
      let changed = false;
      if (envelopes.length > throughStateRevision) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Audit chain is ahead of the durable state revision",
          { stateRevision: throughStateRevision, auditedRevision: envelopes.length }
        );
      }
      if (read.partialTail !== undefined) {
        const partialRevision = envelopes.length + 1;
        const pending = outbox[String(partialRevision)];
        if (pending === undefined) {
          throw new DomainError(
            "ARTIFACT_INTEGRITY_ERROR",
            "Audit partial tail is not backed by a durable outbox event",
            { partialRevision, stateRevision: throughStateRevision }
          );
        }
        this.#assertPartialTail(read.partialTail, pending, envelopes.at(-1));
        await this.#discardPartialTail(read.completeByteLength);
        changed = true;
      }
      const allowLegacyRecoveryMismatch = outboxSchemaVersion === undefined;
      for (let stateRevision = 1; stateRevision <= envelopes.length; stateRevision += 1) {
        assertSameEvent(
          envelopes[stateRevision - 1]!,
          outbox[String(stateRevision)]!,
          stateRevision,
          allowLegacyRecoveryMismatch
        );
      }
      for (
        let stateRevision = envelopes.length + 1;
        stateRevision <= throughStateRevision;
        stateRevision += 1
      ) {
        const appended = await this.#appendUnlocked(
          outbox[String(stateRevision)]!,
          envelopes.at(-1)
        );
        envelopes.push(appended);
        changed = true;
      }
      const verified = changed
        ? await this.#readAndVerifyStrictUnlocked()
        : envelopes;
      if (verified.length < throughStateRevision) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Audit drain did not cover the durable state revision",
          { stateRevision: throughStateRevision, auditedRevision: verified.length }
        );
      }
      for (let stateRevision = 1; stateRevision <= throughStateRevision; stateRevision += 1) {
        assertSameEvent(
          verified[stateRevision - 1]!,
          outbox[String(stateRevision)]!,
          stateRevision,
          allowLegacyRecoveryMismatch
        );
      }
      if (
        this.#durabilityRepairRequired ||
        (!changed && throughStateRevision > 0)
      ) {
        // A complete matching chain can still be the output of another
        // process that died between write and fsync. The durable outbox replay
        // is what requests this repair.
        await this.#syncDurabilityUnlocked();
      }
      return verified;
    });
  }

  async #readEmptyCurrentWithoutWriter(
    loadSnapshot: () => Promise<AuditOutboxSnapshot>
  ): Promise<readonly AuditEnvelope[] | undefined> {
    if (!(await this.#writerLockIsAbsent()) || this.#durabilityRepairRequired) return undefined;
    const {
      outbox,
      outboxSchemaVersion,
      stateRevision: throughStateRevision
    } = await loadSnapshot();
    this.#assertOutbox(outbox, throughStateRevision, outboxSchemaVersion);
    if (throughStateRevision !== 0) return undefined;
    const read = await this.#readAuditUnlocked();
    if (
      read.partialTail !== undefined ||
      read.envelopes.length !== throughStateRevision ||
      !(await this.#writerLockIsAbsent()) ||
      this.#durabilityRepairRequired
    ) {
      return undefined;
    }
    const allowLegacyRecoveryMismatch = outboxSchemaVersion === undefined;
    for (let stateRevision = 1; stateRevision <= throughStateRevision; stateRevision += 1) {
      assertSameEvent(
        read.envelopes[stateRevision - 1]!,
        outbox[String(stateRevision)]!,
        stateRevision,
        allowLegacyRecoveryMismatch
      );
    }
    if (!(await this.#writerLockIsAbsent()) || this.#durabilityRepairRequired) return undefined;
    return read.envelopes;
  }

  async #writerLockIsAbsent(): Promise<boolean> {
    try {
      await access(this.#lockFile);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
  }

  public async readAndVerify(): Promise<readonly AuditEnvelope[]> {
    return this.#exclusive(() => this.#readAndVerifyStrictUnlocked());
  }

  async #exclusive<Result>(work: () => Promise<Result>): Promise<Result> {
    let releaseQueue: (() => void) | undefined;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    await previous;

    let releaseFileLock: (() => Promise<void>) | undefined;
    try {
      await mkdir(this.root, { recursive: true });
      releaseFileLock = await acquireExclusiveFileLock(this.#lockFile, {
        ...(this.options.durabilityObserver === undefined
          ? {}
          : { durabilityObserver: this.options.durabilityObserver })
      });
      return await work();
    } finally {
      try {
        if (releaseFileLock !== undefined) {
          let injectedFailure: unknown;
          try {
            await this.options.phaseHook?.("lock_release");
          } catch (error) {
            injectedFailure = error;
          }
          try {
            await releaseFileLock();
          } catch (releaseFailure) {
            await releaseFileLock();
            throw releaseFailure;
          }
          if (injectedFailure !== undefined) throw injectedFailure;
        }
      } finally {
        releaseQueue?.();
      }
    }
  }

  #assertOutbox(
    outbox: Readonly<Record<string, AuditEvent>>,
    throughStateRevision: number,
    outboxSchemaVersion: AuditOutboxSnapshot["outboxSchemaVersion"]
  ): void {
    if (!Number.isSafeInteger(throughStateRevision) || throughStateRevision < 0) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Audit drain received an invalid durable state revision",
        { throughStateRevision }
      );
    }
    if (
      outboxSchemaVersion !== undefined &&
      outboxSchemaVersion !== EVLEDA_AUDIT_OUTBOX_SCHEMA_VERSION
    ) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Audit outbox has an unsupported schema",
        {
          actualSchemaVersion: outboxSchemaVersion,
          supportedSchemaVersions: ["legacy-v1", EVLEDA_AUDIT_OUTBOX_SCHEMA_VERSION]
        }
      );
    }
    const keys = Object.keys(outbox);
    if (keys.length !== throughStateRevision) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Audit outbox does not contain exactly one event per durable state revision",
        { throughStateRevision, outboxEntries: keys.length }
      );
    }
    for (let stateRevision = 1; stateRevision <= throughStateRevision; stateRevision += 1) {
      const event = outbox[String(stateRevision)];
      if (event === undefined) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Audit outbox is missing a durable state transition",
          { throughStateRevision, missingRevision: stateRevision }
        );
      }
      const eventRevision = stateRevisionOf(event);
      if (eventRevision !== stateRevision) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Audit outbox key does not match its event state revision",
          { outboxRevision: stateRevision, eventRevision }
        );
      }
      if (
        outboxSchemaVersion === EVLEDA_AUDIT_OUTBOX_SCHEMA_VERSION &&
        event.eventSchemaVersion !== EVLEDA_AUDIT_EVENT_SCHEMA_VERSION
      ) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Versioned audit outbox contains a legacy event",
          { outboxRevision: stateRevision, eventSchemaVersion: event.eventSchemaVersion }
        );
      }
    }
  }

  async #appendUnlocked(
    event: AuditEvent,
    last: AuditEnvelope | undefined
  ): Promise<AuditEnvelope> {
    const stateRevision = stateRevisionOf(event);
    const expectedRevision = (last?.sequence ?? 0) + 1;
    if (stateRevision !== expectedRevision) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Audit append is not the next durable state revision",
        { stateRevision, expectedRevision }
      );
    }
    const unsigned: Omit<AuditEnvelope, "digest"> = {
      schemaVersion: EVLEDA_AUDIT_ENVELOPE_SCHEMA_VERSION,
      sequence: expectedRevision,
      previousDigest: last?.digest ?? null,
      event
    };
    const envelope: AuditEnvelope = { ...unsigned, digest: identityPayload(unsigned) };
    this.#durabilityRepairRequired = true;
    const handle = await open(this.#file, "a");
    try {
      await handle.writeFile(`${canonicalJson(envelope)}\n`, "utf8");
      await this.options.phaseHook?.("file_sync");
      await syncFileHandle(handle, this.#file, this.options.durabilityObserver);
    } finally {
      await handle.close();
    }
    await this.options.phaseHook?.("directory_sync");
    await syncContainingDirectory(this.#file, this.options.durabilityObserver);
    this.#durabilityRepairRequired = false;
    return envelope;
  }

  async #syncDurabilityUnlocked(): Promise<void> {
    let handle;
    try {
      handle = await open(this.#file, "r+");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.#durabilityRepairRequired = false;
        return;
      }
      throw error;
    }
    try {
      await this.options.phaseHook?.("file_sync");
      await syncFileHandle(handle, this.#file, this.options.durabilityObserver);
    } finally {
      await handle.close();
    }
    await this.options.phaseHook?.("directory_sync");
    await syncContainingDirectory(this.#file, this.options.durabilityObserver);
    this.#durabilityRepairRequired = false;
  }

  #assertPartialTail(
    partialTail: Buffer,
    event: AuditEvent,
    last: AuditEnvelope | undefined
  ): void {
    const sequence = (last?.sequence ?? 0) + 1;
    const unsigned: Omit<AuditEnvelope, "digest"> = {
      schemaVersion: EVLEDA_AUDIT_ENVELOPE_SCHEMA_VERSION,
      sequence,
      previousDigest: last?.digest ?? null,
      event
    };
    const envelope: AuditEnvelope = { ...unsigned, digest: identityPayload(unsigned) };
    const expected = Buffer.from(`${canonicalJson(envelope)}\n`, "utf8");
    if (
      partialTail.length === 0 ||
      partialTail.length >= expected.length ||
      !expected.subarray(0, partialTail.length).equals(partialTail)
    ) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Audit log has a partial trailing record that does not match the durable outbox",
        { stateRevision: sequence, partialBytes: partialTail.length }
      );
    }
  }

  async #discardPartialTail(completeByteLength: number): Promise<void> {
    this.#durabilityRepairRequired = true;
    await truncate(this.#file, completeByteLength);
    const handle = await open(this.#file, "r+");
    try {
      await this.options.phaseHook?.("file_sync");
      await syncFileHandle(handle, this.#file, this.options.durabilityObserver);
    } finally {
      await handle.close();
    }
    await this.options.phaseHook?.("directory_sync");
    await syncContainingDirectory(this.#file, this.options.durabilityObserver);
    this.#durabilityRepairRequired = false;
  }

  async #readAndVerifyStrictUnlocked(): Promise<readonly AuditEnvelope[]> {
    const result = await this.#readAuditUnlocked();
    if (result.partialTail !== undefined) {
      throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Audit log has a partial trailing record", {
        partialBytes: result.partialTail.length
      });
    }
    return result.envelopes;
  }

  async #readAuditUnlocked(): Promise<AuditReadResult> {
    let raw: Buffer;
    try {
      raw = await readFile(this.#file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { envelopes: [], completeByteLength: 0 };
      }
      throw error;
    }
    if (raw.length === 0) {
      return { envelopes: [], completeByteLength: 0 };
    }

    const endsWithNewline = raw.at(-1) === 0x0a;
    const lastNewline = raw.lastIndexOf(0x0a);
    const completeByteLength = endsWithNewline ? raw.length : lastNewline + 1;
    const complete = raw.subarray(0, completeByteLength).toString("utf8");
    const partialTail = endsWithNewline ? undefined : raw.subarray(completeByteLength);
    const envelopes: AuditEnvelope[] = [];
    const lines = complete.length === 0 ? [] : complete.slice(0, -1).split("\n");
    for (const [index, line] of lines.entries()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Audit log contains an invalid JSON record",
          { sequence: index + 1 }
        );
      }
      if (typeof parsed !== "object" || parsed === null) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Audit log contains an invalid envelope",
          { sequence: index + 1 }
        );
      }
      const envelope = parsed as AuditEnvelope;
      const expectedSequence = index + 1;
      const expectedPrevious = envelopes.at(-1)?.digest ?? null;
      const { digest, ...unsigned } = envelope;
      if (
        envelope.schemaVersion !== EVLEDA_AUDIT_ENVELOPE_SCHEMA_VERSION ||
        envelope.sequence !== expectedSequence ||
        envelope.previousDigest !== expectedPrevious ||
        identityPayload(unsigned) !== digest
      ) {
        throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Audit hash chain verification failed", {
          sequence: envelope.sequence,
          expectedSequence
        });
      }
      const stateRevision = stateRevisionOf(envelope.event);
      if (stateRevision !== expectedSequence) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Audit event state revisions are duplicated, missing, or out of order",
          { sequence: expectedSequence, stateRevision }
        );
      }
      envelopes.push(envelope);
    }
    return {
      envelopes,
      completeByteLength,
      ...(partialTail === undefined ? {} : { partialTail })
    };
  }
}
