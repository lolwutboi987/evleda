import { isProxy } from "node:util/types";
import { canonicalIdentity, canonicalJson, constantTimeDigestEqual, contentIdentity } from "./canonical.js";
import { DomainError } from "../domain/errors.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";

export const PORTABLE_CANONICALIZATION_VERSION = "evleda-c14n-json-v1" as const;
interface ResolvedPortableJsonLimits {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxArrayLength: number;
  readonly maxOwnKeys: number;
  readonly maxKeyBytes: number;
  readonly maxStringBytes: number;
}

export const PORTABLE_JSON_LIMITS: ResolvedPortableJsonLimits = Object.freeze({
  maxBytes: 1_048_576,
  maxDepth: 64,
  maxNodes: 100_000,
  maxArrayLength: 32_768,
  maxOwnKeys: 4_096,
  maxKeyBytes: 512,
  maxStringBytes: 262_144
});

const PORTABLE_JSON_HARD_LIMITS: ResolvedPortableJsonLimits = Object.freeze({
  maxBytes: 16_777_216,
  maxDepth: 128,
  maxNodes: 500_000,
  maxArrayLength: 200_000,
  maxOwnKeys: 16_384,
  maxKeyBytes: 4_096,
  maxStringBytes: 1_048_576
});

const fail = (message: string, details: Readonly<Record<string, unknown>> = {}): never => {
  throw new DomainError("INVALID_ARGUMENT", message, details);
};

const ReflectApply = Reflect.apply;
const FunctionHasInstance = Function.prototype[Symbol.hasInstance];
const IntrinsicUint8Array = Uint8Array;
const IntrinsicUint8ArraySet = Uint8Array.prototype.set;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const typedArrayByteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get;
const IntrinsicSharedArrayBuffer = typeof SharedArrayBuffer === "undefined" ? undefined : SharedArrayBuffer;
const IntrinsicTextDecoder = TextDecoder;
const rawSnapshotBytes = new WeakMap<object, Uint8Array>();

const utf8Length = (value: string): number => Buffer.byteLength(value, "utf8");

/** Validate Unicode scalar well-formedness without rewriting identity-critical text. */
const requireUnicodeScalars = (value: string, path: string): string => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail(`Unpaired Unicode surrogate at ${path}`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail(`Unpaired Unicode surrogate at ${path}`);
    }
  }
  return value;
};

export interface PortableRawByteSnapshot {
  readonly identity: ContentIdentity;
  readonly byteLength: number;
}

/** Capture caller-controlled bytes exactly once; shared backing is never coherent evidence. */
export const capturePortableRawBytes = (
  value: Uint8Array,
  maxBytes = PORTABLE_JSON_HARD_LIMITS.maxBytes,
  allowEmpty = true
): PortableRawByteSnapshot => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > PORTABLE_JSON_HARD_LIMITS.maxBytes) {
    return fail("Invalid raw-byte capture limit");
  }
  if (value === null || typeof value !== "object" || isProxy(value)) {
    return fail("Raw-byte input must be a non-proxy Uint8Array");
  }
  let branded = false;
  try {
    branded = Boolean(ReflectApply(FunctionHasInstance, IntrinsicUint8Array, [value]));
  } catch {
    return fail("Raw-byte input brand check failed");
  }
  if (!branded || typedArrayBufferGetter === undefined || typedArrayByteLengthGetter === undefined || typedArrayByteOffsetGetter === undefined) {
    return fail("Raw-byte input must be a Uint8Array");
  }
  let backing: ArrayBufferLike;
  let byteLength: number;
  let byteOffset: number;
  try {
    backing = ReflectApply(typedArrayBufferGetter, value, []) as ArrayBufferLike;
    byteLength = ReflectApply(typedArrayByteLengthGetter, value, []) as number;
    byteOffset = ReflectApply(typedArrayByteOffsetGetter, value, []) as number;
  } catch {
    return fail("Raw-byte input is detached or incoherent");
  }
  if (IntrinsicSharedArrayBuffer !== undefined && ReflectApply(FunctionHasInstance, IntrinsicSharedArrayBuffer, [backing])) {
    return fail("SharedArrayBuffer-backed raw bytes are forbidden");
  }
  if (!Number.isSafeInteger(byteLength) || !Number.isSafeInteger(byteOffset) || byteLength > maxBytes || (!allowEmpty && byteLength === 0)) {
    return fail("Raw-byte capture length is outside the closed contract");
  }
  try {
    const snapshot = new IntrinsicUint8Array(byteLength);
    const source = new IntrinsicUint8Array(backing as ArrayBuffer, byteOffset, byteLength);
    ReflectApply(IntrinsicUint8ArraySet, snapshot, [source]);
    if (
      ReflectApply(typedArrayBufferGetter, value, []) !== backing ||
      ReflectApply(typedArrayByteLengthGetter, value, []) !== byteLength ||
      ReflectApply(typedArrayByteOffsetGetter, value, []) !== byteOffset
    ) return fail("Raw-byte input changed identity during capture");
    const token = Object.freeze({ identity: Object.freeze(contentIdentity(snapshot)), byteLength });
    rawSnapshotBytes.set(token, snapshot);
    return token;
  } catch {
    return fail("Raw-byte input could not be captured coherently");
  }
};

const requireRawSnapshotBytes = (snapshot: PortableRawByteSnapshot): Uint8Array => {
  if (snapshot === null || typeof snapshot !== "object" || isProxy(snapshot)) {
    return fail("Portable raw snapshot token is invalid");
  }
  const bytes = rawSnapshotBytes.get(snapshot);
  if (bytes === undefined) return fail("Portable raw snapshot token is not authentic");
  return bytes;
};

export const decodeCapturedPortableUtf8 = (
  snapshot: PortableRawByteSnapshot,
  kind: string,
  allowEmpty = false
): string => {
  const bytes = requireRawSnapshotBytes(snapshot);
  if (!allowEmpty && bytes.byteLength === 0) return fail("Portable raw snapshot is empty");
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return fail("UTF-8 BOM is forbidden in portable raw evidence");
  }
  try {
    return new IntrinsicTextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail(`Portable ${kind} evidence must be valid UTF-8`);
  }
};

export const assertCapturedPortablePdfSignature = (snapshot: PortableRawByteSnapshot): void => {
  const bytes = requireRawSnapshotBytes(snapshot);
  if (
    bytes.byteLength < 9 || bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46 ||
    bytes[4] !== 0x2d || (bytes[5] !== 0x31 && bytes[5] !== 0x32) || bytes[6] !== 0x2e ||
    bytes[7]! < 0x30 || bytes[7]! > 0x39 || ![0x0a, 0x0d, 0x20].includes(bytes[8]!)
  ) fail("Successful PDF capture lacks the bounded PDF header signature");
};

const MAX_SAFE_DECIMAL = "9007199254740991";

const validatePortableNumberToken = (token: string, path: string): void => {
  const match = /^-?([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?)([0-9]+))?$/u.exec(token);
  if (match === null) return fail(`Invalid portable number token at ${path}`);
  const integerDigits = match[1]!;
  const fractionDigits = match[2] ?? "";
  const exponentDigits = match[4] ?? "";
  if (
    integerDigits.length + fractionDigits.length > 128 ||
    exponentDigits.length > 6 ||
    token.length > 160
  ) {
    return fail(`Portable number lexical budget exceeded at ${path}`);
  }
  const exponentMagnitude = exponentDigits.length === 0 ? 0 : Number(exponentDigits);
  if (!Number.isSafeInteger(exponentMagnitude) || exponentMagnitude > 999_999) {
    return fail(`Portable number exponent budget exceeded at ${path}`);
  }
  const exponent = (match[3] === "-" ? -1 : 1) * exponentMagnitude;
  const coefficient = `${integerDigits}${fractionDigits}`.replace(/^0+/u, "") || "0";
  if (coefficient === "0") return;
  const scale = fractionDigits.length - exponent;
  let whole: string;
  let fractionalRemainder = "";
  if (scale <= 0) {
    if (coefficient.length - scale > MAX_SAFE_DECIMAL.length) {
      return fail(`Portable number magnitude exceeds MAX_SAFE_INTEGER at ${path}`);
    }
    whole = `${coefficient}${"0".repeat(-scale)}`;
  } else {
    const wholeLength = coefficient.length - scale;
    if (wholeLength <= 0) {
      whole = "0";
      fractionalRemainder = `${"0".repeat(-wholeLength)}${coefficient}`;
    } else {
      whole = coefficient.slice(0, wholeLength);
      fractionalRemainder = coefficient.slice(wholeLength);
    }
  }
  whole = whole.replace(/^0+/u, "") || "0";
  if (
    whole.length > MAX_SAFE_DECIMAL.length ||
    (whole.length === MAX_SAFE_DECIMAL.length &&
      (whole > MAX_SAFE_DECIMAL || (whole === MAX_SAFE_DECIMAL && /[1-9]/u.test(fractionalRemainder))))
  ) {
    return fail(`Portable number magnitude exceeds MAX_SAFE_INTEGER at ${path}`);
  }
  const parsed = Number(token);
  if (!Number.isFinite(parsed)) return fail(`Portable number is not finite at ${path}`);
  if (parsed === 0) return fail(`Portable number underflow is forbidden at ${path}`);
  const mathematicallyIntegral = scale <= 0 || !/[1-9]/u.test(fractionalRemainder);
  if (Number.isInteger(parsed) && !mathematicallyIntegral) {
    return fail(`Portable number rounding to an integer is forbidden at ${path}`);
  }
};

class JsonDuplicateScanner {
  readonly #text: string;
  readonly #limits: typeof PORTABLE_JSON_LIMITS;
  #index = 0;
  #nodes = 0;

  public constructor(text: string, limits: typeof PORTABLE_JSON_LIMITS) {
    this.#text = text;
    this.#limits = limits;
  }

  public scan(): void {
    this.#skipSpace();
    this.#value(0, "$");
    this.#skipSpace();
    if (this.#index !== this.#text.length) {
      fail("Trailing JSON data is forbidden", { offset: this.#index });
    }
  }

  #bump(path: string): void {
    this.#nodes += 1;
    if (this.#nodes > this.#limits.maxNodes) {
      fail("Portable JSON node budget exceeded", { path });
    }
  }

  #peek(): string | undefined {
    return this.#text[this.#index];
  }

