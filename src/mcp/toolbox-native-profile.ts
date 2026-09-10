import path from "node:path";
import { realpath } from "node:fs/promises";
import { readKicadNativeProfile } from "../flux/production-composition.js";
import { createFluxKicadToolchainBinding } from "../flux/kicad-toolchain-binding.js";
import { bindFluxPcbEditorSuite } from "../flux/pcb-editor-launcher.js";
import { KicadCliAdapter } from "../integrations/kicad-cli.js";
import { createOwnedKicadEditorLauncher } from "./toolbox-editor-launcher.js";
import {
  BOUNDED_WINDOWS_PROCESS_TREE_TERMINATION_SCHEMA_VERSION, runBoundedProcess,
  type BoundedWindowsProcessTreeTermination,
} from "../integrations/bounded-process.js";
import {
  createKicadMcpRuntimeBridge, KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS,
  KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY, KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
  type KicadMcpPinnedFileInput,
} from "../integrations/kicad-mcp-session.js";

/** Host configuration, never accepted as model tool arguments. */
export interface KicadToolboxNativeProfileInput {
  readonly profile: KicadMcpPinnedFileInput;
  readonly sourceRoot: string;
  readonly outputRoot: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Optional host-approved library/guidance roots used by fresh design tools. */
  readonly additionalProtectedRoots?: readonly string[];
}

const overlaps = (left: string, right: string): boolean => {
  const relative = path.relative(left, right);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
};

