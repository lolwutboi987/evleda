import { appendFileSync, cpSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { KiCadApprovedPackageResolver, parseKiCadApprovedPackageProfile } from "../../src/harness/kicad-approved-package.js";
import { createKiCad10StockLibraryResolver } from "../../src/harness/kicad-library-resolver.js";
import { compilePcbDesignIntentDraft, type PcbReadOnlyLibraryResolver } from "../../src/harness/pcb-design-compiler.js";
import { createPcbDesignCompilationBundle, createPcbDesignCompilationBundleRef, parsePcbDesignCompilationBundle, serializePcbDesignCompilationBundle } from "../../src/harness/pcb-design-compilation-bundle.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle, createPcbPlaneCompilationBundleRef, parsePcbPlaneCompilationBundle, serializePcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { createGenericFreshProjectBinding, createPlaneFreshProjectBinding } from "../../src/harness/fresh-project.js";
import { assertPcbLibrarySourcesCurrent, parsePcbLibrarySourceSelection, isPcbLibraryRecordAuthorized } from "../../src/harness/pcb-library-source-binding.js";
import { loadDeepRuleCatalog, PACKAGED_DEEP_RULE_RESOURCE_IDENTITY } from "../../src/harness/deep-rule-catalog.js";
import { PCB_DESIGN_INTENT_TOOL_NAME, interpretAndCompilePcbDesignIntent } from "../../src/harness/pcb-design-interpreter.js";
import { FRESH_DESIGN_CLEARANCE_EVIDENCE_SCHEMA_VERSION, evaluateFreshDesignAcceptance } from "../../src/harness/fresh-design-acceptance.js";
import { parseFreshPcbSource } from "../../src/harness/fresh-kicad-parser.js";
import { buildFreshSchematicSourceTerminalGroups } from "../../src/harness/fresh-schematic-source-adapter.js";
import { bindKicadPhysicalFootprintLibraries } from "../../src/integrations/kicad-native-pad-observation.js";
import { prepareKicadToolboxFreshProject, resumeKicadToolboxFreshProject } from "../../src/mcp/toolbox-fresh-preparation.js";
import type { KicadCliAdapter, KicadExecutableIdentity } from "../../src/integrations/kicad-cli.js";
import { loadKicadToolboxFreshProfile } from "../../src/mcp/toolbox-fresh-profile.js";
import { genericDividerDraft } from "../helpers/generic-divider-bundle.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";

const owned: string[] = [];
afterEach(() => { for (const root of owned.splice(0)) {
  if (!path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)) throw new Error("Unsafe test cleanup");
  rmSync(root, { recursive: true, force: true });
} });
const namespace = "EvlEDA_TestPackage", customSymbol = `${namespace}:R`, customFootprint = `${namespace}:R_2`;
const catalog = loadDeepRuleCatalog();
const symbol = (name: string, count = 2, reference = "R") => `(symbol "${name}"
  (property "Reference" "${reference}" (at 0 0 0)) (property "Value" "${name}" (at 0 0 0))
  (symbol "${name}_0_1" (rectangle (start -1 -1) (end 1 1) (stroke (width 0.254) (type default)) (fill (type background))))
  (symbol "${name}_1_1" ${Array.from({ length: count }, (_, index) => `(pin passive line (at ${index * 2.54} 0 0) (length 2.54)
    (name "Terminal ${index + 1}" (effects (font (size 1.27 1.27)))) (number "${index + 1}" (effects (font (size 1.27 1.27)))))`).join(" ")}))`;
