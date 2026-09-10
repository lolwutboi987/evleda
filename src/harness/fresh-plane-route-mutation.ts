import { z } from "zod";
import type { PcbPlaneDesignContract } from "./pcb-design-plane-contract.js";
import type { FreshContractPadPosition, FreshRouteSelectionItem } from "./kicad-tools.js";
import { parseFreshPcbRouteSourceSpans } from "./fresh-kicad-parser.js";
import { freshBoardSerializationsEqual } from "./fresh-board-serialization.js";
import { routeSourceMmToNativeNm } from "./fresh-route-native-units.js";

export const FRESH_PLANE_ROUTE_SELECTION_SCHEMA_VERSION = "evleda.fresh-plane-route-selection.v1" as const;
export const FRESH_PLANE_ROUTE_MUTATION_SCHEMA_VERSION = "evleda.fresh-plane-route-mutation-result.v1" as const;
export const PLANE_ROUTE_MUTATION_SCOPE = "selected-net-incremental-route-geometry" as const;
export const PLANE_ROUTE_NOT_EVALUATED = Object.freeze(["plane_contact", "clearance", "reference_coverage", "completed_route_topology"] as const);

const coordinate = z.number().finite().min(-2000).max(2000);
const identity = z.object({ algorithm: z.literal("sha256"), digest: z.string().regex(/^[a-f0-9]{64}$/u),
  schemaVersion: z.literal(FRESH_PLANE_ROUTE_SELECTION_SCHEMA_VERSION), canonicalizationVersion: z.literal("evleda-c14n-json-v1") }).strict();
const track = z.object({ x1Mm: coordinate, y1Mm: coordinate, x2Mm: coordinate, y2Mm: coordinate, layer: z.enum(["F.Cu", "B.Cu"]) }).strict();
const via = z.object({ xMm: coordinate, yMm: coordinate }).strict();
const mutationArguments = z.object({ selectionIdentity: identity,
  net: z.string().min(1).max(64).regex(/^[A-Za-z0-9+-][A-Za-z0-9_.+-]{0,63}$/u),
  deleteItemIds: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u)).max(128),
  tracks: z.array(track).max(128), vias: z.array(via).max(32),
}).strict();
export const PLANE_ROUTE_MUTATION_INPUT_SCHEMA = Object.freeze(z.toJSONSchema(mutationArguments));
export type PlaneRouteMutationArguments = z.infer<typeof mutationArguments>;
export function parsePlaneRouteMutationArguments(value: unknown): PlaneRouteMutationArguments {
  const result = mutationArguments.parse(value);
  if (new Set(result.deleteItemIds).size !== result.deleteItemIds.length) throw new Error("Plane route deleteItemIds must be unique.");
  if (result.deleteItemIds.length + result.tracks.length + result.vias.length === 0) throw new Error("Plane route mutation must add or delete at least one route item.");
  return result;
}

/** Exclude only the named direct route forms; every retained source token stays authoritative. */
export function assertPlaneRouteSourcePreservation(before: string, after: string, deletedIds: readonly string[], addedIds: readonly string[]): void {
  if (new Set(deletedIds).size !== deletedIds.length || new Set(addedIds).size !== addedIds.length
      || addedIds.some(id => deletedIds.includes(id))) throw new Error("Plane route source exclusions must be unique, disjoint native route identities.");
  const remove = (source: string, ids: readonly string[]) => {
    const spans = parseFreshPcbRouteSourceSpans(source).filter(span => ids.includes(span.id)).sort((a, b) => a.start - b.start);
    if (spans.length !== ids.length) throw new Error("Plane route source exclusion is missing an exact selected direct route identity.");
    let retained = "", cursor = 0;
    for (const span of spans) {
      if (span.start < cursor || span.end <= span.start) throw new Error("Plane route source spans overlap or are malformed.");
      retained += source.slice(cursor, span.start); cursor = span.end;
    }
    return retained + source.slice(cursor);
  };
  if (!freshBoardSerializationsEqual(remove(before, deletedIds), remove(after, addedIds))) {
    throw new Error("Plane route mutation changed nonselected source content, including board settings, zones, or retained items.");
  }
}

type Point = Readonly<{ xMm: number; yMm: number }>;
type Track = Extract<FreshRouteSelectionItem, { kind: "track" }>;
const EPS = 1e-6;
const equal = (a: Point, b: Point) => Math.hypot(a.xMm - b.xMm, a.yMm - b.yMm) <= EPS;
const orient = (a: Point, b: Point, c: Point) => (b.xMm - a.xMm) * (c.yMm - a.yMm) - (b.yMm - a.yMm) * (c.xMm - a.xMm);
const on = (p: Point, a: Point, b: Point) => Math.abs(orient(a, b, p)) <= EPS
  && p.xMm >= Math.min(a.xMm, b.xMm) - EPS && p.xMm <= Math.max(a.xMm, b.xMm) + EPS
  && p.yMm >= Math.min(a.yMm, b.yMm) - EPS && p.yMm <= Math.max(a.yMm, b.yMm) + EPS;
