import { isProxy } from "node:util/types";
import { z } from "zod";
import { canonicalIdentity, canonicalJson } from "../core/canonical.js";
import { hardenPortableValue } from "../core/portable-artifact.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import type { PcbLibraryBinding, PcbReadOnlyLibraryResolver, PcbResolvedSymbol, PcbResolvedFootprint } from "./pcb-design-compiler.js";
import { authenticateKiCadApprovedPackageRecord, hasKiCadApprovedPackageAuthority } from "./kicad-approved-package.js";

export const PCB_LIBRARY_SOURCE_SELECTION_SCHEMA_VERSION = "evleda.pcb-library-source-selection.v1" as const;
export const PCB_LIBRARY_SOURCE_SELECTION_LIMITS = Object.freeze({ maxIdsPerKind: 64, maxBytes: 128 * 1024 });

export interface PcbLibrarySourceSelectionRequest {
  readonly symbolIds: readonly string[];
  readonly footprintIds: readonly string[];
}
export interface PcbLibrarySourceSelectionRecord {
  readonly kind: "symbol" | "footprint";
  readonly libraryId: string;
  readonly sourceIdentity: ContentIdentity;
  readonly inspectionIdentity: CanonicalIdentity;
  /** Present only for an explicitly host-approved, local external package. */
  readonly approvedPackage?: {
    readonly policyIdentity: CanonicalIdentity;
    readonly manifestIdentity: ContentIdentity;
    readonly tableUri: string;
  } | undefined;
}
export interface PcbLibrarySourceSelection {
  readonly schemaVersion: typeof PCB_LIBRARY_SOURCE_SELECTION_SCHEMA_VERSION;
  /** Stock selections expose no paths; approved external packages deliberately bind local table URIs. */
  readonly policyIdentity: CanonicalIdentity;
  readonly records: readonly PcbLibrarySourceSelectionRecord[];
  readonly identity: CanonicalIdentity;
}

const identitySchema = z.object({ algorithm: z.literal("sha256"), digest: z.string().regex(/^[a-f0-9]{64}$/u),
  schemaVersion: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,127}$/u), canonicalizationVersion: z.literal("evleda-c14n-json-v1") }).strict();
const libraryIdSchema = z.string().min(3).max(192).regex(/^[^\s:\u0000-\u001f\u007f]+:[^\s:\u0000-\u001f\u007f]+$/u);
const contentSchema = z.object({ algorithm: z.literal("sha256"), digest: z.string().regex(/^[a-f0-9]{64}$/u),
  size: z.number().int().min(1).max(24 * 1024 * 1024) }).strict();
