import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { createOwnedKicadEditorLauncher } from "../../src/mcp/toolbox-editor-launcher.js";
import { captureKicadStartupFailure } from "../../src/integrations/kicad-startup-diagnostic.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  const parent = await realpath(tmpdir());
  for (const root of roots.splice(0)) {
    const target = await realpath(root);
    if (path.dirname(target) !== parent || !path.basename(target).startsWith("evleda-editor-supervisor-")) throw new Error("Editor test cleanup escaped its owned temporary directory");
    await rm(target, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "evleda-editor-supervisor-")); roots.push(root);
  const python = path.join(root, "python.exe"); await writeFile(python, "pinned test python");
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), unref: vi.fn() });
  const sent: string[] = []; child.stdin.on("data", value => sent.push(String(value)));
  const spawnFake = vi.fn().mockImplementation(() => { setImmediate(() => child.stdout.write('{"type":"spawn","pid":1234}\n')); return child; });
  const input = { python: { path: python, contentIdentity: contentIdentity("pinned test python") }, environment: { SYSTEMROOT: "host-owned" }, spawnForTesting: spawnFake as unknown as typeof spawn };
  const launch = createOwnedKicadEditorLauncher(input);
  const request = { executablePath: path.join(root, "pcbnew.exe"), boardPath: path.join(root, "proof.kicad_pcb"), environment: { KICAD_CONFIG_HOME: "owned-native-config" } };
  const emit = (value: unknown) => child.stdout.write(`${JSON.stringify(value)}\n`);
  return { launch, input, request, child, spawnFake, sent, emit };
}

