import { constants as fsConstants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { types as nodeTypes } from "node:util";
import { constantTimeDigestEqual, contentIdentity } from "../core/canonical.js";
import type { ContentIdentity } from "../domain/types.js";
import { DesignAgentCoordinatorError } from "./coordinator.js";

export function productionAgentReject(
  code: ConstructorParameters<typeof DesignAgentCoordinatorError>[0],
  failureCode: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {}
): never {
  throw new DesignAgentCoordinatorError(code, failureCode, message, details);
}

const normalizePathForComparison = (value: string): string =>
  process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;

const pathsEqual = (left: string, right: string): boolean =>
  normalizePathForComparison(left) === normalizePathForComparison(right);

export const snapshotAbsolutePath = (
  value: unknown,
  failureCode: string,
  label: string
): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 32_768 ||
    value.includes("\0") ||
    !path.isAbsolute(value)
  ) {
    productionAgentReject(
      "INVALID_ARGUMENT",
      failureCode,
      `${label} must be an explicitly configured absolute path`
    );
  }
  const resolved = path.resolve(value);
  if (!pathsEqual(resolved, value)) {
    productionAgentReject(
      "INVALID_ARGUMENT",
      failureCode,
      `${label} must not contain lexical path drift`,
      { configuredPath: value }
    );
  }
  return resolved;
};

export const plainDataProperties = (
  value: unknown,
  expectedKeys: readonly string[],
  failureCode: string,
  label: string
): Readonly<Record<string, PropertyDescriptor>> => {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeTypes.isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    productionAgentReject(
      "INVALID_ARGUMENT",
      failureCode,
      `${label} must be a non-proxy plain object`
    );
  }
  const expected = new Set(expectedKeys);
  if (expected.size !== expectedKeys.length) {
    productionAgentReject("INVALID_ARGUMENT", failureCode, `${label} schema contains duplicate fields`);
  }
  const descriptors = Object.create(null) as Record<string, PropertyDescriptor>;
  // Only explicitly allowlisted own enumerable string fields can carry authority. Unknown,
  // non-enumerable, and symbol metadata is never enumerated, read, copied, or canonicalized.
  for (const name of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      productionAgentReject(
        "INVALID_ARGUMENT",
        failureCode,
        `${label} is missing a required enumerable data property`
      );
    }
    Object.defineProperty(descriptors, name, {
      value: descriptor,
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return descriptors;
};

export const arrayDataValues = (
  value: unknown,
  maximumLength: number,
  failureCode: string,
  label: string,
  allowEmpty = false
): readonly unknown[] => {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    !Number.isSafeInteger(maximumLength) ||
    maximumLength < 0
  ) {
    productionAgentReject(
      "INVALID_ARGUMENT",
      failureCode,
      `${label} must be a bounded plain array`
    );
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > maximumLength ||
    (!allowEmpty && lengthDescriptor.value === 0)
  ) {
    productionAgentReject(
      "INVALID_ARGUMENT",
      failureCode,
      `${label} must be a dense array without named properties`
    );
  }
  const length = lengthDescriptor.value as number;
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      productionAgentReject(
        "INVALID_ARGUMENT",
        failureCode,
        `${label} must contain only enumerable data entries`
      );
    }
    result.push(descriptor.value);
  }
  return result;
};

const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "buffer"
)?.get;
const TYPED_ARRAY_BYTE_OFFSET_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteOffset"
)?.get;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteLength"
)?.get;
const ARRAY_BUFFER_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength"
)?.get;
const SHARED_ARRAY_BUFFER_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  SharedArrayBuffer.prototype,
  "byteLength"
)?.get;

function rejectTypedArray(failureCode: string, label: string): never {
  productionAgentReject(
    "INVALID_ARGUMENT",
    failureCode,
    `${label} must be a bounded ordinary Uint8Array with an attached non-shared buffer`
  );
}

/**
 * Copies an exact ordinary Uint8Array/Buffer through captured intrinsic metadata. Instance
 * getters, iterators, species, subclasses, proxies, shared buffers, and detached buffers are never
 * accepted as byte authority.
 */
