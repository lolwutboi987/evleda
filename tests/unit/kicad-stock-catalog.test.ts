import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { contentIdentity } from "../../src/core/canonical.js";
import { createKiCad10StockLibraryResolver } from "../../src/harness/kicad-library-resolver.js";
import {
  createKiCad10StockCatalog,
  type KiCad10StockCatalog,
  type KiCadStockCatalogOptions,
  type KiCadStockCatalogSearchInput,
  type KiCadStockCatalogSearchResult
} from "../../src/harness/kicad-stock-catalog.js";

const temporaryRoots: string[] = [];
interface Fixture { readonly root: string; readonly symbols: string; readonly footprints: string }
const pin = (number: string): string => `(pin passive line (at 0 0 0) (length 2.54)
  (name "" (effects (font (size 1.27 1.27)))) (number "${number}" (effects (font (size 1.27 1.27)))))`;
const symbol = (name: string, properties: Readonly<Record<string, string>> = {}): string => `(symbol ${JSON.stringify(name)}
  (property "Reference" "U" (at 0 0 0)) (property "Value" ${JSON.stringify(name)} (at 0 0 0))
  ${Object.entries(properties).map(([key, value]) => `(property ${JSON.stringify(key)} ${JSON.stringify(value)} (at 0 0 0))`).join("\n")}
  (symbol ${JSON.stringify(`${name}_1_1`)} ${pin("1")} ${pin("2")}))`;
const library = (definitions: readonly string[]): string => `(kicad_symbol_lib (version 20231120)
  (generator "evleda-test") (generator_version "10.0") ${definitions.join("\n")})\n`;
const footprint = (name: string, description = "stock test package"): string => `(footprint ${JSON.stringify(name)}
  (version 20240108) (generator "evleda-test") (layer "F.Cu") (descr ${JSON.stringify(description)}) (tags "analog smd")
  (property "Datasheet" "https://example.invalid/package.pdf")
  (fp_rect (start -2 -2) (end 2 2) (stroke (width 0.05) (type solid)) (fill none) (layer "F.CrtYd"))
  (fp_rect (start -1 -1) (end 1 1) (stroke (width 0.1) (type solid)) (fill none) (layer "F.Fab"))
  (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask" "F.Paste"))
  (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu" "F.Mask" "F.Paste")))\n`;
