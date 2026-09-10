import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  KiCadStockLibraryResolverError,
  createKiCad10StockLibraryResolver,
  type KiCad10StockLibraryResolverOptions
} from "../../src/harness/kicad-library-resolver.js";
import {
  normalizePcbResolvedFootprint,
  normalizePcbResolvedSymbol
} from "../../src/harness/pcb-design-compiler.js";

const LED_SYMBOL_IDS = Object.freeze([
  "Connector_Generic:Conn_01x02",
  "Device:R",
  "Device:C",
  "Device:LED"
]);

const LED_FOOTPRINT_IDS = Object.freeze([
  "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical",
  "Resistor_SMD:R_0603_1608Metric",
  "Capacitor_SMD:C_0603_1608Metric",
  "LED_SMD:LED_0603_1608Metric"
]);

const DIVIDER_IDS = Object.freeze({
  symbol: "Connector_Generic:Conn_01x03",
  footprint: "Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical"
});

const pin = (number: string, name: string, electricalType = "passive"): string => `
      (pin ${electricalType} line
        (at 0 0 0)
        (length 2.54)
        (name ${JSON.stringify(name)} (effects (font (size 1.27 1.27))))
        (number ${JSON.stringify(number)} (effects (font (size 1.27 1.27)))))`;

const symbol = (
  name: string,
  reference: string,
  pins: readonly string[],
  options: { readonly keywords?: string; readonly filters?: string; readonly unit?: number } = {}
): string => {
  const unit = options.unit ?? 1;
  return `
  (symbol ${JSON.stringify(name)}
    (property "Reference" ${JSON.stringify(reference)} (at 0 0 0))
    (property "Value" ${JSON.stringify(name)} (at 0 0 0))
    (property "ki_keywords" ${JSON.stringify(options.keywords ?? "")} (at 0 0 0))
    (property "ki_fp_filters" ${JSON.stringify(options.filters ?? "")} (at 0 0 0))
    (symbol ${JSON.stringify(`${name}_${unit}_1`)}${pins.join("")}))`;
};

const library = (definitions: readonly string[]): string => `(kicad_symbol_lib
  (version 20231120)
  (generator "evleda-test")
  (generator_version "10.0")${definitions.join("")})\n`;

const footprint = (
  name: string,
  padNumbers: readonly string[],
  options: {
    readonly side?: "F.Cu" | "B.Cu";
    readonly courtyard?: boolean;
    readonly fabrication?: boolean;
  } = {}
): string => {
  const side = options.side ?? "F.Cu";
  const prefix = side === "F.Cu" ? "F" : "B";
  const drawings = [
    options.courtyard === false ? "" : `\n  (fp_rect (start -2 -2) (end 2 2) (stroke (width 0.05) (type solid)) (fill none) (layer "${prefix}.CrtYd"))`,
    options.fabrication === false ? "" : `\n  (fp_rect (start -1 -1) (end 1 1) (stroke (width 0.1) (type solid)) (fill none) (layer "${prefix}.Fab"))`
  ].join("");
  const pads = padNumbers.map((number, index) => `
  (pad ${JSON.stringify(number)} smd rect
    (at ${index} 0)
    (size 1 1)
    (layers ${JSON.stringify(side)} ${JSON.stringify(`${prefix}.Mask`)} ${JSON.stringify(`${prefix}.Paste`)}))`).join("");
  return `(footprint ${JSON.stringify(name)}
  (version 20240108)
  (generator "evleda-test")
  (layer ${JSON.stringify(side)})${drawings}${pads})\n`;
};

interface Fixture {
  readonly root: string;
  readonly symbols: string;
  readonly footprints: string;
}

const temporaryRoots: string[] = [];

const writeLibrary = (root: string, nickname: string, source: string): void => {
  writeFileSync(join(root, `${nickname}.kicad_sym`), source, "utf8");
};

