export interface RouterReferencePointNm {
  readonly xNm: number;
  readonly yNm: number;
}

export interface RouterReferenceCapsule {
  readonly start: RouterReferencePointNm;
  readonly end: RouterReferencePointNm;
  readonly radiusNm: number;
}

export interface RouterReferencePolygon {
  readonly points: readonly RouterReferencePointNm[];
  readonly radiusNm: number;
  readonly additionalRadiusNm: number;
  readonly gridNm: number;
  readonly containment: "verified-integer-halfplanes";
  readonly authority: "caller-supplied-geometry-only";
}

const COORDINATE_LIMIT_NM = 2_000_000_000;

function validPoint(point: RouterReferencePointNm): boolean {
  return Number.isSafeInteger(point.xNm) && Number.isSafeInteger(point.yNm)
    && Math.abs(point.xNm) <= COORDINATE_LIMIT_NM && Math.abs(point.yNm) <= COORDINATE_LIMIT_NM;
}

function validateCapsule(capsule: RouterReferenceCapsule): void {
  if (!validPoint(capsule.start) || !validPoint(capsule.end)
    || !Number.isSafeInteger(capsule.radiusNm) || capsule.radiusNm <= 0
    || capsule.radiusNm > COORDINATE_LIMIT_NM) {
    throw new RangeError("Reference capsule requires bounded integer-nanometre points and a positive integer radius.");
  }
}

function cross(a: RouterReferencePointNm, b: RouterReferencePointNm, c: RouterReferencePointNm): bigint {
  return BigInt(b.xNm - a.xNm) * BigInt(c.yNm - a.yNm)
    - BigInt(b.yNm - a.yNm) * BigInt(c.xNm - a.xNm);
}

/** Proves whole-capsule containment in a strictly convex counterclockwise polygon; unsupported ordering returns false. */
export function routerPolygonContainsCapsule(
  capsule: RouterReferenceCapsule,
  points: readonly RouterReferencePointNm[],
): boolean {
  validateCapsule(capsule);
  if (points.length < 3 || points.length > 64 || points.some(point => !validPoint(point))) return false;
  const radius = BigInt(capsule.radiusNm);
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]!, b = points[(index + 1) % points.length]!;
    if (cross(a, b, points[(index + 2) % points.length]!) <= 0n) return false;
    // Each edge must bound every vertex: local turns alone do not exclude a self-intersecting polygon.
    if (points.some(point => cross(a, b, point) < 0n)) return false;
    const nx = BigInt(a.yNm - b.yNm), ny = BigInt(b.xNm - a.xNm);
    const projection = (point: RouterReferencePointNm): bigint =>
      nx * BigInt(point.xNm - a.xNm) + ny * BigInt(point.yNm - a.yNm);
    const start = projection(capsule.start), end = projection(capsule.end);
    const distance = start < end ? start : end;
    if (distance < 0n || distance * distance < radius * radius * (nx * nx + ny * ny)) return false;
  }
  return true;
}

function convexHull(points: readonly RouterReferencePointNm[]): RouterReferencePointNm[] {
  const unique = [...new Map(points.map(point => [point.xNm + "," + point.yNm, point])).values()]
    .sort((a, b) => a.xNm - b.xNm || a.yNm - b.yNm);
  const half = (input: readonly RouterReferencePointNm[]): RouterReferencePointNm[] => {
    const result: RouterReferencePointNm[] = [];
    for (const point of input) {
      while (result.length >= 2 && cross(result.at(-2)!, result.at(-1)!, point) <= 0n) result.pop();
      result.push(point);
    }
    return result;
  };
  return [...half(unique).slice(0, -1), ...half([...unique].reverse()).slice(0, -1)];
}

/**
 * Intersections of adjacent circle tangents preserve the straight capsule sides.
 * Uniformly scaling radial samples also enlarges those sides, blocking valid channels.
 * Floating-point construction is only a proposal; the returned integer polygon must
 * pass the exact whole-capsule containment proof after grid rounding.
 */
export function buildRouterReferenceCapsule(
  capsule: RouterReferenceCapsule,
  gridNm = 100,
): RouterReferencePolygon {
  validateCapsule(capsule);
  if (!Number.isSafeInteger(gridNm) || gridNm <= 0 || gridNm > 1_000_000) {
    throw new RangeError("Router grid must be a positive integer number of nanometres, at most 1 mm.");
  }
  const angle = Math.atan2(capsule.end.yNm - capsule.start.yNm, capsule.end.xNm - capsule.start.xNm);
  const roundAway = (value: number, center: number): number => {
    const scaled = value / gridNm, nearest = Math.round(scaled);
    const numericNoise = 8 * Number.EPSILON * Math.max(1, Math.abs(scaled));
    if (Math.abs(scaled - nearest) <= numericNoise) return nearest * gridNm;
    return (value >= center ? Math.ceil(scaled) : Math.floor(scaled)) * gridNm;
  };
  for (let step = 0; step <= 32; step += 1) {
    const additionalRadiusNm = step * gridNm;
    const circumradius = (capsule.radiusNm + additionalRadiusNm) / Math.cos(Math.PI / 16);
    const proposed: RouterReferencePointNm[] = [];
    for (const [center, firstNormal] of [
      [capsule.end, angle - Math.PI / 2], [capsule.start, angle + Math.PI / 2],
    ] as const) {
      for (let index = 0; index < 8; index += 1) {
        const direction = firstNormal + (index + 0.5) * Math.PI / 8;
        proposed.push({
          xNm: roundAway(center.xNm + circumradius * Math.cos(direction), center.xNm),
          yNm: roundAway(center.yNm + circumradius * Math.sin(direction), center.yNm),
        });
      }
    }
    if (proposed.some(point => !validPoint(point))) break;
    const points = convexHull(proposed);
    if (!routerPolygonContainsCapsule(capsule, points)) continue;
    return Object.freeze({
      points: Object.freeze(points.map(point => Object.freeze(point))),
      radiusNm: capsule.radiusNm, additionalRadiusNm, gridNm,
      containment: "verified-integer-halfplanes", authority: "caller-supplied-geometry-only",
    });
  }
  throw new RangeError("Could not construct a bounded conservative reference polygon on this grid.");
}