export const copyBoundedOrdinaryUint8Array = (
  value: unknown,
  minimumBytes: number,
  maximumBytes: number,
  failureCode: string,
  label: string
): Buffer => {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeTypes.isProxy(value) ||
    !Number.isSafeInteger(minimumBytes) ||
    !Number.isSafeInteger(maximumBytes) ||
    minimumBytes < 0 ||
    maximumBytes < minimumBytes
  ) {
    rejectTypedArray(failureCode, label);
  }
  const prototype = Object.getPrototypeOf(value);
  const isOrdinaryUint8Array = prototype === Uint8Array.prototype;
  const isOrdinaryBuffer = Buffer.isBuffer(value) && prototype === Buffer.prototype;
  if (
    (!isOrdinaryUint8Array && !isOrdinaryBuffer) ||
    TYPED_ARRAY_BUFFER_GETTER === undefined ||
    TYPED_ARRAY_BYTE_OFFSET_GETTER === undefined ||
    TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined ||
    ARRAY_BUFFER_BYTE_LENGTH_GETTER === undefined ||
    SHARED_ARRAY_BUFFER_BYTE_LENGTH_GETTER === undefined
  ) {
    rejectTypedArray(failureCode, label);
  }
  const bufferGetter = TYPED_ARRAY_BUFFER_GETTER!;
  const byteOffsetGetter = TYPED_ARRAY_BYTE_OFFSET_GETTER!;
  const byteLengthGetter = TYPED_ARRAY_BYTE_LENGTH_GETTER!;
  const arrayBufferByteLengthGetter = ARRAY_BUFFER_BYTE_LENGTH_GETTER!;
  const sharedArrayBufferByteLengthGetter = SHARED_ARRAY_BUFFER_BYTE_LENGTH_GETTER!;

  let metadata: {
    readonly backingBuffer: ArrayBuffer | SharedArrayBuffer;
    readonly byteOffset: number;
    readonly byteLength: number;
  };
  try {
    metadata = {
      backingBuffer: Reflect.apply(bufferGetter, value, []) as ArrayBuffer | SharedArrayBuffer,
      byteOffset: Reflect.apply(byteOffsetGetter, value, []) as number,
      byteLength: Reflect.apply(byteLengthGetter, value, []) as number
    };
  } catch {
    rejectTypedArray(failureCode, label);
  }
  const { backingBuffer, byteOffset, byteLength } = metadata;

  let shared = true;
  try {
    Reflect.apply(sharedArrayBufferByteLengthGetter, backingBuffer, []);
  } catch {
    shared = false;
  }
  if (shared) rejectTypedArray(failureCode, label);

  let backingByteLength: number;
  try {
    backingByteLength = Reflect.apply(
      arrayBufferByteLengthGetter,
      backingBuffer,
      []
    ) as number;
  } catch {
    rejectTypedArray(failureCode, label);
  }
  if (
    !Number.isSafeInteger(byteOffset) ||
    !Number.isSafeInteger(byteLength) ||
    !Number.isSafeInteger(backingByteLength) ||
    byteOffset < 0 ||
    byteLength < minimumBytes ||
    byteLength > maximumBytes ||
    backingByteLength < byteOffset + byteLength
  ) {
    rejectTypedArray(failureCode, label);
  }
  try {
    return Buffer.from(new Uint8Array(backingBuffer as ArrayBuffer, byteOffset, byteLength));
  } catch {
    rejectTypedArray(failureCode, label);
  }
};

export const boundedIdentifier = (
  value: unknown,
  failureCode: string,
  label: string
): string => {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 160 ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:+/-]*$/u.test(value)
  ) {
    productionAgentReject("INVALID_ARGUMENT", failureCode, `${label} is not a bounded identifier`);
  }
  return value;
};

export const snapshotContentIdentity = (
  value: unknown,
  failureCode: string,
  label: string
): ContentIdentity => {
  const descriptors = plainDataProperties(
    value,
    ["algorithm", "digest", "size"],
    failureCode,
    label
  );
  const algorithm = descriptors.algorithm!.value;
  const digest = descriptors.digest!.value;
  const size = descriptors.size!.value;
  if (
    algorithm !== "sha256" ||
    typeof digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(digest) ||
    !Number.isSafeInteger(size) ||
    size < 0
  ) {
    productionAgentReject("INVALID_ARGUMENT", failureCode, `${label} is invalid`);
  }
  return Object.freeze({ algorithm: "sha256" as const, digest, size });
};

export const contentIdentitiesEqual = (
  left: ContentIdentity,
  right: ContentIdentity
): boolean =>
  left.size === right.size && constantTimeDigestEqual(left.digest, right.digest);

