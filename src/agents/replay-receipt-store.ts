import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  opendir,
  rm
} from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import { replaceFileAtomically, syncContainingDirectory } from "../persistence/durability.js";
import { acquireExclusiveFileLock } from "../persistence/file-lock.js";
import {
  DESIGN_AGENT_PROMPT_PACK_SCHEMA,
  DESIGN_AGENT_PROVIDER_SCHEMA,
  DESIGN_AGENT_REPLAY_RECEIPT_SCHEMA,
  DESIGN_AGENT_REPLAY_SCHEMA,
  DESIGN_AGENT_TRUST_MANIFEST_SCHEMA,
  type DesignAgentReplayReceipt,
  type DesignAgentReplayReceiptStore
} from "./contracts.js";
import {
  assertAbsoluteOrdinaryDirectory,
  boundedIdentifier,
  contentIdentitiesEqual,
  copyBoundedOrdinaryUint8Array,
  deepFreezeProductionValue,
  plainDataProperties,
  productionAgentReject,
  readBoundedOrdinaryFile,
  snapshotAbsolutePath,
  snapshotContentIdentity
} from "./production-boundary.js";

export const DESIGN_AGENT_DURABLE_RECEIPT_RECORD_SCHEMA =
  "evleda.design-agent-durable-replay-receipt-record.v2" as const;
export const DESIGN_AGENT_DURABLE_RECEIPT_HEAD_SCHEMA =
  "evleda.design-agent-durable-replay-receipt-head.v1" as const;
export const DESIGN_AGENT_DURABLE_RECEIPT_AUTHENTICATION_SCHEMA =
  "evleda.design-agent-replay-receipt-authentication.v1" as const;
export const DESIGN_AGENT_DURABLE_RECEIPT_DIRECTORY_NAME = "receipts-v2" as const;
export const DESIGN_AGENT_DURABLE_RECEIPT_STAGING_DIRECTORY_NAME = "receipts-v2-staging" as const;
export const DESIGN_AGENT_DURABLE_RECEIPT_HEAD_NAME = "receipts-v2-head.json" as const;
export const DESIGN_AGENT_DURABLE_RECEIPT_LOCK_NAME = "receipts-v2.lock" as const;
export const DESIGN_AGENT_DURABLE_RECEIPT_MAX_RECORDS = 10_000;
export const DESIGN_AGENT_DURABLE_RECEIPT_MAX_RECORD_BYTES = 64 * 1024;
export const DESIGN_AGENT_DURABLE_RECEIPT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export const DESIGN_AGENT_DURABLE_RECEIPT_MAX_HEAD_BYTES = 8 * 1024;
export const DESIGN_AGENT_DURABLE_RECEIPT_MIN_KEY_BYTES = 32;
export const DESIGN_AGENT_DURABLE_RECEIPT_MAX_KEY_BYTES = 128;

export interface DurableDesignAgentReplayReceiptStoreOptions {
  /** Existing absolute ordinary directory owned by host composition. */
  readonly directoryPath: string;
  /** Stable deployment identifier included in every authenticated record. */
  readonly storeId: string;
  /** Stable identifier for the externally provisioned key; the key itself is never persisted. */
  readonly integrityKeyId: string;
  /** Independently provisioned high-entropy secret, synchronously copied before the first await. */
  readonly integrityKey: Uint8Array;
}

export type DurableDesignAgentReplayReceiptStore = DesignAgentReplayReceiptStore & {
  readonly authority: "durable_append_only_production";
};

export interface DurableDesignAgentReplayReceiptAuthentication {
  readonly schemaVersion: typeof DESIGN_AGENT_DURABLE_RECEIPT_AUTHENTICATION_SCHEMA;
  readonly algorithm: "hmac-sha256";
  readonly keyId: string;
  readonly mac: string;
}

export interface DurableDesignAgentReplayReceiptRecord {
  readonly schemaVersion: typeof DESIGN_AGENT_DURABLE_RECEIPT_RECORD_SCHEMA;
  readonly storeId: string;
  readonly sequence: number;
  readonly previousRecordIdentity: CanonicalIdentity | null;
  readonly receiptContentIdentity: ContentIdentity;
  readonly replayIdentity: CanonicalIdentity;
  readonly trustManifestIdentity: CanonicalIdentity;
  readonly providerIdentity: CanonicalIdentity;
  readonly promptPackIdentity: CanonicalIdentity;
  readonly receipt: DesignAgentReplayReceipt;
  readonly identity: CanonicalIdentity;
  readonly authentication: DurableDesignAgentReplayReceiptAuthentication;
}

export interface DurableDesignAgentReplayReceiptHead {
  readonly schemaVersion: typeof DESIGN_AGENT_DURABLE_RECEIPT_HEAD_SCHEMA;
  readonly storeId: string;
  readonly recordCount: number;
  readonly totalRecordBytes: number;
  readonly lastReceiptId: string | null;
  readonly lastRecordIdentity: CanonicalIdentity | null;
  readonly identity: CanonicalIdentity;
  readonly authentication: DurableDesignAgentReplayReceiptAuthentication;
}

export interface DurableDesignAgentReplayReceiptIntegrityReport {
  readonly storeId: string;
  readonly recordCount: number;
  readonly totalBytes: number;
  readonly headIdentity: CanonicalIdentity;
  readonly recordIdentities: readonly CanonicalIdentity[];
  /**
   * Detects tampering relative to the current authenticated head. Preventing rollback of the
   * entire directory to a previously authentic snapshot requires an external monotonic root.
   */
  readonly rollbackBoundary: "external_monotonic_root_required_for_historical_snapshot_rollback";
}

interface SnapshotStoreOptions {
  readonly directoryPath: string;
  readonly recordsPath: string;
  readonly stagingPath: string;
  readonly headPath: string;
  readonly lockPath: string;
  readonly storeId: string;
  readonly integrityKeyId: string;
  readonly integrityKey: Buffer;
}

