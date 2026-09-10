import { canonicalIdentity, canonicalJson } from "../core/canonical.js";
import { hardenPortableValue } from "../core/portable-artifact.js";
import type { CanonicalIdentity } from "../domain/types.js";
import type { FreshReferencePointNm, FreshReferenceZone } from "./fresh-kicad-parser.js";
import { freezePcbPlaneArtifact } from "./pcb-design-plane-contract.js";

type Point = FreshReferencePointNm;
type Obj = Record<string, unknown>;
interface Edge { a: Point; b: Point }
interface Region { index: number; outer: Point[]; holes: Point[][]; area: bigint }
interface Ring { points: Point[]; area: bigint }

export const FRESH_PLANE_FILLED_GEOMETRY_LIMITS = Object.freeze({
  coordinateMagnitudeNm: 2_000_000_000, aggregateVertices: 8192, predicateOperations: 4_000_000,
});
export interface FreshPlaneFilledComponent {
  /** Original index in the selected native layer's shapes.polygons, never a component identifier. */
  readonly nativePolygonIndex: number;
  readonly outer: readonly Point[];
  readonly holes: readonly (readonly Point[])[];
  readonly areaTwiceNm2: string;
  readonly topologyCertificate: "simple_outer_minus_strict_disjoint_holes";
}
export interface FreshPlaneFilledGeometryAssessment {
  readonly status: "verified" | "not_verified";
  readonly issues: readonly string[];
  readonly geometryEquivalent: boolean;
  readonly sourceGeometryIdentity: CanonicalIdentity | null;
  readonly nativeGeometryIdentity: CanonicalIdentity | null;
  readonly components: readonly FreshPlaneFilledComponent[];
  readonly bounds: Readonly<{ aggregateVertices: number; predicateOperations: number; limits: typeof FRESH_PLANE_FILLED_GEOMETRY_LIMITS }>;
}

