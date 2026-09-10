export const STAGE_ORDER = [
  "requirements",
  "system_architecture",
  "component_selection",
  "schematic",
  "firmware_contract",
  "simulation_checks",
  "pcb_placement_routing",
  "manufacturing_package",
  "bringup_package"
] as const;

export type StageKey = (typeof STAGE_ORDER)[number];
export type LifecycleState = "candidate" | "qualified" | "release_authorized";
export type RunState =
  | "queued"
  | "running"
  | "waiting_requirements_approval"
  | "blocked"
  | "interrupted"
  | "completed"
  | "cancelled";
export type StageAttemptState =
  | "pending"
  | "running"
  | "waiting_approval"
  | "blocked"
  | "interrupted"
  | "succeeded"
  | "stale";
export type ValidationStatus =
  | "pass"
  | "fail"
  | "error"
  | "not_run"
  | "unsupported"
  | "stale"
  | "revoked"
  | "waived";

export const VALIDATION_STATUSES: readonly ValidationStatus[] = [
  "pass",
  "fail",
  "error",
  "not_run",
  "unsupported",
  "stale",
  "revoked",
  "waived"
];
export type EvidenceClass = "agent_claim" | "evleda_check" | "kicad_native" | "human_physical";

export interface ContentIdentity {
  readonly algorithm: "sha256";
  readonly digest: string;
  readonly size: number;
}

export interface CanonicalIdentity {
  readonly algorithm: "sha256";
  readonly digest: string;
  readonly schemaVersion: string;
  readonly canonicalizationVersion: string;
}

export interface ToolIdentity {
  readonly name: string;
  readonly version: string;
  readonly adapter: string;
  readonly executablePath?: string;
  readonly executableDigest?: string;
  readonly capabilityProfile?: string;
}

export interface UnresolvedAssumption {
  readonly id: string;
  readonly statement: string;
  readonly severity: "information" | "warning" | "blocking";
  readonly sourceRequirementIds: readonly string[];
}

export interface Requirement {
  readonly id: string;
  readonly statement: string;
  readonly category: string;
  readonly priority: "must" | "should" | "could";
  readonly hazardClass: string;
  readonly normalizedValue?: string;
  readonly verificationMethod: string;
  readonly acceptanceCriteria: string;
}

export interface RequirementsDocument {
  readonly schemaVersion: string;
  readonly identity: CanonicalIdentity;
  readonly sourcePrompt: ContentIdentity;
  readonly requirements: readonly Requirement[];
  readonly constraints: Readonly<Record<string, string>>;
  readonly exclusions: readonly string[];
  readonly unresolvedAssumptions: readonly UnresolvedAssumption[];
  readonly approvalId?: string;
}

export interface Blocker {
  readonly code: string;
  readonly message: string;
  readonly stage: StageKey;
  readonly affectedInputDigests: readonly string[];
  readonly requiredAction: string;
  readonly retryable: boolean;
  readonly createdAt: string;
}

export interface StageAttempt {
  readonly id: string;
  readonly stage: StageKey;
  readonly attemptNumber: number;
  readonly state: StageAttemptState;
  readonly artifactIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly blockers: readonly Blocker[];
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly root?: string;
  readonly policyVersion?: string;
  readonly headRevisionId?: string;
  readonly runIds: readonly string[];
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly revision?: number;
}

export interface DesignRun {
  readonly id: string;
  readonly projectId: string;
  readonly state: RunState;
  readonly lifecycle: LifecycleState;
  readonly attempts: Readonly<Partial<Record<StageKey, readonly StageAttempt[]>>>;
  readonly headRevisionId?: string;
  readonly requirements?: RequirementsDocument;
  readonly workflowVersion?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision?: number;
}

export interface ArtifactRecord {
  readonly id: string;
  readonly projectId: string;
  readonly runId: string;
  readonly designRevisionId: string;
  readonly stage: StageKey;
  readonly logicalName: string;
  readonly mediaType: string;
  readonly blob: ContentIdentity;
  readonly exactInputs: readonly (ContentIdentity | CanonicalIdentity)[];
  readonly derivedFrom: readonly string[];
  readonly tool: ToolIdentity;
  readonly validationStatus: ValidationStatus;
  readonly unresolvedAssumptions: readonly UnresolvedAssumption[];
  readonly lifecycle: LifecycleState;
  readonly createdAt: string;
  readonly staleAt?: string;
}

export interface EvidenceRecord {
  readonly id: string;
  readonly projectId: string;
  readonly runId: string;
  readonly designRevisionId: string;
  readonly stage: StageKey;
  readonly evidenceClass: EvidenceClass;
  readonly claim: string;
  readonly subjectDigests: readonly string[];
  readonly rawArtifactId?: string;
  readonly parsedArtifactId?: string;
  readonly exactInputs: readonly (ContentIdentity | CanonicalIdentity)[];
  readonly tool: ToolIdentity;
  readonly validationStatus: ValidationStatus;
  readonly unresolvedAssumptions: readonly UnresolvedAssumption[];
  readonly lifecycle: LifecycleState;
  readonly createdAt: string;
  readonly validUntil?: string;
  readonly staleAt?: string;
}