interface ScannedRecord {
  readonly record: DurableDesignAgentReplayReceiptRecord;
  readonly byteLength: number;
}

interface ScannedRecords {
  readonly records: readonly ScannedRecord[];
  readonly byReceiptId: ReadonlyMap<string, ScannedRecord>;
  readonly totalBytes: number;
  readonly durableHead: DurableDesignAgentReplayReceiptHead;
  readonly derivedHead: DurableDesignAgentReplayReceiptHead;
  readonly headNeedsAdvance: boolean;
}

const FAILURE = "AGENT_DURABLE_REPLAY_RECEIPT_STORE_INVALID";
const identityEqual = (left: CanonicalIdentity, right: CanonicalIdentity): boolean =>
  canonicalJson(left) === canonicalJson(right);

const snapshotCanonicalIdentity = (
  value: unknown,
  schemaVersion: string,
  failureCode: string,
  label: string
): CanonicalIdentity => {
  const descriptors = plainDataProperties(
    value,
    ["algorithm", "digest", "schemaVersion", "canonicalizationVersion"],
    failureCode,
    label
  );
  const digest = descriptors.digest!.value;
  if (
    descriptors.algorithm!.value !== "sha256" ||
    typeof digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(digest) ||
    descriptors.schemaVersion!.value !== schemaVersion ||
    descriptors.canonicalizationVersion!.value !== "evleda-c14n-json-v1"
  ) {
    productionAgentReject(
      "DIGEST_MISMATCH",
      failureCode,
      `${label} is not a valid ${schemaVersion} canonical identity`
    );
  }
  return Object.freeze({
    algorithm: "sha256" as const,
    digest,
    schemaVersion,
    canonicalizationVersion: "evleda-c14n-json-v1" as const
  });
};

const hmac = (key: Buffer, value: unknown): string =>
  createHmac("sha256", key).update(canonicalJson(value), "utf8").digest("hex");

const macEqual = (left: string, right: string): boolean =>
  /^[0-9a-f]{64}$/u.test(left) &&
  /^[0-9a-f]{64}$/u.test(right) &&
  timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));

const authenticationFor = (
  signedValue: unknown,
  options: SnapshotStoreOptions
): DurableDesignAgentReplayReceiptAuthentication => Object.freeze({
  schemaVersion: DESIGN_AGENT_DURABLE_RECEIPT_AUTHENTICATION_SCHEMA,
  algorithm: "hmac-sha256" as const,
  keyId: options.integrityKeyId,
  mac: hmac(options.integrityKey, signedValue)
});

const validateAuthentication = (
  value: unknown,
  signedValue: unknown,
  options: SnapshotStoreOptions,
  label: string
): DurableDesignAgentReplayReceiptAuthentication => {
  const descriptors = plainDataProperties(
    value,
    ["schemaVersion", "algorithm", "keyId", "mac"],
    "AGENT_DURABLE_REPLAY_RECEIPT_AUTHENTICATION_INVALID",
    label
  );
  const mac = descriptors.mac!.value;
  if (
    descriptors.schemaVersion!.value !== DESIGN_AGENT_DURABLE_RECEIPT_AUTHENTICATION_SCHEMA ||
    descriptors.algorithm!.value !== "hmac-sha256" ||
    descriptors.keyId!.value !== options.integrityKeyId ||
    typeof mac !== "string" ||
    !macEqual(mac, hmac(options.integrityKey, signedValue))
  ) {
    productionAgentReject(
      "ARTIFACT_INTEGRITY_ERROR",
      "AGENT_DURABLE_REPLAY_RECEIPT_AUTHENTICATION_INVALID",
      `${label} does not authenticate with the independently provisioned store key`
    );
  }
  return Object.freeze({
    schemaVersion: DESIGN_AGENT_DURABLE_RECEIPT_AUTHENTICATION_SCHEMA,
    algorithm: "hmac-sha256" as const,
    keyId: options.integrityKeyId,
    mac
  });
};

const validateAndSnapshotReceipt = (value: unknown): DesignAgentReplayReceipt => {
  const descriptors = plainDataProperties(
    value,
    [
      "schemaVersion",
      "receiptId",
      "replayIdentity",
      "trustManifestIdentity",
      "providerIdentity",
      "promptPackIdentity",
      "identity"
    ],
    "AGENT_REPLAY_RECEIPT_INVALID",
    "replayReceipt"
  );
  if (descriptors.schemaVersion!.value !== DESIGN_AGENT_REPLAY_RECEIPT_SCHEMA) {
    productionAgentReject(
      "DIGEST_MISMATCH",
      "AGENT_REPLAY_RECEIPT_INVALID",
      "Replay receipt uses an unsupported schema"
    );
  }
  const receiptId = boundedIdentifier(
    descriptors.receiptId!.value,
    "AGENT_REPLAY_RECEIPT_INVALID",
    "replayReceipt.receiptId"
  );
  const payload = deepFreezeProductionValue({
    schemaVersion: DESIGN_AGENT_REPLAY_RECEIPT_SCHEMA,
    receiptId,
    replayIdentity: snapshotCanonicalIdentity(
      descriptors.replayIdentity!.value,
      DESIGN_AGENT_REPLAY_SCHEMA,
      "AGENT_REPLAY_RECEIPT_INVALID",
      "replayReceipt.replayIdentity"
    ),
    trustManifestIdentity: snapshotCanonicalIdentity(
      descriptors.trustManifestIdentity!.value,
      DESIGN_AGENT_TRUST_MANIFEST_SCHEMA,
      "AGENT_REPLAY_RECEIPT_INVALID",
      "replayReceipt.trustManifestIdentity"
    ),
    providerIdentity: snapshotCanonicalIdentity(
      descriptors.providerIdentity!.value,
      DESIGN_AGENT_PROVIDER_SCHEMA,
      "AGENT_REPLAY_RECEIPT_INVALID",
      "replayReceipt.providerIdentity"
    ),
    promptPackIdentity: snapshotCanonicalIdentity(
      descriptors.promptPackIdentity!.value,
      DESIGN_AGENT_PROMPT_PACK_SCHEMA,
      "AGENT_REPLAY_RECEIPT_INVALID",
      "replayReceipt.promptPackIdentity"
    )
  });
  if (receiptId !== `replay_${payload.replayIdentity.digest}`) {
    productionAgentReject(
      "DIGEST_MISMATCH",
      "AGENT_REPLAY_RECEIPT_INVALID",
      "Replay receipt ID is not derived from its replay identity"
    );
  }
  const identity = snapshotCanonicalIdentity(
    descriptors.identity!.value,
    DESIGN_AGENT_REPLAY_RECEIPT_SCHEMA,
    "AGENT_REPLAY_RECEIPT_INVALID",
    "replayReceipt.identity"
  );
  if (!identityEqual(identity, canonicalIdentity(payload, DESIGN_AGENT_REPLAY_RECEIPT_SCHEMA))) {
    productionAgentReject(
      "DIGEST_MISMATCH",
      "AGENT_REPLAY_RECEIPT_INVALID",
      "Replay receipt canonical identity does not reproduce"
    );
  }
  return deepFreezeProductionValue({ ...payload, identity });
};

