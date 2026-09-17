import { canonicalIdentity, canonicalJson, constantTimeDigestEqual, contentIdentity } from "../core/canonical.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import { z } from "zod";
import { FRESH_NATIVE_NETLIST_COMPARISON_SCHEMA_VERSION } from "./fresh-native-netlist-comparison.js";
import { PCB_EXTERNAL_POWER_BINDING_SCHEMA_VERSION, parsePcbExternalPowerBinding, type PcbExternalPowerBinding } from "./pcb-external-power.js";
import { PCB_DERIVED_POWER_BINDING_SCHEMA_VERSION, parsePcbDerivedPowerBinding, type PcbDerivedPowerBinding } from "./pcb-derived-power.js";

import {
  parseHarnessOptions,
  parseHarnessProviderRequest,
  parseHarnessProviderTurn,
  harnessToolResultSchema,
  type HarnessOptions,
  type HarnessProvider,
  type HarnessProviderMessage,
  type HarnessProviderTurn,
  type HarnessToolCall,
  type HarnessToolPort,
  type HarnessToolResult,
  type HarnessValidationFeedback,
  type HarnessMutationBatchDisposition
} from "./contracts.js";
import {
  renderPcbDesignerPrompt,
  summarizePcbFeedbackForNextIteration,
  type PcbCheckFeedback,
  type PcbCheckFinding,
  type PcbDesignerPromptConstraints
} from "./pcb-rules.js";

/** The bridge names are explicit so a host cannot accidentally skip final checks. */
export const DEFAULT_PCB_HARNESS_VALIDATION_TOOLS = Object.freeze({
  erc: "run_erc",
  drc: "run_drc",
  boardSummary: "pcb_get_board_summary",
  visualInspection: "pcb_visual_qa",
  save: "pcb_save"
});

export interface PcbHarnessValidationTools {
  readonly erc: string;
  readonly drc: string;
  readonly boardSummary: string;
  readonly visualInspection: string;
  readonly save: string;
}

export interface PcbHarnessOperation {
  readonly iteration: number;
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly result: HarnessToolResult;
  readonly phase: "agent" | "save" | "validation";
  readonly status: "succeeded" | "failed";
  readonly error?: string;
}

export interface PcbAgentHarnessRunReport {
  /** V1 remains readable; every newly executed run is emitted as V2. */
  readonly schemaVersion: "evleda.pcb-agent-harness-run.v1" | "evleda.pcb-agent-harness-run.v2";
  readonly status: "completed" | "needs_review" | "blocked" | "failed";
  readonly provider: string;
  readonly prompt: string;
  /** Exact UTF-8 identity of the user frame sent to the provider. */
  readonly providerPromptContentIdentity?: ContentIdentity;
  readonly constraints: readonly string[];
  readonly projectPaths: { readonly projectPath: string; readonly reportPath: string };
  readonly operations: readonly PcbHarnessOperation[];
  /** Host-only dispositions; provider narration cannot create these records. */
  readonly mutationBatchDispositions: readonly HarnessMutationBatchDisposition[];
  readonly validation: {
    readonly status: "passed" | "unresolved" | "not_run";
    readonly runs: number;
    readonly ercRuns: number;
    readonly drcRuns: number;
    readonly boardReviewRuns: number;
    readonly unresolvedItems: readonly string[];
    /** Host snapshots bracketing the same native validation pass. */
    readonly sourceBinding?: PcbHarnessValidationSourceBinding;
  };
  readonly iterations: readonly {
    readonly iteration: number;
    readonly stopReason: HarnessProviderTurn["stopReason"];
    readonly validation: HarnessValidationFeedback;
  }[];
  readonly summary: string;
}

export const PCB_AGENT_HARNESS_RUN_SCHEMA_VERSION = "evleda.pcb-agent-harness-run.v2" as const;
export const PCB_AGENT_HARNESS_LEGACY_RUN_SCHEMA_VERSION = "evleda.pcb-agent-harness-run.v1" as const;

export interface PcbAgentHarnessConfig {
  readonly validationTools?: PcbHarnessValidationTools;
  readonly mutationToolNames?: readonly string[];
  /** Trusted, exact task contract rendered outside the compact general-rules budget. */
  readonly taskContract?: string;
  /**
   * Compiler-owned provider frame. The harness verifies its content identity
   * and sends `text` byte-for-byte, without trimming, rendering, appending, or
   * truncating it.
   */
  readonly exactProviderPrompt?: PcbHarnessExactProviderPrompt;
  /** Exact host-bound identity required on every contract-connectivity result. */
  readonly compoundMutationContractIdentity?: CanonicalIdentity;
  /** Trusted annotation inventory for externally powered contract-connectivity mutations. */
  readonly compoundMutationExternalPowerBinding?: PcbExternalPowerBinding;
  /** Trusted combined annotation inventory for reviewed derived-power mutations. */
  readonly compoundMutationDerivedPowerBinding?: PcbDerivedPowerBinding;
  /** Host-selected rule guidance; caller prompt text cannot alter this policy. */
  readonly designerPrompt?: Omit<PcbDesignerPromptConstraints, "constraints" | "userConstraints">;
  /** Host-owned readback required after fresh incremental schematic mutations. */
  readonly postSchematicReadbackTool?: string;
  /** Fresh runs may batch authoring turns before the first expensive full validation. */
  readonly deferFullValidationUntilPhaseBoundary?: boolean;
  /** Trusted host cap. Copied runs retain the default five-turn cap. */
  readonly maxIterations?: number;
  /** Semantic completion is separate from ERC/DRC cleanliness. */
  readonly completionGate?: (evidence: PcbHarnessCompletionEvidence) => Promise<Readonly<{ passed: boolean; missing: readonly string[] }>>;
  /** Current acceptance profiles use remaining repair turns after native validation passes but the quality gate fails. */
  readonly repairCompletionGateFailures?: boolean;
  /** Explicitly discard host evidence before a reviewed mutation can change sources. */
  readonly invalidateCompletionEvidence?: () => void;
  /** Host read of the exact schematic/PCB bytes bracketing native validation. */
  readonly captureValidationSource?: () => Promise<PcbHarnessValidationSourceSnapshot>;
  /**
   * Optional, best-effort observation hook for local progress displays. It is
   * deliberately not part of the provider transcript or persisted report.
   */
  readonly observer?: PcbAgentHarnessObserver;
}

/** Exact native results from the same ordered validation pass that precedes completion. */
export interface PcbHarnessCompletionEvidence {
  readonly erc: HarnessToolResult;
  readonly drc: HarnessToolResult;
  readonly boardSummary: HarnessToolResult;
  readonly visualInspection: HarnessToolResult;
  readonly sourceBinding?: PcbHarnessValidationSourceBinding;
}

export interface PcbHarnessExactProviderPrompt {
  readonly text: string;
  readonly textContentIdentity: ContentIdentity;
}

export interface PcbHarnessValidationSourceSnapshot {
  readonly schematic: ContentIdentity;
  readonly pcb: ContentIdentity;
  /** Generic fresh runs also bind every rule/library source consumed by native checks. */
  readonly projectSettings?: ContentIdentity;
  readonly customRules?: ContentIdentity | null;
  readonly symbolLibraryTable?: ContentIdentity;
  readonly footprintLibraryTable?: ContentIdentity;
  readonly freshMarker?: ContentIdentity;
}

export interface PcbHarnessValidationSourceBinding {
  readonly schemaVersion: typeof PCB_HARNESS_VALIDATION_SOURCE_BINDING_SCHEMA_VERSION;
  readonly before: PcbHarnessValidationSourceSnapshot;
  readonly after: PcbHarnessValidationSourceSnapshot;
  readonly unchanged: boolean;
  readonly identity: CanonicalIdentity;
}

export const PCB_HARNESS_VALIDATION_SOURCE_BINDING_SCHEMA_VERSION = "evleda.pcb-harness-validation-source-binding.v1" as const;

export type PcbAgentHarnessEvent =
  | Readonly<{ readonly type: "operation"; readonly operation: PcbHarnessOperation }>
  | Readonly<{
      readonly type: "validation";
      readonly iteration: number;
      readonly validation: HarnessValidationFeedback;
    }>;

export type PcbAgentHarnessObserver = (event: PcbAgentHarnessEvent) => void | Promise<void>;

/** Explicit reviewed mutations; inspection calls do not satisfy editsRequired. */
export const DEFAULT_PCB_HARNESS_MUTATION_TOOL_NAMES = Object.freeze([
  "sch_apply_plan", "sch_add_symbol", "sch_modify_property", "lib_assign_footprint", "fresh_apply_contract_connectivity", "fresh_apply_recommended_schematic_placement", "fresh_autoplace_schematic_fields", "fresh_replace_route_items", "fresh_sync_from_schematic", "sch_move_symbol", "pcb_set_board_outline", "pcb_add_track", "pcb_add_via",
  "pcb_place_component", "pcb_move_component", "pcb_move_footprint", "pcb_sync_from_schematic", "pcb_add_zone",
] as const);

