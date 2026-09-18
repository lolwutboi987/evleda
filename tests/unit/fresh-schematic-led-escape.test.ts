import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { createFreshConnectivityContract } from "../../src/harness/fresh-connectivity-contract.js";
import { parseFreshSymbolLibraryTerminalGeometrySource, selectFreshSymbolTerminalGeometryPins } from "../../src/harness/fresh-kicad-parser.js";
import { buildFreshSchematicSourceTerminalGroups } from "../../src/harness/fresh-schematic-source-adapter.js";
import { transformFreshSchematicSourcePin, type FreshSchematicCardinalAngle } from "../../src/harness/fresh-schematic-terminal-groups.js";
import { planFreshTerminalGlobalLabels, type FreshTerminalLabelObstacle } from "../../src/harness/fresh-schematic-terminal-labels.js";
import { closePcbDesignIntentDraft } from "../../src/harness/pcb-design-contract.js";
import { FreshSchematicWorkBudget } from "../../src/harness/fresh-schematic-work-budget.js";
import { genericDividerDraft } from "../helpers/generic-divider-bundle.js";
import { syntheticTerminalLabelStyle } from "../helpers/synthetic-terminal-label-style.js";

const stock = JSON.parse(readFileSync(new URL("../fixtures/fresh-project/stock-led-escape-source.json", import.meta.url), "utf8")) as {
  provenance: { sourceIdentity: ReturnType<typeof contentIdentity>; definitionIdentity: ReturnType<typeof contentIdentity>; nativeCalls: 0 };
  definitionSource: string;
};
function fixture(rotationDeg: FreshSchematicCardinalAngle = 0, change = (definition: string) => definition) {
  const definition = change(stock.definitionSource), librarySource = `(kicad_symbol_lib ${definition})`;
  const geometry = parseFreshSymbolLibraryTerminalGeometrySource(librarySource, contentIdentity(librarySource), "Device:LED");
  const selected = selectFreshSymbolTerminalGeometryPins(geometry, 1, 1);
  const draft: any = genericDividerDraft();
  draft.components = [{ reference: "D1", symbolLibId: "Device:LED", footprintLibId: "Test:LED", value: "SYNTHETIC_LED_TEST", unit: 1,
    pins: selected.map(pin => ({ pin: pin.number, assignment: { kind: "net", net: "N" } })) }];
  draft.nets = [{ ...draft.nets[0], name: "N", role: "passive", endpoints: selected.map(pin => ({ reference: "D1", pin: pin.number })) }];
  draft.netClasses = draft.netClasses.filter((value: { id: string }) => value.id === draft.nets[0].netClassId);
  draft.placementConstraints = [{ ...draft.placementConstraints[0], reference: "D1", edgePreference: "none", allowedRotationsDeg: [rotationDeg] }];
  draft.routingConstraints.nets = [{ ...draft.routingConstraints.nets[0], net: "N", topology: "point_to_point" }];
  const closed = closePcbDesignIntentDraft(draft), contract = createFreshConnectivityContract(closed);
  const source = `(kicad_sch (version 20250114) (lib_symbols ${definition.replace('(symbol "LED"', '(symbol "Device:LED"')})
    (symbol (lib_id "Device:LED") (unit 1) (at 127 101.6 ${rotationDeg})
      (property "Reference" "D1") (property "Value" "SYNTHETIC_LED_TEST") (property "Footprint" "Test:LED")))`;
  const placement = { at: { xMm: 127, yMm: 101.6 }, rotationDeg };
  const livePins = selected.map(pin => ({ reference: "D1", pin: pin.number, ...transformFreshSchematicSourcePin(pin, placement) }));
  const style = syntheticTerminalLabelStyle(source);
  const adapter = buildFreshSchematicSourceTerminalGroups({ schematicSource: source, expectedSourceIdentity: contentIdentity(source), contract: closed,
    libraryResolver: { inspectSymbolTerminalGeometry: () => geometry }, livePins, strokeStyleEvidence: style });
  if (adapter.result.status !== "complete") throw new Error(JSON.stringify(adapter.result));
  const pins = new Map(livePins.map(pin => [`D1:${pin.pin}`, { x: pin.at.xMm, y: pin.at.yMm, angleDeg: pin.angleDeg }]));
  const boxes = adapter.sourcePlanningGeometry.map(component => ({ reference: component.reference, ...component.bounds }));
  const sourceBodyBoxes = adapter.sourceBodyGeometry.flatMap(component => component.bounds === null ? [] : [{ reference: `@source-body:${component.reference}`,
    minX: component.bounds.minXmm, minY: component.bounds.minYmm, maxX: component.bounds.maxXmm, maxY: component.bounds.maxYmm }]);
  const input = { contract, sourceIdentity: contentIdentity(source), partition: adapter.result.value, pins, boxes, sourceBodyBoxes, strokeStyle: style,
    sheet: { minX: 15.24, minY: 15.24, maxX: 279.4, maxY: 195.58 } };
  const escapeGeometry = adapter.sourcePlanningGeometry.map(component => component.escapeGeometry!);
  return { input, adapter, source, style, geometry, escapeGeometry, run: () => planFreshTerminalGlobalLabels({ ...input, escapeGeometry }) };
}

