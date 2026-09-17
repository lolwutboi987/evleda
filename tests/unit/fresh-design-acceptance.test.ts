import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { createSchematicRenderClearanceEvidence } from "../../src/integrations/schematic-render-clearance.js";
import { schematicRenderCapture, COLLIDING_SCHEMATIC_SVG } from "../helpers/schematic-render-capture.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { createPcbLibrarySourceSelection } from "../../src/harness/pcb-library-source-binding.js";
import {
  FRESH_DESIGN_ACCEPTANCE_LIMITS,
  FRESH_DESIGN_CLEARANCE_EVIDENCE_SCHEMA_VERSION,
  createFreshDesignPracticeProfile,
  evaluateFreshDesignAcceptance,
  type FreshDesignAcceptanceArtifacts,
  type FreshDesignAcceptanceEvidence,
} from "../../src/harness/fresh-design-acceptance.js";
import {
  PCB_DEEP_RULE_BINDING_SCHEMA_VERSION,
  PCB_LIBRARY_RESOLVER_OUTPUT_LIMITS,
  PCB_LIBRARY_BINDING_SCHEMA_VERSION,
  compilePcbDesignIntentDraftV1 as compilePcbDesignIntentDraft,
  createPcbAcceptancePlanV1 as createPcbAcceptancePlan,
  createPcbAcceptancePlan as createCurrentPcbAcceptancePlan,
  type PcbReadOnlyLibraryResolver,
  type PcbResolvedFootprint,
  type PcbResolvedSymbol,
} from "../../src/harness/pcb-design-compiler.js";
import { PCB_DESIGN_INTENT_DRAFT_SCHEMA_VERSION } from "../../src/harness/pcb-design-contract.js";
import { parseFreshPcbSource } from "../../src/harness/fresh-kicad-parser.js";
import {nativePadObservationFixture,withNativePadFixtureIds} from "../helpers/native-pad-observation-fixture.js";

const catalog = loadDeepRuleCatalog();
const capturedAttempt13 = JSON.parse(await readFile(new URL("../fixtures/fresh-project/attempt13-acceptance-inputs.json", import.meta.url), "utf8")) as {
  reportSha256: string; contract: FreshDesignAcceptanceArtifacts["contract"];
  pcb: { sha256: string; size: number; utf8Base64: string };
  schematic: { sha256: string; utf8Base64: string }; netlist: { sha256: string; utf8Base64: string };
  ercResult: FreshDesignAcceptanceEvidence["erc"]["result"];
  drcResult: FreshDesignAcceptanceEvidence["drc"]["result"];
  visualResult: FreshDesignAcceptanceEvidence["visualInspection"]["result"];
  nativeDrc: { violations: { type: string }[]; unconnected_items: unknown[] };
};

const dcElectrical = (voltage: number, current: number) => ({
  voltage: { minimumV: voltage, nominalV: voltage, maximumV: voltage },
  current: { nominalA: current, maximumContinuousA: current, peakA: current, peakDurationMs: 1_000 },
  speed: { kind: "dc", maximumFrequencyMHz: 0, minimumEdgeTimeNs: null },
});

