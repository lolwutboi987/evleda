import { describe, expect, it } from "vitest";

import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import {
  PCB_ACCEPTANCE_PLAN_SCHEMA_VERSION,
  PCB_DEEP_RULE_BINDING_SCHEMA_VERSION,
  PCB_DESIGN_COMPILER_INPUT_LIMITS,
  PCB_DESIGN_COMPILATION_LIMITS,
  PCB_DESIGN_COMPILATION_SCHEMA_VERSION,
  PCB_LIBRARY_RESOLVER_OUTPUT_LIMITS,
  PCB_LIBRARY_BINDING_SCHEMA_VERSION,
  compilePcbDesignIntentDraft,
  deriveDeepRuleFeaturesFromContract,
  normalizePcbResolvedFootprint,
  normalizePcbResolvedSymbol,
  type PcbReadOnlyLibraryResolver,
  type PcbResolvedFootprint,
  type PcbResolvedSymbol
} from "../../src/harness/pcb-design-compiler.js";
import { PCB_DESIGN_INTENT_DRAFT_SCHEMA_VERSION } from "../../src/harness/pcb-design-contract.js";

const catalog = loadDeepRuleCatalog();

const dcElectrical = (voltage: number, current = 0.1) => ({
  voltage: { minimumV: voltage, nominalV: voltage, maximumV: voltage },
  current: {
    nominalA: current,
    maximumContinuousA: current,
    peakA: current,
    peakDurationMs: 1_000
  },
  speed: { kind: "dc", maximumFrequencyMHz: 0, minimumEdgeTimeNs: null }
});

const placement = (
  reference: string,
  edgePreference: "none" | "top" | "right" | "bottom" | "left" = "none",
  exactRotation = false
) => ({
  reference,
  side: "front",
  regionMm: { minXmm: 1, maxXmm: 29, minYmm: 1, maxYmm: 19 },
  allowedRotationsDeg: exactRotation ? [0] : [0, 90, 180, 270],
  minimumEdgeClearanceMm: 1,
  minimumCourtyardClearanceMm: 0.25,
  edgePreference
});

const route = (net: string, topology: "point_to_point" | "tree" = "point_to_point") => ({
  net,
  topology,
  preferredLayer: "F.Cu",
  maxVias: 0,
  routeLength: { mode: "unbounded" }
});

const ledDraft = () => ({
  schemaVersion: PCB_DESIGN_INTENT_DRAFT_SCHEMA_VERSION,
  kind: "pcb_design_intent_draft",
  scope: {
    sheetCount: 1,
    componentUnitPolicy: "single_unit",
    board: { shape: "rectangle", widthMm: 30, heightMm: 20, layerCount: 2, copperLayers: ["F.Cu", "B.Cu"] }
  },
  components: [
    {
      reference: "J1",
      symbolLibId: "Connector_Generic:Conn_01x02",
      value: "POWER_IN",
      footprintLibId: "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical",
      unit: 1,
      pins: [
        { pin: "1", assignment: { kind: "net", net: "VCC" } },
        { pin: "2", assignment: { kind: "net", net: "GND" } }
      ]
    },
    {
      reference: "R1",
      symbolLibId: "Device:R",
      value: "1k",
      footprintLibId: "Resistor_SMD:R_0603_1608Metric",
      unit: 1,
      pins: [
        { pin: "1", assignment: { kind: "net", net: "VCC" } },
        { pin: "2", assignment: { kind: "net", net: "LED_A" } }
      ]
    },
    {
      reference: "D1",
      symbolLibId: "Device:LED",
      value: "GREEN",
      footprintLibId: "LED_SMD:LED_0603_1608Metric",
      unit: 1,
      pins: [
        { pin: "1", assignment: { kind: "net", net: "GND" } },
        { pin: "2", assignment: { kind: "net", net: "LED_A" } }
      ]
    },
    {
      reference: "C1",
      symbolLibId: "Device:C",
      value: "100nF",
      footprintLibId: "Capacitor_SMD:C_0603_1608Metric",
      unit: 1,
      pins: [
        { pin: "1", assignment: { kind: "net", net: "VCC" } },
        { pin: "2", assignment: { kind: "net", net: "GND" } }
      ]
    }
  ],
  nets: [
    {
      name: "VCC",
      role: "power_input",
      endpoints: [
        { reference: "J1", pin: "1" },
        { reference: "R1", pin: "1" },
        { reference: "C1", pin: "1" }
      ],
      electrical: dcElectrical(5, 0.1),
      netClassId: "POWER"
    },
    {
      name: "LED_A",
      role: "passive",
      endpoints: [{ reference: "R1", pin: "2" }, { reference: "D1", pin: "2" }],
      electrical: dcElectrical(2, 0.01),
      netClassId: "SIGNAL"
    },
    {
      name: "GND",
      role: "ground",
      endpoints: [
        { reference: "J1", pin: "2" },
        { reference: "D1", pin: "1" },
        { reference: "C1", pin: "2" }
      ],
      electrical: dcElectrical(0, 0.1),
      netClassId: "POWER"
    }
  ],
  netClasses: [
    { id: "POWER", traceWidthMm: 0.5, clearanceMm: 0.25, copperToEdgeMm: 0.3, allowedLayers: ["F.Cu"] },
    { id: "SIGNAL", traceWidthMm: 0.25, clearanceMm: 0.2, copperToEdgeMm: 0.3, allowedLayers: ["F.Cu"] }
  ],
  placementConstraints: [
    placement("J1", "left", true),
    placement("R1"),
    placement("D1"),
    placement("C1")
  ],
  routingConstraints: {
    cornerStyle: "miter_45",
    maximumTurnAngleDeg: 45,
    minimumStraightBeforeTurnMm: 0.25,
    allowRightAngleCorners: false,
    allowAcuteInteriorCorners: false,
    allowBacktracking: false,
    allowSelfIntersections: false,
    viaPolicy: { mode: "forbidden", maxTotal: 0 },
    nets: [route("VCC", "tree"), route("LED_A"), route("GND", "tree")]
  },
  unresolved: []
});

const dividerDraft = () => ({
  schemaVersion: PCB_DESIGN_INTENT_DRAFT_SCHEMA_VERSION,
  kind: "pcb_design_intent_draft",
  scope: {
    sheetCount: 1,
    componentUnitPolicy: "single_unit",
    board: { shape: "rectangle", widthMm: 30, heightMm: 20, layerCount: 2, copperLayers: ["F.Cu", "B.Cu"] }
  },
  components: [
    {
      reference: "R1",
      symbolLibId: "Device:R",
      value: "10k",
      footprintLibId: "Resistor_SMD:R_0603_1608Metric",
      unit: 1,
      pins: [
        { pin: "1", assignment: { kind: "net", net: "VIN" } },
        { pin: "2", assignment: { kind: "net", net: "VOUT" } }
      ]
    },
    {
      reference: "R2",
      symbolLibId: "Device:R",
      value: "10k",
      footprintLibId: "Resistor_SMD:R_0603_1608Metric",
      unit: 1,
      pins: [
        { pin: "1", assignment: { kind: "net", net: "VOUT" } },
        { pin: "2", assignment: { kind: "net", net: "GND" } }
      ]
    },
    {
      reference: "J1",
      symbolLibId: "Connector_Generic:Conn_01x03",
      value: "DIVIDER_IO",
      footprintLibId: "Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical",
      unit: 1,
      pins: [
        { pin: "1", assignment: { kind: "net", net: "VIN" } },
        { pin: "2", assignment: { kind: "net", net: "VOUT" } },
        { pin: "3", assignment: { kind: "net", net: "GND" } }
      ]
    }
  ],
  nets: [
    { name: "VIN", role: "analog", endpoints: [{ reference: "R1", pin: "1" }, { reference: "J1", pin: "1" }], electrical: dcElectrical(3.3, 0.001), netClassId: "DEFAULT" },
    { name: "VOUT", role: "analog", endpoints: [{ reference: "R1", pin: "2" }, { reference: "R2", pin: "1" }, { reference: "J1", pin: "2" }], electrical: dcElectrical(1.65, 0.001), netClassId: "DEFAULT" },
    { name: "GND", role: "ground", endpoints: [{ reference: "R2", pin: "2" }, { reference: "J1", pin: "3" }], electrical: dcElectrical(0, 0.001), netClassId: "DEFAULT" }
  ],
  netClasses: [
    { id: "DEFAULT", traceWidthMm: 0.25, clearanceMm: 0.2, copperToEdgeMm: 0.3, allowedLayers: ["F.Cu", "B.Cu"] }
  ],
  placementConstraints: [placement("R1"), placement("R2"), placement("J1", "left", true)],
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
      { ...route("GND"), preferredLayer: "either", maxVias: 1 }
    ]
  },
  unresolved: []
});

