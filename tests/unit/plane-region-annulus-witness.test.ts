import { describe, expect, it } from "vitest";
import { boundRetainedPlaneRegionAreas, findPlaneRegionAnnulusWitnesses } from "../../src/harness/plane-region-annulus-witness.js";
import type { FreshPlaneFilledComponent } from "../../src/harness/fresh-plane-filled-geometry.js";
const rectangle = (index: number, x1: number, y1: number, x2: number, y2: number): FreshPlaneFilledComponent => ({
  nativePolygonIndex: index, outer: [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }],
  holes: [], areaTwiceNm2: String(2 * (x2 - x1) * (y2 - y1)), topologyCertificate: "simple_outer_minus_strict_disjoint_holes",
});
const via = (uuid: string, x: number, y: number) => ({ uuid, centerNm: { x, y }, diameterNm: 550000, drillNm: 200000 });
const fixture = () => {
  const vias = [via("left", 2000000, 2000000), via("right", 8000000, 2000000)];
  return { reference: rectangle(0, 0, 0, 10000000, 5000000),
    components: [rectangle(0, 0, 0, 4000000, 5000000), rectangle(1, 6000000, 0, 10000000, 5000000)], vias,
    boreEnclosures: vias.map(v => ({ uuid: v.uuid, centerNm: v.centerNm, enclosingDiameterNm: v.drillNm })) };
};
describe("positive-area annulus contacts for separated plane regions", () => {
  it("subtracts full possibly intersecting bore squares conservatively without inferring connectivity", () => {
    const component = rectangle(0, 0, 0, 1000, 1000);
    const result = boundRetainedPlaneRegionAreas([component], [
      { uuid: "inside", centerNm: { x: 500, y: 500 }, enclosingDiameterNm: 100 },
      { uuid: "partial", centerNm: { x: 1000, y: 500 }, enclosingDiameterNm: 100 },
      { uuid: "outside", centerNm: { x: 5000, y: 5000 }, enclosingDiameterNm: 100 },
    ])[0]!;
    expect(result.conservativeRetainedAreaTwiceNm2).toBe("1960000");
    expect(result.possiblyIntersectingBoreUuids).toEqual(["inside", "partial"]);
    expect(result.connectivityClaimed).toBe(false);
    const over = boundRetainedPlaneRegionAreas([component], [{ uuid: "large", centerNm: { x: 500, y: 500 }, enclosingDiameterNm: 2000 }])[0]!;
    expect(over.conservativeRetainedAreaTwiceNm2).toBe("0");
    expect(() => boundRetainedPlaneRegionAreas([{ ...component, areaTwiceNm2: "2000001" }], [])).toThrow("declared area differs");
  });
  it("certifies circles in cached holes or outside a nonrectangular component without subtracting them twice", () => {
    const square = rectangle(0, 0, 0, 1000, 1000), hole = rectangle(0, 400, 400, 600, 600).outer;
    const holed = { ...square, holes: [hole], areaTwiceNm2: "1920000" };
    const result = boundRetainedPlaneRegionAreas([holed], [{ uuid: "cached", centerNm: { x: 500, y: 500 }, enclosingDiameterNm: 100 }])[0]!;
    expect(result.conservativeRetainedAreaTwiceNm2).toBe("1920000"); expect(result.exactlySeparatedBoreUuids).toEqual(["cached"]);
    const triangle = { ...square, outer: [{x:0,y:0},{x:1000,y:0},{x:0,y:1000}], areaTwiceNm2:"1000000" };
    const outside = boundRetainedPlaneRegionAreas([triangle], [{ uuid:"outside",centerNm:{x:900,y:900},enclosingDiameterNm:100 }])[0]!;
    expect(outside.conservativeRetainedAreaTwiceNm2).toBe("1000000"); expect(outside.exactlySeparatedBoreUuids).toEqual(["outside"]);
    const overlapsHole = boundRetainedPlaneRegionAreas([holed], [{ uuid:"overlap",centerNm:{x:610,y:500},enclosingDiameterNm:100 }])[0]!;
    expect(overlapsHole.possiblyIntersectingBoreUuids).toEqual(["overlap"]); expect(overlapsHole.conservativeRetainedAreaTwiceNm2).toBe("1900000");
  });
  it("requires a bore-clear contact patch in both layers for every region", () => {
    const result = findPlaneRegionAnnulusWitnesses(fixture());
    expect(result.allRegionsWitnessed).toBe(true);
    expect(result.regions.map(r => r.viaUuid)).toEqual(["left", "right"]);
    expect(result.regions.every(r => r.contactDiscRadiusNm! > 87000)).toBe(true);
    expect(result.globalDrillClippedContinuityClaimed).toBe(false);
    expect(result.currentCapacityClaimed).toBe(false);
  });
  it("does not treat one grounded component as evidence for an unanchored component", () => {
    const input = fixture(); input.vias.pop();
    const result = findPlaneRegionAnnulusWitnesses(input);
    expect(result.allRegionsWitnessed).toBe(false); expect(result.regions[1]!.status).toBe("unproven");
  });
  it("does not bridge a hole in the primary plane", () => {
    const input = fixture(); input.reference = { ...input.reference, holes: [rectangle(0, 1000000, 1000000, 3000000, 3000000).outer] };
    expect(findPlaneRegionAnnulusWitnesses(input).regions[0]!.status).toBe("unproven");
  });
  it("does not use copper removed by another conservatively enclosed bore", () => {
    const input = fixture(); input.boreEnclosures.push({ uuid: "foreign-slot-enclosure", centerNm: { x: 2000000, y: 2000000 }, enclosingDiameterNm: 1000000 });
    expect(findPlaneRegionAnnulusWitnesses(input).regions[0]!.status).toBe("unproven");
  });
  it("keeps a tangent-only annulus and region contact unproven", () => {
    const input = fixture(); input.components[0] = rectangle(0, 2275000, 0, 4000000, 5000000);
    expect(findPlaneRegionAnnulusWitnesses(input).regions[0]!.status).toBe("unproven");
  });
  it("does not emit an annulus proof without the matching complete via bore", () => {
    const input = fixture(); input.boreEnclosures.pop();
    expect(() => findPlaneRegionAnnulusWitnesses(input)).toThrow("via bore absent");
  });
  it("rejects duplicated region/item identities and non-integer source coordinates", () => {
    const input = fixture(); input.components[1] = { ...input.components[1]!, nativePolygonIndex: 0 };
    expect(() => findPlaneRegionAnnulusWitnesses(input)).toThrow("duplicate component");
    const another = fixture(); another.vias[0]!.centerNm.x += 0.1;
    expect(() => findPlaneRegionAnnulusWitnesses(another)).toThrow("coordinate bound");
  });
});
