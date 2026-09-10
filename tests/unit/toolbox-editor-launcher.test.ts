import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { createOwnedKicadEditorLauncher } from "../../src/mcp/toolbox-editor-launcher.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
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
