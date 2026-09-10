import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { link, open, readFile, rename, rm, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalJson } from "../core/canonical.js";
import { DomainError } from "../domain/errors.js";
import type { DurabilityBarrierObserver } from "./durability.js";

interface LegacyLockOwner {
  readonly schemaVersion: "evleda.file-lock.v1";
  readonly pid: number;
  readonly nonce: string;
  readonly createdAt: string;
}

interface IncarnationBoundLockOwner {
  readonly schemaVersion: "evleda.file-lock.v2";
  readonly pid: number;
  readonly processInstance: string;
  readonly nonce: string;
  readonly createdAt: string;
}

type LockOwner = LegacyLockOwner | IncarnationBoundLockOwner;

const processInstanceDigest = (raw: string): string =>
  createHash("sha256").update(raw, "utf8").digest("hex");

const PROCESS_HELPER_TIMEOUT_MS = 2_000;
const PROCESS_HELPER_MAX_OUTPUT_BYTES = 4_096;
export const SUPPORTED_DURABLE_FILE_LOCK_PLATFORMS = Object.freeze([
  "win32",
  "linux",
  "darwin",
  "freebsd"
] as const);

type SupportedDurableFileLockPlatform =
  (typeof SUPPORTED_DURABLE_FILE_LOCK_PLATFORMS)[number];

const supportedFileLockPlatform = (
  platform: string
): platform is SupportedDurableFileLockPlatform =>
  (SUPPORTED_DURABLE_FILE_LOCK_PLATFORMS as readonly string[]).includes(platform);

const assertSupportedFileLockPlatform = (platform: string): void => {
  if (supportedFileLockPlatform(platform)) return;
  const boundedPlatform = /^[a-z0-9_]{1,32}$/u.test(platform) ? platform : "unknown";
  throw new DomainError(
    "TOOLCHAIN_UNSUPPORTED",
    "Durable file locks are unsupported on this host platform",
    {
      platform: boundedPlatform,
      supportedPlatforms: SUPPORTED_DURABLE_FILE_LOCK_PLATFORMS
    }
  );
};

export interface ProcessHelperRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly shell: false;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export type ProcessHelperRunner = (
  request: ProcessHelperRequest
) => Promise<string | undefined>;

const normalizeHelperOutput = (stdout: string, maximumBytes: number): string | undefined => {
  if (Buffer.byteLength(stdout, "utf8") > maximumBytes || stdout.includes("\0")) return undefined;
  const normalized = stdout.replace(/\r\n?/gu, "\n").trim();
  if (normalized.length === 0 || normalized.includes("\n")) return undefined;
  return normalized;
};

export const runBoundedProcessHelper: ProcessHelperRunner = (request) => new Promise((resolve) => {
  if (
    (!path.isAbsolute(request.executable) && !path.win32.isAbsolute(request.executable)) ||
    (!path.isAbsolute(request.cwd) && !path.win32.isAbsolute(request.cwd)) ||
    request.shell !== false ||
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs <= 0 ||
    request.timeoutMs > PROCESS_HELPER_TIMEOUT_MS ||
    !Number.isSafeInteger(request.maxOutputBytes) ||
    request.maxOutputBytes <= 0 ||
    request.maxOutputBytes > PROCESS_HELPER_MAX_OUTPUT_BYTES
  ) {
    resolve(undefined);
    return;
  }
  execFile(
    request.executable,
    [...request.args],
    {
      cwd: request.cwd,
      encoding: "utf8",
      env: { ...request.env },
      killSignal: "SIGKILL",
      maxBuffer: request.maxOutputBytes,
      shell: false,
      timeout: request.timeoutMs,
      windowsHide: true
    },
    (error, stdout) => resolve(
      error === null
        ? normalizeHelperOutput(stdout, request.maxOutputBytes)
        : undefined
    )
  );
});

const readLinuxProcessInstance = async (pid: number): Promise<string | undefined> => {
  try {
    const [bootId, processStat] = await Promise.all([
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      readFile(`/proc/${String(pid)}/stat`, "utf8")
    ]);
    const closingParenthesis = processStat.lastIndexOf(")");
    if (closingParenthesis < 0) return undefined;
    const fieldsFromState = processStat.slice(closingParenthesis + 2).trim().split(/\s+/u);
    const startTicks = fieldsFromState[19];
    if (startTicks === undefined || !/^[0-9]+$/u.test(startTicks)) return undefined;
    return processInstanceDigest(`linux:${bootId.trim()}:${startTicks}`);
  } catch {
    return undefined;
  }
};

