import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  FreshBoardPersistence,
  MAX_FRESH_LIVE_BOARD_BYTES,
  createKicadHarnessTools,
  prepareFreshProject,
  type FreshProject,
  type KicadHarnessSession,
} from "../../src/harness/index.js";

const owned = new Set<string>();
afterEach(async () => { await Promise.all([...owned].map(async (directory) => { await rm(directory, { recursive: true, force: true }); owned.delete(directory); })); });

const insertBoardForm = (source: string, form: string): string => {
  const changed = source.replace(/^\(kicad_pcb(\r?\n)/u, (_match, newline: string) => `(kicad_pcb${newline}\t${form}${newline}`);
  expect(changed).not.toBe(source);
  expect(changed).toContain(form);
  return changed;
};
const changedBoard = (source: string): string => insertBoardForm(source, '(gr_rect (start 0 0) (end 30 20) (layer "Edge.Cuts"))');
const captured = JSON.parse(await readFile(new URL("../fixtures/fresh-project/authored-netclass-board-serialization.json", import.meta.url), "utf8")) as {
  liveUtf8Base64: string; diskUtf8Base64: string; configuredProjectEnvelope: unknown;
};
const capturedLive = Buffer.from(captured.liveUtf8Base64, "base64").toString("utf8");
const capturedDisk = Buffer.from(captured.diskUtf8Base64, "base64");

async function freshBoard(name = "canary6-shape"): Promise<FreshProject> {
  const root = await mkdtemp(path.join(os.tmpdir(), "evleda-durable-board-"));
  owned.add(root);
  return await prepareFreshProject({ outputDir: path.join(root, "output"), name, resume: false });
}

function internalSession(fresh: FreshProject, live: string, active = fresh.pcbPath) {
  return {
    assertActivePcb: async (expected: string) => {
      if (expected !== active) throw new Error("KiCad active PCB path is not the exact isolated fresh board.");
    },
    readActivePcbSource: async (expected: string) => {
      if (expected !== active) throw new Error("KiCad active PCB path is not the exact isolated fresh board.");
      return live;
    },
    callTool: async (name: string) => {
      if (name === "kicad_get_project_info") return { content: [], structuredContent: { result: `Current project configuration:\n- PCB file: ${fresh.pcbPath}` } };
      throw new Error(`Unexpected internal call ${name}`);
    },
  };
}

describe("fresh durable board persistence", () => {
  it("rejects a captured line-ending-only fallback without treating configured project prose as active authority", async () => {
    const fresh = await freshBoard("captured-eol");
    await writeFile(fresh.pcbPath, capturedDisk);
    const persistence = new FreshBoardPersistence(fresh);
    const calls: string[] = [];
    const session = { ...internalSession(fresh, capturedLive), callTool: async (name: string) => { calls.push(name); return captured.configuredProjectEnvelope as never; } };
    await persistence.capturePreMutation(session);
    await expect(persistence.recoverFromLiveBoard(session, "Board saved", "poll failed")).rejects.toThrow(/did not differ/iu);
    expect(await readFile(fresh.pcbPath)).toEqual(capturedDisk);
    expect(calls).toEqual([]);
  });

  it("restores exact captured CRLF disk bytes while accepting the LF native rollback witness", async () => {
    const fresh = await freshBoard("captured-rollback");
    await writeFile(fresh.pcbPath, capturedDisk);
    const persistence = new FreshBoardPersistence(fresh);
    const calls: string[] = [];
    const session = { ...internalSession(fresh, capturedLive), callTool: async (name: string) => { calls.push(name); if (name !== "pcb_revert") throw new Error("Public board/config source must not be consumed"); return { content: [], structuredContent: { result: "Board reverted to disk." } }; } };
    await persistence.capturePreMutation(session);
    await writeFile(fresh.pcbPath, capturedLive.replace("(thickness 1.6)", "(thickness 1.7)"));
    await persistence.rollbackToPreMutation(session);
    expect(await readFile(fresh.pcbPath)).toEqual(capturedDisk);
    expect(calls).toEqual(["pcb_revert"]);
  });

  it("does not count disk line-ending conversion as an authored change or relax the raw concurrent-overwrite check", async () => {
    const fresh = await freshBoard("disk-eol-only");
    await writeFile(fresh.pcbPath, capturedLive);
    const persistence = new FreshBoardPersistence(fresh);
    const session = internalSession(fresh, capturedLive.replace("(thickness 1.6)", "(thickness 1.7)"));
    await persistence.capturePreMutation(session);
    await writeFile(fresh.pcbPath, capturedDisk);
    expect(await persistence.diskChangedSinceCapture()).toBe(false);
    await expect(persistence.recoverFromLiveBoard(session, "Board saved", "poll failed")).rejects.toThrow(/identity or bytes.*concurrent overwrite/iu);
    expect(await readFile(fresh.pcbPath)).toEqual(capturedDisk);
  });

  it("does not discard a disk BOM when comparing the native rollback witness", async () => {
    const fresh = await freshBoard("bom-rollback");
    const before = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), capturedDisk]);
    await writeFile(fresh.pcbPath, before);
    const persistence = new FreshBoardPersistence(fresh);
    const session = { ...internalSession(fresh, capturedLive), callTool: async () => ({ content: [], structuredContent: { result: "Board reverted to disk." } }) };
    await persistence.capturePreMutation(session);
    await expect(persistence.rollbackToPreMutation(session)).rejects.toMatchObject({
      name: "FreshBoardSerializationError", code: "INVALID_TEXT", offset: 0,
    });
    expect(await readFile(fresh.pcbPath)).toEqual(before);
    expect(persistence.hasPendingBoardMutation()).toBe(true);
  });

  it("persists large private raw source without public truncation or path redaction", async () => {
    const fresh = await freshBoard("large-raw");
    const before = await readFile(fresh.pcbPath, "utf8");
    const raw = insertBoardForm(changedBoard(before), `(property "Source" "C:/Private/board/${"A".repeat(70_000)}")`);
    const persistence = new FreshBoardPersistence(fresh);
    const session = internalSession(fresh, raw);
    await persistence.capturePreMutation(session);
    const receipt = await persistence.recoverFromLiveBoard(session, "Board saved", "no native disk write");
    expect(receipt.live.bytes).toBeGreaterThan(65_536);
    expect(await readFile(fresh.pcbPath, "utf8")).toBe(raw);
  });

  it.each(["assertActivePcb", "readActivePcbSource"] as const)("rejects missing private %s before taking a mutation checkpoint", async (method) => {
    const fresh = await freshBoard("missing-port");
    const session: KicadHarnessSession = { ...internalSession(fresh, capturedLive), listTools: () => [] };
    delete session[method];
    const persistence = new FreshBoardPersistence(fresh);
    await expect(persistence.capturePreMutation(session)).rejects.toThrow(/private active-PCB identity and raw-source ports/iu);
    expect(persistence.hasPendingBoardMutation()).toBe(false);
  });

  it("persists the canary6-shaped live board only after an exact fresh-board preimage check", async () => {
    const fresh = await freshBoard();
    const before = await readFile(fresh.pcbPath, "utf8");
    const live = changedBoard(before);
    const persistence = new FreshBoardPersistence(fresh);
    await persistence.capturePreMutation(internalSession(fresh, before));
    const audit = await persistence.recoverFromLiveBoard(internalSession(fresh, live), "{\"result\":\"Board saved\"}", "poll failed");
    expect(await readFile(fresh.pcbPath, "utf8")).toBe(live);
    expect(audit.rawPcbSaveResult).toContain("Board saved");
    expect(audit.before.sha256).not.toBe(audit.live.sha256);
    expect(audit.live).toEqual(audit.after);
    expect((await readdir(path.dirname(fresh.pcbPath))).filter((entry) => entry.includes("evleda-save.tmp"))).toEqual([]);
  });

  it("rejects truncation, oversize, invalid S-expressions, wrong active paths, and concurrent disk drift without overwriting", async () => {
    const fresh = await freshBoard("negative");
    const before = await readFile(fresh.pcbPath, "utf8");
    const live = changedBoard(before);
    const attempt = async (candidate: string, active = fresh.pcbPath, drift?: string) => {
      await writeFile(fresh.pcbPath, before);
      const persistence = new FreshBoardPersistence(fresh);
      await persistence.capturePreMutation(internalSession(fresh, before));
      if (drift !== undefined) await writeFile(fresh.pcbPath, drift);
      await expect(persistence.recoverFromLiveBoard(internalSession(fresh, candidate, active), "Board saved", "poll failed")).rejects.toThrow();
      expect(await readFile(fresh.pcbPath, "utf8")).toBe(drift ?? before);
    };
    await attempt("(kicad_pcb (truncated yes))");
    await attempt(`(kicad_pcb ${" ".repeat(MAX_FRESH_LIVE_BOARD_BYTES)})`);
    await attempt("(kicad_pcb (general)");
    await attempt("(kicad_pcb)");
    const other = path.join(fresh.projectPath, "other.kicad_pcb");
    await writeFile(other, before);
    await attempt(live, other);
    await attempt(live, fresh.pcbPath, "(kicad_pcb (version 20250316) (general))\n");
  });

  it("rejects a file swap injected after initial checks and before temporary-file creation", async () => {
    const fresh = await freshBoard("swap");
    const before = await readFile(fresh.pcbPath, "utf8");
    const live = changedBoard(before);
    const persistence = new FreshBoardPersistence(fresh);
    await persistence.capturePreMutation(internalSession(fresh, before));
    let swapped = false;
    const session = {
      ...internalSession(fresh, live),
      assertActivePcb: async () => {
        if (!swapped) {
          await rename(fresh.pcbPath, `${fresh.pcbPath}.replaced`);
          await writeFile(fresh.pcbPath, before);
          swapped = true;
        }
      },
    };
    await expect(persistence.recoverFromLiveBoard(session, "Board saved", "poll failed")).rejects.toThrow(/identity|changed/i);
    expect(swapped).toBe(true);
    expect(await readFile(fresh.pcbPath, "utf8")).toBe(before);
    expect((await readdir(fresh.projectPath)).filter((entry) => entry.includes("evleda-save.tmp"))).toEqual([]);
  });

  it("rejects a KiCad active-board switch after serialization and a replaced temporary pathname before rename", async () => {
    const fresh = await freshBoard("active-switch");
    const before = await readFile(fresh.pcbPath, "utf8");
    const live = changedBoard(before);
    const other = path.join(fresh.projectPath, "other.kicad_pcb");
    await writeFile(other, before);
    const switched = new FreshBoardPersistence(fresh);
    await switched.capturePreMutation(internalSession(fresh, before));
    let infoCalls = 0;
    await expect(switched.recoverFromLiveBoard({
      ...internalSession(fresh, live),
      assertActivePcb: async () => {
        infoCalls += 1;
        if (infoCalls > 1) throw new Error("KiCad active PCB path switched to another board.");
      },
    }, "Board saved", "poll failed")).rejects.toThrow(/active PCB path/i);
    expect(await readFile(fresh.pcbPath, "utf8")).toBe(before);

    const temporarySwap = new FreshBoardPersistence(fresh);
    await temporarySwap.capturePreMutation(internalSession(fresh, before));
    infoCalls = 0;
    await expect(temporarySwap.recoverFromLiveBoard({
      ...internalSession(fresh, live),
      assertActivePcb: async () => {
        infoCalls += 1;
        if (infoCalls === 3) {
          const temporary = (await readdir(fresh.projectPath)).find((entry) => entry.includes("evleda-save.tmp"));
          if (temporary === undefined) throw new Error("Test could not locate temporary board file.");
          const temporaryPath = path.join(fresh.projectPath, temporary);
          await rename(temporaryPath, `${temporaryPath}.replaced`);
          await writeFile(temporaryPath, live);
        }
      },
    }, "Board saved", "poll failed")).rejects.toThrow(/temporary path changed identity/i);
    expect(await readFile(fresh.pcbPath, "utf8")).toBe(before);
  });

  it("rejects Windows project-root and ancestor junction redirection, including a same-basename source project", async () => {
    if (process.platform !== "win32") return;
    const fresh = await freshBoard("junction");
    const sourceProject = path.join(path.dirname(fresh.outputPath), "source-copy", "project");
    await mkdir(path.dirname(sourceProject), { recursive: true });
    await rename(fresh.projectPath, sourceProject);
    await symlink(sourceProject, fresh.projectPath, "junction");
    await expect(prepareFreshProject({ outputDir: fresh.outputPath, name: fresh.name, resume: true })).rejects.toThrow(/physical|link|canonical/i);

    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-junction-"));
    owned.add(root);
    const actualParent = path.join(root, "actual-parent");
    const linkedParent = path.join(root, "ancestor-junction");
    await mkdir(actualParent);
    await symlink(actualParent, linkedParent, "junction");
    await expect(prepareFreshProject({ outputDir: path.join(linkedParent, "output"), name: "ancestor", resume: false })).rejects.toThrow(/canonical|physical|link/i);
  });

  it("uses the fallback only for a marker-bound fresh bridge and never projects its internal read tools", async () => {
    const fresh = await freshBoard("bridge");
    const source = await readFile(fresh.pcbPath, "utf8");
    const live = changedBoard(source);
    const names = ["pcb_add_track", "pcb_save"];
    const session: KicadHarnessSession = {
      ...internalSession(fresh, live),
      listTools: () => names.map((name) => ({ name, permission: "write" as const, inputSchema: { type: "object" } })),
      callTool: async (name) => {
        if (name === "pcb_save") return { content: [], structuredContent: { result: "Board saved" } };
        return { content: [], structuredContent: { result: "ok" } };
      },
    };
    const bridge = createKicadHarnessTools(session, { freshProject: fresh, verifyPersistedMutation: async () => false });
    await bridge.execute({ id: "mutate", name: "pcb_add_track", arguments: {} });
    const saved = await bridge.internal.saveAfterMutation({ id: "save", name: "pcb_save", arguments: {} });
    expect(saved.isError).toBeUndefined();
    expect(saved.content).toContain("persisted-by-fresh-live-board-fallback");
    expect(bridge.tools.map((tool) => tool.name)).not.toEqual(expect.arrayContaining(["kicad_get_project_info", "pcb_get_board_as_string"]));
    expect(bridge.freshBoardSaveAudits).toHaveLength(1);

    const copied = createKicadHarnessTools(session, { verifyPersistedMutation: async () => false });
    await expect(copied.internal.saveAfterMutation({ id: "copy", name: "pcb_save", arguments: {} })).resolves.toMatchObject({ isError: true });
  });

  it("does not arm board serialization for schematic-only saves, but does for PCB-only and mixed batches", async () => {
    const fresh = await freshBoard("batch-kind");
    const source = await readFile(fresh.pcbPath, "utf8");
    const live = changedBoard(source);
    const calls: string[] = [];
    const names = ["sch_add_symbol", "pcb_add_track", "pcb_save"];
    const session: KicadHarnessSession = {
      ...internalSession(fresh, live),
      listTools: () => names.map((name) => ({ name, permission: "write" as const, inputSchema: { type: "object" } })),
      callTool: async (name) => {
        calls.push(name);
        if (name === "pcb_save") return { content: [], structuredContent: { result: "Board saved" } };
        return { content: [], structuredContent: { result: "ok" } };
      },
    };
    const schematicOnly = createKicadHarnessTools(session, { freshProject: fresh, verifyPersistedMutation: async () => true });
    await schematicOnly.execute({ id: "sch", name: "sch_add_symbol", arguments: { library: "Device", symbol_name: "R", x_mm: 1, y_mm: 1, reference: "R1", value: "1k" } });
    await expect(schematicOnly.internal.saveAfterMutation({ id: "sch-save", name: "pcb_save", arguments: {} })).resolves.toMatchObject({ toolCallId: "sch-save" });
    expect(calls).not.toContain("pcb_get_board_as_string");

    const pcbOnly = createKicadHarnessTools(session, { freshProject: fresh, verifyPersistedMutation: async () => false });
    await pcbOnly.execute({ id: "pcb", name: "pcb_add_track", arguments: {} });
    await expect(pcbOnly.internal.saveAfterMutation({ id: "pcb-save", name: "pcb_save", arguments: {} })).resolves.toMatchObject({ content: expect.stringContaining("persisted-by-fresh-live-board-fallback") });

    await writeFile(fresh.pcbPath, source);
    const mixed = createKicadHarnessTools(session, { freshProject: fresh, verifyPersistedMutation: async () => false });
    await mixed.execute({ id: "mixed-sch", name: "sch_add_symbol", arguments: { library: "Device", symbol_name: "R", x_mm: 2, y_mm: 2, reference: "R1", value: "1k" } });
    await mixed.execute({ id: "mixed-pcb", name: "pcb_add_track", arguments: {} });
    await expect(mixed.internal.saveAfterMutation({ id: "mixed-save", name: "pcb_save", arguments: {} })).resolves.toMatchObject({ content: expect.stringContaining("persisted-by-fresh-live-board-fallback") });
  });
});
