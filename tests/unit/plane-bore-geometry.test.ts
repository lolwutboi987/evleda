import { describe, expect, it } from "vitest";
import { boreAxisTwiceNm, boreRibbonRelation, segmentDistanceRelation, type PlaneBoreGeometry } from "../../src/harness/plane-bore-geometry.js";

const circle: PlaneBoreGeometry = { centerNm: { x: 0, y: 0 }, diameterNm: 2 };
const slot: PlaneBoreGeometry = { ...circle, slot: { majorDiameterNm: 10, axis: "x" } };
const line = (x1: number, y1: number, x2: number, y2: number, widthNm = 0) => ({ startNm: { x: x1, y: y1 }, endNm: { x: x2, y: y2 }, widthNm });
describe("exact bore/ribbon geometry", () => {
  it("detects slot-end overlap missed by a centre circle, without using a false enclosing-circle failure", () => {
    expect(boreRibbonRelation(circle, line(4, -3, 4, 3), 0)).toBe("separate");
    expect(boreRibbonRelation(slot, line(4, -3, 4, 3), 0)).toBe("overlap");
    // This line lies within the slot's enclosing disk but outside its real body.
    expect(boreRibbonRelation(slot, line(-2, 3, 2, 3), 0)).toBe("separate");
  });
  it("preserves exact tangency, margin expansion and a one-nanometre gap", () => {
    expect(boreRibbonRelation(slot, line(-8, 2, 8, 2, 2), 0)).toBe("tangent");
    expect(boreRibbonRelation(slot, line(-8, 3, 8, 3, 2), 0)).toBe("separate");
    expect(boreRibbonRelation(slot, line(-8, 2, 8, 2, 2), 1)).toBe("overlap");
    expect(boreRibbonRelation(slot, line(5, -3, 5, 3), 0)).toBe("tangent");
  });
  it("retains half-nanometre axis endpoints for odd diameter differences", () => {
    const odd: PlaneBoreGeometry = { centerNm: { x: -10, y: 7 }, diameterNm: 3, slot: { majorDiameterNm: 8, axis: "y" } };
    expect(boreAxisTwiceNm(odd)).toEqual([{ x: -20, y: 9 }, { x: -20, y: 19 }]);
    expect(boreRibbonRelation(odd, line(-15, 11, -5, 11), 0)).toBe("tangent");
    expect(boreRibbonRelation(odd, line(-15, 10, -5, 10), 0)).toBe("overlap");
  });
  it("handles crossing axes, point segments and widely translated coordinates exactly", () => {
    expect(segmentDistanceRelation({ x: -5, y: 0 }, { x: 5, y: 0 }, { x: 0, y: -5 }, { x: 0, y: 5 }, 1)).toBe("overlap");
    expect(boreRibbonRelation(circle, line(1, 0, 1, 0), 0)).toBe("tangent");
    const large: PlaneBoreGeometry = { centerNm: { x: 1_999_999_000, y: -1_999_999_000 }, diameterNm: 2, slot: { majorDiameterNm: 10, axis: "x" } };
    expect(boreRibbonRelation(large, line(1_999_998_995, -1_999_998_998, 1_999_999_005, -1_999_998_998, 2), 0)).toBe("tangent");
  });
});