const windowsRoot = (candidate: string | undefined): string | undefined => {
  if (candidate === undefined || candidate.includes("\0") || !path.win32.isAbsolute(candidate)) {
    return undefined;
  }
  const normalized = path.win32.normalize(candidate);
  return /^[a-z]:\\windows\\?$/iu.test(normalized)
    ? normalized.replace(/\\+$/u, "")
    : undefined;
};

const ambientWindowsRoot = (
  environment: Readonly<NodeJS.ProcessEnv>
): string | undefined => {
  const systemRoot = environment.SystemRoot === undefined
    ? undefined
    : windowsRoot(environment.SystemRoot);
  const windowsDirectory = environment.WINDIR === undefined
    ? undefined
    : windowsRoot(environment.WINDIR);
  if (
    (environment.SystemRoot !== undefined && systemRoot === undefined) ||
    (environment.WINDIR !== undefined && windowsDirectory === undefined) ||
    (
      systemRoot !== undefined &&
      windowsDirectory !== undefined &&
      systemRoot.toLowerCase() !== windowsDirectory.toLowerCase()
    )
  ) {
    return undefined;
  }
  return systemRoot ?? windowsDirectory;
};

const readWindowsProcessInstance = async (
  pid: number,
  systemRoot: string,
  runner: ProcessHelperRunner
): Promise<string | undefined> => {
  const systemDrive = path.win32.parse(systemRoot).root.replace(/\\+$/u, "");
  const system32 = path.win32.join(systemRoot, "System32");
  const powershell = path.win32.join(
    system32,
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const ticks = await runner(Object.freeze({
    executable: powershell,
    args: Object.freeze([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `[Diagnostics.Process]::GetProcessById(${String(pid)}).StartTime.ToUniversalTime().Ticks`
    ]),
    cwd: systemRoot,
    // libuv fills a small Windows-required set from the parent when omitted.
    // Override that entire set so PATH/profile/account values cannot leak from
    // the daemon. PowerShell runs with -NoProfile and needs no user home.
    env: Object.freeze({
      HOMEDRIVE: systemDrive,
      HOMEPATH: "\\",
      LOGONSERVER: "",
      PATH: `${path.win32.dirname(powershell)};${system32}`,
      SYSTEMDRIVE: systemDrive,
      SYSTEMROOT: systemRoot,
      TEMP: path.win32.join(systemRoot, "Temp"),
      TMP: path.win32.join(systemRoot, "Temp"),
      USERDOMAIN: "",
      USERNAME: "evleda-helper",
      USERPROFILE: systemRoot,
      WINDIR: systemRoot
    }),
    shell: false,
    timeoutMs: PROCESS_HELPER_TIMEOUT_MS,
    maxOutputBytes: PROCESS_HELPER_MAX_OUTPUT_BYTES
  }));
  return ticks === undefined || ticks.length > 24 || !/^[0-9]+$/u.test(ticks)
    ? undefined
    : processInstanceDigest(`win32:${ticks}`);
};

const readPosixProcessInstance = async (
  pid: number,
  platform: "darwin" | "freebsd",
  runner: ProcessHelperRunner
): Promise<string | undefined> => {
  const started = await runner(Object.freeze({
    executable: "/bin/ps",
    args: Object.freeze(["-o", "lstart=", "-p", String(pid)]),
    cwd: "/",
    // ps renders lstart in local time. POSIX TZ=UTC0 fixes both offset and DST
    // so a host timezone change cannot alter a live process incarnation.
    env: Object.freeze({ LANG: "C", LC_ALL: "C", TZ: "UTC0" }),
    shell: false,
    timeoutMs: PROCESS_HELPER_TIMEOUT_MS,
    maxOutputBytes: PROCESS_HELPER_MAX_OUTPUT_BYTES
  }));
  return started === undefined || !/^[\x20-\x7e]{1,160}$/u.test(started)
    ? undefined
    : processInstanceDigest(`${platform}:${started}`);
};

export type ProcessInstanceProbe = (pid: number) => Promise<string | undefined>;

export interface PlatformProcessInstanceProbeOptions {
  readonly platform?: NodeJS.Platform;
  readonly ambientEnvironment?: Readonly<NodeJS.ProcessEnv>;
  readonly trustedWindowsRoot?: string;
  readonly runner?: ProcessHelperRunner;
}

export const createPlatformProcessInstanceProbe = (
  options: PlatformProcessInstanceProbeOptions = {}
): ProcessInstanceProbe => {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? runBoundedProcessHelper;
  const ambient = options.ambientEnvironment ?? process.env;
  const systemRoot = platform === "win32"
    ? options.trustedWindowsRoot === undefined
      ? ambientWindowsRoot(ambient)
      : windowsRoot(options.trustedWindowsRoot)
    : undefined;
  return (pid) => platform === "linux"
    ? readLinuxProcessInstance(pid)
    : platform === "win32"
      ? systemRoot === undefined
        ? Promise.resolve(undefined)
        : readWindowsProcessInstance(pid, systemRoot, runner)
      : platform === "darwin" || platform === "freebsd"
        ? readPosixProcessInstance(pid, platform, runner)
        : Promise.resolve(undefined);
};

const defaultProcessInstanceProbe = createPlatformProcessInstanceProbe();

interface ProcessInstanceCacheEntry {
  readonly expiresAt: number;
  readonly value: string;
}

interface ProcessInstanceObservation {
  readonly cached: boolean;
  readonly value: string | undefined;
}

const processInstanceCaches = new WeakMap<
  ProcessInstanceProbe,
  Map<number, ProcessInstanceCacheEntry>
>();

const processInstanceFor = async (
  pid: number,
  probe: ProcessInstanceProbe = defaultProcessInstanceProbe,
  now: () => number = Date.now,
  forceFresh = false
): Promise<ProcessInstanceObservation> => {
  let cache = processInstanceCaches.get(probe);
  if (cache === undefined) {
    cache = new Map<number, ProcessInstanceCacheEntry>();
    processInstanceCaches.set(probe, cache);
  }
  const observedAt = now();
  const cached = cache.get(pid);
  if (!forceFresh && cached !== undefined && cached.expiresAt > observedAt) {
    return { cached: true, value: cached.value };
  }
  const value = await probe(pid);
  if (value !== undefined && /^[0-9a-f]{64}$/u.test(value)) {
    cache.set(pid, { expiresAt: observedAt + 250, value });
    return { cached: false, value };
  }
  // Absence and malformed observations are never cached: they are not
  // positive evidence about a process incarnation.
  cache.delete(pid);
  return { cached: false, value: undefined };
};

let ownProcessInstance: Promise<string | undefined> | undefined;

const lockOwner = async (): Promise<LockOwner> => {
  ownProcessInstance ??= processInstanceFor(process.pid).then(({ value }) => value);
  const processInstance = await ownProcessInstance;
  if (processInstance === undefined) {
    ownProcessInstance = undefined;
    throw new DomainError(
      "ARTIFACT_INTEGRITY_ERROR",
      "Exclusive lock owner process incarnation could not be authenticated",
      { pid: process.pid, platform: process.platform }
    );
  }
  const common = {
    pid: process.pid,
    nonce: randomUUID(),
    createdAt: new Date().toISOString()
  } as const;
  return { schemaVersion: "evleda.file-lock.v2", processInstance, ...common };
};

const parseLockOwner = (raw: string): LockOwner | undefined => {
  try {
    const owner = JSON.parse(raw) as Partial<LockOwner>;
    const commonValid =
      Number.isSafeInteger(owner.pid) &&
      (owner.pid ?? 0) > 0 &&
      typeof owner.nonce === "string" &&
      owner.nonce.length > 0 &&
      typeof owner.createdAt === "string" &&
      owner.createdAt.length > 0;
    return commonValid && (
      owner.schemaVersion === "evleda.file-lock.v1" ||
      (
        owner.schemaVersion === "evleda.file-lock.v2" &&
        "processInstance" in owner &&
        typeof owner.processInstance === "string" &&
        /^[0-9a-f]{64}$/u.test(owner.processInstance)
      )
    )
      ? owner as LockOwner
      : undefined;
  } catch {
    return undefined;
  }
};

const processIsAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const staleOwner = async (
  lockPath: string,
  staleAfterMs: number,
  options: ExclusiveFileLockOptions = {}
): Promise<boolean> => {
  try {
    const metadata = await stat(lockPath);
    const raw = await readFile(lockPath, "utf8");
    const owner = parseLockOwner(raw);
    if (owner !== undefined) {
      if (owner.schemaVersion === "evleda.file-lock.v2") {
        const probe = options.processInstanceProbe ?? defaultProcessInstanceProbe;
        const clock = options.processInstanceClock ?? Date.now;
        const observed = await processInstanceFor(owner.pid, probe, clock);
        if (observed.value === owner.processInstance) return false;
        if (observed.value !== undefined) {
          if (!observed.cached) return true;
          // A PID-only cache may describe the prior incarnation. Never act on
          // a cached mismatch: refresh the OS identity before reclamation.
          const refreshed = await processInstanceFor(owner.pid, probe, clock, true);
          if (refreshed.value !== undefined) {
            return refreshed.value !== owner.processInstance;
          }
        }
      }
      return !(options.processAliveProbe ?? processIsAlive)(owner.pid);
    }
    return Date.now() - metadata.mtimeMs >= staleAfterMs;
  } catch {
    return false;
  }
};

const tryAcquireReclaimGuard = async (
  lockPath: string,
  staleAfterMs: number,
  options: ExclusiveFileLockOptions = {}
): Promise<(() => Promise<void>) | undefined> => {
  const guardPath = `${lockPath}.reclaim`;
  const owner = await lockOwner();
  const claimPath = `${guardPath}.claim-${owner.nonce}`;
  const handle: FileHandle = await open(claimPath, "wx");
  try {
    try {
      await handle.writeFile(`${canonicalJson(owner)}\n`, "utf8");
      // Claim files are live-process coordination, not durable state. Awaiting
      // the descriptor write and close makes the complete owner bytes visible
      // before link(2) publishes the inode; surviving a power loss is neither
      // required nor useful for an ephemeral lease.
    } finally {
      await handle.close();
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await link(claimPath, guardPath);
        let releasePromise: Promise<void> | undefined;
        return () => {
          if (releasePromise === undefined) {
            const pending = (async () => {
              const current = parseLockOwner(await readFile(guardPath, "utf8"));
              if (current === undefined || canonicalJson(current) !== canonicalJson(owner)) {
                throw new DomainError(
                  "ARTIFACT_INTEGRITY_ERROR",
                  "Exclusive lock reclaim-guard ownership changed before release",
                  { guardPath }
                );
              }
              await rm(guardPath);
            })();
            releasePromise = pending;
            void pending.catch(() => {
              if (releasePromise === pending) releasePromise = undefined;
            });
          }
          return releasePromise;
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        if (!(await staleOwner(guardPath, staleAfterMs, options))) {
          return undefined;
        }
        const quarantined = `${guardPath}.stale-${randomUUID()}`;
        try {
          await rename(guardPath, quarantined);
          await rm(quarantined, { force: true });
        } catch (recoveryError) {
          if ((recoveryError as NodeJS.ErrnoException).code !== "ENOENT") {
            return undefined;
          }
        }
      }
    }
    return undefined;
  } finally {
    await rm(claimPath, { force: true });
  }
};

export interface ExclusiveFileLockOptions {
  readonly timeoutMs?: number;
  readonly staleAfterMs?: number;
  readonly retryDelayMs?: number;
  /** Counts barriers without replacing or weakening them. */
  readonly durabilityObserver?: DurabilityBarrierObserver;
  /** Test-only boundary after complete claim close and before publication. */
  readonly claimPreparedHook?: (claimPath: string, lockPath: string) => void | Promise<void>;
  /** Trusted test seam for deterministic PID-incarnation transitions. */
  readonly processInstanceProbe?: ProcessInstanceProbe;
  /** Trusted test seam for the short positive-identity cache clock. */
  readonly processInstanceClock?: () => number;
  /** Trusted test seam used only when an incarnation probe is unavailable. */
  readonly processAliveProbe?: (pid: number) => boolean;
  /** Trusted test seam for explicit unsupported-platform admission coverage. */
  readonly platformForTesting?: NodeJS.Platform;
}

export const reclaimStaleExactFileLock = async (
  lockPath: string,
  expectedBytes: Uint8Array,
  staleAfterMs = 120_000,
  durabilityObserver?: DurabilityBarrierObserver
): Promise<void> => {
  assertSupportedFileLockPlatform(process.platform);
  const options: ExclusiveFileLockOptions = {
    ...(durabilityObserver === undefined ? {} : { durabilityObserver })
  };
  const expected = Buffer.from(expectedBytes);
  const current = await readFile(lockPath);
  if (!current.equals(expected) || !(await staleOwner(lockPath, staleAfterMs, options))) {
    throw new DomainError("STAGE_ALREADY_RUNNING", "Prepared transaction lock is still live", {
      lockPath
    }, true);
  }
  const releaseGuard = await tryAcquireReclaimGuard(
    lockPath,
    staleAfterMs,
    options
  );
  if (releaseGuard === undefined) {
    throw new DomainError("STAGE_ALREADY_RUNNING", "Prepared transaction lock recovery is busy", {
      lockPath
    }, true);
  }
  try {
    const guarded = await readFile(lockPath);
    if (!guarded.equals(expected) || !(await staleOwner(lockPath, staleAfterMs, options))) {
      throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Prepared transaction lock changed during recovery");
    }
    const quarantined = `${lockPath}.stale-${randomUUID()}`;
    await rename(lockPath, quarantined);
    await rm(quarantined, { force: true });
  } finally {
    await releaseGuard();
  }
};

export const acquireExclusiveFileLock = async (
  lockPath: string,
  options: ExclusiveFileLockOptions = {}
): Promise<() => Promise<void>> => {
  assertSupportedFileLockPlatform(options.platformForTesting ?? process.platform);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const staleAfterMs = options.staleAfterMs ?? 120_000;
  const retryDelayMs = options.retryDelayMs ?? 25;
  const startedAt = Date.now();
  const owner = await lockOwner();
  const claimPath = `${lockPath}.claim-${owner.nonce}`;
  const claimHandle = await open(claimPath, "wx");
  try {
    try {
      await claimHandle.writeFile(`${canonicalJson(owner)}\n`, "utf8");
      // See the reclaim-guard claim above: publication happens only after this
      // complete write is closed, while crash recovery treats leases as stale
      // coordination rather than durable application data.
    } finally {
      await claimHandle.close();
    }
    await options.claimPreparedHook?.(claimPath, lockPath);

    while (true) {
      try {
        await link(claimPath, lockPath);
        let releasePromise: Promise<void> | undefined;
        return () => {
          if (releasePromise === undefined) {
            let ownershipVerified = false;
            const pending = (async () => {
              const current = parseLockOwner(await readFile(lockPath, "utf8"));
              if (current === undefined || canonicalJson(current) !== canonicalJson(owner)) {
                throw new DomainError(
                  "ARTIFACT_INTEGRITY_ERROR",
                  "Exclusive lock ownership changed before release",
                  { lockPath }
                );
              }
              ownershipVerified = true;
              await rm(lockPath);
            })().catch((error: unknown) => {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                if (ownershipVerified) return;
                throw new DomainError(
                  "ARTIFACT_INTEGRITY_ERROR",
                  "Exclusive lock disappeared before its owner released it",
                  { lockPath }
                );
              }
              throw error;
            });
            releasePromise = pending;
            void pending.catch(() => {
              if (releasePromise === pending) releasePromise = undefined;
            });
          }
          return releasePromise;
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }

        if (await staleOwner(lockPath, staleAfterMs, options)) {
          const releaseReclaimGuard = await tryAcquireReclaimGuard(
            lockPath,
            staleAfterMs,
            options
          );
          let reclaimed = false;
          if (releaseReclaimGuard !== undefined) {
            try {
              if (await staleOwner(lockPath, staleAfterMs, options)) {
                const quarantined = `${lockPath}.stale-${randomUUID()}`;
                try {
                  await rename(lockPath, quarantined);
                  await rm(quarantined, { force: true });
                  reclaimed = true;
                } catch (recoveryError) {
                  if ((recoveryError as NodeJS.ErrnoException).code !== "ENOENT") {
                    await delay(retryDelayMs);
                  }
                }
              }
            } finally {
              await releaseReclaimGuard();
            }
            if (reclaimed) {
              continue;
            }
          }
        }

        if (Date.now() - startedAt >= timeoutMs) {
          throw new DomainError(
            "STAGE_ALREADY_RUNNING",
            "Timed out waiting for the exclusive file lease",
            { lockPath, timeoutMs },
            true
          );
        }
        await delay(retryDelayMs);
      }
    }
  } finally {
    await rm(claimPath, { force: true });
  }
};
