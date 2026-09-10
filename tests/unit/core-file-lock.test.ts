import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireExclusiveFileLock,
  createPlatformProcessInstanceProbe,
  runBoundedProcessHelper,
  SUPPORTED_DURABLE_FILE_LOCK_PLATFORMS,
  type ProcessHelperRequest
} from "../../src/persistence/file-lock.js";
import type { DurabilityBarrierObservation } from "../../src/persistence/durability.js";

const roots: string[] = [];

const makeLockPath = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "evleda-file-lock-"));
  roots.push(root);
  return path.join(root, "exclusive.lock");
};

const exitedChildPid = async (): Promise<number> => {
  const child = spawn(process.execPath, ["-e", ""], { windowsHide: true, stdio: "ignore" });
  const pid = child.pid;
  if (pid === undefined) throw new Error("Child process did not receive a PID");
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  return pid;
};

const waitForFile = async (file: string): Promise<void> => {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    try {
      await access(file);
      return;
    } catch {
      await delay(5);
    }
  }
  throw new Error(`Timed out waiting for ${file}`);
};

interface WorkerInterval {
  readonly workerId: string;
  readonly pid: number;
  readonly enteredAt: number;
  readonly exitedAt: number;
  readonly observedOwnerBytes: number;
}

const v2Owner = (pid: number, processInstance: string, nonce: string) => ({
  schemaVersion: "evleda.file-lock.v2" as const,
  pid,
  processInstance,
  nonce,
  createdAt: "2026-09-07T00:00:00.000Z"
});

const expectedWindowsHelperEnvironment = {
  HOMEDRIVE: "C:",
  HOMEPATH: "\\",
  LOGONSERVER: "",
  PATH: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0;C:\\Windows\\System32",
  SYSTEMDRIVE: "C:",
  SYSTEMROOT: "C:\\Windows",
  TEMP: "C:\\Windows\\Temp",
  TMP: "C:\\Windows\\Temp",
  USERDOMAIN: "",
  USERNAME: "evleda-helper",
  USERPROFILE: "C:\\Windows",
  WINDIR: "C:\\Windows"
} as const;

