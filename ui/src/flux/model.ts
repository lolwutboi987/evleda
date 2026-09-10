export type FluxId = string;
export type FluxRunPhase = "draft" | "interpreting" | "awaiting_clarification" | "contract_ready" | "preparing" | "awaiting_open" | "opening" | "awaiting_checkpoint" | "checkpointing" | "awaiting_approval" | "approved" | "queued" | "running" | "completed" | "needs_review" | "failed" | "blocked";
export type FluxTerminalDisposition = "completed" | "needs_review" | "failed" | "blocked";
export type FluxEventKind = "project_created" | "thread_created" | "run_created" | "interpretation_started" | "clarification_requested" | "contract_compiled" | "run_prepared" | "run_opened" | "open_checkpoint_recorded" | "approval_recorded" | "approval_consumed" | "run_queued" | "run_started" | "run_progress" | "run_completed" | "run_needs_review" | "run_failed" | "run_blocked" | "preview_ready" | "preview_warning";
export type FluxPreviewKind = "schematic" | "pcb_top" | "pcb_bottom";

export type FluxProviderId = "openai" | "anthropic" | "codex" | "claude-cli";
export type FluxCanonicalTier = "provider-default" | "standard" | "priority";
export type FluxRequestedTier = "provider-default" | "standard" | "fast";
export interface FluxProviderModel { readonly provider: FluxProviderId; readonly model: string; readonly tier: FluxCanonicalTier }
export interface FluxSourceCatalogDto { readonly key: string; readonly label: string; readonly fingerprint: string }
export interface FluxProjectDto { readonly id: FluxId; readonly sourceKey: string; readonly name: string; readonly createdAt: string }
export interface FluxThreadDto { readonly id: FluxId; readonly projectId: FluxId; readonly title: string; readonly createdAt: string }
export interface FluxPreviewMetadata { readonly title: string; readonly summary: string; readonly artifactCount: number; readonly digest: string }
export interface FluxFreshAcceptanceProjection { readonly passed: boolean; readonly requirements: readonly Readonly<{ readonly id: string; readonly status: "pass" | "fail" | "unknown"; readonly detail: string }>[]; readonly missing: readonly string[]; readonly sourceHashes: Readonly<{ readonly schematicSha256: string; readonly pcbSha256: string; readonly netlistSha256?: string }>; readonly evidenceLimitations: readonly string[] }
export interface FluxFreshBoardSaveAuditProjection { readonly before: Readonly<{ readonly sha256: string; readonly bytes: number }>; readonly live: Readonly<{ readonly sha256: string; readonly bytes: number }>; readonly after: Readonly<{ readonly sha256: string; readonly bytes: number }>; readonly directorySync: "synced" | "unavailable" }
export interface FluxReportMetadata { readonly reportId: FluxId; readonly title: string; readonly digest: string; readonly mediaType: string; readonly createdAt: string; readonly disposition?: FluxTerminalDisposition; readonly summary?: string; readonly reportSha256?: string; readonly freshAcceptance?: FluxFreshAcceptanceProjection; readonly freshBoardSaveAudits?: readonly FluxFreshBoardSaveAuditProjection[] }
export interface FluxApprovalDto { readonly id: FluxId; readonly subjectDigest: string; readonly approvedAt: string; readonly consumedAt?: string }
export interface FluxCanonicalIdentityDto { readonly algorithm: "sha256"; readonly digest: string; readonly schemaVersion: string; readonly canonicalizationVersion: "evleda-c14n-json-v1" }
export interface FluxContentIdentityDto { readonly algorithm: "sha256"; readonly digest: string; readonly size: number }
export type FluxDiagnosticCode = "CODEX_CONFIG_INCOMPATIBLE" | "PROVIDER_AUTH_UNAVAILABLE" | "PROVIDER_DEADLINE_EXCEEDED" | "PROVIDER_CANCELLED" | "PROVIDER_PROCESS_EXIT" | "PROVIDER_REQUEST_FAILED" | "PROVIDER_RESPONSE_INVALID" | "SOURCE_DRIFT" | "TOOLCHAIN_FAILURE";
export interface FluxDiagnosticDto { readonly schemaVersion: "evleda.flux-diagnostic.v1"; readonly code: FluxDiagnosticCode; readonly evidenceIdentity: FluxCanonicalIdentityDto }
export interface FluxProviderProfileBindingDto { readonly schemaVersion: string; readonly provider: FluxProviderId; readonly model: string; readonly tier: FluxCanonicalTier; readonly adapterSchemaVersion: string; readonly identity: FluxCanonicalIdentityDto }
export interface FluxCompilationBundleRefDto { readonly schemaVersion: string; readonly bundleIdentity: FluxCanonicalIdentityDto; readonly contentIdentity: FluxContentIdentityDto; readonly identity: FluxCanonicalIdentityDto }
export interface FluxContractQuestionDto { readonly id: string; readonly path: string; readonly question: string }
export interface FluxContractIssueDto { readonly code: string; readonly severity: "error"; readonly path: string; readonly message: string; readonly clarificationId: string | null }
export interface FluxInterpreterReceiptV1Dto { readonly schemaVersion: "evleda.flux-interpreter-receipt.v1"; readonly interpreterSchemaVersion: string; readonly provider: string; readonly promptDigest: string; readonly clarificationDigest: string; readonly compiledAt: string }
export interface FluxInterpreterReceiptV2Dto { readonly schemaVersion: "evleda.flux-interpreter-receipt.v2"; readonly interpreterSchemaVersion: string; readonly provider: FluxProviderId; readonly providerProfile: FluxProviderProfileBindingDto; readonly providerProfileIdentity: FluxCanonicalIdentityDto; readonly promptDigest: string; readonly clarificationDigest: string; readonly compilerProfileIdentity: FluxCanonicalIdentityDto | null; readonly practiceProfileBindingIdentity: FluxCanonicalIdentityDto | null; readonly bundleIdentity: FluxCanonicalIdentityDto | null; readonly compiledAt: string; readonly identity: FluxCanonicalIdentityDto }
export type FluxInterpreterReceiptDto = FluxInterpreterReceiptV1Dto | FluxInterpreterReceiptV2Dto;
export type FluxDeepRuleFeatureName = "powerCurrent" | "signalSpeedInterfaces" | "differentialPairs" | "stackupImpedance" | "thermal" | "emi" | "placement" | "dfm" | "assembly" | "bga" | "gpio";
export interface FluxDeepRuleSummaryDto { readonly schemaVersion: "evleda.flux-deep-rule-summary.v1"; readonly deepRuleBindingIdentity: FluxCanonicalIdentityDto; readonly catalogIdentity: FluxCanonicalIdentityDto; readonly selectedCount: number; readonly selectedRuleIds: readonly string[]; readonly coveredFeatures: readonly FluxDeepRuleFeatureName[]; readonly uncoveredFeatures: readonly FluxDeepRuleFeatureName[]; readonly identity: FluxCanonicalIdentityDto }
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
export interface FluxRunDto {
  readonly id: FluxId; readonly projectId: FluxId; readonly threadId: FluxId; readonly phase: FluxRunPhase;
  readonly prompt: string; readonly providerModel: FluxProviderModel; readonly iterationCap: number;
  readonly harnessRuleIdentity: string; readonly mutationAllowlist: readonly string[]; readonly preview?: FluxPreviewMetadata;
  readonly freshAcceptanceProfileIdentity: string; readonly freshPersistenceProfileIdentity: string; readonly checkpointRequired?: boolean;
  readonly workflowKind: "generic" | "led_compatibility_fixture"; readonly contractState?: FluxContractStateDto; readonly compilationBundleRef?: FluxCompilationBundleRefDto;
  readonly reports: readonly FluxReportMetadata[]; readonly approval?: FluxApprovalDto; readonly blockedReason?: string; readonly diagnostic?: FluxDiagnosticDto;
  readonly createdAt: string; readonly updatedAt: string;
}
export interface FluxEventDto { readonly id: FluxId; readonly eventSeq: number; readonly runId?: FluxId; readonly kind: FluxEventKind; readonly at: string; readonly detail: string; readonly diagnostic?: FluxDiagnosticDto }
export type FluxSequencedEventDto = FluxEventDto;
export interface FluxQueueSnapshot { readonly busyRunId?: FluxId; readonly queuedRunIds: readonly FluxId[] }
export interface FluxOpenResult { readonly opened: boolean; readonly label: string; readonly checkpointRequired: boolean }
interface FluxApprovalSubjectBase { readonly runId: FluxId; readonly sourceKey: string; readonly sourceFingerprint: string; readonly isolatedFingerprint: string; readonly promptIdentity: FluxContentIdentityDto; readonly providerModel: FluxProviderModel; readonly iterationCap: number; readonly harnessRuleIdentity: string; readonly mutationAllowlist: readonly string[]; readonly freshAcceptanceProfileIdentity: string; readonly freshPersistenceProfileIdentity: string; readonly contractIdentity: FluxCanonicalIdentityDto; readonly libraryBindingIdentity: FluxCanonicalIdentityDto; readonly deepRuleBindingIdentity: FluxCanonicalIdentityDto; readonly acceptancePlanIdentity: FluxCanonicalIdentityDto }
export type FluxApprovalSubject =
  | (FluxApprovalSubjectBase & Readonly<{ readonly workflowKind: "generic"; readonly compilationBundleRef: FluxCompilationBundleRefDto; readonly providerProfile: FluxProviderProfileBindingDto; readonly bundleIdentity: FluxCanonicalIdentityDto; readonly compilerProfileIdentity: FluxCanonicalIdentityDto; readonly practiceProfileBindingIdentity: FluxCanonicalIdentityDto; readonly executionPromptIdentity: FluxCanonicalIdentityDto; readonly executionPromptContentIdentity: FluxContentIdentityDto }>)
  | (FluxApprovalSubjectBase & Readonly<{ readonly workflowKind: "led_compatibility_fixture"; readonly compilationBundleRef: null; readonly providerProfile: null }>);
