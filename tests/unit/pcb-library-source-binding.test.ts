import { describe, expect, it } from "vitest";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import {
  compilePcbDesignIntentDraft, compilePcbDesignIntentDraftV1,
  type PcbReadOnlyLibraryResolver,
} from "../../src/harness/pcb-design-compiler.js";
import {
  createPcbDesignCompilationBundle, createPcbDesignCompilationBundleRef,
  parsePcbDesignCompilationBundle, serializePcbDesignCompilationBundle,
} from "../../src/harness/pcb-design-compilation-bundle.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import {
  createPcbPlaneCompilationBundle, parsePcbPlaneCompilationBundle, serializePcbPlaneCompilationBundle,
} from "../../src/harness/pcb-design-plane-bundle.js";
import { createFreshPlaneRules } from "../../src/harness/fresh-plane-rules.js";
import {
  PCB_LIBRARY_SOURCE_SELECTION_SCHEMA_VERSION, assertPcbLibrarySourcesCurrent,
  capturePcbLibrarySourceSelection, createPcbLibrarySourceSelection, parsePcbLibrarySourceSelection,
  type PcbLibrarySourceSelectionRequest, type PcbLibrarySourceSelectionRecord,
} from "../../src/harness/pcb-library-source-binding.js";
import { genericDividerDraft, genericDividerLibraryResolver } from "../helpers/generic-divider-bundle.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";

const catalog = loadDeepRuleCatalog();
const prompt = "Source selection regression fixture.";
const dependencies = (libraryResolver: PcbReadOnlyLibraryResolver) => ({ libraryResolver, deepRuleCatalog: catalog });
const selected = (): PcbLibrarySourceSelectionRequest => ({
  symbolIds: [...new Set(genericDividerDraft().components.map(component => component.symbolLibId))],
  footprintIds: [...new Set(genericDividerDraft().components.map(component => component.footprintLibId))],
});

/** An explicit host capability for software tests; portable callers cannot install one. */
function sourceHost() {
  const events: string[] = [];
  const state = { rawSuffix: "", policy: "fixed root A", inspection: "native geometry A", onResolve: () => {} };
  const resolver: PcbReadOnlyLibraryResolver = {
    resolveSymbol(libraryId) { events.push(`symbol:${libraryId}`); state.onResolve(); return genericDividerLibraryResolver.resolveSymbol(libraryId); },
    resolveFootprint(libraryId) { events.push(`footprint:${libraryId}`); state.onResolve(); return genericDividerLibraryResolver.resolveFootprint(libraryId); },
    captureSourceSelection(request) {
      expect(this).toBe(resolver);
      events.push("capture");
      const records: PcbLibrarySourceSelectionRecord[] = [
        ...request.symbolIds.map(libraryId => ({ kind: "symbol" as const, libraryId,
          sourceIdentity: contentIdentity(`(symbol ${libraryId} (text "${state.rawSuffix}"))`),
          inspectionIdentity: canonicalIdentity({ libraryId, geometry: state.inspection }, "evleda.kicad-stock-symbol-inspection.v1") })),
        ...request.footprintIds.map(libraryId => ({ kind: "footprint" as const, libraryId,
          sourceIdentity: contentIdentity(`(footprint ${libraryId} (geometry "${state.rawSuffix}"))`),
          inspectionIdentity: canonicalIdentity({ libraryId, geometry: state.inspection }, "evleda.kicad-stock-footprint-inspection.v2") })),
      ];
      return createPcbLibrarySourceSelection({ policyIdentity: canonicalIdentity({ policy: state.policy }, "evleda.kicad-stock-catalog-policy.v1"), records }, request);
    },
  };
  return { state, resolver, events };
}
function v1(libraryResolver: PcbReadOnlyLibraryResolver) {
  const deps = dependencies(libraryResolver);
  const compilation = compilePcbDesignIntentDraft(genericDividerDraft(), deps);
  expect(compilation.disposition, JSON.stringify(compilation.issues)).toBe("ready");
  const bundle = createPcbDesignCompilationBundle({ originalPrompt: prompt, compilation }, deps);
  return { compilation, bundle, deps };
}
function v2(libraryResolver: PcbReadOnlyLibraryResolver) {
  const deps = dependencies(libraryResolver);
  const compilation = compilePcbPlaneDesignIntentDraft(planeDividerDraft(), deps);
  expect(compilation.disposition, JSON.stringify(compilation.issues)).toBe("ready");
  if (compilation.disposition !== "ready") throw new Error("Expected ready fixture");
  const bundle = createPcbPlaneCompilationBundle({ originalPrompt: prompt, compilation }, deps);
  return { compilation, bundle, deps };
}
function rehash(value: any): any {
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) if (key !== "identity") rehash(entry);
    if (value.identity?.canonicalizationVersion === "evleda-c14n-json-v1") {
      const { identity, ...payload } = value;
      value.identity = canonicalIdentity(payload, identity.schemaVersion);
    }
  }
  return value;
}