function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function obj(value: unknown, label: string): Obj {
  check(value !== null && typeof value === "object" && !Array.isArray(value), `${label}: expected an object`); return value as Obj;
}
function keys(value: Obj, required: readonly string[], optional: readonly string[] = []) {
  check(required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key)), "Unsupported or missing geometry fields (including arcs)");
}
function arr(value: unknown, label: string): unknown[] {
  check(Array.isArray(value) && value.length <= FRESH_PLANE_FILLED_GEOMETRY_LIMITS.aggregateVertices, `${label}: array exceeds geometry bound or is missing`); return value;
}
class Work {
  vertices = 0;
  operations = 0;
  step() { check(++this.operations <= FRESH_PLANE_FILLED_GEOMETRY_LIMITS.predicateOperations, "Filled geometry predicate work bound exhausted"); }
  points(count: number) { this.vertices += count; check(this.vertices <= FRESH_PLANE_FILLED_GEOMETRY_LIMITS.aggregateVertices, "Aggregate source/native vertex bound exceeded"); }
}
const key = (p: Point) => `${p.x},${p.y}`;
const equal = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
const compare = (a: Point, b: Point) => a.x - b.x || a.y - b.y;
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const cross = (a: Point, b: Point, c: Point) => BigInt(b.x - a.x) * BigInt(c.y - a.y) - BigInt(b.y - a.y) * BigInt(c.x - a.x);
const abs = (n: bigint) => n < 0n ? -n : n;
const signedArea = (points: readonly Point[]) => points.reduce((area, a, i) => {
  const b = points[(i + 1) % points.length]!; return area + BigInt(a.x) * BigInt(b.y) - BigInt(a.y) * BigInt(b.x);
}, 0n);
const edges = (points: readonly Point[]): Edge[] => points.map((a, i) => ({ a, b: points[(i + 1) % points.length]! }));
function onSegment(p: Point, a: Point, b: Point) {
  return p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x) && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y) && cross(a, b, p) === 0n;
}
function intersects(a: Edge, b: Edge) {
  if (Math.max(a.a.x, a.b.x) < Math.min(b.a.x, b.b.x) || Math.max(b.a.x, b.b.x) < Math.min(a.a.x, a.b.x)
    || Math.max(a.a.y, a.b.y) < Math.min(b.a.y, b.b.y) || Math.max(b.a.y, b.b.y) < Math.min(a.a.y, a.b.y)) return false;
  const x = cross(a.a, a.b, b.a), y = cross(a.a, a.b, b.b), z = cross(b.a, b.b, a.a), w = cross(b.a, b.b, a.b);
  return x === 0n && onSegment(b.a, a.a, a.b) || y === 0n && onSegment(b.b, a.a, a.b)
    || z === 0n && onSegment(a.a, b.a, b.b) || w === 0n && onSegment(a.b, b.a, b.b)
    || (x < 0n && y > 0n || x > 0n && y < 0n) && (z < 0n && w > 0n || z > 0n && w < 0n);
}
/** An allowed adjacent intersection must be exactly one shared endpoint, never overlap. */
function endpointOnly(a: Edge, b: Edge) {
  const shared = [a.a, a.b].filter(p => equal(p, b.a) || equal(p, b.b));
  if (shared.length !== 1) return false;
  const s = shared[0]!, otherA = equal(a.a, s) ? a.b : a.a, otherB = equal(b.a, s) ? b.b : b.a;
  return !onSegment(otherA, b.a, b.b) && !onSegment(otherB, a.a, a.b);
}
/** Exact ray crossing; boundary is rejected rather than rounded into either region. */
function inside(point: Point, ring: readonly Point[], work: Work): boolean {
  let result = false;
  for (const edge of edges(ring)) {
    work.step(); check(!onSegment(point, edge.a, edge.b), "Boundary tangency or zero-width touch is unsupported");
    if ((edge.a.y > point.y) !== (edge.b.y > point.y)) {
      const orientation = cross(edge.a, edge.b, point);
      if ((edge.b.y > edge.a.y) === (orientation > 0n)) result = !result;
    }
  }
  return result;
}
function coordinate(value: unknown): number {
  check(typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= FRESH_PLANE_FILLED_GEOMETRY_LIMITS.coordinateMagnitudeNm, "Coordinate is not an exact bounded integer nanometre value"); return value;
}
function nativeCoordinate(value: unknown): number {
  if (value === undefined) return 0; // Pinned proto3 scalar zero omission.
  check(typeof value === "string" && value.length <= 11 && /^(?:0|-?[1-9]\d*)$/u.test(value), "Native coordinate must be a canonical integer string"); return coordinate(Number(value));
}
function nativeChain(value: unknown, work: Work): Point[] {
  const chain = obj(value, "native contour"); keys(chain, ["closed", "nodes"]); check(chain.closed === true, "Native contour is not explicitly closed");
  const nodes = arr(chain.nodes, "native contour nodes"); work.points(nodes.length);
  return nodes.map(value => {
    const node = obj(value, "native node"); keys(node, ["point"]);
    const point = obj(node.point, "native point"); keys(point, [], ["x_nm", "y_nm"]);
    return { x: nativeCoordinate(point.x_nm), y: nativeCoordinate(point.y_nm) };
  });
}

/** Validate before simplifying: collinear removal must not hide reversals or intersections. */
function canonicalRing(points: readonly Point[]): Point[] {
  const corners = points.filter((p, i) => cross(points[(i + points.length - 1) % points.length]!, p, points[(i + 1) % points.length]!) !== 0n);
  check(corners.length >= 3, "Degenerate collinear cycle");
  if (signedArea(corners) < 0n) corners.reverse();
  let first = 0;
  for (let i = 1; i < corners.length; i++) if (compare(corners[i]!, corners[first]!) < 0) first = i;
  return [...corners.slice(first), ...corners.slice(0, first)];
}

/**
 * KiCad's saved filled_polygon and native fractured outline are closed walks.
 * Split only at exact existing vertices, cancel one exact reverse traversal,
 * and certify the remaining boundary. A cancelled bridge has zero area and
 * is never used as copper or as a connectivity edge between open regions.
 */
