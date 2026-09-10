import type {
  ApprovalRecord,
  CanonicalIdentity,
  ContentIdentity,
  EvidenceClass,
  NativeProcessPlanIdentityV1,
  NativeProcessPlanIdentityV2,
  RequirementsDocument,
  ToolIdentity,
  UnresolvedAssumption,
  ValidationStatus,
} from "../domain/types.js";
import type {
  PortablePdfNotRunV2,
  PortableReportKind,
  PortableSourceBindingV1,
  PublicPortableSemanticsV2,
  RawBoundPortableReceiptV2,
} from "../core/portable-artifact.js";
import type { StageKey } from "../domain/stages.js";
import type { ComponentLifecycle, ReferenceComponentKey, ReferenceControllerProfile } from "../knowledge/reference-controller-v0.js";
import type { PcbEngineeringPracticeCatalog } from "../knowledge/pcb-engineering-practices.js";
import type {
  EngineeringConstraintBinding,
  EngineeringEvidenceIdentity,
  EngineeringGateStatus,
} from "../engineering/constraint-compiler.js";
import type {
  PcbPracticeAnalysis,
  PcbPracticeAnalysisProfile,
} from "../integrations/pcb-practice-analyzer.js";

export type ExactInputIdentity = ContentIdentity | CanonicalIdentity;

export interface ArtifactDraft {
  readonly logicalName: string;
  readonly mediaType: string;
  readonly content: Uint8Array;
  readonly identity: ContentIdentity;
  readonly exactInputs: readonly ExactInputIdentity[];
  readonly derivedFrom: readonly string[];
  readonly tool: ToolIdentity;
  readonly validationStatus: ValidationStatus;
  readonly unresolvedAssumptions: readonly UnresolvedAssumption[];
}

export interface EvidenceDraft {
  readonly evidenceClass: EvidenceClass;
  readonly claim: string;
  readonly subjectDigests: readonly string[];
  readonly rawArtifactLogicalName?: string;
  readonly parsedArtifactLogicalName?: string;
  readonly exactInputs: readonly ExactInputIdentity[];
  readonly tool: ToolIdentity;
  readonly validationStatus: ValidationStatus;
  readonly unresolvedAssumptions: readonly UnresolvedAssumption[];
}

export interface BlockerDraft {
  readonly code: string;
  readonly message: string;
  readonly affectedInputDigests: readonly string[];
  readonly requiredAction: string;
  readonly retryable: boolean;
}

export interface StageExecutionResult<K extends StageKey = StageKey> {
  readonly schemaVersion: "evleda.stage-result.v1";
  readonly stage: K;
  readonly executionStatus: "succeeded" | "blocked";
  readonly artifacts: readonly ArtifactDraft[];
  readonly evidence: readonly EvidenceDraft[];
  readonly blockers: readonly BlockerDraft[];
  readonly outputIdentity: CanonicalIdentity;
  readonly requirementsDocument?: RequirementsDocument;
}

export interface CuratedDatasheetIdentity {
  readonly component: ReferenceComponentKey;
  readonly url: string;
  readonly retrievedAt: string;
  readonly identity: ContentIdentity;
}

export interface SourcingObservation {
  readonly component: ReferenceComponentKey;
  readonly manufacturerPartNumber: string;
  readonly supplier: string;
  readonly url: string;
  readonly retrievedAt: string;
  readonly availability: "in_stock" | "not_available" | "unknown";
  readonly identity: ContentIdentity;
}

export interface ComponentLifecycleObservation extends ComponentLifecycle {
  readonly component: ReferenceComponentKey;
  readonly sourceIdentity: ContentIdentity;
}

export interface PinPadMappingObservation {
  readonly component: ReferenceComponentKey;
  readonly symbol: string;
  readonly footprint: string;
  readonly status: "reviewed" | "unreviewed" | "mismatch";
  readonly checkedAt: string;
  readonly mappingIdentity: ContentIdentity;
  readonly reviewIdentity: ContentIdentity;
  readonly requiresReview: boolean;
}

export interface FootprintLibrarySnapshot {
  readonly libraryId: string;
  readonly identity: ContentIdentity | CanonicalIdentity;
  readonly footprints: readonly string[];
}

export type KicadBackendStage = "schematic" | "pcb_placement_routing" | "manufacturing_package";

export type KicadArtifactRole =
  | "project"
  | "schematic"
  | "pcb"
  | "render"
  | "bom"
  | "gerber"
  | "drill"
  | "position"
  | "cam_manifest";

export type KicadReportKind =
  | "erc"
  | "schematic_netlist"
  | "board_statistics"
  | "board_netlist"
  | "connectivity"
  | "drc"
  | "schematic_parity"
  | "geometry"
  | "pcb_practices"
  | "bom_parity"
  | "bom_export"
  | "gerber_export"
  | "drill_export"
  | "position_export"
  | "cam_manifest";

export type KicadNativeReportKind =
  | "erc"
  | "drc"
  | "schematic_netlist"
  | "board_statistics"
  | "board_netlist";

export type KicadEvledaCheckReportKind = Exclude<KicadReportKind, KicadNativeReportKind>;

