import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";

import {
  KICAD_MCP_PRO_AUDITED_COMMIT,
  KICAD_MCP_PRO_VERSION,
  KICAD_MCP_READ_TOOL_ALLOWLIST,
  KICAD_MCP_WRITE_TOOL_ALLOWLIST,
  KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY,
  KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
  KicadMcpAuthorizationError,
  KicadMcpOutputLimitError,
  KicadMcpSession,
  createKicadMcpExpectedExecutableIdentity,
  type KicadMcpOperatingMode,
  type KicadMcpSessionOptions,
} from "../../src/integrations/kicad-mcp-session.js";

interface LockedFile {
  readonly filename: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

interface SidecarLock {
  readonly schemaVersion: number;
  readonly sidecar: {
    readonly distribution: string;
    readonly version: string;
  };
  readonly auditedSource: {
    readonly commit: string;
    readonly pyprojectVersion: string;
  };
  readonly publishedDistribution: {
    readonly files: readonly (LockedFile & {
      readonly coreMetadataSha256?: string;
    })[];
  };
  readonly verifiedWindowsRuntime: {
    readonly uv: {
      readonly version: string;
      readonly archive: LockedFile;
      readonly checksumAsset: LockedFile;
      readonly executables: {
        readonly uv: LockedFile;
        readonly uvx: LockedFile;
      };
    };
    readonly python: {
      readonly version: string;
      readonly archive: LockedFile;
      readonly executable: LockedFile;
    };
    readonly observedPackageIdentity: {
      readonly distribution: string;
      readonly version: string;
      readonly wheelSha256: string;
      readonly coreMetadataSha256: string;
      readonly mcpServerInfo: {
        readonly name: string;
        readonly version: string;
      };
    };
    readonly defaultPaths: {
      readonly uv: string;
      readonly uvx: string;
      readonly uvArchive: string;
      readonly uvChecksum: string;
      readonly python: string;
      readonly pythonArchive: string;
      readonly wheel: string;
      readonly uvCache: string;
      readonly runtimeHome: string;
      readonly runtimeTemp: string;
      readonly runRoot: string;
    };
    readonly environmentOverrides: Record<RuntimePathKey, string>;
    readonly offlineLaunchArgs: readonly string[];
  };
}

type RuntimePathKey = keyof SidecarLock["verifiedWindowsRuntime"]["defaultPaths"];
type RuntimePaths = SidecarLock["verifiedWindowsRuntime"]["defaultPaths"];

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const LOCK_PATH = path.join(REPOSITORY_ROOT, "sidecars", "kicad-mcp-pro.lock.json");
const sidecarLock = JSON.parse(readFileSync(LOCK_PATH, "utf8")) as SidecarLock;
const runtimeLock = sidecarLock.verifiedWindowsRuntime;

function configuredPath(key: RuntimePathKey): string {
  const environmentKey = runtimeLock.environmentOverrides[key];
  return process.env[environmentKey] ?? runtimeLock.defaultPaths[key];
}

const runtimePaths = Object.fromEntries(
  (Object.keys(runtimeLock.defaultPaths) as RuntimePathKey[]).map((key) => [
    key,
    configuredPath(key),
  ]),
) as unknown as RuntimePaths;
// Real process/KiCad interaction is never enabled by installation discovery or
// path overrides. It requires this exact, explicit operator opt-in.
const realSmokeEnabled = process.env.EVLEDA_RUN_REAL_KICAD_MCP_SMOKE === "1";
const manifestedBundleProbeEnabled = process.env.EVLEDA_RUN_MANIFEST_KICAD_MCP_PROBE === "1";
const ownedWorkspaces = new Set<string>();

function ensureRecoveryPath(candidate: string, label: string): void {
  expect(path.isAbsolute(candidate), `${label} must be absolute`).toBe(true);
  if (process.platform !== "win32") return;
  const recoveryRoot = path.resolve("D:\\Codex-Recovery");
  const relative = path.relative(recoveryRoot, path.resolve(candidate));
  expect(
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative),
    `${label} must stay under D:\\Codex-Recovery`,
  ).toBe(true);
}