function unfracture(input: readonly Point[], work: Work): Ring[] {
  const points = [...input];
  if (points.length > 1 && equal(points[0]!, points.at(-1)!)) points.pop();
  check(points.length >= 3, "Contour requires at least three vertices");
  const vertices = [...new Map(points.map(p => [key(p), p])).values()];
  const traversals = new Map<string, Edge[]>();
  let splitCount = 0;
  for (const edge of edges(points)) {
    check(!equal(edge.a, edge.b), "Repeated consecutive vertex or zero-length edge");
    const splits: Point[] = [];
    for (const p of vertices) { work.step(); if (onSegment(p, edge.a, edge.b)) splits.push(p); }
    const direction = compare(edge.a, edge.b) < 0 ? 1 : -1;
    splits.sort((a, b) => direction * compare(a, b));
    for (let i = 1; i < splits.length; i++) {
      check(++splitCount <= FRESH_PLANE_FILLED_GEOMETRY_LIMITS.aggregateVertices * 2, "Split-edge inventory bound exceeded");
      const a = splits[i - 1]!, b = splits[i]!, id = compare(a, b) < 0 ? `${key(a)}:${key(b)}` : `${key(b)}:${key(a)}`;
      const previous = traversals.get(id) ?? [];
      check(previous.length < 2 && !previous.some(e => equal(e.a, a)), "Repeated or overlapping directed edge is ambiguous");
      previous.push({ a, b }); traversals.set(id, previous);
    }
  }
  const boundary: Edge[] = [], bridges: Edge[] = [];
  for (const entries of traversals.values()) (entries.length === 1 ? boundary : bridges).push(entries[0]!);
  check(boundary.length >= 3, "Reverse-edge cancellation leaves no filled boundary");
  const next = new Map<string, Edge>(), previous = new Map<string, Edge>();
  for (const edge of boundary) {
    check(!next.has(key(edge.a)) && !previous.has(key(edge.b)), "Boundary has a pinch, branch, or repeated vertex");
    next.set(key(edge.a), edge); previous.set(key(edge.b), edge);
  }
  check([...next.keys()].every(id => previous.has(id)), "Boundary is not a union of directed cycles");
  const remaining = new Set(next.keys()), rings: Ring[] = [], owner = new Map<string, number>();
  while (remaining.size) {
    const start = remaining.values().next().value!, cycle: Point[] = [];
    let current = start;
    do {
      check(remaining.delete(current), "Cycle revisits a vertex before closure");
      owner.set(current, rings.length);
      const edge = next.get(current)!; cycle.push(edge.a); current = key(edge.b);
    } while (current !== start);
    const area = signedArea(cycle); check(cycle.length >= 3 && area !== 0n, "Cycle is degenerate or has zero area");
    rings.push({ points: cycle, area });
  }
  // Simple cycles, including no contacts between distinct cycles.
  for (let i = 0; i < boundary.length; i++) for (let j = 0; j < i; j++) {
    work.step(); const a = boundary[i]!, b = boundary[j]!;
    check(!intersects(a, b) || owner.get(key(a.a)) === owner.get(key(b.a)) && endpointOnly(a, b), "Boundary cycles cross, overlap, or touch");
  }
  for (const bridge of bridges) for (const edge of boundary) {
    work.step(); check(!intersects(bridge, edge) || endpointOnly(bridge, edge), "Cancelled bridge crosses or overlaps a filled boundary");
  }
  for (let i = 0; i < bridges.length; i++) for (let j = 0; j < i; j++) {
    work.step(); check(!intersects(bridges[i]!, bridges[j]!) || endpointOnly(bridges[i]!, bridges[j]!), "Cancelled bridges cross or overlap ambiguously");
  }
  // Contract each residual cycle. Fracture links must form a tree with no
  // bridge-only leaves; otherwise cancellation could silently erase a spur.
  const parent = new Map<string, string>(), degree = new Map<string, number>();
  const node = (p: Point) => owner.has(key(p)) ? `ring:${owner.get(key(p))!}` : `point:${key(p)}`;
  const root = (id: string): string => {
    let cursor = id; const path: string[] = [];
    while (parent.has(cursor)) { work.step(); path.push(cursor); cursor = parent.get(cursor)!; }
    for (const entry of path) parent.set(entry, cursor);
    return cursor;
  };
  for (const bridge of bridges) {
    const a = node(bridge.a), b = node(bridge.b), ra = root(a), rb = root(b);
    check(ra !== rb, "Cancelled bridge graph contains a cycle or reconnects the same boundary");
    parent.set(ra, rb); degree.set(a, (degree.get(a) ?? 0) + 1); degree.set(b, (degree.get(b) ?? 0) + 1);
  }
  check([...degree].every(([id, count]) => id.startsWith("ring:") || count >= 2), "Cancelled bridge-only spur has no filled boundary endpoint");
  check(rings.every((_, i) => root(`ring:${i}`) === root("ring:0")), "Fractured chain has an unconnected residual cycle");
  return rings;
}