export const KICAD_NATIVE_REPORT_COMMAND_PREFIXES = Object.freeze({
  erc: Object.freeze(["sch", "erc"] as const),
  drc: Object.freeze(["pcb", "drc"] as const),
  schematic_netlist: Object.freeze(["sch", "export", "netlist"] as const),
  board_statistics: Object.freeze(["pcb", "export", "stats"] as const),
  board_netlist: Object.freeze(["pcb", "export", "ipcd356"] as const),
} as const satisfies Readonly<Record<KicadNativeReportKind, readonly string[]>>);

export const isKicadNativeReportKind = (kind: KicadReportKind): kind is KicadNativeReportKind =>
  Object.hasOwn(KICAD_NATIVE_REPORT_COMMAND_PREFIXES, kind);

export interface KicadGeneratedArtifact {
  readonly role: KicadArtifactRole;
  readonly logicalName: string;
  readonly mediaType: string;
  readonly content: Uint8Array;
}

export interface KicadReportBinding {
  readonly logicalName: string;
  readonly identity: ContentIdentity;
}

export interface KicadReportInputBinding extends KicadReportBinding {
  readonly kind: "artifact" | "native_report" | "source";
}

export interface KicadNativeToolIdentity extends ToolIdentity {
  readonly adapter: "kicad_cli";
  readonly executablePath: string;
  readonly executableDigest: string;
}

export interface KicadAnalyzerToolIdentity extends ToolIdentity {
  readonly adapter: "evleda";
  readonly capabilityProfile: string;
}

interface KicadReportBase<K extends KicadReportKind> {
  readonly kind: K;
  readonly logicalName: string;
  readonly mediaType: string;
  readonly content: Uint8Array;
  readonly sourceRevisionDigest: string;
  readonly validationStatus: ValidationStatus;
}

/**
 * Raw bytes written by one identified kicad-cli invocation. A parsed or
 * re-serialized view of those bytes is not a native report.
 */
export interface KicadNativeReport extends KicadReportBase<KicadNativeReportKind> {
  readonly evidenceClass: "kicad_native";
  readonly authority: {
    readonly kind: "kicad_cli_output";
    readonly tool: KicadNativeToolIdentity;
    readonly command: readonly string[];
    readonly outputIdentity: ContentIdentity;
    readonly sourceBindings: readonly KicadReportBinding[];
  };
}

/** Deterministic EvlEDA analysis over exact native reports/artifacts/sources. */
export interface KicadEvledaCheckReport
  extends KicadReportBase<KicadEvledaCheckReportKind> {
  readonly evidenceClass: "evleda_check";
  readonly authority: {
    readonly kind: "evleda_analyzer";
    readonly analyzerId: string;
    readonly tool: KicadAnalyzerToolIdentity;
    readonly inputBindings: readonly KicadReportInputBinding[];
  };
}

export type KicadBackendReport = KicadNativeReport | KicadEvledaCheckReport;

/** Exact, independently reproducible inputs for phase-1 PCB practice analysis. */
export interface KicadPcbSnapshotBinding<T> {
  readonly logicalName: string;
  readonly document: T;
  readonly contentIdentity: ContentIdentity;
  readonly canonicalIdentity: CanonicalIdentity;
}

export interface KicadPcbEngineeringRequest {
  readonly layoutPlan: {
    readonly logicalName: string;
    readonly document: Readonly<Record<string, unknown>>;
    /** Identity of `${canonicalJson(document)}\n`, matching the stage artifact bytes. */
    readonly contentIdentity: ContentIdentity;
  };
  readonly analyzerProfile: KicadPcbSnapshotBinding<PcbPracticeAnalysisProfile>;
  readonly practiceCatalog: KicadPcbSnapshotBinding<PcbEngineeringPracticeCatalog>;
  readonly routeQualityPolicy: KicadPcbSnapshotBinding<Readonly<Record<string, unknown>>> & {
    readonly captureIdentity: ContentIdentity;
  };
  readonly routeQualityRuleDeck: KicadPcbSnapshotBinding<Readonly<Record<string, unknown>>>;
  readonly proofFixturePolicy: KicadPcbSnapshotBinding<Readonly<Record<string, unknown>>>;
  /** Full catalog/context/checker-evidence binding; a standalone self-hashed set is insufficient. */
  readonly engineeringConstraintBinding:
    | KicadPcbSnapshotBinding<EngineeringConstraintBinding>
    | null;
}

export const KICAD_PCB_ENGINEERING_DECISION_SUMMARY_SCHEMA =
  "evleda.kicad-pcb-engineering-decision-summary.v1" as const;

export interface KicadPcbEngineeringGateSummary {
  readonly id: string;
  readonly code: string;
  readonly ruleId: string;
  readonly enforcementClass: string;
  readonly owner: "machine" | "fabricator" | "human" | "physical";
  readonly status: EngineeringGateStatus;
}

