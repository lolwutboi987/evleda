import { describe, expect, it, vi } from "vitest";
import { canonicalIdentity, canonicalJson } from "../../src/core/canonical.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { PCB_INTERFACE_REQUIREMENTS_SCHEMA_VERSION } from "../../src/harness/pcb-interface-requirements.js";
import { closePcbPlaneDesignIntentDraft, normalizePcbPlaneUnresolvedPath, parsePcbPlaneDesignContract,
  parsePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-contract.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle, parsePcbPlaneCompilationBundle, serializePcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { genericDividerLibraryResolver } from "../helpers/generic-divider-bundle.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";

const evidence = () => ({ kind: "caller_assertion", reference: "fixture specification rev 1", description: "Synthetic software fixture; no physical verification." });
const point = (reference: string, pin: string) => ({ reference, pin });
const dependencies = { libraryResolver: genericDividerLibraryResolver, deepRuleCatalog: loadDeepRuleCatalog() };

/** Fictional connectivity and numbers exercise software boundaries only. */
const pairDraft = (): Record<string, any> => {
  const base = planeDividerDraft();
  const component = (reference: string) => ({ ...structuredClone(base.components[0]!), reference,
    pins: ["DP", "DN", "GND"].map((net, index) => ({ pin: String(index + 1), assignment: { kind: "net", net } })) });
  const electrical = structuredClone(base.nets[0]!.electrical);
  const net = (name: string, role: string, pin: string) => ({ name, role, electrical: name === "GND" ? base.nets[2]!.electrical : electrical,
    netClassId: name === "GND" ? "POWER" : "SIGNAL", endpoints: [point("J1", pin), point("J2", pin)] });
  const route = (net: string, pin: string) => ({ net, topology: "point_to_point", preferredLayer: "F.Cu", maxVias: 0,
    routeLength: { mode: "unbounded" }, referencePath: { mode: "continuous_plane", planeId: "GND_PLANE", signalLayer: "F.Cu",
      coverageMarginMm: 0.5, layerTransitions: "forbidden", terminalReferences: ["J1", "J2"].map(reference => ({ signalEndpoint: point(reference, pin), referenceEndpoint: point(reference, "3") })) } });
  return { ...base, components: [component("J1"), component("J2")], nets: [net("DP", "interface", "1"), net("DN", "interface", "2"), net("GND", "ground", "3")],
    netClasses: [base.netClasses[0], { ...base.netClasses[0], id: "SIGNAL" }],
    placementConstraints: [base.placementConstraints[0], { ...base.placementConstraints[0], reference: "J2", edgePreference: "right" }],
    routingConstraints: { ...base.routingConstraints, nets: [base.routingConstraints.nets.find(route => route.net === "GND"), route("DP", "1"), route("DN", "2")] },
    interfaceRequirements: { schemaVersion: PCB_INTERFACE_REQUIREMENTS_SCHEMA_VERSION, construction: { mode: "none" }, interfaces: [{
      id: "LINK", kind: "differential_pair", nets: { positive: "DP", negative: "DN" },
      endpoints: { source: { positive: point("J1", "1"), negative: point("J1", "2") }, receiver: { positive: point("J2", "1"), negative: point("J2", "2") } },
      geometry: { traceWidthMm: { minimumMm: 0.4, maximumMm: 0.6 }, edgeGapMm: { minimumMm: 0.25, maximumMm: 0.5 }, maxEtchLengthMm: 100, maxEtchSkewMm: 2, maxUncoupledLengthMm: 5 },
      routing: { allowedLayers: ["F.Cu", "B.Cu"], layerTransitions: "forbidden", stubs: "forbidden", referencePlaneId: "GND_PLANE", polarityInversion: { policy: "forbidden", receiverMapping: "normal" } },
      terminations: { source: { kind: "none", source: evidence() }, receiver: { kind: "none", source: evidence() } }, impedance: { mode: "none" }, source: evidence(),
    }] },
  };
};
const pair = (draft: Record<string, any>) => draft.interfaceRequirements.interfaces[0];
const construction = () => ({ mode: "two_layer", id: "STACK", boardThicknessMm: 1.57, frontCopperThicknessMm: 0.035, backCopperThicknessMm: 0.035,
  dielectric: { thicknessMm: 1.5, material: "fixture laminate", relativePermittivity: 4, lossTangent: 0.02, frequencyHz: 100_000_000, substrateRelativePermeability: 1, source: evidence() },
  conductor: { conductivitySiemensPerMetre: 58_000_000, relativePermeability: 1, roughnessNm: 0, source: evidence() },
  solderMask: { front: { kind: "absent" }, back: { kind: "absent" } }, exterior: { front: "air", back: "air" }, surfaceFinish: "fixture bare copper", source: evidence() });
const withImpedance = () => {
  const draft = pairDraft(); draft.interfaceRequirements.construction = construction();
  pair(draft).impedance = { mode: "differential", targetOhms: 100, toleranceOhms: 10, frequencyHz: 100_000_000, constructionId: "STACK", source: evidence() };
  return draft;
};
const addParallel = (draft: Record<string, any>) => {
  const base = planeDividerDraft();
  draft.components.push({ ...base.components[1], reference: "RT", value: "100", pins: [{ pin: "1", assignment: { kind: "net", net: "DP" } }, { pin: "2", assignment: { kind: "net", net: "DN" } }] });
  draft.placementConstraints.push({ ...base.placementConstraints[1], reference: "RT" });
  for (const [netName, pin] of [["DP", "1"], ["DN", "2"]]) {
    draft.nets.find((net: any) => net.name === netName).endpoints.push(point("RT", pin!));
    const route = draft.routingConstraints.nets.find((route: any) => route.net === netName);
    route.topology = "tree";
    route.referencePath.terminalReferences.push({ signalEndpoint: point("RT", pin!), referenceEndpoint: point("J2", "3") });
  }
  pair(draft).terminations.receiver = { kind: "parallel", componentReference: "RT", positivePin: "1", negativePin: "2", resistanceOhms: 100, maximumDistanceToEndpointMm: 2, source: evidence() };
};

describe("optional versioned V2 differential interface intent", () => {
  it("closes and bundles explicit whole-route intent without claiming authoring or physical authority", () => {
    const draft = withImpedance(), before = canonicalJson(draft);
    const compilation = compilePcbPlaneDesignIntentDraft(draft, dependencies);
    expect(compilation.disposition, JSON.stringify(compilation.issues)).toBe("ready");
    if (compilation.disposition !== "ready") throw new Error("Expected a ready fixture");
    expect(canonicalJson(draft)).toBe(before);
    expect(compilation.contract.schemaVersion).toBe("evleda.pcb-design-contract.v2");
    expect(compilation.deepRuleBinding.features).toMatchObject({ differentialPairs: true, signalSpeedInterfaces: true, stackupImpedance: true });
    expect(compilation.verificationPlan.schemaVersion).toBe("evleda.pcb-plane-verification-plan.v1");
    for (const kind of ["interface_topology", "interface_pair_geometry", "interface_termination", "interface_impedance", "interface_construction"])
      expect(compilation.verificationPlan.requirements).toContainEqual(expect.objectContaining({ kind, mandatory: true }));
    expect(compilation).toMatchObject({ acceptanceEvaluated: false, nativeAuthoringPerformed: false });
    const bundle = createPcbPlaneCompilationBundle({ originalPrompt: "Synthetic differential link", compilation }, dependencies);
    expect(bundle.executionGuidance).toContain("caller-asserted design intent");
    expect(bundle.executionGuidance).toContain("including bends, launches");
    expect(bundle.executionGuidance).toContain("remains unknown");
    expect(parsePcbPlaneCompilationBundle(serializePcbPlaneCompilationBundle(bundle), dependencies)).toEqual(bundle);
    expect(parsePcbPlaneDesignContract(structuredClone(compilation.contract))).toEqual(compilation.contract);
    const forged = structuredClone(bundle) as any; forged.contract.interfaceRequirements.interfaces[0].geometry.maxEtchSkewMm++;
    const { identity: _identity, ...payload } = forged; forged.identity = canonicalIdentity(payload, bundle.schemaVersion);
    expect(() => parsePcbPlaneCompilationBundle(forged, dependencies)).toThrow(/reconstruction/);
  });

  it("binds integrated and external parallel pins with declared additional route anchors", () => {
    const draft = pairDraft();
    pair(draft).terminations.source = { kind: "integrated", componentReference: "J1", positivePin: "1", negativePin: "2", source: evidence() };
    addParallel(draft);
    const compilation = compilePcbPlaneDesignIntentDraft(draft, dependencies);
    expect(compilation.disposition, JSON.stringify(compilation.issues)).toBe("ready");
    expect(closePcbPlaneDesignIntentDraft(draft).nets.find(net => net.name === "DP")!.endpoints).toHaveLength(3);
  });

  it("validates explicit receiver inversion including integrated receiver pins", () => {
    const draft = pairDraft(), requirement = pair(draft);
    requirement.routing.polarityInversion = { policy: "allowed_at_receiver", receiverMapping: "inverted" };
    requirement.endpoints.receiver = { positive: point("J2", "2"), negative: point("J2", "1") };
    requirement.terminations.receiver = { kind: "integrated", componentReference: "J2", positivePin: "2", negativePin: "1", source: evidence() };
    expect(compilePcbPlaneDesignIntentDraft(draft, dependencies).disposition).toBe("ready");
  });

  it.each([
    ["whole optional object", (d: any) => { d.interfaceRequirements = null; }, "/interfaceRequirements"],
    ["empty interface list", (d: any) => { d.interfaceRequirements.interfaces = []; }, "/interfaceRequirements/interfaces"],
    ["receiver role", (d: any) => { pair(d).endpoints.receiver.positive = null; }, "/interfaceRequirements/interfaces/LINK/endpoints/receiver/positive"],
    ["etch skew", (d: any) => { pair(d).geometry.maxEtchSkewMm = null; }, "/interfaceRequirements/interfaces/LINK/geometry/maxEtchSkewMm"],
    ["source metadata", (d: any) => { pair(d).source.reference = null; }, "/interfaceRequirements/interfaces/LINK/source/reference"],
    ["dielectric", (d: any) => { d.interfaceRequirements.construction.dielectric = null; }, "/interfaceRequirements/construction/dielectric"],
    ["mask", (d: any) => { d.interfaceRequirements.construction.solderMask.front = null; }, "/interfaceRequirements/construction/solderMask/front"],
    ["termination", (d: any) => { pair(d).terminations.receiver = null; }, "/interfaceRequirements/interfaces/LINK/terminations/receiver"],
  ] as const)("asks a stable question for unknown %s without consulting libraries", (_label, mutate, path) => {
    const draft = withImpedance(); mutate(draft);
    const resolver = { resolveSymbol: vi.fn(() => null), resolveFootprint: vi.fn(() => null) };
    const result = compilePcbPlaneDesignIntentDraft(draft, { ...dependencies, libraryResolver: resolver });
    expect(result.disposition, JSON.stringify(result.issues)).toBe("needs_clarification");
    expect(result.questions).toContainEqual(expect.objectContaining({ path }));
    expect(resolver.resolveSymbol).not.toHaveBeenCalled();
    expect(resolver.resolveFootprint).not.toHaveBeenCalled();
  });

  it.each([
    ["duplicate interface", (d: any) => { d.interfaceRequirements.interfaces.push(structuredClone(pair(d))); }],
    ["overlapping interface", (d: any) => { d.interfaceRequirements.interfaces.push({ ...structuredClone(pair(d)), id: "OTHER" }); }],
    ["one member net", (d: any) => { pair(d).nets.negative = "DP"; }],
    ["unknown net", (d: any) => { pair(d).nets.negative = "MISSING"; }],
    ["wrong polarity endpoint", (d: any) => { pair(d).endpoints.source.positive.pin = "2"; }],
    ["unknown endpoint", (d: any) => { pair(d).endpoints.source.positive.reference = "MISSING"; }],
    ["wrong integrated endpoint", (d: any) => { pair(d).terminations.source = { kind: "integrated", componentReference: "J2", positivePin: "1", negativePin: "2", source: evidence() }; }],
    ["forbidden inversion", (d: any) => { pair(d).routing.polarityInversion.receiverMapping = "inverted"; }],
    ["width interval", (d: any) => { pair(d).geometry.traceWidthMm.minimumMm = 0.7; }],
    ["width class inconsistency", (d: any) => { pair(d).geometry.traceWidthMm.maximumMm = 0.45; }],
    ["weakened gap", (d: any) => { pair(d).geometry.edgeGapMm.minimumMm = 0.2; }],
    ["excess skew", (d: any) => { pair(d).geometry.maxEtchSkewMm = 101; }],
    ["excess uncoupled length", (d: any) => { pair(d).geometry.maxUncoupledLengthMm = 101; }],
    ["unknown plane", (d: any) => { pair(d).routing.referencePlaneId = "MISSING"; }],
    ["duplicate layer", (d: any) => { pair(d).routing.allowedLayers = ["F.Cu", "F.Cu"]; }],
    ["missing reference coverage", (d: any) => { d.routingConstraints.nets.find((r: any) => r.net === "DP").referencePath = { mode: "none" }; }],
    ["impedance without construction", (d: any) => { d.interfaceRequirements.construction = { mode: "none" }; }],
    ["wrong construction", (d: any) => { pair(d).impedance.constructionId = "MISSING"; }],
    ["wrong material frequency", (d: any) => { d.interfaceRequirements.construction.dielectric.frequencyHz = 1; }],
    ["total thinner than declared copper", (d: any) => { d.interfaceRequirements.construction.boardThicknessMm = 0.001; }],
    ["total thinner than declared dielectric", (d: any) => { d.interfaceRequirements.construction.dielectric.thicknessMm = 100; }],
    ["total thinner than combined copper and dielectric", (d: any) => { d.interfaceRequirements.construction.boardThicknessMm = 1.55; }],
    ["unexplained excess total thickness", (d: any) => { d.interfaceRequirements.construction.boardThicknessMm = 1.7; }],
    ["sub-nanometre construction", (d: any) => { d.interfaceRequirements.construction.frontCopperThicknessMm = 0.0350001; }],
    ["native thickness overflow", (d: any) => { d.interfaceRequirements.construction.boardThicknessMm = 2147.483638; }],
    ["unrepresentable native Er", (d: any) => { d.interfaceRequirements.construction.dielectric.relativePermittivity = 4.0000000001; }],
    ["unrepresentable native Df", (d: any) => { d.interfaceRequirements.construction.dielectric.lossTangent = 1e-20; }],
    ["unspecified material sentinel", (d: any) => { d.interfaceRequirements.construction.dielectric.material = "Not specified"; }],
    ["unspecified finish sentinel", (d: any) => { d.interfaceRequirements.construction.surfaceFinish = "NOT SPECIFIED"; }],
    ["zero impedance lower bound", (d: any) => { pair(d).impedance.toleranceOhms = 100; }],
    ["claimed physical authority", (d: any) => { pair(d).source.kind = "verified_physical"; }],
    ["unknown property", (d: any) => { pair(d).ignoreDrc = true; }],
    ["negative zero", (d: any) => { pair(d).geometry.maxEtchSkewMm = -0; }],
  ] as const)("rejects contradictory %s", (_label, mutate) => {
    const draft = withImpedance(); mutate(draft);
    expect(() => closePcbPlaneDesignIntentDraft(draft)).toThrow();
    expect(compilePcbPlaneDesignIntentDraft(draft, dependencies).disposition).not.toBe("ready");
  });

  it("rejects undeclared termination branches and misplaced external termination pins", () => {
    const draft = pairDraft(); addParallel(draft);
    pair(draft).terminations.receiver = { kind: "none", source: evidence() };
    expect(() => closePcbPlaneDesignIntentDraft(draft)).toThrow(/undeclared taps/);
    const swapped = pairDraft(); addParallel(swapped);
    pair(swapped).terminations.receiver.positivePin = "2";
    pair(swapped).terminations.receiver.negativePin = "1";
    expect(() => closePcbPlaneDesignIntentDraft(swapped)).toThrow(/polarity/);
  });

  it("retains declared source-series topology and returns explicit unsupported", () => {
    const draft = pairDraft();
    const resistor = planeDividerDraft().components[1]!;
    draft.components.push(...["RS1", "RS2"].map(reference => ({ ...structuredClone(resistor), reference,
      pins: ["1", "2"].map(pin => ({ pin, assignment: { kind: "no_connect" } })) })));
    pair(draft).terminations.source = { kind: "source_series", positive: { componentReference: "RS1", sourcePin: "1", linePin: "2", resistanceOhms: 22 },
      negative: { componentReference: "RS2", sourcePin: "1", linePin: "2", resistanceOhms: 22 }, maximumDistanceToEndpointMm: 1, source: evidence() };
    const result = compilePcbPlaneDesignIntentDraft(draft, dependencies);
    expect(result).toMatchObject({ disposition: "unsupported", contract: null });
    expect(result.draft?.interfaceRequirements?.interfaces[0]?.terminations?.source?.kind).toBe("source_series");
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "UNSUPPORTED_INTERFACE_TOPOLOGY", path: "/interfaceRequirements/interfaces/LINK/terminations/source" }));
    expect(() => closePcbPlaneDesignIntentDraft(draft)).toThrow(/unsupported/);
  });

  it("canonicalizes interface paths and allowed-layer permutations without adding absent fields", () => {
    const draft = pairDraft(), baseline = closePcbPlaneDesignIntentDraft(draft);
    draft.components.reverse(); draft.nets.reverse(); draft.routingConstraints.nets.reverse(); pair(draft).routing.allowedLayers.reverse();
    expect(closePcbPlaneDesignIntentDraft(draft).identity).toEqual(baseline.identity);
    draft.unresolved = [{ path: "/interfaceRequirements/interfaces/0/geometry/maxEtchSkewMm", question: "Confirm skew." }];
    const parsed = parsePcbPlaneDesignIntentDraft(draft);
    expect(parsed.unresolved[0]!.path).toBe("/interfaceRequirements/interfaces/LINK/geometry/maxEtchSkewMm");
    expect(normalizePcbPlaneUnresolvedPath(parsed, parsed.unresolved[0]!.path)).toBe(parsed.unresolved[0]!.path);
    draft.unresolved.push({ path: parsed.unresolved[0]!.path, question: "Duplicate alias." });
    expect(() => parsePcbPlaneDesignIntentDraft(draft)).toThrow(/duplicated/);
  });

  it("retains explicit mask properties and validates their total thickness and frequency", () => {
    const draft = withImpedance(), stack = draft.interfaceRequirements.construction;
    stack.solderMask.front = { kind: "present", thicknessMm: 0.02, material: "fixture mask", relativePermittivity: 3.5, lossTangent: 0.025, frequencyHz: 100_000_000, source: evidence() };
    stack.boardThicknessMm = 1.59;
    expect(compilePcbPlaneDesignIntentDraft(draft, dependencies).disposition).toBe("ready");
    stack.boardThicknessMm = 1.57;
    expect(() => closePcbPlaneDesignIntentDraft(draft)).toThrow(/present-mask/);
    stack.boardThicknessMm = 1.59; stack.solderMask.front.frequencyHz = 1;
    expect(() => closePcbPlaneDesignIntentDraft(draft)).toThrow(/Mask properties/);
  });

  it("canonicalizes independent interface ordering and keeps questions keyed to interface IDs", () => {
    const draft = pairDraft(), extra = structuredClone(pair(draft));
    extra.id = "OTHER"; extra.nets = { positive: "DP2", negative: "DN2" };
    extra.endpoints = { source: { positive: point("J3", "1"), negative: point("J3", "2") }, receiver: { positive: point("J4", "1"), negative: point("J4", "2") } };
    draft.interfaceRequirements.interfaces.push(extra);
    for (const [oldRef, newRef] of [["J1", "J3"], ["J2", "J4"]]) {
      const component = structuredClone(draft.components.find((c: any) => c.reference === oldRef)); component.reference = newRef;
      for (const pin of component.pins) if (pin.assignment.net !== "GND") pin.assignment.net += "2";
      draft.components.push(component);
      draft.placementConstraints.push({ ...structuredClone(draft.placementConstraints.find((p: any) => p.reference === oldRef)), reference: newRef });
      draft.nets.find((n: any) => n.name === "GND").endpoints.push(point(newRef!, "3"));
    }
    for (const name of ["DP", "DN"]) {
      const net = structuredClone(draft.nets.find((n: any) => n.name === name)); net.name += "2";
      for (const endpoint of net.endpoints) endpoint.reference = endpoint.reference === "J1" ? "J3" : "J4";
      draft.nets.push(net);
      const route = structuredClone(draft.routingConstraints.nets.find((r: any) => r.net === name)); route.net += "2";
      for (const terminal of route.referencePath.terminalReferences) for (const field of ["signalEndpoint", "referenceEndpoint"])
        terminal[field].reference = terminal[field].reference === "J1" ? "J3" : "J4";
      draft.routingConstraints.nets.push(route);
    }
    const baseline = closePcbPlaneDesignIntentDraft(draft);
    draft.interfaceRequirements.interfaces.reverse(); draft.components.reverse(); draft.nets.reverse(); draft.routingConstraints.nets.reverse();
    expect(closePcbPlaneDesignIntentDraft(draft).identity).toEqual(baseline.identity);
    draft.unresolved = [{ path: "/interfaceRequirements/interfaces/0/geometry/maxEtchSkewMm", question: "Confirm second link skew." }];
    expect(parsePcbPlaneDesignIntentDraft(draft).unresolved[0]!.path).toBe("/interfaceRequirements/interfaces/OTHER/geometry/maxEtchSkewMm");
  });
});
