import { describe, expect, it } from "vitest";
import { proveReferenceCapsuleContainment } from "../../src/harness/reference-capsule-containment.js";
import type { FreshPlaneFilledComponent } from "../../src/harness/fresh-plane-filled-geometry.js";

const rectangle = (x0 = 0, y0 = 0, x1 = 1000, y1 = 1000): FreshPlaneFilledComponent => ({
  nativePolygonIndex: 0, outer: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], holes: [],
  areaTwiceNm2: String(2 * (x1 - x0) * (y1 - y0)), topologyCertificate: "simple_outer_minus_strict_disjoint_holes",
});
const segment = (y = 200) => ({ uuid: "trace", startNm: { x: 200, y }, endNm: { x: 800, y }, widthNm: 100 });
const run = (y: number) => proveReferenceCapsuleContainment({ component: rectangle(), segments: [segment(y)], marginNm: 50 });
describe("exact straight reference capsule containment", () => {
  it("certifies the complete round-ended sweep and preserves its narrow scope", () => {
    const r = run(200);
    expect(r.allRoutesContained).toBe(true);
    expect(r.routes[0]!.status).toBe("strictly-contained");
    expect(r.drillsIncluded).toBe(false); expect(r.terminalConnectivityClaimed).toBe(false); expect(r.highFrequencyValidityClaimed).toBe(false);
  });
  it.each([[99, "overlap"], [100, "tangent"], [101, null]] as const)("resolves the one-nanometre boundary at y=%s", (y, relation) => {
    const r = run(y); expect(r.allRoutesContained).toBe(relation === null); expect(r.routes[0]!.boundaryRelation).toBe(relation);
  });
  it("does not round away half-nanometre radii from odd trace widths", () => {
    expect(proveReferenceCapsuleContainment({ component: rectangle(), segments: [{ ...segment(100), widthNm: 101 }], marginNm: 50 }).allRoutesContained).toBe(false);
    expect(proveReferenceCapsuleContainment({ component: rectangle(), segments: [{ ...segment(101), widthNm: 101 }], marginNm: 50 }).allRoutesContained).toBe(true);
  });
  it("checks holes and end caps, including a route whose centerline misses a hole", () => {
    const c = { ...rectangle(), holes: [rectangle(850, 170, 900, 230).outer] };
    const r = proveReferenceCapsuleContainment({ component: c, segments: [segment()], marginNm: 50 });
    expect(r.allRoutesContained).toBe(false); expect(r.routes[0]!.blockingRingIndex).toBe(1);
    const outside = proveReferenceCapsuleContainment({ component: rectangle(), segments: [{ ...segment(), startNm: { x: -200, y: 200 } }], marginNm: 50 });
    expect(outside.routes[0]!.reason).toBe("start-outside-interior");
  });
  it("cannot certify a chord crossing a concave cutout even when its endpoints are inside", () => {
    const c = { ...rectangle(), outer: [{x:0,y:0},{x:1000,y:0},{x:1000,y:1000},{x:600,y:1000},{x:600,y:400},{x:400,y:400},{x:400,y:1000},{x:0,y:1000}] };
    expect(proveReferenceCapsuleContainment({ component: c, segments: [segment(600)], marginNm: 0 }).allRoutesContained).toBe(false);
  });
  it("retains each route instead of letting a good segment certify another", () => {
    const r = proveReferenceCapsuleContainment({ component: rectangle(), segments: [segment(), { ...segment(100), uuid: "other" }], marginNm: 50 });
    expect(r.routes.map(s => s.status)).toEqual(["strictly-contained", "unproven"]); expect(r.allRoutesContained).toBe(false);
  });
  it("rejects unsupported topology, duplicate segments and noninteger geometry", () => {
    expect(() => proveReferenceCapsuleContainment({ component: { ...rectangle(), topologyCertificate: "unknown" as any }, segments: [segment()], marginNm: 0 })).toThrow(/validated/);
    expect(() => proveReferenceCapsuleContainment({ component: rectangle(), segments: [segment(), segment()], marginNm: 0 })).toThrow(/unique/);
    expect(() => proveReferenceCapsuleContainment({ component: rectangle(), segments: [{ ...segment(), widthNm: 100.5 }], marginNm: 0 })).toThrow(/bound/);
  });
});
