import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { canonicalIdentity, contentIdentity } from "../core/canonical.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import { parseFreshSymbolLibraryTerminalGeometrySource, type FreshSymbolTerminalGeometry } from "./fresh-kicad-parser.js";
import { physicalPadDefinitionKey, type PcbPadDefinitionNode } from "./fresh-pcb-pad-model.js";
import {
  normalizePcbResolvedFootprint,
  normalizePcbResolvedSymbol,
  type PcbLibraryComponentKind,
  type PcbLibraryPackageKind,
  type PcbReadOnlyLibraryResolver,
  type PcbResolvedFootprint,
  type PcbResolvedSymbol
} from "./pcb-design-compiler.js";

export const KICAD_STOCK_SYMBOL_INSPECTION_SCHEMA_VERSION = "evleda.kicad-stock-symbol-inspection.v1" as const;
export const KICAD_STOCK_FOOTPRINT_INSPECTION_SCHEMA_VERSION = "evleda.kicad-stock-footprint-inspection.v2" as const;
export const KICAD_STOCK_LIBRARY_PAIR_SCHEMA_VERSION = "evleda.kicad-stock-library-pair.v1" as const;

/** Hard ceilings. Callers may only tighten these values. */
export const KICAD_STOCK_LIBRARY_RESOLVER_LIMITS = Object.freeze({
  maxExactSymbolIds: 64,
  maxExactFootprintIds: 64,
  maxStockNicknames: 2_048,
  maxDirectoryEntries: 20_000,
  maxSymbolFileBytes: 24 * 1024 * 1024,
  maxFootprintFileBytes: 512 * 1024,
  maxForms: 750_000,
  maxAtoms: 3_000_000,
  maxDepth: 128,
  maxTextChars: 16_384,
  maxSymbolDefinitions: 2_048,
  maxNestedSymbolsPerDefinition: 512,
  maxPropertiesPerSymbol: 256,
  maxPinsOrPads: 128,
  maxUnits: 128,
  maxCachedFiles: 16,
  maxCachedSourceBytes: 64 * 1024 * 1024,
  maxCachedRecords: 256
});

export type KiCadStockLibraryResolverErrorCode =
  | "INVALID_CONFIGURATION"
  | "ROOT_REJECTED"
  | "PATH_REJECTED"
  | "FILE_TOO_LARGE"
  | "MALFORMED_LIBRARY"
  | "DERIVED_SYMBOL_UNSUPPORTED"
  | "LIMIT_EXCEEDED"
  | "NORMALIZER_REJECTED";

export class KiCadStockLibraryResolverError extends Error {
  public constructor(
    public readonly code: KiCadStockLibraryResolverErrorCode,
    public readonly logicalAsset: string,
    message: string
  ) {
    super(message);
    this.name = "KiCadStockLibraryResolverError";
  }
}

export interface KiCadStockLibraryResolverLimits {
  readonly maxExactSymbolIds: number;
  readonly maxExactFootprintIds: number;
  readonly maxStockNicknames: number;
  readonly maxDirectoryEntries: number;
  readonly maxSymbolFileBytes: number;
  readonly maxFootprintFileBytes: number;
  readonly maxForms: number;
  readonly maxAtoms: number;
  readonly maxDepth: number;
  readonly maxTextChars: number;
  readonly maxSymbolDefinitions: number;
  readonly maxNestedSymbolsPerDefinition: number;
  readonly maxPropertiesPerSymbol: number;
  readonly maxPinsOrPads: number;
  readonly maxUnits: number;
  readonly maxCachedFiles: number;
  readonly maxCachedSourceBytes: number;
  readonly maxCachedRecords: number;
}

export interface KiCad10StockLibraryResolverOptions {
  /** Canonical, non-link KiCad 10 `symbols` directory. */
  readonly symbolRoot: string;
  /** Canonical, non-link KiCad 10 `footprints` directory. */
  readonly footprintRoot: string;
  /** Deduplicated exact IDs extracted from the bounded design contract/draft. */
  readonly exactSymbolIds: readonly string[];
  readonly exactFootprintIds: readonly string[];
  /** Host-owned stock nickname allowlists; project table aliases are not accepted. */
  readonly stockSymbolNicknames: readonly string[];
  readonly stockFootprintNicknames: readonly string[];
  /** Test/host callers may tighten, but never raise, a hard ceiling. */
  readonly limits?: Partial<KiCadStockLibraryResolverLimits>;
}

export type KiCadFootprintSide = "front" | "back";

export interface KiCadStockSymbolPinInspection {
  readonly number: string;
  readonly name: string | null;
  readonly electricalType: string;
  readonly graphicalShape: string;
  readonly unitNumbers: readonly number[];
}

export interface KiCadStockSymbolUnitInspection {
  readonly unitNumber: number;
  readonly bodyStyles: readonly number[];
  readonly pinNumbers: readonly string[];
}

export interface KiCadStockSymbolInspection {
  readonly schemaVersion: typeof KICAD_STOCK_SYMBOL_INSPECTION_SCHEMA_VERSION;
  readonly libraryId: string;
  readonly sourceIdentity: ContentIdentity;
  readonly units: readonly KiCadStockSymbolUnitInspection[];
  readonly pins: readonly KiCadStockSymbolPinInspection[];
  readonly polarity: {
    readonly polarized: boolean;
    readonly basis: "recognized_pin_functions" | "none";
    readonly functions: readonly string[];
  };
  /** Exact projection accepted by `normalizePcbResolvedSymbol`. */
  readonly resolverRecord: PcbResolvedSymbol;
  readonly identity: CanonicalIdentity;
}

export interface KiCadStockFootprintPadInspection {
  readonly number: string;
  readonly padType: string;
  readonly shape: string;
  readonly copperSides: readonly KiCadFootprintSide[];
}

/** Every physical library pad form, including unnumbered paste/mechanical features. */
export interface KiCadStockFootprintPhysicalPadInspection {
  readonly ordinal: number;
  readonly number: string;
  readonly padType: string;
  readonly shape: string;
  readonly layers: readonly string[];
  readonly copperSides: readonly KiCadFootprintSide[];
  readonly role: "numbered-copper" | "paste-aperture" | "uncharacterized-non-electrical";
  readonly definition: PcbPadDefinitionNode;
  readonly definitionKey: string;
  readonly at: Readonly<{ readonly xMm: number; readonly yMm: number; readonly rotationDeg: number }>;
}