const length = (t: Track) => Math.hypot(t.end.xMm - t.start.xMm, t.end.yMm - t.start.yMm);
type NativePoint = Readonly<{ x: number; y: number }>;
type NativeSegment = Readonly<{ start: NativePoint; end: NativePoint }>;
const nativePoint = (point: Point): NativePoint => ({ x: routeSourceMmToNativeNm(point.xMm), y: routeSourceMmToNativeNm(point.yMm) });
function hasPositiveCollinearOverlap(a: NativeSegment, b: NativeSegment): boolean {
  const collinear = (point: NativePoint) => BigInt(a.end.x - a.start.x) * BigInt(point.y - a.start.y)
    === BigInt(a.end.y - a.start.y) * BigInt(point.x - a.start.x);
  if (!collinear(b.start) || !collinear(b.end)) return false;
  const axis = a.start.x !== a.end.x ? "x" : "y";
  const intersectionStart = Math.max(Math.min(a.start[axis], a.end[axis]), Math.min(b.start[axis], b.end[axis]));
  const intersectionEnd = Math.min(Math.max(a.start[axis], a.end[axis]), Math.max(b.start[axis], b.end[axis]));
  return intersectionStart < intersectionEnd;
}

export function planeRouteBinding(contract: PcbPlaneDesignContract, netName: string) {
  const net = contract.nets.find(value => value.name === netName);
  const route = contract.routingConstraints.nets.find(value => value.net === netName);
  const netClass = net === undefined ? undefined : contract.netClasses.find(value => value.id === net.netClassId);
  if (net === undefined || route === undefined || netClass === undefined) throw new Error("Plane route mutation requires an exact V2 contract net/class/route binding.");
  return { net, route, netClass, access: route.topology === "plane" ? route.accessRouting : route };
}

/**
 * Incremental authoring validity only. No graph completion, pad reachability,
 * plane contact, clearance, or reference coverage is established here. Complete
 * retained and added items on the affected net are checked, including GND.
 */