const buildRecord = (
  receipt: DesignAgentReplayReceipt,
  sequence: number,
  previousRecordIdentity: CanonicalIdentity | null,
  options: SnapshotStoreOptions
): DurableDesignAgentReplayReceiptRecord => {
  const payload = deepFreezeProductionValue({
    schemaVersion: DESIGN_AGENT_DURABLE_RECEIPT_RECORD_SCHEMA,
    storeId: options.storeId,
    sequence,
    previousRecordIdentity,
    receiptContentIdentity: Object.freeze(contentIdentity(canonicalJson(receipt))),
    replayIdentity: receipt.replayIdentity,
    trustManifestIdentity: receipt.trustManifestIdentity,
    providerIdentity: receipt.providerIdentity,
    promptPackIdentity: receipt.promptPackIdentity,
    receipt
  });
  const identity = Object.freeze(
    canonicalIdentity(payload, DESIGN_AGENT_DURABLE_RECEIPT_RECORD_SCHEMA)
  );
  const signed = deepFreezeProductionValue({ ...payload, identity });
  return deepFreezeProductionValue({
    ...signed,
    authentication: authenticationFor(signed, options)
  });
};

const validateAndSnapshotRecord = (
  value: unknown,
  expectedReceiptId: string,
  canonicalBytes: Buffer,
  options: SnapshotStoreOptions
): DurableDesignAgentReplayReceiptRecord => {
  const descriptors = plainDataProperties(
    value,
    [
      "schemaVersion",
      "storeId",
      "sequence",
      "previousRecordIdentity",
      "receiptContentIdentity",
      "replayIdentity",
      "trustManifestIdentity",
      "providerIdentity",
      "promptPackIdentity",
      "receipt",
      "identity",
      "authentication"
    ],
    "AGENT_DURABLE_REPLAY_RECEIPT_RECORD_INVALID",
    "durableReplayReceiptRecord"
  );
  const sequence = descriptors.sequence!.value;
  if (
    descriptors.schemaVersion!.value !== DESIGN_AGENT_DURABLE_RECEIPT_RECORD_SCHEMA ||
    descriptors.storeId!.value !== options.storeId ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    sequence > DESIGN_AGENT_DURABLE_RECEIPT_MAX_RECORDS
  ) {
    productionAgentReject(
      "ARTIFACT_INTEGRITY_ERROR",
      "AGENT_DURABLE_REPLAY_RECEIPT_RECORD_INVALID",
      "Durable replay receipt has invalid store, schema, or sequence fields"
    );
  }
  const receipt = validateAndSnapshotReceipt(descriptors.receipt!.value);
  if (receipt.receiptId !== expectedReceiptId) {
    productionAgentReject(
      "ARTIFACT_INTEGRITY_ERROR",
      "AGENT_DURABLE_REPLAY_RECEIPT_RECORD_INVALID",
      "Durable receipt filename does not match its embedded receipt ID"
    );
  }
  const previousValue = descriptors.previousRecordIdentity!.value;
  const previousRecordIdentity = previousValue === null
    ? null
    : snapshotCanonicalIdentity(
        previousValue,
        DESIGN_AGENT_DURABLE_RECEIPT_RECORD_SCHEMA,
        "AGENT_DURABLE_REPLAY_RECEIPT_RECORD_INVALID",
        "durableReplayReceiptRecord.previousRecordIdentity"
      );
  const receiptContentIdentity = snapshotContentIdentity(
    descriptors.receiptContentIdentity!.value,
    "AGENT_DURABLE_REPLAY_RECEIPT_RECORD_INVALID",
    "durableReplayReceiptRecord.receiptContentIdentity"
  );
  if (!contentIdentitiesEqual(receiptContentIdentity, contentIdentity(canonicalJson(receipt)))) {
    productionAgentReject(
      "ARTIFACT_INTEGRITY_ERROR",
      "AGENT_DURABLE_REPLAY_RECEIPT_RECORD_INVALID",
      "Durable receipt content binding does not reproduce"
    );
  }
  const repeated = [
    ["replayIdentity", DESIGN_AGENT_REPLAY_SCHEMA, descriptors.replayIdentity!.value, receipt.replayIdentity],
    [
      "trustManifestIdentity",
      DESIGN_AGENT_TRUST_MANIFEST_SCHEMA,
      descriptors.trustManifestIdentity!.value,
      receipt.trustManifestIdentity
    ],
    ["providerIdentity", DESIGN_AGENT_PROVIDER_SCHEMA, descriptors.providerIdentity!.value, receipt.providerIdentity],
    [
      "promptPackIdentity",
      DESIGN_AGENT_PROMPT_PACK_SCHEMA,
      descriptors.promptPackIdentity!.value,
      receipt.promptPackIdentity
    ]
  ] as const;
  const bindings = repeated.map(([label, schema, candidate, expected]) => {
    const identity = snapshotCanonicalIdentity(
      candidate,
      schema,
      "AGENT_DURABLE_REPLAY_RECEIPT_RECORD_INVALID",
      `durableReplayReceiptRecord.${label}`
    );
    if (!identityEqual(identity, expected)) {
      productionAgentReject(
        "ARTIFACT_INTEGRITY_ERROR",
        "AGENT_DURABLE_REPLAY_RECEIPT_RECORD_INVALID",
        `Durable receipt ${label} differs from its embedded receipt binding`
      );
    }
    return identity;
  });
  const payload = deepFreezeProductionValue({
    schemaVersion: DESIGN_AGENT_DURABLE_RECEIPT_RECORD_SCHEMA,
    storeId: options.storeId,
    sequence: sequence as number,
    previousRecordIdentity,
    receiptContentIdentity,
    replayIdentity: bindings[0]!,
    trustManifestIdentity: bindings[1]!,
    providerIdentity: bindings[2]!,
    promptPackIdentity: bindings[3]!,
    receipt
  });
  const identity = snapshotCanonicalIdentity(
    descriptors.identity!.value,
    DESIGN_AGENT_DURABLE_RECEIPT_RECORD_SCHEMA,
    "AGENT_DURABLE_REPLAY_RECEIPT_RECORD_INVALID",
    "durableReplayReceiptRecord.identity"
  );
  if (!identityEqual(identity, canonicalIdentity(payload, DESIGN_AGENT_DURABLE_RECEIPT_RECORD_SCHEMA))) {
    productionAgentReject(
      "ARTIFACT_INTEGRITY_ERROR",
      "AGENT_DURABLE_REPLAY_RECEIPT_RECORD_INVALID",
      "Durable replay-receipt record identity does not reproduce"
    );
  }
  const signed = deepFreezeProductionValue({ ...payload, identity });
  const authentication = validateAuthentication(
    descriptors.authentication!.value,
    signed,
    options,
    "durableReplayReceiptRecord.authentication"
  );
  const record = deepFreezeProductionValue({ ...signed, authentication });
  if (!canonicalBytes.equals(Buffer.from(`${canonicalJson(record)}\n`, "utf8"))) {
    productionAgentReject(
      "ARTIFACT_INTEGRITY_ERROR",
      "AGENT_DURABLE_REPLAY_RECEIPT_RECORD_NOT_CANONICAL",
      "Durable receipt record is not exact canonical JSON with one trailing newline"
    );
  }
  return record;
};