export interface FluxApprovalSubjectDto { readonly subject: FluxApprovalSubject; readonly digest: string }
export interface FluxPollResult { readonly run: FluxRunDto; readonly queue: FluxQueueSnapshot; readonly events: readonly FluxSequencedEventDto[]; readonly nextEventSeq: number }
export interface FluxPreviewAssetDto { readonly kind: FluxPreviewKind; readonly mediaType: "image/svg+xml" | "image/png"; readonly sizeBytes: number; readonly sha256: string }
export interface FluxPreviewDto { readonly refreshedAt: string; readonly artifacts: readonly FluxPreviewAssetDto[] }
export type FluxInspectionToolName = "pcb_get_board_summary" | "pcb_get_design_rules" | "pcb_get_footprints" | "pcb_get_tracks" | "pcb_get_vias" | "pcb_get_zones";
export interface FluxInspectionToolDto { readonly tool: FluxInspectionToolName; readonly value: unknown }
export type FluxInspectorSnapshot =
  | Readonly<{ readonly state: "idle"; readonly busy: false; readonly completedTools: 0; readonly totalTools: number }>
  | Readonly<{ readonly state: "busy"; readonly busy: true; readonly completedTools: number; readonly totalTools: number; readonly activeTool: FluxInspectionToolName }>
  | Readonly<{ readonly state: "ready"; readonly busy: false; readonly completedTools: number; readonly totalTools: number; readonly capturedAt: string; readonly boardSummary: FluxInspectionToolDto; readonly rules: FluxInspectionToolDto; readonly footprints: FluxInspectionToolDto; readonly tracks: FluxInspectionToolDto; readonly vias: FluxInspectionToolDto; readonly zones: FluxInspectionToolDto }>;