  #skipSpace(): void {
    while ([" ", "\t", "\r", "\n"].includes(this.#peek() ?? "")) this.#index += 1;
  }

  #value(depth: number, path: string): void {
    if (depth > this.#limits.maxDepth) fail("Portable JSON depth budget exceeded", { path });
    this.#bump(path);
    const next = this.#peek();
    if (next === "{") return this.#object(depth, path);
    if (next === "[") return this.#array(depth, path);
    if (next === '"') {
      this.#string(path, false);
      return;
    }
    let token: string | undefined;
    for (const literal of ["true", "false", "null"] as const) {
      if (this.#text.startsWith(literal, this.#index)) token = literal;
    }
    if (token === undefined) {
      const numberPattern = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/uy;
      numberPattern.lastIndex = this.#index;
      token = numberPattern.exec(this.#text)?.[0];
    }
    if (token === undefined) return fail("Invalid JSON token", { path, offset: this.#index });
    if (token !== "true" && token !== "false" && token !== "null") validatePortableNumberToken(token, path);
    this.#index += token.length;
  }

  #string(path: string, key: boolean): string {
    const start = this.#index;
    this.#index += 1;
    let escaped = false;
    while (this.#index < this.#text.length) {
      const code = this.#text.charCodeAt(this.#index);
      if (!escaped && code === 0x22) {
        this.#index += 1;
        const token = this.#text.slice(start, this.#index);
        let decoded: string;
        try {
          const candidate = JSON.parse(token) as unknown;
          if (typeof candidate !== "string") return fail("Invalid JSON string", { path });
          decoded = candidate;
        } catch {
          return fail("Invalid JSON string", { path, offset: start });
        }
        requireUnicodeScalars(decoded, path);
        const size = utf8Length(decoded);
        if (size > (key ? this.#limits.maxKeyBytes : this.#limits.maxStringBytes)) {
          fail(key ? "Portable JSON key budget exceeded" : "Portable JSON string budget exceeded", { path });
        }
        return decoded;
      }
      if (!escaped && code < 0x20) fail("Unescaped JSON control character", { path, offset: this.#index });
      if (escaped) {
        if (code === 0x75) {
          const hex = this.#text.slice(this.#index + 1, this.#index + 5);
          if (!/^[0-9a-fA-F]{4}$/u.test(hex)) fail("Invalid JSON unicode escape", { path });
          this.#index += 4;
        } else if (!'"\\/bfnrt'.includes(String.fromCharCode(code))) {
          fail("Invalid JSON escape", { path, offset: this.#index });
        }
        escaped = false;
      } else if (code === 0x5c) {
        escaped = true;
      }
      this.#index += 1;
    }
    return fail("Unterminated JSON string", { path, offset: start });
  }

  #object(depth: number, path: string): void {
    this.#index += 1;
    this.#skipSpace();
    const keys = new Set<string>();
    if (this.#peek() === "}") {
      this.#index += 1;
      return;
    }
    while (true) {
      if (this.#peek() !== '"') fail("JSON object key must be a string", { path });
      const key = this.#string(path, true);
      if (keys.has(key)) fail("Duplicate JSON object key", { path });
      keys.add(key);
      if (keys.size > this.#limits.maxOwnKeys) fail("Portable JSON own-key budget exceeded", { path });
      this.#skipSpace();
      if (this.#peek() !== ":") fail("Missing JSON object colon", { path, key });
      this.#index += 1;
      this.#skipSpace();
      this.#value(depth + 1, `${path}/<member>`);
      this.#skipSpace();
      if (this.#peek() === "}") {
        this.#index += 1;
        return;
      }
      if (this.#peek() !== ",") fail("Missing JSON object comma", { path });
      this.#index += 1;
      this.#skipSpace();
    }
  }

  #array(depth: number, path: string): void {
    this.#index += 1;
    this.#skipSpace();
    if (this.#peek() === "]") {
      this.#index += 1;
      return;
    }
    let count = 0;
    while (true) {
      if (count >= this.#limits.maxArrayLength) fail("Portable JSON array budget exceeded", { path });
      this.#value(depth + 1, `${path}/${count}`);
      count += 1;
      this.#skipSpace();
      if (this.#peek() === "]") {
        this.#index += 1;
        return;
      }
      if (this.#peek() !== ",") fail("Missing JSON array comma", { path });
      this.#index += 1;
      this.#skipSpace();
    }
  }
}

export interface PortableJsonParseLimits {
  readonly maxBytes?: number;
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly maxArrayLength?: number;
  readonly maxOwnKeys?: number;
  readonly maxKeyBytes?: number;
  readonly maxStringBytes?: number;
}

const effectiveLimits = (overrides: PortableJsonParseLimits = {}): ResolvedPortableJsonLimits => ({
  ...validateLimitOverrides(overrides)
});

const validateLimitOverrides = (overrides: PortableJsonParseLimits): ResolvedPortableJsonLimits => {
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides) || isProxy(overrides)) {
    return fail("Portable JSON limit overrides must be a plain non-proxy object");
  }
  const known = new Set(Object.keys(PORTABLE_JSON_LIMITS));
  const unknown = Object.keys(overrides).filter((key) => !known.has(key));
  if (unknown.length > 0) return fail("Unknown portable JSON limit override", { unknown });
  const descriptors = Object.getOwnPropertyDescriptors(overrides);
  const result = {} as Record<keyof ResolvedPortableJsonLimits, number>;
  for (const key of Object.keys(PORTABLE_JSON_LIMITS) as (keyof ResolvedPortableJsonLimits)[]) {
    const descriptor = descriptors[key];
    if (descriptor !== undefined && (!("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined)) {
      return fail("Accessor portable JSON limit override is forbidden", { key });
    }
    const candidate = descriptor?.value ?? PORTABLE_JSON_LIMITS[key];
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || !Number.isSafeInteger(candidate) || candidate < 0 || candidate > PORTABLE_JSON_HARD_LIMITS[key]) {
      fail("Invalid portable JSON limit override", { key, candidate, hardMaximum: PORTABLE_JSON_HARD_LIMITS[key] });
    }
    result[key] = candidate;
  }
  return result;
};

const parsePortableJsonSnapshot = (snapshot: PortableRawByteSnapshot, overrides: PortableJsonParseLimits = {}): unknown => {
  const limits = effectiveLimits(overrides);
  const bytes = requireRawSnapshotBytes(snapshot);
  if (bytes.byteLength > limits.maxBytes) fail("Portable JSON byte budget exceeded");
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return fail("UTF-8 BOM is forbidden in portable JSON");
  }
  let text = "";
  try {
    text = new IntrinsicTextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("Portable JSON must be valid UTF-8");
  }
  new JsonDuplicateScanner(text, limits).scan();
  return hardenPortableValue(JSON.parse(text) as unknown, limits);
};

export const parseCapturedPortableJsonBytes = (
  snapshot: PortableRawByteSnapshot,
  overrides: PortableJsonParseLimits = {}
): unknown => parsePortableJsonSnapshot(snapshot, overrides);

export const parsePortableJsonBytes = (bytes: Uint8Array, overrides: PortableJsonParseLimits = {}): unknown => {
  const limits = effectiveLimits(overrides);
  return parsePortableJsonSnapshot(capturePortableRawBytes(bytes, limits.maxBytes), limits);
};

export const hardenPortableValue = (value: unknown, overrides: PortableJsonParseLimits = {}): unknown => {
  const limits = effectiveLimits(overrides);
  const active = new WeakSet<object>();
  let nodes = 0;
  let aggregateBytes = 0;

  const addBytes = (amount: number, path: string): void => {
    aggregateBytes += amount;
    if (!Number.isSafeInteger(aggregateBytes) || aggregateBytes > limits.maxBytes) {
      fail("Portable value aggregate byte budget exceeded", { path });
    }
  };

  const visit = (candidate: unknown, depth: number, path: string): unknown => {
    nodes += 1;
    if (nodes > limits.maxNodes) fail("Portable value node budget exceeded", { path });
    if (depth > limits.maxDepth) fail("Portable value depth budget exceeded", { path });
    if (candidate === null || typeof candidate === "boolean") {
      addBytes(candidate === null ? 4 : candidate ? 4 : 5, path);
      return candidate;
    }
    if (typeof candidate === "string") {
      requireUnicodeScalars(candidate, path);
      const size = utf8Length(candidate);
      if (size > limits.maxStringBytes) fail("Portable value string budget exceeded", { path });
      addBytes(size + 2, path);
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) fail("Portable values require finite numbers", { path });
      if (Math.abs(candidate) > Number.MAX_SAFE_INTEGER) fail("Portable number magnitude exceeds MAX_SAFE_INTEGER", { path });
      addBytes(String(candidate).length, path);
      return Object.is(candidate, -0) ? 0 : candidate;
    }
    if (typeof candidate !== "object") return fail("Portable values permit JSON data only", { path });
    if (isProxy(candidate)) fail("Proxy objects are forbidden in portable values", { path });
    if (active.has(candidate)) fail("Cycles are forbidden in portable values", { path });
    active.add(candidate);
    try {
      const ownKeys = Reflect.ownKeys(candidate);
      if (ownKeys.some((key) => typeof key === "symbol")) fail("Symbol keys are forbidden", { path });
      if (Array.isArray(candidate)) {
        if (candidate.length > limits.maxArrayLength) fail("Portable value array budget exceeded", { path });
        const allowedKeys = new Set(["length", ...Array.from({ length: candidate.length }, (_, index) => String(index))]);
        if (ownKeys.some((key) => typeof key !== "string" || !allowedKeys.has(key))) {
          fail("Exotic array properties are forbidden", { path });
        }
        const descriptors = Object.getOwnPropertyDescriptors(candidate);
        const output: unknown[] = [];
        for (let index = 0; index < candidate.length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) {
            return fail("Sparse or accessor arrays are forbidden", { path, index });
          }
          output.push(visit(descriptor.value, depth + 1, `${path}/${index}`));
        }
        return Object.freeze(output);
      }
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) fail("Only plain portable objects are allowed", { path });
      if (ownKeys.length > limits.maxOwnKeys) fail("Portable value own-key budget exceeded", { path });
      const stringKeys = ownKeys as string[];
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      const output = Object.create(null) as Record<string, unknown>;
      for (const key of stringKeys) {
        requireUnicodeScalars(key, `${path}/<key>`);
        const keySize = utf8Length(key);
        if (keySize > limits.maxKeyBytes) fail("Portable value key budget exceeded", { path });
        addBytes(keySize + 3, path);
        const descriptor = descriptors[key];
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) {
          return fail("Non-enumerable or accessor properties are forbidden", { path, key });
        }
        Object.defineProperty(output, key, {
          value: visit(descriptor.value, depth + 1, `${path}/<member>`),
          enumerable: true,
          configurable: false,
          writable: false
        });
      }
      return Object.freeze(output);
    } finally {
      active.delete(candidate);
    }
  };

  const result = visit(value, 0, "$");
  let canonicalWork = 0;
  const canonicalSize = (candidate: unknown): number => {
    let size: number;
    if (candidate === null) size = 4;
    else if (typeof candidate === "boolean") size = candidate ? 4 : 5;
    else if (typeof candidate === "number") size = utf8Length(Object.is(candidate, -0) ? "0" : JSON.stringify(candidate));
    else if (typeof candidate === "string") size = utf8Length(JSON.stringify(candidate));
    else if (Array.isArray(candidate)) {
      size = 2 + Math.max(0, candidate.length - 1);
      for (const entry of candidate) size += canonicalSize(entry);
    } else {
      const object = candidate as Readonly<Record<string, unknown>>;
      const keys = Object.keys(object).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
      size = 2 + Math.max(0, keys.length - 1);
      for (const key of keys) size += utf8Length(JSON.stringify(key)) + 1 + canonicalSize(object[key]);
    }
    canonicalWork += 1;
    if (!Number.isSafeInteger(size) || size > limits.maxBytes || canonicalWork > limits.maxNodes) {
      fail("Portable value canonical serialized-size/work budget exceeded");
    }
    return size;
  };
  canonicalSize(result);
  return result;
};

export const canonicalPortableJson = (value: unknown): string => {
  const result = canonicalJson(hardenPortableValue(value));
  if (utf8Length(result) > PORTABLE_JSON_LIMITS.maxBytes) {
    return fail("Canonical portable document exceeds the aggregate byte budget");
  }
  return result;
};
export const canonicalPortableBytes = (value: unknown): Uint8Array => Buffer.from(canonicalPortableJson(value), "utf8");
export const portableContentIdentity = (bytes: Uint8Array | string): ContentIdentity => {
  if (typeof bytes === "string") {
    requireUnicodeScalars(bytes, "$content");
    return Object.freeze(contentIdentity(bytes));
  }
  return capturePortableRawBytes(bytes).identity;
};
export const portableCanonicalIdentity = (value: unknown, schemaVersion: string): CanonicalIdentity => {
  if (typeof schemaVersion !== "string" || utf8Length(schemaVersion) > 256 || !SCHEMA_TOKEN.test(schemaVersion)) {
    fail("Cannot mint an identity for an invalid schema domain");
  }
  return Object.freeze(canonicalIdentity(hardenPortableValue(value), schemaVersion));
};

const record = (value: unknown, path: string): Readonly<Record<string, unknown>> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`Expected object at ${path}`);
  return value as Readonly<Record<string, unknown>>;
};

const exactKeys = (
  value: Readonly<Record<string, unknown>>,
  path: string,
  required: readonly string[],
  optional: readonly string[] = []
): void => {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`Unknown field at ${path}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`Missing field at ${path}/${key}`);
  }
};

const text = (value: unknown, path: string, pattern?: RegExp, maxBytes = 512): string => {
  if (typeof value !== "string") return fail(`Expected string at ${path}`);
  requireUnicodeScalars(value, path);
  if (utf8Length(value) > maxBytes || (pattern !== undefined && !pattern.test(value))) fail(`Invalid string at ${path}`);
  return value;
};

const integer = (value: unknown, path: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return fail(`Expected bounded integer at ${path}`);
  }
  return value;
};

const oneOf = <T extends string>(value: unknown, path: string, choices: readonly T[]): T => {
  if (typeof value !== "string" || !choices.includes(value as T)) fail(`Invalid enum at ${path}`);
  return value as T;
};

const HEX_64 = /^[0-9a-f]{64}$/u;
const SCHEMA_TOKEN = /^evleda\.[a-z0-9][a-z0-9._-]*\.v[1-9][0-9]*$/u;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+@,=-]{0,127}$/u;
const COMMAND_LITERAL = /^(?:[A-Za-z0-9][A-Za-z0-9._+@,=-]{0,127}|--[a-z0-9][a-z0-9-]{0,125})$/u;

export const validateContentIdentity = (value: unknown, path = "$identity"): ContentIdentity => {
  const safe = record(value, path);
  exactKeys(safe, path, ["algorithm", "digest", "size"]);
  if (safe.algorithm !== "sha256") fail(`Unsupported digest algorithm at ${path}/algorithm`);
  return Object.freeze({
    algorithm: "sha256",
    digest: text(safe.digest, `${path}/digest`, HEX_64, 64),
    size: integer(safe.size, `${path}/size`)
  });
};

export const validateCanonicalIdentity = (value: unknown, path = "$identity"): CanonicalIdentity => {
  const safe = record(value, path);
  exactKeys(safe, path, ["algorithm", "digest", "schemaVersion", "canonicalizationVersion"]);
  if (safe.algorithm !== "sha256" || safe.canonicalizationVersion !== PORTABLE_CANONICALIZATION_VERSION) {
    fail(`Unsupported canonical identity at ${path}`);
  }
  return Object.freeze({
    algorithm: "sha256",
    digest: text(safe.digest, `${path}/digest`, HEX_64, 64),
    schemaVersion: text(safe.schemaVersion, `${path}/schemaVersion`, SCHEMA_TOKEN),
    canonicalizationVersion: PORTABLE_CANONICALIZATION_VERSION
  });
};

const assertIdentity = (actual: CanonicalIdentity, expected: CanonicalIdentity, path: string): void => {
  if (
    actual.schemaVersion !== expected.schemaVersion ||
    actual.canonicalizationVersion !== expected.canonicalizationVersion ||
    !constantTimeDigestEqual(actual.digest, expected.digest)
  ) {
    fail(`Canonical identity mismatch at ${path}`);
  }
};

const requireIdentitySchema = (identity: CanonicalIdentity, expectedSchema: string, path: string): CanonicalIdentity => {
  if (identity.schemaVersion !== expectedSchema) fail(`Identity schema-domain mismatch at ${path}`, { expectedSchema });
  return identity;
};

const withoutKey = (value: Readonly<Record<string, unknown>>, omitted: string): Readonly<Record<string, unknown>> => {
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value)) {
    if (key !== omitted) Object.defineProperty(result, key, { value: entry, enumerable: true });
  }
  return result;
};

const rejectPathLikeText = (value: string, path: string): void => {
  if (
    /(?:[\\/]|^[A-Za-z]:|(?:^|[^A-Za-z])[a-z][a-z0-9+.-]*:\/\/|^file:|^\\\\|^\\[?.]\\|%2f|%5c)/iu.test(value)
  ) {
    fail(`Path, URI, UNC, device, and encoded separators are forbidden at ${path}`);
  }
};

export const validatePortablePathRefV1 = (value: unknown, path = "$path"): PortablePathRefV1 => {
  const safe = record(hardenPortableValue(value), path);
  exactKeys(safe, path, ["schemaVersion", "root", "relativePath"]);
  if (safe.schemaVersion !== "evleda.portable-path-ref.v1") fail(`Unsupported path schema at ${path}`);
  const root = oneOf(safe.root, `${path}/root`, PORTABLE_ROOTS);
  const relativePath = text(safe.relativePath, `${path}/relativePath`, undefined, 1_024);
  if (
    relativePath.length === 0 ||
    !/^[\x20-\x7e]+$/u.test(relativePath) ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath.includes(":") ||
    relativePath.includes("?") ||
    relativePath.includes("#") ||
    relativePath.includes("%") ||
    /^[A-Za-z]:/u.test(relativePath) ||
    /[<>|"*\u0000-\u001f\u007f]/u.test(relativePath)
  ) {
    fail(`Portable path must be a clear relative POSIX path at ${path}/relativePath`);
  }
  const segments = relativePath.split("/");
  const windowsDevices = /^(?:CON|PRN|AUX|NUL|CLOCK\$|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;
  if (
    segments.length > 64 ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.endsWith(".") ||
        segment.endsWith(" ") ||
        utf8Length(segment) > 128 ||
        /[\u0000-\u001f\u007f]/u.test(segment) ||
        windowsDevices.test(segment)
    )
  ) {
    fail(`Portable path contains a forbidden segment at ${path}/relativePath`);
  }
  return Object.freeze({ schemaVersion: "evleda.portable-path-ref.v1", root, relativePath });
};

export const validatePublicPortablePathRefV1 = (value: unknown, path = "$path"): PortablePathRefV1 => {
  const result = validatePortablePathRefV1(value, path);
  if (result.root === "run_private") fail(`Public bindings cannot reference run_private at ${path}`);
  return result;
};

export const parsePortablePathRefV1Bytes = (bytes: Uint8Array): PortablePathRefV1 =>
  validatePortablePathRefV1(parsePortableJsonBytes(bytes), "$path");

export const validateToolContentIdentityV1 = (value: unknown, path = "$tool"): ToolContentIdentityV1 => {
  const safe = record(hardenPortableValue(value), path);
  exactKeys(safe, path, [
    "schemaVersion",
    "role",
    "kind",
    "name",
    "version",
    "commit",
    "contentIdentity",
    "capabilitiesIdentity",
    "helpIdentity"
  ]);
  if (safe.schemaVersion !== "evleda.tool-content-identity.v1") fail(`Unsupported tool identity schema at ${path}`);
  const name = text(safe.name, `${path}/name`, SAFE_TOKEN, 128);
  const version = text(safe.version, `${path}/version`, SAFE_TOKEN, 128);
  const role = oneOf(safe.role, `${path}/role`, ["native_validator", "portable_normalizer", "runtime", "validation_driver"] as const);
  const kind = oneOf(safe.kind, `${path}/kind`, ["native_executable", "portable_implementation"] as const);
  const expectedKind = role === "native_validator" || role === "runtime" ? "native_executable" : "portable_implementation";
  if (kind !== expectedKind) fail(`Tool role/kind mismatch at ${path}`, { role, kind, expectedKind });
  rejectPathLikeText(name, `${path}/name`);
  rejectPathLikeText(version, `${path}/version`);
  return Object.freeze({
    schemaVersion: "evleda.tool-content-identity.v1",
    role,
    kind,
    name,
    version,
    commit: text(safe.commit, `${path}/commit`, /^(?:[0-9a-f]{40}|[0-9a-f]{64}|not_applicable)$/u, 64),
    contentIdentity: validateContentIdentity(safe.contentIdentity, `${path}/contentIdentity`),
    capabilitiesIdentity: validateContentIdentity(safe.capabilitiesIdentity, `${path}/capabilitiesIdentity`),
    helpIdentity: validateContentIdentity(safe.helpIdentity, `${path}/helpIdentity`)
  });
};

export const parseToolContentIdentityV1Bytes = (bytes: Uint8Array): ToolContentIdentityV1 =>
  validateToolContentIdentityV1(parsePortableJsonBytes(bytes), "$tool");

export const validatePortableEnvironmentPolicyV1 = (
  value: unknown,
  path = "$environment"
): PortableEnvironmentPolicyV1 => {
  const safe = record(hardenPortableValue(value), path);
  exactKeys(safe, path, ["schemaVersion", "pythonHashSeed", "pythonUtf8", "locale", "timezone", "privateFields"]);
  if (
    safe.schemaVersion !== "evleda.portable-environment-policy.v1" ||
    safe.pythonHashSeed !== "0" ||
    safe.pythonUtf8 !== "1" ||
    safe.locale !== "C" ||
    safe.timezone !== "UTC"
  ) {
    fail(`Portable environment policy must use the fixed deterministic values at ${path}`);
  }
  if (!Array.isArray(safe.privateFields)) return fail(`Expected array at ${path}/privateFields`);
  const privateFields = safe.privateFields;
  const fields = privateFields.map((entry: unknown, index: number) => {
    const item = record(entry, `${path}/privateFields/${index}`);
    exactKeys(item, `${path}/privateFields/${index}`, ["name", "disposition"]);
    if (item.disposition !== "excluded-private") fail(`Invalid private-field disposition at ${path}/privateFields/${index}`);
    return Object.freeze({
      name: oneOf(item.name, `${path}/privateFields/${index}/name`, ["HOME", "TEMP", "TMP", "KICAD_CONFIG_HOME"] as const),
      disposition: "excluded-private" as const
    });
  });
  const names = fields.map((entry) => entry.name);
  const requiredNames = ["HOME", "KICAD_CONFIG_HOME", "TEMP", "TMP"] as const;
  if (names.length !== requiredNames.length || names.some((name, index) => name !== requiredNames[index])) {
    fail(`Private environment fields must be the exact nonempty sorted set at ${path}/privateFields`);
  }
  return Object.freeze({
    schemaVersion: "evleda.portable-environment-policy.v1",
    pythonHashSeed: "0",
    pythonUtf8: "1",
    locale: "C",
    timezone: "UTC",
    privateFields: Object.freeze(fields)
  });
};

export type TypedCommandPlanDraftV1 = Omit<TypedCommandPlanV1, "commandPlanIdentity">;

export const withCommandPlanIdentity = (draft: TypedCommandPlanDraftV1): TypedCommandPlanV1 => {
  const safe = hardenPortableValue(draft) as unknown as TypedCommandPlanDraftV1;
  if (safe.schemaVersion !== "evleda.typed-command-plan.v1") fail("Cannot mint unsupported command-plan schema");
  return validateTypedCommandPlanV1(Object.freeze({
    ...safe,
    commandPlanIdentity: portableCanonicalIdentity(safe, "evleda.typed-command-plan.v1")
  }));
};

export const validateTypedCommandPlanV1 = (value: unknown, path = "$commandPlan"): TypedCommandPlanV1 => {
  const safe = record(hardenPortableValue(value), path);
  exactKeys(safe, path, ["schemaVersion", "tool", "logicalCwd", "argv", "environment", "expectedOutputs", "commandPlanIdentity"]);
  if (safe.schemaVersion !== "evleda.typed-command-plan.v1") fail(`Unsupported command-plan schema at ${path}`);
  const tool = validateToolContentIdentityV1(safe.tool, `${path}/tool`);
  const logicalCwd = validatePortablePathRefV1(safe.logicalCwd, `${path}/logicalCwd`);
  if (logicalCwd.root !== "run_input" && logicalCwd.root !== "run_public") {
    fail(`Command working directory must use run_input or run_public at ${path}/logicalCwd`);
  }
  if (!Array.isArray(safe.argv) || safe.argv.length === 0 || safe.argv.length > 128) return fail(`Invalid argv at ${path}/argv`);
  const rawArgv = safe.argv;
  const argv = rawArgv.map((entry: unknown, index: number): TypedCommandArgumentV1 => {
    const item = record(entry, `${path}/argv/${index}`);
    exactKeys(item, `${path}/argv/${index}`, ["kind", "value"]);
    if (item.kind === "literal") {
      const literal = text(item.value, `${path}/argv/${index}/value`, COMMAND_LITERAL, 128);
      rejectPathLikeText(literal, `${path}/argv/${index}/value`);
      return Object.freeze({ kind: "literal", value: literal });
    }
    if (item.kind === "path") {
      return Object.freeze({ kind: "path", value: validatePortablePathRefV1(item.value, `${path}/argv/${index}/value`) });
    }
    return fail(`Unknown argv item kind at ${path}/argv/${index}/kind`);
  });
  if (!Array.isArray(safe.expectedOutputs) || safe.expectedOutputs.length > 32) return fail(`Invalid outputs at ${path}/expectedOutputs`);
  const rawExpectedOutputs = safe.expectedOutputs;
  const expectedOutputs = rawExpectedOutputs.map((entry: unknown, index: number) =>
    validatePortablePathRefV1(entry, `${path}/expectedOutputs/${index}`)
  );
  if (expectedOutputs.some((entry) => entry.root !== "run_public" && entry.root !== "run_private")) {
    fail(`Command outputs must use run_public or run_private at ${path}/expectedOutputs`);
  }
  const foldedOutputs = expectedOutputs.map((entry) => `${entry.root}/${entry.relativePath}`.toLowerCase()).sort();
  if (new Set(foldedOutputs).size !== foldedOutputs.length) fail(`Aliasing command outputs at ${path}/expectedOutputs`);
  for (let index = 1; index < foldedOutputs.length; index += 1) {
    if (foldedOutputs[index]!.startsWith(`${foldedOutputs[index - 1]!}/`)) {
      fail(`Ancestor/descendant command outputs are forbidden at ${path}/expectedOutputs`);
    }
  }
  const environment = validatePortableEnvironmentPolicyV1(safe.environment, `${path}/environment`);
  const commandPlanIdentity = requireIdentitySchema(
    validateCanonicalIdentity(safe.commandPlanIdentity, `${path}/commandPlanIdentity`),
    "evleda.typed-command-plan.v1",
    `${path}/commandPlanIdentity`
  );
  const result = Object.freeze({
    schemaVersion: "evleda.typed-command-plan.v1" as const,
    tool,
    logicalCwd,
    argv: Object.freeze(argv),
    environment,
    expectedOutputs: Object.freeze(expectedOutputs),
    commandPlanIdentity
  });
  assertIdentity(
    commandPlanIdentity,
    portableCanonicalIdentity(withoutKey(result as unknown as Readonly<Record<string, unknown>>, "commandPlanIdentity"), "evleda.typed-command-plan.v1"),
    `${path}/commandPlanIdentity`
  );
  return result;
};

export const parseTypedCommandPlanV1Bytes = (bytes: Uint8Array): TypedCommandPlanV1 =>
  validateTypedCommandPlanV1(parsePortableJsonBytes(bytes), "$commandPlan");

export const validatePortableSourceBindingV1 = (value: unknown, path = "$sourceBinding"): PortableSourceBindingV1 => {
  const safe = record(hardenPortableValue(value), path);
  exactKeys(safe, path, ["schemaVersion", "sourceRevisionIdentity", "sourceArtifactIdentity", "sourcePath", "sourceContractIdentity"]);
  if (safe.schemaVersion !== "evleda.portable-source-binding.v1") fail(`Unsupported source-binding schema at ${path}`);
  return Object.freeze({
    schemaVersion: "evleda.portable-source-binding.v1",
    sourceRevisionIdentity: requireIdentitySchema(
      validateCanonicalIdentity(safe.sourceRevisionIdentity, `${path}/sourceRevisionIdentity`),
      "evleda.source-revision.v1",
      `${path}/sourceRevisionIdentity`
    ),
    sourceArtifactIdentity: validateContentIdentity(safe.sourceArtifactIdentity, `${path}/sourceArtifactIdentity`),
    sourcePath: validatePublicPortablePathRefV1(safe.sourcePath, `${path}/sourcePath`),
    sourceContractIdentity: requireIdentitySchema(
      validateCanonicalIdentity(safe.sourceContractIdentity, `${path}/sourceContractIdentity`),
      "evleda.source-contract.v1",
      `${path}/sourceContractIdentity`
    )
  });
};

const LEDGER_RULES: Readonly<Record<PortableReportKind, readonly { pointer: string; ruleId: string; marker: string }[]>> = Object.freeze({
  kicad_netlist: Object.freeze([
    { pointer: "/design/date", ruleId: "evleda.portable.normalize-date.v1", marker: "<portable-date>" },
    { pointer: "/design/source", ruleId: "evleda.portable.normalize-source.v1", marker: "<portable-source>" }
  ]),
  kicad_erc: Object.freeze([
    { pointer: "/date", ruleId: "evleda.portable.normalize-date.v1", marker: "<portable-date>" },
    { pointer: "/source", ruleId: "evleda.portable.normalize-source.v1", marker: "<portable-source>" }
  ]),
  kicad_drc: Object.freeze([
    { pointer: "/date", ruleId: "evleda.portable.normalize-date.v1", marker: "<portable-date>" },
    { pointer: "/source", ruleId: "evleda.portable.normalize-source.v1", marker: "<portable-source>" }
  ]),
  kicad_stats: Object.freeze([
    { pointer: "/metadata/date", ruleId: "evleda.portable.normalize-date.v1", marker: "<portable-date>" }
  ]),
  kicad_d356: Object.freeze([
    {
      pointer: "/records/via-random-s-tail",
      ruleId: "evleda.portable.normalize-d356-via-random-s-tail.v1",
      marker: "<portable-via-s-tail>"
    }
  ])
});

const validateLedger = (
  value: unknown,
  reportKind: PortableReportKind,
  path: string
): readonly FieldDispositionLedgerEntryV2[] => {
  if (!Array.isArray(value)) return fail(`Expected ledger array at ${path}`);
  const entries = value.map((entry: unknown, index: number): FieldDispositionLedgerEntryV2 => {
    const item = record(entry, `${path}/${index}`);
    exactKeys(item, `${path}/${index}`, [
      "pointer",
      "ruleId",
      "occurrenceCount",
      "disposition",
      "normalizedMarker"
    ]);
    const disposition = oneOf(item.disposition, `${path}/${index}/disposition`, ["normalized", "excluded-private", "not-run"] as const);
    const normalizedMarker = item.normalizedMarker === null
      ? null
      : text(item.normalizedMarker, `${path}/${index}/normalizedMarker`, undefined, 64);
    return Object.freeze({
      pointer: text(item.pointer, `${path}/${index}/pointer`, /^\/(?:[A-Za-z0-9_~.-]+\/?)*$/u, 256),
      ruleId: text(item.ruleId, `${path}/${index}/ruleId`, SCHEMA_TOKEN, 256),
      occurrenceCount: integer(item.occurrenceCount, `${path}/${index}/occurrenceCount`, 1, 1_000_000),
      disposition,
      normalizedMarker
    });
  });
  const expected = LEDGER_RULES[reportKind];
  if (entries.length !== expected.length) fail(`Disposition ledger cardinality mismatch at ${path}`);
  for (let index = 0; index < expected.length; index += 1) {
    const actual = entries[index]!;
    const rule = expected[index]!;
    if (
      actual.pointer !== rule.pointer ||
      actual.ruleId !== rule.ruleId ||
      actual.occurrenceCount !== (reportKind === "kicad_d356" ? 273 : 1) ||
      actual.disposition !== "normalized" ||
      actual.normalizedMarker !== rule.marker
    ) {
      fail(`Disposition ledger missing, extra, duplicate, or unsorted entry at ${path}/${index}`);
    }
  }
  return Object.freeze(entries);
};

const validateSExpression = (value: unknown, path: string, depth = 0): PortableSExpressionV1 => {
  if (depth > 64) return fail(`S-expression depth budget exceeded at ${path}`);
  const safe = record(value, path);
  if (safe.kind === "atom" || safe.kind === "string") {
    exactKeys(safe, path, ["kind", "value"]);
    return Object.freeze({
      kind: safe.kind,
      value: text(safe.value, `${path}/value`, undefined, 262_144)
    });
  }
  if (safe.kind === "list") {
    exactKeys(safe, path, ["kind", "items"]);
    if (!Array.isArray(safe.items) || safe.items.length > 32_768) return fail(`Invalid S-expression list at ${path}/items`);
    return Object.freeze({
      kind: "list",
      items: Object.freeze(safe.items.map((entry: unknown, index: number) => validateSExpression(entry, `${path}/items/${index}`, depth + 1)))
    });
  }
  return fail(`Unknown S-expression kind at ${path}/kind`);
};

interface PublicAuditToken {
  readonly value: string;
  readonly pointer: string;
  readonly kind: "key" | "leaf";
  readonly allowance: PublicSeparatorAllowance | null;
}

interface PublicSeparatorAllowance {
  readonly kind:
    | "hierarchy-root"
    | "closed-relative-logical-path"
    | "approved-documentation-url"
    | "kicad-nickname"
    | "kicad-filter-list"
    | "closed-percent-literal";
  readonly validate: (value: string) => boolean;
}

interface PublicAuditBudget {
  work: number;
}

const PUBLIC_AUDIT_MAX_ROUNDS = 8;
const PUBLIC_AUDIT_MAX_WORK = 16_777_216;
const PUBLIC_AUDIT_MAX_VALUE_BYTES = 1_048_576;
export const PUBLIC_CONFUSABLE_MAP_VERSION = "evleda.portable-confusable-map.v1" as const;
const PUBLIC_CONFUSABLES = new Map<number, string>([
  [0x2024, "."], [0xfe52, "."], [0xff61, "."],
  [0x2044, "/"], [0x2215, "/"],
  [0x29f5, "\\"],
  [0xa789, ":"], [0xfe13, ":"], [0xfe55, ":"]
]);
const PUBLIC_ESCAPE_REMAINDER = /(?:%u|%[0-9a-f]{2}|\\(?:u(?:\{[0-9a-f]+\}|[0-9a-f]+)|x[0-9a-f]+|[\\/])|&(?:#[0-9]+|#x[0-9a-f]+|[a-z]+);)/iu;
const RESERVED_SCHEMES = new Set(["file", "http", "https", "ftp", "data", "javascript", "vbscript"]);
const RESERVED_SCHEME_PREFIXES = new Set<string>();
for (const scheme of RESERVED_SCHEMES) {
  for (let end = 1; end <= scheme.length; end += 1) RESERVED_SCHEME_PREFIXES.add(scheme.slice(0, end));
  RESERVED_SCHEME_PREFIXES.add(`${scheme}:`);
}
const WINDOWS_DEVICE_LEAVES = new Set(["con", "prn", "aux", "nul", "clock$", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"]);

const asciiLower = (value: string): string => {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    result += String.fromCharCode(code >= 0x41 && code <= 0x5a ? code + 0x20 : code);
  }
  return result;
};

const mapPublicConfusables = (value: string): string => {
  let output = "";
  for (const scalar of value) {
    const codePoint = scalar.codePointAt(0)!;
    if (codePoint >= 0xff01 && codePoint <= 0xff5e) {
      output += String.fromCodePoint(codePoint - 0xfee0);
    } else {
      output += PUBLIC_CONFUSABLES.get(codePoint) ?? scalar;
    }
  }
  return output;
};

const decodePublicEscapesOnce = (value: string): string => {
  const mapped = mapPublicConfusables(value);
  if (/%u/iu.test(mapped)) return fail("Percent-u escapes are forbidden in public data");
  const percent = mapped.replace(/(?:%[0-9a-f]{2})+/giu, (sequence) => {
    const pairs = sequence.match(/[0-9a-f]{2}/giu) ?? [];
    const bytes = Uint8Array.from(pairs, (pair) => Number.parseInt(pair, 16));
    try {
      return new IntrinsicTextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return fail("Invalid UTF-8 percent escape in public data");
    }
  });
  const paired = percent.replace(
    /\\u([dD][89aAbB][0-9a-fA-F]{2})\\u([dD][c-fC-F][0-9a-fA-F]{2})/gu,
    (_match, highText: string, lowText: string) => {
      const high = Number.parseInt(highText, 16);
      const low = Number.parseInt(lowText, 16);
      return String.fromCodePoint(0x10000 + ((high - 0xd800) << 10) + (low - 0xdc00));
    }
  );
  const fixed = paired.replace(/\\u([0-9a-fA-F]{4})/gu, (_match, digits: string) => {
    const codePoint = Number.parseInt(digits, 16);
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return fail("Isolated JSON surrogate escape in public data");
    return String.fromCodePoint(codePoint);
  });
  const jsonEscaped = fixed.replace(
    /\\(?:u\{([0-9a-fA-F]+)\}|x([0-9a-fA-F]{2})|([\\/"bfnrt]))/gu,
    (_match, braced: string | undefined, hex: string | undefined, simple: string | undefined) => {
      if (braced !== undefined) {
        if (braced.length > 6) return fail("Oversized JSON scalar escape in public data");
        const codePoint = Number.parseInt(braced, 16);
        if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
          return fail("Invalid JSON scalar escape in public data");
        }
        return String.fromCodePoint(codePoint);
      }
      if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16));
      const replacements: Readonly<Record<string, string>> = {
        "\\": "\\", "/": "/", '"': '"', b: "\b", f: "\f", n: "\n", r: "\r", t: "\t"
      };
      return replacements[simple ?? ""] ?? _match;
    }
  );
  const named: Readonly<Record<string, string>> = {
    colon: ":",
    sol: "/",
    bsol: "\\",
    percnt: "%"
  };
  return jsonEscaped.replace(
    /&(?:#([0-9]+)|#x([0-9a-f]+)|(colon|sol|bsol|percnt));/giu,
    (_match, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (decimal !== undefined || hex !== undefined) {
        const lexeme = decimal ?? hex!;
        const maximumDigits = decimal === undefined ? 6 : 7;
        if (lexeme.length > maximumDigits) return fail("Oversized HTML numeric entity in public data");
        const codePoint = Number.parseInt(lexeme, decimal === undefined ? 16 : 10);
        if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
          return fail("Invalid HTML Unicode scalar in public data");
        }
        return String.fromCodePoint(codePoint);
      }
      return named[asciiLower(name ?? "")] ?? _match;
    }
  );
};

const normalizePublicAuditToken = (value: string, pointer: string, budget: PublicAuditBudget): string => {
  let current = value;
  for (let round = 0; round < PUBLIC_AUDIT_MAX_ROUNDS; round += 1) {
    const next = decodePublicEscapesOnce(current);
    const size = utf8Length(next);
    budget.work += utf8Length(current) + size;
    if (size > PUBLIC_AUDIT_MAX_VALUE_BYTES || budget.work > PUBLIC_AUDIT_MAX_WORK) {
      fail(`Public audit decode budget exceeded at ${pointer}`);
    }
    if (next === current) {
      if (PUBLIC_ESCAPE_REMAINDER.test(next)) fail(`Unresolved public escape sequence at ${pointer}`);
      requireUnicodeScalars(next, pointer);
      return next;
    }
    current = next;
  }
  return fail(`Public escape decoding did not reach a fixed point at ${pointer}`);
};

const hasNormalizedPublicLeak = (value: string, kind: PublicAuditToken["kind"]): boolean => {
  const folded = asciiLower(value);
  let materializedEnd = folded.length;
  while (materializedEnd > 0 && (folded[materializedEnd - 1] === "." || folded[materializedEnd - 1] === " ")) materializedEnd -= 1;
  const deviceLeaf = folded.slice(0, materializedEnd).split(".", 1)[0]!;
  if (WINDOWS_DEVICE_LEAVES.has(deviceLeaf)) return true;
  if (value.startsWith(":")) return true;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || code === 0x2f || code === 0x5c) return true;
    if (code !== 0x3a) continue;
    if (kind === "key") return true;
    let start = index;
    while (start > 0) {
      const prior = value.charCodeAt(start - 1);
      const scheme = (prior >= 0x41 && prior <= 0x5a) || (prior >= 0x61 && prior <= 0x7a) ||
        (start < index && ((prior >= 0x30 && prior <= 0x39) || prior === 0x2b || prior === 0x2d || prior === 0x2e));
      if (!scheme) break;
      start -= 1;
    }
    const token = asciiLower(value.slice(start, index));
    const boundary = start === 0 || !/[A-Za-z0-9]/u.test(value[start - 1]!);
    if (boundary && (RESERVED_SCHEMES.has(token) || (token.length === 1 && /^[a-z]$/u.test(token)))) return true;
  }
  return false;
};

const closedLogicalPath = (value: string): boolean =>
  value.length > 0 &&
  value.length <= 4_096 &&
  /^[\x20-\x7e]+$/u.test(value) &&
  !value.startsWith("/") &&
  !value.startsWith("\\") &&
  !value.includes("\\") &&
  !value.includes("//") &&
  !value.includes(":") &&
  !/(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(value) &&
  !/(?:^|[^A-Za-z0-9])[A-Za-z]:(?:[\\/]|[A-Za-z0-9])/u.test(value);

const hierarchyRootAllowance: PublicSeparatorAllowance = Object.freeze({
  kind: "hierarchy-root",
  validate: (value: string) => value === "/"
});

const logicalPathAllowance = (validate: (value: string) => boolean = closedLogicalPath): PublicSeparatorAllowance =>
  Object.freeze({ kind: "closed-relative-logical-path", validate });

const documentationAllowance = (validate: (value: string) => boolean): PublicSeparatorAllowance =>
  Object.freeze({ kind: "approved-documentation-url", validate });

const kicadNicknameAllowance: PublicSeparatorAllowance = Object.freeze({
  kind: "kicad-nickname",
  validate: (value: string) =>
    /^[A-Za-z0-9_*?.-]+:[A-Za-z0-9_+*?.-]+$/u.test(value) &&
    !/^[A-Za-z]:/u.test(value) &&
    !/^(?:file|https?|ftp|data|javascript|vbscript):/iu.test(value)
});

const kicadFilterAllowance: PublicSeparatorAllowance = Object.freeze({
  kind: "kicad-filter-list",
  validate: (value: string) =>
    value.length > 0 &&
    value
      .split(" ")
      .every((token) =>
        /^[A-Za-z0-9_*?.-]+(?::[A-Za-z0-9_+*?.-]+)?$/u.test(token) && !/^[A-Za-z]:/u.test(token)
      ) &&
    !/(?:^| )(?:file|https?|ftp|data|javascript|vbscript):/iu.test(value)
});

const percentLiteralAllowance = (validate: (value: string) => boolean): PublicSeparatorAllowance =>
  Object.freeze({ kind: "closed-percent-literal", validate });

const retainedFragmentSuffix = (value: string): string => {
  const folded = asciiLower(value);
  for (let length = Math.min(value.length, 16); length >= 1; length -= 1) {
    const suffix = folded.slice(-length);
    if (RESERVED_SCHEME_PREFIXES.has(suffix) || /^[a-z]:?$/u.test(suffix) || [":", ":/", ":\\"].includes(suffix)) {
      return value.slice(-length);
    }
  }
  return "";
};

const auditFlattenedPublicTokens = (tokens: readonly PublicAuditToken[]): void => {
  const budget: PublicAuditBudget = { work: 0 };
  let fragment = "";
  for (const token of tokens) {
    const permitsEscapes =
      token.allowance?.kind === "approved-documentation-url" ||
      token.allowance?.kind === "closed-percent-literal";
    if (/(?:%|\\u|&)/iu.test(token.value) && !permitsEscapes) {
      fail(`Escape introducer is forbidden at unregistered pointer ${token.pointer}`);
    }
    if (
      token.allowance?.kind === "approved-documentation-url" &&
      /%(?![0-9a-f]{2})/iu.test(token.value)
    ) {
      fail(`Invalid percent encoding in documentation URL at ${token.pointer}`);
    }
    const normalized = normalizePublicAuditToken(token.value, token.pointer, budget);
    if (token.allowance !== null) {
      if (!token.allowance.validate(normalized)) {
        fail(`Invalid ${token.allowance.kind} at registered pointer ${token.pointer}`);
      }
      fragment = "";
      continue;
    }
    if (hasNormalizedPublicLeak(normalized, token.kind)) {
      fail(`Public path, URI, UNC, drive, traversal, or control leak at ${token.pointer}`);
    }
    const combined = `${fragment}${normalized}`;
    if (fragment.length > 0 && hasNormalizedPublicLeak(combined, "leaf")) {
      fail(`Global split-fragment path leak at ${token.pointer}`);
    }
    fragment = retainedFragmentSuffix(combined) || retainedFragmentSuffix(normalized);
  }
};

const auditJsonPublicLeaks = (
  value: unknown,
  pointer = "",
  allowedValues: ReadonlyMap<string, PublicSeparatorAllowance> = new Map()
): void => {
  const tokens: PublicAuditToken[] = [];
  const collect = (entry: unknown, currentPointer: string): void => {
    if (typeof entry === "string") {
      const allow = allowedValues.get(currentPointer);
      tokens.push({ value: entry, pointer: currentPointer, kind: "leaf", allowance: allow ?? null });
      return;
    }
    if (Array.isArray(entry)) {
      entry.forEach((child, index) => collect(child, `${currentPointer}/${index}`));
      return;
    }
    if (entry !== null && typeof entry === "object") {
      for (const key of Object.keys(entry).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))) {
        const childPointer = `${currentPointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
        tokens.push({ value: key, pointer: `${childPointer}/<key>`, kind: "key", allowance: null });
        collect((entry as Readonly<Record<string, unknown>>)[key], childPointer);
      }
    }
  };
  collect(value, pointer);
  auditFlattenedPublicTokens(tokens);
};

export const validatePortablePublicValueV2 = (value: unknown): unknown => {
  const safe = hardenPortableValue(value);
  auditJsonPublicLeaks(safe);
  return safe;
};

const hierarchyPath = (value: string): boolean => value === "/";
const uuidHierarchyPath = (value: string): boolean =>
  /^\/(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))*$/u.test(value);

const sexprHead = (value: PortableSExpressionV1 | undefined): string | undefined => {
  if (value === undefined || value.kind !== "list") return undefined;
  const head = value.items[0];
  return head?.kind === "atom" ? head.value : undefined;
};

const sexprNamedField = (value: PortableSExpressionListV1): string | undefined => {
  const name = value.items.find((entry) => sexprHead(entry) === "name");
  if (name?.kind !== "list") return undefined;
  const nameValue = name.items[1];
  return nameValue?.kind === "string" ? nameValue.value : undefined;
};

const PUBLIC_DOCUMENTATION_URI = /^https?:\/\/(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?::[0-9]+)?\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/u;
const PORTABLE_LIBRARY_URI = /^\$\{(?:KICAD10_SYMBOL_DIR|KIPRJMOD)\}\/(?:symbols\/)?[A-Za-z0-9_.-]+\.kicad_sym$/u;
const approvedDocumentationUrl = (value: string): boolean => {
  if (!PUBLIC_DOCUMENTATION_URI.test(value)) return false;
  const afterScheme = value.slice(value.indexOf("://") + 3);
  const firstSlash = afterScheme.indexOf("/");
  const authority = firstSlash < 0 ? afterScheme : afterScheme.slice(0, firstSlash);
  const pathAndQuery = firstSlash < 0 ? "" : afterScheme.slice(firstSlash);
  const secondaryScheme = pathAndQuery.split("/").some((segment) => {
    const colon = segment.indexOf(":");
    if (colon <= 0) return false;
    const prefix = segment.slice(0, colon);
    return /^[A-Za-z][A-Za-z0-9+.-]*$/u.test(prefix);
  });
  return (
    !authority.includes("@") &&
    !/^localhost(?::|$)/iu.test(authority) &&
    !/^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)/u.test(authority) &&
    !pathAndQuery.includes("//") &&
    !/(?:^|\/)\.\.(?:\/|$)/u.test(pathAndQuery) &&
    !/(?:^|\/)[A-Za-z]:(?:\/|$)/u.test(pathAndQuery) &&
    !secondaryScheme &&
    !pathAndQuery.includes("\\")
  );
};

const auditNetlistPublicLeaks = (expressions: readonly PortableSExpressionV1[]): void => {
  const tokens: PublicAuditToken[] = [];
  const visit = (
    value: PortableSExpressionV1,
    current: PortableSExpressionListV1 | undefined,
    index: number,
    parent: PortableSExpressionListV1 | undefined,
    insideDesignSheet: boolean,
    pointer: string
  ): void => {
    for (const key of (value.kind === "list" ? ["items", "kind"] : ["kind", "value"])) {
      tokens.push({ value: key, pointer: `${pointer}/${key}/<key>`, kind: "key", allowance: null });
    }
    if (value.kind === "list") {
      const childInsideSheet = insideDesignSheet || sexprHead(value) === "sheet";
      const currentHead = sexprHead(value);
      value.items.forEach((entry, childIndex) =>
        visit(entry, value, childIndex, current, childInsideSheet, `${pointer}/items/${childIndex}`)
      );
      return;
    }
    const currentHead = current === undefined ? undefined : sexprHead(current);
    const parentHead = parent === undefined ? undefined : sexprHead(parent);
    const documentationPosition =
      (currentHead === "docs" && index === 1) ||
        (current !== undefined && currentHead === "field" && index === 2 && ["Source", "Datasheet"].includes(sexprNamedField(current) ?? "")) ||
        (parent !== undefined && currentHead === "value" && index === 1 && parentHead === "property" && ["Source", "Datasheet"].includes(sexprNamedField(parent) ?? ""));
    const allowedHierarchy = index === 1 && (currentHead === "name" || currentHead === "names" || currentHead === "tstamps") && value.value === "/";
    const allowedLibraryUri =
      index === 1 && currentHead === "uri" && parentHead === "library" && PORTABLE_LIBRARY_URI.test(value.value);
    const namedField = current === undefined ? undefined : sexprNamedField(current);
    const namedProperty = parent === undefined ? undefined : sexprNamedField(parent);
    const nicknamePosition =
      (currentHead === "footprint" && index === 1 && parentHead === "comp") ||
      (currentHead === "field" && index === 2 && namedField === "Footprint");
    const filterPosition =
      (currentHead === "value" && index === 1 && parentHead === "property" && namedProperty === "ki_fp_filters") ||
      (currentHead === "fp" && index === 1 && parentHead === "footprints");
    const percentLiteralPosition =
      (currentHead === "value" && index === 1 && parentHead === "comp" && /%/u.test(value.value)) ||
      (currentHead === "field" && index === 2 && namedField === "Rating" && /%/u.test(value.value)) ||
      (currentHead === "value" && index === 1 && parentHead === "property" && namedProperty === "Rating" && /%/u.test(value.value));
    const allowedLogical =
      (currentHead === "field" && index === 2 && !["Source", "Datasheet", "Footprint", "Rating"].includes(namedField ?? "")) ||
      (currentHead === "value" && index === 1 && parentHead === "property" && !["Source", "Datasheet", "Rating", "ki_fp_filters"].includes(namedProperty ?? "")) ||
      (currentHead === "value" && index === 1 && parentHead === "comp" && !/%/u.test(value.value)) ||
      (currentHead === "description" && index === 1 && (parentHead === "libsource" || parentHead === "libpart")) ||
      (currentHead === "pinfunction" && index === 1 && parentHead === "node") ||
      (currentHead === "name" && index === 1 && parentHead === "pin") ||
      (currentHead === "value" && index === 1 && parentHead === "comment");
    const allowance = documentationPosition
      ? documentationAllowance(approvedDocumentationUrl)
      : allowedHierarchy
        ? hierarchyRootAllowance
        : allowedLibraryUri
          ? logicalPathAllowance((entry) => PORTABLE_LIBRARY_URI.test(entry))
          : nicknamePosition
            ? kicadNicknameAllowance
            : filterPosition
              ? kicadFilterAllowance
              : percentLiteralPosition
                ? percentLiteralAllowance((entry) =>
                    namedField === "Rating" || namedProperty === "Rating"
                      ? entry === "1%"
                      : /^[0-9]+(?:\.[0-9]+)?(?:[kM]|R)? 1%$/u.test(entry)
                  )
          : allowedLogical && value.value.length > 0
            ? logicalPathAllowance()
            : null;
    tokens.push({
      value: value.value,
      pointer: `${pointer}/value`,
      kind: "leaf",
      allowance
    });
  };
  expressions.forEach((entry, index) => visit(entry, undefined, index, undefined, false, `/expressions/${index}`));
  auditFlattenedPublicTokens(tokens);
};

const validateRevAD356Profile = (headers: readonly string[], records: readonly string[], path: string): void => {
  const expectedHeaders = ["P  CODE 00", "P  UNITS CUST 0", "P  arrayDim   N"] as const;
  if (headers.length !== expectedHeaders.length || headers.some((entry, index) => entry !== expectedHeaders[index])) {
    fail(`D356 Rev-A headers must be exact and ordered at ${path}/headers`);
  }
  if (records.length < 2 || records.at(-1) !== "999" || records.slice(0, -1).some((entry) => entry === "999")) {
    fail(`D356 Rev-A requires exactly one final 999 at ${path}/records`);
  }
  const dataRecords = records.slice(0, -1);
  if (dataRecords.length !== 653) fail(`D356 Rev-A record coverage rejected at ${path}/records`);
  if (new Set(dataRecords).size !== dataRecords.length || dataRecords.some((entry, index) => index > 0 && dataRecords[index - 1]! >= entry)) {
    fail(`D356 Rev-A data records must be sorted and unique at ${path}/records`);
  }
  const recordTypes = new Map<string, number>();
  const viaTypes = new Map<string, number>();
  const viaDrills = new Map<string, number>();
  const viaBodies = new Set<string>();
  for (const [recordIndex, entry] of dataRecords.entries()) {
    if (!/^[\x20-\x7e]+$/u.test(entry)) fail(`D356 Rev-A requires printable ASCII at ${path}/records`);
    const netField = entry.slice(3, 20);
    if (!/^[A-Z0-9_+()/.\-]+ *$/u.test(netField)) fail(`D356 Rev-A net field rejected at ${path}/records`);
    const netName = netField.trimEnd();
    const recordType = entry.slice(0, 3);
    recordTypes.set(recordType, (recordTypes.get(recordType) ?? 0) + 1);
    if (netName.includes("/") && netName !== "N/C") fail(`D356 Rev-A slash is allowed only for N/C at ${path}/records`);
    if (entry.length === 82) {
      const via = /^((?:307|317)[A-Z0-9_+()/.\- ]{17}VIA {8}(MD[0-9]{4})PA[0-9]{2}X[+-][0-9]{6}Y[+-][0-9]{6}X[0-9]{4}Y[0-9]{4}R[0-9]{3})S\+000000000$/u.exec(entry) ??
        fail(`D356 Rev-A 82-column record rejected at ${path}/records`);
      viaTypes.set(recordType, (viaTypes.get(recordType) ?? 0) + 1);
      viaDrills.set(via[2]!, (viaDrills.get(via[2]!) ?? 0) + 1);
      if (viaBodies.has(via[1]!)) fail(`D356 Rev-A VIA body coverage rejected at ${path}/records`);
      viaBodies.add(via[1]!);
    } else if (entry.length === 73) {
      const valid =
        /^(?:317|327|367)$/u.test(entry.slice(0, 3)) &&
        /^(?:[A-Z][A-Z0-9]{0,4})? *$/u.test(entry.slice(20, 26)) &&
        /^(?:-[A-Z0-9]{1,5})? *$/u.test(entry.slice(26, 32)) &&
        /^(?:D[0-9]{4}[PU])? *$/u.test(entry.slice(32, 38)) &&
        /^A[0-9]{2}X[+-][0-9]{6}Y[+-][0-9]{6}X[0-9]{4}Y[0-9]{4}R[0-9]{3}S[0-3]$/u.test(entry.slice(38));
      if (!valid) fail(`D356 Rev-A 73-column record rejected at ${path}/records`);
    } else {
      fail(`D356 Rev-A record length rejected at ${path}/records`, { length: entry.length });
    }
    auditFlattenedPublicTokens([
      {
        value: netName,
        pointer: `${path}/records/${recordIndex}/net`,
        kind: "leaf",
        allowance: netName === "N/C" ? logicalPathAllowance((value) => value === "N/C") : null
      },
      { value: entry.slice(20), pointer: `${path}/records/${recordIndex}/body`, kind: "leaf", allowance: null }
    ]);
  }
  const exactCounts = (actual: ReadonlyMap<string, number>, expected: Readonly<Record<string, number>>): boolean =>
    actual.size === Object.keys(expected).length && Object.entries(expected).every(([key, count]) => actual.get(key) === count);
  if (
    !exactCounts(recordTypes, { "307": 11, "317": 331, "327": 305, "367": 6 }) ||
    !exactCounts(viaTypes, { "307": 11, "317": 262 }) ||
    !exactCounts(viaDrills, { MD0039: 11, MD0079: 7, MD0118: 255 }) ||
    viaBodies.size !== 273
  ) fail(`D356 Rev-A record, VIA, drill, or endpoint coverage rejected at ${path}/records`);
};

const requireSexprList = (
  value: PortableSExpressionV1,
  expectedHead: string,
  path: string
): PortableSExpressionListV1 => {
  if (value.kind !== "list" || sexprHead(value) !== expectedHead) {
    return fail(`Expected ${expectedHead} list at ${path}`);
  }
  return value;
};

const scalarSexpr = (
  value: PortableSExpressionV1,
  expectedHead: string,
  path: string,
  allowEmpty = false
): string => {
  const list = requireSexprList(value, expectedHead, path);
  const scalar = list.items[1];
  if (list.items.length !== 2 || scalar?.kind !== "string" || (!allowEmpty && scalar.value.length === 0)) {
    return fail(`Expected one string in ${expectedHead} at ${path}`);
  }
  return scalar.value;
};

const validateFieldCollection = (value: PortableSExpressionV1, path: string): void => {
  const fields = requireSexprList(value, "fields", path).items.slice(1);
  if (fields.length < 1 || fields.length > 64) fail(`Field collection cardinality rejected at ${path}`);
  const names = new Set<string>();
  for (const [index, rawField] of fields.entries()) {
    const field = requireSexprList(rawField, "field", `${path}/${index}`);
    if (field.items.length < 2 || field.items.length > 3) fail(`Field shape rejected at ${path}/${index}`);
    const name = scalarSexpr(field.items[1]!, "name", `${path}/${index}/name`);
    if (names.has(name)) fail(`Duplicate field name at ${path}/${index}`);
    names.add(name);
    if (field.items.length === 3 && field.items[2]?.kind !== "string") {
      fail(`Field value must be a string at ${path}/${index}`);
    }
  }
};

const validateTitleBlock = (value: PortableSExpressionV1, path: string): void => {
  const block = requireSexprList(value, "title_block", path);
  const entries = block.items.slice(1);
  const heads = entries.map((entry) => sexprHead(entry));
  const prefix = ["title", "company", "rev", "date", "source"] as const;
  if (
    entries.length !== 14 ||
    prefix.some((head, index) => heads[index] !== head) ||
    heads.slice(5).some((head) => head !== "comment")
  ) {
    fail(`Title block structure rejected at ${path}`);
  }
  prefix.forEach((head, index) => scalarSexpr(entries[index]!, head, `${path}/${head}`, head === "company"));
  entries.slice(5).forEach((rawComment, index) => {
    const comment = requireSexprList(rawComment, "comment", `${path}/comment/${index}`);
    if (comment.items.length !== 3) fail(`Comment structure rejected at ${path}/comment/${index}`);
    const number = scalarSexpr(comment.items[1]!, "number", `${path}/comment/${index}/number`);
    if (number !== String(index + 1)) fail(`Comment number rejected at ${path}/comment/${index}`);
    scalarSexpr(comment.items[2]!, "value", `${path}/comment/${index}/value`, true);
  });
};

const validateDesignSheet = (value: PortableSExpressionV1, path: string): void => {
  const sheet = requireSexprList(value, "sheet", path);
  const entries = sheet.items.slice(1);
  const heads = entries.map((entry) => sexprHead(entry));
  if (heads.length !== 4 || heads.join("\u0000") !== ["number", "name", "tstamps", "title_block"].join("\u0000")) {
    fail(`Design sheet structure rejected at ${path}`);
  }
  if (!/^[1-9][0-9]*$/u.test(scalarSexpr(entries[0]!, "number", `${path}/number`))) {
    fail(`Design sheet number rejected at ${path}`);
  }
  if (scalarSexpr(entries[1]!, "name", `${path}/name`) !== "/" || scalarSexpr(entries[2]!, "tstamps", `${path}/tstamps`) !== "/") {
    fail(`Design sheet hierarchy rejected at ${path}`);
  }
  validateTitleBlock(entries[3]!, `${path}/title_block`);
};

interface NetlistComponentInfo {
  readonly reference: string;
  readonly libpartKey: string;
  readonly pins: ReadonlySet<string>;
}

interface NetlistLibpartInfo {
  readonly key: string;
  readonly library: string;
  readonly pins: ReadonlySet<string>;
}

interface NetlistNetInfo {
  readonly code: string;
  readonly name: string;
  readonly nodes: readonly { readonly reference: string; readonly pin: string }[];
}

const validateComponent = (value: PortableSExpressionV1, path: string): NetlistComponentInfo => {
  const component = requireSexprList(value, "comp", path);
  const entries = component.items.slice(1);
  const heads = entries.map((entry) => sexprHead(entry));
  const propertyStart = 5;
  const sheetPathIndex = heads.indexOf("sheetpath", propertyStart);
  if (
    sheetPathIndex < propertyStart ||
    heads.slice(0, propertyStart).join("\u0000") !== ["ref", "value", "footprint", "fields", "libsource"].join("\u0000") ||
    heads.slice(propertyStart, sheetPathIndex).some((head) => head !== "property") ||
    heads.slice(sheetPathIndex).join("\u0000") !== ["sheetpath", "tstamps", "units"].join("\u0000") ||
    sheetPathIndex - propertyStart < 1 ||
    sheetPathIndex - propertyStart > 64
  ) {
    return fail(`Component structure rejected at ${path}`);
  }
  const reference = scalarSexpr(entries[0]!, "ref", `${path}/ref`);
  if (!/^[A-Z]+[0-9]+$/u.test(reference)) fail(`Component reference rejected at ${path}`);
  scalarSexpr(entries[1]!, "value", `${path}/value`);
  scalarSexpr(entries[2]!, "footprint", `${path}/footprint`);
  validateFieldCollection(entries[3]!, `${path}/fields`);
  const libsource = requireSexprList(entries[4]!, "libsource", `${path}/libsource`);
  if (libsource.items.slice(1).map((entry) => sexprHead(entry)).join("\u0000") !== ["lib", "part", "description"].join("\u0000")) {
    fail(`Component libsource rejected at ${path}`);
  }
  const library = scalarSexpr(libsource.items[1]!, "lib", `${path}/libsource/lib`);
  const part = scalarSexpr(libsource.items[2]!, "part", `${path}/libsource/part`);
  scalarSexpr(libsource.items[3]!, "description", `${path}/libsource/description`, true);
  const propertyNames = new Set<string>();
  for (let index = propertyStart; index < sheetPathIndex; index += 1) {
    const property = requireSexprList(entries[index]!, "property", `${path}/property/${index - propertyStart}`);
    if (property.items.length !== 3) fail(`Component property rejected at ${path}`);
    const name = scalarSexpr(property.items[1]!, "name", `${path}/property/name`);
    if (propertyNames.has(name)) fail(`Duplicate component property at ${path}`);
    propertyNames.add(name);
    scalarSexpr(property.items[2]!, "value", `${path}/property/value`, true);
  }
  if (!propertyNames.has("Sheetname") || !propertyNames.has("Sheetfile")) fail(`Component sheet properties missing at ${path}`);
  const sheetpath = requireSexprList(entries[sheetPathIndex]!, "sheetpath", `${path}/sheetpath`);
  if (
    sheetpath.items.length !== 3 ||
    scalarSexpr(sheetpath.items[1]!, "names", `${path}/sheetpath/names`) !== "/" ||
    scalarSexpr(sheetpath.items[2]!, "tstamps", `${path}/sheetpath/tstamps`) !== "/"
  ) fail(`Component sheetpath rejected at ${path}`);
  const timestamp = scalarSexpr(entries[sheetPathIndex + 1]!, "tstamps", `${path}/tstamps`);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(timestamp)) {
    fail(`Component timestamp rejected at ${path}`);
  }
  const units = requireSexprList(entries[sheetPathIndex + 2]!, "units", `${path}/units`);
  const unitEntries = units.items.slice(1);
  if (unitEntries.length < 1 || unitEntries.length > 16 || unitEntries.some((entry) => sexprHead(entry) !== "unit")) {
    fail(`Component units rejected at ${path}`);
  }
  const componentPins = new Set<string>();
  for (const [unitIndex, rawUnit] of unitEntries.entries()) {
    const unit = requireSexprList(rawUnit, "unit", `${path}/units/${unitIndex}`);
    if (unit.items.length !== 3 || sexprHead(unit.items[1]!) !== "name" || sexprHead(unit.items[2]!) !== "pins") {
      fail(`Component unit rejected at ${path}/units/${unitIndex}`);
    }
    scalarSexpr(unit.items[1]!, "name", `${path}/units/${unitIndex}/name`);
    const pins = requireSexprList(unit.items[2]!, "pins", `${path}/units/${unitIndex}/pins`).items.slice(1);
    if (pins.length > 512) fail(`Component unit pins rejected at ${path}`);
    const numbers = new Set<string>();
    pins.forEach((rawPin, pinIndex) => {
      const pin = requireSexprList(rawPin, "pin", `${path}/units/${unitIndex}/pins/${pinIndex}`);
      if (pin.items.length !== 2) fail(`Component pin rejected at ${path}`);
      const number = scalarSexpr(pin.items[1]!, "num", `${path}/units/${unitIndex}/pins/${pinIndex}/num`);
      if (numbers.has(number)) fail(`Duplicate component pin at ${path}`);
      numbers.add(number);
      componentPins.add(number);
    });
  }
  return { reference, libpartKey: `${library}:${part}`, pins: componentPins };
};