const symbolFile = (name: string, count = 2, reference = "R") => `(kicad_symbol_lib (version 20231120) (generator "evleda-test") ${symbol(name, count, reference)})\n`;
const footprintFile = (name: string, count = 2) => `(footprint "${name}" (version 20240108) (generator "evleda-test") (layer "F.Cu")
  (fp_rect (start -2 -2) (end 4 2) (stroke (width 0.05) (type solid)) (fill none) (layer "F.CrtYd"))
  (fp_rect (start -1 -1) (end 3 1) (stroke (width 0.1) (type solid)) (fill none) (layer "F.Fab"))
  ${Array.from({ length: count }, (_, index) => `(pad "${index + 1}" smd rect (at ${index * 2} 0) (size 1 1) (layers "F.Cu" "F.Mask" "F.Paste"))`).join(" ")}
  (pad "" smd rect (at 1 0) (size 0.3 0.3) (layers "F.Paste"))
  (pad "" np_thru_hole circle (at 1 2) (size 0.5 0.5) (drill 0.5) (layers "*.Cu" "*.Mask")))\n`;
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "evleda-approved-package-")); owned.push(root);
  const stockRoot = path.join(root, "stock"), packageRoot = path.join(root, "package");
  const put = (base: string, relativePath: string, source: string) => {
    const target = path.join(base, relativePath); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, source, "utf8");
    return { relativePath, identity: contentIdentity(source) };
  };
  put(stockRoot, "symbols/Device.kicad_sym", symbolFile("R"));
  put(stockRoot, "symbols/Connector_Generic.kicad_sym", symbolFile("Conn_01x03", 3, "J"));
  put(stockRoot, "footprints/Resistor_SMD.pretty/R_0603_1608Metric.kicad_mod", footprintFile("R_0603_1608Metric"));
  put(stockRoot, "footprints/Connector_PinHeader_2.54mm.pretty/PinHeader_1x03_P2.54mm_Vertical.kicad_mod", footprintFile("PinHeader_1x03_P2.54mm_Vertical", 3));
  const customSymbolPin = put(packageRoot, `symbols/${namespace}.kicad_sym`, symbolFile("R"));
  const customFootprintPin = put(packageRoot, `footprints/${namespace}.pretty/R_2.kicad_mod`, footprintFile("R_2"));
  const provenance = put(packageRoot, "provenance/vendor.md", "Synthetic test provenance; no manufacturer verification claim.\n");
  const notice = put(packageRoot, "NOTICE.md", "Synthetic fixture only.\n");
  const manifest = { schemaVersion: "evleda.kicad-approved-package.v1", namespace,
    symbols: [{ libraryId: customSymbol, source: customSymbolPin, provenanceIds: ["vendor"] }],
    footprints: [{ libraryId: customFootprint, source: customFootprintPin, provenanceIds: ["vendor"] }],
    provenance: [{ ...provenance, id: "vendor", url: "https://example.invalid/vendor" }], notice };
  const profile = { root: packageRoot, manifest: put(packageRoot, "manifest.json", JSON.stringify(manifest)) };
  const stockPolicy = { symbolRoot: path.join(stockRoot, "symbols"), footprintRoot: path.join(stockRoot, "footprints"),
    stockSymbolNicknames: ["Connector_Generic", "Device"], stockFootprintNicknames: ["Connector_PinHeader_2.54mm", "Resistor_SMD"],
    exactSymbolIds: ["Connector_Generic:Conn_01x03", "Device:R"],
    exactFootprintIds: ["Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical", "Resistor_SMD:R_0603_1608Metric"] };
  const create = () => new KiCadApprovedPackageResolver(profile, createKiCad10StockLibraryResolver(stockPolicy), stockPolicy);
  const repin = () => { profile.manifest = put(packageRoot, "manifest.json", JSON.stringify(manifest)); };
  return { root, packageRoot, put, profile, manifest, stockPolicy, create, repin };
}
function mixedDraft(plane = false) {
  const draft = plane ? planeDividerDraft() : genericDividerDraft();
  const component = draft.components.find(entry => entry.reference === "R1")!;
  component.symbolLibId = customSymbol; component.footprintLibId = customFootprint;
  return draft;
}
const selected = { symbolIds: [customSymbol], footprintIds: [customFootprint] };
const dependencies = (libraryResolver: PcbReadOnlyLibraryResolver) => ({ libraryResolver, deepRuleCatalog: catalog });
function ready(resolver: PcbReadOnlyLibraryResolver) {
  const deps = dependencies(resolver), compilation = compilePcbDesignIntentDraft(mixedDraft(), deps);
  expect(compilation.disposition, JSON.stringify(compilation.issues)).toBe("ready");
  return { deps, compilation, bundle: createPcbDesignCompilationBundle({ originalPrompt: "Mixed source fixture", compilation }, deps) };
}

