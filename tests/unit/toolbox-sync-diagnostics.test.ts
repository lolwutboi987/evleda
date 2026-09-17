import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import type { FreshSyncFailureDiagnostic } from "../../src/harness/kicad-tools.js";
import { writeToolboxSyncDiagnostic } from "../../src/mcp/toolbox-sync-diagnostics.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function outputRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "evleda-sync-diagnostics-")); roots.push(root); return root;
}
function diagnostic(): FreshSyncFailureDiagnostic {
  const captured = (text: string) => ({ status: "captured" as const, text, contentIdentity: contentIdentity(text) });
  const unavailable = { status: "unavailable" as const, reason: "Normal sync execution did not reach this read." };
  const body = { schemaVersion: "evleda.fresh-sync-failure-diagnostic.v1" as const, phase: "primary-failure" as const,
    stage: "saved-contract-pad-positions", toolCallId: "toolbox:fixture", contractIdentity: canonicalIdentity({}, "fixture-contract"),
    projectBindingIdentity: canonicalIdentity({}, "fixture-project"), freshMarkerContentIdentity: contentIdentity("marker"),
    primary: captured('{"name":"Error","message":"PCB pad U1:5 mapped to the wrong net."}'),
    nativeResponseJson: captured(JSON.stringify({ content: [], structuredContent: { result: "Full native findings " + "x".repeat(12_000) } })),
    beforePcb: captured("before"), savedPcb: captured("changed source " + "y".repeat(100_000)), savedPcbAtFailure: captured("failure-time saved source"), livePcb: unavailable,
    schematicInput: captured("schematic input"), nativeNetlistBefore: captured("native export input"), nativeNetlistAfter: unavailable };
  return { ...body, identity: canonicalIdentity(body, body.schemaVersion) };
}

describe("private durable sync first-failure diagnostics", () => {
  it("retains complete native findings and saved source beyond route diagnostic limits without overwriting", async () => {
    const root = await outputRoot(), value = diagnostic();
    const first = await writeToolboxSyncDiagnostic(root, value), second = await writeToolboxSyncDiagnostic(root, value);
    expect(first.path).not.toBe(second.path);
    expect(path.dirname(first.path)).toBe(root);
    expect(path.basename(first.path)).toMatch(/^sync-diagnostic-primary-failure-[a-f0-9-]+\.json$/);
    const bytes = await readFile(first.path);
    expect(contentIdentity(bytes)).toEqual(first.identity);
    expect(JSON.parse(bytes.toString("utf8"))).toEqual(value);
    expect(await readFile(second.path)).toEqual(bytes);
  });

  it("rejects payload changes and invalid phases before reserving artifacts", async () => {
    const root = await outputRoot(), value = diagnostic();
    await expect(writeToolboxSyncDiagnostic(root, { ...value, stage: "changed" })).rejects.toThrow(/identity/);
    const { identity: _identity, ...body } = value;
    const changed = { ...body, phase: "after-rollback" };
    await expect(writeToolboxSyncDiagnostic(root, { ...changed, identity: canonicalIdentity(changed, body.schemaVersion) } as FreshSyncFailureDiagnostic)).rejects.toThrow(/phase/);
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects oversized text instead of silently dropping source or findings", async () => {
    const root = await outputRoot(), { identity: _identity, ...body } = diagnostic();
    const text = "x".repeat(1024 * 1024 + 1);
    const changed = { ...body, savedPcb: { status: "captured" as const, text, contentIdentity: contentIdentity(text) } };
    await expect(writeToolboxSyncDiagnostic(root, { ...changed, identity: canonicalIdentity(changed, body.schemaVersion) })).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });

  it("requires the existing exact absolute host output directory", async () => {
    const root = await outputRoot();
    await expect(writeToolboxSyncDiagnostic(path.join(root, "missing"), diagnostic())).rejects.toThrow();
    await expect(writeToolboxSyncDiagnostic(path.relative(process.cwd(), root), diagnostic())).rejects.toThrow(/exact host-owned/);
    expect(await readdir(root)).toEqual([]);
  });
});