const validateLibpart = (value: PortableSExpressionV1, path: string): NetlistLibpartInfo => {
  const libpart = requireSexprList(value, "libpart", path);
  const entries = libpart.items.slice(1);
  let cursor = 0;
  if (sexprHead(entries[cursor]!) !== "lib" || sexprHead(entries[cursor + 1]!) !== "part" || sexprHead(entries[cursor + 2]!) !== "description") {
    return fail(`Libpart prefix rejected at ${path}`);
  }
  const lib = scalarSexpr(entries[cursor++]!, "lib", `${path}/lib`);
  const part = scalarSexpr(entries[cursor++]!, "part", `${path}/part`);
  scalarSexpr(entries[cursor++]!, "description", `${path}/description`, true);
  if (cursor < entries.length && sexprHead(entries[cursor]!) === "docs") scalarSexpr(entries[cursor++]!, "docs", `${path}/docs`, true);
  if (cursor < entries.length && sexprHead(entries[cursor]!) === "footprints") {
    const footprints = requireSexprList(entries[cursor++]!, "footprints", `${path}/footprints`).items.slice(1);
    if (footprints.length < 1 || footprints.length > 128 || footprints.some((entry) => sexprHead(entry) !== "fp")) {
      fail(`Libpart footprints rejected at ${path}`);
    }
    footprints.forEach((entry, index) => scalarSexpr(entry, "fp", `${path}/footprints/${index}`));
  }
  if (cursor >= entries.length || sexprHead(entries[cursor]!) !== "fields") fail(`Libpart fields missing at ${path}`);
  validateFieldCollection(entries[cursor++]!, `${path}/fields`);
  const libpartPins = new Set<string>();
  if (cursor < entries.length && sexprHead(entries[cursor]!) === "pins") {
    const pins = requireSexprList(entries[cursor++]!, "pins", `${path}/pins`).items.slice(1);
    if (pins.length > 512 || pins.some((entry) => sexprHead(entry) !== "pin")) fail(`Libpart pins rejected at ${path}`);
    const numbers = new Set<string>();
    pins.forEach((rawPin, index) => {
      const pin = requireSexprList(rawPin, "pin", `${path}/pins/${index}`);
      if (pin.items.slice(1).map((entry) => sexprHead(entry)).join("\u0000") !== ["num", "name", "type"].join("\u0000")) {
        fail(`Libpart pin structure rejected at ${path}/pins/${index}`);
      }
      const number = scalarSexpr(pin.items[1]!, "num", `${path}/pins/${index}/num`);
      if (numbers.has(number)) fail(`Duplicate libpart pin at ${path}`);
      numbers.add(number);
      libpartPins.add(number);
      scalarSexpr(pin.items[2]!, "name", `${path}/pins/${index}/name`, true);
      scalarSexpr(pin.items[3]!, "type", `${path}/pins/${index}/type`);
    });
  }
  if (cursor !== entries.length) fail(`Unknown or duplicate libpart field at ${path}`);
  return { key: `${lib}:${part}`, library: lib, pins: libpartPins };
};

