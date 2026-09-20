import { afterEach, describe, expect, it } from "vitest";
import { assertPlanePlacementRevisionScope, assertPlaneViaBudgetRevisionScope,
  planPlanePlacementRevisionSources } from "../../src/harness/fresh-plane-placement-revision.js";
import { parseFreshPcbSource } from "../../src/harness/fresh-kicad-parser.js";
import { createFreshPlaneRules } from "../../src/harness/fresh-plane-rules.js";
import { placementRevisionFixture } from "../helpers/placement-revision-fixture.js";

const fixtures: Awaited<ReturnType<typeof placementRevisionFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.f.cleanup(); });
async function fixture() {
  const h = await placementRevisionFixture({ viaBudgetHeadroom: true }); fixtures.push(h);
  const revised = structuredClone(h.draft);
  const route = revised.routingConstraints.nets.find(n => n.net === "VOUT");
  if (!route || !("maxVias" in route)) throw new Error("Missing routed fixture net");
  route.maxVias = 2;
  return { ...h, revised, target: h.f.compile(revised, "Engineering revision allowing two VOUT vias") };
}

describe("separate via-budget revision", () => {
  it("preserves native geometry and schematic while binding the new count to a separate bundle", async () => {
    const h = await fixture(), input = { ...h.input, targetBundle: h.target, revisionKind: "via-budgets" as const };
    const before = structuredClone(input.sources), result = planPlanePlacementRevisionSources(input);
    expect(input.sources).toEqual(before);
    expect(result.receipt.schemaVersion).toBe("evleda.plane-via-budget-revision-source-plan.v1");
    expect(result.sources.sch).toBe(before.sch);
    expect(parseFreshPcbSource(result.sources.pcb).segments).toEqual(parseFreshPcbSource(before.pcb).segments);
    expect(parseFreshPcbSource(result.sources.pcb).vias).toEqual(parseFreshPcbSource(before.pcb).vias);
    expect(result.sources.dru).toBe(createFreshPlaneRules(h.target).source);
    expect(result.receipt).toMatchObject({ freshnessTransferred: false, acceptanceEvaluated: false,
      nativeAuthoringPerformed: false, routingGeometryPreserved: true });
    expect(() => assertPlanePlacementRevisionScope(h.source, h.target)).toThrow(/only component placement/);
  });

  it("rejects unauthenticated bundles and no-op revisions", async () => {
    const h = await fixture();
    expect(() => assertPlaneViaBudgetRevisionScope(structuredClone(h.source), h.target)).toThrow(/authenticated/);
    expect(() => assertPlaneViaBudgetRevisionScope(h.source, structuredClone(h.target))).toThrow(/authenticated/);
    expect(() => assertPlaneViaBudgetRevisionScope(h.source, h.source)).toThrow(/must change/);
    expect(() => assertPlaneViaBudgetRevisionScope(h.target, h.source)).not.toThrow();
  });

  it("rejects reductions below the source's existing native via count", async () => {
    const h = await fixture();
    const increased = planPlanePlacementRevisionSources({ ...h.input, targetBundle: h.target, revisionKind: "via-budgets" });
    // Replace the existing via's net specifically, leaving its geometry intact.
    const withVia = increased.sources.pcb.replace(/(\(via[\s\S]*?\(net )"GND"/u, '$1"VOUT"');
    expect(() => planPlanePlacementRevisionSources({ name: "seeded", sourceBundle: h.target, targetBundle: h.source,
      sources: { ...increased.sources, pcb: withVia }, revisionKind: "via-budgets" })).toThrow(/existing native via count/);
  });

  it.each(["placement", "clearance", "width", "length", "global-limit", "via-size", "reference", "circuit"])
  ("rejects accompanying %s changes", async change => {
    const h = await fixture(), draft = structuredClone(h.revised);
    if (change === "placement") draft.placementConstraints[1]!.regionMm.minXmm += .01;
    if (change === "clearance") {
      const id = draft.nets.find(net => net.name === "VOUT")!.netClassId;
      draft.netClasses.find(netClass => netClass.id === id)!.clearanceMm += .01;
    }
    if (change === "width") draft.netClasses[0]!.traceWidthMm += .01;
    if (change === "length") {
      const route = draft.routingConstraints.nets.find(n => n.net === "VOUT")!;
      if (!("routeLength" in route)) throw new Error("Missing length rule");
      Object.assign(route.routeLength, { mode: "bounded", maximumMm: 45 });
    }
    if (change === "global-limit") draft.routingConstraints.viaPolicy.maxTotal += 1;
    if (change === "via-size") draft.routingConstraints.viaPolicy.diameterMm += .01;
    if (change === "reference") {
      const route = draft.routingConstraints.nets.find(n => n.net === "VIN")!;
      if (!("referencePath" in route)) throw new Error("Missing reference rule");
      route.referencePath = { mode: "none" };
    }
    if (change === "circuit") draft.components[1]!.value += " changed";
    expect(() => assertPlaneViaBudgetRevisionScope(h.source, h.f.compile(draft))).toThrow(/only per-net via-count/);
  });

  it("does not turn a plane access budget into an ordinary net budget", async () => {
    const h = await fixture(), draft = structuredClone(h.revised);
    const ground = draft.routingConstraints.nets.find(n => n.net === "GND")!;
    if (!("accessRouting" in ground)) throw new Error("Missing plane access");
    ground.accessRouting.maxVias = 1;
    expect(() => assertPlaneViaBudgetRevisionScope(h.source, h.f.compile(draft))).toThrow(/only per-net via-count/);
  });
});