async function sha256(filePath: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function expectLockedFile(
  filePath: string,
  identity: Pick<LockedFile, "sizeBytes" | "sha256">,
  label: string,
): Promise<void> {
  ensureRecoveryPath(filePath, label);
  const fileStat = await stat(filePath);
  expect(fileStat.isFile(), `${label} must be a regular file`).toBe(true);
  expect(fileStat.size, `${label} byte size`).toBe(identity.sizeBytes);
  expect(await sha256(filePath), `${label} SHA-256`).toBe(identity.sha256);
}

function commandArguments(): string[] {
  return runtimeLock.offlineLaunchArgs.map((argument) =>
    argument.replace("{python}", runtimePaths.python).replace("{wheel}", runtimePaths.wheel),
  );
}

function sourceEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    PATHEXT: process.env.PATHEXT,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    TEMP: runtimePaths.runtimeTemp,
    TMP: runtimePaths.runtimeTemp,
    USERPROFILE: runtimePaths.runtimeHome,
    LOCALAPPDATA: path.join(runtimePaths.runtimeHome, "AppData", "Local"),
    APPDATA: path.join(runtimePaths.runtimeHome, "AppData", "Roaming"),
    HOME: runtimePaths.runtimeHome,
    UV_CACHE_DIR: runtimePaths.uvCache,
    UV_PYTHON: runtimePaths.python,
    UV_PYTHON_DOWNLOADS: "never",
    EVLEDA_REAL_SMOKE_SECRET: "must-not-cross-the-sidecar-boundary",
  };
}

interface RealRoots {
  readonly workspace: string;
  readonly project: string;
  readonly canonical: string;
}

async function createRoots(label: string): Promise<RealRoots> {
  ensureRecoveryPath(runtimePaths.runRoot, "real sidecar run root");
  await mkdir(runtimePaths.runRoot, { recursive: true });
  const workspace = await mkdtemp(path.join(runtimePaths.runRoot, `${label}-`));
  ownedWorkspaces.add(workspace);
  const project = path.join(workspace, "working-copy");
  const canonical = path.join(workspace, "canonical-source");
  await Promise.all([mkdir(project), mkdir(canonical)]);
  return { workspace, project, canonical };
}