describe("optional selected library source binding", () => {
  it("preserves pre-change V1 compiler and legacy-plan bytes and identities when the host omits the capability", () => {
    const goldens = [
      { compile: compilePcbDesignIntentDraft, compilation: { algorithm: "sha256", digest: "99dd2c644a58d9f8c81746760ac9b73475e731bfccf631f29d6ced562f2b7c8c", size: 38799 },
        bundle: { algorithm: "sha256", digest: "97b1047aa814f9740d637fccd5bbf5771dd691b4b59d03e6b664e8dd0c9d77fc", size: 60571 },
        identity: "ea14a61f686fec3566b12df2c0d60ae7c8bdf9728408be650f286570294b6b1a", reference: "5528c292aa529aa245373af086eb1a020551f0872f432f12f73a7aa0cd4f7596" },
      { compile: compilePcbDesignIntentDraftV1, compilation: { algorithm: "sha256", digest: "d0a6e5ba249998174debcee4fd7d89e3f0366faebcf1e6c2b345b794010cf2d7", size: 38542 },
        bundle: { algorithm: "sha256", digest: "7259fade3d0142c5b109553de30186c5779c9f59a081d41cbffa3d85d87ad89e", size: 59686 },
        identity: "f8a04f06ed65560e4da875d411a664519c15ea3444db288b48e270984729bf49", reference: "772f33568bc87ad8110a510f5b559a9118e6d6aae25f6e740d38c03ea2a787e5" },
    ];
    for (const golden of goldens) {
      const deps = dependencies(genericDividerLibraryResolver);
      const compilation = golden.compile(genericDividerDraft(), deps);
      const bundle = createPcbDesignCompilationBundle({ originalPrompt: prompt, compilation }, deps);
      expect(compilation.libraryBinding).not.toHaveProperty("sourceSelection");
      expect(contentIdentity(canonicalJson(compilation))).toEqual(golden.compilation);
      expect(contentIdentity(serializePcbDesignCompilationBundle(bundle))).toEqual(golden.bundle);
      expect(bundle.identity.digest).toBe(golden.identity);
      expect(createPcbDesignCompilationBundleRef(bundle).identity.digest).toBe(golden.reference);
      expect(parsePcbDesignCompilationBundle(serializePcbDesignCompilationBundle(bundle), deps)).toEqual(bundle);
      expect(() => assertPcbLibrarySourcesCurrent(bundle.libraryBinding, genericDividerLibraryResolver)).not.toThrow();
    }
  });

  it.each(["v1", "v2"] as const)("%s binds exactly unique selected IDs before and after resolution and reproduces canonical bundles", family => {
    const host = sourceHost();
    const deps = dependencies(host.resolver);
    const compilation = family === "v1" ? compilePcbDesignIntentDraft(genericDividerDraft(), deps) : compilePcbPlaneDesignIntentDraft(planeDividerDraft(), deps);
    expect(compilation.disposition).toBe("ready");
    expect(host.events[0]).toBe("capture");
    expect(host.events.at(-1)).toBe("capture");
    expect(host.events.filter(event => event === "capture")).toHaveLength(2);
    const selection = compilation.libraryBinding!.sourceSelection!;
    expect(selection.records).toHaveLength(4); // repeated R1/R2 asset IDs are bound once
    expect(selection.records.map(record => `${record.kind}:${record.libraryId}`)).toEqual([
      "footprint:Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical", "footprint:Resistor_SMD:R_0603_1608Metric",
      "symbol:Connector_Generic:Conn_01x03", "symbol:Device:R",
    ]);
    expect(Object.isFrozen(selection.records[0]!.sourceIdentity)).toBe(true);
    expect(parsePcbLibrarySourceSelection(structuredClone(selection), selected())).toEqual(selection);
    if (family === "v1") {
      const result = v1(host.resolver);
      expect(parsePcbDesignCompilationBundle(serializePcbDesignCompilationBundle(result.bundle), deps)).toEqual(result.bundle);
      expect(createPcbDesignCompilationBundle({ originalPrompt: prompt, compilation: structuredClone(result.compilation) }, deps)).toEqual(result.bundle);
    } else {
      const result = v2(host.resolver);
      expect(parsePcbPlaneCompilationBundle(serializePcbPlaneCompilationBundle(result.bundle), deps)).toEqual(result.bundle);
      expect(createPcbPlaneCompilationBundle({ originalPrompt: prompt, compilation: structuredClone(result.compilation) }, deps)).toEqual(result.bundle);
      const pinnedRules = createFreshPlaneRules(result.bundle);
      const legacyRules = createFreshPlaneRules(v2(genericDividerLibraryResolver).bundle);
      // Native zone names intentionally bind the bundle digest; the actual rule constraints are preserved.
      expect(pinnedRules.source.replaceAll(/EVLEDA_PLANE_[a-f0-9]{12}/gu, "EVLEDA_PLANE_DIGEST"))
        .toBe(legacyRules.source.replaceAll(/EVLEDA_PLANE_[a-f0-9]{12}/gu, "EVLEDA_PLANE_DIGEST"));
    }
    expect(() => assertPcbLibrarySourcesCurrent(compilation.libraryBinding!, host.resolver)).not.toThrow();
  });

  it.each(["v1", "v2"] as const)("%s rejects raw geometry/text drift despite identical normalized pins and pads", family => {
    const host = sourceHost();
    const original = family === "v1" ? v1(host.resolver) : v2(host.resolver);
    host.state.rawSuffix = "changed text and geometry, same terminal inventory";
    const changed = family === "v1" ? v1(host.resolver) : v2(host.resolver);
    expect(changed.bundle.libraryBinding.symbols).toEqual(original.bundle.libraryBinding.symbols);
    expect(changed.bundle.libraryBinding.footprints).toEqual(original.bundle.libraryBinding.footprints);
    expect(changed.bundle.libraryBinding.identity).not.toEqual(original.bundle.libraryBinding.identity);
    expect(() => assertPcbLibrarySourcesCurrent(original.bundle.libraryBinding, host.resolver)).toThrow(/changed/u);
    if (family === "v1") expect(() => parsePcbDesignCompilationBundle(original.bundle, original.deps)).toThrow();
    else expect(() => parsePcbPlaneCompilationBundle(original.bundle, original.deps)).toThrow();
  });

  it.each(["v1", "v2"] as const)("%s fails closed when capture changes while resolving metadata", family => {
    const host = sourceHost();
    host.state.onResolve = () => { host.state.rawSuffix = "source changed during resolve"; };
    const result = family === "v1" ? compilePcbDesignIntentDraft(genericDividerDraft(), dependencies(host.resolver))
      : compilePcbPlaneDesignIntentDraft(planeDividerDraft(), dependencies(host.resolver));
    expect(result.disposition).toBe("needs_clarification");
    expect(result.libraryBinding).toBeNull();
    expect(result.issues.some(issue => /changed during library resolution/u.test(issue.message))).toBe(true);
  });

  it.each(["v1", "v2"] as const)("%s rejects source capture drift in independent bundle reconstruction", family => {
    const host = sourceHost();
    const result = family === "v1" ? v1(host.resolver) : v2(host.resolver);
    host.state.onResolve = () => { host.state.rawSuffix = "changed during revalidation"; };
    if (family === "v1") expect(() => parsePcbDesignCompilationBundle(result.bundle, result.deps)).toThrow();
    else expect(() => parsePcbPlaneCompilationBundle(result.bundle, result.deps)).toThrow();
  });

  it.each(["v1", "v2"] as const)("%s refuses to add or discard pins when the resolver mode differs", family => {
    const host = sourceHost();
    const unpinned = family === "v1" ? v1(genericDividerLibraryResolver) : v2(genericDividerLibraryResolver);
    const pinned = family === "v1" ? v1(host.resolver) : v2(host.resolver);
    expect(() => assertPcbLibrarySourcesCurrent(unpinned.bundle.libraryBinding, host.resolver)).toThrow();
    expect(() => assertPcbLibrarySourcesCurrent(pinned.bundle.libraryBinding, genericDividerLibraryResolver)).toThrow();
    if (family === "v1") {
      expect(() => parsePcbDesignCompilationBundle(unpinned.bundle, pinned.deps)).toThrow();
      expect(() => parsePcbDesignCompilationBundle(pinned.bundle, unpinned.deps)).toThrow();
    } else {
      expect(() => parsePcbPlaneCompilationBundle(unpinned.bundle, pinned.deps)).toThrow();
      expect(() => parsePcbPlaneCompilationBundle(pinned.bundle, unpinned.deps)).toThrow();
    }
  });

  it.each(["v1", "v2"] as const)("%s rejects omitted, partial, extra, copied-policy, and rehashed tampered source pins", family => {
    const host = sourceHost();
    const result = family === "v1" ? v1(host.resolver) : v2(host.resolver);
    const otherHost = sourceHost();
    otherHost.state.policy = "different fixed root B";
    const copied = capturePcbLibrarySourceSelection(otherHost.resolver, selected());
    const mutations: ((binding: any) => void)[] = [
      binding => { delete binding.sourceSelection; },
      binding => { binding.sourceSelection.records.pop(); },
      binding => { binding.sourceSelection.records.push({ ...binding.sourceSelection.records[0], libraryId: "Other:Unused" }); },
      binding => { binding.sourceSelection = structuredClone(copied); },
      binding => { binding.sourceSelection.records[0].sourceIdentity.digest = "f".repeat(64); },
      binding => { binding.sourceSelection.records[0].inspectionIdentity.digest = "a".repeat(64); },
      binding => { binding.sourceSelection.records.reverse(); },
      binding => { binding.sourceSelection.records.push(structuredClone(binding.sourceSelection.records[0])); },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(result.bundle);
      mutate(changed.libraryBinding);
      rehash(changed);
      expect(() => assertPcbLibrarySourcesCurrent(changed.libraryBinding, host.resolver)).toThrow();
      if (family === "v1") expect(() => parsePcbDesignCompilationBundle(changed, result.deps)).toThrow();
      else expect(() => parsePcbPlaneCompilationBundle(changed, result.deps)).toThrow();
    }
  });

  it("revalidates inspection identity and host policy even when raw bytes stay equal", () => {
    const host = sourceHost();
    const binding = v1(host.resolver).bundle.libraryBinding;
    host.state.inspection = "different parsed geometry";
    expect(() => assertPcbLibrarySourcesCurrent(binding, host.resolver)).toThrow();
    host.state.inspection = "native geometry A";
    host.state.policy = "different host policy";
    expect(() => assertPcbLibrarySourcesCurrent(binding, host.resolver)).toThrow();
  });

  it("rejects untrusted shape, accessor capability/output, invalid identity family, and selection overflow", () => {
    const host = sourceHost();
    const selection = capturePcbLibrarySourceSelection(host.resolver, selected())!;
    let getterCalls = 0;
    const accessor = { ...genericDividerLibraryResolver, get captureSourceSelection(): never { getterCalls++; throw new Error("must not run"); } };
    expect(() => capturePcbLibrarySourceSelection(accessor, selected())).toThrow(/data method/u);
    expect(getterCalls).toBe(0);
    const invalid = structuredClone(selection);
    Object.defineProperty(invalid.records[0]!, "sourceIdentity", { enumerable: true, get() { getterCalls++; return selection.records[0]!.sourceIdentity; } });
    expect(() => parsePcbLibrarySourceSelection(invalid, selected())).toThrow();
    expect(getterCalls).toBe(0);
    const wrongFamily = structuredClone(selection) as any;
    wrongFamily.records[0].inspectionIdentity.schemaVersion = "evleda.kicad-stock-symbol-inspection.v1";
    expect(() => parsePcbLibrarySourceSelection(rehash(wrongFamily), selected())).toThrow();
    expect(() => parsePcbLibrarySourceSelection({ ...selection, path: "C:/private/library" }, selected())).toThrow();
    expect(() => parsePcbLibrarySourceSelection(selection, { symbolIds: Array.from({ length: 65 }, (_, index) => `Device:R${index}`), footprintIds: [] })).toThrow();
    const malformed: PcbReadOnlyLibraryResolver = { ...genericDividerLibraryResolver, captureSourceSelection: () => undefined as never };
    expect(compilePcbDesignIntentDraft(genericDividerDraft(), dependencies(malformed)).disposition).toBe("needs_clarification");
    expect(compilePcbPlaneDesignIntentDraft(planeDividerDraft(), dependencies(malformed)).disposition).toBe("needs_clarification");
    expect(selection.schemaVersion).toBe(PCB_LIBRARY_SOURCE_SELECTION_SCHEMA_VERSION);
  });
});
