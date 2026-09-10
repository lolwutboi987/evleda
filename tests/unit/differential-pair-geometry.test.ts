import { describe, expect, it } from "vitest";
import { assessDifferentialPairGeometry, compareDifferentialPairCopperGap, compareDifferentialPairLengths,
  type DifferentialPairGeometryInput, type DifferentialPairPointNm, type DifferentialPairTrack } from "../../src/harness/differential-pair-geometry.js";

const point = (xNm: number, yNm: number): DifferentialPairPointNm => ({ xNm, yNm });
const track = (uuid: string, net: string, start: DifferentialPairPointNm, end: DifferentialPairPointNm, widthNm = 2, layer = "F.Cu"): DifferentialPairTrack => ({ uuid, net, start, end, widthNm, layer,
  sourceIdentity: { algorithm: "sha256", digest: "a".repeat(64), size: 10 } });
const path = (prefix: string, net: string, points: readonly DifferentialPairPointNm[], widthNm = 2) => points.slice(1).map((end, index) => track(`${prefix}${index}`, net, points[index]!, end, widthNm));
function fixture(p = [point(0, 0), point(100, 0)], n = [point(0, 10), point(100, 10)]): DifferentialPairGeometryInput {
  return { tracks: [...path("p", "P", p), ...path("n", "N", n)], pads: [
    { uuid: "sp", reference: "J1", pad: "1", net: "P", layers: ["F.Cu"], center: p[0]! },
    { uuid: "sn", reference: "J1", pad: "2", net: "N", layers: ["F.Cu"], center: n[0]! },
    { uuid: "rp", reference: "J2", pad: "1", net: "P", layers: ["F.Cu"], center: p.at(-1)! },
    { uuid: "rn", reference: "J2", pad: "2", net: "N", layers: ["F.Cu"], center: n.at(-1)! },
  ], vias: [], positiveNet: "P", negativeNet: "N", source: { positive: { reference: "J1", pad: "1" }, negative: { reference: "J1", pad: "2" } },
  receiver: { positive: { reference: "J2", pad: "1" }, negative: { reference: "J2", pad: "2" } }, receiverMapping: "preserved",
  limits: { minimumWidthNm: 2, maximumWidthNm: 2, minimumGapNm: 0, maximumCoupledGapNm: 10, maximumMainLengthNm: 1000,
    maximumSkewNm: 100, maximumStubLengthNm: 0, maximumUncoupledLengthNm: 100, transitions: "forbidden", allowedLayers: ["F.Cu"] } };
}
const integerLength = (nm: number) => ({ twiceAxisNm: String(nm * 2), twiceDiagonalNm: "0" });

describe("exact differential pair length and capsule arithmetic", () => {
  it("compares opposite-sign irrational coefficients without rounding, including Pell neighbours beyond binary64", () => {
    let a = 1n, b = 1n;
    for (let i = 0; i < 80; i++) {
      expect(compareDifferentialPairLengths({ twiceAxisNm: String(a), twiceDiagonalNm: String(-b) }, integerLength(0))).toBe(i % 2 ? 1 : -1);
      [a, b] = [a + 2n * b, a + b];
    }
    expect(compareDifferentialPairLengths({ twiceAxisNm: "-20", twiceDiagonalNm: "14" }, integerLength(0))).toBe(-1);
    expect(compareDifferentialPairLengths({ twiceAxisNm: "-20", twiceDiagonalNm: "15" }, integerLength(0))).toBe(1);
    expect(compareDifferentialPairLengths(integerLength(42), integerLength(42))).toBe(0);
  });
  it("preserves the sign before squaring capsule thresholds and handles odd widths", () => {
    expect(compareDifferentialPairCopperGap({ numerator: "16", denominator: "1" }, 3, 4, 1)).toBe(-1);
    expect(compareDifferentialPairCopperGap({ numerator: "25", denominator: "1" }, 3, 4, 1)).toBe(1);
    expect(compareDifferentialPairCopperGap({ numerator: "25", denominator: "1" }, 3, 5, 1)).toBe(0);
    expect(compareDifferentialPairCopperGap({ numerator: "0", denominator: "1" }, 3, 5, -5)).toBe(1);
    expect(compareDifferentialPairCopperGap({ numerator: "0", denominator: "1" }, 3, 5, -4)).toBe(0);
    expect(compareDifferentialPairCopperGap({ numerator: "1", denominator: "2" }, 1, 1, 0)).toBe(-1);
  });
});

