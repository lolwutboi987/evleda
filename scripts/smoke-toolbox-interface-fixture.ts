/** Synthetic interface proof inputs and pure assertions. Importing this file starts no native process. */
import assert from "node:assert/strict";
import { parsePcbPlaneDesignIntentDraft } from "../src/harness/pcb-design-plane-contract.js";
import { assessDifferentialPairGeometry, type DifferentialPairGeometryAssessment } from "../src/harness/differential-pair-geometry.js";

export const INTERFACE_FIXTURE_NAME = "interface-pair-software-fixture";
export const INTERFACE_FIXTURE_ID = "SYNTHETIC_PAIR";
export const INTERFACE_FIXTURE_SOURCE_SYMBOL = "Connector:Conn_01x03_Pin";
export const INTERFACE_FIXTURE_RECEIVER_SYMBOL = "Connector_Generic:Conn_01x03";
export const INTERFACE_FIXTURE_FOOTPRINT = "Connector_PinHeader_1.00mm:PinHeader_1x03_P1.00mm_Vertical_SMD_Pin1Left";
export const INTERFACE_FIXTURE_PROMPT = "Create a synthetic software-test differential interface between two stock three-pad SMD connectors. "
  + "The caller asserts all construction and electrical numbers solely to exercise saved geometry, native integration and a conditional analytical model. "
  + "This is not a real protocol board, measured stackup, qualified interface, or fabrication release. Keep the original 0.25 mm SIGNAL clearance and all bound requirements.";
export const INTERFACE_FIXTURE_MATERIAL = "Synthetic homogeneous software fixture dielectric";
const source = () => ({ kind: "caller_assertion", reference: "synthetic-interface-proof-rev-1",
  description: "Synthetic software fixture only. These declared numbers have no physical, protocol, datasheet, or manufacturing qualification." });
const endpoint = (reference: string, pin: string) => ({ reference, pin });

