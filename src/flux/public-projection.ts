import { hardenPortableValue, validateCanonicalIdentity } from "../core/portable-artifact.js";
import { parseFluxDiagnostic } from "../domain/diagnostics.js";
import { parsePcbDesignCompilationBundleRef } from "../harness/pcb-design-compilation-bundle.js";
import { parsePcbDesignContract } from "../harness/pcb-design-contract.js";
import { parsePcbProviderProfileBinding } from "../harness/pcb-design-interpreter.js";
import { PCB_AGENT_MAX_FRESH_ITERATIONS, PCB_AGENT_MIN_ITERATIONS } from "../harness/pcb-agent-harness.js";
import { approvalSubjectDigest, FluxError, type FluxApprovalSubject, type FluxContractStateDto, type FluxEventDto, type FluxQueueSnapshot, type FluxRunDto } from "./contracts.js";
import { parseFluxDeepRuleSummary } from "./deep-rule-summary.js";
import { parseFluxFreshClearanceEvidenceBinding, parseFluxPersistedFreshClearanceEvidenceBinding } from "./fresh-clearance-evidence-binding.js";

const ID = /^[a-z][a-z0-9_-]{0,127}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const PHASES = new Set(["draft", "interpreting", "awaiting_clarification", "contract_ready", "preparing", "awaiting_open", "opening", "awaiting_checkpoint", "checkpointing", "awaiting_approval", "approved", "queued", "running", "completed", "needs_review", "failed", "blocked"]);
const EVENTS = new Set(["project_created", "thread_created", "run_created", "interpretation_started", "clarification_requested", "contract_compiled", "run_prepared", "run_opened", "open_checkpoint_recorded", "approval_recorded", "approval_consumed", "run_queued", "run_started", "run_progress", "preview_ready", "preview_warning", "run_completed", "run_needs_review", "run_failed", "run_blocked"]);
const PRIVATE_KEYS = new Set(["compilationBundle", "executionPrompt", "projectPaths", "sourceRoot", "freshNetClassPreparationEvidence", "freshNetClassSemanticAuthority", "freshProjectOpenPreparedSourceAuthority", "freshClearanceEvidenceReceipt", "operationFailureEvidence", "operationFailureEvidenceReservations", "operationFailureEvidenceReservationRef", "providerFailureEvidence", "providerFailureEvidenceReservations"]);
const SECRET_VALUE = /(?:\b(?:bearer|basic)\s+[A-Za-z0-9._~+\/-]+=*|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}|\b(?:password|authorization|cookie)\s*[:=])/iu;
const LOCAL_PATH = /(?:^~[\\/]|^[A-Za-z]:[\\/]|^\\\\|^file:|^\/(?:Users|home|tmp|var|etc|opt|private)\/)/iu;

const fail = (): never => { throw new FluxError("INVALID_ARGUMENT", "Flux public DTO failed its closed safe projection"); };
const record = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : fail();
const exact = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void => {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key))) fail();
};
const text = (value: unknown, maxBytes: number, allowEmpty = false): string => {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.includes("\0") || Buffer.byteLength(value, "utf8") > maxBytes) return fail();
  return value;
};
const id = (value: unknown): string => { const result = text(value, 128); return ID.test(result) ? result : fail(); };
const digest = (value: unknown): string => { const result = text(value, 64); return DIGEST.test(result) ? result : fail(); };
const time = (value: unknown): string => { const result = text(value, 64); return !Number.isNaN(Date.parse(result)) && new Date(result).toISOString() === result ? result : fail(); };
const identity = (value: unknown): unknown => { try { return validateCanonicalIdentity(value, "Flux public identity"); } catch { return fail(); } };
const nullableIdentity = (value: unknown): unknown => value === null ? null : identity(value);
const contentIdentity = (value: unknown): unknown => {
  const item = record(value); exact(item, ["algorithm", "digest", "size"]);
  if (item.algorithm !== "sha256" || !Number.isSafeInteger(item.size) || (item.size as number) < 0) fail(); digest(item.digest);
  return item;
};

