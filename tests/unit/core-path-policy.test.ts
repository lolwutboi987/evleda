import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveWithinRoot, resolveWriteTargetWithinRoot } from "../../src/core/path-policy.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace path policy", () => {
  it("allows a nested path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-path-"));
    roots.push(root);
    expect(resolveWithinRoot(root, "runs/run_1/output.json")).toBe(
      path.join(root, "runs", "run_1", "output.json")
    );
    await expect(resolveWriteTargetWithinRoot(root, "runs/run_1/output.json")).resolves.toBe(
      path.join(root, "runs", "run_1", "output.json")
    );
  });

  it("rejects lexical traversal and absolute escapes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-path-"));
    roots.push(root);
    expect(() => resolveWithinRoot(root, "../escape.txt")).toThrowError(/escapes/iu);
    expect(() => resolveWithinRoot(root, path.parse(root).root)).toThrowError(/escapes/iu);
  });
});

