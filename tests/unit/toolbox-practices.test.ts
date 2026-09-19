import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createToolboxPracticeAnalyzer } from "../../src/mcp/toolbox-practices.js";
import { PCB_PRACTICE_ANALYSIS_PROFILE_SCHEMA, type PcbPracticeAnalysisProfile } from "../../src/integrations/pcb-practice-analyzer.js";
import { sha256 } from "../../src/core/canonical.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const segment = (start: string, end: string, id: string) => `(segment (start ${start}) (end ${end}) (width 0.1) (layer "F.Cu") (net 1) (uuid "${id}"))`;
const board = (body: string) => `(kicad_pcb (version 20260206) (layers (0 "F.Cu" signal) (31 "B.Cu" signal)) (net 1 "SIG") ${body})`;
async function bind(source: string, profile?: PcbPracticeAnalysisProfile) {
  const root = await mkdtemp(path.join(tmpdir(), "toolbox-practices-")); roots.push(root);
  const pcbPath = path.join(root, "board.kicad_pcb"); await writeFile(pcbPath, source);
  return { run: await createToolboxPracticeAnalyzer({ pcbPath, ...(profile === undefined ? {} : { profile }) }), pcbPath };
}
function profile(): PcbPracticeAnalysisProfile {
  return { schemaVersion: PCB_PRACTICE_ANALYSIS_PROFILE_SCHEMA,
    sourceValidation: { mode: "production", supportedBoardVersions: [20260206] }, copperLayerOrder: ["F.Cu", "B.Cu"],
    netClasses: [{ id: "signal", minimumTrackWidthMm: 0.4, severity: "error", sourceRuleId: "reviewed.width" }], netClassByNet: { SIG: "signal" },
    viaRules: [{ id: "signal-via", sourceRuleId: "reviewed.via", severity: "error", minimumPadDiameterMm: 0.8,
      minimumDrillDiameterMm: 0.4, minimumAnnularRingMm: 0.2, allowedLayerTransitions: [{ startLayer: "F.Cu", endLayer: "B.Cu" }] }],
    advisories: { rightAngle: { sourceRuleId: "reviewed.right-angle", toleranceDeg: 0 }, reversal: { sourceRuleId: "reviewed.reversal", maximumInteriorAngleDeg: 0 },
      adjacentHairpin: { sourceRuleId: "reviewed.hairpin", parallelToleranceDeg: 0, maximumLegEdgeGapMm: 0,
        minimumParallelOverlapMm: 0, maximumConnectorPathLengthMm: 0 } },
    diagnostics: { invalidGeometrySourceRuleId: "geometry", unboundNetSourceRuleId: "unbound", unsupportedOutlineSourceRuleId: "outline",
      unsupportedRoutingSourceRuleId: "routing", junctionCoverageSourceRuleId: "junction", containmentSourceRuleId: "containment", duplicateTrackSourceRuleId: "duplicate" } };
}