const MAX_ITERATIONS = 5;
/** Shared executable bounds for every fresh-project host surface. */
export const PCB_AGENT_MIN_ITERATIONS = 1 as const;
export const PCB_AGENT_MAX_FRESH_ITERATIONS = 24 as const;
export const PCB_AGENT_RECOMMENDED_FRESH_ITERATIONS = 12 as const;
const TOOL_RESULT_MESSAGE_CHARS = 4_000;
const VALIDATION_RESULT_CHARS = 2_000;
export const PCB_HARNESS_TASK_CONTRACT_MAX_BYTES = 8 * 1024;

const compact = (value: string, limit: number): string => {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 15)).trimEnd()} [truncated]`;
};

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

const validSourceSnapshot = (value: PcbHarnessValidationSourceSnapshot): boolean => {
  const identities = [
    value.schematic, value.pcb, value.projectSettings,
    value.symbolLibraryTable, value.footprintLibraryTable, value.freshMarker,
    ...(value.customRules === null ? [] : [value.customRules]),
  ].filter((identity): identity is ContentIdentity => identity !== undefined);
  return identities.every((identity) => identity.algorithm === "sha256"
    && /^[a-f0-9]{64}$/u.test(identity.digest)
    && Number.isSafeInteger(identity.size) && identity.size >= 0);
};

const canonicalIdentityBaseSchema = z.object({
  algorithm: z.literal("sha256"),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  schemaVersion: z.string().min(1).max(128),
  canonicalizationVersion: z.literal("evleda-c14n-json-v1"),
}).strict();
const compoundIdentitySchema = canonicalIdentityBaseSchema.extend({ schemaVersion: z.literal("evleda.fresh-connectivity-contract.v1") }).strict();
const placementStateIdentitySchema = canonicalIdentityBaseSchema.extend({ schemaVersion: z.literal("evleda.fresh-schematic-placement-state.v1") }).strict();
const compoundIssueSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,95}$/u),
  message: z.string().trim().min(1).max(2_000),
  remediation: z.string().trim().min(1).max(2_000),
  endpoints: z.array(z.string().trim().min(1).max(128)).max(512).optional(),
  atMm: z.object({ x: z.number().finite(), y: z.number().finite() }).strict().optional(),
}).strict();
const recommendationMoveSchema = z.object({
  reference: z.string().regex(/^[A-Z][A-Z0-9_-]{0,31}$/u),
  xMm: z.number().finite().min(-2_000).max(2_000),
  yMm: z.number().finite().min(-2_000).max(2_000),
  rotationDeg: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
}).strict();
const recommendationPlanIdentitySchema = compoundIdentitySchema.extend({
  schemaVersion: z.literal("evleda.fresh-connectivity-placement-plan.v2"),
}).strict();
const issueEvidenceSchema = z.object({
  total: z.number().int().nonnegative(), returned: z.number().int().nonnegative().max(128), truncated: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.total < value.returned || value.truncated !== (value.total > value.returned)) context.addIssue({ code: "custom", message: "bounded evidence counts are inconsistent" });
});
const recommendationSearchEvidenceSchema = z.object({
  schemaVersion: z.literal("evleda.fresh-connectivity-placement-search.v1"),
  status: z.enum(["found", "exhausted", "unsupported"]),
  gridMm: z.literal(2.54),
  slotPitchMm: z.literal(25.4),
  rotationPolicy: z.literal("current-only"),
  workingBoundsMm: z.object({ minX: z.literal(15.24), minY: z.literal(15.24), maxX: z.literal(279.4), maxY: z.literal(195.58) }).strict(),
  limits: z.object({
    maxComponents: z.literal(8), maxEndpoints: z.literal(64), maxCandidatesPerComponent: z.literal(64), maxTotalCandidates: z.literal(512),
    maxConfigurations: z.literal(2_048), maxStates: z.literal(100_000), maxPlanEvaluations: z.literal(2_048), maxSegmentChecks: z.literal(20_000_000),
  }).strict(),
  configurationsEvaluated: z.number().int().nonnegative(),
  statesVisited: z.number().int().nonnegative(),
  planEvaluations: z.number().int().nonnegative(),
  segmentChecks: z.number().int().nonnegative(),
  candidateCount: z.number().int().nonnegative(),
  exhaustionReason: z.enum(["none", "component-limit", "endpoint-limit", "candidate-limit", "state-limit", "configuration-limit", "plan-evaluation-limit", "segment-check-limit", "no-solution"]),
  blockingEdgeEvidence: issueEvidenceSchema,
}).strict().superRefine((value, context) => {
  if (value.configurationsEvaluated > value.limits.maxConfigurations) context.addIssue({ code: "custom", message: "configurationsEvaluated exceeds its deterministic limit" });
  if (value.statesVisited > value.limits.maxStates) context.addIssue({ code: "custom", message: "statesVisited exceeds its deterministic limit" });
  if (value.planEvaluations > value.limits.maxPlanEvaluations) context.addIssue({ code: "custom", message: "planEvaluations exceeds its deterministic limit" });
  if (value.segmentChecks > value.limits.maxSegmentChecks) context.addIssue({ code: "custom", message: "segmentChecks exceeds its deterministic limit" });
  if (value.candidateCount > value.limits.maxTotalCandidates) context.addIssue({ code: "custom", message: "candidateCount exceeds its deterministic limit" });
  if ((value.status === "found") !== (value.exhaustionReason === "none")) context.addIssue({ code: "custom", message: "found status must correspond exactly to exhaustionReason=none" });
});
const compoundMutationResultSchema = z.object({
  schemaVersion: z.literal("evleda.fresh-contract-connectivity-result.v1"),
  contractIdentity: compoundIdentitySchema,
  applied: z.boolean(),
  mutated: z.boolean(),
  idempotent: z.boolean(),
  rolledBack: z.boolean().optional(),
  issues: z.array(compoundIssueSchema).max(128),
  routes: z.array(z.string().trim().min(1).max(384)).max(512).optional(),
  noConnects: z.array(z.string().trim().min(1).max(128)).max(512).optional(),
  connectivity: z.array(z.object({
    name: z.string().trim().min(1).max(256),
    endpoints: z.array(z.string().trim().min(1).max(128)).max(512),
  }).strict()).max(512).optional(),
  externalPowerAnnotations: z.array(z.object({
    reference: z.string().regex(/^#FLG[0-9]{3}$/u),
    x: z.number().finite().min(-2_000).max(2_000),
    y: z.number().finite().min(-2_000).max(2_000),
    rotation: z.literal(0),
  }).strict()).min(2).max(16).optional(),
  externalPowerBindingIdentity: canonicalIdentityBaseSchema.extend({
    schemaVersion: z.literal(PCB_EXTERNAL_POWER_BINDING_SCHEMA_VERSION),
  }).strict().optional(),
  powerAnnotations: z.array(z.object({
    reference: z.string().regex(/^#FLG[0-9]{3}$/u),
    x: z.number().finite().min(-2_000).max(2_000),
    y: z.number().finite().min(-2_000).max(2_000),
    rotation: z.literal(0),
  }).strict()).min(2).max(16).optional(),
  powerAnnotationBindingIdentity: canonicalIdentityBaseSchema.extend({
    schemaVersion: z.literal(PCB_DERIVED_POWER_BINDING_SCHEMA_VERSION),
  }).strict().optional(),
  nativeNetlistSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  nativeNetCount: z.number().int().nonnegative().optional(),
  nativeComponentCount: z.number().int().nonnegative().optional(),
  recommendedMoves: z.array(recommendationMoveSchema).max(8).optional(),
  recommendationIdentity: recommendationPlanIdentitySchema.optional(),
  startingPlacementIdentity: placementStateIdentitySchema.optional(),
  startingSchematicSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  targetPlacementIdentity: placementStateIdentitySchema.optional(),
  targetPlacements: z.array(recommendationMoveSchema).max(8).optional(),
  recommendationInstruction: z.string().trim().min(1).max(2_000).optional(),
  searchEvidence: recommendationSearchEvidenceSchema.optional(),
  issueEvidence: issueEvidenceSchema.optional(),
  blockingEdges: z.array(z.object({
    net: z.string().trim().min(1).max(256),
    endpoints: z.tuple([z.string().trim().min(1).max(128), z.string().trim().min(1).max(128)]),
  }).strict()).max(64).optional(),
  blockingEdgeEvidence: issueEvidenceSchema.optional(),
}).strict().superRefine((value, context) => {
  if ((value.externalPowerAnnotations === undefined) !== (value.externalPowerBindingIdentity === undefined)) {
    context.addIssue({ code: "custom", message: "external power annotations and binding identity must be supplied together" });
  }
  if (value.externalPowerAnnotations !== undefined) {
    if (!value.applied) context.addIssue({ code: "custom", message: "external power annotations require applied=true" });
    if (value.externalPowerAnnotations.some((annotation, index) => annotation.reference !== `#FLG${String(index + 1).padStart(3, "0")}`)) {
      context.addIssue({ code: "custom", message: "external power annotation references must be complete, unique, and canonically sorted" });
    }
  }
  if ((value.powerAnnotations === undefined) !== (value.powerAnnotationBindingIdentity === undefined)) {
    context.addIssue({ code: "custom", message: "power annotations and binding identity must be supplied together" });
  }
  if (value.powerAnnotations !== undefined) {
    if (value.externalPowerAnnotations !== undefined || value.externalPowerBindingIdentity !== undefined) context.addIssue({ code: "custom", message: "generic and external power annotation result branches are mutually exclusive" });
    if (!value.applied) context.addIssue({ code: "custom", message: "power annotations require applied=true" });
    if (value.powerAnnotations.some((annotation, index) => annotation.reference !== `#FLG${String(index + 1).padStart(3, "0")}`)) {
      context.addIssue({ code: "custom", message: "power annotation references must be complete, unique, and canonically sorted" });
    }
  }
  if (value.applied && value.issues.length !== 0) context.addIssue({ code: "custom", message: "applied=true requires zero issues" });
  if (!value.applied && value.issues.length === 0) context.addIssue({ code: "custom", message: "applied=false requires at least one issue" });
  if (value.mutated && !value.applied) context.addIssue({ code: "custom", message: "mutated=true requires applied=true" });
  if (value.mutated && value.idempotent) context.addIssue({ code: "custom", message: "mutated=true is incompatible with idempotent=true" });
  if (value.applied && !value.mutated && !value.idempotent) context.addIssue({ code: "custom", message: "applied without mutation requires idempotent=true" });
  if (value.rolledBack === true && (value.applied || value.mutated || value.issues.length === 0)) context.addIssue({ code: "custom", message: "rolledBack=true requires applied=false, mutated=false, and issues" });
  if (value.nativeNetlistSha256 !== undefined && (!value.applied || value.mutated || !value.idempotent)) context.addIssue({ code: "custom", message: "inline native parity is valid only for applied idempotent readback" });
  if (value.issueEvidence !== undefined) {
    if (value.issueEvidence.returned !== value.issues.length || value.issueEvidence.total < value.issueEvidence.returned || value.issueEvidence.truncated !== (value.issueEvidence.total > value.issueEvidence.returned)) context.addIssue({ code: "custom", message: "issueEvidence must exactly describe the returned issue array" });
  }
  const moveCount = value.recommendedMoves?.length ?? 0;
  if (moveCount > 0 && (value.applied || value.mutated || value.recommendationIdentity === undefined || value.startingPlacementIdentity === undefined || value.startingSchematicSha256 === undefined || value.targetPlacementIdentity === undefined || value.targetPlacements === undefined || value.searchEvidence?.status !== "found" || value.recommendationInstruction === undefined)) {
    context.addIssue({ code: "custom", message: "recommendedMoves requires a non-mutating rejected result with complete identity-bound target evidence and instruction" });
  }
  if (moveCount === 0 && [value.recommendationIdentity, value.startingPlacementIdentity, value.startingSchematicSha256, value.targetPlacementIdentity, value.targetPlacements].some((entry) => entry !== undefined)) context.addIssue({ code: "custom", message: "recommendation identity and target fields require recommendedMoves" });
  if (value.searchEvidence?.status === "found" && moveCount === 0) context.addIssue({ code: "custom", message: "found search evidence requires recommendedMoves" });
  if (value.recommendedMoves !== undefined) {
    const references = value.recommendedMoves.map((move) => move.reference);
    if (new Set(references).size !== references.length || references.some((reference, index) => index > 0 && references[index - 1]! > reference)) context.addIssue({ code: "custom", message: "recommendedMoves references must be unique and canonically sorted" });
    for (const move of value.recommendedMoves) {
      if (Math.abs(move.xMm / 2.54 - Math.round(move.xMm / 2.54)) > 1e-8 || Math.abs(move.yMm / 2.54 - Math.round(move.yMm / 2.54)) > 1e-8) context.addIssue({ code: "custom", message: "recommendedMoves positions must lie on the 2.54 mm grid" });
      if (move.xMm < 15.24 || move.xMm > 279.4 || move.yMm < 15.24 || move.yMm > 195.58) context.addIssue({ code: "custom", message: "recommendedMoves position exceeds working bounds" });
    }
  }
  if (value.targetPlacements !== undefined) {
    const references = value.targetPlacements.map((placement) => placement.reference);
    if (references.length === 0 || new Set(references).size !== references.length || references.some((reference, index) => index > 0 && references[index - 1]! > reference)) context.addIssue({ code: "custom", message: "targetPlacements must be a complete canonically sorted unique set" });
    for (const move of value.recommendedMoves ?? []) {
      const target = value.targetPlacements.find((placement) => placement.reference === move.reference);
      if (target === undefined || canonicalJson(target) !== canonicalJson(move)) context.addIssue({ code: "custom", message: "every recommended move must exactly reproduce its targetPlacements member" });
    }
  }
  if (value.blockingEdges !== undefined) {
    const keys = value.blockingEdges.map((edge) => `${edge.net}\u0000${edge.endpoints.join("\u0000")}`);
    if (new Set(keys).size !== keys.length || keys.some((key, index) => index > 0 && keys[index - 1]! > key)) context.addIssue({ code: "custom", message: "blockingEdges must be unique and canonically sorted" });
  }
  if (value.blockingEdgeEvidence !== undefined && value.blockingEdgeEvidence.returned !== (value.blockingEdges?.length ?? 0)) context.addIssue({ code: "custom", message: "blockingEdgeEvidence returned count must match blockingEdges" });
});
const recommendedPlacementMutationResultSchema = z.object({
  schemaVersion: z.literal("evleda.fresh-recommended-schematic-placement-result.v1"),
  contractIdentity: compoundIdentitySchema,
  recommendationIdentity: recommendationPlanIdentitySchema,
  applied: z.boolean(), mutated: z.boolean(), idempotent: z.literal(false),
  issues: z.array(compoundIssueSchema).max(128),
}).strict().superRefine((value, context) => {
  if (value.applied !== value.mutated) context.addIssue({ code: "custom", message: "atomic placement applied and mutated flags must match" });
  if (value.applied && value.issues.length !== 0) context.addIssue({ code: "custom", message: "successful atomic placement requires zero issues" });
  if (!value.applied && value.issues.length === 0) context.addIssue({ code: "custom", message: "rejected atomic placement requires an issue" });
});
const contentIdentitySchema = z.object({
  algorithm: z.literal("sha256"), digest: z.string().regex(/^[a-f0-9]{64}$/u), size: z.number().int().nonnegative(),
}).strict();
const freshSchematicFieldsResultSchema = z.object({
  schemaVersion: z.literal("evleda.fresh-schematic-fields-result.v1"), contractIdentity: compoundIdentitySchema,
  applied: z.literal(true), mutated: z.boolean(), idempotent: z.boolean(),
  beforeSchematicContentIdentity: contentIdentitySchema, afterSchematicContentIdentity: contentIdentitySchema,
  references: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/u)).min(1).max(128),
  movedFieldCount: z.number().int().nonnegative().max(256), nativeNetlistSha256: z.string().regex(/^[a-f0-9]{64}$/u), issues: z.tuple([]),
  identity: canonicalIdentityBaseSchema.extend({ schemaVersion: z.literal("evleda.fresh-schematic-fields-result.v1") }).strict(),
}).strict().superRefine((value, context) => {
  const changed = canonicalJson(value.beforeSchematicContentIdentity) !== canonicalJson(value.afterSchematicContentIdentity);
  if (value.mutated !== changed || value.idempotent !== !changed || (!changed && value.movedFieldCount !== 0) || value.movedFieldCount > 2 * value.references.length || canonicalJson(value.references) !== canonicalJson([...new Set(value.references)].sort())) context.addIssue({ code: "custom", message: "Field repair must bind its sorted references and exact presentation source effect." });
});
const routeSelectionIdentitySchema = canonicalIdentityBaseSchema.extend({ schemaVersion: z.literal("evleda.fresh-route-selection.v1") }).strict();
const freshRouteReplacementResultSchema = z.object({
  schemaVersion: z.literal("evleda.fresh-route-replacement-result.v1"),
  contractIdentity: compoundIdentitySchema,
  genericProjectBindingIdentity: canonicalIdentityBaseSchema.extend({ schemaVersion: z.literal("evleda.pcb-agent-generic-fresh-binding.v1") }).strict(),
  freshMarkerContentIdentity: contentIdentitySchema,
  applied: z.literal(true), mutated: z.literal(true), idempotent: z.literal(false),
  selectionIdentity: routeSelectionIdentitySchema,
  beforePcbContentIdentity: contentIdentitySchema,
  livePcbContentIdentity: contentIdentitySchema,
  net: z.string().min(1).max(64),
  deletedItemIds: z.array(z.string().min(1).max(128)).min(1).max(128),
  addedTrackCount: z.number().int().min(0).max(128),
  addedViaCount: z.number().int().min(0).max(32),
  issues: z.tuple([]),
  identity: canonicalIdentityBaseSchema.extend({ schemaVersion: z.literal("evleda.fresh-route-replacement-result.v1") }).strict(),
}).strict();
const nativeExportDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u).refine((value) => {
  const parsed = new Date(`${value}Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value;
}, "native export date must be a valid local ISO timestamp with seconds");
const nativeNetlistComparisonEntrySchema = z.object({
  rawIdentity: contentIdentitySchema,
  exportDate: nativeExportDateSchema,
  comparisonIdentity: canonicalIdentityBaseSchema.extend({ schemaVersion: z.literal(FRESH_NATIVE_NETLIST_COMPARISON_SCHEMA_VERSION) }).strict(),
}).strict();
const nativeNetlistComparisonSchema = z.object({
  equal: z.literal(true),
  before: nativeNetlistComparisonEntrySchema,
  after: nativeNetlistComparisonEntrySchema,
}).strict().superRefine((value, context) => {
  if (canonicalJson(value.before.comparisonIdentity) !== canonicalJson(value.after.comparisonIdentity)) {
    context.addIssue({ code: "custom", message: "successful sync requires equal native comparison identities" });
  }
});
const freshSyncResultSchema = z.object({
  schemaVersion: z.literal("evleda.fresh-sync-from-schematic-result.v1"),
  contractIdentity: compoundIdentitySchema,
  genericProjectBindingIdentity: canonicalIdentityBaseSchema.extend({ schemaVersion: z.literal("evleda.pcb-agent-generic-fresh-binding.v1") }).strict(),
  freshMarkerContentIdentity: contentIdentitySchema,
  applied: z.literal(true), mutated: z.literal(true), idempotent: z.literal(false),
  beforePcbContentIdentity: contentIdentitySchema,
  afterPcbContentIdentity: contentIdentitySchema,
  schematicContentIdentity: contentIdentitySchema,
  nativeNetlistComparison: nativeNetlistComparisonSchema,
  receivedSidecarResponseIdentity: contentIdentitySchema,
  placementReview: z.object({
    status: z.literal("pending-final-acceptance"),
    interimFindings: z.array(z.string().min(7).max(32_000).regex(/^- (?:FAIL|WARN):[^\r\n]*$/u)).max(128),
  }).strict(),
  footprintLibraryTableIdentity: contentIdentitySchema,
  componentCount: z.number().int().positive(), padCount: z.number().int().positive(),
  namedPadCount: z.number().int().nonnegative(), noConnectPadCount: z.number().int().nonnegative(),
  unresolvedMappingCount: z.literal(0), issues: z.tuple([]),
  identity: canonicalIdentityBaseSchema.extend({ schemaVersion: z.literal("evleda.fresh-sync-from-schematic-result.v1") }).strict(),
}).strict();
export const freshSyncV2ResultFieldsSchema = freshSyncResultSchema.omit({
  padCount: true, namedPadCount: true, noConnectPadCount: true,
}).extend({
  schemaVersion: z.literal("evleda.fresh-sync-from-schematic-result.v2"),
  physicalPadCount: z.number().int().nonnegative(),
  logicalTerminalCount: z.number().int().nonnegative(),
  numberedCopperPrimitiveCount: z.number().int().nonnegative(),
  namedCopperPrimitiveCount: z.number().int().nonnegative(),
  noConnectCopperPrimitiveCount: z.number().int().nonnegative(),
  netlessCopperPrimitiveCount: z.number().int().nonnegative().optional(),
  functionalCopperPrimitiveCount: z.number().int().nonnegative().optional(),
  logicalNamedTerminalCount: z.number().int().nonnegative(),
  logicalNoConnectTerminalCount: z.number().int().nonnegative(),
  nonElectricalFeatureCount: z.number().int().nonnegative(),
  platedFootprintHoleCount: z.number().int().nonnegative(),
  nativePadSnapshotIdentity: contentIdentitySchema,
  physicalPadExpectedIdentity: canonicalIdentityBaseSchema.extend({ schemaVersion: z.literal("evleda.kicad-native-pad-expected.v1") }).strict(),
  upstreamMetrics: z.object({
    totalPadsConsidered: z.number().int().nonnegative(), namedPads: z.number().int().nonnegative(), noNetPads: z.number().int().nonnegative(),
    transferQuality: z.enum(["CLEAN", "DEGRADED", "POOR", "UNKNOWN"]),
    namedPadCoveragePercent: z.number().min(0).max(100),
    fullyNamedReferences: z.number().int().nonnegative(), partiallyNamedReferences: z.number().int().nonnegative(),
    unresolvedPadReferences: z.string(), additionalUnresolvedReferences: z.number().int().nonnegative(), literalLines: z.array(z.string()),
  }).strict(),
  identity: canonicalIdentityBaseSchema.extend({ schemaVersion: z.literal("evleda.fresh-sync-from-schematic-result.v2") }).strict(),
}).strict();
export const refineFreshPhysicalSyncCounts = (
  value: Pick<z.infer<typeof freshSyncV2ResultFieldsSchema>, "physicalPadCount" | "numberedCopperPrimitiveCount" | "nonElectricalFeatureCount" | "namedCopperPrimitiveCount" | "noConnectCopperPrimitiveCount" | "netlessCopperPrimitiveCount" | "functionalCopperPrimitiveCount" | "logicalTerminalCount" | "logicalNamedTerminalCount" | "logicalNoConnectTerminalCount" | "platedFootprintHoleCount" | "upstreamMetrics">,
  context: z.RefinementCtx,
): void => {
  if (value.physicalPadCount !== value.numberedCopperPrimitiveCount + value.nonElectricalFeatureCount
      || value.numberedCopperPrimitiveCount !== value.namedCopperPrimitiveCount + (value.netlessCopperPrimitiveCount??value.noConnectCopperPrimitiveCount)
      || (value.netlessCopperPrimitiveCount===undefined)!==(value.functionalCopperPrimitiveCount===undefined)
      || value.functionalCopperPrimitiveCount!==undefined&&value.numberedCopperPrimitiveCount!==value.functionalCopperPrimitiveCount+value.noConnectCopperPrimitiveCount
      || value.logicalTerminalCount !== value.logicalNamedTerminalCount + value.logicalNoConnectTerminalCount
      || value.platedFootprintHoleCount > value.numberedCopperPrimitiveCount) {
    context.addIssue({ code: "custom", message: "Physical and logical pad count equations must agree." });
  }
  if (value.upstreamMetrics.totalPadsConsidered !== value.numberedCopperPrimitiveCount
      || value.upstreamMetrics.namedPads !== value.namedCopperPrimitiveCount
      || value.upstreamMetrics.noNetPads !== (value.netlessCopperPrimitiveCount??value.noConnectCopperPrimitiveCount)) {
    context.addIssue({ code: "custom", message: "Upstream pad metrics must bind numbered copper primitive counts." });
  }
};
const freshSyncV2ResultSchema = freshSyncV2ResultFieldsSchema.superRefine(refineFreshPhysicalSyncCounts);
const versionedFreshSyncResultSchema = z.union([freshSyncResultSchema, freshSyncV2ResultSchema]);
export const mutationBatchDispositionSchema = z.object({
  schemaVersion: z.literal("evleda.mutation-batch-disposition.v1"),
  status: z.literal("no-governed-effect"),
  domain: z.literal("schematic-file"),
  baselineSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  observedSha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

export const compoundMutationState = (
  call: HarnessToolCall,
  result: HarnessToolResult,
  expectedIdentity: CanonicalIdentity | undefined,
  expectedExternalPowerBinding?: PcbExternalPowerBinding,
  expectedDerivedPowerBinding?: PcbDerivedPowerBinding,
): boolean | undefined => {
  if (!["fresh_apply_contract_connectivity", "fresh_apply_recommended_schematic_placement", "fresh_autoplace_schematic_fields", "fresh_replace_route_items", "fresh_sync_from_schematic"].includes(call.name)) return undefined;
  let value: unknown;
  try { value = JSON.parse(result.content) as unknown; }
  catch (error) { throw new Error(`${call.name} returned invalid JSON.`, { cause: error }); }
  if (call.name === "fresh_autoplace_schematic_fields") {
    const fields = freshSchematicFieldsResultSchema.parse(value);
    const { identity, ...payload } = fields;
    if (expectedIdentity === undefined || canonicalJson(fields.contractIdentity) !== canonicalJson(expectedIdentity) || canonicalJson(identity) !== canonicalJson(canonicalIdentity(payload, fields.schemaVersion)) || Object.keys(call.arguments).length !== 0) throw new Error("Field repair result does not bind the exact host contract and empty-argument request.");
    return fields.mutated;
  }
  if (call.name === "fresh_replace_route_items" || call.name === "fresh_sync_from_schematic") {
    const parsedBoardMutation = call.name === "fresh_replace_route_items"
      ? freshRouteReplacementResultSchema.safeParse(value)
      : versionedFreshSyncResultSchema.safeParse(value);
    if (!parsedBoardMutation.success) throw new Error(`${call.name} returned an invalid host board-mutation result: ${parsedBoardMutation.error.issues.slice(0, 8).map((issue) => issue.message).join("; ")}`);
    if (expectedIdentity === undefined || canonicalJson(parsedBoardMutation.data.contractIdentity) !== canonicalJson(expectedIdentity)) {
      throw new Error(`${call.name} result contractIdentity does not match the host-bound contract.`);
    }
    if (call.name === "fresh_replace_route_items") {
      const argumentsValue = call.arguments as {
        readonly selectionIdentity?: unknown; readonly deleteItemIds?: unknown; readonly net?: unknown;
        readonly tracks?: unknown; readonly vias?: unknown;
      };
      const routeData = parsedBoardMutation.data as z.infer<typeof freshRouteReplacementResultSchema>;
      if (canonicalJson(routeData.selectionIdentity) !== canonicalJson(argumentsValue.selectionIdentity)
          || canonicalJson(routeData.deletedItemIds) !== canonicalJson([...(argumentsValue.deleteItemIds as readonly string[] ?? [])].sort())
          || routeData.net !== argumentsValue.net
          || routeData.addedTrackCount !== (Array.isArray(argumentsValue.tracks) ? argumentsValue.tracks.length : -1)
          || routeData.addedViaCount !== (Array.isArray(argumentsValue.vias) ? argumentsValue.vias.length : -1)) {
        throw new Error("fresh_replace_route_items result does not bind its exact selection, net, deletion, and addition request.");
      }
    }
    const { identity, ...payload } = parsedBoardMutation.data;
    if (canonicalJson(identity) !== canonicalJson(canonicalIdentity(payload, parsedBoardMutation.data.schemaVersion))) {
      throw new Error(`${call.name} result identity does not reproduce from its closed payload.`);
    }
    return true;
  }
  if (call.name === "fresh_apply_recommended_schematic_placement") {
    const parsedPlacement = recommendedPlacementMutationResultSchema.safeParse(value);
    if (!parsedPlacement.success) throw new Error(`fresh_apply_recommended_schematic_placement returned an invalid mutation-status contract: ${parsedPlacement.error.issues.slice(0, 8).map((issue) => issue.message).join("; ")}`);
    if (expectedIdentity === undefined || canonicalJson(parsedPlacement.data.contractIdentity) !== canonicalJson(expectedIdentity)) throw new Error("fresh_apply_recommended_schematic_placement result contractIdentity does not match the host-bound contract.");
    const supplied = (call.arguments as { recommendationIdentity?: unknown }).recommendationIdentity;
    if (canonicalJson(parsedPlacement.data.recommendationIdentity) !== canonicalJson(supplied)) throw new Error("fresh_apply_recommended_schematic_placement result identity does not match its sole provider argument.");
    return parsedPlacement.data.mutated;
  }
  const parsed = compoundMutationResultSchema.safeParse(value);
  if (!parsed.success) throw new Error(`fresh_apply_contract_connectivity returned an invalid mutation-status contract: ${parsed.error.issues.slice(0, 8).map((issue) => issue.message).join("; ")}`);
  if (expectedIdentity === undefined) throw new Error("fresh_apply_contract_connectivity has no host-bound contract identity.");
  if (canonicalJson(parsed.data.contractIdentity) !== canonicalJson(expectedIdentity)) {
    throw new Error("fresh_apply_contract_connectivity result contractIdentity does not match the host-bound contract.");
  }
  const externalPowerBinding = expectedExternalPowerBinding === undefined ? undefined : parsePcbExternalPowerBinding(expectedExternalPowerBinding);
  const derivedPowerBinding = expectedDerivedPowerBinding === undefined ? undefined
    : parsePcbDerivedPowerBinding(expectedDerivedPowerBinding, undefined, externalPowerBinding);
  if (parsed.data.externalPowerAnnotations !== undefined) {
    if (derivedPowerBinding !== undefined) throw new Error("fresh_apply_contract_connectivity requires the combined derived power annotation result branch.");
    if (externalPowerBinding === undefined) throw new Error("fresh_apply_contract_connectivity has no host-bound external power annotation inventory.");
    if (canonicalJson(parsed.data.externalPowerBindingIdentity) !== canonicalJson(externalPowerBinding.identity)
        || canonicalJson(parsed.data.externalPowerAnnotations.map(annotation => annotation.reference)) !== canonicalJson(externalPowerBinding.flags.map(flag => flag.reference))) {
      throw new Error("fresh_apply_contract_connectivity external power annotations do not match the host-bound binding identity and inventory.");
    }
  } else if (derivedPowerBinding === undefined && externalPowerBinding !== undefined && parsed.data.mutated) {
    throw new Error("fresh_apply_contract_connectivity mutated an externally powered contract without its required annotation result and binding identity.");
  }
  if (parsed.data.powerAnnotations !== undefined) {
    if (derivedPowerBinding === undefined) throw new Error("fresh_apply_contract_connectivity has no host-bound derived power annotation inventory.");
    if (canonicalJson(parsed.data.powerAnnotationBindingIdentity) !== canonicalJson(derivedPowerBinding.identity)
        || canonicalJson(parsed.data.powerAnnotations.map(annotation => annotation.reference)) !== canonicalJson(derivedPowerBinding.flags.map(flag => flag.reference))) {
      throw new Error("fresh_apply_contract_connectivity power annotations do not match the host-bound derived binding identity and inventory.");
    }
  } else if (derivedPowerBinding !== undefined && parsed.data.mutated) {
    throw new Error("fresh_apply_contract_connectivity mutated a derived powered contract without its required combined annotation result and binding identity.");
  }
  if (parsed.data.recommendedMoves !== undefined && parsed.data.recommendedMoves.length > 0) {
    const expectedPlanIdentity = canonicalIdentity({
      schemaVersion: "evleda.fresh-connectivity-placement-plan.v2",
      contractIdentity: parsed.data.contractIdentity,
      startingPlacementIdentity: parsed.data.startingPlacementIdentity,
      startingSchematicSha256: parsed.data.startingSchematicSha256,
      targetPlacementIdentity: parsed.data.targetPlacementIdentity,
      targetPlacements: parsed.data.targetPlacements,
      searchProfile: {
        schemaVersion: parsed.data.searchEvidence!.schemaVersion,
        gridMm: parsed.data.searchEvidence!.gridMm,
        workingBoundsMm: parsed.data.searchEvidence!.workingBoundsMm,
        slotPitchMm: parsed.data.searchEvidence!.slotPitchMm,
        rotationPolicy: parsed.data.searchEvidence!.rotationPolicy,
        ...parsed.data.searchEvidence!.limits,
      },
      recommendedMoves: parsed.data.recommendedMoves,
    }, "evleda.fresh-connectivity-placement-plan.v2");
    if (canonicalJson(parsed.data.recommendationIdentity) !== canonicalJson(expectedPlanIdentity)) throw new Error("fresh_apply_contract_connectivity recommendationIdentity does not reproduce from its complete bound start and target state.");
  }
  return parsed.data.mutated;
};

const detachedFrozen = <Value>(value: Value): Value => {
  const copy = structuredClone(value);
  const visit = (item: unknown): void => {
    if (typeof item !== "object" || item === null || Object.isFrozen(item)) return;
    for (const child of Object.values(item as Record<string, unknown>)) visit(child);
    Object.freeze(item);
  };
  visit(copy);
  return copy;
};

const validationCall = (id: string, name: string): HarnessToolCall => ({
  id,
  name,
  // The locked sidecar is already rooted in the isolated project.  Supplying
  // a made-up projectPath parameter would make a real schema validation fail.
  arguments: {}
});

interface ParsedValidationResult {
  readonly clean: boolean;
  readonly findings: readonly PcbCheckFinding[];
}

const parseFindings = (value: unknown): readonly PcbCheckFinding[] => {
  if (!Array.isArray(value)) return [];
  return value.map((finding, index) => {
    if (typeof finding === "string" && finding.trim().length > 0) return [{ message: finding.trim() }];
    if (finding !== null && typeof finding === "object") {
      const item = finding as { message?: unknown; description?: unknown; severity?: unknown; code?: unknown; type?: unknown };
      const message = typeof item.message === "string" ? item.message : typeof item.description === "string" ? item.description : null;
      if (message === null || message.trim().length === 0) return { severity: "error", code: "MALFORMED_FINDING", message: `Validator finding ${index + 1} has unsupported content.` };
      return {
        message,
        ...(typeof item.severity === "string" ? { severity: item.severity } : {}),
        ...(typeof item.code === "string" ? { code: item.code } : typeof item.type === "string" ? { code: item.type } : {})
      };
    }
    return { severity: "error", code: "MALFORMED_FINDING", message: `Validator finding ${index + 1} has unsupported shape.` };
  }).flat();
};

const recordValue = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const explicitCount = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (Array.isArray(value)) return value.length;
  return null;
};

interface CountInspection { readonly malformed: readonly string[]; readonly nonzero: readonly string[] }

const inspectKnownValidatorCounts = (record: Record<string, unknown>): CountInspection => {
  const malformed: string[] = [];
  const nonzero: string[] = [];
  const inspect = (candidate: Record<string, unknown> | null, label: string, summary = false): void => {
    if (candidate === null) return;
    const keys = summary
      ? ["error", "warning"]
      : ["violation_count", "violations", "error_count", "errors", "warning_count", "warnings", "unconnected_items", "courtyard_issues"];
    for (const key of keys) {
      if (!Object.hasOwn(candidate, key)) continue;
      const count = explicitCount(candidate[key]);
      if (count === null) malformed.push(`${label}${key}`);
      else if (count !== 0) nonzero.push(`${label}${key}=${count}`);
    }
  };
  inspect(record, "");
  const metadata = recordValue(record.metadata);
  inspect(metadata, "metadata.");
  inspect(recordValue(metadata?.summary), "metadata.summary.", true);
  return { malformed, nonzero };
};

const validatorCountSummary = (record: Record<string, unknown>, label: string, status: string): string => {
  const counts = inspectKnownValidatorCounts(record);
  return `${label} reported ${status || "no explicit clean verdict"}${counts.nonzero.length === 0 ? "" : ` (${counts.nonzero.join(", ")})`}.`;
};

/** Treat ambiguous validator output as unresolved; only an explicit clean/pass may close ERC or DRC. */
const parseValidationResult = (result: HarnessToolResult, label: string): ParsedValidationResult => {
  if (result.isError) return { clean: false, findings: [{ severity: "error", code: label, message: compact(result.content, 800) }] };
  try {
    const value: unknown = JSON.parse(result.content);
    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const status = typeof record.status === "string" ? record.status.toLowerCase() : "";
      const verdict = typeof record.verdict === "string" ? record.verdict.toLowerCase() : "";
      const malformedDisposition =
        Object.hasOwn(record, "status") && typeof record.status !== "string" ||
        Object.hasOwn(record, "verdict") && typeof record.verdict !== "string" ||
        Object.hasOwn(record, "passed") && typeof record.passed !== "boolean";
      const statusPass = ["clean", "pass", "passed"].includes(status);
      const statusFail = ["fail", "failed", "error", "fatal", "critical", "unresolved", "unknown", "not_run"].includes(status);
      const verdictPass = ["clean", "pass", "passed"].includes(verdict);
      const verdictFail = ["fail", "failed", "error", "fatal", "critical", "unresolved", "unknown", "not_run"].includes(verdict);
      const contradiction = statusFail && (record.passed === true || verdictPass) || verdictFail && (record.passed === true || statusPass) || (statusPass || verdictPass) && record.passed === false;
      const clean = !malformedDisposition && !contradiction && !statusFail && !verdictFail && (record.passed === true || statusPass || verdictPass);
      const malformedCollections = ["findings", "issues"].filter((key) => Object.hasOwn(record, key) && !Array.isArray(record[key]));
      const findings = [...parseFindings(record.findings), ...parseFindings(record.issues)];
      const counts = inspectKnownValidatorCounts(record);
      const accepted = clean && findings.length === 0 && malformedCollections.length === 0 && counts.malformed.length === 0 && counts.nonzero.length === 0;
      const diagnostics: PcbCheckFinding[] = [
        ...(malformedDisposition ? [{ severity: "error", code: label, message: `${label} status/verdict/passed fields have malformed types.` }] : []),
        ...(contradiction ? [{ severity: "error", code: label, message: `${label} status/passed fields contradict each other.` }] : []),
        ...(malformedCollections.length === 0 ? [] : [{ severity: "error", code: label, message: `${label} ${malformedCollections.join("/")} must be arrays.` }]),
        ...(counts.malformed.length === 0 ? [] : [{ severity: "error", code: label, message: `${label} count field(s) have malformed types: ${counts.malformed.join(", ")}.` }]),
        ...(counts.nonzero.length === 0 ? [] : [{ severity: "error", code: label, message: `${label} reported nonzero blocking counts: ${counts.nonzero.join(", ")}.` }]),
      ];
      return {
        clean: accepted,
        findings: accepted
          ? []
          : [...findings, ...diagnostics, ...(findings.length === 0 && diagnostics.length === 0 ? [{ severity: "error", code: label, message: validatorCountSummary(record, label, status) }] : [])],
      };
    }
  } catch {
    // A useful board summary may be prose, but ERC/DRC must be machine-explicit.
  }
  return { clean: false, findings: [{ severity: "error", code: label, message: `Validator returned no explicit clean result: ${compact(result.content, 800)}` }] };
};

const parseBoardSummaryResult = (result: HarnessToolResult): ParsedValidationResult => {
  const parsed = parseValidationResult(result, "BOARD_SUMMARY");
  if (!parsed.clean) return parsed;
  const record = recordValue(JSON.parse(result.content));
  const metadata = recordValue(record?.metadata) ?? record;
  const required = ["footprints", "nets", "tracks", "shapes"] as const;
  const problems = required.flatMap((key) => {
    const count = explicitCount(metadata?.[key]);
    return count === null ? [`${key}=missing/malformed`] : count === 0 ? [`${key}=0`] : [];
  });
  return problems.length === 0 ? parsed : {
    clean: false,
    findings: [{ severity: "error", code: "BOARD_SUMMARY", message: `Board summary lacks required nonempty design evidence: ${problems.join(", ")}.` }],
  };
};

const parseVisualResult = (result: HarnessToolResult): ParsedValidationResult => {
  const parsed = parseValidationResult(result, "VISUAL");
  if (!parsed.clean) return parsed;
  const record = recordValue(JSON.parse(result.content));
  const footprintCount = explicitCount(record?.footprint_count);
  const bounds = record?.board_bounds;
  const validBounds = Array.isArray(bounds) && bounds.length === 4 && bounds.every((entry) => typeof entry === "number" && Number.isFinite(entry)) &&
    (bounds[2] as number) > (bounds[0] as number) && (bounds[3] as number) > (bounds[1] as number);
  if (footprintCount !== null && footprintCount > 0 && validBounds) return parsed;
  return {
    clean: false,
    findings: [{ severity: "error", code: "VISUAL", message: `Visual QA lacks required nonempty design evidence: footprint_count=${footprintCount === null ? "missing/malformed" : footprintCount}, board_bounds=${validBounds ? "valid" : "missing/malformed"}.` }],
  };
};

const hasTool = (port: HarnessToolPort, name: string): boolean => port.tools.some((tool) => tool.name === name);

/**
 * Runs a small, bounded edit/validate conversation.  It deliberately returns a
 * JSON-ready report rather than writing files: persistence and the KiCad bridge
 * remain host-owned boundaries.
 */
export async function runPcbAgentHarness(
  input: unknown,
  provider: HarnessProvider,
  toolPort: HarnessToolPort,
  config: PcbAgentHarnessConfig = {}
): Promise<PcbAgentHarnessRunReport> {
  const options = parseHarnessOptions(input);
  const externalPowerBinding = config.compoundMutationExternalPowerBinding === undefined ? undefined
    : parsePcbExternalPowerBinding(config.compoundMutationExternalPowerBinding);
  const derivedPowerBinding = config.compoundMutationDerivedPowerBinding === undefined ? undefined
    : parsePcbDerivedPowerBinding(config.compoundMutationDerivedPowerBinding, undefined, externalPowerBinding);
  const validationTools = config.validationTools ?? DEFAULT_PCB_HARNESS_VALIDATION_TOOLS;
  let prompt: string;
  if (config.exactProviderPrompt !== undefined) {
    if (config.taskContract !== undefined || config.designerPrompt !== undefined) {
      throw new Error("Exact provider prompts cannot be combined with harness prompt rendering or an appended task contract.");
    }
    const exact = config.exactProviderPrompt;
    if (typeof exact.text !== "string" || exact.text.length === 0) throw new Error("Exact provider prompt must be non-empty text.");
    const actual = contentIdentity(exact.text);
    if (exact.textContentIdentity.algorithm !== "sha256"
        || exact.textContentIdentity.size !== actual.size
        || !constantTimeDigestEqual(exact.textContentIdentity.digest, actual.digest)) {
      throw new Error("Exact provider prompt content identity does not match its UTF-8 bytes.");
    }
    prompt = exact.text;
  } else {
    const rulesPrompt = renderPcbDesignerPrompt({
      ...config.designerPrompt,
      constraints: options.fixedRules,
      maxChars: config.designerPrompt?.maxChars ?? 2_400,
    });
    const taskContract = config.taskContract?.trim();
    if (taskContract !== undefined && Buffer.byteLength(taskContract, "utf8") > PCB_HARNESS_TASK_CONTRACT_MAX_BYTES) {
      throw new Error(`Harness task contract exceeds the ${PCB_HARNESS_TASK_CONTRACT_MAX_BYTES}-byte limit; refusing to truncate it.`);
    }
    // Legacy copied-project and LED-fixture prompts retain their bounded,
    // rendered V1 composition. Generic compiler-owned prompts never enter it.
    const boundedCliPrompt = options.userPrompt.length <= 16_000
      ? options.userPrompt
      : `${options.userPrompt.slice(0, 15_985)} [truncated]`;
    prompt = [
      rulesPrompt,
      ...(taskContract === undefined || taskContract.length === 0 ? [] : [`Exact task contract (host-owned; do not relax):\n${taskContract}`]),
      `Requested PCB work (verbatim bounded CLI prompt): ${boundedCliPrompt}`,
      "Project binding: isolated and host-owned; use the supplied KiCad tools without requesting or disclosing a filesystem path.",
    ].join("\n\n");
  }
  const providerPromptContentIdentity = contentIdentity(prompt);
  const operations: PcbHarnessOperation[] = [];
  const iterations: PcbAgentHarnessRunReport["iterations"] extends readonly (infer Item)[] ? Item[] : never[] = [];
  let validationRuns = 0;
  let ercRuns = 0;
  let drcRuns = 0;
  let boardReviewRuns = 0;
  let unresolvedItems: string[] = [];
  let lastToolError = "";
  let lastValidationPassed: boolean | null = null;
  let lastValidationSummary = "";
  let completionEvidence: PcbHarnessCompletionEvidence | null = null;
  let lastSourceBinding: PcbHarnessValidationSourceBinding | undefined;
  const mutationBatchDispositions: HarnessMutationBatchDisposition[] = [];

  const report = (
    status: PcbAgentHarnessRunReport["status"],
    summary: string,
    validationStatus: PcbAgentHarnessRunReport["validation"]["status"] = validationRuns === 0 ? "not_run" : lastValidationPassed === true ? "passed" : "unresolved"
  ): PcbAgentHarnessRunReport => ({
    schemaVersion: PCB_AGENT_HARNESS_RUN_SCHEMA_VERSION,
    status,
    provider: provider.provider,
    prompt,
    providerPromptContentIdentity,
    constraints: [...options.fixedRules],
    projectPaths: { projectPath: options.projectPath, reportPath: options.reportPath },
    operations: [...operations],
    mutationBatchDispositions: [...mutationBatchDispositions],
    validation: {
      status: validationStatus,
      runs: validationRuns,
      ercRuns,
      drcRuns,
      boardReviewRuns,
      unresolvedItems: [...unresolvedItems],
      ...(lastSourceBinding === undefined ? {} : { sourceBinding: lastSourceBinding })
    },
    iterations: [...iterations],
    summary
  });

  const requiredValidationTools = [validationTools.erc, validationTools.drc, validationTools.boardSummary, validationTools.visualInspection];
  const missing = requiredValidationTools.filter((name) => toolPort.internal === undefined && !hasTool(toolPort, name));
  if (missing.length > 0) return report("blocked", `Validation tool port is missing: ${missing.join(", ")}.`);

  const messages: HarnessProviderMessage[] = [
    {
      role: "system",
      content: "Use only supplied tools. Do not make manufacturing, release, safety, or qualification claims."
    },
    {
      role: "user",
      content: prompt
    }
  ];
  let editsOccurred = false;
  let previousResponseId: string | undefined;
  const mutationToolNames = new Set(config.mutationToolNames ?? DEFAULT_PCB_HARNESS_MUTATION_TOOL_NAMES);
  const configuredIterationCap = config.maxIterations ?? MAX_ITERATIONS;
  if (!Number.isSafeInteger(configuredIterationCap) || configuredIterationCap < PCB_AGENT_MIN_ITERATIONS || configuredIterationCap > PCB_AGENT_MAX_FRESH_ITERATIONS) {
    throw new Error(`Harness iteration cap must be an integer from ${PCB_AGENT_MIN_ITERATIONS} through ${PCB_AGENT_MAX_FRESH_ITERATIONS}.`);
  }
  const iterationLimit = Math.min(options.maxIterations, configuredIterationCap);
  const observe = async (event: PcbAgentHarnessEvent): Promise<void> => {
    // Progress displays must never alter an editing run or its CLI outcome.
    try {
      await config.observer?.(detachedFrozen(event));
    } catch {
      // Observation is expressly best-effort.
    }
  };

  const execute = async (call: HarnessToolCall, iteration: number, phase: PcbHarnessOperation["phase"]): Promise<HarnessToolResult | null> => {
    try {
      const result = harnessToolResultSchema.parse(
        phase === "validation" && toolPort.internal !== undefined
          ? await toolPort.internal.execute(call)
          : phase === "save" && toolPort.internal !== undefined
            ? await toolPort.internal.saveAfterMutation(call)
            : await toolPort.execute(call),
      );
      if (result.toolCallId !== call.id) throw new Error(`Tool result ID ${result.toolCallId} does not match ${call.id}`);
      const operation = Object.freeze({ iteration, id: call.id, name: call.name, arguments: call.arguments, result, phase, status: "succeeded" } as const);
      operations.push(operation);
      await observe(Object.freeze({ type: "operation", operation }));
      // Only model-issued agent calls belong in a provider transcript. Host save
      // and validation evidence remains in the report; the bounded summary below
      // is the sole feedback channel for a subsequent turn.
      if (phase === "agent") messages.push({ role: "tool", toolCallId: call.id, content: compact(result.content, TOOL_RESULT_MESSAGE_CHARS) });
      return result;
    } catch (error) {
      lastToolError = `${call.name}: ${errorText(error)}`;
      const failure = harnessToolResultSchema.parse({ toolCallId: call.id, content: lastToolError, isError: true });
      const operation = Object.freeze({ iteration, id: call.id, name: call.name, arguments: call.arguments, result: failure, phase, status: "failed", error: lastToolError } as const);
      operations.push(operation);
      await observe(Object.freeze({ type: "operation", operation }));
      return null;
    }
  };

  const validate = async (iteration: number): Promise<HarnessValidationFeedback | null> => {
    validationRuns += 1;
    let beforeSource: PcbHarnessValidationSourceSnapshot | undefined;
    let sourceCaptureProblem = "";
    if (config.captureValidationSource !== undefined) {
      try {
        beforeSource = await config.captureValidationSource();
        if (!validSourceSnapshot(beforeSource)) {
          beforeSource = undefined;
          sourceCaptureProblem = "Host source capture before native validation returned malformed identities.";
        }
      }
      catch (error) { sourceCaptureProblem = `Host source capture before native validation failed: ${errorText(error)}`; }
    }
    const calls = [
      validationCall(`validation-${iteration}-erc`, validationTools.erc),
      validationCall(`validation-${iteration}-drc`, validationTools.drc),
      validationCall(`validation-${iteration}-board-summary`, validationTools.boardSummary),
      validationCall(`validation-${iteration}-visual`, validationTools.visualInspection)
    ] as const;
    const results: HarnessToolResult[] = [];
    for (const call of calls) {
      const result = await execute(call, iteration, "validation");
      if (result === null) {
        lastValidationPassed = false;
        unresolvedItems = [`${call.name}: tool execution failed.`];
        return null;
      }
      results.push(result);
    }
    ercRuns += 1;
    drcRuns += 1;
    boardReviewRuns += 2;
    const [erc, drc, boardSummary, visual] = results;
    let sourceBinding: PcbHarnessValidationSourceBinding | undefined;
    if (config.captureValidationSource !== undefined && beforeSource !== undefined) {
      try {
        const afterSource = await config.captureValidationSource();
        if (!validSourceSnapshot(afterSource)) throw new Error("host returned malformed source identities");
        const unchanged = canonicalJson(beforeSource) === canonicalJson(afterSource);
        const sourceBindingPayload = {
          schemaVersion: PCB_HARNESS_VALIDATION_SOURCE_BINDING_SCHEMA_VERSION,
          before: beforeSource,
          after: afterSource,
          unchanged,
        };
        sourceBinding = Object.freeze({
          ...sourceBindingPayload,
          identity: canonicalIdentity(sourceBindingPayload, PCB_HARNESS_VALIDATION_SOURCE_BINDING_SCHEMA_VERSION),
        });
        lastSourceBinding = sourceBinding;
        if (!unchanged) sourceCaptureProblem = "Authoritative schematic or PCB source changed during the native validation pass.";
      } catch (error) {
        sourceCaptureProblem = `Host source capture after native validation failed: ${errorText(error)}`;
      }
    }
    completionEvidence = Object.freeze({
      erc: erc!, drc: drc!, boardSummary: boardSummary!, visualInspection: visual!,
      ...(sourceBinding === undefined ? {} : { sourceBinding }),
    });
    const ercResult = parseValidationResult(erc!, "ERC");
    const drcResult = parseValidationResult(drc!, "DRC");
    const visualResult = parseVisualResult(visual!);
    const boardResult = parseBoardSummaryResult(boardSummary!);
    const sourceFindings: PcbCheckFinding[] = sourceCaptureProblem.length === 0 ? [] : [{ severity: "error", code: "SOURCE_BINDING", message: sourceCaptureProblem }];
    const findings = [...ercResult.findings, ...drcResult.findings, ...boardResult.findings, ...visualResult.findings, ...sourceFindings];
    unresolvedItems = [...new Set(findings
      .map((finding) => compact(finding.message, 1_000))
      .filter((item) => item.length > 0))];
    const passed = ercResult.clean && drcResult.clean && boardResult.clean && visualResult.clean && sourceCaptureProblem.length === 0;
    const feedback: PcbCheckFeedback = {
      analyzer: { outcome: visualResult.clean && sourceCaptureProblem.length === 0 ? "pass" : "review", findings: [...visualResult.findings, ...sourceFindings] },
      erc: { status: ercResult.clean ? "clean" : "unresolved", findings: ercResult.findings },
      drc: { status: drcResult.clean ? "clean" : "unresolved", findings: drcResult.findings }
    };
    const validation = {
      passed,
      summary: summarizePcbFeedbackForNextIteration(feedback, VALIDATION_RESULT_CHARS),
      issues: unresolvedItems.slice(0, 128)
    };
    lastValidationPassed = passed;
    lastValidationSummary = validation.summary;
    await observe(Object.freeze({ type: "validation", iteration, validation }));
    return validation;
  };

  for (let iteration = 1; iteration <= iterationLimit; iteration += 1) {
    let turn: HarnessProviderTurn;
    try {
      const request = parseHarnessProviderRequest({ messages, tools: options.allowedToolNames, ...(previousResponseId === undefined ? {} : { previousResponseId }) }, options);
      const raw = await provider.turn(request);
      // Before any edit, completion is invalid when an edit is required. After an edit,
      // the mandatory host validation below, not provider prose, decides completion.
      turn = parseHarnessProviderTurn(raw, { ...options, editsRequired: options.editsRequired && !editsOccurred });
    } catch (error) {
      return report("failed", `Provider turn ${iteration} failed validation: ${errorText(error)}`);
    }
    messages.push(turn.toolCalls.length === 0 ? turn.message : { ...turn.message, toolCalls: turn.toolCalls });
    previousResponseId = turn.responseId;
    if (turn.stopReason === "blocked") {
      return report("blocked", `Provider blocked at iteration ${iteration}: ${compact(turn.message.content, 1_000)}`);
    }

    if (turn.stopReason === "tool_calls") {
      const agentResults = new Map<string, HarnessToolResult>();
      for (const call of turn.toolCalls) {
        if (mutationToolNames.has(call.name)) {
          completionEvidence = null; lastSourceBinding = undefined; lastValidationPassed = null;
          config.invalidateCompletionEvidence?.();
        }
        const result = await execute(call, iteration, "agent");
        if (result === null) return report("blocked", `Tool failed during iteration ${iteration}: ${lastToolError}`);
        if (result.isError) return report("blocked", `Tool ${call.name} reported an error: ${compact(result.content, 1_000)}`);
        agentResults.set(call.id, result);
      }
      let noGovernedSchematicEffect = false;
      try {
        // Only a host-internal authoritative-file read can emit this record.
        // Provider text/tool payloads are never parsed as a disposition.
        const disposition = await toolPort.internal?.classifyPendingMutationBatch?.();
        if (disposition !== undefined) {
          mutationBatchDispositions.push(mutationBatchDispositionSchema.parse(disposition));
          noGovernedSchematicEffect = true;
        }
      } catch (error) {
        return report("blocked", `Host mutation-batch fingerprint failed during iteration ${iteration}: ${errorText(error)}`);
      }
      let mutatedThisTurn: boolean;
      try {
        mutatedThisTurn = false;
        for (const call of turn.toolCalls) {
          if (!mutationToolNames.has(call.name)) continue;
          const result = agentResults.get(call.id)!;
          // Validate every compound result, even after an earlier call mutated.
          const mutated = compoundMutationState(call, result, config.compoundMutationContractIdentity, externalPowerBinding, derivedPowerBinding) ?? true;
          mutatedThisTurn = mutatedThisTurn || mutated;
        }
      } catch (error) {
        return report("blocked", `Host compound mutation result failed validation during iteration ${iteration}: ${errorText(error)}`);
      }
      if (mutatedThisTurn && !noGovernedSchematicEffect) {
        const save = await execute({ id: `save-${iteration}`, name: validationTools.save, arguments: {} }, iteration, "save");
        if (save === null) return report("blocked", `Save failed during iteration ${iteration}: ${lastToolError}`);
        if (save.isError) return report("blocked", `Save tool reported an error: ${compact(save.content, 1_000)}`);
        editsOccurred = true;
      }
      const readbackTool = noGovernedSchematicEffect
        ? config.postSchematicReadbackTool ?? "sch_get_connectivity_graph"
        : config.postSchematicReadbackTool;
      const needsSchematicReadback = readbackTool !== undefined && turn.toolCalls.some((call) =>
        ["sch_apply_plan", "sch_add_symbol", "sch_modify_property", "fresh_apply_contract_connectivity", "fresh_apply_recommended_schematic_placement", "fresh_autoplace_schematic_fields", "sch_move_symbol", "lib_assign_footprint"].includes(call.name),
      );
      if (needsSchematicReadback) {
        const readback = await execute({ id: `schematic-readback-${iteration}`, name: readbackTool!, arguments: {} }, iteration, "validation");
        if (readback === null || readback.isError) return report("blocked", `Schematic connectivity readback failed during iteration ${iteration}: ${lastToolError || readback?.content || "unknown error"}`);
      }
      if (noGovernedSchematicEffect) {
        messages.push({ role: "user", content: "Host authoritative schematic-file disposition: requested synchronous schematic calls had no governed effect. No save was attempted; inspect the bounded schematic readback and make a real correction if needed." });
        // A host-confirmed no-effect is never evidence that a prior edit remains
        // acceptable. It is an explicit repair boundary, even if an earlier
        // iteration saved or this turn happens to be a phase boundary.
        if (iteration === iterationLimit) {
          return report("needs_review", "The final bounded iteration had no governed schematic-file effect after mandatory readback; another provider correction is required.");
        }
        continue;
      }
    }

    if (options.editsRequired && !editsOccurred) {
      if (turn.stopReason === "completed") return report("needs_review", "Provider completed without an explicit reviewed mutation tool call.");
      messages.push({ role: "user", content: "No reviewed mutation has occurred. Make an allowed board or schematic edit before requesting completion." });
      continue;
    }

    const reachedPhaseBoundary = turn.stopReason === "completed"
      || iteration === iterationLimit
      || turn.toolCalls.some((call) => call.name === "fresh_autoplace_schematic_fields" || call.name === "pcb_sync_from_schematic" || call.name === "fresh_sync_from_schematic" || call.name === "fresh_replace_route_items" || (mutationToolNames.has(call.name) && call.name.startsWith("pcb_")));
    if (config.deferFullValidationUntilPhaseBoundary && !reachedPhaseBoundary) {
      const lastOperation = operations.at(-1);
      const savedThisIteration = operations.some((operation) => operation.iteration === iteration && operation.phase === "save");
      messages.push({ role: "user", content: savedThisIteration
        ? "Incremental schematic batch was saved and connectivity was read back. Batch the next independent schematic edits, or synchronize to PCB when the schematic phase is ready for full validation."
        : `No schematic mutation was applied, so no save was attempted. Use the compound tool feedback${lastOperation?.phase === "validation" ? " and connectivity readback" : ""} to correct placement, then retry.` });
      continue;
    }
    const validation = await validate(iteration);
    if (validation === null) return report("blocked", `Validation tool failed during iteration ${iteration}: ${lastToolError}`);
    iterations.push({ iteration, stopReason: turn.stopReason, validation });
    if (validation.passed) {
      if (config.completionGate !== undefined) {
        if (completionEvidence === null) return report("blocked", "Completion evidence was not retained from the current validation pass.");
        // Only returned quality evidence may request another turn. A rejected
        // collector/gate retains its fatal or cancellation semantics for owned cleanup.
        const acceptance = await config.completionGate(completionEvidence);
        if (acceptance === null || typeof acceptance !== "object" || typeof acceptance.passed !== "boolean" || !Array.isArray(acceptance.missing) || !acceptance.missing.every((entry) => typeof entry === "string")) throw new Error("Completion gate returned malformed quality evidence.");
        if (!acceptance.passed) {
          const missing = acceptance.missing.length === 0 ? ["Fresh design acceptance contract is unsatisfied."] : acceptance.missing;
          lastValidationPassed = false; unresolvedItems = [...new Set([...unresolvedItems, ...missing])];
          const summary = `${validation.passed ? "Native validation passed." : validation.summary} Required design items remain: ${missing.join(" ")}`;
          if (iteration === iterationLimit || (turn.stopReason === "completed" && config.repairCompletionGateFailures !== true)) return report("needs_review", summary);
          messages.push({ role: "user", content: summary });
          continue;
        }
      }
      if (validation.passed) return report("completed", "Edits, ERC, DRC, board summary, and visual inspection completed without unresolved reported findings.");
    }
    if (turn.stopReason === "completed") {
      return report("needs_review", `Provider stopped, but required validation remains unresolved. ${validation.summary}`);
    }
    messages.push({ role: "user", content: validation.summary });
  }

  return report("needs_review", `Validation remained unresolved after ${iterationLimit} bounded iteration(s).${lastValidationSummary.length === 0 ? "" : ` ${lastValidationSummary}`}`);
}
