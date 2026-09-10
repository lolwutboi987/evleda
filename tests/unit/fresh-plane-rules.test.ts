import { describe, expect, it } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { createFreshPlaneRules } from "../../src/harness/fresh-plane-rules.js";
import { createPcbPlaneCompilationBundle, type PcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { genericDividerLibraryResolver } from "../helpers/generic-divider-bundle.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";
const dependencies = { libraryResolver: genericDividerLibraryResolver, deepRuleCatalog: loadDeepRuleCatalog() };
function bundle(solid = false, prompt = "Synthetic plane rules fixture") {
  const draft = planeDividerDraft();
  const data = solid ? { ...draft, planes: draft.planes.map(plane => ({ ...plane, padConnection: { mode: "solid" } })) } : draft;
  return createPcbPlaneCompilationBundle({ originalPrompt: prompt, compilation: compilePcbPlaneDesignIntentDraft(data, dependencies) }, dependencies);
}
describe("canonical V2 plane rules", () => {
  it("emits native direct min-spokes and exact gap/width policy under one deterministic zone selector", () => {
    const source = bundle(), rules = createFreshPlaneRules(source), name = `EVLEDA_PLANE_${source.identity.digest.slice(0, 12)}_P01`;
    expect(rules.source).toBe(`(version 1)\n\n(rule "${name}_THERMAL"\n  (layer "B.Cu")\n  (condition "A.Type == 'Zone' && A.Name == '${name}'")\n  (severity error)\n  (constraint min_resolved_spokes 2)\n  (constraint thermal_relief_gap (min 0.25mm))\n  (constraint thermal_spoke_width (min 0.5mm) (opt 0.5mm) (max 0.5mm)))\n`);
    expect(rules.identity).toEqual(contentIdentity(rules.source));
    expect(rules.zones).toEqual([{ planeId: "GND_PLANE", zoneName: name, layer: "B.Cu", thermal: { minimumConnectedSpokes: 2, gapMm: 0.25, spokeWidthMm: 0.5 } }]);
    expect(rules).not.toHaveProperty("accepted");
    expect(rules.limitations.some(value => value.includes("unconnected"))).toBe(true);
  });
  it("emits a canonical empty deck for solid connection without inventing thermal acceptance", () => {
    const rules = createFreshPlaneRules(bundle(true));
    expect(rules.source).toBe("(version 1)\n"); expect(rules.zones[0]!.thermal).toBeNull();
  });
  it("rejects deserialized and forged bundles and keeps rule names bundle-specific", () => {
    const original = bundle();
    expect(() => createFreshPlaneRules(structuredClone(original))).toThrow("authenticated");
    expect(() => createFreshPlaneRules({} as PcbPlaneCompilationBundle)).toThrow("authenticated");
    expect(createFreshPlaneRules(original).zones[0]!.zoneName).not.toBe(createFreshPlaneRules(bundle(false, "Another original request")).zones[0]!.zoneName);
  });
});
