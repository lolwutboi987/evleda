import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import { KiCadApprovedPackageResolver } from "../../src/harness/kicad-approved-package.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { createKiCad10StockCatalog } from "../../src/harness/kicad-stock-catalog.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { closePcbPlaneDesignIntentDraft, normalizePcbPlaneUnresolvedPath, parsePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-contract.js";
import { createPcbPlaneCompilationBundle, parsePcbPlaneCompilationBundle, serializePcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { assertPcbDerivedPowerBindingCurrent, parsePcbDerivedPowerBinding, powerAnnotationBindingOf } from "../../src/harness/pcb-derived-power.js";
import { derivedPowerDraft, derivedPowerFixture, derivedPowerStock, cleanupDerivedPowerFixtures } from "../helpers/derived-power-bundle.js";
import { genericDividerLibraryResolver } from "../helpers/generic-divider-bundle.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";

afterEach(cleanupDerivedPowerFixtures);
const catalog = loadDeepRuleCatalog();
const compile = (draft: unknown, resolver = derivedPowerStock().resolver) =>
  compilePcbPlaneDesignIntentDraft(draft, { libraryResolver: resolver, deepRuleCatalog: catalog });
const declaration = (draft: Record<string, any>, id = "REG_CORE") => draft.derivedPowerSources.find((entry: any) => entry.id === id);
const assign = (draft: Record<string, any>, reference: string, pin: string, net: string | null) => {
  const component = draft.components.find((entry: any) => entry.reference === reference);
  component.pins.find((entry: any) => entry.pin === pin).assignment = net === null ? { kind: "no_connect" } : { kind: "net", net };
  for (const candidate of draft.nets) candidate.endpoints = candidate.endpoints.filter((entry: any) => entry.reference !== reference || entry.pin !== pin);
  if (net !== null) draft.nets.find((candidate: any) => candidate.name === net).endpoints.push({ reference, pin });
  for (const route of draft.routingConstraints.nets) if (route.topology !== "plane") {
    route.topology = draft.nets.find((candidate: any) => candidate.name === route.net).endpoints.length > 2 ? "tree" : "point_to_point";
  }
};

describe("source-bound V2 derived power declarations", () => {
  it("binds a stock inductor and two-resistor filter while preserving every physical inventory", () => {
    const value = derivedPowerDraft();
    const { bundle, compilation, resolver } = derivedPowerFixture(value);
    const binding = bundle.derivedPowerBinding!;
    expect(binding).toEqual(compilation.derivedPowerBinding);
    expect(powerAnnotationBindingOf(bundle)).toEqual(binding);
    expect(bundle.contract.components).toHaveLength(5);
    expect(bundle.libraryBinding.symbols).toHaveLength(5);
    expect(bundle.libraryBinding.footprints).toHaveLength(5);
    expect(bundle.contract.nets.flatMap(net => net.endpoints)).toHaveLength(15);
    expect(bundle.contract.nets.flatMap(net => net.endpoints).some(endpoint => endpoint.reference.startsWith("#"))).toBe(false);
    expect(binding.flags.map(flag => [flag.reference, flag.net])).toEqual([
      ["#FLG001", "GND"], ["#FLG002", "VIN"], ["#FLG003", "FILTER2"], ["#FLG004", "VCORE"],
    ]);
    expect(binding.flags.filter(flag => flag.net === "GND")).toHaveLength(1);
    expect(binding.externalPowerBindingIdentity).toEqual(bundle.externalPowerBinding!.identity);
    expect(binding.flags.slice(0, 2)).toEqual(bundle.externalPowerBinding!.flags);
    expect(bundle.libraryBinding.sourceSelection).toBeDefined();
    expect(() => assertPcbDerivedPowerBindingCurrent(binding, bundle.libraryBinding, resolver)).not.toThrow();
    expect(canonicalJson(binding)).not.toContain("symbolRoot");
    expect(canonicalJson(binding)).not.toContain("footprintRoot");
    expect(bundle.acceptanceEvaluated).toBe(false);
  });

  it("accepts the regulator's post-inductor DVDD self-supply without inventing a dependency cycle", () => {
    const value = derivedPowerDraft(); delete value.externalPowerInputs;
    const { bundle } = derivedPowerFixture(value);
    expect(bundle.externalPowerBinding).toBeUndefined();
    expect(bundle.derivedPowerBinding!.externalPowerBindingIdentity).toBeUndefined();
    expect(bundle.derivedPowerBinding!.flags.map(flag => flag.net)).toEqual(["FILTER2", "GND", "VCORE"]);
    expect(bundle.contract.components.find(component => component.reference === "U1")!.pins.find(pin => pin.pin === "4")!.assignment)
      .toEqual({ kind: "net", net: "VCORE" });
  });

  it("canonicalizes declaration ordering without changing the path's directed pin order", () => {
    const value = derivedPowerDraft(), expected = closePcbPlaneDesignIntentDraft(value);
    value.derivedPowerSources.reverse();
    expect(closePcbPlaneDesignIntentDraft(value)).toEqual(expected);
    expect(expected.derivedPowerSources!.find(entry => entry.id === "FILTER_B")!.path)
      .toEqual([{ reference: "R1", entryPin: "1", exitPin: "2" }, { reference: "R2", entryPin: "1", exitPin: "2" }]);
  });

  it.each([
    ["empty declaration array", (d: any) => { d.derivedPowerSources = []; }],
    ["ninth declaration", (d: any) => { d.derivedPowerSources = Array.from({ length: 9 }, (_, i) => ({ ...d.derivedPowerSources[0], id: `REG_${i}` })); }],
    ["duplicate declaration id", (d: any) => { d.derivedPowerSources[1].id = "REG_CORE"; }],
    ["empty passive path", (d: any) => { declaration(d).path = []; }],
    ["ninth passive step", (d: any) => { declaration(d).path = Array.from({ length: 9 }, () => ({ reference: "L1", entryPin: "1", exitPin: "2" })); }],
    ["unknown annotation key", (d: any) => { declaration(d).verified = true; }],
    ["unknown passive step key", (d: any) => { declaration(d).path[0].impedance = 1; }],
    ["unqualified assertion kind", (d: any) => { declaration(d).source.kind = "verified_datasheet"; }],
    ["empty operating assumption", (d: any) => { declaration(d).operatingAssumptions = ""; }],
    ["nonexistent output pin", (d: any) => { declaration(d).drivingEndpoint.pin = "99"; }],
    ["nonexistent path component", (d: any) => { declaration(d).path[0].reference = "L9"; }],
    ["same passive entry and exit", (d: any) => { declaration(d).path[0].exitPin = "1"; }],
    ["repeated path component", (d: any) => { declaration(d, "FILTER_B").path.push({ reference: "R1", entryPin: "2", exitPin: "1" }); }],
  ])("rejects %s before producing a ready artifact", (_name, mutate) => {
    const value = derivedPowerDraft(); mutate(value);
    expect(compile(value).disposition).not.toBe("ready");
  });

  it.each([
    ["swapped passive pins", (d: any) => { declaration(d).path[0] = { reference: "L1", entryPin: "2", exitPin: "1" }; }],
    ["wrong first segment", (d: any) => { declaration(d).path[0] = { reference: "R1", entryPin: "1", exitPin: "2" }; }],
    ["discontinuous filter order", (d: any) => { declaration(d, "FILTER_B").path.reverse(); }],
    ["wrong supply net", (d: any) => { declaration(d).supplyEndpoint.pin = "4"; }],
    ["driver net reused as supply", (d: any) => { declaration(d).supplyEndpoint = { reference: "U1", pin: "3" }; }],
    ["signal supply role", (d: any) => { d.nets.find((net: any) => net.name === "VCORE").role = "analog"; }],
    ["connector return instead of source ground", (d: any) => { declaration(d).returnEndpoint = { reference: "J1", pin: "3" }; }],
    ["source input instead of ground return", (d: any) => { declaration(d).returnEndpoint.pin = "1"; }],
    ["input pin asserted as driver", (d: any) => { declaration(d).drivingEndpoint.pin = "1"; }],
    ["capacitor in DC path", (d: any) => { d.components.find((component: any) => component.reference === "L1").symbolLibId = "Device:C"; }],
    ["no-connect path entry", (d: any) => { assign(d, "L1", "1", null); }],
    ["no-connect supply endpoint", (d: any) => { assign(d, "J1", "2", null); }],
  ])("rejects %s", (_name, mutate) => {
    const value = derivedPowerDraft(); mutate(value);
    expect(compile(value).disposition).not.toBe("ready");
  });

  it("rejects a disconnected upstream power input even when all annotated endpoints still connect", () => {
    const value = derivedPowerDraft();
    // Keep VIN and VCORE valid two-terminal nets so only the driver's upstream supply is NC.
    assign(value, "J1", "2", "VIN"); assign(value, "U1", "1", null);
    declaration(value).supplyEndpoint = { reference: "U1", pin: "4" };
    expect(() => closePcbPlaneDesignIntentDraft(value)).not.toThrow();
    const result = compile(value);
    expect(result.disposition).toBe("needs_clarification");
    expect(result.issues.map(issue => issue.message).join(" ")).toMatch(/power|supply|upstream/iu);
  });

  it("rejects a path that returns to an earlier net through two distinct passive components", () => {
    const value = derivedPowerDraft();
    assign(value, "R2", "2", "VREG"); assign(value, "J1", "4", "VREG");
    value.nets = value.nets.filter((net: any) => net.name !== "FILTER2");
    value.routingConstraints.nets = value.routingConstraints.nets.filter((route: any) => route.net !== "FILTER2");
    const result = compile(value);
    expect(result.disposition).toBe("needs_clarification");
    expect(result.issues.map(issue => issue.message).join(" ")).toMatch(/repeat nets|cycle/iu);
  });

  it.each(["drivingEndpoint", "path", "supplyEndpoint", "returnEndpoint", "source", "operatingAssumptions"])("keeps nullable %s unresolved with stable declaration paths", field => {
    const value = derivedPowerDraft(); declaration(value)[field] = null;
    value.unresolved = [{ path: `/derivedPowerSources/0/${field}`, question: `Resolve ${field} for the caller assertion.` }];
    const parsed = parsePcbPlaneDesignIntentDraft(value);
    expect(parsed.unresolved[0]!.path).toBe(`/derivedPowerSources/REG_CORE/${field}`);
    expect(normalizePcbPlaneUnresolvedPath(value, `/derivedPowerSources/REG_CORE/${field}`)).toBe(`/derivedPowerSources/REG_CORE/${field}`);
    expect(() => closePcbPlaneDesignIntentDraft(value)).toThrow();
    expect(compile(value).disposition).toBe("needs_clarification");
  });

  it("distinguishes an omitted declaration from an unresolved null collection", () => {
    const value = derivedPowerDraft(); value.derivedPowerSources = null;
    expect(parsePcbPlaneDesignIntentDraft(value).derivedPowerSources).toBeNull();
    expect(() => closePcbPlaneDesignIntentDraft(value)).toThrow();
    delete value.derivedPowerSources;
    expect(closePcbPlaneDesignIntentDraft(value)).not.toHaveProperty("derivedPowerSources");
  });
});

describe("derived power source authority and portable reconstruction", () => {
  it("accepts an IC from the host-approved pinned package and rejects an unregistered lookalike resolver", () => {
    const stock = derivedPowerStock(), value = derivedPowerDraft();
    const namespace = "EvlEDA_DerivedPowerTest", libraryId = `${namespace}:TestRegulator`;
    const packageRoot = join(stock.root, "approved-package"); mkdirSync(packageRoot);
    const put = (relativePath: string, source: string) => {
      const target = join(packageRoot, relativePath); mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, source, "utf8"); return { relativePath, identity: contentIdentity(source) };
    };
    const source = put(`symbols/${namespace}.kicad_sym`, stock.librarySources.Regulator_Switching!);
    const provenance = { ...put("provenance/source.md", "Synthetic IC source for software tests, without manufacturer or physical qualification.\n"),
      id: "fixture", url: "https://example.invalid/derived-power-fixture" };
    const notice = put("NOTICE.md", "Synthetic software fixture only.\n");
    const manifest = { schemaVersion: "evleda.kicad-approved-package.v1", namespace,
      symbols: [{ libraryId, source, provenanceIds: ["fixture"] }], footprints: [], provenance: [provenance], notice };
    const profile = { root: packageRoot, manifest: put("manifest.json", JSON.stringify(manifest)) };
    const resolver = new KiCadApprovedPackageResolver(profile, stock.resolver, stock.options);
    value.components.find((component: any) => component.reference === "U1").symbolLibId = libraryId;
    const dependencies = { libraryResolver: resolver, deepRuleCatalog: catalog };
    const compilation = compilePcbPlaneDesignIntentDraft(value, dependencies);
    expect(compilation.disposition, JSON.stringify(compilation.issues)).toBe("ready");
    if (compilation.disposition !== "ready") throw new Error("Expected source-pinned custom IC compilation");
    expect(compilation.libraryBinding.symbols.find(symbol => symbol.reference === "U1")!.source).toBe("project-custom");
    expect(() => assertPcbDerivedPowerBindingCurrent(compilation.derivedPowerBinding!, compilation.libraryBinding, resolver)).not.toThrow();
    const bundle = createPcbPlaneCompilationBundle({ originalPrompt: "Approved package IC fixture.", compilation }, dependencies);
    expect(parsePcbPlaneCompilationBundle(serializePcbPlaneCompilationBundle(bundle), dependencies)).toEqual(bundle);
    const lookalike = {
      resolveSymbol: resolver.resolveSymbol.bind(resolver), resolveFootprint: resolver.resolveFootprint.bind(resolver),
      captureSourceSelection: resolver.captureSourceSelection.bind(resolver), inspectExternalPowerFlag: resolver.inspectExternalPowerFlag.bind(resolver),
      inspectSymbol: resolver.inspectSymbol.bind(resolver), inspectSymbolTerminalGeometry: resolver.inspectSymbolTerminalGeometry.bind(resolver),
    };
    expect(compilePcbPlaneDesignIntentDraft(value, { libraryResolver: lookalike, deepRuleCatalog: catalog }).disposition).not.toBe("ready");
  });

  it("requires real full symbol inspection, terminal geometry and source-selection capabilities", () => {
    const { stockResolver, resolver } = derivedPowerStock();
    expect(compilePcbPlaneDesignIntentDraft(derivedPowerDraft(), { libraryResolver: stockResolver, deepRuleCatalog: catalog }).disposition).toBe("needs_clarification");
    const methods = {
      resolveSymbol: resolver.resolveSymbol.bind(resolver), resolveFootprint: resolver.resolveFootprint.bind(resolver),
      captureSourceSelection: resolver.captureSourceSelection.bind(resolver), inspectExternalPowerFlag: resolver.inspectExternalPowerFlag.bind(resolver),
      inspectSymbol: resolver.inspectSymbol.bind(resolver), inspectSymbolTerminalGeometry: resolver.inspectSymbolTerminalGeometry.bind(resolver),
    };
    for (const missing of ["inspectSymbol", "inspectSymbolTerminalGeometry"] as const) {
      const incomplete: Partial<typeof methods> = { ...methods }; delete incomplete[missing];
      expect(compilePcbPlaneDesignIntentDraft(derivedPowerDraft(), { libraryResolver: incomplete as typeof methods, deepRuleCatalog: catalog }).disposition).toBe("needs_clarification");
    }
  });

  it("rejects electrical-type forgery even when a normalized resolver pin has the expected name", () => {
    const { resolver } = derivedPowerStock(), value = derivedPowerDraft();
    const forged = {
      resolveSymbol: resolver.resolveSymbol.bind(resolver), resolveFootprint: resolver.resolveFootprint.bind(resolver),
      captureSourceSelection: resolver.captureSourceSelection.bind(resolver), inspectExternalPowerFlag: resolver.inspectExternalPowerFlag.bind(resolver),
      inspectSymbol: resolver.inspectSymbol.bind(resolver),
      inspectSymbolTerminalGeometry(libraryId: string) {
        const captured = resolver.inspectSymbolTerminalGeometry(libraryId);
        if (captured === null || libraryId !== "Regulator_Switching:TestRegulator") return captured;
        const altered = structuredClone(captured);
        for (const representation of altered.representations) for (const pin of representation.pins) if (pin.number === "3") {
          Object.assign(pin, { electricalType: "passive" });
        }
        return altered;
      },
    };
    expect(compilePcbPlaneDesignIntentDraft(value, { libraryResolver: forged, deepRuleCatalog: catalog }).disposition).toBe("needs_clarification");
  });

  it("rechecks both full raw driver source and host policy before bundle reconstruction", () => {
    const { bundle, resolver, options, symbolFiles, librarySources, dependencies } = derivedPowerFixture();
    const bytes = serializePcbPlaneCompilationBundle(bundle);
    const changedPolicy = createKiCad10StockCatalog({ ...options, stockSymbolNicknames: [...options.stockSymbolNicknames, "OtherApprovedNamespace"].sort() });
    expect(() => assertPcbDerivedPowerBindingCurrent(bundle.derivedPowerBinding!, bundle.libraryBinding, changedPolicy)).toThrow();
    writeFileSync(symbolFiles.Regulator_Switching!, librarySources.Regulator_Switching!.replace('"evleda-derived-power-test"', '"source changed but pins unchanged"'), "utf8");
    expect(() => assertPcbDerivedPowerBindingCurrent(bundle.derivedPowerBinding!, bundle.libraryBinding, resolver)).toThrow();
    expect(() => parsePcbPlaneCompilationBundle(bytes, dependencies)).toThrow();
  });

  it("round-trips exact bundle bytes and rejects omitted or rehashed forged child annotations", () => {
    const { bundle, dependencies } = derivedPowerFixture(), binding = bundle.derivedPowerBinding!;
    const bytes = serializePcbPlaneCompilationBundle(bundle);
    expect(parsePcbPlaneCompilationBundle(bytes, dependencies)).toEqual(bundle);
    expect(parsePcbDerivedPowerBinding(binding, bundle.contract.identity, bundle.externalPowerBinding)).toEqual(binding);
    const stripped: any = structuredClone(bundle); delete stripped.derivedPowerBinding;
    expect(() => parsePcbPlaneCompilationBundle(stripped, dependencies)).toThrow();
    const forged: any = structuredClone(binding); forged.flags.at(-1).reference = "#FLG999";
    const { identity: _identity, ...payload } = forged; forged.identity = canonicalIdentity(payload, forged.schemaVersion);
    expect(() => parsePcbDerivedPowerBinding(forged, bundle.contract.identity, bundle.externalPowerBinding)).toThrow();
    const extra: any = structuredClone(bundle); extra.derivedPowerBinding.flags.push({ ...binding.flags[0], reference: "#FLG005" });
    expect(() => parsePcbPlaneCompilationBundle(extra, dependencies)).toThrow();
    const overLimit: any = structuredClone(binding);
    overLimit.flags = Array.from({ length: 17 }, (_, index) => ({ ...binding.flags[0], reference: `#FLG${String(index + 1).padStart(3, "0")}`, net: `EXTRA_${index}` }));
    const { identity: _overLimitIdentity, ...overLimitPayload } = overLimit;
    overLimit.identity = canonicalIdentity(overLimitPayload, overLimit.schemaVersion);
    expect(() => parsePcbDerivedPowerBinding(overLimit, bundle.contract.identity, bundle.externalPowerBinding)).toThrow();
  });

  it("keeps omitted annotation bundles stable and external-only bundles on their original binding", () => {
    const dependencies = { libraryResolver: genericDividerLibraryResolver, deepRuleCatalog: catalog };
    const compilation = compilePcbPlaneDesignIntentDraft(planeDividerDraft(), dependencies);
    const first = createPcbPlaneCompilationBundle({ originalPrompt: "Compatibility: annotations omitted.", compilation }, dependencies);
    const bytes = serializePcbPlaneCompilationBundle(first);
    expect(first).not.toHaveProperty("derivedPowerBinding"); expect(first.contract).not.toHaveProperty("derivedPowerSources");
    expect(powerAnnotationBindingOf(first)).toBeUndefined();
    expect(serializePcbPlaneCompilationBundle(parsePcbPlaneCompilationBundle(bytes, dependencies))).toEqual(bytes);
    const value = derivedPowerDraft(); delete value.derivedPowerSources;
    const external = derivedPowerFixture(value);
    expect(external.bundle).not.toHaveProperty("derivedPowerBinding");
    expect(powerAnnotationBindingOf(external.bundle)).toEqual(external.bundle.externalPowerBinding);
    const externalBytes = serializePcbPlaneCompilationBundle(external.bundle);
    expect(serializePcbPlaneCompilationBundle(parsePcbPlaneCompilationBundle(externalBytes, external.dependencies))).toEqual(externalBytes);
  });
});
