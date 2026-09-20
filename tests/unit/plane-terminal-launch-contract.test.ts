import { describe, expect, it } from "vitest";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";
import { constructionDependencies, interfaceConstructionBundle, interfaceConstructionDraft } from "../helpers/interface-construction-bundle.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { parsePcbPlaneCompilationBundle, serializePcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { createFreshPlaneRules } from "../../src/harness/fresh-plane-rules.js";
const proposal = () => ({ signalEndpoint: { reference: "J1", pin: "1" }, referenceEndpoint: { reference: "J1", pin: "3" },
  maximumLengthMm: 1.5, maximumReturnSpacingMm: 4, engineeringBasis: "Explicit synthetic through-hole terminal transition; unchanged body reference margin." });
function draft(): any {
  const value = planeDividerDraft(), route = value.routingConstraints.nets.find(r => r.net === "VIN");
  if (!route || !("referencePath" in route)) throw new Error("Fixture VIN reference is missing");
  Object.assign(route.referencePath, { terminalLaunches: [proposal()] }); return value;
}
describe("explicit bounded terminal-launch intent", () => {
  it("binds the launch while preserving native rules and round-tripping the exact bundle", () => {
    const original = interfaceConstructionBundle(planeDividerDraft()), target = interfaceConstructionBundle(draft());
    expect(target.identity).not.toEqual(original.identity);
    const oldRules = createFreshPlaneRules(original), newRules = createFreshPlaneRules(target);
    let expectedRules = oldRules.source;
    for (const old of oldRules.zones) expectedRules = expectedRules.replaceAll(old.zoneName, newRules.zones.find(z => z.planeId === old.planeId)!.zoneName);
    expect(newRules.source).toBe(expectedRules);
    expect(parsePcbPlaneCompilationBundle(serializePcbPlaneCompilationBundle(target), constructionDependencies).identity).toEqual(target.identity);
    expect(target.verificationPlan.requirements.find(r => r.id === "reference-launch:VIN:J1:1")?.description).toContain("other bore");
    expect(target.verificationPlan.requirements.find(r => r.id === "reference:VIN")?.description).toContain("unchanged margin");
  });
  it.each(["different-return", "unknown-signal", "different-footprint", "duplicate", "too-long", "fractional-nm", "blank-basis", "tree"])("rejects %s declarations", kind => {
    const d = draft(), r = d.routingConstraints.nets.find((r: any) => r.net === "VIN"), p = r.referencePath.terminalLaunches[0];
    if (kind === "different-return") p.referenceEndpoint.pin = "2";
    if (kind === "unknown-signal") p.signalEndpoint.pin = "9";
    if (kind === "different-footprint") p.referenceEndpoint.reference = "R2";
    if (kind === "duplicate") r.referencePath.terminalLaunches.push(structuredClone(p));
    if (kind === "too-long") p.maximumLengthMm = 3.000001;
    if (kind === "fractional-nm") p.maximumLengthMm = 1.0000001;
    if (kind === "blank-basis") p.engineeringBasis = " ";
    if (kind === "tree") r.topology = "tree";
    expect(compilePcbPlaneDesignIntentDraft(d, constructionDependencies).disposition).not.toBe("ready");
  });
  it("keeps missing bounds unresolved and excludes declared differential-interface members", () => {
    const d = draft(); d.routingConstraints.nets.find((r: any) => r.net === "VIN").referencePath.terminalLaunches[0].maximumLengthMm = null;
    const unresolved = compilePcbPlaneDesignIntentDraft(d, constructionDependencies);
    expect(unresolved.disposition).toBe("needs_clarification");
    expect(unresolved.questions.some(q => q.path.endsWith("/maximumLengthMm"))).toBe(true);
    const pair = interfaceConstructionDraft() as any;
    pair.routingConstraints.nets.find((r: any) => r.net === "DP").referencePath.terminalLaunches = [proposal()];
    const rejected = compilePcbPlaneDesignIntentDraft(pair, constructionDependencies);
    expect(rejected.disposition).not.toBe("ready");
    expect(JSON.stringify(rejected.issues)).toContain("own launch model");
  });
});