export function interfaceFixtureDraft() {
  const electrical = (ground: boolean) => ({ voltage: { minimumV: 0, nominalV: ground ? 0 : 1.65, maximumV: ground ? 0 : 3.3 },
    current: { nominalA: 0.001, maximumContinuousA: 0.001, peakA: 0.001, peakDurationMs: 1_000 },
    speed: ground ? { kind: "dc", maximumFrequencyMHz: 0, minimumEdgeTimeNs: null }
      : { kind: "signal", maximumFrequencyMHz: 100, minimumEdgeTimeNs: 2 } });
  const component = (reference: string) => ({ reference,
    symbolLibId: reference === "J1" ? INTERFACE_FIXTURE_SOURCE_SYMBOL : INTERFACE_FIXTURE_RECEIVER_SYMBOL, footprintLibId: INTERFACE_FIXTURE_FOOTPRINT,
    value: reference === "J1" ? "PAIR_SOURCE" : "PAIR_RX", unit: 1,
    pins: ["DP", "DN", "GND"].map((net, index) => ({ pin: String(index + 1), assignment: { kind: "net", net } })) });
  const route = (net: string, pin: string) => ({ net, topology: "point_to_point", preferredLayer: "F.Cu", maxVias: 0,
    routeLength: { mode: "bounded", maximumMm: 30 }, referencePath: { mode: "continuous_plane", planeId: "GND_PLANE",
      signalLayer: "F.Cu", coverageMarginMm: 0.5, layerTransitions: "forbidden", terminalReferences: ["J1", "J2"].map(reference => ({
        signalEndpoint: endpoint(reference, pin), referenceEndpoint: endpoint(reference, "3") })) } });
  return parsePcbPlaneDesignIntentDraft({ schemaVersion: "evleda.pcb-design-intent-draft.v2", kind: "pcb_design_intent_draft",
    scope: { sheetCount: 1, componentUnitPolicy: "single_unit", board: { shape: "rectangle", widthMm: 30, heightMm: 20,
      layerCount: 2, copperLayers: ["F.Cu", "B.Cu"] } }, components: [component("J1"), component("J2")],
    nets: ["DP", "DN", "GND"].map((name, index) => ({ name, role: name === "GND" ? "ground" : "interface",
      endpoints: [endpoint("J1", String(index + 1)), endpoint("J2", String(index + 1))],
      electrical: electrical(name === "GND"), netClassId: name === "GND" ? "GROUND" : "SIGNAL" })),
    netClasses: [{ id: "GROUND", traceWidthMm: 0.5, clearanceMm: 0.25, copperToEdgeMm: 0.5, allowedLayers: ["F.Cu", "B.Cu"] },
      { id: "SIGNAL", traceWidthMm: 0.4, clearanceMm: 0.25, copperToEdgeMm: 0.5, allowedLayers: ["F.Cu"] }],
    placementConstraints: ["J1", "J2"].map(reference => ({ reference, side: "front", regionMm: { minXmm: 1, maxXmm: 29, minYmm: 1, maxYmm: 19 },
      allowedRotationsDeg: [0], minimumEdgeClearanceMm: 1, minimumCourtyardClearanceMm: 0.25, edgePreference: reference === "J1" ? "left" : "right" })),
    routingConstraints: { cornerStyle: "miter_45", maximumTurnAngleDeg: 45, minimumStraightBeforeTurnMm: 0.2,
      allowRightAngleCorners: false, allowAcuteInteriorCorners: false, allowBacktracking: false, allowSelfIntersections: false,
      viaPolicy: { mode: "bounded", maxTotal: 2, diameterMm: 0.6, drillMm: 0.3, minimumAnnularRingMm: 0.15 },
      nets: [route("DP", "1"), route("DN", "2"), { net: "GND", topology: "plane", planeId: "GND_PLANE",
        accessRouting: { preferredLayer: "F.Cu", maxVias: 2, routeLength: { mode: "bounded", maximumMm: 10 } } }] },
    planes: [{ id: "GND_PLANE", net: "GND", layer: "B.Cu", boundary: { kind: "rectangle", minXmm: 0.5, minYmm: 0.5, maxXmm: 29.5, maxYmm: 19.5 },
      clearanceMm: 0.25, minimumCopperWidthMm: 0.5, copperFill: "solid", padConnection: { mode: "thermal", gapMm: 0.25, spokeWidthMm: 0.5, minimumConnectedSpokes: 2 },
      islandPolicy: { removeUnconnected: true, minimumAreaMm2: 0, requireSingleConnectedComponent: true } }],
    interfaceRequirements: { schemaVersion: "evleda.pcb-interface-requirements.v1", construction: { mode: "two_layer", id: "SYNTHETIC_STACK",
      boardThicknessMm: 0.27, frontCopperThicknessMm: 0.035, backCopperThicknessMm: 0.035,
      dielectric: { thicknessMm: 0.2, material: INTERFACE_FIXTURE_MATERIAL, relativePermittivity: 4.2, lossTangent: 0.02,
        frequencyHz: 100_000_000, substrateRelativePermeability: 1, source: source() },
      conductor: { conductivitySiemensPerMetre: 58_000_000, relativePermeability: 1, roughnessNm: 0, source: source() },
      solderMask: { front: { kind: "absent" }, back: { kind: "absent" } }, exterior: { front: "air", back: "air" }, surfaceFinish: "None", source: source() },
      interfaces: [{ id: INTERFACE_FIXTURE_ID, kind: "differential_pair", nets: { positive: "DP", negative: "DN" },
        endpoints: { source: { positive: endpoint("J1", "1"), negative: endpoint("J1", "2") },
          receiver: { positive: endpoint("J2", "1"), negative: endpoint("J2", "2") } },
        geometry: { traceWidthMm: { minimumMm: 0.4, maximumMm: 0.4 }, edgeGapMm: { minimumMm: 0.25, maximumMm: 0.3 },
          maxEtchLengthMm: 30, maxEtchSkewMm: 0.01, maxUncoupledLengthMm: 7 },
        routing: { allowedLayers: ["F.Cu"], layerTransitions: "forbidden", stubs: "forbidden", referencePlaneId: "GND_PLANE",
          polarityInversion: { policy: "forbidden", receiverMapping: "normal" } },
        terminations: { source: { kind: "none", source: source() }, receiver: { kind: "none", source: source() } },
        impedance: { mode: "differential", targetOhms: 90, toleranceOhms: 10, frequencyHz: 100_000_000, constructionId: "SYNTHETIC_STACK", source: source() },
        source: source() }] }, unresolved: [] });
}

export interface InterfacePublicPad { readonly reference: string; readonly pad: string; readonly net: string;
  readonly xMm: number; readonly yMm: number; readonly layers: readonly string[] }
