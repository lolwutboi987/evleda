import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import type { FreshFootprintPlacementDiagnostic } from "../../src/harness/kicad-tools.js";
import { writeToolboxFootprintPlacementDiagnostic } from "../../src/mcp/toolbox-footprint-placement-diagnostics.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function outputRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "evleda-placement-diagnostics-"));
  roots.push(root);
  return root;
}
function diagnostic(): FreshFootprintPlacementDiagnostic {
  const captured = (text: string) => ({ status: "captured" as const, text, contentIdentity: contentIdentity(text) });
  const before = "before source " + "b".repeat(100_000);
  const planned = "exact planned source " + "p".repeat(100_000);
  const failed = "failure-time disk source " + "f".repeat(100_000);
  const body = {
    schemaVersion: "evleda.fresh-footprint-placement-diagnostic.v1" as const,
    phase: "primary-failure" as const,
    toolCallId: "toolbox:placement-fixture",
    firstOperation: "pcb_revert",
    primary: { name: "Error", message: "Native reload did not reproduce the planned footprint position." },
    beforePcbContentIdentity: contentIdentity(before), plannedPcbContentIdentity: contentIdentity(planned),
    beforePcb: captured(before), plannedPcb: captured(planned), livePcb: captured("native live source"),
    savedPcbAtFailure: { source: failed, contentIdentity: contentIdentity(failed) },
    nativeResponse: { content: [{ type: "text" as const, text: "Complete native findings " + "n".repeat(12_000) }] },
  };
  return { ...body, identity: canonicalIdentity(body, body.schemaVersion) };
}

describe("private durable footprint-placement first-failure diagnostics", () => {
  it("round trips full source and native findings to exclusive independent artifacts", async () => {
    const root = await outputRoot();
    const value = diagnostic();
    const first = await writeToolboxFootprintPlacementDiagnostic(root, value);
    const second = await writeToolboxFootprintPlacementDiagnostic(root, value);
    expect(first.path).not.toBe(second.path);
    expect(path.dirname(first.path)).toBe(root);
    expect(path.basename(first.path)).toMatch(/^footprint-placement-diagnostic-primary-failure-[a-f0-9-]+\.json$/u);
    const bytes = await readFile(first.path);
    expect(contentIdentity(bytes)).toEqual(first.identity);
    expect(JSON.parse(bytes.toString("utf8"))).toEqual(value);
    expect(await readFile(second.path)).toEqual(bytes);
  });

  it("preserves unavailable reads without inventing source or native evidence", async () => {
    const root = await outputRoot();
    const { identity: _identity, nativeResponse: _response, ...body } = diagnostic();
    const changed = { ...body, livePcb: { status: "unavailable" as const, reason: "Native source read failed." },
      savedPcbAtFailure: { unavailable: "Disk source read failed." } };
    const value = { ...changed, identity: canonicalIdentity(changed, body.schemaVersion) };
    const receipt = await writeToolboxFootprintPlacementDiagnostic(root, value);
    expect(JSON.parse(await readFile(receipt.path, "utf8"))).toEqual(value);
  });

  it("rejects payload tampering, wrong schema, and later phases before reserving any artifact", async () => {
    const root = await outputRoot();
    const value = diagnostic();
    await expect(writeToolboxFootprintPlacementDiagnostic(root, { ...value, firstOperation: "tampered" })).rejects.toThrow(/identity/iu);
    const { identity: _identity, ...body } = value;
    for (const changed of [{ ...body, phase: "after-rollback" }, { ...body, schemaVersion: "unexpected-diagnostic.v1" }]) {
      await expect(writeToolboxFootprintPlacementDiagnostic(root, {
        ...changed, identity: canonicalIdentity(changed, changed.schemaVersion),
      } as FreshFootprintPlacementDiagnostic)).rejects.toThrow(/identity or phase/iu);
    }
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses strings above 1 MiB instead of truncating failure evidence", async () => {
    const root = await outputRoot();
    const { identity: _identity, ...body } = diagnostic();
    const text = "x".repeat(1024 * 1024 + 1);
    const changed = { ...body, livePcb: { status: "captured" as const, text, contentIdentity: contentIdentity(text) } };
    await expect(writeToolboxFootprintPlacementDiagnostic(root, { ...changed, identity: canonicalIdentity(changed, body.schemaVersion) })).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses a complete artifact above 16 MiB even when each individual string fits", async () => {
    const root = await outputRoot();
    const { identity: _identity, ...body } = diagnostic();
    const text = "x".repeat(1024 * 1024);
    const changed = { ...body, nativeResponse: { content: Array.from({ length: 17 }, () => ({ type: "text" as const, text })) } };
    await expect(writeToolboxFootprintPlacementDiagnostic(root, { ...changed, identity: canonicalIdentity(changed, body.schemaVersion) })).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });

  it("requires the existing exact absolute physical host output directory", async () => {
    const root = await outputRoot();
    await expect(writeToolboxFootprintPlacementDiagnostic(path.join(root, "missing"), diagnostic())).rejects.toThrow();
    await expect(writeToolboxFootprintPlacementDiagnostic(path.relative(process.cwd(), root), diagnostic())).rejects.toThrow(/exact host-owned/iu);
    await expect(writeToolboxFootprintPlacementDiagnostic(`${root}${path.sep}.`, diagnostic())).rejects.toThrow(/exact host-owned/iu);
    const file = path.join(root, "ordinary-file");
    await writeFile(file, "preserve");
    await expect(writeToolboxFootprintPlacementDiagnostic(file, diagnostic())).rejects.toThrow(/ordinary directory/iu);
    const actual = path.join(root, "actual");
    const linked = path.join(root, "linked");
    await mkdir(actual);
    await symlink(actual, linked, process.platform === "win32" ? "junction" : "dir");
    await expect(writeToolboxFootprintPlacementDiagnostic(linked, diagnostic())).rejects.toThrow(/exact host-owned/iu);
    expect(await readdir(actual)).toEqual([]);
    expect(await readFile(file, "utf8")).toBe("preserve");
  });
});
