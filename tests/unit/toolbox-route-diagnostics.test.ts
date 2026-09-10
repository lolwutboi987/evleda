import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import type { FreshRouteMutationDiagnostic } from "../../src/harness/kicad-tools.js";
import { writeToolboxRouteDiagnostic } from "../../src/mcp/toolbox-route-diagnostics.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function outputRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "evleda-route-diagnostics-")); roots.push(root); return root;
}
function diagnostic(phase: FreshRouteMutationDiagnostic["phase"] = "primary-failure"): FreshRouteMutationDiagnostic {
  const body = { schemaVersion: "evleda.fresh-route-mutation-diagnostic.v1" as const, phase,
    toolCallId: "toolbox:fixture", net: "VIN", firstOperation: "pcb_push_commit",
    primary: [{ name: "TypeError", message: "push_commit requires its native Commit argument" }],
    beforePcbContentIdentity: contentIdentity("pre-route source identity only"), transactionStarted: true, transactionPushed: false,
    cleanup: phase === "primary-failure" ? [] : [{ operation: "drop", status: "failed", message: "secondary failure" }],
    recovery: phase === "primary-failure" ? "pending" : "preserved-state-recovery-required" };
  return { ...body, identity: canonicalIdentity(body, body.schemaVersion) };
}

describe("private durable route failure diagnostics", () => {
  it("retains the complete first cause separately from subsequent recovery failure", async () => {
    const root = await outputRoot(), primary = diagnostic(), final = diagnostic("recovery-finished");
    const first = await writeToolboxRouteDiagnostic(root, primary), second = await writeToolboxRouteDiagnostic(root, final);
    expect(first.path).not.toBe(second.path);
    expect(path.dirname(first.path)).toBe(root); expect(path.basename(first.path)).toMatch(/^route-diagnostic-primary-failure-[a-f0-9-]+\.json$/u);
    const bytes = await readFile(first.path);
    expect(contentIdentity(bytes)).toEqual(first.identity); expect(JSON.parse(bytes.toString("utf8"))).toEqual(primary);
    expect(JSON.parse(await readFile(second.path, "utf8"))).toEqual(final);
    expect(await readdir(root)).toHaveLength(2);
    expect(primary.cleanup).toEqual([]);
  });
  it("never overwrites an earlier diagnostic when the same record is observed again", async () => {
    const root = await outputRoot(), value = diagnostic();
    const first = await writeToolboxRouteDiagnostic(root, value), second = await writeToolboxRouteDiagnostic(root, value);
    expect(first.path).not.toBe(second.path); expect(first.identity).toEqual(second.identity);
    expect(await readFile(first.path)).toEqual(await readFile(second.path));
  });
  it("rejects changed payloads before any artifact is created", async () => {
    const root = await outputRoot(), value = diagnostic();
    await expect(writeToolboxRouteDiagnostic(root, { ...value, firstOperation: "hidden replacement" })).rejects.toThrow(/identity/);
    expect(await readdir(root)).toEqual([]);
  });
  it("rejects an invalid phase even with a recomputed identity", async () => {
    const root = await outputRoot(), { identity: _identity, ...body } = diagnostic();
    const changed = { ...body, phase: "unknown" };
    await expect(writeToolboxRouteDiagnostic(root, { ...changed, identity: canonicalIdentity(changed, body.schemaVersion) } as FreshRouteMutationDiagnostic))
      .rejects.toThrow(/phase/);
    expect(await readdir(root)).toEqual([]);
  });
  it("keeps private artifact size bounded without truncating the first cause", async () => {
    const root = await outputRoot(), { identity: _identity, ...body } = diagnostic();
    const changed = { ...body, primary: [{ name: "Error", message: "x".repeat(70_000) }] };
    await expect(writeToolboxRouteDiagnostic(root, { ...changed, identity: canonicalIdentity(changed, body.schemaVersion) })).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });
  it("does not create a missing output root or accept a relative output path", async () => {
    const root = await outputRoot();
    await expect(writeToolboxRouteDiagnostic(path.join(root, "missing"), diagnostic())).rejects.toThrow();
    await expect(writeToolboxRouteDiagnostic(path.relative(process.cwd(), root), diagnostic())).rejects.toThrow(/exact host-owned/);
    expect(await readdir(root)).toEqual([]);
  });
});