const assertSafe = (value: unknown, key = "", depth = 0): void => {
  if (depth > 64) fail();
  if (typeof value === "string") {
    const trimmed = value.trim(); const pointer = ["id", "path", "clarificationId", "contractPath"].includes(key) && /^\/(?:[A-Za-z0-9_.~-]+(?:\/[A-Za-z0-9_.~-]+)*)?$/u.test(trimmed);
    if (SECRET_VALUE.test(value) || (LOCAL_PATH.test(trimmed) && !pointer)) fail();
    return;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return;
  if (Array.isArray(value)) { for (const entry of value) assertSafe(entry, key, depth + 1); return; }
  const item = record(value);
  for (const [childKey, child] of Object.entries(item)) {
    if (PRIVATE_KEYS.has(childKey) || /(?:password|authorization|cookie|credential|privatekey|rawprovidertext)$/iu.test(childKey.replaceAll(/[_-]/gu, ""))) fail();
    assertSafe(child, childKey, depth + 1);
  }
};

const bounded = (value: unknown): unknown => {
  try { return hardenPortableValue(value, { maxBytes: 2 * 1024 * 1024, maxDepth: 64, maxNodes: 200_000, maxArrayLength: 20_000, maxOwnKeys: 2_048, maxKeyBytes: 512, maxStringBytes: 256 * 1024 }); }
  catch { return fail(); }
};

const projectContractState = (value: unknown, workflowKind: FluxRunDto["workflowKind"]): FluxContractStateDto => {
  const state = record(value);
  exact(state, ["disposition", "questions", "issues", "contract", "contractIdentity", "libraryBindingIdentity", "deepRuleBindingIdentity", "acceptancePlanIdentity", "interpreterReceipt"], ["deepRuleSummary"]);
  if (!["needs_clarification", "unsupported", "ready"].includes(String(state.disposition)) || !Array.isArray(state.questions) || state.questions.length > 64 || !Array.isArray(state.issues) || state.issues.length > 4_096) fail();
  const questions = state.questions as unknown[]; const issues = state.issues as unknown[];
  for (const questionValue of questions) { const question = record(questionValue); exact(question, ["id", "path", "question"]); text(question.id, 1_024); text(question.path, 2_048); text(question.question, 16_384); }
  for (const issueValue of issues) { const issue = record(issueValue); exact(issue, ["code", "severity", "path", "message", "clarificationId"]); text(issue.code, 256); if (issue.severity !== "error") fail(); text(issue.path, 2_048); text(issue.message, 16_384); if (issue.clarificationId !== null) text(issue.clarificationId, 1_024); }
  if (state.contract !== null) {
    if (workflowKind === "generic") { try { parsePcbDesignContract(state.contract); } catch { fail(); } }
    else { const contract = record(state.contract); exact(contract, ["schemaVersion", "kind"]); if (contract.schemaVersion !== "evleda.flux-led-compatibility-fixture.v1" || contract.kind !== "led_compatibility_fixture") fail(); }
  }
  nullableIdentity(state.contractIdentity); nullableIdentity(state.libraryBindingIdentity); nullableIdentity(state.deepRuleBindingIdentity); nullableIdentity(state.acceptancePlanIdentity);
  const receipt = record(state.interpreterReceipt);
  if (receipt.schemaVersion === "evleda.flux-interpreter-receipt.v2") {
    exact(receipt, ["schemaVersion", "interpreterSchemaVersion", "provider", "providerProfile", "providerProfileIdentity", "promptDigest", "clarificationDigest", "compilerProfileIdentity", "practiceProfileBindingIdentity", "bundleIdentity", "compiledAt", "identity"]);
    text(receipt.interpreterSchemaVersion, 256); text(receipt.provider, 128); try { parsePcbProviderProfileBinding(receipt.providerProfile); } catch { fail(); }
    identity(receipt.providerProfileIdentity); digest(receipt.promptDigest); digest(receipt.clarificationDigest); nullableIdentity(receipt.compilerProfileIdentity); nullableIdentity(receipt.practiceProfileBindingIdentity); nullableIdentity(receipt.bundleIdentity); time(receipt.compiledAt); identity(receipt.identity);
  } else if (receipt.schemaVersion === "evleda.flux-interpreter-receipt.v1") {
    exact(receipt, ["schemaVersion", "interpreterSchemaVersion", "provider", "promptDigest", "clarificationDigest", "compiledAt"]);
    text(receipt.interpreterSchemaVersion, 256); text(receipt.provider, 128); digest(receipt.promptDigest); digest(receipt.clarificationDigest); time(receipt.compiledAt);
  } else fail();
  if (state.deepRuleSummary !== undefined) { try { parseFluxDeepRuleSummary(state.deepRuleSummary); } catch { fail(); } }
  if (workflowKind === "generic" && state.disposition === "ready" && state.deepRuleSummary === undefined) fail();
  assertSafe(state);
  return state as unknown as FluxContractStateDto;
};

const validateReports = (reports: unknown): void => {
  if (!Array.isArray(reports) || reports.length > 4_096) fail();
  for (const reportValue of reports as unknown[]) {
    const report = record(reportValue); exact(report, ["reportId", "title", "digest", "mediaType", "createdAt"], ["disposition", "summary", "reportSha256", "freshAcceptance", "freshBoardSaveAudits", "executionBridgeIdentity", "writeSessionAuthorityIdentity", "writeSessionReceiptIdentity", "executionInspectionSessionReceiptIdentity", "freshClearanceEvidenceBinding"]);
    id(report.reportId); text(report.title, 16_384); digest(report.digest); text(report.mediaType, 512); time(report.createdAt);
    if (report.disposition !== undefined && !["completed", "needs_review", "blocked", "failed"].includes(String(report.disposition))) fail();
    if (report.summary !== undefined) text(report.summary, 64 * 1024, true); if (report.reportSha256 !== undefined) digest(report.reportSha256);
    const writeIdentityCount = [report.executionBridgeIdentity, report.writeSessionAuthorityIdentity, report.writeSessionReceiptIdentity, report.executionInspectionSessionReceiptIdentity].filter((value) => value !== undefined).length;
    if (writeIdentityCount !== 0 && writeIdentityCount !== 4) fail();
    if (report.writeSessionAuthorityIdentity !== undefined) {
      const execution = identity(report.executionBridgeIdentity) as Record<string, unknown>; const authority = identity(report.writeSessionAuthorityIdentity) as Record<string, unknown>; const receipt = identity(report.writeSessionReceiptIdentity) as Record<string, unknown>; const inspectionReceipt = identity(report.executionInspectionSessionReceiptIdentity) as Record<string, unknown>;
      if (execution.schemaVersion !== "evleda.kicad-mcp-execution-bridge.v1" || authority.schemaVersion !== "evleda.kicad-mcp-session-authority.v1" || receipt.schemaVersion !== "evleda.kicad-mcp-session-receipt.v1" || inspectionReceipt.schemaVersion !== "evleda.kicad-mcp-session-receipt.v1") fail();
    }
    if (report.freshClearanceEvidenceBinding !== undefined) { try { parseFluxPersistedFreshClearanceEvidenceBinding(report.freshClearanceEvidenceBinding); } catch { fail(); } }
    if (report.freshClearanceEvidenceBinding !== undefined && writeIdentityCount !== 4) fail();
    if (report.freshAcceptance !== undefined) {
      const acceptance = record(report.freshAcceptance); exact(acceptance, ["passed", "requirements", "missing", "sourceHashes", "evidenceLimitations"]);
      if (typeof acceptance.passed !== "boolean" || !Array.isArray(acceptance.requirements) || !Array.isArray(acceptance.missing) || !Array.isArray(acceptance.evidenceLimitations)) fail();
      for (const requirementValue of acceptance.requirements as unknown[]) { const requirement = record(requirementValue); exact(requirement, ["id", "status", "detail"]); text(requirement.id, 1_024); if (!["pass", "fail", "unknown"].includes(String(requirement.status))) fail(); text(requirement.detail, 16_384, true); }
      for (const item of [...acceptance.missing as unknown[], ...acceptance.evidenceLimitations as unknown[]]) text(item, 16_384, true);
      const hashes = record(acceptance.sourceHashes); exact(hashes, ["schematicSha256", "pcbSha256"], ["netlistSha256"]); digest(hashes.schematicSha256); digest(hashes.pcbSha256);
      if (Object.hasOwn(hashes, "netlistSha256")) digest(hashes.netlistSha256);
    }
    if (report.freshBoardSaveAudits !== undefined) {
      if (!Array.isArray(report.freshBoardSaveAudits) || report.freshBoardSaveAudits.length > 64) fail();
      for (const auditValue of report.freshBoardSaveAudits as unknown[]) { const audit = record(auditValue); exact(audit, ["before", "live", "after", "directorySync"]); if (!["synced", "unavailable"].includes(String(audit.directorySync))) fail();
        for (const stage of [audit.before, audit.live, audit.after]) { const snapshot = record(stage); exact(snapshot, ["sha256", "bytes"]); digest(snapshot.sha256); if (!Number.isSafeInteger(snapshot.bytes) || (snapshot.bytes as number) < 0) fail(); } }
    }
  }
};

export const projectFluxRunDto = (value: unknown): FluxRunDto => {
  const run = record(bounded(value));
  exact(run, ["id", "projectId", "threadId", "phase", "prompt", "providerModel", "iterationCap", "harnessRuleIdentity", "mutationAllowlist", "freshAcceptanceProfileIdentity", "freshPersistenceProfileIdentity", "workflowKind", "reports", "createdAt", "updatedAt"], ["checkpointRequired", "contractState", "compilationBundleRef", "preview", "approval", "blockedReason", "diagnostic"]);
  id(run.id); id(run.projectId); id(run.threadId); if (!PHASES.has(String(run.phase))) fail(); text(run.prompt, 1024 * 1024, true);
  const provider = record(run.providerModel); exact(provider, ["provider", "model", "tier"]); text(provider.provider, 1_024); text(provider.model, 1_024); text(provider.tier, 1_024);
  if (!Number.isSafeInteger(run.iterationCap) || (run.iterationCap as number) < PCB_AGENT_MIN_ITERATIONS || (run.iterationCap as number) > PCB_AGENT_MAX_FRESH_ITERATIONS || !Array.isArray(run.mutationAllowlist) || run.mutationAllowlist.length > 256) fail();
  text(run.harnessRuleIdentity, 16_384); text(run.freshAcceptanceProfileIdentity, 16_384); text(run.freshPersistenceProfileIdentity, 16_384); for (const mutation of run.mutationAllowlist as unknown[]) text(mutation, 1_024);
  if (run.workflowKind !== "generic" && run.workflowKind !== "led_compatibility_fixture") fail();
  const workflowKind = run.workflowKind as FluxRunDto["workflowKind"];
  if (run.checkpointRequired !== undefined && typeof run.checkpointRequired !== "boolean") fail();
  const contractState = run.contractState === undefined ? undefined : projectContractState(run.contractState, workflowKind);
  let compilationBundleRef = run.compilationBundleRef;
  if (compilationBundleRef !== undefined) { try { compilationBundleRef = parsePcbDesignCompilationBundleRef(compilationBundleRef); } catch { fail(); } }
  if (run.preview !== undefined) { const preview = record(run.preview); exact(preview, ["title", "summary", "artifactCount", "digest"]); text(preview.title, 4_096); text(preview.summary, 16_384, true); if (!Number.isSafeInteger(preview.artifactCount) || (preview.artifactCount as number) < 0) fail(); digest(preview.digest); }
  validateReports(run.reports);
  if (workflowKind === "generic" && run.phase === "completed") {
    if ((run.reports as unknown[]).length === 0) fail();
    for (const report of run.reports as unknown[]) {
      try { parseFluxFreshClearanceEvidenceBinding(record(report).freshClearanceEvidenceBinding); } catch { fail(); }
      if (record(record(run.contractState).acceptancePlanIdentity).schemaVersion === "evleda.pcb-acceptance-plan.v2") {
        const acceptance = record(record(report).freshAcceptance); const rows = Array.isArray(acceptance.requirements) ? acceptance.requirements.filter((entry) => record(entry).id === "schematic-render-clearance") : [];
        if (acceptance.passed !== true || !Array.isArray(acceptance.missing) || acceptance.missing.length !== 0 || rows.length !== 1 || record(rows[0]).status !== "pass") fail();
      }
    }
  }
  if (run.approval !== undefined) { const approval = record(run.approval); exact(approval, ["id", "subjectDigest", "approvedAt"], ["consumedAt"]); id(approval.id); digest(approval.subjectDigest); time(approval.approvedAt); if (approval.consumedAt !== undefined) time(approval.consumedAt); }
  let diagnostic = run.diagnostic;
  if (run.blockedReason !== undefined) text(run.blockedReason, 64 * 1024); if (diagnostic !== undefined) { try { diagnostic = parseFluxDiagnostic(diagnostic); } catch { fail(); } }
  time(run.createdAt); time(run.updatedAt);
  const projected = { ...run, ...(contractState === undefined ? {} : { contractState }), ...(compilationBundleRef === undefined ? {} : { compilationBundleRef }), ...(diagnostic === undefined ? {} : { diagnostic }) };
  assertSafe(projected);
  return projected as unknown as FluxRunDto;
};

export const projectFluxContractStateDto = (value: unknown, workflowKind: FluxRunDto["workflowKind"]): FluxContractStateDto => projectContractState(record(bounded(value)), workflowKind);

export const projectFluxEventDto = (value: unknown): FluxEventDto => {
  const event = record(bounded(value)); exact(event, ["id", "eventSeq", "kind", "at", "detail"], ["runId", "diagnostic"]); id(event.id);
  if (!Number.isSafeInteger(event.eventSeq) || (event.eventSeq as number) < 1 || !EVENTS.has(String(event.kind))) fail(); if (event.runId !== undefined) id(event.runId); time(event.at); text(event.detail, 64 * 1024, true);
  let diagnostic = event.diagnostic; if (diagnostic !== undefined) { try { diagnostic = parseFluxDiagnostic(diagnostic); } catch { fail(); } }
  const projected = { ...event, ...(diagnostic === undefined ? {} : { diagnostic }) }; assertSafe(projected); return projected as unknown as FluxEventDto;
};

export const projectFluxQueueSnapshot = (value: unknown): FluxQueueSnapshot => {
  const queue = record(bounded(value)); exact(queue, ["queuedRunIds"], ["busyRunId"]); if (queue.busyRunId !== undefined) id(queue.busyRunId);
  if (!Array.isArray(queue.queuedRunIds) || queue.queuedRunIds.length > 10_000) fail(); for (const runId of queue.queuedRunIds as unknown[]) id(runId); return queue as unknown as FluxQueueSnapshot;
};

export const projectFluxApprovalSubjectResult = (value: unknown): Readonly<{ readonly subject: FluxApprovalSubject; readonly digest: string }> => {
  const result = record(bounded(value)); exact(result, ["subject", "digest"]); const subject = record(result.subject);
  const base = ["schemaVersion", "runId", "workflowKind", "sourceKey", "sourceFingerprint", "isolatedFingerprint", "promptIdentity", "providerModel", "iterationCap",
    "harnessRuleIdentity", "mutationAllowlist", "freshAcceptanceProfileIdentity", "freshPersistenceProfileIdentity", "contractIdentity", "libraryBindingIdentity",
    "deepRuleBindingIdentity", "acceptancePlanIdentity", "kicadToolchainIdentity", "inspectionBridgeIdentity", "executionBridgeIdentity", "ipcSocketIdentity", "writeSessionAuthorityIdentity", "ipcProbeSemanticIdentity", "freshNetClassSemanticAuthorityIdentity", "freshProjectOpenPreparedSourceAuthorityIdentity", "freshNetClassPreparationEvidenceIdentity", "openPreflightReceiptIdentity", "openCheckpointReceiptIdentity"];
  if (subject.schemaVersion !== "evleda.flux-approval-subject.v6") fail(); id(subject.runId); text(subject.sourceKey, 64); digest(subject.sourceFingerprint); digest(subject.isolatedFingerprint);
  contentIdentity(subject.promptIdentity); const provider = record(subject.providerModel); exact(provider, ["provider", "model", "tier"]);
  text(provider.provider, 1_024); text(provider.model, 1_024); text(provider.tier, 1_024);
  if (!Number.isSafeInteger(subject.iterationCap) || (subject.iterationCap as number) < PCB_AGENT_MIN_ITERATIONS || (subject.iterationCap as number) > PCB_AGENT_MAX_FRESH_ITERATIONS || !Array.isArray(subject.mutationAllowlist) || subject.mutationAllowlist.length > 256) fail();
  text(subject.harnessRuleIdentity, 16_384); text(subject.freshAcceptanceProfileIdentity, 16_384); text(subject.freshPersistenceProfileIdentity, 16_384);
  for (const mutation of subject.mutationAllowlist as unknown[]) text(mutation, 1_024);
  for (const field of ["contractIdentity", "libraryBindingIdentity", "deepRuleBindingIdentity", "acceptancePlanIdentity", "kicadToolchainIdentity", "inspectionBridgeIdentity", "executionBridgeIdentity", "ipcSocketIdentity", "writeSessionAuthorityIdentity", "ipcProbeSemanticIdentity", "openPreflightReceiptIdentity", "openCheckpointReceiptIdentity"] as const) identity(subject[field]);
  const freshNetClassSemanticAuthorityIdentity = subject.freshNetClassSemanticAuthorityIdentity === null ? null : identity(subject.freshNetClassSemanticAuthorityIdentity) as Record<string, unknown>;
  const freshProjectOpenPreparedSourceAuthorityIdentity = subject.freshProjectOpenPreparedSourceAuthorityIdentity === null ? null : identity(subject.freshProjectOpenPreparedSourceAuthorityIdentity) as Record<string, unknown>;
  const freshNetClassPreparationEvidenceIdentity = subject.freshNetClassPreparationEvidenceIdentity === null ? null : identity(subject.freshNetClassPreparationEvidenceIdentity) as Record<string, unknown>;
  if ((subject.inspectionBridgeIdentity as Record<string, unknown>).schemaVersion !== "evleda.kicad-mcp-inspection-bridge.v2" || (subject.executionBridgeIdentity as Record<string, unknown>).schemaVersion !== "evleda.kicad-mcp-execution-bridge.v1" ||
    (subject.ipcSocketIdentity as Record<string, unknown>).schemaVersion !== "evleda.kicad-api-socket-binding.v1" || (subject.writeSessionAuthorityIdentity as Record<string, unknown>).schemaVersion !== "evleda.kicad-mcp-session-authority.v1" ||
    (subject.ipcProbeSemanticIdentity as Record<string, unknown>).schemaVersion !== "evleda.flux-open-ipc-probe-semantic.v2") fail();
  if (subject.workflowKind === "generic") {
    exact(subject, [...base, "compilationBundleRef", "providerProfile", "bundleIdentity", "compilerProfileIdentity", "practiceProfileBindingIdentity", "executionPromptIdentity", "executionPromptContentIdentity"]);
    try { parsePcbDesignCompilationBundleRef(subject.compilationBundleRef); parsePcbProviderProfileBinding(subject.providerProfile); } catch { fail(); }
    for (const field of ["bundleIdentity", "compilerProfileIdentity", "practiceProfileBindingIdentity", "executionPromptIdentity"] as const) identity(subject[field]);
    contentIdentity(subject.executionPromptContentIdentity);
    if ((subject.acceptancePlanIdentity as Record<string, unknown>).schemaVersion !== "evleda.pcb-acceptance-plan.v2" || (subject.compilerProfileIdentity as Record<string, unknown>).schemaVersion !== "evleda.pcb-design-compiler-profile.v2") fail();
    if (freshNetClassSemanticAuthorityIdentity?.schemaVersion !== "evleda.fresh-netclass-semantic-authority.v2" || freshProjectOpenPreparedSourceAuthorityIdentity?.schemaVersion !== "evleda.fresh-project-open-prepared-source-authority.v1" ||
      freshNetClassPreparationEvidenceIdentity?.schemaVersion !== "evleda.fresh-netclass-preparation-evidence.v2") fail();
  } else if (subject.workflowKind === "led_compatibility_fixture") {
    exact(subject, [...base, "compilationBundleRef", "providerProfile"]);
    if (subject.compilationBundleRef !== null || subject.providerProfile !== null || freshNetClassSemanticAuthorityIdentity !== null || freshProjectOpenPreparedSourceAuthorityIdentity !== null || freshNetClassPreparationEvidenceIdentity !== null) fail();
  } else fail();
  const resultDigest = digest(result.digest); const typed = subject as unknown as FluxApprovalSubject;
  if (approvalSubjectDigest(typed) !== resultDigest) fail(); assertSafe(subject);
  return Object.freeze({ subject: typed, digest: resultDigest });
};

export const projectFluxPollResult = (value: Readonly<{ readonly run: unknown; readonly queue: unknown; readonly events: readonly unknown[]; readonly nextEventSeq: unknown }>) => {
  if (!Number.isSafeInteger(value.nextEventSeq) || (value.nextEventSeq as number) < 0 || !Array.isArray(value.events) || value.events.length > 20_000) fail();
  return Object.freeze({ run: projectFluxRunDto(value.run), queue: projectFluxQueueSnapshot(value.queue), events: Object.freeze(value.events.map(projectFluxEventDto)), nextEventSeq: value.nextEventSeq as number });
};