const buildHead = (
  records: readonly ScannedRecord[],
  options: SnapshotStoreOptions
): DurableDesignAgentReplayReceiptHead => {
  const last = records.at(-1)?.record;
  const payload = deepFreezeProductionValue({
    schemaVersion: DESIGN_AGENT_DURABLE_RECEIPT_HEAD_SCHEMA,
    storeId: options.storeId,
    recordCount: records.length,
    totalRecordBytes: records.reduce((sum, record) => sum + record.byteLength, 0),
    lastReceiptId: last?.receipt.receiptId ?? null,
    lastRecordIdentity: last?.identity ?? null
  });
  const identity = Object.freeze(canonicalIdentity(payload, DESIGN_AGENT_DURABLE_RECEIPT_HEAD_SCHEMA));
  const signed = deepFreezeProductionValue({ ...payload, identity });
  return deepFreezeProductionValue({
    ...signed,
    authentication: authenticationFor(signed, options)
  });
};

const validateHead = (
  value: unknown,
  canonicalBytes: Buffer,
  options: SnapshotStoreOptions
): DurableDesignAgentReplayReceiptHead => {
  const descriptors = plainDataProperties(
    value,
    [
      "schemaVersion",
      "storeId",
      "recordCount",
      "totalRecordBytes",
      "lastReceiptId",
      "lastRecordIdentity",
      "identity",
      "authentication"
    ],
    "AGENT_DURABLE_REPLAY_RECEIPT_HEAD_INVALID",
    "durableReplayReceiptHead"
  );
  const recordCount = descriptors.recordCount!.value;
  const totalRecordBytes = descriptors.totalRecordBytes!.value;
  if (
    descriptors.schemaVersion!.value !== DESIGN_AGENT_DURABLE_RECEIPT_HEAD_SCHEMA ||
    descriptors.storeId!.value !== options.storeId ||
    !Number.isSafeInteger(recordCount) ||
    recordCount < 0 ||
    recordCount > DESIGN_AGENT_DURABLE_RECEIPT_MAX_RECORDS ||
    !Number.isSafeInteger(totalRecordBytes) ||
    totalRecordBytes < 0 ||
    totalRecordBytes > DESIGN_AGENT_DURABLE_RECEIPT_MAX_TOTAL_BYTES
  ) {
    productionAgentReject(
      "ARTIFACT_INTEGRITY_ERROR",
      "AGENT_DURABLE_REPLAY_RECEIPT_HEAD_INVALID",
      "Durable replay-receipt head has invalid store, schema, or bounded counters"
    );
  }
  const lastReceiptValue = descriptors.lastReceiptId!.value;
  const lastReceiptId = lastReceiptValue === null
    ? null
    : boundedIdentifier(
        lastReceiptValue,
        "AGENT_DURABLE_REPLAY_RECEIPT_HEAD_INVALID",
        "durableReplayReceiptHead.lastReceiptId"
      );
  const lastIdentityValue = descriptors.lastRecordIdentity!.value;
  const lastRecordIdentity = lastIdentityValue === null
    ? null
    : snapshotCanonicalIdentity(
        lastIdentityValue,
        DESIGN_AGENT_DURABLE_RECEIPT_RECORD_SCHEMA,
        "AGENT_DURABLE_REPLAY_RECEIPT_HEAD_INVALID",
        "durableReplayReceiptHead.lastRecordIdentity"
      );
  if (
    (recordCount === 0 && (lastReceiptId !== null || lastRecordIdentity !== null)) ||
    (recordCount > 0 && (lastReceiptId === null || lastRecordIdentity === null))
  ) {
    productionAgentReject(
      "ARTIFACT_INTEGRITY_ERROR",
      "AGENT_DURABLE_REPLAY_RECEIPT_HEAD_INVALID",
      "Durable replay-receipt head last-record fields disagree with its count"
    );
  }
  const payload = deepFreezeProductionValue({
    schemaVersion: DESIGN_AGENT_DURABLE_RECEIPT_HEAD_SCHEMA,
    storeId: options.storeId,
    recordCount: recordCount as number,
    totalRecordBytes: totalRecordBytes as number,
    lastReceiptId,
    lastRecordIdentity
  });
  const identity = snapshotCanonicalIdentity(
    descriptors.identity!.value,
    DESIGN_AGENT_DURABLE_RECEIPT_HEAD_SCHEMA,
    "AGENT_DURABLE_REPLAY_RECEIPT_HEAD_INVALID",
    "durableReplayReceiptHead.identity"
  );
  if (!identityEqual(identity, canonicalIdentity(payload, DESIGN_AGENT_DURABLE_RECEIPT_HEAD_SCHEMA))) {
    productionAgentReject(
      "ARTIFACT_INTEGRITY_ERROR",
      "AGENT_DURABLE_REPLAY_RECEIPT_HEAD_INVALID",
      "Durable replay-receipt head identity does not reproduce"
    );
  }
  const signed = deepFreezeProductionValue({ ...payload, identity });
  const authentication = validateAuthentication(
    descriptors.authentication!.value,
    signed,
    options,
    "durableReplayReceiptHead.authentication"
  );
  const head = deepFreezeProductionValue({ ...signed, authentication });
  if (!canonicalBytes.equals(Buffer.from(`${canonicalJson(head)}\n`, "utf8"))) {
    productionAgentReject(
      "ARTIFACT_INTEGRITY_ERROR",
      "AGENT_DURABLE_REPLAY_RECEIPT_HEAD_NOT_CANONICAL",
      "Durable replay-receipt head is not exact canonical JSON with one trailing newline"
    );
  }
  return head;
};

