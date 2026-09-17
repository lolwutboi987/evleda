import { describe, expect, it } from "vitest";
import { assessDifferentialChannelGeometry } from "../../src/harness/differential-channel-geometry.js";
import type { DifferentialPairPad, DifferentialPairPointNm, DifferentialPairTrack, DifferentialPairVia } from "../../src/harness/differential-pair-geometry.js";
import { pcbDifferentialPairRequirementSchema, type PcbDifferentialPairRequirement } from "../../src/harness/pcb-interface-requirements.js";

const nm = (mm: number) => Math.round(mm * 1_000_000);
const point = (x: number, y: number): DifferentialPairPointNm => ({ xNm: nm(x), yNm: nm(y) });
const endpoint = (reference: string, pin: string) => ({ reference, pin });
const source = () => ({ kind: "caller_assertion" as const, reference: "synthetic-channel-fixture", description: "Numerical source geometry only." });
const length = (mm: number) => ({ twiceAxisNm: String(BigInt(nm(mm)) * 2n), twiceDiagonalNm: "0" });
const track = (uuid: string, net: string, start: DifferentialPairPointNm, end: DifferentialPairPointNm, widthMm = 0.5): DifferentialPairTrack =>
  ({ uuid, net, start, end, widthNm: nm(widthMm), layer: "F.Cu" });
const pad = (reference: string, pin: string, net: string, x: number, y: number): DifferentialPairPad =>
  ({ uuid: `${reference}.${pin}`, reference, pad: pin, net, layers: ["F.Cu"], center: point(x, y) });
type Fixture = { pair: PcbDifferentialPairRequirement; selected: { tracks: DifferentialPairTrack[]; pads: DifferentialPairPad[]; vias: DifferentialPairVia[] } };

function fixture(): Fixture {
  const pair = pcbDifferentialPairRequirementSchema.parse({
    id: "USB_CHANNEL", kind: "differential_pair", nets: { positive: "USB_DP", negative: "USB_DN" },
    endpoints: { source: { positive: endpoint("U1", "1"), negative: endpoint("U1", "2") },
      receiver: { positive: endpoint("J1", "1"), negative: endpoint("J1", "2") } },
    geometry: { traceWidthMm: { minimumMm: 0.45, maximumMm: 0.55 }, edgeGapMm: { minimumMm: 0.4, maximumMm: 0.6 },
      maxEtchLengthMm: 20, maxEtchSkewMm: 0.5, maxUncoupledLengthMm: 20 },
    routing: { allowedLayers: ["F.Cu"], layerTransitions: "forbidden", stubs: "forbidden", referencePlaneId: "GND_PLANE",
      polarityInversion: { policy: "forbidden", receiverMapping: "normal" } },
    terminations: { source: { kind: "source_series", positive: { componentReference: "RP", sourcePin: "1", linePin: "2", resistanceOhms: 22 },
      negative: { componentReference: "RN", sourcePin: "1", linePin: "2", resistanceOhms: 22 }, maximumDistanceToEndpointMm: 2, source: source() },
      receiver: { kind: "none", source: source() } },
    impedance: { mode: "none" }, source: source(),
    channel: { kind: "source_series", launchNets: { positive: "USB_DP_SRC", negative: "USB_DN_SRC" },
      additionalReceivers: [{ positive: endpoint("J2", "1"), negative: endpoint("J2", "2") }],
      protection: [{ componentReference: "D1", positivePins: ["1", "6"], negativePins: ["3", "4"],
        ground: { pin: "2", net: "GND" }, supply: { pin: "5", net: "VBUS" }, source: source() }],
      escapes: [{ terminal: endpoint("U1", "1"), traceWidthMm: { minimumMm: 0.2, maximumMm: 0.4 }, maximumRoutedLengthMm: 1 }],
      maximumLaunchEtchLengthMm: 2, maximumBranchEtchLengthMm: 7, maxEtchLengthMm: 12, maxTotalCopperLengthMm: 16, maxEtchSkewMm: 0.5, source: source() },
  });
  return { pair, selected: { tracks: [
    track("p.launch", "USB_DP_SRC", point(0, 0), point(2, 0)),
    track("n.launch", "USB_DN_SRC", point(0, 1), point(1.5, 1)),
    track("p.line", "USB_DP", point(3, 0), point(10, 0)),
    track("n.line", "USB_DN", point(3, 1), point(10, 1)),
    // Both T junctions are at actual, declared protection pad centers.
    track("p.branch.0", "USB_DP", point(6, 0), point(6, -3)),
    track("p.branch.1", "USB_DP", point(6, -3), point(10, -3)),
    track("n.branch.0", "USB_DN", point(6, 1), point(6, 4)),
    track("n.branch.1", "USB_DN", point(6, 4), point(10, 4)),
  ], pads: [
    pad("U1", "1", "USB_DP_SRC", 0, 0), pad("U1", "2", "USB_DN_SRC", 0, 1),
    pad("RP", "1", "USB_DP_SRC", 2, 0), pad("RN", "1", "USB_DN_SRC", 1.5, 1),
    pad("RP", "2", "USB_DP", 3, 0), pad("RN", "2", "USB_DN", 3, 1),
    pad("J1", "1", "USB_DP", 10, 0), pad("J1", "2", "USB_DN", 10, 1),
    pad("J2", "1", "USB_DP", 10, -3), pad("J2", "2", "USB_DN", 10, 4),
    pad("D1", "1", "USB_DP", 5, 0), pad("D1", "6", "USB_DP", 6, 0),
    pad("D1", "3", "USB_DN", 5, 1), pad("D1", "4", "USB_DN", 6, 1),
    pad("D1", "2", "GND", 5.5, 2), pad("D1", "5", "VBUS", 5.5, -1),
  ], vias: [] } };
}
const assess = ({ pair, selected }: Fixture, complete = true) => assessDifferentialChannelGeometry(pair, selected, complete);

