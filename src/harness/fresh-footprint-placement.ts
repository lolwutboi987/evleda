import { freshBoardComparisonText } from "./fresh-board-serialization.js";
import { parseFreshPcbSourceDocument, type FreshKicadSourceAtom as Atom,
  type FreshKicadSourceNode as Node } from "./fresh-kicad-parser.js";

export interface FreshFootprintPose {
  readonly xMm: number;
  readonly yMm: number;
  readonly rotationDeg: number;
}
export interface FreshFootprintPlacement extends FreshFootprintPose { readonly reference: string }
export interface FreshFootprintPlacementPlan {
  readonly source: string;
  readonly changed: boolean;
  readonly reference: string;
  readonly footprintId: string;
  readonly before: FreshFootprintPose;
  readonly after: FreshFootprintPose;
}

export const FRESH_FOOTPRINT_PLACEMENT_LIMITS = Object.freeze({
  maximumSourceBytes: 64 * 1024 * 1024,
  maximumFootprintNodes: 100_000,
  maximumGraphicItems: 4096,
  maximumCoordinateNm: 2_000_000_000,
});

function need(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Unsupported preserving footprint placement: ${message}`);
}
const named = (node: Node, name: string): readonly Node[] => node.children.filter(child => child.name === name);
function field(node: Node, name: string, optional = false): Node | undefined {
  const matches = named(node, name);
  need(matches.length === 1 || optional && matches.length === 0, `missing or duplicate ${node.name}/${name} field.`);
  return matches[0];
}
function scalar(node: Node): Atom {
  need(node.children.length === 0 && node.values.length === 1, `malformed ${node.name} scalar.`);
  return node.values[0]!;
}

// Decimal-to-integer conversion follows freshReferenceNm's exact source policy.
// Multiplying a binary float and rounding would silently admit sub-nm requests.
function decimalInteger(text: string, places: number, maximum: number): number {
  need(text.length <= 128, "numeric token is too long.");
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/u.exec(text);
  need(match !== null && (match[2]!.length > 0 || (match[3]?.length ?? 0) > 0), "invalid exact decimal quantity.");
  const exponent = Number(match[4] ?? 0);
  need(Number.isSafeInteger(exponent) && Math.abs(exponent) <= 100, "numeric exponent is unsupported.");
  const power = places + exponent - (match[3]?.length ?? 0);
  let integer = BigInt((match[2]! + (match[3] ?? "")) || "0");
  if (power >= 0) integer *= 10n ** BigInt(power);
  else {
    const divisor = 10n ** BigInt(-power);
    need(integer % divisor === 0n, places === 6 ? "coordinate is not exact integer nanometres." : "angle is not an exact integer degree.");
    integer /= divisor;
  }
  if (match[1] === "-") integer = -integer;
  need(integer >= -BigInt(maximum) && integer <= BigInt(maximum), "quantity exceeds the supported bound.");
  return Number(integer);
}
function nm(atom: Atom): number {
  need(!atom.quoted, "quoted geometry is unsupported.");
  return decimalInteger(atom.value, 6, FRESH_FOOTPRINT_PLACEMENT_LIMITS.maximumCoordinateNm);
}
function requestNm(value: number): number {
  need(typeof value === "number" && Number.isFinite(value), "requested coordinate is not finite.");
  return decimalInteger(String(value), 6, FRESH_FOOTPRINT_PLACEMENT_LIMITS.maximumCoordinateNm);
}
function cardinal(value: string): number {
  const angle = decimalInteger(value, 0, 360);
  need(angle % 90 === 0, "only cardinal angles in the range -360 through 360 are supported.");
  return ((angle % 360) + 360) % 360;
}
function angle(atom: Atom | undefined): number {
  if (atom === undefined) return 0;
  need(!atom.quoted, "quoted angle is unsupported.");
  return cardinal(atom.value);
}
function millimetres(value: number): string {
  const digits = Math.abs(value).toString().padStart(7, "0");
  const fraction = digits.slice(-6).replace(/0+$/u, "");
  return `${value < 0 ? "-" : ""}${digits.slice(0, -6)}${fraction.length ? `.${fraction}` : ""}`;
}
interface Pose {
  readonly node: Node; readonly x: number; readonly y: number; readonly angle: number;
  readonly angleToken: Atom | undefined; readonly omitZeroAngle: boolean; readonly rootAngle: boolean;
}
function pose(owner: Node): Pose {
  const at = field(owner, "at")!;
  const text = owner.name === "property" || owner.name === "fp_text";
  const legacyUnlocked = text && at.values.at(-1)?.value === "unlocked" && !at.values.at(-1)!.quoted;
  const values = legacyUnlocked ? at.values.slice(0, -1) : at.values;
  need(at.children.length === 0 && (values.length === 2 || values.length === 3), `unsupported ${owner.name}/at form.`);
  if (text) {
    const unlocked = field(owner, "unlocked", true);
    need(!(legacyUnlocked && unlocked !== undefined), "duplicate text unlocked representations.");
    if (unlocked !== undefined) {
      const flag = scalar(unlocked);
      need(!flag.quoted && ["yes", "no"].includes(flag.value), "malformed text unlocked flag.");
    }
  }
  return { node: at, x: nm(values[0]!), y: nm(values[1]!), angle: angle(values[2]), angleToken: values[2],
    omitZeroAngle: !text, rootAngle: owner.name === "footprint" };
}
function report(value: { readonly x: number; readonly y: number; readonly angle: number }): FreshFootprintPose {
  return Object.freeze({ xMm: value.x / 1_000_000, yMm: value.y / 1_000_000, rotationDeg: value.angle });
}

const localGraphics = new Set(["fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly", "fp_curve"]);
const unsupportedObjects = new Set(["zone", "filled_polygon", "fp_text_box", "fp_point", "point", "dimension", "image", "bitmap", "footprint", "module", "render_cache"]);
const poseNames = new Set(["at", "start", "end", "mid", "center", "xy", "xyz", "pts", "points", "position",
  "angle", "rotate", "rotation", "orientation", "offset", "scale", "mirror", "polygon", "primitives"]);
const rootMetadata = new Set(["version", "generator", "generator_version", "layer", "at", "uuid", "tstamp", "descr", "tags",
  "path", "sheetname", "sheetfile", "attr", "locked", "placed", "autoplace_cost90", "autoplace_cost180",
  "solder_mask_margin", "solder_paste_margin", "solder_paste_ratio", "clearance", "zone_connect", "thermal_width", "thermal_gap",
  "duplicate_pad_numbers_are_jumpers", "embedded_fonts", "private_layers", "net_tie_pad_groups", "group"]);
// Known scalar settings are invariant under a rigid footprint transform. An
// unknown numeric/enum form cannot be proved to be metadata, so admit unknown
// extensions only as quoted text (possibly nested), never guessed coordinates.
const invariantSettings = new Set([...rootMetadata, "property", "layers", "net", "pinfunction", "pintype",
  "roundrect_rratio", "chamfer_ratio", "chamfer", "remove_unused_layers", "keep_end_layers", "solder_paste_margin_ratio",
  "thermal_bridge_angle", "options", "anchor", "die_length", "tenting", "covering", "plugging", "capping", "filling",
  "front", "back", "effects", "font", "face", "size", "thickness", "bold", "italic", "line_spacing", "justify",
  "hide", "unlocked", "show_name", "knockout", "id", "members", "stroke", "width", "type", "fill"]);
const padSettings = new Set(["uuid", "tstamp", "layers", "net", "pinfunction", "pintype", "property", "locked",
  "roundrect_rratio", "chamfer_ratio", "chamfer", "remove_unused_layers", "keep_end_layers", "solder_mask_margin",
  "solder_paste_margin", "solder_paste_margin_ratio", "clearance", "zone_connect", "thermal_width", "thermal_gap",
  "thermal_bridge_angle", "options", "die_length", "tenting", "covering", "plugging", "capping", "filling"]);
const textSettings = new Set(["layer", "uuid", "tstamp", "effects", "hide", "unlocked", "locked", "show_name"]);
const graphicSettings = new Set(["stroke", "width", "layer", "uuid", "tstamp", "fill", "locked"]);
const padTypes = new Set(["smd", "thru_hole", "np_thru_hole", "connect"]);
const padShapes = new Set(["circle", "rect", "oval", "trapezoid", "roundrect", "custom"]);
function uniqueFields(owner: Node): void {
  need(new Set(owner.children.map(child => child.name)).size === owner.children.length,
    `duplicate ${owner.name} child field.`);
}
function noUnsupportedObject(node: Node): void {
  need(!unsupportedObjects.has(node.name), `uncharacterized pose-bearing ${node.name} child.`);
  node.children.forEach(noUnsupportedObject);
}
function validateLexicalAtoms(node: Node): void {
  need(!/["\x00-\x20\x7f]/u.test(node.name), "malformed source form name.");
  let previous: Atom | undefined;
  for (const atom of node.values) {
    need(atom.quoted || !/["\x00-\x20\x7f]/u.test(atom.value), "malformed unquoted source atom.");
    need(previous === undefined || atom.start > previous.end, "adjacent source atoms lack a delimiter.");
    previous = atom;
  }
  node.children.forEach(validateLexicalAtoms);
}

function noUnknownPose(node: Node): void {
  need(!unsupportedObjects.has(node.name) && !poseNames.has(node.name)
    && !/^(?:fp_|gr_)/u.test(node.name), `uncharacterized pose-bearing ${node.name} child.`);
  if (!invariantSettings.has(node.name)) { quotedMetadata(node); return; }
  for (const child of node.children) noUnknownPose(child);
}
function quotedMetadata(node: Node): void {
  need(!unsupportedObjects.has(node.name) && !poseNames.has(node.name) && !/^(?:fp_|gr_)/u.test(node.name),
    `uncharacterized pose-bearing ${node.name} child.`);
  need(node.values.every(value => value.quoted), `uncharacterized scalar ${node.name} form cannot be proved to be nongeometric metadata.`);
  node.children.forEach(quotedMetadata);
}
function headerBeforeChildren(node: Node): void {
  need(node.values.length === 0 || node.children.length === 0 || node.values.at(-1)!.end <= node.children[0]!.start,
    `malformed ${node.name} header ordering.`);
}
function noMirror(node: Node): void {
  need(node.name !== "mirror" && !(node.name === "justify" && node.values.some(value => value.value === "mirror")),
    "mirrored footprint children are unsupported.");
  for (const child of node.children) noMirror(child);
}
function boundedPosition(x: number, y: number, root: { x: number; y: number; angle: number }): { x: number; y: number } {
  const [dx, dy] = root.angle === 0 ? [x, y] : root.angle === 90 ? [y, -x]
    : root.angle === 180 ? [-x, -y] : [-y, x];
  need(Math.abs(root.x + dx!) <= FRESH_FOOTPRINT_PLACEMENT_LIMITS.maximumCoordinateNm
    && Math.abs(root.y + dy!) <= FRESH_FOOTPRINT_PLACEMENT_LIMITS.maximumCoordinateNm,
  "transformed child position exceeds exact coordinate bounds.");
  return { x: root.x + dx!, y: root.y + dy! };
}
function point(node: Node): { x: number; y: number } {
  need(node.children.length === 0 && node.values.length === 2, `malformed ${node.name} point.`);
  return { x: nm(node.values[0]!), y: nm(node.values[1]!) };
}
function graphicPoints(graphic: Node, validate: (point: { x: number; y: number }) => void): void {
  need(graphic.values.length === 0, "unsupported local graphic header.");
  uniqueFields(graphic);
  const kind = graphic.name.slice(3);
  const required = kind === "line" || kind === "rect" ? ["start", "end"] : kind === "circle" ? ["center", "end"]
    : kind === "arc" ? ["start", "mid", "end"] : ["pts"];
  for (const name of required) field(graphic, name);
  for (const node of graphic.children) {
    if (!required.includes(node.name)) {
      if (graphicSettings.has(node.name)) noUnknownPose(node); else quotedMetadata(node);
    }
    else if (node.name !== "pts") validate(point(node));
    else {
      need(node.values.length === 0 && (kind === "curve" ? node.children.length === 4 : node.children.length >= 3)
        && node.children.every(child => child.name === "xy"), "malformed local graphic point list.");
      node.children.forEach(child => validate(point(child)));
    }
  }
}
function padLocalGeometry(pad: Node, validate: (point: { x: number; y: number }) => void): void {
  for (const child of pad.children) {
    if (child.name === "at") continue;
    if (["size", "rect_delta"].includes(child.name)) point(child);
    else if (child.name === "offset") validate(point(child));
    else if (child.name === "drill") {
      const oval = child.values[0]?.value === "oval" && !child.values[0]!.quoted;
      const dimensions = child.values.slice(oval ? 1 : 0);
      need(dimensions.length === (oval ? 2 : 1), "unsupported drill dimensions.");
      dimensions.forEach(nm);
      uniqueFields(child);
      need(child.children.every(nested => nested.name === "offset"), "uncharacterized drill child.");
      child.children.forEach(nested => validate(point(nested)));
    } else if (child.name === "primitives") {
      need(child.values.length === 0, "unsupported custom pad primitives.");
      for (const primitive of child.children) {
        need(primitive.name.startsWith("gr_") && localGraphics.has(`fp_${primitive.name.slice(3)}`),
          "uncharacterized custom pad primitive.");
        graphicPoints(primitive, validate);
      }
    } else if (padSettings.has(child.name)) noUnknownPose(child);
    else quotedMetadata(child);
  }
}

interface Edit { readonly start: number; readonly end: number; readonly text: string }
const graphicLayerIds: Readonly<Record<string, number>> = Object.freeze({
  "F.Cu": 0, "B.Cu": 2, "F.Mask": 1, "B.Mask": 3, "F.SilkS": 5, "B.SilkS": 7,
  "F.Adhes": 9, "B.Adhes": 11, "F.Paste": 13, "B.Paste": 15, "Dwgs.User": 17, "Cmts.User": 19,
  "Eco1.User": 21, "Eco2.User": 23, "Edge.Cuts": 25, Margin: 27, "B.CrtYd": 29, "F.CrtYd": 31,
  "B.Fab": 33, "F.Fab": 35,
});
function graphicLayer(node: Node): number {
  const name = scalar(field(node, "layer")!).value;
  const known = Object.hasOwn(graphicLayerIds, name) ? graphicLayerIds[name] : undefined;
  if (known !== undefined) return known;
  const inner = /^In([1-9]|[12]\d|30)\.Cu$/u.exec(name);
  if (inner !== null) return 2 * (Number(inner[1]) + 1);
  const user = /^User\.([1-9]|[1-3]\d|4[0-5])$/u.exec(name);
  need(user !== null, "graphic ordering requires a characterized KiCad 10 layer.");
  return 37 + 2 * Number(user[1]);
}
function compareNumbers(left: readonly number[], right: readonly number[]): number {
  need(left.length === right.length, "native graphic ordering keys have inconsistent dimensions.");
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return left[index]! < right[index]! ? -1 : 1;
  return 0;
}
function graphicUuid(node: Node): string {
  const ids = node.children.filter(child => child.name === "uuid" || child.name === "tstamp");
  need(ids.length === 1, "tied graphic ordering requires one stable UUID per item.");
  const value = scalar(ids[0]!).value.toLowerCase();
  need(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value), "graphic ordering UUID is unsupported.");
  return value;
}
function textFlag(font: Node | undefined, name: "bold" | "italic"): number {
  if (font === undefined) return 0;
  const bare = font.values.filter(value => !value.quoted && value.value === name);
  const explicit = field(font, name, true);
  need(bare.length <= 1 && !(bare.length && explicit !== undefined), `duplicate text ${name} ordering key.`);
  if (explicit === undefined) return bare.length;
  need(explicit.children.length === 0 && explicit.values.length <= 1
    && explicit.values.every(value => !value.quoted && ["yes", "no"].includes(value.value)), `unsupported text ${name} ordering key.`);
  return explicit.values[0]?.value === "no" ? 0 : 1;
}
function textStyleKey(node: Node): readonly number[] {
  const effects = field(node, "effects", true), font = effects === undefined ? undefined : field(effects, "font", true);
  const size = font === undefined ? undefined : field(font, "size", true);
  const dimensions = size === undefined ? { x: 1_524_000, y: 1_524_000 } : point(size);
  need([dimensions.x, dimensions.y].every(value => value >= 1000 && value <= 250_000_000), "text ordering size would be natively clamped.");
  const thickness = font === undefined ? undefined : field(font, "thickness", true);
  const width = thickness === undefined ? 0 : nm(scalar(thickness));
  need(width >= 0, "negative text ordering thickness is unsupported.");
  const spacing = font === undefined ? undefined : field(font, "line_spacing", true);
  const spacingAtom = spacing === undefined ? undefined : scalar(spacing);
  need(spacingAtom === undefined || !spacingAtom.quoted, "quoted text line spacing is unsupported.");
  const spacingKey = spacingAtom === undefined ? 1_000_000 : decimalInteger(spacingAtom.value, 6, 100_000_000);
  need(spacingKey >= 0, "negative text line spacing is unsupported.");
  // File size is (height width), while cmp_drawings compares native (width height).
  return [dimensions.y, dimensions.x, width, textFlag(font, "bold"), textFlag(font, "italic"), 0, spacingKey];
}

/**
 * KiCad 10.0.3 FOOTPRINT::cmp_drawings (footprint.cpp:4304-4422) compares type,
 * layer, shape, then WORLD geometry/text and UUID. Only members sharing those
 * first three invariant keys can change order during a same-side pose edit.
 * Retain the existing slots and complete raw forms, including all trivia within
 * each form; do not canonicalize any other child ordering. cmp_pads instead uses
 * footprint-relative positions, so pad, field and model order stays untouched.
 */
function nativeGraphicOrderEdits(source: string, footprint: Node, before: Pose,
  target: { x: number; y: number; angle: number }, atomEdits: readonly Edit[]): readonly Edit[] {
  if (before.angle === target.angle) return atomEdits;
  const graphics = footprint.children.filter(node => localGraphics.has(node.name) || node.name === "fp_text");
  need(graphics.length <= FRESH_FOOTPRINT_PLACEMENT_LIMITS.maximumGraphicItems, "graphic ordering inventory exceeds its bound.");
  if (graphics.length < 2) return atomEdits;
  const groups = new Map<string, Node[]>();
  for (const graphic of graphics) {
    if (graphic.name === "fp_text") {
      const hide = field(graphic, "hide", true);
      need(hide === undefined || scalar(hide).value === "no", "hidden user text becomes a native field and cannot use drawing ordering.");
      need(!/%[RV]/u.test(graphic.values[1]!.value), "legacy text substitutions would change native source.");
    }
    const key = `${graphic.name}:${graphicLayer(graphic)}`;
    const group = groups.get(key) ?? [];
    group.push(graphic); groups.set(key, group);
  }
  const geometryKeys = new Map<Node, readonly number[]>();
  const world = (local: { x: number; y: number }): readonly number[] => {
    const transformed = boundedPosition(local.x, local.y, target); return [transformed.x, transformed.y];
  };
  const geometryKey = (node: Node): readonly number[] => {
    const cached = geometryKeys.get(node); if (cached !== undefined) return cached;
    let key: readonly number[];
    if (node.name === "fp_text") {
      const placement = pose(node), angle = ((placement.angle + target.angle - before.angle) % 360 + 360) % 360;
      key = [...world(placement), angle];
    } else if (node.name === "fp_poly" || node.name === "fp_curve") {
      const vertices = field(node, "pts")!.children.map(point);
      if (node.name === "fp_poly") {
        need(vertices.every((vertex, index) => {
          const previous = vertices[(index + vertices.length - 1) % vertices.length]!;
          return vertex.x !== previous.x || vertex.y !== previous.y;
        }), "polygon ordering excludes vertices that native loading would suppress.");
        key = [vertices.length, ...vertices.flatMap(world)];
      } else key = [vertices[0]!, vertices[3]!, vertices[1]!, vertices[2]!].flatMap(world);
    } else {
      need(node.name !== "fp_arc", "same-layer arc ordering requires uncharacterized native arc-center/winding keys.");
      const start = point(field(node, node.name === "fp_circle" ? "center" : "start")!);
      key = [...world(start), ...world(point(field(node, "end")!))];
    }
    geometryKeys.set(node, key); return key;
  };
  const strokeWidth = (node: Node): number => {
    const stroke = field(node, "stroke", true), legacy = field(node, "width", true);
    need(!(stroke !== undefined && legacy !== undefined), "ambiguous graphic stroke ordering key.");
    const width = legacy ?? (stroke === undefined ? undefined : field(stroke, "width", true));
    need(width !== undefined, "tied shape ordering requires explicit positive stroke width.");
    const value = nm(scalar(width));
    need(value > 0, "shape ordering excludes native default/nonpositive stroke widths.");
    return value;
  };
  const compare = (left: Node, right: Node): number => {
    if (left === right) return 0;
    const leftKey = geometryKey(left), rightKey = geometryKey(right);
    // Polygon vertex count precedes its variable-length coordinate sequence.
    if (left.name === "fp_poly" && leftKey[0] !== rightKey[0]) return leftKey[0]! < rightKey[0]! ? -1 : 1;
    let difference = compareNumbers(leftKey, rightKey);
    if (difference !== 0) return difference;
    if (left.name === "fp_text") {
      difference = compareNumbers(textStyleKey(left), textStyleKey(right));
      if (difference !== 0) return difference;
      const a = left.values[1]!.value, b = right.values[1]!.value;
      if (a !== b) {
        need(/^[\x00-\x7f]*$/u.test(a) && /^[\x00-\x7f]*$/u.test(b), "tied Unicode text ordering is outside the pinned ASCII comparison scope.");
        return a < b ? -1 : 1;
      }
    } else {
      difference = strokeWidth(left) - strokeWidth(right);
      if (difference !== 0) return difference < 0 ? -1 : 1;
    }
    const a = graphicUuid(left), b = graphicUuid(right);
    need(a !== b, "native pointer-based graphic ordering is unsupported.");
    return a < b ? -1 : 1;
  };
  const replacement = new Map<Node, Node>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort(compare);
    for (const [index, slot] of group.entries()) if (slot !== ordered[index]) replacement.set(slot, ordered[index]!);
  }
  if (replacement.size === 0) return atomEdits;
  // Merge already planned text-angle edits into their source form before moving
  // that form. A single monotone pass keeps work bounded by the source inventory.
  const orderedEdits = [...atomEdits].sort((a, b) => a.start - b.start), outside: Edit[] = [];
  const nested = new Map<Node, Edit[]>(); let graphicIndex = 0;
  for (const edit of orderedEdits) {
    while (graphicIndex < graphics.length && graphics[graphicIndex]!.end <= edit.start) graphicIndex += 1;
    const owner = graphics[graphicIndex];
    if (owner !== undefined && owner.start <= edit.start && edit.end <= owner.end && replacement.has(owner)) {
      const entries = nested.get(owner) ?? []; entries.push(edit); nested.set(owner, entries);
    } else outside.push(edit);
  }
  const render = (node: Node): string => {
    const pieces: string[] = []; let cursor = node.start;
    for (const edit of nested.get(node) ?? []) { pieces.push(source.slice(cursor, edit.start), edit.text); cursor = edit.end; }
    pieces.push(source.slice(cursor, node.end)); return pieces.join("");
  };
  for (const [slot, donor] of replacement) outside.push({ start: slot.start, end: slot.end, text: render(donor) });
  return outside;
}

/**
 * Pure front-side cardinal placement. Only selected root coordinate/angle atoms
 * and absolute pad/text angle atoms are spliced. Pose-dependent native drawing
 * order moves complete unchanged graphic forms (with their planned text angle).
 * Local geometry, IDs, nets,
 * metadata (including pad_prop_heatsink), models, trivia and all other bytes
 * remain untouched. This does not authorize persistence or prove native reload.
 *
 * Native FOOTPRINT::SetOrientation rotates fields/pads by delta; serializer text
 * and pad angles are absolute although their XY positions are footprint-relative.
 * Models and fp_* graphic points already use the footprint-local frame.
 * Characterized from KiCad 10.0.3, commit 146a4f2a7585c65bc580427a19b6fe2ec4a3f622:
 * pcbnew/footprint.cpp SetOrientation, pcb_text.cpp Rotate, and
 * pcb_io/kicad_sexpr/pcb_io_kicad_sexpr.cpp format(PCB_TEXT*).
 */
export function planFreshFootprintPlacement(source: string, placement: FreshFootprintPlacement): FreshFootprintPlacementPlan {
  need(typeof source === "string" && source.isWellFormed() && source.length > 0
    && source.length <= FRESH_FOOTPRINT_PLACEMENT_LIMITS.maximumSourceBytes
    && Buffer.byteLength(source, "utf8") <= FRESH_FOOTPRINT_PLACEMENT_LIMITS.maximumSourceBytes, "source is not bounded well-formed text.");
  // Validate physical string/EOL grammar without using its normalized copy.
  freshBoardComparisonText(source);
  need(placement !== null && typeof placement === "object" && typeof placement.reference === "string"
    && placement.reference.length > 0 && placement.reference.length <= 128 && !/[\x00-\x1f]/u.test(placement.reference), "invalid reference selector.");
  need(typeof placement.rotationDeg === "number" && Number.isFinite(placement.rotationDeg), "requested angle is not finite.");
  const target = { x: requestNm(placement.xMm), y: requestNm(placement.yMm), angle: cardinal(String(placement.rotationDeg)) };
  const root = parseFreshPcbSourceDocument(source);
  validateLexicalAtoms(root);
  const matches = named(root, "footprint").filter(footprint => named(footprint, "property")
    .some(property => property.values[0]?.value === "Reference" && property.values[1]?.value === placement.reference));
  need(matches.length === 1, "reference must select exactly one top-level footprint.");
  const footprint = matches[0]!;
  headerBeforeChildren(footprint);
  need(footprint.values.length === 1 && footprint.values[0]!.quoted, "footprint library identity is malformed.");
  need(scalar(field(footprint, "layer")!).value === "F.Cu", "only front-side F.Cu footprints are supported.");
  const identities = footprint.children.filter(child => child.name === "uuid" || child.name === "tstamp");
  need(identities.length === 1, "footprint must have exactly one UUID identity.");
  const footprintId = scalar(identities[0]!).value;
  need(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(footprintId), "footprint UUID is malformed.");
  const seenIds = new Set<string>();
  const checkIds = (node: Node): void => {
    if (node.name === "uuid" || node.name === "tstamp") {
      const id = scalar(node).value.toLowerCase();
      need(id.length > 0 && !seenIds.has(id), "duplicate or empty UUID identity in board source.");
      seenIds.add(id);
    }
    node.children.forEach(checkIds);
  };
  checkIds(root);
  const before = pose(footprint);
  const childPoses: Pose[] = [];
  const propertyNames = new Set<string>();
  let footprintNodes = 0;
  const countNodes = (node: Node): void => {
    need(++footprintNodes <= FRESH_FOOTPRINT_PLACEMENT_LIMITS.maximumFootprintNodes, "footprint node inventory exceeds its bound.");
    node.children.forEach(countNodes);
  };
  countNodes(footprint);
  noMirror(footprint);
  const validateChildPosition = (point: { readonly x: number; readonly y: number }): void => {
    boundedPosition(point.x, point.y, before);
    boundedPosition(point.x, point.y, target);
  };
  for (const child of footprint.children) {
    if (child.name === "pad" || child.name === "property" || child.name === "fp_text") {
      headerBeforeChildren(child);
      uniqueFields(child);
      noUnsupportedObject(child);
      const position = pose(child);
      for (const nested of child.children) {
        if (child.name !== "pad" && nested.name !== "at") {
          if (textSettings.has(nested.name)) noUnknownPose(nested); else quotedMetadata(nested);
        }
      }
      if (child.name === "pad") need(child.values.length === 3 && child.values[0]!.quoted
        && !child.values[1]!.quoted && padTypes.has(child.values[1]!.value)
        && !child.values[2]!.quoted && padShapes.has(child.values[2]!.value), "pad header type or shape is unsupported.");
      if (child.name === "pad") {
        const oldAnchor = boundedPosition(position.x, position.y, before);
        const newAnchor = boundedPosition(position.x, position.y, target);
        const newAngle = ((position.angle + target.angle - before.angle) % 360 + 360) % 360;
        padLocalGeometry(child, local => {
          boundedPosition(local.x, local.y, { ...oldAnchor, angle: position.angle });
          boundedPosition(local.x, local.y, { ...newAnchor, angle: newAngle });
        });
      }
      if (child.name === "property") {
        need(child.values.length === 2 && child.values.every(value => value.quoted), "property field is malformed.");
        const name = child.values[0]!.value;
        need(!propertyNames.has(name), `duplicate property ${name}.`);
        propertyNames.add(name);
        if (name === "Reference") need(child.values[1]!.value === placement.reference, "reference field is ambiguous.");
      }
      if (child.name === "fp_text") {
        need(child.values.length === 2 && !child.values[0]!.quoted && child.values[0]!.value === "user"
          && child.values[1]!.quoted, "only user fp_text is supported alongside property fields.");
      }
      validateChildPosition(position);
      childPoses.push(position);
    } else if (localGraphics.has(child.name)) {
      // These native primitive points are footprint-local; retain their bytes.
      graphicPoints(child, validateChildPosition);
    } else if (child.name === "model") {
      // Entire 3D blocks are intentionally opaque and remain byte-identical.
      need(child.values.length === 1 && child.values[0]!.quoted, "model identity is malformed.");
    } else if (rootMetadata.has(child.name)) {
      if (child.name !== "group") field(footprint, child.name);
      if (child.name !== "at") child.children.forEach(noUnknownPose);
    } else quotedMetadata(child);
  }
  need(propertyNames.has("Reference"), "footprint Reference property is missing.");
  let edits: Edit[] = [];
  const change = (atom: Atom, text: string): void => { edits.push({ start: atom.start, end: atom.end, text }); };
  const changeAngle = (value: Pose, nextAngle: number): void => {
    if (value.angle === nextAngle) return;
    const token = value.angleToken;
    // KiCad 10 serializes zero root/pad orientation without an angle atom;
    // fields/text always contain it. Remove only the token, retaining trivia.
    // FOOTPRINT::SetOrientation normalizes (-180,180]; pad and text orientation
    // normalize [0,360). Keep the public pose report consistently [0,360).
    const serialized = value.rootAngle && nextAngle > 180 ? nextAngle - 360 : nextAngle;
    if (token !== undefined) change(token, nextAngle === 0 && value.omitZeroAngle ? "" : String(serialized));
    else edits.push({ start: value.node.values[1]!.end, end: value.node.values[1]!.end, text: ` ${serialized}` });
  };
  if (before.x !== target.x) change(before.node.values[0]!, millimetres(target.x));
  if (before.y !== target.y) change(before.node.values[1]!, millimetres(target.y));
  changeAngle(before, target.angle);
  const delta = target.angle - before.angle;
  for (const child of childPoses) changeAngle(child, ((child.angle + delta) % 360 + 360) % 360);
  edits = [...nativeGraphicOrderEdits(source, footprint, before, target, edits)];
  edits.sort((left, right) => left.start - right.start);
  let cursor = 0;
  const pieces: string[] = [];
  for (const edit of edits) {
    need(edit.start >= cursor && edit.start >= footprint.start && edit.end <= footprint.end, "pose edit spans overlap or escape the selected footprint.");
    pieces.push(source.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  pieces.push(source.slice(cursor));
  return Object.freeze({ source: edits.length === 0 ? source : pieces.join(""), changed: edits.length > 0,
    reference: placement.reference, footprintId, before: report(before), after: report(target) });
}
