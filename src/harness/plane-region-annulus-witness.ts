import type { FreshPlaneFilledComponent } from "./fresh-plane-filled-geometry.js";
import type { FreshReferencePointNm } from "./fresh-kicad-parser.js";

type Point = FreshReferencePointNm;
export interface PlaneBridgeVia {
  readonly uuid: string;
  readonly centerNm: Point;
  readonly diameterNm: number;
  readonly drillNm: number;
}
export interface PlaneBridgeBore {
  readonly uuid: string;
  readonly centerNm: Point;
  /** Conservative enclosure, including any supported positional offset. */
  readonly enclosingDiameterNm: number;
}
export interface PlaneRegionAnnulusWitness {
  readonly nativePolygonIndex: number;
  readonly status: "witnessed" | "unproven";
  readonly viaUuid: string | null;
  readonly centerNm: Point | null;
  readonly contactDiscRadiusNm: number | null;
}
const MAX_COORD = 2_000_000_000, MAX_VERTICES = 8192, MAX_ITEMS = 4096, MAX_WORK = 4_000_000;
const check = (condition: unknown, message: string): void => { if (!condition) throw new Error(`Plane region witness: ${message}`); };
const coordinate = (n: number) => check(Number.isSafeInteger(n) && Math.abs(n) <= MAX_COORD, "coordinate bound");
const point = (p: Point) => { coordinate(p.x); coordinate(p.y); };
const cross = (a: Point, b: Point, p: Point) => BigInt(b.x - a.x) * BigInt(p.y - a.y) - BigInt(b.y - a.y) * BigInt(p.x - a.x);
const squared = (a: Point, b: Point) => BigInt(a.x - b.x) ** 2n + BigInt(a.y - b.y) ** 2n;
function floorSqrt(n: bigint): bigint {
  check(n >= 0n, "negative squared distance");
  if (n < 2n) return n;
  let x = n, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
}
function pointSegmentDistance(p: Point, a: Point, b: Point): { n: bigint; d: bigint } {
  const dx = BigInt(b.x - a.x), dy = BigInt(b.y - a.y), length = dx * dx + dy * dy;
  check(length > 0n, "zero-length boundary edge");
  const projection = BigInt(p.x - a.x) * dx + BigInt(p.y - a.y) * dy;
  if (projection <= 0n) return { n: squared(p, a), d: 1n };
  if (projection >= length) return { n: squared(p, b), d: 1n };
  return { n: cross(a, b, p) ** 2n, d: length };
}

/** Geometric calculation only. The caller must authenticate current source,
 * normal through-via span/net, complete bore inventory, direct native contacts,
 * and matching validated simple component geometry on both layers. This helper
 * neither supplies that authority nor changes an island/acceptance policy. */
