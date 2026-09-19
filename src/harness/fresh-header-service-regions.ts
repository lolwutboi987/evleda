import { z } from "zod";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import type { ContentIdentity } from "../domain/types.js";
import { parseFreshPcbSource, parseFreshPcbSourceDocument, parseFreshPcbReferenceGeometry,
  parseFreshPcbRouteSourceSpans, type FreshKicadSourceNode as Node } from "./fresh-kicad-parser.js";
import { routeSourceMmToNativeNm } from "./fresh-route-native-units.js";
import { freezePcbPlaneArtifact } from "./pcb-design-plane-contract.js";
import { assessFreshPlaneFilledGeometry } from "./fresh-plane-filled-geometry.js";

const mm = z.number().finite().min(0).max(2000).refine(value => !Object.is(value, -0) && (() => {
  try { routeSourceMmToNativeNm(value); return true; } catch { return false; }
})(), "Exact integer-nanometre coordinates are required");
const point = z.object({ xMm: mm, yMm: mm }).strict();
const text = z.string().min(1).max(128), uuid = z.string().uuid();
const policySchema = z.object({
  board: z.object({ widthMm: mm.positive(), heightMm: mm.positive() }).strict(),
  left: z.object({ reference: text, innerXmm: mm }).strict(),
  right: z.object({ reference: text, innerXmm: mm }).strict(),
  headerPads: z.array(z.object({ reference: text, pin: text, uuid }).strict()).min(2).max(128),
  // One exact straight inward segment per permission. Later routing is not exempt.
  leads: z.array(z.object({ padUuid: uuid, net: text, layer: z.enum(["F.Cu", "B.Cu"]),
    widthMm: mm.positive(), start: point, end: point }).strict()).max(256),
}).strict().superRefine((p, ctx) => {
  if (!(p.left.innerXmm > 0 && p.left.innerXmm < p.right.innerXmm && p.right.innerXmm < p.board.widthMm)
      || p.left.reference === p.right.reference) ctx.addIssue({ code: "custom", message: "Two distinct opposite full-height side strips are required" });
  if (new Set(p.headerPads.map(pad => pad.uuid)).size !== p.headerPads.length
      || p.headerPads.some(pad => ![p.left.reference, p.right.reference].includes(pad.reference))
      || [p.left.reference, p.right.reference].some(ref => !p.headerPads.some(pad => pad.reference === ref)))
    ctx.addIssue({ code: "custom", message: "Unique exact pads from both declared headers are required" });
});
export type FreshHeaderServicePolicy = z.infer<typeof policySchema>;
export const FRESH_HEADER_SERVICE_LIMITS = Object.freeze({ sourceBytes: 2 * 1024 * 1024, tracks: 1280, vias: 256, pads: 1024, zones: 4, contourVertices: 8192 });

/** Independent conservative containment check. Straight-edge fill cannot extend
 * outside the bounding rectangle of all its vertices, including fracture walks.
 * This does not normalize holes or establish that the fill is topologically valid.
 */