export interface KiCadStockFootprintInspection {
  readonly schemaVersion: typeof KICAD_STOCK_FOOTPRINT_INSPECTION_SCHEMA_VERSION;
  readonly libraryId: string;
  readonly sourceIdentity: ContentIdentity;
  readonly side: KiCadFootprintSide;
  readonly courtyard: {
    readonly front: boolean;
    readonly back: boolean;
    readonly availableForSide: boolean;
  };
  readonly fabrication: {
    readonly front: boolean;
    readonly back: boolean;
    readonly availableForSide: boolean;
  };
  readonly pads: readonly KiCadStockFootprintPadInspection[];
  /** Logical summaries above do not imply same-number copper continuity. */
  readonly physicalPads: readonly KiCadStockFootprintPhysicalPadInspection[];
  readonly terminalPhysicalPadOrdinals: Readonly<Record<string, readonly number[]>>;
  readonly copperCommon: "not-assessed";
  /** Exact projection accepted by `normalizePcbResolvedFootprint`. */
  readonly resolverRecord: PcbResolvedFootprint;
  readonly identity: CanonicalIdentity;
}

export interface KiCadStockLibraryPairInspection {
  readonly schemaVersion: typeof KICAD_STOCK_LIBRARY_PAIR_SCHEMA_VERSION;
  readonly symbolIdentity: CanonicalIdentity;
  readonly footprintIdentity: CanonicalIdentity;
  readonly symbolPinNumbers: readonly string[];
  readonly footprintPadNumbers: readonly string[];
  readonly exactPinPadMatch: boolean;
  readonly identity: CanonicalIdentity;
}

export interface KiCadStockLibraryCacheSnapshot {
  readonly parsedSymbolFileCount: number;
  readonly parsedFootprintFileCount: number;
  readonly cachedSourceBytes: number;
  readonly symbolSourceIdentities: readonly ContentIdentity[];
  readonly footprintSourceIdentities: readonly ContentIdentity[];
}

interface Atom {
  readonly value: string;
  readonly quoted: boolean;
}

interface SNode {
  readonly name: string;
  readonly values: readonly Atom[];
  readonly children: readonly SNode[];
}

interface ParsedSymbolLibrary {
  readonly kind: "symbol";
  readonly definitions: ReadonlyMap<string, SNode>;
}

interface ParsedFootprintLibrary {
  readonly kind: "footprint";
  readonly footprint: SNode;
}

type ParsedLibrary = ParsedSymbolLibrary | ParsedFootprintLibrary;

interface CachedParsedLibrary {
  readonly identity: ContentIdentity;
  readonly parsed: ParsedLibrary;
}

interface RootBinding {
  readonly canonicalPath: string;
  readonly device: number | bigint;
  readonly inode: number | bigint;
}

interface LocatedAsset {
  readonly logicalAsset: string;
  readonly canonicalPath: string;
  readonly parentPath: string;
  readonly maximumBytes: number;
}

interface LoadedAsset {
  readonly bytes: Buffer;
  readonly identity: ContentIdentity;
}

const LIBRARY_PART = /^[A-Za-z0-9][A-Za-z0-9_.+@~-]{0,127}$/u;
const PIN_OR_PAD = /^[A-Za-z0-9][A-Za-z0-9.+/_-]{0,31}$/u;
const INTEGER = /^(?:0|[1-9][0-9]*)$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const ELECTRICAL_TYPES = new Set([
  "input", "output", "bidirectional", "tri_state", "passive", "free", "unspecified",
  "power_in", "power_out", "open_collector", "open_emitter", "no_connect"
]);

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const compareNumber = (left: number, right: number): number => left - right;

const deepFreeze = <Value>(value: Value): Value => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const resolverError = (
  code: KiCadStockLibraryResolverErrorCode,
  logicalAsset: string,
  message: string
): never => {
  throw new KiCadStockLibraryResolverError(code, logicalAsset, message);
};

const safeLogical = (value: string): string =>
  value.length <= 192 && !CONTROL.test(value) ? value : "library asset";

const validateLibraryPart = (value: unknown): value is string =>
  typeof value === "string"
  && value !== "."
  && value !== ".."
  && LIBRARY_PART.test(value)
  && !CONTROL.test(value);

const parseLibraryId = (value: unknown): readonly [string, string] | null => {
  if (typeof value !== "string" || value.length > 192 || CONTROL.test(value)) return null;
  const colon = value.indexOf(":");
  if (colon <= 0 || colon !== value.lastIndexOf(":")) return null;
  const nickname = value.slice(0, colon);
  const item = value.slice(colon + 1);
  return validateLibraryPart(nickname) && validateLibraryPart(item) ? [nickname, item] : null;
};

const samePath = (left: string, right: string): boolean =>
  process.platform === "win32" ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US") : left === right;

const containedBy = (root: string, child: string): boolean => {
  const difference = relative(root, child);
  return difference.length > 0 && !difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference);
};

const samePhysicalFile = (
  left: { readonly dev: number | bigint; readonly ino: number | bigint },
  right: { readonly dev: number | bigint; readonly ino: number | bigint }
): boolean => left.dev === right.dev && left.ino === right.ino;

const bindRoot = (input: string, label: string): RootBinding => {
  if (typeof input !== "string" || input.length === 0 || CONTROL.test(input) || !isAbsolute(input)) {
    return resolverError("INVALID_CONFIGURATION", label, `${label} must be an absolute canonical directory.`);
  }
  const requested = resolve(input);
  try {
    const linkState = lstatSync(requested, { bigint: true });
    if (linkState.isSymbolicLink() || !linkState.isDirectory()) {
      return resolverError("ROOT_REJECTED", label, `${label} must be a non-link directory.`);
    }
    const canonicalPath = realpathSync.native(requested);
    if (!samePath(requested, canonicalPath)) {
      return resolverError("ROOT_REJECTED", label, `${label} must already be canonical and must not traverse links.`);
    }
    const state = statSync(canonicalPath, { bigint: true });
    if (!state.isDirectory()) return resolverError("ROOT_REJECTED", label, `${label} is not a directory.`);
    return { canonicalPath, device: state.dev, inode: state.ino };
  } catch (error) {
    if (error instanceof KiCadStockLibraryResolverError) throw error;
    return resolverError("ROOT_REJECTED", label, `${label} could not be bound to a stable canonical directory.`);
  }
};

const assertStableRoot = (root: RootBinding, label: string): void => {
  try {
    const linkState = lstatSync(root.canonicalPath, { bigint: true });
    const current = statSync(root.canonicalPath, { bigint: true });
    const real = realpathSync.native(root.canonicalPath);
    if (
      linkState.isSymbolicLink()
      || !current.isDirectory()
      || current.dev !== root.device
      || current.ino !== root.inode
      || !samePath(real, root.canonicalPath)
    ) resolverError("PATH_REJECTED", label, `${label} changed after resolver creation.`);
  } catch (error) {
    if (error instanceof KiCadStockLibraryResolverError) throw error;
    resolverError("PATH_REJECTED", label, `${label} changed after resolver creation.`);
  }
};

