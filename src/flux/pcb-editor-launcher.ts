import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { BigIntStats } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import path from "node:path";

import { canonicalIdentity } from "../core/canonical.js";
import type { KicadMcpEditorLaunchContext } from "../integrations/kicad-mcp-session.js";
import {
  ProcessTreeTerminationUnconfirmedError,
  runBoundedProcess,
  type BoundedProcessOptions,
  type BoundedProcessRunner,
} from "../integrations/bounded-process.js";
import {
  parseFluxKicadToolchainBinding,
  type FluxKicadToolchainBinding,
  type FluxKicadCliBinding,
  type FluxPcbnewBinding,
} from "./kicad-toolchain-binding.js";
import { parsePeVersionInfo, type PeVersionInfo } from "./pe-version-info.js";

export const FLUX_KICAD_INSTALLATION_ROOT_SCHEMA_VERSION =
  "evleda.flux-kicad-installation-root.v1" as const;
export const FLUX_KICAD_API_SOCKET_MAX_ENDPOINT_BYTES = 128;

export class FluxPcbEditorIdentityError extends Error {
  override readonly name = "FluxPcbEditorIdentityError";
}

export class FluxPcbEditorProbeUncertainError extends Error {
  override readonly name = "FluxPcbEditorProbeUncertainError";
  readonly retryable = false;

  constructor(options?: ErrorOptions) {
    super("KiCad CLI identity-probe teardown could not be confirmed; do not retry Open until the process tree is inspected.", options);
  }
}

interface FsDirectoryBinding {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: bigint;
  readonly createdNs: bigint;
}

interface FsFileBinding {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: bigint;
  readonly linkCount: bigint;
  readonly createdNs: bigint;
  readonly modifiedNs: bigint;
  readonly changedNs: bigint;
  readonly size: bigint;
}

interface ExecutableHostBinding {
  readonly file: FsFileBinding;
  readonly pe: PeVersionInfo;
}

export interface FluxPcbEditorSuiteHostBinding {
  readonly profile: FluxKicadToolchainBinding;
  readonly installationRoot: FsDirectoryBinding;
  readonly installationRootIdentity: ReturnType<typeof canonicalIdentity>;
  readonly kicadCli: ExecutableHostBinding;
  readonly pcbnew: ExecutableHostBinding;
}

export interface FluxPcbEditorLaunchRequest {
  readonly executablePath: string;
  readonly boardPath: string;
  readonly environment: Readonly<Record<string, string>>;
}

export interface FluxPcbEditorLaunchResult {
  readonly pid: number;
  /** Exact ChildProcess-handle exit witness; never reconstructed from a numeric PID. */
  readonly exited: Promise<Readonly<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>>;
}

export type FluxPcbEditorLauncher = (request: FluxPcbEditorLaunchRequest) => Promise<FluxPcbEditorLaunchResult>;
export type FluxPcbEditorSpawnObserver = (result: FluxPcbEditorLaunchResult) => void | Promise<void>;

export interface BindFluxPcbEditorSuiteOptions {
  readonly toolchain: FluxKicadToolchainBinding;
  readonly runner?: BoundedProcessRunner;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

const samePath = (left: string, right: string): boolean => process.platform === "win32"
  ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
  : left === right;

const sameDirectory = (left: FsDirectoryBinding, right: FsDirectoryBinding): boolean =>
  samePath(left.path, right.path) && left.device === right.device && left.inode === right.inode &&
  left.mode === right.mode && left.createdNs === right.createdNs;

const sameFile = (left: FsFileBinding, right: FsFileBinding): boolean =>
  samePath(left.path, right.path) && left.device === right.device && left.inode === right.inode &&
  left.mode === right.mode && left.linkCount === right.linkCount && left.createdNs === right.createdNs &&
  left.modifiedNs === right.modifiedNs && left.changedNs === right.changedNs && left.size === right.size;

const assertNoLink = async (candidate: string, symbolic: boolean, label: string): Promise<void> => {
  if (symbolic) throw new FluxPcbEditorIdentityError(`${label} must not be a link, junction, or reparse alias.`);
  try {
    await readlink(candidate);
    throw new FluxPcbEditorIdentityError(`${label} must not be a link, junction, or reparse alias.`);
  } catch (error) {
    if (error instanceof FluxPcbEditorIdentityError) throw error;
    if (!(["EINVAL", "UNKNOWN"] as readonly (string | undefined)[]).includes((error as NodeJS.ErrnoException).code)) throw error;
  }
};

const bindDirectory = async (candidate: string, label: string): Promise<FsDirectoryBinding> => {
  const lexical = path.resolve(candidate);
  const metadata = await lstat(lexical, { bigint: true });
  await assertNoLink(lexical, metadata.isSymbolicLink(), label);
  if (!metadata.isDirectory()) throw new FluxPcbEditorIdentityError(`${label} must be an ordinary directory.`);
  const physical = await realpath(lexical);
  if (!samePath(physical, lexical)) throw new FluxPcbEditorIdentityError(`${label} must be canonical.`);
  return Object.freeze({ path: lexical, device: metadata.dev, inode: metadata.ino, mode: metadata.mode, createdNs: metadata.birthtimeNs });
};

const bindCanonicalDirectoryTree = async (candidate: string, label: string): Promise<FsDirectoryBinding> => {
  const lexical = path.resolve(candidate);
  const parsed = path.parse(lexical);
  const relative = path.relative(parsed.root, lexical);
  let cursor = parsed.root;
  let result = await bindDirectory(cursor, `${label} volume root`);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    result = await bindDirectory(cursor, label);
  }
  return result;
};

