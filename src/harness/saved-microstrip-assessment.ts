import { z } from "zod";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import type { ContentIdentity } from "../domain/types.js";
import { isKicadTransmissionLineCalculator, type KicadTransmissionLineCalculator,
  type KicadTransmissionLineModelWarning, type KicadTransmissionLineResult } from "../integrations/kicad-transmission-line.js";
import { parseFreshPcbReferenceGeometry, parseFreshPcbRouteSourceSpans, parseFreshPcbSource, parseFreshPcbStackup,
  type FreshPcbReferenceGeometry, type FreshPcbStackup, type FreshReferencePointNm, type FreshReferenceSegment,
  type FreshStackupField } from "./fresh-kicad-parser.js";

const positive = z.number().finite().positive();
const nonnegative = z.number().finite().nonnegative();
const text = z.string().trim().min(1).max(1024);
const copperLayer = z.string().regex(/^(?:F|B|In(?:[1-9]|[12][0-9]|30))\.Cu$/u);
const terminal = z.object({ reference: z.string().min(1).max(128), pad: z.string().min(1).max(128) }).strict();
export const savedMicrostripRequestSchema = z.object({
  expectedSourceIdentity: z.object({ algorithm: z.literal("sha256"), digest: z.string().regex(/^[a-f0-9]{64}$/u),
    size: z.number().int().positive().max(64 * 1024 * 1024) }).strict(),
  net: z.string().min(1).max(128), signalLayer: z.enum(["F.Cu", "B.Cu"]),
  reference: z.object({ net: z.string().min(1).max(128), layer: copperLayer, zoneUuid: z.string().uuid() }).strict(),
  terminals: z.tuple([terminal, terminal]), targetOhm: positive, absoluteToleranceOhm: nonnegative, frequencyHz: positive,
  construction: z.object({ topCover: z.literal("absent"), surface: z.literal("bare"),
    dielectric: z.object({ material: text, epsilonR: z.number().finite().min(1), lossTangent: nonnegative,
      frequencyHz: positive, evidence: text }).strict(),
    conductor: z.object({ conductivitySiemensPerMetre: positive, relativePermeability: positive,
      roughnessNm: z.number().int().min(0).max(2_000_000_000), evidence: text }).strict(),
    substrateRelativePermeability: positive, evidence: text,
  }).strict(),
}).strict().superRefine((request, ctx) => {
  if (request.reference.layer === request.signalLayer || request.reference.net === request.net)
    ctx.addIssue({ code: "custom", message: "A distinct reference net and copper layer are required." });
  if (canonicalJson(request.terminals[0]) === canonicalJson(request.terminals[1]))
    ctx.addIssue({ code: "custom", message: "Two distinct terminal selectors are required." });
  if (request.construction.dielectric.frequencyHz !== request.frequencyHz)
    ctx.addIssue({ code: "custom", message: "The asserted dielectric frequency must match the requested calculation frequency." });
});
export type SavedMicrostripRequest = z.infer<typeof savedMicrostripRequestSchema>;
export interface SavedMicrostripAssessmentInput {
  readonly savedPcbBytes: Uint8Array;
  readonly request: unknown;
  /** Host-only capability. Structural objects and copied factory objects are not accepted. */
  readonly calculator?: KicadTransmissionLineCalculator;
}
interface Reason { readonly code: string; readonly message: string }
interface RouteSegment {
  readonly uuid: string; readonly layer: string; readonly startNm: FreshReferencePointNm; readonly endNm: FreshReferencePointNm;
  readonly widthNm: number; readonly lengthSquaredNm2: string; readonly lengthNm: number; readonly sourceIdentity: ContentIdentity;
}
interface TerminalAnchor {
  readonly reference: string; readonly pad: string; readonly footprintUuid: string; readonly padUuid: string;
  readonly centerNm: FreshReferencePointNm; readonly sourceIdentity: ContentIdentity; readonly footprintSourceIdentity: ContentIdentity;
}
interface RouteAssessment {
  readonly status: "complete_source_chain" | "unassessed"; readonly reasons: readonly Reason[];
  readonly segments: readonly RouteSegment[]; readonly widthNm: number | null; readonly totalLengthNm: number | null;
  readonly terminalAnchors: readonly TerminalAnchor[];
  readonly completenessMeaning: "all-selected-net-straight-centerlines-between-two-source-pad-centers";
  readonly libraryMembership: "not_verified"; readonly nativeReachability: "not_evaluated";
  readonly finiteWidthContacts: "not_evaluated";
}
interface DielectricSublayer {
  readonly layerIndex: number; readonly sublayerIndex: number; readonly thicknessNm: number;
  readonly material: string; readonly epsilonR: number; readonly lossTangent: number;
}
interface ConstructionAssessment {
  readonly status: "supported_source_declaration" | "unassessed"; readonly reasons: readonly Reason[];
  readonly signalCopperThicknessNm: number | null; readonly referenceCopperThicknessNm: number | null;
  readonly dielectricThicknessNm: number | null; readonly dielectricSublayers: readonly DielectricSublayer[];
  readonly signalMaskThicknessNm: number | null;
  readonly homogeneity: "same_declared_values" | "unassessed";
  readonly physicalConstruction: "not_verified";
}
interface ReferenceRequirements {
  readonly status: "unassessed"; readonly declarationStatus: "matched_saved_zone" | "unassessed";
  readonly reasons: readonly Reason[]; readonly zoneSourceIdentity: ContentIdentity | null; readonly savedFillCachePresent: boolean | null;
  readonly fillFreshness: "not_verified"; readonly wholeRouteCoverage: "not_evaluated";
  readonly referenceElectricalEligibility: "not_evaluated";
}
interface NumericalTarget {
  readonly status: "within_tolerance" | "outside_tolerance" | "unassessed"; readonly reasons: readonly Reason[];
  readonly targetOhm: number; readonly absoluteToleranceOhm: number; readonly calculatedOhm: number | null;
  readonly residualOhm: number | null; readonly calculation: KicadTransmissionLineResult | null;
  readonly basis: "uniform-uncovered-cross-section-assuming-continuous-reference";
}