async function removeOwnedWorkspace(workspace: string): Promise<void> {
  const relative = path.relative(path.resolve(runtimePaths.runRoot), path.resolve(workspace));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to remove non-owned real-sidecar path: ${workspace}`);
  }
  await rm(workspace, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  ownedWorkspaces.delete(workspace);
}

async function connectReal(
  roots: RealRoots,
  mode: KicadMcpOperatingMode,
  overrides: Partial<
    Pick<KicadMcpSessionOptions, "maxStderrBytes" | "timeoutMs" | "signal">
  > = {},
): Promise<KicadMcpSession> {
  return await KicadMcpSession.connect({
    workspaceRoot: roots.workspace,
    projectRoot: roots.project,
    mode,
    ...(mode === "write"
      ? { isolatedWorkingCopy: { canonicalProjectRoot: roots.canonical } }
      : {}),
    command: {
      command: runtimePaths.uvx,
      args: commandArguments(),
    },
    expectedLauncherIdentity: await createKicadMcpExpectedExecutableIdentity(runtimePaths.uvx),
    environment: sourceEnvironment(),
    extraEnvironment: {
      UV_CACHE_DIR: runtimePaths.uvCache,
      UV_PYTHON: runtimePaths.python,
    },
    maxMessageBytes: 2 * 1024 * 1024,
    maxStderrBytes: overrides.maxStderrBytes ?? 4 * 1024,
    maxToolPages: 8,
    maxTools: 512,
    timeoutMs: overrides.timeoutMs ?? 30_000,
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
  });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function expectProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return;
    await delay(50);
  }
  expect(processIsAlive(pid), `sidecar process ${String(pid)} should be gone`).toBe(false);
}

async function assertRuntimeIdentity(): Promise<void> {
  expect(sidecarLock.schemaVersion).toBe(2);
  expect(sidecarLock.sidecar).toMatchObject({
    distribution: "kicad-mcp-pro",
    version: KICAD_MCP_PRO_VERSION,
  });
  expect(sidecarLock.auditedSource).toMatchObject({
    commit: KICAD_MCP_PRO_AUDITED_COMMIT,
    pyprojectVersion: KICAD_MCP_PRO_VERSION,
  });

  await Promise.all([
    expectLockedFile(runtimePaths.uv, runtimeLock.uv.executables.uv, "uv executable"),
    expectLockedFile(runtimePaths.uvx, runtimeLock.uv.executables.uvx, "uvx executable"),
    expectLockedFile(runtimePaths.uvArchive, runtimeLock.uv.archive, "uv release archive"),
    expectLockedFile(
      runtimePaths.uvChecksum,
      runtimeLock.uv.checksumAsset,
      "uv checksum asset",
    ),
    expectLockedFile(runtimePaths.python, runtimeLock.python.executable, "Python executable"),
    expectLockedFile(
      runtimePaths.pythonArchive,
      runtimeLock.python.archive,
      "Python release archive",
    ),
  ]);

  const wheelIdentity = sidecarLock.publishedDistribution.files.find(
    (file) => file.filename === path.basename(runtimePaths.wheel),
  );
  expect(wheelIdentity, "locked wheel identity").toBeDefined();
  if (wheelIdentity === undefined) throw new Error("Locked wheel identity is absent.");
  await expectLockedFile(runtimePaths.wheel, wheelIdentity, "kicad-mcp-pro wheel");
  expect(wheelIdentity.sha256).toBe(runtimeLock.observedPackageIdentity.wheelSha256);

  const checksumText = await readFile(runtimePaths.uvChecksum, "utf8");
  expect(checksumText.trim().split(/\s+/u)[0]).toBe(runtimeLock.uv.archive.sha256);

  const wheelEntries = unzipSync(new Uint8Array(await readFile(runtimePaths.wheel)));
  const metadataEntry = Object.entries(wheelEntries).find(([entryName]) =>
    entryName.endsWith(".dist-info/METADATA"),
  );
  expect(metadataEntry, "wheel Core Metadata entry").toBeDefined();
  if (metadataEntry === undefined) throw new Error("Wheel Core Metadata entry is absent.");
  const metadataBytes = metadataEntry[1];
  expect(createHash("sha256").update(metadataBytes).digest("hex")).toBe(
    runtimeLock.observedPackageIdentity.coreMetadataSha256,
  );
  const metadata = Buffer.from(metadataBytes).toString("utf8");
  expect(metadata).toMatch(/^Name: kicad-mcp-pro$/mu);
  expect(metadata).toMatch(/^Version: 3\.33\.3$/mu);

  for (const [executable, expected] of [
    [runtimePaths.uv, `uv ${runtimeLock.uv.version}`],
    [runtimePaths.uvx, `uvx ${runtimeLock.uv.version}`],
  ] as const) {
    const result = spawnSync(executable, ["--version"], {
      cwd: runtimePaths.runRoot,
      encoding: "utf8",
      env: sourceEnvironment(),
      shell: false,
      timeout: 20_000,
      windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split(/\s+/u).slice(0, 2).join(" ")).toBe(expected);
  }

  const packageVersion = spawnSync(
    runtimePaths.uvx,
    [...commandArguments(), "version", "--json"],
    {
      cwd: runtimePaths.runRoot,
      encoding: "utf8",
      env: sourceEnvironment(),
      shell: false,
      timeout: 30_000,
      windowsHide: true,
    },
  );
  expect(packageVersion.error).toBeUndefined();
  expect(packageVersion.status).toBe(0);
  expect(JSON.parse(packageVersion.stdout)).toMatchObject({
    package: {
      name: runtimeLock.observedPackageIdentity.distribution,
      version: runtimeLock.observedPackageIdentity.version,
    },
    mcp: { transport_default: "stdio", operating_mode: "readonly" },
    python: { version: runtimeLock.python.version },
  });
}

describe.skipIf(!realSmokeEnabled)("audited real kicad-mcp-pro sidecar", () => {
  beforeAll(async () => {
    for (const directory of [
      runtimePaths.uvCache,
      runtimePaths.runtimeHome,
      runtimePaths.runtimeTemp,
      runtimePaths.runRoot,
      path.join(runtimePaths.runtimeHome, "AppData", "Local"),
      path.join(runtimePaths.runtimeHome, "AppData", "Roaming"),
    ]) {
      ensureRecoveryPath(directory, "real sidecar runtime directory");
      await mkdir(directory, { recursive: true });
    }
  });

  afterAll(async () => {
    for (const workspace of [...ownedWorkspaces]) await removeOwnedWorkspace(workspace);
    await Promise.all([
      expectLockedFile(runtimePaths.uv, runtimeLock.uv.executables.uv, "uv executable"),
      expectLockedFile(runtimePaths.uvx, runtimeLock.uv.executables.uvx, "uvx executable"),
      expectLockedFile(
        runtimePaths.python,
        runtimeLock.python.executable,
        "Python executable",
      ),
      expectLockedFile(
        runtimePaths.wheel,
        {
          sizeBytes: 905_627,
          sha256: runtimeLock.observedPackageIdentity.wheelSha256,
        },
        "kicad-mcp-pro wheel",
      ),
    ]);
  });

  it("binds the official launcher, Python, and exact wheel identities before launch", async () => {
    await assertRuntimeIdentity();
  });

  it("discovers the real review catalog, walks its terminal page, and enforces read-only policy", async () => {
    const roots = await createRoots("readonly");
    let session: KicadMcpSession | undefined;
    try {
      session = await connectReal(roots, "readonly");
      const identity = session.identity;
      expect(identity).toMatchObject({
        sidecar: {
          distribution: "kicad-mcp-pro",
          version: "3.33.3",
          auditedCommit: KICAD_MCP_PRO_AUDITED_COMMIT,
        },
        server: { ...runtimeLock.observedPackageIdentity.mcpServerInfo, authenticated: true },
        mode: "readonly",
        launch: {
          schemaVersion: "evleda.kicad-mcp-launch.v1",
          transport: "stdio",
          profile: "full",
          mode: "readonly",
          launcherPathIdentity: expect.stringMatching(/^[a-f0-9]{64}$/u),
          argumentsSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
        launcher: {
          pathIdentity: expect.stringMatching(/^[a-f0-9]{64}$/u),
          sha256: runtimeLock.uv.executables.uvx.sha256,
          sizeBytes: runtimeLock.uv.executables.uvx.sizeBytes,
        },
        toolDiscovery: {
          pageCount: 1,
          toolCount: 134,
          pageCursorIdentities: [null],
        },
      });
      expect(JSON.stringify(identity)).not.toContain(await realpath(roots.project));
      expect(JSON.stringify(identity)).not.toContain(await realpath(runtimePaths.uvx));
      const toolNames = session.listTools().map((tool) => tool.name);
      expect(toolNames).toHaveLength(26);
      expect(toolNames).toEqual(
        expect.arrayContaining([
          "kicad_get_version",
          "kicad_get_project_info",
          "project_get_next_action",
          "run_drc",
          "run_erc",
          "pcb_get_board_as_string",
        ]),
      );
      expect(toolNames).not.toContain("kicad_set_project");
      expect(toolNames).not.toContain("dfm_run_manufacturer_check");

      const version = await session.callTool("kicad_get_version");
      expect(version.structuredContent).toMatchObject({
        result: expect.stringContaining("KiCad MCP Pro Server v3.33.3"),
      });
      await expect(session.callTool("kicad_set_project", {})).rejects.toBeInstanceOf(
        KicadMcpAuthorizationError,
      );
      await expect(
        session.callTool("kicad_get_project_info", {
          project_file: path.join(roots.project, "..", "escape.kicad_pro"),
        }),
      ).rejects.toThrow(/escapes/iu);
      for (const forbidden of [
        "dfm_run_manufacturer_check",
        "export_manufacturing_package",
        "jobset_export",
        "vcs_tag_release",
      ]) {
        await expect(session.callTool(forbidden, {})).rejects.toThrow(
          /permanently forbidden/iu,
        );
      }

      const pid = identity.pid;
      expect(pid).not.toBeNull();
      await session.close();
      session = undefined;
      if (pid !== null) await expectProcessExit(pid);
    } finally {
      await session?.close();
      await removeOwnedWorkspace(roots.workspace);
    }
  });

  it("exposes reviewed write tools only in an isolated real-sidecar working copy", async () => {
    const roots = await createRoots("write");
    let session: KicadMcpSession | undefined;
    try {
      session = await connectReal(roots, "write", { maxStderrBytes: 64 * 1024 });
      expect(session.identity.mode).toBe("write");
      expect(session.identity.toolDiscovery).toMatchObject({
        pageCount: 1,
        pageCursorIdentities: [null],
      });
      expect(session.listTools()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "kicad_get_project_info", permission: "read" }),
          expect.objectContaining({ name: "kicad_set_project", permission: "write" }),
        ]),
      );
      await expect(
        session.callTool("kicad_set_project", {
          project_dir: path.join(roots.workspace, "outside-working-copy"),
        }),
      ).rejects.toThrow(/escapes/iu);
      await expect(session.callTool("manufacturing_quality_gate", {})).rejects.toThrow(
        /permanently forbidden/iu,
      );
    } finally {
      await session?.close();
      await removeOwnedWorkspace(roots.workspace);
    }
  });

  it("fails closed when the real sidecar exceeds the stderr budget", async () => {
    const roots = await createRoots("stderr");
    try {
      await expect(async () => {
        const session = await connectReal(roots, "readonly", { maxStderrBytes: 32 });
        try {
          await delay(100);
          await session.callTool("kicad_get_version");
        } finally {
          await session.close();
        }
      }).rejects.toBeInstanceOf(KicadMcpOutputLimitError);
    } finally {
      await removeOwnedWorkspace(roots.workspace);
    }
  });

  it("times out a real request, closes the session, and reaps the child", async () => {
    const roots = await createRoots("timeout");
    let session: KicadMcpSession | undefined;
    try {
      session = await connectReal(roots, "readonly");
      const pid = session.identity.pid;
      expect(pid).not.toBeNull();
      await expect(
        session.callTool("kicad_get_version", {}, { timeoutMs: 1 }),
      ).rejects.toThrow(/did not complete safely/iu);
      await expect(session.callTool("kicad_get_version")).rejects.toThrow(
        /session is closed/iu,
      );
      if (pid !== null) await expectProcessExit(pid);
      session = undefined;
    } finally {
      await session?.close();
      await removeOwnedWorkspace(roots.workspace);
    }
  });
});

describe.skipIf(!manifestedBundleProbeEnabled)("manifested direct kicad-mcp runtime", () => {
  const bundleRoot = "D:\\Codex-Recovery\\tools\\kicad-mcp-pro\\inspection-runtime-3.33.3";
  const manifestPath = path.join(REPOSITORY_ROOT, "sidecars", "kicad-inspection-runtime-manifest.json");
  const builderPath = path.join(REPOSITORY_ROOT, "scripts", "build-kicad-inspection-runtime-manifest.mjs");
  const pythonPath = path.join(bundleRoot, "environment", "Scripts", "python.exe");
  const launcherPath = path.join(bundleRoot, "kicad-inspection-launcher.py");
  const terminatorPath = path.join(bundleRoot, "process-tree-terminator.exe");
  const kicadCliPath = "D:\\Codex-Recovery\\KiCad\\10.0\\bin\\kicad-cli.exe";
  const probeParent = "D:\\Temp";
  let probeRoot = "";

  const verifyBundle = (): void => {
    const result = spawnSync(process.execPath, [builderPath, "verify", bundleRoot, manifestPath, bundleRoot], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
      shell: false,
      timeout: 30_000,
      windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  };

  const bytecodeEntries = async (): Promise<string[]> => {
    const found: string[] = [];
    const pending = [bundleRoot];
    while (pending.length > 0) {
      const directory = pending.pop()!;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "__pycache__") found.push(path.relative(bundleRoot, candidate));
          else pending.push(candidate);
        } else if (entry.isFile() && entry.name.endsWith(".pyc")) {
          found.push(path.relative(bundleRoot, candidate));
        }
      }
    }
    return found.sort();
  };

  beforeAll(async () => {
    await mkdir(probeParent, { recursive: true });
    probeRoot = await mkdtemp(path.join(probeParent, "evleda-manifested-sidecar-probe-"));
  });

  afterAll(async () => {
    if (probeRoot !== "") await rm(probeRoot, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 });
  });

  it("attests the startup -B flag and launches readonly/write without runtime-tree drift", async () => {
    const initialManifestIdentity = contentIdentity(await readFile(manifestPath));
    verifyBundle();
    expect(await bytecodeEntries()).toEqual([]);
    const launcherSource = await readFile(launcherPath, "utf8");
    expect(launcherSource).toContain("sys.flags.dont_write_bytecode");
    expect(launcherSource.indexOf("sys.flags.dont_write_bytecode")).toBeLessThan(launcherSource.indexOf("from kicad_mcp.server"));

    const flagProbe = String.raw`
import sys
p = sys.argv[1]
ns = {"__name__": "flag_probe"}
exec(compile(open(p, encoding="utf-8").read(), p, "exec"), ns)
class Flags:
    dont_write_bytecode = 0
class FakeSys:
    flags = Flags()
    dont_write_bytecode = True
    argv = [p, "--profile", "full", "--mode", "readonly"]
ns["sys"] = FakeSys()
try:
    ns["main"]()
except SystemExit as exc:
    print(exc.code)
    raise SystemExit(0 if exc.code == 64 else 2)
raise SystemExit(3)
`;
    const rejectedFlag = spawnSync(pythonPath, ["-I", "-s", "-E", "-B", "-c", flagProbe, launcherPath], {
      cwd: probeRoot,
      encoding: "utf8",
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
      shell: false,
      timeout: 10_000,
      windowsHide: true,
    });
    expect(rejectedFlag.error).toBeUndefined();
    expect(rejectedFlag.status).toBe(0);
    expect(rejectedFlag.stdout.trim()).toBe("64");

    const [pythonIdentity, terminatorIdentity, kicadCliIdentity] = await Promise.all([
      createKicadMcpExpectedExecutableIdentity(pythonPath),
      createKicadMcpExpectedExecutableIdentity(terminatorPath),
      createKicadMcpExpectedExecutableIdentity(kicadCliPath),
    ]);
    for (const mode of ["readonly", "write"] as const) {
      const workspace = path.join(probeRoot, mode);
      const project = path.join(workspace, "project");
      const output = path.join(workspace, "output");
      const launchCwd = path.join(workspace, "cwd");
      const home = path.join(workspace, "home");
      const cache = path.join(workspace, "cache");
      const temp = path.join(workspace, "temp");
      const config = path.join(workspace, "config");
      await Promise.all([workspace, project, output, launchCwd, home, cache, temp, config]
        .map(async (directory) => await mkdir(directory, { recursive: true })));
      const socket = Object.freeze({
        endpoint: `ipc://${path.join(workspace, "api.sock")}`,
        identity: canonicalIdentity({ mode }, "evleda.kicad-api-socket-binding.v1"),
      });
      const authorityIdentity = canonicalIdentity({ mode, socket: socket.identity }, "evleda.kicad-mcp-session-authority.v1");
      const semanticAuthorityIdentity = canonicalIdentity({ mode, socket: socket.identity }, "evleda.kicad-mcp-session-semantic-authority.v1");
      const session = await KicadMcpSession.connect({
        workspaceRoot: workspace,
        projectRoot: project,
        outputRoot: output,
        launchCwd,
        deferProjectBinding: true,
        mode,
        ...(mode === "write" ? { freshProject: true } : {}),
        command: { command: pythonPath, args: ["-I", "-s", "-E", "-B", launcherPath] },
        expectedLauncherIdentity: pythonIdentity,
        environment: {
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          TEMP: temp,
          TMP: temp,
          USERPROFILE: home,
          LOCALAPPDATA: path.join(home, "AppData", "Local"),
          APPDATA: path.join(home, "AppData", "Roaming"),
          HOME: home,
        },
        extraEnvironment: { KICAD_CONFIG_HOME: config, XDG_CACHE_HOME: cache },
        kicadCliPath,
        expectedKicadCliIdentity: kicadCliIdentity,
        ipcSocket: socket,
        sessionAuthorityIdentity: authorityIdentity,
        sessionSemanticAuthorityIdentity: semanticAuthorityIdentity,
        processTreeSupervision: {
          strategy: KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY,
          terminator: terminatorIdentity,
          timeoutMs: KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
        },
        readToolAllowlist: KICAD_MCP_READ_TOOL_ALLOWLIST,
        writeToolAllowlist: mode === "write" ? KICAD_MCP_WRITE_TOOL_ALLOWLIST : [],
        requiredTools: mode === "readonly" ? ["kicad_get_version"] : ["kicad_set_project"],
        maxStderrBytes: 64 * 1024,
        timeoutMs: 30_000,
      });
      try {
        expect(session.identity).toMatchObject({ mode, launch: { argumentCount: 9 } });
        expect(session.listTools().length).toBeGreaterThan(0);
      } finally {
        await session.close();
      }
      expect(await bytecodeEntries()).toEqual([]);
    }
    verifyBundle();
    expect(await bytecodeEntries()).toEqual([]);
    expect(contentIdentity(await readFile(manifestPath))).toEqual(initialManifestIdentity);
  }, 180_000);
});
