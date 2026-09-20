import { freshBoardComparisonText, freshBoardSerializationsEqual } from "./fresh-board-serialization.js";
import { parseFreshPcbSourceDocument, type FreshKicadSourceAtom as Atom, type FreshKicadSourceNode as Node } from "./fresh-kicad-parser.js";
import type { FreshFootprintPlacementPlan, FreshFootprintPose } from "./fresh-footprint-placement.js";
import { FRESH_PCB_RESOURCE_LIMITS } from "./fresh-resource-limits.js";

export const FRESH_FOOTPRINT_FIELD_TOOL = "fresh_set_footprint_fields" as const;
export const FRESH_FOOTPRINT_FIELD_UPDATE_SCHEMA = Object.freeze({ type: "object", additionalProperties: false,
  properties: {
    reference: { type: "string", minLength: 1, maxLength: 32, pattern: "^[A-Z][A-Z0-9_-]{0,31}$" },
    field: { type: "string", enum: ["Reference", "Value"] },
    x_mm: { type: "number", minimum: 0, maximum: 2000 }, y_mm: { type: "number", minimum: 0, maximum: 2000 },
    rotation_deg: { type: "number", enum: [0, 90, 180, 270] }, visible: { type: "boolean" },
    size_mm: { type: "number", minimum: 0.8, maximum: 3 }, thickness_mm: { type: "number", minimum: 0.08, maximum: 0.5 },
    layer: { type: "string", enum: ["F.SilkS", "F.Fab"] },
  }, required: ["reference", "field"],
  anyOf: ["x_mm", "rotation_deg", "visible", "size_mm", "thickness_mm", "layer"].map(key => ({ required: [key] })),
});
export const FRESH_FOOTPRINT_FIELD_SCHEMA = Object.freeze({ type: "object", additionalProperties: false,
  properties: { updates: { type: "array", minItems: 1, maxItems: 128, items: FRESH_FOOTPRINT_FIELD_UPDATE_SCHEMA } }, required: ["updates"] });

