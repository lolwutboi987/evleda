import { randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { isProxy } from "node:util/types";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm
} from "node:fs/promises";
import path from "node:path";
import {
  canonicalIdentity,
  canonicalJson,
  constantTimeDigestEqual,
  contentIdentity
} from "../core/canonical.js";
import {
  canonicalPortableJson,
  parsePortableJsonBytes,
  parsePrivateRawCaptureReceiptV2Bytes,
  portableCanonicalIdentity
} from "../core/portable-artifact.js";
import { DomainError } from "../domain/errors.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import { syncContainingDirectory } from "./durability.js";
import { acquireExclusiveFileLock } from "./file-lock.js";
import {
  DURABLE_PRIVATE_KICAD_CAPTURE_AUTHORITY,
  PRIVATE_KICAD_CAPTURE_FILE_ROLES,
  PRIVATE_KICAD_CAPTURE_STORE_PORT,
  type DurablePrivateKicadCaptureStorePort,
  type PrivateKicadCaptureAppend,
  type PrivateKicadCaptureFileIdentities,
  type PrivateKicadCaptureFileRole,
  type PrivateKicadCaptureFiles,
  type PrivateKicadCaptureLimits,
  type PrivateKicadCaptureRead,
  type PrivateKicadCaptureRecord,
  type PrivateKicadCaptureRecordId,
  type PrivateKicadCaptureRoot,
  type PrivateKicadFullResultDraftV1,
  type PrivateKicadFullResultV1
} from "./private-kicad-capture-port.js";

const STORE_SCHEMA_VERSION = "evleda.private-kicad-capture-store.v1" as const;
const RECORD_SCHEMA_VERSION = "evleda.private-kicad-capture-record.v1" as const;
const RECORD_ID_PATTERN = /^pkc_[0-9a-f]{32}$/u;
const RECORD_FILE_MAX_BYTES = 32_768;
const READ_OPEN_FLAGS = process.platform === "win32"
  ? fsConstants.O_RDONLY
  : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
const ReflectApply = Reflect.apply;
const FunctionHasInstance = Function.prototype[Symbol.hasInstance];
const IntrinsicUint8Array = Uint8Array;
const IntrinsicUint8ArraySet = Uint8Array.prototype.set;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const typedArrayByteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get;
const IntrinsicSharedArrayBuffer = typeof SharedArrayBuffer === "undefined" ? undefined : SharedArrayBuffer;
const CAPTURE_FILE_ROLES = Object.freeze([
  ...PRIVATE_KICAD_CAPTURE_FILE_ROLES
] as const);

const ROOT_MARKER = ".evleda-private-kicad-capture-store.json";
const ROOT_MARKER_BYTES = Buffer.from(`${canonicalJson({
  schemaVersion: STORE_SCHEMA_VERSION,
  storageAuthority: DURABLE_PRIVATE_KICAD_CAPTURE_AUTHORITY
})}\n`, "utf8");

const DEFAULT_LIMITS: PrivateKicadCaptureLimits = Object.freeze({
  maxBytesPerFile: 64 * 1024 * 1024,
  maxFilesPerCapture: CAPTURE_FILE_ROLES.length,
  maxAggregateBytesPerCapture: 192 * 1024 * 1024
});

const HARD_LIMITS: PrivateKicadCaptureLimits = Object.freeze({
  maxBytesPerFile: 256 * 1024 * 1024,
  maxFilesPerCapture: CAPTURE_FILE_ROLES.length,
  maxAggregateBytesPerCapture: 768 * 1024 * 1024
});

export interface PrivateKicadCaptureDisjointRoot {
  readonly label: string;
  readonly path: string;
}

export interface PrivateKicadCaptureRootBoundaryObservation {
  readonly phase: "before-create" | "after-create" | "operation";
  readonly privateRoot: string;
  readonly canonicalPrivateRoot: string;
  readonly disjointRoot: PrivateKicadCaptureDisjointRoot;
  readonly canonicalDisjointRoot: string;
}

export interface DurablePrivateKicadCaptureStoreOptions {
  readonly privateRoot: string;
  /** Must include the public content-store root; all entries are enforced as non-overlapping. */
  readonly disjointFrom: readonly PrivateKicadCaptureDisjointRoot[];
  readonly limits?: Partial<PrivateKicadCaptureLimits>;
  /** Additional factory/host boundary assertion. The store's own overlap rejection always runs first. */
  readonly rootBoundaryHook?: (
    observation: PrivateKicadCaptureRootBoundaryObservation
  ) => void | Promise<void>;
}

interface CapturedAppend {
  readonly recordId: PrivateKicadCaptureRecordId;
  readonly files: Readonly<Record<PrivateKicadCaptureFileRole, Buffer>>;
  readonly record: PrivateKicadCaptureRecord<typeof DURABLE_PRIVATE_KICAD_CAPTURE_AUTHORITY>;
  readonly serializedRecord: Buffer;
}

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;

const normalizeForComparison = (value: string): string =>
  process.platform === "win32" ? value.toLowerCase() : value;

const isWithin = (root: string, candidate: string): boolean => {
  const relative = path.relative(
    normalizeForComparison(root),
    normalizeForComparison(candidate)
  );
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

const pathsOverlap = (left: string, right: string): boolean =>
  isWithin(left, right) || isWithin(right, left);

const fail = (
  code: ConstructorParameters<typeof DomainError>[0],
  message: string,
  details: Readonly<Record<string, unknown>> = {}
): never => {
  throw new DomainError(code, message, details);
};

const validateRecordId = (value: unknown): PrivateKicadCaptureRecordId => {
  if (typeof value !== "string" || !RECORD_ID_PATTERN.test(value)) {
    return fail("INVALID_ARGUMENT", "Invalid opaque private-capture record identity");
  }
  return value as PrivateKicadCaptureRecordId;
};

const exactDataRecord = (
  value: unknown,
  keys: readonly string[],
  label: string
): Readonly<Record<string, unknown>> => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    return fail("INVALID_ARGUMENT", `${label} must be a plain non-proxy object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(value);
  if (
    actual.some((key) => typeof key !== "string" || !keys.includes(key)) ||
    keys.some((key) => {
      const descriptor = descriptors[key];
      return descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined;
    }) ||
    actual.length !== keys.length
  ) {
    return fail("INVALID_ARGUMENT", `${label} fields must be exact enumerable data properties`);
  }
  return value as Readonly<Record<string, unknown>>;
};

const optionalDataRecord = (
  value: unknown,
  allowedKeys: readonly string[],
  label: string
): Readonly<Record<string, unknown>> => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    return fail("INVALID_ARGUMENT", `${label} must be a plain non-proxy object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(value);
  if (
    actual.some((key) => typeof key !== "string" || !allowedKeys.includes(key)) ||
    actual.some((key) => {
      if (typeof key !== "string") return true;
      const descriptor = descriptors[key];
      return descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined;
    })
  ) {
    return fail("INVALID_ARGUMENT", `${label} fields must be allowed enumerable data properties`);
  }
  return value as Readonly<Record<string, unknown>>;
};

const resolveLimits = (
  overrides: Partial<PrivateKicadCaptureLimits> | undefined
): PrivateKicadCaptureLimits => {
  if (overrides === undefined) return DEFAULT_LIMITS;
  const record = optionalDataRecord(
    overrides,
    Object.keys(DEFAULT_LIMITS),
    "Private-capture limit overrides"
  );
  const resolved = {
    ...DEFAULT_LIMITS,
    ...record
  } as unknown as PrivateKicadCaptureLimits;
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof PrivateKicadCaptureLimits)[]) {
    const value = resolved[key];
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > HARD_LIMITS[key]
    ) {
      return fail("INVALID_ARGUMENT", "Private-capture limit is outside the closed range", {
        key,
        value,
        hardMaximum: HARD_LIMITS[key]
      });
    }
  }
  return Object.freeze({ ...resolved });
};

const assertAbsoluteRoot = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim().length === 0 || !path.isAbsolute(value)) {
    return fail("INVALID_ARGUMENT", `${label} must be a non-empty absolute path`);
  }
  const resolved = path.resolve(value);
  if (normalizeForComparison(resolved) === normalizeForComparison(path.parse(resolved).root)) {
    return fail("INVALID_ARGUMENT", `${label} cannot be a filesystem root`);
  }
  return resolved;
};

