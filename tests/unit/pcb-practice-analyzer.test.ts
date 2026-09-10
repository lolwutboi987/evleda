import { describe, expect, it } from "vitest";

import {
  PCB_PRACTICE_ANALYSIS_SCHEMA,
  PCB_PRACTICE_ANALYSIS_PROFILE_SCHEMA,
  PcbPracticeAnalyzerError,
  analyzeKicadPcbPractices,
  validateAndSnapshotPcbPracticeAnalysisProfile,
  type PcbPracticeAnalysisProfile,
} from "../../src/integrations/pcb-practice-analyzer.js";

const RECTANGULAR_OUTLINE = [
  '  (gr_line (start 0 0) (end 10 0) (stroke (width 0.05) (type default)) (layer "Edge.Cuts") (uuid "edge-1"))',
  '  (gr_line (start 10 0) (end 10 10) (stroke (width 0.05) (type default)) (layer "Edge.Cuts") (uuid "edge-2"))',
  '  (gr_line (start 10 10) (end 0 10) (stroke (width 0.05) (type default)) (layer "Edge.Cuts") (uuid "edge-3"))',
  '  (gr_line (start 0 10) (end 0 0) (stroke (width 0.05) (type default)) (layer "Edge.Cuts") (uuid "edge-4"))',
] as const;

function board(body: readonly string[], outline: readonly string[] = RECTANGULAR_OUTLINE): string {
  return ["(kicad_pcb", ...outline, ...body, ")", ""].join("\n");
}

function profile(options: {
  readonly minimumInteriorAngleDeg?: number;
  readonly restrictViaSpan?: boolean;
  readonly defaultNetClass?: boolean;
  readonly coordinateToleranceMm?: number;
  readonly includeEdgeMinimums?: boolean;
} = {}): PcbPracticeAnalysisProfile {
  const allowedLayerTransitions = options.restrictViaSpan
    ? [{ startLayer: "F.Cu", endLayer: "In1.Cu" }]
    : [
        { startLayer: "F.Cu", endLayer: "In1.Cu" },
        { startLayer: "F.Cu", endLayer: "B.Cu" },
      ];
  return {
    schemaVersion: PCB_PRACTICE_ANALYSIS_PROFILE_SCHEMA,
    sourceValidation: {
      mode: "fixture",
      supportedBoardVersions: [20260206],
    },
    copperLayerOrder: ["F.Cu", "In1.Cu", "B.Cu"],
    netClasses: [{
      id: "signal",
      sourceRuleId: "design.net-class.signal",
      severity: "error",
      gates: ["human-review"],
      minimumTrackWidthMm: 0.2,
      ...(options.includeEdgeMinimums === false
        ? {}
        : {
            minimumTraceToBoardEdgeMm: 0.15,
            traceToBoardEdgeDisposition: {
              sourceRuleId: "design.net-class.signal.edge",
              severity: "error" as const,
              gates: ["human-review" as const],
            },
          }),
      ...(options.minimumInteriorAngleDeg === undefined
        ? {}
        : {
            minimumInteriorAngleDeg: options.minimumInteriorAngleDeg,
            interiorAngleDisposition: {
              sourceRuleId: "design.net-class.signal.bend",
              severity: "error" as const,
              gates: ["human-review" as const],
            },
          }),
    }],
    netClassByNet: { SIG: "signal" },
    ...(options.defaultNetClass === true ? { defaultNetClassId: "signal" } : {}),
    ...(options.coordinateToleranceMm === undefined
      ? {}
      : { coordinateToleranceMm: options.coordinateToleranceMm }),
    viaRules: [{
      id: "design-via",
      sourceRuleId: "design.via.signal",
      severity: "error",
      gates: ["human-review"],
      appliesTo: { netClassIds: ["signal"], viaTypes: ["through", "blind", "micro"] },
      minimumPadDiameterMm: 0.3,
      minimumDrillDiameterMm: 0.15,
      minimumAnnularRingMm: 0.08,
      allowedLayerTransitions,
    }],
    advisories: {
      rightAngle: { sourceRuleId: "practice.turn.right-angle", toleranceDeg: 0.25 },
      reversal: { sourceRuleId: "practice.turn.reversal", maximumInteriorAngleDeg: 2 },
      adjacentHairpin: {
        sourceRuleId: "practice.route.hairpin",
        parallelToleranceDeg: 0.25,
        maximumLegEdgeGapMm: 0.2,
        minimumParallelOverlapMm: 1,
        maximumConnectorPathLengthMm: 0.6,
      },
    },
    diagnostics: {
      invalidGeometrySourceRuleId: "native.geometry.validity",
      unboundNetSourceRuleId: "profile.net-binding.required",
      unsupportedOutlineSourceRuleId: "native.outline.phase1-support",
      unsupportedRoutingSourceRuleId: "native.routing.phase1-support",
      junctionCoverageSourceRuleId: "native.routing.junction-coverage",
      containmentSourceRuleId: "native.board-material.containment",
      duplicateTrackSourceRuleId: "native.routing.duplicate-track",
    },
    fabrication: {
      declarationId: "fixture-fab-declaration-2026-09-05",
      minimumTrackWidth: {
        sourceRuleId: "fab.declared.track-width",
        minimumMm: 0.18,
        severity: "error",
      },
      ...(options.includeEdgeMinimums === false
        ? {}
        : {
            minimumTraceToBoardEdge: {
              sourceRuleId: "fab.declared.copper-edge",
              minimumMm: 0.25,
              severity: "error" as const,
            },
          }),
      viaRules: [{
        id: "fab-via",
        sourceRuleId: "fab.declared.via",
        severity: "error",
        appliesTo: { viaTypes: ["through", "blind", "micro"] },
        minimumPadDiameterMm: 0.28,
        minimumDrillDiameterMm: 0.1,
        minimumAnnularRingMm: 0.07,
        allowedLayerTransitions,
      }],
    },
  };
}

