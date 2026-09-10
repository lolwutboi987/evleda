import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  copyFile,
  link,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  BOUNDED_WINDOWS_PROCESS_TREE_TERMINATION_SCHEMA_VERSION,
  ProcessAbortError,
  ProcessOutputLimitError,
  ProcessTreeTerminationUnconfirmedError,
  ProcessTimeoutError,
  runBoundedProcess,
  type BoundedWindowsProcessTreeTermination,
} from "../../src/integrations/bounded-process.js";

interface ProcessTreeRecord {
  readonly child: number;
  readonly grandchild: number;
}

interface ProcessTreeFixture {
  readonly invocation: ReturnType<typeof runBoundedProcess>;
  readonly pidFile: string;
  readonly heartbeatFile: string;
}

const temporaryRoots: string[] = [];
const cleanupPids = new Set<number>();
const cleanupChildren = new Set<ChildProcess>();

function inheritedEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) env[name] = value;
  }
  return env;
}

async function syntheticWindowsTerminationBinding(
  root: string,
): Promise<BoundedWindowsProcessTreeTermination> {
  const executablePath = path.join(root, "pinned-tree-terminator.exe");
  const bytes = Buffer.from("synthetic exact tree terminator\n", "utf8");
  await writeFile(executablePath, bytes, { flag: "wx" });
  return Object.freeze({
    schemaVersion: BOUNDED_WINDOWS_PROCESS_TREE_TERMINATION_SCHEMA_VERSION,
    executablePath,
    executableIdentity: Object.freeze({
      algorithm: "sha256" as const,
      digest: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    }),
    cwd: root,
    env: Object.freeze({ SYSTEMROOT: "C:\\Windows", WINDIR: "C:\\Windows" }),
  });
}

async function copiedWindowsTerminationBinding(
  root: string,
): Promise<BoundedWindowsProcessTreeTermination | undefined> {
  if (process.platform !== "win32") return undefined;
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (windowsRoot === undefined || !path.win32.isAbsolute(windowsRoot)) {
    throw new Error("Windows tree-termination test requires an explicit system-root source.");
  }
  const source = path.win32.join(windowsRoot, "System32", "taskkill.exe");
  const executablePath = path.join(root, "pinned-tree-terminator.exe");
  await copyFile(source, executablePath);
  const bytes = await readFile(executablePath);
  return Object.freeze({
    schemaVersion: BOUNDED_WINDOWS_PROCESS_TREE_TERMINATION_SCHEMA_VERSION,
    executablePath,
    executableIdentity: Object.freeze({
      algorithm: "sha256" as const,
      digest: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    }),
    cwd: root,
    env: Object.freeze({ SYSTEMROOT: windowsRoot, WINDIR: windowsRoot }),
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await check()) return;
    await delay(20);
  } while (Date.now() < deadline);
  throw new Error(`Condition was not met within ${timeoutMs} ms.`);
}

async function readProcessTreeRecord(pidFile: string): Promise<ProcessTreeRecord> {
  let record: ProcessTreeRecord | undefined;
  await waitUntil(async () => {
    try {
      const parsed = JSON.parse(await readFile(pidFile, "utf8")) as Partial<ProcessTreeRecord>;
      if (
        Number.isSafeInteger(parsed.child) &&
        Number.isSafeInteger(parsed.grandchild) &&
        parsed.child! > 0 &&
        parsed.grandchild! > 0
      ) {
        record = { child: parsed.child!, grandchild: parsed.grandchild! };
        return true;
      }
    } catch {
      // The child has not atomically published both pids yet.
    }
    return false;
  });
  if (record === undefined) throw new Error("Process tree did not publish its pids.");
  return record;
}

