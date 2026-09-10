import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { computeGenericPcbAgentHarnessRuleIdentity } from "../../src/cli/pcb-agent.js";
import { canonicalIdentity, canonicalJson } from "../../src/core/canonical.js";
import { FLUX_LEGACY_AUTHORED_NETCLASS_REVIEW_MESSAGE } from "../../src/flux/contracts.js";
import {
  createFluxDiagnostic,
  createProviderFailureDiagnostic,
  createProviderFailureEvidence,
  PROVIDER_FAILURE_ADAPTER_IDENTITY_SCHEMA_VERSION,
  PROVIDER_FAILURE_PARSER_IDENTITY_SCHEMA_VERSION,
  PROVIDER_FAILURE_TRANSPORT_IDENTITY_SCHEMA_VERSION,
  providerFailureEvidenceIdentity,
  type ProviderFailureLeaf
} from "../../src/domain/diagnostics.js";
import {
  createPcbProviderProfileBinding,
  PCB_DESIGN_INTERPRETER_ERROR_CODES,
  PcbDesignInterpreterError,
  type PcbProviderProfileBinding
} from "../../src/harness/pcb-design-interpreter.js";
import { parseFreshClearanceEvidenceReceipt, parseFreshNetClassPreparationEvidence, parseFreshNetClassSemanticAuthority } from "../../src/harness/fresh-clearance-evidence.js";
import { parseFreshProjectOpenPreparedSourceAuthority } from "../../src/harness/fresh-project.js";
import {
  FileFluxCompilationBundleStore,
  FluxError,
  FluxRunManager,
  FluxRunStore,
  createFluxOpenCheckpointReceipt,
  createFluxOpenPreflightReceipt,
  createFluxFreshClearanceEvidenceBinding,
  FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE,
  FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE,
  FLUX_CHECKPOINT_FAILURE_RECEIPT_SCHEMA_VERSION,
  FLUX_CHECKPOINT_FAILURE_SCHEMA_VERSION,
  FLUX_CHECKPOINT_OPERATION_TIMEOUT_MS,
  createFluxPcbInterpreterFailureEvidence,
  FLUX_LEGACY_CLEARANCE_REVIEW_MESSAGE,
  FLUX_LEGACY_FULL_SEMANTIC_AUTHORITY_REVIEW_MESSAGE,
  FLUX_LEGACY_SEMANTIC_REVIEW_MESSAGE,
  FLUX_LEGACY_TERMINAL_CLEARANCE_RECEIPT_REVIEW_MESSAGE,
  FLUX_SOCKET_RESTART_INVALIDATION_MESSAGE,
  FLUX_TOOLCHAIN_FAILURE_MESSAGE,
  fluxDigest,
  fluxOperationFailureEvidenceIdentity,
  fluxOpenPreparationDigest,
  projectFluxRunDto,
  projectFluxApprovalSubjectResult,
  type FluxCompilationBundleStore,
  type FluxCompilationInterpreterPort,
  type FluxContractStateDto,
  type FluxExecutionPorts,
  type FluxPersistedRun,
  type FluxPrepareRequest,
  type FluxRunManagerOptions
} from "../../src/flux/index.js";
import { createGenericDividerBundleFixture } from "../helpers/generic-divider-bundle.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

const SOURCE_DIGEST = "a".repeat(64);
const ISOLATED_DIGEST = "b".repeat(64);
const PREVIEW_DIGEST = "c".repeat(64);
const KICAD_TOOLCHAIN_IDENTITY = canonicalIdentity({ suite: "10.0.3", installation: "test" }, "evleda.test-kicad-toolchain.v1");
const INSPECTION_BRIDGE_IDENTITY = canonicalIdentity({ bridge: "test-readonly" }, "evleda.kicad-mcp-inspection-bridge.v2");
const EXECUTION_BRIDGE_IDENTITY = canonicalIdentity({ bridge: "test-write" }, "evleda.kicad-mcp-execution-bridge.v1");
const IPC_SOCKET_IDENTITY = canonicalIdentity({ socket: "run-bound" }, "evleda.kicad-api-socket-binding.v1");
const WRITE_SESSION_AUTHORITY_IDENTITY = canonicalIdentity({ mode: "write" }, "evleda.kicad-mcp-session-authority.v1");
const IPC_PROBE_SEMANTIC_IDENTITY = canonicalIdentity({ result: "same" }, "evleda.flux-open-ipc-probe-semantic.v2");
const CHECKPOINT_INSPECTION_SESSION_RECEIPT_IDENTITY = canonicalIdentity({ session: "checkpoint-read" }, "evleda.kicad-mcp-session-receipt.v1");
const WRITE_SESSION_RECEIPT_IDENTITY = canonicalIdentity({ session: "write" }, "evleda.kicad-mcp-session-receipt.v1");
const EXECUTION_INSPECTION_SESSION_RECEIPT_IDENTITY = canonicalIdentity({ session: "execution-read" }, "evleda.kicad-mcp-session-receipt.v1");
const DEFAULT_DIVIDER_BUNDLE = createGenericDividerBundleFixture().bundle;
const CLEARANCE_KICAD = { kind: "kicad-cli" as const, version: "10.0.3", commit: "abcdef0", sha256: "9".repeat(64), sizeBytes: 1, capabilityHelpSha256: "8".repeat(64), confirmedCapabilities: ["pcb drc"] };
const GENERIC_PROJECT_BINDING_IDENTITY = canonicalIdentity({ project: "fixture" }, "evleda.pcb-agent-generic-fresh-binding.v1");
const FRESH_MARKER_CONTENT_IDENTITY = { algorithm: "sha256" as const, digest: "7".repeat(64), size: 1 };
const TERMINAL_POWER_CLASS_NAME = `EVLEDA_${DEFAULT_DIVIDER_BUNDLE.identity.digest.slice(0, 12)}_C01`;
const TERMINAL_SENSE_CLASS_NAME = `EVLEDA_${DEFAULT_DIVIDER_BUNDLE.identity.digest.slice(0, 12)}_C02`;
const semanticNetClass = (name: string, clearance: number, width: number) => ({ bus_width: 12, clearance, diff_pair_gap: 0.25, diff_pair_via_gap: 0.25,
  diff_pair_width: width, line_style: 0, microvia_diameter: 0.3, microvia_drill: 0.1, name, pcb_color: "rgba(0, 0, 0, 0.000)", priority: -1,
  schematic_color: "rgba(0, 0, 0, 0.000)", track_width: width, tuning_profile: "", via_diameter: 0.6, via_drill: 0.3, wire_width: 6 });
const SEMANTIC_AUTHORITY_PAYLOAD = { schemaVersion: "evleda.fresh-netclass-semantic-authority.v2" as const, classification: "candidate-validation" as const, origin: "host" as const,
  fabricationAuthorized: false as const, qualificationEstablished: false as const, releaseAuthorized: false as const, bundleIdentity: DEFAULT_DIVIDER_BUNDLE.identity,
  contractIdentity: DEFAULT_DIVIDER_BUNDLE.contract.identity, genericProjectBindingIdentity: GENERIC_PROJECT_BINDING_IDENTITY, freshMarkerContentIdentity: FRESH_MARKER_CONTENT_IDENTITY,
  kicad: CLEARANCE_KICAD, ruleResolution: { boardMinimum: "absolute-floor" as const, netClassConflict: "larger-clearance" as const, customRules: "absent-or-empty-only" as const,
    localPadOrFootprintOverrides: "rejected" as const, zones: "rejected" as const, netClassPatterns: "host-generated-escaped-anchored-exact-contract-names" as const, derivedLabelAssignments: "empty-only" as const, contractNetAssignments: "exclusive" as const },
  boardMinimumClearanceMm: 0.2, netClasses: [semanticNetClass(TERMINAL_POWER_CLASS_NAME, 0.25, 0.5), semanticNetClass(TERMINAL_SENSE_CLASS_NAME, 0.2, 0.25)],
  contractNetAssignments: [{ netName: "GND", contractNetClassId: "POWER", kicadNetClassName: TERMINAL_POWER_CLASS_NAME },
    { netName: "VIN", contractNetClassId: "POWER", kicadNetClassName: TERMINAL_POWER_CLASS_NAME }, { netName: "VOUT", contractNetClassId: "SENSE", kicadNetClassName: TERMINAL_SENSE_CLASS_NAME }] };
const FRESH_NETCLASS_SEMANTIC_AUTHORITY = parseFreshNetClassSemanticAuthority({ ...SEMANTIC_AUTHORITY_PAYLOAD,
  identity: canonicalIdentity(SEMANTIC_AUTHORITY_PAYLOAD, SEMANTIC_AUTHORITY_PAYLOAD.schemaVersion) });
const MAX_SEMANTIC_CLASS_IDS = Array.from({ length: 32 }, (_, index) => `CLASS_${String(index).padStart(2, "0")}`);
const MAX_SEMANTIC_AUTHORITY_PAYLOAD = { ...SEMANTIC_AUTHORITY_PAYLOAD,
  netClasses: MAX_SEMANTIC_CLASS_IDS.map((_, index) => semanticNetClass(`EVLEDA_${DEFAULT_DIVIDER_BUNDLE.identity.digest.slice(0, 12)}_C${String(index + 1).padStart(2, "0")}`, 0.2, 0.25)),
  contractNetAssignments: Array.from({ length: 128 }, (_, index) => { const classIndex = Math.floor(index / 4); return { netName: `N${String(index).padStart(3, "0")}`,
    contractNetClassId: MAX_SEMANTIC_CLASS_IDS[classIndex]!, kicadNetClassName: `EVLEDA_${DEFAULT_DIVIDER_BUNDLE.identity.digest.slice(0, 12)}_C${String(classIndex + 1).padStart(2, "0")}` }; }) };
const MAX_FRESH_NETCLASS_SEMANTIC_AUTHORITY = parseFreshNetClassSemanticAuthority({ ...MAX_SEMANTIC_AUTHORITY_PAYLOAD,
  identity: canonicalIdentity(MAX_SEMANTIC_AUTHORITY_PAYLOAD, MAX_SEMANTIC_AUTHORITY_PAYLOAD.schemaVersion) });
const PREPARATION_EVIDENCE_PAYLOAD = { schemaVersion: "evleda.fresh-netclass-preparation-evidence.v2" as const, classification: "candidate-validation" as const, origin: "host" as const,
  fabricationAuthorized: false as const, qualificationEstablished: false as const, releaseAuthorized: false as const, bundleIdentity: DEFAULT_DIVIDER_BUNDLE.identity,
  contractIdentity: DEFAULT_DIVIDER_BUNDLE.contract.identity, genericProjectBindingIdentity: GENERIC_PROJECT_BINDING_IDENTITY,
  freshMarkerContentIdentity: FRESH_MARKER_CONTENT_IDENTITY, kicad: CLEARANCE_KICAD,
  materializationIdentity: canonicalIdentity({ materialization: "fixture" }, "evleda.fresh-netclass-materialization.v2"),
  semanticAuthorityIdentity: FRESH_NETCLASS_SEMANTIC_AUTHORITY.identity };
const FRESH_NETCLASS_PREPARATION_EVIDENCE = parseFreshNetClassPreparationEvidence({ ...PREPARATION_EVIDENCE_PAYLOAD,
  identity: canonicalIdentity(PREPARATION_EVIDENCE_PAYLOAD, PREPARATION_EVIDENCE_PAYLOAD.schemaVersion) });
const MAX_PREPARATION_EVIDENCE_PAYLOAD = { ...PREPARATION_EVIDENCE_PAYLOAD, semanticAuthorityIdentity: MAX_FRESH_NETCLASS_SEMANTIC_AUTHORITY.identity };
const MAX_FRESH_NETCLASS_PREPARATION_EVIDENCE = parseFreshNetClassPreparationEvidence({ ...MAX_PREPARATION_EVIDENCE_PAYLOAD,
  identity: canonicalIdentity(MAX_PREPARATION_EVIDENCE_PAYLOAD, MAX_PREPARATION_EVIDENCE_PAYLOAD.schemaVersion) });
const TERMINAL_RULE_RESOLUTION = { boardMinimum: "absolute-floor" as const, netClassConflict: "larger-clearance" as const,
  customRules: "absent-or-empty-only" as const, localPadOrFootprintOverrides: "rejected" as const, zones: "rejected" as const,
  netClassPatterns: "host-generated-escaped-anchored-exact-contract-names" as const, derivedLabelAssignments: "empty-only" as const, contractNetAssignments: "exclusive" as const };
const TERMINAL_SOURCE_IDENTITIES_BASE = { projectSettings: { algorithm: "sha256" as const, digest: "a".repeat(64), size: 1 }, customRules: null,
  pcb: { algorithm: "sha256" as const, digest: "b".repeat(64), size: 1 } };
const TERMINAL_RULE_SOURCE_SET_IDENTITY = canonicalIdentity({ schemaVersion: "evleda.fresh-clearance-rule-source-set.v2",
  ...TERMINAL_SOURCE_IDENTITIES_BASE, kicad: CLEARANCE_KICAD, resolution: TERMINAL_RULE_RESOLUTION }, "evleda.fresh-clearance-rule-source-set.v2");
const TERMINAL_NET_CLASSES = [
  { contractNetClassId: "POWER", kicadNetClassName: TERMINAL_POWER_CLASS_NAME, traceWidthMm: 0.5, configuredClearanceMm: 0.25, netNames: ["GND", "VIN"] },
  { contractNetClassId: "SENSE", kicadNetClassName: TERMINAL_SENSE_CLASS_NAME, traceWidthMm: 0.25, configuredClearanceMm: 0.2, netNames: ["VOUT"] },
] as const;
const TERMINAL_NETS = [
  { name: "GND", contractNetClassId: "POWER", kicadNetClassName: TERMINAL_POWER_CLASS_NAME, configuredClearanceMm: 0.25, effectiveClearanceMm: 0.25 },
  { name: "VIN", contractNetClassId: "POWER", kicadNetClassName: TERMINAL_POWER_CLASS_NAME, configuredClearanceMm: 0.25, effectiveClearanceMm: 0.25 },
  { name: "VOUT", contractNetClassId: "SENSE", kicadNetClassName: TERMINAL_SENSE_CLASS_NAME, configuredClearanceMm: 0.2, effectiveClearanceMm: 0.25 },
] as const;
const TERMINAL_PAIRS = [["GND", "VIN"], ["GND", "VOUT"], ["VIN", "VOUT"]].map(([leftNet, rightNet]) => ({ leftNet: leftNet!, rightNet: rightNet!, effectiveClearanceMm: 0.25, limitingSources: ["netclass:POWER"] }));
const TERMINAL_CLEARANCE_RECEIPT_PAYLOAD = { schemaVersion: "evleda.fresh-clearance-evidence-receipt.v2" as const, classification: "candidate-validation" as const, origin: "host" as const,
  fabricationAuthorized: false as const, qualificationEstablished: false as const, releaseAuthorized: false as const,
  bundleIdentity: FRESH_NETCLASS_PREPARATION_EVIDENCE.bundleIdentity, contractIdentity: FRESH_NETCLASS_PREPARATION_EVIDENCE.contractIdentity,
  genericProjectBindingIdentity: FRESH_NETCLASS_PREPARATION_EVIDENCE.genericProjectBindingIdentity, freshMarkerContentIdentity: FRESH_NETCLASS_PREPARATION_EVIDENCE.freshMarkerContentIdentity,
  kicad: CLEARANCE_KICAD, sourceIdentities: { ...TERMINAL_SOURCE_IDENTITIES_BASE, ruleSourceSet: TERMINAL_RULE_SOURCE_SET_IDENTITY }, ruleResolution: TERMINAL_RULE_RESOLUTION,
  boardMinimumClearanceMm: 0.2, netClasses: TERMINAL_NET_CLASSES, nets: TERMINAL_NETS, pairs: TERMINAL_PAIRS,
  acceptanceEvidence: { origin: "host" as const, schemaVersion: "evleda.fresh-design-clearance-evidence.v1" as const, source: "kicad-effective-netclass-rules" as const,
    pcbSha256: TERMINAL_SOURCE_IDENTITIES_BASE.pcb.digest, rulesSourceSha256: TERMINAL_RULE_SOURCE_SET_IDENTITY.digest,
    netClasses: [{ id: "POWER", configuredClearanceMm: 0.25, effectiveClearanceMm: 0.25 }, { id: "SENSE", configuredClearanceMm: 0.2, effectiveClearanceMm: 0.25 }] },
  evidenceLimitations: ["This is configuration/readback evidence, not a DRC result or geometry clearance measurement.",
    "Custom rules, zones, copper graphics, and pad/footprint local clearance overrides are rejected by the bounded model.",
    "Assignments are host-generated escaped anchored exact-contract-name patterns; the schematic-derived label cache must be empty (object or null). Exact net inventory is required because KiCad also applies an anchored wildcard matcher.",
    "KiCad 10.0.3 kicad-cli exposes no net-class or constraint-resolution inspection command; exact value evidence is source-readback, while the opt-in native fixture proves KiCad accepts those project bytes.",
    "KiCad executable identity is host-observed and path-free in this receipt; the caller must obtain it from the probed KiCad adapter."] };
const FRESH_CLEARANCE_EVIDENCE_RECEIPT = parseFreshClearanceEvidenceReceipt({ ...TERMINAL_CLEARANCE_RECEIPT_PAYLOAD,
  identity: canonicalIdentity(TERMINAL_CLEARANCE_RECEIPT_PAYLOAD, TERMINAL_CLEARANCE_RECEIPT_PAYLOAD.schemaVersion) });
const terminalClearanceReceiptForKicad = (kicad: typeof CLEARANCE_KICAD) => {
  const ruleSourceSet = canonicalIdentity({ schemaVersion: "evleda.fresh-clearance-rule-source-set.v2", ...TERMINAL_SOURCE_IDENTITIES_BASE,
    kicad, resolution: TERMINAL_RULE_RESOLUTION }, "evleda.fresh-clearance-rule-source-set.v2");
  const payload = { ...TERMINAL_CLEARANCE_RECEIPT_PAYLOAD, kicad,
    sourceIdentities: { ...TERMINAL_SOURCE_IDENTITIES_BASE, ruleSourceSet },
    acceptanceEvidence: { ...TERMINAL_CLEARANCE_RECEIPT_PAYLOAD.acceptanceEvidence, rulesSourceSha256: ruleSourceSet.digest } };
  return parseFreshClearanceEvidenceReceipt({ ...payload, identity: canonicalIdentity(payload, payload.schemaVersion) });
};
const preparedSourceAuthority = (projectRoot: string) => {
  const payload = { schemaVersion: "evleda.fresh-project-open-prepared-source-authority.v1" as const,
    projectIdentity: { canonicalPath: path.resolve(projectRoot), dev: null, ino: null },
    pro: { algorithm: "sha256" as const, digest: "1".repeat(64), size: 1 }, sch: { algorithm: "sha256" as const, digest: "2".repeat(64), size: 1 },
    pcb: { algorithm: "sha256" as const, digest: "3".repeat(64), size: 1 }, sym: { algorithm: "sha256" as const, digest: "4".repeat(64), size: 1 },
    fp: { algorithm: "sha256" as const, digest: "5".repeat(64), size: 1 }, marker: { algorithm: "sha256" as const, digest: "7".repeat(64), size: 1 } };
  return parseFreshProjectOpenPreparedSourceAuthority({ ...payload, identity: canonicalIdentity(payload, payload.schemaVersion) });
};
const FRESH_CLEARANCE_EVIDENCE_BINDING = createFluxFreshClearanceEvidenceBinding({
  kicad: CLEARANCE_KICAD,
  materializationIdentity: FRESH_NETCLASS_PREPARATION_EVIDENCE.materializationIdentity,
  receiptIdentity: FRESH_CLEARANCE_EVIDENCE_RECEIPT.identity,
  semanticAuthorityIdentity: FRESH_NETCLASS_PREPARATION_EVIDENCE.semanticAuthorityIdentity,
});
const GENERIC_COMPLETED_REPORT = { title: "Divider report", digest: "d".repeat(64), mediaType: "application/json", executionBridgeIdentity: EXECUTION_BRIDGE_IDENTITY,
  writeSessionAuthorityIdentity: WRITE_SESSION_AUTHORITY_IDENTITY, writeSessionReceiptIdentity: WRITE_SESSION_RECEIPT_IDENTITY,
  executionInspectionSessionReceiptIdentity: EXECUTION_INSPECTION_SESSION_RECEIPT_IDENTITY, freshClearanceEvidenceBinding: FRESH_CLEARANCE_EVIDENCE_BINDING,
  freshAcceptance: { passed: true, requirements: DEFAULT_DIVIDER_BUNDLE.acceptancePlan.rows.map((entry) => ({ id: entry.id, status: "pass" as const, detail: "Host fixture verified." })), missing: [],
    sourceHashes: { schematicSha256: "7".repeat(64), pcbSha256: "b".repeat(64) }, evidenceLimitations: ["Deterministic host fixture only."] } };
const checkpointReceipt = (request: Parameters<NonNullable<FluxExecutionPorts["checkpointOpen"]>>[0], isolatedFingerprint: string) => createFluxOpenCheckpointReceipt({
  schemaVersion: "evleda.flux-open-checkpoint.v6", runId: request.runId, openPreflightReceiptIdentity: request.openPreflightReceipt.identity,
  kicadToolchainIdentity: KICAD_TOOLCHAIN_IDENTITY, inspectionBridgeIdentity: INSPECTION_BRIDGE_IDENTITY, executionBridgeIdentity: EXECUTION_BRIDGE_IDENTITY,
  ipcSocketIdentity: IPC_SOCKET_IDENTITY, writeSessionAuthorityIdentity: WRITE_SESSION_AUTHORITY_IDENTITY, isolatedFingerprint, board: { algorithm: "sha256", digest: "7".repeat(64), size: 1 },
  editorLock: { algorithm: "sha256", digest: "8".repeat(64), size: 1 }, ipcProbeSemanticIdentity: IPC_PROBE_SEMANTIC_IDENTITY,
  checkpointInspectionSessionReceiptIdentity: CHECKPOINT_INSPECTION_SESSION_RECEIPT_IDENTITY,
  freshNetClassSemanticAuthorityIdentity: request.workflowKind === "generic" ? FRESH_NETCLASS_PREPARATION_EVIDENCE.semanticAuthorityIdentity : null,
  freshProjectOpenPreparedSourceAuthorityIdentity: request.workflowKind === "generic" ? request.freshProjectOpenPreparedSourceAuthority!.identity : null,
  freshNetClassPreparationEvidenceIdentity: request.workflowKind === "generic" ? request.freshNetClassPreparationEvidence!.identity : null
});
const providerFailureDiagnostic = (leaf: ProviderFailureLeaf = "OUTER_JSON_INVALID") => {
  const evidence = createProviderFailureEvidence({
    adapter: "codex",
    boundary: "cli_turn_output",
    leaf,
    providerErrorClass: "MALFORMED",
    checkpoints: {
      outerBytesWithinLimit: true,
      outerJsonParsed: false,
      outerShapeClosed: false,
      outerVersionMatched: false,
      outerTypesValid: false,
      argumentsStringsWithinLimit: true,
      argumentsJsonParsed: false,
      argumentsWithinLimit: true,
      turnSchemaValid: false,
      messageSchemaValid: false,
      callSchemaValid: false,
      toolNamesAllowed: true,
      callIdsUnique: true,
      parallelPolicyValid: true,
      requiredToolValid: false,
      stopReasonValid: false,
      cleanupCompleted: true,
    },
    identities: {
      adapter: canonicalIdentity({ adapter: "codex" }, PROVIDER_FAILURE_ADAPTER_IDENTITY_SCHEMA_VERSION),
      parser: canonicalIdentity({ parser: "closed-turn" }, PROVIDER_FAILURE_PARSER_IDENTITY_SCHEMA_VERSION),
      transportSchema: canonicalIdentity({ transport: "cli" }, PROVIDER_FAILURE_TRANSPORT_IDENTITY_SCHEMA_VERSION),
    },
    observations: {
      outerBytes: 7,
      outerSha256: "1".repeat(64),
      argumentsBytes: null,
      argumentsSha256: null,
      issues: [{ path: "$", code: "INVALID_JSON", observedType: "string" }],
    },
  });
  return createProviderFailureDiagnostic("PROVIDER_RESPONSE_INVALID", evidence);
};
const providerProfile = (): PcbProviderProfileBinding => createPcbProviderProfileBinding({
  provider: "codex",
  model: "gpt-test",
  tier: "priority",
  adapterSchemaVersion: "evleda.test-provider-adapter.v1"
});