const snapshotOptions = (value: unknown): SnapshotStoreOptions => {
  const descriptors = plainDataProperties(
    value,
    ["directoryPath", "storeId", "integrityKeyId", "integrityKey"],
    FAILURE,
    "durableReplayReceiptStoreOptions"
  );
  const keyValue = descriptors.integrityKey!.value;
  const integrityKey = copyBoundedOrdinaryUint8Array(
    keyValue,
    DESIGN_AGENT_DURABLE_RECEIPT_MIN_KEY_BYTES,
    DESIGN_AGENT_DURABLE_RECEIPT_MAX_KEY_BYTES,
    FAILURE,
    "durableReplayReceiptStoreOptions.integrityKey"
  );
  const directoryPath = snapshotAbsolutePath(
    descriptors.directoryPath!.value,
    FAILURE,
    "durableReplayReceiptStoreOptions.directoryPath"
  );
  return Object.freeze({
    directoryPath,
    recordsPath: path.join(directoryPath, DESIGN_AGENT_DURABLE_RECEIPT_DIRECTORY_NAME),
    stagingPath: path.join(directoryPath, DESIGN_AGENT_DURABLE_RECEIPT_STAGING_DIRECTORY_NAME),
    headPath: path.join(directoryPath, DESIGN_AGENT_DURABLE_RECEIPT_HEAD_NAME),
    lockPath: path.join(directoryPath, DESIGN_AGENT_DURABLE_RECEIPT_LOCK_NAME),
    storeId: boundedIdentifier(
      descriptors.storeId!.value,
      FAILURE,
      "durableReplayReceiptStoreOptions.storeId"
    ),
    integrityKeyId: boundedIdentifier(
      descriptors.integrityKeyId!.value,
      FAILURE,
      "durableReplayReceiptStoreOptions.integrityKeyId"
    ),
    integrityKey
  });
};

const receiptFilename = (receiptId: string): string => `${receiptId}.json`;

const pathExists = async (candidate: string): Promise<boolean> => {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const parseStrictJson = (bytes: Buffer, failureCode: string, label: string): unknown => {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    productionAgentReject("ARTIFACT_INTEGRITY_ERROR", failureCode, `${label} is not strict UTF-8 JSON`);
  }
};

const boundedDirectoryEntries = async (
  directoryPath: string,
  maximumEntries: number,
  failureCode: string,
  label: string
): Promise<readonly Dirent[]> => {
  const directory = await opendir(directoryPath);
  const entries: Dirent[] = [];
  try {
    for await (const entry of directory) {
      entries.push(entry);
      if (entries.length > maximumEntries) {
        productionAgentReject(
          "ARTIFACT_INTEGRITY_ERROR",
          failureCode,
          `${label} exceeds its entry limit`
        );
      }
    }
  } finally {
    await directory.close().catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ERR_DIR_CLOSED") throw error;
    });
  }
  return entries;
};

const readHead = async (options: SnapshotStoreOptions): Promise<DurableDesignAgentReplayReceiptHead> => {
  const file = await readBoundedOrdinaryFile(
    options.headPath,
    DESIGN_AGENT_DURABLE_RECEIPT_MAX_HEAD_BYTES,
    "AGENT_DURABLE_REPLAY_RECEIPT_HEAD_INVALID",
    "Durable replay-receipt head"
  );
  return validateHead(parseStrictJson(
    file.bytes,
    "AGENT_DURABLE_REPLAY_RECEIPT_HEAD_INVALID",
    "Durable replay-receipt head"
  ), file.bytes, options);
};

