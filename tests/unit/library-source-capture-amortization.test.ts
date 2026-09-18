import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const reads = vi.hoisted(() => ({ paths: new Map<number, string>(), counts: new Map<string, number>(),
  hook: undefined as ((file: string) => void) | undefined }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const observed = (file: string) => { reads.counts.set(file, (reads.counts.get(file) ?? 0) + 1); reads.hook?.(file); };
  return { ...actual,
    openSync: (...args: unknown[]) => { const fd = Reflect.apply(actual.openSync, actual, args) as number; reads.paths.set(fd, String(args[0])); return fd; },
    closeSync: (fd: number) => { reads.paths.delete(fd); return actual.closeSync(fd); },
    readFileSync: (...args: unknown[]) => { const value = Reflect.apply(actual.readFileSync, actual, args) as Buffer | string;
      observed(typeof args[0] === "number" ? reads.paths.get(args[0])! : String(args[0])); return value; },
    readSync: (...args: unknown[]) => { const count = Reflect.apply(actual.readSync, actual, args) as number;
      if (count > 0) observed(reads.paths.get(args[0] as number)!); return count; },
  };
});

import { contentIdentity } from "../../src/core/canonical.js";
import { KiCadApprovedPackageResolver } from "../../src/harness/kicad-approved-package.js";
import { createKiCad10StockCatalog, captureGenuineKiCadStockCatalogSelection } from "../../src/harness/kicad-stock-catalog.js";
import { createKiCad10StockLibraryResolver, createKiCadStockSyntaxCache, type KiCadStockSyntaxCache } from "../../src/harness/kicad-library-resolver.js";
import { createPcbLibrarySourceSelection } from "../../src/harness/pcb-library-source-binding.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  reads.hook = undefined; reads.counts.clear(); reads.paths.clear();
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)) throw new Error("Unsafe test cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});

function observeSyntaxDecodes() {
  const decode = TextDecoder.prototype.decode, sources: string[] = [];
  vi.spyOn(TextDecoder.prototype, "decode").mockImplementation(function (this: TextDecoder, input, options) {
    const source = decode.call(this, input, options);
    if (/^\s*\((?:kicad_symbol_lib|footprint)\b/u.test(source)) sources.push(source);
    return source;
  });
  return sources;
}

describe("catalog-owned parsed syntax across exact selections", () => {
  it("reuses syntax across alternating selections while freshly reading every lookup", () => {
    const f = fixture(), decodes = observeSyntaxDecodes(); reset();
    const first = f.catalog.inspectSymbol("Test:A")!;
    f.catalog.inspectSymbol("Other:Z");
    expect(f.catalog.inspectSymbol("Test:A")).toEqual(first);
    expect(f.catalog.inspectSymbol("Test:B")!.libraryId).toBe("Test:B");
    expect(decodes).toHaveLength(2);
    expect(reads.counts.get(f.shared)).toBe(3);
    const before = f.catalog.captureSourceSelection(f.selected);
    const warmed = decodes.length;
    f.catalog.inspectSymbol("Other:Z");
    expect(f.catalog.captureSourceSelection(f.selected)).toEqual(before);
    expect(decodes).toHaveLength(warmed);
  });

  it("does not widen exact ID or namespace admission when syntax contains more symbols", () => {
    const f = fixture(), storage = createKiCadStockSyntaxCache(), decodes = observeSyntaxDecodes();
    const exact = (ids: string[], stockSymbolNicknames = f.policy.stockSymbolNicknames) => createKiCad10StockLibraryResolver({
      ...f.policy, stockSymbolNicknames, exactSymbolIds: ids, exactFootprintIds: [],
    }, storage);
    const onlyA = exact(["Test:A"]); onlyA.inspectSymbol("Test:A"); reset();
    expect(onlyA.inspectSymbol("Test:B")).toBeNull();
    expect(reads.counts.size).toBe(0);
    expect(exact(["Test:B"]).inspectSymbol("Test:B")!.libraryId).toBe("Test:B");
    expect(decodes).toHaveLength(1);
    reset(); expect(exact(["Test:A"], ["Other"]).inspectSymbol("Test:A")).toBeNull();
    expect(reads.counts.size).toBe(0);
  });

  it("does not borrow a parse admitted under looser parser limits", () => {
    const f = fixture(), storage = createKiCadStockSyntaxCache();
    const options = { ...f.policy, exactSymbolIds: ["Test:A"], exactFootprintIds: [] };
    const ordinary = createKiCad10StockLibraryResolver(options, storage);
    expect(ordinary.inspectSymbol("Test:A")).not.toBeNull();
    const strict = createKiCad10StockLibraryResolver({ ...options, limits: { maxSymbolDefinitions: 1 } }, storage);
    expect(() => strict.inspectSymbol("Test:A")).toThrow(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));
    expect(ordinary.inspectSymbol("Test:A")).not.toBeNull();
    expect(() => createKiCad10StockLibraryResolver({ ...options, limits: { maxCachedFiles: 1 } }, storage)).toThrow(/aggregate cache bounds/u);
    expect(() => createKiCad10StockLibraryResolver(options, {} as KiCadStockSyntaxCache)).toThrow(/genuine/u);
  });

  it("binds reuse to exact file/root policy and isolates independent catalogs", () => {
    const a = fixture(), b = fixture(), storage = createKiCadStockSyntaxCache(), decodes = observeSyntaxDecodes();
    for (const f of [a, b]) createKiCad10StockLibraryResolver({ ...f.policy, exactSymbolIds: ["Test:A"], exactFootprintIds: [] }, storage).inspectSymbol("Test:A");
    expect(decodes).toHaveLength(2);
    a.catalog.inspectSymbol("Test:A");
    createKiCad10StockCatalog(a.policy).inspectSymbol("Test:A");
    expect(decodes).toHaveLength(4);
  });

  it("rejects stale syntax after same-size restored-mtime edits and retains fresh guards on cache hits", () => {
    const f = fixture(), decodes = observeSyntaxDecodes(), original = f.catalog.inspectSymbol("Test:A")!;
    f.catalog.inspectSymbol("Other:Z"); mutateSameSize(f.shared);
    const changed = f.catalog.inspectSymbol("Test:A")!;
    expect(changed.identity).not.toEqual(original.identity);
    expect(changed.pins[0]!.name).toBe("Q");
    expect(decodes).toHaveLength(3);
    f.catalog.inspectSymbol("Other:Z");
    const before = statSync(f.shared), bytes = readFileSync(f.shared, "utf8");
    writeFileSync(f.shared, bytes.replace("passive", "invalid")); utimesSync(f.shared, before.atime, before.mtime);
    expect(() => f.catalog.inspectSymbol("Test:A")).toThrow();
  });

  it("keeps aggregate file and byte limits across replacements and failures", () => {
    const f = fixture(), catalog = createKiCad10StockCatalog({ ...f.policy, limits: { maxCachedFiles: 1, maxCachedSourceBytes: 1024 } });
    for (const id of ["Test:A", "Other:Z", "Test:B", "Other:Z", "Test:A"]) {
      expect(catalog.inspectSymbol(id)).not.toBeNull();
      const cache = catalog.cacheSnapshot();
      expect(cache.parsedSymbolFileCount + cache.parsedFootprintFileCount).toBeLessThanOrEqual(1);
      expect(cache.cachedSourceBytes).toBeLessThanOrEqual(1024);
    }
    writeFileSync(f.shared, library(["A", "B"]).replace("passive", "invalid"));
    expect(() => catalog.inspectSymbol("Test:A")).toThrow();
    expect(catalog.cacheSnapshot().cachedSourceBytes).toBeLessThanOrEqual(1024);
  });

  it("does not let footprint definition aliases mutate reused syntax", () => {
    const f = fixture(), first = f.catalog.inspectFootprint("Test:F")!;
    const definition = first.physicalPads[0]!.definition;
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Reflect.set(definition, "name", "modified")).toBe(false);
    expect(Reflect.set(definition.values[0]!, "value", "999")).toBe(false);
    f.catalog.inspectSymbol("Other:Z");
    expect(f.catalog.inspectFootprint("Test:F")).toEqual(first);
  });
});
const symbol = (name: string) => `(symbol "${name}" (property "Reference" "U" (at 0 0 0)) (property "Value" "${name}" (at 0 0 0))
  (symbol "${name}_1_1" (pin passive line (at 0 0 0) (length 2.54) (name "P" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))))`;