type ResolverOptions = {
  readonly missingSymbol?: string;
  readonly missingFootprint?: string;
  readonly customSymbol?: string;
  readonly customFootprint?: string;
  readonly bgaSymbol?: string;
  readonly bgaFootprint?: string;
  readonly multiUnitSymbol?: string;
  readonly gpioSymbol?: string;
  readonly missingPolarizedFunction?: string;
  readonly footprintPads?: Readonly<Record<string, readonly string[]>>;
};

const symbolPins: Readonly<Record<string, readonly { number: string; function: string | null }[]>> = {
  "Connector_Generic:Conn_01x02": [{ number: "1", function: "Pin 1" }, { number: "2", function: "Pin 2" }],
  "Connector_Generic:Conn_01x03": [{ number: "1", function: "Pin 1" }, { number: "2", function: "Pin 2" }, { number: "3", function: "Pin 3" }],
  "Device:R": [{ number: "1", function: "Terminal 1" }, { number: "2", function: "Terminal 2" }],
  "Device:C": [{ number: "1", function: "Terminal 1" }, { number: "2", function: "Terminal 2" }],
  "Device:LED": [{ number: "1", function: "Cathode" }, { number: "2", function: "Anode" }]
};

const footprintPads: Readonly<Record<string, readonly string[]>> = {
  "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical": ["1", "2"],
  "Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical": ["1", "2", "3"],
  "Resistor_SMD:R_0603_1608Metric": ["1", "2"],
  "Capacitor_SMD:C_0603_1608Metric": ["1", "2"],
  "LED_SMD:LED_0603_1608Metric": ["1", "2"]
};

const makeResolver = (options: ResolverOptions = {}): PcbReadOnlyLibraryResolver => ({
  resolveSymbol: (libraryId): PcbResolvedSymbol | null => {
    if (libraryId === options.missingSymbol) return null;
    const pins = symbolPins[libraryId];
    if (pins === undefined) return null;
    const connector = libraryId.startsWith("Connector_Generic:");
    return {
      libraryId,
      source: libraryId === options.customSymbol ? "project-custom" : "kicad-stock",
      unitCount: libraryId === options.multiUnitSymbol ? 2 : 1,
      componentKind: libraryId === options.bgaSymbol
        ? "bga"
        : libraryId === options.gpioSymbol
          ? "gpio"
          : connector
            ? "connector"
            : "generic",
      polarized: libraryId === "Device:LED",
      pins: pins.map((pin) => ({
        ...pin,
        function: libraryId === options.missingPolarizedFunction && pin.number === "2" ? null : pin.function
      }))
    };
  },
  resolveFootprint: (libraryId): PcbResolvedFootprint | null => {
    if (libraryId === options.missingFootprint) return null;
    const pads = options.footprintPads?.[libraryId] ?? footprintPads[libraryId];
    if (pads === undefined) return null;
    return {
      libraryId,
      source: libraryId === options.customFootprint ? "project-custom" : "kicad-stock",
      packageKind: libraryId === options.bgaFootprint ? "bga" : "generic",
      pads: [...pads]
    };
  }
});

const compile = (draft: unknown, resolver = makeResolver(), extra: Record<string, unknown> = {}) =>
  compilePcbDesignIntentDraft(draft, {
    libraryResolver: resolver,
    deepRuleCatalog: catalog,
    ...extra
  });

const clone = <Value>(value: Value): Value => structuredClone(value);

