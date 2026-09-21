import { describe, expect, it } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { createPcbLibrarySourceSelection, type PcbLibrarySourceSelectionRequest } from "../../src/harness/pcb-library-source-binding.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { assessFreshPlanePlacement, isFreshPlanePlacementAssessment } from "../../src/harness/fresh-plane-placement-checks.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";
import { genericDividerLibraryResolver } from "../helpers/generic-divider-bundle.js";
import { summarizePlanePlacementChecks } from "../../src/mcp/toolbox-placement-checks.js";

function fixture(options: { gapMm?: number; clearanceMm?: number; angle?: number; missing?: boolean; wrongRegion?: boolean; tamperCourt?: boolean; polygon?: boolean } = {}) {
  const ring = [[-0.5,-0.5],[0.5,-0.5],[0.5,0],[0,0],[0,0.5],[-0.5,0.5]];
  const polygon = ring.map((p,i)=>`(fp_line (start ${p.join(" ")}) (end ${ring[(i+1)%ring.length]!.join(" ")}) (layer "F.CrtYd"))`).join(" ");
  const normal = '(fp_rect (start -0.5 -0.5) (end 0.5 0.5) (layer "F.CrtYd"))';
  const source = `(footprint "test" ${options.polygon ? polygon : normal})`;
  const resolver = { ...genericDividerLibraryResolver,
    readFootprintSource: () => ({ source, sourceIdentity: contentIdentity(source) }),
    captureSourceSelection: (request: PcbLibrarySourceSelectionRequest) => createPcbLibrarySourceSelection({
      policyIdentity: canonicalIdentity({ fixture: true }, "evleda.test-policy.v1"),
      records: (["symbol", "footprint"] as const).flatMap(kind => (kind === "symbol" ? request.symbolIds : request.footprintIds).map(libraryId => ({
        kind, libraryId, sourceIdentity: contentIdentity(kind === "footprint" ? source : libraryId),
        inspectionIdentity: canonicalIdentity({ kind, libraryId }, kind === "symbol" ? "evleda.kicad-stock-symbol-inspection.v1" : "evleda.kicad-stock-footprint-inspection.v2"),
      }))),
    }, request),
  };
  const draft = planeDividerDraft();
  for (const p of draft.placementConstraints) {
    p.edgePreference = p.reference === "J1" ? "left" : "none"; p.minimumCourtyardClearanceMm = options.clearanceMm ?? 0.1;
    p.allowedRotationsDeg = p.reference === "J1" ? [options.angle === -90 ? 270 : 0] : [0,90,180,270];
  }
  const dependencies = { libraryResolver: resolver, deepRuleCatalog: loadDeepRuleCatalog() };
  const compilation = compilePcbPlaneDesignIntentDraft(draft, dependencies);
  if (compilation.disposition !== "ready") throw new Error(JSON.stringify(compilation.issues));
  const compilationBundle = createPcbPlaneCompilationBundle({ compilation, originalPrompt: "Synthetic exact placement test." }, dependencies);
  const x = [5, 6 + (options.gapMm ?? 0.1), 12];
  const pcbSource = `(kicad_pcb (version 20260206) (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
    (gr_rect (start 0 0) (end 30 20) (layer "Edge.Cuts"))
    ${draft.components.map((c,i) => `(footprint "${c.footprintLibId}" (layer "F.Cu") (at ${options.wrongRegion && i === 0 ? 0 : x[i]} 5 ${i === 0 ? options.angle ?? 0 : 0})
      (property "Reference" "${c.reference}") ${options.missing && i === 1 ? "" : options.polygon ? polygon : `(fp_rect (start -0.5 -0.5) (end ${options.tamperCourt && i === 0 ? "0.4" : "0.5"} 0.5) (layer "F.CrtYd"))`})`).join("\n")})`;
  return { compilationBundle, libraryResolver: resolver, pcbSource };
}
describe("V2 exact source placement constraints", () => {
  it("accepts exact minimum gaps without tolerances and binds the complete result", () => {
    const f = fixture(), result = assessFreshPlanePlacement(f);
    expect(result.rows.every(r => r.status === "pass")).toBe(true);
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]!.observations.pairs[0]).toMatchObject({ requiredNm: 100000, distanceSquaredNm2: "10000000000", status: "pass" });
    expect(isFreshPlanePlacementAssessment(result)).toBe(true);
    expect(isFreshPlanePlacementAssessment(structuredClone(result))).toBe(false);
    expect(result.accepted).toBe(false); expect(result.assemblyClearanceClaimed).toBe(false);
    expect(summarizePlanePlacementChecks(result, result.rows).rows).toEqual(result.rows);
  });
  it.each([0.02, 0.099999])("retains the two failing component rows at a %s mm gap", gapMm => {
    const result = assessFreshPlanePlacement(fixture({ gapMm }));
    expect(result.rows.map(r => r.status)).toEqual(["fail", "fail", "pass"]);
    expect(result.rows[0]!.observations.pairs[0]!.status).toBe("fail");
  });
  it("rejects positive-area overlap even when zero courtyard clearance is allowed", () => {
    expect(assessFreshPlanePlacement(fixture({ gapMm: -0.1, clearanceMm: 0 })).rows[0]!.status).toBe("fail");
  });
  it("normalizes periodic cardinal angles without accepting a near-cardinal value", () => {
    expect(assessFreshPlanePlacement(fixture({ angle: -90 })).rows[0]!.observations.poseNm!.rotationDeg).toBe(270);
    expect(assessFreshPlanePlacement(fixture({ angle: 89.999999 })).rows[0]!.status).toBe("unknown");
  });
  it("preserves a region failure when another courtyard is missing", () => {
    const result = assessFreshPlanePlacement(fixture({ wrongRegion: true, missing: true }));
    expect(result.rows[0]!.status).toBe("fail"); expect(result.rows[1]!.status).toBe("unknown");
  });
  it("does not accept an edited courtyard just because it fits on the board", () => {
    const result = assessFreshPlanePlacement(fixture({ tamperCourt: true }));
    expect(result.rows[0]!.status).toBe("fail"); expect(result.rows[0]!.observations.libraryCourtyardMatched).toBe(false);
  });
  it("rejects an unbranded bundle and leaves unsupported source geometry unproved", () => {
    const f = fixture();
    expect(() => assessFreshPlanePlacement({ ...f, compilationBundle: structuredClone(f.compilationBundle) })).toThrow(/authenticated/);
    expect(assessFreshPlanePlacement({ ...f, pcbSource: f.pcbSource.replace("(end 0.5 0.5)", "(end 0.5000001 0.5)") }).rows[0]!.status).toBe("unknown");
  });
  it("does not drop an unexpected footprint from the clearance inventory", () => {
    const f = fixture(), source = f.pcbSource.slice(0,-1) + '(footprint "extra" (property "Reference" "X1") (layer "F.Cu") (at 10 5)) )';
    expect(assessFreshPlanePlacement({ ...f, pcbSource: source }).rows.every(r => r.status === "fail")).toBe(true);
  });
  it("uses conservative enclosures for complete approved orthogonal courtyards without inventing failures", () => {
    const separated = assessFreshPlanePlacement(fixture({ polygon: true }));
    expect(separated.rows.every(r=>r.status==="pass")).toBe(true);
    expect(separated.rows[0]!.observations.pairs[0]!.distanceBasis).toBe("conservative-enclosures");
    expect(summarizePlanePlacementChecks(separated,separated.rows).rows[0]!.status).toBe("pass");
    const uncertain = assessFreshPlanePlacement(fixture({ polygon: true, gapMm: -0.1 }));
    expect(uncertain.rows.slice(0,2).every(r=>r.status==="unknown")).toBe(true);
  });
  it("preserves all pair records in projection and rejects a fabricated pass", () => {
    const result = assessFreshPlanePlacement(fixture({ gapMm: 0.02 }));
    expect(summarizePlanePlacementChecks(result, result.rows).rows.filter(r => r.status === "fail")).toHaveLength(2);
    for (const change of ["missing-pair","false-pair-pass","false-row-pass"] as const) {
      const bad: any = structuredClone(result);
      if (change === "missing-pair") bad.rows[0].observations.pairs.pop();
      if (change === "false-pair-pass") bad.rows[0].observations.pairs[0].status = "pass";
      if (change === "false-row-pass") bad.rows[0].status = "pass";
      const { identity: _, ...payload } = bad; bad.identity = canonicalIdentity(payload,bad.schemaVersion);
      expect(() => summarizePlanePlacementChecks(bad,bad.rows)).toThrow();
    }
  });
});
