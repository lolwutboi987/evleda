import { describe, expect, it } from "vitest";
import { findTerminalCopperPaths } from "../../src/harness/plane-terminal-copper-paths.js";
import { summarizeTerminalCopperConnectivity } from "../../src/mcp/toolbox-terminal-copper.js";

function fixture() {
  const calculation = findTerminalCopperPaths({ boardBoundsNm: { minX: 0, minY: 0, maxX: 1000, maxY: 1000 }, pads: [{ uuid: "p1", reference: "U1", pin: "2", centerNm: { x: 500, y: 500 },
    sizeNm: { x: 100, y: 100 }, shape: "rectangle", cornerRadiusNm: 0, layers: ["F.Cu"], platedThrough: false }],
    tracks: [], vias: [], bores: [], planes: [{ id: "GROUND", layer: "F.Cu", component: { nativePolygonIndex: 0,
      outer: [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }], holes: [],
      areaTwiceNm2: "2000000", topologyCertificate: "simple_outer_minus_strict_disjoint_holes" } }], targetPlaneId: "GROUND" });
  return { status: "verified" as const, reasons: ["Nominal contact witness."], net: "GND", calculation };
}
const project = (v: ReturnType<typeof fixture>) => summarizeTerminalCopperConnectivity(v, ["p1"], "GROUND");
describe("terminal copper public projection", () => {
  it("preserves every witness while excluding arbitrary private metadata", () => {
    const f = fixture();
    const dirty = structuredClone(f) as any;
    dirty.privatePath = "C:/private/board";
    dirty.calculation.privateNative = { path: "C:/private/capture" };
    dirty.calculation.witnessPorts[0].privatePath = "C:/private/port";
    expect(project(dirty)).toEqual(project(f));
    expect(project(f).calculation).toEqual(f.calculation);
  });
  it("supports an explicitly unassessed result without a calculation", () => {
    expect(summarizeTerminalCopperConnectivity({ status: "unknown", reasons: ["Fresh fill required."], net: "GND", calculation: null }, [], "GROUND").calculation).toBeNull();
    expect(() => summarizeTerminalCopperConnectivity({ ...fixture(), calculation: null }, ["p1"], "GROUND")).toThrow(/requires witnesses/);
  });
  it.each(["missing-terminal", "missing-port", "missing-link", "wrong-target", "wrong-start", "false-complete", "bad-radius", "unproved-interior", "foreign-path"])("rejects %s rather than printing a verified path", change => {
    const f = structuredClone(fixture()) as any;
    if (change === "missing-terminal") f.calculation.terminals = [];
    if (change === "missing-port") f.calculation.witnessPorts = [];
    if (change === "missing-link") f.calculation.witnessLinks.pop();
    if (change === "wrong-target") f.calculation.terminals[0].path[f.calculation.terminals[0].path.length - 1] = "plane:OTHER:0";
    if (change === "wrong-start") f.calculation.terminals[0].path[0] = "pad:other";
    if (change === "false-complete") f.calculation.allTerminalsWitnessed = false;
    if (change === "bad-radius") f.calculation.witnessPorts[0].radiusNm = 0;
    if (change === "unproved-interior") f.calculation.primitiveInteriors[0].status = "unproven";
    if (change === "foreign-path") f.calculation.terminals[0].path[0] = "C:/private/board";
    expect(() => project(f)).toThrow(/Terminal copper projection/);
  });
  it("keeps current-capacity and fabrication claims false", () => {
    for (const key of ["currentCapacityClaimed", "fabricationAuthorized"]) {
      const f = structuredClone(fixture()) as any; f.calculation[key] = true;
      expect(() => project(f)).toThrow(/approval claim/);
    }
  });
});
