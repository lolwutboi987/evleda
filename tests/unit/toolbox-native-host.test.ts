import { access, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FluxPcbEditorLauncher } from "../../src/flux/pcb-editor-launcher.js";
import type { KicadToolboxNativeHostInput } from "../../src/mcp/toolbox-native-host.js";

const seams = vi.hoisted(() => ({ launch: vi.fn(), open: vi.fn(), fingerprint: vi.fn(), locks: vi.fn() }));
vi.mock("../../src/mcp/toolbox-owned-editor-locks.js", () => ({ preflightOwnedEditorLocks: seams.locks }));
vi.mock("../../src/cli/pcb-agent.js", () => ({ nativeProjectFingerprint: seams.fingerprint }));
vi.mock("../../src/flux/pcb-editor-launcher.js", () => ({ launchFluxPcbEditor: seams.launch, defaultFluxPcbEditorLauncher: vi.fn() }));
vi.mock("../../src/mcp/toolbox-session.js", () => ({ openKicadToolboxSession: seams.open }));
vi.mock("../../src/harness/kicad-tools.js", () => ({ KICAD_HARNESS_TOOL_NAMES: ["pcb_save", "kicad_set_project"] }));
import { openKicadToolboxNativeHost } from "../../src/mcp/toolbox-native-host.js";
import { bindKicadStartupEvidence, captureKicadStartupFailure } from "../../src/integrations/kicad-startup-diagnostic.js";
import { KicadMcpTerminationUncertainError } from "../../src/integrations/kicad-mcp-session.js";
import { writeToolboxStartupDiagnostic } from "../../src/mcp/toolbox-startup-diagnostics.js";
import type { FreshSchematicFieldCloseOutcome } from "../../src/harness/fresh-schematic-field-diagnostics.js";
import { createSchematicFailureSession, schematicFailureReply } from "../helpers/schematic-failure-session.js";

const roots: string[] = [];
afterEach(async () => { vi.resetAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "evleda-toolbox-native-"));
  roots.push(root);
  const sourceRoot = path.join(root, "source");
  const outputRoot = path.join(root, "output");
  const projectRoot = path.join(outputRoot, "working-project");
  await mkdir(sourceRoot);
  await mkdir(projectRoot, { recursive: true });
  const pcbPath = path.join(projectRoot, "board.kicad_pcb");
  await writeFile(pcbPath, "(kicad_pcb)");
  const order: string[] = [];
  let finish!: () => void;
  const exited = new Promise<{ code: number; signal: null }>(resolve => { finish = () => resolve({ code: 0, signal: null }); });
  const waitUntilReady = vi.fn().mockResolvedValue(undefined);
  const launcher = vi.fn().mockResolvedValue({ pid: 9876, exited, waitUntilReady });
  const terminate = vi.fn().mockImplementation(async (_pid: number, _binding: unknown, observed: () => boolean) => {
    expect(observed()).toBe(false); order.push("terminate"); finish(); await exited; return true;
  });
  const disposeUnused = vi.fn().mockResolvedValue("disposed");
  const authority = { disposeUnused };
  const socket = { endpoint: `ipc://${path.join(root, "absent-api.sock")}` };
  const runtime = {
    identity: { test: "runtime" }, allocateIpcSocket: vi.fn().mockResolvedValue(socket),
    getEditorLaunchContext: vi.fn().mockResolvedValue({}), assertCurrent: vi.fn(), assertIpcSocket: vi.fn(),
    bindSession: vi.fn().mockResolvedValue(authority),
    releaseIpcSocket: vi.fn().mockImplementation(async () => { order.push("release"); return "released"; }),
  };
  const connected = { tools: {}, assertCurrent: vi.fn(), captureSources: vi.fn(), close: vi.fn().mockImplementation(async () => { order.push("cad-close"); }) };
  const locks = { capture: vi.fn().mockImplementation(async () => {
    expect(connected.assertCurrent).toHaveBeenCalled();
  }), refresh: vi.fn(), release: vi.fn().mockImplementation(async () => {
    expect(seams.locks.mock.calls[0]![0].isEditorTeardownConfirmed()).toBe(true);
    order.push("locks-release");
  }) };
  seams.locks.mockResolvedValue(locks);
  seams.open.mockResolvedValue(connected);
  seams.fingerprint.mockResolvedValue("before");
  seams.launch.mockImplementation(async (_suite: unknown, board: string, _context: unknown, ownedLauncher: FluxPcbEditorLauncher, before: () => Promise<void>) => {
    await before(); return await ownedLauncher({ executablePath: "host-owned", boardPath: board, environment: {} });
  });
  const input = { runtime, suite: {}, prepared: { sourceProjectPath: sourceRoot, isolatedProjectPath: projectRoot,
    outputPath: outputRoot, reportPath: path.join(outputRoot, "report.json") }, pcbPath, termination: {}, environment: {} } as unknown as KicadToolboxNativeHostInput;
  const dependencies = { launcher, terminate };
  return { input, dependencies, runtime, connected, order, finish, disposeUnused, socket, locks, waitUntilReady };
}

