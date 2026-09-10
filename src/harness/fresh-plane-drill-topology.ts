import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import { isSavedFreshPlaneEvidence, type SavedFreshPlaneEvidence } from "./fresh-plane-evidence.js";
import { assessFreshPlaneFilledGeometry, type FreshPlaneFilledComponent } from "./fresh-plane-filled-geometry.js";
import { parseFreshPcbReferenceGeometry, parseFreshPcbRouteSourceSpans, parseFreshPcbSource, type FreshReferencePointNm } from "./fresh-kicad-parser.js";
import { freezePcbPlaneArtifact } from "./pcb-design-plane-contract.js";

type Point = FreshReferencePointNm;
type Obj = Record<string, unknown>;
interface Atom { value: string; quoted: boolean }
interface Form { name: string; atoms: Atom[]; children: Form[] }
interface Box { minX: number; minY: number; maxX: number; maxY: number }
interface Bore { uuid: string; kind: "pad" | "via"; netName: string | null; centerNm: Point; diameterNm: number }
export interface FreshPlaneDrillBore extends Bore {
  /** An outward circle enclosure; containment is NOT asserted for the exact-circle basis. */
  readonly enclosureNm: Readonly<Box>;
  readonly classification: "outside_component" | "inside_cached_hole" | "new_interior_void";
  readonly classificationBasis: "strict_outward_enclosure" | "exact_circle_inside_cached_hole";
  readonly geometrySource: "exact-source-and-native-pad" | "exact-saved-through-via";
}
export interface FreshPlaneDrillTopologyAssessment {
  readonly schemaVersion: "evleda.fresh-plane-drill-topology.v1";
  readonly status: "verified" | "unknown";
  readonly issues: readonly string[];
  readonly savedEvidenceIdentity: CanonicalIdentity | null;
  readonly savedPcbIdentity: ContentIdentity | null;
  readonly cachedGeometryIdentity: CanonicalIdentity | null;
  readonly zoneUuid: string | null;
  readonly layer: "F.Cu" | "B.Cu";
  readonly planarInteriorConnected: true | null;
  readonly cachedAreaTwiceNm2: string | null;
  readonly conservativeAreaLowerBoundTwiceNm2: string | null;
  readonly areaMeaning: "stored-zone-fill-and-conservative-drill-subtracted-lower-bound";
  readonly bores: readonly FreshPlaneDrillBore[];
  readonly inventory: Readonly<{ sourcePadCount: number; nativePadCount: number; sourceViaCount: number; boreCount: number; complete: boolean }>;
  readonly physicalConnectivity: "not_assessed";
  readonly actualMinimumCopperWidth: "not_assessed";
  readonly terminalContactContinuity: "not_assessed";
  readonly bounds: Readonly<{ predicateOperations: number; maximumBores: 4096; maximumPredicateOperations: 4000000 }>;
  readonly identity: CanonicalIdentity;
}
const MAX_COORD = 2_000_000_000, MAX_BORES = 4096, MAX_WORK = 4_000_000;
const PAD_FIELDS = new Set(["at", "size", "drill", "layers", "net", "uuid", "tstamp", "roundrect_rratio", "pinfunction", "pintype",
  "solder_mask_margin", "solder_paste_margin", "solder_paste_margin_ratio", "die_length", "locked", "remove_unused_layers",
  "zone_connect", "thermal_gap", "thermal_bridge_width", "thermal_bridge_angle"]);
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function obj(value: unknown, label: string): Obj { check(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`); return value as Obj; }
function keys(value: Obj, allowed: readonly string[]) { check(Object.keys(value).every(key => allowed.includes(key)), "Unsupported native drill geometry fields"); }
function array(value: unknown, label: string): readonly unknown[] { check(Array.isArray(value) && value.length <= MAX_BORES, `${label} exceeds inventory bounds`); return value; }
function unique(values: readonly string[], label: string) { check(new Set(values).size === values.length, `${label} has duplicate identities`); }
function coordinate(value: number): number { check(Number.isSafeInteger(value) && Math.abs(value) <= MAX_COORD, "Coordinate/dimension exceeds exact integer-nanometre bounds"); return value === 0 ? 0 : value; }
function nativeInteger(value: unknown): number {
  if (value === undefined) return 0;
  check(typeof value === "string" && /^(?:0|-?[1-9]\d*)$/u.test(value) && value.length <= 11 || typeof value === "number" && Number.isSafeInteger(value), "Native drill scalar is not an exact integer");
  return coordinate(Number(value));
}
function nativePoint(value: unknown): Point { const p = obj(value, "native point"); keys(p, ["x_nm", "y_nm"]); return { x: nativeInteger(p.x_nm), y: nativeInteger(p.y_nm) }; }

/** Preserve source decimal atoms: the ordinary projection uses binary64 and is insufficient for an exact bore proof. */
function forms(source: string): Form {
  check(typeof source === "string" && source.isWellFormed() && Buffer.byteLength(source) <= 8 * 1024 * 1024, "Source exceeds bounded drill-reader support");
  let i = 0, count = 0;
  const ws = () => { while (i < source.length && /[ \t\r\n]/u.test(source[i]!)) i++; };
  const atom = (): Atom => {
    ws(); const quoted = source[i] === '"'; let value = "";
    if (quoted) {
      i++;
      while (i < source.length) {
        const c = source[i++]!;
        if (c === '"') return { value, quoted };
        if (c === "\\") { check(i < source.length, "Unclosed string escape"); value += source[i++]!; }
        else value += c;
        check(value.length <= 65536, "Source atom bound exceeded");
      }
      throw new Error("Unclosed source string");
    }
    while (i < source.length && !/[ \t\r\n()"]/u.test(source[i]!)) { value += source[i++]!; check(value.length <= 65536, "Source atom bound exceeded"); }
    check(value.length > 0 && !/[;\x00-\x1f]/u.test(value), "Invalid source atom"); return { value, quoted };
  };
  const form = (depth: number): Form => {
    check(depth <= 64 && ++count <= 100_000 && source[i++] === "(", "Source form bound or syntax violated");
    const head = atom(); check(!head.quoted, "Quoted source field name");
    const node: Form = { name: head.value, atoms: [], children: [] };
    while (true) { ws(); check(i < source.length, "Unclosed source form"); if (source[i] === ")") { i++; return node; }
      if (source[i] === "(") node.children.push(form(depth + 1)); else node.atoms.push(atom()); }
  };
  ws(); const root = form(0); ws(); check(i === source.length && root.name === "kicad_pcb", "Expected one complete PCB source"); return root;
}
function field(form: Form, name: string, optional = false): Form | null {
  const matches = form.children.filter(child => child.name === name); check(matches.length === 1 || optional && matches.length === 0, `Missing or repeated source ${name}`); return matches[0] ?? null;
}
function scalar(form: Form): Atom { check(form.children.length === 0 && form.atoms.length === 1, `Invalid source ${form.name} scalar`); return form.atoms[0]!; }
function exact(atom: Atom, places = 6): number {
  check(!atom.quoted && atom.value.length <= 128, "Quoted or oversized source dimension");
  const m = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/u.exec(atom.value); check(m !== null, "Invalid exact source dimension");
  const power = places + Number(m[4] ?? 0) - (m[3]?.length ?? 0); check(Number.isSafeInteger(power) && Math.abs(power) <= 100, "Source exponent outside bound");
  let n = BigInt(m[2]! + (m[3] ?? ""));
  if (power >= 0) n *= 10n ** BigInt(power); else { const d = 10n ** BigInt(-power); check(n % d === 0n, "Source is not exactly integer nanometres"); n /= d; }
  if (m[1] === "-") n = -n;
  check(n >= -BigInt(MAX_COORD) && n <= BigInt(MAX_COORD), "Source dimension outside bounds"); return Number(n);
}
function sourcePoint(form: Form, angle = false): Point {
  check(form.children.length === 0 && (form.atoms.length === 2 || angle && form.atoms.length === 3), "Unsupported source position form");
  return { x: exact(form.atoms[0]!), y: exact(form.atoms[1]!) };
}
function id(form: Form): string {
  const nodes = form.children.filter(child => child.name === "uuid" || child.name === "tstamp"); check(nodes.length === 1, "Source object identity is missing or ambiguous");
  const value = scalar(nodes[0]!).value; check(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value), "Source UUID is not canonical"); return value;
}

function collectBores(source: string, saved: SavedFreshPlaneEvidence) {
  const board = parseFreshPcbSource(source), root = forms(source), routes = parseFreshPcbRouteSourceSpans(source);
  const inventory = saved.stage.nativePads.inventory; check(inventory !== null, "Complete staged native PAD inventory is unavailable");
  const rawPads = array(saved.stage.nativePads.rawSnapshot.padRecords, "Native PAD records").map(value => obj(value, "native PAD"));
  const nativeById = new Map(rawPads.map(raw => [String(obj(raw.id, "native PAD ID").value), raw]));
  const sourcePads = board.footprints.flatMap(fp => fp.pads), sourceIds = sourcePads.map(p => p.physical.id);
  check(sourceIds.every((id): id is string => id !== null) && nativeById.size === rawPads.length && rawPads.length === sourcePads.length
    && sourceIds.every(id => nativeById.has(id)) && inventory.physicalPads.length === rawPads.length
    && same([...inventory.physicalPads.map(p => p.uuid)].sort(), [...nativeById.keys()].sort()), "Source/staged PAD inventories are incomplete or differ");
  unique(sourceIds as string[], "Source PAD inventory");
  check(board.footprints.every(fp => fp.id !== null) && same(board.footprints.map(fp => fp.id).sort(), [...inventory.footprintUuids].sort()), "Source/native footprint inventory differs");
  const footprints = root.children.filter(node => node.name === "footprint"), vias = root.children.filter(node => node.name === "via"), bores: Bore[] = [];
  check(footprints.length === board.footprints.length && vias.length === board.vias.length && vias.length === routes.filter(route => route.kind === "via").length, "Complete source footprint/via inventory differs");
  let padCount = 0;
  const visit = (node: Form, parent: Form | null, grandparent: Form | null): void => {
    if (node.name === "pad") check(parent?.name === "footprint" && grandparent === root, "Nested or non-footprint PAD is outside drill scope");
    if (node.name === "via") check(parent === root, "Nested VIA is outside drill scope");
    if (node.name === "drill") check(parent?.name === "pad" || parent?.name === "via", "Unattributed drill source form");
    if (/^(?:secondary_drill|tertiary_drill|backdrill|front_post_machining|back_post_machining)$/u.test(node.name)) throw new Error("Unsupported additional drilling/machining source form");
    for (const child of node.children) visit(child, node, parent);
  };
  visit(root, null, null);
  for (const footprint of footprints) {
    const fpId = id(footprint), knownFp = board.footprints.find(fp => fp.id === fpId); check(knownFp !== undefined, "Source footprint ownership differs");
    const at = field(footprint, "at")!, origin = sourcePoint(at, true);
    const angle = at.atoms.length === 3 ? exact(at.atoms[2]!, 0) : 0, rotation = ((angle % 360) + 360) % 360;
    for (const pad of footprint.children.filter(node => node.name === "pad")) {
      padCount++; const uuid = id(pad), raw = nativeById.get(uuid), known = knownFp.pads.find(p => p.physical.id === uuid);
      check(raw !== undefined && known !== undefined, "Native PAD/source footprint ownership mismatch");
      check(pad.atoms.length === 3 && pad.children.every(child => PAD_FIELDS.has(child.name)), "Unsupported source PAD fields or geometry");
      const physical = inventory.physicalPads.find(p => p.uuid === uuid)!;
      check(physical.footprintUuid === fpId && physical.reference === knownFp.reference && physical.number === known.number && physical.netName === known.netName,
        "Staged PAD ownership/net differs from exact source inventory");
      const stack = obj(raw.pad_stack, "native pad stack"), drill = obj(stack.drill, "native drill");
      keys(drill, ["diameter", "shape", "start_layer", "end_layer"]);
      for (const name of ["secondary_drill", "tertiary_drill", "front_post_machining", "back_post_machining", "front_outer_layers", "back_outer_layers"]) check(stack[name] === undefined || same(stack[name], {}), "Additional native drilling/machining is unsupported");
      const diameter = nativePoint(drill.diameter), sourceDrill = field(pad, "drill", true);
      if (sourceDrill === null) {
        check(pad.atoms[1]?.value === "smd" && raw.type === "PT_SMD" && diameter.x === 0 && diameter.y === 0, "Unsupported drilled/undrilled PAD disposition"); continue;
      }
      check(pad.atoms[1]?.value === "thru_hole" && raw.type === "PT_PTH" && stack.type === "PST_NORMAL", "Only ordinary circular through-hole PAD bores are supported");
      check(sourceDrill.atoms.length === 1 && sourceDrill.children.every(child => child.name === "offset"), "Slots or unsupported drill forms require explicit geometry");
      const size = exact(sourceDrill.atoms[0]!); check(size > 0 && diameter.x === size && diameter.y === size && drill.shape === "DS_CIRCLE"
        && drill.start_layer === "BL_F_Cu" && drill.end_layer === "BL_B_Cu", "Native/source circular through-drill dimensions or span differ");
      const offset = field(sourceDrill, "offset", true); if (offset) { const p = sourcePoint(offset); check(p.x === 0 && p.y === 0, "Offset bore/copper projection is unsupported"); }
      for (const layer of array(stack.copper_layers, "native pad templates")) { const p = nativePoint(obj(layer, "native template").offset ?? {}); check(p.x === 0 && p.y === 0, "Nonzero native copper/drill offset is unsupported"); }
      check([0, 90, 180, 270].includes(rotation) && knownFp.layer === "F.Cu", "Unsupported footprint projection for exact circular drill center");
      const relative = sourcePoint(field(pad, "at")!, true);
      const local = rotation === 0 ? relative : rotation === 90 ? { x: relative.y, y: -relative.x } : rotation === 180 ? { x: -relative.x, y: -relative.y } : { x: -relative.y, y: relative.x };
      const centerNm = { x: coordinate(origin.x + local.x), y: coordinate(origin.y + local.y) };
      check(same(centerNm, nativePoint(raw.position)), "Native/source PAD center differs in exact integer nanometres");
      bores.push({ uuid, kind: "pad", netName: known.netName, centerNm, diameterNm: size });
    }
  }
  check(padCount === rawPads.length, "Source PAD form inventory is incomplete");
  for (const via of vias) {
    const uuid = id(via), known = board.vias.find(v => v.id === uuid); check(known !== undefined, "Via identity projection differs");
    // parseFreshPcbRouteSourceSpans above enforces exact closed through-via
    // grammar, including no bare blind/micro tokens or auxiliary drill forms.
    bores.push({ uuid, kind: "via", netName: known.netName, centerNm: sourcePoint(field(via, "at")!), diameterNm: exact(scalar(field(via, "drill")!)) });
  }
  check(bores.length <= MAX_BORES, "Aggregate bore inventory bound exceeded"); unique(bores.map(bore => bore.uuid), "Bore inventory");
  return { bores, sourcePadCount: padCount, nativePadCount: rawPads.length, sourceViaCount: vias.length };
}

const cross = (a: Point, b: Point, p: Point) => BigInt(b.x - a.x) * BigInt(p.y - a.y) - BigInt(b.y - a.y) * BigInt(p.x - a.x);
const edges = (ring: readonly Point[]) => ring.map((a, i) => ({ a, b: ring[(i + 1) % ring.length]! }));
const on = (p: Point, a: Point, b: Point) => p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x) && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y) && cross(a, b, p) === 0n;
function intersects(a: Point, b: Point, c: Point, d: Point) {
  const p = cross(a, b, c), q = cross(a, b, d), r = cross(c, d, a), s = cross(c, d, b);
  return p === 0n && on(c, a, b) || q === 0n && on(d, a, b) || r === 0n && on(a, c, d) || s === 0n && on(b, c, d)
    || (p < 0n && q > 0n || p > 0n && q < 0n) && (r < 0n && s > 0n || r > 0n && s < 0n);
}
function boxPoints(box: Box): Point[] { return [{ x: box.minX, y: box.minY }, { x: box.maxX, y: box.minY }, { x: box.maxX, y: box.maxY }, { x: box.minX, y: box.maxY }]; }
function inside(p: Point, ring: readonly Point[], step: () => void) {
  let result = false;
  for (const { a, b } of edges(ring)) { step(); check(!on(p, a, b), "Bore enclosure touches a cached boundary");
    if ((a.y > p.y) !== (b.y > p.y) && (b.y > a.y) === (cross(a, b, p) > 0n)) result = !result; }
  return result;
}
function circleInsideHole(bore: Bore, hole: readonly Point[], step: () => void): boolean {
  if (!inside(bore.centerNm, hole, step)) return false;
  const diameterSquared = BigInt(bore.diameterNm) ** 2n;
  for (const { a, b } of edges(hole)) {
    step();
    const dx = BigInt(b.x - a.x), dy = BigInt(b.y - a.y), px = BigInt(bore.centerNm.x - a.x), py = BigInt(bore.centerNm.y - a.y);
    const lengthSquared = dx * dx + dy * dy, projection = px * dx + py * dy;
    check(lengthSquared > 0n, "Degenerate cached hole boundary");
    if (projection <= 0n) { if (4n * (px * px + py * py) < diameterSquared) return false; }
    else if (projection >= lengthSquared) {
      const qx = BigInt(bore.centerNm.x - b.x), qy = BigInt(bore.centerNm.y - b.y);
      if (4n * (qx * qx + qy * qy) < diameterSquared) return false;
    } else {
      const determinant = dx * py - dy * px;
      if (4n * determinant * determinant < diameterSquared * lengthSquared) return false;
    }
  }
  // Equality is sound here: the closed circle stays in an already excluded
  // hole. It does not relax new-hole separation or permit a copper pinch.
  return true;
}
function classify(bore: Bore, box: Box, component: FreshPlaneFilledComponent, step: () => void): Pick<FreshPlaneDrillBore, "classification" | "classificationBasis"> {
  // Native ERROR_OUTSIDE hole polygons can contain the actual round bore even
  // when its axis-aligned enclosure crosses their oblique polygon edges.
  if (component.holes.some(hole => circleInsideHole(bore, hole, step))) return { classification: "inside_cached_hole", classificationBasis: "exact_circle_inside_cached_hole" };
  const rectangle = boxPoints(box), boundaries = [component.outer, ...component.holes];
  for (const ring of boundaries) {
    for (const a of edges(rectangle)) for (const b of edges(ring)) { step(); check(!intersects(a.a, a.b, b.a, b.b), "Bore enclosure intersects/touches a cached boundary or hole"); }
    // No intersections alone cannot distinguish disjoint from enclosure of an
    // entire cached component/hole. Such topology changes remain unknown.
    check(!inside(ring[0]!, rectangle, step), "Bore enclosure surrounds a cached boundary/hole");
  }
  const classification = !inside(rectangle[0]!, component.outer, step) ? "outside_component"
    : component.holes.some(hole => inside(rectangle[0]!, hole, step)) ? "inside_cached_hole" : "new_interior_void";
  return { classification, classificationBasis: "strict_outward_enclosure" };
}

/** Proves only preservation of the single zone interior after boring. It neither
 * adds PAD/track/barrel copper nor establishes terminal contacts or width. The
 * owning host must independently keep the saved witness/session/settings current.
 */
export function assessFreshPlaneDrillTopology(input: { readonly savedEvidence: SavedFreshPlaneEvidence; readonly pcbSource: string; readonly layer: "F.Cu" | "B.Cu" }): FreshPlaneDrillTopologyAssessment {
  const { savedEvidence, pcbSource, layer } = input;
  let witness: CanonicalIdentity | null = null, sourceIdentity: ContentIdentity | null = null, geometryIdentity: CanonicalIdentity | null = null, zoneUuid: string | null = null;
  let cachedArea: string | null = null, lower: string | null = null, operations = 0;
  let inventory = { sourcePadCount: 0, nativePadCount: 0, sourceViaCount: 0, boreCount: 0, complete: false };
  const bores: FreshPlaneDrillBore[] = [];
  const finish = (issues: string[]): FreshPlaneDrillTopologyAssessment => {
    const body = { schemaVersion: "evleda.fresh-plane-drill-topology.v1" as const, status: issues.length ? "unknown" as const : "verified" as const,
      issues, savedEvidenceIdentity: witness, savedPcbIdentity: sourceIdentity, cachedGeometryIdentity: geometryIdentity, zoneUuid, layer,
      planarInteriorConnected: issues.length ? null : true as const, cachedAreaTwiceNm2: cachedArea, conservativeAreaLowerBoundTwiceNm2: issues.length ? null : lower,
      areaMeaning: "stored-zone-fill-and-conservative-drill-subtracted-lower-bound" as const, bores, inventory,
      physicalConnectivity: "not_assessed" as const, actualMinimumCopperWidth: "not_assessed" as const, terminalContactContinuity: "not_assessed" as const,
      bounds: { predicateOperations: operations, maximumBores: 4096 as const, maximumPredicateOperations: 4000000 as const } };
    return freezePcbPlaneArtifact({ ...body, identity: canonicalIdentity(body, body.schemaVersion) });
  };
  const step = () => check(++operations <= MAX_WORK, "Drill topology predicate work bound exhausted");
  try {
    check(isSavedFreshPlaneEvidence(savedEvidence), "A genuine current-session saved plane witness is required");
    const saved = savedEvidence; witness = saved.identity;
    check(typeof pcbSource === "string" && Buffer.byteLength(pcbSource) <= 8 * 1024 * 1024, "PCB source bound exceeded");
    sourceIdentity = contentIdentity(pcbSource); check(same(sourceIdentity, saved.savedPcbIdentity), "Exact saved PCB source differs from the witness");
    check(layer === "F.Cu" || layer === "B.Cu", "Unsupported selected plane layer");
    zoneUuid = saved.stage.targetZoneUuid;
    const zones = parseFreshPcbReferenceGeometry(pcbSource).zones.filter(zone => zone.uuid === zoneUuid), natives = saved.stage.nativeFilledZones.filter(zone => zone.uuid === zoneUuid);
    check(zones.length === 1 && natives.length === 1, "Target source/native zone inventory is ambiguous");
    const geometry = assessFreshPlaneFilledGeometry({ savedZone: zones[0]!, nativeZone: natives[0]!.raw, layer });
    geometryIdentity = geometry.sourceGeometryIdentity;
    check(geometry.status === "verified" && geometry.geometryEquivalent && geometry.components.length === 1, "One exact normalized source/native filled component is required");
    const component = geometry.components[0]!; cachedArea = component.areaTwiceNm2;
    const captured = collectBores(pcbSource, saved);
    inventory = { sourcePadCount: captured.sourcePadCount, nativePadCount: captured.nativePadCount, sourceViaCount: captured.sourceViaCount, boreCount: captured.bores.length, complete: true };
    const newVoids: Box[] = []; let removedArea = 0n;
    for (const bore of captured.bores) {
      const radius = Math.ceil(bore.diameterNm / 2), p = bore.centerNm;
      const enclosureNm = { minX: coordinate(p.x - radius), minY: coordinate(p.y - radius), maxX: coordinate(p.x + radius), maxY: coordinate(p.y + radius) };
      const { classification, classificationBasis } = classify(bore, enclosureNm, component, step);
      if (classification === "new_interior_void") {
        for (const prior of newVoids) { step(); check(enclosureNm.maxX < prior.minX || prior.maxX < enclosureNm.minX || enclosureNm.maxY < prior.minY || prior.maxY < enclosureNm.minY, "New bore enclosures touch, overlap, or merge"); }
        newVoids.push(enclosureNm); removedArea += 2n * BigInt(enclosureNm.maxX - enclosureNm.minX) * BigInt(enclosureNm.maxY - enclosureNm.minY);
      }
      bores.push({ ...bore, enclosureNm, classification, classificationBasis, geometrySource: bore.kind === "pad" ? "exact-source-and-native-pad" : "exact-saved-through-via" });
    }
    const lowerArea = BigInt(cachedArea) - removedArea; check(lowerArea > 0n, "Conservative retained area is nonpositive"); lower = String(lowerArea);
    // Strictly interior disjoint boxes contain every newly removed disk. Each
    // actual bore is therefore a disjoint interior hole; subtraction preserves
    // the simple outer-minus-holes component's connected open interior.
    return finish([]);
  } catch (error) { return finish([error instanceof Error ? error.message : "Unsupported drill geometry"]); }
}
