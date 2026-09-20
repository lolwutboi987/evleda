import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { canonicalJson, contentIdentity } from "../../src/core/canonical.js";
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
  PCB_PLANE_INTERFACE_REQUIREMENTS_MODEL_GUIDE,
  PCB_PLANE_DESIGN_INTENT_EXTENDED_MODEL_GUIDE_MAX_UTF8_BYTES,
  getPcbPlaneDesignIntentModelGuide,
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
      const props = object.properties as Record<string, any>;
      const optional = object === PCB_PLANE_DESIGN_INTENT_JSON_SCHEMA ? ["interfaceRequirements", "externalPowerInputs", "derivedPowerSources", "boardFeatures", "nativeRuleMode"]
        : props.kind?.const === "differential_pair" ? ["channel"] : props.topology?.const === "plane" ? ["additionalPlaneIds"]
          : props.drivingEndpoint !== undefined ? ["externalPowerInput"] : props.launchNets !== undefined ? ["feedThrough"] : props.viaPolicy !== undefined ? ["minimumHoleToHoleMm"] : [];
      expect([...(object.required as string[])].sort()).toEqual(Object.keys(object.properties as object).filter(key => !optional.includes(key)).sort());
    });
    expect(objectSchemas).toBeGreaterThan(20);
    expectDeepFrozen(PCB_PLANE_DESIGN_INTENT_JSON_SCHEMA);
    expect(Reflect.set(PCB_PLANE_DESIGN_INTENT_JSON_SCHEMA, "additionalProperties", true)).toBe(false);
    expect(Reflect.set(generated, "additionalProperties", true)).toBe(true);
    expect(PCB_PLANE_DESIGN_INTENT_JSON_SCHEMA.additionalProperties).toBe(false);
  });

  it("advertises optional interface intent without changing the omitted-field guide", () => {
    expect(PCB_PLANE_DESIGN_INTENT_JSON_SCHEMA.required).not.toContain("interfaceRequirements");
    expect(PCB_PLANE_DESIGN_INTENT_JSON_SCHEMA.properties).toHaveProperty("interfaceRequirements");
    expect(getPcbPlaneDesignIntentModelGuide()).toBe(PCB_PLANE_DESIGN_INTENT_MODEL_GUIDE);
    expect(getPcbPlaneDesignIntentModelGuide(true)).toBe(`${PCB_PLANE_DESIGN_INTENT_MODEL_GUIDE}\n${PCB_PLANE_INTERFACE_REQUIREMENTS_MODEL_GUIDE}`);
    expect(Buffer.byteLength(getPcbPlaneDesignIntentModelGuide(true), "utf8")).toBeLessThanOrEqual(PCB_PLANE_DESIGN_INTENT_EXTENDED_MODEL_GUIDE_MAX_UTF8_BYTES);
    for (const term of ["caller_assertion", "receiverMapping", "source_series", "explicit unsupported", "bends, launches", "not measured impedance", "unknown until"])
      expect(PCB_PLANE_INTERFACE_REQUIREMENTS_MODEL_GUIDE).toContain(term);
  });

  it("keeps derived power intent optional and the combined guide within its published bound", () => {
    expect(PCB_PLANE_DESIGN_INTENT_JSON_SCHEMA.required).not.toContain("derivedPowerSources");
    expect(PCB_PLANE_DESIGN_INTENT_VALID_EXAMPLE).not.toHaveProperty("derivedPowerSources");
    const guide = getPcbPlaneDesignIntentModelGuide(true, true, true, true);
    expect(Buffer.byteLength(guide, "utf8")).toBeLessThanOrEqual(PCB_PLANE_DESIGN_INTENT_EXTENDED_MODEL_GUIDE_MAX_UTF8_BYTES);
    for (const term of ["Optional derivedPowerSources", "power_out", "Device:L", "Device:R", "operatingAssumptions", "not electrical/current/thermal/feedback qualification", "every upstream/path/return native group"])
      expect(guide).toContain(term);
    for (const term of ["Without externalPowerInput", "externalPowerInput={id,diodeForwardDropAssumption,operatingModes}",
      "exact externalPowerInputs binding", "exactly one stock Device:D_Schottky", "entryPin=2 (A), exitPin=1 (K)",
      "consumer's inspected power_in", "same external return net", "simultaneous-source", "Do not relabel internal rails as external"])
      expect(guide).toContain(term);
    expect(guide).not.toContain("not diode or capacitive source assertions");
  });

  it("advertises a strict optional external source object and pins the access-layer guide revision", () => {
    let externalSchema: Record<string, any> | undefined;
    visitObjects(PCB_PLANE_DESIGN_INTENT_JSON_SCHEMA, object => {
      const props = object.properties as Record<string, any> | undefined;
      if (props?.externalPowerInput === undefined) return;
      expect(object.required).not.toContain("externalPowerInput");
      externalSchema = props.externalPowerInput;
    });
    expect(externalSchema).toBeDefined();
    expect(externalSchema!.additionalProperties).toBe(false);
    expect(externalSchema!.required).toEqual(["id", "diodeForwardDropAssumption", "operatingModes"]);
    for (const key of ["id", "diodeForwardDropAssumption", "operatingModes"]) expect(externalSchema!.properties[key].anyOf).toContainEqual({ type: "null" });
    for (const key of ["diodeForwardDropAssumption", "operatingModes"]) expect(externalSchema!.properties[key].anyOf).toContainEqual(expect.objectContaining({ type: "string", minLength: 1, maxLength: 2048 }));
    expect(contentIdentity(getPcbPlaneDesignIntentModelGuide())).toEqual({ algorithm: "sha256", digest: "4e49118e1728bd31ba03d84716351336a1e6deb1c57f0e8b5826a93dad8edb80", size: 10701 });
    expect(contentIdentity(getPcbPlaneDesignIntentModelGuide(false, true))).toEqual({ algorithm: "sha256", digest: "549d2a4d8148ee163016c5c145851cc0a1e7daa5cb666a2fabbe336b682785ec", size: 12188 });
    expect(contentIdentity(getPcbPlaneDesignIntentModelGuide(true, true, true, false))).toEqual({ algorithm: "sha256", digest: "7b13dbf47c37a6226cc3d70b28fd27e39c7812c21abda473035702e0a7dec367", size: 19326 });
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
      "maximumTurnAngleDeg=45", "one rectangular ground plane on two-layer boards", "one or two on four-layer boards", "islandPolicy",
      "Each plane-topology route requires net", "additionalPlaneIds", "accessRouting", "Each trace route has exactly net",
      "adjacent enabled copper layer", "route maxVias=0", "Every signal endpoint requires exactly one explicit mapping",
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
