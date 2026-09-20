import { describe, expect, it } from "vitest";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { parsePcbDesignContract, parsePcbDesignIntentDraft } from "../../src/harness/pcb-design-contract.js";
import { parsePcbDesignCompilationBundle, serializePcbDesignCompilationBundle } from "../../src/harness/pcb-design-compilation-bundle.js";
import { createGenericDividerBundleFixture, genericDividerDraft, genericDividerLibraryResolver } from "../helpers/generic-divider-bundle.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";
import { createFreshPlaneRules } from "../../src/harness/fresh-plane-rules.js";
import { PCB_PLANE_DESIGN_INTENT_MODEL_GUIDE, PCB_PLANE_DESIGN_INTENT_VALID_EXAMPLE } from "../../src/harness/pcb-design-plane-model-guide.js";
import {
  PCB_PLANE_CONTRACT_SCHEMA_VERSION, PCB_PLANE_DRAFT_SCHEMA_VERSION,
  closePcbPlaneDesignIntentDraft, parsePcbPlaneDesignContract, parsePcbPlaneDesignIntentDraft,
  normalizePcbPlaneUnresolvedPath,
} from "../../src/harness/pcb-design-plane-contract.js";
import { compilePcbPlaneDesignIntentDraft, type PcbPlaneReadyCompilation } from "../../src/harness/pcb-design-plane-compiler.js";
import {
  createPcbPlaneCompilationBundle, createPcbPlaneCompilationBundleRef,
  parsePcbPlaneCompilationBundle, parsePcbPlaneCompilationBundleRef, serializePcbPlaneCompilationBundle,
  verifyPcbPlaneCompilationBundleRef,
} from "../../src/harness/pcb-design-plane-bundle.js";

const catalog = loadDeepRuleCatalog();
const dependencies = { libraryResolver: genericDividerLibraryResolver, deepRuleCatalog: catalog };
const ready = (): PcbPlaneReadyCompilation => {
  const result = compilePcbPlaneDesignIntentDraft(planeDividerDraft(), dependencies);
  expect(result.disposition, JSON.stringify(result.issues)).toBe("ready");
  if (result.disposition !== "ready") throw new Error("Plane fixture failed compilation");
  return result;
};
const mutable = (): Record<string, any> => structuredClone(planeDividerDraft());
const ground = (draft: Record<string, any>) => draft.routingConstraints.nets.find((route: any) => route.net === "GND");
const signal = (draft: Record<string, any>) => draft.routingConstraints.nets.find((route: any) => route.net === "VIN");
const bundle = () => createPcbPlaneCompilationBundle({ originalPrompt: "Synthetic ground-plane contract with explicit return terminals.", compilation: ready() }, dependencies);