async function stopPid(pid: number): Promise<void> {
  if (!isProcessAlive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Best-effort cleanup for a failed assertion.
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await waitUntil(() => child.exitCode !== null || child.signalCode !== null, 2_000).catch(
    () => undefined,
  );
}

afterEach(async () => {
  await Promise.all([...cleanupChildren].map(stopChild));
  cleanupChildren.clear();
  await Promise.all([...cleanupPids].map(stopPid));
  cleanupPids.clear();
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

async function processTreeFixture(
  mode: "quiet" | "flood",
  options: { readonly timeoutMs: number; readonly maxOutputBytes: number; readonly signal?: AbortSignal },
  behavior: "ordinary" | "resistant-parent" | "early-parent-resistant-grandchild" | "external-signal-survivor" = "ordinary",
): Promise<ProcessTreeFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "evleda-bounded-process-"));
  temporaryRoots.push(root);
  const windowsProcessTreeTermination = await copiedWindowsTerminationBinding(root);
  const pidFile = path.join(root, "pids.json");
  const heartbeatFile = path.join(root, "heartbeat.txt");
  const grandchildSource = [
    'const {appendFileSync}=require("node:fs");',
    "const heartbeatFile=process.argv[1];",
    "const mode=process.argv[2];",
    'appendFileSync(heartbeatFile,"started\\n");',
    ...(behavior === "early-parent-resistant-grandchild" || behavior === "external-signal-survivor"
      ? ["process.on('SIGTERM',()=>{});"] : []),
    'setInterval(()=>appendFileSync(heartbeatFile,"tick\\n"),25);',
    'if(mode==="flood"){setTimeout(()=>{',
    "const chunk=Buffer.alloc(64*1024,120);",
    "for(let index=0;index<32;index+=1)process.stdout.write(chunk);",
    "},250);}",
  ].join("");
  const parentSource = [
    'const {spawn}=require("node:child_process");',
    'const {writeFileSync}=require("node:fs");',
    `const grandchild=spawn(process.execPath,["-e",${JSON.stringify(grandchildSource)},${JSON.stringify(heartbeatFile)},${JSON.stringify(mode)}],`,
    behavior === "external-signal-survivor"
      ? '{shell:false,windowsHide:true,stdio:"ignore"});'
      : '{shell:false,windowsHide:true,stdio:["ignore","inherit","inherit"]});',
    'if(grandchild.pid===undefined)throw new Error("grandchild pid unavailable");',
    `writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({child:process.pid,grandchild:grandchild.pid}));`,
    ...(behavior === "resistant-parent" ? ["process.on('SIGTERM',()=>{});"] : []),
    "setInterval(()=>{},1000);",
  ].join("");

  return {
    invocation: runBoundedProcess({
      command: process.execPath,
      args: ["-e", parentSource],
      cwd: root,
      env: inheritedEnvironment(),
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(windowsProcessTreeTermination === undefined ? {} : { windowsProcessTreeTermination }),
    }),
    pidFile,
    heartbeatFile,
  };
}

const abnormalTerminationScenarios = [
  {
    name: "timeout",
    mode: "quiet",
    timeoutMs: 1_500,
    maxOutputBytes: 1_024,
    error: ProcessTimeoutError,
    abort: false,
  },
  {
    name: "abort",
    mode: "quiet",
    timeoutMs: 10_000,
    maxOutputBytes: 1_024,
    error: ProcessAbortError,
    abort: true,
  },
  {
    name: "output flood",
    mode: "flood",
    timeoutMs: 10_000,
    maxOutputBytes: 1_024,
    error: ProcessOutputLimitError,
    abort: false,
  },
] as const;

