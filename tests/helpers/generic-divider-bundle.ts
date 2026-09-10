import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import {
  createPcbDesignCompilationBundle,
  createPcbDesignCompilationBundleRef,
  type PcbDesignCompilationBundleDependencies,
} from "../../src/harness/pcb-design-compilation-bundle.js";
import {
  compilePcbDesignIntentDraft,
  type PcbReadOnlyLibraryResolver,
} from "../../src/harness/pcb-design-compiler.js";
import { PCB_DESIGN_INTENT_DRAFT_SCHEMA_VERSION } from "../../src/harness/pcb-design-contract.js";

const catalog = loadDeepRuleCatalog();

type DividerPinAssignment = Readonly<{ readonly kind: "net"; readonly net: string }>
  | Readonly<{ readonly kind: "no_connect" }>;
const dividerNet = (net: string): DividerPinAssignment => ({ kind: "net", net });

const symbolPins: Readonly<Record<string, readonly { readonly number: string; readonly function: string }[]>> = {
  "Connector_Generic:Conn_01x03": ["1", "2", "3"].map((number) => ({ number, function: `Pin ${number}` })),
  "Device:R": [{ number: "1", function: "Terminal 1" }, { number: "2", function: "Terminal 2" }],
};

const footprintPads: Readonly<Record<string, readonly string[]>> = {
  "Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical": ["1", "2", "3"],
  "Resistor_SMD:R_0603_1608Metric": ["1", "2"],
};

export const genericDividerLibraryResolver: PcbReadOnlyLibraryResolver = {
  resolveSymbol: (libraryId) => symbolPins[libraryId] === undefined ? null : {
    libraryId,
    source: "kicad-stock",
    unitCount: 1,
    componentKind: libraryId.startsWith("Connector_Generic:") ? "connector" : "generic",
    polarized: false,
    pins: symbolPins[libraryId]!,
  },
  resolveFootprint: (libraryId) => footprintPads[libraryId] === undefined ? null : {
    libraryId,
    source: "kicad-stock",
    packageKind: "generic",
    pads: footprintPads[libraryId]!,
  },
};

const electrical = (voltage: number) => ({
  voltage: { minimumV: voltage, nominalV: voltage, maximumV: voltage },
  current: { nominalA: 0.001, maximumContinuousA: 0.001, peakA: 0.001, peakDurationMs: 1_000 },
  speed: { kind: "dc", maximumFrequencyMHz: 0, minimumEdgeTimeNs: null },
});

const placement = (reference: string, edgePreference: "none" | "left" = "none") => ({
  reference,
  side: "front",
  regionMm: { minXmm: 1, maxXmm: 29, minYmm: 1, maxYmm: 19 },
  allowedRotationsDeg: edgePreference === "left" ? [0] : [0, 90, 180, 270],
  minimumEdgeClearanceMm: 1,
  minimumCourtyardClearanceMm: 0.25,
  edgePreference,
});

const route = (net: string, topology: "point_to_point" | "tree" = "point_to_point") => ({
  net,
  topology,
  preferredLayer: "F.Cu",
  maxVias: 0,
  routeLength: { mode: "unbounded" },
});

export const genericDividerDraft = () => ({
  schemaVersion: PCB_DESIGN_INTENT_DRAFT_SCHEMA_VERSION,
  kind: "pcb_design_intent_draft",
  scope: {
    sheetCount: 1,
    componentUnitPolicy: "single_unit",
    board: { shape: "rectangle", widthMm: 30, heightMm: 20, layerCount: 2, copperLayers: ["F.Cu", "B.Cu"] },
  },
  components: [
    {
      reference: "J1", symbolLibId: "Connector_Generic:Conn_01x03", value: "DIVIDER_IO",
      footprintLibId: "Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical", unit: 1,
      pins: [
        { pin: "1", assignment: dividerNet("VIN") },
        { pin: "2", assignment: dividerNet("VOUT") },
        { pin: "3", assignment: dividerNet("GND") },
      ],
    },
    {
      reference: "R1", symbolLibId: "Device:R", value: "10k",
      footprintLibId: "Resistor_SMD:R_0603_1608Metric", unit: 1,
      pins: [
        { pin: "1", assignment: dividerNet("VIN") },
        { pin: "2", assignment: dividerNet("VOUT") },
      ],
    },
    {
      reference: "R2", symbolLibId: "Device:R", value: "10k",
      footprintLibId: "Resistor_SMD:R_0603_1608Metric", unit: 1,
      pins: [
        { pin: "1", assignment: dividerNet("VOUT") },
        { pin: "2", assignment: dividerNet("GND") },
      ],
    },
  ],
  nets: [
    { name: "VIN", role: "analog", endpoints: [{ reference: "J1", pin: "1" }, { reference: "R1", pin: "1" }], electrical: electrical(3.3), netClassId: "POWER" },
    { name: "VOUT", role: "analog", endpoints: [{ reference: "J1", pin: "2" }, { reference: "R1", pin: "2" }, { reference: "R2", pin: "1" }], electrical: electrical(1.65), netClassId: "SENSE" },
    { name: "GND", role: "ground", endpoints: [{ reference: "J1", pin: "3" }, { reference: "R2", pin: "2" }], electrical: electrical(0), netClassId: "POWER" },
  ],
  netClasses: [
    { id: "POWER", traceWidthMm: 0.5, clearanceMm: 0.25, copperToEdgeMm: 0.5, allowedLayers: ["F.Cu"] },
    { id: "SENSE", traceWidthMm: 0.25, clearanceMm: 0.2, copperToEdgeMm: 0.5, allowedLayers: ["F.Cu"] },
  ],
  placementConstraints: [placement("J1", "left"), placement("R1"), placement("R2")],
  routingConstraints: {
    cornerStyle: "miter_45",
    maximumTurnAngleDeg: 45,
    minimumStraightBeforeTurnMm: 0.2,
    allowRightAngleCorners: false,
    allowAcuteInteriorCorners: false,
    allowBacktracking: false,
    allowSelfIntersections: false,
    viaPolicy: { mode: "forbidden", maxTotal: 0 },
    nets: [route("VIN"), route("VOUT", "tree"), route("GND")],
  },
  unresolved: [],
});

export function createGenericDividerBundleFixture(prompt = "Build a generic 10k/10k voltage divider candidate.") {
  return createGenericBundleFixture(genericDividerDraft(), prompt);
}

export function createGenericBundleFixture(draft: unknown, prompt: string) {
  const dependencies: PcbDesignCompilationBundleDependencies = {
    libraryResolver: genericDividerLibraryResolver,
    deepRuleCatalog: catalog,
  };
  const compilation = compilePcbDesignIntentDraft(draft, dependencies);
  if (compilation.disposition !== "ready") throw new Error(`Divider fixture compilation is not ready: ${JSON.stringify(compilation.issues)}`);
  const bundle = createPcbDesignCompilationBundle({ originalPrompt: prompt, compilation }, dependencies);
  return Object.freeze({ bundle, reference: createPcbDesignCompilationBundleRef(bundle), dependencies });
}
