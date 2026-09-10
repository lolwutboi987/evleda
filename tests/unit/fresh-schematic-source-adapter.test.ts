import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import {
  parseFreshSchematicTerminalGeometrySource,
  parseFreshSymbolLibraryTerminalGeometrySource,
  selectFreshSymbolTerminalGeometryPins,
  type FreshSymbolTerminalGeometry,
} from "../../src/harness/fresh-kicad-parser.js";
import { buildFreshSchematicSourceTerminalGroups } from "../../src/harness/fresh-schematic-source-adapter.js";
import { closePcbDesignIntentDraft } from "../../src/harness/pcb-design-contract.js";
import { KiCad10StockLibraryResolver } from "../../src/harness/kicad-library-resolver.js";
import type { FreshSchematicCardinalAngle } from "../../src/harness/fresh-schematic-terminal-groups.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/fresh-project/rp2350-stock-terminal-source.json", import.meta.url), "utf8")) as {
  provenance: { sourceIdentity: ReturnType<typeof contentIdentity>; nativeExecution: false; liveGeometryIncluded: false };
  sourceBase64: string; definitions: { libraryId: string; source: string }[];
};
const stockPins = JSON.parse(readFileSync(new URL("../fixtures/fresh-project/rp2350-stock-schematic-pins.json", import.meta.url), "utf8")) as {
  symbols: { libraryId: string; pins: { number: string; name: string; electricalType: string; graphicalShape: string; at: { xMm: number; yMm: number }; angleDeg: number; unit: number; bodyStyle: number; hidden: boolean }[] }[];
};
const stockSource = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.from(fixture.sourceBase64, "base64"));
const definitions = (libraryId: string) => fixture.definitions.find((entry) => entry.libraryId === libraryId)!.source;
const stockGeometry = (libraryId: string) => parseFreshSymbolLibraryTerminalGeometrySource(stockSource, fixture.provenance.sourceIdentity, libraryId);
const stockSchematic = (libraryId: string, rotation = 0) => {
  const item = libraryId.split(":")[1]!;
  const embedded = definitions(libraryId).replace(`(symbol "${item}"`, `(symbol "${libraryId}"`);
  return `(kicad_sch (version 20250114) (lib_symbols ${embedded})
    (symbol (lib_id "${libraryId}") (at 101.6 101.6 ${rotation}) (unit 1)
      (property "Reference" "U1") (property "Value" "${item}")))`;
};
const parse = (source: string) => parseFreshSchematicTerminalGeometrySource(source, contentIdentity(source));
const pin = (number: string, x = 0, y = 0, angle = 270) => `(pin power_in line (at ${x} ${y} ${angle}) (length 2.54) (name "P${number}") (number "${number}"))`;
const definition = (representations = `(symbol "Stack_1_1" ${pin("1")} ${pin("2", 2.54)})`, extra = "") => `(symbol "Test:Stack" ${extra} ${representations})`;
const small = (body = definition(), instanceExtra = "", instancePins = "") => `(kicad_sch (lib_symbols ${body})
  (symbol (lib_id "Test:Stack") (unit 1) (at 100 100 0) (property "Reference" "U1") ${instanceExtra} ${instancePins}))`;

function contractFor(libraryId: string, pins: readonly string[]) {
  return closePcbDesignIntentDraft({ schemaVersion: "evleda.pcb-design-intent-draft.v1", kind: "pcb_design_intent_draft",
    scope: { sheetCount: 1, componentUnitPolicy: "single_unit", board: { shape: "rectangle", widthMm: 200, heightMm: 200, layerCount: 2, copperLayers: ["F.Cu", "B.Cu"] } },
    components: [{ reference: "U1", symbolLibId: libraryId, value: "SOURCE_ADAPTER_TEST_ONLY", footprintLibId: "Test:Footprint", unit: 1,
      pins: pins.map((number) => ({ pin: number, assignment: { kind: "net", net: "N" } })) }],
    nets: [{ name: "N", role: "passive", endpoints: pins.map((number) => ({ reference: "U1", pin: number })), netClassId: "SIGNAL",
      electrical: { voltage: { minimumV: 0, nominalV: 0, maximumV: 0 }, current: { nominalA: 0, maximumContinuousA: 0, peakA: 0, peakDurationMs: 1000 },
        speed: { kind: "dc", maximumFrequencyMHz: 0, minimumEdgeTimeNs: null } } }],
    netClasses: [{ id: "SIGNAL", traceWidthMm: 0.25, clearanceMm: 0.2, copperToEdgeMm: 0.3, allowedLayers: ["F.Cu"] }],
    placementConstraints: [{ reference: "U1", side: "front", regionMm: { minXmm: 1, maxXmm: 199, minYmm: 1, maxYmm: 199 },
      allowedRotationsDeg: [0, 90, 180, 270], minimumEdgeClearanceMm: 1, minimumCourtyardClearanceMm: 0.25, edgePreference: "none" }],
    routingConstraints: { cornerStyle: "miter_45", maximumTurnAngleDeg: 45, minimumStraightBeforeTurnMm: 0.25, allowRightAngleCorners: false,
      allowAcuteInteriorCorners: false, allowBacktracking: false, allowSelfIntersections: false, viaPolicy: { mode: "forbidden", maxTotal: 0 },
      nets: [{ net: "N", topology: "tree", preferredLayer: "F.Cu", maxVias: 0, routeLength: { mode: "unbounded" } }] }, unresolved: [] });
}