const validateLibrary = (value: PortableSExpressionV1, path: string): string => {
  const library = requireSexprList(value, "library", path);
  if (library.items.length !== 3 || sexprHead(library.items[1]!) !== "logical" || sexprHead(library.items[2]!) !== "uri") {
    return fail(`Library structure rejected at ${path}`);
  }
  const logical = scalarSexpr(library.items[1]!, "logical", `${path}/logical`);
  const uri = scalarSexpr(library.items[2]!, "uri", `${path}/uri`);
  if (!PORTABLE_LIBRARY_URI.test(uri)) {
    fail(`Library logical URI rejected at ${path}`);
  }
  return logical;
};

const validateNet = (value: PortableSExpressionV1, path: string): NetlistNetInfo => {
  const net = requireSexprList(value, "net", path);
  const entries = net.items.slice(1);
  const heads = entries.map((entry) => sexprHead(entry));
  if (
    entries.length < 4 ||
    heads.slice(0, 3).join("\u0000") !== ["code", "name", "class"].join("\u0000") ||
    heads.slice(3).some((head) => head !== "node") ||
    entries.length > 20_003
  ) return fail(`Net structure rejected at ${path}`);
  const code = scalarSexpr(entries[0]!, "code", `${path}/code`);
  if (!/^[1-9][0-9]*$/u.test(code)) fail(`Net code rejected at ${path}`);
  const name = scalarSexpr(entries[1]!, "name", `${path}/name`);
  scalarSexpr(entries[2]!, "class", `${path}/class`);
  const nodes = new Set<string>();
  const nodeList: { reference: string; pin: string }[] = [];
  entries.slice(3).forEach((rawNode, index) => {
    const node = requireSexprList(rawNode, "node", `${path}/node/${index}`);
    const nodeHeads = node.items.slice(1).map((entry) => sexprHead(entry));
    const validHeads =
      nodeHeads.join("\u0000") === ["ref", "pin", "pintype"].join("\u0000") ||
      nodeHeads.join("\u0000") === ["ref", "pin", "pinfunction", "pintype"].join("\u0000");
    if (!validHeads) fail(`Net node structure rejected at ${path}/node/${index}`);
    const reference = scalarSexpr(node.items[1]!, "ref", `${path}/node/${index}/ref`);
    const pin = scalarSexpr(node.items[2]!, "pin", `${path}/node/${index}/pin`);
    if (nodeHeads.length === 4) scalarSexpr(node.items[3]!, "pinfunction", `${path}/node/${index}/pinfunction`, true);
    scalarSexpr(node.items.at(-1)!, "pintype", `${path}/node/${index}/pintype`);
    const key = `${reference}\u0000${pin}`;
    if (nodes.has(key)) fail(`Duplicate net node at ${path}`);
    nodes.add(key);
    nodeList.push({ reference, pin });
  });
  return { code, name, nodes: nodeList };
};