export type FluxReadinessReasonCode = "FLUX_DISABLED" | "ROOTS_INCOMPLETE" | "PROVIDER_NOT_CONFIGURED" | "MODEL_NOT_CONFIGURED" | "AUTH_NOT_CONFIGURED" | "PROVIDER_EXECUTABLE_UNAVAILABLE" | "PROVIDER_PROCESS_TERMINATION_UNCONFIRMED" | "CODEX_LOCAL_READ_ACK_REQUIRED" | "CODEX_CONFIG_INCOMPATIBLE" | "COMPILER_PROFILE_MISSING" | "COMPILER_PROFILE_INVALID" | "KICAD_MCP_RUNTIME_UNAVAILABLE" | "KICAD_PROCESS_TERMINATION_UNCONFIRMED" | "KICAD_TOOLCHAIN_UNAVAILABLE" | "KICAD_LIBRARY_UNAVAILABLE" | "RULE_CATALOG_UNAVAILABLE";
export interface FluxReadinessProviderDto { readonly provider: FluxProviderId; readonly model: string; readonly requestedTier: FluxRequestedTier; readonly canonicalTier: FluxCanonicalTier; readonly adapterSchemaVersion: string; readonly providerProfileIdentity: FluxCanonicalIdentityDto; readonly localReadCapability: "none" | "read_only_host_files"; readonly configurationPreflight: null | Readonly<{ readonly status: "passed"; readonly evidenceIdentity: FluxCanonicalIdentityDto; readonly capabilityProfileIdentity: FluxCanonicalIdentityDto; readonly imageInspectionPolicy: "disabled_by_pinned_feature" }> }
export interface FluxReadinessCompilerDto { readonly profileIdentity: FluxCanonicalIdentityDto; readonly catalogIdentity: FluxCanonicalIdentityDto; readonly exactSymbolCount: number; readonly exactFootprintCount: number; readonly symbolNicknameCount: number; readonly footprintNicknameCount: number }
export interface FluxReadinessToolchainDto { readonly identity: FluxCanonicalIdentityDto; readonly kicadCli: Readonly<{ readonly identity: FluxCanonicalIdentityDto; readonly operationalVersion: string; readonly operationalCommit: string; readonly peFileVersion: string; readonly peProductVersion: string }>; readonly pcbnew: Readonly<{ readonly identity: FluxCanonicalIdentityDto; readonly peFileVersion: string; readonly peProductVersion: string }> }
export interface FluxReadinessKicadMcpRuntimeDto { readonly identity: FluxCanonicalIdentityDto; readonly inspectionBridgeIdentity: FluxCanonicalIdentityDto; readonly executionBridgeIdentity: FluxCanonicalIdentityDto; readonly connectionPolicy: Readonly<{ readonly maxConnections: 8; readonly concurrency: 1; readonly reuse: "same-live-run-bounded"; readonly restart: "fail-closed-reallocate-reapprove"; readonly cleanup: "after-confirmed-session-and-editor-stop"; readonly unconfirmed: "retain-poison-no-retry" }> }
export interface FluxRuntimeReadinessDto { readonly schemaVersion: "evleda.flux-readiness.v1"; readonly configured: boolean; readonly status: "ready" | "setup_required"; readonly reasonCodes: readonly FluxReadinessReasonCode[]; readonly provider: FluxReadinessProviderDto | null; readonly compiler: FluxReadinessCompilerDto | null; readonly toolchain: FluxReadinessToolchainDto | null; readonly kicadMcpRuntime: FluxReadinessKicadMcpRuntimeDto | null; readonly diagnostic: FluxDiagnosticDto | null }

