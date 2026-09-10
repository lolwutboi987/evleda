import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { isProxy } from "node:util/types";

import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import { hardenPortableValue, validateCanonicalIdentity } from "../core/portable-artifact.js";
import {
  parseFluxDiagnostic,
  PROVIDER_FAILURE_EVIDENCE_SCHEMA_VERSION,
  type FluxDiagnosticDto
} from "../domain/diagnostics.js";
import {
  createPcbDesignCompilationBundleRef,
  parsePcbDesignCompilationBundleRef,
  type PcbDesignCompilationBundle,
  type PcbDesignCompilationBundleRef
} from "../harness/pcb-design-compilation-bundle.js";
import { PcbDesignInterpreterError, parsePcbProviderProfileBinding, type PcbProviderProfileBinding } from "../harness/pcb-design-interpreter.js";
import { parseFreshClearanceEvidenceReceipt, parseFreshNetClassPreparationEvidence, parseFreshNetClassSemanticAuthority, verifyFreshClearanceEvidenceReceiptAgainstSemanticAuthority,
  type FreshClearanceEvidenceReceipt, type FreshNetClassPreparationEvidence, type FreshNetClassSemanticAuthority } from "../harness/fresh-clearance-evidence.js";
import { parseFreshProjectOpenPreparedSourceAuthority, type FreshProjectOpenPreparedSourceAuthority } from "../harness/fresh-project.js";
import { PCB_AGENT_MAX_FRESH_ITERATIONS, PCB_AGENT_MIN_ITERATIONS } from "../harness/pcb-agent-harness.js";
import { isFluxLegacyNetClassEvidence } from "./legacy-netclass-evidence.js";
import { FLUX_LEGACY_AUTHORED_NETCLASS_REVIEW_MESSAGE } from "./contracts.js";
import type { FluxCompilationBundleStore } from "./compilation-bundle-store.js";
import {
  approvalSubjectDigest, FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE, FLUX_CHECKPOINT_OPERATION_TIMEOUT_MS, FLUX_OPEN_PREFLIGHT_UNCERTAIN_MESSAGE, FLUX_OPERATION_FAILURE_EVIDENCE_MAX_RECORDS, FLUX_OPERATION_FAILURE_EVIDENCE_RESERVATION_PROVIDER_SCHEMA_VERSION, FLUX_OPERATION_FAILURE_EVIDENCE_RESERVATION_SCHEMA_VERSION, FLUX_OPERATION_FAILURE_SCHEMA_VERSION, FLUX_SOCKET_RESTART_INVALIDATION_MESSAGE, FLUX_TERMINAL_FAILURE_DIAGNOSTIC_SCHEMA_VERSION, FLUX_TERMINAL_FAILURE_RECEIPT_SCHEMA_VERSION, FLUX_TOOLCHAIN_FAILURE_MESSAGE, fluxDigest, fluxId, fluxNow, fluxOpenPreparationDigest, freeze, FluxError, toRunDto,
  type FluxApprovalSubject, type FluxClarificationAnswerDto, type FluxCompilationInterpreterPort,
  type FluxCanonicalIdentityDto, type FluxContractStateDto, type FluxCreateRunInput, type FluxEventDto, type FluxExecuteRequest,
  type FluxExecuteResult, type FluxExecutionPorts, type FluxGenericApprovalSubject,
  type FluxGenericPrepareRequest, type FluxLedCompatibilityApprovalSubject,
  type FluxInterpreterReceiptV2Dto, type FluxLedCompatibilityPrepareRequest, type FluxOpenResult, type FluxPersistedApproval,
  type FluxOpenCheckpointReceipt, type FluxOpenPreflightReceipt, type FluxOperationFailureEvidenceReservation, type FluxPersistedOperationFailure, type FluxPersistedOperationIntent, type FluxPersistedRun, type FluxPersistedState, type FluxPrepareRequest, type FluxPrepareResult, type FluxProjectDto,
  type FluxPreviewMetadata, type FluxQueueSnapshot, type FluxRunDto, type FluxSourceCatalogDto, type FluxSourceCatalogInput,
  type FluxTerminalFailureReceiptDto, type FluxThreadDto
} from "./contracts.js";
import {
  assertFluxOperationFailureEvidenceMatchesDiagnostic,
  createFluxGenericOperationFailureEvidence,
  createFluxOperationFailureDiagnostic,
  createFluxPcbInterpreterFailureEvidence,
  fluxOperationFailureEvidenceIdentity,
  parseFluxOperationFailureEvidence,
  type FluxOperationFailureEvidence
} from "./operation-failure-evidence.js";
import { assertFluxDeepRuleSummaryBinding, createFluxDeepRuleSummary } from "./deep-rule-summary.js";
import { parseFluxFreshClearanceEvidenceBinding } from "./fresh-clearance-evidence-binding.js";
import { createFluxOpenPreflightFailureReceipt, createFluxOpenPreflightUncertainReceipt, parseFluxOpenCheckpointReceipt, parseFluxOpenPreflightReceipt } from "./open-preflight.js";
import { assertDisjointRoots, FluxRunStore } from "./run-store.js";
import { FLUX_CHECKPOINT_FAILURE_RECEIPT_SCHEMA_VERSION, FLUX_CHECKPOINT_FAILURE_SCHEMA_VERSION, FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE } from "./contracts.js";

const TERMINAL_PHASES = new Set(["completed", "needs_review", "failed", "blocked"]);
const INTERRUPTED_AFTER_RESTART = new Set(["interpreting", "preparing", "opening", "checkpointing", "queued", "running"]);
const GENERIC_BUNDLE_PHASES = new Set([
  "contract_ready", "preparing", "awaiting_open", "opening", "awaiting_checkpoint", "checkpointing", "awaiting_approval", "approved", "queued", "running"
]);
const sourceKeyPattern = /^[a-z][a-z0-9_-]{0,63}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;
const comparable = (entry: string): string => process.platform === "win32" ? entry.toLowerCase() : entry;
let processExecutionTail: Promise<void> = Promise.resolve();

const event = (kind: FluxEventDto["kind"], detail: string, runId?: string, diagnostic?: FluxDiagnosticDto): FluxEventDto => freeze({
  id: fluxId("event"), eventSeq: 0, kind, detail, ...(runId === undefined ? {} : { runId }),
  ...(diagnostic === undefined ? {} : { diagnostic }), at: fluxNow()
});
const replaceRun = (state: FluxPersistedState, run: FluxPersistedRun, e?: FluxEventDto): FluxPersistedState => ({
  ...state, runs: { ...state.runs, [run.id]: run }, ...(e === undefined ? {} : { events: [...state.events, e] })
});
const compatibilityIdentity = (schemaVersion: string, value: unknown) => freeze({
  algorithm: "sha256" as const, digest: fluxDigest(value), schemaVersion, canonicalizationVersion: "evleda-c14n-json-v1" as const
});
const compatibilityContractState = (prompt: string): FluxContractStateDto => {
  const contract = freeze({ schemaVersion: "evleda.flux-led-compatibility-fixture.v1", kind: "led_compatibility_fixture" });
  return freeze({
    disposition: "ready", questions: [], issues: [], contract,
    contractIdentity: compatibilityIdentity("evleda.flux-led-compatibility-fixture.v1", contract),
    libraryBindingIdentity: compatibilityIdentity("evleda.flux-led-library-fixture.v1", contract),
    deepRuleBindingIdentity: compatibilityIdentity("evleda.flux-led-deep-rule-fixture.v1", contract),
    acceptancePlanIdentity: compatibilityIdentity("evleda.flux-led-acceptance-fixture.v1", contract),
    interpreterReceipt: {
      schemaVersion: "evleda.flux-interpreter-receipt.v1", interpreterSchemaVersion: "evleda.flux-led-compatibility-fixture.v1",
      provider: "compatibility-fixture", promptDigest: fluxDigest(prompt), clarificationDigest: fluxDigest([]), compiledAt: fluxNow()
    }
  });
};

const projectionRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value) || isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new FluxError("INVALID_ARGUMENT", `${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
};

const exactProjectionKeys = (record: Record<string, unknown>, required: readonly string[], label: string): void => {
  const keys = Object.keys(record).sort(); const expected = [...required].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new FluxError("INVALID_ARGUMENT", `${label} contains missing or unknown fields`);
  }
};
const closedProjectionKeys = (record: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void => {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(record, key)) || Object.keys(record).some((key) => !allowed.has(key))) {
    throw new FluxError("INVALID_ARGUMENT", `${label} contains missing or unknown fields`);
  }
};

const projectionText = (value: unknown, label: string, maximumBytes = 16_384): string => {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > maximumBytes || value.includes("\0")) {
    throw new FluxError("INVALID_ARGUMENT", `${label} must be bounded non-empty text`);
  }
  return value;
};

const projectionIdentity = (value: unknown, label: string): FluxCanonicalIdentityDto => {
  try { return validateCanonicalIdentity(value, label); }
  catch { throw new FluxError("INVALID_ARGUMENT", `${label} is not a canonical identity`); }
};

const nullableProjectionIdentity = (value: unknown, label: string): FluxCanonicalIdentityDto | null =>
  value === null ? null : projectionIdentity(value, label);

const captureInterpretationEnvelope = (value: unknown): Readonly<{ readonly publicState: unknown; readonly bundle: PcbDesignCompilationBundle | null }> => {
  if (typeof value !== "object" || value === null || Array.isArray(value) || isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new FluxError("INVALID_ARGUMENT", "Compilation interpreter returned an invalid authority envelope");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || keys.some((key) => typeof key !== "string" || !["publicState", "bundle"].includes(key))) {
    throw new FluxError("INVALID_ARGUMENT", "Compilation interpreter authority envelope contains missing or unknown fields");
  }
  for (const key of ["publicState", "bundle"] as const) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new FluxError("INVALID_ARGUMENT", "Compilation interpreter authority envelope may contain only data fields");
    }
  }
  const bundle = descriptors.bundle!.value as unknown;
  if (bundle !== null && (typeof bundle !== "object" || Array.isArray(bundle))) {
    throw new FluxError("INVALID_ARGUMENT", "Compilation interpreter bundle must be an authenticated object or null");
  }
  return Object.freeze({ publicState: descriptors.publicState!.value, bundle: bundle as PcbDesignCompilationBundle | null });
};

export interface FluxSourceFingerprintRequest {
  readonly key: string;
  readonly label: string;
  readonly sourceRoot: string;
}

export interface FluxRunManagerOptions {
  readonly workspaceRoot: string;
  readonly sources: readonly FluxSourceCatalogInput[];
  readonly ports: FluxExecutionPorts;
  readonly eventLimit?: number;
  /** @internal Server-owned test seam; production uses the closed global maximum. */
  readonly operationFailureEvidenceCapacity?: number;
  readonly lifecycleObserver?: (event: Readonly<{
    readonly phase: "intent_persisted" | "side_effect_completed";
    readonly operation: "interpret_run" | "clarify_run" | "prepare_run" | "open_project" | "checkpoint_open" | "resume_run";
    readonly runId: string;
  }>) => void | Promise<void>;
  /** Generic interpretation is admitted only through this authority-bearing port. */
  readonly contractInterpreter?: FluxCompilationInterpreterPort;
  readonly compilationBundleStore?: FluxCompilationBundleStore;
  /** Recomputes source identity before copying and every later authority boundary. */
  readonly sourceFingerprint?: (request: Readonly<FluxSourceFingerprintRequest>) => Promise<string>;
  /** Optional server-owned generic harness identity derived from the verified bundle. */
  readonly genericHarnessRuleIdentity?: (bundle: PcbDesignCompilationBundle) => string;
  /** Optional server-owned generic acceptance identity derived from the verified bundle. */
  readonly genericAcceptanceProfileIdentity?: (bundle: PcbDesignCompilationBundle) => string;
  /** Active host provider profile; when present every generic reload must match it exactly. */
  readonly activeProviderProfile?: PcbProviderProfileBinding;
  /** Active immutable KiCad suite/executable binding used by Open, approval, and resume. */
  readonly activeKicadToolchainIdentity: FluxCanonicalIdentityDto;
  /** Active immutable read-only inspection bridge binding used by checkpoint, approval, and resume. */
  readonly activeInspectionBridgeIdentity: FluxCanonicalIdentityDto;
  /** Active immutable full-mode execution bridge binding used by checkpoint, approval, and resume. */
  readonly activeExecutionBridgeIdentity: FluxCanonicalIdentityDto;
}

type ExternalOperation = "interpret_run" | "clarify_run" | "prepare_run" | "open_project" | "checkpoint_open" | "resume_run";
type LifecycleOperation = ExternalOperation | "approve_run";
interface InFlightOperation { readonly digest: string; readonly promise: Promise<unknown> }
type FluxOperationFailureInput = Omit<FluxPersistedOperationFailure, "identity">;
interface FluxOperationFailureResolution { readonly failure: FluxOperationFailureInput; readonly operationFailureEvidence: FluxOperationFailureEvidence }
class FluxLifecycleObservationFailure extends Error {
  public constructor(public readonly original: unknown) {
    super(original instanceof Error ? original.message : "Lifecycle observation boundary interrupted the operation");
    this.name = "FluxLifecycleObservationFailure";
  }
}

/** UI-facing aggregate; authority is always reloaded from the separate bundle store. */
export class FluxRunManager {
  readonly #store: FluxRunStore;
  readonly #sources = new Map<string, FluxSourceCatalogInput>();
  #executionTail: Promise<void> = Promise.resolve();
  #busyRunId: string | undefined;
  #initialized = false;
  #initialization: Promise<void> | undefined;
  readonly #inFlight = new Map<string, InFlightOperation>();
  readonly #operationFailureEvidenceCapacity: number;
  readonly #activeKicadToolchainIdentity: FluxCanonicalIdentityDto;
  readonly #activeInspectionBridgeIdentity: FluxCanonicalIdentityDto;
  readonly #activeExecutionBridgeIdentity: FluxCanonicalIdentityDto;

  public constructor(private readonly options: FluxRunManagerOptions) {
    this.#store = new FluxRunStore(options.workspaceRoot, options.eventLimit);
    this.#activeKicadToolchainIdentity = projectionIdentity(options.activeKicadToolchainIdentity, "Active KiCad toolchain identity");
    this.#activeInspectionBridgeIdentity = projectionIdentity(options.activeInspectionBridgeIdentity, "Active inspection bridge identity");
    this.#activeExecutionBridgeIdentity = projectionIdentity(options.activeExecutionBridgeIdentity, "Active execution bridge identity");
    const evidenceCapacity = options.operationFailureEvidenceCapacity ?? FLUX_OPERATION_FAILURE_EVIDENCE_MAX_RECORDS;
    if (!Number.isSafeInteger(evidenceCapacity) || evidenceCapacity < 1 || evidenceCapacity > FLUX_OPERATION_FAILURE_EVIDENCE_MAX_RECORDS) throw new FluxError("INVALID_ARGUMENT", "Operation failure evidence capacity is invalid");
    this.#operationFailureEvidenceCapacity = evidenceCapacity;
    for (const source of options.sources) {
      if (!sourceKeyPattern.test(source.key) || !source.label.trim() || !digestPattern.test(source.fingerprint)) {
        throw new FluxError("INVALID_ARGUMENT", "Invalid Flux source catalog entry", { key: source.key });
      }
      if (this.#sources.has(source.key)) throw new FluxError("INVALID_ARGUMENT", "Source catalog keys must be unique", { key: source.key });
      assertDisjointRoots(source.sourceRoot, options.workspaceRoot);
      this.#sources.set(source.key, freeze({ ...source }));
    }
  }

  public async initialize(): Promise<void> {
    if (this.#initialized) return;
    if (this.#initialization === undefined) this.#initialization = this.#initializeOnce();
    await this.#initialization;
  }

  async #initializeOnce(): Promise<void> {
    try {
      for (const source of this.#sources.values()) await this.#assertSourceRoot(source);
      await this.#store.initialize();
      const initial = await this.#store.read();
      const sourceRecords = Object.fromEntries([...this.#sources.values()].map((source) => [source.key, {
        key: source.key, label: source.label, fingerprint: source.fingerprint
      }]));
      const blocked = new Map<string, string>();
      const socketRestartInvalidations = new Set<string>();
      const deepRuleSummaryBackfills = new Map<string, ReturnType<typeof createFluxDeepRuleSummary>>();
      for (const run of Object.values(initial.runs)) {
        if (INTERRUPTED_AFTER_RESTART.has(run.phase) || (run.inFlightOperation !== undefined && !TERMINAL_PHASES.has(run.phase))) {
          blocked.set(run.id, run.phase === "interpreting"
            ? "The Flux service restarted during generic interpretation; its durable provider receipt remains uncertain and the call will not be repeated."
            : "The Flux service restarted while this run was in flight; create and prepare a new run before approving again.");
          continue;
        }
        if (run.phase === "awaiting_checkpoint") {
          blocked.set(run.id, "The Flux service restarted after editor launch; the transient GUI session cannot be proven and checkpointing will not resume automatically.");
          continue;
        }
        if (run.workflowKind === "generic" && !TERMINAL_PHASES.has(run.phase) && run.contractState?.interpreterReceipt.schemaVersion === "evleda.flux-interpreter-receipt.v2" && this.options.activeProviderProfile !== undefined) {
          try {
            if (!this.#same(parsePcbProviderProfileBinding(this.options.activeProviderProfile), parsePcbProviderProfileBinding(run.contractState.interpreterReceipt.providerProfile))) {
              blocked.set(run.id, "Generic run provider profile does not match the active host interpreter profile");
              continue;
            }
          } catch {
            blocked.set(run.id, "Generic run provider profile failed restart verification");
            continue;
          }
        }
        if (["awaiting_approval", "approved"].includes(run.phase)) {
          if (run.openPreflightReceipt?.schemaVersion !== "evleda.flux-open-preflight.v5" || run.openCheckpointReceipt?.schemaVersion !== "evleda.flux-open-checkpoint.v6" || (run.approval !== undefined && run.approval.subject.schemaVersion !== "evleda.flux-approval-subject.v6")) {
            blocked.set(run.id, "Run predates the bound KiCad Open/checkpoint approval lifecycle and cannot be resumed; create and prepare a new run.");
            continue;
          }
          try { await this.#verifiedPrepareRequest(run, true); }
          catch { blocked.set(run.id, "Run Open/checkpoint receipt does not match the active KiCad toolchain, inspection bridge, or IPC socket; a new run is required."); continue; }
          socketRestartInvalidations.add(run.id);
          continue;
        }
        if (run.workflowKind === "generic" && run.contractState?.disposition === "ready" && run.compilationBundleRef !== undefined && run.contractState.deepRuleSummary === undefined) {
          try { const verified = await this.#verifiedGenericBundle(run); deepRuleSummaryBackfills.set(run.id, createFluxDeepRuleSummary(verified.bundle.deepRuleBinding)); }
          catch (error) {
            if (!TERMINAL_PHASES.has(run.phase)) blocked.set(run.id, error instanceof FluxError && error.code === "APPROVAL_MISMATCH" ? error.message : "Generic compilation bundle failed restart verification; the run cannot continue.");
            continue;
          }
        }
        if (run.workflowKind !== "generic" || TERMINAL_PHASES.has(run.phase) || !GENERIC_BUNDLE_PHASES.has(run.phase)) continue;
        if (run.compilationBundleRef === undefined) {
          blocked.set(run.id, "Generic run has no durable compilation-bundle reference; it cannot continue from a projection.");
          continue;
        }
        try {
          const verified = await this.#verifiedGenericBundle(run);
          if (run.contractState?.deepRuleSummary === undefined) deepRuleSummaryBackfills.set(run.id, createFluxDeepRuleSummary(verified.bundle.deepRuleBinding));
        }
        catch (error) { blocked.set(run.id, error instanceof FluxError && error.code === "APPROVAL_MISMATCH"
          ? error.message : "Generic compilation bundle failed restart verification; the run cannot continue."); }
      }
      for (const receipt of Object.values(initial.idempotency)) {
        if (receipt.status !== "pending" || !["interpret_run", "clarify_run", "prepare_run", "open_project", "checkpoint_open", "resume_run"].includes(receipt.operation)) continue;
        const run = initial.runs[receipt.runId];
        if (run !== undefined && !TERMINAL_PHASES.has(run.phase) && !blocked.has(run.id)) {
          blocked.set(run.id, "A durable lifecycle intent was interrupted at an uncertain external side-effect boundary; it will not be repeated under another key.");
        }
      }
      if (fluxDigest(initial.sources) !== fluxDigest(sourceRecords) || blocked.size > 0 || socketRestartInvalidations.size > 0 || deepRuleSummaryBackfills.size > 0) {
        await this.#store.replace((state) => {
          const now = fluxNow(); const runs = { ...state.runs }; const events = [...state.events]; let idempotency = state.idempotency;
          for (const [runId, summary] of deepRuleSummaryBackfills) {
            const run = runs[runId];
            if (run?.contractState?.disposition !== "ready" || run.contractState.deepRuleSummary !== undefined) continue;
            runs[runId] = { ...run, contractState: { ...run.contractState, deepRuleSummary: summary }, updatedAt: now };
            idempotency = Object.fromEntries(Object.entries(idempotency).map(([key, receipt]) => {
              if (receipt.status !== "completed" || !["interpret_run", "clarify_run"].includes(receipt.operation) || receipt.runId !== runId || typeof receipt.result !== "object" || receipt.result === null || Array.isArray(receipt.result)) return [key, receipt];
              const result = receipt.result as Record<string, unknown>; const contractState = result.contractState;
              return typeof contractState === "object" && contractState !== null && !Array.isArray(contractState)
                ? [key, { ...receipt, result: { ...result, contractState: { ...(contractState as Record<string, unknown>), deepRuleSummary: summary } } }] : [key, receipt];
            }));
          }
          for (const runId of socketRestartInvalidations) {
            const run = runs[runId]; if (run === undefined || !["awaiting_approval", "approved"].includes(run.phase)) continue;
            const { approval: _approval, openPreflightReceipt: _preflight, openCheckpointReceipt: _checkpoint, blockedReason: _blockedReason, ...base } = run;
            runs[runId] = { ...base, phase: "awaiting_open", checkpointRequired: true, blockedReason: FLUX_SOCKET_RESTART_INVALIDATION_MESSAGE, updatedAt: now };
            idempotency = Object.fromEntries(Object.entries(idempotency).map(([key, receipt]) => receipt.runId === runId && receipt.status === "completed" && ["open_project", "checkpoint_open", "approve_run"].includes(receipt.operation)
              ? [key, { ...receipt, status: "authority_invalidated" as const }] : [key, receipt]));
            events.push(event("run_prepared", FLUX_SOCKET_RESTART_INVALIDATION_MESSAGE, runId));
          }
          for (const [runId, reason] of blocked) {
            const run = runs[runId];
            if (run === undefined || TERMINAL_PHASES.has(run.phase)) continue;
            runs[runId] = { ...run, phase: "blocked", blockedReason: reason, updatedAt: now };
            events.push(event("run_blocked", "Restart recovery blocked a run whose authority or external side effect could not be replayed safely.", runId));
          }
          return { ...state, sources: sourceRecords, runs, idempotency, events };
        });
      }
      this.#initialized = true;
    } catch (error) {
      this.#initialization = undefined;
      throw error;
    }
  }

  public async sources(): Promise<readonly FluxSourceCatalogDto[]> {
    await this.initialize();
    return freeze([...this.#sources.values()].map((entry) => ({ key: entry.key, label: entry.label, fingerprint: entry.fingerprint })));
  }
  public async projects(): Promise<readonly FluxProjectDto[]> {
    await this.initialize(); return freeze(Object.values((await this.#store.read()).projects).map((entry) => ({ ...entry })));
  }
  public async threads(projectId: string): Promise<readonly FluxThreadDto[]> {
    await this.initialize(); const state = await this.#store.read();
    if (state.projects[projectId] === undefined) throw new FluxError("NOT_FOUND", "Project does not exist", { projectId });
    return freeze(Object.values(state.threads).filter((entry) => entry.projectId === projectId).map((entry) => ({ ...entry })));
  }
  public async runs(projectId?: string, threadId?: string): Promise<readonly FluxRunDto[]> {
    await this.initialize(); const state = await this.#store.read();
    if (projectId !== undefined && state.projects[projectId] === undefined) throw new FluxError("NOT_FOUND", "Project does not exist", { projectId });
    if (threadId !== undefined && state.threads[threadId] === undefined) throw new FluxError("NOT_FOUND", "Thread does not exist", { threadId });
    const runs = Object.values(state.runs).filter((entry) => (projectId === undefined || entry.projectId === projectId) && (threadId === undefined || entry.threadId === threadId));
    return freeze(await Promise.all(runs.map((run) => this.#verifiedRunDto(run))));
  }

  public async createProject(sourceKey: string, name: string, idempotencyKey?: string): Promise<FluxProjectDto> {
    await this.initialize();
    if (!this.#sources.has(sourceKey) || !name.trim()) throw new FluxError("INVALID_ARGUMENT", "Project requires a known source key and name");
    const request = { sourceKey, name: name.trim() };
    const saved = await this.#store.replace((state) => {
      if (this.#idempotent(state, "create_project", request, idempotencyKey) !== undefined) return state;
      const item: FluxProjectDto = freeze({ id: fluxId("project"), sourceKey, name: name.trim(), createdAt: fluxNow() });
      return { ...state, projects: { ...state.projects, [item.id]: item },
        idempotency: this.#remember(state, "create_project", request, item.id, item, idempotencyKey),
        events: [...state.events, event("project_created", `Created project ${item.name}.`)] };
    });
    const id = this.#resultId(saved, "create_project", request, idempotencyKey, Object.keys(saved.projects).find((candidate) =>
      saved.projects[candidate]?.sourceKey === sourceKey && saved.projects[candidate]?.name === name.trim()));
    const project = saved.projects[id!];
    if (project === undefined) throw new FluxError("STORE_CORRUPT", "Created project was not persisted");
    return freeze({ ...project });
  }

  public async createThread(projectId: string, title: string, idempotencyKey?: string): Promise<FluxThreadDto> {
    await this.initialize(); if (!title.trim()) throw new FluxError("INVALID_ARGUMENT", "Thread title is required");
    const request = { projectId, title: title.trim() };
    const saved = await this.#store.replace((state) => {
      if (state.projects[projectId] === undefined) throw new FluxError("NOT_FOUND", "Project does not exist", { projectId });
      if (this.#idempotent(state, "create_thread", request, idempotencyKey) !== undefined) return state;
      const item: FluxThreadDto = freeze({ id: fluxId("thread"), projectId, title: title.trim(), createdAt: fluxNow() });
      return { ...state, threads: { ...state.threads, [item.id]: item },
        idempotency: this.#remember(state, "create_thread", request, item.id, item, idempotencyKey),
        events: [...state.events, event("thread_created", `Created thread ${item.title}.`)] };
    });
    const id = this.#resultId(saved, "create_thread", request, idempotencyKey, Object.keys(saved.threads).find((candidate) =>
      saved.threads[candidate]?.projectId === projectId && saved.threads[candidate]?.title === title.trim()));
    const thread = saved.threads[id!];
    if (thread === undefined) throw new FluxError("STORE_CORRUPT", "Created thread was not persisted");
    return freeze({ ...thread });
  }

  public async createRun(input: FluxCreateRunInput, idempotencyKey?: string): Promise<FluxRunDto> {
    await this.initialize(); this.#assertRunInput(input);
    const saved = await this.#store.replace((state) => {
      const project = state.projects[input.projectId]; const thread = state.threads[input.threadId];
      if (project === undefined || thread === undefined || thread.projectId !== input.projectId) throw new FluxError("INVALID_ARGUMENT", "Run project and thread must exist and match");
      if (this.#idempotent(state, "create_run", input, idempotencyKey) !== undefined) return state;
      const source = this.#sources.get(project.sourceKey)!; const now = fluxNow();
      const run: FluxPersistedRun = freeze({
        id: fluxId("run"), projectId: input.projectId, threadId: input.threadId, sourceKey: source.key,
        sourceFingerprint: source.fingerprint, phase: "draft", prompt: input.prompt, providerModel: { ...input.providerModel },
        iterationCap: input.iterationCap, harnessRuleIdentity: input.harnessRuleIdentity,
        mutationAllowlist: [...input.mutationAllowlist].sort(), freshAcceptanceProfileIdentity: input.freshAcceptanceProfileIdentity,
        freshPersistenceProfileIdentity: input.freshPersistenceProfileIdentity, workflowKind: input.workflowKind,
        ...(input.workflowKind === "led_compatibility_fixture" ? { contractState: compatibilityContractState(input.prompt) } : {}),
        reports: [], createdAt: now, updatedAt: now
      });
      return { ...state, runs: { ...state.runs, [run.id]: run },
        idempotency: this.#remember(state, "create_run", input, run.id, toRunDto(run), idempotencyKey),
        events: [...state.events, event("run_created", "Created draft run.", run.id)] };
    });
    const id = this.#resultId(saved, "create_run", input, idempotencyKey, Object.keys(saved.runs).at(-1)); const run = saved.runs[id!];
    if (run === undefined) throw new FluxError("STORE_CORRUPT", "Created run was not persisted");
    return toRunDto(run);
  }

  public async interpretRun(runId: string, idempotencyKey?: string): Promise<FluxRunDto> {
    return this.#compileContract(runId, [], "interpret_run", idempotencyKey);
  }
  public async clarifyRun(runId: string, answers: readonly FluxClarificationAnswerDto[], idempotencyKey?: string): Promise<FluxRunDto> {
    return this.#compileContract(runId, answers, "clarify_run", idempotencyKey);
  }
  public async contract(runId: string): Promise<FluxContractStateDto> {
    const run = await this.getRun(runId);
    if (run.contractState === undefined) throw new FluxError("ILLEGAL_TRANSITION", "Run has not produced a contract compilation");
    return freeze(structuredClone(run.contractState));
  }

  async #compileContract(runId: string, answers: readonly FluxClarificationAnswerDto[], operation: "interpret_run" | "clarify_run", idempotencyKey?: string): Promise<FluxRunDto> {
    await this.initialize();
    const normalizedAnswers = answers.map((entry) => ({ id: entry.id.trim(), answer: entry.answer.trim() }));
    if (normalizedAnswers.length > 64 || normalizedAnswers.some((entry) => !entry.id || !entry.answer) || new Set(normalizedAnswers.map((entry) => entry.id)).size !== normalizedAnswers.length) {
      throw new FluxError("INVALID_ARGUMENT", "Clarification answers must be a unique bounded non-empty batch");
    }
    const request = { runId, answers: normalizedAnswers };
    return this.#coalesce(operation, runId, request, idempotencyKey, async () => {
      const replayState = await this.#store.read();
      const replayRun = replayState.runs[runId];
      if (replayRun?.workflowKind === "generic" && replayRun.compilationBundleRef !== undefined && !TERMINAL_PHASES.has(replayRun.phase)) {
        await this.#verifiedGenericBundle(replayRun);
      }
      const replay = this.#replay<FluxRunDto>(replayState, operation, request, idempotencyKey);
      if (replay !== undefined) return replay;
      const interpreter = this.options.contractInterpreter; const bundleStore = this.options.compilationBundleStore;
      if (interpreter === undefined || typeof interpreter.interpretCompilation !== "function" || bundleStore === undefined) {
        throw new FluxError("ILLEGAL_TRANSITION", "PCB design compilation interpretation and durable bundle storage are not configured");
      }
      const admittedState = await this.#store.replace((state) => {
        this.#assertNewIntent(state, operation, request, idempotencyKey);
        const run = state.runs[runId]; if (run === undefined) throw new FluxError("NOT_FOUND", "Run does not exist", { runId });
        if (run.workflowKind !== "generic") throw new FluxError("ILLEGAL_TRANSITION", "The LED compatibility fixture cannot be reinterpreted");
        if (operation === "clarify_run") {
          if (run.phase !== "awaiting_clarification" || run.contractState === undefined) throw new FluxError("ILLEGAL_TRANSITION", "Clarification answers require an awaiting-clarification compilation");
          const expected = new Set(run.contractState.questions.map((entry) => entry.id));
          if (normalizedAnswers.some((entry) => !expected.has(entry.id))) throw new FluxError("INVALID_ARGUMENT", "Clarification answer does not match an outstanding question");
        } else if (!["draft", "awaiting_clarification", "contract_ready", "awaiting_open", "awaiting_checkpoint", "awaiting_approval", "approved"].includes(run.phase)) {
          throw new FluxError("ILLEGAL_TRANSITION", `Cannot interpret run from ${run.phase}`);
        }
        const { approval: _approval, isolatedFingerprint: _isolated, preview: _preview, checkpointRequired: _checkpoint,
          openPreflightReceipt: _openPreflightReceipt, openCheckpointReceipt: _openCheckpointReceipt, freshNetClassPreparationEvidence: _preparationEvidence,
          freshNetClassSemanticAuthority: _semanticAuthority, freshProjectOpenPreparedSourceAuthority: _preparedSourceAuthority,
          freshClearanceEvidenceReceipt: _terminalClearanceReceipt, ...resetAuthority } = run;
        const startedAt = fluxNow(); const intent = this.#operationIntent(operation, request, resetAuthority, startedAt);
        const reservation = this.#reserveOperationFailureEvidence(state, run, operation, request, idempotencyKey, startedAt);
        const interpreting = freeze({ ...resetAuthority, phase: "interpreting" as const, operationFailureEvidenceReservationRef: reservation.reservation.identity,
          inFlightOperation: intent, updatedAt: startedAt });
        const next = replaceRun(state, interpreting, event("interpretation_started", operation === "clarify_run" ? "Recompiling the generic contract from a clarification batch." : "Interpreting the generic PCB request.", runId));
        return { ...next, operationFailureEvidenceReservations: reservation.reservations,
          idempotency: this.#pending(state, operation, request, runId, runId, idempotencyKey) };
      });
      const interpreting = admittedState.runs[runId]!;
      await this.#observe("intent_persisted", operation, runId);
      try {
        this.#assertAdmittedOperation(admittedState, await this.#store.read(), runId, operation, request, idempotencyKey);
        const interpreted = captureInterpretationEnvelope(await interpreter.interpretCompilation({ prompt: interpreting.prompt, clarificationAnswers: normalizedAnswers }));
        this.#assertAdmittedOperation(admittedState, await this.#store.read(), runId, operation, request, idempotencyKey);
        let publicState = this.#parseContractState(interpreted.publicState);
        this.#assertContractState(publicState, interpreting.prompt, normalizedAnswers);
        let compilationBundleRef: PcbDesignCompilationBundleRef | undefined;
        let harnessRuleIdentity = interpreting.harnessRuleIdentity;
        let freshAcceptanceProfileIdentity = interpreting.freshAcceptanceProfileIdentity;
        if (publicState.disposition === "ready") {
          if (interpreted.bundle === null) throw new FluxError("INVALID_ARGUMENT", "Ready interpretation did not return its compilation bundle");
          const expectedRef = createPcbDesignCompilationBundleRef(interpreted.bundle);
          const storedRef = parsePcbDesignCompilationBundleRef(await bundleStore.put(interpreted.bundle));
          if (!this.#same(expectedRef, storedRef)) throw new FluxError("STORE_CORRUPT", "Bundle store returned a reference for different content");
          const readback = await bundleStore.get(storedRef);
          if (!this.#same(createPcbDesignCompilationBundleRef(readback), storedRef)) throw new FluxError("STORE_CORRUPT", "Bundle store readback changed the persisted compilation bundle");
          publicState = freeze({ ...publicState, deepRuleSummary: createFluxDeepRuleSummary(readback.deepRuleBinding) });
          harnessRuleIdentity = this.options.genericHarnessRuleIdentity?.(readback) ?? harnessRuleIdentity;
          freshAcceptanceProfileIdentity = this.options.genericAcceptanceProfileIdentity?.(readback) ?? freshAcceptanceProfileIdentity;
          if (!harnessRuleIdentity.trim() || !freshAcceptanceProfileIdentity.trim()) throw new FluxError("INVALID_ARGUMENT", "Generic workflow policy returned an invalid identity");
          this.#assertGenericBundleClosure({ ...interpreting, harnessRuleIdentity, freshAcceptanceProfileIdentity, contractState: publicState, compilationBundleRef: storedRef }, readback, storedRef);
          compilationBundleRef = storedRef;
        } else if (interpreted.bundle !== null) {
          throw new FluxError("INVALID_ARGUMENT", "Non-ready interpretation retained a compilation bundle");
        }
        await this.#observe("side_effect_completed", operation, runId);
        this.#assertAdmittedOperation(admittedState, await this.#store.read(), runId, operation, request, idempotencyKey);
        const saved = await this.#store.replace((state) => {
          const active = state.runs[runId]; if (active === undefined || active.phase !== "interpreting") throw new FluxError("ILLEGAL_TRANSITION", "Run is no longer interpreting");
          this.#assertAdmittedOperation(admittedState, state, runId, operation, request, idempotencyKey);
          const phase = publicState.disposition === "ready" ? "contract_ready" as const : "awaiting_clarification" as const;
          const { approval: _approval, isolatedFingerprint: _isolated, preview: _preview, checkpointRequired: _checkpoint,
            openPreflightReceipt: _openPreflightReceipt, openCheckpointReceipt: _openCheckpointReceipt,
            freshNetClassPreparationEvidence: _preparationEvidence, freshNetClassSemanticAuthority: _semanticAuthority, freshProjectOpenPreparedSourceAuthority: _preparedSourceAuthority,
            freshClearanceEvidenceReceipt: _terminalClearanceReceipt, compilationBundleRef: _previousRef, inFlightOperation: _intent, operationFailureEvidenceReservationRef: _reservation, ...base } = active;
          const compiled = freeze({ ...base, phase, harnessRuleIdentity, freshAcceptanceProfileIdentity, contractState: publicState,
            ...(compilationBundleRef === undefined ? {} : { compilationBundleRef }), updatedAt: fluxNow() });
          const dto = toRunDto(compiled);
          const next = replaceRun(state, compiled, event(publicState.disposition === "ready" ? "contract_compiled" : "clarification_requested",
            publicState.disposition === "ready" ? "Generic PCB contract and compilation bundle are durably verified for isolated preparation." : "Generic PCB contract requires clarification before preparation.", runId));
          return { ...next, operationFailureEvidenceReservations: this.#releaseOperationFailureEvidenceReservation(state, active, operation, request, idempotencyKey),
            idempotency: this.#completed(state, operation, request, runId, runId, dto, idempotencyKey) };
        });
        return toRunDto(saved.runs[runId]!);
      } catch (error) {
        if (error instanceof FluxLifecycleObservationFailure) throw error;
        const resolution = this.#operationFailure(error);
        const terminalFailureReceipt = await this.#failIfInterpreting(runId, operation, request, idempotencyKey, resolution.failure, resolution.operationFailureEvidence);
        throw this.#failureError(resolution.failure, terminalFailureReceipt);
      }
    });
  }

  public async prepareRun(runId: string, idempotencyKey?: string): Promise<FluxRunDto> {
    await this.initialize(); const request = { runId };
    return this.#coalesce("prepare_run", runId, request, idempotencyKey, async () => {
      const initialState = await this.#store.read(); const initial = initialState.runs[runId];
      if (initial === undefined) throw new FluxError("NOT_FOUND", "Run does not exist", { runId });
      const verified = await this.#verifiedPrepareRequest(initial, true);
      const replay = this.#replay<FluxRunDto>(initialState, "prepare_run", request, idempotencyKey);
      if (replay !== undefined) return replay;
      const admittedState = await this.#store.replace((state) => {
        this.#assertNewIntent(state, "prepare_run", request, idempotencyKey);
        const run = state.runs[runId]; if (run === undefined) throw new FluxError("NOT_FOUND", "Run does not exist", { runId });
        this.#assertUnchangedRun(initial, run);
        const ready = run.workflowKind === "generic" ? run.phase === "contract_ready" : run.workflowKind === "led_compatibility_fixture" && run.phase === "draft";
        if (!ready) throw new FluxError("ILLEGAL_TRANSITION", "Run must have a verified generic bundle or explicit LED fixture before preparation");
        const preparing = freeze({ ...run, phase: "preparing" as const,
          inFlightOperation: this.#operationIntent("prepare_run", request, run), updatedAt: fluxNow() });
        const next = replaceRun(state, preparing, event("run_prepared", "Preparation started.", runId));
        return { ...next, idempotency: this.#pending(state, "prepare_run", request, runId, runId, idempotencyKey) };
      });
      const preparing = admittedState.runs[runId]!;
      await this.#observe("intent_persisted", "prepare_run", runId);
      try {
        this.#assertAdmittedOperation(admittedState, await this.#store.read(), runId, "prepare_run", request, idempotencyKey);
        const reverified = await this.#verifiedPrepareRequest(preparing, true);
        if (!this.#sameRequestAuthority(verified, reverified)) throw new FluxError("APPROVAL_MISMATCH", "Run authority changed before isolated preparation");
        const result = this.#parsePrepareResult(await this.options.ports.prepare(reverified), reverified.workflowKind);
        const resultPreparationEvidence = result.freshNetClassPreparationEvidence;
        const resultSemanticAuthority = result.freshNetClassSemanticAuthority;
        const resultPreparedSourceAuthority = result.freshProjectOpenPreparedSourceAuthority;
        if (reverified.workflowKind === "generic" && (resultPreparationEvidence == null || resultSemanticAuthority == null || resultPreparedSourceAuthority == null ||
          !this.#same(resultPreparationEvidence.bundleIdentity, reverified.compilationBundle.identity) || !this.#same(resultPreparationEvidence.contractIdentity, reverified.contractIdentity) ||
          !this.#same(resultPreparationEvidence.semanticAuthorityIdentity, resultSemanticAuthority.identity) || !this.#same(resultPreparationEvidence.bundleIdentity, resultSemanticAuthority.bundleIdentity) ||
          !this.#same(resultPreparationEvidence.contractIdentity, resultSemanticAuthority.contractIdentity) || !this.#same(resultPreparationEvidence.genericProjectBindingIdentity, resultSemanticAuthority.genericProjectBindingIdentity) ||
          !this.#same(resultPreparationEvidence.freshMarkerContentIdentity, resultSemanticAuthority.freshMarkerContentIdentity) || !this.#same(resultPreparationEvidence.kicad, resultSemanticAuthority.kicad) ||
          !this.#same(resultPreparationEvidence.freshMarkerContentIdentity, resultPreparedSourceAuthority.marker))) {
          throw new FluxError("APPROVAL_MISMATCH", "Generic prepare evidence does not bind its full semantic authority, verified compilation bundle, contract, and prepared marker");
        }
        await this.#observe("side_effect_completed", "prepare_run", runId);
        const postPrepareState = await this.#store.read(); const postPrepareRun = postPrepareState.runs[runId];
        this.#assertAdmittedOperation(admittedState, postPrepareState, runId, "prepare_run", request, idempotencyKey);
        const postPrepare = await this.#verifiedPrepareRequest(postPrepareRun!, true);
        if (!this.#sameRequestAuthority(reverified, postPrepare)) throw new FluxError("APPROVAL_MISMATCH", "Run authority changed during isolated preparation");
        const saved = await this.#store.replace((state) => {
          const run = state.runs[runId]; if (run === undefined || run.phase !== "preparing") throw new FluxError("ILLEGAL_TRANSITION", "Run is no longer preparing");
          this.#assertAdmittedOperation(admittedState, state, runId, "prepare_run", request, idempotencyKey);
          const { inFlightOperation: _intent, ...base } = run;
          const prepared = freeze({ ...base, phase: "awaiting_open" as const,
            checkpointRequired: true, isolatedFingerprint: result.isolatedFingerprint,
            ...(resultPreparationEvidence == null ? {} : { freshNetClassPreparationEvidence: resultPreparationEvidence }),
            ...(resultSemanticAuthority == null ? {} : { freshNetClassSemanticAuthority: resultSemanticAuthority }),
            ...(resultPreparedSourceAuthority == null ? {} : { freshProjectOpenPreparedSourceAuthority: resultPreparedSourceAuthority }),
            preview: freeze({ ...result.preview }), updatedAt: fluxNow() });
          const dto = toRunDto(prepared);
          const next = replaceRun(state, prepared, event("run_prepared", "Preparation completed; approval is required.", runId));
          return { ...next, idempotency: this.#completed(state, "prepare_run", request, runId, runId, dto, idempotencyKey) };
        });
        return toRunDto(saved.runs[runId]!);
      } catch (error) { if (error instanceof FluxLifecycleObservationFailure) throw error; await this.#failIfPreparing(runId, error); throw error; }
    });
  }

  public async approvalSubject(runId: string): Promise<Readonly<{ subject: FluxApprovalSubject; digest: string }>> {
    await this.initialize(); const run = (await this.#store.read()).runs[runId];
    if (run === undefined) throw new FluxError("NOT_FOUND", "Run does not exist", { runId });
    if (!["awaiting_approval", "approved", "completed", "needs_review", "failed", "blocked"].includes(run.phase) || run.isolatedFingerprint === undefined) throw new FluxError("ILLEGAL_TRANSITION", "Run must retain verified Open and checkpoint authority before its approval subject is available");
    const subject = this.#subject(run, await this.#verifiedPrepareRequest(run, true));
    if (run.approval !== undefined && (run.approval.subjectDigest !== approvalSubjectDigest(subject) || !this.#same(run.approval.subject, subject))) throw new FluxError("APPROVAL_MISMATCH", "Persisted approval no longer matches the current run authority");
    return freeze({ subject, digest: approvalSubjectDigest(subject) });
  }

  public async approveRun(runId: string, presentedDigest: string, idempotencyKey?: string): Promise<FluxRunDto> {
    await this.initialize(); const request = { runId, presentedDigest };
    return this.#coalesce("approve_run", runId, request, idempotencyKey, async () => {
      const initialState = await this.#store.read();
      const initial = initialState.runs[runId]; if (initial === undefined) throw new FluxError("NOT_FOUND", "Run does not exist", { runId });
      const expectedSubject = this.#subject(initial, await this.#verifiedPrepareRequest(initial, true));
      const replay = this.#replay<FluxRunDto>(initialState, "approve_run", request, idempotencyKey); if (replay !== undefined) return replay;
      const expectedDigest = approvalSubjectDigest(expectedSubject);
      if (presentedDigest !== expectedDigest) throw new FluxError("APPROVAL_MISMATCH", "Approval digest does not bind this exact run subject");
      let output: FluxRunDto | undefined;
      const admittedState = await this.#store.replace((state) => {
        this.#assertNewIntent(state, "approve_run", request, idempotencyKey);
        const current = state.runs[runId]; if (current === undefined) throw new FluxError("NOT_FOUND", "Run does not exist", { runId });
        this.#assertUnchangedRun(initial, current);
        if (current.approval !== undefined) {
          if (current.approval.subjectDigest !== expectedDigest || !this.#same(current.approval.subject, expectedSubject)) throw new FluxError("APPROVAL_MISMATCH", "Persisted approval does not match run subject");
          if (current.approval.consumedAt !== undefined) throw new FluxError("APPROVAL_CONSUMED", "Approval was already consumed");
          output = toRunDto(current);
          return { ...state, idempotency: this.#completed(state, "approve_run", request, runId, runId, output, idempotencyKey) };
        }
        if (current.phase !== "awaiting_approval") throw new FluxError("ILLEGAL_TRANSITION", `Cannot transition run from ${current.phase}`);
        const approval: FluxPersistedApproval = freeze({ id: fluxId("approval"), subject: expectedSubject, subjectDigest: expectedDigest, approvedAt: fluxNow() });
        const approved = freeze({ ...current, phase: "approved" as const, approval, updatedAt: approval.approvedAt }); output = toRunDto(approved);
        const next = replaceRun(state, approved, event("approval_recorded", "Recorded one-time approval for the exact prepared subject.", runId));
        return { ...next, idempotency: this.#completed(state, "approve_run", request, runId, runId, output, idempotencyKey) };
      });
      if (output === undefined) throw new FluxError("STORE_CORRUPT", "Approval result was not persisted"); return output;
    });
  }

  /** Queues immediately; execution is serialized globally and completes asynchronously. */
  public async resumeRun(runId: string, idempotencyKey?: string): Promise<FluxRunDto> {
    await this.initialize(); const request = { runId };
    return this.#coalesce("resume_run", runId, request, idempotencyKey, async () => {
      const initialState = await this.#store.read();
      const initial = initialState.runs[runId]; if (initial === undefined) throw new FluxError("NOT_FOUND", "Run does not exist", { runId });
      const subject = this.#subject(initial, await this.#verifiedPrepareRequest(initial, true)); const subjectDigest = approvalSubjectDigest(subject);
      const replay = this.#replay<FluxRunDto>(initialState, "resume_run", request, idempotencyKey); if (replay !== undefined) return replay;
      let queued: FluxRunDto | undefined;
      const admittedState = await this.#store.replace((state) => {
        this.#assertNewIntent(state, "resume_run", request, idempotencyKey);
        const run = state.runs[runId]; if (run === undefined) throw new FluxError("NOT_FOUND", "Run does not exist", { runId });
        this.#assertUnchangedRun(initial, run);
        if (run.phase !== "approved") throw new FluxError("ILLEGAL_TRANSITION", `Cannot transition run from ${run.phase}`);
        const approval = run.approval;
        if (approval === undefined || approval.consumedAt !== undefined) throw new FluxError("APPROVAL_CONSUMED", "An unconsumed approval is required");
        if (approval.subjectDigest !== subjectDigest || !this.#same(approval.subject, subject)) throw new FluxError("APPROVAL_MISMATCH", "Approval does not match current run authority");
        const consumedAt = fluxNow();
        const consumed = freeze({ ...run, approval: { ...approval, consumedAt } });
        const queuedRun = freeze({ ...consumed, phase: "queued" as const,
          inFlightOperation: this.#operationIntent("resume_run", request, consumed), updatedAt: consumedAt }); queued = toRunDto(queuedRun);
        const next = replaceRun(state, queuedRun, event("run_queued", "Approval consumed; run queued for globally serialized execution.", runId));
        return { ...next, idempotency: this.#pending(state, "resume_run", request, runId, runId, idempotencyKey) };
      });
      if (queued === undefined) throw new FluxError("STORE_CORRUPT", "Queued result was not persisted");
      const admittedRun = admittedState.runs[runId]!;
      this.#assertAdmittedRun(admittedRun, admittedRun, "resume_run", request);
      await this.#observe("intent_persisted", "resume_run", runId);
      const receipt = { operation: "resume_run" as const, request, result: queued, admittedRun, admittedState, ...(idempotencyKey === undefined ? {} : { key: idempotencyKey }) };
      const scheduled = processExecutionTail.then(() => this.#execute(runId, receipt), () => this.#execute(runId, receipt));
      processExecutionTail = scheduled.catch(() => undefined); this.#executionTail = scheduled; return queued;
    });
  }

  public async open(projectId: string, runId?: string, idempotencyKey?: string): Promise<FluxOpenResult> {
    await this.initialize(); if (this.options.ports.open === undefined || this.options.ports.preflightOpen === undefined || this.options.ports.cancelOpenPreflight === undefined) throw new FluxError("ILLEGAL_TRANSITION", "Open preflight, cancellation, and launch ports are required");
    if (runId === undefined) throw new FluxError("INVALID_ARGUMENT", "Opening Flux requires an explicit run binding");
    const request = { projectId, runId }; const resultId = runId;
    return this.#coalesce("open_project", resultId, request, idempotencyKey, async () => {
      const initialState = await this.#store.read();
      const initial = initialState.runs[runId];
      if (initial === undefined || initial.projectId !== projectId) throw new FluxError("NOT_FOUND", "Run does not belong to project", { runId, projectId });
      const existing = idempotencyKey === undefined ? undefined : initialState.idempotency[idempotencyKey];
      if (existing?.status === "preflight_uncertain") this.#replay<FluxOpenResult>(initialState, "open_project", request, idempotencyKey);
      const initialPreparation = await this.#verifiedPrepareRequest(initial, true);
      const replay = this.#replay<FluxOpenResult>(initialState, "open_project", request, idempotencyKey); if (replay !== undefined) return replay;
      if (initial.phase !== "awaiting_open") throw new FluxError("ILLEGAL_TRANSITION", "Run is not eligible for Open");
      let preflightReceipt: FluxOpenPreflightReceipt;
      try {
        preflightReceipt = this.#parseOpenPreflightReceipt(await this.options.ports.preflightOpen!({ projectId, runId, preparation: initialPreparation }), projectId, runId, initialPreparation);
      } catch (error) {
        if (error instanceof FluxError && error.code === "OPERATION_UNCERTAIN") {
          await this.#recordOpenPreflightUncertainty(initial, request, idempotencyKey);
          throw new FluxError("OPERATION_UNCERTAIN", FLUX_OPEN_PREFLIGHT_UNCERTAIN_MESSAGE, { operation: "open_project", runId });
        }
        await this.#recordOpenPreflightFailure(initial, request, idempotencyKey);
        throw new FluxError("OPEN_PREFLIGHT_FAILED", "Open preflight failed before any editor launch; retry is safe with the same idempotency key");
      }
      let admittedState: FluxPersistedState;
      try {
        const afterPreflightState = await this.#store.read(); const afterPreflightRun = afterPreflightState.runs[runId];
        this.#assertUnchangedRun(initial, afterPreflightRun!);
        const afterPreflightPreparation = await this.#verifiedPrepareRequest(afterPreflightRun!, true);
        if (!this.#sameRequestAuthority(initialPreparation, afterPreflightPreparation)) throw new FluxError("APPROVAL_MISMATCH", "Run authority changed during Open preflight");
        admittedState = await this.#store.replace((state) => {
          this.#assertNewIntent(state, "open_project", request, idempotencyKey);
          if (state.projects[projectId] === undefined) throw new FluxError("NOT_FOUND", "Project does not exist", { projectId });
          const run = state.runs[runId]; if (run === undefined) throw new FluxError("NOT_FOUND", "Run does not belong to project", { runId, projectId });
          this.#assertUnchangedRun(initial, run);
          const allowed = run.phase === "awaiting_open";
          if (!allowed) throw new FluxError("ILLEGAL_TRANSITION", "Run is not eligible for Open");
          const { blockedReason: _recoveryReason, ...openable } = run;
          const opening = freeze({ ...openable, phase: "opening" as const,
            inFlightOperation: this.#openOperationIntent(request, openable, preflightReceipt), updatedAt: fluxNow() });
          const next = replaceRun(state, opening);
          return { ...next, idempotency: this.#pending(state, "open_project", request, resultId, resultId, idempotencyKey, preflightReceipt) };
        });
      } catch (error) {
        try { await this.options.ports.cancelOpenPreflight!(preflightReceipt); }
        catch {
          await this.#recordOpenPreflightUncertainty(initial, request, idempotencyKey);
          throw new FluxError("OPERATION_UNCERTAIN", FLUX_OPEN_PREFLIGHT_UNCERTAIN_MESSAGE, { operation: "open_project", runId });
        }
        throw error;
      }
      const opening = admittedState.runs[runId]!;
      await this.#observe("intent_persisted", "open_project", resultId);
      this.#assertAdmittedOperation(admittedState, await this.#store.read(), runId, "open_project", request, idempotencyKey);
      const preparation = await this.#verifiedPrepareRequest(opening, true);
      const result = this.#parseOpenResult(await this.options.ports.open!({ projectId, runId, preparation, preflightReceipt }));
      if (!result.opened) {
        await this.#restoreKnownNotOpened(admittedState, runId, request, idempotencyKey);
        throw new FluxError("ILLEGAL_TRANSITION", "Open port reported that the isolated board was not opened");
      }
      if (!result.checkpointRequired) throw new FluxError("INVALID_ARGUMENT", "Open port must require a bound checkpoint before approval");
      await this.#observe("side_effect_completed", "open_project", resultId);
      const postOpenState = await this.#store.read(); const postOpenRun = postOpenState.runs[runId];
      this.#assertAdmittedOperation(admittedState, postOpenState, runId, "open_project", request, idempotencyKey);
      const postOpen = await this.#verifiedPrepareRequest(postOpenRun!, true);
      if (!this.#sameRequestAuthority(preparation, postOpen)) throw new FluxError("APPROVAL_MISMATCH", "Run authority changed during Open");
      await this.#store.replace((state) => {
        const run = state.runs[runId]; if (run === undefined) throw new FluxError("NOT_FOUND", "Run does not exist", { runId });
        this.#assertAdmittedOperation(admittedState, state, runId, "open_project", request, idempotencyKey);
        const { inFlightOperation: _intent, ...base } = run;
        const opened = freeze({ ...base, phase: "awaiting_checkpoint" as const, checkpointRequired: true, openPreflightReceipt: preflightReceipt, updatedAt: fluxNow() });
        const next = replaceRun(state, opened, event("run_opened", "Opened isolated board; checkpoint-open is required before approval.", runId));
        return { ...next, idempotency: this.#completed(state, "open_project", request, resultId, resultId, result, idempotencyKey) };
      });
      return result;
    });
  }

  public async checkpointOpenRun(runId: string, idempotencyKey?: string): Promise<FluxRunDto> {
    await this.initialize();
    const request = { runId };
    return this.#coalesce("checkpoint_open", runId, request, idempotencyKey, async () => {
      const initialState = await this.#store.read();
      const initial = initialState.runs[runId]; if (initial === undefined) throw new FluxError("NOT_FOUND", "Run does not exist", { runId });
      // A terminal failure is replayable even when its dependency authority is no longer available.
      if (idempotencyKey !== undefined && initialState.idempotency[idempotencyKey]?.status === "failed") this.#replay<FluxRunDto>(initialState, "checkpoint_open", request, idempotencyKey);
      if (this.options.ports.checkpointOpen === undefined) throw new FluxError("ILLEGAL_TRANSITION", "No checkpoint-open port is configured");
      if (initial.openPreflightReceipt === undefined) throw new FluxError("ILLEGAL_TRANSITION", "Run has no verified Open preflight receipt");
      const initialPreparation = await this.#verifiedPrepareRequest(initial, true); const initialPreflightReceipt = initialPreparation.openPreflightReceipt;
      if (initialPreflightReceipt === undefined) throw new FluxError("ILLEGAL_TRANSITION", "Run has no current verified Open preflight receipt");
      const replay = this.#replay<FluxRunDto>(initialState, "checkpoint_open", request, idempotencyKey); if (replay !== undefined) return replay;
      const admittedState = await this.#store.replace((state) => {
        this.#assertNewIntent(state, "checkpoint_open", request, idempotencyKey);
        const run = state.runs[runId]; if (run === undefined) throw new FluxError("NOT_FOUND", "Run does not exist", { runId }); this.#assertUnchangedRun(initial, run);
        if (run.phase !== "awaiting_checkpoint" || run.checkpointRequired !== true) throw new FluxError("ILLEGAL_TRANSITION", "Run must be opened before checkpoint-open");
        const checkpointing = freeze({ ...run, phase: "checkpointing" as const,
          inFlightOperation: this.#operationIntent("checkpoint_open", request, run), updatedAt: fluxNow() });
        const next = replaceRun(state, checkpointing);
        return { ...next, idempotency: this.#pending(state, "checkpoint_open", request, runId, runId, idempotencyKey) };
      });
      const checkpointing = admittedState.runs[runId]!;
      const abortController = new AbortController(); const deadlineAtMs = Date.now() + FLUX_CHECKPOINT_OPERATION_TIMEOUT_MS; let timedOut = false;
      const assertActive = (): void => {
        if (Date.now() >= deadlineAtMs) timedOut = true;
        if (abortController.signal.aborted || timedOut) throw new FluxError("OPERATION_UNCERTAIN", timedOut ? FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE : FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE);
      };
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true; abortController.abort();
          reject(new FluxError("OPERATION_UNCERTAIN", FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE, { operation: "checkpoint_open", runId }));
        }, FLUX_CHECKPOINT_OPERATION_TIMEOUT_MS);
        timeoutHandle.unref?.();
      });
      try {
        const operationContext = Object.freeze({ signal: abortController.signal, deadlineAtMs });
        const operation = (async (): Promise<FluxRunDto> => {
          assertActive();
          await this.#observe("intent_persisted", "checkpoint_open", runId); assertActive();
          const current = await this.#store.read(); assertActive();
          this.#assertAdmittedOperation(admittedState, current, runId, "checkpoint_open", request, idempotencyKey);
          const preparation = await this.#verifiedPrepareRequest(checkpointing, true); assertActive();
          const rawResult = await this.options.ports.checkpointOpen!({ ...preparation, openPreflightReceipt: initialPreflightReceipt }, operationContext); assertActive();
          const result = this.#parsePrepareResult(rawResult, preparation.workflowKind, { runId, openPreflightReceipt: initialPreflightReceipt });
          await this.#observe("side_effect_completed", "checkpoint_open", runId); assertActive();
          if (result.checkpointRequired) throw new FluxError("INVALID_ARGUMENT", "Checkpoint-open port did not clear the checkpoint requirement");
          const postCheckpointState = await this.#store.read(); assertActive();
          const postCheckpointRun = postCheckpointState.runs[runId];
          this.#assertAdmittedOperation(admittedState, postCheckpointState, runId, "checkpoint_open", request, idempotencyKey);
          const postCheckpoint = await this.#verifiedPrepareRequest(postCheckpointRun!, true); assertActive();
          if (!this.#sameRequestAuthority(preparation, postCheckpoint)) throw new FluxError("APPROVAL_MISMATCH", "Run authority changed during checkpoint-open");
          const saved = await this.#store.replace((state) => {
            assertActive();
            const run = state.runs[runId]; if (run === undefined) throw new FluxError("NOT_FOUND", "Run does not exist", { runId });
            this.#assertAdmittedOperation(admittedState, state, runId, "checkpoint_open", request, idempotencyKey);
            const { inFlightOperation: _intent, ...base } = run;
            const openCheckpointReceipt = result.openCheckpointReceipt!;
            const checkpointed = freeze({ ...base, phase: "awaiting_approval" as const, checkpointRequired: false,
              isolatedFingerprint: result.isolatedFingerprint, openCheckpointReceipt, preview: freeze({ ...result.preview }), updatedAt: fluxNow() });
            const dto = toRunDto(checkpointed);
            const next = replaceRun(state, checkpointed, event("open_checkpoint_recorded", "Recorded provider-free KiCad open-normalization checkpoint; approval is now available.", runId));
            return { ...next, idempotency: this.#completed(state, "checkpoint_open", request, runId, runId, dto, idempotencyKey) };
          }, assertActive);
          return toRunDto(saved.runs[runId]!);
        })();
        return await Promise.race([operation, timeout]);
      } catch {
        timedOut ||= Date.now() >= deadlineAtMs;
        abortController.abort();
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        const failure = freeze({ code: "OPERATION_UNCERTAIN" as const, message: timedOut ? FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE : FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE, details: {} });
        const saved = await this.#settleCheckpointUncertain(admittedState, runId, request, idempotencyKey, failure);
        // An atomic rename already issued before the deadline may win the terminal transition.
        if (saved.runs[runId]?.phase === "awaiting_approval") return toRunDto(saved.runs[runId]!);
        throw this.#failureError(failure, idempotencyKey === undefined ? undefined : this.#terminalFailureReceipt(saved, idempotencyKey));
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      }
    });
  }

  public async queueSnapshot(): Promise<FluxQueueSnapshot> {
    await this.initialize(); const state = await this.#store.read();
    return freeze({ ...(this.#busyRunId === undefined ? {} : { busyRunId: this.#busyRunId }), queuedRunIds: Object.values(state.runs).filter((run) => run.phase === "queued" && run.id !== this.#busyRunId).map((run) => run.id) });
  }
  public async getRun(runId: string): Promise<FluxRunDto> {
    await this.initialize(); const run = (await this.#store.read()).runs[runId];
    if (run === undefined) throw new FluxError("NOT_FOUND", "Run does not exist", { runId }); return this.#verifiedRunDto(run);
  }
  async #verifiedRunDto(run: FluxPersistedRun): Promise<FluxRunDto> {
    if (run.workflowKind === "generic" && run.contractState?.disposition === "ready" && run.compilationBundleRef !== undefined && !["blocked", "failed"].includes(run.phase)) await this.#verifiedGenericBundle(run);
    return toRunDto(run);
  }
  /** Runtime-only authority reload; callers must never project this result over HTTP. */
  public async verifiedPreparation(runId: string): Promise<FluxPrepareRequest> {
    await this.initialize();
    const run = (await this.#store.read()).runs[runId];
    if (run === undefined) throw new FluxError("NOT_FOUND", "Run does not exist", { runId });
    return this.#verifiedPrepareRequest(run, true);
  }
  public async events(): Promise<readonly FluxEventDto[]> { await this.initialize(); return freeze([...(await this.#store.read()).events]); }
  public async recordProgress(runId: string, detail: string): Promise<void> {
    await this.initialize(); const normalized = detail.replace(/\s+/gu, " ").trim().slice(0, 240); if (!normalized) return;
    await this.#store.replace((state) => { const run = state.runs[runId]; return run?.phase === "running" ? { ...state, events: [...state.events, event("run_progress", normalized, runId)] } : state; });
  }
  public async waitForIdle(): Promise<void> { await this.#executionTail; }

  async #execute(runId: string, receipt: Readonly<{ readonly operation: "resume_run"; readonly request: unknown; readonly result: FluxRunDto; readonly admittedRun: FluxPersistedRun; readonly admittedState: FluxPersistedState; readonly key?: string }>): Promise<void> {
    this.#busyRunId = runId;
    let executionReceiptState = receipt.admittedState;
    try {
      const queuedState = await this.#store.read(); const queued = queuedState.runs[runId];
      if (queued === undefined || queued.phase !== "queued") throw new FluxError("ILLEGAL_TRANSITION", "Run is no longer queued");
      this.#assertAdmittedOperation(receipt.admittedState, queuedState, runId, "resume_run", receipt.request, receipt.key);
      const queuedPreparation = await this.#verifiedPrepareRequest(queued, true); const queuedSubject = this.#subject(queued, queuedPreparation);
      if (queued.approval === undefined || queued.approval.consumedAt === undefined || queued.approval.subjectDigest !== approvalSubjectDigest(queuedSubject) || !this.#same(queued.approval.subject, queuedSubject)) throw new FluxError("APPROVAL_MISMATCH", "Queued run no longer matches its consumed approval");
      const runningState = await this.#store.replace((state) => {
        const run = state.runs[runId]; if (run === undefined) throw new FluxError("NOT_FOUND", "Run does not exist", { runId });
        this.#assertAdmittedOperation(receipt.admittedState, state, runId, "resume_run", receipt.request, receipt.key);
        if (run.phase !== "queued") throw new FluxError("ILLEGAL_TRANSITION", "Run is no longer queued");
        return replaceRun(state, freeze({ ...run, phase: "running" as const, updatedAt: fluxNow() }), event("run_started", "Run started.", runId));
      });
      executionReceiptState = runningState;
      const running = runningState.runs[runId]!;
      this.#assertAdmittedOperation(runningState, runningState, runId, "resume_run", receipt.request, receipt.key);
      const preparation = await this.#verifiedPrepareRequest(running, true); const subject = this.#subject(running, preparation); const approval = running.approval;
      if (approval === undefined || approval.consumedAt === undefined || approval.subjectDigest !== approvalSubjectDigest(subject) || !this.#same(approval.subject, subject)) throw new FluxError("APPROVAL_MISMATCH", "Executing run no longer matches its consumed approval");
      const executeRequest: FluxExecuteRequest = preparation.workflowKind === "generic"
        ? { ...preparation, approval: subject as FluxGenericApprovalSubject }
        : { ...preparation, approval: subject as FluxLedCompatibilityApprovalSubject };
      const output = this.#parseExecutionResult(await this.options.ports.execute(executeRequest), preparation.openCheckpointReceipt!.writeSessionAuthorityIdentity, preparation.workflowKind, subject,
        preparation.workflowKind === "generic" ? preparation.freshNetClassPreparationEvidence : null,
        preparation.workflowKind === "generic" ? preparation.freshNetClassSemanticAuthority : null);
      const postExecutionState = await this.#store.read(); const postExecutionRun = postExecutionState.runs[runId]!;
      this.#assertAdmittedOperation(runningState, postExecutionState, runId, "resume_run", receipt.request, receipt.key);
      const postExecution = await this.#verifiedPrepareRequest(postExecutionRun, true);
      const postSubject = this.#subject(postExecutionRun, postExecution);
      if (!this.#sameRequestAuthority(preparation, postExecution) || postExecutionRun.approval?.subjectDigest !== approvalSubjectDigest(postSubject) || !this.#same(postExecutionRun.approval?.subject, postSubject)) {
        throw new FluxError("APPROVAL_MISMATCH", "Run authority changed during execution");
      }
      await this.#store.replace((state) => {
        const run = state.runs[runId]; if (run === undefined) throw new FluxError("NOT_FOUND", "Run does not exist", { runId });
        this.#assertAdmittedOperation(runningState, state, runId, "resume_run", receipt.request, receipt.key);
        if (run.phase !== "running") throw new FluxError("ILLEGAL_TRANSITION", "Run is no longer executing");
        const now = fluxNow(); const metadata = (output.reports ?? []).map((report) => freeze({ ...report, reportId: fluxId("report"), createdAt: now }));
        const reports = { ...state.reports }; for (const report of metadata) reports[report.reportId] = freeze({ ...report, runId, body: "" });
        const phase = output.disposition; const kind = phase === "completed" ? "run_completed" : phase === "needs_review" ? "run_needs_review" : phase === "blocked" ? "run_blocked" : "run_failed";
        const detail = phase === "completed" ? "Run completed." : phase === "needs_review" ? "Run completed with review-required evidence." : phase === "blocked" ? "Run stopped at a declared blocker." : "Run failed.";
        const { inFlightOperation: _intent, ...base } = run;
        return replaceRun({ ...state, reports }, { ...base, phase, reports: [...run.reports, ...metadata],
          ...(output.freshClearanceEvidenceReceipt === undefined ? {} : { freshClearanceEvidenceReceipt: output.freshClearanceEvidenceReceipt }),
          ...(output.blockedReason === undefined ? {} : { blockedReason: output.blockedReason }), updatedAt: now }, event(kind, detail, runId));
      });
    } catch (error) { await this.#failIfExecuting(runId, error); }
    finally {
      try {
        await this.#refreshAfterTerminal(runId);
        this.#assertAdmittedReceipt(executionReceiptState, await this.#store.read(), receipt.operation, receipt.request, receipt.key);
        await this.#observe("side_effect_completed", "resume_run", runId);
        await this.#store.replace((state) => {
          this.#assertAdmittedReceipt(executionReceiptState, state, receipt.operation, receipt.request, receipt.key);
          return { ...state, idempotency: this.#completed(state, receipt.operation, receipt.request, runId, runId, receipt.result, receipt.key) };
        });
      } finally { this.#busyRunId = undefined; }
    }
  }

  async #refreshAfterTerminal(runId: string): Promise<void> {
    if (this.options.ports.afterTerminal === undefined) return;
    try {
      const preview = this.#parsePreviewMetadata(await this.options.ports.afterTerminal({ runId }), "Terminal preview");
      await this.#store.replace((state) => {
        const run = state.runs[runId];
        return run === undefined || !TERMINAL_PHASES.has(run.phase) ? state : replaceRun(state, { ...run, preview: freeze({ ...preview }), updatedAt: fluxNow() }, event("preview_ready", "Terminal candidate preview is ready.", runId));
      });
    } catch {
      await this.#store.replace((state) => {
        const run = state.runs[runId];
        return run === undefined ? state : { ...state, events: [...state.events, event("preview_warning", "Terminal preview refresh was unavailable; the prior preview remains visible.", runId)] };
      });
    }
  }

  async #verifiedPrepareRequest(run: FluxPersistedRun, verifySourceFingerprint: boolean): Promise<FluxPrepareRequest> {
    if (run.blockedReason === FLUX_LEGACY_AUTHORED_NETCLASS_REVIEW_MESSAGE || [run.freshNetClassPreparationEvidence, run.freshNetClassSemanticAuthority, run.freshClearanceEvidenceReceipt].some(isFluxLegacyNetClassEvidence)) throw new FluxError("APPROVAL_MISMATCH", "Historical cache-based net-class evidence cannot authorize Open, approval or execution; prepare a new run.");
    const source = await this.#sourceForRun(run, verifySourceFingerprint); const state = run.contractState;
    if (state?.disposition !== "ready" || state.contractIdentity === null || state.libraryBindingIdentity === null || state.deepRuleBindingIdentity === null || state.acceptancePlanIdentity === null) throw new FluxError("ILLEGAL_TRANSITION", "Run lacks a complete ready contract identity set");
    let freshNetClassPreparationEvidence: FreshNetClassPreparationEvidence | undefined;
    if (run.freshNetClassPreparationEvidence !== undefined) {
      if (run.workflowKind !== "generic") throw new FluxError("STORE_CORRUPT", "LED compatibility run contains generic net-class preparation evidence");
      try { freshNetClassPreparationEvidence = parseFreshNetClassPreparationEvidence(run.freshNetClassPreparationEvidence); }
      catch { throw new FluxError("STORE_CORRUPT", "Run fresh net-class preparation evidence is invalid"); }
    } else if (run.workflowKind === "generic" && ["awaiting_open", "opening", "awaiting_checkpoint", "checkpointing", "awaiting_approval", "approved", "queued", "running", "completed"].includes(run.phase)) {
      throw new FluxError("APPROVAL_MISMATCH", "Generic run lacks stable fresh net-class semantic preparation authority");
    }
    let freshNetClassSemanticAuthority: FreshNetClassSemanticAuthority | undefined;
    if (run.freshNetClassSemanticAuthority !== undefined) {
      if (run.workflowKind !== "generic") throw new FluxError("STORE_CORRUPT", "LED compatibility run contains full generic semantic authority");
      try { freshNetClassSemanticAuthority = parseFreshNetClassSemanticAuthority(run.freshNetClassSemanticAuthority); }
      catch { throw new FluxError("STORE_CORRUPT", "Run full fresh net-class semantic authority is invalid"); }
    } else if (run.workflowKind === "generic" && ["awaiting_open", "opening", "awaiting_checkpoint", "checkpointing", "awaiting_approval", "approved", "queued", "running", "completed"].includes(run.phase)) {
      throw new FluxError("APPROVAL_MISMATCH", "Generic run lacks its full restart-verifiable net-class semantic authority");
    }
    let freshProjectOpenPreparedSourceAuthority: FreshProjectOpenPreparedSourceAuthority | undefined;
    if (run.freshProjectOpenPreparedSourceAuthority !== undefined) {
      if (run.workflowKind !== "generic") throw new FluxError("STORE_CORRUPT", "LED compatibility run contains generic prepared-source authority");
      try { freshProjectOpenPreparedSourceAuthority = parseFreshProjectOpenPreparedSourceAuthority(run.freshProjectOpenPreparedSourceAuthority); }
      catch { throw new FluxError("STORE_CORRUPT", "Run fresh project prepared-source authority is invalid"); }
      this.#assertPreparedSourceAuthorityWithinWorkspace(freshProjectOpenPreparedSourceAuthority);
    } else if (run.workflowKind === "generic" && ["awaiting_open", "opening", "awaiting_checkpoint", "checkpointing", "awaiting_approval", "approved", "queued", "running", "completed"].includes(run.phase)) {
      throw new FluxError("APPROVAL_MISMATCH", "Generic run lacks lifecycle-owned prepared-source authority");
    }
    let openPreflightReceipt: FluxOpenPreflightReceipt | undefined; let openCheckpointReceipt: FluxOpenCheckpointReceipt | undefined;
    const freshNetClassSemanticAuthorityIdentity = run.workflowKind === "generic" ? freshNetClassPreparationEvidence?.semanticAuthorityIdentity : null;
    const freshNetClassPreparationEvidenceIdentity = run.workflowKind === "generic" ? freshNetClassPreparationEvidence?.identity : null;
    const freshProjectOpenPreparedSourceAuthorityIdentity = run.workflowKind === "generic" ? freshProjectOpenPreparedSourceAuthority?.identity : null;
    if (run.openPreflightReceipt !== undefined) {
      if (run.openPreflightReceipt.schemaVersion !== "evleda.flux-open-preflight.v5") throw new FluxError("APPROVAL_MISMATCH", "Run Open preflight receipt predates bound preparation-evidence authority");
      try { openPreflightReceipt = parseFluxOpenPreflightReceipt(run.openPreflightReceipt); }
      catch { throw new FluxError("STORE_CORRUPT", "Run Open preflight receipt is invalid"); }
      if (openPreflightReceipt.runId !== run.id || openPreflightReceipt.projectId !== run.projectId || !this.#same(openPreflightReceipt.inspectionBridgeIdentity, this.#activeInspectionBridgeIdentity) ||
        !this.#same(openPreflightReceipt.freshNetClassSemanticAuthorityIdentity, freshNetClassSemanticAuthorityIdentity) || !this.#same(openPreflightReceipt.freshProjectOpenPreparedSourceAuthorityIdentity, freshProjectOpenPreparedSourceAuthorityIdentity) ||
        !this.#same(openPreflightReceipt.freshNetClassPreparationEvidenceIdentity, freshNetClassPreparationEvidenceIdentity)) {
        throw new FluxError("APPROVAL_MISMATCH", "Run Open preflight receipt does not bind its project, run, active inspection bridge, and generic preparation authorities");
      }
    }
    if (run.openCheckpointReceipt !== undefined) {
      if (run.openCheckpointReceipt.schemaVersion !== "evleda.flux-open-checkpoint.v6") throw new FluxError("APPROVAL_MISMATCH", "Run Open checkpoint receipt predates bound preparation-evidence authority");
      try { openCheckpointReceipt = parseFluxOpenCheckpointReceipt(run.openCheckpointReceipt); }
      catch { throw new FluxError("STORE_CORRUPT", "Run Open checkpoint receipt is invalid"); }
      if (openPreflightReceipt === undefined || openCheckpointReceipt.runId !== run.id || !this.#same(openCheckpointReceipt.openPreflightReceiptIdentity, openPreflightReceipt.identity) ||
        !this.#same(openCheckpointReceipt.kicadToolchainIdentity, this.#activeKicadToolchainIdentity) || !this.#same(openCheckpointReceipt.inspectionBridgeIdentity, this.#activeInspectionBridgeIdentity) || !this.#same(openCheckpointReceipt.executionBridgeIdentity, this.#activeExecutionBridgeIdentity) ||
        !this.#same(openCheckpointReceipt.ipcSocketIdentity, openPreflightReceipt.ipcSocketIdentity) || !this.#same(openCheckpointReceipt.freshNetClassSemanticAuthorityIdentity, freshNetClassSemanticAuthorityIdentity) ||
        !this.#same(openCheckpointReceipt.freshProjectOpenPreparedSourceAuthorityIdentity, freshProjectOpenPreparedSourceAuthorityIdentity) ||
        !this.#same(openCheckpointReceipt.freshNetClassPreparationEvidenceIdentity, freshNetClassPreparationEvidenceIdentity) ||
        openCheckpointReceipt.isolatedFingerprint !== run.isolatedFingerprint) throw new FluxError("APPROVAL_MISMATCH", "Run Open checkpoint receipt does not match active toolchain, inspection bridge, IPC socket, semantic net-class, and project authority");
    }
    const base = {
      runId: run.id, sourceKey: run.sourceKey, sourceFingerprint: run.sourceFingerprint, sourceRoot: source.sourceRoot,
      providerModel: { ...run.providerModel }, iterationCap: run.iterationCap, harnessRuleIdentity: run.harnessRuleIdentity,
      mutationAllowlist: [...run.mutationAllowlist], freshAcceptanceProfileIdentity: run.freshAcceptanceProfileIdentity,
      freshPersistenceProfileIdentity: run.freshPersistenceProfileIdentity, contractIdentity: { ...state.contractIdentity },
      libraryBindingIdentity: { ...state.libraryBindingIdentity }, deepRuleBindingIdentity: { ...state.deepRuleBindingIdentity },
      acceptancePlanIdentity: { ...state.acceptancePlanIdentity }, ...(openPreflightReceipt === undefined ? {} : { openPreflightReceipt }),
      ...(openCheckpointReceipt === undefined ? {} : { openCheckpointReceipt }),
      ...(freshNetClassPreparationEvidence === undefined ? {} : { freshNetClassPreparationEvidence }),
      ...(freshNetClassSemanticAuthority === undefined ? {} : { freshNetClassSemanticAuthority }),
      ...(freshProjectOpenPreparedSourceAuthority === undefined ? {} : { freshProjectOpenPreparedSourceAuthority })
    };
    if (run.workflowKind === "led_compatibility_fixture") {
      if (run.compilationBundleRef !== undefined || state.interpreterReceipt.schemaVersion !== "evleda.flux-interpreter-receipt.v1" || state.interpreterReceipt.provider !== "compatibility-fixture") {
        throw new FluxError("STORE_CORRUPT", "LED compatibility workflow contains generic compilation authority");
      }
      const preparation = freeze({ ...base, workflowKind: run.workflowKind, prompt: run.prompt } satisfies FluxLedCompatibilityPrepareRequest);
      this.#assertOpenPreflightPreparationBinding(preparation);
      return preparation;
    }
    const { bundle, reference, providerProfile } = await this.#verifiedGenericBundle(run);
    if (bundle.acceptancePlan.schemaVersion !== "evleda.pcb-acceptance-plan.v2" || bundle.compilerProfile.schemaVersion !== "evleda.pcb-design-compiler-profile.v2") throw new FluxError("APPROVAL_MISMATCH", "Historical acceptance profiles remain readable but require a new current compilation and approval before execution.");
    if (freshNetClassPreparationEvidence !== undefined && (!this.#same(freshNetClassPreparationEvidence.bundleIdentity, bundle.identity) || !this.#same(freshNetClassPreparationEvidence.contractIdentity, bundle.contract.identity) ||
      (freshNetClassSemanticAuthority !== undefined && (!this.#same(freshNetClassPreparationEvidence.semanticAuthorityIdentity, freshNetClassSemanticAuthority.identity) ||
        !this.#same(freshNetClassPreparationEvidence.bundleIdentity, freshNetClassSemanticAuthority.bundleIdentity) || !this.#same(freshNetClassPreparationEvidence.contractIdentity, freshNetClassSemanticAuthority.contractIdentity) ||
        !this.#same(freshNetClassPreparationEvidence.genericProjectBindingIdentity, freshNetClassSemanticAuthority.genericProjectBindingIdentity) || !this.#same(freshNetClassPreparationEvidence.freshMarkerContentIdentity, freshNetClassSemanticAuthority.freshMarkerContentIdentity) ||
        !this.#same(freshNetClassPreparationEvidence.kicad, freshNetClassSemanticAuthority.kicad))) ||
      (freshProjectOpenPreparedSourceAuthority !== undefined && !this.#same(freshNetClassPreparationEvidence.freshMarkerContentIdentity, freshProjectOpenPreparedSourceAuthority.marker)))) {
      throw new FluxError("APPROVAL_MISMATCH", "Fresh net-class preparation evidence does not bind the verified compilation bundle, contract, full semantic authority, and prepared marker");
    }
    const preparation = freeze({
      ...base, workflowKind: "generic", compilationBundle: bundle, compilationBundleRef: reference, providerProfile,
      promptIdentity: { ...bundle.executionPrompt.originalPromptContentIdentity }, compilerProfileIdentity: { ...bundle.compilerProfile.identity },
      practiceProfileBindingIdentity: { ...bundle.practiceProfileBinding.identity }, executionPromptIdentity: { ...bundle.executionPrompt.identity },
      executionPromptContentIdentity: { ...bundle.executionPrompt.textContentIdentity }
    } satisfies FluxGenericPrepareRequest);
    this.#assertOpenPreflightPreparationBinding(preparation);
    return preparation;
  }

  async #verifiedGenericBundle(run: FluxPersistedRun): Promise<Readonly<{
    readonly bundle: PcbDesignCompilationBundle; readonly reference: PcbDesignCompilationBundleRef; readonly providerProfile: PcbProviderProfileBinding;
  }>> {
    const store = this.options.compilationBundleStore;
    if (store === undefined || run.compilationBundleRef === undefined) throw new FluxError("STORE_CORRUPT", "Generic run has no configured durable compilation bundle");
    try {
      const reference = parsePcbDesignCompilationBundleRef(run.compilationBundleRef); const bundle = await store.get(reference);
      this.#assertGenericBundleClosure(run, bundle, reference);
      const receipt = run.contractState!.interpreterReceipt;
      if (receipt.schemaVersion !== "evleda.flux-interpreter-receipt.v2") throw new Error("legacy receipt");
      const providerProfile = parsePcbProviderProfileBinding(receipt.providerProfile);
      if (this.options.activeProviderProfile !== undefined && !this.#same(parsePcbProviderProfileBinding(this.options.activeProviderProfile), providerProfile)) {
        throw new FluxError("APPROVAL_MISMATCH", "Generic run provider profile does not match the active host interpreter profile");
      }
      return freeze({ bundle, reference, providerProfile });
    } catch (error) {
      if (error instanceof FluxError && (error.code === "ILLEGAL_TRANSITION" || error.code === "APPROVAL_MISMATCH")) throw error;
      throw new FluxError("STORE_CORRUPT", "Generic compilation bundle failed durable verification");
    }
  }

  #assertGenericBundleClosure(run: FluxPersistedRun, bundle: PcbDesignCompilationBundle, referenceValue: PcbDesignCompilationBundleRef): void {
    const reference = parsePcbDesignCompilationBundleRef(referenceValue); const state = run.contractState;
    if (run.workflowKind !== "generic" || state?.disposition !== "ready" || state.interpreterReceipt.schemaVersion !== "evleda.flux-interpreter-receipt.v2") throw new FluxError("ILLEGAL_TRANSITION", "Generic run lacks a v2 ready compilation receipt");
    const receipt = state.interpreterReceipt; const providerProfile = parsePcbProviderProfileBinding(receipt.providerProfile);
    if (!TERMINAL_PHASES.has(run.phase) && (bundle.acceptancePlan.schemaVersion !== "evleda.pcb-acceptance-plan.v2" || bundle.compilerProfile.schemaVersion !== "evleda.pcb-design-compiler-profile.v2")) throw new FluxError("APPROVAL_MISMATCH", "New generic runs require the current schematic ink-clearance acceptance profile.");
    const exact = [
      [reference, createPcbDesignCompilationBundleRef(bundle)], [reference.bundleIdentity, bundle.identity], [receipt.bundleIdentity, bundle.identity],
      [state.contractIdentity, bundle.contract.identity], [state.libraryBindingIdentity, bundle.libraryBinding.identity],
      [state.deepRuleBindingIdentity, bundle.deepRuleBinding.identity], [state.acceptancePlanIdentity, bundle.acceptancePlan.identity],
      [receipt.compilerProfileIdentity, bundle.compilerProfile.identity], [receipt.practiceProfileBindingIdentity, bundle.practiceProfileBinding.identity],
      [receipt.providerProfileIdentity, providerProfile.identity], [state.contract, bundle.contract]
    ] as const;
    if (exact.some(([left, right]) => left === null || !this.#same(left, right)) || bundle.executionPrompt.originalPrompt !== run.prompt ||
      !this.#same(bundle.executionPrompt.originalPromptContentIdentity, contentIdentity(run.prompt)) || receipt.promptDigest !== fluxDigest(run.prompt) ||
      receipt.provider !== providerProfile.provider || run.providerModel.provider !== providerProfile.provider || run.providerModel.model !== providerProfile.model ||
      run.providerModel.tier !== providerProfile.tier) throw new FluxError("APPROVAL_MISMATCH", "Generic bundle does not match the run projection, prompt, provider profile, or child identities");
    if (state.deepRuleSummary !== undefined) {
      try { assertFluxDeepRuleSummaryBinding(state.deepRuleSummary, bundle.deepRuleBinding); }
      catch { throw new FluxError("APPROVAL_MISMATCH", "Public deep-rule summary does not match the verified bundle binding"); }
    }
  }

  #subject(run: FluxPersistedRun, preparation: FluxPrepareRequest): FluxApprovalSubject {
    if (run.isolatedFingerprint === undefined) throw new FluxError("ILLEGAL_TRANSITION", "Run has not produced an isolated fingerprint");
    if (preparation.openPreflightReceipt === undefined || preparation.openCheckpointReceipt === undefined) throw new FluxError("ILLEGAL_TRANSITION", "Run lacks verified Open and checkpoint receipts");
    const base = {
      schemaVersion: "evleda.flux-approval-subject.v6" as const, runId: run.id, workflowKind: run.workflowKind, sourceKey: run.sourceKey, sourceFingerprint: run.sourceFingerprint,
      isolatedFingerprint: run.isolatedFingerprint, promptIdentity: preparation.workflowKind === "generic" ? preparation.promptIdentity : contentIdentity(preparation.prompt),
      providerModel: { ...run.providerModel }, iterationCap: run.iterationCap, harnessRuleIdentity: run.harnessRuleIdentity,
      mutationAllowlist: [...run.mutationAllowlist], freshAcceptanceProfileIdentity: run.freshAcceptanceProfileIdentity,
      freshPersistenceProfileIdentity: run.freshPersistenceProfileIdentity, contractIdentity: { ...preparation.contractIdentity },
      libraryBindingIdentity: { ...preparation.libraryBindingIdentity }, deepRuleBindingIdentity: { ...preparation.deepRuleBindingIdentity },
      acceptancePlanIdentity: { ...preparation.acceptancePlanIdentity }, kicadToolchainIdentity: { ...this.#activeKicadToolchainIdentity }, inspectionBridgeIdentity: { ...preparation.openCheckpointReceipt.inspectionBridgeIdentity }, executionBridgeIdentity: { ...preparation.openCheckpointReceipt.executionBridgeIdentity },
      ipcSocketIdentity: { ...preparation.openCheckpointReceipt.ipcSocketIdentity }, writeSessionAuthorityIdentity: { ...preparation.openCheckpointReceipt.writeSessionAuthorityIdentity }, ipcProbeSemanticIdentity: { ...preparation.openCheckpointReceipt.ipcProbeSemanticIdentity },
      freshNetClassSemanticAuthorityIdentity: preparation.workflowKind === "generic" ? { ...preparation.freshNetClassPreparationEvidence!.semanticAuthorityIdentity } : null,
      freshProjectOpenPreparedSourceAuthorityIdentity: preparation.workflowKind === "generic" ? { ...preparation.freshProjectOpenPreparedSourceAuthority!.identity } : null,
      freshNetClassPreparationEvidenceIdentity: preparation.workflowKind === "generic" ? { ...preparation.freshNetClassPreparationEvidence!.identity } : null,
      openPreflightReceiptIdentity: { ...preparation.openPreflightReceipt.identity }, openCheckpointReceiptIdentity: { ...preparation.openCheckpointReceipt.identity }
    };
    if (preparation.workflowKind === "generic") return freeze({
      ...base, workflowKind: "generic", compilationBundleRef: structuredClone(preparation.compilationBundleRef),
      providerProfile: structuredClone(preparation.providerProfile), bundleIdentity: { ...preparation.compilationBundle.identity },
      compilerProfileIdentity: { ...preparation.compilerProfileIdentity }, practiceProfileBindingIdentity: { ...preparation.practiceProfileBindingIdentity },
      executionPromptIdentity: { ...preparation.executionPromptIdentity }, executionPromptContentIdentity: { ...preparation.executionPromptContentIdentity }
    } satisfies FluxGenericApprovalSubject);
    return freeze({ ...base, workflowKind: "led_compatibility_fixture", compilationBundleRef: null, providerProfile: null } satisfies FluxLedCompatibilityApprovalSubject);
  }

  async #sourceForRun(run: FluxPersistedRun, verifyFingerprint: boolean): Promise<FluxSourceCatalogInput> {
    const source = this.#sources.get(run.sourceKey); if (source === undefined) throw new FluxError("NOT_FOUND", "Run source no longer exists");
    await this.#assertSourceRoot(source); if (!verifyFingerprint) return source;
    if (this.options.sourceFingerprint === undefined) {
      if (run.workflowKind === "generic") throw new FluxError("ILLEGAL_TRANSITION", "Generic source fingerprint verification is not configured");
      return source;
    }
    const current = await this.options.sourceFingerprint({ key: source.key, label: source.label, sourceRoot: source.sourceRoot });
    if (!digestPattern.test(current)) throw new FluxError("INVALID_ARGUMENT", "Source fingerprint verifier returned an invalid digest");
    if (current !== run.sourceFingerprint) throw new FluxError("APPROVAL_MISMATCH", "Source project changed after the run was created; no isolated copy was made");
    return source;
  }

  #parseContractState(value: unknown): FluxContractStateDto {
    let snapshot: unknown;
    try {
      snapshot = hardenPortableValue(value, {
        maxBytes: 512 * 1024,
        maxDepth: 48,
        maxNodes: 120_000,
        maxArrayLength: 16_384,
        maxOwnKeys: 2_048,
        maxKeyBytes: 512,
        maxStringBytes: 256 * 1024
      });
    } catch {
      throw new FluxError("INVALID_ARGUMENT", "Contract compilation must be bounded plain JSON without accessors, proxies, cycles, or exotic fields");
    }
    const state = projectionRecord(snapshot, "Contract compilation");
    exactProjectionKeys(state, ["disposition", "questions", "issues", "contract", "contractIdentity", "libraryBindingIdentity", "deepRuleBindingIdentity", "acceptancePlanIdentity", "interpreterReceipt"], "Contract compilation");
    if (!["needs_clarification", "unsupported", "ready"].includes(String(state.disposition))) throw new FluxError("INVALID_ARGUMENT", "Contract compilation disposition is invalid");
    if (!Array.isArray(state.questions) || state.questions.length > 64) throw new FluxError("INVALID_ARGUMENT", "Contract compilation questions are invalid");
    const questions = state.questions.map((entry, index) => {
      const question = projectionRecord(entry, `Contract question ${index}`);
      exactProjectionKeys(question, ["id", "path", "question"], `Contract question ${index}`);
      return freeze({ id: projectionText(question.id, `Contract question ${index} id`, 1_024), path: projectionText(question.path, `Contract question ${index} path`, 2_048), question: projectionText(question.question, `Contract question ${index} text`, 16_384) });
    });
    if (!Array.isArray(state.issues) || state.issues.length > 4_096) throw new FluxError("INVALID_ARGUMENT", "Contract compilation issues are invalid");
    const issues = state.issues.map((entry, index) => {
      const issue = projectionRecord(entry, `Contract issue ${index}`);
      exactProjectionKeys(issue, ["code", "severity", "path", "message", "clarificationId"], `Contract issue ${index}`);
      if (issue.severity !== "error") throw new FluxError("INVALID_ARGUMENT", `Contract issue ${index} severity is invalid`);
      const clarificationId = issue.clarificationId === null ? null : projectionText(issue.clarificationId, `Contract issue ${index} clarificationId`, 1_024);
      return freeze({ code: projectionText(issue.code, `Contract issue ${index} code`, 256), severity: "error" as const,
        path: projectionText(issue.path, `Contract issue ${index} path`, 2_048), message: projectionText(issue.message, `Contract issue ${index} message`, 16_384), clarificationId });
    });
    const receiptRecord = projectionRecord(state.interpreterReceipt, "Interpreter receipt");
    exactProjectionKeys(receiptRecord, ["schemaVersion", "interpreterSchemaVersion", "provider", "providerProfile", "providerProfileIdentity", "promptDigest", "clarificationDigest", "compilerProfileIdentity", "practiceProfileBindingIdentity", "bundleIdentity", "compiledAt", "identity"], "Interpreter receipt");
    if (receiptRecord.schemaVersion !== "evleda.flux-interpreter-receipt.v2") throw new FluxError("INVALID_ARGUMENT", "Generic compilation requires a v2 interpreter receipt");
    let providerProfile: PcbProviderProfileBinding;
    try { providerProfile = parsePcbProviderProfileBinding(receiptRecord.providerProfile); }
    catch { throw new FluxError("INVALID_ARGUMENT", "Interpreter receipt provider profile is invalid"); }
    const compiledAt = projectionText(receiptRecord.compiledAt, "Interpreter receipt compiledAt", 64);
    if (Number.isNaN(Date.parse(compiledAt)) || new Date(compiledAt).toISOString() !== compiledAt) throw new FluxError("INVALID_ARGUMENT", "Interpreter receipt compiledAt is not canonical UTC time");
    const promptDigest = projectionText(receiptRecord.promptDigest, "Interpreter receipt promptDigest", 64);
    const clarificationDigest = projectionText(receiptRecord.clarificationDigest, "Interpreter receipt clarificationDigest", 64);
    if (!digestPattern.test(promptDigest) || !digestPattern.test(clarificationDigest)) throw new FluxError("INVALID_ARGUMENT", "Interpreter receipt digests are invalid");
    const interpreterReceipt: FluxInterpreterReceiptV2Dto = freeze({
      schemaVersion: "evleda.flux-interpreter-receipt.v2",
      interpreterSchemaVersion: projectionText(receiptRecord.interpreterSchemaVersion, "Interpreter receipt schema", 256),
      provider: projectionText(receiptRecord.provider, "Interpreter receipt provider", 128),
      providerProfile,
      providerProfileIdentity: projectionIdentity(receiptRecord.providerProfileIdentity, "Interpreter receipt providerProfileIdentity"),
      promptDigest,
      clarificationDigest,
      compilerProfileIdentity: nullableProjectionIdentity(receiptRecord.compilerProfileIdentity, "Interpreter receipt compilerProfileIdentity"),
      practiceProfileBindingIdentity: nullableProjectionIdentity(receiptRecord.practiceProfileBindingIdentity, "Interpreter receipt practiceProfileBindingIdentity"),
      bundleIdentity: nullableProjectionIdentity(receiptRecord.bundleIdentity, "Interpreter receipt bundleIdentity"),
      compiledAt,
      identity: projectionIdentity(receiptRecord.identity, "Interpreter receipt identity")
    });
    let contract: Readonly<Record<string, unknown>> | null;
    if (state.contract === null) contract = null;
    else contract = freeze({ ...projectionRecord(state.contract, "Contract projection") });
    return freeze({
      disposition: state.disposition as FluxContractStateDto["disposition"],
      questions,
      issues,
      contract,
      contractIdentity: nullableProjectionIdentity(state.contractIdentity, "Contract identity"),
      libraryBindingIdentity: nullableProjectionIdentity(state.libraryBindingIdentity, "Library binding identity"),
      deepRuleBindingIdentity: nullableProjectionIdentity(state.deepRuleBindingIdentity, "Deep-rule binding identity"),
      acceptancePlanIdentity: nullableProjectionIdentity(state.acceptancePlanIdentity, "Acceptance-plan identity"),
      interpreterReceipt
    });
  }

  #assertContractState(result: FluxContractStateDto, prompt: string, answers: readonly FluxClarificationAnswerDto[]): void {
    let text: string; try { text = JSON.stringify(result); } catch { throw new FluxError("INVALID_ARGUMENT", "Contract compilation is not JSON serializable"); }
    if (Buffer.byteLength(text, "utf8") > 512 * 1024) throw new FluxError("PATH_POLICY", "Contract compilation is not a bounded path-free projection");
    this.#assertContractProjectionPathFree(result);
    const receipt = result.interpreterReceipt;
    if (receipt.schemaVersion !== "evleda.flux-interpreter-receipt.v2") throw new FluxError("INVALID_ARGUMENT", "Generic compilation requires a v2 interpreter receipt");
    const profile = parsePcbProviderProfileBinding(receipt.providerProfile); const { identity, ...payload } = receipt;
    if (this.options.activeProviderProfile !== undefined && !this.#same(parsePcbProviderProfileBinding(this.options.activeProviderProfile), profile)) throw new FluxError("APPROVAL_MISMATCH", "Interpreter result provider profile does not match the active host profile");
    if (!this.#same(identity, canonicalIdentity(payload, receipt.schemaVersion)) || !this.#same(receipt.providerProfileIdentity, profile.identity) ||
      receipt.promptDigest !== fluxDigest(prompt) || receipt.clarificationDigest !== fluxDigest(answers) || !digestPattern.test(receipt.promptDigest)) throw new FluxError("INVALID_ARGUMENT", "Interpreter receipt does not bind the exact prompt, clarification batch, and provider profile");
    if (result.disposition === "ready") {
      if (result.questions.length !== 0 || result.issues.length !== 0 || result.contract === null || result.contractIdentity === null || result.libraryBindingIdentity === null || result.deepRuleBindingIdentity === null || result.acceptancePlanIdentity === null || receipt.bundleIdentity === null || receipt.compilerProfileIdentity === null || receipt.practiceProfileBindingIdentity === null) throw new FluxError("INVALID_ARGUMENT", "Ready contract compilation lacks its exact v2 identity closure");
    } else if (result.contract !== null || result.contractIdentity !== null || result.libraryBindingIdentity !== null || result.deepRuleBindingIdentity !== null || result.acceptancePlanIdentity !== null || receipt.bundleIdentity !== null || receipt.compilerProfileIdentity !== null || receipt.practiceProfileBindingIdentity !== null) {
      throw new FluxError("INVALID_ARGUMENT", "Non-ready compilation may not retain contract or bundle authority");
    }
  }

  #assertContractProjectionPathFree(value: unknown, key = "", depth = 0): void {
    if (depth > 48) throw new FluxError("PATH_POLICY", "Contract projection exceeds its depth bound");
    if (typeof value === "string") {
      const text = value.trim();
      if (/^(?:[A-Za-z]:[\\/]|\\\\|file:)/iu.test(text) || (text.startsWith("/") && !["id", "path", "clarificationId", "contractPath"].includes(key))) throw new FluxError("PATH_POLICY", "Contract projection contains a filesystem location", { field: key });
      return;
    }
    if (value === null || typeof value === "number" || typeof value === "boolean") return;
    if (Array.isArray(value)) { for (const entry of value) this.#assertContractProjectionPathFree(entry, key, depth + 1); return; }
    if (typeof value === "object") {
      for (const [childKey, entry] of Object.entries(value as Record<string, unknown>)) {
        if (childKey === "projectPaths") throw new FluxError("PATH_POLICY", "Contract projection contains a private path field");
        this.#assertContractProjectionPathFree(entry, childKey, depth + 1);
      }
      return;
    }
    throw new FluxError("INVALID_ARGUMENT", "Contract projection is not plain JSON");
  }

  #parsePrepareResult(input: unknown, workflowKind: FluxPrepareRequest["workflowKind"], checkpoint?: Readonly<{ readonly runId: string; readonly openPreflightReceipt: FluxOpenPreflightReceipt }>): FluxPrepareResult {
    let snapshot: unknown;
    try { snapshot = hardenPortableValue(input, { maxBytes: 512 * 1024, maxDepth: 16, maxNodes: 10_000, maxArrayLength: 1_024, maxOwnKeys: 1_024, maxKeyBytes: 128, maxStringBytes: 16 * 1024 }); }
    catch { throw new FluxError("INVALID_ARGUMENT", "Prepare port returned non-portable metadata"); }
    const value = projectionRecord(snapshot, "Prepare result");
    checkpoint !== undefined ? exactProjectionKeys(value, ["isolatedFingerprint", "preview", "checkpointRequired", "openCheckpointReceipt"], "Prepare result")
      : exactProjectionKeys(value, ["isolatedFingerprint", "preview", "checkpointRequired", "freshNetClassPreparationEvidence", "freshNetClassSemanticAuthority", "freshProjectOpenPreparedSourceAuthority"], "Prepare result");
    const preview = this.#parsePreviewMetadata(value.preview, "Prepare preview");
    if (!digestPattern.test(String(value.isolatedFingerprint)) || typeof value.checkpointRequired !== "boolean") throw new FluxError("INVALID_ARGUMENT", "Prepare port returned invalid immutable metadata");
    let openCheckpointReceipt;
    let freshNetClassPreparationEvidence: FreshNetClassPreparationEvidence | undefined;
    let freshNetClassSemanticAuthority: FreshNetClassSemanticAuthority | undefined;
    let freshProjectOpenPreparedSourceAuthority: FreshProjectOpenPreparedSourceAuthority | undefined;
    if (checkpoint === undefined) {
      if (workflowKind === "generic") {
        try { freshNetClassPreparationEvidence = parseFreshNetClassPreparationEvidence(value.freshNetClassPreparationEvidence); }
        catch { throw new FluxError("INVALID_ARGUMENT", "Generic prepare did not return valid fresh net-class preparation evidence"); }
        try { freshNetClassSemanticAuthority = parseFreshNetClassSemanticAuthority(value.freshNetClassSemanticAuthority); }
        catch { throw new FluxError("INVALID_ARGUMENT", "Generic prepare did not return valid full fresh net-class semantic authority"); }
        try { freshProjectOpenPreparedSourceAuthority = parseFreshProjectOpenPreparedSourceAuthority(value.freshProjectOpenPreparedSourceAuthority); }
        catch { throw new FluxError("INVALID_ARGUMENT", "Generic prepare did not return valid fresh project prepared-source authority"); }
        this.#assertPreparedSourceAuthorityWithinWorkspace(freshProjectOpenPreparedSourceAuthority);
      } else if (value.freshNetClassPreparationEvidence !== null || value.freshNetClassSemanticAuthority !== null || value.freshProjectOpenPreparedSourceAuthority !== null) {
        throw new FluxError("INVALID_ARGUMENT", "LED compatibility prepare must return null generic preparation authorities");
      }
    }
    if (checkpoint !== undefined) {
      try { openCheckpointReceipt = parseFluxOpenCheckpointReceipt(value.openCheckpointReceipt); }
      catch { throw new FluxError("INVALID_ARGUMENT", "Checkpoint-open port returned an invalid receipt"); }
      if (openCheckpointReceipt.runId !== checkpoint.runId || !this.#same(openCheckpointReceipt.openPreflightReceiptIdentity, checkpoint.openPreflightReceipt.identity) || openCheckpointReceipt.isolatedFingerprint !== value.isolatedFingerprint ||
        !this.#same(openCheckpointReceipt.kicadToolchainIdentity, this.#activeKicadToolchainIdentity) || !this.#same(openCheckpointReceipt.inspectionBridgeIdentity, this.#activeInspectionBridgeIdentity) || !this.#same(openCheckpointReceipt.executionBridgeIdentity, this.#activeExecutionBridgeIdentity) ||
        !this.#same(openCheckpointReceipt.inspectionBridgeIdentity, checkpoint.openPreflightReceipt.inspectionBridgeIdentity) || !this.#same(openCheckpointReceipt.ipcSocketIdentity, checkpoint.openPreflightReceipt.ipcSocketIdentity) ||
        !this.#same(openCheckpointReceipt.freshNetClassSemanticAuthorityIdentity, checkpoint.openPreflightReceipt.freshNetClassSemanticAuthorityIdentity) ||
        !this.#same(openCheckpointReceipt.freshProjectOpenPreparedSourceAuthorityIdentity, checkpoint.openPreflightReceipt.freshProjectOpenPreparedSourceAuthorityIdentity) ||
        !this.#same(openCheckpointReceipt.freshNetClassPreparationEvidenceIdentity, checkpoint.openPreflightReceipt.freshNetClassPreparationEvidenceIdentity)) {
        throw new FluxError("APPROVAL_MISMATCH", "Checkpoint-open receipt does not bind the active KiCad toolchain, inspection bridge, IPC socket, and isolated fingerprint");
      }
    }
    const result: FluxPrepareResult = freeze({
      isolatedFingerprint: value.isolatedFingerprint as string,
      checkpointRequired: value.checkpointRequired,
      preview,
      ...(freshNetClassPreparationEvidence === undefined ? {} : { freshNetClassPreparationEvidence }),
      ...(freshNetClassSemanticAuthority === undefined ? {} : { freshNetClassSemanticAuthority }),
      ...(freshProjectOpenPreparedSourceAuthority === undefined ? {} : { freshProjectOpenPreparedSourceAuthority }),
      ...(openCheckpointReceipt === undefined ? {} : { openCheckpointReceipt })
    });
    const { freshNetClassSemanticAuthority: _privateSemanticAuthority, freshProjectOpenPreparedSourceAuthority: _privatePreparedSource, ...publicResult } = result;
    this.#assertContractProjectionPathFree(publicResult);
    return result;
  }
  #parsePreviewMetadata(input: unknown, label: string): FluxPreviewMetadata {
    let snapshot: unknown;
    try { snapshot = hardenPortableValue(input, { maxBytes: 32 * 1024, maxDepth: 4, maxNodes: 64, maxArrayLength: 8, maxOwnKeys: 8, maxKeyBytes: 128, maxStringBytes: 16 * 1024 }); }
    catch { throw new FluxError("INVALID_ARGUMENT", `${label} returned non-portable metadata`); }
    const preview = projectionRecord(snapshot, label); exactProjectionKeys(preview, ["title", "summary", "artifactCount", "digest"], label);
    if (!Number.isSafeInteger(preview.artifactCount) || (preview.artifactCount as number) < 0 || !digestPattern.test(String(preview.digest))) throw new FluxError("INVALID_ARGUMENT", `${label} is invalid`);
    const result = freeze({ title: projectionText(preview.title, `${label} title`, 4_096), summary: projectionText(preview.summary, `${label} summary`, 16_384), artifactCount: preview.artifactCount as number, digest: preview.digest as string });
    this.#assertContractProjectionPathFree(result);
    return result;
  }
  #parseOpenPreflightReceipt(input: unknown, projectId: string, runId: string, preparation: FluxPrepareRequest): FluxOpenPreflightReceipt {
    let receipt: FluxOpenPreflightReceipt;
    try { receipt = parseFluxOpenPreflightReceipt(input); }
    catch { throw new FluxError("OPEN_PREFLIGHT_FAILED", "Open preflight returned an invalid closed receipt"); }
    const semanticIdentity = preparation.workflowKind === "generic" ? preparation.freshNetClassPreparationEvidence?.semanticAuthorityIdentity : null;
    const preparedSourceIdentity = preparation.workflowKind === "generic" ? preparation.freshProjectOpenPreparedSourceAuthority?.identity : null;
    const preparationEvidenceIdentity = preparation.workflowKind === "generic" ? preparation.freshNetClassPreparationEvidence?.identity : null;
    if (preparation.workflowKind === "generic" && (semanticIdentity === undefined || preparedSourceIdentity === undefined || preparationEvidenceIdentity === undefined)) throw new FluxError("APPROVAL_MISMATCH", "Generic Open requires stable fresh net-class, preparation-evidence, and prepared-source authority");
    if (receipt.projectId !== projectId || receipt.runId !== runId || receipt.preparationDigest !== this.#openPreparationDigest(preparation) || !this.#same(receipt.inspectionBridgeIdentity, this.#activeInspectionBridgeIdentity) ||
      !this.#same(receipt.freshNetClassSemanticAuthorityIdentity, semanticIdentity) || !this.#same(receipt.freshProjectOpenPreparedSourceAuthorityIdentity, preparedSourceIdentity) ||
      !this.#same(receipt.freshNetClassPreparationEvidenceIdentity, preparationEvidenceIdentity)) {
      throw new FluxError("OPEN_PREFLIGHT_FAILED", "Open preflight receipt does not bind the exact run preparation and active inspection bridge");
    }
    return receipt;
  }
  #parseOpenResult(input: unknown): FluxOpenResult {
    let snapshot: unknown;
    try { snapshot = hardenPortableValue(input, { maxBytes: 32 * 1024, maxDepth: 4, maxNodes: 64, maxArrayLength: 8, maxOwnKeys: 8, maxKeyBytes: 128, maxStringBytes: 16 * 1024 }); }
    catch { throw new FluxError("INVALID_ARGUMENT", "Open port returned non-portable metadata"); }
    const value = projectionRecord(snapshot, "Open result"); exactProjectionKeys(value, ["opened", "label", "checkpointRequired"], "Open result");
    if (typeof value.opened !== "boolean" || typeof value.checkpointRequired !== "boolean") throw new FluxError("INVALID_ARGUMENT", "Open port returned invalid metadata");
    const result: FluxOpenResult = freeze({ opened: value.opened, label: projectionText(value.label, "Open result label", 16_384), checkpointRequired: value.checkpointRequired });
    this.#assertContractProjectionPathFree(result);
    return result;
  }
  #parseExecutionResult(input: unknown, expectedWriteSessionAuthorityIdentity: FluxCanonicalIdentityDto, workflowKind: FluxPrepareRequest["workflowKind"], expectedApproval: FluxApprovalSubject,
    expectedPreparationEvidence: FreshNetClassPreparationEvidence | null | undefined, expectedSemanticAuthority: FreshNetClassSemanticAuthority | null | undefined): FluxExecuteResult {
    let snapshot: unknown;
    try { snapshot = hardenPortableValue(input, { maxBytes: 12 * 1024 * 1024, maxDepth: 64, maxNodes: 200_000, maxArrayLength: 20_000, maxOwnKeys: 1_024, maxKeyBytes: 512, maxStringBytes: 512 * 1024 }); }
    catch { throw new FluxError("INVALID_ARGUMENT", "Execution port returned non-portable metadata"); }
    const value = projectionRecord(snapshot, "Execution result");
    closedProjectionKeys(value, ["disposition"], ["reports", "blockedReason", "freshClearanceEvidenceReceipt"], "Execution result");
    if (!["completed", "needs_review", "blocked", "failed"].includes(String(value.disposition))) throw new FluxError("INVALID_ARGUMENT", "Execution port returned a missing or malformed terminal disposition");
    let freshClearanceEvidenceReceipt: FreshClearanceEvidenceReceipt | undefined;
    if (value.freshClearanceEvidenceReceipt !== undefined) {
      if (workflowKind !== "generic" || expectedPreparationEvidence == null || expectedSemanticAuthority == null) throw new FluxError("INVALID_ARGUMENT", "Only a fully bound generic execution may return terminal fresh clearance evidence");
      try { freshClearanceEvidenceReceipt = verifyFreshClearanceEvidenceReceiptAgainstSemanticAuthority(value.freshClearanceEvidenceReceipt, expectedSemanticAuthority); }
      catch { throw new FluxError("INVALID_ARGUMENT", "Execution returned an invalid terminal fresh clearance evidence receipt"); }
      if (!this.#same(freshClearanceEvidenceReceipt.bundleIdentity, expectedPreparationEvidence.bundleIdentity) ||
        !this.#same(freshClearanceEvidenceReceipt.contractIdentity, expectedPreparationEvidence.contractIdentity) ||
        expectedApproval.workflowKind !== "generic" || !this.#same(freshClearanceEvidenceReceipt.bundleIdentity, expectedApproval.bundleIdentity) ||
        !this.#same(freshClearanceEvidenceReceipt.contractIdentity, expectedApproval.contractIdentity) ||
        !this.#same(freshClearanceEvidenceReceipt.genericProjectBindingIdentity, expectedPreparationEvidence.genericProjectBindingIdentity) ||
        !this.#same(freshClearanceEvidenceReceipt.freshMarkerContentIdentity, expectedPreparationEvidence.freshMarkerContentIdentity) ||
        !this.#same(freshClearanceEvidenceReceipt.kicad, expectedPreparationEvidence.kicad)) {
        throw new FluxError("APPROVAL_MISMATCH", "Terminal fresh clearance receipt does not bind the approved generic preparation evidence");
      }
    }
    if (value.reports !== undefined && !Array.isArray(value.reports)) throw new FluxError("INVALID_ARGUMENT", "Execution reports must be an array");
    if (Array.isArray(value.reports)) {
      for (const [index, report] of value.reports.entries()) {
        if (typeof report !== "object" || report === null || Array.isArray(report)) throw new FluxError("INVALID_ARGUMENT", "Execution report metadata must be an object");
        const record = report as Record<string, unknown>;
        closedProjectionKeys(record, ["title", "digest", "mediaType", "executionBridgeIdentity", "writeSessionAuthorityIdentity", "writeSessionReceiptIdentity", "executionInspectionSessionReceiptIdentity"], ["disposition", "summary", "reportSha256", "freshAcceptance", "freshBoardSaveAudits", "freshClearanceEvidenceBinding"], `Execution report ${index}`);
        if (typeof record.title !== "string" || !record.title.trim() || typeof record.mediaType !== "string" || !record.mediaType.trim() || !digestPattern.test(String(record.digest))) {
          throw new FluxError("INVALID_ARGUMENT", "Execution report metadata is incomplete");
        }
        if (record.disposition !== undefined && !["completed", "needs_review", "blocked", "failed"].includes(String(record.disposition))) throw new FluxError("INVALID_ARGUMENT", `Execution report ${index} disposition is invalid`);
        if (record.summary !== undefined && typeof record.summary !== "string") throw new FluxError("INVALID_ARGUMENT", `Execution report ${index} summary is invalid`);
        if (record.reportSha256 !== undefined && !digestPattern.test(String(record.reportSha256))) throw new FluxError("INVALID_ARGUMENT", `Execution report ${index} SHA-256 is invalid`);
        const writeSessionAuthorityIdentity = projectionIdentity(record.writeSessionAuthorityIdentity, `Execution report ${index} write-session authority identity`);
        const executionBridgeIdentity = projectionIdentity(record.executionBridgeIdentity, `Execution report ${index} execution bridge identity`);
        const writeSessionReceiptIdentity = projectionIdentity(record.writeSessionReceiptIdentity, `Execution report ${index} write-session receipt identity`);
        const executionInspectionSessionReceiptIdentity = projectionIdentity(record.executionInspectionSessionReceiptIdentity, `Execution report ${index} execution inspection session receipt identity`);
        if (writeSessionReceiptIdentity.schemaVersion !== "evleda.kicad-mcp-session-receipt.v1" || executionInspectionSessionReceiptIdentity.schemaVersion !== "evleda.kicad-mcp-session-receipt.v1" || !this.#same(executionBridgeIdentity, this.#activeExecutionBridgeIdentity) || !this.#same(writeSessionAuthorityIdentity, expectedWriteSessionAuthorityIdentity)) throw new FluxError("APPROVAL_MISMATCH", `Execution report ${index} does not bind the approved execution bridge and write-session authority`);
        if (record.freshClearanceEvidenceBinding !== undefined) {
          try {
            const binding = parseFluxFreshClearanceEvidenceBinding(record.freshClearanceEvidenceBinding);
            if (expectedPreparationEvidence == null || freshClearanceEvidenceReceipt === undefined ||
              !this.#same(binding.kicad, expectedPreparationEvidence.kicad) || !this.#same(binding.kicad, freshClearanceEvidenceReceipt.kicad) ||
              !this.#same(binding.materializationIdentity, expectedPreparationEvidence.materializationIdentity) ||
              !this.#same(binding.semanticAuthorityIdentity, expectedPreparationEvidence.semanticAuthorityIdentity) || !this.#same(binding.semanticAuthorityIdentity, expectedApproval.freshNetClassSemanticAuthorityIdentity) ||
              !this.#same(binding.receiptIdentity, freshClearanceEvidenceReceipt.identity)) throw new Error("clearance authority mismatch");
          } catch { throw new FluxError("INVALID_ARGUMENT", `Execution report ${index} has an invalid or mismatched fresh clearance evidence binding`); }
        }
        if (record.freshAcceptance !== undefined) {
          const acceptance = projectionRecord(record.freshAcceptance, `Execution report ${index} acceptance`);
          exactProjectionKeys(acceptance, ["passed", "requirements", "missing", "sourceHashes", "evidenceLimitations"], `Execution report ${index} acceptance`);
          if (typeof acceptance.passed !== "boolean" || !Array.isArray(acceptance.requirements) || !Array.isArray(acceptance.missing) || !Array.isArray(acceptance.evidenceLimitations) || !acceptance.missing.every((entry) => typeof entry === "string") || !acceptance.evidenceLimitations.every((entry) => typeof entry === "string")) throw new FluxError("INVALID_ARGUMENT", `Execution report ${index} acceptance is invalid`);
          for (const [requirementIndex, requirementValue] of acceptance.requirements.entries()) {
            const requirement = projectionRecord(requirementValue, `Execution report ${index} requirement ${requirementIndex}`);
            exactProjectionKeys(requirement, ["id", "status", "detail"], `Execution report ${index} requirement ${requirementIndex}`);
            if (typeof requirement.id !== "string" || typeof requirement.detail !== "string" || !["pass", "fail", "unknown"].includes(String(requirement.status))) throw new FluxError("INVALID_ARGUMENT", `Execution report ${index} requirement status is invalid`);
          }
          const hashes = projectionRecord(acceptance.sourceHashes, `Execution report ${index} source hashes`);
          closedProjectionKeys(hashes, ["schematicSha256", "pcbSha256"], ["netlistSha256"], `Execution report ${index} source hashes`);
          if (!digestPattern.test(String(hashes.schematicSha256)) || !digestPattern.test(String(hashes.pcbSha256))) throw new FluxError("INVALID_ARGUMENT", `Execution report ${index} source hashes are invalid`);
          if (Object.hasOwn(hashes, "netlistSha256") && (typeof hashes.netlistSha256 !== "string" || !digestPattern.test(hashes.netlistSha256))) throw new FluxError("INVALID_ARGUMENT", `Execution report ${index} netlist source hash is invalid`);
        }
        if (record.freshBoardSaveAudits !== undefined) {
          if (!Array.isArray(record.freshBoardSaveAudits)) throw new FluxError("INVALID_ARGUMENT", `Execution report ${index} save audits are invalid`);
          for (const [auditIndex, auditValue] of record.freshBoardSaveAudits.entries()) {
            const audit = projectionRecord(auditValue, `Execution report ${index} save audit ${auditIndex}`);
            exactProjectionKeys(audit, ["before", "live", "after", "directorySync"], `Execution report ${index} save audit ${auditIndex}`);
            if (!["synced", "unavailable"].includes(String(audit.directorySync))) throw new FluxError("INVALID_ARGUMENT", `Execution report ${index} save audit status is invalid`);
            for (const field of ["before", "live", "after"] as const) {
              const identity = projectionRecord(audit[field], `Execution report ${index} save audit ${auditIndex} ${field}`);
              exactProjectionKeys(identity, ["sha256", "bytes"], `Execution report ${index} save audit ${auditIndex} ${field}`);
              if (!digestPattern.test(String(identity.sha256)) || !Number.isSafeInteger(identity.bytes) || (identity.bytes as number) < 0) throw new FluxError("INVALID_ARGUMENT", `Execution report ${index} save audit identity is invalid`);
            }
          }
        }
        this.#assertContractProjectionPathFree(report);
      }
    }
    if (workflowKind === "generic" && value.disposition === "completed" && (freshClearanceEvidenceReceipt === undefined || !Array.isArray(value.reports) || value.reports.length === 0 || value.reports.some((report) => (report as Record<string, unknown>).freshClearanceEvidenceBinding === undefined))) {
      throw new FluxError("INVALID_ARGUMENT", "Generic completed execution requires a verified terminal fresh clearance receipt and binding on every report");
    }
    if (workflowKind === "generic" && value.disposition === "completed" && Array.isArray(value.reports)) {
      for (const report of value.reports) {
        const acceptance = (report as { freshAcceptance?: { passed?: boolean; requirements?: { id: string; status: string }[]; missing?: unknown[] } }).freshAcceptance;
        const ink = acceptance?.requirements?.filter((entry) => entry.id === "schematic-render-clearance");
        if (acceptance?.passed !== true || acceptance.missing?.length !== 0 || ink?.length !== 1 || ink[0]?.status !== "pass") throw new FluxError("INVALID_ARGUMENT", "Current generic completion requires the passing schematic ink-clearance acceptance row.");
      }
    }
    if (workflowKind === "generic") {
      if (expectedPreparationEvidence == null || expectedSemanticAuthority == null ||
        !this.#same(expectedPreparationEvidence.semanticAuthorityIdentity, expectedSemanticAuthority.identity) || !this.#same(expectedPreparationEvidence.identity, expectedApproval.freshNetClassPreparationEvidenceIdentity)) {
        throw new FluxError("APPROVAL_MISMATCH", "Generic execution lacks approved full fresh net-class preparation and semantic authority");
      }
    }
    if (value.blockedReason !== undefined && (typeof value.blockedReason !== "string" || !value.blockedReason.trim())) throw new FluxError("INVALID_ARGUMENT", "Execution blocked reason must be non-empty text");
    if (typeof value.blockedReason === "string") this.#assertContractProjectionPathFree(value.blockedReason, "blockedReason");
    return freeze({ ...value, ...(freshClearanceEvidenceReceipt === undefined ? {} : { freshClearanceEvidenceReceipt }) }) as FluxExecuteResult;
  }

  #same(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }
  #operationAuthority(run: FluxPersistedRun): unknown {
    const { phase: _phase, updatedAt: _updatedAt, inFlightOperation: _intent, operationFailureEvidenceReservationRef: _reservation, ...authority } = run;
    return authority;
  }
  #operationIntent(operation: ExternalOperation, request: unknown, run: FluxPersistedRun, startedAt = fluxNow()): FluxPersistedOperationIntent {
    return freeze({
      schemaVersion: "evleda.flux-operation-intent.v1",
      operation,
      requestDigest: fluxDigest(request),
      authorityDigest: fluxDigest(this.#operationAuthority(run)),
      priorPhase: run.phase,
      startedAt
    });
  }
  #openOperationIntent(request: unknown, run: FluxPersistedRun, preflightReceipt: FluxOpenPreflightReceipt): FluxPersistedOperationIntent {
    return freeze({ schemaVersion: "evleda.flux-operation-intent.v2", operation: "open_project", requestDigest: fluxDigest(request),
      authorityDigest: fluxDigest(this.#operationAuthority(run)), priorPhase: run.phase, startedAt: fluxNow(), openPreflightReceipt: preflightReceipt });
  }
  #assertAdmittedRun(expected: FluxPersistedRun, current: FluxPersistedRun | undefined, operation: ExternalOperation, request: unknown): asserts current is FluxPersistedRun {
    if (current === undefined || !this.#same(expected, current)) throw new FluxError("APPROVAL_MISMATCH", "Run changed while an external lifecycle operation was in flight");
    const intent = current.inFlightOperation;
    const schemaMatches = operation === "open_project" ? intent?.schemaVersion === "evleda.flux-operation-intent.v2" : intent?.schemaVersion === "evleda.flux-operation-intent.v1";
    if (intent === undefined || !schemaMatches || intent.operation !== operation ||
      intent.requestDigest !== fluxDigest(request) || intent.authorityDigest !== fluxDigest(this.#operationAuthority(current))) {
      throw new FluxError("APPROVAL_MISMATCH", "Run operation receipt no longer binds the admitted authority");
    }
  }
  #assertAdmittedOperation(expected: FluxPersistedState, current: FluxPersistedState, runId: string, operation: ExternalOperation, request: unknown, key: string | undefined): void {
    this.#assertAdmittedRun(expected.runs[runId]!, current.runs[runId], operation, request);
    this.#assertAdmittedReceipt(expected, current, operation, request, key);
  }
  #assertAdmittedReceipt(expected: FluxPersistedState, current: FluxPersistedState, operation: ExternalOperation, request: unknown, key: string | undefined): void {
    if (key === undefined) return;
    const expectedReceipt = expected.idempotency[key]; const currentReceipt = current.idempotency[key];
    if (expectedReceipt === undefined || expectedReceipt.status !== "pending" || expectedReceipt.operation !== operation || expectedReceipt.digest !== fluxDigest(request) ||
      currentReceipt === undefined || !this.#same(expectedReceipt, currentReceipt)) {
      throw new FluxError("IDEMPOTENCY_CONFLICT", "Durable idempotency receipt changed while an external lifecycle operation was in flight");
    }
  }
  #sameRequestAuthority(left: FluxPrepareRequest, right: FluxPrepareRequest): boolean {
    const reduced = (value: FluxPrepareRequest): unknown => value.workflowKind === "generic" ? { ...value, compilationBundle: value.compilationBundle.identity } : value;
    return this.#same(reduced(left), reduced(right));
  }
  #openPreparationDigest(preparation: FluxPrepareRequest): string {
    return fluxOpenPreparationDigest(preparation);
  }
  #assertOpenPreflightPreparationBinding(preparation: FluxPrepareRequest): void {
    if (preparation.openPreflightReceipt !== undefined && preparation.openPreflightReceipt.preparationDigest !== this.#openPreparationDigest(preparation)) {
      throw new FluxError("APPROVAL_MISMATCH", "Run Open preflight receipt does not bind the exact prepared authority");
    }
  }
  #assertUnchangedRun(expected: FluxPersistedRun, current: FluxPersistedRun): void {
    if (!this.#same(expected, current)) throw new FluxError("APPROVAL_MISMATCH", "Run authority changed during lifecycle admission");
  }
  async #transition(runId: string, from: readonly string[], next: (run: FluxPersistedRun) => FluxPersistedRun, e: FluxEventDto): Promise<FluxRunDto> {
    const saved = await this.#store.replace((state) => {
      const current = state.runs[runId]; if (current === undefined) throw new FluxError("NOT_FOUND", "Run does not exist", { runId });
      if (!from.includes(current.phase)) throw new FluxError("ILLEGAL_TRANSITION", `Cannot transition run from ${current.phase}`, { runId, phase: current.phase, allowed: from });
      return replaceRun(state, freeze(next(current)), e);
    });
    return toRunDto(saved.runs[runId]!);
  }
  async #failIfPreparing(runId: string, error: unknown): Promise<void> {
    await this.#store.replace((state) => { const run = state.runs[runId]; if (run?.phase !== "preparing") return state; const { inFlightOperation: _intent, ...base } = run; return replaceRun(state, { ...base, phase: "failed", blockedReason: this.#message(error), updatedAt: fluxNow() }, event("run_failed", this.#message(error), runId)); });
  }
  async #restoreKnownNotOpened(admitted: FluxPersistedState, runId: string, request: unknown, key: string | undefined): Promise<void> {
    await this.#store.replace((state) => {
      const opening = admitted.runs[runId];
      if (opening === undefined) throw new FluxError("STORE_CORRUPT", "Known-not-opened operation has no admitted run");
      const current = state.runs[opening.id];
      if (current === undefined) throw new FluxError("NOT_FOUND", "Run does not exist", { runId });
      this.#assertAdmittedOperation(admitted, state, opening.id, "open_project", request, key);
      const intent = current.inFlightOperation!;
      const { inFlightOperation: _intent, ...base } = current;
      const idempotency = { ...state.idempotency };
      if (key !== undefined) {
        const receipt = idempotency[key];
        if (receipt === undefined || receipt.status !== "pending" || receipt.operation !== "open_project" || receipt.digest !== fluxDigest(request)) {
          throw new FluxError("STORE_CORRUPT", "Known-not-opened operation receipt is invalid");
        }
        delete idempotency[key];
      }
      return replaceRun({ ...state, idempotency }, freeze({ ...base, phase: intent.priorPhase, updatedAt: fluxNow() }));
    });
  }
  async #recordOpenPreflightFailure(expectedRun: FluxPersistedRun, request: unknown, key: string | undefined): Promise<void> {
    if (key === undefined) return;
    await this.#store.replace((state) => {
      const run = state.runs[expectedRun.id]; this.#assertUnchangedRun(expectedRun, run!);
      if (run?.phase !== "awaiting_open") throw new FluxError("ILLEGAL_TRANSITION", "Run changed before Open preflight failure could be recorded");
      const existing = state.idempotency[key]; const requestDigest = fluxDigest(request);
      if (existing !== undefined && (existing.operation !== "open_project" || existing.digest !== requestDigest || existing.status !== "preflight_failed")) throw new FluxError("IDEMPOTENCY_CONFLICT", "Open preflight failure no longer matches its idempotency key");
      const failedAt = fluxNow(); const openPreflightFailure = createFluxOpenPreflightFailureReceipt(requestDigest, expectedRun.id, failedAt);
      return { ...state, idempotency: { ...state.idempotency, [key]: { operation: "open_project", digest: requestDigest, resultId: expectedRun.id, runId: expectedRun.id,
        status: "preflight_failed" as const, startedAt: existing?.startedAt ?? failedAt, completedAt: failedAt, openPreflightFailure } } };
    });
  }
  async #recordOpenPreflightUncertainty(expectedRun: FluxPersistedRun, request: unknown, key: string | undefined): Promise<void> {
    await this.#store.replace((state) => {
      const run = state.runs[expectedRun.id];
      if (run?.phase !== "awaiting_open" || run.projectId !== expectedRun.projectId) throw new FluxError("ILLEGAL_TRANSITION", "Run changed phase before Open preflight uncertainty could be recorded");
      const requestDigest = fluxDigest(request); const blockedAt = fluxNow(); const idempotency = { ...state.idempotency };
      if (key !== undefined) {
        const existing = idempotency[key];
        if (existing !== undefined && (existing.operation !== "open_project" || existing.digest !== requestDigest || existing.status !== "preflight_failed")) throw new FluxError("IDEMPOTENCY_CONFLICT", "Open preflight uncertainty no longer matches its idempotency key");
        idempotency[key] = { operation: "open_project", digest: requestDigest, resultId: expectedRun.id, runId: expectedRun.id,
          status: "preflight_uncertain", startedAt: blockedAt, completedAt: blockedAt,
          openPreflightUncertain: createFluxOpenPreflightUncertainReceipt(requestDigest, expectedRun.id, blockedAt) };
      }
      const blocked = freeze({ ...run, phase: "blocked" as const, blockedReason: FLUX_OPEN_PREFLIGHT_UNCERTAIN_MESSAGE, updatedAt: blockedAt });
      const next = replaceRun(state, blocked, event("run_blocked", "Open preflight became uncertain before editor launch; the run will not be retried automatically.", expectedRun.id));
      return { ...next, idempotency };
    });
  }
  async #failIfInterpreting(runId: string, operation: "interpret_run" | "clarify_run", request: unknown, key: string | undefined, failure: FluxOperationFailureInput, operationFailureEvidence: FluxOperationFailureEvidence): Promise<FluxTerminalFailureReceiptDto | undefined> {
    const saved = await this.#store.replace((state) => {
      const run = state.runs[runId]; if (run?.phase !== "interpreting") return state;
      const { approval: _approval, isolatedFingerprint: _isolated, preview: _preview, checkpointRequired: _checkpoint,
        openPreflightReceipt: _openPreflightReceipt, openCheckpointReceipt: _openCheckpointReceipt,
        freshNetClassPreparationEvidence: _preparationEvidence, freshNetClassSemanticAuthority: _semanticAuthority, freshProjectOpenPreparedSourceAuthority: _preparedSourceAuthority,
        freshClearanceEvidenceReceipt: _terminalClearanceReceipt, contractState: _contract, compilationBundleRef: _bundleRef, inFlightOperation: _intent, operationFailureEvidenceReservationRef: _reservation, ...base } = run;
      const now = fluxNow();
      const evidence = this.#settleOperationFailureEvidence(state, run, operation, request, key, failure.diagnostic, operationFailureEvidence);
      const next = replaceRun(state, { ...base, phase: "blocked", blockedReason: failure.message,
        ...(failure.diagnostic === undefined ? {} : { diagnostic: failure.diagnostic }), updatedAt: now },
      event("run_blocked", "Generic contract interpretation failed closed.", runId, failure.diagnostic));
      return { ...next, operationFailureEvidence: evidence.records, operationFailureEvidenceReservations: evidence.reservations,
        idempotency: this.#failed(state, operation, request, runId, runId, failure, key, now) };
    });
    return key !== undefined && saved.idempotency[key]?.status === "failed" ? this.#terminalFailureReceipt(saved, key) : undefined;
  }
  async #settleCheckpointUncertain(admitted: FluxPersistedState, runId: string, request: unknown, key: string | undefined, failure: FluxOperationFailureInput): Promise<FluxPersistedState> {
    return this.#store.replace((state) => {
      const run = state.runs[runId]; if (run === undefined) throw new FluxError("NOT_FOUND", "Run does not exist", { runId });
      const receipt = key === undefined ? undefined : state.idempotency[key];
      if (run.phase === "awaiting_approval" && run.inFlightOperation === undefined && run.openCheckpointReceipt !== undefined &&
        (key === undefined || (receipt?.status === "completed" && receipt.operation === "checkpoint_open" && receipt.digest === fluxDigest(request)))) return state;
      this.#assertAdmittedReceipt(admitted, state, "checkpoint_open", request, key);
      if (run.phase !== "checkpointing" || run.inFlightOperation === undefined || !this.#same(run.inFlightOperation, admitted.runs[runId]!.inFlightOperation)) {
        throw new FluxError("OPERATION_UNCERTAIN", "The admitted checkpoint operation changed before failure settlement");
      }
      const now = fluxNow();
      const { inFlightOperation: _intent, approval: _approval, openCheckpointReceipt: _checkpoint, ...base } = run;
      const blocked = freeze({ ...base, phase: "blocked" as const, checkpointRequired: true, blockedReason: failure.message, updatedAt: now });
      const next = replaceRun(state, blocked, event("run_blocked", "Checkpoint operation failed after admission and was blocked without replay.", runId));
      return { ...next, idempotency: this.#failed(state, "checkpoint_open", request, runId, runId, failure, key, now) };
    });
  }
  async #failIfExecuting(runId: string, error: unknown): Promise<void> {
    await this.#store.replace((state) => { const run = state.runs[runId]; if (run === undefined || !["queued", "running"].includes(run.phase)) return state; const { inFlightOperation: _intent, ...base } = run; return replaceRun(state, { ...base, phase: "failed", blockedReason: this.#message(error), updatedAt: fluxNow() }, event("run_failed", this.#message(error), runId)); });
  }
  #assertRunInput(input: FluxCreateRunInput): void {
    if (!input.prompt.trim() || !input.providerModel.provider.trim() || !input.providerModel.model.trim() || !input.providerModel.tier.trim() || !input.harnessRuleIdentity.trim() || !input.freshAcceptanceProfileIdentity.trim() || !input.freshPersistenceProfileIdentity.trim() || !["generic", "led_compatibility_fixture"].includes(input.workflowKind) || !Number.isSafeInteger(input.iterationCap) || input.iterationCap < PCB_AGENT_MIN_ITERATIONS || input.iterationCap > PCB_AGENT_MAX_FRESH_ITERATIONS || input.mutationAllowlist.some((item) => !item.trim() || path.isAbsolute(item) || item.includes(".."))) throw new FluxError("INVALID_ARGUMENT", "Run input is not a strict safe request");
  }
  async #assertSourceRoot(source: FluxSourceCatalogInput): Promise<void> {
    const stat = await lstat(source.sourceRoot); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new FluxError("PATH_POLICY", "Source root must be an ordinary directory");
    const canonical = await realpath(source.sourceRoot); if (comparable(canonical) !== comparable(path.resolve(source.sourceRoot))) throw new FluxError("PATH_POLICY", "Source root resolves through a symbolic link");
  }
  #assertPreparedSourceAuthorityWithinWorkspace(authority: FreshProjectOpenPreparedSourceAuthority): void {
    const workspaceRoot = path.resolve(this.options.workspaceRoot); const projectRoot = path.resolve(authority.projectIdentity.canonicalPath);
    const relative = path.relative(workspaceRoot, projectRoot);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new FluxError("PATH_POLICY", "Fresh project prepared-source authority is outside the Flux workspace");
    }
  }
  #idempotent(state: FluxPersistedState, operation: string, request: unknown, key: string | undefined): string | undefined {
    if (key === undefined) return undefined; const item = state.idempotency[key]; if (item === undefined) return undefined;
    if (item.operation !== operation || item.digest !== fluxDigest(request)) throw new FluxError("IDEMPOTENCY_CONFLICT", "Idempotency key was reused with a different request");
    if (item.status === "authority_invalidated") throw new FluxError("IDEMPOTENCY_CONFLICT", "Idempotency key belongs to Open/checkpoint authority invalidated by restart; use a new key after re-establishing authority");
    if (item.status === "preflight_uncertain") throw new FluxError("OPERATION_UNCERTAIN", FLUX_OPEN_PREFLIGHT_UNCERTAIN_MESSAGE, { operation, resultId: item.resultId });
    if (item.status === "pending") throw new FluxError("OPERATION_UNCERTAIN", "A prior operation with this key may have crossed its external side-effect boundary; it will not be repeated automatically.", { operation, resultId: item.resultId });
    if (item.status === "failed") throw this.#failureError(item.failure!, this.#terminalFailureReceipt(state, key));
    return item.resultId;
  }
  #remember(state: FluxPersistedState, operation: string, request: unknown, resultId: string, result: unknown, key: string | undefined) { return this.#completed(state, operation, request, resultId, resultId, result, key); }
  #replay<Result>(state: FluxPersistedState, operation: string, request: unknown, key: string | undefined): Result | undefined {
    if (key === undefined) return undefined; const record = state.idempotency[key]; if (record === undefined) return undefined;
    if (record.operation !== operation || record.digest !== fluxDigest(request)) throw new FluxError("IDEMPOTENCY_CONFLICT", "Idempotency key was reused with a different request");
    if (record.status === "preflight_failed") return undefined;
    if (record.status === "authority_invalidated") throw new FluxError("IDEMPOTENCY_CONFLICT", "Idempotency key belongs to Open/checkpoint authority invalidated by restart; use a new key after re-establishing authority");
    if (record.status === "preflight_uncertain") throw new FluxError("OPERATION_UNCERTAIN", FLUX_OPEN_PREFLIGHT_UNCERTAIN_MESSAGE, { operation, runId: record.runId });
    if (record.status === "pending") throw new FluxError("OPERATION_UNCERTAIN", "A prior operation with this key may have crossed its external side-effect boundary; it will not be repeated automatically.", { operation, runId: record.runId });
    if (record.status === "failed") {
      if (record.failure === undefined) throw new FluxError("STORE_CORRUPT", "Failed idempotency receipt is missing its terminal failure");
      throw this.#failureError(record.failure, this.#terminalFailureReceipt(state, key));
    }
    if (record.result === undefined) throw new FluxError("STORE_CORRUPT", "Completed idempotency receipt is missing its result"); return freeze(structuredClone(record.result)) as Result;
  }
  #assertNewIntent(state: FluxPersistedState, operation: string, request: unknown, key: string | undefined): void {
    if (key === undefined) return; const record = state.idempotency[key]; if (record === undefined) return;
    if (record.operation !== operation || record.digest !== fluxDigest(request)) throw new FluxError("IDEMPOTENCY_CONFLICT", "Idempotency key was reused with a different request");
    if (record.status === "preflight_failed") return;
    if (record.status === "authority_invalidated") throw new FluxError("IDEMPOTENCY_CONFLICT", "Idempotency key belongs to Open/checkpoint authority invalidated by restart; use a new key after re-establishing authority");
    if (record.status === "preflight_uncertain") throw new FluxError("OPERATION_UNCERTAIN", FLUX_OPEN_PREFLIGHT_UNCERTAIN_MESSAGE, { operation, runId: record.runId });
    if (record.status === "failed" && record.failure !== undefined) throw this.#failureError(record.failure, this.#terminalFailureReceipt(state, key));
    throw new FluxError("OPERATION_UNCERTAIN", "Operation admission raced an existing durable receipt; the external side effect was not repeated.", { operation, runId: record.runId });
  }
  #pending(state: FluxPersistedState, operation: ExternalOperation, request: unknown, resultId: string, runId: string, key: string | undefined, openPreflightReceipt?: FluxOpenPreflightReceipt) {
    return key === undefined ? state.idempotency : { ...state.idempotency, [key]: { operation, digest: fluxDigest(request), resultId, runId, status: "pending" as const, startedAt: fluxNow(),
      ...(openPreflightReceipt === undefined ? {} : { openPreflightReceipt }) } };
  }
  #completed(state: FluxPersistedState, operation: string, request: unknown, resultId: string, runId: string, result: unknown, key: string | undefined) {
    if (key === undefined) return state.idempotency; const existing = state.idempotency[key];
    if (existing !== undefined && (existing.operation !== operation || existing.digest !== fluxDigest(request))) throw new FluxError("IDEMPOTENCY_CONFLICT", "Idempotency key was reused with a different request");
    const now = fluxNow();
    return { ...state.idempotency, [key]: { operation, digest: fluxDigest(request), resultId, runId, status: "completed" as const,
      startedAt: existing?.startedAt ?? now, completedAt: now, result: freeze(structuredClone(result)), terminalReceipt: { outcome: "succeeded" as const, at: now } } };
  }
  #failed(state: FluxPersistedState, operation: string, request: unknown, resultId: string, runId: string, failure: FluxOperationFailureInput, key: string | undefined, at = fluxNow()) {
    if (key === undefined) return state.idempotency;
    const existing = state.idempotency[key];
    if (existing === undefined || existing.operation !== operation || existing.digest !== fluxDigest(request) || existing.status !== "pending") throw new FluxError("IDEMPOTENCY_CONFLICT", "Terminal failure no longer matches its pending idempotency receipt");
    const failureValue = freeze(structuredClone(failure));
    const identityPayload = { operation, requestDigest: existing.digest, resultId, runId, startedAt: existing.startedAt, completedAt: at,
      code: failureValue.code, message: failureValue.message, details: failureValue.details,
      ...(failureValue.diagnostic === undefined ? {} : { diagnostic: failureValue.diagnostic }) };
    const persistedFailure: FluxPersistedOperationFailure = freeze({ ...failureValue, identity: canonicalIdentity(identityPayload, FLUX_OPERATION_FAILURE_SCHEMA_VERSION) });
    return { ...state.idempotency, [key]: { operation, digest: existing.digest, resultId, runId, status: "failed" as const,
      startedAt: existing.startedAt, completedAt: at, failure: persistedFailure, terminalReceipt: { outcome: "failed" as const, at } } };
  }
  #operationFailureReservationProviderIdentity(run: FluxPersistedRun): FluxCanonicalIdentityDto {
    return canonicalIdentity({ providerModel: run.providerModel }, FLUX_OPERATION_FAILURE_EVIDENCE_RESERVATION_PROVIDER_SCHEMA_VERSION);
  }
  #reserveOperationFailureEvidence(state: FluxPersistedState, run: FluxPersistedRun, operation: "interpret_run" | "clarify_run", request: unknown, key: string | undefined, reservedAt: string): Readonly<{ readonly reservation: FluxOperationFailureEvidenceReservation; readonly reservations: FluxPersistedState["operationFailureEvidenceReservations"] }> {
    if (Object.keys(state.operationFailureEvidence).length + Object.keys(state.operationFailureEvidenceReservations).length >= this.#operationFailureEvidenceCapacity) {
      throw new FluxError("EVIDENCE_CAPACITY", "Operation failure evidence capacity is exhausted; interpretation was not started");
    }
    const value = freeze({ schemaVersion: FLUX_OPERATION_FAILURE_EVIDENCE_RESERVATION_SCHEMA_VERSION, runId: run.id, operation,
      idempotencyKey: key ?? null, requestDigest: fluxDigest(request), providerIdentity: this.#operationFailureReservationProviderIdentity(run), reservedAt });
    const reservation = freeze({ ...value, identity: canonicalIdentity(value, FLUX_OPERATION_FAILURE_EVIDENCE_RESERVATION_SCHEMA_VERSION) });
    if (state.operationFailureEvidenceReservations[reservation.identity.digest] !== undefined) throw new FluxError("STORE_CORRUPT", "Operation failure evidence reservation identity collided");
    return freeze({ reservation, reservations: { ...state.operationFailureEvidenceReservations, [reservation.identity.digest]: reservation } });
  }
  #operationFailureEvidenceReservation(state: FluxPersistedState, run: FluxPersistedRun, operation: "interpret_run" | "clarify_run", request: unknown, key: string | undefined): Readonly<{ readonly digest: string; readonly reservation: FluxOperationFailureEvidenceReservation }> {
    const ref = run.operationFailureEvidenceReservationRef; const intent = run.inFlightOperation;
    if (ref === undefined || intent === undefined) throw new FluxError("STORE_CORRUPT", "Interpreting run is missing its operation failure evidence reservation");
    const reservation = state.operationFailureEvidenceReservations[ref.digest];
    if (reservation === undefined || canonicalJson(reservation.identity) !== canonicalJson(ref) || reservation.runId !== run.id || reservation.operation !== operation ||
      reservation.idempotencyKey !== (key ?? null) || reservation.requestDigest !== fluxDigest(request) || reservation.requestDigest !== intent.requestDigest ||
      reservation.reservedAt !== intent.startedAt || canonicalJson(reservation.providerIdentity) !== canonicalJson(this.#operationFailureReservationProviderIdentity(run))) {
      throw new FluxError("STORE_CORRUPT", "Operation failure evidence reservation no longer binds the interpreting operation");
    }
    return freeze({ digest: ref.digest, reservation });
  }
  #releaseOperationFailureEvidenceReservation(state: FluxPersistedState, run: FluxPersistedRun, operation: "interpret_run" | "clarify_run", request: unknown, key: string | undefined): FluxPersistedState["operationFailureEvidenceReservations"] {
    const binding = this.#operationFailureEvidenceReservation(state, run, operation, request, key);
    const reservations = { ...state.operationFailureEvidenceReservations }; delete reservations[binding.digest]; return freeze(reservations);
  }
  #settleOperationFailureEvidence(state: FluxPersistedState, run: FluxPersistedRun, operation: "interpret_run" | "clarify_run", request: unknown, key: string | undefined, diagnostic: FluxDiagnosticDto | undefined, evidence: FluxOperationFailureEvidence): Readonly<{ readonly records: FluxPersistedState["operationFailureEvidence"]; readonly reservations: FluxPersistedState["operationFailureEvidenceReservations"] }> {
    const reservations = this.#releaseOperationFailureEvidenceReservation(state, run, operation, request, key);
    if (diagnostic === undefined) throw new FluxError("STORE_CORRUPT", "Operation failure evidence is missing its public diagnostic binding");
    let parsed: FluxOperationFailureEvidence;
    try { parsed = parseFluxOperationFailureEvidence(evidence); assertFluxOperationFailureEvidenceMatchesDiagnostic(parsed, diagnostic); }
    catch { throw new FluxError("STORE_CORRUPT", "Operation failure evidence failed its diagnostic identity binding"); }
    const digest = fluxOperationFailureEvidenceIdentity(parsed).digest; const existing = state.operationFailureEvidence[digest];
    if (existing !== undefined && canonicalJson(parseFluxOperationFailureEvidence(existing)) !== canonicalJson(parsed)) throw new FluxError("STORE_CORRUPT", "Operation failure evidence digest resolves to different content");
    return freeze({ records: existing === undefined ? { ...state.operationFailureEvidence, [digest]: parsed } : state.operationFailureEvidence, reservations });
  }
  #genericOperationFailure(error: unknown, category: "flux_error" | "external_error" | "invalid_diagnostic" | "invalid_provider_evidence", diagnosticCode: FluxDiagnosticDto["code"]): FluxOperationFailureResolution {
    const operationFailureEvidence = createFluxGenericOperationFailureEvidence(category, diagnosticCode);
    const diagnostic = createFluxOperationFailureDiagnostic(operationFailureEvidence);
    const failure = freeze({ code: error instanceof FluxError ? error.code : "ILLEGAL_TRANSITION" as const, message: this.#message(error), details: {}, diagnostic });
    return freeze({ failure, operationFailureEvidence });
  }
  #operationFailure(error: unknown): FluxOperationFailureResolution {
    let diagnostic: FluxDiagnosticDto | undefined;
    try {
      const candidate = typeof error === "object" && error !== null && "diagnostic" in error ? (error as { readonly diagnostic?: unknown }).diagnostic : undefined;
      diagnostic = candidate === undefined ? undefined : parseFluxDiagnostic(candidate);
    } catch { return this.#genericOperationFailure(error, "invalid_diagnostic", "TOOLCHAIN_FAILURE"); }
    let richEvidence: FluxOperationFailureEvidence | undefined;
    try {
      const candidate = typeof error === "object" && error !== null && "providerFailureEvidence" in error ? (error as { readonly providerFailureEvidence?: unknown }).providerFailureEvidence : undefined;
      richEvidence = candidate === undefined ? undefined : parseFluxOperationFailureEvidence(candidate);
      if (richEvidence !== undefined) {
        if (richEvidence.schemaVersion !== PROVIDER_FAILURE_EVIDENCE_SCHEMA_VERSION) throw new Error("provider carrier evidence schema is invalid");
        if (diagnostic === undefined) throw new Error("missing diagnostic");
        assertFluxOperationFailureEvidenceMatchesDiagnostic(richEvidence, diagnostic);
      }
    } catch { return this.#genericOperationFailure(error, "invalid_provider_evidence", "TOOLCHAIN_FAILURE"); }
    if (richEvidence !== undefined) {
      const failure = freeze({ code: error instanceof FluxError ? error.code : "ILLEGAL_TRANSITION" as const, message: this.#message(error), details: {}, diagnostic: diagnostic! });
      return freeze({ failure, operationFailureEvidence: richEvidence });
    }
    if (error instanceof PcbDesignInterpreterError) {
      try {
        const operationFailureEvidence = createFluxPcbInterpreterFailureEvidence(error.code, diagnostic?.code);
        const interpreterDiagnostic = createFluxOperationFailureDiagnostic(operationFailureEvidence);
        const failure = freeze({ code: "ILLEGAL_TRANSITION" as const, message: this.#message(error), details: {}, diagnostic: interpreterDiagnostic });
        return freeze({ failure, operationFailureEvidence });
      } catch {
        return this.#genericOperationFailure(error, "invalid_diagnostic", "TOOLCHAIN_FAILURE");
      }
    }
    return this.#genericOperationFailure(error, error instanceof FluxError ? "flux_error" : "external_error", diagnostic?.code ?? "TOOLCHAIN_FAILURE");
  }
  #terminalFailureReceipt(state: FluxPersistedState, key: string): FluxTerminalFailureReceiptDto {
    const receipt = state.idempotency[key];
    if (receipt?.status !== "failed" || receipt.failure === undefined || receipt.completedAt === undefined ||
      !["interpret_run", "clarify_run", "checkpoint_open"].includes(receipt.operation)) throw new FluxError("STORE_CORRUPT", "Terminal failure receipt is unavailable");
    const run = state.runs[receipt.runId];
    if (receipt.operation === "checkpoint_open") {
      if (run?.phase !== "blocked" || run.checkpointRequired !== true || run.updatedAt !== receipt.completedAt || run.blockedReason !== receipt.failure.message) throw new FluxError("STORE_CORRUPT", "Terminal checkpoint failure is not bound to its blocked run");
      const value = freeze({ schemaVersion: FLUX_CHECKPOINT_FAILURE_RECEIPT_SCHEMA_VERSION, operation: "checkpoint_open" as const,
        idempotencyKey: key, requestDigest: receipt.digest, projectId: run.projectId, threadId: run.threadId, runId: run.id,
        failureIdentity: canonicalIdentity({ code: receipt.failure.code, message: receipt.failure.message, details: receipt.failure.details }, FLUX_CHECKPOINT_FAILURE_SCHEMA_VERSION),
        terminalPhase: "blocked" as const, outcome: "failed" as const, completedAt: receipt.completedAt });
      return freeze({ ...value, identity: canonicalIdentity(value, FLUX_CHECKPOINT_FAILURE_RECEIPT_SCHEMA_VERSION) });
    }
    if (run === undefined || run.phase !== "blocked" || receipt.failure.diagnostic === undefined) throw new FluxError("STORE_CORRUPT", "Terminal interpretation failure is not bound to a diagnosed blocked run");
    const diagnostic = parseFluxDiagnostic(receipt.failure.diagnostic);
    const diagnosticIdentity = canonicalIdentity(diagnostic, FLUX_TERMINAL_FAILURE_DIAGNOSTIC_SCHEMA_VERSION);
    const value = freeze({
      schemaVersion: FLUX_TERMINAL_FAILURE_RECEIPT_SCHEMA_VERSION,
      operation: receipt.operation as "interpret_run" | "clarify_run",
      idempotencyKey: key,
      requestDigest: receipt.digest,
      projectId: run.projectId,
      threadId: run.threadId,
      runId: run.id,
      diagnosticIdentity,
      terminalPhase: "blocked" as const,
      outcome: "failed" as const,
      completedAt: receipt.completedAt,
    });
    return freeze({ ...value, identity: canonicalIdentity(value, FLUX_TERMINAL_FAILURE_RECEIPT_SCHEMA_VERSION) });
  }
  #failureError(failure: FluxOperationFailureInput | FluxPersistedOperationFailure, terminalFailureReceipt?: FluxTerminalFailureReceiptDto): FluxError {
    return new FluxError(failure.code, failure.message, freeze(structuredClone(failure.details)), failure.diagnostic, terminalFailureReceipt);
  }
  async #coalesce<Result>(operation: LifecycleOperation, runId: string, request: unknown, key: string | undefined, task: () => Promise<Result>): Promise<Result> {
    if (key === undefined) return task(); const scope = `${runId}\0${operation}\0${key}`; const digest = fluxDigest(request); const active = this.#inFlight.get(scope);
    if (active !== undefined) { if (active.digest === digest) return active.promise as Promise<Result>; try { await active.promise; } catch { /* durable lookup decides */ } return task(); }
    const promise = task(); this.#inFlight.set(scope, { digest, promise });
    try { return await promise; } finally { if (this.#inFlight.get(scope)?.promise === promise) this.#inFlight.delete(scope); }
  }
  async #observe(phase: "intent_persisted" | "side_effect_completed", operation: ExternalOperation, runId: string): Promise<void> {
    try { await this.options.lifecycleObserver?.({ phase, operation, runId }); }
    catch (error) { throw new FluxLifecycleObservationFailure(error); }
  }
  #resultId(state: FluxPersistedState, operation: string, request: unknown, key: string | undefined, fallback: string | undefined): string | undefined {
    if (key === undefined) return fallback; const record = state.idempotency[key];
    if (record === undefined || record.operation !== operation || record.digest !== fluxDigest(request)) throw new FluxError("STORE_CORRUPT", "Idempotency result is missing"); return record.resultId;
  }
  #message(error: unknown): string {
    return error instanceof FluxError ? error.message : FLUX_TOOLCHAIN_FAILURE_MESSAGE;
  }
}