const fileBindingFrom = (candidate: string, metadata: BigIntStats): FsFileBinding => Object.freeze({
  path: path.resolve(candidate),
  device: metadata.dev,
  inode: metadata.ino,
  mode: metadata.mode,
  linkCount: metadata.nlink,
  createdNs: metadata.birthtimeNs,
  modifiedNs: metadata.mtimeNs,
  changedNs: metadata.ctimeNs,
  size: metadata.size,
});

const bindExecutable = async (
  expected: FluxKicadCliBinding | FluxPcbnewBinding,
  expectedRoot: FsDirectoryBinding,
  label: string,
): Promise<ExecutableHostBinding> => {
  const lexical = path.resolve(expected.path);
  if (!samePath(path.dirname(lexical), expectedRoot.path)) throw new FluxPcbEditorIdentityError(`${label} is outside the pinned KiCad bin root.`);
  await bindCanonicalDirectoryTree(expectedRoot.path, "KiCad bin root");
  const pathMetadata = await lstat(lexical, { bigint: true });
  await assertNoLink(lexical, pathMetadata.isSymbolicLink(), label);
  if (!pathMetadata.isFile() || pathMetadata.nlink !== 1n) throw new FluxPcbEditorIdentityError(`${label} must be an ordinary single-link file.`);
  const physical = await realpath(lexical);
  if (!samePath(physical, lexical)) throw new FluxPcbEditorIdentityError(`${label} must be canonical.`);
  if (pathMetadata.size !== BigInt(expected.contentIdentity.size)) throw new FluxPcbEditorIdentityError(`${label} size does not match its server-owned pin.`);
  const handle = await open(lexical, "r");
  let before: FsFileBinding;
  let after: FsFileBinding;
  let bytes: Buffer;
  try {
    before = fileBindingFrom(lexical, await handle.stat({ bigint: true }));
    if (!sameFile(fileBindingFrom(lexical, pathMetadata), before)) throw new FluxPcbEditorIdentityError(`${label} changed while it was opened.`);
    bytes = await handle.readFile();
    after = fileBindingFrom(lexical, await handle.stat({ bigint: true }));
  } finally {
    await handle.close();
  }
  if (!sameFile(before, after) || bytes.byteLength !== expected.contentIdentity.size) throw new FluxPcbEditorIdentityError(`${label} changed while its bytes were read.`);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== expected.contentIdentity.digest) throw new FluxPcbEditorIdentityError(`${label} SHA-256 does not match its server-owned pin.`);
  const pathAfter = await lstat(lexical, { bigint: true });
  const rebound = fileBindingFrom(lexical, pathAfter);
  if (pathAfter.isSymbolicLink() || !pathAfter.isFile() || !sameFile(before, rebound) || !samePath(await realpath(lexical), lexical)) {
    throw new FluxPcbEditorIdentityError(`${label} was replaced after its descriptor-bound read.`);
  }
  const pe = parsePeVersionInfo(bytes);
  if (pe.fixedFileVersion !== expected.peFileVersion || pe.fileVersion !== expected.peFileVersion ||
    pe.productVersion !== expected.peProductVersion || pe.fixedProductVersion !== pe.fixedFileVersion) {
    throw new FluxPcbEditorIdentityError(`${label} PE VERSIONINFO does not match its server-owned pin.`);
  }
  return Object.freeze({ file: before, pe });
};