const assertNoExistingLinkComponents = async (candidate: string): Promise<void> => {
  const parsed = path.parse(candidate);
  const relative = path.relative(parsed.root, candidate);
  let cursor = parsed.root;
  for (const component of relative.split(path.sep).filter((entry) => entry.length > 0)) {
    cursor = path.join(cursor, component);
    let metadata: Stats;
    try {
      metadata = await lstat(cursor);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      return fail(
        "PATH_OUTSIDE_WORKSPACE",
        "Private-capture root traverses a symbolic link, junction, or reparse point",
        { component: cursor }
      );
    }
    if (!metadata.isDirectory() && normalizeForComparison(cursor) !== normalizeForComparison(candidate)) {
      return fail("PATH_OUTSIDE_WORKSPACE", "Private-capture root ancestor is not a directory", {
        component: cursor
      });
    }
  }
};

const canonicalProspectiveDirectory = async (
  candidate: string,
  rejectLinks: boolean,
  label: string
): Promise<string> => {
  let cursor = path.resolve(candidate);
  const suffix: string[] = [];
  while (true) {
    try {
      const metadata = await lstat(cursor);
      if (rejectLinks && metadata.isSymbolicLink()) {
        return fail(
          "PATH_OUTSIDE_WORKSPACE",
          `${label} resolves through a symbolic link, junction, or reparse point`,
          { component: cursor }
        );
      }
      if (metadata.isSymbolicLink()) {
        const resolvedLink = await realpath(cursor);
        const target = await lstat(resolvedLink);
        if (!target.isDirectory() || target.isSymbolicLink()) {
          return fail("INVALID_ARGUMENT", `${label} link target is not an ordinary directory`, {
            component: cursor
          });
        }
        return path.resolve(resolvedLink, ...suffix);
      }
      if (!metadata.isDirectory()) {
        return fail("INVALID_ARGUMENT", `${label} has a non-directory existing component`, {
          component: cursor
        });
      }
      return path.resolve(await realpath(cursor), ...suffix);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (errorCode(error) !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        return fail("INVALID_ARGUMENT", `${label} has no existing filesystem ancestor`);
      }
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
};

interface PhysicalDirectoryIdentity {
  readonly path: string;
  readonly key: string;
}

const physicalDirectoryIdentity = async (
  candidate: string,
  label: string
): Promise<PhysicalDirectoryIdentity> => {
  try {
    const metadata = await lstat(candidate, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isDirectory() || metadata.ino <= 0n || metadata.dev < 0n) {
      return fail(
        "POLICY_DENIED",
        `${label} lacks a provable ordinary-directory filesystem identity`,
        { candidate }
      );
    }
    return Object.freeze({
      path: candidate,
      key: `${metadata.dev.toString(10)}:${metadata.ino.toString(10)}`
    });
  } catch (error) {
    if (error instanceof DomainError) throw error;
    return fail(
      "POLICY_DENIED",
      `${label} filesystem identity could not be proven`,
      { candidate, causeCode: errorCode(error) }
    );
  }
};

const physicalDirectoryAncestors = async (
  candidate: string,
  label: string
): Promise<readonly PhysicalDirectoryIdentity[]> => {
  const identities: PhysicalDirectoryIdentity[] = [];
  let cursor = path.resolve(candidate);
  while (true) {
    identities.push(await physicalDirectoryIdentity(cursor, label));
    const parent = path.dirname(cursor);
    if (normalizeForComparison(parent) === normalizeForComparison(cursor)) break;
    cursor = parent;
  }
  return Object.freeze(identities);
};

const assertPhysicalRootsDisjoint = async (
  privateRoot: string,
  disjointRoot: string,
  label: string
): Promise<void> => {
  const [privateAncestors, disjointAncestors] = await Promise.all([
    physicalDirectoryAncestors(privateRoot, "Private-capture root"),
    physicalDirectoryAncestors(disjointRoot, `Disjoint root ${label}`)
  ]);
  const privateEndpoint = privateAncestors[0];
  const disjointEndpoint = disjointAncestors[0];
  if (privateEndpoint === undefined || disjointEndpoint === undefined) {
    return fail("POLICY_DENIED", "Filesystem identity ancestry could not prove root separation", {
      privateRoot,
      disjointRoot,
      label
    });
  }
  if (
    disjointAncestors.some((entry) => entry.key === privateEndpoint.key) ||
    privateAncestors.some((entry) => entry.key === disjointEndpoint.key)
  ) {
    return fail(
      "POLICY_DENIED",
      "Persistence roots overlap by filesystem-object ancestry",
      {
        privateRoot,
        disjointRoot,
        label,
        privateIdentity: privateEndpoint.key,
        disjointIdentity: disjointEndpoint.key
      }
    );
  }
};

interface NearestExistingDirectory {
  readonly canonicalPath: string;
  readonly candidateExists: boolean;
}

const nearestExistingDirectory = async (
  candidate: string
): Promise<NearestExistingDirectory> => {
  const requested = path.resolve(candidate);
  let cursor = requested;
  while (true) {
    try {
      const identity = await physicalDirectoryIdentity(cursor, "Proposed private persistence root ancestor");
      return Object.freeze({
        canonicalPath: await realpath(identity.path),
        candidateExists:
          normalizeForComparison(cursor) === normalizeForComparison(requested)
      });
    } catch (error) {
      if (error instanceof DomainError && error.details.causeCode === "ENOENT") {
        const parent = path.dirname(cursor);
        if (normalizeForComparison(parent) === normalizeForComparison(cursor)) throw error;
        cursor = parent;
        continue;
      }
      throw error;
    }
  }
};

const assertProspectivePrivateRootPhysicallyDisjoint = async (
  proposedPrivateRoot: string,
  disjointRoot: string,
  label: string
): Promise<void> => {
  const nearest = await nearestExistingDirectory(proposedPrivateRoot);
  if (nearest.candidateExists) {
    await assertPhysicalRootsDisjoint(nearest.canonicalPath, disjointRoot, label);
    return;
  }
  const [privateAncestorChain, disjointAncestorChain] = await Promise.all([
    physicalDirectoryAncestors(
      nearest.canonicalPath,
      "Proposed private persistence root ancestor"
    ),
    physicalDirectoryAncestors(disjointRoot, `Disjoint root ${label}`)
  ]);
  const disjointEndpoint = disjointAncestorChain[0];
  if (disjointEndpoint === undefined) {
    return fail("POLICY_DENIED", "Disjoint-root filesystem identity could not be proven", {
      proposedPrivateRoot,
      disjointRoot,
      label
    });
  }
  if (privateAncestorChain.some((entry) => entry.key === disjointEndpoint.key)) {
    return fail("POLICY_DENIED", "Proposed persistence root overlaps by filesystem-object ancestry", {
      proposedPrivateRoot,
      nearestExistingAncestor: nearest.canonicalPath,
      disjointRoot,
      label,
      disjointIdentity: disjointEndpoint.key
    });
  }
};

const validateContentIdentity = (value: unknown, label: string): ContentIdentity => {
  const record = exactDataRecord(value, ["algorithm", "digest", "size"], label);
  if (
    record.algorithm !== "sha256" ||
    typeof record.digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.digest) ||
    !Number.isSafeInteger(record.size) ||
    (record.size as number) < 0
  ) {
    return fail("ARTIFACT_INTEGRITY_ERROR", `${label} is invalid`);
  }
  return Object.freeze({
    algorithm: "sha256",
    digest: record.digest,
    size: record.size as number
  });
};

const validateCanonicalIdentity = (value: unknown, label: string): CanonicalIdentity => {
  const record = exactDataRecord(
    value,
    ["algorithm", "digest", "schemaVersion", "canonicalizationVersion"],
    label
  );
  if (
    record.algorithm !== "sha256" ||
    typeof record.digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.digest) ||
    typeof record.schemaVersion !== "string" ||
    record.schemaVersion.length === 0 ||
    record.canonicalizationVersion !== "evleda-c14n-json-v1"
  ) {
    return fail("ARTIFACT_INTEGRITY_ERROR", `${label} is invalid`);
  }
  return Object.freeze({
    algorithm: "sha256",
    digest: record.digest,
    schemaVersion: record.schemaVersion,
    canonicalizationVersion: "evleda-c14n-json-v1"
  });
};

