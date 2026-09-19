import { link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalIdentity } from "../../src/core/canonical.js";
import { freshBoardSerializationsEqual } from "../../src/harness/fresh-board-serialization.js";
import { captureFreshProjectOpenPreparedSourceAuthority, checkpointFreshProjectOpenNormalization, preparePlaneFreshProject } from "../../src/harness/fresh-project.js";
import { createPcbPlaneCompilationBundle, createPcbPlaneCompilationBundleRef } from "../../src/harness/pcb-design-plane-bundle.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import type { KicadCliAdapter, KicadExecutableIdentity } from "../../src/integrations/kicad-cli.js";
import { captureKicadStartupFailure } from "../../src/integrations/kicad-startup-diagnostic.js";
import { INITIAL_FRESH_SAVE_ERROR_CODES, saveInitialFreshProjectSettings } from "../../src/mcp/toolbox-fresh-initial-save.js";
import { prepareKicadToolboxFreshProject } from "../../src/mcp/toolbox-fresh-preparation.js";
import { createGenericDividerBundleFixture, genericDividerDraft } from "../helpers/generic-divider-bundle.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const savedReply = (): CallToolResult => ({ content: [], structuredContent: { result: "Board saved." } });
const expectStartupCode = (error: unknown, code: number): void => {
  expect(error).toBeInstanceOf(Error); expect(error).toMatchObject({ code });
  expect(Number.isSafeInteger(code)).toBe(true);
  expect(captureKicadStartupFailure(error, "session-connect").failure.cause).toEqual({ category: "native-error", code });
};
const appendBoardForm = (source: string, form: string): string => {
  const closing = source.lastIndexOf(")");
  if (closing < 0) throw new Error("Prepared PCB fixture has no root close.");
  return `${source.slice(0, closing)}\t${form}\n${source.slice(closing)}`;
};

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "toolbox-initial-save-")); roots.push(root);
  const identity: KicadExecutableIdentity = { kind: "kicad-cli", path: path.join(root, "kicad-cli.exe"), version: "10.0.3",
    commit: "146a4f2a7585c65bc580427a19b6fe2ec4a3f622", sha256: "a".repeat(64), sizeBytes: 100,
    capabilityHelpSha256: "b".repeat(64), confirmedCapabilities: ["pcb drc"] };
  const expectedKicadCli = { path: identity.path, contentIdentity: { algorithm: "sha256" as const, digest: identity.sha256, size: identity.sizeBytes },
    operationalVersion: identity.version, operationalCommit: identity.commit, peFileVersion: "10.0.3", peProductVersion: "10.0.3",
    identity: canonicalIdentity({ fixture: true }, "evleda.flux-kicad-cli-binding.v1") };
  const createKicadCliAdapter = vi.fn<typeof KicadCliAdapter.create>().mockResolvedValue({ identity } as KicadCliAdapter);
  const prepared = await prepareKicadToolboxFreshProject({ draft: genericDividerDraft(), originalPrompt: "Build divider",
    outputDir: path.join(root, "output"), name: "divider", dependencies: createGenericDividerBundleFixture().dependencies,
    expectedKicadCli, createKicadCliAdapter });
  if (prepared.status !== "prepared") throw new Error("Initial-save fixture preparation failed.");
  const preparation = prepared.preparation, project = preparation.project;
  const before = await readFile(project.pcbPath), proPath = path.join(project.projectPath, `${project.name}.kicad_pro`);
  let live = before.toString("utf8");
  const order: string[] = [];
  const session = {
    assertActivePcb: vi.fn(async (expected: string) => { expect(expected).toBe(project.pcbPath); order.push("active"); }),
    readActivePcbSource: vi.fn(async (expected: string) => { expect(expected).toBe(project.pcbPath); order.push("live"); return live; }),
    callTool: vi.fn(async (name: string, args?: Readonly<Record<string, unknown>>): Promise<CallToolResult> => {
      expect(name).toBe("pcb_save"); expect(args).toEqual({}); order.push("save"); return savedReply();
    }),
  };
  const input = { project, expectedPreparedSourceAuthority: preparation.preparedSourceAuthority, session };
  const normalize = () => checkpointFreshProjectOpenNormalization({ outputDir: project.outputPath, name: project.name,
    expectedPreparedSourceAuthority: preparation.preparedSourceAuthority,
    expectedNetClassProjection: { netClasses: [...preparation.netClassSemanticAuthority.netClasses],
      contractNetAssignments: [...preparation.netClassSemanticAuthority.contractNetAssignments] } });
  return { project, preparation, before, proPath, input, session, order, normalize, setLive: (source: string) => { live = source; } };
}