export interface KicadPcbEngineeringDecisionSummary {
  readonly schemaVersion: typeof KICAD_PCB_ENGINEERING_DECISION_SUMMARY_SCHEMA;
  readonly analyzerOutcome: PcbPracticeAnalysis["outcome"];
  readonly reviewRequired: boolean;
  readonly analyzer: {
    readonly outcome: PcbPracticeAnalysis["outcome"];
    readonly reviewRequired: boolean;
    readonly advisoryFindingIds: readonly string[];
    readonly warningFindingIds: readonly string[];
    readonly errorFindingIds: readonly string[];
    readonly outlineComplete: boolean;
    readonly routingCoverageComplete: boolean;
    readonly completeBoardGeometryCoverage: false;
  };
  readonly machine: {
    readonly status: "pass" | "fail" | "unresolved";
    readonly gateFailed: boolean;
    readonly coverageIncomplete: boolean;
    readonly hardOrCalculationGates: readonly KicadPcbEngineeringGateSummary[];
    readonly failedGateIds: readonly string[];
    readonly unresolvedGateIds: readonly string[];
    readonly hardFindingIds: readonly string[];
    readonly coverageFindingIds: readonly string[];
  };
  readonly external: {
    readonly status: "none" | "outstanding";
    readonly outstandingGateIds: readonly string[];
    readonly owners: readonly ("fabricator" | "human" | "physical")[];
    readonly statuses: readonly EngineeringGateStatus[];
    readonly gates: readonly KicadPcbEngineeringGateSummary[];
  };
  readonly referenceFabricationProfile: {
    readonly status: "bound" | "missing" | "conflicting" | "unverified";
    readonly identities: readonly EngineeringEvidenceIdentity[];
  };
  readonly artifactDisposition: "BLOCKED_DIAGNOSTIC" | "PROVISIONAL_POC";
  readonly provisionalArtifactGenerationAllowed: true;
  readonly manufactureReady: false;
  readonly qualificationAuthorized: false;
  readonly releaseAuthorized: false;
}

export const PCB_PRACTICE_INCOMPLETE_COVERAGE_CODES = Object.freeze([
  "BOARD_OUTLINE_GEOMETRY_INVALID",
  "BOARD_OUTLINE_GEOMETRY_UNSUPPORTED",
  "BOARD_OUTLINE_MISSING",
  "BOARD_OUTLINE_NOT_CLOSED",
  "BOARD_OUTLINE_TOPOLOGY_INVALID",
  "ROUTED_ARC_ANALYSIS_UNSUPPORTED",
  "ROUTED_ARC_NET_CLASS_UNBOUND",
  "ROUTED_NET_CLASS_UNBOUND",
  "TURN_JUNCTION_COVERAGE_UNRESOLVED",
  "VIA_GEOMETRY_UNSUPPORTED",
  "VIA_NET_CLASS_UNBOUND",
  "VIA_RULE_UNBOUND",
] as const);