/** Mirrors the read-only public projection in src/application/results.ts. */
export type EngineeringMachineStatus = "PASS" | "FAIL" | "UNKNOWN" | "NOT_RUN";
export type EngineeringApplicability = "APPLICABLE" | "NOT_APPLICABLE" | "UNKNOWN";
export type EngineeringDispositionStatus = "PROVISIONAL_POC" | "BLOCKED_DIAGNOSTIC";
export type EngineeringExactIdentity = ContentIdentity | CanonicalIdentity;

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
  /** Null only when applicability is NOT_APPLICABLE. */
  readonly machineStatus: EngineeringMachineStatus | null;
  readonly blocking: boolean;
  readonly decisionClasses: readonly string[];
  readonly reasonCode: string;
  readonly sourceIds: readonly string[];
  readonly exactInputIdentities: readonly EngineeringExactIdentity[];
  readonly checkerResultIdentities: readonly EngineeringExactIdentity[];
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
  readonly exactInputIdentities: readonly EngineeringExactIdentity[];
  readonly evidenceIds: readonly string[];
}

export interface EngineeringFindingLocation {
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
  readonly locations: readonly EngineeringFindingLocation[];
  readonly remediation: {
    readonly authority: "advisory_only";
    readonly requiresNewRevision: true;
    readonly summary: string;
    readonly steps: readonly string[];
    readonly verification: readonly string[];
    readonly rerunRuleIds: readonly string[];
    readonly rerunStages: readonly StageKey[];
  };
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
    readonly status: EngineeringDispositionStatus;
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

export interface ApprovalInput {
  readonly rationale: string;
  readonly subjectDigest: string;
  readonly capabilityToken?: string;
}

export interface QualificationInput {
  readonly scope: string;
  readonly rationale: string;
  readonly capabilityToken: string;
}

export interface DesignRevisionSummary {
  readonly id: string;
  readonly projectId: string;
  readonly runId: string;
  readonly manifest: CanonicalIdentity;
  readonly lifecycle: LifecycleState;
}

export interface BenchSnapshot {
  readonly projects: readonly Project[];
  readonly project: Project;
  readonly run: DesignRun;
  readonly requirements?: RequirementsDocument;
  readonly artifacts: readonly ArtifactRecord[];
  readonly evidence: readonly EvidenceRecord[];
}

export const stageLabel = (stage: StageKey): string =>
  ({
    requirements: "Requirements",
    system_architecture: "System architecture",
    component_selection: "Component selection",
    schematic: "Schematic",
    firmware_contract: "Firmware contract",
    simulation_checks: "Simulation / checks",
    pcb_placement_routing: "PCB placement / routing",
    manufacturing_package: "Manufacturing package",
    bringup_package: "Bring-up package"
  })[stage];

export const statusLabel = (value: string): string => value.replaceAll("_", " ");

export const currentAttempt = (
  run: DesignRun,
  stage: StageKey
): StageAttempt | undefined => run.attempts[stage]?.at(-1);

export const shortDigest = (digest: string | undefined): string => {
  if (!digest) return "—";
  return digest.length > 16 ? `${digest.slice(0, 8)}…${digest.slice(-6)}` : digest;
};

const isFuture = (value: string | undefined, now: Date): boolean =>
  value === undefined || Date.parse(value) > now.getTime();

const isPhysicalV2Artifact = (
  artifact: ArtifactRecord | undefined,
  revisionId: string,
  expectedMediaType: "application/zip" | "application/json"
): boolean =>
  artifact !== undefined &&
  artifact.designRevisionId === revisionId &&
  artifact.stage === "bringup_package" &&
  artifact.mediaType === expectedMediaType &&
  artifact.validationStatus === "pass" &&
  artifact.staleAt === undefined &&
  artifact.lifecycle === "candidate" &&
  artifact.tool.name === "human-physical-evidence" &&
  artifact.tool.version === "2" &&
  artifact.tool.adapter === "human";

/**
 * Mirrors the metadata-visible part of the server's fail-closed physical-v2 gate.
 * The server remains authoritative and revalidates source bytes, the v2 schema,
 * the exact head revision, and the complete current evidence root on submission.
 */
export const hasCurrentPassingPhysicalV2Evidence = (
  evidence: readonly EvidenceRecord[],
  artifacts: readonly ArtifactRecord[],
  revisionId: string | undefined,
  now = new Date()
): boolean => {
  if (!revisionId) return false;
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const physical = evidence.filter((record) => record.evidenceClass === "human_physical");
  if (physical.length === 0) return false;

  return physical.every(
    (record) =>
      record.designRevisionId === revisionId &&
      record.validationStatus === "pass" &&
      record.staleAt === undefined &&
      isFuture(record.validUntil, now) &&
      record.lifecycle === "candidate" &&
      record.tool.name === "human-physical-evidence" &&
      record.tool.version === "2" &&
      record.tool.adapter === "human" &&
      record.rawArtifactId !== undefined &&
      record.parsedArtifactId !== undefined &&
      isPhysicalV2Artifact(byId.get(record.rawArtifactId), revisionId, "application/zip") &&
      isPhysicalV2Artifact(byId.get(record.parsedArtifactId), revisionId, "application/json")
  );
};
