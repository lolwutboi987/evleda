import { describe, expect, it } from "vitest";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import { DomainError } from "../../src/domain/errors.js";

describe("canonical JSON", () => {
  it("sorts object keys recursively while preserving array order", () => {
    const left = { z: 1, nested: { beta: true, alpha: [3, 2, 1] } };
    const right = { nested: { alpha: [3, 2, 1], beta: true }, z: 1 };

    expect(canonicalJson(left)).toBe('{"nested":{"alpha":[3,2,1],"beta":true},"z":1}');
    expect(canonicalIdentity(left, "test.v1")).toEqual(canonicalIdentity(right, "test.v1"));
  });

  it("changes identity for a one-value mutation", () => {
    expect(canonicalIdentity({ currentMa: 500 }, "test.v1").digest).not.toBe(
      canonicalIdentity({ currentMa: 501 }, "test.v1").digest
    );
  });

  it("rejects undefined and non-finite values", () => {
    expect(() => canonicalJson({ missing: undefined })).toThrow(DomainError);
    expect(() => canonicalJson({ invalid: Number.NaN })).toThrow(DomainError);
  });

  it("hashes exact prompt bytes", () => {
    expect(contentIdentity("7-16.8 V").digest).not.toBe(contentIdentity("7–16.8 V").digest);
  });
});

