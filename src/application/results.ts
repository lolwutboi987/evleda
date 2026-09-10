import type {
  OperationInputByName,
  OperationName,
  PhysicalCategoryVerdicts
} from "../contracts/operations.js";
import type {
  ApprovalRecord,
  ArtifactRecord,
  CanonicalIdentity,
  ContentIdentity,
  DesignRevision,
  DesignRun,
  EvidenceRecord,
  LiveRegenerationPolicy,
  LiveRegenerationPolicyIdentity,
  Project,
  RequirementsDocument,
  ToolIdentity,
  UnresolvedAssumption,
  ValidationStatus
} from "../domain/types.js";
import type { StageKey } from "../domain/stages.js";

export interface RunStatusResult {
  readonly project: Project;
  readonly run: DesignRun;
  readonly headRevision?: DesignRevision;
  readonly currentStage: StageKey;
  readonly nextStage?: StageKey;
  readonly blockers: readonly {
    readonly code: string;
    readonly message: string;
    readonly stage: StageKey;
    readonly requiredAction: string;
    readonly retryable: boolean;
  }[];
  readonly effectiveLifecycle: "candidate" | "qualified" | "release_authorized";
  readonly activeAttestations: readonly ApprovalRecord[];
  readonly stateRevision: number;
}

export interface RequirementsInspectionResult {
  readonly projectId: string;
  readonly runId: string;
  readonly requirements: RequirementsDocument;
  readonly requirementsDigest: string;
  readonly approvable: boolean;
  readonly approval?: ApprovalRecord;
}

export interface ArtifactListResult {
  readonly projectId: string;
  readonly runId: string;
  readonly revisionId: string | null;
  readonly artifacts: readonly ArtifactRecord[];
}

export interface EvidenceInspectionResult {
  readonly projectId: string;
  readonly runId: string;
  readonly revisionId: string | null;
  readonly evidence: readonly EvidenceRecord[];
  readonly evidenceRoot: CanonicalIdentity;
}

export type EngineeringMachineStatus = "PASS" | "FAIL" | "UNKNOWN" | "NOT_RUN";

export type EngineeringApplicability =
  | "APPLICABLE"
  | "NOT_APPLICABLE"
  | "UNKNOWN";

export interface EngineeringCheckSummary {
  readonly machineStatus: EngineeringMachineStatus;
  readonly reasonCode: string;
  readonly message: string;
  readonly current: boolean;
  readonly artifactId: string | null;
  readonly evidenceId: string | null;
  readonly reportIdentity: ContentIdentity | null;
  readonly tool: ToolIdentity | null;
  readonly evaluatedAt: string | null;
}

export interface EngineeringRuleProjection {
  readonly ruleId: string;
  readonly title: string;
  readonly applicability: EngineeringApplicability;
  /** Null is reserved for a rule that is proven not applicable. */
  readonly machineStatus: EngineeringMachineStatus | null;
  readonly blocking: boolean;
  readonly decisionClasses: readonly string[];
  readonly reasonCode: string;
  readonly sourceIds: readonly string[];
  readonly exactInputIdentities: readonly (ContentIdentity | CanonicalIdentity)[];
  readonly checkerResultIdentities: readonly (ContentIdentity | CanonicalIdentity)[];
  readonly findingIds: readonly string[];
  readonly externalGateIds: readonly string[];
}

export interface EngineeringAdvisoryProjection {
  readonly advisoryId: string;
  readonly ruleIds: readonly string[];
  readonly severity: "advisory" | "warning";
  readonly message: string;
  readonly sourceIds: readonly string[];
  readonly findingIds: readonly string[];
  readonly externalGateIds: readonly string[];
}

export interface EngineeringExternalGateProjection {
  readonly gateId: string;
  readonly ruleId: string;
  readonly owner: "fabricator" | "human" | "physical";
  readonly status: "OPEN" | "UNKNOWN";
  readonly reasonCode: string;
  readonly message: string;
  readonly subjectIds: readonly string[];
  readonly sourceIds: readonly string[];
  readonly exactInputIdentities: readonly (ContentIdentity | CanonicalIdentity)[];
  readonly evidenceIds: readonly string[];
}

