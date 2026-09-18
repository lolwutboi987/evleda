import { describe, expect, it } from "vitest";
import { canonicalIdentity } from "../../src/core/canonical.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { parsePcbDesignIntentDraft, pcbDesignContractPayloadSchema } from "../../src/harness/pcb-design-contract.js";
import { closePcbPlaneDesignIntentDraft, parsePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-contract.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle, parsePcbPlaneCompilationBundle, serializePcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { parsePlaneRouteMutationArguments } from "../../src/harness/fresh-plane-route-mutation.js";
import { PCB_PLANE_DESIGN_INTENT_JSON_SCHEMA } from "../../src/harness/pcb-design-plane-model-guide.js";
import { genericDividerDraft, genericDividerLibraryResolver } from "../helpers/generic-divider-bundle.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";

const dependencies = { libraryResolver: genericDividerLibraryResolver, deepRuleCatalog: loadDeepRuleCatalog() };
const ground = (draft: Record<string, any>) => draft.routingConstraints.nets.find((route: any) => route.net === "GND");
function accessDraft(maxVias = 48): Record<string, any> {
  const draft: Record<string, any> = planeDividerDraft();
  ground(draft).accessRouting.maxVias = maxVias;
  draft.routingConstraints.viaPolicy.maxTotal = Math.max(1, maxVias);
  return draft;
}

describe("V2 plane-access via budget independent of V1 trace and mutation bounds", () => {
  it("compiles and round-trips a declared48-via plane plus37 trace maxima within exact global85", () => {
    const draft = accessDraft();
    draft.routingConstraints.viaPolicy.maxTotal = 85;
    draft.netClasses = draft.netClasses.map((value: any) => ({ ...value, allowedLayers: ["F.Cu", "B.Cu"] }));
    const vin = draft.routingConstraints.nets.find((route: any) => route.net === "VIN");
    vin.referencePath = { mode: "none" }; vin.maxVias = 32;
    draft.routingConstraints.nets.find((route: any) => route.net === "VOUT").maxVias = 5;
    const compilation = compilePcbPlaneDesignIntentDraft(draft, dependencies);
    expect(compilation.disposition, JSON.stringify(compilation.issues)).toBe("ready");
    if (compilation.disposition !== "ready") throw new Error("Expected a closed engineering-intent budget, not native qualification");
    expect(compilation.contract.routingConstraints.nets.find(route => route.topology === "plane")!.accessRouting.maxVias).toBe(48);
    expect(compilation.contract.routingConstraints.viaPolicy).toMatchObject({ mode: "bounded", maxTotal: 85 });
    const bundle = createPcbPlaneCompilationBundle({ compilation, originalPrompt: "Synthetic bounded plane-access budget; no native qualification." }, dependencies);
    const bytes = serializePcbPlaneCompilationBundle(bundle);
    expect(serializePcbPlaneCompilationBundle(parsePcbPlaneCompilationBundle(bytes, dependencies))).toEqual(bytes);
    draft.routingConstraints.viaPolicy.maxTotal = 84;
    expect(() => closePcbPlaneDesignIntentDraft(draft)).toThrow(/Combined trace and plane-access via maxima/u);
  });
  it.each([0, 32, 48, 64])("accepts integer plane-access maximum%s", maximum => {
    const draft = accessDraft(maximum);
    expect(() => parsePcbPlaneDesignIntentDraft(draft)).not.toThrow();
    expect(() => closePcbPlaneDesignIntentDraft(draft)).not.toThrow();
  });
  it.each([65, -1, -0, 1.5, Infinity, NaN])("rejects unsupported plane-access maximum%s in draft and closure", maximum => {
    const draft = accessDraft(); ground(draft).accessRouting.maxVias = maximum;
    expect(() => parsePcbPlaneDesignIntentDraft(draft)).toThrow();
    expect(() => closePcbPlaneDesignIntentDraft(draft)).toThrow();
  });
  it("retains unresolved nullable draft access budgets without inventing a resolved value", () => {
    const draft = accessDraft(); ground(draft).accessRouting.maxVias = null;
    const index = draft.routingConstraints.nets.findIndex((route: any) => route.net === "GND");
    draft.unresolved = [{ path: `/routingConstraints/nets/${index}/accessRouting/maxVias`, question: "Resolve the local ground-return via budget." }];
    const parsed = parsePcbPlaneDesignIntentDraft(draft);
    const route = parsed.routingConstraints.nets.find(route => route.topology === "plane")!;
    expect(route.accessRouting!.maxVias).toBeNull();
    expect(parsed.unresolved[0]!.path).toBe("/routingConstraints/nets/GND/accessRouting/maxVias");
    expect(() => closePcbPlaneDesignIntentDraft(draft)).toThrow();
  });
  it.each([
    ["forbidden policy", (draft: any) => { draft.routingConstraints.viaPolicy = { mode: "forbidden", maxTotal: 0 }; }, /forbids plane-access/u],
    ["per-net exceeds global", (draft: any) => { draft.routingConstraints.viaPolicy.maxTotal = 47; }, /Per-net via maximum/u],
    ["single-layer class", (draft: any) => { draft.netClasses.find((value: any) => value.id === "POWER").allowedLayers = ["B.Cu"]; ground(draft).accessRouting.preferredLayer = "B.Cu"; }, /Single-layer net class/u],
    ["invalid annular ring", (draft: any) => { draft.routingConstraints.viaPolicy.minimumAnnularRingMm = 0.2; }, /annular ring/u],
    ["global exceeds256", (draft: any) => { draft.routingConstraints.viaPolicy.maxTotal = 257; }, /256/u],
  ] as const)("preserves %s rejection", (_name, change, message) => {
    const draft = accessDraft(); change(draft);
    expect(() => closePcbPlaneDesignIntentDraft(draft)).toThrow(message);
  });
  it("keeps V1 and V2 trace routes capped at32 and referenced traces at zero", () => {
    const v1: Record<string, any> = genericDividerDraft();
    v1.routingConstraints.viaPolicy = { mode: "bounded", maxTotal: 64, diameterMm: 0.6, drillMm: 0.3, minimumAnnularRingMm: 0.15 };
    v1.routingConstraints.nets[0].maxVias = 33;
    expect(() => parsePcbDesignIntentDraft(v1)).toThrow(/32/u);
    expect(() => pcbDesignContractPayloadSchema.shape.routingConstraints.shape.nets.element.shape.maxVias.parse(33)).toThrow();
    const v2 = accessDraft(); v2.routingConstraints.viaPolicy.maxTotal = 128;
    const trace = v2.routingConstraints.nets.find((route: any) => route.net === "VIN");
    trace.referencePath = { mode: "none" }; trace.maxVias = 33;
    expect(() => closePcbPlaneDesignIntentDraft(v2)).toThrow(/32/u);
    const referenced = accessDraft(); referenced.routingConstraints.viaPolicy.maxTotal = 49;
    referenced.routingConstraints.nets.find((route: any) => route.net === "VIN").maxVias = 1;
    expect(() => closePcbPlaneDesignIntentDraft(referenced)).toThrow(/layer transitions/u);
  });
  it("retains the separate32-via cap for a single mutation call", () => {
    const args = { selectionIdentity: canonicalIdentity({}, "evleda.fresh-plane-route-selection.v1"), net: "GND", deleteItemIds: [], tracks: [],
      vias: Array.from({ length: 32 }, (_, index) => ({ xMm: 1 + index, yMm: 1 })) };
    expect(parsePlaneRouteMutationArguments(args).vias).toHaveLength(32);
    expect(() => parsePlaneRouteMutationArguments({ ...args, vias: [...args.vias, { xMm: 40, yMm: 1 }] })).toThrow(/32/u);
  });
  it("advertises maximum64 only for plane access in the generated public draft schema", () => {
    const schema = PCB_PLANE_DESIGN_INTENT_JSON_SCHEMA as Record<string, any>;
    const branches = schema.properties.routingConstraints.properties.nets.items.oneOf;
    const plane = branches.find((value: any) => value.properties.topology.const === "plane");
    const trace = branches.find((value: any) => value !== plane);
    const access = plane.properties.accessRouting.anyOf.find((value: any) => value.type === "object");
    expect(access.properties.maxVias.anyOf.find((value: any) => value.type === "integer").maximum).toBe(64);
    expect(trace.properties.maxVias.anyOf.find((value: any) => value.type === "integer").maximum).toBe(32);
  });
});
