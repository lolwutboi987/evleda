import { PCB_EXTERNAL_POWER_FLAG_INSPECTION_SCHEMA_VERSION, PCB_EXTERNAL_POWER_FLAG_LIB_ID } from "./pcb-external-power.js";
import { randomBytes } from "node:crypto";
import { types as utilTypes } from "node:util";

import { canonicalIdentity } from "../core/canonical.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import {
  KiCad10StockLibraryDiscoveryReader,
  KiCadStockDiscoveryReadError,
  KiCadStockLibraryResolverError,
  KICAD_STOCK_LIBRARY_RESOLVER_LIMITS,
  createKiCad10StockLibraryResolver,
  createKiCadStockSyntaxCache,
  type KiCadStockSyntaxCache,
  type KiCad10StockLibraryResolver,
  type KiCadStockDiscoveryCandidate,
  type KiCadStockDiscoveryReaderOptions
} from "./kicad-library-resolver.js";
import { createPcbLibrarySourceSelection, normalizePcbLibrarySourceSelectionRequest, type PcbLibrarySourceSelection, type PcbLibrarySourceSelectionRequest } from "./pcb-library-source-binding.js";
import type { PcbReadOnlyLibraryResolver } from "./pcb-design-compiler.js";

export const KICAD_STOCK_CATALOG_POLICY_SCHEMA_VERSION = "evleda.kicad-stock-catalog-policy.v1" as const;
export const KICAD_STOCK_CATALOG_SEARCH_SCHEMA_VERSION = "evleda.kicad-stock-catalog-search.v1" as const;
export const KICAD_STOCK_CATALOG_LIMITS = Object.freeze({
  maxQueryChars: 128, maxQueryTokens: 8, maxResults: 100,
  maxSourceReadsPerPage: 8, maxLibrariesPerPage: 16, maxCandidatesScannedPerPage: 2_048,
  maxCursorStates: 16
});

export interface KiCadStockCatalogOptions extends KiCadStockDiscoveryReaderOptions {
  readonly searchLimits?: Partial<SearchLimits>;
}

