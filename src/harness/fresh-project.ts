import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { canonicalIdentity, canonicalJson, constantTimeDigestEqual, contentIdentity } from "../core/canonical.js";
import { parsePortableJsonBytes } from "../core/portable-artifact.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import {
  assertEmptyDerivedNetClassAssignments,
  assertExactContractNetClassPatterns,
  createExactContractNetClassPatterns,
} from "./fresh-netclass-assignment.js";
import {
  createPcbDesignCompilationBundleRef,
  parsePcbDesignCompilationBundleRef,
  type PcbDesignCompilationBundle,
  type PcbDesignCompilationBundleRef,
} from "./pcb-design-compilation-bundle.js";
import {
  createPcbPlaneCompilationBundleRef,
  isAuthenticatedPcbPlaneCompilationBundle,
  parsePcbPlaneCompilationBundleRef,
  type PcbPlaneCompilationBundle,
  type PcbPlaneCompilationBundleRef,
} from "./pcb-design-plane-bundle.js";
import { createFreshPlaneRules } from "./fresh-plane-rules.js";
import { createNativeEmptyBoardSeed } from "./native-empty-board-seed.js";
import { createInterfaceConstructionBoardSeed } from "./interface-construction-seed.js";
import { powerAnnotationBindingOf } from "./pcb-derived-power.js";
import { derivePcbNativeNumericRules } from "./pcb-native-numeric-rules.js";
import { consumeFreshPlaneSchematicSeed, assertFreshPlaneSchematicSeedBaseline, assertFreshPlaneSchematicSeedCurrent,
  type FreshPlaneSchematicSeed } from "./fresh-plane-schematic-seed.js";
import { consumeFreshPlanePlacementSeed, assertFreshPlanePlacementSeedBaseline, assertFreshPlanePlacementSeedCurrent,
  assertFreshPlanePlacementSeedPcb, assertFreshPlanePlacementSeedFile, type FreshPlanePlacementSeed } from "./fresh-plane-placement-seed.js";

/** Strict, local contracts for the audited incremental sidecar calls. */
const coordinate = z.number().finite().min(-2_000).max(2_000);
const rotation = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]);
const labelJustify = z.enum(["left", "right", "top", "bottom", "left top", "left bottom", "right top", "right bottom", "none"]);
const labelKind = z.enum(["local", "global", "hierarchical"]);
const labelShape = z.enum(["input", "output", "bidirectional", "tri_state", "passive"]);
const reference = z.string().min(1).max(64);
const sheetless = z.object({}).strict();
const addSymbol = z.object({ library: z.string().min(1).max(120), symbol_name: z.string().min(1).max(240), x_mm: coordinate, y_mm: coordinate, reference, value: z.string().min(1).max(240), footprint: z.string().max(240).optional(), rotation: rotation.optional(), snap_to_grid: z.boolean().optional(), unit: z.number().int().min(1).max(64).optional() }).strict();
const addWire = z.object({ x1_mm: coordinate, y1_mm: coordinate, x2_mm: coordinate, y2_mm: coordinate, snap_to_grid: z.boolean().optional() }).strict();
const addLabel = z.object({ name: z.string().min(1).max(240), x_mm: coordinate, y_mm: coordinate, rotation: rotation.optional(), snap_to_grid: z.boolean().optional(), justify: labelJustify.optional() }).strict();
const addLabels = z.object({ labels: z.array(z.object({ name: z.string().min(1).max(240), x_mm: coordinate, y_mm: coordinate, rotation: rotation.optional(), kind: labelKind.optional(), shape: labelShape.optional(), justify: labelJustify.optional(), snap_to_grid: z.boolean().optional() }).strict()).min(1).max(128) }).strict();
const addPower = z.object({ name: z.string().min(1).max(120), x_mm: coordinate, y_mm: coordinate, rotation: rotation.optional(), snap_to_grid: z.boolean().optional() }).strict();
const property = z.object({ reference, field: z.string().min(1).max(120), value: z.string().max(1_000) }).strict();
const assignFootprint = z.object({ reference, library: z.string().min(1).max(120), footprint: z.string().min(1).max(240) }).strict();
const routeBetweenPins = z.object({ ref1: reference, pin1: z.string().min(1).max(64), ref2: reference, pin2: z.string().min(1).max(64), snap_to_grid: z.boolean().optional() }).strict();
const moveSymbol = z.object({ reference, x_mm: coordinate, y_mm: coordinate, snap_to_grid: z.boolean().optional() }).strict();
const addNoConnect = z.object({ x_mm: coordinate, y_mm: coordinate, snap_to_grid: z.boolean().optional() }).strict();
const pinPositions = z.object({ library: z.string().min(1).max(120), symbol_name: z.string().min(1).max(240), x_mm: coordinate, y_mm: coordinate, rotation: rotation.optional(), unit: z.number().int().min(1).max(64).optional() }).strict();
const applyContractConnectivity = z.object({}).strict();
const schematicFieldPositions = z.object({ updates: z.array(z.object({
  reference: z.string().regex(/^[A-Z][A-Z0-9_-]{0,31}$/u), field: z.enum(["Reference", "Value"]), x_mm: coordinate, y_mm: coordinate,
}).strict()).min(1).max(128) }).strict().superRefine((value, context) => {
  if (new Set(value.updates.map(update => `${update.reference}:${update.field}`)).size !== value.updates.length) context.addIssue({ code: "custom", message: "reference/field pairs must be unique" });
});
const schematicSymbolPoses = z.object({ updates: z.array(z.object({ reference: z.string().regex(/^[A-Z][A-Z0-9_-]{0,31}$/u),
  x_mm: coordinate, y_mm: coordinate, rotation }).strict()).min(1).max(64) }).strict().superRefine((value, context) => {
  if (new Set(value.updates.map(update => update.reference)).size !== value.updates.length) context.addIssue({ code: "custom", message: "symbol references must be unique" });
});
const recommendationIdentity = z.object({
  algorithm: z.literal("sha256"),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  schemaVersion: z.literal("evleda.fresh-connectivity-placement-plan.v2"),
  canonicalizationVersion: z.literal("evleda-c14n-json-v1"),
}).strict();
const applyRecommendedPlacement = z.object({ recommendationIdentity }).strict();
const freshRouteSelectionIdentity = z.object({
  algorithm: z.literal("sha256"),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  schemaVersion: z.literal("evleda.fresh-route-selection.v1"),
  canonicalizationVersion: z.literal("evleda-c14n-json-v1"),
}).strict();
export const FRESH_PLANE_ROUTE_PAGE_SIZE = 32;
const freshPlaneRouteReadArguments = z.object({ page: z.object({
  selectionIdentity: freshRouteSelectionIdentity.extend({ schemaVersion: z.literal("evleda.fresh-plane-route-selection.v1") }).strict(),
  offset: z.number().int().min(FRESH_PLANE_ROUTE_PAGE_SIZE).max(1248).multipleOf(FRESH_PLANE_ROUTE_PAGE_SIZE),
}).strict().optional() }).strict();
/** V2-only continuation; the original V1 empty-argument schema is unchanged. */
export const FRESH_PLANE_ROUTE_READ_INPUT_SCHEMA = Object.freeze(z.toJSONSchema(freshPlaneRouteReadArguments));
export const parseFreshPlaneRouteReadArguments = (value: unknown) => freshPlaneRouteReadArguments.parse(value);
const freshRouteTrack = z.object({
  x1Mm: coordinate, y1Mm: coordinate, x2Mm: coordinate, y2Mm: coordinate,
  layer: z.enum(["F.Cu", "B.Cu"]),
}).strict();
const freshRouteVia = z.object({ xMm: coordinate, yMm: coordinate }).strict();
const freshPadSelection = z.object({reference:reference.optional(),pad:z.string().min(1).max(32).regex(/^[A-Za-z0-9][A-Za-z0-9.+/_-]{0,31}$/u).optional()}).strict().superRefine((value,context)=>{
  if(value.pad!==undefined&&value.reference===undefined)context.addIssue({code:"custom",message:"pad selection requires its exact component reference"});
});
const freshReplaceRouteItems = z.object({
  selectionIdentity: freshRouteSelectionIdentity,
  net: z.string().min(1).max(64).regex(/^[A-Za-z0-9+-][A-Za-z0-9_.+-]{0,63}$/u),
  deleteItemIds: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u)).min(1).max(128),
  tracks: z.array(freshRouteTrack).max(128),
  vias: z.array(freshRouteVia).max(32),
}).strict().superRefine((value, context) => {
  if (new Set(value.deleteItemIds).size !== value.deleteItemIds.length) {
    context.addIssue({ code: "custom", message: "deleteItemIds must be unique" });
  }
  if (value.tracks.length + value.vias.length === 0) {
    context.addIssue({ code: "custom", message: "route replacement must add at least one track or via" });
  }
});

export const FRESH_INCREMENTAL_ARGUMENT_SCHEMAS = Object.freeze({
  fresh_set_schematic_symbol_poses: schematicSymbolPoses,
  sch_get_symbols: sheetless, sch_get_connectivity_graph: sheetless, sch_get_bounding_boxes: sheetless,
  fresh_get_contract_pad_positions: freshPadSelection, fresh_get_route_items: sheetless, fresh_sync_from_schematic: sheetless, fresh_autoplace_schematic_fields: sheetless,
  fresh_replace_route_items: freshReplaceRouteItems,
  fresh_set_schematic_field_positions: schematicFieldPositions,
  lib_verify_component_contract: z.object({ reference }).strict(),
  sch_add_symbol: addSymbol, sch_add_wire: addWire, sch_add_label: addLabel, sch_add_labels: addLabels, sch_get_pin_positions: pinPositions, fresh_apply_contract_connectivity: applyContractConnectivity, fresh_apply_recommended_schematic_placement: applyRecommendedPlacement, sch_add_power_symbol: addPower,
  sch_add_no_connect: addNoConnect, sch_modify_property: property, lib_assign_footprint: assignFootprint,
  sch_route_wire_between_pins: routeBetweenPins, sch_move_symbol: moveSymbol,
});

