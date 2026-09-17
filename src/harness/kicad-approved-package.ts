import { closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync, type BigIntStats } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import { hardenPortableValue, parsePortableJsonBytes } from "../core/portable-artifact.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import { parseFreshSymbolLibraryTerminalGeometrySource, type FreshSymbolTerminalGeometry } from "./fresh-kicad-parser.js";
import { inspectKiCadApprovedSymbolBytes, inspectKiCadApprovedFootprintBytes,
  type KiCadStockSymbolInspection, type KiCadStockFootprintInspection } from "./kicad-library-resolver.js";
import type { PcbReadOnlyLibraryResolver, PcbResolvedSymbol, PcbResolvedFootprint } from "./pcb-design-compiler.js";
import { createPcbLibrarySourceSelection, capturePcbLibrarySourceSelection, normalizePcbLibrarySourceSelectionRequest,
  type PcbLibrarySourceSelectionRequest, type PcbLibrarySourceSelectionRecord } from "./pcb-library-source-binding.js";

export const KICAD_APPROVED_PACKAGE_SCHEMA_VERSION = "evleda.kicad-approved-package.v1" as const;
export const KICAD_APPROVED_PACKAGE_POLICY_SCHEMA_VERSION = "evleda.kicad-approved-package-policy.v1" as const;
export const KICAD_APPROVED_SYMBOL_INSPECTION_SCHEMA_VERSION = "evleda.kicad-approved-symbol-inspection.v1" as const;
export const KICAD_APPROVED_FOOTPRINT_INSPECTION_SCHEMA_VERSION = "evleda.kicad-approved-footprint-inspection.v1" as const;
const MAX_SOURCE = 512 * 1024, MAX_DOCUMENT = 8 * 1024 * 1024, MAX_MANIFEST = 64 * 1024;
const identity = z.object({ algorithm: z.literal("sha256"), digest: z.string().regex(/^[a-f0-9]{64}$/u), size: z.number().int().positive().max(MAX_DOCUMENT) }).strict();
const relativePath = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9_.+/-]*$/u).refine(value =>
  value.split("/").every(part => part !== "" && part !== "." && part !== ".." && !part.endsWith(".") && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(part)));
const filePin = z.object({ relativePath, identity }).strict();
const asset = z.object({ libraryId: z.string().regex(/^EvlEDA_[A-Za-z0-9_.+-]{1,96}:[A-Za-z0-9][A-Za-z0-9_.+@~-]{0,127}$/u),
  source: filePin, provenanceIds: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u)).min(1).max(16) }).strict();
const manifestSchema = z.object({ schemaVersion: z.literal(KICAD_APPROVED_PACKAGE_SCHEMA_VERSION),
  namespace: z.string().regex(/^EvlEDA_[A-Za-z0-9_.+-]{1,96}$/u), symbols: z.array(asset).max(16), footprints: z.array(asset).max(16),
  provenance: z.array(filePin.extend({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
    url: z.string().max(2048).url().refine(value => value.startsWith("https://")) }).strict()).min(1).max(16), notice: filePin }).strict();