const validateNetlistStructure = (expressions: readonly PortableSExpressionV1[], path: string): void => {
  if (expressions.length !== 1 || sexprHead(expressions[0]!) !== "export" || expressions[0]!.kind !== "list") {
    fail(`Netlist requires exactly one top-level export at ${path}`);
  }
  const exportForm = expressions[0] as PortableSExpressionListV1;
  const direct = exportForm.items.slice(1);
  const expectedHeads = ["version", "design", "components", "groups", "variants", "libparts", "libraries", "nets"] as const;
  const heads = direct.map((entry) => sexprHead(entry));
  if (heads.length !== expectedHeads.length || heads.some((entry, index) => entry !== expectedHeads[index])) {
    fail(`Netlist export sections are missing, duplicated, reordered, or unknown at ${path}`);
  }
  const sections = Object.fromEntries(direct.map((entry) => [sexprHead(entry)!, entry])) as Record<string, PortableSExpressionListV1>;
  const version = sections.version!;
  if (version.items.length !== 2 || version.items[1]?.kind !== "string" || version.items[1].value !== "E") {
    fail(`Netlist version must be exact KiCad E at ${path}`);
  }
  const design = sections.design!;
  const designEntries = design.items.slice(1);
  const designHeads = designEntries.map((entry) => sexprHead(entry));
  if (
    designEntries.length < 4 ||
    designHeads[0] !== "source" ||
    designHeads[1] !== "date" ||
    designHeads[2] !== "tool" ||
    designHeads.slice(3).some((entry) => entry !== "sheet") ||
    designHeads.length - 3 > 128
  ) {
    fail(`Netlist design must contain source/date/tool and bounded sheets at ${path}`);
  }
  const source = designEntries[0]! as PortableSExpressionListV1;
  const date = designEntries[1]! as PortableSExpressionListV1;
  const tool = designEntries[2]! as PortableSExpressionListV1;
  if (
    source.items.length !== 2 ||
    source.items[1]?.kind !== "string" ||
    source.items[1].value !== "<portable-source>" ||
    date.items.length !== 2 ||
    date.items[1]?.kind !== "string" ||
    date.items[1].value !== "<portable-date>" ||
    tool.items.length !== 2 ||
    tool.items[1]?.kind !== "string" ||
    tool.items[1].value.length === 0
  ) {
    fail(`Netlist design sentinels/tool are invalid at ${path}`);
  }
  designEntries.slice(3).forEach((entry, index) => validateDesignSheet(entry, `${path}/design/sheet/${index}`));
  if (sections.groups!.items.length !== 1 || sections.variants!.items.length !== 1) {
    fail(`Netlist groups and variants must be exact empty KiCad-E forms at ${path}`);
  }
  for (const [sectionName, itemName, minimum, maximum] of [
    ["components", "comp", 1, 100_000],
    ["libparts", "libpart", 1, 100_000],
    ["libraries", "library", 1, 10_000],
    ["nets", "net", 1, 200_000]
  ] as const) {
    const entries = sections[sectionName]!.items.slice(1);
    if (entries.length < minimum || entries.length > maximum || entries.some((entry) => sexprHead(entry) !== itemName)) {
      fail(`Netlist ${sectionName} cardinality/type rejected at ${path}`);
    }
  }
  const components = new Map<string, NetlistComponentInfo>();
  sections.components!.items.slice(1).forEach((entry, index) => {
    const component = validateComponent(entry, `${path}/components/${index}`);
    if (components.has(component.reference)) fail(`Duplicate component reference at ${path}/components/${index}`);
    components.set(component.reference, component);
  });
  const libparts = new Map<string, NetlistLibpartInfo>();
  sections.libparts!.items.slice(1).forEach((entry, index) => {
    const libpart = validateLibpart(entry, `${path}/libparts/${index}`);
    if (libparts.has(libpart.key)) fail(`Duplicate libpart at ${path}/libparts/${index}`);
    libparts.set(libpart.key, libpart);
  });
  const libraries = new Set<string>();
  sections.libraries!.items.slice(1).forEach((entry, index) => {
    const logical = validateLibrary(entry, `${path}/libraries/${index}`);
    if (libraries.has(logical)) fail(`Duplicate library logical name at ${path}/libraries/${index}`);
    libraries.add(logical);
  });
  for (const libpart of libparts.values()) {
    if (!libraries.has(libpart.library)) fail(`Libpart references an absent logical library at ${path}`);
  }
  for (const component of components.values()) {
    const libpart = libparts.get(component.libpartKey) ?? fail(`Component references an absent libpart at ${path}`);
    if (libpart.pins.size > 0 && [...component.pins].some((pin) => !libpart.pins.has(pin))) {
      fail(`Component unit references an absent libpart pin at ${path}`);
    }
  }
  const netCodes = new Set<string>();
  const netNames = new Set<string>();
  const connectedEndpoints = new Set<string>();
  sections.nets!.items.slice(1).forEach((entry, index) => {
    const net = validateNet(entry, `${path}/nets/${index}`);
    if (netCodes.has(net.code) || netNames.has(net.name)) fail(`Duplicate net code/name at ${path}/nets/${index}`);
    netCodes.add(net.code);
    netNames.add(net.name);
    for (const node of net.nodes) {
      const component = components.get(node.reference);
      if (component === undefined || !component.pins.has(node.pin)) {
        fail(`Net node references an absent component pin at ${path}`);
      }
      const endpoint = `${node.reference}\u0000${node.pin}`;
      if (connectedEndpoints.has(endpoint)) fail(`Component pin occurs in multiple nets at ${path}`);
      connectedEndpoints.add(endpoint);
    }
  });
  auditNetlistPublicLeaks(expressions);
};