const exactEntry = (
  directory: string,
  expectedName: string,
  expectedKind: "file" | "directory",
  logicalAsset: string,
  maximumEntries: number
): string | null => {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return resolverError("PATH_REJECTED", logicalAsset, `The configured stock directory for ${logicalAsset} cannot be inspected.`);
  }
  if (entries.length > maximumEntries) {
    return resolverError("LIMIT_EXCEEDED", logicalAsset, `The configured stock directory for ${logicalAsset} has too many entries.`);
  }
  const matches = entries.filter((entry) => entry.name === expectedName);
  if (matches.length === 0) return null;
  if (matches.length !== 1) return resolverError("PATH_REJECTED", logicalAsset, `The stock path for ${logicalAsset} is ambiguous.`);
  const entry = matches[0]!;
  if (entry.isSymbolicLink() || (expectedKind === "file" ? !entry.isFile() : !entry.isDirectory())) {
    return resolverError("PATH_REJECTED", logicalAsset, `The stock path for ${logicalAsset} must be a non-link ${expectedKind}.`);
  }
  return join(directory, expectedName);
};

const locateSymbol = (
  root: RootBinding,
  nickname: string,
  logicalAsset: string,
  limits: KiCadStockLibraryResolverLimits
): LocatedAsset | null => {
  assertStableRoot(root, "symbol root");
  const path = exactEntry(root.canonicalPath, `${nickname}.kicad_sym`, "file", logicalAsset, limits.maxDirectoryEntries);
  return path === null ? null : {
    logicalAsset,
    canonicalPath: path,
    parentPath: root.canonicalPath,
    maximumBytes: limits.maxSymbolFileBytes
  };
};

const locateFootprint = (
  root: RootBinding,
  nickname: string,
  item: string,
  logicalAsset: string,
  limits: KiCadStockLibraryResolverLimits
): LocatedAsset | null => {
  assertStableRoot(root, "footprint root");
  const libraryDirectory = exactEntry(
    root.canonicalPath,
    `${nickname}.pretty`,
    "directory",
    logicalAsset,
    limits.maxDirectoryEntries
  );
  if (libraryDirectory === null) return null;
  let canonicalLibraryDirectory: string;
  try {
    canonicalLibraryDirectory = realpathSync.native(libraryDirectory);
    if (!samePath(canonicalLibraryDirectory, libraryDirectory) || !containedBy(root.canonicalPath, canonicalLibraryDirectory)) {
      return resolverError("PATH_REJECTED", logicalAsset, `The stock footprint library for ${logicalAsset} leaves the configured root.`);
    }
  } catch (error) {
    if (error instanceof KiCadStockLibraryResolverError) throw error;
    return resolverError("PATH_REJECTED", logicalAsset, `The stock footprint library for ${logicalAsset} cannot be inspected safely.`);
  }
  const path = exactEntry(
    canonicalLibraryDirectory,
    `${item}.kicad_mod`,
    "file",
    logicalAsset,
    limits.maxDirectoryEntries
  );
  return path === null ? null : {
    logicalAsset,
    canonicalPath: path,
    parentPath: canonicalLibraryDirectory,
    maximumBytes: limits.maxFootprintFileBytes
  };
};