const comparePcbEngineeringText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const buildKicadPcbEngineeringDecisionSummary = (
  analysis: PcbPracticeAnalysis,
  binding: EngineeringConstraintBinding | null,
): KicadPcbEngineeringDecisionSummary => {
  const coverageCodes = new Set<string>(PCB_PRACTICE_INCOMPLETE_COVERAGE_CODES);
  const constraintSet = binding?.compiledConstraintSet;
  const gateStatus = (
    ruleId: string,
    enforcementClass: string,
    owner: KicadPcbEngineeringGateSummary["owner"],
  ): EngineeringGateStatus =>
    constraintSet?.evaluations
      .find((evaluation) => evaluation.ruleId === ruleId)
      ?.gateResults.find(
        (gate) => gate.enforcementClass === enforcementClass && gate.owner === owner,
      )?.status ?? "unresolved";
  const summarizedConstraintGates = (constraintSet?.blockers ?? [])
    .map((blocker): KicadPcbEngineeringGateSummary => ({
      id: blocker.id,
      code: blocker.code,
      ruleId: blocker.ruleId,
      enforcementClass: blocker.enforcementClass,
      owner: blocker.owner,
      status: gateStatus(blocker.ruleId, blocker.enforcementClass, blocker.owner),
    }))
    .sort((left, right) => comparePcbEngineeringText(left.id, right.id));
  const machineGates = summarizedConstraintGates.filter(
    (gate) =>
      gate.owner === "machine" &&
      (gate.enforcementClass === "hard_gate" || gate.enforcementClass === "calculation_gate"),
  );
  const externalGates = summarizedConstraintGates.filter(
    (gate): gate is KicadPcbEngineeringGateSummary & {
      readonly owner: "fabricator" | "human" | "physical";
    } => gate.owner !== "machine",
  );
  const errorFindings = analysis.findings.filter((finding) => finding.severity === "error");
  const coverageFindings = errorFindings.filter((finding) => coverageCodes.has(finding.code));
  const coverageFindingIds = new Set(coverageFindings.map((finding) => finding.id));
  const hardFindingIds = errorFindings
    .filter((finding) => !coverageFindingIds.has(finding.id))
    .map((finding) => finding.id)
    .sort(comparePcbEngineeringText);
  const failedGateIds = machineGates
    .filter((gate) => gate.status === "fail")
    .map((gate) => gate.id)
    .sort(comparePcbEngineeringText);
  const unresolvedGateIds = machineGates
    .filter((gate) => gate.status !== "fail" && gate.status !== "pass")
    .map((gate) => gate.id)
    .sort(comparePcbEngineeringText);
  const machineGateFailed = failedGateIds.length > 0 || hardFindingIds.length > 0;
  const machineCoverageIncomplete =
    unresolvedGateIds.length > 0 ||
    !analysis.summary.outlineComplete ||
    !analysis.summary.routingCoverageComplete ||
    !analysis.summary.completeBoardGeometryCoverage ||
    coverageFindingIds.size > 0;
  const machineStatus = machineGateFailed
    ? "fail" as const
    : machineCoverageIncomplete
      ? "unresolved" as const
      : "pass" as const;
  const advisoryFindingIds = analysis.findings
    .filter((finding) => finding.severity === "advisory")
    .map((finding) => finding.id)
    .sort(comparePcbEngineeringText);
  const warningFindingIds = analysis.findings
    .filter((finding) => finding.severity === "warning")
    .map((finding) => finding.id)
    .sort(comparePcbEngineeringText);
  const externalOwners = [...new Set(externalGates.map((gate) => gate.owner))]
    .sort(comparePcbEngineeringText);
  const externalStatuses = [...new Set(externalGates.map((gate) => gate.status))]
    .sort(comparePcbEngineeringText);
  const referenceFabricationIdentities = (constraintSet?.inputBindings ?? [])
    .filter((input) => input.inputId === "fabricator_capability_snapshot_identity")
    .map((input) => input.identity);
  const referenceFabricationProfileStatus = referenceFabricationIdentities.length === 0
    ? "missing" as const
    : referenceFabricationIdentities.length > 1
      ? "conflicting" as const
      : "unverified" as const;
  const analyzerReviewRequired =
    analysis.outcome === "review" ||
    analysis.summary.humanReviewRequired ||
    analysis.summary.fabricatorConfirmationRequired ||
    advisoryFindingIds.length > 0 ||
    warningFindingIds.length > 0;
  const reviewRequired =
    analyzerReviewRequired || machineCoverageIncomplete || externalGates.length > 0;
  return {
    schemaVersion: KICAD_PCB_ENGINEERING_DECISION_SUMMARY_SCHEMA,
    analyzerOutcome: analysis.outcome,
    reviewRequired,
    analyzer: {
      outcome: analysis.outcome,
      reviewRequired: analyzerReviewRequired,
      advisoryFindingIds,
      warningFindingIds,
      errorFindingIds: errorFindings.map((finding) => finding.id).sort(comparePcbEngineeringText),
      outlineComplete: analysis.summary.outlineComplete,
      routingCoverageComplete: analysis.summary.routingCoverageComplete,
      completeBoardGeometryCoverage: analysis.summary.completeBoardGeometryCoverage,
    },
    machine: {
      status: machineStatus,
      gateFailed: machineGateFailed,
      coverageIncomplete: machineCoverageIncomplete,
      hardOrCalculationGates: machineGates,
      failedGateIds,
      unresolvedGateIds,
      hardFindingIds,
      coverageFindingIds: [...coverageFindingIds].sort(comparePcbEngineeringText),
    },
    external: {
      status: externalGates.length === 0 ? "none" : "outstanding",
      outstandingGateIds: externalGates.map((gate) => gate.id).sort(comparePcbEngineeringText),
      owners: externalOwners,
      statuses: externalStatuses,
      gates: externalGates,
    },
    referenceFabricationProfile: {
      status: referenceFabricationProfileStatus,
      identities: referenceFabricationIdentities,
    },
    // The current capability evidence contract is self-attested/non-gating;
    // no identity-only reference can establish a trusted frozen fab profile.
    artifactDisposition: "BLOCKED_DIAGNOSTIC",
    provisionalArtifactGenerationAllowed: true,
    manufactureReady: false,
    qualificationAuthorized: false,
    releaseAuthorized: false,
  };
};

export interface KicadBackendRequest {
  readonly schemaVersion: "evleda.kicad-request.v2";
  readonly stage: KicadBackendStage;
  readonly expectedSourceRevisionDigest: string;
  readonly profile: ReferenceControllerProfile;
  readonly requirements: RequirementsDocument;
  readonly upstreamArtifactIdentities: readonly ContentIdentity[];
  /** Required for PCB placement/routing and explicitly null for other stages. */
  readonly pcbEngineering: KicadPcbEngineeringRequest | null;
}

export interface KicadBackendResult {
  readonly schemaVersion: "evleda.kicad-result.v2";
  readonly stage: KicadBackendStage;
  readonly sourceRevisionDigest: string;
  readonly tool: ToolIdentity;
  readonly artifacts: readonly KicadGeneratedArtifact[];
  readonly reports: readonly KicadBackendReport[];
}

/**
 * KiCad-native files and claims may only enter the workflow through this boundary.
 * Implementations may wrap KiCad CLI, a constrained KiCad MCP, or an isolated test double.
 */
export interface KicadGenerationBackend {
  readonly backendId: string;
  execute(request: KicadBackendRequest): Promise<KicadBackendResult>;
}

/**
 * Identity-only public request for the Portable Validation v3 producer. Native
 * process plans, host paths, timestamps, and streams are supplied separately
 * to the private execution boundary and are never part of this document.
 */
export interface KicadPortableOperationRequestBindingV3 {
  readonly schemaVersion: "evleda.kicad-portable-operation-request-binding.v3";
  readonly commandKind: PortableReportKind | "kicad_pdf";
  readonly nativeProcessPlanIdentity: NativeProcessPlanIdentityV2;
  readonly portableReceiptPlanIdentityV1: NativeProcessPlanIdentityV1;
  readonly commandPlanIdentity: CanonicalIdentity;
  readonly invocationId: string;
}