const validateProjectedNativeFinding = (value: unknown, path: string): void => {
  const finding = record(value, path);
  exactKeys(finding, path, ["type", "severity", "description", "items"]);
  text(finding.type, `${path}/type`, /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u, 256);
  oneOf(finding.severity, `${path}/severity`, ["error", "warning", "exclusion", "info"] as const);
  text(finding.description, `${path}/description`, undefined, 4_096);
  const rawItems = finding.items;
  if (!Array.isArray(rawItems) || rawItems.length > 100_000) fail(`Invalid projected finding items at ${path}`);
  (rawItems as unknown[]).forEach((rawItem: unknown, index: number) => {
    const item = record(rawItem, `${path}/items/${index}`);
    exactKeys(item, `${path}/items/${index}`, ["description", "pos", "uuid"]);
    text(item.description, `${path}/items/${index}/description`, undefined, 4_096);
    text(item.uuid, `${path}/items/${index}/uuid`, SAFE_TOKEN, 128);
    const position = record(item.pos, `${path}/items/${index}/pos`);
    exactKeys(position, `${path}/items/${index}/pos`, ["x", "y"]);
    for (const coordinate of [position.x, position.y]) {
      if (typeof coordinate !== "number" || !Number.isFinite(coordinate) || Math.abs(coordinate) > Number.MAX_SAFE_INTEGER) {
        fail(`Invalid projected finding coordinate at ${path}`);
      }
    }
  });
};

const validateProjectedIgnoredChecks = (value: unknown, path: string): void => {
  if (!Array.isArray(value) || value.length > 4_096) fail(`Invalid projected ignored checks at ${path}`);
  let previous: string | undefined;
  (value as unknown[]).forEach((rawCheck: unknown, index: number) => {
    const check = record(rawCheck, `${path}/${index}`);
    exactKeys(check, `${path}/${index}`, ["key", "description"]);
    const key = text(check.key, `${path}/${index}/key`, /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u, 256);
    text(check.description, `${path}/${index}/description`, undefined, 4_096);
    if (previous !== undefined && previous >= key) fail(`Projected ignored checks are not unique UTF-16 ordered at ${path}`);
    previous = key;
  });
};

const validateProjectedSeverities = (value: unknown, path: string): readonly string[] => {
  if (!Array.isArray(value) || value.length > 16) return fail(`Invalid projected severity coverage at ${path}`);
  const result = value.map((entry: unknown, index: number) =>
    oneOf(entry, `${path}/${index}`, ["error", "warning", "exclusion"] as const)
  );
  if (new Set(result).size !== result.length) fail(`Duplicate projected severity coverage at ${path}`);
  return result;
};

const validateProjectedCountObject = (value: unknown, keys: readonly string[], path: string): void => {
  const item = record(value, path);
  exactKeys(item, path, keys);
  keys.forEach((key) => integer(item[key], `${path}/${key}`));
};

const validateProjectedStats = (document: Readonly<Record<string, unknown>>, path: string): void => {
  exactKeys(document, path, ["metadata", "board", "pads", "vias", "components", "drill_holes"]);
  const metadata = record(document.metadata, `${path}/metadata`);
  exactKeys(metadata, `${path}/metadata`, ["date", "generator", "project", "board_name"]);
  if (metadata.date !== "<portable-date>") fail(`Statistics date sentinel rejected at ${path}`);
  for (const key of ["generator", "project", "board_name"] as const) text(metadata[key], `${path}/metadata/${key}`, undefined, 256);
  const board = record(document.board, `${path}/board`);
  const boardKeys = [
    "has_outline", "width", "height", "area", "front_component_density", "back_component_density",
    "front_copper_area", "back_copper_area", "min_track_clearance", "min_track_width", "min_drill_diameter",
    "board_thickness", "front_footprint_area", "back_footprint_area", "front_footprint_density", "back_footprint_density"
  ] as const;
  exactKeys(board, `${path}/board`, boardKeys);
  if (typeof board.has_outline !== "boolean") fail(`Statistics outline flag rejected at ${path}`);
  boardKeys.slice(1).forEach((key) => text(board[key], `${path}/board/${key}`, undefined, 64));
  validateProjectedCountObject(document.pads, ["through_hole", "smd", "connector", "npth", "castellated", "press_fit"], `${path}/pads`);
  validateProjectedCountObject(document.vias, ["through", "blind", "buried", "micro"], `${path}/vias`);
  const components = record(document.components, `${path}/components`);
  exactKeys(components, `${path}/components`, ["tht", "smd", "unspecified", "total"]);
  for (const key of ["tht", "smd", "unspecified", "total"] as const) {
    validateProjectedCountObject(components[key], ["front", "back", "total"], `${path}/components/${key}`);
  }
  const rawDrillHoles = document.drill_holes;
  if (!Array.isArray(rawDrillHoles) || rawDrillHoles.length > 4_096) fail(`Statistics drill holes rejected at ${path}`);
  (rawDrillHoles as unknown[]).forEach((rawHole: unknown, index: number) => {
    const hole = record(rawHole, `${path}/drill_holes/${index}`);
    exactKeys(hole, `${path}/drill_holes/${index}`, ["count", "shape", "x_size", "y_size", "plated", "source", "start_layer", "stop_layer"]);
    integer(hole.count, `${path}/drill_holes/${index}/count`);
    if (typeof hole.plated !== "boolean") fail(`Statistics plated flag rejected at ${path}`);
    for (const key of ["shape", "x_size", "y_size", "source", "start_layer", "stop_layer"] as const) {
      text(hole[key], `${path}/drill_holes/${index}/${key}`, undefined, 64);
    }
  });
  auditJsonPublicLeaks(document);
};

export const validatePortableSemanticsPayloadV2 = (
  value: unknown,
  reportKind: PortableReportKind,
  path = "$payload"
): PortableSemanticsPayloadV2 => {
  const safe = record(hardenPortableValue(value), path);
  if (reportKind === "kicad_netlist") {
    exactKeys(safe, path, ["schemaVersion", "reportKind", "expressions"]);
    if (safe.schemaVersion !== "evleda.portable-kicad-netlist.v2" || safe.reportKind !== reportKind || !Array.isArray(safe.expressions)) {
      return fail(`Invalid netlist payload at ${path}`);
    }
    const expressions = Object.freeze(safe.expressions.map((entry: unknown, index: number) => validateSExpression(entry, `${path}/expressions/${index}`)));
    validateNetlistStructure(expressions, path);
    return Object.freeze({
      schemaVersion: "evleda.portable-kicad-netlist.v2",
      reportKind,
      expressions
    });
  }
  if (reportKind === "kicad_d356") {
    exactKeys(safe, path, ["schemaVersion", "reportKind", "headers", "records"]);
    if (
      safe.schemaVersion !== "evleda.portable-kicad-d356-rev-a.v2" ||
      safe.reportKind !== reportKind ||
      !Array.isArray(safe.headers) ||
      !Array.isArray(safe.records)
    ) {
      return fail(`Invalid D356 payload at ${path}`);
    }
    const headers = safe.headers.map((entry: unknown, index: number) => text(entry, `${path}/headers/${index}`, undefined, 512));
    const records = safe.records.map((entry: unknown, index: number) => text(entry, `${path}/records/${index}`, undefined, 2_048));
    if (headers.length > 3 || records.length > 100_000) fail(`D356 payload budget exceeded at ${path}`);
    validateRevAD356Profile(headers, records, path);
    return Object.freeze({
      schemaVersion: "evleda.portable-kicad-d356-rev-a.v2",
      reportKind,
      headers: Object.freeze(headers),
      records: Object.freeze(records)
    });
  }
  exactKeys(safe, path, ["schemaVersion", "reportKind", "document"]);
  const schemas = {
    kicad_erc: "evleda.portable-kicad-erc.v2",
    kicad_drc: "evleda.portable-kicad-drc.v2",
    kicad_stats: "evleda.portable-kicad-stats.v2"
  } as const;
  const expectedSchema = schemas[reportKind];
  if (safe.schemaVersion !== expectedSchema || safe.reportKind !== reportKind) return fail(`Invalid ${reportKind} payload at ${path}`);
  const document = record(hardenPortableValue(safe.document), `${path}/document`);
  if (reportKind === "kicad_erc") {
    exactKeys(document, `${path}/document`, ["$schema", "coordinate_units", "date", "ignored_checks", "included_severities", "kicad_version", "sheets", "source"]);
    if (
      document.$schema !== "https://schemas.kicad.org/erc.v1.json" ||
      document.date !== "<portable-date>" ||
      document.source !== "<portable-source>" ||
      !Array.isArray(document.ignored_checks) ||
      !Array.isArray(document.included_severities) ||
      !Array.isArray(document.sheets) ||
      typeof document.coordinate_units !== "string" ||
      typeof document.kicad_version !== "string"
    ) return fail(`Closed normalized ERC document rejected at ${path}`);
    if (document.coordinate_units !== "mm" || !/^10\.[0-9]+(?:\.[0-9]+)?$/u.test(document.kicad_version)) {
      fail(`Unsupported ERC units or KiCad version at ${path}`);
    }
    validateProjectedIgnoredChecks(document.ignored_checks, `${path}/document/ignored_checks`);
    validateProjectedSeverities(document.included_severities, `${path}/document/included_severities`);
    const allowed = new Map<string, PublicSeparatorAllowance>([
      ["/$schema", documentationAllowance((entry) => entry === "https://schemas.kicad.org/erc.v1.json")]
    ]);
    document.sheets.forEach((rawSheet, index) => {
      const sheet = record(rawSheet, `${path}/document/sheets/${index}`);
      exactKeys(sheet, `${path}/document/sheets/${index}`, ["path", "uuid_path", "violations"]);
      const rawViolations = sheet.violations;
      if (typeof sheet.path !== "string" || typeof sheet.uuid_path !== "string" || !Array.isArray(rawViolations)) {
        fail(`Closed normalized ERC sheet rejected at ${path}/document/sheets/${index}`);
      }
      (rawViolations as unknown[]).forEach((entry: unknown, findingIndex: number) =>
        validateProjectedNativeFinding(entry, `${path}/document/sheets/${index}/violations/${findingIndex}`)
      );
      allowed.set(`/sheets/${index}/path`, hierarchyRootAllowance);
      allowed.set(`/sheets/${index}/uuid_path`, logicalPathAllowance(uuidHierarchyPath));
    });
    auditJsonPublicLeaks(document, "", allowed);
    return Object.freeze({ schemaVersion: "evleda.portable-kicad-erc.v2", reportKind, document });
  }
  if (reportKind === "kicad_drc") {
    exactKeys(document, `${path}/document`, ["$schema", "coordinate_units", "date", "ignored_checks", "included_severities", "kicad_version", "schematic_parity", "source", "unconnected_items", "violations"]);
    if (
      document.$schema !== "https://schemas.kicad.org/drc.v1.json" ||
      document.date !== "<portable-date>" ||
      document.source !== "<portable-source>" ||
      !Array.isArray(document.ignored_checks) ||
      !Array.isArray(document.included_severities) ||
      !Array.isArray(document.schematic_parity) ||
      !Array.isArray(document.unconnected_items) ||
      !Array.isArray(document.violations) ||
      typeof document.coordinate_units !== "string" ||
      typeof document.kicad_version !== "string"
    ) return fail(`Closed normalized DRC document rejected at ${path}`);
    if (document.coordinate_units !== "mm" || !/^10\.[0-9]+(?:\.[0-9]+)?$/u.test(document.kicad_version)) {
      fail(`Unsupported DRC units or KiCad version at ${path}`);
    }
    validateProjectedIgnoredChecks(document.ignored_checks, `${path}/document/ignored_checks`);
    validateProjectedSeverities(document.included_severities, `${path}/document/included_severities`);
    for (const key of ["schematic_parity", "unconnected_items", "violations"] as const) {
      (document[key] as unknown[]).forEach((entry: unknown, index: number) =>
        validateProjectedNativeFinding(entry, `${path}/document/${key}/${index}`)
      );
    }
    auditJsonPublicLeaks(
      document,
      "",
      new Map([["/$schema", documentationAllowance((entry) => entry === "https://schemas.kicad.org/drc.v1.json")]])
    );
    return Object.freeze({ schemaVersion: "evleda.portable-kicad-drc.v2", reportKind, document });
  }
  validateProjectedStats(document, `${path}/document`);
  return Object.freeze({ schemaVersion: "evleda.portable-kicad-stats.v2", reportKind, document });
};

const validateFindings = (value: unknown, path: string): readonly PortableFindingV2[] => {
  if (!Array.isArray(value) || value.length > 100_000) return fail(`Invalid findings array at ${path}`);
  const findings = value.map((entry: unknown, index: number): PortableFindingV2 => {
    const item = record(entry, `${path}/${index}`);
    exactKeys(item, `${path}/${index}`, ["ruleId", "severity", "message", "occurrenceCount"]);
    const message = text(item.message, `${path}/${index}/message`, undefined, 4_096);
    rejectPathLikeText(message, `${path}/${index}/message`);
    return Object.freeze({
      ruleId: text(item.ruleId, `${path}/${index}/ruleId`, /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u, 256),
      severity: oneOf(item.severity, `${path}/${index}/severity`, ["error", "warning", "exclusion", "info"] as const),
      message,
      occurrenceCount: integer(item.occurrenceCount, `${path}/${index}/occurrenceCount`, 1, 1_000_000)
    });
  });
  const keys = findings.map((entry) => `${entry.severity}\u0000${entry.ruleId}\u0000${entry.message}`);
  if (new Set(keys).size !== keys.length || keys.some((entry, index) => index > 0 && keys[index - 1]! >= entry)) {
    fail(`Findings must be sorted and unique at ${path}`);
  }
  return Object.freeze(findings);
};

const portableFindingKey = (finding: PortableFindingV2): string =>
  `${finding.severity}\u0000${finding.ruleId}\u0000${finding.message}`;

