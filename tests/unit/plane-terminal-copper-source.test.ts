import { describe, expect, it } from "vitest";
import { collectTerminalCopperSource } from "../../src/harness/plane-terminal-copper-source.js";
import { nativePadObservationFixture, withNativePadFixtureIds } from "../helpers/native-pad-observation-fixture.js";

async function fixture() {
  const pcbSource = withNativePadFixtureIds(`(kicad_pcb (version 20260206) (generator "pcbnew")
    (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
    (footprint "Resistor_SMD:R_0603_1608Metric" (layer "F.Cu") (at 5 5)
      (property "Reference" "R1") (property "Value" "1k")
      (pad "1" smd roundrect (at 0 0 90) (size 0.5 0.8) (roundrect_rratio 0.25) (layers "F.Cu") (net "GND"))))`);
  const observed = await nativePadObservationFixture(pcbSource, pcbSource, { retainedPadLayers: true });
  const inventory = structuredClone(observed.observation.inventory!);
  return { pcbSource, inventory, net: "GND", eligiblePadUuids: [inventory.physicalPads[0]!.uuid], copperLayers: ["F.Cu", "B.Cu"], bores: [] };
}
describe("terminal copper source adapter", () => {
  it("uses native integer anchors and absolute pad angles with the complete source inventory", async () => {
    const input = await fixture(), result = collectTerminalCopperSource(input);
    expect(result.pads[0]).toMatchObject({ centerNm: { x: 5_000_000, y: 5_000_000 }, sizeNm: { x: 800_000, y: 500_000 },
      cornerRadiusNm: 125_000, layers: ["F.Cu"], platedThrough: false, reference: "R1", pin: "1" });
  });
  it.each(["missing-retention", "offset", "angle", "unsupported-shape", "missing-native-pad", "net-mismatch"])("rejects %s without dropping the physical terminal", async change => {
    const input = await fixture(), p = input.inventory.physicalPads[0]!, raw = p.rawNative as any;
    if (change === "missing-retention") delete raw.pad_stack.unconnected_layer_removal;
    if (change === "offset") raw.pad_stack.copper_layers[0].offset = { x_nm: "1" };
    if (change === "angle") raw.pad_stack.angle.value_degrees = 45;
    if (change === "unsupported-shape") raw.pad_stack.copper_layers[0].shape = "PSS_CUSTOM";
    if (change === "missing-native-pad") (input.inventory as any).physicalPads = [];
    if (change === "net-mismatch") (p as any).netName = "OTHER";
    expect(() => collectTerminalCopperSource(input)).toThrow();
  });
});