export interface KicadPortableExecutionContextV3 {
  readonly schemaVersion: "evleda.kicad-portable-execution-context.v3";
  readonly projectId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly stage: KicadBackendStage;
  readonly fencingEpoch: number;
  readonly inputManifest: CanonicalIdentity;
  readonly executionFenceIdentity: CanonicalIdentity;
  readonly sourceRevisionDigest: string;
  readonly contextIdentity: CanonicalIdentity;
}

export interface KicadPortableInvocationBindingV3 {
  readonly schemaVersion: "evleda.kicad-portable-invocation-binding.v3";
  readonly invocationId: string;
  readonly executionContextIdentity: CanonicalIdentity;
  readonly nativeProcessPlanIdentity: NativeProcessPlanIdentityV2;
  readonly portableReceiptPlanIdentityV1: NativeProcessPlanIdentityV1;
  readonly commandPlanIdentity: CanonicalIdentity;
  readonly authoritativeInvocationIdentityV2: CanonicalIdentity;
  readonly portableReceiptInvocationIdentityV1: CanonicalIdentity;
  readonly compatibilityDisposition: "phase1-receipt-projection-only";
  readonly bindingIdentity: CanonicalIdentity;
}

export interface KicadPortableSourceRelationV3 {
  readonly schemaVersion: "evleda.kicad-portable-source-relation.v3";
  readonly evaluation:
    | "command-input"
    | "post-refill-and-save";
  readonly invocationInputSourceIdentity: ContentIdentity;
  readonly evaluatedSourceIdentity: ContentIdentity;
  readonly relationIdentity: CanonicalIdentity;
}

export interface KicadBackendRequestV3 {
  readonly schemaVersion: "evleda.kicad-request.v3";
  readonly stage: KicadBackendStage;
  readonly expectedSourceRevisionDigest: string;
  readonly executionContext: KicadPortableExecutionContextV3;
  readonly operationBindings: readonly KicadPortableOperationRequestBindingV3[];
  readonly lifecycle: "candidate";
  readonly hostAuthenticated: false;
  readonly manufactureReady: false;
  readonly releaseAuthorized: false;
  readonly requestIdentity: CanonicalIdentity;
}

export interface KicadPortableOperationSuccessV3 {
  readonly schemaVersion: "evleda.kicad-portable-operation-result.v3";
  readonly commandKind: PortableReportKind;
  readonly status: "portable_semantics_created";
  readonly sourceBinding: PortableSourceBindingV1;
  readonly sourceRelation: KicadPortableSourceRelationV3;
  readonly nativeContractIdentity: CanonicalIdentity;
  readonly normalizerContractIdentity: CanonicalIdentity;
  readonly nativeProcessPlanIdentity: NativeProcessPlanIdentityV2;
  readonly commandPlanIdentity: CanonicalIdentity;
  readonly runtimeBinding: KicadPortableInvocationBindingV3;
  readonly semantics: PublicPortableSemanticsV2;
  readonly rawBoundReceipt: RawBoundPortableReceiptV2;
  readonly captureEnvelopeIdentity: CanonicalIdentity;
  readonly privateCaptureIdentity: CanonicalIdentity;
  readonly compoundVerificationIdentity: CanonicalIdentity;
  readonly hostAuthenticated: false;
  readonly manufactureReady: false;
  readonly releaseAuthorized: false;
}

export interface KicadPortablePdfResultV3 {
  readonly schemaVersion: "evleda.kicad-portable-operation-result.v3";
  readonly commandKind: "kicad_pdf";
  readonly status: "private_pdf_not_run_publicly";
  readonly sourceBinding: PortableSourceBindingV1;
  readonly sourceRelation: KicadPortableSourceRelationV3;
  readonly nativeContractIdentity: CanonicalIdentity;
  readonly normalizerContractIdentity: CanonicalIdentity;
  readonly nativeProcessPlanIdentity: NativeProcessPlanIdentityV2;
  readonly commandPlanIdentity: CanonicalIdentity;
  readonly runtimeBinding: KicadPortableInvocationBindingV3;
  readonly marker: PortablePdfNotRunV2;
  readonly privateCaptureIdentity: CanonicalIdentity;
  readonly compoundVerificationIdentity: CanonicalIdentity;
  readonly hostAuthenticated: false;
  readonly manufactureReady: false;
  readonly releaseAuthorized: false;
}

export interface KicadPortableRejectedOperationV3 {
  readonly schemaVersion: "evleda.kicad-portable-operation-result.v3";
  readonly commandKind: PortableReportKind | "kicad_pdf";
  readonly status: "private_runtime_rejected";
  readonly nativeProcessPlanIdentity: NativeProcessPlanIdentityV2;
  readonly commandPlanIdentity: CanonicalIdentity;
  readonly runtimeBinding: KicadPortableInvocationBindingV3;
  /** Identity only; the rejection record and captured bytes remain private. */
  readonly privateRejectionIdentity: CanonicalIdentity;
  readonly semantics: null;
  readonly rawBoundReceipt: null;
  readonly hostAuthenticated: false;
  readonly manufactureReady: false;
  readonly releaseAuthorized: false;
}

export type KicadPortableOperationResultV3 =
  | KicadPortableOperationSuccessV3
  | KicadPortablePdfResultV3
  | KicadPortableRejectedOperationV3;