describe("owned editor supervisor protocol", () => {
  it("announces ownership immediately and waits separately for readiness", async () => {
    const f = await fixture(); const editor = await f.launch(f.request); let ready = false;
    const waiting = editor.waitUntilReady().then(() => { ready = true; });
    await Promise.resolve(); expect(editor.pid).toBe(1234); expect(ready).toBe(false);
    f.emit({ type: "readiness_progress", stage: "connection", attempts: 1, elapsedMs: 0, nativeCode: null, firstFailure: null });
    f.emit({ type: "ready", attempts: 1, elapsedMs: 5 });
    await waiting; expect(ready).toBe(true);
    f.emit({ type: "native_exit", code: 0 }); await editor.exited;
    await expect(editor.waitUntilReady()).rejects.toThrow("EDITOR_EXITED");
  });
  it("retains first not-ready evidence on timeout while close and late native exit remain available", async () => {
    const f = await fixture(); let expire!: () => void;
    const setTimer = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (delay === 30000) expire = () => callback(...args);
      return setTimer(callback, delay, ...args);
    }) as typeof setTimeout);
    const editor = await f.launch(f.request);
    const firstFailure = { stage: "version", code: "NOT_READY", nativeCode: 4, attempt: 1 };
    f.emit({ type: "readiness_progress", stage: "version", attempts: 1, elapsedMs: 1000, nativeCode: 4, firstFailure });
    expire();
    const error = await editor.waitUntilReady().catch(value => value);
    expect(captureKicadStartupFailure(error, "editor-launch").failure).toMatchObject({ stage: "editor-readiness",
      cause: { code: 4, editorReadiness: { code: "DEADLINE", attempts: 1, firstFailure } } });
    expect(f.child.unref).not.toHaveBeenCalled();
    f.emit({ type: "ready", attempts: 2, elapsedMs: 30001 });
    await expect(editor.waitUntilReady()).rejects.toBe(error);
    const closing = editor.requestClose(); f.emit({ type: "close_ack" }); await closing;
    f.emit({ type: "native_exit", code: 0 }); await editor.exited;
  });
  it("rejects wrong-document readiness without losing the owned close channel", async () => {
    const f = await fixture(); const editor = await f.launch(f.request);
    f.emit({ type: "readiness_failed", code: "WRONG_DOCUMENT", stage: "document", attempts: 1, elapsedMs: 5, nativeCode: null,
      firstFailure: { code: "WRONG_DOCUMENT", stage: "document", attempt: 1, nativeCode: null } });
    await expect(editor.waitUntilReady()).rejects.toThrow("WRONG_DOCUMENT");
    const closing = editor.requestClose(); f.emit({ type: "close_rejected", message: "Owned editor document differs from the launched board" });
    await expect(closing).rejects.toThrow("document differs");
    expect(f.child.unref).not.toHaveBeenCalled();
    f.emit({ type: "native_exit", code: 0 }); await editor.exited;
  });
  it("rejects readiness on early native exit and cannot be revived by late ready", async () => {
    const f = await fixture(); const editor = await f.launch(f.request);
    f.emit({ type: "native_exit", code: 7 });
    await expect(editor.waitUntilReady()).rejects.toThrow("EDITOR_EXITED");
    f.emit({ type: "ready", attempts: 1, elapsedMs: 2 });
    await expect(editor.waitUntilReady()).rejects.toThrow("EDITOR_EXITED");
    await expect(editor.exited).resolves.toEqual({ code: 7, signal: null });
  });
  it("cancels pending readiness when the host requests close", async () => {
    const f = await fixture(); const editor = await f.launch(f.request);
    const closing = editor.requestClose();
    await expect(editor.waitUntilReady()).rejects.toThrow("CANCELLED");
    f.emit({ type: "readiness_failed", code: "CANCELLED", stage: "connection", attempts: 0, elapsedMs: 1, nativeCode: null, firstFailure: null });
    f.emit({ type: "close_ack" }); await closing;
    f.emit({ type: "native_exit", code: 0 }); await editor.exited;
  });
  it.each(["unknown-code", "extra-field", "negative-attempt", "changed-first"])("rejects malformed %s readiness evidence without exposing its prose", async kind => {
    const f = await fixture(); const editor = await f.launch(f.request);
    const firstFailure = { code: "NOT_READY", stage: "version", attempt: 1, nativeCode: 4 };
    if (kind === "changed-first") f.emit({ type: "readiness_progress", stage: "version", attempts: 1, elapsedMs: 1, nativeCode: 4, firstFailure });
    const event: Record<string, unknown> = { type: "readiness_failed", code: "DEADLINE", stage: "version", attempts: 1, elapsedMs: 2, nativeCode: 4, firstFailure };
    if (kind === "unknown-code") event.code = "sk-native-token";
    if (kind === "extra-field") event.message = "sk-native-token";
    if (kind === "negative-attempt") event.attempts = -1;
    if (kind === "changed-first") event.firstFailure = null;
    f.emit(event);
    const error = await editor.waitUntilReady().catch(value => value);
    expect(error.message).toMatch(/readiness evidence|first failure/); expect(error.message).not.toContain("sk-native-token");
    await expect(editor.exited).rejects.toThrow();
    f.emit({ type: "native_exit", code: 0 });
  });
  it("launches the fixed helper hidden with pinned Python and explicit environment", async () => {
    const f = await fixture(); const editor = await f.launch(f.request);
    const [command, args, options] = f.spawnFake.mock.calls[0]!;
    expect(command).toBe(f.input.python.path); expect(args.slice(0, 4)).toEqual(["-I", "-s", "-E", "-B"]);
    expect(args.slice(4, 6)).toEqual(["-X", "utf8"]);
    expect(path.basename(args[6])).toBe("toolbox-editor-supervisor.py");
    expect(options).toMatchObject({ windowsHide: true, shell: false, env: f.input.environment });
    expect(JSON.parse(f.sent[0]!)).toEqual(f.request); expect(editor.pid).toBe(1234);
    f.emit({ type: "native_exit", code: 0 }); await expect(editor.exited).resolves.toEqual({ code: 0, signal: null });
  });
  it("treats close acknowledgement separately from actual native exit", async () => {
    const f = await fixture(); const editor = await f.launch(f.request); let exited = false;
    void editor.exited.then(() => { exited = true; });
    const ack = editor.requestClose(); expect(f.sent.at(-1)).toBe("close\n");
    f.emit({ type: "close_ack" }); await ack; expect(exited).toBe(false);
    f.emit({ type: "native_exit", code: 0 }); await editor.exited;
  });
  it("retains the editor and reports rejected window selection without dismissing anything", async () => {
    const f = await fixture(); const editor = await f.launch(f.request); const ack = editor.requestClose();
    f.emit({ type: "close_rejected", message: "visible dialog" }); await expect(ack).rejects.toThrow("visible dialog");
    editor.detach(); expect(f.child.unref).toHaveBeenCalled();
    await expect(editor.requestClose()).rejects.toThrow("unavailable");
    f.emit({ type: "native_exit", code: 0 }); await editor.exited;
  });
  it("rejects the native exit witness if the supervisor closes without child evidence", async () => {
    const f = await fixture(); const editor = await f.launch(f.request); f.child.emit("close", 0);
    await expect(editor.exited).rejects.toThrow("without a native child exit witness");
    await expect(editor.requestClose()).rejects.toThrow("uncertain");
  });
  it("allows buffered native exit evidence after the supervisor exit notification", async () => {
    const f = await fixture(); const editor = await f.launch(f.request); f.child.emit("exit", 0);
    f.emit({ type: "native_exit", code: 0 }); f.child.emit("close", 0);
    await expect(editor.exited).resolves.toEqual({ code: 0, signal: null });
  });
  it("rejects modified Python before spawning", async () => {
    const f = await fixture(); await writeFile(f.input.python.path, "replacement");
    await expect(f.launch(f.request)).rejects.toThrow("differs from its host pin"); expect(f.spawnFake).not.toHaveBeenCalled();
  });
});
