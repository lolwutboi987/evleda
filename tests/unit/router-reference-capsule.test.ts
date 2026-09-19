import { describe, expect, it } from "vitest";
import { buildRouterReferenceCapsule, routerPolygonContainsCapsule, type RouterReferencePointNm } from "../../src/harness/router-reference-capsule.js";

const point = (xNm: number, yNm: number): RouterReferencePointNm => ({ xNm, yNm });
const horizontal = { start: point(0, 0), end: point(1_000_000, 0), radiusNm: 350_000 };

function includesPoint(polygon: readonly RouterReferencePointNm[], value: RouterReferencePointNm): boolean {
  return polygon.every((a, index) => {
    const b = polygon[(index + 1) % polygon.length]!;
    return BigInt(b.xNm - a.xNm) * BigInt(value.yNm - a.yNm)
      - BigInt(b.yNm - a.yNm) * BigInt(value.xNm - a.xNm) >= 0n;
  });
}

describe("router reference capsule export", () => {
  it("preserves exact straight boundaries instead of adding the old 6.857 micrometre inflation", () => {
    const result = buildRouterReferenceCapsule(horizontal);
    expect(Math.min(...result.points.map(p => p.xNm))).toBe(-350_000);
    expect(Math.max(...result.points.map(p => p.xNm))).toBe(1_350_000);
    expect(Math.min(...result.points.map(p => p.yNm))).toBe(-350_000);
    expect(Math.max(...result.points.map(p => p.yNm))).toBe(350_000);
    expect(result.additionalRadiusNm).toBe(0);
    expect(350_000 / Math.cos(Math.PI / 16) - 350_000).toBeGreaterThan(6_800);
    expect(result.authority).toBe("caller-supplied-geometry-only");
  });

  it.each([0, 45, 90, 135, 180, 225, 270, 315])("contains both end caps and the swept body at %i degrees", degrees => {
    const radians = degrees * Math.PI / 180;
    const capsule = { start: point(-500_000, 700_000), end: point(-500_000 + Math.round(Math.cos(radians) * 1_000_000), 700_000 + Math.round(Math.sin(radians) * 1_000_000)), radiusNm: 350_000 };
    const result = buildRouterReferenceCapsule(capsule);
    expect(routerPolygonContainsCapsule(capsule, result.points)).toBe(true);
    // Exact 3-4-5-circle witnesses, independent of the exporter's tangent construction.
    for (const center of [capsule.start, capsule.end]) for (const [x, y] of [[350_000, 0], [-350_000, 0], [0, 350_000], [0, -350_000], [210_000, 280_000], [-210_000, 280_000], [210_000, -280_000], [-210_000, -280_000]]) {
      expect(includesPoint(result.points, point(center.xNm + x!, center.yNm + y!))).toBe(true);
    }
  });

  it("quantizes absolute coordinates and proves containment for off-grid endpoints", () => {
    const capsule = { start: point(13, -27), end: point(130_019, 670_063), radiusNm: 325_000 };
    const result = buildRouterReferenceCapsule(capsule, 100);
    expect(result.points.every(p => p.xNm % 100 === 0 && p.yNm % 100 === 0)).toBe(true);
    expect(routerPolygonContainsCapsule(capsule, result.points)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.points.every(Object.isFrozen)).toBe(true);
  });

  it("handles a circle and a segment shorter than the output grid", () => {
    for (const end of [point(0, 0), point(1, 1)]) {
      const capsule = { start: point(0, 0), end, radiusNm: 1 };
      const result = buildRouterReferenceCapsule(capsule, 100);
      expect(routerPolygonContainsCapsule(capsule, result.points)).toBe(true);
    }
  });

  it("rejects an inscribed polygon and a polygon shortened by one nanometre", () => {
    const circle = { start: point(0, 0), end: point(0, 0), radiusNm: 1_000 };
    expect(routerPolygonContainsCapsule(circle, [point(1_000, 0), point(0, 1_000), point(-1_000, 0), point(0, -1_000)])).toBe(false);
    expect(routerPolygonContainsCapsule(circle, [point(-1_000, -1_000), point(999, -1_000), point(999, 1_000), point(-1_000, 1_000)])).toBe(false);
    expect(routerPolygonContainsCapsule(circle, [point(-1_000, -1_000), point(1_000, -1_000), point(1_000, 1_000), point(-1_000, 1_000)])).toBe(true);
  });

  it("rejects unordered and non-convex polygons", () => {
    const circle = { start: point(0, 0), end: point(0, 0), radiusNm: 1 };
    expect(routerPolygonContainsCapsule(circle, [point(0, 1000), point(-588, -809), point(951, 309), point(-951, 309), point(588, -809)])).toBe(false);
    expect(routerPolygonContainsCapsule(horizontal, [point(0, 0), point(2_000_000, 0), point(0, 2_000_000), point(2_000_000, 2_000_000)])).toBe(false);
    expect(routerPolygonContainsCapsule(horizontal, [point(-500_000, -500_000), point(1_500_000, -500_000), point(0, 0), point(1_500_000, 500_000), point(-500_000, 500_000)])).toBe(false);
  });

  it("rejects invalid units and out-of-range geometry without emitting a polygon", () => {
    for (const radiusNm of [0, -1, 0.5, NaN, Infinity]) expect(() => buildRouterReferenceCapsule({ ...horizontal, radiusNm })).toThrow(RangeError);
    for (const grid of [0, -1, 0.5, Infinity]) expect(() => buildRouterReferenceCapsule(horizontal, grid)).toThrow(RangeError);
    expect(() => buildRouterReferenceCapsule({ ...horizontal, start: point(0.1, 0) })).toThrow(RangeError);
    expect(() => buildRouterReferenceCapsule({ start: point(2_000_000_000, 0), end: point(2_000_000_000, 1), radiusNm: 1_000_000 })).toThrow(RangeError);
  });
});