export function findPlaneRegionAnnulusWitnesses(input: {
  readonly components: readonly FreshPlaneFilledComponent[];
  readonly reference: FreshPlaneFilledComponent;
  readonly vias: readonly PlaneBridgeVia[];
  readonly boreEnclosures: readonly PlaneBridgeBore[];
}) {
  check(input.components.length > 0 && input.components.length <= 128, "component count");
  check(input.vias.length <= MAX_ITEMS && input.boreEnclosures.length <= MAX_ITEMS, "item count");
  check(new Set(input.components.map(c => c.nativePolygonIndex)).size === input.components.length, "duplicate component index");
  check(new Set(input.vias.map(v => v.uuid)).size === input.vias.length
    && new Set(input.boreEnclosures.map(b => b.uuid)).size === input.boreEnclosures.length, "duplicate item identity");
  let vertices = 0, work = 0;
  const step = () => { if (++work > MAX_WORK) throw new Error("Plane region witness: predicate work bound"); };
  const bounds = new Map<FreshPlaneFilledComponent, { minX: number; minY: number; maxX: number; maxY: number }>();
  for (const component of [input.reference, ...input.components]) {
    check(component.topologyCertificate === "simple_outer_minus_strict_disjoint_holes", "qualified simple geometry required");
    check(Number.isSafeInteger(component.nativePolygonIndex) && component.nativePolygonIndex >= 0, "component index");
    for (const ring of [component.outer, ...component.holes]) {
      check(ring.length >= 3, "short boundary ring"); vertices += ring.length; check(vertices <= MAX_VERTICES, "vertex bound");
      for (const [i, p] of ring.entries()) { point(p); const q = ring[(i + 1) % ring.length]!; check(p.x !== q.x || p.y !== q.y, "repeated boundary vertex"); }
    }
    bounds.set(component, { minX: Math.min(...component.outer.map(p => p.x)), minY: Math.min(...component.outer.map(p => p.y)),
      maxX: Math.max(...component.outer.map(p => p.x)), maxY: Math.max(...component.outer.map(p => p.y)) });
  }
  for (const bore of input.boreEnclosures) { point(bore.centerNm); coordinate(bore.enclosingDiameterNm); check(bore.enclosingDiameterNm > 0, "bore dimension"); }
  for (const via of input.vias) {
    point(via.centerNm); coordinate(via.diameterNm); coordinate(via.drillNm);
    check(via.drillNm > 0 && via.diameterNm > via.drillNm, "via annulus dimension");
    const bore = input.boreEnclosures.find(b => b.uuid === via.uuid);
    check(bore !== undefined && bore.enclosingDiameterNm === via.drillNm
      && bore.centerNm.x === via.centerNm.x && bore.centerNm.y === via.centerNm.y, "via bore absent or contradictory");
  }
  /** Positive lower bound on distance to every retained boundary, only when
   * strictly inside the outer contour and strictly outside all its holes. */
  const clearance = (p: Point, component: FreshPlaneFilledComponent): bigint | null => {
    const box = bounds.get(component)!;
    if (p.x <= box.minX || p.x >= box.maxX || p.y <= box.minY || p.y >= box.maxY) return null;
    let nearest: { n: bigint; d: bigint } | null = null;
    for (const [ringIndex, ring] of [component.outer, ...component.holes].entries()) {
      let winding = 0;
      for (let i = 0; i < ring.length; i++) {
        step(); const a = ring[i]!, b = ring[(i + 1) % ring.length]!, side = cross(a, b, p), distance = pointSegmentDistance(p, a, b);
        if (distance.n === 0n) return null;
        if (nearest === null || distance.n * nearest.d < nearest.n * distance.d) nearest = distance;
        if (a.y <= p.y) { if (b.y > p.y && side > 0n) winding++; }
        else if (b.y <= p.y && side < 0n) winding--;
      }
      if ((ringIndex === 0) !== (winding !== 0)) return null;
    }
    return nearest === null ? null : floorSqrt(nearest.n / nearest.d);
  };
  const min = (a: bigint, b: bigint) => a < b ? a : b;
  const prepared = input.vias.flatMap(via => {
    const r = Math.floor((via.diameterNm + via.drillNm) / 4), a = Math.floor(3 * r / 5), b = Math.floor(4 * r / 5);
    const offsets = [[r, 0], [-r, 0], [0, r], [0, -r], [a, b], [a, -b], [-a, b], [-a, -b], [b, a], [b, -a], [-b, a], [-b, -a]];
    return offsets.flatMap(([dx, dy]) => {
      step(); const centerNm = { x: via.centerNm.x + dx!, y: via.centerNm.y + dy! }; point(centerNm);
      const radialSquared = squared(centerNm, via.centerNm), radialFloor = floorSqrt(radialSquared);
      const radialCeil = radialFloor * radialFloor === radialSquared ? radialFloor : radialFloor + 1n;
      let radius = min(BigInt(Math.floor(via.diameterNm / 2)) - radialCeil,
        radialFloor - BigInt(Math.ceil(via.drillNm / 2)));
      if (radius <= 1n) return [];
      const referenceClearance = clearance(centerNm, input.reference); if (referenceClearance === null) return [];
      radius = min(radius, referenceClearance);
      for (const bore of input.boreEnclosures) { step(); radius = min(radius,
        floorSqrt(squared(centerNm, bore.centerNm)) - BigInt(Math.ceil(bore.enclosingDiameterNm / 2))); if (radius <= 1n) return []; }
      return [{ viaUuid: via.uuid, centerNm, radius }];
    });
  });
  const regions: PlaneRegionAnnulusWitness[] = input.components.map(component => {
    let best: { viaUuid: string; centerNm: Point; contactDiscRadiusNm: number } | null = null;
    for (const candidate of prepared) { const targetClearance = clearance(candidate.centerNm, component); if (targetClearance === null) continue;
      const radius = Number(min(candidate.radius, targetClearance) - 1n); // Strict positive separation, including exact tangency.
      if (radius > 0 && (best === null || radius > best.contactDiscRadiusNm)) best = { viaUuid: candidate.viaUuid, centerNm: candidate.centerNm, contactDiscRadiusNm: radius };
    }
    return { nativePolygonIndex: component.nativePolygonIndex, status: best === null ? "unproven" : "witnessed",
      viaUuid: best?.viaUuid ?? null, centerNm: best?.centerNm ?? null, contactDiscRadiusNm: best?.contactDiscRadiusNm ?? null };
  });
  return { scope: "positive-area-stored-copper-contact-through-qualified-normal-via-annuli" as const,
    allRegionsWitnessed: regions.every(r => r.status === "witnessed"), regions,
    referenceNativePolygonIndex: input.reference.nativePolygonIndex, boreEnclosures: input.boreEnclosures.length,
    predicateOperations: work, maximumPredicateOperations: MAX_WORK, globalDrillClippedContinuityClaimed: false as const,
    currentCapacityClaimed: false as const, fabricationAuthorized: false as const };
}
