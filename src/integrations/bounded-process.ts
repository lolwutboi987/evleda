import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import type { ContentIdentity } from "../domain/types.js";

export const BOUNDED_WINDOWS_PROCESS_TREE_TERMINATION_SCHEMA_VERSION =
  "evleda.bounded-windows-process-tree-termination.v1" as const;

/**
 * Exact authority for the only helper a Windows bounded process may use to
 * terminate a process tree. The two-key environment is deliberately closed:
 * neither PATH/COMSPEC nor application/provider credentials reach the helper.
 */
export interface BoundedWindowsProcessTreeTermination {
  readonly schemaVersion: typeof BOUNDED_WINDOWS_PROCESS_TREE_TERMINATION_SCHEMA_VERSION;
  readonly executablePath: string;
  readonly executableIdentity: ContentIdentity;
  readonly cwd: string;
  readonly env: Readonly<{
    readonly SYSTEMROOT: string;
    readonly WINDIR: string;
  }>;
}

export interface BoundedProcessOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
  /** Required on Windows to claim confirmed process-tree termination. */
  readonly windowsProcessTreeTermination?: BoundedWindowsProcessTreeTermination;
  /** Deterministic cross-platform teardown seams; production must omit. */
  readonly teardownHooksForTesting?: Readonly<{
    readonly platform?: "win32" | "posix";
    readonly taskkillTree?: (pid: number) => Promise<boolean>;
    readonly signalProcessGroup?: (pid: number, signal: NodeJS.Signals | 0) => void;
    readonly processGroupIsGone?: (pid: number) => boolean;
    readonly terminationTimeoutMs?: number;
    readonly termGraceMs?: number;
    readonly spawnTerminationHelper?: typeof spawn;
  }>;
  readonly spawnForTesting?: typeof spawn;
}

export interface BoundedProcessResult {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly startedAt: string;
}

export type BoundedProcessRunner = (
  options: BoundedProcessOptions,
) => Promise<BoundedProcessResult>;