const loadAsset = (asset: LocatedAsset): LoadedAsset => {
  const logicalAsset = safeLogical(asset.logicalAsset);
  let before;
  try {
    before = lstatSync(asset.canonicalPath, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile()) {
      return resolverError("PATH_REJECTED", logicalAsset, `The stock asset for ${logicalAsset} must be a non-link regular file.`);
    }
    const canonical = realpathSync.native(asset.canonicalPath);
    if (!samePath(canonical, asset.canonicalPath) || !containedBy(asset.parentPath, canonical)) {
      return resolverError("PATH_REJECTED", logicalAsset, `The stock asset for ${logicalAsset} leaves its configured library directory.`);
    }
    if (before.size > BigInt(asset.maximumBytes)) {
      return resolverError("FILE_TOO_LARGE", logicalAsset, `The stock asset for ${logicalAsset} exceeds its byte limit.`);
    }
  } catch (error) {
    if (error instanceof KiCadStockLibraryResolverError) throw error;
    return resolverError("PATH_REJECTED", logicalAsset, `The stock asset for ${logicalAsset} cannot be inspected safely.`);
  }

  let descriptor: number | null = null;
  try {
    descriptor = openSync(asset.canonicalPath, "r");
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !samePhysicalFile(before, opened)) {
      return resolverError("PATH_REJECTED", logicalAsset, `The stock asset for ${logicalAsset} changed while it was opened.`);
    }
    if (opened.size > BigInt(asset.maximumBytes)) {
      return resolverError("FILE_TOO_LARGE", logicalAsset, `The stock asset for ${logicalAsset} exceeds its byte limit.`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(asset.canonicalPath, { bigint: true });
    const realAfter = realpathSync.native(asset.canonicalPath);
    if (
      bytes.byteLength !== Number(opened.size)
      || !samePhysicalFile(opened, after)
      || after.size !== opened.size
      || after.mtimeNs !== opened.mtimeNs
      || pathAfter.isSymbolicLink()
      || !samePhysicalFile(opened, pathAfter)
      || !samePath(realAfter, asset.canonicalPath)
      || !containedBy(asset.parentPath, realAfter)
    ) return resolverError("PATH_REJECTED", logicalAsset, `The stock asset for ${logicalAsset} changed while it was read.`);
    return { bytes, identity: contentIdentity(bytes) };
  } catch (error) {
    if (error instanceof KiCadStockLibraryResolverError) throw error;
    return resolverError("PATH_REJECTED", logicalAsset, `The stock asset for ${logicalAsset} could not be read safely.`);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
};

class BoundedSExpressionParser {
  #cursor = 0;
  #forms = 0;
  #atoms = 0;

  public constructor(
    private readonly source: string,
    private readonly limits: KiCadStockLibraryResolverLimits,
    private readonly logicalAsset: string
  ) {}

  public parseOne(): SNode {
    this.#space();
    const root = this.#node(1);
    this.#space();
    if (this.#cursor !== this.source.length) this.#malformed("Library must contain exactly one root form.");
    return root;
  }

  #malformed(message: string): never {
    return resolverError("MALFORMED_LIBRARY", this.logicalAsset, `${this.logicalAsset}: ${message}`);
  }

  #space(): void {
    while (this.#cursor < this.source.length && /\s/u.test(this.source[this.#cursor]!)) this.#cursor += 1;
  }

  #atom(): Atom {
    this.#atoms += 1;
    if (this.#atoms > this.limits.maxAtoms) this.#malformed("Atom count exceeds the configured limit.");
    if (this.source[this.#cursor] === '"') {
      this.#cursor += 1;
      let value = "";
      while (this.#cursor < this.source.length) {
        const character = this.source[this.#cursor++]!;
        if (character === '"') return { value, quoted: true };
        if (character === "\\") {
          if (this.#cursor >= this.source.length) this.#malformed("String escape is unterminated.");
          const escaped = this.source[this.#cursor++]!;
          value += escaped === "n" ? "\n" : escaped === "r" ? "\r" : escaped === "t" ? "\t" : escaped;
        } else value += character;
        if (value.length > this.limits.maxTextChars) this.#malformed("Text token exceeds the configured limit.");
      }
      return this.#malformed("Quoted string is unterminated.");
    }
    const start = this.#cursor;
    while (this.#cursor < this.source.length && !/[\s()]/u.test(this.source[this.#cursor]!)) {
      this.#cursor += 1;
      if (this.#cursor - start > this.limits.maxTextChars) this.#malformed("Atom exceeds the configured limit.");
    }
    if (this.#cursor === start) return this.#malformed("Expected an atom.");
    return { value: this.source.slice(start, this.#cursor), quoted: false };
  }

  #node(depth: number): SNode {
    if (depth > this.limits.maxDepth) this.#malformed("Nesting exceeds the configured limit.");
    if (this.source[this.#cursor] !== "(") this.#malformed("Expected a form.");
    this.#cursor += 1;
    this.#space();
    if (this.#cursor >= this.source.length || this.source[this.#cursor] === "(" || this.source[this.#cursor] === ")") {
      this.#malformed("Form has no name.");
    }
    const head = this.#atom();
    if (head.quoted || !validateLibraryPart(head.value)) this.#malformed("Form name is invalid.");
    this.#forms += 1;
    if (this.#forms > this.limits.maxForms) this.#malformed("Form count exceeds the configured limit.");
    const values: Atom[] = [];
    const children: SNode[] = [];
    while (true) {
      this.#space();
      if (this.#cursor >= this.source.length) this.#malformed(`Form ${head.value} is unterminated.`);
      if (this.source[this.#cursor] === ")") {
        this.#cursor += 1;
        return { name: head.value, values, children };
      }
      if (this.source[this.#cursor] === "(") children.push(this.#node(depth + 1));
      else values.push(this.#atom());
    }
  }
}

const decodeUtf8 = (bytes: Buffer, logicalAsset: string): string => {
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (source.length === 0 || source.includes("\u0000")) {
      return resolverError("MALFORMED_LIBRARY", logicalAsset, `${logicalAsset}: source text is empty or contains NUL.`);
    }
    return source;
  } catch (error) {
    if (error instanceof KiCadStockLibraryResolverError) throw error;
    return resolverError("MALFORMED_LIBRARY", logicalAsset, `${logicalAsset}: source is not valid UTF-8.`);
  }
};

const childrenNamed = (node: SNode, name: string): readonly SNode[] => node.children.filter((child) => child.name === name);

const uniqueChild = (node: SNode, name: string, logicalAsset: string, required = true): SNode | null => {
  const matches = childrenNamed(node, name);
  if (matches.length === 0 && !required) return null;
  if (matches.length !== 1) return resolverError("MALFORMED_LIBRARY", logicalAsset, `${logicalAsset}: expected exactly one ${name} field.`);
  return matches[0]!;
};

const scalar = (node: SNode, name: string, logicalAsset: string, required = true): string | null => {
  const field = uniqueChild(node, name, logicalAsset, required);
  if (field === null) return null;
  if (field.children.length !== 0 || field.values.length !== 1) {
    return resolverError("MALFORMED_LIBRARY", logicalAsset, `${logicalAsset}: ${name} must contain one scalar.`);
  }
  return field.values[0]!.value;
};

/** KiCad pin name/number fields carry nested rendering effects after one scalar. */
const decoratedScalar = (node: SNode, name: string, logicalAsset: string): string => {
  const field = uniqueChild(node, name, logicalAsset);
  if (field === null || field.values.length !== 1) {
    return resolverError("MALFORMED_LIBRARY", logicalAsset, `${logicalAsset}: ${name} must contain one scalar value.`);
  }
  return field.values[0]!.value;
};

const parseSymbolLibrary = (
  bytes: Buffer,
  logicalAsset: string,
  limits: KiCadStockLibraryResolverLimits
): ParsedSymbolLibrary => {
  const root = new BoundedSExpressionParser(decodeUtf8(bytes, logicalAsset), limits, logicalAsset).parseOne();
  if (root.name !== "kicad_symbol_lib" || root.values.length !== 0) {
    return resolverError("MALFORMED_LIBRARY", logicalAsset, `${logicalAsset}: expected a KiCad symbol-library root.`);
  }
  const version = scalar(root, "version", logicalAsset);
  if (version === null || !INTEGER.test(version)) {
    return resolverError("MALFORMED_LIBRARY", logicalAsset, `${logicalAsset}: symbol-library version is invalid.`);
  }
  const definitions = childrenNamed(root, "symbol");
  if (definitions.length === 0 || definitions.length > limits.maxSymbolDefinitions) {
    return resolverError("LIMIT_EXCEEDED", logicalAsset, `${logicalAsset}: symbol-definition count is unsupported.`);
  }
  const byName = new Map<string, SNode>();
  for (const definition of definitions) {
    const name = definition.values.length === 1 ? definition.values[0]!.value : null;
    if (name === null || !validateLibraryPart(name) || byName.has(name)) {
      return resolverError("MALFORMED_LIBRARY", logicalAsset, `${logicalAsset}: symbol names must be unique bounded identifiers.`);
    }
    byName.set(name, definition);
  }
  return { kind: "symbol", definitions: byName };
};

const parseFootprintLibrary = (
  bytes: Buffer,
  logicalAsset: string,
  limits: KiCadStockLibraryResolverLimits
): ParsedFootprintLibrary => {
  const root = new BoundedSExpressionParser(decodeUtf8(bytes, logicalAsset), limits, logicalAsset).parseOne();
  if (root.name !== "footprint" || root.values.length !== 1 || !validateLibraryPart(root.values[0]!.value)) {
    return resolverError("MALFORMED_LIBRARY", logicalAsset, `${logicalAsset}: expected one named KiCad footprint root.`);
  }
  const version = scalar(root, "version", logicalAsset);
  if (version === null || !INTEGER.test(version)) {
    return resolverError("MALFORMED_LIBRARY", logicalAsset, `${logicalAsset}: footprint version is invalid.`);
  }
  return { kind: "footprint", footprint: root };
};

const parsePositiveInteger = (value: string, logicalAsset: string, label: string, maximum: number): number => {
  if (!INTEGER.test(value)) return resolverError("MALFORMED_LIBRARY", logicalAsset, `${logicalAsset}: ${label} is invalid.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    return resolverError("LIMIT_EXCEEDED", logicalAsset, `${logicalAsset}: ${label} exceeds the configured limit.`);
  }
  return parsed;
};

interface MutablePin {
  readonly number: string;
  readonly name: string | null;
  readonly electricalType: string;
  readonly graphicalShape: string;
  readonly unitNumbers: Set<number>;
}

const cleanedPinName = (value: string): string | null => value.length === 0 || value === "~" ? null : value;

const polarityKey = (value: string): string => value.toLocaleLowerCase("en-US").replace(/[\s_-]+/gu, "");

const recognizedPolarity = (functions: readonly string[]): boolean => {
  const keys = new Set(functions.map(polarityKey));
  return (keys.has("a") && keys.has("k"))
    || (keys.has("anode") && keys.has("cathode"))
    || (keys.has("+") && keys.has("-"))
    || (keys.has("positive") && keys.has("negative"));
};

const propertyMap = (definition: SNode, logicalAsset: string, limits: KiCadStockLibraryResolverLimits): ReadonlyMap<string, string> => {
  const properties = childrenNamed(definition, "property");
  if (properties.length > limits.maxPropertiesPerSymbol) {
    return resolverError("LIMIT_EXCEEDED", logicalAsset, `${logicalAsset}: symbol property count is unsupported.`);
  }
  const result = new Map<string, string>();
  for (const property of properties) {
    // KiCad's unquoted private modifier precedes the real name/value pair.
    // A quoted "private" remains an ordinary property name, not a modifier.
    const first = property.values[0];
    const nameIndex = first?.value === "private" && !first.quoted ? 1 : 0;
    if (property.values.length !== nameIndex + 2) {
      return resolverError("MALFORMED_LIBRARY", logicalAsset, `${logicalAsset}: symbol property is malformed.`);
    }
    const name = property.values[nameIndex]!.value;
    const value = property.values[nameIndex + 1]!.value;
    if (name.length === 0 || CONTROL.test(name) || CONTROL.test(value) || result.has(name)) {
      return resolverError("MALFORMED_LIBRARY", logicalAsset, `${logicalAsset}: symbol properties must be unique bounded text.`);
    }
    result.set(name, value);
  }
  return result;
};

const classifySymbol = (
  nickname: string,
  item: string,
  properties: ReadonlyMap<string, string>
): PcbLibraryComponentKind => {
  const reference = properties.get("Reference") ?? "";
  const keywords = properties.get("ki_keywords") ?? "";
  const filters = properties.get("ki_fp_filters") ?? "";
  const tokens = `${nickname} ${item} ${keywords} ${filters}`.toLocaleLowerCase("en-US").split(/[^a-z0-9]+/u);
  if (tokens.includes("bga") || nickname === "Package_BGA") return "bga";
  if (tokens.includes("gpio")) return "gpio";
  if (reference === "J" || tokens.includes("connector")) return "connector";
  return "generic";
};

const buildSymbolInspection = (
  parsed: ParsedSymbolLibrary,
  libraryId: string,
  nickname: string,
  item: string,
  sourceIdentity: ContentIdentity,
  limits: KiCadStockLibraryResolverLimits
): KiCadStockSymbolInspection | null => {
  const definition = parsed.definitions.get(item);
  if (definition === undefined) return null;
  if (childrenNamed(definition, "extends").length > 0 || childrenNamed(definition, "alias").length > 0) {
    return resolverError(
      "DERIVED_SYMBOL_UNSUPPORTED",
      libraryId,
      `${libraryId}: aliases and derived symbols are unsupported by the stock resolver.`
    );
  }
  const properties = propertyMap(definition, libraryId, limits);
  const nested = childrenNamed(definition, "symbol");
  if (nested.length > limits.maxNestedSymbolsPerDefinition) {
    return resolverError("LIMIT_EXCEEDED", libraryId, `${libraryId}: nested symbol count is unsupported.`);
  }

  const unitBodies = new Map<number, Set<number>>();
  const unitPins = new Map<number, Set<string>>();
  const pins = new Map<string, MutablePin>();
  const scanPin = (pin: SNode, unitNumber: number): void => {
    if (pin.values.length < 2) return resolverError("MALFORMED_LIBRARY", libraryId, `${libraryId}: pin declaration is malformed.`);
    const electricalType = pin.values[0]!.value;
    const graphicalShape = pin.values[1]!.value;
    if (!ELECTRICAL_TYPES.has(electricalType) || !validateLibraryPart(graphicalShape)) {
      return resolverError("MALFORMED_LIBRARY", libraryId, `${libraryId}: pin type or shape is invalid.`);
    }
    const number = decoratedScalar(pin, "number", libraryId);
    const rawName = decoratedScalar(pin, "name", libraryId);
    if (!PIN_OR_PAD.test(number) || CONTROL.test(rawName)) {
      return resolverError("MALFORMED_LIBRARY", libraryId, `${libraryId}: pin number or function text is invalid.`);
    }
    const name = cleanedPinName(rawName);
    const previous = pins.get(number);
    if (
      previous !== undefined
      && (previous.name !== name || previous.electricalType !== electricalType || previous.graphicalShape !== graphicalShape)
    ) return resolverError("MALFORMED_LIBRARY", libraryId, `${libraryId}: pin ${number} has conflicting metadata.`);
    const record = previous ?? { number, name, electricalType, graphicalShape, unitNumbers: new Set<number>() };
    record.unitNumbers.add(unitNumber);
    pins.set(number, record);
    const perUnit = unitPins.get(unitNumber) ?? new Set<string>();
    perUnit.add(number);
    unitPins.set(unitNumber, perUnit);
  };

  for (const pin of childrenNamed(definition, "pin")) scanPin(pin, 1);
  for (const representation of nested) {
    const nestedName = representation.values.length === 1 ? representation.values[0]!.value : "";
    const prefix = `${item}_`;
    if (!nestedName.startsWith(prefix)) {
      return resolverError("MALFORMED_LIBRARY", libraryId, `${libraryId}: nested symbol name is not bound to its parent.`);
    }
    const suffix = nestedName.slice(prefix.length);
    const match = /^(0|[1-9][0-9]*)_(0|[1-9][0-9]*)$/u.exec(suffix);
    if (match === null) return resolverError("MALFORMED_LIBRARY", libraryId, `${libraryId}: nested unit name is malformed.`);
    const unitNumber = parsePositiveInteger(match[1]!, libraryId, "unit number", limits.maxUnits);
    const bodyStyle = parsePositiveInteger(match[2]!, libraryId, "body style", limits.maxUnits);
    const bodies = unitBodies.get(unitNumber) ?? new Set<number>();
    bodies.add(bodyStyle);
    unitBodies.set(unitNumber, bodies);
    for (const pin of childrenNamed(representation, "pin")) scanPin(pin, unitNumber === 0 ? 1 : unitNumber);
  }
  if (pins.size === 0 || pins.size > limits.maxPinsOrPads) {
    return resolverError("LIMIT_EXCEEDED", libraryId, `${libraryId}: pin count is unsupported.`);
  }
  const positiveUnits = [...unitBodies.keys()].filter((unit) => unit > 0).sort(compareNumber);
  const inferredUnits = positiveUnits.length === 0 ? [1] : positiveUnits;
  const unitCount = inferredUnits.at(-1)!;
  if (unitCount > limits.maxUnits || inferredUnits.some((unit, index) => unit !== index + 1)) {
    return resolverError("MALFORMED_LIBRARY", libraryId, `${libraryId}: positive unit numbers must be contiguous.`);
  }

  const pinInspections = [...pins.values()]
    .sort((left, right) => compareText(left.number, right.number))
    .map((pin): KiCadStockSymbolPinInspection => ({
      number: pin.number,
      name: pin.name,
      electricalType: pin.electricalType,
      graphicalShape: pin.graphicalShape,
      unitNumbers: [...pin.unitNumbers].sort(compareNumber)
    }));
  const unitInspections = inferredUnits.map((unitNumber): KiCadStockSymbolUnitInspection => ({
    unitNumber,
    bodyStyles: [...(unitBodies.get(unitNumber) ?? new Set([0]))].sort(compareNumber),
    pinNumbers: [...(unitPins.get(unitNumber) ?? new Set<string>())].sort(compareText)
  }));
  const functions = pinInspections.flatMap((pin) => pin.name === null ? [] : [pin.name]);
  const polarized = recognizedPolarity(functions);
  const candidate: PcbResolvedSymbol = {
    libraryId,
    source: "kicad-stock",
    unitCount,
    componentKind: classifySymbol(nickname, item, properties),
    polarized,
    pins: pinInspections.map((pin) => ({ number: pin.number, function: pin.name }))
  };
  const resolverRecord = normalizePcbResolvedSymbol(candidate, libraryId);
  if (resolverRecord === null) {
    return resolverError("NORMALIZER_REJECTED", libraryId, `${libraryId}: parsed symbol does not satisfy the compiler resolver boundary.`);
  }
  const payload = {
    schemaVersion: KICAD_STOCK_SYMBOL_INSPECTION_SCHEMA_VERSION,
    libraryId,
    sourceIdentity,
    units: unitInspections,
    pins: pinInspections,
    polarity: {
      polarized,
      basis: polarized ? "recognized_pin_functions" as const : "none" as const,
      functions: [...functions].sort(compareText)
    },
    resolverRecord
  };
  return deepFreeze({
    ...payload,
    identity: canonicalIdentity(payload, KICAD_STOCK_SYMBOL_INSPECTION_SCHEMA_VERSION)
  });
};

const descendants = (root: SNode, name: string): readonly SNode[] => {
  const found: SNode[] = [];
  const stack = [...root.children];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.name === name) found.push(node);
    stack.push(...node.children);
  }
  return found;
};

const layerNames = (node: SNode): readonly string[] => {
  const layer = childrenNamed(node, "layers");
  if (layer.length !== 1 || layer[0]!.children.length !== 0) return [];
  return layer[0]!.values.map((entry) => entry.value);
};

const copperSides = (layers: readonly string[]): readonly KiCadFootprintSide[] => {
  const result = new Set<KiCadFootprintSide>();
  if (layers.includes("F.Cu") || layers.includes("*.Cu")) result.add("front");
  if (layers.includes("B.Cu") || layers.includes("*.Cu")) result.add("back");
  return [...result].sort(compareText);
};

const packageKind = (nickname: string, item: string): PcbLibraryPackageKind =>
  nickname === "Package_BGA" || /(?:^|[_-])(?:BGA|FBGA|TFBGA|UFBGA|WLCSP)(?:[_-]|$)/iu.test(item) ? "bga" : "generic";

const buildFootprintInspection = (
  parsed: ParsedFootprintLibrary,
  libraryId: string,
  nickname: string,
  item: string,
  sourceIdentity: ContentIdentity,
  limits: KiCadStockLibraryResolverLimits
): KiCadStockFootprintInspection | null => {
  const footprint = parsed.footprint;
  if (footprint.values[0]!.value !== item) return null;
  const rootLayer = scalar(footprint, "layer", libraryId);
  if (rootLayer !== "F.Cu" && rootLayer !== "B.Cu") {
    return resolverError("MALFORMED_LIBRARY", libraryId, `${libraryId}: footprint side must be F.Cu or B.Cu.`);
  }
  const side: KiCadFootprintSide = rootLayer === "F.Cu" ? "front" : "back";
  const padNodes = descendants(footprint, "pad");
  if (padNodes.length === 0 || padNodes.length > limits.maxPinsOrPads * 4) {
    return resolverError("LIMIT_EXCEEDED", libraryId, `${libraryId}: pad declaration count is unsupported.`);
  }
  const padsByNumber = new Map<string, KiCadStockFootprintPadInspection>();
  const physicalPads: KiCadStockFootprintPhysicalPadInspection[] = [];
  const terminalPhysicalPadOrdinals: Record<string, number[]> = Object.create(null) as Record<string, number[]>;
  for (const [ordinal, pad] of padNodes.entries()) {
    if (pad.values.length < 3) return resolverError("MALFORMED_LIBRARY", libraryId, `${libraryId}: pad declaration is malformed.`);
    const number = pad.values[0]!.value;
    const padType = pad.values[1]!.value;
    const shape = pad.values[2]!.value;
    const padLayers = layerNames(pad);
    const sides = copperSides(padLayers);
    if (!validateLibraryPart(padType) || !validateLibraryPart(shape) || padLayers.length === 0
        || new Set(padLayers).size !== padLayers.length || number.length > 0 && (!PIN_OR_PAD.test(number) || sides.length === 0)) {
      return resolverError("MALFORMED_LIBRARY", libraryId, `${libraryId}: numbered pad metadata is invalid.`);
    }
    const atFields = childrenNamed(pad, "at");
    const atValues = atFields[0]?.values.map((value) => value.quoted ? NaN : Number(value.value)) ?? [];
    if (atFields.length !== 1 || atFields[0]!.children.length !== 0 || (atValues.length !== 2 && atValues.length !== 3)
        || atValues.some((value) => !Number.isFinite(value) || Math.abs(value) > 10_000_000)) {
      return resolverError("MALFORMED_LIBRARY", libraryId, `${libraryId}: physical pad placement is malformed.`);
    }
    physicalPads.push({ ordinal, number, padType, shape, layers: padLayers, copperSides: sides,
      role: number.length > 0 ? "numbered-copper"
        : padType === "smd" && padLayers.every((layer) => layer === "F.Paste" || layer === "B.Paste") ? "paste-aperture" : "uncharacterized-non-electrical",
      definition: pad, definitionKey: physicalPadDefinitionKey(pad),
      at: { xMm: atValues[0]!, yMm: atValues[1]!, rotationDeg: atValues[2] ?? 0 } });
    if (number.length === 0) continue;
    terminalPhysicalPadOrdinals[number] = [...(terminalPhysicalPadOrdinals[number] ?? []), ordinal];
    const candidate: KiCadStockFootprintPadInspection = { number, padType, shape, copperSides: sides };
    const previous = padsByNumber.get(number);
    // A logical terminal may contain unlike copper primitives. Their complete
    // definitions stay separate; this summary is not a physical shorting proof.
    padsByNumber.set(number, previous === undefined ? candidate : {
      number, padType: previous.padType === padType ? padType : "mixed",
      shape: previous.shape === shape ? shape : "mixed",
      copperSides: [...new Set([...previous.copperSides, ...sides])].sort(compareText),
    });
  }
  if (padsByNumber.size === 0 || padsByNumber.size > limits.maxPinsOrPads) {
    return resolverError("LIMIT_EXCEEDED", libraryId, `${libraryId}: numbered pad count is unsupported.`);
  }
  const layers = new Set(
    descendants(footprint, "layer")
      .filter((layer) => layer.children.length === 0 && layer.values.length === 1)
      .map((layer) => layer.values[0]!.value)
  );
  const pads = [...padsByNumber.values()].sort((left, right) => compareText(left.number, right.number));
  const candidate: PcbResolvedFootprint = {
    libraryId,
    source: "kicad-stock",
    packageKind: packageKind(nickname, item),
    pads: pads.map((pad) => pad.number)
  };
  const resolverRecord = normalizePcbResolvedFootprint(candidate, libraryId);
  if (resolverRecord === null) {
    return resolverError("NORMALIZER_REJECTED", libraryId, `${libraryId}: parsed footprint does not satisfy the compiler resolver boundary.`);
  }
  const courtyard = {
    front: layers.has("F.CrtYd"),
    back: layers.has("B.CrtYd"),
    availableForSide: layers.has(side === "front" ? "F.CrtYd" : "B.CrtYd")
  };
  const fabrication = {
    front: layers.has("F.Fab"),
    back: layers.has("B.Fab"),
    availableForSide: layers.has(side === "front" ? "F.Fab" : "B.Fab")
  };
  const payload = {
    schemaVersion: KICAD_STOCK_FOOTPRINT_INSPECTION_SCHEMA_VERSION,
    libraryId,
    sourceIdentity,
    side,
    courtyard,
    fabrication,
    pads,
    physicalPads,
    terminalPhysicalPadOrdinals,
    copperCommon: "not-assessed" as const,
    resolverRecord
  };
  return deepFreeze({
    ...payload,
    identity: canonicalIdentity(payload, KICAD_STOCK_FOOTPRINT_INSPECTION_SCHEMA_VERSION)
  });
};

const mergeLimits = (override: Partial<KiCadStockLibraryResolverLimits> | undefined): KiCadStockLibraryResolverLimits => {
  const defaults = KICAD_STOCK_LIBRARY_RESOLVER_LIMITS;
  const unknown = override === undefined ? [] : Object.keys(override).filter((key) => !(key in defaults));
  if (unknown.length > 0) return resolverError("INVALID_CONFIGURATION", "limits", "Resolver limits contain unknown fields.");
  const result = { ...defaults } as Record<keyof KiCadStockLibraryResolverLimits, number>;
  if (override !== undefined) for (const key of Object.keys(override) as (keyof KiCadStockLibraryResolverLimits)[]) {
    const value = override[key];
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > defaults[key]) {
      return resolverError("INVALID_CONFIGURATION", "limits", `Resolver limit ${key} may only tighten its hard ceiling.`);
    }
    result[key] = value as number;
  }
  return Object.freeze(result) as unknown as KiCadStockLibraryResolverLimits;
};

const exactIdSet = (values: readonly string[], maximum: number, label: string): ReadonlySet<string> => {
  if (!Array.isArray(values) || values.length > maximum) {
    return resolverError("INVALID_CONFIGURATION", label, `${label} exceeds the bounded contract ID count.`);
  }
  const result = new Set<string>();
  for (const value of values) {
    if (parseLibraryId(value) === null) return resolverError("INVALID_CONFIGURATION", label, `${label} contains an invalid exact library ID.`);
    result.add(value);
  }
  return result;
};

const nicknameSet = (values: readonly string[], maximum: number, label: string): ReadonlySet<string> => {
  if (!Array.isArray(values) || values.length > maximum) {
    return resolverError("INVALID_CONFIGURATION", label, `${label} exceeds the stock nickname count.`);
  }
  const result = new Set<string>();
  for (const value of values) {
    if (!validateLibraryPart(value)) return resolverError("INVALID_CONFIGURATION", label, `${label} contains an invalid nickname.`);
    result.add(value);
  }
  return result;
};

/**
 * Read-only, exact-ID resolver for host-configured KiCad 10 stock libraries.
 * It never reads project library tables and never emits a filesystem path.
 */
export class KiCad10StockLibraryResolver implements PcbReadOnlyLibraryResolver {
  readonly #symbolRoot: RootBinding;
  readonly #footprintRoot: RootBinding;
  readonly #exactSymbolIds: ReadonlySet<string>;
  readonly #exactFootprintIds: ReadonlySet<string>;
  readonly #stockSymbolNicknames: ReadonlySet<string>;
  readonly #stockFootprintNicknames: ReadonlySet<string>;
  readonly #limits: KiCadStockLibraryResolverLimits;
  readonly #parsedCache = new Map<string, CachedParsedLibrary>();
  readonly #symbolRecords = new Map<string, KiCadStockSymbolInspection | null>();
  readonly #footprintRecords = new Map<string, KiCadStockFootprintInspection | null>();
  #cachedSourceBytes = 0;

  public constructor(options: KiCad10StockLibraryResolverOptions) {
    this.#limits = mergeLimits(options.limits);
    this.#symbolRoot = bindRoot(options.symbolRoot, "symbol root");
    this.#footprintRoot = bindRoot(options.footprintRoot, "footprint root");
    this.#exactSymbolIds = exactIdSet(options.exactSymbolIds, this.#limits.maxExactSymbolIds, "exactSymbolIds");
    this.#exactFootprintIds = exactIdSet(options.exactFootprintIds, this.#limits.maxExactFootprintIds, "exactFootprintIds");
    this.#stockSymbolNicknames = nicknameSet(options.stockSymbolNicknames, this.#limits.maxStockNicknames, "stockSymbolNicknames");
    this.#stockFootprintNicknames = nicknameSet(options.stockFootprintNicknames, this.#limits.maxStockNicknames, "stockFootprintNicknames");
  }

  public resolveSymbol(exactLibraryId: string): PcbResolvedSymbol | null {
    return this.inspectSymbol(exactLibraryId)?.resolverRecord ?? null;
  }

  public resolveFootprint(exactLibraryId: string): PcbResolvedFootprint | null {
    return this.inspectFootprint(exactLibraryId)?.resolverRecord ?? null;
  }

  public inspectSymbol(exactLibraryId: string): KiCadStockSymbolInspection | null {
    const parsedId = parseLibraryId(exactLibraryId);
    if (parsedId === null || !this.#exactSymbolIds.has(exactLibraryId)) return null;
    const [nickname, item] = parsedId;
    if (!this.#stockSymbolNicknames.has(nickname)) return null;
    const asset = locateSymbol(this.#symbolRoot, nickname, exactLibraryId, this.#limits);
    if (asset === null) return null;
    const loaded = loadAsset(asset);
    const recordKey = `${exactLibraryId}\u0000${loaded.identity.digest}\u0000${loaded.identity.size}`;
    if (this.#symbolRecords.has(recordKey)) return this.#symbolRecords.get(recordKey)!;
    const parsed = this.#parsed("symbol", loaded, exactLibraryId);
    if (parsed.kind !== "symbol") return resolverError("MALFORMED_LIBRARY", exactLibraryId, `${exactLibraryId}: cached library kind mismatch.`);
    const record = buildSymbolInspection(parsed, exactLibraryId, nickname, item, loaded.identity, this.#limits);
    this.#setRecord(this.#symbolRecords, recordKey, record);
    return record;
  }

  public inspectFootprint(exactLibraryId: string): KiCadStockFootprintInspection | null {
    const parsedId = parseLibraryId(exactLibraryId);
    if (parsedId === null || !this.#exactFootprintIds.has(exactLibraryId)) return null;
    const [nickname, item] = parsedId;
    if (!this.#stockFootprintNicknames.has(nickname)) return null;
    const asset = locateFootprint(this.#footprintRoot, nickname, item, exactLibraryId, this.#limits);
    if (asset === null) return null;
    const loaded = loadAsset(asset);
    const recordKey = `${exactLibraryId}\u0000${loaded.identity.digest}\u0000${loaded.identity.size}`;
    if (this.#footprintRecords.has(recordKey)) return this.#footprintRecords.get(recordKey)!;
    const parsed = this.#parsed("footprint", loaded, exactLibraryId);
    if (parsed.kind !== "footprint") return resolverError("MALFORMED_LIBRARY", exactLibraryId, `${exactLibraryId}: cached library kind mismatch.`);
    const record = buildFootprintInspection(parsed, exactLibraryId, nickname, item, loaded.identity, this.#limits);
    this.#setRecord(this.#footprintRecords, recordKey, record);
    return record;
  }

  /** Complete raw-source pin geometry under the same exact stock allowlist and source authority. */
  public inspectSymbolTerminalGeometry(exactLibraryId: string): FreshSymbolTerminalGeometry | null {
    const approved = this.inspectSymbol(exactLibraryId);
    if (approved === null) return null;
    const parsedId = parseLibraryId(exactLibraryId);
    if (parsedId === null || !this.#exactSymbolIds.has(exactLibraryId) || !this.#stockSymbolNicknames.has(parsedId[0])) return null;
    const asset = locateSymbol(this.#symbolRoot, parsedId[0], exactLibraryId, this.#limits);
    if (asset === null) return null;
    const loaded = loadAsset(asset);
    if (loaded.identity.digest !== approved.sourceIdentity.digest || loaded.identity.size !== approved.sourceIdentity.size) {
      return resolverError("MALFORMED_LIBRARY", exactLibraryId, `${exactLibraryId}: approved source changed before terminal geometry capture.`);
    }
    const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(loaded.bytes);
    const geometry = parseFreshSymbolLibraryTerminalGeometrySource(source, loaded.identity, exactLibraryId);
    const after = loadAsset(asset);
    if (after.identity.digest !== loaded.identity.digest || after.identity.size !== loaded.identity.size) {
      return resolverError("MALFORMED_LIBRARY", exactLibraryId, `${exactLibraryId}: source changed during terminal geometry capture.`);
    }
    return geometry;
  }

  public inspectPair(symbolLibraryId: string, footprintLibraryId: string): KiCadStockLibraryPairInspection | null {
    const symbol = this.inspectSymbol(symbolLibraryId);
    const footprint = this.inspectFootprint(footprintLibraryId);
    if (symbol === null || footprint === null) return null;
    const symbolPinNumbers = symbol.resolverRecord.pins.map((pin) => pin.number).sort(compareText);
    const footprintPadNumbers = [...footprint.resolverRecord.pads].sort(compareText);
    const exactPinPadMatch = symbolPinNumbers.length === footprintPadNumbers.length
      && symbolPinNumbers.every((pin, index) => pin === footprintPadNumbers[index]);
    const payload = {
      schemaVersion: KICAD_STOCK_LIBRARY_PAIR_SCHEMA_VERSION,
      symbolIdentity: symbol.identity,
      footprintIdentity: footprint.identity,
      symbolPinNumbers,
      footprintPadNumbers,
      exactPinPadMatch
    };
    return deepFreeze({
      ...payload,
      identity: canonicalIdentity(payload, KICAD_STOCK_LIBRARY_PAIR_SCHEMA_VERSION)
    });
  }

  public cacheSnapshot(): KiCadStockLibraryCacheSnapshot {
    const symbolSourceIdentities = [...this.#parsedCache.values()]
      .filter((entry) => entry.parsed.kind === "symbol")
      .map((entry) => entry.identity)
      .sort((left, right) => compareText(left.digest, right.digest));
    const footprintSourceIdentities = [...this.#parsedCache.values()]
      .filter((entry) => entry.parsed.kind === "footprint")
      .map((entry) => entry.identity)
      .sort((left, right) => compareText(left.digest, right.digest));
    return deepFreeze({
      parsedSymbolFileCount: symbolSourceIdentities.length,
      parsedFootprintFileCount: footprintSourceIdentities.length,
      cachedSourceBytes: this.#cachedSourceBytes,
      symbolSourceIdentities,
      footprintSourceIdentities
    });
  }

  #parsed(kind: "symbol" | "footprint", loaded: LoadedAsset, logicalAsset: string): ParsedLibrary {
    const cacheKey = `${kind}\u0000${loaded.identity.digest}\u0000${loaded.identity.size}`;
    const cached = this.#parsedCache.get(cacheKey);
    if (cached !== undefined) return cached.parsed;
    const parsed = kind === "symbol"
      ? parseSymbolLibrary(loaded.bytes, logicalAsset, this.#limits)
      : parseFootprintLibrary(loaded.bytes, logicalAsset, this.#limits);
    while (
      this.#parsedCache.size >= this.#limits.maxCachedFiles
      || (this.#cachedSourceBytes + loaded.identity.size > this.#limits.maxCachedSourceBytes && this.#parsedCache.size > 0)
    ) {
      const oldest = this.#parsedCache.entries().next().value as [string, CachedParsedLibrary] | undefined;
      if (oldest === undefined) break;
      this.#parsedCache.delete(oldest[0]);
      this.#cachedSourceBytes -= oldest[1].identity.size;
    }
    if (loaded.identity.size <= this.#limits.maxCachedSourceBytes) {
      this.#parsedCache.set(cacheKey, { identity: loaded.identity, parsed });
      this.#cachedSourceBytes += loaded.identity.size;
    }
    return parsed;
  }

  #setRecord<Value>(cache: Map<string, Value>, key: string, value: Value): void {
    while (cache.size >= this.#limits.maxCachedRecords) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    cache.set(key, value);
  }
}

export const createKiCad10StockLibraryResolver = (
  options: KiCad10StockLibraryResolverOptions
): KiCad10StockLibraryResolver => new KiCad10StockLibraryResolver(options);