describe("whole source-tree differential pair geometry", () => {
  it("assesses both complete source-to-receiver chains and preserves source provenance without authority claims", () => {
    const input = fixture(), result = assessDifferentialPairGeometry(input);
    expect(Object.values(result.checks).every(row => row.status === "pass")).toBe(true);
    expect(result.routes.positive.mainLength).toEqual(integerLength(100));
    expect(result.routes.negative.mainLength).toEqual(integerLength(100));
    expect(result.coupling!.paired).toHaveLength(1);
    expect(result.coupling!.paired[0]!.length).toEqual(integerLength(100));
    expect(result.routes.positive.runs![0]!.members[0]!.sourceIdentity).toEqual(input.tracks[0]!.sourceIdentity);
    expect(result.selected.tracks).toEqual(input.tracks);
    expect(result.selected.tracks).not.toBe(input.tracks);
    expect(result.authority).toBe("caller_supplied_source_geometry_only");
    expect(result.notEvaluated).toContain("datasheet_polarity_permission");
    expect(result.accepted).toBe(false);
  });
  it("handles whole polylines with horizontal, vertical and 45-degree bends and unequal launches", () => {
    const result = assessDifferentialPairGeometry(fixture([point(0, 0), point(10, 0), point(20, 10), point(30, 10), point(30, 30)],
      [point(0, 4), point(8, 4), point(18, 14), point(26, 14), point(26, 30)]));
    expect(result.checks.topology.status).toBe("pass");
    expect(result.routes.positive.runs).toHaveLength(4);
    expect(result.routes.positive.mainLength).toEqual({ twiceAxisNm: "80", twiceDiagonalNm: "20" });
    expect(result.routes.negative.mainLength).toEqual({ twiceAxisNm: "64", twiceDiagonalNm: "20" });
    expect(result.etchSkew).toEqual(integerLength(8));
    expect(result.coupling!.paired.length).toBeGreaterThan(2);
    expect(result.coupling!.positiveCoverage.some(interval => interval.status === "unpaired")).toBe(true);
    expect(result.allTrackPairGaps).toHaveLength(16);
  });
  it("is length/coupling invariant under unequal collinear segmentation, reversed records, and input permutation", () => {
    const input = fixture([point(0, 0), point(20, 0), point(60, 0), point(100, 0)]);
    const result = assessDifferentialPairGeometry({ ...input, tracks: [...input.tracks].reverse().map(item => ({ ...item, start: item.end, end: item.start })) });
    expect(result.routes.positive.runs).toHaveLength(1);
    expect(result.routes.positive.runs![0]!.members.map(member => member.uuid)).toEqual(["p0", "p1", "p2"]);
    expect(result.coupling!.paired).toHaveLength(1);
    expect(result.coupling!.paired[0]!.positiveMemberUuids).toEqual(["p0", "p1", "p2"]);
    expect(result.coupling!.paired[0]!.length).toEqual(integerLength(100));
    expect(result.etchSkew).toEqual(integerLength(0));
  });
  it("clips diagonal parallel overlap on the exact half-nanometre grid", () => {
    const input = fixture([point(0, 0), point(10, 10)], [point(0, 1), point(10, 11)]);
    const result = assessDifferentialPairGeometry(input), span = result.coupling!.paired[0]!;
    expect(span.positiveStart).toEqual({ xTwiceNm: "1", yTwiceNm: "1" });
    expect(span.negativeEnd).toEqual({ xTwiceNm: "19", yTwiceNm: "21" });
    expect(span.length).toEqual({ twiceAxisNm: "0", twiceDiagonalNm: "19" });
    expect(span.centerlineSquaredNm2).toEqual({ numerator: "1", denominator: "2" });
    expect(result.coupling!.positiveUncoupledLength).toEqual({ twiceAxisNm: "0", twiceDiagonalNm: "1" });
    expect(result.coupling!.negativeUncoupledLength).toEqual({ twiceAxisNm: "0", twiceDiagonalNm: "1" });
    expect(result.checks.minimumGap.status).toBe("fail");
  });
  it("splits endpoint-on-interior T contacts and interior source/receiver pad anchors, inventorying every stub", () => {
    const input = fixture([point(25, 0), point(75, 0)], [point(25, 10), point(75, 10)]);
    const result = assessDifferentialPairGeometry({ ...input, tracks: [track("pWhole", "P", point(0, 0), point(100, 0)), track("tap", "P", point(50, 0), point(50, -20)), input.tracks[1]!] });
    expect(result.routes.positive.status).toBe("complete_source_tree");
    expect(result.routes.positive.contacts).toContainEqual({ kind: "endpoint_on_interior", firstUuid: "pWhole", secondUuid: "tap" });
    expect(result.routes.positive.edges).toHaveLength(5);
    expect(result.routes.positive.mainLength).toEqual(integerLength(50));
    expect(result.routes.positive.totalEtchLength).toEqual(integerLength(120));
    expect(result.routes.positive.stubs).toHaveLength(3);
    expect(result.routes.positive.stubs!.map(stub => stub.maximumAttachmentToLeafLength.twiceAxisNm).sort()).toEqual(["40", "50", "50"]);
    expect(result.checks.stubs.status).toBe("fail");
    expect(result.selected.tracks).toHaveLength(3);
  });
  it("retains an acyclic branching tap with separate total etch and longest attachment-to-leaf length", () => {
    const input = fixture();
    const result = assessDifferentialPairGeometry({ ...input, tracks: [...input.tracks,
      track("tap", "P", point(50, 0), point(50, -10)), track("left", "P", point(50, -10), point(30, -10)), track("right", "P", point(50, -10), point(70, -10))],
    limits: { ...input.limits, maximumStubLengthNm: 30 } });
    expect(result.routes.positive.stubs).toHaveLength(1);
    expect(result.routes.positive.stubs![0]!.length).toEqual(integerLength(50));
    expect(result.routes.positive.stubs![0]!.maximumAttachmentToLeafLength).toEqual(integerLength(30));
    expect(result.routes.positive.stubs![0]!.leafNodes).toHaveLength(2);
    expect(result.checks.stubs.status).toBe("pass");
  });
  it("allows additional declared termination anchors on the main chain without inventing an internal connection", () => {
    const input = fixture(), result = assessDifferentialPairGeometry({ ...input, pads: [...input.pads,
      { uuid: "term", reference: "R1", pad: "1", net: "P", layers: ["F.Cu"], center: point(80, 0) }], terminationAnchors: [{ reference: "R1", pad: "1" }] });
    expect(result.checks.topology.status).toBe("pass");
    expect(result.routes.positive.mainChain).toHaveLength(2);
    expect(result.routes.positive.runs).toHaveLength(1);
    expect(result.terminationAnchors[0]!.status).toBe("pass");
    expect(result.routes.positive.stubs).toEqual([]);
  });
  it("does not exempt a declared termination tap from stub limits", () => {
    const input = fixture(), result = assessDifferentialPairGeometry({ ...input, tracks: [...input.tracks, track("tap", "P", point(80, 0), point(80, -10))], pads: [...input.pads,
      { uuid: "term", reference: "R1", pad: "1", net: "P", layers: ["F.Cu"], center: point(80, -10) }], terminationAnchors: [{ reference: "R1", pad: "1" }] });
    expect(result.terminationAnchors[0]!.status).toBe("pass");
    expect(result.checks.stubs.status).toBe("fail");
  });
  it.each([
    ["positive overlap", [track("duplicate", "P", point(30, 0), point(60, 0))], "POSITIVE_OVERLAP"],
    ["proper crossing", [track("crossing", "P", point(50, -10), point(50, 10))], "PROPER_CROSSING"],
    ["cycle", [track("up", "P", point(20, 0), point(20, -20)), track("across", "P", point(20, -20), point(80, -20)), track("down", "P", point(80, -20), point(80, 0))], "CYCLE_OR_DISCONNECTED_GRAPH"],
    ["disconnected copper", [track("island", "P", point(0, -30), point(100, -30))], "DISCONNECTED_SELECTED_COPPER"],
  ] as const)("retains all selected primitives but fails complete chain for %s", (_name, extra, reason) => {
    const input = fixture(), result = assessDifferentialPairGeometry({ ...input, tracks: [...input.tracks, ...extra] });
    expect(result.routes.positive.status).toBe("incomplete");
    expect(result.routes.positive.reasons).toContain(reason);
    expect(result.routes.positive.mainChain).toBeNull();
    expect(result.routes.positive.stubs).toBeNull();
    expect(result.selected.tracks).toHaveLength(input.tracks.length + extra.length);
    expect(result.checks.topology.status).toBe("fail");
    expect(result.checks.length.status).toBe("not_assessed");
  });
  it("retains selected vias and explicitly declines their transition, barrel and vertical length", () => {
    const input = fixture(), via = { uuid: "v1", net: "P", center: point(50, 0), layers: ["F.Cu", "B.Cu"], diameterNm: 6, drillNm: 2 };
    const result = assessDifferentialPairGeometry({ ...input, vias: [via] });
    expect(result.selected.vias).toEqual([via]);
    expect(result.viaObservations).toEqual([{ uuid: "v1", layers: ["F.Cu", "B.Cu"], transition: "forbidden_present", unusedBarrel: "not_assessed", verticalLength: "not_assessed" }]);
    expect(result.routes.positive.nodes!.some(node => node.viaUuids.includes("v1"))).toBe(true);
    expect(result.checks.transitions.status).toBe("fail");
    expect(result.routes.positive.mainLength).toBeNull();
  });
  it("checks only source polarity consistency for explicitly swapped receiver roles", () => {
    const input = fixture(), result = assessDifferentialPairGeometry({ ...input, receiverMapping: "swapped", receiver: { positive: input.receiver.negative, negative: input.receiver.positive } });
    expect(result.checks.sourcePolarity.status).toBe("pass");
    expect(result.checks.topology.status).toBe("pass");
    expect(result.notEvaluated).toContain("datasheet_polarity_permission");
    expect(assessDifferentialPairGeometry({ ...input, receiverMapping: "swapped" }).checks.sourcePolarity.status).toBe("fail");
  });
  it("does not choose one split physical member sharing a logical pad number, even on another net", () => {
    const input = fixture(), result = assessDifferentialPairGeometry({ ...input, pads: [...input.pads, { ...input.pads[0]!, uuid: "split", net: "OTHER", center: point(1, 1) }] });
    expect(result.sourceRoles[0]!.matchingPadUuids).toEqual(["sp", "split"]);
    expect(result.checks.sourcePolarity.status).toBe("fail");
    expect(result.checks.topology.status).toBe("fail");
  });
  it("keeps width, minimum gap, length and skew checks independent", () => {
    const input = fixture([point(0, 0), point(101, 0)]), result = assessDifferentialPairGeometry({ ...input,
      tracks: input.tracks.map(item => ({ ...item, widthNm: 4 })), limits: { ...input.limits, maximumMainLengthNm: 100, maximumSkewNm: 0, minimumGapNm: 8 } });
    expect(result.checks.topology.status).toBe("pass");
    expect(result.checks.width.status).toBe("fail");
    expect(result.checks.minimumGap.status).toBe("fail");
    expect(result.checks.length.status).toBe("fail");
    expect(result.checks.skew.status).toBe("fail");
    expect(result.routes.positive.mainLength).toEqual(integerLength(101));
  });
  it("compares signed axis-minus-diagonal skew and diagonal length bounds exactly", () => {
    const input = fixture([point(0, 0), point(10, 0)], [point(0, 100), point(7, 107)]);
    const result = assessDifferentialPairGeometry({ ...input, limits: { ...input.limits, maximumMainLengthNm: 10, maximumSkewNm: 1 } });
    expect(result.etchSkew).toEqual({ twiceAxisNm: "20", twiceDiagonalNm: "-14" });
    expect(result.checks.length.status).toBe("pass");
    expect(result.checks.skew.status).toBe("pass");
    expect(assessDifferentialPairGeometry({ ...input, limits: { ...input.limits, maximumSkewNm: 0 } }).checks.skew.status).toBe("fail");
    const longer = fixture([point(0, 0), point(10, 0)], [point(0, 100), point(8, 108)]);
    expect(assessDifferentialPairGeometry({ ...longer, limits: { ...longer.limits, maximumMainLengthNm: 10 } }).checks.length.status).toBe("fail");
  });
});