const scanUnlocked = async (options: SnapshotStoreOptions): Promise<ScannedRecords> => {
  await assertAbsoluteOrdinaryDirectory(
    options.recordsPath,
    FAILURE,
    "Durable replay-receipt records directory"
  );
  const entries = await boundedDirectoryEntries(
    options.recordsPath,
    DESIGN_AGENT_DURABLE_RECEIPT_MAX_RECORDS,
    "AGENT_DURABLE_REPLAY_RECEIPT_COUNT_EXCEEDED",
    "Durable replay-receipt record directory"
  );
  const scanned: ScannedRecord[] = [];
  const byReceiptId = new Map<string, ScannedRecord>();
  let totalBytes = 0;
  for (const entry of entries) {
    const match = /^(replay_[0-9a-f]{64})\.json$/u.exec(entry.name);
    if (match === null || !entry.isFile() || entry.isSymbolicLink()) {
      productionAgentReject(
        "ARTIFACT_INTEGRITY_ERROR",
        "AGENT_DURABLE_REPLAY_RECEIPT_DIRECTORY_INVALID",
        "Durable replay-receipt directory contains an unexpected entry"
      );
    }
    const receiptId = match[1]!;
    const file = await readBoundedOrdinaryFile(
      path.join(options.recordsPath, entry.name),
      DESIGN_AGENT_DURABLE_RECEIPT_MAX_RECORD_BYTES,
      "AGENT_DURABLE_REPLAY_RECEIPT_RECORD_INVALID",
      "Durable replay-receipt record"
    );
    totalBytes += file.bytes.length;
    if (totalBytes > DESIGN_AGENT_DURABLE_RECEIPT_MAX_TOTAL_BYTES) {
      productionAgentReject(
        "ARTIFACT_INTEGRITY_ERROR",
        "AGENT_DURABLE_REPLAY_RECEIPT_BYTES_EXCEEDED",
        "Durable replay-receipt bytes exceed the fixed aggregate limit"
      );
    }
    const record = validateAndSnapshotRecord(
      parseStrictJson(
        file.bytes,
        "AGENT_DURABLE_REPLAY_RECEIPT_RECORD_INVALID",
        "Durable replay-receipt record"
      ),
      receiptId,
      file.bytes,
      options
    );
    if (byReceiptId.has(receiptId)) {
      productionAgentReject(
        "ARTIFACT_INTEGRITY_ERROR",
        "AGENT_DURABLE_REPLAY_RECEIPT_DUPLICATE",
        "Durable replay-receipt directory contains a duplicate receipt ID"
      );
    }
    const value = Object.freeze({ record, byteLength: file.bytes.length });
    scanned.push(value);
    byReceiptId.set(receiptId, value);
  }
  scanned.sort((left, right) => left.record.sequence - right.record.sequence);
  for (let index = 0; index < scanned.length; index += 1) {
    const current = scanned[index]!.record;
    const expectedPrevious = scanned[index - 1]?.record.identity ?? null;
    if (
      current.sequence !== index + 1 ||
      (current.previousRecordIdentity === null) !== (expectedPrevious === null) ||
      (current.previousRecordIdentity !== null &&
        expectedPrevious !== null &&
        !identityEqual(current.previousRecordIdentity, expectedPrevious))
    ) {
      productionAgentReject(
        "ARTIFACT_INTEGRITY_ERROR",
        "AGENT_DURABLE_REPLAY_RECEIPT_CHAIN_INVALID",
        "Durable replay-receipt sequence is duplicated, missing, reordered, or unlinked"
      );
    }
  }
  const durableHead = await readHead(options);
  if (durableHead.recordCount > scanned.length) {
    productionAgentReject(
      "ARTIFACT_INTEGRITY_ERROR",
      "AGENT_DURABLE_REPLAY_RECEIPT_TRUNCATED",
      "Durable replay-receipt records were removed behind the authenticated head"
    );
  }
  const durablePrefixHead = buildHead(scanned.slice(0, durableHead.recordCount), options);
  if (canonicalJson(durablePrefixHead) !== canonicalJson(durableHead)) {
    productionAgentReject(
      "ARTIFACT_INTEGRITY_ERROR",
      "AGENT_DURABLE_REPLAY_RECEIPT_HEAD_MISMATCH",
      "Authenticated replay-receipt head does not match its exact record prefix"
    );
  }
  const derivedHead = buildHead(scanned, options);
  return {
    records: Object.freeze(scanned),
    byReceiptId,
    totalBytes,
    durableHead,
    derivedHead,
    headNeedsAdvance: durableHead.recordCount < scanned.length
  };
};

const writeHead = async (
  head: DurableDesignAgentReplayReceiptHead,
  options: SnapshotStoreOptions,
  exclusive: boolean
): Promise<void> => {
  const bytes = Buffer.from(`${canonicalJson(head)}\n`, "utf8");
  if (bytes.length > DESIGN_AGENT_DURABLE_RECEIPT_MAX_HEAD_BYTES) {
    productionAgentReject(
      "ARTIFACT_INTEGRITY_ERROR",
      "AGENT_DURABLE_REPLAY_RECEIPT_HEAD_INVALID",
      "Durable replay-receipt head exceeds its byte limit"
    );
  }
  if (exclusive) {
    const staging = path.join(options.stagingPath, `.receipt-head-${randomUUID()}.tmp`);
    const handle = await open(staging, "wx");
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(staging, options.headPath);
      await syncContainingDirectory(options.headPath);
    } finally {
      await rm(staging, { force: true });
      await syncContainingDirectory(staging);
    }
  } else {
    const staging = path.join(options.stagingPath, `.receipt-head-${randomUUID()}.tmp`);
    const handle = await open(staging, "wx");
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await replaceFileAtomically(staging, options.headPath, bytes);
      await syncContainingDirectory(options.headPath);
    } finally {
      await rm(staging, { force: true });
      await syncContainingDirectory(staging);
    }
  }
  const published = await readBoundedOrdinaryFile(
    options.headPath,
    DESIGN_AGENT_DURABLE_RECEIPT_MAX_HEAD_BYTES,
    "AGENT_DURABLE_REPLAY_RECEIPT_HEAD_INVALID",
    "Published durable replay-receipt head"
  );
  if (!published.bytes.equals(bytes)) {
    productionAgentReject(
      "ARTIFACT_INTEGRITY_ERROR",
      "AGENT_DURABLE_REPLAY_RECEIPT_HEAD_MISMATCH",
      "Published replay-receipt head differs from its canonical bytes"
    );
  }
};