const contentIdentitiesEqual = (left: ContentIdentity, right: ContentIdentity): boolean =>
  left.algorithm === right.algorithm &&
  left.size === right.size &&
  constantTimeDigestEqual(left.digest, right.digest);

const canonicalIdentitiesEqual = (left: CanonicalIdentity, right: CanonicalIdentity): boolean =>
  left.algorithm === right.algorithm &&
  left.schemaVersion === right.schemaVersion &&
  left.canonicalizationVersion === right.canonicalizationVersion &&
  constantTimeDigestEqual(left.digest, right.digest);

const PRIVATE_FULL_RESULT_SCHEMA = "evleda.private-kicad-full-result.v1" as const;
const PRIVATE_REPORT_KINDS = Object.freeze([
  "kicad_netlist",
  "kicad_erc",
  "kicad_drc",
  "kicad_stats",
  "kicad_d356",
  "kicad_pdf"
] as const);
const PRIVATE_OUTCOMES = Object.freeze([
  "succeeded",
  "failed",
  "timed_out",
  "not_run"
] as const);
const PRIVATE_FULL_RESULT_DRAFT_KEYS = Object.freeze([
  "schemaVersion",
  "authority",
  "reportKind",
  "rawContentIdentity",
  "sourceContentIdentity",
  "stdoutIdentity",
  "stderrIdentity",
  "commandPlanIdentity",
  "invocationIdentity",
  "captureIdentity",
  "privateReceiptContentIdentity",
  "privateReceiptRecordIdentity",
  "outcome",
  "exitCode",
  "releaseAuthorized"
] as const);

const privateFullResultPreimage = (
  result: PrivateKicadFullResultDraftV1
): Readonly<Record<string, unknown>> => ({
  schemaVersion: result.schemaVersion,
  authority: result.authority,
  reportKind: result.reportKind,
  rawContentIdentity: result.rawContentIdentity,
  sourceContentIdentity: result.sourceContentIdentity,
  stdoutIdentity: result.stdoutIdentity,
  stderrIdentity: result.stderrIdentity,
  commandPlanIdentity: result.commandPlanIdentity,
  invocationIdentity: result.invocationIdentity,
  captureIdentity: result.captureIdentity,
  privateReceiptContentIdentity: result.privateReceiptContentIdentity,
  privateReceiptRecordIdentity: result.privateReceiptRecordIdentity,
  outcome: result.outcome,
  exitCode: result.exitCode,
  releaseAuthorized: result.releaseAuthorized
});

const validatePrivateFullResultDraft = (value: unknown): PrivateKicadFullResultDraftV1 => {
  const safe = exactDataRecord(
    value,
    PRIVATE_FULL_RESULT_DRAFT_KEYS,
    "Private KiCad full-result draft"
  );
  if (
    safe.schemaVersion !== PRIVATE_FULL_RESULT_SCHEMA ||
    safe.authority !== "private-storage-consistency-only" ||
    !PRIVATE_REPORT_KINDS.includes(safe.reportKind as typeof PRIVATE_REPORT_KINDS[number]) ||
    !PRIVATE_OUTCOMES.includes(safe.outcome as typeof PRIVATE_OUTCOMES[number]) ||
    safe.releaseAuthorized !== false
  ) {
    return fail("INVALID_ARGUMENT", "Private KiCad full-result header is outside the closed schema");
  }
  const reportKind = safe.reportKind as PrivateKicadFullResultV1["reportKind"];
  const outcome = safe.outcome as PrivateKicadFullResultV1["outcome"];
  const exitCode = safe.exitCode === null
    ? null
    : Number.isSafeInteger(safe.exitCode) &&
        (safe.exitCode as number) >= 0 &&
        (safe.exitCode as number) <= 4_294_967_295
      ? safe.exitCode as number
      : fail("INVALID_ARGUMENT", "Private KiCad full-result exit code must be uint32 or null");
  if (
    (outcome === "succeeded" && (
      exitCode === null ||
      ((reportKind === "kicad_erc" || reportKind === "kicad_drc")
        ? ![0, 5].includes(exitCode)
        : exitCode !== 0)
    )) ||
    (outcome === "failed" && (exitCode === null || exitCode === 0)) ||
    ((outcome === "timed_out" || outcome === "not_run") && exitCode !== null)
  ) {
    return fail("INVALID_ARGUMENT", "Private KiCad full-result outcome/exit matrix is invalid");
  }
  const commandPlanIdentity = validateCanonicalIdentity(safe.commandPlanIdentity, "Full-result command identity");
  const invocationIdentity = validateCanonicalIdentity(safe.invocationIdentity, "Full-result invocation identity");
  const captureIdentity = validateCanonicalIdentity(safe.captureIdentity, "Full-result capture identity");
  const privateReceiptRecordIdentity = validateCanonicalIdentity(
    safe.privateReceiptRecordIdentity,
    "Full-result private-receipt record identity"
  );
  if (
    commandPlanIdentity.schemaVersion !== "evleda.typed-command-plan.v1" ||
    invocationIdentity.schemaVersion !== "evleda.tool-invocation.v1" ||
    captureIdentity.schemaVersion !== "evleda.raw-capture-key.v2" ||
    privateReceiptRecordIdentity.schemaVersion !== "evleda.private-raw-capture-receipt.v2"
  ) {
    return fail("INVALID_ARGUMENT", "Private KiCad full-result identity schema is invalid");
  }
  return Object.freeze({
    schemaVersion: PRIVATE_FULL_RESULT_SCHEMA,
    authority: "private-storage-consistency-only",
    reportKind,
    rawContentIdentity: validateContentIdentity(safe.rawContentIdentity, "Full-result raw identity"),
    sourceContentIdentity: validateContentIdentity(safe.sourceContentIdentity, "Full-result source identity"),
    stdoutIdentity: validateContentIdentity(safe.stdoutIdentity, "Full-result stdout identity"),
    stderrIdentity: validateContentIdentity(safe.stderrIdentity, "Full-result stderr identity"),
    commandPlanIdentity,
    invocationIdentity,
    captureIdentity,
    privateReceiptContentIdentity: validateContentIdentity(
      safe.privateReceiptContentIdentity,
      "Full-result private-receipt content identity"
    ),
    privateReceiptRecordIdentity,
    outcome,
    exitCode,
    releaseAuthorized: false
  });
};

const freezePrivateFullResult = (
  draft: PrivateKicadFullResultDraftV1,
  resultIdentity: CanonicalIdentity
): PrivateKicadFullResultV1 => Object.freeze({
  ...draft,
  rawContentIdentity: Object.freeze({ ...draft.rawContentIdentity }),
  sourceContentIdentity: Object.freeze({ ...draft.sourceContentIdentity }),
  stdoutIdentity: Object.freeze({ ...draft.stdoutIdentity }),
  stderrIdentity: Object.freeze({ ...draft.stderrIdentity }),
  commandPlanIdentity: Object.freeze({ ...draft.commandPlanIdentity }),
  invocationIdentity: Object.freeze({ ...draft.invocationIdentity }),
  captureIdentity: Object.freeze({ ...draft.captureIdentity }),
  privateReceiptContentIdentity: Object.freeze({ ...draft.privateReceiptContentIdentity }),
  privateReceiptRecordIdentity: Object.freeze({ ...draft.privateReceiptRecordIdentity }),
  resultIdentity: Object.freeze({ ...resultIdentity })
});

export const withPrivateKicadFullResultIdentity = (
  value: PrivateKicadFullResultDraftV1
): PrivateKicadFullResultV1 => {
  const draft = validatePrivateFullResultDraft(value);
  return freezePrivateFullResult(
    draft,
    portableCanonicalIdentity(privateFullResultPreimage(draft), PRIVATE_FULL_RESULT_SCHEMA)
  );
};

