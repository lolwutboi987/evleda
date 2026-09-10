import { createHash, randomUUID } from "node:crypto";

import type { ContentIdentity } from "../domain/types.js";
import type { FluxDiagnosticDto } from "../domain/diagnostics.js";
import type { FluxOperationFailureEvidence } from "./operation-failure-evidence.js";
import type { FluxDeepRuleSummaryDto } from "./deep-rule-summary.js";
import type { FluxFreshClearanceEvidenceBinding, FluxFreshClearanceEvidenceBindingV1 } from "./fresh-clearance-evidence-binding.js";
import type { FreshClearanceEvidenceReceipt, FreshNetClassPreparationEvidence, FreshNetClassSemanticAuthority } from "../harness/fresh-clearance-evidence.js";
import type { FluxLegacyClearanceEvidenceReceipt, FluxLegacyNetClassPreparationEvidence, FluxLegacyNetClassSemanticAuthority } from "./legacy-netclass-evidence.js";
import type { FreshProjectOpenPreparedSourceAuthority } from "../harness/fresh-project.js";
import type {
  PcbDesignCompilationBundle,
  PcbDesignCompilationBundleRef
} from "../harness/pcb-design-compilation-bundle.js";
import type { PcbProviderProfileBinding } from "../harness/pcb-design-interpreter.js";

/** The value used by a browser to identify an item. It is deliberately never a path. */
export type FluxId = string;
export type FluxRunPhase =
  | "draft"
  | "interpreting"
  | "awaiting_clarification"
  | "contract_ready"
  | "preparing"
  | "awaiting_open"
  | "opening"
  | "awaiting_checkpoint"
  | "checkpointing"
  | "awaiting_approval"
  | "approved"
  | "queued"
  | "running"
  | "completed"
  | "needs_review"
  | "failed"
  | "blocked";

export type FluxEventKind =
  | "project_created"
  | "thread_created"
  | "run_created"
  | "interpretation_started"
  | "clarification_requested"
  | "contract_compiled"
  | "run_prepared"
  | "run_opened"
  | "open_checkpoint_recorded"
  | "approval_recorded"
  | "approval_consumed"
  | "run_queued"
  | "run_started"
  | "run_progress"
  | "preview_ready"
  | "preview_warning"
  | "run_completed"
  | "run_needs_review"
  | "run_failed"
  | "run_blocked";

export interface FluxProviderModel {
  readonly provider: string;
  readonly model: string;
  readonly tier: string;
}

export interface FluxSourceCatalogInput {
  readonly key: string;
  readonly label: string;
  readonly sourceRoot: string;
  readonly fingerprint: string;
}

/** Safe source projection; local filesystem locations are intentionally absent. */
export interface FluxSourceCatalogDto {
  readonly key: string;
  readonly label: string;
  readonly fingerprint: string;
}

