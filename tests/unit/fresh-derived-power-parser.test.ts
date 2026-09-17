import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { createFreshConnectivityContract } from "../../src/harness/fresh-connectivity-contract.js";
import { verifyFreshExternalPowerSource } from "../../src/harness/fresh-external-power.js";
import { parseFreshSchematicTerminalGeometrySource } from "../../src/harness/fresh-kicad-parser.js";
import { transformFreshSchematicSourcePin } from "../../src/harness/fresh-schematic-terminal-groups.js";
import { parseFreshPlacements } from "../../src/harness/kicad-tools.js";
import { cleanupDerivedPowerFixtures, derivedPowerFixture } from "../helpers/derived-power-bundle.js";
import { externalDiodePowerFixture } from "../helpers/external-diode-power-bundle.js";

// Synthetic saved sources and graph records exercise host integrity checks only.
const uuid = (value: number) => `bbbbbbbb-bbbb-4bbb-8bbb-${String(value).padStart(12, "0")}`;
const rootUuid = uuid(1);
function sourceFixture(fixture: ReturnType<typeof derivedPowerFixture> = derivedPowerFixture()) {
  const bundle = fixture.bundle;
  const contract = createFreshConnectivityContract(bundle.contract, bundle.externalPowerBinding, bundle.derivedPowerBinding);
  const binding = contract.derivedPowerBinding!;
  const definitions = [...new Set([...contract.components.map(component => component.symbolLibId), "power:PWR_FLAG"])]
    .map(id => fixture.selectedSymbolDefinitions[id]!.replace(/^\(symbol "[^"]+"/u, `(symbol "${id}"`));
  const physicalInstances = contract.components.map((component, index) => `(symbol (lib_id "${component.symbolLibId}")
    (at ${(50.8 + index * 25.4).toFixed(2)} 76.20 0) (unit 1) (uuid "${uuid(10 + index)}")
    (property "Reference" "${component.reference}") (property "Value" "${component.value}")
    (property "Footprint" "${component.footprintLibId}"))`);
  const source = (instances = physicalInstances, flags: readonly string[] = []) => `(kicad_sch (version 20250114) (uuid "${rootUuid}")
    (lib_symbols ${definitions.join("\n")}) ${instances.join("\n")} ${flags.join("\n")})`;
  const pristine = source();
  const placed = parseFreshSchematicTerminalGeometrySource(pristine, contentIdentity(pristine));
  const flags = binding.flags.map((flag, index) => {
    const anchor = placed.find(symbol => symbol.reference === flag.anchorEndpoint.reference)!;
    const pin = anchor.pins.find(pin => pin.number === flag.anchorEndpoint.pin)!;
    const point = transformFreshSchematicSourcePin(pin, anchor.placement).at;
    const x = Number((point.xMm + 10.16).toFixed(2)), y = Number((point.yMm + 10.16).toFixed(2));
    return `(symbol (lib_id "power:PWR_FLAG") (at ${x} ${y} 0) (unit 1)
      (in_bom yes) (on_board yes) (dnp no) (uuid "${uuid(100 + index * 2)}")
      (property "Reference" "${flag.reference}" (at ${x} ${y} 0) (effects (font (size 1.27 1.27)) (hide yes)))
      (property "Value" "PWR_FLAG" (at ${x} ${(y - 5.08).toFixed(2)} 0) (effects (font (size 1.27 1.27))))
      (property "Footprint" "" (at ${x} ${y} 0) (effects (font (size 1.27 1.27)) (hide yes)))
      (pin "1" (uuid "${uuid(101 + index * 2)}"))
      (instances (project "synthetic-derived" (path "/${rootUuid}" (reference "${flag.reference}") (unit 1)))))`;
  });
  const physicalGroups = contract.nets.map(net => ({ name: net.name, endpoints: net.endpoints.map(endpoint => `${endpoint.reference}:${endpoint.pin}`) }));
  const groups = physicalGroups.map(group => ({ ...group, endpoints: [...group.endpoints,
    ...binding.flags.filter(flag => flag.net === group.name).map(flag => `${flag.reference}:1`)] }));
  return { ...fixture, contract, binding, source, physicalInstances, flags, pristine, saved: source(physicalInstances, flags), groups, physicalGroups };
}
type Fixture = ReturnType<typeof sourceFixture>;
let fixture: Fixture;
beforeAll(() => { fixture = sourceFixture(); });
afterAll(cleanupDerivedPowerFixtures);

describe("combined saved external and derived power source verification", () => {
  it("projects only bound flags while preserving physical inventories and the internal DVDD return path", () => {
    const value = verifyFreshExternalPowerSource(fixture.contract, fixture.saved, { groups: fixture.groups });
    expect(value.references).toEqual(fixture.binding.flags.map(flag => flag.reference));
    expect(value.physicalSymbols.map(symbol => symbol.reference)).toEqual(fixture.contract.components.map(component => component.reference));
    expect(value.groups).toEqual(fixture.physicalGroups);
    expect(value.groups!.find(group => group.name === "VCORE")!.endpoints).toContain("U1:4");
    expect(value.groups!.flatMap(group => group.endpoints).some(endpoint => endpoint.startsWith("#"))).toBe(false);
  });

  it.each([
    ["driver electrical type", '(pin power_out line (at 5.08 2.54 180)', '(pin passive line (at 5.08 2.54 180)'],
    ["upstream pin name", '(name "VIN"', '(name "V_CHANGED"'],
    ["passive endpoint geometry", '(pin passive line (at -3.81 0 0)', '(pin passive line (at -5.08 0 0)'],
    ["driver pin length", '(pin power_out line (at 5.08 2.54 180) (length 2.54)', '(pin power_out line (at 5.08 2.54 180) (length 3.81)'],
    ["passive pin visibility", '(pin passive line (at -3.81 0 0)', '(pin passive line hide (at -3.81 0 0)'],
  ])("rejects changed complete selected pins: %s", (_label, before, after) => {
    const changed = fixture.saved.replaceAll(before!, after!);
    expect(changed).not.toBe(fixture.saved);
    expect(() => verifyFreshExternalPowerSource(fixture.contract, changed)).toThrow();
  });

  it("rejects extra unselected driver unit pins", () => {
    const needle = '(symbol "TestRegulator_1_1"';
    const changed = fixture.saved.replace(needle, '(symbol "TestRegulator_2_1" (pin passive line (at 0 0 0) (length 0) (name "other") (number "99")))\n' + needle);
    expect(() => verifyFreshExternalPowerSource(fixture.contract, changed)).toThrow(/selected pin geometry/u);
  });

  it.each(["VIN", "SW", "VREG", "FILTER1", "GND", "VCORE", "FILTER2"])("requires the complete %s group", net => {
    const groups = fixture.groups.map(group => group.name === net ? { ...group, endpoints: group.endpoints.slice(1) } : group);
    expect(() => verifyFreshExternalPowerSource(fixture.contract, fixture.saved, { groups })).toThrow(/complete/u);
  });

  it("rejects a duplicated required physical endpoint in another group", () => {
    const groups = [...fixture.groups, { name: "OTHER", endpoints: ["U1:1"] }];
    expect(() => verifyFreshExternalPowerSource(fixture.contract, fixture.saved, { groups })).toThrow(/complete/u);
  });

  it("rejects a renamed upstream group and a physical endpoint from another net", () => {
    for (const groups of [fixture.groups.map(group => group.name === "VIN" ? { ...group, name: "OTHER" } : group),
      fixture.groups.map(group => group.name === "SW" ? { ...group, endpoints: [...group.endpoints, "U1:1"] } : group)]) {
      expect(() => verifyFreshExternalPowerSource(fixture.contract, fixture.saved, { groups })).toThrow(/complete/u);
    }
  });

  it("rejects partial annotations and unknown auxiliary pins before filtering", () => {
    expect(() => verifyFreshExternalPowerSource(fixture.contract, fixture.source(fixture.physicalInstances, fixture.flags.slice(1)), { allowAbsent: true })).toThrow();
    const groups = [...fixture.groups, { name: "EXTRA", endpoints: ["#FLG999:1"] }];
    expect(() => verifyFreshExternalPowerSource(fixture.contract, fixture.saved, { groups })).toThrow(/unverified auxiliary/u);
  });

  it("allows pristine empty and incremental physical authoring, but verifies every present bound symbol", () => {
    expect(verifyFreshExternalPowerSource(fixture.contract, fixture.source([]), { allowAbsent: true }).references).toEqual([]);
    const driver = fixture.physicalInstances.find(instance => instance.includes('(property "Reference" "U1")'))!;
    expect(verifyFreshExternalPowerSource(fixture.contract, fixture.source([driver]), { allowAbsent: true }).references).toEqual([]);
    const drifted = fixture.source([driver]).replace('(name "VIN"', '(name "DRIFT"');
    expect(() => verifyFreshExternalPowerSource(fixture.contract, drifted, { allowAbsent: true })).toThrow(/selected pin geometry/u);
    expect(() => verifyFreshExternalPowerSource(fixture.contract, fixture.source([driver]))).toThrow();
    const connected = fixture.source([driver]).replace('(lib_symbols', '(wire (pts (xy 10 10) (xy 20 10))) (lib_symbols');
    expect(() => verifyFreshExternalPowerSource(fixture.contract, connected, { allowAbsent: true })).toThrow();
  });

  it("requires all physical bound source symbols once annotations exist", () => {
    const instances = fixture.physicalInstances.filter(instance => !instance.includes('(property "Reference" "R1")'));
    expect(() => verifyFreshExternalPowerSource(fixture.contract, fixture.source(instances, fixture.flags))).toThrow(/physical component inventory/u);
  });

  it("rejects an unrelated physical component removed while native groups still claim it exists", () => {
    const component = { ...fixture.contract.components.find(component => component.reference === "R1")!, reference: "R9" };
    const contract = { ...fixture.contract, components: [...fixture.contract.components, component],
      noConnects: [...fixture.contract.noConnects, { reference: "R9", pin: "1" }, { reference: "R9", pin: "2" }] };
    const instance = `(symbol (lib_id "${component.symbolLibId}") (at 203.2 127 0) (unit 1) (uuid "${uuid(900)}")
      (property "Reference" "R9") (property "Value" "${component.value}") (property "Footprint" "${component.footprintLibId}"))`;
    const groups = [...fixture.groups, { name: "~no-connect", endpoints: ["R9:1"] }, { name: "~no-connect", endpoints: ["R9:2"] }];
    const complete = fixture.source([...fixture.physicalInstances, instance], fixture.flags);
    expect(verifyFreshExternalPowerSource(contract, complete, { groups }).physicalSymbols).toHaveLength(contract.components.length);
    expect(() => verifyFreshExternalPowerSource(contract, fixture.saved, { groups })).toThrow(/physical component inventory/u);
  });

  it.each(["value", "library", "footprint"])("rejects changed saved physical %s even when pin geometry is unchanged", kind => {
    const instances = fixture.physicalInstances.map(instance => {
      if (!instance.includes('(property "Reference" "R1")')) return instance;
      return kind === "value" ? instance.replace('(property "Value" "10")', '(property "Value" "1000")')
        : kind === "library" ? instance.replace('(lib_id "Device:R")', '(lib_id "Device:L")')
          : instance.replace('(property "Footprint" "Resistor_SMD:R_0603_1608Metric")', '(property "Footprint" "Other:Changed")');
    });
    expect(() => verifyFreshExternalPowerSource(fixture.contract, fixture.source(instances, fixture.flags))).toThrow(/physical component inventory/u);
  });

  it("retains source-qualified DOC7 power readback fields for the combined inventory", () => {
    const verified = verifyFreshExternalPowerSource(fixture.contract, fixture.saved, { groups: fixture.groups });
    const rows = verified.sourcePlacements.map(value => `- ${value.reference} PWR_FLAG @ (${value.x.toFixed(2)}, ${value.y.toFixed(2)}) unit=1`);
    const observed = parseFreshPlacements(`Symbols (${rows.length} total):\nPower symbols:\n${rows.join("\n")}`, verified.sourcePlacements);
    expect([...observed.keys()]).toEqual(verified.references);
    expect([...observed.values()].every(values => values[0]!.library === "power" && values[0]!.rotation === 0)).toBe(true);
  });
});

describe("saved and native external-input diode path verification", () => {
  let externalFixture: Fixture;
  beforeAll(() => { externalFixture = sourceFixture(externalDiodePowerFixture()); });

  it("preserves complete physical path groups and excludes only exact bound flags", () => {
    const f = externalFixture;
    expect(verifyFreshExternalPowerSource(f.contract, f.saved, { groups: f.groups }).groups).toEqual(f.physicalGroups);
    expect(f.binding.symbols.map(value => value.reference)).toContain("J1");
    expect(f.binding.symbols.map(value => value.reference)).toContain("D1");
  });

  it.each([
    ["diode anode name", '(name "A"', '(name "K"'],
    ["diode cathode name", '(name "K"', '(name "A"'],
    ["diode pin type", '(symbol "D_Schottky_1_1" (pin passive', '(symbol "D_Schottky_1_1" (pin power_out'],
    ["connector pin name", '(name "Pin_1"', '(name "CHANGED"'],
    ["consumer input pin type", '(pin power_in line (at -5.08 5.08 0)', '(pin passive line (at -5.08 5.08 0)'],
    ["consumer ground pin name", '(name "GND"', '(name "OTHER"'],
  ])("rejects changed saved %s before granting annotation exclusions", (_name, before, after) => {
    const f = externalFixture, changed = f.saved.replaceAll(before!, after!);
    expect(changed).not.toBe(f.saved);
    expect(() => verifyFreshExternalPowerSource(f.contract, changed, { groups: f.groups })).toThrow();
  });

  it.each(["VIN", "VSYS", "GND", "VCORE"])("requires the complete native %s path/return/upstream group", net => {
    const f = externalFixture, groups = f.groups.map(group => group.name === net ? { ...group, endpoints: group.endpoints.slice(1) } : group);
    expect(() => verifyFreshExternalPowerSource(f.contract, f.saved, { groups })).toThrow(/complete/u);
  });

  it("rejects reverse diode connectivity even when all source-inspected symbols remain intact", () => {
    const f = externalFixture;
    const groups = f.groups.map(group => ({ ...group, endpoints: group.endpoints.map(value => value === "D1:1" ? "D1:2" : value === "D1:2" ? "D1:1" : value) }));
    expect(() => verifyFreshExternalPowerSource(f.contract, f.saved, { groups })).toThrow(/complete/u);
  });
});
