import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const observed = vi.hoisted(() => ({ descriptors: new Map<number, string>(), reads: new Map<string, number>(),
  geometryParses: 0, semanticParses: 0, closed: undefined as ((file: string) => void) | undefined }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual,
    openSync: (...args: unknown[]) => { const fd = Reflect.apply(actual.openSync, actual, args) as number; observed.descriptors.set(fd, String(args[0])); return fd; },
    readFileSync: (...args: unknown[]) => {
      const result = Reflect.apply(actual.readFileSync, actual, args) as Buffer | string;
      if (typeof args[0] === "number") { const file = observed.descriptors.get(args[0])!; observed.reads.set(file, (observed.reads.get(file) ?? 0) + 1); }
      return result;
    },
    closeSync: (fd: number) => { const file = observed.descriptors.get(fd)!; observed.descriptors.delete(fd); actual.closeSync(fd); observed.closed?.(file); },
  };
});
vi.mock("../../src/harness/fresh-kicad-parser.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/harness/fresh-kicad-parser.js")>();
  return { ...actual,
    parseFreshSymbolLibraryTerminalGeometrySource: (...args: Parameters<typeof actual.parseFreshSymbolLibraryTerminalGeometrySource>) => {
      observed.geometryParses++; return actual.parseFreshSymbolLibraryTerminalGeometrySource(...args);
    },
    freshPowerFlagDefinitionSemanticIdentity: (...args: Parameters<typeof actual.freshPowerFlagDefinitionSemanticIdentity>) => {
      observed.semanticParses++; return actual.freshPowerFlagDefinitionSemanticIdentity(...args);
    },
  };
});

import { contentIdentity } from "../../src/core/canonical.js";
import { createKiCad10StockLibraryResolver, createKiCadStockSyntaxCache } from "../../src/harness/kicad-library-resolver.js";
import { createKiCad10StockCatalog } from "../../src/harness/kicad-stock-catalog.js";

// Synthetic parser workload only; no native execution or manufacturing claim.
const flagSource = `(kicad_symbol_lib (version 20250114) (generator "test")
  (symbol "+3V3" (power global))
  (symbol "PWR_FLAG" (power global) (in_bom yes) (on_board yes)
    (property "Reference" "#FLG" (at 0 0 0)) (property "Value" "PWR_FLAG" (at 0 1 0)) (property "Footprint" "" (at 0 0 0))
    (symbol "PWR_FLAG_0_1" (polyline (pts (xy 0 0) (xy 0 1) (xy 1 2) (xy -1 2) (xy 0 1)) (stroke (width 0) (type default)) (fill (type none))))
    (symbol "PWR_FLAG_1_1" (pin power_out line (at 0 0 90) (length 0)
      (name "pwr" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27))))))))\n`;
const ordinarySource = `(kicad_symbol_lib (version 20250114) (symbol "R" (property "Reference" "R" (at 0 0 0))
  (symbol "R_1_1" (pin passive line (at 0 0 0) (length 2.54) (name "P") (number "1")))))\n`;
const footprintSource = (name: string) => `(footprint "${name}" (version 20250114) (layer "F.Cu") (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask")))\n`;
const roots: string[] = [];
afterEach(() => {
  observed.closed = undefined; observed.descriptors.clear(); observed.reads.clear(); observed.geometryParses = 0; observed.semanticParses = 0;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)) throw new Error("Unsafe parser fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "evleda-power-syntax-")); roots.push(root);
  const symbolRoot = path.join(root, "symbols"), footprintRoot = path.join(root, "footprints");
  mkdirSync(symbolRoot); mkdirSync(path.join(footprintRoot, "Parts.pretty"), { recursive: true });
  const file = path.join(symbolRoot, "power.kicad_sym"); writeFileSync(file, flagSource);
  writeFileSync(path.join(symbolRoot, "Device.kicad_sym"), ordinarySource);
  for (const name of ["F1", "F2"]) writeFileSync(path.join(footprintRoot, "Parts.pretty", `${name}.kicad_mod`), footprintSource(name));
  const options = { symbolRoot, footprintRoot, exactSymbolIds: ["power:PWR_FLAG"], exactFootprintIds: [],
    stockSymbolNicknames: ["Device", "power"], stockFootprintNicknames: ["Parts"] };
  return { root, file, options };
}
function observeDecodedSources() {
  const original = TextDecoder.prototype.decode, values: string[] = [];
  vi.spyOn(TextDecoder.prototype, "decode").mockImplementation(function (this: TextDecoder, input, options) {
    const value = original.call(this, input, options); values.push(value); return value;
  });
  return values;
}
function replaceWithRestoredTime(file: string, source: string) {
  const before = statSync(file); writeFileSync(file, source); utimesSync(file, before.atime, before.mtime);
}

