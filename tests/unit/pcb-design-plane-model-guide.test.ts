import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { canonicalJson } from "../../src/core/canonical.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { parsePcbDesignIntentDraft } from "../../src/harness/pcb-design-contract.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import {
  PCB_PLANE_CONTRACT_LIMITS,
  parsePcbPlaneDesignIntentDraft,
  pcbPlaneDesignIntentDraftSchema,
} from "../../src/harness/pcb-design-plane-contract.js";
import {
  PCB_PLANE_DESIGN_INTENT_JSON_SCHEMA,
  PCB_PLANE_DESIGN_INTENT_MODEL_GUIDE,
  PCB_PLANE_DESIGN_INTENT_MODEL_GUIDE_MAX_UTF8_BYTES,
  PCB_PLANE_DESIGN_INTENT_MODEL_GUIDE_VERSION,
  PCB_PLANE_DESIGN_INTENT_VALID_EXAMPLE,
} from "../../src/harness/pcb-design-plane-model-guide.js";

const visitObjects = (value: unknown, visit: (object: Record<string, unknown>) => void): void => {
  if (value === null || typeof value !== "object") return;
  if (!Array.isArray(value)) visit(value as Record<string, unknown>);
  for (const child of Object.values(value)) visitObjects(child, visit);
};
const expectDeepFrozen = (value: unknown): void => {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
};