export class BoundedProcessError extends Error {
  override readonly name: string = "BoundedProcessError";
  readonly command: string;
  readonly args: readonly string[];
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    message: string,
    options: BoundedProcessOptions,
    stdout: string,
    stderr: string,
    errorOptions?: ErrorOptions,
  ) {
    super(message, errorOptions);
    this.command = options.command;
    this.args = [...options.args];
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export class ProcessTimeoutError extends BoundedProcessError {
  override readonly name = "ProcessTimeoutError";
}

export class ProcessAbortError extends BoundedProcessError {
  override readonly name = "ProcessAbortError";
}

export class ProcessOutputLimitError extends BoundedProcessError {
  override readonly name = "ProcessOutputLimitError";
}

export class ProcessTreeTerminationUnconfirmedError extends BoundedProcessError {
  override readonly name = "ProcessTreeTerminationUnconfirmedError";
  readonly retainWorkingDirectory = true;
  public constructor(
    message: string,
    options: BoundedProcessOptions,
    stdout: string,
    stderr: string,
    readonly primaryErrorName: string | null = null,
    readonly confirmationFailure: "root_close_unconfirmed" | "tree_death_unconfirmed" | "root_and_tree_unconfirmed" = "root_and_tree_unconfirmed",
    primaryError?: BoundedProcessError,
  ) {
    super(message, options, stdout, stderr, primaryError === undefined ? undefined : { cause: primaryError });
  }
}

const TREE_TERMINATION_TIMEOUT_MS = 2_000;
const TERM_GRACE_MS = 250;
const MAXIMUM_TERMINATION_HELPER_BYTES = 16 * 1024 * 1024;

function destroyOutputHandles(child: ReturnType<typeof spawn>): void {
  child.stdout?.removeAllListeners("data");
  child.stderr?.removeAllListeners("data");
  child.stdout?.destroy();
  child.stderr?.destroy();
}

async function waitBounded(completion: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = await Promise.race([
    completion.then(() => false),
    new Promise<true>((resolve) => {
      timeout = setTimeout(() => resolve(true), timeoutMs);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  return !timedOut;
}

async function booleanWithin(completion: Promise<boolean>, timeoutMs: number): Promise<boolean> {
  void completion.catch(() => undefined);
  let timeout: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    completion.catch(() => false),
    new Promise<false>((resolve) => { timeout = setTimeout(() => resolve(false), timeoutMs); }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  return result;
}

const samePath = (left: string, right: string): boolean =>
  process.platform === "win32"
    ? path.resolve(left).toLocaleLowerCase("en-US") === path.resolve(right).toLocaleLowerCase("en-US")
    : path.resolve(left) === path.resolve(right);

const validContentIdentity = (identity: ContentIdentity): boolean =>
  identity.algorithm === "sha256"
  && /^[0-9a-f]{64}$/u.test(identity.digest)
  && Number.isSafeInteger(identity.size)
  && identity.size > 0
  && identity.size <= MAXIMUM_TERMINATION_HELPER_BYTES;

const exactTerminationEnvironment = (
  environment: Readonly<Record<string, string>>,
): environment is BoundedWindowsProcessTreeTermination["env"] => {
  const keys = Reflect.ownKeys(environment);
  if (keys.length !== 2 || !keys.every((key) => typeof key === "string")) return false;
  if (!Object.hasOwn(environment, "SYSTEMROOT") || !Object.hasOwn(environment, "WINDIR")) return false;
  const systemRoot = environment.SYSTEMROOT;
  const windowsDirectory = environment.WINDIR;
  return typeof systemRoot === "string"
    && typeof windowsDirectory === "string"
    && systemRoot.length > 0
    && windowsDirectory.length > 0
    && !/[\0\r\n]/u.test(systemRoot)
    && !/[\0\r\n]/u.test(windowsDirectory)
    && path.win32.isAbsolute(systemRoot)
    && path.win32.isAbsolute(windowsDirectory)
    && path.win32.resolve(systemRoot).toLocaleLowerCase("en-US")
      === path.win32.resolve(windowsDirectory).toLocaleLowerCase("en-US");
};

interface TerminationFileWitness {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly birthtimeNs: bigint;
}

const fileWitness = (metadata: BigIntStats): TerminationFileWitness => Object.freeze({
  dev: metadata.dev,
  ino: metadata.ino,
  mode: metadata.mode,
  nlink: metadata.nlink,
  size: metadata.size,
  mtimeNs: metadata.mtimeNs,
  ctimeNs: metadata.ctimeNs,
  birthtimeNs: metadata.birthtimeNs,
});

const sameFileWitness = (left: TerminationFileWitness, right: TerminationFileWitness): boolean =>
  left.dev === right.dev
  && left.ino === right.ino
  && left.mode === right.mode
  && left.nlink === right.nlink
  && left.size === right.size
  && left.mtimeNs === right.mtimeNs
  && left.ctimeNs === right.ctimeNs
  && left.birthtimeNs === right.birthtimeNs;

interface ExactTerminationHelper {
  readonly handle: FileHandle;
  readonly executable: TerminationFileWitness;
  readonly parent: TerminationFileWitness;
  readonly cwd: TerminationFileWitness;
}

const exactHandleBytes = async (
  handle: FileHandle,
  identity: ContentIdentity,
): Promise<boolean> => {
  const bytes = Buffer.alloc(identity.size);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
    if (read.bytesRead < 1) return false;
    offset += read.bytesRead;
  }
  const overflow = Buffer.alloc(1);
  if ((await handle.read(overflow, 0, 1, bytes.byteLength)).bytesRead !== 0) return false;
  const actualDigest = Buffer.from(createHash("sha256").update(bytes).digest("hex"), "ascii");
  const expectedDigest = Buffer.from(identity.digest, "ascii");
  return actualDigest.byteLength === expectedDigest.byteLength
    && timingSafeEqual(actualDigest, expectedDigest);
};

const exactDirectoryWitness = async (directory: string): Promise<TerminationFileWitness | undefined> => {
  const [metadata, canonical] = await Promise.all([
    lstat(directory, { bigint: true }),
    realpath(directory),
  ]);
  return metadata.isDirectory()
    && !metadata.isSymbolicLink()
    && metadata.nlink === 1n
    && samePath(canonical, directory)
      ? fileWitness(metadata)
      : undefined;
};

async function exactTerminationHelper(
  binding: BoundedWindowsProcessTreeTermination,
): Promise<ExactTerminationHelper | undefined> {
  if (
    Reflect.ownKeys(binding).length !== 5
    || binding.schemaVersion !== BOUNDED_WINDOWS_PROCESS_TREE_TERMINATION_SCHEMA_VERSION
    || typeof binding.executablePath !== "string"
    || typeof binding.cwd !== "string"
    || /[\0\r\n]/u.test(binding.executablePath)
    || /[\0\r\n]/u.test(binding.cwd)
    || !path.isAbsolute(binding.executablePath)
    || !path.isAbsolute(binding.cwd)
    || !validContentIdentity(binding.executableIdentity)
    || !exactTerminationEnvironment(binding.env)
  ) return undefined;
  let handle: FileHandle | undefined;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    handle = await open(binding.executablePath, fsConstants.O_RDONLY | noFollow);
    const helperBefore = await handle.stat({ bigint: true });
    if (
      !helperBefore.isFile()
      || helperBefore.isSymbolicLink()
      || helperBefore.nlink !== 1n
      || helperBefore.size !== BigInt(binding.executableIdentity.size)
      || !await exactHandleBytes(handle, binding.executableIdentity)
    ) {
      await handle.close();
      return undefined;
    }
    const [helperAfter, helperPathMetadata, helperRealPath, parent, cwd] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(binding.executablePath, { bigint: true }),
      realpath(binding.executablePath),
      exactDirectoryWitness(path.dirname(binding.executablePath)),
      exactDirectoryWitness(binding.cwd),
    ]);
    if (
      !sameFileWitness(fileWitness(helperBefore), fileWitness(helperAfter))
      || !helperPathMetadata.isFile()
      || helperPathMetadata.isSymbolicLink()
      || !sameFileWitness(fileWitness(helperBefore), fileWitness(helperPathMetadata))
      || !samePath(helperRealPath, binding.executablePath)
      || parent === undefined
      || cwd === undefined
    ) {
      await handle.close();
      return undefined;
    }
    return Object.freeze({
      handle,
      executable: fileWitness(helperAfter),
      parent,
      cwd,
    });
  } catch {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    return undefined;
  }
}

const reassertTerminationHelper = async (
  binding: BoundedWindowsProcessTreeTermination,
  before: ExactTerminationHelper,
): Promise<boolean> => {
  let after: ExactTerminationHelper | undefined;
  try {
    const heldMetadata = await before.handle.stat({ bigint: true });
    if (!sameFileWitness(before.executable, fileWitness(heldMetadata))) return false;
    if (!await exactHandleBytes(before.handle, binding.executableIdentity)) return false;
    after = await exactTerminationHelper(binding);
    return after !== undefined
      && sameFileWitness(before.executable, after.executable)
      && sameFileWitness(before.parent, after.parent)
      && sameFileWitness(before.cwd, after.cwd);
  } catch {
    return false;
  } finally {
    if (after !== undefined) await after.handle.close().catch(() => undefined);
  }
};

/**
 * Runs one exact, caller-authorized Windows tree helper. Identity verification
 * happens before the final synchronous root-live check/spawn pair. A missing,
 * drifted, or already-stale authority simply yields unconfirmed termination.
 */
export async function runBoundedWindowsProcessTreeTermination(
  pid: number,
  binding: BoundedWindowsProcessTreeTermination | undefined,
  rootExitObserved: () => boolean,
  timeoutMs: number = TREE_TERMINATION_TIMEOUT_MS,
  spawnHelper: typeof spawn = spawn,
): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || binding === undefined) return false;
  const exactHelper = await exactTerminationHelper(binding);
  if (exactHelper === undefined) return false;
  // There is intentionally no await or timer boundary between this final
  // same-incarnation observation and the synchronous spawn call.
  if (rootExitObserved()) {
    await exactHelper.handle.close().catch(() => undefined);
    return false;
  }
  return await new Promise<boolean>((resolve) => {
    let killer: ReturnType<typeof spawn>;
    try {
      killer = spawnHelper(binding.executablePath, ["/PID", String(pid), "/T", "/F"], {
        cwd: binding.cwd,
        env: { ...binding.env },
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      void exactHelper.handle.close().finally(() => resolve(false));
      return;
    }
    let done = false;
    const finish = (candidate: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      void (async () => {
        const confirmed = candidate && await reassertTerminationHelper(binding, exactHelper);
        await exactHelper.handle.close().catch(() => undefined);
        resolve(confirmed);
      })();
    };
    const timeout = setTimeout(() => {
      try { killer.kill("SIGKILL"); } catch { /* helper already exited */ }
      finish(false);
    }, timeoutMs);
    killer.once("error", () => finish(false));
    killer.once("close", (code) => finish(code === 0));
  });
}

function processGroupIsGone(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function waitForProcessGroupExit(
  pid: number,
  timeoutMs: number,
  isGone: (pid: number) => boolean,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!isGone(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

async function terminateProcessTree(
  child: ReturnType<typeof spawn>,
  close: Promise<void>,
  rootExitObserved: () => boolean,
  windowsProcessTreeTermination: BoundedWindowsProcessTreeTermination | undefined,
  hooks: BoundedProcessOptions["teardownHooksForTesting"],
): Promise<Readonly<{ readonly rootClosed: boolean; readonly treeConfirmed: boolean }>> {
  const pid = child.pid;
  const terminationTimeoutMs = hooks?.terminationTimeoutMs ?? TREE_TERMINATION_TIMEOUT_MS;
  const termGraceMs = hooks?.termGraceMs ?? TERM_GRACE_MS;
  const platform = hooks?.platform ?? (process.platform === "win32" ? "win32" : "posix");
  if (platform === "win32" && pid !== undefined && pid > 0) {
    // /T /F must bind the still-actionable root PID before any direct signal.
    const treeConfirmed = await booleanWithin(
      hooks?.taskkillTree === undefined
        ? runBoundedWindowsProcessTreeTermination(
            pid,
            windowsProcessTreeTermination,
            rootExitObserved,
            terminationTimeoutMs,
            hooks?.spawnTerminationHelper ?? spawn,
          )
        : rootExitObserved() ? Promise.resolve(false) : hooks.taskkillTree(pid),
      terminationTimeoutMs,
    );
    try { child.kill("SIGKILL"); } catch { /* root may already have exited */ }
    const rootClosed = await waitBounded(close, terminationTimeoutMs);
    destroyOutputHandles(child);
    child.unref();
    return Object.freeze({ rootClosed, treeConfirmed });
  }

  const signalGroup = hooks?.signalProcessGroup ?? ((groupPid: number, signal: NodeJS.Signals | 0) => {
    process.kill(-groupPid, signal);
  });
  const groupGone = hooks?.processGroupIsGone ?? processGroupIsGone;
  if (pid !== undefined && pid > 0) {
    try { signalGroup(pid, "SIGTERM"); } catch { /* group may already be gone */ }
  }
  try { child.kill("SIGTERM"); } catch { /* root may already have exited */ }
  await waitBounded(close, termGraceMs);
  if (pid !== undefined && pid > 0) {
    try { signalGroup(pid, "SIGKILL"); } catch { /* group may already be gone */ }
  }
  try { child.kill("SIGKILL"); } catch { /* root may already have exited */ }
  const [rootClosed, treeConfirmed] = await Promise.all([
    waitBounded(close, terminationTimeoutMs),
    pid === undefined || pid <= 0
      ? Promise.resolve(false)
      : waitForProcessGroupExit(pid, terminationTimeoutMs, groupGone),
  ]);
  destroyOutputHandles(child);
  child.unref();
  return Object.freeze({ rootClosed, treeConfirmed });
}

const confirmationFailure = (
  confirmation: Readonly<{ readonly rootClosed: boolean; readonly treeConfirmed: boolean }>,
): ProcessTreeTerminationUnconfirmedError["confirmationFailure"] =>
  confirmation.rootClosed
    ? "tree_death_unconfirmed"
    : confirmation.treeConfirmed ? "root_close_unconfirmed" : "root_and_tree_unconfirmed";

function validateOptions(options: BoundedProcessOptions): void {
  if (!options.command.trim() || options.command.includes("\0")) {
    throw new BoundedProcessError(
      "Process command must be non-empty and contain no NUL byte.",
      options,
      "",
      "",
    );
  }
  if (
    options.args.some(
      (argument) => argument.includes("\0") || argument.includes("\r") || argument.includes("\n"),
    )
  ) {
    throw new BoundedProcessError(
      "Process arguments must not contain NUL bytes or line breaks.",
      options,
      "",
      "",
    );
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new BoundedProcessError("Process timeout must be a positive integer.", options, "", "");
  }
  if (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0) {
    throw new BoundedProcessError(
      "Process output limit must be a positive integer.",
      options,
      "",
      "",
    );
  }
}

export const runBoundedProcess: BoundedProcessRunner = async (
  options,
): Promise<BoundedProcessResult> => {
  validateOptions(options);
  if (options.signal?.aborted) {
    throw new ProcessAbortError("Process invocation was aborted before spawn.", options, "", "");
  }

  const startedAt = new Date().toISOString();
  const started = performance.now();

  return await new Promise<BoundedProcessResult>((resolve, reject) => {
    const child = (options.spawnForTesting ?? spawn)(options.command, [...options.args], {
      cwd: options.cwd,
      env: { ...options.env },
      detached: process.platform !== "win32",
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let markChildClosed: (() => void) | undefined;
    const childClosed = new Promise<void>((resolve) => { markChildClosed = resolve; });
    child.once("close", () => markChildClosed?.());
    let rootExitObserved = false;
    child.once("exit", () => { rootExitObserved = true; });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let terminalError: BoundedProcessError | undefined;
    let settled = false;
    let termination: Promise<Readonly<{ readonly rootClosed: boolean; readonly treeConfirmed: boolean }>> | undefined;

    const capturedStdout = (): string => Buffer.concat(stdoutChunks).toString("utf8");
    const capturedStderr = (): string => Buffer.concat(stderrChunks).toString("utf8");

    const stop = (error: BoundedProcessError, rootIdentityGone = rootExitObserved): void => {
      if (terminalError === undefined) {
        terminalError = error;
        cleanup();
        if (rootIdentityGone) {
          termination = waitBounded(childClosed, TREE_TERMINATION_TIMEOUT_MS).then(() =>
            Object.freeze({ rootClosed: true, treeConfirmed: false }));
          void termination.then(() => {
            destroyOutputHandles(child);
            child.unref();
            rejectOnce(new ProcessTreeTerminationUnconfirmedError(
              "Bounded process tree cannot be confirmed after the root process exited.",
              options,
              capturedStdout(),
              capturedStderr(),
              error.name,
              "tree_death_unconfirmed",
              error,
            ));
          });
          return;
        }
        termination = terminateProcessTree(
          child,
          childClosed,
          () => rootExitObserved,
          options.windowsProcessTreeTermination,
          options.teardownHooksForTesting,
        )
          .catch(() => Object.freeze({ rootClosed: false, treeConfirmed: false }));
        void termination.then((confirmation) => rejectOnce(confirmation.rootClosed && confirmation.treeConfirmed
          ? error
          : new ProcessTreeTerminationUnconfirmedError(
              "Bounded process-tree termination could not be confirmed.",
              options,
              capturedStdout(),
              capturedStderr(),
              error.name,
              confirmationFailure(confirmation),
              error,
            )));
      }
    };

    const append = (stream: "stdout" | "stderr", chunk: Buffer | string): void => {
      if (terminalError !== undefined) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const currentBytes = stream === "stdout" ? stdoutBytes : stderrBytes;
      const remaining = options.maxOutputBytes - currentBytes;
      const accepted = remaining > 0 ? data.subarray(0, remaining) : Buffer.alloc(0);

      if (stream === "stdout") {
        if (accepted.length > 0) stdoutChunks.push(accepted);
        stdoutBytes += data.length;
      } else {
        if (accepted.length > 0) stderrChunks.push(accepted);
        stderrBytes += data.length;
      }

      if (data.length > remaining) {
        stop(
          new ProcessOutputLimitError(
            `${stream} exceeded the ${options.maxOutputBytes}-byte capture limit.`,
            options,
            capturedStdout(),
            capturedStderr(),
          ),
        );
      }
    };

    child.stdout.on("data", (chunk: Buffer | string) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer | string) => append("stderr", chunk));
    const streamFailure = (stream: "stdout" | "stderr"): void => {
      stop(new BoundedProcessError(
        `${stream} stream failed during bounded process capture.`,
        options,
        capturedStdout(),
        capturedStderr(),
      ));
    };
    child.stdout.once("error", () => streamFailure("stdout"));
    child.stderr.once("error", () => streamFailure("stderr"));

    const timeout = setTimeout(() => {
      stop(
        new ProcessTimeoutError(
          `Process exceeded its ${options.timeoutMs} ms timeout.`,
          options,
          capturedStdout(),
          capturedStderr(),
        ),
      );
    }, options.timeoutMs);
    timeout.unref();

    const onAbort = (): void => {
      stop(
        new ProcessAbortError(
          "Process invocation was aborted.",
          options,
          capturedStdout(),
          capturedStderr(),
        ),
      );
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    function cleanup(): void {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    }

    const rejectOnce = (error: BoundedProcessError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    child.once("error", (error) => {
      if (terminalError !== undefined) {
        if (termination === undefined) rejectOnce(terminalError);
        return;
      }
      if (rootExitObserved) {
        stop(new BoundedProcessError(
          `Process reported an error after exit: ${error.message}`,
          options,
          capturedStdout(),
          capturedStderr(),
          { cause: error },
        ));
        return;
      }
      rejectOnce(
        new BoundedProcessError(
          `Failed to spawn process: ${error.message}`,
          options,
          capturedStdout(),
          capturedStderr(),
          { cause: error },
        ),
      );
    });

    child.once("close", (code, signal) => {
      if (settled) return;

      if (terminalError !== undefined) {
        if (termination === undefined) {
          rejectOnce(terminalError);
        }
        return;
      }
      if (code === null) {
        stop(new BoundedProcessError(
          `Process terminated without an exit code${signal === null ? "." : ` (${signal}).`}`,
          options,
          capturedStdout(),
          capturedStderr(),
        ), true);
        return;
      }
      cleanup();
      settled = true;
      resolve({
        command: options.command,
        args: [...options.args],
        cwd: options.cwd,
        exitCode: code,
        stdout: capturedStdout(),
        stderr: capturedStderr(),
        durationMs: Math.round((performance.now() - started) * 1000) / 1000,
        startedAt,
      });
    });
  });
};
