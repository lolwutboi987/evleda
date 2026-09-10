import type { StageKey } from "./stages.js";

export type ProjectId = string;
export type RunId = string;
export type RevisionId = string;
export type ArtifactId = string;
export type EvidenceId = string;
export type AttemptId = string;
export type ToolInvocationId = string;

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
export type EvidenceClass =
  | "agent_claim"
  | "evleda_check"
  | "kicad_native"
  | "human_physical";

export interface ContentIdentity {
  readonly algorithm: "sha256";
  readonly digest: string;
  readonly size: number;
}

export interface CanonicalIdentity {
  readonly algorithm: "sha256";
  readonly digest: string;
  readonly schemaVersion: string;
  readonly canonicalizationVersion: "evleda-c14n-json-v1";
}

/** Canonical identity of an exact, validated portable command plan. */
export interface TypedCommandPlanIdentity extends CanonicalIdentity {
  readonly schemaVersion: "evleda.typed-command-plan.v1";
}

export interface NativeProcessPlanIdentityV1 extends CanonicalIdentity {
  readonly schemaVersion: "evleda.native-process-plan.v1";
}

export interface NativeProcessPlanIdentityV2 extends CanonicalIdentity {
  readonly schemaVersion: "evleda.native-process-plan.v2";
}

/** @deprecated Pre-production V1 inspection compatibility only; new ledgers require V2. */
export type NativeProcessPlanIdentity = NativeProcessPlanIdentityV1;

export interface NativeProcessPathRefV1 {
  readonly schemaVersion: "evleda.portable-path-ref.v1";
  readonly root: "reference" | "run_input" | "run_private" | "run_public";
  readonly relativePath: string;
}

export interface NativeProcessToolV1 {
  readonly schemaVersion: "evleda.tool-content-identity.v1";
  readonly role: "native_validator" | "runtime";
  readonly kind: "native_executable";
  readonly name: string;
  readonly version: string;
  readonly commit: string;
  readonly contentIdentity: ContentIdentity;
  readonly capabilitiesIdentity: ContentIdentity;
  readonly helpIdentity: ContentIdentity;
}

export type NativeProcessCommandArgumentV1 =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "path"; readonly value: NativeProcessPathRefV1 };

export interface NativeProcessPortableEnvironmentV1 {
  readonly schemaVersion: "evleda.portable-environment-policy.v1";
  readonly pythonHashSeed: "0";
  readonly pythonUtf8: "1";
  readonly locale: "C";
  readonly timezone: "UTC";
  readonly privateFields: readonly {
    readonly name: "HOME" | "TEMP" | "TMP" | "KICAD_CONFIG_HOME";
    readonly disposition: "excluded-private";
  }[];
}

export interface NativeProcessEnvironmentV1 {
  readonly schemaVersion: "evleda.native-process-environment.v1";
  readonly inheritance: "none";
  readonly fixed: readonly { readonly name: string; readonly value: string }[];
  readonly privateRuntime: readonly { readonly name: string; readonly disposition: "excluded-private" }[];
}

export interface NativeProcessPortableCommandV1 {
  readonly schemaVersion: "evleda.typed-command-plan.v1";
  readonly tool: NativeProcessToolV1;
  readonly logicalCwd: NativeProcessPathRefV1;
  readonly argv: readonly NativeProcessCommandArgumentV1[];
  readonly environment: NativeProcessPortableEnvironmentV1;
  readonly expectedOutputs: readonly NativeProcessPathRefV1[];
  readonly commandPlanIdentity: TypedCommandPlanIdentity;
}

export interface NativeProcessLogicalCommandV1 {
  readonly schemaVersion: "evleda.native-process-logical-command.v1";
  readonly tool: NativeProcessToolV1;
  readonly logicalCwd: NativeProcessPathRefV1;
  readonly argv: readonly NativeProcessCommandArgumentV1[];
  readonly environment: NativeProcessEnvironmentV1;
  readonly expectedOutputs: readonly NativeProcessPathRefV1[];
  readonly commandIdentity: CanonicalIdentity & {
    readonly schemaVersion: "evleda.native-process-logical-command.v1";
  };
}

export type NativeProcessCommandV1 =
  | {
      readonly kind: "portable_typed_command_v1";
      readonly value: NativeProcessPortableCommandV1;
    }
  | {
      readonly kind: "native_process_logical_command_v1";
      readonly value: NativeProcessLogicalCommandV1;
    };

