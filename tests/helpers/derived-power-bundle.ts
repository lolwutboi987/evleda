import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { createKiCad10StockLibraryResolver } from "../../src/harness/kicad-library-resolver.js";
import { createKiCad10StockCatalog } from "../../src/harness/kicad-stock-catalog.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { planeDividerDraft } from "./plane-divider-draft.js";

/** Synthetic local KiCad source exercises guarded software semantics, not native or physical qualification. */
const pin = (number: string, name: string, electricalType: string, x: number, y: number, rotation = 0) =>
  `(pin ${electricalType} line (at ${x} ${y} ${rotation}) (length 2.54)
    (name ${JSON.stringify(name)} (effects (font (size 1.27 1.27))))
    (number ${JSON.stringify(number)} (effects (font (size 1.27 1.27)))))`;
const symbol = (name: string, reference: string, pins: readonly string[]) =>
  `(symbol "${name}" (in_bom yes) (on_board yes)
    (property "Reference" "${reference}" (at 0 0 0))
    (property "Value" "${name}" (at 0 1.27 0))
    (property "Footprint" "" (at 0 0 0))
    (symbol "${name}_0_1" (rectangle (start -1.27 -1.27) (end 1.27 1.27)
      (stroke (width 0.254) (type default)) (fill (type none))))
    (symbol "${name}_1_1" ${pins.join("\n")}))`;
const library = (...definitions: string[]) => `(kicad_symbol_lib (version 20250114) (generator "evleda-derived-power-test")
  ${definitions.join("\n")})\n`;
const passive = (name: string) => symbol(name, name, [pin("1", "~", "passive", -3.81, 0), pin("2", "~", "passive", 3.81, 0, 180)]);

export const selectedSymbolDefinitions: Readonly<Record<string, string>> = Object.freeze({
  "Device:L": passive("L"), "Device:R": passive("R"), "Device:C": passive("C"),
  "Connector_Generic:Conn_01x04": symbol("Conn_01x04", "J", ["1", "2", "3", "4"].map((number, index) => pin(number, `Pin_${number}`, "passive", -3.81, 5.08 - index * 2.54))),
  "Regulator_Switching:TestRegulator": symbol("TestRegulator", "U", [
    pin("1", "VIN", "power_in", -5.08, 5.08), pin("2", "GND", "power_in", 0, -5.08, 90),
    pin("3", "SW", "power_out", 5.08, 2.54, 180), pin("4", "DVDD", "power_in", -5.08, 0),
    pin("5", "VREG", "power_out", 5.08, -2.54, 180),
  ]),
  "power:PWR_FLAG": `(symbol "PWR_FLAG" (power global) (in_bom yes) (on_board yes)
    (property "Reference" "#FLG" (at 0 0 0)) (property "Value" "PWR_FLAG" (at 0 1.27 0))
    (property "Footprint" "" (at 0 0 0))
    (symbol "PWR_FLAG_0_1" (polyline (pts (xy 0 0) (xy 0 1) (xy 1 2) (xy -1 2) (xy 0 1))
      (stroke (width 0) (type default)) (fill (type none))))
    (symbol "PWR_FLAG_1_1" (pin power_out line (at 0 0 90) (length 0)
      (name "pwr" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))))`,
});
export const derivedPowerLibrarySources: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(
  ["Device", "Connector_Generic", "Regulator_Switching", "power"].map(nickname => [nickname,
    library(...Object.entries(selectedSymbolDefinitions).filter(([id]) => id.startsWith(`${nickname}:`)).map(([, source]) => source))])));

const footprint = (name: string, pads: readonly string[]) => `(footprint "${name}" (version 20240108)
  (generator "evleda-derived-power-test") (layer "F.Cu")
  (fp_rect (start -2 -2) (end 6 2) (stroke (width 0.05) (type solid)) (fill none) (layer "F.CrtYd"))
  (fp_rect (start -1 -1) (end 5 1) (stroke (width 0.1) (type solid)) (fill none) (layer "F.Fab"))
  ${pads.map((number, index) => `(pad "${number}" smd rect (at ${index} 0) (size 0.8 1) (layers "F.Cu" "F.Mask" "F.Paste"))`).join("\n")})\n`;
const footprintPins: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical": ["1", "2", "3", "4"],
  "Package_SO:TestRegulator_5": ["1", "2", "3", "4", "5"],
  "Inductor_SMD:L_0603_1608Metric": ["1", "2"],
  "Resistor_SMD:R_0603_1608Metric": ["1", "2"],
});
const ownedRoots: string[] = [];
export function cleanupDerivedPowerFixtures(): void {
  for (const root of ownedRoots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe derived-power fixture cleanup target");
    rmSync(root, { recursive: true, force: true });
  }
}