export const derivePortableFindingsV2 = (payload: PortableSemanticsPayloadV2): readonly PortableFindingV2[] => {
  const inputs: unknown[] = [];
  if (payload.reportKind === "kicad_erc") {
    const sheets = payload.document.sheets;
    if (!Array.isArray(sheets)) return fail("ERC findings require sheets");
    for (const rawSheet of sheets) {
      const sheet = record(rawSheet, "$payload/document/sheets");
      if (!Array.isArray(sheet.violations)) return fail("ERC findings require violation arrays");
      inputs.push(...sheet.violations);
    }
    const ignored = payload.document.ignored_checks;
    const severities = payload.document.included_severities;
    if (!Array.isArray(ignored) || !Array.isArray(severities)) return fail("ERC findings require coverage metadata");
    for (const rawCheck of ignored) {
      const check = record(rawCheck, "$payload/document/ignored_checks");
      inputs.push({ type: `ignored_check.${String(check.key)}`, severity: "exclusion", description: String(check.description) });
    }
    if (severities.join("\u0000") !== ["error", "warning", "exclusion"].join("\u0000")) {
      inputs.push({ type: "native_severity_coverage_incomplete", severity: "exclusion", description: "Native ERC severity coverage is incomplete" });
    }
    inputs.push({ type: "native_outcome_host_authentication_required", severity: "exclusion", description: "Native ERC outcome requires host authentication" });
  } else if (payload.reportKind === "kicad_drc") {
    for (const key of ["violations", "unconnected_items", "schematic_parity"] as const) {
      const entries = payload.document[key];
      if (!Array.isArray(entries)) return fail(`DRC findings require ${key}`);
      inputs.push(...entries);
    }
    const ignored = payload.document.ignored_checks;
    const severities = payload.document.included_severities;
    if (!Array.isArray(ignored) || !Array.isArray(severities)) return fail("DRC findings require coverage metadata");
    for (const rawCheck of ignored) {
      const check = record(rawCheck, "$payload/document/ignored_checks");
      inputs.push({ type: `ignored_check.${String(check.key)}`, severity: "exclusion", description: String(check.description) });
    }
    if (severities.join("\u0000") !== ["error", "warning", "exclusion"].join("\u0000")) {
      inputs.push({ type: "native_severity_coverage_incomplete", severity: "exclusion", description: "Native DRC severity coverage is incomplete" });
    }
    inputs.push({ type: "native_outcome_host_authentication_required", severity: "exclusion", description: "Native DRC outcome requires host authentication" });
  } else if (payload.reportKind === "kicad_stats") {
    inputs.push({ type: "observational_statistics_only", severity: "exclusion", description: "Board statistics are observational and do not assert acceptance" });
  }
  const grouped = new Map<string, PortableFindingV2>();
  for (const rawInput of inputs) {
    const item = record(rawInput, "$payload/finding");
    const rawRule = [item.type, item.rule, item.key, item.code].find((candidate) => typeof candidate === "string") ?? `${payload.reportKind}.finding`;
    const rawMessage = [item.description, item.message].find((candidate) => typeof candidate === "string") ?? "KiCad reported a finding";
    const ruleId = String(rawRule).replace(/[^A-Za-z0-9._-]+/gu, "_").slice(0, 256) || `${payload.reportKind}.finding`;
    const message = requireUnicodeScalars(String(rawMessage), "$payload/finding/message").slice(0, 4_096);
    const rawSeverity = typeof item.severity === "string" ? item.severity : "error";
    const severity: PortableFindingV2["severity"] =
      rawSeverity === "warning" || rawSeverity === "exclusion" || rawSeverity === "info" ? rawSeverity : "error";
    const candidate: PortableFindingV2 = Object.freeze({ ruleId, severity, message, occurrenceCount: 1 });
    const key = portableFindingKey(candidate);
    const prior = grouped.get(key);
    grouped.set(key, prior === undefined ? candidate : Object.freeze({ ...prior, occurrenceCount: prior.occurrenceCount + 1 }));
  }
  return Object.freeze(
    [...grouped.values()].sort((left, right) => {
      const leftKey = portableFindingKey(left);
      const rightKey = portableFindingKey(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    })
  );
};

const statusFromFindings = (findings: readonly PortableFindingV2[]): PublicPortableSemanticsV2["status"] => {
  if (findings.some((finding) => finding.severity === "error")) return "FAIL";
  return findings.length === 0 ? "PASS" : "UNKNOWN";
};

export type PublicPortableSemanticsDraftV2 = Omit<
  PublicPortableSemanticsV2,
  "payloadIdentity" | "findingsIdentity" | "semanticIdentity" | "documentIdentity"
>;

const semanticIdentityPreimage = (value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
  const withoutIdentity = withoutKey(withoutKey(value, "semanticIdentity"), "documentIdentity");
  const rawLedger = withoutIdentity.fieldDispositionLedger;
  if (!Array.isArray(rawLedger)) return fail("Semantic identity requires a disposition ledger");
  const portableLedger = rawLedger.map((entry, index) => {
    const item = record(entry, `$semanticIdentity/fieldDispositionLedger/${index}`);
    return withoutKey(item, "rawValueIdentity");
  });
  return Object.freeze({ ...withoutIdentity, fieldDispositionLedger: Object.freeze(portableLedger) });
};

export const withSemanticIdentity = (draft: PublicPortableSemanticsDraftV2): PublicPortableSemanticsV2 => {
  const safe = hardenPortableValue(draft) as unknown as PublicPortableSemanticsDraftV2;
  if (safe.schemaVersion !== "evleda.public-portable-semantics.v2") fail("Cannot mint unsupported public semantics schema");
  if (!PORTABLE_REPORT_KINDS.includes(safe.reportKind)) fail("Cannot mint unsupported public semantics report kind");
  const payload = validatePortableSemanticsPayloadV2(safe.payload, safe.reportKind);
  const expectedFindings = derivePortableFindingsV2(payload);
  if (canonicalPortableJson(expectedFindings) !== canonicalPortableJson(safe.findings)) {
    fail("Cannot mint public semantics with caller-supplied finding drift");
  }
  if (safe.status !== statusFromFindings(expectedFindings) || safe.normalizationOutcome !== "succeeded") {
    fail("Cannot mint public semantics with caller-supplied status/outcome drift");
  }
  const payloadIdentity = portableCanonicalIdentity(payload, payload.schemaVersion);
  const findingsIdentity = portableCanonicalIdentity(safe.findings, "evleda.portable-findings.v2");
  const preimage = { ...safe, payload, payloadIdentity, findings: expectedFindings, findingsIdentity };
  const semanticIdentity = portableCanonicalIdentity(
    semanticIdentityPreimage(preimage as unknown as Readonly<Record<string, unknown>>),
    "evleda.public-portable-semantics.v2"
  );
  const documentPreimage = Object.freeze({ ...preimage, semanticIdentity });
  return validatePublicPortableSemanticsV2(Object.freeze({
    ...documentPreimage,
    documentIdentity: portableCanonicalIdentity(documentPreimage, "evleda.public-portable-semantics-document.v2")
  }));
};

export const validatePublicPortableSemanticsV2 = (value: unknown, path = "$semantics"): PublicPortableSemanticsV2 => {
  const safe = record(hardenPortableValue(value), path);
  exactKeys(safe, path, [
    "schemaVersion",
    "authority",
    "rawNormalizationProvenance",
    "reportKind",
    "sourceBinding",
    "nativeContractIdentity",
    "normalizerContractIdentity",
    "normalizer",
    "tool",
    "commandPlanIdentity",
    "payload",
    "payloadIdentity",
    "fieldDispositionLedger",
    "findings",
    "findingsIdentity",
    "status",
    "normalizationOutcome",
    "lifecycle",
    "releaseAuthorized",
    "semanticIdentity",
    "documentIdentity"
  ]);
  if (
    safe.schemaVersion !== "evleda.public-portable-semantics.v2" ||
    safe.authority !== "integrity-only" ||
    safe.rawNormalizationProvenance !== "requires-private-replay" ||
    safe.normalizationOutcome !== "succeeded" ||
    safe.lifecycle !== "candidate" ||
    safe.releaseAuthorized !== false
  ) {
    return fail(`Unsupported or release-authorizing public semantics at ${path}`);
  }
  const reportKind = oneOf(safe.reportKind, `${path}/reportKind`, PORTABLE_REPORT_KINDS);
  const payload = validatePortableSemanticsPayloadV2(safe.payload, reportKind, `${path}/payload`);
  const payloadIdentity = requireIdentitySchema(
    validateCanonicalIdentity(safe.payloadIdentity, `${path}/payloadIdentity`),
    payload.schemaVersion,
    `${path}/payloadIdentity`
  );
  assertIdentity(payloadIdentity, portableCanonicalIdentity(payload, payload.schemaVersion), `${path}/payloadIdentity`);
  const findings = validateFindings(safe.findings, `${path}/findings`);
  const derivedFindings = derivePortableFindingsV2(payload);
  if (canonicalPortableJson(findings) !== canonicalPortableJson(derivedFindings)) {
    return fail(`Findings do not derive from normalized payload at ${path}/findings`);
  }
  const findingsIdentity = requireIdentitySchema(
    validateCanonicalIdentity(safe.findingsIdentity, `${path}/findingsIdentity`),
    "evleda.portable-findings.v2",
    `${path}/findingsIdentity`
  );
  assertIdentity(findingsIdentity, portableCanonicalIdentity(findings, "evleda.portable-findings.v2"), `${path}/findingsIdentity`);
  const status = oneOf(safe.status, `${path}/status`, ["PASS", "FAIL", "UNKNOWN"] as const);
  const expectedStatus = statusFromFindings(derivedFindings);
  if (status !== expectedStatus) return fail(`Status does not derive from findings at ${path}/status`, { status, expectedStatus });
  const semanticIdentity = requireIdentitySchema(
    validateCanonicalIdentity(safe.semanticIdentity, `${path}/semanticIdentity`),
    "evleda.public-portable-semantics.v2",
    `${path}/semanticIdentity`
  );
  const documentIdentity = requireIdentitySchema(
    validateCanonicalIdentity(safe.documentIdentity, `${path}/documentIdentity`),
    "evleda.public-portable-semantics-document.v2",
    `${path}/documentIdentity`
  );
  const normalizer = validateToolContentIdentityV1(safe.normalizer, `${path}/normalizer`);
  const tool = validateToolContentIdentityV1(safe.tool, `${path}/tool`);
  if (normalizer.role !== "portable_normalizer" || tool.role !== "native_validator") {
    return fail(`Public semantics tool roles are invalid at ${path}`);
  }
  const result = Object.freeze({
    schemaVersion: "evleda.public-portable-semantics.v2" as const,
    authority: "integrity-only" as const,
    rawNormalizationProvenance: "requires-private-replay" as const,
    reportKind,
    sourceBinding: validatePortableSourceBindingV1(safe.sourceBinding, `${path}/sourceBinding`),
    nativeContractIdentity: requireIdentitySchema(
      validateCanonicalIdentity(safe.nativeContractIdentity, `${path}/nativeContractIdentity`),
      "evleda.native-validation-contract.v1",
      `${path}/nativeContractIdentity`
    ),
    normalizerContractIdentity: requireIdentitySchema(
      validateCanonicalIdentity(safe.normalizerContractIdentity, `${path}/normalizerContractIdentity`),
      "evleda.portable-normalizer-contract.v1",
      `${path}/normalizerContractIdentity`
    ),
    normalizer,
    tool,
    commandPlanIdentity: requireIdentitySchema(
      validateCanonicalIdentity(safe.commandPlanIdentity, `${path}/commandPlanIdentity`),
      "evleda.typed-command-plan.v1",
      `${path}/commandPlanIdentity`
    ),
    payload,
    payloadIdentity,
    fieldDispositionLedger: validateLedger(safe.fieldDispositionLedger, reportKind, `${path}/fieldDispositionLedger`),
    findings,
    findingsIdentity,
    status,
    normalizationOutcome: "succeeded" as const,
    lifecycle: "candidate" as const,
    releaseAuthorized: false as const,
    semanticIdentity,
    documentIdentity
  });
  assertIdentity(
    semanticIdentity,
    portableCanonicalIdentity(semanticIdentityPreimage(result as unknown as Readonly<Record<string, unknown>>), "evleda.public-portable-semantics.v2"),
    `${path}/semanticIdentity`
  );
  assertIdentity(
    documentIdentity,
    portableCanonicalIdentity(withoutKey(result as unknown as Readonly<Record<string, unknown>>, "documentIdentity"), "evleda.public-portable-semantics-document.v2"),
    `${path}/documentIdentity`
  );
  return result;
};

export const parsePublicPortableSemanticsV2Bytes = (bytes: Uint8Array): PublicPortableSemanticsV2 =>
  validatePublicPortableSemanticsV2(parsePortableJsonBytes(bytes), "$semantics");

export type RawBoundPortableReceiptDraftV2 = Omit<RawBoundPortableReceiptV2, "receiptIdentity">;

export const withRawBoundReceiptV2Identity = (draft: RawBoundPortableReceiptDraftV2): RawBoundPortableReceiptV2 => {
  const safe = hardenPortableValue(draft) as unknown as RawBoundPortableReceiptDraftV2;
  if (safe.schemaVersion !== "evleda.raw-bound-portable-receipt.v2") fail("Cannot mint unsupported raw-bound receipt schema");
  return validateRawBoundPortableReceiptV2(Object.freeze({
    ...safe,
    receiptIdentity: portableCanonicalIdentity(safe, "evleda.raw-bound-portable-receipt.v2")
  }));
};

export const validateRawBoundPortableReceiptV2 = (value: unknown, path = "$receipt"): RawBoundPortableReceiptV2 => {
  const safe = record(hardenPortableValue(value), path);
  exactKeys(safe, path, [
    "schemaVersion",
    "reportKind",
    "sourceBinding",
    "rawContentIdentity",
    "portableSemanticIdentity",
    "portableDocumentIdentity",
    "normalizerContentIdentity",
    "toolIdentity",
    "commandPlanIdentity",
    "captureIdentity",
    "lifecycle",
    "releaseAuthorized",
    "receiptIdentity"
  ]);
  if (
    safe.schemaVersion !== "evleda.raw-bound-portable-receipt.v2" ||
    safe.lifecycle !== "candidate" ||
    safe.releaseAuthorized !== false
  ) {
    return fail(`Unsupported or release-authorizing raw-bound receipt at ${path}`);
  }
  const receiptIdentity = validateCanonicalIdentity(safe.receiptIdentity, `${path}/receiptIdentity`);
  const result = Object.freeze({
    schemaVersion: "evleda.raw-bound-portable-receipt.v2" as const,
    reportKind: oneOf(safe.reportKind, `${path}/reportKind`, PORTABLE_REPORT_KINDS),
    sourceBinding: validatePortableSourceBindingV1(safe.sourceBinding, `${path}/sourceBinding`),
    rawContentIdentity: validateContentIdentity(safe.rawContentIdentity, `${path}/rawContentIdentity`),
    portableSemanticIdentity: requireIdentitySchema(
      validateCanonicalIdentity(safe.portableSemanticIdentity, `${path}/portableSemanticIdentity`),
      "evleda.public-portable-semantics.v2",
      `${path}/portableSemanticIdentity`
    ),
    portableDocumentIdentity: requireIdentitySchema(
      validateCanonicalIdentity(safe.portableDocumentIdentity, `${path}/portableDocumentIdentity`),
      "evleda.public-portable-semantics-document.v2",
      `${path}/portableDocumentIdentity`
    ),
    normalizerContentIdentity: validateContentIdentity(safe.normalizerContentIdentity, `${path}/normalizerContentIdentity`),
    toolIdentity: validateToolContentIdentityV1(safe.toolIdentity, `${path}/toolIdentity`),
    commandPlanIdentity: requireIdentitySchema(
      validateCanonicalIdentity(safe.commandPlanIdentity, `${path}/commandPlanIdentity`),
      "evleda.typed-command-plan.v1",
      `${path}/commandPlanIdentity`
    ),
    captureIdentity: requireIdentitySchema(
      validateCanonicalIdentity(safe.captureIdentity, `${path}/captureIdentity`),
      "evleda.portable-capture-command-envelope.v1",
      `${path}/captureIdentity`
    ),
    lifecycle: "candidate" as const,
    releaseAuthorized: false as const,
    receiptIdentity
  });
  if (result.toolIdentity.role !== "native_validator") return fail(`Raw-bound receipt tool role rejected at ${path}`);
  assertIdentity(
    receiptIdentity,
    portableCanonicalIdentity(withoutKey(result as unknown as Readonly<Record<string, unknown>>, "receiptIdentity"), "evleda.raw-bound-portable-receipt.v2"),
    `${path}/receiptIdentity`
  );
  return result;
};

export const parseRawBoundPortableReceiptV2Bytes = (bytes: Uint8Array): RawBoundPortableReceiptV2 =>
  validateRawBoundPortableReceiptV2(parsePortableJsonBytes(bytes), "$receipt");

export type PrivateRawCaptureReceiptDraftV2 = Omit<PrivateRawCaptureReceiptV2, "captureIdentity" | "receiptIdentity">;

const rawCapturePreimage = (draft: PrivateRawCaptureReceiptDraftV2): Readonly<Record<string, unknown>> => ({
  schemaVersion: "evleda.raw-capture-key.v2",
  reportKind: draft.reportKind,
  sourceBinding: draft.sourceBinding,
  rawContentIdentity: draft.rawContentIdentity,
  nativeContractIdentity: draft.nativeContractIdentity,
  normalizerContractIdentity: draft.normalizerContractIdentity,
  toolIdentity: draft.toolIdentity,
  commandPlanIdentity: draft.commandPlanIdentity,
  invocationIdentity: draft.invocationIdentity,
  stdoutIdentity: draft.stdoutIdentity,
  stderrIdentity: draft.stderrIdentity,
  exitCode: draft.exitCode,
  outcome: draft.outcome
});

export const deriveRawCaptureIdentityV2 = (draft: PrivateRawCaptureReceiptDraftV2): CanonicalIdentity => {
  if (draft.schemaVersion !== "evleda.private-raw-capture-receipt.v2") fail("Cannot derive capture identity for unsupported receipt schema");
  return portableCanonicalIdentity(rawCapturePreimage(draft), "evleda.raw-capture-key.v2");
};

export const withPrivateRawCaptureReceiptV2Identities = (
  draft: PrivateRawCaptureReceiptDraftV2
): PrivateRawCaptureReceiptV2 => {
  const safe = hardenPortableValue(draft) as unknown as PrivateRawCaptureReceiptDraftV2;
  const captureIdentity = deriveRawCaptureIdentityV2(safe);
  const preimage = { ...safe, captureIdentity };
  return validatePrivateRawCaptureReceiptV2(Object.freeze({
    ...preimage,
    receiptIdentity: portableCanonicalIdentity(preimage, "evleda.private-raw-capture-receipt.v2")
  }));
};

export const validatePrivateRawCaptureReceiptV2 = (
  value: unknown,
  path = "$privateReceipt"
): PrivateRawCaptureReceiptV2 => {
  const safe = record(hardenPortableValue(value), path);
  exactKeys(safe, path, [
    "schemaVersion",
    "authority",
    "reportKind",
    "sourceBinding",
    "rawContentIdentity",
    "privateRawPath",
    "nativeContractIdentity",
    "normalizerContractIdentity",
    "toolIdentity",
    "commandPlanIdentity",
    "invocationIdentity",
    "stdoutIdentity",
    "stderrIdentity",
    "exitCode",
    "outcome",
    "publicSemanticIdentity",
    "capturedAt",
    "timestampDisposition",
    "captureIdentity",
    "receiptIdentity"
  ]);
  if (
    safe.schemaVersion !== "evleda.private-raw-capture-receipt.v2" ||
    safe.authority !== "private-non-authoritative" ||
    safe.timestampDisposition !== "excluded-private"
  ) {
    return fail(`Unsupported private raw-capture receipt at ${path}`);
  }
  const privateRawPath = validatePortablePathRefV1(safe.privateRawPath, `${path}/privateRawPath`);
  if (privateRawPath.root !== "run_private") fail(`Private raw locator must use run_private at ${path}/privateRawPath`);
  const reportKind = oneOf(safe.reportKind, `${path}/reportKind`, [...PORTABLE_REPORT_KINDS, "kicad_pdf"] as const);
  const outcome = oneOf(safe.outcome, `${path}/outcome`, ["succeeded", "failed", "timed_out", "not_run"] as const);
  const exitCode = safe.exitCode === null ? null : integer(safe.exitCode, `${path}/exitCode`, 0, 4_294_967_295);
  if (
    (outcome === "succeeded" && (exitCode === null || ((reportKind === "kicad_erc" || reportKind === "kicad_drc") ? ![0, 5].includes(exitCode) : exitCode !== 0))) ||
    (outcome === "failed" && (exitCode === null || exitCode === 0)) ||
    ((outcome === "timed_out" || outcome === "not_run") && exitCode !== null)
  ) fail(`Exit code/outcome mismatch at ${path}`);
  const capturedAt = text(
    safe.capturedAt,
    `${path}/capturedAt`,
    /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/u,
    24
  );
  const parsedCapturedAt = Date.parse(capturedAt);
  const canonicalCapturedAt = Number.isFinite(parsedCapturedAt) ? new Date(parsedCapturedAt).toISOString() : "";
  const expectedCapturedAt = capturedAt.includes(".") ? capturedAt : capturedAt.replace("Z", ".000Z");
  if (capturedAt.startsWith("0000-") || canonicalCapturedAt !== expectedCapturedAt) fail(`Invalid calendar timestamp at ${path}/capturedAt`);
  const publicSemanticIdentity =
    safe.publicSemanticIdentity === null
      ? null
      : requireIdentitySchema(
          validateCanonicalIdentity(safe.publicSemanticIdentity, `${path}/publicSemanticIdentity`),
          "evleda.public-portable-semantics.v2",
          `${path}/publicSemanticIdentity`
        );
  if (
    (reportKind === "kicad_pdf" && publicSemanticIdentity !== null) ||
    (reportKind !== "kicad_pdf" && outcome === "succeeded" && publicSemanticIdentity === null) ||
    (outcome !== "succeeded" && publicSemanticIdentity !== null)
  ) return fail(`Report kind/outcome/public semantic authority mismatch at ${path}`);
  const captureIdentity = requireIdentitySchema(
    validateCanonicalIdentity(safe.captureIdentity, `${path}/captureIdentity`),
    "evleda.raw-capture-key.v2",
    `${path}/captureIdentity`
  );
  const receiptIdentity = validateCanonicalIdentity(safe.receiptIdentity, `${path}/receiptIdentity`);
  const result = Object.freeze({
    schemaVersion: "evleda.private-raw-capture-receipt.v2" as const,
    authority: "private-non-authoritative" as const,
    reportKind,
    sourceBinding: validatePortableSourceBindingV1(safe.sourceBinding, `${path}/sourceBinding`),
    rawContentIdentity: validateContentIdentity(safe.rawContentIdentity, `${path}/rawContentIdentity`),
    privateRawPath,
    nativeContractIdentity: requireIdentitySchema(
      validateCanonicalIdentity(safe.nativeContractIdentity, `${path}/nativeContractIdentity`),
      "evleda.native-validation-contract.v1",
      `${path}/nativeContractIdentity`
    ),
    normalizerContractIdentity: requireIdentitySchema(
      validateCanonicalIdentity(safe.normalizerContractIdentity, `${path}/normalizerContractIdentity`),
      "evleda.portable-normalizer-contract.v1",
      `${path}/normalizerContractIdentity`
    ),
    toolIdentity: validateToolContentIdentityV1(safe.toolIdentity, `${path}/toolIdentity`),
    commandPlanIdentity: requireIdentitySchema(
      validateCanonicalIdentity(safe.commandPlanIdentity, `${path}/commandPlanIdentity`),
      "evleda.typed-command-plan.v1",
      `${path}/commandPlanIdentity`
    ),
    invocationIdentity: requireIdentitySchema(
      validateCanonicalIdentity(safe.invocationIdentity, `${path}/invocationIdentity`),
      "evleda.tool-invocation.v1",
      `${path}/invocationIdentity`
    ),
    stdoutIdentity: validateContentIdentity(safe.stdoutIdentity, `${path}/stdoutIdentity`),
    stderrIdentity: validateContentIdentity(safe.stderrIdentity, `${path}/stderrIdentity`),
    exitCode,
    outcome,
    publicSemanticIdentity,
    capturedAt,
    timestampDisposition: "excluded-private" as const,
    captureIdentity,
    receiptIdentity
  });
  if (result.toolIdentity.role !== "native_validator") return fail(`Private receipt tool role rejected at ${path}`);
  const draft = withoutKey(withoutKey(result as unknown as Readonly<Record<string, unknown>>, "receiptIdentity"), "captureIdentity") as unknown as PrivateRawCaptureReceiptDraftV2;
  assertIdentity(captureIdentity, deriveRawCaptureIdentityV2(draft), `${path}/captureIdentity`);
  assertIdentity(
    receiptIdentity,
    portableCanonicalIdentity(withoutKey(result as unknown as Readonly<Record<string, unknown>>, "receiptIdentity"), "evleda.private-raw-capture-receipt.v2"),
    `${path}/receiptIdentity`
  );
  return result;
};

export const parsePrivateRawCaptureReceiptV2Bytes = (bytes: Uint8Array): PrivateRawCaptureReceiptV2 =>
  validatePrivateRawCaptureReceiptV2(parsePortableJsonBytes(bytes), "$privateReceipt");

export const portablePdfNotRunV2 = (rawBytes: Uint8Array): PortablePdfNotRunV2 => {
  capturePortableRawBytes(rawBytes, 16_777_216, true);
  return Object.freeze({
    schemaVersion: "evleda.portable-kicad-pdf-not-run.v2",
    authority: "consistency-only",
    reportKind: "kicad_pdf",
    status: "NOT_RUN",
    blocker: "PDF_PRIVATE_NON_SEMANTIC",
    reason: "PDF bytes remain private and cannot create portable public authority",
    portableSemantics: null,
    rawContentIdentity: null,
    privateReceiptRequired: true,
    releaseAuthorized: false
  });
};

export const validatePortablePdfNotRunV2 = (value: unknown, path = "$pdfMarker"): PortablePdfNotRunV2 => {
  const safe = record(hardenPortableValue(value), path);
  exactKeys(safe, path, ["schemaVersion", "authority", "reportKind", "status", "blocker", "reason", "portableSemantics", "rawContentIdentity", "privateReceiptRequired", "releaseAuthorized"]);
  if (
    safe.schemaVersion !== "evleda.portable-kicad-pdf-not-run.v2" || safe.authority !== "consistency-only" ||
    safe.reportKind !== "kicad_pdf" || safe.status !== "NOT_RUN" || safe.blocker !== "PDF_PRIVATE_NON_SEMANTIC" ||
    safe.reason !== "PDF bytes remain private and cannot create portable public authority" ||
    safe.portableSemantics !== null || safe.rawContentIdentity !== null || safe.privateReceiptRequired !== true ||
    safe.releaseAuthorized !== false
  ) return fail(`Invalid or authority-escalating PDF marker at ${path}`);
  return Object.freeze({
    schemaVersion: "evleda.portable-kicad-pdf-not-run.v2", authority: "consistency-only", reportKind: "kicad_pdf",
    status: "NOT_RUN", blocker: "PDF_PRIVATE_NON_SEMANTIC",
    reason: "PDF bytes remain private and cannot create portable public authority",
    portableSemantics: null, rawContentIdentity: null, privateReceiptRequired: true, releaseAuthorized: false
  });
};

export const parsePortablePdfNotRunV2Bytes = (bytes: Uint8Array): PortablePdfNotRunV2 =>
  validatePortablePdfNotRunV2(parsePortableJsonBytes(bytes));

export const PORTABLE_ROOTS = ["reference", "run_input", "run_public", "run_private"] as const;
export type PortableRoot = (typeof PORTABLE_ROOTS)[number];
export type PublicPortableRoot = Exclude<PortableRoot, "run_private">;

export const PORTABLE_REPORT_KINDS = ["kicad_netlist", "kicad_erc", "kicad_drc", "kicad_stats", "kicad_d356"] as const;
export type PortableReportKind = (typeof PORTABLE_REPORT_KINDS)[number];

export interface PortablePathRefV1 {
  readonly schemaVersion: "evleda.portable-path-ref.v1";
  readonly root: PortableRoot;
  readonly relativePath: string;
}

export interface ToolContentIdentityV1 {
  readonly schemaVersion: "evleda.tool-content-identity.v1";
  readonly role: "native_validator" | "portable_normalizer" | "runtime" | "validation_driver";
  readonly kind: "native_executable" | "portable_implementation";
  readonly name: string;
  readonly version: string;
  readonly commit: string;
  readonly contentIdentity: ContentIdentity;
  readonly capabilitiesIdentity: ContentIdentity;
  readonly helpIdentity: ContentIdentity;
}

export type TypedCommandArgumentV1 =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "path"; readonly value: PortablePathRefV1 };