export type NativeProcessProfileV1 =
  | {
      readonly schemaVersion: "evleda.native-process-profile.kicad.v1";
      readonly domain: "kicad";
      readonly operation:
        | "kicad_erc"
        | "kicad_drc"
        | "kicad_netlist"
        | "kicad_stats"
        | "kicad_d356"
        | "kicad_pdf";
      readonly contractIdentity: CanonicalIdentity;
    }
  | {
      readonly schemaVersion: "evleda.native-process-profile.firmware.v1";
      readonly domain: "firmware";
      readonly operation: "compile" | "link" | "objcopy";
      readonly contractIdentity: CanonicalIdentity;
    };

export interface NativeProcessInputPolicyV1 {
  readonly schemaVersion: "evleda.native-process-input-policy.v1";
  readonly snapshot: "immutable_before_spawn";
  readonly mutation: "immutable" | "isolated_copy";
  readonly evaluatedInput: "command_input" | "post_execution_snapshot";
}

export interface NativeProcessPlanV1 {
  readonly schemaVersion: "evleda.native-process-plan.v1";
  readonly transport: "native_process";
  readonly profile: NativeProcessProfileV1;
  readonly tool: NativeProcessToolV1;
  readonly command: NativeProcessCommandV1;
  readonly acceptedExitCodes: readonly number[];
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly inputPolicy: NativeProcessInputPolicyV1;
  readonly planIdentity: NativeProcessPlanIdentityV1;
}

export interface NativeProcessExpectedOutputV1 {
  readonly schemaVersion: "evleda.native-process-expected-output.v1";
  readonly path: NativeProcessPathRefV1;
  readonly maxBytes: number;
}

/** Current pre-production plan. V1 remains a legacy inspection type only. */
export interface NativeProcessPlanV2 {
  readonly schemaVersion: "evleda.native-process-plan.v2";
  readonly transport: "native_process";
  readonly profile: NativeProcessProfileV1;
  readonly tool: NativeProcessToolV1;
  readonly command: NativeProcessCommandV1;
  readonly expectedOutputs: readonly NativeProcessExpectedOutputV1[];
  readonly acceptedExitCodes: readonly number[];
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly inputPolicy: NativeProcessInputPolicyV1;
  readonly planIdentity: NativeProcessPlanIdentityV2;
}

export interface SourceIdentity {
  readonly kind: "prompt" | "curated" | "live_research" | "tool_output" | "human";
  readonly identity: ContentIdentity | CanonicalIdentity;
  readonly uri?: string;
  readonly retrievedAt?: string;
}

/** Public policy for regenerating outputs that depend on live model or research calls. */
export interface LiveRegenerationPolicy {
  readonly scope: "live_model_or_research";
  readonly claim: "traceable";
  readonly reproducible: false;
}

/** Canonical identity of the exact live-regeneration policy record. */
export interface LiveRegenerationPolicyIdentity extends CanonicalIdentity {
  readonly schemaVersion: "evleda.live-regeneration-policy.v1";
}