describe("bounded source-series differential channel geometry", () => {
  it("measures every receiver across four distinct copper nets and reaches every signal anchor", () => {
    const input = fixture(), result = assess(input);
    expect(Object.values(result.checks).map(check => check.status)).toEqual(Array(10).fill("pass"));
    expect(result.inventoryComplete).toBe(true);
    expect(result.accepted).toBe(false);
    expect(result.launch.routes.positive.mainLength).toEqual(length(2));
    expect(result.launch.routes.negative.mainLength).toEqual(length(1.5));
    expect(result.receiverPaths.map(path => ({ receiver: path.receiver, positive: path.positiveEtchLength, negative: path.negativeEtchLength, skew: path.etchSkew }))).toEqual([
      { receiver: input.pair.endpoints.receiver, positive: length(9), negative: length(8.5), skew: length(0.5) },
      { receiver: input.pair.channel!.additionalReceivers[0], positive: length(12), negative: length(11.5), skew: length(0.5) },
    ]);
    expect(result.receiverPaths.map(path => path.geometry.routes.positive.mainLength)).toEqual([length(7), length(10)]);
    expect(result.copperEtchLength).toEqual({ positive: length(16), negative: length(15.5) });
    expect(result.anchors).toHaveLength(14);
    expect(result.anchors.every(anchor => anchor.status === "pass" && anchor.matchingPadUuids.length === 1 && anchor.contactNodeIds.length === 1)).toBe(true);
    expect(result.anchors.filter(anchor => anchor.selector.reference === "D1").map(anchor => anchor.selector.pad).sort()).toEqual(["1", "3", "4", "6"]);
    const positive = result.receiverPaths[0]!.geometry.routes.positive;
    const junction = positive.nodes!.find(node => node.padUuids.includes("D1.6"))!;
    expect(positive.edges!.filter(edge => edge.startNode === junction.id || edge.endNode === junction.id)).toHaveLength(3);
    expect(positive.stubs![0]!.maximumAttachmentToLeafLength).toEqual(length(7));
    expect(result.receiverPaths.every(path => path.geometry.etchSkew?.twiceAxisNm === "0")).toBe(true);
  });

  it("counts branch copper once in the complete length budget and includes launch skew", () => {
    const input = fixture();
    input.pair.channel!.maxTotalCopperLengthMm = 15.75;
    input.pair.channel!.maxEtchSkewMm = 0.49;
    const result = assess(input);
    expect(result.launch.checks.length.status).toBe("pass");
    expect(result.receiverPaths.every(path => path.geometry.checks.length.status === "pass")).toBe(true);
    expect(result.receiverPaths[0]!.positiveEtchLength).toEqual(length(9));
    expect(result.receiverPaths[1]!.positiveEtchLength).toEqual(length(12));
    expect(result.copperEtchLength).toEqual({ positive: length(16), negative: length(15.5) });
    expect(result.checks.length.status).toBe("fail");
    expect(result.checks.skew.status).toBe("fail");
  });
  it("keeps the line-pair skew budget separate from the explicitly bounded complete-channel skew", () => {
    const input = fixture();
    input.pair.geometry.maxEtchSkewMm = 0.1;
    const result = assess(input);
    expect(result.launch.etchSkew).toEqual(length(0.5));
    expect(result.receiverPaths.every(path => path.geometry.etchSkew?.twiceAxisNm === "0")).toBe(true);
    expect(result.budgets.pathSkew.status).toBe("pass");
    expect(result.checks.skew.status).toBe("pass");
  });

  it("checks every receiver path independently of the unique total-copper budget", () => {
    const input = fixture();
    input.pair.channel!.maxEtchLengthMm = 11.75;
    const result = assess(input);
    expect(result.copperEtchLength).toEqual({ positive: length(16), negative: length(15.5) });
    expect(result.receiverPaths[0]!.positiveEtchLength).toEqual(length(9));
    expect(result.receiverPaths[1]!.positiveEtchLength).toEqual(length(12));
    expect(result.checks.length.status).toBe("fail");
    expect(result.checks.topology.status).toBe("pass");
  });

  it("computes receiver-specific skew after combining the signed launch and line imbalances", () => {
    const input = fixture();
    input.pair.channel!.maximumBranchEtchLengthMm = 9;
    input.pair.channel!.maxEtchLengthMm = 20;
    input.pair.channel!.maxTotalCopperLengthMm = 20;
    input.pair.channel!.maxEtchSkewMm = 1;
    input.pair.geometry.maxEtchSkewMm = 3;
    input.selected.tracks = input.selected.tracks.map(item => item.uuid === "n.branch.1" ? { ...item, end: point(12, 4) } : item);
    input.selected.pads = input.selected.pads.map(item => item.uuid === "J2.2" ? { ...item, center: point(12, 4) } : item);
    const result = assess(input);
    expect(result.checks.topology.status).toBe("pass");
    expect(result.checks.length.status).toBe("pass");
    expect(result.receiverPaths.map(path => path.geometry.etchSkew)).toEqual([length(0), length(2)]);
    expect(result.receiverPaths.map(path => path.etchSkew)).toEqual([length(0.5), length(1.5)]);
    expect(result.receiverPaths[1]!.positiveEtchLength).toEqual(length(12));
    expect(result.receiverPaths[1]!.negativeEtchLength).toEqual(length(13.5));
    expect(result.checks.skew.status).toBe("fail");
  });

  it.each(["1", "2"])("rejects a missing additional receiver pad J2.%s", pin => {
    const input = fixture();
    input.selected.pads = input.selected.pads.filter(pad => pad.uuid !== `J2.${pin}`);
    const result = assess(input);
    expect(result.anchors).toContainEqual(expect.objectContaining({ selector: { reference: "J2", pad: pin }, matchingPadUuids: [], status: "fail" }));
    expect(result.checks.topology.status).toBe("fail");
    expect(result.receiverPaths[1]!.positiveEtchLength).toBeNull();
    expect(result.receiverPaths[1]!.negativeEtchLength).toBeNull();
    expect(result.receiverPaths[1]!.etchSkew).toBeNull();
  });

  it.each(["1", "3", "4", "6"])("requires actual copper contact at protection signal pin D1.%s", pin => {
    const input = fixture();
    input.selected.pads = input.selected.pads.map(pad => pad.uuid === `D1.${pin}` ? { ...pad, center: point(30, 30) } : pad);
    const result = assess(input);
    expect(result.anchors).toContainEqual(expect.objectContaining({ selector: { reference: "D1", pad: pin }, matchingPadUuids: [`D1.${pin}`], contactNodeIds: [], status: "fail" }));
    expect(result.checks.topology.status).toBe("fail");
  });

  it("rejects wrong ESD polarity mapping even when both line graphs and all receiver mappings are complete", () => {
    const input = fixture(), protection = input.pair.channel!.protection[0]!;
    protection.positivePins = ["3", "6"];
    protection.negativePins = ["1", "4"];
    const result = assess(input);
    expect(result.receiverPaths.every(path => path.geometry.checks.topology.status === "pass" && path.geometry.checks.sourcePolarity.status === "pass")).toBe(true);
    expect(result.anchors.filter(anchor => anchor.status === "fail").map(anchor => anchor.selector.pad).sort()).toEqual(["1", "3"]);
    expect(result.checks.topology.status).toBe("fail");
  });

  it("does not discard a disconnected receiver branch when the primary receiver remains reachable", () => {
    const input = fixture();
    input.selected.tracks = input.selected.tracks.filter(track => track.uuid !== "p.branch.0");
    const result = assess(input);
    expect(result.receiverPaths[0]!.geometry.routes.positive.reasons).toContain("DISCONNECTED_SELECTED_COPPER");
    expect(result.receiverPaths.every(path => path.positiveEtchLength === null && path.negativeEtchLength === null && path.etchSkew === null)).toBe(true);
    expect(result.checks.topology.status).toBe("fail");
  });

  it("rejects an undeclared signal pad even on an otherwise valid degree-two body node", () => {
    const input = fixture();
    input.selected.pads.push(pad("TP1", "1", "USB_DP", 8, 0));
    const result = assess(input);
    expect(result.receiverPaths.every(path => path.geometry.checks.topology.status === "pass")).toBe(true);
    expect(result.checks.topology).toEqual({ status: "fail", reasons: ["UNDECLARED_SOURCE_SIGNAL_PAD"] });
  });

  it("requires a real declared pad at a branch attachment, not merely somewhere on the same net", () => {
    const input = fixture();
    input.selected.tracks = input.selected.tracks.map(item => item.uuid === "p.branch.0" ? { ...item, start: point(7, 0), end: point(7, -3) }
      : item.uuid === "p.branch.1" ? { ...item, start: point(7, -3) } : item);
    const result = assess(input);
    expect(result.anchors.every(anchor => anchor.status === "pass")).toBe(true);
    expect(result.receiverPaths.every(path => path.geometry.checks.topology.status === "pass")).toBe(true);
    expect(result.checks.topology.status).toBe("fail");
    expect(result.checks.topology.reasons).toContain("ALL_LEAVES_AND_BRANCH_ATTACHMENTS_REQUIRE_DECLARED_PAD_CENTERS");
  });

  it("rejects a cycle while withholding every affected complete-channel length", () => {
    const input = fixture();
    input.selected.tracks.push(track("loop.0", "USB_DP", point(4, 0), point(4, -1)),
      track("loop.1", "USB_DP", point(4, -1), point(5, -1)), track("loop.2", "USB_DP", point(5, -1), point(5, 0)));
    const result = assess(input);
    expect(result.receiverPaths[0]!.geometry.routes.positive.reasons).toContain("CYCLE_OR_DISCONNECTED_GRAPH");
    expect(result.checks.topology.status).toBe("fail");
    expect(result.receiverPaths.every(path => path.positiveEtchLength === null && path.etchSkew === null)).toBe(true);
  });

  it("retains a forbidden via without inventing a vertical or resistor-internal length", () => {
    const input = fixture();
    input.selected.vias.push({ uuid: "via.1", net: "USB_DP", center: point(5, 0), layers: ["F.Cu", "B.Cu"], diameterNm: nm(0.6), drillNm: nm(0.3) });
    const result = assess(input);
    expect(result.checks.transitions.status).toBe("fail");
    expect(result.checks.topology.status).toBe("fail");
    expect(result.receiverPaths[0]!.geometry.viaObservations).toEqual([{ uuid: "via.1", layers: ["F.Cu", "B.Cu"],
      transition: "forbidden_present", unusedBarrel: "not_assessed", verticalLength: "not_assessed" }]);
    expect(result.receiverPaths.every(path => path.positiveEtchLength === null && path.negativeEtchLength === null)).toBe(true);
  });

  it("checks positive launch against negative line copper across resistor sections", () => {
    const input = fixture();
    const translate = (p: DifferentialPairPointNm) => ({ xNm: p.xNm + nm(7), yNm: p.yNm + nm(1.3) });
    input.selected.tracks = input.selected.tracks.map(item => item.net.endsWith("_SRC") ? { ...item, start: translate(item.start), end: translate(item.end) } : item);
    input.selected.pads = input.selected.pads.map(item => item.net.endsWith("_SRC") ? { ...item, center: translate(item.center) } : item);
    const result = assess(input);
    expect(result.launch.checks.minimumGap.status).toBe("pass");
    expect(result.receiverPaths.every(path => path.geometry.checks.minimumGap.status === "pass")).toBe(true);
    expect(result.checks.topology.status).toBe("pass");
    expect(result.checks.minimumGap.status).toBe("fail");
    expect(result.allTrackPairGaps).toContainEqual(expect.objectContaining({ positiveUuid: "p.launch", negativeUuid: "n.line", minimumGap: "fail" }));
  });

  it("allows a terminal neckdown exactly at its routed-distance budget", () => {
    const input = fixture();
    input.selected.tracks = input.selected.tracks.flatMap(item => item.uuid === "p.launch" ? [
      track("p.escape", "USB_DP_SRC", point(0, 0), point(1, 0), 0.2),
      track("p.launch", "USB_DP_SRC", point(1, 0), point(2, 0)),
    ] : [item]);
    const result = assess(input);
    expect(result.checks.width.status).toBe("pass");
    expect(result.checks.topology.status).toBe("pass");
    expect(result.escapes).toEqual([{ net: "USB_DP_SRC", edgeId: "p.escape:0", widthNm: nm(0.2),
      qualifyingTerminals: [{ reference: "U1", pad: "1" }], status: "pass" }]);
  });

  it("rejects a narrow body that has no applicable terminal escape", () => {
    const input = fixture();
    input.selected.tracks = input.selected.tracks.map(item => item.uuid === "p.line" ? { ...item, widthNm: nm(0.3) } : item);
    const result = assess(input);
    expect(result.checks.topology.status).toBe("pass");
    expect(result.checks.width.status).toBe("fail");
    expect(result.escapes.length).toBeGreaterThan(0);
    expect(result.escapes.every(escape => escape.status === "fail" && escape.qualifyingTerminals.length === 0)).toBe(true);
  });

  it("uses routed distance for an escape whose far-away copper returns near the terminal", () => {
    const input = fixture();
    input.pair.channel!.maximumLaunchEtchLengthMm = 10;
    input.pair.channel!.maxEtchLengthMm = 30;
    input.pair.channel!.maxTotalCopperLengthMm = 30;
    input.pair.channel!.maxEtchSkewMm = 10;
    input.pair.geometry.maxEtchSkewMm = 10;
    input.selected.tracks = input.selected.tracks.flatMap(item => item.uuid === "p.launch" ? [
      track("detour.0", "USB_DP_SRC", point(0, 0), point(-2, 0)),
      track("detour.1", "USB_DP_SRC", point(-2, 0), point(-2, -0.8)),
      track("detour.2", "USB_DP_SRC", point(-2, -0.8), point(0, -0.8)),
      track("near.but.long", "USB_DP_SRC", point(0, -0.8), point(0, -0.2), 0.3),
      track("p.launch", "USB_DP_SRC", point(0, -0.2), point(2, -0.2)),
    ] : [item]);
    input.selected.pads = input.selected.pads.map(item => item.uuid === "RP.1" ? { ...item, center: point(2, -0.2) } : item);
    const result = assess(input);
    expect(result.checks.topology.status).toBe("pass");
    expect(result.launch.routes.positive.mainLength).toEqual(length(7.4));
    expect(result.checks.width.status).toBe("fail");
    expect(result.escapes).toEqual([{ net: "USB_DP_SRC", edgeId: "near.but.long:0", widthNm: nm(0.3), qualifyingTerminals: [], status: "fail" }]);
  });

  it("withholds complete graph facts when source projection is incomplete", () => {
    const input = fixture(), result = assess(input, false);
    expect(result.inventoryComplete).toBe(false);
    expect(result.checks.topology.status).toBe("not_assessed");
    expect(result.checks.length.status).toBe("not_assessed");
    expect(result.checks.skew.status).toBe("not_assessed");
    expect(result.launch.routes.positive.mainLength).toBeNull();
    expect(result.receiverPaths.every(path => path.positiveEtchLength === null && path.negativeEtchLength === null && path.etchSkew === null)).toBe(true);
    expect(result.anchors.every(anchor => anchor.status === "not_assessed")).toBe(true);
    expect(result.accepted).toBe(false);
  });
});