const cleanStagingUnlocked = async (options: SnapshotStoreOptions): Promise<void> => {
  await assertAbsoluteOrdinaryDirectory(
    options.stagingPath,
    FAILURE,
    "Replay-receipt staging directory"
  );
  const entries = await boundedDirectoryEntries(
    options.stagingPath,
    64,
    "AGENT_DURABLE_REPLAY_RECEIPT_STAGING_INVALID",
    "Replay-receipt staging directory"
  );
  for (const entry of entries) {
    if (
      !/^\.receipt(?:-head)?-[0-9a-f-]{36}\.tmp$/u.test(entry.name) ||
      !entry.isFile() ||
      entry.isSymbolicLink()
    ) {
      productionAgentReject(
        "ARTIFACT_INTEGRITY_ERROR",
        "AGENT_DURABLE_REPLAY_RECEIPT_STAGING_INVALID",
        "Replay-receipt staging directory contains an unexpected entry"
      );
    }
    await rm(path.join(options.stagingPath, entry.name));
  }
  if (entries.length > 0) await syncContainingDirectory(path.join(options.stagingPath, ".sync"));
};

const writeNewRecord = async (
  record: DurableDesignAgentReplayReceiptRecord,
  options: SnapshotStoreOptions
): Promise<number> => {
  const bytes = Buffer.from(`${canonicalJson(record)}\n`, "utf8");
  if (bytes.length > DESIGN_AGENT_DURABLE_RECEIPT_MAX_RECORD_BYTES) {
    productionAgentReject(
      "INVALID_ARGUMENT",
      "AGENT_DURABLE_REPLAY_RECEIPT_RECORD_TOO_LARGE",
      "Replay-receipt record exceeds its fixed byte limit"
    );
  }
  const staging = path.join(options.stagingPath, `.receipt-${randomUUID()}.tmp`);
  const target = path.join(options.recordsPath, receiptFilename(record.receipt.receiptId));
  const handle = await open(staging, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(staging, target);
    await syncContainingDirectory(target);
  } finally {
    await rm(staging, { force: true });
    await syncContainingDirectory(staging);
  }
  const published = await readBoundedOrdinaryFile(
    target,
    DESIGN_AGENT_DURABLE_RECEIPT_MAX_RECORD_BYTES,
    "AGENT_DURABLE_REPLAY_RECEIPT_RECORD_INVALID",
    "Published durable replay-receipt record"
  );
  if (!published.bytes.equals(bytes)) {
    productionAgentReject(
      "ARTIFACT_INTEGRITY_ERROR",
      "AGENT_DURABLE_REPLAY_RECEIPT_WRITE_MISMATCH",
      "Published replay-receipt bytes differ from the canonical record"
    );
  }
  return bytes.length;
};

const withExclusiveStore = async <Result>(
  options: SnapshotStoreOptions,
  work: () => Promise<Result>
): Promise<Result> => {
  await assertAbsoluteOrdinaryDirectory(options.directoryPath, FAILURE, "Replay-receipt store root");
  const before = await lstat(options.directoryPath);
  const release = await acquireExclusiveFileLock(options.lockPath);
  try {
    await assertAbsoluteOrdinaryDirectory(options.directoryPath, FAILURE, "Replay-receipt store root");
    const locked = await lstat(options.directoryPath);
    if (
      before.dev !== locked.dev ||
      before.ino !== locked.ino ||
      before.mode !== locked.mode ||
      !locked.isDirectory()
    ) {
      productionAgentReject(
        "ARTIFACT_INTEGRITY_ERROR",
        "AGENT_DURABLE_REPLAY_RECEIPT_PATH_DRIFT",
        "Replay-receipt store root changed while acquiring its exclusive lock"
      );
    }
    const result = await work();
    const after = await lstat(options.directoryPath);
    if (
      locked.dev !== after.dev ||
      locked.ino !== after.ino ||
      locked.mode !== after.mode ||
      !after.isDirectory()
    ) {
      productionAgentReject(
        "ARTIFACT_INTEGRITY_ERROR",
        "AGENT_DURABLE_REPLAY_RECEIPT_PATH_DRIFT",
        "Replay-receipt store root changed during the exclusive operation"
      );
    }
    return result;
  } finally {
    await release();
  }
};

