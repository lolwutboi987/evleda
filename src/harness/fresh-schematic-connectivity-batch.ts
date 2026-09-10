import type { CallToolResult } from "@modelcontextprotocol/client";
import { z } from "zod";
import { canonicalJson, contentIdentity } from "../core/canonical.js";
import type { ContentIdentity } from "../domain/types.js";
import type { FreshPoint, FreshSchematicWire } from "./fresh-kicad-parser.js";
import { expectedFreshSchematicCompletePlanGeometry, FRESH_SCHEMATIC_COMPLETE_PLAN_NORMALIZATION_VERSION, type FreshSchematicWriterGeometry } from "./fresh-schematic-writer-geometry.js";
import { FreshSchematicWorkBudget } from "./fresh-schematic-work-budget.js";

export const FRESH_SCHEMATIC_BATCH_TOOL_NAME = "sch_apply_connectivity_batch_v1" as const;
export const FRESH_SCHEMATIC_BATCH_SCHEMA_VERSION = "evleda.kicad-schematic-connectivity-batch.v1" as const;
const kinds = ["wires", "global_labels", "no_connects", "junctions"] as const;
type Kind = typeof kinds[number];
const coordinate = z.number().finite().min(-2000).max(2000).refine((value) => Number(value.toFixed(4)) === value, "Must already use exact four-decimal coordinates");
const pointSchema = z.object({ x_mm: coordinate, y_mm: coordinate }).strict();
const wireSchema = z.object({ x1_mm: coordinate, y1_mm: coordinate, x2_mm: coordinate, y2_mm: coordinate }).strict();
const labelSchema = pointSchema.extend({ name: z.string().min(1).max(240), rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]), shape: z.literal("passive"), justify: z.enum(["left", "right", "top", "bottom", "left top", "left bottom", "right top", "right bottom", "none"]) }).strict();
const idSchema = z.object({ algorithm: z.literal("sha256"), digest: z.string().regex(/^[a-f0-9]{64}$/u), size: z.number().int().min(1).max(8 * 1024 * 1024) }).strict();
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u);
const countsSchema = z.object({ wires: z.number().int().min(0).max(4096), global_labels: z.number().int().min(0).max(4096), no_connects: z.number().int().min(0).max(4096), junctions: z.number().int().min(0).max(4096) }).strict();
const inventorySchema = z.object({
  wires: z.array(wireSchema.extend({ uuid }).strict()).max(4096),
  global_labels: z.array(labelSchema.extend({ uuid }).strict()).max(4096),
  no_connects: z.array(pointSchema.extend({ uuid }).strict()).max(4096),
  junctions: z.array(pointSchema.extend({ uuid }).strict()).max(4096),
}).strict();
const receiptSchema = z.object({
  schemaVersion: z.literal(FRESH_SCHEMATIC_BATCH_SCHEMA_VERSION),
  normalizationVersion: z.literal(FRESH_SCHEMATIC_COMPLETE_PLAN_NORMALIZATION_VERSION), applied: z.literal(true),
  projectFile: z.string().min(1).max(32768), schematicFile: z.string().min(1).max(32768), before: idSchema, after: idSchema,
  submittedCounts: countsSchema, appliedCounts: countsSchema, inventory: inventorySchema,
  operationReceipt: z.array(z.object({ kind: z.enum(kinds), index: z.number().int().min(0).max(4095), status: z.literal("applied"), resultingPrimitiveIndices: z.array(z.number().int().min(0).max(4095)).length(1) }).strict()).max(4096),
  reload: z.object({ status: z.literal("not_requested"), confirmed: z.literal(false) }).strict(),
}).strict();
export type FreshSchematicBatchReceipt = z.infer<typeof receiptSchema>;
export type FreshSchematicBatchLabel = z.infer<typeof labelSchema>;
type Wire = z.infer<typeof wireSchema>;
type Point = z.infer<typeof pointSchema>;