const placement = (
  reference: string,
  edgePreference: "none" | "left" = "none",
  exactRotation = false,
) => ({
  reference,
  side: "front",
  regionMm: { minXmm: 1, maxXmm: 29, minYmm: 1, maxYmm: 19 },
  allowedRotationsDeg: exactRotation ? [0] : [0, 90, 180, 270],
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

const ledDraft = () => ({
  schemaVersion: PCB_DESIGN_INTENT_DRAFT_SCHEMA_VERSION,
  kind: "pcb_design_intent_draft",
  scope: {
    sheetCount: 1,
    componentUnitPolicy: "single_unit",
    board: { shape: "rectangle", widthMm: 30, heightMm: 20, layerCount: 2, copperLayers: ["F.Cu", "B.Cu"] },
  },
  components: [
    {
      reference: "J1", symbolLibId: "Connector_Generic:Conn_01x02", value: "POWER_IN",
      footprintLibId: "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical", unit: 1,
      pins: [
        { pin: "1", assignment: { kind: "net", net: "VCC" } },
        { pin: "2", assignment: { kind: "net", net: "GND" } },
      ],
    },
    {
      reference: "R1", symbolLibId: "Device:R", value: "1k",
      footprintLibId: "Resistor_SMD:R_0603_1608Metric", unit: 1,
      pins: [
        { pin: "1", assignment: { kind: "net", net: "VCC" } },
        { pin: "2", assignment: { kind: "net", net: "LED_A" } },
      ],
    },
    {
      reference: "D1", symbolLibId: "Device:LED", value: "GREEN",
      footprintLibId: "LED_SMD:LED_0603_1608Metric", unit: 1,
      pins: [
        { pin: "1", assignment: { kind: "net", net: "GND" } },
        { pin: "2", assignment: { kind: "net", net: "LED_A" } },
      ],
    },
    {
      reference: "C1", symbolLibId: "Device:C", value: "100nF",
      footprintLibId: "Capacitor_SMD:C_0603_1608Metric", unit: 1,
      pins: [
        { pin: "1", assignment: { kind: "net", net: "VCC" } },
        { pin: "2", assignment: { kind: "net", net: "GND" } },
      ],
    },
  ],
  nets: [
    { name: "VCC", role: "power_input", endpoints: [{ reference: "J1", pin: "1" }, { reference: "R1", pin: "1" }, { reference: "C1", pin: "1" }], electrical: dcElectrical(5, 0.1), netClassId: "POWER" },
    { name: "LED_A", role: "passive", endpoints: [{ reference: "R1", pin: "2" }, { reference: "D1", pin: "2" }], electrical: dcElectrical(2, 0.01), netClassId: "SIGNAL" },
    { name: "GND", role: "ground", endpoints: [{ reference: "J1", pin: "2" }, { reference: "D1", pin: "1" }, { reference: "C1", pin: "2" }], electrical: dcElectrical(0, 0.1), netClassId: "POWER" },
  ],
  netClasses: [
    { id: "POWER", traceWidthMm: 0.5, clearanceMm: 0.25, copperToEdgeMm: 0.3, allowedLayers: ["F.Cu"] },
    { id: "SIGNAL", traceWidthMm: 0.25, clearanceMm: 0.2, copperToEdgeMm: 0.3, allowedLayers: ["F.Cu"] },
  ],
  placementConstraints: [placement("J1", "left", true), placement("R1"), placement("D1"), placement("C1")],
  routingConstraints: {
    cornerStyle: "miter_45",
    maximumTurnAngleDeg: 45,
    minimumStraightBeforeTurnMm: 0.25,
    allowRightAngleCorners: false,
    allowAcuteInteriorCorners: false,
    allowBacktracking: false,
    allowSelfIntersections: false,
    viaPolicy: { mode: "forbidden", maxTotal: 0 },
    nets: [route("VCC", "tree"), route("LED_A"), route("GND", "tree")],
  },
  unresolved: [],
});

const dividerDraft = () => ({
  schemaVersion: PCB_DESIGN_INTENT_DRAFT_SCHEMA_VERSION,
  kind: "pcb_design_intent_draft",
  scope: {
    sheetCount: 1,
    componentUnitPolicy: "single_unit",
    board: { shape: "rectangle", widthMm: 30, heightMm: 20, layerCount: 2, copperLayers: ["F.Cu", "B.Cu"] },
  },
  components: [
    {
      reference: "J1", symbolLibId: "Connector_Generic:Conn_01x04", value: "DIVIDER_IO",
      footprintLibId: "Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical", unit: 1,
      pins: [
        { pin: "1", assignment: { kind: "net", net: "VIN" } },
        { pin: "2", assignment: { kind: "net", net: "VOUT" } },
        { pin: "3", assignment: { kind: "net", net: "GND" } },
        { pin: "4", assignment: { kind: "no_connect" } },
      ],
    },
    {
      reference: "R1", symbolLibId: "Device:R", value: "10k",
      footprintLibId: "Resistor_SMD:R_0603_1608Metric", unit: 1,
      pins: [
        { pin: "1", assignment: { kind: "net", net: "VIN" } },
        { pin: "2", assignment: { kind: "net", net: "VOUT" } },
      ],
    },
    {
      reference: "R2", symbolLibId: "Device:R", value: "10k",
      footprintLibId: "Resistor_SMD:R_0603_1608Metric", unit: 1,
      pins: [
        { pin: "1", assignment: { kind: "net", net: "VOUT" } },
        { pin: "2", assignment: { kind: "net", net: "GND" } },
      ],
    },
  ],
  nets: [
    { name: "VIN", role: "analog", endpoints: [{ reference: "J1", pin: "1" }, { reference: "R1", pin: "1" }], electrical: dcElectrical(3.3, 0.001), netClassId: "DEFAULT" },
    { name: "VOUT", role: "analog", endpoints: [{ reference: "J1", pin: "2" }, { reference: "R1", pin: "2" }, { reference: "R2", pin: "1" }], electrical: dcElectrical(1.65, 0.001), netClassId: "DEFAULT" },
    { name: "GND", role: "ground", endpoints: [{ reference: "J1", pin: "3" }, { reference: "R2", pin: "2" }], electrical: dcElectrical(0, 0.001), netClassId: "DEFAULT" },
  ],
  netClasses: [{ id: "DEFAULT", traceWidthMm: 0.25, clearanceMm: 0.2, copperToEdgeMm: 0.3, allowedLayers: ["F.Cu", "B.Cu"] }],
  placementConstraints: [placement("J1", "left", true), placement("R1"), placement("R2")],
  routingConstraints: {
    cornerStyle: "miter_45",
    maximumTurnAngleDeg: 45,
    minimumStraightBeforeTurnMm: 0.2,
    allowRightAngleCorners: false,
    allowAcuteInteriorCorners: false,
    allowBacktracking: false,
    allowSelfIntersections: false,
    viaPolicy: { mode: "bounded", maxTotal: 3, diameterMm: 0.6, drillMm: 0.3, minimumAnnularRingMm: 0.15 },
    nets: [
      { ...route("VIN"), preferredLayer: "either", maxVias: 1 },
      { ...route("VOUT", "tree"), preferredLayer: "either", maxVias: 1 },
      { ...route("GND"), preferredLayer: "either", maxVias: 1 },
    ],
  },
  unresolved: [],
});

const symbolPins: Readonly<Record<string, readonly { readonly number: string; readonly function: string }[]>> = {
  "Connector_Generic:Conn_01x02": [{ number: "1", function: "Pin 1" }, { number: "2", function: "Pin 2" }],
  "Connector_Generic:Conn_01x04": [{ number: "1", function: "Pin 1" }, { number: "2", function: "Pin 2" }, { number: "3", function: "Pin 3" }, { number: "4", function: "Pin 4" }],
  "Connector_Generic:Conn_01x03": [{ number: "1", function: "Pin 1" }, { number: "2", function: "Pin 2" }, { number: "3", function: "Pin 3" }],
  "Device:R": [{ number: "1", function: "Terminal 1" }, { number: "2", function: "Terminal 2" }],
  "Device:C": [{ number: "1", function: "Terminal 1" }, { number: "2", function: "Terminal 2" }],
  "Device:LED": [{ number: "1", function: "Cathode" }, { number: "2", function: "Anode" }],
};

const footprintPads: Readonly<Record<string, readonly string[]>> = {
  "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical": ["1", "2"],
  "Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical": ["1", "2", "3", "4"],
  "Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical": ["1", "2", "3"],
  "Resistor_SMD:R_0603_1608Metric": ["1", "2"],
  "Capacitor_SMD:C_0603_1608Metric": ["1", "2"],
  "LED_SMD:LED_0603_1608Metric": ["1", "2"],
};

const resolver: PcbReadOnlyLibraryResolver = {
  resolveSymbol: (libraryId): PcbResolvedSymbol | null => {
    const pins = symbolPins[libraryId];
    return pins === undefined ? null : {
      libraryId,
      source: "kicad-stock",
      unitCount: 1,
      componentKind: libraryId.startsWith("Connector_Generic:") ? "connector" : "generic",
      polarized: libraryId === "Device:LED",
      pins,
    };
  },
  resolveFootprint: (libraryId): PcbResolvedFootprint | null => {
    const pads = footprintPads[libraryId];
    return pads === undefined ? null : { libraryId, source: "kicad-stock", packageKind: "generic", pads };
  },
};

const compile = (draft: unknown, libraryResolver: PcbReadOnlyLibraryResolver = resolver): FreshDesignAcceptanceArtifacts => {
  const result = compilePcbDesignIntentDraft(draft, { libraryResolver, deepRuleCatalog: catalog });
  if (result.disposition !== "ready" || result.contract === null || result.libraryBinding === null
      || result.deepRuleBinding === null || result.acceptancePlan === null) {
    throw new Error(`Fixture did not compile: ${JSON.stringify(result.issues)}`);
  }
  return {
    contract: result.contract,
    libraryResolver,
    libraryBinding: result.libraryBinding,
    deepRuleCatalog: catalog,
    deepRuleBinding: result.deepRuleBinding,
    acceptancePlan: result.acceptancePlan,
  };
};

const schematicSymbol = (reference: string, libId: string, value: string, footprint: string) => `
  (symbol (lib_id "${libId}") (at 20 20 0)
    (property "Reference" "${reference}")
    (property "Value" "${value}")
    (property "Footprint" "${footprint}"))`;

const schematicSource = (artifacts: FreshDesignAcceptanceArtifacts, noConnects = 0): string => `(kicad_sch
  (version 20250316)
  (generator "generic-acceptance-fixture")
  ${artifacts.contract.components.map((component) => schematicSymbol(component.reference, component.symbolLibId, component.value, component.footprintLibId)).join("\n  ")}
  ${artifacts.contract.nets.map((net, index) => `(global_label "${net.name}" (shape passive) (at ${20 + index} 20 0))`).join("\n  ")}
  ${Array.from({ length: noConnects }, (_entry, index) => `(no_connect (at ${20 + index} 30))`).join("\n  ")}
)
`;

const netlistSource = (artifacts: FreshDesignAcceptanceArtifacts): string => `(export
  (components
    ${artifacts.contract.components.map((component) => {
      const separator = component.symbolLibId.indexOf(":");
      const library = component.symbolLibId.slice(0, separator);
      const part = component.symbolLibId.slice(separator + 1);
      return `(comp (ref "${component.reference}") (value "${component.value}") (footprint "${component.footprintLibId}") (libsource (lib "${library}") (part "${part}")))`;
    }).join("\n    ")})
  (nets
    ${[
      ...artifacts.contract.nets.map((net, index) => `(net (code "${index + 1}") (name "${net.name}") ${net.endpoints.map((endpoint) => `(node (ref "${endpoint.reference}") (pin "${endpoint.pin}") (pintype "passive"))`).join(" ")})`),
      ...artifacts.contract.components.flatMap((component) => component.pins.flatMap((pin) =>
        pin.assignment.kind === "no_connect"
          ? [`(net (code "nc-${component.reference}-${pin.pin}") (name "unconnected-(${component.reference}-Pin_${pin.pin}-Pad${pin.pin})") (node (ref "${component.reference}") (pin "${pin.pin}") (pintype "passive+no_connect")))`]
          : [])),
    ].join("\n    ")})
)
`;

type Pad = readonly [number, number, string | null];

const footprint = (
  reference: string,
  libraryId: string,
  value: string,
  x: number,
  y: number,
  halfWidth: number,
  halfHeight: number,
  pads: readonly Pad[],
  netOrdinals: Readonly<Record<string, number>>,
) => `
  (footprint "${libraryId}" (layer "F.Cu") (at ${x} ${y} 0)
    (property "Reference" "${reference}") (property "Value" "${value}")
    (fp_rect (start ${-halfWidth} ${-halfHeight}) (end ${halfWidth} ${halfHeight}) (stroke (width 0.05) (type default)) (fill none) (layer "F.CrtYd"))
    (fp_rect (start ${-halfWidth + 0.1} ${-halfHeight + 0.1}) (end ${halfWidth - 0.1} ${halfHeight - 0.1}) (stroke (width 0.05) (type default)) (fill none) (layer "F.Fab"))
    ${pads.map(([px, py, net], index) => `(pad "${index + 1}" smd rect (at ${px} ${py}) (size 1 1) (layers "F.Cu")${net === null ? "" : ` (net ${netOrdinals[net]} "${net}")`})`).join("\n    ")}
  )`;

const boardHeader = (nets: readonly string[]) => `(kicad_pcb
  (version 20250316)
  (generator "generic-acceptance-fixture")
  (general)
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  ${nets.map((net, index) => `(net ${index + 1} "${net}")`).join(" ")}
  (gr_rect (start 0 0) (end 30 20) (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts"))`;

const LED_ARTIFACTS = compile(ledDraft());
const LED_NETS = { VCC: 1, LED_A: 2, GND: 3 } as const;
const LED_PCB = `${boardHeader(["VCC", "LED_A", "GND"])}
  ${footprint("J1", "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical", "POWER_IN", 2.5, 10, 1.25, 2.75, [[0, -2, "VCC"], [0, 2, "GND"]], LED_NETS)}
  ${footprint("C1", "Capacitor_SMD:C_0603_1608Metric", "100nF", 7, 10, 0.75, 1.25, [[0, -1, "VCC"], [0, 1, "GND"]], LED_NETS)}
  ${footprint("R1", "Resistor_SMD:R_0603_1608Metric", "1k", 13, 8, 1.25, 0.75, [[-1, 0, "VCC"], [1, 0, "LED_A"]], LED_NETS)}
  ${footprint("D1", "LED_SMD:LED_0603_1608Metric", "GREEN", 13, 12, 1.25, 0.75, [[-1, 0, "GND"], [1, 0, "LED_A"]], LED_NETS)}
  (segment (start 2.5 8) (end 7 9) (width 0.5) (layer "F.Cu") (net 1) (uuid "vcc-a"))
  (segment (start 7 9) (end 12 8) (width 0.5) (layer "F.Cu") (net 1) (uuid "vcc-b"))
  (segment (start 14 8) (end 14 12) (width 0.25) (layer "F.Cu") (net 2) (uuid "led-a"))
  (segment (start 2.5 12) (end 7 11) (width 0.5) (layer "F.Cu") (net 3) (uuid "gnd-a"))
  (segment (start 7 11) (end 12 12) (width 0.5) (layer "F.Cu") (net 3) (uuid "gnd-b"))
)
`;

const DIVIDER_ARTIFACTS = compile(dividerDraft());
const DIVIDER_NETS = { VIN: 1, VOUT: 2, GND: 3, "unconnected-(J1-Pin_4-Pad4)":4 } as const;
const DIVIDER_PCB = `${boardHeader(["VIN", "VOUT", "GND", "unconnected-(J1-Pin_4-Pad4)"])}
  ${footprint("J1", "Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical", "DIVIDER_IO", 2.5, 10, 1.25, 4.25, [[0, -3, "VIN"], [0, -1, "VOUT"], [0, 1, "GND"], [0, 3, "unconnected-(J1-Pin_4-Pad4)"]], DIVIDER_NETS)}
  ${footprint("R1", "Resistor_SMD:R_0603_1608Metric", "10k", 9, 7, 1.25, 0.75, [[-1, 0, "VIN"], [1, 0, "VOUT"]], DIVIDER_NETS)}
  ${footprint("R2", "Resistor_SMD:R_0603_1608Metric", "10k", 17, 11, 1.25, 0.75, [[-1, 0, "VOUT"], [1, 0, "GND"]], DIVIDER_NETS)}
  (segment (start 2.5 7) (end 8 7) (width 0.25) (layer "F.Cu") (net 1) (uuid "vin"))
  (segment (start 2.5 9) (end 8 9) (width 0.25) (layer "F.Cu") (net 2) (uuid "vout-a"))
  (segment (start 8 9) (end 10 7) (width 0.25) (layer "F.Cu") (net 2) (uuid "vout-b"))
  (segment (start 10 7) (end 12 7) (width 0.25) (layer "F.Cu") (net 2) (uuid "vout-c"))
  (segment (start 12 7) (end 16 11) (width 0.25) (layer "F.Cu") (net 2) (uuid "vout-d"))
  (segment (start 2.5 11) (end 18 11) (width 0.25) (layer "F.Cu") (net 3) (uuid "gnd"))
)
`;

const erc = { origin: "host", result: JSON.stringify({ status: "clean", findings: [], metadata: { available: true, violation_count: 0 } }) } as const;
const drc = { origin: "host", result: JSON.stringify({ status: "clean", findings: [], metadata: { available: true, violations: 0, unconnected_items: 0, courtyard_issues: 0 } }) } as const;
const visualInspection = { origin: "host", result: JSON.stringify({ status: "PASS", findings: [] }) } as const;

const clearanceEvidence = (artifacts: FreshDesignAcceptanceArtifacts, pcbSource: string) => ({
  origin: "host" as const,
  schemaVersion: FRESH_DESIGN_CLEARANCE_EVIDENCE_SCHEMA_VERSION,
  source: "kicad-effective-netclass-rules" as const,
  pcbSha256: createHash("sha256").update(pcbSource, "utf8").digest("hex"),
  rulesSourceSha256: "a".repeat(64),
  netClasses: artifacts.contract.netClasses.map((netClass) => ({
    id: netClass.id,
    configuredClearanceMm: netClass.clearanceMm,
    effectiveClearanceMm: netClass.clearanceMm,
  })),
});

const evidence = (
  artifacts: FreshDesignAcceptanceArtifacts,
  pcbSource: string,
  noConnects: number,
  overrides: Partial<FreshDesignAcceptanceEvidence> = {},
): FreshDesignAcceptanceEvidence => ({
  schematicSource: schematicSource(artifacts, noConnects),
  netlistSource: netlistSource(artifacts),
  pcbSource,
  clearance: clearanceEvidence(artifacts, pcbSource),
  erc,
  drc,
  visualInspection,
  ...overrides,
});

const row = (result: ReturnType<typeof evaluateFreshDesignAcceptance>, id: string) =>
  result.requirements.find((entry) => entry.id === id);

const appendPcbForms = (source: string, ...forms: readonly string[]): string =>
  source.replace(/\)\s*$/u, `${forms.join("\n")}\n)\n`);

const withNamedNetReferences = (source: string, names: readonly string[]): string => {
  const tableLine = names.map((name, index) => `(net ${index + 1} "${name}")`).join(" ");
  if (!source.includes(tableLine)) throw new Error("Fixture numeric net table is absent.");
  return source.replace(tableLine, "").replace(/\(net (\d+)(?: "[^"\r\n]*")?\)/gu, (_form, id: string) => {
    const netName = names[Number(id) - 1];
    if (netName === undefined) throw new Error(`Fixture net ID ${id} is not defined.`);
    return `(net "${netName}")`;
  });
};

const reidentify = <Value extends { identity: unknown; schemaVersion: string }>(value: Value, schemaVersion: string): void => {
  const mutable = value as unknown as Record<string, unknown>;
  const { identity: _identity, ...payload } = mutable;
  mutable.identity = canonicalIdentity(payload, schemaVersion);
};

const recursivelyFrozen = (value: unknown, seen = new Set<object>()): boolean => {
  if (value === null || typeof value !== "object") return true;
  if (seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every((child) => recursivelyFrozen(child, seen));
};

const cloneArtifacts = (artifacts: FreshDesignAcceptanceArtifacts): FreshDesignAcceptanceArtifacts => ({
  contract: structuredClone(artifacts.contract),
  libraryResolver: artifacts.libraryResolver,
  libraryBinding: structuredClone(artifacts.libraryBinding),
  deepRuleCatalog: structuredClone(artifacts.deepRuleCatalog),
  ...(artifacts.deepRuleSelectionOptions === undefined
    ? {}
    : { deepRuleSelectionOptions: structuredClone(artifacts.deepRuleSelectionOptions) }),
  deepRuleBinding: structuredClone(artifacts.deepRuleBinding),
  acceptancePlan: structuredClone(artifacts.acceptancePlan),
});

describe("generic compiler-bound fresh-design acceptance", () => {
  it("reproduces selected source pins and rejects source-only drift before or during independent acceptance", () => {
    let rawText = "original raw geometry and text";
    let onResolve = () => {};
    const captureOrder: string[] = [];
    const sourceResolver: PcbReadOnlyLibraryResolver = {
      resolveSymbol(id) { captureOrder.push("resolve"); onResolve(); return resolver.resolveSymbol(id); },
      resolveFootprint(id) { captureOrder.push("resolve"); onResolve(); return resolver.resolveFootprint(id); },
      captureSourceSelection(selected) {
        captureOrder.push("capture");
        return createPcbLibrarySourceSelection({
          policyIdentity: canonicalIdentity({ hostPolicy: "acceptance source fixture" }, "evleda.kicad-stock-catalog-policy.v1"),
          records: [
            ...selected.symbolIds.map(libraryId => ({ kind: "symbol" as const, libraryId, sourceIdentity: contentIdentity(`${libraryId}:${rawText}`),
              inspectionIdentity: canonicalIdentity({ libraryId }, "evleda.kicad-stock-symbol-inspection.v1") })),
            ...selected.footprintIds.map(libraryId => ({ kind: "footprint" as const, libraryId, sourceIdentity: contentIdentity(`${libraryId}:${rawText}`),
              inspectionIdentity: canonicalIdentity({ libraryId }, "evleda.kicad-stock-footprint-inspection.v2") })),
          ],
        }, selected);
      },
    };
    const artifacts = compile(ledDraft(), sourceResolver);
    const input = evidence(artifacts, LED_PCB, 0);
    captureOrder.length = 0;
    const current = evaluateFreshDesignAcceptance(input, artifacts);
    expect(current.passed).toBe(true);
    expect(row(current, "contract:integrity")?.status).toBe("pass");
    expect(captureOrder[0]).toBe("capture");
    expect(captureOrder.at(-1)).toBe("capture");
    expect(captureOrder.filter(entry => entry === "capture")).toHaveLength(2);

    rawText = "changed geometry and text, unchanged pins and pads";
    expect(row(evaluateFreshDesignAcceptance(input, artifacts), "contract:integrity")?.status).toBe("fail");
    rawText = "original raw geometry and text";
    onResolve = () => { rawText = "source changed during acceptance resolution"; };
    expect(row(evaluateFreshDesignAcceptance(input, artifacts), "contract:integrity")?.status).toBe("fail");
    onResolve = () => {};
    rawText = "original raw geometry and text";
    expect(row(evaluateFreshDesignAcceptance(input, { ...artifacts, libraryResolver: resolver }), "contract:integrity")?.status).toBe("fail");
    expect(row(evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, LED_PCB, 0), { ...LED_ARTIFACTS, libraryResolver: sourceResolver }), "contract:integrity")?.status).toBe("fail");

    const tampered = cloneArtifacts(artifacts);
    (tampered.libraryBinding.sourceSelection!.records[0]!.sourceIdentity as { digest: string }).digest = "f".repeat(64);
    reidentify(tampered.libraryBinding.sourceSelection!, tampered.libraryBinding.sourceSelection!.schemaVersion);
    reidentify(tampered.libraryBinding, PCB_LIBRARY_BINDING_SCHEMA_VERSION);
    const rehashed = { ...tampered, acceptancePlan: createPcbAcceptancePlan(tampered.contract, tampered.libraryBinding, tampered.deepRuleBinding) };
    expect(row(evaluateFreshDesignAcceptance(input, rehashed), "contract:integrity")?.status).toBe("fail");
  });

  it("preserves v1 results and requires a fresh host-branded native ink receipt for v2", () => {
    const legacyEvidence = evidence(LED_ARTIFACTS, LED_PCB, 0); const legacy = evaluateFreshDesignAcceptance(legacyEvidence, LED_ARTIFACTS);
    expect(legacy).toMatchObject({ schemaVersion: "evleda.fresh-design-acceptance.v1", passed: true });
    const plan = createCurrentPcbAcceptancePlan(LED_ARTIFACTS.contract, LED_ARTIFACTS.libraryBinding, LED_ARTIFACTS.deepRuleBinding);
    const expected = { sources: { schematic: contentIdentity(legacyEvidence.schematicSource), pcb: contentIdentity(legacyEvidence.pcbSource), projectSettings: contentIdentity("settings") },
      executable: { sha256: "a".repeat(64), sizeBytes: 100 }, validationSourceBindingIdentity: canonicalIdentity({ pass: "native" }, "evleda.pcb-harness-validation-source-binding.v1") };
    const artifacts = { ...LED_ARTIFACTS, acceptancePlan: plan, schematicRenderExpected: expected };
    const missing = evaluateFreshDesignAcceptance(legacyEvidence, artifacts);
    expect(missing.requirements).toHaveLength(legacy.requirements.length + 1); expect(row(missing, "schematic-render-clearance")?.status).toBe("unknown");
    const render = createSchematicRenderClearanceEvidence(schematicRenderCapture(expected), expected);
    const accepted = evaluateFreshDesignAcceptance({ ...legacyEvidence, schematicRenderClearance: render }, artifacts);
    expect(accepted).toMatchObject({ schemaVersion: "evleda.fresh-design-acceptance.v2", passed: true }); expect(accepted.sourceHashes).toEqual(legacy.sourceHashes);
    expect(row(accepted, "schematic-render-clearance")?.detail).toContain("ink clearance only");
    for (const input of [structuredClone(render), { ...render, status: "pass" as const }]) expect(row(evaluateFreshDesignAcceptance({ ...legacyEvidence, schematicRenderClearance: input }, artifacts), "schematic-render-clearance")?.status).toBe("unknown");
    const stale = evaluateFreshDesignAcceptance({ ...legacyEvidence, schematicSource: `${legacyEvidence.schematicSource} `, schematicRenderClearance: render }, artifacts);
    expect(row(stale, "schematic-render-clearance")?.status).toBe("unknown");
    const collision = createSchematicRenderClearanceEvidence(schematicRenderCapture(expected, undefined, COLLIDING_SCHEMATIC_SVG), expected);
    const failed = evaluateFreshDesignAcceptance({ ...legacyEvidence, schematicRenderClearance: collision }, artifacts);
    expect(row(failed, "schematic-render-clearance")).toMatchObject({ status: "fail", detail: expect.stringContaining("SVG element") });
  });
  it("accepts modern named net references while preserving the exact legacy pad and track maps", () => {
    const modern = withNamedNetReferences(LED_PCB, ["VCC", "LED_A", "GND"]);
    const oldBoard = parseFreshPcbSource(LED_PCB);
    const newBoard = parseFreshPcbSource(modern);
    const padFacts=(board:ReturnType<typeof parseFreshPcbSource>)=>board.footprints.map(footprint=>footprint.pads.map(({physical,...pad})=>{
      const {source:_rawSource,...facts}=physical;return {...pad,physical:facts};
    }));
    expect(padFacts(newBoard)).toEqual(padFacts(oldBoard));
    // New physical capture retains the distinct original net serialization,
    // while the electrical/geometry facts above remain equal.
    expect(newBoard.footprints[0]!.pads[0]!.physical.source).not.toEqual(oldBoard.footprints[0]!.pads[0]!.physical.source);
    expect(newBoard.segments).toEqual(oldBoard.segments);
    const accepted = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, modern, 0), LED_ARTIFACTS);
    expect(accepted.requirements.filter((entry) => entry.kind === "pcb_component").every((entry) => entry.status === "pass")).toBe(true);
    expect(accepted.passed).toBe(true);
  });

  it("does not accept an F.Cu route as reaching an otherwise identical B.Cu-only SMD pad",()=>{
    const pad=parseFreshPcbSource(LED_PCB).footprints.find(fp=>fp.reference==="J1")!.pads.find(p=>p.number==="1")!;
    const wrongLayer=LED_PCB.replace(pad.physical.source,pad.physical.source.replace('(layers "F.Cu")','(layers "B.Cu")'));
    const result=evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS,wrongLayer,0),LED_ARTIFACTS);
    expect(row(result,"component:J1:pcb")?.status).toBe("pass");
    expect(row(result,"net:VCC:routed")?.status).toBe("fail");
    expect(result.passed).toBe(false);
  });
  it.each(["np_thru_hole","unknown_pad_type","thru_hole-without-drill","smd-with-drill"])("does not infer electrical pad contact from copper selectors for %s",kind=>{
    const pad=parseFreshPcbSource(LED_PCB).footprints.find(fp=>fp.reference==="J1")!.pads.find(p=>p.number==="1")!;
    let changed=pad.physical.source.replace('(layers "F.Cu")','(layers "*.Cu")');
    if(kind==="np_thru_hole")changed=changed.replace('smd rect','np_thru_hole rect').replace('(size 1 1)','(size 1 1) (drill 0.4)');
    if(kind==="unknown_pad_type")changed=changed.replace('smd rect','unknown_pad_type rect');
    if(kind==="thru_hole-without-drill")changed=changed.replace('smd rect','thru_hole rect');
    if(kind==="smd-with-drill")changed=changed.replace('(size 1 1)','(size 1 1) (drill 0.4)');
    const result=evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS,LED_PCB.replace(pad.physical.source,changed),0),LED_ARTIFACTS);
    expect(row(result,"component:J1:pcb")?.status).toBe("fail");
    expect(row(result,"net:VCC:routed")?.status).toBe("fail");
    expect(result.passed).toBe(false);
  });

  it("preserves an added paste aperture as a feature requiring native/library evidence, not a new pin",()=>{
    const pad=parseFreshPcbSource(LED_PCB).footprints.find(fp=>fp.reference==="J1")!.pads[0]!;
    const added=LED_PCB.replace(pad.physical.source,pad.physical.source+'\n(pad "" smd rect (at 0 0) (size 0.8 0.8) (layers "F.Paste"))');
    const result=evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS,added,0),LED_ARTIFACTS);
    expect(row(result,"component:J1:pcb")?.status).toBe("unknown");
    expect(row(result,"component:J1:pcb")?.detail).toContain("paste apertures are not pins");
    expect(result.passed).toBe(false);
  });

  it("reports footprint plated PAD holes independently of a zero routed-VIA inventory",()=>{
    const pad=parseFreshPcbSource(LED_PCB).footprints.find(fp=>fp.reference==="J1")!.pads[0]!;
    const source=LED_PCB.replace(pad.physical.source,pad.physical.source.replace('smd rect','thru_hole rect').replace('(size 1 1)','(size 1 1) (drill 0.4)').replace('(layers "F.Cu")','(layers "*.Cu")'));
    const result=evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS,source,0),LED_ARTIFACTS);
    expect(result.evidenceLimitations.some(value=>value.includes("Routed VIA objects: 0; plated through-hole footprint PAD primitives: 1"))).toBe(true);
    expect(row(result,"route:VCC:vias")?.status).toBe("pass");
  });
  it("accepts an interior same-terminal plated thermal member without inventing a routing leaf, while retaining a real track-cycle failure",async()=>{
    let source=withNativePadFixtureIds(LED_PCB);
    const pad=parseFreshPcbSource(source).footprints.find(fp=>fp.reference==="R1")!.pads.find(p=>p.number==="2")!;
    const ep=pad.physical.source.replace('(size 1 1)','(size 2 2)');
    // The hole is 0.5 mm along the existing LED_A track, inside the 2x2 EP.
    const hole='(pad "2" thru_hole circle (at 1 0.5) (size 0.5 0.5) (drill 0.2) (layers "*.Cu") (net 2 "LED_A") (uuid "88888888-8888-4888-8888-888888888888"))';
    source=source.replace(pad.physical.source,ep+"\n"+hole);
    const captured=await nativePadObservationFixture(source);
    const artifacts={...LED_ARTIFACTS,nativePadExpected:captured.expected};
    const accepted=evaluateFreshDesignAcceptance({...evidence(LED_ARTIFACTS,source,0),nativePads:captured.observation},artifacts);
    expect(row(accepted,"component:R1:pcb")?.status).toBe("pass");
    expect(row(accepted,"net:LED_A:routed")?.status).toBe("pass");
    expect(accepted.passed).toBe(true);
    const extra='(segment (start 14 8) (end 18 8) (width 0.25) (layer "F.Cu") (net 2) (uuid "cycle-1"))\n(segment (start 18 8) (end 18 12) (width 0.25) (layer "F.Cu") (net 2) (uuid "cycle-2"))\n(segment (start 18 12) (end 14 12) (width 0.25) (layer "F.Cu") (net 2) (uuid "cycle-3"))';
    const cyclic=source.replace(/\)\s*$/u,extra+"\n)");
    const cycleCapture=await nativePadObservationFixture(cyclic,source);
    const rejected=evaluateFreshDesignAcceptance({...evidence(LED_ARTIFACTS,cyclic,0),nativePads:cycleCapture.observation},{...LED_ARTIFACTS,nativePadExpected:cycleCapture.expected});
    expect(row(rejected,"net:LED_A:routed")?.status).toBe("fail");
    expect(row(rejected,"net:LED_A:routed")?.detail).toContain("acyclic=false");
    expect(rejected.passed).toBe(false);
  });

  it.each(["0", "123"])("retains quoted numeric net name %s as a name, not an ID", (name) => {
    const draft = ledDraft();
    for (const component of draft.components) for (const pin of component.pins) if (pin.assignment.net === "GND") pin.assignment.net = name;
    draft.nets.find((net) => net.name === "GND")!.name = name;
    draft.routingConstraints.nets.find((net) => net.net === "GND")!.net = name;
    const artifacts = compile(draft);
    const modern = withNamedNetReferences(LED_PCB, ["VCC", "LED_A", "GND"]).replaceAll('"GND"', `"${name}"`);
    const result = evaluateFreshDesignAcceptance(evidence(artifacts, modern, 0), artifacts);
    expect(result.requirements.filter((entry) => entry.kind === "pcb_component").every((entry) => entry.status === "pass")).toBe(true);
    expect(parseFreshPcbSource(modern).segments.filter((segment) => segment.netName === name)).toHaveLength(2);
  });

  it("keeps an empty quoted net parsed as no-net but rejects erasing a native intentional NC assignment", () => {
    const modern = withNamedNetReferences(DIVIDER_PCB, ["VIN", "VOUT", "GND", "unconnected-(J1-Pin_4-Pad4)"])
      .replace('(net "unconnected-(J1-Pin_4-Pad4)")', '(net "")');
    expect(modern).toContain('(net "")');
    const result = evaluateFreshDesignAcceptance(evidence(DIVIDER_ARTIFACTS, modern, 1), DIVIDER_ARTIFACTS);
    expect(row(result, "component:J1:pcb")?.status).toBe("fail");
    expect(result.passed).toBe(false);
    expect(parseFreshPcbSource(modern).footprints.find((footprint) => footprint.reference === "J1")?.pads.find((pad) => pad.number === "4")?.netName).toBeNull();
  });

  it.each([
    ["extra named reference", (source: string) => appendPcbForms(source, '(segment (start 25 15) (end 26 15) (width 0.5) (layer "F.Cu") (net "EXTRA") (uuid "extra-net"))')],
    ["undeclared numeric ID", (source: string) => source.replace('(net "VCC")', '(net 7)')],
    ["legacy pair without declaration", (source: string) => source.replace('(net "VCC")', '(net 1 "VCC")')],
    ["quoted first token with extra value", (source: string) => source.replace('(net "VCC")', '(net "1" "VCC")')],
    ["named root declaration", (source: string) => appendPcbForms(source, '(net "VCC")')],
    ["unexpected declaration table", (source: string) => appendPcbForms(source, '(net 7 "EXTRA")')],
  ] as const)("rejects malformed/conflicting modern inventory: %s", (_name, mutate) => {
    const source = mutate(withNamedNetReferences(LED_PCB, ["VCC", "LED_A", "GND"]));
    const result = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, source, 0), LED_ARTIFACTS);
    expect(result.passed).toBe(false);
    expect(result.requirements.some((entry) => entry.kind === "pcb_component" && entry.status !== "pass")).toBe(true);
  });

  it("allows name references alongside an exact legacy table but rejects a name absent from that table", () => {
    const mixed = LED_PCB.replace('(net 1 "VCC"))', '(net "VCC"))');
    expect(row(evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, mixed, 0), LED_ARTIFACTS), "component:J1:pcb")?.status).toBe("pass");
    const wrong = mixed.replace('(net "VCC"))', '(net "OTHER"))');
    expect(row(evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, wrong, 0), LED_ARTIFACTS), "component:J1:pcb")?.status).not.toBe("pass");
  });

  it("rebinds a native footprint leaf only through valid unique contract/local-library evidence", () => {
    const leafBoard = LED_PCB.replace('footprint "Resistor_SMD:R_0603_1608Metric"', 'footprint "R_0603_1608Metric"');
    expect(row(evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, leafBoard, 0), LED_ARTIFACTS), "component:R1:pcb")?.status).toBe("pass");
    for (const wrong of ["Other:R_0603_1608Metric", "R_0805_2012Metric"]) {
      const source = LED_PCB.replace('footprint "Resistor_SMD:R_0603_1608Metric"', `footprint "${wrong}"`);
      expect(row(evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, source, 0), LED_ARTIFACTS), "component:R1:pcb")?.status).toBe("fail");
    }
    const unavailable = cloneArtifacts(LED_ARTIFACTS);
    (unavailable as { libraryResolver: PcbReadOnlyLibraryResolver }).libraryResolver = { ...resolver, resolveFootprint: () => null };
    expect(row(evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, leafBoard, 0), unavailable), "component:R1:pcb")?.status).toBe("fail");
    const incomplete = cloneArtifacts(LED_ARTIFACTS);
    (incomplete.libraryBinding.footprints as unknown[]).pop();
    expect(row(evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, leafBoard, 0), incomplete), "component:R1:pcb")?.status).toBe("fail");
    const missingNativeIdentity = evidence(LED_ARTIFACTS, leafBoard, 0, { netlistSource: "" });
    expect(row(evaluateFreshDesignAcceptance(missingNativeIdentity, LED_ARTIFACTS), "component:R1:pcb")?.status).toBe("fail");
  });

  it("rejects an ambiguous leaf shared by two distinct otherwise valid full library IDs", () => {
    const draft = ledDraft();
    draft.components.find((component) => component.reference === "C1")!.footprintLibId = "OtherStock:R_0603_1608Metric";
    const alternateResolver: PcbReadOnlyLibraryResolver = {
      ...resolver,
      resolveFootprint: (id) => id === "OtherStock:R_0603_1608Metric"
        ? { ...resolver.resolveFootprint("Resistor_SMD:R_0603_1608Metric")!, libraryId: id }
        : resolver.resolveFootprint(id),
    };
    const artifacts = compile(draft, alternateResolver);
    const qualified = LED_PCB.replace('footprint "Capacitor_SMD:C_0603_1608Metric"', 'footprint "OtherStock:R_0603_1608Metric"');
    const qualifiedResult = evaluateFreshDesignAcceptance(evidence(artifacts, qualified, 0), artifacts);
    expect(row(qualifiedResult, "contract:integrity")?.status).toBe("pass");
    expect(row(qualifiedResult, "component:R1:pcb")?.status).toBe("pass");
    const ambiguous = qualified.replace('footprint "Resistor_SMD:R_0603_1608Metric"', 'footprint "R_0603_1608Metric"');
    expect(row(evaluateFreshDesignAcceptance(evidence(artifacts, ambiguous, 0), artifacts), "component:R1:pcb")?.status).toBe("fail");
  });

  it.each([[0, 0], [0.1, 0], [0, 0.1], [0.1, 0.1]] as const)("keeps the V1 outline at zero origin for shift (%s,%s)", (x, y) => {
    const shifted = LED_PCB.replace('(gr_rect (start 0 0) (end 30 20)', `(gr_rect (start ${x} ${y}) (end ${30 + x} ${20 + y})`);
    const outline = row(evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, shifted, 0), LED_ARTIFACTS), "board:outline");
    expect(outline?.status).toBe(x === 0 && y === 0 ? "pass" : "fail");
    expect(outline?.detail).toContain("origin");
  });

  it("rejects a jointly translated PCB and placement regions under the fixed zero-origin convention", () => {
    const draft = ledDraft();
    const anchors: Readonly<Record<string, readonly [number, number]>> = { J1: [2.5, 10], C1: [7, 10], R1: [13, 8], D1: [13, 12] };
    for (const constraint of draft.placementConstraints) {
      const [x, y] = anchors[constraint.reference]!;
      constraint.regionMm = { minXmm: x + 0.1, maxXmm: x + 0.1, minYmm: y + 0.1, maxYmm: y + 0.1 };
    }
    const artifacts = compile(draft);
    const moved = LED_PCB
      .replace('(gr_rect (start 0 0) (end 30 20)', '(gr_rect (start 0.1 0.1) (end 30.1 20.1)')
      .replace(/(\(footprint "[^"]+" \(layer "F\.Cu"\) \(at )([-\d.]+) ([-\d.]+) 0\)/gu, (_form, prefix: string, x: string, y: string) => `${prefix}${Number(x) + 0.1} ${Number(y) + 0.1} 0)`)
      .replace(/\(segment \(start ([-\d.]+) ([-\d.]+)\) \(end ([-\d.]+) ([-\d.]+)\)/gu, (_form, x1: string, y1: string, x2: string, y2: string) => `(segment (start ${Number(x1) + 0.1} ${Number(y1) + 0.1}) (end ${Number(x2) + 0.1} ${Number(y2) + 0.1})`);
    const result = evaluateFreshDesignAcceptance(evidence(artifacts, moved, 0), artifacts);
    expect(result.requirements.filter((entry) => entry.kind === "placement").every((entry) => entry.status === "pass")).toBe(true);
    expect(row(result, "board:outline")?.status).toBe("fail");
    expect(result.passed).toBe(false);
  });

  it.each([undefined, 0, []])("accepts clean ERC with supported absent/numeric/list violations alias %j", (violations) => {
    const metadata = { available: true, violation_count: 0, ...(violations === undefined ? {} : { violations }) };
    const result = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, LED_PCB, 0, {
      erc: { origin: "host", result: JSON.stringify({ status: "clean", verdict: "PASS", findings: [], metadata }) },
    }), LED_ARTIFACTS);
    expect(row(result, "erc")?.status).toBe("pass");
  });

  it.each([
    ["nonempty list against zero", { violation_count: 0, violations: [{ type: "pin_not_connected" }] }],
    ["nonempty list against one", { violation_count: 1, violations: [{ type: "pin_not_connected" }] }],
    ["null alias", { violation_count: 0, violations: null }],
    ["object alias", { violation_count: 0, violations: {} }],
    ["string alias", { violation_count: 0, violations: "0" }],
    ["negative alias", { violation_count: 0, violations: -1 }],
    ["fractional alias", { violation_count: 0, violations: 0.5 }],
    ["array primary count", { violation_count: [], violations: [] }],
    ["array issue count", { violation_count: 0, violations: [], issue_count: [] }],
    ["missing required primary", { violations: [] }],
    ["contradictory legacy numeric", { violation_count: 0, violations: 1 }],
  ] as const)("rejects malformed/nonclean ERC count aliases: %s", (_name, counts) => {
    const result = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, LED_PCB, 0, {
      erc: { origin: "host", result: JSON.stringify({ status: "clean", findings: [], metadata: { available: true, ...counts } }) },
    }), LED_ARTIFACTS);
    expect(row(result, "erc")?.status).not.toBe("pass");
  });

  it("does not normalize DRC arrays or waive ERC status/findings checks", () => {
    const drcArray = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, LED_PCB, 0, {
      drc: { origin: "host", result: JSON.stringify({ status: "clean", findings: [], metadata: { available: true, violations: [], unconnected_items: 0, courtyard_issues: 0 } }) },
    }), LED_ARTIFACTS);
    expect(row(drcArray, "drc")?.status).not.toBe("pass");
    for (const overrides of [{ status: "failed" }, { passed: false }, { findings: [{ severity: "error", code: "ERC_X" }] }]) {
      const result = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, LED_PCB, 0, {
        erc: { origin: "host", result: JSON.stringify({ status: "clean", findings: [], metadata: { available: true, violation_count: 0, violations: [] }, ...overrides }) },
      }), LED_ARTIFACTS);
      expect(row(result, "erc")?.status).not.toBe("pass");
    }
  });

  it("accepts attempt13 native name/leaf/clean-ERC representations while retaining its genuine design failures", () => {
    const { identity: _identity, ...contractPayload } = capturedAttempt13.contract;
    const artifacts = compile({ ...contractPayload, schemaVersion: PCB_DESIGN_INTENT_DRAFT_SCHEMA_VERSION, kind: "pcb_design_intent_draft", unresolved: [] });
    expect(artifacts.contract.identity).toEqual(capturedAttempt13.contract.identity);
    const pcbSource = Buffer.from(capturedAttempt13.pcb.utf8Base64, "base64").toString("utf8");
    expect(createHash("sha256").update(pcbSource).digest("hex")).toBe(capturedAttempt13.pcb.sha256);
    expect(Buffer.byteLength(pcbSource)).toBe(13120);
    const result = evaluateFreshDesignAcceptance(evidence(artifacts, pcbSource, 0, {
      schematicSource: Buffer.from(capturedAttempt13.schematic.utf8Base64, "base64").toString("utf8"),
      netlistSource: Buffer.from(capturedAttempt13.netlist.utf8Base64, "base64").toString("utf8"),
      erc: { origin: "host", result: capturedAttempt13.ercResult },
      drc: { origin: "host", result: capturedAttempt13.drcResult },
      visualInspection: { origin: "host", result: capturedAttempt13.visualResult },
    }), artifacts);
    expect(result.requirements.filter((entry) => entry.kind === "pcb_component").map((entry) => entry.status)).toEqual(["pass", "pass", "pass"]);
    expect(row(result, "erc")?.status).toBe("pass");
    expect(row(result, "drc")?.status).toBe("fail");
    expect(row(result, "placement:J1")?.status).toBe("fail");
    expect(row(result, "route:VOUT:turns")?.status).toBe("fail");
    expect(result.requirements.filter((entry) => entry.kind === "routed_net").every((entry) => entry.status === "fail")).toBe(true);
    expect(result.passed).toBe(false);
    expect(capturedAttempt13.nativeDrc.violations.filter((violation) => violation.type === "shorting_items")).toHaveLength(4);
    expect(capturedAttempt13.nativeDrc.violations.filter((violation) => violation.type === "solder_mask_bridge")).toHaveLength(5);
    expect(capturedAttempt13.nativeDrc.unconnected_items).toHaveLength(4);
    const parsed = parseFreshPcbSource(pcbSource);
    expect(parsed.footprints.flatMap((footprint) => footprint.pads).map((pad) => pad.netName).sort()).toEqual(["GND", "GND", "VIN", "VIN", "VOUT", "VOUT", "VOUT"]);
    expect(parsed.segments.map((segment) => segment.netName).sort()).toEqual(["GND", "GND", "VIN", "VIN", "VOUT", "VOUT", "VOUT"]);
  });


  it("accepts the current LED proof-board semantics using only regenerated host rows", () => {
    const input = evidence(LED_ARTIFACTS, LED_PCB, 0);
    const first = evaluateFreshDesignAcceptance(input, LED_ARTIFACTS);
    const second = evaluateFreshDesignAcceptance(structuredClone(input), LED_ARTIFACTS);
    expect(first, first.missing.join("\n")).toEqual(second);
    expect(first.passed, first.missing.join("\n")).toBe(true);
    expect(first.requirements.map((entry) => entry.kind)).toEqual(expect.arrayContaining([
      "contract_integrity", "library_symbol", "library_footprint", "schematic_component",
      "pin_disposition", "schematic_net", "pcb_component", "board_outline", "placement",
      "routed_net", "netclass_width", "route_turns", "route_vias", "erc", "drc", "visual_practice",
    ]));
    expect(first.requirements.every((entry) => entry.status === "pass")).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.requirements)).toBe(true);
    expect(Object.isFrozen(first.requirements[0])).toBe(true);
    expect(Object.isFrozen(first.sourceHashes)).toBe(true);
  });

  it("accepts a non-LED resistor divider and binds its explicit no-connect pin", () => {
    const result = evaluateFreshDesignAcceptance(evidence(DIVIDER_ARTIFACTS, DIVIDER_PCB, 1), DIVIDER_ARTIFACTS);
    expect(result.passed, result.missing.join("\n")).toBe(true);
    expect(row(result, "pin:J1:4:disposition")).toMatchObject({ status: "pass", kind: "pin_disposition" });
    expect(row(result, "net:VOUT:schematic")).toMatchObject({ status: "pass", kind: "schematic_net" });
    expect(row(result, "net:VOUT:routed")).toMatchObject({ status: "pass", kind: "routed_net" });
  });

  it("rejects under-width copper without treating a model-style PASS string as evidence", () => {
    const underWidth = LED_PCB.replace('(width 0.5) (layer "F.Cu") (net 1)', '(width 0.49) (layer "F.Cu") (net 1)');
    const input = evidence(LED_ARTIFACTS, underWidth, 0, {
      visualInspection: { origin: "provider", result: JSON.stringify({ status: "PASS", findings: [] }) } as never,
    });
    const result = evaluateFreshDesignAcceptance(input, LED_ARTIFACTS);
    expect(result.passed).toBe(false);
    expect(row(result, "netclass:POWER:width")?.status).toBe("fail");
    expect(row(result, "visual-practice")?.status).toBe("unknown");
  });

  it("requires separately bound configured/effective clearance evidence for every net class", () => {
    const missing = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, LED_PCB, 0, {
      clearance: undefined as never,
    }), LED_ARTIFACTS);
    expect(row(missing, "netclass:POWER:clearance")?.status).toBe("unknown");
    expect(missing.passed).toBe(false);

    const under = clearanceEvidence(LED_ARTIFACTS, LED_PCB);
    const power = under.netClasses.find((entry) => entry.id === "POWER")!;
    (power as { configuredClearanceMm: number; effectiveClearanceMm: number }).configuredClearanceMm = 0.1;
    (power as { configuredClearanceMm: number; effectiveClearanceMm: number }).effectiveClearanceMm = 0.15;
    const underResult = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, LED_PCB, 0, {
      clearance: under,
    }), LED_ARTIFACTS);
    expect(row(underResult, "netclass:POWER:clearance")?.status).toBe("fail");
    expect(row(underResult, "drc")?.status).toBe("pass");

    const mismatched = clearanceEvidence(LED_ARTIFACTS, LED_PCB);
    (mismatched.netClasses[0] as { id: string }).id = "MISMATCHED_CLASS";
    const mismatchResult = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, LED_PCB, 0, {
      clearance: mismatched,
    }), LED_ARTIFACTS);
    expect(mismatchResult.requirements.filter((entry) => entry.kind === "netclass_clearance").every((entry) => entry.status === "fail")).toBe(true);
  });

  it("rejects a routed 90-degree dogleg", () => {
    const rightAngle = LED_PCB.replace(
      '  (segment (start 14 8) (end 14 12) (width 0.25) (layer "F.Cu") (net 2) (uuid "led-a"))',
      [
        '  (segment (start 14 8) (end 16 8) (width 0.25) (layer "F.Cu") (net 2) (uuid "led-a"))',
        '  (segment (start 16 8) (end 16 12) (width 0.25) (layer "F.Cu") (net 2) (uuid "led-b"))',
        '  (segment (start 16 12) (end 14 12) (width 0.25) (layer "F.Cu") (net 2) (uuid "led-c"))',
      ].join("\n"),
    );
    const result = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, rightAngle, 0), LED_ARTIFACTS);
    expect(result.passed).toBe(false);
    expect(row(result, "route:LED_A:turns")?.status).toBe("fail");
  });

  it("rejects connected backtracking even when the required pads remain joined", () => {
    const backtrack = LED_PCB.replace(
      [
        '  (segment (start 2.5 8) (end 7 9) (width 0.5) (layer "F.Cu") (net 1) (uuid "vcc-a"))',
        '  (segment (start 7 9) (end 12 8) (width 0.5) (layer "F.Cu") (net 1) (uuid "vcc-b"))',
      ].join("\n"),
      [
        '  (segment (start 2.5 8) (end 7 9) (width 0.5) (layer "F.Cu") (net 1) (uuid "vcc-a"))',
        '  (segment (start 7 9) (end 6 9) (width 0.5) (layer "F.Cu") (net 1) (uuid "vcc-back"))',
        '  (segment (start 6 9) (end 12 8) (width 0.5) (layer "F.Cu") (net 1) (uuid "vcc-b"))',
      ].join("\n"),
    );
    const result = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, backtrack, 0), LED_ARTIFACTS);
    expect(result.passed).toBe(false);
    expect(row(result, "route:VCC:turns")?.status).toBe("fail");
  });

  it("rejects forbidden vias and bounded vias below the declared geometry", () => {
    const forbidden = LED_PCB.replace(/\)\s*$/u, '  (via (at 7 9) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "via-forbidden"))\n)\n');
    const forbiddenResult = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, forbidden, 0), LED_ARTIFACTS);
    expect(row(forbiddenResult, "route:VCC:vias")?.status).toBe("fail");

    const undersized = DIVIDER_PCB.replace(/\)\s*$/u, '  (via (at 8 9) (size 0.5) (drill 0.3) (layers "F.Cu" "B.Cu") (net 2) (uuid "via-small"))\n)\n');
    const undersizedResult = evaluateFreshDesignAcceptance(evidence(DIVIDER_ARTIFACTS, undersized, 1), DIVIDER_ARTIFACTS);
    expect(row(undersizedResult, "route:VOUT:vias")?.status).toBe("fail");
  });

  it("rejects a footprint outside its placement region and allowed rotation", () => {
    const misplaced = LED_PCB.replace(
      '(footprint "Resistor_SMD:R_0603_1608Metric" (layer "F.Cu") (at 13 8 0)',
      '(footprint "Resistor_SMD:R_0603_1608Metric" (layer "F.Cu") (at 31 8 45)',
    );
    const result = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, misplaced, 0), LED_ARTIFACTS);
    expect(result.passed).toBe(false);
    expect(row(result, "placement:R1")?.status).toBe("fail");
  });

  it("keeps native ERC and DRC mandatory and binds no-connect acceptance to ERC", () => {
    const input = evidence(DIVIDER_ARTIFACTS, DIVIDER_PCB, 1, {
      erc: { origin: "host", result: "not-json" },
      drc: { origin: "host", result: JSON.stringify({ status: "clean", metadata: { available: true, violations: 0 } }) },
    });
    const result = evaluateFreshDesignAcceptance(input, DIVIDER_ARTIFACTS);
    expect(result.passed).toBe(false);
    expect(row(result, "erc")?.status).toBe("unknown");
    expect(row(result, "drc")?.status).toBe("unknown");
    expect(row(result, "pin:J1:4:disposition")?.status).toBe("unknown");
  });

  it("rejects contradictory native statuses, counts, findings, and invalid finding severities", () => {
    const contradictoryErc = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, LED_PCB, 0, {
      erc: {
        origin: "host",
        result: JSON.stringify({
          status: "clean",
          findings: [{ severity: "error", code: "ERC_X" }],
          metadata: { available: true, violation_count: 0 },
        }),
      },
    }), LED_ARTIFACTS);
    expect(row(contradictoryErc, "erc")?.status).toBe("fail");

    const contradictoryDrc = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, LED_PCB, 0, {
      drc: {
        origin: "host",
        result: JSON.stringify({
          status: "clean",
          findings: [],
          metadata: { available: true, violations: 0, violation_count: 1, unconnected_items: 0, courtyard_issues: 0 },
        }),
      },
    }), LED_ARTIFACTS);
    expect(row(contradictoryDrc, "drc")?.status).toBe("fail");

    const invalidSeverity = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, LED_PCB, 0, {
      erc: {
        origin: "host",
        result: JSON.stringify({
          status: "clean",
          findings: [{ severity: "catastrophic", code: "ERC_X" }],
          metadata: { available: true, violation_count: 1 },
        }),
      },
    }), LED_ARTIFACTS);
    expect(row(invalidSeverity, "erc")?.status).toBe("unknown");
    expect(invalidSeverity.passed).toBe(false);

    const malformedPassedValues: readonly ["erc" | "drc", unknown][] = [
      ["erc", {
        status: "clean", passed: "false", findings: [],
        metadata: { available: true, violation_count: 0 },
      }],
      ["drc", {
        status: "clean", passed: 1, findings: [],
        metadata: { available: true, violations: 0, unconnected_items: 0, courtyard_issues: 0 },
      }],
    ];
    for (const [kind, payload] of malformedPassedValues) {
      const result = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, LED_PCB, 0, {
        [kind]: { origin: "host", result: JSON.stringify(payload) },
      }), LED_ARTIFACTS);
      expect(row(result, kind)?.status).toBe("unknown");
      expect(result.passed).toBe(false);
    }
  });

  it("strictly rejects contradictory visual status, passed flags, issues, and counts", () => {
    const cases: readonly unknown[] = [
      { status: "PASS", passed: false, findings: [] },
      { status: "PASS", findings: [], issues: [{ severity: "warning", code: "VISIBLE_X" }] },
      { status: "PASS", findings: [], issues: [], finding_count: 1 },
      { status: "PASS", findings: [{ severity: "error", code: "VISIBLE_X" }], issues: [], finding_count: 0 },
    ];
    for (const visual of cases) {
      const result = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, LED_PCB, 0, {
        visualInspection: { origin: "host", result: JSON.stringify(visual) },
      }), LED_ARTIFACTS);
      expect(result.passed).toBe(false);
      expect(row(result, "visual-practice")?.status).not.toBe("pass");
    }
  });

  it("regenerates policy and rejects a tampered supplied acceptance plan", () => {
    const tampered = cloneArtifacts(LED_ARTIFACTS);
    (tampered.acceptancePlan.rows as unknown as Array<{ description: string }>)[0]!.description = "provider says pass";
    const result = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, LED_PCB, 0), tampered);
    expect(result.passed).toBe(false);
    expect(row(result, "contract:integrity")?.status).toBe("fail");
    expect(result.requirements.map((entry) => entry.id)).toEqual(LED_ARTIFACTS.acceptancePlan.rows.map((entry) => entry.id));
    expect(result.requirements.some((entry) => entry.detail.includes("provider says pass"))).toBe(false);
  });

  it("uses a supplied bundle practice profile only when it exactly reproduces from the contract", () => {
    const exact = {
      ...LED_ARTIFACTS,
      practiceProfile: createFreshDesignPracticeProfile(LED_ARTIFACTS.contract),
    };
    expect(evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, LED_PCB, 0), exact).passed).toBe(true);
    const tamperedProfile = structuredClone(exact.practiceProfile) as unknown as Record<string, unknown>;
    tamperedProfile.providerOverride = "relax bends";
    const rejected = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, LED_PCB, 0), {
      ...exact,
      practiceProfile: tamperedProfile as never,
    });
    expect(rejected.passed).toBe(false);
    expect(row(rejected, "contract:integrity")?.status).toBe("fail");
    expect(row(rejected, "contract:integrity")?.detail).toContain("practice-profile=false");
  });

  it("rejects library and deep-rule binding tampering, including a rehashed truncated binding and plan", () => {
    const libraryTampered = cloneArtifacts(LED_ARTIFACTS);
    (libraryTampered.libraryBinding.symbols[0] as unknown as { libraryId: string }).libraryId = "Device:Wrong";
    reidentify(libraryTampered.libraryBinding, PCB_LIBRARY_BINDING_SCHEMA_VERSION);
    (libraryTampered as unknown as { acceptancePlan: FreshDesignAcceptanceArtifacts["acceptancePlan"] }).acceptancePlan = createPcbAcceptancePlan(
      libraryTampered.contract,
      libraryTampered.libraryBinding,
      libraryTampered.deepRuleBinding,
    );
    const libraryResult = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, LED_PCB, 0), libraryTampered);
    expect(row(libraryResult, "contract:integrity")?.status).toBe("fail");
    expect(libraryResult.requirements.some((entry) => entry.kind === "library_symbol" && entry.status === "fail")).toBe(true);

    const extraField = cloneArtifacts(LED_ARTIFACTS);
    (extraField.libraryBinding as unknown as Record<string, unknown>).unexpected = "rehashed-extra";
    reidentify(extraField.libraryBinding, PCB_LIBRARY_BINDING_SCHEMA_VERSION);
    (extraField as unknown as { acceptancePlan: FreshDesignAcceptanceArtifacts["acceptancePlan"] }).acceptancePlan = createPcbAcceptancePlan(
      extraField.contract,
      extraField.libraryBinding,
      extraField.deepRuleBinding,
    );
    const extraResult = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, LED_PCB, 0), extraField);
    expect(row(extraResult, "contract:integrity")?.status).toBe("fail");

    const permuted = cloneArtifacts(LED_ARTIFACTS);
    (permuted.libraryBinding.symbols as unknown as Array<unknown>).reverse();
    reidentify(permuted.libraryBinding, PCB_LIBRARY_BINDING_SCHEMA_VERSION);
    (permuted as unknown as { acceptancePlan: FreshDesignAcceptanceArtifacts["acceptancePlan"] }).acceptancePlan = createPcbAcceptancePlan(
      permuted.contract,
      permuted.libraryBinding,
      permuted.deepRuleBinding,
    );
    const permutationResult = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, LED_PCB, 0), permuted);
    expect(row(permutationResult, "contract:integrity")?.status).toBe("fail");

    const deepTampered = cloneArtifacts(LED_ARTIFACTS);
    const selection = deepTampered.deepRuleBinding.selection as unknown as Record<string, unknown>;
    delete selection.rules;
    reidentify(deepTampered.deepRuleBinding, PCB_DEEP_RULE_BINDING_SCHEMA_VERSION);
    (deepTampered as unknown as { acceptancePlan: FreshDesignAcceptanceArtifacts["acceptancePlan"] }).acceptancePlan = createPcbAcceptancePlan(
      deepTampered.contract,
      deepTampered.libraryBinding,
      deepTampered.deepRuleBinding,
    );
    const deepResult = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, LED_PCB, 0), deepTampered);
    expect(row(deepResult, "contract:integrity")?.status).toBe("fail");
    expect(deepResult.passed).toBe(false);
  });

  it("rejects runtime token counters, extra selector keys, and accessors without invoking them", () => {
    const tokenCounter = cloneArtifacts(LED_ARTIFACTS);
    (tokenCounter as unknown as { deepRuleSelectionOptions: unknown }).deepRuleSelectionOptions = {
      tokenCounter: () => 1,
    };
    const tokenResult = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, LED_PCB, 0), tokenCounter);
    expect(row(tokenResult, "contract:integrity")?.status).toBe("fail");

    const extra = cloneArtifacts(LED_ARTIFACTS);
    (extra as unknown as { deepRuleSelectionOptions: unknown }).deepRuleSelectionOptions = {
      maxRules: 24,
      unexpected: true,
    };
    const extraResult = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, LED_PCB, 0), extra);
    expect(row(extraResult, "contract:integrity")?.status).toBe("fail");

    let getterInvoked = false;
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "maxRules", {
      enumerable: true,
      get: () => {
        getterInvoked = true;
        return 24;
      },
    });
    const getter = cloneArtifacts(LED_ARTIFACTS);
    (getter as unknown as { deepRuleSelectionOptions: unknown }).deepRuleSelectionOptions = accessor;
    const getterResult = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, LED_PCB, 0), getter);
    expect(row(getterResult, "contract:integrity")?.status).toBe("fail");
    expect(getterInvoked).toBe(false);
  });

  it("reuses compiler resolver-value validation before accepting rehashed library artifacts", () => {
    const baseSymbol = resolver.resolveSymbol("Device:R")!;
    const baseFootprint = resolver.resolveFootprint("Resistor_SMD:R_0603_1608Metric")!;
    const malformedSymbols: readonly unknown[] = [
      { ...baseSymbol, componentKind: "mystery" },
      { ...baseSymbol, polarized: "false" },
      { ...baseSymbol, pins: [{ number: "1", function: 7 }, baseSymbol.pins[1]] },
      { ...baseSymbol, pins: [{ number: "1", function: "x".repeat(PCB_LIBRARY_RESOLVER_OUTPUT_LIMITS.maxPinFunctionChars + 1) }, baseSymbol.pins[1]] },
    ];
    for (const malformed of malformedSymbols) {
      const artifacts = cloneArtifacts(LED_ARTIFACTS);
      (artifacts as unknown as { libraryResolver: PcbReadOnlyLibraryResolver }).libraryResolver = {
        ...resolver,
        resolveSymbol: (libraryId) => libraryId === "Device:R"
          ? malformed as PcbResolvedSymbol
          : resolver.resolveSymbol(libraryId),
      };
      const result = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, LED_PCB, 0), artifacts);
      expect(row(result, "contract:integrity")?.status).toBe("fail");
    }

    const malformedFootprint = cloneArtifacts(LED_ARTIFACTS);
    (malformedFootprint as unknown as { libraryResolver: PcbReadOnlyLibraryResolver }).libraryResolver = {
      ...resolver,
      resolveFootprint: (libraryId) => libraryId === "Resistor_SMD:R_0603_1608Metric"
        ? { ...baseFootprint, pads: ["1", "bad pad"] } as PcbResolvedFootprint
        : resolver.resolveFootprint(libraryId),
    };
    const footprintResult = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, LED_PCB, 0), malformedFootprint);
    expect(row(footprintResult, "contract:integrity")?.status).toBe("fail");

    const rehashed = cloneArtifacts(LED_ARTIFACTS);
    const r1 = rehashed.libraryBinding.symbols.find((entry) => entry.reference === "R1")!;
    (r1 as unknown as { componentKind: string }).componentKind = "mystery";
    reidentify(rehashed.libraryBinding, PCB_LIBRARY_BINDING_SCHEMA_VERSION);
    (rehashed as unknown as { acceptancePlan: FreshDesignAcceptanceArtifacts["acceptancePlan"] }).acceptancePlan = createPcbAcceptancePlan(
      rehashed.contract,
      rehashed.libraryBinding,
      rehashed.deepRuleBinding,
    );
    const rehashedResult = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, LED_PCB, 0), rehashed);
    expect(row(rehashedResult, "contract:integrity")?.status).toBe("fail");
  });

  it.each([
    ["local-for-global", (source: string) => source.replace('(global_label "GND" (shape passive)', '(label "GND"')],
    ["wrong shape", (source: string) => source.replace('(global_label "GND" (shape passive)', '(global_label "GND" (shape input)')],
    ["duplicate label", (source: string) => source.replace('(version 20250316)', '(version 20250316) (global_label "GND" (shape passive) (at 0 0 0))')],
    ["extra hierarchical label", (source: string) => source.replace('(version 20250316)', '(version 20250316) (hierarchical_label "EXTRA" (shape input) (at 0 0 0))')],
  ] as const)("rejects %s despite exact native net names and endpoints", (_name, mutate) => {
    const result = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, LED_PCB, 0, {
      schematicSource: mutate(schematicSource(LED_ARTIFACTS)),
    }), LED_ARTIFACTS);
    expect(row(result, "net:GND:schematic")?.status).toBe("fail");
    expect(row(result, "pin:D1:1:disposition")?.status).toBe("fail");
  });

  it("rejects actual root child sheets despite exact root symbol and native net inventories", () => {
    const result = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, LED_PCB, 0, {
      schematicSource: schematicSource(LED_ARTIFACTS).replace('(version 20250316)', '(version 20250316) (sheet (property "Sheetfile" "child.kicad_sch"))'),
    }), LED_ARTIFACTS);
    expect(row(result, "component:D1:schematic")).toMatchObject({ status: "fail", detail: expect.stringContaining("single-sheet") });
    expect(row(result, "net:GND:schematic")?.status).toBe("fail");
  });

  it("retains exact native bare-name comparisons", () => {
    const result = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, LED_PCB, 0, {
      netlistSource: netlistSource(LED_ARTIFACTS).replace('(name "GND")', '(name "/GND")'),
    }), LED_ARTIFACTS);
    expect(row(result, "net:GND:schematic")?.status).toBe("fail");
  });

  it.each([
    ["Netclass", '(global_label "GND" (property "Netclass" "OtherClass" (at 0 0 0))'],
    ["private Netclass", '(global_label "GND" (property private "Netclass" "OtherClass" (at 0 0 0))'],
    ["Net Class compatibility field", '(global_label "GND" (property "Net Class" "OtherClass" (at 0 0 0))'],
    ["unsupported locale-dependent field", '(global_label "GND" (property "Netzklasse" "OtherClass" (at 0 0 0))'],
  ] as const)("rejects %s with exact native net/pad evidence and unchanged project rules", (_name, replacement) => {
    const result = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, LED_PCB, 0, {
      schematicSource: schematicSource(LED_ARTIFACTS).replace('(global_label "GND"', replacement),
    }), LED_ARTIFACTS);
    expect(row(result, "component:D1:schematic")).toMatchObject({ status: "fail", detail: expect.stringContaining("authored-pattern") });
    expect(row(result, "net:GND:schematic")?.status).toBe("fail");
    expect(row(result, "pin:D1:1:disposition")?.status).toBe("fail");
  });

  it.each([
    '(directive_label "" (at 0 0 0) (length 2.54) (shape dot) (property "Netclass" "OtherClass"))',
    '(netclass_flag "" (at 0 0 0) (length 2.54) (shape dot) (property private "Netclass" "OtherClass"))',
    '(rule_area (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (polyline (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 0)) (stroke (width 0.15) (type default)) (fill (type none))))',
  ])("rejects the exact native schematic class-source form %s", (form) => {
    const result = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, LED_PCB, 0, {
      schematicSource: schematicSource(LED_ARTIFACTS).replace('(version 20250316)', `(version 20250316) ${form}`),
    }), LED_ARTIFACTS);
    expect(row(result, "component:D1:schematic")?.status).toBe("fail");
    expect(row(result, "net:GND:schematic")?.status).toBe("fail");
  });

  it("accepts native intersheet metadata and ordinary drawings without treating them as class overrides", () => {
    const result = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, LED_PCB, 0, {
      schematicSource: schematicSource(LED_ARTIFACTS).replace('(global_label "GND"', '(global_label "GND" (property private "intersheetrefs" "${INTERSHEET_REFS}" (at 0 0 0)) (fields_autoplaced yes) (effects (font (size 1.27 1.27)))').replace('(version 20250316)', '(version 20250316) (rectangle (start 0 0) (end 10 10)) (polyline (pts (xy 0 0) (xy 10 0)))'),
    }), LED_ARTIFACTS);
    expect(row(result, "component:D1:schematic")?.status).toBe("pass");
    expect(row(result, "net:GND:schematic")?.status).toBe("pass");
  });

  it("rejects exact schematic and native-netlist library/value mutations", () => {
    const schematicLibrary = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, LED_PCB, 0, {
      schematicSource: schematicSource(LED_ARTIFACTS, 0).replace("Device:LED", "Device:Wrong"),
    }), LED_ARTIFACTS);
    expect(row(schematicLibrary, "component:D1:schematic")?.status).toBe("fail");

    const schematicValue = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, LED_PCB, 0, {
      schematicSource: schematicSource(LED_ARTIFACTS, 0).replace('"GREEN"', '"RED"'),
    }), LED_ARTIFACTS);
    expect(row(schematicValue, "component:D1:schematic")?.status).toBe("fail");

    const netlistIdentity = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, LED_PCB, 0, {
      netlistSource: netlistSource(LED_ARTIFACTS).replace('(value "GREEN")', '(value "RED")'),
    }), LED_ARTIFACTS);
    expect(row(netlistIdentity, "pin:D1:1:disposition")?.status).toBe("fail");
    expect(row(netlistIdentity, "net:GND:schematic")?.status).toBe("fail");
  });

  it("rejects exact PCB footprint library, value, pad-number, and pad-net mutations", () => {
    const mutations: readonly [string, string][] = [
      ["library", LED_PCB.replace("LED_SMD:LED_0603_1608Metric", "LED_SMD:LED_0805_2012Metric")],
      ["value", LED_PCB.replace('(property "Reference" "D1") (property "Value" "GREEN")', '(property "Reference" "D1") (property "Value" "RED")')],
      ["pad", LED_PCB.replace('(pad "2" smd rect (at 1 0)', '(pad "9" smd rect (at 1 0)')],
      ["net", LED_PCB.replace('(pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu") (net 1 "VCC"))', '(pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu") (net 3 "GND"))')],
    ];
    for (const [name, pcbSource] of mutations) {
      const result = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, pcbSource, 0), LED_ARTIFACTS);
      expect(result.requirements.some((entry) => entry.kind === "pcb_component" && entry.status === "fail"), name).toBe(true);
      expect(result.passed, name).toBe(false);
    }
  });

  it("rejects an unused extra named PCB net declaration", () => {
    const extraNet = appendPcbForms(LED_PCB, '  (net 99 "EXTRA_UNUSED")');
    const result = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, extraNet, 0), LED_ARTIFACTS);
    expect(result.passed).toBe(false);
    expect(result.requirements.filter((entry) => entry.kind === "pcb_component").every((entry) => entry.status === "fail")).toBe(true);
    expect(result.requirements.filter((entry) => entry.kind === "routed_net").every((entry) => entry.status === "fail")).toBe(true);

    const mismatchedId = LED_PCB.replace('(net 1 "VCC"))', '(net 99 "VCC"))');
    const idResult = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, mismatchedId, 0), LED_ARTIFACTS);
    expect(idResult.passed).toBe(false);
    expect(idResult.requirements.some((entry) => entry.kind === "pcb_component" && entry.status !== "pass")).toBe(true);

    for (const malformed of [
      LED_PCB.replace('(net 1 "VCC"))', '(net 0 "VCC"))'),
      appendPcbForms(LED_PCB, '  (net 1 "CONFLICTING_ID")'),
      appendPcbForms(LED_PCB, '  (net 99 "VCC")'),
    ]) {
      const malformedResult = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, malformed, 0), LED_ARTIFACTS);
      expect(malformedResult.passed).toBe(false);
      expect(malformedResult.requirements.some((entry) => entry.kind === "pcb_component" && entry.status !== "pass")).toBe(true);
    }
  });

  it("rejects native net membership and no-connect pin-type mutations", () => {
    const wrongMembership = netlistSource(LED_ARTIFACTS)
      .replace('(name "GND")', '(name "BAD_GND")');
    const wrongNet = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, LED_PCB, 0, {
      netlistSource: wrongMembership,
    }), LED_ARTIFACTS);
    expect(wrongNet.requirements.some((entry) => entry.kind === "schematic_net" && entry.status === "fail")).toBe(true);

    const connectedMarkedNoConnect = netlistSource(LED_ARTIFACTS).replace(
      '(node (ref "J1") (pin "2") (pintype "passive"))',
      '(node (ref "J1") (pin "2") (pintype "passive+no_connect"))',
    );
    const connectedPinType = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, LED_PCB, 0, {
      netlistSource: connectedMarkedNoConnect,
    }), LED_ARTIFACTS);
    expect(row(connectedPinType, "pin:J1:2:disposition")?.status).toBe("fail");

    const wrongNoConnectType = netlistSource(DIVIDER_ARTIFACTS).replace("passive+no_connect", "passive");
    const noConnect = evaluateFreshDesignAcceptance(evidence(DIVIDER_ARTIFACTS, DIVIDER_PCB, 1, {
      netlistSource: wrongNoConnectType,
    }), DIVIDER_ARTIFACTS);
    expect(row(noConnect, "pin:J1:4:disposition")?.status).toBe("fail");
  });

  it("rejects duplicate/overlapping and adjacent-hairpin copper", () => {
    const overlap = appendPcbForms(
      LED_PCB,
      '  (segment (start 2.5 8) (end 7 9) (width 0.5) (layer "F.Cu") (net 1) (uuid "vcc-duplicate"))',
    );
    const overlapResult = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, overlap, 0), LED_ARTIFACTS);
    expect(row(overlapResult, "net:VCC:routed")?.status).toBe("fail");
    expect(row(overlapResult, "route:VCC:turns")?.status).toBe("fail");

    const hairpin = LED_PCB.replace(
      '  (segment (start 14 8) (end 14 12) (width 0.25) (layer "F.Cu") (net 2) (uuid "led-a"))',
      [
        '  (segment (start 14 8) (end 14 10) (width 0.25) (layer "F.Cu") (net 2) (uuid "hp-a"))',
        '  (segment (start 14 10) (end 14.4 10) (width 0.25) (layer "F.Cu") (net 2) (uuid "hp-b"))',
        '  (segment (start 14.4 10) (end 14.4 8) (width 0.25) (layer "F.Cu") (net 2) (uuid "hp-c"))',
        '  (segment (start 14 10) (end 14 12) (width 0.25) (layer "F.Cu") (net 2) (uuid "hp-d"))',
      ].join("\n"),
    );
    const hairpinResult = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, hairpin, 0), LED_ARTIFACTS);
    expect(row(hairpinResult, "route:LED_A:turns")?.status).toBe("fail");
  });

  it("rejects a same-layer self-intersection whose individual bends are only 45 degrees", () => {
    const crossed = LED_PCB.replace(
      '  (segment (start 14 8) (end 14 12) (width 0.25) (layer "F.Cu") (net 2) (uuid "led-a"))',
      [
        '  (segment (start 14 8) (end 18 12) (width 0.25) (layer "F.Cu") (net 2) (uuid "cross-a"))',
        '  (segment (start 18 12) (end 18 8) (width 0.25) (layer "F.Cu") (net 2) (uuid "cross-b"))',
        '  (segment (start 18 8) (end 14 12) (width 0.25) (layer "F.Cu") (net 2) (uuid "cross-c"))',
      ].join("\n"),
    );
    const result = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, crossed, 0), LED_ARTIFACTS);
    expect(row(result, "route:LED_A:turns")?.status).toBe("fail");
  });

  it("enforces acyclic simple-path and tree topology instead of mere reachability", () => {
    const pointCycle = LED_PCB.replace(
      '  (segment (start 14 8) (end 14 12) (width 0.25) (layer "F.Cu") (net 2) (uuid "led-a"))',
      [
        '  (segment (start 14 8) (end 16 10) (width 0.25) (layer "F.Cu") (net 2) (uuid "cycle-a"))',
        '  (segment (start 16 10) (end 14 12) (width 0.25) (layer "F.Cu") (net 2) (uuid "cycle-b"))',
        '  (segment (start 14 8) (end 12 10) (width 0.25) (layer "F.Cu") (net 2) (uuid "cycle-c"))',
        '  (segment (start 12 10) (end 14 12) (width 0.25) (layer "F.Cu") (net 2) (uuid "cycle-d"))',
      ].join("\n"),
    );
    const pointResult = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, pointCycle, 0), LED_ARTIFACTS);
    expect(row(pointResult, "net:LED_A:routed")?.status).toBe("fail");

    const treeCycle = appendPcbForms(
      LED_PCB,
      '  (segment (start 2.5 8) (end 4.75 10) (width 0.5) (layer "F.Cu") (net 1) (uuid "tree-loop-a"))',
      '  (segment (start 4.75 10) (end 7 9) (width 0.5) (layer "F.Cu") (net 1) (uuid "tree-loop-b"))',
    );
    const treeResult = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, treeCycle, 0), LED_ARTIFACTS);
    expect(row(treeResult, "net:VCC:routed")?.status).toBe("fail");
  });

  it("enforces allowed layers and bounded route length", () => {
    const wrongLayer = LED_PCB.replace(
      '(start 14 8) (end 14 12) (width 0.25) (layer "F.Cu") (net 2)',
      '(start 14 8) (end 14 12) (width 0.25) (layer "B.Cu") (net 2)',
    );
    const layerResult = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, wrongLayer, 0), LED_ARTIFACTS);
    expect(row(layerResult, "net:LED_A:routed")?.status).toBe("fail");

    const boundedDraft = structuredClone(ledDraft());
    (boundedDraft.routingConstraints.nets.find((entry) => entry.net === "LED_A") as unknown as {
      routeLength: { mode: "bounded"; maximumMm: number };
    }).routeLength = { mode: "bounded", maximumMm: 3 };
    const boundedArtifacts = compile(boundedDraft);
    const lengthResult = evaluateFreshDesignAcceptance(evidence(boundedArtifacts, LED_PCB, 0), boundedArtifacts);
    expect(row(lengthResult, "net:LED_A:routed")?.status).toBe("fail");
  });

  it("fails closed when zone copper is present without a V1 zone contract and verified coverage", () => {
    const zoned = appendPcbForms(
      LED_PCB,
      '  (zone (net 3) (net_name "GND") (layer "F.Cu") (hatch edge 0.5) (polygon (pts (xy 1 1) (xy 29 1) (xy 29 19) (xy 1 19))))',
    );
    const result = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, zoned, 0), LED_ARTIFACTS);
    expect(result.passed).toBe(false);
    expect(result.requirements.filter((entry) => entry.kind === "routed_net").every((entry) => entry.status === "fail")).toBe(true);
    expect(row(result, "visual-practice")?.status).toBe("fail");
  });

  it("uses a fixed host-supported KiCad format set and rejects candidate-selected versions", () => {
    const unsupported = LED_PCB.replace("(version 20250316)", "(version 19990101)");
    const result = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, unsupported, 0), LED_ARTIFACTS);
    expect(result.passed).toBe(false);
    expect(row(result, "board:outline")?.status).toBe("unknown");
    expect(row(result, "route:LED_A:turns")?.status).toBe("unknown");
  });

  it("keeps closed V1 front-only and classifies a requested back-side placement as unsupported", () => {
    const backDraft = structuredClone(ledDraft());
    backDraft.placementConstraints.find((entry) => entry.reference === "R1")!.side = "back";
    const result = compilePcbDesignIntentDraft(backDraft, { libraryResolver: resolver, deepRuleCatalog: catalog });
    expect(result.disposition).toBe("unsupported");
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "UNSUPPORTED_V1_FEATURE",
      path: "placement.R1.side",
    }));
  });

  it("fails closed above bounded routing evidence limits", () => {
    const repeated = Array.from(
      { length: FRESH_DESIGN_ACCEPTANCE_LIMITS.maximumParsedSegments + 1 },
      (_entry, index) => `  (segment (start 20 ${1 + index / 1000}) (end 21 ${1 + index / 1000}) (width 0.25) (layer "F.Cu") (net 2) (uuid "bound-${index}"))`,
    );
    const oversized = appendPcbForms(LED_PCB, ...repeated);
    const result = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, oversized, 0), LED_ARTIFACTS);
    expect(result.passed).toBe(false);
    expect(row(result, "route:LED_A:turns")?.status).toBe("unknown");
    expect(row(result, "net:LED_A:routed")?.status).toBe("unknown");
  });

  it("recursively freezes every returned collection and nested identity", () => {
    const result = evaluateFreshDesignAcceptance(evidence(LED_ARTIFACTS, LED_PCB, 0), LED_ARTIFACTS);
    expect(recursivelyFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.missing)).toBe(true);
    expect(Object.isFrozen(result.evidenceLimitations)).toBe(true);
    expect(Object.isFrozen(result.contractIdentity)).toBe(true);
    expect(Object.isFrozen(result.acceptancePlanIdentity)).toBe(true);
  });

  it("rejects a missing no-connect marker even though the pin is absent from the netlist", () => {
    const result = evaluateFreshDesignAcceptance(evidence(DIVIDER_ARTIFACTS, DIVIDER_PCB, 0), DIVIDER_ARTIFACTS);
    expect(result.passed).toBe(false);
    expect(row(result, "pin:J1:4:disposition")?.status).toBe("fail");
  });
});
