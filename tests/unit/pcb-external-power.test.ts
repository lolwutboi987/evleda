import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalIdentity, canonicalJson } from "../../src/core/canonical.js";
import { createKiCad10StockLibraryResolver } from "../../src/harness/kicad-library-resolver.js";
import { createKiCad10StockCatalog } from "../../src/harness/kicad-stock-catalog.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { closePcbPlaneDesignIntentDraft, normalizePcbPlaneUnresolvedPath, parsePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-contract.js";
import { createPcbPlaneCompilationBundle, createPcbPlaneCompilationBundleRef, parsePcbPlaneCompilationBundle, serializePcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { assertPcbExternalPowerBindingCurrent, parsePcbExternalPowerBinding } from "../../src/harness/pcb-external-power.js";
import { createPlaneFreshProjectBinding } from "../../src/harness/fresh-project.js";
import { getPcbPlaneDesignIntentModelGuide, PCB_PLANE_DESIGN_INTENT_MODEL_GUIDE, PCB_PLANE_DESIGN_INTENT_EXTENDED_MODEL_GUIDE_MAX_UTF8_BYTES } from "../../src/harness/pcb-design-plane-model-guide.js";
import { genericDividerLibraryResolver } from "../helpers/generic-divider-bundle.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";

// Synthetic KiCad source only. This fixture tests guarded source semantics, not native qualification.
const source = `(kicad_symbol_lib (version 20250114) (generator "test")
  (symbol "PWR_FLAG" (power global) (in_bom yes) (on_board yes)
    (property "Reference" "#FLG" (at 0 0 0))
    (property "Value" "PWR_FLAG" (at 0 1 0))
    (property "Footprint" "" (at 0 0 0))
    (symbol "PWR_FLAG_0_1" (polyline (pts (xy 0 0) (xy 0 1) (xy 1 2) (xy -1 2) (xy 0 1)) (stroke (width 0) (type default)) (fill (type none))))
    (symbol "PWR_FLAG_1_1" (pin power_out line (at 0 0 90) (length 0)
      (name "pwr" (effects (font (size 1.27 1.27))))
      (number "1" (effects (font (size 1.27 1.27))))))))\n`;
const owned: string[] = [];
afterEach(() => { for (const root of owned.splice(0)) {
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe fixture cleanup target");
  rmSync(root, { recursive: true, force: true });
} });
function stock() {
  const root = mkdtempSync(join(tmpdir(), "evleda-external-power-")); owned.push(root);
  const symbolRoot = join(root, "symbols"), footprintRoot = join(root, "footprints");
  mkdirSync(symbolRoot); mkdirSync(footprintRoot);
  const file = join(symbolRoot, "power.kicad_sym"); writeFileSync(file, source);
  const options = { symbolRoot, footprintRoot, exactSymbolIds: ["power:PWR_FLAG"], exactFootprintIds: [], stockSymbolNicknames: ["power"], stockFootprintNicknames: ["Device"] };
  const resolver = createKiCad10StockLibraryResolver(options);
  return { root, file, options, resolver };
}
function draft(): Record<string, any> {
  const value: Record<string, any> = planeDividerDraft();
  value.nets.find((net: any) => net.name === "VIN").role = "power_input";
  value.externalPowerInputs = [{ id: "INPUT", supplyEndpoint: { reference: "J1", pin: "1" }, returnEndpoint: { reference: "J1", pin: "3" } }];
  return value;
}
const catalog = loadDeepRuleCatalog();
function fixture(value = draft()) {
  const { resolver, ...files } = stock();
  const libraryResolver = { ...genericDividerLibraryResolver, inspectExternalPowerFlag: () => resolver.inspectExternalPowerFlag() };
  const dependencies = { libraryResolver, deepRuleCatalog: catalog };
  const compilation = compilePcbPlaneDesignIntentDraft(value, dependencies);
  if (compilation.disposition !== "ready") throw new Error(JSON.stringify(compilation.issues));
  const bundle = createPcbPlaneCompilationBundle({ originalPrompt: "Explicit off-board supply fixture.", compilation }, dependencies);
  return { ...files, resolver, dependencies, compilation, bundle };
}

describe("V2 explicit external power input contract and source binding", () => {
  it("adds only separate source-bound annotations and the power symbol table namespace", () => {
    const { compilation, bundle, dependencies, resolver } = fixture();
    expect(compilation.externalPowerBinding).toEqual(bundle.externalPowerBinding);
    const binding = bundle.externalPowerBinding!;
    expect(binding.flags).toEqual([
      { reference: "#FLG001", net: "GND", anchorEndpoint: { reference: "J1", pin: "3" }, symbolLibId: "power:PWR_FLAG" },
      { reference: "#FLG002", net: "VIN", anchorEndpoint: { reference: "J1", pin: "1" }, symbolLibId: "power:PWR_FLAG" },
    ]);
    expect(bundle.contract.components).toHaveLength(3);
    expect(bundle.libraryBinding.symbols).toHaveLength(3);
    expect(bundle.libraryBinding.footprints).toHaveLength(3);
    expect(bundle.contract.nets.flatMap(net => net.endpoints)).toHaveLength(7);
    expect(bundle.contract.nets.flatMap(net => net.endpoints).some(point => point.reference.startsWith("#"))).toBe(false);
    expect(assertPcbExternalPowerBindingCurrent(binding, resolver).geometry.representations.flatMap(value => value.pins)).toHaveLength(1);
    expect(parsePcbPlaneCompilationBundle(serializePcbPlaneCompilationBundle(bundle), dependencies)).toEqual(bundle);
    const tables = createPlaneFreshProjectBinding(bundle, createPcbPlaneCompilationBundleRef(bundle));
    expect(tables.symbolTable.match(/\(name "power"\)/gu)).toHaveLength(1);
    expect(tables.footprintTable).not.toContain("power");
    expect(bundle.executionGuidance).toContain("caller assertions");
    expect(canonicalJson(binding)).not.toContain("symbolRoot");
    expect(canonicalJson(binding)).not.toContain("footprintRoot");
  });

  it("canonicalizes input order and shares one return annotation across separate supply nets", () => {
    const value = draft(); value.nets.find((net: any) => net.name === "VOUT").role = "power_input";
    value.externalPowerInputs.push({ id: "SECOND", supplyEndpoint: { reference: "J1", pin: "2" }, returnEndpoint: { reference: "J1", pin: "3" } });
    const first = closePcbPlaneDesignIntentDraft(value);
    value.externalPowerInputs.reverse();
    expect(closePcbPlaneDesignIntentDraft(value)).toEqual(first);
    const { bundle } = fixture(value);
    expect(bundle.externalPowerBinding!.flags.map(flag => flag.net)).toEqual(["GND", "VIN", "VOUT"]);
    expect(bundle.externalPowerBinding!.flags.filter(flag => flag.net === "GND")).toHaveLength(1);
  });

  it.each([
    ["empty declaration", (d: any) => { d.externalPowerInputs = []; }],
    ["unknown extra field", (d: any) => { d.externalPowerInputs[0].voltage = 3.3; }],
    ["unknown component", (d: any) => { d.externalPowerInputs[0].supplyEndpoint.reference = "J9"; }],
    ["unknown pin", (d: any) => { d.externalPowerInputs[0].supplyEndpoint.pin = "9"; }],
    ["supply role", (d: any) => { d.nets.find((n: any) => n.name === "VIN").role = "power"; }],
    ["return role", (d: any) => { d.externalPowerInputs[0].returnEndpoint.pin = "2"; }],
    ["same endpoint", (d: any) => { d.externalPowerInputs[0].returnEndpoint.pin = "1"; }],
    ["duplicate supply", (d: any) => { d.externalPowerInputs.push({ ...d.externalPowerInputs[0], id: "OTHER" }); }],
    ["duplicate id", (d: any) => { d.externalPowerInputs.push(structuredClone(d.externalPowerInputs[0])); }],
    ["too many", (d: any) => { d.externalPowerInputs = Array.from({ length: 9 }, (_, i) => ({ ...d.externalPowerInputs[0], id: `P${i}` })); }],
  ])("rejects %s", (_name, change) => { const value = draft(); change(value); expect(() => parsePcbPlaneDesignIntentDraft(value)).toThrow(); });

  it("retains unknown nullable decisions but rejects closure and resolves keyed clarification paths", () => {
    const value = draft(); value.externalPowerInputs[0].supplyEndpoint = null;
    value.unresolved = [{ path: "/externalPowerInputs/0/supplyEndpoint", question: "Which connector pin supplies power?" }];
    const parsed = parsePcbPlaneDesignIntentDraft(value);
    expect(parsed.unresolved[0]!.path).toBe("/externalPowerInputs/INPUT/supplyEndpoint");
    expect(normalizePcbPlaneUnresolvedPath(value, "/externalPowerInputs/INPUT/supplyEndpoint")).toBe("/externalPowerInputs/INPUT/supplyEndpoint");
    expect(() => closePcbPlaneDesignIntentDraft(value)).toThrow();
    value.externalPowerInputs = null; value.unresolved = [];
    expect(parsePcbPlaneDesignIntentDraft(value).externalPowerInputs).toBeNull();
    expect(() => closePcbPlaneDesignIntentDraft(value)).toThrow();
  });

  it("rejects no-connect supply endpoints and nonconnector endpoints", () => {
    const value = draft(); value.components[0].pins[0].assignment = { kind: "no_connect" };
    value.nets.find((net: any) => net.name === "VIN").endpoints.shift();
    expect(() => parsePcbPlaneDesignIntentDraft(value)).toThrow(/no-connect/iu);
    const nonconnector = draft(); nonconnector.externalPowerInputs[0].supplyEndpoint = { reference: "R1", pin: "1" };
    const { resolver } = stock();
    const result = compilePcbPlaneDesignIntentDraft(nonconnector, { deepRuleCatalog: catalog, libraryResolver: {
      ...genericDividerLibraryResolver, inspectExternalPowerFlag: () => resolver.inspectExternalPowerFlag(),
    } });
    expect(result.disposition).toBe("needs_clarification");
    expect(result.issues[0]!.message).toContain("physical connector");
  });

  it("rejects legacy capability absence and unapproved exact flag IDs before ready compilation", () => {
    expect(compilePcbPlaneDesignIntentDraft(draft(), { deepRuleCatalog: catalog, libraryResolver: genericDividerLibraryResolver }).disposition).toBe("needs_clarification");
    const { options } = stock();
    expect(createKiCad10StockLibraryResolver({ ...options, exactSymbolIds: [] }).inspectExternalPowerFlag()).toBeNull();
    expect(createKiCad10StockLibraryResolver({ ...options, stockSymbolNicknames: ["Device"] }).inspectExternalPowerFlag()).toBeNull();
    expect(createKiCad10StockCatalog({ ...options, stockSymbolNicknames: ["Device"] }).inspectExternalPowerFlag()).toBeNull();
  });

  it("rechecks exact source and host policy for bundle reconstruction and authoring", () => {
    const { bundle, file, dependencies, options } = fixture();
    const bytes = serializePcbPlaneCompilationBundle(bundle);
    const changedPolicy = createKiCad10StockLibraryResolver({ ...options, exactSymbolIds: ["power:PWR_FLAG", "power:GND"] });
    expect(() => assertPcbExternalPowerBindingCurrent(bundle.externalPowerBinding!, changedPolicy)).toThrow(/policy changed/iu);
    writeFileSync(file, source.replace('(at 0 1 0)', '(at 0 2 0)'));
    expect(() => assertPcbExternalPowerBindingCurrent(bundle.externalPowerBinding!, dependencies.libraryResolver)).toThrow(/source or host policy changed/iu);
    expect(() => parsePcbPlaneCompilationBundle(bytes, dependencies)).toThrow(/differ/iu);
  });

  it("rejects stale capture while compiling, forged annotation descriptors and omitted bindings", () => {
    const { resolver, file } = stock(); let captures = 0;
    const changing = { ...genericDividerLibraryResolver, inspectExternalPowerFlag: () => {
      const value = resolver.inspectExternalPowerFlag();
      if (++captures === 1) writeFileSync(file, source.replace('(at 0 1 0)', '(at 0 2 0)'));
      return value;
    } };
    expect(compilePcbPlaneDesignIntentDraft(draft(), { deepRuleCatalog: catalog, libraryResolver: changing }).disposition).toBe("needs_clarification");
    const { bundle, dependencies } = fixture();
    const forged: any = structuredClone(bundle.externalPowerBinding); forged.flags[0].reference = "#FLG999";
    const { identity: _old, ...payload } = forged; forged.identity = canonicalIdentity(payload, forged.schemaVersion);
    expect(() => parsePcbExternalPowerBinding(forged)).toThrow(/canonical/iu);
    const stripped: any = structuredClone(bundle); delete stripped.externalPowerBinding;
    expect(() => parsePcbPlaneCompilationBundle(stripped, dependencies)).toThrow();
  });

  it("keeps guide opt-in and bounded while explaining caller assertion and physical separation", () => {
    expect(getPcbPlaneDesignIntentModelGuide()).toBe(PCB_PLANE_DESIGN_INTENT_MODEL_GUIDE);
    expect(getPcbPlaneDesignIntentModelGuide(false, true)).toContain("Optional externalPowerInputs");
    expect(getPcbPlaneDesignIntentModelGuide(false, true)).toContain("Do not invent flag components");
    expect(Buffer.byteLength(getPcbPlaneDesignIntentModelGuide(true, true), "utf8")).toBeLessThan(PCB_PLANE_DESIGN_INTENT_EXTENDED_MODEL_GUIDE_MAX_UTF8_BYTES);
  });
});

describe("strict stock PWR_FLAG role inspection", () => {
  const withNeighborNames = (names: readonly string[]) => source.replace('  (symbol "PWR_FLAG"',
    names.map(name => `  (symbol ${JSON.stringify(name)} (power global))\n`).join("") + '  (symbol "PWR_FLAG"');

  it("reads the flag among native +/- power names without widening regular exact IDs or shared parse caches", () => {
    const { resolver, file, options } = stock();
    writeFileSync(file, withNeighborNames(["+1V35", "+3.3VADC", "+BATT", "-2V5", "-VSW"]));
    expect(() => resolver.inspectSymbol("power:PWR_FLAG")).toThrow(/symbol names/u);
    const result = resolver.inspectExternalPowerFlag();
    expect(result?.symbolLibId).toBe("power:PWR_FLAG");
    expect(result?.geometry.representations.flatMap(representation => representation.pins)).toHaveLength(1);
    expect(() => resolver.inspectSymbol("power:PWR_FLAG")).toThrow(/symbol names/u);
    expect(resolver.resolveSymbol("power:+BATT")).toBeNull();
    expect(() => createKiCad10StockLibraryResolver({ ...options, exactSymbolIds: ["power:+BATT"] })).toThrow(/invalid exact library ID/u);
    expect(createKiCad10StockCatalog(options).inspectExternalPowerFlag()?.definitionIdentity).toEqual(result!.definitionIdentity);
  });

  it.each([
    ["duplicate signed names", ["+3V3", "+3V3"]],
    ["duplicate selected flag", ["PWR_FLAG"]],
    ["internal path separator", ["+bad/name"]],
    ["multiple signs", ["++3V3"]],
    ["overlong internal name", ["+" + "A".repeat(128)]],
  ])("rejects %s in the dedicated whole-library parse", (_name, names) => {
    const { resolver, file } = stock(); writeFileSync(file, withNeighborNames(names));
    expect(() => resolver.inspectExternalPowerFlag()).toThrow(/symbol names/u);
  });

  it("retains definition-count, source-byte and nesting ceilings in the dedicated parse", () => {
    const { file, options } = stock(); const bytes = withNeighborNames(["+3V3", "-3V3"]); writeFileSync(file, bytes);
    expect(() => createKiCad10StockLibraryResolver({ ...options, limits: { maxSymbolDefinitions: 2 } }).inspectExternalPowerFlag()).toThrow(/count/u);
    expect(() => createKiCad10StockLibraryResolver({ ...options, limits: { maxSymbolFileBytes: Buffer.byteLength(bytes) - 1 } }).inspectExternalPowerFlag()).toThrow();
    expect(() => createKiCad10StockLibraryResolver({ ...options, limits: { maxDepth: 4 } }).inspectExternalPowerFlag()).toThrow(/Nesting/u);
  });

  const installedRoot = "C:/Program Files/KiCad/10.0/share/kicad";
  it.skipIf(!existsSync(join(installedRoot, "symbols/power.kicad_sym")))("inspects the complete installed KiCad power library through the same guarded capability", () => {
    const options = { symbolRoot: join(installedRoot, "symbols"), footprintRoot: join(installedRoot, "footprints"),
      exactSymbolIds: ["power:PWR_FLAG"], exactFootprintIds: [], stockSymbolNicknames: ["power"], stockFootprintNicknames: ["Device"] };
    const result = createKiCad10StockLibraryResolver(options).inspectExternalPowerFlag();
    expect(result).toMatchObject({ symbolLibId: "power:PWR_FLAG", powerScope: "global", footprint: "", inBom: true, onBoard: true });
    expect(result!.geometry.representations.flatMap(representation => representation.pins)).toMatchObject([
      { number: "1", electricalType: "power_out", lengthMm: 0, at: { xMm: 0, yMm: 0 } },
    ]);
    expect(createKiCad10StockCatalog(options).inspectExternalPowerFlag()!.definitionSemanticIdentity).toEqual(result!.definitionSemanticIdentity);
  });

  it("provides separate guarded geometry/source evidence without changing regular symbol inspection", () => {
    const { resolver, options } = stock(); const ordinary = resolver.inspectSymbol("power:PWR_FLAG");
    const inspection = resolver.inspectExternalPowerFlag()!;
    expect(inspection).toMatchObject({ symbolLibId: "power:PWR_FLAG", powerScope: "global", footprint: "", inBom: true, onBoard: true });
    expect(inspection.definitionIdentity).toEqual(inspection.geometry.definitionIdentity);
    expect(resolver.inspectSymbol("power:PWR_FLAG")).toEqual(ordinary);
    const catalog = createKiCad10StockCatalog(options); const first = catalog.inspectExternalPowerFlag();
    catalog.resolveSymbol("power:PWR_FLAG");
    expect(catalog.inspectExternalPowerFlag()).toEqual(first);
    expect(first!.policyIdentity).not.toEqual(inspection.policyIdentity);
    expect(first!.definitionSemanticIdentity).toEqual(inspection.definitionSemanticIdentity);
  });

  it.each([
    ["missing global role", '(power global)', ''],
    ["local power role", '(power global)', '(power local)'],
    ["false on-board", '(on_board yes)', '(on_board no)'],
    ["false BOM", '(in_bom yes)', '(in_bom no)'],
    ["physical footprint", '(property "Footprint" ""', '(property "Footprint" "Device:R"'],
    ["reference spoof", '(property "Reference" "#FLG"', '(property "Reference" "U"'],
    ["wrong pin", '(number "1"', '(number "2"'],
    ["wrong electrical type", '(pin power_out line', '(pin passive line'],
    ["nonzero length", '(length 0)', '(length 2.54)'],
    ["wrong pin location", '(at 0 0 90)', '(at 1 0 90)'],
    ["unsupported extra unit", 'PWR_FLAG_1_1', 'PWR_FLAG_2_1'],
  ])("rejects %s", (_name, before, after) => {
    const { resolver, file } = stock(); writeFileSync(file, source.replace(before, after));
    expect(() => resolver.inspectExternalPowerFlag()).toThrow();
  });
});