export interface FreshFootprintFieldRequest {
  readonly reference: string; readonly field: "Reference" | "Value";
  /** Absolute board coordinates; field angles are absolute native text angles. */
  readonly x_mm?: number; readonly y_mm?: number; readonly rotation_deg?: 0 | 90 | 180 | 270;
  readonly visible?: boolean; readonly size_mm?: number; readonly thickness_mm?: number; readonly layer?: "F.SilkS" | "F.Fab";
}
export interface FreshFootprintFieldPresentation extends FreshFootprintPose {
  readonly visible: boolean; readonly layer: "F.SilkS" | "F.Fab";
  readonly sizeMm: Readonly<{ x: number; y: number }>; readonly thicknessMm: number;
}
export interface FreshFootprintFieldPlan extends FreshFootprintPlacementPlan {
  readonly field: "Reference" | "Value"; readonly fieldId: string; readonly fieldText: string;
  readonly beforeField: FreshFootprintFieldPresentation; readonly afterField: FreshFootprintFieldPresentation;
}
export interface FreshFootprintFieldsPlan {
  readonly source: string; readonly changed: boolean;
  readonly updates: readonly Readonly<{ request: FreshFootprintFieldRequest; reference: string; footprintId: string; footprintPose: FreshFootprintPose;
    field: "Reference" | "Value"; fieldId: string; fieldText: string; changed: boolean;
    beforeField: FreshFootprintFieldPresentation; afterField: FreshFootprintFieldPresentation }>[];
}
function need(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Unsupported preserving footprint field: ${message}`);
}
function quantity(value: string, places: number, limit: number): number {
  need(value.length < 128, "numeric token exceeds its bound.");
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/u.exec(value);
  need(match !== null && (match[2]!.length > 0 || (match[3]?.length ?? 0) > 0), "invalid numeric token.");
  const exponent = Number(match[4] ?? 0), power = places + exponent - (match[3]?.length ?? 0);
  need(Number.isSafeInteger(exponent) && Math.abs(exponent) <= 100, "numeric exponent exceeds its bound.");
  let result = BigInt(match[2]! + (match[3] ?? "") || "0");
  if (power >= 0) result *= 10n ** BigInt(power);
  else { const divisor = 10n ** BigInt(-power); need(result % divisor === 0n, "quantity is not exact native units."); result /= divisor; }
  if (match[1] === "-") result = -result;
  need(result >= -BigInt(limit) && result <= BigInt(limit), "quantity exceeds its bound.");
  return Number(result);
}
const nm = (value: number | Atom): number => {
  need(typeof value === "number" ? Number.isFinite(value) : !value.quoted, "finite unquoted coordinates are required.");
  return quantity(typeof value === "number" ? String(value) : value.value, 6, 2_000_000_000);
};
function angle(value: Atom | undefined): number {
  if (value === undefined) return 0;
  need(!value.quoted, "quoted text angle is unsupported.");
  const degrees = quantity(value.value, 0, 360); need(degrees % 90 === 0, "only cardinal angles are supported.");
  return (degrees + 360) % 360;
}
const mm = (value: number): string => {
  const digits = Math.abs(value).toString().padStart(7, "0"), fraction = digits.slice(-6).replace(/0+$/u, "");
  return `${value < 0 ? "-" : ""}${digits.slice(0, -6)}${fraction ? `.${fraction}` : ""}`;
};
const named = (node: Node, name: string): readonly Node[] => node.children.filter(child => child.name === name);
function one(node: Node, name: string, optional = false): Node | undefined {
  const values = named(node, name); need(values.length === 1 || optional && values.length === 0, `missing or duplicate ${node.name}/${name}.`); return values[0];
}
function scalar(node: Node): Atom { need(node.values.length === 1 && node.children.length === 0, `malformed ${node.name} scalar.`); return node.values[0]!; }
function uuid(node: Node): string {
  const values = node.children.filter(child => child.name === "uuid" || child.name === "tstamp");
  need(values.length === 1, `${node.name} requires one stable UUID.`);
  const value = scalar(values[0]!).value;
  need(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value), "malformed UUID."); return value;
}
function at(node: Node) {
  const value = one(node, "at")!;
  const unlocked = value.values.at(-1)?.value === "unlocked" && !value.values.at(-1)!.quoted;
  const tokens = unlocked ? value.values.slice(0, -1) : value.values;
  need(value.children.length === 0 && [2, 3].includes(tokens.length), "malformed field/footprint position.");
  return { node: value, tokens, x: nm(tokens[0]!), y: nm(tokens[1]!), rotation: angle(tokens[2]) };
}
function world(x: number, y: number, root: ReturnType<typeof at>) {
  const offset = root.rotation === 0 ? [x, y] : root.rotation === 90 ? [y, -x] : root.rotation === 180 ? [-x, -y] : [-y, x];
  return { x: root.x + offset[0]!, y: root.y + offset[1]! };
}

export function parseFreshFootprintFieldRequest(value: Readonly<Record<string, unknown>>): FreshFootprintFieldRequest {
  need(Object.keys(value).every(key => Object.hasOwn(FRESH_FOOTPRINT_FIELD_UPDATE_SCHEMA.properties, key))
    && typeof value.reference === "string" && /^[A-Z][A-Z0-9_-]{0,31}$/u.test(value.reference)
    && ["Reference", "Value"].includes(value.field as string), "request must select one exact reference and Reference/Value field.");
  need(Object.keys(value).some(key => !["reference", "field"].includes(key)), "request requires a presentation change.");
  need((value.x_mm === undefined) === (value.y_mm === undefined), "board x/y coordinates must be supplied together.");
  for (const key of ["x_mm", "y_mm", "size_mm", "thickness_mm"] as const) if (value[key] !== undefined) {
    need(typeof value[key] === "number", `${key} must be a number.`); nm(value[key]);
    const minimum = key === "size_mm" ? 0.8 : key === "thickness_mm" ? 0.08 : 0;
    const maximum = key === "size_mm" ? 3 : key === "thickness_mm" ? 0.5 : 2000;
    need(value[key] >= minimum && value[key] <= maximum, `${key} violates its presentation bound.`);
  }
  need(value.rotation_deg === undefined || [0, 90, 180, 270].includes(value.rotation_deg as number), "field angle must be cardinal.");
  need(value.visible === undefined || typeof value.visible === "boolean", "visibility must be boolean.");
  need(value.layer === undefined || ["F.SilkS", "F.Fab"].includes(value.layer as string), "field layer must be F.SilkS or F.Fab.");
  return Object.freeze({ ...value }) as unknown as FreshFootprintFieldRequest;
}

/** Edit only selected presentation tokens; every other source byte is retained. */
export function planFreshFootprintField(source: string, input: FreshFootprintFieldRequest): FreshFootprintFieldPlan {
  const request = parseFreshFootprintFieldRequest(input as unknown as Readonly<Record<string, unknown>>);
  need(source.isWellFormed() && Buffer.byteLength(source, "utf8") <= FRESH_PCB_RESOURCE_LIMITS.maximumLiveSourceBytes,
    "source must be bounded well-formed text.");
  freshBoardComparisonText(source);
  const board = parseFreshPcbSourceDocument(source);
  const matches = named(board, "footprint").filter(fp => named(fp, "property").some(prop => prop.values[0]?.value === "Reference" && prop.values[1]?.value === request.reference));
  need(matches.length === 1, "reference must select exactly one footprint.");
  const footprint = matches[0]!, footprintId = uuid(footprint), pose = at(footprint);
  need(footprint.values.length === 1 && footprint.values[0]!.quoted && scalar(one(footprint, "layer")!).value === "F.Cu", "only an exact front footprint is supported.");
  const propertyNames = named(footprint, "property").map(prop => prop.values[0]?.value);
  need(new Set(propertyNames).size === propertyNames.length, "duplicate footprint properties.");
  need(!named(footprint, "fp_text").some(text => ["reference", "value"].includes(text.values[0]?.value ?? "")), "mixed legacy Reference/Value representations are unsupported.");
  const fields = named(footprint, "property").filter(prop => prop.values[0]?.value === request.field);
  need(fields.length === 1, "selected field is missing or ambiguous.");
  const field = fields[0]!, fieldId = uuid(field), position = at(field);
  need(field.values.length === 2 && field.values.every(token => token.quoted), "field identity/text must remain literal quoted source.");
  need(field.children.every(child => ["at", "layer", "uuid", "tstamp", "effects", "hide", "unlocked", "locked", "show_name"].includes(child.name))
    && new Set(field.children.map(child => child.name)).size === field.children.length, "unsupported or duplicate field presentation metadata.");
  const layer = one(field, "layer")!, currentLayer = scalar(layer).value;
  need(["F.SilkS", "F.Fab"].includes(currentLayer), "selected field is not on an admitted front presentation layer.");
  const effects = one(field, "effects")!, font = one(effects, "font")!, size = one(font, "size")!, thickness = one(font, "thickness")!;
  need(effects.values.length === 0 && effects.children.every(child => ["font", "justify"].includes(child.name))
    && new Set(effects.children.map(child => child.name)).size === effects.children.length, "unsupported field effects.");
  need(font.values.length === 0 && font.children.every(child => ["size", "thickness", "bold", "italic", "line_spacing"].includes(child.name))
    && new Set(font.children.map(child => child.name)).size === font.children.length, "unsupported or duplicate font metadata.");
  need(size.children.length === 0 && size.values.length === 2, "malformed field size.");
  const width = nm(size.values[0]!), height = nm(size.values[1]!), weight = nm(scalar(thickness));
  need(width > 0 && height > 0 && weight > 0, "field font dimensions must be positive.");
  const hide = one(field, "hide", true);
  need(hide === undefined || !scalar(hide).quoted && ["yes", "no"].includes(scalar(hide).value), "unsupported field visibility metadata.");
  const visible = hide === undefined || scalar(hide).value === "no", requestedVisible = request.visible ?? visible;
  const targetSize = request.size_mm === undefined ? undefined : nm(request.size_mm), targetThickness = request.thickness_mm === undefined ? weight : nm(request.thickness_mm);
  need(!requestedVisible || (targetSize ?? width) >= 800_000 && (targetSize ?? height) >= 800_000 && targetThickness >= 80_000, "visible fields require at least 0.8 mm size and 0.08 mm thickness.");
  const originalWorld = world(position.x, position.y, pose);
  const requestedWorld = request.x_mm === undefined ? originalWorld : { x: nm(request.x_mm), y: nm(request.y_mm!) };
  const dx = requestedWorld.x - pose.x, dy = requestedWorld.y - pose.y;
  const local = pose.rotation === 0 ? [dx, dy] : pose.rotation === 90 ? [-dy, dx] : pose.rotation === 180 ? [-dx, -dy] : [dy, -dx];
  const edits: { start: number; end: number; text: string }[] = [];
  const change = (token: Atom, text: string) => edits.push({ start: token.start, end: token.end, text });
  if (position.x !== local[0]) change(position.tokens[0]!, mm(local[0]!));
  if (position.y !== local[1]) change(position.tokens[1]!, mm(local[1]!));
  if (request.rotation_deg !== undefined && position.rotation !== request.rotation_deg) {
    if (position.tokens[2] !== undefined) change(position.tokens[2], String(request.rotation_deg));
    else edits.push({ start: position.tokens[1]!.end, end: position.tokens[1]!.end, text: ` ${request.rotation_deg}` });
  }
  if (targetSize !== undefined) for (const token of size.values) if (nm(token) !== targetSize) change(token, mm(targetSize));
  if (weight !== targetThickness) change(scalar(thickness), mm(targetThickness));
  if (request.layer !== undefined && request.layer !== currentLayer) change(scalar(layer), `"${request.layer}"`);
  if (visible !== requestedVisible) {
    if (requestedVisible) edits.push({ start: hide!.start, end: hide!.end, text: "" });
    else if (hide !== undefined) change(scalar(hide), "yes");
    // KiCad 10 serializes field visibility immediately after its layer.
    else edits.push({ start: layer.end, end: layer.end, text: " (hide yes)" });
  }
  edits.sort((a, b) => a.start - b.start);
  let cursor = 0; const parts: string[] = [];
  for (const edit of edits) { need(edit.start >= cursor && edit.start >= field.start && edit.end < field.end, "presentation edit escapes its selected field."); parts.push(source.slice(cursor, edit.start), edit.text); cursor = edit.end; }
  parts.push(source.slice(cursor));
  const plannedSource = parts.join("");
  need(Buffer.byteLength(plannedSource, "utf8") <= FRESH_PCB_RESOURCE_LIMITS.maximumLiveSourceBytes,
    "planned source exceeds the live board byte bound.");
  const rootPose = Object.freeze({ xMm: pose.x / 1e6, yMm: pose.y / 1e6, rotationDeg: pose.rotation });
  const beforeField = Object.freeze({ xMm: originalWorld.x / 1e6, yMm: originalWorld.y / 1e6, rotationDeg: position.rotation, visible,
    layer: currentLayer as "F.SilkS" | "F.Fab", sizeMm: Object.freeze({ x: width / 1e6, y: height / 1e6 }), thicknessMm: weight / 1e6 });
  return Object.freeze({ source: plannedSource, changed: edits.length > 0, reference: request.reference, footprintId, before: rootPose, after: rootPose,
    field: request.field, fieldId, fieldText: field.values[1]!.value, beforeField,
    afterField: Object.freeze({ xMm: requestedWorld.x / 1e6, yMm: requestedWorld.y / 1e6, rotationDeg: request.rotation_deg ?? position.rotation,
      visible: requestedVisible, layer: request.layer ?? beforeField.layer, sizeMm: Object.freeze({ x: (targetSize ?? width) / 1e6, y: (targetSize ?? height) / 1e6 }), thicknessMm: targetThickness / 1e6 }) });
}

export function assertOnlyRequestedFootprintFieldChanged(before: string, after: string, request: FreshFootprintFieldRequest): void {
  const planned = planFreshFootprintField(before, request);
  need(freshBoardSerializationsEqual(planned.source, after), "native readback differs from the exact preserving field plan.");
}

export function parseFreshFootprintFieldUpdates(value: Readonly<Record<string, unknown>>): readonly FreshFootprintFieldRequest[] {
  need(Object.keys(value).length === 1 && Array.isArray(value.updates) && value.updates.length >= 1 && value.updates.length <= 128,
    "updates must contain 1 through 128 field edits.");
  const updates = value.updates.map(entry => {
    need(entry !== null && typeof entry === "object" && !Array.isArray(entry), "each update must be one closed object.");
    return parseFreshFootprintFieldRequest(entry as Readonly<Record<string, unknown>>);
  });
  need(new Set(updates.map(update => `${update.reference}:${update.field}`)).size === updates.length, "duplicate reference/field updates are not allowed.");
  return Object.freeze(updates);
}

/** The complete list is planned in memory before any owned source is staged. */
export function planFreshFootprintFields(source: string, value: Readonly<Record<string, unknown>>): FreshFootprintFieldsPlan {
  const requests = parseFreshFootprintFieldUpdates(value);
  let planned = source;
  const updates = requests.map(request => {
    const plan = planFreshFootprintField(planned, request); planned = plan.source;
    return Object.freeze({ request, reference: plan.reference, footprintId: plan.footprintId, footprintPose: plan.before,
      field: plan.field, fieldId: plan.fieldId, fieldText: plan.fieldText, changed: plan.changed, beforeField: plan.beforeField, afterField: plan.afterField });
  });
  return Object.freeze({ source: planned, changed: planned !== source, updates: Object.freeze(updates) });
}

export function assertOnlyRequestedFootprintFieldsChanged(before: string, after: string, value: Readonly<Record<string, unknown>>): void {
  need(freshBoardSerializationsEqual(planFreshFootprintFields(before, value).source, after), "native readback differs from the complete atomic field plan.");
}
