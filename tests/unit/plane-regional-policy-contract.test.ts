import { describe, expect, it } from "vitest";
import { fourLayerPlaneBundle, fourLayerPlaneDraft } from "../helpers/four-layer-plane-bundle.js";
import { constructionDependencies, interfaceConstructionBundle } from "../helpers/interface-construction-bundle.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { parsePcbPlaneCompilationBundle, serializePcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
function regional() {
  const d = fourLayerPlaneDraft(), p = d.planes.find((p: any) => p.id === "BACK_GND");
  p.islandPolicy = { ...p.islandPolicy, requireSingleConnectedComponent: false, referencePlaneId: "GND_PLANE",
    engineeringBasis: "Supplemental fill; every stored region must have a qualified via contact to the primary plane. Signal references remain on the primary." };
  return d;
}
describe("explicit supplemental ground-region intent", () => {
  it("preserves pre-extension bundle identities byte for byte for existing policies", () => {
    expect(fourLayerPlaneBundle().identity.digest).toBe("97d2b82653ff0561ca437a163e5f3767c8453d5e26dbb8cf4947634b0f3ab523");
    expect(interfaceConstructionBundle().identity.digest).toBe("2367b1454246ece167bbd9d128b78d8a300f908b686cca84ad1193cdec68bfa6");
  });
  it("binds the explicit alternate policy and rationale in a separate ready bundle", () => {
    const candidate = interfaceConstructionBundle(regional());
    expect(candidate.contract.planes.find(p => p.id === "BACK_GND")!.islandPolicy).toMatchObject({
      requireSingleConnectedComponent: false, referencePlaneId: "GND_PLANE", engineeringBasis: expect.any(String) });
    expect(candidate.contract.planes.find(p => p.id === "GND_PLANE")!.islandPolicy.requireSingleConnectedComponent).toBe(true);
    expect(candidate.identity).not.toEqual(fourLayerPlaneBundle().identity);
    expect(parsePcbPlaneCompilationBundle(serializePcbPlaneCompilationBundle(candidate), constructionDependencies).identity).toEqual(candidate.identity);
    expect(candidate.verificationPlan.requirements.find(r => r.id === "plane-policy:BACK_GND")!.description).toContain("through-via");
  });
  it.each([
    ["bare false without rationale/reference", (d: any) => { delete d.planes[1].islandPolicy.referencePlaneId; }],
    ["primary replacement", (d: any) => { d.planes[0].islandPolicy = { ...d.planes[1].islandPolicy, referencePlaneId: "BACK_GND" }; }],
    ["self reference", (d: any) => { d.planes[1].islandPolicy.referencePlaneId = "BACK_GND"; }],
    ["unknown reference", (d: any) => { d.planes[1].islandPolicy.referencePlaneId = "MISSING"; }],
    ["required signal reference", (d: any) => { d.routingConstraints.nets.find((r: any) => r.net === "DP").referencePath.planeId = "BACK_GND"; }],
    ["island removal disabled", (d: any) => { d.planes[1].islandPolicy.removeUnconnected = false; }],
    ["blank rationale", (d: any) => { d.planes[1].islandPolicy.engineeringBasis = " "; }],
  ] as const)("rejects %s", (_name, mutate) => {
    const d = regional(); mutate(d); expect(compilePcbPlaneDesignIntentDraft(d, constructionDependencies).disposition).not.toBe("ready");
  });
  it("asks for a missing named reference instead of inventing it", () => {
    const d = regional(); d.planes[1].islandPolicy.referencePlaneId = null;
    const result = compilePcbPlaneDesignIntentDraft(d, constructionDependencies);
    expect(result.disposition).toBe("needs_clarification");
    expect(result.questions.some(q => q.path.endsWith("/islandPolicy/referencePlaneId"))).toBe(true);
  });
});