export interface KiCadStockCatalogSearchInput {
  readonly kind: "symbol" | "footprint";
  /** Literal text tokens, matched case-insensitively across source metadata. Empty means browse. */
  readonly query: string;
  readonly library?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface KiCadStockCatalogSearchIssue {
  readonly library: string;
  readonly libraryId?: string;
  readonly code: string;
  readonly count: number;
  readonly sourceIdentity?: ContentIdentity;
}

export interface KiCadStockCatalogScanCounts {
  readonly sources: number;
  /** Bytes from completed guarded reads, including parse failures; rejected reads may have consumed additional work. */
  readonly sourceBytes: number;
  readonly candidates: number;
  readonly libraries: number;
}

export interface KiCadStockCatalogSearchResult {
  readonly schemaVersion: typeof KICAD_STOCK_CATALOG_SEARCH_SCHEMA_VERSION;
  readonly namespaceAuthority: "host-approved-kicad-10-stock";
  readonly policyIdentity: CanonicalIdentity;
  readonly kind: "symbol" | "footprint";
  readonly query: string;
  readonly library: string | null;
  readonly candidates: readonly KiCadStockDiscoveryCandidate[];
  /** False when work remains OR some source coverage could not be inspected. */
  readonly complete: boolean;
  readonly exhausted: boolean;
  readonly nextCursor: string | null;
  readonly scanned: KiCadStockCatalogScanCounts;
  readonly totalScanned: KiCadStockCatalogScanCounts;
  readonly unsupported: readonly KiCadStockCatalogSearchIssue[];
  readonly totalUnsupportedSources: number;
  readonly snapshot: "per-source-read-not-atomic";
}

export class KiCadStockCatalogError extends Error {
  public constructor(public readonly code: "INVALID_QUERY" | "INVALID_CURSOR" | "SOURCE_CHANGED" | "INVALID_CONFIGURATION", message: string) {
    super(message);
    this.name = "KiCadStockCatalogError";
  }
}

type SearchLimits = { readonly [Key in keyof typeof KICAD_STOCK_CATALOG_LIMITS]: number };
type Counts = { -readonly [Key in keyof KiCadStockCatalogScanCounts]: number };
interface SearchState {
  readonly requestKey: string;
  libraryIndex: number;
  itemIndex: number;
  sourceIdentity: ContentIdentity | CanonicalIdentity | null;
  readonly total: Counts;
  unsupported: number;
}

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const PART = /^[A-Za-z0-9][A-Za-z0-9_.+@~-]{0,127}$/u;
const queryText = /^[A-Za-z0-9 _.:+@~-]*$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const emptyCounts = (): Counts => ({ sources: 0, sourceBytes: 0, candidates: 0, libraries: 0 });
const sameIdentity = (a: ContentIdentity | CanonicalIdentity, b: ContentIdentity | CanonicalIdentity): boolean =>
  a.digest === b.digest && ("size" in a ? "size" in b && a.size === b.size : !("size" in b) && a.schemaVersion === b.schemaVersion);
const freeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

const nicknames = (values: readonly string[]): readonly string[] => {
  if (!Array.isArray(values) || values.length < 1 || values.length > KICAD_STOCK_LIBRARY_RESOLVER_LIMITS.maxStockNicknames
    || values.some((value, index) => typeof value !== "string" || !PART.test(value) || CONTROL.test(value) || value === "." || value === ".."
      || (index > 0 && compare(values[index - 1]!, value) >= 0))) {
    throw new KiCadStockCatalogError("INVALID_CONFIGURATION", "Catalog namespaces must be nonempty, bounded, sorted unique stock nicknames.");
  }
  return Object.freeze([...values]);
};

const searchLimits = (override: KiCadStockCatalogOptions["searchLimits"]): SearchLimits => {
  const limits = { ...KICAD_STOCK_CATALOG_LIMITS } as { -readonly [Key in keyof SearchLimits]: number };
  if (override !== undefined) for (const [key, value] of Object.entries(override)) {
    if (!Object.hasOwn(limits, key) || !Number.isSafeInteger(value) || value < 1 || value > limits[key as keyof SearchLimits]) {
      throw new KiCadStockCatalogError("INVALID_CONFIGURATION", "Catalog search limits may only tighten hard ceilings.");
    }
    limits[key as keyof SearchLimits] = value;
  }
  return Object.freeze(limits);
};

/** Installed-stock discovery and exact inspection; no project aliases or filesystem paths are exposed. */
export class KiCad10StockCatalog implements PcbReadOnlyLibraryResolver {
  readonly #options: KiCadStockDiscoveryReaderOptions;
  readonly #reader: KiCad10StockLibraryDiscoveryReader;
  readonly #symbols: ReadonlySet<string>;
  readonly #footprints: ReadonlySet<string>;
  readonly #limits: SearchLimits;
  readonly #policyIdentity: CanonicalIdentity;
  readonly #cursors = new Map<string, SearchState>();
  // Only syntax survives exact selection replacement. Inspection records and
  // admission remain resolver-local; one catalog-wide cache enforces bounds.
  readonly #syntaxCache: KiCadStockSyntaxCache;
  #resolver: KiCad10StockLibraryResolver;
  #selectedSymbols = new Set<string>();
  #selectedFootprints = new Set<string>();