const writeLibrary = (fixture: Fixture, nickname: string, source: string): void => {
  writeFileSync(join(fixture.symbols, `${nickname}.kicad_sym`), source, "utf8");
};
const writeFootprint = (fixture: Fixture, nickname: string, name: string, source = footprint(name)): void => {
  const directory = join(fixture.footprints, `${nickname}.pretty`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.kicad_mod`), source, "utf8");
};
const createFixture = (): Fixture => {
  const root = mkdtempSync(join(tmpdir(), "evleda-stock-catalog-"));
  temporaryRoots.push(root);
  const fixture = { root, symbols: join(root, "symbols"), footprints: join(root, "footprints") };
  mkdirSync(fixture.symbols);
  mkdirSync(fixture.footprints);
  writeLibrary(fixture, "Device", library([symbol("R"), symbol("C"), symbol("LED")]));
  writeLibrary(fixture, "Logic", library([
    symbol("Zener"), symbol("OpAmp", {
      Description: "Precision low noise amplifier", ki_keywords: "analog rail-to-rail",
      Datasheet: "https://example.invalid/opamp.pdf", Footprint: "Package_QFN:QFN_2", ki_fp_filters: "QFN*"
    }), symbol("A+1"), symbol("A.1"), symbol("AB1"),
    '(symbol "Derived" (extends "OpAmp") (property "Description" "Derived amplifier"))',
    '(symbol "LegacyAlias" (alias "OpAmp") (property "Description" "Alias amplifier"))'
  ]));
  writeLibrary(fixture, "Project_Custom", library([symbol("Hidden")]));
  for (const name of ["ZPackage", "QFN_2", "Alpha"]) writeFootprint(fixture, "Package_QFN", name);
  writeFootprint(fixture, "Resistor_SMD", "R_0603");
  writeFootprint(fixture, "Project_Custom", "Hidden");
  return fixture;
};
const options = (fixture: Fixture, override: Partial<KiCadStockCatalogOptions> = {}): KiCadStockCatalogOptions => ({
  symbolRoot: fixture.symbols, footprintRoot: fixture.footprints,
  stockSymbolNicknames: ["Device", "Logic"], stockFootprintNicknames: ["Package_QFN", "Resistor_SMD"], ...override
});
const drain = (catalog: KiCad10StockCatalog, input: KiCadStockCatalogSearchInput): KiCadStockCatalogSearchResult[] => {
  const pages: KiCadStockCatalogSearchResult[] = [];
  let page = catalog.search(input);
  for (let index = 0; index < 100; index += 1) {
    pages.push(page);
    if (page.nextCursor === null) return pages;
    page = catalog.search({ ...input, cursor: page.nextCursor });
  }
  throw new Error("Catalog pagination did not finish within the fixture bound");
};
const ids = (pages: readonly KiCadStockCatalogSearchResult[]): string[] => pages.flatMap(page => page.candidates.map(candidate => candidate.libraryId));
const errorCode = (code: string) => expect.objectContaining({ code });

afterEach(() => {
  // Only roots returned by this file's own mkdtempSync calls are recursively removed.
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("KiCad 10 stock catalog", () => {
  it("discovers new IDs beyond the legacy fixture set and returns real source metadata", () => {
    const fixture = createFixture();
    const catalog = createKiCad10StockCatalog(options(fixture));
    const result = catalog.search({ kind: "symbol", query: "  PRECISION   rail-to-rail  " });
    expect(result).toMatchObject({ query: "PRECISION rail-to-rail", complete: true, exhausted: true, nextCursor: null,
      namespaceAuthority: "host-approved-kicad-10-stock", snapshot: "per-source-read-not-atomic" });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ libraryId: "Logic:OpAmp", description: "Precision low noise amplifier",
      keywords: "analog rail-to-rail", datasheet: "https://example.invalid/opamp.pdf", defaultFootprint: "Package_QFN:QFN_2",
      footprintFilters: "QFN*", status: "uninspected", unsupportedReason: null });
    expect(result.candidates[0]!.sourceIdentity).toEqual(contentIdentity(readFileSync(join(fixture.symbols, "Logic.kicad_sym"))));
    expect(ids(drain(catalog, { kind: "symbol", query: "" })).length).toBeGreaterThan(3);
    expect(catalog.inspectPair("Logic:OpAmp", "Package_QFN:QFN_2")?.exactPinPadMatch).toBe(true);
    const footprints = catalog.search({ kind: "footprint", query: "analog package", library: "Package_QFN" });
    expect(footprints.candidates).toHaveLength(3);
    expect(footprints.candidates[0]).toMatchObject({ description: "stock test package", keywords: "analog smd",
      datasheet: "https://example.invalid/package.pdf", defaultFootprint: null, status: "uninspected" });
    expect(Object.isFrozen(result.candidates[0])).toBe(true);
  });

  it("exposes derived and alias metadata as unsupported while exact inspection rejects both", () => {
    const catalog = createKiCad10StockCatalog(options(createFixture()));
    const result = catalog.search({ kind: "symbol", query: "amplifier", library: "Logic" });
    expect(result.candidates.filter(candidate => candidate.status === "unsupported")).toEqual([
      expect.objectContaining({ libraryId: "Logic:Derived", extends: "OpAmp", unsupportedReason: "DERIVED_SYMBOL_UNSUPPORTED" }),
      expect.objectContaining({ libraryId: "Logic:LegacyAlias", extends: null, unsupportedReason: "DERIVED_SYMBOL_UNSUPPORTED" })
    ]);
    for (const id of ["Logic:Derived", "Logic:LegacyAlias"]) {
      expect(() => catalog.inspectSymbol(id)).toThrowError(errorCode("DERIVED_SYMBOL_UNSUPPORTED"));
    }
  });

  it("uses only the host's approved namespaces for each asset kind", () => {
    const catalog = createKiCad10StockCatalog(options(createFixture()));
    for (const kind of ["symbol", "footprint"] as const) {
      expect(ids(drain(catalog, { kind, query: "" })).every(id => !id.startsWith("Project_Custom:"))).toBe(true);
      expect(() => catalog.search({ kind, query: "", library: "Project_Custom" })).toThrowError(errorCode("INVALID_QUERY"));
    }
    expect(catalog.inspectSymbol("Project_Custom:Hidden")).toBeNull();
    expect(catalog.inspectFootprint("Project_Custom:Hidden")).toBeNull();
    expect(catalog.inspectSymbol("Package_QFN:QFN_2")).toBeNull();
    expect(catalog.inspectFootprint("Logic:OpAmp")).toBeNull();
    expect(catalog.inspectPair("Project_Custom:Hidden", "Package_QFN:QFN_2")).toBeNull();
    expect(catalog.inspectSymbol("Logic:Missing")).toBeNull();
  });

  it("matches punctuation literally instead of treating queries as regular expressions", () => {
    const catalog = createKiCad10StockCatalog(options(createFixture()));
    expect(ids([catalog.search({ kind: "symbol", query: "A.1" })])).toEqual(["Logic:A.1"]);
    expect(ids([catalog.search({ kind: "symbol", query: "A+1" })])).toEqual(["Logic:A+1"]);
  });

  it.each([
    null, [], { kind: "model", query: "" }, { kind: "symbol" }, { kind: "symbol", query: 1 },
    { kind: "symbol", query: "[A-Z]" }, { kind: "symbol", query: ".*" }, { kind: "symbol", query: "foo|bar" },
    { kind: "symbol", query: "../Logic" }, { kind: "symbol", query: "C:\\stock" }, { kind: "symbol", query: "Logic/Part" },
    { kind: "symbol", query: "line\nbreak" }, { kind: "symbol", query: "tab\tbreak" },
    { kind: "symbol", query: "x".repeat(129) }, { kind: "symbol", query: "a b c d e f g h i" },
    { kind: "symbol", query: "", limit: 0 }, { kind: "symbol", query: "", limit: 101 },
    { kind: "symbol", query: "", limit: 1.5 }, { kind: "symbol", query: "", cursor: "short" },
    { kind: "symbol", query: "", symbolRoot: "C:\\stock" }
  ])("rejects malformed, regex, and path query input %#", input => {
    const catalog = createKiCad10StockCatalog(options(createFixture()));
    expect(() => catalog.search(input as KiCadStockCatalogSearchInput)).toThrowError(errorCode("INVALID_QUERY"));
  });

  it("rejects raised limits and noncanonical namespace policies", () => {
    const fixture = createFixture();
    for (const override of [
      { stockSymbolNicknames: ["Logic", "Device"] }, { stockSymbolNicknames: ["Device", "Device"] },
      { stockSymbolNicknames: ["../Device"] }, { searchLimits: { maxCursorStates: 17 } },
      { searchLimits: { maxResults: 0 } }, { searchLimits: { unknown: 1 } }
    ]) expect(() => createKiCad10StockCatalog(options(fixture, override as Partial<KiCadStockCatalogOptions>)))
      .toThrowError(errorCode("INVALID_CONFIGURATION"));
  });

  it("uses closed source filenames and reports nested directories without recursing", () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.symbols, "Alternate.lib"), library([symbol("Ghost")]), "utf8");
    writeFileSync(join(fixture.symbols, "Case.KICAD_SYM"), library([symbol("Ghost")]), "utf8");
    const directory = join(fixture.footprints, "Package_QFN.pretty");
    writeFileSync(join(directory, "Ghost.KICAD_MOD"), footprint("Ghost"), "utf8");
    writeFileSync(join(directory, "Backup.kicad_mod.bak"), footprint("Backup"), "utf8");
    mkdirSync(join(directory, "nested"));
    writeFileSync(join(directory, "nested", "Nested.kicad_mod"), footprint("Nested"), "utf8");
    const catalog = createKiCad10StockCatalog(options(fixture, { stockSymbolNicknames: ["Alternate", "Case", "Device", "Logic"] }));
    const symbols = catalog.search({ kind: "symbol", query: "Ghost" });
    expect(symbols).toMatchObject({ candidates: [], complete: false, exhausted: true, totalUnsupportedSources: 2 });
    expect(symbols.unsupported).toEqual([
      expect.objectContaining({ library: "Alternate", code: "MISSING_SOURCE" }), expect.objectContaining({ library: "Case", code: "MISSING_SOURCE" })
    ]);
    const footprints = catalog.search({ kind: "footprint", query: "", library: "Package_QFN" });
    expect(ids([footprints])).toEqual(["Package_QFN:Alpha", "Package_QFN:QFN_2", "Package_QFN:ZPackage"]);
    expect(footprints).toMatchObject({ complete: false, exhausted: true, unsupported: [
      { library: "Package_QFN", code: "UNSUPPORTED_DIRECTORY_ENTRIES", count: 1 }
    ] });
  });

  for (const kind of ["symbol", "footprint"] as const) it(`rejects a linked ${kind} source`, context => {
    const fixture = createFixture();
    const source = join(fixture.root, kind === "symbol" ? "external.kicad_sym" : "external.kicad_mod");
    writeFileSync(source, kind === "symbol" ? library([symbol("Linked")]) : footprint("Linked"), "utf8");
    const destination = kind === "symbol" ? join(fixture.symbols, "Linked.kicad_sym")
      : join(fixture.footprints, "Package_QFN.pretty", "Linked.kicad_mod");
    try { symlinkSync(source, destination, "file"); } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        context.skip("File symlinks are unavailable without additional host permission"); return;
      }
      throw error;
    }
    const catalog = createKiCad10StockCatalog(options(fixture, { stockSymbolNicknames: ["Device", "Linked", "Logic"] }));
    const result = catalog.search({ kind, query: "", library: kind === "symbol" ? "Linked" : "Package_QFN" });
    expect(result).toMatchObject({ complete: false, exhausted: true, candidates: [], unsupported: [expect.objectContaining({ code: "PATH_REJECTED" })] });
    expect(() => kind === "symbol" ? catalog.inspectSymbol("Linked:Linked") : catalog.inspectFootprint("Package_QFN:Linked"))
      .toThrowError(errorCode("PATH_REJECTED"));
  });

  it("reports malformed sources as incomplete coverage instead of a successful not-found", () => {
    const fixture = createFixture();
    writeLibrary(fixture, "Device", '(kicad_symbol_lib (symbol "broken"');
    writeFootprint(fixture, "Package_QFN", "Broken", '(footprint "Broken"');
    const catalog = createKiCad10StockCatalog(options(fixture));
    for (const kind of ["symbol", "footprint"] as const) {
      const result = catalog.search({ kind, query: "definitely-absent" });
      expect(result).toMatchObject({ candidates: [], complete: false, exhausted: true, nextCursor: null, totalUnsupportedSources: 1 });
      expect(result.unsupported).toEqual([expect.objectContaining({ code: "MALFORMED_LIBRARY" })]);
    }
  });

  it("keeps malformed symbol metadata visible as unsupported coverage even when a query filters it out", () => {
    const fixture = createFixture();
    writeLibrary(fixture, "Logic", library(['(symbol "BadMetadata" (property "Description") (symbol "BadMetadata_1_1"))']));
    const catalog = createKiCad10StockCatalog(options(fixture));
    const browse = catalog.search({ kind: "symbol", query: "", library: "Logic" });
    expect(browse.candidates).toEqual([expect.objectContaining({ libraryId: "Logic:BadMetadata", status: "unsupported", unsupportedReason: "MALFORMED_LIBRARY" })]);
    const filtered = catalog.search({ kind: "symbol", query: "precision", library: "Logic" });
    expect(filtered).toMatchObject({ candidates: [], complete: false, exhausted: true, totalUnsupportedSources: 1 });
    expect(filtered.unsupported).toEqual([expect.objectContaining({ libraryId: "Logic:BadMetadata", code: "MALFORMED_LIBRARY" })]);
  });

  it.each(["symbol", "footprint"] as const)("paginates %s deterministically under tightened work limits", kind => {
    const catalog = createKiCad10StockCatalog(options(createFixture(), { searchLimits: {
      maxSourceReadsPerPage: 1, maxLibrariesPerPage: 1, maxCandidatesScannedPerPage: 2
    } }));
    const input = { kind, query: "", limit: 2 };
    const first = drain(catalog, input);
    const second = drain(catalog, input);
    expect(ids(first)).toEqual(ids(second));
    expect(ids(first)).toEqual([...ids(first)].sort());
    expect(new Set(ids(first)).size).toBe(ids(first).length);
    expect(first.length).toBeGreaterThan(1);
    for (const page of first) {
      expect(page.candidates.length).toBeLessThanOrEqual(2);
      expect(page.scanned.sources).toBeLessThanOrEqual(1);
      expect(page.scanned.libraries).toBeLessThanOrEqual(1);
      expect(page.scanned.candidates).toBeLessThanOrEqual(2);
    }
    expect(first.at(-1)).toMatchObject({ complete: true, exhausted: true, nextCursor: null });
    expect(first.at(-1)!.totalScanned.sources).toBe(first.reduce((sum, page) => sum + page.scanned.sources, 0));
  });

  it("enforces request-bound, single-use, bounded and evicted cursors", () => {
    const catalog = createKiCad10StockCatalog(options(createFixture(), { searchLimits: { maxCursorStates: 2 } }));
    const input = { kind: "symbol" as const, query: "", library: "Logic", limit: 1 };
    const cursor = catalog.search(input).nextCursor!;
    expect(() => catalog.search({ ...input, query: "different", cursor })).toThrowError(errorCode("INVALID_CURSOR"));
    catalog.search({ ...input, cursor });
    expect(() => catalog.search({ ...input, cursor })).toThrowError(errorCode("INVALID_CURSOR"));
    expect(() => catalog.search({ ...input, cursor: "x".repeat(32) })).toThrowError(errorCode("INVALID_CURSOR"));
    const evicted = catalog.search(input).nextCursor!;
    catalog.search(input);
    const retained = catalog.search(input).nextCursor!;
    expect(catalog.cacheSnapshot().cursorStateCount).toBe(2);
    expect(() => catalog.search({ ...input, cursor: evicted })).toThrowError(errorCode("INVALID_CURSOR"));
    expect(catalog.search({ ...input, cursor: retained }).candidates).toHaveLength(1);
  });

  it("rejects changed raw symbol bytes between pages", () => {
    const fixture = createFixture();
    const catalog = createKiCad10StockCatalog(options(fixture));
    const input = { kind: "symbol" as const, query: "", library: "Logic", limit: 1 };
    const cursor = catalog.search(input).nextCursor!;
    const path = join(fixture.symbols, "Logic.kicad_sym");
    writeFileSync(path, `${readFileSync(path, "utf8")}\n`, "utf8");
    expect(() => catalog.search({ ...input, cursor })).toThrowError(errorCode("SOURCE_CHANGED"));
  });

  it.each(["add", "remove"] as const)("detects footprint directory %s changes between pages", change => {
    const fixture = createFixture();
    const catalog = createKiCad10StockCatalog(options(fixture));
    const input = { kind: "footprint" as const, query: "", library: "Package_QFN", limit: 1 };
    const cursor = catalog.search(input).nextCursor!;
    if (change === "add") writeFootprint(fixture, "Package_QFN", "Another");
    else unlinkSync(join(fixture.footprints, "Package_QFN.pretty", "ZPackage.kicad_mod"));
    expect(() => catalog.search({ ...input, cursor })).toThrowError(errorCode("SOURCE_CHANGED"));
  });

  it("reads more than 64 IDs cumulatively while retaining bounded aggregate caches", () => {
    const fixture = createFixture();
    const names = Array.from({ length: 70 }, (_, index) => `Part${String(index).padStart(3, "0")}`);
    writeLibrary(fixture, "Logic", library(names.map(name => symbol(name))));
    for (const name of names) writeFootprint(fixture, "Package_QFN", name);
    const catalog = createKiCad10StockCatalog(options(fixture, { limits: { maxCachedFiles: 2, maxCachedSourceBytes: 2048, maxCachedRecords: 4 } }));
    const assertBounded = () => {
      const cache = catalog.cacheSnapshot();
      expect(cache.exactResolverCount).toBe(1);
      expect(cache.parsedSymbolFileCount + cache.parsedFootprintFileCount).toBeLessThanOrEqual(2);
      expect(cache.cachedSourceBytes).toBeLessThanOrEqual(2048);
    };
    for (const name of names) {
      expect(catalog.inspectSymbol(`Logic:${name}`)?.pins).toHaveLength(2);
      expect(catalog.inspectFootprint(`Package_QFN:${name}`)?.pads).toHaveLength(2);
      assertBounded();
    }
    const selection = catalog.captureSourceSelection({
      symbolIds: names.slice(0, 64).map(name => `Logic:${name}`), footprintIds: names.slice(0, 64).map(name => `Package_QFN:${name}`)
    });
    expect(selection.records).toHaveLength(128);
    assertBounded();
  }, 20_000);

  it("updates discovery, inspections and selection identity when raw bytes change but normalized pins do not", () => {
    const fixture = createFixture();
    const catalog = createKiCad10StockCatalog(options(fixture));
    const selected = { symbolIds: ["Logic:OpAmp"], footprintIds: ["Package_QFN:QFN_2"] };
    const beforeSelection = catalog.captureSourceSelection(selected);
    const beforeSymbol = catalog.inspectSymbol("Logic:OpAmp")!;
    const beforeFootprint = catalog.inspectFootprint("Package_QFN:QFN_2")!;
    const symbolPath = join(fixture.symbols, "Logic.kicad_sym");
    writeFileSync(symbolPath, readFileSync(symbolPath, "utf8").replace("Precision low noise amplifier", "Precision revised amplifier"), "utf8");
    const footprintPath = join(fixture.footprints, "Package_QFN.pretty", "QFN_2.kicad_mod");
    writeFileSync(footprintPath, `${readFileSync(footprintPath, "utf8")}\n`, "utf8");
    const afterSymbol = catalog.inspectSymbol("Logic:OpAmp")!;
    const afterFootprint = catalog.inspectFootprint("Package_QFN:QFN_2")!;
    expect(afterSymbol.resolverRecord).toEqual(beforeSymbol.resolverRecord);
    expect(afterFootprint.resolverRecord).toEqual(beforeFootprint.resolverRecord);
    expect(afterSymbol.sourceIdentity).not.toEqual(beforeSymbol.sourceIdentity);
    expect(afterSymbol.identity).not.toEqual(beforeSymbol.identity);
    expect(afterFootprint.sourceIdentity).not.toEqual(beforeFootprint.sourceIdentity);
    const found = catalog.search({ kind: "symbol", query: "revised" });
    expect(found.candidates).toEqual([expect.objectContaining({ libraryId: "Logic:OpAmp", sourceIdentity: afterSymbol.sourceIdentity })]);
    const footprintFound = catalog.search({ kind: "footprint", query: "QFN_2", library: "Package_QFN" });
    expect(footprintFound.candidates[0]!.sourceIdentity).toEqual(afterFootprint.sourceIdentity);
    const afterSelection = catalog.captureSourceSelection(selected);
    expect(afterSelection.policyIdentity).toEqual(beforeSelection.policyIdentity);
    expect(afterSelection.identity).not.toEqual(beforeSelection.identity);
    expect(afterSelection.records.map(record => record.sourceIdentity)).not.toEqual(beforeSelection.records.map(record => record.sourceIdentity));
  });

  it("enforces 64 selections per kind and returns one consistent path-free policy identity", () => {
    const fixture = createFixture();
    const catalog = createKiCad10StockCatalog(options(fixture));
    const selected = { symbolIds: ["Logic:OpAmp"], footprintIds: ["Package_QFN:QFN_2"] };
    const selection = catalog.captureSourceSelection(selected);
    const search = catalog.search({ kind: "symbol", query: "OpAmp" });
    expect(selection.policyIdentity).toEqual(search.policyIdentity);
    expect(createKiCad10StockCatalog(options(fixture)).captureSourceSelection(selected)).toEqual(selection);
    expect(createKiCad10StockCatalog(options(fixture, { stockSymbolNicknames: ["Logic"] })).captureSourceSelection(selected).policyIdentity)
      .not.toEqual(selection.policyIdentity);
    for (const kind of ["symbolIds", "footprintIds"] as const) {
      const excessive = Array.from({ length: 65 }, (_, index) => `${kind === "symbolIds" ? "Logic" : "Package_QFN"}:Part${index}`);
      expect(() => catalog.captureSourceSelection({ ...selected, [kind]: excessive })).toThrow();
    }
    expect(() => catalog.captureSourceSelection({ ...selected, symbolIds: ["Logic:OpAmp", "Logic:OpAmp"] })).toThrow();
    expect(() => catalog.captureSourceSelection({ ...selected, symbolIds: ["Project_Custom:Hidden"] })).toThrowError(errorCode("PATH_REJECTED"));
    const publicJson = JSON.stringify({ selection, search, inspection: catalog.inspectSymbol("Logic:OpAmp"), cache: catalog.cacheSnapshot() });
    expect(publicJson).not.toContain(fixture.root);
    expect(publicJson).not.toMatch(/"[A-Za-z]:[\\/]/u);
    expect(publicJson).not.toContain("symbolRoot");
    expect(publicJson).not.toContain("canonicalPath");
  });

  it("rejects root replacement before rebinding an exact inspection selection", () => {
    const fixture = createFixture();
    const catalog = createKiCad10StockCatalog(options(fixture));
    expect(catalog.inspectSymbol("Logic:OpAmp")).not.toBeNull();
    renameSync(fixture.symbols, join(fixture.root, "original-symbols"));
    mkdirSync(fixture.symbols);
    writeLibrary(fixture, "Logic", library([symbol("Replacement")]));
    expect(() => catalog.inspectSymbol("Logic:Replacement")).toThrowError(errorCode("PATH_REJECTED"));
    expect(() => catalog.captureSourceSelection({ symbolIds: ["Logic:Replacement"], footprintIds: [] })).toThrowError(errorCode("PATH_REJECTED"));
    expect(catalog.search({ kind: "symbol", query: "", library: "Logic" })).toMatchObject({
      complete: false, exhausted: true, candidates: [], unsupported: [expect.objectContaining({ code: "PATH_REJECTED" })]
    });
  });

  it("does not widen a separately created legacy exact resolver", () => {
    const fixture = createFixture();
    const shared = options(fixture);
    const exact = createKiCad10StockLibraryResolver({ ...shared, exactSymbolIds: ["Device:R"], exactFootprintIds: ["Resistor_SMD:R_0603"] });
    const catalog = createKiCad10StockCatalog(shared);
    expect(catalog.inspectSymbol("Logic:OpAmp")).not.toBeNull();
    expect(catalog.inspectFootprint("Package_QFN:QFN_2")).not.toBeNull();
    expect(exact.inspectSymbol("Logic:OpAmp")).toBeNull();
    expect(exact.inspectFootprint("Package_QFN:QFN_2")).toBeNull();
    expect(exact.inspectSymbol("Device:R")).not.toBeNull();
  });
});

const installedSymbolRoot = "C:\\Program Files\\KiCad\\10.0\\share\\kicad\\symbols";
const installedFootprintRoot = "C:\\Program Files\\KiCad\\10.0\\share\\kicad\\footprints";
it.runIf(existsSync(join(installedSymbolRoot, "MCU_RaspberryPi.kicad_sym")) && existsSync(join(installedFootprintRoot, "Package_DFN_QFN.pretty")))(
  "discovers and inspects installed stock RP2040 read-only without launching KiCad", () => {
    const catalog = createKiCad10StockCatalog({ symbolRoot: installedSymbolRoot, footprintRoot: installedFootprintRoot,
      stockSymbolNicknames: ["MCU_RaspberryPi"], stockFootprintNicknames: ["Package_DFN_QFN"] });
    const found = drain(catalog, { kind: "symbol", query: "RP2040", limit: 10 });
    expect(ids(found)).toContain("MCU_RaspberryPi:RP2040");
    const candidate = found.flatMap(page => page.candidates).find(value => value.libraryId === "MCU_RaspberryPi:RP2040")!;
    expect(candidate.status).toBe("uninspected");
    expect(catalog.inspectSymbol("MCU_RaspberryPi:RP2040")).toMatchObject({ sourceIdentity: candidate.sourceIdentity,
      resolverRecord: { libraryId: "MCU_RaspberryPi:RP2040", unitCount: 1 } });
  }, 20_000
);