const packageSchema = z.object({ policyIdentity: identitySchema, manifestIdentity: contentSchema,
  tableUri: z.string().min(1).max(768).regex(/^(?:[A-Za-z]:\/|\/)[^\u0000-\u001f\u007f"\\$]*$/u) }).strict();
const recordSchema = z.object({ kind: z.enum(["symbol", "footprint"]), libraryId: libraryIdSchema,
  sourceIdentity: contentSchema, inspectionIdentity: identitySchema, approvedPackage: packageSchema.optional() }).strict()
  .superRefine((record, context) => {
    const expected = record.approvedPackage === undefined
      ? record.kind === "symbol" ? "evleda.kicad-stock-symbol-inspection.v1" : "evleda.kicad-stock-footprint-inspection.v2"
      : record.kind === "symbol" ? "evleda.kicad-approved-symbol-inspection.v1" : "evleda.kicad-approved-footprint-inspection.v1";
    if (record.inspectionIdentity.schemaVersion !== expected) context.addIssue({ code: "custom", message: "Source selection inspection family differs from its asset kind" });
    if (record.approvedPackage !== undefined && (record.approvedPackage.policyIdentity.schemaVersion !== "evleda.kicad-approved-package-policy.v1"
      || !record.libraryId.startsWith("EvlEDA_") || record.sourceIdentity.size > 512 * 1024)) {
      context.addIssue({ code: "custom", message: "Approved package policy, namespace or source limit is invalid" });
    }
    if (record.kind === "footprint" && record.sourceIdentity.size > 512 * 1024) context.addIssue({ code: "custom", message: "Footprint source exceeds its byte limit" });
  });
const payloadSchema = z.object({ schemaVersion: z.literal(PCB_LIBRARY_SOURCE_SELECTION_SCHEMA_VERSION),
  policyIdentity: identitySchema, records: z.array(recordSchema).max(128) }).strict();
const requestSchema = z.object({ symbolIds: z.array(libraryIdSchema).max(64), footprintIds: z.array(libraryIdSchema).max(64) }).strict();
const snapshot = (value: unknown): unknown => hardenPortableValue(value, { maxBytes: PCB_LIBRARY_SOURCE_SELECTION_LIMITS.maxBytes,
  maxDepth: 8, maxNodes: 4096, maxArrayLength: 128, maxOwnKeys: 8, maxStringBytes: 768 });
const freeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") { for (const entry of Object.values(value)) freeze(entry); Object.freeze(value); }
  return value;
};
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const recordKey = (record: Pick<PcbLibrarySourceSelectionRecord, "kind" | "libraryId">): string => `${record.kind}:${record.libraryId}`;

/** Canonical selected IDs, never discovery/search results or filesystem paths. */
export function normalizePcbLibrarySourceSelectionRequest(value: PcbLibrarySourceSelectionRequest): PcbLibrarySourceSelectionRequest {
  const parsed = requestSchema.parse(snapshot(value));
  for (const ids of [parsed.symbolIds, parsed.footprintIds]) {
    if (new Set(ids).size !== ids.length) throw new Error("Library source selection contains duplicate selected IDs");
    ids.sort(compare);
  }
  return freeze(parsed);
}

function requireExactSelection(records: readonly PcbLibrarySourceSelectionRecord[], request: PcbLibrarySourceSelectionRequest): void {
  const selected = normalizePcbLibrarySourceSelectionRequest(request);
  const expected = [...selected.symbolIds.map(libraryId => `symbol:${libraryId}`), ...selected.footprintIds.map(libraryId => `footprint:${libraryId}`)].sort(compare);
  const actual = records.map(recordKey);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("Library source selection must be sorted, unique, and exactly match the selected symbol and footprint IDs");
  }
  const tables = new Map<string, string>();
  let packagePolicy: string | undefined;
  for (const record of records) {
    const key = `${record.kind}:${record.libraryId.split(":")[0]}`;
    const value = record.approvedPackage === undefined ? "stock" : canonicalJson(record.approvedPackage);
    if (tables.has(key) && tables.get(key) !== value) throw new Error("Library namespace has conflicting source authority");
    tables.set(key, value);
    if (record.approvedPackage !== undefined) {
      const policy = canonicalJson([record.approvedPackage.policyIdentity, record.approvedPackage.manifestIdentity]);
      if (packagePolicy !== undefined && packagePolicy !== policy) throw new Error("Only one approved library package is supported");
      packagePolicy = policy;
    }
  }
}

type ResolvedRecord = PcbResolvedSymbol | PcbResolvedFootprint;

export function isPcbLibraryRecordAuthorized(resolver: PcbReadOnlyLibraryResolver, kind: "symbol" | "footprint",
  record: ResolvedRecord, selection: PcbLibrarySourceSelection | undefined): boolean {
  const pinned = selection?.records.find(entry => entry.kind === kind && entry.libraryId === record.libraryId);
  if (record.source === "kicad-stock") return pinned?.approvedPackage === undefined;
  try { return pinned?.approvedPackage !== undefined && authenticateKiCadApprovedPackageRecord(resolver, kind, record, pinned); }
  catch { return false; }
}

/** Structural artifact consistency; current host authority must still be reproduced before execution. */
export function assertPcbLibraryBindingSourceKinds(binding: Pick<PcbLibraryBinding, "symbols" | "footprints" | "sourceSelection">): void {
  for (const [kind, records] of [["symbol", binding.symbols], ["footprint", binding.footprints]] as const) {
    for (const record of records) {
      const pinned = binding.sourceSelection?.records.find(entry => entry.kind === kind && entry.libraryId === record.libraryId);
      if ((record.source === "project-custom") !== (pinned?.approvedPackage !== undefined)) throw new Error("Library source kind differs from bound package inspection authority");
    }
  }
}

/** Host-side assembly helper. Its result is data; only a host-owned resolver provides source authority. */
export function createPcbLibrarySourceSelection(input: { readonly policyIdentity: CanonicalIdentity;
  readonly records: readonly PcbLibrarySourceSelectionRecord[] }, selected: PcbLibrarySourceSelectionRequest): PcbLibrarySourceSelection {
  const value = z.object({ policyIdentity: identitySchema, records: z.array(recordSchema).max(128) }).strict().parse(snapshot(input));
  value.records.sort((a, b) => compare(recordKey(a), recordKey(b)));
  const payload = { schemaVersion: PCB_LIBRARY_SOURCE_SELECTION_SCHEMA_VERSION, ...value };
  requireExactSelection(payload.records, selected);
  return freeze({ ...payload, identity: canonicalIdentity(payload, PCB_LIBRARY_SOURCE_SELECTION_SCHEMA_VERSION) });
}

export function parsePcbLibrarySourceSelection(input: unknown, selected: PcbLibrarySourceSelectionRequest): PcbLibrarySourceSelection {
  const value = payloadSchema.extend({ identity: identitySchema }).parse(snapshot(input));
  const { identity, ...payload } = value;
  requireExactSelection(payload.records, selected);
  if (canonicalJson(identity) !== canonicalJson(canonicalIdentity(payload, PCB_LIBRARY_SOURCE_SELECTION_SCHEMA_VERSION))) {
    throw new Error("Library source selection identity mismatch");
  }
  return freeze(value);
}

/** Read an optional host capability without executing an accessor or accepting JSON-shaped authority. */
export function capturePcbLibrarySourceSelection(resolver: PcbReadOnlyLibraryResolver,
  selected: PcbLibrarySourceSelectionRequest): PcbLibrarySourceSelection | undefined {
  if (resolver === null || typeof resolver !== "object" || isProxy(resolver)) throw new Error("Library source resolver must be a non-proxy host object");
  let cursor: object | null = resolver;
  while (cursor !== null) {
    if (isProxy(cursor)) throw new Error("Library source resolver prototype must be a non-proxy host object");
    const descriptor = Object.getOwnPropertyDescriptor(cursor, "captureSourceSelection");
    if (descriptor !== undefined) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") throw new Error("Library source capture must be a host data method");
      const request = normalizePcbLibrarySourceSelectionRequest(selected);
      return parsePcbLibrarySourceSelection(Reflect.apply(descriptor.value, resolver, [request]), request);
    }
    cursor = Object.getPrototypeOf(cursor);
  }
  return undefined;
}

/** Enforce coherent source capture on both sides of normalized library resolution. */
export function assertPcbLibrarySourceSelectionStable(before: PcbLibrarySourceSelection | undefined,
  after: PcbLibrarySourceSelection | undefined): void {
  if ((before === undefined) !== (after === undefined) || (before !== undefined && canonicalJson(before) !== canonicalJson(after))) {
    throw new Error("Selected library sources or host catalog policy changed during library resolution");
  }
}

/** Reproduce existing pins before a host allocates or opens a native session. Never mint historical pins from IDs. */
export function assertPcbLibrarySourcesCurrent(binding: PcbLibraryBinding, resolver: PcbReadOnlyLibraryResolver): void {
  assertPcbLibraryBindingSourceKinds(binding);
  if ([...binding.symbols, ...binding.footprints].some(record => record.source === "project-custom") && !hasKiCadApprovedPackageAuthority(resolver)) {
    throw new Error("Custom library sources require the original host-approved package resolver");
  }
  const selected = { symbolIds: [...new Set(binding.symbols.map(symbol => symbol.libraryId))],
    footprintIds: [...new Set(binding.footprints.map(footprint => footprint.libraryId))] };
  const pinned = Object.hasOwn(binding, "sourceSelection") ? parsePcbLibrarySourceSelection(binding.sourceSelection, selected) : undefined;
  const current = capturePcbLibrarySourceSelection(resolver, selected);
  assertPcbLibrarySourceSelectionStable(pinned, current);
}
