import { describe, expect, it } from "vitest";
import { canonicalIdentity } from "../../src/core/canonical.js";
import { closePcbPlaneDesignIntentDraft, parsePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-contract.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle, parsePcbPlaneCompilationBundle, serializePcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { PCB_PLANE_DESIGN_INTENT_JSON_SCHEMA, PCB_PLANE_DESIGN_INTENT_MODEL_GUIDE } from "../../src/harness/pcb-design-plane-model-guide.js";
import { assertPlaneIncrementalRouteGeometry, parsePlaneRouteMutationArguments } from "../../src/harness/fresh-plane-route-mutation.js";
import type { FreshRouteSelectionItem } from "../../src/harness/kicad-tools.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { genericDividerLibraryResolver } from "../helpers/generic-divider-bundle.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";

const dependencies = { libraryResolver: genericDividerLibraryResolver, deepRuleCatalog: loadDeepRuleCatalog() };
const ground = (draft: Record<string, any>) => draft.routingConstraints.nets.find((route: any) => route.topology === "plane");
const draft = (): Record<string, any> => { const value = planeDividerDraft(); ground(value).accessRouting.preferredLayer = "either"; return value; };
const track = (id: string, layer: string, widthMm = .6): Extract<FreshRouteSelectionItem, { kind: "track" }> => ({ kind: "track", id, net: "GND", layer,
  widthMm, start: { xMm: 5, yMm: 10 }, end: { xMm: 7, yMm: 10 } });

describe("explicit mixed-layer V2 plane access", () => {
  it("closes and round-trips one GND plane with explicit front/back access on the same net", () => {
    const input = draft(), compilation = compilePcbPlaneDesignIntentDraft(input, dependencies);
    expect(compilation.disposition, JSON.stringify(compilation.issues)).toBe("ready");
    const bundle = createPcbPlaneCompilationBundle({ compilation, originalPrompt: "One GND net with explicit F.Cu access and 0.60 mm B.Cu return strap" }, dependencies);
    expect(bundle.contract.planes).toHaveLength(1); expect(bundle.contract.planes[0]!.layer).toBe("B.Cu");
    expect(bundle.contract.nets.filter(net => net.name === "GND")).toHaveLength(1);
    expect(ground(bundle.contract).accessRouting.preferredLayer).toBe("either");
    expect(parsePcbPlaneCompilationBundle(serializePcbPlaneCompilationBundle(bundle), dependencies)).toEqual(bundle);
    expect(() => assertPlaneIncrementalRouteGeometry(bundle.contract, "GND", [track("front", "F.Cu", .5), track("back", "B.Cu")])).not.toThrow();
  });

  it("retains nullable draft intent and keyed clarification", () => {
    const input = draft(); ground(input).accessRouting.preferredLayer = null;
    input.unresolved = [{ path: "/routingConstraints/nets/GND/accessRouting/preferredLayer", question: "Choose the intended copper layers." }];
    const parsed = parsePcbPlaneDesignIntentDraft(input);
    expect(ground(parsed).accessRouting.preferredLayer).toBeNull(); expect(() => closePcbPlaneDesignIntentDraft(input)).toThrow();
  });

  it.each(["In1.Cu", "F.Mask", "both", "", 1])("rejects invalid access layer %s", preferredLayer => {
    const input = draft(); ground(input).accessRouting.preferredLayer = preferredLayer;
    expect(() => parsePcbPlaneDesignIntentDraft(input)).toThrow();
  });

  it.each(["plane", "reference"])("does not broaden the exact %s layer", field => {
    const input = draft();
    if (field === "plane") input.planes[0].layer = "either";
    else input.routingConstraints.nets.find((route: any) => route.net === "VIN").referencePath.signalLayer = "either";
    expect(() => closePcbPlaneDesignIntentDraft(input)).toThrow();
  });

  it("requires both class layers even when the plane itself and zero-via budget are valid", () => {
    const input = draft(), power = input.netClasses.find((row: any) => row.id === "POWER");
    input.netClasses.push({ ...power, id: "GROUND_ONLY", allowedLayers: ["B.Cu"] });
    input.nets.find((net: any) => net.name === "GND").netClassId = "GROUND_ONLY";
    ground(input).accessRouting.maxVias = 0;
    expect(() => closePcbPlaneDesignIntentDraft(input)).toThrow(/Routing layer is incompatible/);
    ground(input).accessRouting.preferredLayer = "B.Cu";
    expect(() => closePcbPlaneDesignIntentDraft(input)).not.toThrow();
  });

  it("retains exact per-track and board-layer validation for either", () => {
    const contract = closePcbPlaneDesignIntentDraft(draft());
    for (const layer of ["either", "In1.Cu", "F.Mask"]) expect(() => assertPlaneIncrementalRouteGeometry(contract, "GND", [track("bad", layer)])).toThrow(/layer/);
    const input = draft(); input.scope.board.copperLayers = ["F.Cu"];
    expect(() => closePcbPlaneDesignIntentDraft(input)).toThrow();
    const args = { selectionIdentity: canonicalIdentity({}, "evleda.fresh-plane-route-selection.v1"), net: "GND", deleteItemIds: [],
      tracks: [{ x1Mm: 5, y1Mm: 10, x2Mm: 7, y2Mm: 10, layer: "either" }], vias: [] };
    expect(() => parsePlaneRouteMutationArguments(args)).toThrow();
  });

  it("keeps an existing F-only route restrictive and checks retained copper along with proposed copper", () => {
    const exact = closePcbPlaneDesignIntentDraft(planeDividerDraft()), mixed = closePcbPlaneDesignIntentDraft(draft());
    const retained = track("retained", "B.Cu"), proposed = track("new", "F.Cu", .5);
    expect(() => assertPlaneIncrementalRouteGeometry(exact, "GND", [retained, proposed])).toThrow(/layer/);
    expect(() => assertPlaneIncrementalRouteGeometry(mixed, "GND", [retained, proposed])).not.toThrow();
    expect(() => assertPlaneIncrementalRouteGeometry(mixed, "GND", [{ ...retained, widthMm: .1 }, proposed])).toThrow(/wrong-width/);
    const tooLong = [retained, { ...proposed, end: { xMm: 20, yMm: 10 } }];
    expect(() => assertPlaneIncrementalRouteGeometry(mixed, "GND", tooLong)).toThrow(/length/);
  });

  it("advertises either only for access routing, keeping plane and reference schemas exact", () => {
    const schema = PCB_PLANE_DESIGN_INTENT_JSON_SCHEMA as Record<string, any>;
    const planeRoute = schema.properties.routingConstraints.properties.nets.items.oneOf.find((branch: any) => branch.properties.topology.const === "plane");
    const access = planeRoute.properties.accessRouting.anyOf.find((branch: any) => branch.type === "object");
    expect(JSON.stringify(access.properties.preferredLayer)).toContain('"either"');
    expect(JSON.stringify(schema.properties.planes.items.properties.layer)).not.toContain('"either"');
    expect(PCB_PLANE_DESIGN_INTENT_MODEL_GUIDE).toContain('either for exactly F.Cu/B.Cu');
    expect(PCB_PLANE_DESIGN_INTENT_MODEL_GUIDE).toContain('any on four-layer boards');
    expect(PCB_PLANE_DESIGN_INTENT_MODEL_GUIDE).not.toContain('Access preferredLayer is one exact F.Cu or B.Cu, never');
  });
});