const profileSchema = z.object({ root: z.string().min(1).max(600), manifest: filePin }).strict();
type Manifest = z.infer<typeof manifestSchema>;
type FilePin = z.infer<typeof filePin>;
export type KiCadApprovedPackageProfile = z.infer<typeof profileSchema>;
export type KiCadApprovedSymbolInspection = Omit<KiCadStockSymbolInspection, "schemaVersion"> & {
  readonly schemaVersion: typeof KICAD_APPROVED_SYMBOL_INSPECTION_SCHEMA_VERSION;
  readonly packagePolicyIdentity: CanonicalIdentity;
};
export type KiCadApprovedFootprintInspection = Omit<KiCadStockFootprintInspection, "schemaVersion"> & {
  readonly schemaVersion: typeof KICAD_APPROVED_FOOTPRINT_INSPECTION_SCHEMA_VERSION;
  readonly packagePolicyIdentity: CanonicalIdentity;
};
export type KiCadAuthorizedFootprintInspection = KiCadStockFootprintInspection | KiCadApprovedFootprintInspection;
interface StockResolver extends PcbReadOnlyLibraryResolver {
  inspectSymbol(id: string): KiCadStockSymbolInspection | null;
  inspectFootprint(id: string): KiCadStockFootprintInspection | null;
  inspectSymbolTerminalGeometry(id: string): FreshSymbolTerminalGeometry | null;
}
interface StockPolicy {
  readonly symbolRoot: string; readonly footprintRoot: string;
  readonly stockSymbolNicknames: readonly string[]; readonly stockFootprintNicknames: readonly string[];
  readonly exactSymbolIds?: readonly string[]; readonly exactFootprintIds?: readonly string[];
}
const bounds = { maxBytes: MAX_MANIFEST, maxDepth: 8, maxNodes: 4096, maxArrayLength: 64, maxOwnKeys: 16, maxStringBytes: 2048 };
const freeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
};
const equal = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const samePath = (left: string, right: string) => process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
const stamp = (stat: BigIntStats) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.nlink}`;
const authorizedResolvers = new WeakMap<object, (kind: "symbol" | "footprint", record: PcbResolvedSymbol | PcbResolvedFootprint, pin: PcbLibrarySourceSelectionRecord) => boolean>();
/** Inspect-only authority: registration is private and follows full pinned-package construction. */
export const hasKiCadApprovedPackageAuthority = (resolver: object): boolean => authorizedResolvers.has(resolver);
export const authenticateKiCadApprovedPackageRecord = (resolver: object, kind: "symbol" | "footprint", record: PcbResolvedSymbol | PcbResolvedFootprint, pin: PcbLibrarySourceSelectionRecord): boolean =>
  authorizedResolvers.get(resolver)?.(kind, record, pin) === true;

export function parseKiCadApprovedPackageProfile(value: unknown): KiCadApprovedPackageProfile {
  const parsed = profileSchema.parse(hardenPortableValue(value, bounds));
  if (!path.isAbsolute(parsed.root) || !samePath(path.resolve(parsed.root), parsed.root) || /[\u0000-\u001f\u007f"$]/u.test(parsed.root)
    || parsed.root.startsWith("\\\\") || parsed.manifest.identity.size > MAX_MANIFEST) throw new Error("Approved package profile has an invalid local root or manifest pin");
  return freeze(parsed);
}

/** Single optional local package. Every use reopens pinned bytes; no project aliases or fallback IDs. */
export class KiCadApprovedPackageResolver implements PcbReadOnlyLibraryResolver {
  readonly #profile: KiCadApprovedPackageProfile;
  readonly #manifest: Manifest;
  readonly #rootIdentity: string;
  readonly #stock: StockResolver;
  readonly #stockPolicy: StockPolicy;
  readonly #policyIdentity: CanonicalIdentity;
  readonly #symbols: ReadonlyMap<string, Manifest["symbols"][number]>;
  readonly #footprints: ReadonlyMap<string, Manifest["footprints"][number]>;

  public constructor(profile: KiCadApprovedPackageProfile, stock: StockResolver, stockPolicy: StockPolicy) {
    if (new.target !== KiCadApprovedPackageResolver) throw new Error("Approved package authority cannot be subclassed");
    this.#profile = parseKiCadApprovedPackageProfile(profile);
    this.#stock = stock;
    this.#stockPolicy = freeze({ ...stockPolicy, stockSymbolNicknames: [...stockPolicy.stockSymbolNicknames], stockFootprintNicknames: [...stockPolicy.stockFootprintNicknames] });
    const root = lstatSync(this.#profile.root, { bigint: true });
    if (!root.isDirectory() || root.isSymbolicLink() || !samePath(realpathSync.native(this.#profile.root), this.#profile.root)) throw new Error("Approved package root must be a canonical non-link directory");
    this.#rootIdentity = `${root.dev}:${root.ino}`;
    this.#manifest = freeze(manifestSchema.parse(parsePortableJsonBytes(this.#read(this.#profile.manifest, MAX_MANIFEST), bounds)));
    if (this.#manifest.symbols.length + this.#manifest.footprints.length === 0) throw new Error("Approved package cannot be empty");
    const namespace = this.#manifest.namespace;
    const forbidden = [...stockPolicy.stockSymbolNicknames, ...stockPolicy.stockFootprintNicknames,
      ...readdirSync(stockPolicy.symbolRoot).map(name => name.replace(/\.kicad_sym$/u, "")),
      ...readdirSync(stockPolicy.footprintRoot).map(name => name.replace(/\.pretty$/u, ""))];
    if (forbidden.some(name => name.toLowerCase() === namespace.toLowerCase())) throw new Error("Approved package namespace collides with installed or approved stock");
    const provenances = new Set(this.#manifest.provenance.map(entry => entry.id));
    if (provenances.size !== this.#manifest.provenance.length) throw new Error("Approved package provenance IDs must be unique");
    for (const [kind, assets] of [["symbol", this.#manifest.symbols], ["footprint", this.#manifest.footprints]] as const) {
      if (new Set(assets.map(entry => entry.libraryId.toLowerCase())).size !== assets.length) throw new Error("Approved package exact IDs contain duplicates or case aliases");
      for (const entry of assets) {
        const [nickname, name] = entry.libraryId.split(":");
        const expected = kind === "symbol" ? `symbols/${namespace}.kicad_sym` : `footprints/${namespace}.pretty/${name}.kicad_mod`;
        if (nickname !== namespace || entry.source.relativePath !== expected || entry.source.identity.size > MAX_SOURCE
          || new Set(entry.provenanceIds).size !== entry.provenanceIds.length || entry.provenanceIds.some(id => !provenances.has(id))) throw new Error("Approved package asset has invalid namespace, source pin or provenance");
      }
    }
    const pins = [this.#profile.manifest, this.#manifest.notice, ...this.#manifest.provenance,
      ...this.#manifest.symbols.map(entry => entry.source), ...this.#manifest.footprints.map(entry => entry.source)];
    const paths = new Map<string, FilePin>();
    for (const pin of pins) {
      const previous = paths.get(pin.relativePath.toLowerCase());
      if (previous !== undefined && !equal(previous, { relativePath: pin.relativePath, identity: pin.identity })) throw new Error("Approved package file path has conflicting pins or case aliases");
      paths.set(pin.relativePath.toLowerCase(), { relativePath: pin.relativePath, identity: pin.identity });
    }
    this.#symbols = new Map(this.#manifest.symbols.map(entry => [entry.libraryId, entry]));
    this.#footprints = new Map(this.#manifest.footprints.map(entry => [entry.libraryId, entry]));
    this.#policyIdentity = canonicalIdentity({ schemaVersion: KICAD_APPROVED_PACKAGE_POLICY_SCHEMA_VERSION,
      root: this.#profile.root, manifestIdentity: this.#profile.manifest.identity, namespace }, KICAD_APPROVED_PACKAGE_POLICY_SCHEMA_VERSION);
    this.#recapture();
    for (const id of this.#symbols.keys()) this.inspectSymbol(id);
    for (const id of this.#footprints.keys()) this.inspectFootprint(id);
    authorizedResolvers.set(this, (kind, record, pin) => {
      if (record.source !== "project-custom" || !(kind === "symbol" ? this.#symbols : this.#footprints).has(record.libraryId)) return false;
      const approved = kind === "symbol" ? this.inspectSymbol(record.libraryId) : this.inspectFootprint(record.libraryId);
      return approved !== null && approved.resolverRecord.source === "project-custom" && equal(approved.resolverRecord, record)
        && pin.kind === kind && pin.libraryId === record.libraryId && equal(pin.sourceIdentity, approved.sourceIdentity)
        && equal(pin.inspectionIdentity, approved.identity) && equal(pin.approvedPackage, this.#packageSourceBinding(kind));
    });
    Object.freeze(this);
  }

  #read(pin: FilePin, maximum: number): Buffer {
    const root = lstatSync(this.#profile.root, { bigint: true });
    if (!root.isDirectory() || root.isSymbolicLink() || `${root.dev}:${root.ino}` !== this.#rootIdentity
      || !samePath(realpathSync.native(this.#profile.root), this.#profile.root)) throw new Error("Approved package root changed");
    let current = this.#profile.root;
    const ancestors: { path: string; identity: string }[] = [];
    const segments = pin.relativePath.split("/");
    for (let index = 0; index < segments.length; index++) {
      const entries = readdirSync(current, { withFileTypes: true });
      if (entries.length > 2048) throw new Error("Approved package directory exceeds its bound");
      const matches = entries.filter(entry => entry.name.toLowerCase() === segments[index]!.toLowerCase());
      if (matches.length !== 1 || matches[0]!.name !== segments[index]) throw new Error("Approved package path is absent or ambiguously cased");
      current = path.join(current, segments[index]!);
      const stat = lstatSync(current, { bigint: true });
      if (stat.isSymbolicLink() || !samePath(realpathSync.native(current), current)
        || (index + 1 === segments.length ? !stat.isFile() || stat.nlink !== 1n : !stat.isDirectory())) throw new Error("Approved package paths must be confined non-link files and directories");
      if (index + 1 < segments.length) ancestors.push({ path: current, identity: `${stat.dev}:${stat.ino}` });
    }
    const before = lstatSync(current, { bigint: true });
    if (before.size > BigInt(maximum) || before.size !== BigInt(pin.identity.size)) throw new Error("Approved package file size changed or exceeds its bound");
    const fd = openSync(current, "r");
    try {
      if (stamp(fstatSync(fd, { bigint: true })) !== stamp(before)) throw new Error("Approved package file changed while opening");
      const buffer = Buffer.alloc(pin.identity.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, length);
        if (count === 0) break;
        length += count;
      }
      const bytes = buffer.subarray(0, length);
      if (stamp(fstatSync(fd, { bigint: true })) !== stamp(before) || stamp(lstatSync(current, { bigint: true })) !== stamp(before)
        || !samePath(realpathSync.native(current), current) || !equal(contentIdentity(bytes), pin.identity)) throw new Error("Approved package file changed or differs from its pin");
      const afterRoot = lstatSync(this.#profile.root, { bigint: true });
      if (!afterRoot.isDirectory() || afterRoot.isSymbolicLink() || `${afterRoot.dev}:${afterRoot.ino}` !== this.#rootIdentity
        || !samePath(realpathSync.native(this.#profile.root), this.#profile.root)) throw new Error("Approved package root changed during read");
      for (const ancestor of ancestors) {
        const after = lstatSync(ancestor.path, { bigint: true });
        if (!after.isDirectory() || after.isSymbolicLink() || `${after.dev}:${after.ino}` !== ancestor.identity
          || !samePath(realpathSync.native(ancestor.path), ancestor.path)) throw new Error("Approved package directory changed during read");
      }
      return bytes;
    } finally { closeSync(fd); }
  }
  #recapture(): void {
    // Native symbol loading checks installed files before project tables. A newly
    // introduced installed nickname must never shadow an approved package.
    for (const [root, suffix] of [[this.#stockPolicy.symbolRoot, ".kicad_sym"], [this.#stockPolicy.footprintRoot, ".pretty"]] as const) {
      const entries = readdirSync(root);
      if (entries.length > 20_000 || entries.some(name => name.toLowerCase() === `${this.#manifest.namespace}${suffix}`.toLowerCase())) {
        throw new Error("Approved package namespace collides with installed stock or its directory bound");
      }
    }
    this.#read(this.#profile.manifest, MAX_MANIFEST);
    this.#read(this.#manifest.notice, MAX_DOCUMENT);
    for (const document of this.#manifest.provenance) this.#read(document, MAX_DOCUMENT);
  }
  #isPackageId(id: string): boolean { return id.split(":")[0]?.toLowerCase() === this.#manifest.namespace.toLowerCase(); }
  #packageSourceBinding(kind: "symbol" | "footprint") {
    const namespace = this.#manifest.namespace;
    return { policyIdentity: this.#policyIdentity, manifestIdentity: this.#profile.manifest.identity,
      tableUri: path.join(this.#profile.root, kind === "symbol" ? `symbols/${namespace}.kicad_sym` : `footprints/${namespace}.pretty`).replaceAll("\\", "/") };
  }
  public resolveSymbol(id: string): PcbResolvedSymbol | null { return this.inspectSymbol(id)?.resolverRecord ?? null; }
  public resolveFootprint(id: string): PcbResolvedFootprint | null { return this.inspectFootprint(id)?.resolverRecord ?? null; }
  public inspectSymbol(id: string): KiCadStockSymbolInspection | KiCadApprovedSymbolInspection | null {
    const entry = this.#symbols.get(id);
    if (entry === undefined) {
      if (this.#isPackageId(id)) return null;
      const stock = this.#stock.inspectSymbol(id);
      if (stock !== null && (stock.libraryId !== id || stock.resolverRecord.source !== "kicad-stock")) throw new Error("Stock symbol fallback cannot grant package source authority");
      return stock;
    }
    this.#recapture();
    const stock = inspectKiCadApprovedSymbolBytes(this.#read(entry.source, MAX_SOURCE), id, [...this.#symbols.keys()]);
    const { identity: _identity, ...parsed } = stock;
    const payload = { ...parsed, schemaVersion: KICAD_APPROVED_SYMBOL_INSPECTION_SCHEMA_VERSION,
      packagePolicyIdentity: this.#policyIdentity, resolverRecord: { ...stock.resolverRecord, source: "project-custom" as const } };
    this.#read(entry.source, MAX_SOURCE); this.#recapture();
    return freeze({ ...payload, identity: canonicalIdentity(payload, payload.schemaVersion) });
  }
  public inspectFootprint(id: string): KiCadAuthorizedFootprintInspection | null {
    const entry = this.#footprints.get(id);
    if (entry === undefined) {
      if (this.#isPackageId(id)) return null;
      const stock = this.#stock.inspectFootprint(id);
      if (stock !== null && (stock.libraryId !== id || stock.resolverRecord.source !== "kicad-stock")) throw new Error("Stock footprint fallback cannot grant package source authority");
      return stock;
    }
    this.#recapture();
    const stock = inspectKiCadApprovedFootprintBytes(this.#read(entry.source, MAX_SOURCE), id);
    const { identity: _identity, ...parsed } = stock;
    const payload = { ...parsed, schemaVersion: KICAD_APPROVED_FOOTPRINT_INSPECTION_SCHEMA_VERSION,
      packagePolicyIdentity: this.#policyIdentity, resolverRecord: { ...stock.resolverRecord, source: "project-custom" as const } };
    this.#read(entry.source, MAX_SOURCE); this.#recapture();
    return freeze({ ...payload, identity: canonicalIdentity(payload, payload.schemaVersion) });
  }
  public inspectSymbolTerminalGeometry(id: string): FreshSymbolTerminalGeometry | null {
    const entry = this.#symbols.get(id);
    if (entry === undefined) return this.#isPackageId(id) ? null : this.#stock.inspectSymbolTerminalGeometry(id);
    const approved = this.inspectSymbol(id);
    if (approved === null) return null;
    const bytes = this.#read(entry.source, MAX_SOURCE);
    const geometry = parseFreshSymbolLibraryTerminalGeometrySource(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), approved.sourceIdentity, id);
    this.#read(entry.source, MAX_SOURCE); this.#recapture();
    return geometry;
  }
  public inspectExternalPowerFlag() { return this.#stock.inspectExternalPowerFlag?.() ?? null; }
  public inspectPair(symbolId: string, footprintId: string) {
    const symbol = this.inspectSymbol(symbolId), footprint = this.inspectFootprint(footprintId);
    if (symbol === null || footprint === null) return null;
    const symbolPinNumbers = symbol.resolverRecord.pins.map(pin => pin.number).sort(), footprintPadNumbers = [...footprint.resolverRecord.pads].sort();
    const payload = { schemaVersion: "evleda.kicad-approved-library-pair.v1" as const, symbolIdentity: symbol.identity, footprintIdentity: footprint.identity,
      symbolPinNumbers, footprintPadNumbers, exactPinPadMatch: equal(symbolPinNumbers, footprintPadNumbers) };
    return freeze({ ...payload, identity: canonicalIdentity(payload, payload.schemaVersion) });
  }
  public captureSourceSelection(request: PcbLibrarySourceSelectionRequest) {
    const selected = normalizePcbLibrarySourceSelectionRequest(request);
    this.#recapture();
    const stockSelected = { symbolIds: selected.symbolIds.filter(id => !this.#isPackageId(id)), footprintIds: selected.footprintIds.filter(id => !this.#isPackageId(id)) };
    const stockCapture = capturePcbLibrarySourceSelection(this.#stock, stockSelected);
    const records: PcbLibrarySourceSelectionRecord[] = [];
    for (const [kind, ids] of [["symbol", selected.symbolIds], ["footprint", selected.footprintIds]] as const) for (const libraryId of ids) {
      const inspection = kind === "symbol" ? this.inspectSymbol(libraryId) : this.inspectFootprint(libraryId);
      if (inspection === null) throw new Error("Selected library ID is unavailable under approved stock/package authority");
      const packaged = inspection.resolverRecord.source === "project-custom";
      records.push({ kind, libraryId, sourceIdentity: inspection.sourceIdentity, inspectionIdentity: inspection.identity,
        ...(packaged ? { approvedPackage: this.#packageSourceBinding(kind) } : {}) });
    }
    const policyIdentity = canonicalIdentity({ schemaVersion: "evleda.kicad-composite-library-policy.v1",
      stockPolicyIdentity: stockCapture?.policyIdentity ?? canonicalIdentity(this.#stockPolicy, "evleda.kicad-exact-stock-policy.v1"),
      packagePolicyIdentity: this.#policyIdentity }, "evleda.kicad-composite-library-policy.v1");
    this.#recapture();
    return createPcbLibrarySourceSelection({ policyIdentity, records }, selected);
  }
}

// Prevent replacing inspection/capture methods on a branded instance's prototype.
Object.freeze(KiCadApprovedPackageResolver.prototype);
