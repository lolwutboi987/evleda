import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { parseFreshSchematicTerminalGeometrySource } from "../../src/harness/fresh-kicad-parser.js";
import { buildSchematicTerminalGroups, transformFreshSchematicSourcePin,
  type FreshSchematicCardinalAngle, type FreshSchematicSourceComponent, type FreshSchematicTerminalInput } from "../../src/harness/fresh-schematic-terminal-groups.js";
import { freshAbsolutePinAngle } from "../../src/harness/kicad-tools.js";

const read = (name: string) => readFileSync(new URL(`../fixtures/schematic-cardinal-native/${name}`, import.meta.url), "utf8");
const oracle = JSON.parse(read("oracle.json")) as {
  nativeExecution: boolean; version: string; sourcesUnchanged: boolean;
  captureScriptIdentity: ReturnType<typeof contentIdentity>;
  artifacts: Record<string, ReturnType<typeof contentIdentity>>;
  cases: { reference: string; symbolLibId: string; placement: FreshSchematicSourceComponent["placement"]; pins: FreshSchematicSourceComponent["pins"] }[];
  observations: { reference: string; pin: string; net: string; at: { xMm: number; yMm: number }; angleDeg: FreshSchematicCardinalAngle; nativeStrokeSegments: number[][] }[];
};
const source = read("cardinal-unlabelled.kicad_sch"), sourceIdentity = contentIdentity(source);
const parsed = parseFreshSchematicTerminalGeometrySource(source, sourceIdentity);
const components: FreshSchematicSourceComponent[] = parsed.map(c => ({ reference: c.reference, symbolLibId: c.symbolLibId, sourceIdentity,
  unit: c.unit, placement: c.placement, pins: c.pins.map(p => ({ number: p.number, at: p.at, angleDeg: p.angleDeg })) }));
const input: FreshSchematicTerminalInput = {
  contractIdentity: canonicalIdentity({ purpose: "independent native cardinal geometry only" }, "evleda.native-cardinal-test.v1"),
  components, assignments: oracle.observations.map(p => ({ reference: p.reference, pin: p.pin, assignment: { kind: "net", net: p.net } })),
  livePins: oracle.observations.map(({ reference, pin, at, angleDeg }) => ({ reference, pin, at, angleDeg })),
};
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

describe("independent KiCad 10 native schematic cardinal geometry", () => {
  it("pins the real CLI XML/SVG and sources, rather than generating expected observations with the host transform", () => {
    expect(oracle).toMatchObject({ nativeExecution: true, version: "10.0.3", sourcesUnchanged: true });
    for (const file of ["native.net", "native.svg", "cardinal-labelled.kicad_sch", "cardinal-unlabelled.kicad_sch", "source-symbols.kicad_sym"]) {
      expect(contentIdentity(readFileSync(new URL(`../fixtures/schematic-cardinal-native/${file}`, import.meta.url)))).toEqual(oracle.artifacts[file]);
    }
    expect(contentIdentity(read("capture.py"))).toEqual(oracle.captureScriptIdentity);
    expect(components).toHaveLength(12); expect(oracle.observations).toHaveLength(36);
    expect([...new Set(components.map(c => c.symbolLibId))].sort()).toEqual(["Device:Crystal_GND24", "Device:R", "Transistor_FET:Q_NMOS_GSD"]);
    const nativeXml = read("native.net"), nativeSvg = read("native.svg");
    for (const rotation of [0,90,180,270]) {
      const component = new RegExp(`<comp ref="Q${rotation}">([\\s\\S]*?)<\\/comp>`, "u").exec(nativeXml)?.[1];
      expect(component).toContain("<value>DMG1012T</value>");
      expect(component).toContain('lib="Transistor_FET" part="Q_NMOS_GSD"');
    }
    for (const pin of oracle.observations) {
      const net = new RegExp(`<net code="[^\"]+" name="${escaped(pin.net)}"[^>]*>([\\s\\S]*?)<\\/net>`, "u").exec(nativeXml);
      expect(net?.[1]).toContain(`<node ref="${pin.reference}" pin="${pin.pin}"`);
      expect(pin.nativeStrokeSegments.length).toBeGreaterThan(0);
      for (const segment of pin.nativeStrokeSegments) {
        const path = ([x1,y1,x2,y2]: number[]) => new RegExp(`d="M\\s*${escaped(x1!.toFixed(4))}[,\\s]+${escaped(y1!.toFixed(4))}\\s*L\\s*${escaped(x2!.toFixed(4))}[,\\s]+${escaped(y2!.toFixed(4))}\\s*"`, "u");
        expect(path(segment).test(nativeSvg) || path([segment[2]!,segment[3]!,segment[0]!,segment[1]!]).test(nativeSvg)).toBe(true);
      }
    }
  });
  it.each(oracle.cases)("matches native netlisted pin locations and rendered inward directions for $reference", c => {
    const component = components.find(value => value.reference === c.reference)!;
    expect(component.placement).toEqual(c.placement);
    for (const pin of component.pins) {
      const native = oracle.observations.find(p => p.reference === component.reference && p.pin === pin.number)!;
      const actual = transformFreshSchematicSourcePin(pin, component.placement);
      expect(actual.at.xMm).toBeCloseTo(native.at.xMm, 8);
      expect(actual.at.yMm).toBeCloseTo(native.at.yMm, 8);
      expect(actual.angleDeg).toBe(native.angleDeg);
      expect(freshAbsolutePinAngle(pin.angleDeg, component.placement.rotationDeg)).toBe(native.angleDeg);
    }
  });
  it("preserves every native co-located crystal pin at every cardinal rotation", () => {
    const result = buildSchematicTerminalGroups(input);
    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error(JSON.stringify(result));
    expect(result.value.endpointToGroup).toHaveLength(36); expect(result.value.groups).toHaveLength(32);
    for (const rotation of [0,90,180,270]) {
      expect(result.value.groups.find(g => g.id === `Y${rotation}:2`)?.memberEndpointIds).toEqual([`Y${rotation}:2`,`Y${rotation}:4`]);
    }
  });
  it.each(oracle.cases.filter(c => c.placement.rotationDeg === 90 || c.placement.rotationDeg === 270))(
    "rejects the old DOC9 quarter-turn position observation for $reference even with corrected host angles", c => {
      const component = components.find(value => value.reference === c.reference)!;
      const oldPins = component.pins.map(pin => {
        const [x,y] = component.placement.rotationDeg === 90 ? [pin.at.yMm,pin.at.xMm] : [-pin.at.yMm,-pin.at.xMm];
        return { reference: component.reference, pin: pin.number,
          at: { xMm: component.placement.at.xMm + x!, yMm: component.placement.at.yMm + y! },
          angleDeg: freshAbsolutePinAngle(pin.angleDeg, component.placement.rotationDeg)! };
      });
      const changed = { ...input, livePins: input.livePins.map(pin => oldPins.find(old => old.reference === pin.reference && old.pin === pin.pin) ?? pin) };
      expect(buildSchematicTerminalGroups(changed)).toMatchObject({ status: "invalid", issues: [{ code: "SOURCE_LIVE_GEOMETRY_MISMATCH" }] });
    });
});
