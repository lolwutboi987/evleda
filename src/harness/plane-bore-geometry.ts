/** Integer geometry for a round bore or a cardinal oblong bore. For a slot,
 * diameterNm is its minor diameter; majorDiameterNm includes both round ends. */
export interface PlaneBoreGeometry {
  readonly centerNm: Readonly<{ x: number; y: number }>;
  readonly diameterNm: number;
  readonly slot?: Readonly<{ majorDiameterNm: number; axis: "x" | "y" }>;
}
type Point = Readonly<{ x: number; y: number }>;
type Relation = "overlap" | "tangent" | "separate";

/** Twice-nanometre coordinates preserve half-nanometre capsule end centres. */
export function boreAxisTwiceNm(bore: PlaneBoreGeometry): readonly [Point, Point] {
  const x = 2 * bore.centerNm.x, y = 2 * bore.centerNm.y;
  const delta = bore.slot === undefined ? 0 : bore.slot.majorDiameterNm - bore.diameterNm;
  return bore.slot?.axis === "x" ? [{ x: x - delta, y }, { x: x + delta, y }]
    : [{ x, y: y - delta }, { x, y: y + delta }];
}
const cross = (a: Point, b: Point, c: Point) =>
  BigInt(b.x - a.x) * BigInt(c.y - a.y) - BigInt(b.y - a.y) * BigInt(c.x - a.x);
const on = (p: Point, a: Point, b: Point) => cross(a, b, p) === 0n
  && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x)
  && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
const opposite = (a: bigint, b: bigint) => a < 0n && b > 0n || a > 0n && b < 0n;
const compare = (a: bigint, b: bigint): Relation => a < b ? "overlap" : a === b ? "tangent" : "separate";
function pointSegment(p: Point, a: Point, b: Point, limit: bigint): Relation {
  const dx = BigInt(b.x - a.x), dy = BigInt(b.y - a.y);
  const px = BigInt(p.x - a.x), py = BigInt(p.y - a.y);
  const length2 = dx * dx + dy * dy, dot = px * dx + py * dy;
  if (length2 === 0n || dot <= 0n) return compare(px * px + py * py, limit);
  if (dot >= length2) return compare((px - dx) ** 2n + (py - dy) ** 2n, limit);
  const determinant = dx * py - dy * px;
  return compare(determinant * determinant, limit * length2);
}
/** All coordinates and radius use the same integer scale. Inputs come only
 * from the bounded, exact source/native readers, never model-supplied geometry. */
export function segmentDistanceRelation(a: Point, b: Point, c: Point, d: Point, radius: number): Relation {
  const limit = BigInt(radius) ** 2n;
  if (on(a, c, d) || on(b, c, d) || on(c, a, b) || on(d, a, b)
    || opposite(cross(a, b, c), cross(a, b, d)) && opposite(cross(c, d, a), cross(c, d, b))) {
    return compare(0n, limit);
  }
  const relations = [pointSegment(a, c, d, limit), pointSegment(b, c, d, limit), pointSegment(c, a, b, limit), pointSegment(d, a, b, limit)];
  return relations.includes("overlap") ? "overlap" : relations.includes("tangent") ? "tangent" : "separate";
}
export function boreRibbonRelation(bore: PlaneBoreGeometry,
  segment: { readonly startNm: Point; readonly endNm: Point; readonly widthNm: number }, marginNm: number): Relation {
  const [a, b] = boreAxisTwiceNm(bore);
  return segmentDistanceRelation(a, b,
    { x: 2 * segment.startNm.x, y: 2 * segment.startNm.y },
    { x: 2 * segment.endNm.x, y: 2 * segment.endNm.y },
    bore.diameterNm + segment.widthNm + 2 * marginNm);
}