function disjointBoundaries(rings: readonly (readonly Point[])[], work: Work) {
  for (let i = 0; i < rings.length; i++) for (let j = 0; j < i; j++) {
    for (const a of edges(rings[i]!)) for (const b of edges(rings[j]!)) {
      work.step(); check(!intersects(a, b), "Distinct boundaries cross, overlap, or have a zero-width touch");
    }
  }
}
function regionsFromRings(rings: Ring[], index: number, work: Work): Region[] {
  const parents = rings.map((ring, i) => {
    const enclosing = rings.map((candidate, j) => j !== i && inside(ring.points[0]!, candidate.points, work) ? j : -1).filter(j => j >= 0);
    return enclosing.sort((a, b) => abs(rings[a]!.area) < abs(rings[b]!.area) ? -1 : 1)[0] ?? -1;
  });
  const depth = (index: number) => { let n = index, result = 0; while (parents[n] !== -1) { work.step(); n = parents[n]!; check(++result < rings.length, "Cyclic boundary nesting"); } return result; };
  for (const [i, p] of parents.entries()) if (p !== -1) check((rings[i]!.area > 0n) !== (rings[p]!.area > 0n), "Fractured nested cycles have ambiguous same-direction winding");
  return rings.flatMap((ring, i) => {
    if (depth(i) % 2 !== 0) return [];
    const holes = rings.filter((_, j) => parents[j] === i);
    const area = abs(ring.area) - holes.reduce((sum, hole) => sum + abs(hole.area), 0n);
    check(area > 0n, "Filled component has nonpositive exact area");
    return [{ index, outer: canonicalRing(ring.points), holes: holes.map(h => canonicalRing(h.points)), area }];
  });
}
// Each simple Jordan outer bounds one connected open region. Removing finitely
// many strictly interior, pairwise disjoint closed hole regions preserves
// that connectivity. Contacts are rejected; no zero-width connection counts.
function validateRegions(regions: Region[], work: Work) {
  disjointBoundaries(regions.flatMap(region => [region.outer, ...region.holes]), work);
  const contains = (point: Point, region: Region) => inside(point, region.outer, work) && !region.holes.some(hole => inside(point, hole, work));
  for (let i = 0; i < regions.length; i++) for (let j = 0; j < i; j++) {
    check(!contains(regions[i]!.outer[0]!, regions[j]!) && !contains(regions[j]!.outer[0]!, regions[i]!), "Filled component interiors overlap (nested polygons are not implicit holes)");
  }
}
function geometryIdentity(regions: Region[], layer: "F.Cu" | "B.Cu") {
  const geometry = regions.map(region => ({ outer: region.outer, holes: [...region.holes].sort((a, b) => compareText(canonicalJson(a), canonicalJson(b))), areaTwiceNm2: String(region.area) }));
  geometry.sort((a, b) => compareText(canonicalJson(a), canonicalJson(b)));
  return canonicalIdentity({ layer, components: geometry }, "evleda.fresh-plane-normalized-filled-geometry.v1");
}