export interface FreshSchematicBatchRequest extends Readonly<Record<string, unknown>> {
  readonly normalization_version: typeof FRESH_SCHEMATIC_COMPLETE_PLAN_NORMALIZATION_VERSION;
  readonly project_file: string;
  readonly schematic_file: string;
  readonly expected_before_sha256: string;
  readonly expected_before_size_bytes: number;
  readonly wires: readonly Wire[];
  readonly global_labels: readonly FreshSchematicBatchLabel[];
  readonly no_connects: readonly Point[];
  readonly junctions: readonly Point[];
}
export interface FreshSchematicBatchPlan {
  readonly request: FreshSchematicBatchRequest;
  readonly expectedGeometry: FreshSchematicWriterGeometry;
  readonly expectedKeys: Readonly<Record<Kind, readonly string[]>>;
  readonly operationExpectedKeys: Readonly<Record<Kind, readonly string[]>>;
}
export interface FreshSchematicBatchSourceInventory {
  readonly wires: readonly Readonly<{ uuid: string; start: FreshPoint; end: FreshPoint }>[];
  readonly globalLabels: readonly Readonly<{ uuid: string; name: string; at: FreshPoint; rotationDeg: number; shape: string | null; justify: readonly string[] | null }>[];
  readonly noConnects: readonly Readonly<{ uuid: string; at: FreshPoint }>[];
  readonly junctions: readonly Readonly<{ uuid: string; at: FreshPoint }>[];
  readonly unrelatedChildrenIdentity: ContentIdentity;
}
const freeze = <Value>(value: Value): Value => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
};
const pointOrder = (left: FreshPoint, right: FreshPoint): number => left.x - right.x || left.y - right.y;
const wireKey = (wire: Wire): string => canonicalJson([{ x: wire.x1_mm, y: wire.y1_mm }, { x: wire.x2_mm, y: wire.y2_mm }].sort(pointOrder));
const primitiveKey = (kind: Kind, item: Wire | Point | FreshSchematicBatchLabel): string => {
  if (kind === "wires") return wireKey(item as Wire);
  const point = item as Point;
  return kind === "global_labels" ? canonicalJson({ x_mm: point.x_mm, y_mm: point.y_mm, name: (item as FreshSchematicBatchLabel).name,
    rotation: (item as FreshSchematicBatchLabel).rotation, shape: (item as FreshSchematicBatchLabel).shape, justify: (item as FreshSchematicBatchLabel).justify })
    : canonicalJson({ x_mm: point.x_mm, y_mm: point.y_mm });
};
const asWire = (wire: FreshSchematicWire): Wire => ({ x1_mm: wire.start.x, y1_mm: wire.start.y, x2_mm: wire.end.x, y2_mm: wire.end.y });
const counts = (inventory: Readonly<Record<Kind, readonly unknown[]>>) => Object.fromEntries(kinds.map((kind) => [kind, inventory[kind].length]));
const containsWire = (outer: Wire, inner: Wire): boolean => {
  if (outer.x1_mm === outer.x2_mm) return inner.x1_mm === inner.x2_mm && inner.x1_mm === outer.x1_mm
    && Math.min(inner.y1_mm, inner.y2_mm) >= Math.min(outer.y1_mm, outer.y2_mm) && Math.max(inner.y1_mm, inner.y2_mm) <= Math.max(outer.y1_mm, outer.y2_mm);
  return inner.y1_mm === inner.y2_mm && inner.y1_mm === outer.y1_mm
    && Math.min(inner.x1_mm, inner.x2_mm) >= Math.min(outer.x1_mm, outer.x2_mm) && Math.max(inner.x1_mm, inner.x2_mm) <= Math.max(outer.x1_mm, outer.x2_mm);
};

