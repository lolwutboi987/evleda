import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createKiCad10StockCatalog } from "../../src/harness/kicad-stock-catalog.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { derivedPowerStock } from "./derived-power-bundle.js";
import { usbChannelDraft } from "./usb-channel-bundle.js";
import { usbChannelPcb, usbChannelPadSource, usbChannelTrackSource } from "./usb-channel-source.js";

/** Synthetic source files exercise the genuine host pin-inspection boundary, not manufacturer or native qualification. */
export function usbFeedThroughStock(mutate = (source: string) => source) {
  const stock = derivedPowerStock();
  const pins: Record<string, readonly [string, string, string][]> = {
    ChannelSource: [["1", "GND", "power_in"], ["51", "USB_DM", "bidirectional"], ["52", "USB_DP", "bidirectional"]],
    UsbContacts: ["A1", "A4", "A6", "A7", "B6", "B7"].map(number => [number, `Pin_${number}`, "passive"]),
    ChannelProtection: [["1", "IO1", "passive"], ["2", "GND", "power_in"], ["3", "IO2", "passive"], ["4", "IO2", "passive"], ["5", "VBUS", "power_in"], ["6", "IO1", "passive"]],
  };
  const definitions = Object.entries(pins).map(([name, pins]) => `(symbol "${name}" (in_bom yes) (on_board yes)
    (property "Reference" "${name === "UsbContacts" ? "J" : "U"}") (property "Value" "${name}") (property "Footprint" "")
    (symbol "${name}_0_1" (rectangle (start -1 -1) (end 1 1) (stroke (width 0.254) (type default)) (fill (type none))))
    (symbol "${name}_1_1" ${pins.map(([number, pinName, type], index) => `(pin ${type} line (at -3.81 ${index * 2.54} 0) (length 2.54) (name "${pinName}") (number "${number}"))`).join("\n")}))`);
  const source = mutate(`(kicad_symbol_lib (version 20250114) ${definitions.join("\n")})`), file = join(stock.symbolRoot, "Fixture.kicad_sym");
  writeFileSync(file, source, "utf8");
  const footprintRoot = join(stock.footprintRoot, "Fixture.pretty"); mkdirSync(footprintRoot);
  for (const [name, entries] of Object.entries(pins)) writeFileSync(join(footprintRoot, `${name}.kicad_mod`), `(footprint "${name}" (version 20240108) (layer "F.Cu")
    (fp_rect (start -1 -1) (end 8 1) (stroke (width 0.05) (type solid)) (fill none) (layer "F.CrtYd"))
    (fp_rect (start -1 -1) (end 8 1) (stroke (width 0.1) (type solid)) (fill none) (layer "F.Fab"))
    ${entries.map(([number], index) => `(pad "${number}" smd rect (at ${index} 0) (size 0.8 1) (layers "F.Cu" "F.Paste" "F.Mask"))`).join("\n")})`, "utf8");
  const ids = Object.keys(pins).map(name => `Fixture:${name}`);
  const options = { ...stock.options, stockSymbolNicknames: [...stock.options.stockSymbolNicknames, "Fixture"].sort(),
    stockFootprintNicknames: [...stock.options.stockFootprintNicknames, "Fixture"].sort(), exactSymbolIds: [...stock.options.exactSymbolIds, ...ids], exactFootprintIds: [...stock.options.exactFootprintIds, ...ids] };
  const resolver = createKiCad10StockCatalog(options);
  return { ...stock, resolver, file, source, options, dependencies: { libraryResolver: resolver, deepRuleCatalog: loadDeepRuleCatalog() } };
}

export function usbFeedThroughDraft(): Record<string, any> {
  const draft = usbChannelDraft(), pair = draft.interfaceRequirements.interfaces[0];
  pair.channel.feedThrough = { kind: "two_line_protection", componentReference: "D1", inputNets: { positive: "MP", negative: "MN" },
    positive: { inputPin: "1", outputPin: "6" }, negative: { inputPin: "3", outputPin: "4" },
    source: { kind: "caller_assertion", reference: "ST DS4260 Rev7 p1, Fig15 and Fig17 (synthetic topology fixture)",
      description: "Explicit two-line component transfer; package R/L, electrical delay and skew are not modeled as PCB copper or zero." } };
  for (const [reference, pin, net] of [["R1", "2", "MP"], ["R2", "2", "MN"], ["D1", "1", "MP"], ["D1", "3", "MN"]]) {
    draft.components.find((value: any) => value.reference === reference).pins.find((value: any) => value.pin === pin).assignment.net = net;
  }
  const referenceFor = new Map(draft.routingConstraints.nets.flatMap((route: any) => route.referencePath?.terminalReferences?.map((value: any) => [`${value.signalEndpoint.reference}:${value.signalEndpoint.pin}`, value.referenceEndpoint]) ?? []));
  for (const [net, template] of [["MP", "DP"], ["MN", "DN"]]) {
    draft.nets.push({ ...structuredClone(draft.nets.find((value: any) => value.name === template)), name: net });
    draft.routingConstraints.nets.push({ ...structuredClone(draft.routingConstraints.nets.find((value: any) => value.net === template)), net });
  }
  for (const net of draft.nets) {
    net.endpoints = draft.components.flatMap((component: any) => component.pins.filter((pin: any) => pin.assignment.net === net.name).map((pin: any) => ({ reference: component.reference, pin: pin.pin })));
    const route = draft.routingConstraints.nets.find((value: any) => value.net === net.name);
    if (route.topology === "plane") continue;
    route.topology = net.endpoints.length > 2 ? "tree" : "point_to_point";
    route.referencePath.terminalReferences = net.endpoints.map((point: any) => ({ signalEndpoint: point, referenceEndpoint: referenceFor.get(`${point.reference}:${point.pin}`) }));
  }
  return draft;
}

export function usbFeedThroughFixture(draft = usbFeedThroughDraft()) {
  const stock = usbFeedThroughStock(), compilation = compilePcbPlaneDesignIntentDraft(draft, stock.dependencies);
  if (compilation.disposition !== "ready") throw new Error(JSON.stringify(compilation.issues));
  const bundle = createPcbPlaneCompilationBundle({ originalPrompt: "Synthetic explicitly asserted six-net protection transfer.", compilation }, stock.dependencies);
  return { ...stock, draft, compilation, bundle };
}

export function usbFeedThroughPcb() {
  return usbChannelPcb()
    .replace(usbChannelPadSource(22, "2", "DP", "2 0"), usbChannelPadSource(22, "2", "MP", "2 0"))
    .replace(usbChannelPadSource(32, "2", "DN", "2 1"), usbChannelPadSource(32, "2", "MN", "2 1"))
    .replace(usbChannelPadSource(51, "1", "DP", "5 0"), usbChannelPadSource(51, "1", "MP", "5 0"))
    .replace(usbChannelPadSource(53, "3", "DN", "5 1"), usbChannelPadSource(53, "3", "MN", "5 1"))
    .replace(usbChannelTrackSource(3, "DP", "2 0", "10 0"), `${usbChannelTrackSource(3, "MP", "2 0", "5 0")} ${usbChannelTrackSource(201, "DP", "6 0", "10 0")}`)
    .replace(usbChannelTrackSource(4, "DN", "2 1", "10 1"), `${usbChannelTrackSource(4, "MN", "2 1", "5 1")} ${usbChannelTrackSource(202, "DN", "6 1", "10 1")}`);
}