/** Public, identity-bound result. It deliberately contains no host material. */
export interface KicadBackendResultV3 {
  readonly schemaVersion: "evleda.kicad-result.v3";
  readonly stage: KicadBackendStage;
  readonly sourceRevisionDigest: string;
  readonly requestIdentity: CanonicalIdentity;
  readonly operations: readonly KicadPortableOperationResultV3[];
  readonly lifecycle: "candidate";
  readonly hostAuthenticated: false;
  readonly manufactureReady: false;
  readonly qualificationAuthorized: false;
  readonly releaseAuthorized: false;
  readonly resultIdentity: CanonicalIdentity;
}

export type SimulationCoverageItem =
  | "power_tree_operating_points"
  | "logic_rail_load_budget"
  | "motor_current_chop"
  | "motor_driver_thermal"
  | "fault_and_reset";

export interface SimulationRequest {
  readonly schemaVersion: "evleda.simulation-request.v1";
  readonly expectedSourceRevisionDigest: string;
  readonly profile: ReferenceControllerProfile;
  readonly requirements: RequirementsDocument;
  readonly upstreamArtifactIdentities: readonly ContentIdentity[];
}

export interface SimulationReport {
  readonly coverageItem: SimulationCoverageItem;
  readonly logicalName: string;
  readonly mediaType: string;
  readonly content: Uint8Array;
  readonly sourceRevisionDigest: string;
  readonly modelIdentity: ExactInputIdentity;
  readonly validationStatus: ValidationStatus;
}

export interface SimulationBackendResult {
  readonly schemaVersion: "evleda.simulation-result.v1";
  readonly sourceRevisionDigest: string;
  readonly tool: ToolIdentity;
  readonly reports: readonly SimulationReport[];
}

/** A backend must return captured model/check reports; the stage never synthesizes a pass. */
export interface SimulationBackend {
  readonly backendId: string;
  execute(request: SimulationRequest): Promise<SimulationBackendResult>;
}

export const FIRMWARE_COMPILE_BACKEND_CONFIGURATION_SCHEMA =
  "evleda.firmware-compile-backend-config.v1" as const;
export const FIRMWARE_COMPILE_ENVIRONMENT_SCHEMA =
  "evleda.firmware-compile-environment.v1" as const;
export const FIRMWARE_TARGET_BUILD_CONFIGURATION_SCHEMA =
  "evleda.firmware-target-build-backend-config.v1" as const;
export const FIRMWARE_TARGET_BUILD_ENVIRONMENT_SCHEMA =
  "evleda.firmware-target-build-environment.v1" as const;
export const FIRMWARE_EXECUTION_POLICY_SCHEMA =
  "evleda.firmware-execution-policy.v1" as const;

export type FirmwareSourceOrigin = "evleda-deterministic-generator";

export interface FirmwareExecutionPolicy {
  readonly schemaVersion: typeof FIRMWARE_EXECUTION_POLICY_SCHEMA;
  readonly acceptedSourceOrigin: FirmwareSourceOrigin;
  readonly agentDerivedOrUntrustedSourceExecution: "deny";
  readonly osSandbox: "none";
  readonly containmentClaim: "not-contained";
  readonly executableStrategy:
    | "identity-checked-shared-path"
    | "verified-private-toolchain-closure";
  readonly lto: "disabled";
  readonly linkerPlugin: "disabled";
}

export interface FirmwareCompileResourceLimits {
  readonly maxSourceBytes: number;
  readonly maxTotalSourceBytes: number;
  readonly maxCompilerBytes: number;
  readonly maxValidationExecutableBytes: number;
}

export interface FirmwareTargetBuildResourceLimits {
  readonly maxSourceBytes: number;
  readonly maxTotalSourceBytes: number;
  readonly maxSupportFileBytes: number;
  readonly maxSupportTotalBytes: number;
  readonly maxToolchainFileBytes: number;
  readonly maxToolchainTotalBytes: number;
  readonly maxElfBytes: number;
  readonly maxBinBytes: number;
  readonly maxMapBytes: number;
}

export const FIRMWARE_SOURCE_LOGICAL_NAMES = [
  "firmware/include/board_contract.h",
  "firmware/src/board_contract.c",
  "firmware/tests/board_contract_validation.c"
] as const;

export type FirmwareSourceLogicalName = (typeof FIRMWARE_SOURCE_LOGICAL_NAMES)[number];

export interface FirmwareCompileSource {
  readonly logicalName: FirmwareSourceLogicalName;
  readonly content: Uint8Array;
  readonly identity: ContentIdentity;
}

export interface FirmwareCompileBackendConfiguration {
  readonly schemaVersion: typeof FIRMWARE_COMPILE_BACKEND_CONFIGURATION_SCHEMA;
  readonly backendId: string;
  readonly requestedCompilerPath: string | null;
  readonly environment: Readonly<Record<string, string>>;
  readonly environmentIdentity: CanonicalIdentity;
  readonly executionPolicy: FirmwareExecutionPolicy;
  readonly resourceLimits: FirmwareCompileResourceLimits;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly compileArguments: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly processRunner: "evleda.bounded-process.v1";
}

export interface FirmwareCompileRequest {
  readonly schemaVersion: "evleda.firmware-compile-request.v1";
  readonly sourceRevisionDigest: string;
  readonly configurationIdentity: CanonicalIdentity;
  readonly sourceOrigin: FirmwareSourceOrigin;
  readonly sources: readonly FirmwareCompileSource[];
}