describe("real stock LED first escape (source facts; synthetic placements/style, no native proof)", () => {
  it("pins the actual stock definition and retains all five graphics and both full pin lines", () => {
    expect(stock.provenance.nativeCalls).toBe(0);
    expect(stock.provenance.sourceIdentity).toEqual({ algorithm: "sha256", digest: "b055c9db747f615ce86b1aaacd4146e14d03b575c00dd2430a0546fd4c78aa99", size: 2586816 });
    expect(contentIdentity(stock.definitionSource)).toEqual(stock.provenance.definitionIdentity);
    const f = fixture(), actual = f.escapeGeometry[0]!;
    expect(actual.graphics).toHaveLength(5); expect(actual.pins.map(pin => pin.endpointId)).toEqual(["D1:1", "D1:2"]);
    expect(actual.libraryDefinitionIdentity).toEqual(stock.provenance.definitionIdentity);
    expect(actual.graphics.map(graphic => graphic.index)).toEqual([0, 1, 2, 3, 4]);
  });
  it.each([0, 90, 180, 270] as const)("reproduces and fixes only the aggregate empty-corner rejection at rotation %s", rotation => {
    const f = fixture(rotation), pin = f.input.pins.get("D1:1")!, merged = f.escapeGeometry[0]!.bodyBounds!;
    const overlap = pin.angleDeg === 0 ? pin.x - merged.minX : pin.angleDeg === 180 ? merged.maxX - pin.x : pin.angleDeg === 90 ? merged.maxY - pin.y : pin.y - merged.minY;
    expect(overlap).toBeCloseTo(0.9154, 8);
    expect(planFreshTerminalGlobalLabels(f.input).issues[0]!.code).toBe("TERMINAL_LABEL_SPACE_UNAVAILABLE");
    const before = JSON.stringify({ input: f.input, geometry: f.escapeGeometry });
    const result = f.run();
    expect(result.issues).toEqual([]); expect(result.wires).toHaveLength(2); expect(result.labels).toHaveLength(2);
    expect(result.wires[0]!.edgeEndpoints).toEqual(["D1:1"]);
    expect(Math.abs(result.wires[0]!.endX - pin.x) + Math.abs(result.wires[0]!.endY - pin.y)).toBeCloseTo(1.27, 8);
    expect(JSON.stringify({ input: f.input, geometry: f.escapeGeometry })).toBe(before);
  });
  it("rejects a complete source graphic genuinely crossing the cathode escape", () => {
    const f = fixture(0, source => source.replace('(symbol "LED_0_1"', '(symbol "LED_0_1" (polyline (pts (xy -4.445 -1.27) (xy -4.445 1.27)) (stroke (width 0.254) (type default)) (fill (type none)))'));
    expect(f.escapeGeometry[0]!.graphics).toHaveLength(6);
    expect(f.run().issues[0]!.code).toBe("TERMINAL_LABEL_SPACE_UNAVAILABLE"); expect(f.run().wires).toEqual([]);
  });
  it("rejects another same-net source pin line crossing the escape even though its anchor does not lie on the stub", () => {
    const f = fixture(0, source => source.replace('(at 3.81 0 180)', '(at -4.445 1.27 270)'));
    expect(f.input.pins.get("D1:2")!.y).not.toBe(f.input.pins.get("D1:1")!.y);
    expect(f.escapeGeometry[0]!.pins).toHaveLength(2);
    expect(f.run().issues[0]!.code).toBe("TERMINAL_LABEL_SPACE_UNAVAILABLE");
  });
  it.each(["foreign-component", "native-glyph", "foreign-body"])("does not exempt %s obstacles on the outward stub", kind => {
    const f = fixture(), pin = f.input.pins.get("D1:1")!;
    const obstacle: FreshTerminalLabelObstacle = { reference: kind === "native-glyph" ? "D1" : "OTHER", minX: pin.x - 0.8, maxX: pin.x - 0.6, minY: pin.y - 0.2, maxY: pin.y + 0.2,
      ...(kind === "native-glyph" ? { nativeText: { coveringLabel: null } } : {}) };
    const result = planFreshTerminalGlobalLabels({ ...f.input, escapeGeometry: f.escapeGeometry,
      ...(kind === "foreign-body" ? { sourceBodyBoxes: [...f.input.sourceBodyBoxes, obstacle] } : { boxes: [...f.input.boxes, obstacle] }) });
    expect(result.issues[0]!.code).toBe("TERMINAL_LABEL_SPACE_UNAVAILABLE"); expect(result.wires).toEqual([]);
  });
  it("rejects absent, incomplete, copied and stale primitive authority", () => {
    const f = fixture(), other = fixture(90);
    for (const escapeGeometry of [[], structuredClone(f.escapeGeometry), other.escapeGeometry,
      [Object.freeze({ ...f.escapeGeometry[0]!, graphics: f.escapeGeometry[0]!.graphics.slice(1) })]]) {
      const result = planFreshTerminalGlobalLabels({ ...f.input, escapeGeometry });
      expect(result.issues[0]!.code).toBe("TERMINAL_LABEL_SOURCE_MISMATCH"); expect(result.wires).toEqual([]);
    }
    expect(planFreshTerminalGlobalLabels({ ...f.input, escapeGeometry: f.escapeGeometry, strokeStyle: syntheticTerminalLabelStyle(f.source + " ") }).issues[0]!.code).toBe("TERMINAL_LABEL_SOURCE_MISMATCH");
    expect(planFreshTerminalGlobalLabels({ ...f.input, escapeGeometry: f.escapeGeometry }, new FreshSchematicWorkBudget(1)).issues[0]!.code).toBe("PLANNING_WORK_LIMIT");
  });
  it("does not issue primitive authority for unsupported selected source graphic or pin geometry", () => {
    for (const change of [(source: string) => source.replace('(symbol "LED_0_1"', '(symbol "LED_0_1" (text "unqualified" (at 0 0 0) (effects (font (size 1.27 1.27))))'),
      (source: string) => source.replace('(pin passive line', '(pin passive inverted')]) {
      const f = fixture(0, change);
      expect(f.adapter.sourcePlanningGeometry[0]!.complete).toBe(false);
      expect(f.adapter.sourcePlanningGeometry[0]!.escapeGeometry).toBeNull();
      expect(f.run().wires).toEqual([]);
    }
  });
});