describe("deterministic PCB design compiler v1", () => {
  it("compiles the LED design into closed, identity-bound host artifacts", () => {
    const result = compile(ledDraft());
    expect(result.schemaVersion).toBe(PCB_DESIGN_COMPILATION_SCHEMA_VERSION);
    expect(result.disposition).toBe("ready");
    expect(result.questions).toEqual([]);
    expect(result.issues).toEqual([]);
    expect(result.contractIdentity).toEqual(result.contract?.identity);
    expect(result.libraryBinding).toMatchObject({ schemaVersion: PCB_LIBRARY_BINDING_SCHEMA_VERSION });
    expect(result.deepRuleBinding).toMatchObject({ schemaVersion: PCB_DEEP_RULE_BINDING_SCHEMA_VERSION });
    expect(result.acceptancePlan).toMatchObject({ schemaVersion: PCB_ACCEPTANCE_PLAN_SCHEMA_VERSION });
    expect(result.libraryBinding?.contractIdentity).toEqual(result.contractIdentity);
    expect(result.deepRuleBinding?.contractIdentity).toEqual(result.contractIdentity);
    expect(result.acceptancePlan?.contractIdentity).toEqual(result.contractIdentity);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.acceptancePlan?.rows)).toBe(true);
    expect(Object.isFrozen(result.deepRuleBinding?.selection.rules)).toBe(true);
  });

  it("compiles a non-LED resistor-divider/connector design with bounded vias", () => {
    const result = compile(dividerDraft());
    expect(result.disposition).toBe("ready");
    expect(result.contract?.components.map((component) => component.reference)).toEqual(["J1", "R1", "R2"]);
    expect(result.contract?.routingConstraints.viaPolicy).toMatchObject({ mode: "bounded", maxTotal: 3 });
    expect(result.acceptancePlan?.rows.map((entry) => entry.id)).toContain("net:VOUT:routed");
    expect(result.acceptancePlan?.rows.map((entry) => entry.id)).toContain("route:VOUT:vias");
  });

  it("normalizes every semantic array permutation to byte-equivalent compiler output", () => {
    const first = dividerDraft();
    const second = clone(first);
    second.scope.board.copperLayers.reverse();
    second.components.reverse();
    second.components.forEach((component) => component.pins.reverse());
    second.nets.reverse();
    second.nets.forEach((net) => net.endpoints.reverse());
    second.netClasses.reverse();
    second.netClasses.forEach((netClass) => netClass.allowedLayers.reverse());
    second.placementConstraints.reverse();
    second.placementConstraints.forEach((entry) => entry.allowedRotationsDeg.reverse());
    second.routingConstraints.nets.reverse();
    expect(compile(second)).toEqual(compile(first));
  });

  it("returns all voltage, current, peak, speed, and pinout questions in one stable batch", () => {
    const draft: any = ledDraft();
    draft.nets.find((net: any) => net.name === "LED_A").electrical = null;
    draft.components.find((component: any) => component.reference === "D1").pins.find((pin: any) => pin.pin === "2").assignment = {
      kind: "unresolved",
      question: "Which LED pin is the anode?"
    };
    draft.nets.find((net: any) => net.name === "LED_A").endpoints = [
      { reference: "R1", pin: "2" }
    ];
    draft.unresolved.push({ path: "/component/D1/pin/2/assignment", question: "Confirm the LED anode mapping." });
    const result = compile(draft);
    const paths = result.questions.map((question) => question.path);
    expect(result.disposition).toBe("needs_clarification");
    expect(paths).toEqual([...paths].sort());
    expect(paths).toEqual(expect.arrayContaining([
      "component.D1.pin.2.assignment",
      "net.LED_A.electrical.voltage.nominalV",
      "net.LED_A.electrical.current.maximumContinuousA",
      "net.LED_A.electrical.current.peakA",
      "net.LED_A.electrical.current.peakDurationMs",
      "net.LED_A.electrical.speed",
      "net.LED_A.endpoints"
    ]));
    expect(new Set(result.questions.map((question) => question.id)).size).toBe(result.questions.length);
    expect(result.contract).toBeNull();
    expect(result.libraryBinding).toBeNull();
    expect(result.deepRuleBinding).toBeNull();
    expect(result.acceptancePlan).toBeNull();
  });

  it("keeps known unresolved electrical questions when an unrelated strict-schema error is also present", () => {
    const draft: any = ledDraft();
    draft.nets.find((net: any) => net.name === "LED_A").electrical = null;
    draft.unknownRootField = "must still be reported";
    const result = compile(draft);
    const paths = result.questions.map((entry) => entry.path);
    expect(result.disposition).toBe("needs_clarification");
    expect(result.issues.some((entry) => entry.code === "INVALID_DRAFT" && entry.path === "$" )).toBe(true);
    expect(paths).toEqual(expect.arrayContaining([
      "net.LED_A.electrical.voltage.minimumV",
      "net.LED_A.electrical.voltage.nominalV",
      "net.LED_A.electrical.voltage.maximumV",
      "net.LED_A.electrical.current.nominalA",
      "net.LED_A.electrical.current.maximumContinuousA",
      "net.LED_A.electrical.current.peakA",
      "net.LED_A.electrical.current.peakDurationMs",
      "net.LED_A.electrical.speed"
    ]));
    expect(paths).toEqual([...paths].sort());
  });

  it("unions duplicate keyed placement and route gaps independently of input order", () => {
    const first: any = ledDraft();
    const r1Placement = first.placementConstraints.find((entry: any) => entry.reference === "R1");
    const duplicatePlacement = clone(r1Placement);
    r1Placement.regionMm = null;
    duplicatePlacement.side = null;
    first.placementConstraints.push(duplicatePlacement);

    const ledRoute = first.routingConstraints.nets.find((entry: any) => entry.net === "LED_A");
    const duplicateRoute = clone(ledRoute);
    ledRoute.topology = null;
    duplicateRoute.preferredLayer = null;
    first.routingConstraints.nets.push(duplicateRoute);

    const second = clone(first);
    second.placementConstraints.reverse();
    second.routingConstraints.nets.reverse();
    const firstResult = compile(first);
    const secondResult = compile(second);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult.disposition).toBe("needs_clarification");
    expect(firstResult.questions.map((entry) => entry.path)).toEqual(expect.arrayContaining([
      "placement.R1.regionMm",
      "placement.R1.side",
      "route.LED_A.topology",
      "route.LED_A.preferredLayer"
    ]));
  });

  it("batches missing placement, route, class, and board facts instead of defaulting them", () => {
    const draft: any = ledDraft();
    draft.scope.board.widthMm = null;
    draft.netClasses[0].traceWidthMm = null;
    draft.placementConstraints = draft.placementConstraints.filter((entry: any) => entry.reference !== "R1");
    draft.routingConstraints.nets = draft.routingConstraints.nets.filter((entry: any) => entry.net !== "LED_A");
    const result = compile(draft);
    expect(result.disposition).toBe("needs_clarification");
    expect(result.questions.map((entry) => entry.path)).toEqual(expect.arrayContaining([
      "scope.board.widthMm",
      "netClass.POWER.traceWidthMm",
      "placement.R1",
      "route.LED_A"
    ]));
  });

  it("turns relationship errors into stable semantic-path issues without throwing", () => {
    const draft: any = ledDraft();
    draft.components.push(clone(draft.components[0]));
    const result = compile(draft);
    expect(result.disposition).toBe("needs_clarification");
    expect(result.issues.some((entry) => entry.path.startsWith("component.J1"))).toBe(true);
    expect(result.questions.every((entry) => !entry.path.includes("components.4"))).toBe(true);
  });

  it.each([
    ["differential pairs", { differentialPairs: true }, "differential-pair routing"],
    ["controlled impedance", { controlledImpedance: true }, "controlled impedance"],
    ["BGA", { bga: true }, "BGA"],
    ["custom libraries", { customLibraries: true }, "custom symbol"],
    ["multi-unit symbols", { multiUnitSymbols: true }, "multi-unit"],
    ["back-side placement", { backSidePlacement: true }, "back-side"],
    ["multiple sheets", { multipleSchematicSheets: true }, "multiple schematic"],
    ["multilayer", { multilayer: true }, "more than two"],
    ["nonrectangular", { nonRectangularBoard: true }, "non-rectangular"]
  ])("returns unsupported for an explicit structured %s request", (_name, requestedCapabilities, message) => {
    const result = compile(ledDraft(), makeResolver(), { requestedCapabilities });
    expect(result.disposition).toBe("unsupported");
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.message).toContain(message);
    expect(result.contract).toBeNull();
  });

  it("detects unsupported shape/layer/unit literals before strict draft parsing", () => {
    for (const mutate of [
      (draft: any) => { draft.scope.board.shape = "circle"; },
      (draft: any) => { draft.scope.board.layerCount = 4; },
      (draft: any) => { draft.components[0].unit = 2; }
    ]) {
      const draft = ledDraft();
      mutate(draft);
      expect(compile(draft).disposition).toBe("unsupported");
    }
  });

  it("accepts a back-side fact in the draft but classifies it as unsupported before closure", () => {
    const draft: any = ledDraft();
    draft.placementConstraints.find((entry: any) => entry.reference === "D1").side = "back";
    const result = compile(draft);
    expect(result.disposition).toBe("unsupported");
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "UNSUPPORTED_V1_FEATURE",
        path: "placement.D1.side",
        message: expect.stringContaining("back-side component placement")
      })
    ]);
    expect(result.questions).toEqual([]);
    expect(result.contract).toBeNull();
    expect(result.libraryBinding).toBeNull();
    expect(result.deepRuleBinding).toBeNull();
    expect(result.acceptancePlan).toBeNull();
  });

  it("classifies exact newer structured fields as unsupported rather than scanning names or guessing", () => {
    const differential: any = ledDraft();
    differential.nets[1].differentialPairId = "PAIR_1";
    expect(compile(differential)).toMatchObject({
      disposition: "unsupported",
      issues: [{ path: "net.LED_A.differentialPair" }]
    });

    const impedance: any = ledDraft();
    impedance.nets[1].targetImpedanceOhms = 50;
    expect(compile(impedance)).toMatchObject({
      disposition: "unsupported",
      issues: [{ path: "net.LED_A.targetImpedanceOhms" }]
    });

    const custom: any = ledDraft();
    custom.components[1].libraryPath = "some-path";
    expect(compile(custom)).toMatchObject({
      disposition: "unsupported",
      issues: [{ path: "component.R1.librarySource" }]
    });
  });

  it.each([
    ["BGA symbol", makeResolver({ bgaSymbol: "Device:R" }), "BGA"],
    ["BGA footprint", makeResolver({ bgaFootprint: "Resistor_SMD:R_0603_1608Metric" }), "BGA"],
    ["custom symbol", makeResolver({ customSymbol: "Device:R" }), "custom symbol"],
    ["custom footprint", makeResolver({ customFootprint: "Resistor_SMD:R_0603_1608Metric" }), "custom symbol"],
    ["multi-unit local symbol", makeResolver({ multiUnitSymbol: "Device:R" }), "multi-unit"]
  ])("returns unsupported when the exact local binding reveals a %s", (_name, resolver, expectedMessage) => {
    const result = compile(ledDraft(), resolver);
    expect(result.disposition).toBe("unsupported");
    expect(result.issues.some((issue) =>
      issue.code === "UNSUPPORTED_V1_FEATURE"
      && issue.path.includes("R1")
      && issue.message.includes(expectedMessage)
    )).toBe(true);
  });

  it("asks for exact replacement IDs when local libraries are unknown", () => {
    const result = compile(ledDraft(), makeResolver({
      missingSymbol: "Device:LED",
      missingFootprint: "LED_SMD:LED_0603_1608Metric"
    }));
    expect(result.disposition).toBe("needs_clarification");
    expect(result.questions.map((entry) => entry.path)).toEqual(expect.arrayContaining([
      "component.D1.symbolLibId",
      "component.D1.footprintLibId"
    ]));
    expect(result.issues.filter((entry) => entry.code === "UNKNOWN_LIBRARY_ID")).toHaveLength(2);
  });

  it("requires the complete declared-pin, symbol-pin, and footprint-pad sets to agree", () => {
    const result = compile(ledDraft(), makeResolver({
      footprintPads: { "LED_SMD:LED_0603_1608Metric": ["1", "2", "MP"] }
    }));
    expect(result.disposition).toBe("needs_clarification");
    expect(result.issues.some((entry) => entry.code === "LIBRARY_PIN_PAD_MISMATCH")).toBe(true);
    expect(result.questions.map((entry) => entry.path)).toContain("component.D1.footprintLibId");
  });

  it("requires polarized library pin functions and connector access orientation", () => {
    const polarity = compile(ledDraft(), makeResolver({ missingPolarizedFunction: "Device:LED" }));
    expect(polarity.disposition).toBe("needs_clarification");
    expect(polarity.questions.map((entry) => entry.path)).toContain("component.D1.polarity");

    const orientationDraft: any = ledDraft();
    const connectorPlacement = orientationDraft.placementConstraints.find((entry: any) => entry.reference === "J1");
    connectorPlacement.edgePreference = "none";
    connectorPlacement.allowedRotationsDeg = [0, 90];
    const orientation = compile(orientationDraft);
    expect(orientation.disposition).toBe("needs_clarification");
    expect(orientation.questions.map((entry) => entry.path)).toEqual(expect.arrayContaining([
      "placement.J1.edgePreference",
      "placement.J1.allowedRotationsDeg"
    ]));
  });

  it("uses injective path encoding for legal pin identifiers that previously collided", () => {
    const draft: any = ledDraft();
    const diode = draft.components.find((component: any) => component.reference === "D1");
    diode.pins[0].pin = "A/B";
    diode.pins[1].pin = "A_B";
    for (const net of draft.nets) {
      for (const endpoint of net.endpoints) {
        if (endpoint.reference !== "D1") continue;
        endpoint.pin = endpoint.pin === "1" ? "A/B" : "A_B";
      }
    }
    const base = makeResolver();
    const resolver: PcbReadOnlyLibraryResolver = {
      resolveSymbol: (id) => id === "Device:LED"
        ? {
            libraryId: id,
            source: "kicad-stock",
            unitCount: 1,
            componentKind: "generic",
            polarized: true,
            pins: [{ number: "A/B", function: "Cathode" }, { number: "A_B", function: "Anode" }]
          }
        : base.resolveSymbol(id),
      resolveFootprint: (id) => id === "LED_SMD:LED_0603_1608Metric"
        ? { libraryId: id, source: "kicad-stock", packageKind: "generic", pads: ["A/B", "A_B"] }
        : base.resolveFootprint(id)
    };

    const ready = compile(draft, resolver);
    expect(ready.disposition).toBe("ready");
    const pinRows = ready.acceptancePlan!.rows.filter((entry) => entry.id.startsWith("pin:D1:"));
    expect(pinRows.map((entry) => entry.id)).toEqual(expect.arrayContaining([
      "pin:D1:A%002FB:disposition",
      "pin:D1:A_B:disposition"
    ]));
    expect(new Set(pinRows.map((entry) => entry.contractPath)).size).toBe(2);

    for (const pin of diode.pins) pin.assignment = { kind: "unresolved", question: `Resolve ${pin.pin}.` };
    for (const net of draft.nets) net.endpoints = net.endpoints.filter((endpoint: any) => endpoint.reference !== "D1");
    const unresolved = compile(draft, resolver);
    expect(unresolved.disposition).toBe("needs_clarification");
    expect(unresolved.questions.map((entry) => entry.path)).toEqual(expect.arrayContaining([
      "component.D1.pin.A%002FB.assignment",
      "component.D1.pin.A_B.assignment"
    ]));
    expect(new Set(unresolved.questions.map((entry) => entry.id)).size).toBe(unresolved.questions.length);
  });

  it("passes exact IDs to a read-only resolver and emits a path-free canonical projection", () => {
    const symbolCalls: string[] = [];
    const footprintCalls: string[] = [];
    const base = makeResolver();
    const resolver: PcbReadOnlyLibraryResolver = {
      resolveSymbol: (id) => {
        symbolCalls.push(id);
        return base.resolveSymbol(id);
      },
      resolveFootprint: (id) => {
        footprintCalls.push(id);
        return base.resolveFootprint(id);
      }
    };
    const result = compile(ledDraft(), resolver);
    expect(result.disposition).toBe("ready");
    expect(symbolCalls.sort()).toEqual(["Connector_Generic:Conn_01x02", "Device:C", "Device:LED", "Device:R"].sort());
    expect(footprintCalls.sort()).toEqual([
      "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical",
      "Resistor_SMD:R_0603_1608Metric",
      "LED_SMD:LED_0603_1608Metric",
      "Capacitor_SMD:C_0603_1608Metric"
    ].sort());
    expect(JSON.stringify(result.libraryBinding)).not.toMatch(/[A-Z]:\\|\/home\/|file:/iu);
    expect(result.libraryBinding?.identity.digest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("derives deep-rule features from the closed artifact, never prompt-like net names", () => {
    const ordinary = compile(ledDraft());
    expect(ordinary.deepRuleBinding?.features).toEqual({
      placement: true,
      dfm: true,
      assembly: true,
      powerCurrent: true
    });
    expect(ordinary.deepRuleBinding?.selection.activeFeatures).toEqual([
      "powerCurrent",
      "placement",
      "dfm",
      "assembly"
    ]);

    const fast: any = ledDraft();
    const passiveNet = fast.nets.find((entry: any) => entry.name === "LED_A");
    passiveNet.name = "USB_DP_DIFFERENTIAL_90OHM_BGA";
    for (const component of fast.components) {
      for (const pin of component.pins) {
        if (pin.assignment.kind === "net" && pin.assignment.net === "LED_A") pin.assignment.net = passiveNet.name;
      }
    }
    fast.routingConstraints.nets.find((entry: any) => entry.net === "LED_A").net = passiveNet.name;
    passiveNet.electrical.speed = { kind: "signal", maximumFrequencyMHz: 480, minimumEdgeTimeNs: 1 };
    const fastResult = compile(fast);
    expect(fastResult.disposition).toBe("ready");
    expect(fastResult.deepRuleBinding?.selection.activeFeatures).toContain("signalSpeedInterfaces");
    expect(fastResult.deepRuleBinding?.selection.activeFeatures).not.toContain("differentialPairs");
    expect(fastResult.deepRuleBinding?.selection.activeFeatures).not.toContain("bga");
    expect(fastResult.deepRuleBinding?.selection.activeFeatures).not.toContain("stackupImpedance");
  });

  it("derives GPIO guidance only from the bound local symbol classification", () => {
    const result = compile(ledDraft(), makeResolver({ gpioSymbol: "Device:R" }));
    expect(result.disposition).toBe("ready");
    expect(result.deepRuleBinding?.selection.activeFeatures).toContain("gpio");
    expect(deriveDeepRuleFeaturesFromContract(result.contract!, result.libraryBinding!)).toEqual(result.deepRuleBinding?.features);
  });

  it("binds stable selected rule IDs and exact catalog identity to the contract", () => {
    const first = compile(ledDraft());
    const second = compile(clone(ledDraft()));
    expect(first.deepRuleBinding?.selection.deepRuleSelection).toEqual(second.deepRuleBinding?.selection.deepRuleSelection);
    expect(first.deepRuleBinding?.catalogIdentity).toEqual(second.deepRuleBinding?.catalogIdentity);
    expect(first.deepRuleBinding?.identity).toEqual(second.deepRuleBinding?.identity);
    expect(first.deepRuleBinding?.selection.rules.length).toBeGreaterThan(9);
  });

  it("generates all mandatory acceptance rows on the host in fixed phase order", () => {
    const result = compile(ledDraft());
    const rows = result.acceptancePlan!.rows;
    const ids = rows.map((entry) => entry.id);
    expect(ids[0]).toBe("contract:integrity");
    expect(ids).toEqual(expect.arrayContaining([
      "library:J1:symbol",
      "library:J1:footprint",
      "component:J1:schematic",
      "pin:J1:2:disposition",
      "net:GND:schematic",
      "component:J1:pcb",
      "board:outline",
      "placement:J1",
      "net:GND:routed",
      "netclass:POWER:width",
      "netclass:POWER:clearance",
      "route:GND:turns",
      "route:GND:vias",
      "erc",
      "drc",
      "visual-practice"
    ]));
    expect(ids.slice(-4)).toEqual(["erc", "drc", "visual-practice", "schematic-render-clearance"]);
    expect(rows.every((entry) => entry.mandatory)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(rows.find((entry) => entry.id === "netclass:POWER:width")?.description).toContain("not ampacity proof");
    expect(rows.find((entry) => entry.id === "netclass:POWER:clearance")).toMatchObject({
      kind: "netclass_clearance",
      mandatory: true,
      contractPath: "netClass.POWER.clearanceMm"
    });
    expect(rows.find((entry) => entry.id === "netclass:POWER:clearance")?.description).toContain("at least 0.25 mm");
    expect(rows.find((entry) => entry.id === "netclass:POWER:clearance")?.description).toContain("DRC result alone does not prove");
    expect(ids.indexOf("netclass:POWER:clearance")).toBe(ids.indexOf("netclass:POWER:width") + 1);
    expect(result.acceptancePlan?.libraryBindingIdentity).toEqual(result.libraryBinding?.identity);
    expect(result.acceptancePlan?.deepRuleBindingIdentity).toEqual(result.deepRuleBinding?.identity);
  });

  it("generates one mandatory clearance row for every canonical closed net class", () => {
    const result = compile(ledDraft());
    const clearanceRows = result.acceptancePlan!.rows.filter((entry) => entry.kind === "netclass_clearance");
    expect(clearanceRows).toEqual([
      expect.objectContaining({ id: "netclass:POWER:clearance", contractPath: "netClass.POWER.clearanceMm" }),
      expect.objectContaining({ id: "netclass:SIGNAL:clearance", contractPath: "netClass.SIGNAL.clearanceMm" })
    ]);
    expect(clearanceRows.every((entry) => entry.mandatory)).toBe(true);
  });

  it("does not call libraries or rule selection for a structurally unsupported request", () => {
    let calls = 0;
    const resolver: PcbReadOnlyLibraryResolver = {
      resolveSymbol: () => { calls += 1; return null; },
      resolveFootprint: () => { calls += 1; return null; }
    };
    const result = compile(ledDraft(), resolver, { requestedCapabilities: { controlledImpedance: true } });
    expect(result.disposition).toBe("unsupported");
    expect(calls).toBe(0);
    expect(result.deepRuleBinding).toBeNull();
  });

  it("enforces the raw byte bound before inspecting an unsupported feature field", () => {
    const result = compile({
      differentialPairs: [],
      padding: "x".repeat(300_000)
    });
    expect(result.disposition).toBe("needs_clarification");
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "INVALID_DRAFT",
        path: "$",
        message: expect.stringContaining("limit is 262144")
      })
    ]);
    expect(result.issues.some((issue) => issue.code === "UNSUPPORTED_V1_FEATURE")).toBe(false);
  });

  it("rejects pathological depth before traversing a nested unsupported field", () => {
    const root: Record<string, unknown> = { differentialPairs: [] };
    let cursor = root;
    for (let depth = 0; depth <= PCB_DESIGN_COMPILER_INPUT_LIMITS.maxDepth; depth += 1) {
      const child: Record<string, unknown> = {};
      cursor.next = child;
      cursor = child;
    }
    const result = compile(root);
    expect(result.disposition).toBe("needs_clarification");
    expect(result.issues[0]).toMatchObject({ code: "INVALID_DRAFT", path: "$" });
    expect(result.issues[0]?.message).toContain(`maximum depth ${PCB_DESIGN_COMPILER_INPUT_LIMITS.maxDepth}`);
    expect(result.issues.some((issue) => issue.code === "UNSUPPORTED_V1_FEATURE")).toBe(false);
  });

  it("rejects huge and sparse arrays before unsupported detection or schema recursion", () => {
    for (const pathological of [
      Array.from({ length: PCB_DESIGN_COMPILER_INPUT_LIMITS.maxArrayLength + 1 }, () => null),
      new Array(10_000_000)
    ]) {
      const result = compile({ differentialPairs: pathological });
      expect(result.disposition).toBe("needs_clarification");
      expect(result.issues[0]).toMatchObject({ code: "INVALID_DRAFT", path: "$" });
      expect(result.issues[0]?.message).toContain(`exceeds ${PCB_DESIGN_COMPILER_INPUT_LIMITS.maxArrayLength} entries`);
      expect(result.issues.some((issue) => issue.code === "UNSUPPORTED_V1_FEATURE")).toBe(false);
    }
  });

  it("captures one compiler input view without invoking accessors, get traps, or toJSON", () => {
    let getterCalls = 0;
    const accessor: any = ledDraft();
    const scope = accessor.scope;
    Object.defineProperty(accessor, "scope", {
      enumerable: true,
      get: () => { getterCalls += 1; return scope; }
    });
    const accessorResult = compile(accessor);
    expect(accessorResult).toMatchObject({
      disposition: "needs_clarification",
      issues: [expect.objectContaining({ code: "INVALID_DRAFT", path: "$" })]
    });
    expect(getterCalls).toBe(0);

    let getCalls = 0;
    const proxy = new Proxy(ledDraft(), {
      get: (target, property, receiver) => {
        getCalls += 1;
        return Reflect.get(target, property, receiver) as unknown;
      }
    });
    expect(compile(proxy).disposition).toBe("ready");
    expect(getCalls).toBe(0);

    let toJsonCalls = 0;
    const oversized: any = { differentialPairs: [], padding: "x".repeat(300_000) };
    oversized.toJSON = () => { toJsonCalls += 1; return {}; };
    const oversizedResult = compile(oversized);
    expect(oversizedResult).toMatchObject({
      disposition: "needs_clarification",
      issues: [expect.objectContaining({ code: "INVALID_DRAFT", message: expect.stringContaining("limit is 262144") })]
    });
    expect(toJsonCalls).toBe(0);
  });

  it("coalesces declared and intrinsic unresolved paths after strict semantic resolution", () => {
    const draft: any = ledDraft();
    const diode = draft.components.find((entry: any) => entry.reference === "D1");
    diode.pins.find((entry: any) => entry.pin === "2").assignment = {
      kind: "unresolved", question: "Which LED pin is the anode?"
    };
    draft.nets.find((entry: any) => entry.name === "LED_A").endpoints = [{ reference: "R1", pin: "2" }];
    draft.unresolved = [{
      path: "/components/D1/pins/2/assignment",
      question: "Confirm the LED anode mapping."
    }];
    const result = compile(draft);
    const path = "component.D1.pin.2.assignment";
    expect(result.questions.filter((entry) => entry.path === path)).toHaveLength(1);
    expect(result.issues.filter((entry) => entry.code === "UNRESOLVED_FIELD" && entry.path === path)).toHaveLength(1);
    expect(result.questions.find((entry) => entry.path === path)?.question).toContain("Confirm the LED anode mapping.");
    expect(result.questions.find((entry) => entry.path === path)?.question).toContain("Which LED pin is the anode?");

    const routeDraft: any = ledDraft();
    routeDraft.routingConstraints.nets.find((entry: any) => entry.net === "LED_A").topology = null;
    routeDraft.unresolved = [{
      path: "/routingConstraints/nets/LED_A/topology",
      question: "Choose the LED_A topology."
    }];
    const routeResult = compile(routeDraft);
    expect(routeResult.questions.filter((entry) => entry.path === "route.LED_A.topology")).toHaveLength(1);
    expect(routeResult.issues.filter((entry) =>
      entry.code === "UNRESOLVED_FIELD" && entry.path === "route.LED_A.topology")).toHaveLength(1);
  });

  it("keeps semantic-pointer findings invariant under keyed collection permutations", () => {
    const first: any = ledDraft();
    first.scope.board.widthMm = null;
    first.unresolved = [
      { path: "/scope/board/widthMm", question: "Choose width." },
      { path: "/components/D1/value", question: "Confirm the LED value." },
      { path: "/routingConstraints/nets/LED_A/topology", question: "Confirm the LED route topology." }
    ];
    const second = clone(first);
    second.components.reverse();
    second.nets.reverse();
    second.nets.forEach((net: any) => net.endpoints.reverse());
    second.placementConstraints.reverse();
    second.routingConstraints.nets.reverse();
    second.unresolved.reverse();
    expect(compile(second)).toEqual(compile(first));
  });

  it("keeps cross-net relationship diagnostics invariant under net permutations", () => {
    const first: any = ledDraft();
    first.nets.find((entry: any) => entry.name === "LED_A").endpoints.push({ reference: "J1", pin: "1" });
    const second = clone(first);
    second.nets.reverse();
    second.routingConstraints.nets.reverse();
    expect(compile(second)).toEqual(compile(first));
  });

  it.each([
    "/component/D1/value",
    "/components/0/value",
    "/components/D1/pins/1/~",
    "/components/D1/pins/1/~2",
    "/components/D1/pins/1/assignment/",
    "/constructor"
  ])("returns a bounded invalid-draft finding for malformed semantic pointer %s", (pointer) => {
    const draft: any = ledDraft();
    draft.unresolved = [{ path: pointer, question: "Resolve it." }];
    const result = compile(draft);
    expect(result.disposition).toBe("needs_clarification");
    expect(result.issues.some((entry) => entry.code === "INVALID_DRAFT")).toBe(true);
    expect(result.questions.every((entry) => entry.path.length <= 512)).toBe(true);
  });

  it("blocks a three-endpoint point-to-point topology before contract readiness", () => {
    const draft: any = ledDraft();
    draft.routingConstraints.nets.find((entry: any) => entry.net === "VCC").topology = "point_to_point";
    const result = compile(draft);
    expect(result.disposition).toBe("needs_clarification");
    expect(result.contract).toBeNull();
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "INVALID_DRAFT",
      path: "route.VCC.topology",
      message: expect.stringContaining("exactly 2 endpoints")
    }));
  });

  it("rejects negative zero before identity and resolver work", () => {
    const draft: any = ledDraft();
    draft.routingConstraints.nets[0].maxVias = -0;
    let resolverCalls = 0;
    const base = makeResolver();
    const resolver: PcbReadOnlyLibraryResolver = {
      resolveSymbol: (id) => { resolverCalls += 1; return base.resolveSymbol(id); },
      resolveFootprint: (id) => { resolverCalls += 1; return base.resolveFootprint(id); }
    };
    const result = compile(draft, resolver);
    expect(result.disposition).toBe("needs_clarification");
    expect(result.issues.some((entry) => entry.message.includes("negative zero"))).toBe(true);
    expect(result.contract).toBeNull();
    expect(resolverCalls).toBe(0);
  });

  it("round-trips +5V without widening net-class identifiers", () => {
    const draft: any = ledDraft();
    for (const component of draft.components) for (const pin of component.pins) {
      if (pin.assignment.kind === "net" && pin.assignment.net === "VCC") pin.assignment.net = "+5V";
    }
    draft.nets.find((entry: any) => entry.name === "VCC").name = "+5V";
    draft.routingConstraints.nets.find((entry: any) => entry.net === "VCC").net = "+5V";
    const result = compile(draft);
    expect(result.disposition).toBe("ready");
    expect(result.contract?.nets.some((entry) => entry.name === "+5V")).toBe(true);
    expect(result.contract?.netClasses.map((entry) => entry.id)).toEqual(["POWER", "SIGNAL"]);
  });

  it("returns one deterministic bounded finding when schema diagnostics overflow", () => {
    const pathological: any = ledDraft();
    pathological.components = Array.from(
      { length: PCB_DESIGN_COMPILER_INPUT_LIMITS.maxArrayLength },
      (_, index) => ({ reference: `X${index}`, pins: Array.from({ length: 32 }, () => null) })
    );
    const first = compile(pathological);
    pathological.components.reverse();
    const second = compile(pathological);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      disposition: "needs_clarification",
      questions: [{ id: "$", path: "$" }],
      issues: [{
        code: "INVALID_DRAFT",
        path: "$",
        clarificationId: "$",
        message: expect.stringContaining("diagnostics exceeded")
      }]
    });
    expect(first.issues.length).toBeLessThanOrEqual(PCB_DESIGN_COMPILATION_LIMITS.maxIssues);
    expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeLessThanOrEqual(PCB_DESIGN_COMPILATION_LIMITS.maxPayloadBytes);
  });

  it("treats resolver exceptions and exact-ID substitution as clarification, never readiness", () => {
    const base = makeResolver();
    const throwing: PcbReadOnlyLibraryResolver = {
      resolveSymbol: (id) => id === "Device:LED" ? (() => { throw new Error("host failure"); })() : base.resolveSymbol(id),
      resolveFootprint: (id) => {
        const resolved = base.resolveFootprint(id);
        return id === "LED_SMD:LED_0603_1608Metric" && resolved !== null
          ? { ...resolved, libraryId: "LED_SMD:Another_Footprint" }
          : resolved;
      }
    };
    const result = compile(ledDraft(), throwing);
    expect(result.disposition).toBe("needs_clarification");
    expect(result.issues.some((entry) => entry.code === "INVALID_LIBRARY_RECORD")).toBe(true);
    expect(result.contractIdentity).toBeNull();
  });

  it("normalizes only detached resolver descriptors, including nested pins and pads", () => {
    const base = makeResolver();
    let liveReads = 0;
    const resolver: PcbReadOnlyLibraryResolver = {
      resolveSymbol: (id) => {
        const original = base.resolveSymbol(id);
        if (original === null) return null;
        const pins = new Proxy(original.pins.map((pin) => new Proxy({ ...pin }, {
          get: (target, property, receiver) => {
            liveReads += 1;
            if (property === "number") return "999";
            if (property === "function") return "MALICIOUS_PIN";
            return Reflect.get(target, property, receiver) as unknown;
          }
        })), {
          get: (target, property, receiver) => {
            liveReads += 1;
            if (property === "0") return { number: "999", function: "MALICIOUS_PIN" };
            return Reflect.get(target, property, receiver) as unknown;
          }
        });
        return new Proxy({ ...original, pins }, {
          get: (target, property, receiver) => {
            liveReads += 1;
            if (property === "libraryId") return "Hostile:Substitution";
            if (property === "source") return "project-custom";
            if (property === "unitCount") return 2;
            if (property === "componentKind") return "bga";
            return Reflect.get(target, property, receiver) as unknown;
          }
        });
      },
      resolveFootprint: (id) => {
        const original = base.resolveFootprint(id);
        if (original === null) return null;
        const pads = new Proxy([...original.pads], {
          get: (target, property, receiver) => {
            liveReads += 1;
            if (property === "0") return "999";
            return Reflect.get(target, property, receiver) as unknown;
          }
        });
        return new Proxy({ ...original, pads }, {
          get: (target, property, receiver) => {
            liveReads += 1;
            if (property === "libraryId") return "Hostile:Footprint";
            if (property === "source") return "project-custom";
            if (property === "packageKind") return "bga";
            return Reflect.get(target, property, receiver) as unknown;
          }
        });
      }
    };
    const result = compile(ledDraft(), resolver);
    expect(result.disposition).toBe("ready");
    expect(liveReads).toBe(0);
    expect(result.libraryBinding?.symbols.every((entry) =>
      entry.source === "kicad-stock" && entry.unitCount === 1
    )).toBe(true);
    expect(result.libraryBinding?.symbols.flatMap((entry) => entry.pins).some((pin) => pin.number === "999")).toBe(false);
    expect(result.libraryBinding?.footprints.every((entry) =>
      entry.source === "kicad-stock" && entry.packageKind === "generic" && !entry.pads.includes("999")
    )).toBe(true);
  });

  it("snapshots a symbol before the footprint resolver can mutate its active return", () => {
    const base = makeResolver();
    let activeSymbol: any;
    let symbolCalls = 0;
    let footprintCalls = 0;
    const resolver: PcbReadOnlyLibraryResolver = {
      resolveSymbol: (id) => {
        if (id !== "Device:R") return base.resolveSymbol(id);
        symbolCalls += 1;
        activeSymbol = base.resolveSymbol(id)!;
        return activeSymbol;
      },
      resolveFootprint: (id) => {
        if (id !== "Resistor_SMD:R_0603_1608Metric") return base.resolveFootprint(id);
        footprintCalls += 1;
        activeSymbol.source = "project-custom";
        activeSymbol.unitCount = 2;
        activeSymbol.componentKind = "bga";
        activeSymbol.pins[0].number = "999";
        return base.resolveFootprint(id);
      }
    };
    const result = compile(ledDraft(), resolver);
    expect(result.disposition).toBe("ready");
    expect(symbolCalls).toBe(1);
    expect(footprintCalls).toBe(1);
    expect(result.libraryBinding?.symbols.find((entry) => entry.reference === "R1")).toMatchObject({
      libraryId: "Device:R",
      source: "kicad-stock",
      unitCount: 1,
      componentKind: "generic",
      pins: [{ number: "1" }, { number: "2" }]
    });
  });

  it("finishes symbol reflection before a later footprint return can be mutated", () => {
    const base = makeResolver();
    let activeFootprint: any;
    let reflectionCalls = 0;
    let symbolCalls = 0;
    let footprintCalls = 0;
    const resolver: PcbReadOnlyLibraryResolver = {
      resolveSymbol: (id) => {
        if (id !== "Device:R") return base.resolveSymbol(id);
        symbolCalls += 1;
        return new Proxy(base.resolveSymbol(id)!, {
          ownKeys: (target) => {
            reflectionCalls += 1;
            if (activeFootprint !== undefined) {
              activeFootprint.packageKind = "bga";
              activeFootprint.pads[0] = "999";
            }
            return Reflect.ownKeys(target);
          }
        });
      },
      resolveFootprint: (id) => {
        if (id !== "Resistor_SMD:R_0603_1608Metric") return base.resolveFootprint(id);
        footprintCalls += 1;
        activeFootprint = base.resolveFootprint(id)!;
        return activeFootprint;
      }
    };
    const result = compile(ledDraft(), resolver);
    expect(result.disposition).toBe("ready");
    expect({ symbolCalls, footprintCalls, reflectionCalls }).toEqual({ symbolCalls: 1, footprintCalls: 1, reflectionCalls: 1 });
    expect(result.libraryBinding?.footprints.find((entry) => entry.reference === "R1")).toMatchObject({
      libraryId: "Resistor_SMD:R_0603_1608Metric",
      source: "kicad-stock",
      packageKind: "generic",
      pads: ["1", "2"]
    });
  });

  it.each([
    ["symbol null", "symbol", "null", "UNKNOWN_LIBRARY_ID"],
    ["symbol error", "symbol", "error", "INVALID_LIBRARY_RECORD"],
    ["footprint null", "footprint", "null", "UNKNOWN_LIBRARY_ID"],
    ["footprint error", "footprint", "error", "INVALID_LIBRARY_RECORD"]
  ] as const)("keeps resolver calls exact for %s", (_label, kind, failure, expectedCode) => {
    const base = makeResolver();
    const symbolCalls: string[] = [];
    const footprintCalls: string[] = [];
    const resolver: PcbReadOnlyLibraryResolver = {
      resolveSymbol: (id) => {
        symbolCalls.push(id);
        if (kind === "symbol" && id === "Device:R") {
          if (failure === "error") throw new Error("symbol resolver secret");
          return null;
        }
        return base.resolveSymbol(id);
      },
      resolveFootprint: (id) => {
        footprintCalls.push(id);
        if (kind === "footprint" && id === "Resistor_SMD:R_0603_1608Metric") {
          if (failure === "error") throw new Error("footprint resolver secret");
          return null;
        }
        return base.resolveFootprint(id);
      }
    };
    const draft = ledDraft();
    const result = compile(draft, resolver);
    const path = kind === "symbol" ? "component.R1.symbolLibId" : "component.R1.footprintLibId";
    expect(result.disposition).toBe("needs_clarification");
    expect(result.libraryBinding).toBeNull();
    expect(result.issues.filter((entry) => entry.path === path && entry.code === expectedCode)).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("resolver secret");
    expect(symbolCalls).toHaveLength(draft.components.length);
    expect(footprintCalls).toHaveLength(draft.components.length);
    expect(new Set(symbolCalls).size).toBe(symbolCalls.length);
    expect(new Set(footprintCalls).size).toBe(footprintCalls.length);
  });

  it("maps resolver reflection traps to one redacted invalid-record finding", () => {
    const base = makeResolver();
    const secret = "resolver-secret C:/private/library";
    const factories: readonly ((record: object) => object)[] = [
      (record) => new Proxy(record, { getPrototypeOf: () => { throw new Error(secret); } }),
      (record) => new Proxy(record, { ownKeys: () => { throw new Error(secret); } }),
      (record) => new Proxy(record, { getOwnPropertyDescriptor: () => { throw new Error(secret); } })
    ];
    for (const kind of ["symbol", "footprint"] as const) for (const factory of factories) {
      const resolver: PcbReadOnlyLibraryResolver = {
        resolveSymbol: (id) => {
          const record = base.resolveSymbol(id);
          return kind === "symbol" && id === "Device:R" && record !== null
            ? factory(record) as PcbResolvedSymbol
            : record;
        },
        resolveFootprint: (id) => {
          const record = base.resolveFootprint(id);
          return kind === "footprint" && id === "Resistor_SMD:R_0603_1608Metric" && record !== null
            ? factory(record) as PcbResolvedFootprint
            : record;
        }
      };
      const result = compile(ledDraft(), resolver);
      const path = kind === "symbol" ? "component.R1.symbolLibId" : "component.R1.footprintLibId";
      expect(result.disposition).toBe("needs_clarification");
      expect(result.libraryBinding).toBeNull();
      expect(result.issues.filter((entry) => entry.path === path && entry.code === "INVALID_LIBRARY_RECORD")).toHaveLength(1);
      expect(result.issues.some((entry) => entry.path === path && entry.code === "UNKNOWN_LIBRARY_ID")).toBe(false);
      expect(JSON.stringify(result)).not.toContain(secret);
    }

    expect(normalizePcbResolvedSymbol(
      factories[0]!(base.resolveSymbol("Device:R")!) as PcbResolvedSymbol,
      "Device:R"
    )).toBeNull();
    expect(normalizePcbResolvedFootprint(
      factories[1]!(base.resolveFootprint("Resistor_SMD:R_0603_1608Metric")!) as PcbResolvedFootprint,
      "Resistor_SMD:R_0603_1608Metric"
    )).toBeNull();
  });

  it("rejects resolver accessors and toJSON functions without invoking them", () => {
    const base = makeResolver();
    let activeCalls = 0;
    const symbolAccessor = { ...base.resolveSymbol("Device:R")! } as Record<string, unknown>;
    Object.defineProperty(symbolAccessor, "source", {
      enumerable: true,
      get: () => { activeCalls += 1; return "kicad-stock"; }
    });
    const symbolToJson: any = { ...base.resolveSymbol("Device:R")! };
    symbolToJson.toJSON = () => { activeCalls += 1; return {}; };
    const symbolPinAccessor: any = {
      ...base.resolveSymbol("Device:R")!,
      pins: base.resolveSymbol("Device:R")!.pins.map((pin) => ({ ...pin }))
    };
    Object.defineProperty(symbolPinAccessor.pins[0], "function", {
      enumerable: true,
      get: () => { activeCalls += 1; return "Terminal"; }
    });

    const footprintAccessor = { ...base.resolveFootprint("Resistor_SMD:R_0603_1608Metric")! } as Record<string, unknown>;
    Object.defineProperty(footprintAccessor, "packageKind", {
      enumerable: true,
      get: () => { activeCalls += 1; return "generic"; }
    });
    const footprintToJson: any = { ...base.resolveFootprint("Resistor_SMD:R_0603_1608Metric")! };
    footprintToJson.toJSON = () => { activeCalls += 1; return {}; };
    const footprintPadAccessor: any = {
      ...base.resolveFootprint("Resistor_SMD:R_0603_1608Metric")!,
      pads: ["1", "2"]
    };
    Object.defineProperty(footprintPadAccessor.pads, "0", {
      enumerable: true,
      get: () => { activeCalls += 1; return "1"; }
    });

    const symbolResults = [symbolAccessor, symbolToJson, symbolPinAccessor].map((candidate) => compile(ledDraft(), {
      ...base,
      resolveSymbol: (id) => id === "Device:R" ? candidate as PcbResolvedSymbol : base.resolveSymbol(id)
    }));
    const footprintResults = [footprintAccessor, footprintToJson, footprintPadAccessor].map((candidate) => compile(ledDraft(), {
      ...base,
      resolveFootprint: (id) => id === "Resistor_SMD:R_0603_1608Metric"
        ? candidate as PcbResolvedFootprint
        : base.resolveFootprint(id)
    }));
    expect(activeCalls).toBe(0);
    for (const result of [...symbolResults, ...footprintResults]) {
      expect(result.disposition).toBe("needs_clarification");
      expect(result.libraryBinding).toBeNull();
      expect(result.issues.some((entry) => entry.code === "INVALID_LIBRARY_RECORD")).toBe(true);
    }
  });

  it.each(["alias", "cycle", "oversize"] as const)(
    "rejects %s resolver graphs within the per-record boundary",
    (failure) => {
      const base = makeResolver();
      const resolver: PcbReadOnlyLibraryResolver = {
        resolveSymbol: (id) => {
          const original = base.resolveSymbol(id);
          if (id !== "Device:R" || original === null) return original;
          if (failure === "alias") {
            const shared = { number: "1", function: "Terminal" };
            return { ...original, pins: [shared, shared] };
          }
          if (failure === "cycle") {
            const cyclic: any = { ...original, pins: original.pins.map((pin) => ({ ...pin })) };
            cyclic.pins[0].function = cyclic;
            return cyclic;
          }
          return {
            ...original,
            pins: [
              { number: "1", function: "x".repeat(PCB_LIBRARY_RESOLVER_OUTPUT_LIMITS.maxRecordBytes + 1) },
              { number: "2", function: "Terminal" }
            ]
          };
        },
        resolveFootprint: (id) => {
          const original = base.resolveFootprint(id);
          if (id !== "Resistor_SMD:R_0603_1608Metric" || original === null) return original;
          if (failure === "alias") {
            const shared = { pad: "1" };
            return { ...original, pads: [shared, shared] as unknown as string[] };
          }
          if (failure === "cycle") {
            const cyclic: any = { ...original, pads: [...original.pads] };
            cyclic.pads[0] = cyclic;
            return cyclic;
          }
          return { ...original, pads: ["x".repeat(PCB_LIBRARY_RESOLVER_OUTPUT_LIMITS.maxRecordBytes + 1), "2"] };
        }
      };
      const result = compile(ledDraft(), resolver);
      expect(result.disposition).toBe("needs_clarification");
      expect(result.libraryBinding).toBeNull();
      expect(result.issues.filter((entry) =>
        entry.code === "INVALID_LIBRARY_RECORD" && entry.path.startsWith("component.R1.")
      )).toHaveLength(2);
    }
  );

  it("calls each resolver method exactly once per fully named component without retrying failures", () => {
    const base = makeResolver();
    const symbolCalls: string[] = [];
    const footprintCalls: string[] = [];
    const resolver: PcbReadOnlyLibraryResolver = {
      resolveSymbol: (id) => {
        symbolCalls.push(id);
        if (id === "Device:R") return new Proxy(base.resolveSymbol(id)!, { ownKeys: () => { throw new Error("once"); } });
        return base.resolveSymbol(id);
      },
      resolveFootprint: (id) => {
        footprintCalls.push(id);
        return base.resolveFootprint(id);
      }
    };
    const draft = ledDraft();
    const result = compile(draft, resolver);
    expect(result.disposition).toBe("needs_clarification");
    expect(symbolCalls).toHaveLength(draft.components.length);
    expect(footprintCalls).toHaveLength(draft.components.length);
    expect(new Set(symbolCalls).size).toBe(symbolCalls.length);
    expect(new Set(footprintCalls).size).toBe(footprintCalls.length);
  });

  it("strictly bounds resolver pin/pad counts, identifiers, functions, and record keys", () => {
    const base = makeResolver();
    const scenarios: readonly PcbReadOnlyLibraryResolver[] = [
      {
        ...base,
        resolveSymbol: (id) => id === "Device:R"
          ? { ...base.resolveSymbol(id)!, pins: Array.from({ length: PCB_LIBRARY_RESOLVER_OUTPUT_LIMITS.maxPinsOrPads + 1 }, (_, index) => ({ number: String(index + 1), function: "pin" })) }
          : base.resolveSymbol(id)
      },
      {
        ...base,
        resolveFootprint: (id) => id === "Resistor_SMD:R_0603_1608Metric"
          ? { ...base.resolveFootprint(id)!, pads: Array.from({ length: PCB_LIBRARY_RESOLVER_OUTPUT_LIMITS.maxPinsOrPads + 1 }, (_, index) => String(index + 1)) }
          : base.resolveFootprint(id)
      },
      {
        ...base,
        resolveSymbol: (id) => id === "Device:R"
          ? { ...base.resolveSymbol(id)!, pins: [{ number: "1", function: "x".repeat(PCB_LIBRARY_RESOLVER_OUTPUT_LIMITS.maxPinFunctionChars + 1) }, { number: "2", function: "pin" }] }
          : base.resolveSymbol(id)
      },
      {
        ...base,
        resolveFootprint: (id) => id === "Resistor_SMD:R_0603_1608Metric"
          ? { ...base.resolveFootprint(id)!, pads: ["1", "bad pad"] }
          : base.resolveFootprint(id)
      },
      {
        ...base,
        resolveSymbol: (id) => id === "Device:R"
          ? { ...base.resolveSymbol(id)!, unexpected: true } as PcbResolvedSymbol
          : base.resolveSymbol(id)
      }
    ];
    for (const resolver of scenarios) {
      const result = compile(ledDraft(), resolver);
      expect(result.disposition).toBe("needs_clarification");
      expect(result.issues.some((entry) => entry.code === "INVALID_LIBRARY_RECORD")).toBe(true);
      expect(result.libraryBinding).toBeNull();
    }
  });

  it("rejects a resolver projection whose exact canonical bytes exceed the aggregate bound", () => {
    const base = makeResolver();
    const resolver: PcbReadOnlyLibraryResolver = {
      resolveSymbol: (id) => {
        const original = base.resolveSymbol(id);
        if (original === null) return null;
        return {
          ...original,
          pins: Array.from({ length: PCB_LIBRARY_RESOLVER_OUTPUT_LIMITS.maxPinsOrPads }, (_, index) => ({
            number: String(index + 1),
            function: "f".repeat(PCB_LIBRARY_RESOLVER_OUTPUT_LIMITS.maxPinFunctionChars)
          }))
        };
      },
      resolveFootprint: (id) => {
        const original = base.resolveFootprint(id);
        return original === null
          ? null
          : { ...original, pads: Array.from({ length: PCB_LIBRARY_RESOLVER_OUTPUT_LIMITS.maxPinsOrPads }, (_, index) => String(index + 1)) };
      }
    };
    const result = compile(ledDraft(), resolver);
    expect(result.disposition).toBe("needs_clarification");
    expect(result.issues.some((entry) =>
      entry.path === "libraryBinding"
      && entry.message.includes(String(PCB_LIBRARY_RESOLVER_OUTPUT_LIMITS.maxBindingProjectionBytes))
    )).toBe(true);
    expect(result.libraryBinding).toBeNull();
  });
});