/** User-authored fields only. Runtime authority is copied from the server policy by the API client. */
export interface FluxCreateInput { readonly sourceKey: string; readonly projectName: string; readonly threadTitle: string; readonly prompt: string; readonly iterationCap: number }
export interface FluxIterationCapPolicyDto { readonly minimum: number; readonly maximum: number; readonly recommended: number }
export interface FluxRuntimePolicyDto { readonly providerModel: FluxProviderModel; readonly iterationCap: FluxIterationCapPolicyDto; readonly harnessRuleIdentity: string; readonly mutationAllowlist: readonly string[]; readonly freshProjectNamePattern: "^[a-z][a-z0-9-]{0,63}$"; readonly checkpointOpenRequiredForFresh: true; readonly freshAcceptanceProfileIdentity: string; readonly freshPersistenceProfileIdentity: string }
export interface FluxRunBindingDto { readonly projectId: string; readonly threadId: string }
export interface FluxApi {
  resetBrowserIntents(): void;
  readiness(signal?: AbortSignal): Promise<FluxRuntimeReadinessDto>;
  policy(signal?: AbortSignal): Promise<FluxRuntimePolicyDto>;
  sources(signal?: AbortSignal): Promise<readonly FluxSourceCatalogDto[]>;
  projects(signal?: AbortSignal): Promise<readonly FluxProjectDto[]>;
  runs(signal?: AbortSignal): Promise<readonly FluxRunDto[]>;
  createRun(input: FluxCreateInput, policy: FluxRuntimePolicyDto, signal?: AbortSignal): Promise<FluxRunDto>;
  getRun(runId: string, signal?: AbortSignal): Promise<FluxRunDto>;
  interpret(runId: string, signal?: AbortSignal, binding?: FluxRunBindingDto): Promise<FluxRunDto>;
  clarifications(runId: string, answers: readonly FluxClarificationAnswerDto[], signal?: AbortSignal, binding?: FluxRunBindingDto): Promise<FluxRunDto>;
  contract(runId: string, signal?: AbortSignal): Promise<FluxContractStateDto>;
  prepare(runId: string, signal?: AbortSignal): Promise<FluxRunDto>;
  poll(runId: string, afterEventSeq: number, signal?: AbortSignal): Promise<FluxPollResult>;
  approvalSubject(runId: string, signal?: AbortSignal): Promise<FluxApprovalSubjectDto>;
  approve(runId: string, digest: string, signal?: AbortSignal): Promise<FluxRunDto>;
  resume(runId: string, signal?: AbortSignal): Promise<FluxRunDto>;
  open(projectId: string, runId?: string, signal?: AbortSignal): Promise<FluxOpenResult>;
  checkpointOpen(runId: string, signal?: AbortSignal): Promise<FluxRunDto>;
  preview(runId: string, signal?: AbortSignal): Promise<FluxPreviewDto>;
  refreshPreview(runId: string, signal?: AbortSignal): Promise<FluxPreviewDto>;
  inspector(signal?: AbortSignal): Promise<FluxInspectorSnapshot>;
  inspect(signal?: AbortSignal): Promise<FluxInspectorSnapshot>;
  previewUrl(runId: string, kind: FluxPreviewKind): string;
}