describe("bounded subprocess tree cleanup", () => {
  it("preserves normal non-zero exit and captured-output semantics", async () => {
    const result = await runBoundedProcess({
      command: process.execPath,
      args: [
        "-e",
        'process.stdout.write("out");process.stderr.write("err");process.exitCode=7;',
      ],
      cwd: process.cwd(),
      env: inheritedEnvironment(),
      timeoutMs: 5_000,
      maxOutputBytes: 1_024,
    });

    expect(result).toMatchObject({ exitCode: 7, stdout: "out", stderr: "err" });
  });

  it.each(abnormalTerminationScenarios)(
    "settles $name only after confirmed tree death or a typed unconfirmed result",
    async (scenario) => {
      const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      cleanupChildren.add(unrelated);
      await waitUntil(() => unrelated.pid !== undefined && isProcessAlive(unrelated.pid));

      const controller = new AbortController();
      const fixture = await processTreeFixture(scenario.mode, {
        timeoutMs: scenario.timeoutMs,
        maxOutputBytes: scenario.maxOutputBytes,
        ...(scenario.abort ? { signal: controller.signal } : {}),
      });
      const outcome = fixture.invocation.catch((error: unknown) => error);
      const tree = await Promise.race([
        readProcessTreeRecord(fixture.pidFile),
        outcome.then((earlyOutcome) => {
          const detail =
            earlyOutcome instanceof Error
              ? `${earlyOutcome.name}: ${earlyOutcome.message}`
              : JSON.stringify(earlyOutcome);
          throw new Error(
            `Process tree exited before publishing pids: ${detail}`,
          );
        }),
      ]);
      cleanupPids.add(tree.child);
      cleanupPids.add(tree.grandchild);
      expect(isProcessAlive(tree.child)).toBe(true);
      expect(isProcessAlive(tree.grandchild)).toBe(true);

      const terminationStarted = Date.now();
      if (scenario.abort) controller.abort();
      const observed = await outcome;
      if (observed instanceof ProcessTreeTerminationUnconfirmedError) {
        expect(observed).toMatchObject({
          retainWorkingDirectory: true,
          primaryErrorName: scenario.error.name,
        });
        expect(["root_close_unconfirmed", "tree_death_unconfirmed", "root_and_tree_unconfirmed"])
          .toContain(observed.confirmationFailure);
        await Promise.all([stopPid(tree.child), stopPid(tree.grandchild)]);
        await waitUntil(() => !isProcessAlive(tree.child) && !isProcessAlive(tree.grandchild));
      } else {
        expect(observed).toBeInstanceOf(scenario.error);
      }
      expect(Date.now() - terminationStarted).toBeLessThan(5_000);
      expect(isProcessAlive(tree.child)).toBe(false);
      expect(isProcessAlive(tree.grandchild)).toBe(false);
      cleanupPids.delete(tree.child);
      cleanupPids.delete(tree.grandchild);
      expect(unrelated.pid).toBeDefined();
      expect(isProcessAlive(unrelated.pid!)).toBe(true);

      const heartbeatSize = (await stat(fixture.heartbeatFile)).size;
      await delay(100);
      expect((await stat(fixture.heartbeatFile)).size).toBe(heartbeatSize);

      cleanupChildren.delete(unrelated);
      await stopChild(unrelated);
    },
  );

  it.each(["resistant-parent", "early-parent-resistant-grandchild"] as const)(
    "confirms real tree death before timeout rejection when $behavior",
    async (behavior) => {
      const fixture = await processTreeFixture("quiet", { timeoutMs: 500, maxOutputBytes: 1_024 }, behavior);
      const tree = await readProcessTreeRecord(fixture.pidFile);
      cleanupPids.add(tree.child);
      cleanupPids.add(tree.grandchild);
      await expect(fixture.invocation).rejects.toBeInstanceOf(ProcessTimeoutError);
      expect(isProcessAlive(tree.child)).toBe(false);
      expect(isProcessAlive(tree.grandchild)).toBe(false);
      cleanupPids.delete(tree.child);
      cleanupPids.delete(tree.grandchild);
    },
  );

  it("fails typed and closed when Windows tree-kill confirmation is unavailable", async () => {
    const error = await runBoundedProcess({
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      cwd: process.cwd(),
      env: inheritedEnvironment(),
      timeoutMs: 25,
      maxOutputBytes: 1_024,
      teardownHooksForTesting: {
        platform: "win32",
        taskkillTree: async () => false,
        terminationTimeoutMs: 100,
      },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProcessTreeTerminationUnconfirmedError);
    expect(error).toMatchObject({
      retainWorkingDirectory: true,
      primaryErrorName: "ProcessTimeoutError",
      confirmationFailure: "tree_death_unconfirmed",
    });
  });

  it("preserves output-limit classification only after deterministic Windows tree and root confirmation", async () => {
    class OutputFloodProcess extends EventEmitter {
      readonly stdin = null;
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();
      readonly pid = 12_345;
      readonly exitCode = null;
      readonly signalCode = null;
      kill(): boolean {
        queueMicrotask(() => this.emit("close", null, "SIGKILL"));
        return true;
      }
      unref(): void { /* test double */ }
    }
    const child = new OutputFloodProcess();
    const invocation = runBoundedProcess({
      command: process.execPath,
      args: ["--version"],
      cwd: process.cwd(),
      env: inheritedEnvironment(),
      timeoutMs: 1_000,
      maxOutputBytes: 16,
      spawnForTesting: (() => {
        queueMicrotask(() => child.stdout.write(Buffer.alloc(17, 120)));
        return child as unknown as ReturnType<typeof spawn>;
      }) as unknown as typeof spawn,
      teardownHooksForTesting: {
        platform: "win32",
        taskkillTree: async () => true,
        terminationTimeoutMs: 100,
      },
    });
    await expect(invocation).rejects.toBeInstanceOf(ProcessOutputLimitError);
  });

  it("uses only an exact caller-pinned Windows helper with a closed environment and fixed cwd", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-bounded-terminator-"));
    temporaryRoots.push(root);
    const binding = await syntheticWindowsTerminationBinding(root);
    class OutputFloodProcess extends EventEmitter {
      readonly stdin = null;
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();
      readonly pid = 12_345;
      readonly exitCode = null;
      readonly signalCode = null;
      kill(): boolean {
        queueMicrotask(() => this.emit("close", null, "SIGKILL"));
        return true;
      }
      unref(): void { /* test double */ }
    }
    class HelperProcess extends EventEmitter {
      kill(): boolean { return true; }
    }
    const child = new OutputFloodProcess();
    let helperSpawns = 0;
    let helperInvocation: Readonly<{
      command: string;
      args: readonly string[];
      cwd: unknown;
      env: unknown;
      shell: unknown;
      windowsHide: unknown;
    }> | undefined;
    const previous = {
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      PATH: process.env.PATH,
      COMSPEC: process.env.COMSPEC,
      hostileSecret: process.env.EVLEDA_HOSTILE_SECRET,
    };
    process.env.SystemRoot = "C:\\attacker-root";
    process.env.WINDIR = "C:\\attacker-root";
    process.env.PATH = "C:\\attacker-bin";
    process.env.COMSPEC = "C:\\attacker-shell.exe";
    process.env.EVLEDA_HOSTILE_SECRET = "must-not-reach-helper";
    try {
      const invocation = runBoundedProcess({
        command: process.execPath,
        args: ["--version"],
        cwd: process.cwd(),
        env: { PROVIDER_SECRET: "must-not-reach-helper-either" },
        timeoutMs: 1_000,
        maxOutputBytes: 16,
        windowsProcessTreeTermination: binding,
        spawnForTesting: (() => {
          queueMicrotask(() => child.stdout.write(Buffer.alloc(17, 120)));
          return child as unknown as ReturnType<typeof spawn>;
        }) as unknown as typeof spawn,
        teardownHooksForTesting: {
          platform: "win32",
          terminationTimeoutMs: 100,
          spawnTerminationHelper: ((command, args, options) => {
            helperSpawns += 1;
            helperInvocation = {
              command,
              args: args ?? [],
              cwd: options?.cwd,
              env: options?.env,
              shell: options?.shell,
              windowsHide: options?.windowsHide,
            };
            const helper = new HelperProcess();
            queueMicrotask(() => helper.emit("close", 0, null));
            return helper as unknown as ReturnType<typeof spawn>;
          }) as typeof spawn,
        },
      });
      await expect(invocation).rejects.toBeInstanceOf(ProcessOutputLimitError);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        const name = key === "hostileSecret" ? "EVLEDA_HOSTILE_SECRET" : key;
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    expect(helperSpawns).toBe(1);
    expect(helperInvocation).toEqual({
      command: binding.executablePath,
      args: ["/PID", "12345", "/T", "/F"],
      cwd: binding.cwd,
      env: { SYSTEMROOT: "C:\\Windows", WINDIR: "C:\\Windows" },
      shell: false,
      windowsHide: true,
    });
  });

  it.each(["replacement", "oversize", "a-to-b-to-a"] as const)(
    "does not accept Windows helper success after $variant drift during execution",
    async (variant) => {
      const root = await mkdtemp(path.join(tmpdir(), "evleda-bounded-terminator-drift-"));
      temporaryRoots.push(root);
      const binding = await syntheticWindowsTerminationBinding(root);
      const original = await readFile(binding.executablePath);
      class OutputFloodProcess extends EventEmitter {
        readonly stdin = null;
        readonly stdout = new PassThrough();
        readonly stderr = new PassThrough();
        readonly pid = 12_345;
        readonly exitCode = null;
        readonly signalCode = null;
        kill(): boolean {
          queueMicrotask(() => this.emit("close", null, "SIGKILL"));
          return true;
        }
        unref(): void { /* test double */ }
      }
      class HelperProcess extends EventEmitter {
        kill(): boolean { return true; }
      }
      const child = new OutputFloodProcess();
      let helperSpawns = 0;
      const error = await runBoundedProcess({
        command: process.execPath,
        args: ["--version"],
        cwd: process.cwd(),
        env: {},
        timeoutMs: 1_000,
        maxOutputBytes: 16,
        windowsProcessTreeTermination: binding,
        spawnForTesting: (() => {
          queueMicrotask(() => child.stdout.write(Buffer.alloc(17, 120)));
          return child as unknown as ReturnType<typeof spawn>;
        }) as unknown as typeof spawn,
        teardownHooksForTesting: {
          platform: "win32",
          terminationTimeoutMs: 250,
          spawnTerminationHelper: (() => {
            helperSpawns += 1;
            const helper = new HelperProcess();
            void (async () => {
              if (variant === "replacement") {
                const replacement = path.join(root, "replacement.exe");
                const displaced = path.join(root, "displaced.exe");
                await writeFile(replacement, Buffer.alloc(original.byteLength, 98), { flag: "wx" });
                await rename(binding.executablePath, displaced);
                await rename(replacement, binding.executablePath);
              } else if (variant === "oversize") {
                await truncate(binding.executablePath, 16 * 1024 * 1024 + 1);
              } else {
                await writeFile(binding.executablePath, Buffer.alloc(original.byteLength, 98));
                await writeFile(binding.executablePath, original);
              }
              helper.emit("close", 0, null);
            })();
            return helper as unknown as ReturnType<typeof spawn>;
          }) as unknown as typeof spawn,
        },
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        name: "ProcessTreeTerminationUnconfirmedError",
        primaryErrorName: "ProcessOutputLimitError",
        confirmationFailure: "tree_death_unconfirmed",
      });
      expect(helperSpawns).toBe(1);
    },
  );

  it.each(["hardlink", "symlink"] as const)(
    "rejects a $kind Windows helper before spawn",
    async (kind) => {
      const root = await mkdtemp(path.join(tmpdir(), "evleda-bounded-terminator-link-"));
      temporaryRoots.push(root);
      const binding = await syntheticWindowsTerminationBinding(root);
      if (kind === "hardlink") {
        await link(binding.executablePath, path.join(root, "second-link.exe"));
      } else {
        const target = path.join(root, "terminator-target.exe");
        await rename(binding.executablePath, target);
        try {
          await symlink(target, binding.executablePath, "file");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EPERM") return;
          throw error;
        }
      }
      class OutputFloodProcess extends EventEmitter {
        readonly stdin = null;
        readonly stdout = new PassThrough();
        readonly stderr = new PassThrough();
        readonly pid = 12_345;
        readonly exitCode = null;
        readonly signalCode = null;
        kill(): boolean {
          queueMicrotask(() => this.emit("close", null, "SIGKILL"));
          return true;
        }
        unref(): void { /* test double */ }
      }
      const child = new OutputFloodProcess();
      let helperSpawns = 0;
      const error = await runBoundedProcess({
        command: process.execPath,
        args: ["--version"],
        cwd: process.cwd(),
        env: {},
        timeoutMs: 1_000,
        maxOutputBytes: 16,
        windowsProcessTreeTermination: binding,
        spawnForTesting: (() => {
          queueMicrotask(() => child.stdout.write(Buffer.alloc(17, 120)));
          return child as unknown as ReturnType<typeof spawn>;
        }) as unknown as typeof spawn,
        teardownHooksForTesting: {
          platform: "win32",
          terminationTimeoutMs: 50,
          spawnTerminationHelper: (() => {
            helperSpawns += 1;
            throw new Error("must not spawn");
          }) as unknown as typeof spawn,
        },
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        name: "ProcessTreeTerminationUnconfirmedError",
        primaryErrorName: "ProcessOutputLimitError",
      });
      expect(helperSpawns).toBe(0);
    },
  );

  it.each([
    { label: "missing helper authority", mutate: (value: BoundedWindowsProcessTreeTermination) => undefined },
    {
      label: "drifted helper bytes",
      mutate: (value: BoundedWindowsProcessTreeTermination) => ({
        ...value,
        executableIdentity: { ...value.executableIdentity, digest: "f".repeat(64) },
      }),
    },
    {
      label: "extra helper environment key",
      mutate: (value: BoundedWindowsProcessTreeTermination) => ({
        ...value,
        env: { ...value.env, PATH: "C:\\attacker-bin" },
      }),
    },
  ])("does not spawn an ambient Windows helper for $label", async ({ mutate }) => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-bounded-no-fallback-"));
    temporaryRoots.push(root);
    const exact = await syntheticWindowsTerminationBinding(root);
    const candidate = mutate(exact);
    class OutputFloodProcess extends EventEmitter {
      readonly stdin = null;
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();
      readonly pid = 12_345;
      readonly exitCode = null;
      readonly signalCode = null;
      kill(): boolean {
        queueMicrotask(() => this.emit("close", null, "SIGKILL"));
        return true;
      }
      unref(): void { /* test double */ }
    }
    const child = new OutputFloodProcess();
    let helperSpawns = 0;
    const error = await runBoundedProcess({
      command: process.execPath,
      args: ["--version"],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 1_000,
      maxOutputBytes: 16,
      ...(candidate === undefined ? {} : {
        windowsProcessTreeTermination: candidate as BoundedWindowsProcessTreeTermination,
      }),
      spawnForTesting: (() => {
        queueMicrotask(() => child.stdout.write(Buffer.alloc(17, 120)));
        return child as unknown as ReturnType<typeof spawn>;
      }) as unknown as typeof spawn,
      teardownHooksForTesting: {
        platform: "win32",
        terminationTimeoutMs: 50,
        spawnTerminationHelper: (() => {
          helperSpawns += 1;
          throw new Error("must not spawn");
        }) as unknown as typeof spawn,
      },
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      name: "ProcessTreeTerminationUnconfirmedError",
      retainWorkingDirectory: true,
      primaryErrorName: "ProcessOutputLimitError",
      confirmationFailure: "tree_death_unconfirmed",
    });
    expect(helperSpawns).toBe(0);
  });

  it.each([
    { label: "tree helper failure", pid: 12_345 },
    { label: "missing process identity", pid: undefined },
  ])("keeps output flood as a typed composite on $label", async ({ pid }) => {
    class OutputFloodProcess extends EventEmitter {
      readonly stdin = null;
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();
      readonly exitCode = null;
      readonly signalCode = null;
      readonly pid = pid;
      kill(): boolean {
        queueMicrotask(() => this.emit("close", null, "SIGKILL"));
        return true;
      }
      unref(): void { /* test double */ }
    }
    const child = new OutputFloodProcess();
    const error = await runBoundedProcess({
      command: process.execPath,
      args: ["--version"],
      cwd: process.cwd(),
      env: inheritedEnvironment(),
      timeoutMs: 1_000,
      maxOutputBytes: 16,
      spawnForTesting: (() => {
        queueMicrotask(() => child.stdout.write(Buffer.alloc(17, 120)));
        return child as unknown as ReturnType<typeof spawn>;
      }) as unknown as typeof spawn,
      teardownHooksForTesting: {
        platform: "win32",
        taskkillTree: async () => false,
        terminationTimeoutMs: 50,
      },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProcessTreeTerminationUnconfirmedError);
    expect(error).toMatchObject({
      primaryErrorName: "ProcessOutputLimitError",
      confirmationFailure: "tree_death_unconfirmed",
      stdout: "x".repeat(16),
    });
    expect((error as Error).cause).toBeInstanceOf(ProcessOutputLimitError);
    expect(((error as Error).cause as ProcessOutputLimitError).stdout).toBe("x".repeat(16));
  });

  it.each(["win32", "posix"] as const)(
    "never signals a stale numeric identity after a signal-only close on %s",
    async (platform) => {
      class SignalCloseProcess extends EventEmitter {
        readonly stdin = null;
        readonly stdout = new PassThrough();
        readonly stderr = new PassThrough();
        readonly pid = 12345;
        readonly exitCode = null;
        readonly signalCode = "SIGTERM" as const;
        kill(): boolean { return true; }
        unref(): void { /* test double */ }
      }
      let treeKillCalls = 0;
      let groupSignalCalls = 0;
      const child = new SignalCloseProcess();
      const invocation = runBoundedProcess({
        command: process.execPath,
        args: ["--version"],
        cwd: process.cwd(),
        env: inheritedEnvironment(),
        timeoutMs: 1_000,
        maxOutputBytes: 1_024,
        spawnForTesting: (() => {
          queueMicrotask(() => child.emit("close", null, "SIGTERM"));
          return child as unknown as ReturnType<typeof spawn>;
        }) as unknown as typeof spawn,
        teardownHooksForTesting: {
          platform,
          taskkillTree: async () => {
            treeKillCalls += 1;
            return true;
          },
          signalProcessGroup: () => {
            groupSignalCalls += 1;
          },
          processGroupIsGone: () => false,
          terminationTimeoutMs: 50,
        },
      });
      await expect(invocation).rejects.toMatchObject({
        name: "ProcessTreeTerminationUnconfirmedError",
        retainWorkingDirectory: true,
        primaryErrorName: "BoundedProcessError",
        confirmationFailure: "tree_death_unconfirmed",
      });
      expect(treeKillCalls).toBe(0);
      expect(groupSignalCalls).toBe(0);
    },
  );

  it.each([
    { platform: "win32", stream: "stdout" },
    { platform: "win32", stream: "stderr" },
    { platform: "posix", stream: "stdout" },
    { platform: "posix", stream: "stderr" },
  ] as const)(
    "never signals a stale numeric identity after exit then $stream error on $platform",
    async ({ platform, stream }) => {
      class ExitedProcess extends EventEmitter {
        readonly stdin = null;
        readonly stdout = new PassThrough();
        readonly stderr = new PassThrough();
        readonly pid = 12345;
        readonly exitCode = 0;
        readonly signalCode = null;
        kill(): boolean { return true; }
        unref(): void { /* test double */ }
      }
      let treeKillCalls = 0;
      let groupSignalCalls = 0;
      const child = new ExitedProcess();
      const invocation = runBoundedProcess({
        command: process.execPath,
        args: ["--version"],
        cwd: process.cwd(),
        env: inheritedEnvironment(),
        timeoutMs: 1_000,
        maxOutputBytes: 1_024,
        spawnForTesting: (() => {
          queueMicrotask(() => {
            child.emit("exit", 0, null);
            child[stream].emit("error", new Error("late stream failure"));
          });
          return child as unknown as ReturnType<typeof spawn>;
        }) as unknown as typeof spawn,
        teardownHooksForTesting: {
          platform,
          taskkillTree: async () => {
            treeKillCalls += 1;
            return true;
          },
          signalProcessGroup: () => {
            groupSignalCalls += 1;
          },
          processGroupIsGone: () => false,
          terminationTimeoutMs: 50,
        },
      });
      const early = await Promise.race([
        invocation.then(() => "settled", () => "settled"),
        new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
      ]);
      expect(early).toBe("pending");
      child.emit("close", 0, null);
      await expect(invocation).rejects.toMatchObject({
        name: "ProcessTreeTerminationUnconfirmedError",
        retainWorkingDirectory: true,
        primaryErrorName: "BoundedProcessError",
        confirmationFailure: "tree_death_unconfirmed",
      });
      expect(treeKillCalls).toBe(0);
      expect(groupSignalCalls).toBe(0);
    },
  );

  it("bounds a hung Windows tree-kill helper and exercises POSIX group TERM-to-KILL verification", async () => {
    const hungTaskkill = await runBoundedProcess({
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      cwd: process.cwd(),
      env: inheritedEnvironment(),
      timeoutMs: 25,
      maxOutputBytes: 1_024,
      teardownHooksForTesting: {
        platform: "win32",
        taskkillTree: async () => await new Promise<boolean>(() => undefined),
        terminationTimeoutMs: 50,
      },
    }).catch((caught: unknown) => caught);
    expect(hungTaskkill).toBeInstanceOf(ProcessTreeTerminationUnconfirmedError);

    const groupSignals: Array<NodeJS.Signals | 0> = [];
    await expect(runBoundedProcess({
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      cwd: process.cwd(),
      env: inheritedEnvironment(),
      timeoutMs: 25,
      maxOutputBytes: 1_024,
      teardownHooksForTesting: {
        platform: "posix",
        signalProcessGroup: (_pid, signal) => { groupSignals.push(signal); },
        processGroupIsGone: () => true,
        termGraceMs: 10,
        terminationTimeoutMs: 100,
      },
    })).rejects.toBeInstanceOf(ProcessTimeoutError);
    expect(groupSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