export const validatePrivateKicadFullResultV1 = (value: unknown): PrivateKicadFullResultV1 => {
  const safe = exactDataRecord(value, [
    ...PRIVATE_FULL_RESULT_DRAFT_KEYS,
    "resultIdentity"
  ], "Private KiCad full-result");
  const draft = validatePrivateFullResultDraft(Object.fromEntries(
    Object.entries(safe).filter(([key]) => key !== "resultIdentity")
  ));
  const resultIdentity = validateCanonicalIdentity(safe.resultIdentity, "Private full-result identity");
  const expected = portableCanonicalIdentity(privateFullResultPreimage(draft), PRIVATE_FULL_RESULT_SCHEMA);
  if (
    resultIdentity.schemaVersion !== PRIVATE_FULL_RESULT_SCHEMA ||
    !canonicalIdentitiesEqual(resultIdentity, expected)
  ) {
    return fail("INVALID_ARGUMENT", "Private KiCad full-result identity is invalid");
  }
  return freezePrivateFullResult(draft, resultIdentity);
};

export const parseCanonicalPrivateKicadFullResultV1Bytes = (
  bytes: Uint8Array
): PrivateKicadFullResultV1 => {
  const result = validatePrivateKicadFullResultV1(parsePortableJsonBytes(bytes));
  const expected = Buffer.from(`${canonicalPortableJson(result)}\n`, "utf8");
  if (!Buffer.from(bytes).equals(expected)) {
    return fail("INVALID_ARGUMENT", "Private KiCad full-result bytes are not exact canonical JSON");
  }
  return result;
};

const freezeRecord = (
  value: Omit<
    PrivateKicadCaptureRecord<typeof DURABLE_PRIVATE_KICAD_CAPTURE_AUTHORITY>,
    "recordManifestIdentity"
  > & { readonly recordManifestIdentity: CanonicalIdentity }
): PrivateKicadCaptureRecord<typeof DURABLE_PRIVATE_KICAD_CAPTURE_AUTHORITY> => {
  const files = Object.freeze(Object.fromEntries(
    CAPTURE_FILE_ROLES.map((role) => [role, Object.freeze({ ...value.files[role] })])
  )) as PrivateKicadCaptureFileIdentities;
  return Object.freeze({
    ...value,
    files,
    fullResultRecordIdentity: Object.freeze({ ...value.fullResultRecordIdentity }),
    privateReceiptRecordIdentity: Object.freeze({ ...value.privateReceiptRecordIdentity }),
    recordManifestIdentity: Object.freeze({ ...value.recordManifestIdentity })
  });
};

const recordPreimage = (
  record: Omit<
    PrivateKicadCaptureRecord<typeof DURABLE_PRIVATE_KICAD_CAPTURE_AUTHORITY>,
    "recordManifestIdentity"
  >
): Readonly<Record<string, unknown>> => ({
  schemaVersion: record.schemaVersion,
  recordId: record.recordId,
  storageAuthority: record.storageAuthority,
  files: record.files,
  fullResultRecordIdentity: record.fullResultRecordIdentity,
  privateReceiptRecordIdentity: record.privateReceiptRecordIdentity,
  fileCount: record.fileCount,
  aggregateSize: record.aggregateSize,
  releaseAuthorized: record.releaseAuthorized
});

const snapshotBytes = (
  value: unknown,
  role: PrivateKicadCaptureFileRole,
  maxBytes: number
): Buffer => {
  if (value === null || typeof value !== "object" || isProxy(value)) {
    return fail("INVALID_ARGUMENT", `Private-capture ${role} must be a non-proxy Uint8Array`);
  }
  let branded = false;
  try {
    branded = Boolean(ReflectApply(FunctionHasInstance, IntrinsicUint8Array, [value]));
  } catch {
    return fail("INVALID_ARGUMENT", `Private-capture ${role} byte brand check failed`);
  }
  if (
    !branded ||
    typedArrayBufferGetter === undefined ||
    typedArrayByteLengthGetter === undefined ||
    typedArrayByteOffsetGetter === undefined
  ) {
    return fail("INVALID_ARGUMENT", `Private-capture ${role} must be a Uint8Array`);
  }
  try {
    const backing = ReflectApply(typedArrayBufferGetter, value, []) as ArrayBufferLike;
    const byteLength = ReflectApply(typedArrayByteLengthGetter, value, []) as number;
    const byteOffset = ReflectApply(typedArrayByteOffsetGetter, value, []) as number;
    if (
      IntrinsicSharedArrayBuffer !== undefined &&
      ReflectApply(FunctionHasInstance, IntrinsicSharedArrayBuffer, [backing])
    ) {
      return fail("INVALID_ARGUMENT", `Private-capture ${role} cannot use shared backing memory`);
    }
    if (!Number.isSafeInteger(byteLength) || !Number.isSafeInteger(byteOffset) || byteLength < 0 || byteOffset < 0) {
      return fail("INVALID_ARGUMENT", `Private-capture ${role} byte view is incoherent`);
    }
    if (byteLength > maxBytes) {
      return fail("INVALID_ARGUMENT", "Private-capture file exceeds the configured byte limit", {
        role,
        actual: byteLength,
        maximum: maxBytes
      });
    }
    const snapshot = Buffer.alloc(byteLength);
    const source = new IntrinsicUint8Array(backing as ArrayBuffer, byteOffset, byteLength);
    ReflectApply(IntrinsicUint8ArraySet, snapshot, [source]);
    if (
      ReflectApply(typedArrayBufferGetter, value, []) !== backing ||
      ReflectApply(typedArrayByteLengthGetter, value, []) !== byteLength ||
      ReflectApply(typedArrayByteOffsetGetter, value, []) !== byteOffset
    ) {
      return fail("INVALID_ARGUMENT", `Private-capture ${role} byte view changed during capture`);
    }
    return snapshot;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    return fail("INVALID_ARGUMENT", `Private-capture ${role} bytes could not be captured exactly`);
  }
};

export class DurablePrivateKicadCaptureStore implements DurablePrivateKicadCaptureStorePort {
  public readonly [PRIVATE_KICAD_CAPTURE_STORE_PORT]!: true;
  public readonly storageAuthority!: typeof DURABLE_PRIVATE_KICAD_CAPTURE_AUTHORITY;
  public readonly privateRoot!: PrivateKicadCaptureRoot;
  public readonly limits!: PrivateKicadCaptureLimits;

  readonly #requestedRoot: string;
  readonly #limits: PrivateKicadCaptureLimits;
  readonly #disjointFrom: readonly PrivateKicadCaptureDisjointRoot[];
  readonly #rootBoundaryHook: DurablePrivateKicadCaptureStoreOptions["rootBoundaryHook"];
  #canonicalRoot: string | undefined;
  #initialization: Promise<void> | undefined;