export function derivedPowerStock() {
  const root = mkdtempSync(join(tmpdir(), "evleda-derived-power-")); ownedRoots.push(root);
  const symbolRoot = join(root, "symbols"), footprintRoot = join(root, "footprints");
  mkdirSync(symbolRoot); mkdirSync(footprintRoot);
  const symbolFiles: Record<string, string> = {};
  for (const [nickname, source] of Object.entries(derivedPowerLibrarySources)) {
    const file = join(symbolRoot, `${nickname}.kicad_sym`); symbolFiles[nickname] = file;
    writeFileSync(file, source, "utf8");
  }
  for (const [libraryId, pads] of Object.entries(footprintPins)) {
    const [nickname, name] = libraryId.split(":") as [string, string];
    const directory = join(footprintRoot, `${nickname}.pretty`); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${name}.kicad_mod`), footprint(name, pads), "utf8");
  }
  const options = { symbolRoot, footprintRoot, stockSymbolNicknames: Object.keys(derivedPowerLibrarySources).sort(),
    stockFootprintNicknames: [...new Set(Object.keys(footprintPins).map(id => id.split(":")[0]!))].sort(),
    exactSymbolIds: ["Device:L", "Device:R", "Device:C", "Connector_Generic:Conn_01x04", "Regulator_Switching:TestRegulator", "power:PWR_FLAG"],
    exactFootprintIds: Object.keys(footprintPins) };
  const stockResolver = createKiCad10StockLibraryResolver(options);
  // The catalog supplies real raw-source selection and host-policy pinning around the exact stock resolver.
  const resolver = createKiCad10StockCatalog(options);
  return { root, symbolRoot, footprintRoot, symbolFiles, librarySources: derivedPowerLibrarySources, selectedSymbolDefinitions, options, stockResolver, resolver };
}

export function derivedPowerDraft(): Record<string, any> {
  const base = planeDividerDraft();
  const assignments: Record<string, Record<string, string>> = {
    J1: { "1": "VIN", "2": "VCORE", "3": "GND", "4": "FILTER2" },
    U1: { "1": "VIN", "2": "GND", "3": "SW", "4": "VCORE", "5": "VREG" },
    L1: { "1": "SW", "2": "VCORE" }, R1: { "1": "VREG", "2": "FILTER1" }, R2: { "1": "FILTER1", "2": "FILTER2" },
  };
  const components = Object.entries(assignments).map(([reference, pins]) => ({ reference,
    symbolLibId: reference === "J1" ? "Connector_Generic:Conn_01x04" : reference === "U1" ? "Regulator_Switching:TestRegulator" : reference.startsWith("L") ? "Device:L" : "Device:R",
    footprintLibId: reference === "J1" ? "Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical" : reference === "U1" ? "Package_SO:TestRegulator_5" : reference.startsWith("L") ? "Inductor_SMD:L_0603_1608Metric" : "Resistor_SMD:R_0603_1608Metric",
    value: reference.startsWith("R") ? "10" : reference === "L1" ? "1uH" : `FICTIONAL_${reference}`, unit: 1,
    pins: Object.entries(pins).map(([pin, net]) => ({ pin, assignment: { kind: "net", net } })),
  }));
  const nets = ["VIN", "GND", "SW", "VCORE", "VREG", "FILTER1", "FILTER2"].map(name => ({
    name, role: name === "GND" ? "ground" : name === "VIN" ? "power_input" : "power",
    electrical: structuredClone(base.nets.find(net => net.name === (name === "GND" ? "GND" : "VIN"))!.electrical),
    netClassId: "POWER", endpoints: components.flatMap(component => component.pins.filter(pin => pin.assignment.net === name)
      .map(pin => ({ reference: component.reference, pin: pin.pin }))),
  }));
  const assertion = { kind: "caller_assertion", reference: "Synthetic regulator topology fixture", description: "Assumed regulator operating state for software tests only." };
  return { ...base, components, nets, netClasses: base.netClasses.filter(netClass => netClass.id === "POWER"),
    placementConstraints: components.map(component => ({ ...structuredClone(base.placementConstraints[0]!), reference: component.reference,
      edgePreference: component.reference === "J1" ? "left" : "none", allowedRotationsDeg: component.reference === "J1" ? [0] : [0, 90, 180, 270] })),
    routingConstraints: { ...base.routingConstraints, nets: nets.map(net => net.name === "GND"
      ? structuredClone(base.routingConstraints.nets.find(route => route.net === "GND")!)
      : { net: net.name, topology: net.endpoints.length > 2 ? "tree" : "point_to_point", preferredLayer: "F.Cu", maxVias: 0,
        routeLength: { mode: "unbounded" }, referencePath: { mode: "none" } }) },
    externalPowerInputs: [{ id: "INPUT", supplyEndpoint: { reference: "J1", pin: "1" }, returnEndpoint: { reference: "J1", pin: "3" } }],
    derivedPowerSources: [
      { id: "REG_CORE", drivingEndpoint: { reference: "U1", pin: "3" }, path: [{ reference: "L1", entryPin: "1", exitPin: "2" }],
        supplyEndpoint: { reference: "J1", pin: "2" }, returnEndpoint: { reference: "U1", pin: "2" }, source: structuredClone(assertion),
        operatingAssumptions: "VIN is energized; the internal regulator is enabled; VCORE also supplies U1 DVDD." },
      { id: "FILTER_B", drivingEndpoint: { reference: "U1", pin: "5" },
        path: [{ reference: "R1", entryPin: "1", exitPin: "2" }, { reference: "R2", entryPin: "1", exitPin: "2" }],
        supplyEndpoint: { reference: "J1", pin: "4" }, returnEndpoint: { reference: "U1", pin: "2" }, source: structuredClone(assertion),
        operatingAssumptions: "VIN is energized and the VREG output is enabled; both series resistors conduct." },
    ],
  };
}

export function derivedPowerFixture(draft: Record<string, any> = derivedPowerDraft()) {
  const stock = derivedPowerStock();
  const dependencies = { libraryResolver: stock.resolver, deepRuleCatalog: loadDeepRuleCatalog() };
  const compilation = compilePcbPlaneDesignIntentDraft(draft, dependencies);
  if (compilation.disposition !== "ready") throw new Error(`Derived-power fixture not ready: ${JSON.stringify(compilation.issues)}`);
  const bundle = createPcbPlaneCompilationBundle({ originalPrompt: "Synthetic source-bound derived supply annotations; no physical qualification.", compilation }, dependencies);
  return { ...stock, draft, dependencies, compilation, bundle };
}
