import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import type { PcbReadOnlyLibraryResolver } from "../../src/harness/pcb-design-compiler.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { constructionAssertion, interfaceConstructionDraft } from "./interface-construction-bundle.js";
import { genericDividerLibraryResolver } from "./generic-divider-bundle.js";

const point = (reference: string, pin: string) => ({ reference, pin });
const fixturePins: Readonly<Record<string, readonly string[]>> = {
  "Fixture:ChannelSource": ["1", "51", "52"],
  "Fixture:UsbContacts": ["A1", "A4", "A6", "A7", "B6", "B7"],
  "Fixture:ChannelProtection": ["1", "2", "3", "4", "5", "6"],
};

/** Mocks the compiler's stock-library boundary with every fixture pin; no native-library or part qualification. */
export const usbChannelLibraryResolver: PcbReadOnlyLibraryResolver = {
  resolveSymbol(libraryId) {
    const pins = fixturePins[libraryId];
    return pins === undefined ? genericDividerLibraryResolver.resolveSymbol(libraryId) : {
      libraryId, source: "kicad-stock", unitCount: 1,
      componentKind: libraryId === "Fixture:UsbContacts" ? "connector" : "generic", polarized: false,
      pins: pins.map(number => ({ number, function: `Fictional pin ${number}` })),
    };
  },
  resolveFootprint(libraryId) {
    const pads = fixturePins[libraryId];
    return pads === undefined ? genericDividerLibraryResolver.resolveFootprint(libraryId) : {
      libraryId, source: "kicad-stock", packageKind: "generic", pads,
    };
  },
};

/** Fictional source-series USB-shaped topology exercises software, not a USB-compliant PCB. */
export function usbChannelDraft(): Record<string, any> {
  const base = interfaceConstructionDraft();
  const assignments: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    U1: { "52": "LP", "51": "LN", "1": "GND" },
    R1: { "1": "LP", "2": "DP" }, R2: { "1": "LN", "2": "DN" },
    J1: { A6: "DP", B6: "DP", A7: "DN", B7: "DN", A1: "GND", A4: "VBUS" },
    D1: { "1": "DP", "6": "DP", "3": "DN", "4": "DN", "2": "GND", "5": "VBUS" },
  };
  const libraryId = (reference: string) => reference === "U1" ? "Fixture:ChannelSource"
    : reference === "J1" ? "Fixture:UsbContacts" : "Fixture:ChannelProtection";
  const components = Object.entries(assignments).map(([reference, pins]) => ({
    reference, symbolLibId: reference.startsWith("R") ? "Device:R" : libraryId(reference),
    footprintLibId: reference.startsWith("R") ? "Resistor_SMD:R_0603_1608Metric" : libraryId(reference),
    value: reference.startsWith("R") ? "22" : `FICTIONAL_${reference}`, unit: 1,
    pins: Object.entries(pins).map(([pin, net]) => ({ pin, assignment: { kind: "net", net } })),
  }));
  const nets = ["DP", "DN", "LP", "LN", "GND", "VBUS"].map(name => ({
    name, role: name === "GND" ? "ground" : name === "VBUS" ? "power" : "interface",
    electrical: structuredClone(base.nets.find((net: any) => net.name === (name === "GND" ? "GND" : "DP")).electrical),
    netClassId: name === "GND" || name === "VBUS" ? "POWER" : "SIGNAL",
    endpoints: components.flatMap(component => component.pins.filter(pin => pin.assignment.net === name)
      .map(pin => point(component.reference, pin.pin))),
  }));
  const referenceEndpoint = (reference: string) => reference === "U1" ? point("U1", "1")
    : reference === "J1" ? point("J1", "A1") : point("D1", "2");
  const routes = nets.map(net => net.name === "GND" ? structuredClone(base.routingConstraints.nets.find((route: any) => route.net === "GND")) : {
    net: net.name, topology: net.endpoints.length > 2 ? "tree" : "point_to_point", preferredLayer: "F.Cu", maxVias: 0,
    routeLength: { mode: "unbounded" }, referencePath: {
      mode: "continuous_plane", planeId: "GND_PLANE", signalLayer: "F.Cu", coverageMarginMm: 0.5,
      layerTransitions: "forbidden", terminalReferences: net.endpoints.map(signalEndpoint => ({
        signalEndpoint, referenceEndpoint: referenceEndpoint(signalEndpoint.reference),
      })),
    },
  });
  const pair = base.interfaceRequirements.interfaces[0];
  pair.endpoints = { source: { positive: point("U1", "52"), negative: point("U1", "51") },
    receiver: { positive: point("J1", "A6"), negative: point("J1", "A7") } };
  pair.geometry.maxUncoupledLengthMm = 15;
  pair.terminations.source = { kind: "source_series",
    positive: { componentReference: "R1", sourcePin: "1", linePin: "2", resistanceOhms: 22 },
    negative: { componentReference: "R2", sourcePin: "1", linePin: "2", resistanceOhms: 22 },
    maximumDistanceToEndpointMm: 2, source: constructionAssertion() };
  pair.channel = { kind: "source_series", launchNets: { positive: "LP", negative: "LN" },
    additionalReceivers: [{ positive: point("J1", "B6"), negative: point("J1", "B7") }],
    protection: [{ componentReference: "D1", positivePins: ["1", "6"], negativePins: ["3", "4"],
      ground: { pin: "2", net: "GND" }, supply: { pin: "5", net: "VBUS" }, source: constructionAssertion() }],
    escapes: nets.filter(net => ["DP", "DN", "LP", "LN"].includes(net.name)).flatMap(net => net.endpoints.map(terminal => ({
      terminal, traceWidthMm: { minimumMm: 0.2, maximumMm: 0.6 }, maximumRoutedLengthMm: 2,
    }))),
    maximumLaunchEtchLengthMm: 5, maximumBranchEtchLengthMm: 10, maxEtchLengthMm: 100, maxTotalCopperLengthMm: 100, maxEtchSkewMm: 2,
    source: constructionAssertion(),
  };
  return { ...base, components, nets,
    placementConstraints: components.map(component => ({ ...structuredClone(base.placementConstraints[0]),
      reference: component.reference, edgePreference: component.reference === "J1" ? "left" : "none" })),
    routingConstraints: { ...base.routingConstraints, nets: routes },
  };
}

export const usbChannelDependencies = { libraryResolver: usbChannelLibraryResolver, deepRuleCatalog: loadDeepRuleCatalog() };
export function usbChannelBundle(draft: unknown = usbChannelDraft()) {
  const compilation = compilePcbPlaneDesignIntentDraft(draft, usbChannelDependencies);
  if (compilation.disposition !== "ready") throw new Error(`USB channel fixture is not ready: ${JSON.stringify(compilation.issues)}`);
  return createPcbPlaneCompilationBundle({ originalPrompt: "Synthetic bounded four-net source-series channel fixture.", compilation }, usbChannelDependencies);
}
