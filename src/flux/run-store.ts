import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { isProxy } from "node:util/types";
import { parsePortableJsonBytes } from "../core/portable-artifact.js";
import { canonicalIdentity, canonicalJson } from "../core/canonical.js";
import {
  parseFluxDiagnostic,
  type FluxDiagnosticDto
} from "../domain/diagnostics.js";
import { parsePcbDesignCompilationBundleRef } from "../harness/pcb-design-compilation-bundle.js";
import { parseFreshNetClassSemanticAuthority as parseCurrentFreshNetClassSemanticAuthority, verifyFreshClearanceEvidenceReceiptAgainstSemanticAuthority } from "../harness/fresh-clearance-evidence.js";
import { isFluxLegacyNetClassEvidence, parseFluxPersistedClearanceEvidenceReceipt as parseFreshClearanceEvidenceReceipt, parseFluxPersistedNetClassPreparationEvidence as parseFreshNetClassPreparationEvidence, parseFluxPersistedNetClassSemanticAuthority as parseFreshNetClassSemanticAuthority } from "./legacy-netclass-evidence.js";
import { parseFreshProjectOpenPreparedSourceAuthority } from "../harness/fresh-project.js";
import { PCB_AGENT_MAX_FRESH_ITERATIONS, PCB_AGENT_MIN_ITERATIONS } from "../harness/pcb-agent-harness.js";
import { FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE, FLUX_LEGACY_AUTHORED_NETCLASS_REVIEW_MESSAGE, FLUX_LEGACY_CLEARANCE_REVIEW_MESSAGE, FLUX_LEGACY_FULL_SEMANTIC_AUTHORITY_REVIEW_MESSAGE, FLUX_LEGACY_SEMANTIC_REVIEW_MESSAGE, FLUX_LEGACY_TERMINAL_CLEARANCE_RECEIPT_REVIEW_MESSAGE, FLUX_OPEN_PREFLIGHT_UNCERTAIN_MESSAGE, FLUX_OPERATION_FAILURE_EVIDENCE_MAX_RECORDS, FLUX_OPERATION_FAILURE_EVIDENCE_MAX_RECORDS_PER_RUN, FLUX_OPERATION_FAILURE_EVIDENCE_RESERVATION_PROVIDER_SCHEMA_VERSION, FLUX_OPERATION_FAILURE_EVIDENCE_RESERVATION_SCHEMA_VERSION, FLUX_OPERATION_FAILURE_SCHEMA_VERSION, FLUX_STATE_SCHEMA_VERSION, FLUX_TOOLCHAIN_FAILURE_MESSAGE, fluxDigest, FluxError, freeze, type FluxCanonicalIdentityDto, type FluxEventDto, type FluxOperationFailureEvidenceReservation, type FluxPersistedReport, type FluxPersistedState } from "./contracts.js";
import {
  assertFluxOperationFailureEvidenceMatchesDiagnostic,
  createFluxLegacyOperationFailureEvidence,
  createFluxOperationFailureDiagnostic,
  FLUX_OPERATION_FAILURE_EVIDENCE_MAX_BYTES,
  fluxOperationFailureEvidenceIdentity,
  parseFluxOperationFailureEvidence,
  type FluxOperationFailureEvidence
} from "./operation-failure-evidence.js";
import { parseFluxDeepRuleSummary } from "./deep-rule-summary.js";
import { FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE } from "./contracts.js";
import { parseFluxPersistedFreshClearanceEvidenceBinding } from "./fresh-clearance-evidence-binding.js";
import { parseFluxOpenPreflightFailureReceipt, parseFluxOpenPreflightUncertainReceipt, parseFluxPersistedOpenCheckpointReceipt, parseFluxPersistedOpenPreflightReceipt } from "./open-preflight.js";

const isWithin = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};
const comparable = (value: string): string => process.platform === "win32" ? value.toLowerCase() : value;

export const assertDisjointRoots = (sourceRoot: string, workspaceRoot: string): void => {
  const source = comparable(path.resolve(sourceRoot));
  const workspace = comparable(path.resolve(workspaceRoot));
  if (isWithin(source, workspace) || isWithin(workspace, source)) {
    throw new FluxError("PATH_POLICY", "Source and Flux workspace roots must be disjoint");
  }
};

const assertNoSymlink = async (target: string, label: string): Promise<void> => {
  const stat = await lstat(target);
  if (stat.isSymbolicLink()) throw new FluxError("PATH_POLICY", `${label} may not be a symbolic link`);
};

const SAFE_ID = /^[a-z][a-z0-9_-]{0,127}$/u;
const SAFE_SOURCE_KEY = /^[a-z][a-z0-9_-]{0,63}$/u;
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,200}$/u;
const HEX_64 = /^[0-9a-f]{64}$/u;
const RUN_PHASES = new Set(["draft", "interpreting", "awaiting_clarification", "contract_ready", "preparing", "awaiting_open", "opening", "awaiting_checkpoint", "checkpointing", "awaiting_approval", "approved", "queued", "running", "completed", "needs_review", "failed", "blocked"]);
const TERMINAL_PHASES_FOR_STORE = new Set(["completed", "needs_review", "failed", "blocked"]);
const EVENT_KINDS = new Set(["project_created", "thread_created", "run_created", "interpretation_started", "clarification_requested", "contract_compiled", "run_prepared", "run_opened", "open_checkpoint_recorded", "approval_recorded", "approval_consumed", "run_queued", "run_started", "run_progress", "preview_ready", "preview_warning", "run_completed", "run_needs_review", "run_failed", "run_blocked"]);
const operationEvidenceMatchesDiagnostic = (evidence: unknown, diagnostic: unknown): boolean => {
  try { assertFluxOperationFailureEvidenceMatchesDiagnostic(parseFluxOperationFailureEvidence(evidence), parseFluxDiagnostic(diagnostic)); return true; } catch { return false; }
};

const stateRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value) || isProxy(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new FluxError("STORE_CORRUPT", `${label} must be a plain object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new FluxError("STORE_CORRUPT", `${label} may not contain symbol fields`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) throw new FluxError("STORE_CORRUPT", `${label} may contain only enumerable data fields`);
  }
  return value as Record<string, unknown>;
};
const exactStateKeys = (record: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void => {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(record, key)) || Object.keys(record).some((key) => !allowed.has(key))) throw new FluxError("STORE_CORRUPT", `${label} contains missing or unknown fields`);
};
const stateText = (value: unknown, label: string, maximum = 1_048_576): string => {
  if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value, "utf8") > maximum) throw new FluxError("STORE_CORRUPT", `${label} must be bounded text`);
  return value;
};
const stateId = (value: unknown, label: string, pattern = SAFE_ID): string => {
  const id = stateText(value, label, 256);
  if (!pattern.test(id)) throw new FluxError("STORE_CORRUPT", `${label} is not a safe identifier`);
  return id;
};
const stateTime = (value: unknown, label: string): string => {
  const timestamp = stateText(value, label, 64);
  if (Number.isNaN(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) throw new FluxError("STORE_CORRUPT", `${label} is not canonical UTC time`);
  return timestamp;
};
const stateIdentity = (value: unknown, label: string): FluxCanonicalIdentityDto => {
  const identity = stateRecord(value, label); exactStateKeys(identity, ["algorithm", "digest", "schemaVersion", "canonicalizationVersion"], [], label);
  if (identity.algorithm !== "sha256" || typeof identity.digest !== "string" || !HEX_64.test(identity.digest) || typeof identity.schemaVersion !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(identity.schemaVersion) || identity.canonicalizationVersion !== "evleda-c14n-json-v1") throw new FluxError("STORE_CORRUPT", `${label} is invalid`);
  return identity as unknown as FluxCanonicalIdentityDto;
};
const stateMap = (value: unknown, label: string): Record<string, unknown> => stateRecord(value, label);
const assertNoPrivateStateFields = (value: unknown, label: string, depth = 0): void => {
  if (depth > 64) throw new FluxError("STORE_CORRUPT", `${label} exceeds its safe depth`);
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return;
  if (Array.isArray(value)) { for (const entry of value) assertNoPrivateStateFields(entry, label, depth + 1); return; }
  const record = stateRecord(value, label);
  for (const [key, child] of Object.entries(record)) {
    if (["compilationBundle", "executionPrompt", "projectPaths", "sourceRoot"].includes(key)) throw new FluxError("STORE_CORRUPT", `${label} contains a private authority or path field`);
    assertNoPrivateStateFields(child, label, depth + 1);
  }
};
const assertMetadata = (value: unknown, label: string, persisted: boolean): void => {
  const record = stateRecord(value, label);
  exactStateKeys(record, persisted ? ["reportId", "runId", "title", "digest", "mediaType", "createdAt", "body"] : ["reportId", "title", "digest", "mediaType", "createdAt"],
    ["disposition", "summary", "reportSha256", "freshAcceptance", "freshBoardSaveAudits", "executionBridgeIdentity", "writeSessionAuthorityIdentity", "writeSessionReceiptIdentity", "executionInspectionSessionReceiptIdentity", "freshClearanceEvidenceBinding"], label);
  stateId(record.reportId, `${label}.reportId`);
  if (persisted) stateId(record.runId, `${label}.runId`);
  stateText(record.title, `${label}.title`, 16_384); stateText(record.mediaType, `${label}.mediaType`, 512); stateTime(record.createdAt, `${label}.createdAt`);
  if (!HEX_64.test(stateText(record.digest, `${label}.digest`, 64))) throw new FluxError("STORE_CORRUPT", `${label}.digest is invalid`);
  if (persisted) stateText(record.body, `${label}.body`, 1024 * 1024);
  if (record.disposition !== undefined && !["completed", "needs_review", "blocked", "failed"].includes(String(record.disposition))) throw new FluxError("STORE_CORRUPT", `${label}.disposition is invalid`);
  if (record.summary !== undefined) stateText(record.summary, `${label}.summary`, 64 * 1024);
  if (record.reportSha256 !== undefined && !HEX_64.test(stateText(record.reportSha256, `${label}.reportSha256`, 64))) throw new FluxError("STORE_CORRUPT", `${label}.reportSha256 is invalid`);
  if (record.freshAcceptance !== undefined) stateRecord(record.freshAcceptance, `${label}.freshAcceptance`);
  if (record.freshBoardSaveAudits !== undefined && !Array.isArray(record.freshBoardSaveAudits)) throw new FluxError("STORE_CORRUPT", `${label}.freshBoardSaveAudits is invalid`);
  const writeIdentityCount = [record.executionBridgeIdentity, record.writeSessionAuthorityIdentity, record.writeSessionReceiptIdentity, record.executionInspectionSessionReceiptIdentity].filter((item) => item !== undefined).length;
  if (writeIdentityCount !== 0 && writeIdentityCount !== 4) throw new FluxError("STORE_CORRUPT", `${label} has an incomplete execution-session identity set`);
  if (writeIdentityCount === 4) {
    const execution = stateIdentity(record.executionBridgeIdentity, `${label}.executionBridgeIdentity`); const authority = stateIdentity(record.writeSessionAuthorityIdentity, `${label}.writeSessionAuthorityIdentity`); const receipt = stateIdentity(record.writeSessionReceiptIdentity, `${label}.writeSessionReceiptIdentity`); const inspectionReceipt = stateIdentity(record.executionInspectionSessionReceiptIdentity, `${label}.executionInspectionSessionReceiptIdentity`);
    if (execution.schemaVersion !== "evleda.kicad-mcp-execution-bridge.v1" || authority.schemaVersion !== "evleda.kicad-mcp-session-authority.v1" || receipt.schemaVersion !== "evleda.kicad-mcp-session-receipt.v1" || inspectionReceipt.schemaVersion !== "evleda.kicad-mcp-session-receipt.v1") throw new FluxError("STORE_CORRUPT", `${label} has invalid execution-session identity schemas`);
  }
  if (record.freshClearanceEvidenceBinding !== undefined) { try { parseFluxPersistedFreshClearanceEvidenceBinding(record.freshClearanceEvidenceBinding); } catch { throw new FluxError("STORE_CORRUPT", `${label} has an invalid fresh clearance evidence binding`); } }
  if (record.freshClearanceEvidenceBinding !== undefined && writeIdentityCount !== 4) throw new FluxError("STORE_CORRUPT", `${label} clearance evidence lacks its execution-session authority quartet`);
};
const assertContractStateEnvelope = (value: unknown, label: string): void => {
  const record = stateRecord(value, label);
  exactStateKeys(record, ["disposition", "questions", "issues", "contract", "contractIdentity", "libraryBindingIdentity", "deepRuleBindingIdentity", "acceptancePlanIdentity", "interpreterReceipt"], ["deepRuleSummary"], label);
  if (!["needs_clarification", "unsupported", "ready"].includes(String(record.disposition)) || !Array.isArray(record.questions) || !Array.isArray(record.issues)) throw new FluxError("STORE_CORRUPT", `${label} has an invalid disposition or issue arrays`);
  for (const [index, item] of record.questions.entries()) exactStateKeys(stateRecord(item, `${label}.questions[${index}]`), ["id", "path", "question"], [], `${label}.questions[${index}]`);
  for (const [index, item] of record.issues.entries()) exactStateKeys(stateRecord(item, `${label}.issues[${index}]`), ["code", "severity", "path", "message", "clarificationId"], [], `${label}.issues[${index}]`);
  const receipt = stateRecord(record.interpreterReceipt, `${label}.interpreterReceipt`);
  if (receipt.schemaVersion === "evleda.flux-interpreter-receipt.v1") exactStateKeys(receipt, ["schemaVersion", "interpreterSchemaVersion", "provider", "promptDigest", "clarificationDigest", "compiledAt"], [], `${label}.interpreterReceipt`);
  else if (receipt.schemaVersion === "evleda.flux-interpreter-receipt.v2") exactStateKeys(receipt, ["schemaVersion", "interpreterSchemaVersion", "provider", "providerProfile", "providerProfileIdentity", "promptDigest", "clarificationDigest", "compilerProfileIdentity", "practiceProfileBindingIdentity", "bundleIdentity", "compiledAt", "identity"], [], `${label}.interpreterReceipt`);
  else throw new FluxError("STORE_CORRUPT", `${label}.interpreterReceipt schema is unsupported`);
  if (record.deepRuleSummary !== undefined) {
    try { parseFluxDeepRuleSummary(record.deepRuleSummary); } catch { throw new FluxError("STORE_CORRUPT", `${label}.deepRuleSummary is invalid`); }
    if (record.disposition !== "ready" || record.deepRuleBindingIdentity === null || canonicalJson((record.deepRuleSummary as Record<string, unknown>).deepRuleBindingIdentity) !== canonicalJson(record.deepRuleBindingIdentity)) throw new FluxError("STORE_CORRUPT", `${label}.deepRuleSummary is not bound to its contract state`);
  }
  assertNoPrivateStateFields(record, label);
};

function assertPlainState(value: unknown): asserts value is FluxPersistedState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new FluxError("STORE_CORRUPT", "Flux state must be an object");
  const state = value as Partial<FluxPersistedState>;
  if (state.schemaVersion !== FLUX_STATE_SCHEMA_VERSION || !Number.isSafeInteger(state.revision) || state.revision! < 0 ||
    !state.sources || !state.projects || !state.threads || !state.runs || !state.reports || !state.operationFailureEvidence || !state.operationFailureEvidenceReservations || !state.idempotency || !Array.isArray(state.events) ||
    !Number.isSafeInteger(state.nextEventSeq) || state.nextEventSeq! < 1) {
    throw new FluxError("STORE_CORRUPT", "Flux state has an invalid envelope");
  }
  if (state.events.some((item) => typeof item !== "object" || item === null || !Number.isSafeInteger((item as Record<string, unknown>).eventSeq) || ((item as Record<string, unknown>).eventSeq as number) < 1) ||
    state.events.some((event, index) => index > 0 && event.eventSeq <= state.events![index - 1]!.eventSeq) || (state.events.at(-1)?.eventSeq ?? 0) >= state.nextEventSeq!) throw new FluxError("STORE_CORRUPT", "Flux event sequence is invalid");

  const root = stateRecord(value, "Flux state");
  exactStateKeys(root, ["schemaVersion", "revision", "sources", "projects", "threads", "runs", "reports", "operationFailureEvidence", "operationFailureEvidenceReservations", "idempotency", "events", "nextEventSeq"], [], "Flux state");
  const sources = stateMap(state.sources, "Flux sources");
  for (const [key, item] of Object.entries(sources)) {
    stateId(key, "Flux source map key", SAFE_SOURCE_KEY); const source = stateRecord(item, `Flux source ${key}`);
    exactStateKeys(source, ["key", "label", "fingerprint"], [], `Flux source ${key}`);
    if (stateId(source.key, `Flux source ${key}.key`, SAFE_SOURCE_KEY) !== key || !stateText(source.label, `Flux source ${key}.label`, 16_384).trim() || !HEX_64.test(stateText(source.fingerprint, `Flux source ${key}.fingerprint`, 64))) throw new FluxError("STORE_CORRUPT", `Flux source ${key} is invalid`);
  }
  const projects = stateMap(state.projects, "Flux projects");
  for (const [key, item] of Object.entries(projects)) {
    stateId(key, "Flux project map key"); const project = stateRecord(item, `Flux project ${key}`);
    exactStateKeys(project, ["id", "sourceKey", "name", "createdAt"], [], `Flux project ${key}`);
    if (stateId(project.id, `Flux project ${key}.id`) !== key || sources[stateId(project.sourceKey, `Flux project ${key}.sourceKey`, SAFE_SOURCE_KEY)] === undefined || !stateText(project.name, `Flux project ${key}.name`, 16_384).trim()) throw new FluxError("STORE_CORRUPT", `Flux project ${key} is invalid`);
    stateTime(project.createdAt, `Flux project ${key}.createdAt`);
  }
  const threads = stateMap(state.threads, "Flux threads");
  for (const [key, item] of Object.entries(threads)) {
    stateId(key, "Flux thread map key"); const thread = stateRecord(item, `Flux thread ${key}`);
    exactStateKeys(thread, ["id", "projectId", "title", "createdAt"], [], `Flux thread ${key}`);
    if (stateId(thread.id, `Flux thread ${key}.id`) !== key || projects[stateId(thread.projectId, `Flux thread ${key}.projectId`)] === undefined || !stateText(thread.title, `Flux thread ${key}.title`, 16_384).trim()) throw new FluxError("STORE_CORRUPT", `Flux thread ${key} is invalid`);
    stateTime(thread.createdAt, `Flux thread ${key}.createdAt`);
  }
  const runs = stateMap(state.runs, "Flux runs");
  for (const [key, item] of Object.entries(runs)) {
    stateId(key, "Flux run map key"); const run = stateRecord(item, `Flux run ${key}`);
    exactStateKeys(run, ["id", "projectId", "threadId", "sourceKey", "sourceFingerprint", "phase", "prompt", "providerModel", "iterationCap", "harnessRuleIdentity", "mutationAllowlist", "freshAcceptanceProfileIdentity", "freshPersistenceProfileIdentity", "workflowKind", "reports", "createdAt", "updatedAt"],
      ["contractState", "compilationBundleRef", "preview", "checkpointRequired", "approval", "blockedReason", "diagnostic", "isolatedFingerprint", "inFlightOperation", "operationFailureEvidenceReservationRef", "freshNetClassPreparationEvidence", "freshNetClassSemanticAuthority", "freshProjectOpenPreparedSourceAuthority", "freshClearanceEvidenceReceipt", "openPreflightReceipt", "openCheckpointReceipt"], `Flux run ${key}`);
    const projectId = stateId(run.projectId, `Flux run ${key}.projectId`); const threadId = stateId(run.threadId, `Flux run ${key}.threadId`); const sourceKey = stateId(run.sourceKey, `Flux run ${key}.sourceKey`, SAFE_SOURCE_KEY);
    if (stateId(run.id, `Flux run ${key}.id`) !== key || projects[projectId] === undefined || threads[threadId] === undefined || sources[sourceKey] === undefined || (threads[threadId] as Record<string, unknown>).projectId !== projectId || (projects[projectId] as Record<string, unknown>).sourceKey !== sourceKey) throw new FluxError("STORE_CORRUPT", `Flux run ${key} has invalid cross-references`);
    if (!RUN_PHASES.has(String(run.phase)) || !HEX_64.test(stateText(run.sourceFingerprint, `Flux run ${key}.sourceFingerprint`, 64)) || !Number.isSafeInteger(run.iterationCap) || (run.iterationCap as number) < PCB_AGENT_MIN_ITERATIONS || (run.iterationCap as number) > PCB_AGENT_MAX_FRESH_ITERATIONS || !Array.isArray(run.mutationAllowlist) || !Array.isArray(run.reports)) throw new FluxError("STORE_CORRUPT", `Flux run ${key} has invalid fields`);
    stateText(run.prompt, `Flux run ${key}.prompt`); stateText(run.harnessRuleIdentity, `Flux run ${key}.harnessRuleIdentity`, 16_384); stateText(run.freshAcceptanceProfileIdentity, `Flux run ${key}.freshAcceptanceProfileIdentity`, 16_384); stateText(run.freshPersistenceProfileIdentity, `Flux run ${key}.freshPersistenceProfileIdentity`, 16_384);
    const provider = stateRecord(run.providerModel, `Flux run ${key}.providerModel`); exactStateKeys(provider, ["provider", "model", "tier"], [], `Flux run ${key}.providerModel`);
    for (const field of ["provider", "model", "tier"] as const) if (!stateText(provider[field], `Flux run ${key}.providerModel.${field}`, 1_024).trim()) throw new FluxError("STORE_CORRUPT", `Flux run ${key} provider binding is invalid`);
    if (!run.mutationAllowlist.every((entry) => typeof entry === "string" && entry.trim() && !path.isAbsolute(entry) && !entry.includes(".."))) throw new FluxError("STORE_CORRUPT", `Flux run ${key} mutation allowlist is invalid`);
    if (!["generic", "led_compatibility_fixture"].includes(String(run.workflowKind))) throw new FluxError("STORE_CORRUPT", `Flux run ${key} workflow is invalid`);
    if (run.contractState !== undefined) assertContractStateEnvelope(run.contractState, `Flux run ${key}.contractState`);
    if (run.compilationBundleRef !== undefined) { try { parsePcbDesignCompilationBundleRef(run.compilationBundleRef); } catch { throw new FluxError("STORE_CORRUPT", `Flux run ${key} bundle reference is invalid`); } }
    if (run.preview !== undefined) {
      const preview = stateRecord(run.preview, `Flux run ${key}.preview`); exactStateKeys(preview, ["title", "summary", "artifactCount", "digest"], [], `Flux run ${key}.preview`);
      if (!stateText(preview.title, `Flux run ${key}.preview.title`, 4_096).trim() || !stateText(preview.summary, `Flux run ${key}.preview.summary`, 16_384).trim() || !Number.isSafeInteger(preview.artifactCount) || (preview.artifactCount as number) < 0 || !HEX_64.test(stateText(preview.digest, `Flux run ${key}.preview.digest`, 64))) throw new FluxError("STORE_CORRUPT", `Flux run ${key} preview is invalid`);
    }
    if (run.checkpointRequired !== undefined && typeof run.checkpointRequired !== "boolean") throw new FluxError("STORE_CORRUPT", `Flux run ${key} checkpoint flag is invalid`);
    if (run.isolatedFingerprint !== undefined && !HEX_64.test(stateText(run.isolatedFingerprint, `Flux run ${key}.isolatedFingerprint`, 64))) throw new FluxError("STORE_CORRUPT", `Flux run ${key} isolated fingerprint is invalid`);
    if (run.blockedReason !== undefined) stateText(run.blockedReason, `Flux run ${key}.blockedReason`, 64 * 1024);
    if (run.diagnostic !== undefined) { try { parseFluxDiagnostic(run.diagnostic); } catch { throw new FluxError("STORE_CORRUPT", `Flux run ${key} diagnostic is invalid`); } }
    if (run.operationFailureEvidenceReservationRef !== undefined) stateIdentity(run.operationFailureEvidenceReservationRef, `Flux run ${key}.operationFailureEvidenceReservationRef`);
    if ([run.freshNetClassPreparationEvidence, run.freshNetClassSemanticAuthority, run.freshClearanceEvidenceReceipt].some(isFluxLegacyNetClassEvidence) && (run.phase === "completed" || !TERMINAL_PHASES_FOR_STORE.has(String(run.phase)))) throw new FluxError("STORE_CORRUPT", `Flux run ${key} historical cache-based net-class evidence cannot authorize current preparation or completion`);
    if (run.freshNetClassPreparationEvidence !== undefined) {
      try { parseFreshNetClassPreparationEvidence(run.freshNetClassPreparationEvidence); } catch { throw new FluxError("STORE_CORRUPT", `Flux run ${key} fresh net-class preparation evidence is invalid`); }
      if (run.workflowKind !== "generic") throw new FluxError("STORE_CORRUPT", `Flux run ${key} LED workflow contains generic preparation evidence`);
    }
    if (run.freshNetClassSemanticAuthority !== undefined) {
      let authority; try { authority = parseFreshNetClassSemanticAuthority(run.freshNetClassSemanticAuthority); }
      catch { throw new FluxError("STORE_CORRUPT", `Flux run ${key} full net-class semantic authority is invalid`); }
      if (run.workflowKind !== "generic") throw new FluxError("STORE_CORRUPT", `Flux run ${key} LED workflow contains generic semantic authority`);
      if (run.freshNetClassPreparationEvidence !== undefined) {
        const preparation = parseFreshNetClassPreparationEvidence(run.freshNetClassPreparationEvidence);
        if (canonicalJson(authority.identity) !== canonicalJson(preparation.semanticAuthorityIdentity) || canonicalJson(authority.bundleIdentity) !== canonicalJson(preparation.bundleIdentity) ||
          canonicalJson(authority.contractIdentity) !== canonicalJson(preparation.contractIdentity) || canonicalJson(authority.genericProjectBindingIdentity) !== canonicalJson(preparation.genericProjectBindingIdentity) ||
          canonicalJson(authority.freshMarkerContentIdentity) !== canonicalJson(preparation.freshMarkerContentIdentity) || canonicalJson(authority.kicad) !== canonicalJson(preparation.kicad)) {
          throw new FluxError("STORE_CORRUPT", `Flux run ${key} semantic authority does not bind its preparation evidence`);
        }
      }
    }
    if (run.freshProjectOpenPreparedSourceAuthority !== undefined) {
      try {
        const authority = parseFreshProjectOpenPreparedSourceAuthority(run.freshProjectOpenPreparedSourceAuthority);
        stateText(authority.projectIdentity.canonicalPath, `Flux run ${key} prepared-source project path`, 16_384);
      } catch { throw new FluxError("STORE_CORRUPT", `Flux run ${key} prepared-source authority is invalid`); }
      if (run.workflowKind !== "generic") throw new FluxError("STORE_CORRUPT", `Flux run ${key} LED workflow contains generic prepared-source authority`);
    }
    if (run.freshClearanceEvidenceReceipt !== undefined) {
      try { parseFreshClearanceEvidenceReceipt(run.freshClearanceEvidenceReceipt); }
      catch { throw new FluxError("STORE_CORRUPT", `Flux run ${key} terminal fresh clearance evidence receipt is invalid`); }
      if (run.workflowKind !== "generic") throw new FluxError("STORE_CORRUPT", `Flux run ${key} LED workflow contains generic terminal clearance evidence`);
      if (!TERMINAL_PHASES_FOR_STORE.has(String(run.phase))) throw new FluxError("STORE_CORRUPT", `Flux run ${key} contains terminal clearance evidence before reaching a terminal phase`);
    }
    if (run.openPreflightReceipt !== undefined) {
      let receipt; try { receipt = parseFluxPersistedOpenPreflightReceipt(run.openPreflightReceipt); } catch { throw new FluxError("STORE_CORRUPT", `Flux run ${key} Open preflight receipt is invalid`); }
      if (receipt.runId !== key || receipt.projectId !== projectId) throw new FluxError("STORE_CORRUPT", `Flux run ${key} Open preflight receipt cross-reference is invalid`);
      if (receipt.schemaVersion === "evleda.flux-open-preflight.v4") {
        const preparation = run.freshNetClassPreparationEvidence === undefined ? undefined : parseFreshNetClassPreparationEvidence(run.freshNetClassPreparationEvidence);
        const preparedSource = run.freshProjectOpenPreparedSourceAuthority === undefined ? undefined : parseFreshProjectOpenPreparedSourceAuthority(run.freshProjectOpenPreparedSourceAuthority);
        const semanticIdentity = run.workflowKind === "generic" ? preparation?.semanticAuthorityIdentity : null;
        const preparedSourceIdentity = run.workflowKind === "generic" ? preparedSource?.identity : null;
        if ((run.workflowKind === "generic" && (preparation === undefined || preparedSource === undefined)) ||
          canonicalJson(receipt.freshNetClassSemanticAuthorityIdentity) !== canonicalJson(semanticIdentity) ||
          canonicalJson(receipt.freshProjectOpenPreparedSourceAuthorityIdentity) !== canonicalJson(preparedSourceIdentity)) {
          throw new FluxError("STORE_CORRUPT", `Flux run ${key} Open preflight receipt does not bind its generic preparation authorities`);
        }
      }
      if (receipt.schemaVersion === "evleda.flux-open-preflight.v5") {
        const preparation = run.freshNetClassPreparationEvidence === undefined ? undefined : parseFreshNetClassPreparationEvidence(run.freshNetClassPreparationEvidence);
        const semantic = run.freshNetClassSemanticAuthority === undefined ? undefined : parseFreshNetClassSemanticAuthority(run.freshNetClassSemanticAuthority);
        const preparedSource = run.freshProjectOpenPreparedSourceAuthority === undefined ? undefined : parseFreshProjectOpenPreparedSourceAuthority(run.freshProjectOpenPreparedSourceAuthority);
        const semanticIdentity = run.workflowKind === "generic" ? preparation?.semanticAuthorityIdentity : null; const preparationIdentity = run.workflowKind === "generic" ? preparation?.identity : null;
        const preparedSourceIdentity = run.workflowKind === "generic" ? preparedSource?.identity : null;
        if ((run.workflowKind === "generic" && (preparation === undefined || semantic === undefined || preparedSource === undefined)) || canonicalJson(receipt.freshNetClassSemanticAuthorityIdentity) !== canonicalJson(semanticIdentity) ||
          canonicalJson(receipt.freshNetClassPreparationEvidenceIdentity) !== canonicalJson(preparationIdentity) || canonicalJson(receipt.freshProjectOpenPreparedSourceAuthorityIdentity) !== canonicalJson(preparedSourceIdentity)) {
          throw new FluxError("STORE_CORRUPT", `Flux run ${key} current Open preflight receipt does not bind its full generic preparation authority`);
        }
      }
    }
    if (run.openCheckpointReceipt !== undefined) {
      let receipt; try { receipt = parseFluxPersistedOpenCheckpointReceipt(run.openCheckpointReceipt); } catch { throw new FluxError("STORE_CORRUPT", `Flux run ${key} Open checkpoint receipt is invalid`); }
      const preflight = run.openPreflightReceipt === undefined ? undefined : parseFluxPersistedOpenPreflightReceipt(run.openPreflightReceipt);
      const preparation = run.freshNetClassPreparationEvidence === undefined ? undefined : parseFreshNetClassPreparationEvidence(run.freshNetClassPreparationEvidence);
      const preparedSource = run.freshProjectOpenPreparedSourceAuthority === undefined ? undefined : parseFreshProjectOpenPreparedSourceAuthority(run.freshProjectOpenPreparedSourceAuthority);
      const semanticIdentity = run.workflowKind === "generic" ? preparation?.semanticAuthorityIdentity : null;
      const preparedSourceIdentity = run.workflowKind === "generic" ? preparedSource?.identity : null;
      const preparationIdentity = run.workflowKind === "generic" ? preparation?.identity : null;
      if (preflight === undefined || receipt.runId !== key || canonicalJson(receipt.openPreflightReceiptIdentity) !== canonicalJson(preflight.identity) || receipt.isolatedFingerprint !== run.isolatedFingerprint ||
        (receipt.schemaVersion === "evleda.flux-open-checkpoint.v3" && (preflight.schemaVersion !== "evleda.flux-open-preflight.v2" || canonicalJson(receipt.inspectionBridgeIdentity) !== canonicalJson(preflight.inspectionBridgeIdentity) || canonicalJson(receipt.ipcSocketIdentity) !== canonicalJson(preflight.ipcSocketIdentity))) ||
        (receipt.schemaVersion === "evleda.flux-open-checkpoint.v4" && ((run.workflowKind === "generic" && preparation === undefined) || preflight.schemaVersion !== "evleda.flux-open-preflight.v3" || canonicalJson(receipt.inspectionBridgeIdentity) !== canonicalJson(preflight.inspectionBridgeIdentity) || canonicalJson(receipt.ipcSocketIdentity) !== canonicalJson(preflight.ipcSocketIdentity) ||
          canonicalJson(receipt.freshNetClassSemanticAuthorityIdentity) !== canonicalJson(semanticIdentity) || canonicalJson(preflight.freshNetClassSemanticAuthorityIdentity) !== canonicalJson(semanticIdentity))) ||
        (receipt.schemaVersion === "evleda.flux-open-checkpoint.v5" && ((run.workflowKind === "generic" && (preparation === undefined || preparedSource === undefined)) || preflight.schemaVersion !== "evleda.flux-open-preflight.v4" || canonicalJson(receipt.inspectionBridgeIdentity) !== canonicalJson(preflight.inspectionBridgeIdentity) || canonicalJson(receipt.ipcSocketIdentity) !== canonicalJson(preflight.ipcSocketIdentity) ||
          canonicalJson(receipt.freshNetClassSemanticAuthorityIdentity) !== canonicalJson(semanticIdentity) || canonicalJson(preflight.freshNetClassSemanticAuthorityIdentity) !== canonicalJson(semanticIdentity) ||
          canonicalJson(receipt.freshProjectOpenPreparedSourceAuthorityIdentity) !== canonicalJson(preparedSourceIdentity) || canonicalJson(preflight.freshProjectOpenPreparedSourceAuthorityIdentity) !== canonicalJson(preparedSourceIdentity))) ||
        (receipt.schemaVersion === "evleda.flux-open-checkpoint.v6" && ((run.workflowKind === "generic" && (preparation === undefined || run.freshNetClassSemanticAuthority === undefined || preparedSource === undefined)) || preflight.schemaVersion !== "evleda.flux-open-preflight.v5" ||
          canonicalJson(receipt.inspectionBridgeIdentity) !== canonicalJson(preflight.inspectionBridgeIdentity) || canonicalJson(receipt.ipcSocketIdentity) !== canonicalJson(preflight.ipcSocketIdentity) ||
          canonicalJson(receipt.freshNetClassSemanticAuthorityIdentity) !== canonicalJson(semanticIdentity) || canonicalJson(preflight.freshNetClassSemanticAuthorityIdentity) !== canonicalJson(semanticIdentity) ||
          canonicalJson(receipt.freshProjectOpenPreparedSourceAuthorityIdentity) !== canonicalJson(preparedSourceIdentity) || canonicalJson(preflight.freshProjectOpenPreparedSourceAuthorityIdentity) !== canonicalJson(preparedSourceIdentity) ||
          canonicalJson(receipt.freshNetClassPreparationEvidenceIdentity) !== canonicalJson(preparationIdentity) || canonicalJson(preflight.freshNetClassPreparationEvidenceIdentity) !== canonicalJson(preparationIdentity)))) {
        throw new FluxError("STORE_CORRUPT", `Flux run ${key} Open checkpoint receipt cross-reference is invalid`);
      }
    }
    if (run.approval !== undefined) {
      const approval = stateRecord(run.approval, `Flux run ${key}.approval`); exactStateKeys(approval, ["id", "subjectDigest", "approvedAt", "subject"], ["consumedAt"], `Flux run ${key}.approval`);
      stateId(approval.id, `Flux run ${key}.approval.id`); if (!HEX_64.test(stateText(approval.subjectDigest, `Flux run ${key}.approval.subjectDigest`, 64))) throw new FluxError("STORE_CORRUPT", `Flux run ${key} approval digest is invalid`);
      stateTime(approval.approvedAt, `Flux run ${key}.approval.approvedAt`); if (approval.consumedAt !== undefined) stateTime(approval.consumedAt, `Flux run ${key}.approval.consumedAt`);
      const subject = stateRecord(approval.subject, `Flux run ${key}.approval.subject`);
      const subjectBase = ["runId", "workflowKind", "sourceKey", "sourceFingerprint", "isolatedFingerprint", "promptIdentity", "providerModel", "iterationCap", "harnessRuleIdentity", "mutationAllowlist", "freshAcceptanceProfileIdentity", "freshPersistenceProfileIdentity", "contractIdentity", "libraryBindingIdentity", "deepRuleBindingIdentity", "acceptancePlanIdentity"];
      const subjectWorkflow = subject.workflowKind;
      const currentSubject = subject.schemaVersion === "evleda.flux-approval-subject.v6"; const preparedSourceSubject = subject.schemaVersion === "evleda.flux-approval-subject.v5"; const semanticSubject = subject.schemaVersion === "evleda.flux-approval-subject.v4";
      const bridgeSubject = subject.schemaVersion === "evleda.flux-approval-subject.v3"; const priorSubject = subject.schemaVersion === "evleda.flux-approval-subject.v2";
      if (currentSubject || preparedSourceSubject || semanticSubject || bridgeSubject || priorSubject) {
        const currentBase = ["schemaVersion", ...subjectBase, "kicadToolchainIdentity", "openPreflightReceiptIdentity", "openCheckpointReceiptIdentity",
          ...(currentSubject || preparedSourceSubject || semanticSubject || bridgeSubject ? ["inspectionBridgeIdentity", "executionBridgeIdentity", "ipcSocketIdentity", "writeSessionAuthorityIdentity", "ipcProbeSemanticIdentity"] : []),
          ...(currentSubject || preparedSourceSubject || semanticSubject ? ["freshNetClassSemanticAuthorityIdentity"] : []),
          ...(currentSubject || preparedSourceSubject ? ["freshProjectOpenPreparedSourceAuthorityIdentity"] : []),
          ...(currentSubject ? ["freshNetClassPreparationEvidenceIdentity"] : [])];
        exactStateKeys(subject, subjectWorkflow === "generic"
          ? [...currentBase, "compilationBundleRef", "providerProfile", "bundleIdentity", "compilerProfileIdentity", "practiceProfileBindingIdentity", "executionPromptIdentity", "executionPromptContentIdentity"]
          : [...currentBase, "compilationBundleRef", "providerProfile"], [], `Flux run ${key}.approval.subject`);
        const preflightReceipt = run.openPreflightReceipt === undefined ? undefined : parseFluxPersistedOpenPreflightReceipt(run.openPreflightReceipt);
        const checkpointReceipt = run.openCheckpointReceipt === undefined ? undefined : parseFluxPersistedOpenCheckpointReceipt(run.openCheckpointReceipt);
        if (approval.subjectDigest !== fluxDigest(subject) || subject.runId !== key || subject.sourceKey !== sourceKey || subjectWorkflow !== run.workflowKind || subject.sourceFingerprint !== run.sourceFingerprint || subject.isolatedFingerprint !== run.isolatedFingerprint ||
          preflightReceipt === undefined || checkpointReceipt === undefined || canonicalJson(subject.openPreflightReceiptIdentity) !== canonicalJson(preflightReceipt.identity) ||
          canonicalJson(subject.openCheckpointReceiptIdentity) !== canonicalJson(checkpointReceipt.identity) || canonicalJson(subject.kicadToolchainIdentity) !== canonicalJson(checkpointReceipt.kicadToolchainIdentity)) throw new FluxError("STORE_CORRUPT", `Flux run ${key} approval subject does not bind its Open and checkpoint authority`);
        stateIdentity(subject.kicadToolchainIdentity, `Flux run ${key}.approval.subject.kicadToolchainIdentity`); stateIdentity(subject.openPreflightReceiptIdentity, `Flux run ${key}.approval.subject.openPreflightReceiptIdentity`); stateIdentity(subject.openCheckpointReceiptIdentity, `Flux run ${key}.approval.subject.openCheckpointReceiptIdentity`);
        if (currentSubject || preparedSourceSubject || semanticSubject || bridgeSubject) {
          const preflightAuthority = preflightReceipt as unknown as Record<string, unknown>; const checkpointAuthority = checkpointReceipt as unknown as Record<string, unknown>;
          if ((currentSubject && (preflightReceipt.schemaVersion !== "evleda.flux-open-preflight.v5" || checkpointReceipt.schemaVersion !== "evleda.flux-open-checkpoint.v6")) ||
            (preparedSourceSubject && (preflightReceipt.schemaVersion !== "evleda.flux-open-preflight.v4" || checkpointReceipt.schemaVersion !== "evleda.flux-open-checkpoint.v5")) ||
            (semanticSubject && (preflightReceipt.schemaVersion !== "evleda.flux-open-preflight.v3" || checkpointReceipt.schemaVersion !== "evleda.flux-open-checkpoint.v4")) ||
            (bridgeSubject && (preflightReceipt.schemaVersion !== "evleda.flux-open-preflight.v2" || checkpointReceipt.schemaVersion !== "evleda.flux-open-checkpoint.v3")) ||
            canonicalJson(subject.inspectionBridgeIdentity) !== canonicalJson(preflightAuthority.inspectionBridgeIdentity) || canonicalJson(subject.inspectionBridgeIdentity) !== canonicalJson(checkpointAuthority.inspectionBridgeIdentity) ||
            canonicalJson(subject.executionBridgeIdentity) !== canonicalJson(checkpointAuthority.executionBridgeIdentity) ||
            canonicalJson(subject.ipcSocketIdentity) !== canonicalJson(preflightAuthority.ipcSocketIdentity) || canonicalJson(subject.ipcSocketIdentity) !== canonicalJson(checkpointAuthority.ipcSocketIdentity) ||
            canonicalJson(subject.writeSessionAuthorityIdentity) !== canonicalJson(checkpointAuthority.writeSessionAuthorityIdentity) ||
            canonicalJson(subject.ipcProbeSemanticIdentity) !== canonicalJson(checkpointAuthority.ipcProbeSemanticIdentity) ||
            canonicalJson(checkpointReceipt.openPreflightReceiptIdentity) !== canonicalJson(preflightReceipt.identity)) throw new FluxError("STORE_CORRUPT", `Flux run ${key} approval subject does not bind its inspection bridge and IPC socket authority`);
          stateIdentity(subject.inspectionBridgeIdentity, `Flux run ${key}.approval.subject.inspectionBridgeIdentity`); stateIdentity(subject.executionBridgeIdentity, `Flux run ${key}.approval.subject.executionBridgeIdentity`); stateIdentity(subject.ipcSocketIdentity, `Flux run ${key}.approval.subject.ipcSocketIdentity`); stateIdentity(subject.writeSessionAuthorityIdentity, `Flux run ${key}.approval.subject.writeSessionAuthorityIdentity`); stateIdentity(subject.ipcProbeSemanticIdentity, `Flux run ${key}.approval.subject.ipcProbeSemanticIdentity`);
          if (currentSubject || preparedSourceSubject || semanticSubject) {
            const preparation = run.freshNetClassPreparationEvidence === undefined ? undefined : parseFreshNetClassPreparationEvidence(run.freshNetClassPreparationEvidence);
            const semanticIdentity = subjectWorkflow === "generic" ? preparation?.semanticAuthorityIdentity : null;
            if ((subjectWorkflow === "generic" && preparation === undefined) || canonicalJson(subject.freshNetClassSemanticAuthorityIdentity) !== canonicalJson(semanticIdentity) ||
              canonicalJson(preflightAuthority.freshNetClassSemanticAuthorityIdentity) !== canonicalJson(semanticIdentity) || canonicalJson(checkpointAuthority.freshNetClassSemanticAuthorityIdentity) !== canonicalJson(semanticIdentity)) {
              throw new FluxError("STORE_CORRUPT", `Flux run ${key} approval subject does not bind stable fresh net-class semantic authority`);
            }
            if (subject.freshNetClassSemanticAuthorityIdentity !== null) stateIdentity(subject.freshNetClassSemanticAuthorityIdentity, `Flux run ${key}.approval.subject.freshNetClassSemanticAuthorityIdentity`);
          }
          if (currentSubject || preparedSourceSubject) {
            const preparedSource = run.freshProjectOpenPreparedSourceAuthority === undefined ? undefined : parseFreshProjectOpenPreparedSourceAuthority(run.freshProjectOpenPreparedSourceAuthority);
            const preparedSourceIdentity = subjectWorkflow === "generic" ? preparedSource?.identity : null;
            if ((subjectWorkflow === "generic" && preparedSource === undefined) || canonicalJson(subject.freshProjectOpenPreparedSourceAuthorityIdentity) !== canonicalJson(preparedSourceIdentity) ||
              canonicalJson(preflightAuthority.freshProjectOpenPreparedSourceAuthorityIdentity) !== canonicalJson(preparedSourceIdentity) || canonicalJson(checkpointAuthority.freshProjectOpenPreparedSourceAuthorityIdentity) !== canonicalJson(preparedSourceIdentity)) {
              throw new FluxError("STORE_CORRUPT", `Flux run ${key} approval subject does not bind lifecycle-owned prepared-source authority`);
            }
            if (subject.freshProjectOpenPreparedSourceAuthorityIdentity !== null) stateIdentity(subject.freshProjectOpenPreparedSourceAuthorityIdentity, `Flux run ${key}.approval.subject.freshProjectOpenPreparedSourceAuthorityIdentity`);
          }
          if (currentSubject) {
            const preparation = run.freshNetClassPreparationEvidence === undefined ? undefined : parseFreshNetClassPreparationEvidence(run.freshNetClassPreparationEvidence);
            const preparationIdentity = subjectWorkflow === "generic" ? preparation?.identity : null;
            if ((subjectWorkflow === "generic" && (preparation === undefined || run.freshNetClassSemanticAuthority === undefined)) || canonicalJson(subject.freshNetClassPreparationEvidenceIdentity) !== canonicalJson(preparationIdentity) ||
              canonicalJson(preflightAuthority.freshNetClassPreparationEvidenceIdentity) !== canonicalJson(preparationIdentity) || canonicalJson(checkpointAuthority.freshNetClassPreparationEvidenceIdentity) !== canonicalJson(preparationIdentity)) {
              throw new FluxError("STORE_CORRUPT", `Flux run ${key} approval subject does not bind its exact preparation evidence identity`);
            }
            if (subject.freshNetClassPreparationEvidenceIdentity !== null) stateIdentity(subject.freshNetClassPreparationEvidenceIdentity, `Flux run ${key}.approval.subject.freshNetClassPreparationEvidenceIdentity`);
          }
        }
        if (subjectWorkflow === "generic") {
          try { parsePcbDesignCompilationBundleRef(subject.compilationBundleRef); } catch { throw new FluxError("STORE_CORRUPT", `Flux run ${key} approval bundle reference is invalid`); }
          stateRecord(subject.providerProfile, `Flux run ${key}.approval.subject.providerProfile`);
        } else if (subjectWorkflow !== "led_compatibility_fixture" || subject.compilationBundleRef !== null || subject.providerProfile !== null) throw new FluxError("STORE_CORRUPT", `Flux run ${key} approval workflow binding is invalid`);
      } else if (subjectWorkflow === undefined && TERMINAL_PHASES_FOR_STORE.has(String(run.phase))) {
        exactStateKeys(subject, ["runId", "sourceFingerprint", "isolatedFingerprint", "prompt", "providerModel", "iterationCap", "harnessRuleIdentity", "mutationAllowlist", "freshAcceptanceProfileIdentity", "freshPersistenceProfileIdentity", "contractIdentity", "libraryBindingIdentity", "deepRuleBindingIdentity", "acceptancePlanIdentity"], [], `Flux run ${key}.legacy approval.subject`);
        if (subject.runId !== key) throw new FluxError("STORE_CORRUPT", `Flux run ${key} legacy approval subject does not bind its run`);
      } else {
        exactStateKeys(subject, subjectWorkflow === "generic"
          ? [...subjectBase, "compilationBundleRef", "providerProfile", "bundleIdentity", "compilerProfileIdentity", "practiceProfileBindingIdentity", "executionPromptIdentity", "executionPromptContentIdentity"]
          : [...subjectBase, "compilationBundleRef", "providerProfile"], [], `Flux run ${key}.approval.subject`);
        if (subject.runId !== key || subject.sourceKey !== sourceKey || subjectWorkflow !== run.workflowKind || subject.sourceFingerprint !== run.sourceFingerprint || subject.isolatedFingerprint !== run.isolatedFingerprint) throw new FluxError("STORE_CORRUPT", `Flux run ${key} approval subject does not bind its run`);
        if (subjectWorkflow === "generic") {
          try { parsePcbDesignCompilationBundleRef(subject.compilationBundleRef); } catch { throw new FluxError("STORE_CORRUPT", `Flux run ${key} approval bundle reference is invalid`); }
          stateRecord(subject.providerProfile, `Flux run ${key}.approval.subject.providerProfile`);
        } else if (subjectWorkflow !== "led_compatibility_fixture" || subject.compilationBundleRef !== null || subject.providerProfile !== null) throw new FluxError("STORE_CORRUPT", `Flux run ${key} approval workflow binding is invalid`);
      }
      assertNoPrivateStateFields(subject, `Flux run ${key}.approval.subject`);
    }
    if (run.inFlightOperation !== undefined) {
      const intent = stateRecord(run.inFlightOperation, `Flux run ${key}.inFlightOperation`);
      exactStateKeys(intent, ["schemaVersion", "operation", "requestDigest", "authorityDigest", "priorPhase", "startedAt"], ["openPreflightReceipt"], `Flux run ${key}.inFlightOperation`);
      const v1 = intent.schemaVersion === "evleda.flux-operation-intent.v1" && intent.openPreflightReceipt === undefined;
      const v2Open = intent.schemaVersion === "evleda.flux-operation-intent.v2" && intent.operation === "open_project" && intent.openPreflightReceipt !== undefined;
      if ((!v1 && !v2Open) || !["interpret_run", "clarify_run", "prepare_run", "open_project", "checkpoint_open", "resume_run"].includes(String(intent.operation)) || !HEX_64.test(String(intent.requestDigest)) || !HEX_64.test(String(intent.authorityDigest)) || !RUN_PHASES.has(String(intent.priorPhase))) throw new FluxError("STORE_CORRUPT", `Flux run ${key} operation intent is invalid`);
      if (v2Open) {
        try {
          const receipt = parseFluxPersistedOpenPreflightReceipt(intent.openPreflightReceipt);
          if (receipt.runId !== key || receipt.projectId !== projectId) throw new Error("cross-reference");
          if (receipt.schemaVersion === "evleda.flux-open-preflight.v4") {
            const preparation = run.freshNetClassPreparationEvidence === undefined ? undefined : parseFreshNetClassPreparationEvidence(run.freshNetClassPreparationEvidence);
            const preparedSource = run.freshProjectOpenPreparedSourceAuthority === undefined ? undefined : parseFreshProjectOpenPreparedSourceAuthority(run.freshProjectOpenPreparedSourceAuthority);
            const semanticIdentity = run.workflowKind === "generic" ? preparation?.semanticAuthorityIdentity : null;
            const preparedSourceIdentity = run.workflowKind === "generic" ? preparedSource?.identity : null;
            if ((run.workflowKind === "generic" && (preparation === undefined || preparedSource === undefined)) ||
              canonicalJson(receipt.freshNetClassSemanticAuthorityIdentity) !== canonicalJson(semanticIdentity) || canonicalJson(receipt.freshProjectOpenPreparedSourceAuthorityIdentity) !== canonicalJson(preparedSourceIdentity)) throw new Error("authority");
          }
          if (receipt.schemaVersion === "evleda.flux-open-preflight.v5") {
            const preparation = run.freshNetClassPreparationEvidence === undefined ? undefined : parseFreshNetClassPreparationEvidence(run.freshNetClassPreparationEvidence);
            const preparedSource = run.freshProjectOpenPreparedSourceAuthority === undefined ? undefined : parseFreshProjectOpenPreparedSourceAuthority(run.freshProjectOpenPreparedSourceAuthority);
            const semantic = run.freshNetClassSemanticAuthority === undefined ? undefined : parseFreshNetClassSemanticAuthority(run.freshNetClassSemanticAuthority);
            const semanticIdentity = run.workflowKind === "generic" ? preparation?.semanticAuthorityIdentity : null; const preparationIdentity = run.workflowKind === "generic" ? preparation?.identity : null;
            const preparedSourceIdentity = run.workflowKind === "generic" ? preparedSource?.identity : null;
            if ((run.workflowKind === "generic" && (preparation === undefined || semantic === undefined || preparedSource === undefined)) || canonicalJson(receipt.freshNetClassSemanticAuthorityIdentity) !== canonicalJson(semanticIdentity) ||
              canonicalJson(receipt.freshNetClassPreparationEvidenceIdentity) !== canonicalJson(preparationIdentity) || canonicalJson(receipt.freshProjectOpenPreparedSourceAuthorityIdentity) !== canonicalJson(preparedSourceIdentity)) throw new Error("authority");
          }
        } catch { throw new FluxError("STORE_CORRUPT", `Flux run ${key} Open preflight receipt is invalid`); }
      }
      stateTime(intent.startedAt, `Flux run ${key}.inFlightOperation.startedAt`);
    }
    const phaseOperation = run.phase === "interpreting" ? new Set(["interpret_run", "clarify_run"])
      : run.phase === "preparing" ? new Set(["prepare_run"])
        : run.phase === "opening" ? new Set(["open_project"])
          : run.phase === "checkpointing" ? new Set(["checkpoint_open"])
            : run.phase === "queued" || run.phase === "running" ? new Set(["resume_run"])
              : undefined;
    if (phaseOperation !== undefined && (run.inFlightOperation === undefined || !phaseOperation.has(String((run.inFlightOperation as Record<string, unknown>).operation)))) throw new FluxError("STORE_CORRUPT", `Flux run ${key} active phase lacks its matching operation intent`);
    if (phaseOperation === undefined && run.inFlightOperation !== undefined && !TERMINAL_PHASES_FOR_STORE.has(String(run.phase))) throw new FluxError("STORE_CORRUPT", `Flux run ${key} has an operation intent outside an active or terminal phase`);
    stateTime(run.createdAt, `Flux run ${key}.createdAt`); stateTime(run.updatedAt, `Flux run ${key}.updatedAt`);
  }
  const reports = stateMap(state.reports, "Flux reports");
  for (const [key, item] of Object.entries(reports)) {
    stateId(key, "Flux report map key"); assertMetadata(item, `Flux report ${key}`, true);
    const report = item as Record<string, unknown>;
    if (report.reportId !== key || runs[String(report.runId)] === undefined) throw new FluxError("STORE_CORRUPT", `Flux report ${key} has invalid cross-references`);
    if (report.executionBridgeIdentity !== undefined) {
      const run = stateRecord(runs[String(report.runId)], `Flux report ${key} run`); const checkpoint = run.openCheckpointReceipt === undefined ? undefined : parseFluxPersistedOpenCheckpointReceipt(run.openCheckpointReceipt);
      const approval = run.approval === undefined ? undefined : stateRecord(run.approval, `Flux report ${key} approval`); const subject = approval === undefined ? undefined : stateRecord(approval.subject, `Flux report ${key} approval subject`);
      const checkpointAuthority = checkpoint as unknown as Record<string, unknown> | undefined;
      const currentVersion = checkpoint?.schemaVersion === "evleda.flux-open-checkpoint.v6" && subject?.schemaVersion === "evleda.flux-approval-subject.v6";
      const readableLegacyVersion = run.phase === "needs_review" && ((checkpoint?.schemaVersion === "evleda.flux-open-checkpoint.v5" && subject?.schemaVersion === "evleda.flux-approval-subject.v5") ||
        (checkpoint?.schemaVersion === "evleda.flux-open-checkpoint.v4" && subject?.schemaVersion === "evleda.flux-approval-subject.v4") || (checkpoint?.schemaVersion === "evleda.flux-open-checkpoint.v3" && subject?.schemaVersion === "evleda.flux-approval-subject.v3"));
      if ((!currentVersion && !readableLegacyVersion) || canonicalJson(report.executionBridgeIdentity) !== canonicalJson(checkpointAuthority?.executionBridgeIdentity) || canonicalJson(report.executionBridgeIdentity) !== canonicalJson(subject?.executionBridgeIdentity) ||
        canonicalJson(report.writeSessionAuthorityIdentity) !== canonicalJson(checkpointAuthority?.writeSessionAuthorityIdentity) || canonicalJson(report.writeSessionAuthorityIdentity) !== canonicalJson(subject?.writeSessionAuthorityIdentity)) {
        throw new FluxError("STORE_CORRUPT", `Flux report ${key} does not bind its approved write-session authority`);
      }
    }
  }
  for (const [runId, item] of Object.entries(runs)) {
    const run = item as Record<string, unknown>; const reportList = run.reports as unknown[];
    for (const report of reportList) {
      assertMetadata(report, `Flux run ${runId} report`, false); const reportId = (report as Record<string, unknown>).reportId as string;
      const persisted = reports[reportId] as Record<string, unknown> | undefined;
      if (persisted?.runId !== runId) throw new FluxError("STORE_CORRUPT", `Flux run ${runId} report cross-reference is invalid`);
      const { runId: _persistedRunId, body: _body, ...persistedMetadata } = persisted;
      if (canonicalJson(persistedMetadata) !== canonicalJson(report)) throw new FluxError("STORE_CORRUPT", `Flux run ${runId} report metadata does not match its persisted report`);
    }
    if (run.workflowKind === "generic" && run.phase === "completed") {
      const preparation = run.freshNetClassPreparationEvidence === undefined ? undefined : parseFreshNetClassPreparationEvidence(run.freshNetClassPreparationEvidence);
      const semantic = run.freshNetClassSemanticAuthority === undefined ? undefined : parseCurrentFreshNetClassSemanticAuthority(run.freshNetClassSemanticAuthority);
      const preparedSource = run.freshProjectOpenPreparedSourceAuthority === undefined ? undefined : parseFreshProjectOpenPreparedSourceAuthority(run.freshProjectOpenPreparedSourceAuthority);
      let terminalReceipt;
      try { terminalReceipt = run.freshClearanceEvidenceReceipt === undefined || semantic === undefined ? undefined : verifyFreshClearanceEvidenceReceiptAgainstSemanticAuthority(run.freshClearanceEvidenceReceipt, semantic); }
      catch { throw new FluxError("STORE_CORRUPT", `Flux generic completed run ${runId} terminal clearance receipt does not match its full semantic authority`); }
      const approval = run.approval === undefined ? undefined : stateRecord(run.approval, `Flux generic completed run ${runId} approval`); const subject = approval === undefined ? undefined : stateRecord(approval.subject, `Flux generic completed run ${runId} approval subject`);
      const bundleReference = run.compilationBundleRef === undefined ? undefined : parsePcbDesignCompilationBundleRef(run.compilationBundleRef);
      const contractState = run.contractState === undefined ? undefined : stateRecord(run.contractState, `Flux generic completed run ${runId} contract state`);
      if (preparation === undefined || semantic === undefined || preparedSource === undefined || terminalReceipt === undefined || subject?.schemaVersion !== "evleda.flux-approval-subject.v6" || reportList.length === 0 ||
        bundleReference === undefined || contractState?.contractIdentity === null || contractState?.contractIdentity === undefined || canonicalJson(preparation.bundleIdentity) !== canonicalJson(bundleReference.bundleIdentity) ||
        canonicalJson(preparation.contractIdentity) !== canonicalJson(contractState.contractIdentity) || canonicalJson(subject.compilationBundleRef) !== canonicalJson(bundleReference) ||
        canonicalJson(preparation.identity) !== canonicalJson(subject.freshNetClassPreparationEvidenceIdentity) || canonicalJson(preparation.semanticAuthorityIdentity) !== canonicalJson(semantic.identity) ||
        canonicalJson(preparation.freshMarkerContentIdentity) !== canonicalJson(preparedSource.marker) ||
        canonicalJson(terminalReceipt.bundleIdentity) !== canonicalJson(preparation.bundleIdentity) || canonicalJson(terminalReceipt.bundleIdentity) !== canonicalJson(subject.bundleIdentity) ||
        canonicalJson(terminalReceipt.contractIdentity) !== canonicalJson(preparation.contractIdentity) || canonicalJson(terminalReceipt.contractIdentity) !== canonicalJson(subject.contractIdentity) ||
        canonicalJson(terminalReceipt.genericProjectBindingIdentity) !== canonicalJson(preparation.genericProjectBindingIdentity) ||
        canonicalJson(terminalReceipt.freshMarkerContentIdentity) !== canonicalJson(preparation.freshMarkerContentIdentity) || canonicalJson(terminalReceipt.kicad) !== canonicalJson(preparation.kicad)) {
        throw new FluxError("STORE_CORRUPT", `Flux generic completed run ${runId} lacks or mismatches its stable preparation, approval, and terminal clearance receipt authority`);
      }
      for (const report of reportList) {
        if (stateRecord(subject.acceptancePlanIdentity, "Completed approval acceptance plan").schemaVersion === "evleda.pcb-acceptance-plan.v2") {
          const acceptance = stateRecord((report as Record<string, unknown>).freshAcceptance, "Current completed acceptance");
          const ink = Array.isArray(acceptance.requirements) ? acceptance.requirements.filter((entry) => stateRecord(entry, "Current completed requirement").id === "schematic-render-clearance") : [];
          if (acceptance.passed !== true || !Array.isArray(acceptance.missing) || acceptance.missing.length !== 0 || ink.length !== 1 || stateRecord(ink[0], "Current completed ink requirement").status !== "pass") throw new FluxError("STORE_CORRUPT", `Flux current completed run ${runId} lacks passing schematic ink-clearance acceptance`);
        }
        const bindingValue = (report as Record<string, unknown>).freshClearanceEvidenceBinding;
        if (bindingValue === undefined) throw new FluxError("STORE_CORRUPT", `Flux generic completed run ${runId} lacks its fresh clearance evidence binding`);
        const binding = parseFluxPersistedFreshClearanceEvidenceBinding(bindingValue);
        if (binding.schemaVersion !== "evleda.flux-fresh-clearance-evidence-binding.v2" || canonicalJson(binding.kicad) !== canonicalJson(preparation.kicad) || canonicalJson(binding.kicad) !== canonicalJson(terminalReceipt.kicad) ||
          canonicalJson(binding.materializationIdentity) !== canonicalJson(preparation.materializationIdentity) || canonicalJson(binding.semanticAuthorityIdentity) !== canonicalJson(preparation.semanticAuthorityIdentity) ||
          canonicalJson(binding.semanticAuthorityIdentity) !== canonicalJson(subject.freshNetClassSemanticAuthorityIdentity) || canonicalJson(binding.receiptIdentity) !== canonicalJson(terminalReceipt.identity)) {
          throw new FluxError("STORE_CORRUPT", `Flux generic completed run ${runId} clearance evidence does not bind its approved preparation and terminal receipt authority`);
        }
      }
    }
  }
  const operationFailureEvidence = stateMap(state.operationFailureEvidence, "Flux operation failure evidence");
  if (Object.keys(operationFailureEvidence).length > FLUX_OPERATION_FAILURE_EVIDENCE_MAX_RECORDS) throw new FluxError("STORE_CORRUPT", "Flux operation failure evidence exceeds its state record limit");
  for (const [key, item] of Object.entries(operationFailureEvidence)) {
    if (!HEX_64.test(key)) throw new FluxError("STORE_CORRUPT", "Flux operation failure evidence map contains an invalid key");
    let parsed: FluxOperationFailureEvidence;
    try { parsed = parseFluxOperationFailureEvidence(item); } catch { throw new FluxError("STORE_CORRUPT", `Flux operation failure evidence ${key} is malformed`); }
    if (Buffer.byteLength(canonicalJson(parsed), "utf8") > FLUX_OPERATION_FAILURE_EVIDENCE_MAX_BYTES || fluxOperationFailureEvidenceIdentity(parsed).digest !== key) throw new FluxError("STORE_CORRUPT", `Flux operation failure evidence ${key} identity is invalid`);
  }
  const operationFailureEvidenceReservations = stateMap(state.operationFailureEvidenceReservations, "Flux operation failure evidence reservations");
  if (Object.keys(operationFailureEvidence).length + Object.keys(operationFailureEvidenceReservations).length > FLUX_OPERATION_FAILURE_EVIDENCE_MAX_RECORDS) throw new FluxError("STORE_CORRUPT", "Flux operation failure evidence and reservations exceed their shared state limit");
  for (const [key, item] of Object.entries(operationFailureEvidenceReservations)) {
    if (!HEX_64.test(key)) throw new FluxError("STORE_CORRUPT", "Flux operation failure evidence reservations contain an invalid key");
    const reservation = stateRecord(item, `Flux operation failure evidence reservation ${key}`);
    exactStateKeys(reservation, ["schemaVersion", "runId", "operation", "idempotencyKey", "requestDigest", "providerIdentity", "reservedAt", "identity"], [], `Flux operation failure evidence reservation ${key}`);
    if (reservation.schemaVersion !== FLUX_OPERATION_FAILURE_EVIDENCE_RESERVATION_SCHEMA_VERSION || !["interpret_run", "clarify_run"].includes(String(reservation.operation)) ||
      (reservation.idempotencyKey !== null && (typeof reservation.idempotencyKey !== "string" || !SAFE_IDEMPOTENCY_KEY.test(reservation.idempotencyKey))) ||
      !HEX_64.test(stateText(reservation.requestDigest, `Flux operation failure evidence reservation ${key}.requestDigest`, 64))) throw new FluxError("STORE_CORRUPT", `Flux operation failure evidence reservation ${key} is invalid`);
    stateId(reservation.runId, `Flux operation failure evidence reservation ${key}.runId`); stateTime(reservation.reservedAt, `Flux operation failure evidence reservation ${key}.reservedAt`);
    stateIdentity(reservation.providerIdentity, `Flux operation failure evidence reservation ${key}.providerIdentity`);
    const identity = stateIdentity(reservation.identity, `Flux operation failure evidence reservation ${key}.identity`); const { identity: _identity, ...payload } = reservation;
    if (identity.digest !== key || canonicalJson(identity) !== canonicalJson(canonicalIdentity(payload, FLUX_OPERATION_FAILURE_EVIDENCE_RESERVATION_SCHEMA_VERSION))) throw new FluxError("STORE_CORRUPT", `Flux operation failure evidence reservation ${key} identity is invalid`);
  }
  const idempotency = stateMap(state.idempotency, "Flux idempotency");
  for (const [key, item] of Object.entries(idempotency)) {
    stateId(key, "Flux idempotency key", SAFE_IDEMPOTENCY_KEY); const receipt = stateRecord(item, `Flux idempotency ${key}`);
    exactStateKeys(receipt, ["operation", "digest", "resultId", "runId", "status", "startedAt"], ["completedAt", "result", "failure", "terminalReceipt", "openPreflightReceipt", "openPreflightFailure", "openPreflightUncertain"], `Flux idempotency ${key}`);
    const operation = stateText(receipt.operation, `Flux idempotency ${key}.operation`, 128);
    if (!["create_project", "create_thread", "create_run", "interpret_run", "clarify_run", "prepare_run", "open_project", "checkpoint_open", "approve_run", "resume_run"].includes(operation)) throw new FluxError("STORE_CORRUPT", `Flux idempotency ${key} operation is invalid`);
    if (!HEX_64.test(stateText(receipt.digest, `Flux idempotency ${key}.digest`, 64))) throw new FluxError("STORE_CORRUPT", `Flux idempotency ${key} digest is invalid`);
    const resultId = stateId(receipt.resultId, `Flux idempotency ${key}.resultId`); const receiptRunId = stateId(receipt.runId, `Flux idempotency ${key}.runId`);
    if (resultId !== receiptRunId || (operation === "create_project" ? projects[resultId] : operation === "create_thread" ? threads[resultId] : runs[resultId]) === undefined) throw new FluxError("STORE_CORRUPT", `Flux idempotency ${key} result reference is invalid`);
    stateTime(receipt.startedAt, `Flux idempotency ${key}.startedAt`);
    if (!["pending", "completed", "failed", "preflight_failed", "preflight_uncertain", "authority_invalidated"].includes(String(receipt.status))) throw new FluxError("STORE_CORRUPT", `Flux idempotency ${key} status is invalid`);
    if (receipt.completedAt !== undefined) stateTime(receipt.completedAt, `Flux idempotency ${key}.completedAt`);
    if (receipt.terminalReceipt !== undefined) {
      const terminal = stateRecord(receipt.terminalReceipt, `Flux idempotency ${key}.terminalReceipt`); exactStateKeys(terminal, ["outcome", "at"], [], `Flux idempotency ${key}.terminalReceipt`);
      if (!["succeeded", "failed"].includes(String(terminal.outcome))) throw new FluxError("STORE_CORRUPT", `Flux idempotency ${key} terminal outcome is invalid`); stateTime(terminal.at, `Flux idempotency ${key}.terminalReceipt.at`);
    }
    if (receipt.failure !== undefined) {
      if (typeof receipt.completedAt !== "string") throw new FluxError("STORE_CORRUPT", `Flux idempotency ${key} failure has no completion time`);
      const failure = stateRecord(receipt.failure, `Flux idempotency ${key}.failure`); exactStateKeys(failure, ["code", "message", "details", "identity"], ["diagnostic"], `Flux idempotency ${key}.failure`);
      if (!["INVALID_ARGUMENT", "NOT_FOUND", "ILLEGAL_TRANSITION", "APPROVAL_MISMATCH", "APPROVAL_CONSUMED", "IDEMPOTENCY_CONFLICT", "OPERATION_UNCERTAIN", "OPEN_PREFLIGHT_FAILED", "EVIDENCE_CAPACITY", "PATH_POLICY", "STORE_CORRUPT"].includes(String(failure.code)) || !stateText(failure.message, `Flux idempotency ${key}.failure.message`, 64 * 1024).trim()) throw new FluxError("STORE_CORRUPT", `Flux idempotency ${key} failure is invalid`);
      assertNoPrivateStateFields(stateRecord(failure.details, `Flux idempotency ${key}.failure.details`), `Flux idempotency ${key}.failure.details`);
      if (failure.diagnostic !== undefined) { try { parseFluxDiagnostic(failure.diagnostic); } catch { throw new FluxError("STORE_CORRUPT", `Flux idempotency ${key} failure diagnostic is invalid`); } }
      const failurePayload = { code: failure.code, message: failure.message, details: failure.details,
        ...(failure.diagnostic === undefined ? {} : { diagnostic: failure.diagnostic }) };
      const identityPayload = { operation, requestDigest: receipt.digest, resultId, runId: receiptRunId, startedAt: receipt.startedAt,
        completedAt: receipt.completedAt, ...failurePayload };
      if (canonicalJson(failure.identity) !== canonicalJson(canonicalIdentity(identityPayload, FLUX_OPERATION_FAILURE_SCHEMA_VERSION))) throw new FluxError("STORE_CORRUPT", `Flux idempotency ${key} failure identity is invalid`);
    }
    if (receipt.openPreflightReceipt !== undefined) { try { parseFluxPersistedOpenPreflightReceipt(receipt.openPreflightReceipt); } catch { throw new FluxError("STORE_CORRUPT", `Flux idempotency ${key} Open preflight receipt is invalid`); } }
    if (receipt.openPreflightFailure !== undefined) { try { parseFluxOpenPreflightFailureReceipt(receipt.openPreflightFailure); } catch { throw new FluxError("STORE_CORRUPT", `Flux idempotency ${key} Open preflight failure is invalid`); } }
    if (receipt.openPreflightUncertain !== undefined) { try { parseFluxOpenPreflightUncertainReceipt(receipt.openPreflightUncertain); } catch { throw new FluxError("STORE_CORRUPT", `Flux idempotency ${key} Open preflight uncertainty is invalid`); } }
    if (receipt.status === "completed" && (receipt.result === undefined || receipt.failure !== undefined || receipt.openPreflightReceipt !== undefined || receipt.openPreflightFailure !== undefined || receipt.openPreflightUncertain !== undefined || receipt.completedAt === undefined || (receipt.terminalReceipt as Record<string, unknown> | undefined)?.outcome !== "succeeded")) throw new FluxError("STORE_CORRUPT", `Flux idempotency ${key} completed receipt is incomplete`);
    if (receipt.status === "failed" && (receipt.result !== undefined || receipt.failure === undefined || receipt.openPreflightReceipt !== undefined || receipt.openPreflightFailure !== undefined || receipt.openPreflightUncertain !== undefined || receipt.completedAt === undefined || (receipt.terminalReceipt as Record<string, unknown> | undefined)?.outcome !== "failed")) throw new FluxError("STORE_CORRUPT", `Flux idempotency ${key} failed receipt is incomplete`);
    if (receipt.status === "authority_invalidated" && (!["open_project", "checkpoint_open", "approve_run"].includes(operation) || receipt.result === undefined || receipt.failure !== undefined || receipt.openPreflightReceipt !== undefined || receipt.openPreflightFailure !== undefined || receipt.openPreflightUncertain !== undefined || receipt.completedAt === undefined || (receipt.terminalReceipt as Record<string, unknown> | undefined)?.outcome !== "succeeded")) throw new FluxError("STORE_CORRUPT", `Flux idempotency ${key} invalidated authority receipt is incomplete`);
    if (receipt.status === "preflight_failed") {
      const preflightFailure = receipt.openPreflightFailure as Record<string, unknown> | undefined;
      if (operation !== "open_project" || receipt.result !== undefined || receipt.failure !== undefined || receipt.openPreflightReceipt !== undefined || receipt.openPreflightUncertain !== undefined || receipt.terminalReceipt !== undefined || receipt.completedAt === undefined || preflightFailure === undefined ||
        preflightFailure.requestDigest !== receipt.digest || preflightFailure.runId !== receiptRunId || preflightFailure.failedAt !== receipt.completedAt || Date.parse(String(receipt.startedAt)) > Date.parse(String(receipt.completedAt))) throw new FluxError("STORE_CORRUPT", `Flux idempotency ${key} Open preflight failure is not bound to its request`);
    }
    if (receipt.status === "preflight_uncertain") {
      const uncertainty = receipt.openPreflightUncertain as Record<string, unknown> | undefined; const blockedRun = stateRecord(runs[receiptRunId], `Flux idempotency ${key} uncertain run`);
      if (operation !== "open_project" || receipt.result !== undefined || receipt.failure !== undefined || receipt.openPreflightReceipt !== undefined || receipt.openPreflightFailure !== undefined || receipt.terminalReceipt !== undefined ||
        receipt.completedAt === undefined || uncertainty === undefined || uncertainty.requestDigest !== receipt.digest || uncertainty.runId !== receiptRunId || uncertainty.blockedAt !== receipt.completedAt ||
        receipt.startedAt !== receipt.completedAt || blockedRun.phase !== "blocked" || blockedRun.blockedReason !== FLUX_OPEN_PREFLIGHT_UNCERTAIN_MESSAGE || blockedRun.updatedAt !== receipt.completedAt || blockedRun.inFlightOperation !== undefined) {
        throw new FluxError("STORE_CORRUPT", `Flux idempotency ${key} Open preflight uncertainty is not bound to its blocked run`);
      }
    }
    if (receipt.status === "pending") {
      const run = runs[receiptRunId] as Record<string, unknown>; const intent = run.inFlightOperation as Record<string, unknown> | undefined;
      const legacyOpen = operation === "open_project" && intent?.schemaVersion === "evleda.flux-operation-intent.v1";
      const currentOpen = operation === "open_project" && intent?.schemaVersion === "evleda.flux-operation-intent.v2" && receipt.openPreflightReceipt !== undefined && canonicalJson(intent.openPreflightReceipt) === canonicalJson(receipt.openPreflightReceipt);
      if (receipt.completedAt !== undefined || receipt.result !== undefined || receipt.failure !== undefined || receipt.openPreflightFailure !== undefined || receipt.openPreflightUncertain !== undefined || receipt.terminalReceipt !== undefined ||
        (operation === "open_project" ? (!legacyOpen && !currentOpen) : receipt.openPreflightReceipt !== undefined)) throw new FluxError("STORE_CORRUPT", `Flux idempotency ${key} pending receipt contains invalid lifecycle fields`);
    }
    if (receipt.status === "failed") {
      const failedRun = stateRecord(runs[receiptRunId], `Flux idempotency ${key} failed run`);
      const failure = stateRecord(receipt.failure, `Flux idempotency ${key}.failure`);
      const terminal = stateRecord(receipt.terminalReceipt, `Flux idempotency ${key}.terminalReceipt`);
      if (operation === "checkpoint_open") {
        const retainedTerminalEvents = state.events.filter((entry) => entry.runId === receiptRunId && entry.kind === "run_blocked");
        if (failure.code !== "OPERATION_UNCERTAIN" || ![FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE, FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE].includes(String(failure.message)) || Object.keys(stateRecord(failure.details, `Flux idempotency ${key}.failure.details`)).length !== 0 ||
          failure.diagnostic !== undefined || failedRun.phase !== "blocked" || failedRun.checkpointRequired !== true || failedRun.blockedReason !== failure.message || failedRun.updatedAt !== receipt.completedAt || terminal.at !== receipt.completedAt ||
          receipt.digest !== fluxDigest({ runId: receiptRunId }) || retainedTerminalEvents.length > 1 || retainedTerminalEvents.some((entry) => entry.diagnostic !== undefined) ||
          failedRun.inFlightOperation !== undefined || failedRun.openCheckpointReceipt !== undefined || failedRun.approval !== undefined || Date.parse(String(receipt.startedAt)) > Date.parse(String(receipt.completedAt))) {
          throw new FluxError("STORE_CORRUPT", `Flux idempotency ${key} failed checkpoint receipt is not bound to its uncertain terminal run`);
        }
      } else {
        const sameDiagnostic = failure.diagnostic === undefined
          ? failedRun.diagnostic === undefined
          : failedRun.diagnostic !== undefined && canonicalJson(parseFluxDiagnostic(failure.diagnostic)) === canonicalJson(parseFluxDiagnostic(failedRun.diagnostic));
        const retainedTerminalEvents = state.events.filter((entry) => entry.runId === receiptRunId && entry.kind === "run_blocked" && entry.detail === "Generic contract interpretation failed closed.");
        const retainedEventsBound = retainedTerminalEvents.length <= 1 && (retainedTerminalEvents.length === 0 || retainedTerminalEvents.some((entry) => failure.diagnostic === undefined
          ? entry.diagnostic === undefined
          : entry.diagnostic !== undefined && canonicalJson(parseFluxDiagnostic(entry.diagnostic)) === canonicalJson(parseFluxDiagnostic(failure.diagnostic))));
        const diagnostic = parseFluxDiagnostic(failure.diagnostic); const evidence = operationFailureEvidence[diagnostic.evidenceIdentity.digest];
        const evidenceValid = evidence !== undefined && operationEvidenceMatchesDiagnostic(evidence, diagnostic);
        if (!["interpret_run", "clarify_run"].includes(operation) || failedRun.workflowKind !== "generic" || failedRun.phase !== "blocked" ||
          failedRun.inFlightOperation !== undefined || failedRun.operationFailureEvidenceReservationRef !== undefined || failedRun.blockedReason !== failure.message || failedRun.updatedAt !== receipt.completedAt || terminal.at !== receipt.completedAt ||
          failedRun.contractState !== undefined || failedRun.compilationBundleRef !== undefined || failedRun.approval !== undefined || failedRun.isolatedFingerprint !== undefined ||
          failedRun.preview !== undefined || failedRun.checkpointRequired !== undefined || !sameDiagnostic || !retainedEventsBound || !evidenceValid || Date.parse(String(receipt.startedAt)) > Date.parse(String(receipt.completedAt))) {
          throw new FluxError("STORE_CORRUPT", `Flux idempotency ${key} failed receipt is not semantically bound to its terminal run`);
        }
      }
    }
    if (receipt.result !== undefined) assertNoPrivateStateFields(receipt.result, `Flux idempotency ${key}.result`);
  }
  for (const [index, item] of state.events.entries()) {
    const record = stateRecord(item, `Flux event ${index}`); exactStateKeys(record, ["id", "eventSeq", "kind", "at", "detail"], ["runId", "diagnostic"], `Flux event ${index}`);
    stateId(record.id, `Flux event ${index}.id`); if (!EVENT_KINDS.has(String(record.kind))) throw new FluxError("STORE_CORRUPT", `Flux event ${index} kind is invalid`);
    stateTime(record.at, `Flux event ${index}.at`); stateText(record.detail, `Flux event ${index}.detail`, 64 * 1024);
    if (record.runId !== undefined && runs[stateId(record.runId, `Flux event ${index}.runId`)] === undefined) throw new FluxError("STORE_CORRUPT", `Flux event ${index} run reference is invalid`);
    if (record.diagnostic !== undefined) { try { parseFluxDiagnostic(record.diagnostic); } catch { throw new FluxError("STORE_CORRUPT", `Flux event ${index} diagnostic is invalid`); } }
  }
  for (const [runId, item] of Object.entries(runs)) {
    const run = item as Record<string, unknown>;
    if (run.phase === "blocked" && run.diagnostic !== undefined) {
      const diagnostic = parseFluxDiagnostic(run.diagnostic); const evidence = operationFailureEvidence[diagnostic.evidenceIdentity.digest];
      if (evidence === undefined || !operationEvidenceMatchesDiagnostic(evidence, diagnostic)) throw new FluxError("STORE_CORRUPT", `Flux run ${runId} operation failure evidence is missing or invalid`);
    }
  }
  const boundReservations = new Set<string>();
  for (const [runId, item] of Object.entries(runs)) {
    const run = item as Record<string, unknown>; const intent = run.inFlightOperation as Record<string, unknown> | undefined;
    const reservationRefValue = run.operationFailureEvidenceReservationRef;
    const interpretingOperation = intent !== undefined && ["interpret_run", "clarify_run"].includes(String(intent.operation));
    if (reservationRefValue === undefined) {
      if (["interpreting", "blocked"].includes(String(run.phase)) && interpretingOperation) throw new FluxError("STORE_CORRUPT", `Flux run ${runId} is missing its provider failure evidence reservation`);
      continue;
    }
    const reservationRef = stateIdentity(reservationRefValue, `Flux run ${runId}.operationFailureEvidenceReservationRef`);
    const reservation = operationFailureEvidenceReservations[reservationRef.digest] as Record<string, unknown> | undefined;
    if (reservation === undefined || !["interpreting", "blocked"].includes(String(run.phase)) || !interpretingOperation || reservation.runId !== runId ||
      reservation.operation !== intent!.operation || reservation.requestDigest !== intent!.requestDigest || reservation.reservedAt !== intent!.startedAt ||
      canonicalJson(reservation.identity) !== canonicalJson(reservationRef) || canonicalJson(reservation.providerIdentity) !== canonicalJson(canonicalIdentity({ providerModel: run.providerModel }, FLUX_OPERATION_FAILURE_EVIDENCE_RESERVATION_PROVIDER_SCHEMA_VERSION))) {
      throw new FluxError("STORE_CORRUPT", `Flux run ${runId} provider failure evidence reservation is not bound to its pending operation`);
    }
    if (reservation.idempotencyKey !== null) {
      const boundReceipt = idempotency[String(reservation.idempotencyKey)] as Record<string, unknown> | undefined;
      if (boundReceipt === undefined || boundReceipt.status !== "pending" || boundReceipt.runId !== runId || boundReceipt.operation !== reservation.operation || boundReceipt.digest !== reservation.requestDigest) throw new FluxError("STORE_CORRUPT", `Flux run ${runId} provider failure evidence reservation is not bound to its idempotency receipt`);
    }
    boundReservations.add(reservationRef.digest);
  }
  if (Object.keys(operationFailureEvidenceReservations).some((digest) => !boundReservations.has(digest))) throw new FluxError("STORE_CORRUPT", "Flux operation failure evidence reservations contain an unbound record");
  const evidenceByRun = new Map<string, Set<string>>();
  const referencedEvidence = new Set<string>();
  const bindEvidence = (runId: string, diagnosticValue: unknown, label: string): void => {
    const diagnostic = parseFluxDiagnostic(diagnosticValue); const evidence = operationFailureEvidence[diagnostic.evidenceIdentity.digest];
    if (evidence === undefined) throw new FluxError("STORE_CORRUPT", `${label} is missing its private operation failure evidence`);
    const identity = fluxOperationFailureEvidenceIdentity(parseFluxOperationFailureEvidence(evidence));
    if (canonicalJson(identity) !== canonicalJson(diagnostic.evidenceIdentity) || !operationEvidenceMatchesDiagnostic(evidence, diagnostic)) throw new FluxError("STORE_CORRUPT", `${label} does not bind its private operation failure evidence`);
    referencedEvidence.add(identity.digest);
    const bindings = evidenceByRun.get(runId) ?? new Set<string>(); bindings.add(identity.digest); evidenceByRun.set(runId, bindings);
    if (bindings.size > FLUX_OPERATION_FAILURE_EVIDENCE_MAX_RECORDS_PER_RUN) throw new FluxError("STORE_CORRUPT", `Flux run ${runId} exceeds its operation failure evidence limit`);
  };
  for (const [runId, item] of Object.entries(runs)) {
    const diagnostic = (item as Record<string, unknown>).diagnostic; if (diagnostic !== undefined) bindEvidence(runId, diagnostic, `Flux run ${runId}`);
  }
  for (const [key, item] of Object.entries(idempotency)) {
    const receipt = item as Record<string, unknown>; const failure = receipt.failure as Record<string, unknown> | undefined;
    if (failure?.diagnostic !== undefined) bindEvidence(String(receipt.runId), failure.diagnostic, `Flux idempotency ${key}`);
  }
  for (const [index, item] of state.events.entries()) if (item.runId !== undefined && item.diagnostic !== undefined) bindEvidence(item.runId, item.diagnostic, `Flux event ${index}`);
  if (Object.keys(operationFailureEvidence).some((digest) => !referencedEvidence.has(digest))) throw new FluxError("STORE_CORRUPT", "Flux operation failure evidence contains an unbound record");
}

const empty = (): FluxPersistedState => freeze({ schemaVersion: FLUX_STATE_SCHEMA_VERSION, revision: 0, sources: {}, projects: {}, threads: {}, runs: {}, reports: {}, operationFailureEvidence: {}, operationFailureEvidenceReservations: {}, idempotency: {}, events: [], nextEventSeq: 1 });

const migrateState = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const state = value as Record<string, unknown>;
  const inputSchemaVersion = state.schemaVersion;
  const isLegacyState = inputSchemaVersion === "evleda.flux.v1" || inputSchemaVersion === "evleda.flux.v2";
  const isV3State = inputSchemaVersion === "evleda.flux.v3";
  const isV4State = inputSchemaVersion === "evleda.flux.v4";
  const isV5State = inputSchemaVersion === "evleda.flux.v5";
  const isV6State = inputSchemaVersion === "evleda.flux.v6";
  const isV7State = inputSchemaVersion === "evleda.flux.v7";
  const isV8State = inputSchemaVersion === "evleda.flux.v8";
  const isV9State = inputSchemaVersion === "evleda.flux.v9";
  const hasV4NestedFields = (typeof state.runs === "object" && state.runs !== null && !Array.isArray(state.runs) && Object.values(state.runs as Record<string, unknown>).some((item) =>
    typeof item === "object" && item !== null && !Array.isArray(item) && (Object.hasOwn(item, "operationFailureEvidenceReservationRef") || Object.hasOwn(item, "providerFailureEvidenceReservationRef") || Object.hasOwn(item, "providerFailureEvidenceDisposition")))) ||
    (typeof state.idempotency === "object" && state.idempotency !== null && !Array.isArray(state.idempotency) && Object.values(state.idempotency as Record<string, unknown>).some((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return false; const failure = (item as Record<string, unknown>).failure;
      return typeof failure === "object" && failure !== null && !Array.isArray(failure) && Object.hasOwn(failure, "providerFailureEvidenceDisposition");
    }));
  const canMigrateVersion = (isLegacyState || isV3State) && !Object.hasOwn(state, "operationFailureEvidence") && !Object.hasOwn(state, "operationFailureEvidenceReservations") && !Object.hasOwn(state, "providerFailureEvidence") && !Object.hasOwn(state, "providerFailureEvidenceReservations") && !hasV4NestedFields;
  const migrateLegacyState = isLegacyState && canMigrateVersion;
  let migrated: Record<string, unknown> = {
    ...state,
    ...(canMigrateVersion ? { schemaVersion: FLUX_STATE_SCHEMA_VERSION, operationFailureEvidence: {}, operationFailureEvidenceReservations: {} }
      : isV4State || isV5State || isV6State || isV7State || isV8State || isV9State ? { schemaVersion: FLUX_STATE_SCHEMA_VERSION } : {})
  };
  if (migrateLegacyState && Array.isArray(state.events) && state.nextEventSeq === undefined) {
    const events = state.events.map((entry, index) => ({ ...(entry as Record<string, unknown>), eventSeq: index + 1 }));
    migrated = { ...migrated, events, nextEventSeq: events.length + 1 };
  }
  if (migrateLegacyState && typeof state.idempotency === "object" && state.idempotency !== null && !Array.isArray(state.idempotency)) {
    const idempotency = Object.fromEntries(Object.entries(state.idempotency as Record<string, unknown>).map(([key, item]) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return [key, item];
      const record = item as Record<string, unknown>;
      return [key, record.status === undefined ? { ...record, runId: record.resultId, status: "completed", startedAt: "1970-01-01T00:00:00.000Z", completedAt: "1970-01-01T00:00:00.000Z", terminalReceipt: { outcome: "succeeded", at: "1970-01-01T00:00:00.000Z" } } : record];
    }));
    migrated = { ...migrated, idempotency };
  }
  if (migrateLegacyState && typeof state.runs === "object" && state.runs !== null && !Array.isArray(state.runs)) {
    const runs = Object.fromEntries(Object.entries(state.runs as Record<string, unknown>).map(([key, item]) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return [key, item];
      const run = item as Record<string, unknown>;
      const terminal = ["completed", "needs_review", "failed", "blocked"].includes(String(run.phase));
      const profilesBound = run.freshAcceptanceProfileIdentity !== undefined && run.freshPersistenceProfileIdentity !== undefined;
      const workflowBound = run.workflowKind === "generic" || run.workflowKind === "led_compatibility_fixture";
      const normalized = profilesBound && workflowBound ? run : {
        ...run,
        freshAcceptanceProfileIdentity: run.freshAcceptanceProfileIdentity ?? "legacy-unbound",
        freshPersistenceProfileIdentity: run.freshPersistenceProfileIdentity ?? "legacy-unbound",
        workflowKind: run.workflowKind ?? "led_compatibility_fixture"
      };
      if (inputSchemaVersion === "evleda.flux.v1" && !terminal && normalized.workflowKind === "generic" && normalized.compilationBundleRef === undefined) {
        return [key, {
          ...normalized,
          phase: "blocked",
          blockedReason: "Generic run predates durable compilation-bundle authority and cannot be reconstructed from its public projection; create and interpret a new run."
        }];
      }
      if (!profilesBound || !workflowBound) {
        return [key, {
          ...normalized,
          ...(terminal ? {} : {
            phase: "blocked",
            blockedReason: "Run predates the bound generic-contract lifecycle; create and interpret a new run."
          })
        }];
      }
      return [key, normalized];
    }));
    migrated = { ...migrated, runs };
  }
  if (migrateLegacyState &&
    typeof migrated.idempotency === "object" && migrated.idempotency !== null && !Array.isArray(migrated.idempotency) &&
    typeof migrated.runs === "object" && migrated.runs !== null && !Array.isArray(migrated.runs)) {
    const runs = migrated.runs as Record<string, Record<string, unknown>>;
    const legacyReceipts = migrated.idempotency as Record<string, unknown>;
    const committedFailureRunId = (item: unknown): string | undefined => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
      const receipt = item as Record<string, unknown>; const runId = String(receipt.runId); const run = runs[runId];
      return receipt.status === "pending" && ["interpret_run", "clarify_run"].includes(String(receipt.operation)) && run?.phase === "blocked" &&
        run.inFlightOperation === undefined && run.blockedReason === FLUX_TOOLCHAIN_FAILURE_MESSAGE && run.contractState === undefined && run.compilationBundleRef === undefined &&
        run.approval === undefined && run.isolatedFingerprint === undefined && run.preview === undefined && run.checkpointRequired === undefined && run.diagnostic === undefined
        ? runId : undefined;
    };
    const candidateCounts: Record<string, number> = {};
    for (const item of Object.values(legacyReceipts)) {
      const runId = committedFailureRunId(item); if (runId !== undefined) candidateCounts[runId] = (candidateCounts[runId] ?? 0) + 1;
    }
    const diagnosedRuns: Record<string, FluxDiagnosticDto> = {};
    const legacyEvidence = createFluxLegacyOperationFailureEvidence(inputSchemaVersion as "evleda.flux.v1" | "evleda.flux.v2");
    const legacyDiagnostic = createFluxOperationFailureDiagnostic(legacyEvidence);
    const idempotency = Object.fromEntries(Object.entries(legacyReceipts).map(([key, item]) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return [key, item];
      const receipt = item as Record<string, unknown>;
      const run = runs[String(receipt.runId)];
      const committedInterpretationFailure = committedFailureRunId(receipt) !== undefined && candidateCounts[String(receipt.runId)] === 1;
      if (!committedInterpretationFailure || run === undefined) return [key, receipt];
      const at = typeof run.updatedAt === "string" ? run.updatedAt : "1970-01-01T00:00:00.000Z";
      const message = typeof run.blockedReason === "string" && run.blockedReason.trim() ? run.blockedReason : "Generic contract interpretation failed closed.";
      const diagnostic = legacyDiagnostic;
      diagnosedRuns[String(receipt.runId)] = diagnostic;
      const failurePayload = { code: "ILLEGAL_TRANSITION" as const, message, details: {}, diagnostic };
      const identityPayload = { operation: receipt.operation, requestDigest: receipt.digest, resultId: receipt.resultId, runId: receipt.runId,
        startedAt: receipt.startedAt, completedAt: at, ...failurePayload };
      return [key, { ...receipt, status: "failed", completedAt: at,
        failure: { ...failurePayload, identity: canonicalIdentity(identityPayload, FLUX_OPERATION_FAILURE_SCHEMA_VERSION) }, terminalReceipt: { outcome: "failed", at } }];
    }));
    const diagnosedRunEntries = Object.fromEntries(Object.entries(runs).map(([runId, run]) => [runId,
      diagnosedRuns[runId] === undefined ? run : { ...run, diagnostic: diagnosedRuns[runId] }]));
    const events = Array.isArray(migrated.events) ? migrated.events.map((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
      const entry = item as Record<string, unknown>; const diagnostic = diagnosedRuns[String(entry.runId)];
      return diagnostic !== undefined && entry.kind === "run_blocked" && entry.detail === "Generic contract interpretation failed closed." && entry.diagnostic === undefined
        ? { ...entry, diagnostic } : entry;
    }) : migrated.events;
    const operationFailureEvidence = Object.keys(diagnosedRuns).length === 0 ? migrated.operationFailureEvidence : {
      ...(migrated.operationFailureEvidence as Record<string, unknown>), [fluxOperationFailureEvidenceIdentity(legacyEvidence).digest]: legacyEvidence };
    migrated = { ...migrated, runs: diagnosedRunEntries, idempotency, events, operationFailureEvidence };
  }
  if (canMigrateVersion && typeof migrated.idempotency === "object" && migrated.idempotency !== null && !Array.isArray(migrated.idempotency)) {
    const legacyEvidence = createFluxLegacyOperationFailureEvidence(inputSchemaVersion as "evleda.flux.v1" | "evleda.flux.v2" | "evleda.flux.v3");
    const legacyDiagnostic = createFluxOperationFailureDiagnostic(legacyEvidence); const legacyRunIds = new Set<string>();
    const idempotency = Object.fromEntries(Object.entries(migrated.idempotency as Record<string, unknown>).map(([key, item]) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return [key, item];
      const receipt = item as Record<string, unknown>; const failureValue = receipt.failure;
      if (receipt.status !== "failed" || typeof failureValue !== "object" || failureValue === null || Array.isArray(failureValue)) return [key, receipt];
      const failure = failureValue as Record<string, unknown>;
      try {
        legacyRunIds.add(String(receipt.runId));
        const payload = { code: failure.code, message: failure.message, details: failure.details, diagnostic: legacyDiagnostic };
        const identityPayload = { operation: receipt.operation, requestDigest: receipt.digest, resultId: receipt.resultId, runId: receipt.runId,
          startedAt: receipt.startedAt, completedAt: receipt.completedAt, ...payload };
        return [key, { ...receipt, failure: { ...payload, identity: canonicalIdentity(identityPayload, FLUX_OPERATION_FAILURE_SCHEMA_VERSION) } }];
      } catch { return [key, receipt]; }
    }));
    const runs = typeof migrated.runs === "object" && migrated.runs !== null && !Array.isArray(migrated.runs)
      ? Object.fromEntries(Object.entries(migrated.runs as Record<string, unknown>).map(([runId, item]) => {
        if (typeof item !== "object" || item === null || Array.isArray(item)) return [runId, item];
        const run = item as Record<string, unknown>;
        if (run.phase === "blocked" && run.diagnostic !== undefined) legacyRunIds.add(runId);
        return legacyRunIds.has(runId) ? [runId, { ...run, diagnostic: legacyDiagnostic }] : [runId, item];
      })) : migrated.runs;
    const events = Array.isArray(migrated.events) ? migrated.events.map((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return item; const eventValue = item as Record<string, unknown>;
      return legacyRunIds.has(String(eventValue.runId)) && eventValue.diagnostic !== undefined ? { ...eventValue, diagnostic: legacyDiagnostic } : item;
    }) : migrated.events;
    const operationFailureEvidence = legacyRunIds.size === 0 ? migrated.operationFailureEvidence : {
      ...(migrated.operationFailureEvidence as Record<string, unknown>), [fluxOperationFailureEvidenceIdentity(legacyEvidence).digest]: legacyEvidence };
    migrated = { ...migrated, idempotency, runs, events, operationFailureEvidence };
  }
  if (canMigrateVersion && typeof migrated.runs === "object" && migrated.runs !== null && !Array.isArray(migrated.runs) &&
    typeof migrated.idempotency === "object" && migrated.idempotency !== null && !Array.isArray(migrated.idempotency)) {
    const idempotency = migrated.idempotency as Record<string, unknown>; const reservations: Record<string, FluxOperationFailureEvidenceReservation> = {};
    const runs = Object.fromEntries(Object.entries(migrated.runs as Record<string, unknown>).map(([runId, item]) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return [runId, item];
      const run = item as Record<string, unknown>; const intentValue = run.inFlightOperation;
      if (typeof intentValue !== "object" || intentValue === null || Array.isArray(intentValue) || !["interpreting", "blocked"].includes(String(run.phase))) return [runId, run];
      const intent = intentValue as Record<string, unknown>;
      if (!["interpret_run", "clarify_run"].includes(String(intent.operation))) return [runId, run];
      const matching = Object.entries(idempotency).filter(([, receiptValue]) => {
        if (typeof receiptValue !== "object" || receiptValue === null || Array.isArray(receiptValue)) return false;
        const receipt = receiptValue as Record<string, unknown>;
        return receipt.status === "pending" && receipt.runId === runId && receipt.operation === intent.operation && receipt.digest === intent.requestDigest;
      });
      if (matching.length > 1) return [runId, run];
      try {
        const value = { schemaVersion: FLUX_OPERATION_FAILURE_EVIDENCE_RESERVATION_SCHEMA_VERSION, runId,
          operation: intent.operation as "interpret_run" | "clarify_run", idempotencyKey: matching[0]?.[0] ?? null,
          requestDigest: intent.requestDigest as string, providerIdentity: canonicalIdentity({ providerModel: run.providerModel }, FLUX_OPERATION_FAILURE_EVIDENCE_RESERVATION_PROVIDER_SCHEMA_VERSION),
          reservedAt: intent.startedAt as string };
        const reservation = { ...value, identity: canonicalIdentity(value, FLUX_OPERATION_FAILURE_EVIDENCE_RESERVATION_SCHEMA_VERSION) };
        if (reservations[reservation.identity.digest] !== undefined) return [runId, run];
        reservations[reservation.identity.digest] = reservation;
        return [runId, { ...run, operationFailureEvidenceReservationRef: reservation.identity }];
      } catch { return [runId, run]; }
    }));
    migrated = { ...migrated, runs, operationFailureEvidenceReservations: reservations };
  }
  if ((isLegacyState || isV3State || isV4State || isV5State || isV6State || isV7State) && typeof migrated.runs === "object" && migrated.runs !== null && !Array.isArray(migrated.runs)) {
    const downgradedRunIds = new Set<string>();
    const reviewMessage = isV7State ? FLUX_LEGACY_FULL_SEMANTIC_AUTHORITY_REVIEW_MESSAGE : isV6State ? FLUX_LEGACY_TERMINAL_CLEARANCE_RECEIPT_REVIEW_MESSAGE : isV5State ? FLUX_LEGACY_SEMANTIC_REVIEW_MESSAGE : FLUX_LEGACY_CLEARANCE_REVIEW_MESSAGE;
    const downgradeReports = (value: unknown): unknown => !Array.isArray(value) ? value : value.map((item) => typeof item === "object" && item !== null && !Array.isArray(item)
      ? { ...(item as Record<string, unknown>), disposition: "needs_review", summary: reviewMessage } : item);
    const runs = Object.fromEntries(Object.entries(migrated.runs as Record<string, unknown>).map(([runId, item]) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return [runId, item];
      const run = item as Record<string, unknown>;
      if (run.workflowKind !== "generic" || run.phase !== "completed") return [runId, run];
      downgradedRunIds.add(runId);
      return [runId, { ...run, phase: "needs_review", blockedReason: reviewMessage, reports: downgradeReports(run.reports) }];
    }));
    const reports = typeof migrated.reports === "object" && migrated.reports !== null && !Array.isArray(migrated.reports)
      ? Object.fromEntries(Object.entries(migrated.reports as Record<string, unknown>).map(([reportId, item]) => {
        if (typeof item !== "object" || item === null || Array.isArray(item) || !downgradedRunIds.has(String((item as Record<string, unknown>).runId))) return [reportId, item];
        return [reportId, { ...(item as Record<string, unknown>), disposition: "needs_review", summary: reviewMessage }];
      })) : migrated.reports;
    const events = Array.isArray(migrated.events) ? migrated.events.map((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return item; const entry = item as Record<string, unknown>;
      return downgradedRunIds.has(String(entry.runId)) && entry.kind === "run_completed" ? { ...entry, kind: "run_needs_review", detail: reviewMessage } : entry;
    }) : migrated.events;
    const idempotency = typeof migrated.idempotency === "object" && migrated.idempotency !== null && !Array.isArray(migrated.idempotency)
      ? Object.fromEntries(Object.entries(migrated.idempotency as Record<string, unknown>).map(([key, item]) => {
        if (typeof item !== "object" || item === null || Array.isArray(item)) return [key, item]; const receipt = item as Record<string, unknown>; const result = receipt.result;
        if (!downgradedRunIds.has(String(receipt.runId)) || typeof result !== "object" || result === null || Array.isArray(result) || (result as Record<string, unknown>).phase !== "completed") return [key, receipt];
        return [key, { ...receipt, result: { ...(result as Record<string, unknown>), phase: "needs_review", blockedReason: reviewMessage, reports: downgradeReports((result as Record<string, unknown>).reports) } }];
      })) : migrated.idempotency;
    migrated = { ...migrated, runs, reports, events, idempotency };
  }

  if ((isLegacyState || isV3State || isV4State || isV5State || isV6State || isV7State || isV8State || isV9State) && typeof migrated.runs === "object" && migrated.runs !== null && !Array.isArray(migrated.runs)) {
    const reviewRunIds = new Set<string>();
    const preparedPhases = new Set(["preparing", "awaiting_open", "opening", "awaiting_checkpoint", "checkpointing", "awaiting_approval", "approved", "queued", "running"]);
    const runs = Object.fromEntries(Object.entries(migrated.runs as Record<string, unknown>).map(([runId, item]) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return [runId, item];
      const run = item as Record<string, unknown>;
      const legacy = [run.freshNetClassPreparationEvidence, run.freshNetClassSemanticAuthority, run.freshClearanceEvidenceReceipt].some(isFluxLegacyNetClassEvidence);
      const missing = run.freshNetClassPreparationEvidence === undefined || run.freshNetClassSemanticAuthority === undefined || run.freshProjectOpenPreparedSourceAuthority === undefined;
      if (run.workflowKind !== "generic" || !(run.phase === "completed" && legacy || preparedPhases.has(String(run.phase)) && (legacy || missing))) return [runId, run];
      reviewRunIds.add(runId);
      // Retain all source bytes, identities, approvals, reports, events and uncertain operation leases.
      return [runId, { ...run, phase: "needs_review", blockedReason: FLUX_LEGACY_AUTHORED_NETCLASS_REVIEW_MESSAGE }];
    }));
    const idempotency = typeof migrated.idempotency === "object" && migrated.idempotency !== null && !Array.isArray(migrated.idempotency)
      ? Object.fromEntries(Object.entries(migrated.idempotency as Record<string, unknown>).map(([key, item]) => {
        if (typeof item !== "object" || item === null || Array.isArray(item)) return [key, item];
        const receipt = item as Record<string, unknown>; const result = receipt.result;
        if (!reviewRunIds.has(String(receipt.runId)) || typeof result !== "object" || result === null || Array.isArray(result) || !["completed", ...preparedPhases].includes(String((result as Record<string, unknown>).phase))) return [key, receipt];
        return [key, { ...receipt, result: { ...(result as Record<string, unknown>), phase: "needs_review", blockedReason: FLUX_LEGACY_AUTHORED_NETCLASS_REVIEW_MESSAGE } }];
      })) : migrated.idempotency;
    migrated = { ...migrated, runs, idempotency };
  }
  return migrated;
};

const assertImmutableReports = (previous: FluxPersistedState, next: FluxPersistedState): void => {
  for (const [reportId, report] of Object.entries(previous.reports)) {
    const replacement = next.reports[reportId];
    if (replacement === undefined || JSON.stringify(replacement) !== JSON.stringify(report)) {
      throw new FluxError("IDEMPOTENCY_CONFLICT", "Committed Flux reports are immutable", { reportId });
    }
  }
};

const assertImmutableOperationFailureEvidence = (previous: FluxPersistedState, next: FluxPersistedState): void => {
  for (const [digest, evidence] of Object.entries(previous.operationFailureEvidence)) {
    const replacement = next.operationFailureEvidence[digest];
    if (replacement === undefined || canonicalJson(replacement) !== canonicalJson(evidence)) {
      throw new FluxError("IDEMPOTENCY_CONFLICT", "Committed operation failure evidence is immutable", { evidenceDigest: digest });
    }
  }
};

const assertImmutableTerminalFailures = (previous: FluxPersistedState, next: FluxPersistedState): void => {
  for (const [key, receipt] of Object.entries(previous.idempotency)) {
    if (receipt.status !== "failed") continue;
    const replacement = next.idempotency[key];
    if (replacement === undefined || canonicalJson(replacement) !== canonicalJson(receipt)) throw new FluxError("IDEMPOTENCY_CONFLICT", "Committed terminal failure receipts are immutable");
  }
};

const assertImmutableTerminalClearanceReceipts = (previous: FluxPersistedState, next: FluxPersistedState): void => {
  for (const [runId, run] of Object.entries(previous.runs)) {
    if (run.freshClearanceEvidenceReceipt === undefined) continue;
    const replacement = next.runs[runId]?.freshClearanceEvidenceReceipt;
    if (replacement === undefined || canonicalJson(replacement) !== canonicalJson(run.freshClearanceEvidenceReceipt)) {
      throw new FluxError("IDEMPOTENCY_CONFLICT", "Committed terminal fresh clearance evidence receipts are immutable", { runId });
    }
  }
};

/** A small purpose-built state store. Every replace is a same-directory atomic rename. */
export class FluxRunStore {
  readonly #stateFile: string;
  #tail: Promise<void> = Promise.resolve();
  #initialized = false;

  public constructor(public readonly workspaceRoot: string, private readonly eventLimit = 500) {
    if (!Number.isSafeInteger(eventLimit) || eventLimit < 1) throw new FluxError("INVALID_ARGUMENT", "eventLimit must be a positive integer");
    this.#stateFile = path.join(workspaceRoot, "flux-state.json");
  }

  public async initialize(): Promise<void> {
    if (this.#initialized) return;
    await mkdir(this.workspaceRoot, { recursive: true });
    await assertNoSymlink(this.workspaceRoot, "Flux workspace root");
    const realRoot = await realpath(this.workspaceRoot);
    if (comparable(realRoot) !== comparable(path.resolve(this.workspaceRoot))) throw new FluxError("PATH_POLICY", "Flux workspace root resolves through a link");
    try {
      const loaded = await this.#readWithMigration();
      if (loaded.migrated) await this.#write(loaded.state);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.#write(empty());
    }
    this.#initialized = true;
  }

  public async read(): Promise<FluxPersistedState> { await this.initialize(); return freeze(structuredClone(await this.#read()) as FluxPersistedState); }

  public async replace(mutator: (state: FluxPersistedState) => FluxPersistedState, assertBeforeCommit?: () => void): Promise<FluxPersistedState> {
    await this.initialize();
    let resolve!: (state: FluxPersistedState) => void;
    let reject!: (reason: unknown) => void;
    const result = new Promise<FluxPersistedState>((ok, bad) => { resolve = ok; reject = bad; });
    const work = async (): Promise<void> => {
      try {
        const current = await this.#read();
        const candidate = mutator(structuredClone(current) as FluxPersistedState);
        let nextEventSeq = current.nextEventSeq;
        const sequencedEvents = candidate.events.map((entry) => entry.eventSeq === 0 ? freeze({ ...entry, eventSeq: nextEventSeq++ }) : entry);
        const sequenced = { ...candidate, events: sequencedEvents, nextEventSeq };
        assertPlainState(sequenced);
        assertImmutableReports(current, candidate);
        assertImmutableOperationFailureEvidence(current, candidate);
        assertImmutableTerminalFailures(current, candidate);
        assertImmutableTerminalClearanceReceipts(current, candidate);
        const next = freeze({ ...sequenced, revision: current.revision + 1, events: sequenced.events.slice(-this.eventLimit) });
        await this.#write(next, assertBeforeCommit);
        resolve(freeze(structuredClone(next) as FluxPersistedState));
      } catch (error) { reject(error); }
    };
    this.#tail = this.#tail.then(work, work);
    return result;
  }

  public async appendEvent(event: FluxEventDto): Promise<FluxPersistedState> {
    return this.replace((state) => ({ ...state, events: [...state.events, event] }));
  }

  /** @internal Server-local diagnostic evidence lookup. This is intentionally not exposed by Flux routes. */
  public async readOperationFailureEvidence(identity: FluxCanonicalIdentityDto): Promise<FluxOperationFailureEvidence | undefined> {
    let normalizedIdentity: FluxCanonicalIdentityDto;
    try {
      normalizedIdentity = parseFluxDiagnostic({ schemaVersion: "evleda.flux-diagnostic.v1", code: "TOOLCHAIN_FAILURE", evidenceIdentity: identity }).evidenceIdentity;
    } catch { throw new FluxError("INVALID_ARGUMENT", "Provider failure evidence identity is malformed"); }
    const state = await this.read(); const evidence = state.operationFailureEvidence[normalizedIdentity.digest];
    if (evidence === undefined) return undefined;
    const parsed = parseFluxOperationFailureEvidence(evidence);
    if (canonicalJson(fluxOperationFailureEvidenceIdentity(parsed)) !== canonicalJson(normalizedIdentity)) throw new FluxError("STORE_CORRUPT", "Operation failure evidence identity does not match its lookup key");
    return freeze(structuredClone(parsed));
  }

  /** Report ids are write-once. A second publication is always rejected. */
  public async publishReport(report: FluxPersistedReport): Promise<FluxPersistedState> {
    return this.replace((state) => {
      if (Object.hasOwn(state.reports, report.reportId)) throw new FluxError("IDEMPOTENCY_CONFLICT", "Reports are immutable and cannot be replaced", { reportId: report.reportId });
      return { ...state, reports: { ...state.reports, [report.reportId]: freeze(structuredClone(report)) } };
    });
  }

  async #read(): Promise<FluxPersistedState> {
    return (await this.#readWithMigration()).state;
  }

  async #readWithMigration(): Promise<Readonly<{ readonly state: FluxPersistedState; readonly migrated: boolean }>> {
    await assertNoSymlink(this.#stateFile, "Flux state file");
    const text = await readFile(this.#stateFile, "utf8");
    let parsed: unknown;
    try { parsed = parsePortableJsonBytes(Buffer.from(text, "utf8"), { maxBytes: 16 * 1024 * 1024, maxDepth: 96, maxNodes: 500_000, maxArrayLength: 200_000, maxOwnKeys: 16_384, maxKeyBytes: 4_096, maxStringBytes: 1024 * 1024 }); }
    catch { throw new FluxError("STORE_CORRUPT", "Flux state is not bounded canonical portable JSON"); }
    const schemaBefore = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).schemaVersion
      : undefined;
    const migrated = migrateState(parsed);
    assertPlainState(migrated);
    return { state: migrated, migrated: schemaBefore !== FLUX_STATE_SCHEMA_VERSION };
  }

  async #write(state: FluxPersistedState, assertBeforeCommit?: () => void): Promise<void> {
    const basename = `.flux-state-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
    const temporary = path.join(this.workspaceRoot, basename);
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", flag: "wx" });
    try { assertBeforeCommit?.(); }
    catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
    await rename(temporary, this.#stateFile);
  }
}
