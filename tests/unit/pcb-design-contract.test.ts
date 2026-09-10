import { describe, expect, it } from "vitest";
import {
  PCB_DESIGN_CONTRACT_LIMITS,
  PCB_DESIGN_CONTRACT_SCHEMA_VERSION,
  PCB_DESIGN_INTENT_DRAFT_SCHEMA_VERSION,
  PcbDesignContractError,
  closePcbDesignIntentDraft,
  normalizePcbDesignUnresolvedPath,
  parsePcbDesignContract,
  parsePcbDesignIntentDraft,
  pcbDesignContractIdentity,
  pcbDesignContractSchema,
  pcbDesignIntentDraftSchema,
  pcbDesignStablePathSchema
} from "../../src/harness/pcb-design-contract.js";
import { createFreshConnectivityContract } from "../../src/harness/fresh-connectivity-contract.js";
import { parseFreshNetlistSource } from "../../src/harness/fresh-kicad-parser.js";
import { freshConnectivityReadbackIssues, freshNativeNetlistParityIssues } from "../../src/harness/kicad-tools.js";

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

const placement = (reference: string, edgePreference: "none" | "top" | "right" | "bottom" | "left" = "none") => ({
  reference,
  side: "front",
  regionMm: { minXmm: 1, maxXmm: 29, minYmm: 1, maxYmm: 19 },
  allowedRotationsDeg: [0, 90, 180, 270],
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
    board: {
      shape: "rectangle",
      widthMm: 30,
      heightMm: 20,
      layerCount: 2,
      copperLayers: ["F.Cu", "B.Cu"]
    }
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
      endpoints: [
        { reference: "R1", pin: "2" },
        { reference: "D1", pin: "2" }
      ],
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
  placementConstraints: [placement("J1", "left"), placement("R1"), placement("D1"), placement("C1")],
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
        { pin: "3", assignment: { kind: "net", net: "GND" } },
        { pin: "MP", assignment: { kind: "no_connect" } }
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
  placementConstraints: [placement("R1"), placement("R2"), placement("J1", "left")],
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

const clone = <Value>(value: Value): Value => structuredClone(value);
const nativeNode = (reference: string, pin: string, pinType = "passive"): string => `(node (ref "${reference}") (pin "${pin}") (pintype "${pinType}"))`;
const nativeComponent = (reference: string, value: string, footprint: string, library: string, part: string): string =>
  `(comp (ref "${reference}") (value "${value}") (footprint "${footprint}") (libsource (lib "${library}") (part "${part}")))`;
const dividerNativeNetlist = (noConnectName = "unconnected-(J1-NC-PadMP)", noConnectNodes = nativeNode("J1", "MP", "passive+no_connect")): string => `(export
  (components
    ${nativeComponent("J1", "DIVIDER_IO", "Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical", "Connector_Generic", "Conn_01x03")}
    ${nativeComponent("R1", "10k", "Resistor_SMD:R_0603_1608Metric", "Device", "R")}
    ${nativeComponent("R2", "10k", "Resistor_SMD:R_0603_1608Metric", "Device", "R")})
  (nets
    (net (code "1") (name "GND") ${nativeNode("J1", "3")} ${nativeNode("R2", "2")})
    (net (code "2") (name "VIN") ${nativeNode("J1", "1")} ${nativeNode("R1", "1")})
    (net (code "3") (name "VOUT") ${nativeNode("J1", "2")} ${nativeNode("R1", "2")} ${nativeNode("R2", "1")})
    (net (code "4") (name "${noConnectName}") ${noConnectNodes})))`;

describe("PCB design contract v1", () => {
  it("closes a fully specified LED board and freezes its canonical identity", () => {
    const contract = closePcbDesignIntentDraft(ledDraft());
    expect(contract.schemaVersion).toBe(PCB_DESIGN_CONTRACT_SCHEMA_VERSION);
    expect(contract.identity).toMatchObject({
      algorithm: "sha256",
      schemaVersion: PCB_DESIGN_CONTRACT_SCHEMA_VERSION,
      canonicalizationVersion: "evleda-c14n-json-v1"
    });
    expect(contract.identity.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(contract.components.map((entry) => entry.reference)).toEqual(["C1", "D1", "J1", "R1"]);
    expect(Object.isFrozen(contract)).toBe(true);
    expect(parsePcbDesignContract(contract)).toEqual(contract);
  });

  it("supports a resistor divider with an explicit no-connect and bounded vias", () => {
    const contract = closePcbDesignIntentDraft(dividerDraft());
    expect(contract.components.find((entry) => entry.reference === "J1")?.pins.at(-1)?.assignment).toEqual({ kind: "no_connect" });
    expect(contract.routingConstraints.viaPolicy).toMatchObject({ mode: "bounded", maxTotal: 3 });
    expect(contract.nets.find((entry) => entry.name === "VOUT")?.endpoints).toHaveLength(3);
    const connectivity = createFreshConnectivityContract(contract);
    expect(connectivity.sourceContractIdentity).toEqual(contract.identity);
    expect(connectivity.noConnects).toEqual([{ reference: "J1", pin: "MP" }]);
    expect(connectivity.nets.find((entry) => entry.name === "VOUT")?.endpoints).toEqual([
      { reference: "J1", pin: "2" }, { reference: "R1", pin: "2" }, { reference: "R2", pin: "1" },
    ]);
    expect(Object.isFrozen(connectivity)).toBe(true);
    expect(freshNativeNetlistParityIssues(connectivity, dividerNativeNetlist())).toEqual([]);
    expect(freshNativeNetlistParityIssues(connectivity, dividerNativeNetlist().replace('(value "10k")', '(value "11k")'))).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "NATIVE_COMPONENT_IDENTITY_PARITY_MISMATCH" }),
    ]));
    const functionalGroups = [
      { name: "GND", endpoints: ["J1:3", "R2:2"] },
      { name: "VIN", endpoints: ["J1:1", "R1:1"] },
      { name: "VOUT", endpoints: ["J1:2", "R1:2", "R2:1"] },
    ].map((group, index) => `Group ${index + 1}: ${group.name} | pins=${group.endpoints.join(", ")}`).join("\n");
    expect(freshConnectivityReadbackIssues(connectivity, `${functionalGroups}\nGroup 4: ~no-connect | pins=J1:MP`)).toEqual([]);
    expect(freshConnectivityReadbackIssues(connectivity, `${functionalGroups}\nGroup 4: ~unnamed | pins=J1:MP`)).toEqual(expect.arrayContaining([expect.objectContaining({ code: "NO_CONNECT_GROUP_MISMATCH" })]));
    expect(freshConnectivityReadbackIssues(connectivity, functionalGroups)).toEqual(expect.arrayContaining([expect.objectContaining({ code: "NO_CONNECT_GROUP_MISMATCH" })]));
    expect(freshConnectivityReadbackIssues(connectivity, `${functionalGroups}\nGroup 4: ~no-connect | pins=J1:MP\nGroup 5: ~no-connect | pins=R1:9`)).toEqual(expect.arrayContaining([expect.objectContaining({ code: "EXTRA_OR_DUPLICATE_NO_CONNECT_GROUP" })]));
    expect(freshNativeNetlistParityIssues(connectivity, dividerNativeNetlist("NC_FAKE"))).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "NATIVE_NET_NAME_PARITY_MISMATCH" }),
      expect.objectContaining({ code: "NATIVE_NO_CONNECT_PARITY_MISMATCH" }),
    ]));
    expect(freshNativeNetlistParityIssues(connectivity, dividerNativeNetlist("unconnected-(J1-NC-PadMP)", `${nativeNode("J1", "MP", "passive+no_connect")} ${nativeNode("J1", "MP2", "passive+no_connect")}`))).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "NATIVE_NET_NAME_PARITY_MISMATCH" }),
      expect.objectContaining({ code: "NATIVE_NO_CONNECT_PARITY_MISMATCH" }),
    ]));
  });

  it("retains real KiCad singleton no-connect pin semantics", async () => {
    const source = await readFile(path.resolve("reference-designs/robotics-controller-v0/validation/runs/20260905T041400.496613Z-8b7f124253b42c31/outputs/schematic-netlist.kicad_net"), "utf8");
    const parsed = parseFreshNetlistSource(source);
    expect(parsed.nets.find((net) => net.name === "unconnected-(J2-Pin_6-Pad6)")).toMatchObject({
      nodes: [{ reference: "J2", pin: "6", pinType: "passive+no_connect" }],
    });
  });

  it("normalizes semantic array permutations to the same contract and identity", () => {
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
    second.placementConstraints.forEach((constraint) => constraint.allowedRotationsDeg.reverse());
    second.routingConstraints.nets.reverse();
    expect(closePcbDesignIntentDraft(second)).toEqual(closePcbDesignIntentDraft(first));
  });

  it.each([
    ["component reference", (draft: ReturnType<typeof ledDraft>) => draft.components.push(clone(draft.components[0]!))],
    ["pin", (draft: ReturnType<typeof ledDraft>) => draft.components[0]!.pins.push(clone(draft.components[0]!.pins[0]!))],
    ["net name", (draft: ReturnType<typeof ledDraft>) => draft.nets.push(clone(draft.nets[0]!))],
    ["net-class ID", (draft: ReturnType<typeof ledDraft>) => draft.netClasses.push(clone(draft.netClasses[0]!))],
    ["placement reference", (draft: ReturnType<typeof ledDraft>) => draft.placementConstraints.push(clone(draft.placementConstraints[0]!))],
    ["routing-net constraint", (draft: ReturnType<typeof ledDraft>) => draft.routingConstraints.nets.push(clone(draft.routingConstraints.nets[0]!))]
  ])("rejects duplicate %s", (_label, mutate) => {
    const draft = ledDraft();
    mutate(draft);
    expect(() => parsePcbDesignIntentDraft(draft)).toThrow(/Duplicate/u);
  });

  it("rejects missing, unknown, and asymmetric pin/net references", () => {
    const missingEndpoint = ledDraft();
    missingEndpoint.nets[0]!.endpoints.pop();
    expect(() => parsePcbDesignIntentDraft(missingEndpoint)).toThrow(/assignment is missing/u);

    const unknownEndpoint = ledDraft();
    unknownEndpoint.nets[0]!.endpoints[0] = { reference: "U99", pin: "1" };
    expect(() => parsePcbDesignIntentDraft(unknownEndpoint)).toThrow(/unknown endpoint/u);

    const asymmetric = ledDraft();
    asymmetric.nets[0]!.endpoints[0] = { reference: "J1", pin: "2" };
    expect(() => parsePcbDesignIntentDraft(asymmetric)).toThrow(/asymmetric|both/u);

    const missingNet = ledDraft();
    missingNet.components[0]!.pins[0]!.assignment = { kind: "net", net: "MISSING" };
    expect(() => parsePcbDesignIntentDraft(missingNet)).toThrow(/unknown net/u);
  });

  it("rejects missing classes and route/class layer contradictions", () => {
    const missingClass = ledDraft();
    missingClass.nets[0]!.netClassId = "UNKNOWN";
    expect(() => parsePcbDesignIntentDraft(missingClass)).toThrow(/unknown net class/u);

    const wrongLayer = ledDraft();
    wrongLayer.routingConstraints.nets[0]!.preferredLayer = "B.Cu";
    expect(() => parsePcbDesignIntentDraft(wrongLayer)).toThrow(/layer forbidden/u);
  });

  it("keeps unresolved drafts structurally separate from closed contracts", () => {
    const unresolved: any = ledDraft();
    const unresolvedLed = unresolved.components.find((component: any) => component.reference === "D1");
    unresolvedLed.footprintLibId = null;
    unresolvedLed.pins.find((pin: any) => pin.pin === "2").assignment = { kind: "unresolved", question: "Which LED pin is the anode?" };
    unresolved.nets.find((net: any) => net.name === "LED_A").endpoints = [{ reference: "R1", pin: "2" }];
    unresolved.unresolved.push(
      { path: "/components/D1/footprintLibId", question: "Choose an available LED footprint." },
      { path: "/components/D1/pins/2/assignment", question: "Resolve the anode mapping from the selected symbol." }
    );
    const draft = parsePcbDesignIntentDraft(unresolved);
    expect(draft.unresolved).toHaveLength(2);
    expect(() => closePcbDesignIntentDraft(draft)).toThrow(PcbDesignContractError);
    try {
      closePcbDesignIntentDraft(draft);
    } catch (error) {
      expect(error).toMatchObject({ code: "UNRESOLVED_DRAFT" });
    }
    expect(pcbDesignContractSchema.safeParse(draft).success).toBe(false);
    const closed = closePcbDesignIntentDraft(ledDraft());
    expect(pcbDesignIntentDraftSchema.safeParse(closed).success).toBe(false);
  });

  it("rejects a net endpoint whose corresponding draft pin disposition is unresolved", () => {
    const unresolved: any = ledDraft();
    unresolved.components.find((component: any) => component.reference === "D1").pins
      .find((pin: any) => pin.pin === "2").assignment = {
        kind: "unresolved",
        question: "Which pin is the anode?"
      };
    unresolved.unresolved.push({
      path: "/components/D1/pins/2/assignment",
      question: "Resolve the anode mapping."
    });
    expect(() => parsePcbDesignIntentDraft(unresolved)).toThrow(/asymmetric with its pin assignment/u);
  });

  it.each([
    ["multiple sheets", (draft: any) => { draft.scope.sheetCount = 2; }],
    ["multi-unit symbols", (draft: any) => { draft.components[0].unit = 2; }],
    ["non-rectangular boards", (draft: any) => { draft.scope.board.shape = "circle"; }],
    ["more than two layers", (draft: any) => { draft.scope.board.layerCount = 4; }],
    ["90-degree routing", (draft: any) => { draft.routingConstraints.maximumTurnAngleDeg = 90; }],
    ["right-angle permission", (draft: any) => { draft.routingConstraints.allowRightAngleCorners = true; }]
  ])("rejects unsupported v1 feature: %s", (_label, mutate) => {
    const draft: any = ledDraft();
    mutate(draft);
    expect(() => parsePcbDesignIntentDraft(draft)).toThrow(/Invalid PCB design intent draft/u);
  });

  it("preserves a requested back-side placement in a draft but cannot close it as v1", () => {
    const draft = ledDraft();
    draft.placementConstraints[0]!.side = "back";
    const parsed = parsePcbDesignIntentDraft(draft);
    expect(parsed.placementConstraints.find((entry) => entry.reference === "J1")?.side).toBe("back");
    expect(() => closePcbDesignIntentDraft(parsed)).toThrow(/expected "front"/u);
  });

  it("enforces electrical, geometric, via, and board numeric relationships", () => {
    const electrical = ledDraft();
    electrical.nets[0]!.electrical.current.peakA = 0.01;
    expect(() => parsePcbDesignIntentDraft(electrical)).toThrow(/nominal <= continuous maximum <= peak/u);

    const region = ledDraft();
    region.placementConstraints[0]!.regionMm.maxXmm = 31;
    expect(() => parsePcbDesignIntentDraft(region)).toThrow(/exceeds board width/u);

    const annularRing = dividerDraft();
    annularRing.routingConstraints.viaPolicy = {
      mode: "bounded",
      maxTotal: 2,
      diameterMm: 0.4,
      drillMm: 0.3,
      minimumAnnularRingMm: 0.1
    };
    expect(() => parsePcbDesignIntentDraft(annularRing)).toThrow(/annular ring/u);

    const board = ledDraft();
    board.scope.board.widthMm = 501;
    expect(() => parsePcbDesignIntentDraft(board)).toThrow(/<=500/u);
  });

  it("treats bounded-via maxTotal as a global budget across per-net maxima", () => {
    const overcommitted = dividerDraft();
    overcommitted.routingConstraints.viaPolicy.maxTotal = 2;
    expect(() => parsePcbDesignIntentDraft(overcommitted)).toThrow(
      /Sum of per-net via maxima \(3\) exceeds global maxTotal \(2\)/u
    );
  });

  it("requires exactly one placement and routing constraint per closed component/net", () => {
    const missingPlacement = ledDraft();
    missingPlacement.placementConstraints.pop();
    expect(() => closePcbDesignIntentDraft(missingPlacement)).toThrow(/missing a placement constraint/u);

    const missingRoute = ledDraft();
    missingRoute.routingConstraints.nets.pop();
    expect(() => closePcbDesignIntentDraft(missingRoute)).toThrow(/missing a routing constraint/u);
  });

  it("rejects noncanonical closed artifacts and identity tampering", () => {
    const contract: any = clone(closePcbDesignIntentDraft(ledDraft()));
    contract.components.reverse();
    expect(() => parsePcbDesignContract(contract)).toThrow(/canonical array order/u);

    const tampered: any = clone(closePcbDesignIntentDraft(ledDraft()));
    tampered.identity.digest = "0".repeat(64);
    expect(() => parsePcbDesignContract(tampered)).toThrow(/identity does not reproduce/u);
  });

  it("validates and canonicalizes payloads before exposing their identity", () => {
    const contract = closePcbDesignIntentDraft(dividerDraft());
    const { identity: _identity, ...payload } = clone(contract);
    const permuted: any = clone(payload);
    permuted.components.reverse();
    permuted.components.forEach((component: any) => component.pins.reverse());
    permuted.nets.reverse();
    permuted.nets.forEach((net: any) => net.endpoints.reverse());
    permuted.routingConstraints.nets.reverse();
    expect(pcbDesignContractIdentity(permuted)).toEqual(contract.identity);

    permuted.nets[0].endpoints[0] = { reference: "U404", pin: "1" };
    expect(() => pcbDesignContractIdentity(permuted)).toThrow(/Cannot identify an invalid/u);
  });

  it("deep-freezes every nested collection and object returned by the closed parser", () => {
    const contract = closePcbDesignIntentDraft(ledDraft());
    expect(Object.isFrozen(contract.components)).toBe(true);
    expect(Object.isFrozen(contract.components[0])).toBe(true);
    expect(Object.isFrozen(contract.components[0]!.pins)).toBe(true);
    expect(Object.isFrozen(contract.components[0]!.pins[0]!.assignment)).toBe(true);
    expect(Object.isFrozen(contract.routingConstraints.viaPolicy)).toBe(true);
    expect(Object.isFrozen(contract.identity)).toBe(true);
    const originalDigest = contract.identity.digest;
    expect(() => (contract.components as any[]).reverse()).toThrow(TypeError);
    expect(() => { (contract.routingConstraints as any).maximumTurnAngleDeg = 90; }).toThrow(TypeError);
    expect(contract.identity.digest).toBe(originalDigest);
    expect(contract.routingConstraints.maximumTurnAngleDeg).toBe(45);
  });

  it("rejects unknown fields before they can become mutation instructions", () => {
    const draft: any = ledDraft();
    draft.shellCommand = "do something outside KiCad";
    expect(() => parsePcbDesignIntentDraft(draft)).toThrow(/Unrecognized key/u);
  });

  it("enforces maximum collection counts", () => {
    const draft: any = ledDraft();
    draft.components = Array.from({ length: PCB_DESIGN_CONTRACT_LIMITS.maxComponents + 1 }, (_, index) => ({
      reference: `X${index + 1}`,
      symbolLibId: "Device:R",
      value: "1k",
      footprintLibId: "Resistor_SMD:R_0603_1608Metric",
      unit: 1,
      pins: [{ pin: "1", assignment: { kind: "no_connect" as const } }]
    }));
    expect(() => parsePcbDesignIntentDraft(draft)).toThrow(/Too big/u);
  });

  it("rejects an otherwise bounded-shape payload before parsing when its JSON bytes exceed the hard limit", () => {
    const draft: any = ledDraft();
    draft.components = Array.from({ length: PCB_DESIGN_CONTRACT_LIMITS.maxComponents }, (_, componentIndex) => ({
      reference: `X${componentIndex + 1}`,
      symbolLibId: "Device:R",
      value: "x".repeat(192),
      footprintLibId: "Resistor_SMD:R_0603_1608Metric",
      unit: 1,
      pins: Array.from({ length: PCB_DESIGN_CONTRACT_LIMITS.maxPinsPerComponent }, (_, pinIndex) => ({
        pin: String(pinIndex + 1),
        assignment: { kind: "no_connect" }
      }))
    }));
    expect(() => parsePcbDesignIntentDraft(draft)).toThrow(/limit is 262144/u);
  });

  it("captures one descriptor-backed view without invoking getters or toJSON", () => {
    let getterCalls = 0;
    const accessorDraft = ledDraft() as any;
    const scope = accessorDraft.scope;
    Object.defineProperty(accessorDraft, "scope", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return scope;
      }
    });
    expect(() => parsePcbDesignIntentDraft(accessorDraft)).toThrow(
      expect.objectContaining({ code: "INVALID_DRAFT" })
    );
    expect(getterCalls).toBe(0);

    let liveReads = 0;
    const proxyDraft = new Proxy(ledDraft(), {
      get: (target, property, receiver) => {
        liveReads += 1;
        return Reflect.get(target, property, receiver) as unknown;
      }
    });
    expect(parsePcbDesignIntentDraft(proxyDraft).kind).toBe("pcb_design_intent_draft");
    expect(liveReads).toBe(0);

    let toJsonCalls = 0;
    const oversized: any = ledDraft();
    oversized.components = Array.from({ length: PCB_DESIGN_CONTRACT_LIMITS.maxComponents }, (_, componentIndex) => ({
      reference: `X${componentIndex + 1}`,
      symbolLibId: "Device:R",
      value: "x".repeat(192),
      footprintLibId: "Resistor_SMD:R_0603_1608Metric",
      unit: 1,
      pins: Array.from({ length: PCB_DESIGN_CONTRACT_LIMITS.maxPinsPerComponent }, (_, pinIndex) => ({
        pin: String(pinIndex + 1), assignment: { kind: "no_connect" }
      }))
    }));
    oversized.toJSON = () => { toJsonCalls += 1; return {}; };
    expect(() => parsePcbDesignIntentDraft(oversized)).toThrow(
      expect.objectContaining({ code: "PAYLOAD_TOO_LARGE" })
    );
    expect(toJsonCalls).toBe(0);
  });

  it("maps hostile snapshot failures to the correct draft or contract boundary code", () => {
    const sentinel = new Error("must-not-escape");
    const hostile = (): unknown => new Proxy({}, { ownKeys: () => { throw sentinel; } });
    for (const [operation, code] of [
      [() => parsePcbDesignIntentDraft(hostile()), "INVALID_DRAFT"],
      [() => pcbDesignContractIdentity(hostile()), "INVALID_CONTRACT"],
      [() => parsePcbDesignContract(hostile()), "INVALID_CONTRACT"]
    ] as const) {
      let caught: unknown;
      try { operation(); } catch (error) { caught = error; }
      expect(caught).toMatchObject({ code });
      expect((caught as Error).message).not.toContain(sentinel.message);
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => parsePcbDesignIntentDraft(cyclic)).toThrow(expect.objectContaining({ code: "INVALID_DRAFT" }));
    expect(() => pcbDesignContractIdentity(cyclic)).toThrow(expect.objectContaining({ code: "INVALID_CONTRACT" }));
    expect(() => parsePcbDesignContract(1n)).toThrow(expect.objectContaining({ code: "INVALID_CONTRACT" }));
  });

  it.each([
    ["signed voltage", (draft: any) => { draft.nets[0].electrical.voltage.minimumV = -0; }],
    ["current", (draft: any) => { draft.nets[0].electrical.current.nominalA = -0; }],
    ["DC zero literal", (draft: any) => { draft.nets[0].electrical.speed.maximumFrequencyMHz = -0; }],
    ["rotation zero literal", (draft: any) => { draft.placementConstraints[0].allowedRotationsDeg[0] = -0; }],
    ["placement clearance", (draft: any) => { draft.placementConstraints[0].minimumEdgeClearanceMm = -0; }],
    ["routing geometry", (draft: any) => { draft.routingConstraints.minimumStraightBeforeTurnMm = -0; }],
    ["per-net via count", (draft: any) => { draft.routingConstraints.nets[0].maxVias = -0; }],
    ["forbidden-via total", (draft: any) => { draft.routingConstraints.viaPolicy.maxTotal = -0; }]
  ])("rejects negative zero in the %s contract field", (_label, mutate) => {
    const draft: any = ledDraft();
    mutate(draft);
    expect(() => parsePcbDesignIntentDraft(draft)).toThrow(/negative zero/u);
  });

  it("requires exactly two endpoints for a closed point-to-point net", () => {
    const draft: any = ledDraft();
    draft.routingConstraints.nets.find((entry: any) => entry.net === "VCC").topology = "point_to_point";
    expect(parsePcbDesignIntentDraft(draft).nets.find((entry) => entry.name === "VCC")?.endpoints).toHaveLength(3);
    expect(() => closePcbDesignIntentDraft(draft)).toThrow(/must have exactly 2 endpoints/u);

    const tree = closePcbDesignIntentDraft(ledDraft());
    const { identity: _identity, ...payload } = clone(tree) as any;
    payload.routingConstraints.nets.find((entry: any) => entry.net === "VCC").topology = "point_to_point";
    expect(() => pcbDesignContractIdentity(payload)).toThrow(/must have exactly 2 endpoints/u);
  });

  it.each(["+5V", "3V3", "-12V"])('round-trips the common safe net name "%s"', (name) => {
    const draft: any = ledDraft();
    for (const component of draft.components) for (const pin of component.pins) {
      if (pin.assignment.kind === "net" && pin.assignment.net === "VCC") pin.assignment.net = name;
    }
    draft.nets.find((entry: any) => entry.name === "VCC").name = name;
    draft.routingConstraints.nets.find((entry: any) => entry.net === "VCC").net = name;
    const contract = closePcbDesignIntentDraft(draft);
    expect(contract.nets.some((entry) => entry.name === name)).toBe(true);
    expect(parsePcbDesignContract(contract)).toEqual(contract);
  });

  it.each([
    "bad|net", "bad/net", "bad\\net", "bad:net", "bad,net", "bad net", "bad\nnet",
    "~no-connect", "~unnamed", "unconnected-(J1-Pin_1-Pad1)", "__proto__", "constructor"
  ])('rejects the unsafe or reserved net name "%s"', (name) => {
    const draft: any = ledDraft();
    for (const component of draft.components) for (const pin of component.pins) {
      if (pin.assignment.kind === "net" && pin.assignment.net === "VCC") pin.assignment.net = name;
    }
    draft.nets.find((entry: any) => entry.name === "VCC").name = name;
    draft.routingConstraints.nets.find((entry: any) => entry.net === "VCC").net = name;
    expect(() => parsePcbDesignIntentDraft(draft)).toThrow(/safe PCB net name|control|reserved/u);
  });

  it("strictly resolves and injectively normalizes EvlEDA semantic pointers", () => {
    const draft: any = ledDraft();
    const diode = draft.components.find((entry: any) => entry.reference === "D1");
    diode.pins.find((entry: any) => entry.pin === "1").pin = "A/B";
    diode.pins.find((entry: any) => entry.pin === "A/B").assignment = {
      kind: "unresolved", question: "Resolve the escaped pin."
    };
    const ground = draft.nets.find((entry: any) => entry.name === "GND");
    ground.endpoints = ground.endpoints.filter((entry: any) => entry.reference !== "D1");
    draft.unresolved = [{
      path: "/components/D1/pins/A~1B/assignment",
      question: "Resolve the escaped pin."
    }];
    const parsed = parsePcbDesignIntentDraft(draft);
    expect(normalizePcbDesignUnresolvedPath(parsed, parsed.unresolved[0]!.path)).toEqual({
      success: true,
      path: "component.D1.pin.A%002FB.assignment"
    });
    expect(pcbDesignStablePathSchema.safeParse("component.D1.pin.A%002FB.assignment").success).toBe(true);
    for (const malformed of [
      "/component/D1/value",
      "/components/0/value",
      "/components/D1/pins/1/assignment/",
      "/components/D1/pins/1//assignment",
      "/components/D1/pins/1/~",
      "/components/D1/pins/1/~2",
      "/constructor"
    ]) {
      const invalid: any = ledDraft();
      invalid.unresolved = [{ path: malformed, question: "Resolve it." }];
      expect(() => parsePcbDesignIntentDraft(invalid), malformed).toThrow(/Unresolved path|semantic-pointer|~0 and ~1/u);
    }
    expect(pcbDesignStablePathSchema.safeParse("component..D1").success).toBe(false);
    expect(pcbDesignStablePathSchema.safeParse("component.D1.%002f").success).toBe(false);
    expect(pcbDesignStablePathSchema.safeParse("component.%0041").success).toBe(false);
    expect(pcbDesignStablePathSchema.safeParse("component.%0000").success).toBe(false);
  });

  it("rejects ambiguous semantic selectors instead of coalescing colliding paths", () => {
    const draft: any = ledDraft();
    draft.components.push(clone(draft.components.find((entry: any) => entry.reference === "D1")));
    draft.unresolved = [{ path: "/components/D1/value", question: "Which D1 value?" }];
    expect(() => parsePcbDesignIntentDraft(draft)).toThrow(/ambiguous keyed collection entry/u);
  });

  it("preserves canonical-order and identity codes beyond formatted-issue truncation", () => {
    const identityOnly: any = clone(closePcbDesignIntentDraft(ledDraft()));
    const duplicateRoute = clone(identityOnly.routingConstraints.nets.find((entry: any) => entry.net === "LED_A"));
    for (let index = 0; index < PCB_DESIGN_CONTRACT_LIMITS.maxFormattedIssues + 4; index += 1) {
      identityOnly.routingConstraints.nets.push(clone(duplicateRoute));
    }
    identityOnly.routingConstraints.nets.sort((left: any, right: any) => left.net < right.net ? -1 : left.net > right.net ? 1 : 0);
    let identityError: unknown;
    try { parsePcbDesignContract(identityOnly); } catch (error) { identityError = error; }
    expect(identityError).toMatchObject({ code: "CONTRACT_IDENTITY_MISMATCH" });
    expect((identityError as Error).message).toContain("identity does not reproduce");

    const noncanonical = clone(identityOnly);
    noncanonical.components.reverse();
    let canonicalError: unknown;
    try { parsePcbDesignContract(noncanonical); } catch (error) { canonicalError = error; }
    expect(canonicalError).toMatchObject({ code: "NON_CANONICAL_CONTRACT" });
    expect((canonicalError as Error).message).toContain("canonical array order");
  });
});
import { readFile } from "node:fs/promises";
import path from "node:path";