describe("V2 PCB plane design-intent model guide", () => {
  it("advertises the exact canonical strict draft schema, detached and deeply frozen", () => {
    const generated = z.toJSONSchema(pcbPlaneDesignIntentDraftSchema, { target: "draft-2020-12" });
    expect(PCB_PLANE_DESIGN_INTENT_JSON_SCHEMA).toEqual(generated);
    expect(PCB_PLANE_DESIGN_INTENT_JSON_SCHEMA).not.toBe(generated);
    expect(PCB_PLANE_DESIGN_INTENT_JSON_SCHEMA.properties).not.toBe(generated.properties);
    expect(PCB_PLANE_DESIGN_INTENT_JSON_SCHEMA.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(PCB_PLANE_DESIGN_INTENT_JSON_SCHEMA.required).toEqual(expect.arrayContaining(["planes", "unresolved", "routingConstraints"]));
    let objectSchemas = 0;
    visitObjects(PCB_PLANE_DESIGN_INTENT_JSON_SCHEMA, (object) => {
      if (object.type !== "object") return;
      objectSchemas += 1;
      expect(object.additionalProperties).toBe(false);
      expect([...(object.required as string[])].sort()).toEqual(Object.keys(object.properties as object).sort());
    });
    expect(objectSchemas).toBeGreaterThan(20);
    expectDeepFrozen(PCB_PLANE_DESIGN_INTENT_JSON_SCHEMA);
    expect(Reflect.set(PCB_PLANE_DESIGN_INTENT_JSON_SCHEMA, "additionalProperties", true)).toBe(false);
    expect(Reflect.set(generated, "additionalProperties", true)).toBe(true);
    expect(PCB_PLANE_DESIGN_INTENT_JSON_SCHEMA.additionalProperties).toBe(false);
  });

  it("keeps the complete guidance bounded, provider-neutral and explicit about authority", () => {
    const guide = PCB_PLANE_DESIGN_INTENT_MODEL_GUIDE;
    expect(guide).toContain(PCB_PLANE_DESIGN_INTENT_MODEL_GUIDE_VERSION);
    expect(Buffer.byteLength(guide, "utf8")).toBeLessThanOrEqual(PCB_PLANE_DESIGN_INTENT_MODEL_GUIDE_MAX_UTF8_BYTES);
    expect(guide).not.toMatch(/(?:[A-Za-z]:[\\/]|\\\\|file:\/\/|\/(?:home|Users|var|tmp)\/)/u);
    expect(guide).not.toMatch(/(?:OpenAI|Anthropic|ChatGPT|Claude|api[_-]?key)/iu);
    for (const instruction of [
      "evleda.pcb-design-intent-draft.v2", "Nullable means use an explicit null", "bidirectionally exact",
      "Use electrical:null", "Preserve supplied anchors", "Closed V2 placements are front-only",
      "maximumTurnAngleDeg=45", "exactly one rectangular ground plane", "islandPolicy",
      "Each plane-topology route has exactly net", "accessRouting", "Each trace route has exactly net",
      "opposite copper layer", "route maxVias=0", "Every signal endpoint requires exactly one explicit mapping",
      "sum of all trace and plane-access maxVias", "keyed RFC6901 pointers to existing fields",
      "not a nonexistent child", "evleda_design_context", "not an electrically approved or ready design",
      "do not perform native authoring", "continuous-plane intent is not impedance or EMC qualification",
    ]) expect(guide).toContain(instruction);
  });

  it("provides a canonical parser-valid immutable V2 example with both route branches", () => {
    const example = PCB_PLANE_DESIGN_INTENT_VALID_EXAMPLE;
    expect(parsePcbPlaneDesignIntentDraft(example)).toEqual(example);
    expect(() => parsePcbDesignIntentDraft(example)).toThrow();
    expect(Buffer.byteLength(canonicalJson(example), "utf8")).toBeLessThan(PCB_PLANE_CONTRACT_LIMITS.maxBytes);
    expectDeepFrozen(example);
    const plane = example.planes[0]!;
    expect(Reflect.set(plane, "clearanceMm", 1)).toBe(false);
    expect(example.scope.board).toMatchObject({ widthMm: null, heightMm: null, copperLayers: ["F.Cu", "B.Cu"] });
    expect(example.components.every(component => component.symbolLibId === null && component.footprintLibId === null && component.value === null)).toBe(true);
    expect(example.nets.every(net => net.electrical === null)).toBe(true);
    expect(example.placementConstraints.every(placement => placement.regionMm === null)).toBe(true);
    expect(plane).toMatchObject({ boundary: null, clearanceMm: null, minimumCopperWidthMm: null, net: "GND", layer: "B.Cu" });
    expect(example.routingConstraints.nets[0]).toEqual({
      net: "GND", topology: "plane", planeId: plane.id,
      accessRouting: { preferredLayer: "B.Cu", maxVias: null, routeLength: null },
    });
    const trace = example.routingConstraints.nets[1]!;
    expect(trace).toMatchObject({ topology: "point_to_point", maxVias: 0, preferredLayer: "F.Cu" });
    if (trace.topology === "plane" || trace.referencePath?.mode !== "continuous_plane") throw new Error("Missing reference example");
    expect(trace.referencePath).toMatchObject({ planeId: plane.id, signalLayer: "F.Cu", layerTransitions: "forbidden", coverageMarginMm: null });
    const signalEndpoints = example.nets.find(net => net.name === trace.net)!.endpoints;
    const groundEndpoints = example.nets.find(net => net.name === plane.net)!.endpoints;
    expect(trace.referencePath.terminalReferences?.map(terminal => terminal.signalEndpoint)).toEqual(signalEndpoints);
    for (const terminal of trace.referencePath.terminalReferences!) expect(groundEndpoints).toContainEqual(terminal.referenceEndpoint);
  });

  it("requests missing engineering decisions before consulting libraries or producing a contract", () => {
    const resolveSymbol = vi.fn(() => null);
    const resolveFootprint = vi.fn(() => null);
    const compilation = compilePcbPlaneDesignIntentDraft(PCB_PLANE_DESIGN_INTENT_VALID_EXAMPLE, {
      libraryResolver: { resolveSymbol, resolveFootprint }, deepRuleCatalog: loadDeepRuleCatalog(),
    });
    expect(compilation).toMatchObject({
      disposition: "needs_clarification", draft: PCB_PLANE_DESIGN_INTENT_VALID_EXAMPLE,
      contract: null, libraryBinding: null, verificationPlan: null,
      nativeAuthoringPerformed: false, acceptanceEvaluated: false,
    });
    expect(compilation.questions.map(question => question.path)).toEqual(expect.arrayContaining([
      "/scope/board/widthMm", "/scope/board/heightMm", "/nets/GND/electrical",
      "/planes/GND_PLANE/boundary", "/planes/GND_PLANE/clearanceMm",
      "/routingConstraints/nets/N1/referencePath/coverageMarginMm",
    ]));
    expect(resolveSymbol).not.toHaveBeenCalled();
    expect(resolveFootprint).not.toHaveBeenCalled();
  });

  it("rejects mixed branch keys and invalid known reference relationships", () => {
    const example = PCB_PLANE_DESIGN_INTENT_VALID_EXAMPLE;
    const plane = example.routingConstraints.nets[0]!;
    const trace = example.routingConstraints.nets[1]!;
    if (trace.topology === "plane" || trace.referencePath?.mode !== "continuous_plane") throw new Error("Missing reference example");
    const withRoutes = (...nets: unknown[]) => ({ ...example, routingConstraints: { ...example.routingConstraints, nets } });
    expect(() => parsePcbPlaneDesignIntentDraft(withRoutes({ ...plane, preferredLayer: "B.Cu" }, trace))).toThrow();
    expect(() => parsePcbPlaneDesignIntentDraft(withRoutes(plane, { ...trace, accessRouting: null }))).toThrow();
    expect(() => parsePcbPlaneDesignIntentDraft(withRoutes(plane, { ...trace, referencePath: { ...trace.referencePath, signalLayer: "B.Cu" } }))).toThrow();
    expect(() => parsePcbPlaneDesignIntentDraft({ ...example, planes: [...example.planes, ...example.planes] })).toThrow();
    expect(() => parsePcbPlaneDesignIntentDraft({ ...example, identity: {} })).toThrow();
  });
});