describe("complete pair capsule gaps and correspondence coverage", () => {
  it("includes diagonal endcaps where projected overlap is absent", () => {
    const result = assessDifferentialPairGeometry(fixture([point(0, 0), point(10, 0)], [point(11, 2), point(21, 2)]));
    expect(result.allTrackPairGaps![0]!.centerlineSquaredNm2).toEqual({ numerator: "5", denominator: "1" });
    expect(result.coupling!.paired).toEqual([]);
    expect(result.coupling!.positiveUncoupledLength).toEqual(integerLength(10));
  });
  it("finds exact proper cross-net intersections and endpoint-to-interior minima", () => {
    const crossing = assessDifferentialPairGeometry(fixture([point(0, 0), point(1, 1)], [point(0, 1), point(1, 0)]));
    expect(crossing.allTrackPairGaps![0]!.centerlineSquaredNm2).toEqual({ numerator: "0", denominator: "1" });
    expect(crossing.checks.minimumGap.status).toBe("fail");
    const endpoint = assessDifferentialPairGeometry(fixture([point(0, 0), point(10, 0)], [point(5, 4), point(5, 8)]));
    expect(endpoint.allTrackPairGaps![0]!.centerlineSquaredNm2).toEqual({ numerator: "16", denominator: "1" });
  });
  it("detects a short-circuiting N stub even when both main routes are safely spaced", () => {
    const input = fixture(), result = assessDifferentialPairGeometry({ ...input, tracks: [...input.tracks, track("nStub", "N", point(50, 10), point(50, 1))] });
    expect(result.allTrackPairGaps).toHaveLength(2);
    expect(result.allTrackPairGaps!.find(gap => gap.negativeUuid === "nStub")!.minimumGap).toBe("fail");
    expect(result.checks.minimumGap.status).toBe("fail");
    expect(result.checks.topology.status).toBe("pass");
  });
  it("applies each pair's own width sum instead of selecting only the closest centerline", () => {
    const input = fixture(), result = assessDifferentialPairGeometry({ ...input, tracks: [input.tracks[0]!, track("n0", "N", point(0, 10), point(50, 10), 2),
      track("n1", "N", point(50, 10), point(100, 10), 30)] });
    expect(result.allTrackPairGaps!.map(gap => gap.minimumGap)).toEqual(["pass", "fail"]);
    expect(result.checks.minimumGap.status).toBe("fail");
  });
  it("retains far parallel intervals as uncoupled and applies maximum gap only to eligible paired spans", () => {
    const input = fixture([point(0, 0), point(100, 0)], [point(0, 50), point(100, 50)]);
    const result = assessDifferentialPairGeometry({ ...input, limits: { ...input.limits, maximumUncoupledLengthNm: 99 } });
    expect(result.coupling!.paired).toEqual([]);
    expect(result.coupling!.positiveCoverage[0]!.reasons).toContain("PARALLEL_GAP_EXCEEDS_COUPLING_MAXIMUM");
    expect(result.coupling!.positiveUncoupledLength).toEqual(integerLength(100));
    expect(result.checks.uncoupled.status).toBe("fail");
    expect(result.checks.minimumGap.status).toBe("pass");
    expect(result.checks.coupledGap.status).toBe("not_assessed");
  });
  it("does not couple antiparallel paths or zero-length projected overlaps", () => {
    const antiparallel = assessDifferentialPairGeometry(fixture([point(0, 0), point(100, 0)], [point(100, 10), point(0, 10)]));
    expect(antiparallel.coupling!.paired).toEqual([]);
    expect(antiparallel.coupling!.positiveUncoupledLength).toEqual(integerLength(100));
    const touchingProjection = assessDifferentialPairGeometry(fixture([point(0, 0), point(10, 0)], [point(10, 2), point(20, 2)]));
    expect(touchingProjection.coupling!.paired).toEqual([]);
  });
  it("retains competing parallel meander intervals as ambiguous on both members", () => {
    const input = fixture([point(0, 0), point(100, 0), point(100, 2), point(0, 2), point(0, 4), point(100, 4)]);
    const result = assessDifferentialPairGeometry(input);
    expect(result.checks.topology.status).toBe("pass");
    expect(result.coupling!.status).toBe("ambiguous");
    expect(result.coupling!.paired).toEqual([]);
    expect(result.coupling!.positiveCoverage.filter(interval => interval.status === "ambiguous")).toHaveLength(2);
    expect(result.coupling!.negativeCoverage[0]!.candidateMateRunIndices).toEqual([0, 4]);
    expect(result.checks.uncoupled.status).toBe("fail");
  });
  it("keeps uniquely paired prefixes when only a later subinterval has competing mates", () => {
    const input = fixture([point(0, 0), point(100, 0)], [point(0, 10), point(100, 10), point(110, 20), point(40, 20), point(40, 30), point(50, 40), point(100, 40)]);
    const result = assessDifferentialPairGeometry({ ...input, limits: { ...input.limits, maximumCoupledGapNm: 40 } });
    expect(result.coupling!.status).toBe("ambiguous");
    expect(result.coupling!.paired).toHaveLength(1);
    expect(result.coupling!.paired[0]!.length).toEqual(integerLength(50));
    expect(result.coupling!.positiveCoverage.map(interval => interval.status)).toEqual(["paired", "ambiguous"]);
    expect(result.coupling!.negativeCoverage[0]!.status).toBe("paired");
    expect(result.coupling!.positiveUncoupledLength).toEqual(integerLength(50));
  });
  it("rejects uniquely local matches whose source-to-receiver correspondence reverses order", () => {
    const input = fixture([point(0, 0), point(10, 0), point(10, 100), point(20, 100), point(30, 100)],
      [point(20, 104), point(30, 104), point(40, 114), point(-10, 114), point(-10, 4), point(0, 4), point(10, 4)]);
    const result = assessDifferentialPairGeometry({ ...input, limits: { ...input.limits, maximumCoupledGapNm: 4 } });
    expect(result.checks.topology.status).toBe("pass");
    expect(result.coupling!.status).toBe("ambiguous");
    expect(result.coupling!.paired).toEqual([]);
    expect(result.coupling!.positiveCoverage.filter(interval => interval.reasons.includes("NON_MONOTONE_CORRESPONDENCE"))).toHaveLength(2);
    expect(result.coupling!.negativeCoverage.filter(interval => interval.reasons.includes("NON_MONOTONE_CORRESPONDENCE"))).toHaveLength(2);
  });
  it("does not turn different copper layers into a planar clearance pass", () => {
    const input = fixture(), result = assessDifferentialPairGeometry({ ...input, tracks: input.tracks.map(item => item.net === "N" ? { ...item, layer: "B.Cu" } : item),
      pads: input.pads.map(item => item.net === "N" ? { ...item, layers: ["B.Cu"] } : item) });
    expect(result.allTrackPairGaps![0]!.layerRelationship).toBe("different_layer_not_assessed");
    expect(result.allTrackPairGaps![0]!.centerlineSquaredNm2).toBeNull();
    expect(result.checks.minimumGap.status).toBe("not_assessed");
    expect(result.checks.transitions.status).toBe("fail");
  });
  it.each([[point(0, 0), point(100, 1), "UNSUPPORTED_NON_OCTILINEAR_TRACK"], [point(0, 0), point(0, 0), "ZERO_LENGTH_TRACK"]] as const)(
    "does not round unsupported or zero-length directions", (start, end, code) => {
      const input = fixture(), result = assessDifferentialPairGeometry({ ...input, tracks: [track("bad", "P", start, end), input.tracks[1]!] });
      expect(result.diagnostics).toContain(`${code}:bad`);
      expect(result.selected.tracks[0]!.end).toEqual(end);
      expect(result.routes.positive.mainChain).toBeNull();
      expect(result.checks.topology.status).toBe("not_assessed");
    });
  it("declines excessive complete inventories without truncating them into a passing subset", () => {
    const input = fixture(), tracks = Array.from({ length: 257 }, (_, i) => track(`bound${i}`, i % 2 ? "N" : "P", point(0, i * 20), point(100, i * 20)));
    const result = assessDifferentialPairGeometry({ ...input, tracks });
    expect(result.selected.tracks).toHaveLength(257);
    expect(result.inventoryComplete).toBe(false);
    expect(result.allTrackPairGaps).toBeNull();
    expect(result.routes.positive.edges).toBeNull();
    expect(result.checks.minimumGap.status).toBe("not_assessed");
  });
  it("does not convert unsafe or non-integer source coordinates to rounded nanometres", () => {
    const input = fixture(), result = assessDifferentialPairGeometry({ ...input, tracks: [{ ...input.tracks[0]!, end: point(100.5, 0) }, input.tracks[1]!] });
    expect(result.diagnostics).toContain("INVALID_TRACK_GEOMETRY");
    expect(result.selected.tracks[0]!.end.xNm).toBe(100.5);
    expect(result.allTrackPairGaps).toBeNull();
  });
});
