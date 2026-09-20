import { afterEach, describe, expect, it } from "vitest";
import { assertPlaneTerminalLaunchRevisionScope, planPlanePlacementRevisionSources } from "../../src/harness/fresh-plane-placement-revision.js";
import { parseFreshPcbSource } from "../../src/harness/fresh-kicad-parser.js";
import { createFreshPlaneRules } from "../../src/harness/fresh-plane-rules.js";
import { placementRevisionFixture } from "../helpers/placement-revision-fixture.js";
const owned: Awaited<ReturnType<typeof placementRevisionFixture>>[] = [];
afterEach(async () => { for (const f of owned.splice(0)) await f.f.cleanup(); });
async function fixture() {
  const h = await placementRevisionFixture({ terminalLaunch: true }); owned.push(h);
  const revised = structuredClone(h.draft);
  const route = revised.routingConstraints.nets.find(r => r.net === "VIN");
  if (!route || !("referencePath" in route)) throw new Error("Fixture VIN reference is missing");
  Object.assign(route.referencePath, { terminalLaunches: [{
    signalEndpoint: { reference: "J1", pin: "1" }, referenceEndpoint: { reference: "J1", pin: "3" }, maximumLengthMm: 1,
    maximumReturnSpacingMm: 4, engineeringBasis: "Explicit terminal approach with unchanged native/copper/body constraints." }] });
  return { ...h, revised, launched: h.f.compile(revised, "Explicit launch requirement revision") };
}
describe("separate native terminal-launch revision", () => {
  it("keeps source geometry, schematic and rules exact while binding the new launch intent", async () => {
    const h = await fixture(), original = structuredClone(h.input.sources);
    const result = planPlanePlacementRevisionSources({ ...h.input, targetBundle: h.launched, revisionKind: "terminal-launches" });
    expect(h.input.sources).toEqual(original); expect(result.sources.sch).toBe(original.sch);
    let reboundRules = original.dru;
    const beforeRules = createFreshPlaneRules(h.source), afterRules = createFreshPlaneRules(h.launched);
    for (const before of beforeRules.zones) reboundRules = reboundRules.replaceAll(before.zoneName, afterRules.zones.find(z => z.planeId === before.planeId)!.zoneName);
    expect(result.sources.dru).toBe(reboundRules);
    expect(parseFreshPcbSource(result.sources.pcb).segments).toEqual(parseFreshPcbSource(original.pcb).segments);
    expect(parseFreshPcbSource(result.sources.pcb).vias).toEqual(parseFreshPcbSource(original.pcb).vias);
    expect(result.receipt.schemaVersion).toBe("evleda.plane-terminal-launch-revision-source-plan.v1");
    expect(result.receipt.freshnessTransferred).toBe(false); expect(result.receipt.acceptanceEvaluated).toBe(false);
  });
  it.each(["margin", "terminals", "width", "placement", "plane-policy"])("rejects accompanying %s edits", async kind => {
    const h = await fixture(), d: any = structuredClone(h.revised), r = d.routingConstraints.nets.find((r: any) => r.net === "VIN");
    if (kind === "margin") r.referencePath.coverageMarginMm -= .01;
    if (kind === "terminals") r.referencePath.terminalReferences[1].referenceEndpoint = { reference: "J1", pin: "3" };
    if (kind === "width") d.netClasses[0].traceWidthMm += .01;
    if (kind === "placement") d.placementConstraints[0].regionMm.minXmm += .01;
    if (kind === "plane-policy") d.planes[0].islandPolicy.minimumAreaMm2 += .01;
    expect(() => assertPlaneTerminalLaunchRevisionScope(h.source, h.f.compile(d))).toThrow("only explicit terminal-launch");
  });
  it("rejects copied authority, no-op/rationale-only changes and unsupported physical approaches", async () => {
    const h = await fixture();
    expect(() => assertPlaneTerminalLaunchRevisionScope(structuredClone(h.source), h.launched)).toThrow("authenticated");
    expect(() => assertPlaneTerminalLaunchRevisionScope(h.source, h.source)).toThrow("substantive");
    const d: any = structuredClone(h.revised); d.routingConstraints.nets.find((r: any) => r.net === "VIN").referencePath.terminalLaunches[0].engineeringBasis = "Different wording.";
    expect(() => assertPlaneTerminalLaunchRevisionScope(h.launched, h.f.compile(d))).toThrow("substantive");
    d.routingConstraints.nets.find((r: any) => r.net === "VIN").referencePath.terminalLaunches[0].maximumLengthMm = 2;
    expect(() => planPlanePlacementRevisionSources({ ...h.input, targetBundle: h.f.compile(d), revisionKind: "terminal-launches" })).toThrow("remainder");
  });
});