describe("host-bound toolbox practice analysis", () => {
  it.each([{ end: "2 0", angle: 0 }, { end: "2 1", angle: 45 }])("accepts measured $angle-degree continuation without declaring readiness", async ({ end, angle }) => {
    const source = board(`${segment("0 0", "1 0", "a")} ${segment("1 0", end, "b")}`);
    const f = await bind(source); const result = await f.run();
    expect(result.turnPolicy.violations).toEqual([]);
    expect(result.geometry.turns[0]!.directionChangeDeg).toBeCloseTo(angle);
    expect(result.sourceIdentity).toEqual({ algorithm: "sha256", digest: sha256(Buffer.from(source)), size: Buffer.byteLength(source) });
    expect(result.analysis).toBeNull();
    expect(result.checks).toMatchObject({ widthAndNetClass: "unverified-no-profile", vias: "unverified-no-profile", manufacturingReadiness: "unverified" });
    expect(result).not.toHaveProperty("passed");
  });

  it.each([{ end: "1 1", angle: 90 }, { end: "2.7320508075688772 1", angle: 30 }])("rejects measured $angle-degree turns", async ({ end, angle }) => {
    const f = await bind(board(`${segment("0 0", "1 0", "a")} ${segment("1 0", end, "b")}`));
    const result = await f.run();
    expect(result.turnPolicy.violations).toHaveLength(1);
    expect(result.turnPolicy.violations[0]!.directionChangeDeg).toBeCloseTo(angle);
  });

  it.each([
    ["9.95 28.4", "10.2 28.65", "10.4 28.85"],
    ["14.3 32.5", "14.55 32.75", "15.51 33.71"],
    ["9.3 27.75", "9.95 28.4", "10.2 28.65"],
    ["14.55 32.1", "14.7 32.25", "15.03 32.58"],
  ])("recognizes the saved diagonal continuation %s -> %s -> %s as straight", async (start, vertex, end) => {
    const f = await bind(board(`${segment(start, vertex, "a")} ${segment(vertex, end, "b")}`));
    const result = await f.run();
    expect(result.turnPolicy.measuredTurnCount).toBe(1);
    expect(result.turnPolicy.violations).toEqual([]);
    expect(result.geometry.turns[0]!.classification).toBe("straight");
    expect(result.geometry.turns[0]!.directionChangeDeg).toBeCloseTo(0, 10);
    expect(result.turnPolicy.numericalToleranceDeg).toBe(1e-7);
  });

  it.each(["2 0.000001", "2 1.000001"])("still rejects the small real deviation ending at %s", async end => {
    const f = await bind(board(`${segment("0 0", "1 0", "a")} ${segment("1 0", end, "b")}`));
    const result = await f.run();
    expect(result.turnPolicy.measuredTurnCount).toBe(1);
    expect(result.turnPolicy.violations).toHaveLength(1);
  });

  it("retains overlap error when a 180-degree reversal cannot be treated as a sequential turn", async () => {
    const f = await bind(board(`${segment("0 0", "1 0", "a")} ${segment("1 0", "0.5 0", "b")}`));
    const result = await f.run();
    expect(result.turnPolicy.unresolvedFindings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "OVERLAPPING_ROUTED_TRACKS", severity: "error" })]));
    expect(result.turnPolicy.measuredTurnCount).toBe(0);
  });

  it("keeps branch junctions explicitly unresolved even without an electrical profile", async () => {
    const f = await bind(board(`${segment("0 0", "1 0", "a")} ${segment("1 0", "2 1", "b")} ${segment("1 0", "2 -1", "c")}`));
    const result = await f.run();
    expect(result.turnPolicy.unresolvedFindings.some(finding => finding.code === "TURN_JUNCTION_COVERAGE_UNRESOLVED")).toBe(true);
  });

  it("does not infer compliant bends for routed arcs", async () => {
    const f = await bind(board('(arc (start 0 0) (mid 1 1) (end 2 0) (width 0.1) (layer "F.Cu") (net 1) (uuid "arc"))'));
    const result = await f.run();
    expect(result.geometry.routedArcCount).toBe(1);
    expect(result.turnPolicy.unresolvedFindings.some(finding => finding.code === "ROUTED_ARC_ANALYSIS_UNSUPPORTED")).toBe(true);
  });

  it("preserves original bound width/via findings and snapshots the reviewed profile", async () => {
    const reviewed = profile();
    const f = await bind(board(`${segment("0 0", "1 0", "a")} (via (at 1 0) (size 0.3) (drill 0.2) (layers "F.Cu" "B.Cu") (net 1) (uuid "v"))`), reviewed);
    (reviewed.netClasses[0] as { minimumTrackWidthMm: number }).minimumTrackWidthMm = 0;
    const result = await f.run();
    expect(result.analysis!.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "TRACK_WIDTH_BELOW_BOUND_MINIMUM", sourceRuleIds: ["reviewed.width"] }),
      expect.objectContaining({ code: "VIA_GEOMETRY_BELOW_BOUND_MINIMUM", sourceRuleIds: ["reviewed.via"] }),
    ]));
    expect(result.analysis!.qualificationEstablished).toBe(false);
    expect(result.checks.electricalSuitability).toBe("unverified");
  });

  it("rejects fixture validation and malformed PCB source instead of reporting checks", async () => {
    const reviewed = profile(); (reviewed.sourceValidation as { mode: string }).mode = "fixture";
    await expect(bind(board(""), reviewed)).rejects.toThrow("production");
    const f = await bind("not a PCB"); await expect(f.run()).rejects.toThrow();
  });
});
