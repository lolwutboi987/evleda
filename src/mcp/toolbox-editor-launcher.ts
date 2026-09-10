import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contentIdentity } from "../core/canonical.js";
import type { KicadMcpPinnedFileInput } from "../integrations/kicad-mcp-session.js";
import type { FluxPcbEditorLaunchRequest, FluxPcbEditorLaunchResult } from "../flux/pcb-editor-launcher.js";

export interface OwnedKicadEditorLaunchResult extends FluxPcbEditorLaunchResult {
  /** Acknowledges WM_CLOSE posting only; await exited separately. */
  requestClose(): Promise<void>;
  /** Retain the supervisor/editor on timeout without keeping this host alive. */
  detach(): void;
}

export interface OwnedKicadEditorLauncherInput {
  readonly python: KicadMcpPinnedFileInput;
  readonly environment: Readonly<Record<string, string>>;
  readonly spawnForTesting?: typeof spawn;
}

/** Fixed helper and pinned Python; all launch inputs originate with the native host. */
export function createOwnedKicadEditorLauncher(input: OwnedKicadEditorLauncherInput) {
  return async (request: FluxPcbEditorLaunchRequest): Promise<OwnedKicadEditorLaunchResult> => {
    if (!path.isAbsolute(input.python.path) || input.python.contentIdentity.algorithm !== "sha256"
        || !path.isAbsolute(request.executablePath) || !path.isAbsolute(request.boardPath)) throw new Error("Owned editor requires absolute host-pinned launch paths.");
    const python = path.resolve(input.python.path);
    const before = await lstat(python, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 256n * 1024n * 1024n
        || (await realpath(python)).toLowerCase() !== python.toLowerCase()) throw new Error("Owned editor Python must be an ordinary canonical pinned executable.");
    const bytes = await readFile(python);
    const identity = contentIdentity(bytes);
    const after = await lstat(python, { bigint: true });
    if (identity.digest !== input.python.contentIdentity.digest || identity.size !== input.python.contentIdentity.size
        || before.ino !== after.ino || before.dev !== after.dev || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error("Owned editor Python differs from its host pin.");
    }
    const helper = fileURLToPath(new URL("./toolbox-editor-supervisor.py", import.meta.url));
    const child = (input.spawnForTesting ?? spawn)(python, ["-I", "-s", "-E", "-B", "-X", "utf8", helper], {
      cwd: path.dirname(helper), env: { ...input.environment }, windowsHide: true, shell: false, stdio: "pipe",
    }) as ChildProcessWithoutNullStreams;
    let resolveExit!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
    let rejectExit!: (error: Error) => void;
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { resolveExit = resolve; rejectExit = reject; });
    void exited.catch(() => undefined);
    let nativeExited = false, detached = false, announced = false;
    let terminalError: Error | undefined;
    let pending: { resolve: () => void; reject: (error: Error) => void } | undefined;
    let buffer = "";
    return await new Promise<OwnedKicadEditorLaunchResult>((resolve, reject) => {
      const detach = (): void => {
        detached = true; child.unref();
        for (const stream of [child.stdin, child.stdout, child.stderr]) (stream as unknown as { unref?: () => void }).unref?.();
      };
      const startupTimer = setTimeout(() => fail(new Error("Owned editor supervisor did not confirm native launch; state retained as uncertain.")), 30_000);
      const fail = (error: Error): void => { terminalError = error; clearTimeout(startupTimer); reject(error); if (!nativeExited) rejectExit(error); pending?.reject(error); pending = undefined; detach(); };
      child.once("error", error => fail(error));
      // close follows stdout draining; exit can precede its final native_exit line.
      child.once("close", () => { if (!nativeExited) fail(new Error("Owned editor supervisor exited without a native child exit witness; state is uncertain.")); });
      child.stdin.on("error", error => fail(error));
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 32_768) { fail(new Error("Owned editor supervisor protocol exceeded its bound.")); return; }
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          try {
            const event = JSON.parse(line) as { type?: string; pid?: number; code?: number; message?: string };
            if (event.type === "spawn" && !announced && Number.isSafeInteger(event.pid) && event.pid! > 0) {
              announced = true;
              clearTimeout(startupTimer);
              resolve(Object.freeze({ pid: event.pid!, exited,
                requestClose: () => {
                  if (nativeExited) return Promise.resolve();
                  if (terminalError !== undefined) return Promise.reject(terminalError);
                  if (detached || pending !== undefined) return Promise.reject(new Error("Owned editor close request is unavailable or pending."));
                  return new Promise<void>((ack, rejectAck) => { pending = { resolve: ack, reject: rejectAck }; child.stdin.write("close\n"); });
                },
                detach,
              }));
            } else if (event.type === "native_exit" && announced && Number.isInteger(event.code)) {
              nativeExited = true; resolveExit({ code: event.code!, signal: null }); pending?.resolve(); pending = undefined;
              child.stdin.end();
            } else if (event.type === "close_ack" && pending !== undefined) { pending.resolve(); pending = undefined;
            } else if (event.type === "close_rejected" && pending !== undefined) { pending.reject(new Error(event.message ?? "Owned editor rejected close.")); pending = undefined;
            } else { fail(new Error(event.message ?? "Owned editor supervisor returned unexpected protocol data.")); }
          } catch (error) { fail(error instanceof Error ? error : new Error("Invalid supervisor response.")); }
        }
      });
      // Drain diagnostics without treating helper termination as native exit.
      child.stderr.resume();
      child.stdin.write(`${JSON.stringify({ executablePath: request.executablePath, boardPath: request.boardPath, environment: request.environment })}\n`);
    });
  };
}