const writeFootprint = (root: string, nickname: string, name: string, source: string): void => {
  const directory = join(root, `${nickname}.pretty`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.kicad_mod`), source, "utf8");
};

const createFixture = (): Fixture => {
  const root = mkdtempSync(join(tmpdir(), "evleda-library-resolver-"));
  temporaryRoots.push(root);
  const symbols = join(root, "symbols");
  const footprints = join(root, "footprints");
  mkdirSync(symbols);
  mkdirSync(footprints);
  writeLibrary(symbols, "Device", library([
    symbol("R", "R", [pin("1", ""), pin("2", "")]),
    symbol("C", "C", [pin("1", ""), pin("2", "")]),
    symbol("LED", "D", [pin("1", "K"), pin("2", "A")], { keywords: "LED diode" }),
    `
  (symbol "Alias"
    (extends "R")
    (property "Reference" "R" (at 0 0 0)))`,
    `
  (symbol "Dual"
    (property "Reference" "U" (at 0 0 0))
    (property "Value" "Dual" (at 0 0 0))
    (symbol "Dual_1_1"${pin("1", "A")}${pin("2", "B")})
    (symbol "Dual_2_1"${pin("3", "C")}${pin("4", "D")}))`
  ]));
  writeLibrary(symbols, "Connector_Generic", library([
    symbol("Conn_01x02", "J", [pin("1", "Pin_1"), pin("2", "Pin_2")], { keywords: "connector" }),
    symbol("Conn_01x03", "J", [pin("1", "Pin_1"), pin("2", "Pin_2"), pin("3", "Pin_3")], { keywords: "connector" })
  ]));
  writeLibrary(symbols, "Project_Custom", library([
    symbol("Part", "U", [pin("1", "A"), pin("2", "B")])
  ]));

  writeFootprint(footprints, "Connector_PinHeader_2.54mm", "PinHeader_1x02_P2.54mm_Vertical", footprint("PinHeader_1x02_P2.54mm_Vertical", ["1", "2"]));
  writeFootprint(footprints, "Connector_PinHeader_2.54mm", "PinHeader_1x03_P2.54mm_Vertical", footprint("PinHeader_1x03_P2.54mm_Vertical", ["1", "2", "3"]));
  writeFootprint(footprints, "Resistor_SMD", "R_0603_1608Metric", footprint("R_0603_1608Metric", ["1", "2"]));
  writeFootprint(footprints, "Capacitor_SMD", "C_0603_1608Metric", footprint("C_0603_1608Metric", ["1", "2"]));
  writeFootprint(footprints, "LED_SMD", "LED_0603_1608Metric", footprint("LED_0603_1608Metric", ["1", "2"]));
  writeFootprint(footprints, "Mismatch", "OnePad", footprint("OnePad", ["1"]));
  writeFootprint(footprints, "Project_Custom", "Part", footprint("Part", ["1", "2"]));
  return { root, symbols, footprints };
};

const resolverOptions = (
  fixture: Fixture,
  override: Partial<KiCad10StockLibraryResolverOptions> = {}
): KiCad10StockLibraryResolverOptions => ({
  symbolRoot: fixture.symbols,
  footprintRoot: fixture.footprints,
  exactSymbolIds: [...LED_SYMBOL_IDS, DIVIDER_IDS.symbol, "Device:Missing", "Device:Alias", "Device:Dual", "Project_Custom:Part"],
  exactFootprintIds: [...LED_FOOTPRINT_IDS, DIVIDER_IDS.footprint, "Mismatch:OnePad", "Project_Custom:Part"],
  stockSymbolNicknames: ["Device", "Connector_Generic"],
  stockFootprintNicknames: ["Connector_PinHeader_2.54mm", "Resistor_SMD", "Capacitor_SMD", "LED_SMD", "Mismatch"],
  ...override
});

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("KiCad 10 stock-library resolver", () => {
  it("resolves all exact LED IDs and the three-pin resistor-divider connector", () => {
    const fixture = createFixture();
    const resolver = createKiCad10StockLibraryResolver(resolverOptions(fixture));

    for (const id of LED_SYMBOL_IDS) {
      const record = resolver.resolveSymbol(id);
      expect(record).not.toBeNull();
      expect(normalizePcbResolvedSymbol(record, id)).toEqual(record);
      expect(Reflect.ownKeys(record!)).toEqual(["libraryId", "source", "unitCount", "componentKind", "polarized", "pins"]);
    }
    for (const id of LED_FOOTPRINT_IDS) {
      const record = resolver.resolveFootprint(id);
      expect(record).not.toBeNull();
      expect(normalizePcbResolvedFootprint(record, id)).toEqual(record);
      expect(Reflect.ownKeys(record!)).toEqual(["libraryId", "source", "packageKind", "pads"]);
    }

    expect(resolver.resolveSymbol(DIVIDER_IDS.symbol)).toMatchObject({
      libraryId: DIVIDER_IDS.symbol,
      source: "kicad-stock",
      unitCount: 1,
      componentKind: "connector",
      pins: [{ number: "1" }, { number: "2" }, { number: "3" }]
    });
    expect(resolver.resolveFootprint(DIVIDER_IDS.footprint)?.pads).toEqual(["1", "2", "3"]);
    expect(resolver.inspectPair(DIVIDER_IDS.symbol, DIVIDER_IDS.footprint)?.exactPinPadMatch).toBe(true);
  });

  it("extracts exact unit, pin-function, polarity, side, courtyard, fabrication, and pad evidence", () => {
    const fixture = createFixture();
    const resolver = createKiCad10StockLibraryResolver(resolverOptions(fixture));
    const led = resolver.inspectSymbol("Device:LED")!;
    expect(led.units).toEqual([{ unitNumber: 1, bodyStyles: [1], pinNumbers: ["1", "2"] }]);
    expect(led.pins).toEqual([
      { number: "1", name: "K", electricalType: "passive", graphicalShape: "line", unitNumbers: [1] },
      { number: "2", name: "A", electricalType: "passive", graphicalShape: "line", unitNumbers: [1] }
    ]);
    expect(led.polarity).toEqual({ polarized: true, basis: "recognized_pin_functions", functions: ["A", "K"] });
    expect(led.resolverRecord.polarized).toBe(true);

    const footprintRecord = resolver.inspectFootprint("LED_SMD:LED_0603_1608Metric")!;
    expect(footprintRecord.side).toBe("front");
    expect(footprintRecord.courtyard).toEqual({ front: true, back: false, availableForSide: true });
    expect(footprintRecord.fabrication).toEqual({ front: true, back: false, availableForSide: true });
    expect(footprintRecord.pads).toEqual([
      { number: "1", padType: "smd", shape: "rect", copperSides: ["front"] },
      { number: "2", padType: "smd", shape: "rect", copperSides: ["front"] }
    ]);
    expect(Object.isFrozen(footprintRecord)).toBe(true);
    expect(Object.isFrozen(footprintRecord.pads[0])).toBe(true);
  });

  it("reports back-side and absent documentation layers without inventing availability", () => {
    const fixture = createFixture();
    writeFootprint(fixture.footprints, "Back_Stock", "BackPart", footprint("BackPart", ["1", "2"], {
      side: "B.Cu",
      courtyard: false,
      fabrication: false
    }));
    const resolver = createKiCad10StockLibraryResolver(resolverOptions(fixture, {
      exactFootprintIds: ["Back_Stock:BackPart"],
      stockFootprintNicknames: ["Back_Stock"]
    }));
    expect(resolver.inspectFootprint("Back_Stock:BackPart")).toMatchObject({
      side: "back",
      courtyard: { front: false, back: false, availableForSide: false },
      fabrication: { front: false, back: false, availableForSide: false },
      pads: [
        { number: "1", copperSides: ["back"] },
        { number: "2", copperSides: ["back"] }
      ]
    });
  });

  it("returns null for missing IDs, non-allowlisted requests, and project-custom nicknames", () => {
    const fixture = createFixture();
    const resolver = createKiCad10StockLibraryResolver(resolverOptions(fixture));
    expect(resolver.resolveSymbol("Device:Missing")).toBeNull();
    expect(resolver.resolveSymbol("Device:NotInContract")).toBeNull();
    expect(resolver.resolveFootprint("LED_SMD:NotInContract")).toBeNull();
    expect(resolver.resolveSymbol("Project_Custom:Part")).toBeNull();
    expect(resolver.resolveFootprint("Project_Custom:Part")).toBeNull();
  });

  it("rejects path syntax at configuration and never resolves path-like calls", () => {
    const fixture = createFixture();
    expect(() => createKiCad10StockLibraryResolver(resolverOptions(fixture, {
      exactSymbolIds: ["../Device:R"]
    }))).toThrowError(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
    const resolver = createKiCad10StockLibraryResolver(resolverOptions(fixture));
    for (const id of ["../Device:R", "Device:../R", "Device:R/../../x", "Device:R:extra", "Device\\R:R"]) {
      expect(resolver.resolveSymbol(id)).toBeNull();
    }
  });

  it("rejects aliases/derived symbols while representing bounded multi-unit symbols exactly", () => {
    const fixture = createFixture();
    const resolver = createKiCad10StockLibraryResolver(resolverOptions(fixture));
    expect(() => resolver.inspectSymbol("Device:Alias")).toThrowError(expect.objectContaining({
      code: "DERIVED_SYMBOL_UNSUPPORTED",
      logicalAsset: "Device:Alias"
    }));

    const dual = resolver.inspectSymbol("Device:Dual")!;
    expect(dual.resolverRecord.unitCount).toBe(2);
    expect(dual.units).toEqual([
      { unitNumber: 1, bodyStyles: [1], pinNumbers: ["1", "2"] },
      { unitNumber: 2, bodyStyles: [1], pinNumbers: ["3", "4"] }
    ]);
    expect(normalizePcbResolvedSymbol(dual.resolverRecord, "Device:Dual")).toEqual(dual.resolverRecord);
  });

  it("rejects a symlinked footprint library that escapes the configured root", () => {
    const fixture = createFixture();
    const outside = join(fixture.root, "outside.pretty");
    mkdirSync(outside);
    writeFileSync(join(outside, "Outside.kicad_mod"), footprint("Outside", ["1", "2"]), "utf8");
    symlinkSync(outside, join(fixture.footprints, "Escaped.pretty"), process.platform === "win32" ? "junction" : "dir");
    const resolver = createKiCad10StockLibraryResolver(resolverOptions(fixture, {
      exactFootprintIds: ["Escaped:Outside"],
      stockFootprintNicknames: ["Escaped"]
    }));
    expect(() => resolver.inspectFootprint("Escaped:Outside")).toThrowError(expect.objectContaining({ code: "PATH_REJECTED" }));
  });

  it("rejects a linked root instead of treating its target as a canonical stock root", () => {
    const fixture = createFixture();
    const linkedRoot = join(fixture.root, "linked-symbols");
    symlinkSync(fixture.symbols, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    expect(() => createKiCad10StockLibraryResolver(resolverOptions(fixture, {
      symbolRoot: linkedRoot
    }))).toThrowError(expect.objectContaining({ code: "ROOT_REJECTED" }));
  });

  it("fails closed on malformed and oversized source files", () => {
    const malformedFixture = createFixture();
    writeFileSync(join(malformedFixture.symbols, "Device.kicad_sym"), "(kicad_symbol_lib (version 20231120) (symbol \"R\"", "utf8");
    const malformed = createKiCad10StockLibraryResolver(resolverOptions(malformedFixture));
    expect(() => malformed.inspectSymbol("Device:R")).toThrowError(expect.objectContaining({ code: "MALFORMED_LIBRARY" }));

    const oversizedFixture = createFixture();
    const oversized = createKiCad10StockLibraryResolver(resolverOptions(oversizedFixture, {
      exactSymbolIds: ["Device:R"],
      limits: { maxSymbolFileBytes: 64 }
    }));
    expect(() => oversized.inspectSymbol("Device:R")).toThrowError(expect.objectContaining({ code: "FILE_TOO_LARGE" }));
  });

  it("reads distinct private-property names without consuming a quoted private name as a modifier", () => {
    const fixture = createFixture();
    writeLibrary(fixture.symbols, "Device", library([`
      (symbol "R"
        (property "Reference" "U" (at 0 0 0))
        (property "private" "ordinary property value" (at 0 0 0))
        (property private "KLC_S4.2_DVDD" "Digital core supply placement note." (at 0 0 0))
        (property private "KLC_S4.2_VREG_LX" "Place next to DVDD." (at 0 0 0))
        (symbol "R_1_1"${pin("1", "A")}${pin("2", "B")}))`
    ]));
    const resolver = createKiCad10StockLibraryResolver(resolverOptions(fixture));
    expect(resolver.resolveSymbol("Device:R")).toMatchObject({
      componentKind: "generic",
      unitCount: 1,
      pins: [{ number: "1", function: "A" }, { number: "2", function: "B" }]
    });
  });

  it.each([
    ['(property private "Reference" "J" (at 0 0 0))', "connector"],
    ['(property private "ki_keywords" "gpio" (at 0 0 0))', "gpio"],
    ['(property private "ki_fp_filters" "BGA" (at 0 0 0))', "bga"],
    ['(property Reference J (at 0 0 0))', "connector"]
  ])("preserves the actual property name and value in %s", (property, componentKind) => {
    const fixture = createFixture();
    writeLibrary(fixture.symbols, "Device", library([`
      (symbol "R" ${property}
        (symbol "R_1_1"${pin("1", "A")}${pin("2", "B")}))`
    ]));
    const resolver = createKiCad10StockLibraryResolver(resolverOptions(fixture));
    expect(resolver.resolveSymbol("Device:R")?.componentKind).toBe(componentKind);
  });

  it.each([
    '(property)',
    '(property "name")',
    '(property "name" "value" "extra")',
    '(property private)',
    '(property private "name")',
    '(property private "name" "value" "extra")',
    '(property private private "name" "value")',
    '(property public "name" "value")',
    '(property PRIVATE "name" "value")',
    '(property "private" "name" "value")',
    '(property "" "value")',
    '(property private "" "value")',
    '(property "bad\\tname" "value")',
    '(property private "bad\\tname" "value")',
    '(property "name" "bad\\tvalue")',
    '(property private "name" "bad\\tvalue")'
  ])("rejects malformed property arity or text without skipping %s", (property) => {
    const fixture = createFixture();
    writeLibrary(fixture.symbols, "Device", library([`
      (symbol "R" ${property}
        (symbol "R_1_1"${pin("1", "A")}${pin("2", "B")}))`
    ]));
    const resolver = createKiCad10StockLibraryResolver(resolverOptions(fixture));
    expect(() => resolver.inspectSymbol("Device:R")).toThrowError(expect.objectContaining({
      code: "MALFORMED_LIBRARY", logicalAsset: "Device:R"
    }));
  });

  it.each([
    ['(property "name" "same")', '(property "name" "same")'],
    ['(property private "name" "same")', '(property private "name" "same")'],
    ['(property "name" "first")', '(property private "name" "second")'],
    ['(property private "name" "first")', '(property "name" "second")'],
    ['(property "private" "first")', '(property private "private" "second")'],
    ['(property private "ki_keywords" "first")', '(property "ki_key\\words" "second")']
  ])("rejects duplicate real property names across %s and %s", (first, second) => {
    const fixture = createFixture();
    writeLibrary(fixture.symbols, "Device", library([`
      (symbol "R" ${first} ${second}
        (symbol "R_1_1"${pin("1", "A")}${pin("2", "B")}))`
    ]));
    const resolver = createKiCad10StockLibraryResolver(resolverOptions(fixture));
    expect(() => resolver.inspectSymbol("Device:R")).toThrowError(expect.objectContaining({
      code: "MALFORMED_LIBRARY", logicalAsset: "Device:R"
    }));
  });

  it("counts private properties against the unchanged property ceiling", () => {
    const fixture = createFixture();
    writeLibrary(fixture.symbols, "Device", library([`
      (symbol "R"
        (property "private" "ordinary")
        (property private "first" "note")
        (property private "second" "note")
        (symbol "R_1_1"${pin("1", "A")}${pin("2", "B")}))`
    ]));
    const resolver = createKiCad10StockLibraryResolver(resolverOptions(fixture, {
      limits: { maxPropertiesPerSymbol: 2 }
    }));
    expect(() => resolver.inspectSymbol("Device:R")).toThrowError(expect.objectContaining({
      code: "LIMIT_EXCEEDED", logicalAsset: "Device:R"
    }));
  });

  it("enforces parser depth, form-count, and token-text ceilings", () => {
    const depthFixture = createFixture();
    const depthResolver = createKiCad10StockLibraryResolver(resolverOptions(depthFixture, {
      exactSymbolIds: ["Device:R"],
      limits: { maxDepth: 3 }
    }));
    expect(() => depthResolver.inspectSymbol("Device:R")).toThrowError(expect.objectContaining({ code: "MALFORMED_LIBRARY" }));

    const countFixture = createFixture();
    const countResolver = createKiCad10StockLibraryResolver(resolverOptions(countFixture, {
      exactSymbolIds: ["Device:R"],
      limits: { maxForms: 8 }
    }));
    expect(() => countResolver.inspectSymbol("Device:R")).toThrowError(expect.objectContaining({ code: "MALFORMED_LIBRARY" }));

    const textFixture = createFixture();
    const textResolver = createKiCad10StockLibraryResolver(resolverOptions(textFixture, {
      exactSymbolIds: ["Device:R"],
      limits: { maxTextChars: 8 }
    }));
    expect(() => textResolver.inspectSymbol("Device:R")).toThrowError(expect.objectContaining({ code: "MALFORMED_LIBRARY" }));
  });

  it("reports exact pin-pad mismatch without coercing either library record", () => {
    const fixture = createFixture();
    const resolver = createKiCad10StockLibraryResolver(resolverOptions(fixture));
    const pair = resolver.inspectPair("Device:R", "Mismatch:OnePad")!;
    expect(pair.symbolPinNumbers).toEqual(["1", "2"]);
    expect(pair.footprintPadNumbers).toEqual(["1"]);
    expect(pair.exactPinPadMatch).toBe(false);
    expect(normalizePcbResolvedSymbol(resolver.resolveSymbol("Device:R"), "Device:R")).not.toBeNull();
    expect(normalizePcbResolvedFootprint(resolver.resolveFootprint("Mismatch:OnePad"), "Mismatch:OnePad")).not.toBeNull();
  });

  it("caches parsed files by content hash and produces path-free deterministic identities", () => {
    const fixture = createFixture();
    const firstResolver = createKiCad10StockLibraryResolver(resolverOptions(fixture));
    const first = firstResolver.inspectSymbol("Device:R")!;
    const repeated = firstResolver.inspectSymbol("Device:R")!;
    const sibling = firstResolver.inspectSymbol("Device:LED")!;
    expect(repeated).toBe(first);
    expect(sibling.sourceIdentity).toEqual(first.sourceIdentity);
    expect(firstResolver.cacheSnapshot()).toMatchObject({
      parsedSymbolFileCount: 1,
      parsedFootprintFileCount: 0
    });

    const secondResolver = createKiCad10StockLibraryResolver(resolverOptions(fixture));
    expect(secondResolver.inspectSymbol("Device:R")?.identity).toEqual(first.identity);
    const publicJson = JSON.stringify({ first, cache: firstResolver.cacheSnapshot() });
    expect(publicJson).not.toContain(fixture.root);
    expect(publicJson).not.toMatch(/[A-Za-z]:[\\/]/u);
    expect(publicJson).not.toContain("symbolRoot");
    expect(publicJson).not.toContain("canonicalPath");
  });

  it("keys both parsed and record caches to changed source content", () => {
    const fixture = createFixture();
    const resolver = createKiCad10StockLibraryResolver(resolverOptions(fixture));
    const before = resolver.inspectSymbol("Device:R")!;
    const path = join(fixture.symbols, "Device.kicad_sym");
    const original = library([
      symbol("R", "R", [pin("1", ""), pin("2", "")]),
      symbol("C", "C", [pin("1", ""), pin("2", "")]),
      symbol("LED", "D", [pin("1", "K"), pin("2", "A")]),
      `\n  (symbol "Alias" (extends "R") (property "Reference" "R" (at 0 0 0)))`,
      `\n  (symbol "Dual" (property "Reference" "U" (at 0 0 0)) (property "Value" "Dual" (at 0 0 0)) (symbol "Dual_1_1"${pin("1", "A")}${pin("2", "B")}) (symbol "Dual_2_1"${pin("3", "C")}${pin("4", "D")}))`
    ]);
    writeFileSync(path, `${original}\n`, "utf8");
    const after = resolver.inspectSymbol("Device:R")!;
    expect(after.sourceIdentity.digest).not.toBe(before.sourceIdentity.digest);
    expect(after.identity.digest).not.toBe(before.identity.digest);
    expect(after.resolverRecord).toEqual(before.resolverRecord);
    expect(resolver.cacheSnapshot().parsedSymbolFileCount).toBe(2);
  });

  it("rejects unknown or raised limit fields", () => {
    const fixture = createFixture();
    expect(() => createKiCad10StockLibraryResolver(resolverOptions(fixture, {
      limits: { maxDepth: 129 }
    }))).toThrowError(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
    expect(() => createKiCad10StockLibraryResolver(resolverOptions(fixture, {
      limits: { unexpected: 1 } as never
    }))).toThrowError(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
  });
});

const installedSymbolRoot = "D:\\Codex-Recovery\\KiCad\\10.0\\share\\kicad\\symbols";
const installedFootprintRoot = "D:\\Codex-Recovery\\KiCad\\10.0\\share\\kicad\\footprints";

it.runIf(existsSync(join(installedSymbolRoot, "MCU_RaspberryPi.kicad_sym")) && existsSync(installedFootprintRoot)).each([
  ["RP2350A", 61],
  ["RP2350B", 81]
] as const)("resolves installed stock %s private properties with every numbered pin in unit 1 read-only", (item, pinCount) => {
  const libraryId = `MCU_RaspberryPi:${item}`;
  const resolver = createKiCad10StockLibraryResolver({
    symbolRoot: installedSymbolRoot,
    footprintRoot: installedFootprintRoot,
    exactSymbolIds: [libraryId],
    exactFootprintIds: [],
    stockSymbolNicknames: ["MCU_RaspberryPi"],
    stockFootprintNicknames: []
  });
  const inspection = resolver.inspectSymbol(libraryId)!;
  const numbers = Array.from({ length: pinCount }, (_, index) => String(index + 1)).sort();
  expect(inspection).not.toBeNull();
  expect(inspection.resolverRecord.unitCount).toBe(1);
  expect(inspection.resolverRecord.pins.map((entry) => entry.number)).toEqual(numbers);
  expect(inspection.pins.map((entry) => entry.number)).toEqual(numbers);
  expect(inspection.units).toEqual([{ unitNumber: 1, bodyStyles: [0, 1], pinNumbers: numbers }]);
  expect(inspection.pins.every((entry) => entry.unitNumbers.length === 1 && entry.unitNumbers[0] === 1)).toBe(true);
  expect(inspection.pins.find((entry) => entry.number === String(pinCount))).toMatchObject({
    name: "GND", electricalType: "power_in", unitNumbers: [1]
  });
  expect(normalizePcbResolvedSymbol(inspection.resolverRecord, libraryId)).toEqual(inspection.resolverRecord);
});

it.runIf(existsSync(installedSymbolRoot) && existsSync(installedFootprintRoot))(
  "resolves the installed KiCad 10 stock assets for the LED and divider contracts read-only",
  () => {
    const exactSymbolIds = [...LED_SYMBOL_IDS, DIVIDER_IDS.symbol];
    const exactFootprintIds = [...LED_FOOTPRINT_IDS, DIVIDER_IDS.footprint];
    const resolver = createKiCad10StockLibraryResolver({
      symbolRoot: installedSymbolRoot,
      footprintRoot: installedFootprintRoot,
      exactSymbolIds,
      exactFootprintIds,
      stockSymbolNicknames: ["Device", "Connector_Generic"],
      stockFootprintNicknames: ["Connector_PinHeader_2.54mm", "Resistor_SMD", "Capacitor_SMD", "LED_SMD"]
    });
    for (const id of exactSymbolIds) expect(normalizePcbResolvedSymbol(resolver.resolveSymbol(id), id)).not.toBeNull();
    for (const id of exactFootprintIds) expect(normalizePcbResolvedFootprint(resolver.resolveFootprint(id), id)).not.toBeNull();
    expect(resolver.inspectSymbol("Device:LED")?.polarity).toMatchObject({ polarized: true, functions: ["A", "K"] });
    expect(resolver.inspectPair(DIVIDER_IDS.symbol, DIVIDER_IDS.footprint)?.exactPinPadMatch).toBe(true);
    expect(resolver.cacheSnapshot()).toMatchObject({ parsedSymbolFileCount: 2, parsedFootprintFileCount: 5 });
  },
  20_000
);

it("exports a path-redacted typed resolver error", () => {
  const error = new KiCadStockLibraryResolverError("MALFORMED_LIBRARY", "Device:R", "Device:R is malformed");
  expect(error).toMatchObject({ code: "MALFORMED_LIBRARY", logicalAsset: "Device:R" });
  expect(JSON.stringify(error)).not.toContain("path");
});