const library = (names: string[]) => `(kicad_symbol_lib (version 20231120) ${names.map(symbol).join(" ")})\n`;
const footprint = `(footprint "F" (version 20240108) (layer "F.Cu") (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask")))\n`;
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "evleda-capture-amortization-")); roots.push(root);
  const put = (relative: string, source: string) => { const file = path.join(root, relative); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, source); return file; };
  const shared = put("stock/symbols/Test.kicad_sym", library(["A", "B"]));
  const second = put("stock/symbols/Other.kicad_sym", library(["Z"]));
  put("stock/footprints/Test.pretty/F.kicad_mod", footprint);
  const policy = { symbolRoot: path.join(root, "stock/symbols"), footprintRoot: path.join(root, "stock/footprints"),
    stockSymbolNicknames: ["Other", "Test"], stockFootprintNicknames: ["Test"] };
  const selected = { symbolIds: ["Other:Z", "Test:A", "Test:B"], footprintIds: ["Test:F"] };
  const catalog = createKiCad10StockCatalog(policy);
  const namespace = "EvlEDA_Capture", packageRoot = path.join(root, "package");
  const pin = (relativePath: string, source: string) => { put(`package/${relativePath}`, source); return { relativePath, identity: contentIdentity(source) }; };
  const symbolPin = pin(`symbols/${namespace}.kicad_sym`, library(["A", "B"]));
  const footprintPin = pin(`footprints/${namespace}.pretty/F.kicad_mod`, footprint);
  const notice = pin("NOTICE.md", "test package\n"), provenance = pin("provenance/vendor.md", "original vendor evidence\n");
  const manifest = { schemaVersion: "evleda.kicad-approved-package.v1", namespace,
    symbols: ["A", "B"].map(name => ({ libraryId: `${namespace}:${name}`, source: symbolPin, provenanceIds: ["vendor"] })),
    footprints: [{ libraryId: `${namespace}:F`, source: footprintPin, provenanceIds: ["vendor"] }],
    notice, provenance: [{ ...provenance, id: "vendor", url: "https://example.invalid/vendor" }] };
  const profile = { root: packageRoot, manifest: pin("manifest.json", JSON.stringify(manifest)) };
  const composite = () => new KiCadApprovedPackageResolver(profile, catalog, policy);
  return { root, put, shared, second, policy, selected, catalog, namespace, packageRoot, profile, composite,
    customSelected: { symbolIds: [`${namespace}:A`, `${namespace}:B`, ...selected.symbolIds], footprintIds: [`${namespace}:F`, ...selected.footprintIds] } };
}
const reset = () => { reads.counts.clear(); reads.hook = undefined; };
const mutateSameSize = (file: string) => {
  const before = statSync(file), text = readFileSync(file, "utf8");
  writeFileSync(file, text.replace('"P"', '"Q"'));
  utimesSync(file, before.atime, before.mtime);
};

