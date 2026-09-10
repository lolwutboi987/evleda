import { createHash, timingSafeEqual } from "node:crypto";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import { DomainError } from "../domain/errors.js";

const isPlainObject = (value: object): value is Record<string, unknown> => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const encode = (value: unknown, path: string): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new DomainError("INVALID_ARGUMENT", `Non-finite number at ${path}`);
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry, index) => encode(entry, `${path}[${index}]`)).join(",")}]`;
  }

  if (typeof value === "object") {
    if (!isPlainObject(value)) {
      throw new DomainError(
        "INVALID_ARGUMENT",
        `Only plain JSON objects can be canonicalized at ${path}`
      );
    }

    const entries = Object.keys(value)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((key) => {
        const entry = value[key];
        if (entry === undefined) {
          throw new DomainError("INVALID_ARGUMENT", `Undefined value at ${path}.${key}`);
        }
        return `${JSON.stringify(key)}:${encode(entry, `${path}.${key}`)}`;
      });
    return `{${entries.join(",")}}`;
  }

  throw new DomainError("INVALID_ARGUMENT", `Unsupported JSON value at ${path}`);
};

export const canonicalJson = (value: unknown): string => encode(value, "$");

export const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

export const contentIdentity = (bytes: Uint8Array | string): ContentIdentity => {
  const buffer = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
  return {
    algorithm: "sha256",
    digest: sha256(buffer),
    size: buffer.byteLength
  };
};

export const canonicalIdentity = (
  value: unknown,
  schemaVersion: string
): CanonicalIdentity => ({
  algorithm: "sha256",
  digest: sha256(canonicalJson(value)),
  schemaVersion,
  canonicalizationVersion: "evleda-c14n-json-v1"
});

export const constantTimeDigestEqual = (left: string, right: string): boolean => {
  if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
};
