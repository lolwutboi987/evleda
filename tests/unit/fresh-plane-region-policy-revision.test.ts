import { afterEach, describe, expect, it } from "vitest";
import { assertPlanePlacementRevisionScope, assertPlaneRegionPolicyRevisionScope, assertPlaneViaBudgetRevisionScope,
  planPlanePlacementRevisionSources } from "../../src/harness/fresh-plane-placement-revision.js";
import { parseFreshPcbSource } from "../../src/harness/fresh-kicad-parser.js";
import { createFreshPlaneRules } from "../../src/harness/fresh-plane-rules.js";
import { placementRevisionFixture } from "../helpers/placement-revision-fixture.js";
const owned: Awaited<ReturnType<typeof placementRevisionFixture>>[] = [];
afterEach(async () => { for (const h of owned.splice(0)) await h.f.cleanup(); });
async function fixture() {
  const h = await placementRevisionFixture({ regionalPlane: true }); owned.push(h);
  const revised = structuredClone(h.draft);
  Object.assign(revised.planes.find(p => p.id === "BACK_GND")!.islandPolicy, { requireSingleConnectedComponent: false,
    referencePlaneId: "GND_PLANE", engineeringBasis: "Each supplemental stored region must retain qualified contact and area evidence; primary signal references remain unchanged." });
  return { ...h, revised, regional: h.f.compile(revised, "Explicit supplemental-region engineering revision") };
}
describe("separate supplemental-region policy revision", () => {
  it("preserves source geometry and schematic while separately binding the revised policy", async () => {
    const h = await fixture(), before = structuredClone(h.input.sources);
    const result = planPlanePlacementRevisionSources({ ...h.input, targetBundle: h.regional, revisionKind: "plane-regions" });
    expect(h.input.sources).toEqual(before); expect(result.sources.sch).toBe(before.sch);
    expect(parseFreshPcbSource(result.sources.pcb).segments).toEqual(parseFreshPcbSource(before.pcb).segments);
    expect(parseFreshPcbSource(result.sources.pcb).vias).toEqual(parseFreshPcbSource(before.pcb).vias);
    expect(result.sources.dru).toBe(createFreshPlaneRules(h.regional).source);
    expect(result.receipt.schemaVersion).toBe("evleda.plane-region-policy-revision-source-plan.v1");
    expect(result.receipt).toMatchObject({ freshnessTransferred: false, acceptanceEvaluated: false, routingGeometryPreserved: true });
    expect(() => assertPlanePlacementRevisionScope(h.source, h.regional)).toThrow();
    expect(() => assertPlaneViaBudgetRevisionScope(h.source, h.regional)).toThrow();
  });
  it("rejects copied bundles, no-op and rationale-only revisions", async () => {
    const h = await fixture();
    expect(() => assertPlaneRegionPolicyRevisionScope(structuredClone(h.source), h.regional)).toThrow("authenticated");
    expect(() => assertPlaneRegionPolicyRevisionScope(h.source, h.source)).toThrow("must change");
    const rationale = structuredClone(h.revised); Object.assign(rationale.planes.find(p => p.id === "BACK_GND")!.islandPolicy, { engineeringBasis: "Different text only." });
    expect(() => assertPlaneRegionPolicyRevisionScope(h.regional, h.f.compile(rationale))).toThrow("substantive");
  });
  it.each(["area", "clearance", "plane-boundary", "placement", "via-budget", "circuit"])("rejects an accompanying %s change", async kind => {
    const h = await fixture(), d = structuredClone(h.revised), plane = d.planes.find(p => p.id === "BACK_GND")!;
    if (kind === "area") plane.islandPolicy.minimumAreaMm2 += .01;
    if (kind === "clearance") plane.clearanceMm += .01;
    if (kind === "plane-boundary") plane.boundary.minXmm += .01;
    if (kind === "placement") d.placementConstraints[0]!.regionMm.minXmm += .01;
    if (kind === "via-budget") d.routingConstraints.viaPolicy.maxTotal += 1;
    if (kind === "circuit") d.components[0]!.value += " changed";
    expect(() => assertPlaneRegionPolicyRevisionScope(h.source, h.f.compile(d))).toThrow("only supplemental component-policy");
  });
});