describe("one host-approved local library package", () => {
  it.each(["exact", "catalog"])("loads the optional package through the pinned %s toolbox profile and protects its root", async mode => {
    const f = fixture();
    const { exactSymbolIds, exactFootprintIds, ...roots } = f.stockPolicy;
    const libraries = mode === "exact" ? { ...f.stockPolicy, kicadMajorVersion: 10, approvedPackage: f.profile }
      : { ...roots, kicadMajorVersion: 10, mode: "stock_catalog", schemaVersion: "evleda.kicad-stock-catalog-policy.v1", approvedPackage: f.profile };
    const bytes = JSON.stringify({ libraries, deepRules: { resourceRoot: path.resolve("resources/deep-pcb-rule-corpus/v1"),
      resourceIdentity: PACKAGED_DEEP_RULE_RESOURCE_IDENTITY, catalogIdentity: canonicalIdentity(catalog, "evleda.deep-rule-catalog.v1"),
      selection: { maxRules: 24, maxPromptBytes: 8192, maxPromptTokens: 8192, featureCoveragePolicy: "require-all" } } });
    const file = path.join(f.root, "toolbox-profile.json"); writeFileSync(file, bytes);
    const loaded = await loadKicadToolboxFreshProfile({ path: file, contentIdentity: contentIdentity(bytes) });
    expect(loaded.protectedRoots).toContain(f.packageRoot);
    expect(loaded.libraryEnvironment).toEqual({ KICAD10_SYMBOL_DIR: roots.symbolRoot, KICAD10_FOOTPRINT_DIR: roots.footprintRoot });
    expect(loaded.dependencies.libraryResolver.resolveSymbol(customSymbol)?.source).toBe("project-custom");
    expect(loaded.searchLibrary === undefined).toBe(mode === "exact");
  });

  it("preserves exact custom source identity, full geometry, physical pad inventory and distinct inspection families", () => {
    const resolver = fixture().create();
    expect(resolver.resolveSymbol(customSymbol)?.source).toBe("project-custom");
    expect(resolver.inspectSymbol(customSymbol)?.schemaVersion).toBe("evleda.kicad-approved-symbol-inspection.v1");
    expect(resolver.inspectFootprint(customFootprint)?.schemaVersion).toBe("evleda.kicad-approved-footprint-inspection.v1");
    expect(resolver.inspectSymbolTerminalGeometry(customSymbol)?.representations.flatMap(entry => entry.pins)).toHaveLength(2);
    expect(resolver.inspectFootprint(customFootprint)?.physicalPads.map(entry => entry.padType).sort()).toEqual(["np_thru_hole", "smd", "smd", "smd"]);
    const capture = resolver.captureSourceSelection(selected);
    expect(parsePcbLibrarySourceSelection(capture, selected)).toEqual(capture);
    expect(capture.records.every(entry => entry.approvedPackage !== undefined)).toBe(true);
    expect(resolver.resolveSymbol(`${namespace}:Undeclared`)).toBeNull();
    expect(resolver.resolveSymbol(`${namespace.toLowerCase()}:R`)).toBeNull();
    expect(resolver.resolveFootprint(`${namespace}:../escape`)).toBeNull();
  });

  it("reconstructs mixed V1 bundles and exact host-bound local project table URIs", () => {
    const f = fixture(), resolver = f.create(), { deps, bundle } = ready(resolver);
    expect(parsePcbDesignCompilationBundle(serializePcbDesignCompilationBundle(bundle), deps)).toEqual(bundle);
    expect(bundle.libraryBinding.symbols.map(entry => entry.source)).toEqual(["kicad-stock", "project-custom", "kicad-stock"]);
    const tables = createGenericFreshProjectBinding(bundle, createPcbDesignCompilationBundleRef(bundle));
    expect(tables.symbolTable).toContain(path.join(f.packageRoot, `symbols/${namespace}.kicad_sym`).replaceAll("\\", "/"));
    expect(tables.footprintTable).toContain(path.join(f.packageRoot, `footprints/${namespace}.pretty`).replaceAll("\\", "/"));
    expect(tables.symbolTable).toContain('${KICAD10_SYMBOL_DIR}/Device.kicad_sym');
    expect(tables.binding.symbolLibraryTableIdentity).toEqual(contentIdentity(tables.symbolTable));
    expect(() => assertPcbLibrarySourcesCurrent(bundle.libraryBinding, resolver)).not.toThrow();
  });

  it("reconstructs mixed V2 plane bundles without minting a V1 source authority", () => {
    const resolver = fixture().create(), deps = dependencies(resolver);
    const compilation = compilePcbPlaneDesignIntentDraft(mixedDraft(true), deps);
    expect(compilation.disposition, JSON.stringify(compilation.issues)).toBe("ready");
    if (compilation.disposition !== "ready") throw new Error("Expected ready plane fixture");
    const bundle = createPcbPlaneCompilationBundle({ originalPrompt: "Mixed plane fixture", compilation }, deps);
    expect(parsePcbPlaneCompilationBundle(serializePcbPlaneCompilationBundle(bundle), deps)).toEqual(bundle);
    const tables = createPlaneFreshProjectBinding(bundle, createPcbPlaneCompilationBundleRef(bundle));
    expect(tables.symbolTable).toContain(`/${namespace}.kicad_sym`);
  });

  it("passes the interpreter's strict schema and independent reconstruction with source pins", async () => {
    const resolver = fixture().create();
    const result = await interpretAndCompilePcbDesignIntent({ prompt: "Mixed source fixture" }, {
      provider: { provider: "fixture", turn: async () => ({ message: { role: "assistant", content: "Fixture" },
        toolCalls: [{ id: "fixture-intent", name: PCB_DESIGN_INTENT_TOOL_NAME, arguments: mixedDraft() }], stopReason: "tool_calls" }) },
      compilerOptions: dependencies(resolver),
    });
    expect(result.disposition).toBe("ready");
    expect(result.libraryBinding?.sourceSelection?.records.some(entry => entry.approvedPackage !== undefined)).toBe(true);
  });

  it("acceptance independently authenticates mixed library rows without claiming native validation", () => {
    const resolver = fixture().create(), { bundle } = ready(resolver);
    const pcbSource = "(kicad_pcb (version 20250316) (generator fixture) (layers (0 \"F.Cu\" signal) (31 \"B.Cu\" signal)))";
    const artifacts = { contract: bundle.contract, libraryResolver: resolver, libraryBinding: bundle.libraryBinding,
      deepRuleCatalog: catalog, deepRuleBinding: bundle.deepRuleBinding, acceptancePlan: bundle.acceptancePlan };
    const evidence = { schematicSource: "(kicad_sch)", netlistSource: "(export)", pcbSource,
      clearance: { origin: "host" as const, schemaVersion: FRESH_DESIGN_CLEARANCE_EVIDENCE_SCHEMA_VERSION,
        source: "kicad-effective-netclass-rules" as const, pcbSha256: contentIdentity(pcbSource).digest,
        rulesSourceSha256: "a".repeat(64), netClasses: [] },
      erc: { origin: "host" as const, result: "{}" }, drc: { origin: "host" as const, result: "{}" }, visualInspection: { origin: "host" as const, result: "{}" } };
    const result = evaluateFreshDesignAcceptance(evidence, artifacts);
    expect(result.requirements.find(entry => entry.id === "contract:integrity")?.status).toBe("pass");
    expect(result.requirements.find(entry => entry.id === "library:R1:symbol")?.status).toBe("pass");
    expect(result.passed).toBe(false); // No schematic/native/DRC qualification is supplied by this fixture.
  });

  it("binds custom physical footprints with every paste/NPTH member and rejects a removed feature", () => {
    const f = fixture(), resolver = f.create();
    const footprint = readFileSync(path.join(f.packageRoot, f.manifest.footprints[0]!.source.relativePath), "utf8")
      .replace('(footprint "R_2"', `(footprint "${customFootprint}" (at 0 0) (property "Reference" "R1") (property "Value" "10k")`);
    const pcbSource = `(kicad_pcb (version 20250316) (generator fixture) (layers (0 "F.Cu" signal) (31 "B.Cu" signal)) ${footprint})`;
    const expected = { pcbPath: path.join(f.root, "board.kicad_pcb"), pcbSource, requestedPrimitiveIds: [], enabledCopperLayers: ["F.Cu", "B.Cu"],
      scopeIdentity: canonicalIdentity({ fixture: true }, "evleda.fixture.v1"), physicalFootprintResolver: resolver,
      physicalFootprints: [{ reference: "R1", libraryId: customFootprint, sourceIdentity: resolver.inspectFootprint(customFootprint)!.sourceIdentity }] };
    const board = parseFreshPcbSource(pcbSource);
    expect(bindKicadPhysicalFootprintLibraries(board, expected)[0]).toMatchObject({ physicalPadCount: 4, logicalTerminalCount: 2 });
    const removed = pcbSource.replace('(pad "" smd rect (at 1 0) (size 0.3 0.3) (layers "F.Paste"))', "");
    expect(() => bindKicadPhysicalFootprintLibraries(parseFreshPcbSource(removed), expected)).toThrow(/inventory\/geometry/);
  });

  it("requires exact embedded package electrical pin types, shapes and body graphics", () => {
    const resolver = fixture().create(), { bundle } = ready(resolver);
    const definition = (id: string) => {
      const name = id.split(":")[1]!;
      return symbol(name, name === "Conn_01x03" ? 3 : 2, name === "Conn_01x03" ? "J" : "R").replace(`(symbol "${name}"`, `(symbol "${id}"`);
    };
    const embedded = definition(customSymbol);
    const source = `(kicad_sch (version 20250114) (lib_symbols ${[...new Set(bundle.contract.components.map(component => component.symbolLibId))].map(definition).join(" ")})
      ${bundle.contract.components.map((component, index) => `(symbol (lib_id "${component.symbolLibId}") (at ${20 + index * 20} 20 0) (unit 1)
        (property "Reference" "${component.reference}") (property "Value" "${component.value}"))`).join(" ")})`;
    const livePins = bundle.contract.components.flatMap((component, index) => component.pins.map((pin, pinIndex) => ({
      reference: component.reference, pin: pin.pin, at: { xMm: 20 + index * 20 + pinIndex * 2.54, yMm: 20 }, angleDeg: 0 as const })));
    const input = { schematicSource: source, expectedSourceIdentity: contentIdentity(source), contract: bundle.contract, libraryResolver: resolver, livePins };
    expect(buildFreshSchematicSourceTerminalGroups(input).result.status).toBe("complete");
    for (const mutation of [embedded.replace("pin passive line", "pin input line"), embedded.replace("pin passive line", "pin passive clock"), embedded.replace("(end 1 1)", "(end 1.5 1)")]) {
      const changed = source.replace(embedded, mutation);
      expect(() => buildFreshSchematicSourceTerminalGroups({ ...input, schematicSource: changed, expectedSourceIdentity: contentIdentity(changed) })).toThrow(/embedded pins differ|embedded graphics differ/);
    }
  });

  it("prepares and resumes package tables, then rejects source drift before allocating a native adapter", async () => {
    const f = fixture(), resolver = f.create();
    const identity: KicadExecutableIdentity = { kind: "kicad-cli", path: path.join(f.root, "fixture-kicad.exe"), version: "10.0.3",
      commit: "146a4f2a7585c65bc580427a19b6fe2ec4a3f622", sha256: "a".repeat(64), sizeBytes: 100, capabilityHelpSha256: "b".repeat(64), confirmedCapabilities: ["pcb drc"] };
    const createKicadCliAdapter = vi.fn<typeof KicadCliAdapter.create>().mockResolvedValue({ identity } as KicadCliAdapter);
    const args = { draft: mixedDraft(), originalPrompt: "Prepare mixed package fixture", outputDir: path.join(f.root, "output"), name: "mixed",
      dependencies: dependencies(resolver), createKicadCliAdapter,
      expectedKicadCli: { path: identity.path, contentIdentity: { algorithm: "sha256" as const, digest: identity.sha256, size: identity.sizeBytes },
        operationalVersion: identity.version, operationalCommit: identity.commit, peFileVersion: "10.0.3", peProductVersion: "10.0.3",
        identity: canonicalIdentity({ fixture: true }, "evleda.flux-kicad-cli-binding.v1") } };
    const result = await prepareKicadToolboxFreshProject(args);
    expect(result.status).toBe("prepared");
    if (result.status !== "prepared") throw new Error("Expected prepared fixture");
    const resumed = await resumeKicadToolboxFreshProject(args);
    expect(resumed.bundle.identity).toEqual(result.preparation.bundle.identity);
    const before = readFileSync(resumed.project.pcbPath); createKicadCliAdapter.mockClear();
    appendFileSync(path.join(f.packageRoot, f.manifest.symbols[0]!.source.relativePath), " ");
    await expect(resumeKicadToolboxFreshProject(args)).rejects.toThrow();
    expect(createKicadCliAdapter).not.toHaveBeenCalled(); expect(readFileSync(resumed.project.pcbPath)).toEqual(before);
  });

  it.each(["symbol", "footprint", "manifest", "notice", "provenance"])("rejects %s byte drift before resolution, reconstruction or resume source guards", kind => {
    const f = fixture(), resolver = f.create(), { bundle, deps } = ready(resolver);
    const file = kind === "symbol" ? f.manifest.symbols[0]!.source.relativePath : kind === "footprint" ? f.manifest.footprints[0]!.source.relativePath
      : kind === "manifest" ? "manifest.json" : kind === "notice" ? "NOTICE.md" : f.manifest.provenance[0]!.relativePath;
    appendFileSync(path.join(f.packageRoot, file), " ");
    expect(() => assertPcbLibrarySourcesCurrent(bundle.libraryBinding, resolver)).toThrow();
    expect(() => parsePcbDesignCompilationBundle(bundle, deps)).toThrow();
    expect(compilePcbDesignIntentDraft(mixedDraft(), deps).disposition).not.toBe("ready");
  });

  it.each(["source-kind-only", "copied-selection", "relabel-stock"])("rejects unregistered resolver authority: %s", mode => {
    const resolver = fixture().create();
    const fake: PcbReadOnlyLibraryResolver = {
      resolveSymbol: id => { const record = resolver.resolveSymbol(id); return record && mode === "relabel-stock" ? { ...record, source: "kicad-stock" } : record; },
      resolveFootprint: id => { const record = resolver.resolveFootprint(id); return record && mode === "relabel-stock" ? { ...record, source: "kicad-stock" } : record; },
      ...(mode === "source-kind-only" ? {} : { captureSourceSelection: resolver.captureSourceSelection.bind(resolver) }),
    };
    expect(compilePcbDesignIntentDraft(mixedDraft(), dependencies(fake)).disposition).not.toBe("ready");
    const { bundle } = ready(resolver);
    expect(() => assertPcbLibrarySourcesCurrent(bundle.libraryBinding, fake)).toThrow();
  });

  it("preserves legacy host-owned stock resolver behavior when the package capability is omitted", () => {
    const resolver = fixture().create();
    const legacy: PcbReadOnlyLibraryResolver = {
      resolveSymbol(id) { const record = resolver.resolveSymbol(id); return record === null ? null : { ...record, source: "kicad-stock" }; },
      resolveFootprint(id) { const record = resolver.resolveFootprint(id); return record === null ? null : { ...record, source: "kicad-stock" }; },
    };
    const compilation = compilePcbDesignIntentDraft(mixedDraft(), dependencies(legacy));
    expect(compilation.disposition).toBe("ready");
    expect(compilation.libraryBinding).not.toHaveProperty("sourceSelection");
    // Legacy host-owned stock projections already grant authority. This does not grant custom-package authority.
    expect(compilation.libraryBinding!.symbols.every(record => record.source === "kicad-stock")).toBe(true);
  });

  it("rejects rehashed package policy/manifest/table substitutions and source relabelling", () => {
    const resolver = fixture().create(), { bundle, deps } = ready(resolver);
    for (const key of ["tableUri", "policyIdentity", "manifestIdentity", "source"] as const) {
      const value: any = structuredClone(bundle);
      const metadata = value.libraryBinding.sourceSelection.records.find((entry: any) => entry.approvedPackage).approvedPackage;
      if (key === "source") value.libraryBinding.symbols.find((entry: any) => entry.source === "project-custom").source = "kicad-stock";
      else if (key === "tableUri") metadata.tableUri = metadata.tableUri.replace("/package/", "/different-package/");
      else metadata[key].digest = "a".repeat(64);
      const rehash = (node: any) => { if (node && typeof node === "object") { for (const [name, child] of Object.entries(node)) if (name !== "identity") rehash(child);
        if (node.identity?.canonicalizationVersion) { const { identity, ...payload } = node; node.identity = canonicalIdentity(payload, identity.schemaVersion); } } };
      rehash(value);
      expect(() => parsePcbDesignCompilationBundle(value, deps)).toThrow();
    }
  });

  it("authenticates the complete package source pin even with the genuine host resolver", () => {
    const resolver = fixture().create(), capture = resolver.captureSourceSelection(selected), symbol = resolver.resolveSymbol(customSymbol)!;
    expect(isPcbLibraryRecordAuthorized(resolver, "symbol", symbol, capture)).toBe(true);
    for (const field of ["sourceIdentity", "inspectionIdentity", "policyIdentity", "manifestIdentity", "tableUri"] as const) {
      const forged: any = structuredClone(capture), record = forged.records.find((entry: any) => entry.kind === "symbol");
      if (field === "sourceIdentity" || field === "inspectionIdentity") record[field].digest = "0".repeat(64);
      else if (field === "tableUri") record.approvedPackage.tableUri += ".unapproved";
      else record.approvedPackage[field].digest = "0".repeat(64);
      expect(isPcbLibraryRecordAuthorized(resolver, "symbol", symbol, forged)).toBe(false);
    }
  });

  it("rejects namespace collisions even outside the allowed stock nickname subset", () => {
    const f = fixture(); writeFileSync(path.join(f.stockPolicy.symbolRoot, `${namespace}.kicad_sym`), symbolFile("R"));
    expect(() => f.create()).toThrow(/collides/);
  });

  it("rejects an installed namespace appearing after construction before native stock-first lookup", () => {
    const f = fixture(), resolver = f.create();
    writeFileSync(path.join(f.stockPolicy.symbolRoot, `${namespace}.kicad_sym`), symbolFile("R"));
    expect(() => resolver.captureSourceSelection(selected)).toThrow(/collides/);
  });

  it("rejects replacement of the bound root even when every pinned byte remains identical", () => {
    const f = fixture(), resolver = f.create(), renamed = path.join(f.root, "old-package");
    renameSync(f.packageRoot, renamed); cpSync(renamed, f.packageRoot, { recursive: true });
    expect(() => resolver.captureSourceSelection(selected)).toThrow(/root changed/);
  });

  it.each(["../outside.kicad_sym", "symbols/../outside.kicad_sym", "symbols/x:stream", "symbols/CON.kicad_sym"])("rejects unsafe source path %s", relativePath => {
    const f = fixture(); f.manifest.symbols[0]!.source.relativePath = relativePath; f.repin(); expect(() => f.create()).toThrow();
  });

  it("rejects hardlinked files and junctions without reading outside the package", () => {
    const f = fixture(), source = path.join(f.packageRoot, f.manifest.symbols[0]!.source.relativePath), outside = path.join(f.root, "outside.kicad_sym");
    renameSync(source, outside); linkSync(outside, source); expect(() => f.create()).toThrow(/non-link/); unlinkSync(source);
    const sourceDirectory = path.join(f.packageRoot, "symbols"), outsideDirectory = path.join(f.root, "outside-symbols");
    renameSync(sourceDirectory, outsideDirectory); renameSync(outside, path.join(outsideDirectory, `${namespace}.kicad_sym`));
    symlinkSync(outsideDirectory, sourceDirectory, "junction"); expect(() => f.create()).toThrow(/non-link/);
  });

  it("rejects hidden symbol definitions, multi-unit symbols, external models and malformed manifest pins", () => {
    for (const kind of ["definition", "unit", "model", "manifest"] as const) {
      const f = fixture();
      if (kind === "manifest") { f.profile.manifest.identity = { ...f.profile.manifest.identity, digest: "0".repeat(64) }; expect(() => f.create()).toThrow(); continue; }
      const entry = kind === "model" ? f.manifest.footprints[0]! : f.manifest.symbols[0]!;
      const previous = readFileSync(path.join(f.packageRoot, entry.source.relativePath), "utf8");
      const next = kind === "definition" ? previous.replace(/\)\n$/u, `${symbol("Hidden")})\n`)
        : kind === "unit" ? previous.replace('"R_1_1"', '"R_2_1"') : previous.replace(/\)\n$/u, '(model "outside.step"))\n');
      entry.source = f.put(f.packageRoot, entry.source.relativePath, next); f.repin(); expect(() => f.create()).toThrow();
    }
  });

  it("rejects accessor/proxy profiles without invoking caller-controlled getters", () => {
    const f = fixture(); let calls = 0;
    const accessor = { ...f.profile }; Object.defineProperty(accessor, "root", { get() { calls++; return f.packageRoot; }, enumerable: true });
    expect(() => parseKiCadApprovedPackageProfile(accessor)).toThrow(); expect(calls).toBe(0);
    expect(() => parseKiCadApprovedPackageProfile(new Proxy(f.profile, {}))).toThrow();
  });

  it("cannot mint package authority through overridden subclass or instance methods", () => {
    const f = fixture(); class Forged extends KiCadApprovedPackageResolver {}
    expect(() => new Forged(f.profile, createKiCad10StockLibraryResolver(f.stockPolicy), f.stockPolicy)).toThrow(/subclassed/);
    const resolver = f.create();
    expect(() => Object.defineProperty(resolver, "captureSourceSelection", { value: () => ({ forged: true }) })).toThrow();
    expect(() => Object.defineProperty(KiCadApprovedPackageResolver.prototype, "inspectSymbol", { value: () => ({ forged: true }) })).toThrow();
  });
});