export function auditFreshStoredFillHeaderBounds(input: { pcbSource: string; expectedSourceIdentity: ContentIdentity; policy: FreshHeaderServicePolicy }) {
  const policy = policySchema.parse(input.policy), sourceIdentity = contentIdentity(input.pcbSource);
  const unknown: string[] = [], zones: { id: string; vertices: number; minXnm: number; maxXnm: number; minYnm: number; maxYnm: number; contained: boolean }[] = [];
  let vertices = 0;
  try {
    check(sameIdentity(sourceIdentity, input.expectedSourceIdentity), "Exact saved source identity differs");
    check(sourceIdentity.size <= FRESH_HEADER_SERVICE_LIMITS.sourceBytes, "Source byte bound exceeded");
    check(parseFreshPcbSource(input.pcbSource).version === 20260206, "Only the inspected KiCad 10 saved-fill format is supported");
    const parsed = parseFreshPcbReferenceGeometry(input.pcbSource);
    check(parsed.zones.length > 0 && parsed.zones.length <= FRESH_HEADER_SERVICE_LIMITS.zones, "Missing or excessive zone inventory");
    const left = routeSourceMmToNativeNm(policy.left.innerXmm), right = routeSourceMmToNativeNm(policy.right.innerXmm), height = routeSourceMmToNativeNm(policy.board.heightMm);
    for (const zone of parsed.zones) {
      const fill = zone.settings.find(setting => setting.name === "fill");
      check(zone.status === "supported" && zone.uuid !== null && zone.kind === "copper" && zone.layers.length === 1 && ["F.Cu", "B.Cu"].includes(zone.layers[0]!)
        && zone.filledCachePresent && zone.filledPolygons.length > 0 && fill?.values.length === 1 && !fill.values[0]!.quoted && fill.values[0]!.value === "yes", "Unsupported or unfilled zone");
      const points = zone.filledPolygons.flatMap(group => {
        check(group.status === "supported" && group.contourGroup.length === 1 && group.contourGroup[0]!.status === "supported"
          && group.contourGroup[0]!.pointsNm !== null && group.contourGroup[0]!.pointsNm!.length >= 3, "Incomplete or non-straight stored contour");
        return group.contourGroup[0]!.pointsNm!;
      });
      vertices += points.length; check(vertices <= FRESH_HEADER_SERVICE_LIMITS.contourVertices, "Stored fill vertex bound exceeded");
      let minXnm = Infinity, maxXnm = -Infinity, minYnm = Infinity, maxYnm = -Infinity;
      for (const p of points) { minXnm = Math.min(minXnm, p.x); maxXnm = Math.max(maxXnm, p.x); minYnm = Math.min(minYnm, p.y); maxYnm = Math.max(maxYnm, p.y); }
      zones.push({ id: zone.uuid, vertices: points.length, minXnm, maxXnm, minYnm, maxYnm,
        contained: minXnm >= left && maxXnm <= right && minYnm >= 0 && maxYnm <= height });
    }
  } catch (error) { unknown.push(error instanceof Error ? error.message : "Source bounds could not be read"); }
  return freezePcbPlaneArtifact({ schemaVersion: "evleda.stored-fill-header-bounds.v1", sourceIdentity,
    policyIdentity: canonicalIdentity(policy, "evleda.header-service-policy.v1"), status: unknown.length ? "unknown" : zones.every(z => z.contained) ? "contained" : "bounds-cross-service-region",
    complete: unknown.length === 0, zones, unknown, vertices, nativeAuthority: false,
    scope: "conservative-enclosure-of-all-straight-stored-fill-vertices-only", topologyVerified: false, fillFreshness: "unverified",
    notAssessed: ["other-copper-primitives", "polygon-validity", "holes-and-islands", "connectivity", "clearance", "return-path-quality", "fabrication"] });
}
const sameIdentity = (a: ContentIdentity, b: ContentIdentity) => canonicalJson(a) === canonicalJson(b);
type Point = { x: number; y: number };
type Pad = { id: string; reference: string; pin: string; net: string | null; layers: string[];
  center: Point; width: number; height: number; radius2: number; drill: { width: number; height: number } | null; copper: boolean };
type Finding = { code: string; id: string | null; detail: string };
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const field = (node: Node, name: string, optional = false): Node | undefined => {
  const found = node.children.filter(child => child.name === name);
  check(found.length === (optional && found.length === 0 ? 0 : 1), `Ambiguous/missing ${name}`); return found[0];
};
// Parse original decimal tokens, never round a sub-nanometre source value into compliance.
function scalar(raw: string, scale = 6): number {
  const m = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/u.exec(raw);
  check(raw.length <= 64 && m !== null, "Unsupported numeric source token");
  let n = BigInt(m[2]! + (m[3] ?? "")); const exponent = scale + Number(m[4] ?? 0) - (m[3]?.length ?? 0);
  check(Number.isSafeInteger(exponent) && Math.abs(exponent) <= 40, "Numeric source exponent exceeds bound");
  if (exponent >= 0) n *= 10n ** BigInt(exponent);
  else { const d = 10n ** BigInt(-exponent); check(n % d === 0n, "Source value is not an exact integer nanometre"); n /= d; }
  if (m[1] === "-") n = -n;
  check(n >= -2_000_000_000n && n <= 2_000_000_000n, "Source coordinate exceeds bound"); return Number(n);
}
function values(node: Node, count: number, scale = 6): number[] {
  check(node.children.length === 0 && node.values.length === count && node.values.every(a => !a.quoted), `Unsupported ${node.name} geometry`);
  return node.values.map(atom => scalar(atom.value, scale));
}
/** KiCad 10.0.3 / 146a4f2a: PADSTACK::RoundRectRadius (padstack.cpp:953)
 * uses KiROUND(min(size) * parsed double ratio); math/util.h:102 uses llround.
 * For admitted nonnegative ratios Math.round has the same halfway-away rule.
 * This is native radius materialization, never a geometric tolerance or rounding
 * of saved coordinates. The ratio grammar remains bounded to exact six decimals.
 * https://gitlab.com/kicad/code/kicad/-/blob/146a4f2a7585c65bc580427a19b6fe2ec4a3f622/pcbnew/padstack.cpp#L953
 */
