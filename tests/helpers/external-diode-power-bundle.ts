import { writeFileSync } from "node:fs";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { createKiCad10StockCatalog } from "../../src/harness/kicad-stock-catalog.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { derivedPowerDraft, derivedPowerStock } from "./derived-power-bundle.js";

/** Deliberately synthetic symbols and operating assertions; no native/electrical qualification. */
export function externalDiodePowerStock(mutateDiode = (source: string) => source) {
  const stock = derivedPowerStock();
  const diode = mutateDiode(stock.selectedSymbolDefinitions["Device:R"]!
    .replaceAll('"R', '"D_Schottky').replace('(property "Reference" "D_Schottky")', '(property "Reference" "D")')
    .replace('(name "~"', '(name "K"').replace('(name "~"', '(name "A"'));
  const device = stock.librarySources.Device!.replace(/\)\s*$/u, `${diode}\n)\n`);
  writeFileSync(stock.symbolFiles.Device!, device, "utf8");
  const options = { ...stock.options, exactSymbolIds: [...stock.options.exactSymbolIds, "Device:D_Schottky"] };
  const librarySources: Readonly<Record<string, string>> = { ...stock.librarySources, Device: device };
  const selectedSymbolDefinitions: Readonly<Record<string, string>> = { ...stock.selectedSymbolDefinitions, "Device:D_Schottky": diode };
  return { ...stock, options, resolver: createKiCad10StockCatalog(options),
    librarySources, selectedSymbolDefinitions };
}

export function externalDiodePowerDraft(): Record<string, any> {
  const draft = derivedPowerDraft();
  const regulator = draft.components.find((value: any) => value.reference === "U1");
  regulator.pins.find((value: any) => value.pin === "1").assignment.net = "VSYS";
  const diode = { ...structuredClone(draft.components.find((value: any) => value.reference === "R1")), reference: "D1",
    symbolLibId: "Device:D_Schottky", value: "SYNTHETIC_SCHOTTKY",
    pins: [{ pin: "1", assignment: { kind: "net", net: "VSYS" } }, { pin: "2", assignment: { kind: "net", net: "VIN" } }] };
  draft.components.push(diode);
  const vin = draft.nets.find((value: any) => value.name === "VIN");
  vin.endpoints = [{ reference: "J1", pin: "1" }, { reference: "D1", pin: "2" }];
  draft.nets.push({ ...structuredClone(vin), name: "VSYS", role: "power",
    endpoints: [{ reference: "D1", pin: "1" }, { reference: "U1", pin: "1" }] });
  draft.placementConstraints.push({ ...structuredClone(draft.placementConstraints.find((value: any) => value.reference === "R1")), reference: "D1" });
  draft.routingConstraints.nets.push({ ...structuredClone(draft.routingConstraints.nets.find((value: any) => value.net === "VIN")), net: "VSYS" });
  draft.derivedPowerSources.push({ id: "EXTERNAL_VSYS", drivingEndpoint: { reference: "J1", pin: "1" },
    path: [{ reference: "D1", entryPin: "2", exitPin: "1" }], supplyEndpoint: { reference: "U1", pin: "1" }, returnEndpoint: { reference: "U1", pin: "2" },
    externalPowerInput: { id: "INPUT", diodeForwardDropAssumption: "Forward drop depends on load and temperature; no numerical drop or resulting VSYS range is qualified.",
      operatingModes: "Only declared external-input operation with the diode forward-biased is asserted. Absent input, reverse bias, disabled regulator, external VSYS, and simultaneous supplies are not qualified." },
    source: { kind: "caller_assertion", reference: "Synthetic external-input topology fixture", description: "Declared connector input through a forward Schottky to regulator VIN with common ground." },
    operatingAssumptions: "The caller asserts the external source is present and the downstream regulator is enabled. No voltage, current, startup, backfeed, thermal, or functional qualification." });
  return draft;
}

export function externalDiodePowerFixture(draft = externalDiodePowerDraft()) {
  const stock = externalDiodePowerStock();
  const dependencies = { libraryResolver: stock.resolver, deepRuleCatalog: loadDeepRuleCatalog() };
  const compilation = compilePcbPlaneDesignIntentDraft(draft, dependencies);
  if (compilation.disposition !== "ready") throw new Error(`External-diode fixture not ready: ${JSON.stringify(compilation.issues)}`);
  const bundle = createPcbPlaneCompilationBundle({ originalPrompt: "Synthetic declared external-input Schottky path; no physical qualification.", compilation }, dependencies);
  return { ...stock, draft, dependencies, compilation, bundle };
}
