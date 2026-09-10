import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { unzipSync, zipSync, type Zippable } from "fflate";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import {
  evidenceIsCurrent,
  evidenceRecordProjection,
  evidenceRoot as deriveEvidenceRoot
} from "../core/evidence.js";
import { deterministicId } from "../core/ids.js";
import {
  resolveExistingWithinRoot,
  resolveWithinRoot,
  resolveWriteTargetWithinRoot
} from "../core/path-policy.js";
import {
  assertPrototypeExportAllowed,
  assertRequirementsApproval,
  deriveLifecycleDecision
} from "../core/policy.js";
import { parseRequirements, requirementsAreApprovable } from "../core/requirements.js";
import type { CommandContext } from "../contracts/capabilities.js";
import { SYSTEM_CONTEXT } from "../contracts/capabilities.js";
import {
  assertHumanCapability,
  failureEnvelope,
  successEnvelope,
  type OperationEnvelope
} from "../contracts/errors.js";
import {
  bundleExportReplayV1Schema,
  bundleExportReplayV2Schema,
  canonicalIdentitySchema,
  contentIdentitySchema,
  currentBundleExportResultSchema,
  engineeringPracticeInspectionResultSchema,
  legacyBundleExportResultSchema,
  LIVE_REGENERATION_POLICY,
  LIVE_REGENERATION_POLICY_IDENTITY
} from "../contracts/results.js";
import {
  operationInputSchemas,
  type ApproveRequirementsInput,
  type CreateProjectInput,
  type ExportCandidateBundleInput,
  type ExportPrototypeBundleInput,
  type GenerateBringupPlanInput,
  type GenerateFirmwareScaffoldInput,
  type GetRunStatusInput,
  type InspectEvidenceInput,
  type InspectEngineeringPracticesInput,
  type InspectRequirementsInput,
  type ListArtifactsInput,
  type OperationInputByName,
  type OperationName,
  type RerunStageInput,
  type ResumeRunInput,
  type StartDesignRunInput,
  qualifyRevisionInputSchema,
  type QualifyRevisionInput,
  bringupPlanSchema,
  humanPhysicalEvidenceRecordSchema,
  physicalAcceptanceContractSchema,
  physicalAsBuiltRecordSchema,
  physicalFirmwareFlashRecordSchema,
  physicalInstrumentCalibrationRecordSchema,
  physicalMeasurementRecordSchema,
  PHYSICAL_EVIDENCE_POLICY,
  type HumanPhysicalEvidenceRecord,
  type PhysicalAcceptanceContract,
  type PhysicalArtifactBindings,
  type PhysicalBringupPlan,
  type PhysicalInstrumentCalibrationRecord,
  type PhysicalCategoryVerdicts,
  submitExternalEvidenceInputSchema,
  submitExternalEvidenceCurrentInputSchema,
  type SubmitExternalEvidenceInput,
  authorizeManufacturingReleaseInputSchema,
  type AuthorizeManufacturingReleaseInput,
  revokeAttestationInputSchema,
  type RevokeAttestationInput
} from "../contracts/operations.js";
import { DomainError } from "../domain/errors.js";
import {
  buildEngineeringPracticeInspection,
  type EngineeringInspectionExecution
} from "../engineering/engineering-practice-inspection.js";
import {
  validateAndSnapshotEngineeringConstraintBinding,
  type EngineeringCheckerResult,
  type EngineeringEvidenceIdentity
} from "../engineering/constraint-compiler.js";
import { validateAndSnapshotPcbEngineeringPracticeCatalog } from "../knowledge/pcb-engineering-practices.js";
import {
  analyzeKicadPcbPractices,
  validateAndSnapshotPcbPracticeAnalysisProfile,
  type PcbPracticeAnalysis,
  type PcbPracticeAnalysisProfile
} from "../integrations/pcb-practice-analyzer.js";
import {
  PCB_LAYOUT_QUALITY_POLICY,
  PCB_LAYOUT_QUALITY_POLICY_SCHEMA,
  PCB_ROUTE_QUALITY_RULE_DECK,
  PCB_ROUTE_QUALITY_RULE_DECK_SCHEMA,
  REV_A_PROOF_FIXTURE_POLICY,
  REV_A_PROOF_FIXTURE_POLICY_SCHEMA
} from "../generators/pcb-layout-plan.js";
import {
  CANDIDATE_APPLICATION_TOOL,
  GENERATED_BRINGUP_PLAN_CONTRACT,
  GENERATED_BRINGUP_PLAN_WARNING,
  generatedBringupPlan
} from "../domain/candidate-generation-contract.js";
import { downstreamStages, stageIndex, STAGE_ORDER, type StageKey } from "../domain/stages.js";
import type {
  ApprovalRecord,
  ArtifactRecord,
  Blocker,
  CanonicalIdentity,
  ContentIdentity,
  DesignRevision,
  DesignRun,
  EvidenceRecord,
  HumanActor,
  Project,
  StageAttempt,
  ToolIdentity,
  UnresolvedAssumption
} from "../domain/types.js";
import {
  isCommittedStateTransactionError,
  type CommittedStateTransaction,
  type EvlEdaState,
  type IdempotencyRecord,
  type MutableEvlEdaState
} from "../persistence/state-store.js";
import {
  EVLEDA_AUDIT_EVENT_SCHEMA_VERSION,
  EVLEDA_AUDIT_OUTBOX_SCHEMA_VERSION,
  type AuditEvent
} from "../persistence/audit-log.js";
import { acquireRunExecutionLease } from "../persistence/run-execution-lease.js";
import type {
  ArtifactDraft,
  CandidateStageContext,
  EvidenceDraft,
  FirmwareCompileBackendConfiguration,
  FirmwareTargetBuildBackendConfiguration,
  StageExecutionResult
} from "../workflow/contracts.js";
import {
  FIRMWARE_COMPILE_BACKEND_CONFIGURATION_SCHEMA,
  FIRMWARE_COMPILE_ENVIRONMENT_SCHEMA,
  FIRMWARE_TARGET_BUILD_CONFIGURATION_SCHEMA,
  KICAD_NATIVE_REPORT_COMMAND_PREFIXES,
  UPSTREAM_STAGE_SOURCE_REVISION_BINDING_SCHEMA,
  buildKicadPcbEngineeringDecisionSummary,
  type KicadEvledaCheckReportKind,
  type KicadNativeReportKind,
  type KicadReportKind,
  type UpstreamStageSourceRevisionBinding,
} from "../workflow/contracts.js";
import {
  REFERENCE_KICAD_ANALYZER_TOOLS,
  REFERENCE_KICAD_REQUEST_BINDING_SCHEMA,
  REFERENCE_KICAD_REPORT_SCHEMA
} from "../integrations/reference-kicad-backend.js";
import {
  validateFirmwareTargetBuildConfiguration,
  validateFirmwareTargetBuildReport,
  type FirmwareTargetBuildReportExpectation
} from "../generators/firmware-contract-generator.js";
import {
  STAGE_CONTEXT_ENRICHMENT_SCHEMA,
  STAGE_PROVISION_SCHEMA,
  type ApplicationPorts,
  type StageContextProvision,
  type StageProvisionManifest
} from "./ports.js";
import {
  evaluatePhysicalEvidence,
  type DerivedPhysicalResultsV3,
  type PhysicalTargetBuildBinding
} from "./physical-evidence.js";
import type {
  ArtifactListResult,
  BundleExportResult,
  BundleManifest,
  BundleManifestArtifact,
  CurrentBundleExportResult,
  EvidenceInspectionResult,
  EngineeringPracticeInspectionResult,
  GeneratedArtifactResult,
  OperationResult,
  QualificationResult,
  ExternalEvidenceResult,
  AttestationResult,
  RequirementsInspectionResult,
  RunStatusResult
} from "./results.js";

const APPLICATION_TOOL: ToolIdentity = CANDIDATE_APPLICATION_TOOL;

const BUNDLE_TOOL: ToolIdentity = {
  name: "evleda-deterministic-bundler",
  version: "0.1.0",
  adapter: "evleda",
  capabilityProfile: "deterministic-zip-v3"
};

const LEGACY_BUNDLE_TOOL: ToolIdentity = {
  ...BUNDLE_TOOL,
  capabilityProfile: "deterministic-zip-v2"
};

const BUNDLE_EXPORT_REPLAY_SCHEMA_VERSION = "evleda.bundle-export-replay.v2" as const;
const LEGACY_BUNDLE_EXPORT_REPLAY_SCHEMA_VERSION =
  "evleda.bundle-export-replay.v1" as const;
const CANDIDATE_BUNDLE_WARNING = "CANDIDATE — NOT FOR MANUFACTURING" as const;
const PROTOTYPE_BUNDLE_WARNING = "PROTOTYPE — NOT PRODUCTION RELEASED" as const;

const KICAD_CLI_REPORT_AUTHORITY_SCHEMA = "evleda.kicad-cli-report-authority.v2" as const;
const KICAD_ANALYZER_REPORT_AUTHORITY_SCHEMA =
  "evleda.kicad-analyzer-report-authority.v2" as const;

/** Server-owned allowlist. Current catalog checker evidence is non-gating. */
const APPROVED_ENGINEERING_CHECKER_TOOLS: ReadonlyMap<string, ToolIdentity> = new Map();

const REQUIRED_KICAD_REPORTS_BY_STAGE = Object.freeze({
  schematic: Object.freeze({
    native: ["erc", "schematic_netlist"],
    derived: ["connectivity"]
  }),
  pcb_placement_routing: Object.freeze({
    native: ["drc", "schematic_netlist", "board_statistics", "board_netlist"],
    derived: ["schematic_parity", "connectivity", "geometry", "pcb_practices"]
  }),
  manufacturing_package: Object.freeze({
    native: ["drc", "schematic_netlist", "board_statistics", "board_netlist"],
    derived: [
      "schematic_parity",
      "bom_parity",
      "bom_export",
      "gerber_export",
      "drill_export",
      "position_export",
      "cam_manifest"
    ]
  })
} as const satisfies Readonly<
  Record<
    Extract<StageKey, "schematic" | "pcb_placement_routing" | "manufacturing_package">,
    {
      readonly native: readonly KicadNativeReportKind[];
      readonly derived: readonly KicadEvledaCheckReportKind[];
    }
  >
>);

const REPORT_STAGE_KEYS = Object.keys(REQUIRED_KICAD_REPORTS_BY_STAGE) as readonly Extract<
  StageKey,
  "schematic" | "pcb_placement_routing" | "manufacturing_package"
>[];

const KICAD_NATIVE_REPORT_KINDS = Object.keys(
  KICAD_NATIVE_REPORT_COMMAND_PREFIXES
) as readonly KicadNativeReportKind[];

const KICAD_DERIVED_REPORT_KINDS = Object.keys(
  REFERENCE_KICAD_ANALYZER_TOOLS
) as readonly KicadEvledaCheckReportKind[];

const lifecycleCoverBytes = (
  warning: BundleManifest["warning"],
  lifecycle: "candidate" | "qualified"
): Buffer => {
  const policy = lifecycle === "candidate"
    ? {
        accent: "#8a2400",
        label: "REVIEW CANDIDATE ONLY",
        detail: "Not qualified or authorized for fabrication or manufacturing."
      }
    : {
        accent: "#6b4b00",
        label: "CONTROLLED PROTOTYPE ONLY",
        detail: "Qualified only for the bound prototype scope. Production is not released."
      };
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900" role="img" aria-labelledby="title description">\n` +
      `  <title id="title">${warning}</title>\n` +
      `  <desc id="description">${policy.label}. Lifecycle: ${lifecycle}.</desc>\n` +
      `  <rect width="1600" height="900" fill="#15171a"/>\n` +
      `  <rect x="48" y="48" width="1504" height="804" rx="28" fill="${policy.accent}" stroke="#ffffff" stroke-width="8"/>\n` +
      `  <text x="800" y="300" text-anchor="middle" fill="#ffffff" font-family="Arial, Helvetica, sans-serif" font-size="60" font-weight="700">${warning}</text>\n` +
      `  <text x="800" y="455" text-anchor="middle" fill="#ffffff" font-family="Arial, Helvetica, sans-serif" font-size="54" font-weight="700">${policy.label}</text>\n` +
      `  <text x="800" y="565" text-anchor="middle" fill="#ffffff" font-family="Arial, Helvetica, sans-serif" font-size="42">Lifecycle: ${lifecycle}</text>\n` +
      `  <text x="800" y="670" text-anchor="middle" fill="#ffffff" font-family="Arial, Helvetica, sans-serif" font-size="30">${policy.detail}</text>\n` +
      `</svg>\n`,
    "utf8"
  );
};

const FIXED_ZIP_TIME = new Date(1980, 0, 1, 0, 0, 0, 0);

const recordMap = <Value>(record: Readonly<Record<string, unknown>>): Record<string, Value> =>
  record as Record<string, Value>;

const attemptsRecord = (): Readonly<Record<StageKey, readonly StageAttempt[]>> =>
  Object.fromEntries(STAGE_ORDER.map((stage) => [stage, []])) as unknown as Record<
    StageKey,
    readonly StageAttempt[]
  >;

const activeAttempt = (attempts: readonly StageAttempt[]): StageAttempt | undefined =>
  [...attempts].reverse().find((attempt) => attempt.state !== "stale");

const activeSuccessfulAttempt = (attempts: readonly StageAttempt[]): StageAttempt | undefined =>
  [...attempts]
    .reverse()
    .find((attempt) => attempt.state === "succeeded");

const uniqueSorted = (values: readonly string[]): readonly string[] =>
  [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));

const withoutIdempotencyKey = (input: object): Record<string, unknown> => {
  const copy = { ...(input as Record<string, unknown>) };
  delete copy.idempotencyKey;
  return copy;
};

const safeArchiveName = (value: string): string => {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 120);
  return normalized.length === 0 ? "artifact.bin" : normalized;
};

const sameActor = (left: HumanActor, right: HumanActor): boolean =>
  left.type === right.type && left.id === right.id && left.role === right.role;

const sameContentIdentity = (left: ContentIdentity, right: ContentIdentity): boolean =>
  left.algorithm === right.algorithm && left.digest === right.digest && left.size === right.size;

type ParsedToolIdentity = {
  readonly name: string;
  readonly version: string;
  readonly adapter: "evleda" | "kicad_cli" | "kicad_mcp" | "external" | "human";
  readonly executablePath?: string | undefined;
  readonly executableDigest?: string | undefined;
  readonly capabilityProfile?: string | undefined;
};

const sameToolIdentity = (left: ParsedToolIdentity, right: ParsedToolIdentity): boolean =>
  canonicalJson(left) === canonicalJson(right);

const isBundleToolFamily = (tool: ParsedToolIdentity): boolean =>
  tool.name === BUNDLE_TOOL.name ||
  tool.capabilityProfile?.startsWith("deterministic-zip-") === true;

const sameExactInputList = (
  left: readonly (ContentIdentity | CanonicalIdentity)[],
  right: readonly (ContentIdentity | CanonicalIdentity)[]
): boolean =>
  canonicalIdentity(left, "evleda.exact-input-list.v1").digest ===
  canonicalIdentity(right, "evleda.exact-input-list.v1").digest;

const isRecordValue = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const contentIdentityValue = (value: unknown): ContentIdentity | undefined => {
  if (
    !isRecordValue(value) ||
    value.algorithm !== "sha256" ||
    typeof value.digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.digest) ||
    typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0
  ) {
    return undefined;
  }
  return { algorithm: "sha256", digest: value.digest, size: value.size };
};

const canonicalIdentityValue = (value: unknown): CanonicalIdentity | undefined => {
  if (
    !isRecordValue(value) ||
    value.algorithm !== "sha256" ||
    typeof value.digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.digest) ||
    typeof value.schemaVersion !== "string" ||
    value.schemaVersion.length === 0 ||
    value.canonicalizationVersion !== "evleda-c14n-json-v1"
  ) {
    return undefined;
  }
  return {
    algorithm: "sha256",
    digest: value.digest,
    schemaVersion: value.schemaVersion,
    canonicalizationVersion: "evleda-c14n-json-v1"
  };
};

const exactObjectKeys = (
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[]
): boolean => {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  return canonicalJson(actual) === canonicalJson(expected);
};

const canonicalJsonBytesMatch = (bytes: Buffer, value: unknown): boolean => {
  const canonical = Buffer.from(canonicalJson(value), "utf8");
  return bytes.equals(canonical) || bytes.equals(Buffer.concat([canonical, Buffer.from("\n")]));
};

const exactInputIncludes = (
  inputs: readonly (ContentIdentity | CanonicalIdentity)[],
  expected: ContentIdentity | CanonicalIdentity
): boolean => inputs.some((input) => canonicalJson(input) === canonicalJson(expected));

const authorityIdentities = (
  inputs: readonly (ContentIdentity | CanonicalIdentity)[],
  schemaVersion: string
): readonly CanonicalIdentity[] =>
  inputs.filter(
    (input): input is CanonicalIdentity =>
      "schemaVersion" in input && input.schemaVersion === schemaVersion
  );

const reportClaimDigest = (claim: string, prefix: string): string | undefined => {
  const suffix = ".";
  if (!claim.startsWith(prefix) || !claim.endsWith(suffix)) return undefined;
  const digest = claim.slice(prefix.length, -suffix.length);
  return /^[0-9a-f]{64}$/u.test(digest) ? digest : undefined;
};

const nativeReportClaimDigest = (
  entry: EvidenceRecord,
  kind: KicadNativeReportKind
): string | undefined =>
  reportClaimDigest(
    entry.claim,
    `Direct kicad-cli ${kind} output for source revision `
  );

const derivedReportClaimDigest = (
  entry: EvidenceRecord,
  kind: KicadEvledaCheckReportKind
): string | undefined =>
  reportClaimDigest(
    entry.claim,
    `EvlEDA ${REFERENCE_KICAD_ANALYZER_TOOLS[kind].capabilityProfile} ${kind} check over exact native inputs for source revision `
  );

interface ClaimedNativeReport {
  readonly kind: KicadNativeReportKind;
  readonly sourceRevisionDigest: string;
}

interface ClaimedDerivedReport {
  readonly kind: KicadEvledaCheckReportKind;
  readonly analyzerId: string;
  readonly sourceRevisionDigest: string;
}

const claimedNativeReport = (entry: EvidenceRecord): ClaimedNativeReport | undefined => {
  for (const kind of KICAD_NATIVE_REPORT_KINDS) {
    const sourceRevisionDigest = nativeReportClaimDigest(entry, kind);
    if (sourceRevisionDigest !== undefined) return { kind, sourceRevisionDigest };
  }
  return undefined;
};

const claimedDerivedReport = (entry: EvidenceRecord): ClaimedDerivedReport | undefined => {
  const claimPrefix = "EvlEDA ";
  const digestMarker = " check over exact native inputs for source revision ";
  if (!entry.claim.startsWith(claimPrefix) || !entry.claim.endsWith(".")) return undefined;
  for (const kind of KICAD_DERIVED_REPORT_KINDS) {
    const kindMarker = ` ${kind}${digestMarker}`;
    const markerIndex = entry.claim.indexOf(kindMarker, claimPrefix.length);
    if (markerIndex < 0) continue;
    const analyzerId = entry.claim.slice(claimPrefix.length, markerIndex);
    const sourceRevisionDigest = entry.claim.slice(
      markerIndex + kindMarker.length,
      -1
    );
    if (
      /^[a-z0-9][a-z0-9._-]*$/u.test(analyzerId) &&
      /^[0-9a-f]{64}$/u.test(sourceRevisionDigest)
    ) {
      return { kind, analyzerId, sourceRevisionDigest };
    }
  }
  return undefined;
};

interface RevisionEvidenceProjection {
  readonly ancestry: ReadonlySet<string>;
  readonly artifacts: readonly ArtifactRecord[];
  readonly evidence: readonly EvidenceRecord[];
  readonly evidenceRoot: CanonicalIdentity;
}

interface ResolvedPhysicalArtifactBindings {
  readonly plan: PhysicalBringupPlan;
  readonly acceptanceContract: PhysicalAcceptanceContract;
  readonly targetBuild: PhysicalTargetBuildBinding;
}

interface EngineeringSnapshotReference {
  readonly logicalName: string;
  readonly contentIdentity: ContentIdentity;
  readonly canonicalIdentity: CanonicalIdentity;
}

interface EngineeringInputReferences {
  readonly layoutPlan: {
    readonly logicalName: string;
    readonly contentIdentity: ContentIdentity;
  };
  readonly analyzerProfile: EngineeringSnapshotReference;
  readonly practiceCatalog: EngineeringSnapshotReference;
  readonly routeQualityPolicy: EngineeringSnapshotReference & {
    readonly captureIdentity: ContentIdentity;
  };
  readonly routeQualityRuleDeck: EngineeringSnapshotReference;
  readonly proofFixturePolicy: EngineeringSnapshotReference;
  readonly engineeringConstraintBinding:
    | (EngineeringSnapshotReference & {
        readonly compiledConstraintSetIdentity: CanonicalIdentity;
      })
    | null;
}

interface ValidatedNativeEngineeringReport {
  readonly execution: EngineeringInspectionExecution;
  readonly artifact: ArtifactRecord;
  readonly evidence: EvidenceRecord;
}

interface ValidatedEngineeringPracticeReport {
  readonly execution: EngineeringInspectionExecution & {
    readonly analysis: PcbPracticeAnalysis;
    readonly reviewRequired: boolean;
  };
  readonly catalog: ReturnType<typeof validateAndSnapshotPcbEngineeringPracticeCatalog>;
  readonly analyzerProfile: PcbPracticeAnalysisProfile;
  readonly routeQualityPolicy: Readonly<Record<string, unknown>>;
  readonly routeQualityPolicyIdentity: CanonicalIdentity;
  readonly routeQualityPolicyCaptureIdentity: ContentIdentity;
  readonly routeQualityRuleDeck: Readonly<Record<string, unknown>>;
  readonly routeQualityRuleDeckIdentity: CanonicalIdentity;
  readonly proofFixturePolicyIdentity: CanonicalIdentity;
  readonly constraintBinding: ReturnType<typeof validateAndSnapshotEngineeringConstraintBinding> | null;
  readonly nativeBoard: {
    readonly artifactId: string;
    readonly identity: ContentIdentity;
  };
}

type StoredBundleExportReplayV1 = ReturnType<typeof bundleExportReplayV1Schema.parse>;
type StoredBundleExportReplayV2 = ReturnType<typeof bundleExportReplayV2Schema.parse>;
type StoredBundleExportReplay = StoredBundleExportReplayV1 | StoredBundleExportReplayV2;

interface IdempotencyLookup {
  readonly storageKey: string;
  readonly record: IdempotencyRecord;
}

interface ServiceOptions {
  readonly workspaceRoot: string;
  readonly policyVersion?: string;
  readonly workflowVersion?: string;
  readonly now?: () => Date;
  readonly newUuid?: () => string;
}

interface MutationResult<Result> {
  readonly state: EvlEdaState;
  readonly result: Result;
  readonly committed: boolean;
}

interface TransitionAuditDetails {
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly projectId?: string;
  readonly runId?: string;
  readonly subjectDigest?: string;
}

type TransitionAuditFactory<Result> = (
  result: Result,
  state: MutableEvlEdaState
) => TransitionAuditDetails;

type TransitionAuditSubject = Pick<
  TransitionAuditDetails,
  "projectId" | "runId" | "subjectDigest"
>;

type DurableOperationName =
  | OperationName
  | "submit_external_evidence"
  | "qualify_revision"
  | "authorize_manufacturing_release"
  | "revoke_attestation";

class IdempotencyReplay extends Error {
  public constructor(public readonly result: unknown) {
    super("Idempotent command already committed");
  }
}

class AuthenticCommittedAuditDeliveryError<Result> extends DomainError {
  public readonly transactionOutcome = "committed_repair_required" as const;
  public readonly maintenancePhases = ["audit_delivery"] as const;
  public maintenanceRepairStatus: "pending" | "succeeded" | "failed" = "pending";
  public maintenanceRepairFailure: unknown;
  public auditRepairStatus: "not_attempted" | "succeeded" | "failed" = "not_attempted";
  public auditRepairFailure: unknown;
  #repairPromise: Promise<void> | undefined;

  public constructor(
    public readonly committed: CommittedStateTransaction<Result>,
    cause: unknown,
    private readonly repair: () => Promise<void>
  ) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(
      "ARTIFACT_INTEGRITY_ERROR",
      `State transaction committed, but audit delivery failed: ${message}; retry the exact command to recover its durable result`,
      {
        transactionOutcome: "committed_repair_required",
        stateRevision: committed.state.revision,
        phases: ["audit_delivery"],
        failures: [{ phase: "audit_delivery", message }],
        requiredAction: "Retry the exact command and idempotency key; do not issue a different mutation."
      },
      true
    );
    this.name = "CommittedAuditDeliveryError";
  }

  public async repairMaintenance(): Promise<void> {
    if (this.maintenanceRepairStatus === "succeeded") return;
    if (this.#repairPromise !== undefined) return this.#repairPromise;
    const pending = this.repair().then(
      () => {
        this.maintenanceRepairStatus = "succeeded";
        this.maintenanceRepairFailure = undefined;
      },
      (error: unknown) => {
        this.maintenanceRepairStatus = "failed";
        this.maintenanceRepairFailure = error;
        throw error;
      }
    );
    this.#repairPromise = pending;
    try {
      await pending;
    } catch (error) {
      if (this.#repairPromise === pending) this.#repairPromise = undefined;
      throw error;
    }
  }

  public recordAuditRepair(status: "succeeded" | "failed", failure?: unknown): void {
    this.auditRepairStatus = status;
    this.auditRepairFailure = failure;
  }
}

const stageCommitFailures = new WeakMap<object, unknown>();

class StageCommitFailureRelay extends Error {
  public constructor(cause: unknown) {
    super("Authenticated stage commit outcome");
    stageCommitFailures.set(this, cause);
  }
}

const takeStageCommitFailure = (value: unknown): { readonly cause: unknown } | undefined => {
  if (typeof value !== "object" || value === null || !stageCommitFailures.has(value)) return undefined;
  const cause = stageCommitFailures.get(value);
  stageCommitFailures.delete(value);
  return { cause };
};

const DEFAULT_APPLICATION_IDLE_TIMEOUT_MS = 15_000;
const MAX_APPLICATION_IDLE_TIMEOUT_MS = 2_147_483_647;

const applicationIdleTimeout = (timeoutMs: number | undefined): number => {
  const value = timeoutMs ?? DEFAULT_APPLICATION_IDLE_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_APPLICATION_IDLE_TIMEOUT_MS) {
    throw new RangeError(
      `Application service idle timeout must be an integer from 1 through ${String(MAX_APPLICATION_IDLE_TIMEOUT_MS)}`
    );
  }
  return value;
};

const TRACKED_APPLICATION_METHODS = [
  "initialize",
  "createProject",
  "startDesignRun",
  "getRunStatus",
  "inspectRequirements",
  "approveRequirements",
  "resumeRun",
  "listArtifacts",
  "inspectEvidence",
  "inspectEngineeringPractices",
  "rerunStage",
  "exportCandidateBundle",
  "submitExternalEvidence",
  "qualifyRevision",
  "exportPrototypeBundle",
  "authorizeManufacturingRelease",
  "revokeAttestation",
  "generateBringupPlan",
  "generateFirmwareScaffold",
  "listProjects",
  "listRuns",
  "readArtifact"
] as const;

export interface ApplicationServiceIdleOptions {
  /** Finite upper bound for waiting. Defaults to 15 seconds. */
  readonly timeoutMs?: number;
  /** Cancels only the wait. It never abandons or declares an active write settled. */
  readonly signal?: AbortSignal;
}

export class ApplicationServiceClosedError extends Error {
  public constructor() {
    super("Application service is closing or closed");
    this.name = "ApplicationServiceClosedError";
  }
}

export class ApplicationServiceIdleTimeoutError extends Error {
  public constructor(public readonly timeoutMs: number) {
    super(`Application service did not become idle within ${String(timeoutMs)} ms`);
    this.name = "ApplicationServiceIdleTimeoutError";
  }
}

export class ApplicationService {
  readonly #workspaceRoot: string;
  readonly #policyVersion: string;
  readonly #workflowVersion: string;
  readonly #now: () => Date;
  readonly #newUuid: () => string;
  #structurallyInitialized = false;
  #structuralInitializationPromise: Promise<void> | undefined;
  readonly #operationScope = new AsyncLocalStorage<{
    auditReconciliationIdentity?: string;
  }>();
  readonly #activeOperations = new Set<symbol>();
  readonly #idleWaiters = new Set<() => void>();
  #acceptingOperations = true;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  public constructor(
    private readonly ports: ApplicationPorts,
    options: ServiceOptions
  ) {
    this.#workspaceRoot = path.resolve(options.workspaceRoot);
    this.#policyVersion = options.policyVersion ?? "evleda.policy.v1";
    this.#workflowVersion = options.workflowVersion ?? "evleda.workflow.v1";
    this.#now = options.now ?? (() => new Date());
    this.#newUuid = options.newUuid ?? randomUUID;
    this.#installOperationTracking();
  }

  public async initialize(): Promise<void> {
    await this.#initializeAndReconcile();
  }

  async #initializeAndReconcile(): Promise<EvlEdaState> {
    await this.#initializeStructure();
    return this.#repairAndVerifyAudit();
  }

  /**
   * Wait until every public operation that was admitted by this service settles.
   * This is observational: callers that intend to remove backing paths must use close(),
   * which first fences admission of new work.
   */
  public async whenIdle(options: ApplicationServiceIdleOptions = {}): Promise<void> {
    const timeoutMs = applicationIdleTimeout(options.timeoutMs);
    if (options.signal?.aborted === true) {
      throw options.signal.reason ?? new DOMException("The idle wait was aborted", "AbortError");
    }
    if (this.#activeOperations.size === 0) return;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (failure?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#idleWaiters.delete(onIdle);
        options.signal?.removeEventListener("abort", onAbort);
        if (failure === undefined) resolve();
        else reject(failure);
      };
      const onIdle = (): void => finish();
      const onAbort = (): void => finish(
        options.signal?.reason ?? new DOMException("The idle wait was aborted", "AbortError")
      );
      const timer = setTimeout(
        () => finish(new ApplicationServiceIdleTimeoutError(timeoutMs)),
        timeoutMs
      );
      this.#idleWaiters.add(onIdle);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted === true) onAbort();
      else if (this.#activeOperations.size === 0) onIdle();
    });
  }

  /**
   * Permanently stop admission and wait for already-admitted work. A timeout/abort leaves
   * the service fenced so a caller can wait again; it must not delete backing paths yet.
   */
  public close(options: ApplicationServiceIdleOptions = {}): Promise<void> {
    try {
      applicationIdleTimeout(options.timeoutMs);
    } catch (error) {
      return Promise.reject(error);
    }
    this.#acceptingOperations = false;
    if (this.#closed) return Promise.resolve();
    if (this.#closePromise !== undefined) return this.#closePromise;

    const closing = this.whenIdle(options).then(() => {
      this.#closed = true;
    });
    this.#closePromise = closing;
    void closing.then(
      () => undefined,
      () => {
        if (this.#closePromise === closing) this.#closePromise = undefined;
      }
    );
    return closing;
  }

  public async dispatch<Name extends OperationName>(
    operation: Name,
    input: unknown,
    context: CommandContext = SYSTEM_CONTEXT,
    requestId?: string
  ): Promise<OperationEnvelope<OperationResult<Name>>> {
    try {
      const parsed = operationInputSchemas[operation].parse(input) as OperationInputByName[Name];
      const result = await this.#dispatchRaw(operation, parsed, context);
      return successEnvelope(operation, result, requestId) as OperationEnvelope<OperationResult<Name>>;
    } catch (error) {
      return failureEnvelope(error);
    }
  }

  public async createProject(
    input: CreateProjectInput,
    context: CommandContext = SYSTEM_CONTEXT
  ): Promise<OperationResult<"create_project">> {
    await this.#initializeAndReconcile();
    const parsed = operationInputSchemas.create_project.parse(input);
    if (parsed.policyVersion !== undefined && parsed.policyVersion !== this.#policyVersion) {
      throw new DomainError("POLICY_DENIED", "Requested policy version is not the pinned local policy", {
        requested: parsed.policyVersion,
        configured: this.#policyVersion
      });
    }
    const projectId = deterministicId("project", {
      operation: "create_project",
      request: parsed
    });
    const createdAt = this.#timestamp();
    const requestedRoot = resolveWithinRoot(
      this.#workspaceRoot,
      path.join("projects", parsed.workspace ?? projectId)
    );

    const mutation = await this.#idempotentMutation<{ readonly projectId: string }>(
      "create_project",
      parsed,
      context,
      (result) => ({
        type: "project.created",
        projectId: result.projectId,
        payload: { projectId: result.projectId, request: withoutIdempotencyKey(parsed) }
      }),
      async (state): Promise<{ readonly projectId: string }> => {
        const writeTarget = await resolveWriteTargetWithinRoot(this.#workspaceRoot, requestedRoot);
        await mkdir(writeTarget, { recursive: true });
        const root = await resolveExistingWithinRoot(this.#workspaceRoot, writeTarget);
        const projects = recordMap<Project>(state.projects);
        const rootOwner = Object.values(projects).find(
          (project) => {
            const existingRoot = path.resolve(project.root);
            const requestedRoot = path.resolve(root);
            return process.platform === "win32"
              ? existingRoot.toLocaleLowerCase("en-US") === requestedRoot.toLocaleLowerCase("en-US")
              : existingRoot === requestedRoot;
          }
        );
        if (rootOwner !== undefined && rootOwner.id !== projectId) {
          throw new DomainError(
            "IDEMPOTENCY_CONFLICT",
            "Project directory is already owned by another project",
            { workspace: parsed.workspace ?? projectId, projectId: rootOwner.id }
          );
        }
        const project: Project = {
          id: projectId,
          name: parsed.name,
          ...(parsed.description === undefined ? {} : { description: parsed.description }),
          root,
          policyVersion: this.#policyVersion,
          runIds: [],
          createdAt,
          updatedAt: createdAt,
          revision: 0
        };
        projects[projectId] = project;
        return { projectId };
      }
    );
    const project = this.#project(mutation.state, mutation.result.projectId);
    return { project, stateRevision: mutation.state.revision };
  }

  public async startDesignRun(
    input: StartDesignRunInput,
    context: CommandContext = SYSTEM_CONTEXT
  ): Promise<RunStatusResult> {
    await this.#initializeAndReconcile();
    const parsed = operationInputSchemas.start_design_run.parse(input);
    const expectedPromptIdentity = contentIdentity(parsed.prompt);
    const promptIdentity = await this.ports.content.put(parsed.prompt, expectedPromptIdentity);
    if (
      !sameContentIdentity(promptIdentity, expectedPromptIdentity) ||
      !(await this.ports.content.verify(expectedPromptIdentity))
    ) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Persisted source prompt does not match the exact submitted prompt identity",
        { expected: expectedPromptIdentity, actual: promptIdentity }
      );
    }
    const requirements = parseRequirements(parsed.prompt);
    const configuration = canonicalIdentity(
      {
        configuration: parsed.configuration,
        policyVersion: this.#policyVersion,
        workflowVersion: this.#workflowVersion
      },
      "evleda.run-configuration.v1"
    );
    const runId = deterministicId("run", {
      operation: "start_design_run",
      request: parsed,
      promptIdentity,
      configuration
    });
    const attemptId = deterministicId("attempt", { runId, stage: "requirements", attemptNumber: 1 });
    const timestamp = this.#timestamp();
    const inputManifest = canonicalIdentity(
      { prompt: promptIdentity, configuration },
      "evleda.stage-input.requirements.v1"
    );
    const blockers: readonly Blocker[] = requirements.blocking.map((assumption) => ({
      code: assumption.id.toLocaleUpperCase("en-US"),
      message: assumption.statement,
      stage: "requirements",
      affectedInputDigests: [promptIdentity.digest],
      requiredAction: "Clarify the source prompt and start a new immutable design run.",
      retryable: false,
      createdAt: timestamp
    }));

    const mutation = await this.#idempotentMutation<{ readonly runId: string }>(
      "start_design_run",
      parsed,
      context,
      (result) => ({
        type: blockers.length === 0
          ? "run.awaiting_requirements_approval"
          : "run.requirements_blocked",
        projectId: parsed.projectId,
        runId: result.runId,
        subjectDigest: requirements.document.identity.digest,
        payload: {
          runId: result.runId,
          requirementsDigest: requirements.document.identity.digest,
          blockers
        }
      }),
      async (state): Promise<{ readonly runId: string }> => {
        const projects = recordMap<Project>(state.projects);
        const runs = recordMap<DesignRun>(state.runs);
        const project = this.#projectFromMutable(projects, parsed.projectId);
        this.#assertExpectedRevision(project.revision, parsed.expectedRevision, "project");
        const requirementsAttempt: StageAttempt = {
          id: attemptId,
          stage: "requirements",
          attemptNumber: 1,
          state: blockers.length === 0 ? "waiting_approval" : "blocked",
          inputManifest,
          artifactIds: [],
          evidenceIds: [],
          blockers,
          startedAt: timestamp,
          ...(blockers.length === 0 ? {} : { completedAt: timestamp }),
          fencingEpoch: 1
        };
        const attempts = attemptsRecord();
        (attempts as Record<StageKey, readonly StageAttempt[]>).requirements = [
          requirementsAttempt
        ];
        const run: DesignRun = {
          id: runId,
          projectId: project.id,
          sourcePrompt: promptIdentity,
          workflowVersion: this.#workflowVersion,
          configuration,
          state: blockers.length === 0 ? "waiting_requirements_approval" : "blocked",
          lifecycle: "candidate",
          requirements: requirements.document,
          attempts,
          createdAt: timestamp,
          updatedAt: timestamp,
          revision: 0
        };
        runs[runId] = run;
        projects[project.id] = {
          ...project,
          runIds: [...project.runIds, runId],
          updatedAt: timestamp,
          revision: project.revision + 1
        };
        return { runId };
      }
    );
    return this.#status(mutation.state, mutation.result.runId);
  }

  public async getRunStatus(input: GetRunStatusInput): Promise<RunStatusResult> {
    const state = await this.#initializeAndReconcile();
    const parsed = operationInputSchemas.get_run_status.parse(input);
    return this.#status(state, parsed.runId);
  }

  public async inspectRequirements(
    input: InspectRequirementsInput
  ): Promise<RequirementsInspectionResult> {
    const state = await this.#initializeAndReconcile();
    const parsed = operationInputSchemas.inspect_requirements.parse(input);
    const run = this.#run(state, parsed.runId);
    const requirements = await this.#assertRequirementsIntegrity(run);
    const approvals = recordMap<ApprovalRecord>(state.approvals);
    const approval = requirements.approvalId === undefined
      ? undefined
      : approvals[requirements.approvalId];
    return {
      projectId: run.projectId,
      runId: run.id,
      requirements,
      requirementsDigest: requirements.identity.digest,
      approvable: requirementsAreApprovable(requirements),
      ...(approval === undefined ? {} : { approval })
    };
  }

  public async approveRequirements(
    input: ApproveRequirementsInput,
    context: CommandContext
  ): Promise<RunStatusResult> {
    const snapshot = await this.#initializeAndReconcile();
    const parsed = operationInputSchemas.approve_requirements.parse(input);
    this.#assertContextActor(context, "requirements_approval", parsed.actor);
    const snapshotRun = this.#run(snapshot, parsed.runId);
    const snapshotRequirements = await this.#assertRequirementsIntegrity(snapshotRun);
    assertRequirementsApproval(snapshotRequirements, parsed.actor, parsed.requirementsDigest);
    const requirementsBytes = `${canonicalJson(snapshotRequirements)}\n`;
    const requirementsBlob = await this.ports.content.put(requirementsBytes);
    const timestamp = this.#timestamp();
    const approvalId = deterministicId("approval", {
      operation: "approve_requirements",
      request: parsed
    });

    const mutation = await this.#idempotentMutation<{ readonly runId: string }>(
      "approve_requirements",
      parsed,
      context,
      () => ({
        type: "requirements.approved",
        projectId: snapshotRun.projectId,
        runId: snapshotRun.id,
        subjectDigest: parsed.requirementsDigest,
        payload: {
          requirementsDigest: parsed.requirementsDigest,
          scope: parsed.scope,
          rationale: parsed.rationale
        }
      }),
      async (state): Promise<{ readonly runId: string }> => {
        const runs = recordMap<DesignRun>(state.runs);
        const projects = recordMap<Project>(state.projects);
        const approvals = recordMap<ApprovalRecord>(state.approvals);
        const artifacts = recordMap<ArtifactRecord>(state.artifacts);
        const revisions = recordMap<DesignRevision>(state.revisions);
        const run = this.#runFromMutable(runs, parsed.runId);
        this.#assertExpectedRevision(run.revision, parsed.expectedRevision, "run");
        const document = this.#requirements(run);
        assertRequirementsApproval(document, parsed.actor, parsed.requirementsDigest);

        const existing = Object.values(approvals).find(
          (approval) =>
            approval.kind === "requirements" &&
            approval.runId === run.id &&
            approval.subjectDigest === document.identity.digest &&
            approval.revokedAt === undefined
        );
        const approval: ApprovalRecord = existing ?? {
          id: approvalId,
          kind: "requirements",
          projectId: run.projectId,
          runId: run.id,
          subjectDigest: document.identity.digest,
          policyVersion: this.#policyVersion,
          actor: parsed.actor,
          scope: parsed.scope,
          rationale: parsed.rationale,
          createdAt: timestamp
        };
        approvals[approval.id] = approval;

        const artifactId = deterministicId("artifact", {
          runId: run.id,
          stage: "requirements",
          logicalName: "requirements.json",
          blob: requirementsBlob,
          approvalId: approval.id
        });
        const revisionRecord = {
            schemaVersion: "evleda.design-revision.v1",
            projectId: run.projectId,
            runId: run.id,
            parentRevisionIds: [],
            requirements: document.identity,
            approval: {
              id: approval.id,
              subjectDigest: approval.subjectDigest,
              actor: approval.actor,
              policyVersion: approval.policyVersion
            },
            artifacts: [
              {
                id: artifactId,
                projectId: run.projectId,
                runId: run.id,
                logicalName: "requirements.json",
                mediaType: "application/json",
                blob: requirementsBlob,
                stage: "requirements",
                exactInputs: [run.sourcePrompt, document.identity],
                derivedFrom: [],
                tool: APPLICATION_TOOL,
                validationStatus: "pass",
                unresolvedAssumptions: document.unresolvedAssumptions,
                lifecycle: "candidate",
                createdAt: timestamp,
                staleAt: null
              }
            ],
            evidence: []
          } as const;
        const { manifest: revisionManifest, blob: manifestRecordBlob } =
          await this.#persistRevisionManifestRecord(revisionRecord);
        const revisionId = deterministicId("revision", {
          runId: run.id,
          ordinal: 1,
          manifest: revisionManifest.digest
        });
        const artifact: ArtifactRecord = {
          id: artifactId,
          projectId: run.projectId,
          runId: run.id,
          designRevisionId: revisionId,
          stage: "requirements",
          logicalName: "requirements.json",
          mediaType: "application/json",
          blob: requirementsBlob,
          exactInputs: [run.sourcePrompt, document.identity],
          derivedFrom: [],
          tool: APPLICATION_TOOL,
          validationStatus: "pass",
          unresolvedAssumptions: document.unresolvedAssumptions,
          lifecycle: "candidate",
          createdAt: timestamp
        };
        artifacts[artifact.id] = artifact;
        const revision: DesignRevision = {
          id: revisionId,
          projectId: run.projectId,
          runId: run.id,
          ordinal: 1,
          parentRevisionIds: [],
          manifest: revisionManifest,
          manifestRecordBlob,
          artifactIds: [artifact.id],
          evidenceIds: [],
          lifecycle: "candidate",
          createdAt: timestamp
        };
        revisions[revision.id] = revision;

        const attempts = { ...run.attempts } as Record<StageKey, readonly StageAttempt[]>;
        const requirementAttempts = [...attempts.requirements];
        const waitingIndex = requirementAttempts.findLastIndex(
          (attempt) => attempt.state === "waiting_approval"
        );
        if (waitingIndex < 0) {
          throw new DomainError(
            "GATE_FAILED",
            "The run is not waiting for requirements approval",
            { runId: run.id, state: run.state }
          );
        }
        const waiting = requirementAttempts[waitingIndex]!;
        const requirementsOutputIdentity = canonicalIdentity(
          {
            schemaVersion: "evleda.reconstructed-stage-result.v1",
            stage: "requirements",
            attemptId: waiting.id,
            inputManifest: waiting.inputManifest,
            artifacts: [{ id: artifact.id, identity: artifact.blob }],
            evidenceIds: []
          },
          "evleda.stage-result.requirements.v1"
        );
        requirementAttempts[waitingIndex] = {
          ...waiting,
          state: "succeeded",
          outputIdentity: requirementsOutputIdentity,
          artifactIds: [artifact.id],
          blockers: [],
          completedAt: timestamp
        };
        attempts.requirements = requirementAttempts;
        const approvedDocument = { ...document, approvalId: approval.id };
        runs[run.id] = {
          ...run,
          requirements: approvedDocument,
          attempts,
          headRevisionId: revision.id,
          state: "queued",
          lifecycle: "candidate",
          updatedAt: timestamp,
          revision: run.revision + 1
        };
        const project = this.#projectFromMutable(projects, run.projectId);
        projects[project.id] = {
          ...project,
          headRevisionId: revision.id,
          updatedAt: timestamp,
          revision: project.revision + 1
        };
        return { runId: run.id };
      }
    );
    return this.#status(mutation.state, mutation.result.runId);
  }

  public async resumeRun(
    input: ResumeRunInput,
    context: CommandContext = SYSTEM_CONTEXT
  ): Promise<RunStatusResult> {
    const initialState = await this.#initializeAndReconcile();
    const parsed = operationInputSchemas.resume_run.parse(input);
    const replay = this.#runExecutionReplay(initialState, "resume_run", parsed, parsed.runId);
    if (replay?.result.status === "completed") {
      return this.#status(initialState, parsed.runId);
    }
    this.#run(initialState, parsed.runId);

    return this.#withRunExecutionLease(parsed.runId, async () => {
      const lockedState = await this.#repairAndVerifyAudit();
      const lockedReplay = this.#runExecutionReplay(
        lockedState,
        "resume_run",
        parsed,
        parsed.runId
      );
      if (lockedReplay?.result.status === "completed") {
        return this.#status(lockedState, parsed.runId);
      }
      const initialRun = this.#run(lockedState, parsed.runId);
      if (lockedReplay === undefined) {
        this.#assertExpectedRevision(initialRun.revision, parsed.expectedRevision, "run");
        this.#assertRunResumable(initialRun);
        this.#assertRequirementsApproved(lockedState, initialRun);
        await this.#reserveIdempotentOperation(
          "resume_run",
          parsed,
          { status: "pending", runId: parsed.runId },
          context,
          { projectId: initialRun.projectId, runId: initialRun.id },
          (state) => {
            const current = this.#run(state, parsed.runId);
            this.#assertExpectedRevision(current.revision, parsed.expectedRevision, "run");
            this.#assertRunResumable(current);
            this.#assertRequirementsApproved(state, current);
            this.#assertNoPendingRunExecution(state, current.id);
          }
        );
      } else {
        this.#assertPendingRunExecutionReplay(lockedState, "resume_run", parsed, initialRun.id);
        this.#assertPendingResumeRecoveryState(initialRun);
        this.#assertRequirementsApproved(lockedState, initialRun);
      }
      while (true) {
        const state = await this.#repairAndVerifyAudit();
        const run = this.#run(state, parsed.runId);
        const nextStage = this.#nextStage(run);
        if (nextStage === undefined) {
          if (run.state !== "completed") {
            await this.#setRunState(run.id, run.revision, "completed", context, "run.completed");
          }
          break;
        }
        if (nextStage === "requirements") {
          throw new DomainError(
            "REQUIREMENTS_NOT_APPROVED",
            "Requirements must be approved before candidate generation can resume",
            { runId: run.id }
          );
        }
        const outcome = await this.#executeStage(run.id, nextStage, context);
        if (outcome === "blocked") {
          break;
        }
      }

      const recorded = await this.#completeReservedOperation(
        "resume_run",
        parsed,
        { status: "completed", runId: parsed.runId },
        context,
        "run.resume_finished",
        parsed.runId
      );
      return this.#status(recorded, parsed.runId);
    });
  }

  public async listArtifacts(input: ListArtifactsInput): Promise<ArtifactListResult> {
    const state = await this.#initializeAndReconcile();
    const parsed = operationInputSchemas.list_artifacts.parse(input);
    const run = this.#run(state, parsed.runId);
    const selectedRevisionId = parsed.revisionId ?? run.headRevisionId;
    const selectedRevision = selectedRevisionId === undefined
      ? undefined
      : this.#revision(state, selectedRevisionId);
    if (selectedRevision !== undefined) {
      const revision = selectedRevision;
      if (revision.runId !== run.id) {
        throw new DomainError("NOT_FOUND", "Revision is not part of the requested run", {
          runId: run.id,
          revisionId: revision.id
        });
      }
    }
    const projection = selectedRevision === undefined
      ? undefined
      : this.#resolveRevisionProjection(state, selectedRevision);
    const artifacts = [...(projection?.artifacts ?? [])]
      .filter((artifact) => parsed.stage === undefined || artifact.stage === parsed.stage)
      .filter((artifact) => parsed.includeStale || artifact.staleAt === undefined)
      .sort((left, right) => {
        const byStage = stageIndex(left.stage) - stageIndex(right.stage);
        return byStage === 0 ? left.id.localeCompare(right.id, "en") : byStage;
      });
    return {
      projectId: run.projectId,
      runId: run.id,
      revisionId: selectedRevisionId ?? null,
      artifacts
    };
  }

  public async inspectEvidence(input: InspectEvidenceInput): Promise<EvidenceInspectionResult> {
    const state = await this.#initializeAndReconcile();
    const parsed = operationInputSchemas.inspect_evidence.parse(input);
    const run = this.#run(state, parsed.runId);
    const selectedRevisionId = parsed.revisionId ?? run.headRevisionId;
    const selectedRevision = selectedRevisionId === undefined
      ? undefined
      : this.#revision(state, selectedRevisionId);
    if (selectedRevision !== undefined) {
      const revision = selectedRevision;
      if (revision.runId !== run.id) {
        throw new DomainError("NOT_FOUND", "Revision is not part of the requested run", {
          runId: run.id,
          revisionId: revision.id
        });
      }
    }
    const projection = selectedRevision === undefined
      ? undefined
      : this.#resolveRevisionProjection(state, selectedRevision);
    const evidence = [...(projection?.evidence ?? [])]
      .filter((entry) => parsed.evidenceId === undefined || entry.id === parsed.evidenceId)
      .filter((entry) => parsed.stage === undefined || entry.stage === parsed.stage)
      .filter((entry) => parsed.includeStale || entry.staleAt === undefined)
      .sort((left, right) => {
        const byStage = stageIndex(left.stage) - stageIndex(right.stage);
        return byStage === 0 ? left.id.localeCompare(right.id, "en") : byStage;
      });
    if (parsed.evidenceId !== undefined && evidence.length === 0) {
      throw new DomainError("NOT_FOUND", "Evidence record was not found", {
        evidenceId: parsed.evidenceId,
        runId: run.id
      });
    }
    const evidenceRoot = this.#evidenceRoot(evidence);
    return {
      projectId: run.projectId,
      runId: run.id,
      revisionId: selectedRevisionId ?? null,
      evidence,
      evidenceRoot
    };
  }

  public async inspectEngineeringPractices(
    input: InspectEngineeringPracticesInput
  ): Promise<EngineeringPracticeInspectionResult> {
    const state = await this.#initializeAndReconcile();
    const parsed = operationInputSchemas.inspect_engineering_practices.parse(input);
    const run = this.#run(state, parsed.runId);
    const project = this.#project(state, run.projectId);
    const requirements = run.requirements === undefined
      ? null
      : await this.#assertRequirementsIntegrity(run);
    const selectedRevisionId = parsed.revisionId ?? run.headRevisionId;
    if (selectedRevisionId === undefined) {
      if (parsed.findingCursor !== undefined) {
        throw new DomainError(
          "INVALID_ARGUMENT",
          "A finding cursor cannot be used before an engineering report exists",
          { parameter: "findingCursor", runId: run.id }
        );
      }
      const projected = buildEngineeringPracticeInspection({
        projectId: project.id,
        runId: run.id,
        revisionId: null,
        isHeadRevision: false,
        revisionManifest: null,
        requirementsIdentity: requirements?.identity ?? null,
        evidenceRootIdentity: this.#evidenceRoot([]),
        practiceCatalog: null,
        routeQualityPolicy: null,
        routeQualityPolicyIdentity: null,
        routeQualityPolicyCaptureIdentity: null,
        routeQualityRuleDeck: null,
        routeQualityRuleDeckIdentity: null,
        proofFixturePolicyIdentity: null,
        analyzerProfileIdentity: null,
        constraintBinding: null,
        authoritativeScopeFactIdentities: [],
        authoritativeCheckerResultIdentities: [],
        verifiedReferenceFabricationProfile: null,
        nativeBoard: null,
        nativeDrc: null,
        evledaPractice: null,
        findingLimit: parsed.findingLimit
      });
      return engineeringPracticeInspectionResultSchema.parse(
        projected
      ) as EngineeringPracticeInspectionResult;
    }
    const revision = this.#revision(state, selectedRevisionId);
    if (revision.runId !== run.id || revision.projectId !== project.id) {
      throw new DomainError("NOT_FOUND", "Revision is not part of the requested run", {
        runId: run.id,
        revisionId: revision.id
      });
    }
    const isHeadRevision = run.headRevisionId === revision.id;
    const revisionRecord = await this.#loadRevisionManifestRecord(revision);
    this.#assertEngineeringRevisionRecord(
      state,
      revision,
      revisionRecord,
      isHeadRevision
    );
    const projection = this.#resolveRevisionProjection(state, revision);
    const diagnosticAttempt = run.headRevisionId === revision.id
      ? activeAttempt(run.attempts.pcb_placement_routing)
      : undefined;
    const useAttachedDiagnosticAttempt =
      diagnosticAttempt !== undefined &&
      diagnosticAttempt.state !== "succeeded" &&
      diagnosticAttempt.state !== "stale" &&
      diagnosticAttempt.executionFence?.parentRevisionId === revision.id &&
      (diagnosticAttempt.artifactIds.length > 0 || diagnosticAttempt.evidenceIds.length > 0);
    const revisionArtifactIds = new Set(
      useAttachedDiagnosticAttempt ? diagnosticAttempt.artifactIds : revision.artifactIds
    );
    const revisionEvidenceIds = new Set(
      useAttachedDiagnosticAttempt ? diagnosticAttempt.evidenceIds : revision.evidenceIds
    );
    const manifestArtifacts = new Map(
      (Array.isArray(revisionRecord.artifacts) ? revisionRecord.artifacts : [])
        .filter(isRecordValue)
        .map((artifact) => [artifact.id, artifact] as const)
        .filter((entry): entry is readonly [string, Readonly<Record<string, unknown>>] =>
          typeof entry[0] === "string"
        )
    );
    const manifestEvidence = new Map(
      (Array.isArray(revisionRecord.evidence) ? revisionRecord.evidence : [])
        .filter(isRecordValue)
        .map((entry) => [entry.id, entry] as const)
        .filter((entry): entry is readonly [string, Readonly<Record<string, unknown>>] =>
          typeof entry[0] === "string"
        )
    );
    const artifacts = projection.artifacts
      .filter((artifact) => revisionArtifactIds.has(artifact.id))
      .map((artifact) =>
        !isHeadRevision && manifestArtifacts.has(artifact.id)
          ? {
              ...artifact,
              validationStatus: manifestArtifacts.get(artifact.id)!
                .validationStatus as ArtifactRecord["validationStatus"]
            }
          : artifact
      );
    const evidence = projection.evidence
      .filter((entry) => revisionEvidenceIds.has(entry.id))
      .map((entry) =>
        !isHeadRevision && manifestEvidence.has(entry.id)
          ? {
              ...entry,
              validationStatus: manifestEvidence.get(entry.id)!
                .validationStatus as EvidenceRecord["validationStatus"]
            }
          : entry
      );
    const selectedEvidenceRoot = isHeadRevision
      ? projection.evidenceRoot
      : this.#evidenceRoot(evidence);
    const nativeDrc = await this.#engineeringNativeReport(
      "drc",
      artifacts,
      evidence,
      isHeadRevision,
      run
    );
    const practice = await this.#engineeringPracticeReport(
      revision,
      run,
      artifacts,
      evidence,
      nativeDrc,
      isHeadRevision
    );
    const authoritativeCheckerResultIdentities = practice?.constraintBinding === null ||
      practice?.constraintBinding === undefined
      ? []
      : await this.#authoritativeEngineeringCheckerResultIdentities(
          projection.artifacts,
          projection.evidence,
          practice.constraintBinding.contextSnapshot.checkerResults,
          practice.nativeBoard.identity,
          isHeadRevision
        );
    const projected = buildEngineeringPracticeInspection({
      projectId: project.id,
      runId: run.id,
      revisionId: revision.id,
      isHeadRevision,
      revisionManifest: revision.manifest,
      requirementsIdentity: requirements?.identity ?? null,
      evidenceRootIdentity: selectedEvidenceRoot,
      practiceCatalog: practice?.catalog ?? null,
      routeQualityPolicy: practice?.routeQualityPolicy ?? null,
      routeQualityPolicyIdentity: practice?.routeQualityPolicyIdentity ?? null,
      routeQualityPolicyCaptureIdentity:
        practice?.routeQualityPolicyCaptureIdentity ?? null,
      routeQualityRuleDeck: practice?.routeQualityRuleDeck ?? null,
      routeQualityRuleDeckIdentity: practice?.routeQualityRuleDeckIdentity ?? null,
      proofFixturePolicyIdentity: practice?.proofFixturePolicyIdentity ?? null,
      analyzerProfileIdentity: practice === null
        ? null
        : canonicalIdentity(
            practice.analyzerProfile,
            practice.analyzerProfile.schemaVersion
          ),
      constraintBinding: practice?.constraintBinding ?? null,
      // Scope facts in the current constraint document are caller/compiler
      // snapshots without an independently approved evidence registry.
      authoritativeScopeFactIdentities: [],
      authoritativeCheckerResultIdentities,
      // The current fabricator capability evidence policy is explicitly
      // self-attested/non-gating. Identity-only constraint inputs therefore
      // cannot be promoted into a trusted frozen fabrication profile.
      verifiedReferenceFabricationProfile: null,
      nativeBoard: practice?.nativeBoard ?? null,
      nativeDrc: nativeDrc?.execution ?? null,
      evledaPractice: practice?.execution ?? null,
      ...(parsed.findingCursor === undefined
        ? {}
        : { findingCursor: parsed.findingCursor }),
      findingLimit: parsed.findingLimit
    });
    const validated = engineeringPracticeInspectionResultSchema.safeParse(projected);
    if (!validated.success) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Engineering practice projection violates its closed result contract",
        { revisionId: revision.id, issues: validated.error.issues }
      );
    }
    return validated.data as EngineeringPracticeInspectionResult;
  }

  public async rerunStage(
    input: RerunStageInput,
    context: CommandContext = SYSTEM_CONTEXT
  ): Promise<RunStatusResult> {
    const snapshot = await this.#initializeAndReconcile();
    const parsed = operationInputSchemas.rerun_stage.parse(input);
    if (parsed.stage === "requirements") {
      throw new DomainError(
        "POLICY_DENIED",
        "Requirements are immutable for a design run; start a new run for a revised prompt",
        { runId: parsed.runId }
      );
    }
    const rerunStage = parsed.stage as Exclude<StageKey, "requirements">;
    const replay = this.#runExecutionReplay(snapshot, "rerun_stage", parsed, parsed.runId);
    if (replay?.result.status === "completed") {
      return this.#status(snapshot, parsed.runId);
    }
    this.#run(snapshot, parsed.runId);

    return this.#withRunExecutionLease(parsed.runId, async () => {
      const lockedState = await this.#repairAndVerifyAudit();
      const lockedReplay = this.#runExecutionReplay(
        lockedState,
        "rerun_stage",
        parsed,
        parsed.runId
      );
      if (lockedReplay?.result.status === "completed") {
        return this.#status(lockedState, parsed.runId);
      }
      const run = this.#run(lockedState, parsed.runId);
      if (lockedReplay === undefined) {
        this.#assertExpectedRevision(run.revision, parsed.expectedRevision, "run");
        this.#assertRunRerunnable(run);
        this.#assertRequirementsApproved(lockedState, run);
        await this.#reserveIdempotentOperation(
          "rerun_stage",
          parsed,
          { status: "pending", phase: "reserved", runId: run.id, stage: rerunStage },
          context,
          {
            projectId: run.projectId,
            runId: run.id,
            ...(run.requirements === undefined ? {} : { subjectDigest: run.requirements.identity.digest })
          },
          (state) => {
            const current = this.#run(state, parsed.runId);
            this.#assertExpectedRevision(current.revision, parsed.expectedRevision, "run");
            this.#assertRunRerunnable(current);
            this.#assertRequirementsApproved(state, current);
            this.#assertNoPendingRunExecution(state, current.id);
          }
        );
      } else {
        this.#assertPendingRunExecutionReplay(lockedState, "rerun_stage", parsed, run.id);
        this.#assertPendingRerunRecoveryState(run);
        this.#assertRequirementsApproved(lockedState, run);
      }

      const replayPhase =
        lockedReplay !== undefined && "phase" in lockedReplay.result
          ? lockedReplay.result.phase
          : undefined;
      if (replayPhase !== "prepared") {
        const timestamp = this.#timestamp();
        await this.#transaction<{ readonly baseRevisionId?: string }>(
        context,
        (result) => ({
          type: "stage.rerun_prepared",
          projectId: run.projectId,
          runId: run.id,
          ...(run.requirements === undefined ? {} : { subjectDigest: run.requirements.identity.digest }),
          payload: {
            stage: parsed.stage,
            reason: parsed.reason,
            baseRevisionId: result.baseRevisionId ?? null
          }
        }),
        async (mutable) => {
        const runs = recordMap<DesignRun>(mutable.runs);
        const projects = recordMap<Project>(mutable.projects);
        const artifacts = recordMap<ArtifactRecord>(mutable.artifacts);
        const evidence = recordMap<EvidenceRecord>(mutable.evidence);
        const current = this.#runFromMutable(runs, run.id);
        this.#assertExpectedRevision(current.revision, parsed.expectedRevision, "run");
        const idempotency = recordMap<IdempotencyRecord>(mutable.idempotency);
        const command = this.#findIdempotencyRecord(
          idempotency,
          "rerun_stage",
          parsed,
          this.#requestDigest("rerun_stage", parsed)
        );
        if (command === undefined) {
          throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Rerun reservation is missing");
        }
        const attempts = { ...current.attempts } as Record<StageKey, readonly StageAttempt[]>;
        const staleStages = [rerunStage, ...downstreamStages(rerunStage)];
        const staleArtifactIds = new Set<string>();
        const staleEvidenceIds = new Set<string>();
        for (const stage of staleStages) {
          attempts[stage] = attempts[stage].map((attempt) => {
            if (attempt.state === "stale") {
              return attempt;
            }
            for (const id of attempt.artifactIds) staleArtifactIds.add(id);
            for (const id of attempt.evidenceIds) staleEvidenceIds.add(id);
            return { ...attempt, state: "stale" as const };
          });
        }
        for (const id of staleArtifactIds) {
          const artifact = artifacts[id];
          if (artifact !== undefined && artifact.staleAt === undefined) {
            artifacts[id] = { ...artifact, validationStatus: "stale", staleAt: timestamp };
          }
        }
        for (const id of staleEvidenceIds) {
          const entry = evidence[id];
          if (entry !== undefined && entry.staleAt === undefined) {
            evidence[id] = { ...entry, validationStatus: "stale", staleAt: timestamp };
          }
        }

        const baseRevisionId = this.#baseRevisionForStage(mutable as unknown as EvlEdaState, current, rerunStage);
        const nextRun: DesignRun = {
          ...current,
          attempts,
          state: "queued",
          lifecycle: "candidate",
          updatedAt: timestamp,
          revision: current.revision + 1,
          ...(baseRevisionId === undefined ? {} : { headRevisionId: baseRevisionId })
        };
        if (baseRevisionId === undefined) {
          delete (nextRun as { headRevisionId?: string }).headRevisionId;
        }
        runs[current.id] = nextRun;
        const project = this.#projectFromMutable(projects, current.projectId);
        const nextProject: Project = {
          ...project,
          updatedAt: timestamp,
          revision: project.revision + 1,
          ...(baseRevisionId === undefined ? {} : { headRevisionId: baseRevisionId })
        };
        if (baseRevisionId === undefined) {
          delete (nextProject as { headRevisionId?: string }).headRevisionId;
        }
        projects[project.id] = nextProject;
        idempotency[command.storageKey] = {
          ...command.record,
          result: {
            status: "pending",
            phase: "prepared",
            runId: run.id,
            stage: rerunStage,
            baseRevisionId: baseRevisionId ?? null
          }
        };
          return baseRevisionId === undefined ? {} : { baseRevisionId };
        }
      );
      }

      const current = this.#run(await this.#repairAndVerifyAudit(), run.id);
      const attempt = activeAttempt(current.attempts[rerunStage]);
      if (attempt?.state !== "succeeded" && attempt?.state !== "blocked") {
        await this.#executeStage(run.id, rerunStage, context);
      }
      let finalState = await this.#repairAndVerifyAudit();
      const finalRun = this.#run(finalState, run.id);
      if (finalRun.state === "running") {
        finalState = await this.#setRunState(
          run.id,
          finalRun.revision,
          rerunStage === STAGE_ORDER.at(-1) ? "completed" : "queued",
          context,
          "stage.rerun_finished"
        );
      }
      finalState = await this.#completeReservedOperation(
        "rerun_stage",
        parsed,
        { status: "completed", runId: run.id, stage: parsed.stage },
        context,
        "stage.rerun_recorded",
        run.id
      );
      return this.#status(finalState, run.id);
    });
  }

  public async exportCandidateBundle(
    input: ExportCandidateBundleInput,
    context: CommandContext = SYSTEM_CONTEXT
  ): Promise<BundleExportResult> {
    const state = await this.#initializeAndReconcile();
    const parsed = operationInputSchemas.export_candidate_bundle.parse(input);
    const replay = this.#idempotencyResult(state, "export_candidate_bundle", parsed);
    if (replay !== undefined) {
      await this.#repairAndVerifyAudit();
      return this.#restoreBundleExportReplay("export_candidate_bundle", parsed, replay);
    }
    const revision = this.#revision(state, parsed.revisionId);
    const run = this.#run(state, revision.runId);
    this.#assertExpectedRevision(run.revision, parsed.expectedRevision, "run");
    const projection = await this.#assertRevisionExportable(state, revision);
    const result = await this.#buildBundle(
      state,
      revision,
      projection,
      CANDIDATE_BUNDLE_WARNING,
      "candidate"
    );
    return this.#recordExportMutation(
      "export_candidate_bundle",
      parsed,
      run,
      result,
      context,
      "bundle.candidate_exported"
    );
  }

  public async submitExternalEvidence(
    input: SubmitExternalEvidenceInput,
    context: CommandContext
  ): Promise<ExternalEvidenceResult> {
    const snapshot = await this.#initializeAndReconcile();
    const parsedAny = submitExternalEvidenceInputSchema.parse(input);
    this.#assertContextActor(context, "hardware_qualification", parsedAny.actor);
    type StoredExternalEvidenceResult = {
      readonly rawArtifactId: string;
      readonly parsedArtifactId: string;
      readonly evidenceId: string;
      readonly evidenceRootBefore: CanonicalIdentity;
      readonly evidenceRoot: CanonicalIdentity;
      readonly categoryVerdicts: PhysicalCategoryVerdicts;
      readonly overallVerdict: "pass" | "fail";
      readonly stateRevision: number;
    };
    const replay = this.#idempotencyResult(
      snapshot,
      "submit_external_evidence",
      parsedAny
    ) as StoredExternalEvidenceResult | undefined;
    if (replay !== undefined) {
      const rawArtifact = snapshot.artifacts[replay.rawArtifactId];
      const parsedArtifact = snapshot.artifacts[replay.parsedArtifactId];
      const evidence = snapshot.evidence[replay.evidenceId];
      if (rawArtifact === undefined || parsedArtifact === undefined || evidence === undefined) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Idempotent external evidence result is missing durable records"
        );
      }
      await Promise.all([
        this.ports.content.get(rawArtifact.blob),
        this.ports.content.get(parsedArtifact.blob)
      ]);
      return {
        rawArtifact,
        parsedArtifact,
        evidence,
        evidenceRootBefore: replay.evidenceRootBefore,
        evidenceRoot: replay.evidenceRoot,
        categoryVerdicts: replay.categoryVerdicts,
        overallVerdict: replay.overallVerdict,
        stateRevision: replay.stateRevision
      };
    }
    const parsedCurrent = submitExternalEvidenceCurrentInputSchema.safeParse(parsedAny);
    if (!parsedCurrent.success) {
      throw new DomainError(
        "GATE_FAILED",
        "Legacy physical evidence can be replayed and audited but cannot create new qualification-eligible evidence",
        { requiredSchemaVersion: "evleda.human-physical-evidence.v3" }
      );
    }
    const parsed = parsedCurrent.data;
    const revision = this.#revision(snapshot, parsed.revisionId);
    const run = this.#run(snapshot, revision.runId);
    this.#assertExpectedRevision(run.revision, parsed.expectedRevision, "run");
    if (run.headRevisionId !== revision.id) {
      throw new DomainError("REVISION_CONFLICT", "Physical evidence must bind the current run head");
    }
    const snapshotProjection = await this.#assertRevisionExportable(snapshot, revision, {
      gatePostRevisionEvidence: false
    });
    if (parsed.revisionManifestDigest !== revision.manifest.digest) {
      throw new DomainError("REVISION_CONFLICT", "Physical evidence revision manifest is stale", {
        expected: revision.manifest.digest,
        actual: parsed.revisionManifestDigest
      });
    }
    const evidenceRootBefore = snapshotProjection.evidenceRoot;
    if (parsed.evidenceRootDigest !== evidenceRootBefore.digest) {
      throw new DomainError("REVISION_CONFLICT", "Physical evidence root input is stale", {
        expected: evidenceRootBefore.digest,
        actual: parsed.evidenceRootDigest
      });
    }
    const recordedAt = this.#now();
    const resolvedPhysical = await this.#assertPhysicalArtifactBindings(
      snapshot,
      revision,
      parsed.artifactBindings
    );

    const sourceBytes = new Map<string, Buffer>();
    for (const source of parsed.sourceBlobs) {
      const bytes = Buffer.from(source.bytesBase64, "base64");
      const actual = contentIdentity(bytes);
      if (!sameContentIdentity(actual, source.identity)) {
        throw new DomainError("DIGEST_MISMATCH", "Physical source bytes do not match their declared identity", {
          sourceId: source.id,
          expected: source.identity,
          actual
        });
      }
      sourceBytes.set(source.id, bytes);
    }
    const parseSourceJson = <Value>(
      sourceId: string,
      schema: { safeParse(value: unknown): { success: true; data: Value } | { success: false } },
      label: string
    ): Value => {
      const bytes = sourceBytes.get(sourceId);
      if (bytes === undefined) {
        throw new DomainError("EVIDENCE_MISSING", `${label} source bytes are missing`, { sourceId });
      }
      let value: unknown;
      try {
        value = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw new DomainError("INVALID_ARGUMENT", `${label} source is not valid JSON`, { sourceId });
      }
      const result = schema.safeParse(value);
      if (!result.success) {
        throw new DomainError("INVALID_ARGUMENT", `${label} source does not match its strict versioned schema`, { sourceId });
      }
      return result.data;
    };
    const asBuiltRecord = parseSourceJson(
      parsed.asBuiltRecordSourceId,
      physicalAsBuiltRecordSchema,
      "As-built record"
    );
    const firmwareFlashRecord = parseSourceJson(
      parsed.firmwareFlashRecordSourceId,
      physicalFirmwareFlashRecordSchema,
      "Firmware flash record"
    );
    const measurementRecord = parseSourceJson(
      parsed.measurementRecordSourceId,
      physicalMeasurementRecordSchema,
      "Physical measurement record"
    );
    const instruments = parsed.instruments.map((instrument) => ({
      ...instrument,
      calibration: parseSourceJson(
        instrument.calibrationSourceId,
        physicalInstrumentCalibrationRecordSchema,
        `Calibration record for ${instrument.id}`
      )
    }));
    const evaluation = evaluatePhysicalEvidence({
      revision,
      bindings: parsed.artifactBindings,
      targetBuild: resolvedPhysical.targetBuild,
      plan: resolvedPhysical.plan,
      sources: parsed.sourceBlobs,
      primarySourceIds: {
        asBuiltRecord: parsed.asBuiltRecordSourceId,
        flashedFirmwareBinary: parsed.flashedFirmwareBinarySourceId,
        firmwareFlashRecord: parsed.firmwareFlashRecordSourceId,
        measurementRecord: parsed.measurementRecordSourceId
      },
      acceptanceContract: resolvedPhysical.acceptanceContract,
      asBuiltRecord,
      firmwareFlashRecord,
      measurementRecord,
      instruments,
      now: recordedAt
    });
    const sourceMetadata = parsed.sourceBlobs.map(({ bytesBase64: _bytesBase64, ...source }) => ({
      ...source,
      archivePath: this.#physicalArchivePath(source.identity),
      policyValidUntil: evaluation.validUntil
    }));
    const rawArchiveManifest = {
      schemaVersion: "evleda.physical-source-archive.v1",
      sourceBlobs: sourceMetadata
    };
    const rawArchiveFiles = new Map<string, Uint8Array>([
      ["manifest.json", Buffer.from(`${canonicalJson(rawArchiveManifest)}\n`, "utf8")],
      ...sourceMetadata.map((source) => [
        source.archivePath,
        sourceBytes.get(source.id)!
      ] as const)
    ]);
    const rawBytes = this.#deterministicZip(rawArchiveFiles);
    const results = evaluation.results;
    const evidencePayload = humanPhysicalEvidenceRecordSchema.parse({
      schemaVersion: "evleda.human-physical-evidence.v3",
      policy: PHYSICAL_EVIDENCE_POLICY,
      projectId: revision.projectId,
      runId: run.id,
      designRevisionId: revision.id,
      runStateRevision: parsed.expectedRevision,
      revisionManifest: revision.manifest,
      evidenceRootBefore,
      boardSerial: asBuiltRecord.boardSerial,
      artifactBindings: parsed.artifactBindings,
      sourceBlobs: sourceMetadata,
      primarySourceIds: {
        asBuiltRecord: parsed.asBuiltRecordSourceId,
        flashedFirmwareBinary: parsed.flashedFirmwareBinarySourceId,
        firmwareFlashRecord: parsed.firmwareFlashRecordSourceId,
        measurementRecord: parsed.measurementRecordSourceId
      },
      bringupPlan: resolvedPhysical.plan,
      asBuiltRecord,
      firmwareFlashRecord,
      measurementRecord,
      acceptanceContract: resolvedPhysical.acceptanceContract,
      instruments,
      rationale: parsed.rationale,
      actor: parsed.actor,
      results,
      recordedAt: recordedAt.toISOString(),
      validUntil: evaluation.validUntil
    });
    const parsedBytes = Buffer.from(`${canonicalJson(evidencePayload)}\n`, "utf8");
    // All objects are immutable CAS candidates and none becomes authoritative until the
    // later state transaction. Persist them concurrently while retaining input ordering.
    const persistedObjects = await Promise.allSettled([
      ...parsed.sourceBlobs.map((source) =>
        Promise.resolve().then(() =>
          this.ports.content.put(sourceBytes.get(source.id)!, source.identity)
        )
      ),
      Promise.resolve().then(() => this.ports.content.put(rawBytes)),
      Promise.resolve().then(() => this.ports.content.put(parsedBytes))
    ]);
    const persistenceFailure = persistedObjects.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    if (persistenceFailure !== undefined) throw persistenceFailure.reason;
    const storedObjects = persistedObjects.map((result) => {
      if (result.status !== "fulfilled") throw result.reason;
      return result.value;
    });
    const storedSources = storedObjects.slice(0, parsed.sourceBlobs.length);
    const rawBlob = storedObjects[parsed.sourceBlobs.length]!;
    const parsedBlob = storedObjects[parsed.sourceBlobs.length + 1]!;
    storedSources.forEach((stored, index) => {
      const source = parsed.sourceBlobs[index]!;
      if (!sameContentIdentity(stored, source.identity)) {
        throw new DomainError("DIGEST_MISMATCH", "Stored physical source identity changed", {
          sourceId: source.id,
          expected: source.identity,
          actual: stored
        });
      }
    });
    const rawArtifactId = deterministicId("artifact", {
      operation: "submit_external_evidence",
      role: "raw_sources",
      request: parsed,
      blob: rawBlob
    });
    const parsedArtifactId = deterministicId("artifact", {
      operation: "submit_external_evidence",
      role: "parsed_record",
      request: parsed,
      blob: parsedBlob
    });
    const evidenceId = deterministicId("evidence", {
      operation: "submit_external_evidence",
      request: parsed,
      rawBlob,
      parsedBlob
    });
    const exactInputs = this.#uniqueIdentities([
      revision.manifest,
      evidenceRootBefore,
      ...this.#physicalBindingList(parsed.artifactBindings).map((binding) => binding.identity),
      ...sourceMetadata.map((source) => source.identity)
    ]);
    const derivedFrom = uniqueSorted(
      this.#physicalBindingList(parsed.artifactBindings).map((binding) => binding.artifactId)
    );
    const tool: ToolIdentity = {
      name: "human-physical-evidence",
      version: "3",
      adapter: "human",
      capabilityProfile: "procedure-case-bound-derived-physical-evidence-v3"
    };
    const mutation = await this.#idempotentMutation<StoredExternalEvidenceResult>(
      "submit_external_evidence",
      parsed,
      context,
      (result) => ({
          type: "evidence.external_submitted",
          projectId: revision.projectId,
          runId: run.id,
          subjectDigest: revision.manifest.digest,
          payload: {
            rawArtifactId: result.rawArtifactId,
            parsedArtifactId: result.parsedArtifactId,
            evidenceId: result.evidenceId,
            evidenceRootBefore: result.evidenceRootBefore,
            evidenceRoot: result.evidenceRoot,
            categoryVerdicts: result.categoryVerdicts,
            overallVerdict: result.overallVerdict
          }
        }),
      async (mutable) => {
        const runs = recordMap<DesignRun>(mutable.runs);
        const artifacts = recordMap<ArtifactRecord>(mutable.artifacts);
        const evidence = recordMap<EvidenceRecord>(mutable.evidence);
        const currentState = mutable as unknown as EvlEdaState;
        const currentRevision = this.#revision(currentState, revision.id);
        const currentRun = this.#runFromMutable(runs, run.id);
        this.#assertExpectedRevision(currentRun.revision, parsed.expectedRevision, "run");
        if (currentRun.headRevisionId !== revision.id) {
          throw new DomainError("REVISION_CONFLICT", "Design head changed before evidence commit");
        }
        const currentProjection = await this.#assertRevisionExportable(currentState, currentRevision, {
          gatePostRevisionEvidence: false
        });
        if (currentRevision.manifest.digest !== parsed.revisionManifestDigest) {
          throw new DomainError("REVISION_CONFLICT", "Design manifest changed before evidence commit");
        }
        const currentEvidenceRoot = currentProjection.evidenceRoot;
        if (currentEvidenceRoot.digest !== parsed.evidenceRootDigest) {
          throw new DomainError("REVISION_CONFLICT", "Evidence root changed before evidence commit", {
            expected: parsed.evidenceRootDigest,
            actual: currentEvidenceRoot.digest
          });
        }
        const commitNow = this.#now();
        const currentResolvedPhysical = await this.#assertPhysicalArtifactBindings(
          currentState,
          currentRevision,
          parsed.artifactBindings
        );
        const commitEvaluation = evaluatePhysicalEvidence({
          revision: currentRevision,
          bindings: parsed.artifactBindings,
          targetBuild: currentResolvedPhysical.targetBuild,
          plan: currentResolvedPhysical.plan,
          sources: parsed.sourceBlobs,
          primarySourceIds: {
            asBuiltRecord: parsed.asBuiltRecordSourceId,
            flashedFirmwareBinary: parsed.flashedFirmwareBinarySourceId,
            firmwareFlashRecord: parsed.firmwareFlashRecordSourceId,
            measurementRecord: parsed.measurementRecordSourceId
          },
          acceptanceContract: currentResolvedPhysical.acceptanceContract,
          asBuiltRecord,
          firmwareFlashRecord,
          measurementRecord,
          instruments,
          now: commitNow
        });
        if (
          commitEvaluation.validUntil !== evaluation.validUntil ||
          canonicalJson(commitEvaluation.results) !== canonicalJson(results)
        ) {
          throw new DomainError("EVIDENCE_STALE", "Physical evidence policy result changed before commit");
        }
        const verificationSettlements = await Promise.allSettled([
          ...sourceMetadata.map((source) => Promise.resolve().then(() =>
            this.ports.content.verify(source.identity)
          )),
          Promise.resolve().then(() => this.ports.content.verify(rawBlob)),
          Promise.resolve().then(() => this.ports.content.verify(parsedBlob))
        ]);
        const verificationFailure = verificationSettlements.find(
          (result): result is PromiseRejectedResult => result.status === "rejected"
        );
        if (verificationFailure !== undefined) throw verificationFailure.reason;
        const verifiedObjects = verificationSettlements.map((result) => {
          if (result.status !== "fulfilled") throw result.reason;
          return result.value;
        });
        if (verifiedObjects.some((verified) => verified !== true)) {
          throw new DomainError(
            "ARTIFACT_INTEGRITY_ERROR",
            "Physical evidence content verification did not affirm every committed object"
          );
        }
        const timestamp = recordedAt.toISOString();
        const rawArtifact: ArtifactRecord = {
          id: rawArtifactId,
          projectId: revision.projectId,
          runId: run.id,
          designRevisionId: revision.id,
          stage: "bringup_package",
          logicalName: `physical-evidence/${safeArchiveName(asBuiltRecord.boardSerial)}-${evidenceId}-sources.zip`,
          mediaType: "application/zip",
          blob: rawBlob,
          exactInputs,
          derivedFrom,
          tool,
          validationStatus: results.overallVerdict,
          unresolvedAssumptions: [],
          lifecycle: "candidate",
          createdAt: timestamp
        };
        const parsedArtifact: ArtifactRecord = {
          id: parsedArtifactId,
          projectId: revision.projectId,
          runId: run.id,
          designRevisionId: revision.id,
          stage: "bringup_package",
          logicalName: `physical-evidence/${safeArchiveName(asBuiltRecord.boardSerial)}-${evidenceId}-record.json`,
          mediaType: "application/json",
          blob: parsedBlob,
          exactInputs,
          derivedFrom,
          tool,
          validationStatus: results.overallVerdict,
          unresolvedAssumptions: [],
          lifecycle: "candidate",
          createdAt: timestamp
        };
        const entry: EvidenceRecord = {
          id: evidenceId,
          projectId: revision.projectId,
          runId: run.id,
          designRevisionId: revision.id,
          stage: "bringup_package",
          evidenceClass: "human_physical",
          claim:
            `Candidate-only physical observation record for board serial ${asBuiltRecord.boardSerial}; ` +
            `the deterministic overall verdict is ${results.overallVerdict}. ` +
            "This human-supplied record does not itself authorize manufacturing release.",
          subjectDigests: uniqueSorted([
            revision.manifest.digest,
            currentEvidenceRoot.digest,
            ...this.#physicalBindingList(parsed.artifactBindings).map((binding) => binding.identity.digest),
            ...sourceMetadata.map((source) => source.identity.digest),
            rawBlob.digest,
            parsedBlob.digest
          ]),
          rawArtifactId: rawArtifact.id,
          parsedArtifactId: parsedArtifact.id,
          exactInputs,
          tool,
          validationStatus: results.overallVerdict,
          unresolvedAssumptions: [],
          lifecycle: "candidate",
          createdAt: timestamp,
          validUntil: evaluation.validUntil
        };
        artifacts[rawArtifact.id] = rawArtifact;
        artifacts[parsedArtifact.id] = parsedArtifact;
        evidence[entry.id] = entry;
        runs[run.id] = {
          ...currentRun,
          updatedAt: timestamp,
          revision: currentRun.revision + 1
        };
        const evidenceRoot = this.#resolveRevisionProjection(
          currentState,
          currentRevision
        ).evidenceRoot;
        return {
          rawArtifactId,
          parsedArtifactId,
          evidenceId,
          evidenceRootBefore: currentEvidenceRoot,
          evidenceRoot,
          categoryVerdicts: results.categories,
          overallVerdict: results.overallVerdict,
          stateRevision: mutable.revision + 1
        };
      }
    );
    const rawArtifact = mutation.state.artifacts[mutation.result.rawArtifactId];
    const parsedArtifact = mutation.state.artifacts[mutation.result.parsedArtifactId];
    const evidence = mutation.state.evidence[mutation.result.evidenceId];
    if (rawArtifact === undefined || parsedArtifact === undefined || evidence === undefined) {
      throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "External evidence records are missing");
    }
    return {
      rawArtifact,
      parsedArtifact,
      evidence,
      evidenceRootBefore: mutation.result.evidenceRootBefore,
      evidenceRoot: mutation.result.evidenceRoot,
      categoryVerdicts: mutation.result.categoryVerdicts,
      overallVerdict: mutation.result.overallVerdict,
      stateRevision: mutation.result.stateRevision
    };
  }

  public async qualifyRevision(
    input: QualifyRevisionInput,
    context: CommandContext
  ): Promise<QualificationResult> {
    await this.#initializeAndReconcile();
    const parsed = qualifyRevisionInputSchema.parse(input);
    this.#assertContextActor(context, "hardware_qualification", parsed.actor);
    const approvalId = deterministicId("approval", { operation: "qualify_revision", request: parsed });
    const mutation = await this.#idempotentMutation<{
      readonly approvalId: string;
      readonly evidenceRoot: CanonicalIdentity;
      readonly projectId: string;
      readonly runId: string;
      readonly revisionId: string;
      readonly subjectDigest: string;
    }>(
      "qualify_revision",
      parsed,
      context,
      (result) => ({
        type: "revision.qualified",
        projectId: result.projectId,
        runId: result.runId,
        subjectDigest: result.subjectDigest,
        payload: {
          revisionId: result.revisionId,
          approvalId: result.approvalId,
          evidenceRoot: result.evidenceRoot
        }
      }),
      async (mutable) => {
        const state = mutable as unknown as EvlEdaState;
        const runs = recordMap<DesignRun>(mutable.runs);
        const approvals = recordMap<ApprovalRecord>(mutable.approvals);
        const revision = this.#revision(state, parsed.revisionId);
        const currentRun = this.#runFromMutable(runs, revision.runId);
        this.#assertExpectedRevision(currentRun.revision, parsed.expectedRevision, "run");
        if (currentRun.headRevisionId !== revision.id) {
          throw new DomainError("REVISION_CONFLICT", "Only the current run head may be qualified", {
            requestedRevisionId: revision.id,
            headRevisionId: currentRun.headRevisionId
          });
        }
        const now = this.#now();
        this.#assertRequirementsApproved(state, currentRun, now);
        if (parsed.requirementsDigest !== this.#requirements(currentRun).identity.digest) {
          throw new DomainError("REVISION_CONFLICT", "Qualification requirements digest is stale");
        }
        const projection = await this.#assertRevisionExportable(state, revision);
        const evidence = projection.evidence;
        const evidenceRoot = projection.evidenceRoot;
        if (parsed.evidenceRootDigest !== evidenceRoot.digest) {
          throw new DomainError("REVISION_CONFLICT", "Qualification evidence root is stale", {
            expected: evidenceRoot.digest,
            actual: parsed.evidenceRootDigest
          });
        }
        const physical = await this.#passingPhysicalEvidence(state, revision, evidence, now);
        if (physical === undefined) {
          throw new DomainError(
            "EXTERNAL_ACCEPTANCE_REQUIRED",
            "Qualification requires a current passing v2 physical observation record for the exact head revision and evidence root"
          );
        }
        this.#assertCurrentEvidence(evidence, now);
        const timestamp = now.toISOString();
        const approval: ApprovalRecord = {
          id: approvalId,
          kind: "qualification",
          projectId: revision.projectId,
          runId: currentRun.id,
          designRevisionId: revision.id,
          subjectDigest: revision.manifest.digest,
          evidenceRootDigest: evidenceRoot.digest,
          policyVersion: this.#policyVersion,
          actor: parsed.actor,
          scope: parsed.scope,
          rationale: parsed.rationale,
          createdAt: timestamp
        };
        approvals[approval.id] = approval;
        runs[currentRun.id] = {
          ...currentRun,
          updatedAt: timestamp,
          revision: currentRun.revision + 1
        };
        return {
          approvalId,
          evidenceRoot,
          projectId: revision.projectId,
          runId: currentRun.id,
          revisionId: revision.id,
          subjectDigest: revision.manifest.digest
        };
      }
    );
    const approval = mutation.state.approvals[mutation.result.approvalId];
    if (approval === undefined) {
      throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Qualification approval was not persisted");
    }
    return {
      approval,
      projectId: approval.projectId,
      runId: approval.runId!,
      designRevisionId: approval.designRevisionId!,
      stateRevision: mutation.state.revision
    };
  }

  public async exportPrototypeBundle(
    input: ExportPrototypeBundleInput,
    context: CommandContext = SYSTEM_CONTEXT
  ): Promise<BundleExportResult> {
    const state = await this.#initializeAndReconcile();
    const parsed = operationInputSchemas.export_prototype_bundle.parse(input);
    const replay = this.#idempotencyResult(state, "export_prototype_bundle", parsed);
    if (replay !== undefined) {
      await this.#repairAndVerifyAudit();
      return this.#restoreBundleExportReplay("export_prototype_bundle", parsed, replay);
    }
    const revision = this.#revision(state, parsed.revisionId);
    const run = this.#run(state, revision.runId);
    this.#assertExpectedRevision(run.revision, parsed.expectedRevision, "run");
    const approvals = Object.values(recordMap<ApprovalRecord>(state.approvals));
    const now = this.#now();
    this.#assertRequirementsApproved(state, run, now);
    const projection = await this.#assertRevisionExportable(state, revision);
    const evidence = projection.evidence;
    const evidenceRoot = projection.evidenceRoot;
    const physical = await this.#passingPhysicalEvidence(state, revision, evidence, now);
    if (physical === undefined) {
      throw new DomainError(
        "EXTERNAL_ACCEPTANCE_REQUIRED",
        "Prototype export requires a current deeply verified v2 physical observation record for the exact revision and evidence root"
      );
    }
    assertPrototypeExportAllowed(
      revision,
      approvals,
      evidence,
      this.#policyVersion,
      now,
      [physical.id]
    );
    const lifecycle = deriveLifecycleDecision(
      revision,
      approvals,
      evidence,
      this.#policyVersion,
      now,
      [physical.id]
    );
    const qualification = approvals.find((approval) =>
      lifecycle.activeQualificationIds.includes(approval.id)
    );
    if (qualification === undefined) {
      throw new DomainError(
        "POLICY_DENIED",
        "Prototype export requires an existing human qualification bound to the exact revision and evidence root",
        { revisionId: revision.id, evidenceRootDigest: evidenceRoot.digest }
      );
    }
    const result = await this.#buildBundle(
      state,
      revision,
      projection,
      PROTOTYPE_BUNDLE_WARNING,
      "qualified"
    );
    return this.#recordExportMutation(
      "export_prototype_bundle",
      parsed,
      run,
      result,
      context,
      "bundle.prototype_exported"
    );
  }

  public async authorizeManufacturingRelease(
    input: AuthorizeManufacturingReleaseInput,
    context: CommandContext
  ): Promise<AttestationResult> {
    await this.#initializeAndReconcile();
    const parsed = authorizeManufacturingReleaseInputSchema.parse(input);
    this.#assertContextActor(context, "manufacturing_release", parsed.actor);
    const approvalId = deterministicId("approval", {
      operation: "authorize_manufacturing_release",
      request: parsed
    });
    const mutation = await this.#idempotentMutation<{
      readonly approvalId: string;
      readonly qualificationApprovalId: string;
      readonly evidenceRoot: CanonicalIdentity;
      readonly physicalEvidenceId: string;
      readonly projectId: string;
      readonly runId: string;
      readonly revisionId: string;
      readonly subjectDigest: string;
    }>(
      "authorize_manufacturing_release",
      parsed,
      context,
      (result) => ({
        type: "revision.manufacturing_release_authorized",
        projectId: result.projectId,
        runId: result.runId,
        subjectDigest: result.subjectDigest,
        payload: {
          approvalId: result.approvalId,
          qualificationApprovalId: result.qualificationApprovalId,
          physicalEvidenceId: result.physicalEvidenceId,
          evidenceRoot: result.evidenceRoot
        }
      }),
      async (mutable) => {
        const state = mutable as unknown as EvlEdaState;
        const runs = recordMap<DesignRun>(mutable.runs);
        const mutableApprovals = recordMap<ApprovalRecord>(mutable.approvals);
        const revision = this.#revision(state, parsed.revisionId);
        const currentRun = this.#runFromMutable(runs, revision.runId);
        this.#assertExpectedRevision(currentRun.revision, parsed.expectedRevision, "run");
        if (currentRun.headRevisionId !== revision.id) {
          throw new DomainError("REVISION_CONFLICT", "Design head changed before release");
        }
        const now = this.#now();
        this.#assertRequirementsApproved(state, currentRun, now);
        const projection = await this.#assertRevisionExportable(state, revision);
        if (parsed.subjectDigest !== revision.manifest.digest) {
          throw new DomainError("REVISION_CONFLICT", "Release subject digest is stale");
        }
        const evidence = projection.evidence;
        const evidenceRoot = projection.evidenceRoot;
        if (parsed.evidenceRootDigest !== evidenceRoot.digest) {
          throw new DomainError("REVISION_CONFLICT", "Release evidence root is stale", {
            expected: evidenceRoot.digest,
            actual: parsed.evidenceRootDigest
          });
        }
        const physical = await this.#passingPhysicalEvidence(state, revision, evidence, now);
        if (physical === undefined) {
          throw new DomainError(
            "EXTERNAL_ACCEPTANCE_REQUIRED",
            "Manufacturing release requires passing exact fabricated-board physical evidence"
          );
        }
        this.#assertCurrentEvidence(evidence, now);
        const lifecycle = deriveLifecycleDecision(
          revision,
          Object.values(mutableApprovals),
          evidence,
          this.#policyVersion,
          now,
          [physical.id]
        );
        const qualification = mutableApprovals[parsed.qualificationApprovalId];
        if (
          qualification === undefined ||
          !lifecycle.activeQualificationIds.includes(qualification.id)
        ) {
          throw new DomainError(
            "POLICY_DENIED",
            "Manufacturing release requires the selected current exact human qualification",
            { qualificationApprovalId: parsed.qualificationApprovalId }
          );
        }
        const timestamp = now.toISOString();
        const approval: ApprovalRecord = {
          id: approvalId,
          kind: "manufacturing_release",
          projectId: revision.projectId,
          runId: currentRun.id,
          designRevisionId: revision.id,
          subjectDigest: revision.manifest.digest,
          evidenceRootDigest: evidenceRoot.digest,
          qualificationApprovalId: qualification.id,
          policyVersion: this.#policyVersion,
          actor: parsed.actor,
          scope: parsed.scope,
          rationale: parsed.rationale,
          createdAt: timestamp
        };
        mutableApprovals[approval.id] = approval;
        const released = deriveLifecycleDecision(
          revision,
          Object.values(mutableApprovals),
          evidence,
          this.#policyVersion,
          now,
          [physical.id]
        );
        if (
          released.state !== "release_authorized" ||
          !released.activeReleaseIds.includes(approval.id)
        ) {
          throw new DomainError(
            "POLICY_DENIED",
            "Manufacturing release prerequisites changed before commit"
          );
        }
        runs[currentRun.id] = {
          ...currentRun,
          updatedAt: timestamp,
          revision: currentRun.revision + 1
        };
        return {
          approvalId,
          qualificationApprovalId: qualification.id,
          evidenceRoot,
          physicalEvidenceId: physical.id,
          projectId: revision.projectId,
          runId: currentRun.id,
          revisionId: revision.id,
          subjectDigest: revision.manifest.digest
        };
      }
    );
    const approval = mutation.state.approvals[mutation.result.approvalId];
    if (approval === undefined) {
      throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Release attestation was not persisted");
    }
    if (approval.runId === undefined) {
      throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Release attestation has no run binding");
    }
    const effectiveLifecycle = (await this.#status(mutation.state, approval.runId)).effectiveLifecycle;
    return { approval, effectiveLifecycle, stateRevision: mutation.state.revision };
  }

  public async revokeAttestation(
    input: RevokeAttestationInput,
    context: CommandContext
  ): Promise<AttestationResult> {
    const snapshot = await this.#initializeAndReconcile();
    const parsed = revokeAttestationInputSchema.parse(input);
    const original = snapshot.approvals[parsed.approvalId];
    if (original === undefined) {
      throw new DomainError("NOT_FOUND", "Attestation was not found", {
        approvalId: parsed.approvalId
      });
    }
    const capability = original.kind === "requirements"
      ? "requirements_approval"
      : original.kind === "manufacturing_release"
        ? "manufacturing_release"
        : "hardware_qualification";
    this.#assertContextActor(context, capability, parsed.actor);
    const runId = original.runId;
    if (runId === undefined) {
      throw new DomainError("INVALID_ARGUMENT", "Attestation is not bound to a design run");
    }
    this.#run(snapshot, runId);
    const mutation = await this.#idempotentMutation<{
      readonly approvalId: string;
      readonly projectId: string;
      readonly runId: string;
      readonly subjectDigest: string;
      readonly reason: string;
    }>(
      "revoke_attestation",
      parsed,
      context,
      (result) => ({
        type: "attestation.revoked",
        projectId: result.projectId,
        runId: result.runId,
        subjectDigest: result.subjectDigest,
        payload: { approvalId: result.approvalId, reason: result.reason }
      }),
      (mutable) => {
        const runs = recordMap<DesignRun>(mutable.runs);
        const approvals = recordMap<ApprovalRecord>(mutable.approvals);
        const currentRun = this.#runFromMutable(runs, runId);
        this.#assertExpectedRevision(currentRun.revision, parsed.expectedRevision, "run");
        const current = approvals[original.id];
        if (current === undefined) {
          throw new DomainError("NOT_FOUND", "Attestation disappeared before revocation");
        }
        const currentCapability = current.kind === "requirements"
          ? "requirements_approval"
          : current.kind === "manufacturing_release"
            ? "manufacturing_release"
            : "hardware_qualification";
        this.#assertContextActor(context, currentCapability, current.actor);
        if (current.runId !== runId) {
          throw new DomainError("REVISION_CONFLICT", "Attestation run binding changed");
        }
        const timestamp = this.#timestamp();
        approvals[current.id] = { ...current, revokedAt: current.revokedAt ?? timestamp };
        runs[runId] = {
          ...currentRun,
          updatedAt: timestamp,
          revision: currentRun.revision + 1
        };
        return {
          approvalId: current.id,
          projectId: current.projectId,
          runId,
          subjectDigest: current.subjectDigest,
          reason: parsed.reason
        };
      }
    );
    const approval = mutation.state.approvals[mutation.result.approvalId];
    if (approval === undefined) {
      throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Revoked attestation is missing");
    }
    if (approval.runId === undefined) {
      throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Revoked attestation has no run binding");
    }
    const effectiveLifecycle = (await this.#status(mutation.state, approval.runId)).effectiveLifecycle;
    return { approval, effectiveLifecycle, stateRevision: mutation.state.revision };
  }

  public async generateBringupPlan(
    input: GenerateBringupPlanInput,
    context: CommandContext = SYSTEM_CONTEXT
  ): Promise<GeneratedArtifactResult> {
    const state = await this.#initializeAndReconcile();
    const parsed = operationInputSchemas.generate_bringup_plan.parse(input);
    const replay = this.#idempotencyResult(state, "generate_bringup_plan", parsed);
    if (replay !== undefined) {
      if (
        typeof replay !== "object" ||
        replay === null ||
        !("artifactId" in replay) ||
        typeof replay.artifactId !== "string" ||
        !("revisionId" in replay) ||
        typeof replay.revisionId !== "string"
      ) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Idempotent bring-up generation result is malformed"
        );
      }
      const artifact = state.artifacts[replay.artifactId];
      const revision = state.revisions[replay.revisionId];
      if (
        artifact === undefined ||
        revision === undefined ||
        artifact.designRevisionId !== revision.id ||
        artifact.runId !== revision.runId ||
        artifact.projectId !== revision.projectId
      ) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Idempotent bring-up generation result is missing or inconsistently bound"
        );
      }
      await this.ports.content.get(artifact.blob);
      return {
        projectId: revision.projectId,
        runId: revision.runId,
        designRevisionId: revision.id,
        workflowStage: "bringup_package",
        artifact,
        revision
      };
    }
    const revision = this.#revision(state, parsed.revisionId);
    const run = this.#run(state, revision.runId);
    const project = this.#project(state, revision.projectId);
    if (run.headRevisionId !== revision.id || project.headRevisionId !== revision.id) {
      throw new DomainError(
        "REVISION_CONFLICT",
        "Bring-up artifacts can only be generated from the exact current run and project head",
        {
          revisionId: revision.id,
          runHeadRevisionId: run.headRevisionId,
          projectHeadRevisionId: project.headRevisionId
        }
      );
    }
    const requirements = this.#requirements(run);
    const content = generatedBringupPlan(revision, requirements.identity.digest);
    return this.#commitGeneratedArtifact(
      "generate_bringup_plan",
      parsed,
      context,
      revision,
      GENERATED_BRINGUP_PLAN_CONTRACT.stage,
      GENERATED_BRINGUP_PLAN_CONTRACT.logicalName,
      GENERATED_BRINGUP_PLAN_CONTRACT.mediaType,
      Buffer.from(content, "utf8")
    );
  }

  public async generateFirmwareScaffold(
    input: GenerateFirmwareScaffoldInput,
    context: CommandContext = SYSTEM_CONTEXT
  ): Promise<GeneratedArtifactResult> {
    const state = await this.#initializeAndReconcile();
    const parsed = operationInputSchemas.generate_firmware_scaffold.parse(input);
    const replay = this.#idempotencyResult(state, "generate_firmware_scaffold", parsed);
    if (replay !== undefined) {
      if (
        typeof replay !== "object" ||
        replay === null ||
        !("artifactId" in replay) ||
        typeof replay.artifactId !== "string" ||
        !("revisionId" in replay) ||
        typeof replay.revisionId !== "string"
      ) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Idempotent firmware export result is malformed"
        );
      }
      const artifact = state.artifacts[replay.artifactId];
      const revision = state.revisions[replay.revisionId];
      if (
        artifact === undefined ||
        revision === undefined ||
        artifact.designRevisionId !== revision.id ||
        artifact.runId !== revision.runId ||
        artifact.projectId !== revision.projectId
      ) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Idempotent firmware export result is missing or inconsistently bound"
        );
      }
      await this.ports.content.get(artifact.blob);
      return {
        projectId: revision.projectId,
        runId: revision.runId,
        designRevisionId: revision.id,
        workflowStage: "firmware_contract",
        artifact,
        revision
      };
    }
    const revision = this.#revision(state, parsed.revisionId);
    const run = this.#run(state, revision.runId);
    const project = this.#project(state, revision.projectId);
    if (run.headRevisionId !== revision.id || project.headRevisionId !== revision.id) {
      throw new DomainError(
        "REVISION_CONFLICT",
        "Firmware artifacts can only be exported from the exact current run and project head",
        { revisionId: revision.id, runHeadRevisionId: run.headRevisionId, projectHeadRevisionId: project.headRevisionId }
      );
    }
    if (parsed.language !== "c") {
      throw new DomainError(
        "GATE_FAILED",
        "The current firmware stage has no committed artifacts for the requested language",
        { revisionId: revision.id, requestedLanguage: parsed.language, availableLanguages: ["c"] }
      );
    }
    const attempt = activeSuccessfulAttempt(run.attempts.firmware_contract);
    if (
      attempt === undefined ||
      attempt.outputIdentity === undefined ||
      attempt.provisionIdentity === undefined ||
      attempt.provisionManifestBlob === undefined ||
      attempt.artifactIds.length === 0
    ) {
      throw new DomainError(
        "GATE_FAILED",
        "The current revision has no complete committed firmware-stage result to export",
        { revisionId: revision.id }
      );
    }
    await this.#verifyAttemptProvision(attempt);
    const requiredNames = [
      "firmware/board-contract.json",
      "firmware/include/board_contract.h",
      "firmware/src/board_contract.c",
      "firmware/tests/board_contract_validation.c",
      "firmware/CMakeLists.txt",
      "firmware/reports/schematic-pin-map-parity.json",
      "firmware/reports/compile-validation.json"
    ] as const;
    const firmwareArtifacts = attempt.artifactIds.map((artifactId) => {
      const artifact = state.artifacts[artifactId];
      if (
        artifact === undefined ||
        artifact.stage !== "firmware_contract" ||
        artifact.runId !== run.id ||
        artifact.projectId !== project.id ||
        artifact.staleAt !== undefined ||
        !revision.artifactIds.includes(artifactId)
      ) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Committed firmware-stage artifact is missing, stale, or outside the current revision",
          { revisionId: revision.id, attemptId: attempt.id, artifactId }
        );
      }
      return artifact;
    });
    const byName = new Map(firmwareArtifacts.map((artifact) => [artifact.logicalName, artifact]));
    const missingNames = requiredNames.filter((logicalName) => !byName.has(logicalName));
    if (missingNames.length > 0 || byName.size !== firmwareArtifacts.length) {
      throw new DomainError(
        "GATE_FAILED",
        "The current firmware-stage artifact inventory is incomplete or ambiguous",
        { revisionId: revision.id, attemptId: attempt.id, missingNames }
      );
    }
    const firmwareEvidence = attempt.evidenceIds.map((evidenceId) => {
      const entry = state.evidence[evidenceId];
      if (
        entry === undefined ||
        entry.stage !== "firmware_contract" ||
        entry.runId !== run.id ||
        entry.projectId !== project.id ||
        entry.staleAt !== undefined ||
        !revision.evidenceIds.includes(evidenceId)
      ) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Committed firmware-stage evidence is missing, stale, or outside the current revision",
          { revisionId: revision.id, attemptId: attempt.id, evidenceId }
        );
      }
      return entry;
    });
    const payloads = await Promise.all(
      firmwareArtifacts.map(async (artifact) => {
        const logicalName = this.#safeLogicalPath(artifact.logicalName);
        const bytes = await this.ports.content.get(artifact.blob);
        if (!sameContentIdentity(contentIdentity(bytes), artifact.blob)) {
          throw new DomainError("DIGEST_MISMATCH", "Firmware artifact bytes changed before export", {
            artifactId: artifact.id
          });
        }
        return { artifact, logicalName, bytes };
      })
    );
    payloads.sort((left, right) => left.logicalName.localeCompare(right.logicalName, "en"));
    const exportRecord = {
      schemaVersion: "evleda.firmware-stage-export.v1",
      classification: "candidate-only",
      lifecycle: "candidate",
      releaseAuthorized: false,
      projectId: project.id,
      runId: run.id,
      designRevisionId: revision.id,
      revisionManifest: revision.manifest,
      attempt: {
        id: attempt.id,
        inputManifest: attempt.inputManifest,
        provisionIdentity: attempt.provisionIdentity,
        provisionManifestBlob: attempt.provisionManifestBlob,
        outputIdentity: attempt.outputIdentity
      },
      artifacts: payloads.map(({ artifact }) => this.#artifactProjection(artifact)),
      evidence: firmwareEvidence.map((entry) => this.#evidenceProjection(entry))
    } as const;
    const files = new Map<string, Uint8Array>(
      payloads.map(({ logicalName, bytes }) => [logicalName, bytes] as const)
    );
    files.set(
      "provenance/firmware-stage-export.json",
      Buffer.from(`${canonicalJson(exportRecord)}\n`, "utf8")
    );
    const bytes = this.#deterministicZip(files);
    return this.#recordFirmwareScaffoldExport(
      parsed,
      context,
      revision,
      attempt,
      firmwareArtifacts,
      bytes
    );
  }

  public async listProjects(): Promise<readonly Project[]> {
    const state = await this.#initializeAndReconcile();
    return Object.values(recordMap<Project>(state.projects)).sort((left, right) =>
      left.createdAt === right.createdAt
        ? left.id.localeCompare(right.id, "en")
        : left.createdAt.localeCompare(right.createdAt, "en")
    );
  }

  public async listRuns(projectId: string): Promise<readonly DesignRun[]> {
    const state = await this.#initializeAndReconcile();
    this.#project(state, projectId);
    return Object.values(recordMap<DesignRun>(state.runs))
      .filter((run) => run.projectId === projectId)
      .sort((left, right) =>
        left.createdAt === right.createdAt
          ? left.id.localeCompare(right.id, "en")
          : left.createdAt.localeCompare(right.createdAt, "en")
      );
  }

  public async readArtifact(artifactId: string): Promise<{
    readonly artifact: ArtifactRecord;
    readonly bytes: Buffer;
  }> {
    const state = await this.#initializeAndReconcile();
    const artifact = recordMap<ArtifactRecord>(state.artifacts)[artifactId];
    if (artifact === undefined) {
      throw new DomainError("NOT_FOUND", "Artifact was not found", { artifactId });
    }
    return { artifact, bytes: await this.ports.content.get(artifact.blob) };
  }

  async #engineeringArtifactBytes(
    artifact: ArtifactRecord,
    label: string,
    maximumBytes: number
  ): Promise<Buffer> {
    let bytes: Buffer;
    try {
      bytes = await this.ports.content.get(artifact.blob);
    } catch (error) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        `${label} bytes are missing or corrupt`,
        {
          artifactId: artifact.id,
          causeCode: error instanceof DomainError ? error.code : "CONTENT_READ_FAILED"
        }
      );
    }
    if (
      bytes.byteLength === 0 ||
      bytes.byteLength > maximumBytes ||
      !sameContentIdentity(contentIdentity(bytes), artifact.blob)
    ) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        `${label} does not match its bounded content-addressed identity`,
        { artifactId: artifact.id, maximumBytes }
      );
    }
    return bytes;
  }

  async #authoritativeEngineeringCheckerResultIdentities(
    artifacts: readonly ArtifactRecord[],
    evidence: readonly EvidenceRecord[],
    checkerResults: readonly EngineeringCheckerResult[],
    boardIdentity: ContentIdentity,
    selectedIsHeadRevision: boolean
  ): Promise<readonly EngineeringEvidenceIdentity[]> {
    const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
    const verified: EngineeringEvidenceIdentity[] = [];
    for (const checker of checkerResults) {
      const approvedTool = APPROVED_ENGINEERING_CHECKER_TOOLS.get(checker.checkerId);
      if (approvedTool === undefined) continue;
      if (!exactInputIncludes(checker.exactInputIdentities, boardIdentity)) continue;
      const candidates: EngineeringEvidenceIdentity[] = [];
      for (const entry of evidence) {
        const linkedIds = [entry.rawArtifactId, entry.parsedArtifactId].filter(
          (value): value is string => value !== undefined
        );
        if (
          entry.evidenceClass !== "evleda_check" ||
          entry.validationStatus !== "pass" ||
          entry.lifecycle !== "candidate" ||
          linkedIds.length !== 1 ||
          entry.tool.adapter !== "evleda" ||
          entry.tool.capabilityProfile !== checker.checkerId ||
          !sameToolIdentity(entry.tool, approvedTool) ||
          entry.tool.name.length === 0 ||
          entry.tool.version.length === 0 ||
          !Number.isFinite(Date.parse(entry.createdAt)) ||
          (selectedIsHeadRevision && !evidenceIsCurrent(entry, this.#now()))
        ) {
          continue;
        }
        const artifact = artifactById.get(linkedIds[0]!);
        if (
          artifact === undefined ||
          artifact.validationStatus !== "pass" ||
          artifact.lifecycle !== "candidate" ||
          (selectedIsHeadRevision && artifact.staleAt !== undefined) ||
          !sameToolIdentity(entry.tool, artifact.tool) ||
          !sameExactInputList(entry.exactInputs, artifact.exactInputs) ||
          !entry.subjectDigests.includes(artifact.blob.digest) ||
          !exactInputIncludes(entry.exactInputs, boardIdentity) ||
          checker.exactInputIdentities.some(
            (identity) =>
              !exactInputIncludes(entry.exactInputs, identity) ||
              !exactInputIncludes(artifact.exactInputs, identity)
          )
        ) {
          continue;
        }
        const bytes = await this.#engineeringArtifactBytes(
          artifact,
          `Engineering checker ${checker.checkerId} report`,
          16_777_216
        );
        let identityMatches =
          "size" in checker.resultIdentity &&
          sameContentIdentity(checker.resultIdentity, artifact.blob);
        if (!identityMatches && !("size" in checker.resultIdentity)) {
          try {
            const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
            if (isRecordValue(parsed) && canonicalJsonBytesMatch(bytes, parsed)) {
              const embedded = canonicalIdentityValue(parsed.identity);
              const preimage = Object.fromEntries(
                Object.entries(parsed).filter(([key]) => key !== "identity")
              );
              identityMatches =
                embedded !== undefined &&
                canonicalJson(embedded) === canonicalJson(checker.resultIdentity) &&
                canonicalJson(
                  canonicalIdentity(preimage, checker.resultIdentity.schemaVersion),
                ) === canonicalJson(checker.resultIdentity);
            }
          } catch {
            identityMatches = false;
          }
        }
        if (identityMatches) candidates.push(checker.resultIdentity);
      }
      if (candidates.length === 1) verified.push(candidates[0]!);
    }
    return this.#uniqueIdentities(verified);
  }

  #assertEngineeringRevisionRecord(
    state: EvlEdaState,
    revision: DesignRevision,
    record: Readonly<Record<string, unknown>>,
    selectedIsHeadRevision: boolean
  ): void {
    const artifactEntries = Array.isArray(record.artifacts) ? record.artifacts : undefined;
    const evidenceEntries = Array.isArray(record.evidence) ? record.evidence : undefined;
    if (artifactEntries === undefined || evidenceEntries === undefined) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Revision manifest record lacks its closed artifact/evidence inventories",
        { revisionId: revision.id }
      );
    }
    const stableArtifact = (value: Readonly<Record<string, unknown>>) => ({
      id: value.id,
      projectId: value.projectId,
      runId: value.runId,
      stage: value.stage,
      logicalName: value.logicalName,
      mediaType: value.mediaType,
      blob: value.blob,
      exactInputs: value.exactInputs,
      derivedFrom: value.derivedFrom,
      tool: value.tool,
      validationStatus: value.validationStatus,
      unresolvedAssumptions: value.unresolvedAssumptions,
      lifecycle: value.lifecycle,
      createdAt: value.createdAt
    });
    const stableEvidence = (value: Readonly<Record<string, unknown>>) => ({
      id: value.id,
      projectId: value.projectId,
      runId: value.runId,
      stage: value.stage,
      evidenceClass: value.evidenceClass,
      claim: value.claim,
      subjectDigests: value.subjectDigests,
      rawArtifactId: value.rawArtifactId ?? null,
      parsedArtifactId: value.parsedArtifactId ?? null,
      exactInputs: value.exactInputs,
      tool: value.tool,
      validationStatus: value.validationStatus,
      unresolvedAssumptions: value.unresolvedAssumptions,
      lifecycle: value.lifecycle,
      createdAt: value.createdAt,
      validUntil: value.validUntil ?? null
    });
    const artifactById = new Map<string, Readonly<Record<string, unknown>>>();
    for (const value of artifactEntries) {
      if (!isRecordValue(value) || typeof value.id !== "string" || artifactById.has(value.id)) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Revision manifest artifact inventory is malformed or duplicated",
          { revisionId: revision.id }
        );
      }
      artifactById.set(value.id, value);
    }
    const evidenceById = new Map<string, Readonly<Record<string, unknown>>>();
    for (const value of evidenceEntries) {
      if (!isRecordValue(value) || typeof value.id !== "string" || evidenceById.has(value.id)) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Revision manifest evidence inventory is malformed or duplicated",
          { revisionId: revision.id }
        );
      }
      evidenceById.set(value.id, value);
    }
    if (
      canonicalJson([...artifactById.keys()].sort()) !==
        canonicalJson([...revision.artifactIds].sort()) ||
      canonicalJson([...evidenceById.keys()].sort()) !==
        canonicalJson([...revision.evidenceIds].sort())
    ) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Revision state membership differs from its canonical manifest inventory",
        { revisionId: revision.id }
      );
    }
    for (const [artifactId, manifestArtifact] of artifactById) {
      const artifact = state.artifacts[artifactId];
      const currentProjection = artifact === undefined
        ? undefined
        : stableArtifact(artifact as unknown as Readonly<Record<string, unknown>>);
      const comparableCurrent =
        currentProjection !== undefined &&
        !selectedIsHeadRevision &&
        artifact!.validationStatus === "stale" &&
        artifact!.staleAt !== undefined
          ? { ...currentProjection, validationStatus: manifestArtifact.validationStatus }
          : currentProjection;
      if (
        artifact === undefined ||
        canonicalJson(stableArtifact(manifestArtifact)) !==
          canonicalJson(comparableCurrent)
      ) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Stored artifact no longer reproduces its revision-manifest record",
          { revisionId: revision.id, artifactId }
        );
      }
    }
    for (const [evidenceId, manifestEvidence] of evidenceById) {
      const entry = state.evidence[evidenceId];
      const currentProjection = entry === undefined
        ? undefined
        : stableEvidence(entry as unknown as Readonly<Record<string, unknown>>);
      const comparableCurrent =
        currentProjection !== undefined &&
        !selectedIsHeadRevision &&
        entry!.validationStatus === "stale" &&
        entry!.staleAt !== undefined
          ? { ...currentProjection, validationStatus: manifestEvidence.validationStatus }
          : currentProjection;
      if (
        entry === undefined ||
        canonicalJson(stableEvidence(manifestEvidence)) !==
          canonicalJson(comparableCurrent)
      ) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Stored evidence no longer reproduces its revision-manifest record",
          { revisionId: revision.id, evidenceId }
        );
      }
    }
  }

  #engineeringInputReferences(value: unknown): EngineeringInputReferences {
    const invalid = (field: string): never => {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "PCB-practice report contains malformed self-contained engineering input references",
        { field }
      );
    };
    const root = isRecordValue(value) ? value : invalid("engineeringInputs");
    if (!exactObjectKeys(root, [
      "layoutPlan",
      "analyzerProfile",
      "practiceCatalog",
      "routeQualityPolicy",
      "routeQualityRuleDeck",
      "proofFixturePolicy",
      "engineeringConstraintBinding"
    ])) {
      invalid("engineeringInputs.keys");
    }
    const reference = (
      candidate: unknown,
      field: string,
      expectedLogicalName: string,
      extraKeys: readonly string[] = []
    ): EngineeringSnapshotReference & Readonly<Record<string, unknown>> => {
      const record = isRecordValue(candidate) ? candidate : invalid(field);
      if (!exactObjectKeys(record, [
        "logicalName",
        "contentIdentity",
        "canonicalIdentity",
        ...extraKeys
      ])) {
        invalid(`${field}.keys`);
      }
      const content = contentIdentityValue(record.contentIdentity) ?? invalid(`${field}.contentIdentity`);
      const canonical = canonicalIdentityValue(record.canonicalIdentity) ?? invalid(`${field}.canonicalIdentity`);
      if (record.logicalName !== expectedLogicalName) invalid(`${field}.logicalName`);
      return {
        ...record,
        logicalName: expectedLogicalName,
        contentIdentity: content,
        canonicalIdentity: canonical
      };
    };
    const layoutPlanRecord = isRecordValue(root.layoutPlan)
      ? root.layoutPlan
      : invalid("engineeringInputs.layoutPlan");
    if (
      !exactObjectKeys(layoutPlanRecord, ["logicalName", "contentIdentity"]) ||
      layoutPlanRecord.logicalName !== "pcb/layout-routing-plan.json"
    ) {
      invalid("engineeringInputs.layoutPlan");
    }
    const layoutPlanIdentity = contentIdentityValue(layoutPlanRecord.contentIdentity) ??
      invalid("engineeringInputs.layoutPlan.contentIdentity");
    const analyzerProfile = reference(
      root.analyzerProfile,
      "engineeringInputs.analyzerProfile",
      "pcb/engineering/analyzer-profile.json"
    );
    const practiceCatalog = reference(
      root.practiceCatalog,
      "engineeringInputs.practiceCatalog",
      "pcb/engineering/practice-catalog.json"
    );
    const routeQualityPolicyRecord = reference(
      root.routeQualityPolicy,
      "engineeringInputs.routeQualityPolicy",
      "pcb/engineering/route-quality-policy.json",
      ["captureIdentity"]
    );
    const routeQualityPolicyCapture = contentIdentityValue(
      routeQualityPolicyRecord.captureIdentity
    ) ?? invalid("engineeringInputs.routeQualityPolicy.captureIdentity");
    const routeQualityRuleDeck = reference(
      root.routeQualityRuleDeck,
      "engineeringInputs.routeQualityRuleDeck",
      "pcb/engineering/route-quality-rule-deck.json"
    );
    const proofFixturePolicy = reference(
      root.proofFixturePolicy,
      "engineeringInputs.proofFixturePolicy",
      "pcb/engineering/proof-fixture-policy.json"
    );
    let engineeringConstraintBinding: EngineeringInputReferences["engineeringConstraintBinding"];
    if (root.engineeringConstraintBinding === null) {
      engineeringConstraintBinding = null;
    } else {
      const record = reference(
        root.engineeringConstraintBinding,
        "engineeringInputs.engineeringConstraintBinding",
        "pcb/engineering/constraint-binding.json",
        ["compiledConstraintSetIdentity"]
      );
      const compiledConstraintSetIdentity = canonicalIdentityValue(
        record.compiledConstraintSetIdentity
      ) ?? invalid("engineeringInputs.engineeringConstraintBinding.compiledConstraintSetIdentity");
      engineeringConstraintBinding = {
        logicalName: record.logicalName,
        contentIdentity: record.contentIdentity,
        canonicalIdentity: record.canonicalIdentity,
        compiledConstraintSetIdentity
      };
    }
    return {
      layoutPlan: {
        logicalName: "pcb/layout-routing-plan.json",
        contentIdentity: layoutPlanIdentity
      },
      analyzerProfile,
      practiceCatalog,
      routeQualityPolicy: {
        logicalName: routeQualityPolicyRecord.logicalName,
        contentIdentity: routeQualityPolicyRecord.contentIdentity,
        canonicalIdentity: routeQualityPolicyRecord.canonicalIdentity,
        captureIdentity: routeQualityPolicyCapture
      },
      routeQualityRuleDeck,
      proofFixturePolicy,
      engineeringConstraintBinding
    };
  }

  async #engineeringSnapshotDocument(
    artifacts: readonly ArtifactRecord[],
    reference: { readonly logicalName: string; readonly contentIdentity: ContentIdentity },
    reportArtifact: ArtifactRecord
  ): Promise<{
    readonly artifact: ArtifactRecord;
    readonly document: Readonly<Record<string, unknown>>;
  }> {
    const candidates = artifacts.filter(
      (artifact) =>
        artifact.logicalName === reference.logicalName &&
        sameContentIdentity(artifact.blob, reference.contentIdentity)
    );
    if (candidates.length !== 1) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Engineering snapshot reference does not resolve to exactly one selected-revision artifact",
        { logicalName: reference.logicalName, candidateCount: candidates.length }
      );
    }
    const artifact = candidates[0]!;
    if (
      artifact.stage !== "pcb_placement_routing" ||
      artifact.mediaType !== "application/json" ||
      !reportArtifact.derivedFrom.includes(artifact.id)
    ) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Engineering snapshot artifact is outside the report's exact PCB-stage derivation",
        { logicalName: reference.logicalName, artifactId: artifact.id }
      );
    }
    const bytes = await this.#engineeringArtifactBytes(
      artifact,
      `Engineering snapshot ${reference.logicalName}`,
      16_777_216
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Engineering snapshot artifact is not valid UTF-8 JSON",
        { logicalName: reference.logicalName, artifactId: artifact.id }
      );
    }
    if (!isRecordValue(parsed) || !bytes.equals(Buffer.from(`${canonicalJson(parsed)}\n`, "utf8"))) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Engineering snapshot artifact is not its exact canonical JSON snapshot",
        { logicalName: reference.logicalName, artifactId: artifact.id }
      );
    }
    return { artifact, document: parsed };
  }

  #assertEmbeddedSnapshotIdentity(
    document: Readonly<Record<string, unknown>>,
    reference: EngineeringSnapshotReference,
    expectedSchemaVersion: string,
    omittedKeys: readonly string[] = ["identity"]
  ): Readonly<Record<string, unknown>> {
    const embedded = canonicalIdentityValue(document.identity);
    if (
      document.schemaVersion !== expectedSchemaVersion ||
      reference.canonicalIdentity.schemaVersion !== expectedSchemaVersion ||
      embedded === undefined ||
      canonicalJson(embedded) !== canonicalJson(reference.canonicalIdentity)
    ) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Engineering snapshot identity metadata is malformed or detached",
        { logicalName: reference.logicalName, expectedSchemaVersion }
      );
    }
    const preimage = Object.fromEntries(
      Object.entries(document).filter(([key]) => !omittedKeys.includes(key))
    );
    if (
      canonicalJson(canonicalIdentity(preimage, expectedSchemaVersion)) !==
      canonicalJson(reference.canonicalIdentity)
    ) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Engineering snapshot canonical identity does not reproduce from its exact payload",
        { logicalName: reference.logicalName }
      );
    }
    return preimage;
  }

  async #engineeringNativeReport(
    kind: "drc" | "board_statistics",
    artifacts: readonly ArtifactRecord[],
    evidence: readonly EvidenceRecord[],
    selectedIsHeadRevision = true,
    run?: DesignRun
  ): Promise<ValidatedNativeEngineeringReport | null> {
    const logicalName = kind === "drc"
      ? "reports/kicad/pcb/drc.json"
      : "reports/kicad/pcb/native/board-statistics.json";
    const reportArtifacts = artifacts.filter(
      (artifact) =>
        artifact.stage === "pcb_placement_routing" && artifact.logicalName === logicalName
    );
    const reportEvidence = evidence.filter((entry) => {
      if (entry.stage !== "pcb_placement_routing") return false;
      const claim = claimedNativeReport(entry);
      return claim?.kind === kind || entry.rawArtifactId !== undefined &&
        reportArtifacts.some((artifact) => artifact.id === entry.rawArtifactId);
    });
    if (reportArtifacts.length === 0 && reportEvidence.length === 0) return null;
    if (reportArtifacts.length !== 1 || reportEvidence.length !== 1) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        `Selected revision does not contain exactly one authoritative native ${kind} report/evidence pair`,
        {
          kind,
          artifactCount: reportArtifacts.length,
          evidenceCount: reportEvidence.length
        }
      );
    }
    const artifact = reportArtifacts[0]!;
    const entry = reportEvidence[0]!;
    const claim = claimedNativeReport(entry);
    const authority = authorityIdentities(
      entry.exactInputs,
      KICAD_CLI_REPORT_AUTHORITY_SCHEMA
    );
    if (
      claim?.kind !== kind ||
      entry.evidenceClass !== "kicad_native" ||
      entry.rawArtifactId !== artifact.id ||
      entry.parsedArtifactId !== undefined ||
      entry.subjectDigests.length !== 1 ||
      entry.subjectDigests[0] !== artifact.blob.digest ||
      entry.validationStatus !== artifact.validationStatus ||
      entry.lifecycle !== "candidate" ||
      artifact.lifecycle !== "candidate" ||
      artifact.mediaType.length === 0 ||
      artifact.tool.adapter !== "kicad_cli" ||
      !sameToolIdentity(entry.tool, artifact.tool) ||
      !sameExactInputList(entry.exactInputs, artifact.exactInputs) ||
      authority.length !== 1 ||
      authorityIdentities(entry.exactInputs, KICAD_ANALYZER_REPORT_AUTHORITY_SCHEMA).length !== 0 ||
      typeof artifact.tool.executablePath !== "string" ||
      artifact.tool.executablePath.length === 0 ||
      typeof artifact.tool.executableDigest !== "string" ||
      !/^[0-9a-f]{64}$/u.test(artifact.tool.executableDigest)
    ) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        `Native ${kind} report/evidence authority is malformed or rebound`,
        { artifactId: artifact.id, evidenceId: entry.id }
      );
    }
    await this.#engineeringArtifactBytes(artifact, `Native ${kind} report`, 67_108_864);
    if (run !== undefined) {
      const producingAttempts = run.attempts.pcb_placement_routing.filter(
        (attempt) =>
          attempt.artifactIds.includes(artifact.id) && attempt.evidenceIds.includes(entry.id)
      );
      if (
        producingAttempts.length !== 1 ||
        !exactInputIncludes(artifact.exactInputs, producingAttempts[0]!.inputManifest) ||
        !exactInputIncludes(entry.exactInputs, producingAttempts[0]!.inputManifest)
      ) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          `Native ${kind} report is not bound to exactly one persisted PCB-stage attempt`,
          { artifactId: artifact.id, evidenceId: entry.id }
        );
      }
    }
    return {
      artifact,
      evidence: entry,
      execution: {
        validationStatus: entry.validationStatus,
        current:
          (!selectedIsHeadRevision ||
            (evidenceIsCurrent(entry, this.#now()) && artifact.staleAt === undefined)) &&
          entry.validationStatus !== "stale" &&
          entry.validationStatus !== "revoked" &&
          entry.validationStatus !== "waived",
        artifactId: artifact.id,
        evidenceId: entry.id,
        reportIdentity: artifact.blob,
        tool: entry.tool,
        evaluatedAt: entry.createdAt
      }
    };
  }

  async #engineeringPracticeReport(
    revision: DesignRevision,
    run: DesignRun,
    artifacts: readonly ArtifactRecord[],
    evidence: readonly EvidenceRecord[],
    nativeDrc: ValidatedNativeEngineeringReport | null,
    selectedIsHeadRevision: boolean
  ): Promise<ValidatedEngineeringPracticeReport | null> {
    const logicalName = "reports/kicad/pcb/pcb-practices.json";
    const reportArtifacts = artifacts.filter(
      (artifact) =>
        artifact.stage === "pcb_placement_routing" && artifact.logicalName === logicalName
    );
    const approvedTool = REFERENCE_KICAD_ANALYZER_TOOLS.pcb_practices;
    const reportEvidence = evidence.filter((entry) => {
      if (entry.stage !== "pcb_placement_routing") return false;
      const claim = claimedDerivedReport(entry);
      return claim?.kind === "pcb_practices" ||
        (entry.evidenceClass === "evleda_check" && sameToolIdentity(entry.tool, approvedTool)) ||
        (entry.parsedArtifactId !== undefined &&
          reportArtifacts.some((artifact) => artifact.id === entry.parsedArtifactId));
    });
    if (reportArtifacts.length === 0 && reportEvidence.length === 0) return null;
    if (reportArtifacts.length !== 1 || reportEvidence.length !== 1) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Selected revision does not contain exactly one authoritative PCB-practice report/evidence pair",
        {
          revisionId: revision.id,
          artifactCount: reportArtifacts.length,
          evidenceCount: reportEvidence.length
        }
      );
    }
    const reportArtifact = reportArtifacts[0]!;
    const reportEntry = reportEvidence[0]!;
    const claim = claimedDerivedReport(reportEntry);
    if (
      claim?.kind !== "pcb_practices" ||
      claim.analyzerId !== approvedTool.capabilityProfile ||
      reportEntry.evidenceClass !== "evleda_check" ||
      reportEntry.rawArtifactId !== undefined ||
      reportEntry.parsedArtifactId !== reportArtifact.id ||
      reportEntry.subjectDigests.length !== 1 ||
      reportEntry.subjectDigests[0] !== reportArtifact.blob.digest ||
      reportEntry.validationStatus !== reportArtifact.validationStatus ||
      reportEntry.lifecycle !== "candidate" ||
      reportArtifact.lifecycle !== "candidate" ||
      reportArtifact.mediaType !== "application/json" ||
      !sameToolIdentity(reportEntry.tool, approvedTool) ||
      !sameToolIdentity(reportArtifact.tool, approvedTool) ||
      !sameExactInputList(reportEntry.exactInputs, reportArtifact.exactInputs)
    ) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "PCB-practice report/evidence authority is malformed or rebound",
        { artifactId: reportArtifact.id, evidenceId: reportEntry.id }
      );
    }
    const producingAttempts = run.attempts.pcb_placement_routing.filter(
      (attempt) =>
        attempt.artifactIds.includes(reportArtifact.id) &&
        attempt.evidenceIds.includes(reportEntry.id)
    );
    if (
      producingAttempts.length !== 1 ||
      !exactInputIncludes(reportArtifact.exactInputs, producingAttempts[0]!.inputManifest) ||
      !exactInputIncludes(reportEntry.exactInputs, producingAttempts[0]!.inputManifest)
    ) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "PCB-practice report is not bound to exactly one persisted stage attempt and input manifest",
        { artifactId: reportArtifact.id, evidenceId: reportEntry.id }
      );
    }
    const bytes = await this.#engineeringArtifactBytes(
      reportArtifact,
      "PCB-practice report",
      67_108_864
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "PCB-practice report is not valid UTF-8 JSON",
        { artifactId: reportArtifact.id }
      );
    }
    const document = isRecordValue(parsed) ? parsed : undefined;
    const authority = isRecordValue(document?.authority) ? document.authority : undefined;
    const payload = isRecordValue(document?.payload) ? document.payload : undefined;
    const requestBinding = isRecordValue(document?.requestBinding)
      ? document.requestBinding
      : undefined;
    const reportKeys = document === undefined ? [] : Object.keys(document);
    const allowedReportKeys = new Set([
      "schemaVersion",
      "kind",
      "validationStatus",
      "classification",
      "lifecycle",
      "releaseAuthorized",
      "sourceRevisionDigest",
      "requestBinding",
      "authority",
      "provenance",
      "canonicalValidation",
      "unresolvedAssumptions",
      "executable",
      "sourceBindings",
      "payload"
    ]);
    const requiredReportKeys = [
      "schemaVersion",
      "kind",
      "validationStatus",
      "classification",
      "lifecycle",
      "releaseAuthorized",
      "sourceRevisionDigest",
      "requestBinding",
      "authority",
      "payload"
    ];
    if (
      document === undefined ||
      authority === undefined ||
      payload === undefined ||
      requestBinding === undefined ||
      !canonicalJsonBytesMatch(bytes, document) ||
      document.schemaVersion !== REFERENCE_KICAD_REPORT_SCHEMA ||
      document.kind !== "pcb_practices" ||
      document.validationStatus !== reportArtifact.validationStatus ||
      document.classification !== "candidate-validation" ||
      document.lifecycle !== "candidate" ||
      document.releaseAuthorized !== false ||
      document.sourceRevisionDigest !== claim.sourceRevisionDigest ||
      authority.kind !== "evleda_analyzer" ||
      authority.analyzerId !== approvedTool.capabilityProfile ||
      !exactObjectKeys(authority, ["kind", "analyzerId", "tool", "inputBindings"]) ||
      !isRecordValue(authority.tool) ||
      !sameToolIdentity(authority.tool as unknown as ToolIdentity, approvedTool) ||
      !Array.isArray(authority.inputBindings) ||
      reportKeys.some((key) => !allowedReportKeys.has(key)) ||
      requiredReportKeys.some((key) => !reportKeys.includes(key)) ||
      !exactObjectKeys(payload, [
        "engineeringInputs",
        "analysisIdentity",
        "analysis",
        "engineeringSummary"
      ])
    ) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "PCB-practice report envelope is malformed or does not match its evidence authority",
        { artifactId: reportArtifact.id }
      );
    }
    const expectedAuthorityIdentity = canonicalIdentity(
      authority,
      KICAD_ANALYZER_REPORT_AUTHORITY_SCHEMA
    );
    if (
      authorityIdentities(
        reportEntry.exactInputs,
        KICAD_ANALYZER_REPORT_AUTHORITY_SCHEMA
      ).length !== 1 ||
      !exactInputIncludes(reportEntry.exactInputs, expectedAuthorityIdentity) ||
      authorityIdentities(reportEntry.exactInputs, KICAD_CLI_REPORT_AUTHORITY_SCHEMA).length !== 0
    ) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "PCB-practice analyzer authority identity is absent, duplicated, or substituted",
        { artifactId: reportArtifact.id, evidenceId: reportEntry.id }
      );
    }
    const inputBindings = authority.inputBindings.map((value, index) => {
      const record = isRecordValue(value) ? value : undefined;
      const identity = contentIdentityValue(record?.identity);
      if (
        record === undefined ||
        !exactObjectKeys(record, ["kind", "logicalName", "identity"]) ||
        !["artifact", "native_report", "source"].includes(String(record.kind)) ||
        typeof record.logicalName !== "string" ||
        record.logicalName.length === 0 ||
        identity === undefined ||
        !exactInputIncludes(reportEntry.exactInputs, identity)
      ) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "PCB-practice analyzer input binding is malformed or absent from exact inputs",
          { artifactId: reportArtifact.id, bindingIndex: index }
        );
      }
      return {
        kind: record.kind as "artifact" | "native_report" | "source",
        logicalName: record.logicalName,
        identity
      };
    });
    const bindingKeys = inputBindings.map(
      (binding) => `${binding.kind}:${binding.logicalName}:${canonicalJson(binding.identity)}`
    );
    if (new Set(bindingKeys).size !== bindingKeys.length) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "PCB-practice analyzer authority contains duplicate input bindings",
        { artifactId: reportArtifact.id }
      );
    }
    const references = this.#engineeringInputReferences(payload.engineeringInputs);
    const expectedSnapshotReferences = [
      references.layoutPlan,
      references.analyzerProfile,
      references.practiceCatalog,
      references.routeQualityPolicy,
      references.routeQualityRuleDeck,
      references.proofFixturePolicy,
      ...(references.engineeringConstraintBinding === null
        ? []
        : [references.engineeringConstraintBinding])
    ];
    for (const reference of expectedSnapshotReferences) {
      const matching = inputBindings.filter(
        (binding) =>
          binding.kind === "artifact" &&
          binding.logicalName === reference.logicalName &&
          sameContentIdentity(binding.identity, reference.contentIdentity)
      );
      if (matching.length !== 1) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "PCB-practice report does not bind exactly one referenced engineering snapshot",
          { logicalName: reference.logicalName, bindingCount: matching.length }
        );
      }
    }
    const requestBindingIdentity = canonicalIdentityValue(requestBinding.identity);
    const request = isRecordValue(requestBinding.request) ? requestBinding.request : undefined;
    const requestPcbEngineering = isRecordValue(request?.pcbEngineering)
      ? request.pcbEngineering
      : undefined;
    const requestPreimage = Object.fromEntries(
      Object.entries(requestBinding).filter(([key]) => key !== "identity")
    );
    if (
      !exactObjectKeys(requestBinding, ["schemaVersion", "identity", "request", "templateInstantiation"]) ||
      requestBinding.schemaVersion !== REFERENCE_KICAD_REQUEST_BINDING_SCHEMA ||
      requestBindingIdentity === undefined ||
      canonicalJson(
        canonicalIdentity(requestPreimage, REFERENCE_KICAD_REQUEST_BINDING_SCHEMA)
      ) !== canonicalJson(requestBindingIdentity) ||
      request === undefined ||
      !exactObjectKeys(request, [
        "schemaVersion",
        "stage",
        "expectedSourceRevisionDigest",
        "requirementsIdentity",
        "upstreamArtifactIdentities",
        "pcbEngineering"
      ]) ||
      request.schemaVersion !== "evleda.kicad-request.v2" ||
      request.stage !== "pcb_placement_routing" ||
      request.expectedSourceRevisionDigest !== document.sourceRevisionDigest ||
      canonicalJson(request.requirementsIdentity) !== canonicalJson(run.requirements?.identity) ||
      requestPcbEngineering === undefined ||
      canonicalJson(requestPcbEngineering) !== canonicalJson(references)
    ) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "PCB-practice request binding does not reproduce or bind the selected run inputs",
        { artifactId: reportArtifact.id, revisionId: revision.id }
      );
    }
    const requestedUpstream = Array.isArray(request.upstreamArtifactIdentities)
      ? request.upstreamArtifactIdentities
      : [];
    if (
      requestedUpstream.some((identity) => {
        const parsedIdentity = contentIdentityValue(identity);
        return parsedIdentity === undefined || !exactInputIncludes(reportEntry.exactInputs, parsedIdentity);
      })
    ) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "PCB-practice report omits a request-bound upstream artifact identity",
        { artifactId: reportArtifact.id }
      );
    }
    if (nativeDrc === null) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "PCB-practice report exists without its authoritative native DRC report/evidence pair",
        { artifactId: reportArtifact.id }
      );
    }
    const nativeBoardStatistics = await this.#engineeringNativeReport(
      "board_statistics",
      artifacts,
      evidence,
      selectedIsHeadRevision,
      run
    );
    if (nativeBoardStatistics === null) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "PCB-practice report exists without its authoritative native board-statistics pair",
        { artifactId: reportArtifact.id }
      );
    }
    const requiredNative = [nativeDrc, nativeBoardStatistics];
    for (const native of requiredNative) {
      const matching = inputBindings.filter(
        (binding) =>
          binding.kind === "native_report" &&
          binding.logicalName === native.artifact.logicalName &&
          sameContentIdentity(binding.identity, native.artifact.blob)
      );
      if (matching.length !== 1 || !reportArtifact.derivedFrom.includes(native.artifact.id)) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "PCB-practice report is detached from a required native report authority",
          { reportArtifactId: reportArtifact.id, nativeArtifactId: native.artifact.id }
        );
      }
    }
    const boardBindings = inputBindings.filter(
      (binding) =>
        binding.kind === "artifact" &&
        binding.logicalName.toLocaleLowerCase("en-US").endsWith(".kicad_pcb")
    );
    const boardSources = inputBindings.filter(
      (binding) =>
        binding.kind === "source" &&
        binding.logicalName.toLocaleLowerCase("en-US").endsWith(".kicad_pcb")
    );
    if (
      boardBindings.length !== 1 ||
      boardSources.length !== 1 ||
      !sameContentIdentity(boardBindings[0]!.identity, boardSources[0]!.identity)
    ) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "PCB-practice report does not bind one identical board artifact and evaluated board source",
        { artifactId: reportArtifact.id }
      );
    }
    const boardCandidates = artifacts.filter(
      (artifact) =>
        artifact.logicalName === boardBindings[0]!.logicalName &&
        sameContentIdentity(artifact.blob, boardBindings[0]!.identity)
    );
    if (boardCandidates.length !== 1 || !reportArtifact.derivedFrom.includes(boardCandidates[0]!.id)) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "PCB-practice board authority does not resolve to one selected-revision artifact",
        { artifactId: reportArtifact.id, boardCandidateCount: boardCandidates.length }
      );
    }
    const boardArtifact = boardCandidates[0]!;
    const boardBytes = await this.#engineeringArtifactBytes(
      boardArtifact,
      "Native KiCad board",
      67_108_864
    );
    const layoutPlan = await this.#engineeringSnapshotDocument(
      artifacts,
      references.layoutPlan,
      reportArtifact
    );
    const analyzerProfileSnapshot = await this.#engineeringSnapshotDocument(
      artifacts,
      references.analyzerProfile,
      reportArtifact
    );
    const catalogSnapshot = await this.#engineeringSnapshotDocument(
      artifacts,
      references.practiceCatalog,
      reportArtifact
    );
    const routePolicySnapshot = await this.#engineeringSnapshotDocument(
      artifacts,
      references.routeQualityPolicy,
      reportArtifact
    );
    const ruleDeckSnapshot = await this.#engineeringSnapshotDocument(
      artifacts,
      references.routeQualityRuleDeck,
      reportArtifact
    );
    const proofPolicySnapshot = await this.#engineeringSnapshotDocument(
      artifacts,
      references.proofFixturePolicy,
      reportArtifact
    );
    let analyzerProfile: PcbPracticeAnalysisProfile;
    let catalog: ReturnType<typeof validateAndSnapshotPcbEngineeringPracticeCatalog>;
    let constraintBinding: ReturnType<typeof validateAndSnapshotEngineeringConstraintBinding> | null = null;
    try {
      analyzerProfile = validateAndSnapshotPcbPracticeAnalysisProfile(
        analyzerProfileSnapshot.document as unknown as PcbPracticeAnalysisProfile
      );
      catalog = validateAndSnapshotPcbEngineeringPracticeCatalog(catalogSnapshot.document);
      if (
        canonicalJson(canonicalIdentity(analyzerProfile, analyzerProfile.schemaVersion)) !==
          canonicalJson(references.analyzerProfile.canonicalIdentity) ||
        canonicalJson(analyzerProfile) !== canonicalJson(analyzerProfileSnapshot.document) ||
        analyzerProfile.sourceValidation.mode !== "production" ||
        canonicalJson(catalog.identity) !== canonicalJson(references.practiceCatalog.canonicalIdentity) ||
        canonicalJson(catalog) !== canonicalJson(catalogSnapshot.document)
      ) {
        throw new Error("snapshot identity mismatch");
      }
      if (references.engineeringConstraintBinding !== null) {
        const constraintSnapshot = await this.#engineeringSnapshotDocument(
          artifacts,
          references.engineeringConstraintBinding,
          reportArtifact
        );
        constraintBinding = validateAndSnapshotEngineeringConstraintBinding(
          constraintSnapshot.document
        );
        if (
          canonicalJson(constraintBinding) !== canonicalJson(constraintSnapshot.document) ||
          canonicalJson(constraintBinding.identity) !==
            canonicalJson(references.engineeringConstraintBinding.canonicalIdentity) ||
          canonicalJson(constraintBinding.compiledConstraintSetIdentity) !==
            canonicalJson(references.engineeringConstraintBinding.compiledConstraintSetIdentity) ||
          canonicalJson(constraintBinding.catalogIdentity) !== canonicalJson(catalog.identity) ||
          canonicalJson(constraintBinding.catalogSnapshot) !== canonicalJson(catalog)
        ) {
          throw new Error("constraint snapshot mismatch");
        }
      }
    } catch (error) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Bound analyzer profile, practice catalog, or constraint snapshot failed strict validation",
        {
          artifactId: reportArtifact.id,
          causeCode: error instanceof DomainError ? error.code : "SNAPSHOT_VALIDATION_FAILED"
        }
      );
    }
    const routePolicyPreimage = this.#assertEmbeddedSnapshotIdentity(
      routePolicySnapshot.document,
      references.routeQualityPolicy,
      PCB_LAYOUT_QUALITY_POLICY_SCHEMA,
      ["identity", "captureIdentity"]
    );
    const embeddedCapture = contentIdentityValue(routePolicySnapshot.document.captureIdentity);
    if (
      embeddedCapture === undefined ||
      !sameContentIdentity(embeddedCapture, references.routeQualityPolicy.captureIdentity) ||
      !sameContentIdentity(
        contentIdentity(`${canonicalJson(routePolicyPreimage)}\n`),
        references.routeQualityPolicy.captureIdentity
      ) ||
      canonicalJson(routePolicyPreimage.practiceCatalogIdentity) !== canonicalJson(catalog.identity) ||
      canonicalJson(routePolicyPreimage.ruleDeckIdentity) !==
        canonicalJson(references.routeQualityRuleDeck.canonicalIdentity)
    ) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Route-quality policy is detached from its capture, catalog, or rule deck",
        { artifactId: routePolicySnapshot.artifact.id }
      );
    }
    this.#assertEmbeddedSnapshotIdentity(
      ruleDeckSnapshot.document,
      references.routeQualityRuleDeck,
      PCB_ROUTE_QUALITY_RULE_DECK_SCHEMA
    );
    this.#assertEmbeddedSnapshotIdentity(
      proofPolicySnapshot.document,
      references.proofFixturePolicy,
      REV_A_PROOF_FIXTURE_POLICY_SCHEMA
    );
    if (
      canonicalJson(routePolicySnapshot.document) !== canonicalJson(PCB_LAYOUT_QUALITY_POLICY) ||
      canonicalJson(ruleDeckSnapshot.document) !== canonicalJson(PCB_ROUTE_QUALITY_RULE_DECK) ||
      canonicalJson(proofPolicySnapshot.document) !== canonicalJson(REV_A_PROOF_FIXTURE_POLICY)
    ) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Bound PCB policy snapshot differs from the closed policy schema supported by this inspector",
        { artifactId: reportArtifact.id }
      );
    }
    const planBinding = isRecordValue(layoutPlan.document.practiceBinding)
      ? layoutPlan.document.practiceBinding
      : undefined;
    const proofApplicability = isRecordValue(proofPolicySnapshot.document.applicability)
      ? proofPolicySnapshot.document.applicability
      : undefined;
    if (
      layoutPlan.document.schemaVersion !== "evleda.pcb-layout-plan.v2" ||
      layoutPlan.document.lifecycle !== "candidate" ||
      layoutPlan.document.releaseAuthorized !== false ||
      planBinding === undefined ||
      canonicalJson(planBinding.catalogIdentity) !== canonicalJson(catalog.identity) ||
      canonicalJson(planBinding.qualityPolicyIdentity) !==
        canonicalJson(references.routeQualityPolicy.canonicalIdentity) ||
      canonicalJson(planBinding.qualityPolicyCaptureIdentity) !==
        canonicalJson(references.routeQualityPolicy.captureIdentity) ||
      canonicalJson(planBinding.routeQualityRuleDeckIdentity) !==
        canonicalJson(references.routeQualityRuleDeck.canonicalIdentity) ||
      proofApplicability === undefined ||
      proofApplicability.profileId !== layoutPlan.document.profileId ||
      proofApplicability.boardRevision !== layoutPlan.document.boardRevision ||
      proofApplicability.purpose !== "proof_fixture_diagnostics_only" ||
      proofApplicability.transferableToOtherProfiles !== false
    ) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Layout plan and proof-fixture policy do not bind the exact catalog and route policies",
        { artifactId: layoutPlan.artifact.id }
      );
    }
    const recomputedAnalysis = analyzeKicadPcbPractices(
      boardBytes,
      analyzerProfile,
      { sourcePath: boardArtifact.logicalName }
    );
    const analysisIdentity = canonicalIdentity(
      recomputedAnalysis,
      recomputedAnalysis.schemaVersion
    );
    const suppliedAnalysisIdentity = canonicalIdentityValue(payload.analysisIdentity);
    const engineeringSummary = buildKicadPcbEngineeringDecisionSummary(
      recomputedAnalysis,
      constraintBinding
    );
    const expectedStatus = engineeringSummary.machine.status === "pass" ? "pass" : "fail";
    if (
      suppliedAnalysisIdentity === undefined ||
      canonicalJson(suppliedAnalysisIdentity) !== canonicalJson(analysisIdentity) ||
      canonicalJson(payload.analysis) !== canonicalJson(recomputedAnalysis) ||
      canonicalJson(payload.engineeringSummary) !== canonicalJson(engineeringSummary) ||
      reportArtifact.validationStatus !== expectedStatus ||
      reportEntry.validationStatus !== expectedStatus
    ) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "PCB-practice analysis or decision summary does not reproduce from the exact board and snapshots",
        { artifactId: reportArtifact.id }
      );
    }
    const boundArtifactIds = new Set(
      inputBindings
        .filter((binding) => binding.kind !== "source")
        .map((binding) => {
          const candidates = artifacts.filter(
            (artifact) =>
              artifact.logicalName === binding.logicalName &&
              sameContentIdentity(artifact.blob, binding.identity)
          );
          if (candidates.length !== 1) {
            throw new DomainError(
              "ARTIFACT_INTEGRITY_ERROR",
              "PCB-practice authority dependency is missing or ambiguous",
              { logicalName: binding.logicalName, candidateCount: candidates.length }
            );
          }
          return candidates[0]!.id;
        })
    );
    if (
      reportArtifact.derivedFrom.length !== boundArtifactIds.size ||
      reportArtifact.derivedFrom.some((artifactId) => !boundArtifactIds.has(artifactId))
    ) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "PCB-practice report derivedFrom set does not match its exact analyzer authority",
        { artifactId: reportArtifact.id }
      );
    }
    const boundArtifactsCurrent = [...boundArtifactIds].every(
      (artifactId) => artifacts.find((artifact) => artifact.id === artifactId)?.staleAt === undefined
    );
    return {
      execution: {
        validationStatus: reportEntry.validationStatus,
        machineStatus:
          engineeringSummary.machine.status === "pass"
            ? "PASS"
            : engineeringSummary.machine.status === "fail"
              ? "FAIL"
              : "UNKNOWN",
        current:
          !selectedIsHeadRevision ||
          (evidenceIsCurrent(reportEntry, this.#now()) &&
            reportArtifact.staleAt === undefined &&
            boundArtifactsCurrent &&
            nativeDrc.execution.current &&
            nativeBoardStatistics.execution.current),
        artifactId: reportArtifact.id,
        evidenceId: reportEntry.id,
        reportIdentity: reportArtifact.blob,
        tool: reportEntry.tool,
        evaluatedAt: reportEntry.createdAt,
        analysis: recomputedAnalysis,
        reviewRequired: engineeringSummary.reviewRequired
      },
      catalog,
      analyzerProfile,
      routeQualityPolicy: routePolicySnapshot.document,
      routeQualityPolicyIdentity: references.routeQualityPolicy.canonicalIdentity,
      routeQualityPolicyCaptureIdentity: references.routeQualityPolicy.captureIdentity,
      routeQualityRuleDeck: ruleDeckSnapshot.document,
      routeQualityRuleDeckIdentity: references.routeQualityRuleDeck.canonicalIdentity,
      proofFixturePolicyIdentity: references.proofFixturePolicy.canonicalIdentity,
      constraintBinding,
      nativeBoard: { artifactId: boardArtifact.id, identity: boardArtifact.blob }
    };
  }

  async #dispatchRaw<Name extends OperationName>(
    operation: Name,
    input: OperationInputByName[Name],
    context: CommandContext
  ): Promise<OperationResult<Name>> {
    let result: unknown;
    switch (operation) {
      case "create_project":
        result = await this.createProject(input as CreateProjectInput, context);
        break;
      case "start_design_run":
        result = await this.startDesignRun(input as StartDesignRunInput, context);
        break;
      case "get_run_status":
        result = await this.getRunStatus(input as GetRunStatusInput);
        break;
      case "inspect_requirements":
        result = await this.inspectRequirements(input as InspectRequirementsInput);
        break;
      case "approve_requirements":
        result = await this.approveRequirements(input as ApproveRequirementsInput, context);
        break;
      case "resume_run":
        result = await this.resumeRun(input as ResumeRunInput, context);
        break;
      case "list_artifacts":
        result = await this.listArtifacts(input as ListArtifactsInput);
        break;
      case "inspect_evidence":
        result = await this.inspectEvidence(input as InspectEvidenceInput);
        break;
      case "inspect_engineering_practices":
        result = await this.inspectEngineeringPractices(
          input as InspectEngineeringPracticesInput
        );
        break;
      case "rerun_stage":
        result = await this.rerunStage(input as RerunStageInput, context);
        break;
      case "export_candidate_bundle":
        result = await this.exportCandidateBundle(input as ExportCandidateBundleInput, context);
        break;
      case "export_prototype_bundle":
        result = await this.exportPrototypeBundle(input as ExportPrototypeBundleInput, context);
        break;
      case "generate_bringup_plan":
        result = await this.generateBringupPlan(input as GenerateBringupPlanInput, context);
        break;
      case "generate_firmware_scaffold":
        result = await this.generateFirmwareScaffold(
          input as GenerateFirmwareScaffoldInput,
          context
        );
        break;
      default:
        throw new DomainError("INVALID_ARGUMENT", "Unknown operation", { operation });
    }
    return result as OperationResult<Name>;
  }

  async #initializeStructure(): Promise<void> {
    if (this.#structurallyInitialized) return;
    if (this.#structuralInitializationPromise !== undefined) {
      return this.#structuralInitializationPromise;
    }

    const attempt = (async (): Promise<void> => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => this.ports.state.initialize()),
        Promise.resolve().then(() => this.ports.content.initialize()),
        Promise.resolve().then(() => mkdir(this.#workspaceRoot, { recursive: true }))
      ]);
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected"
      );
      if (failure !== undefined) throw failure.reason;
      this.#structurallyInitialized = true;
    })();
    this.#structuralInitializationPromise = attempt;
    try {
      await attempt;
    } finally {
      if (this.#structuralInitializationPromise === attempt) {
        this.#structuralInitializationPromise = undefined;
      }
    }
  }

  #auditReconciliationIdentity(state: EvlEdaState): string {
    const tailEvent = state.revision === 0
      ? null
      : state.auditOutbox[String(state.revision)] ?? null;
    return canonicalIdentity(
      {
        stateRevision: state.revision,
        outboxSchemaVersion: state.auditOutboxSchemaVersion ?? null,
        tailEvent
      },
      "evleda.application-audit-reconciliation.v1"
    ).digest;
  }

  #auditSnapshot(state: EvlEdaState): {
    readonly stateRevision: number;
    readonly outboxSchemaVersion?: typeof EVLEDA_AUDIT_OUTBOX_SCHEMA_VERSION;
    readonly outbox: Readonly<Record<string, AuditEvent>>;
  } {
    const outbox = (state as EvlEdaState & {
      readonly auditOutbox?: Readonly<Record<string, AuditEvent>>;
    }).auditOutbox;
    if (outbox === undefined) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Durable state exists without its crash-recovery audit outbox",
        { stateRevision: state.revision }
      );
    }
    return {
      stateRevision: state.revision,
      ...(state.auditOutboxSchemaVersion === undefined
        ? {}
        : { outboxSchemaVersion: state.auditOutboxSchemaVersion }),
      outbox
    };
  }

  async #repairAndVerifyAudit(): Promise<EvlEdaState> {
    const audit = this.ports.audit;
    const preliminaryState = await this.ports.state.read();
    if (audit === undefined) return preliminaryState;
    const preliminaryIdentity = this.#auditReconciliationIdentity(preliminaryState);
    const operationScope = this.#operationScope.getStore();
    if (preliminaryIdentity === operationScope?.auditReconciliationIdentity) {
      return preliminaryState;
    }

    const attempt = (async (): Promise<EvlEdaState> => {
      for (;;) {
        let drainedIdentity: string | undefined;
        await audit.drain(async () => {
          // Load under the audit implementation's cross-process exclusion boundary. A
          // preliminary snapshot is only a skip hint and is never used as drain authority.
          const currentState = await this.ports.state.read();
          drainedIdentity = this.#auditReconciliationIdentity(currentState);
          return this.#auditSnapshot(currentState);
        });
        if (drainedIdentity === undefined) {
          throw new Error("Audit reconciliation completed without a state identity");
        }
        // A different process can commit after the drain snapshot but before the drain
        // returns. Do not let the flight owner proceed against that unaudited revision.
        const postDrainState = await this.ports.state.read();
        if (this.#auditReconciliationIdentity(postDrainState) === drainedIdentity) {
          return postDrainState;
        }
      }
    })();
    const reconciledState = await attempt;
    if (operationScope !== undefined) {
      operationScope.auditReconciliationIdentity = this.#auditReconciliationIdentity(
        reconciledState
      );
    }
    return reconciledState;
  }

  #installOperationTracking(): void {
    const instance = this as unknown as Record<string, unknown>;
    for (const methodName of TRACKED_APPLICATION_METHODS) {
      const original = instance[methodName];
      if (typeof original !== "function") {
        throw new Error(`Application operation ${methodName} is not callable`);
      }
      Object.defineProperty(instance, methodName, {
        configurable: false,
        enumerable: false,
        writable: false,
        value: (...args: readonly unknown[]) => this.#trackOperation(
          () => Reflect.apply(original, this, args) as Promise<unknown>
        )
      });
    }
  }

  #trackOperation<Result>(operation: () => Promise<Result>): Promise<Result> {
    if (!this.#acceptingOperations) {
      return Promise.reject(new ApplicationServiceClosedError());
    }
    const token = Symbol("application-operation");
    this.#activeOperations.add(token);
    let result: Promise<Result>;
    try {
      // Always create a fresh admission scope. Internal application calls use private
      // helpers, so inherited async resources can never masquerade as the original call.
      result = this.#operationScope.run({}, operation);
    } catch (error) {
      this.#completeOperation(token);
      return Promise.reject(error);
    }
    return Promise.resolve(result).finally(() => this.#completeOperation(token));
  }

  #completeOperation(token: symbol): void {
    if (!this.#activeOperations.delete(token) || this.#activeOperations.size !== 0) return;
    for (const resolve of [...this.#idleWaiters]) resolve();
  }

  async #transaction<Result>(
    context: CommandContext,
    audit: TransitionAuditFactory<Result>,
    mutate: (state: MutableEvlEdaState) => Result | Promise<Result>,
    relayCommittedFailure = false
  ): Promise<{ readonly state: EvlEdaState; readonly result: Result }> {
    let committed;
    try {
      committed = await this.ports.state.transaction(undefined, async (state) => {
        const result = await mutate(state);
        const stateRevision = state.revision + 1;
        const details = audit(result, state);
        const withOutbox = state as MutableEvlEdaState & {
          auditOutboxSchemaVersion?: typeof EVLEDA_AUDIT_OUTBOX_SCHEMA_VERSION;
          auditOutbox?: Record<string, AuditEvent>;
        };
        const outbox = withOutbox.auditOutbox ?? {};
        if (state.revision === 0 && withOutbox.auditOutboxSchemaVersion === undefined) {
          withOutbox.auditOutboxSchemaVersion = EVLEDA_AUDIT_OUTBOX_SCHEMA_VERSION;
        }
        if (outbox[String(stateRevision)] !== undefined) {
          throw new DomainError(
            "ARTIFACT_INTEGRITY_ERROR",
            "Audit outbox already contains the next state revision",
            { stateRevision }
          );
        }
        outbox[String(stateRevision)] = this.#auditEvent(
          details.type,
          context,
          stateRevision,
          details.payload,
          details.projectId,
          details.runId,
          details.subjectDigest
        );
        withOutbox.auditOutbox = outbox;
        return result;
      });
    } catch (error) {
      if (!isCommittedStateTransactionError(error)) throw error;
      let stateMaintenanceRepaired = true;
      try {
        await error.repairMaintenance();
      } catch {
        stateMaintenanceRepaired = false;
      }
      if (!stateMaintenanceRepaired) {
        if (relayCommittedFailure) throw new StageCommitFailureRelay(error);
        throw error;
      }
      try {
        await this.#repairAndVerifyAudit();
        error.recordAuditRepair("succeeded");
      } catch (auditRepairFailure) {
        error.recordAuditRepair("failed", auditRepairFailure);
      }
      if (relayCommittedFailure) throw new StageCommitFailureRelay(error);
      throw error;
    }
    try {
      await this.#repairAndVerifyAudit();
    } catch (auditDeliveryFailure) {
      const error = new AuthenticCommittedAuditDeliveryError(
        committed,
        auditDeliveryFailure,
        async () => {
          await this.#repairAndVerifyAudit();
        }
      );
      try {
        await error.repairMaintenance();
        error.recordAuditRepair("succeeded");
      } catch (auditRepairFailure) {
        error.recordAuditRepair("failed", auditRepairFailure);
      }
      if (relayCommittedFailure) throw new StageCommitFailureRelay(error);
      throw error;
    }
    return committed;
  }

  #auditEvent(
    type: string,
    context: CommandContext,
    stateRevision: number,
    payload: Readonly<Record<string, unknown>>,
    projectId?: string,
    runId?: string,
    subjectDigest?: string
  ): AuditEvent {
    const actorType = context.kind === "human" ? "human" : context.kind === "mcp" ? "model" : "system";
    const actorId = context.kind === "human" ? context.actor.id : context.kind === "mcp" ? "mcp-client" : "evleda";
    return {
      eventSchemaVersion: EVLEDA_AUDIT_EVENT_SCHEMA_VERSION,
      type,
      actorType,
      actorId,
      ...(projectId === undefined ? {} : { projectId }),
      ...(runId === undefined ? {} : { runId }),
      ...(subjectDigest === undefined ? {} : { subjectDigest }),
      occurredAt: this.#timestamp(),
      payload: { ...payload, stateRevision }
    };
  }

  async #idempotentMutation<Result>(
    operation: DurableOperationName,
    input: { readonly idempotencyKey: string },
    context: CommandContext,
    audit: TransitionAuditFactory<Result>,
    mutate: (state: MutableEvlEdaState) => Result | Promise<Result>
  ): Promise<MutationResult<Result>> {
    const snapshot = await this.#repairAndVerifyAudit();
    const requestDigest = this.#requestDigest(operation, input);
    const replay = this.#findIdempotencyRecord(
      snapshot.idempotency,
      operation,
      input,
      requestDigest
    );
    if (replay !== undefined) {
      const reconciledState = await this.#repairAndVerifyAudit();
      return {
        state: reconciledState,
        result: replay.record.result as Result,
        committed: false
      };
    }
    try {
      const committed = await this.#transaction(
        context,
        audit,
        async (state) => {
        const idempotency = recordMap<IdempotencyRecord>(state.idempotency);
        const existing = this.#findIdempotencyRecord(
          idempotency,
          operation,
          input,
          requestDigest
        );
        if (existing !== undefined) {
          throw new IdempotencyReplay(existing.record.result);
        }
        const result = await mutate(state);
        idempotency[this.#idempotencyStorageKey(operation, input.idempotencyKey)] = {
          key: input.idempotencyKey,
          requestDigest,
          operation,
          result,
          createdAt: this.#timestamp()
        };
          return result;
        }
      );
      return { ...committed, committed: true };
    } catch (error) {
      if (error instanceof IdempotencyReplay) {
        const reconciledState = await this.#repairAndVerifyAudit();
        return {
          state: reconciledState,
          result: error.result as Result,
          committed: false
        };
      }
      throw error;
    }
  }

  #idempotencyResult(
    state: EvlEdaState,
    operation: DurableOperationName,
    input: { readonly idempotencyKey: string }
  ): unknown | undefined {
    return this.#findIdempotencyRecord(
      state.idempotency,
      operation,
      input,
      this.#requestDigest(operation, input)
    )?.record.result;
  }

  async #withRunExecutionLease<Result>(
    runId: string,
    work: () => Promise<Result>
  ): Promise<Result> {
    const release = await acquireRunExecutionLease(this.ports.state.root, runId);
    try {
      return await work();
    } finally {
      await release();
    }
  }

  #pendingRunExecutions(
    state: EvlEdaState,
    runId: string
  ): readonly { readonly storageKey: string; readonly record: IdempotencyRecord }[] {
    return Object.entries(state.idempotency).flatMap(([storageKey, value]) => {
      const parsed = this.#parseRunExecutionIdempotencyRecord(storageKey, value);
      return parsed?.result.status === "pending" && parsed.result.runId === runId
        ? [{ storageKey, record: parsed.record }]
        : [];
    });
  }

  #parseRunExecutionIdempotencyRecord(
    storageKey: string,
    value: unknown
  ):
    | {
        readonly record: IdempotencyRecord;
        readonly result: Readonly<Record<string, unknown>> & {
          readonly status: "pending" | "completed";
          readonly runId: string;
        };
      }
    | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "The idempotency map contains an invalid record",
        { storageKey }
      );
    }
    const candidate = value as Partial<IdempotencyRecord>;
    if (candidate.operation !== "resume_run" && candidate.operation !== "rerun_stage") {
      return undefined;
    }
    if (
      typeof candidate.key !== "string" ||
      typeof candidate.requestDigest !== "string" ||
      typeof candidate.createdAt !== "string"
    ) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "A run execution idempotency record has an invalid durable schema",
        { storageKey, operation: candidate.operation }
      );
    }
    this.#validateIdempotencyRecord(
      value,
      candidate.operation,
      candidate.requestDigest,
      candidate.key
    );
    const expectedStorageKey = this.#idempotencyStorageKey(candidate.operation, candidate.key);
    if (storageKey !== expectedStorageKey && storageKey !== candidate.key) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "A run execution idempotency record is stored under the wrong scope",
        { storageKey, operation: candidate.operation }
      );
    }
    const result = candidate.result;
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "A run execution idempotency result has an invalid durable schema",
        { operation: candidate.operation }
      );
    }
    const fields = Object.keys(result).sort((left, right) => left.localeCompare(right, "en"));
    const hasFields = (...expected: readonly string[]): boolean =>
      canonicalJson(fields) === canonicalJson([...expected].sort((left, right) => left.localeCompare(right, "en")));
    if (!("status" in result) || (result.status !== "pending" && result.status !== "completed")) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "A run execution idempotency result has an invalid status",
        { operation: candidate.operation }
      );
    }
    if (!("runId" in result) || typeof result.runId !== "string") {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "A run execution idempotency result has an invalid run identity",
        { operation: candidate.operation }
      );
    }
    if (candidate.operation === "resume_run") {
      if (!hasFields("runId", "status")) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "A resume idempotency result has unexpected fields",
          { operation: candidate.operation }
        );
      }
    } else {
      const stageIsValid =
        "stage" in result &&
        typeof result.stage === "string" &&
        result.stage !== "requirements" &&
        STAGE_ORDER.includes(result.stage as StageKey);
      const reserved =
        result.status === "pending" &&
        "phase" in result &&
        result.phase === "reserved" &&
        hasFields("phase", "runId", "stage", "status");
      const prepared =
        result.status === "pending" &&
        "phase" in result &&
        result.phase === "prepared" &&
        "baseRevisionId" in result &&
        (result.baseRevisionId === null || typeof result.baseRevisionId === "string") &&
        hasFields("baseRevisionId", "phase", "runId", "stage", "status");
      const completed =
        result.status === "completed" && hasFields("runId", "stage", "status");
      if (!stageIsValid || (!reserved && !prepared && !completed)) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "A rerun idempotency result has an invalid durable schema",
          { operation: candidate.operation }
        );
      }
    }
    return {
      record: value as IdempotencyRecord,
      result: result as Readonly<Record<string, unknown>> & {
        readonly status: "pending" | "completed";
        readonly runId: string;
      }
    };
  }

  #assertNoPendingRunExecution(state: EvlEdaState, runId: string): void {
    const pending = this.#pendingRunExecutions(state, runId);
    if (pending.length === 0) {
      return;
    }
    if (pending.length > 1) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "The design run has conflicting pending execution commands",
        { runId, pendingCount: pending.length }
      );
    }
    throw new DomainError(
      "STAGE_ALREADY_RUNNING",
      "This design run has an unfinished execution command",
      { runId, operation: pending[0]!.record.operation },
      true
    );
  }

  #runExecutionReplay(
    state: EvlEdaState,
    operation: "resume_run" | "rerun_stage",
    input: ResumeRunInput | RerunStageInput,
    runId: string
  ):
    | {
        readonly storageKey: string;
        readonly record: IdempotencyRecord;
        readonly result: Readonly<Record<string, unknown>> & {
          readonly status: "pending" | "completed";
          readonly runId: string;
        };
      }
    | undefined {
    const current = this.#findIdempotencyRecord(
      state.idempotency,
      operation,
      input,
      this.#requestDigest(operation, input)
    );
    if (current === undefined) {
      return undefined;
    }
    const parsed = this.#parseRunExecutionIdempotencyRecord(current.storageKey, current.record);
    if (parsed === undefined || parsed.result.runId !== runId) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "The run execution replay record does not match the requested run",
        { runId, operation }
      );
    }
    if (
      operation === "rerun_stage" &&
      (!("stage" in parsed.result) || parsed.result.stage !== (input as RerunStageInput).stage)
    ) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "The rerun replay record does not match the requested stage",
        { runId, operation, stage: (input as RerunStageInput).stage }
      );
    }
    return { storageKey: current.storageKey, record: parsed.record, result: parsed.result };
  }

  #assertPendingRunExecutionReplay(
    state: EvlEdaState,
    operation: "resume_run" | "rerun_stage",
    input: ResumeRunInput | RerunStageInput,
    runId: string
  ): void {
    const current = this.#runExecutionReplay(state, operation, input, runId);
    if (current === undefined || current.result.status !== "pending") {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "The pending run execution replay record is invalid",
        { runId, operation }
      );
    }
    const pending = this.#pendingRunExecutions(state, runId);
    if (pending.length !== 1 || pending[0]!.storageKey !== current.storageKey) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "The design run has conflicting pending execution commands",
        { runId, operation, pendingCount: pending.length }
      );
    }
  }

  #idempotencyStorageKey(operation: DurableOperationName, idempotencyKey: string): string {
    const scope = canonicalIdentity(
      { operation, idempotencyKey },
      "evleda.idempotency-scope.v1"
    );
    return `idempotency_scope_${scope.digest}`;
  }

  #findIdempotencyRecord(
    records: Readonly<Record<string, IdempotencyRecord>>,
    operation: DurableOperationName,
    input: { readonly idempotencyKey: string },
    requestDigest: string
  ): IdempotencyLookup | undefined {
    const storageKey = this.#idempotencyStorageKey(operation, input.idempotencyKey);
    const scoped = records[storageKey];
    if (scoped !== undefined) {
      this.#validateIdempotencyRecord(
        scoped,
        operation,
        requestDigest,
        input.idempotencyKey
      );
      return { storageKey, record: scoped };
    }

    const legacy = records[input.idempotencyKey];
    if (
      typeof legacy !== "object" ||
      legacy === null ||
      legacy.key !== input.idempotencyKey ||
      legacy.operation !== operation
    ) {
      return undefined;
    }
    this.#validateIdempotencyRecord(
      legacy,
      operation,
      requestDigest,
      input.idempotencyKey
    );
    return {
      storageKey: input.idempotencyKey,
      record: legacy
    };
  }

  #validateIdempotencyRecord(
    existing: unknown,
    operation: DurableOperationName,
    requestDigest: string,
    idempotencyKey: string
  ): asserts existing is IdempotencyRecord {
    if (
      typeof existing !== "object" ||
      existing === null ||
      !("key" in existing) ||
      typeof existing.key !== "string" ||
      !("operation" in existing) ||
      typeof existing.operation !== "string" ||
      !("requestDigest" in existing) ||
      typeof existing.requestDigest !== "string" ||
      !/^[0-9a-f]{64}$/u.test(existing.requestDigest) ||
      !("createdAt" in existing) ||
      typeof existing.createdAt !== "string" ||
      !("result" in existing)
    ) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Stored idempotency record has an invalid durable schema",
        { operation }
      );
    }
    if (
      existing.key !== idempotencyKey ||
      existing.operation !== operation ||
      existing.requestDigest !== requestDigest
    ) {
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "Idempotency key was already used for a different canonical request",
        {
          key: existing.key,
          existingOperation: existing.operation,
          requestedOperation: operation
        }
      );
    }
  }

  #requestDigest(operation: DurableOperationName, input: object): string {
    return canonicalIdentity(
      { operation, input: withoutIdempotencyKey(input) },
      "evleda.application-command.v1"
    ).digest;
  }

  async #reserveIdempotentOperation(
    operation: OperationName,
    input: { readonly idempotencyKey: string },
    result: Readonly<Record<string, unknown>>,
    context: CommandContext,
    auditSubject: TransitionAuditSubject,
    validate?: (state: EvlEdaState) => void
  ): Promise<EvlEdaState> {
    const requestDigest = this.#requestDigest(operation, input);
    const snapshot = await this.#repairAndVerifyAudit();
    const existing = this.#findIdempotencyRecord(
      snapshot.idempotency,
      operation,
      input,
      requestDigest
    );
    if (existing !== undefined) {
      return this.#repairAndVerifyAudit();
    }
    let committed;
    try {
      committed = await this.#transaction<void>(
        context,
        () => ({
          type: `command.${operation}.reserved`,
          payload: { operation },
          ...auditSubject
        }),
        (state) => {
          const idempotency = recordMap<IdempotencyRecord>(state.idempotency);
          const concurrent = this.#findIdempotencyRecord(
            idempotency,
            operation,
            input,
            requestDigest
          );
          if (concurrent !== undefined) {
            throw new IdempotencyReplay(concurrent.record.result);
          }
          validate?.(state as unknown as EvlEdaState);
          idempotency[this.#idempotencyStorageKey(operation, input.idempotencyKey)] = {
            key: input.idempotencyKey,
            requestDigest,
            operation,
            result,
            createdAt: this.#timestamp()
          };
        }
      );
    } catch (error) {
      if (error instanceof IdempotencyReplay) {
        return this.#repairAndVerifyAudit();
      }
      throw error;
    }
    return committed.state;
  }

  async #completeReservedOperation(
    operation: OperationName,
    input: { readonly idempotencyKey: string },
    result: Readonly<Record<string, unknown>>,
    context: CommandContext,
    auditType: string,
    runId: string
  ): Promise<EvlEdaState> {
    const requestDigest = this.#requestDigest(operation, input);
    const snapshot = await this.#repairAndVerifyAudit();
    const existing = this.#findIdempotencyRecord(
      snapshot.idempotency,
      operation,
      input,
      requestDigest
    );
    if (existing === undefined) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Reserved idempotency record is missing",
        { operation }
      );
    }
    if (
      typeof existing.record.result === "object" &&
      existing.record.result !== null &&
      "status" in existing.record.result &&
      existing.record.result.status === "completed"
    ) {
      return this.#repairAndVerifyAudit();
    }
    const committed = await this.#transaction<void>(
      context,
      (_result, mutable) => {
        const state = mutable as unknown as EvlEdaState;
        const committedRun = this.#run(state, runId);
        const subjectDigest = committedRun.headRevisionId === undefined
          ? committedRun.requirements?.identity.digest
          : this.#revision(state, committedRun.headRevisionId).manifest.digest;
        return {
          type: auditType,
          payload: { operation },
          projectId: committedRun.projectId,
          runId: committedRun.id,
          ...(subjectDigest === undefined ? {} : { subjectDigest })
        };
      },
      (state) => {
        const idempotency = recordMap<IdempotencyRecord>(state.idempotency);
        const current = this.#findIdempotencyRecord(
          idempotency,
          operation,
          input,
          requestDigest
        );
        if (current === undefined) {
          throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Reserved operation disappeared");
        }
        idempotency[current.storageKey] = { ...current.record, result };
      }
    );
    return committed.state;
  }

  async #recordIdempotency(
    operation: OperationName,
    input: { readonly idempotencyKey: string },
    result: unknown,
    context: CommandContext,
    auditType: string,
    runId: string
  ): Promise<EvlEdaState> {
    const snapshot = await this.#repairAndVerifyAudit();
    if (this.#idempotencyResult(snapshot, operation, input) !== undefined) {
      return this.#repairAndVerifyAudit();
    }
    const requestDigest = this.#requestDigest(operation, input);
    let committed: { readonly state: EvlEdaState; readonly result: undefined };
    try {
      committed = await this.#transaction<undefined>(
        context,
        (_result, mutable) => {
          const state = mutable as unknown as EvlEdaState;
          const run = this.#run(state, runId);
          const subjectDigest = run.headRevisionId === undefined
            ? run.requirements?.identity.digest
            : this.#revision(state, run.headRevisionId).manifest.digest;
          return {
            type: auditType,
            payload: {
              operation,
              idempotencyKeyDigest: contentIdentity(input.idempotencyKey).digest
            },
            projectId: run.projectId,
            runId: run.id,
            ...(subjectDigest === undefined ? {} : { subjectDigest })
          };
        },
      (state) => {
        const idempotency = recordMap<IdempotencyRecord>(state.idempotency);
        const existing = this.#findIdempotencyRecord(
          idempotency,
          operation,
          input,
          requestDigest
        );
        if (existing !== undefined) {
          throw new IdempotencyReplay(existing.record.result);
        }
        idempotency[this.#idempotencyStorageKey(operation, input.idempotencyKey)] = {
          key: input.idempotencyKey,
          requestDigest,
          operation,
          result,
          createdAt: this.#timestamp()
        };
          return undefined;
        }
      );
    } catch (error) {
      if (error instanceof IdempotencyReplay) {
        return this.#repairAndVerifyAudit();
      }
      throw error;
    }
    return committed.state;
  }

  async #setRunState(
    runId: string,
    expectedRevision: number,
    stateValue: DesignRun["state"],
    context: CommandContext,
    auditType: string
  ): Promise<EvlEdaState> {
    const timestamp = this.#timestamp();
    const committed = await this.#transaction<void>(
      context,
      (_result, mutable) => {
        const state = mutable as unknown as EvlEdaState;
        const run = this.#run(state, runId);
        const subjectDigest = run.headRevisionId === undefined
          ? run.requirements?.identity.digest
          : this.#revision(state, run.headRevisionId).manifest.digest;
        return {
          type: auditType,
          payload: { state: stateValue },
          projectId: run.projectId,
          runId: run.id,
          ...(subjectDigest === undefined ? {} : { subjectDigest })
        };
      },
      (state) => {
      const runs = recordMap<DesignRun>(state.runs);
      const run = this.#runFromMutable(runs, runId);
      this.#assertExpectedRevision(run.revision, expectedRevision, "run");
      runs[run.id] = {
        ...run,
        state: stateValue,
        lifecycle: "candidate",
        updatedAt: timestamp,
        revision: run.revision + 1
      };
      }
    );
    return committed.state;
  }

  #project(state: EvlEdaState, projectId: string): Project {
    const project = state.projects[projectId];
    if (project === undefined) {
      throw new DomainError("NOT_FOUND", "Project was not found", { projectId });
    }
    return project;
  }

  #projectFromMutable(projects: Record<string, Project>, projectId: string): Project {
    const project = projects[projectId];
    if (project === undefined) {
      throw new DomainError("NOT_FOUND", "Project was not found", { projectId });
    }
    return project;
  }

  #run(state: EvlEdaState, runId: string): DesignRun {
    const run = state.runs[runId];
    if (run === undefined) {
      throw new DomainError("NOT_FOUND", "Design run was not found", { runId });
    }
    return run;
  }

  #runFromMutable(runs: Record<string, DesignRun>, runId: string): DesignRun {
    const run = runs[runId];
    if (run === undefined) {
      throw new DomainError("NOT_FOUND", "Design run was not found", { runId });
    }
    return run;
  }

  #revision(state: EvlEdaState, revisionId: string): DesignRevision {
    const revision = state.revisions[revisionId];
    if (revision === undefined) {
      throw new DomainError("NOT_FOUND", "Design revision was not found", { revisionId });
    }
    return revision;
  }

  #requirements(run: DesignRun) {
    if (run.requirements === undefined) {
      throw new DomainError("NOT_FOUND", "The run has no parsed requirements", { runId: run.id });
    }
    return run.requirements;
  }

  async #assertRequirementsIntegrity(run: DesignRun) {
    const requirements = this.#requirements(run);
    const { identity, approvalId: _approvalId, ...identityPayload } = requirements;
    const recomputed = canonicalIdentity(identityPayload, requirements.schemaVersion);
    if (
      canonicalJson(identity) !== canonicalJson(recomputed) ||
      !sameContentIdentity(requirements.sourcePrompt, run.sourcePrompt)
    ) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Requirements document does not reproduce its stored identity or source prompt binding",
        { runId: run.id, expected: identity, actual: recomputed }
      );
    }

    const promptBytes = await this.ports.content.get(run.sourcePrompt);
    const actualPromptIdentity = contentIdentity(promptBytes);
    if (!sameContentIdentity(actualPromptIdentity, run.sourcePrompt)) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Stored source prompt bytes do not reproduce the run source identity",
        { runId: run.id, expected: run.sourcePrompt, actual: actualPromptIdentity }
      );
    }
    const prompt = promptBytes.toString("utf8");
    for (const requirement of requirements.requirements) {
      if (requirement.sourceSpans.length === 0) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Requirement is missing its source prompt span",
          { runId: run.id, requirementId: requirement.id }
        );
      }
      for (const span of requirement.sourceSpans) {
        if (
          !Number.isSafeInteger(span.start) ||
          !Number.isSafeInteger(span.end) ||
          span.start < 0 ||
          span.end <= span.start ||
          span.end > prompt.length ||
          prompt.slice(span.start, span.end) !== span.excerpt
        ) {
          throw new DomainError(
            "ARTIFACT_INTEGRITY_ERROR",
            "Requirement source span does not reproduce the bound source prompt",
            { runId: run.id, requirementId: requirement.id, span }
          );
        }
      }
    }
    return requirements;
  }

  #assertExpectedRevision(actual: number, expected: number, resource: string): void {
    if (actual !== expected) {
      throw new DomainError("REVISION_CONFLICT", `${resource} revision is stale`, {
        expectedRevision: expected,
        actualRevision: actual,
        resource
      }, true);
    }
  }

  #assertContextActor(
    context: CommandContext,
    capability:
      | "requirements_approval"
      | "hardware_qualification"
      | "manufacturing_release",
    actor: HumanActor
  ): void {
    assertHumanCapability(
      context.kind === "human" &&
        context.capability === capability &&
        sameActor(context.actor, actor),
      `${capability === "requirements_approval" ? "Requirements approval" : capability === "hardware_qualification" ? "Hardware qualification" : "Manufacturing release"} requires a trusted human capability context matching the attesting actor`,
      { contextKind: context.kind, capability }
    );
  }

  #assertRequirementsApproved(
    state: EvlEdaState,
    run: DesignRun,
    now = this.#now()
  ): ApprovalRecord {
    const requirements = this.#requirements(run);
    const approval = requirements.approvalId === undefined
      ? undefined
      : state.approvals[requirements.approvalId];
    if (
      approval === undefined ||
      approval.kind !== "requirements" ||
      approval.runId !== run.id ||
      approval.projectId !== run.projectId ||
      approval.subjectDigest !== requirements.identity.digest ||
      approval.policyVersion !== this.#policyVersion ||
      approval.actor.type !== "human" ||
      approval.actor.role !== "requirements_reviewer" ||
      approval.revokedAt !== undefined ||
      (approval.expiresAt !== undefined &&
        (!Number.isFinite(Date.parse(approval.expiresAt)) ||
          Date.parse(approval.expiresAt) <= now.getTime()))
    ) {
      throw new DomainError(
        "REQUIREMENTS_NOT_APPROVED",
        "No active human approval binds the exact current requirements digest",
        { runId: run.id, requirementsDigest: requirements.identity.digest }
      );
    }
    return approval;
  }

  #assertRunResumable(run: DesignRun): void {
    if (run.state === "queued" || run.state === "blocked" || run.state === "interrupted") {
      return;
    }
    if (run.state === "running") {
      throw new DomainError(
        "STAGE_ALREADY_RUNNING",
        "A running design run cannot be resumed by another command",
        { runId: run.id, state: run.state },
        true
      );
    }
    throw new DomainError(
      "GATE_FAILED",
      "The design run is not in a resumable state",
      {
        runId: run.id,
        state: run.state,
        allowedStates: ["queued", "blocked", "interrupted"]
      }
    );
  }

  #assertPendingResumeRecoveryState(run: DesignRun): void {
    if (
      run.state === "queued" ||
      run.state === "running" ||
      run.state === "blocked" ||
      run.state === "interrupted" ||
      run.state === "completed"
    ) {
      return;
    }
    throw new DomainError(
      "GATE_FAILED",
      "The pending resume command cannot recover from the current run state",
      { runId: run.id, state: run.state }
    );
  }

  #assertRunRerunnable(run: DesignRun): void {
    if (
      run.state === "queued" ||
      run.state === "blocked" ||
      run.state === "interrupted" ||
      run.state === "completed"
    ) {
      return;
    }
    if (run.state === "running") {
      throw new DomainError(
        "STAGE_ALREADY_RUNNING",
        "A running design run cannot start a rerun command",
        { runId: run.id, state: run.state },
        true
      );
    }
    throw new DomainError(
      "GATE_FAILED",
      "The design run is not in a rerunnable state",
      {
        runId: run.id,
        state: run.state,
        allowedStates: ["queued", "blocked", "interrupted", "completed"]
      }
    );
  }

  #assertPendingRerunRecoveryState(run: DesignRun): void {
    if (
      run.state === "queued" ||
      run.state === "running" ||
      run.state === "blocked" ||
      run.state === "interrupted" ||
      run.state === "completed"
    ) {
      return;
    }
    throw new DomainError(
      "GATE_FAILED",
      "The pending rerun command cannot recover from the current run state",
      { runId: run.id, state: run.state }
    );
  }

  #nextStage(run: DesignRun): StageKey | undefined {
    return STAGE_ORDER.find(
      (stage) => activeSuccessfulAttempt(run.attempts[stage]) === undefined
    );
  }

  async #status(state: EvlEdaState, runId: string): Promise<RunStatusResult> {
    const run = this.#run(state, runId);
    if (run.requirements !== undefined) {
      await this.#assertRequirementsIntegrity(run);
    }
    const project = this.#project(state, run.projectId);
    const nextStage = this.#nextStage(run);
    const blockedStage = STAGE_ORDER.find((stage) => activeAttempt(run.attempts[stage])?.state === "blocked");
    const currentStage = blockedStage ?? nextStage ?? STAGE_ORDER.at(-1)!;
    const blockers = STAGE_ORDER.flatMap((stage) => {
      const attempt = activeAttempt(run.attempts[stage]);
      if (attempt?.state !== "blocked") {
        return [];
      }
      return attempt.blockers.map((blocker) => ({
        code: blocker.code,
        message: blocker.message,
        stage: blocker.stage,
        requiredAction: blocker.requiredAction,
        retryable: blocker.retryable
      }));
    });
    const headRevision = run.headRevisionId === undefined
      ? undefined
      : this.#revision(state, run.headRevisionId);
    const headEvidence = headRevision === undefined
      ? []
      : this.#evidenceForRevision(state, headRevision);
    const now = this.#now();
    const verifiedPhysical = headRevision === undefined
      ? undefined
      : await this.#passingPhysicalEvidence(state, headRevision, headEvidence, now);
    const runApprovals = Object.values(recordMap<ApprovalRecord>(state.approvals)).filter(
      (approval) => approval.runId === run.id
    );
    const lifecycle = headRevision === undefined
      ? undefined
      : deriveLifecycleDecision(
          headRevision,
          runApprovals,
          headEvidence,
          this.#policyVersion,
          now,
          verifiedPhysical === undefined ? [] : [verifiedPhysical.id]
        );
    const activeByTimeAndPolicy = runApprovals.filter(
      (approval) =>
        approval.revokedAt === undefined &&
        approval.policyVersion === this.#policyVersion &&
        (approval.expiresAt === undefined || new Date(approval.expiresAt).getTime() > now.getTime())
    );
    const activeRequirementsApproval = activeByTimeAndPolicy.some(
      (approval) =>
        approval.kind === "requirements" &&
        approval.actor.role === "requirements_reviewer" &&
        approval.subjectDigest === run.requirements?.identity.digest
    );
    const activeLifecycleIds = new Set(
      activeRequirementsApproval
        ? [
            ...(lifecycle?.activeQualificationIds ?? []),
            ...(lifecycle?.activeReleaseIds ?? [])
          ]
        : []
    );
    const activeAttestations = activeByTimeAndPolicy
      .filter(
        (approval) =>
          (approval.kind === "requirements" &&
            approval.actor.role === "requirements_reviewer" &&
            approval.subjectDigest === run.requirements?.identity.digest) ||
          activeLifecycleIds.has(approval.id) ||
          (approval.kind === "waiver" &&
            headRevision !== undefined &&
            approval.designRevisionId === headRevision.id &&
            approval.subjectDigest === headRevision.manifest.digest)
      )
      .sort((left, right) => left.id.localeCompare(right.id, "en"));
    const effectiveLifecycle = headRevision === undefined || !activeRequirementsApproval
      ? "candidate"
      : lifecycle!.state;
    return {
      project,
      run,
      ...(headRevision === undefined ? {} : { headRevision }),
      currentStage,
      ...(nextStage === undefined ? {} : { nextStage }),
      blockers,
      effectiveLifecycle,
      activeAttestations,
      stateRevision: state.revision
    };
  }

  async #executeStage(
    runId: string,
    stage: Exclude<StageKey, "requirements">,
    context: CommandContext
  ): Promise<"succeeded" | "blocked"> {
    const snapshot = await this.#repairAndVerifyAudit();
    const run = this.#run(snapshot, runId);
    const project = this.#project(snapshot, run.projectId);
    const requirements = this.#requirements(run);
    const approval = this.#assertRequirementsApproved(snapshot, run);
    if (run.headRevisionId === undefined) {
      throw new DomainError(
        "REQUIREMENTS_NOT_APPROVED",
        "Approved requirements revision is missing",
        { runId }
      );
    }
    const headRevision = this.#revision(snapshot, run.headRevisionId);
    if (project.headRevisionId === undefined) {
      throw new DomainError("REVISION_CONFLICT", "Project head revision is missing", {
        projectId: project.id,
        runId
      });
    }
    const projectHeadRevisionId = project.headRevisionId;
    const provisionRequest = this.#stageProvisionRequest(project, run, headRevision, stage);
    const reconstructedUpstream = await this.#reconstructUpstream(snapshot, run, stage);
    const upstream = reconstructedUpstream.results;
    const upstreamSourceRevisionBindings = reconstructedUpstream.sourceRevisionBindings;
    let provision: StageContextProvision;
    let provisioningBlocker:
      | {
          readonly code: string;
          readonly message: string;
          readonly requiredAction: string;
        }
      | undefined;
    if (this.ports.stageContext === undefined) {
      provision = this.#unavailableProvision(provisionRequest, "unconfigured");
    } else {
      try {
        provision = await this.ports.stageContext.provide({
          project,
          run,
          revision: headRevision,
          stage
        });
        this.#assertStageProvision(provision, provisionRequest);
      } catch (error) {
        const domain = error instanceof DomainError ? error : undefined;
        const code = domain?.code ?? "TOOLCHAIN_UNAVAILABLE";
        provision = this.#unavailableProvision(provisionRequest, "failed", code);
        provisioningBlocker = {
          code,
          message:
            domain?.message ?? `Stage context provisioning failed for ${stage}.`,
          requiredAction:
            "Repair or refresh the pinned stage provisioning inputs and retry the blocked stage."
        };
      }
    }
    this.#assertStageProvision(provision, provisionRequest);
    const { provisionIdentity, provisionManifest, ...enrichment } = provision;
    const provisionManifestBytes = Buffer.from(`${canonicalJson(provisionManifest)}\n`, "utf8");
    const provisionManifestBlob = await this.ports.content.put(provisionManifestBytes);
    const inputManifest = canonicalIdentity(
      {
        schemaVersion: "evleda.stage-input.v1",
        projectId: run.projectId,
        runId: run.id,
        stage,
        requirements: requirements.identity,
        requirementsApproval: {
          id: approval.id,
          subjectDigest: approval.subjectDigest,
          policyVersion: approval.policyVersion
        },
        headRevision: headRevision.manifest,
        upstream: upstream.map((result) => ({
          stage: result.stage,
          outputIdentity: result.outputIdentity
        })),
        upstreamSourceRevisionBindings: upstreamSourceRevisionBindings.map((binding) => ({
          stage: binding.stage,
          identity: binding.identity
        })),
        provisionIdentity,
        provisionManifestBlob,
        configuration: run.configuration,
        workflowVersion: run.workflowVersion
      },
      `evleda.stage-input.${stage}.v1`
    );
    const attemptId = this.#id("attempt");
    const previousAttempts = run.attempts[stage];
    const attemptNumber = Math.max(0, ...previousAttempts.map((attempt) => attempt.attemptNumber)) + 1;
    const fencingEpoch = Math.max(0, ...previousAttempts.map((attempt) => attempt.fencingEpoch)) + 1;
    const startedAt = this.#timestamp();
    const start = await this.#transaction<StageAttempt>(
      context,
      (result) => ({
        type: "stage.started",
        projectId: run.projectId,
        runId: run.id,
        subjectDigest: inputManifest.digest,
        payload: {
          stage,
          attemptId: result.id,
          attemptNumber: result.attemptNumber,
          inputManifest,
          provisionIdentity,
          provisionManifestBlob
        }
      }),
      (mutable) => {
      const projects = recordMap<Project>(mutable.projects);
      const runs = recordMap<DesignRun>(mutable.runs);
      const current = this.#runFromMutable(runs, run.id);
      this.#assertExpectedRevision(current.revision, run.revision, "run");
      const currentProject = this.#projectFromMutable(projects, project.id);
      this.#assertExpectedRevision(currentProject.revision, project.revision, "project");
      if (
        current.headRevisionId !== headRevision.id ||
        currentProject.headRevisionId !== projectHeadRevisionId
      ) {
        throw new DomainError(
          "REVISION_CONFLICT",
          "Stage input head changed during context provisioning",
          { runId: run.id, stage },
          true
        );
      }
      const attempts = { ...current.attempts } as Record<StageKey, readonly StageAttempt[]>;
      const recovered = attempts[stage].map((attempt) =>
        attempt.state === "running"
          ? {
              ...attempt,
              state: "interrupted" as const,
              completedAt: startedAt,
              blockers: [
                ...attempt.blockers,
                {
                  code: "INTERRUPTED_ATTEMPT_RECOVERED",
                  message: "A previously running attempt had no active executor and was interrupted.",
                  stage,
                  affectedInputDigests: [attempt.inputManifest.digest],
                  requiredAction: "Review the interruption and continue with the appended attempt.",
                  retryable: true,
                  createdAt: startedAt
                }
              ]
            }
          : attempt
      );
      const attempt: StageAttempt = {
        id: attemptId,
        stage,
        attemptNumber,
        state: "running",
        inputManifest,
        provisionIdentity,
        provisionManifestBlob,
        executionFence: {
          inputManifest,
          parentRevisionId: headRevision.id,
          parentRevisionManifest: headRevision.manifest,
          projectHeadRevisionId,
          requirementsApprovalId: approval.id,
          requirementsApprovalDigest: approval.subjectDigest
        },
        artifactIds: [],
        evidenceIds: [],
        blockers: [],
        startedAt,
        fencingEpoch
      };
      attempts[stage] = [...recovered, attempt];
      runs[current.id] = {
        ...current,
        attempts,
        state: "running",
        lifecycle: "candidate",
        updatedAt: startedAt,
        revision: current.revision + 1
      };
        return attempt;
      }
    );
    const baseCandidateContext: CandidateStageContext = {
      projectId: run.projectId,
      runId: run.id,
      designRevisionId: headRevision.id,
      requirements,
      requirementsApproval: approval,
      upstream,
      upstreamSourceRevisionBindings
    };
    let result: StageExecutionResult;
    if (provisioningBlocker !== undefined) {
      return await this.#blockStage(
        run.id,
        stage,
        attemptId,
        [
          {
            ...provisioningBlocker,
            stage,
            affectedInputDigests: [inputManifest.digest, provisionIdentity.digest],
            retryable: true,
            createdAt: this.#timestamp()
          }
        ],
        context
      );
    }
    if (this.ports.stages === undefined || !this.ports.stages.has(stage)) {
      return await this.#blockStage(
        run.id,
        stage,
        attemptId,
        [
          {
            code: "TOOLCHAIN_UNAVAILABLE",
            message: `No executor is registered for ${stage}.`,
            stage,
            affectedInputDigests: [inputManifest.digest],
            requiredAction: `Configure the ${stage} executor and resume this run.`,
            retryable: true,
            createdAt: this.#timestamp()
          }
        ],
        context
      );
    }
    try {
      const candidateContext: CandidateStageContext = {
        ...enrichment,
        ...baseCandidateContext
      };
      result = await this.ports.stages.execute(stage, candidateContext);
      // Freeze the complete returned value, including every byte buffer, before any
      // validation or persistence await can expose it to caller-owned mutation.
      result = structuredClone(result);
    } catch (error) {
      const domain = error instanceof DomainError ? error : undefined;
      return this.#blockStage(
        run.id,
        stage,
        attemptId,
        [
          {
            code: domain?.code ?? "TOOL_RESULT_INCONCLUSIVE",
            message: domain?.message ?? "Stage executor failed without a conclusive result.",
            stage,
            affectedInputDigests: [inputManifest.digest],
            requiredAction: "Inspect the tool failure, correct the cause, and rerun the stage.",
            retryable: domain?.retryable ?? true,
            createdAt: this.#timestamp()
          }
        ],
        context
      );
    }

    const validationBlockers = this.#validateStageResult(stage, result, inputManifest);
    if (validationBlockers.length > 0 || result.executionStatus === "blocked") {
      const declared = result.blockers.map((blocker) => ({
        ...blocker,
        stage,
        createdAt: this.#timestamp()
      }));
      return this.#blockStage(
        run.id,
        stage,
        attemptId,
        [...declared, ...validationBlockers],
        context,
        this.#stageOutputIdentityMatches(result) ? result : undefined
      );
    }

    try {
      return await this.#commitStageResult(
        start.state,
        run.id,
        stage,
        attemptId,
        inputManifest,
        result,
        context
      );
    } catch (error) {
      const committedFailure = takeStageCommitFailure(error);
      if (committedFailure !== undefined) throw committedFailure.cause;
      const domain = error instanceof DomainError ? error : undefined;
      return this.#blockStage(
        run.id,
        stage,
        attemptId,
        [
          {
            code: domain?.code ?? "ARTIFACT_INTEGRITY_ERROR",
            message: domain?.message ?? "Stage outputs could not be committed safely.",
            stage,
            affectedInputDigests: [inputManifest.digest],
            requiredAction: "Inspect stage outputs and rerun with valid immutable artifacts.",
            retryable: domain?.retryable ?? false,
            createdAt: this.#timestamp()
          }
        ],
        context
      );
    }
  }

  #recomputeStageOutputIdentity(result: StageExecutionResult): CanonicalIdentity {
    const payload = {
      schemaVersion: "evleda.stage-result.v1",
      stage: result.stage,
      executionStatus: result.executionStatus,
      artifacts: result.artifacts.map((artifact) => ({
        logicalName: artifact.logicalName,
        mediaType: artifact.mediaType,
        identity: artifact.identity,
        exactInputs: artifact.exactInputs,
        derivedFrom: artifact.derivedFrom,
        tool: artifact.tool,
        validationStatus: artifact.validationStatus,
        unresolvedAssumptions: artifact.unresolvedAssumptions
      })),
      evidence: result.evidence,
      blockers: result.blockers,
      ...(result.requirementsDocument === undefined
        ? {}
        : { requirementsIdentity: result.requirementsDocument.identity })
    };
    return canonicalIdentity(payload, `evleda.stage-result.${result.stage}.v1`);
  }

  #stageOutputIdentityMatches(result: StageExecutionResult): boolean {
    try {
      const recomputed = this.#recomputeStageOutputIdentity(result);
      return canonicalJson(recomputed) === canonicalJson(result.outputIdentity);
    } catch {
      return false;
    }
  }

  #validateStageResult(
    stage: Exclude<StageKey, "requirements">,
    result: StageExecutionResult,
    inputManifest: CanonicalIdentity
  ): readonly Blocker[] {
    const blockers: Blocker[] = [];
    const add = (code: string, message: string, requiredAction: string): void => {
      blockers.push({
        code,
        message,
        stage,
        affectedInputDigests: [inputManifest.digest],
        requiredAction,
        retryable: false,
        createdAt: this.#timestamp()
      });
    };
    if (result.schemaVersion !== "evleda.stage-result.v1" || result.stage !== stage) {
      add(
        "TOOL_RESULT_INCONCLUSIVE",
        "Stage executor returned a mismatched stage or schema version.",
        "Correct the executor contract before retrying."
      );
    }
    if (!this.#stageOutputIdentityMatches(result)) {
      add(
        "DIGEST_MISMATCH",
        "Stage executor output identity does not reproduce the exact returned result manifest.",
        "Correct the executor result canonicalization before retrying."
      );
    }
    if (result.executionStatus === "succeeded" && result.blockers.length > 0) {
      add(
        "TOOL_RESULT_INCONCLUSIVE",
        "Stage executor claimed success while also returning blockers.",
        "Return one unambiguous execution status."
      );
    }
    if (result.executionStatus === "blocked" && result.blockers.length === 0) {
      add(
        "TOOL_RESULT_INCONCLUSIVE",
        "Stage executor reported a blocker without an actionable blocker record.",
        "Return an explicit blocker with affected inputs and required action."
      );
    }
    const logicalNames = new Set<string>();
    for (const artifact of result.artifacts) {
      const normalizedName = artifact.logicalName.toLocaleLowerCase("en-US");
      if (logicalNames.has(normalizedName)) {
        add(
          "ARTIFACT_INTEGRITY_ERROR",
          `Stage output contains duplicate artifact name ${artifact.logicalName}.`,
          "Use unique case-insensitive logical artifact names."
        );
      }
      logicalNames.add(normalizedName);
      if (contentIdentity(artifact.content).digest !== artifact.identity.digest ||
          contentIdentity(artifact.content).size !== artifact.identity.size) {
        add(
          "DIGEST_MISMATCH",
          `Artifact ${artifact.logicalName} bytes do not match its declared identity.`,
          "Regenerate the artifact and its identity from the exact same bytes."
        );
      }
      if (["fail", "error", "stale", "revoked"].includes(artifact.validationStatus)) {
        add(
          "GATE_FAILED",
          `Artifact ${artifact.logicalName} has non-current validation status ${artifact.validationStatus}.`,
          "Resolve the validation failure before committing this stage."
        );
      }
      if (artifact.unresolvedAssumptions.some((assumption) => assumption.severity === "blocking")) {
        add(
          "GATE_FAILED",
          `Artifact ${artifact.logicalName} retains a blocking assumption.`,
          "Resolve the blocking assumption before committing this stage."
        );
      }
    }
    for (const entry of result.evidence) {
      if (["fail", "error", "stale", "revoked"].includes(entry.validationStatus)) {
        add(
          "GATE_FAILED",
          `Evidence claim has non-current validation status ${entry.validationStatus}: ${entry.claim}`,
          "Resolve the failed or stale evidence before committing this stage."
        );
      }
      if (entry.unresolvedAssumptions.some((assumption) => assumption.severity === "blocking")) {
        add(
          "GATE_FAILED",
          `Evidence claim retains a blocking assumption: ${entry.claim}`,
          "Resolve the blocking assumption before committing this stage."
        );
      }
    }
    return blockers;
  }

  async #blockStage(
    runId: string,
    stage: Exclude<StageKey, "requirements">,
    attemptId: string,
    blockers: readonly Blocker[],
    context: CommandContext,
    diagnosticResult?: StageExecutionResult
  ): Promise<"blocked"> {
    const diagnostics =
      diagnosticResult !== undefined &&
      diagnosticResult.stage === stage &&
      this.#stageOutputIdentityMatches(diagnosticResult)
        ? structuredClone(diagnosticResult)
        : undefined;
    const diagnosticArtifacts = diagnostics?.artifacts ?? [];
    const names = new Set<string>();
    let diagnosticsAreSafe = diagnostics !== undefined;
    for (const artifact of diagnosticArtifacts) {
      try {
        this.#safeLogicalPath(artifact.logicalName);
      } catch {
        diagnosticsAreSafe = false;
      }
      const folded = artifact.logicalName.toLocaleLowerCase("en-US");
      const actual = contentIdentity(artifact.content);
      if (
        names.has(folded) ||
        actual.digest !== artifact.identity.digest ||
        actual.size !== artifact.identity.size
      ) {
        diagnosticsAreSafe = false;
      }
      names.add(folded);
    }
    for (const entry of diagnostics?.evidence ?? []) {
      if (
        (entry.rawArtifactLogicalName !== undefined &&
          !names.has(entry.rawArtifactLogicalName.toLocaleLowerCase("en-US"))) ||
        (entry.parsedArtifactLogicalName !== undefined &&
          !names.has(entry.parsedArtifactLogicalName.toLocaleLowerCase("en-US")))
      ) {
        diagnosticsAreSafe = false;
      }
    }
    const persistedResult = diagnosticsAreSafe ? diagnostics : undefined;
    if (persistedResult !== undefined) {
      await Promise.all(
        persistedResult.artifacts.map((artifact) =>
          this.ports.content.put(artifact.content, artifact.identity)
        )
      );
    }
    const artifactIdsByName = new Map<string, string>();
    for (const artifact of persistedResult?.artifacts ?? []) {
      artifactIdsByName.set(
        artifact.logicalName,
        deterministicId("artifact", {
          kind: "blocked-stage-diagnostic",
          runId,
          stage,
          attemptId,
          outputIdentity: persistedResult!.outputIdentity,
          logicalName: artifact.logicalName,
          identity: artifact.identity
        })
      );
    }
    const referencedNames = new Set(
      (persistedResult?.evidence ?? []).flatMap((entry) => [
        ...(entry.rawArtifactLogicalName === undefined ? [] : [entry.rawArtifactLogicalName]),
        ...(entry.parsedArtifactLogicalName === undefined ? [] : [entry.parsedArtifactLogicalName])
      ])
    );
    const syntheticEvidence: EvidenceDraft[] = (persistedResult?.artifacts ?? [])
      .filter((artifact) => !referencedNames.has(artifact.logicalName))
      .map((artifact) => ({
        evidenceClass: "evleda_check",
        claim: `Blocked ${stage} diagnostic artifact ${artifact.logicalName} is retained for review and is not successful-stage evidence.`,
        subjectDigests: uniqueSorted([
          artifact.identity.digest,
          persistedResult!.outputIdentity.digest
        ]),
        rawArtifactLogicalName: artifact.logicalName,
        exactInputs: this.#uniqueIdentities([
          ...artifact.exactInputs,
          persistedResult!.outputIdentity
        ]),
        tool: APPLICATION_TOOL,
        validationStatus: ["fail", "error", "unsupported"].includes(
          artifact.validationStatus
        )
          ? artifact.validationStatus
          : "fail",
        unresolvedAssumptions: artifact.unresolvedAssumptions
      }));
    const blockedSummaryEvidence: readonly EvidenceDraft[] = persistedResult === undefined
      ? []
      : [{
          evidenceClass: "evleda_check",
          claim: `Stage ${stage} did not commit successfully; its retained outputs are diagnostic-only and veto export from this revision.`,
          subjectDigests: uniqueSorted([
            persistedResult.outputIdentity.digest,
            ...persistedResult.artifacts.map((artifact) => artifact.identity.digest)
          ]),
          ...(persistedResult.artifacts[0] === undefined
            ? {}
            : { rawArtifactLogicalName: persistedResult.artifacts[0].logicalName }),
          exactInputs: [persistedResult.outputIdentity],
          tool: APPLICATION_TOOL,
          validationStatus: "fail",
          unresolvedAssumptions: []
        }];
    const diagnosticEvidence = [
      ...(persistedResult?.evidence ?? []),
      ...syntheticEvidence,
      ...blockedSummaryEvidence
    ];
    const evidenceIds = diagnosticEvidence.map((entry, index) =>
      deterministicId("evidence", {
        kind: "blocked-stage-diagnostic",
        runId,
        stage,
        attemptId,
        outputIdentity: persistedResult?.outputIdentity ?? null,
        index,
        claim: entry.claim,
        subjects: entry.subjectDigests
      })
    );
    const timestamp = this.#timestamp();
    await this.#transaction<{
      readonly artifactIds: readonly string[];
      readonly evidenceIds: readonly string[];
      readonly blockers: readonly Blocker[];
    }>(
      context,
      (recorded, mutable) => {
        const run = this.#run(mutable as unknown as EvlEdaState, runId);
        return {
          type: "stage.blocked",
          projectId: run.projectId,
          runId: run.id,
          ...(recorded.blockers[0]?.affectedInputDigests[0] === undefined
            ? {}
            : { subjectDigest: recorded.blockers[0].affectedInputDigests[0] }),
          payload: {
            stage,
            attemptId,
            blockers: recorded.blockers,
            diagnosticArtifactIds: recorded.artifactIds,
            diagnosticEvidenceIds: recorded.evidenceIds,
            outputIdentity: persistedResult?.outputIdentity ?? null
          }
        };
      },
      (mutable) => {
      const runs = recordMap<DesignRun>(mutable.runs);
      const artifacts = recordMap<ArtifactRecord>(mutable.artifacts);
      const evidence = recordMap<EvidenceRecord>(mutable.evidence);
      const run = this.#runFromMutable(runs, runId);
      const attempts = { ...run.attempts } as Record<StageKey, readonly StageAttempt[]>;
      const index = attempts[stage].findIndex((attempt) => attempt.id === attemptId);
      const attempt = attempts[stage][index];
      if (attempt === undefined || attempt.state !== "running") {
        throw new DomainError("REVISION_CONFLICT", "Stage attempt is no longer current", {
          runId,
          stage,
          attemptId
        }, true);
      }
      let parent: DesignRevision | undefined;
      let effectiveBlockers = [...blockers];
      try {
        parent = this.#assertStageAttemptFence(
          mutable as unknown as EvlEdaState,
          run,
          attempt,
          attempt.inputManifest
        );
      } catch (error) {
        effectiveBlockers.push({
          code: "STAGE_EXECUTION_FENCE_CHANGED",
          message: error instanceof Error ? error.message : "Stage execution fence changed.",
          stage,
          affectedInputDigests: [attempt.inputManifest.digest],
          requiredAction: "Discard these outputs and retry from the current head and approval.",
          retryable: true,
          createdAt: timestamp
        });
      }
      const committedArtifactIds: string[] = [];
      const committedEvidenceIds: string[] = [];
      if (parent !== undefined && persistedResult !== undefined) {
        const derivedFromById = new Map<string, readonly string[]>();
        for (const draft of persistedResult.artifacts) {
          const artifactId = artifactIdsByName.get(draft.logicalName)!;
          derivedFromById.set(
            artifactId,
            uniqueSorted(
              draft.derivedFrom.map((reference) => {
                const local = artifactIdsByName.get(reference);
                if (local !== undefined) return local;
                if (parent!.artifactIds.includes(reference) && artifacts[reference] !== undefined) {
                  return reference;
                }
                const upstream = parent!.artifactIds
                  .map((id) => artifacts[id])
                  .find((artifact) =>
                    artifact !== undefined &&
                    artifact.logicalName === reference &&
                    artifact.staleAt === undefined
                  );
                if (upstream === undefined) {
                  throw new DomainError(
                    "ARTIFACT_INTEGRITY_ERROR",
                    "Blocked diagnostic artifact dependency was not found",
                    { stage, attemptId, dependency: reference }
                  );
                }
                return upstream.id;
              })
            )
          );
        }
        for (const draft of persistedResult.artifacts) {
          const artifactId = artifactIdsByName.get(draft.logicalName)!;
          artifacts[artifactId] = {
            id: artifactId,
            projectId: run.projectId,
            runId: run.id,
            designRevisionId: parent.id,
            stage,
            logicalName: draft.logicalName,
            mediaType: draft.mediaType,
            blob: draft.identity,
            exactInputs: this.#uniqueIdentities([
              ...draft.exactInputs,
              attempt.inputManifest,
              persistedResult.outputIdentity
            ]),
            derivedFrom: derivedFromById.get(artifactId)!,
            tool: draft.tool,
            validationStatus: draft.validationStatus,
            unresolvedAssumptions: draft.unresolvedAssumptions,
            lifecycle: "candidate",
            createdAt: timestamp
          };
          committedArtifactIds.push(artifactId);
        }
        for (const [evidenceIndex, draft] of diagnosticEvidence.entries()) {
          const rawArtifactId = draft.rawArtifactLogicalName === undefined
            ? undefined
            : artifactIdsByName.get(draft.rawArtifactLogicalName);
          const parsedArtifactId = draft.parsedArtifactLogicalName === undefined
            ? undefined
            : artifactIdsByName.get(draft.parsedArtifactLogicalName);
          const evidenceId = evidenceIds[evidenceIndex]!;
          evidence[evidenceId] = {
            id: evidenceId,
            projectId: run.projectId,
            runId: run.id,
            designRevisionId: parent.id,
            stage,
            evidenceClass: draft.evidenceClass,
            claim: draft.claim,
            subjectDigests: uniqueSorted(draft.subjectDigests),
            ...(rawArtifactId === undefined ? {} : { rawArtifactId }),
            ...(parsedArtifactId === undefined ? {} : { parsedArtifactId }),
            exactInputs: this.#uniqueIdentities([
              ...draft.exactInputs,
              attempt.inputManifest,
              persistedResult.outputIdentity
            ]),
            tool: draft.tool,
            validationStatus: draft.validationStatus,
            unresolvedAssumptions: draft.unresolvedAssumptions,
            lifecycle: "candidate",
            createdAt: timestamp
          };
          committedEvidenceIds.push(evidenceId);
        }
      }
      const stageAttempts = [...attempts[stage]];
      stageAttempts[index] = {
        ...attempt,
        state: "blocked",
        ...(persistedResult === undefined
          ? {}
          : { outputIdentity: persistedResult.outputIdentity }),
        artifactIds: committedArtifactIds,
        evidenceIds: committedEvidenceIds,
        blockers: effectiveBlockers,
        completedAt: timestamp
      };
      attempts[stage] = stageAttempts;
      runs[run.id] = {
        ...run,
        attempts,
        state: "blocked",
        lifecycle: "candidate",
        updatedAt: timestamp,
        revision: run.revision + 1
      };
        return {
          artifactIds: committedArtifactIds,
          evidenceIds: committedEvidenceIds,
          blockers: effectiveBlockers
        };
      }
    );
    return "blocked";
  }

  async #commitStageResult(
    startState: EvlEdaState,
    runId: string,
    stage: Exclude<StageKey, "requirements">,
    attemptId: string,
    inputManifest: CanonicalIdentity,
    result: StageExecutionResult,
    context: CommandContext
  ): Promise<"succeeded"> {
    if (!this.#stageOutputIdentityMatches(result)) {
      throw new DomainError(
        "DIGEST_MISMATCH",
        "Stage result output identity changed before commit",
        { runId, stage, attemptId }
      );
    }
    const startedRun = this.#run(startState, runId);
    const startedAttempt = startedRun.attempts[stage].find((attempt) => attempt.id === attemptId);
    if (startedAttempt === undefined) {
      throw new DomainError("REVISION_CONFLICT", "Started stage attempt is missing", {
        runId,
        stage,
        attemptId
      });
    }
    await this.#verifyAttemptProvision(startedAttempt);
    const drafts: ArtifactDraft[] = [...result.artifacts];
    if (drafts.length === 0) {
      const receipt = Buffer.from(
        `${canonicalJson({
          schemaVersion: "evleda.stage-receipt.v1",
          stage,
          inputManifest,
          outputIdentity: result.outputIdentity
        })}\n`,
        "utf8"
      );
      drafts.push({
        logicalName: `${stage}-receipt.json`,
        mediaType: "application/json",
        content: receipt,
        identity: contentIdentity(receipt),
        exactInputs: [inputManifest, result.outputIdentity],
        derivedFrom: [],
        tool: APPLICATION_TOOL,
        validationStatus: "pass",
        unresolvedAssumptions: []
      });
    }
    await Promise.all(
      drafts.map((draft) => this.ports.content.put(draft.content, draft.identity))
    );
    const artifactIdsByName = new Map<string, string>();
    for (const draft of drafts) {
      artifactIdsByName.set(
        draft.logicalName,
        deterministicId("artifact", {
          runId,
          stage,
          attemptId,
          logicalName: draft.logicalName,
          identity: draft.identity
        })
      );
    }
    const evidenceIds = result.evidence.map((entry, index) =>
      deterministicId("evidence", {
        runId,
        stage,
        attemptId,
        index,
        claim: entry.claim,
        subjects: entry.subjectDigests
      })
    );
    const timestamp = this.#timestamp();
    await this.#transaction<{
      readonly revisionId: string;
      readonly artifactIds: readonly string[];
      readonly evidenceIds: readonly string[];
    }>(
      context,
      (committedResult, mutable) => {
        const state = mutable as unknown as EvlEdaState;
        const committedRun = this.#run(state, runId);
        const revision = this.#revision(state, committedResult.revisionId);
        return {
          type: "stage.succeeded",
          projectId: committedRun.projectId,
          runId: committedRun.id,
          subjectDigest: revision.manifest.digest,
          payload: {
            stage,
            attemptId,
            revisionId: revision.id,
            artifactIds: committedResult.artifactIds,
            evidenceIds: committedResult.evidenceIds
          }
        };
      },
      async (mutable) => {
      const projects = recordMap<Project>(mutable.projects);
      const runs = recordMap<DesignRun>(mutable.runs);
      const revisions = recordMap<DesignRevision>(mutable.revisions);
      const artifacts = recordMap<ArtifactRecord>(mutable.artifacts);
      const evidence = recordMap<EvidenceRecord>(mutable.evidence);
      const run = this.#runFromMutable(runs, runId);
      const attempts = { ...run.attempts } as Record<StageKey, readonly StageAttempt[]>;
      const attemptIndex = attempts[stage].findIndex((attempt) => attempt.id === attemptId);
      const attempt = attempts[stage][attemptIndex];
      if (
        attempt === undefined ||
        attempt.state !== "running" ||
        canonicalJson(attempt.inputManifest) !== canonicalJson(inputManifest) ||
        canonicalJson(attempt.provisionIdentity) !== canonicalJson(startedAttempt.provisionIdentity) ||
        canonicalJson(attempt.provisionManifestBlob) !==
          canonicalJson(startedAttempt.provisionManifestBlob)
      ) {
        throw new DomainError("REVISION_CONFLICT", "Stage attempt lost its fencing token", {
          runId,
          stage,
          attemptId
        }, true);
      }
      const parent = this.#assertStageAttemptFence(
        mutable as unknown as EvlEdaState,
        run,
        attempt,
        inputManifest
      );
      const artifactIds = drafts.map((draft) => artifactIdsByName.get(draft.logicalName)!);
      const inheritedArtifactIds = parent.artifactIds.filter((id) => artifacts[id]?.staleAt === undefined);
      const inheritedEvidenceIds = parent.evidenceIds.filter((id) => evidence[id]?.staleAt === undefined);
      const snapshotArtifactIds = uniqueSorted([...inheritedArtifactIds, ...artifactIds]);
      const snapshotEvidenceIds = uniqueSorted([...inheritedEvidenceIds, ...evidenceIds]);
      const ordinal = Math.max(
        0,
        ...Object.values(revisions)
          .filter((revision) => revision.runId === run.id)
          .map((revision) => revision.ordinal)
      ) + 1;
      const derivedFromByArtifactId = new Map<string, readonly string[]>();
      for (const draft of drafts) {
        const artifactId = artifactIdsByName.get(draft.logicalName)!;
        derivedFromByArtifactId.set(
          artifactId,
          uniqueSorted(
            draft.derivedFrom.map((reference) => {
              const local = artifactIdsByName.get(reference);
              if (local !== undefined) return local;
              if (artifacts[reference] !== undefined) return reference;
              const upstream = Object.values(artifacts).find(
                (artifact) =>
                  artifact.runId === run.id &&
                  artifact.logicalName === reference &&
                  artifact.staleAt === undefined
              );
              if (upstream === undefined) {
                throw new DomainError("NOT_FOUND", "Artifact dependency was not found", {
                  stage,
                  logicalName: draft.logicalName,
                  dependency: reference
                });
              }
              return upstream.id;
            })
          )
        );
      }
      const revisionRecord = {
          schemaVersion: "evleda.design-revision.v1",
          projectId: run.projectId,
          runId: run.id,
          ordinal,
          parentRevisionIds: [parent.id],
          stage,
          attempt: {
            id: attempt.id,
            number: attempt.attemptNumber,
            fencingEpoch: attempt.fencingEpoch,
            inputManifest,
            outputIdentity: result.outputIdentity
          },
          requirements: this.#requirements(run).identity,
          artifacts: [
            ...inheritedArtifactIds.map((id) => {
              const artifact = artifacts[id]!;
              return this.#artifactProjection(artifact);
            }),
            ...drafts.map((draft) => ({
              id: artifactIdsByName.get(draft.logicalName)!,
              projectId: run.projectId,
              runId: run.id,
              stage,
              logicalName: draft.logicalName,
              mediaType: draft.mediaType,
              blob: draft.identity,
              exactInputs: this.#uniqueIdentities([...draft.exactInputs, inputManifest]),
              derivedFrom: derivedFromByArtifactId.get(
                artifactIdsByName.get(draft.logicalName)!
              )!,
              tool: draft.tool,
              validationStatus: draft.validationStatus,
              unresolvedAssumptions: draft.unresolvedAssumptions,
              lifecycle: "candidate",
              createdAt: timestamp,
              staleAt: null
            }))
          ],
          evidence: [
            ...inheritedEvidenceIds.map((id) => {
              const entry = evidence[id]!;
              return this.#evidenceProjection(entry);
            }),
            ...result.evidence.map((entry, index) => ({
              id: evidenceIds[index]!,
              projectId: run.projectId,
              runId: run.id,
              stage,
              evidenceClass: entry.evidenceClass,
              claim: entry.claim,
              subjectDigests: uniqueSorted(entry.subjectDigests),
              rawArtifactId:
                entry.rawArtifactLogicalName === undefined
                  ? null
                  : artifactIdsByName.get(entry.rawArtifactLogicalName) ?? null,
              parsedArtifactId:
                entry.parsedArtifactLogicalName === undefined
                  ? null
                  : artifactIdsByName.get(entry.parsedArtifactLogicalName) ?? null,
              exactInputs: this.#uniqueIdentities([...entry.exactInputs, inputManifest]),
              tool: entry.tool,
              validationStatus: entry.validationStatus,
              unresolvedAssumptions: entry.unresolvedAssumptions,
              lifecycle: "candidate",
              createdAt: timestamp,
              validUntil: null,
              staleAt: null
            }))
          ]
        } as const;
      const { manifest, blob: manifestRecordBlob } =
        await this.#persistRevisionManifestRecord(revisionRecord);
      const revisionId = deterministicId("revision", {
        runId: run.id,
        ordinal,
        manifest: manifest.digest
      });
      for (const draft of drafts) {
        const artifactId = artifactIdsByName.get(draft.logicalName)!;
        const derivedFrom = derivedFromByArtifactId.get(artifactId)!;
        artifacts[artifactId] = {
          id: artifactId,
          projectId: run.projectId,
          runId: run.id,
          designRevisionId: revisionId,
          stage,
          logicalName: draft.logicalName,
          mediaType: draft.mediaType,
          blob: draft.identity,
          exactInputs: this.#uniqueIdentities([...draft.exactInputs, inputManifest]),
          derivedFrom,
          tool: draft.tool,
          validationStatus: draft.validationStatus,
          unresolvedAssumptions: draft.unresolvedAssumptions,
          lifecycle: "candidate",
          createdAt: timestamp
        };
      }
      for (const [index, draft] of result.evidence.entries()) {
        const rawArtifactId = draft.rawArtifactLogicalName === undefined
          ? undefined
          : artifactIdsByName.get(draft.rawArtifactLogicalName);
        const parsedArtifactId = draft.parsedArtifactLogicalName === undefined
          ? undefined
          : artifactIdsByName.get(draft.parsedArtifactLogicalName);
        if (draft.rawArtifactLogicalName !== undefined && rawArtifactId === undefined) {
          throw new DomainError("NOT_FOUND", "Evidence raw artifact reference was not found", {
            logicalName: draft.rawArtifactLogicalName
          });
        }
        if (draft.parsedArtifactLogicalName !== undefined && parsedArtifactId === undefined) {
          throw new DomainError("NOT_FOUND", "Evidence parsed artifact reference was not found", {
            logicalName: draft.parsedArtifactLogicalName
          });
        }
        const evidenceId = evidenceIds[index]!;
        evidence[evidenceId] = {
          id: evidenceId,
          projectId: run.projectId,
          runId: run.id,
          designRevisionId: revisionId,
          stage,
          evidenceClass: draft.evidenceClass,
          claim: draft.claim,
          subjectDigests: uniqueSorted(draft.subjectDigests),
          ...(rawArtifactId === undefined ? {} : { rawArtifactId }),
          ...(parsedArtifactId === undefined ? {} : { parsedArtifactId }),
          exactInputs: this.#uniqueIdentities([...draft.exactInputs, inputManifest]),
          tool: draft.tool,
          validationStatus: draft.validationStatus,
          unresolvedAssumptions: draft.unresolvedAssumptions,
          lifecycle: "candidate",
          createdAt: timestamp
        };
      }
      revisions[revisionId] = {
        id: revisionId,
        projectId: run.projectId,
        runId: run.id,
        ordinal,
        parentRevisionIds: [parent.id],
        manifest,
        manifestRecordBlob,
        artifactIds: snapshotArtifactIds,
        evidenceIds: snapshotEvidenceIds,
        lifecycle: "candidate",
        createdAt: timestamp
      };
      const stageAttempts = [...attempts[stage]];
      stageAttempts[attemptIndex] = {
        ...attempt,
        state: "succeeded",
        outputIdentity: result.outputIdentity,
        artifactIds,
        evidenceIds,
        blockers: [],
        completedAt: timestamp
      };
      attempts[stage] = stageAttempts;
      runs[run.id] = {
        ...run,
        attempts,
        headRevisionId: revisionId,
        state: stage === STAGE_ORDER.at(-1) ? "completed" : "running",
        lifecycle: "candidate",
        updatedAt: timestamp,
        revision: run.revision + 1
      };
      const project = this.#projectFromMutable(projects, run.projectId);
      projects[project.id] = {
        ...project,
        headRevisionId: revisionId,
        updatedAt: timestamp,
        revision: project.revision + 1
      };
        return { revisionId, artifactIds, evidenceIds };
      },
      true
    );
    return "succeeded";
  }

  async #reconstructUpstream(
    state: EvlEdaState,
    run: DesignRun,
    beforeStage: Exclude<StageKey, "requirements">
  ): Promise<{
    readonly results: readonly StageExecutionResult[];
    readonly sourceRevisionBindings: readonly UpstreamStageSourceRevisionBinding[];
  }> {
    const output: StageExecutionResult[] = [];
    const sourceRevisionBindings: UpstreamStageSourceRevisionBinding[] = [];
    for (const stage of STAGE_ORDER.slice(0, stageIndex(beforeStage))) {
      const attempt = activeSuccessfulAttempt(run.attempts[stage]);
      if (attempt === undefined) {
        continue;
      }
      if (attempt.outputIdentity === undefined) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Successful stage attempt is missing its exact stored output identity",
          { runId: run.id, stage, attemptId: attempt.id }
        );
      }
      const provisionManifest =
        stage === "requirements" ? undefined : await this.#verifyAttemptProvision(attempt);
      const artifactRecords = attempt.artifactIds.map((id) => {
        const artifact = state.artifacts[id];
        if (artifact === undefined) {
          throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Stage artifact record is missing", {
            runId: run.id,
            stage,
            artifactId: id
          });
        }
        return artifact;
      });
      const artifactDrafts = await Promise.all(
        artifactRecords.map(async (artifact): Promise<ArtifactDraft> => ({
          logicalName: artifact.logicalName,
          mediaType: artifact.mediaType,
          content: await this.ports.content.get(artifact.blob),
          identity: artifact.blob,
          exactInputs: artifact.exactInputs,
          derivedFrom: [...new Set(artifact.derivedFrom.map((dependencyId) => {
            const dependency = state.artifacts[dependencyId];
            if (dependency === undefined || dependency.runId !== run.id) {
              throw new DomainError(
                "ARTIFACT_INTEGRITY_ERROR",
                "Persisted artifact lineage cannot be reconstructed",
                { runId: run.id, stage, artifactId: artifact.id, dependencyId }
              );
            }
            return dependency.logicalName;
          }))].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
          tool: artifact.tool,
          validationStatus: artifact.validationStatus,
          unresolvedAssumptions: artifact.unresolvedAssumptions
        }))
      );
      const evidenceDrafts: EvidenceDraft[] = attempt.evidenceIds.map((id) => {
        const entry = state.evidence[id];
        if (entry === undefined) {
          throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Stage evidence record is missing", {
            runId: run.id,
            stage,
            evidenceId: id
          });
        }
        const raw = entry.rawArtifactId === undefined
          ? undefined
          : state.artifacts[entry.rawArtifactId]?.logicalName;
        const parsed = entry.parsedArtifactId === undefined
          ? undefined
          : state.artifacts[entry.parsedArtifactId]?.logicalName;
        return {
          evidenceClass: entry.evidenceClass,
          claim: entry.claim,
          subjectDigests: entry.subjectDigests,
          ...(raw === undefined ? {} : { rawArtifactLogicalName: raw }),
          ...(parsed === undefined ? {} : { parsedArtifactLogicalName: parsed }),
          exactInputs: entry.exactInputs,
          tool: entry.tool,
          validationStatus: entry.validationStatus,
          unresolvedAssumptions: entry.unresolvedAssumptions
        };
      });
      if (stage !== "requirements") {
        sourceRevisionBindings.push(
          this.#reconstructUpstreamSourceRevisionBinding(
            state,
            run,
            stage,
            attempt,
            provisionManifest!,
            artifactRecords,
            attempt.evidenceIds.map((id) => state.evidence[id]!)
          )
        );
      }
      output.push({
        schemaVersion: "evleda.stage-result.v1",
        stage,
        executionStatus: "succeeded",
        artifacts: artifactDrafts,
        evidence: evidenceDrafts,
        blockers: [],
        outputIdentity: attempt.outputIdentity,
        ...(stage === "requirements" ? { requirementsDocument: this.#requirements(run) } : {})
      });
    }
    return {
      results: Object.freeze(output),
      sourceRevisionBindings: Object.freeze(sourceRevisionBindings)
    };
  }

  #reconstructUpstreamSourceRevisionBinding(
    state: EvlEdaState,
    run: DesignRun,
    stage: Exclude<StageKey, "requirements">,
    attempt: StageAttempt,
    provisionManifest: StageProvisionManifest,
    artifacts: readonly ArtifactRecord[],
    evidence: readonly EvidenceRecord[]
  ): UpstreamStageSourceRevisionBinding {
    const integrityFailure = (message: string, details: Readonly<Record<string, unknown>> = {}): never => {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        message,
        { runId: run.id, stage, attemptId: attempt.id, ...details }
      );
    };
    const safeId = (value: unknown): value is string =>
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= 256 &&
      /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(value);
    const fence = attempt.executionFence;
    if (
      attempt.state !== "succeeded" ||
      attempt.stage !== stage ||
      !safeId(attempt.id) ||
      attempt.outputIdentity === undefined ||
      attempt.provisionIdentity === undefined ||
      attempt.provisionManifestBlob === undefined ||
      fence === undefined ||
      !canonicalIdentitySchema.safeParse(attempt.inputManifest).success ||
      !canonicalIdentitySchema.safeParse(attempt.outputIdentity).success ||
      !canonicalIdentitySchema.safeParse(attempt.provisionIdentity).success ||
      !contentIdentitySchema.safeParse(attempt.provisionManifestBlob).success ||
      attempt.inputManifest.schemaVersion !== `evleda.stage-input.${stage}.v1` ||
      attempt.outputIdentity.schemaVersion !== `evleda.stage-result.${stage}.v1` ||
      attempt.provisionIdentity.schemaVersion !== STAGE_PROVISION_SCHEMA ||
      canonicalJson(fence.inputManifest) !== canonicalJson(attempt.inputManifest)
    ) {
      return integrityFailure("Successful upstream attempt has an invalid immutable execution binding");
    }
    const request = provisionManifest.request;
    if (
      !safeId(request.projectId) ||
      !safeId(request.runId) ||
      !safeId(request.revisionId) ||
      request.projectId !== run.projectId ||
      request.runId !== run.id ||
      request.stage !== stage ||
      request.workflowVersion !== run.workflowVersion ||
      canonicalJson(request.configuration) !== canonicalJson(run.configuration) ||
      request.revisionId !== fence.parentRevisionId ||
      fence.projectHeadRevisionId !== fence.parentRevisionId
    ) {
      return integrityFailure("Persisted upstream provision does not match its run and execution fence");
    }
    const project = state.projects[run.projectId];
    const sourceRevision = state.revisions[fence.parentRevisionId];
    if (
      project === undefined ||
      project.id !== run.projectId ||
      request.projectPolicyVersion !== project.policyVersion ||
      sourceRevision === undefined ||
      sourceRevision.id !== fence.parentRevisionId ||
      sourceRevision.projectId !== run.projectId ||
      sourceRevision.runId !== run.id ||
      canonicalJson(sourceRevision.manifest) !== canonicalJson(fence.parentRevisionManifest) ||
      canonicalJson(sourceRevision.manifest) !== canonicalJson(request.revisionManifest)
    ) {
      return integrityFailure("Persisted upstream source revision does not reproduce its provision and fence");
    }
    if (artifacts.length === 0) {
      return integrityFailure("Successful upstream attempt has no committed artifact from which to derive its revision");
    }
    const committedRevisionIds = new Set<string>();
    for (const artifact of artifacts) {
      if (
        !safeId(artifact.id) ||
        artifact.projectId !== run.projectId ||
        artifact.runId !== run.id ||
        artifact.stage !== stage ||
        !attempt.artifactIds.includes(artifact.id) ||
        !safeId(artifact.designRevisionId)
      ) {
        return integrityFailure("Persisted upstream artifact is detached from its successful attempt", {
          artifactId: artifact.id
        });
      }
      committedRevisionIds.add(artifact.designRevisionId);
    }
    for (const entry of evidence) {
      if (
        !safeId(entry.id) ||
        entry.projectId !== run.projectId ||
        entry.runId !== run.id ||
        entry.stage !== stage ||
        !attempt.evidenceIds.includes(entry.id) ||
        !safeId(entry.designRevisionId)
      ) {
        return integrityFailure("Persisted upstream evidence is detached from its successful attempt", {
          evidenceId: entry.id
        });
      }
      committedRevisionIds.add(entry.designRevisionId);
    }
    if (committedRevisionIds.size !== 1) {
      return integrityFailure("Upstream attempt artifacts and evidence do not share one committed revision", {
        committedRevisionIds: [...committedRevisionIds].slice(0, 9)
      });
    }
    const committedRevisionId = [...committedRevisionIds][0]!;
    const committedRevision = state.revisions[committedRevisionId];
    if (
      committedRevision === undefined ||
      committedRevision.id !== committedRevisionId ||
      committedRevision.projectId !== run.projectId ||
      committedRevision.runId !== run.id ||
      canonicalJson(committedRevision.parentRevisionIds) !== canonicalJson([sourceRevision.id]) ||
      attempt.artifactIds.some((id) => !committedRevision.artifactIds.includes(id)) ||
      attempt.evidenceIds.some((id) => !committedRevision.evidenceIds.includes(id))
    ) {
      return integrityFailure("Committed upstream revision does not reproduce its attempt and source ancestry", {
        committedRevisionId
      });
    }
    const bindingPayload = Object.freeze({
      schemaVersion: UPSTREAM_STAGE_SOURCE_REVISION_BINDING_SCHEMA,
      projectId: run.projectId,
      runId: run.id,
      stage,
      attemptId: attempt.id,
      stageInputManifest: Object.freeze({ ...attempt.inputManifest }),
      stageOutputIdentity: Object.freeze({ ...attempt.outputIdentity }),
      provisionIdentity: Object.freeze({ ...attempt.provisionIdentity }),
      provisionManifestBlob: Object.freeze({ ...attempt.provisionManifestBlob }),
      sourceRevision: Object.freeze({
        id: sourceRevision.id,
        manifest: Object.freeze({ ...sourceRevision.manifest })
      }),
      committedRevision: Object.freeze({
        id: committedRevision.id,
        manifest: Object.freeze({ ...committedRevision.manifest })
      })
    });
    return Object.freeze({
      ...bindingPayload,
      identity: Object.freeze(
        canonicalIdentity(bindingPayload, UPSTREAM_STAGE_SOURCE_REVISION_BINDING_SCHEMA)
      )
    });
  }

  #baseRevisionForStage(
    state: EvlEdaState,
    run: DesignRun,
    stage: Exclude<StageKey, "requirements">
  ): string | undefined {
    const target = activeSuccessfulAttempt(run.attempts[stage]);
    if (target !== undefined) {
      const targetArtifact = target.artifactIds
        .map((id) => state.artifacts[id])
        .find((artifact) => artifact !== undefined);
      if (targetArtifact !== undefined) {
        return state.revisions[targetArtifact.designRevisionId]?.parentRevisionIds[0];
      }
    }
    const priorStages = STAGE_ORDER.slice(0, stageIndex(stage)).reverse();
    for (const prior of priorStages) {
      const attempt = activeSuccessfulAttempt(run.attempts[prior]);
      const artifact = attempt?.artifactIds
        .map((id) => state.artifacts[id])
        .find((entry) => entry !== undefined);
      if (artifact !== undefined) {
        return artifact.designRevisionId;
      }
    }
    return undefined;
  }

  #uniqueIdentities(
    identities: readonly (ContentIdentity | CanonicalIdentity)[]
  ): readonly (ContentIdentity | CanonicalIdentity)[] {
    const unique = new Map<string, ContentIdentity | CanonicalIdentity>();
    for (const identity of identities) {
      const discriminator = "size" in identity ? `content:${identity.size}` : `canonical:${identity.schemaVersion}`;
      unique.set(`${identity.algorithm}:${identity.digest}:${discriminator}`, identity);
    }
    return [...unique.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([, identity]) => identity);
  }

  #assertProvisionIdentity(identity: CanonicalIdentity): void {
    if (
      identity.algorithm !== "sha256" ||
      !/^[0-9a-f]{64}$/u.test(identity.digest) ||
      identity.schemaVersion !== STAGE_PROVISION_SCHEMA ||
      identity.canonicalizationVersion !== "evleda-c14n-json-v1"
    ) {
      throw new DomainError(
        "TOOL_RESULT_INCONCLUSIVE",
        "Stage context provider returned an invalid provision identity",
        { expectedSchemaVersion: STAGE_PROVISION_SCHEMA },
        true
      );
    }
  }

  #stageProvisionRequest(
    project: Project,
    run: DesignRun,
    revision: DesignRevision,
    stage: Exclude<StageKey, "requirements">
  ): StageProvisionManifest["request"] {
    return {
      projectId: project.id,
      projectPolicyVersion: project.policyVersion,
      runId: run.id,
      workflowVersion: run.workflowVersion,
      configuration: run.configuration,
      revisionId: revision.id,
      revisionManifest: revision.manifest,
      stage
    };
  }

  #stageEnrichmentIdentity(provision: StageContextProvision): CanonicalIdentity {
    return canonicalIdentity(
      {
        profile: provision.profile ?? null,
        curatedDatasheets: provision.curatedDatasheets ?? null,
        sourcing: provision.sourcing ?? null,
        lifecycleObservations: provision.lifecycleObservations ?? null,
        pinPadMappingReviews: provision.pinPadMappingReviews ?? null,
        footprintLibrary: provision.footprintLibrary ?? null,
        firmwareCompileConfiguration: provision.firmwareCompileConfiguration ?? null,
        firmwareTargetBuildConfiguration: provision.firmwareTargetBuildConfiguration ?? null
      },
      STAGE_CONTEXT_ENRICHMENT_SCHEMA
    );
  }

  #unavailableProvision(
    request: StageProvisionManifest["request"],
    status: "unconfigured" | "failed",
    errorCode?: string
  ): StageContextProvision {
    const shell = {
      profile: null,
      curatedDatasheets: null,
      sourcing: null,
      lifecycleObservations: null,
      pinPadMappingReviews: null,
      footprintLibrary: null,
      firmwareCompileConfiguration: null,
      firmwareTargetBuildConfiguration: null
    };
    const manifest: StageProvisionManifest = {
      schemaVersion: STAGE_PROVISION_SCHEMA,
      request,
      enrichmentIdentity: canonicalIdentity(shell, STAGE_CONTEXT_ENRICHMENT_SCHEMA),
      backends: { kicad: null, simulation: null, firmwareCompile: null, firmwareTargetBuild: null },
      providerEvidence: {
        status,
        ...(errorCode === undefined ? {} : { errorCode })
      }
    };
    return {
      provisionIdentity: canonicalIdentity(manifest, STAGE_PROVISION_SCHEMA),
      provisionManifest: manifest
    };
  }

  #assertFirmwareCompileConfiguration(
    configuration: FirmwareCompileBackendConfiguration
  ): CanonicalIdentity {
    if (
      configuration.schemaVersion !== FIRMWARE_COMPILE_BACKEND_CONFIGURATION_SCHEMA ||
      configuration.backendId.trim().length === 0 ||
      configuration.backendId.length > 128 ||
      (configuration.requestedCompilerPath !== null &&
        (!path.isAbsolute(configuration.requestedCompilerPath) ||
          configuration.requestedCompilerPath.length > 4096)) ||
      configuration.platform !== process.platform ||
      configuration.architecture !== process.arch ||
      configuration.processRunner !== "evleda.bounded-process.v1" ||
      !Number.isSafeInteger(configuration.timeoutMs) ||
      configuration.timeoutMs <= 0 ||
      configuration.timeoutMs > 10 * 60_000 ||
      !Number.isSafeInteger(configuration.maxOutputBytes) ||
      configuration.maxOutputBytes <= 0 ||
      configuration.maxOutputBytes > 4 * 1024 * 1024 ||
      !Array.isArray(configuration.compileArguments) ||
      configuration.compileArguments.length === 0 ||
      configuration.compileArguments.length > 64 ||
      configuration.compileArguments.some(
        (argument) =>
          typeof argument !== "string" ||
          argument.length > 1024 ||
          argument.includes("\0") ||
          argument.includes("\r") ||
          argument.includes("\n")
      ) ||
      typeof configuration.environment !== "object" ||
      configuration.environment === null ||
      Array.isArray(configuration.environment) ||
      Object.entries(configuration.environment).some(
        ([key, value]) =>
          key.length === 0 || key.length > 128 ||
          typeof value !== "string" || value.length > 32 * 1024 || value.includes("\0")
      )
    ) {
      throw new DomainError(
        "TOOL_RESULT_INCONCLUSIVE",
        "Stage context provider returned an invalid firmware compile configuration",
        {},
        true
      );
    }
    const environmentIdentity = canonicalIdentity(
      configuration.environment,
      FIRMWARE_COMPILE_ENVIRONMENT_SCHEMA
    );
    if (canonicalJson(environmentIdentity) !== canonicalJson(configuration.environmentIdentity)) {
      throw new DomainError(
        "TOOL_RESULT_INCONCLUSIVE",
        "Firmware compile configuration is detached from its configured environment",
        {},
        true
      );
    }
    return canonicalIdentity(
      configuration,
      FIRMWARE_COMPILE_BACKEND_CONFIGURATION_SCHEMA
    );
  }

  #assertFirmwareTargetBuildConfiguration(
    configuration: FirmwareTargetBuildBackendConfiguration
  ): CanonicalIdentity {
    if (!validateFirmwareTargetBuildConfiguration(configuration)) {
      throw new DomainError(
        "TOOL_RESULT_INCONCLUSIVE",
        "Stage context provider returned an invalid firmware target build configuration",
        {},
        true
      );
    }
    return canonicalIdentity(configuration, FIRMWARE_TARGET_BUILD_CONFIGURATION_SCHEMA);
  }

  #assertStageProvision(
    provision: StageContextProvision,
    expectedRequest: StageProvisionManifest["request"]
  ): void {
    const allowedProvisionKeys = new Set([
      "profile",
      "curatedDatasheets",
      "sourcing",
      "lifecycleObservations",
      "pinPadMappingReviews",
      "footprintLibrary",
      "kicadBackend",
      "simulationBackend",
      "firmwareCompileBackend",
      "firmwareCompileConfiguration",
      "firmwareTargetBuildBackend",
      "firmwareTargetBuildConfiguration",
      "provisionIdentity",
      "provisionManifest"
    ]);
    if (typeof provision !== "object" || provision === null || Array.isArray(provision)) {
      throw new DomainError(
        "TOOL_RESULT_INCONCLUSIVE",
        "Stage context provider returned a non-object provision",
        { stage: expectedRequest.stage },
        true
      );
    }
    const provisionObject = provision as unknown as object;
    const ownKeys = Reflect.ownKeys(provisionObject);
    if (
      (Object.getPrototypeOf(provisionObject) !== Object.prototype &&
        Object.getPrototypeOf(provisionObject) !== null) ||
      ownKeys.length > allowedProvisionKeys.size ||
      ownKeys.some((key) =>
        typeof key !== "string" ||
        !allowedProvisionKeys.has(key) ||
        (() => {
          const descriptor = Object.getOwnPropertyDescriptor(provisionObject, key);
          return descriptor === undefined ||
            !("value" in descriptor) ||
            descriptor.enumerable !== true;
        })()
      ) ||
      !Object.hasOwn(provisionObject, "provisionIdentity") ||
      !Object.hasOwn(provisionObject, "provisionManifest")
    ) {
      throw new DomainError(
        "TOOL_RESULT_INCONCLUSIVE",
        "Stage context provider returned an open or accessor-bearing provision object",
        { stage: expectedRequest.stage },
        true
      );
    }
    this.#assertProvisionIdentity(provision.provisionIdentity);
    const manifest = provision.provisionManifest;
    let serialized: string;
    try {
      serialized = canonicalJson(manifest);
    } catch (error) {
      throw new DomainError(
        "TOOL_RESULT_INCONCLUSIVE",
        "Stage context provider returned a non-serializable provision manifest",
        { reason: error instanceof Error ? error.message : String(error) },
        true
      );
    }
    if (
      Buffer.byteLength(serialized, "utf8") > 64 * 1024 * 1024 ||
      manifest.schemaVersion !== STAGE_PROVISION_SCHEMA ||
      canonicalJson(manifest.request) !== canonicalJson(expectedRequest) ||
      canonicalJson(manifest.enrichmentIdentity) !==
        canonicalJson(this.#stageEnrichmentIdentity(provision)) ||
      canonicalJson(canonicalIdentity(manifest, STAGE_PROVISION_SCHEMA)) !==
        canonicalJson(provision.provisionIdentity)
    ) {
      throw new DomainError(
        "TOOL_RESULT_INCONCLUSIVE",
        "Stage provision identity, request, or enrichment does not match its canonical manifest",
        { stage: expectedRequest.stage },
        true
      );
    }
    const expectedKicad = provision.kicadBackend?.backendId ?? null;
    const expectedSimulation = provision.simulationBackend?.backendId ?? null;
    if (
      (manifest.backends.kicad?.backendId ?? null) !== expectedKicad ||
      (manifest.backends.simulation?.backendId ?? null) !== expectedSimulation
    ) {
      throw new DomainError(
        "TOOL_RESULT_INCONCLUSIVE",
        "Stage provision backend identities do not match the returned enrichment",
        { stage: expectedRequest.stage },
        true
      );
    }
    const firmwareBackend = provision.firmwareCompileBackend;
    const firmwareConfiguration = provision.firmwareCompileConfiguration;
    const firmwareBinding = manifest.backends.firmwareCompile;
    if (
      (firmwareBackend === undefined) !== (firmwareConfiguration === undefined) ||
      (firmwareBackend === undefined) !== (firmwareBinding === null)
    ) {
      throw new DomainError(
        "TOOL_RESULT_INCONCLUSIVE",
        "Firmware backend, configuration, and provision binding must be supplied together",
        { stage: expectedRequest.stage },
        true
      );
    }
    if (
      firmwareBackend !== undefined &&
      firmwareConfiguration !== undefined &&
      firmwareBinding !== null
    ) {
      const configurationIdentity = this.#assertFirmwareCompileConfiguration(firmwareConfiguration);
      if (
        firmwareBackend.backendId !== firmwareConfiguration.backendId ||
        firmwareBinding.backendId !== firmwareBackend.backendId ||
        canonicalJson(firmwareBackend.configuration) !== canonicalJson(firmwareConfiguration) ||
        canonicalJson(firmwareBinding.configurationIdentity) !==
          canonicalJson(configurationIdentity)
      ) {
        throw new DomainError(
          "TOOL_RESULT_INCONCLUSIVE",
          "Firmware backend or configuration does not match its provision manifest binding",
          { stage: expectedRequest.stage },
          true
        );
      }
    }
    const targetBackend = provision.firmwareTargetBuildBackend;
    const targetConfiguration = provision.firmwareTargetBuildConfiguration;
    const targetBinding = manifest.backends.firmwareTargetBuild ?? null;
    if (
      (targetBackend === undefined) !== (targetConfiguration === undefined) ||
      (targetBackend === undefined) !== (targetBinding === null)
    ) {
      throw new DomainError(
        "TOOL_RESULT_INCONCLUSIVE",
        "Firmware target backend, configuration, and provision binding must be supplied together",
        { stage: expectedRequest.stage },
        true
      );
    }
    if (targetBackend !== undefined && targetConfiguration !== undefined && targetBinding !== null) {
      const configurationIdentity = this.#assertFirmwareTargetBuildConfiguration(targetConfiguration);
      if (
        targetBackend.backendId !== targetConfiguration.backendId ||
        targetBinding.backendId !== targetBackend.backendId ||
        canonicalJson(targetBackend.configuration) !== canonicalJson(targetConfiguration) ||
        canonicalJson(targetBinding.configurationIdentity) !== canonicalJson(configurationIdentity)
      ) {
        throw new DomainError(
          "TOOL_RESULT_INCONCLUSIVE",
          "Firmware target backend or configuration does not match its provision manifest binding",
          { stage: expectedRequest.stage },
          true
        );
      }
    }
  }

  async #verifyAttemptProvision(attempt: StageAttempt): Promise<StageProvisionManifest> {
    if (attempt.provisionIdentity === undefined || attempt.provisionManifestBlob === undefined) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Stage attempt is missing its persisted provision manifest",
        { attemptId: attempt.id, stage: attempt.stage }
      );
    }
    if (
      !contentIdentitySchema.safeParse(attempt.provisionManifestBlob).success ||
      attempt.provisionManifestBlob.size > 64 * 1024 * 1024
    ) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Persisted stage provision manifest identity exceeds its closed byte boundary",
        { attemptId: attempt.id, stage: attempt.stage }
      );
    }
    const bytes = await this.ports.content.get(attempt.provisionManifestBlob);
    if (bytes.byteLength > 64 * 1024 * 1024) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Persisted stage provision manifest exceeds its closed byte boundary",
        { attemptId: attempt.id, stage: attempt.stage }
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Persisted stage provision manifest is not valid JSON",
        { attemptId: attempt.id }
      );
    }
    const canonicalBytes = Buffer.from(`${canonicalJson(parsed)}\n`, "utf8");
    const recomputed = canonicalIdentity(parsed, STAGE_PROVISION_SCHEMA);
    const root = isRecordValue(parsed) ? parsed : undefined;
    const request = root !== undefined && isRecordValue(root.request) ? root.request : undefined;
    if (
      !bytes.equals(canonicalBytes) ||
      root === undefined ||
      request === undefined ||
      !exactObjectKeys(root, [
        "schemaVersion",
        "request",
        "enrichmentIdentity",
        "backends",
        "providerEvidence"
      ]) ||
      !exactObjectKeys(request, [
        "projectId",
        "projectPolicyVersion",
        "runId",
        "workflowVersion",
        "configuration",
        "revisionId",
        "revisionManifest",
        "stage"
      ]) ||
      root.schemaVersion !== STAGE_PROVISION_SCHEMA ||
      !canonicalIdentitySchema.safeParse(root.enrichmentIdentity).success ||
      !canonicalIdentitySchema.safeParse(request.configuration).success ||
      !canonicalIdentitySchema.safeParse(request.revisionManifest).success ||
      canonicalJson(recomputed) !== canonicalJson(attempt.provisionIdentity)
    ) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Persisted stage provision preimage does not reproduce the attempt identity",
        { attemptId: attempt.id, expected: attempt.provisionIdentity, actual: recomputed }
      );
    }
    return parsed as StageProvisionManifest;
  }

  #assertStageAttemptFence(
    state: EvlEdaState,
    run: DesignRun,
    attempt: StageAttempt,
    inputManifest: CanonicalIdentity
  ): DesignRevision {
    const fence = attempt.executionFence;
    const project = this.#project(state, run.projectId);
    if (
      fence === undefined ||
      canonicalJson(attempt.inputManifest) !== canonicalJson(inputManifest) ||
      canonicalJson(fence.inputManifest) !== canonicalJson(inputManifest) ||
      run.headRevisionId !== fence.parentRevisionId ||
      project.headRevisionId !== fence.projectHeadRevisionId
    ) {
      throw new DomainError(
        "REVISION_CONFLICT",
        "Stage attempt parent head or frozen input manifest changed during execution",
        { runId: run.id, stage: attempt.stage, attemptId: attempt.id },
        true
      );
    }
    const parent = state.revisions[fence.parentRevisionId];
    if (
      parent === undefined ||
      parent.runId !== run.id ||
      canonicalJson(parent.manifest) !== canonicalJson(fence.parentRevisionManifest)
    ) {
      throw new DomainError(
        "REVISION_CONFLICT",
        "Stage attempt parent revision no longer matches its start fence",
        { runId: run.id, stage: attempt.stage, attemptId: attempt.id },
        true
      );
    }
    let approval: ApprovalRecord;
    try {
      approval = this.#assertRequirementsApproved(state, run);
    } catch {
      throw new DomainError(
        "REVISION_CONFLICT",
        "Requirements approval changed or became inactive during stage execution",
        { runId: run.id, stage: attempt.stage, attemptId: attempt.id },
        true
      );
    }
    if (
      approval.id !== fence.requirementsApprovalId ||
      approval.subjectDigest !== fence.requirementsApprovalDigest
    ) {
      throw new DomainError(
        "REVISION_CONFLICT",
        "Requirements approval binding changed during stage execution",
        { runId: run.id, stage: attempt.stage, attemptId: attempt.id },
        true
      );
    }
    return parent;
  }

  async #recordExportMutation(
    operation: "export_candidate_bundle" | "export_prototype_bundle",
    input: {
      readonly revisionId: string;
      readonly idempotencyKey: string;
      readonly expectedRevision: number;
    },
    run: DesignRun,
    result: CurrentBundleExportResult,
    context: CommandContext,
    auditType: string
  ): Promise<BundleExportResult> {
    const timestamp = this.#timestamp();
    const receipt = this.#createBundleExportReplay(operation, input, result);
    if (receipt.result.runId !== run.id || receipt.result.projectId !== run.projectId) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Bundle export result does not belong to the selected run",
        { operation, revisionId: input.revisionId }
      );
    }
    const mutation = await this.#idempotentMutation<StoredBundleExportReplay>(
      operation,
      input,
      context,
      (mutationResult) => ({
        type: auditType,
        projectId: mutationResult.result.projectId,
        runId: mutationResult.result.runId,
        subjectDigest: mutationResult.result.identity.digest,
        payload: {
          operation,
          bundleDigest: mutationResult.result.identity.digest
        }
      }),
      async (mutable) => {
        const runs = recordMap<DesignRun>(mutable.runs);
        const current = this.#runFromMutable(runs, run.id);
        this.#assertExpectedRevision(current.revision, input.expectedRevision, "run");
        runs[current.id] = {
          ...current,
          updatedAt: timestamp,
          revision: current.revision + 1
        };
        return receipt;
      }
    );
    return this.#restoreBundleExportReplay(operation, input, mutation.result);
  }

  #createBundleExportReplay(
    operation: "export_candidate_bundle" | "export_prototype_bundle",
    input: { readonly revisionId: string },
    result: CurrentBundleExportResult
  ): StoredBundleExportReplayV2 {
    const validated = currentBundleExportResultSchema.safeParse(result);
    if (!validated.success) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Bundle export produced an invalid replay result",
        { operation, revisionId: input.revisionId }
      );
    }
    const bytes = Buffer.from(validated.data.bytesBase64, "base64");
    const actualIdentity = contentIdentity(bytes);
    if (!sameContentIdentity(actualIdentity, validated.data.identity)) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Bundle export bytes do not match the recorded identity",
        {
          operation,
          revisionId: input.revisionId,
          expected: validated.data.identity,
          actual: actualIdentity
        }
      );
    }
    const { bytesBase64: _bytesBase64, ...storedResult } = validated.data;
    const receipt = bundleExportReplayV2Schema.parse({
      schemaVersion: BUNDLE_EXPORT_REPLAY_SCHEMA_VERSION,
      result: storedResult
    });
    this.#assertBundleExportReplayBindings(operation, input, receipt);
    return receipt;
  }

  #parseBundleExportReplay(
    operation: "export_candidate_bundle" | "export_prototype_bundle",
    input: { readonly revisionId: string },
    replay: unknown
  ): StoredBundleExportReplay {
    if (
      typeof replay !== "object" ||
      replay === null ||
      Array.isArray(replay) ||
      Object.keys(replay).length !== 2 ||
      !("schemaVersion" in replay) ||
      !("result" in replay)
    ) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Stored bundle export replay receipt has an invalid schema",
        { operation, revisionId: input.revisionId }
      );
    }
    const parsed = replay.schemaVersion === BUNDLE_EXPORT_REPLAY_SCHEMA_VERSION
      ? bundleExportReplayV2Schema.safeParse(replay)
      : replay.schemaVersion === LEGACY_BUNDLE_EXPORT_REPLAY_SCHEMA_VERSION
        ? bundleExportReplayV1Schema.safeParse(replay)
        : undefined;
    if (parsed === undefined || !parsed.success) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Stored bundle export replay result has an invalid durable schema",
        { operation, revisionId: input.revisionId }
      );
    }
    const receipt = parsed.data;
    this.#assertBundleExportReplayBindings(operation, input, receipt);
    return receipt;
  }

  #assertBundleExportReplayBindings(
    operation: "export_candidate_bundle" | "export_prototype_bundle",
    input: { readonly revisionId: string },
    receipt: StoredBundleExportReplay
  ): void {
    const candidate = operation === "export_candidate_bundle";
    const expectedKind = candidate ? "candidate" : "prototype";
    const expectedLifecycle = candidate ? "candidate" : "qualified";
    const expectedWarning = candidate ? CANDIDATE_BUNDLE_WARNING : PROTOTYPE_BUNDLE_WARNING;
    const expectedRoot = candidate
      ? `CANDIDATE-NOT-FOR-MANUFACTURING-${safeArchiveName(input.revisionId)}`
      : `PROTOTYPE-NOT-PRODUCTION-RELEASED-${safeArchiveName(input.revisionId)}`;
    const result = receipt.result;
    const manifest = result.manifest;
    const revisionInput = result.exactInputs[0];
    const evidenceInput = result.exactInputs[1];
    const current = receipt.schemaVersion === BUNDLE_EXPORT_REPLAY_SCHEMA_VERSION;
    const policyInput = current ? receipt.result.exactInputs[2] : undefined;
    const requiredBundleTool = current ? BUNDLE_TOOL : LEGACY_BUNDLE_TOOL;
    const artifactToolsByIdentity = new Map<string, ParsedToolIdentity>();
    let artifactToolIdentityCollision = false;
    for (const artifact of manifest.artifacts) {
      const identity = canonicalIdentity(artifact.tool, "evleda.tool-identity.v1").digest;
      const existing = artifactToolsByIdentity.get(identity);
      if (existing !== undefined && !sameToolIdentity(existing, artifact.tool)) {
        artifactToolIdentityCollision = true;
      }
      artifactToolsByIdentity.set(identity, artifact.tool);
    }
    const exactArtifactToolUnion = [...artifactToolsByIdentity.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([, tool]) => tool);
    const manifestBundleTools = manifest.toolchain.filter(isBundleToolFamily);
    const generatedBundleToolsAreExact = manifest.artifacts
      .filter((artifact) => artifact.sourceKind === "bundle_generated")
      .every((artifact) => sameToolIdentity(artifact.tool, requiredBundleTool));
    if (
      result.designRevisionId !== input.revisionId ||
      result.fileName !== `${expectedRoot}.zip` ||
      result.projectId !== manifest.projectId ||
      result.runId !== manifest.runId ||
      result.designRevisionId !== manifest.designRevisionId ||
      result.lifecycle !== expectedLifecycle ||
      result.validationStatus !== "pass" ||
      manifest.bundleKind !== expectedKind ||
      manifest.lifecycle !== expectedLifecycle ||
      manifest.warning !== expectedWarning ||
      !sameToolIdentity(result.tool, requiredBundleTool) ||
      artifactToolIdentityCollision ||
      canonicalJson(manifest.toolchain) !== canonicalJson(exactArtifactToolUnion) ||
      manifestBundleTools.length !== 1 ||
      !sameToolIdentity(manifestBundleTools[0]!, requiredBundleTool) ||
      !generatedBundleToolsAreExact ||
      result.exactInputs.length !== (current ? 3 : 2) ||
      revisionInput === undefined ||
      evidenceInput === undefined ||
      canonicalJson(revisionInput) !== canonicalJson(manifest.revisionManifest) ||
      canonicalJson(evidenceInput) !== canonicalJson(manifest.evidenceRoot) ||
      (current &&
        (manifest.schemaVersion !== "evleda.bundle-manifest.v3" ||
          policyInput === undefined ||
          canonicalJson(policyInput) !==
            canonicalJson(manifest.liveRegenerationPolicyIdentity))) ||
      (!current && manifest.schemaVersion !== "evleda.bundle-manifest.v2")
    ) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Stored bundle export replay result is inconsistent with its request or operation",
        { operation, revisionId: input.revisionId }
      );
    }
  }

  async #restoreBundleExportReplay(
    operation: "export_candidate_bundle" | "export_prototype_bundle",
    input: { readonly revisionId: string },
    replay: unknown
  ): Promise<BundleExportResult> {
    const receipt = this.#parseBundleExportReplay(operation, input, replay);
    let bytes: Buffer;
    try {
      bytes = await this.ports.content.get(receipt.result.identity);
    } catch (error) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Stored bundle export replay bytes are missing or corrupt",
        {
          operation,
          revisionId: input.revisionId,
          bundleDigest: receipt.result.identity.digest,
          causeCode: error instanceof DomainError ? error.code : "CONTENT_READ_FAILED"
        }
      );
    }

    const rootName = receipt.result.fileName.slice(0, -4);
    try {
      this.#assertBundleComplete(bytes, rootName, receipt.result.manifest);
      const archivedManifest = unzipSync(bytes)[`${rootName}/bundle-manifest.json`];
      const expectedManifest = Buffer.from(
        `${canonicalJson(receipt.result.manifest)}\n`,
        "utf8"
      );
      if (
        archivedManifest === undefined ||
        !Buffer.from(archivedManifest).equals(expectedManifest)
      ) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Stored bundle manifest does not match its replay receipt"
        );
      }
    } catch (error) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Stored bundle export replay archive does not match its receipt",
        {
          operation,
          revisionId: input.revisionId,
          bundleDigest: receipt.result.identity.digest,
          causeCode: error instanceof DomainError ? error.code : "INVALID_ARCHIVE"
        }
      );
    }

    const restoredValue = {
      ...receipt.result,
      bytesBase64: bytes.toString("base64")
    };
    const restored = receipt.schemaVersion === BUNDLE_EXPORT_REPLAY_SCHEMA_VERSION
      ? currentBundleExportResultSchema.safeParse(restoredValue)
      : legacyBundleExportResultSchema.safeParse(restoredValue);
    if (!restored.success) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Stored bundle export replay could not reconstruct its original result",
        { operation, revisionId: input.revisionId }
      );
    }
    return restored.data as unknown as BundleExportResult;
  }

  #artifactProjection(artifact: ArtifactRecord): Readonly<Record<string, unknown>> {
    return {
      id: artifact.id,
      projectId: artifact.projectId,
      runId: artifact.runId,
      designRevisionId: artifact.designRevisionId,
      stage: artifact.stage,
      logicalName: artifact.logicalName,
      mediaType: artifact.mediaType,
      blob: artifact.blob,
      exactInputs: artifact.exactInputs,
      derivedFrom: uniqueSorted(artifact.derivedFrom),
      tool: artifact.tool,
      validationStatus: artifact.validationStatus,
      unresolvedAssumptions: artifact.unresolvedAssumptions,
      lifecycle: artifact.lifecycle,
      createdAt: artifact.createdAt,
      staleAt: artifact.staleAt ?? null
    };
  }

  async #persistRevisionManifestRecord(
    record: Readonly<Record<string, unknown>>
  ): Promise<{ readonly manifest: CanonicalIdentity; readonly blob: ContentIdentity }> {
    if (record.schemaVersion !== "evleda.design-revision.v1") {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Design revision manifest record has an unsupported schema"
      );
    }
    const manifest = canonicalIdentity(record, "evleda.design-revision.v1");
    const blob = await this.ports.content.put(`${canonicalJson(record)}\n`);
    return { manifest, blob };
  }

  async #loadRevisionManifestRecord(
    revision: DesignRevision
  ): Promise<Readonly<Record<string, unknown>>> {
    if (revision.manifestRecordBlob === undefined) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Revision predates canonical manifest-record persistence and cannot be exported as a provenance-verifiable v2 bundle",
        {
          revisionId: revision.id,
          requiredAction: "Create a new candidate checkpoint or rerun from frozen inputs; do not reconstruct the legacy root."
        }
      );
    }
    let bytes: Buffer;
    try {
      bytes = await this.ports.content.get(revision.manifestRecordBlob);
    } catch (error) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Revision manifest record is missing or corrupt",
        {
          revisionId: revision.id,
          manifestRecordBlob: revision.manifestRecordBlob,
          causeCode: error instanceof DomainError ? error.code : "CONTENT_READ_FAILED"
        }
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Revision manifest record is not valid JSON",
        { revisionId: revision.id }
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Revision manifest record is not an object",
        { revisionId: revision.id }
      );
    }
    const record = parsed as Readonly<Record<string, unknown>>;
    const canonicalBytes = Buffer.from(`${canonicalJson(record)}\n`, "utf8");
    const recomputed = canonicalIdentity(record, "evleda.design-revision.v1");
    if (
      !bytes.equals(canonicalBytes) ||
      record.schemaVersion !== "evleda.design-revision.v1" ||
      record.projectId !== revision.projectId ||
      record.runId !== revision.runId ||
      canonicalJson(record.parentRevisionIds) !== canonicalJson(revision.parentRevisionIds) ||
      recomputed.digest !== revision.manifest.digest ||
      revision.manifest.schemaVersion !== "evleda.design-revision.v1" ||
      revision.manifest.canonicalizationVersion !== "evleda-c14n-json-v1"
    ) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Revision manifest record does not reproduce its stored revision identity",
        { revisionId: revision.id, expected: revision.manifest, actual: recomputed }
      );
    }
    return record;
  }

  #evidenceProjection(entry: EvidenceRecord): Readonly<Record<string, unknown>> {
    return evidenceRecordProjection(entry);
  }

  #evidenceRoot(evidence: readonly EvidenceRecord[]): CanonicalIdentity {
    return deriveEvidenceRoot(evidence);
  }

  #assertCurrentEvidence(evidence: readonly EvidenceRecord[], now: Date): void {
    const inactiveEvidenceIds = evidence
      .filter((entry) => !evidenceIsCurrent(entry, now))
      .map((entry) => entry.id)
      .sort((left, right) => left.localeCompare(right, "en"));
    if (inactiveEvidenceIds.length > 0) {
      throw new DomainError(
        "GATE_FAILED",
        "Current revision evidence contains stale or expired records",
        { evidenceIds: inactiveEvidenceIds }
      );
    }
  }

  #physicalBindingList(bindings: PhysicalArtifactBindings): readonly {
    readonly artifactId: string;
    readonly identity: ContentIdentity;
  }[] {
    return [
      bindings.bom,
      bindings.cam.manifest,
      ...bindings.cam.artifacts,
      bindings.targetBuildReport,
      bindings.targetBinary,
      bindings.bringupProcedure,
      bindings.acceptance
    ];
  }

  #physicalArchivePath(identity: ContentIdentity): string {
    return `sources/sha256/${identity.digest.slice(0, 2)}/${identity.digest.slice(2)}`;
  }

  async #assertPhysicalArtifactBindings(
    state: EvlEdaState,
    revision: DesignRevision,
    bindings: PhysicalArtifactBindings
  ): Promise<ResolvedPhysicalArtifactBindings> {
    const currentArtifactIds = new Set(revision.artifactIds);
    const loadBinding = async (
      binding: { readonly artifactId: string; readonly identity: ContentIdentity },
      role: string
    ): Promise<{ readonly artifact: ArtifactRecord; readonly bytes: Buffer }> => {
      const artifact = state.artifacts[binding.artifactId];
      if (
        artifact === undefined ||
        !currentArtifactIds.has(binding.artifactId) ||
        artifact.projectId !== revision.projectId ||
        artifact.runId !== revision.runId ||
        artifact.staleAt !== undefined
      ) {
        throw new DomainError(
          "EVIDENCE_STALE",
          `Physical evidence ${role} binding is missing, stale, or outside the current head`,
          { role, artifactId: binding.artifactId, revisionId: revision.id }
        );
      }
      if (
        artifact.lifecycle !== "candidate" ||
        artifact.validationStatus !== "pass" ||
        artifact.unresolvedAssumptions.some((assumption) => assumption.severity === "blocking")
      ) {
        throw new DomainError(
          "GATE_FAILED",
          `Physical evidence ${role} artifact is not an eligible passing candidate input`,
          { role, artifactId: artifact.id, validationStatus: artifact.validationStatus }
        );
      }
      if (!sameContentIdentity(artifact.blob, binding.identity)) {
        throw new DomainError(
          "DIGEST_MISMATCH",
          `Physical evidence ${role} identity does not match the current artifact`,
          { role, artifactId: artifact.id, expected: artifact.blob, actual: binding.identity }
        );
      }
      return { artifact, bytes: await this.ports.content.get(artifact.blob) };
    };
    const assertShape = (
      artifact: ArtifactRecord,
      expected: {
        readonly role: string;
        readonly stage: StageKey;
        readonly logicalName: string;
        readonly mediaType: string;
        readonly adapter: ToolIdentity["adapter"];
        readonly toolName?: string;
      }
    ): void => {
      if (
        artifact.stage !== expected.stage ||
        artifact.logicalName !== expected.logicalName ||
        artifact.mediaType !== expected.mediaType ||
        artifact.tool.adapter !== expected.adapter ||
        (expected.toolName !== undefined && artifact.tool.name !== expected.toolName)
      ) {
        throw new DomainError(
          "INVALID_ARGUMENT",
          `Artifact ${artifact.id} is not the canonical ${expected.role} artifact`,
          {
            role: expected.role,
            expected,
            actual: {
              stage: artifact.stage,
              logicalName: artifact.logicalName,
              mediaType: artifact.mediaType,
              tool: artifact.tool
            }
          }
        );
      }
    };
    const bom = await loadBinding(bindings.bom, "BOM");
    assertShape(bom.artifact, {
      role: "BOM",
      stage: "manufacturing_package",
      logicalName: "manufacturing/bom.csv",
      mediaType: "text/csv; charset=utf-8",
      adapter: "kicad_cli",
      toolName: "kicad-cli"
    });
    const camManifest = await loadBinding(bindings.cam.manifest, "CAM manifest");
    assertShape(camManifest.artifact, {
      role: "CAM manifest",
      stage: "manufacturing_package",
      logicalName: "manufacturing/cam-manifest.json",
      mediaType: "application/json",
      adapter: "kicad_cli",
      toolName: "kicad-cli"
    });
    let camValue: unknown;
    try {
      camValue = JSON.parse(camManifest.bytes.toString("utf8"));
    } catch {
      throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Current CAM manifest is not JSON");
    }
    const camRecord = camValue as { readonly schemaVersion?: unknown; readonly artifacts?: unknown };
    if (
      typeof camRecord !== "object" ||
      camRecord === null ||
      camRecord.schemaVersion !== "evleda.reference-kicad-cam-manifest.v1" ||
      !Array.isArray(camRecord.artifacts)
    ) {
      throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Current CAM manifest has the wrong schema");
    }
    const manifestOutputs: { readonly logicalName: string; readonly identity: ContentIdentity }[] = [];
    for (const output of camRecord.artifacts) {
      if (
        typeof output !== "object" ||
        output === null ||
        Object.keys(output).sort().join(",") !== "identity,logicalName" ||
        typeof (output as { readonly logicalName?: unknown }).logicalName !== "string"
      ) {
        throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "CAM manifest contains a malformed output binding");
      }
      const identity = (output as { readonly identity?: unknown }).identity;
      if (
        typeof identity !== "object" || identity === null ||
        (identity as { readonly algorithm?: unknown }).algorithm !== "sha256" ||
        typeof (identity as { readonly digest?: unknown }).digest !== "string" ||
        !/^[0-9a-f]{64}$/u.test((identity as { readonly digest: string }).digest) ||
        !Number.isSafeInteger((identity as { readonly size?: unknown }).size) ||
        (identity as { readonly size: number }).size <= 0
      ) {
        throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "CAM manifest contains an invalid output identity");
      }
      manifestOutputs.push({
        logicalName: (output as { readonly logicalName: string }).logicalName,
        identity: identity as ContentIdentity
      });
    }
    const manifestNames = manifestOutputs.map((output) => output.logicalName);
    if (
      new Set(manifestNames).size !== manifestNames.length ||
      new Set(manifestOutputs.map((output) => output.identity.digest)).size !== manifestOutputs.length
    ) {
      throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "CAM manifest contains duplicate names or identities");
    }
    const expectedMediaType = (logicalName: string): string | undefined => {
      if (logicalName === "manufacturing/positions.csv") return "text/csv; charset=utf-8";
      if (/^manufacturing\/gerbers\/[a-zA-Z0-9._-]+\.gbr$/u.test(logicalName)) return "application/vnd.gerber";
      if (/^manufacturing\/gerbers\/[a-zA-Z0-9._-]+\.gbrjob$/u.test(logicalName)) return "application/json";
      if (/^manufacturing\/drill\/[a-zA-Z0-9._-]+\.drl$/u.test(logicalName)) return "application/x-excellon";
      if (/^manufacturing\/drill\/[a-zA-Z0-9._-]+\.rpt$/u.test(logicalName)) return "text/plain; charset=utf-8";
      if (/^manufacturing\/drill\/[a-zA-Z0-9._-]+\.svg$/u.test(logicalName)) return "image/svg+xml";
      return undefined;
    };
    const camArtifacts = await Promise.all(
      bindings.cam.artifacts.map((binding) => loadBinding(binding, "CAM output"))
    );
    for (const output of camArtifacts) {
      const mediaType = expectedMediaType(output.artifact.logicalName);
      if (mediaType === undefined) {
        throw new DomainError("INVALID_ARGUMENT", "CAM output binding uses a non-canonical path", {
          artifactId: output.artifact.id,
          logicalName: output.artifact.logicalName
        });
      }
      assertShape(output.artifact, {
        role: "CAM output",
        stage: "manufacturing_package",
        logicalName: output.artifact.logicalName,
        mediaType,
        adapter: "kicad_cli",
        toolName: "kicad-cli"
      });
    }
    if (
      !camArtifacts.some((output) => output.artifact.logicalName.endsWith(".gbr")) ||
      !camArtifacts.some((output) => output.artifact.logicalName.endsWith(".drl")) ||
      !camArtifacts.some((output) => output.artifact.logicalName === "manufacturing/positions.csv")
    ) {
      throw new DomainError("EVIDENCE_MISSING", "Complete CAM bindings require Gerber, drill, and position outputs");
    }
    const suppliedCamOutputs = [
      { logicalName: bom.artifact.logicalName, identity: bom.artifact.blob },
      ...camArtifacts.map(({ artifact }) => ({ logicalName: artifact.logicalName, identity: artifact.blob }))
    ].sort((left, right) => left.logicalName.localeCompare(right.logicalName, "en"));
    const sortedManifestOutputs = [...manifestOutputs].sort((left, right) =>
      left.logicalName.localeCompare(right.logicalName, "en")
    );
    if (canonicalJson(suppliedCamOutputs) !== canonicalJson(sortedManifestOutputs)) {
      throw new DomainError("DIGEST_MISMATCH", "Complete CAM bindings do not exactly match the current CAM manifest");
    }
    const currentCanonicalCamNames = revision.artifactIds
      .map((id) => state.artifacts[id])
      .filter((artifact): artifact is ArtifactRecord => artifact !== undefined)
      .map((artifact) => artifact.logicalName)
      .filter((logicalName) => expectedMediaType(logicalName) !== undefined)
      .sort((left, right) => left.localeCompare(right, "en"));
    const suppliedCamNames = camArtifacts
      .map(({ artifact }) => artifact.logicalName)
      .sort((left, right) => left.localeCompare(right, "en"));
    if (canonicalJson(currentCanonicalCamNames) !== canonicalJson(suppliedCamNames)) {
      throw new DomainError("EVIDENCE_MISSING", "CAM bindings omit a current-revision canonical CAM output");
    }

    const targetReport = await loadBinding(bindings.targetBuildReport, "target-build report");
    assertShape(targetReport.artifact, {
      role: "target-build report",
      stage: "firmware_contract",
      logicalName: "firmware/reports/stm32g0-target-build.json",
      mediaType: "application/json",
      adapter: "external"
    });
    const targetBinary = await loadBinding(bindings.targetBinary, "target-build BIN");
    assertShape(targetBinary.artifact, {
      role: "target-build BIN",
      stage: "firmware_contract",
      logicalName: "firmware/build/evleda-stm32g0b1cet6-candidate.bin",
      mediaType: "application/octet-stream",
      adapter: "external"
    });
    if (targetReport.artifact.designRevisionId !== targetBinary.artifact.designRevisionId) {
      throw new DomainError("DIGEST_MISMATCH", "Target-build report and BIN were not committed by the same firmware stage");
    }
    if (!sameToolIdentity(targetReport.artifact.tool, targetBinary.artifact.tool)) {
      throw new DomainError("DIGEST_MISMATCH", "Target-build report and BIN do not share the exact compiler identity");
    }
    const run = this.#run(state, revision.runId);
    const targetAttempt = run.attempts.firmware_contract.find(
      (attempt) =>
        attempt.state === "succeeded" &&
        attempt.artifactIds.includes(targetReport.artifact.id) &&
        attempt.artifactIds.includes(targetBinary.artifact.id) &&
        attempt.executionFence !== undefined
    );
    if (targetAttempt?.executionFence === undefined) {
      throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Target-build artifacts lack their firmware-stage execution fence");
    }
    const targetRevision = state.revisions[targetReport.artifact.designRevisionId];
    if (
      targetRevision === undefined ||
      !targetRevision.parentRevisionIds.includes(targetAttempt.executionFence.parentRevisionId) ||
      !targetRevision.artifactIds.includes(targetReport.artifact.id) ||
      !targetRevision.artifactIds.includes(targetBinary.artifact.id)
    ) {
      throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Target-build artifact revision does not reproduce the firmware execution fence");
    }
    let targetReportValue: unknown;
    try {
      targetReportValue = JSON.parse(targetReport.bytes.toString("utf8"));
    } catch {
      throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Target-build report is not JSON");
    }
    const reportExpectation: FirmwareTargetBuildReportExpectation = {
      projectId: revision.projectId,
      runId: revision.runId,
      sourceDesignRevisionId: targetAttempt.executionFence.parentRevisionId
    };
    if (!validateFirmwareTargetBuildReport(targetReportValue, reportExpectation)) {
      throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Target-build report failed strict provenance validation");
    }
    const report = targetReportValue as {
      readonly sourceRevision: {
        readonly projectId: string;
        readonly runId: string;
        readonly designRevisionId: string;
        readonly targetBuildSourceIdentity: CanonicalIdentity;
        readonly generatedSources: readonly { readonly logicalName: string; readonly identity: ContentIdentity }[];
      };
      readonly toolchain: {
        readonly provisionedConfigurationIdentity: CanonicalIdentity;
        readonly toolchainIdentity: CanonicalIdentity;
      };
      readonly outputs: readonly {
        readonly kind: "elf" | "bin" | "map";
        readonly logicalName: string;
        readonly mediaType: string;
        readonly identity: ContentIdentity;
      }[];
    };
    const loadReportArtifact = async (
      logicalName: string,
      identity: ContentIdentity,
      requireTargetTool: boolean
    ): Promise<ArtifactRecord> => {
      const matches = revision.artifactIds
        .map((id) => state.artifacts[id])
        .filter((artifact): artifact is ArtifactRecord =>
          artifact !== undefined &&
          artifact.logicalName === logicalName &&
          artifact.stage === "firmware_contract" &&
          artifact.designRevisionId === targetReport.artifact.designRevisionId &&
          artifact.projectId === revision.projectId &&
          artifact.runId === revision.runId &&
          artifact.validationStatus === "pass" &&
          artifact.staleAt === undefined &&
          (!requireTargetTool || sameToolIdentity(artifact.tool, targetReport.artifact.tool)) &&
          sameContentIdentity(artifact.blob, identity)
        );
      if (matches.length !== 1) {
        throw new DomainError("EVIDENCE_MISSING", "Target-build report references a missing or ambiguous committed artifact", {
          logicalName,
          count: matches.length
        });
      }
      await this.ports.content.get(matches[0]!.blob);
      return matches[0]!;
    };
    const committedOutputs = await Promise.all(
      report.outputs.map(async (output) => {
        const artifact = await loadReportArtifact(output.logicalName, output.identity, true);
        return { kind: output.kind, logicalName: artifact.logicalName, mediaType: artifact.mediaType, identity: artifact.blob };
      })
    );
    const committedSources = await Promise.all(
      report.sourceRevision.generatedSources.map(async (source) => {
        const artifact = await loadReportArtifact(source.logicalName, source.identity, false);
        return { logicalName: artifact.logicalName, identity: artifact.blob };
      })
    );
    const committedBin = committedOutputs.find((output) => output.kind === "bin");
    const committedArtifactIds = [
      ...report.outputs.map((output) => revision.artifactIds
        .map((id) => state.artifacts[id])
        .find((artifact) => artifact?.logicalName === output.logicalName)?.id),
      ...report.sourceRevision.generatedSources.map((source) => revision.artifactIds
        .map((id) => state.artifacts[id])
        .find((artifact) => artifact?.logicalName === source.logicalName)?.id)
    ];
    if (
      committedBin === undefined ||
      !sameContentIdentity(committedBin.identity, targetBinary.artifact.blob) ||
      targetBinary.artifact.id !== bindings.targetBinary.artifactId ||
      committedArtifactIds.some((id) => id === undefined || !targetAttempt.artifactIds.includes(id))
    ) {
      throw new DomainError("DIGEST_MISMATCH", "Target-build report BIN output does not match the explicitly bound BIN artifact");
    }
    if (!validateFirmwareTargetBuildReport(targetReportValue, {
      ...reportExpectation,
      targetBuildSourceIdentity: report.sourceRevision.targetBuildSourceIdentity,
      provisionedConfigurationIdentity: report.toolchain.provisionedConfigurationIdentity,
      toolchainIdentity: report.toolchain.toolchainIdentity,
      outputs: committedOutputs
    })) {
      throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Target-build report does not reproduce committed sources, outputs, and toolchain");
    }
    const requiredReportInputs = [
      report.sourceRevision.targetBuildSourceIdentity,
      report.toolchain.provisionedConfigurationIdentity,
      report.toolchain.toolchainIdentity,
      ...committedSources.map((source) => source.identity),
      ...committedOutputs.map((output) => output.identity)
    ];
    const reportInputKeys = new Set(targetReport.artifact.exactInputs.map((identity) => canonicalJson(identity)));
    const binaryInputKeys = new Set(targetBinary.artifact.exactInputs.map((identity) => canonicalJson(identity)));
    if (
      !requiredReportInputs.every((identity) => reportInputKeys.has(canonicalJson(identity))) ||
      !requiredReportInputs
        .slice(0, 3 + committedSources.length)
        .every((identity) => binaryInputKeys.has(canonicalJson(identity)))
    ) {
      throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Target-build artifacts omit required source/configuration/toolchain exact inputs");
    }

    const procedure = await loadBinding(bindings.bringupProcedure, "bring-up procedure");
    assertShape(procedure.artifact, {
      role: "bring-up procedure",
      stage: "bringup_package",
      logicalName: "bringup/bringup-plan.json",
      mediaType: "application/json",
      adapter: "evleda",
      toolName: "evleda-deterministic-generators"
    });
    let procedureValue: unknown;
    try { procedureValue = JSON.parse(procedure.bytes.toString("utf8")); } catch { procedureValue = undefined; }
    const parsedPlan = bringupPlanSchema.safeParse(procedureValue);
    if (!parsedPlan.success) {
      throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Bring-up procedure failed strict v2 validation");
    }

    const acceptance = await loadBinding(bindings.acceptance, "physical acceptance contract");
    assertShape(acceptance.artifact, {
      role: "physical acceptance contract",
      stage: "bringup_package",
      logicalName: "bringup/physical-acceptance.json",
      mediaType: "application/json",
      adapter: "evleda",
      toolName: "evleda-deterministic-generators"
    });
    let acceptanceValue: unknown;
    try { acceptanceValue = JSON.parse(acceptance.bytes.toString("utf8")); } catch { acceptanceValue = undefined; }
    const parsedAcceptance = physicalAcceptanceContractSchema.safeParse(acceptanceValue);
    if (!parsedAcceptance.success) {
      throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Physical acceptance contract failed strict validation");
    }
    const targetBuild: PhysicalTargetBuildBinding = {
      projectId: report.sourceRevision.projectId,
      runId: report.sourceRevision.runId,
      designRevisionId: report.sourceRevision.designRevisionId,
      reportArtifact: bindings.targetBuildReport,
      binaryArtifact: bindings.targetBinary,
      binaryIdentity: targetBinary.artifact.blob,
      targetSourceRevisionDigest: report.sourceRevision.targetBuildSourceIdentity.digest,
      targetBuildSourceIdentity: report.sourceRevision.targetBuildSourceIdentity,
      targetConfigurationIdentity: report.toolchain.provisionedConfigurationIdentity,
      targetToolchainIdentity: report.toolchain.toolchainIdentity,
      targetCompiledSources: committedSources
    };
    return {
      plan: parsedPlan.data,
      acceptanceContract: parsedAcceptance.data,
      targetBuild
    };
  }

  async #physicalSourceArchiveMatches(
    bytes: Buffer,
    record: HumanPhysicalEvidenceRecord
  ): Promise<boolean> {
    const sourceIds = record.sourceBlobs.map((source) => source.id.toLocaleLowerCase("en-US"));
    const sourceDigests = record.sourceBlobs.map((source) => source.identity.digest);
    const sourcePaths = record.sourceBlobs.map((source) => source.archivePath);
    if (
      new Set(sourceIds).size !== sourceIds.length ||
      new Set(sourceDigests).size !== sourceDigests.length ||
      new Set(sourcePaths).size !== sourcePaths.length
    ) {
      return false;
    }
    let archive: ReturnType<typeof unzipSync>;
    try {
      archive = unzipSync(bytes);
    } catch {
      return false;
    }
    const expectedManifest = Buffer.from(
      `${canonicalJson({
        schemaVersion: "evleda.physical-source-archive.v1",
        sourceBlobs: record.sourceBlobs
      })}\n`,
      "utf8"
    );
    const expectedPaths = new Set([
      "manifest.json",
      ...record.sourceBlobs.map((source) => source.archivePath)
    ]);
    const archivePaths = Object.keys(archive);
    if (
      archivePaths.length !== expectedPaths.size ||
      archivePaths.some((archivePath) => !expectedPaths.has(archivePath)) ||
      archive["manifest.json"] === undefined ||
      !Buffer.from(archive["manifest.json"]).equals(expectedManifest)
    ) {
      return false;
    }
    for (const source of record.sourceBlobs) {
      const archiveBytes = archive[source.archivePath];
      if (
        source.archivePath !== this.#physicalArchivePath(source.identity) ||
        source.policyValidUntil !== record.validUntil ||
        archiveBytes === undefined ||
        !sameContentIdentity(contentIdentity(archiveBytes), source.identity)
      ) {
        return false;
      }
      const stored = await this.ports.content.get(source.identity);
      if (!stored.equals(Buffer.from(archiveBytes))) {
        return false;
      }
    }
    return true;
  }

  async #passingPhysicalEvidence(
    state: EvlEdaState,
    revision: DesignRevision,
    evidence: readonly EvidenceRecord[],
    now: Date
  ): Promise<EvidenceRecord | undefined> {
    const physicalEntries = evidence
      .filter((entry) => entry.evidenceClass === "human_physical")
      .sort((left, right) => left.id.localeCompare(right.id, "en"));
    if (physicalEntries.length === 0) return undefined;
    let passing: EvidenceRecord | undefined;
    for (const entry of physicalEntries) {
      if (
        entry.designRevisionId !== revision.id ||
        entry.stage !== "bringup_package" ||
        entry.validationStatus !== "pass" ||
        entry.lifecycle !== "candidate" ||
        entry.unresolvedAssumptions.length !== 0 ||
        entry.tool.name !== "human-physical-evidence" ||
        entry.tool.version !== "3" ||
        entry.tool.adapter !== "human" ||
        entry.tool.capabilityProfile !== "procedure-case-bound-derived-physical-evidence-v3" ||
        !evidenceIsCurrent(entry, now) ||
        entry.rawArtifactId === undefined ||
        entry.parsedArtifactId === undefined
      ) {
        return undefined;
      }
      const rawArtifact = state.artifacts[entry.rawArtifactId];
      const parsedArtifact = state.artifacts[entry.parsedArtifactId];
      if (
        rawArtifact === undefined ||
        parsedArtifact === undefined ||
        rawArtifact.designRevisionId !== revision.id ||
        parsedArtifact.designRevisionId !== revision.id ||
        rawArtifact.stage !== "bringup_package" ||
        parsedArtifact.stage !== "bringup_package" ||
        rawArtifact.mediaType !== "application/zip" ||
        parsedArtifact.mediaType !== "application/json" ||
        rawArtifact.validationStatus !== "pass" ||
        parsedArtifact.validationStatus !== "pass" ||
        rawArtifact.staleAt !== undefined ||
        parsedArtifact.staleAt !== undefined ||
        rawArtifact.lifecycle !== "candidate" ||
        parsedArtifact.lifecycle !== "candidate" ||
        rawArtifact.tool.name !== "human-physical-evidence" ||
        parsedArtifact.tool.name !== "human-physical-evidence" ||
        rawArtifact.tool.version !== "3" ||
        parsedArtifact.tool.version !== "3" ||
        rawArtifact.tool.adapter !== "human" ||
        parsedArtifact.tool.adapter !== "human" ||
        rawArtifact.tool.capabilityProfile !== "procedure-case-bound-derived-physical-evidence-v3" ||
        parsedArtifact.tool.capabilityProfile !== "procedure-case-bound-derived-physical-evidence-v3" ||
        !sameToolIdentity(rawArtifact.tool, parsedArtifact.tool) ||
        !sameToolIdentity(rawArtifact.tool, entry.tool)
      ) {
        return undefined;
      }
      const [rawBytes, parsedBytes] = await Promise.all([
        this.ports.content.get(rawArtifact.blob),
        this.ports.content.get(parsedArtifact.blob)
      ]);
      let unknownRecord: unknown;
      try {
        unknownRecord = JSON.parse(parsedBytes.toString("utf8"));
      } catch {
        return undefined;
      }
      const parsedRecord = humanPhysicalEvidenceRecordSchema.safeParse(unknownRecord);
      if (!parsedRecord.success) return undefined;
      const record = parsedRecord.data;
      const sourceBytes = new Map<string, Buffer>();
      for (const source of record.sourceBlobs) {
        sourceBytes.set(source.id, await this.ports.content.get(source.identity));
      }
      const parseRecordSource = <Value>(
        sourceId: string,
        schema: { safeParse(value: unknown): { success: true; data: Value } | { success: false } }
      ): Value | undefined => {
        const bytes = sourceBytes.get(sourceId);
        if (bytes === undefined) return undefined;
        try {
          const result = schema.safeParse(JSON.parse(bytes.toString("utf8")));
          return result.success ? result.data : undefined;
        } catch {
          return undefined;
        }
      };
      const asBuiltRecord = parseRecordSource(record.primarySourceIds.asBuiltRecord, physicalAsBuiltRecordSchema);
      const firmwareFlashRecord = parseRecordSource(record.primarySourceIds.firmwareFlashRecord, physicalFirmwareFlashRecordSchema);
      const measurementRecord = parseRecordSource(record.primarySourceIds.measurementRecord, physicalMeasurementRecordSchema);
      const instruments = record.instruments.map((instrument) => ({
        id: instrument.id,
        calibrationSourceId: instrument.calibrationSourceId,
        calibration: parseRecordSource(instrument.calibrationSourceId, physicalInstrumentCalibrationRecordSchema)
      }));
      if (
        asBuiltRecord === undefined || firmwareFlashRecord === undefined || measurementRecord === undefined ||
        instruments.some((instrument) => instrument.calibration === undefined)
      ) return undefined;
      let resolvedPhysical: ResolvedPhysicalArtifactBindings;
      try {
        resolvedPhysical = await this.#assertPhysicalArtifactBindings(state, revision, record.artifactBindings);
      } catch (error) {
        if (error instanceof DomainError && error.code !== "ARTIFACT_INTEGRITY_ERROR") return undefined;
        throw error;
      }
      if (
        canonicalJson(resolvedPhysical.plan) !== canonicalJson(record.bringupPlan) ||
        canonicalJson(resolvedPhysical.acceptanceContract) !== canonicalJson(record.acceptanceContract) ||
        canonicalJson(asBuiltRecord) !== canonicalJson(record.asBuiltRecord) ||
        canonicalJson(firmwareFlashRecord) !== canonicalJson(record.firmwareFlashRecord) ||
        canonicalJson(measurementRecord) !== canonicalJson(record.measurementRecord) ||
        instruments.some((instrument, index) =>
          canonicalJson(instrument.calibration) !== canonicalJson(record.instruments[index]?.calibration)
        )
      ) return undefined;
      let evaluated: { readonly results: DerivedPhysicalResultsV3; readonly validUntil: string };
      try {
        evaluated = evaluatePhysicalEvidence({
          revision,
          bindings: record.artifactBindings,
          targetBuild: resolvedPhysical.targetBuild,
          plan: resolvedPhysical.plan,
          sources: record.sourceBlobs,
          primarySourceIds: record.primarySourceIds,
          acceptanceContract: resolvedPhysical.acceptanceContract,
          asBuiltRecord,
          firmwareFlashRecord,
          measurementRecord,
          instruments: instruments as readonly { readonly id: string; readonly calibrationSourceId: string; readonly calibration: PhysicalInstrumentCalibrationRecord }[],
          now
        });
      } catch (error) {
        if (error instanceof DomainError && error.code !== "ARTIFACT_INTEGRITY_ERROR") return undefined;
        throw error;
      }
      if (
        record.projectId !== revision.projectId ||
        record.runId !== revision.runId ||
        record.designRevisionId !== revision.id ||
        canonicalJson(record.revisionManifest) !== canonicalJson(revision.manifest) ||
        record.results.overallVerdict !== "pass" ||
        canonicalJson(record.results) !== canonicalJson(evaluated.results) ||
        record.validUntil !== evaluated.validUntil ||
        entry.validUntil !== record.validUntil ||
        entry.createdAt !== record.recordedAt ||
        rawArtifact.createdAt !== record.recordedAt ||
        parsedArtifact.createdAt !== record.recordedAt ||
        Date.parse(record.measurementRecord.completedAt) > Date.parse(record.recordedAt) ||
        Date.parse(record.validUntil) <= now.getTime()
      ) {
        return undefined;
      }
      if (!(await this.#physicalSourceArchiveMatches(rawBytes, record))) return undefined;
      const requiredIdentities = this.#uniqueIdentities([
        revision.manifest,
        record.evidenceRootBefore,
        ...this.#physicalBindingList(record.artifactBindings).map((binding) => binding.identity),
        ...record.sourceBlobs.map((source) => source.identity)
      ]);
      const requiredIdentityKeys = requiredIdentities.map(
        (identity) => canonicalJson(identity)
      );
      const rawInputKeys = new Set(rawArtifact.exactInputs.map((identity) => canonicalJson(identity)));
      const parsedInputKeys = new Set(parsedArtifact.exactInputs.map((identity) => canonicalJson(identity)));
      const evidenceInputKeys = new Set(entry.exactInputs.map((identity) => canonicalJson(identity)));
      const requiredDigests = [
        revision.manifest.digest,
        record.evidenceRootBefore.digest,
        ...this.#physicalBindingList(record.artifactBindings).map((binding) => binding.identity.digest),
        ...record.sourceBlobs.map((source) => source.identity.digest),
        rawArtifact.blob.digest,
        parsedArtifact.blob.digest
      ];
      const derivedFrom = new Set(
        this.#physicalBindingList(record.artifactBindings).map((binding) => binding.artifactId)
      );
      if (
        !requiredIdentityKeys.every(
          (key) => rawInputKeys.has(key) && parsedInputKeys.has(key) && evidenceInputKeys.has(key)
        ) ||
        !requiredDigests.every((digest) => entry.subjectDigests.includes(digest)) ||
        rawArtifact.derivedFrom.some((id) => !derivedFrom.has(id)) ||
        parsedArtifact.derivedFrom.some((id) => !derivedFrom.has(id)) ||
        rawArtifact.derivedFrom.length !== derivedFrom.size ||
        parsedArtifact.derivedFrom.length !== derivedFrom.size
      ) {
        return undefined;
      }
      passing = entry;
    }
    return passing;
  }

  #evidenceForRevision(state: EvlEdaState, revision: DesignRevision): readonly EvidenceRecord[] {
    const ancestry = this.#revisionAncestry(state, revision);
    if (revision.evidenceIds.length !== new Set(revision.evidenceIds).size) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Revision manifest contains duplicate evidence IDs",
        { revisionId: revision.id }
      );
    }
    const ids = uniqueSorted([
      ...revision.evidenceIds,
      ...Object.entries(recordMap<EvidenceRecord>(state.evidence))
        .filter(([, entry]) => entry.designRevisionId === revision.id)
        .map(([id]) => id)
    ]);
    return ids.map((id) => {
      const entry = state.evidence[id];
      if (
        entry === undefined ||
        entry.id !== id ||
        entry.projectId !== revision.projectId ||
        entry.runId !== revision.runId ||
        !ancestry.has(entry.designRevisionId)
      ) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Revision evidence is missing or belongs to another project/run",
          { evidenceId: id, revisionId: revision.id }
        );
      }
      return entry;
    });
  }

  #resolveRevisionProjection(
    state: EvlEdaState,
    revision: DesignRevision
  ): RevisionEvidenceProjection {
    const run = this.#run(state, revision.runId);
    const project = this.#project(state, revision.projectId);
    if (run.projectId !== project.id || revision.projectId !== project.id) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Revision, run, and project identities do not agree",
        { revisionId: revision.id, runId: run.id, projectId: project.id }
      );
    }
    if (revision.artifactIds.length !== new Set(revision.artifactIds).size) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Revision manifest contains duplicate artifact IDs",
        { revisionId: revision.id }
      );
    }
    const ancestry = this.#revisionAncestry(state, revision);
    const evidence = this.#evidenceForRevision(state, revision);
    const artifactIds = uniqueSorted([
      ...revision.artifactIds,
      ...evidence.flatMap((entry) => [
        ...(entry.rawArtifactId === undefined ? [] : [entry.rawArtifactId]),
        ...(entry.parsedArtifactId === undefined ? [] : [entry.parsedArtifactId])
      ])
    ]);
    const artifacts = artifactIds.map((id) => {
      const artifact = state.artifacts[id];
      if (artifact === undefined) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Revision projection references a missing artifact",
          { revisionId: revision.id, artifactId: id }
        );
      }
      if (
        artifact.id !== id ||
        artifact.projectId !== revision.projectId ||
        artifact.runId !== revision.runId ||
        !ancestry.has(artifact.designRevisionId)
      ) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Revision projection contains an artifact outside the project, run, or revision ancestry",
          {
            revisionId: revision.id,
            artifactId: id,
            storedArtifactId: artifact.id,
            artifactProjectId: artifact.projectId,
            artifactRunId: artifact.runId,
            artifactDesignRevisionId: artifact.designRevisionId
          }
        );
      }
      return artifact;
    });
    return {
      ancestry,
      artifacts,
      evidence,
      evidenceRoot: this.#evidenceRoot(evidence)
    };
  }

  async #assertRevisionExportable(
    state: EvlEdaState,
    revision: DesignRevision,
    options: { readonly gatePostRevisionEvidence?: boolean } = {}
  ): Promise<RevisionEvidenceProjection> {
    const run = this.#run(state, revision.runId);
    if (run.headRevisionId !== revision.id) {
      throw new DomainError(
        "REVISION_CONFLICT",
        "Only the current run head can be exported",
        { requestedRevisionId: revision.id, headRevisionId: run.headRevisionId }
      );
    }
    const missingStages = STAGE_ORDER.filter(
      (stage) => activeSuccessfulAttempt(run.attempts[stage]) === undefined
    );
    if (run.state !== "completed" || missingStages.length > 0) {
      throw new DomainError(
        "GATE_FAILED",
        "Candidate export requires a completed current revision across all nine workflow stages",
        { runId: run.id, runState: run.state, missingStages }
      );
    }
    const revisionArtifactIds = new Set(revision.artifactIds);
    const revisionEvidenceIds = new Set(revision.evidenceIds);
    const activeArtifactIds = new Set<string>();
    const activeEvidenceIds = new Set<string>();
    for (const stage of STAGE_ORDER) {
      const attempt = activeSuccessfulAttempt(run.attempts[stage])!;
      if (
        attempt.artifactIds.some((id) => !revisionArtifactIds.has(id)) ||
        attempt.evidenceIds.some((id) => !revisionEvidenceIds.has(id))
      ) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Current revision does not include every active stage output",
          { stage, attemptId: attempt.id, revisionId: revision.id }
        );
      }
      for (const id of attempt.artifactIds) activeArtifactIds.add(id);
      for (const id of attempt.evidenceIds) activeEvidenceIds.add(id);
    }
    const projection = this.#resolveRevisionProjection(state, revision);
    const artifactById = new Map(projection.artifacts.map((artifact) => [artifact.id, artifact]));
    const evidenceById = new Map(projection.evidence.map((entry) => [entry.id, entry]));
    const activeArtifacts = uniqueSorted([...activeArtifactIds]).map((id) => {
      const artifact = artifactById.get(id);
      if (artifact === undefined) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Active stage artifact is missing from the resolved revision projection",
          { artifactId: id, revisionId: revision.id }
        );
      }
      return artifact;
    });
    const activeEvidence = uniqueSorted([...activeEvidenceIds]).map((id) => {
      const entry = evidenceById.get(id);
      if (entry === undefined) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Active stage evidence is missing from the resolved revision projection",
          { evidenceId: id, revisionId: revision.id }
        );
      }
      return entry;
    });
    const now = this.#now();
    const gatePostRevisionEvidence = options.gatePostRevisionEvidence ?? true;
    const gatedArtifacts = gatePostRevisionEvidence
      ? projection.artifacts
      : projection.artifacts.filter((artifact) => revisionArtifactIds.has(artifact.id));
    const gatedEvidence = gatePostRevisionEvidence
      ? projection.evidence
      : projection.evidence.filter((entry) => revisionEvidenceIds.has(entry.id));
    const invalidArtifacts = gatedArtifacts.filter(
      (artifact) =>
        artifact.staleAt !== undefined ||
        ["fail", "error", "unsupported", "stale", "revoked"].includes(
          artifact.validationStatus
        ) ||
        artifact.unresolvedAssumptions.some((assumption) => assumption.severity === "blocking")
    );
    const invalidEvidence = gatedEvidence.filter(
      (entry) =>
        !evidenceIsCurrent(entry, now) ||
        ["fail", "error", "unsupported", "stale", "revoked"].includes(
          entry.validationStatus
        ) ||
        ((entry.evidenceClass === "kicad_native" || entry.evidenceClass === "evleda_check") &&
          entry.validationStatus === "not_run") ||
        entry.unresolvedAssumptions.some((assumption) => assumption.severity === "blocking")
    );
    if (invalidArtifacts.length > 0 || invalidEvidence.length > 0) {
      throw new DomainError(
        "GATE_FAILED",
        "Current revision contains failed, stale, unsupported, or blocking outputs",
        {
          artifactIds: uniqueSorted(invalidArtifacts.map((artifact) => artifact.id)),
          evidenceIds: uniqueSorted(invalidEvidence.map((entry) => entry.id))
        }
      );
    }
    const nativeAdapter = (artifact: ArtifactRecord): boolean =>
      artifact.tool.adapter === "kicad_cli" || artifact.tool.adapter === "kicad_mcp";
    const artifactName = (artifact: ArtifactRecord): string =>
      artifact.logicalName.toLocaleLowerCase("en-US");
    const requiredInventory: readonly [string, (artifact: ArtifactRecord) => boolean][] = [
      ["KiCad project", (artifact) => nativeAdapter(artifact) && artifactName(artifact).endsWith(".kicad_pro")],
      ["KiCad schematic", (artifact) => nativeAdapter(artifact) && artifactName(artifact).endsWith(".kicad_sch")],
      ["KiCad PCB", (artifact) => nativeAdapter(artifact) && artifactName(artifact).endsWith(".kicad_pcb")],
      ["BOM", (artifact) => artifact.tool.adapter === "kicad_cli" && /(?:^|\/)(?:[^/]*bom[^/]*)\.(?:csv|json)$/u.test(artifactName(artifact))],
      ["Gerber", (artifact) => artifact.tool.adapter === "kicad_cli" && (artifactName(artifact).endsWith(".gbr") || artifactName(artifact).includes("gerber"))],
      ["drill", (artifact) => artifact.tool.adapter === "kicad_cli" && (artifactName(artifact).endsWith(".drl") || artifactName(artifact).includes("drill"))],
      ["pick-and-place/position", (artifact) => artifact.tool.adapter === "kicad_cli" && /(?:position|pick.?and.?place|pnp)/u.test(artifactName(artifact))],
      ["CAM manifest", (artifact) => artifact.tool.adapter === "kicad_cli" && /cam[-_]?manifest/u.test(artifactName(artifact))],
      ["render", (artifact) => nativeAdapter(artifact) && (/render/u.test(artifactName(artifact)) || /\.(?:png|svg|pdf)$/u.test(artifactName(artifact)))],
      ["firmware contract", (artifact) => artifactName(artifact) === "firmware/board-contract.json"],
      ["firmware source", (artifact) => /^firmware\/(?:src|include)\//u.test(artifactName(artifact))],
      ["bring-up plan", (artifact) => /^bringup\/bringup-plan\.(?:json|md)$/u.test(artifactName(artifact))]
    ];
    const missingInventory = requiredInventory
      .filter(([, predicate]) => !activeArtifacts.some((artifact) => artifact.validationStatus === "pass" && predicate(artifact)))
      .map(([label]) => label);
    const activeInputByStage = new Map(
      STAGE_ORDER.map((stage) => [stage, activeSuccessfulAttempt(run.attempts[stage])!.inputManifest.digest])
    );
    const reportPathHasKind = (logicalName: string, kind: string): boolean => {
      const normalized = logicalName
        .normalize("NFC")
        .toLocaleLowerCase("en-US")
        .replace(/[^a-z0-9]+/gu, "_");
      return new RegExp(`(?:^|_)${kind}(?:_|$)`, "u").test(normalized);
    };
    type ReportStage = (typeof REPORT_STAGE_KEYS)[number];
    const reportKey = (stage: ReportStage, kind: KicadReportKind): string =>
      `${stage}:${kind}`;
    const invalidReportEvidenceIds = new Set<string>();
    const nativeReportCandidates = new Map<string, EvidenceRecord[]>();
    const derivedReportCandidates = new Map<string, EvidenceRecord[]>();
    const approvedAnalyzerTools = Object.values(REFERENCE_KICAD_ANALYZER_TOOLS);
    for (const stage of REPORT_STAGE_KEYS) {
      const expected = REQUIRED_KICAD_REPORTS_BY_STAGE[stage];
      for (const entry of activeEvidence.filter((candidate) => candidate.stage === stage)) {
        const nativeClaim = claimedNativeReport(entry);
        if (nativeClaim !== undefined) {
          if (
            entry.evidenceClass !== "kicad_native" ||
            !(expected.native as readonly KicadNativeReportKind[]).includes(nativeClaim.kind)
          ) {
            invalidReportEvidenceIds.add(entry.id);
          } else {
            const key = reportKey(stage, nativeClaim.kind);
            nativeReportCandidates.set(key, [
              ...(nativeReportCandidates.get(key) ?? []),
              entry
            ]);
          }
        } else if (entry.evidenceClass === "kicad_native") {
          invalidReportEvidenceIds.add(entry.id);
        }

        const derivedClaim = claimedDerivedReport(entry);
        if (derivedClaim !== undefined) {
          if (
            entry.evidenceClass !== "evleda_check" ||
            !(expected.derived as readonly KicadEvledaCheckReportKind[]).includes(
              derivedClaim.kind
            )
          ) {
            invalidReportEvidenceIds.add(entry.id);
          } else {
            const key = reportKey(stage, derivedClaim.kind);
            derivedReportCandidates.set(key, [
              ...(derivedReportCandidates.get(key) ?? []),
              entry
            ]);
          }
        } else if (
          entry.evidenceClass === "evleda_check" &&
          approvedAnalyzerTools.some((tool) => sameToolIdentity(entry.tool, tool))
        ) {
          invalidReportEvidenceIds.add(entry.id);
        }
      }
    }

    const validNativeReport = (
      entry: EvidenceRecord,
      stage: ReportStage,
      kind: KicadNativeReportKind
    ): ArtifactRecord | undefined => {
      const authority = authorityIdentities(
        entry.exactInputs,
        KICAD_CLI_REPORT_AUTHORITY_SCHEMA
      );
      if (
        entry.stage !== stage ||
        entry.evidenceClass !== "kicad_native" ||
        entry.validationStatus !== "pass" ||
        nativeReportClaimDigest(entry, kind) === undefined ||
        entry.tool.adapter !== "kicad_cli" ||
        entry.tool.name.length === 0 ||
        entry.tool.version.length === 0 ||
        typeof entry.tool.executablePath !== "string" ||
        entry.tool.executablePath.length === 0 ||
        typeof entry.tool.executableDigest !== "string" ||
        !/^[0-9a-f]{64}$/u.test(entry.tool.executableDigest) ||
        entry.rawArtifactId === undefined ||
        entry.parsedArtifactId !== undefined ||
        entry.subjectDigests.length !== 1 ||
        authority.length !== 1 ||
        authorityIdentities(entry.exactInputs, KICAD_ANALYZER_REPORT_AUTHORITY_SCHEMA).length !== 0 ||
        !entry.exactInputs.some((identity) => identity.digest === activeInputByStage.get(entry.stage))
      ) {
        return undefined;
      }
      const raw = artifactById.get(entry.rawArtifactId);
      if (
        raw === undefined ||
        !activeArtifactIds.has(raw.id) ||
        raw.stage !== stage ||
        raw.validationStatus !== "pass" ||
        !sameToolIdentity(raw.tool, entry.tool) ||
        raw.derivedFrom.length !== 0 ||
        entry.subjectDigests[0] !== raw.blob.digest ||
        !raw.exactInputs.some((identity) => identity.digest === activeInputByStage.get(entry.stage)) ||
        !sameExactInputList(entry.exactInputs, raw.exactInputs) ||
        authorityIdentities(raw.exactInputs, KICAD_CLI_REPORT_AUTHORITY_SCHEMA).length !== 1 ||
        !exactInputIncludes(raw.exactInputs, authority[0]!)
      ) {
        return undefined;
      }
      return raw;
    };

    const missingNativeReports: string[] = [];
    const missingDerivedReports: string[] = [];
    const duplicateReports: string[] = [];
    const validNativeArtifacts = new Map<
      string,
      { readonly entry: EvidenceRecord; readonly kind: KicadNativeReportKind }
    >();
    for (const stage of REPORT_STAGE_KEYS) {
      for (const kind of REQUIRED_KICAD_REPORTS_BY_STAGE[stage].native) {
        const key = reportKey(stage, kind);
        const candidates = nativeReportCandidates.get(key) ?? [];
        if (candidates.length !== 1) {
          if (candidates.length === 0) missingNativeReports.push(key);
          else duplicateReports.push(key);
          for (const candidate of candidates) invalidReportEvidenceIds.add(candidate.id);
          continue;
        }
        const candidate = candidates[0]!;
        const artifact = validNativeReport(candidate, stage, kind);
        if (artifact === undefined) {
          missingNativeReports.push(key);
          invalidReportEvidenceIds.add(candidate.id);
          continue;
        }
        validNativeArtifacts.set(artifact.id, { entry: candidate, kind });
      }
    }

    const artifactBindingMatchesKind = (
      kind: KicadEvledaCheckReportKind,
      artifact: ArtifactRecord
    ): boolean => {
      const logicalName = artifactName(artifact);
      switch (kind) {
        case "connectivity":
        case "schematic_parity":
          return true;
        case "geometry":
        case "pcb_practices":
          return logicalName.endsWith(".kicad_pcb");
        case "bom_parity":
        case "bom_export":
          return /(?:^|\/)(?:[^/]*bom[^/]*)\.(?:csv|json)$/u.test(logicalName);
        case "gerber_export":
          return logicalName.endsWith(".gbr") || logicalName.includes("gerber");
        case "drill_export":
          return logicalName.endsWith(".drl") || logicalName.includes("drill");
        case "position_export":
          return /(?:position|pick.?and.?place|pnp)/u.test(logicalName);
        case "cam_manifest":
          return /cam[-_]?manifest/u.test(logicalName);
      }
    };

    const validDerivedReport = async (
      entry: EvidenceRecord,
      stage: ReportStage,
      kind: KicadEvledaCheckReportKind
    ): Promise<boolean> => {
      const approvedTool = REFERENCE_KICAD_ANALYZER_TOOLS[kind];
      const claim = claimedDerivedReport(entry);
      if (
        entry.stage !== stage ||
        entry.evidenceClass !== "evleda_check" ||
        entry.validationStatus !== "pass" ||
        claim?.kind !== kind ||
        claim.analyzerId !== approvedTool.capabilityProfile ||
        derivedReportClaimDigest(entry, kind) !== claim.sourceRevisionDigest ||
        !sameToolIdentity(entry.tool, approvedTool) ||
        entry.rawArtifactId !== undefined ||
        entry.parsedArtifactId === undefined ||
        entry.subjectDigests.length !== 1 ||
        !entry.exactInputs.some((identity) => identity.digest === activeInputByStage.get(entry.stage))
      ) {
        return false;
      }
      const parsed = artifactById.get(entry.parsedArtifactId);
      if (
        parsed === undefined ||
        !activeArtifactIds.has(parsed.id) ||
        parsed.stage !== stage ||
        parsed.validationStatus !== "pass" ||
        parsed.mediaType !== "application/json" ||
        !sameToolIdentity(parsed.tool, approvedTool) ||
        entry.subjectDigests[0] !== parsed.blob.digest ||
        !sameExactInputList(entry.exactInputs, parsed.exactInputs)
      ) {
        return false;
      }

      let document: Readonly<Record<string, unknown>>;
      try {
        const bytes = await this.ports.content.get(parsed.blob);
        const value = JSON.parse(bytes.toString("utf8")) as unknown;
        if (!isRecordValue(value)) return false;
        document = value;
      } catch {
        return false;
      }
      const authority = document.authority;
      if (
        document.schemaVersion !== REFERENCE_KICAD_REPORT_SCHEMA ||
        document.kind !== kind ||
        document.validationStatus !== "pass" ||
        document.sourceRevisionDigest !== claim.sourceRevisionDigest ||
        !isRecordValue(authority) ||
        authority.kind !== "evleda_analyzer" ||
        authority.analyzerId !== approvedTool.capabilityProfile ||
        !isRecordValue(authority.tool) ||
        !sameToolIdentity(authority.tool as unknown as ToolIdentity, approvedTool) ||
        !Array.isArray(authority.inputBindings)
      ) {
        return false;
      }
      const expectedAuthority = canonicalIdentity(
        authority,
        KICAD_ANALYZER_REPORT_AUTHORITY_SCHEMA
      );
      const storedAuthority = authorityIdentities(
        entry.exactInputs,
        KICAD_ANALYZER_REPORT_AUTHORITY_SCHEMA
      );
      if (
        storedAuthority.length !== 1 ||
        !exactInputIncludes(storedAuthority, expectedAuthority) ||
        authorityIdentities(entry.exactInputs, KICAD_CLI_REPORT_AUTHORITY_SCHEMA).length !== 0 ||
        authorityIdentities(parsed.exactInputs, KICAD_ANALYZER_REPORT_AUTHORITY_SCHEMA).length !== 1 ||
        !exactInputIncludes(parsed.exactInputs, expectedAuthority)
      ) {
        return false;
      }

      const bindingKeys = new Set<string>();
      const boundArtifactIds = new Set<string>();
      const artifactBindings: ArtifactRecord[] = [];
      const sourceBindings: { readonly logicalName: string; readonly identity: ContentIdentity }[] = [];
      const nativeBindingKinds = new Set<KicadNativeReportKind>();
      let nativeBindingCount = 0;
      let sourceBindingCount = 0;
      for (const value of authority.inputBindings) {
        if (
          !isRecordValue(value) ||
          !["artifact", "native_report", "source"].includes(String(value.kind)) ||
          typeof value.logicalName !== "string"
        ) {
          return false;
        }
        const identity = contentIdentityValue(value.identity);
        if (identity === undefined || !exactInputIncludes(entry.exactInputs, identity)) {
          return false;
        }
        const bindingKey = `${String(value.kind)}:${value.logicalName}:${canonicalJson(identity)}`;
        if (bindingKeys.has(bindingKey)) return false;
        bindingKeys.add(bindingKey);
        if (value.kind === "source") {
          sourceBindingCount += 1;
          sourceBindings.push({ logicalName: value.logicalName, identity });
          continue;
        }
        const matchingArtifacts = activeArtifacts.filter(
          (artifact) =>
            artifact.id !== parsed.id &&
            artifact.logicalName === value.logicalName &&
            sameContentIdentity(artifact.blob, identity)
        );
        if (matchingArtifacts.length !== 1) return false;
        const boundArtifact = matchingArtifacts[0]!;
        if (value.kind === "native_report") {
          const native = validNativeArtifacts.get(boundArtifact.id);
          if (native === undefined || native.entry.stage !== stage) return false;
          nativeBindingCount += 1;
          nativeBindingKinds.add(native.kind);
        } else {
          if (boundArtifact.stage !== stage || validNativeArtifacts.has(boundArtifact.id)) {
            return false;
          }
          artifactBindings.push(boundArtifact);
        }
        boundArtifactIds.add(boundArtifact.id);
      }
      if (
        nativeBindingCount === 0 ||
        sourceBindingCount === 0 ||
        parsed.derivedFrom.length !== boundArtifactIds.size ||
        parsed.derivedFrom.some((artifactId) => !boundArtifactIds.has(artifactId))
      ) {
        return false;
      }
      if (
        !["connectivity", "schematic_parity"].includes(kind) &&
        !artifactBindings.some((artifact) => artifactBindingMatchesKind(kind, artifact))
      ) {
        return false;
      }
      if (
        kind === "pcb_practices" &&
        (nativeBindingKinds.size !== 2 ||
          !nativeBindingKinds.has("drc") ||
          !nativeBindingKinds.has("board_statistics") ||
          artifactBindings.filter((artifact) => artifactName(artifact).endsWith(".kicad_pcb"))
            .length !== 1 ||
          sourceBindings.filter((binding) =>
            binding.logicalName.toLocaleLowerCase("en-US").endsWith(".kicad_pcb")
          ).length !== 1)
      ) {
        return false;
      }
      if (kind === "pcb_practices") {
        const pcbArtifact = artifactBindings.find((artifact) =>
          artifactName(artifact).endsWith(".kicad_pcb")
        )!;
        const pcbSource = sourceBindings.find((binding) =>
          binding.logicalName.toLocaleLowerCase("en-US").endsWith(".kicad_pcb")
        )!;
        if (!sameContentIdentity(pcbSource.identity, pcbArtifact.blob)) return false;
      }
      return true;
    };

    for (const stage of REPORT_STAGE_KEYS) {
      for (const kind of REQUIRED_KICAD_REPORTS_BY_STAGE[stage].derived) {
        const key = reportKey(stage, kind);
        const candidates = derivedReportCandidates.get(key) ?? [];
        if (candidates.length !== 1) {
          if (candidates.length === 0) missingDerivedReports.push(key);
          else duplicateReports.push(key);
          for (const candidate of candidates) invalidReportEvidenceIds.add(candidate.id);
          continue;
        }
        const candidate = candidates[0]!;
        if (!(await validDerivedReport(candidate, stage, kind))) {
          missingDerivedReports.push(key);
          invalidReportEvidenceIds.add(candidate.id);
        }
      }
    }
    const simulationCoverage = [
      "power_tree_operating_points",
      "logic_rail_load_budget",
      "motor_current_chop",
      "motor_driver_thermal",
      "fault_and_reset"
    ] as const;
    const validSimulationEvidence = (entry: EvidenceRecord, coverage: string): boolean => {
      if (
        entry.evidenceClass !== "evleda_check" ||
        entry.validationStatus !== "pass" ||
        !["evleda", "external"].includes(entry.tool.adapter) ||
        !/(?:simulat|analytic|model|spice)/iu.test(entry.tool.name) ||
        entry.rawArtifactId === undefined ||
        !entry.exactInputs.some(
          (identity) => identity.digest === activeInputByStage.get("simulation_checks")
        )
      ) {
        return false;
      }
      const raw = state.artifacts[entry.rawArtifactId];
      return raw !== undefined &&
        activeArtifactIds.has(raw.id) &&
        raw.validationStatus === "pass" &&
        entry.subjectDigests.includes(raw.blob.digest) &&
        reportPathHasKind(raw.logicalName, coverage);
    };
    const missingSimulationCoverage = simulationCoverage.filter(
      (coverage) => !activeEvidence.some((entry) => validSimulationEvidence(entry, coverage))
    );
    if (
      missingInventory.length > 0 ||
      missingNativeReports.length > 0 ||
      missingDerivedReports.length > 0 ||
      duplicateReports.length > 0 ||
      invalidReportEvidenceIds.size > 0 ||
      missingSimulationCoverage.length > 0
    ) {
      throw new DomainError(
        "GATE_FAILED",
        "Candidate revision is incomplete for deterministic export",
        {
          missingInventory,
          missingNativeReports: uniqueSorted(missingNativeReports),
          missingDerivedReports: uniqueSorted(missingDerivedReports),
          duplicateReports: uniqueSorted(duplicateReports),
          invalidReportEvidenceIds: uniqueSorted([...invalidReportEvidenceIds]),
          missingSimulationCoverage
        }
      );
    }
    return projection;
  }

  #revisionAncestry(state: EvlEdaState, revision: DesignRevision): ReadonlySet<string> {
    const ancestry = new Set<string>();
    const pending = [revision.id];
    while (pending.length > 0) {
      const revisionId = pending.pop()!;
      if (ancestry.has(revisionId)) continue;
      const current = state.revisions[revisionId];
      if (current === undefined || current.runId !== revision.runId) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Revision ancestry is missing or crosses a run boundary",
          { revisionId }
        );
      }
      ancestry.add(revisionId);
      pending.push(...current.parentRevisionIds);
    }
    return ancestry;
  }

  #safeLogicalPath(value: string): string {
    if (
      value.length === 0 ||
      value.length > 512 ||
      value.startsWith("/") ||
      value.includes("\\") ||
      value.includes("\0") ||
      value !== value.normalize("NFC") ||
      /^[A-Za-z]:/u.test(value) ||
      /[\u0000-\u001f<>:"|?*]/u.test(value)
    ) {
      throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Artifact path is unsafe", {
        logicalName: value
      });
    }
    const segments = value.split("/");
    const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
    if (
      segments.some(
        (segment) =>
          segment.length === 0 ||
          segment === "." ||
          segment === ".." ||
          segment.endsWith(".") ||
          segment.endsWith(" ") ||
          reserved.test(segment)
      )
    ) {
      throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Artifact path has a reserved segment", {
        logicalName: value
      });
    }
    return value;
  }

  async #buildBundle(
    state: EvlEdaState,
    revision: DesignRevision,
    projection: RevisionEvidenceProjection,
    warning: BundleManifest["warning"],
    lifecycle: "candidate" | "qualified"
  ): Promise<CurrentBundleExportResult> {
    const run = this.#run(state, revision.runId);
    const project = this.#project(state, revision.projectId);
    if (run.projectId !== project.id || revision.projectId !== project.id) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Revision, run, and project identities do not agree"
      );
    }
    if (revision.lifecycle !== "candidate") {
      throw new DomainError(
        "POLICY_DENIED",
        "Application-authored revisions must remain candidate-only",
        { revisionId: revision.id, lifecycle: revision.lifecycle }
      );
    }
    const evidenceRecords = projection.evidence;
    const artifactRecords = projection.artifacts;
    const revisionRecord = await this.#loadRevisionManifestRecord(revision);
    const logicalPaths = new Set<string>();
    const artifactPayloads = await Promise.all(
      artifactRecords.map(async (artifact) => {
        const logicalPath = this.#safeLogicalPath(artifact.logicalName);
        const collisionKey = `${artifact.stage}/${logicalPath}`.toLocaleLowerCase("en-US");
        if (logicalPaths.has(collisionKey)) {
          throw new DomainError(
            "ARTIFACT_INTEGRITY_ERROR",
            "Bundle contains duplicate or case-colliding logical paths",
            { stage: artifact.stage, logicalName: artifact.logicalName }
          );
        }
        logicalPaths.add(collisionKey);
        return {
          artifact,
          bytes: await this.ports.content.get(artifact.blob),
          path: `artifacts/${artifact.stage}/${safeArchiveName(artifact.id)}/${logicalPath}`
        };
      })
    );
    artifactPayloads.sort((left, right) => left.path.localeCompare(right.path, "en"));
    const pathSet = new Set<string>();
    for (const payload of artifactPayloads) {
      const folded = payload.path.toLocaleLowerCase("en-US");
      if (pathSet.has(folded)) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Bundle contains duplicate or case-colliding artifact paths",
          { path: payload.path }
        );
      }
      pathSet.add(folded);
    }
    const evidenceRoot = projection.evidenceRoot;
    const sourceManifestArtifacts: readonly BundleManifestArtifact[] = artifactPayloads.map(
      ({ artifact, path: artifactPath }) => ({
        path: artifactPath,
        logicalName: artifact.logicalName,
        mediaType: artifact.mediaType,
        identity: artifact.blob,
        stage: artifact.stage,
        validationStatus: artifact.validationStatus,
        sourceArtifactId: artifact.id,
        sourceKind: "stored_artifact",
        sourceDesignRevisionId: artifact.designRevisionId,
        projectId: project.id,
        runId: run.id,
        designRevisionId: revision.id,
        exactInputs: artifact.exactInputs,
        derivedFrom: uniqueSorted(artifact.derivedFrom),
        tool: artifact.tool,
        unresolvedAssumptions: artifact.unresolvedAssumptions,
        lifecycle: artifact.lifecycle,
        createdAt: artifact.createdAt,
        staleAt: artifact.staleAt ?? null
      })
    );
    const toolchainByIdentity = new Map<string, ToolIdentity>();
    for (const tool of [...artifactRecords.map((artifact) => artifact.tool), ...evidenceRecords.map((entry) => entry.tool)]) {
      const key = canonicalIdentity(tool, "evleda.tool-identity.v1").digest;
      toolchainByIdentity.set(key, tool);
    }
    toolchainByIdentity.set(canonicalIdentity(BUNDLE_TOOL, "evleda.tool-identity.v1").digest, BUNDLE_TOOL);
    const toolchain = [...toolchainByIdentity.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([, tool]) => tool);
    const assumptionsById = new Map<string, UnresolvedAssumption>();
    for (const assumption of [
      ...artifactRecords.flatMap((artifact) => artifact.unresolvedAssumptions),
      ...evidenceRecords.flatMap((entry) => entry.unresolvedAssumptions)
    ]) {
      const existing = assumptionsById.get(assumption.id);
      if (existing !== undefined && canonicalJson(existing) !== canonicalJson(assumption)) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Bundle provenance contains conflicting assumptions with the same ID",
          { assumptionId: assumption.id }
        );
      }
      assumptionsById.set(assumption.id, assumption);
    }
    const unresolvedAssumptions = [...assumptionsById.values()].sort((left, right) =>
      left.id.localeCompare(right.id, "en")
    );
    const evidenceProjection = [...evidenceRecords]
      .sort((left, right) => left.id.localeCompare(right.id, "en"))
      .map((entry) => this.#evidenceProjection(entry));
    const evidenceBytes = Buffer.from(
      `${canonicalJson({
        schemaVersion: "evleda.bundle-evidence.v2",
        canonicalizationVersion: "evleda-c14n-json-v1",
        evidenceRoot,
        evidence: evidenceProjection
      })}\n`,
      "utf8"
    );
    const revisionRecordBytes = Buffer.from(
      `${canonicalJson({
        schemaVersion: "evleda.bundle-revision-record.v1",
        canonicalizationVersion: "evleda-c14n-json-v1",
        designRevisionId: revision.id,
        ordinal: revision.ordinal,
        revisionManifest: revision.manifest,
        record: revisionRecord
      })}\n`,
      "utf8"
    );
    const readmeBytes = Buffer.from(
      `# ${warning}\n\n` +
        `Project: ${project.id}\nRun: ${run.id}\nRevision: ${revision.id}\n\n` +
        (lifecycle === "candidate"
          ? "This is an immutable review candidate. It is not qualified, certified, safe, or authorized for fabrication or manufacturing.\n"
          : "This bundle is authorized only for the exact controlled prototype scope in the bound human qualification. It is not production released.\n"),
      "utf8"
    );
    const markerBytes = Buffer.from(`${warning}\n`, "utf8");
    const coverBytes = lifecycleCoverBytes(warning, lifecycle);
    const bundleKind = lifecycle === "candidate" ? "candidate" : "prototype";
    const auxiliaryPayloads = [
      {
        role: "cover",
        path: "COVER.svg",
        logicalName: "bundle/COVER.svg",
        mediaType: "image/svg+xml; charset=utf-8",
        bytes: coverBytes
      },
      {
        role: "readme",
        path: "README.md",
        logicalName: "bundle/README.md",
        mediaType: "text/markdown; charset=utf-8",
        bytes: readmeBytes
      },
      {
        role: "warning",
        path: "WARNING.txt",
        logicalName: "bundle/WARNING.txt",
        mediaType: "text/plain; charset=utf-8",
        bytes: markerBytes
      },
      {
        role: "evidence_inventory",
        path: "evidence/evidence.json",
        logicalName: "bundle/evidence/evidence.json",
        mediaType: "application/json",
        bytes: evidenceBytes,
        derivedFrom: uniqueSorted(
          evidenceRecords.flatMap((entry) => [
            ...(entry.rawArtifactId === undefined ? [] : [entry.rawArtifactId]),
            ...(entry.parsedArtifactId === undefined ? [] : [entry.parsedArtifactId])
          ])
        )
      },
      {
        role: "revision_record",
        path: "provenance/revision.json",
        logicalName: "bundle/provenance/revision.json",
        mediaType: "application/json",
        bytes: revisionRecordBytes,
        derivedFrom: uniqueSorted(revision.artifactIds)
      }
    ] as const;
    const auxiliaryManifestArtifacts: readonly BundleManifestArtifact[] = auxiliaryPayloads.map(
      (payload) => {
        const identity = contentIdentity(payload.bytes);
        return {
          path: payload.path,
          logicalName: payload.logicalName,
          mediaType: payload.mediaType,
          identity,
          stage: "manufacturing_package",
          validationStatus: "pass",
          sourceArtifactId: deterministicId("bundle_artifact", {
            source: "evleda_bundle_generator",
            bundleKind,
            role: payload.role,
            projectId: project.id,
            runId: run.id,
            designRevisionId: revision.id,
            revisionManifest: revision.manifest,
            evidenceRoot,
            liveRegenerationPolicyIdentity: LIVE_REGENERATION_POLICY_IDENTITY,
            identity
          }),
          sourceKind: "bundle_generated",
          sourceDesignRevisionId: revision.id,
          projectId: project.id,
          runId: run.id,
          designRevisionId: revision.id,
          exactInputs: [revision.manifest, evidenceRoot, LIVE_REGENERATION_POLICY_IDENTITY],
          derivedFrom: "derivedFrom" in payload ? payload.derivedFrom : [],
          tool: BUNDLE_TOOL,
          unresolvedAssumptions: [],
          lifecycle,
          createdAt: null,
          staleAt: null,
          generationRole: payload.role
        };
      }
    );
    const manifestArtifacts = [
      ...sourceManifestArtifacts,
      ...auxiliaryManifestArtifacts
    ].sort((left, right) => left.path.localeCompare(right.path, "en"));
    const manifestPathKeys = new Set<string>();
    for (const artifact of manifestArtifacts) {
      const key = artifact.path.normalize("NFC").toLocaleLowerCase("en-US");
      if (manifestPathKeys.has(key)) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Bundle manifest contains duplicate or case-colliding paths",
          { path: artifact.path }
        );
      }
      manifestPathKeys.add(key);
    }
    const manifest: BundleManifest = {
      schemaVersion: "evleda.bundle-manifest.v3",
      canonicalizationVersion: "evleda-c14n-json-v1",
      bundleKind,
      lifecycle,
      projectId: project.id,
      runId: run.id,
      designRevisionId: revision.id,
      designRevisionOrdinal: revision.ordinal,
      revisionManifest: revision.manifest,
      revisionRecordPath: "provenance/revision.json",
      evidenceRoot,
      evidenceInventoryPath: "evidence/evidence.json",
      warning,
      artifacts: manifestArtifacts,
      toolchain,
      unresolvedAssumptions,
      exactInputs: [revision.manifest, evidenceRoot, LIVE_REGENERATION_POLICY_IDENTITY],
      liveRegenerationPolicy: LIVE_REGENERATION_POLICY,
      liveRegenerationPolicyIdentity: LIVE_REGENERATION_POLICY_IDENTITY
    };
    const manifestBytes = Buffer.from(`${canonicalJson(manifest)}\n`, "utf8");
    const rootName = lifecycle === "candidate"
      ? `CANDIDATE-NOT-FOR-MANUFACTURING-${safeArchiveName(revision.id)}`
      : `PROTOTYPE-NOT-PRODUCTION-RELEASED-${safeArchiveName(revision.id)}`;
    const files = new Map<string, Uint8Array>();
    files.set(`${rootName}/bundle-manifest.json`, manifestBytes);
    for (const payload of auxiliaryPayloads) {
      files.set(`${rootName}/${payload.path}`, payload.bytes);
    }
    for (const payload of artifactPayloads) {
      files.set(`${rootName}/${payload.path}`, payload.bytes);
    }
    const zipBytes = this.#deterministicZip(files);
    this.#assertBundleComplete(zipBytes, rootName, manifest);
    const identity = await this.ports.content.put(zipBytes);
    return {
      projectId: project.id,
      runId: run.id,
      designRevisionId: revision.id,
      workflowStage: "manufacturing_package",
      fileName: `${rootName}.zip`,
      mediaType: "application/zip",
      identity,
      bytesBase64: Buffer.from(zipBytes).toString("base64"),
      manifest,
      exactInputs: [revision.manifest, evidenceRoot, LIVE_REGENERATION_POLICY_IDENTITY],
      tool: BUNDLE_TOOL,
      validationStatus: "pass",
      unresolvedAssumptions,
      lifecycle,
      liveRegenerationPolicy: LIVE_REGENERATION_POLICY,
      liveRegenerationPolicyIdentity: LIVE_REGENERATION_POLICY_IDENTITY
    };
  }

  #assertBundleComplete(
    bytes: Uint8Array,
    rootName: string,
    manifest: {
      readonly artifacts: readonly {
        readonly path: string;
        readonly identity: ContentIdentity;
      }[];
    }
  ): void {
    const files = unzipSync(bytes);
    const expected = new Set([
      `${rootName}/bundle-manifest.json`,
      ...manifest.artifacts.map((artifact) => `${rootName}/${artifact.path}`)
    ]);
    const actual = new Set(Object.keys(files).filter((entry) => !entry.endsWith("/")));
    if (
      expected.size !== actual.size ||
      [...expected].some((entry) => !actual.has(entry))
    ) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Deterministic bundle is incomplete relative to its manifest",
        { expected: [...expected].sort(), actual: [...actual].sort() }
      );
    }
    for (const artifact of manifest.artifacts) {
      const archived = files[`${rootName}/${artifact.path}`];
      if (archived === undefined) {
        throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Manifest artifact is absent", {
          path: artifact.path
        });
      }
      const actualIdentity = contentIdentity(archived);
      if (
        actualIdentity.digest !== artifact.identity.digest ||
        actualIdentity.size !== artifact.identity.size
      ) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Archived artifact does not match its manifest identity",
          { path: artifact.path, expected: artifact.identity, actual: actualIdentity }
        );
      }
    }
  }

  #deterministicZip(files: ReadonlyMap<string, Uint8Array>): Uint8Array {
    const archive: Zippable = {};
    for (const [filePath, bytes] of [...files.entries()].sort(([left], [right]) =>
      left.localeCompare(right, "en")
    )) {
      archive[filePath] = [
        bytes,
        { level: 9, mtime: FIXED_ZIP_TIME, os: 3, attrs: 0o644 << 16 }
      ];
    }
    return zipSync(archive, { level: 9, mtime: FIXED_ZIP_TIME, os: 3 });
  }

  async #recordFirmwareScaffoldExport(
    input: GenerateFirmwareScaffoldInput,
    context: CommandContext,
    sourceRevision: DesignRevision,
    sourceAttempt: StageAttempt,
    sourceArtifacts: readonly ArtifactRecord[],
    bytes: Uint8Array
  ): Promise<GeneratedArtifactResult> {
    const snapshot = await this.#repairAndVerifyAudit();
    const replay = this.#idempotencyResult(snapshot, "generate_firmware_scaffold", input);
    if (replay !== undefined) {
      const stored = replay as { readonly artifactId: string; readonly revisionId: string };
      const artifact = snapshot.artifacts[stored.artifactId];
      const revision = snapshot.revisions[stored.revisionId];
      if (artifact === undefined || revision === undefined) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Idempotent firmware export result is missing its durable records"
        );
      }
      await this.ports.content.get(artifact.blob);
      return {
        projectId: revision.projectId,
        runId: revision.runId,
        designRevisionId: revision.id,
        workflowStage: "firmware_contract",
        artifact,
        revision
      };
    }
    const blob = await this.ports.content.put(bytes);
    const timestamp = this.#timestamp();
    const logicalName = "firmware/exports/firmware-stage-export.zip";
    const artifactId = deterministicId("artifact", {
      operation: "generate_firmware_scaffold",
      sourceRevisionId: sourceRevision.id,
      sourceAttemptId: sourceAttempt.id,
      blob
    });
    const exactInputs = this.#uniqueIdentities([
      sourceRevision.manifest,
      sourceAttempt.inputManifest,
      sourceAttempt.provisionIdentity!,
      sourceAttempt.provisionManifestBlob!,
      sourceAttempt.outputIdentity!,
      ...sourceArtifacts.map((artifact) => artifact.blob)
    ]);
    const warning: UnresolvedAssumption = {
      id: "assumption_firmware_stage_export_candidate_only",
      statement:
        "This archive exactly packages committed candidate firmware-stage outputs; target hardware and physical behavior remain unqualified.",
      severity: "warning",
      sourceRequirementIds: []
    };
    const mutation = await this.#idempotentMutation<{
      readonly artifactId: string;
      readonly revisionId: string;
    }>(
      "generate_firmware_scaffold",
      input,
      context,
      (result, mutable) => {
        const revision = this.#revision(mutable as unknown as EvlEdaState, result.revisionId);
        return {
          type: "generation.firmware_scaffold_created",
          projectId: revision.projectId,
          runId: revision.runId,
          subjectDigest: revision.manifest.digest,
          payload: {
            operation: "generate_firmware_scaffold",
            sourceRevisionId: sourceRevision.id,
            sourceAttemptId: sourceAttempt.id,
            artifactId: result.artifactId,
            revisionId: result.revisionId,
            headMoved: false
          }
        };
      },
      (mutable) => {
        const runs = recordMap<DesignRun>(mutable.runs);
        const projects = recordMap<Project>(mutable.projects);
        const revisions = recordMap<DesignRevision>(mutable.revisions);
        const artifacts = recordMap<ArtifactRecord>(mutable.artifacts);
        const run = this.#runFromMutable(runs, sourceRevision.runId);
        this.#assertExpectedRevision(run.revision, input.expectedRevision, "run");
        const project = this.#projectFromMutable(projects, sourceRevision.projectId);
        const currentRevision = revisions[sourceRevision.id];
        const currentAttempt = activeSuccessfulAttempt(run.attempts.firmware_contract);
        if (
          run.headRevisionId !== sourceRevision.id ||
          project.headRevisionId !== sourceRevision.id ||
          currentRevision === undefined ||
          canonicalJson(currentRevision.manifest) !== canonicalJson(sourceRevision.manifest) ||
          currentAttempt?.id !== sourceAttempt.id ||
          canonicalJson(currentAttempt.outputIdentity) !== canonicalJson(sourceAttempt.outputIdentity) ||
          sourceArtifacts.some((source) => {
            const current = artifacts[source.id];
            return current === undefined ||
              !currentRevision.artifactIds.includes(source.id) ||
              canonicalJson(current.blob) !== canonicalJson(source.blob) ||
              current.staleAt !== undefined;
          })
        ) {
          throw new DomainError(
            "REVISION_CONFLICT",
            "Firmware-stage export source changed before it could be recorded",
            { revisionId: sourceRevision.id, attemptId: sourceAttempt.id },
            true
          );
        }
        const existingArtifact = artifacts[artifactId];
        const artifact: ArtifactRecord = {
          id: artifactId,
          projectId: sourceRevision.projectId,
          runId: sourceRevision.runId,
          designRevisionId: sourceRevision.id,
          stage: "firmware_contract",
          logicalName,
          mediaType: "application/zip",
          blob,
          exactInputs,
          derivedFrom: uniqueSorted(sourceArtifacts.map((artifact) => artifact.id)),
          tool: APPLICATION_TOOL,
          validationStatus: "pass",
          unresolvedAssumptions: [warning],
          lifecycle: "candidate",
          createdAt: existingArtifact?.createdAt ?? timestamp
        };
        if (existingArtifact === undefined) {
          artifacts[artifactId] = artifact;
        } else if (canonicalJson(existingArtifact) !== canonicalJson(artifact)) {
          throw new DomainError(
            "ARTIFACT_INTEGRITY_ERROR",
            "A deterministic firmware export artifact ID resolves to different immutable metadata",
            { artifactId }
          );
        }
        return { artifactId, revisionId: sourceRevision.id };
      }
    );
    const artifact = mutation.state.artifacts[mutation.result.artifactId];
    const revision = mutation.state.revisions[mutation.result.revisionId];
    if (artifact === undefined || revision === undefined) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Firmware export transaction did not produce its promised records"
      );
    }
    return {
      projectId: revision.projectId,
      runId: revision.runId,
      designRevisionId: revision.id,
      workflowStage: "firmware_contract",
      artifact,
      revision
    };
  }

  async #commitGeneratedArtifact(
    operation: "generate_bringup_plan",
    input: GenerateBringupPlanInput,
    context: CommandContext,
    sourceRevision: DesignRevision,
    stage: "bringup_package",
    logicalName: string,
    mediaType: string,
    bytes: Uint8Array
  ): Promise<GeneratedArtifactResult> {
    const snapshot = await this.#repairAndVerifyAudit();
    const replay = this.#idempotencyResult(snapshot, operation, input);
    if (replay !== undefined) {
      const stored = replay as { readonly artifactId: string; readonly revisionId: string };
      const artifact = snapshot.artifacts[stored.artifactId];
      const revision = snapshot.revisions[stored.revisionId];
      if (artifact === undefined || revision === undefined) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Idempotent generation result is missing its durable records"
        );
      }
      return {
        projectId: revision.projectId,
        runId: revision.runId,
        designRevisionId: revision.id,
        workflowStage: stage,
        artifact,
        revision
      };
    }
    const blob = await this.ports.content.put(bytes);
    const timestamp = this.#timestamp();
    const warning: UnresolvedAssumption = GENERATED_BRINGUP_PLAN_WARNING;
    const mutation = await this.#idempotentMutation<{
      readonly artifactId: string;
      readonly revisionId: string;
    }>(
      operation,
      input,
      context,
      (result, mutable) => {
        const state = mutable as unknown as EvlEdaState;
        const revision = this.#revision(state, result.revisionId);
        return {
          type: "generation.bringup_plan_created",
          projectId: revision.projectId,
          runId: revision.runId,
          subjectDigest: revision.manifest.digest,
          payload: {
            operation,
            sourceRevisionId: sourceRevision.id,
            artifactId: result.artifactId,
            revisionId: revision.id
          }
        };
      },
      async (mutable) => {
      const projects = recordMap<Project>(mutable.projects);
      const runs = recordMap<DesignRun>(mutable.runs);
      const revisions = recordMap<DesignRevision>(mutable.revisions);
      const artifacts = recordMap<ArtifactRecord>(mutable.artifacts);
      const run = this.#runFromMutable(runs, sourceRevision.runId);
      this.#assertExpectedRevision(run.revision, input.expectedRevision, "run");
      const parent = revisions[sourceRevision.id];
      if (parent === undefined || parent.manifest.digest !== sourceRevision.manifest.digest) {
        throw new DomainError("REVISION_CONFLICT", "Generation source revision is stale");
      }
      const requirements = this.#requirements(run);
      const artifactId = deterministicId("artifact", {
        operation,
        idempotencyKey: input.idempotencyKey,
        sourceRevisionId: parent.id,
        logicalName,
        blob
      });
      const ordinal = Math.max(
        0,
        ...Object.values(revisions)
          .filter((revision) => revision.runId === run.id)
          .map((revision) => revision.ordinal)
      ) + 1;
      const artifactIds = uniqueSorted([...parent.artifactIds, artifactId]);
      const revisionRecord = {
          schemaVersion: "evleda.design-revision.v1",
          projectId: run.projectId,
          runId: run.id,
          ordinal,
          parentRevisionIds: [parent.id],
          operation,
          sourceRevision: parent.manifest,
          requirements: requirements.identity,
          artifacts: [
            ...parent.artifactIds.map((id) => {
              const artifact = artifacts[id];
              if (artifact === undefined) {
                throw new DomainError(
                  "ARTIFACT_INTEGRITY_ERROR",
                  "Source revision artifact is missing",
                  { artifactId: id }
                );
              }
              return this.#artifactProjection(artifact);
            }),
            {
              id: artifactId,
              projectId: run.projectId,
              runId: run.id,
              stage,
              logicalName,
              mediaType,
              blob,
              exactInputs: [parent.manifest, requirements.identity],
              derivedFrom: parent.artifactIds,
              tool: APPLICATION_TOOL,
              validationStatus: "not_run",
              unresolvedAssumptions: [warning],
              lifecycle: "candidate",
              createdAt: timestamp,
              staleAt: null
            }
          ],
          evidence: parent.evidenceIds.map((id) => {
            const entry = recordMap<EvidenceRecord>(mutable.evidence)[id];
            if (entry === undefined) {
              throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Source revision evidence is missing", {
                evidenceId: id
              });
            }
            return this.#evidenceProjection(entry);
          })
        } as const;
      const { manifest, blob: manifestRecordBlob } =
        await this.#persistRevisionManifestRecord(revisionRecord);
      const revisionId = deterministicId("revision", {
        runId: run.id,
        ordinal,
        manifest: manifest.digest
      });
      const artifact: ArtifactRecord = {
        id: artifactId,
        projectId: run.projectId,
        runId: run.id,
        designRevisionId: revisionId,
        stage,
        logicalName,
        mediaType,
        blob,
        exactInputs: [parent.manifest, requirements.identity],
        derivedFrom: parent.artifactIds,
        tool: APPLICATION_TOOL,
        validationStatus: "not_run",
        unresolvedAssumptions: [warning],
        lifecycle: "candidate",
        createdAt: timestamp
      };
      artifacts[artifact.id] = artifact;
      revisions[revisionId] = {
        id: revisionId,
        projectId: run.projectId,
        runId: run.id,
        ordinal,
        parentRevisionIds: [parent.id],
        manifest,
        manifestRecordBlob,
        artifactIds,
        evidenceIds: parent.evidenceIds,
        lifecycle: "candidate",
        createdAt: timestamp
      };
      runs[run.id] = {
        ...run,
        headRevisionId: revisionId,
        lifecycle: "candidate",
        updatedAt: timestamp,
        revision: run.revision + 1
      };
      const project = this.#projectFromMutable(projects, run.projectId);
      projects[project.id] = {
        ...project,
        headRevisionId: revisionId,
        updatedAt: timestamp,
        revision: project.revision + 1
      };
        return { artifactId, revisionId };
      }
    );
    const artifact = mutation.state.artifacts[mutation.result.artifactId];
    const revision = mutation.state.revisions[mutation.result.revisionId];
    if (artifact === undefined || revision === undefined) {
      throw new DomainError(
        "ARTIFACT_INTEGRITY_ERROR",
        "Generated artifact transaction did not produce its promised records"
      );
    }
    return {
      projectId: revision.projectId,
      runId: revision.runId,
      designRevisionId: revision.id,
      workflowStage: stage,
      artifact,
      revision
    };
  }

  #id(prefix: string): string {
    return `${prefix}_${this.#newUuid()}`;
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }
}