export interface EngineeringFindingLocationProjection {
  readonly artifactId: string;
  readonly artifactIdentity: ContentIdentity;
  readonly sourcePath: string;
  readonly form: string;
  readonly ordinal: number;
  readonly uuid: string | null;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly line: number;
  readonly column: number;
  readonly geometry: Readonly<Record<string, unknown>>;
}

export interface EngineeringFindingRemediationProjection {
  readonly authority: "advisory_only";
  readonly requiresNewRevision: true;
  readonly summary: string;
  readonly steps: readonly string[];
  readonly verification: readonly string[];
  readonly rerunRuleIds: readonly string[];
  readonly rerunStages: readonly StageKey[];
}

export interface EngineeringFindingProjection {
  readonly findingId: string;
  readonly ruleIds: readonly string[];
  readonly machineStatus: Exclude<EngineeringMachineStatus, "PASS">;
  readonly severity: "advisory" | "warning" | "error";
  readonly message: string;
  readonly observed: Readonly<Record<string, unknown>>;
  readonly required: Readonly<Record<string, unknown>>;
  readonly assumptions: readonly string[];
  readonly sourceIds: readonly string[];
  readonly externalGateIds: readonly string[];
  readonly locations: readonly EngineeringFindingLocationProjection[];
  readonly remediation: EngineeringFindingRemediationProjection;
}

export interface EngineeringSourceProjection {
  readonly sourceId: string;
  readonly title: string;
  readonly publisher: string;
  readonly revision: string;
  readonly date: {
    readonly kind: "published" | "revised" | "accessed";
    readonly value: string;
  };
  readonly url: string | null;
  readonly authority:
    | "standards_body"
    | "component_manufacturer"
    | "connector_manufacturer"
    | "protection_manufacturer"
    | "fabricator"
    | "internal_policy";
  readonly accessScope:
    | "public_full_text"
    | "public_scope_or_toc"
    | "live_capability_page"
    | "embedded_snapshot";
  readonly normativeStatus:
    | "current"
    | "unmaintained_reference"
    | "manufacturer_guidance"
    | "fabricator_specific"
    | "internal_product_policy";
  readonly captureIdentity: ContentIdentity | null;
  readonly locator: { readonly kind: string; readonly value: string } | null;
  readonly excerptIdentity: ContentIdentity | null;
  readonly captureComplete: boolean;
}

export interface EngineeringPracticeInspectionResult {
  readonly schemaVersion: "evleda.engineering-practice-inspection.v1";
  readonly projectId: string;
  readonly runId: string;
  readonly revisionId: string | null;
  readonly isHeadRevision: boolean;
  readonly proofFixture: {
    readonly purpose: "full_stack_engineering_proof_fixture";
    readonly classification: "candidate_only";
    readonly reportEstablishesQualification: false;
    readonly reportAuthorizesManufacturing: false;
    readonly reportAuthorizesRelease: false;
  };
  readonly disposition: {
    readonly status: "PROVISIONAL_POC" | "BLOCKED_DIAGNOSTIC";
    readonly reasonCodes: readonly string[];
    readonly machineBlockerRuleIds: readonly string[];
    readonly openExternalGateIds: readonly string[];
  };
  readonly bindings: {
    readonly revisionManifest: CanonicalIdentity | null;
    readonly requirementsIdentity: CanonicalIdentity | null;
    readonly evidenceRootIdentity: CanonicalIdentity;
    readonly practiceCatalogIdentity: CanonicalIdentity | null;
    readonly routeQualityPolicyIdentity: CanonicalIdentity | null;
    readonly routeQualityPolicyCaptureIdentity: ContentIdentity | null;
    readonly routeQualityRuleDeckIdentity: CanonicalIdentity | null;
    readonly proofFixturePolicyIdentity: CanonicalIdentity | null;
    readonly analyzerProfileIdentity: CanonicalIdentity | null;
    readonly constraintBindingIdentity: CanonicalIdentity | null;
    readonly nativeBoardIdentity: ContentIdentity | null;
  };
  readonly checks: {
    readonly nativeDrc: EngineeringCheckSummary & {
      readonly evidenceClass: "kicad_native";
    };
    readonly evledaPractice: EngineeringCheckSummary & {
      readonly evidenceClass: "evleda_check";
      readonly analysisOutcome: "pass" | "review" | "fail" | null;
      readonly reviewRequired: boolean;
      readonly advisoryCount: number;
    };
  };
  readonly coverage: {
    readonly inventoryComplete: boolean;
    readonly expectedRuleCount: number;
    readonly evaluatedRuleCount: number;
    readonly applicableRuleCount: number;
    readonly notApplicableRuleCount: number;
    readonly statusCounts: Readonly<Record<EngineeringMachineStatus, number>>;
    readonly missingRuleIds: readonly string[];
    readonly unexpectedRuleIds: readonly string[];
  };
  readonly rules: readonly EngineeringRuleProjection[];
  readonly advisories: readonly EngineeringAdvisoryProjection[];
  readonly outstandingExternalGates: readonly EngineeringExternalGateProjection[];
  readonly gateSummary: {
    readonly machineBlockers: number;
    readonly fabricatorOpen: number;
    readonly humanOpen: number;
    readonly physicalOpen: number;
  };
  readonly findings: {
    readonly total: number;
    readonly items: readonly EngineeringFindingProjection[];
    readonly nextCursor: string | null;
  };
  readonly sources: readonly EngineeringSourceProjection[];
  readonly identity: CanonicalIdentity;
}