export function headerServiceRoundRectRadiusNm(minimumSizeNm: number, sourceRatio: string): number {
  check(Number.isSafeInteger(minimumSizeNm) && minimumSizeNm > 0 && minimumSizeNm <= 2_000_000_000, "Invalid native pad dimension");
  const scaled = scalar(sourceRatio), ratio = Number(sourceRatio);
  check(scaled >= 0 && scaled <= 500000 && !Object.is(ratio, -0), "Invalid rounded rectangle ratio");
  return Math.round(minimumSizeNm * ratio);
}
function at(node: Node): { point: Point; angle: number } {
  check(node.values.length === 2 || node.values.length === 3, "Unsupported placement");
  check(node.children.length === 0 && node.values.every(a => !a.quoted), "Unsupported placement fields");
  const angle = node.values[2] === undefined ? 0 : scalar(node.values[2].value, 0);
  check(angle % 90 === 0, "Only cardinal pad/footprint geometry is supported");
  return { point: { x: scalar(node.values[0]!.value), y: scalar(node.values[1]!.value) }, angle: ((angle % 360) + 360) % 360 };
}
const nmPoint = (p: { xMm: number; yMm: number }): Point => ({ x: routeSourceMmToNativeNm(p.xMm), y: routeSourceMmToNativeNm(p.yMm) });
const samePoint = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
function sourcePad(node: Node, fp: Node, known: ReturnType<typeof parseFreshPcbSource>["footprints"][number]["pads"][number], reference: string): Pad {
  const allowed = new Set(["at", "size", "drill", "layers", "uuid", "tstamp", "net", "roundrect_rratio", "solder_mask_margin", "solder_paste_margin",
    "solder_paste_margin_ratio", "clearance", "zone_connect", "thermal_bridge_angle", "thermal_gap", "thermal_bridge_width", "remove_unused_layers", "keep_end_layers", "property"]);
  check(node.values.length === 3 && node.children.every(child => allowed.has(child.name))
    && new Set(node.children.map(child => child.name)).size === node.children.length, "Unsupported pad source fields");
  const position = at(field(node, "at")!), placement = at(field(fp, "at")!);
  let { x, y } = position.point;
  if (placement.angle === 90) [x, y] = [y, -x]; else if (placement.angle === 180) [x, y] = [-x, -y]; else if (placement.angle === 270) [x, y] = [-y, x];
  const center = { x: placement.point.x + x, y: placement.point.y + y };
  check(Math.abs(center.x) <= 2e9 && Math.abs(center.y) <= 2e9, "Absolute pad coordinates exceed bound");
  let [width, height] = values(field(node, "size")!, 2) as [number, number];
  check(width > 0 && height > 0, "Nonpositive pad dimensions");
  const shape = node.values[2]!.value, type = node.values[1]!.value;
  check(["rect", "roundrect", "circle", "oval"].includes(shape) && ["smd", "thru_hole", "np_thru_hole"].includes(type), "Unsupported pad shape/type");
  check(shape !== "circle" || width === height, "Noncircular circle pad");
  let radius2 = shape === "circle" || shape === "oval" ? Math.min(width, height) : 0;
  if (shape === "roundrect") {
    // PAD::buildEffectiveShapes uses integer half-sizes. Keep odd-size shape
    // materialization unqualified, including .5 ratios whose rounded diameter
    // exceeds the source minimum by one nm. Radius computation alone is no proof.
    check(width % 2 === 0 && height % 2 === 0, "Odd-size roundrect geometry requires native half-size qualification");
    const ratio = field(node, "roundrect_rratio")!;
    values(ratio, 1); // Reject quoted, compound or inexact source scalars before materialization.
    radius2 = 2 * headerServiceRoundRectRadiusNm(Math.min(width, height), ratio.values[0]!.value);
    check(radius2 <= Math.min(width, height), "Materialized roundrect radius exceeds the supported core");
    // Pinned pad.cpp:1195-1203 substitutes a circle when BOTH remaining
    // half-sizes are below100nm. Only its already-exact circle case is admitted;
    // no near-circle approximation is borrowed for an own-pad exemption.
    check(radius2 === 0 || width-radius2 >= 200 || height-radius2 >= 200 || width === height && radius2 === width,
      "Near-circle roundrect simplification requires separate native geometry qualification");
  } else check(field(node, "roundrect_rratio", true) === undefined, "Unexpected rounded rectangle field");
  const drillNode = field(node, "drill", true); let drill: Pad["drill"] = null;
  if (drillNode !== undefined) {
    check(drillNode.children.length === 0, "Offset/unknown drilled pad geometry is unsupported");
    const oval = drillNode.values[0]?.value === "oval", dimensions = drillNode.values.slice(oval ? 1 : 0);
    check(dimensions.length === (oval ? 2 : 1) && dimensions.every(a => !a.quoted), "Malformed pad drill");
    drill = { width: scalar(dimensions[0]!.value), height: scalar(dimensions[oval ? 1 : 0]!.value) };
    check(drill.width > 0 && drill.height > 0, "Nonpositive drill");
  }
  check(type === "smd" ? drill === null : drill !== null, "Unsupported pad/drill combination");
  if (type === "thru_hole") check(drill!.width < width && drill!.height < height, "Plated pad has no supported positive annulus");
  const unused = field(node, "remove_unused_layers", true);
  check(unused === undefined || unused.children.length === 0 && unused.values.length === 1 && unused.values[0]!.value === "no", "Removed pad-layer copper requires native presence evidence");
  if (position.angle === 90 || position.angle === 270) { [width, height] = [height, width]; if (drill) [drill.width, drill.height] = [drill.height, drill.width]; }
  const layersNode = field(node, "layers")!;
  check(layersNode.children.length === 0 && layersNode.values.length > 0 && layersNode.values.every(atom => atom.quoted), "Explicit nonempty quoted pad layers are required");
  const rawLayers = layersNode.values.map(atom => atom.value);
  check(new Set(rawLayers).size === rawLayers.length, "Duplicate pad layer selectors");
  check(rawLayers.every(layer => ["*.Cu", "F&B.Cu", "F.Cu", "B.Cu", "*.Mask", "F.Mask", "B.Mask", "F.Paste", "B.Paste"].includes(layer)), "Unsupported pad layer");
  const layers = ["F.Cu", "B.Cu"].filter(layer => rawLayers.includes(layer) || rawLayers.includes("*.Cu") || rawLayers.includes("F&B.Cu"));
  const mechanical = type === "np_thru_hole";
  if (mechanical) check(known.number === "" && known.netName === null && drill !== null && width === drill.width && height === drill.height
    && ["circle", "oval"].includes(shape), "NPTH with possible copper annulus is unsupported");
  check(known.physical.id !== null, "Pad identity is missing");
  return { id: known.physical.id, reference, pin: known.number, net: known.netName, layers, center, width, height, radius2, drill, copper: layers.length > 0 && !mechanical };
}
// Doubled-nm coordinates retain odd native widths exactly. Cardinal supported
// pad shapes are rectangles plus a circular radius around their central box.
function inPad(pad: Pad, x2: number, y2: number): boolean {
  const dx = Math.max(0, Math.abs(x2 - 2 * pad.center.x) - (pad.width - pad.radius2));
  const dy = Math.max(0, Math.abs(y2 - 2 * pad.center.y) - (pad.height - pad.radius2));
  return BigInt(dx) ** 2n + BigInt(dy) ** 2n <= BigInt(pad.radius2) ** 2n;
}
function fullWidthContact(pad: Pad, start: Point, end: Point, width: number, direction: 1 | -1): boolean {
  const low = Math.max(direction * (2 * start.x - 2 * pad.center.x), 0), high = Math.min(direction * (2 * end.x - 2 * pad.center.x), pad.width);
  const y0 = 2 * start.y - width, y1 = 2 * start.y + width;
  const contained = (u: number) => inPad(pad, 2 * pad.center.x + direction * u, y0) && inPad(pad, 2 * pad.center.x + direction * u, y1);
  if (high <= low || !contained(low)) return false;
  let lo = low, hi = high;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (contained(mid)) lo = mid; else hi = mid - 1; }
  if (lo <= low) return false;
  const xs = [2 * pad.center.x + direction * (lo - 1), 2 * pad.center.x + direction * lo].sort((a, b) => a - b);
  if (pad.drill === null) return true;
  const r = Math.min(pad.drill.width, pad.drill.height), coreX = pad.drill.width - r, coreY = pad.drill.height - r;
  const gap = (a: number, b: number, c: number, d: number) => Math.max(0, c - b, a - d);
  const dx = gap(xs[0]!, xs[1]!, 2 * pad.center.x - coreX, 2 * pad.center.x + coreX), dy = gap(y0, y1, 2 * pad.center.y - coreY, 2 * pad.center.y + coreY);
  return BigInt(dx) ** 2n + BigInt(dy) ** 2n > BigInt(r) ** 2n;
}