const v2Receipt = (
  prompt: string,
  answers: readonly { readonly id: string; readonly answer: string }[],
  profile: PcbProviderProfileBinding,
  bundle: ReturnType<typeof createGenericDividerBundleFixture>["bundle"] | null
) => {
  const payload = {
    schemaVersion: "evleda.flux-interpreter-receipt.v2" as const,
    interpreterSchemaVersion: "evleda.pcb-design-interpreter.v1",
    provider: profile.provider,
    providerProfile: profile,
    providerProfileIdentity: profile.identity,
    promptDigest: fluxDigest(prompt),
    clarificationDigest: fluxDigest(answers),
    compilerProfileIdentity: bundle === null ? null : bundle.compilerProfile.identity,
    practiceProfileBindingIdentity: bundle === null ? null : bundle.practiceProfileBinding.identity,
    bundleIdentity: bundle === null ? null : bundle.identity,
    compiledAt: "2026-09-06T00:00:00.000Z"
  };
  return Object.freeze({ ...payload, identity: canonicalIdentity(payload, payload.schemaVersion) });
};

const readyState = (
  prompt: string,
  answers: readonly { readonly id: string; readonly answer: string }[],
  profile: PcbProviderProfileBinding,
  bundle: ReturnType<typeof createGenericDividerBundleFixture>["bundle"]
): FluxContractStateDto => Object.freeze({
  disposition: "ready",
  questions: [],
  issues: [],
  contract: bundle.contract,
  contractIdentity: bundle.contract.identity,
  libraryBindingIdentity: bundle.libraryBinding.identity,
  deepRuleBindingIdentity: bundle.deepRuleBinding.identity,
  acceptancePlanIdentity: bundle.acceptancePlan.identity,
  interpreterReceipt: v2Receipt(prompt, answers, profile, bundle)
});

const unresolvedState = (
  prompt: string,
  answers: readonly { readonly id: string; readonly answer: string }[],
  profile: PcbProviderProfileBinding,
  disposition: "needs_clarification" | "unsupported" = "needs_clarification"
): FluxContractStateDto => Object.freeze({
  disposition,
  questions: disposition === "needs_clarification" ? [{ id: "/scope/name", path: "/scope/name", question: "Name the candidate." }] : [],
  issues: [{ code: disposition === "unsupported" ? "UNSUPPORTED_V1_FEATURE" : "UNRESOLVED_FIELD", severity: "error" as const, path: "/scope/name", message: "Candidate name is unavailable.", clarificationId: disposition === "unsupported" ? null : "/scope/name" }],
  contract: null,
  contractIdentity: null,
  libraryBindingIdentity: null,
  deepRuleBindingIdentity: null,
  acceptancePlanIdentity: null,
  interpreterReceipt: v2Receipt(prompt, answers, profile, null)
});

interface Fixture {
  readonly base: string;
  readonly sourceRoot: string;
  readonly workspaceRoot: string;
  readonly prompt: string;
  readonly profile: PcbProviderProfileBinding;
  readonly bundleFixture: ReturnType<typeof createGenericDividerBundleFixture>;
  readonly store: FluxCompilationBundleStore;
  readonly manager: FluxRunManager;
  readonly projectId: string;
  readonly threadId: string;
  readonly setSourceDigest: (digest: string) => void;
  readonly managerOptions: () => FluxRunManagerOptions;
  readonly observedRequests: FluxPrepareRequest[];
}

const fixture = async (options: Readonly<{
  readonly ports?: Partial<FluxExecutionPorts>;
  readonly interpreter?: FluxCompilationInterpreterPort;
  readonly lifecycleObserver?: FluxRunManagerOptions["lifecycleObserver"];
  readonly operationFailureEvidenceCapacity?: number;
}> = {}): Promise<Fixture> => {
  const base = await mkdtemp(path.join(tmpdir(), "evleda-flux-bundle-lifecycle-")); roots.push(base);
  const sourceRoot = path.join(base, "source"); const workspaceRoot = path.join(base, "workspace");
  await mkdir(sourceRoot); await mkdir(workspaceRoot);
  const prompt = "Build a generic 10k/10k voltage divider candidate.";
  const bundleFixture = createGenericDividerBundleFixture(prompt); const profile = providerProfile();
  let currentSourceDigest = SOURCE_DIGEST;
  const observedRequests: FluxPrepareRequest[] = [];
  const interpreter = options.interpreter ?? {
    interpretCompilation: async ({ prompt: exactPrompt, clarificationAnswers }) => ({
      publicState: readyState(exactPrompt, clarificationAnswers, profile, bundleFixture.bundle),
      bundle: bundleFixture.bundle
    })
  };
  const rawStore = new FileFluxCompilationBundleStore(workspaceRoot, bundleFixture.dependencies);
  const defaultPorts: FluxExecutionPorts = {
    prepare: async (request) => {
      observedRequests.push(request);
      return { isolatedFingerprint: ISOLATED_DIGEST, checkpointRequired: true, freshNetClassPreparationEvidence: FRESH_NETCLASS_PREPARATION_EVIDENCE,
        freshNetClassSemanticAuthority: FRESH_NETCLASS_SEMANTIC_AUTHORITY,
        freshProjectOpenPreparedSourceAuthority: request.workflowKind === "generic" ? preparedSourceAuthority(path.join(workspaceRoot, "runs", request.runId, "project")) : null,
        preview: { title: "Divider", summary: "Prepared", artifactCount: 3, digest: PREVIEW_DIGEST } };
    },
    preflightOpen: async ({ projectId, runId, preparation }) => createFluxOpenPreflightReceipt({
      schemaVersion: "evleda.flux-open-preflight.v5", projectId, runId: runId!, preparationDigest: fluxOpenPreparationDigest(preparation!), suiteVersion: "10.0.3",
      installationRootIdentity: canonicalIdentity({ installation: "test" }, "evleda.test-kicad-installation-root.v1"),
      inspectionBridgeIdentity: INSPECTION_BRIDGE_IDENTITY, ipcSocketIdentity: IPC_SOCKET_IDENTITY,
      freshNetClassSemanticAuthorityIdentity: preparation?.workflowKind === "generic" ? preparation.freshNetClassPreparationEvidence!.semanticAuthorityIdentity : null,
      freshProjectOpenPreparedSourceAuthorityIdentity: preparation?.workflowKind === "generic" ? preparation.freshProjectOpenPreparedSourceAuthority!.identity : null,
      freshNetClassPreparationEvidenceIdentity: preparation?.workflowKind === "generic" ? preparation.freshNetClassPreparationEvidence!.identity : null,
      kicadCli: { algorithm: "sha256", digest: "4".repeat(64), size: 1 }, pcbnew: { algorithm: "sha256", digest: "5".repeat(64), size: 1 }, board: { algorithm: "sha256", digest: "6".repeat(64), size: 1 },
    }),
    cancelOpenPreflight: async () => undefined,
    open: async ({ preparation }) => {
      if (preparation !== undefined) observedRequests.push(preparation);
      return { opened: true, label: "Opened divider", checkpointRequired: true };
    },
    checkpointOpen: async (request) => {
      observedRequests.push(request);
      return { isolatedFingerprint: ISOLATED_DIGEST, checkpointRequired: false, preview: { title: "Divider", summary: "Checkpointed", artifactCount: 3, digest: PREVIEW_DIGEST },
        openCheckpointReceipt: checkpointReceipt(request, ISOLATED_DIGEST) };
    },
    execute: async (request) => {
      observedRequests.push(request);
      return { disposition: "completed", reports: [GENERIC_COMPLETED_REPORT], freshClearanceEvidenceReceipt: FRESH_CLEARANCE_EVIDENCE_RECEIPT };
    }
  };
  const managerOptions = (): FluxRunManagerOptions => ({
    workspaceRoot,
    sources: [{ key: "fresh", label: "New KiCad project", sourceRoot, fingerprint: SOURCE_DIGEST }],
    ports: { ...defaultPorts, ...options.ports },
    contractInterpreter: interpreter,
    compilationBundleStore: rawStore,
    sourceFingerprint: async () => currentSourceDigest,
    genericHarnessRuleIdentity: computeGenericPcbAgentHarnessRuleIdentity,
    activeKicadToolchainIdentity: KICAD_TOOLCHAIN_IDENTITY,
    activeInspectionBridgeIdentity: INSPECTION_BRIDGE_IDENTITY,
    activeExecutionBridgeIdentity: EXECUTION_BRIDGE_IDENTITY,
    ...(options.operationFailureEvidenceCapacity === undefined ? {} : { operationFailureEvidenceCapacity: options.operationFailureEvidenceCapacity }),
    ...(options.lifecycleObserver === undefined ? {} : { lifecycleObserver: options.lifecycleObserver })
  });
  const manager = new FluxRunManager(managerOptions()); await manager.initialize();
  const project = await manager.createProject("fresh", "Divider"); const thread = await manager.createThread(project.id, "Divider");
  return { base, sourceRoot, workspaceRoot, prompt, profile, bundleFixture, store: rawStore, manager, projectId: project.id, threadId: thread.id,
    setSourceDigest: (digest) => { currentSourceDigest = digest; }, managerOptions, observedRequests };
};

const createGenericRun = async (value: Fixture, idempotencyKey?: string, iterationCap = 2) => value.manager.createRun({
  projectId: value.projectId,
  threadId: value.threadId,
  prompt: value.prompt,
  providerModel: { provider: value.profile.provider, model: value.profile.model, tier: value.profile.tier },
  iterationCap,
  harnessRuleIdentity: "pending-until-compilation",
  mutationAllowlist: ["fresh_apply_contract_connectivity"],
  freshAcceptanceProfileIdentity: "acceptance-v1",
  freshPersistenceProfileIdentity: "persistence-v1",
  workflowKind: "generic"
}, idempotencyKey);

const blobPath = (workspaceRoot: string, reference: ReturnType<typeof createGenericDividerBundleFixture>["reference"]): string =>
  path.join(workspaceRoot, "content", "compilation-bundles", "blobs", "sha256", reference.contentIdentity.digest.slice(0, 2), reference.contentIdentity.digest.slice(2));

/** A historical fixture with v1 cache-based evidence and all original child links rederived. */
const cacheBasedV9State = (input: Record<string, any>, runId: string): Record<string, any> => {
  const state = structuredClone(input); const run = state.runs[runId]; const identities = new Map<string, unknown>();
  const rewrite = (value: any): any => {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(rewrite);
    const replacement = identities.get(canonicalJson(value));
    return replacement ?? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rewrite(child)]));
  };
  const archive = (value: Record<string, any>, changes: Record<string, unknown> = {}): Record<string, any> => {
    const { identity: prior, ...body } = value; const payload = rewrite({ ...body, ...changes });
    const identity = canonicalIdentity(payload, payload.schemaVersion); identities.set(canonicalJson(prior), identity); return { ...payload, identity };
  };
  const { derivedLabelAssignments: _cache, contractNetAssignments: _assignments, netClassPatterns: _patterns, ...receiptResolution } = run.freshNetClassSemanticAuthority.ruleResolution;
  const semantic = archive(run.freshNetClassSemanticAuthority, { schemaVersion: "evleda.fresh-netclass-semantic-authority.v1", ruleResolution: { ...receiptResolution, netClassPatterns: "rejected", contractNetAssignments: "exclusive" } });
  identities.set(canonicalJson(run.freshNetClassPreparationEvidence.materializationIdentity), canonicalIdentity({ historical: "cache-materialization" }, "evleda.fresh-netclass-materialization.v1"));
  const preparation = archive(run.freshNetClassPreparationEvidence, { schemaVersion: "evleda.fresh-netclass-preparation-evidence.v1" });
  let receipt;
  if (run.freshClearanceEvidenceReceipt !== undefined) {
    const current = run.freshClearanceEvidenceReceipt; const { ruleSourceSet: _ruleSource, ...sources } = current.sourceIdentities;
    const ruleSourceSet = canonicalIdentity({ schemaVersion: "evleda.fresh-clearance-rule-source-set.v1", ...sources, kicad: current.kicad, resolution: receiptResolution }, "evleda.fresh-clearance-rule-source-set.v1");
    identities.set(canonicalJson(current.sourceIdentities.ruleSourceSet), ruleSourceSet);
    receipt = archive(current, { schemaVersion: "evleda.fresh-clearance-evidence-receipt.v1", ruleResolution: receiptResolution,
      acceptanceEvidence: { ...current.acceptanceEvidence, rulesSourceSha256: ruleSourceSet.digest }, evidenceLimitations: current.evidenceLimitations.filter((line: string) => !line.startsWith("Assignments are ")).map((line: string) => line.replace("rejected by the bounded model", "rejected by V1")) });
  }
  if (run.openPreflightReceipt !== undefined) archive(run.openPreflightReceipt);
  if (run.openCheckpointReceipt !== undefined) archive(run.openCheckpointReceipt);
  for (const report of run.reports) if (report.freshClearanceEvidenceBinding !== undefined) archive(report.freshClearanceEvidenceBinding);
  const result = rewrite(state); result.schemaVersion = "evleda.flux.v9"; const historicalRun = result.runs[runId];
  historicalRun.freshNetClassSemanticAuthority = semantic; historicalRun.freshNetClassPreparationEvidence = preparation;
  if (receipt !== undefined) historicalRun.freshClearanceEvidenceReceipt = receipt;
  if (historicalRun.approval !== undefined) historicalRun.approval.subjectDigest = fluxDigest(historicalRun.approval.subject);
  return result;
};

