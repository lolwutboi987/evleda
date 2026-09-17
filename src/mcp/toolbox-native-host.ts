import { randomUUID } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { createKicadStackupReader } from "../integrations/kicad-stackup.js";
import { createToolboxSavedMicrostrip } from "./toolbox-saved-microstrip.js";
import { canonicalIdentity } from "../core/canonical.js";
import { nativeProjectFingerprint, type PreparedProject } from "../cli/pcb-agent.js";
import { defaultFluxPcbEditorLauncher, launchFluxPcbEditor, type FluxPcbEditorLauncher,
  type FluxPcbEditorLaunchResult, type FluxPcbEditorSuiteHostBinding } from "../flux/pcb-editor-launcher.js";
import { runBoundedWindowsProcessTreeTermination, type BoundedWindowsProcessTreeTermination } from "../integrations/bounded-process.js";
import { KicadMcpTerminationUncertainError, type KicadMcpBoundSessionAuthority, type KicadMcpInspectionIpcSocketBinding, type KicadMcpRuntimeBridge } from "../integrations/kicad-mcp-session.js";
import { KICAD_HARNESS_TOOL_NAMES, KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES, KICAD_PLANE_FRESH_SIDECAR_REQUIRED_TOOL_NAMES } from "../harness/kicad-tools.js";
import { openKicadToolboxSession, type ConnectedKicadToolbox } from "./toolbox-session.js";
import { assertFreshProjectDirectoryChain } from "../harness/fresh-project.js";
import { assertKicadToolboxFreshPreparation } from "./toolbox-fresh-preparation.js";
import { openKicadToolboxFreshSession, type KicadToolboxFreshSessionInput } from "./toolbox-fresh-session.js";
import { preflightOwnedEditorLocks, type OwnedEditorLocks } from "./toolbox-owned-editor-locks.js";
import { createToolboxPreview } from "./toolbox-preview.js";
import type { KicadCliAdapter } from "../integrations/kicad-cli.js";
import type { ReferenceCoverageCalculator } from "../integrations/kicad-reference-coverage.js";
import { createToolboxReferenceCoverage } from "./toolbox-reference-coverage.js";
import { assertKicadToolboxPlanePreparation } from "./toolbox-plane-preparation.js";
import { openKicadToolboxPlaneSession, type KicadToolboxPlaneSessionInput } from "./toolbox-plane-session.js";
import { bindKicadStartupEvidence, captureKicadStartupFailure, registeredKicadStartupCategory, withKicadStartupCleanup, type KicadStartupStage } from "../integrations/kicad-startup-diagnostic.js";
import { createToolboxStartupDiagnostic, writeToolboxStartupDiagnostic } from "./toolbox-startup-diagnostics.js";

export interface KicadToolboxNativeHostInput {
  readonly runtime: KicadMcpRuntimeBridge;
  readonly suite: FluxPcbEditorSuiteHostBinding;
  readonly prepared: PreparedProject;
  readonly pcbPath: string;
  readonly termination: BoundedWindowsProcessTreeTermination;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly launcher?: FluxPcbEditorLauncher;
  readonly createCliAdapter?: typeof KicadCliAdapter.create;
  readonly referenceCoverage?: ReferenceCoverageCalculator;
  /** Original authenticated preparation and host adapter factory, never JSON. */
  readonly fresh?: Omit<KicadToolboxFreshSessionInput, "authority">;
  readonly planeFresh?: Omit<KicadToolboxPlaneSessionInput, "authority">;
}

/** Host/test seams; never populated from model arguments or a settings file. */
export interface KicadToolboxNativeHostDependencies {
  readonly launcher?: FluxPcbEditorLauncher;
  readonly terminate?: typeof runBoundedWindowsProcessTreeTermination;
  readonly writeStartupDiagnostic?: typeof writeToolboxStartupDiagnostic;
}

