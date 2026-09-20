import { describe, expect, it } from "vitest";
import { collectPlaneBridgeSource } from "../../src/harness/plane-region-bridge-source.js";
import { nativePadObservationFixture, withNativePadFixtureIds } from "../helpers/native-pad-observation-fixture.js";
const source = withNativePadFixtureIds(`(kicad_pcb (version 20260206)
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
  (footprint "Test:J1" (layer "F.Cu") (at 2 3) (property "Reference" "J1") (property "Value" "TEST")
    (pad "1" thru_hole oval (at 0 0) (size 1.2 2.2) (drill oval 0.6 1.6 (offset 0.1 0.2)) (layers "*.Cu") (net "GND"))
    (pad "2" smd rect (at 2 0) (size 1 1) (layers "F.Cu") (net "SIGNAL")))
  (via (at 5.500001 5.25) (size 0.55) (drill 0.2) (layers "F.Cu" "B.Cu") (net "GND")
    (uuid "55555555-5555-4555-8555-555555555555")))`);
describe("complete source/native bore enclosures for region contact witnesses", () => {
  it("retains exact via coordinates and conservatively encloses a rotated/offset-capable slot", async () => {
    const observed = await nativePadObservationFixture(source);
    const result = collectPlaneBridgeSource(source, observed.observation.inventory!);
    expect(result.sourcePadCount).toBe(2); expect(result.sourceViaCount).toBe(1); expect(result.boreCount).toBe(2);
    expect(result.boreEnclosures[0]).toMatchObject({ centerNm: { x: 2000000, y: 3000000 }, enclosingDiameterNm: 2200000 });
    expect(result.vias[0]).toMatchObject({ centerNm: { x: 5500001, y: 5250000 }, diameterNm: 550000, drillNm: 200000 });
  });
  it("rejects incomplete and duplicated PAD inventories instead of losing a bore", async () => {
    const observed = await nativePadObservationFixture(source), inventory = observed.observation.inventory!;
    expect(() => collectPlaneBridgeSource(source, { ...inventory, physicalPads: inventory.physicalPads.slice(1) })).toThrow("complete PAD inventory");
    expect(() => collectPlaneBridgeSource(source, { ...inventory, physicalPads: [inventory.physicalPads[1]!, inventory.physicalPads[1]!] })).toThrow("complete PAD inventory");
  });
  it("rejects additional machining and malformed native bore dimensions", async () => {
    const observed = await nativePadObservationFixture(source), inventory = observed.observation.inventory!;
    const additional = structuredClone(inventory) as any;
    additional.physicalPads[0].rawNative.pad_stack.secondary_drill = { diameter: { x_nm: "100000", y_nm: "100000" } };
    expect(() => collectPlaneBridgeSource(source, additional)).toThrow("additional bore");
    const malformed = structuredClone(inventory) as any;
    malformed.physicalPads[0].rawNative.pad_stack.drill.diameter.y_nm = "0";
    expect(() => collectPlaneBridgeSource(source, malformed)).toThrow("complete bore geometry");
  });
  it("rejects source geometry below integer nanometre precision", async () => {
    const observed = await nativePadObservationFixture(source);
    expect(() => collectPlaneBridgeSource(source.replace("5.500001", "5.5000001"), observed.observation.inventory!)).toThrow();
  });
});
