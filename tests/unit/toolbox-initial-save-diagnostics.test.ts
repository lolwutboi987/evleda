import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { writeInitialSaveSourceMismatch } from "../../src/mcp/toolbox-initial-save-diagnostics.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) {
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith("evleda-initial-source-")) throw new Error("Unsafe fixture cleanup");
  await rm(root, { recursive: true, force: true });
} });
describe("private initial-save source diagnostics", () => {
  it("retains both complete raw channels and their identities without claiming native Save", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-initial-source-")); roots.push(root);
    const input = { phase: "before-save" as const, preparedSource: '(kicad_pcb (version 20260206))\r\n',
      observedLiveSource: '(kicad_pcb (version 20260206) (property "changed" "yes"))\n' };
    const result = await writeInitialSaveSourceMismatch(root, input), bytes = await readFile(result.path), record = JSON.parse(bytes.toString("utf8"));
    expect(result.identity).toEqual(contentIdentity(bytes));
    expect(record.prepared).toEqual({ source: input.preparedSource, identity: contentIdentity(input.preparedSource) });
    expect(record.live).toEqual({ source: input.observedLiveSource, identity: contentIdentity(input.observedLiveSource) });
    expect(record.nativeSaveAttempted).toBe(false); expect(record.acceptanceEvaluated).toBe(false);
    const { identity, ...body } = record; expect(identity).toEqual(canonicalIdentity(body, record.schemaVersion));
    expect(Object.keys(result).sort()).toEqual(["identity", "path"]);
  });
  it("rejects oversized or malformed source before reserving an artifact", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-initial-source-")); roots.push(root);
    for (const observedLiveSource of ["x".repeat(2 * 1024 * 1024 + 1), "\ud800"]) {
      await expect(writeInitialSaveSourceMismatch(root, { phase: "after-save", preparedSource: "(kicad_pcb)", observedLiveSource })).rejects.toThrow(/scope/);
    }
    expect(await readdir(root)).toEqual([]);
  });
});