async function observeExitWithin(exited: Promise<unknown>, timeoutMs = 4_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([exited, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Toolbox editor exit/request remains unconfirmed.")), timeoutMs);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

const comparablePath = (value: string): string => process.platform === "win32" ? value.toLowerCase() : value;
const contains = (root: string, candidate: string): boolean => {
  const relative = path.relative(comparablePath(root), comparablePath(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

async function assertCanonicalDirectory(candidate: string): Promise<string> {
  const absolute = path.resolve(candidate);
  const canonical = await realpath(absolute);
  if (comparablePath(absolute) !== comparablePath(canonical)) throw new Error("Copied project directories must not be aliases.");
  let cursor = absolute;
  for (;;) {
    const metadata = await lstat(cursor);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Copied project directories must not contain links or junctions.");
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return canonical;
}

async function assertCopiedProjectIsolation(prepared: PreparedProject): Promise<string> {
  const [projectRoot, outputRoot, sourceRoot] = await Promise.all([
    assertCanonicalDirectory(prepared.isolatedProjectPath),
    assertCanonicalDirectory(prepared.outputPath),
    realpath(prepared.sourceProjectPath),
  ]);
  if (!(await lstat(sourceRoot)).isDirectory() || !contains(outputRoot, projectRoot)
      || comparablePath(outputRoot) === comparablePath(projectRoot)
      || contains(sourceRoot, outputRoot) || contains(outputRoot, sourceRoot)) {
    throw new Error("Copied project must remain inside its output directory and disjoint from its source.");
  }
  const pending = [projectRoot];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    await assertCanonicalDirectory(directory);
    for (const name of await readdir(directory)) {
      const candidate = path.join(directory, name);
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())
          || (metadata.isFile() && metadata.nlink !== 1)) {
        throw new Error("Copied project contains a link, shared file, or unsupported entry.");
      }
      if (metadata.isDirectory()) pending.push(candidate);
    }
  }
  return projectRoot;
}

/** Compose existing host capabilities; no provider or model-selected runtime. */
export async function openKicadToolboxNativeHost(
  input: KicadToolboxNativeHostInput,
  dependencies: KicadToolboxNativeHostDependencies = {},
): Promise<ConnectedKicadToolbox> {
  const prepared = Object.freeze({ ...input.prepared });
  if (input.fresh !== undefined && input.planeFresh !== undefined) throw new Error("Native startup cannot mix routed and plane preparation families.");
  const assertProject = async (): Promise<string> => {
    if (input.fresh === undefined && input.planeFresh === undefined) {
      if (prepared.freshProject !== undefined) throw new Error("Fresh native startup requires authenticated host preparation.");
      return assertCopiedProjectIsolation(prepared);
    }
    const preparation = input.planeFresh === undefined ? input.fresh!.preparation : input.planeFresh.preparation;
    if (input.planeFresh !== undefined) assertKicadToolboxPlanePreparation(preparation);
    else assertKicadToolboxFreshPreparation(preparation);
    const project = preparation.project;
    if (project !== prepared.freshProject || prepared.isolatedProjectPath !== project.projectPath
        || prepared.outputPath !== project.outputPath || input.pcbPath !== project.pcbPath) throw new Error("Fresh native paths differ from authenticated preparation.");
    await assertFreshProjectDirectoryChain(project);
    await project.assertMarkerCurrent();
    return realpath(project.projectPath);
  };
  const projectRoot = await assertProject();
  const pcbPath = await realpath(input.pcbPath);
  if (path.dirname(pcbPath) !== projectRoot || path.extname(pcbPath).toLowerCase() !== ".kicad_pcb"
      || !(await lstat(input.pcbPath)).isFile()) throw new Error("Native toolbox board must be the exact ordinary board in the copied project root.");
  const baseline = await nativeProjectFingerprint(projectRoot);
  const runBindingIdentity = canonicalIdentity({ nonce: randomUUID(), projectRoot, pcbPath,
    sources: baseline, runtime: input.runtime.identity }, "evleda.toolbox-native-run.v1");
  let socket: KicadMcpInspectionIpcSocketBinding | undefined;
  let authority: KicadMcpBoundSessionAuthority | undefined;
  let editor: (FluxPcbEditorLaunchResult & { waitUntilReady?: () => Promise<void>; requestClose?: () => Promise<void>; detach?: () => void }) | undefined;
  let editorExited = false;
  let editorTeardownConfirmed = false;
  let ownedLocks: OwnedEditorLocks | undefined;
  let locksCaptured = false;
  let connected: ConnectedKicadToolbox | undefined;
  let closing: Promise<void> | undefined;
  const cleanup = async (): Promise<void> => {
    const failures: unknown[] = [];
    let sidecarTeardownConfirmed = false;
    const graceful = editor?.requestClose !== undefined;
    if (graceful && editor !== undefined) {
      try {
        if (!editorExited) {
          await connected?.assertCurrent();
          await observeExitWithin(editor.requestClose!());
        }
        await observeExitWithin(editor.exited, 10_000);
        editorTeardownConfirmed = true;
      } catch (error) { failures.push(error); editor.detach?.(); }
    }
    if (!graceful && connected !== undefined && ownedLocks !== undefined && locksCaptured && !editorExited) {
      try { await connected.assertCurrent(); await ownedLocks.refresh(); }
      catch (error) { failures.push(error); }
    }
    try {
      if (connected !== undefined) { await connected.close(); sidecarTeardownConfirmed = true; }
      else if (authority !== undefined) await authority.disposeUnused();
    } catch (error) { failures.push(error); }
    if (editor !== undefined && !graceful) {
      try {
        if (!editorExited) {
          const confirmed = await (dependencies.terminate ?? runBoundedWindowsProcessTreeTermination)(
            editor.pid, input.termination, () => editorExited, 4_000);
          if (!confirmed) throw new Error("Toolbox editor process-tree termination remains unconfirmed; IPC allocation retained.");
        }
        await observeExitWithin(editor.exited);
        editorTeardownConfirmed = true;
      } catch (error) { failures.push(error); }
    }
    if (failures.length === 0 && ownedLocks !== undefined) {
      try { await ownedLocks.release(); } catch (error) { failures.push(error); }
    }
    if (failures.length === 0 && socket !== undefined) {
      try {
        if (await input.runtime.releaseIpcSocket(socket, runBindingIdentity) !== "released") {
          throw new Error("Toolbox IPC allocation remains active and was retained.");
        }
      } catch (error) { failures.push(error); }
    }
    // This records only observed host-owned teardown, never workspace lease
    // release or live schematic reload. Diagnostics cannot change cleanup.
    try {
      await connected?.finalizeSchematicFieldFailure?.({ nativeEditorTeardown: editorTeardownConfirmed ? "confirmed" : "unconfirmed",
        sidecarTeardown: sidecarTeardownConfirmed ? "confirmed" : "unconfirmed", ownedHostCleanup: failures.length === 0 ? "confirmed" : "unconfirmed",
        checkpoint: "not-observed" });
    } catch { /* Preserve the original cleanup outcome if private diagnostics fail. */ }
    if (failures.length > 0) throw new AggregateError(failures, "Native toolbox cleanup was not confirmed; owned state was retained.");
  };
  const close = (): Promise<void> => closing ??= cleanup();
  let startupStage: KicadStartupStage = "ipc-allocation";
  try {
    socket = await input.runtime.allocateIpcSocket({ runBindingIdentity });
    startupStage = "editor-context";
    const context = await input.runtime.getEditorLaunchContext(socket, runBindingIdentity);
    const launcher: FluxPcbEditorLauncher = async (request) => {
      startupStage = "editor-launch";
      const result = await (dependencies.launcher ?? input.launcher ?? defaultFluxPcbEditorLauncher)(request);
      // Capture before launchFluxPcbEditor runs any fallible post-spawn checks.
      editor = result;
      void result.exited.then(() => { editorExited = true; }, () => { /* cleanup awaits and surfaces rejection */ });
      return result;
    };
    await launchFluxPcbEditor(input.suite, pcbPath, context, launcher, async () => {
      startupStage = "editor-preflight";
      await assertProject();
      await input.runtime.assertCurrent();
      await input.runtime.assertIpcSocket(socket!, runBindingIdentity);
      if (await nativeProjectFingerprint(projectRoot) !== baseline) throw new Error("Copied project changed before editor launch.");
      ownedLocks = await preflightOwnedEditorLocks({ outputRoot: prepared.outputPath, projectRoot, pcbPath,
        isEditorTeardownConfirmed: () => editorTeardownConfirmed });
    }, input.environment);
    // Native readiness has its own existing editor-start bound; it must finish
    // before allocating the separate MCP connection/deadline budget.
    startupStage = "editor-readiness";
    if (editor?.waitUntilReady === undefined) throw new Error("Owned editor launcher did not provide its readiness witness.");
    await editor.waitUntilReady();
    if (editorExited) throw new Error("Toolbox PCB editor exited before session binding.");
    startupStage = "session-authority";
    authority = await input.runtime.bindSession({ runBindingIdentity, ipcSocket: socket, mode: "write",
      requiredTools: Object.freeze([...(input.planeFresh !== undefined ? KICAD_PLANE_FRESH_SIDECAR_REQUIRED_TOOL_NAMES
        : input.fresh === undefined ? KICAD_HARNESS_TOOL_NAMES : KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES)].sort()),
      roots: { workspaceRoot: prepared.outputPath, projectRoot: prepared.isolatedProjectPath,
        outputRoot: path.join(prepared.outputPath, ".evleda-mcp-output") } });
    startupStage = "session-connect";
    connected = input.planeFresh !== undefined ? await openKicadToolboxPlaneSession({ ...input.planeFresh, authority })
      : input.fresh === undefined ? await openKicadToolboxSession({ authority, prepared, pcbPath })
      : await openKicadToolboxFreshSession({ ...input.fresh, authority });
    startupStage = "session-recheck";
    await connected.assertCurrent();
    startupStage = "lock-capture";
    await ownedLocks!.capture();
    locksCaptured = true;
    const owned = connected;
    const createAdapter = input.createCliAdapter ?? input.fresh?.createCliAdapter ?? input.planeFresh?.createCliAdapter;
    const schematicPath = prepared.freshProject?.schematicPath ?? path.join(projectRoot, `${path.basename(pcbPath, ".kicad_pcb")}.kicad_sch`);
    startupStage = "preview-binding";
    let renderPreview: ReturnType<typeof createToolboxPreview> | undefined;
    if (createAdapter !== undefined && (await lstat(schematicPath).catch(() => undefined))?.isFile()) {
      renderPreview = createToolboxPreview({ pcbPath, schematicPath, createAdapter,
        adapterOptions: { workspaceRoot: prepared.outputPath, projectRoot, outputRoot: prepared.outputPath,
          executablePath: input.suite.profile.kicadCli.path,
          expectedExecutableIdentity: { sha256: input.suite.profile.kicadCli.contentIdentity.digest, sizeBytes: input.suite.profile.kicadCli.contentIdentity.size } } });
    }
    startupStage = "stackup-binding";
    const readStackup = await createKicadStackupReader({ pcbPath });
    const checkMicrostripRoute = await createToolboxSavedMicrostrip({ pcbPath });
    startupStage = "reference-binding";
    const checkReferenceCoverage = input.referenceCoverage === undefined ? undefined
      : await createToolboxReferenceCoverage({ pcbPath, calculator: input.referenceCoverage });
    return Object.freeze({ tools: owned.tools, assertCurrent: () => owned.assertCurrent(), readStackup, checkMicrostripRoute,
      ...(owned.planeAuthoringContext === undefined ? {} : { planeAuthoringContext: owned.planeAuthoringContext }),
      captureSources: () => owned.captureSources(),
      ...(checkReferenceCoverage === undefined ? {} : { checkReferenceCoverage }),
      ...(owned.checkEndpointConnectivity === undefined ? {} : { checkEndpointConnectivity: () => owned.checkEndpointConnectivity!() }),
      ...(owned.checkPlaneAcceptance === undefined ? {} : { checkPlaneAcceptance: owned.checkPlaneAcceptance }),
      ...(owned.checkInterface === undefined ? {} : { checkInterface: owned.checkInterface }),
      ...(renderPreview === undefined ? {} : { renderPreview }),
      ...(owned.prepareCheckpoint === undefined ? {} : { prepareCheckpoint: () => owned.prepareCheckpoint!() }),
      ...(owned.recordRecoveryRequired === undefined ? {} : { recordRecoveryRequired: (reason: string) => owned.recordRecoveryRequired!(reason) }),
      ...(owned.analyzePractices === undefined ? {} : { analyzePractices: () => owned.analyzePractices!() }), close });
  } catch (error) {
    // Capture before any cleanup or diagnostic I/O can fail. Never expose the
    // foreign error graph through Error.cause, AggregateError or custom inspect.
    const primary = captureKicadStartupFailure(error, startupStage);
    const writeDiagnostic = dependencies.writeStartupDiagnostic ?? writeToolboxStartupDiagnostic;
    let primaryArtifact: Awaited<ReturnType<typeof writeToolboxStartupDiagnostic>> | undefined;
    let finalArtifact: Awaited<ReturnType<typeof writeToolboxStartupDiagnostic>> | undefined;
    let primaryWriteFailed = false, finalWriteFailed = false;
    try { primaryArtifact = await writeDiagnostic(prepared.outputPath, createToolboxStartupDiagnostic("primary-failure", primary)); }
    catch { primaryWriteFailed = true; }
    let finalized = primary;
    let cleanupConfirmed = true;
    try { await close(); finalized = withKicadStartupCleanup(primary, "host-cleanup", "confirmed"); }
    catch (cleanupError) { cleanupConfirmed = false; finalized = withKicadStartupCleanup(primary, "host-cleanup", "unconfirmed", cleanupError); }
    try { finalArtifact = await writeDiagnostic(prepared.outputPath, createToolboxStartupDiagnostic("cleanup-finished", finalized)); }
    catch { finalWriteFailed = true; }
    const artifact = primaryArtifact ?? finalArtifact;
    const reference = artifact === undefined ? " Diagnostic publication failed." : ` Diagnostic: ${artifact.filename} (sha256:${artifact.identity.digest}).`;
    const message = cleanupConfirmed ? "Native toolbox startup failed." : "Native toolbox startup failed and cleanup was not confirmed.";
    const options = { cause: Object.freeze({ ...finalized, diagnostics: Object.freeze({ primary: primaryArtifact ?? null, final: finalArtifact ?? null,
      primaryWriteFailed, finalWriteFailed }) }) };
    const publicMessage = `${message} Stage: ${primary.failure.stage}; category: ${primary.failure.cause.category}.${reference}`;
    const category = registeredKicadStartupCategory(error);
    const failure = !cleanupConfirmed || category === "kicad-termination-uncertain" || category === "kicad-verification-deadline"
      ? new KicadMcpTerminationUncertainError(publicMessage, options) : new Error(publicMessage, options);
    throw bindKicadStartupEvidence(failure, finalized);
  }
}