/** Pure bounded geometry proof; caller separately binds native/source epochs, net and PAD contact. */
export function assessFreshPlaneFilledGeometry(input: {
  readonly nativeZone: unknown;
  readonly savedZone: FreshReferenceZone;
  readonly layer: "F.Cu" | "B.Cu";
}): FreshPlaneFilledGeometryAssessment {
  const work = new Work();
  let sourceGeometryIdentity: CanonicalIdentity | null = null, nativeGeometryIdentity: CanonicalIdentity | null = null;
  const result = (issues: string[], components: FreshPlaneFilledComponent[] = []): FreshPlaneFilledGeometryAssessment => freezePcbPlaneArtifact({
    status: issues.length ? "not_verified" : "verified", issues, geometryEquivalent: issues.length === 0,
    sourceGeometryIdentity, nativeGeometryIdentity, components,
    bounds: { aggregateVertices: work.vertices, predicateOperations: work.operations, limits: FRESH_PLANE_FILLED_GEOMETRY_LIMITS },
  });
  try {
    const snapshot = hardenPortableValue(input, { maxBytes: 8 * 1024 * 1024, maxDepth: 48, maxNodes: 150_000,
      maxArrayLength: 8192, maxOwnKeys: 64, maxStringBytes: 1024 * 1024 }) as typeof input;
    const { layer, savedZone } = snapshot;
    check(layer === "F.Cu" || layer === "B.Cu", "Unsupported selected copper layer");
    check(savedZone.status === "supported" && savedZone.kind === "copper" && savedZone.layers.length === 1 && savedZone.layers[0] === layer
      && savedZone.unknownForms.length === 0 && savedZone.filledCachePresent && savedZone.filledPolygons.length > 0, "Source zone is not a supported single-layer filled copper zone");
    const sourceIndexes = new Set<number>(), sourceRegions: Region[] = [];
    for (const group of savedZone.filledPolygons) {
      check(group.status === "supported" && group.layer === layer && group.contourGroup.length === 1 && group.unknownForms.length === 0
        && group.islandFlag.status !== "unsupported" && Number.isSafeInteger(group.index) && group.index >= 0 && !sourceIndexes.has(group.index), "Unsupported or duplicate source filled-polygon group");
      sourceIndexes.add(group.index);
      const contour = group.contourGroup[0]!;
      check(contour.status === "supported" && contour.pointsNm !== null && contour.unknownForms.length === 0, "Unsupported source filled contour");
      work.points(contour.pointsNm.length);
      const points = contour.pointsNm.map(p => { const point = obj(p, "source point"); keys(point, ["x", "y"]); return { x: coordinate(point.x), y: coordinate(point.y) }; });
      sourceRegions.push(...regionsFromRings(unfracture(points, work), group.index, work));
    }
    validateRegions(sourceRegions, work); sourceGeometryIdentity = geometryIdentity(sourceRegions, layer);
    const native = obj(snapshot.nativeZone, "native zone");
    keys(native, ["id", "type", "layers", "filled", "filled_polygons"], ["@type", "outline", "name", "copper_settings", "priority", "border", "locked", "layer_properties"]);
    const id = obj(native.id, "native zone identity"); keys(id, ["value"]);
    check(savedZone.uuid !== null && id.value === savedZone.uuid && native.type === "ZT_COPPER" && native.filled === true
      && (native["@type"] === undefined || native["@type"] === "type.googleapis.com/kiapi.board.types.Zone"), "Native zone identity, type, or filled state differs");
    const nativeLayer = layer === "F.Cu" ? "BL_F_Cu" : "BL_B_Cu";
    const layers = arr(native.layers, "native layers"), fills = arr(native.filled_polygons, "native fill layers");
    check(layers.length === 1 && layers[0] === nativeLayer && fills.length === 1, "Native zone is not the selected single filled layer");
    const fill = obj(fills[0], "native filled layer"); keys(fill, ["layer", "shapes"]); check(fill.layer === nativeLayer, "Native filled layer differs");
    const shapes = obj(fill.shapes, "native filled shapes"); keys(shapes, ["polygons"]);
    const polygons = arr(shapes.polygons, "native filled polygons"); check(polygons.length > 0, "No native filled polygons");
    const nativeRegions: Region[] = [];
    for (const [index, value] of polygons.entries()) {
      const polygon = obj(value, "native filled polygon"); keys(polygon, ["outline"], ["holes"]);
      const group = regionsFromRings(unfracture(nativeChain(polygon.outline, work), work), index, work);
      for (const value of arr(polygon.holes ?? [], "native typed holes")) {
        const rings = unfracture(nativeChain(value, work), work);
        check(rings.length === 1, "Fractured explicit hole is unsupported");
        const hole = canonicalRing(rings[0]!.points);
        disjointBoundaries([...group.flatMap(region => [region.outer, ...region.holes]), hole], work);
        const owners = group.filter(region => inside(hole[0]!, region.outer, work) && !region.holes.some(other => inside(hole[0]!, other, work)));
        check(owners.length === 1, "Explicit hole is not strictly within its own filled polygon");
        const owner = owners[0]!;
        check(!owner.holes.some(other => inside(other[0]!, hole, work)) && !group.some(region => region !== owner && inside(region.outer[0]!, hole, work)), "Explicit holes nest or swallow another component");
        owner.holes.push(hole); owner.area -= abs(rings[0]!.area);
        check(owner.area > 0n, "Explicit holes leave nonpositive component area");
      }
      nativeRegions.push(...group);
    }
    validateRegions(nativeRegions, work); nativeGeometryIdentity = geometryIdentity(nativeRegions, layer);
    const components: FreshPlaneFilledComponent[] = nativeRegions.map(region => ({ nativePolygonIndex: region.index, outer: region.outer,
      holes: region.holes.sort((a, b) => compareText(canonicalJson(a), canonicalJson(b))), areaTwiceNm2: String(region.area),
      topologyCertificate: "simple_outer_minus_strict_disjoint_holes" }));
    return result(sourceGeometryIdentity.digest === nativeGeometryIdentity.digest ? [] : ["Normalized saved/native filled boundaries or hole ownership differ"], components);
  } catch (error) {
    return result([`Filled geometry not verified: ${error instanceof Error ? error.message : "unsupported input"}`]);
  }
}