export interface PortableEnvironmentPolicyV1 {
  readonly schemaVersion: "evleda.portable-environment-policy.v1";
  readonly pythonHashSeed: "0";
  readonly pythonUtf8: "1";
  readonly locale: "C";
  readonly timezone: "UTC";
  readonly privateFields: readonly {
    readonly name: "HOME" | "TEMP" | "TMP" | "KICAD_CONFIG_HOME";
    readonly disposition: "excluded-private";
  }[];
}

export interface TypedCommandPlanV1 {
  readonly schemaVersion: "evleda.typed-command-plan.v1";
  readonly tool: ToolContentIdentityV1;
  readonly logicalCwd: PortablePathRefV1;
  readonly argv: readonly TypedCommandArgumentV1[];
  readonly environment: PortableEnvironmentPolicyV1;
  readonly expectedOutputs: readonly PortablePathRefV1[];
  readonly commandPlanIdentity: CanonicalIdentity;
}

export type FieldDispositionV2 = "normalized" | "excluded-private" | "not-run";

export interface FieldDispositionLedgerEntryV2 {
  readonly pointer: string;
  readonly ruleId: string;
  readonly occurrenceCount: number;
  readonly disposition: FieldDispositionV2;
  readonly normalizedMarker: string | null;
}

export interface PortableSourceBindingV1 {
  readonly schemaVersion: "evleda.portable-source-binding.v1";
  readonly sourceRevisionIdentity: CanonicalIdentity;
  readonly sourceArtifactIdentity: ContentIdentity;
  readonly sourcePath: PortablePathRefV1;
  readonly sourceContractIdentity: CanonicalIdentity;
}

export interface PortableFindingV2 {
  readonly ruleId: string;
  readonly severity: "error" | "warning" | "exclusion" | "info";
  readonly message: string;
  readonly occurrenceCount: number;
}

export interface PortableSExpressionAtomV1 {
  readonly kind: "atom";
  readonly value: string;
}

export interface PortableSExpressionStringV1 {
  readonly kind: "string";
  readonly value: string;
}

export interface PortableSExpressionListV1 {
  readonly kind: "list";
  readonly items: readonly PortableSExpressionV1[];
}

export type PortableSExpressionV1 = PortableSExpressionAtomV1 | PortableSExpressionStringV1 | PortableSExpressionListV1;

export type PortableSemanticsPayloadV2 =
  | { readonly schemaVersion: "evleda.portable-kicad-netlist.v2"; readonly reportKind: "kicad_netlist"; readonly expressions: readonly PortableSExpressionV1[] }
  | { readonly schemaVersion: "evleda.portable-kicad-erc.v2"; readonly reportKind: "kicad_erc"; readonly document: Readonly<Record<string, unknown>> }
  | { readonly schemaVersion: "evleda.portable-kicad-drc.v2"; readonly reportKind: "kicad_drc"; readonly document: Readonly<Record<string, unknown>> }
  | { readonly schemaVersion: "evleda.portable-kicad-stats.v2"; readonly reportKind: "kicad_stats"; readonly document: Readonly<Record<string, unknown>> }
  | { readonly schemaVersion: "evleda.portable-kicad-d356-rev-a.v2"; readonly reportKind: "kicad_d356"; readonly headers: readonly string[]; readonly records: readonly string[] };

export interface PublicPortableSemanticsV2 {
  readonly schemaVersion: "evleda.public-portable-semantics.v2";
  readonly authority: "integrity-only";
  readonly rawNormalizationProvenance: "requires-private-replay";
  readonly reportKind: PortableReportKind;
  readonly sourceBinding: PortableSourceBindingV1;
  readonly nativeContractIdentity: CanonicalIdentity;
  readonly normalizerContractIdentity: CanonicalIdentity;
  readonly normalizer: ToolContentIdentityV1;
  readonly tool: ToolContentIdentityV1;
  readonly commandPlanIdentity: CanonicalIdentity;
  readonly payload: PortableSemanticsPayloadV2;
  readonly payloadIdentity: CanonicalIdentity;
  readonly fieldDispositionLedger: readonly FieldDispositionLedgerEntryV2[];
  readonly findings: readonly PortableFindingV2[];
  readonly findingsIdentity: CanonicalIdentity;
  readonly status: "PASS" | "FAIL" | "UNKNOWN";
  readonly normalizationOutcome: "succeeded";
  readonly lifecycle: "candidate";
  readonly releaseAuthorized: false;
  readonly semanticIdentity: CanonicalIdentity;
  readonly documentIdentity: CanonicalIdentity;
}

export interface RawBoundPortableReceiptV2 {
  readonly schemaVersion: "evleda.raw-bound-portable-receipt.v2";
  readonly reportKind: PortableReportKind;
  readonly sourceBinding: PortableSourceBindingV1;
  readonly rawContentIdentity: ContentIdentity;
  readonly portableSemanticIdentity: CanonicalIdentity;
  readonly portableDocumentIdentity: CanonicalIdentity;
  readonly normalizerContentIdentity: ContentIdentity;
  readonly toolIdentity: ToolContentIdentityV1;
  readonly commandPlanIdentity: CanonicalIdentity;
  readonly captureIdentity: CanonicalIdentity;
  readonly lifecycle: "candidate";
  readonly releaseAuthorized: false;
  readonly receiptIdentity: CanonicalIdentity;
}

export interface PrivateRawCaptureReceiptV2 {
  readonly schemaVersion: "evleda.private-raw-capture-receipt.v2";
  readonly authority: "private-non-authoritative";
  readonly reportKind: PortableReportKind | "kicad_pdf";
  readonly sourceBinding: PortableSourceBindingV1;
  readonly rawContentIdentity: ContentIdentity;
  readonly privateRawPath: PortablePathRefV1;
  readonly nativeContractIdentity: CanonicalIdentity;
  readonly normalizerContractIdentity: CanonicalIdentity;
  readonly toolIdentity: ToolContentIdentityV1;
  readonly commandPlanIdentity: CanonicalIdentity;
  readonly invocationIdentity: CanonicalIdentity;
  readonly stdoutIdentity: ContentIdentity;
  readonly stderrIdentity: ContentIdentity;
  readonly exitCode: number | null;
  readonly outcome: "succeeded" | "failed" | "timed_out" | "not_run";
  readonly publicSemanticIdentity: CanonicalIdentity | null;
  readonly capturedAt: string;
  readonly timestampDisposition: "excluded-private";
  readonly captureIdentity: CanonicalIdentity;
  readonly receiptIdentity: CanonicalIdentity;
}

export interface PortablePdfNotRunV2 {
  readonly schemaVersion: "evleda.portable-kicad-pdf-not-run.v2";
  readonly authority: "consistency-only";
  readonly reportKind: "kicad_pdf";
  readonly status: "NOT_RUN";
  readonly blocker: "PDF_PRIVATE_NON_SEMANTIC";
  readonly reason: "PDF bytes remain private and cannot create portable public authority";
  readonly portableSemantics: null;
  readonly rawContentIdentity: null;
  readonly privateReceiptRequired: true;
  readonly releaseAuthorized: false;
}