describe("direct-toolbox V2 plane contract foundation", () => {
  it("preserves the captured omitted-interface V2 compiler, artifacts, guide, bundle bytes and canonical DRU", () => {
    const compilation = ready();
    const value = bundle();
    expect(compilation.contract).not.toHaveProperty("interfaceRequirements");
    expect(compilation.draft).not.toHaveProperty("interfaceRequirements");
    expect(contentIdentity(canonicalJson(compilation))).toEqual({ algorithm: "sha256", digest: "3b1c69afe0d80801d845745a6e364c61dd4d36f890d738b6e50ac60a7390b540", size: 59292 });
    expect(compilation.contract.identity.digest).toBe("302b8db0af86f5f3cf8f5e0f12d4c947672dca9ad163323475d8f11f8ab81637");
    expect(value.compilerId).toBe("evleda.pcb-plane-compiler.v1");
    expect(value.identity.digest).toBe("4071a930d10468bc67ea7167f4bd73e30b373ef86a72a82bdd39406971608e91");
    expect(createPcbPlaneCompilationBundleRef(value).identity.digest).toBe("ac8c8cd6d62459fccdfac2b7f2c329131e0b8f0be18556dc699716a329ce867f");
    expect(contentIdentity(serializePcbPlaneCompilationBundle(value))).toEqual({ algorithm: "sha256", digest: "3711883cdffb8e354f9ca3a7ffd0f6803273b3e6c09ec40deb18b13af1a44fe7", size: 60602 });
    expect(createFreshPlaneRules(value).identity).toEqual({ algorithm: "sha256", digest: "efa1e786021e9799722a21986f1818e21e3a9f51e3c08e6460d845824fe1ee2e", size: 329 });
    // Access-layer guidance evolves independently of the unchanged legacy bundle and DRU.
    expect(contentIdentity(PCB_PLANE_DESIGN_INTENT_MODEL_GUIDE)).toEqual({ algorithm: "sha256", digest: "0503f1b29f2b9a5baf58e8723affa5b414cc923ffc1451c43f294d24180662fb", size: 10628 });
    expect(contentIdentity(canonicalJson(PCB_PLANE_DESIGN_INTENT_VALID_EXAMPLE))).toEqual({ algorithm: "sha256", digest: "d46af532e582cc923165128c1a48cfa38ffb893b6ac39b5ff9731e6b04b4ea52", size: 2720 });
  });
  it("closes real plane routing and reference intent without changing schematic connectivity", () => {
    const input = planeDividerDraft();
    const before = canonicalJson(input);
    const contract = closePcbPlaneDesignIntentDraft(input);
    expect(contract.schemaVersion).toBe(PCB_PLANE_CONTRACT_SCHEMA_VERSION);
    expect(contract.routingConstraints.nets.find(route => route.net === "GND")).toMatchObject({ topology: "plane", planeId: "GND_PLANE" });
    expect(contract.planes[0]).toMatchObject({ net: "GND", layer: "B.Cu", clearanceMm: 0.25, minimumCopperWidthMm: 0.5 });
    const originalNets = [...input.nets].sort((a, b) => a.name.localeCompare(b.name));
    expect(contract.nets.map(n => ({ name: n.name, endpoints: n.endpoints }))).toEqual(originalNets.map(n => ({ name: n.name, endpoints: n.endpoints })));
    expect(canonicalJson(input)).toBe(before);
    expect(parsePcbPlaneDesignContract(structuredClone(contract))).toEqual(contract);
    expect(Object.isFrozen(contract.planes[0]!.padConnection)).toBe(true);
    const result = ready();
    expect(result.libraryBinding.contractIdentity).toEqual(contract.identity);
    expect(result.deepRuleBinding.contractIdentity).toEqual(contract.identity);
    expect(result.verificationPlan.requirements).toContainEqual(expect.objectContaining({ id: "plane-net:GND", kind: "plane_connectivity" }));
    expect(result.verificationPlan.requirements).toContainEqual(expect.objectContaining({ id: "reference:VIN", kind: "reference_path" }));
    expect(result.verificationPlan.requirements).not.toContainEqual(expect.objectContaining({ id: "trace-net:GND" }));
    expect(result).toMatchObject({ foundationOnly: true, nativeAuthoringPerformed: false, acceptanceEvaluated: false });
  });

  it.each([
    ["unknown plane net", (d: any) => { d.planes[0].net = "MISSING"; }],
    ["non-ground plane", (d: any) => { d.nets.find((n: any) => n.name === "GND").role = "passive"; }],
    ["forbidden plane layer", (d: any) => { d.netClasses[0].allowedLayers = ["F.Cu"]; }],
    ["inner plane layer", (d: any) => { d.planes[0].layer = "In1.Cu"; }],
    ["weakened clearance", (d: any) => { d.planes[0].clearanceMm = 0.2; }],
    ["zero minimum width", (d: any) => { d.planes[0].minimumCopperWidthMm = 0; }],
    ["negative zero", (d: any) => { d.planes[0].islandPolicy.minimumAreaMm2 = -0; }],
    ["inverted boundary", (d: any) => { d.planes[0].boundary.maxXmm = 0.4; }],
    ["board overflow", (d: any) => { d.planes[0].boundary.maxXmm = 31; }],
    ["edge clearance", (d: any) => { d.planes[0].boundary.minXmm = 0.1; }],
    ["unbounded polygon", (d: any) => { d.planes[0].boundary.kind = "polygon"; }],
    ["hatch copper", (d: any) => { d.planes[0].copperFill = "hatch"; }],
    ["undersized spokes", (d: any) => { d.planes[0].padConnection.spokeWidthMm = 0.25; }],
    ["invalid spokes", (d: any) => { d.planes[0].padConnection.minimumConnectedSpokes = 5; }],
    ["retained unconnected islands", (d: any) => { d.planes[0].islandPolicy.removeUnconnected = false; }],
    ["multiple components", (d: any) => { d.planes[0].islandPolicy.requireSingleConnectedComponent = false; }],
    ["impossible island area", (d: any) => { d.planes[0].islandPolicy.minimumAreaMm2 = 600; }],
    ["extra plane", (d: any) => { d.planes.push(structuredClone(d.planes[0])); }],
    ["missing plane", (d: any) => { d.planes = []; }],
    ["tree in place of plane", (d: any) => { d.routingConstraints.nets = d.routingConstraints.nets.filter((r: any) => r.net !== "GND"); d.routingConstraints.nets.push({ net: "GND", topology: "tree", preferredLayer: "F.Cu", maxVias: 0, routeLength: { mode: "unbounded" }, referencePath: { mode: "none" } }); }],
    ["unknown plane ID", (d: any) => { ground(d).planeId = "OTHER"; }],
    ["wrong plane owner", (d: any) => { ground(d).net = "VIN"; }],
    ["duplicate plane owner", (d: any) => { d.routingConstraints.nets.push(structuredClone(ground(d))); }],
    ["missing route", (d: any) => { d.routingConstraints.nets = d.routingConstraints.nets.filter((r: any) => r.net !== "VOUT"); }],
    ["unknown routing net", (d: any) => { signal(d).net = "UNKNOWN"; }],
    ["three-terminal point path", (d: any) => { d.routingConstraints.nets.find((r: any) => r.net === "VOUT").topology = "point_to_point"; }],
    ["global via conflict", (d: any) => { d.routingConstraints.viaPolicy = { mode: "forbidden", maxTotal: 0 }; }],
    ["combined via budget", (d: any) => { signal(d).referencePath = { mode: "none" }; signal(d).maxVias = 1; }],
    ["invalid annular ring", (d: any) => { d.routingConstraints.viaPolicy.minimumAnnularRingMm = 0.2; }],
    ["reference transition", (d: any) => { signal(d).maxVias = 1; d.routingConstraints.viaPolicy.maxTotal = 3; }],
    ["same-layer reference", (d: any) => { signal(d).referencePath.signalLayer = "B.Cu"; signal(d).preferredLayer = "B.Cu"; }],
    ["ambiguous referenced layer", (d: any) => { signal(d).preferredLayer = "either"; }],
    ["unknown reference plane", (d: any) => { signal(d).referencePath.planeId = "UNKNOWN"; }],
    ["missing terminal map", (d: any) => { signal(d).referencePath.terminalReferences.pop(); }],
    ["duplicate signal terminal", (d: any) => { const refs = signal(d).referencePath.terminalReferences; refs[1] = structuredClone(refs[0]); }],
    ["wrong reference terminal", (d: any) => { signal(d).referencePath.terminalReferences[0].referenceEndpoint = { reference: "R1", pin: "1" }; }],
    ["wrong signal terminal", (d: any) => { signal(d).referencePath.terminalReferences[0].signalEndpoint = { reference: "R2", pin: "1" }; }],
    ["extra authority flag", (d: any) => { d.fabricationAuthorized = true; }],
    ["unknown plane setting", (d: any) => { d.planes[0].ignoreDrc = true; }],
  ] as const)("rejects %s", (_label, mutate) => {
    const value = mutable(); mutate(value);
    expect(() => closePcbPlaneDesignIntentDraft(value)).toThrow();
    expect(compilePcbPlaneDesignIntentDraft(value, dependencies).disposition).not.toBe("ready");
  });

  it.each([
    ["plane clearance", (d: any) => { d.planes[0].clearanceMm = null; }, "/planes/GND_PLANE/clearanceMm"],
    ["thermal gap", (d: any) => { d.planes[0].padConnection.gapMm = null; }, "/planes/GND_PLANE/padConnection/gapMm"],
    ["access routing", (d: any) => { ground(d).accessRouting = null; }, "/routingConstraints/nets/GND/accessRouting"],
    ["reference margin", (d: any) => { signal(d).referencePath.coverageMarginMm = null; }, "/routingConstraints/nets/VIN/referencePath/coverageMarginMm"],
    ["board width", (d: any) => { d.scope.board.widthMm = null; }, "/scope/board/widthMm"],
  ] as const)("asks a stable explicit question for unresolved %s", (_label, mutate, path) => {
    const value = mutable(); mutate(value);
    const result = compilePcbPlaneDesignIntentDraft(value, dependencies);
    expect(result.disposition).toBe("needs_clarification");
    expect(result.questions).toContainEqual(expect.objectContaining({ path }));
    expect(result.contract).toBeNull();
  });

  it("resolves keyed and numeric questions without unknown paths, duplicate aliases, or array-order drift", () => {
    const value = mutable();
    value.unresolved = [{ path: "/planes/0/clearanceMm", question: "Confirm the manufacturing clearance." }];
    const parsed = parsePcbPlaneDesignIntentDraft(value);
    expect(parsed.unresolved[0]!.path).toBe("/planes/GND_PLANE/clearanceMm");
    expect(normalizePcbPlaneUnresolvedPath(parsed, "/planes/GND_PLANE/clearanceMm")).toBe("/planes/GND_PLANE/clearanceMm");
    expect(compilePcbPlaneDesignIntentDraft(value, dependencies).questions[0]!.question).toContain("manufacturing clearance");
    value.unresolved.push({ path: "/planes/GND_PLANE/clearanceMm", question: "Duplicate alias" });
    expect(() => parsePcbPlaneDesignIntentDraft(value)).toThrow();
    value.unresolved = [{ path: "/planes/GND_PLANE/nonexistent", question: "Unknown" }];
    expect(() => parsePcbPlaneDesignIntentDraft(value)).toThrow();
    const normal = closePcbPlaneDesignIntentDraft(planeDividerDraft());
    const reordered = mutable(); reordered.components.reverse(); reordered.nets.reverse(); reordered.planes.reverse(); reordered.routingConstraints.nets.reverse();
    signal(reordered).referencePath.terminalReferences.reverse();
    expect(closePcbPlaneDesignIntentDraft(reordered).identity).toEqual(normal.identity);
    const forged = structuredClone(normal) as any; forged.nets.reverse();
    const { identity: _identity, ...payload } = forged;
    forged.identity = canonicalIdentity(payload, PCB_PLANE_CONTRACT_SCHEMA_VERSION);
    expect(() => parsePcbPlaneDesignContract(forged)).toThrow(/canonical/);
    const reservedId = mutable(); reservedId.planes[0].id = "constructor"; ground(reservedId).planeId = "constructor";
    signal(reservedId).referencePath.planeId = "constructor";
    reservedId.unresolved = [{ path: "/planes/constructor/clearanceMm", question: "Confirm this declared plane's clearance." }];
    expect(parsePcbPlaneDesignIntentDraft(reservedId).unresolved[0]!.path).toBe("/planes/constructor/clearanceMm");
    expect(normalizePcbPlaneUnresolvedPath(reservedId, "/planes/__proto__/clearanceMm")).toBeNull();
  });

  it("reuses bounded stock-library diagnostics and refuses hostile input without invoking accessors", () => {
    const bad = mutable(); bad.components[0].symbolLibId = "Missing:Symbol";
    expect(compilePcbPlaneDesignIntentDraft(bad, dependencies)).toMatchObject({ disposition: "needs_clarification", contract: null });
    const unsupported = { ...genericDividerLibraryResolver, resolveFootprint: (id: string) => {
      const original = genericDividerLibraryResolver.resolveFootprint(id); return original === null ? null : { ...original, source: "project-custom" as const };
    } };
    expect(compilePcbPlaneDesignIntentDraft(planeDividerDraft(), { ...dependencies, libraryResolver: unsupported }).disposition).toBe("unsupported");
    let calls = 0; const hostile = mutable(); Object.defineProperty(hostile, "planes", { get() { calls++; throw new Error("getter invoked"); }, enumerable: true });
    expect(compilePcbPlaneDesignIntentDraft(hostile, dependencies).disposition).toBe("needs_clarification");
    expect(calls).toBe(0);
    const cyclic: any = {}; cyclic.self = cyclic;
    expect(() => parsePcbPlaneDesignIntentDraft(cyclic)).toThrow();
    expect(() => parsePcbPlaneDesignIntentDraft({ ...planeDividerDraft(), huge: "x".repeat(300_000) })).toThrow();
    const result = compilePcbPlaneDesignIntentDraft(planeDividerDraft(), { ...dependencies, deepRuleSelectionOptions: { tokenCounter: () => 0 } as any });
    expect(result.disposition).toBe("needs_clarification");
  });

  it("binds and independently reconstructs the whole V2 canonical bundle and reference", () => {
    const value = bundle(); const bytes = serializePcbPlaneCompilationBundle(value);
    const parsed = parsePcbPlaneCompilationBundle(bytes, dependencies);
    expect(parsed).toEqual(value);
    expect(bytes.toString()).toBe(canonicalJson(value) + "\n");
    const ref = createPcbPlaneCompilationBundleRef(value);
    expect(parsePcbPlaneCompilationBundleRef(structuredClone(ref))).toEqual(ref);
    expect(verifyPcbPlaneCompilationBundleRef(ref, parsed)).toEqual(ref);
    expect(ref.contentIdentity).toEqual(contentIdentity(bytes));
    expect(() => serializePcbPlaneCompilationBundle(structuredClone(value))).toThrow(/independently/);
    expect(() => parsePcbPlaneCompilationBundle(JSON.stringify(value, null, 2), dependencies)).toThrow(/canonical/);
    expect(() => parsePcbPlaneCompilationBundle(bytes.toString().trimEnd(), dependencies)).toThrow(/canonical/);
    expect(() => parsePcbPlaneCompilationBundle(bytes.toString().replace(/^\{/u, '{"schemaVersion":"duplicate",'), dependencies)).toThrow();
    const forged = structuredClone(value) as any; forged.contract.planes[0].clearanceMm = 0.3;
    const { identity: _identity, ...payload } = forged; forged.identity = canonicalIdentity(payload, value.schemaVersion);
    expect(() => parsePcbPlaneCompilationBundle(forged, dependencies)).toThrow(/reconstruction/);
    const extra = { ...value, amendment: { net: "GND", topology: "tree" } };
    expect(() => parsePcbPlaneCompilationBundle(extra, dependencies)).toThrow(/reconstruction/);
    expect(() => parsePcbPlaneCompilationBundle(value, { ...dependencies, deepRuleSelectionOptions: { maxRules: 39 } })).toThrow(/host pin/);
    const wrongRef = structuredClone(ref) as any; wrongRef.contentIdentity.digest = "a".repeat(64);
    const { identity: _refIdentity, ...refPayload } = wrongRef; wrongRef.identity = canonicalIdentity(refPayload, ref.schemaVersion);
    expect(() => verifyPcbPlaneCompilationBundleRef(wrongRef, value)).toThrow(/exact authenticated/);
  });

  it("discriminates V1 and V2 without global schema replacement or a tree-plus-amendment contract", () => {
    const old = createGenericDividerBundleFixture();
    expect(() => parsePcbPlaneDesignIntentDraft(genericDividerDraft())).toThrow();
    expect(() => parsePcbDesignIntentDraft(planeDividerDraft())).toThrow();
    expect(() => parsePcbDesignContract(ready().contract)).toThrow();
    expect(() => parsePcbPlaneDesignContract(old.bundle.contract)).toThrow();
    expect(() => parsePcbPlaneCompilationBundle(old.bundle, dependencies)).toThrow(/V2/);
    expect(() => parsePcbDesignCompilationBundle(bundle(), old.dependencies)).toThrow();
    expect(PCB_PLANE_DRAFT_SCHEMA_VERSION).toBe("evleda.pcb-design-intent-draft.v2");
    expect(old.bundle.contract.schemaVersion).toBe("evleda.pcb-design-contract.v1");
  });

  it("preserves the pre-refactor V1 golden draft, contract, bundle, reference and exact canonical bytes", () => {
    const old = createGenericDividerBundleFixture();
    expect(contentIdentity(canonicalJson(genericDividerDraft()))).toEqual({ algorithm: "sha256", digest: "757254e21779e461d150caf85dfc810f7866296135fb8b981fb1abcccaa6876f", size: 3683 });
    expect(old.bundle.contract.identity.digest).toBe("e4fdc5fb3aedffdd35253aed643532d5fd8ba210daea0a2806a9d8b59ecb86b7");
    expect(old.bundle.identity.digest).toBe("a1f68f7a0ff3b2da3c47f39942becfbb69e1c8790421a68eab318359fc315481");
    expect(old.reference.identity.digest).toBe("c831caddab48c196fb2b0e7a50c3207dbb0a2ac7fcfd92084f981a1e741fe8be");
    expect(contentIdentity(serializePcbDesignCompilationBundle(old.bundle))).toEqual({ algorithm: "sha256", digest: "5c69d89104c0ae69e64fbacfbfbf5cc1a113284d6cfcd5b1b47110e1f78d7a14", size: 60599 });
  });
});
