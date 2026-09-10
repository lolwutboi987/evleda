import type { CallToolResult } from "@modelcontextprotocol/client";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { PcbReadOnlyLibraryResolver } from "./pcb-design-compiler.js";
import { assertPcbLibrarySourcesCurrent } from "./pcb-library-source-binding.js";

import {
  harnessToolCallSchema,
  harnessToolDefinitionSchema,
  harnessToolResultSchema,
  type HarnessToolCall,
  type HarnessToolDefinition,
  type HarnessToolPort,
  type HarnessInternalToolPort,
  type HarnessMutationBatchDisposition,
  type HarnessToolResult,
} from "./contracts.js";
import { KicadMcpSession, type KicadMcpSessionOptions, type KicadMcpToolDescriptor } from "../integrations/kicad-mcp-session.js";
import { analyzeKicadPcbPractices, type PcbPracticeAnalysisProfile } from "../integrations/pcb-practice-analyzer.js";
import { captureKicadNativeSourceHashes } from "../integrations/kicad-cli.js";
import {
  FRESH_INCREMENTAL_INPUT_SCHEMAS,
  assertFreshProjectDirectoryChain,
  isVerifiedFreshProject,
  isVerifiedPlaneFreshProject,
  parseFreshIncrementalArguments,
  type FreshProject,
} from "./fresh-project.js";
import {
  createFreshConnectivityContract,
  type FreshConnectivityContract,
  type FreshConnectivityContractSource,
  type FreshConnectivityEndpoint,
} from "./fresh-connectivity-contract.js";
import {
  parseFreshEmbeddedPinAngles,
  parseFreshNetlistSource,
  parseFreshPcbSource,
  parseFreshSchematicSource,
  parseFreshSchematicPresentationSource,
  compareFreshSchematicFieldPresentationSources,
  freshGlobalLabelInventoryMatches,
  freshSchematicClassSourcesSupported,
  parseFreshSchematicConnectivityPrimitiveInventory,
  parseFreshPcbRouteSourceSpans,
  parseFreshPcbReferenceGeometry,
  type FreshParsedPcb,
  type FreshPcbSegment,
  type FreshPcbVia,
} from "./fresh-kicad-parser.js";
import { canonicalIdentity, canonicalJson, contentIdentity, sha256 } from "../core/canonical.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import { parsePcbDesignContract, type PcbDesignContract } from "./pcb-design-contract.js";
import { parsePcbPlaneDesignContract, type PcbPlaneDesignContract } from "./pcb-design-plane-contract.js";
import { createPcbPlaneCompilationBundleRef, isAuthenticatedPcbPlaneCompilationBundle, type PcbPlaneCompilationBundle } from "./pcb-design-plane-bundle.js";
import {
  createPcbDesignCompilationBundleRef,
  type PcbDesignCompilationBundle,
} from "./pcb-design-compilation-bundle.js";
import { FreshBoardPersistence, hasQualifiedNativeBoardReply, type FreshBoardSaveAudit } from "./fresh-board-persistence.js";
import { freshBoardComparisonText, freshBoardSerializationsEqual } from "./fresh-board-serialization.js";
import { PCB_SILKSCREEN_TEXT_SCHEMA, parsePcbSilkscreenText, assertOnlyRequestedPcbTextAdded, type PcbSilkscreenText } from "./pcb-silkscreen-text.js";
import { compareFreshNativeNetlists } from "./fresh-native-netlist-comparison.js";
import { FreshSchematicRollback, type FreshSchematicPreimage } from "./fresh-schematic-rollback.js";
import { exactFreshSchematicGeometryMatches, expectedFreshSchematicGeometryPrefixes } from "./fresh-schematic-writer-geometry.js";
import { approximateFreshGlobalLabelBounds, freshGlobalLabelOrientation, type FreshPlannedGlobalLabel } from "./fresh-schematic-label-layout.js";
import { buildFreshSchematicSourceTerminalGroups, type FreshSchematicApprovedGeometryResolver } from "./fresh-schematic-source-adapter.js";
import { validatePristineTerminalPartition, type FreshSchematicTerminalInput, type FreshSchematicTerminalPartition } from "./fresh-schematic-terminal-groups.js";
import { FreshSchematicWorkBudget, type FreshSchematicWorkKind } from "./fresh-schematic-work-budget.js";
import { prepareFreshSchematicConnectivityBatch, validateFreshSchematicConnectivityBatchReceipt } from "./fresh-schematic-connectivity-batch.js";
import type { FreshSchematicStrokeStyleEvidence } from "./fresh-schematic-stroke-style.js";
import { collectKicadNativePadObservation, bindKicadPhysicalFootprintLibraries, type KicadNativePadObservation, type KicadNativePadObservationExpected } from "../integrations/kicad-native-pad-observation.js";
import { buildFreshPhysicalRouteTopology } from "./fresh-design-acceptance.js";
import { assertPlaneIncrementalRouteGeometry, assertPlaneRouteSourcePreservation, FRESH_PLANE_ROUTE_MUTATION_SCHEMA_VERSION, FRESH_PLANE_ROUTE_SELECTION_SCHEMA_VERSION, PLANE_ROUTE_MUTATION_INPUT_SCHEMA, PLANE_ROUTE_MUTATION_SCOPE, PLANE_ROUTE_NOT_EVALUATED, parsePlaneRouteMutationArguments } from "./fresh-plane-route-mutation.js";
import type { KicadPlaneStageInput, KicadPlaneStageReceipt } from "../integrations/kicad-plane-stage.js";
import { prepareFreshPlaneMutation, compareFreshPlaneMutation, type PreparedFreshPlaneMutation } from "./fresh-plane-mutation.js";
import { createFreshPlaneRules } from "./fresh-plane-rules.js";
import { validateFreshPlaneStageObservation, isValidatedFreshPlaneStageObservation } from "./fresh-plane-stage-observation.js";
import { prepareFreshPlaneConnectivity, assessFreshPlaneConnectivity, type FreshPlaneConnectivityAssessment } from "./fresh-plane-connectivity.js";
import { createSavedFreshPlaneEvidence, assertSavedFreshPlaneEvidenceCurrent, type SavedFreshPlaneEvidence } from "./fresh-plane-evidence.js";
import type { FreshPlaneAcceptanceAssessment, FreshPlaneAcceptanceInput } from "./fresh-plane-acceptance.js";
import { assessSavedInterface, type SavedInterfaceAssessment } from "./saved-interface-assessment.js";
import type { KicadTransmissionLineCalculator } from "../integrations/kicad-transmission-line.js";
import { routeMmToNativeNm, routeNativeNmToMm, routeNativeNmToKipyMm, routeSourceMmToNativeNm, validatedNativePadPositionMm } from "./fresh-route-native-units.js";

/** The deliberately small, reviewed surface exposed to a layout harness. */
export const KICAD_HARNESS_TOOL_NAMES = Object.freeze([
  "kicad_set_project",
  "sch_plan_from_spec",
  "sch_apply_plan",
  "sch_verify_plan",
  "run_erc",
  "run_drc",
  "pcb_get_board_summary",
  "pcb_get_design_rules",
  "pcb_visual_qa",
  "pcb_get_tracks",
  "pcb_get_vias",
  "pcb_get_zones",
  "pcb_get_footprints",
  "pcb_set_board_outline",
  "pcb_add_track",
  "pcb_add_via",
  "pcb_place_component",
  "pcb_move_component",
  "pcb_move_footprint",
  "pcb_sync_from_schematic",
  "pcb_add_zone",
  "pcb_save",
] as const);
/** Fresh projects get incremental schematic authoring only; no whole-sheet replacement. */
export const KICAD_FRESH_HARNESS_TOOL_NAMES = Object.freeze([
  "pcb_add_text",
  ...KICAD_HARNESS_TOOL_NAMES.filter((name) => !name.startsWith("sch_") && name !== "pcb_sync_from_schematic"),
  "sch_get_symbols",
  "sch_get_connectivity_graph",
  "sch_get_bounding_boxes",
  "sch_get_pin_positions",
  "lib_verify_component_contract",
  "sch_add_symbol",
  "sch_modify_property",
  "lib_assign_footprint",
  "fresh_apply_contract_connectivity",
  "fresh_apply_recommended_schematic_placement",
  "fresh_autoplace_schematic_fields",
  "fresh_get_contract_pad_positions",
  "fresh_get_route_items",
  "fresh_replace_route_items",
  "fresh_sync_from_schematic",
  "fresh_apply_contract_plane",
  "sch_move_symbol",
] as const);
/** Sidecar capabilities needed behind the fresh host compound tool. */
export const KICAD_FRESH_SIDECAR_REQUIRED_TOOL_NAMES = Object.freeze([
  ...KICAD_FRESH_HARNESS_TOOL_NAMES.filter((name) => !name.startsWith("fresh_") && name !== "pcb_add_text"),
  "sch_add_wire",
  "sch_add_label",
  "sch_add_no_connect",
  "sch_add_missing_junctions",
  "pcb_sync_from_schematic",
  // Host-only durable recovery reads. They are intentionally never projected
  // into provider definitions, but a fresh sidecar must advertise both.
  "kicad_get_project_info",
  "pcb_get_board_as_string",
  // Private native document/source authority, also required by legacy fresh recovery.
  "evleda_get_live_pcb_document",
] as const);
/** Additional private sidecar capabilities required only by generic fresh board compounds. */
export const KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES = Object.freeze([
  ...KICAD_FRESH_SIDECAR_REQUIRED_TOOL_NAMES,
  // Only the batch API can select passive global labels. Keep it host-only.
  "sch_add_labels",
  "sch_autoplace_fields",
  "pcb_begin_commit",
  "pcb_delete_items",
  "pcb_push_commit",
  "pcb_drop_commit",
  "pcb_revert",
  "evleda_get_live_pcb_pad_snapshot",
] as const);
/** Plane authoring is deliberately not a V1 complete-trace-tree mutation surface. */
const PLANE_UNAVAILABLE_TOOL_NAMES = new Set<string>(["pcb_add_track", "pcb_add_via", "pcb_add_zone", "pcb_add_text"]);
export const KICAD_PLANE_FRESH_SIDECAR_REQUIRED_TOOL_NAMES = Object.freeze(KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES.filter(name=>name!=="pcb_add_zone"));
export type KicadHarnessToolName = (typeof KICAD_FRESH_HARNESS_TOOL_NAMES)[number];

const MAX_ARGUMENT_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 32_000;
/** Sidecar bbox text rounds to 0.01 mm; use twice that per opposing edge. */
const BOUNDING_BOX_ROUNDING_MARGIN_MM = 0.02;
const MAX_CONFIDENT_SCHEMATIC_BOUNDING_BOX_MM = 50;
const supportedToolNames = new Set<string>(KICAD_FRESH_HARNESS_TOOL_NAMES);
const FRESH_HOST_TOOL_NAMES = new Set([
  "fresh_apply_contract_connectivity", "fresh_apply_recommended_schematic_placement",
  "fresh_autoplace_schematic_fields",
  "fresh_get_contract_pad_positions", "fresh_get_route_items", "fresh_replace_route_items", "fresh_sync_from_schematic",
  "fresh_apply_contract_plane",
]);
const HOST_INTERNAL_TOOL_NAMES = new Set(["kicad_set_project", "run_erc", "run_drc", "pcb_get_board_summary", "pcb_visual_qa", "pcb_save"]);
/** Only these host-reviewed operations can change the live board string. */
const PCB_MUTATION_TOOL_NAMES = new Set([
  "pcb_add_text",
  "pcb_set_board_outline", "pcb_add_track", "pcb_add_via", "pcb_place_component", "pcb_move_component", "pcb_move_footprint", "pcb_sync_from_schematic", "pcb_add_zone",
]);
const PROVIDER_MUTATION_TOOL_NAMES = new Set([
  "sch_apply_plan", "sch_add_symbol", "sch_modify_property", "lib_assign_footprint", "fresh_apply_contract_connectivity", "fresh_apply_recommended_schematic_placement", "fresh_autoplace_schematic_fields", "fresh_replace_route_items", "fresh_sync_from_schematic", "fresh_apply_contract_plane", "sch_move_symbol",
  ...PCB_MUTATION_TOOL_NAMES,
]);

/** Reuse the harness's reviewed public surface and mutation classification. */
export function kicadHarnessToolEffect(name: string): "read" | "mutation" | undefined {
  if (!supportedToolNames.has(name) || HOST_INTERNAL_TOOL_NAMES.has(name)) return undefined;
  return PROVIDER_MUTATION_TOOL_NAMES.has(name) ? "mutation" : "read";
}
/** Locked sidecar synchronous calls that can only govern the authoritative schematic file. */
const SYNCHRONOUS_SCHEMATIC_FILE_MUTATION_TOOL_NAMES = new Set([
  "sch_apply_plan", "sch_add_symbol", "sch_modify_property", "lib_assign_footprint", "fresh_apply_recommended_schematic_placement", "fresh_autoplace_schematic_fields", "sch_move_symbol",
]);
const READ_TO_WRITE_LAYER = new Map<string, string>([
  ["BL_F_Cu", "F_Cu"], ["BL_B_Cu", "B_Cu"],
  ...Array.from({ length: 4 }, (_, index) => [`BL_In${index + 1}_Cu`, `In${index + 1}_Cu`] as const),
]);
const WRITE_COPPER_LAYER_ALIASES = new Map<string, string>([
  ["F.Cu", "F_Cu"], ["B.Cu", "B_Cu"],
  ...Array.from({ length: 4 }, (_, index) => [`In${index + 1}.Cu`, `In${index + 1}_Cu`] as const),
]);

function normalizeLayer(value: string): string {
  const writeAlias = WRITE_COPPER_LAYER_ALIASES.get(value);
  if (writeAlias !== undefined) return writeAlias;
  if (!value.startsWith("BL_")) return value;
  const mapped = READ_TO_WRITE_LAYER.get(value);
  if (mapped === undefined) throw new Error(`Unsupported read-side KiCad layer enum: ${value}`);
  return mapped;
}

function normalizeReadLayers(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/BL_[A-Za-z0-9_]+/gu, (layer) => normalizeLayer(layer));
  if (Array.isArray(value)) return value.map(normalizeReadLayers);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, normalizeReadLayers(entry)]));
  return value;
}

export interface KicadHarnessSession {
  listTools(): readonly KicadMcpToolDescriptor[];
  callTool(name: string, argumentsValue?: Readonly<Record<string, unknown>>): Promise<CallToolResult>;
  assertActivePcb?(expectedPath: string): Promise<void>;
  readActivePcbSource?(expectedPath: string): Promise<string>;
  readLivePcbPadSnapshot?(requestedPrimitiveIds: readonly string[]): Promise<CallToolResult>;
  supportsSchematicConnectivityBatch?(): boolean;
  applySchematicConnectivityBatch?(argumentsValue: Readonly<Record<string, unknown>>): Promise<CallToolResult>;
  supportsPlaneStage?(): boolean;
  stagePlane?(argumentsValue: KicadPlaneStageInput): Promise<KicadPlaneStageReceipt>;
  supportsNativeRouteTransactions?():boolean;
  supportsQualifiedFootprintIdentitySync?():boolean;
  finishNativeRouteTransaction?():void;
  quarantineNativeRouteTransaction?(cause?:unknown):void;
}

export interface FreshRouteMutationDiagnostic {
  readonly schemaVersion:"evleda.fresh-route-mutation-diagnostic.v1";
  readonly phase:"primary-failure"|"recovery-finished";
  readonly toolCallId:string;readonly net:string;readonly firstOperation:string;
  readonly primary:readonly Readonly<{name:string;message:string;detail?:Readonly<{jsonPrefix:string;truncated:boolean;contentIdentity:ContentIdentity}>}>[];
  readonly beforePcbContentIdentity:ContentIdentity;
  readonly transactionStarted:boolean;readonly transactionPushed:boolean;
  readonly cleanup:readonly Readonly<{operation:string;status:string;message:string}>[];
  readonly recovery:string;readonly identity:CanonicalIdentity;
}

export interface KicadHarnessTools extends HarnessToolPort<KicadHarnessToolName> {
  readonly tools: readonly HarnessToolDefinition[];
  readonly internal: HarnessInternalToolPort;
  /** Host-only evidence, included in the CLI report but never provider tool output. */
  readonly freshBoardSaveAudits: readonly FreshBoardSaveAudit[];
  readonly freshRouteMutationDiagnostics?:readonly FreshRouteMutationDiagnostic[];
  captureFreshPcbPadEvidence(): Promise<Readonly<{ observation: KicadNativePadObservation; expected: KicadNativePadObservationExpected }> | undefined>;
  /** Host-only, current saved V2 endpoint reachability. Never an electrical acceptance verdict. */
  assessPlaneConnectivity?(): Promise<FreshPlaneConnectivityAssessment>;
  /** Serialized host-only V2 plane facts; model input cannot supply evidence or selectors. */
  assessPlaneAcceptance?(calculator?: KicadTransmissionLineCalculator): Promise<FreshPlaneAcceptanceAssessment>;
  /** Bound interface requirements and exact current saved source; host calculator only. */
  assessInterface?(interfaceId: string, calculator?: KicadTransmissionLineCalculator): Promise<SavedInterfaceAssessment>;
  runFinalValidation(): Promise<Readonly<Record<"erc" | "drc" | "boardSummary" | "visualQa", unknown>>>;
}

/** Detached diagnostics only; these values confer no project or mutation authority. */
export interface FreshSyncBoardComparisonDiagnostic {
  readonly diskSource: string;
  readonly diskContentIdentity: ContentIdentity;
  readonly liveSource: string;
  readonly liveContentIdentity: ContentIdentity;
}

export interface KicadHarnessToolsOptions {
  readonly assessFreshPlaneEvidence?: (input: Pick<FreshPlaneAcceptanceInput,
    "compilationBundle" | "pcbSource" | "projectSettingsSource" | "rulesSource" | "savedEvidence" | "endpointConnectivity" | "transmissionLine">
    & { readonly pcbPath: string; readonly projectBindingIdentity: CanonicalIdentity; readonly sourceScopeIdentity: CanonicalIdentity }) => Promise<FreshPlaneAcceptanceAssessment>;
  /** Host-private bounded provenance; callback failures never mask the first native fault. */
  readonly observeFreshRouteMutationDiagnostic?:(diagnostic:FreshRouteMutationDiagnostic)=>void|Promise<void>;
  /** Deterministic host fallback, normally backed by a source-preserving KiCad CLI check. */
  readonly fallback?: HarnessInternalToolPort;
  /** Required only when the sidecar has no explicit save tool but its edit tools persist directly. */
  readonly verifyPersistedMutation?: (baseline?: string) => Promise<boolean>;
  /** Per-unsaved-batch fingerprint; prevents prior run changes masking a later no-op. */
  readonly capturePersistedMutationBaseline?: () => Promise<string>;
  /** Set only from a hash-verified `--new-project` preparation. */
  readonly freshProject?: FreshProject;
  /** Closed host task contract; never reconstructed from provider tool arguments. */
  readonly freshConnectivityContract?: FreshConnectivityContractSource;
  /** Authenticated whole-bundle authority required by generic fresh compounds. */
  readonly freshCompilationBundle?: PcbDesignCompilationBundle;
  /** Genuine authenticated V2 bundle, never a V1 contract/practice-profile projection. */
  readonly freshPlaneCompilationBundle?: PcbPlaneCompilationBundle;
  /** Original host resolver, including its optional persisted source-selection capability. */
  readonly freshLibraryResolver?: PcbReadOnlyLibraryResolver;
  /** Host-only native `kicad-cli sch export netlist` capture, invoked only after verified save. */
  readonly captureFreshNativeNetlist?: () => Promise<string>;
  /** Host-only synchronous exact-pair diagnostics before comparison/rollback. Return values and errors are ignored. */
  readonly observeFreshSyncBoardComparison?: (diagnostic: FreshSyncBoardComparisonDiagnostic) => void;
  /** Already approved exact stock resolver; never supplied by provider arguments. */
  readonly freshSchematicGeometryResolver?: FreshSchematicApprovedGeometryResolver;
  /** Trusted current-source native renderer supplier; never numeric/model stroke metadata. */
  readonly captureFreshSchematicStrokeStyle?: (schematicIdentity: ContentIdentity) => Promise<FreshSchematicStrokeStyleEvidence>;
  /** Host policy may tighten, never exceed, the shared deterministic work ceiling. */
  readonly freshSchematicWorkLimit?: number;
  /** Same approved stock resolver and fixed source pins used by the host; never provider metadata. */
  readonly freshPhysicalFootprintResolver?: KicadNativePadObservationExpected["physicalFootprintResolver"];
  readonly freshPhysicalFootprintSourcePins?: KicadNativePadObservationExpected["physicalFootprints"];
}

function detachedJson(value: unknown, label: string, maxBytes: number): unknown {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new Error(`${label} must be JSON serializable.`, { cause: error });
  }
  if (serialized === undefined) throw new Error(`${label} must be JSON serializable.`);
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte limit.`);
  }
  return JSON.parse(serialized) as unknown;
}

function inputSchemaFor(tool: KicadMcpToolDescriptor): Record<string, unknown> {
  const schema = detachedJson(tool.inputSchema, `Input schema for '${tool.name}'`, MAX_ARGUMENT_BYTES);
  if (schema === null || Array.isArray(schema) || typeof schema !== "object") {
    throw new Error(`Input schema for '${tool.name}' must be a JSON object.`);
  }
  return schema as Record<string, unknown>;
}

/** Keep provider-facing metadata inside the bounded harness contract. */
function providerToolDescription(tool: KicadMcpToolDescriptor): string {
  const description = tool.description?.replace(/\s+/gu, " ").trim();
  if (!description) return `Reviewed KiCad operation: ${tool.name}.`;
  const scalars = Array.from(description);
  return scalars.length <= 2_000 ? description : `${scalars.slice(0, 1_999).join("")}…`;
}

function normalizeValidationPayload(value: unknown): unknown {
  if (typeof value === "string") {
    try { return normalizeValidationPayload(JSON.parse(value) as unknown); } catch { return value; }
  }
  if (value === null || Array.isArray(value) || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const rawNested = record.result;
  const nested = typeof rawNested === "string"
    ? (() => { try { return JSON.parse(rawNested) as unknown; } catch { return rawNested; } })()
    : rawNested;
  const base = nested !== null && !Array.isArray(nested) && typeof nested === "object"
    ? { ...(nested as Record<string, unknown>), ...record }
    : record;
  if (typeof base.verdict === "string" && base.status === undefined && base.passed === undefined) {
    const verdict = base.verdict.toLowerCase();
    return { ...base, status: ["pass", "passed", "clean", "ok"].includes(verdict) ? "clean" : "failed" };
  }
  return base;
}

function unavailableValidationResult(value: unknown): boolean {
  const normalized = normalizeValidationPayload(value);
  if (normalized === null || Array.isArray(normalized) || typeof normalized !== "object") return false;
  const record = normalized as Record<string, unknown>;
  const failureMode = typeof record.failure_mode === "string" ? record.failure_mode.toLowerCase() : "";
  if (failureMode !== "environment" && failureMode !== "configuration") return false;
  const metadata = record.metadata;
  const unavailableMetadata = metadata !== null && typeof metadata === "object" && (metadata as Record<string, unknown>).available === false;
  const unavailableStatus = typeof record.report_status === "string" && record.report_status.toLowerCase() === "unavailable";
  const boundedText = JSON.stringify(record).slice(0, 4_000).toLowerCase();
  const unavailableText = /(?:connection|ipc|server).{0,80}(?:refused|unavailable)|(?:refused|unavailable).{0,80}(?:connection|ipc|server)|no report/u.test(boundedText);
  return unavailableMetadata || unavailableStatus || unavailableText;
}

function resultContent(result: CallToolResult, normalize = false, normalizeLayers = false): string {
  const preferred = result.structuredContent ?? result.content;
  const payload = normalize ? normalizeValidationPayload(preferred) : preferred;
  const detached = detachedJson(normalizeLayers ? normalizeReadLayers(payload) : payload, "KiCad MCP result", MAX_RESULT_BYTES);
  const content = JSON.stringify(detached);
  if (content.length === 0) throw new Error("KiCad MCP returned an empty result.");
  return content;
}

export interface FreshPoint { readonly x: number; readonly y: number }
export interface FreshPlacement extends FreshPoint {
  readonly reference: string;
  readonly value?: string;
  readonly library: string;
  readonly symbol: string;
  readonly rotation: number;
  readonly unit: number;
  readonly footprint?: string;
}
export interface FreshConnectivityGroup {
  readonly name: string;
  readonly endpoints: readonly string[];
}
export interface FreshBoundingBox {
  readonly reference: string;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}
export interface FreshConnectivityIssue {
  readonly code: string;
  readonly message: string;
  readonly remediation: string;
  readonly endpoints?: readonly string[];
  readonly atMm?: FreshPoint;
}
export interface FreshConnectivitySearchEvidence {
  readonly schemaVersion: "evleda.fresh-connectivity-placement-search.v1";
  readonly status: "found" | "exhausted" | "unsupported";
  readonly gridMm: 2.54;
  readonly slotPitchMm: 25.4;
  readonly rotationPolicy: "current-only";
  readonly workingBoundsMm: Readonly<{ readonly minX: 15.24; readonly minY: 15.24; readonly maxX: 279.4; readonly maxY: 195.58 }>;
  readonly limits: Readonly<{
    readonly maxComponents: 8; readonly maxEndpoints: 64; readonly maxCandidatesPerComponent: 64;
    readonly maxTotalCandidates: 512; readonly maxConfigurations: 2048; readonly maxStates: 100000;
    readonly maxPlanEvaluations: 2048; readonly maxSegmentChecks: 20000000;
  }>;
  readonly configurationsEvaluated: number;
  readonly statesVisited: number;
  readonly planEvaluations: number;
  readonly segmentChecks: number;
  readonly candidateCount: number;
  readonly exhaustionReason: FreshPlacementSearchExhaustionReason;
  readonly blockingEdgeEvidence: FreshIssueEvidence;
}
export interface FreshIssueEvidence {
  readonly total: number;
  readonly returned: number;
  readonly truncated: boolean;
}
export interface FreshContractConnectivityResultFields {
  readonly applied: boolean;
  readonly mutated: boolean;
  readonly idempotent: boolean;
  readonly rolledBack?: boolean;
  readonly issues: readonly FreshConnectivityIssue[];
  readonly routes?: readonly string[];
  readonly noConnects?: readonly string[];
  readonly connectivity?: readonly FreshConnectivityGroup[];
  readonly nativeNetlistSha256?: string;
  readonly nativeNetCount?: number;
  readonly nativeComponentCount?: number;
  readonly recommendedMoves?: readonly FreshConnectivityRecommendedMove[];
  readonly recommendationIdentity?: ReturnType<typeof canonicalIdentity>;
  readonly startingPlacementIdentity?: ReturnType<typeof canonicalIdentity>;
  readonly startingSchematicSha256?: string;
  readonly targetPlacementIdentity?: ReturnType<typeof canonicalIdentity>;
  readonly targetPlacements?: readonly FreshConnectivityRecommendedMove[];
  readonly recommendationInstruction?: string;
  readonly searchEvidence?: FreshConnectivitySearchEvidence;
  readonly issueEvidence?: FreshIssueEvidence;
  readonly blockingEdgeEvidence?: FreshIssueEvidence;
  readonly blockingEdges?: readonly { readonly net: string; readonly endpoints: readonly [string, string] }[];
}

export const FRESH_CONTRACT_PAD_POSITIONS_SCHEMA_VERSION = "evleda.fresh-contract-pad-positions.v1" as const;
export const FRESH_ROUTE_SELECTION_SCHEMA_VERSION = "evleda.fresh-route-selection.v1" as const;
export const FRESH_ROUTE_REPLACEMENT_RESULT_SCHEMA_VERSION = "evleda.fresh-route-replacement-result.v1" as const;
export const FRESH_SYNC_FROM_SCHEMATIC_RESULT_SCHEMA_VERSION = "evleda.fresh-sync-from-schematic-result.v1" as const;
export const FRESH_PHYSICAL_SYNC_FROM_SCHEMATIC_RESULT_SCHEMA_VERSION = "evleda.fresh-sync-from-schematic-result.v2" as const;
export const FRESH_PHYSICAL_PAD_POSITIONS_SCHEMA_VERSION = "evleda.fresh-contract-pad-positions.v2" as const;
export const FRESH_PLANE_SYNC_SCHEMA_VERSION = "evleda.fresh-plane-sync-from-schematic-result.v1" as const;
export const FRESH_PLANE_PAD_POSITIONS_SCHEMA_VERSION = "evleda.fresh-plane-pad-positions.v1" as const;
export const FRESH_PLANE_APPLY_RESULT_SCHEMA_VERSION = "evleda.fresh-plane-apply-result.v1" as const;
export const FRESH_PLANE_APPLY_FAILURE_SCHEMA_VERSION = "evleda.fresh-plane-apply-failure.v1" as const;
export const FRESH_PLANE_APPLY_INPUT_SCHEMA = Object.freeze({type:"object",additionalProperties:false,
  properties:{planeId:{type:"string",minLength:1,maxLength:64}},required:[]});

function parseFreshPlaneApplyArguments(value:Readonly<Record<string,unknown>>):Readonly<{planeId?:string}>{
  if(Object.keys(value).some(key=>key!=="planeId")||value.planeId!==undefined&&(typeof value.planeId!=="string"||value.planeId.length<1||value.planeId.length>64))throw new Error("Plane apply accepts only an optional exact contract planeId; model geometry and settings are not accepted.");
  return value.planeId===undefined?Object.freeze({}):Object.freeze({planeId:value.planeId as string});
}

const MAX_FRESH_PCB_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_FRESH_PAD_POSITIONS = 192;
const MAX_FRESH_ROUTE_SELECTION_ITEMS = 96;
const KICAD_SELECTION_ID = /^(?:[0-9a-f]{8,64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu;

interface FreshPcbCapture {
  readonly source: string;
  readonly contentIdentity: ContentIdentity;
  readonly projectBindingIdentity: CanonicalIdentity;
  readonly freshMarkerContentIdentity: ContentIdentity;
  readonly parsed: FreshParsedPcb;
}

/** New synchronization must preserve native library nicknames. Historical
 * uniquely bound bare IDs remain readable by the separate inspection path.
 */
function assertFullSyncedFootprintIds(contract:FreshConnectivityContract,board:FreshParsedPcb):void{
  if(board.footprints.length!==contract.components.length||contract.components.some(component=>{
    const matches=board.footprints.filter(fp=>fp.reference===component.reference);
    return matches.length!==1||matches[0]!.libraryId!==component.footprintLibId;
  }))throw new Error("Synced PCB footprint library IDs do not exactly match the complete qualified schematic assignments.");
}

export interface FreshContractPadPosition {
  readonly reference: string;
  readonly pad: string;
  readonly net: string | null;
  readonly xMm: number;
  readonly yMm: number;
  readonly layers: readonly string[];
  readonly physical?: Readonly<{ id: string; footprintId: string; padType: string; shape: string; sizeMm: Readonly<{x:number;y:number}>; drill: Readonly<{shape:"circle"|"oval";sizeMm:Readonly<{x:number;y:number}>;offsetMm:Readonly<{x:number;y:number}>|null}> | null }>;
}

export interface FreshPhysicalPadCounts {
  readonly physicalPadCount: number;
  readonly logicalTerminalCount: number;
  readonly numberedCopperPrimitiveCount: number;
  readonly namedCopperPrimitiveCount: number;
  readonly noConnectCopperPrimitiveCount: number;
  readonly logicalNamedTerminalCount: number;
  readonly logicalNoConnectTerminalCount: number;
  readonly nonElectricalFeatureCount: number;
  readonly platedFootprintHoleCount: number;
}

function physicalPadCounts(contract: FreshConnectivityContract, board: FreshParsedPcb): FreshPhysicalPadCounts {
  const pads=board.footprints.flatMap(fp=>fp.pads);
  const numbered=pads.filter(p=>p.number.length>0);
  return Object.freeze({physicalPadCount:pads.length,logicalTerminalCount:expectedPadNets(contract).size,
    numberedCopperPrimitiveCount:numbered.length,namedCopperPrimitiveCount:numbered.filter(p=>p.netName!==null).length,
    noConnectCopperPrimitiveCount:numbered.filter(p=>p.netName===null).length,logicalNamedTerminalCount:contract.nets.reduce((sum,net)=>sum+net.endpoints.length,0),logicalNoConnectTerminalCount:contract.noConnects.length,
    nonElectricalFeatureCount:pads.filter(p=>p.number.length===0).length,platedFootprintHoleCount:pads.filter(p=>p.physical.padType==="thru_hole"&&p.physical.drill!==null).length});
}

interface FreshUpstreamPadMetrics {
  readonly totalPadsConsidered:number; readonly namedPads:number; readonly noNetPads:number;
  readonly transferQuality:"CLEAN"|"DEGRADED"|"POOR"|"UNKNOWN"; readonly namedPadCoveragePercent:number;
  readonly fullyNamedReferences:number; readonly partiallyNamedReferences:number;
  readonly unresolvedPadReferences:string; readonly additionalUnresolvedReferences:number; readonly literalLines:readonly string[];
}
function exactUpstreamPadMetrics(lines:readonly string[],contract:FreshConnectivityContract,board:FreshParsedPcb,counts:FreshPhysicalPadCounts):FreshUpstreamPadMetrics {
  const literalLines:string[]=[];
  const exact=(prefix:string):string=>{
    const matches=lines.filter(line=>line.startsWith(prefix));
    if(matches.length!==1)throw new Error(`Fresh sync requires one exact upstream ${prefix} metric.`);
    literalLines.push(matches[0]!);return matches[0]!.slice(prefix.length);
  };
  const integer=(prefix:string):number=>{const value=exact(prefix);if(!/^(?:0|[1-9][0-9]*)$/u.test(value)||!Number.isSafeInteger(Number(value)))throw new Error("Fresh sync has malformed upstream integer metrics.");return Number(value);};
  if(integer("Schematic components considered: ")!==contract.components.length)throw new Error("Fresh sync upstream component count differs from contract.");
  const totalPadsConsidered=integer("Total pads considered: "),namedPads=integer("Pads with named nets: "),noNetPads=integer("Pads left as <no net>: ");
  const quality=/^(CLEAN|DEGRADED|POOR|UNKNOWN) \(([0-9]+(?:\.[0-9]+)?)% pad coverage\)$/u.exec(exact("Transfer quality: "));
  if(quality===null)throw new Error("Fresh sync upstream quality text is malformed.");
  const transferQuality=quality[1] as FreshUpstreamPadMetrics["transferQuality"],namedPadCoveragePercent=Number(quality[2]);
  const expectedQuality=totalPadsConsidered===0?"UNKNOWN":namedPads===totalPadsConsidered?"CLEAN":namedPadCoveragePercent>=50?"DEGRADED":"POOR";
  if(totalPadsConsidered!==counts.numberedCopperPrimitiveCount||namedPads!==counts.namedCopperPrimitiveCount||noNetPads!==counts.noConnectCopperPrimitiveCount
    ||Math.abs(namedPadCoveragePercent-(totalPadsConsidered===0?100:100*namedPads/totalPadsConsidered))>0.051||transferQuality!==expectedQuality)throw new Error("Fresh sync literal upstream physical-pad metrics contradict complete source/native disposition evidence.");
  const fullyNamedReferences=integer("Fully net-mapped refs: "),partiallyNamedReferences=integer("Partially net-mapped refs: ");
  const unresolved=board.footprints.flatMap(fp=>{
    const numbered=fp.pads.filter(pad=>pad.number.length>0),missing=numbered.filter(pad=>pad.netName===null).length;
    return missing===0?[]:[`${fp.reference} (${missing}/${numbered.length} pad(s) without net names)`];
  });
  if(partiallyNamedReferences!==unresolved.length||fullyNamedReferences!==contract.components.length-unresolved.length)throw new Error("Fresh sync upstream reference metrics contradict declared NC dispositions.");
  const unresolvedPadReferences=exact("Refs with unresolved pad nets: ");
  const listed=unresolvedPadReferences==="(none)"?[]:unresolvedPadReferences.split(", ");
  const metricIndex=lines.findIndex(line=>line===`Refs with unresolved pad nets: ${unresolvedPadReferences}`);
  const more=/^\.\.\. and ([1-9][0-9]*) more$/u.exec(lines[metricIndex+1]??"");
  const additionalUnresolvedReferences=unresolved.length>12?Number(more?.[1]??NaN):0;
  if(listed.length!==Math.min(unresolved.length,12)||new Set(listed).size!==listed.length||listed.some(ref=>!unresolved.includes(ref))||additionalUnresolvedReferences!==Math.max(0,unresolved.length-12))throw new Error("Fresh sync unresolved-reference text does not reproduce the literal physical no-net inventory.");
  if(additionalUnresolvedReferences>0)literalLines.push(lines[metricIndex+1]!);
  return freezeDeep({totalPadsConsidered,namedPads,noNetPads,transferQuality,namedPadCoveragePercent,fullyNamedReferences,partiallyNamedReferences,unresolvedPadReferences,additionalUnresolvedReferences,literalLines});
}

export interface FreshContractPadPositions {
  readonly schemaVersion: typeof FRESH_CONTRACT_PAD_POSITIONS_SCHEMA_VERSION;
  readonly contractIdentity: CanonicalIdentity;
  readonly genericProjectBindingIdentity: CanonicalIdentity;
  readonly freshMarkerContentIdentity: ContentIdentity;
  readonly pcbContentIdentity: ContentIdentity;
  readonly footprintLibraryTableIdentity: ContentIdentity;
  readonly pads: readonly FreshContractPadPosition[];
  readonly identity: CanonicalIdentity;
}

export type FreshRouteSelectionItem =
  | Readonly<{
      readonly kind: "track";
      readonly id: string;
      readonly net: string;
      readonly start: Readonly<{ readonly xMm: number; readonly yMm: number }>;
      readonly end: Readonly<{ readonly xMm: number; readonly yMm: number }>;
      readonly widthMm: number;
      readonly layer: string;
    }>
  | Readonly<{
      readonly kind: "via";
      readonly id: string;
      readonly net: string;
      readonly at: Readonly<{ readonly xMm: number; readonly yMm: number }>;
      readonly diameterMm: number;
      readonly drillMm: number;
      readonly layers: readonly string[];
    }>;

export interface FreshRouteSelection {
  readonly schemaVersion: typeof FRESH_ROUTE_SELECTION_SCHEMA_VERSION;
  readonly contractIdentity: CanonicalIdentity;
  readonly genericProjectBindingIdentity: CanonicalIdentity;
  readonly freshMarkerContentIdentity: ContentIdentity;
  readonly pcbContentIdentity: ContentIdentity;
  readonly items: readonly FreshRouteSelectionItem[];
  readonly identity: CanonicalIdentity;
}
export interface FreshPlaneRouteSelection extends Omit<FreshRouteSelection, "schemaVersion" | "genericProjectBindingIdentity"> {
  readonly schemaVersion: typeof FRESH_PLANE_ROUTE_SELECTION_SCHEMA_VERSION;
  readonly planeProjectBindingIdentity: CanonicalIdentity;
  readonly sourceContractIdentity: CanonicalIdentity;
  readonly completion: "not_evaluated";
  readonly connection: "not_evaluated";
  readonly notEvaluated: typeof PLANE_ROUTE_NOT_EVALUATED;
}
type AuthoringRouteSelection = FreshRouteSelection | FreshPlaneRouteSelection;
interface PendingFreshPlaneApply {
  readonly kind:"plane";
  readonly before:FreshPcbCapture;
  readonly prepared:PreparedFreshPlaneMutation;
  readonly observation:ReturnType<typeof validateFreshPlaneStageObservation>;
  readonly projectSettingsIdentity:ContentIdentity;
  readonly rulesIdentity:ContentIdentity;
  readonly sourceScopeIdentity:CanonicalIdentity;
}

const freezeDeep = <Value>(value: Value): Value => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
};

const sameContentIdentity = (left: ContentIdentity, right: ContentIdentity): boolean =>
  left.algorithm === "sha256" && right.algorithm === "sha256"
  && left.size === right.size && left.digest === right.digest;

function assertGenericCompilationBinding(
  project: FreshProject,
  connectivity: FreshConnectivityContract | undefined,
  design: PcbDesignContract | undefined,
  bundle: PcbDesignCompilationBundle | undefined,
): asserts bundle is PcbDesignCompilationBundle {
  if (project.workflowKind !== "generic" || project.genericBinding === undefined
      || connectivity === undefined || design === undefined || bundle === undefined) {
    throw new Error("Generic fresh compounds require an authenticated project, full compilation bundle, and exact design/connectivity contracts.");
  }
  // This call accepts only a bundle minted by the strict create/parse boundary;
  // a shape-compatible or coherently rehashed object is not sufficient.
  const bundleRef = createPcbDesignCompilationBundleRef(bundle);
  const binding = project.genericBinding;
  const pairs: readonly (readonly [unknown, unknown, string])[] = [
    [bundleRef, binding.bundleRef, "bundle reference"],
    [design, bundle.contract, "design contract"],
    [design.identity, binding.contractIdentity, "contract identity"],
    [connectivity.sourceContractIdentity, binding.contractIdentity, "connectivity source-contract identity"],
    [bundle.libraryBinding.identity, binding.libraryBindingIdentity, "library binding identity"],
    [bundle.deepRuleBinding.identity, binding.deepRuleBindingIdentity, "deep-rule binding identity"],
    [bundle.practiceProfileBinding.identity, binding.practiceProfileBindingIdentity, "practice-profile binding identity"],
    [bundle.acceptancePlan.identity, binding.acceptancePlanIdentity, "acceptance-plan identity"],
    [bundle.executionPrompt.textContentIdentity, binding.executionPromptContentIdentity, "execution-prompt content identity"],
  ];
  const mismatch = pairs.find(([left, right]) => canonicalJson(left) !== canonicalJson(right));
  if (mismatch !== undefined) throw new Error(`Generic fresh ${mismatch[2]} differs from the marker-bound compilation authority.`);
}

function contractAuthoringProject(project: FreshProject | undefined): boolean {
  return project?.workflowKind === "generic" || isVerifiedPlaneFreshProject(project);
}
function authoringProjectBinding(project: FreshProject) {
  if(isVerifiedPlaneFreshProject(project))return project.planeBinding;
  if(project.workflowKind==="generic"&&project.genericBinding!==undefined)return project.genericBinding;
  throw new Error("Authoring requires its genuine generic or plane project binding.");
}
function projectBindingResultFields(project:FreshProject,identity:CanonicalIdentity):Readonly<{genericProjectBindingIdentity:CanonicalIdentity}>|Readonly<{planeProjectBindingIdentity:CanonicalIdentity}>{
  return project.workflowKind==="plane"?Object.freeze({planeProjectBindingIdentity:identity}):Object.freeze({genericProjectBindingIdentity:identity});
}
function assertPlaneCompilationBinding(project:FreshProject,connectivity:FreshConnectivityContract|undefined,design:PcbPlaneDesignContract|undefined,bundle:PcbPlaneCompilationBundle|undefined):asserts bundle is PcbPlaneCompilationBundle {
  if(!isVerifiedPlaneFreshProject(project)||project.genericBinding!==undefined||connectivity===undefined||design===undefined||bundle===undefined||!isAuthenticatedPcbPlaneCompilationBundle(bundle))throw new Error("Plane authoring requires a genuine plane project and full authenticated V2 compilation bundle.");
  const binding=project.planeBinding;
  const pairs:readonly(readonly[unknown,unknown,string])[]=[
    [createPcbPlaneCompilationBundleRef(bundle),binding.bundleRef,"bundle reference"],[design,bundle.contract,"full V2 contract"],
    [design.identity,binding.contractIdentity,"contract identity"],[connectivity.sourceContractIdentity,binding.contractIdentity,"complete schematic source identity"],
    [bundle.libraryBinding.identity,binding.libraryBindingIdentity,"library binding"],[bundle.deepRuleBinding.identity,binding.deepRuleBindingIdentity,"deep-rule binding"],
    [bundle.verificationPlan.identity,binding.verificationPlanIdentity,"verification plan"],[contentIdentity(bundle.executionGuidance),binding.guidanceContentIdentity,"guidance"],
    [bundle.originalPromptContentIdentity,binding.originalPromptContentIdentity,"original prompt"],
  ];
  const mismatch=pairs.find(([actual,expected])=>canonicalJson(actual)!==canonicalJson(expected));
  if(mismatch)throw new Error(`Plane authoring ${mismatch[2]} differs from its marker-bound V2 authority.`);
}

async function captureFreshPcb(project: FreshProject): Promise<FreshPcbCapture> {
  if (!isVerifiedFreshProject(project) || !contractAuthoringProject(project)) {
    throw new Error("Fresh PCB source capture requires a bundle-bound generic or genuine plane project capability.");
  }
  const markerBefore = await project.assertMarkerCurrent();
  const root = await assertFreshProjectDirectoryChain(project);
  const expected = path.join(root.canonicalPath, `${project.name}.kicad_pcb`);
  if (path.resolve(project.pcbPath) !== expected) throw new Error("Fresh PCB path is not the exact marker-bound project child.");
  const before = await lstat(expected, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size <= 0n || before.size > BigInt(MAX_FRESH_PCB_SOURCE_BYTES)) {
    throw new Error("Fresh PCB source must be a bounded single-link physical regular file.");
  }
  if (await realpath(expected) !== expected) throw new Error("Fresh PCB source resolves through an unsupported link.");
  const bytes = await readFile(expected);
  const after = await lstat(expected, { bigint: true });
  if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n
      || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || BigInt(bytes.byteLength) !== after.size) {
    throw new Error("Fresh PCB source changed while being captured.");
  }
  const markerAfter = await project.assertMarkerCurrent();
  if (!sameContentIdentity(markerBefore, markerAfter)) throw new Error("Fresh marker changed during PCB source capture.");
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch (error) { throw new Error("Fresh PCB source is not strict UTF-8.", { cause: error }); }
  return Object.freeze({
    source,
    contentIdentity: Object.freeze(contentIdentity(bytes)),
    projectBindingIdentity: authoringProjectBinding(project).identity,
    freshMarkerContentIdentity: markerBefore,
    parsed: parseFreshPcbSource(source),
  });
}

const expectedPadNets = (contract: FreshConnectivityContract): ReadonlyMap<string, string | null> => {
  const result = new Map<string, string | null>();
  for (const net of contract.nets) for (const endpoint of net.endpoints) {
    const key = endpointId(endpoint);
    if (result.has(key)) throw new Error(`Contract endpoint ${key} appears more than once.`);
    result.set(key, net.name);
  }
  for (const endpoint of contract.noConnects) {
    const key = endpointId(endpoint);
    if (result.has(key)) throw new Error(`Contract no-connect ${key} also belongs to a net.`);
    result.set(key, null);
  }
  return result;
};

const footprintLeaf = (libraryId: string): string => {
  const separator = libraryId.indexOf(":");
  if (separator < 1 || separator === libraryId.length - 1) throw new Error(`Invalid contract footprint library ID ${libraryId}.`);
  return libraryId.slice(separator + 1);
};

function exactContractPadPositions(
  project: FreshProject,
  contract: FreshConnectivityContract,
  board: FreshParsedPcb,
  physicalMode = false,
): readonly FreshContractPadPosition[] {
  const expectedRefs = new Set(contract.components.map((component) => component.reference));
  if (board.footprints.length !== contract.components.length
      || new Set(board.footprints.map((footprint) => footprint.reference)).size !== board.footprints.length
      || board.footprints.some((footprint) => !expectedRefs.has(footprint.reference))) {
    throw new Error("PCB footprint inventory does not exactly match the host contract.");
  }
  const leafLibraries = new Map<string, Set<string>>();
  for (const component of contract.components) {
    const leaf = footprintLeaf(component.footprintLibId);
    const libraries = leafLibraries.get(leaf) ?? new Set<string>();
    libraries.add(component.footprintLibId);
    leafLibraries.set(leaf, libraries);
  }
  const expected = expectedPadNets(contract);
  const maximum=physicalMode?4096:MAX_FRESH_PAD_POSITIONS;
  if (expected.size === 0 || expected.size > maximum) {
    throw new Error(`Contract pad inventory must contain 1-${maximum} entries.`);
  }
  const positions: FreshContractPadPosition[] = [];
  const observed = new Set<string>();
  for (const component of contract.components) {
    const footprint = board.footprints.find((entry) => entry.reference === component.reference)!;
    const leaf = footprintLeaf(component.footprintLibId);
    const exactLibrary = footprint.libraryId === component.footprintLibId;
    const uniquelyReboundLeaf = !footprint.libraryId.includes(":")
      && footprint.libraryId === leaf && leafLibraries.get(leaf)?.size === 1
      && contractAuthoringProject(project);
    if ((!exactLibrary && !uniquelyReboundLeaf) || footprint.value !== component.value) {
      throw new Error(`PCB footprint ${component.reference} library/value does not match the authenticated contract.`);
    }
    const expectedForReference = [...expected.keys()].filter((key) => key.startsWith(`${component.reference}:`));
    if ((physicalMode?new Set(footprint.pads.filter(p=>p.number.length>0).map(p=>p.number)).size:footprint.pads.length) !== expectedForReference.length) {
      throw new Error(`PCB footprint ${component.reference} pad count differs from the contract.`);
    }
    for (const pad of footprint.pads) {
      if(physicalMode&&pad.number.length===0){
        if(pad.netName!==null||pad.physical.padType!=="smd"||pad.layers.some(layer=>layer!=="F.Paste"&&layer!=="B.Paste"))throw new Error(`PCB ${component.reference} has unsupported unnumbered/non-electrical pad features.`);
        continue;
      }
      const key = `${component.reference}:${pad.number}`;
      if (!expected.has(key) || (!physicalMode&&observed.has(key)) || pad.netName !== expected.get(key)) {
        throw new Error(`PCB pad ${key} is missing, duplicated, extra, or mapped to the wrong net.`);
      }
      if (!Number.isFinite(pad.at.x) || !Number.isFinite(pad.at.y)
          || pad.layers.length === 0 || new Set(pad.layers).size !== pad.layers.length) {
        throw new Error(`PCB pad ${key} has unsupported position or layer data.`);
      }
      observed.add(key);
      if(physicalMode){
        if(footprint.id===null||pad.physical.id===null||pad.physical.sizeMm===null||pad.physical.shape===null
          ||pad.physical.padType!=="smd"&&pad.physical.padType!=="thru_hole"
          ||pad.physical.padType==="smd"&&pad.physical.drill!==null||pad.physical.padType==="thru_hole"&&pad.physical.drill===null)throw new Error(`PCB physical pad ${key} has unsupported identity/type/drill geometry.`);
      }
      // Route coordinates are exposed only for net-bound contract pads. The
      // no-connect inventory is still verified exactly above, but it is not a
      // legal routing endpoint and therefore cannot enter provider feedback.
      if (pad.netName !== null) {
        positions.push({
          reference: component.reference,
          pad: pad.number,
          net: pad.netName,
          xMm: pad.at.x,
          yMm: pad.at.y,
          layers: [...pad.layers],
          ...(physicalMode?{physical:{id:pad.physical.id!,footprintId:footprint.id!,padType:pad.physical.padType!,shape:pad.physical.shape!,sizeMm:pad.physical.sizeMm!,drill:pad.physical.drill}}:{}),
        });
      }
    }
  }
  if (observed.size !== expected.size || [...expected.keys()].some((key) => !observed.has(key))) {
    throw new Error("PCB does not contain every expected contract pad exactly once.");
  }
  return freezeDeep(positions.sort((left, right) =>
    left.reference.localeCompare(right.reference, "en-US") || left.pad.localeCompare(right.pad, "en-US") || (left.physical?.id??"").localeCompare(right.physical?.id??"","en-US")));
}

function buildRouteSelection(contract: FreshConnectivityContract, capture: FreshPcbCapture): AuthoringRouteSelection {
  const contractNets = new Set(contract.nets.map((net) => net.name));
  const items: FreshRouteSelectionItem[] = [];
  const addTrack = (track: FreshPcbSegment): void => {
    if (track.id === null || !KICAD_SELECTION_ID.test(track.id) || track.netName === null || !contractNets.has(track.netName)) {
      throw new Error("Every selectable track must have an exact KiCad uuid/tstamp identity and contract net.");
    }
    items.push({ kind: "track", id: track.id, net: track.netName, start: { xMm: track.start.x, yMm: track.start.y }, end: { xMm: track.end.x, yMm: track.end.y }, widthMm: track.widthMm, layer: track.layer });
  };
  const addVia = (via: FreshPcbVia): void => {
    if (via.id === null || !KICAD_SELECTION_ID.test(via.id) || via.netName === null || !contractNets.has(via.netName)) {
      throw new Error("Every selectable via must have an exact KiCad uuid/tstamp identity and contract net.");
    }
    items.push({ kind: "via", id: via.id, net: via.netName, at: { xMm: via.at.x, yMm: via.at.y }, diameterMm: via.diameterMm, drillMm: via.drillMm, layers: [...via.layers] });
  };
  capture.parsed.segments.forEach(addTrack);
  capture.parsed.vias.forEach(addVia);
  if (items.length > MAX_FRESH_ROUTE_SELECTION_ITEMS) throw new Error(`Fresh route selection exceeds ${MAX_FRESH_ROUTE_SELECTION_ITEMS} items.`);
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error("Fresh route selection contains duplicate track/via UUIDs.");
  items.sort((left, right) => left.id.localeCompare(right.id, "en-US"));
  if(capture.projectBindingIdentity.schemaVersion==="evleda.pcb-agent-plane-fresh-binding.v1"){
    const sourceRoutes=parseFreshPcbRouteSourceSpans(capture.source);
    if(sourceRoutes.length!==items.length||sourceRoutes.some(span=>!items.some(item=>item.id===span.id&&item.kind===span.kind)))throw new Error("Plane route selection differs from its exact complete source-span inventory.");
    const payload={schemaVersion:FRESH_PLANE_ROUTE_SELECTION_SCHEMA_VERSION,contractIdentity:contract.identity,
      sourceContractIdentity:contract.sourceContractIdentity,planeProjectBindingIdentity:capture.projectBindingIdentity,
      freshMarkerContentIdentity:capture.freshMarkerContentIdentity,pcbContentIdentity:capture.contentIdentity,items,
      completion:"not_evaluated" as const,connection:"not_evaluated" as const,notEvaluated:PLANE_ROUTE_NOT_EVALUATED};
    return freezeDeep({...payload,identity:canonicalIdentity(payload,payload.schemaVersion)});
  }
  const payload = {
    schemaVersion: FRESH_ROUTE_SELECTION_SCHEMA_VERSION,
    contractIdentity: contract.identity,
    genericProjectBindingIdentity: capture.projectBindingIdentity,
    freshMarkerContentIdentity: capture.freshMarkerContentIdentity,
    pcbContentIdentity: capture.contentIdentity,
    items,
  };
  return freezeDeep({ ...payload, identity: canonicalIdentity(payload, FRESH_ROUTE_SELECTION_SCHEMA_VERSION) });
}

const ROUTE_GEOMETRY_EPSILON_MM = 1e-6;
const routePointEqual = (left: { readonly xMm: number; readonly yMm: number }, right: { readonly xMm: number; readonly yMm: number }): boolean =>
  Math.hypot(left.xMm - right.xMm, left.yMm - right.yMm) <= ROUTE_GEOMETRY_EPSILON_MM;
const orientation = (
  a: { readonly xMm: number; readonly yMm: number },
  b: { readonly xMm: number; readonly yMm: number },
  c: { readonly xMm: number; readonly yMm: number },
): number => (b.xMm - a.xMm) * (c.yMm - a.yMm) - (b.yMm - a.yMm) * (c.xMm - a.xMm);
const pointOnRouteSegment = (
  point: { readonly xMm: number; readonly yMm: number },
  start: { readonly xMm: number; readonly yMm: number },
  end: { readonly xMm: number; readonly yMm: number },
): boolean => Math.abs(orientation(start, end, point)) <= ROUTE_GEOMETRY_EPSILON_MM
  && point.xMm >= Math.min(start.xMm, end.xMm) - ROUTE_GEOMETRY_EPSILON_MM
  && point.xMm <= Math.max(start.xMm, end.xMm) + ROUTE_GEOMETRY_EPSILON_MM
  && point.yMm >= Math.min(start.yMm, end.yMm) - ROUTE_GEOMETRY_EPSILON_MM
  && point.yMm <= Math.max(start.yMm, end.yMm) + ROUTE_GEOMETRY_EPSILON_MM;

function assertCleanReplacementRoute(
  contract: PcbDesignContract,
  practiceProfile: PcbPracticeAnalysisProfile,
  netName: string,
  selection: Pick<FreshRouteSelection,"items">,
  pads: readonly FreshContractPadPosition[],
  boardSource: string,
): void {
  const tracks = selection.items.filter((item): item is Extract<FreshRouteSelectionItem, { kind: "track" }> => item.kind === "track" && item.net === netName);
  const vias = selection.items.filter((item): item is Extract<FreshRouteSelectionItem, { kind: "via" }> => item.kind === "via" && item.net === netName);
  const netPads = pads.filter((pad) => pad.net === netName);
  if (tracks.length === 0 || netPads.length < 2) throw new Error(`Replacement route ${netName} lacks tracks or contract pads.`);
  const net = contract.nets.find((entry) => entry.name === netName);
  const routeConstraint = contract.routingConstraints.nets.find((entry) => entry.net === netName);
  const netClass = net === undefined ? undefined : contract.netClasses.find((entry) => entry.id === net.netClassId);
  if (net === undefined || routeConstraint === undefined || netClass === undefined) throw new Error(`Replacement route ${netName} is not fully bound to a contract net/class/route.`);
  const allowedLayerSet = new Set<string>(netClass.allowedLayers);
  for (const track of tracks) {
    const dx = Math.abs(track.end.xMm - track.start.xMm);
    const dy = Math.abs(track.end.yMm - track.start.yMm);
    if (!allowedLayerSet.has(track.layer)
        || (routeConstraint.preferredLayer !== "either" && track.layer !== routeConstraint.preferredLayer)
        || track.widthMm + ROUTE_GEOMETRY_EPSILON_MM < netClass.traceWidthMm
        || Math.hypot(dx, dy) <= ROUTE_GEOMETRY_EPSILON_MM
        || !(dx <= ROUTE_GEOMETRY_EPSILON_MM || dy <= ROUTE_GEOMETRY_EPSILON_MM || Math.abs(dx - dy) <= ROUTE_GEOMETRY_EPSILON_MM)) {
      throw new Error(`Replacement route ${netName} retains a wrong-layer, undersized, zero-length, or non-45-degree track.`);
    }
  }
  const viaPolicy = contract.routingConstraints.viaPolicy;
  const allVias = selection.items.filter((item) => item.kind === "via");
  if (viaPolicy.mode === "forbidden" && allVias.length > 0) throw new Error("Replacement route violates the contract's global zero-via policy.");
  if (vias.length > routeConstraint.maxVias || (viaPolicy.mode === "bounded" && allVias.length > viaPolicy.maxTotal)) {
    throw new Error(`Replacement route ${netName} exceeds its per-net or global via bound.`);
  }
  if (viaPolicy.mode === "bounded") for (const via of vias) {
    const boardLayers = contract.scope.board.copperLayers;
    const viaLayerSet = new Set<string>(via.layers);
    if (via.layers.length !== boardLayers.length
        || boardLayers.some((layer) => !viaLayerSet.has(layer))
        || via.layers.some((layer) => !allowedLayerSet.has(layer))
        || via.diameterMm + ROUTE_GEOMETRY_EPSILON_MM < viaPolicy.diameterMm
        || via.drillMm + ROUTE_GEOMETRY_EPSILON_MM < viaPolicy.drillMm
        || (via.diameterMm - via.drillMm) / 2 + ROUTE_GEOMETRY_EPSILON_MM < viaPolicy.minimumAnnularRingMm) {
      throw new Error(`Replacement route ${netName} retains a via with unsupported layers or dimensions.`);
    }
  }
  const totalLengthMm = tracks.reduce((total, track) => total + Math.hypot(track.end.xMm - track.start.xMm, track.end.yMm - track.start.yMm), 0);
  if (routeConstraint.routeLength.mode === "bounded" && totalLengthMm > routeConstraint.routeLength.maximumMm + ROUTE_GEOMETRY_EPSILON_MM) {
    throw new Error(`Replacement route ${netName} exceeds its maximum routed length.`);
  }
  for (let leftIndex = 0; leftIndex < tracks.length; leftIndex += 1) {
    const left = tracks[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < tracks.length; rightIndex += 1) {
      const right = tracks[rightIndex]!;
      if (left.layer !== right.layer) continue;
      const shared = [left.start, left.end].some((point) => routePointEqual(point, right.start) || routePointEqual(point, right.end));
      const o1 = orientation(left.start, left.end, right.start);
      const o2 = orientation(left.start, left.end, right.end);
      const o3 = orientation(right.start, right.end, left.start);
      const o4 = orientation(right.start, right.end, left.end);
      const proper = ((o1 > ROUTE_GEOMETRY_EPSILON_MM && o2 < -ROUTE_GEOMETRY_EPSILON_MM)
        || (o1 < -ROUTE_GEOMETRY_EPSILON_MM && o2 > ROUTE_GEOMETRY_EPSILON_MM))
        && ((o3 > ROUTE_GEOMETRY_EPSILON_MM && o4 < -ROUTE_GEOMETRY_EPSILON_MM)
          || (o3 < -ROUTE_GEOMETRY_EPSILON_MM && o4 > ROUTE_GEOMETRY_EPSILON_MM));
      const collinearOverlap = Math.abs(o1) <= ROUTE_GEOMETRY_EPSILON_MM && Math.abs(o2) <= ROUTE_GEOMETRY_EPSILON_MM
        && ([right.start, right.end].filter((point) => pointOnRouteSegment(point, left.start, left.end)).length
          + [left.start, left.end].filter((point) => pointOnRouteSegment(point, right.start, right.end)).length > 2);
      if (proper || collinearOverlap || (!shared && (
        [right.start, right.end].some((point) => pointOnRouteSegment(point, left.start, left.end))
        || [left.start, left.end].some((point) => pointOnRouteSegment(point, right.start, right.end))
      ))) {
        throw new Error(`Replacement route ${netName} contains a self-intersection or overlapping track.`);
      }
    }
  }
  const practiceAnalysis=analyzeKicadPcbPractices(boardSource, practiceProfile);
  const hairpins = practiceAnalysis.extracted.hairpinCandidates
    .filter((candidate) => candidate.netName === netName);
  if (hairpins.length > 0) {
    throw new Error(`Replacement route ${netName} enters the bound practice profile's adjacent parallel hairpin proximity envelope.`);
  }

  type RoutePoint = Readonly<{ xMm: number; yMm: number }>;
  type GraphEdge = Readonly<{ id: string; left: string; right: string; kind: "track" | "via" | "pad" }>;
  const coordinateKey = (point: RoutePoint): string => canonicalJson([point.xMm === 0 ? 0 : point.xMm, point.yMm === 0 ? 0 : point.yMm]);
  const nodeKey = (layer: string, point: RoutePoint): string => `${layer}\0${coordinateKey(point)}`;
  const nodes = new Set<string>();
  const edges: GraphEdge[] = [];
  const adjacency = new Map<string, Array<{ readonly edgeId: string; readonly next: string }>>();
  const addNode = (key: string): void => { nodes.add(key); if (!adjacency.has(key)) adjacency.set(key, []); };
  const addEdge = (edge: GraphEdge): void => {
    if (edge.left === edge.right) throw new Error(`Replacement route ${netName} contains a zero-span ${edge.kind} graph edge.`);
    addNode(edge.left); addNode(edge.right); edges.push(edge);
    adjacency.get(edge.left)!.push({ edgeId: edge.id, next: edge.right });
    adjacency.get(edge.right)!.push({ edgeId: edge.id, next: edge.left });
  };
  const trackIncidents = new Map<string, Array<{ readonly node: RoutePoint; readonly other: RoutePoint }>>();
  const coordinateTrackCounts = new Map<string, number>();
  for (const track of tracks) {
    const start = nodeKey(track.layer, track.start);
    const end = nodeKey(track.layer, track.end);
    addEdge({ id: `track:${track.id}`, left: start, right: end, kind: "track" });
    for (const [node, other] of [[track.start, track.end], [track.end, track.start]] as const) {
      const key = nodeKey(track.layer, node);
      const incidents = trackIncidents.get(key) ?? [];
      incidents.push({ node, other });
      trackIncidents.set(key, incidents);
      const coordinate = coordinateKey(node);
      coordinateTrackCounts.set(coordinate, (coordinateTrackCounts.get(coordinate) ?? 0) + 1);
    }
  }
  const viaNodes = new Set<string>();
  for (const via of vias) {
    const keys = via.layers.map((layer) => nodeKey(layer, via.at));
    keys.forEach((key) => viaNodes.add(key));
    for (let index = 1; index < keys.length; index += 1) {
      addEdge({ id: `via:${via.id}:${index}`, left: keys[index - 1]!, right: keys[index]!, kind: "via" });
    }
  }
  const padNodes = new Set<string>();
  const padCoordinates = new Set<string>();
  const nodesByPad = new Map<string, readonly string[]>();
  const physicalMode=netPads.some(pad=>pad.physical!==undefined);
  if(physicalMode){
    const sourceBoard=parseFreshPcbSource(boardSource);
    const sourcePads=new Map(net.endpoints.map(endpoint=>[`${endpoint.reference}:${endpoint.pin}`,sourceBoard.footprints.filter(fp=>fp.reference===endpoint.reference).flatMap(fp=>fp.pads.filter(pad=>pad.number===endpoint.pin&&pad.netName===netName))]));
    const topology=buildFreshPhysicalRouteTopology(practiceAnalysis.extracted.segments.filter(segment=>segment.netName===netName),practiceAnalysis.extracted.vias.filter(via=>via.netName===netName),sourcePads);
    if(!topology.connected||!topology.acyclic||!topology.noDuplicateEdges||!topology.leavesTerminateAtPads||(routeConstraint.topology==="point_to_point"&&!topology.pointToPointSimplePath))throw new Error(`Replacement route ${netName} violates source physical-pad topology (connected=${topology.connected}, acyclic=${topology.acyclic}, pad-terminated=${topology.leavesTerminateAtPads}).`);
    for(const pad of netPads)padCoordinates.add(coordinateKey(pad));
    for(const [coordinate,count]of coordinateTrackCounts)if(count>2&&!padCoordinates.has(coordinate))throw new Error(`Replacement route ${netName} creates an unsupported free-space tee.`);
  }else{
  for (const pad of netPads) {
    const expanded: string[] = [];
    for (const selector of pad.layers) {
      if (selector === "*.Cu") expanded.push(...contract.scope.board.copperLayers);
      else if (contract.scope.board.copperLayers.includes(selector as "F.Cu" | "B.Cu")) expanded.push(selector);
      else if (selector.endsWith(".Cu")) throw new Error(`Contract pad ${pad.reference}.${pad.pad} uses unsupported copper layer ${selector}.`);
    }
    const layers = [...new Set(expanded)].filter((layer) => allowedLayerSet.has(layer));
    if (layers.length === 0) throw new Error(`Contract pad ${pad.reference}.${pad.pad} has no allowed copper layer for ${netName}.`);
    const keys = layers.map((layer) => nodeKey(layer, pad));
    keys.forEach((key) => { addNode(key); padNodes.add(key); });
    padCoordinates.add(coordinateKey(pad));
    nodesByPad.set(`${pad.reference}:${pad.pad}`, keys);
    for (let index = 1; index < keys.length; index += 1) {
      addEdge({ id: `pad:${pad.reference}:${pad.pad}:${index}`, left: keys[index - 1]!, right: keys[index]!, kind: "pad" });
    }
  }
  for (const [pad, keys] of nodesByPad) {
    if (!keys.some((key) => (trackIncidents.get(key)?.length ?? 0) > 0)) throw new Error(`Replacement route ${netName} does not reach contract pad ${pad} on an allowed copper layer.`);
  }
  for (const [coordinate, count] of coordinateTrackCounts) {
    if (count > 2 && !padCoordinates.has(coordinate)) {
      throw new Error(`Replacement route ${netName} creates an unsupported free-space tee; multi-endpoint nets must daisy-chain through a pad.`);
    }
  }
  for (const [key, incidents] of trackIncidents) {
    if (incidents.length === 1 && !padNodes.has(key) && !viaNodes.has(key)) {
      throw new Error(`Replacement route ${netName} has a dangling non-pad/non-via endpoint.`);
    }
  }
  for (const key of viaNodes) {
    if (!padNodes.has(key) && (trackIncidents.get(key)?.length ?? 0) === 0) {
      throw new Error(`Replacement route ${netName} has a via layer with no incident track or pad.`);
    }
  }
  const firstPadNodes = nodesByPad.values().next().value as readonly string[] | undefined;
  if (firstPadNodes === undefined || firstPadNodes.length === 0) throw new Error(`Replacement route ${netName} has no graph seed pad.`);
  const reached = new Set<string>();
  const queue = [firstPadNodes[0]!];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (reached.has(current)) continue;
    reached.add(current);
    for (const edge of adjacency.get(current) ?? []) if (!reached.has(edge.next)) queue.push(edge.next);
  }
  if (reached.size !== nodes.size || [...nodesByPad.values()].some((keys) => keys.some((key) => !reached.has(key)))) {
    throw new Error(`Replacement route ${netName} contains a disconnected copper island or a pad outside the one routed component.`);
  }
  if (edges.length !== nodes.size - 1) {
    throw new Error(`Replacement route ${netName} contains a copper cycle, duplicate transition, or backtracking loop.`);
  }
  }

  const maximumTurn = contract.routingConstraints.maximumTurnAngleDeg;
  for (const entries of trackIncidents.values()) {
    if (entries.length === 2) {
      const first = { x: entries[0]!.other.xMm - entries[0]!.node.xMm, y: entries[0]!.other.yMm - entries[0]!.node.yMm };
      const second = { x: entries[1]!.other.xMm - entries[1]!.node.xMm, y: entries[1]!.other.yMm - entries[1]!.node.yMm };
      const denominator = Math.hypot(first.x, first.y) * Math.hypot(second.x, second.y);
      if (denominator <= ROUTE_GEOMETRY_EPSILON_MM) throw new Error(`Replacement route ${netName} contains a zero-length segment.`);
      const awayAngle = Math.acos(Math.max(-1, Math.min(1, (first.x * second.x + first.y * second.y) / denominator))) * 180 / Math.PI;
      const turnAngle = 180 - awayAngle;
      if (turnAngle > 1e-6
          && (Math.hypot(first.x, first.y) + ROUTE_GEOMETRY_EPSILON_MM < contract.routingConstraints.minimumStraightBeforeTurnMm
            || Math.hypot(second.x, second.y) + ROUTE_GEOMETRY_EPSILON_MM < contract.routingConstraints.minimumStraightBeforeTurnMm)) {
        throw new Error(`Replacement route ${netName} violates the minimum straight length before a turn.`);
      }
      if (turnAngle > maximumTurn + 1e-6) throw new Error(`Replacement route ${netName} exceeds its ${maximumTurn}-degree turn bound or backtracks.`);
    }
  }
}

const endpointId = (endpoint: FreshConnectivityEndpoint): string => `${endpoint.reference}:${endpoint.pin}`;
const pointDistance = (left: FreshPoint, right: FreshPoint): number => Math.hypot(left.x - right.x, left.y - right.y);

function preferredResultText(result: CallToolResult): string {
  const serialized = resultContent(result);
  const payload = JSON.parse(serialized) as { result?: unknown };
  return typeof payload.result === "string" ? payload.result : serialized;
}

async function freshActiveBoardSource(session: KicadHarnessSession, expectedPath: string): Promise<string> {
  if (typeof session.readActivePcbSource !== "function") throw new Error("Fresh board authority requires the private raw-source port.");
  const source = await session.readActivePcbSource(expectedPath);
  if (typeof source !== "string" || source.length === 0 || Buffer.byteLength(source, "utf8") > 500_000
      || /\[\s*truncated\s*\]|\btruncat(?:ed|ion)\b/iu.test(source)) {
    throw new Error("KiCad live board readback is absent, truncated, or over its host bound.");
  }
  freshBoardComparisonText(source);
  parseFreshPcbSource(source);
  return source;
}

function nativeReplyCause(operation:string,result:CallToolResult):unknown{
  try{
    const json=JSON.stringify(result),bytes=Buffer.from(json,"utf8");
    return freezeDeep(bytes.length<=16*1024?{operation,response:JSON.parse(json) as unknown}:{operation,responseIdentity:contentIdentity(bytes),responseJsonPrefix:bytes.subarray(0,8192).toString("utf8"),responseTruncated:true});
  }catch(error){return Object.freeze({operation,responseCaptureUnavailable:true,captureError:(error instanceof Error?error.message:String(error)).slice(0,512)});}
}
function assertSuccessfulSidecarMutation(result: CallToolResult, operation: string): string {
  if (result.isError === true) throw new Error(`${operation} returned an MCP error.`,{cause:nativeReplyCause(operation,result)});
  const text = preferredResultText(result).replace(/\s+/gu, " ").trim();
  if (text.length === 0 || /\b(?:failed|failure|error|aborted|unable|refus(?:e|ed|ing))\b|\bcould not\b|\bwas not found\b/iu.test(text)) {
    throw new Error(`${operation} did not report a successful governed mutation: ${text.slice(0, 500)}`,{cause:nativeReplyCause(operation,result)});
  }
  return text;
}

export function parseFreshPlacements(value: string): ReadonlyMap<string, readonly FreshPlacement[]> {
  const placements = new Map<string, FreshPlacement[]>();
  const lines = value.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  const heading = /^Symbols \((\d+) total\):$/u.exec(lines[0]?.trim() ?? "");
  const placementLines = heading === null ? lines : lines.slice(1);
  if (heading !== null && Number(heading[1]) !== placementLines.length) throw new Error("Symbol placement readback count does not match its declared total.");
  const expression = /^-\s+([A-Z][A-Z0-9_-]{0,31})\s+(.{1,256}?)\s+([^\s:]{1,120}):([^\s:]{1,240})\s+@\s+\((-?[\d.]+),\s*(-?[\d.]+)\)\s+rot=(0|90|180|270)\s+unit=([1-9]\d?)(?:\s+footprint=([^\s:]{1,120}):([^\s:]{1,384}))?\s*$/u;
  for (const line of placementLines) {
    if (line.length > 1_500) throw new Error("Symbol placement readback line exceeds its bounded grammar.");
    const match = expression.exec(line);
    if (match === null) throw new Error("Symbol placement readback contains a malformed or unsupported line suffix.");
    const x = Number(match[5]);
    const y = Number(match[6]);
    const rotation = Number(match[7]);
    const unit = Number(match[8]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 2_000 || Math.abs(y) > 2_000 || !Number.isSafeInteger(unit) || unit < 1 || unit > 64) {
      throw new Error("Symbol placement readback contains out-of-bounds placement data.");
    }
    const footprint = match[9] === undefined ? undefined : `${match[9]}:${match[10]}`;
    const placement: FreshPlacement = {
      reference: match[1]!, value: match[2]!.trim(), library: match[3]!, symbol: match[4]!, x, y, rotation, unit,
      ...(footprint === undefined ? {} : { footprint }),
    };
    const existing = placements.get(placement.reference) ?? [];
    existing.push(placement);
    placements.set(placement.reference, existing);
  }
  if (placements.size === 0 && placementLines.length > 0) throw new Error("Symbol placement readback contains no valid placements.");
  return placements;
}

function parseFreshConnectivityGroups(value: string): readonly FreshConnectivityGroup[] {
  const groups: FreshConnectivityGroup[] = [];
  for (const line of value.split(/\r?\n/u)) {
    const match = /(?:^|\s)Group\s+\d+:\s*([^|]+)\|\s*pins=([^|]+)/u.exec(line);
    if (match === null) continue;
    const endpoints = match[2]!.split(",").map((entry) => entry.trim()).filter(Boolean);
    groups.push({ name: match[1]!.trim(), endpoints });
  }
  return groups;
}

export function parseFreshBoundingBoxes(value: string): readonly FreshBoundingBox[] {
  if (!/^Schematic bounding boxes \((\d+) symbols\):/mu.test(value) || !/Sheet occupied region:[^\r\n]+\bmm\b/mu.test(value)) {
    throw new Error("Schematic bounding-box readback does not explicitly declare its supported symbol count and millimetre units.");
  }
  const declared = Number(/^Schematic bounding boxes \((\d+) symbols\):/mu.exec(value)![1]);
  const boxes: FreshBoundingBox[] = [];
  const lines = value.split(/\r?\n/u);
  const divider = lines.findIndex((line) => /^-{20,}\s*$/u.test(line));
  if (divider < 0) throw new Error("Schematic bounding-box readback has no table divider.");
  for (const line of lines.slice(divider + 1)) {
    if (line.trim().length === 0) break;
    const match = /^(\S+)\s+.*?\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*$/u.exec(line);
    if (match === null) throw new Error("Schematic bounding-box table contains a malformed row.");
    const values = match.slice(2).map(Number);
    if (values.some((entry) => !Number.isFinite(entry))) throw new Error("Schematic bounding-box table contains a non-finite coordinate.");
    const box = { reference: match[1]!, minX: values[2]!, minY: values[3]!, maxX: values[4]!, maxY: values[5]! };
    if (!(box.minX < box.maxX && box.minY < box.maxY)) throw new Error(`Schematic bounding box for ${box.reference} is empty or inverted.`);
    boxes.push(box);
  }
  if (!Number.isSafeInteger(declared) || declared !== boxes.length) throw new Error(`Schematic bounding-box count mismatch: declared ${declared}, parsed ${boxes.length}.`);
  return boxes;
}

export function exactFreshConnectivityIssues(
  contract: FreshConnectivityContract,
  groups: readonly FreshConnectivityGroup[],
): readonly FreshConnectivityIssue[] {
  if (groups.length === 0) return [{
    code: "CONNECTIVITY_READBACK_UNSUPPORTED",
    message: "Connectivity readback did not expose any supported group records.",
    remediation: "Keep the schematic open and retry after KiCad connectivity is available.",
  }];
  const endpointGroups = new Map<string, FreshConnectivityGroup[]>();
  for (const group of groups) for (const endpoint of group.endpoints) {
    endpointGroups.set(endpoint, [...(endpointGroups.get(endpoint) ?? []), group]);
  }
  const issues: FreshConnectivityIssue[] = [];
  const expectedEndpoints = new Set([
    ...contract.nets.flatMap((net) => net.endpoints.map(endpointId)),
    ...contract.noConnects.map(endpointId),
  ]);
  const expectedNames = new Set(contract.nets.map((net) => net.name));
  for (const group of groups) {
    if (group.name !== "~no-connect" && !expectedNames.has(group.name)) issues.push({
      code: "UNEXPECTED_CONNECTIVITY_GROUP",
      message: `Connectivity readback contains non-contract group ${group.name}.`,
      remediation: "Restore the exact contract topology before continuing.",
      endpoints: group.endpoints,
    });
    const unknown = group.endpoints.filter((endpoint) => !expectedEndpoints.has(endpoint));
    if (unknown.length > 0) issues.push({
      code: "UNEXPECTED_CONNECTIVITY_ENDPOINT",
      message: `Connectivity readback contains endpoint(s) absent from the host contract: ${unknown.join(", ")}.`,
      remediation: "Restore the exact contract component and pin inventory before continuing.",
      endpoints: unknown,
    });
  }
  for (const net of contract.nets) {
    const expected = new Set(net.endpoints.map(endpointId));
    const matching = groups.filter((group) => group.name === net.name);
    if (matching.length !== 1) {
      issues.push({
        code: "NET_GROUP_MISMATCH",
        message: `Expected exactly one ${net.name} group, observed ${matching.length}.`,
        remediation: "Do not restate topology; preserve the bound contract and inspect the current schematic connectivity.",
        endpoints: [...expected],
      });
      continue;
    }
    const actual = new Set(matching[0]!.endpoints);
    if (actual.size !== expected.size || [...expected].some((endpoint) => !actual.has(endpoint))) {
      issues.push({
        code: "NET_ENDPOINT_MISMATCH",
        message: `${net.name} readback does not exactly match its host-bound endpoint set.`,
        remediation: "Do not add arbitrary wires; keep this result unresolved for host review.",
        endpoints: [...expected],
      });
    }
  }
  for (const endpoint of contract.noConnects) {
    const id = endpointId(endpoint);
    const endpointEntries = endpointGroups.get(id) ?? [];
    if (endpointEntries.length !== 1 || endpointEntries[0]!.name !== "~no-connect" || endpointEntries[0]!.endpoints.length !== 1) {
      issues.push({
        code: "NO_CONNECT_GROUP_MISMATCH",
        message: `${id} must appear exactly once as a singleton ~no-connect readback group.`,
        remediation: "Do not alter the contract; apply the exact no-connect marker or remove unintended connectivity before retrying.",
        endpoints: [id],
      });
    }
  }
  const expectedNoConnects = new Set(contract.noConnects.map(endpointId));
  const actualNoConnects = groups.filter((group) => group.name === "~no-connect").flatMap((group) => group.endpoints);
  if (actualNoConnects.length !== expectedNoConnects.size || actualNoConnects.some((endpoint) => !expectedNoConnects.has(endpoint))) issues.push({
    code: "EXTRA_OR_DUPLICATE_NO_CONNECT_GROUP",
    message: "Connectivity readback contains a missing, duplicate, or non-contract ~no-connect endpoint.",
    remediation: "Restore the exact host-contract no-connect disposition before continuing.",
    endpoints: [...expectedNoConnects],
  });
  return issues;
}

export function freshConnectivityReadbackIssues(
  contract: FreshConnectivityContract,
  readback: string,
): readonly FreshConnectivityIssue[] {
  return exactFreshConnectivityIssues(contract, parseFreshConnectivityGroups(readback));
}

export function freshNativeNetlistParityIssues(
  contract: FreshConnectivityContract,
  source: string,
): readonly FreshConnectivityIssue[] {
  const native = parseFreshNetlistSource(source);
  const intentionalNoConnectNets = native.nets.filter((net) =>
    /^unconnected-\(.+\)$/u.test(net.name)
    && net.nodes.length === 1
    && net.nodes[0]!.pinType.split("+").includes("no_connect"),
  );
  const functionalNets = native.nets.filter((net) => !intentionalNoConnectNets.includes(net));
  const expectedReferences = [...contract.components.map((component) => component.reference)].sort();
  const actualReferences = [...native.references].sort();
  const issues: FreshConnectivityIssue[] = [];
  if (JSON.stringify(actualReferences) !== JSON.stringify(expectedReferences)) issues.push({
    code: "NATIVE_COMPONENT_PARITY_MISMATCH",
    message: "Native KiCad netlist component references do not exactly match the host contract.",
    remediation: "Keep completion blocked and restore the last trusted fresh checkpoint.",
    endpoints: expectedReferences,
  });
  for (const component of contract.components) {
    const observed = native.components.find((candidate) => candidate.reference === component.reference);
    if (
      observed === undefined
      || observed.symbolLibId !== component.symbolLibId
      || observed.value !== component.value
      || observed.footprintLibId !== component.footprintLibId
    ) issues.push({
      code: "NATIVE_COMPONENT_IDENTITY_PARITY_MISMATCH",
      message: `Native KiCad netlist identity for ${component.reference} does not exactly match its contract library, value, and footprint.`,
      remediation: "Keep completion blocked and restore the last trusted fresh checkpoint.",
      endpoints: [component.reference],
    });
  }
  const expectedNames = [...contract.nets.map((net) => net.name)].sort();
  const actualNames = [...functionalNets.map((net) => net.name)].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) issues.push({
    code: "NATIVE_NET_NAME_PARITY_MISMATCH",
    message: "Native KiCad netlist names do not exactly match the host contract.",
    remediation: "Keep completion blocked; provider prose or sidecar-only readback cannot override native parity.",
  });
  for (const net of contract.nets) {
    const expected = [...net.endpoints.map(endpointId)].sort();
    const observedNet = functionalNets.find((candidate) => candidate.name === net.name);
    const actual = observedNet === undefined ? [] : observedNet.nodes.map(endpointId).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) issues.push({
      code: "NATIVE_NET_ENDPOINT_PARITY_MISMATCH",
      message: `Native KiCad netlist endpoints for ${net.name} do not exactly match the host contract.`,
      remediation: "Keep completion blocked and restore the pre-connectivity schematic.",
      endpoints: expected,
    });
  }
  const actualNoConnects = intentionalNoConnectNets.map((net) => endpointId(net.nodes[0]!)).sort();
  const expectedNoConnects = contract.noConnects.map(endpointId).sort();
  if (JSON.stringify(actualNoConnects) !== JSON.stringify(expectedNoConnects)) issues.push({
    code: "NATIVE_NO_CONNECT_PARITY_MISMATCH",
    message: "Native KiCad singleton no-connect endpoints do not exactly match the host contract.",
    remediation: "Keep completion blocked and restore the pre-connectivity schematic.",
    endpoints: expectedNoConnects,
  });
  return issues;
}

function pristineConnectivityIssues(
  contract: FreshConnectivityContract,
  groups: readonly FreshConnectivityGroup[],
  noConnectCount: number,
): readonly FreshConnectivityIssue[] {
  const expected = new Set([
    ...contract.nets.flatMap((net) => net.endpoints.map(endpointId)),
    ...contract.noConnects.map(endpointId),
  ]);
  const issues: FreshConnectivityIssue[] = [];
  const endpointGroups = new Map<string, FreshConnectivityGroup[]>();
  for (const group of groups) {
    for (const endpoint of group.endpoints) endpointGroups.set(endpoint, [...(endpointGroups.get(endpoint) ?? []), group]);
    const contractEndpoints = group.endpoints.filter((endpoint) => expected.has(endpoint));
    if (contractEndpoints.length === 0) continue;
    if (group.name !== "~unnamed" || group.endpoints.length !== 1) {
      issues.push({
        code: "PREEXISTING_CONNECTIVITY",
        message: `Contract endpoint(s) already belong to ${group.name} or a multi-pin group before the atomic contract operation.`,
        remediation: "Start from disconnected contract symbols, or restore a trusted checkpoint before retrying.",
        endpoints: contractEndpoints,
      });
    }
  }
  for (const endpoint of expected) {
    const entries = endpointGroups.get(endpoint) ?? [];
    if (entries.length !== 1 || entries[0]!.name !== "~unnamed" || entries[0]!.endpoints.length !== 1) issues.push({
      code: "PRISTINE_ENDPOINT_READBACK_MISMATCH",
      message: `${endpoint} must appear exactly once as a singleton ~unnamed group before contract connectivity is applied.`,
      remediation: "Restore the exact post-placement, pre-connectivity checkpoint before retrying.",
      endpoints: [endpoint],
    });
  }
  if (noConnectCount !== 0) issues.push({
    code: "PREEXISTING_NO_CONNECT",
    message: `Observed ${noConnectCount} no-connect marker(s) before the contract operation.`,
    remediation: "Restore the pre-connectivity checkpoint so the host cannot duplicate or misidentify markers.",
  });
  return issues;
}

function ercIsClean(payload: Record<string, unknown>): boolean {
  const status = typeof payload.status === "string" ? payload.status.toLowerCase() : "";
  const verdict = typeof payload.verdict === "string" ? payload.verdict.toLowerCase() : "";
  const clean = payload.passed === true || ["clean", "pass", "passed", "ok"].includes(status) || ["clean", "pass", "passed", "ok"].includes(verdict);
  const findings = Array.isArray(payload.findings) ? payload.findings : [];
  const issues = Array.isArray(payload.issues) ? payload.issues : [];
  const metadata = payload.metadata !== null && typeof payload.metadata === "object" ? payload.metadata as Record<string, unknown> : {};
  const counts = [metadata.violation_count, metadata.violations, metadata.issue_count]
    .filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry));
  return clean && findings.length === 0 && issues.length === 0 && counts.every((entry) => entry === 0);
}

export const FRESH_PROVIDER_RESULT_MAX_CHARS = 3_900;

const boundedIssueText = (value: string): string => value.length <= 384 ? value : `${value.slice(0, 383)}…`;

export function serializeFreshContractConnectivityResult(
  contract: Pick<FreshConnectivityContract, "identity">,
  value: FreshContractConnectivityResultFields,
): string {
  const uniqueIssues = new Map<string, FreshConnectivityIssue>();
  for (const issue of value.issues) {
    const key = `${issue.code}\u0000${(issue.endpoints ?? []).join("\u0000")}\u0000${issue.message}\u0000${issue.remediation}\u0000${issue.atMm?.x ?? ""},${issue.atMm?.y ?? ""}`;
    if (!uniqueIssues.has(key)) uniqueIssues.set(key, {
      ...issue,
      message: boundedIssueText(issue.message),
      remediation: boundedIssueText(issue.remediation),
      ...(issue.endpoints === undefined ? {} : { endpoints: issue.endpoints.slice(0, 16) }),
    });
  }
  const compactIssues = new Map<string, FreshConnectivityIssue>();
  for (const issue of uniqueIssues.values()) {
    const key = `${issue.code}\u0000${(issue.endpoints ?? []).join("\u0000")}\u0000${issue.message}\u0000${issue.remediation}\u0000${issue.atMm?.x ?? ""},${issue.atMm?.y ?? ""}`;
    if (!compactIssues.has(key)) compactIssues.set(key, issue);
  }
  const issues = [...compactIssues.values()].sort(issueOrder).slice(0, MAX_RETURNED_FRESH_CONNECTIVITY_ISSUES);
  const issueTotal = Math.max(value.issueEvidence?.total ?? 0, uniqueIssues.size);
  const uniqueBlockingEdges = [...new Map((value.blockingEdges ?? []).map((edge) => [`${edge.net}\u0000${edge.endpoints.join("\u0000")}`, edge])).values()]
    .sort((left, right) => `${left.net}\u0000${left.endpoints.join("\u0000")}`.localeCompare(`${right.net}\u0000${right.endpoints.join("\u0000")}`, "en-US"))
    .slice(0, MAX_RETURNED_FRESH_BLOCKING_EDGES);
  const blockingTotal = Math.max(value.blockingEdgeEvidence?.total ?? 0, new Set((value.blockingEdges ?? []).map((edge) => `${edge.net}\u0000${edge.endpoints.join("\u0000")}`)).size);
  const {
    issues: _issues,
    issueEvidence: _issueEvidence,
    blockingEdges: _blockingEdges,
    blockingEdgeEvidence: _blockingEdgeEvidence,
    routes: _routes,
    noConnects: _noConnects,
    connectivity: _connectivity,
    ...identityFirst
  } = value;
  const minimumIssues = value.applied ? 0 : 1;
  let issueCount = issues.length;
  let blockingCount = uniqueBlockingEdges.length;
  let routeCount = value.routes?.length ?? 0;
  let noConnectCount = value.noConnects?.length ?? 0;
  let connectivityCount = value.connectivity?.length ?? 0;
  const build = (): string => JSON.stringify({
    schemaVersion: "evleda.fresh-contract-connectivity-result.v1",
    contractIdentity: contract.identity,
    ...identityFirst,
    ...(routeCount === 0 ? {} : { routes: value.routes!.slice(0, routeCount) }),
    ...(noConnectCount === 0 ? {} : { noConnects: value.noConnects!.slice(0, noConnectCount) }),
    ...(connectivityCount === 0 ? {} : { connectivity: value.connectivity!.slice(0, connectivityCount) }),
    issues: issues.slice(0, issueCount),
    issueEvidence: { total: issueTotal, returned: issueCount, truncated: issueTotal > issueCount },
    ...(blockingTotal === 0 ? {} : {
      blockingEdges: uniqueBlockingEdges.slice(0, blockingCount),
      blockingEdgeEvidence: { total: blockingTotal, returned: blockingCount, truncated: blockingTotal > blockingCount },
    }),
  });
  let serialized = build();
  while ((serialized.length > FRESH_PROVIDER_RESULT_MAX_CHARS || Buffer.byteLength(serialized, "utf8") > FRESH_PROVIDER_RESULT_MAX_CHARS)
    && (blockingCount > 0 || connectivityCount > 0 || routeCount > 0 || noConnectCount > 0 || issueCount > minimumIssues)) {
    if (blockingCount > 0) blockingCount -= 1;
    else if (connectivityCount > 0) connectivityCount -= 1;
    else if (routeCount > 0) routeCount -= 1;
    else if (noConnectCount > 0) noConnectCount -= 1;
    else issueCount -= 1;
    serialized = build();
  }
  if (serialized.length > FRESH_PROVIDER_RESULT_MAX_CHARS || Buffer.byteLength(serialized, "utf8") > FRESH_PROVIDER_RESULT_MAX_CHARS) {
    throw new Error("Fresh connectivity result identity and minimum issue evidence exceed the provider-safe serialized budget.");
  }
  return serialized;
}

function contractResult(
  call: HarnessToolCall,
  contract: FreshConnectivityContract,
  value: FreshContractConnectivityResultFields,
): HarnessToolResult {
  return harnessToolResultSchema.parse({
    toolCallId: call.id,
    content: serializeFreshContractConnectivityResult(contract, value),
  });
}

interface FreshRecommendedPlacementResultFields {
  readonly applied: boolean;
  readonly mutated: boolean;
  readonly idempotent: false;
  readonly issues: readonly FreshConnectivityIssue[];
}

function recommendedPlacementResult(
  call: HarnessToolCall,
  contract: FreshConnectivityContract,
  recommendationIdentity: ReturnType<typeof canonicalIdentity>,
  value: FreshRecommendedPlacementResultFields,
): HarnessToolResult {
  return harnessToolResultSchema.parse({
    toolCallId: call.id,
    content: JSON.stringify({
      schemaVersion: "evleda.fresh-recommended-schematic-placement-result.v1",
      contractIdentity: contract.identity,
      recommendationIdentity,
      ...value,
    }),
  });
}

/** Deterministic minimum-length tree; the sidecar still owns actual wire geometry. */
function netTree(
  endpoints: readonly FreshConnectivityEndpoint[],
  pins: ReadonlyMap<string, FreshPoint>,
  work: FreshPlanningWork,
): readonly (readonly [FreshConnectivityEndpoint, FreshConnectivityEndpoint])[] | null {
  if (endpoints.length < 2) return [];
  const ordered = [...endpoints].sort((left, right) => endpointId(left).localeCompare(endpointId(right), "en-US"));
  const joined = new Set([endpointId(ordered[0]!)]);
  const edges: (readonly [FreshConnectivityEndpoint, FreshConnectivityEndpoint])[] = [];
  type Edge = { left: FreshConnectivityEndpoint; right: FreshConnectivityEndpoint; distance: number; key: string };
  const bestByTarget = new Map<string, Edge>();
  let newest = ordered[0]!;
  // Cached Prim frontier: each newly joined vertex updates remaining targets
  // once, replacing the former cubic scan of the whole joined cross-product.
  while (joined.size < ordered.length) {
    for (const right of ordered) {
      if (!consumeSegmentCheck(work, "tree")) return null;
      const rightId = endpointId(right);
      if (joined.has(rightId)) continue;
      const distance = pointDistance(pins.get(endpointId(newest))!, pins.get(rightId)!);
      const key = `${endpointId(newest)}\u0000${rightId}`;
      const previous = bestByTarget.get(rightId);
      if (previous === undefined || distance < previous.distance || distance === previous.distance && key < previous.key) {
        bestByTarget.set(rightId, { left: newest, right, distance, key });
      }
    }
    let best: Edge | undefined;
    for (const candidate of bestByTarget.values()) {
      if (!consumeSegmentCheck(work, "tree")) return null;
      if (best === undefined || candidate.distance < best.distance || candidate.distance === best.distance && candidate.key < best.key) best = candidate;
    }
    if (best === undefined) throw new Error("Cannot construct the deterministic contract net tree.");
    edges.push([best.left, best.right]);
    joined.add(endpointId(best.right));
    bestByTarget.delete(endpointId(best.right));
    newest = best.right;
  }
  return edges;
}

interface PlannedWire extends FreshPoint {
  readonly endX: number;
  readonly endY: number;
  readonly net: string;
  readonly edgeEndpoints: readonly string[];
}
export interface FreshPlanningWork {
  segmentChecks: number;
  readonly maxSegmentChecks: number;
  exhausted: boolean;
  readonly budget: FreshSchematicWorkBudget;
}
export function createFreshSchematicPlanningWork(budget = new FreshSchematicWorkBudget()): FreshPlanningWork {
  return { segmentChecks: 0, maxSegmentChecks: budget.snapshot().maximum, exhausted: budget.snapshot().status === "exhausted", budget };
}
const consumeSegmentCheck = (work: FreshPlanningWork, kind: FreshSchematicWorkKind = "route"): boolean => {
  if (!work.budget.charge(kind)) { work.exhausted = true; return false; }
  if (kind !== "tree") work.segmentChecks += 1;
  return true;
};

const terminalMemberIndexes = new WeakMap<FreshSchematicTerminalPartition, ReadonlyMap<string, readonly string[]>>();
const terminalMembers = (id: string, partition: FreshSchematicTerminalPartition | undefined): readonly string[] => {
  if (partition === undefined) return [id];
  let index = terminalMemberIndexes.get(partition);
  if (index === undefined) {
    if (!Object.isFrozen(partition) || !Object.isFrozen(partition.groups)) throw new Error("Schematic planning requires an immutable source-bound terminal partition.");
    index = new Map(partition.groups.flatMap((group) => group.memberEndpointIds.map((member) => [member, group.memberEndpointIds] as const)));
    terminalMemberIndexes.set(partition, index);
  }
  return index.get(id) ?? [id];
};
const collapsedNetEndpoints = (endpoints: readonly FreshConnectivityEndpoint[], partition: FreshSchematicTerminalPartition | undefined): readonly FreshConnectivityEndpoint[] => {
  if (partition === undefined) return endpoints;
  const original = new Map(endpoints.map((endpoint) => [endpointId(endpoint), endpoint]));
  return endpoints.filter((endpoint) => {
    const representative = terminalMembers(endpointId(endpoint), partition)[0]!;
    if (!original.has(representative)) throw new Error("Source-proven terminal group crosses its exact contract net.");
    return representative === endpointId(endpoint);
  });
};

// Fresh project settings omit connection_grid_size and preserve KiCad 10.0.3's
// DEFAULT_CONNECTION_GRID_MILS = 50 (eeschema/schematic_settings.h). This is
// the schematic connection grid, independent of the PCB or placement grid.
const ROUTE_GRID_MM = 1.27;
const ROUTE_SEARCH_CHANNELS = 12;
const GEOMETRY_EPSILON_MM = 0.001;
const MAX_ENDPOINT_ESCAPE_DISTANCE_MM = 25;
export const FRESH_CONNECTIVITY_PLACEMENT_SEARCH = Object.freeze({
  schemaVersion: "evleda.fresh-connectivity-placement-search.v1" as const,
  gridMm: 2.54,
  workingBoundsMm: Object.freeze({ minX: 15.24, minY: 15.24, maxX: 279.4, maxY: 195.58 }),
  slotPitchMm: 25.4,
  rotationPolicy: "current-only" as const,
  maxComponents: 8,
  maxEndpoints: 64,
  maxCandidatesPerComponent: 64,
  maxTotalCandidates: 512,
  maxConfigurations: 2_048,
  maxStates: 100_000,
  maxPlanEvaluations: 2_048,
  maxSegmentChecks: 20_000_000,
});
const MAX_RETURNED_FRESH_CONNECTIVITY_ISSUES = 128;
const MAX_RETURNED_FRESH_BLOCKING_EDGES = 64;
const samePoint = (left: FreshPoint, right: FreshPoint): boolean => pointDistance(left, right) <= GEOMETRY_EPSILON_MM;
const wireStart = (wire: PlannedWire): FreshPoint => ({ x: wire.x, y: wire.y });
const wireEnd = (wire: PlannedWire): FreshPoint => ({ x: wire.endX, y: wire.endY });

function outwardRouteGridCoordinate(value: number, direction: -1 | 1): number {
  const units = value / ROUTE_GRID_MM;
  const nearest = Math.round(units);
  // Arithmetic on decimal bounds can put an exact grid line a few floating
  // point bits outside itself. Stabilize only that noise before floor/ceil.
  const stableUnits = Math.abs(units - nearest) <= Number.EPSILON * Math.max(1, Math.abs(units)) * 4 ? nearest : units;
  return roundedCoordinate((direction === -1 ? Math.floor(stableUnits) : Math.ceil(stableUnits)) * ROUTE_GRID_MM);
}

export function freshEndpointEscape(
  pin: FreshPoint & { readonly angleDeg: 0 | 90 | 180 | 270 },
  box: FreshBoundingBox,
): FreshPoint | null {
  const escape = pin.angleDeg === 0
    ? { x: outwardRouteGridCoordinate(box.minX - BOUNDING_BOX_ROUNDING_MARGIN_MM, -1), y: pin.y }
    : pin.angleDeg === 90
      ? { x: pin.x, y: outwardRouteGridCoordinate(box.maxY + BOUNDING_BOX_ROUNDING_MARGIN_MM, 1) }
      : pin.angleDeg === 180
        ? { x: outwardRouteGridCoordinate(box.maxX + BOUNDING_BOX_ROUNDING_MARGIN_MM, 1), y: pin.y }
        : { x: pin.x, y: outwardRouteGridCoordinate(box.minY - BOUNDING_BOX_ROUNDING_MARGIN_MM, -1) };
  const distance = pointDistance(pin, escape);
  if (!Number.isFinite(distance) || distance > MAX_ENDPOINT_ESCAPE_DISTANCE_MM) return null;
  return escape;
}

export function freshAbsolutePinAngle(
  localAngle: 0 | 90 | 180 | 270,
  placementRotation: number,
): 0 | 90 | 180 | 270 | null {
  const value = (localAngle - placementRotation + 360) % 360;
  return value === 0 || value === 90 || value === 180 || value === 270 ? value : null;
}

/** Reserve approximate presentation space before electrical mutations; never native visual evidence. */
export function planFreshGlobalLabelTerminals(
  contract: FreshConnectivityContract,
  pins: ReadonlyMap<string, FreshPoint & { readonly angleDeg: 0 | 90 | 180 | 270 }>,
  boxes: readonly FreshBoundingBox[],
  work = createFreshSchematicPlanningWork(),
  partition?: FreshSchematicTerminalPartition,
): Readonly<{ labels: readonly FreshPlannedGlobalLabel[]; issues: readonly FreshConnectivityIssue[] }> {
  const labels: FreshPlannedGlobalLabel[] = [];
  const stubs: PlannedWire[] = [];
  const issues: FreshConnectivityIssue[] = [];
  const within = (point: FreshPoint, box: Omit<FreshBoundingBox, "reference">): boolean => point.x > box.minX && point.x < box.maxX && point.y > box.minY && point.y < box.maxY;
  for (const net of contract.nets) {
    const endpoint = net.endpoints[0]!;
    const id = endpointId(endpoint);
    const allowedPins = new Set(terminalMembers(id, partition));
    const pin = pins.get(id);
    const box = boxes.find((entry) => entry.reference === endpoint.reference);
    const escape = pin === undefined || box === undefined ? null : freshEndpointEscape(pin, box);
    let selected: FreshPlannedGlobalLabel | undefined;
    if (pin !== undefined && escape !== null) {
      const orientation = freshGlobalLabelOrientation(pin.angleDeg);
      const dx = pin.angleDeg === 0 ? -1 : pin.angleDeg === 180 ? 1 : 0;
      const dy = pin.angleDeg === 90 ? 1 : pin.angleDeg === 270 ? -1 : 0;
      const initialDistance = Math.max(5.08, pointDistance(pin, escape));
      for (let distance = initialDistance; distance <= MAX_ENDPOINT_ESCAPE_DISTANCE_MM; distance += ROUTE_GRID_MM) {
        if (work.exhausted) break;
        const at = { x: roundedCoordinate(pin.x + dx * distance), y: roundedCoordinate(pin.y + dy * distance) };
        // The writer snaps labels to the same 50 mil native connection grid.
        if ([at.x, at.y].some((value) => Math.abs(value / ROUTE_GRID_MM - Math.round(value / ROUTE_GRID_MM)) > 1e-7)) continue;
        const bounds = approximateFreshGlobalLabelBounds(net.name, at, orientation.rotationDeg);
        if (bounds === null) break;
        const sheet = FRESH_CONNECTIVITY_PLACEMENT_SEARCH.workingBoundsMm;
        if (bounds.minX < sheet.minX || bounds.minY < sheet.minY || bounds.maxX > sheet.maxX || bounds.maxY > sheet.maxY) continue;
        const labelBox = { reference: id, ...bounds };
        const stub: PlannedWire = { x: pin.x, y: pin.y, endX: at.x, endY: at.y, net: net.name, edgeEndpoints: [id] };
        if (boxes.some((other) => !consumeSegmentCheck(work, "label") || boxesConflict(labelBox, other)
          || other.reference !== endpoint.reference && wireEntersBox(stub, other))) continue;
        if ([...pins].some(([otherId, other]) => !consumeSegmentCheck(work, "label") || !allowedPins.has(otherId) && (within(other, bounds) || pointOnWire(other, stub)))) continue;
        if (labels.some((other) => !consumeSegmentCheck(work, "label") || boxesConflict(labelBox, { reference: other.endpointId, ...other.bounds })
          || wireEntersBox(stub, { reference: other.endpointId, ...other.bounds }))) continue;
        if (stubs.some((other) => !consumeSegmentCheck(work, "label") || wireConflicts(stub, other) || wireEntersBox(other, labelBox))) continue;
        selected = { name: net.name, endpointId: id, at, ...orientation, fontMm: 1.524, bounds };
        stubs.push(stub);
        break;
      }
    }
    if (selected === undefined) issues.push({
      code: "LABEL_PLANNING_SPACE_UNAVAILABLE",
      message: `No bounded on-grid outward terminal for ${net.name} can reserve the approximate label envelope without colliding with known symbols, pins, or other terminals.`,
      remediation: "Keep connectivity unmodified and use a complete host placement recommendation; approximate planning space is not native rendered-clearance evidence.",
      endpoints: [id],
    });
    else labels.push(selected);
  }
  if (work.exhausted) return Object.freeze({ labels: Object.freeze([]), issues: Object.freeze([{
    code: "PLANNING_WORK_LIMIT", message: `Global label planning exhausted its aggregate work budget: ${canonicalJson(work.budget.snapshot())}`,
    remediation: "Keep connectivity unchanged; an incomplete label plan cannot authorize mutation.",
  }]) });
  return Object.freeze({ labels: Object.freeze(labels), issues: Object.freeze(issues) });
}

function pointOnWire(point: FreshPoint, wire: PlannedWire): boolean {
  if (Math.abs(wire.x - wire.endX) <= GEOMETRY_EPSILON_MM) {
    return Math.abs(point.x - wire.x) <= GEOMETRY_EPSILON_MM
      && point.y >= Math.min(wire.y, wire.endY) - GEOMETRY_EPSILON_MM
      && point.y <= Math.max(wire.y, wire.endY) + GEOMETRY_EPSILON_MM;
  }
  return Math.abs(point.y - wire.endY) <= GEOMETRY_EPSILON_MM
    && point.x >= Math.min(wire.x, wire.endX) - GEOMETRY_EPSILON_MM
    && point.x <= Math.max(wire.x, wire.endX) + GEOMETRY_EPSILON_MM;
}

function wireConflicts(left: PlannedWire, right: PlannedWire): boolean {
  const leftVertical = Math.abs(left.x - left.endX) <= GEOMETRY_EPSILON_MM;
  const rightVertical = Math.abs(right.x - right.endX) <= GEOMETRY_EPSILON_MM;
  const allowedShared = (point: FreshPoint): boolean => left.net === right.net
    && [wireStart(left), wireEnd(left)].some((endpoint) => samePoint(endpoint, point))
    && [wireStart(right), wireEnd(right)].some((endpoint) => samePoint(endpoint, point));
  if (leftVertical === rightVertical) {
    const sameAxis = leftVertical
      ? Math.abs(left.x - right.x) <= GEOMETRY_EPSILON_MM
      : Math.abs(left.y - right.y) <= GEOMETRY_EPSILON_MM;
    if (!sameAxis) return false;
    const leftLow = leftVertical ? Math.min(left.y, left.endY) : Math.min(left.x, left.endX);
    const leftHigh = leftVertical ? Math.max(left.y, left.endY) : Math.max(left.x, left.endX);
    const rightLow = rightVertical ? Math.min(right.y, right.endY) : Math.min(right.x, right.endX);
    const rightHigh = rightVertical ? Math.max(right.y, right.endY) : Math.max(right.x, right.endX);
    const low = Math.max(leftLow, rightLow);
    const high = Math.min(leftHigh, rightHigh);
    if (high < low - GEOMETRY_EPSILON_MM) return false;
    if (Math.abs(high - low) > GEOMETRY_EPSILON_MM) return true;
    const point = leftVertical ? { x: left.x, y: low } : { x: low, y: left.y };
    return !allowedShared(point);
  }
  const vertical = leftVertical ? left : right;
  const horizontal = leftVertical ? right : left;
  const point = { x: vertical.x, y: horizontal.y };
  if (!pointOnWire(point, vertical) || !pointOnWire(point, horizontal)) return false;
  return !allowedShared(point);
}

export const freshSameNetWire = (
  left: Pick<PlannedWire, "x" | "y" | "endX" | "endY" | "net">,
  right: Pick<PlannedWire, "x" | "y" | "endX" | "endY" | "net">,
): boolean => left.net === right.net && plannedWireKey(left) === plannedWireKey(right);

function wireEntersBox(wire: PlannedWire, box: FreshBoundingBox): boolean {
  if (Math.abs(wire.x - wire.endX) <= GEOMETRY_EPSILON_MM) {
    if (!(box.minX + GEOMETRY_EPSILON_MM < wire.x && wire.x < box.maxX - GEOMETRY_EPSILON_MM)) return false;
    return Math.max(Math.min(wire.y, wire.endY), box.minY + GEOMETRY_EPSILON_MM)
      < Math.min(Math.max(wire.y, wire.endY), box.maxY - GEOMETRY_EPSILON_MM);
  }
  if (!(box.minY + GEOMETRY_EPSILON_MM < wire.y && wire.y < box.maxY - GEOMETRY_EPSILON_MM)) return false;
  return Math.max(Math.min(wire.x, wire.endX), box.minX + GEOMETRY_EPSILON_MM)
    < Math.min(Math.max(wire.x, wire.endX), box.maxX - GEOMETRY_EPSILON_MM);
}

function pathWires(points: readonly FreshPoint[], net: string, endpoints: readonly FreshConnectivityEndpoint[]): readonly PlannedWire[] {
  const edgeEndpoints = endpoints.map((endpoint) => endpointId(endpoint));
  const coordinateEndpoints = [points[0]!, points.at(-1)!].map((point) => `${point.x.toFixed(4)},${point.y.toFixed(4)}`);
  return points.slice(1).flatMap((point, index) => {
    const previous = points[index]!;
    if (samePoint(previous, point)) return [];
    if (Math.abs(previous.x - point.x) > GEOMETRY_EPSILON_MM && Math.abs(previous.y - point.y) > GEOMETRY_EPSILON_MM) return [];
    return [{ x: previous.x, y: previous.y, endX: point.x, endY: point.y, net, edgeEndpoints: [...edgeEndpoints, ...coordinateEndpoints] }];
  });
}

function planWirePath(
  startEndpoint: FreshConnectivityEndpoint,
  endEndpoint: FreshConnectivityEndpoint,
  net: string,
  pins: ReadonlyMap<string, FreshPoint & { readonly angleDeg: 0 | 90 | 180 | 270 }>,
  boxes: readonly FreshBoundingBox[],
  previousWires: readonly PlannedWire[],
  work: FreshPlanningWork,
  labels: readonly FreshPlannedGlobalLabel[] = [],
  partition?: FreshSchematicTerminalPartition,
  obstacleChannels = false,
  reservedTerminalWires: readonly PlannedWire[] = [],
): readonly PlannedWire[] | null {
  const start = pins.get(endpointId(startEndpoint))!;
  const end = pins.get(endpointId(endEndpoint))!;
  const startBox = boxes.find((box) => box.reference === startEndpoint.reference);
  const endBox = boxes.find((box) => box.reference === endEndpoint.reference);
  if (startBox === undefined || endBox === undefined) return null;
  const startEscape = labels.find((label) => label.endpointId === endpointId(startEndpoint))?.at ?? freshEndpointEscape(start, startBox);
  const endEscape = labels.find((label) => label.endpointId === endpointId(endEndpoint))?.at ?? freshEndpointEscape(end, endBox);
  if (startEscape === null || endEscape === null) return null;
  const routingBounds = [...boxes, ...labels.map((label) => ({ reference: label.endpointId, ...label.bounds }))];
  const minimumX = outwardRouteGridCoordinate(Math.min(startEscape.x, endEscape.x, ...routingBounds.map((box) => box.minX)), -1);
  const maximumX = outwardRouteGridCoordinate(Math.max(startEscape.x, endEscape.x, ...routingBounds.map((box) => box.maxX)), 1);
  const minimumY = outwardRouteGridCoordinate(Math.min(startEscape.y, endEscape.y, ...routingBounds.map((box) => box.minY)), -1);
  const maximumY = outwardRouteGridCoordinate(Math.max(startEscape.y, endEscape.y, ...routingBounds.map((box) => box.maxY)), 1);
  const candidates: FreshPoint[][] = [];
  const candidate = (middle: readonly FreshPoint[]): FreshPoint[] => [start, startEscape, ...middle, endEscape, end];
  if (Math.abs(startEscape.x - endEscape.x) <= GEOMETRY_EPSILON_MM || Math.abs(startEscape.y - endEscape.y) <= GEOMETRY_EPSILON_MM) candidates.push(candidate([]));
  candidates.push(candidate([{ x: endEscape.x, y: startEscape.y }]), candidate([{ x: startEscape.x, y: endEscape.y }]));
  for (let index = 1; index <= ROUTE_SEARCH_CHANNELS; index += 1) {
    const offset = index * ROUTE_GRID_MM;
    const channelYs = [roundedCoordinate(minimumY - offset), roundedCoordinate(maximumY + offset)];
    const channelXs = [roundedCoordinate(minimumX - offset), roundedCoordinate(maximumX + offset)];
    for (const channelY of channelYs) candidates.push(candidate([{ x: startEscape.x, y: channelY }, { x: endEscape.x, y: channelY }]));
    for (const channelX of channelXs) candidates.push(candidate([{ x: channelX, y: startEscape.y }, { x: channelX, y: endEscape.y }]));
    for (const channelX of channelXs) for (const channelY of channelYs) {
      candidates.push(
        candidate([{ x: channelX, y: startEscape.y }, { x: channelX, y: channelY }, { x: endEscape.x, y: channelY }]),
        candidate([{ x: startEscape.x, y: channelY }, { x: channelX, y: channelY }, { x: channelX, y: endEscape.y }]),
      );
    }
  }
  if (obstacleChannels) {
    // The outer-union lanes cannot use gaps between staggered label envelopes.
    // Retry with at most the existing channel count per axis, on the same native
    // grid. All candidates still pass the exact same collision checks below.
    const channels = (axis: "x" | "y"): readonly number[] => {
      const low = axis === "x" ? "minX" : "minY";
      const high = axis === "x" ? "maxX" : "maxY";
      const values = routingBounds.flatMap((box) => [
        outwardRouteGridCoordinate(box[low] - BOUNDING_BOX_ROUNDING_MARGIN_MM, -1),
        outwardRouteGridCoordinate(box[high] + BOUNDING_BOX_ROUNDING_MARGIN_MM, 1),
      ]);
      const distance = (value: number): number => Math.abs(value - startEscape[axis]) + Math.abs(value - endEscape[axis]);
      return [...new Set(values)].sort((left, right) => distance(left) - distance(right) || left - right).slice(0, ROUTE_SEARCH_CHANNELS);
    };
    const channelXs = channels("x");
    const channelYs = channels("y");
    for (const channelY of channelYs) candidates.push(candidate([{ x: startEscape.x, y: channelY }, { x: endEscape.x, y: channelY }]));
    for (const channelX of channelXs) candidates.push(candidate([{ x: channelX, y: startEscape.y }, { x: channelX, y: endEscape.y }]));
    for (const channelX of channelXs) for (const channelY of channelYs) {
      candidates.push(
        candidate([{ x: channelX, y: startEscape.y }, { x: channelX, y: channelY }, { x: endEscape.x, y: channelY }]),
        candidate([{ x: startEscape.x, y: channelY }, { x: channelX, y: channelY }, { x: channelX, y: endEscape.y }]),
      );
    }
  }
  const allowedPins = new Set([...terminalMembers(endpointId(startEndpoint), partition), ...terminalMembers(endpointId(endEndpoint), partition)]);
  const endpointReferences = new Set([startEndpoint.reference, endEndpoint.reference]);
  const valid = candidates.flatMap((points) => {
    const wires = pathWires(points, net, [startEndpoint, endEndpoint]);
    if (wires.some((wire) => labels.some((label) => {
      if (!consumeSegmentCheck(work)) return true;
      return wireEntersBox(wire, { reference: label.endpointId, ...label.bounds });
    }))) return [];
    if (wires.some((wire) => reservedTerminalWires.some((reserved) => reserved.net !== net
      && (!consumeSegmentCheck(work) || wireConflicts(wire, reserved))))) return [];
    if (wires.length === 0 || wires.some((wire, wireIndex) => boxes.some((box) => {
      if (!consumeSegmentCheck(work)) return true;
      if ((wireIndex === 0 && box.reference === startEndpoint.reference) || (wireIndex === wires.length - 1 && box.reference === endEndpoint.reference)) return false;
      return wireEntersBox(wire, endpointReferences.has(box.reference) ? box : {
      ...box,
      minX: box.minX - BOUNDING_BOX_ROUNDING_MARGIN_MM,
      minY: box.minY - BOUNDING_BOX_ROUNDING_MARGIN_MM,
      maxX: box.maxX + BOUNDING_BOX_ROUNDING_MARGIN_MM,
      maxY: box.maxY + BOUNDING_BOX_ROUNDING_MARGIN_MM,
      });
    }))) return [];
    for (const [id, pin] of pins) if (!allowedPins.has(id) && wires.some((wire) => consumeSegmentCheck(work) ? pointOnWire(pin, wire) : true)) return [];
    for (let index = 0; index < wires.length; index += 1) {
      for (let other = index + 2; other < wires.length; other += 1) if (!consumeSegmentCheck(work) || wireConflicts(wires[index]!, wires[other]!)) return [];
    }
    if (wires.some((wire) => previousWires.some((previous) => !freshSameNetWire(wire, previous) && (!consumeSegmentCheck(work) || wireConflicts(wire, previous))))) return [];
    const novelWires = wires.filter((wire) => !previousWires.some((previous) => freshSameNetWire(wire, previous)));
    if (novelWires.length === 0) return [];
    return [{ wires: novelWires, length: novelWires.reduce((total, wire) => total + Math.abs(wire.endX - wire.x) + Math.abs(wire.endY - wire.y), 0), signature: JSON.stringify(points) }];
  }).sort((left, right) => left.length - right.length || left.wires.length - right.wires.length || left.signature.localeCompare(right.signature, "en-US"));
  return valid[0]?.wires ?? null;
}

function planContractWires(
  contract: FreshConnectivityContract,
  pins: ReadonlyMap<string, FreshPoint & { readonly angleDeg: 0 | 90 | 180 | 270 }>,
  boxes: readonly FreshBoundingBox[],
  work = createFreshSchematicPlanningWork(),
  labels: readonly FreshPlannedGlobalLabel[] = [],
  partition?: FreshSchematicTerminalPartition,
  obstacleChannels = false,
): { readonly wires: readonly PlannedWire[]; readonly routes: readonly string[]; readonly issues: readonly FreshConnectivityIssue[] } {
  const wires: PlannedWire[] = [];
  const routes: string[] = [];
  const issues: FreshConnectivityIssue[] = [];
  const reservedTerminalWires: PlannedWire[] = [];
  if (obstacleChannels) for (const net of contract.nets) for (const endpoint of collapsedNetEndpoints(net.endpoints, partition)) {
    const id = endpointId(endpoint);
    const pin = pins.get(id)!;
    const box = boxes.find((candidate) => candidate.reference === endpoint.reference);
    const escape = labels.find((label) => label.endpointId === id)?.at ?? (box === undefined ? null : freshEndpointEscape(pin, box));
    if (escape !== null) reservedTerminalWires.push(...pathWires([pin, escape], net.name, [endpoint]));
  }
  for (const net of contract.nets) {
    const endpoints = collapsedNetEndpoints(net.endpoints, partition);
    const edges = netTree(endpoints, pins, work);
    if (edges === null || work.exhausted) return { wires: [], routes: [], issues: [{
      code: "PLANNING_WORK_LIMIT", message: `Net-tree planning exhausted its aggregate work budget: ${canonicalJson(work.budget.snapshot())}`,
      remediation: "Keep connectivity unchanged; no partial wire plan is executable.",
    }] };
    if (endpoints.length === 1) {
      const label = labels.find((candidate) => terminalMembers(candidate.endpointId, partition).includes(endpointId(endpoints[0]!)));
      const pin = pins.get(endpointId(endpoints[0]!))!;
      if (label !== undefined && !samePoint(pin, label.at)) wires.push(...pathWires([pin, label.at], net.name, endpoints));
    }
    for (const [left, right] of edges) {
    const planned = planWirePath(left, right, net.name, pins, boxes, wires, work, labels, partition, obstacleChannels, reservedTerminalWires);
    if (planned === null || work.exhausted) {
      issues.push({
        code: work.exhausted ? "PLANNING_WORK_LIMIT" : "NO_PROVEN_COLLISION_FREE_WIRE_PLAN",
        message: work.exhausted
          ? `Deterministic segment-check budget was exhausted while planning ${net.name} ${endpointId(left)}-${endpointId(right)}.`
          : `No bounded orthogonal route for ${net.name} ${endpointId(left)}-${endpointId(right)} avoids symbol bodies, unrelated pins, prior wires, overlaps, and non-junction crossings.`,
        remediation: "Apply the complete host-recommended move set when provided, then retry before any connectivity mutation.",
        endpoints: [endpointId(left), endpointId(right)],
      });
      if (work.exhausted) return { wires: [], routes: [], issues };
      continue;
    }
    wires.push(...planned);
    routes.push(`${endpointId(left)}-${endpointId(right)}`);
    }
  }
  return { wires, routes, issues };
}

/** Complete label reservations and the original contract tree share one budget. */
function planFreshContractGeometry(
  contract: FreshConnectivityContract,
  pins: ReadonlyMap<string, FreshPoint & { readonly angleDeg: 0 | 90 | 180 | 270 }>,
  boxes: readonly FreshBoundingBox[],
  work = createFreshSchematicPlanningWork(),
  globalLabels = false,
  partition?: FreshSchematicTerminalPartition,
): ReturnType<typeof planContractWires> & { readonly labels: readonly FreshPlannedGlobalLabel[] } {
  const attempt = (labelContract: FreshConnectivityContract, obstacleChannels: boolean) => {
    const labelPlan = globalLabels ? planFreshGlobalLabelTerminals(labelContract, pins, boxes, work, partition) : { labels: [], issues: [] };
    const plan = labelPlan.issues.length === 0 ? planContractWires(contract, pins, boxes, work, labelPlan.labels, partition, obstacleChannels)
      : { wires: [], routes: [], issues: labelPlan.issues };
    return { ...plan, labels: labelPlan.labels };
  };
  const initial = attempt(contract, false);
  if (initial.issues.length === 0 || !globalLabels || work.exhausted) return initial;
  // Preserve successful legacy plans. One local-channel retry respects every
  // reserved terminal stub, including terminals of nets not routed yet.
  const local = initial.labels.length === contract.nets.length
    ? { ...planContractWires(contract, pins, boxes, work, initial.labels, partition, true), labels: initial.labels } : initial;
  if (local.issues.length === 0 || work.exhausted) return local;
  // On one symbol face, reserve outer pins first so the middle label can sit
  // beyond their stubs instead of being enclosed by them. This changes only
  // reservation order: the original net tree and endpoint identities stay fixed.
  const groups = new Map<string, typeof contract.nets[number][]>();
  for (const net of contract.nets) {
    const endpoint = net.endpoints[0]!;
    const pin = pins.get(endpointId(endpoint));
    if (pin === undefined) return initial;
    const key = `${endpoint.reference}:${pin.angleDeg}`;
    const group = groups.get(key) ?? [];
    group.push(net);
    groups.set(key, group);
  }
  const nets = [...groups.values()].flatMap((group) => {
    const transverse = (net: typeof contract.nets[number]): number => {
      const pin = pins.get(endpointId(net.endpoints[0]!))!;
      return pin.angleDeg === 0 || pin.angleDeg === 180 ? pin.y : pin.x;
    };
    const values = group.map(transverse);
    const middle = (Math.min(...values) + Math.max(...values)) / 2;
    return [...group].sort((left, right) => Math.abs(transverse(right) - middle) - Math.abs(transverse(left) - middle)
      || left.name.localeCompare(right.name, "en-US"));
  });
  if (nets.every((net, index) => net === contract.nets[index])) return initial;
  const retry = attempt({ ...contract, nets }, true);
  return retry.issues.length === 0 || work.exhausted ? retry : initial;
}

export function inspectFreshConnectivityWirePlan(
  contract: FreshConnectivityContract,
  pins: ReadonlyMap<string, FreshPoint & { readonly angleDeg: 0 | 90 | 180 | 270 }>,
  boxes: readonly FreshBoundingBox[],
  globalLabels = false,
  partition?: FreshSchematicTerminalPartition,
  budget = new FreshSchematicWorkBudget(),
): Readonly<{ readonly routes: readonly string[]; readonly wireCount: number; readonly wireLengthMm: number; readonly wires: readonly PlannedWire[]; readonly labels: readonly FreshPlannedGlobalLabel[]; readonly issues: readonly FreshConnectivityIssue[] }> {
  const work = createFreshSchematicPlanningWork(budget);
  const plan = planFreshContractGeometry(contract, pins, boxes, work, globalLabels, partition);
  return Object.freeze({
    routes: Object.freeze([...plan.routes]), wireCount: plan.wires.length,
    labels: Object.freeze(plan.labels.map((label) => Object.freeze({ ...label, at: Object.freeze({ ...label.at }), bounds: Object.freeze({ ...label.bounds }) }))),
    wires: Object.freeze(plan.wires.map((wire) => Object.freeze({ ...wire, edgeEndpoints: Object.freeze([...wire.edgeEndpoints]) }))),
    wireLengthMm: plan.wires.reduce((total, wire) => total + Math.abs(wire.endX - wire.x) + Math.abs(wire.endY - wire.y), 0),
    issues: Object.freeze([...plan.issues].sort(issueOrder)),
  });
}

export interface FreshConnectivityRecommendedMove {
  readonly reference: string;
  readonly xMm: number;
  readonly yMm: number;
  readonly rotationDeg: 0 | 90 | 180 | 270;
}

export type FreshPlacementSearchExhaustionReason =
  | "none"
  | "component-limit"
  | "endpoint-limit"
  | "candidate-limit"
  | "state-limit"
  | "configuration-limit"
  | "plan-evaluation-limit"
  | "segment-check-limit"
  | "no-solution";

export interface FreshConnectivityPlacementSearchResult {
  readonly status: "found" | "exhausted" | "unsupported";
  readonly recommendedMoves: readonly FreshConnectivityRecommendedMove[];
  readonly recommendationIdentity?: ReturnType<typeof canonicalIdentity>;
  readonly startingPlacementIdentity: ReturnType<typeof canonicalIdentity>;
  readonly startingSchematicSha256: string;
  readonly targetPlacementIdentity?: ReturnType<typeof canonicalIdentity>;
  readonly targetPlacements: readonly FreshConnectivityRecommendedMove[];
  readonly configurationsEvaluated: number;
  readonly statesVisited: number;
  readonly planEvaluations: number;
  readonly segmentChecks: number;
  readonly candidateCount: number;
  readonly exhaustionReason: FreshPlacementSearchExhaustionReason;
  readonly blockingEdgeTotal: number;
  readonly blockingEdges: readonly { readonly net: string; readonly endpoints: readonly [string, string] }[];
}

interface FreshPlacementCandidate {
  readonly placement: FreshPlacement;
  readonly box: FreshBoundingBox;
  readonly pins: ReadonlyMap<string, FreshPoint & { readonly angleDeg: 0 | 90 | 180 | 270 }>;
}

const roundedCoordinate = (value: number): number => Math.round(value * 10_000) / 10_000;
const cardinalRotations = [0, 90, 180, 270] as const;

function rotateAround(point: FreshPoint, center: FreshPoint, degrees: number, target: FreshPoint): FreshPoint {
  const radians = degrees * Math.PI / 180;
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: roundedCoordinate(target.x + dx * Math.cos(radians) - dy * Math.sin(radians)),
    y: roundedCoordinate(target.y + dx * Math.sin(radians) + dy * Math.cos(radians)),
  };
}

function placementCandidate(
  current: FreshPlacement,
  currentBox: FreshBoundingBox,
  currentPins: ReadonlyMap<string, FreshPoint & { readonly angleDeg: 0 | 90 | 180 | 270 }>,
  x: number,
  y: number,
  rotation: 0 | 90 | 180 | 270,
): FreshPlacementCandidate | null {
  const delta = rotation - current.rotation;
  const center = { x: current.x, y: current.y };
  const target = { x, y };
  const corners = [
    { x: currentBox.minX, y: currentBox.minY }, { x: currentBox.minX, y: currentBox.maxY },
    { x: currentBox.maxX, y: currentBox.minY }, { x: currentBox.maxX, y: currentBox.maxY },
  ].map((point) => rotateAround(point, center, delta, target));
  const box: FreshBoundingBox = {
    reference: current.reference,
    minX: Math.min(...corners.map((point) => point.x)), minY: Math.min(...corners.map((point) => point.y)),
    maxX: Math.max(...corners.map((point) => point.x)), maxY: Math.max(...corners.map((point) => point.y)),
  };
  const bounds = FRESH_CONNECTIVITY_PLACEMENT_SEARCH.workingBoundsMm;
  if (box.minX < bounds.minX || box.minY < bounds.minY || box.maxX > bounds.maxX || box.maxY > bounds.maxY) return null;
  const pins = new Map<string, FreshPoint & { readonly angleDeg: 0 | 90 | 180 | 270 }>();
  for (const [id, pin] of currentPins) {
    const position = rotateAround(pin, center, delta, target);
    const angleDeg = freshAbsolutePinAngle(pin.angleDeg, delta);
    if (angleDeg === null) return null;
    pins.set(id, { ...position, angleDeg });
  }
  return {
    placement: { ...current, x, y, rotation }, box, pins,
  };
}

function boxesConflict(left: FreshBoundingBox, right: FreshBoundingBox): boolean {
  const margin = BOUNDING_BOX_ROUNDING_MARGIN_MM;
  return Math.min(left.maxX + margin, right.maxX + margin) - Math.max(left.minX - margin, right.minX - margin) > GEOMETRY_EPSILON_MM
    && Math.min(left.maxY + margin, right.maxY + margin) - Math.max(left.minY - margin, right.minY - margin) > GEOMETRY_EPSILON_MM;
}

function candidatesConflict(left: FreshPlacementCandidate, right: FreshPlacementCandidate, work: FreshPlanningWork): boolean {
  if (!consumeSegmentCheck(work, "placement")) return true;
  if (boxesConflict(left.box, right.box)) return true;
  return [...left.pins.values()].some((leftPin) => [...right.pins.values()].some((rightPin) => !consumeSegmentCheck(work, "placement") || samePoint(leftPin, rightPin)));
}

const issueOrder = (left: FreshConnectivityIssue, right: FreshConnectivityIssue): number => {
  const leftKey = `${left.code}\u0000${(left.endpoints ?? []).join("\u0000")}\u0000${left.message}`;
  const rightKey = `${right.code}\u0000${(right.endpoints ?? []).join("\u0000")}\u0000${right.message}`;
  return leftKey.localeCompare(rightKey, "en-US");
};

function freshPlacementStateIdentity(
  placements: ReadonlyMap<string, FreshPlacement>,
  boxes: readonly FreshBoundingBox[],
  pins: ReadonlyMap<string, FreshPoint & { readonly angleDeg: 0 | 90 | 180 | 270 }>,
): ReturnType<typeof canonicalIdentity> {
  const payload = {
    schemaVersion: "evleda.fresh-schematic-placement-state.v1",
    placements: [...placements.values()].map((placement) => ({ ...placement })).sort((left, right) => left.reference.localeCompare(right.reference, "en-US")),
    boxes: boxes.map((box) => ({ ...box })).sort((left, right) => left.reference.localeCompare(right.reference, "en-US")),
    pins: [...pins].map(([id, pin]) => ({ id, ...pin })).sort((left, right) => left.id.localeCompare(right.id, "en-US")),
  };
  return canonicalIdentity(payload, payload.schemaVersion);
}

/** Pure bounded placement search; it never calls or mutates KiCad. */
export function searchFreshConnectivityPlacement(
  contract: FreshConnectivityContract,
  placements: ReadonlyMap<string, FreshPlacement>,
  boxes: readonly FreshBoundingBox[],
  pins: ReadonlyMap<string, FreshPoint & { readonly angleDeg: 0 | 90 | 180 | 270 }>,
  governedSchematicSha256?: string,
  globalLabels = false,
  partition?: FreshSchematicTerminalPartition,
  sharedWork = createFreshSchematicPlanningWork(),
): FreshConnectivityPlacementSearchResult {
  const startingPlacementIdentity = freshPlacementStateIdentity(placements, boxes, pins);
  const startingSchematicSha256 = governedSchematicSha256 ?? startingPlacementIdentity.digest;
  if (!/^[a-f0-9]{64}$/u.test(startingSchematicSha256)) throw new Error("Governed schematic identity must be a lowercase SHA-256 digest.");
  const references = contract.components.map((component) => component.reference).sort((left, right) => left.localeCompare(right, "en-US"));
  const contractEndpointIds = [...contract.nets.flatMap((net) => net.endpoints), ...contract.noConnects].map(endpointId);
  const endpointCount = contractEndpointIds.length;
  const empty = (status: "unsupported" | "exhausted", exhaustionReason: FreshPlacementSearchExhaustionReason, overrides: Partial<FreshConnectivityPlacementSearchResult> = {}): FreshConnectivityPlacementSearchResult => ({
    status,
    recommendedMoves: [],
    startingPlacementIdentity,
    startingSchematicSha256,
    targetPlacements: [],
    configurationsEvaluated: 0,
    statesVisited: 0,
    planEvaluations: 0,
    segmentChecks: 0,
    candidateCount: 0,
    exhaustionReason,
    blockingEdgeTotal: 0,
    blockingEdges: [],
    ...overrides,
  });
  if (references.length > FRESH_CONNECTIVITY_PLACEMENT_SEARCH.maxComponents) return empty("unsupported", "component-limit");
  if (endpointCount > FRESH_CONNECTIVITY_PLACEMENT_SEARCH.maxEndpoints) return empty("unsupported", "endpoint-limit");
  if (new Set(references).size !== references.length || new Set(contractEndpointIds).size !== contractEndpointIds.length || contractEndpointIds.some((id) => !pins.has(id))) {
    return empty("unsupported", "no-solution");
  }
  const candidateSets = new Map<string, readonly FreshPlacementCandidate[]>();
  const slotXs: number[] = [];
  const slotYs: number[] = [];
  const bounds = FRESH_CONNECTIVITY_PLACEMENT_SEARCH.workingBoundsMm;
  for (let x = 25.4; x <= bounds.maxX - 25.4 + GEOMETRY_EPSILON_MM; x += FRESH_CONNECTIVITY_PLACEMENT_SEARCH.slotPitchMm) slotXs.push(roundedCoordinate(x));
  for (let y = 25.4; y <= bounds.maxY - 17.78 + GEOMETRY_EPSILON_MM; y += FRESH_CONNECTIVITY_PLACEMENT_SEARCH.slotPitchMm) slotYs.push(roundedCoordinate(y));
  for (const reference of references) {
    const placement = placements.get(reference);
    const box = boxes.find((candidate) => candidate.reference === reference);
    const referencePins = new Map([...pins].filter(([id]) => id.startsWith(`${reference}:`)));
    if (placement === undefined || box === undefined || referencePins.size === 0 || !cardinalRotations.includes(placement.rotation as never)) {
      return empty("unsupported", "no-solution");
    }
    const orderedSlots = slotXs.flatMap((x) => slotYs.map((y) => ({ x, y }))).sort((left, right) => {
      const leftDistance = Math.abs(left.x - placement.x) + Math.abs(left.y - placement.y);
      const rightDistance = Math.abs(right.x - placement.x) + Math.abs(right.y - placement.y);
      return leftDistance - rightDistance || left.x - right.x || left.y - right.y;
    });
    // sch_move_symbol has no rotation argument. Do not spend any bounded work
    // on states the atomic application surface cannot reproduce.
    const rotation = placement.rotation as 0 | 90 | 180 | 270;
    const unique = new Map<string, FreshPlacementCandidate>();
    for (const position of [{ x: placement.x, y: placement.y }, ...orderedSlots]) {
      if (!consumeSegmentCheck(sharedWork, "placement")) return empty("exhausted", "segment-check-limit", { segmentChecks: sharedWork.segmentChecks });
      if (unique.size >= FRESH_CONNECTIVITY_PLACEMENT_SEARCH.maxCandidatesPerComponent) break;
      const candidate = placementCandidate(placement, box, referencePins, position.x, position.y, rotation);
      if (candidate === null) continue;
      unique.set(`${position.x.toFixed(4)},${position.y.toFixed(4)},${rotation}`, candidate);
    }
    const ordered = [...unique.values()];
    if (ordered.length === 0) return empty("exhausted", "no-solution");
    candidateSets.set(reference, ordered);
    const totalCandidates = [...candidateSets.values()].reduce((total, candidates) => total + candidates.length, 0);
    if (totalCandidates > FRESH_CONNECTIVITY_PLACEMENT_SEARCH.maxTotalCandidates) {
      return empty("unsupported", "candidate-limit", { candidateCount: totalCandidates });
    }
  }
  const assigned = new Map<string, FreshPlacementCandidate>();
  let statesVisited = 0;
  let configurationsEvaluated = 0;
  let planEvaluations = 0;
  let exhaustionReason: FreshPlacementSearchExhaustionReason = "none";
  let solution: Map<string, FreshPlacementCandidate> | undefined;
  let solutionScore: readonly number[] | undefined;
  let solutionSignature: string | undefined;
  const blocking = new Map<string, { net: string; endpoints: readonly [string, string] }>();
  const blockingSeen = new Set<string>();
  const planningWork = sharedWork;
  const visit = (index: number): void => {
    if (exhaustionReason !== "none") return;
    if (!consumeSegmentCheck(planningWork, "placement")) { exhaustionReason = "segment-check-limit"; return; }
    if (statesVisited >= FRESH_CONNECTIVITY_PLACEMENT_SEARCH.maxStates) { exhaustionReason = "state-limit"; return; }
    statesVisited += 1;
    if (index === references.length) {
      if (configurationsEvaluated >= FRESH_CONNECTIVITY_PLACEMENT_SEARCH.maxConfigurations) { exhaustionReason = "configuration-limit"; return; }
      configurationsEvaluated += 1;
      if (planEvaluations >= FRESH_CONNECTIVITY_PLACEMENT_SEARCH.maxPlanEvaluations) { exhaustionReason = "plan-evaluation-limit"; return; }
      planEvaluations += 1;
      const candidatePlacements = new Map([...assigned].map(([reference, value]) => [reference, value.placement]));
      const candidateBoxes = [...assigned.values()].map((value) => value.box);
      const candidatePins = new Map([...assigned.values()].flatMap((value) => [...value.pins]));
      const wirePlan = planFreshContractGeometry(contract, candidatePins, candidateBoxes, planningWork, globalLabels, partition);
      for (const issue of wirePlan.issues) {
        const endpoints = issue.endpoints;
        if (endpoints?.length === 2) {
          const net = contract.nets.find((candidate) => candidate.endpoints.some((endpoint) => endpointId(endpoint) === endpoints[0]))?.name ?? "unknown";
          const key = `${net}\u0000${endpoints.join("\u0000")}`;
          if (!blockingSeen.has(key)) {
            blockingSeen.add(key);
            if (blocking.size < MAX_RETURNED_FRESH_BLOCKING_EDGES) blocking.set(key, { net, endpoints: [endpoints[0]!, endpoints[1]!] });
          }
        }
      }
      if (planningWork.exhausted) { exhaustionReason = "segment-check-limit"; return; }
      if (wirePlan.issues.length === 0) {
        // Compare complete, verified layouts, not the first individually-near
        // placement reached by DFS. These are bounded best-feasible results,
        // never a claim of globally optimal placement or routing.
        const width = Math.max(...candidateBoxes.map((box) => box.maxX)) - Math.min(...candidateBoxes.map((box) => box.minX));
        const height = Math.max(...candidateBoxes.map((box) => box.maxY)) - Math.min(...candidateBoxes.map((box) => box.minY));
        const score = [
          wirePlan.wires.reduce((total, wire) => total + Math.abs(wire.endX - wire.x) + Math.abs(wire.endY - wire.y), 0),
          width + height,
          width * height,
          wirePlan.wires.length,
          references.reduce((total, reference) => {
            const selected = candidatePlacements.get(reference)!;
            const original = placements.get(reference)!;
            return total + Math.abs(selected.x - original.x) + Math.abs(selected.y - original.y);
          }, 0),
        ].map(roundedCoordinate);
        const signature = canonicalJson(references.map((reference) => candidatePlacements.get(reference)!));
        const difference = solutionScore === undefined ? -1 : score.reduce((result, value, scoreIndex) => result || value - solutionScore![scoreIndex]!, 0);
        if (difference < 0 || difference === 0 && signature < solutionSignature!) {
          solution = new Map(assigned);
          solutionScore = score;
          solutionSignature = signature;
        }
      }
      return;
    }
    const reference = references[index]!;
    for (const candidate of candidateSets.get(reference) ?? []) {
      if ([...assigned.values()].some((existing) => candidatesConflict(candidate, existing, planningWork))) {
        if (planningWork.exhausted) { exhaustionReason = "segment-check-limit"; return; }
        continue;
      }
      assigned.set(reference, candidate);
      visit(index + 1);
      assigned.delete(reference);
      if (exhaustionReason !== "none") return;
    }
  };
  visit(0);
  const candidateCount = [...candidateSets.values()].reduce((total, candidates) => total + candidates.length, 0);
  if (solution === undefined) return {
    ...empty("exhausted", exhaustionReason === "none" ? "no-solution" : exhaustionReason),
    configurationsEvaluated, statesVisited, planEvaluations, segmentChecks: planningWork.segmentChecks, candidateCount,
    blockingEdgeTotal: blockingSeen.size,
    blockingEdges: [...blocking.values()],
  };
  const targetPlacements = references.map((reference): FreshConnectivityRecommendedMove => {
    const selected = solution!.get(reference)!.placement;
    return { reference, xMm: selected.x, yMm: selected.y, rotationDeg: selected.rotation as 0 | 90 | 180 | 270 };
  });
  const recommendedMoves = references.flatMap((reference): FreshConnectivityRecommendedMove[] => {
    const selected = solution!.get(reference)!.placement;
    const current = placements.get(reference)!;
    return selected.x === current.x && selected.y === current.y && selected.rotation === current.rotation ? [] : [{
      reference, xMm: selected.x, yMm: selected.y, rotationDeg: selected.rotation as 0 | 90 | 180 | 270,
    }];
  });
  if (recommendedMoves.length === 0) return {
    ...empty("exhausted", "no-solution"),
    configurationsEvaluated, statesVisited, planEvaluations, segmentChecks: planningWork.segmentChecks, candidateCount,
    blockingEdgeTotal: blockingSeen.size,
    blockingEdges: [...blocking.values()],
  };
  const targetPlacementMap = new Map([...solution].map(([reference, candidate]) => [reference, candidate.placement]));
  const targetBoxes = [...solution.values()].map((candidate) => candidate.box);
  const targetPins = new Map([...solution.values()].flatMap((candidate) => [...candidate.pins]));
  const targetPlacementIdentity = freshPlacementStateIdentity(targetPlacementMap, targetBoxes, targetPins);
  const identityPayload = {
    schemaVersion: "evleda.fresh-connectivity-placement-plan.v2",
    contractIdentity: contract.identity,
    startingPlacementIdentity,
    startingSchematicSha256,
    targetPlacementIdentity,
    targetPlacements,
    searchProfile: FRESH_CONNECTIVITY_PLACEMENT_SEARCH,
    recommendedMoves,
  };
  return {
    status: "found", recommendedMoves: Object.freeze(recommendedMoves),
    recommendationIdentity: canonicalIdentity(identityPayload, identityPayload.schemaVersion),
    startingPlacementIdentity,
    startingSchematicSha256,
    targetPlacementIdentity,
    targetPlacements: Object.freeze(targetPlacements),
    configurationsEvaluated, statesVisited, planEvaluations, segmentChecks: planningWork.segmentChecks, candidateCount,
    exhaustionReason: "none",
    blockingEdgeTotal: blockingSeen.size,
    blockingEdges: [...blocking.values()],
  };
}

function placementConvergenceFields(
  contract: FreshConnectivityContract,
  issuesInput: readonly FreshConnectivityIssue[],
  currentPlan: ReturnType<typeof planContractWires> | null,
  search: FreshConnectivityPlacementSearchResult,
  knownIssueTotal?: number,
): FreshContractConnectivityResultFields {
  const found = search.status === "found"
    && search.recommendedMoves.length > 0
    && search.recommendationIdentity !== undefined
    && search.targetPlacementIdentity !== undefined
    && search.targetPlacements.length === contract.components.length;
  const blockingEdges = [
    ...(currentPlan?.issues ?? []).flatMap((issue) => {
      const endpoints = issue.endpoints;
      if (endpoints?.length !== 2) return [];
      const net = contract.nets.find((candidate) => endpoints.every((id) => candidate.endpoints.some((endpoint) => endpointId(endpoint) === id)))?.name ?? "unknown";
      return [{ net, endpoints: [endpoints[0]!, endpoints[1]!] as const }];
    }),
    ...search.blockingEdges,
  ];
  const uniqueBlockingEdges = [...new Map(blockingEdges.map((edge) => [`${edge.net}\u0000${edge.endpoints.join("\u0000")}`, edge])).values()]
    .sort((left, right) => `${left.net}\u0000${left.endpoints.join("\u0000")}`.localeCompare(`${right.net}\u0000${right.endpoints.join("\u0000")}`, "en-US"))
    .slice(0, MAX_RETURNED_FRESH_BLOCKING_EDGES);
  const rawIssues = found ? issuesInput : [...issuesInput, {
    code: "PLACEMENT_SEARCH_EXHAUSTED",
    message: search.status === "unsupported"
      ? "Bounded placement recommendation is unsupported for the current geometry evidence."
      : `The bounded placement search did not find an actionable complete move set (${search.exhaustionReason}).`,
    remediation: "Keep connectivity unmodified and request host review with the complete blocking-edge evidence.",
  }];
  const uniqueIssueMap = new Map<string, FreshConnectivityIssue>();
  for (const issue of rawIssues) {
    const key = `${issue.code}\u0000${(issue.endpoints ?? []).join("\u0000")}\u0000${issue.message}\u0000${issue.remediation}\u0000${issue.atMm?.x ?? ""},${issue.atMm?.y ?? ""}`;
    if (!uniqueIssueMap.has(key)) uniqueIssueMap.set(key, issue);
  }
  const totalIssues = knownIssueTotal === undefined
    ? uniqueIssueMap.size
    : Math.max(uniqueIssueMap.size, knownIssueTotal + (found ? 0 : 1));
  const issues = [...uniqueIssueMap.values()].sort(issueOrder).slice(0, MAX_RETURNED_FRESH_CONNECTIVITY_ISSUES);
  return {
    applied: false, mutated: false, idempotent: false, issues,
    recommendedMoves: found ? search.recommendedMoves : [],
    ...(found ? {
      recommendationIdentity: search.recommendationIdentity,
      startingPlacementIdentity: search.startingPlacementIdentity,
      startingSchematicSha256: search.startingSchematicSha256,
      targetPlacementIdentity: search.targetPlacementIdentity,
      targetPlacements: search.targetPlacements,
    } : {}),
    recommendationInstruction: found
      ? "Call fresh_apply_recommended_schematic_placement once with only this exact recommendationIdentity. The host will apply and verify the complete move set atomically; do not call sch_move_symbol or substitute coordinates. Then call fresh_apply_contract_connectivity again."
      : "No complete recommendation is available; do not guess or partially move symbols.",
    searchEvidence: {
      schemaVersion: FRESH_CONNECTIVITY_PLACEMENT_SEARCH.schemaVersion,
      status: search.status,
          gridMm: FRESH_CONNECTIVITY_PLACEMENT_SEARCH.gridMm,
          slotPitchMm: FRESH_CONNECTIVITY_PLACEMENT_SEARCH.slotPitchMm,
      rotationPolicy: FRESH_CONNECTIVITY_PLACEMENT_SEARCH.rotationPolicy,
      workingBoundsMm: FRESH_CONNECTIVITY_PLACEMENT_SEARCH.workingBoundsMm,
      limits: {
        maxComponents: FRESH_CONNECTIVITY_PLACEMENT_SEARCH.maxComponents,
        maxEndpoints: FRESH_CONNECTIVITY_PLACEMENT_SEARCH.maxEndpoints,
        maxCandidatesPerComponent: FRESH_CONNECTIVITY_PLACEMENT_SEARCH.maxCandidatesPerComponent,
        maxTotalCandidates: FRESH_CONNECTIVITY_PLACEMENT_SEARCH.maxTotalCandidates,
        maxConfigurations: FRESH_CONNECTIVITY_PLACEMENT_SEARCH.maxConfigurations,
        maxStates: FRESH_CONNECTIVITY_PLACEMENT_SEARCH.maxStates,
        maxPlanEvaluations: FRESH_CONNECTIVITY_PLACEMENT_SEARCH.maxPlanEvaluations,
        maxSegmentChecks: FRESH_CONNECTIVITY_PLACEMENT_SEARCH.maxSegmentChecks,
      },
      configurationsEvaluated: search.configurationsEvaluated,
      statesVisited: search.statesVisited,
      planEvaluations: search.planEvaluations,
      segmentChecks: search.segmentChecks,
      candidateCount: search.candidateCount,
      exhaustionReason: search.exhaustionReason,
      blockingEdgeEvidence: {
        total: search.blockingEdgeTotal,
        returned: search.blockingEdges.length,
        truncated: search.blockingEdgeTotal > search.blockingEdges.length,
      },
    },
    issueEvidence: { total: totalIssues, returned: issues.length, truncated: totalIssues > issues.length },
    blockingEdges: uniqueBlockingEdges,
  };
}

const plannedWireKey = (wire: Pick<PlannedWire, "x" | "y" | "endX" | "endY">): string => {
  const first = `${wire.x.toFixed(4)},${wire.y.toFixed(4)}`;
  const second = `${wire.endX.toFixed(4)},${wire.endY.toFixed(4)}`;
  return first <= second ? `${first}|${second}` : `${second}|${first}`;
};

export function freshPersistedNoConnectsMatch(source: string, expectedPoints: readonly FreshPoint[]): boolean {
  const persisted = parseFreshSchematicSource(source);
  return persisted.noConnects.length === expectedPoints.length
    && expectedPoints.every((expected) => persisted.noConnects.some((actual) => pointDistance(expected, actual) <= 0.001));
}

interface FreshContractLabelAnchor {
  readonly name: string;
  readonly at: FreshPoint;
  readonly rotationDeg?: 0 | 90 | 180 | 270;
  readonly justify?: "left" | "right" | "top" | "bottom";
}

function exactFreshContractLabelsMatch(
  source: string,
  expected: readonly FreshContractLabelAnchor[],
  global: boolean,
): boolean {
  const schematic = parseFreshSchematicSource(source);
  if (global && !freshGlobalLabelInventoryMatches(schematic, expected.map((label) => label.name))) return false;
  if (global) {
    let presentation: ReturnType<typeof parseFreshSchematicPresentationSource>;
    try { presentation = parseFreshSchematicPresentationSource(source); }
    catch { return false; }
    if (presentation.labels.length !== expected.length || !expected.every((label) => {
      const matches = presentation.labels.filter((entry) => entry.name === label.name);
      if (matches.length !== 1) return false;
      const actual = matches[0]!;
      return actual.rotationDeg === label.rotationDeg && actual.justify?.length === 1 && actual.justify[0] === label.justify
        && actual.fontSizeMm?.x === 1.524 && actual.fontSizeMm.y === 1.524 && !actual.bold && !actual.italic && !actual.hidden;
    })) return false;
  }
  return schematic.labels.length === expected.length && expected.every((label) => {
    const matches = schematic.labels.filter((actual) => actual.name === label.name);
    return matches.length === 1 && samePoint(matches[0]!.at, label.at)
      && (global || (matches[0]!.kind === "local" && matches[0]!.shape === null));
  });
}

function assertFreshGenericSchematicSource(schematic: ReturnType<typeof parseFreshSchematicSource>): void {
  if (schematic.childSheetCount !== 0) {
    throw new Error("Fresh generic schematic violates the closed single-sheet contract: root child sheets are not permitted.");
  }
  if (!freshSchematicClassSourcesSupported(schematic)) {
    const sources = schematic.classSources;
    throw new Error(`Fresh generic schematic contains unsupported class sources or label metadata: Netclass fields=${sources.netclassPropertyCount}, other label fields=${sources.unsupportedLabelPropertyCount}, directives=${sources.directiveLabelCount}, rule areas=${sources.ruleAreaCount}. The authored-pattern model permits only intersheet-reference fields on global labels.`);
  }
}

/**
 * Converts the currently advertised, allowlisted MCP schemas into provider definitions.
 * This intentionally omits any sidecar capability not in the frozen reviewed name list.
 */
export function projectKicadHarnessToolDefinitions(
  session: Pick<KicadHarnessSession, "listTools"|"supportsPlaneStage"|"stagePlane"|"supportsNativeRouteTransactions"|"supportsQualifiedFootprintIdentitySync">,
  freshProject?: FreshProject,
  freshConnectivityContract?: FreshConnectivityContractSource,
): readonly HarnessToolDefinition[] {
  const found = new Map(session.listTools().map((tool) => [tool.name, tool]));
  const definitions: HarnessToolDefinition[] = [];
  const names = isVerifiedFreshProject(freshProject) ? KICAD_FRESH_HARNESS_TOOL_NAMES : KICAD_HARNESS_TOOL_NAMES;
  for (const name of names) {
    const tool = found.get(name);
    if((name==="fresh_sync_from_schematic"||name==="pcb_sync_from_schematic")&&session.supportsQualifiedFootprintIdentitySync?.()!==true)continue;
    if(name==="fresh_replace_route_items"&&session.supportsNativeRouteTransactions?.()!==true)continue;
    if(name==="fresh_apply_contract_plane"&&(!isVerifiedPlaneFreshProject(freshProject)||session.supportsPlaneStage?.()!==true||typeof session.stagePlane!=="function"))continue;
    if(freshProject?.workflowKind==="plane"&&(!isVerifiedPlaneFreshProject(freshProject)||PLANE_UNAVAILABLE_TOOL_NAMES.has(name)))continue;
    if (name === "pcb_add_text" && (!isVerifiedFreshProject(freshProject) || freshProject.workflowKind !== "generic" || freshConnectivityContract === undefined)) continue;
    if (FRESH_HOST_TOOL_NAMES.has(name) && freshConnectivityContract === undefined) continue;
    if (["fresh_get_contract_pad_positions", "fresh_get_route_items", "fresh_replace_route_items", "fresh_sync_from_schematic", "fresh_autoplace_schematic_fields"].includes(name)
        && !contractAuthoringProject(freshProject)) continue;
    if (tool === undefined && !FRESH_HOST_TOOL_NAMES.has(name)) continue;
    if (HOST_INTERNAL_TOOL_NAMES.has(name)) continue;
    const definition=harnessToolDefinitionSchema.parse({
      name,
      description: freshProject?.workflowKind==="plane"&&name==="fresh_get_route_items"?"Read the complete bounded, source-bound track/via UUID selection for the genuine V2 plane project. This inventory does not establish route completion, plane contact, clearance, or reference coverage.":freshProject?.workflowKind==="plane"&&name==="fresh_replace_route_items"?"Incrementally add and/or delete selected track/via UUIDs on one exact V2 contract net, including ground-plane access. Supply the last plane selection identity and all arrays; arrays may be empty but the operation must have an effect. Widths and via dimensions are host-derived. Draft routes may remain incomplete; mandatory save verifies exact source/native readback, not completed connectivity.":name === "pcb_add_text" ? "Add one bounded literal front-silkscreen label at zero rotation to the bound generic fresh PCB. Defaults are explicit; mandatory save verifies the new text and preservation of all existing board content. No copied-project support." : tool === undefined
        ? name === "fresh_apply_contract_connectivity"
          ? "Apply the host-bound design contract's exact nets and no-connects. Arguments must be empty. If a recommendation is returned, pass only its exact identity to the host atomic placement operation."
          : name === "fresh_apply_recommended_schematic_placement"
            ? "Apply the complete pending host recommendation atomically. Supply only the exact recommendationIdentity returned by fresh_apply_contract_connectivity; coordinates and membership remain host-owned."
            : name === "fresh_autoplace_schematic_fields"
              ? "Explicitly auto-place only existing visible Reference/Value field positions and justification for the exact contract symbols. Arguments must be empty. Electrical source content is preserved; the host must save and recollect native validation/render evidence. This operation does not certify readability or repair terminal/symbol layout."
            : name === "fresh_get_contract_pad_positions"
              ? "Read exact unrounded PCB pad positions for every host-contract pin. Arguments must be empty; the host binds the result to current PCB and library-table identities."
              : name === "fresh_get_route_items"
                ? "Read a bounded, source-bound list of current track/via UUIDs and exact geometry. Use its identity unchanged for fresh_replace_route_items."
                : name === "fresh_replace_route_items"
                  ? "Atomically replace only selected current track/via UUIDs on one contract net. Widths and via dimensions are derived by the host; arbitrary object deletion is impossible."
                  : "Synchronize the exact host-bound schematic into the PCB with forced open-board reload and complete footprint/pad/net readback. Arguments must be empty."
        : providerToolDescription(tool),
      inputSchema: name==="fresh_apply_contract_plane"?FRESH_PLANE_APPLY_INPUT_SCHEMA:freshProject?.workflowKind==="plane"&&name==="fresh_replace_route_items"?PLANE_ROUTE_MUTATION_INPUT_SCHEMA:name === "pcb_add_text" ? PCB_SILKSCREEN_TEXT_SCHEMA : name in FRESH_INCREMENTAL_INPUT_SCHEMAS
        ? FRESH_INCREMENTAL_INPUT_SCHEMAS[name as keyof typeof FRESH_INCREMENTAL_INPUT_SCHEMAS]
        : inputSchemaFor(tool!),
    });
    definitions.push(name==="fresh_apply_contract_plane"?{...definition,description:"Apply and refill one exact declared V2 plane using only its optional planeId. The host derives every setting and native UUID; arbitrary geometry is not accepted. Complete stage/source/physical inventory is validated before mandatory native save. DC connectivity, reference coverage, thermal and island-area acceptance remain unevaluated."}:definition);
  }
  return Object.freeze(definitions);
}

interface FreshPlacementSnapshot {
  readonly schematic: string;
  readonly placements: ReadonlyMap<string, FreshPlacement>;
  readonly boxes: readonly FreshBoundingBox[];
  readonly pins: ReadonlyMap<string, FreshPoint & { readonly angleDeg: 0 | 90 | 180 | 270 }>;
  readonly identity: ReturnType<typeof canonicalIdentity>;
  readonly sourceTerminals?: ReturnType<typeof buildFreshSchematicSourceTerminalGroups>;
}

interface PendingFreshPlacementRecommendation {
  readonly contract: FreshConnectivityContract;
  readonly recommendationIdentity: ReturnType<typeof canonicalIdentity>;
  readonly startingPlacementIdentity: ReturnType<typeof canonicalIdentity>;
  readonly startingSchematicSha256: string;
  readonly targetPlacementIdentity: ReturnType<typeof canonicalIdentity>;
  readonly targetPlacements: readonly FreshConnectivityRecommendedMove[];
  readonly recommendedMoves: readonly FreshConnectivityRecommendedMove[];
}

interface PendingFreshPlacementCommit {
  readonly contract: FreshConnectivityContract;
  readonly recommendationIdentity: ReturnType<typeof canonicalIdentity>;
  readonly baseline: FreshSchematicPreimage;
  readonly targetPlacementIdentity: ReturnType<typeof canonicalIdentity>;
  readonly targetPlacements: readonly FreshConnectivityRecommendedMove[];
  saveVerified: boolean;
}

class SerializedKicadHarnessTools implements KicadHarnessTools {
  readonly tools: readonly HarnessToolDefinition[];
  readonly internal: HarnessInternalToolPort;
  #tail: Promise<void> = Promise.resolve();
  readonly #session: KicadHarnessSession;
  readonly #fallback: HarnessInternalToolPort | undefined;
  readonly #verifyPersistedMutation: ((baseline?: string) => Promise<boolean>) | undefined;
  readonly #capturePersistedMutationBaseline: (() => Promise<string>) | undefined;
  #pendingPersistedMutationBaseline: string | undefined;
  /**
   * A deliberately narrow, direct-file batch fingerprint. History/sidecar
   * artifacts never participate: only the canonical fresh .kicad_sch bytes do.
   */
  #pendingSchematicFileMutationBatch: {
    readonly preimage: Buffer;
    readonly sha256: string;
    hasSchematicMutation: boolean;
    hasPcbMutation: boolean;
  } | undefined;
  readonly #freshProject: FreshProject | undefined;
  readonly #freshConnectivityContract: FreshConnectivityContract | undefined;
  readonly #freshDesignContract: PcbDesignContract | undefined;
  readonly #freshPlaneDesignContract: PcbPlaneDesignContract | undefined;
  readonly #freshAuthoringDesignContract: PcbDesignContract | PcbPlaneDesignContract | undefined;
  readonly #freshCompilationBundle: PcbDesignCompilationBundle | undefined;
  readonly #freshPlaneCompilationBundle: PcbPlaneCompilationBundle | undefined;
  readonly #freshLibraryResolver: PcbReadOnlyLibraryResolver | undefined;
  readonly #captureFreshNativeNetlist: (() => Promise<string>) | undefined;
  readonly #observeFreshSyncBoardComparison: KicadHarnessToolsOptions["observeFreshSyncBoardComparison"];
  readonly #freshSchematicGeometryResolver: FreshSchematicApprovedGeometryResolver | undefined;
  readonly #captureFreshSchematicStrokeStyle: KicadHarnessToolsOptions["captureFreshSchematicStrokeStyle"];
  readonly #freshSchematicWorkLimit: number;
  readonly #freshConnectivitySource: FreshConnectivityContractSource | undefined;
  readonly #freshPhysicalFootprintResolver: KicadHarnessToolsOptions["freshPhysicalFootprintResolver"];
  readonly #freshPhysicalFootprintSourcePins: KicadHarnessToolsOptions["freshPhysicalFootprintSourcePins"];
  readonly #freshBoardPersistence: FreshBoardPersistence | undefined;
  readonly #freshSchematicRollback: FreshSchematicRollback | undefined;
  #pendingFreshConnectivity: {
    readonly contract: FreshConnectivityContract;
    readonly baseline: FreshSchematicPreimage | undefined;
    readonly noConnectPoints: readonly { readonly endpoint: FreshConnectivityEndpoint; readonly point: FreshPoint }[];
    readonly labelAnchors: readonly FreshContractLabelAnchor[];
    /** A field-only mutation must retain these exact saved bytes through parity. */
    readonly fieldLayoutAfterContentIdentity?: ContentIdentity;
    readonly connectivityBatchAfterContentIdentity?: ContentIdentity;
  } | undefined;
  #pendingFreshPlacementRecommendation: PendingFreshPlacementRecommendation | undefined;
  #pendingFreshPlacementCommit: PendingFreshPlacementCommit | undefined;
  #pendingFreshRouteSelection: AuthoringRouteSelection | undefined;
  #planeRecoveryRequired = false;
  #savedFreshPlaneEvidence: SavedFreshPlaneEvidence | undefined;
  readonly #assessFreshPlaneEvidence: KicadHarnessToolsOptions["assessFreshPlaneEvidence"];
  #routeRecoveryRequired = false;
  readonly #observeFreshRouteMutationDiagnostic:KicadHarnessToolsOptions["observeFreshRouteMutationDiagnostic"];
  #freshRouteMutationDiagnostics:FreshRouteMutationDiagnostic[]=[];
  #pendingFreshBoardPostSave: (
    | PendingFreshPlaneApply
    | Readonly<{ readonly kind: "text"; readonly before: string; readonly requested: PcbSilkscreenText; readonly expectedAfter?: string }>
    | Readonly<{ readonly kind: "sync"; readonly contract: FreshConnectivityContract; readonly schematicContentIdentity: ContentIdentity; readonly physicalPcbSource?: string; readonly nativeNetlistSource?: string }>
    | Readonly<{ readonly kind: "route";readonly before:FreshPcbCapture; readonly contract: FreshConnectivityContract; readonly design: PcbDesignContract; readonly net: string; readonly expectedItems: readonly FreshRouteSelectionItem[]; readonly physicalPcbSource?: string }>
    | Readonly<{ readonly kind: "plane-route"; readonly before:FreshPcbCapture;readonly contract: FreshConnectivityContract; readonly design: PcbPlaneDesignContract; readonly net: string; readonly expectedItems: readonly FreshRouteSelectionItem[]; readonly physicalPcbSource: string }>
  ) | undefined;
  #freshBoardSaveAudits: FreshBoardSaveAudit[] = [];

  constructor(session: KicadHarnessSession, options: KicadHarnessToolsOptions) {
    this.#session = session;
    this.#observeFreshRouteMutationDiagnostic=options.observeFreshRouteMutationDiagnostic;
    this.#fallback = options.fallback;
    this.#verifyPersistedMutation = options.verifyPersistedMutation;
    this.#capturePersistedMutationBaseline = options.capturePersistedMutationBaseline;
    this.#freshProject = isVerifiedFreshProject(options.freshProject) ? options.freshProject : undefined;
    if(options.freshProject?.workflowKind==="plane"&&!isVerifiedPlaneFreshProject(options.freshProject))throw new Error("Copied or unauthenticated plane project cannot enter authoring or LED compatibility mode.");
    const freshConnectivityContract = this.#freshProject === undefined || options.freshConnectivityContract === undefined
      ? undefined
      : createFreshConnectivityContract(options.freshConnectivityContract);
    const freshDesignContract = this.#freshProject?.workflowKind === "generic"
      && (options.freshConnectivityContract as { readonly schemaVersion?: unknown } | undefined)?.schemaVersion === "evleda.pcb-design-contract.v1"
      ? parsePcbDesignContract(options.freshConnectivityContract)
      : undefined;
    const freshPlaneDesignContract=this.#freshProject?.workflowKind==="plane"&&options.freshConnectivityContract!==undefined?parsePcbPlaneDesignContract(options.freshConnectivityContract):undefined;
    if(this.#freshProject?.workflowKind==="plane"){
      if(options.freshCompilationBundle!==undefined)throw new Error("Plane authoring cannot use a V1 compilation bundle or practice profile.");
      assertPlaneCompilationBinding(this.#freshProject,freshConnectivityContract,freshPlaneDesignContract,options.freshPlaneCompilationBundle);
    }else if(options.freshPlaneCompilationBundle!==undefined)throw new Error("A plane compilation bundle may only bind its genuine plane project.");
    if (this.#freshProject?.workflowKind === "generic" && options.freshConnectivityContract !== undefined) {
      assertGenericCompilationBinding(this.#freshProject, freshConnectivityContract, freshDesignContract, options.freshCompilationBundle);
    } else if (options.freshCompilationBundle !== undefined) {
      throw new Error("A fresh compilation bundle may be supplied only with its exact generic marker-bound contract.");
    }
    this.#freshConnectivityContract = freshConnectivityContract;
    this.#freshDesignContract = freshDesignContract;
    this.#freshPlaneDesignContract=freshPlaneDesignContract;
    this.#freshAuthoringDesignContract=freshPlaneDesignContract??freshDesignContract;
    this.#freshCompilationBundle = options.freshCompilationBundle;
    this.#freshPlaneCompilationBundle=options.freshPlaneCompilationBundle;
    this.#freshLibraryResolver=options.freshLibraryResolver;
    this.#assertLibrarySources();
    this.#assessFreshPlaneEvidence=options.assessFreshPlaneEvidence;
    this.#captureFreshNativeNetlist = options.captureFreshNativeNetlist;
    this.#observeFreshSyncBoardComparison = options.observeFreshSyncBoardComparison;
    this.#freshSchematicGeometryResolver = options.freshSchematicGeometryResolver;
    this.#captureFreshSchematicStrokeStyle = options.captureFreshSchematicStrokeStyle;
    this.#freshSchematicWorkLimit = new FreshSchematicWorkBudget(options.freshSchematicWorkLimit).snapshot().maximum;
    this.#freshConnectivitySource = freshConnectivityContract === undefined ? undefined
      : this.#freshAuthoringDesignContract ?? structuredClone(options.freshConnectivityContract!);
    this.#freshPhysicalFootprintResolver=options.freshPhysicalFootprintResolver;
    this.#freshPhysicalFootprintSourcePins=options.freshPhysicalFootprintSourcePins===undefined?undefined:freezeDeep(structuredClone(options.freshPhysicalFootprintSourcePins));
    if((this.#freshPhysicalFootprintResolver===undefined)!==(this.#freshPhysicalFootprintSourcePins===undefined))throw new Error("Physical pad authority requires both the approved resolver and fixed source pins.");
    if(freshPlaneDesignContract!==undefined&&this.#freshPhysicalFootprintResolver===undefined)throw new Error("Plane authoring requires the approved physical footprint resolver/source pins; no legacy pad fallback is available.");
    if(this.#freshPhysicalFootprintResolver!==undefined){
      const physicalContract=this.#freshAuthoringDesignContract;
      if(physicalContract===undefined||!contractAuthoringProject(this.#freshProject)||typeof session.readLivePcbPadSnapshot!=="function")throw new Error("Physical pad authority requires a bound authoring project and private native pad read port.");
      const pins=this.#freshPhysicalFootprintSourcePins!;
      if(pins.length!==physicalContract.components.length||new Set(pins.map(pin=>pin.reference)).size!==pins.length||pins.some(pin=>!physicalContract.components.some(component=>component.reference===pin.reference&&component.footprintLibId===pin.libraryId)
        ||pin.sourceIdentity.algorithm!=="sha256"||!/^[a-f0-9]{64}$/u.test(pin.sourceIdentity.digest)||!Number.isSafeInteger(pin.sourceIdentity.size)||pin.sourceIdentity.size<=0))throw new Error("Physical footprint source pins differ from the complete host contract.");
    }
    this.#freshBoardPersistence = this.#freshProject === undefined ? undefined : new FreshBoardPersistence(this.#freshProject);
    this.#freshSchematicRollback = this.#freshProject === undefined ? undefined : new FreshSchematicRollback(this.#freshProject);
    this.tools = projectKicadHarnessToolDefinitions(session, this.#freshProject, options.freshConnectivityContract);
    this.internal = {
      execute: async (call) => await this.#executeInternal(call),
      saveAfterMutation: async (call) => await this.#saveAfterMutation(call),
      classifyPendingMutationBatch: async () => await this.#classifyPendingSchematicFileMutationBatch(),
    };
  }

  async #assertFreshCompoundAuthority(): Promise<void> {
    this.#assertLibrarySources();
    if(this.#freshProject?.workflowKind==="plane"){
      assertPlaneCompilationBinding(this.#freshProject,this.#freshConnectivityContract,this.#freshPlaneDesignContract,this.#freshPlaneCompilationBundle);
      await this.#freshProject.assertMarkerCurrent();
      assertFreshGenericSchematicSource(parseFreshSchematicSource(await readFile(this.#freshProject.schematicPath,"utf8")));
      assertPlaneCompilationBinding(this.#freshProject,this.#freshConnectivityContract,this.#freshPlaneDesignContract,this.#freshPlaneCompilationBundle);
      this.#assertLibrarySources();
      return;
    }
    if (this.#freshProject?.workflowKind !== "generic") return;
    assertGenericCompilationBinding(
      this.#freshProject,
      this.#freshConnectivityContract,
      this.#freshDesignContract,
      this.#freshCompilationBundle,
    );
    await this.#freshProject.assertMarkerCurrent();
    assertFreshGenericSchematicSource(parseFreshSchematicSource(await readFile(this.#freshProject.schematicPath, "utf8")));
    assertGenericCompilationBinding(
      this.#freshProject,
      this.#freshConnectivityContract,
      this.#freshDesignContract,
      this.#freshCompilationBundle,
    );
    this.#assertLibrarySources();
  }

  #assertLibrarySources(): void {
    const binding = (this.#freshPlaneCompilationBundle ?? this.#freshCompilationBundle)?.libraryBinding;
    if (binding === undefined) return;
    if (this.#freshLibraryResolver === undefined) {
      if (Object.hasOwn(binding, "sourceSelection")) throw new Error("Persisted library source pins require the original host source-aware resolver.");
      return;
    }
    assertPcbLibrarySourcesCurrent(binding, this.#freshLibraryResolver);
  }

  #callSourceBoundTool(name: string, argumentsValue: Readonly<Record<string, unknown>>): ReturnType<KicadHarnessSession["callTool"]> {
    this.#assertLibrarySources();
    return this.#session.callTool(name, argumentsValue);
  }

  get freshBoardSaveAudits(): readonly FreshBoardSaveAudit[] {
    return Object.freeze([...this.#freshBoardSaveAudits]);
  }
  get freshRouteMutationDiagnostics():readonly FreshRouteMutationDiagnostic[]{return Object.freeze([...this.#freshRouteMutationDiagnostics]);}

  #physicalExpected(capture:FreshPcbCapture,requestedPrimitiveIds:readonly string[]):KicadNativePadObservationExpected {
    if(this.#freshPhysicalFootprintResolver===undefined||this.#freshPhysicalFootprintSourcePins===undefined||this.#freshAuthoringDesignContract===undefined)throw new Error("Physical PCB expected authority is unavailable.");
    return Object.freeze({pcbPath:this.#freshProject!.pcbPath,pcbSource:capture.source,requestedPrimitiveIds:Object.freeze([...requestedPrimitiveIds]),enabledCopperLayers:this.#freshAuthoringDesignContract.scope.board.copperLayers,
      scopeIdentity:canonicalIdentity({contractIdentity:this.#freshAuthoringDesignContract.identity,...projectBindingResultFields(this.#freshProject!,capture.projectBindingIdentity),freshMarkerContentIdentity:capture.freshMarkerContentIdentity,physicalFootprints:this.#freshPhysicalFootprintSourcePins},"evleda.fresh-pcb-pad-read-scope.v1"),
      physicalFootprintResolver:this.#freshPhysicalFootprintResolver,physicalFootprints:this.#freshPhysicalFootprintSourcePins});
  }

  #assertPhysicalLibrarySources():void {
    this.#assertLibrarySources();
    if(this.#freshPhysicalFootprintResolver===undefined)return;
    for(const pin of this.#freshPhysicalFootprintSourcePins!){
      const inspected=this.#freshPhysicalFootprintResolver.inspectFootprint(pin.libraryId);
      if(inspected===null||!sameContentIdentity(inspected.sourceIdentity,pin.sourceIdentity))throw new Error("Approved physical footprint source changed before PCB operation.");
    }
  }

  async #physicalPadState(capture:FreshPcbCapture,requestedPrimitiveIds?:readonly string[]):Promise<Readonly<{observation:KicadNativePadObservation;expected:KicadNativePadObservationExpected;pads:readonly FreshContractPadPosition[]}>|undefined>{
    if(this.#freshPhysicalFootprintResolver===undefined)return undefined;
    this.#assertPhysicalLibrarySources();
    const positions=exactContractPadPositions(this.#freshProject!,this.#freshConnectivityContract!,capture.parsed,true);
    const expected=this.#physicalExpected(capture,requestedPrimitiveIds??positions.map(pad=>pad.physical!.id));
    const observation=await collectKicadNativePadObservation({readLivePcbPadSnapshot:ids=>this.#session.readLivePcbPadSnapshot!(ids)},expected);
    const after=await captureFreshPcb(this.#freshProject!);
    this.#assertPhysicalLibrarySources();
    if(!sameContentIdentity(after.contentIdentity,capture.contentIdentity)||!sameContentIdentity(after.freshMarkerContentIdentity,capture.freshMarkerContentIdentity))throw new Error("PCB source/marker changed during private physical-pad observation.");
    if(observation.inventory===null||observation.inventory.unsupportedPhysicalUuids.length!==0)throw new Error("Native physical-pad inventory has unsupported or incomplete feature/layer evidence.");
    const byId=new Map(observation.inventory.physicalPads.map(pad=>[pad.uuid,pad]));
    const pads=positions.map(pad=>{
      const observed=byId.get(pad.physical!.id);
      if(observed===undefined||observed.role!=="numbered-copper"||observed.netName!==pad.net||observed.observedUsableCopperLayers===null||observed.observedUsableCopperLayers.length===0)throw new Error("Contract routing candidate lacks current native copper-layer evidence.");
      // This raw native position has already passed source/library projection
      // validation. Do not re-export binary residue from local-pad transforms.
      return {...pad,...validatedNativePadPositionMm(observed.rawNative),layers:observed.observedUsableCopperLayers.map(layer=>layer.replace(/^BL_/u,"").replace(/_(Cu)$/u,".$1"))};
    });
    if(observation.inventory.terminals.length!==expectedPadNets(this.#freshConnectivityContract!).size||observation.inventory.terminals.some(terminal=>!terminal.eligibleForPinMatching))throw new Error("Native logical terminal inventory is incomplete or contradictory.");
    return Object.freeze({observation,expected,pads:freezeDeep(pads)});
  }

  #assertPhysicalRouteReachability(netName:string,contract:FreshConnectivityContract,capture:FreshPcbCapture,observation:KicadNativePadObservation,pads:readonly FreshContractPadPosition[]):void {
    const net=contract.nets.find(value=>value.name===netName);
    if(net===undefined||observation.inventory===null)throw new Error("Saved route lacks complete contract/native physical evidence.");
    const tracks=capture.parsed.segments.filter(segment=>segment.netName===netName);
    const contacts=net.endpoints.map(endpoint=>pads.filter(pad=>pad.reference===endpoint.reference&&pad.pad===endpoint.pin&&pad.net===netName
      &&tracks.some(track=>pad.layers.includes(track.layer)&&pointOnRouteSegment(pad,{xMm:track.start.x,yMm:track.start.y},{xMm:track.end.x,yMm:track.end.y}))).map(pad=>pad.physical!.id));
    if(contacts.some(ids=>ids.length===0))throw new Error("Saved route does not contact every logical terminal on actual native copper layers.");
    const queries=new Map(observation.clusters.queries.map(query=>[query.sourceUuids[0]!,query]));
    const contactIds=[...new Set(contacts.flat())];
    if(contactIds.some(id=>!queries.has(id)))throw new Error("Saved route is missing native single-source evidence for a contacted physical primitive.");
    const byId=new Map(observation.inventory.physicalPads.map(pad=>[pad.uuid,pad]));
    const sets=observation.clusters.queries.map(query=>new Set(query.returnedPadUuids));
    for(const set of sets)if([...set].some(id=>byId.get(id)?.netName!==netName))throw new Error("Saved route native cluster contains an unexpected net or non-electrical primitive.");
    for(let a=0;a<sets.length;a++)for(let b=a+1;b<sets.length;b++){
      const left=sets[a]!,right=sets[b]!;
      if([...left].some(id=>right.has(id))&&(left.size!==right.size||[...left].some(id=>!right.has(id))))throw new Error("Saved route has contradictory intersecting native copper clusters.");
    }
    if(!contactIds.some(id=>{const reached=new Set(queries.get(id)!.returnedPadUuids);return contacts.every(candidates=>candidates.some(candidate=>reached.has(candidate)));}))throw new Error("Saved route logical terminals remain physically disconnected in native copper evidence.");
    // Only reachability is derived here. Source topology still checks every
    // track/via; a routed native cluster is never an intrinsic pad shortcut.
  }

  /** Host finalizer only; serialized with tool operations and never provider-visible. */
  async captureFreshPcbPadEvidence():Promise<Readonly<{observation:KicadNativePadObservation;expected:KicadNativePadObservationExpected}>|undefined>{
    const run=this.#tail.then(async()=>{
      if(this.#freshPhysicalFootprintResolver===undefined)return undefined;
      await this.#assertFreshCompoundAuthority();
      const state=await this.#physicalPadState(await captureFreshPcb(this.#freshProject!));
      if(this.#freshProject?.workflowKind==="plane")await this.#assertFreshCompoundAuthority();
      return state===undefined?undefined:Object.freeze({observation:state.observation,expected:state.expected});
    });
    this.#tail=run.then(()=>undefined,()=>undefined);
    return await run;
  }

  /** Serialized saved-board read; raw PAD requests and paths remain host-owned. */
  async assessPlaneConnectivity():Promise<FreshPlaneConnectivityAssessment>{
    return await this.#withCurrentPlaneRead(async context => context.endpointConnectivity);
  }

  async assessPlaneAcceptance(calculator?:KicadTransmissionLineCalculator):Promise<FreshPlaneAcceptanceAssessment>{
    if(this.#assessFreshPlaneEvidence===undefined)throw new Error("The host has no V2 plane evidence assessor configured.");
    return await this.#withCurrentPlaneRead(context=>this.#assessFreshPlaneEvidence!({...context,
      ...(calculator===undefined?{}:{transmissionLine:calculator})}), true);
  }

  async assessInterface(interfaceId:string,calculator?:KicadTransmissionLineCalculator):Promise<SavedInterfaceAssessment>{
    return await this.#withCurrentPlaneRead(context=>assessSavedInterface({
      savedPcbBytes:Buffer.from(context.pcbSource,"utf8"),compilationBundle:context.compilationBundle,interfaceId,
      ...(calculator===undefined?{}:{calculator})}));
  }

  async #withCurrentPlaneRead<T>(operation: (input: Parameters<NonNullable<KicadHarnessToolsOptions["assessFreshPlaneEvidence"]>>[0])=>Promise<T>, requireFillEvidence=false):Promise<T>{
    const run=this.#tail.then(async()=>{
      if(!isVerifiedPlaneFreshProject(this.#freshProject)||this.#freshPlaneCompilationBundle===undefined
          ||this.#freshPhysicalFootprintResolver===undefined||this.#freshPhysicalFootprintSourcePins===undefined
          ||typeof this.#session.readLivePcbPadSnapshot!=="function")throw new Error("Endpoint connectivity requires the genuine V2 plane project, authenticated bundle, and approved native physical-pad capability.");
      const assertSavedRead=()=>{
        if(this.#planeRecoveryRequired||this.#routeRecoveryRequired||this.#pendingFreshBoardPostSave!==undefined
            ||this.#freshBoardPersistence?.hasPendingBoardMutation()===true||this.#pendingPersistedMutationBaseline!==undefined
            ||this.#pendingSchematicFileMutationBatch!==undefined||this.#pendingFreshConnectivity!==undefined||this.#pendingFreshPlacementCommit!==undefined){
          throw new Error("Endpoint connectivity requires settled saved state; pending or uncertain schematic/PCB mutations must be resolved first.");
        }
      };
      assertSavedRead();await this.#assertFreshCompoundAuthority();this.#assertPhysicalLibrarySources();
      // The acceptance callback also consumes native ERC/DRC and library-table
      // evidence. Keep their complete native source set inside this same read
      // operation, including changes after those subprocesses finish.
      const nativeSourcesBefore=await captureKicadNativeSourceHashes(this.#freshProject.projectPath);
      const before=await captureFreshPcb(this.#freshProject);
      const liveBefore=await freshActiveBoardSource(this.#session,this.#freshProject.pcbPath);
      if(!freshBoardSerializationsEqual(before.source,liveBefore))throw new Error("Endpoint connectivity refuses unsaved native PCB changes.");
      const physicalExpected=this.#physicalExpected(before,[]);
      const {projectSettings:settingsBefore,rules:rulesBefore}=await this.#planeRuleSources();
      const requiredSources=[this.#freshProject.pcbPath,this.#freshProject.schematicPath,this.#freshProject.rulesPath,
        path.join(this.#freshProject.projectPath,`${this.#freshProject.name}.kicad_pro`),
        path.join(this.#freshProject.projectPath,"sym-lib-table"),path.join(this.#freshProject.projectPath,"fp-lib-table")];
      const sourceKey=(file:string)=>path.relative(this.#freshProject!.projectPath,file).split(path.sep).join("/");
      if(requiredSources.some(file=>nativeSourcesBefore[sourceKey(file)]===undefined)
          ||nativeSourcesBefore[sourceKey(this.#freshProject.pcbPath)]!==before.contentIdentity.digest
          ||nativeSourcesBefore[`${this.#freshProject.name}.kicad_pro`]!==contentIdentity(settingsBefore).digest
          ||nativeSourcesBefore[sourceKey(this.#freshProject.rulesPath)]!==contentIdentity(rulesBefore).digest){
        throw new Error("Complete native project source inventory changed or is missing before plane evidence collection.");
      }
      const assertFillEvidenceCurrent=()=>{
        if(requireFillEvidence&&this.#savedFreshPlaneEvidence!==undefined)assertSavedFreshPlaneEvidenceCurrent(this.#savedFreshPlaneEvidence,{
          bundleIdentity:this.#freshPlaneCompilationBundle!.identity,projectBindingIdentity:before.projectBindingIdentity,
          sourceScopeIdentity:physicalExpected.scopeIdentity,savedPcbIdentity:before.contentIdentity,
          projectSettingsIdentity:contentIdentity(settingsBefore),rulesIdentity:contentIdentity(rulesBefore)});
      };
      assertFillEvidenceCurrent();
      const input={compilationBundle:this.#freshPlaneCompilationBundle,pcbPath:this.#freshProject.pcbPath,pcbSource:before.source,
        scopeIdentity:physicalExpected.scopeIdentity,physicalFootprints:this.#freshPhysicalFootprintSourcePins,physicalFootprintResolver:this.#freshPhysicalFootprintResolver};
      const prepared=prepareFreshPlaneConnectivity(input);
      const observation=await collectKicadNativePadObservation({readLivePcbPadSnapshot:ids=>this.#session.readLivePcbPadSnapshot!(ids)},prepared.nativePadExpected);
      const endpointConnectivity=assessFreshPlaneConnectivity({...input,nativePads:observation});
      const result=await operation({compilationBundle:this.#freshPlaneCompilationBundle,pcbPath:this.#freshProject.pcbPath,
        projectBindingIdentity:before.projectBindingIdentity,sourceScopeIdentity:physicalExpected.scopeIdentity,
        pcbSource:before.source,projectSettingsSource:new TextDecoder("utf-8",{fatal:true}).decode(settingsBefore),
        rulesSource:new TextDecoder("utf-8",{fatal:true}).decode(rulesBefore),savedEvidence:this.#savedFreshPlaneEvidence??null,endpointConnectivity});
      const liveAfter=await freshActiveBoardSource(this.#session,this.#freshProject.pcbPath);
      if(!freshBoardSerializationsEqual(before.source,liveAfter))throw new Error("Native PCB changed during endpoint connectivity observation.");
      await this.#assertFreshCompoundAuthority();this.#assertPhysicalLibrarySources();assertSavedRead();
      const {projectSettings:settingsAfter,rules:rulesAfter}=await this.#planeRuleSources();
      if(!settingsBefore.equals(settingsAfter)||!rulesBefore.equals(rulesAfter))throw new Error("Project settings or canonical plane rules changed during plane evidence collection.");
      const nativeSourcesAfter=await captureKicadNativeSourceHashes(this.#freshProject.projectPath);
      const after=await captureFreshPcb(this.#freshProject);
      if(!sameContentIdentity(before.contentIdentity,after.contentIdentity)||!sameContentIdentity(before.freshMarkerContentIdentity,after.freshMarkerContentIdentity)
          ||canonicalJson(before.projectBindingIdentity)!==canonicalJson(after.projectBindingIdentity)
          ||canonicalJson(this.#physicalExpected(after,[]).scopeIdentity)!==canonicalJson(physicalExpected.scopeIdentity))throw new Error("PCB source, marker, or physical scope changed during endpoint connectivity observation.");
      if(canonicalJson(nativeSourcesBefore)!==canonicalJson(nativeSourcesAfter))throw new Error("Complete native project source inventory changed during plane evidence collection.");
      this.#assertPhysicalLibrarySources();assertSavedRead();
      assertFillEvidenceCurrent();
      return result;
    });
    this.#tail=run.then(()=>undefined,()=>undefined);
    return await run;
  }

  async #sourceTerminalGroups(schematic: string, pins: ReadonlyMap<string, FreshPoint & { readonly angleDeg: 0 | 90 | 180 | 270 }>, work: FreshPlanningWork) {
    if (this.#freshSchematicGeometryResolver === undefined || this.#freshConnectivitySource === undefined) return undefined;
    const schematicIdentity = contentIdentity(schematic);
    const strokeStyleEvidence = await this.#captureFreshSchematicStrokeStyle?.(schematicIdentity);
    const result = buildFreshSchematicSourceTerminalGroups({
      schematicSource: schematic, expectedSourceIdentity: schematicIdentity, contract: this.#freshConnectivitySource,
      libraryResolver: this.#freshSchematicGeometryResolver,
      ...(strokeStyleEvidence === undefined ? {} : { strokeStyleEvidence }),
      livePins: [...pins].map(([id, pin]) => {
        const separator = id.indexOf(":");
        return { reference: id.slice(0, separator), pin: id.slice(separator + 1), at: { xMm: pin.x, yMm: pin.y }, angleDeg: pin.angleDeg };
      }),
    }, work.budget);
    if (result.result.status === "exhausted") work.exhausted = true;
    return result;
  }

  async #readFreshPlacementSnapshot(contract: FreshConnectivityContract, work = createFreshSchematicPlanningWork()): Promise<FreshPlacementSnapshot> {
    const schematic = await readFile(this.#freshProject!.schematicPath, "utf8");
    for (const component of contract.components) {
      if (!schematic.includes(`(symbol "${component.symbolLibId}"`)) throw new Error(`Missing embedded ${component.symbolLibId} definition for ${component.reference}.`);
    }
    const symbolsResult = await this.#callSourceBoundTool("sch_get_symbols", {});
    if (symbolsResult.isError === true) throw new Error("KiCad failed to read the recommendation-bound symbol placements.");
    const allPlacements = parseFreshPlacements(preferredResultText(symbolsResult));
    const expectedReferences = new Set(contract.components.map((component) => component.reference));
    if (allPlacements.size !== expectedReferences.size || [...allPlacements].some(([reference, values]) => !expectedReferences.has(reference) || values.length !== 1)) {
      throw new Error("The live symbol inventory no longer exactly matches the recommendation-bound contract.");
    }
    const placements = new Map<string, FreshPlacement>();
    for (const component of contract.components) {
      const placement = allPlacements.get(component.reference)?.[0];
      if (placement === undefined
        || `${placement.library}:${placement.symbol}` !== component.symbolLibId
        || (placement.footprint !== undefined && placement.footprint !== component.footprintLibId)) {
        throw new Error(`The live identity of ${component.reference} no longer matches its host contract.`);
      }
      placements.set(component.reference, placement);
    }
    const boundsResult = await this.#callSourceBoundTool("sch_get_bounding_boxes", {});
    if (boundsResult.isError === true) throw new Error("KiCad failed to read recommendation-bound schematic bounding boxes.");
    const allBoxes = parseFreshBoundingBoxes(preferredResultText(boundsResult));
    if (allBoxes.length !== contract.components.length
      || contract.components.some((component) => allBoxes.filter((box) => box.reference === component.reference).length !== 1)) {
      throw new Error("The live bounding-box inventory no longer exactly matches the recommendation-bound contract.");
    }
    let boxes = contract.components.map((component) => allBoxes.find((box) => box.reference === component.reference)!)
      .sort((left, right) => left.reference.localeCompare(right.reference, "en-US"));
    const pins = new Map<string, FreshPoint & { readonly angleDeg: 0 | 90 | 180 | 270 }>();
    for (const [reference, placement] of [...placements].sort(([left], [right]) => left.localeCompare(right, "en-US"))) {
      const localAngles = parseFreshEmbeddedPinAngles(schematic, `${placement.library}:${placement.symbol}`, placement.unit);
      const result = await this.#callSourceBoundTool("sch_get_pin_positions", {
        library: placement.library, symbol_name: placement.symbol, x_mm: placement.x, y_mm: placement.y,
        rotation: placement.rotation, unit: placement.unit,
      });
      if (result.isError === true) throw new Error(`KiCad failed to resolve recommendation-bound pin positions for ${reference}.`);
      for (const match of preferredResultText(result).matchAll(/- Pin ([^:]+): \((-?[\d.]+),\s*(-?[\d.]+)\) mm/gu)) {
        const id = `${reference}:${match[1]}`;
        const x = Number(match[2]);
        const y = Number(match[3]);
        const localAngle = localAngles[match[1]!];
        const angleDeg = localAngle === undefined ? null : freshAbsolutePinAngle(localAngle, placement.rotation);
        if (!Number.isFinite(x) || !Number.isFinite(y) || angleDeg === null || pins.has(id)) throw new Error(`KiCad returned invalid or duplicate pin geometry for ${id}.`);
        pins.set(id, { x, y, angleDeg });
      }
    }
    const endpoints = [...contract.nets.flatMap((net) => net.endpoints), ...contract.noConnects];
    if (endpoints.some((endpoint) => !pins.has(endpointId(endpoint)))) throw new Error("One or more recommendation-bound contract pins could not be resolved exactly.");
    const sourceTerminals = await this.#sourceTerminalGroups(schematic, pins, work);
    if (sourceTerminals !== undefined && sourceTerminals.result.status !== "complete") {
      throw new Error(`Source-bound placement terminals are ${sourceTerminals.result.status}: ${canonicalJson(sourceTerminals.result)}`);
    }
    if (sourceTerminals !== undefined) {
      if (sourceTerminals.sourceBodyGeometry.some((body) => !body.coverage.complete || !body.coverage.renderedStrokeVerified)) throw new Error("Source-bound placement lacks complete graphics and verified rendered-stroke coverage.");
      const bodies = new Map(sourceTerminals.sourceBodyGeometry.map((body) => [body.reference, body.bounds]));
      boxes = boxes.map((box) => {
        const body = bodies.get(box.reference);
        return body === undefined || body === null ? box : { reference: box.reference, minX: Math.min(box.minX, body.minXmm), minY: Math.min(box.minY, body.minYmm), maxX: Math.max(box.maxX, body.maxXmm), maxY: Math.max(box.maxY, body.maxYmm) };
      });
    }
    return Object.freeze({ schematic, placements, boxes: Object.freeze(boxes), pins, identity: freshPlacementStateIdentity(placements, boxes, pins),
      ...(sourceTerminals === undefined ? {} : { sourceTerminals }) });
  }

  async #captureSaveBaseline(name: string): Promise<boolean> {
    if (!PROVIDER_MUTATION_TOOL_NAMES.has(name) || this.#pendingPersistedMutationBaseline !== undefined) return false;
    if (this.#capturePersistedMutationBaseline !== undefined) {
      this.#pendingPersistedMutationBaseline = await this.#capturePersistedMutationBaseline();
      return true;
    }
    return false;
  }

  async #captureSchematicFileMutationBatch(name: string): Promise<void> {
    if (!PROVIDER_MUTATION_TOOL_NAMES.has(name)) return;
    if (this.#freshProject !== undefined
        && (typeof this.#session.assertActivePcb !== "function" || typeof this.#session.readActivePcbSource !== "function")) {
      throw new Error("Fresh mutations require private active-PCB identity and raw-source ports.");
    }
    const current = this.#pendingSchematicFileMutationBatch;
    if (current !== undefined) {
      if (SYNCHRONOUS_SCHEMATIC_FILE_MUTATION_TOOL_NAMES.has(name)) current.hasSchematicMutation = true;
      if (PCB_MUTATION_TOOL_NAMES.has(name)) current.hasPcbMutation = true;
      return;
    }
    // This recovery path applies only to an authority-marked fresh project,
    // whose exact schematic path is fixed by the marker, not provider input.
    if (
      (!SYNCHRONOUS_SCHEMATIC_FILE_MUTATION_TOOL_NAMES.has(name) && !PCB_MUTATION_TOOL_NAMES.has(name))
      || this.#freshProject === undefined
    ) return;
    const preimage = await readFile(this.#freshProject.schematicPath);
    this.#pendingSchematicFileMutationBatch = {
      preimage,
      sha256: sha256(preimage),
      hasSchematicMutation: SYNCHRONOUS_SCHEMATIC_FILE_MUTATION_TOOL_NAMES.has(name),
      hasPcbMutation: PCB_MUTATION_TOOL_NAMES.has(name),
    };
  }

  async #classifyPendingSchematicFileMutationBatch(): Promise<HarnessMutationBatchDisposition | undefined> {
    if(this.#pendingFreshBoardPostSave?.kind==="plane")return undefined;
    const pending = this.#pendingSchematicFileMutationBatch;
    if (this.#pendingFreshPlacementCommit !== undefined && (pending === undefined || !pending.hasSchematicMutation || pending.hasPcbMutation)) {
      return await this.#rollbackPendingPlacementCommitAfterFailure(new Error("Atomic placement lost its exclusive schematic batch boundary."), "atomic placement could not prove an exclusive persisted schematic mutation before save");
    }
    if (pending === undefined || !pending.hasSchematicMutation || pending.hasPcbMutation) return undefined;
    // A read/hash failure is intentionally allowed to escape: unknown authority
    // cannot be translated into a no-op and therefore remains terminal.
    let observed: Buffer;
    try {
      observed = await readFile(this.#freshProject!.schematicPath);
    } catch (error) {
      if (this.#pendingFreshPlacementCommit !== undefined) {
        return await this.#rollbackPendingPlacementCommitAfterFailure(error, "atomic placement schematic fingerprint could not be read before save");
      }
      throw error;
    }
    const observedSha256 = sha256(observed);
    if (!pending.preimage.equals(observed) || pending.sha256 !== observedSha256) return undefined;
    if (this.#pendingFreshPlacementCommit !== undefined) {
      return await this.#rollbackPendingPlacementCommitAfterFailure(new Error("Atomic placement produced no governed schematic-file effect."), "atomic placement returned success but the exact authoritative schematic bytes did not change");
    }
    this.#pendingSchematicFileMutationBatch = undefined;
    // This baseline was captured for exactly this unsaved batch. Clearing it
    // permits a later real mutation to capture a fresh, independent baseline.
    this.#pendingPersistedMutationBaseline = undefined;
    return Object.freeze({
      schemaVersion: "evleda.mutation-batch-disposition.v1",
      status: "no-governed-effect",
      domain: "schematic-file",
      baselineSha256: pending.sha256,
      observedSha256,
    });
  }

  async #rollbackPendingConnectivityAfterFailure(error: unknown, context: string): Promise<never> {
    const pending = this.#pendingFreshConnectivity;
    if (pending === undefined) throw error;
    try {
      if (pending.baseline !== undefined) await this.#freshSchematicRollback!.restore(pending.baseline);
    } catch (rollbackError) {
      this.#pendingFreshConnectivity = undefined;
      this.#pendingPersistedMutationBaseline = undefined;
      throw new Error(`FRESH_CONNECTIVITY_ROLLBACK_FAILED_TERMINAL: ${context}; exact disk rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}.`, { cause: error });
    }
    this.#pendingFreshConnectivity = undefined;
    this.#pendingPersistedMutationBaseline = undefined;
    throw new Error(`FRESH_CONNECTIVITY_ROLLED_BACK_TERMINAL: ${context}; exact disk preimage restored, live KiCad state is unproven, and this session must close.`, { cause: error });
  }

  async #rollbackPendingPlacementCommitAfterFailure(error: unknown, context: string): Promise<never> {
    const pending = this.#pendingFreshPlacementCommit;
    if (pending === undefined) throw error;
    this.#pendingFreshPlacementCommit = undefined;
    this.#pendingPersistedMutationBaseline = undefined;
    this.#pendingSchematicFileMutationBatch = undefined;
    try {
      await this.#freshSchematicRollback!.restore(pending.baseline);
    } catch (rollbackError) {
      throw new Error(`FRESH_CONNECTIVITY_PLACEMENT_ROLLBACK_FAILED_TERMINAL: ${context}; exact disk rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}.`, { cause: error });
    }
    throw new Error(`FRESH_CONNECTIVITY_PLACEMENT_ROLLED_BACK_TERMINAL: ${context}; exact disk preimage restored, live KiCad state is unproven, and this session must close.`, { cause: error });
  }

  async #rollbackPendingFreshBoardAfterFailure(error: unknown, context: string, call?:HarnessToolCall): Promise<HarnessToolResult> {
    if (this.#pendingFreshBoardPostSave === undefined) throw error;
    if(this.#pendingFreshBoardPostSave.kind==="plane")return await this.#planeApplyFailure(call??{id:"plane-sequence-failure",name:"fresh_apply_contract_plane",arguments:{}},this.#pendingFreshBoardPostSave.before,this.#pendingFreshBoardPostSave.observation,"save-order",new Error(context,{cause:error}));
    if(this.#pendingFreshBoardPostSave.kind==="plane-route"){
      const pending=this.#pendingFreshBoardPostSave;
      return await this.#routeMutationFailure(call??{id:"route-sequence-failure",name:"fresh_replace_route_items",arguments:{}},pending.net,pending.before,pending.physicalPcbSource,"mandatory-save-order",new Error(context,{cause:error}),true,true);
    }
    this.#pendingFreshBoardPostSave = undefined;
    this.#pendingFreshRouteSelection = undefined;
    this.#pendingPersistedMutationBaseline = undefined;
    try {
      await this.#freshBoardPersistence!.rollbackToPreMutation(this.#session);
    } catch (rollbackError) {
      throw new Error(`FRESH_BOARD_COMPOUND_ROLLBACK_FAILED_TERMINAL: ${context}; exact PCB rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}.`, { cause: error });
    }
    throw new Error(`FRESH_BOARD_COMPOUND_ROLLED_BACK_TERMINAL: ${context}; exact PCB disk/live preimage restored and this session must close.`, { cause: error });
  }

  async #completePendingPlacementCommitAfterReadback(): Promise<void> {
    const pending = this.#pendingFreshPlacementCommit;
    if (pending === undefined || !pending.saveVerified) return;
    const work = createFreshSchematicPlanningWork(new FreshSchematicWorkBudget(this.#freshSchematicWorkLimit));
    const snapshot = await this.#readFreshPlacementSnapshot(pending.contract, work);
    if (canonicalJson(snapshot.identity) !== canonicalJson(pending.targetPlacementIdentity)
      || snapshot.placements.size !== pending.targetPlacements.length
      || pending.targetPlacements.some((target) => {
        const placement = snapshot.placements.get(target.reference);
        return placement === undefined
          || Math.abs(placement.x - target.xMm) > GEOMETRY_EPSILON_MM
          || Math.abs(placement.y - target.yMm) > GEOMETRY_EPSILON_MM
          || placement.rotation !== target.rotationDeg;
      })) throw new Error("Saved atomic placement no longer reproduces its complete recommendation-bound target state.");
    const geometry = parseFreshSchematicSource(snapshot.schematic);
    if (geometry.wires.length !== 0 || geometry.labels.length !== 0 || geometry.junctions.length !== 0 || geometry.noConnectCount !== 0) {
      throw new Error("Saved atomic placement contains non-pristine schematic geometry absent from its recommendation.");
    }
    const partition = snapshot.sourceTerminals?.result.status === "complete" ? snapshot.sourceTerminals.result.value : undefined;
    const plan = planFreshContractGeometry(pending.contract, snapshot.pins, snapshot.boxes, work, contractAuthoringProject(this.#freshProject), partition);
    if (work.exhausted || plan.issues.length > 0) throw new Error("Saved atomic placement no longer admits the complete deterministic contract wire plan.");
    this.#pendingFreshPlacementCommit = undefined;
    this.#pendingPersistedMutationBaseline = undefined;
    this.#pendingSchematicFileMutationBatch = undefined;
  }

  async #queuedPlaneCallGuard(call:HarnessToolCall):Promise<HarnessToolResult|undefined>{
    // A source-equivalent edit can still dirty/refill native copper. Invalidate
    // on dispatch, before native execution; byte equality never restores authority.
    if(PROVIDER_MUTATION_TOOL_NAMES.has(call.name)||call.name==="pcb_save")this.#savedFreshPlaneEvidence=undefined;
    if(this.#routeRecoveryRequired&&(PROVIDER_MUTATION_TOOL_NAMES.has(call.name)||call.name==="pcb_save"))throw new Error("ROUTE_RECOVERY_REQUIRED: Queued writes/save are refused after a failed native route transaction.");
    if(this.#planeRecoveryRequired&&(PROVIDER_MUTATION_TOOL_NAMES.has(call.name)||call.name==="pcb_save"))throw new Error("PLANE_APPLY_RECOVERY_REQUIRED: Queued writes/save are refused after uncertain plane staging.");
    if(this.#pendingFreshBoardPostSave?.kind==="plane"){
      const pending=this.#pendingFreshBoardPostSave;
      return await this.#planeApplyFailure(call,pending.before,pending.observation,"queued-save-order",new Error("A queued operation reached a staged plane before its dedicated mandatory native save."));
    }
    if(this.#pendingFreshBoardPostSave?.kind==="plane-route"&&call.name!=="pcb_save"){
      const pending=this.#pendingFreshBoardPostSave;
      return await this.#routeMutationFailure(call,pending.net,pending.before,pending.physicalPcbSource,"queued-save-order",new Error("Queued operation preceded mandatory route save."),true,true);
    }
    return undefined;
  }

  async #call(call: HarnessToolCall, providerCallable: boolean, normalize = false): Promise<HarnessToolResult> {
    const parsed = harnessToolCallSchema.parse(detachedJson(call, "Harness tool call", MAX_ARGUMENT_BYTES));
    if(this.#routeRecoveryRequired&&(PROVIDER_MUTATION_TOOL_NAMES.has(parsed.name)||parsed.name==="pcb_save"))throw new Error("ROUTE_RECOVERY_REQUIRED: Further writes/save are refused after a failed native route transaction.");
    if(this.#planeRecoveryRequired&&(PROVIDER_MUTATION_TOOL_NAMES.has(parsed.name)||parsed.name==="pcb_save"))throw new Error("PLANE_APPLY_RECOVERY_REQUIRED: Further writes/save are refused; preserve and inspect state, use host recovery, then close this editing session.");
    if (providerCallable && this.#pendingFreshBoardPostSave !== undefined) {
      const run = this.#tail.then(async () => await this.#rollbackPendingFreshBoardAfterFailure(
        new Error(`Later provider call ${parsed.name} preceded the compound board save.`),
        `another provider call (${parsed.name}) was requested after a verified board compound but before its mandatory save/readback`,
        parsed,
      ));
      this.#tail = run.then(() => undefined, () => undefined);
      return await run;
    }
    if (!providerCallable && this.#pendingFreshBoardPostSave !== undefined && parsed.name !== "pcb_save") {
      const run = this.#tail.then(async () => await this.#rollbackPendingFreshBoardAfterFailure(
        new Error(`Internal call ${parsed.name} bypassed the compound board save.`),
        `compound board mutation required pcb_save immediately, but ${parsed.name} was requested instead`,
        parsed,
      ));
      this.#tail = run.then(() => undefined, () => undefined);
      return await run;
    }
    if (providerCallable && this.#pendingFreshPlacementCommit !== undefined) {
      const run = this.#tail.then(async () => await this.#rollbackPendingPlacementCommitAfterFailure(
        new Error(`Later provider call ${parsed.name} preceded placement commit.`),
        `another provider call (${parsed.name}) was requested after atomic placement but before its mandatory save/readback commit`,
      ));
      this.#tail = run.then(() => undefined, () => undefined);
      return await run;
    }
    if (!providerCallable && this.#pendingFreshPlacementCommit !== undefined
      && parsed.name !== "pcb_save"
      && !(this.#pendingFreshPlacementCommit.saveVerified && parsed.name === "sch_get_connectivity_graph")) {
      const run = this.#tail.then(async () => await this.#rollbackPendingPlacementCommitAfterFailure(
        new Error(`Internal call ${parsed.name} bypassed the mandatory placement commit sequence.`),
        `atomic placement required save followed immediately by exact schematic readback, but ${parsed.name} was requested instead`,
      ));
      this.#tail = run.then(() => undefined, () => undefined);
      return await run;
    }
    if(this.#freshProject?.workflowKind==="plane"&&PLANE_UNAVAILABLE_TOOL_NAMES.has(parsed.name))throw new Error(`Plane workflow does not yet support ${parsed.name} as a public/raw operation. Use only the governed plane route operation where applicable; arbitrary copper/zone writes are outside this authority.`);
    if (!supportedToolNames.has(parsed.name) || (providerCallable && !this.tools.some((tool) => tool.name === parsed.name))) {
      throw new Error(`Unsupported KiCad harness tool: ${parsed.name}`);
    }
    if (FRESH_HOST_TOOL_NAMES.has(parsed.name)) {
      if (this.#freshProject === undefined || this.#freshConnectivityContract === undefined || !providerCallable) {
        throw new Error("Fresh host compound operations are only available to a marked fresh project with a host-bound closed task contract.");
      }
      const run = this.#tail.then(async () => {
        const pendingBefore = this.#pendingFreshConnectivity;
        let capturedByThisCall = false;
        try {
          const planeGuard=await this.#queuedPlaneCallGuard(parsed);
          if(planeGuard!==undefined)return planeGuard;
          await this.#assertFreshCompoundAuthority();
          if (this.#pendingFreshPlacementCommit !== undefined) {
            return await this.#rollbackPendingPlacementCommitAfterFailure(
              new Error(`Queued host call ${parsed.name} reached a pending placement commit.`),
              `a queued provider host call (${parsed.name}) reached execution after atomic placement but before its mandatory save/readback commit`,
            );
          }
          await this.#captureSchematicFileMutationBatch(parsed.name);
          capturedByThisCall = await this.#captureSaveBaseline(parsed.name);
          const result = parsed.name === "fresh_apply_contract_connectivity"
            ? await this.#freshApplyContractConnectivity(parsed)
            : parsed.name === "fresh_apply_recommended_schematic_placement"
              ? await this.#freshApplyRecommendedSchematicPlacement(parsed)
              : parsed.name === "fresh_autoplace_schematic_fields"
                ? await this.#freshAutoplaceSchematicFields(parsed)
              : parsed.name === "fresh_get_contract_pad_positions"
                ? await this.#freshGetContractPadPositions(parsed)
                : parsed.name === "fresh_get_route_items"
                  ? await this.#freshGetRouteItems(parsed)
                  : parsed.name === "fresh_replace_route_items"
                    ? await this.#freshReplaceRouteItems(parsed)
                    : parsed.name==="fresh_apply_contract_plane"?await this.#freshApplyContractPlane(parsed):await this.#freshSyncFromSchematic(parsed);
          if (capturedByThisCall && this.#pendingFreshConnectivity === undefined) {
            let payload: unknown;
            try { payload = JSON.parse(result.content) as unknown; } catch { payload = null; }
            if (payload !== null && typeof payload === "object" && !Array.isArray(payload) && (payload as Record<string, unknown>).mutated === false) {
              this.#pendingPersistedMutationBaseline = undefined;
            }
          }
          if(result.isError!==true)this.#assertLibrarySources();
          if(this.#freshProject?.workflowKind==="plane"&&result.isError!==true)await this.#assertFreshCompoundAuthority();
          return result;
        } catch (error) {
          if(this.#pendingFreshBoardPostSave?.kind==="plane")return await this.#planeApplyFailure(parsed,this.#pendingFreshBoardPostSave.before,this.#pendingFreshBoardPostSave.observation,"result-authority",error);
          if(this.#pendingFreshBoardPostSave?.kind==="plane-route")return await this.#routeMutationFailure(parsed,this.#pendingFreshBoardPostSave.net,this.#pendingFreshBoardPostSave.before,this.#pendingFreshBoardPostSave.physicalPcbSource,"result-authority",error,true,true);
          if (this.#pendingFreshPlacementCommit !== undefined) return await this.#rollbackPendingPlacementCommitAfterFailure(error, "atomic placement result construction failed before mandatory save/readback commit");
          if (this.#pendingFreshConnectivity !== undefined) return await this.#rollbackPendingConnectivityAfterFailure(error, pendingBefore === undefined
            ? "contract-connectivity result construction failed after mutation"
            : "a later duplicate contract-connectivity call failed before mandatory save/native parity");
          if (capturedByThisCall) this.#pendingPersistedMutationBaseline = undefined;
          throw error;
        }
      });
      this.#tail = run.then(() => undefined, () => undefined);
      return await run;
    }
    const advertised = this.#session.listTools().some((tool) => tool.name === parsed.name);
    if (!advertised) {
      if (this.#pendingFreshPlacementCommit !== undefined) {
        const run = this.#tail.then(async () => await this.#rollbackPendingPlacementCommitAfterFailure(
          new Error(`Required internal tool ${parsed.name} disappeared before placement commit.`),
          `atomic placement could not complete because ${parsed.name} was no longer advertised`,
        ));
        this.#tail = run.then(() => undefined, () => undefined);
        return await run;
      }
      if (this.#fallback !== undefined) return await this.#fallback.execute(parsed);
      throw new Error(`KiCad sidecar did not advertise required internal tool: ${parsed.name}`);
    }
    const run = this.#tail.then(async () => {
      try {
      const planeGuard=await this.#queuedPlaneCallGuard(parsed);
      if(planeGuard!==undefined)return planeGuard;
      if(this.#freshProject?.workflowKind==="plane")await this.#assertFreshCompoundAuthority();
      if (providerCallable && this.#pendingFreshPlacementCommit !== undefined) {
        return await this.#rollbackPendingPlacementCommitAfterFailure(
          new Error(`Queued provider call ${parsed.name} reached a pending placement commit.`),
          `a queued provider call (${parsed.name}) reached execution after atomic placement but before its mandatory save/readback commit`,
        );
      }
      if (!providerCallable && this.#pendingFreshPlacementCommit !== undefined
        && parsed.name !== "pcb_save"
        && !(this.#pendingFreshPlacementCommit.saveVerified && parsed.name === "sch_get_connectivity_graph")) {
        return await this.#rollbackPendingPlacementCommitAfterFailure(
          new Error(`Queued internal call ${parsed.name} reached a pending placement commit.`),
          `a queued internal call (${parsed.name}) reached execution outside the mandatory placement save/readback sequence`,
        );
      }
      if (providerCallable && this.#pendingFreshPlacementRecommendation !== undefined && SYNCHRONOUS_SCHEMATIC_FILE_MUTATION_TOOL_NAMES.has(parsed.name)) {
        throw new Error("A complete host placement recommendation is pending. Raw or substitute schematic mutations are refused; call fresh_apply_recommended_schematic_placement with only its exact recommendationIdentity.");
      }
      if (
        providerCallable
        && this.#pendingFreshConnectivity !== undefined
        && PROVIDER_MUTATION_TOOL_NAMES.has(parsed.name)
        && parsed.name !== "fresh_apply_contract_connectivity"
      ) {
        const pending = this.#pendingFreshConnectivity;
        if (pending.baseline !== undefined) await this.#freshSchematicRollback!.restore(pending.baseline);
        this.#pendingFreshConnectivity = undefined;
        this.#pendingPersistedMutationBaseline = undefined;
        throw new Error("FRESH_CONNECTIVITY_ROLLED_BACK_TERMINAL: another mutation was requested after contract connectivity but before its mandatory save/native-parity gate; exact disk preimage restored when available, and this session must close.");
      }
      if (providerCallable) {
        if (PROVIDER_MUTATION_TOOL_NAMES.has(parsed.name)) await this.#assertFreshCompoundAuthority();
        await this.#captureSchematicFileMutationBatch(parsed.name);
        await this.#captureSaveBaseline(parsed.name);
      }
      if (PCB_MUTATION_TOOL_NAMES.has(parsed.name)) await this.#freshBoardPersistence?.capturePreMutation(this.#session);
      if (parsed.name === "pcb_add_text") return await this.#addPcbSilkscreenText(parsed);
      if (parsed.name in FRESH_INCREMENTAL_INPUT_SCHEMAS) {
        if (this.#freshProject === undefined) throw new Error("Fresh incremental schematic tools require a marked fresh project.");
        parseFreshIncrementalArguments(parsed.name, parsed.arguments);
      }
      const argumentsValue = parsed.name === "pcb_add_track" && typeof parsed.arguments.layer === "string"
        ? { ...parsed.arguments, layer: normalizeLayer(parsed.arguments.layer) }
        : parsed.arguments;
      if(parsed.name==="pcb_save"&&this.#pendingFreshBoardPostSave?.kind==="plane-route")await this.#knownBoardMutationState(this.#pendingFreshBoardPostSave.before,this.#pendingFreshBoardPostSave.physicalPcbSource,true);
      const result = await this.#callSourceBoundTool(parsed.name, structuredClone(argumentsValue));
      if(parsed.name==="pcb_save"&&this.#pendingFreshBoardPostSave?.kind==="plane-route"&&!hasQualifiedNativeBoardReply(result,"Board saved."))throw new Error("Native route save lacks its qualified positive acknowledgement.",{cause:nativeReplyCause("pcb_save",result)});
      // Preserve the native error or missing save acknowledgement as the first
      // failure when the same awaited call also observes library drift.
      if(result.isError!==true){
        this.#assertLibrarySources();
        if(this.#freshProject?.workflowKind==="plane")await this.#assertFreshCompoundAuthority();
      }
      if (parsed.name !== "pcb_save" && result.isError === true && this.#pendingFreshPlacementCommit !== undefined) {
        return await this.#rollbackPendingPlacementCommitAfterFailure(new Error(`KiCad ${parsed.name} returned an MCP error.`), `a ${parsed.name} call failed before atomic placement commit completed`);
      }
      if (providerCallable && result.isError === true && this.#pendingFreshConnectivity !== undefined) {
        return await this.#rollbackPendingConnectivityAfterFailure(new Error(`KiCad ${parsed.name} returned an MCP error.`), `a later ${parsed.name} call failed before mandatory save/native parity`);
      }
      if (!providerCallable && HOST_INTERNAL_TOOL_NAMES.has(parsed.name) && this.#fallback !== undefined && unavailableValidationResult(result.structuredContent ?? result.content)) {
        return await this.#fallback.execute(parsed);
      }
      const normalizedResult = harnessToolResultSchema.parse({
        toolCallId: parsed.id,
        content: resultContent(result, normalize, parsed.name === "pcb_get_tracks"),
        ...(result.isError === true ? { isError: true } : {}),
      });
      if (!providerCallable && parsed.name === "sch_get_connectivity_graph" && this.#pendingFreshPlacementCommit?.saveVerified === true) {
        await this.#completePendingPlacementCommitAfterReadback();
      }
      return normalizedResult;
      } catch (error) {
        if (parsed.name !== "pcb_save" && this.#pendingFreshPlacementCommit !== undefined) {
          return await this.#rollbackPendingPlacementCommitAfterFailure(error, `a ${parsed.name} call failed before atomic placement commit completed`);
        }
        if (providerCallable && this.#pendingFreshConnectivity !== undefined) {
          return await this.#rollbackPendingConnectivityAfterFailure(error, `a later ${parsed.name} call failed before mandatory save/native parity`);
        }
        throw error;
      }
    });
    this.#tail = run.then(() => undefined, () => undefined);
    return await run;
  }

  async #addPcbSilkscreenText(call: HarnessToolCall): Promise<HarnessToolResult> {
    if (this.#freshProject === undefined || this.#freshBoardPersistence === undefined) throw new Error("PCB text requires a verified fresh project and save/readback authority.");
    const requested = parsePcbSilkscreenText(call.arguments);
    if (this.#freshDesignContract !== undefined && (requested.x_mm > this.#freshDesignContract.scope.board.widthMm
        || requested.y_mm > this.#freshDesignContract.scope.board.heightMm)) throw new Error("PCB text anchor exceeds the host board bounds.");
    const before = await captureFreshPcb(this.#freshProject);
    const liveBefore = await freshActiveBoardSource(this.#session, this.#freshProject.pcbPath);
    if (!freshBoardSerializationsEqual(before.source, liveBefore)) throw new Error("PCB text requires matching saved and live board preimages.");
    this.#pendingFreshBoardPostSave = Object.freeze({ kind: "text", before: before.source, requested });
    try {
      const result = await this.#callSourceBoundTool("pcb_add_text", { ...requested });
      if (result.isError) throw new Error("Native PCB text insertion failed.");
      const expectedAfter = await freshActiveBoardSource(this.#session, this.#freshProject.pcbPath);
      assertOnlyRequestedPcbTextAdded(before.source, expectedAfter, requested);
      const diskAfter = await captureFreshPcb(this.#freshProject);
      if (!freshBoardSerializationsEqual(before.source, diskAfter.source)
          && !freshBoardSerializationsEqual(expectedAfter, diskAfter.source)) throw new Error("PCB disk changed outside the requested text mutation.");
      this.#pendingFreshBoardPostSave = Object.freeze({ kind: "text", before: before.source, requested, expectedAfter });
      this.#assertLibrarySources();
      return harnessToolResultSchema.parse({ toolCallId: call.id, content: resultContent(result, false, false) });
    } catch (error) {
      const detail = (error instanceof Error ? error.message : String(error)).slice(0, 1024);
      return await this.#rollbackPendingFreshBoardAfterFailure(error, `PCB text insertion failed exact source preservation (${detail})`);
    }
  }

  async #freshGetContractPadPositions(call: HarnessToolCall): Promise<HarnessToolResult> {
    const selection=parseFreshIncrementalArguments(call.name, call.arguments) as {readonly reference?:string;readonly pad?:string};
    const contract = this.#freshConnectivityContract!;
    const first = await captureFreshPcb(this.#freshProject!);
    if(this.#freshPhysicalFootprintResolver!==undefined){
      // Validate the complete source/native/library inventory before selecting
      // bounded provider-facing candidates; selection never narrows authority.
      const state=(await this.#physicalPadState(first,[]))!;
      const inventory=state.observation.inventory!;
      const components=contract.components.map(component=>({reference:component.reference,logicalTerminalCount:inventory.terminals.filter(t=>t.reference===component.reference).length,physicalPadCount:inventory.physicalPads.filter(p=>p.reference===component.reference).length}));
      if(selection.reference!==undefined&&!components.some(component=>component.reference===selection.reference))throw new Error("Selected physical-pad reference is not in the complete host contract.");
      const terminals=inventory.terminals.filter(terminal=>(selection.reference===undefined||terminal.reference===selection.reference)&&(selection.pad===undefined||terminal.number===selection.pad));
      if(selection.pad!==undefined&&terminals.length!==1)throw new Error("Selected logical terminal does not exist exactly once in the host contract.");
      const pads=state.pads.filter(pad=>(selection.reference===undefined||pad.reference===selection.reference)&&(selection.pad===undefined||pad.pad===selection.pad));
      const schemaVersion=this.#freshProject!.workflowKind==="plane"?FRESH_PLANE_PAD_POSITIONS_SCHEMA_VERSION:FRESH_PHYSICAL_PAD_POSITIONS_SCHEMA_VERSION;
      const common={schemaVersion,contractIdentity:contract.identity,...projectBindingResultFields(this.#freshProject!,first.projectBindingIdentity),freshMarkerContentIdentity:first.freshMarkerContentIdentity,pcbContentIdentity:first.contentIdentity,
        footprintLibraryTableIdentity:authoringProjectBinding(this.#freshProject!).footprintLibraryTableIdentity,nativePadSnapshotIdentity:state.observation.rawEnvelopeIdentity,physicalPadExpectedIdentity:state.observation.expectedIdentity,
        ...(this.#freshProject!.workflowKind==="plane"?{sourceContractIdentity:contract.sourceContractIdentity}:{}),
        boardCounts:physicalPadCounts(contract,first.parsed),selection:{reference:selection.reference??null,pad:selection.pad??null},components};
      const selectedTerminals=terminals.map(t=>({reference:t.reference,pad:t.number,net:t.net.names[0]??null,physicalPadIds:t.physicalPadUuids,copperCommon:"not-assessed"}));
      const payload={...common,status:"complete-selection" as const,selectedLogicalTerminalCount:terminals.length,selectedCandidateCount:pads.length,terminals:selectedTerminals,pads};
      let result:unknown={...payload,identity:canonicalIdentity(payload,schemaVersion)};
      if(JSON.stringify(result).length>MAX_RESULT_BYTES){
        const manifest={...common,status:"selection-required" as const,selectedLogicalTerminalCount:terminals.length,selectedCandidateCount:pads.length,
          availableTerminals:selection.reference===undefined?[]:terminals.map(t=>({pad:t.number,net:t.net.names[0]??null,physicalCandidateCount:t.physicalPadUuids.length})),
          instruction:selection.reference===undefined?"Call again with one exact reference; the complete private inventory was validated, but no candidate rows were truncated into this manifest.":"Call again with this reference and one exact pad; the complete private inventory was validated, but no candidate rows were truncated into this manifest."};
        result={...manifest,identity:canonicalIdentity(manifest,schemaVersion)};
      }
      return harnessToolResultSchema.parse({toolCallId:call.id,content:JSON.stringify(freezeDeep(result))});
    }
    if(selection.reference!==undefined||selection.pad!==undefined)throw new Error("Physical-pad selection requires the current private physical evidence capability.");
    const pads = exactContractPadPositions(this.#freshProject!, contract, first.parsed);
    const second = await captureFreshPcb(this.#freshProject!);
    if (!sameContentIdentity(first.contentIdentity, second.contentIdentity)) {
      throw new Error("Fresh PCB changed while exact contract pad positions were being derived.");
    }
    const secondPads = exactContractPadPositions(this.#freshProject!, contract, second.parsed);
    if (canonicalJson(pads) !== canonicalJson(secondPads)) {
      throw new Error("Fresh PCB pad geometry changed during independent source rebind.");
    }
    const payload = {
      schemaVersion: FRESH_CONTRACT_PAD_POSITIONS_SCHEMA_VERSION,
      contractIdentity: contract.identity,
      genericProjectBindingIdentity: first.projectBindingIdentity,
      freshMarkerContentIdentity: first.freshMarkerContentIdentity,
      pcbContentIdentity: first.contentIdentity,
      footprintLibraryTableIdentity: authoringProjectBinding(this.#freshProject!).footprintLibraryTableIdentity,
      pads,
    };
    const result: FreshContractPadPositions = freezeDeep({
      ...payload,
      identity: canonicalIdentity(payload, FRESH_CONTRACT_PAD_POSITIONS_SCHEMA_VERSION),
    });
    return harnessToolResultSchema.parse({ toolCallId: call.id, content: JSON.stringify(result) });
  }

  async #freshGetRouteItems(call: HarnessToolCall): Promise<HarnessToolResult> {
    parseFreshIncrementalArguments(call.name, call.arguments);
    const contract = this.#freshConnectivityContract!;
    const first = await captureFreshPcb(this.#freshProject!);
    exactContractPadPositions(this.#freshProject!, contract, first.parsed,this.#freshPhysicalFootprintResolver!==undefined);
    await this.#physicalPadState(first,[]);
    const firstSelection = buildRouteSelection(contract, first);
    const second = await captureFreshPcb(this.#freshProject!);
    exactContractPadPositions(this.#freshProject!, contract, second.parsed,this.#freshPhysicalFootprintResolver!==undefined);
    const secondSelection = buildRouteSelection(contract, second);
    if (!sameContentIdentity(first.contentIdentity, second.contentIdentity)
        || canonicalJson(firstSelection) !== canonicalJson(secondSelection)) {
      throw new Error("Fresh route selection changed during independent source rebind.");
    }
    this.#pendingFreshRouteSelection = firstSelection;
    return harnessToolResultSchema.parse({ toolCallId: call.id, content: JSON.stringify(firstSelection) });
  }

  async #freshReplaceRouteItems(call: HarnessToolCall): Promise<HarnessToolResult> {
    if(this.#session.supportsNativeRouteTransactions?.()!==true)throw new Error("Fresh route mutation requires the pinned native Commit ownership capability; name-only transaction tools are insufficient.");
    const contract = this.#freshConnectivityContract!;
    const design = this.#freshAuthoringDesignContract;
    if (design === undefined) throw new Error("Route replacement requires the generic PCB design contract.");
    const planeDesign=this.#freshPlaneDesignContract;
    const requestedArguments = (planeDesign===undefined?parseFreshIncrementalArguments(call.name, call.arguments):parsePlaneRouteMutationArguments(call.arguments)) as {
      readonly selectionIdentity: CanonicalIdentity;
      readonly net: string;
      readonly deleteItemIds: readonly string[];
      readonly tracks: readonly { readonly x1Mm: number; readonly y1Mm: number; readonly x2Mm: number; readonly y2Mm: number; readonly layer: "F.Cu" | "B.Cu" }[];
      readonly vias: readonly { readonly xMm: number; readonly yMm: number }[];
    };
    // Keep original call arguments intact. Native integer units are the one
    // materialized add plan used for validation, transport and exact readback.
    const nativeTracks=requestedArguments.tracks.map(track=>({x1Nm:routeMmToNativeNm(track.x1Mm),y1Nm:routeMmToNativeNm(track.y1Mm),x2Nm:routeMmToNativeNm(track.x2Mm),y2Nm:routeMmToNativeNm(track.y2Mm),layer:track.layer}));
    const nativeVias=requestedArguments.vias.map(via=>({xNm:routeMmToNativeNm(via.xMm),yNm:routeMmToNativeNm(via.yMm)}));
    const argumentsValue={...requestedArguments,
      tracks:nativeTracks.map(track=>({x1Mm:routeNativeNmToMm(track.x1Nm),y1Mm:routeNativeNmToMm(track.y1Nm),x2Mm:routeNativeNmToMm(track.x2Nm),y2Mm:routeNativeNmToMm(track.y2Nm),layer:track.layer})),
      vias:nativeVias.map(via=>({xMm:routeNativeNmToMm(via.xNm),yMm:routeNativeNmToMm(via.yNm)}))};
    const pending = this.#pendingFreshRouteSelection;
    this.#pendingFreshRouteSelection = undefined;
    if (pending === undefined || canonicalJson(argumentsValue.selectionIdentity) !== canonicalJson(pending.identity)) {
      throw new Error("Route replacement selection identity is missing, stale, replayed, or does not match the last host readback.");
    }
    const net = design.nets.find((entry) => entry.name === argumentsValue.net);
    const route = design.routingConstraints.nets.find((entry) => entry.net === argumentsValue.net);
    const netClass = net === undefined ? undefined : design.netClasses.find((entry) => entry.id === net.netClassId);
    if (net === undefined || route === undefined || netClass === undefined) throw new Error("Route replacement net is not an exact host-contract net.");
    const routeGeometry=route.topology==="plane"?route.accessRouting:route;
    const currentCapture = await captureFreshPcb(this.#freshProject!);
    const physicalMode=this.#freshPhysicalFootprintResolver!==undefined;
    const currentPhysical=await this.#physicalPadState(currentCapture,[]);
    const currentSelection = buildRouteSelection(contract, currentCapture);
    if (!sameContentIdentity(currentCapture.contentIdentity, pending.pcbContentIdentity)
        || canonicalJson(currentSelection.identity) !== canonicalJson(pending.identity)) {
      throw new Error("Route replacement source or item inventory changed after bounded read feedback.");
    }
    const byId = new Map(currentSelection.items.map((item) => [item.id, item]));
    const selected = argumentsValue.deleteItemIds.map((id) => byId.get(id));
    if (selected.some((item) => item === undefined)
        || selected.some((item) => item!.net !== net.name)) {
      throw new Error("Route replacement may delete only current track/via UUIDs on its one bound contract net.");
    }
    const withinBoard = (x: number, y: number): boolean => x >= 0 && y >= 0
      && x <= design.scope.board.widthMm && y <= design.scope.board.heightMm;
    for (const track of [...requestedArguments.tracks,...argumentsValue.tracks]) {
      if (!withinBoard(track.x1Mm, track.y1Mm) || !withinBoard(track.x2Mm, track.y2Mm)
          || !netClass.allowedLayers.includes(track.layer)
          || (routeGeometry.preferredLayer !== "either" && track.layer !== routeGeometry.preferredLayer)) {
        throw new Error("Replacement track exceeds board bounds or its net-class allowed layers.");
      }
      const dx = Math.abs(track.x2Mm - track.x1Mm);
      const dy = Math.abs(track.y2Mm - track.y1Mm);
      if (Math.hypot(dx, dy) <= ROUTE_GEOMETRY_EPSILON_MM
          || !(dx <= ROUTE_GEOMETRY_EPSILON_MM || dy <= ROUTE_GEOMETRY_EPSILON_MM || Math.abs(dx - dy) <= ROUTE_GEOMETRY_EPSILON_MM)) {
        throw new Error("Replacement tracks must be nonzero horizontal, vertical, or exact 45-degree segments.");
      }
    }
    const viaPolicy = design.routingConstraints.viaPolicy;
    if (viaPolicy.mode === "forbidden" && argumentsValue.vias.length > 0) {
      throw new Error("Replacement vias are forbidden by the host contract.");
    }
    if (argumentsValue.vias.length > 0 && (!netClass.allowedLayers.includes("F.Cu") || !netClass.allowedLayers.includes("B.Cu"))) {
      throw new Error("Replacement through vias require both copper layers in the net-class allowed-layer set.");
    }
    for (const via of [...requestedArguments.vias,...argumentsValue.vias]) if (!withinBoard(via.xMm, via.yMm)) {
      throw new Error("Replacement via exceeds the board bounds.");
    }
    const remainingViaCount = currentSelection.items.filter((item) => item.kind === "via" && !argumentsValue.deleteItemIds.includes(item.id)).length;
    if (viaPolicy.mode === "bounded" && (remainingViaCount + argumentsValue.vias.length > viaPolicy.maxTotal
        || currentSelection.items.filter((item) => item.kind === "via" && item.net === net.name && !argumentsValue.deleteItemIds.includes(item.id)).length
          + argumentsValue.vias.length > routeGeometry.maxVias)) {
      throw new Error("Replacement vias exceed the global or per-net contract bound.");
    }
    if(planeDesign!==undefined){
      const proposed:FreshRouteSelectionItem[]=[...currentSelection.items.filter(item=>!argumentsValue.deleteItemIds.includes(item.id)),
        ...argumentsValue.tracks.map((track,index):FreshRouteSelectionItem=>({kind:"track",id:`proposed-track-${index}`,net:net.name,start:{xMm:track.x1Mm,yMm:track.y1Mm},end:{xMm:track.x2Mm,yMm:track.y2Mm},layer:track.layer,widthMm:netClass.traceWidthMm})),
        ...argumentsValue.vias.map((via,index):FreshRouteSelectionItem=>({kind:"via",id:`proposed-via-${index}`,net:net.name,at:{xMm:via.xMm,yMm:via.yMm},layers:["F.Cu","B.Cu"],diameterMm:viaPolicy.mode==="bounded"?viaPolicy.diameterMm:0,drillMm:viaPolicy.mode==="bounded"?viaPolicy.drillMm:0}))];
      assertPlaneIncrementalRouteGeometry(planeDesign,net.name,proposed,currentPhysical!.pads);
    }

    await this.#freshBoardPersistence!.capturePreMutation(this.#session);
    let transactionStarted = false;
    let transactionPushed = false;
    let firstOperation="pre-begin-source-fence";
    let acceptedStagedSource:string|undefined;
    try {
      const lockedCapture = await captureFreshPcb(this.#freshProject!);
      const lockedSelection = buildRouteSelection(contract, lockedCapture);
      if (!sameContentIdentity(lockedCapture.contentIdentity, currentCapture.contentIdentity)
          || canonicalJson(lockedSelection.identity) !== canonicalJson(currentSelection.identity)) {
        throw new Error("Route replacement source changed while the exact rollback preimage was being captured.");
      }
      const liveBeforeSource = await freshActiveBoardSource(this.#session, this.#freshProject!.pcbPath);
      if (!freshBoardSerializationsEqual(liveBeforeSource, lockedCapture.source)) {
        throw new Error("Live KiCad route source differs from the exact marker-bound disk preimage before mutation.");
      }
      firstOperation="pcb_begin_commit";
      const begun=await this.#callSourceBoundTool("pcb_begin_commit", {});
      if(!hasQualifiedNativeBoardReply(begun,"Transaction group started. Use pcb_push_commit to apply or pcb_drop_commit to discard."))throw new Error("Native begin lacks its qualified positive acknowledgement.",{cause:nativeReplyCause("pcb_begin_commit",begun)});
      transactionStarted = true;
      if(planeDesign===undefined||argumentsValue.deleteItemIds.length>0){firstOperation="pcb_delete_items";assertSuccessfulSidecarMutation(
        await this.#callSourceBoundTool("pcb_delete_items", { item_ids: [...argumentsValue.deleteItemIds] }),
        "pcb_delete_items",
      );}
      for (const [index,track] of argumentsValue.tracks.entries()) {
        firstOperation=`pcb_add_track[${index}]`;
        const native=nativeTracks[index]!;
        assertSuccessfulSidecarMutation(await this.#callSourceBoundTool("pcb_add_track", {
          x1_mm: routeNativeNmToKipyMm(native.x1Nm), y1_mm: routeNativeNmToKipyMm(native.y1Nm), x2_mm: routeNativeNmToKipyMm(native.x2Nm), y2_mm: routeNativeNmToKipyMm(native.y2Nm),
          layer: normalizeLayer(track.layer), width_mm: netClass.traceWidthMm, net_name: net.name,
        }), "pcb_add_track");
      }
      for (const [index,via] of argumentsValue.vias.entries()) {
        firstOperation=`pcb_add_via[${index}]`;
        if (viaPolicy.mode !== "bounded") throw new Error("Internal via-policy narrowing failed.");
        const native=nativeVias[index]!;
        assertSuccessfulSidecarMutation(await this.#callSourceBoundTool("pcb_add_via", {
          x_mm: routeNativeNmToKipyMm(native.xNm), y_mm: routeNativeNmToKipyMm(native.yNm), diameter_mm: viaPolicy.diameterMm, drill_mm: viaPolicy.drillMm,
          net_name: net.name, via_type: "through", from_layer: "", to_layer: "",
        }), "pcb_add_via");
      }
      firstOperation="pcb_push_commit";
      const pushed=await this.#callSourceBoundTool("pcb_push_commit", {});
      if(!hasQualifiedNativeBoardReply(pushed,"Transaction group committed successfully."))throw new Error("Native push lacks its qualified positive acknowledgement.",{cause:nativeReplyCause("pcb_push_commit",pushed)});
      transactionPushed = true;

      firstOperation="post-push-source-readback";
      const liveSource = await freshActiveBoardSource(this.#session, this.#freshProject!.pcbPath);
      const liveCapture: FreshPcbCapture = {
        source: liveSource,
        contentIdentity: Object.freeze(contentIdentity(liveSource)),
        projectBindingIdentity: currentCapture.projectBindingIdentity,
        freshMarkerContentIdentity: currentCapture.freshMarkerContentIdentity,
        parsed: parseFreshPcbSource(liveSource),
      };
      const pads = exactContractPadPositions(this.#freshProject!, contract, liveCapture.parsed,physicalMode);
      if(physicalMode){
        // This is unsaved live source: validate its library geometry, but do not
        // mint a saved/native observation until the mandatory save completes.
        bindKicadPhysicalFootprintLibraries(liveCapture.parsed,this.#physicalExpected(liveCapture,[]));
        const physicalState=(board:FreshParsedPcb)=>board.footprints.map(fp=>({...fp,pads:fp.pads.map(({physical,...pad})=>{const {source:_source,...facts}=physical;return {...pad,physical:facts};})}));
        if(canonicalJson(physicalState(currentCapture.parsed))!==canonicalJson(physicalState(liveCapture.parsed)))throw new Error("Route replacement changed footprint geometry or physical pad metadata outside its selected route items.");
      }
      const afterSelection = buildRouteSelection(contract, liveCapture);
      for (const id of argumentsValue.deleteItemIds) if (afterSelection.items.some((item) => item.id === id)) {
        throw new Error(`Deleted route UUID ${id} remains in live readback.`);
      }
      const unaffected = currentSelection.items.filter((item) => !argumentsValue.deleteItemIds.includes(item.id));
      for (const item of unaffected) {
        const after = afterSelection.items.find((candidate) => candidate.id === item.id);
        if (after === undefined || canonicalJson(after) !== canonicalJson(item)) {
          throw new Error("Atomic route replacement changed an unselected route item.");
        }
      }
      const newItems = afterSelection.items.filter((item) => !byId.has(item.id));
      if (newItems.length !== argumentsValue.tracks.length + argumentsValue.vias.length) {
        throw new Error("Atomic route replacement added an unexpected number or kind of route items.");
      }
      const expectedTrackKeys = nativeTracks.map((track) => canonicalJson({
        kind: "track", net: net.name,
        start: { xNm: track.x1Nm, yNm: track.y1Nm }, end: { xNm: track.x2Nm, yNm: track.y2Nm },
        widthNm: routeMmToNativeNm(netClass.traceWidthMm), layer: track.layer,
      })).sort();
      const actualTrackKeys = newItems.filter((item) => item.kind === "track").map(item=>canonicalJson({kind:item.kind,net:item.net,start:{xNm:routeSourceMmToNativeNm(item.start.xMm),yNm:routeSourceMmToNativeNm(item.start.yMm)},end:{xNm:routeSourceMmToNativeNm(item.end.xMm),yNm:routeSourceMmToNativeNm(item.end.yMm)},widthNm:routeSourceMmToNativeNm(item.widthMm),layer:item.layer})).sort();
      const expectedViaKeys = nativeVias.map((via) => canonicalJson({
        kind: "via", net: net.name, at: { xNm: via.xNm, yNm: via.yNm },
        diameterNm: viaPolicy.mode === "bounded" ? routeMmToNativeNm(viaPolicy.diameterMm) : 0,
        drillNm: viaPolicy.mode === "bounded" ? routeMmToNativeNm(viaPolicy.drillMm) : 0,
        layers: ["F.Cu", "B.Cu"],
      })).sort();
      const actualViaKeys = newItems.filter((item) => item.kind === "via").map(item=>canonicalJson({kind:item.kind,net:item.net,at:{xNm:routeSourceMmToNativeNm(item.at.xMm),yNm:routeSourceMmToNativeNm(item.at.yMm)},diameterNm:routeSourceMmToNativeNm(item.diameterMm),drillNm:routeSourceMmToNativeNm(item.drillMm),layers:item.layers})).sort();
      if (canonicalJson(expectedTrackKeys) !== canonicalJson(actualTrackKeys)
          || canonicalJson(expectedViaKeys) !== canonicalJson(actualViaKeys)) {
        throw new Error("Atomic route replacement geometry differs from the host-derived add plan.");
      }
      if(planeDesign!==undefined){
        assertPlaneRouteSourcePreservation(currentCapture.source,liveSource,argumentsValue.deleteItemIds,newItems.map(item=>item.id));
        assertPlaneIncrementalRouteGeometry(planeDesign,net.name,afterSelection.items,currentPhysical!.pads);
      }
      else assertCleanReplacementRoute(
        this.#freshDesignContract!,
        this.#freshCompilationBundle!.practiceProfileBinding.profile,
        net.name,
        afterSelection,
        pads,
        liveSource,
      );
      acceptedStagedSource=liveSource;
      this.#pendingFreshBoardPostSave = planeDesign!==undefined?Object.freeze({kind:"plane-route" as const,before:currentCapture,contract,design:planeDesign,net:net.name,expectedItems:freezeDeep(structuredClone(afterSelection.items)),physicalPcbSource:liveSource}):Object.freeze({
        kind: "route" as const,
        before:currentCapture,
        contract,
        design:this.#freshDesignContract!,
        net: net.name,
        expectedItems: freezeDeep(structuredClone(afterSelection.items)),
        ...(physicalMode?{physicalPcbSource:liveSource}:{}),
      });
      const payload = {
        schemaVersion: planeDesign===undefined?FRESH_ROUTE_REPLACEMENT_RESULT_SCHEMA_VERSION:FRESH_PLANE_ROUTE_MUTATION_SCHEMA_VERSION,
        contractIdentity: contract.identity,
        ...projectBindingResultFields(this.#freshProject!,liveCapture.projectBindingIdentity),
        ...(planeDesign===undefined?{}:{sourceContractIdentity:contract.sourceContractIdentity,completion:"not_evaluated" as const,connection:"not_evaluated" as const,mutationValidity:"verified" as const,scope:PLANE_ROUTE_MUTATION_SCOPE,notEvaluated:PLANE_ROUTE_NOT_EVALUATED}),
        freshMarkerContentIdentity: liveCapture.freshMarkerContentIdentity,
        applied: true,
        mutated: true,
        idempotent: false,
        selectionIdentity: pending.identity,
        beforePcbContentIdentity: currentCapture.contentIdentity,
        livePcbContentIdentity: liveCapture.contentIdentity,
        net: net.name,
        deletedItemIds: [...argumentsValue.deleteItemIds].sort(),
        addedTrackCount: argumentsValue.tracks.length,
        addedViaCount: argumentsValue.vias.length,
        issues: [] as const,
      };
      return harnessToolResultSchema.parse({
        toolCallId: call.id,
        content: JSON.stringify(freezeDeep({ ...payload, identity: canonicalIdentity(payload, payload.schemaVersion) })),
      });
    } catch (error) {
      return await this.#routeMutationFailure(call,net.name,currentCapture,acceptedStagedSource,firstOperation,error,transactionStarted,transactionPushed);
    }
  }

  async #freshAutoplaceSchematicFields(call: HarnessToolCall): Promise<HarnessToolResult> {
    parseFreshIncrementalArguments(call.name, call.arguments);
    if (this.#freshProject === undefined || !contractAuthoringProject(this.#freshProject) || this.#freshAuthoringDesignContract === undefined
        || this.#captureFreshNativeNetlist === undefined || this.#freshSchematicRollback === undefined) {
      throw new Error("Schematic field repair requires a generic marker-bound project and host-native parity capture.");
    }
    if (this.#pendingFreshConnectivity !== undefined || this.#pendingFreshBoardPostSave !== undefined) {
      throw new Error("Save and validate the prior governed mutation before starting explicit schematic field repair.");
    }
    if (!this.#session.listTools().some((tool) => tool.name === "sch_autoplace_fields")) {
      throw new Error("KiCad sidecar did not advertise required host-only sch_autoplace_fields capability.");
    }
    const contract = this.#freshConnectivityContract!;
    const references = contract.components.map((component) => component.reference).sort();
    const fieldPlanningWork = createFreshSchematicPlanningWork(new FreshSchematicWorkBudget(this.#freshSchematicWorkLimit));
    const snapshot = await this.#readFreshPlacementSnapshot(contract, fieldPlanningWork);
    const beforeBytes = await readFile(this.#freshProject.schematicPath);
    const beforeSource = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(beforeBytes);
    if (beforeSource !== snapshot.schematic) throw new Error("Schematic source changed while field repair was binding its geometry.");
    const beforeIdentity = contentIdentity(beforeBytes);
    const beforeParsed = parseFreshSchematicSource(beforeSource);
    assertFreshGenericSchematicSource(beforeParsed);
    const fieldPartition = snapshot.sourceTerminals?.result.status === "complete" ? snapshot.sourceTerminals.result.value : undefined;
    const labelPlan = planFreshContractGeometry(contract, snapshot.pins, snapshot.boxes, fieldPlanningWork, true, fieldPartition);
    if (labelPlan.issues.length !== 0 || !exactFreshContractLabelsMatch(beforeSource, labelPlan.labels, true)) {
      throw new Error("Field-only repair requires the exact previously authored passive-global terminal inventory; it cannot repair terminal placement.");
    }
    const noConnectPoints = contract.noConnects.map((endpoint) => ({ endpoint, point: snapshot.pins.get(endpointId(endpoint))! }));
    if (!freshPersistedNoConnectsMatch(beforeSource, noConnectPoints.map((entry) => entry.point))) {
      throw new Error("Field-only repair requires the exact contract no-connect inventory.");
    }
    const presentation = parseFreshSchematicPresentationSource(beforeSource);
    const targets = presentation.symbolFields.filter((field) => field.sourcePresent && !field.hidden).map((field) => ({ symbolIndex: field.symbolIndex, kind: field.kind }));
    if (targets.length === 0) throw new Error("No existing visible Reference/Value fields are available for explicit field repair.");
    // Validate eligible paths before authorizing the sidecar. The comparator
    // retains all raw tokens outside exactly these source-owned layout paths.
    compareFreshSchematicFieldPresentationSources(beforeSource, beforeSource, beforeIdentity, targets);
    const assertSource = async (expected: Buffer): Promise<void> => {
      if (!(await readFile(this.#freshProject!.schematicPath)).equals(expected)) throw new Error("Exact schematic bytes changed during field repair or native parity capture.");
    };
    const beforeNative = await this.#captureFreshNativeNetlist();
    await assertSource(beforeBytes);
    const beforeIssues = freshNativeNetlistParityIssues(contract, beforeNative);
    if (beforeIssues.length > 0) throw new Error(`Field repair requires exact pre-mutation native contract parity: ${beforeIssues.map((issue) => issue.code).join(", ")}.`);
    const baseline = await this.#freshSchematicRollback.capture(beforeSource);
    try {
      const result = await this.#callSourceBoundTool("sch_autoplace_fields", { references, dry_run: false });
      assertSuccessfulSidecarMutation(result, "sch_autoplace_fields");
      // One exact positive completion line; prose about a failed/unsupported
      // operation or a dry run cannot authorize a successful field mutation.
      const completed = preferredResultText(result).split(/\r?\n/u).map((line) => line.trim())
        .map((line) => /^Auto-placed Reference\/Value fields on (\d+) symbol\(s\)(?:: ([^.]+))?\.$/u.exec(line)).filter((match) => match !== null);
      if (completed.length !== 1) throw new Error("Schematic field repair lacks one exact supported completion summary.");
      const reportedCount = Number(completed[0]![1]);
      const reportedRefs = completed[0]![2]?.split(", ") ?? [];
      if (!Number.isSafeInteger(reportedCount) || reportedCount !== reportedRefs.length
          || new Set(reportedRefs).size !== reportedRefs.length || reportedRefs.some((reference) => !references.includes(reference))) {
        throw new Error("Schematic field repair completion references/count do not match the exact contract scope.");
      }
      const afterBytes = await readFile(this.#freshProject.schematicPath);
      const afterSource = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(afterBytes);
      const comparison = compareFreshSchematicFieldPresentationSources(beforeSource, afterSource, beforeIdentity, targets);
      if (!comparison.equal) throw new Error("Schematic field repair changed source outside existing visible Reference/Value positions and positional justification.");
      if (comparison.changedFieldCount > reportedCount * 2 || reportedCount === 0 && comparison.changedFieldCount !== 0) {
        throw new Error("Schematic field repair completion count contradicts actual changed fields.");
      }
      const afterPresentation = parseFreshSchematicPresentationSource(afterSource);
      const layout = (field: (typeof presentation.symbolFields)[number]): unknown => ({ at: field.at, rotationDeg: field.rotationDeg, justify: field.justify });
      for (const field of presentation.symbolFields) {
        const afterField = afterPresentation.symbolFields.find((entry) => entry.symbolIndex === field.symbolIndex && entry.kind === field.kind);
        if (afterField === undefined || canonicalJson(layout(field)) !== canonicalJson(layout(afterField))) {
          if (field.reference === null || !reportedRefs.includes(field.reference)) throw new Error("Schematic field repair completion omits a reference whose field layout actually changed.");
        }
      }
      assertFreshGenericSchematicSource(parseFreshSchematicSource(afterSource));
      const afterNative = await this.#captureFreshNativeNetlist();
      await assertSource(afterBytes);
      const afterIssues = freshNativeNetlistParityIssues(contract, afterNative);
      if (afterIssues.length > 0) throw new Error(`Field repair changed native contract parity: ${afterIssues.map((issue) => issue.code).join(", ")}.`);
      await this.#assertFreshCompoundAuthority();
      await assertSource(afterBytes);
      const afterIdentity = contentIdentity(afterBytes);
      const mutated = !beforeBytes.equals(afterBytes);
      if (mutated) this.#pendingFreshConnectivity = {
        contract, baseline, noConnectPoints, labelAnchors: labelPlan.labels, fieldLayoutAfterContentIdentity: afterIdentity,
      };
      const payload = {
        schemaVersion: "evleda.fresh-schematic-fields-result.v1" as const,
        contractIdentity: contract.identity, applied: true, mutated, idempotent: !mutated,
        beforeSchematicContentIdentity: beforeIdentity, afterSchematicContentIdentity: afterIdentity,
        references, movedFieldCount: comparison.changedFieldCount, nativeNetlistSha256: sha256(afterNative), issues: [] as const,
      };
      return harnessToolResultSchema.parse({ toolCallId: call.id, content: JSON.stringify(freezeDeep({
        ...payload, identity: canonicalIdentity(payload, payload.schemaVersion),
      })) });
    } catch (error) {
      this.#pendingFreshConnectivity = undefined;
      try { await this.#freshSchematicRollback.restore(baseline); }
      catch (rollbackError) {
        throw new Error(`FRESH_CONNECTIVITY_ROLLBACK_FAILED_TERMINAL: explicit field repair failed and exact schematic rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}.`, { cause: error });
      }
      throw new Error(`FRESH_CONNECTIVITY_ROLLED_BACK_TERMINAL: explicit field repair failed: ${error instanceof Error ? error.message : String(error)}. Exact schematic preimage restored; the editing session must close without retry.`, { cause: error });
    }
  }

  async #knownBoardMutationState(before:FreshPcbCapture, staged:string|undefined, saving=false) {
    const disk=await captureFreshPcb(this.#freshProject!);
    const live=await freshActiveBoardSource(this.#session,this.#freshProject!.pcbPath);
    const settled=await captureFreshPcb(this.#freshProject!);
    if(!sameContentIdentity(disk.contentIdentity,settled.contentIdentity))throw new Error("Plane disk changed during state fence.");
    const known=(source:string)=>freshBoardSerializationsEqual(source,before.source)||(staged!==undefined&&freshBoardSerializationsEqual(source,staged));
    if(!known(disk.source)||!known(live)||saving&&(staged===undefined||!freshBoardSerializationsEqual(live,staged)))throw new Error("Plane current disk/live state is outside the known preimage or fully accepted stage; preserve external/unknown changes.");
    return {disk,live};
  }
  async #planeKnownState(before:FreshPcbCapture, observation:ReturnType<typeof validateFreshPlaneStageObservation>|undefined, saving=false){
    return await this.#knownBoardMutationState(before,observation?.nativeSourceStaged,saving);
  }

  async #planeRuleSources(){
    if(!isVerifiedPlaneFreshProject(this.#freshProject))throw new Error("Plane settings require genuine project authority.");
    const read=async(file:string)=>{
      const before=await lstat(file,{bigint:true});
      if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>4n*1024n*1024n||await realpath(file)!==file)throw new Error("Plane settings must be bounded ordinary project files.");
      const bytes=await readFile(file),after=await lstat(file,{bigint:true});
      if(!after.isFile()||after.isSymbolicLink()||after.nlink!==1n||before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeNs!==after.mtimeNs||BigInt(bytes.length)!==after.size)throw new Error("Plane settings changed during capture.");
      return bytes;
    };
    const [projectSettings,rules]=await Promise.all([read(path.join(this.#freshProject.projectPath,`${this.#freshProject.name}.kicad_pro`)),read(this.#freshProject.rulesPath)]);
    return {projectSettings,rules,projectSettingsIdentity:contentIdentity(projectSettings),rulesIdentity:contentIdentity(rules)};
  }

  async #assertPlaneFillInputs(pending:Pick<PendingFreshPlaneApply,"before"|"projectSettingsIdentity"|"rulesIdentity"|"sourceScopeIdentity">,
    expectedPcbIdentity:ContentIdentity=pending.before.contentIdentity){
    const current=await this.#planeRuleSources(),capture=await captureFreshPcb(this.#freshProject!);
    if(!sameContentIdentity(capture.contentIdentity,expectedPcbIdentity)||!sameContentIdentity(current.projectSettingsIdentity,pending.projectSettingsIdentity)||!sameContentIdentity(current.rulesIdentity,pending.rulesIdentity)
      ||!sameContentIdentity(capture.freshMarkerContentIdentity,pending.before.freshMarkerContentIdentity)
      ||canonicalJson(capture.projectBindingIdentity)!==canonicalJson(pending.before.projectBindingIdentity)
      ||canonicalJson(this.#physicalExpected(capture,[]).scopeIdentity)!==canonicalJson(pending.sourceScopeIdentity))throw new Error("Plane fill settings or project scope changed across native fill/save.");
    this.#assertLibrarySources();
    return current;
  }

  async #routeMutationFailure(call:HarnessToolCall,net:string,before:FreshPcbCapture,acceptedStaged:string|undefined,firstOperation:string,error:unknown,transactionStarted:boolean,transactionPushed:boolean):Promise<never>{
    const primary:Array<{name:string;message:string;detail?:{jsonPrefix:string;truncated:boolean;contentIdentity:ContentIdentity}}>=[];const seen=new Set<unknown>();let cause:unknown=error;
    for(let depth=0;depth<4&&cause!==undefined&&!seen.has(cause);depth++){
      seen.add(cause);
      let detail:{jsonPrefix:string;truncated:boolean;contentIdentity:ContentIdentity}|undefined;
      if(cause!==null&&typeof cause==="object"&&!(cause instanceof Error)){
        try{
          const visited=new Set<object>();
          const serialized=JSON.stringify(cause,(_key,value:unknown)=>{
            if(value!==null&&typeof value==="object"){
              if(visited.has(value))return "[circular-reference]";visited.add(value);
              if(value instanceof Error)return {name:value.name,message:value.message,...(value.cause===undefined?{}:{cause:value.cause})};
            }
            return value;
          });
          if(serialized!==undefined){const bytes=Buffer.from(serialized,"utf8");detail={jsonPrefix:bytes.subarray(0,4096).toString("utf8"),truncated:bytes.length>4096,contentIdentity:contentIdentity(bytes)};}
        }catch{/* The typed message/cause chain remains available if detail cannot be serialized. */}
      }
      primary.push({name:(cause instanceof Error?cause.name:"NativeErrorEvidence").slice(0,160),message:(cause instanceof Error?cause.message:detail?.jsonPrefix??String(cause)).replace(/\s+/gu," ").slice(0,1600),...(detail===undefined?{}:{detail})});
      cause=cause instanceof Error?cause.cause:undefined;
    }
    const cleanup:Array<{operation:string;status:string;message:string}>=[];let recovery="pending";
    const publish=async(phase:FreshRouteMutationDiagnostic["phase"])=>{
      const payload={schemaVersion:"evleda.fresh-route-mutation-diagnostic.v1" as const,phase,toolCallId:call.id.slice(0,256),net,firstOperation,
        primary:structuredClone(primary),beforePcbContentIdentity:before.contentIdentity,transactionStarted,transactionPushed,cleanup:structuredClone(cleanup),recovery};
      const diagnostic=freezeDeep({...payload,identity:canonicalIdentity(payload,payload.schemaVersion)});
      this.#freshRouteMutationDiagnostics.push(diagnostic);if(this.#freshRouteMutationDiagnostics.length>16)this.#freshRouteMutationDiagnostics.shift();
      try{await this.#observeFreshRouteMutationDiagnostic?.(diagnostic);}catch{/* Diagnostics cannot replace the primary fault. */}
    };
    // Capture the original operation/error before any cleanup can fail or close
    // a transport. The public terminal message also retains this first cause.
    await publish("primary-failure");
    this.#routeRecoveryRequired=true;
    try{this.#session.quarantineNativeRouteTransaction?.(error);}catch(fault){cleanup.push({operation:"quarantine",status:"failed",message:String(fault).slice(0,800)});}
    const plane=before.projectBindingIdentity.schemaVersion==="evleda.pcb-agent-plane-fresh-binding.v1";
    try{
      if(plane)await this.#knownBoardMutationState(before,acceptedStaged);
      if(transactionStarted&&!transactionPushed){
        const dropped=await this.#session.callTool("pcb_drop_commit",{});
        if(!hasQualifiedNativeBoardReply(dropped,"Transaction group discarded successfully."))throw new Error("Native drop lacks its qualified positive acknowledgement.",{cause:nativeReplyCause("pcb_drop_commit",dropped)});
        cleanup.push({operation:"pcb_drop_commit",status:"acknowledged",message:""});
      }
      if(plane){
        const state=await this.#knownBoardMutationState(before,acceptedStaged);
        await this.#freshBoardPersistence!.rollbackToPreMutation(this.#session,{expectedDiskSource:state.disk.source,expectedLiveSource:state.live});
      }else await this.#freshBoardPersistence!.rollbackToPreMutation(this.#session);
      cleanup.push({operation:"pcb_revert",status:"verified-preimage",message:""});recovery="restored-known-preimage";
    }catch(fault){
      cleanup.push({operation:transactionStarted&&!transactionPushed&&!cleanup.some(item=>item.operation==="pcb_drop_commit")?"drop-or-state-fence":"rollback-or-state-fence",status:"failed-or-unproven",message:(fault instanceof Error?fault.message:String(fault)).replace(/\s+/gu," ").slice(0,1000)});
      recovery="preserved-state-recovery-required";
    }
    this.#pendingFreshBoardPostSave=undefined;this.#pendingFreshRouteSelection=undefined;this.#pendingPersistedMutationBaseline=undefined;
    await publish("recovery-finished");
    const last=this.#freshRouteMutationDiagnostics.at(-1)!;
    const first=primary[0]??{name:"UnknownError",message:"Unknown native failure"};
    const prefix=recovery==="restored-known-preimage"?"FRESH_ROUTE_REPLACEMENT_ROLLED_BACK_TERMINAL":"FRESH_ROUTE_REPLACEMENT_ROLLBACK_FAILED_TERMINAL";
    const terminal=new Error(`${prefix}: primary ${firstOperation}: ${first.name}: ${first.message}. Recovery: ${recovery}. ${cleanup.filter(item=>item.status==="failed-or-unproven").map(item=>`${item.operation}: ${item.message}`).join(" ")} Editing session must close.`,{cause:error});
    Object.defineProperty(terminal,"routeDiagnostic",{value:last,enumerable:false});
    throw terminal;
  }

  async #planeApplyFailure(call:HarnessToolCall,before:FreshPcbCapture,observation:ReturnType<typeof validateFreshPlaneStageObservation>|undefined,stage:string,error:unknown):Promise<HarnessToolResult>{
    this.#savedFreshPlaneEvidence=undefined;
    this.#planeRecoveryRequired=true;
    this.#pendingFreshBoardPostSave=undefined;this.#pendingFreshRouteSelection=undefined;
    this.#pendingPersistedMutationBaseline=undefined;this.#pendingSchematicFileMutationBatch=undefined;
    let rollback="not-attempted-unknown-or-external-state";
    try{
      const state=await this.#planeKnownState(before,observation);
      if(freshBoardSerializationsEqual(state.disk.source,before.source)&&freshBoardSerializationsEqual(state.live,before.source)
          ||observation!==undefined&&isValidatedFreshPlaneStageObservation(observation)){
        // Unfill/refill can dirty an editor without changing serialized bytes.
        // A positively known preimage still requires native revert/settlement.
        rollback="attempted";
        await this.#freshBoardPersistence!.rollbackToPreMutation(this.#session,{expectedDiskSource:state.disk.source,expectedLiveSource:state.live});
        rollback="restored-known-preimage";
      }
    }catch{if(rollback==="attempted")rollback="guarded-recovery-failed-state-preserved";}
    const payload={schemaVersion:FRESH_PLANE_APPLY_FAILURE_SCHEMA_VERSION,stage,code:"PLANE_APPLY_TERMINAL",recoveryRequired:true,rollback,
      editingSessionMustClose:true,beforePcbContentIdentity:before.contentIdentity,
      acceptedStagedPcbContentIdentity:observation===undefined?null:contentIdentity(observation.nativeSourceStaged),
      message:(error instanceof Error?error.message:String(error)).replace(/\s+/gu," ").slice(0,1200)};
    return harnessToolResultSchema.parse({toolCallId:call.id,isError:true,content:JSON.stringify({...payload,identity:canonicalIdentity(payload,payload.schemaVersion)})});
  }

  async #freshApplyContractPlane(call:HarnessToolCall):Promise<HarnessToolResult>{
    const args=parseFreshPlaneApplyArguments(call.arguments);
    if(this.#planeRecoveryRequired||this.#pendingFreshBoardPostSave!==undefined)throw new Error("Plane apply cannot execute after quarantine or before the prior board stage is saved.");
    if(!isVerifiedPlaneFreshProject(this.#freshProject)||this.#freshPlaneCompilationBundle===undefined||this.#session.supportsPlaneStage?.()!==true||typeof this.#session.stagePlane!=="function")throw new Error("Plane apply requires the genuine V2 project and available private native stage capability; DOC3 authoring/routes remain separate.");
    if(this.#pendingFreshConnectivity!==undefined||this.#pendingFreshPlacementCommit!==undefined||this.#pendingSchematicFileMutationBatch!==undefined)throw new Error("Save and validate prior schematic mutations before plane staging.");
    const bundle=this.#freshPlaneCompilationBundle;
    const plane=args.planeId===undefined?bundle.contract.planes[0]:bundle.contract.planes.find(p=>p.id===args.planeId);
    if(plane===undefined)throw new Error("Unknown exact contract planeId.");
    const before=await captureFreshPcb(this.#freshProject);
    const ruleSources=await this.#planeRuleSources();
    const fillInputs={before,projectSettingsIdentity:ruleSources.projectSettingsIdentity,rulesIdentity:ruleSources.rulesIdentity,
      sourceScopeIdentity:this.#physicalExpected(before,[]).scopeIdentity};
    if(!sameContentIdentity(ruleSources.rulesIdentity,createFreshPlaneRules(bundle).identity))throw new Error("Plane fill requires its exact canonical V2 rules.");
    const liveBefore=await freshActiveBoardSource(this.#session,this.#freshProject.pcbPath);
    if(!freshBoardSerializationsEqual(before.source,liveBefore))throw new Error("Plane apply requires matching saved/live preimages.");
    const physical=(await this.#physicalPadState(before,[]))!;
    const zoneName=createFreshPlaneRules(bundle).zones.find(zone=>zone.planeId===plane.id)!.zoneName;
    const named=parseFreshPcbReferenceGeometry(before.source).zones.filter(zone=>zone.settings.some(setting=>setting.name==="name"&&setting.values.length===1&&setting.values[0]!.value===zoneName));
    if(named.length>1||named.some(zone=>zone.uuid===null))throw new Error("Declared plane name has ambiguous or missing native UUID ownership.");
    const prepared=prepareFreshPlaneMutation({compilationBundle:bundle,beforePcbSource:before.source,planeId:plane.id,
      ...(named.length===0?{operation:"create" as const}:{operation:"update" as const,zoneId:named[0]!.uuid!})});
    const referencePads=physical.pads.filter(pad=>pad.net===plane.net).map(pad=>({reference:pad.reference,pad:pad.pad,primitiveId:pad.physical!.id}));
    if(referencePads.length===0||referencePads.length>128||prepared.beforeZoneUuids.length>32)throw new Error("Plane stage exceeds its complete reference-pad or zone inventory bound; no references were truncated.");
    const request:KicadPlaneStageInput={board_file:this.#freshProject.pcbPath,zone_ids:[...prepared.beforeZoneUuids],reference_pads:referencePads,
      request:{expectedSavedIdentity:before.contentIdentity,expectedLiveIdentity:contentIdentity(liveBefore),mutation:prepared.mutation}};
    let observation:ReturnType<typeof validateFreshPlaneStageObservation>|undefined;
    await this.#freshBoardPersistence!.capturePreMutation(this.#session);
    try{
      const locked=await this.#planeKnownState(before,undefined);
      if(!sameContentIdentity(locked.disk.contentIdentity,before.contentIdentity)||locked.live!==liveBefore)throw new Error("Plane preimage changed immediately before native dispatch.");
      await this.#assertFreshCompoundAuthority();
      if(this.#session.supportsPlaneStage?.()!==true)throw new Error("Private plane stage capability is no longer ready.");
      await this.#assertPlaneFillInputs(fillInputs);
      this.#assertLibrarySources();
      const receipt=await this.#session.stagePlane(request);
      const candidate=validateFreshPlaneStageObservation(receipt,{request,prepared,padExpected:this.#physicalExpected(before,referencePads.map(pad=>pad.primitiveId))});
      if(!isValidatedFreshPlaneStageObservation(candidate)||!candidate.comparison.valid)throw new Error("Plane stage did not produce validated mutation/source/epoch observations.");
      observation=candidate;
      const stagedBoard=parseFreshPcbSource(observation.nativeSourceStaged);
      exactContractPadPositions(this.#freshProject,this.#freshConnectivityContract!,stagedBoard,true);
      if(observation.nativePads.inventory===null||observation.nativePads.inventory.unsupportedPhysicalUuids.length!==0||observation.nativePads.inventory.terminals.length!==expectedPadNets(this.#freshConnectivityContract!).size||observation.nativePads.inventory.terminals.some(terminal=>!terminal.eligibleForPinMatching))throw new Error("Plane stage has incomplete contract physical/logical pad evidence.");
      const settled=await this.#planeKnownState(before,observation,true);
      if(!sameContentIdentity(settled.disk.contentIdentity,before.contentIdentity)||settled.live!==observation.nativeSourceStaged)throw new Error("Plane stage source drifted or saved unexpectedly before host validation.");
      await this.#assertPlaneFillInputs(fillInputs);
      this.#pendingFreshBoardPostSave=Object.freeze({kind:"plane",...fillInputs,prepared,observation});
      const stagedPcbContentIdentity=contentIdentity(observation.nativeSourceStaged);
      const payload={schemaVersion:FRESH_PLANE_APPLY_RESULT_SCHEMA_VERSION,contractIdentity:this.#freshConnectivityContract!.identity,
        sourceContractIdentity:bundle.contract.identity,planeProjectBindingIdentity:this.#freshProject.planeBinding.identity,freshMarkerContentIdentity:before.freshMarkerContentIdentity,
        planeId:plane.id,targetZoneUuid:observation.targetZoneUuid,operation:prepared.mutation.operation,preparedSpecIdentity:prepared.identity,
        beforePcbContentIdentity:before.contentIdentity,stagedPcbContentIdentity,stageReceiptIdentity:observation.receiptIdentity,
        mutationComparisonIdentity:canonicalIdentity(observation.comparison,"evleda.fresh-plane-mutation-comparison.v1"),requirements:prepared.requirements,
        applied:true,mutated:true,idempotent:false,nativeActionsPerformed:true,sourceChanged:!sameContentIdentity(before.contentIdentity,stagedPcbContentIdentity),
        completion:"not_evaluated",connection:"not_evaluated",referenceCoverage:"not_evaluated",thermalAcceptance:"not_evaluated",islandAreaAcceptance:"not_evaluated",
        nativeSaveCalledByStage:false,acceptanceEvaluated:false,issues:[]};
      return harnessToolResultSchema.parse({toolCallId:call.id,content:JSON.stringify(freezeDeep({...payload,identity:canonicalIdentity(payload,payload.schemaVersion)}))});
    }catch(error){return await this.#planeApplyFailure(call,before,observation,"stage-validation",error);}
  }

  async #saveFreshPlane(call:HarnessToolCall,pending:PendingFreshPlaneApply):Promise<HarnessToolResult>{
    try{
      if(this.#planeRecoveryRequired||this.#pendingFreshBoardPostSave!==pending||call.name!=="pcb_save"||Object.keys(call.arguments).length!==0)throw new Error("Plane native save has stale pending authority or invalid arguments.");
      await this.#assertFreshCompoundAuthority();
      await this.#assertPlaneFillInputs(pending);
      await this.#planeKnownState(pending.before,pending.observation,true);
      if(!this.#session.listTools().some(tool=>tool.name==="pcb_save"))throw new Error("Plane apply requires a successful native pcb_save; a no-save source write is not a substitute.");
      const raw=await this.#callSourceBoundTool("pcb_save",{});
      assertSuccessfulSidecarMutation(raw,"pcb_save");
      if(!hasQualifiedNativeBoardReply(raw,"Board saved."))throw new Error("Plane native save lacks the qualified positive Board saved acknowledgement; editor recovery remains required.",{cause:nativeReplyCause("pcb_save",raw)});
      let current=await this.#planeKnownState(pending.before,pending.observation,true);
      if(!freshBoardSerializationsEqual(current.disk.source,pending.observation.nativeSourceStaged)){
        // A source-equivalent update never enters fallback: its successful
        // native save and exact readback suffice even without a hash change.
        if(!sameContentIdentity(current.disk.contentIdentity,pending.before.contentIdentity))throw new Error("Native plane save produced unrecognized disk bytes; preserve current state.");
        current=await this.#planeKnownState(pending.before,pending.observation,true);
        const audit=await this.#freshBoardPersistence!.recoverFromLiveBoard(this.#session,resultContent(raw),"Native plane save left the exact preimage; persist only the accepted staged source.",true,current.live);
        this.#freshBoardSaveAudits.push(audit);
      }
      const capture=await captureFreshPcb(this.#freshProject!);
      if(!freshBoardSerializationsEqual(capture.source,pending.observation.nativeSourceStaged))throw new Error("Saved plane source does not reproduce the accepted native stage.");
      await this.#physicalPadState(capture,[]);
      const comparison=compareFreshPlaneMutation({prepared:pending.prepared,afterPcbSource:capture.source,returnedZoneProto:pending.observation.comparison.nativeProtoSnapshot,
        ...(pending.observation.beforeZoneProto===null?{}:{beforeZoneProto:pending.observation.beforeZoneProto}),phase:"refilled"});
      if(!comparison.valid)throw new Error("Saved plane failed repeated contract/source preservation comparison.");
      await this.#assertFreshCompoundAuthority();
      const final=await this.#planeKnownState(pending.before,pending.observation,true);
      if(!sameContentIdentity(capture.contentIdentity,final.disk.contentIdentity))throw new Error("Saved plane source changed during final native readback.");
      if(!isVerifiedPlaneFreshProject(this.#freshProject)||this.#freshPlaneCompilationBundle===undefined)throw new Error("Saved plane evidence lost its V2 project authority.");
      const {projectSettings,rules}=await this.#assertPlaneFillInputs(pending,capture.contentIdentity);
      this.#savedFreshPlaneEvidence=createSavedFreshPlaneEvidence({compilationBundle:this.#freshPlaneCompilationBundle,stage:pending.observation,
        projectBindingIdentity:capture.projectBindingIdentity,sourceScopeIdentity:this.#physicalExpected(capture,[]).scopeIdentity,
        savedPcbSource:capture.source,projectSettingsIdentity:contentIdentity(projectSettings),rulesIdentity:contentIdentity(rules)});
      this.#pendingFreshBoardPostSave=undefined;this.#pendingPersistedMutationBaseline=undefined;this.#pendingSchematicFileMutationBatch=undefined;
      this.#freshBoardPersistence!.markNormalSaveComplete();
      return harnessToolResultSchema.parse({toolCallId:call.id,content:JSON.stringify({status:"plane-native-saved-and-source-verified",nativeSaveCalled:true,
        savedPcbContentIdentity:capture.contentIdentity,stageObservationIdentity:pending.observation.identity,
        currentSessionFillEvidenceIdentity:this.#savedFreshPlaneEvidence.identity,acceptanceEvaluated:false})});
    }catch(error){return await this.#planeApplyFailure(call,pending.before,pending.observation,"native-save-readback",error);}
  }

  async #freshSyncFromSchematic(call: HarnessToolCall): Promise<HarnessToolResult> {
    if(this.#session.supportsQualifiedFootprintIdentitySync?.()!==true)throw new Error("Fresh sync requires the qualified writer that preserves full footprint library IDs.");
    parseFreshIncrementalArguments(call.name, call.arguments);
    const contract = this.#freshConnectivityContract!;
    const physicalMode=this.#freshPhysicalFootprintResolver!==undefined;
    this.#assertPhysicalLibrarySources();
    if (this.#freshAuthoringDesignContract === undefined || this.#captureFreshNativeNetlist === undefined) {
      throw new Error("Fresh schematic sync requires the generic design contract and host-native netlist capture.");
    }
    const schematicBytes = await readFile(this.#freshProject!.schematicPath);
    const schematicContentIdentity = contentIdentity(schematicBytes);
    const schematic = parseFreshSchematicSource(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(schematicBytes));
    const assertSchematicUnchanged = async (): Promise<void> => {
      const current = await readFile(this.#freshProject!.schematicPath);
      if (!current.equals(schematicBytes) || !sameContentIdentity(contentIdentity(current), schematicContentIdentity)) {
        throw new Error("Exact saved schematic bytes changed during native capture or PCB synchronization.");
      }
    };
    assertFreshGenericSchematicSource(schematic);
    if (!freshGlobalLabelInventoryMatches(schematic, contract.nets.map((net) => net.name))) {
      throw new Error("Fresh sync requires exactly one passive global label for each contract net and no extra labels.");
    }
    if (schematic.symbols.length !== contract.components.length
        || contract.components.some((component) => {
          const symbols = schematic.symbols.filter((symbol) => symbol.reference === component.reference);
          return symbols.length !== 1 || symbols[0]!.libId !== component.symbolLibId
            || symbols[0]!.value !== component.value || symbols[0]!.footprint !== component.footprintLibId;
        })) {
      throw new Error("Fresh sync schematic component/library/value inventory differs from the host contract.");
    }
    const nativeBefore = await this.#captureFreshNativeNetlist();
    await assertSchematicUnchanged();
    const parityBefore = freshNativeNetlistParityIssues(contract, nativeBefore);
    if (parityBefore.length > 0) throw new Error(`Fresh sync native netlist differs from the contract: ${parityBefore.map((issue) => issue.code).join(", ")}.`);
    const before = await captureFreshPcb(this.#freshProject!);
    await this.#freshBoardPersistence!.capturePreMutation(this.#session);
    try {
      const lockedBefore = await captureFreshPcb(this.#freshProject!);
      if (!sameContentIdentity(before.contentIdentity, lockedBefore.contentIdentity)) {
        throw new Error("Fresh PCB source changed while the sync rollback preimage was being captured.");
      }
      const liveBeforeSource = await freshActiveBoardSource(this.#session, this.#freshProject!.pcbPath);
      if (!freshBoardSerializationsEqual(liveBeforeSource, lockedBefore.source)) {
        throw new Error("Live KiCad board differs from the exact marker-bound disk preimage before synchronization.");
      }
      await assertSchematicUnchanged();
      const raw = await this.#callSourceBoundTool("pcb_sync_from_schematic", {
        origin_x_mm: 20, origin_y_mm: 20, scale_x: 1, scale_y: 1, grid_mm: 2.54,
        allow_open_board: true, use_net_names: true, replace_mismatched: true, force: false, auto_place: true,
      });
      const text = assertSuccessfulSidecarMutation(raw, "pcb_sync_from_schematic");
      const receivedText = preferredResultText(raw);
      const receivedLines = receivedText.split(/\r?\n/u).map((line) => line.trim());
      // Pinned no-change/reload branches are complete lines. A flattened
      // `no ... sync` match also catches the legitimate <no net>: 0 metric
      // followed by the auto-placement report, so never infer across lines.
      if (receivedLines.some((line) => [
        "No schematic symbols were found to sync.",
        "The PCB already contains all schematic footprint assignments.",
        "The PCB file was updated. Reload it manually in KiCad if needed.",
        "Pre-sync gate was overridden by force=True.",
      ].includes(line) || !physicalMode&&line.startsWith("Transfer quality: DEGRADED"))) {
        throw new Error(`Fresh sync returned refusal or no-change text: ${text.slice(0, 500)}`);
      }
      const expectedPadMap = expectedPadNets(contract);
      const expectedNamedPads = [...expectedPadMap.values()].filter((net): net is string => net !== null).length;
      const exactLines = physicalMode?[
        `Schematic components considered: ${contract.components.length}`,
        "The PCB file was updated and KiCad was asked to reload it.",
      ]:[
        `Schematic components considered: ${contract.components.length}`,
        `Total pads considered: ${expectedPadMap.size}`,
        `Pads with named nets: ${expectedNamedPads}`,
        `Pads left as <no net>: ${contract.noConnects.length}`,
        "Transfer quality: CLEAN (100.0% pad coverage)",
        `Fully net-mapped refs: ${contract.components.length}`,
        "Partially net-mapped refs: 0",
        "Refs with unresolved pad nets: (none)",
        "The PCB file was updated and KiCad was asked to reload it.",
      ];
      if (exactLines.some((line) => !text.includes(line))) throw new Error("Fresh sync textual metrics do not prove a complete clean transfer and reload.");
      const added = Number(/New footprints added:\s*(\d+)/u.exec(text)?.[1] ?? "NaN");
      const replaced = Number(/Mismatched footprints replaced:\s*(\d+)/u.exec(text)?.[1] ?? "NaN");
      if (!Number.isSafeInteger(added) || !Number.isSafeInteger(replaced) || added + replaced <= 0) {
        throw new Error("Fresh sync did not report a real footprint mutation.");
      }
      const after = await captureFreshPcb(this.#freshProject!);
      if (freshBoardSerializationsEqual(before.source, after.source)) throw new Error("Fresh sync left authoritative PCB content unchanged.");
      assertFullSyncedFootprintIds(contract,after.parsed);
      const pads = exactContractPadPositions(this.#freshProject!, contract, after.parsed,physicalMode);
      const liveSource = await freshActiveBoardSource(this.#session, this.#freshProject!.pcbPath);
      if (this.#observeFreshSyncBoardComparison !== undefined) {
        try {
          this.#observeFreshSyncBoardComparison(Object.freeze({
            diskSource: after.source,
            diskContentIdentity: Object.freeze({ ...after.contentIdentity }),
            liveSource,
            liveContentIdentity: Object.freeze({ ...contentIdentity(liveSource) }),
          }));
        } catch {
          // Best-effort host diagnostics never replace or mask the source guard.
        }
      }
      if (!freshBoardSerializationsEqual(liveSource, after.source)) {
        throw new Error("Reloaded live board bytes differ from the authoritative synced PCB source.");
      }
      const livePads = exactContractPadPositions(this.#freshProject!, contract, parseFreshPcbSource(liveSource),physicalMode);
      assertFullSyncedFootprintIds(contract,parseFreshPcbSource(liveSource));
      if (canonicalJson(livePads) !== canonicalJson(pads)) throw new Error("Reloaded live pad inventory differs from synced source readback.");
      const physicalState=await this.#physicalPadState(after,[]);
      const physicalCounts=physicalState===undefined?undefined:physicalPadCounts(contract,after.parsed);
      const upstreamMetrics=physicalCounts===undefined?undefined:exactUpstreamPadMetrics(receivedLines,contract,after.parsed,physicalCounts);
      await assertSchematicUnchanged();
      const nativeAfter = await this.#captureFreshNativeNetlist();
      await assertSchematicUnchanged();
      const parityAfter = freshNativeNetlistParityIssues(contract, nativeAfter);
      const nativeNetlistComparison = compareFreshNativeNetlists(nativeBefore, nativeAfter);
      if (parityAfter.length > 0 || !nativeNetlistComparison.equal) {
        throw new Error("Schematic/native netlist changed during PCB synchronization.");
      }
      this.#pendingFreshBoardPostSave = Object.freeze({ kind: "sync" as const, contract, schematicContentIdentity,
        ...(physicalMode?{physicalPcbSource:after.source,nativeNetlistSource:nativeAfter}:{}) });
      const payload = {
        schemaVersion: this.#freshProject!.workflowKind==="plane"?FRESH_PLANE_SYNC_SCHEMA_VERSION:physicalMode?FRESH_PHYSICAL_SYNC_FROM_SCHEMATIC_RESULT_SCHEMA_VERSION:FRESH_SYNC_FROM_SCHEMATIC_RESULT_SCHEMA_VERSION,
        contractIdentity: contract.identity,
        ...projectBindingResultFields(this.#freshProject!,after.projectBindingIdentity),
        ...(this.#freshProject!.workflowKind==="plane"?{sourceContractIdentity:contract.sourceContractIdentity}:{}),
        freshMarkerContentIdentity: after.freshMarkerContentIdentity,
        applied: true,
        mutated: true,
        idempotent: false,
        beforePcbContentIdentity: before.contentIdentity,
        afterPcbContentIdentity: after.contentIdentity,
        schematicContentIdentity,
        nativeNetlistComparison,
        receivedSidecarResponseIdentity: contentIdentity(receivedText),
        // Import QA findings are still real; final contract placement remains
        // independently required and is never certified by this sync result.
        placementReview: { status: "pending-final-acceptance", interimFindings: receivedLines.filter((line) => line.startsWith("- FAIL:") || line.startsWith("- WARN:")) },
        footprintLibraryTableIdentity: authoringProjectBinding(this.#freshProject!).footprintLibraryTableIdentity,
        componentCount: contract.components.length,
        ...(physicalState===undefined?{padCount:pads.length,namedPadCount:expectedNamedPads,noConnectPadCount:contract.noConnects.length}:{
          ...physicalCounts!,upstreamMetrics:upstreamMetrics!,nativePadSnapshotIdentity:physicalState.observation.rawEnvelopeIdentity,physicalPadExpectedIdentity:physicalState.observation.expectedIdentity,
        }),
        unresolvedMappingCount: 0,
        issues: [] as const,
      };
      return harnessToolResultSchema.parse({
        toolCallId: call.id,
        content: JSON.stringify(freezeDeep({ ...payload, identity: canonicalIdentity(payload, payload.schemaVersion) })),
      });
    } catch (error) {
      this.#pendingFreshBoardPostSave = undefined;
      try { await this.#freshBoardPersistence!.rollbackToPreMutation(this.#session); }
      catch (rollbackError) {
        throw new Error(`FRESH_SYNC_ROLLBACK_FAILED_TERMINAL: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}.`, { cause: error });
      }
      throw new Error(`FRESH_SYNC_ROLLED_BACK_TERMINAL: ${error instanceof Error ? error.message : String(error)} Exact disk and live board preimage restored; close this editing session.`, { cause: error });
    }
  }

  async #freshApplyRecommendedSchematicPlacement(call: HarnessToolCall): Promise<HarnessToolResult> {
    const parsedArguments = parseFreshIncrementalArguments(call.name, call.arguments) as {
      recommendationIdentity: ReturnType<typeof canonicalIdentity>;
    };
    const requestedIdentity = parsedArguments.recommendationIdentity;
    const pending = this.#pendingFreshPlacementRecommendation;
    const work = createFreshSchematicPlanningWork(new FreshSchematicWorkBudget(this.#freshSchematicWorkLimit));
    if (pending === undefined) {
      throw new Error("No pending host placement recommendation exists; the supplied identity is stale, replayed, or unbound.");
    }
    if (canonicalJson(requestedIdentity) !== canonicalJson(pending.recommendationIdentity)) {
      throw new Error("The supplied recommendationIdentity does not exactly match the complete pending host plan.");
    }
    const advertised = new Set(this.#session.listTools().map((tool) => tool.name));
    for (const name of ["sch_get_symbols", "sch_get_bounding_boxes", "sch_get_pin_positions", "sch_move_symbol"]) {
      if (!advertised.has(name)) throw new Error(`KiCad sidecar did not advertise required atomic-placement tool: ${name}`);
    }
    let before: FreshPlacementSnapshot;
    try {
      before = await this.#readFreshPlacementSnapshot(pending.contract, work);
    } catch (error) {
      throw new Error(`The pending recommendation start state could not be verified: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const beforeGeometry = parseFreshSchematicSource(before.schematic);
    if (canonicalJson(before.identity) !== canonicalJson(pending.startingPlacementIdentity)
      || sha256(before.schematic) !== pending.startingSchematicSha256
      || beforeGeometry.wires.length !== 0
      || beforeGeometry.labels.length !== 0
      || beforeGeometry.junctions.length !== 0
      || beforeGeometry.noConnectCount !== 0) {
      this.#pendingFreshPlacementRecommendation = undefined;
      return recommendedPlacementResult(call, pending.contract, pending.recommendationIdentity, {
        applied: false, mutated: false, idempotent: false,
        issues: [{
          code: "STALE_PLACEMENT_RECOMMENDATION",
          message: "The complete live placement fingerprint changed after this recommendation was issued.",
          remediation: "Call fresh_apply_contract_connectivity again to obtain a recommendation bound to the newly verified state.",
        }],
      });
    }
    const rollbackCheckpoint = await this.#freshSchematicRollback!.capture(before.schematic);
    let attemptedMoves = 0;
    try {
      for (const move of pending.recommendedMoves) {
        const current = before.placements.get(move.reference);
        if (current === undefined || current.rotation !== move.rotationDeg) throw new Error(`Recommendation target ${move.reference} no longer preserves its exact cardinal rotation.`);
        attemptedMoves += 1;
        const result = await this.#callSourceBoundTool("sch_move_symbol", {
          reference: move.reference, x_mm: move.xMm, y_mm: move.yMm, snap_to_grid: true,
        });
        if (result.isError === true) throw new Error(`KiCad rejected atomic recommendation move ${attemptedMoves}/${pending.recommendedMoves.length} for ${move.reference}.`);
        const semantic = preferredResultText(result).replace(/\s+/gu, " ").trim();
        if (/\bWARNING\b|\b(?:failed|failure|error|aborted|unable)\b|\bcould not\b|\bwas not found\b|\balready overlap\b/iu.test(semantic)) {
          throw new Error(`KiCad returned an unsafe semantic result for ${move.reference}: ${semantic.slice(0, 500)}`);
        }
      }
      const after = await this.#readFreshPlacementSnapshot(pending.contract, work);
      if (after.placements.size !== pending.targetPlacements.length || pending.targetPlacements.some((target) => {
        const placement = after.placements.get(target.reference);
        return placement === undefined
          || Math.abs(placement.x - target.xMm) > GEOMETRY_EPSILON_MM
          || Math.abs(placement.y - target.yMm) > GEOMETRY_EPSILON_MM
          || placement.rotation !== target.rotationDeg;
      })) throw new Error("Atomic placement readback does not exactly match the complete target configuration.");
      if (canonicalJson(after.identity) !== canonicalJson(pending.targetPlacementIdentity)) {
        throw new Error("Atomic placement geometry does not reproduce the recommendation-bound target fingerprint.");
      }
      const afterGeometry = parseFreshSchematicSource(after.schematic);
      if (afterGeometry.wires.length !== 0 || afterGeometry.labels.length !== 0 || afterGeometry.junctions.length !== 0 || afterGeometry.noConnectCount !== 0) {
        throw new Error("Atomic placement readback contains non-pristine schematic geometry absent from the recommendation plan.");
      }
      const partition = after.sourceTerminals?.result.status === "complete" ? after.sourceTerminals.result.value : undefined;
      const plan = planFreshContractGeometry(pending.contract, after.pins, after.boxes, work, contractAuthoringProject(this.#freshProject), partition);
      if (work.exhausted || plan.issues.length > 0) throw new Error("Atomic placement readback no longer admits the complete deterministic contract wire plan.");
      this.#pendingFreshPlacementCommit = {
        contract: pending.contract,
        recommendationIdentity: pending.recommendationIdentity,
        baseline: rollbackCheckpoint,
        targetPlacementIdentity: pending.targetPlacementIdentity,
        targetPlacements: pending.targetPlacements,
        saveVerified: false,
      };
      this.#pendingFreshPlacementRecommendation = undefined;
      return recommendedPlacementResult(call, pending.contract, pending.recommendationIdentity, {
        applied: true, mutated: true, idempotent: false, issues: [],
      });
    } catch (error) {
      this.#pendingFreshPlacementRecommendation = undefined;
      this.#pendingFreshPlacementCommit = undefined;
      this.#pendingSchematicFileMutationBatch = undefined;
      try {
        await this.#freshSchematicRollback!.restore(rollbackCheckpoint);
      } catch (rollbackError) {
        throw new Error(
          `FRESH_CONNECTIVITY_PLACEMENT_ROLLBACK_FAILED_TERMINAL: atomic recommendation stopped after ${attemptedMoves} attempted move(s), and exact disk rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}.`,
          { cause: error },
        );
      }
      throw new Error(
        `FRESH_CONNECTIVITY_PLACEMENT_ROLLED_BACK_TERMINAL: atomic recommendation stopped after ${attemptedMoves} attempted move(s): ${error instanceof Error ? error.message : String(error)} Exact disk preimage restored and verified; live KiCad state is unproven, so this session must close.`,
        { cause: error },
      );
    }
  }

  async #freshApplyContractConnectivity(call: HarnessToolCall): Promise<HarnessToolResult> {
    parseFreshIncrementalArguments(call.name, call.arguments);
    const contract = this.#freshConnectivityContract!;
    const globalLabels = contractAuthoringProject(this.#freshProject);
    const endpointCount = contract.nets.reduce((total, net) => total + net.endpoints.length, 0) + contract.noConnects.length;
    const extendedScope = contract.components.length > FRESH_CONNECTIVITY_PLACEMENT_SEARCH.maxComponents || endpointCount > FRESH_CONNECTIVITY_PLACEMENT_SEARCH.maxEndpoints;
    const planningWork = createFreshSchematicPlanningWork(new FreshSchematicWorkBudget(this.#freshSchematicWorkLimit));
    if (contract.components.length > 64 || endpointCount > 8_192 || extendedScope && this.#freshSchematicGeometryResolver === undefined) {
      this.#pendingFreshPlacementRecommendation = undefined;
      return contractResult(call, contract, {
        applied: false, mutated: false, idempotent: false,
        issues: [{
          code: "SOURCE_TERMINAL_EVIDENCE_UNAVAILABLE",
          message: `The contract has ${contract.components.length} component(s) and ${endpointCount} distinct endpoint occurrence(s); larger direct planning requires its approved source-geometry resolver within the existing 64-component/8192-pin contract envelope.`,
          remediation: "Keep connectivity unmodified; bind the approved exact stock resolver instead of reducing the component or pin inventory.",
        }],
        issueEvidence: { total: 1, returned: 1, truncated: false },
      });
    }
    const advertised = new Set(this.#session.listTools().map((tool) => tool.name));
    for (const name of ["sch_get_symbols", "sch_get_bounding_boxes", "sch_get_pin_positions", "sch_add_wire", globalLabels ? "sch_add_labels" : "sch_add_label", "sch_add_no_connect", "sch_add_missing_junctions", "sch_get_connectivity_graph", "run_erc"]) {
      if (!advertised.has(name)) throw new Error(`KiCad sidecar did not advertise required host contract-connectivity tool: ${name}`);
    }

    const schematic = await readFile(this.#freshProject!.schematicPath, "utf8");
    const parsedSchematic = parseFreshSchematicSource(schematic);
    if (globalLabels) assertFreshGenericSchematicSource(parsedSchematic);
    const preflightIssues: FreshConnectivityIssue[] = [];
    const preflightIssueKeys = new Set<string>();
    let preflightIssueTotal = 0;
    const addPreflightIssue = (issue: FreshConnectivityIssue): void => {
      const key = `${issue.code}\u0000${(issue.endpoints ?? []).join("\u0000")}\u0000${issue.message}\u0000${issue.atMm?.x ?? ""},${issue.atMm?.y ?? ""}`;
      if (preflightIssueKeys.has(key)) return;
      preflightIssueKeys.add(key);
      preflightIssueTotal += 1;
      if (preflightIssues.length < MAX_RETURNED_FRESH_CONNECTIVITY_ISSUES) preflightIssues.push(issue);
    };
    for (const component of contract.components) if (!schematic.includes(`(symbol "${component.symbolLibId}"`)) {
      addPreflightIssue({
        code: "MISSING_EMBEDDED_LIBRARY_SYMBOL",
        message: `The schematic does not contain the embedded ${component.symbolLibId} definition required by ${component.reference}.`,
        remediation: `Add ${component.reference} from the contract library, then retry the same empty-argument operation.`,
        endpoints: [component.reference],
      });
    }
    const symbolsResult = await this.#callSourceBoundTool("sch_get_symbols", {});
    if (symbolsResult.isError === true) throw new Error("KiCad failed to read placed symbols before contract connectivity.");
    const allPlacements = parseFreshPlacements(preferredResultText(symbolsResult));
    const placements = new Map<string, FreshPlacement>();
    for (const component of contract.components) {
      const matches = allPlacements.get(component.reference) ?? [];
      if (matches.length !== 1) {
        addPreflightIssue({
          code: matches.length === 0 ? "MISSING_CONTRACT_COMPONENT" : "DUPLICATE_CONTRACT_COMPONENT",
          message: `Expected exactly one placed ${component.reference}; observed ${matches.length}.`,
          remediation: matches.length === 0
            ? `Add ${component.reference} using ${component.symbolLibId}, then retry.`
            : "Restore a checkpoint with one exact contract component before retrying.",
          endpoints: [component.reference],
        });
        continue;
      }
      const placement = matches[0]!;
      const actualLibraryId = `${placement.library}:${placement.symbol}`;
      if (actualLibraryId !== component.symbolLibId) {
        addPreflightIssue({
          code: "CONTRACT_SYMBOL_MISMATCH",
          message: `${component.reference} uses ${actualLibraryId}, not contract symbol ${component.symbolLibId}.`,
          remediation: "Restore or place the exact contract symbol before retrying.",
          endpoints: [component.reference],
        });
        continue;
      }
      if (placement.footprint !== undefined && placement.footprint !== component.footprintLibId) {
        addPreflightIssue({
          code: "CONTRACT_FOOTPRINT_MISMATCH",
          message: `${component.reference} reports footprint ${placement.footprint}, not host-contract footprint ${component.footprintLibId}.`,
          remediation: "Assign the exact host-contract footprint before connectivity mutation.",
          endpoints: [component.reference],
        });
        continue;
      }
      placements.set(component.reference, placement);
    }
    const expectedReferences = new Set(contract.components.map((component) => component.reference));
    const extras = [...allPlacements.keys()].filter((reference) => !expectedReferences.has(reference));
    if (extras.length > 0) addPreflightIssue({
      code: "EXTRA_SCHEMATIC_COMPONENT",
      message: `Placed symbol inventory contains non-contract reference(s): ${extras.join(", ")}.`,
      remediation: "Restore an exact contract-component checkpoint before applying connectivity.",
      endpoints: extras,
    });
    if (preflightIssues.length > 0) {
      this.#pendingFreshPlacementRecommendation = undefined;
      return contractResult(call, contract, {
        applied: false, mutated: false, idempotent: false, issues: preflightIssues.sort(issueOrder),
        issueEvidence: { total: preflightIssueTotal, returned: preflightIssues.length, truncated: preflightIssueTotal > preflightIssues.length },
      });
    }

    const boundsResult = await this.#callSourceBoundTool("sch_get_bounding_boxes", {});
    if (boundsResult.isError === true) throw new Error("KiCad failed to read schematic bounding boxes before contract connectivity.");
    const allBounds = parseFreshBoundingBoxes(preferredResultText(boundsResult));
    let contractBounds = contract.components.flatMap((component) => allBounds.filter((box) => box.reference === component.reference));
    if (contractBounds.length !== contract.components.length) addPreflightIssue({
      code: "BOUNDING_BOX_READBACK_INCOMPLETE",
      message: `Expected ${contract.components.length} exact contract symbol bounding boxes; observed ${contractBounds.length}.`,
      remediation: "Keep connectivity unmodified and retry after KiCad can inspect every placed contract symbol.",
    });
    const contractEndpoints = [
      ...contract.nets.flatMap((net) => net.endpoints),
      ...contract.noConnects,
    ];
    const pins = new Map<string, { x: number; y: number; angleDeg: 0 | 90 | 180 | 270 }>();
    for (const [reference, placement] of placements) {
      const localAngles = parseFreshEmbeddedPinAngles(schematic, `${placement.library}:${placement.symbol}`, placement.unit);
      const result = await this.#callSourceBoundTool("sch_get_pin_positions", { library: placement.library, symbol_name: placement.symbol, x_mm: placement.x, y_mm: placement.y, rotation: placement.rotation, unit: placement.unit });
      if (result.isError === true) throw new Error(`KiCad failed to resolve pin positions for ${reference}.`);
      const text = preferredResultText(result);
      for (const match of text.matchAll(/- Pin ([^:]+): \((-?[\d.]+),\s*(-?[\d.]+)\) mm/gu)) {
        const localAngle = localAngles[match[1]!];
        // KiCad placement rotation is applied to (x, -y) library coordinates;
        // its screen-space cardinal pin angle therefore rotates in subtraction.
        const absoluteAngle = localAngle === undefined ? null : freshAbsolutePinAngle(localAngle, placement.rotation);
        if (absoluteAngle === null) continue;
        pins.set(`${reference}:${match[1]}`, { x: Number(match[2]), y: Number(match[3]), angleDeg: absoluteAngle });
      }
    }
    for (const endpoint of contractEndpoints) if (!pins.has(endpointId(endpoint))) {
      addPreflightIssue({
        code: "UNRESOLVED_CONTRACT_PIN",
        message: `Live pin position is unavailable for ${endpointId(endpoint)}.`,
        remediation: "Correct the component identity or unit, then retry; never guess pin coordinates.",
        endpoints: [endpointId(endpoint)],
      });
    }

    let sourceTerminals: ReturnType<typeof buildFreshSchematicSourceTerminalGroups> | undefined;
    try { sourceTerminals = await this.#sourceTerminalGroups(schematic, pins, planningWork); }
    catch (error) { addPreflightIssue({ code: "SOURCE_TERMINAL_EVIDENCE_MISMATCH", message: error instanceof Error ? error.message : String(error), remediation: "Restore exact approved symbol/source geometry; caller pin coordinates cannot replace source evidence." }); }
    if (sourceTerminals?.result.status === "exhausted") return contractResult(call, contract, {
      applied: false, mutated: false, idempotent: false, issues: [{ code: "PLANNING_WORK_LIMIT", message: canonicalJson(planningWork.budget.snapshot()), remediation: "Keep connectivity unchanged; source-terminal planning exhausted its aggregate work budget." }],
    });
    if (sourceTerminals !== undefined && sourceTerminals.result.status !== "complete") {
      for (const issue of sourceTerminals.result.issues) addPreflightIssue({ code: issue.code, message: issue.message, endpoints: issue.endpointIds, remediation: "Correct the source/contract conflict without merging different terminals or dropping any original pin." });
    }
    if (preflightIssues.some((issue) => issue.code === "SOURCE_TERMINAL_EVIDENCE_MISMATCH") || sourceTerminals !== undefined && sourceTerminals.result.status !== "complete") {
      this.#pendingFreshPlacementRecommendation = undefined;
      return contractResult(call, contract, { applied: false, mutated: false, idempotent: false, issues: preflightIssues.sort(issueOrder) });
    }
    const terminalPartition = sourceTerminals?.result.status === "complete" ? sourceTerminals.result.value : undefined;
    const completeBody = new Map(sourceTerminals?.sourceBodyGeometry.filter((body) => body.coverage.complete && body.coverage.renderedStrokeVerified && body.bounds !== null).map((body) => [body.reference, body]) ?? []);
    for (const body of sourceTerminals?.sourceBodyGeometry ?? []) if (!body.coverage.complete || !body.coverage.renderedStrokeVerified) {
      addPreflightIssue({ code: "UNSUPPORTED_BOUNDING_BOX_GEOMETRY", message: `${body.reference} lacks complete source-graphic and bound native stroke coverage (${body.coverage.unsupportedKinds.join(", ") || "renderer stroke evidence unavailable"}).`,
        remediation: "Obtain current-source renderer/config/pen evidence or implement the actual missing graphics coverage; nominal small pin boxes are not body proof.", endpoints: [body.reference] });
    }
    contractBounds = contractBounds.map((box) => {
      const proven = completeBody.get(box.reference)?.bounds;
      return proven === undefined || proven === null ? box : { reference: box.reference,
        minX: Math.min(box.minX, proven.minXmm), minY: Math.min(box.minY, proven.minYmm),
        maxX: Math.max(box.maxX, proven.maxXmm), maxY: Math.max(box.maxY, proven.maxYmm) };
    });
    for (const box of contractBounds) {
      const placement = placements.get(box.reference);
      const width = box.maxX - box.minX;
      const height = box.maxY - box.minY;
      if (!completeBody.has(box.reference) && (width > MAX_CONFIDENT_SCHEMATIC_BOUNDING_BOX_MM || height > MAX_CONFIDENT_SCHEMATIC_BOUNDING_BOX_MM || (placement?.rotation !== 0 && (width > 20 || height > 20)))) {
        addPreflightIssue({ code: "UNSUPPORTED_BOUNDING_BOX_GEOMETRY", message: `${box.reference} has a large or rotated bounding box without complete source-graphic coverage.`,
          remediation: "Provide complete conservative source geometry; pin-derived default boxes do not prove body extent.", endpoints: [box.reference] });
      }
    }
    for (let leftIndex = 0; leftIndex < contractBounds.length; leftIndex += 1) for (let rightIndex = leftIndex + 1; rightIndex < contractBounds.length; rightIndex += 1) {
      if (!consumeSegmentCheck(planningWork, "collision")) break;
      const left = contractBounds[leftIndex]!;
      const right = contractBounds[rightIndex]!;
      const overlapX = Math.min(left.maxX + BOUNDING_BOX_ROUNDING_MARGIN_MM, right.maxX + BOUNDING_BOX_ROUNDING_MARGIN_MM) - Math.max(left.minX - BOUNDING_BOX_ROUNDING_MARGIN_MM, right.minX - BOUNDING_BOX_ROUNDING_MARGIN_MM);
      const overlapY = Math.min(left.maxY + BOUNDING_BOX_ROUNDING_MARGIN_MM, right.maxY + BOUNDING_BOX_ROUNDING_MARGIN_MM) - Math.max(left.minY - BOUNDING_BOX_ROUNDING_MARGIN_MM, right.minY - BOUNDING_BOX_ROUNDING_MARGIN_MM);
      if (overlapX > 0.001 && overlapY > 0.001) addPreflightIssue({ code: "SYMBOL_BOUNDING_BOX_OVERLAP", message: `${left.reference} and ${right.reference} schematic bounding boxes overlap by ${overlapX.toFixed(3)} x ${overlapY.toFixed(3)} mm.`, remediation: `Move ${right.reference} clear of ${left.reference}, re-read bounding boxes, then retry the same empty-argument operation.`, endpoints: [left.reference, right.reference] });
    }

    const resolvedEndpoints = contractEndpoints.filter((endpoint) => pins.has(endpointId(endpoint)))
      .sort((left, right) => endpointId(left).localeCompare(endpointId(right), "en-US"));
    const collisionBuckets = new Map<string, { readonly endpoint: FreshConnectivityEndpoint; readonly point: FreshPoint }[]>();
    const collisionBucket = (value: number): number => Math.floor(value / GEOMETRY_EPSILON_MM);
    for (const endpoint of resolvedEndpoints) {
      const point = pins.get(endpointId(endpoint))!;
      const bucketX = collisionBucket(point.x);
      const bucketY = collisionBucket(point.y);
      for (let xOffset = -1; xOffset <= 1; xOffset += 1) for (let yOffset = -1; yOffset <= 1; yOffset += 1) {
        for (const prior of collisionBuckets.get(`${bucketX + xOffset},${bucketY + yOffset}`) ?? []) {
          if (!consumeSegmentCheck(planningWork, "collision")) break;
          if (pointDistance(prior.point, point) > GEOMETRY_EPSILON_MM) continue;
          if (terminalPartition !== undefined && terminalMembers(endpointId(prior.endpoint), terminalPartition).includes(endpointId(endpoint))) continue;
          addPreflightIssue({
            code: "PIN_COORDINATE_COLLISION",
            message: `${endpointId(prior.endpoint)} and ${endpointId(endpoint)} resolve to the same electrical point (${prior.point.x}, ${prior.point.y}) mm.`,
            remediation: `Move ${endpoint.reference === prior.endpoint.reference ? endpoint.reference : `${prior.endpoint.reference} or ${endpoint.reference}`} so all contract pins are distinct, then retry the same empty-argument operation.`,
            endpoints: [endpointId(prior.endpoint), endpointId(endpoint)],
            // Pin angle is host-only routing metadata; the provider-visible issue
            // needs only the exact collision coordinate.
            atMm: { x: prior.point.x, y: prior.point.y },
          });
        }
      }
      const key = `${bucketX},${bucketY}`;
      const entries = collisionBuckets.get(key) ?? [];
      entries.push({ endpoint, point });
      collisionBuckets.set(key, entries);
    }
    const allGeometryInputsResolved = contractBounds.length === contract.components.length
      && contractEndpoints.every((endpoint) => pins.has(endpointId(endpoint)))
      && !preflightIssues.some((issue) => ["BOUNDING_BOX_READBACK_INCOMPLETE", "UNSUPPORTED_BOUNDING_BOX_GEOMETRY", "UNRESOLVED_CONTRACT_PIN"].includes(issue.code));
    const currentPlacementIdentity = freshPlacementStateIdentity(placements, contractBounds, pins);
    if (this.#pendingFreshPlacementRecommendation !== undefined
      && canonicalJson(this.#pendingFreshPlacementRecommendation.startingPlacementIdentity) !== canonicalJson(currentPlacementIdentity)) {
      this.#pendingFreshPlacementRecommendation = undefined;
    }
    const currentGeometryPlan = allGeometryInputsResolved
      ? planFreshContractGeometry(contract, pins, contractBounds, planningWork, globalLabels, terminalPartition) : null;
    const convergenceIssues = [...preflightIssues, ...(currentGeometryPlan?.issues ?? [])];
    if (convergenceIssues.length > 0) {
      const searchEligible = allGeometryInputsResolved
        && parsedSchematic.wires.length === 0 && parsedSchematic.labels.length === 0
        && parsedSchematic.junctions.length === 0 && parsedSchematic.noConnectCount === 0;
      const search = searchEligible
        ? searchFreshConnectivityPlacement(contract, placements, contractBounds, pins, sha256(schematic), globalLabels, terminalPartition, planningWork)
        : {
          status: "unsupported" as const,
          recommendedMoves: [],
          startingPlacementIdentity: currentPlacementIdentity,
          startingSchematicSha256: sha256(schematic),
          targetPlacements: [],
          configurationsEvaluated: 0,
          statesVisited: 0,
          planEvaluations: 0,
          segmentChecks: 0,
          candidateCount: 0,
          exhaustionReason: "no-solution" as const,
          blockingEdgeTotal: 0,
          blockingEdges: [],
        };
      if (search.status === "found"
        && search.recommendationIdentity !== undefined
        && search.targetPlacementIdentity !== undefined
        && search.targetPlacements.length === contract.components.length
        && search.recommendedMoves.length > 0) {
        const existing = this.#pendingFreshPlacementRecommendation;
        if (existing === undefined || canonicalJson(existing.recommendationIdentity) !== canonicalJson(search.recommendationIdentity)) {
          this.#pendingFreshPlacementRecommendation = Object.freeze({
            contract,
            recommendationIdentity: search.recommendationIdentity,
            startingPlacementIdentity: search.startingPlacementIdentity,
            startingSchematicSha256: search.startingSchematicSha256,
            targetPlacementIdentity: search.targetPlacementIdentity,
            targetPlacements: Object.freeze([...search.targetPlacements]),
            recommendedMoves: Object.freeze([...search.recommendedMoves]),
          });
        }
      } else {
        this.#pendingFreshPlacementRecommendation = undefined;
      }
      return contractResult(call, contract, placementConvergenceFields(
        contract,
        convergenceIssues,
        currentGeometryPlan,
        search,
        preflightIssueTotal + (currentGeometryPlan?.issues.length ?? 0),
      ));
    }
    this.#pendingFreshPlacementRecommendation = undefined;

    const beforeReadback = await this.#callSourceBoundTool("sch_get_connectivity_graph", {});
    if (beforeReadback.isError === true) throw new Error("KiCad failed to read connectivity before the contract operation.");
    const beforeGroups = parseFreshConnectivityGroups(preferredResultText(beforeReadback));
    const alreadyExactIssues = exactFreshConnectivityIssues(contract, beforeGroups);
    const expectedLabels: readonly FreshContractLabelAnchor[] = globalLabels ? currentGeometryPlan!.labels
      : contract.nets.map((net) => ({ name: net.name, at: pins.get(endpointId(net.endpoints[0]!))! }));
    const noConnectLocations = parsedSchematic.noConnects;
    const exactNoConnects = noConnectLocations.length === contract.noConnects.length && contract.noConnects.every((endpoint) => {
      const expected = pins.get(endpointId(endpoint))!;
      return noConnectLocations.some((actual) => pointDistance(expected, actual) <= 0.001);
    });
    if (alreadyExactIssues.length === 0 && exactNoConnects) {
      if (!exactFreshContractLabelsMatch(schematic, expectedLabels, globalLabels)) return contractResult(call, contract, {
        applied: false, mutated: false, idempotent: true,
        issues: [{ code: "CONTRACT_LABEL_INVENTORY_MISMATCH", message: "Persisted schematic label kinds, shapes, names, or anchors differ from the exact host contract inventory.", remediation: "Restore the exact contract-label checkpoint before accepting existing connectivity." }],
      });
      const erc = await this.#callSourceBoundTool("run_erc", {});
      if (erc.isError === true) throw new Error("KiCad ERC could not run after exact contract-connectivity readback.");
      const ercPayload = JSON.parse(resultContent(erc, true)) as Record<string, unknown>;
      if (!ercIsClean(ercPayload)) return contractResult(call, contract, {
        applied: false, mutated: false, idempotent: true,
        issues: [{ code: "ERC_NOT_CLEAN", message: "Contract connectivity is exact, but ERC is not clean.", remediation: "Resolve the reported ERC design findings without changing contract topology, then retry." }],
      });
      if (this.#pendingFreshConnectivity === undefined) {
        if (this.#captureFreshNativeNetlist === undefined) return contractResult(call, contract, {
          applied: false, mutated: false, idempotent: true,
          issues: [{ code: "NATIVE_PARITY_UNAVAILABLE", message: "Persisted connectivity is exact, but host-native KiCad netlist parity is unavailable.", remediation: "Configure the native KiCad netlist capture before accepting this existing connectivity." }],
        });
        try {
          const nativeSource = await this.#captureFreshNativeNetlist();
          const nativeIssues = freshNativeNetlistParityIssues(contract, nativeSource);
          if (nativeIssues.length > 0) return contractResult(call, contract, {
            applied: false, mutated: false, idempotent: true, issues: nativeIssues,
          });
          return contractResult(call, contract, {
            applied: true, mutated: false, idempotent: true, issues: [],
            routes: [], noConnects: contract.noConnects.map(endpointId), connectivity: beforeGroups,
            nativeNetlistSha256: sha256(nativeSource), nativeNetCount: contract.nets.length, nativeComponentCount: contract.components.length,
          });
        } catch (error) {
          return contractResult(call, contract, {
            applied: false, mutated: false, idempotent: true,
            issues: [{ code: "NATIVE_PARITY_FAILED", message: `Host-native KiCad netlist parity could not complete: ${(error instanceof Error ? error.message : String(error)).replace(/\s+/gu, " ").slice(0, 500)}`, remediation: "Keep the existing connectivity unresolved until a native parity capture succeeds." }],
          });
        }
      }
      return contractResult(call, contract, {
        applied: true, mutated: false, idempotent: true, issues: [],
        routes: [], noConnects: contract.noConnects.map(endpointId), connectivity: beforeGroups,
      });
    }

    const sourcePristine = sourceTerminals === undefined ? undefined : validatePristineTerminalPartition(sourceTerminals.terminalInput, beforeGroups, planningWork.budget);
    if (sourcePristine?.status === "exhausted") return contractResult(call, contract, { applied: false, mutated: false, idempotent: false,
      issues: [{ code: "PLANNING_WORK_LIMIT", message: canonicalJson(planningWork.budget.snapshot()), remediation: "Keep connectivity unchanged; pristine validation exhausted the aggregate planning budget." }] });
    const pristineIssues: FreshConnectivityIssue[] = sourcePristine === undefined ? [...pristineConnectivityIssues(contract, beforeGroups, parsedSchematic.noConnectCount)]
      : sourcePristine.status === "complete" ? [] : sourcePristine.issues.map((issue) => ({ code: issue.code, message: issue.message, endpoints: issue.endpointIds, remediation: "Restore the exact source-proven pristine terminal partition without dropping original pins." }));
    if (sourcePristine !== undefined && parsedSchematic.noConnectCount !== 0) pristineIssues.push({ code: "PREEXISTING_NO_CONNECT", message: "Pristine source already contains no-connect markers.", remediation: "Restore the post-placement checkpoint before connectivity authoring." });
    if (parsedSchematic.wires.length > 0 || parsedSchematic.labels.length > 0 || parsedSchematic.junctions.length > 0) pristineIssues.push({
      code: "PREEXISTING_SCHEMATIC_GEOMETRY",
      message: `Disconnected contract preflight still contains ${parsedSchematic.wires.length} wire(s), ${parsedSchematic.labels.length} label(s), and ${parsedSchematic.junctions.length} junction(s).`,
      remediation: "Restore a clean post-placement checkpoint before the host plans complete connectivity geometry.",
    });
    if (pristineIssues.length > 0) return contractResult(call, contract, {
      applied: false, mutated: false, idempotent: false, issues: pristineIssues,
    });
    const requiresBatch = extendedScope;
    if (requiresBatch && (this.#session.supportsSchematicConnectivityBatch?.() !== true || this.#session.applySchematicConnectivityBatch === undefined)) return contractResult(call, contract, {
      applied: false, mutated: false, idempotent: false, issues: [{
        code: "SCHEMATIC_BATCH_CAPABILITY_UNAVAILABLE",
        message: "Larger direct planning passed, but the installed session lacks the verified complete versioned batch authoring capability.",
        remediation: "Install and verify the exact private batch capability; do not fall back to thousands of serial writes or drop contract endpoints.",
      }],
    });
    const geometryPlan = currentGeometryPlan!;
    if (geometryPlan.issues.length > 0) throw new Error("Connectivity geometry changed after its complete preflight plan.");
    let batchPlan: ReturnType<typeof prepareFreshSchematicConnectivityBatch> | undefined;
    if (requiresBatch) {
      if (!globalLabels || sourceTerminals === undefined || terminalPartition === undefined) throw new Error("Larger schematic batch requires complete source-bound generic terminal authority.");
      try {
        batchPlan = prepareFreshSchematicConnectivityBatch({ projectFile: path.join(this.#freshProject!.projectPath, `${this.#freshProject!.name}.kicad_pro`), schematicFile: this.#freshProject!.schematicPath, beforeSource: schematic,
          wires: geometryPlan.wires.map((wire) => ({ start: wireStart(wire), end: wireEnd(wire) })),
          labels: currentGeometryPlan!.labels.map((label) => ({ name: label.name, x_mm: label.at.x, y_mm: label.at.y, rotation: label.rotationDeg, shape: "passive", justify: label.justify })),
          noConnects: contract.noConnects.map((endpoint) => pins.get(endpointId(endpoint))!),
        }, planningWork.budget);
      } catch (error) { return contractResult(call, contract, { applied: false, mutated: false, idempotent: false, issues: [{
        code: "SCHEMATIC_BATCH_PLAN_UNSUPPORTED", message: error instanceof Error ? error.message : String(error), remediation: "Keep connectivity unchanged; the entire exact batch plan must fit its verified normalization and primitive envelope.",
      }] }); }
      if (batchPlan.status !== "complete") return contractResult(call, contract, { applied: false, mutated: false, idempotent: false, issues: [{ code: "PLANNING_WORK_LIMIT", message: canonicalJson(planningWork.budget.snapshot()), remediation: "Keep connectivity unchanged; no partial batch plan is executable." }] });
    }
    const expectedGeometryPrefixes = requiresBatch ? [] : expectedFreshSchematicGeometryPrefixes(geometryPlan.wires.map((wire) => ({ start: wireStart(wire), end: wireEnd(wire) })));
    const expectedGeometry = batchPlan?.status === "complete" ? batchPlan.value.expectedGeometry : expectedGeometryPrefixes.at(-1)!;
    const rollbackCheckpoint = await this.#freshSchematicRollback!.capture(schematic);

    const routes = [...geometryPlan.routes];
    let groups: readonly FreshConnectivityGroup[] = [];
    let completedMutationCalls = 0;
    let connectivityBatchAfterContentIdentity: ContentIdentity | undefined;
    let recoveryIssues: readonly FreshConnectivityIssue[] | undefined;
    const mutate = async (name: string, argumentsValue: Readonly<Record<string, unknown>>, failure: string): Promise<void> => {
      const result = await this.#callSourceBoundTool(name, argumentsValue);
      if (result.isError === true) throw new Error(failure);
      const semantic = preferredResultText(result).replace(/\s+/gu, " ").trim();
      if (/\bWARNING\b|\b(?:failed|failure|error|aborted|unable)\b|\bcould not\b|\bwas not found\b|\balready overlap\b/iu.test(semantic)) {
        throw new Error(`${failure} Sidecar semantic result: ${semantic.slice(0, 500)}`);
      }
      completedMutationCalls += 1;
    };
    try {
      if (batchPlan?.status === "complete") {
        const beforeBytes = await readFile(this.#freshProject!.schematicPath);
        if (!beforeBytes.equals(Buffer.from(schematic, "utf8"))) throw new Error("Schematic source changed before the exact batch dispatch.");
        const beforeInventory = parseFreshSchematicConnectivityPrimitiveInventory(schematic);
        this.#assertLibrarySources();
        const response = await this.#session.applySchematicConnectivityBatch!(batchPlan.value.request);
        completedMutationCalls += 1;
        const afterBytes = await readFile(this.#freshProject!.schematicPath);
        const afterSource = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(afterBytes);
        validateFreshSchematicConnectivityBatchReceipt({ result: response, plan: batchPlan.value, beforeSource: beforeBytes, afterSource: afterBytes,
          beforeInventory, afterInventory: parseFreshSchematicConnectivityPrimitiveInventory(afterSource) });
        connectivityBatchAfterContentIdentity = contentIdentity(afterBytes);
      } else {
      let writtenWireCount = 0;
      for (const wire of geometryPlan.wires) {
        await mutate(
          "sch_add_wire",
          { x1_mm: wire.x, y1_mm: wire.y, x2_mm: wire.endX, y2_mm: wire.endY, snap_to_grid: false },
          `KiCad failed while applying a prevalidated ${wire.net} wire segment.`,
        );
        writtenWireCount += 1;
        if (!exactFreshSchematicGeometryMatches(
          parseFreshSchematicSource(await readFile(this.#freshProject!.schematicPath, "utf8")),
          expectedGeometryPrefixes[writtenWireCount]!,
        )) {
          throw new Error(`Persisted schematic wire or junction geometry diverged after ${writtenWireCount} of ${geometryPlan.wires.length} prevalidated segments.`);
        }
      }
      if (globalLabels) {
        await mutate(
          "sch_add_labels",
          { labels: currentGeometryPlan!.labels.map((label) => ({ name: label.name, x_mm: label.at.x, y_mm: label.at.y, kind: "global", shape: "passive", rotation: label.rotationDeg, snap_to_grid: true, justify: label.justify })) },
          "KiCad failed to place the passive global contract labels at their reserved on-grid outward terminals.",
        );
      } else {
        for (const label of expectedLabels) await mutate(
          "sch_add_label",
          { name: label.name, x_mm: label.at.x, y_mm: label.at.y, rotation: 0, snap_to_grid: true, justify: "none" },
          `KiCad failed to place the ${label.name} label at its verified endpoint.`,
        );
      }
      for (const endpoint of contract.noConnects) {
        const pin = pins.get(endpointId(endpoint))!;
        await mutate(
          "sch_add_no_connect",
          { x_mm: pin.x, y_mm: pin.y, snap_to_grid: true },
          `KiCad failed while applying the contract no-connect at ${endpointId(endpoint)}.`,
        );
      }
      await mutate("sch_add_missing_junctions", {}, "KiCad failed to add required wire junctions.");
      }

      const geometrySource = await readFile(this.#freshProject!.schematicPath, "utf8");
      const geometryReadback = parseFreshSchematicSource(geometrySource);
      if (globalLabels) assertFreshGenericSchematicSource(geometryReadback);
      if (!exactFreshSchematicGeometryMatches(geometryReadback, expectedGeometry)) {
        throw new Error("Persisted schematic no longer exactly matches the pinned writer's expected wires and junctions for the collision-checked plan.");
      }
      if (!exactFreshContractLabelsMatch(geometrySource, expectedLabels, globalLabels)) {
        throw new Error("Persisted schematic labels do not exactly match the contract kinds, shapes, names, and anchors.");
      }

      const readback = await this.#callSourceBoundTool("sch_get_connectivity_graph", {});
      if (readback.isError === true) throw new Error("KiCad failed to read back contract connectivity.");
      groups = parseFreshConnectivityGroups(preferredResultText(readback));
      const postconditionIssues = [...exactFreshConnectivityIssues(contract, groups)];
      const postSource = await readFile(this.#freshProject!.schematicPath, "utf8");
      const postSchematic = parseFreshSchematicSource(postSource);
      if (globalLabels) assertFreshGenericSchematicSource(postSchematic);
      if (!exactFreshContractLabelsMatch(postSource, expectedLabels, globalLabels)) {
        throw new Error("Persisted schematic label inventory changed during connectivity readback.");
      }
      if (postSchematic.noConnects.length !== contract.noConnects.length || contract.noConnects.some((endpoint) => {
        const expected = pins.get(endpointId(endpoint))!;
        return !postSchematic.noConnects.some((actual) => pointDistance(expected, actual) <= 0.001);
      })) postconditionIssues.push({
        code: "NO_CONNECT_READBACK_MISMATCH",
        message: "Persisted no-connect markers do not exactly match the host-bound endpoint set.",
        remediation: "Keep the design unresolved and restore the pre-connectivity checkpoint for host review.",
        endpoints: contract.noConnects.map(endpointId),
      });
      if (postconditionIssues.length > 0) {
        recoveryIssues = postconditionIssues;
        throw new Error("Contract connectivity postcondition failed.");
      }

      const erc = await this.#callSourceBoundTool("run_erc", {});
      if (erc.isError === true) throw new Error("KiCad ERC could not run after contract connectivity mutation.");
      const ercPayload = JSON.parse(resultContent(erc, true)) as Record<string, unknown>;
      if (!ercIsClean(ercPayload)) {
        recoveryIssues = [{ code: "ERC_NOT_CLEAN", message: "Exact connectivity readback passed, but ERC is not clean.", remediation: "Correct placement or other ERC design findings, then retry; do not change contract topology." }];
        throw new Error("Contract connectivity ERC postcondition failed.");
      }
    } catch (error) {
      const issues = recoveryIssues ?? [{
        code: "CONNECTIVITY_MUTATION_FAILED",
        message: `Contract connectivity mutation stopped after ${completedMutationCalls} successful host mutation call(s): ${(error instanceof Error ? error.message : String(error)).replace(/\s+/gu, " ").slice(0, 500)}`,
        remediation: "The exact schematic preimage was restored. Correct component placement if applicable, then retry the same empty-argument operation.",
      }];
      try {
        await this.#freshSchematicRollback!.restore(rollbackCheckpoint);
      } catch (rollbackError) {
        throw new Error(
          `FRESH_CONNECTIVITY_ROLLBACK_FAILED_TERMINAL: Contract connectivity mutation failed and exact disk rollback could not be verified: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          { cause: error },
        );
      }
      throw new Error(
        `FRESH_CONNECTIVITY_ROLLED_BACK_TERMINAL: ${issues.map((issue) => `${issue.code}: ${issue.message}`).join(" ")} Exact disk preimage restored and verified; the KiCad in-memory reload state is unproven, so this session must close without retry.`,
        { cause: error },
      );
    }

    this.#pendingFreshConnectivity = {
      contract, baseline: rollbackCheckpoint,
      noConnectPoints: contract.noConnects.map((endpoint) => ({ endpoint, point: pins.get(endpointId(endpoint))! })),
      labelAnchors: expectedLabels,
      ...(connectivityBatchAfterContentIdentity === undefined ? {} : { connectivityBatchAfterContentIdentity }),
    };
    return contractResult(call, contract, {
      applied: true, mutated: true, idempotent: false, issues: [],
      routes, noConnects: contract.noConnects.map(endpointId), connectivity: groups,
    });
  }

  async execute(callValue: HarnessToolCall<KicadHarnessToolName>): Promise<HarnessToolResult> {
    return await this.#call(callValue, true);
  }

  async #executeInternal(call: HarnessToolCall): Promise<HarnessToolResult> {
    return await this.#call(call, false, ["run_erc", "run_drc", "pcb_get_board_summary", "pcb_visual_qa"].includes(call.name));
  }

  async #terminalSaveFailure(call: HarnessToolCall, message: string, cause?:unknown): Promise<HarnessToolResult> {
    if(this.#pendingFreshBoardPostSave?.kind==="plane")return await this.#planeApplyFailure(call,this.#pendingFreshBoardPostSave.before,this.#pendingFreshBoardPostSave.observation,"native-save-readback",new Error(message));
    if(this.#pendingFreshBoardPostSave?.kind==="plane-route"||this.#pendingFreshBoardPostSave?.kind==="route"){
      const pending=this.#pendingFreshBoardPostSave;
      try{return await this.#routeMutationFailure(call,pending.net,pending.before,pending.physicalPcbSource,"mandatory-save/readback",cause??new Error(message),true,true);}
      catch(error){return harnessToolResultSchema.parse({toolCallId:call.id,isError:true,content:error instanceof Error?error.message:String(error)});}
    }
    const pending = this.#pendingFreshConnectivity;
    const placementCommit = this.#pendingFreshPlacementCommit;
    const baseline = pending?.baseline ?? placementCommit?.baseline;
    let rollback = "";
    let rollbackFailed = false;
    if (baseline !== undefined) {
      try {
        await this.#freshSchematicRollback!.restore(baseline);
        rollback = " Exact schematic disk preimage restored and verified; live KiCad state remains unproven.";
      } catch (error) {
        rollbackFailed = true;
        rollback = ` Exact schematic rollback also failed verification: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (this.#pendingFreshBoardPostSave !== undefined && this.#freshBoardPersistence?.hasPendingBoardMutation() === true) {
      try {
        await this.#freshBoardPersistence.rollbackToPreMutation(this.#session);
        rollback += " Exact PCB disk/live preimage restored and verified.";
      } catch (error) {
        rollbackFailed = true;
        rollback += ` Exact PCB rollback also failed verification: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    this.#pendingFreshBoardPostSave = undefined;
    this.#pendingFreshConnectivity = undefined;
    this.#pendingFreshPlacementCommit = undefined;
    this.#pendingPersistedMutationBaseline = undefined;
    this.#pendingSchematicFileMutationBatch = undefined;
    const prefix = placementCommit !== undefined
      ? rollbackFailed ? "FRESH_CONNECTIVITY_PLACEMENT_ROLLBACK_FAILED_TERMINAL" : "FRESH_CONNECTIVITY_PLACEMENT_SAVE_ROLLED_BACK_TERMINAL"
      : pending === undefined ? "SAVE_TERMINAL" : "FRESH_CONNECTIVITY_SAVE_TERMINAL";
    return harnessToolResultSchema.parse({
      toolCallId: call.id,
      isError: true,
      content: `${prefix}: ${message.replace(/\s+/gu, " ").slice(0, 1_200)}.${rollback} The editing session must close without retry.`,
    });
  }

  async #completeFreshConnectivityParity(
    call: HarnessToolCall,
    saveResult: HarnessToolResult,
  ): Promise<HarnessToolResult> {
    const pending = this.#pendingFreshConnectivity;
    if (pending === undefined) {
      // Raw generic schematic saves also remain inside the authored-pattern
      // source model, even when no connectivity compound is pending.
      await this.#assertFreshCompoundAuthority();
      if (this.#pendingFreshPlacementCommit !== undefined) {
        this.#pendingFreshPlacementCommit.saveVerified = true;
        return saveResult;
      }
      this.#pendingPersistedMutationBaseline = undefined;
      this.#pendingSchematicFileMutationBatch = undefined;
      return saveResult;
    }
    if (this.#captureFreshNativeNetlist === undefined) {
      return await this.#terminalSaveFailure(call, "Native netlist parity is unavailable because no host-native KiCad netlist capture is configured");
    }
    try {
      const schematicSource = await readFile(this.#freshProject!.schematicPath, "utf8");
      const schematic = parseFreshSchematicSource(schematicSource);
      const governedAfterIdentity = pending.fieldLayoutAfterContentIdentity ?? pending.connectivityBatchAfterContentIdentity;
      const governedOperation = pending.fieldLayoutAfterContentIdentity === undefined ? "connectivity-batch" : "field-layout";
      if (governedAfterIdentity !== undefined
          && !sameContentIdentity(contentIdentity(schematicSource), governedAfterIdentity)) {
        throw new Error(`The exact ${governedOperation} schematic source changed before its mandatory save/native parity checkpoint.`);
      }
      const globalLabels = contractAuthoringProject(this.#freshProject);
      if (globalLabels) assertFreshGenericSchematicSource(schematic);
      if (!exactFreshContractLabelsMatch(schematicSource, pending.labelAnchors, globalLabels)) {
        throw new Error("Persisted schematic label kinds, shapes, names, or anchors do not exactly reproduce the host contract after save");
      }
      const exactPersistedNoConnects = freshPersistedNoConnectsMatch(
        schematicSource,
        pending.noConnectPoints.map(({ point }) => point),
      );
      if (!exactPersistedNoConnects) {
        throw new Error("Persisted no-connect marker count or coordinates do not exactly reproduce the host-bound endpoints after save");
      }
      this.#assertLibrarySources();
      const source = await this.#captureFreshNativeNetlist();
      if (governedAfterIdentity !== undefined
          && !sameContentIdentity(contentIdentity(await readFile(this.#freshProject!.schematicPath)), governedAfterIdentity)) {
        throw new Error(`The exact ${governedOperation} schematic source changed during its mandatory save native capture.`);
      }
      const issues = freshNativeNetlistParityIssues(pending.contract, source);
      if (issues.length > 0) throw new Error(issues.map((issue) => `${issue.code}: ${issue.message}`).join(" "));
      this.#assertLibrarySources();
      this.#pendingFreshConnectivity = undefined;
      this.#pendingPersistedMutationBaseline = undefined;
      this.#pendingSchematicFileMutationBatch = undefined;
      return harnessToolResultSchema.parse({
        toolCallId: call.id,
        content: JSON.stringify({
          status: "saved-and-native-connectivity-verified",
          contractIdentity: pending.contract.identity,
          nativeNetlistSha256: sha256(source),
          nativeNetCount: pending.contract.nets.length,
          nativeComponentCount: pending.contract.components.length,
        }),
      });
    } catch (error) {
      return await this.#terminalSaveFailure(call, `Saved contract connectivity failed native parity: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async #completeFreshBoardPostSave(): Promise<void> {
    const pending = this.#pendingFreshBoardPostSave;
    if (pending === undefined) return;
    if(pending.kind==="plane")throw new Error("Plane stage requires its dedicated native-save/readback path, including source-equivalent updates.");
    await this.#assertFreshCompoundAuthority();
    const capture = await captureFreshPcb(this.#freshProject!);
    if (pending.kind === "text") {
      if (pending.expectedAfter === undefined || !freshBoardSerializationsEqual(pending.expectedAfter, capture.source)) throw new Error("Saved PCB text differs from verified native insertion.");
      assertOnlyRequestedPcbTextAdded(pending.before, capture.source, pending.requested);
      const live = await freshActiveBoardSource(this.#session, this.#freshProject!.pcbPath);
      if (!freshBoardSerializationsEqual(capture.source, live)) throw new Error("Saved PCB text and live board differ after save.");
      if (!sameContentIdentity((await captureFreshPcb(this.#freshProject!)).contentIdentity, capture.contentIdentity)) throw new Error("Saved PCB source changed during text readback.");
      this.#pendingFreshBoardPostSave = undefined;
      return;
    }
    const physicalMode=this.#freshPhysicalFootprintResolver!==undefined;
    if(pending.kind==="sync")assertFullSyncedFootprintIds(pending.contract,capture.parsed);
    const sourcePads=exactContractPadPositions(this.#freshProject!,pending.contract,capture.parsed,physicalMode);
    if(physicalMode&&(pending.physicalPcbSource===undefined||!freshBoardSerializationsEqual(pending.physicalPcbSource,capture.source)))throw new Error("Mandatory PCB save changed the exact verified physical board source.");
    const physicalState=await this.#physicalPadState(capture,physicalMode&&(pending.kind==="route"||pending.kind==="plane-route")?sourcePads.filter(pad=>pad.net===pending.net).map(pad=>pad.physical!.id):[]);
    const pads=physicalState?.pads??sourcePads;
    if (pending.kind === "sync" && !sameContentIdentity(
      contentIdentity(await readFile(this.#freshProject!.schematicPath)), pending.schematicContentIdentity,
    )) throw new Error("Exact saved schematic bytes changed before the synchronized PCB save committed.");
    if(physicalMode&&pending.kind==="sync"){
      const native=await this.#captureFreshNativeNetlist!();
      if(pending.nativeNetlistSource===undefined||freshNativeNetlistParityIssues(pending.contract,native).length>0||!compareFreshNativeNetlists(pending.nativeNetlistSource,native).equal)throw new Error("Mandatory synchronized PCB save failed fresh native schematic/netlist parity.");
      if(!sameContentIdentity(contentIdentity(await readFile(this.#freshProject!.schematicPath)),pending.schematicContentIdentity))throw new Error("Exact schematic source changed during mandatory sync-save native parity capture.");
    }
    if (pending.kind === "route") {
      const selection = buildRouteSelection(pending.contract, capture);
      if (canonicalJson(selection.items) !== canonicalJson(pending.expectedItems)) {
        throw new Error("Saved route-item inventory differs from the exact verified live replacement.");
      }
      assertCleanReplacementRoute(
        pending.design,
        this.#freshCompilationBundle!.practiceProfileBinding.profile,
        pending.net,
        selection,
        pads,
        capture.source,
      );
      if(physicalState!==undefined)this.#assertPhysicalRouteReachability(pending.net,pending.contract,capture,physicalState.observation,physicalState.pads);
    }
    if(pending.kind==="plane-route"){
      const selection=buildRouteSelection(pending.contract,capture);
      if(canonicalJson(selection.items)!==canonicalJson(pending.expectedItems))throw new Error("Saved plane route-item inventory differs from the exact verified incremental mutation.");
      assertPlaneIncrementalRouteGeometry(pending.design,pending.net,selection.items,physicalState!.pads);
      // The complete private native observation is bound above, but arbitrary
      // incomplete access pieces must not be promoted to connected terminals.
    }
    if(physicalMode){
      const settled=await captureFreshPcb(this.#freshProject!);
      if(!sameContentIdentity(settled.contentIdentity,capture.contentIdentity)||!sameContentIdentity(settled.freshMarkerContentIdentity,capture.freshMarkerContentIdentity))throw new Error("PCB source/marker changed after mandatory save evidence collection.");
      this.#assertPhysicalLibrarySources();
    }
    if(pending.kind==="route"||pending.kind==="plane-route")this.#session.finishNativeRouteTransaction?.();
    this.#pendingFreshBoardPostSave = undefined;
  }

  async #saveAfterMutation(call: HarnessToolCall): Promise<HarnessToolResult> {
    if(this.#pendingFreshBoardPostSave?.kind==="plane"){
      const pending=this.#pendingFreshBoardPostSave;
      const run=this.#tail.then(async()=>await this.#saveFreshPlane(call,pending));
      this.#tail=run.then(()=>undefined,()=>undefined);
      return await run;
    }
    if(this.#planeRecoveryRequired)return harnessToolResultSchema.parse({toolCallId:call.id,isError:true,content:"PLANE_APPLY_RECOVERY_REQUIRED: Save is refused; preserve and inspect current state, then close."});
    if(this.#routeRecoveryRequired)return harnessToolResultSchema.parse({toolCallId:call.id,isError:true,content:"ROUTE_RECOVERY_REQUIRED: Save is refused; preserve and inspect current state, then close."});
    try {
      if (this.#session.listTools().some((tool) => tool.name === "pcb_save")) {
        const saved = await this.#call(call, false);
        if (saved.isError) return await this.#terminalSaveFailure(call, `KiCad pcb_save returned an MCP error: ${saved.content}`);
        const genericPersisted = this.#verifyPersistedMutation !== undefined
          && await this.#verifyPersistedMutation(this.#pendingPersistedMutationBaseline);
        const boardPersistenceRequired = this.#freshBoardPersistence?.hasPendingBoardMutation() === true;
        const boardPersisted = !boardPersistenceRequired || await this.#freshBoardPersistence!.diskChangedSinceCapture();
        if (genericPersisted && boardPersisted) {
          await this.#completeFreshBoardPostSave();
          this.#freshBoardPersistence?.markNormalSaveComplete();
          return await this.#completeFreshConnectivityParity(call, saved);
        }
        if (this.#freshBoardPersistence !== undefined && boardPersistenceRequired) {
          try {
            const routePending=this.#pendingFreshBoardPostSave?.kind==="plane-route"?this.#pendingFreshBoardPostSave:undefined;
            const acceptedRouteLive=routePending===undefined?undefined:(await this.#knownBoardMutationState(routePending.before,routePending.physicalPcbSource,true)).live;
            const audit = await this.#freshBoardPersistence.recoverFromLiveBoard(
              this.#session,
              saved.content,
              genericPersisted ? "pcb_save left the captured isolated board hash unchanged" : "pcb_save poll did not verify an isolated native-file change",
              true,
              acceptedRouteLive,
            );
            this.#freshBoardSaveAudits.push(audit);
            await this.#completeFreshBoardPostSave();
            this.#freshBoardPersistence.markNormalSaveComplete();
            return await this.#completeFreshConnectivityParity(call, harnessToolResultSchema.parse({
              toolCallId: call.id,
              content: JSON.stringify({ status: "persisted-by-fresh-live-board-fallback", durableSave: audit }),
            }));
          } catch (error) {
            return await this.#terminalSaveFailure(call, `Fresh durable board fallback failed: ${error instanceof Error ? error.message : String(error)}`,error);
          }
        }
        return await this.#terminalSaveFailure(call, "KiCad save did not produce a verified per-mutation isolated native-file change");
      }
      const persisted = this.#verifyPersistedMutation !== undefined
        && await this.#verifyPersistedMutation(this.#pendingPersistedMutationBaseline);
      if (persisted) {
        await this.#completeFreshBoardPostSave();
        this.#freshBoardPersistence?.markNormalSaveComplete();
        return await this.#completeFreshConnectivityParity(call, harnessToolResultSchema.parse({ toolCallId: call.id, content: JSON.stringify({ status: "persisted-by-edit-tool" }) }));
      }
      return await this.#terminalSaveFailure(call, "KiCad IPC did not advertise pcb_save and no per-mutation persisted file change was verified");
    } catch (error) {
      return await this.#terminalSaveFailure(call, `Save or persistence verification threw: ${error instanceof Error ? error.message : String(error)}`,error);
    }
  }

  async runFinalValidation(): Promise<Readonly<Record<"erc" | "drc" | "boardSummary" | "visualQa", unknown>>> {
    const names = [
      ["erc", "run_erc"],
      ["drc", "run_drc"],
      ["boardSummary", "pcb_get_board_summary"],
      ["visualQa", "pcb_visual_qa"],
    ] as const;
    const values = await Promise.all(names.map(async ([, name], index) =>
      JSON.parse((await this.#executeInternal({ id: `final-${index + 1}`, name, arguments: {} })).content),
    ));
    return Object.freeze({
      erc: values[0],
      drc: values[1],
      boardSummary: values[2],
      visualQa: values[3],
    });
  }
}

/** Creates an edit-capable bridge; callers must provide an isolated working-copy session. */
export function createKicadHarnessTools(session: KicadHarnessSession, options: KicadHarnessToolsOptions = {}): KicadHarnessTools {
  return new SerializedKicadHarnessTools(session, options);
}

export async function connectKicadHarnessTools(options: KicadMcpSessionOptions): Promise<{
  readonly session: KicadMcpSession;
  readonly tools: KicadHarnessTools;
}> {
  if (options.mode !== "write" || (options.isolatedWorkingCopy === undefined && options.freshProject !== true)) {
    throw new Error("KiCad harness editing requires write mode with an isolated working copy or a verified fresh project.");
  }
  const session = await KicadMcpSession.connect(options);
  return Object.freeze({ session, tools: createKicadHarnessTools(session) });
}