describe("Flux v10 compilation-bundle lifecycle", () => {
  it("binds a new 24-turn budget in approval and never executes a consumed terminal 12-turn run again", async () => {
    const executed: number[] = [];
    const value = await fixture({ ports: { execute: async (request) => {
      expect(request.approval.iterationCap).toBe(request.iterationCap); executed.push(request.iterationCap);
      return { disposition: "needs_review" };
    } } });
    for (const cap of [12, 24]) {
      const run = await createGenericRun(value, `budget-create-${cap}`, cap);
      await value.manager.interpretRun(run.id); await value.manager.prepareRun(run.id); await value.manager.open(value.projectId, run.id); await value.manager.checkpointOpenRun(run.id);
      const subject = await value.manager.approvalSubject(run.id); expect(subject.subject.iterationCap).toBe(cap);
      expect(projectFluxApprovalSubjectResult(subject).subject.iterationCap).toBe(cap);
      await value.manager.approveRun(run.id, subject.digest); await value.manager.resumeRun(run.id, `budget-resume-${cap}`); await value.manager.waitForIdle();
      const store = new FluxRunStore(value.workspaceRoot); const terminal = await store.read();
      expect(terminal.runs[run.id]).toMatchObject({ phase: "needs_review", iterationCap: cap, approval: { subject: { iterationCap: cap }, consumedAt: expect.any(String) } });
      const restarted = new FluxRunManager(value.managerOptions()); await restarted.initialize();
      await restarted.resumeRun(run.id, `budget-resume-${cap}`); await restarted.waitForIdle();
      await expect(restarted.resumeRun(run.id, `different-budget-resume-${cap}`)).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
      await expect(restarted.approveRun(run.id, subject.digest)).rejects.toBeInstanceOf(FluxError);
      expect(await store.read()).toEqual(terminal);
      expect(projectFluxRunDto(await restarted.getRun(run.id)).iterationCap).toBe(cap);
    }
    expect(executed).toEqual([12, 24]);
    await expect(createGenericRun(value, "budget-create-25", 25)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("preserves v9 cache-based checkpoint failure settlement and replays its terminal receipt", async () => {
    let checkpoints = 0; const value = await fixture({ ports: { checkpointOpen: async () => { checkpoints += 1; throw new Error("native checkpoint failure"); } } });
    const run = await createGenericRun(value); await value.manager.interpretRun(run.id); await value.manager.prepareRun(run.id); await value.manager.open(value.projectId, run.id);
    const originalFailure = await value.manager.checkpointOpenRun(run.id, "v9-checkpoint-failure").catch((error: unknown) => error) as FluxError;
    expect(originalFailure).toMatchObject({ code: "OPERATION_UNCERTAIN" });
    const stateFile = path.join(value.workspaceRoot, "flux-state.json"); const legacy = cacheBasedV9State(JSON.parse(await readFile(stateFile, "utf8")), run.id);
    await writeFile(stateFile, `${JSON.stringify(legacy)}\n`, "utf8"); const migrated = await new FluxRunStore(value.workspaceRoot).read();
    expect(migrated).toEqual({ ...legacy, schemaVersion: "evleda.flux.v10" });
    const restarted = new FluxRunManager(value.managerOptions()); await restarted.initialize();
    await expect(restarted.checkpointOpenRun(run.id, "v9-checkpoint-failure")).rejects.toMatchObject({ code: "OPERATION_UNCERTAIN", terminalFailureReceipt: originalFailure.terminalFailureReceipt });
    expect(checkpoints).toBe(1); expect((await new FluxRunStore(value.workspaceRoot).read()).idempotency["v9-checkpoint-failure"]).toEqual(legacy.idempotency["v9-checkpoint-failure"]);
  });

  it("retains v9 cache-based completion evidence and reports exactly while blocking current authority", async () => {
    const value = await fixture(); const run = await createGenericRun(value);
    await value.manager.interpretRun(run.id); await value.manager.prepareRun(run.id); await value.manager.open(value.projectId, run.id); await value.manager.checkpointOpenRun(run.id);
    const subject = await value.manager.approvalSubject(run.id); await value.manager.approveRun(run.id, subject.digest); await value.manager.resumeRun(run.id); await value.manager.waitForIdle();
    const stateFile = path.join(value.workspaceRoot, "flux-state.json"); const legacy = cacheBasedV9State(JSON.parse(await readFile(stateFile, "utf8")), run.id);
    await writeFile(stateFile, `${JSON.stringify(legacy)}\n`, "utf8");
    const migrated = await new FluxRunStore(value.workspaceRoot).read();
    expect(migrated.schemaVersion).toBe("evleda.flux.v10"); expect(migrated.revision).toBe(legacy.revision);
    expect(migrated.runs[run.id]).toEqual({ ...legacy.runs[run.id], phase: "needs_review", blockedReason: FLUX_LEGACY_AUTHORED_NETCLASS_REVIEW_MESSAGE });
    expect(migrated.reports).toEqual(legacy.reports); expect(migrated.events).toEqual(legacy.events);
    const once = await readFile(stateFile, "utf8"); await new FluxRunStore(value.workspaceRoot).read(); expect(await readFile(stateFile, "utf8")).toBe(once);
    const restarted = new FluxRunManager(value.managerOptions()); await restarted.initialize();
    const historical = await restarted.getRun(run.id); expect(projectFluxRunDto(historical)).toEqual(historical);
    expect(() => projectFluxRunDto({ ...historical, phase: "completed" })).toThrow();
    await expect(restarted.approvalSubject(run.id)).rejects.toMatchObject({ code: "APPROVAL_MISMATCH" });
    await expect(restarted.resumeRun(run.id)).rejects.toMatchObject({ code: "APPROVAL_MISMATCH" });
  });

  it("downgrades v9 prepared cache-based authority without reminting or invoking Open", async () => {
    let opens = 0; const value = await fixture({ ports: { open: async () => { opens += 1; throw new Error("must not open"); } } });
    const run = await createGenericRun(value); await value.manager.interpretRun(run.id); await value.manager.prepareRun(run.id, "v9-prepare");
    const stateFile = path.join(value.workspaceRoot, "flux-state.json"); const legacy = cacheBasedV9State(JSON.parse(await readFile(stateFile, "utf8")), run.id);
    await writeFile(stateFile, `${JSON.stringify(legacy)}\n`, "utf8"); const migrated = await new FluxRunStore(value.workspaceRoot).read();
    expect(migrated.runs[run.id]).toEqual({ ...legacy.runs[run.id], phase: "needs_review", blockedReason: FLUX_LEGACY_AUTHORED_NETCLASS_REVIEW_MESSAGE });
    expect(migrated.idempotency["v9-prepare"]?.result).toMatchObject({ phase: "needs_review" });
    const restarted = new FluxRunManager(value.managerOptions()); await restarted.initialize();
    await expect(restarted.open(value.projectId, run.id)).rejects.toMatchObject({ code: "APPROVAL_MISMATCH" }); expect(opens).toBe(0);
    const invalid = structuredClone(migrated) as Record<string, any>; invalid.runs[run.id] = { ...invalid.runs[run.id], phase: "awaiting_open" };
    await writeFile(stateFile, `${JSON.stringify(invalid)}\n`, "utf8"); await expect(new FluxRunStore(value.workspaceRoot).read()).rejects.toMatchObject({ code: "STORE_CORRUPT" });
  });
  it("runs a non-LED divider through store, restart, Open/checkpoint, approval, resume, and verified execution", async () => {
    const value = await fixture();
    let gets = 0;
    const countedStore: FluxCompilationBundleStore = {
      put: (input) => value.store.put(input),
      get: async (input) => { gets += 1; return value.store.get(input); }
    };
    const first = new FluxRunManager({ ...value.managerOptions(), compilationBundleStore: countedStore }); await first.initialize();
    const project = await first.createProject("fresh", "Restart divider"); const thread = await first.createThread(project.id, "Restart divider");
    const run = await first.createRun({ projectId: project.id, threadId: thread.id, prompt: value.prompt,
      providerModel: { provider: value.profile.provider, model: value.profile.model, tier: value.profile.tier }, iterationCap: 2,
      harnessRuleIdentity: "pending", mutationAllowlist: ["fresh_apply_contract_connectivity"], freshAcceptanceProfileIdentity: "acceptance-v1",
      freshPersistenceProfileIdentity: "persistence-v1", workflowKind: "generic" });
    const interpreted = await first.interpretRun(run.id, "interpret-divider");
    expect(interpreted.phase).toBe("contract_ready");
    expect(interpreted.compilationBundleRef).toEqual(value.bundleFixture.reference);
    expect(interpreted.harnessRuleIdentity).toBe(computeGenericPcbAgentHarnessRuleIdentity(value.bundleFixture.bundle));
    expect(interpreted.contractState?.deepRuleSummary).toMatchObject({ schemaVersion: "evleda.flux-deep-rule-summary.v1", deepRuleBindingIdentity: value.bundleFixture.bundle.deepRuleBinding.identity,
      catalogIdentity: value.bundleFixture.bundle.deepRuleBinding.catalogIdentity, selectedCount: value.bundleFixture.bundle.deepRuleBinding.selection.rules.length,
      selectedRuleIds: [...value.bundleFixture.bundle.deepRuleBinding.selection.rules.map((rule) => rule.id)].sort() });
    expect(JSON.stringify(interpreted.contractState?.deepRuleSummary)).not.toMatch(/instruction|excerpt|https?:|dossier|prompt/iu);
    const stateText = await readFile(path.join(value.workspaceRoot, "flux-state.json"), "utf8");
    const storedRun = JSON.parse(stateText).runs[run.id] as Record<string, unknown>;
    expect(JSON.parse(stateText).schemaVersion).toBe("evleda.flux.v10");
    expect(JSON.parse(stateText).operationFailureEvidenceReservations).toEqual({});
    expect(storedRun.compilationBundleRef).toEqual(value.bundleFixture.reference);
    expect(storedRun.freshNetClassPreparationEvidence).toBeUndefined();
    expect(storedRun.freshProjectOpenPreparedSourceAuthority).toBeUndefined();
    expect(storedRun).not.toHaveProperty("compilationBundle");
    expect(stateText).not.toContain('"executionPrompt":');

    const restarted = new FluxRunManager({ ...value.managerOptions(), compilationBundleStore: countedStore }); await restarted.initialize();
    expect((await restarted.prepareRun(run.id, "prepare-divider")).phase).toBe("awaiting_open");
    await restarted.open(project.id, run.id, "open-divider");
    expect((await restarted.checkpointOpenRun(run.id, "checkpoint-divider")).phase).toBe("awaiting_approval");
    expect((await new FluxRunStore(value.workspaceRoot).read()).runs[run.id]?.freshNetClassPreparationEvidence).toEqual(FRESH_NETCLASS_PREPARATION_EVIDENCE);
    expect((await new FluxRunStore(value.workspaceRoot).read()).runs[run.id]?.freshNetClassSemanticAuthority).toEqual(FRESH_NETCLASS_SEMANTIC_AUTHORITY);
    expect((await new FluxRunStore(value.workspaceRoot).read()).runs[run.id]?.freshProjectOpenPreparedSourceAuthority?.identity.schemaVersion).toBe("evleda.fresh-project-open-prepared-source-authority.v1");
    const approval = await restarted.approvalSubject(run.id);
    expect(approval.subject).toMatchObject({
      schemaVersion: "evleda.flux-approval-subject.v6", workflowKind: "generic", sourceKey: "fresh", sourceFingerprint: SOURCE_DIGEST,
      compilationBundleRef: value.bundleFixture.reference, providerProfile: value.profile,
      bundleIdentity: value.bundleFixture.bundle.identity,
      compilerProfileIdentity: value.bundleFixture.bundle.compilerProfile.identity,
      practiceProfileBindingIdentity: value.bundleFixture.bundle.practiceProfileBinding.identity,
      executionPromptIdentity: value.bundleFixture.bundle.executionPrompt.identity,
      executionPromptContentIdentity: value.bundleFixture.bundle.executionPrompt.textContentIdentity,
      freshNetClassSemanticAuthorityIdentity: FRESH_NETCLASS_PREPARATION_EVIDENCE.semanticAuthorityIdentity,
      freshProjectOpenPreparedSourceAuthorityIdentity: preparedSourceAuthority(path.join(value.workspaceRoot, "runs", run.id, "project")).identity,
      freshNetClassPreparationEvidenceIdentity: FRESH_NETCLASS_PREPARATION_EVIDENCE.identity,
    });
    await restarted.approveRun(run.id, approval.digest, "approve-divider");
    await restarted.resumeRun(run.id, "resume-divider"); await restarted.waitForIdle();
    const completed = await restarted.getRun(run.id); expect(completed.phase).toBe("completed");
    expect(completed.reports[0]?.freshClearanceEvidenceBinding).toEqual(FRESH_CLEARANCE_EVIDENCE_BINDING);
    expect((await new FluxRunStore(value.workspaceRoot).read()).runs[run.id]?.freshClearanceEvidenceReceipt).toEqual(FRESH_CLEARANCE_EVIDENCE_RECEIPT);
    expect(JSON.stringify(completed)).not.toContain("freshNetClassPreparationEvidence");
    expect(JSON.stringify(completed)).not.toContain("freshNetClassSemanticAuthority");
    expect(JSON.stringify(completed)).not.toContain("freshProjectOpenPreparedSourceAuthority");
    expect(JSON.stringify(completed)).not.toContain("freshClearanceEvidenceReceipt");
    const terminalRestart = new FluxRunManager({ ...value.managerOptions(), compilationBundleStore: countedStore }); await terminalRestart.initialize();
    expect((await terminalRestart.getRun(run.id))).toMatchObject({ phase: "completed", reports: [{ freshClearanceEvidenceBinding: FRESH_CLEARANCE_EVIDENCE_BINDING }] });
    expect(gets).toBeGreaterThanOrEqual(13);
    expect(value.observedRequests.every((request) => request.workflowKind === "generic" && request.compilationBundleRef.contentIdentity.digest === value.bundleFixture.reference.contentIdentity.digest)).toBe(true);
    expect(JSON.stringify(await terminalRestart.getRun(run.id))).not.toContain('"executionPrompt":');
    expect(JSON.stringify(await terminalRestart.getRun(run.id))).not.toContain(value.workspaceRoot);
  });

  it("admits the maximum closed semantic prepare projection and rejects oversized envelope dimensions", async () => {
    let positive!: Fixture;
    positive = await fixture({ ports: { prepare: async (request) => ({ isolatedFingerprint: ISOLATED_DIGEST, checkpointRequired: true,
      freshNetClassPreparationEvidence: MAX_FRESH_NETCLASS_PREPARATION_EVIDENCE, freshNetClassSemanticAuthority: MAX_FRESH_NETCLASS_SEMANTIC_AUTHORITY,
      freshProjectOpenPreparedSourceAuthority: preparedSourceAuthority(path.join(positive.workspaceRoot, "runs", request.runId, "project")),
      preview: { title: "Maximum semantic authority", summary: "Prepared", artifactCount: 3, digest: PREVIEW_DIGEST } }) } });
    const positiveRun = await createGenericRun(positive); await positive.manager.interpretRun(positiveRun.id);
    await expect(positive.manager.prepareRun(positiveRun.id, "maximum-semantic-prepare")).resolves.toMatchObject({ phase: "awaiting_open" });

    const invalidAuthorities: readonly unknown[] = [
      { ...FRESH_NETCLASS_SEMANTIC_AUTHORITY, padding: Array.from({ length: 40 }, () => "x".repeat(14 * 1024)) },
      { ...FRESH_NETCLASS_SEMANTIC_AUTHORITY, padding: Array.from({ length: 1_000 }, () => Array.from({ length: 10 }, () => ({ value: 0 }))) },
      { ...FRESH_NETCLASS_SEMANTIC_AUTHORITY, padding: Array.from({ length: 1_025 }, () => 0) },
    ];
    for (const [index, invalidAuthority] of invalidAuthorities.entries()) {
      let value!: Fixture;
      value = await fixture({ ports: { prepare: async (request) => ({ isolatedFingerprint: ISOLATED_DIGEST, checkpointRequired: true,
        freshNetClassPreparationEvidence: FRESH_NETCLASS_PREPARATION_EVIDENCE, freshNetClassSemanticAuthority: invalidAuthority as never,
        freshProjectOpenPreparedSourceAuthority: preparedSourceAuthority(path.join(value.workspaceRoot, "runs", request.runId, "project")),
        preview: { title: "Invalid semantic authority", summary: "Prepared", artifactCount: 3, digest: PREVIEW_DIGEST } }) } });
      const run = await createGenericRun(value); await value.manager.interpretRun(run.id);
      await expect(value.manager.prepareRun(run.id, `invalid-semantic-envelope-${index}`)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }
  });

  it("binds Open authority to the exact preparation evidence, semantic identity, and prepared source", async () => {
    const value = await fixture(); const run = await createGenericRun(value);
    await value.manager.interpretRun(run.id, "interpret-semantic-digest");
    await value.manager.prepareRun(run.id, "prepare-semantic-digest");
    const prepared = await value.manager.verifiedPreparation(run.id);
    const replacementMaterializationPayload = {
      ...PREPARATION_EVIDENCE_PAYLOAD,
      materializationIdentity: canonicalIdentity({ materialization: "independent-idempotent-reverify" }, "evleda.fresh-netclass-materialization.v2"),
    };
    const replacementMaterializationEvidence = parseFreshNetClassPreparationEvidence({
      ...replacementMaterializationPayload,
      identity: canonicalIdentity(replacementMaterializationPayload, replacementMaterializationPayload.schemaVersion),
    });
    const changedOperationalReceipt = { ...prepared, freshNetClassPreparationEvidence: replacementMaterializationEvidence } as FluxPrepareRequest;
    expect(fluxOpenPreparationDigest(changedOperationalReceipt)).not.toBe(fluxOpenPreparationDigest(prepared));

    const replacementSemanticPayload = {
      ...replacementMaterializationPayload,
      semanticAuthorityIdentity: canonicalIdentity({ semantics: "changed" }, "evleda.fresh-netclass-semantic-authority.v2"),
    };
    const replacementSemanticEvidence = parseFreshNetClassPreparationEvidence({
      ...replacementSemanticPayload,
      identity: canonicalIdentity(replacementSemanticPayload, replacementSemanticPayload.schemaVersion),
    });
    const changedSemanticAuthority = { ...prepared, freshNetClassPreparationEvidence: replacementSemanticEvidence } as FluxPrepareRequest;
    expect(fluxOpenPreparationDigest(changedSemanticAuthority)).not.toBe(fluxOpenPreparationDigest(prepared));

    const preparedSource = prepared.freshProjectOpenPreparedSourceAuthority!;
    const changedPreparedSourcePayload = { ...preparedSource, sch: { ...preparedSource.sch, digest: "e".repeat(64) } };
    const { identity: _priorPreparedSourceIdentity, ...preparedSourcePreimage } = changedPreparedSourcePayload;
    const changedPreparedSource = parseFreshProjectOpenPreparedSourceAuthority({ ...preparedSourcePreimage,
      identity: canonicalIdentity(preparedSourcePreimage, preparedSourcePreimage.schemaVersion) });
    expect(fluxOpenPreparationDigest({ ...prepared, freshProjectOpenPreparedSourceAuthority: changedPreparedSource })).not.toBe(fluxOpenPreparationDigest(prepared));
  });

  it("clears every prepared, Open, checkpoint, and approval authority when an approved run is reinterpreted", async () => {
    const value = await fixture(); const run = await createGenericRun(value);
    await value.manager.interpretRun(run.id, "interpret-before-open");
    await value.manager.prepareRun(run.id, "prepare-before-reinterpret");
    await value.manager.open(value.projectId, run.id, "open-before-reinterpret");
    await value.manager.checkpointOpenRun(run.id, "checkpoint-before-reinterpret");
    const firstSubject = await value.manager.approvalSubject(run.id);
    await value.manager.approveRun(run.id, firstSubject.digest, "approve-before-reinterpret");

    const before = (await new FluxRunStore(value.workspaceRoot).read()).runs[run.id]!;
    expect(before).toMatchObject({ phase: "approved", openPreflightReceipt: { schemaVersion: "evleda.flux-open-preflight.v5" },
      openCheckpointReceipt: { schemaVersion: "evleda.flux-open-checkpoint.v6" }, approval: { subject: { schemaVersion: "evleda.flux-approval-subject.v6" } } });

    const reinterpreted = await value.manager.interpretRun(run.id, "reinterpret-after-approval");
    expect(reinterpreted.phase).toBe("contract_ready");
    const reset = (await new FluxRunStore(value.workspaceRoot).read()).runs[run.id]!;
    expect(reset).not.toHaveProperty("approval");
    expect(reset).not.toHaveProperty("isolatedFingerprint");
    expect(reset).not.toHaveProperty("preview");
    expect(reset).not.toHaveProperty("checkpointRequired");
    expect(reset).not.toHaveProperty("openPreflightReceipt");
    expect(reset).not.toHaveProperty("openCheckpointReceipt");
    expect(reset).not.toHaveProperty("freshNetClassSemanticAuthority");
    expect(reset).not.toHaveProperty("freshProjectOpenPreparedSourceAuthority");
    await expect(value.manager.approvalSubject(run.id)).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    expect((await value.manager.prepareRun(run.id, "prepare-after-reinterpret")).phase).toBe("awaiting_open");
  });

  it("binds approval to exact Open and KiCad toolchain receipts and never resurrects an A-to-B-to-A restart mismatch", async () => {
    const toolchainB = canonicalIdentity({ suite: "10.0.4", installation: "test-b" }, "evleda.test-kicad-toolchain.v1");
    const socketB = canonicalIdentity({ socket: "run-bound-b" }, "evleda.kicad-api-socket-binding.v1");
    const writeAuthorityB = canonicalIdentity({ mode: "write-b" }, "evleda.kicad-mcp-session-authority.v1");
    const value = await fixture(); const run = await createGenericRun(value);
    await value.manager.interpretRun(run.id); await value.manager.prepareRun(run.id); await value.manager.open(value.projectId, run.id); await value.manager.checkpointOpenRun(run.id);
    const subjectA = await value.manager.approvalSubject(run.id);

    await value.manager.interpretRun(run.id, "reinterpret-for-toolchain-b");
    const optionsB = value.managerOptions();
    const managerB = new FluxRunManager({ ...optionsB, activeKicadToolchainIdentity: toolchainB, ports: { ...optionsB.ports,
      preflightOpen: async ({ projectId, runId, preparation }) => createFluxOpenPreflightReceipt({ schemaVersion: "evleda.flux-open-preflight.v5", projectId, runId: runId!,
        preparationDigest: fluxOpenPreparationDigest(preparation!), suiteVersion: "10.0.4", installationRootIdentity: canonicalIdentity({ installation: "test-b" }, "evleda.test-kicad-installation-root.v1"),
        inspectionBridgeIdentity: INSPECTION_BRIDGE_IDENTITY, ipcSocketIdentity: socketB,
        freshNetClassSemanticAuthorityIdentity: preparation?.workflowKind === "generic" ? preparation.freshNetClassPreparationEvidence!.semanticAuthorityIdentity : null,
        freshProjectOpenPreparedSourceAuthorityIdentity: preparation?.workflowKind === "generic" ? preparation.freshProjectOpenPreparedSourceAuthority!.identity : null,
        freshNetClassPreparationEvidenceIdentity: preparation?.workflowKind === "generic" ? preparation.freshNetClassPreparationEvidence!.identity : null,
        kicadCli: { algorithm: "sha256", digest: "d".repeat(64), size: 2 }, pcbnew: { algorithm: "sha256", digest: "e".repeat(64), size: 2 }, board: { algorithm: "sha256", digest: "f".repeat(64), size: 2 } }),
      checkpointOpen: async (request) => ({ isolatedFingerprint: ISOLATED_DIGEST, checkpointRequired: false,
        preview: { title: "Divider", summary: "Checkpointed under B", artifactCount: 3, digest: PREVIEW_DIGEST },
        openCheckpointReceipt: createFluxOpenCheckpointReceipt({ schemaVersion: "evleda.flux-open-checkpoint.v6", runId: request.runId,
          openPreflightReceiptIdentity: request.openPreflightReceipt.identity, kicadToolchainIdentity: toolchainB, inspectionBridgeIdentity: INSPECTION_BRIDGE_IDENTITY, executionBridgeIdentity: EXECUTION_BRIDGE_IDENTITY,
          ipcSocketIdentity: socketB, writeSessionAuthorityIdentity: writeAuthorityB, isolatedFingerprint: ISOLATED_DIGEST,
          board: { algorithm: "sha256", digest: "1".repeat(64), size: 2 }, editorLock: { algorithm: "sha256", digest: "2".repeat(64), size: 2 },
          ipcProbeSemanticIdentity: canonicalIdentity({ result: "same-b" }, "evleda.flux-open-ipc-probe-semantic.v2"),
          checkpointInspectionSessionReceiptIdentity: canonicalIdentity({ session: "checkpoint-read-b" }, "evleda.kicad-mcp-session-receipt.v1"),
          freshNetClassSemanticAuthorityIdentity: request.freshNetClassPreparationEvidence!.semanticAuthorityIdentity,
          freshProjectOpenPreparedSourceAuthorityIdentity: request.freshProjectOpenPreparedSourceAuthority!.identity,
          freshNetClassPreparationEvidenceIdentity: request.freshNetClassPreparationEvidence!.identity }) }) } });
    await managerB.initialize(); await managerB.prepareRun(run.id); await managerB.open(value.projectId, run.id); await managerB.checkpointOpenRun(run.id);
    const subjectB = await managerB.approvalSubject(run.id);
    expect(subjectB.digest).not.toBe(subjectA.digest);
    expect(subjectB.subject.kicadToolchainIdentity).toEqual(toolchainB);
    expect(subjectB.subject.openPreflightReceiptIdentity).not.toEqual(subjectA.subject.openPreflightReceiptIdentity);
    expect(subjectB.subject.openCheckpointReceiptIdentity).not.toEqual(subjectA.subject.openCheckpointReceiptIdentity);

    const blockedValue = await fixture(); const blockedRun = await createGenericRun(blockedValue);
    await blockedValue.manager.interpretRun(blockedRun.id); await blockedValue.manager.prepareRun(blockedRun.id); await blockedValue.manager.open(blockedValue.projectId, blockedRun.id); await blockedValue.manager.checkpointOpenRun(blockedRun.id);
    const approvedA = await blockedValue.manager.approvalSubject(blockedRun.id); await blockedValue.manager.approveRun(blockedRun.id, approvedA.digest);
    const blockedOptions = blockedValue.managerOptions(); let executions = 0;
    const restartedB = new FluxRunManager({ ...blockedOptions, activeKicadToolchainIdentity: toolchainB, ports: { ...blockedOptions.ports, execute: async () => { executions += 1; return { disposition: "completed" }; } } });
    await restartedB.initialize(); expect(await restartedB.getRun(blockedRun.id)).toMatchObject({ phase: "blocked", blockedReason: expect.stringContaining("KiCad toolchain") });
    const restartedA = new FluxRunManager({ ...blockedOptions, ports: { ...blockedOptions.ports, execute: async () => { executions += 1; return { disposition: "completed" }; } } });
    await restartedA.initialize(); expect((await restartedA.getRun(blockedRun.id)).phase).toBe("blocked");
    await expect(restartedA.resumeRun(blockedRun.id)).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" }); expect(executions).toBe(0);
  });

  it("blocks inspection or execution bridge A-to-B restarts before approval consumption", async () => {
    const value = await fixture(); const run = await createGenericRun(value); let executions = 0;
    await value.manager.interpretRun(run.id); await value.manager.prepareRun(run.id); await value.manager.open(value.projectId, run.id); await value.manager.checkpointOpenRun(run.id);
    const approval = await value.manager.approvalSubject(run.id); await value.manager.approveRun(run.id, approval.digest);
    const bridgeB = canonicalIdentity({ bridge: "different-readonly-sidecar" }, "evleda.kicad-mcp-inspection-bridge.v2"); const options = value.managerOptions();
    const restarted = new FluxRunManager({ ...options, activeInspectionBridgeIdentity: bridgeB,
      ports: { ...options.ports, execute: async () => { executions += 1; return { disposition: "completed" }; } } });
    await restarted.initialize();
    const blocked = await restarted.getRun(run.id);
    expect(blocked).toMatchObject({ phase: "blocked", blockedReason: expect.stringContaining("inspection bridge") });
    expect(blocked.approval).not.toHaveProperty("consumedAt");
    await expect(restarted.resumeRun(run.id, "bridge-mismatch-resume")).rejects.toMatchObject({ code: "APPROVAL_MISMATCH" });
    expect(executions).toBe(0);

    const executionValue = await fixture(); const executionRun = await createGenericRun(executionValue);
    await executionValue.manager.interpretRun(executionRun.id); await executionValue.manager.prepareRun(executionRun.id); await executionValue.manager.open(executionValue.projectId, executionRun.id); await executionValue.manager.checkpointOpenRun(executionRun.id);
    const executionApproval = await executionValue.manager.approvalSubject(executionRun.id); await executionValue.manager.approveRun(executionRun.id, executionApproval.digest);
    const executionB = canonicalIdentity({ bridge: "different-write-sidecar" }, "evleda.kicad-mcp-execution-bridge.v1"); const executionOptions = executionValue.managerOptions();
    const executionRestart = new FluxRunManager({ ...executionOptions, activeExecutionBridgeIdentity: executionB }); await executionRestart.initialize();
    expect(await executionRestart.getRun(executionRun.id)).toMatchObject({ phase: "blocked", blockedReason: expect.stringContaining("bridge") });
    expect((await new FluxRunStore(executionValue.workspaceRoot).read()).runs[executionRun.id]?.approval?.consumedAt).toBeUndefined();
  });

  it("invalidates socket-bound approval on same-authority restart and requires new Open receipts and approval", async () => {
    const value = await fixture(); const run = await createGenericRun(value);
    await value.manager.interpretRun(run.id); await value.manager.prepareRun(run.id, "restart-prepare");
    await value.manager.open(value.projectId, run.id, "restart-open"); await value.manager.checkpointOpenRun(run.id, "restart-checkpoint");
    const oldSubject = await value.manager.approvalSubject(run.id); await value.manager.approveRun(run.id, oldSubject.digest, "restart-approve");

    const restarted = new FluxRunManager(value.managerOptions()); await restarted.initialize();
    const invalidated = await restarted.getRun(run.id);
    expect(invalidated).toMatchObject({ phase: "awaiting_open", checkpointRequired: true, blockedReason: FLUX_SOCKET_RESTART_INVALIDATION_MESSAGE });
    expect(invalidated).not.toHaveProperty("approval");
    const stored = await new FluxRunStore(value.workspaceRoot).read();
    expect(stored.runs[run.id]).not.toHaveProperty("openPreflightReceipt"); expect(stored.runs[run.id]).not.toHaveProperty("openCheckpointReceipt");
    expect(stored.idempotency["restart-open"]?.status).toBe("authority_invalidated"); expect(stored.idempotency["restart-checkpoint"]?.status).toBe("authority_invalidated"); expect(stored.idempotency["restart-approve"]?.status).toBe("authority_invalidated");
    await expect(restarted.open(value.projectId, run.id, "restart-open")).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    await restarted.open(value.projectId, run.id, "restart-open-new"); await restarted.checkpointOpenRun(run.id, "restart-checkpoint-new");
    const newSubject = await restarted.approvalSubject(run.id); expect((await restarted.getRun(run.id)).approval).toBeUndefined();
    await restarted.approveRun(run.id, newSubject.digest, "restart-approve-new"); expect((await restarted.getRun(run.id)).phase).toBe("approved");
  });

  it("keeps legacy Open/checkpoint v1-v2 authority readable but blocks it from resume", async () => {
    const value = await fixture(); const run = await createGenericRun(value);
    await value.manager.interpretRun(run.id); await value.manager.prepareRun(run.id); await value.manager.open(value.projectId, run.id); await value.manager.checkpointOpenRun(run.id);
    const approval = await value.manager.approvalSubject(run.id); await value.manager.approveRun(run.id, approval.digest);
    const stateFile = path.join(value.workspaceRoot, "flux-state.json"); const state = JSON.parse(await readFile(stateFile, "utf8")) as Record<string, any>; const stored = state.runs[run.id];
    const { inspectionBridgeIdentity: _inspection, ipcSocketIdentity: _socket, freshNetClassSemanticAuthorityIdentity: _preflightSemantic,
      freshProjectOpenPreparedSourceAuthorityIdentity: _preflightPreparedSource, freshNetClassPreparationEvidenceIdentity: _preflightPreparationEvidence,
      identity: _preflightIdentity, ...preflightRest } = stored.openPreflightReceipt;
    const preflightPayload = { ...preflightRest, schemaVersion: "evleda.flux-open-preflight.v1" }; const legacyPreflight = { ...preflightPayload, identity: canonicalIdentity(preflightPayload, preflightPayload.schemaVersion) };
    const { executionBridgeIdentity: _execution, ipcSocketIdentity: _checkpointSocket, writeSessionAuthorityIdentity: _write, ipcProbeSemanticIdentity: legacyIpcProbeIdentity,
      checkpointInspectionSessionReceiptIdentity: _checkpointSession, freshNetClassSemanticAuthorityIdentity: _checkpointSemantic,
      freshProjectOpenPreparedSourceAuthorityIdentity: _checkpointPreparedSource, freshNetClassPreparationEvidenceIdentity: _checkpointPreparationEvidence,
      identity: _checkpointIdentity, ...checkpointRest } = stored.openCheckpointReceipt;
    const checkpointPayload = { ...checkpointRest, schemaVersion: "evleda.flux-open-checkpoint.v2", openPreflightReceiptIdentity: legacyPreflight.identity, ipcProbeIdentity: legacyIpcProbeIdentity };
    const legacyCheckpoint = { ...checkpointPayload, identity: canonicalIdentity(checkpointPayload, checkpointPayload.schemaVersion) };
    const legacySubject = { ...stored.approval.subject, schemaVersion: "evleda.flux-approval-subject.v2", openPreflightReceiptIdentity: legacyPreflight.identity, openCheckpointReceiptIdentity: legacyCheckpoint.identity };
    delete legacySubject.inspectionBridgeIdentity; delete legacySubject.executionBridgeIdentity; delete legacySubject.ipcSocketIdentity; delete legacySubject.writeSessionAuthorityIdentity; delete legacySubject.ipcProbeSemanticIdentity; delete legacySubject.freshNetClassSemanticAuthorityIdentity; delete legacySubject.freshProjectOpenPreparedSourceAuthorityIdentity; delete legacySubject.freshNetClassPreparationEvidenceIdentity;
    delete stored.freshNetClassPreparationEvidence;
    delete stored.freshNetClassSemanticAuthority;
    delete stored.freshProjectOpenPreparedSourceAuthority;
    stored.openPreflightReceipt = legacyPreflight; stored.openCheckpointReceipt = legacyCheckpoint; stored.approval = { ...stored.approval, subject: legacySubject, subjectDigest: fluxDigest(legacySubject) };
    await writeFile(stateFile, `${JSON.stringify(state)}\n`, "utf8");

    expect((await new FluxRunStore(value.workspaceRoot).read()).runs[run.id]?.phase).toBe("approved");
    const restarted = new FluxRunManager(value.managerOptions()); await restarted.initialize();
    expect(await restarted.getRun(run.id)).toMatchObject({ phase: "blocked", blockedReason: expect.stringContaining("predates") });
    await expect(restarted.resumeRun(run.id)).rejects.toMatchObject({ code: "APPROVAL_MISMATCH" });
  });

  it("reads semantic-only Open v3/checkpoint v4/approval v4 history but never authorizes it", async () => {
    const value = await fixture(); const run = await createGenericRun(value);
    await value.manager.interpretRun(run.id); await value.manager.prepareRun(run.id); await value.manager.open(value.projectId, run.id); await value.manager.checkpointOpenRun(run.id);
    const approval = await value.manager.approvalSubject(run.id); await value.manager.approveRun(run.id, approval.digest);
    const stateFile = path.join(value.workspaceRoot, "flux-state.json"); const state = JSON.parse(await readFile(stateFile, "utf8")) as Record<string, any>; const stored = state.runs[run.id];
    const { identity: _preflightIdentity, freshProjectOpenPreparedSourceAuthorityIdentity: _preparedSourceIdentity,
      freshNetClassPreparationEvidenceIdentity: _preparationEvidenceIdentity, ...preflightRest } = stored.openPreflightReceipt;
    const preflightPayload = { ...preflightRest, schemaVersion: "evleda.flux-open-preflight.v3" }; const legacyPreflight = { ...preflightPayload, identity: canonicalIdentity(preflightPayload, preflightPayload.schemaVersion) };
    const { identity: _checkpointIdentity, freshProjectOpenPreparedSourceAuthorityIdentity: _checkpointPreparedSourceIdentity,
      freshNetClassPreparationEvidenceIdentity: _checkpointPreparationEvidenceIdentity, ...checkpointRest } = stored.openCheckpointReceipt;
    const checkpointPayload = { ...checkpointRest, schemaVersion: "evleda.flux-open-checkpoint.v4", openPreflightReceiptIdentity: legacyPreflight.identity };
    const legacyCheckpoint = { ...checkpointPayload, identity: canonicalIdentity(checkpointPayload, checkpointPayload.schemaVersion) };
    const legacySubject = { ...stored.approval.subject, schemaVersion: "evleda.flux-approval-subject.v4", openPreflightReceiptIdentity: legacyPreflight.identity, openCheckpointReceiptIdentity: legacyCheckpoint.identity };
    delete legacySubject.freshProjectOpenPreparedSourceAuthorityIdentity;
    delete legacySubject.freshNetClassPreparationEvidenceIdentity;
    stored.openPreflightReceipt = legacyPreflight; stored.openCheckpointReceipt = legacyCheckpoint;
    stored.approval = { ...stored.approval, subject: legacySubject, subjectDigest: fluxDigest(legacySubject) };
    await writeFile(stateFile, `${JSON.stringify(state)}\n`, "utf8");
    expect((await new FluxRunStore(value.workspaceRoot).read()).runs[run.id]?.phase).toBe("approved");
    const restarted = new FluxRunManager(value.managerOptions()); await restarted.initialize();
    expect(await restarted.getRun(run.id)).toMatchObject({ phase: "blocked", blockedReason: expect.stringContaining("predates") });
    await expect(restarted.resumeRun(run.id)).rejects.toMatchObject({ code: "APPROVAL_MISMATCH" });
  });

  it("reads prepared-source Open v4/checkpoint v5/approval v5 history but never authorizes it", async () => {
    const value = await fixture(); const run = await createGenericRun(value);
    await value.manager.interpretRun(run.id); await value.manager.prepareRun(run.id); await value.manager.open(value.projectId, run.id); await value.manager.checkpointOpenRun(run.id);
    const approval = await value.manager.approvalSubject(run.id); await value.manager.approveRun(run.id, approval.digest);
    const stateFile = path.join(value.workspaceRoot, "flux-state.json"); const state = JSON.parse(await readFile(stateFile, "utf8")) as Record<string, any>; const stored = state.runs[run.id];
    const { freshNetClassPreparationEvidenceIdentity: _preflightPreparationIdentity, identity: _preflightIdentity, ...preflightRest } = stored.openPreflightReceipt;
    const preflightPayload = { ...preflightRest, schemaVersion: "evleda.flux-open-preflight.v4" }; const legacyPreflight = { ...preflightPayload, identity: canonicalIdentity(preflightPayload, preflightPayload.schemaVersion) };
    const { freshNetClassPreparationEvidenceIdentity: _checkpointPreparationIdentity, identity: _checkpointIdentity, ...checkpointRest } = stored.openCheckpointReceipt;
    const checkpointPayload = { ...checkpointRest, schemaVersion: "evleda.flux-open-checkpoint.v5", openPreflightReceiptIdentity: legacyPreflight.identity };
    const legacyCheckpoint = { ...checkpointPayload, identity: canonicalIdentity(checkpointPayload, checkpointPayload.schemaVersion) };
    const legacySubject = { ...stored.approval.subject, schemaVersion: "evleda.flux-approval-subject.v5", openPreflightReceiptIdentity: legacyPreflight.identity, openCheckpointReceiptIdentity: legacyCheckpoint.identity };
    delete legacySubject.freshNetClassPreparationEvidenceIdentity; stored.openPreflightReceipt = legacyPreflight; stored.openCheckpointReceipt = legacyCheckpoint;
    stored.approval = { ...stored.approval, subject: legacySubject, subjectDigest: fluxDigest(legacySubject) }; await writeFile(stateFile, `${JSON.stringify(state)}\n`, "utf8");
    expect((await new FluxRunStore(value.workspaceRoot).read()).runs[run.id]?.phase).toBe("approved");
    const restarted = new FluxRunManager(value.managerOptions()); await restarted.initialize(); expect((await restarted.getRun(run.id)).phase).toBe("blocked");
    await expect(restarted.resumeRun(run.id)).rejects.toMatchObject({ code: "APPROVAL_MISMATCH" });
  });

  it("rejects an outside-workspace prepared-source authority before Open preflight", async () => {
    let preflights = 0;
    const value = await fixture({ ports: { preflightOpen: async () => { preflights += 1; throw new Error("must not preflight"); } } });
    const run = await createGenericRun(value); await value.manager.interpretRun(run.id); await value.manager.prepareRun(run.id);
    const stateFile = path.join(value.workspaceRoot, "flux-state.json"); const state = JSON.parse(await readFile(stateFile, "utf8")) as Record<string, any>;
    state.runs[run.id].freshProjectOpenPreparedSourceAuthority = preparedSourceAuthority(path.join(value.base, "outside-project"));
    await writeFile(stateFile, `${JSON.stringify(state)}\n`, "utf8");
    const restarted = new FluxRunManager(value.managerOptions()); await restarted.initialize();
    await expect(restarted.open(value.projectId, run.id, "outside-source-authority")).rejects.toMatchObject({ code: "PATH_POLICY" });
    expect(preflights).toBe(0);
  });

  it("migrates legacy nonterminal state without full semantic authority but refuses Open before preflight", async () => {
    let preflights = 0; const value = await fixture({ ports: { preflightOpen: async () => { preflights += 1; throw new Error("must not preflight"); } } });
    const run = await createGenericRun(value); await value.manager.interpretRun(run.id); await value.manager.prepareRun(run.id);
    const stateFile = path.join(value.workspaceRoot, "flux-state.json"); const state = JSON.parse(await readFile(stateFile, "utf8")) as Record<string, any>;
    state.schemaVersion = "evleda.flux.v7"; delete state.runs[run.id].freshNetClassSemanticAuthority; await writeFile(stateFile, `${JSON.stringify(state)}\n`, "utf8");
    const restarted = new FluxRunManager(value.managerOptions()); await restarted.initialize();
    await expect(restarted.open(value.projectId, run.id, "legacy-missing-full-semantic")).rejects.toMatchObject({ code: "APPROVAL_MISMATCH" });
    expect(preflights).toBe(0);
  });

  it("rejects a coherently rehashed Open receipt that no longer binds the exact prepared authority", async () => {
    const value = await fixture(); const run = await createGenericRun(value);
    await value.manager.interpretRun(run.id); await value.manager.prepareRun(run.id); await value.manager.open(value.projectId, run.id); await value.manager.checkpointOpenRun(run.id);
    const subject = await value.manager.approvalSubject(run.id); await value.manager.approveRun(run.id, subject.digest);
    const stateStore = new FluxRunStore(value.workspaceRoot); const approved = (await stateStore.read()).runs[run.id]!;
    const priorPreflight = approved.openPreflightReceipt!; const priorCheckpoint = approved.openCheckpointReceipt!;
    if (priorPreflight.schemaVersion !== "evleda.flux-open-preflight.v5" || priorCheckpoint.schemaVersion !== "evleda.flux-open-checkpoint.v6") throw new Error("expected current Open receipts");
    const changedPreflight = createFluxOpenPreflightReceipt({ schemaVersion: priorPreflight.schemaVersion, projectId: priorPreflight.projectId, runId: priorPreflight.runId,
      preparationDigest: "f".repeat(64), suiteVersion: priorPreflight.suiteVersion, installationRootIdentity: priorPreflight.installationRootIdentity,
      inspectionBridgeIdentity: priorPreflight.inspectionBridgeIdentity, ipcSocketIdentity: priorPreflight.ipcSocketIdentity,
      freshNetClassSemanticAuthorityIdentity: priorPreflight.freshNetClassSemanticAuthorityIdentity,
      freshProjectOpenPreparedSourceAuthorityIdentity: priorPreflight.freshProjectOpenPreparedSourceAuthorityIdentity,
      freshNetClassPreparationEvidenceIdentity: priorPreflight.freshNetClassPreparationEvidenceIdentity,
      kicadCli: priorPreflight.kicadCli, pcbnew: priorPreflight.pcbnew, board: priorPreflight.board });
    const changedCheckpoint = createFluxOpenCheckpointReceipt({ schemaVersion: priorCheckpoint.schemaVersion, runId: priorCheckpoint.runId,
      openPreflightReceiptIdentity: changedPreflight.identity, kicadToolchainIdentity: priorCheckpoint.kicadToolchainIdentity,
      inspectionBridgeIdentity: priorCheckpoint.inspectionBridgeIdentity, executionBridgeIdentity: priorCheckpoint.executionBridgeIdentity,
      ipcSocketIdentity: priorCheckpoint.ipcSocketIdentity, writeSessionAuthorityIdentity: priorCheckpoint.writeSessionAuthorityIdentity,
      isolatedFingerprint: priorCheckpoint.isolatedFingerprint, board: priorCheckpoint.board, editorLock: priorCheckpoint.editorLock,
      ipcProbeSemanticIdentity: priorCheckpoint.ipcProbeSemanticIdentity, checkpointInspectionSessionReceiptIdentity: priorCheckpoint.checkpointInspectionSessionReceiptIdentity,
      freshNetClassSemanticAuthorityIdentity: priorCheckpoint.freshNetClassSemanticAuthorityIdentity,
      freshProjectOpenPreparedSourceAuthorityIdentity: priorCheckpoint.freshProjectOpenPreparedSourceAuthorityIdentity,
      freshNetClassPreparationEvidenceIdentity: priorCheckpoint.freshNetClassPreparationEvidenceIdentity });
    const changedSubject = { ...approved.approval!.subject, openPreflightReceiptIdentity: changedPreflight.identity, openCheckpointReceiptIdentity: changedCheckpoint.identity };
    await stateStore.replace((state) => ({ ...state, runs: { ...state.runs, [run.id]: { ...approved, openPreflightReceipt: changedPreflight,
      openCheckpointReceipt: changedCheckpoint, approval: { ...approved.approval!, subject: changedSubject, subjectDigest: fluxDigest(changedSubject) } } } }));
    await expect(value.manager.resumeRun(run.id)).rejects.toMatchObject({ code: "APPROVAL_MISMATCH" });
  });

  it("stores no authority for clarification/unsupported output and rejects a non-ready bundle", async () => {
    let mode: "clarify" | "unsupported" | "invalid" = "clarify";
    const profile = providerProfile(); const bundleFixture = createGenericDividerBundleFixture();
    const interpreter: FluxCompilationInterpreterPort = {
      interpretCompilation: async ({ prompt, clarificationAnswers }) => mode === "invalid"
        ? { publicState: unresolvedState(prompt, clarificationAnswers, profile), bundle: bundleFixture.bundle }
        : mode === "unsupported"
          ? { publicState: unresolvedState(prompt, clarificationAnswers, profile, "unsupported"), bundle: null }
          : clarificationAnswers.length === 0
            ? { publicState: unresolvedState(prompt, clarificationAnswers, profile), bundle: null }
            : { publicState: readyState(prompt, clarificationAnswers, profile, bundleFixture.bundle), bundle: bundleFixture.bundle }
    };
    const value = await fixture({ interpreter }); const run = await createGenericRun(value);
    const clarification = await value.manager.interpretRun(run.id);
    expect(clarification.phase).toBe("awaiting_clarification");
    expect(clarification.compilationBundleRef).toBeUndefined();
    const ready = await value.manager.clarifyRun(run.id, [{ id: "/scope/name", answer: "Divider" }]);
    expect(ready.phase).toBe("contract_ready"); expect(ready.compilationBundleRef).toBeDefined();

    mode = "unsupported";
    const unsupportedRun = await createGenericRun(value); const unsupported = await value.manager.interpretRun(unsupportedRun.id);
    expect(unsupported.contractState?.disposition).toBe("unsupported"); expect(unsupported.compilationBundleRef).toBeUndefined();
    await expect(value.manager.prepareRun(unsupportedRun.id)).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });

    mode = "invalid";
    const invalidRun = await createGenericRun(value);
    await expect(value.manager.interpretRun(invalidRun.id)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect((await value.manager.getRun(invalidRun.id)).phase).toBe("blocked");
  });

  it("rejects unknown interpreter projection fields before bundle storage or public persistence", async () => {
    const profile = providerProfile(); const bundleFixture = createGenericDividerBundleFixture();
    let variant: "state" | "receipt" | "identity" | "question" | "envelope" = "state";
    const value = await fixture({ interpreter: {
      interpretCompilation: async ({ prompt, clarificationAnswers }) => {
        const ready = readyState(prompt, clarificationAnswers, profile, bundleFixture.bundle);
        if (variant === "envelope") return { publicState: ready, bundle: bundleFixture.bundle, unexpected: true } as never;
        if (variant === "question") {
          const unresolved = unresolvedState(prompt, clarificationAnswers, profile);
          return { publicState: { ...unresolved, questions: [{ ...unresolved.questions[0]!, executionPrompt: "private" }] }, bundle: null } as never;
        }
        if (variant === "receipt") return { publicState: { ...ready, interpreterReceipt: { ...ready.interpreterReceipt, unexpected: true } }, bundle: bundleFixture.bundle } as never;
        if (variant === "identity") return { publicState: { ...ready, contractIdentity: { ...ready.contractIdentity!, unexpected: true } }, bundle: bundleFixture.bundle } as never;
        return { publicState: { ...ready, compilationBundle: bundleFixture.bundle }, bundle: bundleFixture.bundle } as never;
      }
    } });
    for (const current of ["state", "receipt", "identity", "question", "envelope"] as const) {
      variant = current; const run = await createGenericRun(value);
      await expect(value.manager.interpretRun(run.id), current).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      const blocked = await value.manager.getRun(run.id);
      expect(blocked.phase).toBe("blocked"); expect(blocked.contractState).toBeUndefined(); expect(blocked.compilationBundleRef).toBeUndefined();
    }
    const stateText = await readFile(path.join(value.workspaceRoot, "flux-state.json"), "utf8");
    expect(stateText).not.toContain('"executionPrompt"'); expect(stateText).not.toContain('"compilationBundle"');
    await expect(readFile(blobPath(value.workspaceRoot, bundleFixture.reference))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("discards an interpreter result when prompt authority changes while the provider call is in flight", async () => {
    const entered = deferred<void>(); const release = deferred<void>(); const profile = providerProfile(); const bundleFixture = createGenericDividerBundleFixture();
    const value = await fixture({ interpreter: { interpretCompilation: async ({ prompt, clarificationAnswers }) => {
      entered.resolve(); await release.promise;
      return { publicState: readyState(prompt, clarificationAnswers, profile, bundleFixture.bundle), bundle: bundleFixture.bundle };
    } } });
    const run = await createGenericRun(value); const pending = value.manager.interpretRun(run.id);
    await entered.promise;
    const stateStore = new FluxRunStore(value.workspaceRoot);
    await stateStore.replace((state) => ({ ...state, runs: { ...state.runs, [run.id]: { ...state.runs[run.id]!, prompt: `${value.prompt} changed` } } }));
    release.resolve();
    await expect(pending).rejects.toMatchObject({ code: "APPROVAL_MISMATCH" });
    const blocked = await value.manager.getRun(run.id);
    expect(blocked.phase).toBe("blocked"); expect(blocked.contractState).toBeUndefined(); expect(blocked.compilationBundleRef).toBeUndefined();
  });

  it("rejects an in-flight idempotency mutation that would detach its evidence reservation", async () => {
    const entered = deferred<void>(); const release = deferred<void>(); const profile = providerProfile(); const bundleFixture = createGenericDividerBundleFixture();
    const value = await fixture({ interpreter: { interpretCompilation: async ({ prompt, clarificationAnswers }) => {
      entered.resolve(); await release.promise;
      return { publicState: readyState(prompt, clarificationAnswers, profile, bundleFixture.bundle), bundle: bundleFixture.bundle };
    } } });
    const run = await createGenericRun(value); const pending = value.manager.interpretRun(run.id, "mutated-receipt"); await entered.promise;
    const stateStore = new FluxRunStore(value.workspaceRoot);
    await expect(stateStore.replace((state) => ({ ...state, idempotency: { ...state.idempotency,
      "mutated-receipt": { ...state.idempotency["mutated-receipt"]!, digest: "f".repeat(64) } } }))).rejects.toMatchObject({ code: "STORE_CORRUPT" });
    release.resolve();
    await expect(pending).resolves.toMatchObject({ phase: "contract_ready" });
    expect((await new FluxRunStore(value.workspaceRoot).read()).operationFailureEvidenceReservations).toEqual({});
  });

  it.each(["raw_dependency", "malformed_result", "uncleared_checkpoint", "intent_observer", "completion_observer", "pre_port_authority", "post_port_authority", "commit"] as const)("settles every admitted checkpoint failure once: %s", async (stage) => {
    let calls = 0; let context: Parameters<NonNullable<FluxExecutionPorts["checkpointOpen"]>>[1] | undefined;
    const value = await fixture({ ports: { checkpointOpen: async (request, operationContext) => {
      calls += 1; context = operationContext;
      if (stage === "raw_dependency") throw new Error("private dependency path C:/secret/board.kicad_pcb");
      if (stage === "malformed_result") return { privateResult: "secret" } as never;
      return { isolatedFingerprint: ISOLATED_DIGEST, checkpointRequired: stage === "uncleared_checkpoint",
        preview: { title: "Checkpoint", summary: "Completed", artifactCount: 3, digest: PREVIEW_DIGEST }, openCheckpointReceipt: checkpointReceipt(request, ISOLATED_DIGEST) };
    } }, lifecycleObserver: ({ operation, phase }) => {
      if (operation !== "checkpoint_open") return;
      if ((stage === "intent_observer" && phase === "intent_persisted") || (stage === "completion_observer" && phase === "side_effect_completed")) throw new Error("private observer failure");
      if ((stage === "pre_port_authority" && phase === "intent_persisted") || (stage === "post_port_authority" && phase === "side_effect_completed")) value.setSourceDigest("f".repeat(64));
    } });
    const run = await createGenericRun(value); await value.manager.interpretRun(run.id); await value.manager.prepareRun(run.id); await value.manager.open(value.projectId, run.id);
    const originalReplace = FluxRunStore.prototype.replace;
    const commitSpy = stage !== "commit" ? undefined : vi.spyOn(FluxRunStore.prototype, "replace").mockImplementation(async function (this: FluxRunStore, mutator, guard) {
      return originalReplace.call(this, (state) => { const next = mutator(state); if (next.runs[run.id]?.phase === "awaiting_approval") throw new Error("private commit failure"); return next; }, guard);
    });
    const key = `checkpoint-failure-${stage}`;
    try {
      const outcomes = await Promise.all([value.manager.checkpointOpenRun(run.id, key), value.manager.checkpointOpenRun(run.id, key)].map((pending) => pending.catch((error: unknown) => error)));
      const failure = outcomes[0] as FluxError;
      expect(outcomes[1]).toBe(failure);
      expect(failure).toMatchObject({ code: "OPERATION_UNCERTAIN", message: FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE, details: {} });
      expect(context?.signal.aborted ?? true).toBe(true);
      const state = await new FluxRunStore(value.workspaceRoot).read(); const blocked = state.runs[run.id]!;
      expect(blocked).toMatchObject({ phase: "blocked", checkpointRequired: true, blockedReason: FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE });
      expect(blocked.inFlightOperation).toBeUndefined(); expect(blocked.approval).toBeUndefined(); expect(blocked.openCheckpointReceipt).toBeUndefined();
      expect(state.idempotency[key]).toMatchObject({ status: "failed", terminalReceipt: { outcome: "failed", at: blocked.updatedAt } });
      expect(state.events.filter((item) => item.runId === run.id && item.kind === "run_blocked")).toHaveLength(1);
      const receipt = failure.terminalFailureReceipt!; const { identity: receiptIdentity, ...payload } = receipt;
      expect(receipt).toMatchObject({ schemaVersion: FLUX_CHECKPOINT_FAILURE_RECEIPT_SCHEMA_VERSION, operation: "checkpoint_open", idempotencyKey: key,
        requestDigest: fluxDigest({ runId: run.id }), projectId: run.projectId, threadId: run.threadId, runId: run.id, terminalPhase: "blocked", outcome: "failed", completedAt: blocked.updatedAt,
        failureIdentity: canonicalIdentity({ code: "OPERATION_UNCERTAIN", message: FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE, details: {} }, FLUX_CHECKPOINT_FAILURE_SCHEMA_VERSION) });
      expect(receiptIdentity).toEqual(canonicalIdentity(payload, FLUX_CHECKPOINT_FAILURE_RECEIPT_SCHEMA_VERSION));
      value.setSourceDigest("e".repeat(64));
      const restarted = new FluxRunManager(value.managerOptions()); await restarted.initialize();
      const { checkpointOpen: _unavailablePort, ...unavailablePorts } = value.managerOptions().ports;
      const unavailable = new FluxRunManager({ ...value.managerOptions(), ports: unavailablePorts }); await unavailable.initialize();
      for (const manager of [value.manager, restarted, unavailable]) {
        const replay = await manager.checkpointOpenRun(run.id, key).catch((error: unknown) => error);
        expect(replay).toMatchObject({ code: failure.code, message: failure.message, terminalFailureReceipt: receipt });
      }
      expect(calls).toBe(["intent_observer", "pre_port_authority"].includes(stage) ? 0 : 1);
      expect((await new FluxRunStore(value.workspaceRoot).read()).revision).toBe(state.revision);
    } finally { commitSpy?.mockRestore(); }
  });

  it.each(["intent_persisted", "side_effect_completed"] as const)("bounds the checkpoint observer at %s and fences its late continuation", async (phaseToStall) => {
    const entered = deferred<void>(); const release = deferred<void>(); let calls = 0;
    const value = await fixture({ lifecycleObserver: async ({ operation, phase }) => {
      if (operation === "checkpoint_open" && phase === phaseToStall) { entered.resolve(); await release.promise; }
    }, ports: { checkpointOpen: async (request) => { calls += 1; return { isolatedFingerprint: ISOLATED_DIGEST, checkpointRequired: false,
      preview: { title: "Checkpoint", summary: "Completed", artifactCount: 3, digest: PREVIEW_DIGEST }, openCheckpointReceipt: checkpointReceipt(request, ISOLATED_DIGEST) }; } } });
    const run = await createGenericRun(value); await value.manager.interpretRun(run.id); await value.manager.prepareRun(run.id); await value.manager.open(value.projectId, run.id);
    vi.useFakeTimers(); vi.setSystemTime(new Date("2030-02-01T00:00:00.000Z"));
    try {
      const pending = value.manager.checkpointOpenRun(run.id, `stalled-${phaseToStall}`).catch((error: unknown) => error);
      await entered.promise; await vi.advanceTimersByTimeAsync(FLUX_CHECKPOINT_OPERATION_TIMEOUT_MS);
      expect(await pending).toMatchObject({ code: "OPERATION_UNCERTAIN", message: FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE });
      const settled = await new FluxRunStore(value.workspaceRoot).read(); release.resolve(); await vi.advanceTimersByTimeAsync(0);
      expect(await new FluxRunStore(value.workspaceRoot).read()).toEqual(settled);
      expect(calls).toBe(phaseToStall === "intent_persisted" ? 0 : 1); expect(vi.getTimerCount()).toBe(0);
    } finally { release.resolve(); vi.useRealTimers(); }
  });

  it("fences the checkpoint commit after its temporary state is written but before atomic rename", async () => {
    const value = await fixture();
    const run = await createGenericRun(value); await value.manager.interpretRun(run.id); await value.manager.prepareRun(run.id); await value.manager.open(value.projectId, run.id);
    vi.useFakeTimers(); vi.setSystemTime(new Date("2030-02-02T00:00:00.000Z"));
    const originalReplace = FluxRunStore.prototype.replace; let guardedCommit = false;
    const spy = vi.spyOn(FluxRunStore.prototype, "replace").mockImplementation(async function (this: FluxRunStore, mutator, guard) {
      return originalReplace.call(this, mutator, guard === undefined ? undefined : () => {
        guardedCommit = true; vi.setSystemTime(Date.now() + FLUX_CHECKPOINT_OPERATION_TIMEOUT_MS); guard();
      });
    });
    try {
      await expect(value.manager.checkpointOpenRun(run.id, "checkpoint-commit-deadline")).rejects.toMatchObject({ code: "OPERATION_UNCERTAIN", message: FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE });
      expect(guardedCommit).toBe(true);
      const state = await new FluxRunStore(value.workspaceRoot).read();
      expect(state.runs[run.id]).toMatchObject({ phase: "blocked", checkpointRequired: true });
      expect(state.idempotency["checkpoint-commit-deadline"]?.status).toBe("failed");
      expect(state.events.filter((item) => item.runId === run.id && item.kind === "open_checkpoint_recorded")).toHaveLength(0);
      expect((await readdir(value.workspaceRoot)).filter((name) => name.startsWith(".flux-state-") && name.endsWith(".tmp"))).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally { spy.mockRestore(); vi.useRealTimers(); }
  });

  it("rejects checkpoint authority failure before admission without creating a failed key", async () => {
    let calls = 0;
    const value = await fixture({ ports: { checkpointOpen: async () => { calls += 1; throw new Error("unexpected port call"); } } });
    const run = await createGenericRun(value); await value.manager.interpretRun(run.id); await value.manager.prepareRun(run.id); await value.manager.open(value.projectId, run.id);
    value.setSourceDigest("f".repeat(64));
    await expect(value.manager.checkpointOpenRun(run.id, "invalid-before-admission")).rejects.toMatchObject({ code: "APPROVAL_MISMATCH" });
    const state = await new FluxRunStore(value.workspaceRoot).read(); expect(state.runs[run.id]?.phase).toBe("awaiting_checkpoint");
    expect(state.idempotency["invalid-before-admission"]).toBeUndefined(); expect(calls).toBe(0);
    expect(state.events.filter((item) => item.runId === run.id && item.kind === "run_blocked")).toHaveLength(0);
  });

  it("aborts and durably terminalizes checkpoint exactly at the aggregate 270-second deadline", async () => {
    const entered = deferred<Parameters<NonNullable<FluxExecutionPorts["checkpointOpen"]>>[1]>(); const aborted = deferred<void>(); let calls = 0;
    const value = await fixture({ ports: { checkpointOpen: async (_request, context) => {
      calls += 1; entered.resolve(context);
      return new Promise<never>((_resolve, reject) => context.signal.addEventListener("abort", () => {
        aborted.resolve(); reject(new FluxError("OPERATION_UNCERTAIN", FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE));
      }, { once: true }));
    } } });
    const run = await createGenericRun(value); await value.manager.interpretRun(run.id); await value.manager.prepareRun(run.id); await value.manager.open(value.projectId, run.id);
    vi.useFakeTimers(); vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    try {
      const pending = value.manager.checkpointOpenRun(run.id, "checkpoint-timeout"); const outcome = pending.then((result) => ({ result }), (error: unknown) => ({ error }));
      const context = await entered.promise; const concurrentReplay = value.manager.checkpointOpenRun(run.id, "checkpoint-timeout");
      const concurrentOutcome = concurrentReplay.then((result) => ({ result }), (error: unknown) => ({ error }));
      expect(Object.isFrozen(context)).toBe(true); expect(context.deadlineAtMs - Date.now()).toBe(FLUX_CHECKPOINT_OPERATION_TIMEOUT_MS); expect(context.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(FLUX_CHECKPOINT_OPERATION_TIMEOUT_MS - 1);
      expect(context.signal.aborted).toBe(false); expect((await value.manager.getRun(run.id)).phase).toBe("checkpointing");
      await vi.advanceTimersByTimeAsync(1); await aborted.promise;
      const terminal = await outcome; expect(terminal).toMatchObject({ error: { code: "OPERATION_UNCERTAIN", message: FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE } });
      expect(await concurrentOutcome).toMatchObject({ error: { code: "OPERATION_UNCERTAIN", message: FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE } });
      expect(vi.getTimerCount()).toBe(0);
      const state = await new FluxRunStore(value.workspaceRoot).read(); const blocked = state.runs[run.id]!;
      expect(blocked).toMatchObject({ phase: "blocked", blockedReason: FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE });
      expect(blocked.inFlightOperation).toBeUndefined(); expect(blocked.openCheckpointReceipt).toBeUndefined(); expect(blocked.approval).toBeUndefined();
      expect(state.idempotency["checkpoint-timeout"]).toMatchObject({ operation: "checkpoint_open", status: "failed", completedAt: blocked.updatedAt,
        failure: { code: "OPERATION_UNCERTAIN", message: FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE }, terminalReceipt: { outcome: "failed", at: blocked.updatedAt } });
      expect(state.events.filter((entry) => entry.runId === run.id && entry.kind === "run_blocked")).toHaveLength(1);
      expect(state.operationFailureEvidence).toEqual({}); expect(state.operationFailureEvidenceReservations).toEqual({});

      const restarted = new FluxRunManager(value.managerOptions()); await restarted.initialize();
      await expect(restarted.checkpointOpenRun(run.id, "checkpoint-timeout")).rejects.toMatchObject({ code: "OPERATION_UNCERTAIN", message: FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE });
      await expect(restarted.checkpointOpenRun(run.id, "checkpoint-timeout-other")).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
      expect(calls).toBe(1); expect((await new FluxRunStore(value.workspaceRoot).read()).revision).toBe(state.revision);
    } finally { vi.useRealTimers(); }
  });

  it("fences a checkpoint port that ignores abort so its late result cannot mutate durable state", async () => {
    type CheckpointResult = Awaited<ReturnType<NonNullable<FluxExecutionPorts["checkpointOpen"]>>>;
    const entered = deferred<Parameters<NonNullable<FluxExecutionPorts["checkpointOpen"]>>[1]>(); const late = deferred<CheckpointResult>();
    let checkpointRequest!: Parameters<NonNullable<FluxExecutionPorts["checkpointOpen"]>>[0];
    const value = await fixture({ ports: { checkpointOpen: async (request, context) => { checkpointRequest = request; entered.resolve(context); return late.promise; } } });
    const run = await createGenericRun(value); await value.manager.interpretRun(run.id); await value.manager.prepareRun(run.id); await value.manager.open(value.projectId, run.id);
    vi.useFakeTimers(); vi.setSystemTime(new Date("2030-01-02T00:00:00.000Z"));
    try {
      const pending = value.manager.checkpointOpenRun(run.id, "checkpoint-ignore-abort"); const outcome = pending.then((result) => ({ result }), (error: unknown) => ({ error }));
      const context = await entered.promise; await vi.advanceTimersByTimeAsync(FLUX_CHECKPOINT_OPERATION_TIMEOUT_MS);
      expect(context.signal.aborted).toBe(true); expect(await outcome).toMatchObject({ error: { code: "OPERATION_UNCERTAIN" } });
      expect(vi.getTimerCount()).toBe(0);
      const settled = await new FluxRunStore(value.workspaceRoot).read(); const eventCount = settled.events.length;
      late.resolve({ isolatedFingerprint: ISOLATED_DIGEST, checkpointRequired: false,
        preview: { title: "Late checkpoint", summary: "Must be ignored", artifactCount: 3, digest: PREVIEW_DIGEST },
        openCheckpointReceipt: checkpointReceipt(checkpointRequest, ISOLATED_DIGEST) });
      await Promise.resolve(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(0);
      const afterLate = await new FluxRunStore(value.workspaceRoot).read();
      expect(afterLate.revision).toBe(settled.revision); expect(afterLate.events).toHaveLength(eventCount);
      expect(afterLate.runs[run.id]).toMatchObject({ phase: "blocked", blockedReason: FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE });
      expect(afterLate.runs[run.id]?.openCheckpointReceipt).toBeUndefined(); expect(afterLate.runs[run.id]?.approval).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });

  it("clears the aggregate checkpoint timer on success and preserves idempotent replay", async () => {
    let calls = 0; let observedContext: Parameters<NonNullable<FluxExecutionPorts["checkpointOpen"]>>[1] | undefined;
    const value = await fixture({ ports: { checkpointOpen: async (request, context) => {
      calls += 1; observedContext = context;
      return { isolatedFingerprint: ISOLATED_DIGEST, checkpointRequired: false,
        preview: { title: "Checkpoint", summary: "Completed", artifactCount: 3, digest: PREVIEW_DIGEST }, openCheckpointReceipt: checkpointReceipt(request, ISOLATED_DIGEST) };
    } } });
    const run = await createGenericRun(value); await value.manager.interpretRun(run.id); await value.manager.prepareRun(run.id); await value.manager.open(value.projectId, run.id);
    vi.useFakeTimers(); vi.setSystemTime(new Date("2030-01-03T00:00:00.000Z"));
    try {
      const first = await value.manager.checkpointOpenRun(run.id, "checkpoint-success-timer"); expect(first.phase).toBe("awaiting_approval");
      expect(observedContext?.signal.aborted).toBe(false); expect(observedContext!.deadlineAtMs - Date.now()).toBe(FLUX_CHECKPOINT_OPERATION_TIMEOUT_MS);
      expect(vi.getTimerCount()).toBe(0);
      const replay = await value.manager.checkpointOpenRun(run.id, "checkpoint-success-timer"); expect(replay).toEqual(first); expect(calls).toBe(1); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("durably settles a runtime-declared checkpoint uncertainty before the manager timer fires", async () => {
    let calls = 0;
    const value = await fixture({ ports: { checkpointOpen: async () => { calls += 1; throw new FluxError("OPERATION_UNCERTAIN", FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE); } } });
    const run = await createGenericRun(value); await value.manager.interpretRun(run.id); await value.manager.prepareRun(run.id); await value.manager.open(value.projectId, run.id);
    vi.useFakeTimers(); vi.setSystemTime(new Date("2030-01-04T00:00:00.000Z"));
    try {
      await expect(value.manager.checkpointOpenRun(run.id, "checkpoint-runtime-uncertain")).rejects.toMatchObject({ code: "OPERATION_UNCERTAIN", message: FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE });
      expect(vi.getTimerCount()).toBe(0); expect(calls).toBe(1);
      expect(await value.manager.getRun(run.id)).toMatchObject({ phase: "blocked", blockedReason: FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE });
      const state = await new FluxRunStore(value.workspaceRoot).read(); expect(state.idempotency["checkpoint-runtime-uncertain"]?.status).toBe("failed");
    } finally { vi.useRealTimers(); }
  });

  it("serializes different-key Open and checkpoint calls with durable in-flight phases", async () => {
    const openEntered = deferred<void>(); const openRelease = deferred<void>(); const checkpointEntered = deferred<void>(); const checkpointRelease = deferred<void>();
    let opens = 0; let checkpoints = 0;
    const value = await fixture({ ports: {
      open: async () => { opens += 1; openEntered.resolve(); await openRelease.promise; return { opened: true, label: "Opened", checkpointRequired: true }; },
      checkpointOpen: async (request) => { checkpoints += 1; checkpointEntered.resolve(); await checkpointRelease.promise; return { isolatedFingerprint: ISOLATED_DIGEST, checkpointRequired: false, preview: { title: "Divider", summary: "Checkpointed", artifactCount: 3, digest: PREVIEW_DIGEST }, openCheckpointReceipt: checkpointReceipt(request, ISOLATED_DIGEST) }; }
    } });
    const run = await createGenericRun(value); await value.manager.interpretRun(run.id); await value.manager.prepareRun(run.id);
    const firstOpen = value.manager.open(value.projectId, run.id, "open-a"); await openEntered.promise;
    expect((await value.manager.getRun(run.id)).phase).toBe("opening");
    await expect(value.manager.open(value.projectId, run.id, "open-b")).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    expect(opens).toBe(1); openRelease.resolve(); await firstOpen;
    const firstCheckpoint = value.manager.checkpointOpenRun(run.id, "checkpoint-a"); await checkpointEntered.promise;
    expect((await value.manager.getRun(run.id)).phase).toBe("checkpointing");
    await expect(value.manager.checkpointOpenRun(run.id, "checkpoint-b")).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    expect(checkpoints).toBe(1); checkpointRelease.resolve(); await firstCheckpoint;
    expect((await value.manager.getRun(run.id)).phase).toBe("awaiting_approval");
    await expect(value.manager.open(value.projectId, run.id, "second-open")).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    expect(opens).toBe(1);
  });

  it("rejects different-key prepare/resume races and records only one approval identity", async () => {
    const prepareEntered = deferred<void>(); const prepareRelease = deferred<void>(); const executeEntered = deferred<void>(); const executeRelease = deferred<void>();
    let prepares = 0; let executions = 0;
    const value = await fixture({ ports: {
      prepare: async (request) => { prepares += 1; prepareEntered.resolve(); await prepareRelease.promise; return { isolatedFingerprint: ISOLATED_DIGEST, checkpointRequired: true,
        freshNetClassPreparationEvidence: FRESH_NETCLASS_PREPARATION_EVIDENCE,
        freshNetClassSemanticAuthority: FRESH_NETCLASS_SEMANTIC_AUTHORITY,
        freshProjectOpenPreparedSourceAuthority: preparedSourceAuthority(path.join(value.workspaceRoot, "runs", request.runId, "project")),
        preview: { title: "Divider", summary: "Prepared", artifactCount: 3, digest: PREVIEW_DIGEST } }; },
      execute: async () => { executions += 1; executeEntered.resolve(); await executeRelease.promise; return { disposition: "completed", reports: [GENERIC_COMPLETED_REPORT], freshClearanceEvidenceReceipt: FRESH_CLEARANCE_EVIDENCE_RECEIPT }; }
    } });
    const run = await createGenericRun(value); await value.manager.interpretRun(run.id);
    const preparing = value.manager.prepareRun(run.id, "prepare-a"); await prepareEntered.promise;
    await expect(value.manager.prepareRun(run.id, "prepare-b")).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    expect(prepares).toBe(1); prepareRelease.resolve(); await preparing;
    await value.manager.open(value.projectId, run.id); await value.manager.checkpointOpenRun(run.id);
    const subject = await value.manager.approvalSubject(run.id);
    const approvals = await Promise.allSettled([value.manager.approveRun(run.id, subject.digest, "approve-a"), value.manager.approveRun(run.id, subject.digest, "approve-b")]);
    const approvedIds = approvals.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof value.manager.approveRun>>> => result.status === "fulfilled").map((result) => result.value.approval?.id);
    expect(approvedIds.length).toBeGreaterThanOrEqual(1); expect(new Set(approvedIds).size).toBe(1);
    await value.manager.resumeRun(run.id, "resume-a"); await executeEntered.promise;
    await expect(value.manager.resumeRun(run.id, "resume-b")).rejects.toBeInstanceOf(FluxError);
    expect(executions).toBe(1); executeRelease.resolve(); await value.manager.waitForIdle();
  });

  it("keeps opened=false closed and restart-blocks malformed or lost Open outcomes", async () => {
    let openMode: "false" | "malformed" | "true" = "false"; let opens = 0;
    const value = await fixture({ ports: { open: async () => {
      opens += 1;
      if (openMode === "false") return { opened: false, label: "Not opened", checkpointRequired: true };
      if (openMode === "malformed") return { opened: "yes", label: "Unknown", checkpointRequired: true } as never;
      return { opened: true, label: "Opened", checkpointRequired: true };
    } } });
    const run = await createGenericRun(value); await value.manager.interpretRun(run.id); await value.manager.prepareRun(run.id);
    await expect(value.manager.open(value.projectId, run.id, "false-open")).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    expect((await value.manager.getRun(run.id)).phase).toBe("awaiting_open");
    await expect(value.manager.checkpointOpenRun(run.id)).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    await expect(value.manager.approvalSubject(run.id)).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    openMode = "malformed";
    await expect(value.manager.open(value.projectId, run.id, "malformed-open")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect((await value.manager.getRun(run.id)).phase).toBe("opening");
    const restarted = new FluxRunManager(value.managerOptions()); await restarted.initialize();
    expect((await restarted.getRun(run.id)).phase).toBe("blocked"); expect(opens).toBe(2);

    const lost = await fixture({ lifecycleObserver: ({ phase, operation }) => {
      if (phase === "side_effect_completed" && operation === "open_project") throw new Error("lost Open response");
    } });
    const lostRun = await createGenericRun(lost); await lost.manager.interpretRun(lostRun.id); await lost.manager.prepareRun(lostRun.id);
    await expect(lost.manager.open(lost.projectId, lostRun.id, "lost-open")).rejects.toThrow("lost Open response");
    expect((await lost.manager.getRun(lostRun.id)).phase).toBe("opening");
    const lostRestart = new FluxRunManager({ ...lost.managerOptions(), lifecycleObserver: undefined } as never); await lostRestart.initialize();
    expect((await lostRestart.getRun(lostRun.id)).phase).toBe("blocked");
    await expect(lostRestart.open(lost.projectId, lostRun.id, "another-open")).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
  });

  it("fails closed on blob corruption, reference replacement, and projected child/profile/workflow tampering", async () => {
    const corruption = await fixture(); const corruptRun = await createGenericRun(corruption); await corruption.manager.interpretRun(corruptRun.id);
    await writeFile(blobPath(corruption.workspaceRoot, corruption.bundleFixture.reference), "corrupt\n", "utf8");
    const corruptRestart = new FluxRunManager(corruption.managerOptions()); await corruptRestart.initialize();
    expect((await corruptRestart.getRun(corruptRun.id))).toMatchObject({ phase: "blocked", blockedReason: expect.stringContaining("verification") });

    for (const mutation of ["reference", "child", "profile", "summary", "workflow"] as const) {
      const value = await fixture(); const run = await createGenericRun(value); await value.manager.interpretRun(run.id);
      const stateStore = new FluxRunStore(value.workspaceRoot);
      const replacement = stateStore.replace((state) => {
        const current = state.runs[run.id]!;
        let changed: FluxPersistedRun;
        if (mutation === "reference") changed = { ...current, compilationBundleRef: { ...current.compilationBundleRef!, contentIdentity: { ...current.compilationBundleRef!.contentIdentity, digest: "f".repeat(64) } } };
        else if (mutation === "child") changed = { ...current, contractState: { ...current.contractState!, libraryBindingIdentity: { ...current.contractState!.libraryBindingIdentity!, digest: "f".repeat(64) } } };
        else if (mutation === "profile") {
          const receipt = current.contractState!.interpreterReceipt;
          if (receipt.schemaVersion !== "evleda.flux-interpreter-receipt.v2") throw new Error("expected v2");
          changed = { ...current, contractState: { ...current.contractState!, interpreterReceipt: { ...receipt, providerProfile: { ...receipt.providerProfile, model: "tampered" } } } };
        } else if (mutation === "summary") changed = { ...current, contractState: { ...current.contractState!, deepRuleSummary: { ...current.contractState!.deepRuleSummary!, selectedCount: current.contractState!.deepRuleSummary!.selectedCount - 1 } } };
        else changed = { ...current, workflowKind: "led_compatibility_fixture" };
        return { ...state, runs: { ...state.runs, [run.id]: changed } };
      });
      if (mutation === "reference" || mutation === "summary") {
        await expect(replacement).rejects.toMatchObject({ code: "STORE_CORRUPT" });
        continue;
      }
      await replacement;
      await expect(value.manager.prepareRun(run.id)).rejects.toMatchObject({ code: expect.stringMatching(/STORE_CORRUPT|APPROVAL_MISMATCH/u) });
    }
  });

  it("recomputes source identity before copy and rejects drift without calling prepare", async () => {
    let prepares = 0;
    const value = await fixture({ ports: { prepare: async () => { prepares += 1; throw new Error("must not copy"); } } });
    const run = await createGenericRun(value); await value.manager.interpretRun(run.id); value.setSourceDigest("f".repeat(64));
    await expect(value.manager.prepareRun(run.id)).rejects.toMatchObject({ code: "APPROVAL_MISMATCH" });
    expect(prepares).toBe(0); expect((await value.manager.getRun(run.id)).phase).toBe("contract_ready");
  });

  it("revalidates every approval-bound identity at queue time", async () => {
    const value = await fixture(); const run = await createGenericRun(value);
    await value.manager.interpretRun(run.id); await value.manager.prepareRun(run.id); await value.manager.open(value.projectId, run.id);
    await value.manager.checkpointOpenRun(run.id); const subject = await value.manager.approvalSubject(run.id); await value.manager.approveRun(run.id, subject.digest);
    const stateStore = new FluxRunStore(value.workspaceRoot); const approved = (await stateStore.read()).runs[run.id]!;
    const receipt = approved.contractState!.interpreterReceipt;
    if (receipt.schemaVersion !== "evleda.flux-interpreter-receipt.v2" || approved.approval?.subject.workflowKind !== "generic") throw new Error("expected approved generic v2 run");
    const changed = (label: string) => `${label}-${"f".repeat(64)}`.slice(-64);
    const mutations: readonly [string, FluxPersistedRun][] = [
      ["contract", { ...approved, contractState: { ...approved.contractState!, contractIdentity: { ...approved.contractState!.contractIdentity!, digest: changed("contract") } } }],
      ["library", { ...approved, contractState: { ...approved.contractState!, libraryBindingIdentity: { ...approved.contractState!.libraryBindingIdentity!, digest: changed("library") } } }],
      ["deep-rule", { ...approved, contractState: { ...approved.contractState!, deepRuleBindingIdentity: { ...approved.contractState!.deepRuleBindingIdentity!, digest: changed("rules") } } }],
      ["acceptance", { ...approved, contractState: { ...approved.contractState!, acceptancePlanIdentity: { ...approved.contractState!.acceptancePlanIdentity!, digest: changed("acceptance") } } }],
      ["compiler", { ...approved, contractState: { ...approved.contractState!, interpreterReceipt: { ...receipt, compilerProfileIdentity: { ...receipt.compilerProfileIdentity!, digest: changed("compiler") } } } }],
      ["practice", { ...approved, contractState: { ...approved.contractState!, interpreterReceipt: { ...receipt, practiceProfileBindingIdentity: { ...receipt.practiceProfileBindingIdentity!, digest: changed("practice") } } } }],
      ["bundle", { ...approved, contractState: { ...approved.contractState!, interpreterReceipt: { ...receipt, bundleIdentity: { ...receipt.bundleIdentity!, digest: changed("bundle") } } } }],
      ["provider", { ...approved, providerModel: { ...approved.providerModel, model: "tampered" } }],
      ["workflow", { ...approved, workflowKind: "led_compatibility_fixture" }],
      ["source", { ...approved, sourceFingerprint: changed("source") }],
      ["prompt", { ...approved, prompt: `${approved.prompt} changed` }],
      ["reference", { ...approved, compilationBundleRef: { ...approved.compilationBundleRef!, identity: { ...approved.compilationBundleRef!.identity, digest: changed("reference") } } }],
      ["approval-child", { ...approved, approval: { ...approved.approval!, subject: { ...approved.approval.subject, executionPromptIdentity: { ...approved.approval.subject.executionPromptIdentity, digest: changed("execution") } } } }]
    ];
    for (const [label, mutation] of mutations) {
      const replacement = stateStore.replace((state) => ({ ...state, runs: { ...state.runs, [run.id]: mutation } }));
      try {
        await replacement;
      } catch (error) {
        expect(error, label).toMatchObject({ code: "STORE_CORRUPT" });
        continue;
      }
      await expect(value.manager.resumeRun(run.id), label).rejects.toBeInstanceOf(FluxError);
      await stateStore.replace((state) => ({ ...state, runs: { ...state.runs, [run.id]: approved } }));
    }
  });

  it("blocks an interrupted interpreter intent and preserves a non-retryable durable receipt", async () => {
    let calls = 0;
    const baseInterpreter = async () => { calls += 1; throw new Error("must not run before crash hook"); };
    const value = await fixture({
      interpreter: { interpretCompilation: baseInterpreter },
      operationFailureEvidenceCapacity: 1,
      lifecycleObserver: ({ phase, operation }) => { if (phase === "intent_persisted" && operation === "interpret_run") throw new Error("simulated crash"); }
    });
    const run = await createGenericRun(value); const waitingRun = await createGenericRun(value);
    await expect(value.manager.interpretRun(run.id, "crash-interpret")).rejects.toThrow("simulated crash"); expect(calls).toBe(0);
    expect(Object.keys((await new FluxRunStore(value.workspaceRoot).read()).operationFailureEvidenceReservations)).toHaveLength(1);
    const restarted = new FluxRunManager({ ...value.managerOptions(), lifecycleObserver: undefined } as never); await restarted.initialize();
    expect((await restarted.getRun(run.id)).phase).toBe("blocked");
    await expect(restarted.interpretRun(run.id, "crash-interpret")).rejects.toMatchObject({ code: "OPERATION_UNCERTAIN" });
    await expect(restarted.interpretRun(waitingRun.id, "capacity-after-crash")).rejects.toMatchObject({ code: "EVIDENCE_CAPACITY" });
    const recoveredState = await new FluxRunStore(value.workspaceRoot).read();
    expect(Object.keys(recoveredState.operationFailureEvidenceReservations)).toHaveLength(1);
    expect(recoveredState.idempotency).not.toHaveProperty("capacity-after-crash");
    expect(recoveredState.runs[waitingRun.id]?.phase).toBe("draft");
    expect(calls).toBe(0);
  });

  it("reserves capacity before concurrent provider calls and releases it on known success", async () => {
    let calls = 0;
    const entered = [deferred<void>(), deferred<void>(), deferred<void>()];
    const release = [deferred<void>(), deferred<void>(), deferred<void>()];
    const profile = providerProfile(); const bundleFixture = createGenericDividerBundleFixture("Build a generic 10k/10k voltage divider candidate.");
    const value = await fixture({ operationFailureEvidenceCapacity: 2, interpreter: { interpretCompilation: async ({ prompt, clarificationAnswers }) => {
      const index = calls; calls += 1; entered[index]!.resolve(); await release[index]!.promise;
      return { publicState: readyState(prompt, clarificationAnswers, profile, bundleFixture.bundle), bundle: bundleFixture.bundle };
    } } });
    const firstRun = await createGenericRun(value); const secondRun = await createGenericRun(value); const overflowRun = await createGenericRun(value);
    const first = value.manager.interpretRun(firstRun.id, "capacity-first");
    await Promise.race([entered[0]!.promise, first]);
    const second = value.manager.interpretRun(secondRun.id, "capacity-second");
    await Promise.race([entered[1]!.promise, second]);
    let state = await new FluxRunStore(value.workspaceRoot).read();
    expect(Object.keys(state.operationFailureEvidenceReservations)).toHaveLength(2);
    expect(JSON.stringify(await value.manager.getRun(firstRun.id))).not.toContain("providerFailureEvidenceReservation");
    await expect(value.manager.interpretRun(overflowRun.id, "capacity-overflow")).rejects.toMatchObject({ code: "EVIDENCE_CAPACITY" });
    expect(calls).toBe(2); state = await new FluxRunStore(value.workspaceRoot).read();
    expect(state.runs[overflowRun.id]?.phase).toBe("draft"); expect(state.idempotency).not.toHaveProperty("capacity-overflow");

    release[0]!.resolve(); await first;
    expect(Object.keys((await new FluxRunStore(value.workspaceRoot).read()).operationFailureEvidenceReservations)).toHaveLength(1);
    const retried = value.manager.interpretRun(overflowRun.id, "capacity-overflow"); await entered[2]!.promise;
    expect(calls).toBe(3); expect(Object.keys((await new FluxRunStore(value.workspaceRoot).read()).operationFailureEvidenceReservations)).toHaveLength(2);
    release[1]!.resolve(); release[2]!.resolve(); await Promise.all([second, retried]);
    state = await new FluxRunStore(value.workspaceRoot).read();
    expect(state.operationFailureEvidenceReservations).toEqual({}); expect(state.operationFailureEvidence).toEqual({});
  });

  it("commits blocked interpretation and failed idempotency receipts atomically for deterministic replay", async () => {
    let calls = 0;
    const value = await fixture({ interpreter: { interpretCompilation: async () => { calls += 1; throw new Error("provider transport detail must not persist"); } } });
    const run = await createGenericRun(value);
    const outcomes = await Promise.allSettled([value.manager.interpretRun(run.id, "terminal-failure"), value.manager.interpretRun(run.id, "terminal-failure")]);
    expect(calls).toBe(1); expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
    const failures = outcomes.map((outcome) => (outcome as PromiseRejectedResult).reason as FluxError);
    expect(new Set(failures.map((failure) => `${failure.code}:${failure.message}`)).size).toBe(1);
    expect(failures[0]).toMatchObject({ code: "ILLEGAL_TRANSITION", message: expect.not.stringContaining("transport detail") });
    const persisted = await new FluxRunStore(value.workspaceRoot).read();
    expect(persisted.runs[run.id]).toMatchObject({ phase: "blocked", blockedReason: failures[0]!.message });
    expect(persisted.operationFailureEvidenceReservations).toEqual({});
    expect(persisted.idempotency["terminal-failure"]).toMatchObject({ status: "failed", completedAt: expect.any(String),
      failure: { code: failures[0]!.code, message: failures[0]!.message, details: {}, diagnostic: { schemaVersion: "evleda.flux-diagnostic.v1", code: "TOOLCHAIN_FAILURE", evidenceIdentity: { schemaVersion: "evleda.flux-diagnostic-evidence.v1" } } }, terminalReceipt: { outcome: "failed" } });
    expect(Object.keys(persisted.operationFailureEvidence)).toHaveLength(1);
    expect(Object.values(persisted.operationFailureEvidence)[0]).toMatchObject({ schemaVersion: "evleda.flux-generic-operation-failure-evidence.v1", kind: "generic" });
    expect(persisted.runs[run.id]?.diagnostic).toEqual(persisted.idempotency["terminal-failure"]?.failure?.diagnostic);
    expect(persisted.events.find((entry) => entry.runId === run.id && entry.kind === "run_blocked")?.diagnostic).toEqual(persisted.runs[run.id]?.diagnostic);
    expect(persisted.idempotency["terminal-failure"]).not.toHaveProperty("result");
    const stateStore = new FluxRunStore(value.workspaceRoot);
    await expect(stateStore.replace((state) => {
      const receipt = state.idempotency["terminal-failure"]!; const failure = receipt.failure!;
      return { ...state, runs: { ...state.runs, [run.id]: { ...state.runs[run.id]!, blockedReason: "coherently changed" } },
        idempotency: { ...state.idempotency, "terminal-failure": { ...receipt, failure: { ...failure, message: "coherently changed" } } } };
    })).rejects.toMatchObject({ code: "STORE_CORRUPT" });
    await expect(stateStore.replace((state) => {
      const receipt = state.idempotency["terminal-failure"]!; const changedAt = "2026-09-07T00:00:00.000Z";
      return { ...state, runs: { ...state.runs, [run.id]: { ...state.runs[run.id]!, updatedAt: changedAt } },
        idempotency: { ...state.idempotency, "terminal-failure": { ...receipt, completedAt: changedAt, terminalReceipt: { outcome: "failed" as const, at: changedAt } } } };
    })).rejects.toMatchObject({ code: "STORE_CORRUPT" });
    const eventCount = persisted.events.filter((entry) => entry.runId === run.id && entry.kind === "run_blocked").length;
    await expect(value.manager.interpretRun(run.id, "terminal-failure")).rejects.toMatchObject({ code: failures[0]!.code, message: failures[0]!.message });
    const restarted = new FluxRunManager(value.managerOptions()); await restarted.initialize();
    await expect(restarted.interpretRun(run.id, "terminal-failure")).rejects.toMatchObject({ code: failures[0]!.code, message: failures[0]!.message });
    await expect(restarted.interpretRun(run.id, "different-key")).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    expect(calls).toBe(1);
    expect((await new FluxRunStore(value.workspaceRoot).read()).events.filter((entry) => entry.runId === run.id && entry.kind === "run_blocked")).toHaveLength(eventCount);
  });

  it.each(PCB_DESIGN_INTERPRETER_ERROR_CODES)("durably classifies a closed %s interpreter failure without retaining its prose", async (interpreterErrorCode) => {
    const secret = `sk-private-${interpreterErrorCode} C:\\private\\provider-turn.json`;
    let calls = 0;
    const value = await fixture({ interpreter: { interpretCompilation: async () => {
      calls += 1;
      throw new PcbDesignInterpreterError(interpreterErrorCode, secret);
    } } });
    const run = await createGenericRun(value);
    const key = `closed-${interpreterErrorCode.toLocaleLowerCase("en-US")}`;
    const expectedEvidence = createFluxPcbInterpreterFailureEvidence(interpreterErrorCode);
    const expectedIdentity = fluxOperationFailureEvidenceIdentity(expectedEvidence);

    await expect(value.manager.interpretRun(run.id, key)).rejects.toMatchObject({
      code: "ILLEGAL_TRANSITION",
      message: FLUX_TOOLCHAIN_FAILURE_MESSAGE,
      diagnostic: { code: expectedEvidence.diagnosticCode, evidenceIdentity: expectedIdentity },
    });
    const persisted = await new FluxRunStore(value.workspaceRoot).read();
    expect(persisted.operationFailureEvidenceReservations).toEqual({});
    expect(persisted.operationFailureEvidence[expectedIdentity.digest]).toEqual(expectedEvidence);
    expect(persisted.runs[run.id]).toMatchObject({
      phase: "blocked",
      blockedReason: FLUX_TOOLCHAIN_FAILURE_MESSAGE,
      diagnostic: { code: expectedEvidence.diagnosticCode, evidenceIdentity: expectedIdentity },
    });
    expect(persisted.idempotency[key]).toMatchObject({
      status: "failed",
      failure: { code: "ILLEGAL_TRANSITION", message: FLUX_TOOLCHAIN_FAILURE_MESSAGE, diagnostic: persisted.runs[run.id]!.diagnostic },
    });
    expect(persisted.events.find((entry) => entry.runId === run.id && entry.kind === "run_blocked")?.diagnostic).toEqual(persisted.runs[run.id]!.diagnostic);
    expect(JSON.stringify(persisted)).not.toContain(secret);
    expect(JSON.stringify(persisted)).not.toContain("provider-turn.json");

    const restarted = new FluxRunManager(value.managerOptions()); await restarted.initialize();
    await expect(restarted.interpretRun(run.id, key)).rejects.toMatchObject({
      code: "ILLEGAL_TRANSITION",
      message: FLUX_TOOLCHAIN_FAILURE_MESSAGE,
      diagnostic: persisted.runs[run.id]!.diagnostic,
    });
    expect(calls).toBe(1);
  });

  it("retains the same closed interpreter evidence through clarification failure and replay", async () => {
    const secret = "sk-private-clarification C:\\private\\clarification-turn.json";
    let calls = 0;
    const value = await fixture({ interpreter: { interpretCompilation: async ({ prompt, clarificationAnswers }) => {
      calls += 1;
      if (clarificationAnswers.length === 0) return { publicState: unresolvedState(prompt, clarificationAnswers, providerProfile()), bundle: null };
      throw new PcbDesignInterpreterError("INVALID_COMPILATION", secret);
    } } });
    const run = await createGenericRun(value); await value.manager.interpretRun(run.id);
    const answers = [{ id: "/scope/name", answer: "Divider" }];
    const expectedEvidence = createFluxPcbInterpreterFailureEvidence("INVALID_COMPILATION");
    const expectedIdentity = fluxOperationFailureEvidenceIdentity(expectedEvidence);
    await expect(value.manager.clarifyRun(run.id, answers, "closed-clarification")).rejects.toMatchObject({
      diagnostic: { code: "TOOLCHAIN_FAILURE", evidenceIdentity: expectedIdentity },
    });
    const persisted = await new FluxRunStore(value.workspaceRoot).read();
    expect(persisted.operationFailureEvidence[expectedIdentity.digest]).toEqual(expectedEvidence);
    expect(JSON.stringify(persisted)).not.toContain(secret);
    const restarted = new FluxRunManager(value.managerOptions()); await restarted.initialize();
    await expect(restarted.clarifyRun(run.id, answers, "closed-clarification")).rejects.toMatchObject({
      diagnostic: persisted.runs[run.id]!.diagnostic,
    });
    expect(calls).toBe(2);
  });

  it("preserves a validated diagnostic code while rebinding it to generic private evidence", async () => {
    const diagnostic = createFluxDiagnostic("PROVIDER_AUTH_UNAVAILABLE", { provider: "codex", category: "credentials" });
    const providerFailure = Object.assign(new Error("private provider authentication output"), { diagnostic });
    const value = await fixture({ interpreter: { interpretCompilation: async () => { throw providerFailure; } } });
    const run = await createGenericRun(value);
    await expect(value.manager.interpretRun(run.id, "diagnosed-failure")).rejects.toMatchObject({ diagnostic: { code: "PROVIDER_AUTH_UNAVAILABLE" } });
    const persisted = await new FluxRunStore(value.workspaceRoot).read();
    const rebound = persisted.runs[run.id]?.diagnostic!;
    expect(persisted.runs[run.id]).toMatchObject({ phase: "blocked", diagnostic: { code: "PROVIDER_AUTH_UNAVAILABLE" }, blockedReason: expect.not.stringContaining("authentication output") });
    expect(rebound.evidenceIdentity).not.toEqual(diagnostic.evidenceIdentity);
    expect(persisted.operationFailureEvidence[rebound.evidenceIdentity.digest]).toMatchObject({ kind: "generic", diagnosticCode: "PROVIDER_AUTH_UNAVAILABLE" });
    expect(persisted.idempotency["diagnosed-failure"]?.failure?.diagnostic).toEqual(rebound);
    expect(persisted.events.find((entry) => entry.runId === run.id && entry.kind === "run_blocked")?.diagnostic).toEqual(rebound);
    expect(JSON.stringify(persisted)).not.toContain("private provider authentication output");
  });

  it("atomically retains private provider failure evidence without projecting it", async () => {
    let calls = 0;
    const providerFailure = providerFailureDiagnostic();
    const value = await fixture({ operationFailureEvidenceCapacity: 1, interpreter: { interpretCompilation: async () => {
      calls += 1;
      throw new PcbDesignInterpreterError("PROVIDER_FAILED", "The PCB design-intent provider failed.", providerFailure.diagnostic, providerFailure.providerFailureEvidence);
    } } });
    const run = await createGenericRun(value);
    const outcomes = await Promise.allSettled([value.manager.interpretRun(run.id, "private-evidence"), value.manager.interpretRun(run.id, "private-evidence")]);
    expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
    const firstFailure = (outcomes[0] as PromiseRejectedResult).reason as FluxError;
    expect(calls).toBe(1);
    expect(firstFailure).toMatchObject({ diagnostic: providerFailure.diagnostic, terminalFailureReceipt: { idempotencyKey: "private-evidence", runId: run.id } });
    expect(firstFailure).not.toHaveProperty("providerFailureEvidence");

    const identity = providerFailureEvidenceIdentity(providerFailure.providerFailureEvidence);
    const stateStore = new FluxRunStore(value.workspaceRoot);
    const persisted = await stateStore.read();
    expect(persisted.schemaVersion).toBe("evleda.flux.v10");
    expect(Object.keys(persisted.operationFailureEvidence)).toEqual([identity.digest]);
    expect(persisted.operationFailureEvidenceReservations).toEqual({});
    expect(persisted.operationFailureEvidence[identity.digest]).toEqual(providerFailure.providerFailureEvidence);
    expect(Buffer.byteLength(JSON.stringify(persisted.operationFailureEvidence[identity.digest]), "utf8")).toBeLessThanOrEqual(4_096);
    expect(persisted.runs[run.id]?.diagnostic).toEqual(providerFailure.diagnostic);
    expect(persisted.idempotency["private-evidence"]?.failure?.diagnostic).toEqual(providerFailure.diagnostic);
    expect(persisted.events.find((entry) => entry.runId === run.id && entry.kind === "run_blocked")?.diagnostic).toEqual(providerFailure.diagnostic);
    await expect(stateStore.readOperationFailureEvidence(identity)).resolves.toEqual(providerFailure.providerFailureEvidence);

    const publicJson = JSON.stringify({ error: firstFailure, run: await value.manager.getRun(run.id), events: await value.manager.events() });
    expect(publicJson).toContain(identity.digest);
    expect(publicJson).not.toContain("providerFailureEvidence");
    expect(publicJson).not.toContain("operationFailureEvidence");
    expect(publicJson).not.toContain(providerFailure.providerFailureEvidence.leaf);
    expect(publicJson).not.toContain(providerFailure.providerFailureEvidence.observations.outerSha256!);

    const beforeReplay = await readFile(path.join(value.workspaceRoot, "flux-state.json"), "utf8");
    const restarted = new FluxRunManager(value.managerOptions()); await restarted.initialize();
    await expect(restarted.interpretRun(run.id, "private-evidence")).rejects.toMatchObject({ diagnostic: providerFailure.diagnostic,
      terminalFailureReceipt: { identity: firstFailure.terminalFailureReceipt!.identity } });
    expect(calls).toBe(1);
    expect(await readFile(path.join(value.workspaceRoot, "flux-state.json"), "utf8")).toBe(beforeReplay);
    const capacityRun = await createGenericRun(value);
    await expect(value.manager.interpretRun(capacityRun.id, "capacity-after-evidence")).rejects.toMatchObject({ code: "EVIDENCE_CAPACITY" });
    expect(calls).toBe(1);

    await expect(stateStore.replace((state) => ({ ...state, operationFailureEvidence: {} }))).rejects.toMatchObject({ code: "STORE_CORRUPT" });
    const evictingStore = new FluxRunStore(value.workspaceRoot, 1);
    await evictingStore.appendEvent({ id: "event_evidence_eviction_one", eventSeq: 0, runId: run.id, kind: "run_progress", at: "2026-09-07T12:00:00.000Z", detail: "Bounded progress event." });
    await evictingStore.appendEvent({ id: "event_evidence_eviction_two", eventSeq: 0, runId: run.id, kind: "run_progress", at: "2026-09-07T12:00:01.000Z", detail: "Second bounded progress event." });
    const evicted = await evictingStore.read();
    expect(evicted.events).toHaveLength(1);
    expect(evicted.events[0]?.kind).toBe("run_progress");
    expect(evicted.operationFailureEvidence[identity.digest]).toEqual(providerFailure.providerFailureEvidence);
    await expect(evictingStore.readOperationFailureEvidence(identity)).resolves.toEqual(providerFailure.providerFailureEvidence);
  });

  it("does not commit terminal interpretation state before provider settlement completes", async () => {
    const entered = deferred<void>();
    const settled = deferred<void>();
    const diagnostic = createFluxDiagnostic("PROVIDER_REQUEST_FAILED", { provider: "codex", category: "termination_unconfirmed_after_cleanup" });
    const value = await fixture({ interpreter: { interpretCompilation: async () => {
      entered.resolve();
      await settled.promise;
      throw Object.assign(new Error("private timeout and cleanup output"), { diagnostic });
    } } });
    const run = await createGenericRun(value);
    const operation = value.manager.interpretRun(run.id, "settled-provider-failure");
    await entered.promise;

    const inFlight = await new FluxRunStore(value.workspaceRoot).read();
    expect(inFlight.runs[run.id]).toMatchObject({ phase: "interpreting", inFlightOperation: { operation: "interpret_run" } });
    expect(inFlight.idempotency["settled-provider-failure"]).toMatchObject({ status: "pending" });
    expect(inFlight.events.some((entry) => entry.runId === run.id && entry.kind === "run_blocked")).toBe(false);

    settled.resolve();
    await expect(operation).rejects.toMatchObject({ diagnostic: { code: "PROVIDER_REQUEST_FAILED" } });
    const terminal = await new FluxRunStore(value.workspaceRoot).read();
    expect(terminal.runs[run.id]).toMatchObject({ phase: "blocked", diagnostic: { code: "PROVIDER_REQUEST_FAILED" } });
    expect(terminal.operationFailureEvidence[terminal.runs[run.id]!.diagnostic!.evidenceIdentity.digest]).toMatchObject({ kind: "generic", diagnosticCode: "PROVIDER_REQUEST_FAILED" });
    expect(terminal.idempotency["settled-provider-failure"]).toMatchObject({ status: "failed", terminalReceipt: { outcome: "failed" } });
    expect(terminal.events.filter((entry) => entry.runId === run.id && entry.kind === "run_blocked")).toHaveLength(1);
  });

  it("rejects private evidence tampering, coherent rekeying, overflow, and per-run overbinding", async () => {
    const providerFailure = providerFailureDiagnostic();
    const value = await fixture({ interpreter: { interpretCompilation: async () => {
      throw new PcbDesignInterpreterError("PROVIDER_FAILED", "The PCB design-intent provider failed.", providerFailure.diagnostic, providerFailure.providerFailureEvidence);
    } } });
    const run = await createGenericRun(value); await expect(value.manager.interpretRun(run.id, "evidence-tamper")).rejects.toBeInstanceOf(FluxError);
    const stateFile = path.join(value.workspaceRoot, "flux-state.json"); const original = JSON.parse(await readFile(stateFile, "utf8")) as Record<string, any>;
    const digest = providerFailureEvidenceIdentity(providerFailure.providerFailureEvidence).digest;
    const second = providerFailureDiagnostic("OUTER_SHAPE_INVALID"); const secondDigest = providerFailureEvidenceIdentity(second.providerFailureEvidence).digest;
    const variants = [
      () => { const changed = structuredClone(original); changed.operationFailureEvidence = {}; return changed; },
      () => { const changed = structuredClone(original); changed.operationFailureEvidence[digest].unexpected = true; return changed; },
      () => { const changed = structuredClone(original); changed.operationFailureEvidence[digest].leaf = "OUTER_SHAPE_INVALID"; return changed; },
      () => { const changed = structuredClone(original); changed.operationFailureEvidence = { [secondDigest]: second.providerFailureEvidence }; return changed; },
      () => { const changed = structuredClone(original); changed.operationFailureEvidence[digest].observations.padding = "x".repeat(5_000); return changed; },
      () => { const changed = structuredClone(original); changed.operationFailureEvidence[digest].observations.issues[0].path = "C:\\private\\provider.txt"; return changed; },
      () => {
        const changed = structuredClone(original); const changedDiagnostic = { ...providerFailure.diagnostic, code: "PROVIDER_REQUEST_FAILED" as const };
        changed.runs[run.id].diagnostic = changedDiagnostic; changed.events = changed.events.map((entry: Record<string, unknown>) => entry.runId === run.id && entry.diagnostic !== undefined ? { ...entry, diagnostic: changedDiagnostic } : entry);
        const receipt = changed.idempotency["evidence-tamper"]; const failure = { ...receipt.failure, diagnostic: changedDiagnostic };
        const { identity: _identity, ...failurePayload } = failure;
        failure.identity = canonicalIdentity({ operation: receipt.operation, requestDigest: receipt.digest, resultId: receipt.resultId, runId: receipt.runId,
          startedAt: receipt.startedAt, completedAt: receipt.completedAt, ...failurePayload }, "evleda.flux-operation-failure.v2");
        receipt.failure = failure; return changed;
      },
      () => { const changed = structuredClone(original); changed.operationFailureEvidence = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [index.toString(16).padStart(64, "0"), providerFailure.providerFailureEvidence])); return changed; },
      () => {
        const changed = structuredClone(original); changed.operationFailureEvidence[secondDigest] = second.providerFailureEvidence;
        changed.events.push({ id: "event_second_private_evidence", eventSeq: changed.nextEventSeq, runId: run.id, kind: "run_progress", at: "2026-09-07T12:00:02.000Z", detail: "Second evidence binding.", diagnostic: second.diagnostic });
        changed.nextEventSeq += 1; return changed;
      },
    ];
    for (const mutate of variants) {
      await writeFile(stateFile, `${JSON.stringify(mutate())}\n`, "utf8");
      await expect(new FluxRunStore(value.workspaceRoot).read()).rejects.toMatchObject({ code: "STORE_CORRUPT" });
    }
    await writeFile(stateFile, `${JSON.stringify(original)}\n`, "utf8");
    const stableBytes = await readFile(stateFile, "utf8");
    const atomicStore = new FluxRunStore(value.workspaceRoot);
    await expect(atomicStore.replace((state) => ({ ...state, operationFailureEvidence: { ...state.operationFailureEvidence, [secondDigest]: second.providerFailureEvidence } }))).rejects.toMatchObject({ code: "STORE_CORRUPT" });
    expect(await readFile(stateFile, "utf8")).toBe(stableBytes);

    const malformedEvidence = { ...providerFailure.providerFailureEvidence, unsafePath: "C:\\private\\provider-output.json" };
    const fallback = await fixture({ interpreter: { interpretCompilation: async () => {
      throw Object.assign(new Error("private raw provider output"), { diagnostic: providerFailure.diagnostic, providerFailureEvidence: malformedEvidence });
    } } });
    const fallbackRun = await createGenericRun(fallback); await expect(fallback.manager.interpretRun(fallbackRun.id, "invalid-private-evidence")).rejects.toMatchObject({ diagnostic: { code: "TOOLCHAIN_FAILURE" } });
    const fallbackState = await new FluxRunStore(fallback.workspaceRoot).read();
    expect(Object.keys(fallbackState.operationFailureEvidence)).toHaveLength(1);
    expect(JSON.stringify(fallbackState)).not.toContain("private raw provider output");
    expect(JSON.stringify(fallbackState)).not.toContain("provider-output.json");
  });

  it("does not replay interpretation after a crash following durable bundle readback", async () => {
    let calls = 0;
    const prompt = "Build a generic 10k/10k voltage divider candidate."; const bundleFixture = createGenericDividerBundleFixture(prompt); const profile = providerProfile();
    const value = await fixture({
      interpreter: { interpretCompilation: async ({ prompt: exact, clarificationAnswers }) => { calls += 1; return { publicState: readyState(exact, clarificationAnswers, profile, bundleFixture.bundle), bundle: bundleFixture.bundle }; } },
      lifecycleObserver: ({ phase, operation }) => { if (phase === "side_effect_completed" && operation === "interpret_run") throw new Error("crash after durable bundle"); }
    });
    const run = await createGenericRun(value);
    await expect(value.manager.interpretRun(run.id, "post-store-crash")).rejects.toThrow("crash after durable bundle");
    expect(calls).toBe(1); expect((await value.manager.getRun(run.id)).phase).toBe("interpreting");
    await expect(readFile(blobPath(value.workspaceRoot, bundleFixture.reference))).resolves.toBeInstanceOf(Buffer);
    const restarted = new FluxRunManager({ ...value.managerOptions(), lifecycleObserver: undefined } as never); await restarted.initialize();
    await expect(restarted.interpretRun(run.id, "post-store-crash")).rejects.toMatchObject({ code: "OPERATION_UNCERTAIN" });
    expect(calls).toBe(1);
  });

  it("recovers interrupted clarification and Open intents without allowing a different idempotency key to replay them", async () => {
    const profile = providerProfile(); const bundleFixture = createGenericDividerBundleFixture();
    const clarifyValue = await fixture({
      interpreter: { interpretCompilation: async ({ prompt, clarificationAnswers }) => clarificationAnswers.length === 0
        ? { publicState: unresolvedState(prompt, clarificationAnswers, profile), bundle: null }
        : { publicState: readyState(prompt, clarificationAnswers, profile, bundleFixture.bundle), bundle: bundleFixture.bundle } },
      lifecycleObserver: ({ phase, operation }) => { if (phase === "intent_persisted" && operation === "clarify_run") throw new Error("clarification crash"); }
    });
    const clarifyRun = await createGenericRun(clarifyValue); await clarifyValue.manager.interpretRun(clarifyRun.id);
    await expect(clarifyValue.manager.clarifyRun(clarifyRun.id, [{ id: "/scope/name", answer: "Divider" }], "clarify-crash")).rejects.toThrow("clarification crash");
    const clarifyRestart = new FluxRunManager({ ...clarifyValue.managerOptions(), lifecycleObserver: undefined } as never); await clarifyRestart.initialize();
    expect((await clarifyRestart.getRun(clarifyRun.id)).phase).toBe("blocked");
    await expect(clarifyRestart.clarifyRun(clarifyRun.id, [{ id: "/scope/name", answer: "Divider" }], "different-key")).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });

    const openValue = await fixture(); const openRun = await createGenericRun(openValue); await openValue.manager.interpretRun(openRun.id); await openValue.manager.prepareRun(openRun.id);
    const crashingOpen = new FluxRunManager({ ...openValue.managerOptions(), lifecycleObserver: ({ phase, operation }) => {
      if (phase === "intent_persisted" && operation === "open_project") throw new Error("open crash");
    } });
    await crashingOpen.initialize();
    await expect(crashingOpen.open(openValue.projectId, openRun.id, "open-crash")).rejects.toThrow("open crash");
    const openRestart = new FluxRunManager({ ...openValue.managerOptions(), lifecycleObserver: undefined } as never); await openRestart.initialize();
    expect((await openRestart.getRun(openRun.id)).phase).toBe("blocked");
    await expect(openRestart.open(openValue.projectId, openRun.id, "different-open-key")).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
  });

  it("never defaults a missing disposition or write-session report authority to completed", async () => {
    for (const output of [{}, { disposition: "success" }, { disposition: "completed", reports: [{ title: "Unbound report", digest: "d".repeat(64), mediaType: "text/plain" }] }] as const) {
      const value = await fixture({ ports: { execute: async () => output as never } }); const run = await createGenericRun(value);
      await value.manager.interpretRun(run.id); await value.manager.prepareRun(run.id); await value.manager.open(value.projectId, run.id);
      await value.manager.checkpointOpenRun(run.id); const approval = await value.manager.approvalSubject(run.id); await value.manager.approveRun(run.id, approval.digest);
      await value.manager.resumeRun(run.id); await value.manager.waitForIdle();
      expect((await value.manager.getRun(run.id))).toMatchObject({ phase: "failed", blockedReason: expect.stringMatching(/disposition|missing or unknown fields/u) });
    }
  });

  it("rejects a coherently reminted clearance binding whose KiCad child differs from the approved preparation", async () => {
    const substitutedBinding = createFluxFreshClearanceEvidenceBinding({ kicad: { ...CLEARANCE_KICAD, sha256: "c".repeat(64) },
      materializationIdentity: FRESH_NETCLASS_PREPARATION_EVIDENCE.materializationIdentity, receiptIdentity: FRESH_CLEARANCE_EVIDENCE_RECEIPT.identity,
      semanticAuthorityIdentity: FRESH_NETCLASS_PREPARATION_EVIDENCE.semanticAuthorityIdentity });
    const value = await fixture({ ports: { execute: async () => ({ disposition: "completed", reports: [{ ...GENERIC_COMPLETED_REPORT,
      freshClearanceEvidenceBinding: substitutedBinding }], freshClearanceEvidenceReceipt: FRESH_CLEARANCE_EVIDENCE_RECEIPT }) } });
    const run = await createGenericRun(value); await value.manager.interpretRun(run.id); await value.manager.prepareRun(run.id); await value.manager.open(value.projectId, run.id);
    await value.manager.checkpointOpenRun(run.id); const approval = await value.manager.approvalSubject(run.id); await value.manager.approveRun(run.id, approval.digest);
    await value.manager.resumeRun(run.id); await value.manager.waitForIdle();
    expect(await value.manager.getRun(run.id)).toMatchObject({ phase: "failed", blockedReason: expect.stringContaining("mismatched fresh clearance evidence binding") });
    expect((await new FluxRunStore(value.workspaceRoot).read()).runs[run.id]?.freshClearanceEvidenceReceipt).toBeUndefined();
  });

  it("migrates v4-v7 generic completion to review and rejects v10 missing, tampered, path-bearing, or hybrid clearance authority", async () => {
    const value = await fixture(); const run = await createGenericRun(value);
    await value.manager.interpretRun(run.id); await value.manager.prepareRun(run.id); await value.manager.open(value.projectId, run.id); await value.manager.checkpointOpenRun(run.id);
    const approval = await value.manager.approvalSubject(run.id); await value.manager.approveRun(run.id, approval.digest); await value.manager.resumeRun(run.id); await value.manager.waitForIdle();
    const publicCurrent = await value.manager.getRun(run.id); expect(projectFluxRunDto(publicCurrent)).toEqual(publicCurrent);
    const stateFile = path.join(value.workspaceRoot, "flux-state.json"); const current = JSON.parse(await readFile(stateFile, "utf8")) as Record<string, any>; const revision = current.revision;
    const legacy = structuredClone(current); legacy.schemaVersion = "evleda.flux.v4"; delete legacy.runs[run.id].freshClearanceEvidenceReceipt;
    for (const report of legacy.runs[run.id].reports) delete report.freshClearanceEvidenceBinding;
    for (const report of Object.values(legacy.reports) as Record<string, any>[]) delete report.freshClearanceEvidenceBinding;
    await writeFile(stateFile, `${JSON.stringify(legacy)}\n`, "utf8");

    const migrated = await new FluxRunStore(value.workspaceRoot).read();
    expect(migrated).toMatchObject({ schemaVersion: "evleda.flux.v10", revision });
    expect(migrated.runs[run.id]).toMatchObject({ phase: "needs_review", blockedReason: FLUX_LEGACY_CLEARANCE_REVIEW_MESSAGE,
      reports: [{ disposition: "needs_review", summary: FLUX_LEGACY_CLEARANCE_REVIEW_MESSAGE }] });
    expect(Object.values(migrated.reports)).toEqual([expect.objectContaining({ disposition: "needs_review", summary: FLUX_LEGACY_CLEARANCE_REVIEW_MESSAGE })]);
    expect(migrated.events.some((entry) => entry.runId === run.id && entry.kind === "run_completed")).toBe(false);
    expect(migrated.events.some((entry) => entry.runId === run.id && entry.kind === "run_needs_review" && entry.detail === FLUX_LEGACY_CLEARANCE_REVIEW_MESSAGE)).toBe(true);
    const once = await readFile(stateFile, "utf8"); await new FluxRunStore(value.workspaceRoot).read(); expect(await readFile(stateFile, "utf8")).toBe(once);
    const restarted = new FluxRunManager(value.managerOptions()); await restarted.initialize(); expect((await restarted.getRun(run.id)).phase).toBe("needs_review");

    const semanticLegacy = structuredClone(current); semanticLegacy.schemaVersion = "evleda.flux.v5"; delete semanticLegacy.runs[run.id].freshClearanceEvidenceReceipt;
    await writeFile(stateFile, `${JSON.stringify(semanticLegacy)}\n`, "utf8");
    const semanticMigrated = await new FluxRunStore(value.workspaceRoot).read();
    expect(semanticMigrated.runs[run.id]).toMatchObject({ phase: "needs_review", blockedReason: FLUX_LEGACY_SEMANTIC_REVIEW_MESSAGE,
      reports: [{ disposition: "needs_review", summary: FLUX_LEGACY_SEMANTIC_REVIEW_MESSAGE }] });

    const terminalReceiptLegacy = structuredClone(current); terminalReceiptLegacy.schemaVersion = "evleda.flux.v6"; delete terminalReceiptLegacy.runs[run.id].freshClearanceEvidenceReceipt;
    await writeFile(stateFile, `${JSON.stringify(terminalReceiptLegacy)}\n`, "utf8");
    const terminalReceiptMigrated = await new FluxRunStore(value.workspaceRoot).read();
    expect(terminalReceiptMigrated.runs[run.id]).toMatchObject({ phase: "needs_review", blockedReason: FLUX_LEGACY_TERMINAL_CLEARANCE_RECEIPT_REVIEW_MESSAGE,
      reports: [{ disposition: "needs_review", summary: FLUX_LEGACY_TERMINAL_CLEARANCE_RECEIPT_REVIEW_MESSAGE }] });
    expect(terminalReceiptMigrated.runs[run.id]?.freshClearanceEvidenceReceipt).toBeUndefined();
    const migratedOnce = await readFile(stateFile, "utf8"); await new FluxRunStore(value.workspaceRoot).read(); expect(await readFile(stateFile, "utf8")).toBe(migratedOnce);

    const fullSemanticLegacy = structuredClone(current); fullSemanticLegacy.schemaVersion = "evleda.flux.v7"; const fullSemanticLegacyRun = fullSemanticLegacy.runs[run.id];
    const { freshNetClassPreparationEvidenceIdentity: _legacyPreflightPreparation, identity: _legacyPreflightIdentity, ...legacyPreflightRest } = fullSemanticLegacyRun.openPreflightReceipt;
    const legacyPreflightPayload = { ...legacyPreflightRest, schemaVersion: "evleda.flux-open-preflight.v4" }; const legacyPreflight = { ...legacyPreflightPayload, identity: canonicalIdentity(legacyPreflightPayload, legacyPreflightPayload.schemaVersion) };
    const { freshNetClassPreparationEvidenceIdentity: _legacyCheckpointPreparation, identity: _legacyCheckpointIdentity, ...legacyCheckpointRest } = fullSemanticLegacyRun.openCheckpointReceipt;
    const legacyCheckpointPayload = { ...legacyCheckpointRest, schemaVersion: "evleda.flux-open-checkpoint.v5", openPreflightReceiptIdentity: legacyPreflight.identity };
    const legacyCheckpoint = { ...legacyCheckpointPayload, identity: canonicalIdentity(legacyCheckpointPayload, legacyCheckpointPayload.schemaVersion) };
    const legacySubject = { ...fullSemanticLegacyRun.approval.subject, schemaVersion: "evleda.flux-approval-subject.v5", openPreflightReceiptIdentity: legacyPreflight.identity, openCheckpointReceiptIdentity: legacyCheckpoint.identity };
    delete legacySubject.freshNetClassPreparationEvidenceIdentity; delete fullSemanticLegacyRun.freshNetClassSemanticAuthority;
    fullSemanticLegacyRun.openPreflightReceipt = legacyPreflight; fullSemanticLegacyRun.openCheckpointReceipt = legacyCheckpoint;
    fullSemanticLegacyRun.approval = { ...fullSemanticLegacyRun.approval, subject: legacySubject, subjectDigest: fluxDigest(legacySubject) };
    await writeFile(stateFile, `${JSON.stringify(fullSemanticLegacy)}\n`, "utf8"); const fullSemanticMigrated = await new FluxRunStore(value.workspaceRoot).read();
    expect(fullSemanticMigrated.runs[run.id]).toMatchObject({ phase: "needs_review", blockedReason: FLUX_LEGACY_FULL_SEMANTIC_AUTHORITY_REVIEW_MESSAGE,
      reports: [{ disposition: "needs_review", summary: FLUX_LEGACY_FULL_SEMANTIC_AUTHORITY_REVIEW_MESSAGE }] });

    const missing = structuredClone(current); for (const report of missing.runs[run.id].reports) delete report.freshClearanceEvidenceBinding;
    for (const report of Object.values(missing.reports) as Record<string, any>[]) delete report.freshClearanceEvidenceBinding;
    await writeFile(stateFile, `${JSON.stringify(missing)}\n`, "utf8"); await expect(new FluxRunStore(value.workspaceRoot).read()).rejects.toMatchObject({ code: "STORE_CORRUPT" });

    const missingPreparation = structuredClone(current); delete missingPreparation.runs[run.id].freshNetClassPreparationEvidence;
    await writeFile(stateFile, `${JSON.stringify(missingPreparation)}\n`, "utf8"); await expect(new FluxRunStore(value.workspaceRoot).read()).rejects.toMatchObject({ code: "STORE_CORRUPT" });

    const missingSemanticAuthority = structuredClone(current); delete missingSemanticAuthority.runs[run.id].freshNetClassSemanticAuthority;
    await writeFile(stateFile, `${JSON.stringify(missingSemanticAuthority)}\n`, "utf8"); await expect(new FluxRunStore(value.workspaceRoot).read()).rejects.toMatchObject({ code: "STORE_CORRUPT" });

    const missingPreparedSource = structuredClone(current); delete missingPreparedSource.runs[run.id].freshProjectOpenPreparedSourceAuthority;
    await writeFile(stateFile, `${JSON.stringify(missingPreparedSource)}\n`, "utf8"); await expect(new FluxRunStore(value.workspaceRoot).read()).rejects.toMatchObject({ code: "STORE_CORRUPT" });

    const tamperedPreparedSource = structuredClone(current); tamperedPreparedSource.runs[run.id].freshProjectOpenPreparedSourceAuthority.sch.digest = "f".repeat(64);
    await writeFile(stateFile, `${JSON.stringify(tamperedPreparedSource)}\n`, "utf8"); await expect(new FluxRunStore(value.workspaceRoot).read()).rejects.toMatchObject({ code: "STORE_CORRUPT" });

    const missingTerminalReceipt = structuredClone(current); delete missingTerminalReceipt.runs[run.id].freshClearanceEvidenceReceipt;
    await writeFile(stateFile, `${JSON.stringify(missingTerminalReceipt)}\n`, "utf8"); await expect(new FluxRunStore(value.workspaceRoot).read()).rejects.toMatchObject({ code: "STORE_CORRUPT" });

    await writeFile(stateFile, `${JSON.stringify(current)}\n`, "utf8"); const atomicBytes = await readFile(stateFile, "utf8"); const atomicStore = new FluxRunStore(value.workspaceRoot);
    await expect(atomicStore.replace((state) => { const storedRun = state.runs[run.id]!; const { freshClearanceEvidenceReceipt: _receipt, ...withoutReceipt } = storedRun;
      return { ...state, runs: { ...state.runs, [run.id]: withoutReceipt } }; })).rejects.toMatchObject({ code: "STORE_CORRUPT" });
    expect(await readFile(stateFile, "utf8")).toBe(atomicBytes);

    const tamperedTerminalReceipt = structuredClone(current); tamperedTerminalReceipt.runs[run.id].freshClearanceEvidenceReceipt.nets[0].effectiveClearanceMm = 0.2;
    await writeFile(stateFile, `${JSON.stringify(tamperedTerminalReceipt)}\n`, "utf8"); await expect(new FluxRunStore(value.workspaceRoot).read()).rejects.toMatchObject({ code: "STORE_CORRUPT" });

    const preparationPath = structuredClone(current); preparationPath.runs[run.id].freshNetClassPreparationEvidence.kicad.path = "C:\\private\\kicad-cli.exe";
    await writeFile(stateFile, `${JSON.stringify(preparationPath)}\n`, "utf8"); await expect(new FluxRunStore(value.workspaceRoot).read()).rejects.toMatchObject({ code: "STORE_CORRUPT" });

    const tampered = structuredClone(current); tampered.runs[run.id].reports[0].freshClearanceEvidenceBinding.materializationIdentity.digest = "f".repeat(64);
    tampered.reports[tampered.runs[run.id].reports[0].reportId].freshClearanceEvidenceBinding.materializationIdentity.digest = "f".repeat(64);
    await writeFile(stateFile, `${JSON.stringify(tampered)}\n`, "utf8"); await expect(new FluxRunStore(value.workspaceRoot).read()).rejects.toMatchObject({ code: "STORE_CORRUPT" });

    const semanticMismatch = structuredClone(current); const priorBinding = semanticMismatch.runs[run.id].reports[0].freshClearanceEvidenceBinding;
    const mismatchedBinding = createFluxFreshClearanceEvidenceBinding({ kicad: priorBinding.kicad, materializationIdentity: priorBinding.materializationIdentity,
      receiptIdentity: priorBinding.receiptIdentity, semanticAuthorityIdentity: canonicalIdentity({ semantics: "other" }, "evleda.fresh-netclass-semantic-authority.v2") });
    semanticMismatch.runs[run.id].reports[0].freshClearanceEvidenceBinding = mismatchedBinding;
    semanticMismatch.reports[semanticMismatch.runs[run.id].reports[0].reportId].freshClearanceEvidenceBinding = mismatchedBinding;
    await writeFile(stateFile, `${JSON.stringify(semanticMismatch)}\n`, "utf8"); await expect(new FluxRunStore(value.workspaceRoot).read()).rejects.toMatchObject({ code: "STORE_CORRUPT" });

    const changedSemanticPayload = { ...SEMANTIC_AUTHORITY_PAYLOAD, boardMinimumClearanceMm: 0.3 };
    const changedSemantic = parseFreshNetClassSemanticAuthority({ ...changedSemanticPayload, identity: canonicalIdentity(changedSemanticPayload, changedSemanticPayload.schemaVersion) });
    const changedPreparationPayload = { ...PREPARATION_EVIDENCE_PAYLOAD, semanticAuthorityIdentity: changedSemantic.identity };
    const changedPreparation = parseFreshNetClassPreparationEvidence({ ...changedPreparationPayload, identity: canonicalIdentity(changedPreparationPayload, changedPreparationPayload.schemaVersion) });
    const coherentlyChangedSemantic = structuredClone(current); const semanticRun = coherentlyChangedSemantic.runs[run.id]; semanticRun.freshNetClassSemanticAuthority = changedSemantic; semanticRun.freshNetClassPreparationEvidence = changedPreparation;
    const { identity: _semanticPreflightIdentity, ...semanticPreflightRest } = semanticRun.openPreflightReceipt;
    const semanticPreflight = createFluxOpenPreflightReceipt({ ...semanticPreflightRest, freshNetClassSemanticAuthorityIdentity: changedSemantic.identity, freshNetClassPreparationEvidenceIdentity: changedPreparation.identity });
    const { identity: _semanticCheckpointIdentity, ...semanticCheckpointRest } = semanticRun.openCheckpointReceipt;
    const semanticCheckpoint = createFluxOpenCheckpointReceipt({ ...semanticCheckpointRest, openPreflightReceiptIdentity: semanticPreflight.identity,
      freshNetClassSemanticAuthorityIdentity: changedSemantic.identity, freshNetClassPreparationEvidenceIdentity: changedPreparation.identity });
    const semanticSubject = { ...semanticRun.approval.subject, freshNetClassSemanticAuthorityIdentity: changedSemantic.identity, freshNetClassPreparationEvidenceIdentity: changedPreparation.identity,
      openPreflightReceiptIdentity: semanticPreflight.identity, openCheckpointReceiptIdentity: semanticCheckpoint.identity };
    semanticRun.openPreflightReceipt = semanticPreflight; semanticRun.openCheckpointReceipt = semanticCheckpoint;
    semanticRun.approval = { ...semanticRun.approval, subject: semanticSubject, subjectDigest: fluxDigest(semanticSubject) };
    const semanticBinding = createFluxFreshClearanceEvidenceBinding({ kicad: CLEARANCE_KICAD, materializationIdentity: changedPreparation.materializationIdentity,
      receiptIdentity: FRESH_CLEARANCE_EVIDENCE_RECEIPT.identity, semanticAuthorityIdentity: changedSemantic.identity });
    semanticRun.reports[0].freshClearanceEvidenceBinding = semanticBinding; coherentlyChangedSemantic.reports[semanticRun.reports[0].reportId].freshClearanceEvidenceBinding = semanticBinding;
    await writeFile(stateFile, `${JSON.stringify(coherentlyChangedSemantic)}\n`, "utf8"); await expect(new FluxRunStore(value.workspaceRoot).read()).rejects.toMatchObject({ code: "STORE_CORRUPT" });

    const substitutedMaterializationPayload = { ...PREPARATION_EVIDENCE_PAYLOAD,
      materializationIdentity: canonicalIdentity({ materialization: "coherent-substitution" }, "evleda.fresh-netclass-materialization.v2") };
    const substitutedPreparation = parseFreshNetClassPreparationEvidence({ ...substitutedMaterializationPayload,
      identity: canonicalIdentity(substitutedMaterializationPayload, substitutedMaterializationPayload.schemaVersion) });
    const coherentlyChangedPreparation = structuredClone(current); const preparationRun = coherentlyChangedPreparation.runs[run.id];
    preparationRun.freshNetClassPreparationEvidence = substitutedPreparation;
    const substitutedPreparationBinding = createFluxFreshClearanceEvidenceBinding({ kicad: CLEARANCE_KICAD,
      materializationIdentity: substitutedPreparation.materializationIdentity, receiptIdentity: FRESH_CLEARANCE_EVIDENCE_RECEIPT.identity,
      semanticAuthorityIdentity: FRESH_NETCLASS_SEMANTIC_AUTHORITY.identity });
    preparationRun.reports[0].freshClearanceEvidenceBinding = substitutedPreparationBinding;
    coherentlyChangedPreparation.reports[preparationRun.reports[0].reportId].freshClearanceEvidenceBinding = substitutedPreparationBinding;
    await writeFile(stateFile, `${JSON.stringify(coherentlyChangedPreparation)}\n`, "utf8"); await expect(new FluxRunStore(value.workspaceRoot).read()).rejects.toMatchObject({ code: "STORE_CORRUPT" });

    for (const replacement of [
      createFluxFreshClearanceEvidenceBinding({ kicad: { ...CLEARANCE_KICAD, sha256: "c".repeat(64) }, materializationIdentity: FRESH_NETCLASS_PREPARATION_EVIDENCE.materializationIdentity,
        receiptIdentity: FRESH_CLEARANCE_EVIDENCE_RECEIPT.identity, semanticAuthorityIdentity: FRESH_NETCLASS_PREPARATION_EVIDENCE.semanticAuthorityIdentity }),
      createFluxFreshClearanceEvidenceBinding({ kicad: CLEARANCE_KICAD, materializationIdentity: canonicalIdentity({ materialization: "substituted" }, "evleda.fresh-netclass-materialization.v2"),
        receiptIdentity: FRESH_CLEARANCE_EVIDENCE_RECEIPT.identity, semanticAuthorityIdentity: FRESH_NETCLASS_PREPARATION_EVIDENCE.semanticAuthorityIdentity }),
      createFluxFreshClearanceEvidenceBinding({ kicad: CLEARANCE_KICAD, materializationIdentity: FRESH_NETCLASS_PREPARATION_EVIDENCE.materializationIdentity,
        receiptIdentity: canonicalIdentity({ receipt: "substituted" }, "evleda.fresh-clearance-evidence-receipt.v2"), semanticAuthorityIdentity: FRESH_NETCLASS_PREPARATION_EVIDENCE.semanticAuthorityIdentity }),
    ]) {
      const substituted = structuredClone(current); substituted.runs[run.id].reports[0].freshClearanceEvidenceBinding = replacement;
      substituted.reports[substituted.runs[run.id].reports[0].reportId].freshClearanceEvidenceBinding = replacement;
      await writeFile(stateFile, `${JSON.stringify(substituted)}\n`, "utf8"); await expect(new FluxRunStore(value.workspaceRoot).read()).rejects.toMatchObject({ code: "STORE_CORRUPT" });
    }
    const restartSubstituted = structuredClone(current);
    const restartBinding = createFluxFreshClearanceEvidenceBinding({ kicad: CLEARANCE_KICAD,
      materializationIdentity: FRESH_NETCLASS_PREPARATION_EVIDENCE.materializationIdentity,
      receiptIdentity: canonicalIdentity({ receipt: "restart-substituted" }, "evleda.fresh-clearance-evidence-receipt.v2"),
      semanticAuthorityIdentity: FRESH_NETCLASS_PREPARATION_EVIDENCE.semanticAuthorityIdentity });
    restartSubstituted.runs[run.id].reports[0].freshClearanceEvidenceBinding = restartBinding;
    restartSubstituted.reports[restartSubstituted.runs[run.id].reports[0].reportId].freshClearanceEvidenceBinding = restartBinding;
    await writeFile(stateFile, `${JSON.stringify(restartSubstituted)}\n`, "utf8");
    await expect(new FluxRunManager(value.managerOptions()).initialize()).rejects.toMatchObject({ code: "STORE_CORRUPT" });

    const changedKicad = { ...CLEARANCE_KICAD, sha256: "c".repeat(64) }; const remintedReceipt = terminalClearanceReceiptForKicad(changedKicad);
    const coherentlyReminted = structuredClone(current); const remintedBinding = createFluxFreshClearanceEvidenceBinding({ kicad: changedKicad,
      materializationIdentity: FRESH_NETCLASS_PREPARATION_EVIDENCE.materializationIdentity, receiptIdentity: remintedReceipt.identity,
      semanticAuthorityIdentity: FRESH_NETCLASS_PREPARATION_EVIDENCE.semanticAuthorityIdentity });
    coherentlyReminted.runs[run.id].freshClearanceEvidenceReceipt = remintedReceipt;
    coherentlyReminted.runs[run.id].reports[0].freshClearanceEvidenceBinding = remintedBinding;
    coherentlyReminted.reports[coherentlyReminted.runs[run.id].reports[0].reportId].freshClearanceEvidenceBinding = remintedBinding;
    await writeFile(stateFile, `${JSON.stringify(coherentlyReminted)}\n`, "utf8");
    await expect(new FluxRunStore(value.workspaceRoot).read()).rejects.toMatchObject({ code: "STORE_CORRUPT" });

    const pathBearingTerminalReceipt = structuredClone(current); pathBearingTerminalReceipt.runs[run.id].freshClearanceEvidenceReceipt.kicad.confirmedCapabilities = ["C:\\private\\capability"];
    await writeFile(stateFile, `${JSON.stringify(pathBearingTerminalReceipt)}\n`, "utf8"); await expect(new FluxRunStore(value.workspaceRoot).read()).rejects.toMatchObject({ code: "STORE_CORRUPT" });

    const pathBearing = structuredClone(current); pathBearing.runs[run.id].reports[0].freshClearanceEvidenceBinding.kicad.path = "C:\\private\\kicad-cli.exe";
    pathBearing.reports[pathBearing.runs[run.id].reports[0].reportId].freshClearanceEvidenceBinding.kicad.path = "C:\\private\\kicad-cli.exe";
    await writeFile(stateFile, `${JSON.stringify(pathBearing)}\n`, "utf8"); await expect(new FluxRunStore(value.workspaceRoot).read()).rejects.toMatchObject({ code: "STORE_CORRUPT" });

    const hybrid = structuredClone(current); const publicHybrid = structuredClone(publicCurrent);
    const hybridRunReport = hybrid.runs[run.id]?.reports[0]; const publicHybridReport = publicHybrid.reports[0];
    if (!hybridRunReport || !publicHybridReport) throw new Error("Expected completed report fixtures");
    const hybridStoredReport = hybrid.reports[hybridRunReport.reportId];
    if (!hybridStoredReport) throw new Error("Expected stored report fixture");
    for (const field of ["executionBridgeIdentity", "writeSessionAuthorityIdentity", "writeSessionReceiptIdentity", "executionInspectionSessionReceiptIdentity"]) {
      delete (hybridRunReport as unknown as Record<string, unknown>)[field]; delete (hybridStoredReport as unknown as Record<string, unknown>)[field]; delete (publicHybridReport as unknown as Record<string, unknown>)[field];
    }
    await writeFile(stateFile, `${JSON.stringify(hybrid)}\n`, "utf8"); await expect(new FluxRunStore(value.workspaceRoot).read()).rejects.toMatchObject({ code: "STORE_CORRUPT" });
    expect(() => projectFluxRunDto(publicHybrid)).toThrow();
  });

  it("migrates v8 to v10 by changing only the root version and retains generic and provider evidence", async () => {
    let calls = 0;
    const richProviderFailure = providerFailureDiagnostic();
    const value = await fixture({ interpreter: { interpretCompilation: async () => {
      calls += 1;
      if (calls === 1) throw new Error("private generic failure");
      throw new PcbDesignInterpreterError(
        "PROVIDER_FAILED",
        "The PCB design-intent provider failed.",
        richProviderFailure.diagnostic,
        richProviderFailure.providerFailureEvidence,
      );
    } } });
    const genericRun = await createGenericRun(value); const providerRun = await createGenericRun(value);
    await expect(value.manager.interpretRun(genericRun.id, "v8-generic-evidence")).rejects.toBeInstanceOf(FluxError);
    await expect(value.manager.interpretRun(providerRun.id, "v8-provider-evidence")).rejects.toBeInstanceOf(FluxError);
    const stateFile = path.join(value.workspaceRoot, "flux-state.json");
    const current = JSON.parse(await readFile(stateFile, "utf8")) as Record<string, any>;
    expect(current.schemaVersion).toBe("evleda.flux.v10");
    expect(Object.values(current.operationFailureEvidence).map((entry: any) => entry.schemaVersion).sort()).toEqual([
      "evleda.flux-generic-operation-failure-evidence.v1",
      "evleda.provider-failure-evidence.v1",
    ]);
    const v8 = structuredClone(current); v8.schemaVersion = "evleda.flux.v8";
    await writeFile(stateFile, `${JSON.stringify(v8)}\n`, "utf8");

    const migrated = await new FluxRunStore(value.workspaceRoot).read();
    expect(migrated).toEqual({ ...v8, schemaVersion: "evleda.flux.v10" });
    expect(migrated.revision).toBe(current.revision);
    expect(migrated.operationFailureEvidence).toEqual(current.operationFailureEvidence);
    expect(JSON.parse(await readFile(stateFile, "utf8")).schemaVersion).toBe("evleda.flux.v10");
  });

  it("migrates v1 honestly: terminal history remains readable and nonterminal generic projection-only runs block", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "evleda-flux-v1-migration-")); roots.push(base); await mkdir(base, { recursive: true });
    const contractState = unresolvedState("legacy", [], providerProfile(), "unsupported");
    const baseRun = {
      projectId: "project_1", threadId: "thread_1", sourceKey: "source", sourceFingerprint: SOURCE_DIGEST,
      prompt: "legacy", providerModel: { provider: "codex", model: "gpt-test", tier: "priority" }, iterationCap: 1,
      harnessRuleIdentity: "legacy", mutationAllowlist: [], freshAcceptanceProfileIdentity: "acceptance-v1",
      freshPersistenceProfileIdentity: "persistence-v1", workflowKind: "generic", contractState, reports: [],
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
    };
    await writeFile(path.join(base, "flux-state.json"), JSON.stringify({ schemaVersion: "evleda.flux.v1", revision: 1,
      sources: { source: { key: "source", label: "Source", fingerprint: SOURCE_DIGEST } },
      projects: { project_1: { id: "project_1", sourceKey: "source", name: "Legacy", createdAt: baseRun.createdAt } },
      threads: { thread_1: { id: "thread_1", projectId: "project_1", title: "Legacy", createdAt: baseRun.createdAt } },
      runs: { terminal: { ...baseRun, id: "terminal", phase: "completed" }, active: { ...baseRun, id: "active", phase: "contract_ready" } },
      reports: {}, idempotency: {}, events: [], nextEventSeq: 1 }) + "\n", "utf8");
    const store = new FluxRunStore(base); const migrated = await store.read();
    expect(migrated.schemaVersion).toBe("evleda.flux.v10");
    expect(migrated.runs.terminal?.phase).toBe("needs_review");
    expect(migrated.runs.active).toMatchObject({ phase: "blocked", blockedReason: expect.stringContaining("cannot be reconstructed") });
    expect(JSON.parse(await readFile(path.join(base, "flux-state.json"), "utf8")).schemaVersion).toBe("evleda.flux.v10");
  });

  it("migrates v3 to an exact empty private-evidence map once and rejects partial/current omissions", async () => {
    const value = await fixture(); await createGenericRun(value, "v3-migration-run");
    const stateFile = path.join(value.workspaceRoot, "flux-state.json");
    const v3 = JSON.parse(await readFile(stateFile, "utf8")) as Record<string, any>;
    const originalRevision = v3.revision;
    v3.schemaVersion = "evleda.flux.v3";
    delete v3.operationFailureEvidence;
    delete v3.operationFailureEvidenceReservations;
    await writeFile(stateFile, `${JSON.stringify(v3)}\n`, "utf8");

    const firstRestart = new FluxRunStore(value.workspaceRoot); const migrated = await firstRestart.read();
    expect(migrated).toMatchObject({ schemaVersion: "evleda.flux.v10", revision: originalRevision, operationFailureEvidence: {}, operationFailureEvidenceReservations: {} });
    const once = await readFile(stateFile, "utf8");
    const secondRestart = new FluxRunStore(value.workspaceRoot); await secondRestart.read();
    expect(await readFile(stateFile, "utf8")).toBe(once);

    await writeFile(stateFile, `${JSON.stringify({ ...v3, operationFailureEvidence: {} })}\n`, "utf8");
    await expect(new FluxRunStore(value.workspaceRoot).read()).rejects.toMatchObject({ code: "STORE_CORRUPT" });
    await writeFile(stateFile, `${JSON.stringify({ ...v3, schemaVersion: "evleda.flux.v4" })}\n`, "utf8");
    await expect(new FluxRunStore(value.workspaceRoot).read()).rejects.toMatchObject({ code: "STORE_CORRUPT" });
  });

  it("backfills a verified deep-rule summary for an existing awaiting-open run exactly once", async () => {
    const value = await fixture(); const run = await createGenericRun(value);
    await value.manager.interpretRun(run.id, "summary-backfill-interpret"); await value.manager.prepareRun(run.id);
    const stateFile = path.join(value.workspaceRoot, "flux-state.json"); const old = JSON.parse(await readFile(stateFile, "utf8")) as Record<string, any>;
    delete old.runs[run.id].contractState.deepRuleSummary;
    delete old.idempotency["summary-backfill-interpret"].result.contractState.deepRuleSummary;
    await writeFile(stateFile, `${JSON.stringify(old)}\n`, "utf8");

    const restarted = new FluxRunManager(value.managerOptions()); await restarted.initialize();
    const summary = (await restarted.getRun(run.id)).contractState?.deepRuleSummary;
    expect(summary).toMatchObject({ schemaVersion: "evleda.flux-deep-rule-summary.v1", deepRuleBindingIdentity: value.bundleFixture.bundle.deepRuleBinding.identity });
    expect((await restarted.interpretRun(run.id, "summary-backfill-interpret")).contractState?.deepRuleSummary).toEqual(summary);
    const once = await readFile(stateFile, "utf8"); const second = new FluxRunManager(value.managerOptions()); await second.initialize();
    expect(await readFile(stateFile, "utf8")).toBe(once);
  });

  it("synthesizes diagnosed v3 terminal failure evidence and prevents its deletion", async () => {
    const value = await fixture({ interpreter: { interpretCompilation: async () => { throw new Error("legacy private provider output"); } } });
    const run = await createGenericRun(value); await expect(value.manager.interpretRun(run.id, "v3-opaque")).rejects.toBeInstanceOf(FluxError);
    const stateFile = path.join(value.workspaceRoot, "flux-state.json"); const v3 = JSON.parse(await readFile(stateFile, "utf8")) as Record<string, any>;
    v3.schemaVersion = "evleda.flux.v3"; delete v3.operationFailureEvidence; delete v3.operationFailureEvidenceReservations;
    const receipt = v3.idempotency["v3-opaque"]; const failure = receipt.failure;
    const oldFailurePayload = { code: failure.code, message: failure.message, details: failure.details, diagnostic: failure.diagnostic };
    failure.identity = canonicalIdentity({ operation: receipt.operation, requestDigest: receipt.digest, resultId: receipt.resultId, runId: receipt.runId,
      startedAt: receipt.startedAt, completedAt: receipt.completedAt, ...oldFailurePayload }, "evleda.flux-operation-failure.v1");
    await writeFile(stateFile, `${JSON.stringify(v3)}\n`, "utf8");

    const store = new FluxRunStore(value.workspaceRoot); const migrated = await store.read();
    const migratedFailure = migrated.idempotency["v3-opaque"]!.failure!;
    expect(Object.keys(migrated.operationFailureEvidence)).toHaveLength(1); expect(migrated.operationFailureEvidenceReservations).toEqual({});
    expect(Object.values(migrated.operationFailureEvidence)[0]).toMatchObject({ schemaVersion: "evleda.flux-legacy-operation-failure-evidence.v1", kind: "legacy_opaque", sourceSchemaVersion: "evleda.flux.v3" });
    expect(migratedFailure).toMatchObject({ diagnostic: { code: "TOOLCHAIN_FAILURE" } });
    expect(migrated.runs[run.id]?.diagnostic).toEqual(migratedFailure.diagnostic);
    await expect(store.replace((state) => ({ ...state, operationFailureEvidence: {} }))).rejects.toMatchObject({ code: "STORE_CORRUPT" });
  });

  it("synthesizes and preserves a v3 interrupted-interpretation capacity reservation", async () => {
    let calls = 0;
    const value = await fixture({ operationFailureEvidenceCapacity: 1, interpreter: { interpretCompilation: async () => { calls += 1; throw new Error("must not run"); } },
      lifecycleObserver: ({ phase, operation }) => { if (phase === "intent_persisted" && operation === "interpret_run") throw new Error("migration crash"); } });
    const run = await createGenericRun(value); const waitingRun = await createGenericRun(value);
    await expect(value.manager.interpretRun(run.id, "v3-reservation")).rejects.toThrow("migration crash"); expect(calls).toBe(0);
    const stateFile = path.join(value.workspaceRoot, "flux-state.json"); const v3 = JSON.parse(await readFile(stateFile, "utf8")) as Record<string, any>;
    v3.schemaVersion = "evleda.flux.v3"; delete v3.operationFailureEvidence; delete v3.operationFailureEvidenceReservations; delete v3.runs[run.id].operationFailureEvidenceReservationRef;
    const revision = v3.revision; await writeFile(stateFile, `${JSON.stringify(v3)}\n`, "utf8");
    const migrated = await new FluxRunStore(value.workspaceRoot).read();
    expect(migrated.revision).toBe(revision); expect(Object.keys(migrated.operationFailureEvidenceReservations)).toHaveLength(1);
    expect(migrated.runs[run.id]?.operationFailureEvidenceReservationRef).toBeDefined();

    const restarted = new FluxRunManager({ ...value.managerOptions(), lifecycleObserver: undefined } as never); await restarted.initialize();
    expect((await restarted.getRun(run.id)).phase).toBe("blocked");
    await expect(restarted.interpretRun(run.id, "v3-reservation")).rejects.toMatchObject({ code: "OPERATION_UNCERTAIN" });
    await expect(restarted.interpretRun(waitingRun.id, "v3-reservation-capacity")).rejects.toMatchObject({ code: "EVIDENCE_CAPACITY" });
    const recovered = await new FluxRunStore(value.workspaceRoot).read(); expect(Object.keys(recovered.operationFailureEvidenceReservations)).toHaveLength(1); expect(calls).toBe(0);
  });

  it("migrates old committed interpretation failures but preserves genuinely uncertain pending receipts", async () => {
    let calls = 0;
    const value = await fixture({ interpreter: { interpretCompilation: async () => { calls += 1; throw new Error("deterministic provider failure"); } } });
    const run = await createGenericRun(value); await expect(value.manager.interpretRun(run.id, "legacy-failure")).rejects.toBeInstanceOf(FluxError);
    const stateFile = path.join(value.workspaceRoot, "flux-state.json");
    const terminal = JSON.parse(await readFile(stateFile, "utf8")) as Record<string, any>;
    terminal.schemaVersion = "evleda.flux.v2";
    delete terminal.operationFailureEvidence;
    delete terminal.operationFailureEvidenceReservations;
    terminal.idempotency["legacy-failure"].status = "pending";
    delete terminal.idempotency["legacy-failure"].completedAt;
    delete terminal.idempotency["legacy-failure"].failure;
    delete terminal.idempotency["legacy-failure"].terminalReceipt;
    delete terminal.runs[run.id].diagnostic;
    terminal.events = [];
    await writeFile(stateFile, `${JSON.stringify(terminal)}\n`, "utf8");
    const migrated = await new FluxRunStore(value.workspaceRoot).read();
    expect(migrated.schemaVersion).toBe("evleda.flux.v10");
    expect(migrated.idempotency["legacy-failure"]).toMatchObject({ status: "failed", failure: { code: "ILLEGAL_TRANSITION", diagnostic: { code: "TOOLCHAIN_FAILURE" } }, terminalReceipt: { outcome: "failed" } });
    expect(Object.keys(migrated.operationFailureEvidence)).toHaveLength(1);
    const migratedReplay = new FluxRunManager(value.managerOptions()); await migratedReplay.initialize();
    await expect(migratedReplay.interpretRun(run.id, "legacy-failure")).rejects.toMatchObject({ diagnostic: { code: "TOOLCHAIN_FAILURE" },
      terminalFailureReceipt: { operation: "interpret_run", idempotencyKey: "legacy-failure", runId: run.id, terminalPhase: "blocked", outcome: "failed" } });
    expect(calls).toBe(1);

    const duplicate = structuredClone(terminal);
    duplicate.idempotency["legacy-failure-duplicate"] = { ...duplicate.idempotency["legacy-failure"] };
    await writeFile(stateFile, `${JSON.stringify(duplicate)}\n`, "utf8");
    const ambiguousDuplicate = await new FluxRunStore(value.workspaceRoot).read();
    expect(ambiguousDuplicate.idempotency["legacy-failure"]).toMatchObject({ status: "pending" });
    expect(ambiguousDuplicate.idempotency["legacy-failure-duplicate"]).toMatchObject({ status: "pending" });

    const uncertain = structuredClone(terminal);
    uncertain.runs[run.id].blockedReason = "A durable lifecycle intent was interrupted at an uncertain external side-effect boundary.";
    await writeFile(stateFile, `${JSON.stringify(uncertain)}\n`, "utf8");
    const preserved = await new FluxRunStore(value.workspaceRoot).read();
    expect(preserved.schemaVersion).toBe("evleda.flux.v10");
    expect(preserved.idempotency["legacy-failure"]).toMatchObject({ status: "pending" });
    expect(preserved.idempotency["legacy-failure"]).not.toHaveProperty("terminalReceipt");
  });

  it("rejects unsafe persisted IDs, map-key mismatches, and broken cross-references before lifecycle use", async () => {
    const value = await fixture(); const run = await createGenericRun(value, "strict-state-run");
    const stateFile = path.join(value.workspaceRoot, "flux-state.json"); const original = JSON.parse(await readFile(stateFile, "utf8")) as Record<string, any>;
    const variants = [
      () => { const changed = structuredClone(original); changed.runs[run.id].id = "../outside"; return changed; },
      () => { const changed = structuredClone(original); changed.runs.run_alias = changed.runs[run.id]; delete changed.runs[run.id]; return changed; },
      () => { const changed = structuredClone(original); changed.threads[value.threadId].projectId = "project_missing"; return changed; },
      () => { const changed = structuredClone(original); delete changed.nextEventSeq; return changed; },
      () => { const changed = structuredClone(original); delete changed.runs[run.id].workflowKind; return changed; },
      () => { const changed = structuredClone(original); const receiptKey = Object.keys(changed.idempotency)[0]!; delete changed.idempotency[receiptKey].status; return changed; },
      () => { const changed = structuredClone(original); const receiptKey = Object.keys(changed.idempotency)[0]!; changed.idempotency[receiptKey] = null; return changed; },
      () => { const changed = structuredClone(original); changed.runs[run.id] = null; return changed; }
    ];
    for (const mutate of variants) {
      await writeFile(stateFile, `${JSON.stringify(mutate())}\n`, "utf8");
      await expect(new FluxRunStore(value.workspaceRoot).read()).rejects.toMatchObject({ code: "STORE_CORRUPT" });
    }
    await writeFile(stateFile, `${JSON.stringify(original)}\n`, "utf8");
  });
});