export interface FluxProjectDto {
  readonly id: FluxId;
  readonly sourceKey: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface FluxThreadDto {
  readonly id: FluxId;
  readonly projectId: FluxId;
  readonly title: string;
  readonly createdAt: string;
}

export interface FluxPreviewMetadata {
  readonly title: string;
  readonly summary: string;
  readonly artifactCount: number;
  readonly digest: string;
}

export interface FluxReportMetadata {
  readonly reportId: FluxId;
  readonly title: string;
  readonly digest: string;
  readonly mediaType: string;
  readonly createdAt: string;
  readonly disposition?: "completed" | "needs_review" | "blocked" | "failed";
  readonly summary?: string;
  readonly reportSha256?: string;
  readonly freshAcceptance?: FluxFreshAcceptanceProjection;
  readonly freshBoardSaveAudits?: readonly FluxFreshBoardSaveAuditProjection[];
  /** Path-free pre-execution write-session authority. Required on newly executed reports. */
  readonly writeSessionAuthorityIdentity?: FluxCanonicalIdentityDto;
  /** Path/PID-free receipt identity for the actual long-lived write session. Required on newly executed reports. */
  readonly writeSessionReceiptIdentity?: FluxCanonicalIdentityDto;
  /** Full-mode execution bridge authority used by the write session. Required on newly executed reports. */
  readonly executionBridgeIdentity?: FluxCanonicalIdentityDto;
  /** Actual read-only inspection session used for the execution-time semantic re-probe. */
  readonly executionInspectionSessionReceiptIdentity?: FluxCanonicalIdentityDto;
  /** Closed, path-free proof that generic completion used verified native clearance materialization and receipt authority. */
  readonly freshClearanceEvidenceBinding?: FluxFreshClearanceEvidenceBinding | FluxFreshClearanceEvidenceBindingV1;
}

export interface FluxFreshAcceptanceProjection {
  readonly passed: boolean;
  readonly requirements: readonly Readonly<{ readonly id: string; readonly status: "pass" | "fail" | "unknown"; readonly detail: string }>[];
  readonly missing: readonly string[];
  readonly sourceHashes: Readonly<{ readonly schematicSha256: string; readonly pcbSha256: string; readonly netlistSha256?: string }>;
  readonly evidenceLimitations: readonly string[];
}

export interface FluxFreshBoardSaveAuditProjection {
  readonly before: Readonly<{ readonly sha256: string; readonly bytes: number }>;
  readonly live: Readonly<{ readonly sha256: string; readonly bytes: number }>;
  readonly after: Readonly<{ readonly sha256: string; readonly bytes: number }>;
  readonly directorySync: "synced" | "unavailable";
}

export interface FluxRuntimePolicyDto {
  /** Exact server-owned provider/model selection accepted by create-run. */
  readonly providerModel: FluxProviderModel;
  readonly iterationCap: Readonly<{ readonly minimum: 1; readonly maximum: 24; readonly recommended: 12 }>;
  readonly harnessRuleIdentity: string;
  readonly mutationAllowlist: readonly string[];
  readonly freshProjectNamePattern: "^[a-z][a-z0-9-]{0,63}$";
  readonly checkpointOpenRequiredForFresh: true;
  readonly freshAcceptanceProfileIdentity: string;
  readonly freshPersistenceProfileIdentity: string;
}

export interface FluxCanonicalIdentityDto { readonly algorithm: "sha256"; readonly digest: string; readonly schemaVersion: string; readonly canonicalizationVersion: "evleda-c14n-json-v1" }
export interface FluxContractQuestionDto { readonly id: string; readonly path: string; readonly question: string }
export interface FluxContractIssueDto { readonly code: string; readonly severity: "error"; readonly path: string; readonly message: string; readonly clarificationId: string | null }
export interface FluxInterpreterReceiptV1Dto { readonly schemaVersion: "evleda.flux-interpreter-receipt.v1"; readonly interpreterSchemaVersion: string; readonly provider: string; readonly promptDigest: string; readonly clarificationDigest: string; readonly compiledAt: string }
export interface FluxInterpreterReceiptV2Dto {
  readonly schemaVersion: "evleda.flux-interpreter-receipt.v2";
  readonly interpreterSchemaVersion: string;
  readonly provider: string;
  readonly providerProfile: PcbProviderProfileBinding;
  readonly providerProfileIdentity: FluxCanonicalIdentityDto;
  readonly promptDigest: string;
  readonly clarificationDigest: string;
  readonly compilerProfileIdentity: FluxCanonicalIdentityDto | null;
  readonly practiceProfileBindingIdentity: FluxCanonicalIdentityDto | null;
  readonly bundleIdentity: FluxCanonicalIdentityDto | null;
  readonly compiledAt: string;
  readonly identity: FluxCanonicalIdentityDto;
}
export type FluxInterpreterReceiptDto = FluxInterpreterReceiptV1Dto | FluxInterpreterReceiptV2Dto;
export interface FluxContractStateDto {
  readonly disposition: "needs_clarification" | "unsupported" | "ready";
  readonly questions: readonly FluxContractQuestionDto[];
  readonly issues: readonly FluxContractIssueDto[];
  readonly contract: Readonly<Record<string, unknown>> | null;
  readonly contractIdentity: FluxCanonicalIdentityDto | null;
  readonly libraryBindingIdentity: FluxCanonicalIdentityDto | null;
  readonly deepRuleBindingIdentity: FluxCanonicalIdentityDto | null;
  readonly deepRuleSummary?: FluxDeepRuleSummaryDto;
  readonly acceptancePlanIdentity: FluxCanonicalIdentityDto | null;
  readonly interpreterReceipt: FluxInterpreterReceiptDto;
}
export interface FluxClarificationAnswerDto { readonly id: string; readonly answer: string }
export interface FluxContractInterpretationInput { readonly prompt: string; readonly clarificationAnswers: readonly FluxClarificationAnswerDto[] }
export interface FluxContractInterpretationPort {
  interpret(input: Readonly<FluxContractInterpretationInput>): Promise<FluxContractStateDto>;
}
/** Internal authority-bearing result. Only publicState is suitable for persistence or HTTP projection. */
export interface FluxCompilationInterpretationResult {
  readonly publicState: FluxContractStateDto;
  readonly bundle: PcbDesignCompilationBundle | null;
}
export interface FluxCompilationInterpreterPort {
  interpretCompilation(input: Readonly<FluxContractInterpretationInput>): Promise<FluxCompilationInterpretationResult>;
}

interface FluxApprovalSubjectBaseV2 {
  readonly schemaVersion: "evleda.flux-approval-subject.v2";
  readonly runId: FluxId;
  readonly workflowKind: "generic" | "led_compatibility_fixture";
  readonly sourceKey: string;
  readonly sourceFingerprint: string;
  readonly isolatedFingerprint: string;
  readonly promptIdentity: ContentIdentity;
  readonly providerModel: FluxProviderModel;
  readonly iterationCap: number;
  readonly harnessRuleIdentity: string;
  readonly mutationAllowlist: readonly string[];
  readonly freshAcceptanceProfileIdentity: string;
  readonly freshPersistenceProfileIdentity: string;
  readonly contractIdentity: FluxCanonicalIdentityDto;
  readonly libraryBindingIdentity: FluxCanonicalIdentityDto;
  readonly deepRuleBindingIdentity: FluxCanonicalIdentityDto;
  readonly acceptancePlanIdentity: FluxCanonicalIdentityDto;
  readonly kicadToolchainIdentity: FluxCanonicalIdentityDto;
  readonly openPreflightReceiptIdentity: FluxCanonicalIdentityDto;
  readonly openCheckpointReceiptIdentity: FluxCanonicalIdentityDto;
}

interface FluxApprovalSubjectBaseV3 extends Omit<FluxApprovalSubjectBaseV2, "schemaVersion"> {
  readonly schemaVersion: "evleda.flux-approval-subject.v3";
  readonly inspectionBridgeIdentity: FluxCanonicalIdentityDto;
  readonly executionBridgeIdentity: FluxCanonicalIdentityDto;
  readonly ipcSocketIdentity: FluxCanonicalIdentityDto;
  readonly writeSessionAuthorityIdentity: FluxCanonicalIdentityDto;
  readonly ipcProbeSemanticIdentity: FluxCanonicalIdentityDto;
}

interface FluxApprovalSubjectBaseV4 extends Omit<FluxApprovalSubjectBaseV3, "schemaVersion"> {
  readonly schemaVersion: "evleda.flux-approval-subject.v4";
  readonly freshNetClassSemanticAuthorityIdentity: FluxCanonicalIdentityDto | null;
}

interface FluxApprovalSubjectBaseV5 extends Omit<FluxApprovalSubjectBaseV4, "schemaVersion"> {
  readonly schemaVersion: "evleda.flux-approval-subject.v5";
  readonly freshProjectOpenPreparedSourceAuthorityIdentity: FluxCanonicalIdentityDto | null;
}

interface FluxApprovalSubjectBase extends Omit<FluxApprovalSubjectBaseV5, "schemaVersion"> {
  readonly schemaVersion: "evleda.flux-approval-subject.v6";
  readonly freshNetClassPreparationEvidenceIdentity: FluxCanonicalIdentityDto | null;
}

export interface FluxGenericApprovalSubjectV2 extends FluxApprovalSubjectBaseV2 {
  readonly workflowKind: "generic";
  readonly compilationBundleRef: PcbDesignCompilationBundleRef;
  readonly providerProfile: PcbProviderProfileBinding;
  readonly bundleIdentity: FluxCanonicalIdentityDto;
  readonly compilerProfileIdentity: FluxCanonicalIdentityDto;
  readonly practiceProfileBindingIdentity: FluxCanonicalIdentityDto;
  readonly executionPromptIdentity: FluxCanonicalIdentityDto;
  readonly executionPromptContentIdentity: ContentIdentity;
}

export interface FluxLedCompatibilityApprovalSubjectV2 extends FluxApprovalSubjectBaseV2 {
  readonly workflowKind: "led_compatibility_fixture";
  readonly compilationBundleRef: null;
  readonly providerProfile: null;
}

export type FluxApprovalSubjectV2 = FluxGenericApprovalSubjectV2 | FluxLedCompatibilityApprovalSubjectV2;

export interface FluxGenericApprovalSubjectV3 extends FluxApprovalSubjectBaseV3 {
  readonly workflowKind: "generic";
  readonly compilationBundleRef: PcbDesignCompilationBundleRef;
  readonly providerProfile: PcbProviderProfileBinding;
  readonly bundleIdentity: FluxCanonicalIdentityDto;
  readonly compilerProfileIdentity: FluxCanonicalIdentityDto;
  readonly practiceProfileBindingIdentity: FluxCanonicalIdentityDto;
  readonly executionPromptIdentity: FluxCanonicalIdentityDto;
  readonly executionPromptContentIdentity: ContentIdentity;
}

export interface FluxLedCompatibilityApprovalSubjectV3 extends FluxApprovalSubjectBaseV3 {
  readonly workflowKind: "led_compatibility_fixture";
  readonly compilationBundleRef: null;
  readonly providerProfile: null;
}

export type FluxApprovalSubjectV3 = FluxGenericApprovalSubjectV3 | FluxLedCompatibilityApprovalSubjectV3;

export interface FluxGenericApprovalSubjectV4 extends FluxApprovalSubjectBaseV4 {
  readonly workflowKind: "generic";
  readonly compilationBundleRef: PcbDesignCompilationBundleRef;
  readonly providerProfile: PcbProviderProfileBinding;
  readonly bundleIdentity: FluxCanonicalIdentityDto;
  readonly compilerProfileIdentity: FluxCanonicalIdentityDto;
  readonly practiceProfileBindingIdentity: FluxCanonicalIdentityDto;
  readonly executionPromptIdentity: FluxCanonicalIdentityDto;
  readonly executionPromptContentIdentity: ContentIdentity;
}

export interface FluxLedCompatibilityApprovalSubjectV4 extends FluxApprovalSubjectBaseV4 {
  readonly workflowKind: "led_compatibility_fixture";
  readonly compilationBundleRef: null;
  readonly providerProfile: null;
}

export type FluxApprovalSubjectV4 = FluxGenericApprovalSubjectV4 | FluxLedCompatibilityApprovalSubjectV4;

export interface FluxGenericApprovalSubjectV5 extends FluxApprovalSubjectBaseV5 {
  readonly workflowKind: "generic";
  readonly compilationBundleRef: PcbDesignCompilationBundleRef;
  readonly providerProfile: PcbProviderProfileBinding;
  readonly bundleIdentity: FluxCanonicalIdentityDto;
  readonly compilerProfileIdentity: FluxCanonicalIdentityDto;
  readonly practiceProfileBindingIdentity: FluxCanonicalIdentityDto;
  readonly executionPromptIdentity: FluxCanonicalIdentityDto;
  readonly executionPromptContentIdentity: ContentIdentity;
}

export interface FluxLedCompatibilityApprovalSubjectV5 extends FluxApprovalSubjectBaseV5 {
  readonly workflowKind: "led_compatibility_fixture";
  readonly compilationBundleRef: null;
  readonly providerProfile: null;
}

export type FluxApprovalSubjectV5 = FluxGenericApprovalSubjectV5 | FluxLedCompatibilityApprovalSubjectV5;

export interface FluxGenericApprovalSubject extends FluxApprovalSubjectBase {
  readonly workflowKind: "generic";
  readonly compilationBundleRef: PcbDesignCompilationBundleRef;
  readonly providerProfile: PcbProviderProfileBinding;
  readonly bundleIdentity: FluxCanonicalIdentityDto;
  readonly compilerProfileIdentity: FluxCanonicalIdentityDto;
  readonly practiceProfileBindingIdentity: FluxCanonicalIdentityDto;
  readonly executionPromptIdentity: FluxCanonicalIdentityDto;
  readonly executionPromptContentIdentity: ContentIdentity;
}

export interface FluxLedCompatibilityApprovalSubject extends FluxApprovalSubjectBase {
  readonly workflowKind: "led_compatibility_fixture";
  readonly compilationBundleRef: null;
  readonly providerProfile: null;
}

export type FluxApprovalSubject = FluxGenericApprovalSubject | FluxLedCompatibilityApprovalSubject;

export interface FluxApprovalDto {
  readonly id: FluxId;
  readonly subjectDigest: string;
  readonly approvedAt: string;
  readonly consumedAt?: string;
}

export interface FluxRunDto {
  readonly id: FluxId;
  readonly projectId: FluxId;
  readonly threadId: FluxId;
  readonly phase: FluxRunPhase;
  readonly prompt: string;
  readonly providerModel: FluxProviderModel;
  readonly iterationCap: number;
  readonly harnessRuleIdentity: string;
  readonly mutationAllowlist: readonly string[];
  readonly freshAcceptanceProfileIdentity: string;
  readonly freshPersistenceProfileIdentity: string;
  readonly checkpointRequired?: boolean;
  readonly workflowKind: "generic" | "led_compatibility_fixture";
  readonly contractState?: FluxContractStateDto;
  /** Path-free CAS reference only. The compilation bundle is never an API DTO. */
  readonly compilationBundleRef?: PcbDesignCompilationBundleRef;
  readonly preview?: FluxPreviewMetadata;
  readonly reports: readonly FluxReportMetadata[];
  readonly approval?: FluxApprovalDto;
  readonly blockedReason?: string;
  readonly diagnostic?: FluxDiagnosticDto;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FluxEventDto {
  readonly id: FluxId;
  readonly eventSeq: number;
  readonly runId?: FluxId;
  readonly kind: FluxEventKind;
  readonly at: string;
  readonly detail: string;
  readonly diagnostic?: FluxDiagnosticDto;
}

export interface FluxQueueSnapshot {
  readonly busyRunId?: FluxId;
  readonly queuedRunIds: readonly FluxId[];
}

export interface FluxOpenResult {
  readonly opened: boolean;
  readonly label: string;
  readonly checkpointRequired: boolean;
}

interface FluxPrepareRequestBase {
  readonly runId: FluxId;
  readonly sourceKey: string;
  readonly sourceFingerprint: string;
  /** Internal trusted path, never returned in a browser DTO. */
  readonly sourceRoot: string;
  readonly providerModel: FluxProviderModel;
  readonly iterationCap: number;
  readonly harnessRuleIdentity: string;
  readonly mutationAllowlist: readonly string[];
  readonly freshAcceptanceProfileIdentity: string;
  readonly freshPersistenceProfileIdentity: string;
  readonly contractIdentity: FluxCanonicalIdentityDto;
  readonly libraryBindingIdentity: FluxCanonicalIdentityDto;
  readonly deepRuleBindingIdentity: FluxCanonicalIdentityDto;
  readonly acceptancePlanIdentity: FluxCanonicalIdentityDto;
  /** Internal path-free prepare evidence; required after generic preparation and absent for LED compatibility. */
  readonly freshNetClassPreparationEvidence?: FreshNetClassPreparationEvidence;
  /** Internal full semantic projection. Required after generic preparation and never projected publicly. */
  readonly freshNetClassSemanticAuthority?: FreshNetClassSemanticAuthority;
  /** Internal prepared-file authority. It contains a private physical path and is never projected by the API. */
  readonly freshProjectOpenPreparedSourceAuthority?: FreshProjectOpenPreparedSourceAuthority;
  /** Internal path-free Open authority; never projected by the API. */
  readonly openPreflightReceipt?: FluxOpenPreflightReceipt;
  /** Internal path-free checkpoint authority; never projected by the API. */
  readonly openCheckpointReceipt?: FluxOpenCheckpointReceipt;
}

export interface FluxGenericPrepareRequest extends FluxPrepareRequestBase {
  readonly workflowKind: "generic";
  readonly compilationBundle: PcbDesignCompilationBundle;
  readonly compilationBundleRef: PcbDesignCompilationBundleRef;
  readonly providerProfile: PcbProviderProfileBinding;
  readonly promptIdentity: ContentIdentity;
  readonly compilerProfileIdentity: FluxCanonicalIdentityDto;
  readonly practiceProfileBindingIdentity: FluxCanonicalIdentityDto;
  readonly executionPromptIdentity: FluxCanonicalIdentityDto;
  readonly executionPromptContentIdentity: ContentIdentity;
}

export interface FluxLedCompatibilityPrepareRequest extends FluxPrepareRequestBase {
  readonly workflowKind: "led_compatibility_fixture";
  readonly prompt: string;
  readonly compilationBundle?: never;
  readonly compilationBundleRef?: never;
  readonly providerProfile?: never;
}

export type FluxPrepareRequest = FluxGenericPrepareRequest | FluxLedCompatibilityPrepareRequest;

export interface FluxPrepareResult {
  readonly isolatedFingerprint: string;
  readonly preview: FluxPreviewMetadata;
  readonly checkpointRequired: boolean;
  readonly freshNetClassPreparationEvidence?: FreshNetClassPreparationEvidence | null;
  readonly freshNetClassSemanticAuthority?: FreshNetClassSemanticAuthority | null;
  readonly freshProjectOpenPreparedSourceAuthority?: FreshProjectOpenPreparedSourceAuthority | null;
  readonly openCheckpointReceipt?: FluxOpenCheckpointReceipt;
}

export type FluxExecuteRequest =
  | (FluxGenericPrepareRequest & Readonly<{ readonly approval: FluxGenericApprovalSubject }>)
  | (FluxLedCompatibilityPrepareRequest & Readonly<{ readonly approval: FluxLedCompatibilityApprovalSubject }>);

export interface FluxExecuteResult {
  readonly reports?: readonly Omit<FluxReportMetadata, "reportId" | "createdAt">[];
  /** Internal live-verified terminal receipt. Persisted privately on the run and never projected in report/public DTOs. */
  readonly freshClearanceEvidenceReceipt?: FreshClearanceEvidenceReceipt;
  /** Absence is invalid and must never be interpreted as successful completion. */
  readonly disposition: "completed" | "needs_review" | "blocked" | "failed";
  readonly blockedReason?: string;
}

export interface FluxOpenRequest {
  readonly projectId: FluxId;
  readonly runId?: FluxId;
  /** Present for run-bound opens after the manager has reloaded and verified authority. */
  readonly preparation?: FluxPrepareRequest;
}

export const FLUX_OPEN_PREFLIGHT_LEGACY_SCHEMA_VERSION = "evleda.flux-open-preflight.v1" as const;
export const FLUX_OPEN_PREFLIGHT_BRIDGE_SCHEMA_VERSION = "evleda.flux-open-preflight.v2" as const;
export const FLUX_OPEN_PREFLIGHT_SEMANTIC_SCHEMA_VERSION = "evleda.flux-open-preflight.v3" as const;
export const FLUX_OPEN_PREFLIGHT_PREPARED_SOURCE_SCHEMA_VERSION = "evleda.flux-open-preflight.v4" as const;
export const FLUX_OPEN_PREFLIGHT_SCHEMA_VERSION = "evleda.flux-open-preflight.v5" as const;
export interface FluxOpenPreflightReceiptV1 {
  readonly schemaVersion: typeof FLUX_OPEN_PREFLIGHT_LEGACY_SCHEMA_VERSION;
  readonly projectId: FluxId;
  readonly runId: FluxId;
  readonly preparationDigest: string;
  readonly suiteVersion: string;
  readonly installationRootIdentity: FluxCanonicalIdentityDto;
  readonly kicadCli: ContentIdentity;
  readonly pcbnew: ContentIdentity;
  readonly board: ContentIdentity;
  readonly identity: FluxCanonicalIdentityDto;
}
export interface FluxOpenPreflightReceiptV2 {
  readonly schemaVersion: typeof FLUX_OPEN_PREFLIGHT_BRIDGE_SCHEMA_VERSION;
  readonly projectId: FluxId;
  readonly runId: FluxId;
  readonly preparationDigest: string;
  readonly suiteVersion: string;
  readonly installationRootIdentity: FluxCanonicalIdentityDto;
  readonly inspectionBridgeIdentity: FluxCanonicalIdentityDto;
  readonly ipcSocketIdentity: FluxCanonicalIdentityDto;
  readonly kicadCli: ContentIdentity;
  readonly pcbnew: ContentIdentity;
  readonly board: ContentIdentity;
  readonly identity: FluxCanonicalIdentityDto;
}
export interface FluxOpenPreflightReceiptV3 extends Omit<FluxOpenPreflightReceiptV2, "schemaVersion"> {
  readonly schemaVersion: typeof FLUX_OPEN_PREFLIGHT_SEMANTIC_SCHEMA_VERSION;
  readonly freshNetClassSemanticAuthorityIdentity: FluxCanonicalIdentityDto | null;
}
export interface FluxOpenPreflightReceiptV4 extends Omit<FluxOpenPreflightReceiptV3, "schemaVersion"> {
  readonly schemaVersion: typeof FLUX_OPEN_PREFLIGHT_PREPARED_SOURCE_SCHEMA_VERSION;
  readonly freshProjectOpenPreparedSourceAuthorityIdentity: FluxCanonicalIdentityDto | null;
}
export interface FluxOpenPreflightReceipt extends Omit<FluxOpenPreflightReceiptV4, "schemaVersion"> {
  readonly schemaVersion: typeof FLUX_OPEN_PREFLIGHT_SCHEMA_VERSION;
  readonly freshNetClassPreparationEvidenceIdentity: FluxCanonicalIdentityDto | null;
}

export const FLUX_OPEN_PREFLIGHT_FAILURE_SCHEMA_VERSION = "evleda.flux-open-preflight-failure.v1" as const;
export interface FluxOpenPreflightFailureReceipt {
  readonly schemaVersion: typeof FLUX_OPEN_PREFLIGHT_FAILURE_SCHEMA_VERSION;
  readonly operation: "open_project";
  readonly requestDigest: string;
  readonly runId: FluxId;
  readonly failedAt: string;
  readonly identity: FluxCanonicalIdentityDto;
}

export const FLUX_OPEN_PREFLIGHT_UNCERTAIN_SCHEMA_VERSION = "evleda.flux-open-preflight-uncertain.v1" as const;
export const FLUX_OPEN_PREFLIGHT_UNCERTAIN_MESSAGE = "The Open preflight probe crossed an uncertain process boundary; the run is blocked and Open will not be retried automatically.";
export const FLUX_SOCKET_RESTART_INVALIDATION_MESSAGE = "The Flux service restarted after socket-bound checkpointing; Open, checkpoint, and approval authority were invalidated and must be established again.";
export const FLUX_LEGACY_AUTHORED_NETCLASS_REVIEW_MESSAGE = "This generic run predates authored exact net-class assignments with an empty derived cache; its historical evidence is retained for review and a new run must be prepared before approval or execution.";
export const FLUX_LEGACY_CLEARANCE_REVIEW_MESSAGE = "This legacy generic completion predates the closed native clearance evidence binding and requires review before it can be treated as completed.";
export const FLUX_LEGACY_SEMANTIC_REVIEW_MESSAGE = "This legacy generic completion predates stable prelaunch net-class semantic approval authority and requires review before it can be treated as completed.";
export const FLUX_LEGACY_TERMINAL_CLEARANCE_RECEIPT_REVIEW_MESSAGE = "This legacy generic completion predates private terminal clearance-receipt persistence and requires review before it can be treated as completed.";
export const FLUX_LEGACY_FULL_SEMANTIC_AUTHORITY_REVIEW_MESSAGE = "This legacy generic completion predates private full net-class semantic authority persistence and requires review before it can be treated as completed.";
export interface FluxOpenPreflightUncertainReceipt {
  readonly schemaVersion: typeof FLUX_OPEN_PREFLIGHT_UNCERTAIN_SCHEMA_VERSION;
  readonly operation: "open_project";
  readonly requestDigest: string;
  readonly runId: FluxId;
  readonly blockedAt: string;
  readonly identity: FluxCanonicalIdentityDto;
}

export const FLUX_OPEN_CHECKPOINT_LEGACY_SCHEMA_VERSION = "evleda.flux-open-checkpoint.v1" as const;
export const FLUX_OPEN_CHECKPOINT_BRIDGE_SCHEMA_VERSION = "evleda.flux-open-checkpoint.v2" as const;
export const FLUX_OPEN_CHECKPOINT_SOCKET_SCHEMA_VERSION = "evleda.flux-open-checkpoint.v3" as const;
export const FLUX_OPEN_CHECKPOINT_SEMANTIC_SCHEMA_VERSION = "evleda.flux-open-checkpoint.v4" as const;
export const FLUX_OPEN_CHECKPOINT_PREPARED_SOURCE_SCHEMA_VERSION = "evleda.flux-open-checkpoint.v5" as const;
export const FLUX_OPEN_CHECKPOINT_SCHEMA_VERSION = "evleda.flux-open-checkpoint.v6" as const;
export const FLUX_OPEN_IPC_PROBE_SEMANTIC_SCHEMA_VERSION = "evleda.flux-open-ipc-probe-semantic.v2" as const;
export interface FluxOpenCheckpointReceiptV1 {
  readonly schemaVersion: typeof FLUX_OPEN_CHECKPOINT_LEGACY_SCHEMA_VERSION;
  readonly runId: FluxId;
  readonly openPreflightReceiptIdentity: FluxCanonicalIdentityDto;
  readonly kicadToolchainIdentity: FluxCanonicalIdentityDto;
  readonly isolatedFingerprint: string;
  readonly board: ContentIdentity;
  readonly editorLock: ContentIdentity;
  readonly ipcProbeIdentity: FluxCanonicalIdentityDto;
  readonly identity: FluxCanonicalIdentityDto;
}
export interface FluxOpenCheckpointReceiptV2 {
  readonly schemaVersion: typeof FLUX_OPEN_CHECKPOINT_BRIDGE_SCHEMA_VERSION;
  readonly runId: FluxId;
  readonly openPreflightReceiptIdentity: FluxCanonicalIdentityDto;
  readonly kicadToolchainIdentity: FluxCanonicalIdentityDto;
  readonly inspectionBridgeIdentity: FluxCanonicalIdentityDto;
  readonly isolatedFingerprint: string;
  readonly board: ContentIdentity;
  readonly editorLock: ContentIdentity;
  readonly ipcProbeIdentity: FluxCanonicalIdentityDto;
  readonly identity: FluxCanonicalIdentityDto;
}
export interface FluxOpenCheckpointReceiptV3 {
  readonly schemaVersion: typeof FLUX_OPEN_CHECKPOINT_SOCKET_SCHEMA_VERSION;
  readonly runId: FluxId;
  readonly openPreflightReceiptIdentity: FluxCanonicalIdentityDto;
  readonly kicadToolchainIdentity: FluxCanonicalIdentityDto;
  readonly inspectionBridgeIdentity: FluxCanonicalIdentityDto;
  readonly executionBridgeIdentity: FluxCanonicalIdentityDto;
  readonly ipcSocketIdentity: FluxCanonicalIdentityDto;
  readonly writeSessionAuthorityIdentity: FluxCanonicalIdentityDto;
  readonly isolatedFingerprint: string;
  readonly board: ContentIdentity;
  readonly editorLock: ContentIdentity;
  readonly ipcProbeSemanticIdentity: FluxCanonicalIdentityDto;
  readonly checkpointInspectionSessionReceiptIdentity: FluxCanonicalIdentityDto;
  readonly identity: FluxCanonicalIdentityDto;
}
export interface FluxOpenCheckpointReceiptV4 extends Omit<FluxOpenCheckpointReceiptV3, "schemaVersion"> {
  readonly schemaVersion: typeof FLUX_OPEN_CHECKPOINT_SEMANTIC_SCHEMA_VERSION;
  readonly freshNetClassSemanticAuthorityIdentity: FluxCanonicalIdentityDto | null;
}
export interface FluxOpenCheckpointReceiptV5 extends Omit<FluxOpenCheckpointReceiptV4, "schemaVersion"> {
  readonly schemaVersion: typeof FLUX_OPEN_CHECKPOINT_PREPARED_SOURCE_SCHEMA_VERSION;
  readonly freshProjectOpenPreparedSourceAuthorityIdentity: FluxCanonicalIdentityDto | null;
}
export interface FluxOpenCheckpointReceipt extends Omit<FluxOpenCheckpointReceiptV5, "schemaVersion"> {
  readonly schemaVersion: typeof FLUX_OPEN_CHECKPOINT_SCHEMA_VERSION;
  readonly freshNetClassPreparationEvidenceIdentity: FluxCanonicalIdentityDto | null;
}

export type FluxCheckpointOpenRequest = FluxPrepareRequest & Readonly<{ readonly openPreflightReceipt: FluxOpenPreflightReceipt }>;

export const FLUX_CHECKPOINT_OPERATION_TIMEOUT_MS = 270_000;
export const FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE = "The checkpoint operation exceeded its deadline after the editor side-effect boundary; the run is blocked and the operation will not be replayed automatically.";
export const FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE = "Checkpoint operation failed after admission; its side effects are uncertain and the run will not be retried automatically.";
export interface FluxCheckpointOperationContext {
  readonly signal: AbortSignal;
  readonly deadlineAtMs: number;
}

export interface FluxExecutionPorts {
  readonly prepare: (request: FluxPrepareRequest) => Promise<FluxPrepareResult>;
  readonly execute: (request: FluxExecuteRequest) => Promise<FluxExecuteResult>;
  readonly preflightOpen?: (request: FluxOpenRequest) => Promise<FluxOpenPreflightReceipt>;
  /** Releases a preflight-only socket allocation before any durable opening intent or GUI launch. */
  readonly cancelOpenPreflight?: (receipt: FluxOpenPreflightReceipt) => Promise<void>;
  readonly open?: (request: FluxOpenRequest & Readonly<{ readonly preflightReceipt: FluxOpenPreflightReceipt }>) => Promise<FluxOpenResult>;
  readonly checkpointOpen?: (request: FluxCheckpointOpenRequest, context: FluxCheckpointOperationContext) => Promise<FluxPrepareResult & Readonly<{ readonly openCheckpointReceipt: FluxOpenCheckpointReceipt }>>;
  readonly afterTerminal?: (request: { readonly runId: FluxId }) => Promise<FluxPreviewMetadata>;
}

export interface FluxCreateRunInput {
  readonly projectId: FluxId;
  readonly threadId: FluxId;
  readonly prompt: string;
  readonly providerModel: FluxProviderModel;
  readonly iterationCap: number;
  readonly harnessRuleIdentity: string;
  readonly mutationAllowlist: readonly string[];
  readonly freshAcceptanceProfileIdentity: string;
  readonly freshPersistenceProfileIdentity: string;
  readonly workflowKind: "generic" | "led_compatibility_fixture";
}

export interface FluxPersistedSource {
  readonly key: string;
  readonly label: string;
  readonly fingerprint: string;
}

export interface FluxPersistedProject extends FluxProjectDto {}
export interface FluxPersistedThread extends FluxThreadDto {}

export interface FluxPersistedApproval extends FluxApprovalDto {
  readonly subject: FluxApprovalSubject | FluxApprovalSubjectV2 | FluxApprovalSubjectV3 | FluxApprovalSubjectV4 | FluxApprovalSubjectV5;
}

interface FluxPersistedOperationIntentBase {
  readonly operation: "interpret_run" | "clarify_run" | "prepare_run" | "open_project" | "checkpoint_open" | "resume_run";
  readonly requestDigest: string;
  readonly authorityDigest: string;
  readonly priorPhase: FluxRunPhase;
  readonly startedAt: string;
}
export type FluxPersistedOperationIntent =
  | (FluxPersistedOperationIntentBase & Readonly<{ readonly schemaVersion: "evleda.flux-operation-intent.v1"; readonly openPreflightReceipt?: never }>)
  | (FluxPersistedOperationIntentBase & Readonly<{ readonly schemaVersion: "evleda.flux-operation-intent.v2"; readonly operation: "open_project"; readonly openPreflightReceipt: FluxOpenPreflightReceipt | FluxOpenPreflightReceiptV1 | FluxOpenPreflightReceiptV2 | FluxOpenPreflightReceiptV3 | FluxOpenPreflightReceiptV4 }>);

export interface FluxPersistedRun extends FluxRunDto {
  readonly sourceKey: string;
  readonly sourceFingerprint: string;
  readonly isolatedFingerprint?: string;
  readonly checkpointRequired?: boolean;
  readonly compilationBundleRef?: PcbDesignCompilationBundleRef;
  /** Durable internal operation lease. Deliberately omitted from FluxRunDto. */
  readonly inFlightOperation?: FluxPersistedOperationIntent;
  /** Private capacity reservation. Deliberately omitted from FluxRunDto. */
  readonly operationFailureEvidenceReservationRef?: FluxCanonicalIdentityDto;
  readonly freshNetClassPreparationEvidence?: FreshNetClassPreparationEvidence | FluxLegacyNetClassPreparationEvidence;
  readonly freshNetClassSemanticAuthority?: FreshNetClassSemanticAuthority | FluxLegacyNetClassSemanticAuthority;
  readonly freshProjectOpenPreparedSourceAuthority?: FreshProjectOpenPreparedSourceAuthority;
  readonly freshClearanceEvidenceReceipt?: FreshClearanceEvidenceReceipt | FluxLegacyClearanceEvidenceReceipt;
  readonly openPreflightReceipt?: FluxOpenPreflightReceipt | FluxOpenPreflightReceiptV1 | FluxOpenPreflightReceiptV2 | FluxOpenPreflightReceiptV3 | FluxOpenPreflightReceiptV4;
  readonly openCheckpointReceipt?: FluxOpenCheckpointReceipt | FluxOpenCheckpointReceiptV1 | FluxOpenCheckpointReceiptV2 | FluxOpenCheckpointReceiptV3 | FluxOpenCheckpointReceiptV4 | FluxOpenCheckpointReceiptV5;
  readonly approval?: FluxPersistedApproval;
}

export interface FluxPersistedReport extends FluxReportMetadata {
  readonly runId: FluxId;
  readonly body: string;
}

export interface FluxPersistedOperationFailure {
  readonly code: FluxErrorCode;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly diagnostic?: FluxDiagnosticDto;
  readonly identity: FluxCanonicalIdentityDto;
}

export const FLUX_OPERATION_FAILURE_EVIDENCE_RESERVATION_SCHEMA_VERSION = "evleda.flux-operation-failure-evidence-reservation.v1" as const;
export const FLUX_OPERATION_FAILURE_EVIDENCE_RESERVATION_PROVIDER_SCHEMA_VERSION = "evleda.flux-operation-failure-evidence-reservation-provider.v1" as const;
export interface FluxOperationFailureEvidenceReservation {
  readonly schemaVersion: typeof FLUX_OPERATION_FAILURE_EVIDENCE_RESERVATION_SCHEMA_VERSION;
  readonly runId: FluxId;
  readonly operation: "interpret_run" | "clarify_run";
  readonly idempotencyKey: string | null;
  readonly requestDigest: string;
  readonly providerIdentity: FluxCanonicalIdentityDto;
  readonly reservedAt: string;
  readonly identity: FluxCanonicalIdentityDto;
}

export const FLUX_OPERATION_FAILURE_SCHEMA_VERSION = "evleda.flux-operation-failure.v2" as const;
export const FLUX_TERMINAL_FAILURE_RECEIPT_SCHEMA_VERSION = "evleda.flux-terminal-failure-receipt.v1" as const;
export const FLUX_TERMINAL_FAILURE_DIAGNOSTIC_SCHEMA_VERSION = "evleda.flux-terminal-failure-diagnostic.v1" as const;
export interface FluxInterpretationFailureReceiptDto {
  readonly schemaVersion: typeof FLUX_TERMINAL_FAILURE_RECEIPT_SCHEMA_VERSION;
  readonly operation: "interpret_run" | "clarify_run";
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly projectId: FluxId;
  readonly threadId: FluxId;
  readonly runId: FluxId;
  readonly diagnosticIdentity: FluxCanonicalIdentityDto;
  readonly terminalPhase: "blocked";
  readonly outcome: "failed";
  readonly completedAt: string;
  readonly identity: FluxCanonicalIdentityDto;
}
export const FLUX_CHECKPOINT_FAILURE_RECEIPT_SCHEMA_VERSION = "evleda.flux-terminal-failure-receipt.v2" as const;
export const FLUX_CHECKPOINT_FAILURE_SCHEMA_VERSION = "evleda.flux-checkpoint-failure.v1" as const;
export interface FluxCheckpointFailureReceiptDto {
  readonly schemaVersion: typeof FLUX_CHECKPOINT_FAILURE_RECEIPT_SCHEMA_VERSION;
  readonly operation: "checkpoint_open";
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly projectId: FluxId;
  readonly threadId: FluxId;
  readonly runId: FluxId;
  readonly failureIdentity: FluxCanonicalIdentityDto;
  readonly terminalPhase: "blocked";
  readonly outcome: "failed";
  readonly completedAt: string;
  readonly identity: FluxCanonicalIdentityDto;
}
export type FluxTerminalFailureReceiptDto = FluxInterpretationFailureReceiptDto | FluxCheckpointFailureReceiptDto;
export const FLUX_TOOLCHAIN_FAILURE_MESSAGE = "Flux toolchain operation failed closed; verify the stored bundle, provider policy, source, and KiCad prerequisites before creating a new run.";

export interface FluxPersistedState {
  readonly schemaVersion: "evleda.flux.v10";
  readonly revision: number;
  readonly sources: Readonly<Record<string, FluxPersistedSource>>;
  readonly projects: Readonly<Record<string, FluxPersistedProject>>;
  readonly threads: Readonly<Record<string, FluxPersistedThread>>;
  readonly runs: Readonly<Record<string, FluxPersistedRun>>;
  readonly reports: Readonly<Record<string, FluxPersistedReport>>;
  readonly operationFailureEvidence: Readonly<Record<string, FluxOperationFailureEvidence>>;
  readonly operationFailureEvidenceReservations: Readonly<Record<string, FluxOperationFailureEvidenceReservation>>;
  readonly idempotency: Readonly<Record<string, {
    readonly operation: string; readonly digest: string; readonly resultId: FluxId; readonly runId: FluxId;
    readonly status: "pending" | "completed" | "failed" | "preflight_failed" | "preflight_uncertain" | "authority_invalidated"; readonly startedAt: string; readonly completedAt?: string;
    readonly result?: unknown; readonly failure?: FluxPersistedOperationFailure;
    readonly openPreflightReceipt?: FluxOpenPreflightReceipt | FluxOpenPreflightReceiptV1 | FluxOpenPreflightReceiptV2 | FluxOpenPreflightReceiptV3 | FluxOpenPreflightReceiptV4; readonly openPreflightFailure?: FluxOpenPreflightFailureReceipt; readonly openPreflightUncertain?: FluxOpenPreflightUncertainReceipt;
    readonly terminalReceipt?: Readonly<{ readonly outcome: "succeeded" | "failed"; readonly at: string }>;
  }>>;
  readonly events: readonly FluxEventDto[];
  readonly nextEventSeq: number;
}

export const FLUX_STATE_SCHEMA_VERSION = "evleda.flux.v10" as const;
export const FLUX_OPERATION_FAILURE_EVIDENCE_MAX_RECORDS = 256;
export const FLUX_OPERATION_FAILURE_EVIDENCE_MAX_RECORDS_PER_RUN = 1;
export const FLUX_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
export const fluxId = (prefix: string): FluxId => `${prefix}_${randomUUID()}`;
export const fluxNow = (): string => new Date().toISOString();

const canonical = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new FluxError("INVALID_ARGUMENT", "Non-finite number cannot be hashed");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new FluxError("INVALID_ARGUMENT", "Only plain data can be hashed");
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => {
      const entry = record[key];
      if (entry === undefined) throw new FluxError("INVALID_ARGUMENT", "Undefined cannot be hashed");
      return `${JSON.stringify(key)}:${canonical(entry)}`;
    }).join(",")}}`;
  }
  throw new FluxError("INVALID_ARGUMENT", "Unsupported value cannot be hashed");
};

export const fluxDigest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
export const approvalSubjectDigest = (subject: FluxApprovalSubject): string => fluxDigest(subject);
export const fluxOpenPreparationDigest = (preparation: FluxPrepareRequest): string => {
  const { openPreflightReceipt: _openPreflightReceipt, openCheckpointReceipt: _openCheckpointReceipt, freshNetClassPreparationEvidence, freshNetClassSemanticAuthority: _semanticAuthority, freshProjectOpenPreparedSourceAuthority, ...authority } = preparation;
  return fluxDigest({ ...authority,
    freshNetClassSemanticAuthorityIdentity: preparation.workflowKind === "generic" ? freshNetClassPreparationEvidence?.semanticAuthorityIdentity ?? null : null,
    freshNetClassPreparationEvidenceIdentity: preparation.workflowKind === "generic" ? freshNetClassPreparationEvidence?.identity ?? null : null,
    freshProjectOpenPreparedSourceAuthorityIdentity: preparation.workflowKind === "generic" ? freshProjectOpenPreparedSourceAuthority?.identity ?? null : null });
};

export type FluxErrorCode = "INVALID_ARGUMENT" | "NOT_FOUND" | "ILLEGAL_TRANSITION" | "APPROVAL_MISMATCH" | "APPROVAL_CONSUMED" | "IDEMPOTENCY_CONFLICT" | "OPERATION_UNCERTAIN" | "OPEN_PREFLIGHT_FAILED" | "EVIDENCE_CAPACITY" | "PATH_POLICY" | "STORE_CORRUPT";
export class FluxError extends Error {
  public constructor(public readonly code: FluxErrorCode, message: string, public readonly details: Readonly<Record<string, unknown>> = {}, public readonly diagnostic?: FluxDiagnosticDto, public readonly terminalFailureReceipt?: FluxTerminalFailureReceiptDto) {
    super(message);
    this.name = "FluxError";
  }
}

export const freeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) freeze(item);
    Object.freeze(value);
  }
  return value;
};

export const toRunDto = (run: FluxPersistedRun): FluxRunDto => freeze({
  id: run.id, projectId: run.projectId, threadId: run.threadId, phase: run.phase, prompt: run.prompt,
  providerModel: { ...run.providerModel }, iterationCap: run.iterationCap, harnessRuleIdentity: run.harnessRuleIdentity,
  mutationAllowlist: [...run.mutationAllowlist], freshAcceptanceProfileIdentity: run.freshAcceptanceProfileIdentity, freshPersistenceProfileIdentity: run.freshPersistenceProfileIdentity,
  workflowKind: run.workflowKind, ...(run.contractState === undefined ? {} : { contractState: structuredClone(run.contractState) }),
  ...(run.compilationBundleRef === undefined ? {} : { compilationBundleRef: structuredClone(run.compilationBundleRef) }),
  ...(run.checkpointRequired === undefined ? {} : { checkpointRequired: run.checkpointRequired }), ...(run.preview === undefined ? {} : { preview: { ...run.preview } }),
  reports: run.reports.map((report) => ({ ...report })),
  ...(run.approval === undefined ? {} : { approval: { id: run.approval.id, subjectDigest: run.approval.subjectDigest, approvedAt: run.approval.approvedAt, ...(run.approval.consumedAt === undefined ? {} : { consumedAt: run.approval.consumedAt }) } }),
  ...(run.blockedReason === undefined ? {} : { blockedReason: run.blockedReason }), ...(run.diagnostic === undefined ? {} : { diagnostic: structuredClone(run.diagnostic) }), createdAt: run.createdAt, updatedAt: run.updatedAt
});