describe("synchronous source capture amortization", () => {
  it("reads a shared stock file once at entry and once at exit, retaining exact standalone identities", () => {
    const f = fixture(); reset();
    const capture = f.catalog.captureSourceSelection(f.selected);
    expect(reads.counts.get(f.shared)).toBe(2);
    expect(reads.counts.get(f.second)).toBe(2);
    for (const record of capture.records) {
      const inspection = record.kind === "symbol" ? f.catalog.inspectSymbol(record.libraryId) : f.catalog.inspectFootprint(record.libraryId);
      expect(record.sourceIdentity).toEqual(inspection!.sourceIdentity);
      expect(record.inspectionIdentity).toEqual(inspection!.identity);
    }
    reset(); f.catalog.captureSourceSelection(f.selected);
    expect(reads.counts.get(f.shared)).toBe(2);
  });

  it("rejects same-size restored-mtime stock drift before final capture publication", () => {
    const f = fixture(); let changed = false;
    reads.hook = file => { if (!changed && file === f.shared) { changed = true; reads.hook = undefined; mutateSameSize(f.second); } };
    expect(() => f.catalog.captureSourceSelection(f.selected)).toThrow(expect.objectContaining({ code: "SOURCE_CHANGED" }));
    reads.hook = undefined;
    const later = f.catalog.captureSourceSelection(f.selected);
    expect(later.records.find(record => record.libraryId === "Other:Z")!.sourceIdentity).toEqual(contentIdentity(readFileSync(f.second)));
  });

  it("rechecks bytes on a new independent capture, even with restored size and mtime", () => {
    const f = fixture(), before = f.catalog.captureSourceSelection(f.selected);
    mutateSameSize(f.shared);
    const after = f.catalog.captureSourceSelection(f.selected);
    expect(after.identity).not.toEqual(before.identity);
    expect(after.records.filter(record => record.libraryId.startsWith("Test:") && record.kind === "symbol")
      .every(record => record.sourceIdentity.digest === contentIdentity(readFileSync(f.shared)).digest)).toBe(true);
  });

  it("rechecks parent links at the final stock fence", () => {
    const f = fixture(), old = `${f.policy.symbolRoot}-old`; let replaced = false;
    reads.hook = file => {
      if (!replaced && file.endsWith("F.kicad_mod")) {
        replaced = true; reads.hook = undefined;
        renameSync(f.policy.symbolRoot, old);
        symlinkSync(old, f.policy.symbolRoot, process.platform === "win32" ? "junction" : "dir");
      }
    };
    expect(() => f.catalog.captureSourceSelection(f.selected)).toThrow();
    expect(replaced).toBe(true);
    unlinkSync(f.policy.symbolRoot);
  });

  it("does not retain all selected raw files in the parsed-cache budget", () => {
    const f = fixture();
    const resolver = createKiCad10StockLibraryResolver({ ...f.policy, exactSymbolIds: f.selected.symbolIds, exactFootprintIds: f.selected.footprintIds,
      limits: { maxCachedFiles: 1, maxCachedSourceBytes: 1024 } });
    expect(resolver.captureSourceSelectionRecords()).toHaveLength(4);
    expect(resolver.cacheSnapshot().parsedSymbolFileCount + resolver.cacheSnapshot().parsedFootprintFileCount).toBe(1);
  });

  it("fences package metadata only twice and shares a multi-symbol source, with identical records", () => {
    const f = fixture(), resolver = f.composite(); reset();
    const capture = resolver.captureSourceSelection(f.customSelected);
    expect(reads.counts.get(path.join(f.packageRoot, "manifest.json"))).toBe(2);
    expect(reads.counts.get(path.join(f.packageRoot, "NOTICE.md"))).toBe(2);
    expect(reads.counts.get(path.join(f.packageRoot, "provenance/vendor.md"))).toBe(2);
    expect(reads.counts.get(path.join(f.packageRoot, `symbols/${f.namespace}.kicad_sym`))).toBe(2);
    expect(reads.counts.get(f.shared)).toBe(2);
    for (const record of capture.records) {
      const inspection = record.kind === "symbol" ? resolver.inspectSymbol(record.libraryId) : resolver.inspectFootprint(record.libraryId);
      expect(record.sourceIdentity).toEqual(inspection!.sourceIdentity);
      expect(record.inspectionIdentity).toEqual(inspection!.identity);
    }
  });

  it.each(["provenance", "symbol", "shadow", "source-link"])("rejects package %s changed by stock work inside capture", kind => {
    const f = fixture(), resolver = f.composite(); let changed = false;
    const source = path.join(f.packageRoot, `symbols/${f.namespace}.kicad_sym`), old = `${source}.old`;
    reads.hook = file => {
      if (!changed && file === f.second) {
        changed = true; reads.hook = undefined;
        if (kind === "provenance") writeFileSync(path.join(f.packageRoot, "provenance/vendor.md"), "modified vendor evidence\n");
        if (kind === "symbol") mutateSameSize(source);
        if (kind === "shadow") writeFileSync(path.join(f.policy.symbolRoot, `${f.namespace}.kicad_sym`), library(["A"]));
        if (kind === "source-link") { renameSync(source, old); symlinkSync(path.dirname(source), `${path.dirname(source)}-link`, process.platform === "win32" ? "junction" : "dir"); renameSync(path.dirname(source), `${path.dirname(source)}-old`); renameSync(`${path.dirname(source)}-link`, path.dirname(source)); }
      }
    };
    expect(() => resolver.captureSourceSelection(f.customSelected)).toThrow();
    expect(changed).toBe(true);
    if (kind === "source-link") unlinkSync(path.dirname(source));
    else expect(() => resolver.captureSourceSelection(f.customSelected)).toThrow();
  });

  it("does not trust structural stock captures over their direct inspection records", () => {
    const f = fixture(), selected = { symbolIds: ["Test:A"], footprintIds: [] };
    const structural = { resolveSymbol: f.catalog.resolveSymbol.bind(f.catalog), resolveFootprint: f.catalog.resolveFootprint.bind(f.catalog),
      inspectSymbol: f.catalog.inspectSymbol.bind(f.catalog), inspectFootprint: f.catalog.inspectFootprint.bind(f.catalog),
      inspectSymbolTerminalGeometry: f.catalog.inspectSymbolTerminalGeometry.bind(f.catalog),
      captureSourceSelection: () => {
        const captured = f.catalog.captureSourceSelection(selected);
        return createPcbLibrarySourceSelection({ policyIdentity: captured.policyIdentity, records: captured.records.map(record => ({ ...record,
          sourceIdentity: { ...record.sourceIdentity, digest: "0".repeat(64) } })) }, selected);
      } };
    const resolver = new KiCadApprovedPackageResolver(f.profile, structural, f.policy);
    expect(resolver.captureSourceSelection(selected).records[0]!.sourceIdentity).toEqual(f.catalog.inspectSymbol("Test:A")!.sourceIdentity);
  });

  it("rejects proxy and overridden catalog shortcuts without invoking proxy traps", () => {
    const f = fixture(); let traps = 0;
    const proxy = new Proxy(f.catalog, { getPrototypeOf() { traps++; return Object.getPrototypeOf(f.catalog); } });
    expect(captureGenuineKiCadStockCatalogSelection(proxy, f.selected)).toBeUndefined(); expect(traps).toBe(0);
    Object.defineProperty(f.catalog, "inspectSymbol", { value: f.catalog.inspectSymbol.bind(f.catalog) });
    expect(captureGenuineKiCadStockCatalogSelection(f.catalog, f.selected)).toBeUndefined();
  });

  it("allows independent nested captures without sharing in-progress authority", () => {
    const f = fixture(), resolver = f.composite(); let nested = false;
    reads.hook = file => { if (!nested && file === f.second) { nested = true; reads.hook = undefined;
      expect(resolver.captureSourceSelection({ symbolIds: ["Test:A"], footprintIds: [] }).records).toHaveLength(1); } };
    const outer = resolver.captureSourceSelection(f.customSelected);
    expect(outer.records).toHaveLength(7);
    expect(nested).toBe(true);
    expect(resolver.captureSourceSelection(f.customSelected)).toEqual(outer);
  });
});