export function assertPlaneIncrementalRouteGeometry(contract: PcbPlaneDesignContract, netName: string, items: readonly FreshRouteSelectionItem[], sourceNativeMatchedPads: readonly FreshContractPadPosition[] = []): void {
  const { route, netClass, access } = planeRouteBinding(contract, netName);
  const tracks = items.filter((item): item is Track => item.kind === "track" && item.net === netName);
  const vias = items.filter((item): item is Extract<FreshRouteSelectionItem, { kind: "via" }> => item.kind === "via" && item.net === netName);
  const allVias = items.filter(item => item.kind === "via");
  const within = (p: Point, radius: number) => [p.xMm, p.yMm, radius].every(Number.isFinite)
    && p.xMm - radius >= netClass.copperToEdgeMm - EPS && p.yMm - radius >= netClass.copperToEdgeMm - EPS
    && p.xMm + radius <= contract.scope.board.widthMm - netClass.copperToEdgeMm + EPS
    && p.yMm + radius <= contract.scope.board.heightMm - netClass.copperToEdgeMm + EPS;
  for (const t of tracks) {
    const dx = Math.abs(t.end.xMm - t.start.xMm), dy = Math.abs(t.end.yMm - t.start.yMm);
    if (!Number.isFinite(t.widthMm) || t.widthMm + EPS < netClass.traceWidthMm
        || !netClass.allowedLayers.includes(t.layer as "F.Cu" | "B.Cu")
        || !contract.scope.board.copperLayers.includes(t.layer as "F.Cu" | "B.Cu")
        || access.preferredLayer !== "either" && t.layer !== access.preferredLayer
        || !within(t.start, t.widthMm / 2) || !within(t.end, t.widthMm / 2)
        || length(t) <= EPS || !(dx <= EPS || dy <= EPS || Math.abs(dx - dy) <= EPS)) {
      throw new Error("Plane incremental route has a wrong-width/layer, out-of-board, zero-length, or non-45-degree track.");
    }
    if (route.topology !== "plane" && route.referencePath.mode === "continuous_plane" && t.layer !== route.referencePath.signalLayer) {
      throw new Error("Plane-referenced signal track differs from its declared signal layer.");
    }
  }
  const policy = contract.routingConstraints.viaPolicy;
  if (policy.mode === "forbidden" && allVias.length > 0) throw new Error("Plane incremental route violates the global zero-via policy.");
  if (vias.length > access.maxVias || policy.mode === "bounded" && allVias.length > policy.maxTotal) throw new Error("Plane incremental route exceeds its per-net or global via bound.");
  if (route.topology !== "plane" && route.referencePath.mode === "continuous_plane" && vias.length > 0) throw new Error("Plane-referenced signal forbids layer transitions.");
  for (const v of vias) {
    if (policy.mode !== "bounded" || v.layers.length !== 2 || new Set(v.layers).size !== 2
        || !["F.Cu", "B.Cu"].every(layer => v.layers.includes(layer) && netClass.allowedLayers.includes(layer as "F.Cu" | "B.Cu"))
        || ![v.diameterMm, v.drillMm].every(Number.isFinite)
        || v.diameterMm + EPS < policy.diameterMm || v.drillMm + EPS < policy.drillMm
        || (v.diameterMm - v.drillMm) / 2 + EPS < policy.minimumAnnularRingMm
        || !within(v.at, v.diameterMm / 2)) throw new Error("Plane incremental route has unsupported via layers, dimensions, annular ring, or board bounds.");
  }
  for (let i = 0; i < vias.length; i++) for (let j = i + 1; j < vias.length; j++) {
    if (equal(vias[i]!.at, vias[j]!.at)) throw new Error("Plane incremental route contains duplicate coincident vias.");
  }
  // Reuse the existing characterized center-contact model, not complete native
  // connectivity clusters. The host supplies only source/library/native-matched
  // pads. Offset, unknown and non-copper primitives cannot exempt a corner.
  const contact = (p: Point, layer: string) => vias.some(v => v.layers.includes(layer) && equal(v.at, p))
    || sourceNativeMatchedPads.some(pad => {
      const physical = pad.physical;
      if (pad.net !== netName || !pad.layers.includes(layer) || !equal(pad, p) || physical === undefined
          || !["rect", "roundrect", "circle", "oval"].includes(physical.shape)) return false;
      if (physical.padType === "smd") return physical.drill === null;
      return physical.padType === "thru_hole" && physical.drill !== null
        && physical.drill.sizeMm.x > 0 && physical.drill.sizeMm.y > 0
        && (physical.drill.offsetMm === null || physical.drill.offsetMm.x === 0 && physical.drill.offsetMm.y === 0);
    });
  if (access.routeLength.mode === "bounded" && tracks.reduce((sum, t) => sum + length(t), 0) > access.routeLength.maximumMm + EPS) throw new Error("Plane incremental route exceeds its maximum routed length.");
  // Source/readback coordinates must already be exact native nm. Never round
  // them into collinearity or let a pad/via point exempt an overlap interval.
  const nativeSegments = tracks.map(t => ({ start: nativePoint(t.start), end: nativePoint(t.end) }));
  for (let i = 0; i < tracks.length; i++) for (let j = i + 1; j < tracks.length; j++) {
    const a = tracks[i]!, b = tracks[j]!;
    if (a.layer !== b.layer) continue;
    const shared = [a.start, a.end].some(p => equal(p, b.start) || equal(p, b.end));
    const o1 = orient(a.start, a.end, b.start), o2 = orient(a.start, a.end, b.end), o3 = orient(b.start, b.end, a.start), o4 = orient(b.start, b.end, a.end);
    const proper = o1 * o2 < -EPS * EPS && o3 * o4 < -EPS * EPS;
    const overlap = hasPositiveCollinearOverlap(nativeSegments[i]!, nativeSegments[j]!);
    const interiorContacts = [...[b.start, b.end].filter(p => on(p, a.start, a.end)), ...[a.start, a.end].filter(p => on(p, b.start, b.end))];
    if (proper || overlap || !shared && interiorContacts.some(p => !contact(p, a.layer))) {
      throw new Error("Plane incremental route contains a self-intersection, overlap, or backtracking segment.");
    }
  }
  // Pair by physical endpoints without orienting a full route or assuming it is
  // a tree. Dangling ends and disconnected access pieces remain valid drafts.
  const visited = new Set<string>();
  for (const t of tracks) for (const p of [t.start, t.end]) {
    const key = `${t.layer}:${p.xMm}:${p.yMm}`;
    if (visited.has(key)) continue;
    visited.add(key);
    const incident = tracks.filter(other => other.layer === t.layer && (equal(other.start, p) || equal(other.end, p)));
    if (incident.length > 2) {
      if (contact(p, t.layer)) continue;
      throw new Error("Plane incremental route multiway track junction is unsupported by the bounded corner-validity check.");
    }
    if (incident.length !== 2) continue;
    const away = incident.map(other => equal(other.start, p) ? other.end : other.start);
    const a = { x: away[0]!.xMm - p.xMm, y: away[0]!.yMm - p.yMm }, b = { x: away[1]!.xMm - p.xMm, y: away[1]!.yMm - p.yMm };
    const turn = 180 - Math.acos(Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y) / (Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y))))) * 180 / Math.PI;
    if (turn > contract.routingConstraints.maximumTurnAngleDeg + EPS) throw new Error("Plane incremental route exceeds its turn bound or backtracks.");
    if (turn > EPS && incident.some(other => length(other) + EPS < contract.routingConstraints.minimumStraightBeforeTurnMm)) throw new Error("Plane incremental route violates minimum straight length before a turn.");
  }
}