export interface InterfaceFixtureTrack { readonly x1Mm: number; readonly y1Mm: number; readonly x2Mm: number; readonly y2Mm: number; readonly layer: "F.Cu" }
export interface InterfaceFixtureRoute { readonly net: string; readonly tracks: readonly InterfaceFixtureTrack[];
  readonly vias: readonly { readonly xMm: number; readonly yMm: number }[] }
export const EXPECTED_INTERFACE_PADS = [
  ["J1", "1", "DP", 4_125_000, 9_000_000], ["J1", "2", "DN", 5_875_000, 10_000_000], ["J1", "3", "GND", 4_125_000, 11_000_000],
  ["J2", "1", "DP", 24_125_000, 9_000_000], ["J2", "2", "DN", 25_875_000, 10_000_000], ["J2", "3", "GND", 24_125_000, 11_000_000],
] as const;

/** Reject fractional nanometres and unsafe values. Rounding is never an acceptance tolerance. */
export function exactFixtureNm(mm: number): number {
  assert.ok(Number.isFinite(mm) && !Object.is(mm, -0), "Expected a finite canonical coordinate");
  const nm = Math.round(mm * 1e6);
  assert.ok(Number.isSafeInteger(nm) && Math.abs(nm) <= 2_000_000_000 && nm / 1e6 === mm, "Coordinate must represent exact integer nanometres");
  return nm;
}
export function assertInterfacePhysicalCounts(counts: Record<string, unknown>) {
  for (const name of ["physicalPadCount", "logicalTerminalCount", "numberedCopperPrimitiveCount", "namedCopperPrimitiveCount", "logicalNamedTerminalCount"])
    assert.equal(counts[name], 6, name);
  for (const name of ["noConnectCopperPrimitiveCount", "logicalNoConnectTerminalCount", "nonElectricalFeatureCount", "platedFootprintHoleCount"])
    assert.equal(counts[name], 0, name);
}
export function assertInterfacePads(value: Record<string, any>, placed: boolean): asserts value is Record<string, any> & { pads: InterfacePublicPad[] } {
  assert.equal(value.schemaVersion, "evleda.fresh-plane-pad-positions.v1");
  assert.equal(value.status, "complete-selection"); assertInterfacePhysicalCounts(value.boardCounts); assert.equal(value.pads.length, 6);
  assert.deepEqual(value.terminals.map((row: any) => `${row.reference}:${row.pad}:${row.net}`).sort(),
    EXPECTED_INTERFACE_PADS.map(([reference, pad, net]) => `${reference}:${pad}:${net}`).sort());
  for (const [reference, pad, net, xNm, yNm] of EXPECTED_INTERFACE_PADS) {
    const rows = value.pads.filter((row: any) => row.reference === reference && row.pad === pad);
    assert.equal(rows.length, 1); const row = rows[0]!; assert.equal(row.net, net);
    assert.deepEqual([...row.layers].sort(), ["F.Cu", "F.Mask", "F.Paste"]);
    assert.equal(row.physical?.padType, "smd"); assert.equal(row.physical?.shape, "rect");
    assert.equal(row.physical?.drill, null); assert.deepEqual(row.physical?.sizeMm, { x: 1.75, y: 0.6 });
    assert.equal(typeof row.physical?.id, "string"); assert.equal(typeof row.physical?.footprintId, "string");
    exactFixtureNm(row.xMm); exactFixtureNm(row.yMm);
    if (placed) assert.deepEqual([exactFixtureNm(row.xMm), exactFixtureNm(row.yMm)], [xNm, yNm], `Unexpected actual pad position ${reference}.${pad}`);
  }
}

/** Every endpoint is taken from the validated public native pad rows, never a footprint origin. */
export function interfaceFixtureRoutes(value: Record<string, any>): InterfaceFixtureRoute[] {
  assertInterfacePads(value, true);
  const get = (reference: string, pad: string) => value.pads.find(row => row.reference === reference && row.pad === pad)!;
  const points = (net: string, pin: string, interior: readonly (readonly [number, number])[]): InterfaceFixtureRoute => {
    const start = get("J1", pin), end = get("J2", pin);
    assert.equal(start.net, net); assert.equal(end.net, net);
    const route = [[start.xMm, start.yMm], ...interior, [end.xMm, end.yMm]];
    return { net, vias: [], tracks: route.slice(1).map((point, index) => ({ x1Mm: route[index]![0]!, y1Mm: route[index]![1]!,
      x2Mm: point[0]!, y2Mm: point[1]!, layer: "F.Cu" })) };
  };
  const grounds = [get("J1", "3"), get("J2", "3")];
  const result = [points("DP", "1", [[8, 9], [8.15, 9.15], [21.85, 9.15], [22, 9]]),
    points("DN", "2", [[8, 10], [8.15, 9.85], [21.85, 9.85], [22, 10]]),
    { net: "GND", tracks: grounds.map(pad => ({ x1Mm: pad.xMm, y1Mm: pad.yMm, x2Mm: pad.xMm, y2Mm: 12.5, layer: "F.Cu" as const })),
      vias: grounds.map(pad => ({ xMm: pad.xMm, yMm: 12.5 })) }];
  assertInterfaceGeometry(assessInterfaceFixtureRoutes(value.pads, result));
  return result;
}