const KICAD_CHILD_ENVIRONMENT_KEYS = Object.freeze([
  "SystemRoot", "WINDIR", "TEMP", "TMP",
  "KICAD_CONFIG_HOME", "KICAD10_SYMBOL_DIR", "KICAD10_FOOTPRINT_DIR",
  "KICAD10_3DMODEL_DIR", "KICAD10_TEMPLATE_DIR", "KICAD10_USER_TEMPLATE_DIR",
] as const);
const exactEnvironment = (environment: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> => {
  const selected: Record<string, string> = {};
  for (const key of KICAD_CHILD_ENVIRONMENT_KEYS) {
    const matches = Object.entries(environment).filter(([candidate]) => process.platform === "win32"
      ? candidate.toLocaleLowerCase("en-US") === key.toLocaleLowerCase("en-US")
      : candidate === key);
    if (matches.length > 1) throw new FluxPcbEditorIdentityError("KiCad child environment contains an ambiguous key.");
    const value = matches[0]?.[1];
    if (value === undefined || value === "") continue;
    if (/[\0\r\n]/u.test(value)) throw new FluxPcbEditorIdentityError("KiCad child environment contains controls.");
    selected[key] = value;
  }
  return Object.freeze(selected);
};

const exactLaunchEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
  context: KicadMcpEditorLaunchContext,
): Readonly<Record<string, string>> => {
  const ipcSocketEndpoint = context.endpoint;
  if (!ipcSocketEndpoint.startsWith("ipc://") || /[\0\r\n]/u.test(ipcSocketEndpoint)
      || Buffer.byteLength(ipcSocketEndpoint, "utf8") > FLUX_KICAD_API_SOCKET_MAX_ENDPOINT_BYTES
      || !path.isAbsolute(ipcSocketEndpoint.slice("ipc://".length))) {
    throw new FluxPcbEditorIdentityError("KiCad API socket endpoint is not one bounded absolute IPC URI.");
  }
  if (![context.tempRoot, context.configRoot].every((root) => typeof root === "string" && path.isAbsolute(root) && !/[\0\r\n]/u.test(root))
      || !samePath(ipcSocketEndpoint.slice("ipc://".length), path.join(context.tempRoot, "kicad", "api.sock"))
      || !samePath(context.configRoot, path.join(context.tempRoot, "config"))) {
    throw new FluxPcbEditorIdentityError("KiCad editor temp/config paths do not derive the bound API socket endpoint.");
  }
  // KiCad10.0.3 derives its Windows listener from GetTempDir()/kicad/api.sock.
  // KICAD_API_SOCKET is useful to clients, but does not override that listener.
  return Object.freeze({
    ...exactEnvironment(environment),
    TEMP: context.tempRoot, TMP: context.tempRoot,
    KICAD_CONFIG_HOME: context.configRoot,
    KICAD_CACHE_HOME: path.join(context.tempRoot, "cache"),
    KICAD_API_SOCKET: ipcSocketEndpoint,
  });
};

const runCliProbe = async (
  binding: FluxKicadToolchainBinding,
  root: FsDirectoryBinding,
  runner: BoundedProcessRunner,
  environment: Readonly<Record<string, string>>,
): Promise<void> => {
  const invoke = async (args: readonly string[], expected: string): Promise<void> => {
    const options: BoundedProcessOptions = {
      command: binding.kicadCli.path,
      args,
      cwd: root.path,
      env: environment,
      timeoutMs: 5_000,
      maxOutputBytes: 16_384,
    };
    let result;
    try {
      result = await runner(options);
    } catch (error) {
      if (error instanceof ProcessTreeTerminationUnconfirmedError) throw new FluxPcbEditorProbeUncertainError({ cause: error });
      throw error;
    }
    if (result.exitCode !== 0 || result.stderr !== "" || result.stdout !== `${expected}\r\n`) throw new FluxPcbEditorIdentityError("Pinned KiCad CLI identity probe failed its exact transcript policy.");
  };
  await invoke(["version"], binding.kicadCli.operationalVersion);
  await invoke(["version", "--format", "commit"], binding.kicadCli.operationalCommit);
};

const assertExecutableRole = (binding: FluxPcbEditorSuiteHostBinding): void => {
  if (binding.kicadCli.pe.originalFilename.toLocaleLowerCase("en-US") !== "kicad.exe" ||
    binding.kicadCli.pe.internalName.toLocaleLowerCase("en-US") !== "kicad" ||
    binding.pcbnew.pe.originalFilename.toLocaleLowerCase("en-US") !== "pcbnew.exe" ||
    binding.pcbnew.pe.internalName.toLocaleLowerCase("en-US") !== "pcbnew") {
    throw new FluxPcbEditorIdentityError("KiCad executable PE roles do not match the pinned CLI/editor pair.");
  }
  if (binding.kicadCli.pe.fileVersion !== binding.pcbnew.pe.fileVersion ||
    binding.kicadCli.pe.productVersion !== binding.pcbnew.pe.productVersion ||
    binding.profile.kicadCli.operationalVersion !== binding.kicadCli.pe.productVersion) {
    throw new FluxPcbEditorIdentityError("KiCad CLI and PCB editor PE versions do not match.");
  }
};