export interface BundleManifestArtifact {
  readonly path: string;
  readonly identity: ContentIdentity;
  readonly logicalName: string;
  readonly mediaType: string;
  readonly stage: StageKey;
  readonly validationStatus: ValidationStatus;
  readonly sourceArtifactId: string;
  readonly sourceKind: "stored_artifact" | "bundle_generated";
  readonly sourceDesignRevisionId: string;
  readonly projectId: string;
  readonly runId: string;
  /** The selected revision for which this bundle was assembled. */
  readonly designRevisionId: string;
  readonly exactInputs: readonly (ContentIdentity | CanonicalIdentity)[];
  readonly derivedFrom: readonly string[];
  readonly tool: ToolIdentity;
  readonly unresolvedAssumptions: readonly UnresolvedAssumption[];
  readonly lifecycle: "candidate" | "qualified" | "release_authorized";
  readonly createdAt: string | null;
  readonly staleAt: string | null;
  readonly generationRole?:
    | "revision_record"
    | "evidence_inventory"
    | "readme"
    | "warning"
    | "cover";
}

interface BundleManifestBase {
  readonly canonicalizationVersion: "evleda-c14n-json-v1";
  readonly bundleKind: "candidate" | "prototype";
  readonly warning: string;
  readonly projectId: string;
  readonly runId: string;
  readonly designRevisionId: string;
  readonly designRevisionOrdinal: number;
  readonly revisionManifest: CanonicalIdentity;
  readonly revisionRecordPath: "provenance/revision.json";
  readonly evidenceRoot: CanonicalIdentity;
  readonly evidenceInventoryPath: "evidence/evidence.json";
  readonly lifecycle: "candidate" | "qualified";
  readonly artifacts: readonly BundleManifestArtifact[];
  readonly toolchain: readonly ToolIdentity[];
  readonly unresolvedAssumptions: readonly UnresolvedAssumption[];
}

export type LegacyBundleExportExactInputs = readonly [
  revisionManifest: CanonicalIdentity,
  evidenceRoot: CanonicalIdentity
];

export type BundleExportExactInputs = readonly [
  revisionManifest: CanonicalIdentity,
  evidenceRoot: CanonicalIdentity,
  liveRegenerationPolicyIdentity: LiveRegenerationPolicyIdentity
];

/** Read-only compatibility shape for original, unlabeled v2 bundles. */
export interface BundleManifestV2 extends BundleManifestBase {
  readonly schemaVersion: "evleda.bundle-manifest.v2";
  readonly exactInputs?: never;
  readonly liveRegenerationPolicy?: never;
  readonly liveRegenerationPolicyIdentity?: never;
}

/** Current manifest shape. Its ordered inputs bind the policy identity into the bundle. */
export interface BundleManifestV3 extends BundleManifestBase {
  readonly schemaVersion: "evleda.bundle-manifest.v3";
  readonly exactInputs: BundleExportExactInputs;
  /** Policy label only; it does not assert that this bundle used live inputs. */
  readonly liveRegenerationPolicy: LiveRegenerationPolicy;
  readonly liveRegenerationPolicyIdentity: LiveRegenerationPolicyIdentity;
}