export interface ToolIdentity {
  readonly name: string;
  readonly version: string;
  readonly adapter: "evleda" | "kicad_cli" | "kicad_mcp" | "external" | "human";
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

export interface ArtifactRecord {
  readonly id: ArtifactId;
  readonly projectId: ProjectId;
  readonly runId: RunId;
  readonly designRevisionId: RevisionId;
  readonly stage: StageKey;
  readonly logicalName: string;
  readonly mediaType: string;
  readonly blob: ContentIdentity;
  readonly exactInputs: readonly (ContentIdentity | CanonicalIdentity)[];
  readonly derivedFrom: readonly ArtifactId[];
  readonly tool: ToolIdentity;
  readonly validationStatus: ValidationStatus;
  readonly unresolvedAssumptions: readonly UnresolvedAssumption[];
  readonly lifecycle: LifecycleState;
  readonly createdAt: string;
  readonly staleAt?: string;
}

export interface EvidenceRecord {
  readonly id: EvidenceId;
  readonly projectId: ProjectId;
  readonly runId: RunId;
  readonly designRevisionId: RevisionId;
  readonly stage: StageKey;
  readonly evidenceClass: EvidenceClass;
  readonly claim: string;
  readonly subjectDigests: readonly string[];
  readonly rawArtifactId?: ArtifactId;
  readonly parsedArtifactId?: ArtifactId;
  readonly exactInputs: readonly (ContentIdentity | CanonicalIdentity)[];
  readonly tool: ToolIdentity;
  readonly validationStatus: ValidationStatus;
  readonly unresolvedAssumptions: readonly UnresolvedAssumption[];
  readonly lifecycle: LifecycleState;
  readonly createdAt: string;
  readonly validUntil?: string;
  readonly staleAt?: string;
}

export interface RequirementSourceSpan {
  readonly start: number;
  readonly end: number;
  readonly excerpt: string;
}

export interface Requirement {
  readonly id: string;
  readonly statement: string;
  readonly category:
    | "power"
    | "compute"
    | "actuator"
    | "sensor"
    | "communication"
    | "mechanical"
    | "environment"
    | "safety"
    | "firmware"
    | "manufacturing";
  readonly priority: "must" | "should" | "could";
  readonly hazardClass: "none" | "functional" | "electrical" | "thermal" | "mechanical";
  readonly normalizedValue?: string;
  readonly tolerance?: string;
  readonly sourceSpans: readonly RequirementSourceSpan[];
  readonly verificationMethod: string;
  readonly acceptanceCriteria: string;
}

export interface RequirementsDocument {
  readonly schemaVersion: "evleda.requirements.v1";
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

export interface StageExecutionFence {
  readonly inputManifest: CanonicalIdentity;
  readonly parentRevisionId: RevisionId;
  readonly parentRevisionManifest: CanonicalIdentity;
  readonly projectHeadRevisionId: RevisionId;
  readonly requirementsApprovalId: string;
  readonly requirementsApprovalDigest: string;
  readonly nativeProcessPlanBindings?: readonly {
    readonly schemaVersion: "evleda.native-process-plan-binding.v3";
    readonly profileDomain: NativeProcessProfileV1["domain"];
    readonly operation: NativeProcessProfileV1["operation"];
    readonly contractIdentity: CanonicalIdentity;
    readonly planIdentity: NativeProcessPlanIdentityV2;
    readonly portableReceiptPlanIdentityV1: NativeProcessPlanIdentityV1;
  }[];
}

export interface StageAttempt {
  readonly id: AttemptId;
  readonly stage: StageKey;
  readonly attemptNumber: number;
  readonly state: StageAttemptState;
  readonly inputManifest: CanonicalIdentity;
  /** Canonical provision identity and exact persisted preimage captured before execution. */
  readonly provisionIdentity?: CanonicalIdentity;
  readonly provisionManifestBlob?: ContentIdentity;
  /** Exact executor-authored identity, accepted only after application-side recomputation. */
  readonly outputIdentity?: CanonicalIdentity;
  /** Exact revision created by this attempt; required for invocation-backed success. */
  readonly resultRevisionId?: RevisionId;
  /** Immutable commit fence captured with the input manifest. */
  readonly executionFence?: StageExecutionFence;
  readonly artifactIds: readonly ArtifactId[];
  readonly evidenceIds: readonly EvidenceId[];
  readonly blockers: readonly Blocker[];
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly fencingEpoch: number;
}

export interface DesignRevision {
  readonly id: RevisionId;
  readonly projectId: ProjectId;
  readonly runId: RunId;
  /** Exact stage attempt that created this revision; required for invocation-backed success. */
  readonly createdByAttemptId?: AttemptId;
  readonly ordinal: number;
  readonly parentRevisionIds: readonly RevisionId[];
  readonly manifest: CanonicalIdentity;
  /**
   * Content-addressed canonical JSON preimage for `manifest`. Revisions created
   * before bundle-manifest v2 may not have this field and are intentionally not
   * eligible for provenance-verifiable export.
   */
  readonly manifestRecordBlob?: ContentIdentity;
  readonly artifactIds: readonly ArtifactId[];
  readonly evidenceIds: readonly EvidenceId[];
  readonly lifecycle: LifecycleState;
  readonly createdAt: string;
}

export interface DesignRun {
  readonly id: RunId;
  readonly projectId: ProjectId;
  readonly parentRunId?: RunId;
  readonly sourcePrompt: ContentIdentity;
  readonly workflowVersion: string;
  readonly configuration: CanonicalIdentity;
  readonly state: RunState;
  readonly lifecycle: LifecycleState;
  readonly requirements?: RequirementsDocument;
  readonly attempts: Readonly<Record<StageKey, readonly StageAttempt[]>>;
  readonly headRevisionId?: RevisionId;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

export interface Project {
  readonly id: ProjectId;
  readonly name: string;
  readonly description?: string;
  readonly root: string;
  readonly policyVersion: string;
  readonly headRevisionId?: RevisionId;
  readonly runIds: readonly RunId[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

export interface HumanActor {
  readonly type: "human";
  readonly id: string;
  readonly displayName: string;
  readonly role: "requirements_reviewer" | "hardware_qualifier" | "release_authority";
}

export interface ApprovalRecord {
  readonly id: string;
  readonly kind: "requirements" | "qualification" | "manufacturing_release" | "waiver";
  readonly projectId: ProjectId;
  readonly runId?: RunId;
  readonly designRevisionId?: RevisionId;
  readonly subjectDigest: string;
  readonly evidenceRootDigest?: string;
  readonly qualificationApprovalId?: string;
  readonly policyVersion: string;
  readonly actor: HumanActor;
  readonly scope: string;
  readonly rationale: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly revokedAt?: string;
}

export type ToolInvocationOutcome =
  | "unknown"
  /** The typed command plan accepted the recorded exit code (which need not be zero). */
  | "succeeded"
  /** The child exited with a nonzero code rejected by the typed command plan. */
  | "failed"
  /** The child was terminated at its deadline and therefore has no exit-code authority. */
  | "timed_out"
  /** The caller cancelled the child and therefore has no exit-code authority. */
  | "cancelled"
  /** Spawn, capture-limit, or process-control failure produced no exit-code authority. */
  | "error";

export interface LegacyToolInvocationExecutionFenceV2 {
  readonly inputManifest: CanonicalIdentity;
  readonly parentRevisionId: RevisionId;
  readonly parentRevisionManifest: CanonicalIdentity;
  readonly projectHeadRevisionId: RevisionId;
  readonly requirementsApprovalId: string;
  readonly requirementsApprovalDigest: string;
  readonly nativeProcessPlanBindings?: readonly {
    readonly schemaVersion: "evleda.native-process-plan-binding.v1";
    readonly profileDomain: NativeProcessProfileV1["domain"];
    readonly operation: NativeProcessProfileV1["operation"];
    readonly contractIdentity: CanonicalIdentity;
    readonly planIdentity: NativeProcessPlanIdentityV1;
  }[];
}

/** Exact pre-production record-v2/plan-v1 shape; compatibility projection only. */
export interface LegacyToolInvocationRecordV2 {
  readonly schemaVersion: "evleda.tool-invocation-record.v2";
  readonly transport: "native_process";
  readonly id: ToolInvocationId;
  readonly projectId: ProjectId;
  readonly runId: RunId;
  readonly attemptId: AttemptId;
  readonly stage: StageKey;
  readonly fencingEpoch: number;
  readonly inputManifest: CanonicalIdentity;
  readonly executionFence: LegacyToolInvocationExecutionFenceV2;
  readonly toolContentIdentity: ContentIdentity;
  readonly commandPlan: NativeProcessPlanV1;
  readonly commandPlanIdentity: NativeProcessPlanIdentityV1;
  readonly stdoutIdentity: ContentIdentity | null;
  readonly stderrIdentity: ContentIdentity | null;
  readonly exitCode: number | null;
  readonly outcome: ToolInvocationOutcome;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly invocationIdentity: (CanonicalIdentity & {
    readonly schemaVersion: "evleda.tool-invocation.v1";
  }) | null;
}

/**
 * Durable two-phase invocation ledger entry.
 *
 * A writer must first append the exact `unknown` record before starting the
 * process, then replace only the terminal fields once. Retrying a command
 * requires a new stage attempt and invocation identifier.
 */
export interface ToolInvocationRecord {
  /** V4 supersedes pre-production V3 by separating current and compatibility identities. */
  readonly schemaVersion: "evleda.tool-invocation-record.v4";
  readonly transport: "native_process";
  readonly id: ToolInvocationId;
  readonly projectId: ProjectId;
  readonly runId: RunId;
  readonly attemptId: AttemptId;
  readonly stage: StageKey;
  readonly fencingEpoch: number;
  readonly inputManifest: CanonicalIdentity;
  readonly executionFence: StageExecutionFence;
  readonly toolContentIdentity: ContentIdentity;
  readonly commandPlan: NativeProcessPlanV2;
  readonly commandPlanIdentity: NativeProcessPlanIdentityV2;
  readonly stdoutIdentity: ContentIdentity | null;
  readonly stderrIdentity: ContentIdentity | null;
  readonly exitCode: number | null;
  readonly outcome: ToolInvocationOutcome;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly invocationIdentity: (CanonicalIdentity & {
    readonly schemaVersion: "evleda.tool-invocation.v2";
  }) | null;
  readonly portableReceiptInvocationIdentityV1: (CanonicalIdentity & {
    readonly schemaVersion: "evleda.tool-invocation.v1";
  }) | null;
  readonly portableReceiptInvocationIdentityDisposition: "compatibility_projection_only";
}