export const deepFreezeProductionValue = <Value>(
  value: Value,
  seen = new Set<object>()
): Value => {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor && descriptor.enumerable === true) {
      deepFreezeProductionValue(descriptor.value, seen);
    }
  }
  return Object.isFrozen(value) ? value : Object.freeze(value);
};

const sameFileVersion = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs &&
  left.birthtimeMs === right.birthtimeMs;

const sameFilesystemObject = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.isDirectory() === right.isDirectory();

const assertResolvedPathStable = async (
  configuredPath: string,
  failureCode: string,
  label: string
): Promise<void> => {
  const resolved = await realpath(configuredPath);
  if (!pathsEqual(resolved, configuredPath)) {
    productionAgentReject(
      "POLICY_DENIED",
      failureCode,
      `${label} resolves through a symbolic link or path alias`,
      { configuredPath }
    );
  }
};

export const assertAbsoluteOrdinaryDirectory = async (
  directoryPath: string,
  failureCode: string,
  label: string
): Promise<void> => {
  const before = await lstat(directoryPath);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    productionAgentReject(
      "POLICY_DENIED",
      failureCode,
      `${label} must be an existing ordinary directory`,
      { directoryPath }
    );
  }
  await assertResolvedPathStable(directoryPath, failureCode, label);
  const after = await lstat(directoryPath);
  // Directory timestamps and sizes legitimately change when a peer creates a lock claim or
  // receipt. Object identity and type, not mutable directory contents, establish path stability.
  if (!sameFilesystemObject(before, after)) {
    productionAgentReject(
      "ARTIFACT_INTEGRITY_ERROR",
      failureCode,
      `${label} changed while its path was authenticated`,
      { directoryPath }
    );
  }
};

export interface BoundedOrdinaryFile {
  readonly configuredPath: string;
  readonly bytes: Buffer;
  readonly identity: ContentIdentity;
}

export const readBoundedOrdinaryFile = async (
  configuredPath: string,
  maximumBytes: number,
  failureCode: string,
  label: string
): Promise<BoundedOrdinaryFile> => {
  const before = await lstat(configuredPath);
  if (before.isSymbolicLink() || !before.isFile()) {
    productionAgentReject(
      "POLICY_DENIED",
      failureCode,
      `${label} must be an ordinary file and cannot be a symbolic link`,
      { configuredPath }
    );
  }
  if (before.size > maximumBytes) {
    productionAgentReject(
      "ARTIFACT_INTEGRITY_ERROR",
      failureCode,
      `${label} exceeds its byte limit`,
      { maximumBytes, actualBytes: before.size }
    );
  }
  await assertResolvedPathStable(configuredPath, failureCode, label);

  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  const handle = await open(configuredPath, fsConstants.O_RDONLY | noFollow);
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileVersion(before, opened)) {
      productionAgentReject(
        "ARTIFACT_INTEGRITY_ERROR",
        failureCode,
        `${label} changed before it could be read`,
        { configuredPath }
      );
    }
    const bounded = Buffer.alloc(Math.min(maximumBytes + 1, before.size + 1));
    let offset = 0;
    while (offset < bounded.length) {
      const read = await handle.read(bounded, offset, bounded.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset > maximumBytes) {
      productionAgentReject(
        "ARTIFACT_INTEGRITY_ERROR",
        failureCode,
        `${label} grew beyond its byte limit while being read`,
        { maximumBytes }
      );
    }
    bytes = Buffer.from(bounded.subarray(0, offset));
    const afterHandle = await handle.stat();
    if (!sameFileVersion(opened, afterHandle) || afterHandle.size !== bytes.length) {
      productionAgentReject(
        "ARTIFACT_INTEGRITY_ERROR",
        failureCode,
        `${label} changed while being read`,
        { configuredPath }
      );
    }
  } finally {
    await handle.close();
  }

  const afterPath = await lstat(configuredPath);
  await assertResolvedPathStable(configuredPath, failureCode, label);
  if (!sameFileVersion(before, afterPath)) {
    productionAgentReject(
      "ARTIFACT_INTEGRITY_ERROR",
      failureCode,
      `${label} path target drifted while being read`,
      { configuredPath }
    );
  }
  // Buffer instances cannot be frozen by Node. The buffer is a fresh private copy; callers must
  // consume it synchronously into a validated snapshot and never retain it as an authority object.
  return Object.freeze({
    configuredPath,
    bytes,
    identity: Object.freeze(contentIdentity(bytes))
  });
};