const ensureDirectory = async (directoryPath: string): Promise<void> => {
  try {
    await mkdir(directoryPath);
    await syncContainingDirectory(directoryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
};

const initialize = async (options: SnapshotStoreOptions): Promise<ScannedRecords> =>
  await withExclusiveStore(options, async () => {
    const headExists = await pathExists(options.headPath);
    const recordsExist = await pathExists(options.recordsPath);
    await ensureDirectory(options.recordsPath);
    await ensureDirectory(options.stagingPath);
    await assertAbsoluteOrdinaryDirectory(options.recordsPath, FAILURE, "Replay-receipt records directory");
    await assertAbsoluteOrdinaryDirectory(options.stagingPath, FAILURE, "Replay-receipt staging directory");
    await cleanStagingUnlocked(options);
    if (!headExists && recordsExist) {
      const unheadedRecords = await boundedDirectoryEntries(
        options.recordsPath,
        DESIGN_AGENT_DURABLE_RECEIPT_MAX_RECORDS,
        "AGENT_DURABLE_REPLAY_RECEIPT_COUNT_EXCEEDED",
        "Unheaded replay-receipt record directory"
      );
      if (unheadedRecords.length > 0) {
        productionAgentReject(
          "ARTIFACT_INTEGRITY_ERROR",
          "AGENT_DURABLE_REPLAY_RECEIPT_HEAD_MISSING",
          "Existing replay-receipt records have no authenticated head"
        );
      }
    }
    if (!headExists) await writeHead(buildHead([], options), options, true);
    let scan = await scanUnlocked(options);
    if (scan.headNeedsAdvance) {
      await writeHead(scan.derivedHead, options, false);
      scan = await scanUnlocked(options);
    }
    return scan;
  });

const scanAndRepairUnlocked = async (options: SnapshotStoreOptions): Promise<ScannedRecords> => {
  await cleanStagingUnlocked(options);
  let scan = await scanUnlocked(options);
  if (scan.headNeedsAdvance) {
    await writeHead(scan.derivedHead, options, false);
    scan = await scanUnlocked(options);
  }
  return scan;
};

/**
 * Creates a compact authenticated receipt store. It does not persist the full frozen replay;
 * application composition must durably persist that separate payload and match its identity to a
 * receipt resolved here. The secret key must come from host configuration, never a request or the
 * receipt directory. Full historical-directory rollback additionally requires an external
 * monotonic root, as reported by the integrity scanner.
 */
export const createDurableDesignAgentReplayReceiptStore = async (
  optionsValue: DurableDesignAgentReplayReceiptStoreOptions
): Promise<DurableDesignAgentReplayReceiptStore> => {
  // Copy the path, IDs, and secret key before any filesystem await.
  const options = snapshotOptions(optionsValue);
  try {
    await initialize(options);
  } catch (error) {
    if (error instanceof Error && "failureCode" in error) throw error;
    productionAgentReject(
      "ARTIFACT_INTEGRITY_ERROR",
      FAILURE,
      "Durable replay-receipt store could not be initialized"
    );
  }

  const append = async (receiptValue: DesignAgentReplayReceipt): Promise<void> => {
    const receipt = validateAndSnapshotReceipt(receiptValue);
    await withExclusiveStore(options, async () => {
      // Authenticate the complete physical history before extending its head. This deliberately
      // favors fail-closed correctness over an index-only fast path that could append over a
      // corrupt interior record.
      const scan = await scanAndRepairUnlocked(options);
      const existing = scan.byReceiptId.get(receipt.receiptId)?.record;
      if (existing !== undefined) {
        const expected = buildRecord(
          receipt,
          existing.sequence,
          existing.previousRecordIdentity,
          options
        );
        if (canonicalJson(existing) !== canonicalJson(expected)) {
          productionAgentReject(
            "DIGEST_MISMATCH",
            "AGENT_REPLAY_RECEIPT_CONFLICT",
            "Append-only replay receipt ID already binds different authenticated content"
          );
        }
        return;
      }
      if (scan.records.length >= DESIGN_AGENT_DURABLE_RECEIPT_MAX_RECORDS) {
        productionAgentReject(
          "ARTIFACT_INTEGRITY_ERROR",
          "AGENT_DURABLE_REPLAY_RECEIPT_COUNT_EXCEEDED",
          "Durable replay-receipt record count limit has been reached"
        );
      }
      const record = buildRecord(
        receipt,
        scan.records.length + 1,
        scan.records.at(-1)?.record.identity ?? null,
        options
      );
      const encodedBytes = Buffer.byteLength(`${canonicalJson(record)}\n`, "utf8");
      if (scan.totalBytes + encodedBytes > DESIGN_AGENT_DURABLE_RECEIPT_MAX_TOTAL_BYTES) {
        productionAgentReject(
          "ARTIFACT_INTEGRITY_ERROR",
          "AGENT_DURABLE_REPLAY_RECEIPT_BYTES_EXCEEDED",
          "Durable replay-receipt aggregate byte limit has been reached"
        );
      }
      try {
        const byteLength = await writeNewRecord(record, options);
        const scannedRecord = Object.freeze({ record, byteLength });
        const nextHead = buildHead(
          [...scan.records, scannedRecord],
          options
        );
        await writeHead(nextHead, options, false);
      } catch (error) {
        const raced = await scanAndRepairUnlocked(options);
        const racedRecord = raced.byReceiptId.get(receipt.receiptId)?.record;
        if (racedRecord !== undefined && canonicalJson(racedRecord.receipt) === canonicalJson(receipt)) {
          // Publication may have succeeded before a sync/readback error. A successful authenticated
          // rescan and head repair establishes the exact idempotent outcome, so do not report a
          // false definitely-not-committed failure.
          return;
        }
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          productionAgentReject(
            "DIGEST_MISMATCH",
            "AGENT_REPLAY_RECEIPT_CONFLICT",
            "Replay receipt target was created concurrently with different authenticated content"
          );
        }
        throw error;
      }
    });
  };

  const resolve = async (receiptIdValue: string): Promise<unknown> => {
    const receiptId = boundedIdentifier(
      receiptIdValue,
      "AGENT_REPLAY_RECEIPT_INVALID",
      "receiptId"
    );
    return await withExclusiveStore(options, async () => {
      const scan = await scanAndRepairUnlocked(options);
      return scan.byReceiptId.get(receiptId)?.record.receipt;
    });
  };

  return Object.freeze({
    authority: "durable_append_only_production" as const,
    append,
    resolve
  });
};

export const scanDurableDesignAgentReplayReceiptStore = async (
  optionsValue: DurableDesignAgentReplayReceiptStoreOptions
): Promise<DurableDesignAgentReplayReceiptIntegrityReport> => {
  const options = snapshotOptions(optionsValue);
  return await withExclusiveStore(options, async () => {
    const scan = await scanAndRepairUnlocked(options);
    return deepFreezeProductionValue({
      storeId: options.storeId,
      recordCount: scan.records.length,
      totalBytes: scan.totalBytes,
      headIdentity: scan.derivedHead.identity,
      recordIdentities: Object.freeze(scan.records.map((entry) => entry.record.identity)),
      rollbackBoundary:
        "external_monotonic_root_required_for_historical_snapshot_rollback" as const
    });
  });
};