export interface FirmwareCompileStep {
  readonly operation: "compiler_version" | "target_probe" | "compile_and_link" | "validation_test";
  readonly commandRole: "compiler" | "validation_executable";
  readonly commandIdentity: ContentIdentity;
  readonly arguments: readonly string[];
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface FirmwareCompileResult {
  readonly schemaVersion: "evleda.firmware-compile-result.v1";
  readonly sourceRevisionDigest: string;
  readonly configurationIdentity: CanonicalIdentity;
  readonly status: "pass" | "fail" | "unsupported";
  readonly code: string;
  readonly message: string;
  readonly backendId: string;
  readonly requestedCompilerPath: string | null;
  readonly compilerFamily: "clang" | "gcc" | null;
  readonly targetTriple: string | null;
  readonly tool?: ToolIdentity;
  readonly executableIdentity?: ContentIdentity;
  readonly validationExecutableIdentity?: ContentIdentity;
  readonly compiledSources?: readonly {
    readonly logicalName: FirmwareSourceLogicalName;
    readonly identity: ContentIdentity;
  }[];
  readonly steps: readonly FirmwareCompileStep[];
}

/** A compile backend is executable only when this configuration is provisioned into the stage manifest. */
export interface FirmwareCompileBackend {
  readonly backendId: string;
  readonly configuration: FirmwareCompileBackendConfiguration;
  execute(request: FirmwareCompileRequest): Promise<FirmwareCompileResult>;
}

export const FIRMWARE_TARGET_SOURCE_LOGICAL_NAMES = [
  "firmware/include/board_contract.h",
  "firmware/src/board_contract.c",
  "firmware/target/startup_stm32g0b1.s",
  "firmware/target/platform_stm32g0b1.c",
  "firmware/target/STM32G0B1CET6.ld"
] as const;

export type FirmwareTargetSourceLogicalName =
  (typeof FIRMWARE_TARGET_SOURCE_LOGICAL_NAMES)[number];

export interface FirmwareTargetBuildSource {
  readonly logicalName: FirmwareTargetSourceLogicalName;
  readonly content: Uint8Array;
  readonly identity: ContentIdentity;
}

export type FirmwareTargetToolchainFileRole =
  | "gcc"
  | "cc1"
  | "assembler"
  | "collect2"
  | "ld"
  | "objcopy"
  | "libgcc";

export interface FirmwareTargetBoundFile {
  readonly role: FirmwareTargetToolchainFileRole | "support_manifest" | "support_source";
  readonly path: string;
  readonly relativePath: string;
  readonly identity: ContentIdentity;
}

export interface FirmwareTargetEmbeddedFile {
  readonly logicalPath: string;
  readonly identity: ContentIdentity;
}

export interface FirmwareTargetBuildBackendConfiguration {
  readonly schemaVersion: typeof FIRMWARE_TARGET_BUILD_CONFIGURATION_SCHEMA;
  readonly backendId: string;
  readonly requestedToolchainRoot: string | null;
  readonly supportRoot: string;
  readonly targetTriple: "arm-none-eabi";
  readonly targetPart: "STM32G0B1CET6";
  readonly cpu: "cortex-m0plus";
  readonly floatAbi: "soft";
  readonly expectedRelease: "14.2.Rel1";
  readonly expectedGccVersion: "14.2.1";
  readonly distribution: {
    readonly archiveName: "arm-gnu-toolchain-14.2.rel1-mingw-w64-i686-arm-none-eabi.zip";
    readonly officialUrl: string;
    readonly sha256: string;
  };
  readonly environment: Readonly<Record<string, string>>;
  readonly environmentIdentity: CanonicalIdentity;
  readonly executionPolicy: FirmwareExecutionPolicy;
  readonly resourceLimits: FirmwareTargetBuildResourceLimits;
  readonly toolchainFiles: readonly FirmwareTargetBoundFile[];
  readonly supportFiles: readonly FirmwareTargetBoundFile[];
  readonly embeddedFiles: readonly FirmwareTargetEmbeddedFile[];
  readonly compileArguments: readonly string[];
  readonly objcopyArguments: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly processRunner: "evleda.bounded-process.v1";
}

export interface FirmwareTargetBuildRequest {
  readonly schemaVersion: "evleda.firmware-target-build-request.v1";
  readonly sourceRevisionDigest: string;
  readonly configurationIdentity: CanonicalIdentity;
  readonly sourceOrigin: FirmwareSourceOrigin;
  readonly sources: readonly FirmwareTargetBuildSource[];
}

export interface FirmwareTargetBuildStep {
  readonly operation: "gcc_version" | "target_probe" | "ld_version" | "objcopy_version" | "compile_and_link" | "objcopy_binary";
  readonly commandRole: "gcc" | "ld" | "objcopy";
  readonly commandIdentity: ContentIdentity;
  readonly arguments: readonly string[];
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface FirmwareTargetBuildOutput {
  readonly kind: "elf" | "bin" | "map";
  readonly logicalName: string;
  readonly mediaType: string;
  readonly content: Uint8Array;
  readonly identity: ContentIdentity;
}

export interface FirmwareTargetBuildResult {
  readonly schemaVersion: "evleda.firmware-target-build-result.v1";
  readonly sourceRevisionDigest: string;
  readonly configurationIdentity: CanonicalIdentity;
  readonly status: "pass" | "fail" | "unsupported";
  readonly code: string;
  readonly message: string;
  readonly backendId: string;
  readonly targetTriple: "arm-none-eabi" | null;
  readonly gccVersion: string | null;
  readonly toolchainIdentity: CanonicalIdentity | null;
  readonly compiledSources: readonly { readonly logicalName: FirmwareTargetSourceLogicalName; readonly identity: ContentIdentity }[];
  readonly steps: readonly FirmwareTargetBuildStep[];
  readonly outputs: readonly FirmwareTargetBuildOutput[];
  readonly deploymentDisposition: "not-built" | "compiled-non-flashable-candidate";
  readonly flashable: false;
  readonly releaseAuthorized: false;
}

export interface FirmwareTargetBuildBackend {
  readonly backendId: string;
  readonly configuration: FirmwareTargetBuildBackendConfiguration;
  execute(request: FirmwareTargetBuildRequest): Promise<FirmwareTargetBuildResult>;
}

/** Compatibility alias for existing isolated stage tests. Production uses CandidateStageContext directly. */
export interface FirmwareCompileContextExtension {
  readonly firmwareCompileBackend?: FirmwareCompileBackend;
  readonly firmwareCompileConfiguration?: FirmwareCompileBackendConfiguration;
  readonly firmwareTargetBuildBackend?: FirmwareTargetBuildBackend;
  readonly firmwareTargetBuildConfiguration?: FirmwareTargetBuildBackendConfiguration;
}

export interface CommonStageContext {
  readonly projectId: string;
  readonly runId: string;
  readonly designRevisionId: string;
  readonly profile?: ReferenceControllerProfile;
}

export interface RequirementsStageContext extends CommonStageContext {
  readonly prompt: string;
}

export const UPSTREAM_STAGE_SOURCE_REVISION_BINDING_SCHEMA =
  "evleda.upstream-stage-source-revision-binding.v1" as const;

/**
 * Application-authenticated lineage for one persisted successful predecessor.
 * Generator-authored artifact fields are deliberately absent from this trust
 * decision: the application derives it from the attempt provision, execution
 * fence, and committed revision graph.
 */
export interface UpstreamStageSourceRevisionBinding {
  readonly schemaVersion: typeof UPSTREAM_STAGE_SOURCE_REVISION_BINDING_SCHEMA;
  readonly projectId: string;
  readonly runId: string;
  readonly stage: Exclude<StageKey, "requirements">;
  readonly attemptId: string;
  readonly stageInputManifest: CanonicalIdentity;
  readonly stageOutputIdentity: CanonicalIdentity;
  readonly provisionIdentity: CanonicalIdentity;
  readonly provisionManifestBlob: ContentIdentity;
  readonly sourceRevision: {
    readonly id: string;
    readonly manifest: CanonicalIdentity;
  };
  readonly committedRevision: {
    readonly id: string;
    readonly manifest: CanonicalIdentity;
  };
  /** Reproduces every preceding field in this binding. */
  readonly identity: CanonicalIdentity;
}

export interface CandidateStageContext extends CommonStageContext {
  readonly requirements: RequirementsDocument;
  readonly requirementsApproval?: ApprovalRecord;
  readonly upstream: readonly StageExecutionResult[];
  readonly upstreamSourceRevisionBindings: readonly UpstreamStageSourceRevisionBinding[];
  readonly curatedDatasheets?: readonly CuratedDatasheetIdentity[];
  readonly sourcing?: readonly SourcingObservation[];
  readonly lifecycleObservations?: readonly ComponentLifecycleObservation[];
  readonly pinPadMappingReviews?: readonly PinPadMappingObservation[];
  readonly footprintLibrary?: FootprintLibrarySnapshot;
  readonly kicadBackend?: KicadGenerationBackend;
  readonly simulationBackend?: SimulationBackend;
  readonly firmwareCompileBackend?: FirmwareCompileBackend;
  readonly firmwareCompileConfiguration?: FirmwareCompileBackendConfiguration;
  readonly firmwareTargetBuildBackend?: FirmwareTargetBuildBackend;
  readonly firmwareTargetBuildConfiguration?: FirmwareTargetBuildBackendConfiguration;
}

export interface StageContextByKey {
  readonly requirements: RequirementsStageContext;
  readonly system_architecture: CandidateStageContext;
  readonly component_selection: CandidateStageContext;
  readonly schematic: CandidateStageContext;
  readonly firmware_contract: CandidateStageContext;
  readonly simulation_checks: CandidateStageContext;
  readonly pcb_placement_routing: CandidateStageContext;
  readonly manufacturing_package: CandidateStageContext;
  readonly bringup_package: CandidateStageContext;
}

export interface StageExecutor<K extends StageKey = StageKey> {
  readonly stage: K;
  execute(context: StageContextByKey[K]): Promise<StageExecutionResult<K>>;
}

export interface StageRegistryContract {
  orderedStages(): readonly StageKey[];
  has(stage: StageKey): boolean;
  get<K extends StageKey>(stage: K): StageExecutor<K>;
  execute<K extends StageKey>(stage: K, context: StageContextByKey[K]): Promise<StageExecutionResult<K>>;
}