describe("bounded PWR_FLAG raw syntax reuse", () => {
  it("removes all three repeated parses while retaining both guarded reads and fresh immutable inspections", () => {
    const f = fixture(), resolver = createKiCad10StockLibraryResolver(f.options), decoded = observeDecodedSources();
    const first = resolver.inspectExternalPowerFlag()!, second = resolver.inspectExternalPowerFlag()!;
    expect(second).toEqual(first); expect(second).not.toBe(first);
    expect(observed.reads.get(f.file)).toBe(4);
    expect(decoded.filter(value => value === flagSource)).toHaveLength(2);
    expect(observed.geometryParses).toBe(1); expect(observed.semanticParses).toBe(1);
    expect(Object.isFrozen(second.geometry)).toBe(true);
    expect(Reflect.set(first.geometry.representations[0]!, "unit", 99)).toBe(false);
    expect(Reflect.set(first.definitionSemanticIdentity, "digest", "0".repeat(64))).toBe(false);
    expect(resolver.inspectExternalPowerFlag()).toEqual(first);
    expect(observed.reads.get(f.file)).toBe(6); expect(observed.geometryParses).toBe(1);
  });

  it("reuses the role syntax across catalog selection replacement without admitting signed ordinary symbols", () => {
    const f = fixture(), catalog = createKiCad10StockCatalog(f.options), first = catalog.inspectExternalPowerFlag();
    for (let i = 0; i < 3; i++) {
      expect(catalog.inspectSymbol("Device:R")).not.toBeNull();
      expect(catalog.inspectExternalPowerFlag()).toEqual(first);
    }
    expect(observed.geometryParses).toBe(1); expect(observed.semanticParses).toBe(1);
    expect(observed.reads.get(f.file)).toBe(8);
    expect(() => catalog.inspectSymbol("power:PWR_FLAG")).toThrow(/symbol names/u);
    expect(catalog.inspectSymbol("power:+3V3")).toBeNull();
  });

  it("reparses changed same-size bytes despite restored mtime and refuses changed role semantics", () => {
    const f = fixture(), resolver = createKiCad10StockLibraryResolver(f.options), before = resolver.inspectExternalPowerFlag()!;
    replaceWithRestoredTime(f.file, flagSource.replace('"pwr"', '"PWR"'));
    const after = resolver.inspectExternalPowerFlag()!;
    expect(after.sourceIdentity).not.toEqual(before.sourceIdentity);
    expect(after.geometry.representations.flatMap(value => value.pins)[0]!.name).toBe("PWR");
    expect(observed.geometryParses).toBe(2);
    replaceWithRestoredTime(f.file, flagSource.replace('(number "1"', '(number "2"'));
    expect(() => resolver.inspectExternalPowerFlag()).toThrow(/power annotation semantics/u);
  });

  it("rechecks final bytes after a warm cache hit and recovers only through a fresh later inspection", () => {
    const f = fixture(), resolver = createKiCad10StockLibraryResolver(f.options); resolver.inspectExternalPowerFlag();
    observed.closed = file => {
      if (file !== f.file) return;
      observed.closed = undefined;
      replaceWithRestoredTime(f.file, flagSource.replace('"pwr"', '"PWR"'));
    };
    expect(() => resolver.inspectExternalPowerFlag()).toThrow(/changed during role capture/u);
    expect(observed.geometryParses).toBe(1); expect(observed.reads.get(f.file)).toBe(4);
    expect(resolver.inspectExternalPowerFlag()!.sourceIdentity).toEqual(contentIdentity(readFileSync(f.file)));
    expect(observed.geometryParses).toBe(2); expect(observed.descriptors.size).toBe(0);
  });

  it("rejects replacement of a warm source root by a junction", () => {
    const f = fixture(), resolver = createKiCad10StockLibraryResolver(f.options); resolver.inspectExternalPowerFlag();
    const old = `${f.options.symbolRoot}-old`; renameSync(f.options.symbolRoot, old);
    symlinkSync(old, f.options.symbolRoot, process.platform === "win32" ? "junction" : "dir");
    try { expect(() => resolver.inspectExternalPowerFlag()).toThrow(); expect(observed.geometryParses).toBe(1); }
    finally { unlinkSync(f.options.symbolRoot); }
  });

  it("keeps nested independent captures fresh without double-counting parser storage", () => {
    const f = fixture(), resolver = createKiCad10StockLibraryResolver(f.options); let closes = 0;
    let nested: ReturnType<typeof resolver.inspectExternalPowerFlag> | undefined;
    observed.closed = file => {
      if (file !== f.file || ++closes !== 2) return;
      observed.closed = undefined;
      nested = resolver.inspectExternalPowerFlag();
    };
    const outer = resolver.inspectExternalPowerFlag();
    expect(outer).toEqual(nested); expect(outer).not.toBe(nested);
    expect(observed.reads.get(f.file)).toBe(4);
    expect(resolver.cacheSnapshot()).toMatchObject({ parsedSymbolFileCount: 1, cachedSourceBytes: Buffer.byteLength(flagSource) });
    expect(observed.geometryParses).toBe(2); expect(observed.semanticParses).toBe(2);
    expect(resolver.inspectExternalPowerFlag()).toEqual(outer);
    expect(observed.reads.get(f.file)).toBe(6); expect(observed.geometryParses).toBe(2);
  });

  it("separates role policy, parser limits, and roots while retaining admission checks", () => {
    const a = fixture(), b = fixture(), storage = createKiCadStockSyntaxCache();
    const first = createKiCad10StockLibraryResolver(a.options, storage).inspectExternalPowerFlag()!;
    const changed = createKiCad10StockLibraryResolver({ ...a.options, exactSymbolIds: ["power:PWR_FLAG", "power:GND"] }, storage).inspectExternalPowerFlag()!;
    expect(changed.policyIdentity).not.toEqual(first.policyIdentity); expect(observed.geometryParses).toBe(2);
    expect(createKiCad10StockLibraryResolver(b.options, storage).inspectExternalPowerFlag()).not.toBeNull();
    expect(observed.geometryParses).toBe(3);
    const strict = createKiCad10StockLibraryResolver({ ...a.options, limits: { maxSymbolDefinitions: 1 } }, storage);
    expect(() => strict.inspectExternalPowerFlag()).toThrow(/count/u);
    expect(createKiCad10StockLibraryResolver({ ...a.options, exactSymbolIds: [] }, storage).inspectExternalPowerFlag()).toBeNull();
    expect(createKiCad10StockLibraryResolver({ ...a.options, stockSymbolNicknames: ["Device"] }, storage).inspectExternalPowerFlag()).toBeNull();
    expect(observed.geometryParses).toBe(3);
  });

  it("keeps stock symbols and role syntax warm when a full cache must evict a footprint", () => {
    const f = fixture(), catalog = createKiCad10StockCatalog({ ...f.options, limits: { maxCachedFiles: 3, maxCachedSourceBytes: 64 * 1024 } });
    const selected = { symbolIds: ["Device:R"], footprintIds: ["Parts:F1", "Parts:F2"] }, decoded = observeDecodedSources();
    const before = catalog.captureSourceSelection(selected);
    for (let i = 0; i < 4; i++) {
      expect(catalog.inspectExternalPowerFlag()).not.toBeNull();
      expect(catalog.captureSourceSelection(selected)).toEqual(before);
      const snapshot = catalog.cacheSnapshot();
      expect(snapshot.parsedSymbolFileCount + snapshot.parsedFootprintFileCount).toBeLessThanOrEqual(3);
      expect(snapshot.cachedSourceBytes).toBeLessThanOrEqual(64 * 1024);
    }
    expect(decoded.filter(value => value === ordinarySource)).toHaveLength(1);
    expect(observed.geometryParses).toBe(1); expect(observed.semanticParses).toBe(1);
    expect(observed.reads.get(f.file)).toBe(8);
  });

  it("obeys tightened one-file and sub-source byte budgets", () => {
    const f = fixture(), one = createKiCad10StockCatalog({ ...f.options, limits: { maxCachedFiles: 1 } });
    one.inspectExternalPowerFlag(); one.inspectSymbol("Device:R"); one.inspectExternalPowerFlag();
    const snapshot = one.cacheSnapshot();
    expect(snapshot.parsedSymbolFileCount + snapshot.parsedFootprintFileCount).toBe(1);
    expect(observed.geometryParses).toBe(2);
    const uncached = createKiCad10StockLibraryResolver({ ...f.options, limits: { maxCachedSourceBytes: Buffer.byteLength(flagSource) - 1 } });
    uncached.inspectExternalPowerFlag(); uncached.inspectExternalPowerFlag();
    expect(observed.geometryParses).toBe(4); expect(uncached.cacheSnapshot().cachedSourceBytes).toBe(0);
  });
});