/** Scoped stored-source analysis only. Caller permissions and cached fill are
 * never native authority, route completion, clearance or fabrication evidence. */
export function auditFreshHeaderServiceRegions(input: { readonly pcbSource: string; readonly expectedSourceIdentity: ContentIdentity; readonly policy: FreshHeaderServicePolicy }) {
  const policy = policySchema.parse(input.policy), source = input.pcbSource;
  check(typeof source === "string" && source.isWellFormed() && Buffer.byteLength(source) <= FRESH_HEADER_SERVICE_LIMITS.sourceBytes, "PCB source exceeds audit bound");
  const sourceIdentity = contentIdentity(source), policyIdentity = canonicalIdentity(policy, "evleda.header-service-policy.v1");
  const violations: Finding[] = [], unknown: Finding[] = [], permittedTrackIds: string[] = [];
  const counts = { tracks: 0, vias: 0, pads: 0, zones: 0, storedFillVertices: 0 };
  const finish = () => freezePcbPlaneArtifact({ schemaVersion: "evleda.header-service-source-audit.v1", sourceIdentity, policyIdentity,
    status: violations.length ? "violations" : unknown.length ? "unknown" : "clear", complete: unknown.length === 0,
    violations, unknown, permittedTrackIds, counts, limits: FRESH_HEADER_SERVICE_LIMITS,
    scope: "saved-source-copper-in-two-full-height-side-strips", nativeAuthority: false, fillFreshness: "unverified",
    roundrectRadiusModel: "KiCad-10.0.3-KiROUND-binary64-product-halfway-away-from-zero; coordinates remain exact source nanometres",
    notAssessed: ["complete-intent", "routing-completion", "contract-numerical-rules", "library-identity", "clearance", "ampacity", "fabrication", "soldering-or-rework-safety"] });
  if (canonicalJson(sourceIdentity) !== canonicalJson(input.expectedSourceIdentity)) { unknown.push({ code: "SOURCE_IDENTITY_MISMATCH", id: null, detail: "Exact expected saved source differs" }); return finish(); }
  const width = routeSourceMmToNativeNm(policy.board.widthMm), height = routeSourceMmToNativeNm(policy.board.heightMm);
  const left = routeSourceMmToNativeNm(policy.left.innerXmm), right = routeSourceMmToNativeNm(policy.right.innerXmm);
  const intrudes = (minX2: number, maxX2: number) => minX2 < 2 * left || maxX2 > 2 * right;
  const bounded = (minX2: number, maxX2: number, minY2: number, maxY2: number) => minX2 >= 0 && maxX2 <= 2 * width && minY2 >= 0 && maxY2 <= 2 * height;
  try {
    const tree = parseFreshPcbSourceDocument(source), board = parseFreshPcbSource(source), geometry = parseFreshPcbReferenceGeometry(source);
    parseFreshPcbRouteSourceSpans(source); // Reject unknown modifiers, nested routes and inexact native quantities.
    check(board.version === 20260206, "Only the inspected KiCad 10 saved-board format is supported");
    const table = field(tree, "layers")!;
    check(canonicalJson(table.children.filter(n => n.values[0]?.value.endsWith(".Cu")).map(n => n.values[0]!.value).sort()) === canonicalJson(["B.Cu", "F.Cu"]), "Board copper inventory is not exactly F/B");
    const edgeNodes = tree.children.filter(n => field(n, "layer", true)?.values[0]?.value === "Edge.Cuts");
    const edges = edgeNodes.flatMap(n => { check(["gr_line", "gr_rect"].includes(n.name) && n.values.length === 0
      && n.children.every(child => ["start","end","stroke","width","fill","layer","uuid","tstamp","locked"].includes(child.name)), "Unsupported board outline");
      const a = values(field(n, "start")!, 2), b = values(field(n, "end")!, 2);
      return n.name === "gr_line" ? [[a, b]] : [[a, [b[0], a[1]]], [[b[0], a[1]], b], [b, [a[0], b[1]]], [[a[0], b[1]], a]];
    });
    const edgeKey = (e: number[][]) => e.map(p => p.join(",")).sort().join(";");
    check(canonicalJson(edges.map(e => edgeKey(e as number[][])).sort()) === canonicalJson([[[0,0],[width,0]],[[width,0],[width,height]],[[width,height],[0,height]],[[0,height],[0,0]]].map(edgeKey).sort()), "Saved outline differs from the declared exact rectangle");
    counts.tracks = geometry.segments.length; counts.vias = board.vias.length; counts.zones = geometry.zones.length;
    check(counts.tracks <= FRESH_HEADER_SERVICE_LIMITS.tracks && counts.vias <= FRESH_HEADER_SERVICE_LIMITS.vias && counts.zones <= FRESH_HEADER_SERVICE_LIMITS.zones, "Copper inventory exceeds audit bounds");
    for (const detail of geometry.issues) unknown.push({ code: "UNSUPPORTED_SOURCE", id: null, detail });
    for (const item of geometry.unsupportedRouteItems.filter(item => item.kind !== "via")) unknown.push({ code: "UNSUPPORTED_ROUTE", id: null, detail: item.reason });
    const pads: Pad[] = [];
    for (const fp of board.footprints) {
      const node = tree.children.find(n => n.name === "footprint" && field(n, "uuid", true)?.values[0]?.value === fp.id);
      check(node !== undefined && ["F.Cu", "B.Cu"].includes(fp.layer), "Footprint source identity/layer unsupported");
      const jumpers = field(node, "duplicate_pad_numbers_are_jumpers", true);
      if (jumpers !== undefined && (jumpers.children.length !== 0 || jumpers.values.length !== 1 || jumpers.values[0]!.quoted || jumpers.values[0]!.value !== "no"))
        unknown.push({ code: "UNSUPPORTED_FOOTPRINT_COPPER", id: fp.id, detail: "Only the explicit duplicate-pad-jumpers no scalar is supported; no internal tie is inferred" });
      const safe = new Set(["uuid", "tstamp", "layer", "at", "descr", "tags", "property", "path", "sheetname", "sheetfile", "attr", "model", "pad", "fp_text", "fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly", "fp_curve", "embedded_fonts", "duplicate_pad_numbers_are_jumpers"]);
      for (const child of node.children) if (!safe.has(child.name) || child.name !== "pad" && child.name !== "layer"
          && (/\.Cu$/u.test(field(child, "layer", true)?.values[0]?.value??"") || field(child, "layer", true)?.values[0]?.value === "Edge.Cuts"))
        unknown.push({ code: "UNSUPPORTED_FOOTPRINT_COPPER", id: fp.id, detail: `Unmodeled footprint field/graphic ${child.name}` });
      for (const pad of fp.pads) {
        check(++counts.pads <= FRESH_HEADER_SERVICE_LIMITS.pads, "Pad inventory exceeds audit bound");
        try { const padNode = node.children.find(n => n.name === "pad" && field(n, "uuid", true)?.values[0]?.value === pad.physical.id); check(padNode !== undefined, "Pad source UUID is missing"); pads.push(sourcePad(padNode, node, pad, fp.reference)); }
        catch (error) { unknown.push({ code: "UNSUPPORTED_PAD", id: pad.physical.id, detail: String(error) }); }
      }
    }
    const permittedPads = new Set<string>();
    for (const declared of policy.headerPads) {
      const pad = pads.find(p => p.id === declared.uuid);
      if (!pad || !pad.copper || pad.reference !== declared.reference || pad.pin !== declared.pin || pad.net === null) { unknown.push({ code: "HEADER_PAD_MISMATCH", id: declared.uuid, detail: "Declared header terminal is not exact saved copper" }); continue; }
      const ownSide = declared.reference === policy.left.reference ? pad.center.x < left : pad.center.x > right;
      if (!ownSide) unknown.push({ code: "HEADER_PAD_OUTSIDE_OWN_STRIP", id: pad.id, detail: "Header terminal does not occupy its declared side" });
      else if (declared.reference === policy.left.reference ? 2*pad.center.x+pad.width > 2*right : 2*pad.center.x-pad.width < 2*left)
        unknown.push({ code: "HEADER_PAD_OVERLAPS_OPPOSITE_STRIP", id: pad.id, detail: "A declared header land cannot exempt copper in the opposite service strip" });
      else permittedPads.add(pad.id);
    }
    for (const pad of pads) {
      if (!pad.copper) continue;
      const x0 = 2 * pad.center.x - pad.width, x1 = 2 * pad.center.x + pad.width;
      if (!bounded(x0,x1,2*pad.center.y-pad.height,2*pad.center.y+pad.height)) violations.push({ code: "COPPER_OUTSIDE_BOARD", id: pad.id, detail: "Pad copper exceeds declared board rectangle" });
      if (intrudes(x0,x1) && !permittedPads.has(pad.id)) violations.push({ code: "PAD_IN_SERVICE_STRIP", id: pad.id, detail: "Nonexempt pad copper enters a service strip" });
    }
    const accepted = new Set<string>();
    for (const lead of policy.leads) {
      const pad = pads.find(p => p.id === lead.padUuid), start = nmPoint(lead.start), end = nmPoint(lead.end), w = routeSourceMmToNativeNm(lead.widthMm);
      const direction = pad?.reference === policy.left.reference ? 1 : -1;
      if (!pad || !permittedPads.has(pad.id) || pad.net !== lead.net || !pad.layers.includes(lead.layer)
          || start.y !== end.y || direction * (end.x-start.x) <= 0 || !inPad(pad,2*start.x,2*start.y)
          || 2*end.x-w < 2*left || 2*end.x+w > 2*right
          || !fullWidthContact(pad,start,end,w,direction)) {
        unknown.push({ code: "INVALID_OWN_LEAD_PERMISSION", id: lead.padUuid, detail: "Own lead lacks exact terminal/net/layer, inward geometry or full-width copper contact outside its drill" }); continue;
      }
      const matches = geometry.segments.filter(t => t.netName === lead.net && t.layer === lead.layer && t.widthNm === w
        && (samePoint(t.startNm,start) && samePoint(t.endNm,end) || samePoint(t.startNm,end) && samePoint(t.endNm,start)));
      if (matches.length > 1 || matches.some(t => accepted.has(t.uuid))) { unknown.push({ code: "AMBIGUOUS_OWN_LEAD", id: lead.padUuid, detail: "Permission maps to duplicate geometry/permission" }); continue; }
      if (matches[0]) { accepted.add(matches[0].uuid); permittedTrackIds.push(matches[0].uuid); }
    }
    for (const t of geometry.segments) {
      const x0=2*Math.min(t.startNm.x,t.endNm.x)-t.widthNm,x1=2*Math.max(t.startNm.x,t.endNm.x)+t.widthNm;
      if (!bounded(x0,x1,2*Math.min(t.startNm.y,t.endNm.y)-t.widthNm,2*Math.max(t.startNm.y,t.endNm.y)+t.widthNm)) violations.push({code:"COPPER_OUTSIDE_BOARD",id:t.uuid,detail:"Track capsule exceeds board rectangle"});
      if (intrudes(x0,x1) && !accepted.has(t.uuid)) violations.push({code:"TRACK_IN_SERVICE_STRIP",id:t.uuid,detail:"Finite-width track capsule enters a strip without an exact own-pad lead permission"});
    }
    for (const via of board.vias) {
      const x=routeSourceMmToNativeNm(via.at.x),y=routeSourceMmToNativeNm(via.at.y),d=routeSourceMmToNativeNm(via.diameterMm);
      if (!bounded(2*x-d,2*x+d,2*y-d,2*y+d)) violations.push({code:"COPPER_OUTSIDE_BOARD",id:via.id,detail:"Via annulus exceeds board rectangle"});
      if (intrudes(2*x-d,2*x+d)) violations.push({code:"VIA_IN_SERVICE_STRIP",id:via.id,detail:"Ordinary via annulus enters a strip; no net is exempt"});
    }
    for (const zone of geometry.zones) {
      const fill = zone.settings.find(setting => setting.name === "fill");
      if (zone.status !== "supported" || zone.kind !== "copper" || !zone.filledCachePresent || zone.filledPolygons.length === 0
          || fill?.values.length !== 1 || fill.values[0]!.quoted || fill.values[0]!.value !== "yes"
          || zone.layers.length !== 1 || !["F.Cu","B.Cu"].includes(zone.layers[0]!)) {
        unknown.push({code:"UNSUPPORTED_OR_UNFILLED_ZONE",id:zone.uuid,detail:"Only complete stored single-layer straight copper fill contours are assessed"}); continue;
      }
      for (const group of zone.filledPolygons) for (const contour of group.contourGroup) counts.storedFillVertices+=contour.pointsNm?.length??0;
      check(counts.storedFillVertices<=FRESH_HEADER_SERVICE_LIMITS.contourVertices,"Stored fill vertex bound exceeded");
      const layer=zone.layers[0] as "F.Cu"|"B.Cu", nativeLayer=layer==="F.Cu"?"BL_F_Cu":"BL_B_Cu";
      // Private same-source second encoding ONLY to reuse the bounded pure
      // fracture/hole normalizer. It is not a native observation or independent
      // comparison. No native/verified identity or status escapes this adapter.
      const normalized=assessFreshPlaneFilledGeometry({savedZone:zone,layer,nativeZone:{id:{value:zone.uuid},type:"ZT_COPPER",layers:[nativeLayer],filled:true,
        filled_polygons:[{layer:nativeLayer,shapes:{polygons:zone.filledPolygons.map(group=>({outline:{closed:true,nodes:group.contourGroup[0]!.pointsNm!.map(p=>({point:{x_nm:String(p.x),y_nm:String(p.y)}}))}}))}}]}});
      if(normalized.status!=="verified"){unknown.push({code:"UNSUPPORTED_FILL",id:zone.uuid,detail:normalized.issues.join("; ")});continue;}
      // A normalized outer boundary outside a full-height side strip proves
      // positive-area copper there; strict interior holes cannot erase its edge.
      if(normalized.components.some(c=>c.outer.some(p=>intrudes(2*p.x,2*p.x)))) violations.push({code:"FILL_IN_SERVICE_STRIP",id:zone.uuid,detail:"Normalized stored copper fill enters a service strip; GND is not exempt"});
      if(normalized.components.some(c=>c.outer.some(p=>!bounded(2*p.x,2*p.x,2*p.y,2*p.y)))) violations.push({code:"COPPER_OUTSIDE_BOARD",id:zone.uuid,detail:"Normalized stored fill exceeds the declared rectangle"});
    }
  } catch (error) { unknown.push({ code: "UNSUPPORTED_SOURCE", id: null, detail: error instanceof Error ? error.message : "Source parsing failed" }); }
  return finish();
}