describe("fresh toolbox initial native project-settings save", () => {
  it.each(["before-save", "after-save"] as const)("captures the complete %s mismatch without weakening the source guard", async phase => {
    const f = await fixture(), changed = appendBoardForm(f.before.toString("utf8"), '(gr_text "unexpected" (at 1 1) (layer "F.SilkS"))');
    const onSourceMismatch = vi.fn(async () => {});
    if (phase === "before-save") f.setLive(changed);
    else f.session.callTool.mockImplementation(async () => { f.setLive(changed); return savedReply(); });
    const error = await saveInitialFreshProjectSettings({ ...f.input, onSourceMismatch }).catch(value => value);
    expectStartupCode(error, INITIAL_FRESH_SAVE_ERROR_CODES.LIVE_PCB);
    expect(onSourceMismatch).toHaveBeenCalledExactlyOnceWith({ phase, preparedSource: f.before.toString("utf8"), observedLiveSource: changed });
    expect(f.session.callTool).toHaveBeenCalledTimes(phase === "before-save" ? 0 : 1);
    expect(await readFile(f.project.pcbPath)).toEqual(f.before);
  });
  it("retains the native mismatch failure when diagnostic publication fails", async () => {
    const f = await fixture(); f.setLive(appendBoardForm(f.before.toString("utf8"), '(gr_text "unexpected" (at 1 1) (layer "F.SilkS"))'));
    const error = await saveInitialFreshProjectSettings({ ...f.input, onSourceMismatch: async () => { throw new Error("Diagnostic unavailable"); } }).catch(value => value);
    expectStartupCode(error, INITIAL_FRESH_SAVE_ERROR_CODES.LIVE_PCB);
    expect(f.session.callTool).not.toHaveBeenCalled();
  });
  it("pins distinct numeric startup codes for the initial-save failure boundaries", () => {
    expect(INITIAL_FRESH_SAVE_ERROR_CODES).toEqual({ PREPARED_AUTHORITY: 52001, PREPARED_SETTINGS: 52002, PCB_BYTES: 52003,
      SOURCE_INVENTORY: 52004, LIVE_PCB: 52005, ACKNOWLEDGEMENT: 52006, HISTORY_DESTINATION: 52007, HISTORY_SNAPSHOT: 52008 });
  });

  it("accepts a qualified source-equivalent save while preserving exact prepared PCB bytes", async () => {
    const f = await fixture();
    const equivalent = f.before.toString("utf8").replaceAll("\r\n", "\n").replace("(version ", "(version  ");
    expect(equivalent).not.toBe(f.before.toString("utf8"));
    expect(freshBoardSerializationsEqual(equivalent, f.before.toString("utf8"))).toBe(true);
    f.setLive(equivalent);
    await expect(saveInitialFreshProjectSettings(f.input)).resolves.toBeUndefined();
    expect(f.session.assertActivePcb).toHaveBeenCalledWith(f.project.pcbPath);
    expect(f.session.callTool).toHaveBeenCalledExactlyOnceWith("pcb_save", {});
    expect(f.order.indexOf("live")).toBeLessThan(f.order.indexOf("save"));
    expect(f.order.lastIndexOf("live")).toBeGreaterThan(f.order.indexOf("save"));
    expect(await readFile(f.project.pcbPath)).toEqual(f.before);
    await expect(f.normalize()).resolves.toMatchObject({ changed: false });
  });

  it("refuses an unconfirmed active PCB before calling native Save", async () => {
    const f = await fixture(); f.session.assertActivePcb.mockRejectedValue(new Error("active PCB differs"));
    await expect(saveInitialFreshProjectSettings(f.input)).rejects.toThrow("active PCB differs");
    expect(f.session.callTool).not.toHaveBeenCalled();
    expect(await readFile(f.project.pcbPath)).toEqual(f.before);
  });

  it("refuses an unsaved live edit before calling native Save", async () => {
    const f = await fixture();
    f.setLive(appendBoardForm(f.before.toString("utf8"), '(property "unapproved" "live edit")'));
    const error = await saveInitialFreshProjectSettings(f.input).catch(value => value);
    expectStartupCode(error, INITIAL_FRESH_SAVE_ERROR_CODES.LIVE_PCB);
    expect(f.session.callTool).not.toHaveBeenCalled();
    expect(await readFile(f.project.pcbPath)).toEqual(f.before);
  });

  it("rejects saved PCB drift during the awaited live read before native Save dispatch", async () => {
    const f = await fixture(); const original = f.before.toString("utf8");
    const changed = appendBoardForm(original, '(property "external" "preserve changed disk bytes")');
    f.session.readActivePcbSource.mockImplementation(async expected => {
      expect(expected).toBe(f.project.pcbPath);
      await writeFile(f.project.pcbPath, changed, "utf8");
      return original;
    });
    await expect(saveInitialFreshProjectSettings(f.input)).rejects.toThrow();
    expect(f.session.callTool).not.toHaveBeenCalled();
    expect(await readFile(f.project.pcbPath, "utf8")).toBe(changed);
  });

  it("rejects preexisting primary .pro byte changes before native Save", async () => {
    const f = await fixture(); const changed = Buffer.concat([await readFile(f.proPath), Buffer.from("\n")]);
    await writeFile(f.proPath, changed);
    const error = await saveInitialFreshProjectSettings(f.input).catch(value => value);
    expectStartupCode(error, INITIAL_FRESH_SAVE_ERROR_CODES.PREPARED_SETTINGS);
    expect(f.session.callTool).not.toHaveBeenCalled();
    expect(await readFile(f.proPath)).toEqual(changed);
    expect(await readFile(f.project.pcbPath)).toEqual(f.before);
  });

  it("rejects primary .pro drift during the awaited live read before native Save dispatch", async () => {
    const f = await fixture(); const changed = Buffer.concat([await readFile(f.proPath), Buffer.from("\n")]);
    f.session.readActivePcbSource.mockImplementation(async expected => {
      expect(expected).toBe(f.project.pcbPath);
      await writeFile(f.proPath, changed);
      return f.before.toString("utf8");
    });
    const error = await saveInitialFreshProjectSettings(f.input).catch(value => value);
    expectStartupCode(error, INITIAL_FRESH_SAVE_ERROR_CODES.PREPARED_SETTINGS);
    expect(f.session.callTool).not.toHaveBeenCalled();
    expect(await readFile(f.proPath)).toEqual(changed);
    expect(await readFile(f.project.pcbPath)).toEqual(f.before);
  });

  it.each(["schematic", "PCB", "symbol table", "footprint table", "marker"] as const)(
    "refuses changed prepared %s before calling native Save", async target => {
      const f = await fixture();
      const sourcePath = target === "schematic" ? f.project.schematicPath : target === "PCB" ? f.project.pcbPath
        : target === "marker" ? f.project.markerPath : path.join(f.project.projectPath, target === "symbol table" ? "sym-lib-table" : "fp-lib-table");
      await writeFile(sourcePath, Buffer.concat([await readFile(sourcePath), Buffer.from("\n")]));
      const error = await saveInitialFreshProjectSettings(f.input).catch(value => value);
      expectStartupCode(error, INITIAL_FRESH_SAVE_ERROR_CODES.PREPARED_AUTHORITY);
      expect(f.session.callTool).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["Board not saved", { content: [], structuredContent: { result: "Board not saved." } }],
    ["Save skipped", { content: [], structuredContent: { result: "Save skipped." } }],
    ["error result", { isError: true, content: [], structuredContent: { result: "Board saved." } }],
    ["conflicting content", { content: [{ type: "text", text: "Board not saved." }], structuredContent: { result: "Board saved." } }],
    ["missing acknowledgement", { content: [] }],
  ] satisfies [string, CallToolResult][])("rejects %s without admitting the initial save", async (_label, reply) => {
    const f = await fixture(); f.session.callTool.mockResolvedValue(reply);
    const error = await saveInitialFreshProjectSettings(f.input).catch(value => value);
    expect(error).toBeInstanceOf(Error); expect(error.cause).toBe(reply);
    expectStartupCode(error, INITIAL_FRESH_SAVE_ERROR_CODES.ACKNOWLEDGEMENT);
    expect(f.session.callTool).toHaveBeenCalledExactlyOnceWith("pcb_save", {});
    expect(await readFile(f.project.pcbPath)).toEqual(f.before);
  });

  it("propagates native Save failure without retrying or rewriting source", async () => {
    const f = await fixture(); const failure = Object.assign(new Error("native Save failed"), { code: -32603 }); f.session.callTool.mockRejectedValue(failure);
    await expect(saveInitialFreshProjectSettings(f.input)).rejects.toBe(failure);
    expectStartupCode(failure, -32603);
    expect(f.session.callTool).toHaveBeenCalledExactlyOnceWith("pcb_save", {});
    expect(await readFile(f.project.pcbPath)).toEqual(f.before);
  });

  it.each(["source edit", "line endings only"])("rejects exact saved PCB byte drift during Save: %s", async kind => {
    const f = await fixture();
    const original = f.before.toString("utf8");
    const changed = kind === "source edit" ? appendBoardForm(original, '(property "unexpected" "saved edit")')
      : original.includes("\r\n") ? original.replaceAll("\r\n", "\n") : original.replaceAll("\n", "\r\n");
    expect(changed).not.toBe(original);
    if (kind === "line endings only") expect(freshBoardSerializationsEqual(original, changed)).toBe(true);
    f.session.callTool.mockImplementation(async () => {
      await writeFile(f.project.pcbPath, changed, "utf8"); f.setLive(changed); return savedReply();
    });
    await expect(saveInitialFreshProjectSettings(f.input)).rejects.toThrow();
    expect(f.session.callTool).toHaveBeenCalledOnce();
    expect(await readFile(f.project.pcbPath, "utf8")).toBe(changed);
  });

  it.each(["schematic", "symbol table", "footprint table", "marker"] as const)(
    "rejects %s changes made during native Save", async target => {
      const f = await fixture();
      const sourcePath = target === "schematic" ? f.project.schematicPath : target === "marker" ? f.project.markerPath
        : path.join(f.project.projectPath, target === "symbol table" ? "sym-lib-table" : "fp-lib-table");
      const changed = Buffer.concat([await readFile(sourcePath), Buffer.from("\n")]);
      f.session.callTool.mockImplementation(async () => { await writeFile(sourcePath, changed); return savedReply(); });
      await expect(saveInitialFreshProjectSettings(f.input)).rejects.toThrow();
      expect(await readFile(sourcePath)).toEqual(changed);
    },
  );

  it.each(["kicad_sch", "kicad_sym", "kicad_mod", "kicad_dru", "kicad_pcb", "kicad_pro"])(
    "rejects a second native .%s source added during Save", async extension => {
      const f = await fixture(); const addedPath = path.join(f.project.projectPath, `unexpected.${extension}`);
      f.session.callTool.mockImplementation(async () => { await writeFile(addedPath, "unexpected native source\n"); return savedReply(); });
      await expect(saveInitialFreshProjectSettings(f.input)).rejects.toThrow();
      expect(await readFile(addedPath, "utf8")).toBe("unexpected native source\n");
    },
  );

  it.each(["absent", "ordinary empty directory", "ordinary with another native file"])("accepts only a new exact history leaf when .history was %s", async historyParent => {
    const f = await fixture(); const historyDir = path.join(f.project.projectPath, ".history");
    const historyPath = path.join(historyDir, `${f.project.name}.kicad_pcb`);
    const otherPath = path.join(historyDir, "other.kicad_pcb");
    const live = f.before.toString("utf8").replaceAll("\r\n", "\n").replace("(version ", "(version  "); f.setLive(live);
    expect(live).not.toBe(f.before.toString("utf8"));
    expect(freshBoardSerializationsEqual(live, f.before.toString("utf8"))).toBe(true);
    if (historyParent !== "absent") await mkdir(historyDir);
    if (historyParent === "ordinary with another native file") await writeFile(otherPath, f.before);
    f.session.callTool.mockImplementation(async () => {
      await mkdir(historyDir, { recursive: true }); await writeFile(historyPath, live, "utf8"); return savedReply();
    });
    await expect(saveInitialFreshProjectSettings(f.input)).resolves.toBeUndefined();
    expect(f.session.callTool).toHaveBeenCalledExactlyOnceWith("pcb_save", {});
    expect(await readFile(historyPath)).toEqual(Buffer.from(live, "utf8"));
    expect((await lstat(historyPath)).nlink).toBe(1);
    if (historyParent === "ordinary with another native file") expect(await readFile(otherPath)).toEqual(f.before);
    expect(await readFile(f.project.pcbPath)).toEqual(f.before);
  });

  it("accepts the exact LF file snapshot when the verified API representation differs", async () => {
    const f = await fixture(), historyDir = path.join(f.project.projectPath, ".history"), historyPath = path.join(historyDir, `${f.project.name}.kicad_pcb`);
    const fileLf = f.before.toString("utf8").replaceAll("\r\n", "\n"), live = fileLf.replace("(version ", "(version  ");
    f.setLive(live); expect(live).not.toBe(fileLf); expect(freshBoardSerializationsEqual(live, fileLf)).toBe(true);
    f.session.callTool.mockImplementation(async () => { await mkdir(historyDir); await writeFile(historyPath, fileLf, "utf8"); return savedReply(); });
    await expect(saveInitialFreshProjectSettings(f.input)).resolves.toBeUndefined();
    expect(await readFile(historyPath, "utf8")).toBe(fileLf);
    expect(await readFile(f.project.pcbPath)).toEqual(f.before);
  });

  it("rejects a third equivalent history formatting that matches neither exact admitted source", async () => {
    const f = await fixture(), historyDir = path.join(f.project.projectPath, ".history"), historyPath = path.join(historyDir, `${f.project.name}.kicad_pcb`);
    const fileLf = f.before.toString("utf8").replaceAll("\r\n", "\n"), live = fileLf.replace("(version ", "(version  "), third = fileLf.replace("(version ", "(version   ");
    f.setLive(live); expect(freshBoardSerializationsEqual(third, fileLf)).toBe(true);
    f.session.callTool.mockImplementation(async () => { await mkdir(historyDir); await writeFile(historyPath, third, "utf8"); return savedReply(); });
    const error = await saveInitialFreshProjectSettings(f.input).catch(value => value);
    expectStartupCode(error, INITIAL_FRESH_SAVE_ERROR_CODES.HISTORY_SNAPSHOT);
    expect(await readFile(f.project.pcbPath)).toEqual(f.before);
  });

  it.each(["wrong bytes", "wrong line endings", "wrong name", "extra native history source"])(
    "rejects native history output with %s", async kind => {
      const f = await fixture(); const historyDir = path.join(f.project.projectPath, ".history");
      const historyPath = path.join(historyDir, kind === "wrong name" ? "other-board.kicad_pcb" : `${f.project.name}.kicad_pcb`);
      const live = f.before.toString("utf8").replaceAll("\r\n", "\n"); f.setLive(live);
      const written = kind === "wrong bytes" ? appendBoardForm(live, '(property "different" "history")')
        : kind === "wrong line endings" ? live.replaceAll("\n", "\r\n") : live;
      if (kind === "wrong line endings") expect(freshBoardSerializationsEqual(written, live)).toBe(true);
      f.session.callTool.mockImplementation(async () => {
        await mkdir(historyDir); await writeFile(historyPath, written, "utf8");
        if (kind === "extra native history source") await writeFile(path.join(historyDir, "other.kicad_sch"), "extra native source\n");
        return savedReply();
      });
      const error = await saveInitialFreshProjectSettings(f.input).catch(value => value);
      expectStartupCode(error, kind === "wrong name" || kind === "extra native history source"
        ? INITIAL_FRESH_SAVE_ERROR_CODES.SOURCE_INVENTORY : INITIAL_FRESH_SAVE_ERROR_CODES.HISTORY_SNAPSHOT);
      expect(f.session.callTool).toHaveBeenCalledOnce();
      expect(await readFile(historyPath, "utf8")).toBe(written);
      expect(await readFile(f.project.pcbPath)).toEqual(f.before);
    },
  );

  it.each(["identical live bytes", "different bytes"])("rejects a preexisting exact history target containing %s before Save", async kind => {
    const f = await fixture(); const historyDir = path.join(f.project.projectPath, ".history");
    const historyPath = path.join(historyDir, `${f.project.name}.kicad_pcb`);
    const live = f.before.toString("utf8").replaceAll("\r\n", "\n"); f.setLive(live);
    const historyBytes = Buffer.from(kind === "identical live bytes" ? live : "preserve preexisting history\n");
    await mkdir(historyDir); await writeFile(historyPath, historyBytes);
    const error = await saveInitialFreshProjectSettings(f.input).catch(value => value);
    expectStartupCode(error, INITIAL_FRESH_SAVE_ERROR_CODES.HISTORY_DESTINATION);
    expect(f.session.callTool).not.toHaveBeenCalled();
    expect(await readFile(historyPath)).toEqual(historyBytes);
    expect(await readFile(f.project.pcbPath)).toEqual(f.before);
  });

  it("keeps other preexisting native history files under exact source protection", async () => {
    const f = await fixture(); const historyDir = path.join(f.project.projectPath, ".history");
    const historyPath = path.join(historyDir, `${f.project.name}.kicad_pcb`), otherPath = path.join(historyDir, "other.kicad_pcb");
    const live = f.before.toString("utf8").replaceAll("\r\n", "\n"); f.setLive(live);
    await mkdir(historyDir); await writeFile(otherPath, "previous native history\n");
    f.session.callTool.mockImplementation(async () => {
      await writeFile(historyPath, live, "utf8"); await writeFile(otherPath, "preserve changed native history\n"); return savedReply();
    });
    await expect(saveInitialFreshProjectSettings(f.input)).rejects.toThrow();
    expect(f.session.callTool).toHaveBeenCalledOnce();
    expect(await readFile(otherPath, "utf8")).toBe("preserve changed native history\n");
  });

  it("rejects an exact history target introduced during the awaited live read before Save", async () => {
    const f = await fixture(); const historyDir = path.join(f.project.projectPath, ".history");
    const historyPath = path.join(historyDir, `${f.project.name}.kicad_pcb`), live = f.before.toString("utf8");
    await mkdir(historyDir); let introduced = false;
    f.session.readActivePcbSource.mockImplementation(async () => {
      if (!introduced) { await writeFile(historyPath, live, "utf8"); introduced = true; }
      return live;
    });
    await expect(saveInitialFreshProjectSettings(f.input)).rejects.toThrow();
    expect(f.session.callTool).not.toHaveBeenCalled();
    expect(await readFile(historyPath, "utf8")).toBe(live);
  });

  it("rejects an ordinary file at the history-directory path before Save", async () => {
    const f = await fixture(); const historyDir = path.join(f.project.projectPath, ".history");
    await writeFile(historyDir, "preserve ordinary file\n");
    const error = await saveInitialFreshProjectSettings(f.input).catch(value => value);
    expectStartupCode(error, INITIAL_FRESH_SAVE_ERROR_CODES.HISTORY_DESTINATION);
    expect(f.session.callTool).not.toHaveBeenCalled();
    expect(await readFile(historyDir, "utf8")).toBe("preserve ordinary file\n");
  });

  it("rejects a hardlinked history leaf created during native Save", async () => {
    const f = await fixture(); const historyDir = path.join(f.project.projectPath, ".history");
    const historyPath = path.join(historyDir, `${f.project.name}.kicad_pcb`);
    const originalPath = path.join(f.project.outputPath, "history-link-source.kicad_pcb");
    const live = f.before.toString("utf8").replaceAll("\r\n", "\n"); f.setLive(live); await writeFile(originalPath, live);
    f.session.callTool.mockImplementation(async () => { await mkdir(historyDir); await link(originalPath, historyPath); return savedReply(); });
    const error = await saveInitialFreshProjectSettings(f.input).catch(value => value);
    expectStartupCode(error, INITIAL_FRESH_SAVE_ERROR_CODES.HISTORY_SNAPSHOT);
    expect(f.session.callTool).toHaveBeenCalledOnce();
    expect((await lstat(historyPath)).nlink).toBe(2);
    expect(await readFile(historyPath, "utf8")).toBe(live);
    expect(await readFile(originalPath, "utf8")).toBe(live);
  });

  it("rejects a symlinked history leaf created during native Save", async context => {
    const f = await fixture(); const historyDir = path.join(f.project.projectPath, ".history");
    const historyPath = path.join(historyDir, `${f.project.name}.kicad_pcb`);
    const originalPath = path.join(f.project.outputPath, "history-symlink-source.kicad_pcb");
    const probePath = path.join(f.project.outputPath, "history-symlink-probe.kicad_pcb");
    const live = f.before.toString("utf8").replaceAll("\r\n", "\n"); f.setLive(live); await writeFile(originalPath, live);
    try { await symlink(originalPath, probePath, "file"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") { context.skip(); return; } throw error; }
    await unlink(probePath);
    f.session.callTool.mockImplementation(async () => { await mkdir(historyDir); await symlink(originalPath, historyPath, "file"); return savedReply(); });
    const error = await saveInitialFreshProjectSettings(f.input).catch(value => value);
    expectStartupCode(error, INITIAL_FRESH_SAVE_ERROR_CODES.SOURCE_INVENTORY);
    expect(f.session.callTool).toHaveBeenCalledOnce();
    expect((await lstat(historyPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(originalPath, "utf8")).toBe(live);
  });

  it.each(["before Save", "during live read", "during Save"])("rejects a history parent alias introduced %s", async stage => {
    const f = await fixture(); const historyDir = path.join(f.project.projectPath, ".history");
    const originalDir = path.join(f.project.outputPath, "unrelated-history");
    const sentinelPath = path.join(originalDir, "preserve.txt");
    await mkdir(originalDir); await writeFile(sentinelPath, "preserve unrelated directory\n");
    const aliasHistory = () => symlink(originalDir, historyDir, process.platform === "win32" ? "junction" : "dir");
    let introduced = false;
    if (stage === "before Save") await aliasHistory();
    else if (stage === "during live read") f.session.readActivePcbSource.mockImplementation(async () => {
      if (!introduced) { await aliasHistory(); introduced = true; }
      return f.before.toString("utf8");
    });
    else f.session.callTool.mockImplementation(async () => { await aliasHistory(); return savedReply(); });
    const error = await saveInitialFreshProjectSettings(f.input).catch(value => value);
    expectStartupCode(error, stage === "during Save" ? INITIAL_FRESH_SAVE_ERROR_CODES.HISTORY_SNAPSHOT
      : INITIAL_FRESH_SAVE_ERROR_CODES.HISTORY_DESTINATION);
    expect(f.session.callTool).toHaveBeenCalledTimes(stage === "during Save" ? 1 : 0);
    expect((await lstat(historyDir)).isSymbolicLink()).toBe(true);
    expect(await realpath(historyDir)).toBe(await realpath(originalDir));
    expect(await readFile(sentinelPath, "utf8")).toBe("preserve unrelated directory\n");
    expect(await readFile(f.project.pcbPath)).toEqual(f.before);
  });

  it.each(["before", "during"])("rejects generated plane rules changed %s native Save", async stage => {
    const root = await mkdtemp(path.join(tmpdir(), "toolbox-initial-plane-save-")); roots.push(root);
    const dependencies = createGenericDividerBundleFixture().dependencies;
    const compilation = compilePcbPlaneDesignIntentDraft(planeDividerDraft(), dependencies);
    if (compilation.disposition !== "ready") throw new Error("Initial-save plane fixture compilation failed.");
    const bundle = createPcbPlaneCompilationBundle({ originalPrompt: "Initial-save plane rules fixture", compilation }, dependencies);
    const project = await preparePlaneFreshProject({ outputDir: path.join(root, "output"), name: "plane-save", resume: false,
      compilationBundle: bundle, compilationBundleRef: createPcbPlaneCompilationBundleRef(bundle) });
    const expectedPreparedSourceAuthority = await captureFreshProjectOpenPreparedSourceAuthority(project);
    const board = await readFile(project.pcbPath, "utf8"), rules = await readFile(project.rulesPath, "utf8");
    const changeRules = () => writeFile(project.rulesPath, `${rules}\n`);
    const session = {
      assertActivePcb: vi.fn(async (expected: string) => { expect(expected).toBe(project.pcbPath); }),
      readActivePcbSource: vi.fn(async () => board),
      callTool: vi.fn(async () => { await changeRules(); return savedReply(); }),
    };
    if (stage === "before") await changeRules();
    await expect(saveInitialFreshProjectSettings({ project, expectedPreparedSourceAuthority, session })).rejects.toThrow();
    expect(session.callTool).toHaveBeenCalledTimes(stage === "before" ? 0 : 1);
    expect(await readFile(project.rulesPath, "utf8")).toBe(`${rules}\n`);
  });

  it("permits primary .pro changes while the existing normalizer admits their semantics", async () => {
    const f = await fixture(); const beforePro = await readFile(f.proPath, "utf8");
    const candidate = JSON.parse(beforePro);
    candidate.net_settings.classes.reverse(); candidate.net_settings.netclass_patterns.reverse(); candidate.net_settings.netclass_assignments = null;
    f.session.callTool.mockImplementation(async () => { await writeFile(f.proPath, JSON.stringify(candidate, null, 4)); return savedReply(); });
    await expect(saveInitialFreshProjectSettings(f.input)).resolves.toBeUndefined();
    expect(await readFile(f.proPath, "utf8")).not.toBe(beforePro);
    expect(await readFile(f.project.pcbPath)).toEqual(f.before);
    await expect(f.normalize()).resolves.toMatchObject({ changed: true });
  });

  it("leaves semantic .pro drift for the existing normalizer to reject", async () => {
    const f = await fixture(); const candidate = JSON.parse(await readFile(f.proPath, "utf8"));
    candidate.board.design_settings.rules.min_track_width = 0.4;
    f.session.callTool.mockImplementation(async () => { await writeFile(f.proPath, JSON.stringify(candidate)); return savedReply(); });
    await expect(saveInitialFreshProjectSettings(f.input)).resolves.toBeUndefined();
    await expect(f.normalize()).rejects.toThrow(/non-net-settings drift/i);
  });

  it("rejects live layer drift observed after a qualified Save with unchanged disk bytes", async () => {
    const f = await fixture(); const changed = f.before.toString("utf8").replace('"B.Cu"', '"In1.Cu"');
    expect(changed).not.toBe(f.before.toString("utf8"));
    f.session.callTool.mockImplementation(async () => { f.setLive(changed); return savedReply(); });
    await expect(saveInitialFreshProjectSettings(f.input)).rejects.toThrow();
    expect(f.session.callTool).toHaveBeenCalledOnce();
    expect(await readFile(f.project.pcbPath)).toEqual(f.before);
  });
});
