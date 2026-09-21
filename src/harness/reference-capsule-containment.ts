import type { FreshPlaneFilledComponent } from "./fresh-plane-filled-geometry.js";
import type { FreshReferenceSegment, FreshReferencePointNm } from "./fresh-kicad-parser.js";
import { segmentDistanceRelation } from "./plane-bore-geometry.js";

type Point = FreshReferencePointNm;
type Segment = Pick<FreshReferenceSegment, "uuid" | "startNm" | "endNm" | "widthNm">;
export interface ReferenceCapsuleContainment {
  readonly scope: "strict-capsule-containment-in-validated-stored-component";
  readonly allRoutesContained: boolean;
  readonly nativePolygonIndex: number;
  readonly marginNm: number;
  readonly routes: readonly Readonly<{
    segmentId: string; status: "strictly-contained" | "unproven";
    reason: "strict-boundary-separation" | "start-outside-interior" | "boundary-tangent-or-crossing";
    blockingRingIndex: number | null; blockingEdgeIndex: number | null;
    boundaryRelation: "overlap" | "tangent" | null;
  }>[];
  readonly predicateOperations: number;
  readonly maximumPredicateOperations: 4000000;
  readonly drillsIncluded: false;
  readonly terminalConnectivityClaimed: false;
  readonly highFrequencyValidityClaimed: false;
}
const check = (v: unknown, message: string): void => { if (!v) throw new Error(`Reference capsule: ${message}`); };
const cross = (a: Point, b: Point, p: Point) => BigInt(b.x - a.x) * BigInt(p.y - a.y) - BigInt(b.y - a.y) * BigInt(p.x - a.x);
const doubled = (p: Point): Point => ({ x: 2 * p.x, y: 2 * p.y });

/** A connected capsule starting inside a validated simple component cannot
 * leave it without meeting an outer/hole boundary. Exact strict separation
 * from every boundary therefore certifies containment, without a polygonal
 * approximation to the round caps. Bore and terminal checks remain separate. */
export function proveReferenceCapsuleContainment(input: {
  readonly component: FreshPlaneFilledComponent; readonly segments: readonly Segment[]; readonly marginNm: number;
}): ReferenceCapsuleContainment {
  const integer = (n: number) => check(Number.isSafeInteger(n) && Math.abs(n) <= 2_000_000_000, "coordinate/dimension bound");
  const point = (p: Point) => { integer(p.x); integer(p.y); };
  const c = input.component;
  check(c.topologyCertificate === "simple_outer_minus_strict_disjoint_holes", "validated simple component required");
  integer(c.nativePolygonIndex); check(c.nativePolygonIndex >= 0, "component index");
  integer(input.marginNm); check(input.marginNm >= 0 && input.marginNm <= 50_000_000, "margin bound");
  check(input.segments.length > 0 && input.segments.length <= 4096 && new Set(input.segments.map(s => s.uuid)).size === input.segments.length, "complete unique route inventory");
  const rings = [c.outer, ...c.holes]; let vertices = 0, work = 0;
  const step = () => { check(++work <= 4_000_000, "predicate work bound"); };
  for (const ring of rings) {
    check(ring.length >= 3, "short boundary"); vertices += ring.length; check(vertices <= 8192, "vertex bound");
    ring.forEach((p, i) => { point(p); const q = ring[(i + 1) % ring.length]!; check(p.x !== q.x || p.y !== q.y, "zero boundary edge"); });
  }
  for (const s of input.segments) {
    check(typeof s.uuid === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(s.uuid), "segment identity");
    point(s.startNm); point(s.endNm); integer(s.widthNm);
    check(s.widthNm > 0 && (s.startNm.x !== s.endNm.x || s.startNm.y !== s.endNm.y), "positive nonzero route geometry");
  }
  const inside = (p: Point) => {
    for (const [index, ring] of rings.entries()) {
      let winding = 0;
      for (let i = 0; i < ring.length; i++) {
        step(); const a = ring[i]!, b = ring[(i + 1) % ring.length]!, side = cross(a, b, p);
        if (side === 0n && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x) && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y)) return false;
        if (a.y <= p.y) { if (b.y > p.y && side > 0n) winding++; }
        else if (b.y <= p.y && side < 0n) winding--;
      }
      if ((index === 0) !== (winding !== 0)) return false;
    }
    return true;
  };
  const routes = input.segments.map(s => {
    if (!inside(s.startNm)) return { segmentId: s.uuid, status: "unproven" as const, reason: "start-outside-interior" as const,
      blockingRingIndex: null, blockingEdgeIndex: null, boundaryRelation: null };
    const a = doubled(s.startNm), b = doubled(s.endNm), radiusTwiceNm = s.widthNm + 2 * input.marginNm;
    for (const [ringIndex, ring] of rings.entries()) for (let i = 0; i < ring.length; i++) {
      step(); const relation = segmentDistanceRelation(a, b, doubled(ring[i]!), doubled(ring[(i + 1) % ring.length]!), radiusTwiceNm);
      if (relation !== "separate") return { segmentId: s.uuid, status: "unproven" as const, reason: "boundary-tangent-or-crossing" as const,
        blockingRingIndex: ringIndex, blockingEdgeIndex: i, boundaryRelation: relation };
    }
    return { segmentId: s.uuid, status: "strictly-contained" as const, reason: "strict-boundary-separation" as const,
      blockingRingIndex: null, blockingEdgeIndex: null, boundaryRelation: null };
  });
  return { scope: "strict-capsule-containment-in-validated-stored-component", allRoutesContained: routes.every(r => r.status === "strictly-contained"),
    nativePolygonIndex: c.nativePolygonIndex, marginNm: input.marginNm, routes, predicateOperations: work, maximumPredicateOperations: 4000000,
    drillsIncluded: false, terminalConnectivityClaimed: false, highFrequencyValidityClaimed: false };
}