/** Verify and compose native CAD only; no provider credentials or model runner. */
export async function loadKicadToolboxNativeProfile(input: KicadToolboxNativeProfileInput) {
  const profile = await readKicadNativeProfile(input.profile);
  const [sourceRoot, outputRoot] = await Promise.all([realpath(input.sourceRoot), realpath(input.outputRoot)]);
  if (overlaps(sourceRoot, outputRoot) || overlaps(outputRoot, sourceRoot)) throw new Error("Native toolbox source and output roots must be separate.");
  const runtime = profile.kicadMcpRuntime;
  const suite = profile.kicadToolchain;
  const environment = input.environment ?? process.env;
  const systemRoot = environment.SYSTEMROOT ?? environment.SystemRoot;
  const windowsDirectory = environment.WINDIR ?? environment.windir;
  if (systemRoot === undefined || windowsDirectory === undefined ||
      path.resolve(systemRoot).toLowerCase() !== path.resolve(windowsDirectory).toLowerCase()) {
    throw new Error("Native toolbox requires matching SYSTEMROOT and WINDIR.");
  }
  // Do not pass provider tokens, Python startup options, or unrelated host state.
  const nativeEnvironment = Object.freeze({ SYSTEMROOT: systemRoot, WINDIR: windowsDirectory });
  const termination: BoundedWindowsProcessTreeTermination = Object.freeze({
    schemaVersion: BOUNDED_WINDOWS_PROCESS_TREE_TERMINATION_SCHEMA_VERSION,
    executablePath: runtime.processTreeSupervision.terminator.path,
    executableIdentity: runtime.processTreeSupervision.terminator.identity,
    cwd: runtime.runtimeBundle.root, env: nativeEnvironment,
  });
  const additionalRoots = await Promise.all((input.additionalProtectedRoots ?? []).map(root => realpath(root)));
  if (profile.kicadTransmissionLine !== undefined) additionalRoots.push(await realpath(path.dirname(profile.kicadTransmissionLine.path)));
  if (profile.kicadReferenceCoverage !== undefined) additionalRoots.push(await realpath(path.dirname(profile.kicadReferenceCoverage.path)));
  if (profile.kicadPlaneContacts !== undefined) additionalRoots.push(
    await realpath(profile.kicadPlaneContacts.runtimeRoot), await realpath(path.dirname(profile.kicadPlaneContacts.helper.path)),
    await realpath(path.dirname(profile.kicadPlaneContacts.manifest.path)));
  const protectedRoots = [...new Set([sourceRoot, outputRoot, path.dirname(profile.path), suite.binRoot,
    runtime.runtimeBundle.root, path.dirname(runtime.lock.path), path.dirname(runtime.runtimeBundle.manifest.path),
    ...additionalRoots])];
  for (const editable of [sourceRoot, outputRoot]) {
    for (const fixed of [profile.path, suite.binRoot, runtime.runtimeBundle.root, runtime.lock.path,
      runtime.runtimeBundle.manifest.path, termination.executablePath, ...additionalRoots]) {
      if (overlaps(editable, fixed) || overlaps(fixed, editable)) throw new Error("Native toolbox project roots overlap fixed native resources.");
    }
  }
  const kicadToolchain = createFluxKicadToolchainBinding({ binRoot: suite.binRoot,
    kicadCli: { path: suite.kicadCli.path, contentIdentity: suite.kicadCli.identity,
      operationalVersion: suite.kicadCli.operationalVersion, operationalCommit: suite.kicadCli.operationalCommit,
      peFileVersion: suite.kicadCli.peFileVersion, peProductVersion: suite.kicadCli.peProductVersion },
    pcbnew: { path: suite.pcbnew.path, contentIdentity: suite.pcbnew.identity,
      peFileVersion: suite.pcbnew.peFileVersion, peProductVersion: suite.pcbnew.peProductVersion } });
  const expected = runtime.runtimeBundle.expectedClosure;
  // The existing bridge checks every pinned file, runtime closure and root.
  const bridge = await createKicadMcpRuntimeBridge({
    lockFile: { path: runtime.lock.path, contentIdentity: runtime.lock.identity },
    runtimeBundle: { root: runtime.runtimeBundle.root,
      manifestFile: { path: runtime.runtimeBundle.manifest.path, contentIdentity: runtime.runtimeBundle.manifest.identity },
      expectedClosure: { fileCount: expected.fileCount, manifestIdentity: expected.manifestIdentity,
        treeIdentity: expected.treeIdentity, protocol: expected.protocol,
        python: { relativePath: expected.python.relativePath, contentIdentity: expected.python.identity },
        entrypoint: { relativePath: expected.entrypoint.relativePath, contentIdentity: expected.entrypoint.identity } } },
    runtimeParentRoot: runtime.runtimeParentRoot, ipcSocketParentRoot: runtime.ipcSocketParentRoot,
    verificationTimeoutMs: KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS,
    ...(runtime.runtimePolicy.connectionDeadlinePolicy === undefined ? {}
      : { connectionDeadlinePolicy: runtime.runtimePolicy.connectionDeadlinePolicy }),
    processTreeSupervision: { strategy: KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY,
      terminator: { path: termination.executablePath, contentIdentity: termination.executableIdentity },
      timeoutMs: KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS },
    kicadCli: { path: suite.kicadCli.path, contentIdentity: suite.kicadCli.identity },
    environment: nativeEnvironment, protectedRoots,
  });
  const editorSuite = await bindFluxPcbEditorSuite({ toolchain: kicadToolchain, environment: nativeEnvironment,
    runner: options => runBoundedProcess({ ...options, windowsProcessTreeTermination: termination }) });
  await bridge.assertCurrent();
  const createCliAdapter: typeof KicadCliAdapter.create = async options => {
    const adapter = await KicadCliAdapter.create({ ...options, executablePath: suite.kicadCli.path,
      expectedExecutableIdentity: { sha256: suite.kicadCli.identity.digest, sizeBytes: suite.kicadCli.identity.size },
      environment: nativeEnvironment,
      runner: request => runBoundedProcess({ ...request, windowsProcessTreeTermination: termination }) });
    if (adapter.identity.version !== suite.kicadCli.operationalVersion || adapter.identity.commit !== suite.kicadCli.operationalCommit) {
      throw new Error("Toolbox KiCad CLI adapter differs from the approved operational version/commit.");
    }
    return adapter;
  };
  const transmissionLine = profile.kicadTransmissionLine === undefined ? undefined
    : await (await import("../integrations/kicad-transmission-line.js")).createKicadTransmissionLineCalculator({
      executablePath: profile.kicadTransmissionLine.path,
      expectedExecutableIdentity: { sha256: profile.kicadTransmissionLine.identity.digest, sizeBytes: profile.kicadTransmissionLine.identity.size },
      cwd: path.dirname(profile.kicadTransmissionLine.path), environment: nativeEnvironment,
      windowsProcessTreeTermination: termination,
    });
  const referenceCoverage = profile.kicadReferenceCoverage === undefined ? undefined
    : await (await import("../integrations/kicad-reference-coverage.js")).createReferenceCoverageCalculator({
      executablePath: profile.kicadReferenceCoverage.path,
      expectedExecutableIdentity: { sha256: profile.kicadReferenceCoverage.identity.digest, sizeBytes: profile.kicadReferenceCoverage.identity.size },
      cwd: path.dirname(profile.kicadReferenceCoverage.path), outputRoot, environment: nativeEnvironment,
      windowsProcessTreeTermination: termination,
    });
  const plane = profile.kicadPlaneContacts;
  const createPlaneContactsReader = plane === undefined ? undefined
    : async (board: {readonly pcbPath:string;readonly expectedSourceIdentity:import("../domain/types.js").ContentIdentity}) =>
      (await import("../integrations/kicad-plane-contacts.js")).createKicadPlaneContactsReader({ ...board, runtimeRoot: plane.runtimeRoot,
        manifest: {path:plane.manifest.path,contentIdentity:plane.manifest.identity}, helper: {path:plane.helper.path,contentIdentity:plane.helper.identity},
        outputRoot,environment:nativeEnvironment,windowsProcessTreeTermination:termination });
  return Object.freeze({ bridge, editorSuite, termination, environment: nativeEnvironment,
    ...(createPlaneContactsReader === undefined ? {} : { createPlaneContactsReader }),
    ...(referenceCoverage === undefined ? {} : { referenceCoverage }),
    ...(transmissionLine === undefined ? {} : { transmissionLine }),
    createCliAdapter, editorLauncher: createOwnedKicadEditorLauncher({
      python: { path: path.resolve(runtime.runtimeBundle.root, ...expected.python.relativePath.split("/")), contentIdentity: expected.python.identity },
      environment: nativeEnvironment }), profileIdentity: profile.contentIdentity });
}