const MAX_NM = 2_000_000_000;
class Unsupported extends Error { constructor(readonly code: string, message: string) { super(message); } }
function requireSupported(value: unknown, code: string, message: string): asserts value { if (!value) throw new Unsupported(code, message); }
const reason = (code: string, message: string): Reason => ({ code, message });
const failure = (error: unknown, code: string): Reason => error instanceof Unsupported
  ? reason(error.code, error.message) : reason(code, "Saved source is outside the supported, unambiguous parser scope.");
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const pointKey = (p: FreshReferencePointNm) => `${p.x},${p.y}`;
function boundedNm(value: number): number {
  requireSupported(Number.isSafeInteger(value) && Math.abs(value) <= MAX_NM, "EXACT_NM_REQUIRED", "Geometry must be exact integer nanometres within the supported bounds.");
  return value === 0 ? 0 : value;
}

// Only retained, already parsed source forms are read here. The extra reader
// preserves exact placement/thickness atoms that the shared mm projection loses.
interface Atom { readonly value: string; readonly quoted: boolean }
interface Form { readonly name: string; readonly atoms: readonly Atom[]; readonly children: readonly Form[] }
function readForm(source: string): Form {
  requireSupported(source.isWellFormed() && Buffer.byteLength(source) <= 1024 * 1024, "SOURCE_FORM_BOUND", "Retained source form exceeds the bounded exact reader.");
  let cursor = 0, count = 0;
  const whitespace = () => { while (cursor < source.length && /[ \t\r\n]/u.test(source[cursor]!)) cursor++; };
  const atom = (): Atom => {
    whitespace(); const quoted = source[cursor] === '"'; let value = "";
    if (quoted) {
      cursor++;
      while (cursor < source.length) {
        const char = source[cursor++]!;
        if (char === '"') return { value, quoted };
        if (char === "\\") { requireSupported(cursor < source.length, "SOURCE_SYNTAX", "Unclosed source escape."); value += source[cursor++]!; }
        else value += char;
        requireSupported(value.length <= 65536, "SOURCE_FORM_BOUND", "Source atom exceeds its bound.");
      }
      throw new Unsupported("SOURCE_SYNTAX", "Unclosed source string.");
    }
    while (cursor < source.length && !/[ \t\r\n()"]/u.test(source[cursor]!)) value += source[cursor++]!;
    requireSupported(value.length > 0 && value.length <= 65536 && !/[;\x00-\x1f]/u.test(value), "SOURCE_SYNTAX", "Unsupported source atom.");
    return { value, quoted };
  };
  const form = (depth: number): Form => {
    whitespace(); requireSupported(depth <= 64 && ++count <= 100_000 && source[cursor++] === "(", "SOURCE_FORM_BOUND", "Source nesting, inventory or syntax is unsupported.");
    const head = atom(); requireSupported(!head.quoted, "SOURCE_SYNTAX", "Quoted source field name is unsupported.");
    const atoms: Atom[] = [], children: Form[] = [];
    while (true) {
      whitespace(); requireSupported(cursor < source.length, "SOURCE_SYNTAX", "Unclosed source form.");
      if (source[cursor] === ")") { cursor++; return { name: head.value, atoms, children }; }
      if (source[cursor] === "(") children.push(form(depth + 1)); else atoms.push(atom());
    }
  };
  const result = form(0); whitespace(); requireSupported(cursor === source.length, "SOURCE_SYNTAX", "Expected exactly one retained source form.");
  return result;
}
function field(form: Form, name: string, optional = false): Form | null {
  const values = form.children.filter(child => child.name === name);
  requireSupported(values.length === 1 || optional && values.length === 0, "AMBIGUOUS_SOURCE_FIELD", `Missing or repeated source ${name} field.`);
  return values[0] ?? null;
}
function scalar(form: Form): Atom {
  requireSupported(form.atoms.length === 1 && form.children.length === 0, "AMBIGUOUS_SOURCE_FIELD", "Source field must contain exactly one scalar.");
  return form.atoms[0]!;
}
function exactDecimal(atom: Atom, places = 6): number {
  requireSupported(!atom.quoted && atom.value.length <= 128, "EXACT_NM_REQUIRED", "Quoted or oversized geometry value is unsupported.");
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/u.exec(atom.value);
  requireSupported(match !== null && (match[2]!.length > 0 || (match[3]?.length ?? 0) > 0), "EXACT_NM_REQUIRED", "Invalid exact source quantity.");
  const power = places + Number(match[4] ?? 0) - (match[3]?.length ?? 0);
  requireSupported(Number.isSafeInteger(power) && Math.abs(power) <= 100, "EXACT_NM_REQUIRED", "Source exponent exceeds exact reader bounds.");
  let integer = BigInt((match[2]! + (match[3] ?? "")) || "0");
  if (power >= 0) integer *= 10n ** BigInt(power);
  else { const divisor = 10n ** BigInt(-power); requireSupported(integer % divisor === 0n, "EXACT_NM_REQUIRED", "Sub-nanometre source geometry is unsupported; it is not rounded."); integer /= divisor; }
  if (match[1] === "-") integer = -integer;
  requireSupported(integer >= -BigInt(MAX_NM) && integer <= BigInt(MAX_NM), "EXACT_NM_REQUIRED", "Exact source quantity exceeds its bound.");
  return Number(integer);
}
function sourcePoint(form: Form, allowAngle = false): FreshReferencePointNm {
  requireSupported(form.children.length === 0 && (form.atoms.length === 2 || allowAngle && form.atoms.length === 3), "PAD_PLACEMENT_UNSUPPORTED", "Source position must contain two coordinates and an optional angle.");
  return { x: exactDecimal(form.atoms[0]!), y: exactDecimal(form.atoms[1]!) };
}
function rotation(form: Form): number {
  const value = form.atoms.length === 3 ? exactDecimal(form.atoms[2]!, 0) : 0;
  requireSupported(value % 90 === 0, "PAD_ROTATION_UNSUPPORTED", "Only exact cardinal footprint and pad angles are supported.");
  return ((value % 360) + 360) % 360;
}
function sourceId(form: Form): string {
  const ids = form.children.filter(child => child.name === "uuid" || child.name === "tstamp");
  requireSupported(ids.length === 1, "PAD_ID_UNSUPPORTED", "Source object identity must be explicit and unique.");
  const value = scalar(ids[0]!).value;
  requireSupported(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value), "PAD_ID_UNSUPPORTED", "Source UUID must be canonical.");
  return value;
}
function assertPhysicalFormParents(source: string): void {
  const root = readForm(source), footprints = new Set(root.children.filter(child => child.name === "footprint"));
  const setups = root.children.filter(child => child.name === "setup");
  const stackups = setups.length === 1 ? setups[0]!.children.filter(child => child.name === "stackup") : [];
  const physicalStackup = stackups.length === 1 ? stackups[0] : undefined;
  requireSupported(root.name === "kicad_pcb", "SOURCE_SYNTAX", "Expected one complete PCB form.");
  const pending = root.children.map(form => ({ form, parent: root }));
  while (pending.length) {
    const { form, parent } = pending.pop()!;
    requireSupported((form.name !== "footprint" || parent === root) && (form.name !== "pad" || footprints.has(parent)),
      "PAD_INVENTORY_UNSUPPORTED", "Pads and footprints outside their supported direct parent positions cannot be omitted from inventory.");
    requireSupported(!["segment", "via", "arc", "zone"].includes(form.name) || parent === root,
      "ROUTE_INVENTORY_UNSUPPORTED", "Route/zone forms outside direct board positions are unsupported.");
    requireSupported(!form.name.startsWith("gr_") || parent === root, "ROUTE_INVENTORY_UNSUPPORTED", "Nested board graphics cannot be omitted from the copper inventory.");
    requireSupported(!form.name.startsWith("fp_") || footprints.has(parent), "ROUTE_INVENTORY_UNSUPPORTED", "Footprint graphics must occur directly within a board footprint.");
    const layers = form.children.filter(child => child.name === "layer" || child.name === "layers").flatMap(child => child.atoms.map(atom => atom.value));
    // Only the exact root/setup/stackup container contains physical layer
    // declarations rather than item layer selectors. Its grammar is checked
    // separately by the shared stackup parser; descendants still traverse here.
    requireSupported(form === physicalStackup || !layers.some(layer => layer.endsWith(".Cu") || layer.includes("*")) || ["footprint", "pad", "segment", "via", "arc", "zone"].includes(form.name),
      "ROUTE_INVENTORY_UNSUPPORTED", "Unmodeled copper-layer-bearing forms cannot establish a complete source-route inventory.");
    form.children.forEach(child => pending.push({ form: child, parent: form }));
  }
}
const PAD_FIELDS = new Set(["at", "size", "layers", "net", "uuid", "tstamp", "roundrect_rratio", "pinfunction", "pintype",
  "solder_mask_margin", "solder_paste_margin", "solder_paste_margin_ratio", "die_length", "locked", "zone_connect",
  "thermal_gap", "thermal_bridge_width", "thermal_bridge_angle"]);
function terminalAnchors(source: string, geometry: FreshPcbReferenceGeometry, request: SavedMicrostripRequest): TerminalAnchor[] {
  const board = parseFreshPcbSource(source);
  const forms = geometry.otherObservations.filter(item => item.kind === "footprint").map(item => ({ form: readForm(item.source), sourceIdentity: item.sourceIdentity }));
  const byId = new Map(forms.map(item => [sourceId(item.form), item]));
  requireSupported(forms.length === board.footprints.length && byId.size === forms.length, "PAD_INVENTORY_UNSUPPORTED", "Footprint source inventory is incomplete or ambiguous.");
  requireSupported(new Set(board.footprints.map(fp => fp.reference)).size === board.footprints.length, "PAD_INVENTORY_UNSUPPORTED", "Footprint references are ambiguous.");
  for (const fp of board.footprints) {
    requireSupported(fp.id !== null && byId.has(fp.id), "PAD_INVENTORY_UNSUPPORTED", "Every footprint must have an exact retained source identity.");
    const root = byId.get(fp.id)!.form, pending = root.children.map(form => ({ form, parent: root }));
    while (pending.length) {
      const { form, parent } = pending.pop()!;
      requireSupported(form.name !== "footprint" && (form.name !== "pad" || parent === root), "PAD_INVENTORY_UNSUPPORTED", "Nested footprint/pad forms cannot be omitted from terminal inventory.");
      if (form.name !== "pad") {
        const layers = form.children.filter(child => child.name === "layer" || child.name === "layers").flatMap(child => child.atoms.map(atom => atom.value));
        requireSupported(!layers.some(layer => layer.endsWith(".Cu") || layer.includes("*")), "FOOTPRINT_COPPER_UNSUPPORTED", "Footprint-local copper graphics are outside the supported route inventory.");
      }
      form.children.forEach(child => pending.push({ form: child, parent: form }));
    }
    const rawPads = root.children.filter(form => form.name === "pad");
    requireSupported(rawPads.length === fp.pads.length, "PAD_INVENTORY_UNSUPPORTED", "Raw and projected direct-pad counts differ.");
    for (const form of rawPads) {
      const padId = sourceId(form), projected = fp.pads.filter(pad => pad.physical.id === padId);
      requireSupported(projected.length === 1 && form.atoms.length === 3 && projected[0]!.number === form.atoms[0]!.value,
        "PAD_INVENTORY_UNSUPPORTED", "Every raw pad must map uniquely to its source identity and number.");
      const nets = form.children.filter(child => child.name === "net");
      requireSupported(nets.length <= 1 && nets.every(net => net.children.length === 0 && (net.atoms.length === 1 || net.atoms.length === 2)),
        "PAD_NET_AMBIGUOUS", "Every physical pad's net declaration must be unambiguous before selecting a net.");
      if (nets.length) {
        const net = nets[0]!, nullNet = net.atoms.length === 1 ? ["", "0"].includes(net.atoms[0]!.value)
          : net.atoms[0]!.value === "0" && net.atoms[1]!.value === "";
        requireSupported(projected[0]!.netName !== null || nullNet, "PAD_NET_AMBIGUOUS", "A declared pad net cannot disappear into an unresolved no-net projection.");
        if (net.atoms.length === 2) requireSupported(projected[0]!.netName === (net.atoms[1]!.value || null), "PAD_NET_AMBIGUOUS", "Legacy pad net name disagrees with its resolved identity.");
      }
    }
  }
  for (const selector of request.terminals) {
    const fp = board.footprints.find(value => value.reference === selector.reference);
    requireSupported(fp !== undefined && fp.pads.filter(pad => pad.number === selector.pad).length === 1,
      "TERMINAL_SELECTOR_MISMATCH", "Terminal selectors must uniquely identify physical pads across all nets.");
  }
  const selected = board.footprints.flatMap(fp => fp.pads.filter(pad => pad.netName === request.net).map(pad => ({ fp, pad })));
  requireSupported(selected.length === 2, "TERMINAL_INVENTORY_UNSUPPORTED", "The selected net must contain exactly the two declared physical pads across all layers.");
  const anchors = selected.map(({ fp, pad }) => {
    requireSupported(fp.id !== null && byId.has(fp.id) && pad.physical.id !== null, "PAD_ID_UNSUPPORTED", "Terminal footprint/pad identities are missing.");
    const retained = byId.get(fp.id)!, footprint = retained.form, placement = field(footprint, "at")!, origin = sourcePoint(placement, true), angle = rotation(placement);
    const form = readForm(pad.physical.source), localAt = field(form, "at")!, local = sourcePoint(localAt, true);
    rotation(localAt);
    requireSupported(form.name === "pad" && form.atoms.length === 3 && form.atoms[1]!.value === "smd"
      && ["rect", "roundrect", "circle", "oval"].includes(form.atoms[2]!.value)
      && form.children.every(child => PAD_FIELDS.has(child.name) && child.children.length === 0)
      && new Set(form.children.map(child => child.name)).size === form.children.length,
    "PAD_SHAPE_UNSUPPORTED", "Only ordinary unambiguous SMD pad forms without drills, offsets or custom stacks are supported.");
    const size = sourcePoint(field(form, "size")!);
    requireSupported(size.x > 0 && size.y > 0, "PAD_SHAPE_UNSUPPORTED", "Pad dimensions must be explicit positive integer nanometres.");
    const copper = pad.layers.filter(layer => layer.endsWith(".Cu"));
    requireSupported(fp.layer === request.signalLayer && copper.length === 1 && copper[0] === request.signalLayer
      && !pad.layers.some(layer => layer.includes("*")), "PAD_LAYER_UNSUPPORTED", "Both terminal pads must be ordinary SMD copper on the selected signal layer.");
    const rotated = angle === 0 ? local : angle === 90 ? { x: local.y, y: -local.x }
      : angle === 180 ? { x: -local.x, y: -local.y } : { x: -local.y, y: local.x };
    return { reference: fp.reference, pad: pad.number, footprintUuid: fp.id, padUuid: pad.physical.id,
      centerNm: { x: boundedNm(origin.x + rotated.x), y: boundedNm(origin.y + rotated.y) }, sourceIdentity: contentIdentity(pad.physical.source),
      footprintSourceIdentity: retained.sourceIdentity };
  });
  requireSupported(new Set(anchors.map(anchor => anchor.padUuid)).size === 2 && new Set(anchors.map(anchor => pointKey(anchor.centerNm))).size === 2,
    "TERMINAL_INVENTORY_UNSUPPORTED", "Two distinct, noncoincident physical terminal anchors are required.");
  return request.terminals.map(selector => {
    const matching = anchors.filter(anchor => anchor.reference === selector.reference && anchor.pad === selector.pad);
    requireSupported(matching.length === 1, "TERMINAL_SELECTOR_MISMATCH", "A terminal selector is missing or ambiguous in the selected saved net.");
    return matching[0]!;
  });
}
function cross(a: FreshReferencePointNm, b: FreshReferencePointNm, c: FreshReferencePointNm): bigint {
  return BigInt(b.x - a.x) * BigInt(c.y - a.y) - BigInt(b.y - a.y) * BigInt(c.x - a.x);
}
function on(p: FreshReferencePointNm, a: FreshReferencePointNm, b: FreshReferencePointNm): boolean {
  return cross(a, b, p) === 0n && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x)
    && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
}
function segmentsConflict(a: FreshReferenceSegment, b: FreshReferenceSegment): boolean {
  const p = a.startNm, q = a.endNm, r = b.startNm, s = b.endNm;
  const c1 = cross(p, q, r), c2 = cross(p, q, s), c3 = cross(r, s, p), c4 = cross(r, s, q);
  if (c1 === 0n && c2 === 0n) {
    const axis = p.x !== q.x ? "x" : "y";
    if (Math.max(Math.min(p[axis], q[axis]), Math.min(r[axis], s[axis])) < Math.min(Math.max(p[axis], q[axis]), Math.max(r[axis], s[axis]))) return true;
  }
  if ((c1 < 0n && c2 > 0n || c1 > 0n && c2 < 0n) && (c3 < 0n && c4 > 0n || c3 > 0n && c4 < 0n)) return true;
  const interior = (point: FreshReferencePointNm, start: FreshReferencePointNm, end: FreshReferencePointNm) => on(point, start, end)
    && pointKey(point) !== pointKey(start) && pointKey(point) !== pointKey(end);
  return interior(p, r, s) || interior(q, r, s) || interior(r, p, q) || interior(s, p, q);
}
function deriveRoute(source: string, geometry: FreshPcbReferenceGeometry, request: SavedMicrostripRequest): RouteAssessment {
  const spans = parseFreshPcbRouteSourceSpans(source), board = parseFreshPcbSource(source);
  assertPhysicalFormParents(source);
  const viaSpans = spans.filter(span => span.kind === "via"), trackSpans = spans.filter(span => span.kind === "track");
  requireSupported(geometry.issues.length === 0 && geometry.zones.every(zone => zone.status === "supported")
    && geometry.otherObservations.every(item => item.kind === "footprint"), "ROUTE_INVENTORY_UNSUPPORTED", "Arcs, vias, unknown/nested copper or ambiguous source prevent a complete first-slice route inventory.");
  requireSupported(trackSpans.length === geometry.segments.length && trackSpans.every(span => geometry.segments.some(segment => segment.uuid === span.id)),
    "ROUTE_INVENTORY_UNSUPPORTED", "Strict route spans and reference-segment inventories differ.");
  // A via is outside the reference export, but ordinary other-net through vias
  // may be admitted only through an exact source-span / parsed-inventory bijection.
  requireSupported(geometry.unsupportedRouteItems.length === viaSpans.length && board.vias.length === viaSpans.length
    && geometry.unsupportedRouteItems.every(item => item.kind === "via"), "ROUTE_INVENTORY_UNSUPPORTED", "Arcs or unattributed unsupported route forms cannot be filtered away.");
  for (const span of viaSpans) {
    const raw = source.slice(span.start, span.end), form = readForm(raw), identity = contentIdentity(raw);
    const observed = geometry.unsupportedRouteItems.filter(item => item.source === raw && same(item.sourceIdentity, identity));
    const projected = board.vias.filter(via => via.id === span.id);
    requireSupported(observed.length === 1 && projected.length === 1 && sourceId(form) === span.id,
      "VIA_INVENTORY_UNSUPPORTED", "Every admitted via must match exactly one raw observation and parsed source identity.");
    const via = projected[0]!, center = sourcePoint(field(form, "at")!), diameter = exactDecimal(scalar(field(form, "size")!)), drill = exactDecimal(scalar(field(form, "drill")!));
    requireSupported(via.netName !== null && via.netName !== request.net && same(via.layers, ["F.Cu", "B.Cu"])
      && via.at.x === center.x / 1e6 && via.at.y === center.y / 1e6 && via.diameterMm === diameter / 1e6 && via.drillMm === drill / 1e6,
      "SELECTED_OR_UNSUPPORTED_VIA", "Only fully attributed ordinary other-net through vias are outside this selected route assessment.");
  }
  requireSupported(!geometry.zones.some(zone => zone.netName === request.net && zone.kind !== "rule_area"), "SIGNAL_ZONE_UNSUPPORTED", "Selected-net zone copper is outside the point-to-point trace model.");
  const selected = geometry.segments.filter(segment => segment.netName === request.net);
  requireSupported(selected.length > 0 && selected.length <= 128, "ROUTE_INVENTORY_UNSUPPORTED", "All selected-net segments must fit the nonempty bounded inventory; no subset is assessed.");
  requireSupported(selected.every(segment => segment.layer === request.signalLayer), "ROUTE_LAYER_UNSUPPORTED", "Every selected-net segment must be on the declared signal layer.");
  const width = boundedNm(selected[0]!.widthNm);
  requireSupported(width > 0 && selected.every(segment => segment.widthNm === width), "ROUTE_WIDTH_UNSUPPORTED", "Every selected-net segment must have the same exact positive width.");
  const vertices = new Map<string, number[]>();
  selected.forEach((segment, index) => {
    for (const p of [segment.startNm, segment.endNm]) { boundedNm(p.x); boundedNm(p.y); }
    requireSupported(pointKey(segment.startNm) !== pointKey(segment.endNm), "ROUTE_ZERO_LENGTH", "Zero-length segments are unsupported.");
    for (const p of [segment.startNm, segment.endNm]) { const key = pointKey(p); const edges = vertices.get(key) ?? []; edges.push(index); vertices.set(key, edges); }
  });
  for (let i = 0; i < selected.length; i++) for (let j = i + 1; j < selected.length; j++)
    requireSupported(!segmentsConflict(selected[i]!, selected[j]!), "ROUTE_INTERSECTION", "Crossings, endpoint-to-interior contacts and positive overlaps are unsupported.");
  const leaves = [...vertices.entries()].filter(([, edges]) => edges.length === 1).map(([key]) => key);
  requireSupported(leaves.length === 2 && [...vertices.values()].every(edges => edges.length <= 2), "ROUTE_TOPOLOGY_UNSUPPORTED", "The full route must be a single chain with two leaves and no branches or cycles.");
  const reached = new Set<string>(), pending = [leaves[0]!];
  while (pending.length) {
    const key = pending.pop()!; if (reached.has(key)) continue; reached.add(key);
    for (const index of vertices.get(key)!) { const segment = selected[index]!; pending.push(pointKey(segment.startNm), pointKey(segment.endNm)); }
  }
  requireSupported(reached.size === vertices.size && selected.length === vertices.size - 1, "ROUTE_DISCONNECTED", "All selected-net segments must belong to one acyclic endpoint chain.");
  const anchors = terminalAnchors(source, geometry, request);
  requireSupported(same([...leaves].sort(), anchors.map(anchor => pointKey(anchor.centerNm)).sort()), "ROUTE_TERMINAL_MISMATCH", "Both chain leaves must equal the declared exact source pad centers.");
  const segments = selected.map(segment => {
    const dx = segment.endNm.x - segment.startNm.x, dy = segment.endNm.y - segment.startNm.y;
    return { uuid: segment.uuid, layer: segment.layer, startNm: segment.startNm, endNm: segment.endNm, widthNm: segment.widthNm,
      lengthSquaredNm2: String(BigInt(dx) * BigInt(dx) + BigInt(dy) * BigInt(dy)), lengthNm: Math.hypot(dx, dy), sourceIdentity: segment.sourceIdentity };
  });
  return { status: "complete_source_chain", reasons: [], segments, widthNm: width, totalLengthNm: segments.reduce((sum, segment) => sum + segment.lengthNm, 0),
    terminalAnchors: anchors, completenessMeaning: "all-selected-net-straight-centerlines-between-two-source-pad-centers",
    libraryMembership: "not_verified", nativeReachability: "not_evaluated", finiteWidthContacts: "not_evaluated" };
}
function explicit<Value>(value: FreshStackupField<Value>, label: string): Value {
  requireSupported(value.status === "explicit" && value.value !== null && value.sources.length === 1, "STACKUP_FIELD_MISSING", `An explicit unambiguous ${label} is required.`);
  return value.value;
}
function thickness(value: FreshStackupField<number>, label: string, allowZero = false): number {
  explicit(value, label); const form = readForm(value.sources[0]!);
  requireSupported(form.name === "thickness" && form.children.length === 0 && (form.atoms.length === 1
    || form.atoms.length === 2 && form.atoms[1]!.value === "locked" && !form.atoms[1]!.quoted), "STACKUP_THICKNESS_UNSUPPORTED", "Thickness must retain its exact source scalar.");
  const nm = exactDecimal(form.atoms[0]!);
  requireSupported(allowZero ? nm >= 0 : nm > 0, "STACKUP_THICKNESS_UNSUPPORTED", "Required copper and dielectric thicknesses must be positive.");
  return nm;
}
function deriveConstruction(stackup: FreshPcbStackup, request: SavedMicrostripRequest): ConstructionAssessment {
  requireSupported(stackup.status === "explicit" && stackup.observationsComplete && stackup.issues.length === 0,
    "STACKUP_UNSUPPORTED", "A complete supported saved stackup observation is required.");
  const copper = stackup.layers.filter(layer => layer.kind === "copper");
  const canonicalOrder = ["F.Cu", ...Array.from({ length: Math.max(0, copper.length - 2) }, (_, index) => `In${index + 1}.Cu`), "B.Cu"];
  requireSupported(copper.length >= 2 && same(copper.map(layer => layer.name), canonicalOrder) && same(stackup.boardCopperLayerOrder, canonicalOrder),
    "STACKUP_LAYER_ORDER", "Only explicit canonical physical copper order is supported.");
  const signalIndex = request.signalLayer === "F.Cu" ? 0 : copper.length - 1;
  const referenceIndex = request.signalLayer === "F.Cu" ? 1 : copper.length - 2;
  const signal = copper[signalIndex]!, reference = copper[referenceIndex]!;
  requireSupported(signal.name === request.signalLayer && reference.name === request.reference.layer,
    "REFERENCE_NOT_ADJACENT", "The declared reference must be the adjacent inward copper layer.");
  for (const layer of [signal, reference]) requireSupported(explicit(layer.type, "copper type").toLowerCase() === "copper" && layer.sublayers.length === 1,
    "COPPER_CONSTRUCTION_UNSUPPORTED", "Signal/reference copper types and single thickness records must be explicit.");
  const signalCopperThicknessNm = thickness(signal.sublayers[0]!.thicknessMm, "signal copper thickness");
  const referenceCopperThicknessNm = thickness(reference.sublayers[0]!.thicknessMm, "reference copper thickness");
  const outward = request.signalLayer === "F.Cu" ? stackup.layers.slice(0, signal.index) : stackup.layers.slice(signal.index + 1);
  const outerNames = request.signalLayer === "F.Cu" ? ["F.SilkS", "F.Paste", "F.Mask"] : ["B.Mask", "B.Paste", "B.SilkS"];
  requireSupported(outward.every(layer => outerNames.includes(layer.name ?? "") && ["mask", "paste", "silkscreen"].includes(layer.kind))
    && outward.every((layer, index) => index === 0 || outerNames.indexOf(outward[index - 1]!.name!) < outerNames.indexOf(layer.name!)),
    "EXTERIOR_CONSTRUCTION_UNSUPPORTED", "Exterior dielectric, wrong-side layers or ambiguous outer construction cannot represent uncovered microstrip.");
  for (const layer of outward.filter(value => value.kind !== "mask")) for (const sublayer of layer.sublayers) {
    const side = request.signalLayer === "F.Cu" ? "top" : "bottom";
    const expectedType = `${side} ${layer.kind === "paste" ? "solder paste" : "silk screen"}`;
    requireSupported(explicit(layer.type, "exterior layer type").toLowerCase() === expectedType,
      "EXTERIOR_TYPE_UNSUPPORTED", "Exterior paste/silk type must explicitly agree with its layer name.");
    if (sublayer.thicknessMm.status !== "missing") requireSupported(thickness(sublayer.thicknessMm, "exterior coating thickness", true) === 0,
      "EXTERIOR_CONSTRUCTION_UNSUPPORTED", "An explicitly positive exterior coating is outside the bare-conductor model.");
  }
  for (const setting of stackup.settings.filter(value => value.name === "copper_finish")) {
    const finish = scalar(readForm(setting.source)).value.toLowerCase();
    requireSupported(["none", "bare", "bare copper"].includes(finish), "COPPER_FINISH_UNSUPPORTED", "An explicit plated/coated or unknown copper finish is outside the bare-conductor model.");
  }
  const between = stackup.layers.slice(Math.min(signal.index, reference.index) + 1, Math.max(signal.index, reference.index));
  requireSupported(between.length > 0 && between.every(layer => layer.kind === "dielectric"), "DIELECTRIC_SPACING_UNSUPPORTED", "Only explicit dielectric records may lie between signal and reference copper.");
  const dielectricSublayers = between.flatMap(layer => {
    requireSupported(["core", "prepreg"].includes(explicit(layer.type, "dielectric type").toLowerCase()), "DIELECTRIC_TYPE_UNSUPPORTED", "Only explicit core/prepreg dielectric records are supported.");
    return layer.sublayers.map(sub => ({ layerIndex: layer.index, sublayerIndex: sub.index, thicknessNm: thickness(sub.thicknessMm, "dielectric thickness"),
      material: explicit(sub.material, "dielectric material"), epsilonR: explicit(sub.epsilonR, "dielectric permittivity"), lossTangent: explicit(sub.lossTangent, "dielectric loss tangent") }));
  });
  requireSupported(dielectricSublayers.length > 0 && dielectricSublayers.every(sub => sub.material.trim().length > 0 && sub.epsilonR > 1 && sub.lossTangent >= 0),
    "DIELECTRIC_DOMAIN_UNSUPPORTED", "Complete positive-domain dielectric declarations are required; air-only loss singularities are unsupported.");
  const first = dielectricSublayers[0]!;
  requireSupported(dielectricSublayers.every(sub => sub.material === first.material && sub.epsilonR === first.epsilonR && sub.lossTangent === first.lossTangent),
    "HETEROGENEOUS_DIELECTRIC", "Different material, permittivity or loss-tangent declarations are not averaged into a homogeneous substrate.");
  const asserted = request.construction.dielectric;
  requireSupported(first.material === asserted.material && first.epsilonR === asserted.epsilonR && first.lossTangent === asserted.lossTangent,
    "MATERIAL_ASSERTION_MISMATCH", "Caller material values must match the explicit saved dielectric declarations.");
  const dielectricThicknessNm = boundedNm(dielectricSublayers.reduce((sum, sub) => sum + sub.thicknessNm, 0));
  const maskName = request.signalLayer === "F.Cu" ? "F.Mask" : "B.Mask";
  const masks = stackup.layers.filter(layer => layer.name === maskName);
  requireSupported(masks.length === 1 && masks[0]!.sublayers.length === 1, "MASK_UNASSESSED", "An explicit signal-side mask thickness is required; an omitted record does not establish a bare trace.");
  const mask = masks[0]!;
  const expectedMaskType = request.signalLayer === "F.Cu" ? "top solder mask" : "bottom solder mask";
  requireSupported(explicit(mask.type, "signal-side mask type").toLowerCase() === expectedMaskType,
    "MASK_TYPE_UNSUPPORTED", "Signal-side mask type must explicitly agree with its layer name.");
  requireSupported(request.signalLayer === "F.Cu" ? mask.index < signal.index : mask.index > signal.index,
    "MASK_POSITION_UNSUPPORTED", "The mask record must lie outside the selected signal copper.");
  const signalMaskThicknessNm = thickness(mask.sublayers[0]!.thicknessMm, "signal-side mask thickness", true);
  requireSupported(signalMaskThicknessNm === 0, "MASKED_MICROSTRIP_UNSUPPORTED", "Positive mask thickness is outside the uncovered bare-conductor model; caller assertions cannot remove it.");
  return { status: "supported_source_declaration", reasons: [], signalCopperThicknessNm, referenceCopperThicknessNm, dielectricThicknessNm,
    dielectricSublayers, signalMaskThicknessNm, homogeneity: "same_declared_values", physicalConstruction: "not_verified" };
}
function referenceRequirements(geometry: FreshPcbReferenceGeometry, request: SavedMicrostripRequest): ReferenceRequirements {
  const zones = geometry.zones.filter(zone => zone.uuid === request.reference.zoneUuid);
  const zone = zones[0];
  const matched = zones.length === 1 && zone?.status === "supported" && zone.kind === "copper"
    && zone.netName === request.reference.net && zone.layers.length === 1 && zone.layers[0] === request.reference.layer;
  return { status: "unassessed", declarationStatus: matched ? "matched_saved_zone" : "unassessed",
    reasons: [reason(matched ? "REFERENCE_REQUIREMENTS_REMAIN" : "REFERENCE_DECLARATION_MISMATCH",
      matched ? "Saved zone identity/net/layer match the declaration; fresh fill, full-route coverage and electrical reference eligibility remain unassessed."
        : "The declared reference zone does not uniquely match supported saved copper on the declared net/layer.")],
    zoneSourceIdentity: matched ? zone!.sourceIdentity : null, savedFillCachePresent: matched ? zone!.filledCachePresent : null,
    fillFreshness: "not_verified", wholeRouteCoverage: "not_evaluated", referenceElectricalEligibility: "not_evaluated" };
}