export type BundleManifest = BundleManifestV3;
export type AnyBundleManifest = BundleManifestV2 | BundleManifestV3;

interface BundleExportResultBase {
  readonly projectId: string;
  readonly runId: string;
  readonly designRevisionId: string;
  readonly workflowStage: "manufacturing_package";
  readonly fileName: string;
  readonly mediaType: "application/zip";
  readonly identity: ContentIdentity;
  readonly bytesBase64: string;
  readonly tool: ToolIdentity;
  readonly validationStatus: ValidationStatus;
  readonly unresolvedAssumptions: readonly UnresolvedAssumption[];
  readonly lifecycle: "candidate" | "qualified";
}

/** Read-only compatibility shape for original, unlabeled v2 export results. */
export interface BundleExportResultV2 extends BundleExportResultBase {
  readonly manifest: BundleManifestV2;
  readonly exactInputs: LegacyBundleExportExactInputs;
  readonly liveRegenerationPolicy?: never;
  readonly liveRegenerationPolicyIdentity?: never;
}

/** Current export result shape. */
export interface BundleExportResultV3 extends BundleExportResultBase {
  readonly manifest: BundleManifestV3;
  readonly exactInputs: BundleExportExactInputs;
  /** Must exactly match the policy embedded in the bundle manifest. */
  readonly liveRegenerationPolicy: LiveRegenerationPolicy;
  /** Must exactly match the policy identity embedded in the bundle manifest. */
  readonly liveRegenerationPolicyIdentity: LiveRegenerationPolicyIdentity;
}

export type LegacyBundleExportResult = BundleExportResultV2;
export type CurrentBundleExportResult = BundleExportResultV3;
export type BundleExportResult = BundleExportResultV2 | BundleExportResultV3;

export interface GeneratedArtifactResult {
  readonly projectId: string;
  readonly runId: string;
  readonly designRevisionId: string;
  readonly workflowStage: "bringup_package" | "firmware_contract";
  readonly artifact: ArtifactRecord;
  readonly revision: DesignRevision;
}

export interface QualificationResult {
  readonly approval: ApprovalRecord;
  readonly projectId: string;
  readonly runId: string;
  readonly designRevisionId: string;
  readonly stateRevision: number;
}

export interface ExternalEvidenceResult {
  readonly rawArtifact: ArtifactRecord;
  readonly parsedArtifact: ArtifactRecord;
  readonly evidence: EvidenceRecord;
  readonly evidenceRootBefore: CanonicalIdentity;
  readonly evidenceRoot: CanonicalIdentity;
  readonly categoryVerdicts: PhysicalCategoryVerdicts;
  readonly overallVerdict: "pass" | "fail";
  readonly stateRevision: number;
}

export interface AttestationResult {
  readonly approval: ApprovalRecord;
  readonly effectiveLifecycle: "candidate" | "qualified" | "release_authorized";
  readonly stateRevision: number;
}

export interface OperationResultByName {
  readonly create_project: { readonly project: Project; readonly stateRevision: number };
  readonly start_design_run: RunStatusResult;
  readonly get_run_status: RunStatusResult;
  readonly inspect_requirements: RequirementsInspectionResult;
  readonly approve_requirements: RunStatusResult;
  readonly resume_run: RunStatusResult;
  readonly list_artifacts: ArtifactListResult;
  readonly inspect_evidence: EvidenceInspectionResult;
  readonly inspect_engineering_practices: EngineeringPracticeInspectionResult;
  readonly rerun_stage: RunStatusResult;
  readonly export_candidate_bundle: BundleExportResult;
  readonly export_prototype_bundle: BundleExportResult;
  readonly generate_bringup_plan: GeneratedArtifactResult;
  readonly generate_firmware_scaffold: GeneratedArtifactResult;
}

export type OperationResult<Name extends OperationName> = OperationResultByName[Name];

export interface ApplicationCommand<Name extends OperationName = OperationName> {
  readonly operation: Name;
  readonly input: OperationInputByName[Name];
}