/** Host-only request construction. Paths and source bytes still require the private session's independent authority check. */
export function prepareFreshSchematicConnectivityBatch(input: {
  readonly projectFile: string; readonly schematicFile: string; readonly beforeSource: string;
  readonly wires: readonly FreshSchematicWire[]; readonly labels: readonly FreshSchematicBatchLabel[]; readonly noConnects: readonly FreshPoint[];
}, budget = new FreshSchematicWorkBudget()) {
  const normalized = expectedFreshSchematicCompletePlanGeometry(input.wires, budget);
  if (normalized.status !== "complete") return normalized;
  const before = contentIdentity(input.beforeSource);
  idSchema.parse(before);
  const rawWires = input.wires.map(asWire);
  const globalLabels = input.labels.map((label) => labelSchema.parse(label));
  const noConnects = input.noConnects.map((point) => pointSchema.parse({ x_mm: point.x, y_mm: point.y }));
  const junctions = normalized.value.junctions.map((point) => ({ x_mm: point.x, y_mm: point.y }));
  const request: FreshSchematicBatchRequest = { normalization_version: FRESH_SCHEMATIC_COMPLETE_PLAN_NORMALIZATION_VERSION,
    project_file: input.projectFile, schematic_file: input.schematicFile, expected_before_sha256: before.digest, expected_before_size_bytes: before.size,
    wires: rawWires, global_labels: globalLabels, no_connects: noConnects, junctions };
  const total = kinds.reduce((sum, kind) => sum + request[kind].length, 0);
  if (total < 1 || total > 4096) throw new Error("Complete batch must contain 1-4096 total primitives; no partial request is allowed.");
  const resulting = { wires: normalized.value.wires.map(asWire), global_labels: globalLabels, no_connects: noConnects, junctions };
  const expectedKeys = Object.fromEntries(kinds.map((kind) => [kind, resulting[kind].map((item) => primitiveKey(kind, item))])) as Record<Kind, string[]>;
  const operationExpectedKeys: Record<Kind, string[]> = { wires: [], global_labels: [...expectedKeys.global_labels], no_connects: [...expectedKeys.no_connects], junctions: [...expectedKeys.junctions] };
  for (const wire of rawWires) {
    const matches: string[] = [];
    for (const candidate of resulting.wires) {
      if (!budget.charge("route")) return Object.freeze({ status: "exhausted" as const, work: budget.snapshot() });
      if (containsWire(candidate, wire)) matches.push(wireKey(candidate));
    }
    if (matches.length !== 1) throw new Error("Submitted batch wire does not map to exactly one normalized complete-plan segment.");
    operationExpectedKeys.wires.push(matches[0]!);
  }
  for (const kind of kinds) if (new Set(expectedKeys[kind]).size !== expectedKeys[kind].length) throw new Error(`Complete batch contains duplicate ${kind} primitives.`);
  return freeze({ status: "complete" as const, value: { request, expectedGeometry: normalized.value, expectedKeys, operationExpectedKeys } satisfies FreshSchematicBatchPlan, work: budget.snapshot() });
}