const PROVIDER_LABELS: Readonly<Record<FluxProviderId, string>> = Object.freeze({
  openai: "OpenAI",
  anthropic: "Anthropic",
  codex: "Codex CLI",
  "claude-cli": "Claude CLI",
});

export const fluxProviderLabel = (provider: unknown): string => typeof provider === "string" && Object.hasOwn(PROVIDER_LABELS, provider) ? PROVIDER_LABELS[provider as FluxProviderId] : "Unsupported provider";

const READINESS_MESSAGES: Readonly<Record<FluxReadinessReasonCode, string>> = Object.freeze({
  FLUX_DISABLED: "Flux is disabled on this local service.",
  ROOTS_INCOMPLETE: "The source and isolated-workspace bindings are incomplete.",
  PROVIDER_NOT_CONFIGURED: "Select one supported interpretation provider.",
  MODEL_NOT_CONFIGURED: "Select a model for the interpretation provider.",
  AUTH_NOT_CONFIGURED: "Configure authentication for the selected provider.",
  PROVIDER_EXECUTABLE_UNAVAILABLE: "The selected local provider executable is unavailable.",
  PROVIDER_PROCESS_TERMINATION_UNCONFIRMED: "The provider process tree could not be confirmed stopped; inspect the host before retrying.",
  CODEX_LOCAL_READ_ACK_REQUIRED: "Codex CLI requires an explicit profile-bound acknowledgement of its local read capability.",
  CODEX_CONFIG_INCOMPATIBLE: "Pinned Codex CLI configuration is incompatible with the required isolation profile.",
  COMPILER_PROFILE_MISSING: "The PCB compiler profile has not been configured.",
  COMPILER_PROFILE_INVALID: "The PCB compiler profile failed validation.",
  KICAD_MCP_RUNTIME_UNAVAILABLE: "The pinned read-only KiCad inspection bridge is unavailable or incompatible.",
  KICAD_PROCESS_TERMINATION_UNCONFIRMED: "A KiCad readiness-probe process may still be running; inspect and terminate it before restarting.",
  KICAD_TOOLCHAIN_UNAVAILABLE: "The pinned KiCad CLI and PCB editor toolchain is unavailable or incompatible.",
  KICAD_LIBRARY_UNAVAILABLE: "The required KiCad library catalog is unavailable.",
  RULE_CATALOG_UNAVAILABLE: "The researched PCB rule catalog is unavailable.",
});

export const fluxReadinessMessage = (code: unknown): string => typeof code === "string" && Object.hasOwn(READINESS_MESSAGES, code) ? READINESS_MESSAGES[code as FluxReadinessReasonCode] : "An unrecognized setup blocker was reported.";