/** Byte-bound numerical cross-section assessment; no filesystem, CAD authoring or acceptance side effects. */
export async function assessSavedMicrostrip(input: SavedMicrostripAssessmentInput) {
  const suppliedBytes = input.savedPcbBytes;
  if (!(suppliedBytes instanceof Uint8Array) || suppliedBytes.byteLength > 8 * 1024 * 1024)
    throw new Error("Saved microstrip assessment requires bounded host-supplied PCB bytes.");
  // This copy precedes request access, parsing and every awaited calculation.
  const bytes = Buffer.from(suppliedBytes);
  const request = freeze(savedMicrostripRequestSchema.parse(input.request));
  const sourceIdentity = freeze(contentIdentity(bytes));
  if (!same(sourceIdentity, request.expectedSourceIdentity)) throw new Error("Saved PCB identity differs from the explicitly requested source identity.");
  const calculator = input.calculator;
  if (calculator !== undefined && !isKicadTransmissionLineCalculator(calculator)) throw new Error("Saved microstrip assessment requires a genuine factory-bound transmission-line calculator.");
  const requestIdentity = canonicalIdentity(request, "evleda.saved-microstrip-request.v1");
  let routeCompleteness: RouteAssessment = { status: "unassessed", reasons: [], segments: [], widthNm: null, totalLengthNm: null, terminalAnchors: [],
    completenessMeaning: "all-selected-net-straight-centerlines-between-two-source-pad-centers", libraryMembership: "not_verified", nativeReachability: "not_evaluated", finiteWidthContacts: "not_evaluated" };
  let construction: ConstructionAssessment = { status: "unassessed", reasons: [], signalCopperThicknessNm: null, referenceCopperThicknessNm: null,
    dielectricThicknessNm: null, dielectricSublayers: [], signalMaskThicknessNm: null, homogeneity: "unassessed", physicalConstruction: "not_verified" };
  let reference: ReferenceRequirements = { status: "unassessed", declarationStatus: "unassessed", reasons: [], zoneSourceIdentity: null,
    savedFillCachePresent: null, fillFreshness: "not_verified", wholeRouteCoverage: "not_evaluated", referenceElectricalEligibility: "not_evaluated" };
  try {
    const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const geometry = parseFreshPcbReferenceGeometry(source);
    requireSupported(same(geometry.sourceIdentity, sourceIdentity), "SOURCE_IDENTITY_MISMATCH", "Source parser and byte identities differ.");
    try { routeCompleteness = deriveRoute(source, geometry, request); }
    catch (error) { routeCompleteness = { ...routeCompleteness, reasons: [failure(error, "ROUTE_UNSUPPORTED")] }; }
    try { construction = deriveConstruction(parseFreshPcbStackup(source), request); }
    catch (error) { construction = { ...construction, reasons: [failure(error, "CONSTRUCTION_UNSUPPORTED")] }; }
    reference = referenceRequirements(geometry, request);
  } catch (error) {
    const reasons = [failure(error, "SOURCE_UNSUPPORTED")];
    routeCompleteness = { ...routeCompleteness, reasons }; construction = { ...construction, reasons }; reference = { ...reference, reasons };
  }
  const prepared = routeCompleteness.status === "complete_source_chain" && construction.status === "supported_source_declaration"
    && reference.declarationStatus === "matched_saved_zone";
  // Qucs node75, Kirschning-Jansen impedance dispersion: necessary base-model
  // envelope only, not an accuracy qualification of this finite-thickness core.
  const widthRatio = prepared ? routeCompleteness.widthNm! / construction.dielectricThicknessNm! : null;
  const normalizedFrequency = prepared ? request.frequencyHz * (construction.dielectricThicknessNm! / 1e9) / 299_792_458 : null;
  const inBaseEnvelope = prepared && widthRatio! >= 0.1 && widthRatio! <= 10 && request.construction.dielectric.epsilonR <= 18
    && normalizedFrequency! <= 0.1 && request.construction.substrateRelativePermeability === 1;
  let numericalTarget: NumericalTarget = { status: "unassessed", reasons: [reason("CROSS_SECTION_UNASSESSED", "Complete source-route and supported construction/reference declarations are required.")],
    targetOhm: request.targetOhm, absoluteToleranceOhm: request.absoluteToleranceOhm, calculatedOhm: null, residualOhm: null, calculation: null,
    basis: "uniform-uncovered-cross-section-assuming-continuous-reference" };
  let modelWarnings: readonly KicadTransmissionLineModelWarning[] = [];
  if (inBaseEnvelope) {
    if (calculator === undefined) numericalTarget = { ...numericalTarget, reasons: [reason("CALCULATOR_UNAVAILABLE", "A factory-bound numerical calculator has not been supplied by the host.")] };
    else {
      try {
        const calculation = await calculator.calculate({ model: "microstrip", operation: "analyze", parameters: {
          EPSILONR: request.construction.dielectric.epsilonR, H: construction.dielectricThicknessNm! / 1e9,
          T: construction.signalCopperThicknessNm! / 1e9, PHYS_WIDTH: routeCompleteness.widthNm! / 1e9,
          PHYS_LEN: routeCompleteness.totalLengthNm! / 1e9, FREQUENCY: request.frequencyHz,
          SIGMA: request.construction.conductor.conductivitySiemensPerMetre, MURC: request.construction.conductor.relativePermeability,
          H_T: "absent", ROUGH: request.construction.conductor.roughnessNm / 1e9, TAND: request.construction.dielectric.lossTangent,
          MUR: request.construction.substrateRelativePermeability,
        } });
        modelWarnings = structuredClone(calculation.modelWarnings);
        const ohm = calculation.impedance.singleEndedOhm;
        if (calculation.status === "calculated" && ohm !== null && Number.isFinite(ohm) && ohm > 0) {
          const residualOhm = ohm - request.targetOhm;
          numericalTarget = { ...numericalTarget, status: Math.abs(residualOhm) <= request.absoluteToleranceOhm ? "within_tolerance" : "outside_tolerance",
            reasons: [], calculatedOhm: ohm, residualOhm, calculation: structuredClone(calculation) };
        } else numericalTarget = { ...numericalTarget, calculation: structuredClone(calculation),
          reasons: [reason("CALCULATION_UNAVAILABLE", "Pinned numerical calculation did not complete with a usable result.")] };
      } catch { numericalTarget = { ...numericalTarget, reasons: [reason("CALCULATION_UNAVAILABLE", "Pinned numerical calculation did not complete with a usable result.")] }; }
    }
  } else if (prepared) numericalTarget = { ...numericalTarget, reasons: [reason("MODEL_ENVELOPE_UNASSESSED", "The source geometry/material/frequency is outside the bounded nonmagnetic base-model envelope.")] };
  const payload = { schemaVersion: "evleda.saved-microstrip-assessment.v1" as const, sourceIdentity, requestIdentity, request,
    routeCompleteness, construction,
    constructionProvenance: { authority: "caller_asserted_metadata" as const, sourceMatched: construction.status === "supported_source_declaration",
      sourceMatchScope: ["dielectric-material-permittivity-loss-declarations", "signal-reference-spacing", "copper-thicknesses", "zero-mask-thickness"] as const,
      sourceUnverifiedAssertionFields: ["material-frequency-basis", "conductivity", "permeability", "roughness", "metallic-cover-absence", "evidence-text"] as const,
      assertions: request.construction, physicalMaterialVerification: "not_performed" as const },
    modelApplicability: { status: inBaseEnvelope ? "conditional_model_only" as const : "unassessed" as const,
      reasons: [reason(inBaseEnvelope ? "MODEL_LIMITATIONS_REMAIN" : "MODEL_APPLICABILITY_UNASSESSED",
        inBaseEnvelope ? "Uniform bare microstrip is evaluated conditionally. Finite-thickness accuracy, bends/launches, lateral copper and actual reference continuity are not qualified."
          : "The complete source-route, construction and necessary base-model domain have not been established.")],
      widthToHeightRatio: widthRatio, frequencyHeightOverC: normalizedFrequency },
    numericalTarget, modelWarnings, referenceRequirements: reference,
    boardAccepted: false as const, interfaceAccepted: false as const,
    supportBounds: { maximumInputBytes: 8 * 1024 * 1024, maximumAssessedSourceBytes: 1024 * 1024, maximumSelectedSegments: 128,
      sourceGrammar: "existing-strict-source-span-grammar-without-unquoted-BOM" as const },
    scope: "Saved-route numerical cross-section assessment only; source centerline/pad facts are not library/native terminal authority or complete interface acceptance.",
    lengthMeaning: "exact-integer-nm-coordinates-and-squared-lengths-with-numerical-Euclidean-length-sum" as const,
  };
  return freeze({ ...payload, identity: canonicalIdentity(payload, payload.schemaVersion) });
}
export type SavedMicrostripAssessment = Awaited<ReturnType<typeof assessSavedMicrostrip>>;
