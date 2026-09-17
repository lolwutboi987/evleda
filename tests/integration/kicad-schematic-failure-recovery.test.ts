import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as filesystem from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KicadMcpOutputError, type KicadMcpSession } from "../../src/integrations/kicad-mcp-session.js";
import { createSchematicFailureSession, schematicFailureReply } from "../helpers/schematic-failure-session.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual };
});

const roots: string[] = [], sessions: KicadMcpSession[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const session of sessions.splice(0)) await session.close();
  const base = path.resolve(tmpdir());
  for (const root of roots.splice(0)) {
    const relative = path.relative(base, path.resolve(root));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Fixture escaped its owned temporary root.");
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
async function fixture(options: Partial<Parameters<typeof createSchematicFailureSession>[0]> = {}) {
  const workspace = await mkdtemp(path.join(tmpdir(), "evleda-schematic-failure-")); roots.push(workspace);
  const project = path.join(workspace, "project"), boardFile = path.join(project, "board.kicad_pcb");
  await mkdir(project); await writeFile(boardFile, "(kicad_pcb)\n", "utf8");
  const peer = await createSchematicFailureSession({ ...options, workspace, project, boardFile });
  sessions.push(peer.session); return { ...peer, boardFile };
}

describe("completed schematic tool-negative recovery", () => {
  it("retains the exact private returned failure, fences edits, and keeps checked reads available until explicit close", async () => {
    const f = await fixture(), close = vi.spyOn(f.session, "close");
    const error = await f.session.callTool("sch_autoplace_fields").catch((error: unknown) => error);
    expect(error).toBeInstanceOf(KicadMcpOutputError);
    expect((error as Error).cause).toEqual({ operation: "sch_autoplace_fields", response: schematicFailureReply });
    expect(String(error)).not.toMatch(/Unsupported|synthetic-private-test-token|C:/iu);
    expect(JSON.stringify(error)).not.toMatch(/Unsupported|synthetic-private-test-token|C:/iu);
    expect(close).not.toHaveBeenCalled();
    expect(await f.session.readActivePcbSource(f.boardFile)).toBe("(kicad_pcb)\n");
    await expect(f.session.callTool("sch_get_symbols")).resolves.toHaveProperty("structuredContent");
    for (const name of ["sch_autoplace_fields", "pcb_save", "pcb_revert"]) {
      await expect(f.session.callTool(name)).rejects.toThrow(/writes are quarantined/iu);
    }
    expect(f.session.supportsNativeRouteTransactions()).toBe(false);
    expect(f.session.supportsQualifiedFootprintIdentitySync()).toBe(false);
    expect(f.session.supportsSchematicConnectivityBatch()).toBe(false);
    await f.session.assertActivePcb(f.boardFile);
    await f.session.close();
    await expect(f.session.callTool("sch_get_symbols")).rejects.toThrow(/closed/iu);
    expect(await f.calls()).toEqual(["sch_autoplace_fields", "evleda_get_live_pcb_document", "sch_get_symbols", "evleda_get_live_pcb_document"]);
  });

  it("keeps normal close available when an optional recovery read also returns a qualified application negative", async () => {
    const f = await fixture({ readToolFailure: true });
    await expect(f.session.callTool("sch_autoplace_fields")).rejects.toBeInstanceOf(KicadMcpOutputError);
    const error = await f.session.callTool("sch_get_symbols").catch((error: unknown) => error);
    expect((error as Error).cause).toEqual({ operation: "sch_get_symbols", response: schematicFailureReply });
    await f.session.assertActivePcb(f.boardFile);
    await expect(f.session.callTool("pcb_save")).rejects.toThrow(/quarantined/iu);
    await f.session.close();
  });

  it.each(["rpc", "transport", "malformed", "hang", "protocol-negative"] as const)("keeps %s faults terminal, without retaining a write or read channel", async failure => {
    const f = await fixture({ failure });
    const error = await f.session.callTool("sch_autoplace_fields").catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    await expect(f.session.readActivePcbSource(f.boardFile)).rejects.toThrow(/closed/iu);
    await expect(f.session.callTool("pcb_save")).rejects.toThrow(/closed/iu);
    expect(await f.calls()).toEqual(["sch_autoplace_fields"]);
    if (failure === "protocol-negative") {
      expect(((error as Error).cause as Error).cause).toEqual({ operation: "sch_autoplace_fields", response: schematicFailureReply });
    }
  });

  it.each(["document", "transport"] as const)("fails closed when a recovery read finds %s uncertainty", async liveFailure => {
    const f = await fixture({ liveFailure });
    const primary = await f.session.callTool("sch_autoplace_fields").catch((error: unknown) => error);
    await expect(f.session.assertActivePcb(f.boardFile)).rejects.toThrow();
    await expect(f.session.callTool("sch_get_symbols")).rejects.toThrow(/closed/iu);
    expect((primary as Error).cause).toEqual({ operation: "sch_autoplace_fields", response: schematicFailureReply });
  });

  it("keeps launcher authorization failures terminal while preserving the original negative reply", async () => {
    const f = await fixture();
    const originalAccess = filesystem.access; let checks = 0;
    vi.spyOn(filesystem, "access").mockImplementation(async (...args) => {
      if (args[0] === process.execPath && ++checks === 2) throw new Error("synthetic executable authorization failure");
      await originalAccess(...args);
    });
    const error = await f.session.callTool("sch_autoplace_fields").catch((error: unknown) => error);
    expect(String(error)).toContain("recovery connection integrity could not be confirmed");
    expect(((error as Error).cause as Error).cause).toEqual({ operation: "sch_autoplace_fields", response: schematicFailureReply });
    await expect(f.session.readActivePcbSource(f.boardFile)).rejects.toThrow(/closed/iu);
    expect(await f.calls()).toEqual(["sch_autoplace_fields"]);
  });

  it("fences another edit while post-reply runtime qualification is still pending", async () => {
    const f = await fixture();
    const originalAccess = filesystem.access; let checks = 0, release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(filesystem, "access").mockImplementation(async (...args) => {
      if (args[0] === process.execPath && ++checks === 2) await pending;
      await originalAccess(...args);
    });
    const failed = f.session.callTool("sch_autoplace_fields").catch((error: unknown) => error);
    try {
      await vi.waitFor(() => expect(checks).toBe(2));
      await expect(f.session.callTool("pcb_save")).rejects.toThrow(/quarantined/iu);
    } finally { release(); }
    expect(await failed).toBeInstanceOf(KicadMcpOutputError);
    expect(await f.calls()).toEqual(["sch_autoplace_fields"]);
  });

  it("rejects an over-limit native response without retaining an unbounded payload or recovery channel", async () => {
    const f = await fixture({ reply: { isError: true, content: [{ type: "text", text: "x".repeat(40_000) }] } });
    const error = await f.session.callTool("sch_autoplace_fields").catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(JSON.stringify(error).length).toBeLessThan(4096);
    await expect(f.session.readActivePcbSource(f.boardFile)).rejects.toThrow(/closed/iu);
  });

  it("retains the original returned cause even if terminal teardown also rejects", async () => {
    const f = await fixture({ failure: "protocol-negative" });
    const close = vi.spyOn(f.session, "close").mockRejectedValue(new Error("synthetic cleanup failure"));
    const error = await f.session.callTool("sch_autoplace_fields").catch((error: unknown) => error);
    expect(close).toHaveBeenCalledOnce();
    expect(String(error)).toContain("recovery connection integrity could not be confirmed");
    expect(((error as Error).cause as Error).cause).toEqual({ operation: "sch_autoplace_fields", response: schematicFailureReply });
    expect(String(error)).not.toContain("synthetic cleanup failure");
    close.mockRestore();
  });
});
