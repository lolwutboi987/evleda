import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import type { PrivateRawCaptureReceiptV2 } from "../core/portable-artifact.js";

export const PRIVATE_KICAD_CAPTURE_STORE_PORT = Symbol("evleda.private-kicad-capture-store-port");

declare const privateKicadCaptureRecordIdBrand: unique symbol;
declare const privateKicadCaptureRootBrand: unique symbol;

/** Random, caller-retained retry identity. It deliberately carries no content digest or host path. */
export type PrivateKicadCaptureRecordId = string & {
  readonly [privateKicadCaptureRecordIdBrand]: "private-kicad-capture-record-id";
};

/** Root reserved exclusively for private KiCad capture data. */
export type PrivateKicadCaptureRoot = string & {
  readonly [privateKicadCaptureRootBrand]: "private-kicad-capture-root";
};

export const DURABLE_PRIVATE_KICAD_CAPTURE_AUTHORITY = "durable-private-production" as const;
export const MEMORY_PRIVATE_KICAD_CAPTURE_AUTHORITY = "memory-private-development-only" as const;

export type PrivateKicadCaptureStorageAuthority =
  | typeof DURABLE_PRIVATE_KICAD_CAPTURE_AUTHORITY
  | typeof MEMORY_PRIVATE_KICAD_CAPTURE_AUTHORITY;

export const PRIVATE_KICAD_CAPTURE_FILE_ROLES = Object.freeze([
  "raw",
  "source",
  "stdout",
  "stderr",
  "fullResult",
  "privateReceipt"
] as const);

export type PrivateKicadCaptureFileRole = typeof PRIVATE_KICAD_CAPTURE_FILE_ROLES[number];

export interface PrivateKicadCaptureFiles {
  readonly raw: Uint8Array;
  readonly source: Uint8Array;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly fullResult: Uint8Array;
  readonly privateReceipt: Uint8Array;
}

export type PrivateKicadCaptureFileIdentities = Readonly<
  Record<PrivateKicadCaptureFileRole, ContentIdentity>
>;

export interface PrivateKicadCaptureAppend {
  readonly recordId: PrivateKicadCaptureRecordId;
  readonly files: PrivateKicadCaptureFiles;
}

export interface PrivateKicadCaptureLimits {
  readonly maxBytesPerFile: number;
  readonly maxFilesPerCapture: number;
  readonly maxAggregateBytesPerCapture: number;
}

/**
 * Closed private command-result record. It binds the six stored byte roles without
 * asserting that the host, executable, or electrical result is authentic.
 */
export interface PrivateKicadFullResultV1 {
  readonly schemaVersion: "evleda.private-kicad-full-result.v1";
  readonly authority: "private-storage-consistency-only";
  readonly reportKind: PrivateRawCaptureReceiptV2["reportKind"];
  readonly rawContentIdentity: ContentIdentity;
  readonly sourceContentIdentity: ContentIdentity;
  readonly stdoutIdentity: ContentIdentity;
  readonly stderrIdentity: ContentIdentity;
  readonly commandPlanIdentity: CanonicalIdentity;
  readonly invocationIdentity: CanonicalIdentity;
  readonly captureIdentity: CanonicalIdentity;
  readonly privateReceiptContentIdentity: ContentIdentity;
  readonly privateReceiptRecordIdentity: CanonicalIdentity;
  readonly outcome: PrivateRawCaptureReceiptV2["outcome"];
  readonly exitCode: number | null;
  readonly releaseAuthorized: false;
  readonly resultIdentity: CanonicalIdentity;
}

export type PrivateKicadFullResultDraftV1 = Omit<PrivateKicadFullResultV1, "resultIdentity">;

export interface PrivateKicadCaptureRecord<
  Authority extends PrivateKicadCaptureStorageAuthority = PrivateKicadCaptureStorageAuthority
> {
  readonly schemaVersion: "evleda.private-kicad-capture-record.v1";
  readonly recordId: PrivateKicadCaptureRecordId;
  readonly storageAuthority: Authority;
  readonly files: PrivateKicadCaptureFileIdentities;
  readonly fullResultRecordIdentity: CanonicalIdentity;
  readonly privateReceiptRecordIdentity: CanonicalIdentity;
  readonly fileCount: 6;
  readonly aggregateSize: number;
  readonly releaseAuthorized: false;
  readonly recordManifestIdentity: CanonicalIdentity;
}

export interface PrivateKicadCaptureRead<
  Authority extends PrivateKicadCaptureStorageAuthority = PrivateKicadCaptureStorageAuthority
> {
  readonly record: PrivateKicadCaptureRecord<Authority>;
  /** Every read returns new buffers verified against the durable record. */
  readonly files: Readonly<Record<PrivateKicadCaptureFileRole, Buffer>>;
  readonly fullResult: PrivateKicadFullResultV1;
  readonly privateReceipt: PrivateRawCaptureReceiptV2;
}

/**
 * Intentionally not structurally compatible with the public ContentStorePort:
 * it has a private brand/root and capture-level methods rather than generic put/get methods.
 */
export interface PrivateKicadCaptureStorePort<
  Authority extends PrivateKicadCaptureStorageAuthority = PrivateKicadCaptureStorageAuthority
> {
  readonly [PRIVATE_KICAD_CAPTURE_STORE_PORT]: true;
  readonly storageAuthority: Authority;
  readonly privateRoot: PrivateKicadCaptureRoot;
  readonly limits: PrivateKicadCaptureLimits;
  initialize(): Promise<void>;
  mintRecordId(): PrivateKicadCaptureRecordId;
  appendCapture(input: PrivateKicadCaptureAppend): Promise<PrivateKicadCaptureRecord<Authority>>;
  readCapture(recordId: PrivateKicadCaptureRecordId): Promise<PrivateKicadCaptureRead<Authority>>;
  verifyCapture(recordId: PrivateKicadCaptureRecordId): Promise<PrivateKicadCaptureRecord<Authority>>;
}

export type DurablePrivateKicadCaptureStorePort = PrivateKicadCaptureStorePort<
  typeof DURABLE_PRIVATE_KICAD_CAPTURE_AUTHORITY
>;

/** Memory stores are development-only and cannot satisfy a production durable-store port. */
export type DevelopmentMemoryPrivateKicadCaptureStorePort = PrivateKicadCaptureStorePort<
  typeof MEMORY_PRIVATE_KICAD_CAPTURE_AUTHORITY
>;