  public constructor(options: KiCadStockCatalogOptions) {
    const symbols = nicknames(options.stockSymbolNicknames);
    const footprints = nicknames(options.stockFootprintNicknames);
    this.#options = Object.freeze({
      symbolRoot: options.symbolRoot, footprintRoot: options.footprintRoot,
      stockSymbolNicknames: symbols, stockFootprintNicknames: footprints,
      ...(options.limits === undefined ? {} : { limits: Object.freeze({ ...options.limits }) })
    });
    this.#symbols = new Set(symbols);
    this.#footprints = new Set(footprints);
    this.#limits = searchLimits(options.searchLimits);
    this.#reader = new KiCad10StockLibraryDiscoveryReader(this.#options);
    this.#syntaxCache = createKiCadStockSyntaxCache(this.#options.limits);
    this.#resolver = createKiCad10StockLibraryResolver({ ...this.#options, exactSymbolIds: [], exactFootprintIds: [] }, this.#syntaxCache);
    this.#policyIdentity = canonicalIdentity({
      schemaVersion: KICAD_STOCK_CATALOG_POLICY_SCHEMA_VERSION, mode: "stock_catalog", kicadMajorVersion: 10,
      symbolRoot: options.symbolRoot, footprintRoot: options.footprintRoot,
      stockSymbolNicknames: symbols, stockFootprintNicknames: footprints,
      ...(options.limits === undefined ? {} : { limits: options.limits })
    }, KICAD_STOCK_CATALOG_POLICY_SCHEMA_VERSION);
  }

  public resolveSymbol(libraryId: string) { return this.inspectSymbol(libraryId)?.resolverRecord ?? null; }
  public resolveFootprint(libraryId: string) { return this.inspectFootprint(libraryId)?.resolverRecord ?? null; }

  public inspectSymbol(libraryId: string) {
    if (!this.#approved(libraryId, this.#symbols)) return null;
    if (!this.#selectedSymbols.has(libraryId)) this.#select([libraryId], []);
    return this.#resolver.inspectSymbol(libraryId);
  }

  public inspectFootprint(libraryId: string) {
    if (!this.#approved(libraryId, this.#footprints)) return null;
    if (!this.#selectedFootprints.has(libraryId)) this.#select([], [libraryId]);
    return this.#resolver.inspectFootprint(libraryId);
  }

  public readFootprintSource(libraryId: string) {
    if (!this.#approved(libraryId, this.#footprints)) return null;
    if (!this.#selectedFootprints.has(libraryId)) this.#select([], [libraryId]);
    return this.#resolver.readFootprintSource(libraryId);
  }

  public inspectPair(symbolLibraryId: string, footprintLibraryId: string) {
    if (!this.#approved(symbolLibraryId, this.#symbols) || !this.#approved(footprintLibraryId, this.#footprints)) return null;
    if (!this.#selectedSymbols.has(symbolLibraryId) || !this.#selectedFootprints.has(footprintLibraryId)) this.#select([symbolLibraryId], [footprintLibraryId]);
    return this.#resolver.inspectPair(symbolLibraryId, footprintLibraryId);
  }

  public inspectSymbolTerminalGeometry(libraryId: string) {
    if (!this.#approved(libraryId, this.#symbols)) return null;
    if (!this.#selectedSymbols.has(libraryId)) this.#select([libraryId], []);
    return this.#resolver.inspectSymbolTerminalGeometry(libraryId);
  }

  public inspectExternalPowerFlag() {
    const libraryId = PCB_EXTERNAL_POWER_FLAG_LIB_ID;
    if (!this.#approved(libraryId, this.#symbols)) return null;
    if (!this.#selectedSymbols.has(libraryId)) this.#select([libraryId], []);
    const inspection = this.#resolver.inspectExternalPowerFlag();
    if (inspection === null) return null;
    const { identity: _identity, ...captured } = inspection;
    const payload = { ...captured, policyIdentity: this.#policyIdentity };
    return freeze({ ...payload, identity: canonicalIdentity(payload, PCB_EXTERNAL_POWER_FLAG_INSPECTION_SCHEMA_VERSION) });
  }

  public captureSourceSelection(request: PcbLibrarySourceSelectionRequest): PcbLibrarySourceSelection {
    const selected = normalizePcbLibrarySourceSelectionRequest(request);
    // The exact-reader constructor rejects over-limit and malformed selections before any source read.
    this.#select(selected.symbolIds, selected.footprintIds);
    try {
      const records = this.#resolver.captureSourceSelectionRecords();
      return createPcbLibrarySourceSelection({ policyIdentity: this.#policyIdentity, records }, selected);
    } catch (error) {
      if (error instanceof KiCadStockLibraryResolverError && error.code === "SOURCE_CHANGED") {
        throw new KiCadStockCatalogError("SOURCE_CHANGED", "Selected stock sources changed during selection capture.");
      }
      throw error;
    }
  }

  public cacheSnapshot() {
    return freeze({ ...this.#resolver.cacheSnapshot(), exactResolverCount: 1, cursorStateCount: this.#cursors.size });
  }

  public search(input: KiCadStockCatalogSearchInput): KiCadStockCatalogSearchResult {
    const request = this.#request(input);
    const libraries = request.library === null ? [...(request.kind === "symbol" ? this.#symbols : this.#footprints)] : [request.library];
    const requestKey = JSON.stringify([request.kind, request.query, request.library, request.limit]);
    let state: SearchState;
    if (input.cursor !== undefined) {
      const stored = this.#cursors.get(input.cursor);
      if (stored === undefined || stored.requestKey !== requestKey) throw new KiCadStockCatalogError("INVALID_CURSOR", "Search cursor is unknown, expired, or belongs to another request.");
      this.#cursors.delete(input.cursor);
      state = { ...stored, total: { ...stored.total } };
    } else state = { requestKey, libraryIndex: 0, itemIndex: 0, sourceIdentity: null, total: emptyCounts(), unsupported: 0 };

    const candidates: KiCadStockDiscoveryCandidate[] = [];
    const unsupported: KiCadStockCatalogSearchIssue[] = [];
    const scanned = emptyCounts();
    const issue = (library: string, code: string, libraryId?: string, count = 1, sourceIdentity?: ContentIdentity) => {
      unsupported.push({ library, ...(libraryId === undefined ? {} : { libraryId }), code, count,
        ...(sourceIdentity === undefined ? {} : { sourceIdentity }) });
      state.unsupported += count;
    };
    const nextLibrary = () => { state.libraryIndex += 1; state.itemIndex = 0; state.sourceIdentity = null; };
    const checkIdentity = (identity: ContentIdentity | CanonicalIdentity) => {
      if (state.sourceIdentity !== null && !sameIdentity(identity, state.sourceIdentity)) {
        throw new KiCadStockCatalogError("SOURCE_CHANGED", "Stock source or directory changed across search pages; start a new search.");
      }
      state.sourceIdentity = identity;
    };
    const matches = (candidate: KiCadStockDiscoveryCandidate) => {
      const haystack = [candidate.libraryId, candidate.description, candidate.keywords, candidate.datasheet, candidate.defaultFootprint, candidate.footprintFilters]
        .filter((value) => value !== null).join(" ").toLowerCase();
      return request.tokens.every((token) => haystack.includes(token));
    };
    while (state.libraryIndex < libraries.length && candidates.length < request.limit
      && scanned.sources < this.#limits.maxSourceReadsPerPage && scanned.libraries < this.#limits.maxLibrariesPerPage
      && scanned.candidates < this.#limits.maxCandidatesScannedPerPage) {
      const library = libraries[state.libraryIndex]!;
      scanned.libraries += 1;
      if (request.kind === "symbol") {
        scanned.sources += 1;
        try {
          const source = this.#reader.readSymbolLibrary(library);
          if (source === null) { issue(library, "MISSING_SOURCE"); nextLibrary(); continue; }
          scanned.sourceBytes += source.sourceIdentity.size;
          const firstVisit = state.sourceIdentity === null;
          checkIdentity(source.sourceIdentity);
          if (firstVisit && source.unsupportedEntries > 0) issue(library, "UNSUPPORTED_LIBRARY_IDS", undefined, source.unsupportedEntries);
          while (state.itemIndex < source.candidates.length && candidates.length < request.limit && scanned.candidates < this.#limits.maxCandidatesScannedPerPage) {
            const candidate = source.candidates[state.itemIndex++]!;
            scanned.candidates += 1;
            if (candidate.unsupportedReason !== null && candidate.unsupportedReason !== "DERIVED_SYMBOL_UNSUPPORTED") {
              issue(library, candidate.unsupportedReason, candidate.libraryId, 1, candidate.sourceIdentity);
            }
            if (matches(candidate)) candidates.push(candidate);
          }
          if (state.itemIndex === source.candidates.length) nextLibrary();
        } catch (error) {
          if (!(error instanceof KiCadStockLibraryResolverError)) throw error;
          if (error instanceof KiCadStockDiscoveryReadError) scanned.sourceBytes += error.sourceIdentity.size;
          issue(library, error.code, undefined, 1, error instanceof KiCadStockDiscoveryReadError ? error.sourceIdentity : undefined); nextLibrary();
        }
      } else {
        try {
          const directory = this.#reader.listFootprintNames(library);
          if (directory === null) { issue(library, "MISSING_SOURCE"); nextLibrary(); continue; }
          const firstVisit = state.sourceIdentity === null;
          checkIdentity(directory.identity);
          if (firstVisit && directory.unsupportedEntries > 0) issue(library, "UNSUPPORTED_DIRECTORY_ENTRIES", undefined, directory.unsupportedEntries);
          while (state.itemIndex < directory.names.length && candidates.length < request.limit
            && scanned.sources < this.#limits.maxSourceReadsPerPage && scanned.candidates < this.#limits.maxCandidatesScannedPerPage) {
            const libraryId = `${library}:${directory.names[state.itemIndex++]!}`;
            scanned.sources += 1; scanned.candidates += 1;
            try {
              const candidate = this.#reader.readFootprint(libraryId);
              if (candidate === null) issue(library, "MISSING_SOURCE", libraryId);
              else { scanned.sourceBytes += candidate.sourceIdentity.size; if (matches(candidate)) candidates.push(candidate); }
            } catch (error) {
              if (!(error instanceof KiCadStockLibraryResolverError)) throw error;
              if (error instanceof KiCadStockDiscoveryReadError) scanned.sourceBytes += error.sourceIdentity.size;
              issue(library, error.code, libraryId, 1, error instanceof KiCadStockDiscoveryReadError ? error.sourceIdentity : undefined);
            }
          }
          if (state.itemIndex === directory.names.length) nextLibrary();
        } catch (error) {
          if (!(error instanceof KiCadStockLibraryResolverError)) throw error;
          issue(library, error.code); nextLibrary();
        }
      }
    }
    for (const key of Object.keys(scanned) as (keyof Counts)[]) state.total[key] += scanned[key];
    const exhausted = state.libraryIndex >= libraries.length;
    const nextCursor = exhausted ? null : this.#storeCursor(state);
    return freeze({
      schemaVersion: KICAD_STOCK_CATALOG_SEARCH_SCHEMA_VERSION, namespaceAuthority: "host-approved-kicad-10-stock",
      policyIdentity: this.#policyIdentity, kind: request.kind, query: request.query, library: request.library,
      candidates, complete: exhausted && state.unsupported === 0, exhausted, nextCursor, scanned,
      totalScanned: { ...state.total }, unsupported, totalUnsupportedSources: state.unsupported, snapshot: "per-source-read-not-atomic"
    });
  }

  #approved(libraryId: string, namespaces: ReadonlySet<string>): boolean {
    if (typeof libraryId !== "string" || libraryId.length > 192 || CONTROL.test(libraryId)) return false;
    const parts = libraryId.split(":");
    return parts.length === 2 && parts.every((part) => PART.test(part) && part !== "." && part !== "..") && namespaces.has(parts[0]!);
  }

  #select(symbolIds: readonly string[], footprintIds: readonly string[]): void {
    this.#reader.assertRootsStable();
    const unchanged = (ids: readonly string[], previous: ReadonlySet<string>) => Array.isArray(ids)
      && ids.length === previous.size && ids.every((id) => previous.has(id)) && new Set(ids).size === ids.length;
    if (unchanged(symbolIds, this.#selectedSymbols) && unchanged(footprintIds, this.#selectedFootprints)) return;
    const resolver = createKiCad10StockLibraryResolver({ ...this.#options, exactSymbolIds: symbolIds, exactFootprintIds: footprintIds }, this.#syntaxCache);
    this.#reader.assertRootsStable();
    this.#resolver = resolver;
    this.#selectedSymbols = new Set(symbolIds);
    this.#selectedFootprints = new Set(footprintIds);
  }

  #storeCursor(state: SearchState): string {
    while (this.#cursors.size >= this.#limits.maxCursorStates) this.#cursors.delete(this.#cursors.keys().next().value!);
    const cursor = randomBytes(24).toString("base64url");
    this.#cursors.set(cursor, state);
    return cursor;
  }

  #request(input: KiCadStockCatalogSearchInput) {
    if (input === null || typeof input !== "object" || Array.isArray(input)
      || Reflect.ownKeys(input).some((key) => typeof key !== "string" || !["kind", "query", "library", "limit", "cursor"].includes(key))
      || (input.kind !== "symbol" && input.kind !== "footprint") || typeof input.query !== "string"
      || input.query.length > this.#limits.maxQueryChars || !queryText.test(input.query) || CONTROL.test(input.query) || input.query.includes("..")) {
      throw new KiCadStockCatalogError("INVALID_QUERY", "Search requires bounded literal text and a supported asset kind.");
    }
    const query = input.query.trim().replace(/ +/gu, " ");
    const tokens = query.toLowerCase().split(" ").filter(Boolean);
    const limit = input.limit ?? Math.min(20, this.#limits.maxResults);
    const namespaces = input.kind === "symbol" ? this.#symbols : this.#footprints;
    if (tokens.length > this.#limits.maxQueryTokens || !Number.isSafeInteger(limit) || limit < 1 || limit > this.#limits.maxResults
      || (input.library !== undefined && (typeof input.library !== "string" || !namespaces.has(input.library)))
      || (input.cursor !== undefined && (typeof input.cursor !== "string" || input.cursor.length !== 32 || !/^[A-Za-z0-9_-]{32}$/u.test(input.cursor)))) {
      throw new KiCadStockCatalogError("INVALID_QUERY", "Search library, token count, result limit, or cursor format is invalid.");
    }
    return { kind: input.kind, query, tokens, library: input.library ?? null, limit };
  }
}

export const createKiCad10StockCatalog = (options: KiCadStockCatalogOptions): KiCad10StockCatalog => new KiCad10StockCatalog(options);

const originalCatalogMethods = Object.freeze({
  captureSourceSelection: KiCad10StockCatalog.prototype.captureSourceSelection,
  inspectSymbol: KiCad10StockCatalog.prototype.inspectSymbol,
  inspectFootprint: KiCad10StockCatalog.prototype.inspectFootprint,
  resolveSymbol: KiCad10StockCatalog.prototype.resolveSymbol,
  resolveFootprint: KiCad10StockCatalog.prototype.resolveFootprint,
});

/** Internal composite-resolver reuse only. Structural captures and overridden
 * inspection methods do not establish the same stock inspection authority.
 */
export function captureGenuineKiCadStockCatalogSelection(resolver: object, selected: PcbLibrarySourceSelectionRequest): PcbLibrarySourceSelection | undefined {
  if (utilTypes.isProxy(resolver) || Object.getPrototypeOf(resolver) !== KiCad10StockCatalog.prototype
      || Object.entries(originalCatalogMethods).some(([name, method]) =>
        Object.getOwnPropertyDescriptor(resolver, name) !== undefined
        || Object.getOwnPropertyDescriptor(KiCad10StockCatalog.prototype, name)?.value !== method)) return undefined;
  return originalCatalogMethods.captureSourceSelection.call(resolver as KiCad10StockCatalog, selected);
}