/** Compare actual source UUID associations, raw-byte identities and every operation receipt; counts alone never establish success. */
export function validateFreshSchematicConnectivityBatchReceipt(input: {
  readonly result: CallToolResult; readonly plan: FreshSchematicBatchPlan;
  readonly beforeSource: Uint8Array; readonly afterSource: Uint8Array;
  readonly beforeInventory: FreshSchematicBatchSourceInventory; readonly afterInventory: FreshSchematicBatchSourceInventory;
}): FreshSchematicBatchReceipt {
  const { result, plan } = input;
  if (result.isError === true || result.content.length !== 1 || result.content[0]!.type !== "text" || result.structuredContent === undefined) throw new Error("Batch did not return its exact successful structured/text receipt envelope.");
  const text = result.content[0]!.text;
  if (Buffer.byteLength(text, "utf8") > 1024 * 1024) throw new Error("Batch receipt text exceeds its private envelope budget.");
  const receipt = receiptSchema.parse(result.structuredContent);
  if (canonicalJson(JSON.parse(text)) !== canonicalJson(receipt)) throw new Error("Batch receipt text and structured payload contradict each other.");
  if (receipt.projectFile !== plan.request.project_file || receipt.schematicFile !== plan.request.schematic_file
      || canonicalJson(receipt.before) !== canonicalJson(contentIdentity(input.beforeSource))
      || receipt.before.digest !== plan.request.expected_before_sha256 || receipt.before.size !== plan.request.expected_before_size_bytes
      || canonicalJson(receipt.after) !== canonicalJson(contentIdentity(input.afterSource))) throw new Error("Batch receipt paths or exact before/after source identities disagree with the host capture.");
  if (canonicalJson(input.beforeInventory.unrelatedChildrenIdentity) !== canonicalJson(input.afterInventory.unrelatedChildrenIdentity)) throw new Error("Batch changed, inserted, removed or reordered unrelated schematic child content.");
  if (input.beforeInventory.wires.length || input.beforeInventory.globalLabels.length || input.beforeInventory.noConnects.length || input.beforeInventory.junctions.length) throw new Error("Batch source baseline was not pristine.");
  const sourceInventory = {
    wires: input.afterInventory.wires.map((wire) => ({ ...asWire(wire), uuid: wire.uuid })),
    global_labels: input.afterInventory.globalLabels.map((label) => ({ x_mm: label.at.x, y_mm: label.at.y, name: label.name, rotation: label.rotationDeg,
      shape: label.shape, justify: label.justify?.join(" ") ?? "none", uuid: label.uuid })),
    no_connects: input.afterInventory.noConnects.map((point) => ({ x_mm: point.at.x, y_mm: point.at.y, uuid: point.uuid })),
    junctions: input.afterInventory.junctions.map((point) => ({ x_mm: point.at.x, y_mm: point.at.y, uuid: point.uuid })),
  };
  const actual = inventorySchema.parse(sourceInventory);
  const allUuids = kinds.flatMap((kind) => actual[kind].map((item) => item.uuid));
  if (new Set(allUuids).size !== allUuids.length) throw new Error("Actual batch primitives contain duplicate UUIDs.");
  if (canonicalJson(receipt.submittedCounts) !== canonicalJson(counts(plan.request)) || canonicalJson(receipt.appliedCounts) !== canonicalJson(counts(actual))) throw new Error("Batch count receipt differs from submitted plan or actual source primitives.");
  for (const kind of kinds) {
    const sourceKeys = actual[kind].map((item) => primitiveKey(kind, item));
    if (canonicalJson([...sourceKeys].sort()) !== canonicalJson([...plan.expectedKeys[kind]].sort())) throw new Error(`Actual ${kind} geometry does not equal the host's versioned complete plan.`);
    const sourcePairs = actual[kind].map((item) => canonicalJson([item.uuid, primitiveKey(kind, item)])).sort();
    const receiptPairs = receipt.inventory[kind].map((item) => canonicalJson([item.uuid, primitiveKey(kind, item)])).sort();
    if (canonicalJson(sourcePairs) !== canonicalJson(receiptPairs)) throw new Error(`Batch ${kind} receipt has wrong UUID-to-kind/geometry associations.`);
  }
  const seen = new Set<string>();
  for (const operation of receipt.operationReceipt) {
    const key = `${operation.kind}:${operation.index}`;
    const expected = plan.operationExpectedKeys[operation.kind][operation.index];
    const resulting = receipt.inventory[operation.kind][operation.resultingPrimitiveIndices[0]!];
    if (seen.has(key) || expected === undefined || resulting === undefined || primitiveKey(operation.kind, resulting) !== expected) throw new Error("Batch operation receipt omits, duplicates or misroutes a submitted primitive.");
    seen.add(key);
  }
  if (seen.size !== kinds.reduce((sum, kind) => sum + plan.request[kind].length, 0)) throw new Error("Batch operation receipt is incomplete.");
  return freeze(receipt);
}