export const bindFluxPcbEditorSuite = async (options: BindFluxPcbEditorSuiteOptions): Promise<FluxPcbEditorSuiteHostBinding> => {
  const profile = parseFluxKicadToolchainBinding(options.toolchain);
  const installationRoot = await bindCanonicalDirectoryTree(profile.binRoot, "KiCad bin root");
  const [kicadCli, pcbnew] = await Promise.all([
    bindExecutable(profile.kicadCli, installationRoot, "KiCad CLI executable"),
    bindExecutable(profile.pcbnew, installationRoot, "KiCad PCB editor executable"),
  ]);
  const bound = Object.freeze({
    profile,
    installationRoot,
    installationRootIdentity: canonicalIdentity({
      canonicalPath: process.platform === "win32" ? installationRoot.path.toLocaleLowerCase("en-US") : installationRoot.path,
      device: installationRoot.device.toString(10),
      inode: installationRoot.inode.toString(10),
      mode: installationRoot.mode.toString(10),
      createdNs: installationRoot.createdNs.toString(10),
    }, FLUX_KICAD_INSTALLATION_ROOT_SCHEMA_VERSION),
    kicadCli,
    pcbnew,
  });
  assertExecutableRole(bound);
  await runCliProbe(profile, installationRoot, options.runner ?? runBoundedProcess, exactEnvironment(options.environment ?? process.env));
  const afterProbe = await rebindFluxPcbEditorSuite(bound);
  if (!sameDirectory(bound.installationRoot, afterProbe.installationRoot) || !sameFile(bound.kicadCli.file, afterProbe.kicadCli.file) || !sameFile(bound.pcbnew.file, afterProbe.pcbnew.file)) {
    throw new FluxPcbEditorIdentityError("KiCad toolchain changed during its non-GUI identity probe.");
  }
  return bound;
};

const rebindFluxPcbEditorSuite = async (expected: FluxPcbEditorSuiteHostBinding): Promise<FluxPcbEditorSuiteHostBinding> => {
  const installationRoot = await bindCanonicalDirectoryTree(expected.profile.binRoot, "KiCad bin root");
  const [kicadCli, pcbnew] = await Promise.all([
    bindExecutable(expected.profile.kicadCli, installationRoot, "KiCad CLI executable"),
    bindExecutable(expected.profile.pcbnew, installationRoot, "KiCad PCB editor executable"),
  ]);
  const rebound = Object.freeze({ ...expected, installationRoot, kicadCli, pcbnew });
  assertExecutableRole(rebound);
  return rebound;
};

export const assertFluxPcbEditorSuite = async (expected: FluxPcbEditorSuiteHostBinding): Promise<void> => {
  const current = await rebindFluxPcbEditorSuite(expected);
  if (!sameDirectory(expected.installationRoot, current.installationRoot) ||
    !sameFile(expected.kicadCli.file, current.kicadCli.file) || !sameFile(expected.pcbnew.file, current.pcbnew.file)) {
    throw new FluxPcbEditorIdentityError("Pinned KiCad toolchain was replaced after preflight.");
  }
};

export const defaultFluxPcbEditorLauncher: FluxPcbEditorLauncher = async ({ executablePath, boardPath, environment }) => await new Promise((resolve, reject) => {
  const child = spawn(executablePath, [boardPath], { cwd: path.dirname(boardPath), env: environment, stdio: "ignore", windowsHide: false, detached: true });
  const exited = new Promise<Readonly<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>>((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit(Object.freeze({ code, signal })));
  });
  child.once("error", reject);
  child.once("spawn", () => {
    if (!Number.isSafeInteger(child.pid) || child.pid! <= 0) {
      reject(new FluxPcbEditorIdentityError("PCB editor launch did not return a valid process identity."));
      return;
    }
    child.unref();
    resolve(Object.freeze({ pid: child.pid!, exited }));
  });
});

export const launchFluxPcbEditor = async (
  binding: FluxPcbEditorSuiteHostBinding,
  boardPath: string,
  editorContext: KicadMcpEditorLaunchContext,
  launcher: FluxPcbEditorLauncher = defaultFluxPcbEditorLauncher,
  beforeLaunch?: () => Promise<void>,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  onSpawn?: FluxPcbEditorSpawnObserver,
): Promise<FluxPcbEditorLaunchResult> => {
  await assertFluxPcbEditorSuite(binding);
  await beforeLaunch?.();
  await assertFluxPcbEditorSuite(binding);
  const launchEnvironment = exactLaunchEnvironment(environment, editorContext);
  await editorContext.prepareLaunch();
  const result = await launcher({ executablePath: binding.pcbnew.file.path, boardPath: path.resolve(boardPath), environment: launchEnvironment });
  if (!Number.isSafeInteger(result.pid) || result.pid <= 0 || typeof result.exited?.then !== "function") throw new FluxPcbEditorIdentityError("PCB editor launcher returned an invalid process identity.");
  editorContext.observeExit(result.exited);
  await onSpawn?.(result);
  await assertFluxPcbEditorSuite(binding);
  return Object.freeze({ pid: result.pid, exited: result.exited });
};