const spawnLockWorker = (
  lockPath: string,
  readyFile: string,
  startFile: string,
  resultFile: string,
  workerId: string
): Promise<WorkerInterval> => new Promise((resolve, reject) => {
  const child = spawn(
    process.execPath,
    [
      path.resolve("node_modules", "tsx", "dist", "cli.mjs"),
      path.resolve("tests", "fixtures", "file-lock-worker.ts"),
      lockPath,
      readyFile,
      startFile,
      resultFile,
      workerId
    ],
    { cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "ignore", "pipe"] }
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const timer = setTimeout(() => {
    child.kill();
    reject(new Error(`File-lock worker timed out: ${stderr}`));
  }, 15_000);
  child.once("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.once("exit", async (code) => {
    clearTimeout(timer);
    if (code !== 0) {
      reject(new Error(`File-lock worker exited ${String(code)}: ${stderr}`));
      return;
    }
    try {
      resolve(JSON.parse(await readFile(resultFile, "utf8")) as WorkerInterval);
    } catch (error) {
      reject(error);
    }
  });
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("acquireExclusiveFileLock", () => {
  it.each(["aix", "sunos", "haiku"] as const)(
    "rejects unsupported %s lock admission before helper execution or claim creation",
    async (platform) => {
      const lockPath = await makeLockPath();
      let helperCalls = 0;
      let instanceProbeCalls = 0;
      let claimHooks = 0;
      const unsupportedProbe = createPlatformProcessInstanceProbe({
        platform,
        runner: async () => {
          helperCalls += 1;
          return "unexpected";
        }
      });
      await expect(unsupportedProbe(123)).resolves.toBeUndefined();

      await expect(acquireExclusiveFileLock(lockPath, {
        platformForTesting: platform,
        processInstanceProbe: async () => {
          instanceProbeCalls += 1;
          return "a".repeat(64);
        },
        claimPreparedHook: () => { claimHooks += 1; }
      })).rejects.toMatchObject({
        code: "TOOLCHAIN_UNSUPPORTED",
        message: "Durable file locks are unsupported on this host platform",
        details: {
          platform,
          supportedPlatforms: ["win32", "linux", "darwin", "freebsd"]
        },
        retryable: false
      });
      expect(helperCalls).toBe(0);
      expect(instanceProbeCalls).toBe(0);
      expect(claimHooks).toBe(0);
      expect(await readdir(path.dirname(lockPath))).toEqual([]);
    }
  );

  it("bounds an unknown unsupported platform in its stable admission error", async () => {
    const lockPath = await makeLockPath();
    const hostilePlatform = `unknown-${"界".repeat(1_000)}` as NodeJS.Platform;

    const failure = await acquireExclusiveFileLock(lockPath, {
      platformForTesting: hostilePlatform
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "TOOLCHAIN_UNSUPPORTED",
      message: "Durable file locks are unsupported on this host platform",
      details: {
        platform: "unknown",
        supportedPlatforms: SUPPORTED_DURABLE_FILE_LOCK_PLATFORMS
      },
      retryable: false
    });
    expect((failure as Error).message.length).toBeLessThan(80);
    expect(await readdir(path.dirname(lockPath))).toEqual([]);
  });

  it("launches the Windows incarnation helper with an absolute path and minimal environment", async () => {
    const captured: ProcessHelperRequest[] = [];
    const secretValues = [
      "path-poison-秘密",
      "comspec-poison",
      "proxy-secret",
      "openai-secret",
      "anthropic-secret",
      "github-secret",
      "git-askpass-secret",
      "ssh-agent-secret",
      "mixed-case-path-secret",
      "mixed-case-comspec-secret"
    ];
    const probe = createPlatformProcessInstanceProbe({
      platform: "win32",
      ambientEnvironment: {
        PATH: secretValues[0],
        Path: secretValues[8],
        COMSPEC: secretValues[1],
        ComSpec: secretValues[9],
        HTTP_PROXY: secretValues[2],
        HTTPS_PROXY: secretValues[2],
        OPENAI_API_KEY: secretValues[3],
        ANTHROPIC_API_KEY: secretValues[4],
        GITHUB_TOKEN: secretValues[5],
        GIT_ASKPASS: secretValues[6],
        SSH_AUTH_SOCK: secretValues[7],
        NODE_OPTIONS: "--require=attacker.js",
        SystemRoot: "C:\\Windows"
      },
      runner: async (request) => {
        captured.push(request);
        return "639243755014984166";
      }
    });

    await expect(probe(321)).resolves.toMatch(/^[0-9a-f]{64}$/u);
    expect(captured).toHaveLength(1);
    const request = captured[0]!;
    expect(request.executable).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
    );
    expect(path.win32.isAbsolute(request.executable)).toBe(true);
    expect(request.cwd).toBe("C:\\Windows");
    expect(request.env).toEqual(expectedWindowsHelperEnvironment);
    expect(request).toMatchObject({
      shell: false,
      timeoutMs: 2_000,
      maxOutputBytes: 4_096
    });
    expect(request.args).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Diagnostics.Process]::GetProcessById(321).StartTime.ToUniversalTime().Ticks"
    ]);
    const serializedRequest = JSON.stringify(request);
    for (const secret of secretValues) expect(serializedRequest).not.toContain(secret);
    expect(serializedRequest).not.toContain("NODE_OPTIONS");
  });

  it.each(["darwin", "freebsd"] as const)(
    "uses an absolute ps helper and fixed C locale on supported %s",
    async (platform) => {
    let captured: ProcessHelperRequest | undefined;
    const probe = createPlatformProcessInstanceProbe({
      platform,
      ambientEnvironment: {
        PATH: "/attacker/bin",
        COMSPEC: "attacker",
        ALL_PROXY: "http://proxy-secret",
        AZURE_CLIENT_SECRET: "azure-secret",
        GOOGLE_APPLICATION_CREDENTIALS: "/credential.json",
        GH_TOKEN: "github-secret",
        NPM_TOKEN: "npm-secret",
        "UNICODE_秘密": "値"
      },
      runner: async (request) => {
        captured = request;
        return "Sun Sep  7 04:00:00 2026";
      }
    });

    await expect(probe(654)).resolves.toMatch(/^[0-9a-f]{64}$/u);
    expect(captured).toMatchObject({
      executable: "/bin/ps",
      args: ["-o", "lstart=", "-p", "654"],
      cwd: "/",
      env: { LANG: "C", LC_ALL: "C", TZ: "UTC0" },
      shell: false,
      timeoutMs: 2_000,
      maxOutputBytes: 4_096
    });
    expect(JSON.stringify(captured)).not.toMatch(
      /PATH|COMSPEC|PROXY|AZURE|GOOGLE|GH_TOKEN|NPM_TOKEN|秘密|credential|secret/iu
    );
    }
  );

  it("uses direct procfs rather than any helper for supported Linux", async () => {
    let helperCalls = 0;
    const probe = createPlatformProcessInstanceProbe({
      platform: "linux",
      runner: async () => {
        helperCalls += 1;
        return "unexpected";
      }
    });

    await probe(process.pid);
    expect(helperCalls).toBe(0);
  });

  it("applies the selected portable UTC timezone in a real helper child", async () => {
    const output = await runBoundedProcessHelper({
      executable: process.execPath,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify({tz:process.env.TZ,offset:new Date(0).getTimezoneOffset()}))"
      ],
      cwd: process.cwd(),
      env: { LANG: "C", LC_ALL: "C", TZ: "UTC0" },
      shell: false,
      timeoutMs: 2_000,
      maxOutputBytes: 4_096
    });

    expect(JSON.parse(output!)).toEqual({ tz: "UTC0", offset: 0 });
  });

  it.each(["darwin", "freebsd"] as const)(
    "keeps a live %s owner stable across ambient timezone changes",
    async (platform) => {
      const lockPath = await makeLockPath();
      const requests: ProcessHelperRequest[] = [];
      let simulatedHostTimezone = "America/Los_Angeles";
      const runner = async (request: ProcessHelperRequest): Promise<string> => {
        requests.push(request);
        return request.env.TZ === "UTC0"
          ? "Sun Sep  7 04:00:00 2026"
          : simulatedHostTimezone === "America/Los_Angeles"
            ? "Sat Sep  6 21:00:00 2026"
            : "Sun Sep  7 13:00:00 2026";
      };
      const beforeChange = createPlatformProcessInstanceProbe({
        platform,
        ambientEnvironment: { TZ: simulatedHostTimezone },
        runner
      });
      const originalIdentity = await beforeChange(4_242_428);
      simulatedHostTimezone = "Asia/Tokyo";
      const afterChange = createPlatformProcessInstanceProbe({
        platform,
        ambientEnvironment: { TZ: simulatedHostTimezone },
        runner
      });
      const currentIdentity = await afterChange(4_242_428);
      expect(currentIdentity).toBe(originalIdentity);
      const ownerBytes = `${JSON.stringify(v2Owner(
        4_242_428,
        originalIdentity!,
        `${platform}-timezone-owner`
      ))}\n`;
      await writeFile(lockPath, ownerBytes, "utf8");

      await expect(acquireExclusiveFileLock(lockPath, {
        timeoutMs: 0,
        processInstanceProbe: afterChange,
        processAliveProbe: () => true
      })).rejects.toMatchObject({ code: "STAGE_ALREADY_RUNNING" });

      expect(requests).toHaveLength(3);
      expect(requests.every(({ env }) => env.TZ === "UTC0")).toBe(true);
      expect(await readFile(lockPath, "utf8")).toBe(ownerBytes);
      await expect(access(`${lockPath}.reclaim`)).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it.each([
    "６３９２４３７５５０１４９８４１６６",
    "639243755014984166\nsecond-line",
    "9".repeat(4_097)
  ])("rejects non-canonical or oversized Windows helper output", async (output) => {
    const probe = createPlatformProcessInstanceProbe({
      platform: "win32",
      trustedWindowsRoot: "C:\\Windows",
      runner: async () => output
    });

    await expect(probe(123)).resolves.toBeUndefined();
  });

  it("times out and output-bounds helper subprocesses without a shell", async () => {
    const request = (
      source: string,
      timeoutMs: number,
      maxOutputBytes: number
    ): ProcessHelperRequest => ({
      executable: process.execPath,
      args: ["-e", source],
      cwd: process.cwd(),
      env: {},
      shell: false,
      timeoutMs,
      maxOutputBytes
    });
    const startedAt = Date.now();

    await expect(runBoundedProcessHelper(request(
      "setInterval(() => undefined, 1000)",
      50,
      1_024
    ))).resolves.toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    await expect(runBoundedProcessHelper(request(
      "process.stdout.write('x'.repeat(8192))",
      2_000,
      1_024
    ))).resolves.toBeUndefined();
  });

  it("passes exactly the requested helper environment to a real child", async () => {
    const output = await runBoundedProcessHelper({
      executable: process.execPath,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))"
      ],
      cwd: process.cwd(),
      env: expectedWindowsHelperEnvironment,
      shell: false,
      timeoutMs: 2_000,
      maxOutputBytes: 4_096
    });

    expect(JSON.parse(output!)).toEqual(Object.keys(expectedWindowsHelperEnvironment).sort());
  });

  it("never PATH-resolves a relative helper request", async () => {
    await expect(runBoundedProcessHelper({
      executable: path.basename(process.execPath),
      args: ["--version"],
      cwd: process.cwd(),
      env: { PATH: path.dirname(process.execPath), COMSPEC: "attacker" },
      shell: false,
      timeoutMs: 2_000,
      maxOutputBytes: 4_096
    })).resolves.toBeUndefined();
  });

  it.each([
    "relative\\Windows",
    "C:\\攻撃",
    "\\\\attacker\\Windows",
    "C:\\Windows\\..\\attacker"
  ])("falls back conservatively without invoking a helper for untrusted Windows root %s", async (root) => {
    let calls = 0;
    const probe = createPlatformProcessInstanceProbe({
      platform: "win32",
      trustedWindowsRoot: root,
      runner: async () => {
        calls += 1;
        return "639243755014984166";
      }
    });

    await expect(probe(123)).resolves.toBeUndefined();
    expect(calls).toBe(0);
  });

  it("publishes complete claim bytes without issuing a durability barrier", async () => {
    const lockPath = await makeLockPath();
    const barriers: DurabilityBarrierObservation[] = [];
    let preparedOwner: unknown;
    const release = await acquireExclusiveFileLock(lockPath, {
      durabilityObserver: (barrier) => barriers.push(barrier),
      claimPreparedHook: async (claimPath) => {
        preparedOwner = JSON.parse(await readFile(claimPath, "utf8")) as unknown;
      }
    });

    const publishedBytes = await readFile(lockPath, "utf8");
    expect(JSON.parse(publishedBytes)).toEqual(preparedOwner);
    expect((await stat(lockPath)).isFile()).toBe(true);
    expect((await stat(lockPath)).nlink).toBe(1);
    expect(barriers).toEqual([]);
    await release();
  });

  it("removes an unpublished claim when preparation faults", async () => {
    const lockPath = await makeLockPath();
    await expect(acquireExclusiveFileLock(lockPath, {
      claimPreparedHook: () => {
        throw new Error("simulated claim preparation fault");
      }
    })).rejects.toThrow(/simulated claim preparation fault/iu);

    expect(await readdir(path.dirname(lockPath))).toEqual([]);
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes simultaneous critical sections in distinct operating-system processes", async () => {
    const lockPath = await makeLockPath();
    const root = path.dirname(lockPath);
    const startFile = path.join(root, "start.signal");
    const firstReady = path.join(root, "first.ready");
    const secondReady = path.join(root, "second.ready");
    const firstResult = path.join(root, "first.result.json");
    const secondResult = path.join(root, "second.result.json");
    const first = spawnLockWorker(
      lockPath,
      firstReady,
      startFile,
      firstResult,
      "first"
    );
    const second = spawnLockWorker(
      lockPath,
      secondReady,
      startFile,
      secondResult,
      "second"
    );
    await Promise.all([waitForFile(firstReady), waitForFile(secondReady)]);
    await writeFile(startFile, "start\n", "utf8");

    const workers = await Promise.all([first, second]);
    const ordered = [...workers].sort((left, right) => left.enteredAt - right.enteredAt);
    expect(new Set(workers.map(({ pid }) => pid)).size).toBe(2);
    expect(workers.every(({ observedOwnerBytes }) => observedOwnerBytes > 0)).toBe(true);
    expect(ordered[0]!.exitedAt).toBeLessThanOrEqual(ordered[1]!.enteredAt);
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("ignores an orphaned unpublished claim after its process is killed", async () => {
    const lockPath = await makeLockPath();
    const readyFile = path.join(path.dirname(lockPath), "claim.ready");
    const child = spawn(
      process.execPath,
      [
        path.resolve("node_modules", "tsx", "dist", "cli.mjs"),
        path.resolve("tests", "fixtures", "file-lock-claim-crash-worker.ts"),
        lockPath,
        readyFile
      ],
      { cwd: process.cwd(), windowsHide: true, stdio: "ignore" }
    );
    const exited = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => resolve());
    });
    await waitForFile(readyFile);
    const [ownerPidText, orphanClaim] = (await readFile(readyFile, "utf8")).trim().split("\n");
    const ownerPid = Number(ownerPidText);
    expect(orphanClaim).toBeDefined();
    expect(JSON.parse(await readFile(orphanClaim!, "utf8"))).toMatchObject({ pid: ownerPid });
    process.kill(ownerPid);
    await exited;

    const release = await acquireExclusiveFileLock(lockPath, { timeoutMs: 2_000 });
    await release();
    await rm(orphanClaim!, { force: true });
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reclaims a valid lock as soon as its owning process is known dead", async () => {
    const lockPath = await makeLockPath();
    const deadPid = await exitedChildPid();
    await writeFile(
      lockPath,
      `${JSON.stringify({
        schemaVersion: "evleda.file-lock.v1",
        pid: deadPid,
        nonce: "dead-owner",
        createdAt: new Date().toISOString()
      })}\n`,
      "utf8"
    );

    const release = await acquireExclusiveFileLock(lockPath, {
      timeoutMs: 2_000,
      staleAfterMs: 120_000,
      retryDelayMs: 2
    });
    await release();
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reclaims malformed lock metadata only after the stale threshold", async () => {
    const lockPath = await makeLockPath();
    await writeFile(lockPath, "{", "utf8");
    const old = new Date(0);
    await utimes(lockPath, old, old);

    const release = await acquireExclusiveFileLock(lockPath, {
      timeoutMs: 2_000,
      staleAfterMs: 1,
      retryDelayMs: 2
    });
    await release();
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never reclaims a live owner's lock even with a zero stale threshold", async () => {
    const lockPath = await makeLockPath();
    const release = await acquireExclusiveFileLock(lockPath);

    await expect(
      acquireExclusiveFileLock(lockPath, {
        timeoutMs: 50,
        staleAfterMs: 0,
        retryDelayMs: 2
      })
    ).rejects.toMatchObject({ code: "STAGE_ALREADY_RUNNING" });
    await release();
  });

  it("makes concurrent release calls share one successful unlink", async () => {
    const lockPath = await makeLockPath();
    const release = await acquireExclusiveFileLock(lockPath);

    const first = release();
    const second = release();
    const third = release();

    expect(second).toBe(first);
    expect(third).toBe(first);
    await Promise.all([first, second, third]);
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reclaims an orphaned reclaim guard before recovering the stale lease", async () => {
    const lockPath = await makeLockPath();
    const deadPid = await exitedChildPid();
    const owner = (nonce: string) => `${JSON.stringify({
      schemaVersion: "evleda.file-lock.v1",
      pid: deadPid,
      nonce,
      createdAt: "2026-09-04T00:00:00.000Z"
    })}\n`;
    await writeFile(lockPath, owner("stale-owner"), "utf8");
    await writeFile(`${lockPath}.reclaim`, owner("orphaned-reclaimer"), "utf8");

    const release = await acquireExclusiveFileLock(lockPath, {
      timeoutMs: 2_000,
      staleAfterMs: 0,
      retryDelayMs: 2
    });
    await release();

    const remaining = await readdir(path.dirname(lockPath));
    expect(remaining).toEqual([]);
  });

  it("prevents a former owner from deleting a replacement lease", async () => {
    const lockPath = await makeLockPath();
    const releaseFormer = await acquireExclusiveFileLock(lockPath);
    await rm(lockPath);
    const releaseReplacement = await acquireExclusiveFileLock(lockPath);

    await expect(releaseFormer()).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR"
    });
    await expect(access(lockPath)).resolves.toBeUndefined();
    await releaseReplacement();
  });

  it("serializes competing stale-lock reclaimers without overlapping ownership", async () => {
    const lockPath = await makeLockPath();
    const deadPid = await exitedChildPid();
    await writeFile(
      lockPath,
      `${JSON.stringify({
        schemaVersion: "evleda.file-lock.v1",
        pid: deadPid,
        nonce: "stale-owner",
        createdAt: "2026-09-04T00:00:00.000Z"
      })}\n`,
      "utf8"
    );
    let active = 0;
    let maximumActive = 0;
    const contender = async (): Promise<void> => {
      const release = await acquireExclusiveFileLock(lockPath, {
        timeoutMs: 5_000,
        staleAfterMs: 0,
        retryDelayMs: 2
      });
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await delay(10);
      active -= 1;
      await release();
    };

    await Promise.all([contender(), contender(), contender(), contender()]);

    expect(maximumActive).toBe(1);
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(`${lockPath}.reclaim`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reclaims an old process incarnation even when its PID is currently live", async () => {
    const lockPath = await makeLockPath();
    await writeFile(lockPath, `${JSON.stringify({
      schemaVersion: "evleda.file-lock.v2",
      pid: process.pid,
      processInstance: "0".repeat(64),
      nonce: "recycled-pid-owner",
      createdAt: new Date().toISOString()
    })}\n`, "utf8");

    const release = await acquireExclusiveFileLock(lockPath, {
      timeoutMs: 5_000,
      staleAfterMs: 120_000,
      retryDelayMs: 2
    });
    await release();
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refreshes a cached A identity before deciding that a live reused-PID B lock is stale", async () => {
    const lockPath = await makeLockPath();
    const pid = 4_242_424;
    const instanceA = "a".repeat(64);
    const instanceB = "b".repeat(64);
    let probeCalls = 0;
    const probe = async (): Promise<string> => {
      probeCalls += 1;
      return probeCalls === 1 ? instanceA : instanceB;
    };
    const options = {
      timeoutMs: 0,
      retryDelayMs: 1,
      processInstanceProbe: probe,
      processInstanceClock: () => 1_000,
      processAliveProbe: () => true
    } as const;
    await writeFile(lockPath, `${JSON.stringify(v2Owner(pid, instanceA, "owner-a"))}\n`, "utf8");
    await expect(acquireExclusiveFileLock(lockPath, options)).rejects.toMatchObject({
      code: "STAGE_ALREADY_RUNNING"
    });
    const ownerBBytes = `${JSON.stringify(v2Owner(pid, instanceB, "owner-b"))}\n`;
    await writeFile(lockPath, ownerBBytes, "utf8");

    await expect(acquireExclusiveFileLock(lockPath, options)).rejects.toMatchObject({
      code: "STAGE_ALREADY_RUNNING"
    });

    expect(probeCalls).toBe(2);
    expect(await readFile(lockPath, "utf8")).toBe(ownerBBytes);
    await expect(access(`${lockPath}.reclaim`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("forces another fresh mismatch check under the reclaim guard", async () => {
    const lockPath = await makeLockPath();
    const pid = 4_242_425;
    const instanceA = "c".repeat(64);
    const instanceB = "d".repeat(64);
    let clock = 1_000;
    let probeCalls = 0;
    const probe = async (): Promise<string> => {
      probeCalls += 1;
      return probeCalls === 1 ? instanceA : instanceB;
    };
    const options = {
      timeoutMs: 2_000,
      retryDelayMs: 1,
      processInstanceProbe: probe,
      processInstanceClock: () => clock,
      processAliveProbe: () => true
    } as const;
    await writeFile(lockPath, `${JSON.stringify(v2Owner(pid, instanceA, "expired-a"))}\n`, "utf8");
    await expect(acquireExclusiveFileLock(lockPath, { ...options, timeoutMs: 0 }))
      .rejects.toMatchObject({ code: "STAGE_ALREADY_RUNNING" });
    clock += 300;

    const release = await acquireExclusiveFileLock(lockPath, options);

    expect(probeCalls).toBe(3);
    await release();
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("delays process-exit reclamation only until its positive identity cache is refreshed", async () => {
    const lockPath = await makeLockPath();
    const pid = 4_242_426;
    const instance = "e".repeat(64);
    let clock = 1_000;
    let exited = false;
    let probeCalls = 0;
    const probe = async (): Promise<string | undefined> => {
      probeCalls += 1;
      return exited ? undefined : instance;
    };
    const options = {
      timeoutMs: 0,
      retryDelayMs: 1,
      processInstanceProbe: probe,
      processInstanceClock: () => clock,
      processAliveProbe: () => !exited
    } as const;
    await writeFile(lockPath, `${JSON.stringify(v2Owner(pid, instance, "exiting"))}\n`, "utf8");
    await expect(acquireExclusiveFileLock(lockPath, options)).rejects.toMatchObject({
      code: "STAGE_ALREADY_RUNNING"
    });
    exited = true;
    await expect(acquireExclusiveFileLock(lockPath, options)).rejects.toMatchObject({
      code: "STAGE_ALREADY_RUNNING"
    });
    expect(probeCalls).toBe(1);
    clock += 300;

    const release = await acquireExclusiveFileLock(lockPath, { ...options, timeoutMs: 2_000 });

    expect(probeCalls).toBe(3);
    await release();
  });

  it("never caches an unavailable process-incarnation observation", async () => {
    const lockPath = await makeLockPath();
    const pid = 4_242_427;
    const instance = "f".repeat(64);
    let probeCalls = 0;
    const probe = async (): Promise<string | undefined> => {
      probeCalls += 1;
      return probeCalls === 1 ? undefined : instance;
    };
    const options = {
      timeoutMs: 0,
      retryDelayMs: 1,
      processInstanceProbe: probe,
      processInstanceClock: () => 1_000,
      processAliveProbe: () => true
    } as const;
    const bytes = `${JSON.stringify(v2Owner(pid, instance, "positive-only"))}\n`;
    await writeFile(lockPath, bytes, "utf8");

    await expect(acquireExclusiveFileLock(lockPath, options)).rejects.toMatchObject({
      code: "STAGE_ALREADY_RUNNING"
    });
    await expect(acquireExclusiveFileLock(lockPath, options)).rejects.toMatchObject({
      code: "STAGE_ALREADY_RUNNING"
    });

    expect(probeCalls).toBe(2);
    expect(await readFile(lockPath, "utf8")).toBe(bytes);
  });
});