function findingsWithCode(
  result: ReturnType<typeof analyzeKicadPcbPractices>,
  code: string,
) {
  return result.findings.filter((finding) => finding.code === code);
}

function expectAnalyzerError(action: () => unknown, code: PcbPracticeAnalyzerError["code"]): void {
  try {
    action();
    throw new Error("Expected PCB practice analyzer error");
  } catch (error) {
    expect(error).toBeInstanceOf(PcbPracticeAnalyzerError);
    expect(error).toMatchObject({ code });
  }
}

describe("native KiCad PCB practice analyzer", () => {
  it("keeps a generic 90 degree turn advisory, but hard-fails the same geometry under a 135 degree class rule", () => {
    const source = board([
      '  (segment (start 2 2) (end 4 2) (width 0.25) (layer "F.Cu") (net "SIG") (uuid "turn-a"))',
      '  (segment (start 4 2) (end 4 4) (width 0.25) (layer "F.Cu") (net "SIG") (uuid "turn-b"))',
    ]);

    const generic = analyzeKicadPcbPractices(source, profile(), { sourcePath: "fixture.kicad_pcb" });
    const advisory = findingsWithCode(generic, "RIGHT_ANGLE_TURN_ADVISORY");
    expect(advisory).toHaveLength(1);
    expect(advisory[0]).toMatchObject({
      severity: "advisory",
      sourceRuleIds: ["practice.turn.right-angle"],
      gates: ["human-review"],
      observed: { interiorAngleDeg: 90, directionChangeDeg: 90 },
    });
    expect(advisory[0]!.evidence.map((entry) => entry.location.uuid)).toEqual(["turn-a", "turn-b"]);
    expect(advisory[0]!.evidence[0]!.location).toMatchObject({
      sourcePath: "fixture.kicad_pcb",
      form: "segment",
      line: 6,
      column: 3,
    });
    expect(generic.outcome).toBe("review");

    const strict = analyzeKicadPcbPractices(source, profile({ minimumInteriorAngleDeg: 135 }));
    expect(findingsWithCode(strict, "RIGHT_ANGLE_TURN_ADVISORY")).toHaveLength(0);
    expect(findingsWithCode(strict, "TURN_BELOW_NET_CLASS_MINIMUM")).toEqual([
      expect.objectContaining({
        severity: "error",
        sourceRuleIds: ["design.net-class.signal.bend"],
        observed: expect.objectContaining({ classification: "right-angle", interiorAngleDeg: 90 }),
        required: { minimumInteriorAngleDeg: 135 },
      }),
    ]);
    expect(strict.outcome).toBe("fail");
  });

  it("classifies a reversal only at a true degree-two connected node, not between unrelated collinear segments", () => {
    const result = analyzeKicadPcbPractices(board([
      '  (segment (start 1 2) (end 3 2) (width 0.25) (layer "F.Cu") (net "SIG") (uuid "reverse-in"))',
      '  (segment (start 3 2) (end 2 2.01) (width 0.25) (layer "F.Cu") (net "SIG") (uuid "reverse-out"))',
      '  (segment (start 5 4) (end 6 4) (width 0.25) (layer "F.Cu") (net "SIG") (uuid "unrelated-a"))',
      '  (segment (start 7 4) (end 8 4) (width 0.25) (layer "F.Cu") (net "SIG") (uuid "unrelated-b"))',
    ]), profile());

    const reversals = result.extracted.turns.filter((turn) => turn.classification === "reversal-candidate");
    expect(reversals).toHaveLength(1);
    expect(reversals[0]).toMatchObject({
      vertex: { x: 3, y: 2 },
      segmentOrdinals: [1, 2],
      interiorAngleDeg: expect.closeTo(0.5729386977, 8),
      directionChangeDeg: expect.closeTo(179.4270613023, 8),
    });
    const finding = findingsWithCode(result, "CONNECTED_REVERSAL_CANDIDATE");
    expect(finding).toHaveLength(1);
    expect(finding[0]!.evidence.map((entry) => entry.location.uuid)).toEqual(["reverse-in", "reverse-out"]);
  });

  it("binds track, edge, via geometry, and layer-transition failures to design and fab rules", () => {
    const result = analyzeKicadPcbPractices(board([
      '  (segment (start 2 0.3) (end 4 0.3) (width 0.15) (layer "F.Cu") (net "SIG") (uuid "thin-edge-track"))',
      '  (via micro (at 5 5) (size 0.26) (drill 0.14) (layers "F.Cu" "B.Cu") (net "SIG") (uuid "bad-microvia"))',
    ]), profile({ restrictViaSpan: true }));

    expect(result.schemaVersion).toBe(PCB_PRACTICE_ANALYSIS_SCHEMA);
    expect(findingsWithCode(result, "TRACK_WIDTH_BELOW_BOUND_MINIMUM")[0]).toMatchObject({
      sourceRuleIds: ["design.net-class.signal", "fab.declared.track-width"],
      gates: ["fabricator-confirmation", "human-review"],
      observed: { widthMm: 0.15, netClassId: "signal" },
      required: { minimumWidthMm: 0.2 },
    });
    expect(findingsWithCode(result, "TRACE_TO_BOARD_EDGE_BELOW_BOUND_MINIMUM")[0]).toMatchObject({
      sourceRuleIds: ["fab.declared.copper-edge"],
      gates: ["fabricator-confirmation"],
      observed: { centerlineDistanceMm: 0.3, copperClearanceMm: 0.22499999999999998 },
      required: { minimumCopperClearanceMm: 0.25 },
    });
    expect(findingsWithCode(result, "VIA_GEOMETRY_BELOW_BOUND_MINIMUM")[0]).toMatchObject({
      sourceRuleIds: ["design.via.signal", "fab.declared.via"],
      gates: ["fabricator-confirmation", "human-review"],
    });
    expect(findingsWithCode(result, "VIA_LAYER_TRANSITION_NOT_ALLOWED")[0]).toMatchObject({
      sourceRuleIds: ["design.via.signal", "fab.declared.via"],
      observed: { type: "micro", layers: ["F.Cu", "B.Cu"] },
    });
    expect(result.extracted.vias[0]).toMatchObject({
      type: "micro",
      padDiameterMm: 0.26,
      drillDiameterMm: 0.14,
      annularRingMm: 0.06,
      layers: ["F.Cu", "B.Cu"],
    });
    expect(result.extracted.layerTransitions[0]).toMatchObject({
      viaOrdinal: 1,
      viaType: "micro",
      startLayer: "F.Cu",
      endLayer: "B.Cu",
      netName: "SIG",
      netClassId: "signal",
    });
    expect(result.summary).toMatchObject({ layerTransitionCount: 1, fabricatorConfirmationRequired: true });
    expect(result.qualificationEstablished).toBe(false);
    expect(result.releaseAuthorized).toBe(false);
  });

  it("reports only connected, profile-envelope adjacent parallel legs as a hairpin candidate", () => {
    const result = analyzeKicadPcbPractices(board([
      '  (segment (start 1 3) (end 4 3) (width 0.25) (layer "F.Cu") (net "SIG") (uuid "leg-a"))',
      '  (segment (start 4 3) (end 4 3.4) (width 0.25) (layer "F.Cu") (net "SIG") (uuid "bridge"))',
      '  (segment (start 4 3.4) (end 1 3.4) (width 0.25) (layer "F.Cu") (net "SIG") (uuid "leg-b"))',
      '  (segment (start 1 5) (end 4 5) (width 0.25) (layer "F.Cu") (net "SIG") (uuid "parallel-but-unrelated"))',
    ]), profile());

    expect(result.extracted.hairpinCandidates).toHaveLength(1);
    expect(result.extracted.hairpinCandidates[0]).toMatchObject({
      legSegmentOrdinals: [1, 3],
      connectorSegmentOrdinals: [2],
      minimumCenterlineSeparationMm: 0.3999999999999999,
      maximumCenterlineSeparationMm: 0.3999999999999999,
      minimumEdgeGapMm: 0.1499999999999999,
      maximumEdgeGapMm: 0.1499999999999999,
      parallelOverlapMm: 3,
      connectorPathLengthMm: 0.3999999999999999,
    });
    const hairpin = findingsWithCode(result, "ADJACENT_PARALLEL_HAIRPIN_CANDIDATE");
    expect(hairpin).toHaveLength(1);
    expect(hairpin[0]).toMatchObject({
      severity: "advisory",
      sourceRuleIds: ["practice.route.hairpin"],
      gates: ["human-review"],
    });
    expect(hairpin[0]!.evidence.map((entry) => entry.location.uuid)).toEqual(["leg-a", "leg-b", "bridge"]);
  });

  it("fails closed for an unsupported outline and an unbound routed net", () => {
    const unsupportedOutline = [
      '  (gr_curve (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 10)) (stroke (width 0.05) (type default)) (layer "Edge.Cuts") (uuid "curve-edge"))',
    ];
    const result = analyzeKicadPcbPractices(board([
      '  (segment (start 2 2) (end 4 2) (width 0.25) (layer "F.Cu") (net "UNBOUND") (uuid "unknown-net-track"))',
    ], unsupportedOutline), profile());

    expect(result.outcome).toBe("fail");
    expect(result.summary.outlineComplete).toBe(false);
    expect(result.summary.boardEdgePrimitiveCount).toBe(0);
    expect(result.extracted.segments[0]!.netClassId).toBeNull();
    expect(result.extracted.segments[0]!.clearanceToBoardEdgeMm).toBeNull();
    expect(findingsWithCode(result, "BOARD_OUTLINE_GEOMETRY_UNSUPPORTED")).toHaveLength(1);
    expect(findingsWithCode(result, "BOARD_OUTLINE_MISSING")).toHaveLength(1);
    expect(findingsWithCode(result, "ROUTED_NET_CLASS_UNBOUND")).toHaveLength(1);
    expect(result.summary).toMatchObject({
      humanReviewRequired: true,
      fabricatorConfirmationRequired: true,
    });
  });

  it("resolves legacy numeric nets and computes arc distance while failing incomplete arc topology coverage", () => {
    const arcOutline = [
      '  (gr_arc (start 0 5) (mid 5 0) (end 10 5) (stroke (width 0.05) (type default)) (layer "Edge.Cuts") (uuid "arc-top"))',
      '  (gr_arc (start 10 5) (mid 5 10) (end 0 5) (stroke (width 0.05) (type default)) (layer "Edge.Cuts") (uuid "arc-bottom"))',
    ];
    const result = analyzeKicadPcbPractices(board([
      '  (net 1 "SIG")',
      '  (segment (start 4 5) (end 6 5) (width 0.25) (layer "F.Cu") (net 1) (uuid "numeric-net"))',
    ], arcOutline), profile());

    expect(result.outcome).toBe("fail");
    expect(result.summary).toMatchObject({ outlineComplete: false, boardEdgePrimitiveCount: 2 });
    expect(result.extracted.boardEdges.map((edge) => edge.kind)).toEqual(["arc", "arc"]);
    expect(result.extracted.segments[0]).toMatchObject({
      netName: "SIG",
      netClassId: "signal",
      clearanceToBoardEdgeMm: 3.875,
    });
    expect(findingsWithCode(result, "BOARD_OUTLINE_ARC_TOPOLOGY_UNSUPPORTED")).toHaveLength(2);
    expect(result.limitations.join(" ")).toContain("does not establish");
  });

  it("requires one complete root, direct unique critical fields, and strict net ordinals", () => {
    const valid = board([
      '  (property "note" "literal (segment (start 1 1)) text")',
      '  (gr_text_box "Multiline\\n(segment)\\ttext" (start 1 1) (end 2 2) (layer "F.Silkscreen"))',
      '  (segment (start 2 2) (end 4 2) (width 0.25) (layer "F.Cu") (net "SIG") (tstamp 49c9abcd))',
    ]);
    const parsed = analyzeKicadPcbPractices(valid, profile());
    expect(parsed.summary.segmentCount).toBe(1);
    expect(parsed.extracted.segments[0]!.evidence.uuid).toBe("49c9abcd");

    expectAnalyzerError(() => analyzeKicadPcbPractices(valid.trimEnd().slice(0, -1), profile()), "INVALID_KICAD_PCB");
    expectAnalyzerError(() => analyzeKicadPcbPractices(`${valid}THIS IS NOT S-EXPR`, profile()), "INVALID_KICAD_PCB");
    expectAnalyzerError(
      () => analyzeKicadPcbPractices(valid.replace("(kicad_pcb", "(kicad_pcb evil"), profile()),
      "INVALID_KICAD_PCB",
    );
    expectAnalyzerError(() => analyzeKicadPcbPractices(board([
      '  (segment evil (start 2 2) (end 4 2) (width 0.25) (layer "F.Cu") (net "SIG"))',
    ]), profile()), "INVALID_KICAD_PCB");
    expectAnalyzerError(() => analyzeKicadPcbPractices(board([
      '  (segment (start 2 2) (start 9 9) (end 4 2) (width 0.25) (width -4) (layer "F.Cu") (layer "Bogus.Cu") (net "SIG") (net "BAD"))',
    ]), profile()), "INVALID_KICAD_PCB");
    expectAnalyzerError(() => analyzeKicadPcbPractices(board([
      '  (net 1 "SIG")',
      '  (segment (start 2 2) (end 4 2) (width 0.25) (layer "F.Cu") (net 1e0))',
    ]), profile()), "INVALID_KICAD_PCB");
  });

  it("extracts routed arcs but fails coverage instead of silently passing all-arc routing", () => {
    const result = analyzeKicadPcbPractices(board([
      '  (arc (start 2 2) (mid 3 3) (end 4 2) (width 0.1) (layer "F.Cu") (net "SIG") (uuid "a1"))',
    ]), profile());

    expect(result.outcome).toBe("fail");
    expect(result.summary).toMatchObject({
      segmentCount: 0,
      routedArcCount: 1,
      routingCoverageComplete: false,
    });
    expect(result.extracted.routedArcs[0]).toMatchObject({
      uuid: "a1",
      widthMm: 0.1,
      netName: "SIG",
      netClassId: "signal",
    });
    expect(findingsWithCode(result, "ROUTED_ARC_ANALYSIS_UNSUPPORTED")).toHaveLength(1);
  });

  it("recognizes documented bezier Edge.Cuts and fails outline coverage", () => {
    const result = analyzeKicadPcbPractices(board([
      '  (bezier (pts (xy 2 2) (xy 3 1) (xy 4 1) (xy 5 2)) (layer "Edge.Cuts") (uuid "b1"))',
    ]), profile());

    expect(result.outcome).toBe("fail");
    expect(result.summary.outlineComplete).toBe(false);
    expect(findingsWithCode(result, "BOARD_OUTLINE_GEOMETRY_UNSUPPORTED")[0]).toMatchObject({
      observed: { form: "bezier" },
      gates: ["human-review", "fabricator-confirmation"],
    });
  });

  it("fails hard-bend coverage at endpoint tees and endpoint-on-interior junctions", () => {
    const strictProfile = profile({ minimumInteriorAngleDeg: 135 });
    const tee = analyzeKicadPcbPractices(board([
      '  (segment (start 2 2) (end 4 2) (width 0.25) (layer "F.Cu") (net "SIG") (uuid "tee-left"))',
      '  (segment (start 4 2) (end 6 2) (width 0.25) (layer "F.Cu") (net "SIG") (uuid "tee-right"))',
      '  (segment (start 4 2) (end 4 4) (width 0.25) (layer "F.Cu") (net "SIG") (uuid "tee-branch"))',
    ]), strictProfile);
    expect(tee.summary.turnCount).toBe(0);
    expect(findingsWithCode(tee, "TURN_JUNCTION_COVERAGE_UNRESOLVED")[0]).toMatchObject({
      severity: "error",
      sourceRuleIds: ["design.net-class.signal.bend", "native.routing.junction-coverage"],
      observed: { kind: "endpoint-junction", connectedSegmentCount: 3 },
    });

    const interior = analyzeKicadPcbPractices(board([
      '  (segment (start 2 2) (end 6 2) (width 0.25) (layer "F.Cu") (net "SIG") (uuid "trunk"))',
      '  (segment (start 4 2) (end 4 4) (width 0.25) (layer "F.Cu") (net "SIG") (uuid "branch"))',
    ]), strictProfile);
    expect(interior.summary.turnCount).toBe(0);
    expect(findingsWithCode(interior, "TURN_JUNCTION_COVERAGE_UNRESOLVED")[0]).toMatchObject({
      observed: { kind: "endpoint-on-segment-interior" },
    });
  });

  it("uses Euclidean tolerance clustering without round-bin false splits or merges", () => {
    const strictProfile = profile({ minimumInteriorAngleDeg: 135, coordinateToleranceMm: 0.001 });
    const withinTolerance = analyzeKicadPcbPractices(board([
      '  (segment (start 2 2) (end 4.00049 2) (width 0.25) (layer "F.Cu") (net "SIG"))',
      '  (segment (start 4.00051 2) (end 4.00051 4) (width 0.25) (layer "F.Cu") (net "SIG"))',
    ]), strictProfile);
    expect(withinTolerance.summary.turnCount).toBe(1);
    expect(findingsWithCode(withinTolerance, "TURN_BELOW_NET_CLASS_MINIMUM")).toHaveLength(1);

    const outsideTolerance = analyzeKicadPcbPractices(board([
      '  (segment (start 2 2.00049) (end 4.00049 2.00049) (width 0.25) (layer "F.Cu") (net "SIG"))',
      '  (segment (start 3.99951 1.99951) (end 3.99951 4) (width 0.25) (layer "F.Cu") (net "SIG"))',
    ]), strictProfile);
    expect(outsideTolerance.summary.turnCount).toBe(0);
    expect(findingsWithCode(outsideTolerance, "TURN_BELOW_NET_CLASS_MINIMUM")).toHaveLength(0);
  });

  it("reports exact duplicate tracks and suppresses fake reversals and hairpins", () => {
    const result = analyzeKicadPcbPractices(board([
      '  (segment (start 2 2) (end 4 2) (width 0.25) (layer "F.Cu") (net "SIG") (uuid "duplicate-a"))',
      '  (segment (start 2 2) (end 4 2) (width 0.25) (layer "F.Cu") (net "SIG") (uuid "duplicate-b"))',
    ]), profile());

    expect(findingsWithCode(result, "DUPLICATE_ROUTED_TRACK")).toHaveLength(1);
    expect(result.extracted.turns.filter((turn) => turn.classification === "reversal-candidate")).toEqual([]);
    expect(result.extracted.hairpinCandidates).toEqual([]);
  });

  it("rejects a diverging long-leg false hairpin using the full overlap separation envelope", () => {
    const longOutline = [
      '  (gr_line (start 0 0) (end 110 0) (layer "Edge.Cuts"))',
      '  (gr_line (start 110 0) (end 110 10) (layer "Edge.Cuts"))',
      '  (gr_line (start 110 10) (end 0 10) (layer "Edge.Cuts"))',
      '  (gr_line (start 0 10) (end 0 0) (layer "Edge.Cuts"))',
    ];
    const result = analyzeKicadPcbPractices(board([
      '  (segment (start 1 3) (end 101 3) (width 0.25) (layer "F.Cu") (net "SIG"))',
      '  (segment (start 101 3) (end 101 3.4) (width 0.25) (layer "F.Cu") (net "SIG"))',
      '  (segment (start 101 3.4) (end 1 3.8) (width 0.25) (layer "F.Cu") (net "SIG"))',
    ], longOutline), profile());

    expect(result.extracted.hairpinCandidates).toEqual([]);
    expect(findingsWithCode(result, "ADJACENT_PARALLEL_HAIRPIN_CANDIDATE")).toHaveLength(0);
  });

  it("enforces trace and via containment outside the board and inside nested cutouts", () => {
    const outside = analyzeKicadPcbPractices(board([
      '  (segment (start 20 20) (end 22 20) (width 0.25) (layer "F.Cu") (net "SIG") (uuid "outside-track"))',
      '  (via (at 20 20) (size 0.4) (drill 0.2) (layers "F.Cu" "B.Cu") (net "SIG") (uuid "outside-via"))',
    ]), profile({ includeEdgeMinimums: false }));
    expect(findingsWithCode(outside, "TRACE_OUTSIDE_BOARD_MATERIAL")).toHaveLength(1);
    expect(findingsWithCode(outside, "VIA_OUTSIDE_BOARD_MATERIAL")).toHaveLength(1);

    const cutoutOutline = [
      ...RECTANGULAR_OUTLINE,
      '  (gr_circle (center 5 5) (end 6 5) (layer "Edge.Cuts") (uuid "cutout"))',
    ];
    const inCutout = analyzeKicadPcbPractices(board([
      '  (segment (start 4.8 5) (end 5.2 5) (width 0.25) (layer "F.Cu") (net "SIG") (uuid "cutout-track"))',
      '  (via (at 5 5) (size 0.4) (drill 0.2) (layers "F.Cu" "B.Cu") (net "SIG") (uuid "cutout-via"))',
    ], cutoutOutline), profile({ includeEdgeMinimums: false }));
    expect(inCutout.summary.outlineComplete).toBe(true);
    expect(findingsWithCode(inCutout, "TRACE_OUTSIDE_BOARD_MATERIAL")).toHaveLength(1);
    expect(findingsWithCode(inCutout, "VIA_OUTSIDE_BOARD_MATERIAL")).toHaveLength(1);

    const crossing = analyzeKicadPcbPractices(board([
      '  (segment (start 3.5 5) (end 6.5 5) (width 0.25) (layer "F.Cu") (net "SIG") (uuid "crossing-cutout"))',
    ], cutoutOutline), profile({ includeEdgeMinimums: false }));
    expect(findingsWithCode(crossing, "TRACE_OUTSIDE_BOARD_MATERIAL")).toHaveLength(1);
  });

  it("rejects invalid copper layers and unsupported per-layer via padstacks", () => {
    const invalidLayer = analyzeKicadPcbPractices(board([
      '  (segment (start 2 2) (end 4 2) (width 0.25) (layer "Bogus.Cu") (net "SIG"))',
      '  (via (at 5 5) (size 0.4) (drill 0.2) (layers "F.Cu" "Bogus.Cu") (net "SIG"))',
    ]), profile());
    expect(findingsWithCode(invalidLayer, "ROUTED_SEGMENT_GEOMETRY_INVALID")).toHaveLength(1);
    expect(findingsWithCode(invalidLayer, "VIA_GEOMETRY_INVALID")).toHaveLength(1);

    const padstack = analyzeKicadPcbPractices(board([
      '  (via (at 5 5) (size 0.5) (drill 0.2) (layers "F.Cu" "B.Cu") (padstack (mode front_inner_back) (layer "Inner" (size 0.25)) (layer "B.Cu" (size 0.5))) (net "SIG") (uuid "complex-via"))',
    ]), profile());
    expect(findingsWithCode(padstack, "VIA_GEOMETRY_UNSUPPORTED")[0]).toMatchObject({
      severity: "error",
      observed: { unsupportedForms: ["padstack"] },
    });
  });

  it("rejects degenerate, self-intersecting, and non-finite-scale outline geometry", () => {
    for (const outline of [
      ['  (gr_poly (pts (xy 0 0) (xy 5 0) (xy 10 0)) (layer "Edge.Cuts"))'],
      ['  (gr_poly (pts (xy 0 0) (xy 10 10) (xy 0 10) (xy 10 0)) (layer "Edge.Cuts"))'],
    ]) {
      const result = analyzeKicadPcbPractices(board([], outline), profile());
      expect(result.outcome).toBe("fail");
      expect(result.summary.outlineComplete).toBe(false);
      expect(findingsWithCode(result, "BOARD_OUTLINE_TOPOLOGY_INVALID")).toHaveLength(1);
    }
    const extreme = analyzeKicadPcbPractices(board([], [
      '  (gr_circle (center 1e308 0) (end -1e308 0) (layer "Edge.Cuts"))',
    ]), profile());
    expect(extreme.outcome).toBe("fail");
    expect(extreme.summary.outlineComplete).toBe(false);
    expect(findingsWithCode(extreme, "BOARD_OUTLINE_GEOMETRY_INVALID")).toHaveLength(1);
  });

  it("keeps small-scale circle clearance dimensionally correct", () => {
    const result = analyzeKicadPcbPractices(board([
      '  (segment (start 4.995 3.999) (end 5.005 3.999) (width 0.000001) (layer "F.Cu") (net "SIG"))',
    ], [
      '  (gr_circle (center 5 5) (end 5 4) (layer "Edge.Cuts"))',
    ]), profile({ includeEdgeMinimums: false }));
    expect(result.extracted.segments[0]!.clearanceToBoardEdgeMm).toBeCloseTo(0.0009995, 10);
  });

  it("keeps empty nets unbound under a default class and snapshots strict profile data once", () => {
    const emptyNet = analyzeKicadPcbPractices(board([
      '  (segment (start 2 2) (end 4 2) (width 0.25) (layer "F.Cu") (net ""))',
    ]), profile({ defaultNetClass: true }));
    expect(emptyNet.extracted.segments[0]!.netClassId).toBeNull();
    expect(findingsWithCode(emptyNet, "ROUTED_NET_CLASS_UNBOUND")).toHaveLength(1);

    const accessorProfile = profile();
    let reads = 0;
    Object.defineProperty(accessorProfile.netClasses[0]!, "minimumTrackWidthMm", {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? 0.2 : 0;
      },
    });
    expectAnalyzerError(() => validateAndSnapshotPcbPracticeAnalysisProfile(accessorProfile), "INVALID_PROFILE");
    expect(reads).toBe(0);

    const forgedSeverity = profile() as unknown as { netClasses: { severity: string }[] };
    forgedSeverity.netClasses[0]!.severity = "advisory";
    expectAnalyzerError(
      () => validateAndSnapshotPcbPracticeAnalysisProfile(forgedSeverity as unknown as PcbPracticeAnalysisProfile),
      "INVALID_PROFILE",
    );
    const unknownKey = profile() as unknown as Record<string, unknown>;
    unknownKey.extra = true;
    expectAnalyzerError(
      () => validateAndSnapshotPcbPracticeAnalysisProfile(unknownKey as unknown as PcbPracticeAnalysisProfile),
      "INVALID_PROFILE",
    );
    const legacyProfile = profile() as unknown as { schemaVersion: string };
    legacyProfile.schemaVersion = "evleda.pcb-practice-analysis-profile.v1";
    expectAnalyzerError(
      () => validateAndSnapshotPcbPracticeAnalysisProfile(legacyProfile as unknown as PcbPracticeAnalysisProfile),
      "INVALID_PROFILE",
    );
  });

  it("returns a detached deeply frozen result without freezing or aliasing the caller profile", () => {
    const original = profile({ restrictViaSpan: true });
    const originalTransition = original.viaRules[0]!.allowedLayerTransitions![0]!;
    const result = analyzeKicadPcbPractices(board([
      '  (via (at 5 5) (size 0.4) (drill 0.2) (layers "F.Cu" "B.Cu") (net "SIG"))',
    ]), original);
    const required = findingsWithCode(result, "VIA_LAYER_TRANSITION_NOT_ALLOWED")[0]!.required as {
      readonly allowedLayerTransitions: readonly { readonly startLayer: string }[];
    };
    expect(required.allowedLayerTransitions[0]).not.toBe(originalTransition);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(required.allowedLayerTransitions[0])).toBe(true);
    expect(Object.isFrozen(originalTransition)).toBe(false);
    expect(() => {
      (required.allowedLayerTransitions[0] as { startLayer: string }).startLayer = "B.Cu";
    }).toThrow();
    expect(originalTransition.startLayer).toBe("F.Cu");
  });

  it("rejects tangent circular outlines analytically rather than trusting coarse tessellation", () => {
    const result = analyzeKicadPcbPractices(board([], [
      '  (gr_circle (center 0 0) (end 10 0) (layer "Edge.Cuts") (uuid "circle-1"))',
      '  (gr_circle (center 19.980964431637155 0.8723877473067199) (end 29.980964431637155 0.8723877473067199) (layer "Edge.Cuts") (uuid "circle-2"))',
    ]), profile());
    expect(result.outcome).toBe("fail");
    expect(result.summary.outlineComplete).toBe(false);
    expect(findingsWithCode(result, "BOARD_OUTLINE_TOPOLOGY_INVALID")[0]!.message).toContain("Circular");
  });

  it("hard-marks unknown via pad-presence modifiers and root copper graphics as incomplete", () => {
    const via = analyzeKicadPcbPractices(board([
      '  (via (at 5 5) (size 0.4) (drill 0.2) (layers "F.Cu" "B.Cu") (start_end_only yes) (net "SIG") (uuid "start-end-via"))',
    ]), profile());
    expect(findingsWithCode(via, "VIA_GEOMETRY_UNSUPPORTED")[0]).toMatchObject({
      observed: { unsupportedForms: ["start_end_only"] },
    });
    expect(via.summary.routingCoverageComplete).toBe(false);

    const copperGraphic = analyzeKicadPcbPractices(board([
      '  (gr_line (start 2 2) (end 4 2) (layer "F.Cu") (net "SIG") (uuid "graphic-copper"))',
    ]), profile());
    expect(findingsWithCode(copperGraphic, "COPPER_GRAPHIC_ROUTING_UNSUPPORTED")).toHaveLength(1);
    expect(copperGraphic.summary).toMatchObject({ segmentCount: 0, routingCoverageComplete: false });
  });

  it("requires safe net ordinals and globally unique analyzed native identities", () => {
    expectAnalyzerError(() => analyzeKicadPcbPractices(board([
      '  (net 9007199254740993 "SIG")',
      '  (segment (start 2 2) (end 4 2) (width 0.25) (layer "F.Cu") (net 9007199254740993))',
    ]), profile()), "INVALID_KICAD_PCB");
    expectAnalyzerError(() => analyzeKicadPcbPractices(board([
      '  (segment (start 2 2) (end 4 2) (width 0.25) (layer "F.Cu") (net "SIG") (uuid "same"))',
      '  (segment (start 4 2) (end 6 2) (width 0.25) (layer "F.Cu") (net "SIG") (uuid "same"))',
    ]), profile()), "INVALID_KICAD_PCB");
  });

  it("rejects sparse/accessor arrays without invoking them and handles prototype-like net names", () => {
    const arrayAccessor = profile();
    let reads = 0;
    Object.defineProperty(arrayAccessor.netClasses, "0", {
      enumerable: true,
      get: () => {
        reads += 1;
        return profile().netClasses[0];
      },
    });
    expectAnalyzerError(() => validateAndSnapshotPcbPracticeAnalysisProfile(arrayAccessor), "INVALID_PROFILE");
    expect(reads).toBe(0);

    const sparse = profile() as unknown as { netClasses: unknown[] };
    sparse.netClasses = new Array(1);
    expectAnalyzerError(
      () => validateAndSnapshotPcbPracticeAnalysisProfile(sparse as unknown as PcbPracticeAnalysisProfile),
      "INVALID_PROFILE",
    );

    const prototypeName = profile({ defaultNetClass: true });
    const result = analyzeKicadPcbPractices(board([
      '  (segment (start 2 2) (end 4 2) (width 0.25) (layer "F.Cu") (net "toString"))',
    ]), prototypeName);
    expect(result.extracted.segments[0]!.netClassId).toBe("signal");
    expect(findingsWithCode(result, "ROUTED_NET_CLASS_UNBOUND")).toHaveLength(0);
  });

  it("rejects malformed UTF-8 board bytes", () => {
    const prefix = Buffer.from(board(['  (property "note" "ok")']));
    const closingQuote = prefix.indexOf(Buffer.from('ok"')) + 2;
    prefix[closingQuote - 1] = 0xff;
    expectAnalyzerError(() => analyzeKicadPcbPractices(prefix, profile()), "INVALID_KICAD_PCB");
  });

  it("binds supported source versions and native copper layers, with headerless input limited to fixture mode", () => {
    const nativeHeader = [
      "  (version 20260206)",
      '  (layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (2 "B.Cu" signal))',
    ];
    const valid = analyzeKicadPcbPractices(board([
      ...nativeHeader,
      '  (segment (start 2 2) (end 4 2) (width 0.25) (layer "In1.Cu") (net "SIG"))',
    ]), profile());
    expect(valid.extracted.segments[0]!.layer).toBe("In1.Cu");

    expectAnalyzerError(() => analyzeKicadPcbPractices(board([
      "  (version 99999999)",
      '  (layers (0 "F.Cu" signal) (2 "B.Cu" signal))',
    ]), profile()), "INVALID_KICAD_PCB");
    expectAnalyzerError(() => analyzeKicadPcbPractices(board([
      "  (version 20260206)",
      '  (layers (0 "F.Cu" signal) (2 "B.Cu" signal))',
      '  (segment (start 2 2) (end 4 2) (width 0.25) (layer "In1.Cu") (net "SIG"))',
    ]), profile()), "INVALID_KICAD_PCB");

    const production = profile() as unknown as {
      sourceValidation: { mode: "production" | "fixture"; supportedBoardVersions: number[] };
    };
    production.sourceValidation.mode = "production";
    expectAnalyzerError(
      () => analyzeKicadPcbPractices(board([]), production as unknown as PcbPracticeAnalysisProfile),
      "INVALID_KICAD_PCB",
    );

    const selfAuthorizedFuture = profile() as unknown as {
      sourceValidation: { mode: "production" | "fixture"; supportedBoardVersions: number[] };
    };
    selfAuthorizedFuture.sourceValidation.supportedBoardVersions = [99999999];
    expectAnalyzerError(
      () => analyzeKicadPcbPractices(board([
        "  (version 99999999)",
        '  (layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (2 "B.Cu" signal))',
      ]), selfAuthorizedFuture as unknown as PcbPracticeAnalysisProfile),
      "INVALID_PROFILE",
    );
  });

  it("orders equal-location findings by severity and keeps UUID-backed IDs stable across earlier insertions", () => {
    const warningProfile = profile({ includeEdgeMinimums: false }) as unknown as {
      netClasses: { severity: "warning" | "error" }[];
      fabrication: { minimumTrackWidth: { severity: "warning" | "error" } };
    };
    warningProfile.netClasses[0]!.severity = "warning";
    warningProfile.fabrication.minimumTrackWidth.severity = "warning";
    const outside = analyzeKicadPcbPractices(board([
      '  (segment (start 20 20) (end 22 20) (width 0.1) (layer "F.Cu") (net "SIG") (uuid "ordered"))',
    ]), warningProfile as unknown as PcbPracticeAnalysisProfile);
    const sameLocation = outside.findings.filter((finding) =>
      finding.evidence.some((entry) => entry.location.uuid === "ordered")
    );
    expect(sameLocation.map((finding) => finding.severity).slice(0, 2)).toEqual(["error", "warning"]);

    const baselineSource = board([
      '  (segment (start 2 2) (end 4 2) (width 0.1) (layer "F.Cu") (net "SIG") (uuid "stable-track"))',
    ]);
    const insertedSource = board([
      '  (segment (start 1 1) (end 2 1) (width 0.25) (layer "F.Cu") (net "SIG") (uuid "earlier-track"))',
      '  (segment (start 2 2) (end 4 2) (width 0.1) (layer "F.Cu") (net "SIG") (uuid "stable-track"))',
    ]);
    const baselineFinding = findingsWithCode(
      analyzeKicadPcbPractices(baselineSource, profile()),
      "TRACK_WIDTH_BELOW_BOUND_MINIMUM",
    )[0]!;
    const insertedFinding = findingsWithCode(
      analyzeKicadPcbPractices(insertedSource, profile()),
      "TRACK_WIDTH_BELOW_BOUND_MINIMUM",
    ).find((finding) => finding.evidence[0]?.location.uuid === "stable-track")!;
    expect(insertedFinding.id).toBe(baselineFinding.id);
  });

  it("bounds the via-count by profile-selector work product before rule application", () => {
    const oversized = profile() as unknown as {
      viaRules: { appliesTo: { netNames: string[] } }[];
    };
    oversized.viaRules[0]!.appliesTo.netNames = Array.from({ length: 10_000 }, (_unused, index) => `N${index}`);
    const vias = Array.from({ length: 101 }, (_unused, index) =>
      `  (via (at ${2 + index / 100} 5) (size 0.4) (drill 0.2) (layers "F.Cu" "B.Cu") (net "SIG"))`
    );
    expectAnalyzerError(
      () => analyzeKicadPcbPractices(board(vias), oversized as unknown as PcbPracticeAnalysisProfile),
      "INVALID_KICAD_PCB",
    );
  });

  it("is byte-for-byte deterministic across a small native-source mutation corpus", () => {
    const seed = board([
      '  (segment (start 2 2) (end 4 2) (width 0.25) (layer "F.Cu") (net "SIG") (uuid "seed-track"))',
      '  (via (at 5 5) (size 0.4) (drill 0.2) (layers "F.Cu" "B.Cu") (net "SIG") (uuid "seed-via"))',
    ]);
    const corpus = [
      seed,
      seed.replace("(width 0.25)", "(width 0.19)"),
      seed.replace('(net "SIG") (uuid "seed-track")', '(net "MUTATED") (uuid "seed-track")'),
      seed.replace("(via (at 5 5)", "(via future (at 5 5)"),
      seed.replace("(gr_line (start 0 0)", "(gr_curve (start 0 0)"),
    ];

    for (const [mutationIndex, source] of corpus.entries()) {
      const first = analyzeKicadPcbPractices(source, profile(), {
        sourcePath: `mutation-${mutationIndex}.kicad_pcb`,
      });
      const second = analyzeKicadPcbPractices(source, profile(), {
        sourcePath: `mutation-${mutationIndex}.kicad_pcb`,
      });
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
      expect(new Set(first.findings.map((finding) => finding.id)).size).toBe(first.findings.length);
      for (const finding of first.findings) {
        expect(finding.id).toMatch(/^PCB-PRACTICE-[0-9a-f]{24}(?:-\d+)?$/u);
      }
      for (const finding of first.findings) {
        expect(finding.sourceRuleIds).toEqual(
          [...finding.sourceRuleIds].sort((left, right) => left.localeCompare(right, "en-US")),
        );
      }
    }
  });
});