const primitiveSchema = (type: "string" | "number" | "integer" | "boolean", extras: Record<string, unknown> = {}) => ({ type, ...extras });
const objectSchema = (properties: Record<string, unknown>, required: readonly string[]) => Object.freeze({ type: "object", additionalProperties: false, properties, required: [...required] });
const coordinateSchema = primitiveSchema("number");
const rotationSchema = primitiveSchema("integer", { enum: [0, 90, 180, 270] });
const labelJustifySchema = primitiveSchema("string", { enum: ["left", "right", "top", "bottom", "left top", "left bottom", "right top", "right bottom", "none"] });
const labelKindSchema = primitiveSchema("string", { enum: ["local", "global", "hierarchical"] });
const labelShapeSchema = primitiveSchema("string", { enum: ["input", "output", "bidirectional", "tri_state", "passive"] });
export const FRESH_INCREMENTAL_INPUT_SCHEMAS = Object.freeze({
  fresh_set_schematic_symbol_poses: objectSchema({ updates: { type: "array", minItems: 1, maxItems: 64, items: objectSchema({
    reference: primitiveSchema("string", { pattern: "^[A-Z][A-Z0-9_-]{0,31}$" }),
    x_mm: primitiveSchema("number", { minimum: -2000, maximum: 2000 }), y_mm: primitiveSchema("number", { minimum: -2000, maximum: 2000 }),
    rotation: rotationSchema }, ["reference", "x_mm", "y_mm", "rotation"]) } }, ["updates"]),
  fresh_set_schematic_field_positions: objectSchema({ updates: { type: "array", minItems: 1, maxItems: 128, items: objectSchema({
    reference: primitiveSchema("string", { pattern: "^[A-Z][A-Z0-9_-]{0,31}$" }), field: primitiveSchema("string", { enum: ["Reference", "Value"] }),
    x_mm: primitiveSchema("number", { minimum: -2000, maximum: 2000 }),
    y_mm: primitiveSchema("number", { minimum: -2000, maximum: 2000 }),
  }, ["reference", "field", "x_mm", "y_mm"]) } }, ["updates"]),
  sch_get_symbols: objectSchema({}, []), sch_get_connectivity_graph: objectSchema({}, []), sch_get_bounding_boxes: objectSchema({}, []),
  fresh_get_contract_pad_positions: Object.freeze({...objectSchema({reference:primitiveSchema("string",{minLength:1,maxLength:32}),pad:primitiveSchema("string",{minLength:1,maxLength:32})},[]),dependentRequired:{pad:["reference"]}}), fresh_get_route_items: objectSchema({}, []), fresh_sync_from_schematic: objectSchema({}, []), fresh_autoplace_schematic_fields: objectSchema({}, []),
  fresh_replace_route_items: objectSchema({
    selectionIdentity: objectSchema({
      algorithm: primitiveSchema("string", { const: "sha256" }),
      digest: primitiveSchema("string", { pattern: "^[a-f0-9]{64}$" }),
      schemaVersion: primitiveSchema("string", { const: "evleda.fresh-route-selection.v1" }),
      canonicalizationVersion: primitiveSchema("string", { const: "evleda-c14n-json-v1" }),
    }, ["algorithm", "digest", "schemaVersion", "canonicalizationVersion"]),
    net: primitiveSchema("string", { pattern: "^[A-Za-z0-9+-][A-Za-z0-9_.+-]{0,63}$" }),
    deleteItemIds: { type: "array", minItems: 1, maxItems: 128, uniqueItems: true, items: primitiveSchema("string", { pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" }) },
    tracks: { type: "array", maxItems: 128, items: objectSchema({ x1Mm: coordinateSchema, y1Mm: coordinateSchema, x2Mm: coordinateSchema, y2Mm: coordinateSchema, layer: primitiveSchema("string", { enum: ["F.Cu", "B.Cu"] }) }, ["x1Mm", "y1Mm", "x2Mm", "y2Mm", "layer"]) },
    vias: { type: "array", maxItems: 32, items: objectSchema({ xMm: coordinateSchema, yMm: coordinateSchema }, ["xMm", "yMm"]) },
  }, ["selectionIdentity", "net", "deleteItemIds", "tracks", "vias"]),
  lib_verify_component_contract: objectSchema({ reference: primitiveSchema("string") }, ["reference"]),
  sch_add_symbol: objectSchema({ library: primitiveSchema("string"), symbol_name: primitiveSchema("string"), x_mm: coordinateSchema, y_mm: coordinateSchema, reference: primitiveSchema("string"), value: primitiveSchema("string"), footprint: primitiveSchema("string"), rotation: rotationSchema, snap_to_grid: primitiveSchema("boolean"), unit: primitiveSchema("integer") }, ["library", "symbol_name", "x_mm", "y_mm", "reference", "value"]),
  sch_add_wire: objectSchema({ x1_mm: coordinateSchema, y1_mm: coordinateSchema, x2_mm: coordinateSchema, y2_mm: coordinateSchema, snap_to_grid: primitiveSchema("boolean") }, ["x1_mm", "y1_mm", "x2_mm", "y2_mm"]),
  sch_add_label: objectSchema({ name: primitiveSchema("string"), x_mm: coordinateSchema, y_mm: coordinateSchema, rotation: rotationSchema, snap_to_grid: primitiveSchema("boolean"), justify: labelJustifySchema }, ["name", "x_mm", "y_mm"]),
  sch_add_labels: objectSchema({ labels: { type: "array", minItems: 1, maxItems: 128, items: objectSchema({ name: primitiveSchema("string"), x_mm: coordinateSchema, y_mm: coordinateSchema, rotation: rotationSchema, kind: labelKindSchema, shape: labelShapeSchema, justify: labelJustifySchema, snap_to_grid: primitiveSchema("boolean") }, ["name", "x_mm", "y_mm"]) } }, ["labels"]),
  sch_get_pin_positions: objectSchema({ library: primitiveSchema("string"), symbol_name: primitiveSchema("string"), x_mm: coordinateSchema, y_mm: coordinateSchema, rotation: rotationSchema, unit: primitiveSchema("integer") }, ["library", "symbol_name", "x_mm", "y_mm"]),
  fresh_apply_contract_connectivity: objectSchema({}, []),
  fresh_apply_recommended_schematic_placement: objectSchema({ recommendationIdentity: objectSchema({ algorithm: primitiveSchema("string", { const: "sha256" }), digest: primitiveSchema("string", { pattern: "^[a-f0-9]{64}$" }), schemaVersion: primitiveSchema("string", { const: "evleda.fresh-connectivity-placement-plan.v2" }), canonicalizationVersion: primitiveSchema("string", { const: "evleda-c14n-json-v1" }) }, ["algorithm", "digest", "schemaVersion", "canonicalizationVersion"]) }, ["recommendationIdentity"]),
  sch_add_power_symbol: objectSchema({ name: primitiveSchema("string"), x_mm: coordinateSchema, y_mm: coordinateSchema, rotation: rotationSchema, snap_to_grid: primitiveSchema("boolean") }, ["name", "x_mm", "y_mm"]),
  sch_add_no_connect: objectSchema({ x_mm: coordinateSchema, y_mm: coordinateSchema, snap_to_grid: primitiveSchema("boolean") }, ["x_mm", "y_mm"]),
  sch_modify_property: objectSchema({ reference: primitiveSchema("string"), field: primitiveSchema("string"), value: primitiveSchema("string") }, ["reference", "field", "value"]),
  lib_assign_footprint: objectSchema({ reference: primitiveSchema("string"), library: primitiveSchema("string"), footprint: primitiveSchema("string") }, ["reference", "library", "footprint"]),
  sch_route_wire_between_pins: objectSchema({ ref1: primitiveSchema("string"), pin1: primitiveSchema("string"), ref2: primitiveSchema("string"), pin2: primitiveSchema("string"), snap_to_grid: primitiveSchema("boolean") }, ["ref1", "pin1", "ref2", "pin2"]),
  sch_move_symbol: objectSchema({ reference: primitiveSchema("string"), x_mm: coordinateSchema, y_mm: coordinateSchema, snap_to_grid: primitiveSchema("boolean") }, ["reference", "x_mm", "y_mm"]),
} as const);

export function parseFreshIncrementalArguments(name: string, value: unknown): Record<string, unknown> {
  const schema = FRESH_INCREMENTAL_ARGUMENT_SCHEMAS[name as keyof typeof FRESH_INCREMENTAL_ARGUMENT_SCHEMAS];
  if (schema === undefined) throw new Error(`Unsupported fresh schematic tool: ${name}`);
  return schema.parse(value) as Record<string, unknown>;
}

export const FRESH_PROJECT_MARKER_NAME = ".evleda-pcb-agent-fresh.json";
export const FRESH_PROJECT_CHECKPOINT_NAME = ".evleda-pcb-agent-checkpoint.json";
export const FRESH_PROJECT_UNSAFE_TERMINAL_NAME = ".evleda-pcb-agent-unsafe-terminal.json";
export const FRESH_PROJECT_DIRECTORY = "project";
export const GENERIC_FRESH_PROJECT_BINDING_SCHEMA_VERSION = "evleda.pcb-agent-generic-fresh-binding.v1" as const;
export const PLANE_FRESH_PROJECT_BINDING_SCHEMA_VERSION = "evleda.pcb-agent-plane-fresh-binding.v1" as const;
export const FRESH_PROJECT_OPEN_PREPARED_SOURCE_AUTHORITY_SCHEMA_VERSION = "evleda.fresh-project-open-prepared-source-authority.v1" as const;
const SAFE_NAME = /^[a-z][a-z0-9-]{0,63}$/u;
const freshProjectCapability = Symbol("evleda.fresh-project.capability");

/**
 * Cycle-free structural projection consumed by the Open checkpoint.  The
 * clearance-evidence module already depends on this module, so callers project
 * these two fields from their independently verified semantic authority.
 */
export interface FreshProjectManagedNetClass {
  readonly bus_width: number;
  readonly clearance: number;
  readonly diff_pair_gap: number;
  readonly diff_pair_via_gap: number;
  readonly diff_pair_width: number;
  readonly line_style: number;
  readonly microvia_diameter: number;
  readonly microvia_drill: number;
  readonly name: string;
  readonly pcb_color: string;
  readonly priority: number;
  readonly schematic_color: string;
  readonly track_width: number;
  readonly tuning_profile: string;
  readonly via_diameter: number;
  readonly via_drill: number;
  readonly wire_width: number;
}

export interface FreshProjectContractNetAssignment {
  readonly netName: string;
  readonly contractNetClassId: string;
  readonly kicadNetClassName: string;
}

export interface FreshProjectNetClassSemanticProjection {
  /** Bundle-owned classes only.  The audited KiCad Default is checked separately. */
  readonly netClasses: readonly FreshProjectManagedNetClass[];
  readonly contractNetAssignments: readonly FreshProjectContractNetAssignment[];
}

/**
 * Lifecycle-owned pre-Open authority.  It is captured while preparation still
 * owns the fresh capability and must not be reconstructed from the mutable
 * checkpoint being verified.  Only projectSettings may undergo the closed
 * KiCad Open normalization accepted below.
 */
export interface FreshProjectOpenPreparedSourceAuthority {
  readonly schemaVersion: typeof FRESH_PROJECT_OPEN_PREPARED_SOURCE_AUTHORITY_SCHEMA_VERSION;
  readonly projectIdentity: FreshFilesystemIdentity;
  readonly pro: ContentIdentity;
  readonly sch: ContentIdentity;
  readonly pcb: ContentIdentity;
  readonly sym: ContentIdentity;
  readonly fp: ContentIdentity;
  readonly marker: ContentIdentity;
  readonly identity: CanonicalIdentity;
}

export const validateFreshProjectName = (value: string): string => {
  const name = value.trim();
  if (!SAFE_NAME.test(name)) throw new Error("--new-project must be a safe lowercase name (a-z, 0-9, and hyphen; starts with a letter).");
  return name;
};

export interface FreshFilesystemIdentity {
  /** Canonical path plus dev/ino when this platform provides a stable pair. */
  readonly canonicalPath: string;
  readonly dev: string | null;
  readonly ino: string | null;
}

interface FreshMarkerV1 {
  readonly schemaVersion: "evleda.pcb-agent-fresh-project.v1";
  readonly name: string;
  readonly outputPath: string;
  readonly projectPath: string;
  readonly projectIdentity: FreshFilesystemIdentity;
  readonly files: Readonly<Record<"pro" | "sch" | "pcb" | "symLibTable" | "fpLibTable", { readonly path: string; readonly sha256: string }>>;
}

export interface GenericFreshProjectBinding {
  readonly schemaVersion: typeof GENERIC_FRESH_PROJECT_BINDING_SCHEMA_VERSION;
  readonly bundleRef: PcbDesignCompilationBundleRef;
  readonly contractIdentity: CanonicalIdentity;
  readonly libraryBindingIdentity: CanonicalIdentity;
  readonly deepRuleBindingIdentity: CanonicalIdentity;
  readonly practiceProfileBindingIdentity: CanonicalIdentity;
  readonly acceptancePlanIdentity: CanonicalIdentity;
  readonly executionPromptContentIdentity: ContentIdentity;
  readonly symbolLibraryTableIdentity: ContentIdentity;
  readonly footprintLibraryTableIdentity: ContentIdentity;
  readonly identity: CanonicalIdentity;
}

interface FreshMarkerV2 {
  readonly schemaVersion: "evleda.pcb-agent-fresh-project.v2";
  readonly workflowKind: "generic";
  readonly name: string;
  readonly outputPath: string;
  readonly projectPath: string;
  readonly projectIdentity: FreshFilesystemIdentity;
  readonly files: FreshMarkerV1["files"];
  readonly genericBinding: GenericFreshProjectBinding;
}

export interface PlaneFreshProjectBinding {
  readonly schemaVersion: typeof PLANE_FRESH_PROJECT_BINDING_SCHEMA_VERSION;
  readonly family: "plane-v2";
  readonly bundleRef: PcbPlaneCompilationBundleRef;
  readonly contractIdentity: CanonicalIdentity;
  readonly libraryBindingIdentity: CanonicalIdentity;
  readonly deepRuleBindingIdentity: CanonicalIdentity;
  readonly verificationPlanIdentity: CanonicalIdentity;
  readonly guidanceContentIdentity: ContentIdentity;
  readonly originalPromptContentIdentity: ContentIdentity;
  readonly expectedRulesContentIdentity: ContentIdentity;
  readonly symbolLibraryTableIdentity: ContentIdentity;
  readonly footprintLibraryTableIdentity: ContentIdentity;
  readonly identity: CanonicalIdentity;
}

interface FreshMarkerV3 {
  readonly schemaVersion: "evleda.pcb-agent-fresh-project.v3";
  readonly workflowKind: "plane";
  readonly name: string;
  readonly outputPath: string;
  readonly projectPath: string;
  readonly projectIdentity: FreshFilesystemIdentity;
  readonly files: FreshMarkerV1["files"] & Readonly<{ dru: { readonly path: string; readonly sha256: string } }>;
  readonly planeBinding: PlaneFreshProjectBinding;
}

type FreshMarker = FreshMarkerV1 | FreshMarkerV2 | FreshMarkerV3;

interface FreshCheckpointV1 {
  readonly schemaVersion: "evleda.pcb-agent-fresh-project-checkpoint.v1";
  readonly baselineMarkerSha256: string;
  readonly projectPath: string;
  readonly files: FreshMarker["files"];
  readonly reportPath: string;
  readonly reportSha256: string;
  readonly reportStatus: "completed" | "needs_review" | "blocked" | "failed";
  readonly attempt: number;
  readonly reason: "run_exit" | "legacy_migration" | "kicad_open_normalization";
}

interface FreshCheckpointV2 {
  readonly schemaVersion: "evleda.pcb-agent-fresh-project-checkpoint.v2";
  readonly baselineMarkerSha256: string;
  readonly projectPath: string;
  readonly files: FreshMarker["files"];
  readonly reportPath: string;
  readonly reportSha256: string;
  readonly reportStatus: FreshCheckpointV1["reportStatus"];
  readonly attempt: number;
  readonly reason: Exclude<FreshCheckpointV1["reason"], "legacy_migration">;
  readonly genericBindingIdentity: CanonicalIdentity;
  readonly symbolLibraryTableIdentity: ContentIdentity;
  readonly footprintLibraryTableIdentity: ContentIdentity;
}

interface FreshCheckpointV3 extends Omit<FreshCheckpointV2, "schemaVersion" | "genericBindingIdentity"> {
  readonly schemaVersion: "evleda.pcb-agent-fresh-project-checkpoint.v3";
  readonly planeBindingIdentity: CanonicalIdentity;
}

type FreshCheckpoint = FreshCheckpointV1 | FreshCheckpointV2 | FreshCheckpointV3;

export interface FreshCheckpointCommitOptions {
  /** Synchronous final fence; throwing prevents the atomic checkpoint rename. */
  readonly assertCanCommit?: () => void;
  readonly sourceGuard?: FreshProjectCheckpointGuard;
}

/** Opaque in-process source witness; serialization does not preserve its authority. */
export interface FreshProjectCheckpointGuard {
  readonly schemaVersion: "evleda.fresh-checkpoint-source-guard.v1";
}
const checkpointGuards = new WeakSet<object>();
const checkpointGuardState = new WeakMap<object, { project: FreshProject; marker: FreshMarker; snapshot: FreshCheckpointPublicationSnapshot }>();

export interface FreshProject {
  readonly workflowKind: "led_compatibility_fixture" | "generic" | "plane";
  readonly genericBinding?: GenericFreshProjectBinding;
  readonly planeBinding?: PlaneFreshProjectBinding;
  readonly name: string;
  readonly outputPath: string;
  readonly projectPath: string;
  /** Immutable marker-bound canonical root and physical directory identity. */
  readonly projectIdentity: FreshFilesystemIdentity;
  readonly schematicPath: string;
  readonly pcbPath: string;
  readonly markerPath: string;
  readonly checkpointPath: string;
  readonly unsafeTerminalPath: string;
  /** Re-runs the closed marker parser and authenticates the original marker bytes captured when this capability was minted. */
  assertMarkerCurrent(): Promise<ContentIdentity>;
  /** Rechecks both the marker hash and the intentionally empty schematic. */
  assertSchematicEmpty(): Promise<void>;
  /** Atomically records a changed project only after its report has been persisted. */
  checkpointAfterReport(reportPath: string, status: FreshCheckpointV1["reportStatus"], options?: FreshCheckpointCommitOptions): Promise<void>;
  /** Permanently prevents resume after a transaction whose live/disk recovery is untrusted. */
  recordUnsafeTerminal(reportPath: string, reason: string): Promise<void>;
  /** Non-forgeable outside this module; prevents copied projects opting in by shape. */
  readonly [freshProjectCapability]: true;
}

export interface PlaneFreshProject extends FreshProject {
  readonly workflowKind: "plane";
  readonly planeBinding: PlaneFreshProjectBinding;
  readonly genericBinding?: never;
  readonly rulesPath: string;
}
const planeProjectCapabilities = new WeakSet<object>();
type NativeNumericProjection = NonNullable<ReturnType<typeof derivePcbNativeNumericRules>>;
const planeNumericProjections = new WeakMap<object, NativeNumericProjection>();

export const isVerifiedFreshProject = (value: unknown): value is FreshProject =>
  value !== null && typeof value === "object" && (value as FreshProject)[freshProjectCapability] === true;

export const isVerifiedPlaneFreshProject = (value: unknown): value is PlaneFreshProject =>
  isVerifiedFreshProject(value) && value.workflowKind === "plane" && planeProjectCapabilities.has(value);

interface FreshRegularFilePhysicalIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly mode: string;
}

interface FreshRegularFileCapture {
  readonly path: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly physical: FreshRegularFilePhysicalIdentity;
}

const physicalFileIdentity = (metadata: BigIntStats): FreshRegularFilePhysicalIdentity => ({
  dev: metadata.dev.toString(10),
  ino: metadata.ino.toString(10),
  size: metadata.size.toString(10),
  mtimeNs: metadata.mtimeNs.toString(10),
  ctimeNs: metadata.ctimeNs.toString(10),
  mode: metadata.mode.toString(10),
});

const samePhysicalFileIdentity = (left: FreshRegularFilePhysicalIdentity, right: FreshRegularFilePhysicalIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino && left.size === right.size
  && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.mode === right.mode;

const captureFreshRegularFile = async (filePath: string): Promise<FreshRegularFileCapture> => {
  const before = await lstat(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Fresh-project source is not an ordinary non-link file.");
  const bytes = await readFile(filePath);
  const after = await lstat(filePath, { bigint: true });
  const beforePhysical = physicalFileIdentity(before);
  const afterPhysical = physicalFileIdentity(after);
  if (!after.isFile() || after.isSymbolicLink() || !samePhysicalFileIdentity(beforePhysical, afterPhysical) || BigInt(bytes.byteLength) !== after.size) {
    throw new Error("Fresh-project source changed identity while its bytes were captured.");
  }
  return Object.freeze({ path: filePath, bytes, sha256: createHash("sha256").update(bytes).digest("hex"), physical: Object.freeze(afterPhysical) });
};

const captureOptionalFreshRegularFile = async (filePath: string): Promise<FreshRegularFileCapture | null> => {
  try { return await captureFreshRegularFile(filePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

const sha256 = async (filePath: string): Promise<string> => (await captureFreshRegularFile(filePath)).sha256;
const fileNames = (name: string) => ({
  pro: `${name}.kicad_pro`, sch: `${name}.kicad_sch`, pcb: `${name}.kicad_pcb`,
  symLibTable: "sym-lib-table", fpLibTable: "fp-lib-table",
} as const);

function emptySchematic(name: string, uuid: string): string {
  return `(kicad_sch\n  (version 20250316)\n  (generator "KiCad Studio Fixture Corpus")\n  (uuid "${uuid}")\n  (paper "A4")\n  (title_block (title "${name}"))\n\t(lib_symbols)\n\t(sheet_instances\n\t\t(path "/" (page "1"))\n\t)\n\t(embedded_fonts no)\n)\n`;
}
function emptyBoard(planeBundle?: PcbPlaneCompilationBundle): string {
  return planeBundle === undefined ? createNativeEmptyBoardSeed() : createInterfaceConstructionBoardSeed(planeBundle);
}

/** Strictly accepts one axis-aligned Edge.Cuts rectangle at the requested size. */
export function assertSingleFreshBoardOutline(boardText: string, widthMm = 30, heightMm = 20, toleranceMm = 0.01): void {
  const rectangles = [...boardText.matchAll(/\(gr_rect\s+\(start\s+([-\d.]+)\s+([-\d.]+)\)\s+\(end\s+([-\d.]+)\s+([-\d.]+)\)[\s\S]*?\(layer\s+"Edge\.Cuts"\)\)/gu)];
  if (rectangles.length !== 1) throw new Error(`Expected exactly one Edge.Cuts outline; found ${rectangles.length}.`);
  const match = rectangles[0]!;
  const actualWidth = Math.abs(Number(match[3]) - Number(match[1]));
  const actualHeight = Math.abs(Number(match[4]) - Number(match[2]));
  if (Math.abs(actualWidth - widthMm) > toleranceMm || Math.abs(actualHeight - heightMm) > toleranceMm) throw new Error(`Board outline must be ${widthMm}x${heightMm} mm.`);
}
function overlayNativeNumericProjection(settings: Record<string, unknown>, projection?: NativeNumericProjection): Record<string, unknown> {
  if (projection === undefined) return settings;
  const board = asRecord(settings.board, "board"), design = board.design_settings === undefined ? {} : asRecord(board.design_settings, "design_settings");
  return { ...settings, board: { ...board, design_settings: { ...design,
    rules: { ...(design.rules === undefined ? {} : asRecord(design.rules, "rules")), ...projection.boardRules },
    rule_severities: { ...(design.rule_severities === undefined ? {} : asRecord(design.rule_severities, "rule_severities")), ...projection.requiredNativeCheckSeverities },
  } } };
}
function emptyProject(name: string, projection?: NativeNumericProjection): string {
  return `${JSON.stringify(overlayNativeNumericProjection({ meta: { filename: name, version: 1, fixtureId: "evleda-fresh-kicad10", generatedBy: "evleda pcb-agent fresh project" }, schematic: { file: `${name}.kicad_sch` }, board: { file: `${name}.kicad_pcb` } }, projection), null, 2)}\n`;
}

/** Project-local table entries deliberately resolve through the verified KiCad 10 environment. */
function freshSymbolLibraryTable(): string {
  return `(sym_lib_table\n  (version 7)\n  (lib (name "Device")(type "KiCad")(uri "${"${KICAD10_SYMBOL_DIR}"}/Device.kicad_sym")(options "")(descr "KiCad 10 stock Device symbols"))\n  (lib (name "Connector_Generic")(type "KiCad")(uri "${"${KICAD10_SYMBOL_DIR}"}/Connector_Generic.kicad_sym")(options "")(descr "KiCad 10 stock generic connectors"))\n)\n`;
}
function freshFootprintLibraryTable(): string {
  return `(fp_lib_table\n  (version 7)\n  (lib (name "Connector_PinHeader_2.54mm")(type "KiCad")(uri "${"${KICAD10_FOOTPRINT_DIR}"}/Connector_PinHeader_2.54mm.pretty")(options "")(descr "KiCad 10 stock pin headers"))\n  (lib (name "Resistor_SMD")(type "KiCad")(uri "${"${KICAD10_FOOTPRINT_DIR}"}/Resistor_SMD.pretty")(options "")(descr "KiCad 10 stock SMD resistors"))\n  (lib (name "LED_SMD")(type "KiCad")(uri "${"${KICAD10_FOOTPRINT_DIR}"}/LED_SMD.pretty")(options "")(descr "KiCad 10 stock SMD LEDs"))\n  (lib (name "Capacitor_SMD")(type "KiCad")(uri "${"${KICAD10_FOOTPRINT_DIR}"}/Capacitor_SMD.pretty")(options "")(descr "KiCad 10 stock SMD capacitors"))\n)\n`;
}

const safeKicadLibraryNickname = (libraryId: string): string => {
  const separator = libraryId.indexOf(":");
  const nickname = separator < 1 ? "" : libraryId.slice(0, separator);
  if (!/^[A-Za-z][A-Za-z0-9_.+-]{0,119}$/u.test(nickname)) {
    throw new Error(`Generic fresh contract uses an unsupported KiCad library nickname: ${JSON.stringify(nickname)}.`);
  }
  return nickname;
};

const uniqueSortedLibraryNicknames = (libraryIds: readonly string[]): readonly string[] =>
  [...new Set(libraryIds.map(safeKicadLibraryNickname))].sort((left, right) => left.localeCompare(right, "en-US"));

const freezeGenericBinding = <Value>(value: Value): Value => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeGenericBinding(child);
    Object.freeze(value);
  }
  return value;
};

function approvedPackageTableUri(binding: PcbDesignCompilationBundle["libraryBinding"], kind: "symbol" | "footprint", nickname: string): string | undefined {
  const entries = (kind === "symbol" ? binding.symbols : binding.footprints).filter(entry => safeKicadLibraryNickname(entry.libraryId) === nickname);
  const records = binding.sourceSelection?.records.filter(entry => entry.kind === kind && safeKicadLibraryNickname(entry.libraryId) === nickname) ?? [];
  if (entries.every(entry => entry.source === "kicad-stock")) {
    if (records.some(record => record.approvedPackage !== undefined)) throw new Error("Stock table nickname carries package authority");
    return undefined;
  }
  if (entries.some(entry => entry.source !== "project-custom") || entries.some(entry => !records.some(record => record.libraryId === entry.libraryId && record.approvedPackage !== undefined))) {
    throw new Error("Custom table mapping lacks complete approved source bindings");
  }
  const mappings = [...new Set(records.map(record => record.approvedPackage?.tableUri))];
  const uri = mappings[0];
  if (mappings.length !== 1 || uri === undefined || !/^(?:[A-Za-z]:\/|\/)[^\u0000-\u001f\u007f"\\$]*$/u.test(uri)
    || !uri.endsWith(kind === "symbol" ? `/${nickname}.kicad_sym` : `/${nickname}.pretty`)) throw new Error("Custom table namespace has an invalid or conflicting URI");
  return uri;
}

function genericSymbolLibraryTable(bundle: Pick<PcbDesignCompilationBundle, "libraryBinding"> & Pick<PcbPlaneCompilationBundle, "externalPowerBinding" | "derivedPowerBinding">): string {
  const annotations = powerAnnotationBindingOf(bundle);
  const nicknames = uniqueSortedLibraryNicknames([...bundle.libraryBinding.symbols.map((entry) => entry.libraryId),
    ...(annotations === undefined ? [] : [annotations.source.symbolLibId])]);
  return `(sym_lib_table\n  (version 7)\n${nicknames.map((nickname) => {
    const uri = approvedPackageTableUri(bundle.libraryBinding, "symbol", nickname);
    return uri === undefined ? `  (lib (name "${nickname}")(type "KiCad")(uri "\${KICAD10_SYMBOL_DIR}/${nickname}.kicad_sym")(options "")(descr "Bundle-bound KiCad 10 stock ${nickname} symbols"))`
      : `  (lib (name "${nickname}")(type "KiCad")(uri "${uri}")(options "")(descr "Bundle-bound host-approved package ${nickname} symbols"))`;
  }).join("\n")}\n)\n`;
}

function genericFootprintLibraryTable(bundle: Pick<PcbDesignCompilationBundle, "libraryBinding">): string {
  const nicknames = uniqueSortedLibraryNicknames(bundle.libraryBinding.footprints.map((entry) => entry.libraryId));
  return `(fp_lib_table\n  (version 7)\n${nicknames.map((nickname) => {
    const uri = approvedPackageTableUri(bundle.libraryBinding, "footprint", nickname);
    return uri === undefined ? `  (lib (name "${nickname}")(type "KiCad")(uri "\${KICAD10_FOOTPRINT_DIR}/${nickname}.pretty")(options "")(descr "Bundle-bound KiCad 10 stock ${nickname} footprints"))`
      : `  (lib (name "${nickname}")(type "KiCad")(uri "${uri}")(options "")(descr "Bundle-bound host-approved package ${nickname} footprints"))`;
  }).join("\n")}\n)\n`;
}

const sameContentIdentity = (left: ContentIdentity, right: ContentIdentity): boolean =>
  left.algorithm === "sha256" && right.algorithm === "sha256"
  && left.size === right.size
  && constantTimeDigestEqual(left.digest, right.digest);

/**
 * Converts only an authenticated compilation bundle plus its exact reference
 * into the marker payload used by a generic fresh project.
 */
export function createGenericFreshProjectBinding(
  bundle: PcbDesignCompilationBundle,
  referenceInput: PcbDesignCompilationBundleRef,
): Readonly<{ binding: GenericFreshProjectBinding; symbolTable: string; footprintTable: string }> {
  const reference = parsePcbDesignCompilationBundleRef(referenceInput);
  // This call rejects a merely shape-compatible/deserialized bundle unless it
  // was returned by the strict bundle create/parse boundary in this process.
  const actualReference = createPcbDesignCompilationBundleRef(bundle);
  if (canonicalJson(reference) !== canonicalJson(actualReference)) {
    throw new Error("Generic fresh compilation-bundle reference does not match the authenticated bundle bytes.");
  }
  const symbolTable = genericSymbolLibraryTable(bundle);
  const footprintTable = genericFootprintLibraryTable(bundle);
  const payload = {
    schemaVersion: GENERIC_FRESH_PROJECT_BINDING_SCHEMA_VERSION,
    bundleRef: reference,
    contractIdentity: bundle.contract.identity,
    libraryBindingIdentity: bundle.libraryBinding.identity,
    deepRuleBindingIdentity: bundle.deepRuleBinding.identity,
    practiceProfileBindingIdentity: bundle.practiceProfileBinding.identity,
    acceptancePlanIdentity: bundle.acceptancePlan.identity,
    executionPromptContentIdentity: bundle.executionPrompt.textContentIdentity,
    symbolLibraryTableIdentity: contentIdentity(symbolTable),
    footprintLibraryTableIdentity: contentIdentity(footprintTable),
  };
  const binding: GenericFreshProjectBinding = freezeGenericBinding({
    ...payload,
    identity: canonicalIdentity(payload, GENERIC_FRESH_PROJECT_BINDING_SCHEMA_VERSION),
  });
  return Object.freeze({ binding, symbolTable, footprintTable });
}

/** True V2 plane authority; no V1 practice profile, acceptance plan, or execution prompt is fabricated. */
export function createPlaneFreshProjectBinding(
  bundle: PcbPlaneCompilationBundle,
  referenceInput: PcbPlaneCompilationBundleRef,
): Readonly<{ binding: PlaneFreshProjectBinding; symbolTable: string; footprintTable: string; rulesSource: string }> {
  if (!isAuthenticatedPcbPlaneCompilationBundle(bundle)) throw new Error("Plane fresh preparation requires an authenticated V2 plane compilation bundle.");
  const reference = parsePcbPlaneCompilationBundleRef(referenceInput);
  if (canonicalJson(reference) !== canonicalJson(createPcbPlaneCompilationBundleRef(bundle))) {
    throw new Error("Plane fresh compilation-bundle reference does not match the authenticated V2 bytes.");
  }
  const symbolTable = genericSymbolLibraryTable(bundle);
  const footprintTable = genericFootprintLibraryTable(bundle);
  const rules = createFreshPlaneRules(bundle);
  const payload = {
    schemaVersion: PLANE_FRESH_PROJECT_BINDING_SCHEMA_VERSION,
    family: "plane-v2" as const,
    bundleRef: reference,
    contractIdentity: bundle.contract.identity,
    libraryBindingIdentity: bundle.libraryBinding.identity,
    deepRuleBindingIdentity: bundle.deepRuleBinding.identity,
    verificationPlanIdentity: bundle.verificationPlan.identity,
    guidanceContentIdentity: contentIdentity(bundle.executionGuidance),
    originalPromptContentIdentity: bundle.originalPromptContentIdentity,
    expectedRulesContentIdentity: rules.identity,
    symbolLibraryTableIdentity: contentIdentity(symbolTable),
    footprintLibraryTableIdentity: contentIdentity(footprintTable),
  };
  const binding: PlaneFreshProjectBinding = freezeGenericBinding({ ...payload,
    identity: canonicalIdentity(payload, PLANE_FRESH_PROJECT_BINDING_SCHEMA_VERSION) });
  return Object.freeze({ binding, symbolTable, footprintTable, rulesSource: rules.source });
}

const schematicIsEmpty = (contents: string): boolean => {
  const compact = contents.replace(/;[^\n]*/gu, "");
  return /\(lib_symbols\s*\)/u.test(compact)
    && !/\(symbol(?:\s|\))/u.test(compact)
    && !/\(symbol_instances(?:\s|\))/u.test(compact);
};

const stableIdentityPart = (value: bigint): string | null => value > 0n ? value.toString(10) : null;

/** Rejects Windows junctions/reparse links and POSIX symlinks before following a directory. */
export async function readFreshDirectoryIdentity(directory: string): Promise<FreshFilesystemIdentity> {
  const resolved = path.resolve(directory);
  const metadata = await lstat(resolved, { bigint: true });
  // Node exposes Windows junctions as symbolic links through lstat.  It has no
  // separate stable reparse-tag API, so fail closed on every link it reports.
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Fresh-project directory is not a physical non-link directory.");
  const canonicalPath = await realpath(resolved);
  if (canonicalPath !== resolved) throw new Error("Fresh-project directory canonical path differs from its marker path.");
  const dev = stableIdentityPart(metadata.dev);
  const ino = stableIdentityPart(metadata.ino);
  return Object.freeze({ canonicalPath, dev: dev === null || ino === null ? null : dev, ino: dev === null || ino === null ? null : ino });
}

const sameFreshDirectoryIdentity = (left: FreshFilesystemIdentity, right: FreshFilesystemIdentity): boolean =>
  left.canonicalPath === right.canonicalPath
  && (left.dev === null || left.ino === null || (left.dev === right.dev && left.ino === right.ino));

/** Verifies the marker-bound project root and its exact direct-board path. */
export async function assertFreshProjectDirectoryChain(freshProject: FreshProject): Promise<FreshFilesystemIdentity> {
  if (!isVerifiedFreshProject(freshProject)) throw new Error("Fresh directory chain requires a marker-bound fresh project.");
  const expectedRoot = path.join(path.resolve(freshProject.outputPath), FRESH_PROJECT_DIRECTORY);
  const expectedBoard = path.join(expectedRoot, `${freshProject.name}.kicad_pcb`);
  if (path.resolve(freshProject.projectPath) !== expectedRoot || path.resolve(freshProject.pcbPath) !== expectedBoard || path.dirname(expectedBoard) !== expectedRoot) {
    throw new Error("Fresh-project root or board basename does not match the marker-bound isolated layout.");
  }
  // Fresh boards live immediately below the marker-bound root.  Keeping this a
  // loop makes an accidental future nested-board change fail rather than skip a
  // link check between the board parent and the project root.
  let current = path.dirname(expectedBoard);
  while (true) {
    const currentIdentity = await readFreshDirectoryIdentity(current);
    if (current === expectedRoot) {
      if (!sameFreshDirectoryIdentity(currentIdentity, freshProject.projectIdentity)) {
        throw new Error("Fresh-project physical root identity changed from the marker binding.");
      }
      return currentIdentity;
    }
    const parent = path.dirname(current);
    if (parent === current || !current.startsWith(`${expectedRoot}${path.sep}`)) throw new Error("Fresh board parent escapes the marker-bound project root.");
    current = parent;
  }
}

const assertGenericBindingShape = (binding: GenericFreshProjectBinding): void => {
  if (binding === null || typeof binding !== "object" || Array.isArray(binding)
      || Object.keys(binding).sort().join("\0") !== [
        "acceptancePlanIdentity", "bundleRef", "contractIdentity", "deepRuleBindingIdentity",
        "executionPromptContentIdentity", "footprintLibraryTableIdentity", "identity",
        "libraryBindingIdentity", "practiceProfileBindingIdentity", "schemaVersion",
        "symbolLibraryTableIdentity",
      ].sort().join("\0")) {
    throw new Error("Generic fresh-project marker has a non-closed compilation binding.");
  }
  const reference = parsePcbDesignCompilationBundleRef(binding.bundleRef);
  const payload = {
    schemaVersion: binding.schemaVersion,
    bundleRef: reference,
    contractIdentity: binding.contractIdentity,
    libraryBindingIdentity: binding.libraryBindingIdentity,
    deepRuleBindingIdentity: binding.deepRuleBindingIdentity,
    practiceProfileBindingIdentity: binding.practiceProfileBindingIdentity,
    acceptancePlanIdentity: binding.acceptancePlanIdentity,
    executionPromptContentIdentity: binding.executionPromptContentIdentity,
    symbolLibraryTableIdentity: binding.symbolLibraryTableIdentity,
    footprintLibraryTableIdentity: binding.footprintLibraryTableIdentity,
  };
  if (binding.schemaVersion !== GENERIC_FRESH_PROJECT_BINDING_SCHEMA_VERSION
      || binding.identity?.schemaVersion !== GENERIC_FRESH_PROJECT_BINDING_SCHEMA_VERSION
      || ![binding.executionPromptContentIdentity, binding.symbolLibraryTableIdentity, binding.footprintLibraryTableIdentity]
        .every((identity) => identity?.algorithm === "sha256" && Number.isSafeInteger(identity.size) && identity.size >= 0 && constantTimeDigestEqual(identity.digest, identity.digest))
      || canonicalJson(binding.identity) !== canonicalJson(canonicalIdentity(payload, GENERIC_FRESH_PROJECT_BINDING_SCHEMA_VERSION))) {
    throw new Error("Generic fresh-project marker has an invalid compilation binding identity.");
  }
};

const assertPlaneBindingShape = (binding: PlaneFreshProjectBinding): void => {
  if (binding === null || typeof binding !== "object" || Array.isArray(binding)
      || Object.keys(binding).sort().join("\0") !== [
        "schemaVersion", "family", "bundleRef", "contractIdentity", "libraryBindingIdentity", "deepRuleBindingIdentity",
        "verificationPlanIdentity", "guidanceContentIdentity", "originalPromptContentIdentity", "expectedRulesContentIdentity",
        "symbolLibraryTableIdentity", "footprintLibraryTableIdentity", "identity",
      ].sort().join("\0")) throw new Error("Plane fresh-project marker has a non-closed V2 binding.");
  const reference = parsePcbPlaneCompilationBundleRef(binding.bundleRef);
  const identities = [
    [binding.contractIdentity, "evleda.pcb-design-contract.v2"],
    [binding.libraryBindingIdentity, "evleda.pcb-library-binding.v1"],
    [binding.deepRuleBindingIdentity, "evleda.pcb-deep-rule-binding.v1"],
    [binding.verificationPlanIdentity, "evleda.pcb-plane-verification-plan.v1"],
    [binding.identity, PLANE_FRESH_PROJECT_BINDING_SCHEMA_VERSION],
  ] as const;
  for (const [identity, schema] of identities) {
    if (identity === null || typeof identity !== "object" || Array.isArray(identity)
        || Object.keys(identity).sort().join("\0") !== ["algorithm", "canonicalizationVersion", "digest", "schemaVersion"].sort().join("\0")
        || identity.algorithm !== "sha256" || identity.schemaVersion !== schema || identity.canonicalizationVersion !== "evleda-c14n-json-v1"
        || typeof identity.digest !== "string" || !/^[a-f0-9]{64}$/u.test(identity.digest)) {
      throw new Error("Plane fresh-project marker has an invalid child identity family.");
    }
  }
  for (const identity of [binding.guidanceContentIdentity, binding.originalPromptContentIdentity, binding.expectedRulesContentIdentity,
    binding.symbolLibraryTableIdentity, binding.footprintLibraryTableIdentity]) {
    if (identity === null || typeof identity !== "object" || Array.isArray(identity)
        || Object.keys(identity).sort().join("\0") !== ["algorithm", "digest", "size"].sort().join("\0")
        || identity.algorithm !== "sha256" || !Number.isSafeInteger(identity.size) || identity.size < 0 || identity.size > 2 * 1024 * 1024
        || typeof identity.digest !== "string" || !/^[a-f0-9]{64}$/u.test(identity.digest)) {
      throw new Error("Plane fresh-project marker has an invalid content identity.");
    }
  }
  const { identity, ...payload } = binding;
  if (binding.schemaVersion !== PLANE_FRESH_PROJECT_BINDING_SCHEMA_VERSION || binding.family !== "plane-v2"
      || canonicalJson(reference) !== canonicalJson(binding.bundleRef)
      || canonicalJson(identity) !== canonicalJson(canonicalIdentity(payload, PLANE_FRESH_PROJECT_BINDING_SCHEMA_VERSION))) {
    throw new Error("Plane fresh-project binding does not match its exact V2 payload.");
  }
};

async function parseVerifiedMarker(
  markerPath: string,
  outputPath: string,
  name: string,
  verifyBaseline = true,
  expectedGeneric?: GenericFreshProjectBinding | PlaneFreshProjectBinding,
  expectedWorkflow: "led_compatibility_fixture" | "generic" | "plane" | "any" = expectedGeneric === undefined ? "led_compatibility_fixture"
    : expectedGeneric.schemaVersion === PLANE_FRESH_PROJECT_BINDING_SCHEMA_VERSION ? "plane" : "generic",
  initialSchematicSeed?: FreshPlaneSchematicSeed,
  initialPlacementSeed?: FreshPlanePlacementSeed,
): Promise<FreshMarker> {
  let marker: FreshMarker;
  try {
    marker = parsePortableJsonBytes(await readFile(markerPath), {
      maxBytes: 2 * 1024 * 1024,
      maxDepth: 64,
      maxNodes: 100_000,
      maxArrayLength: 10_000,
      maxOwnKeys: 2_048,
      maxKeyBytes: 512,
      maxStringBytes: 512 * 1024,
    }) as FreshMarker;
  } catch (error) {
    throw new Error("Fresh-project marker is not duplicate-free bounded strict UTF-8 JSON.", { cause: error });
  }
  if (!["evleda.pcb-agent-fresh-project.v1", "evleda.pcb-agent-fresh-project.v2", "evleda.pcb-agent-fresh-project.v3"].includes(marker.schemaVersion)
      || marker.name !== name || marker.outputPath !== outputPath || marker.projectPath !== path.join(outputPath, FRESH_PROJECT_DIRECTORY)) {
    throw new Error("Fresh-project marker does not match the requested output/name.");
  }
  if (expectedWorkflow === "generic" && marker.schemaVersion === "evleda.pcb-agent-fresh-project.v1") {
    throw new Error("Legacy V1 fresh-project markers cannot be upgraded in place to a generic bundle-bound workflow; prepare a new empty output directory.");
  }
  if (expectedWorkflow === "led_compatibility_fixture" && marker.schemaVersion === "evleda.pcb-agent-fresh-project.v2") {
    throw new Error("A generic bundle-bound fresh project cannot resume as the LED compatibility fixture.");
  }
  if (expectedWorkflow === "plane" && marker.schemaVersion !== "evleda.pcb-agent-fresh-project.v3") {
    throw new Error("A legacy fresh project cannot resume as the V2 plane family; prepare a new empty output directory.");
  }
  if (marker.schemaVersion === "evleda.pcb-agent-fresh-project.v3" && expectedWorkflow !== "plane" && expectedWorkflow !== "any") {
    throw new Error("A plane fresh project requires an explicit plane workflow; legacy-only paths cannot resume it.");
  }
  if (marker.schemaVersion === "evleda.pcb-agent-fresh-project.v2") {
    if (marker.workflowKind !== "generic") throw new Error("Generic fresh-project marker has an invalid workflow kind.");
    if (Object.keys(marker).sort().join("\0") !== ["schemaVersion", "workflowKind", "name", "outputPath", "projectPath", "projectIdentity", "files", "genericBinding"].sort().join("\0")) {
      throw new Error("Generic fresh-project marker contains missing or unexpected fields.");
    }
    assertGenericBindingShape(marker.genericBinding);
    if (expectedGeneric !== undefined && canonicalJson(marker.genericBinding) !== canonicalJson(expectedGeneric)) {
      throw new Error("Generic fresh-project marker is bound to another compilation-bundle reference or execution identity.");
    }
  } else if (marker.schemaVersion === "evleda.pcb-agent-fresh-project.v3") {
    if (marker.workflowKind !== "plane" || Object.keys(marker).sort().join("\0") !== [
      "schemaVersion", "workflowKind", "name", "outputPath", "projectPath", "projectIdentity", "files", "planeBinding",
    ].sort().join("\0")) throw new Error("Plane fresh-project marker contains missing or unexpected fields.");
    assertPlaneBindingShape(marker.planeBinding);
    if (expectedGeneric !== undefined && canonicalJson(marker.planeBinding) !== canonicalJson(expectedGeneric)) {
      throw new Error("Plane fresh-project marker is bound to another V2 compilation bundle or verification identity.");
    }
  } else if (Object.keys(marker).sort().join("\0") !== ["schemaVersion", "name", "outputPath", "projectPath", "projectIdentity", "files"].sort().join("\0")) {
    throw new Error("Legacy fresh-project marker contains missing or unexpected fields.");
  }
  if (marker.projectIdentity === undefined
      || typeof marker.projectIdentity !== "object" || Array.isArray(marker.projectIdentity)
      || Object.keys(marker.projectIdentity).sort().join("\0") !== ["canonicalPath", "dev", "ino"].sort().join("\0")
      || typeof marker.projectIdentity.canonicalPath !== "string"
      || marker.projectIdentity.canonicalPath !== marker.projectPath
      || ![marker.projectIdentity.dev, marker.projectIdentity.ino].every((value) => value === null || (typeof value === "string" && /^[1-9]\d*$/u.test(value)))) {
    throw new Error("Fresh-project marker has no valid physical project-root binding.");
  }
  const actualIdentity = await readFreshDirectoryIdentity(marker.projectPath);
  if (!sameFreshDirectoryIdentity(actualIdentity, marker.projectIdentity)) throw new Error("Fresh-project physical root identity changed from the marker binding.");
  if (marker.files === undefined || typeof marker.files !== "object" || Array.isArray(marker.files)
      || Object.keys(marker.files).sort().join("\0") !== [...fileKeysFor(marker)].sort().join("\0")) {
    throw new Error("Fresh-project marker file inventory is not closed.");
  }
  for (const key of fileKeysFor(marker)) {
    const entry = freshFile(marker.files, key);
    if (entry === undefined || typeof entry !== "object" || Array.isArray(entry)
        || Object.keys(entry).sort().join("\0") !== ["path", "sha256"].sort().join("\0")
        || entry.path !== path.join(marker.projectPath, key === "dru" ? `${name}.kicad_dru` : fileNames(name)[key])
        || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.sha256)) {
      throw new Error(`Fresh-project marker file identity is invalid for ${key}.`);
    }
    if (verifyBaseline && await sha256(entry.path) !== entry.sha256) throw new Error(`Fresh-project marker hash verification failed for ${key}.`);
  }
  if (marker.schemaVersion === "evleda.pcb-agent-fresh-project.v2") {
    const symbolIdentity = contentIdentity(await readFile(marker.files.symLibTable.path));
    const footprintIdentity = contentIdentity(await readFile(marker.files.fpLibTable.path));
    if (!sameContentIdentity(symbolIdentity, marker.genericBinding.symbolLibraryTableIdentity)
        || !sameContentIdentity(footprintIdentity, marker.genericBinding.footprintLibraryTableIdentity)) {
      throw new Error("Generic fresh-project library tables differ from their bundle-generated identities.");
    }
  }
  if (marker.schemaVersion === "evleda.pcb-agent-fresh-project.v3") {
    const symbolIdentity = contentIdentity(await readFile(marker.files.symLibTable.path));
    const footprintIdentity = contentIdentity(await readFile(marker.files.fpLibTable.path));
    if (!sameContentIdentity(symbolIdentity, marker.planeBinding.symbolLibraryTableIdentity)
        || !sameContentIdentity(footprintIdentity, marker.planeBinding.footprintLibraryTableIdentity)) {
      throw new Error("Plane fresh-project library tables differ from their actual V2 bundle-generated identities.");
    }
    const rulesIdentity = contentIdentity((await captureFreshRegularFile(marker.files.dru.path)).bytes);
    if (!sameContentIdentity(rulesIdentity, marker.planeBinding.expectedRulesContentIdentity)
        || marker.files.dru.sha256 !== marker.planeBinding.expectedRulesContentIdentity.digest) {
      throw new Error("Plane fresh-project owned rules differ from their immutable V2 bundle-generated identity.");
    }
  }
  if (verifyBaseline) {
    const schematic = await readFile(marker.files.sch.path, "utf8");
    if (initialPlacementSeed !== undefined && marker.schemaVersion === "evleda.pcb-agent-fresh-project.v3") {
      assertFreshPlanePlacementSeedBaseline(initialPlacementSeed, outputPath, { sch: schematic,
        pcb: await readFile(marker.files.pcb.path, "utf8"), pro: await readFile(marker.files.pro.path, "utf8"),
        dru: await readFile(marker.files.dru.path, "utf8") });
    }
    else if (initialSchematicSeed !== undefined && marker.schemaVersion === "evleda.pcb-agent-fresh-project.v3") assertFreshPlaneSchematicSeedBaseline(initialSchematicSeed, outputPath, schematic);
    else if (!schematicIsEmpty(schematic)) throw new Error("Marked fresh schematic is not empty.");
  }
  return marker;
}

const fileKeys = ["pro", "sch", "pcb", "symLibTable", "fpLibTable"] as const;
type CommonFreshFileKey = typeof fileKeys[number];
type FreshFileKey = CommonFreshFileKey | "dru";
type FreshFileCaptures = Readonly<Record<CommonFreshFileKey, FreshRegularFileCapture>> & Readonly<{ dru?: FreshRegularFileCapture }>;
const fileKeysFor = (marker: FreshMarker): readonly FreshFileKey[] => marker.schemaVersion === "evleda.pcb-agent-fresh-project.v3" ? [...fileKeys, "dru"] : fileKeys;
const freshFile = (files: FreshMarker["files"], key: FreshFileKey): { readonly path: string; readonly sha256: string } => {
  const value = key === "dru" ? ("dru" in files ? files.dru : undefined) : files[key];
  if (value === undefined) throw new Error(`Fresh-project ${key} file record is missing.`);
  return value;
};
const freshCapture = (captures: FreshFileCaptures, key: FreshFileKey): FreshRegularFileCapture => {
  const value = captures[key];
  if (value === undefined) throw new Error(`Fresh-project ${key} capture is missing.`);
  return value;
};

interface FreshFilesSnapshot {
  readonly files: FreshMarker["files"];
  readonly captures: FreshFileCaptures;
}

interface FreshCheckpointPublicationSnapshot extends FreshFilesSnapshot {
  readonly marker: FreshRegularFileCapture;
  readonly projectIdentity: FreshFilesystemIdentity;
  /** Additional rule-source capture; plane rules are also mandatory in files.dru. */
  readonly customRules: Readonly<{ readonly path: string; readonly capture: FreshRegularFileCapture | null }> | null;
}

async function captureCurrentFiles(marker: FreshMarker): Promise<FreshFilesSnapshot> {
  const entries = await Promise.all(fileKeysFor(marker).map(async (key) => [key, await captureFreshRegularFile(freshFile(marker.files, key).path)] as const));
  const captures = Object.fromEntries(entries) as FreshFileCaptures;
  const files = Object.fromEntries(fileKeysFor(marker).map((key) => [key, { path: freshCapture(captures, key).path, sha256: freshCapture(captures, key).sha256 }])) as FreshMarker["files"];
  return Object.freeze({ files, captures: Object.freeze(captures) });
}

async function currentFiles(marker: FreshMarker): Promise<FreshMarker["files"]> {
  return (await captureCurrentFiles(marker)).files;
}

const filesEqual = (left: FreshMarker["files"], right: FreshMarker["files"], marker: FreshMarker): boolean =>
  fileKeysFor(marker).every((key) => freshFile(left, key).path === freshFile(right, key).path && freshFile(left, key).sha256 === freshFile(right, key).sha256);

const capturedFilesEqual = (left: FreshFileCaptures, right: FreshFileCaptures, marker: FreshMarker): boolean =>
  fileKeysFor(marker).every((key) => freshCapture(left, key).path === freshCapture(right, key).path
    && freshCapture(left, key).sha256 === freshCapture(right, key).sha256
    && samePhysicalFileIdentity(freshCapture(left, key).physical, freshCapture(right, key).physical));

const preparedSourceAuthorityKeys = ["schemaVersion", "projectIdentity", "pro", "sch", "pcb", "sym", "fp", "marker", "identity"] as const;
const contentIdentityKeys = ["algorithm", "digest", "size"] as const;

const parsePreparedContentIdentity = (value: unknown, label: string): ContentIdentity => {
  const record = asRecord(value, label);
  if (Object.keys(record).sort().join("\0") !== [...contentIdentityKeys].sort().join("\0")
      || record.algorithm !== "sha256"
      || typeof record.digest !== "string" || !/^[a-f0-9]{64}$/u.test(record.digest)
      || typeof record.size !== "number" || !Number.isSafeInteger(record.size) || record.size <= 0) {
    throw new Error(`${label} is not a closed content identity.`);
  }
  return Object.freeze({ algorithm: "sha256", digest: record.digest, size: record.size });
};

/** Strictly parses and self-authenticates a lifecycle-owned prepared-source authority. */
export function parseFreshProjectOpenPreparedSourceAuthority(input: unknown): FreshProjectOpenPreparedSourceAuthority {
  const value = asRecord(input, "Fresh project Open prepared-source authority");
  if (Object.keys(value).sort().join("\0") !== [...preparedSourceAuthorityKeys].sort().join("\0")
      || value.schemaVersion !== FRESH_PROJECT_OPEN_PREPARED_SOURCE_AUTHORITY_SCHEMA_VERSION) {
    throw new Error("Fresh project Open prepared-source authority is not closed or has the wrong schema.");
  }
  const projectIdentity = asRecord(value.projectIdentity, "Prepared project identity");
  if (Object.keys(projectIdentity).sort().join("\0") !== ["canonicalPath", "dev", "ino"].sort().join("\0")
      || typeof projectIdentity.canonicalPath !== "string" || !path.isAbsolute(projectIdentity.canonicalPath)
      || projectIdentity.canonicalPath !== path.resolve(projectIdentity.canonicalPath)
      || !((projectIdentity.dev === null && projectIdentity.ino === null)
        || (typeof projectIdentity.dev === "string" && /^[1-9]\d*$/u.test(projectIdentity.dev)
          && typeof projectIdentity.ino === "string" && /^[1-9]\d*$/u.test(projectIdentity.ino)))) {
    throw new Error("Fresh project Open prepared-source authority has an invalid physical project identity.");
  }
  const payload = {
    schemaVersion: FRESH_PROJECT_OPEN_PREPARED_SOURCE_AUTHORITY_SCHEMA_VERSION,
    projectIdentity: Object.freeze({ canonicalPath: projectIdentity.canonicalPath, dev: projectIdentity.dev, ino: projectIdentity.ino }) as FreshFilesystemIdentity,
    pro: parsePreparedContentIdentity(value.pro, "Prepared project settings"),
    sch: parsePreparedContentIdentity(value.sch, "Prepared schematic"),
    pcb: parsePreparedContentIdentity(value.pcb, "Prepared PCB"),
    sym: parsePreparedContentIdentity(value.sym, "Prepared symbol library table"),
    fp: parsePreparedContentIdentity(value.fp, "Prepared footprint library table"),
    marker: parsePreparedContentIdentity(value.marker, "Prepared marker"),
  };
  const expectedIdentity = canonicalIdentity(payload, FRESH_PROJECT_OPEN_PREPARED_SOURCE_AUTHORITY_SCHEMA_VERSION);
  if (!semanticJsonEqual(value.identity, expectedIdentity)) throw new Error("Fresh project Open prepared-source authority identity is invalid.");
  return freezeGenericBinding({ ...payload, identity: expectedIdentity });
}

/** Captures the exact post-prepare source authority through a non-forgeable fresh capability. */
export async function captureFreshProjectOpenPreparedSourceAuthority(
  freshProject: FreshProject,
): Promise<FreshProjectOpenPreparedSourceAuthority> {
  if (!isVerifiedFreshProject(freshProject)) throw new Error("Prepared-source authority capture requires a verified FreshProject capability.");
  const rootBefore = await assertFreshProjectDirectoryChain(freshProject);
  const markerBefore = await captureFreshRegularFile(freshProject.markerPath);
  const authenticatedMarker = await freshProject.assertMarkerCurrent();
  if (!sameContentIdentity(authenticatedMarker, contentIdentity(markerBefore.bytes))) throw new Error("Prepared marker differs from the fresh capability authority.");
  const marker = await parseVerifiedMarker(
    freshProject.markerPath,
    path.resolve(freshProject.outputPath),
    freshProject.name,
    false,
    freshProject.planeBinding ?? freshProject.genericBinding,
    freshProject.workflowKind,
  );
  const filesBefore = await captureCurrentFiles(marker);
  const files = await captureCurrentFiles(marker);
  const markerAfter = await captureFreshRegularFile(freshProject.markerPath);
  const rootAfter = await assertFreshProjectDirectoryChain(freshProject);
  if (!sameFreshDirectoryIdentity(rootBefore, rootAfter)
      || !sameRegularFileCaptureIdentity(markerBefore, markerAfter)
      || !filesEqual(filesBefore.files, files.files, marker)
      || !capturedFilesEqual(filesBefore.captures, files.captures, marker)) {
    throw new Error("Fresh project changed while its prepared-source authority was captured.");
  }
  for (const key of fileKeysFor(marker).filter((key) => key !== "pro")) {
    if (freshFile(files.files, key).path !== freshFile(marker.files, key).path || freshFile(files.files, key).sha256 !== freshFile(marker.files, key).sha256) {
      throw new Error(`Fresh-project ${key} differs from its immutable marker baseline before prepared-source authority capture.`);
    }
  }
  const payload = {
    schemaVersion: FRESH_PROJECT_OPEN_PREPARED_SOURCE_AUTHORITY_SCHEMA_VERSION,
    projectIdentity: Object.freeze({ ...rootAfter }),
    pro: contentIdentity(files.captures.pro.bytes),
    sch: contentIdentity(files.captures.sch.bytes),
    pcb: contentIdentity(files.captures.pcb.bytes),
    sym: contentIdentity(files.captures.symLibTable.bytes),
    fp: contentIdentity(files.captures.fpLibTable.bytes),
    marker: contentIdentity(markerAfter.bytes),
  };
  return freezeGenericBinding({
    ...payload,
    identity: canonicalIdentity(payload, FRESH_PROJECT_OPEN_PREPARED_SOURCE_AUTHORITY_SCHEMA_VERSION),
  });
}

function assertFreshFileInventory(value: unknown, marker: FreshMarker, label: string): asserts value is FreshMarker["files"] {
  if (value === null || Array.isArray(value) || typeof value !== "object"
      || Object.keys(value).sort().join("\0") !== [...fileKeysFor(marker)].sort().join("\0")) {
    throw new Error(`${label} file inventory is not closed.`);
  }
  for (const key of fileKeysFor(marker)) {
    const entry = (value as Record<FreshFileKey, unknown>)[key];
    if (entry === null || Array.isArray(entry) || typeof entry !== "object"
        || Object.keys(entry).sort().join("\0") !== ["path", "sha256"].sort().join("\0")) {
      throw new Error(`${label} file identity is invalid for ${key}.`);
    }
    const record = entry as Record<string, unknown>;
    if (record.path !== freshFile(marker.files, key).path || typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.sha256)) {
      throw new Error(`${label} file identity is invalid for ${key}.`);
    }
  }
}

const runSynchronousCommitFence = (assertCanCommit: (() => void) | undefined): void => {
  if (assertCanCommit === undefined) return;
  if (typeof assertCanCommit !== "function") throw new Error("Fresh checkpoint assertCanCommit fence must be a function.");
  const result = (assertCanCommit as () => unknown)();
  if (result !== undefined) {
    if (result !== null && (typeof result === "object" || typeof result === "function") && "then" in result) {
      void Promise.resolve(result).catch(() => undefined);
    }
    throw new Error("Fresh checkpoint assertCanCommit fence must complete synchronously and return undefined.");
  }
};

const parseFreshCheckpointCommitOptions = (input: FreshCheckpointCommitOptions | undefined): FreshCheckpointCommitOptions | undefined => {
  if (input === undefined) return undefined;
  if (input === null || Array.isArray(input) || typeof input !== "object"
      || Object.keys(input).some((key) => key !== "assertCanCommit" && key !== "sourceGuard")
      || (input.assertCanCommit !== undefined && typeof input.assertCanCommit !== "function")
      || (input.sourceGuard !== undefined && !checkpointGuards.has(input.sourceGuard))) {
    throw new Error("Fresh checkpoint commit options are not closed and valid.");
  }
  return Object.freeze({ ...(input.assertCanCommit === undefined ? {} : { assertCanCommit: input.assertCanCommit }),
    ...(input.sourceGuard === undefined ? {} : { sourceGuard: input.sourceGuard }) });
};

async function writeAtomicJson(
  filePath: string,
  value: unknown,
  beforeCommit?: () => Promise<void>,
  assertCanCommit?: () => void,
): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await beforeCommit?.();
    // No await or other yield may be introduced between this production fence
    // and initiating the atomic replacement.
    runSynchronousCommitFence(assertCanCommit);
    await rename(temporary, filePath);
  } catch (error) {
    try { await unlink(temporary); } catch { /* best effort */ }
    throw error;
  }
}

async function readCheckpoint(checkpointPath: string): Promise<FreshCheckpoint | undefined> {
  try {
    return parsePortableJsonBytes(await readFile(checkpointPath), {
      maxBytes: 2 * 1024 * 1024,
      maxDepth: 64,
      maxNodes: 100_000,
      maxArrayLength: 10_000,
      maxOwnKeys: 2_048,
      maxKeyBytes: 512,
      maxStringBytes: 1024 * 1024,
    }) as FreshCheckpoint;
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Fresh-project checkpoint is not bounded duplicate-free strict UTF-8 JSON.", { cause: error });
  }
}

async function verifyCheckpoint(
  marker: FreshMarker,
  markerPath: string,
  checkpointPath: string,
  allowedChangedFiles: readonly FreshFileKey[] = [],
): Promise<FreshCheckpoint | undefined> {
  const checkpoint = await readCheckpoint(checkpointPath);
  if (checkpoint === undefined) return undefined;
  const expectedSchema = marker.schemaVersion === "evleda.pcb-agent-fresh-project.v3"
    ? "evleda.pcb-agent-fresh-project-checkpoint.v3"
    : marker.schemaVersion === "evleda.pcb-agent-fresh-project.v2"
      ? "evleda.pcb-agent-fresh-project-checkpoint.v2"
      : "evleda.pcb-agent-fresh-project-checkpoint.v1";
  if (checkpoint.schemaVersion !== expectedSchema
      || typeof checkpoint.baselineMarkerSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(checkpoint.baselineMarkerSha256)
      || checkpoint.baselineMarkerSha256 !== await sha256(markerPath)
      || checkpoint.projectPath !== marker.projectPath
      || checkpoint.reportPath !== path.join(marker.outputPath, "pcb-agent-report.json")
      || typeof checkpoint.reportSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(checkpoint.reportSha256)
      || !checkpointStatus.safeParse(checkpoint.reportStatus).success
      || !Number.isSafeInteger(checkpoint.attempt) || checkpoint.attempt < 1) {
    throw new Error("Fresh-project checkpoint does not bind to this immutable baseline.");
  }
  assertFreshFileInventory(checkpoint.files, marker, "Fresh-project checkpoint");
  if (marker.schemaVersion === "evleda.pcb-agent-fresh-project.v2") {
    if (checkpoint.schemaVersion !== "evleda.pcb-agent-fresh-project-checkpoint.v2"
        || Object.keys(checkpoint).sort().join("\0") !== [
          "schemaVersion", "baselineMarkerSha256", "projectPath", "files", "reportPath", "reportSha256",
          "reportStatus", "attempt", "reason", "genericBindingIdentity", "symbolLibraryTableIdentity",
          "footprintLibraryTableIdentity",
        ].sort().join("\0")
        || canonicalJson(checkpoint.genericBindingIdentity) !== canonicalJson(marker.genericBinding.identity)
        || !sameContentIdentity(checkpoint.symbolLibraryTableIdentity, marker.genericBinding.symbolLibraryTableIdentity)
        || !sameContentIdentity(checkpoint.footprintLibraryTableIdentity, marker.genericBinding.footprintLibraryTableIdentity)) {
      throw new Error("Generic fresh-project checkpoint does not bind the exact bundle-generated library tables.");
    }
  } else if (marker.schemaVersion === "evleda.pcb-agent-fresh-project.v3") {
    if (checkpoint.schemaVersion !== "evleda.pcb-agent-fresh-project-checkpoint.v3"
        || Object.keys(checkpoint).sort().join("\0") !== [
          "schemaVersion", "baselineMarkerSha256", "projectPath", "files", "reportPath", "reportSha256",
          "reportStatus", "attempt", "reason", "planeBindingIdentity", "symbolLibraryTableIdentity", "footprintLibraryTableIdentity",
        ].sort().join("\0")
        || canonicalJson(checkpoint.planeBindingIdentity) !== canonicalJson(marker.planeBinding.identity)
        || !sameContentIdentity(checkpoint.symbolLibraryTableIdentity, marker.planeBinding.symbolLibraryTableIdentity)
        || !sameContentIdentity(checkpoint.footprintLibraryTableIdentity, marker.planeBinding.footprintLibraryTableIdentity)) {
      throw new Error("Plane fresh-project checkpoint does not bind the exact V2 bundle and library tables.");
    }
  } else if (Object.keys(checkpoint).sort().join("\0") !== [
    "schemaVersion", "baselineMarkerSha256", "projectPath", "files", "reportPath", "reportSha256",
    "reportStatus", "attempt", "reason",
  ].sort().join("\0")) {
    throw new Error("Legacy fresh-project checkpoint contains missing or unexpected fields.");
  }
  const allowed = new Set(allowedChangedFiles);
  const current = await currentFiles(marker);
  if (fileKeysFor(marker).some((key) => !allowed.has(key) && (freshFile(current, key).path !== freshFile(checkpoint.files, key).path || freshFile(current, key).sha256 !== freshFile(checkpoint.files, key).sha256))) {
    throw new Error("Fresh-project bytes differ from the latest checkpoint.");
  }
  // Reports are diagnostic history, not authorization. A crash can persist a
  // report before its checkpoint metadata; exact project/table bytes remain the
  // authority to resume, and metadata is reconciled below when available.
  if (checkpoint.schemaVersion === "evleda.pcb-agent-fresh-project-checkpoint.v2" || checkpoint.schemaVersion === "evleda.pcb-agent-fresh-project-checkpoint.v3") {
    if (checkpoint.reason !== "run_exit" && checkpoint.reason !== "kicad_open_normalization") {
      throw new Error("Generic fresh-project checkpoint has an unsupported reason.");
    }
    return checkpoint;
  }
  return checkpoint.reason === "run_exit" || checkpoint.reason === "legacy_migration" || checkpoint.reason === "kicad_open_normalization"
    ? checkpoint
    : { ...checkpoint, reason: "legacy_migration" };
}

const checkpointStatus = z.enum(["completed", "needs_review", "blocked", "failed"]);

const sameRegularFileCaptureIdentity = (left: FreshRegularFileCapture, right: FreshRegularFileCapture): boolean =>
  left.path === right.path && left.sha256 === right.sha256 && samePhysicalFileIdentity(left.physical, right.physical);

async function assertFreshCheckpointPublicationSnapshot(
  marker: FreshMarker,
  snapshot: FreshCheckpointPublicationSnapshot,
): Promise<void> {
  const rootBefore = await readFreshDirectoryIdentity(marker.projectPath);
  if (!sameFreshDirectoryIdentity(rootBefore, marker.projectIdentity)
      || !sameFreshDirectoryIdentity(rootBefore, snapshot.projectIdentity)) {
    throw new Error("Fresh-project root identity changed after Open normalization validation.");
  }
  const [markerNow, filesNow, customRulesNow] = await Promise.all([
    captureFreshRegularFile(snapshot.marker.path),
    captureCurrentFiles(marker),
    snapshot.customRules === null ? Promise.resolve(null) : captureOptionalFreshRegularFile(snapshot.customRules.path),
  ]);
  const rootAfter = await readFreshDirectoryIdentity(marker.projectPath);
  const customRulesEqual = snapshot.customRules === null
    || (snapshot.customRules.capture === null
      ? customRulesNow === null
      : customRulesNow !== null && sameRegularFileCaptureIdentity(customRulesNow, snapshot.customRules.capture));
  if (!sameFreshDirectoryIdentity(rootAfter, rootBefore)
      || !sameRegularFileCaptureIdentity(markerNow, snapshot.marker)
      || !filesEqual(filesNow.files, snapshot.files, marker)
      || !capturedFilesEqual(filesNow.captures, snapshot.captures, marker)
      || !customRulesEqual) {
    throw new Error("Fresh-project validated snapshot changed before durable checkpoint publication.");
  }
}

interface FreshCheckpointPublicationGuard {
  readonly snapshot: FreshCheckpointPublicationSnapshot;
  readonly beforeFinalRecheck?: () => void | Promise<void>;
}

/** Capture only at a host-verified save boundary, before native teardown. */
export async function captureFreshProjectCheckpointGuard(project: FreshProject): Promise<FreshProjectCheckpointGuard> {
  if (!isVerifiedFreshProject(project)) throw new Error("Checkpoint source guard requires a verified FreshProject.");
  const projectIdentity = await assertFreshProjectDirectoryChain(project);
  const markerCapture = await captureFreshRegularFile(project.markerPath);
  if (!sameContentIdentity(await project.assertMarkerCurrent(), contentIdentity(markerCapture.bytes))) {
    throw new Error("Checkpoint source guard marker differs from project authority.");
  }
  const marker = await parseVerifiedMarker(project.markerPath, project.outputPath, project.name, false, project.planeBinding ?? project.genericBinding, project.workflowKind);
  const files = await captureCurrentFiles(marker);
  const rulesPath = path.join(project.projectPath, `${project.name}.kicad_dru`);
  const snapshot: FreshCheckpointPublicationSnapshot = { ...files, marker: markerCapture, projectIdentity,
    customRules: { path: rulesPath, capture: await captureOptionalFreshRegularFile(rulesPath) } };
  await assertFreshCheckpointPublicationSnapshot(marker, snapshot);
  const guard: FreshProjectCheckpointGuard = Object.freeze({ schemaVersion: "evleda.fresh-checkpoint-source-guard.v1" });
  checkpointGuards.add(guard);
  checkpointGuardState.set(guard, { project, marker, snapshot });
  return guard;
}

/** Recheck before report publication; checkpoint publication repeats the same fence. */
export async function assertFreshProjectCheckpointGuardCurrent(project: FreshProject, guard: FreshProjectCheckpointGuard): Promise<void> {
  const state = checkpointGuards.has(guard) ? checkpointGuardState.get(guard) : undefined;
  if (state === undefined || state.project !== project) throw new Error("Checkpoint source guard is unauthenticated or belongs to another project capability.");
  await project.assertMarkerCurrent();
  await assertFreshProjectDirectoryChain(project);
  await assertFreshCheckpointPublicationSnapshot(state.marker, state.snapshot);
}

/**
 * Host-only post-close step. Invoke only after the exact owned editor has exited.
 * KiCad may rewrite identical project settings while closing; no other source
 * identity or byte change is admitted, and the ordinary guard remains strict.
 */
export async function refreshFreshProjectCheckpointGuardAfterOwnedClose(
  project: FreshProject, guard: FreshProjectCheckpointGuard,
): Promise<FreshProjectCheckpointGuard> {
  const state = checkpointGuards.has(guard) ? checkpointGuardState.get(guard) : undefined;
  if (state === undefined || state.project !== project) throw new Error("Checkpoint source guard is unauthenticated or belongs to another project capability.");
  await project.assertMarkerCurrent();
  await assertFreshProjectDirectoryChain(project);
  const previous = state.snapshot.captures.pro;
  const assertOrdinarySettings = async () => {
    const metadata = await lstat(previous.path, { bigint: true });
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n || await realpath(previous.path) !== previous.path) {
      throw new Error("Post-close project settings must be the exact ordinary unaliased unshared file.");
    }
  };
  await assertOrdinarySettings();
  const current = await captureFreshRegularFile(previous.path);
  if (current.path !== previous.path || current.sha256 !== previous.sha256 || !current.bytes.equals(previous.bytes)) {
    throw new Error("Project settings bytes changed during owned close; source guard cannot refresh.");
  }
  const snapshot: FreshCheckpointPublicationSnapshot = { ...state.snapshot,
    captures: Object.freeze({ ...state.snapshot.captures, pro: current }) };
  await assertFreshCheckpointPublicationSnapshot(state.marker, snapshot);
  await assertOrdinarySettings();
  const refreshed: FreshProjectCheckpointGuard = Object.freeze({ schemaVersion: "evleda.fresh-checkpoint-source-guard.v1" });
  checkpointGuards.add(refreshed);
  checkpointGuardState.set(refreshed, { project, marker: state.marker, snapshot });
  return refreshed;
}

async function writeFreshCheckpoint(
  marker: FreshMarker,
  markerPath: string,
  checkpointPath: string,
  reportPath: string,
  status: FreshCheckpointV1["reportStatus"],
  attempt: number,
  reason: FreshCheckpointV1["reason"],
  publicationGuard?: FreshCheckpointPublicationGuard,
  commitOptions?: FreshCheckpointCommitOptions,
): Promise<void> {
  const resolvedReportPath = path.resolve(reportPath);
  if (resolvedReportPath !== path.join(marker.outputPath, "pcb-agent-report.json")) throw new Error("Fresh-project checkpoint report path is not the canonical report.");
  let report: { status?: unknown };
  try { report = JSON.parse(await readFile(resolvedReportPath, "utf8")) as { status?: unknown }; }
  catch (error) { throw new Error("Fresh-project checkpoint report is unreadable.", { cause: error }); }
  if (checkpointStatus.parse(report.status) !== status) throw new Error("Fresh-project checkpoint status does not match its report.");
  if (publicationGuard !== undefined) await assertFreshCheckpointPublicationSnapshot(marker, publicationGuard.snapshot);
  const files = publicationGuard?.snapshot.files ?? await currentFiles(marker);
  const markerSha256 = publicationGuard?.snapshot.marker.sha256 ?? await sha256(markerPath);
  let next: FreshCheckpoint;
  if (marker.schemaVersion === "evleda.pcb-agent-fresh-project.v2") {
    if (reason === "legacy_migration") throw new Error("Generic V2 fresh projects cannot use legacy checkpoint migration.");
    const symbolIdentity = contentIdentity(publicationGuard?.snapshot.captures.symLibTable.bytes ?? await readFile(files.symLibTable.path));
    const footprintIdentity = contentIdentity(publicationGuard?.snapshot.captures.fpLibTable.bytes ?? await readFile(files.fpLibTable.path));
    if (!sameContentIdentity(symbolIdentity, marker.genericBinding.symbolLibraryTableIdentity)
        || !sameContentIdentity(footprintIdentity, marker.genericBinding.footprintLibraryTableIdentity)) {
      throw new Error("Refusing to checkpoint a generic project whose bundle-generated library tables changed.");
    }
    next = {
      schemaVersion: "evleda.pcb-agent-fresh-project-checkpoint.v2",
      baselineMarkerSha256: markerSha256, projectPath: marker.projectPath,
      files, reportPath: resolvedReportPath, reportSha256: await sha256(resolvedReportPath), reportStatus: status, attempt, reason,
      genericBindingIdentity: marker.genericBinding.identity,
      symbolLibraryTableIdentity: marker.genericBinding.symbolLibraryTableIdentity,
      footprintLibraryTableIdentity: marker.genericBinding.footprintLibraryTableIdentity,
    };
  } else if (marker.schemaVersion === "evleda.pcb-agent-fresh-project.v3") {
    if (reason === "legacy_migration") throw new Error("Plane fresh projects cannot use legacy checkpoint migration.");
    const symbolIdentity = contentIdentity(publicationGuard?.snapshot.captures.symLibTable.bytes ?? await readFile(files.symLibTable.path));
    const footprintIdentity = contentIdentity(publicationGuard?.snapshot.captures.fpLibTable.bytes ?? await readFile(files.fpLibTable.path));
    if (!sameContentIdentity(symbolIdentity, marker.planeBinding.symbolLibraryTableIdentity)
        || !sameContentIdentity(footprintIdentity, marker.planeBinding.footprintLibraryTableIdentity)) {
      throw new Error("Refusing to checkpoint a plane project whose V2 bundle-generated library tables changed.");
    }
    const rulesIdentity = contentIdentity(publicationGuard === undefined
      ? (await captureFreshRegularFile(freshFile(files, "dru").path)).bytes
      : freshCapture(publicationGuard.snapshot.captures, "dru").bytes);
    if (!sameContentIdentity(rulesIdentity, marker.planeBinding.expectedRulesContentIdentity)
        || freshFile(files, "dru").sha256 !== rulesIdentity.digest) {
      throw new Error("Refusing to checkpoint a plane project whose immutable owned rules changed.");
    }
    next = {
      schemaVersion: "evleda.pcb-agent-fresh-project-checkpoint.v3",
      baselineMarkerSha256: markerSha256, projectPath: marker.projectPath,
      files, reportPath: resolvedReportPath, reportSha256: await sha256(resolvedReportPath), reportStatus: status, attempt, reason,
      planeBindingIdentity: marker.planeBinding.identity,
      symbolLibraryTableIdentity: marker.planeBinding.symbolLibraryTableIdentity,
      footprintLibraryTableIdentity: marker.planeBinding.footprintLibraryTableIdentity,
    };
  } else {
    next = {
      schemaVersion: "evleda.pcb-agent-fresh-project-checkpoint.v1",
      baselineMarkerSha256: markerSha256, projectPath: marker.projectPath,
      files, reportPath: resolvedReportPath, reportSha256: await sha256(resolvedReportPath), reportStatus: status, attempt, reason,
    };
  }
  await writeAtomicJson(checkpointPath, next, publicationGuard === undefined ? undefined : async () => {
    await publicationGuard.beforeFinalRecheck?.();
    await assertFreshCheckpointPublicationSnapshot(marker, publicationGuard.snapshot);
  }, commitOptions?.assertCanCommit);
}

async function reconcileCheckpointReportMetadata(
  marker: FreshMarker,
  markerPath: string,
  checkpointPath: string,
  checkpoint: FreshCheckpoint,
): Promise<void> {
  const reportPath = path.join(marker.outputPath, "pcb-agent-report.json");
  try {
    const report = JSON.parse(await readFile(reportPath, "utf8")) as { status?: unknown };
    const status = checkpointStatus.parse(report.status);
    const reportHash = await sha256(reportPath);
    if (checkpoint.reportPath !== reportPath || checkpoint.reportSha256 !== reportHash || checkpoint.reportStatus !== status) {
      await writeFreshCheckpoint(marker, markerPath, checkpointPath, reportPath, status, checkpoint.attempt, checkpoint.reason);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    // A malformed/interrupted report is not a project authorization failure.
    // The next CLI exit atomically replaces it and refreshes the checkpoint.
  }
}

export type PrepareFreshProjectOptions =
  | Readonly<{
      readonly outputDir: string;
      readonly name: string;
      readonly resume: boolean;
      /** Omission is the legacy LED fixture for source compatibility. */
      readonly workflowKind?: "led_compatibility_fixture";
    }>
  | Readonly<{
      readonly outputDir: string;
      readonly name: string;
      readonly resume: boolean;
      readonly workflowKind: "generic";
      readonly compilationBundle: PcbDesignCompilationBundle;
      readonly compilationBundleRef: PcbDesignCompilationBundleRef;
    }>
  | (PreparePlaneFreshProjectOptions & Readonly<{ workflowKind: "plane" }>);

export interface PreparePlaneFreshProjectOptions {
  readonly outputDir: string;
  readonly name: string;
  readonly resume: boolean;
  readonly compilationBundle: PcbPlaneCompilationBundle;
  readonly compilationBundleRef: PcbPlaneCompilationBundleRef;
  readonly schematicSeed?: FreshPlaneSchematicSeed;
  readonly placementSeed?: FreshPlanePlacementSeed;
}

/** Read-only checkpoint verification for an already genuine plane capability.
 * Unlike resume, this never reconciles diagnostic metadata or writes sources.
 */
export async function verifyPlaneFreshProjectCheckpointReadonly(project: PlaneFreshProject, bundle: PcbPlaneCompilationBundle) {
  if (!isVerifiedPlaneFreshProject(project)) throw new Error("Seed source requires a genuine plane project capability.");
  const binding = createPlaneFreshProjectBinding(bundle, createPcbPlaneCompilationBundleRef(bundle)).binding;
  try { await lstat(project.unsafeTerminalPath); throw new Error("Seed source has an unsafe terminal marker."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await project.assertMarkerCurrent();
  const marker = await parseVerifiedMarker(project.markerPath, project.outputPath, project.name, false, binding, "plane");
  const checkpoint = await verifyCheckpoint(marker, project.markerPath, project.checkpointPath);
  if (marker.schemaVersion !== "evleda.pcb-agent-fresh-project.v3" || checkpoint?.schemaVersion !== "evleda.pcb-agent-fresh-project-checkpoint.v3"
      || checkpoint.reason !== "run_exit" || checkpoint.reportStatus !== "needs_review") throw new Error("Seed source requires a current healthy closed checkpoint.");
  await project.assertMarkerCurrent();
  return Object.freeze({ projectIdentity: marker.projectIdentity, baselinePcbSha256: marker.files.pcb.sha256,
    checkpointPcbSha256: checkpoint.files.pcb.sha256, reportPath: checkpoint.reportPath, reportSha256: checkpoint.reportSha256 });
}

/** Read the immutable constructor baseline through the genuine project capability.
 * Revision lineage is checked separately against these hashes, never against a report alone. */
export async function readPlaneFreshProjectBaselineHashes(project: PlaneFreshProject, bundle: PcbPlaneCompilationBundle) {
  if (!isVerifiedPlaneFreshProject(project)) throw new Error("Plane baseline requires a genuine project capability.");
  const binding = createPlaneFreshProjectBinding(bundle, createPcbPlaneCompilationBundleRef(bundle)).binding;
  await project.assertMarkerCurrent();
  const marker = await parseVerifiedMarker(project.markerPath, project.outputPath, project.name, false, binding, "plane");
  if (marker.schemaVersion !== "evleda.pcb-agent-fresh-project.v3") throw new Error("Plane baseline family differs.");
  await project.assertMarkerCurrent();
  return Object.freeze({ pcb: marker.files.pcb.sha256, sch: marker.files.sch.sha256, pro: marker.files.pro.sha256, dru: marker.files.dru.sha256 });
}

/** Read-only host administration capture. This never mints a FreshProject or
 * invokes resume/report reconciliation, and grants no old-project write API. */
export const FRESH_RUNTIME_IMPORT_SOURCE_KEYS = Object.freeze(["marker", "checkpoint", "bundle", "report", "sch", "pcb", "pro", "dru", "symLibTable", "fpLibTable"] as const);
export type FreshRuntimeImportSourceKey = typeof FRESH_RUNTIME_IMPORT_SOURCE_KEYS[number];
export type FreshRuntimeImportSourcePins = Readonly<Record<FreshRuntimeImportSourceKey, ContentIdentity>>;
const importFileStamp = (s: BigIntStats) => [s.dev, s.ino, s.birthtimeNs, s.size, s.mtimeNs, s.ctimeNs, s.mode, s.nlink].map(String).join(":");
export async function captureFreshRuntimeImportFile(input: Readonly<{ path: string; contentIdentity: ContentIdentity }>, maximumBytes: number) {
  input = Object.freeze({ path: input.path, contentIdentity: Object.freeze(structuredClone(input.contentIdentity)) });
  if (path.resolve(input.path) !== input.path || input.contentIdentity.algorithm !== "sha256" || !/^[a-f0-9]{64}$/u.test(input.contentIdentity.digest)
      || !Number.isSafeInteger(input.contentIdentity.size) || input.contentIdentity.size < 0 || input.contentIdentity.size > maximumBytes
      || !Number.isSafeInteger(maximumBytes) || maximumBytes > 64 * 1024 * 1024) throw new Error("Runtime source import requires a bounded exact canonical file pin.");
  const parents: FreshFilesystemIdentity[] = [];
  for (let directory = path.dirname(input.path);; directory = path.dirname(directory)) {
    const identity = await readFreshDirectoryIdentity(directory);
    if (identity.dev === null || identity.ino === null) throw new Error("Runtime source import requires exact physical ancestry.");
    parents.push(identity); if (path.dirname(directory) === directory) break;
  }
  const before = await lstat(input.path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== BigInt(input.contentIdentity.size)) throw new Error("Runtime import source is not the pinned ordinary unshared file.");
  const handle = await open(input.path, "r");
  try {
    const opened = await handle.stat({ bigint: true });
    if (importFileStamp(opened) !== importFileStamp(before)) throw new Error("Runtime import source changed while opening.");
    const buffer = Buffer.alloc(input.contentIdentity.size + 1); let count = 0;
    while (count < buffer.length) { const result = await handle.read(buffer, count, buffer.length - count, count); if (!result.bytesRead) break; count += result.bytesRead; }
    const after = await handle.stat({ bigint: true }), atPath = await lstat(input.path, { bigint: true });
    const bytes = buffer.subarray(0, count), identity = contentIdentity(bytes);
    if (count !== input.contentIdentity.size || !sameContentIdentity(identity, input.contentIdentity) || !atPath.isFile() || atPath.isSymbolicLink()
        || atPath.nlink !== 1n || importFileStamp(opened) !== importFileStamp(after) || importFileStamp(opened) !== importFileStamp(atPath)) throw new Error("Runtime import source bytes or physical identity changed.");
    for (const expected of parents) if (!sameFreshDirectoryIdentity(expected, await readFreshDirectoryIdentity(expected.canonicalPath))) throw new Error("Runtime import source ancestry changed.");
    return { path: input.path, bytes, contentIdentity: Object.freeze(identity), physical: importFileStamp(atPath), mtimeNs: atPath.mtimeNs.toString(), parents: Object.freeze(parents) };
  } finally { await handle.close(); }
}
export interface ReadonlyPlaneRuntimeImportSource { readonly kind: "readonly-plane-runtime-import-source"; readonly identity: CanonicalIdentity;
  readonly outputPath: string; readonly name: string; readonly files: Readonly<Record<FreshRuntimeImportSourceKey, Readonly<{ path: string; contentIdentity: ContentIdentity }>>> }
const readonlyRuntimeImportSources = new WeakMap<object, { options: { outputDir: string; name: string; compilationBundle: PcbPlaneCompilationBundle; pins: FreshRuntimeImportSourcePins };
  texts: Readonly<Record<FreshRuntimeImportSourceKey, string>>; physical: string }>();
export async function captureReadonlyPlaneRuntimeImportSource(input: { readonly outputDir: string; readonly name: string;
  readonly compilationBundle: PcbPlaneCompilationBundle; readonly pins: FreshRuntimeImportSourcePins }): Promise<ReadonlyPlaneRuntimeImportSource> {
  const name = validateFreshProjectName(input.name), outputPath = path.resolve(input.outputDir), compilationBundle = input.compilationBundle;
  const pins = structuredClone(input.pins), projectPath = path.join(outputPath, FRESH_PROJECT_DIRECTORY);
  const reference = createPcbPlaneCompilationBundleRef(compilationBundle), binding = createPlaneFreshProjectBinding(compilationBundle, reference).binding;
  if (Object.keys(pins).sort().join("\0") !== [...FRESH_RUNTIME_IMPORT_SOURCE_KEYS].sort().join("\0")) throw new Error("Runtime import source pins must include the exact artifact inventory.");
  for (const key of FRESH_RUNTIME_IMPORT_SOURCE_KEYS) {
    const pin = pins[key];
    if (pin === null || typeof pin !== "object" || Object.keys(pin).sort().join("\0") !== "algorithm\0digest\0size" || pin.algorithm !== "sha256"
        || !/^[a-f0-9]{64}$/u.test(pin.digest) || !Number.isSafeInteger(pin.size) || pin.size < 1 || pin.size > 16 * 1024 * 1024) throw new Error("Runtime import source pin is not closed and bounded.");
    Object.freeze(pin);
  }
  Object.freeze(pins);
  if (!sameContentIdentity(pins.bundle, reference.contentIdentity)) throw new Error("Runtime import bundle pin differs from its authenticated bundle.");
  const assertSafe = async () => {
    try { await lstat(path.join(outputPath, FRESH_PROJECT_UNSAFE_TERMINAL_NAME)); throw new Error("Runtime import source has an unsafe terminal marker."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  };
  await assertSafe();
  const paths: Record<FreshRuntimeImportSourceKey, string> = { marker: path.join(outputPath, FRESH_PROJECT_MARKER_NAME), checkpoint: path.join(outputPath, FRESH_PROJECT_CHECKPOINT_NAME),
    bundle: path.join(outputPath, "toolbox-design-bundle.json"), report: path.join(outputPath, "pcb-agent-report.json"),
    ...Object.fromEntries(Object.entries({ ...fileNames(name), dru: `${name}.kicad_dru` }).map(([key, file]) => [key, path.join(projectPath, file)])) } as Record<FreshRuntimeImportSourceKey, string>;
  const captures = new Map<FreshRuntimeImportSourceKey, Awaited<ReturnType<typeof captureFreshRuntimeImportFile>>>();
  for (const key of FRESH_RUNTIME_IMPORT_SOURCE_KEYS) captures.set(key, await captureFreshRuntimeImportFile({ path: paths[key], contentIdentity: pins[key] },
    key === "report" ? 16 * 1024 * 1024 : key === "bundle" ? 8 * 1024 * 1024 : 2 * 1024 * 1024));
  const marker = await parseVerifiedMarker(paths.marker, outputPath, name, false, binding, "plane"), checkpoint = await verifyCheckpoint(marker, paths.marker, paths.checkpoint);
  if (marker.schemaVersion !== "evleda.pcb-agent-fresh-project.v3" || checkpoint?.schemaVersion !== "evleda.pcb-agent-fresh-project-checkpoint.v3"
      || checkpoint.reason !== "run_exit" || checkpoint.reportStatus !== "needs_review" || checkpoint.reportSha256 !== pins.report.digest
      || marker.files.pcb.sha256 !== pins.pcb.digest) throw new Error("Runtime import requires a pinned healthy closed checkpoint and unmaterialized board baseline.");
  for (const key of FRESH_RUNTIME_IMPORT_SOURCE_KEYS) {
    const before = captures.get(key)!, after = await captureFreshRuntimeImportFile(before, Math.max(before.bytes.length, 1));
    if (after.physical !== before.physical || canonicalJson(after.parents) !== canonicalJson(before.parents)) throw new Error("Runtime import source changed during read-only capture.");
  }
  await assertSafe();
  const files = Object.freeze(Object.fromEntries([...captures].map(([key, value]) => [key, Object.freeze({ path: value.path, contentIdentity: value.contentIdentity })]))) as ReadonlyPlaneRuntimeImportSource["files"];
  const physical = canonicalJson(Object.fromEntries([...captures].map(([key, value]) => [key, { physical: value.physical, parents: value.parents }])));
  const identity = Object.freeze(canonicalIdentity({ outputPath, name, files, physical, planeBindingIdentity: binding.identity }, "evleda.readonly-plane-runtime-import-source.v1"));
  const texts = Object.freeze(Object.fromEntries([...captures].map(([key, value]) => {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value.bytes);
    if (!Buffer.from(text).equals(value.bytes)) throw new Error("Runtime import source is not exact UTF-8.");
    return [key, text];
  }))) as Readonly<Record<FreshRuntimeImportSourceKey, string>>;
  const capability: ReadonlyPlaneRuntimeImportSource = Object.freeze({ kind: "readonly-plane-runtime-import-source", identity, outputPath, name, files });
  readonlyRuntimeImportSources.set(capability, { options: { outputDir: outputPath, name, compilationBundle, pins }, texts, physical });
  return capability;
}
export function readReadonlyPlaneRuntimeImportSource(source: ReadonlyPlaneRuntimeImportSource, key: FreshRuntimeImportSourceKey): string {
  const state = readonlyRuntimeImportSources.get(source); if (state === undefined) throw new Error("Runtime import source capability is not genuine.");
  return state.texts[key];
}
export async function assertReadonlyPlaneRuntimeImportSourceCurrent(source: ReadonlyPlaneRuntimeImportSource): Promise<void> {
  const state = readonlyRuntimeImportSources.get(source); if (state === undefined) throw new Error("Runtime import source capability is not genuine.");
  const current = await captureReadonlyPlaneRuntimeImportSource(state.options);
  if (canonicalJson(current.identity) !== canonicalJson(source.identity)) throw new Error("Runtime import source changed after read-only capture.");
}

/** Compilation support is broader than the currently qualified native writer. */
export function assertCurrentPlaneNativeAuthoringScope(bundle: PcbPlaneCompilationBundle): void {
  if (!isAuthenticatedPcbPlaneCompilationBundle(bundle)) throw new Error("Native authoring scope requires an authenticated plane bundle.");
  if (bundle.contract.scope.board.layerCount !== 2 || bundle.contract.planes.length !== 1) {
    throw new Error("FOUR_LAYER_NATIVE_AUTHORING_UNAVAILABLE: four-layer compilation is supported, but internal-layer and multiple-plane native authoring is not yet qualified. No project was prepared.");
  }
}

/** Creates or verifies the only project class allowed to expose fresh incremental authoring. */
export async function prepareFreshProject(options: PrepareFreshProjectOptions): Promise<FreshProject> {
  const name = validateFreshProjectName(options.name);
  const schematicSeed = options.workflowKind === "plane" ? options.schematicSeed : undefined;
  const placementSeed = options.workflowKind === "plane" ? options.placementSeed : undefined;
  const hasSeed = schematicSeed !== undefined || placementSeed !== undefined;
  if (hasSeed && options.resume) throw new Error("A seed is only valid during new plane project issuance.");
  if (schematicSeed !== undefined && placementSeed !== undefined) throw new Error("Distinct plane source seeds cannot be combined.");
  if (options.workflowKind !== undefined && !["led_compatibility_fixture", "generic", "plane"].includes(options.workflowKind)) {
    throw new Error("Fresh-project workflow family is unsupported.");
  }
  if ((options.workflowKind === undefined || options.workflowKind === "led_compatibility_fixture")
      && ((options as { compilationBundle?: unknown }).compilationBundle !== undefined || (options as { compilationBundleRef?: unknown }).compilationBundleRef !== undefined)) {
    throw new Error("Bundle-bound preparation requires an explicit generic or plane workflow; it cannot fall back to LED.");
  }
  const generic = options.workflowKind === "generic"
    ? createGenericFreshProjectBinding(options.compilationBundle, options.compilationBundleRef)
    : undefined;
  const planeInput = options.workflowKind === "plane"
    ? { bundle: options.compilationBundle, bundleRef: options.compilationBundleRef } : undefined;
  if (planeInput !== undefined) assertCurrentPlaneNativeAuthoringScope(planeInput.bundle);
  const plane = planeInput === undefined ? undefined : createPlaneFreshProjectBinding(planeInput.bundle, planeInput.bundleRef);
  const workflowKind = plane !== undefined ? "plane" as const : generic === undefined ? "led_compatibility_fixture" as const : "generic" as const;
  const expectedBinding = plane?.binding ?? generic?.binding;
  const requestedOutput = path.resolve(options.outputDir);
  try {
    const info = await lstat(requestedOutput);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("--output-dir must be an ordinary directory.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(requestedOutput, { recursive: true });
  }
  const outputPath = path.resolve(requestedOutput);
  const projectPath = path.join(outputPath, FRESH_PROJECT_DIRECTORY);
  const markerPath = path.join(outputPath, FRESH_PROJECT_MARKER_NAME);
  if (options.resume) {
    const unsafePath = path.join(outputPath, FRESH_PROJECT_UNSAFE_TERMINAL_NAME);
    try {
      JSON.parse(await readFile(unsafePath, "utf8"));
      throw new Error("Fresh project has an unsafe connectivity terminal and cannot resume; create a newly prepared fresh project.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const marker = await parseVerifiedMarker(markerPath, outputPath, name, false, expectedBinding, workflowKind);
    const checkpoint = await verifyCheckpoint(marker, markerPath, path.join(outputPath, FRESH_PROJECT_CHECKPOINT_NAME));
    if (checkpoint === undefined) await parseVerifiedMarker(markerPath, outputPath, name, true, expectedBinding, workflowKind);
    else await reconcileCheckpointReportMetadata(marker, markerPath, path.join(outputPath, FRESH_PROJECT_CHECKPOINT_NAME), checkpoint);
  } else {
    if ((await readdir(outputPath)).length !== 0) throw new Error("--output-dir must be empty before --prepare --new-project.");
    const seedDirectories: FreshFilesystemIdentity[] = [];
    if (hasSeed) {
      for (let directory = outputPath;; directory = path.dirname(directory)) {
        const identity = await readFreshDirectoryIdentity(directory);
        if (identity.dev === null || identity.ino === null) throw new Error("Seeded issuance requires exact physical destination directory identities.");
        seedDirectories.push(identity);
        if (path.dirname(directory) === directory) break;
      }
    }
    const assertSeedDestination = async () => {
      for (const expected of seedDirectories) if (!sameFreshDirectoryIdentity(expected, await readFreshDirectoryIdentity(expected.canonicalPath))) {
        throw new Error("Seeded destination directory changed during source qualification.");
      }
    };
    const placementSources = placementSeed === undefined ? undefined
      : await consumeFreshPlanePlacementSeed(placementSeed, outputPath, name, planeInput!.bundle);
    if (placementSources !== undefined && placementSources.dru !== plane!.rulesSource) throw new Error("Placement seed rules differ from the new canonical rules.");
    const boardSource = placementSources?.pcb ?? emptyBoard(planeInput?.bundle);
    const schematicSource = placementSources?.sch ?? (schematicSeed === undefined ? emptySchematic(name, randomUUID())
      : await consumeFreshPlaneSchematicSeed(schematicSeed, outputPath, name, planeInput!.bundle));
    if (hasSeed) {
      await assertSeedDestination();
      if ((await readdir(outputPath)).length !== 0) throw new Error("Seeded destination became nonempty during source qualification.");
    }
    await mkdir(projectPath);
    const seedProjectIdentity = hasSeed ? await readFreshDirectoryIdentity(projectPath) : undefined;
    const names = plane === undefined ? fileNames(name) : { ...fileNames(name), dru: `${name}.kicad_dru` };
    await Promise.all([
      writeFile(path.join(projectPath, names.pro), placementSources?.pro ?? emptyProject(name, planeInput === undefined ? undefined : derivePcbNativeNumericRules(planeInput.bundle.contract)), { encoding: "utf8", flag: "wx" }),
      writeFile(path.join(projectPath, names.sch), schematicSource, { encoding: "utf8", flag: "wx" }),
      writeFile(path.join(projectPath, names.pcb), boardSource, { encoding: "utf8", flag: "wx" }),
      writeFile(path.join(projectPath, names.symLibTable), plane?.symbolTable ?? generic?.symbolTable ?? freshSymbolLibraryTable(), { encoding: "utf8", flag: "wx" }),
      writeFile(path.join(projectPath, names.fpLibTable), plane?.footprintTable ?? generic?.footprintTable ?? freshFootprintLibraryTable(), { encoding: "utf8", flag: "wx" }),
      ...(plane === undefined ? [] : [writeFile(path.join(projectPath, `${name}.kicad_dru`), plane.rulesSource, { encoding: "utf8", flag: "wx" })]),
    ]);
    const seededFiles = new Map<string, FreshRegularFileCapture>();
    const files = Object.fromEntries(await Promise.all((Object.entries(names) as [keyof typeof names, string][]).map(async ([key, filename]) => {
      const filePath = path.join(projectPath, filename);
      const captured = await captureFreshRegularFile(filePath);
      if (hasSeed) seededFiles.set(filePath, captured);
      return [key, { path: filePath, sha256: captured.sha256 }];
    }))) as FreshMarker["files"];
    const marker: FreshMarker = plane !== undefined
      ? { schemaVersion: "evleda.pcb-agent-fresh-project.v3", workflowKind: "plane", name, outputPath, projectPath, projectIdentity: await readFreshDirectoryIdentity(projectPath),
        files: { ...files, dru: freshFile(files, "dru") }, planeBinding: plane.binding }
      : generic === undefined
      ? { schemaVersion: "evleda.pcb-agent-fresh-project.v1", name, outputPath, projectPath, projectIdentity: await readFreshDirectoryIdentity(projectPath), files }
      : { schemaVersion: "evleda.pcb-agent-fresh-project.v2", workflowKind: "generic", name, outputPath, projectPath, projectIdentity: await readFreshDirectoryIdentity(projectPath), files, genericBinding: generic.binding };
    if (hasSeed) {
      if (schematicSeed !== undefined) await assertFreshPlaneSchematicSeedCurrent(schematicSeed);
      if (placementSeed !== undefined) await assertFreshPlanePlacementSeedCurrent(placementSeed);
      await assertSeedDestination();
      if (!sameFreshDirectoryIdentity(seedProjectIdentity!, await readFreshDirectoryIdentity(projectPath))
          || !sameFreshDirectoryIdentity(seedProjectIdentity!, marker.projectIdentity)
          || canonicalJson((await readdir(outputPath)).sort()) !== canonicalJson([FRESH_PROJECT_DIRECTORY])
          || canonicalJson((await readdir(projectPath)).sort()) !== canonicalJson(Object.values(names).sort())) {
        throw new Error("Seeded destination sources or physical project identity changed before marker publication.");
      }
      for (const [filePath, before] of seededFiles) {
        const after = await captureFreshRegularFile(filePath), state = await lstat(filePath, { bigint: true });
        if (state.nlink !== 1n || !sameRegularFileCaptureIdentity(before, after)) throw new Error("Seeded source changed before marker publication.");
      }
      await assertSeedDestination();
    }
    await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  }
  const markerIdentityBeforeCapability = contentIdentity(await readFile(markerPath));
  const marker = await parseVerifiedMarker(markerPath, outputPath, name, !options.resume, expectedBinding, workflowKind, schematicSeed, placementSeed);
  const markerIdentityAfterCapability = contentIdentity(await readFile(markerPath));
  if (!sameContentIdentity(markerIdentityBeforeCapability, markerIdentityAfterCapability)) {
    throw new Error("Fresh-project marker changed while its capability was being minted.");
  }
  const authenticatedMarkerIdentity = markerIdentityAfterCapability;
  if (marker.schemaVersion === "evleda.pcb-agent-fresh-project.v3") freezeGenericBinding(marker);
  const checkpointPath = path.join(outputPath, FRESH_PROJECT_CHECKPOINT_NAME);
  const unsafeTerminalPath = path.join(outputPath, FRESH_PROJECT_UNSAFE_TERMINAL_NAME);
  const project: FreshProject = Object.freeze({
    workflowKind,
    ...(marker.schemaVersion === "evleda.pcb-agent-fresh-project.v2" ? { genericBinding: marker.genericBinding } : {}),
    ...(marker.schemaVersion === "evleda.pcb-agent-fresh-project.v3" ? { planeBinding: marker.planeBinding, rulesPath: marker.files.dru.path } : {}),
    name, outputPath, projectPath, projectIdentity: marker.projectIdentity, schematicPath: marker.files.sch.path, pcbPath: marker.files.pcb.path, markerPath, checkpointPath, unsafeTerminalPath,
    assertMarkerCurrent: async () => {
      const before = contentIdentity(await readFile(markerPath));
      if (!sameContentIdentity(before, authenticatedMarkerIdentity)) throw new Error("Fresh-project marker bytes changed after the project capability was minted.");
      await parseVerifiedMarker(markerPath, outputPath, name, false, expectedBinding, workflowKind);
      const after = contentIdentity(await readFile(markerPath));
      if (!sameContentIdentity(after, authenticatedMarkerIdentity)) throw new Error("Fresh-project marker changed during closed verification.");
      return Object.freeze({ ...after });
    },
    assertSchematicEmpty: async () => { await parseVerifiedMarker(markerPath, outputPath, name, true, expectedBinding, workflowKind); },
    checkpointAfterReport: async (reportPath: string, status: FreshCheckpointV1["reportStatus"], commitOptions?: FreshCheckpointCommitOptions) => {
      const options = parseFreshCheckpointCommitOptions(commitOptions);
      if (workflowKind === "plane") await project.assertMarkerCurrent();
      if (options?.sourceGuard !== undefined) await assertFreshProjectCheckpointGuardCurrent(project, options.sourceGuard);
      const sourceState = options?.sourceGuard === undefined ? undefined : checkpointGuardState.get(options.sourceGuard)!;
      const previous = await readCheckpoint(checkpointPath);
      await writeFreshCheckpoint(marker, markerPath, checkpointPath, reportPath, status, (previous?.attempt ?? 0) + 1, "run_exit",
        sourceState === undefined ? undefined : { snapshot: sourceState.snapshot }, options);
    },
    recordUnsafeTerminal: async (reportPath: string, reason: string) => {
      const resolvedReport = path.resolve(reportPath);
      if (resolvedReport !== path.join(outputPath, "pcb-agent-report.json")) throw new Error("Unsafe fresh terminal report path is not canonical.");
      const normalizedReason = reason.replace(/\s+/gu, " ").trim();
      if (normalizedReason.length === 0 || normalizedReason.length > 2_000) throw new Error("Unsafe fresh terminal reason is invalid.");
      await writeAtomicJson(unsafeTerminalPath, {
        schemaVersion: "evleda.pcb-agent-unsafe-terminal.v1",
        projectPath,
        reportPath: resolvedReport,
        reportSha256: await sha256(resolvedReport),
        reason: normalizedReason,
      });
    },
    [freshProjectCapability]: true as const,
  });
  if (workflowKind === "plane") {
    planeProjectCapabilities.add(project);
    const projection = derivePcbNativeNumericRules(planeInput!.bundle.contract);
    if (projection !== undefined) planeNumericProjections.set(project, projection);
  }
  return project;
}

/** Explicit plane-only entrypoint; V1 artifacts never acquire plane authority by shape. */
export async function preparePlaneFreshProject(options: PreparePlaneFreshProjectOptions): Promise<PlaneFreshProject> {
  const project = await prepareFreshProject({ ...options, workflowKind: "plane" });
  if (!isVerifiedPlaneFreshProject(project)) throw new Error("Plane preparation did not mint a plane capability.");
  return project;
}

/**
 * One-time, explicit migration for a reviewed interrupted fresh run created
 * before checkpoint support. It never changes the baseline marker or project.
 */
export async function migrateFreshProjectCheckpoint(options: { readonly outputDir: string; readonly name: string }): Promise<void> {
  const name = validateFreshProjectName(options.name);
  const outputPath = path.resolve(options.outputDir);
  const markerPath = path.join(outputPath, FRESH_PROJECT_MARKER_NAME);
  const checkpointPath = path.join(outputPath, FRESH_PROJECT_CHECKPOINT_NAME);
  const marker = await parseVerifiedMarker(markerPath, outputPath, name, false, undefined, "led_compatibility_fixture");
  if (await readCheckpoint(checkpointPath) !== undefined) throw new Error("Fresh-project checkpoint migration is one-time and already completed.");
  const reportPath = path.join(outputPath, "pcb-agent-report.json");
  const report = JSON.parse(await readFile(reportPath, "utf8")) as { status?: unknown };
  const status = checkpointStatus.parse(report.status);
  await writeFreshCheckpoint(marker, markerPath, checkpointPath, reportPath, status, 1, "legacy_migration");
}

const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || Array.isArray(value) || typeof value !== "object") throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
};
const assertEmptyArray = (value: unknown, label: string): void => {
  if (!Array.isArray(value) || value.length !== 0) throw new Error(`${label} must remain an empty KiCad default.`);
};
const assertEmptyObject = (value: unknown, label: string): void => {
  if (value === null || Array.isArray(value) || typeof value !== "object" || Object.keys(value as object).length !== 0) throw new Error(`${label} must remain an empty KiCad default.`);
};
const assertExact = (value: unknown, expected: unknown, label: string): void => {
  if (JSON.stringify(value) !== JSON.stringify(expected)) throw new Error(`${label} differs from the audited KiCad 10 open/save default.`);
};

const AUDITED_KICAD10_DEFAULT_NET_CLASS = Object.freeze({
  bus_width: 12,
  clearance: 0.2,
  diff_pair_gap: 0.25,
  diff_pair_via_gap: 0.25,
  diff_pair_width: 0.2,
  line_style: 0,
  microvia_diameter: 0.3,
  microvia_drill: 0.1,
  name: "Default",
  pcb_color: "rgba(0, 0, 0, 0.000)",
  priority: 2_147_483_647,
  schematic_color: "rgba(0, 0, 0, 0.000)",
  track_width: 0.2,
  tuning_profile: "",
  via_diameter: 0.6,
  via_drill: 0.3,
  wire_width: 6,
} satisfies FreshProjectManagedNetClass);

/** Narrowly recognizes the observed KiCad 10 blank-project open/save expansion. */
function assertKicad10OpenNormalization(proText: string, name: string): void {
  let candidate: Record<string, unknown>;
  try { candidate = asRecord(JSON.parse(proText), "KiCad project file"); }
  catch (error) { throw new Error("KiCad project file is not valid JSON.", { cause: error }); }
  const rootKeys = ["board", "boards", "component_class_settings", "cvpcb", "libraries", "meta", "net_settings", "pcbnew", "schematic", "sheets", "text_variables", "tuning_profiles"];
  if (Object.keys(candidate).some((key) => !rootKeys.includes(key))) throw new Error("KiCad project file contains a non-default top-level section.");
  assertEmptyArray(candidate.boards, "boards");
  assertEmptyArray(candidate.sheets, "sheets");
  assertEmptyObject(candidate.text_variables, "text_variables");

  const meta = asRecord(candidate.meta, "meta");
  assertExact(meta, { filename: `${name}.kicad_pro`, fixtureId: "evleda-fresh-kicad10", generatedBy: "evleda pcb-agent fresh project", version: 3 }, "meta");
  const libraries = asRecord(candidate.libraries, "libraries");
  assertEmptyArray(libraries.pinned_footprint_libs, "pinned_footprint_libs");
  assertEmptyArray(libraries.pinned_symbol_libs, "pinned_symbol_libs");
  const classes = asRecord(candidate.component_class_settings, "component_class_settings");
  assertEmptyArray(classes.assignments, "component class assignments");
  assertExact(classes.sheet_component_classes, { enabled: false }, "sheet component classes");
  const cvpcb = asRecord(candidate.cvpcb, "cvpcb");
  assertEmptyArray(cvpcb.equivalence_files, "cvpcb equivalence files");

  const net = asRecord(candidate.net_settings, "net_settings");
  assertEmptyArray(net.netclass_patterns, "netclass patterns");
  if (net.netclass_assignments !== null || net.net_colors !== null) throw new Error("KiCad project file contains netclass assignments or colors.");
  const netClasses = net.classes;
  if (!Array.isArray(netClasses) || netClasses.length !== 1) throw new Error("KiCad project file must retain exactly the default net class.");
  assertExact(netClasses[0], AUDITED_KICAD10_DEFAULT_NET_CLASS, "default net class");

  const schematic = asRecord(candidate.schematic, "schematic");
  assertExact(schematic.bus_aliases, {}, "schematic bus aliases");
  assertExact(schematic.file, `${name}.kicad_sch`, "schematic file");
  assertExact(schematic.legacy_lib_dir, "", "legacy symbol path");
  assertEmptyArray(schematic.legacy_lib_list, "legacy symbol list");
  assertExact(schematic.top_level_sheets, [{ filename: `${name}.kicad_sch`, name, uuid: "00000000-0000-0000-0000-000000000000" }], "top-level sheets");

  const pcbnew = asRecord(candidate.pcbnew, "pcbnew");
  assertExact(pcbnew.page_layout_descr_file, "", "page layout path");
  assertExact(pcbnew.last_paths, { idf: "", netlist: "", plot: "", specctra_dsn: "", vrml: "" }, "pcbnew last paths");
  const board = asRecord(candidate.board, "board");
  assertExact(board.file, `${name}.kicad_pcb`, "board file");
  assertEmptyArray(board.layer_pairs, "board layer pairs");
  assertEmptyArray(board.layer_presets, "board layer presets");
  assertEmptyArray(board.viewports, "board viewports");
  const design = asRecord(board.design_settings, "board design settings");
  assertEmptyArray(design.diff_pair_dimensions, "diff pair dimensions");
  assertEmptyArray(design.drc_exclusions, "DRC exclusions");
  assertEmptyArray(design.track_widths, "custom track widths");
  assertEmptyArray(design.via_dimensions, "custom via dimensions");
  const rules = asRecord(design.rules, "board rules");
  assertExact(rules, { max_error: 0.005, min_clearance: 0.0, min_connection: 0.0, min_copper_edge_clearance: 0.5, min_groove_width: 0.0, min_hole_clearance: 0.25, min_hole_to_hole: 0.25, min_microvia_diameter: 0.2, min_microvia_drill: 0.1, min_resolved_spokes: 2, min_silk_clearance: 0.0, min_text_height: 0.8, min_text_thickness: 0.08, min_through_hole_diameter: 0.3, min_track_width: 0.2, min_via_annular_width: 0.1, min_via_diameter: 0.5, solder_mask_to_copper_clearance: 0.0, use_height_for_length_calcs: true }, "board rule defaults");
}

const MANAGED_NETCLASS_NAME = /^EVLEDA_[a-f0-9]{12}_C(?:0[1-9]|[1-9]\d*)$/u;
const CONTRACT_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.+-]{0,63}$/u;
const CONTRACT_NET_NAME = /^(?!(?:__proto__|constructor|prototype)$)[A-Za-z0-9+-][A-Za-z0-9_.+-]{0,63}$/u;
const finiteNumber = z.number().finite().refine((value) => !Object.is(value, -0), "must not be negative zero");
const managedNetClassSchema = z.object({
  bus_width: finiteNumber,
  clearance: finiteNumber,
  diff_pair_gap: finiteNumber,
  diff_pair_via_gap: finiteNumber,
  diff_pair_width: finiteNumber,
  line_style: finiteNumber,
  microvia_diameter: finiteNumber,
  microvia_drill: finiteNumber,
  name: z.string().regex(MANAGED_NETCLASS_NAME),
  pcb_color: z.literal("rgba(0, 0, 0, 0.000)"),
  priority: z.literal(-1),
  schematic_color: z.literal("rgba(0, 0, 0, 0.000)"),
  track_width: finiteNumber,
  tuning_profile: z.literal(""),
  via_diameter: finiteNumber,
  via_drill: finiteNumber,
  wire_width: finiteNumber,
}).strict().superRefine((value, context) => {
  const fixed = {
    bus_width: 12, diff_pair_gap: 0.25, diff_pair_via_gap: 0.25, line_style: 0,
    microvia_diameter: 0.3, microvia_drill: 0.1, wire_width: 6,
  } as const;
  for (const [key, expected] of Object.entries(fixed)) {
    if (value[key as keyof typeof fixed] !== expected) context.addIssue({ code: "custom", message: `${key} is not the audited KiCad value` });
  }
  if (value.clearance < 0.05 || value.clearance > 10) context.addIssue({ code: "custom", message: "clearance is outside the contract bound" });
  if (value.track_width < 0.05 || value.track_width > 20 || value.diff_pair_width !== value.track_width) {
    context.addIssue({ code: "custom", message: "track and differential-pair widths are inconsistent" });
  }
  if (value.via_drill <= 0 || value.via_diameter <= value.via_drill) context.addIssue({ code: "custom", message: "via geometry is invalid" });
});
const contractNetAssignmentSchema = z.object({
  netName: z.string().regex(CONTRACT_NET_NAME),
  contractNetClassId: z.string().regex(CONTRACT_IDENTIFIER),
  kicadNetClassName: z.string().regex(MANAGED_NETCLASS_NAME),
}).strict();
const netClassProjectionSchema = z.object({
  netClasses: z.array(managedNetClassSchema).min(1).max(32),
  contractNetAssignments: z.array(contractNetAssignmentSchema).min(1).max(128),
}).strict().superRefine((value, context) => {
  const classNames = value.netClasses.map((entry) => entry.name);
  if (new Set(classNames).size !== classNames.length) context.addIssue({ code: "custom", message: "managed net-class names must be unique" });
  const netNames = value.contractNetAssignments.map((entry) => entry.netName);
  if (new Set(netNames).size !== netNames.length) context.addIssue({ code: "custom", message: "contract net assignments must be unique" });
  const classNameSet = new Set(classNames);
  const byContractId = new Map<string, string>();
  const byClassName = new Map<string, string>();
  for (const assignment of value.contractNetAssignments) {
    if (!classNameSet.has(assignment.kicadNetClassName)) context.addIssue({ code: "custom", message: "contract assignment references an unknown managed net class" });
    const priorClass = byContractId.get(assignment.contractNetClassId);
    if (priorClass !== undefined && priorClass !== assignment.kicadNetClassName) context.addIssue({ code: "custom", message: "contract net-class ID maps to multiple KiCad classes" });
    const priorId = byClassName.get(assignment.kicadNetClassName);
    if (priorId !== undefined && priorId !== assignment.contractNetClassId) context.addIssue({ code: "custom", message: "KiCad net class maps to multiple contract IDs" });
    byContractId.set(assignment.contractNetClassId, assignment.kicadNetClassName);
    byClassName.set(assignment.kicadNetClassName, assignment.contractNetClassId);
  }
  if (classNames.some((className) => !byClassName.has(className))) context.addIssue({ code: "custom", message: "every managed net class must have a contract assignment" });
});

const AUDITED_KICAD10_COMPACT_NON_NET_SETTINGS = (name: string): Record<string, unknown> => ({
  board: {
    file: `${name}.kicad_pcb`, layer_pairs: [], layer_presets: [], viewports: [],
    design_settings: {
      diff_pair_dimensions: [], drc_exclusions: [], track_widths: [], via_dimensions: [],
      rules: { max_error: 0.005, min_clearance: 0, min_connection: 0, min_copper_edge_clearance: 0.5, min_groove_width: 0, min_hole_clearance: 0.25, min_hole_to_hole: 0.25, min_microvia_diameter: 0.2, min_microvia_drill: 0.1, min_resolved_spokes: 2, min_silk_clearance: 0, min_text_height: 0.8, min_text_thickness: 0.08, min_through_hole_diameter: 0.3, min_track_width: 0.2, min_via_annular_width: 0.1, min_via_diameter: 0.5, solder_mask_to_copper_clearance: 0, use_height_for_length_calcs: true },
    },
  },
  boards: [],
  component_class_settings: { assignments: [], sheet_component_classes: { enabled: false } },
  cvpcb: { equivalence_files: [] },
  libraries: { pinned_footprint_libs: [], pinned_symbol_libs: [] },
  meta: { filename: `${name}.kicad_pro`, fixtureId: "evleda-fresh-kicad10", generatedBy: "evleda pcb-agent fresh project", version: 3 },
  pcbnew: { last_paths: { idf: "", netlist: "", plot: "", specctra_dsn: "", vrml: "" }, page_layout_descr_file: "" },
  schematic: { bus_aliases: {}, file: `${name}.kicad_sch`, legacy_lib_dir: "", legacy_lib_list: [], top_level_sheets: [{ filename: `${name}.kicad_sch`, name, uuid: "00000000-0000-0000-0000-000000000000" }] },
  sheets: [],
  text_variables: {},
  tuning_profiles: {},
});

/** Exact post-materialization form before KiCad has expanded GUI defaults. */
const AUDITED_GENERIC_SPARSE_NON_NET_SETTINGS = (name: string): Record<string, unknown> => ({
  meta: { filename: name, version: 1, fixtureId: "evleda-fresh-kicad10", generatedBy: "evleda pcb-agent fresh project" },
  schematic: { file: `${name}.kicad_sch` },
  board: { file: `${name}.kicad_pcb`, design_settings: { rules: { min_clearance: 0 } } },
});

/* Exact host-observed KiCad 10.0.3 blank-project expansion, excluding net_settings. */
const AUDITED_KICAD10_EXPANDED_NON_NET_SETTINGS_JSON = String.raw`{"board":{"3dviewports":[],"design_settings":{"defaults":{"apply_defaults_to_fp_barcodes":false,"apply_defaults_to_fp_dimensions":false,"apply_defaults_to_fp_fields":false,"apply_defaults_to_fp_shapes":false,"apply_defaults_to_fp_text":false,"board_outline_line_width":0.05,"copper_line_width":0.2,"copper_text_italic":false,"copper_text_size_h":1.5,"copper_text_size_v":1.5,"copper_text_thickness":0.3,"copper_text_upright":false,"courtyard_line_width":0.05,"dimension_precision":4,"dimension_units":3,"dimensions":{"arrow_length":1270000,"extension_offset":500000,"keep_text_aligned":true,"suppress_zeroes":true,"text_position":0,"units_format":0},"fab_line_width":0.1,"fab_text_italic":false,"fab_text_size_h":1,"fab_text_size_v":1,"fab_text_thickness":0.15,"fab_text_upright":false,"other_line_width":0.1,"other_text_italic":false,"other_text_size_h":1,"other_text_size_v":1,"other_text_thickness":0.15,"other_text_upright":false,"pads":{"drill":0.8,"height":1.27,"width":2.54},"silk_line_width":0.1,"silk_text_italic":false,"silk_text_size_h":1,"silk_text_size_v":1,"silk_text_thickness":0.1,"silk_text_upright":false,"zones":{"border_display_style":2,"border_hatch_pitch":0.5,"corner_radius":0,"corner_smoothing":0,"fill_mode":0,"hatch_gap":1.5,"hatch_orientation":0,"hatch_smoothing_level":0,"hatch_smoothing_value":0.1,"hatch_thickness":1,"min_clearance":0.5,"min_island_area":10,"min_thickness":0.25,"pad_connection":1,"remove_islands":0,"thermal_relief_gap":0.5,"thermal_relief_spoke_width":0.5}},"diff_pair_dimensions":[],"drc_exclusions":[],"meta":{"version":2},"rule_severities":{"annular_width":"error","clearance":"error","connection_width":"warning","copper_edge_clearance":"error","copper_sliver":"warning","courtyards_overlap":"error","creepage":"error","diff_pair_gap_out_of_range":"error","diff_pair_uncoupled_length_too_long":"error","drill_out_of_range":"error","duplicate_footprints":"warning","extra_footprint":"warning","footprint":"error","footprint_filters_mismatch":"ignore","footprint_symbol_field_mismatch":"warning","footprint_symbol_mismatch":"warning","footprint_type_mismatch":"ignore","hole_clearance":"error","hole_to_hole":"warning","holes_co_located":"warning","invalid_outline":"error","isolated_copper":"warning","item_on_disabled_layer":"error","items_not_allowed":"error","length_out_of_range":"error","lib_footprint_issues":"warning","lib_footprint_mismatch":"warning","malformed_courtyard":"error","microvia_drill_out_of_range":"error","mirrored_text_on_front_layer":"warning","missing_courtyard":"ignore","missing_footprint":"warning","missing_tuning_profile":"warning","net_conflict":"warning","nonmirrored_text_on_back_layer":"warning","npth_inside_courtyard":"error","padstack":"warning","pth_inside_courtyard":"error","shorting_items":"error","silk_edge_clearance":"warning","silk_over_copper":"warning","silk_overlap":"warning","skew_out_of_range":"error","solder_mask_bridge":"error","starved_thermal":"error","text_height":"warning","text_on_edge_cuts":"error","text_thickness":"warning","through_hole_pad_without_hole":"error","too_many_vias":"error","track_angle":"error","track_dangling":"warning","track_not_centered_on_via":"ignore","track_on_post_machined_layer":"error","track_segment_length":"error","track_width":"error","tracks_crossing":"error","tuning_profile_track_geometries":"ignore","unconnected_items":"error","unresolved_variable":"error","via_dangling":"warning","zones_intersect":"error"},"rules":{"max_error":0.005,"min_clearance":0,"min_connection":0,"min_copper_edge_clearance":0.5,"min_groove_width":0,"min_hole_clearance":0.25,"min_hole_to_hole":0.25,"min_microvia_diameter":0.2,"min_microvia_drill":0.1,"min_resolved_spokes":2,"min_silk_clearance":0,"min_text_height":0.8,"min_text_thickness":0.08,"min_through_hole_diameter":0.3,"min_track_width":0.2,"min_via_annular_width":0.1,"min_via_diameter":0.5,"solder_mask_to_copper_clearance":0,"use_height_for_length_calcs":true},"teardrop_options":[{"td_onpthpad":true,"td_onroundshapesonly":false,"td_onsmdpad":true,"td_ontrackend":false,"td_onvia":true}],"teardrop_parameters":[{"td_allow_use_two_tracks":true,"td_curve_segcount":0,"td_height_ratio":1,"td_length_ratio":0.5,"td_maxheight":2,"td_maxlen":1,"td_on_pad_in_zone":false,"td_target_name":"td_round_shape","td_width_to_size_filter_ratio":0.9},{"td_allow_use_two_tracks":true,"td_curve_segcount":0,"td_height_ratio":1,"td_length_ratio":0.5,"td_maxheight":2,"td_maxlen":1,"td_on_pad_in_zone":false,"td_target_name":"td_rect_shape","td_width_to_size_filter_ratio":0.9},{"td_allow_use_two_tracks":true,"td_curve_segcount":0,"td_height_ratio":1,"td_length_ratio":0.5,"td_maxheight":2,"td_maxlen":1,"td_on_pad_in_zone":false,"td_target_name":"td_track_end","td_width_to_size_filter_ratio":0.9}],"track_widths":[],"tuning_pattern_settings":{"diff_pair_defaults":{"corner_radius_percentage":80,"corner_style":1,"max_amplitude":1,"min_amplitude":0.2,"single_sided":false,"spacing":1},"diff_pair_skew_defaults":{"corner_radius_percentage":80,"corner_style":1,"max_amplitude":1,"min_amplitude":0.2,"single_sided":false,"spacing":0.6},"single_track_defaults":{"corner_radius_percentage":80,"corner_style":1,"max_amplitude":1,"min_amplitude":0.2,"single_sided":false,"spacing":0.6}},"via_dimensions":[],"zones_allow_external_fillets":false},"file":"__EVLEDA_FRESH_NAME__.kicad_pcb","ipc2581":{"bom_rev":"","dist":"","distpn":"","internal_id":"","mfg":"","mpn":"","sch_revision":""},"layer_pairs":[],"layer_presets":[],"viewports":[]},"boards":[],"component_class_settings":{"assignments":[],"meta":{"version":0},"sheet_component_classes":{"enabled":false}},"cvpcb":{"equivalence_files":[]},"libraries":{"pinned_footprint_libs":[],"pinned_symbol_libs":[]},"meta":{"filename":"__EVLEDA_FRESH_NAME__.kicad_pro","fixtureId":"evleda-fresh-kicad10","generatedBy":"evleda pcb-agent fresh project","version":3},"pcbnew":{"last_paths":{"idf":"","netlist":"","plot":"","specctra_dsn":"","vrml":""},"page_layout_descr_file":""},"schematic":{"bus_aliases":{},"file":"__EVLEDA_FRESH_NAME__.kicad_sch","legacy_lib_dir":"","legacy_lib_list":[],"top_level_sheets":[{"filename":"__EVLEDA_FRESH_NAME__.kicad_sch","name":"__EVLEDA_FRESH_NAME__","uuid":"00000000-0000-0000-0000-000000000000"}]},"sheets":[],"text_variables":{},"tuning_profiles":{"meta":{"version":0},"tuning_profiles_impedance_geometric":[]}}`;

const semanticJsonEqual = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);
const byName = <Value extends { readonly name: string }>(left: Value, right: Value): number => left.name.localeCompare(right.name, "en-US");

function parseStrictKicadProject(proText: string): Record<string, unknown> {
  try {
    return asRecord(parsePortableJsonBytes(Buffer.from(proText, "utf8"), {
      maxBytes: 16 * 1024 * 1024,
      maxDepth: 64,
      maxNodes: 500_000,
      maxArrayLength: 100_000,
      maxOwnKeys: 10_000,
      maxKeyBytes: 1_024,
      maxStringBytes: 1024 * 1024,
    }), "KiCad project file");
  } catch (error) {
    throw new Error("KiCad project file is not bounded duplicate-free strict UTF-8 JSON.", { cause: error });
  }
}

function assertGenericNonNetNormalization(candidate: Record<string, unknown>, name: string, numericProjection?: NativeNumericProjection): void {
  const nonNet = { ...candidate };
  delete nonNet.net_settings;
  const compact = overlayNativeNumericProjection(AUDITED_KICAD10_COMPACT_NON_NET_SETTINGS(name), numericProjection);
  const sparse = overlayNativeNumericProjection(AUDITED_GENERIC_SPARSE_NON_NET_SETTINGS(name), numericProjection);
  const expanded = overlayNativeNumericProjection(JSON.parse(AUDITED_KICAD10_EXPANDED_NON_NET_SETTINGS_JSON.replaceAll("__EVLEDA_FRESH_NAME__", name)) as Record<string, unknown>, numericProjection);
  if (!semanticJsonEqual(nonNet, sparse) && !semanticJsonEqual(nonNet, compact) && !semanticJsonEqual(nonNet, expanded)) {
    throw new Error("Generic KiCad project contains non-net-settings drift outside the closed KiCad 10 normalization allowlist.");
  }
}

function assertGenericKicad10OpenNormalization(
  proText: string,
  name: string,
  projectionInput: FreshProjectNetClassSemanticProjection,
  numericProjection?: NativeNumericProjection,
): void {
  const projectionResult = netClassProjectionSchema.safeParse(projectionInput);
  if (!projectionResult.success) throw new Error("Expected generic net-class semantic projection is not closed and valid.", { cause: projectionResult.error });
  const projection = projectionResult.data;
  const candidate = parseStrictKicadProject(proText);
  assertGenericNonNetNormalization(candidate, name, numericProjection);

  const net = asRecord(candidate.net_settings, "net_settings");
  const netKeys = ["classes", "meta", "net_colors", "netclass_assignments", "netclass_patterns"];
  if (Object.keys(net).sort().join("\0") !== netKeys.sort().join("\0")) throw new Error("Generic KiCad net_settings contains missing or unexpected fields.");
  if (!semanticJsonEqual(net.meta, { version: 5 })) throw new Error("Generic KiCad net_settings meta differs from the audited version-5 marker.");
  if (net.net_colors !== null) throw new Error("Generic KiCad project contains net colors.");
  assertExactContractNetClassPatterns(net.netclass_patterns, createExactContractNetClassPatterns(projection.contractNetAssignments));
  assertEmptyDerivedNetClassAssignments(net.netclass_assignments);

  if (!Array.isArray(net.classes) || net.classes.length !== projection.netClasses.length + 1) {
    throw new Error("Generic KiCad project must contain Default plus exactly the expected managed net classes.");
  }
  const defaultClasses: Record<string, unknown>[] = [];
  const managedClasses: FreshProjectManagedNetClass[] = [];
  const actualClassNames = new Set<string>();
  for (const [index, value] of net.classes.entries()) {
    const record = asRecord(value, `net class ${index + 1}`);
    const className = record.name;
    if (typeof className !== "string" || actualClassNames.has(className)) throw new Error("Generic KiCad net-class names are missing or duplicate.");
    actualClassNames.add(className);
    if (className === "Default") defaultClasses.push(record);
    else {
      if (!className.startsWith("EVLEDA_")) throw new Error("Generic KiCad project contains a non-managed custom net class.");
      const parsed = managedNetClassSchema.safeParse(record);
      if (!parsed.success) throw new Error("Generic KiCad project contains an unknown or malformed EVLEDA managed net class.", { cause: parsed.error });
      managedClasses.push(parsed.data);
    }
  }
  if (defaultClasses.length !== 1 || !semanticJsonEqual(defaultClasses[0], AUDITED_KICAD10_DEFAULT_NET_CLASS)) {
    throw new Error("Generic KiCad project default net class differs from the audited KiCad 10 default.");
  }
  if (!semanticJsonEqual([...managedClasses].sort(byName), [...projection.netClasses].sort(byName))) {
    throw new Error("Generic KiCad managed net-class values differ from the expected semantic projection.");
  }

}

async function assertGenericRuleSourcesRemainClosed(
  projectPath: string,
  name: string,
  pcbText: string,
): Promise<Readonly<{ readonly path: string; readonly capture: FreshRegularFileCapture | null }>> {
  if (/\(zone(?:\s|\))/u.test(pcbText)) throw new Error("Generic fresh PCB contains a copper zone before Open checkpoint approval.");
  if (/\(clearance(?:\s|\))/u.test(pcbText)) throw new Error("Generic fresh PCB contains a local copper-clearance override before Open checkpoint approval.");

  const rulesPath = path.join(projectPath, `${name}.kicad_dru`);
  let capture: FreshRegularFileCapture | null;
  try { capture = await captureOptionalFreshRegularFile(rulesPath); }
  catch (error) { throw new Error("Generic KiCad custom-rule source cannot be inspected.", { cause: error }); }
  if (capture === null) return Object.freeze({ path: rulesPath, capture: null });
  if (capture.bytes.byteLength === 0 || capture.bytes.byteLength > 4 * 1024 * 1024) {
    throw new Error("Generic KiCad custom-rule source must be absent or an ordinary empty version-1 deck.");
  }
  const contents = capture.bytes.toString("utf8");
  if (!/^\s*\(version\s+1\)\s*$/u.test(contents)) {
    throw new Error("Generic KiCad custom rules are unsupported; only an absent or empty version-1 deck is accepted.");
  }
  return Object.freeze({ path: rulesPath, capture });
}

export interface FreshProjectOpenNormalizationOptions {
  readonly outputDir: string;
  readonly name: string;
  readonly expectedNetClassProjection?: FreshProjectNetClassSemanticProjection;
  readonly expectedPreparedSourceAuthority?: FreshProjectOpenPreparedSourceAuthority;
  /** Synchronous aggregate-deadline/abort fence executed immediately before rename. */
  readonly assertCanCommit?: () => void;
  /** Deterministic race injection for unit tests; production callers omit it. */
  readonly testHooks?: Readonly<{ readonly beforeCheckpointCommit?: () => void | Promise<void> }>;
}

/** Legacy-only Open normalization. Plane projects require the explicit plane wrapper. */
export async function checkpointFreshProjectOpenNormalization(options: FreshProjectOpenNormalizationOptions): Promise<{ readonly changed: boolean; readonly checkpointPath: string }> {
  return checkpointFreshProjectOpenNormalizationForFamily(options);
}

export async function checkpointPlaneFreshProjectOpenNormalization(options: {
  readonly project: PlaneFreshProject;
  readonly placementSeed?: FreshPlanePlacementSeed;
  readonly expectedNetClassProjection: FreshProjectNetClassSemanticProjection;
  readonly expectedPreparedSourceAuthority: FreshProjectOpenPreparedSourceAuthority;
  readonly assertCanCommit?: FreshProjectOpenNormalizationOptions["assertCanCommit"];
  readonly testHooks?: FreshProjectOpenNormalizationOptions["testHooks"];
}): Promise<{ readonly changed: boolean; readonly checkpointPath: string }> {
  if (!isVerifiedPlaneFreshProject(options.project)) throw new Error("Plane Open normalization requires an authenticated plane fresh-project capability.");
  await options.project.assertMarkerCurrent();
  if (options.placementSeed !== undefined) {
    assertFreshPlanePlacementSeedPcb(options.placementSeed, options.project.outputPath, options.expectedPreparedSourceAuthority.pcb);
    assertFreshPlanePlacementSeedFile(options.placementSeed, options.project.outputPath, "pro", options.expectedPreparedSourceAuthority.pro);
  }
  return checkpointFreshProjectOpenNormalizationForFamily({
    outputDir: options.project.outputPath, name: options.project.name,
    expectedNetClassProjection: options.expectedNetClassProjection,
    expectedPreparedSourceAuthority: options.expectedPreparedSourceAuthority,
    ...(options.assertCanCommit === undefined ? {} : { assertCanCommit: options.assertCanCommit }),
    ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
  }, options.project.planeBinding, planeNumericProjections.get(options.project), options.placementSeed === undefined ? undefined : options.expectedPreparedSourceAuthority.pcb);
}

async function checkpointFreshProjectOpenNormalizationForFamily(
  options: FreshProjectOpenNormalizationOptions,
  expectedPlane?: PlaneFreshProjectBinding,
  numericProjection?: NativeNumericProjection,
  placementRevisionPcbIdentity?: ContentIdentity,
): Promise<{ readonly changed: boolean; readonly checkpointPath: string }> {
  const name = validateFreshProjectName(options.name);
  const outputPath = path.resolve(options.outputDir);
  const markerPath = path.join(outputPath, FRESH_PROJECT_MARKER_NAME);
  const checkpointPath = path.join(outputPath, FRESH_PROJECT_CHECKPOINT_NAME);
  const markerBefore = await captureFreshRegularFile(markerPath);
  const marker = await parseVerifiedMarker(markerPath, outputPath, name, false, expectedPlane, expectedPlane === undefined ? "any" : "plane");
  if (marker.schemaVersion === "evleda.pcb-agent-fresh-project.v3" && expectedPlane === undefined) {
    throw new Error("Plane fresh projects require explicit plane Open normalization; the legacy-only entrypoint cannot authorize them.");
  }
  const markerAfter = await captureFreshRegularFile(markerPath);
  if (!sameRegularFileCaptureIdentity(markerBefore, markerAfter)) throw new Error("Fresh-project marker changed while Open normalization authority was established.");
  const checkpoint = await verifyCheckpoint(marker, markerPath, checkpointPath, ["pro"]);
  const anchor = checkpoint?.files ?? marker.files;
  const currentSnapshot = await captureCurrentFiles(marker);
  const current = currentSnapshot.files;
  for (const key of fileKeysFor(marker).filter((key) => key !== "pro")) {
    if (freshFile(current, key).path !== freshFile(anchor, key).path || freshFile(current, key).sha256 !== freshFile(anchor, key).sha256) throw new Error(`Fresh-project ${key} differs from the latest checkpoint.`);
    if (marker.schemaVersion === "evleda.pcb-agent-fresh-project.v3" && freshFile(current, key).sha256 !== freshFile(marker.files, key).sha256) {
      throw new Error("Initial plane Open normalization requires the immutable empty marker baseline; authored checkpoints are not an initial prepared-source authority.");
    }
  }
  let customRulesSnapshot: FreshCheckpointPublicationSnapshot["customRules"] = null;
  let preparedSourceAuthority: FreshProjectOpenPreparedSourceAuthority | undefined;
  if (marker.schemaVersion === "evleda.pcb-agent-fresh-project.v2" || marker.schemaVersion === "evleda.pcb-agent-fresh-project.v3") {
    if (options.expectedPreparedSourceAuthority === undefined) throw new Error("Generic KiCad Open normalization requires lifecycle-owned prepared-source authority.");
    preparedSourceAuthority = parseFreshProjectOpenPreparedSourceAuthority(options.expectedPreparedSourceAuthority);
    const currentProjectIdentity = await readFreshDirectoryIdentity(marker.projectPath);
    if (!sameFreshDirectoryIdentity(preparedSourceAuthority.projectIdentity, marker.projectIdentity)
        || !sameFreshDirectoryIdentity(preparedSourceAuthority.projectIdentity, currentProjectIdentity)) {
      throw new Error("Generic KiCad project root differs from lifecycle-owned prepared-source authority.");
    }
    const actualIdentities = {
      sch: contentIdentity(currentSnapshot.captures.sch.bytes),
      pcb: contentIdentity(currentSnapshot.captures.pcb.bytes),
      sym: contentIdentity(currentSnapshot.captures.symLibTable.bytes),
      fp: contentIdentity(currentSnapshot.captures.fpLibTable.bytes),
      marker: contentIdentity(markerAfter.bytes),
    };
    for (const key of ["sch", "pcb", "sym", "fp", "marker"] as const) {
      if (!sameContentIdentity(actualIdentities[key], preparedSourceAuthority[key])) {
        throw new Error(`Generic KiCad ${key} differs from lifecycle-owned prepared-source authority.`);
      }
    }
    if (marker.schemaVersion === "evleda.pcb-agent-fresh-project.v3") {
      const pcbText = currentSnapshot.captures.pcb.bytes.toString("utf8");
      if (placementRevisionPcbIdentity !== undefined && !sameContentIdentity(placementRevisionPcbIdentity, contentIdentity(currentSnapshot.captures.pcb.bytes))) {
        throw new Error("Placement revision Open changed its exact qualified authored PCB.");
      }
      if (placementRevisionPcbIdentity === undefined && (/\(zone(?:\s|\))/u.test(pcbText) || /\(clearance(?:\s|\))/u.test(pcbText))) {
        throw new Error("Initial plane Open normalization cannot authorize authored zones or local copper-clearance overrides.");
      }
      const rulesCapture = freshCapture(currentSnapshot.captures, "dru");
      if (!sameContentIdentity(contentIdentity(rulesCapture.bytes), marker.planeBinding.expectedRulesContentIdentity)) {
        throw new Error("Initial plane Open rules differ from the exact bundle-generated rules.");
      }
      customRulesSnapshot = { path: marker.files.dru.path, capture: rulesCapture };
    } else {
      customRulesSnapshot = await assertGenericRuleSourcesRemainClosed(marker.projectPath, name, currentSnapshot.captures.pcb.bytes.toString("utf8"));
    }
    if (options.expectedNetClassProjection === undefined) throw new Error("Generic KiCad project normalization requires the expected net-class semantic projection.");
    if (placementRevisionPcbIdentity === undefined) {
      assertGenericKicad10OpenNormalization(currentSnapshot.captures.pro.bytes.toString("utf8"), name, options.expectedNetClassProjection, numericProjection);
    } else if (!sameContentIdentity(contentIdentity(currentSnapshot.captures.pro.bytes), preparedSourceAuthority.pro)) {
      throw new Error("Placement revision Open changed its exact qualified authored project settings.");
    }
  } else if (options.expectedPreparedSourceAuthority !== undefined) {
    throw new Error("LED compatibility Open normalization does not accept generic prepared-source authority.");
  }
  const genericAlreadyCheckpointed = (marker.schemaVersion === "evleda.pcb-agent-fresh-project.v2" || marker.schemaVersion === "evleda.pcb-agent-fresh-project.v3")
    && checkpoint !== undefined && current.pro.path === checkpoint.files.pro.path && current.pro.sha256 === checkpoint.files.pro.sha256;
  if (marker.schemaVersion === "evleda.pcb-agent-fresh-project.v2" || marker.schemaVersion === "evleda.pcb-agent-fresh-project.v3") {
    if (preparedSourceAuthority === undefined) throw new Error("Generic KiCad prepared-source authority was not established.");
    const currentProIdentity = contentIdentity(currentSnapshot.captures.pro.bytes);
    if (sameContentIdentity(currentProIdentity, preparedSourceAuthority.pro) || genericAlreadyCheckpointed) return { changed: false, checkpointPath };
  } else if (current.pro.sha256 === anchor.pro.sha256) return { changed: false, checkpointPath };
  if (marker.schemaVersion === "evleda.pcb-agent-fresh-project.v1") {
    if (options.expectedNetClassProjection !== undefined) throw new Error("LED compatibility Open normalization does not accept a generic net-class projection.");
    assertKicad10OpenNormalization(currentSnapshot.captures.pro.bytes.toString("utf8"), name);
  }
  const projectIdentity = await readFreshDirectoryIdentity(marker.projectPath);
  if (!sameFreshDirectoryIdentity(projectIdentity, marker.projectIdentity)) throw new Error("Fresh-project root identity changed during Open normalization validation.");
  const publicationSnapshot: FreshCheckpointPublicationSnapshot = Object.freeze({
    ...currentSnapshot,
    marker: markerAfter,
    projectIdentity,
    customRules: customRulesSnapshot,
  });
  const reportPath = path.join(outputPath, "pcb-agent-report.json");
  const report = JSON.parse(await readFile(reportPath, "utf8")) as { status?: unknown };
  const status = checkpointStatus.parse(report.status);
  await writeFreshCheckpoint(marker, markerPath, checkpointPath, reportPath, status, (checkpoint?.attempt ?? 0) + 1, "kicad_open_normalization", {
    snapshot: publicationSnapshot,
    ...(options.testHooks?.beforeCheckpointCommit === undefined ? {} : { beforeFinalRecheck: options.testHooks.beforeCheckpointCommit }),
  }, options.assertCanCommit === undefined ? undefined : { assertCanCommit: options.assertCanCommit });
  return { changed: true, checkpointPath };
}

/** Context for fresh runs only; the exact proof contract travels separately. */
export const FRESH_PROJECT_PROMPT_CONTEXT = "Fresh project workflow: author incrementally; inspect symbols/connectivity before edits; batch independent symbol/property/footprint calls; call sch_get_pin_positions before coordinate-derived work and never guess pin, label, or wire coordinates. After placing and spacing the contract components, call fresh_apply_contract_connectivity with an empty argument object; the host alone derives exact nets and no-connects from the bound task contract. If it returns applied=false with a nonempty recommendedMoves set, call fresh_apply_recommended_schematic_placement exactly once with only the returned recommendationIdentity. That host operation applies and verifies the complete move set atomically; never call sch_move_symbol for a pending recommendation, partially apply it, or substitute coordinates. Then call fresh_apply_contract_connectivity again. If no complete recommendation is present, do not guess. Then read connectivity after the schematic batch. Run full ERC/DRC/board review at phase boundaries. Never request whole-sheet replacement. Use the installed KiCad 10 stock tables through KICAD10 library variables. Sidecar reads may return BL_F_Cu/BL_B_Cu/BL_InN_Cu; writes use F_Cu/B_Cu/InN_Cu.";

export const FRESH_LED_ACCEPTANCE_REQUIREMENT_IDS = Object.freeze([
  "symbols", "schematic-nets", "no-connect", "pcb-sync-footprints", "outline", "j1-edge-orientation",
  "routed-connectivity", "trace-width", "track-turns", "vias", "gnd-zone", "erc", "drc", "visual-practice",
] as const);
export const freshLedAcceptanceRequirementIdSchema = z.enum(FRESH_LED_ACCEPTANCE_REQUIREMENT_IDS);

const endpointSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}:[A-Za-z0-9_.-]{1,16}$/u);
const acceptedStatusSchema = z.enum(["clean", "pass", "passed"]);
const unique = <Value>(values: readonly Value[]): boolean => new Set(values).size === values.length;

/** Validated source of truth consumed by prompt rendering and host acceptance. */
export const freshLedIndicatorContractSchema = z.object({
  schemaVersion: z.literal("evleda.fresh-led-indicator-contract.v1"),
  name: z.string().trim().min(1).max(64),
  purpose: z.string().trim().min(1).max(256),
  electrical: z.object({ supplyVolts: z.number().positive(), maximumTotalLoadMa: z.number().positive() }).strict(),
  board: z.object({
    layerCount: z.number().int().min(1).max(32), widthMm: z.number().positive(), heightMm: z.number().positive(),
    dimensionToleranceMm: z.number().nonnegative(), completeOutlineRequired: z.boolean(),
  }).strict(),
  components: z.array(z.object({
    reference: z.string().regex(/^[A-Z][A-Z0-9_-]{0,31}$/u), symbolId: z.string().trim().min(3).max(256),
    value: z.string().min(1).max(256), footprintId: z.string().trim().min(3).max(512),
  }).strict()).min(1).max(32),
  schematic: z.object({
    exactNets: z.array(z.object({ name: z.string().min(1).max(128), endpoints: z.array(endpointSchema).min(2).max(64) }).strict()).min(1).max(64),
    ledPolarity: z.object({
      reference: z.string().regex(/^[A-Z][A-Z0-9_-]{0,31}$/u), cathodePin: z.string().min(1).max(16), cathodeNet: z.string().min(1).max(128),
      anodePin: z.string().min(1).max(16), anodeNet: z.string().min(1).max(128),
    }).strict(),
    noConnectMarkers: z.number().int().nonnegative(),
  }).strict(),
  placement: z.object({
    allFootprintsOn: z.enum(["F.Cu", "B.Cu"]),
    connector: z.object({
      reference: z.string().regex(/^[A-Z][A-Z0-9_-]{0,31}$/u), edge: z.enum(["left", "top", "right", "bottom"]),
      bodyAndCourtyardInsideBoard: z.boolean(), maximumEdgeClearanceMm: z.number().nonnegative(),
      rotationDeg: z.number().int().min(0).max(359).refine((value) => value % 90 === 0, "rotationDeg must be a multiple of 90"),
      localMinusXFacesOutward: z.boolean(),
    }).strict(),
  }).strict(),
  routing: z.object({
    requiredLayer: z.enum(["F.Cu", "B.Cu"]), minimumWidthMm: z.number().positive(),
    maximumDirectionChangeDeg: z.number().min(0).max(180),
    forbidden: z.array(z.enum(["reversal", "duplicate-track", "overlap"])).max(3).refine(unique, "routing forbidden entries must be unique"),
    maximumViaCount: z.number().int().nonnegative(), everyExactNetMustBeRouted: z.boolean(),
    danglingTrackEndpoints: z.number().int().nonnegative(), completeCoverageRequired: z.boolean(),
    forbiddenGeometryDetection: z.object({
      reversalMaximumInteriorAngleDeg: z.number().min(0).max(90),
      hairpin: z.object({
        parallelToleranceDeg: z.number().min(0).max(90), maximumLegEdgeGapMm: z.number().nonnegative(),
        minimumParallelOverlapMm: z.number().nonnegative(), maximumConnectorPathLengthMm: z.number().nonnegative(),
      }).strict(),
    }).strict(),
  }).strict(),
  zones: z.object({
    ground: z.object({
      netName: z.string().min(1).max(128), policy: z.enum(["optional", "required", "forbidden"]),
      addOnlyIfSafe: z.boolean(), substitutesForRoutedConnectivity: z.boolean(),
    }).strict(),
  }).strict(),
  acceptance: z.object({
    authority: z.string().trim().min(1).max(512),
    mandatoryRows: z.array(freshLedAcceptanceRequirementIdSchema).min(1).max(FRESH_LED_ACCEPTANCE_REQUIREMENT_IDS.length).refine(unique, "mandatoryRows must be unique"),
    native: z.object({
      erc: z.object({ acceptedStatuses: z.array(acceptedStatusSchema).min(1).max(3).refine(unique), availableRequired: z.boolean(), maximumViolations: z.number().int().nonnegative() }).strict(),
      drc: z.object({
        acceptedStatuses: z.array(acceptedStatusSchema).min(1).max(3).refine(unique), availableRequired: z.boolean(),
        maximumViolations: z.number().int().nonnegative(), maximumUnconnectedItems: z.number().int().nonnegative(), maximumCourtyardIssues: z.number().int().nonnegative(),
      }).strict(),
      visualPractice: z.object({
        acceptedStatuses: z.array(acceptedStatusSchema).min(1).max(3).refine(unique),
        maximumFindings: z.number().int().nonnegative(), maximumBlockingPracticeFindings: z.number().int().nonnegative(),
      }).strict(),
    }).strict(),
    completedOnlyWhen: z.string().trim().min(1).max(256), unresolvedDisposition: z.literal("needs_review"),
    prohibitedClaimsAndOutputs: z.array(z.string().trim().min(1).max(128)).min(1).max(16),
  }).strict(),
}).strict().superRefine((contract, context) => {
  const references = contract.components.map((component) => component.reference);
  if (!unique(references)) context.addIssue({ code: "custom", path: ["components"], message: "component references must be unique" });
  if (!references.includes(contract.placement.connector.reference)) context.addIssue({ code: "custom", path: ["placement", "connector", "reference"], message: "connector reference must identify a component" });
  if (!references.includes(contract.schematic.ledPolarity.reference)) context.addIssue({ code: "custom", path: ["schematic", "ledPolarity", "reference"], message: "LED polarity reference must identify a component" });
  const netNames = contract.schematic.exactNets.map((net) => net.name);
  if (!unique(netNames)) context.addIssue({ code: "custom", path: ["schematic", "exactNets"], message: "net names must be unique" });
  const endpoints = contract.schematic.exactNets.flatMap((net) => net.endpoints);
  if (!unique(endpoints)) context.addIssue({ code: "custom", path: ["schematic", "exactNets"], message: "each endpoint must belong to exactly one net" });
  for (const endpoint of endpoints) {
    if (!references.includes(endpoint.split(":", 1)[0]!)) context.addIssue({ code: "custom", path: ["schematic", "exactNets"], message: `endpoint ${endpoint} references an unknown component` });
  }
  const polarity = contract.schematic.ledPolarity;
  for (const [pin, net, role] of [[polarity.cathodePin, polarity.cathodeNet, "cathode"], [polarity.anodePin, polarity.anodeNet, "anode"]] as const) {
    const expected = `${polarity.reference}:${pin}`;
    if (!contract.schematic.exactNets.some((candidate) => candidate.name === net && candidate.endpoints.includes(expected))) {
      context.addIssue({ code: "custom", path: ["schematic", "ledPolarity", `${role}Net`], message: `${role} endpoint must belong to its declared net` });
    }
  }
  if (!netNames.includes(contract.zones.ground.netName)) context.addIssue({ code: "custom", path: ["zones", "ground", "netName"], message: "ground-zone net must be one of the exact schematic nets" });
  const outwardEdgeByRotation = ["left", "top", "right", "bottom"] as const;
  if (contract.placement.connector.localMinusXFacesOutward && outwardEdgeByRotation[contract.placement.connector.rotationDeg / 90] !== contract.placement.connector.edge) {
    context.addIssue({ code: "custom", path: ["placement", "connector"], message: "connector edge and rotation disagree with local -X outward" });
  }
});

export type FreshLedIndicatorContract = z.infer<typeof freshLedIndicatorContractSchema>;

const deepFreeze = <Value>(value: Value): Value => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

export const parseFreshLedIndicatorContract = (value: unknown): FreshLedIndicatorContract => deepFreeze(freshLedIndicatorContractSchema.parse(value));

/**
 * Closed proof-board input shared with the host acceptance evaluator. It is not
 * a default design rule for arbitrary boards and it never authorizes release.
 */
export const LED_INDICATOR_EXAMPLE = parseFreshLedIndicatorContract({
  schemaVersion: "evleda.fresh-led-indicator-contract.v1",
  name: "led-indicator",
  purpose: "local proof-of-concept only",
  electrical: { supplyVolts: 5, maximumTotalLoadMa: 100 },
  board: { layerCount: 2, widthMm: 30, heightMm: 20, dimensionToleranceMm: 0.05, completeOutlineRequired: true },
  components: [
    { reference: "J1", symbolId: "Connector_Generic:Conn_01x02", value: "Conn_01x02", footprintId: "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical" },
    { reference: "R1", symbolId: "Device:R", value: "1k", footprintId: "Resistor_SMD:R_0603_1608Metric" },
    { reference: "D1", symbolId: "Device:LED", value: "LED", footprintId: "LED_SMD:LED_0603_1608Metric" },
    { reference: "C1", symbolId: "Device:C", value: "100nF", footprintId: "Capacitor_SMD:C_0603_1608Metric" },
  ],
  schematic: {
    exactNets: [
      { name: "+5V", endpoints: ["J1:1", "R1:1", "C1:1"] },
      { name: "LED_A", endpoints: ["R1:2", "D1:2"] },
      { name: "GND", endpoints: ["J1:2", "D1:1", "C1:2"] },
    ],
    ledPolarity: { reference: "D1", cathodePin: "1", cathodeNet: "GND", anodePin: "2", anodeNet: "LED_A" },
    noConnectMarkers: 0,
  },
  placement: {
    allFootprintsOn: "F.Cu",
    connector: { reference: "J1", edge: "left", bodyAndCourtyardInsideBoard: true, maximumEdgeClearanceMm: 1, rotationDeg: 0, localMinusXFacesOutward: true },
  },
  routing: {
    requiredLayer: "F.Cu", minimumWidthMm: 0.5, maximumDirectionChangeDeg: 45,
    forbidden: ["reversal", "duplicate-track", "overlap"], maximumViaCount: 0,
    everyExactNetMustBeRouted: true, danglingTrackEndpoints: 0, completeCoverageRequired: true,
    forbiddenGeometryDetection: {
      reversalMaximumInteriorAngleDeg: 0.01,
      hairpin: { parallelToleranceDeg: 0.01, maximumLegEdgeGapMm: 0.01, minimumParallelOverlapMm: 0.01, maximumConnectorPathLengthMm: 0.01 },
    },
  },
  zones: { ground: { netName: "GND", policy: "optional", addOnlyIfSafe: true, substitutesForRoutedConnectivity: false } },
  acceptance: {
    authority: "Host acceptance evaluator and native/readback evidence are authoritative; provider prose is not.",
    mandatoryRows: [
      "symbols", "schematic-nets", "no-connect", "pcb-sync-footprints", "outline", "j1-edge-orientation",
      "routed-connectivity", "trace-width", "track-turns", "vias", "erc", "drc", "visual-practice",
    ],
    native: {
      erc: { acceptedStatuses: ["clean", "pass", "passed"], availableRequired: true, maximumViolations: 0 },
      drc: { acceptedStatuses: ["clean", "pass", "passed"], availableRequired: true, maximumViolations: 0, maximumUnconnectedItems: 0, maximumCourtyardIssues: 0 },
      visualPractice: { acceptedStatuses: ["clean", "pass", "passed"], maximumFindings: 0, maximumBlockingPracticeFindings: 0 },
    },
    completedOnlyWhen: "every mandatory host row passes",
    unresolvedDisposition: "needs_review",
    prohibitedClaimsAndOutputs: ["manufacturing readiness", "release", "safety qualification", "manufacturing exports"],
  },
});

/** Exact generated contract; fail closed instead of truncating away a field. */
export const FRESH_LED_INDICATOR_PROVIDER_CONTRACT_MAX_BYTES = 6 * 1024;
export function renderFreshLedIndicatorProviderContract(contractInput: unknown = LED_INDICATOR_EXAMPLE): string {
  const contract = parseFreshLedIndicatorContract(contractInput);
  const rendered = [
    "FRESH_LED_INDICATOR_TASK_CONTRACT (closed; overrides omissions or shorthand such as LED_INDICATOR_EXAMPLE):",
    JSON.stringify(contract, null, 2),
  ].join("\n");
  if (Buffer.byteLength(rendered, "utf8") > FRESH_LED_INDICATOR_PROVIDER_CONTRACT_MAX_BYTES) {
    throw new Error(`Fresh LED indicator provider contract exceeds ${FRESH_LED_INDICATOR_PROVIDER_CONTRACT_MAX_BYTES} bytes; refusing to truncate it.`);
  }
  return rendered;
}

export const FRESH_LED_INDICATOR_PROVIDER_CONTRACT = renderFreshLedIndicatorProviderContract();