describe("native toolbox host composition", () => {
  it("records field close only after the exact graceful editor exit, sidecar close and owned cleanup", async () => {
    const f = await fixture();
    const launched = await f.dependencies.launcher({ executablePath: "host-owned", boardPath: f.input.pcbPath, environment: {} });
    const requestClose = vi.fn(async () => { f.order.push("request-close"); });
    f.dependencies.launcher.mockResolvedValue({ ...launched, requestClose } as typeof launched);
    const finalize = vi.fn(async (outcome: FreshSchematicFieldCloseOutcome) => {
      f.order.push("field-close-record");
      expect(outcome).toEqual({ nativeEditorTeardown: "confirmed", sidecarTeardown: "confirmed", ownedHostCleanup: "confirmed", checkpoint: "not-observed" });
    });
    Object.assign(f.connected, { finalizeSchematicFieldFailure: finalize });
    const host = await openKicadToolboxNativeHost(f.input, f.dependencies);
    const closing = host.close();
    await vi.waitFor(() => expect(requestClose).toHaveBeenCalledOnce());
    expect(finalize).not.toHaveBeenCalled();
    expect(f.connected.close).not.toHaveBeenCalled();
    f.finish(); await closing;
    expect(f.order).toEqual(["request-close", "cad-close", "locks-release", "release", "field-close-record"]);
    expect(f.dependencies.terminate).not.toHaveBeenCalled();
    await host.close(); expect(finalize).toHaveBeenCalledOnce();
  });

  it.each(["editor", "sidecar"] as const)("keeps %s teardown uncertainty separate and preserves cleanup failure if diagnostics reject", async failure => {
    const f = await fixture();
    if (failure === "editor") f.dependencies.terminate.mockResolvedValue(false);
    else f.connected.close.mockRejectedValue(new Error("sidecar teardown uncertain"));
    const finalize = vi.fn(async (outcome: FreshSchematicFieldCloseOutcome) => {
      expect(outcome).toEqual({ nativeEditorTeardown: failure === "editor" ? "unconfirmed" : "confirmed",
        sidecarTeardown: failure === "sidecar" ? "unconfirmed" : "confirmed", ownedHostCleanup: "unconfirmed", checkpoint: "not-observed" });
      throw new Error("private diagnostic writer failure");
    });
    Object.assign(f.connected, { finalizeSchematicFieldFailure: finalize });
    const host = await openKicadToolboxNativeHost(f.input, f.dependencies);
    const error = await host.close().catch(error => error as AggregateError);
    expect(error).toBeInstanceOf(AggregateError);
    expect(String(error)).toContain("cleanup was not confirmed");
    expect((error as AggregateError).errors).toHaveLength(1);
    expect(String((error as AggregateError).errors[0])).not.toContain("diagnostic");
    expect(finalize).toHaveBeenCalledOnce();
    expect(f.runtime.releaseIpcSocket).not.toHaveBeenCalled();
    f.finish();
  });

  it("awaits captured editor readiness before allocating or connecting MCP authority", async () => {
    const f = await fixture(); let ready!: () => void;
    f.waitUntilReady.mockImplementation(() => new Promise<void>(resolve => { ready = resolve; }));
    const opening = openKicadToolboxNativeHost(f.input, f.dependencies);
    await vi.waitFor(() => expect(f.waitUntilReady).toHaveBeenCalledOnce());
    expect(f.dependencies.launcher).toHaveBeenCalledOnce(); expect(f.runtime.bindSession).not.toHaveBeenCalled(); expect(seams.open).not.toHaveBeenCalled();
    ready(); const host = await opening;
    expect(f.runtime.bindSession).toHaveBeenCalledOnce(); expect(seams.open).toHaveBeenCalledOnce(); await host.close();
  });
  it("preserves readiness failure evidence and closes only the captured owner without connecting MCP", async () => {
    const f = await fixture();
    const details = { code: "DEADLINE" as const, stage: "version" as const, attempts: 3, elapsedMs: 30000, nativeCode: 4,
      firstFailure: { code: "NOT_READY" as const, stage: "version" as const, attempt: 1, nativeCode: 4 } };
    f.waitUntilReady.mockRejectedValue(bindKicadStartupEvidence(new Error("private readiness error"), {
      failure: { stage: "editor-readiness", cause: { category: "native-error", code: 4, editorReadiness: details }, stderr: null }, cleanup: [] }));
    const launched = await f.dependencies.launcher({ executablePath: "host-owned", boardPath: f.input.pcbPath, environment: {} });
    const requestClose = vi.fn(async () => { f.finish(); });
    f.dependencies.launcher.mockResolvedValue({ ...launched, requestClose, detach: vi.fn() });
    const error = await openKicadToolboxNativeHost(f.input, f.dependencies).catch(value => value);
    expect(error.cause.failure).toMatchObject({ stage: "editor-readiness", cause: { code: 4, editorReadiness: details } });
    expect(f.runtime.bindSession).not.toHaveBeenCalled(); expect(seams.open).not.toHaveBeenCalled(); expect(requestClose).toHaveBeenCalledOnce();
    expect(f.dependencies.terminate).not.toHaveBeenCalled(); expect(f.runtime.releaseIpcSocket).toHaveBeenCalledOnce();
  });
  it("refuses launchers without an explicit owned readiness witness", async () => {
    const f = await fixture();
    const launched = await f.dependencies.launcher({ executablePath: "host-owned", boardPath: f.input.pcbPath, environment: {} });
    f.dependencies.launcher.mockResolvedValue({ ...launched, waitUntilReady: undefined });
    const error = await openKicadToolboxNativeHost(f.input, f.dependencies).catch(value => value);
    expect(error.cause.failure.stage).toBe("editor-readiness");
    expect(f.runtime.bindSession).not.toHaveBeenCalled(); expect(seams.open).not.toHaveBeenCalled();
  });
  it("writes the first startup cause before cleanup and retains it when cleanup fails", async () => {
    const f = await fixture();
    const primary = captureKicadStartupFailure(Object.assign(new Error("sk-primary-token"), { code: "ECONNREFUSED" }), "mcp-handshake", { category: "present", truncated: false, seenBytes: 149 });
    seams.open.mockRejectedValue(bindKicadStartupEvidence(new Error("private wrapper"), primary));
    const order: string[] = [];
    f.disposeUnused.mockImplementation(async () => { order.push("cleanup"); throw Object.assign(new Error("sk-cleanup-token"), { code: "EPERM" }); });
    const writeStartupDiagnostic = vi.fn(async (...args: Parameters<typeof writeToolboxStartupDiagnostic>) => {
      order.push(args[1].phase); return writeToolboxStartupDiagnostic(...args);
    });
    const error = await openKicadToolboxNativeHost(f.input, { ...f.dependencies, writeStartupDiagnostic }).catch(value => value);
    expect(error).toBeInstanceOf(KicadMcpTerminationUncertainError);
    expect(error.retainRuntimeDirectory).toBe(true);
    expect(order).toEqual(["primary-failure", "cleanup", "cleanup-finished"]);
    expect(error.cause.failure).toEqual(primary.failure);
    expect(error.cause.cleanup).toEqual([{ stage: "host-cleanup", status: "unconfirmed", cause: { category: "native-error" } }]);
    const artifact = error.cause.diagnostics.primary;
    expect(JSON.parse(await readFile(path.join(f.input.prepared.outputPath, artifact.filename), "utf8")).failure).toEqual(primary.failure);
    expect(inspect(error, { depth: 8 })).not.toMatch(/sk-primary|sk-cleanup|private wrapper/);
    expect(f.runtime.releaseIpcSocket).not.toHaveBeenCalled();
  });

  it("keeps the primary stage when diagnostic publication fails without invoking foreign getters", async () => {
    const f = await fixture(); let invoked = 0;
    const primary = new Error("sk-secret-primary");
    Object.defineProperty(primary, "message", { get: () => { invoked++; return "sk-getter-secret"; } });
    Object.defineProperty(primary, inspect.custom, { value: () => { invoked++; return "sk-inspect-secret"; } });
    seams.open.mockRejectedValue(primary);
    const writeStartupDiagnostic = vi.fn().mockRejectedValue(new Error("sk-write-secret"));
    const error = await openKicadToolboxNativeHost(f.input, { ...f.dependencies, writeStartupDiagnostic }).catch(value => value);
    expect(error.message).toContain("Stage: session-connect");
    expect(error.cause.failure).toEqual({ stage: "session-connect", cause: { category: "native-error" }, stderr: null });
    expect(error.cause.diagnostics).toMatchObject({ primaryWriteFailed: true, finalWriteFailed: true });
    expect(f.runtime.releaseIpcSocket).toHaveBeenCalledOnce();
    expect(inspect(error, { depth: 8 })).not.toContain("sk-");
    expect(invoked).toBe(0);
  });

  it("preserves typed runtime uncertainty even when host cleanup confirms", async () => {
    const f = await fixture(); seams.open.mockRejectedValue(new KicadMcpTerminationUncertainError("sk-private-uncertainty"));
    const error = await openKicadToolboxNativeHost(f.input, f.dependencies).catch(value => value);
    expect(error).toBeInstanceOf(KicadMcpTerminationUncertainError);
    expect(error.retainRuntimeDirectory).toBe(true);
    expect(error.cause.failure.cause.category).toBe("kicad-termination-uncertain");
    expect(inspect(error, { depth: 8 })).not.toContain("sk-private");
  });
  it("forwards the owning session's endpoint assessment without replacing its evidence", async () => {
    const f = await fixture(), result = { report: { status: "partially-connected" }, diagnostic: { filename: "owned.json" } };
    const checkEndpointConnectivity = vi.fn(async () => result);
    seams.open.mockResolvedValue({ ...f.connected, checkEndpointConnectivity });
    const host = await openKicadToolboxNativeHost(f.input, f.dependencies);
    try {
      expect(await host.checkEndpointConnectivity!()).toBe(result);
      expect(checkEndpointConnectivity).toHaveBeenCalledWith();
    } finally { await host.close(); }
  });

  it("exposes saved reference coverage only with a host calculator and binds the exact opened PCB", async () => {
    const f = await fixture();
    const calculate = vi.fn();
    const host = await openKicadToolboxNativeHost({ ...f.input, referenceCoverage: { calculate } }, f.dependencies);
    try {
      expect(host.checkReferenceCoverage).toBeTypeOf("function");
      const result = await host.checkReferenceCoverage!({ signalNets: ["SIG"], signalLayer: "F.Cu", referenceNet: "GND", referenceLayer: "B.Cu",
        marginNm: 100000, marginBasis: "Explicit synthetic geometry-test margin, not an electrical approval" });
      expect(result).toMatchObject({ status: "not_assessed", evidenceStatus: { fillFreshness: "unverified_saved_cache", impedance: "not_evaluated" } });
      expect(calculate).not.toHaveBeenCalled();
    } finally { await host.close(); }
  });

  it("lets the exact owned editor close its own locks without a numeric termination fallback", async () => {
    const f = await fixture(); const requestClose = vi.fn().mockImplementation(async () => { f.order.push("graceful"); f.finish(); });
    const launched = await f.dependencies.launcher({ executablePath: "host-owned", boardPath: f.input.pcbPath, environment: {} });
    f.dependencies.launcher.mockResolvedValue({ ...launched, requestClose, detach: vi.fn() });
    const host = await openKicadToolboxNativeHost(f.input, f.dependencies);
    expect(host.checkReferenceCoverage).toBeUndefined(); await host.close();
    expect(f.order).toEqual(["graceful", "cad-close", "locks-release", "release"]);
    expect(f.dependencies.terminate).not.toHaveBeenCalled(); expect(f.locks.refresh).not.toHaveBeenCalled();
  });

  it("reaches ordinary owned editor close after a real qualified schematic negative and checked active-document read", async () => {
    const f = await fixture();
    const { session, calls } = await createSchematicFailureSession({ workspace: f.input.prepared.outputPath,
      project: f.input.prepared.isolatedProjectPath, boardFile: f.input.pcbPath });
    f.connected.assertCurrent.mockImplementation(async () => {
      await session.assertActivePcb(f.input.pcbPath); f.order.push("checked-current");
    });
    f.connected.close.mockImplementation(async () => { f.order.push("cad-close"); await session.close(); });
    const requestClose = vi.fn(async () => { f.order.push("graceful"); f.finish(); });
    const detach = vi.fn();
    const launched = await f.dependencies.launcher({ executablePath: "host-owned", boardPath: f.input.pcbPath, environment: {} });
    f.dependencies.launcher.mockResolvedValue({ ...launched, requestClose, detach });
    try {
      const host = await openKicadToolboxNativeHost(f.input, f.dependencies);
      const error = await session.callTool("sch_autoplace_fields").catch((error: unknown) => error);
      expect((error as Error).cause).toEqual({ operation: "sch_autoplace_fields", response: schematicFailureReply });
      await expect(session.callTool("pcb_save")).rejects.toThrow(/quarantined/iu);
      f.order.length = 0;
      await host.close();
      expect(f.order).toEqual(["checked-current", "graceful", "cad-close", "locks-release", "release"]);
      expect(await calls()).toEqual(["evleda_get_live_pcb_document", "sch_autoplace_fields", "evleda_get_live_pcb_document"]);
      expect(requestClose).toHaveBeenCalledOnce(); expect(detach).not.toHaveBeenCalled();
      expect(f.dependencies.terminate).not.toHaveBeenCalled();
    } finally { f.finish(); await session.close(); }
  });

  it("refuses graceful close when the retained read channel finds a changed document", async () => {
    const f = await fixture();
    const { session } = await createSchematicFailureSession({ workspace: f.input.prepared.outputPath,
      project: f.input.prepared.isolatedProjectPath, boardFile: f.input.pcbPath, liveFailure: "document" });
    f.connected.assertCurrent.mockImplementation(() => session.assertActivePcb(f.input.pcbPath));
    f.connected.close.mockImplementation(() => session.close());
    const requestClose = vi.fn(), detach = vi.fn();
    const launched = await f.dependencies.launcher({ executablePath: "host-owned", boardPath: f.input.pcbPath, environment: {} });
    f.dependencies.launcher.mockResolvedValue({ ...launched, requestClose, detach });
    try {
      const host = await openKicadToolboxNativeHost(f.input, f.dependencies);
      await expect(session.callTool("sch_autoplace_fields")).rejects.toThrow(/categorical/iu);
      await expect(host.close()).rejects.toThrow(/cleanup was not confirmed/iu);
      expect(requestClose).not.toHaveBeenCalled(); expect(detach).toHaveBeenCalledOnce();
      expect(f.dependencies.terminate).not.toHaveBeenCalled();
      expect(f.locks.release).not.toHaveBeenCalled(); expect(f.runtime.releaseIpcSocket).not.toHaveBeenCalled();
    } finally { f.finish(); await session.close(); }
  });

  it("retains the graceful owner when a close request is refused instead of forcing it", async () => {
    const f = await fixture(); const detach = vi.fn();
    const launched = await f.dependencies.launcher({ executablePath: "host-owned", boardPath: f.input.pcbPath, environment: {} });
    f.dependencies.launcher.mockResolvedValue({ ...launched, requestClose: async () => { throw new Error("visible dialog"); }, detach });
    const host = await openKicadToolboxNativeHost(f.input, f.dependencies);
    await expect(host.close()).rejects.toThrow("cleanup was not confirmed");
    expect(detach).toHaveBeenCalledOnce(); expect(f.dependencies.terminate).not.toHaveBeenCalled();
    expect(f.locks.release).not.toHaveBeenCalled(); expect(f.runtime.releaseIpcSocket).not.toHaveBeenCalled(); f.finish();
  });

  it("preflights lock ownership before launch and captures only after active PCB verification", async () => {
    const f = await fixture();
    const host = await openKicadToolboxNativeHost(f.input, f.dependencies);
    expect(seams.locks.mock.invocationCallOrder[0]!).toBeLessThan(f.dependencies.launcher.mock.invocationCallOrder[0]!);
    expect(f.connected.assertCurrent.mock.invocationCallOrder[0]!).toBeLessThan(f.locks.capture.mock.invocationCallOrder[0]!);
    await host.close();
    expect(f.locks.refresh.mock.invocationCallOrder[0]!).toBeLessThan(f.connected.close.mock.invocationCallOrder[0]!);
  });

  it("retains allocation and locks if their stable ownership changed before teardown", async () => {
    const f = await fixture(); const host = await openKicadToolboxNativeHost(f.input, f.dependencies);
    f.locks.refresh.mockRejectedValue(new Error("lock ownership changed"));
    await expect(host.close()).rejects.toThrow("cleanup was not confirmed");
    expect(f.connected.close).toHaveBeenCalledOnce(); expect(f.dependencies.terminate).toHaveBeenCalledOnce();
    expect(f.locks.release).not.toHaveBeenCalled(); expect(f.runtime.releaseIpcSocket).not.toHaveBeenCalled();
  });

  it("does not launch when an existing lock conflicts at preflight", async () => {
    const f = await fixture(); seams.locks.mockRejectedValue(new Error("preexisting lock"));
    const error = await openKicadToolboxNativeHost(f.input, f.dependencies).catch(value => value);
    expect(error.message).toContain("Stage: editor-preflight");
    expect(error.cause.failure).toMatchObject({ stage: "editor-preflight", cause: { category: "native-error" } });
    expect(f.dependencies.launcher).not.toHaveBeenCalled();
    expect(f.runtime.releaseIpcSocket).toHaveBeenCalledOnce();
  });

  it("retains the IPC allocation when captured locks cannot be released unchanged", async () => {
    const f = await fixture(); const host = await openKicadToolboxNativeHost(f.input, f.dependencies);
    f.locks.release.mockRejectedValue(new Error("lock replaced"));
    await expect(host.close()).rejects.toThrow("cleanup was not confirmed");
    expect(f.connected.close).toHaveBeenCalledOnce(); expect(f.dependencies.terminate).toHaveBeenCalledOnce();
    expect(f.runtime.releaseIpcSocket).not.toHaveBeenCalled();
  });

  it("closes native handles and surfaces uncertainty when post-verification lock capture fails", async () => {
    const f = await fixture(); f.locks.capture.mockRejectedValue(new Error("lock capture changed"));
    f.locks.release.mockRejectedValue(new Error("uncaptured lock retained"));
    await expect(openKicadToolboxNativeHost(f.input, f.dependencies)).rejects.toThrow("startup failed and cleanup was not confirmed");
    expect(f.connected.assertCurrent).toHaveBeenCalledOnce(); expect(f.connected.close).toHaveBeenCalledOnce();
    expect(f.dependencies.terminate).toHaveBeenCalledOnce(); expect(f.runtime.releaseIpcSocket).not.toHaveBeenCalled();
  });

  it("binds the live session without requiring the Windows IPC endpoint to appear as a file", async () => {
    const f = await fixture();
    await expect(access(f.socket.endpoint.slice("ipc://".length))).rejects.toMatchObject({ code: "ENOENT" });
    const host = await openKicadToolboxNativeHost(f.input, f.dependencies);
    expect(f.runtime.bindSession).toHaveBeenCalledOnce();
    expect(seams.open).toHaveBeenCalledOnce();
    await expect(access(f.socket.endpoint.slice("ipc://".length))).rejects.toMatchObject({ code: "ENOENT" });
    await host.close();
  });

  it("rejects a resumed copy junction resolving to source before any allocation or launch", async () => {
    const f = await fixture();
    const alias = path.join(f.input.prepared.outputPath, "resumed-alias");
    await symlink(f.input.prepared.sourceProjectPath, alias, "junction");
    const input = { ...f.input, prepared: { ...f.input.prepared, isolatedProjectPath: alias } };
    await expect(openKicadToolboxNativeHost(input, f.dependencies)).rejects.toThrow(/aliases|links|junctions/u);
    expect(f.runtime.allocateIpcSocket).not.toHaveBeenCalled();
    expect(seams.launch).not.toHaveBeenCalled();
  });

  it("rejects a nested junction to source before any allocation or launch", async () => {
    const f = await fixture();
    await symlink(f.input.prepared.sourceProjectPath, path.join(f.input.prepared.isolatedProjectPath, "nested"), "junction");
    await expect(openKicadToolboxNativeHost(f.input, f.dependencies)).rejects.toThrow("contains a link");
    expect(f.runtime.allocateIpcSocket).not.toHaveBeenCalled();
    expect(seams.launch).not.toHaveBeenCalled();
  });

  it("rejects a shared source hardlink before any allocation or launch", async () => {
    const f = await fixture();
    await link(f.input.pcbPath, path.join(f.input.prepared.sourceProjectPath, "shared.kicad_pcb"));
    await expect(openKicadToolboxNativeHost(f.input, f.dependencies)).rejects.toThrow("shared file");
    expect(f.runtime.allocateIpcSocket).not.toHaveBeenCalled();
    expect(seams.launch).not.toHaveBeenCalled();
  });

  it("rejects an ordinary copied root outside its output before any allocation", async () => {
    const f = await fixture();
    const input = { ...f.input, prepared: { ...f.input.prepared, isolatedProjectPath: f.input.prepared.sourceProjectPath } };
    await expect(openKicadToolboxNativeHost(input, f.dependencies)).rejects.toThrow("disjoint from its source");
    expect(f.runtime.allocateIpcSocket).not.toHaveBeenCalled();
    expect(seams.launch).not.toHaveBeenCalled();
  });

  it("binds matching roots/tools, then closes CAD, exact editor, and socket once", async () => {
    const f = await fixture();
    const host = await openKicadToolboxNativeHost(f.input, f.dependencies);
    expect(f.runtime.bindSession).toHaveBeenCalledWith(expect.objectContaining({ mode: "write",
      requiredTools: ["kicad_set_project", "pcb_save"], roots: { workspaceRoot: f.input.prepared.outputPath,
        projectRoot: f.input.prepared.isolatedProjectPath, outputRoot: path.join(f.input.prepared.outputPath, ".evleda-mcp-output") } }));
    await Promise.all([host.close(), host.close()]);
    expect(f.order).toEqual(["cad-close", "terminate", "locks-release", "release"]);
    expect(f.dependencies.terminate).toHaveBeenCalledWith(9876, f.input.termination, expect.any(Function), 4_000);
  });

  it("retains a spawned editor witness when launcher postchecks fail", async () => {
    const f = await fixture();
    seams.launch.mockImplementation(async (_suite: unknown, board: string, _context: unknown, ownedLauncher: FluxPcbEditorLauncher) => {
      await ownedLauncher({ executablePath: "host-owned", boardPath: board, environment: {} });
      throw new Error("postcheck failed");
    });
    const error = await openKicadToolboxNativeHost(f.input, f.dependencies).catch(value => value);
    expect(error.message).toContain("Stage: editor-launch");
    expect(error.cause.failure).toMatchObject({ stage: "editor-launch", cause: { category: "native-error" } });
    expect(f.order).toEqual(["terminate", "release"]);
    expect(seams.open).not.toHaveBeenCalled();
  });

  it("preserves uncertain tree cleanup and retains socket allocation", async () => {
    const f = await fixture();
    f.dependencies.terminate.mockResolvedValue(false);
    const host = await openKicadToolboxNativeHost(f.input, f.dependencies);
    await expect(host.close()).rejects.toThrow("cleanup was not confirmed");
    expect(f.runtime.releaseIpcSocket).not.toHaveBeenCalled();
    f.finish();
  });

  it("still terminates editor on CAD close failure but retains allocation", async () => {
    const f = await fixture();
    f.connected.close.mockRejectedValue(new Error("CAD teardown uncertain"));
    const host = await openKicadToolboxNativeHost(f.input, f.dependencies);
    await expect(host.close()).rejects.toThrow("cleanup was not confirmed");
    expect(f.dependencies.terminate).toHaveBeenCalledOnce();
    expect(f.locks.release).not.toHaveBeenCalled();
    expect(f.runtime.releaseIpcSocket).not.toHaveBeenCalled();
  });

  it("does not target a numeric PID after the exact editor already exited", async () => {
    const f = await fixture();
    const host = await openKicadToolboxNativeHost(f.input, f.dependencies);
    f.finish(); await Promise.resolve();
    await host.close();
    expect(f.dependencies.terminate).not.toHaveBeenCalled();
    expect(f.runtime.releaseIpcSocket).toHaveBeenCalledOnce();
  });
});
