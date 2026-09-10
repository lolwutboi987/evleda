import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, contentIdentity } from "../core/canonical.js";
import type { KicadMcpPinnedFileInput } from "../integrations/kicad-mcp-session.js";
import type { FluxPcbEditorLaunchRequest, FluxPcbEditorLaunchResult } from "../flux/pcb-editor-launcher.js";
import { bindKicadStartupEvidence, type KicadEditorReadinessFailure, type KicadEditorReadinessStage } from "../integrations/kicad-startup-diagnostic.js";

export interface OwnedKicadEditorLaunchResult extends FluxPcbEditorLaunchResult {
  /** Version, ping and the exact launched PCB have been observed within startup's bound. */
  waitUntilReady(): Promise<void>;
  /** Acknowledges WM_CLOSE posting only; await exited separately. */
  requestClose(): Promise<void>;
  /** Retain the supervisor/editor on timeout without keeping this host alive. */
  detach(): void;
}

const readinessStages = new Set(["connection", "version", "ping", "document"]);
const readinessCodes = new Set(["DEADLINE", "EDITOR_EXITED", "WRONG_DOCUMENT", "NATIVE_FAILURE", "INVALID_ENDPOINT", "VERSION_MISMATCH", "CANCELLED"]);
const firstCodes = new Set([...readinessCodes, "NOT_READY", "CONNECTION_NOT_READY"]);
const boundedInteger = (value: unknown, maximum = 2_147_483_647): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maximum;
const nativeCode = (value: unknown): value is number | null => value === null || typeof value === "number" && Number.isInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647;
const exactKeys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).sort().join("|") === [...expected].sort().join("|");
type ReadinessProgress = Omit<KicadEditorReadinessFailure, "code">;
function parseReadiness(event: Record<string, unknown>, failed: boolean): ReadinessProgress | KicadEditorReadinessFailure {
  const invalid = () => { throw new Error("Owned editor supervisor returned invalid readiness evidence."); };
  if (!exactKeys(event, ["type", "stage", "attempts", "elapsedMs", "nativeCode", "firstFailure", ...(failed ? ["code"] : [])])
      || typeof event.stage !== "string" || !readinessStages.has(event.stage) || !boundedInteger(event.attempts, 10000)
      || !boundedInteger(event.elapsedMs) || !nativeCode(event.nativeCode)
      || failed && (typeof event.code !== "string" || !readinessCodes.has(event.code))) invalid();
  const first = event.firstFailure;
  if (first !== null && (typeof first !== "object" || Array.isArray(first))) invalid();
  if (first !== null) {
    const record = first as Record<string, unknown>;
    if (!exactKeys(record, ["stage", "code", "nativeCode", "attempt"]) || typeof record.stage !== "string" || !readinessStages.has(record.stage)
        || typeof record.code !== "string" || !firstCodes.has(record.code) || !nativeCode(record.nativeCode)
        || !boundedInteger(record.attempt, 10000) || record.attempt < 1 || record.attempt > (event.attempts as number)) invalid();
  }
  return Object.freeze({ ...(failed ? { code: event.code } : {}), stage: event.stage, attempts: event.attempts, elapsedMs: event.elapsedMs,
    nativeCode: event.nativeCode, firstFailure: first === null ? null : Object.freeze({ ...first as Record<string, unknown> }) }) as ReadinessProgress | KicadEditorReadinessFailure;
}
function readinessError(details: KicadEditorReadinessFailure): Error {
  const error = new Error(`Owned editor readiness failed: ${details.code}; stage ${details.stage}; attempts ${details.attempts}.`);
  return bindKicadStartupEvidence(error, Object.freeze({ failure: Object.freeze({ stage: "editor-readiness" as const,
    cause: Object.freeze({ category: "native-error" as const, ...(details.nativeCode === null ? {} : { code: details.nativeCode }), editorReadiness: details }), stderr: null }), cleanup: Object.freeze([]) }));
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
    let resolveReady!: () => void, rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    void ready.catch(() => undefined);
    let readinessSettled = false;
    let progress: ReadinessProgress = Object.freeze({ stage: "connection" as KicadEditorReadinessStage, attempts: 0, elapsedMs: 0, nativeCode: null, firstFailure: null });
    const startedAt = Date.now();
    let nativeExited = false, detached = false, announced = false;
    let terminalError: Error | undefined;
    let pending: { resolve: () => void; reject: (error: Error) => void } | undefined;
    let buffer = "";
    return await new Promise<OwnedKicadEditorLaunchResult>((resolve, reject) => {
      const failReadiness = (error: Error): void => {
        if (readinessSettled) return;
        readinessSettled = true; clearTimeout(startupTimer); rejectReady(error);
      };
      const localReadinessError = (code: KicadEditorReadinessFailure["code"]) => readinessError(Object.freeze({ ...progress, code, elapsedMs: Math.min(2_147_483_647, Math.max(0, Date.now() - startedAt)) }));
      const detach = (): void => {
        failReadiness(localReadinessError("CANCELLED"));
        detached = true; child.unref();
        for (const stream of [child.stdin, child.stdout, child.stderr]) (stream as unknown as { unref?: () => void }).unref?.();
      };
      const startupTimer = setTimeout(() => {
        if (announced) failReadiness(localReadinessError("DEADLINE"));
        else fail(new Error("Owned editor supervisor did not confirm native launch; state retained as uncertain."));
      }, 30_000);
      const fail = (error: Error): void => { terminalError ??= error; clearTimeout(startupTimer); failReadiness(terminalError); reject(terminalError); if (!nativeExited) rejectExit(terminalError); pending?.reject(terminalError); pending = undefined; detach(); };
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
            const event = JSON.parse(line) as Record<string, unknown>;
            if (event === null || typeof event !== "object" || Array.isArray(event)) throw new Error("Owned editor supervisor returned invalid protocol data.");
            if (event.type === "spawn" && !announced && exactKeys(event, ["type", "pid"]) && typeof event.pid === "number" && Number.isSafeInteger(event.pid) && event.pid > 0) {
              announced = true;
              resolve(Object.freeze({ pid: event.pid, exited, waitUntilReady: async () => {
                await ready;
                if (nativeExited) throw localReadinessError("EDITOR_EXITED");
                if (terminalError !== undefined) throw terminalError;
                if (detached) throw localReadinessError("CANCELLED");
              },
                requestClose: () => {
                  if (nativeExited) return Promise.resolve();
                  if (terminalError !== undefined) return Promise.reject(terminalError);
                  if (detached || pending !== undefined) return Promise.reject(new Error("Owned editor close request is unavailable or pending."));
                  failReadiness(localReadinessError("CANCELLED"));
                  return new Promise<void>((ack, rejectAck) => { pending = { resolve: ack, reject: rejectAck }; child.stdin.write("close\n"); });
                },
                detach,
              }));
            } else if ((event.type === "readiness_progress" || event.type === "readiness_failed") && announced) {
              const captured = parseReadiness(event, event.type === "readiness_failed");
              if (!readinessSettled && !nativeExited) {
                if (captured.attempts < progress.attempts || captured.elapsedMs < progress.elapsedMs
                    || progress.firstFailure !== null && canonicalJson(captured.firstFailure) !== canonicalJson(progress.firstFailure)) throw new Error("Owned editor readiness progress changed its first failure or moved backward.");
                progress = captured;
                if (event.type === "readiness_failed") failReadiness(readinessError(captured as KicadEditorReadinessFailure));
              }
            } else if (event.type === "ready" && announced) {
              if (!exactKeys(event, ["type", "attempts", "elapsedMs"]) || !boundedInteger(event.attempts, 10000) || event.attempts < 1 || !boundedInteger(event.elapsedMs)) throw new Error("Owned editor supervisor returned invalid readiness evidence.");
              if (!readinessSettled && !nativeExited) {
                if (event.attempts < progress.attempts || event.elapsedMs < progress.elapsedMs) throw new Error("Owned editor readiness completion moved backward.");
                readinessSettled = true; clearTimeout(startupTimer); resolveReady();
              }
            } else if (event.type === "native_exit" && announced && exactKeys(event, ["type", "code"]) && typeof event.code === "number" && Number.isInteger(event.code)) {
              nativeExited = true; failReadiness(localReadinessError("EDITOR_EXITED")); clearTimeout(startupTimer);
              resolveExit({ code: event.code, signal: null }); pending?.resolve(); pending = undefined;
              child.stdin.end();
            } else if (event.type === "close_ack" && pending !== undefined) { pending.resolve(); pending = undefined;
            } else if (event.type === "close_rejected" && pending !== undefined) { pending.reject(new Error(typeof event.message === "string" ? event.message : "Owned editor rejected close.")); pending = undefined;
            } else { fail(new Error(typeof event.message === "string" ? event.message : "Owned editor supervisor returned unexpected protocol data.")); }
          } catch (error) { fail(error instanceof Error ? error : new Error("Invalid supervisor response.")); }
        }
      });
      // Drain diagnostics without treating helper termination as native exit.
      child.stderr.resume();
      child.stdin.write(`${JSON.stringify({ executablePath: request.executablePath, boardPath: request.boardPath, environment: request.environment })}\n`);
    });
  };
}