  public constructor(options: DurablePrivateKicadCaptureStoreOptions) {
    const safe = optionalDataRecord(
      options,
      ["privateRoot", "disjointFrom", "limits", "rootBoundaryHook"],
      "Durable private-capture store options"
    );
    this.#requestedRoot = assertAbsoluteRoot(safe.privateRoot, "Private-capture root");
    const disjointFrom = safe.disjointFrom;
    if (!Array.isArray(disjointFrom) || isProxy(disjointFrom) || disjointFrom.length === 0) {
      fail(
        "INVALID_ARGUMENT",
        "Private-capture store requires at least one disjoint root, including the public content store"
      );
    }
    const disjointArray = disjointFrom as unknown[];
    const disjointDescriptors = Object.getOwnPropertyDescriptors(disjointArray);
    const disjointKeys = Reflect.ownKeys(disjointArray);
    if (
      disjointKeys.some((key) =>
        key !== "length" &&
        (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= disjointArray.length)
      ) ||
      Array.from({ length: disjointArray.length }, (_, index) => String(index)).some((key) => {
        const descriptor = disjointDescriptors[key];
        return descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true;
      })
    ) {
      fail("INVALID_ARGUMENT", "Disjoint roots must be a dense plain data array");
    }
    const disjointRoots = Array.from(
      { length: disjointArray.length },
      (_, index) => disjointDescriptors[String(index)]!.value
    ) as readonly unknown[];
    this.#disjointFrom = Object.freeze(disjointRoots.map((entry: unknown, index: number) => {
      const root = exactDataRecord(entry, ["label", "path"], `Disjoint root ${index}`);
      if (typeof root.label !== "string" || root.label.trim().length === 0) {
        return fail("INVALID_ARGUMENT", "Disjoint root label must be non-empty", { index });
      }
      const protectedPath = assertAbsoluteRoot(root.path, `Disjoint root ${root.label}`);
      if (pathsOverlap(this.#requestedRoot, protectedPath)) {
        return fail("POLICY_DENIED", "Private-capture root overlaps a protected root", {
          privateRoot: this.#requestedRoot,
          disjointRoot: protectedPath,
          label: root.label
        });
      }
      return Object.freeze({ label: root.label, path: protectedPath });
    }));
    const resolvedLimits = resolveLimits(safe.limits as Partial<PrivateKicadCaptureLimits> | undefined);
    this.#limits = Object.freeze({ ...resolvedLimits });
    if (safe.rootBoundaryHook !== undefined && typeof safe.rootBoundaryHook !== "function") {
      fail("INVALID_ARGUMENT", "Private-capture root boundary hook must be a function");
    }
    this.#rootBoundaryHook = safe.rootBoundaryHook as DurablePrivateKicadCaptureStoreOptions["rootBoundaryHook"];
    Object.defineProperties(this, {
      [PRIVATE_KICAD_CAPTURE_STORE_PORT]: {
        value: true,
        enumerable: false,
        writable: false,
        configurable: false
      },
      storageAuthority: {
        value: DURABLE_PRIVATE_KICAD_CAPTURE_AUTHORITY,
        enumerable: true,
        writable: false,
        configurable: false
      },
      privateRoot: {
        value: this.#requestedRoot as PrivateKicadCaptureRoot,
        enumerable: true,
        writable: false,
        configurable: false
      },
      limits: {
        value: Object.freeze({ ...this.#limits }),
        enumerable: true,
        writable: false,
        configurable: false
      }
    });
    Object.preventExtensions(this);
  }

  public mintRecordId(): PrivateKicadCaptureRecordId {
    return `pkc_${randomUUID().replaceAll("-", "")}` as PrivateKicadCaptureRecordId;
  }

  public initialize(): Promise<void> {
    if (this.#initialization !== undefined) return this.#initialization;
    const pending = this.#initializeOnce();
    this.#initialization = pending;
    void pending.catch(() => {
      if (this.#initialization === pending) this.#initialization = undefined;
    });
    return pending;
  }

  public async appendCapture(
    input: PrivateKicadCaptureAppend
  ): Promise<PrivateKicadCaptureRecord<typeof DURABLE_PRIVATE_KICAD_CAPTURE_AUTHORITY>> {
    const captured = this.#captureAppend(input);
    await this.initialize();
    await this.#assertSecureLayout("operation");
    const paths = this.#paths();
    const release = await acquireExclusiveFileLock(path.join(paths.locks, "append.lock"));
    try {
      await this.#assertSecureLayout("operation");
      const recordPath = this.#recordPath(captured.recordId);
      if (await this.#ordinaryFileExists(recordPath, "private-capture record")) {
        const existing = await this.#readRecord(captured.recordId);
        if (!Buffer.from(`${canonicalJson(existing)}\n`, "utf8").equals(captured.serializedRecord)) {
          return fail(
            "ARTIFACT_INTEGRITY_ERROR",
            "Conflicting duplicate private-capture record identity",
            { recordId: captured.recordId }
          );
        }
        const existingFiles = await this.#readFilesAndVerify(existing);
        this.#validateStoredDocuments(existingFiles, existing);
        return existing;
      }

      for (const role of CAPTURE_FILE_ROLES) {
        await this.#putBlob(captured.record.files[role], captured.files[role], role);
      }
      await this.#publishImmutable(recordPath, captured.serializedRecord, "private-capture record");
      const committed = await this.#readRecord(captured.recordId);
      if (!Buffer.from(`${canonicalJson(committed)}\n`, "utf8").equals(captured.serializedRecord)) {
        return fail("ARTIFACT_INTEGRITY_ERROR", "Committed private-capture record changed", {
          recordId: captured.recordId
        });
      }
      return committed;
    } finally {
      await release();
    }
  }

  public async readCapture(
    recordId: PrivateKicadCaptureRecordId
  ): Promise<PrivateKicadCaptureRead<typeof DURABLE_PRIVATE_KICAD_CAPTURE_AUTHORITY>> {
    const validId = validateRecordId(recordId);
    await this.initialize();
    await this.#assertSecureLayout("operation");
    const record = await this.#readRecord(validId);
    const files = await this.#readFilesAndVerify(record);
    const { privateReceipt, fullResult } = this.#validateStoredDocuments(files, record);
    return Object.freeze({
      record,
      files: Object.freeze(files),
      fullResult,
      privateReceipt
    });
  }

  public async verifyCapture(
    recordId: PrivateKicadCaptureRecordId
  ): Promise<PrivateKicadCaptureRecord<typeof DURABLE_PRIVATE_KICAD_CAPTURE_AUTHORITY>> {
    return (await this.readCapture(recordId)).record;
  }

  async #initializeOnce(): Promise<void> {
    await this.#assertRootBoundary("before-create");
    try {
      const metadata = await lstat(this.#requestedRoot);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        return fail(
          "PATH_OUTSIDE_WORKSPACE",
          "Private-capture root must be an ordinary directory, not a link or file"
        );
      }
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (errorCode(error) !== "ENOENT") throw error;
      await mkdir(this.#requestedRoot, { recursive: true });
    }
    await assertNoExistingLinkComponents(this.#requestedRoot);
    const metadata = await lstat(this.#requestedRoot);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      return fail("PATH_OUTSIDE_WORKSPACE", "Private-capture root is not an ordinary directory");
    }
    this.#canonicalRoot = await realpath(this.#requestedRoot);
    await this.#assertRootBoundary("after-create");

    const marker = path.join(this.#canonicalRoot, ROOT_MARKER);
    const entries = await readdir(this.#canonicalRoot);
    if (!entries.includes(ROOT_MARKER)) {
      if (entries.length !== 0) {
        return fail(
          "ARTIFACT_INTEGRITY_ERROR",
          "Refusing to attach a private-capture store marker to a non-empty unmarked root",
          { entries: entries.slice(0, 20) }
        );
      }
      let handle;
      try {
        handle = await open(marker, "wx");
        await handle.writeFile(ROOT_MARKER_BYTES);
        await handle.sync();
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      } finally {
        await handle?.close();
      }
      await syncContainingDirectory(marker);
    }
    const actualMarker = await this.#readOrdinaryFile(marker, ROOT_MARKER_BYTES.byteLength, "store marker");
    if (!actualMarker.equals(ROOT_MARKER_BYTES)) {
      return fail("ARTIFACT_INTEGRITY_ERROR", "Private-capture store marker is corrupt or incompatible");
    }

    const paths = this.#paths();
    for (const directory of [paths.blobs, paths.sha256, paths.records, paths.staging, paths.locks]) {
      try {
        await mkdir(directory);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
      await this.#assertOrdinaryChain(directory, "directory");
    }
    const finalEntries = await readdir(this.#canonicalRoot);
    const expected = new Set([ROOT_MARKER, "blobs", "records", "staging", "locks"]);
    const unknown = finalEntries.filter((entry) => !expected.has(entry));
    if (unknown.length > 0) {
      return fail("ARTIFACT_INTEGRITY_ERROR", "Private-capture root contains unknown top-level entries", {
        entries: unknown.slice(0, 20)
      });
    }
    await this.#assertSecureLayout("operation");
  }

  #captureAppend(input: PrivateKicadCaptureAppend): CapturedAppend {
    const safe = exactDataRecord(input, ["recordId", "files"], "Private-capture append");
    const recordId = validateRecordId(safe.recordId);
    const fileInput = exactDataRecord(
      safe.files,
      CAPTURE_FILE_ROLES,
      "Private-capture files"
    );
    if (CAPTURE_FILE_ROLES.length > this.#limits.maxFilesPerCapture) {
      return fail("INVALID_ARGUMENT", "Private-capture file count exceeds the configured limit", {
        actual: CAPTURE_FILE_ROLES.length,
        maximum: this.#limits.maxFilesPerCapture
      });
    }
    const pairs: [PrivateKicadCaptureFileRole, Buffer][] = [];
    let aggregateSize = 0;
    for (const role of CAPTURE_FILE_ROLES) {
      const bytes = snapshotBytes(fileInput[role], role, this.#limits.maxBytesPerFile);
      aggregateSize += bytes.byteLength;
      if (!Number.isSafeInteger(aggregateSize)) {
        return fail("INVALID_ARGUMENT", "Private-capture aggregate size is not safely representable");
      }
      if (aggregateSize > this.#limits.maxAggregateBytesPerCapture) {
        return fail("INVALID_ARGUMENT", "Private-capture aggregate exceeds the configured byte limit", {
          actual: aggregateSize,
          maximum: this.#limits.maxAggregateBytesPerCapture
        });
      }
      pairs.push([role, bytes]);
    }
    const files = Object.fromEntries(pairs) as Readonly<Record<PrivateKicadCaptureFileRole, Buffer>>;
    const identities = Object.freeze(Object.fromEntries(
      CAPTURE_FILE_ROLES.map((role) => [role, Object.freeze(contentIdentity(files[role]))])
    )) as PrivateKicadCaptureFileIdentities;
    const privateReceipt = parsePrivateRawCaptureReceiptV2Bytes(files.privateReceipt);
    if (!files.privateReceipt.equals(Buffer.from(`${canonicalPortableJson(privateReceipt)}\n`, "utf8"))) {
      return fail("INVALID_ARGUMENT", "Private receipt bytes must be exact canonical JSON");
    }
    this.#assertReceiptIdentityBindings(privateReceipt, identities);
    const fullResult = parseCanonicalPrivateKicadFullResultV1Bytes(files.fullResult);
    this.#assertFullResultIdentityBindings(fullResult, privateReceipt, identities);
    const draft = Object.freeze({
      schemaVersion: RECORD_SCHEMA_VERSION,
      recordId,
      storageAuthority: DURABLE_PRIVATE_KICAD_CAPTURE_AUTHORITY,
      files: identities,
      fullResultRecordIdentity: fullResult.resultIdentity,
      privateReceiptRecordIdentity: privateReceipt.receiptIdentity,
      fileCount: 6 as const,
      aggregateSize,
      releaseAuthorized: false as const
    });
    const record = freezeRecord({
      ...draft,
      recordManifestIdentity: canonicalIdentity(recordPreimage(draft), RECORD_SCHEMA_VERSION)
    });
    return Object.freeze({
      recordId,
      files: Object.freeze(files),
      record,
      serializedRecord: Buffer.from(`${canonicalJson(record)}\n`, "utf8")
    });
  }

  #assertReceiptIdentityBindings(
    receipt: ReturnType<typeof parsePrivateRawCaptureReceiptV2Bytes>,
    identities: PrivateKicadCaptureFileIdentities
  ): void {
    for (const [label, expected, actual] of [
      ["raw", receipt.rawContentIdentity, identities.raw],
      ["source", receipt.sourceBinding.sourceArtifactIdentity, identities.source],
      ["stdout", receipt.stdoutIdentity, identities.stdout],
      ["stderr", receipt.stderrIdentity, identities.stderr]
    ] as const) {
      if (!contentIdentitiesEqual(expected, actual)) {
        fail("DIGEST_MISMATCH", `Private receipt ${label} identity does not match captured bytes`, {
          expected,
          actual
        });
      }
    }
  }

  #validateReceiptBindings(
    files: Readonly<Record<PrivateKicadCaptureFileRole, Buffer>>,
    record: PrivateKicadCaptureRecord<typeof DURABLE_PRIVATE_KICAD_CAPTURE_AUTHORITY>
  ): ReturnType<typeof parsePrivateRawCaptureReceiptV2Bytes> {
    let receipt: ReturnType<typeof parsePrivateRawCaptureReceiptV2Bytes>;
    try {
      receipt = parsePrivateRawCaptureReceiptV2Bytes(files.privateReceipt);
    } catch (error) {
      if (error instanceof DomainError) {
        return fail("ARTIFACT_INTEGRITY_ERROR", "Stored private receipt failed validation", {
          causeCode: error.code,
          cause: error.message
        });
      }
      throw error;
    }
    if (!files.privateReceipt.equals(Buffer.from(`${canonicalPortableJson(receipt)}\n`, "utf8"))) {
      return fail("ARTIFACT_INTEGRITY_ERROR", "Stored private receipt bytes are not exact canonical JSON");
    }
    this.#assertReceiptIdentityBindings(receipt, record.files);
    if (!canonicalIdentitiesEqual(receipt.receiptIdentity, record.privateReceiptRecordIdentity)) {
      fail("ARTIFACT_INTEGRITY_ERROR", "Stored private receipt identity does not match its record");
    }
    return receipt;
  }

  #assertFullResultIdentityBindings(
    fullResult: PrivateKicadFullResultV1,
    receipt: ReturnType<typeof parsePrivateRawCaptureReceiptV2Bytes>,
    identities: PrivateKicadCaptureFileIdentities
  ): void {
    for (const [label, expected, actual] of [
      ["raw", fullResult.rawContentIdentity, identities.raw],
      ["source", fullResult.sourceContentIdentity, identities.source],
      ["stdout", fullResult.stdoutIdentity, identities.stdout],
      ["stderr", fullResult.stderrIdentity, identities.stderr],
      ["privateReceipt", fullResult.privateReceiptContentIdentity, identities.privateReceipt]
    ] as const) {
      if (!contentIdentitiesEqual(expected, actual)) {
        fail("DIGEST_MISMATCH", `Private full-result ${label} identity does not match captured bytes`, {
          expected,
          actual
        });
      }
    }
    for (const [label, expected, actual] of [
      ["command", fullResult.commandPlanIdentity, receipt.commandPlanIdentity],
      ["invocation", fullResult.invocationIdentity, receipt.invocationIdentity],
      ["capture", fullResult.captureIdentity, receipt.captureIdentity],
      ["privateReceipt", fullResult.privateReceiptRecordIdentity, receipt.receiptIdentity]
    ] as const) {
      if (!canonicalIdentitiesEqual(expected, actual)) {
        fail("DIGEST_MISMATCH", `Private full-result ${label} identity does not match its receipt`, {
          expected,
          actual
        });
      }
    }
    if (
      fullResult.reportKind !== receipt.reportKind ||
      fullResult.outcome !== receipt.outcome ||
      fullResult.exitCode !== receipt.exitCode
    ) {
      fail("DIGEST_MISMATCH", "Private full-result outcome does not match its receipt");
    }
  }

  #validateStoredDocuments(
    files: Readonly<Record<PrivateKicadCaptureFileRole, Buffer>>,
    record: PrivateKicadCaptureRecord<typeof DURABLE_PRIVATE_KICAD_CAPTURE_AUTHORITY>
  ): {
    readonly privateReceipt: ReturnType<typeof parsePrivateRawCaptureReceiptV2Bytes>;
    readonly fullResult: PrivateKicadFullResultV1;
  } {
    const privateReceipt = this.#validateReceiptBindings(files, record);
    let fullResult: PrivateKicadFullResultV1;
    try {
      fullResult = parseCanonicalPrivateKicadFullResultV1Bytes(files.fullResult);
      this.#assertFullResultIdentityBindings(fullResult, privateReceipt, record.files);
    } catch (error) {
      if (error instanceof DomainError) {
        return fail("ARTIFACT_INTEGRITY_ERROR", "Stored private full-result failed validation", {
          causeCode: error.code,
          cause: error.message
        });
      }
      throw error;
    }
    if (!canonicalIdentitiesEqual(fullResult.resultIdentity, record.fullResultRecordIdentity)) {
      return fail("ARTIFACT_INTEGRITY_ERROR", "Stored private full-result identity does not match its record");
    }
    return Object.freeze({ privateReceipt, fullResult });
  }

  async #assertRootBoundary(
    phase: PrivateKicadCaptureRootBoundaryObservation["phase"]
  ): Promise<string> {
    await assertNoExistingLinkComponents(this.#requestedRoot);
    const canonicalPrivateRoot = await canonicalProspectiveDirectory(
      this.#requestedRoot,
      true,
      "Private-capture root"
    );
    for (const disjointRoot of this.#disjointFrom) {
      const canonicalDisjointRoot = await canonicalProspectiveDirectory(
        disjointRoot.path,
        false,
        `Disjoint root ${disjointRoot.label}`
      );
      if (
        pathsOverlap(this.#requestedRoot, disjointRoot.path) ||
        pathsOverlap(canonicalPrivateRoot, canonicalDisjointRoot)
      ) {
        return fail("POLICY_DENIED", "Private-capture root overlaps a protected root", {
          phase,
          privateRoot: this.#requestedRoot,
          canonicalPrivateRoot,
          disjointRoot: disjointRoot.path,
          canonicalDisjointRoot,
          label: disjointRoot.label
        });
      }
      if (phase === "before-create") {
        await assertProspectivePrivateRootPhysicallyDisjoint(
          this.#requestedRoot,
          canonicalDisjointRoot,
          disjointRoot.label
        );
      } else {
        await assertPhysicalRootsDisjoint(
          canonicalPrivateRoot,
          canonicalDisjointRoot,
          disjointRoot.label
        );
      }
      await this.#rootBoundaryHook?.(Object.freeze({
        phase,
        privateRoot: this.#requestedRoot,
        canonicalPrivateRoot,
        disjointRoot,
        canonicalDisjointRoot
      }));
    }
    return canonicalPrivateRoot;
  }

  async #assertSecureLayout(
    phase: PrivateKicadCaptureRootBoundaryObservation["phase"]
  ): Promise<void> {
    const canonical = await this.#assertRootBoundary(phase);
    if (
      this.#canonicalRoot === undefined ||
      normalizeForComparison(canonical) !== normalizeForComparison(this.#canonicalRoot)
    ) {
      return fail("PATH_OUTSIDE_WORKSPACE", "Private-capture root identity changed after initialization");
    }
    const paths = this.#paths();
    for (const directory of [this.#canonicalRoot, paths.blobs, paths.sha256, paths.records, paths.staging, paths.locks]) {
      await this.#assertOrdinaryChain(directory, "directory");
    }
    const marker = path.join(this.#canonicalRoot, ROOT_MARKER);
    const markerBytes = await this.#readOrdinaryFile(marker, ROOT_MARKER_BYTES.byteLength, "store marker");
    if (!markerBytes.equals(ROOT_MARKER_BYTES)) {
      return fail("ARTIFACT_INTEGRITY_ERROR", "Private-capture store marker changed after initialization");
    }
    const entries = await readdir(this.#canonicalRoot);
    const expected = new Set([ROOT_MARKER, "blobs", "records", "staging", "locks"]);
    const unknown = entries.filter((entry) => !expected.has(entry));
    if (unknown.length > 0) {
      return fail("ARTIFACT_INTEGRITY_ERROR", "Private-capture root contains unknown top-level entries", {
        entries: unknown.slice(0, 20)
      });
    }
  }

  #paths(): {
    readonly blobs: string;
    readonly sha256: string;
    readonly records: string;
    readonly staging: string;
    readonly locks: string;
  } {
    if (this.#canonicalRoot === undefined) {
      return fail("ARTIFACT_INTEGRITY_ERROR", "Private-capture store is not initialized");
    }
    return Object.freeze({
      blobs: path.join(this.#canonicalRoot, "blobs"),
      sha256: path.join(this.#canonicalRoot, "blobs", "sha256"),
      records: path.join(this.#canonicalRoot, "records"),
      staging: path.join(this.#canonicalRoot, "staging"),
      locks: path.join(this.#canonicalRoot, "locks")
    });
  }

  async #assertOrdinaryChain(candidate: string, finalKind: "file" | "directory"): Promise<void> {
    if (this.#canonicalRoot === undefined || !isWithin(this.#canonicalRoot, candidate)) {
      return fail("PATH_OUTSIDE_WORKSPACE", "Private-capture path escapes its canonical root", {
        candidate
      });
    }
    const relative = path.relative(this.#canonicalRoot, candidate);
    let cursor = this.#canonicalRoot;
    const components = relative === "" ? [] : relative.split(path.sep);
    const inspect = ["", ...components];
    for (let index = 0; index < inspect.length; index += 1) {
      if (index > 0) cursor = path.join(cursor, inspect[index]!);
      const metadata = await lstat(cursor);
      const isFinal = index === inspect.length - 1;
      if (metadata.isSymbolicLink()) {
        return fail(
          "PATH_OUTSIDE_WORKSPACE",
          "Private-capture path traverses a symbolic link, junction, or reparse point",
          { component: cursor }
        );
      }
      if ((isFinal && finalKind === "file" && !metadata.isFile()) ||
          ((!isFinal || finalKind === "directory") && !metadata.isDirectory())) {
        return fail("ARTIFACT_INTEGRITY_ERROR", "Private-capture path is not an ordinary file type", {
          component: cursor,
          expected: isFinal ? finalKind : "directory"
        });
      }
      const resolved = await realpath(cursor);
      if (
        !isWithin(this.#canonicalRoot, resolved) ||
        normalizeForComparison(resolved) !== normalizeForComparison(path.resolve(cursor))
      ) {
        return fail(
          "PATH_OUTSIDE_WORKSPACE",
          "Private-capture path changed through a link, junction, or reparse point",
          { component: cursor, resolved }
        );
      }
    }
  }

  async #ordinaryFileExists(candidate: string, label: string): Promise<boolean> {
    try {
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        return fail("ARTIFACT_INTEGRITY_ERROR", `${label} path is not an ordinary file`, {
          candidate
        });
      }
      await this.#assertOrdinaryChain(candidate, "file");
      return true;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }
  }

  async #readOrdinaryFile(candidate: string, maxBytes: number, label: string): Promise<Buffer> {
    try {
      await this.#assertOrdinaryChain(candidate, "file");
      const handle = await open(candidate, READ_OPEN_FLAGS);
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > maxBytes) {
          return fail("ARTIFACT_INTEGRITY_ERROR", `${label} exceeds its bounded ordinary-file contract`, {
            size: before.size,
            maximum: maxBytes
          });
        }
        const bytes = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < bytes.byteLength) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, null);
          if (bytesRead === 0) {
            return fail("ARTIFACT_INTEGRITY_ERROR", `${label} was truncated while it was read`);
          }
          offset += bytesRead;
        }
        const extra = Buffer.alloc(1);
        const { bytesRead: extraBytes } = await handle.read(extra, 0, 1, null);
        const after = await handle.stat();
        await this.#assertOrdinaryChain(candidate, "file");
        const pathMetadata = await lstat(candidate);
        if (
          !after.isFile() ||
          pathMetadata.isSymbolicLink() ||
          !pathMetadata.isFile() ||
          after.size !== before.size ||
          bytes.byteLength !== before.size ||
          extraBytes !== 0 ||
          pathMetadata.dev !== after.dev ||
          pathMetadata.ino !== after.ino
        ) {
          return fail("ARTIFACT_INTEGRITY_ERROR", `${label} changed while it was read`);
        }
        return Buffer.from(bytes);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (errorCode(error) === "ENOENT") {
        return fail("ARTIFACT_INTEGRITY_ERROR", `${label} is missing`, { candidate });
      }
      throw error;
    }
  }

  async #publishImmutable(candidate: string, bytes: Buffer, label: string): Promise<void> {
    const paths = this.#paths();
    const stagingPath = path.join(paths.staging, `${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(stagingPath, "wx");
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle?.close();
    }
    try {
      await this.#assertOrdinaryChain(stagingPath, "file");
      try {
        await link(stagingPath, candidate);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        const existing = await this.#readOrdinaryFile(candidate, bytes.byteLength, label);
        if (!existing.equals(bytes)) {
          return fail("ARTIFACT_INTEGRITY_ERROR", `Conflicting immutable ${label}`, { candidate });
        }
      }
      await syncContainingDirectory(candidate);
    } finally {
      await rm(stagingPath, { force: true });
    }
    const committed = await this.#readOrdinaryFile(candidate, bytes.byteLength, label);
    if (!committed.equals(bytes)) {
      return fail("ARTIFACT_INTEGRITY_ERROR", `Published ${label} failed exact verification`, {
        candidate
      });
    }
  }

  #recordPath(recordId: PrivateKicadCaptureRecordId): string {
    return path.join(this.#paths().records, `${validateRecordId(recordId)}.json`);
  }

  #blobPath(identity: ContentIdentity): string {
    return path.join(this.#paths().sha256, identity.digest.slice(0, 2), identity.digest.slice(2));
  }

  async #putBlob(identity: ContentIdentity, bytes: Buffer, role: PrivateKicadCaptureFileRole): Promise<void> {
    const expected = contentIdentity(bytes);
    if (!contentIdentitiesEqual(identity, expected)) {
      return fail("ARTIFACT_INTEGRITY_ERROR", "Captured bytes changed before private CAS append", {
        role
      });
    }
    const target = this.#blobPath(identity);
    const shard = path.dirname(target);
    try {
      await mkdir(shard);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    await this.#assertOrdinaryChain(shard, "directory");
    if (await this.#ordinaryFileExists(target, `private ${role} blob`)) {
      const existing = await this.#readOrdinaryFile(target, identity.size, `private ${role} blob`);
      const actual = contentIdentity(existing);
      if (!contentIdentitiesEqual(actual, identity)) {
        return fail("ARTIFACT_INTEGRITY_ERROR", "Existing private CAS object is corrupt", {
          role,
          expected: identity,
          actual
        });
      }
      return;
    }
    await this.#publishImmutable(target, bytes, `private ${role} blob`);
  }

  async #readRecord(
    recordId: PrivateKicadCaptureRecordId
  ): Promise<PrivateKicadCaptureRecord<typeof DURABLE_PRIVATE_KICAD_CAPTURE_AUTHORITY>> {
    const candidate = this.#recordPath(recordId);
    if (!(await this.#ordinaryFileExists(candidate, "private-capture record"))) {
      return fail("NOT_FOUND", "Private-capture record is missing", { recordId });
    }
    const bytes = await this.#readOrdinaryFile(candidate, RECORD_FILE_MAX_BYTES, "private-capture record");
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      return fail("ARTIFACT_INTEGRITY_ERROR", "Private-capture record contains invalid JSON", {
        recordId
      });
    }
    let record: PrivateKicadCaptureRecord<typeof DURABLE_PRIVATE_KICAD_CAPTURE_AUTHORITY>;
    try {
      record = this.#validateRecord(parsed, recordId);
    } catch (error) {
      if (error instanceof DomainError && error.code !== "ARTIFACT_INTEGRITY_ERROR") {
        return fail("ARTIFACT_INTEGRITY_ERROR", "Private-capture record failed validation", {
          recordId,
          causeCode: error.code,
          cause: error.message
        });
      }
      throw error;
    }
    if (!bytes.equals(Buffer.from(`${canonicalJson(record)}\n`, "utf8"))) {
      return fail("ARTIFACT_INTEGRITY_ERROR", "Private-capture record is not exact canonical data", {
        recordId
      });
    }
    return record;
  }

  #validateRecord(
    value: unknown,
    expectedRecordId: PrivateKicadCaptureRecordId
  ): PrivateKicadCaptureRecord<typeof DURABLE_PRIVATE_KICAD_CAPTURE_AUTHORITY> {
    let safe: Readonly<Record<string, unknown>>;
    try {
      safe = exactDataRecord(value, [
        "schemaVersion",
        "recordId",
        "storageAuthority",
        "files",
        "fullResultRecordIdentity",
        "privateReceiptRecordIdentity",
        "fileCount",
        "aggregateSize",
        "releaseAuthorized",
        "recordManifestIdentity"
      ], "Private-capture record");
    } catch (error) {
      if (error instanceof DomainError) {
        return fail("ARTIFACT_INTEGRITY_ERROR", error.message, error.details);
      }
      throw error;
    }
    const recordId = validateRecordId(safe.recordId);
    if (
      recordId !== expectedRecordId ||
      safe.schemaVersion !== RECORD_SCHEMA_VERSION ||
      safe.storageAuthority !== DURABLE_PRIVATE_KICAD_CAPTURE_AUTHORITY ||
      safe.fileCount !== CAPTURE_FILE_ROLES.length ||
      safe.releaseAuthorized !== false ||
      !Number.isSafeInteger(safe.aggregateSize) ||
      (safe.aggregateSize as number) < 0
    ) {
      return fail("ARTIFACT_INTEGRITY_ERROR", "Private-capture record header is invalid", {
        expectedRecordId
      });
    }
    let fileRecord: Readonly<Record<string, unknown>>;
    try {
      fileRecord = exactDataRecord(safe.files, CAPTURE_FILE_ROLES, "Private-capture identities");
    } catch (error) {
      if (error instanceof DomainError) {
        return fail("ARTIFACT_INTEGRITY_ERROR", error.message, error.details);
      }
      throw error;
    }
    const files = Object.freeze(Object.fromEntries(CAPTURE_FILE_ROLES.map((role) => [
      role,
      validateContentIdentity(fileRecord[role], `Private-capture ${role} identity`)
    ]))) as PrivateKicadCaptureFileIdentities;
    const aggregateSize = CAPTURE_FILE_ROLES.reduce(
      (total, role) => total + files[role].size,
      0
    );
    if (
      !Number.isSafeInteger(aggregateSize) ||
      aggregateSize !== safe.aggregateSize ||
      CAPTURE_FILE_ROLES.length > this.#limits.maxFilesPerCapture ||
      aggregateSize > this.#limits.maxAggregateBytesPerCapture ||
      CAPTURE_FILE_ROLES.some((role) => files[role].size > this.#limits.maxBytesPerFile)
    ) {
      return fail("ARTIFACT_INTEGRITY_ERROR", "Private-capture record violates its size limits");
    }
    const privateReceiptRecordIdentity = validateCanonicalIdentity(
      safe.privateReceiptRecordIdentity,
      "Private receipt record identity"
    );
    const fullResultRecordIdentity = validateCanonicalIdentity(
      safe.fullResultRecordIdentity,
      "Private full-result record identity"
    );
    const recordManifestIdentity = validateCanonicalIdentity(
      safe.recordManifestIdentity,
      "Private-capture manifest identity"
    );
    if (
      fullResultRecordIdentity.schemaVersion !== PRIVATE_FULL_RESULT_SCHEMA ||
      privateReceiptRecordIdentity.schemaVersion !== "evleda.private-raw-capture-receipt.v2" ||
      recordManifestIdentity.schemaVersion !== RECORD_SCHEMA_VERSION
    ) {
      return fail("ARTIFACT_INTEGRITY_ERROR", "Private-capture record identity schema is invalid");
    }
    const draft = Object.freeze({
      schemaVersion: RECORD_SCHEMA_VERSION,
      recordId,
      storageAuthority: DURABLE_PRIVATE_KICAD_CAPTURE_AUTHORITY,
      files,
      fullResultRecordIdentity,
      privateReceiptRecordIdentity,
      fileCount: 6 as const,
      aggregateSize,
      releaseAuthorized: false as const
    });
    const expectedIdentity = canonicalIdentity(recordPreimage(draft), RECORD_SCHEMA_VERSION);
    if (!canonicalIdentitiesEqual(recordManifestIdentity, expectedIdentity)) {
      return fail("ARTIFACT_INTEGRITY_ERROR", "Private-capture record manifest identity is corrupt");
    }
    return freezeRecord({ ...draft, recordManifestIdentity });
  }

  async #readFilesAndVerify(
    record: PrivateKicadCaptureRecord<typeof DURABLE_PRIVATE_KICAD_CAPTURE_AUTHORITY>
  ): Promise<Readonly<Record<PrivateKicadCaptureFileRole, Buffer>>> {
    const pairs = await Promise.all(CAPTURE_FILE_ROLES.map(async (role) => {
      const identity = record.files[role];
      const candidate = this.#blobPath(identity);
      if (!(await this.#ordinaryFileExists(candidate, `private ${role} blob`))) {
        return fail("ARTIFACT_INTEGRITY_ERROR", "Private-capture record references a missing blob", {
          recordId: record.recordId,
          role
        });
      }
      const bytes = await this.#readOrdinaryFile(candidate, identity.size, `private ${role} blob`);
      const actual = contentIdentity(bytes);
      if (!contentIdentitiesEqual(actual, identity)) {
        return fail("ARTIFACT_INTEGRITY_ERROR", "Private-capture blob failed identity verification", {
          recordId: record.recordId,
          role,
          expected: identity,
          actual
        });
      }
      return [role, Buffer.from(bytes)] as const;
    }));
    return Object.fromEntries(pairs) as Readonly<Record<PrivateKicadCaptureFileRole, Buffer>>;
  }
}
