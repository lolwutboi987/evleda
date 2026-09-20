import { describe, expect, it } from "vitest";
import { findPlaneRegionAnnulusWitnesses } from "../../src/harness/plane-region-annulus-witness.js";
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