/** The offline model tests this planned route, while the driver separately checks the saved source/public assessment. */
export function assessInterfaceFixtureRoutes(pads: readonly InterfacePublicPad[], routes: readonly InterfaceFixtureRoute[]) {
  return assessDifferentialPairGeometry({ positiveNet: "DP", negativeNet: "DN", receiverMapping: "preserved",
    source: { positive: { reference: "J1", pad: "1" }, negative: { reference: "J1", pad: "2" } },
    receiver: { positive: { reference: "J2", pad: "1" }, negative: { reference: "J2", pad: "2" } },
    pads: pads.filter(pad => pad.net !== "GND").map(pad => ({ uuid: `${pad.reference}-pad-${pad.pad}`, reference: pad.reference, pad: pad.pad,
      net: pad.net, layers: pad.layers.filter(layer => layer.endsWith(".Cu")), center: { xNm: exactFixtureNm(pad.xMm), yNm: exactFixtureNm(pad.yMm) } })),
    tracks: routes.filter(route => route.net !== "GND").flatMap(route => route.tracks.map((track, index) => ({ uuid: `${route.net}-track-${index}`,
      net: route.net, layer: track.layer, widthNm: 400_000, start: { xNm: exactFixtureNm(track.x1Mm), yNm: exactFixtureNm(track.y1Mm) },
      end: { xNm: exactFixtureNm(track.x2Mm), yNm: exactFixtureNm(track.y2Mm) } }))),
    vias: routes.filter(route => route.net !== "GND").flatMap(route => route.vias.map((via, index) => ({ uuid: `${route.net}-via-${index}`, net: route.net,
      center: { xNm: exactFixtureNm(via.xMm), yNm: exactFixtureNm(via.yMm) }, layers: ["F.Cu", "B.Cu"], diameterNm: 600_000, drillNm: 300_000 }))),
    limits: { minimumWidthNm: 400_000, maximumWidthNm: 400_000, minimumGapNm: 250_000, maximumCoupledGapNm: 300_000,
      maximumMainLengthNm: 30_000_000, maximumSkewNm: 10_000, maximumStubLengthNm: 0, maximumUncoupledLengthNm: 7_000_000,
      transitions: "forbidden", allowedLayers: ["F.Cu"] } });
}
export function assertInterfaceGeometry(value: DifferentialPairGeometryAssessment) {
  assert.equal(value.inventoryComplete, true); assert.equal(value.selected.tracks.length, 10); assert.equal(value.selected.pads.length, 4);
  assert.equal(value.selected.vias.length, 0); assert.equal(value.accepted, false);
  for (const [name, check] of Object.entries(value.checks)) assert.equal(check.status, "pass", `${name}: ${check.reasons.join("; ")}`);
  for (const route of [value.routes.positive, value.routes.negative]) {
    assert.equal(route.status, "complete_source_tree"); assert.equal(route.mainChain!.length, 5); assert.deepEqual(route.stubs, []);
    assert.deepEqual(route.mainLength, { twiceAxisNm: "39400000", twiceDiagonalNm: "600000" });
    assert.deepEqual(route.totalEtchLength, route.mainLength);
  }
  assert.deepEqual(value.etchSkew, { twiceAxisNm: "0", twiceDiagonalNm: "0" });
  assert.equal(value.coupling!.status, "complete"); assert.equal(value.coupling!.paired.length, 1);
  assert.deepEqual(value.coupling!.paired[0]!.length, { twiceAxisNm: "27400000", twiceDiagonalNm: "0" });
  assert.deepEqual(value.coupling!.positiveUncoupledLength, { twiceAxisNm: "12000000", twiceDiagonalNm: "600000" });
  assert.deepEqual(value.coupling!.negativeUncoupledLength, value.coupling!.positiveUncoupledLength);
}