function adapterInput(libraryId: string, rotation = 0) {
  const schematicSource = stockSchematic(libraryId, rotation);
  const fixturePins = stockPins.symbols.find((symbol) => symbol.libraryId === libraryId)!.pins;
  return { schematicSource, expectedSourceIdentity: contentIdentity(schematicSource), contract: contractFor(libraryId, fixturePins.map((pin) => pin.number)),
    libraryResolver: { inspectSymbolTerminalGeometry: stockGeometry },
    // Explicit synthetic test placement, independently applied to previously captured local pin metadata.
    // These are not native observations and cannot authorize a live mutation.
    livePins: fixturePins.map((pin) => {
      const x = pin.at.xMm; const y = pin.at.yMm;
      const offset = rotation === 0 ? [x, -y] : rotation === 90 ? [y, x] : rotation === 180 ? [-x, y] : [-y, -x];
      return { reference: "U1", pin: pin.number, at: { xMm: 101.6 + offset[0]!, yMm: 101.6 + offset[1]! },
        angleDeg: ((pin.angleDeg - rotation + 360) % 360) as FreshSchematicCardinalAngle };
    }) };
}

describe("bounded exact-source schematic terminal adapter", () => {
  it("pins original raw stock bytes and marks synthetic/native evidence limits", () => {
    expect(contentIdentity(stockSource)).toEqual({ algorithm: "sha256", size: 64675, digest: "c9f0fe21e8a46d7503537322833345ba4299a2e6d0e7c018a8a4a4457f563191" });
    expect(fixture.provenance).toMatchObject({ nativeExecution: false, liveGeometryIncluded: false });
  });

  for (const [index, count] of [61, 81].entries()) {
    const libraryId = fixture.definitions[index]!.libraryId;
    it(`extracts every ${libraryId} pin from actual source, including body-0 supply pins`, () => {
      const approved = stockGeometry(libraryId);
      const pins = selectFreshSymbolTerminalGeometryPins(approved, 1, 1);
      const schematic = stockSchematic(libraryId);
      const placed = parse(schematic)[0]!;
      expect(placed.pins).toEqual(pins);
      expect(pins).toHaveLength(count);
      expect(pins.map((pin) => Number(pin.number)).sort((a, b) => a - b)).toEqual(Array.from({ length: count }, (_, n) => n + 1));
      const expected = new Map(stockPins.symbols[index]!.pins.map((pin) => [pin.number, pin]));
      for (const pin of pins) {
        const { number, name, electricalType, graphicalShape, at, angleDeg, unit, bodyStyle, hidden } = expected.get(pin.number)!;
        expect(pin).toMatchObject({ number, name, electricalType, graphicalShape, at, angleDeg, unit, bodyStyle, hidden });
      }
      expect(pins.filter((pin) => pin.bodyStyle === 0).length).toBeGreaterThan(0);
      expect(placed).toMatchObject({ sourceIdentity: contentIdentity(schematic), bodyStyle: 1, bodyStyleOrigin: "omitted-default" });
      expect(approved.sourceIdentity).toEqual(fixture.provenance.sourceIdentity);
      expect(Object.isFrozen(placed.pins)).toBe(true);
    });
    it.each([0, 90, 180, 270])(`corroborates all ${count} source pins at test rotation %s without dropping co-located numbers`, (rotation) => {
      const result = buildFreshSchematicSourceTerminalGroups(adapterInput(libraryId, rotation));
      expect(result.result.status).toBe("complete");
      expect(result.terminalInput.components[0]!.pins).toHaveLength(count);
      if (result.result.status !== "complete") throw new Error(JSON.stringify(result.result));
      expect(result.result.value.endpointToGroup).toHaveLength(count);
      for (const name of ["IOVDD", "DVDD"]) {
        const members = stockPins.symbols[index]!.pins.filter((pin) => pin.name === name).map((pin) => `U1:${pin.number}`).sort();
        expect(result.result.value.groups.some((group) => JSON.stringify(group.memberEndpointIds) === JSON.stringify(members))).toBe(true);
      }
      expect(result).toMatchObject({ verificationScope: "exact_source_and_approved_selected_pin_geometry", requiresTrustedNativeLiveReadback: true });
      expect(result.sourceBindings[0]!.librarySourceIdentity).toEqual(fixture.provenance.sourceIdentity);
      const body = result.sourceBodyGeometry[0]!;
      expect(body.coverage).toMatchObject({ complete: true, includesText: false, includesStroke: true, scope: "selected-library-graphics-only", graphicCount: 1 });
      expect(body.coverage).toMatchObject({ renderedStrokeVerified: false, strokeStyleIdentity: null });
      const localCorners = index === 0 ? [[-21.845, -42.165], [21.845, 42.165]] : [[-21.845, -54.865], [21.845, 52.325]];
      const transformed = localCorners.map(([x, y]) => rotation === 0 ? [101.6 + x!, 101.6 - y!]
        : rotation === 90 ? [101.6 + y!, 101.6 + x!] : rotation === 180 ? [101.6 - x!, 101.6 + y!] : [101.6 - y!, 101.6 - x!]);
      expect(body.bounds!.minXmm).toBeCloseTo(Math.min(...transformed.map((point) => point[0]!)), 8);
      expect(body.bounds!.maxXmm).toBeCloseTo(Math.max(...transformed.map((point) => point[0]!)), 8);
      expect(body.bounds!.minYmm).toBeCloseTo(Math.min(...transformed.map((point) => point[1]!)), 8);
      expect(body.bounds!.maxYmm).toBeCloseTo(Math.max(...transformed.map((point) => point[1]!)), 8);
    });
    it(`rejects an added unapproved embedded unit in actual ${libraryId} source`, () => {
      const input = adapterInput(libraryId);
      const item = libraryId.split(":")[1]!;
      const embedded = definitions(libraryId).replace(`(symbol "${item}"`, `(symbol "${libraryId}"`);
      const altered = `${embedded.slice(0, embedded.lastIndexOf(")"))} (symbol "${item}_2_1" ${pin("127", 1, 2)}) )`;
      const schematicSource = input.schematicSource.replace(embedded, altered);
      expect(schematicSource).not.toBe(input.schematicSource);
      // Deliberately recomputed current source identity cannot approve an extra unit.
      expect(() => buildFreshSchematicSourceTerminalGroups({ ...input, schematicSource, expectedSourceIdentity: contentIdentity(schematicSource) })).toThrow(/multi-unit/u);
    });
  }

  it("includes common unit0/body0 while selecting one exact alternate body", () => {
    const source = small(definition(`(symbol "Stack_0_0" ${pin("1")}) (symbol "Stack_1_1" ${pin("2", 2.54)}) (symbol "Stack_1_2" ${pin("2", 5.08)})`), "(body_style 2)");
    expect(parse(source)[0]!.pins.map((pin) => [pin.number, pin.at.xMm, pin.unit, pin.bodyStyle])).toEqual([["1", 0, 0, 0], ["2", 5.08, 1, 2]]);
    expect(parse(source.replace("body_style", "convert"))[0]!.pins).toEqual(parse(source)[0]!.pins);
    expect(parse(source)[0]!.bodyStyleOrigin).toBe("explicit");
  });
  it("supports the default single unit and body when all geometry is common", () => {
    expect(parse(small(definition(`(symbol "Stack_0_0" ${pin("1")} ${pin("2", 2.54)})`)))[0]!.pins).toHaveLength(2);
  });
  it("retains quote-sensitive private property names", () => {
    expect(parse(small().replace('(property "Reference" "U1")', '(property "private" "not-a-modifier") (property private "Reference" "U1")'))[0]!.reference).toBe("U1");
  });

  it.each([
    ["mirror", small(undefined, "(mirror x)")],
    ["alternate library name", small(undefined, '(lib_name "Other:Geometry")')],
    ["duplicate selector", small(undefined, "(body_style 1) (convert 1)")],
    ["duplicate unit", small(undefined, "(unit 1)")],
    ["missing unit", small().replace("(unit 1)", "")],
    ["noncardinal", small().replace("(at 100 100 0)", "(at 100 100 45)")],
    ["quoted coordinate", small().replace("(at 100 100 0)", '(at "100" 100 0)')],
    ["duplicate reference", small(undefined, '(property "Reference" "U2")')],
    ["duplicate definition", small(`${definition()} ${definition()}`)],
    ["lib_symbols atom", small().replace("(lib_symbols", "(lib_symbols unexpected")],
    ["late pin header", small().replace("pin power_in line", "pin power_in (hide no) line")],
    ["late representation name", small().replace('(symbol "Stack_1_1"', '(symbol (unit_name "late") "Stack_1_1"')],
    ["unsupported pin name child", small().replace('(name "P1")', '(name "P1" (wrong 1))')],
    ["extends", small(definition(undefined, '(extends "Base")'))],
    ["alias", small(definition(undefined, '(alias "Alias")'))],
    ["nested pin", small(definition(`(symbol "Stack_1_1" (other ${pin("1")}))`))],
    ["unscoped root pin", small(definition(undefined, pin("3")))],
    ["duplicate representation", small(definition(`(symbol "Stack_1_1" ${pin("1")}) (symbol "Stack_1_1" ${pin("2")})`))],
    ["duplicate pin", small(definition(`(symbol "Stack_1_1" ${pin("1")} ${pin("1")})`))],
    ["common selected duplicate", small(definition(`(symbol "Stack_0_0" ${pin("1")}) (symbol "Stack_1_1" ${pin("1")})`))],
    ["missing selected body", small(undefined, "(body_style 2)")],
    ["unsupported body", small(undefined, "(body_style 3)")],
    ["noncardinal pin", small(definition(`(symbol "Stack_1_1" ${pin("1", 0, 0, 45)})`))],
    ["duplicate pin at", small(definition(`(symbol "Stack_1_1" ${pin("1").replace("(length", "(at 0 0 270) (length")})`))],
    ["invalid hide", small(definition(`(symbol "Stack_1_1" ${pin("1").replace("(length", '(hide "yes") (length')})`))],
    ["missing instance pin", small(undefined, "", '(pin "1" (uuid a))')],
    ["duplicate instance pin", small(undefined, "", '(pin "1") (pin "1")')],
    ["alternate instance pin", small(undefined, "", '(pin "1" (alternate "DIFFERENT")) (pin "2")')],
    ["duplicate pin uuid", small(undefined, "", '(pin "1" (uuid a) (uuid b)) (pin "2")')],
    ["extra instance pin", small(undefined, "", '(pin "1") (pin "2") (pin "3")')],
    ["child sheet", small().replace("(lib_symbols", "(sheet) (lib_symbols")],
  ])("fails closed for %s without partial pins", (_name, source) => expect(() => parse(source)).toThrow());

  it("verifies identities before interpreting either raw source", () => {
    expect(() => parseFreshSchematicTerminalGeometrySource(small(), contentIdentity(`${small()} `))).toThrow(/identity/u);
    expect(() => parseFreshSymbolLibraryTerminalGeometrySource(`${stockSource} `, fixture.provenance.sourceIdentity, "MCU_RaspberryPi:RP2350A")).toThrow(/identity/u);
    expect(() => parse(`${small()}\ud800`)).toThrow(/UTF-8/u);
  });
  it("requires approved current library geometry rather than caller local coordinates", () => {
    const input = adapterInput("MCU_RaspberryPi:RP2350A");
    expect(() => buildFreshSchematicSourceTerminalGroups({ ...input, libraryResolver: { inspectSymbolTerminalGeometry: () => null } })).toThrow(/approved/u);
    const source = input.schematicSource.replace("(at 12.7 45.72 270)", "(at 12.71 45.72 270)");
    expect(() => buildFreshSchematicSourceTerminalGroups({ ...input, schematicSource: source, expectedSourceIdentity: contentIdentity(source) })).toThrow(/embedded pins differ/u);
    const wrong: FreshSymbolTerminalGeometry = { ...stockGeometry("MCU_RaspberryPi:RP2350A"), libraryId: "Other:Symbol" };
    expect(() => buildFreshSchematicSourceTerminalGroups({ ...input, libraryResolver: { inspectSymbolTerminalGeometry: () => wrong } })).toThrow(/approved/u);
    const graphics = input.schematicSource.replace("(start -21.59 41.91)", "(start -22 41.91)");
    expect(() => buildFreshSchematicSourceTerminalGroups({ ...input, schematicSource: graphics, expectedSourceIdentity: contentIdentity(graphics) })).toThrow(/embedded graphics differ/u);
  });
  it("requires complete contract and live coverage after source extraction", () => {
    const input = adapterInput("MCU_RaspberryPi:RP2350A");
    const changed = input.schematicSource.replace('(property "Reference" "U1")', '(property "Reference" "U2")');
    expect(() => buildFreshSchematicSourceTerminalGroups({ ...input, schematicSource: changed, expectedSourceIdentity: contentIdentity(changed) })).toThrow(/contract/u);
    expect(buildFreshSchematicSourceTerminalGroups({ ...input, livePins: input.livePins.slice(1) }).result.status).toBe("invalid");
    const livePins = input.livePins.map((pin, index) => index === 0 ? { ...pin, at: { ...pin.at, xMm: pin.at.xMm + 1 } } : pin);
    expect(buildFreshSchematicSourceTerminalGroups({ ...input, livePins }).result.status).not.toBe("complete");
  });
  it("does not admit a partial multi-unit library through the single-unit contract", () => {
    const embedded = definition(`(symbol "Stack_1_1" ${pin("1")} ${pin("2", 2.54)}) (symbol "Stack_2_1" ${pin("3", 5.08)})`);
    const schematicSource = small(embedded);
    const librarySource = `(kicad_symbol_lib ${embedded.replace('"Test:Stack"', '"Stack"')})`;
    const geometry = parseFreshSymbolLibraryTerminalGeometrySource(librarySource, contentIdentity(librarySource), "Test:Stack");
    expect(parse(schematicSource)[0]!.pins).toHaveLength(2); // Selected-unit extraction is explicit.
    expect(() => buildFreshSchematicSourceTerminalGroups({ schematicSource, expectedSourceIdentity: contentIdentity(schematicSource),
      contract: contractFor("Test:Stack", ["1", "2"]), libraryResolver: { inspectSymbolTerminalGeometry: () => geometry }, livePins: [] })).toThrow(/multi-unit/u);
  });
  it("binds actual source-shaped extraction through the real exact-allowlist resolver", () => {
    const scratch = mkdtempSync(join(tmpdir(), "evleda-source-adapter-"));
    try {
      const symbolRoot = join(scratch, "symbols"); const footprintRoot = join(scratch, "footprints");
      mkdirSync(symbolRoot); mkdirSync(footprintRoot);
      writeFileSync(join(symbolRoot, "MCU_RaspberryPi.kicad_sym"), Buffer.from(fixture.sourceBase64, "base64"));
      const resolver = new KiCad10StockLibraryResolver({ symbolRoot, footprintRoot,
        exactSymbolIds: ["MCU_RaspberryPi:RP2350A"], exactFootprintIds: [], stockSymbolNicknames: ["MCU_RaspberryPi"], stockFootprintNicknames: [] });
      expect(resolver.inspectSymbolTerminalGeometry("MCU_RaspberryPi:RP2350B")).toBeNull();
      const input = adapterInput("MCU_RaspberryPi:RP2350A");
      const result = buildFreshSchematicSourceTerminalGroups({ ...input, libraryResolver: resolver });
      expect(result.result.status).toBe("complete");
      expect(result.sourceBindings[0]!.librarySourceIdentity).toEqual(fixture.provenance.sourceIdentity);
      expect(result.terminalInput.livePins).not.toBe(input.livePins);
      expect(Object.isFrozen(result.terminalInput.livePins[0]!.at)).toBe(true);
    } finally {
      if (resolve(scratch).startsWith(`${resolve(tmpdir())}\\evleda-source-adapter-`) || resolve(scratch).startsWith(`${resolve(tmpdir())}/evleda-source-adapter-`)) rmSync(scratch, { recursive: true });
      else throw new Error("Refusing cleanup outside the owned source-adapter test scratch.");
    }
  });
});
