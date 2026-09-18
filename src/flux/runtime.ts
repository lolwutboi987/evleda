import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  PCB_AGENT_CLI_REPORT_SCHEMA_VERSION,
  PCB_AGENT_HARNESS_RULE_IDENTITY,
  PCB_AGENT_MUTATION_ALLOWLIST,
  computeGenericPcbAgentHarnessRuleIdentity,
  pcbAgentRequiredSessionTools,
  runPcbAgentCli,
  type PcbAgentCliDependencies,
  type PcbAgentCliExecution,
  type PcbAgentCliEvent,
  type PcbAgentCliOptions,
  type PcbAgentCliReport
} from "../cli/pcb-agent.js";
import { canonicalIdentity, canonicalJson } from "../core/canonical.js";
import { verifyHostSchematicRenderClearanceEvidence } from "../integrations/schematic-render-clearance.js";
import { validateCanonicalIdentity } from "../core/portable-artifact.js";
import type { PcbDesignCompilationBundleDependencies } from "../harness/pcb-design-compilation-bundle.js";
import { parsePcbProviderProfileBinding, type PcbProviderProfileBinding } from "../harness/pcb-design-interpreter.js";
import {
  FRESH_CLEARANCE_EVIDENCE_RECEIPT_SCHEMA_VERSION,
  FRESH_NETCLASS_MATERIALIZATION_SCHEMA_VERSION,
  createFreshNetClassPreparationEvidence,
  materializeFreshNetClasses,
  parseFreshNetClassPreparationEvidence,
  parseFreshNetClassSemanticAuthority,
  readFreshClearanceEvidence,
  readFreshNetClassSemanticAuthority,
  verifyFreshClearanceEvidenceReceipt,
  verifyFreshClearanceEvidenceReceiptAgainstSemanticAuthority,
  verifyFreshNetClassSemanticAuthority,
  type FreshClearanceEvidenceReceipt,
  type FreshNetClassMaterialization,
  type FreshNetClassPreparationEvidence,
  type FreshNetClassSemanticAuthority,
} from "../harness/fresh-clearance-evidence.js";
import { PCB_AGENT_MAX_FRESH_ITERATIONS, PCB_AGENT_MIN_ITERATIONS, PCB_AGENT_RECOMMENDED_FRESH_ITERATIONS } from "../harness/pcb-agent-harness.js";
import { captureFreshProjectOpenPreparedSourceAuthority, checkpointFreshProjectOpenNormalization, parseFreshProjectOpenPreparedSourceAuthority, prepareFreshProject, type FreshProject, type FreshProjectNetClassSemanticProjection, type FreshProjectOpenPreparedSourceAuthority } from "../harness/fresh-project.js";
import { runBoundedProcess, type BoundedProcessRunner } from "../integrations/bounded-process.js";
import { KicadCliAdapter, type KicadCliAdapterOptions, type KicadExecutableIdentity } from "../integrations/kicad-cli.js";
import {
  KICAD_MCP_INSPECTION_TOOL_ALLOWLIST,
  KICAD_MCP_IPC_SOCKET_MAX_CONNECTIONS,
  KICAD_MCP_SESSION_RECEIPT_SCHEMA_VERSION,
  KICAD_MCP_SESSION_SEMANTIC_IDENTITY_SCHEMA_VERSION,
  KicadMcpSession,
  KicadMcpTerminationUncertainError,
  type KicadMcpBoundSessionAuthority,
  type KicadMcpInspectionIpcSocketBinding,
  type KicadMcpRuntimeBridge,
  type KicadMcpRuntimeOperationContext,
} from "../integrations/kicad-mcp-session.js";
import { FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE, FLUX_OPEN_CHECKPOINT_SCHEMA_VERSION, FLUX_OPEN_IPC_PROBE_SEMANTIC_SCHEMA_VERSION, FLUX_OPEN_PREFLIGHT_SCHEMA_VERSION, FluxError, fluxDigest, fluxOpenPreparationDigest, type FluxCanonicalIdentityDto, type FluxCheckpointOpenRequest, type FluxCheckpointOperationContext, type FluxCompilationInterpreterPort, type FluxExecuteRequest, type FluxFreshAcceptanceProjection, type FluxOpenPreflightReceipt, type FluxPrepareRequest, type FluxProviderModel, type FluxReportMetadata, type FluxRuntimePolicyDto, type FluxSourceCatalogInput } from "./contracts.js";
import { FileFluxCompilationBundleStore, type FluxCompilationBundleStore } from "./compilation-bundle-store.js";
import { createFluxFreshClearanceEvidenceBinding } from "./fresh-clearance-evidence-binding.js";
import { FluxInspector, type FluxInspectionAuthorityDto, type FluxInspectorSnapshot } from "./inspector.js";
import { parseFluxKicadToolchainBinding, type FluxKicadToolchainBinding } from "./kicad-toolchain-binding.js";
import { createFluxOpenCheckpointReceipt, createFluxOpenPreflightReceipt } from "./open-preflight.js";
import { assertFluxPcbEditorSuite, bindFluxPcbEditorSuite, FluxPcbEditorProbeUncertainError, launchFluxPcbEditor, type FluxPcbEditorLauncher, type FluxPcbEditorSuiteHostBinding } from "./pcb-editor-launcher.js";
import { FluxPreviewRenderer } from "./preview-renderer.js";
import type { FluxPreviewManifestBinding, FluxRoutesOptions } from "./routes.js";
import { FluxRunManager } from "./run-manager.js";

const NATIVE_FILE = /\.kicad_(?:pro|sch|pcb|dru|wks|sym|mod|jobset|dbl)$/iu;
const KEY_FILE = /\.kicad_(?:pro|sch|pcb)$/iu;
const FRESH_NAME_PATTERN = "^[a-z][a-z0-9-]{0,63}$" as const;
export const FLUX_FRESH_ACCEPTANCE_PROFILE_IDENTITY = "evleda.flux.fresh-led-indicator-acceptance.v1";
export const FLUX_GENERIC_ACCEPTANCE_PROFILE_IDENTITY = "evleda.flux.generic-design-acceptance.pending.v1";
export const FLUX_FRESH_PERSISTENCE_PROFILE_IDENTITY = "evleda.flux.fresh-board-persistence.v1";
export const FLUX_OPEN_RUN_BINDING_SCHEMA_VERSION = "evleda.flux-open-run-binding.v1" as const;
export const FLUX_ITERATION_CAP_POLICY = Object.freeze({
  minimum: PCB_AGENT_MIN_ITERATIONS,
  maximum: PCB_AGENT_MAX_FRESH_ITERATIONS,
  recommended: PCB_AGENT_RECOMMENDED_FRESH_ITERATIONS
});
export const computeFluxGenericAcceptanceProfileIdentity = (request: Readonly<{ readonly acceptancePlan: { readonly identity: unknown }; readonly practiceProfileBinding: { readonly identity: unknown } }>): string => fluxDigest({
  schemaVersion: "evleda.flux.generic-design-acceptance-profile.v1",
  acceptancePlanIdentity: request.acceptancePlan.identity,
  practiceProfileBindingIdentity: request.practiceProfileBinding.identity
});
const exactStrings = (left: readonly string[], right: readonly string[]): boolean => {
  const normalizedLeft = [...left].sort(); const normalizedRight = [...right].sort();
  return normalizedLeft.length === normalizedRight.length && normalizedLeft.every((entry, index) => entry === normalizedRight[index]);
};
const CANONICAL_PCB_AGENT_MUTATION_ALLOWLIST = Object.freeze([...PCB_AGENT_MUTATION_ALLOWLIST].sort());
const canonicalPolicyMutationAllowlist = (input: readonly string[]): readonly string[] => {
  const unique = new Set(input);
  const canonical = [...unique].sort();
  if (input.length !== CANONICAL_PCB_AGENT_MUTATION_ALLOWLIST.length || unique.size !== input.length ||
    input.some((entry) => !/^[a-z][a-z0-9_]{0,127}$/u.test(entry)) ||
    canonical.some((entry, index) => entry !== CANONICAL_PCB_AGENT_MUTATION_ALLOWLIST[index])) {
    throw new FluxError("INVALID_ARGUMENT", "Flux harness mutation policy must be the exact unique executable mutation-tool set.");
  }
  return Object.freeze(canonical);
};
const assertCheckpointOperationActive = (context: FluxCheckpointOperationContext): void => {
  if (context.signal.aborted || !Number.isFinite(context.deadlineAtMs) || Date.now() >= context.deadlineAtMs) {
    throw new FluxError("OPERATION_UNCERTAIN", FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE);
  }
};
const checkpointStep = async <Value>(context: FluxCheckpointOperationContext, operation: () => Promise<Value>): Promise<Value> => {
  assertCheckpointOperationActive(context);
  try {
    const value = await operation();
    assertCheckpointOperationActive(context);
    return value;
  } catch (error) {
    assertCheckpointOperationActive(context);
    throw error;
  }
};
const optionalCheckpointStep = async <Value>(context: FluxCheckpointOperationContext | undefined, operation: () => Promise<Value>): Promise<Value> =>
  context === undefined ? await operation() : await checkpointStep(context, operation);
const checkpointMcpContext = (context: FluxCheckpointOperationContext): KicadMcpRuntimeOperationContext => {
  assertCheckpointOperationActive(context);
  return Object.freeze({
    signal: context.signal,
    deadlineAtMs: performance.now() + Math.max(0, context.deadlineAtMs - Date.now()),
  });
};
type CheckpointFailureStage = "initial_validation" | "prepared_binding" | "runtime_revalidation" | "ipc_validation"
  | "toolchain_probe" | "prepared_source_readback" | "normalization" | "readonly_ipc_probe" | "write_binding"
  | "final_validation_publication";
const CHECKPOINT_FLUX_ERROR_CODES = new Set([
  "INVALID_ARGUMENT", "NOT_FOUND", "ILLEGAL_TRANSITION", "APPROVAL_MISMATCH", "APPROVAL_CONSUMED",
  "IDEMPOTENCY_CONFLICT", "OPERATION_UNCERTAIN", "OPEN_PREFLIGHT_FAILED", "EVIDENCE_CAPACITY", "PATH_POLICY", "STORE_CORRUPT",
]);
const CHECKPOINT_SYSTEM_ERROR_CODES = new Set([
  "ENOENT", "EACCES", "EPERM", "EIO", "ENOSPC", "EMFILE", "ENFILE", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "EPIPE",
]);
/** Best-effort local observability only; never a receipt or lifecycle authority. */
const reportCheckpointFailure = (runId: string, stage: CheckpointFailureStage, startedAtMs: number, error: unknown): void => {
  try {
    const code: unknown = error instanceof Error ? Object.getOwnPropertyDescriptor(error, "code")?.value : undefined;
    const [errorCategory, errorCode] = error instanceof KicadMcpTerminationUncertainError
      ? ["termination_uncertain", "KICAD_MCP"]
      : error instanceof FluxPcbEditorProbeUncertainError
        ? ["termination_uncertain", "PCB_EDITOR_PROBE"]
        : error instanceof FluxError && typeof code === "string" && CHECKPOINT_FLUX_ERROR_CODES.has(code)
          ? ["flux", code]
          : typeof code === "string" && CHECKPOINT_SYSTEM_ERROR_CODES.has(code)
            ? ["system", code]
            : [error instanceof Error ? "error" : "non_error", "UNKNOWN"];
    const elapsed = performance.now() - startedAtMs;
    process.stderr.write(`${JSON.stringify({
      event: "flux_checkpoint_failure",
      runId: /^run_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(runId) ? runId : "invalid",
      stage,
      elapsedMs: Number.isFinite(elapsed) ? Math.min(86_400_000, Math.max(0, Math.round(elapsed))) : 0,
      errorCategory,
      errorCode,
    })}\n`);
  } catch {
    // Diagnostic classification or stderr failure must not replace the checkpoint failure.
  }
};

type FluxRuntimeCheckpointNormalizerOptions = Omit<Parameters<typeof checkpointFreshProjectOpenNormalization>[0], "name"> & Readonly<{
  readonly newProjectName: string;
}>;
type FluxRuntimeCheckpointNormalizer = (options: FluxRuntimeCheckpointNormalizerOptions) => ReturnType<typeof checkpointFreshProjectOpenNormalization>;

interface SourceBinding extends FluxSourceCatalogInput {
  readonly mode: "copy" | "new";
}

interface RuntimeFsBinding {
  readonly kind: "directory" | "file";
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: bigint;
  readonly linkCount: bigint;
  readonly createdNs: bigint;
}

interface PreparedBinding {
  readonly source: SourceBinding;
  readonly outputRoot: string;
  readonly projectRoot: string;
  readonly schematicPath: string;
  readonly pcbPath: string;
  readonly authorityDigest: string;
  readonly outputIdentity: RuntimeFsBinding;
  readonly projectIdentity: RuntimeFsBinding;
  readonly schematicIdentity: RuntimeFsBinding;
  readonly pcbIdentity: RuntimeFsBinding;
}

interface RuntimePreviewManifestBinding extends FluxPreviewManifestBinding {
  readonly authorityDigest: string;
  readonly previewDigest: string;
}

interface RuntimeOpenPreflightBinding {
  readonly receipt: FluxOpenPreflightReceipt;
  readonly preparationDigest: string;
  readonly prepared: PreparedBinding;
  readonly suite: FluxPcbEditorSuiteHostBinding;
  readonly runBindingIdentity: FluxCanonicalIdentityDto;
  readonly ipcSocket: KicadMcpInspectionIpcSocketBinding;
  readonly freshNetClassPreparationEvidence?: FreshNetClassPreparationEvidence;
  readonly freshProjectOpenPreparedSourceAuthority?: FreshProjectOpenPreparedSourceAuthority;
}

interface RuntimeOpenedIpcBinding {
  readonly runBindingIdentity: FluxCanonicalIdentityDto;
  readonly ipcSocket: KicadMcpInspectionIpcSocketBinding;
  readonly writeSessionAuthority?: KicadMcpBoundSessionAuthority;
}

interface RuntimeInspectorOperation {
  readonly authorityDigest: string;
  readonly result: Promise<FluxInspectorSnapshot>;
}

interface RuntimeFreshClearanceEvidencePort {
  readonly port: NonNullable<PcbAgentCliDependencies["freshDesignClearanceEvidencePort"]>;
  readonly kicad: KicadExecutableIdentity;
  readonly materialization: () => FreshNetClassMaterialization | undefined;
  readonly semanticAuthority: () => FreshNetClassSemanticAuthority | undefined;
  readonly receipt: () => FreshClearanceEvidenceReceipt | undefined;
}

interface RuntimePreparedNetClassAuthority {
  readonly authorityDigest: string;
  readonly evidence: FreshNetClassPreparationEvidence;
  readonly materialization: FreshNetClassMaterialization;
  readonly semanticAuthority: FreshNetClassSemanticAuthority;
  readonly preparedSourceAuthority: FreshProjectOpenPreparedSourceAuthority;
}

/** Exact, production-profile-bound KiCad MCP runtime with separate read/write authorities. */
export type FluxKicadMcpRuntime = KicadMcpRuntimeBridge;

interface FluxRuntimeBaseDependencies {
  readonly runCli?: typeof runPcbAgentCli;
  readonly kicadToolchain: FluxKicadToolchainBinding;
  /** Test seam; production executes only the pinned non-GUI kicad-cli. */
  readonly runKicadCliIdentityProbe?: BoundedProcessRunner;
  /** Test seam; production awaits the native child spawn/error boundary. */
  readonly launchPcbEditor?: FluxPcbEditorLauncher;
  readonly isPcbEditorProcessAlive?: (pid: number) => boolean;
  readonly createAdapter?: typeof KicadCliAdapter.create;
  readonly kicadMcpRuntime: FluxKicadMcpRuntime;
  readonly currentHarnessPolicy?: () => Readonly<{ readonly harnessRuleIdentity: string; readonly mutationAllowlist: readonly string[] }>;
  readonly checkpointOpen?: FluxRuntimeCheckpointNormalizer;
  /** Deterministic test seam; production uses the closed host clearance implementation. */
  readonly createFreshDesignClearanceEvidencePort?: (
    kicad: KicadExecutableIdentity,
  ) => NonNullable<PcbAgentCliDependencies["freshDesignClearanceEvidencePort"]>;
  readonly compilationBundleStore?: FluxCompilationBundleStore;
  readonly compilationBundleDependencies?: PcbDesignCompilationBundleDependencies;
  readonly providerModel?: FluxProviderModel;
}

/** Interpreter-enabled composition must supply the exact active provider profile. */
export type FluxRuntimeDependencies =
  | (FluxRuntimeBaseDependencies & Readonly<{ readonly contractInterpreter?: undefined; readonly providerProfile?: undefined }>)
  | (FluxRuntimeBaseDependencies & Readonly<{ readonly contractInterpreter: FluxCompilationInterpreterPort; readonly providerProfile: PcbProviderProfileBinding }>);

export interface FluxRuntime {
  readonly routes: FluxRoutesOptions;
  readonly manager: FluxRunManager;
}

const requiredPath = (environment: NodeJS.ProcessEnv, key: "EVLEDA_FLUX_SOURCE_ROOT" | "EVLEDA_FLUX_WORKSPACE_ROOT"): string => {
  const value = environment[key]?.trim();
  if (!value) throw new Error(`${key} is required to enable the local Flux workspace.`);
  return path.resolve(value);
};

const ordinaryDirectory = async (candidate: string, label: string, create = false): Promise<string> => {
  if (create) await mkdir(candidate, { recursive: true });
  const metadata = await lstat(candidate);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} must be an ordinary directory.`);
  const canonical = await realpath(candidate);
  if (canonical.toLocaleLowerCase("en-US") !== path.resolve(candidate).toLocaleLowerCase("en-US")) throw new Error(`${label} must not resolve through a link.`);
  return canonical;
};

const nativeFiles = async (root: string): Promise<readonly string[]> => {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Flux source projects may not contain symbolic links.");
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory() && entry.name !== ".git" && entry.name !== "node_modules") pending.push(candidate);
      else if (entry.isFile() && NATIVE_FILE.test(entry.name)) files.push(candidate);
    }
  }
  return files.sort((left, right) => left.localeCompare(right, "en-US"));
};

const fingerprint = async (root: string): Promise<string> => {
  const hash = createHash("sha256");
  for (const file of await nativeFiles(root)) {
    hash.update(path.relative(root, file).replaceAll(path.sep, "/"));
    hash.update(await readFile(file));
  }
  return hash.digest("hex");
};

const hasProject = async (root: string): Promise<boolean> => (await readdir(root, { withFileTypes: true })).some((entry) => entry.isFile() && KEY_FILE.test(entry.name));
const within = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

const sameRuntimePath = (left: string, right: string): boolean => process.platform === "win32"
  ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
  : left === right;
const previewAuthorityTails = new Map<string, Promise<void>>();
const withPreviewAuthorityLease = async <Result>(directory: string, operation: () => Promise<Result>): Promise<Result> => {
  const key = process.platform === "win32" ? path.resolve(directory).toLocaleLowerCase("en-US") : path.resolve(directory);
  const previous = previewAuthorityTails.get(key) ?? Promise.resolve();
  const scheduled = previous.then(operation, operation);
  const tail = scheduled.then(() => undefined, () => undefined);
  previewAuthorityTails.set(key, tail);
  try {
    return await scheduled;
  } finally {
    if (previewAuthorityTails.get(key) === tail) previewAuthorityTails.delete(key);
  }
};
const sameRuntimeObject = (left: RuntimeFsBinding, right: RuntimeFsBinding): boolean =>
  left.kind === right.kind && left.device === right.device && left.inode === right.inode && left.mode === right.mode &&
  (left.kind === "directory" || left.linkCount === right.linkCount) &&
  left.createdNs === right.createdNs && sameRuntimePath(left.path, right.path);

const bindRuntimeDirectory = async (candidate: string, label: string): Promise<RuntimeFsBinding> => {
  const lexical = path.resolve(candidate); const metadata = await lstat(lexical, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new FluxError("PATH_POLICY", `${label} must be an ordinary non-link directory`);
  const physical = await realpath(lexical);
  if (!sameRuntimePath(physical, lexical)) throw new FluxError("PATH_POLICY", `${label} must not resolve through a junction, link, reparse point, or alias`);
  return Object.freeze({ kind: "directory" as const, path: lexical, device: metadata.dev, inode: metadata.ino, mode: metadata.mode, linkCount: metadata.nlink, createdNs: metadata.birthtimeNs });
};

const bindRuntimeFile = async (candidate: string, parent: RuntimeFsBinding, label: string): Promise<RuntimeFsBinding> => {
  const lexical = path.resolve(candidate);
  if (!within(parent.path, lexical) || !sameRuntimePath(path.dirname(lexical), parent.path)) throw new FluxError("PATH_POLICY", `${label} escapes its bound project directory`);
  const metadata = await lstat(lexical, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) throw new FluxError("PATH_POLICY", `${label} must be an ordinary non-link single-link file`);
  const physical = await realpath(lexical);
  if (!sameRuntimePath(physical, lexical) || !within(parent.path, physical)) throw new FluxError("PATH_POLICY", `${label} resolves outside its bound project directory`);
  return Object.freeze({ kind: "file" as const, path: lexical, device: metadata.dev, inode: metadata.ino, mode: metadata.mode, linkCount: metadata.nlink, createdNs: metadata.birthtimeNs });
};

const assertRuntimeBinding = async (expected: RuntimeFsBinding, kind: "directory" | "file", parent: RuntimeFsBinding | undefined, label: string): Promise<void> => {
  const current = kind === "directory" ? await bindRuntimeDirectory(expected.path, label) : await bindRuntimeFile(expected.path, parent!, label);
  if (!sameRuntimeObject(expected, current)) throw new FluxError("PATH_POLICY", `${label} was replaced after Flux bound it`);
};

const runtimeFileBindingFromHandle = (candidate: string, metadata: BigIntStats): RuntimeFsBinding => Object.freeze({
  kind: "file" as const,
  path: path.resolve(candidate),
  device: metadata.dev,
  inode: metadata.ino,
  mode: metadata.mode,
  linkCount: metadata.nlink,
  createdNs: metadata.birthtimeNs,
});

const contentIdentityForBoundFile = async (
  expected: RuntimeFsBinding,
  parent: RuntimeFsBinding,
  label: string,
): Promise<Readonly<{ readonly algorithm: "sha256"; readonly digest: string; readonly size: number }>> => {
  await assertRuntimeBinding(parent, "directory", undefined, `${label} parent`);
  await assertRuntimeBinding(expected, "file", parent, label);
  const handle = await open(expected.path, "r");
  let before: RuntimeFsBinding;
  let after: RuntimeFsBinding;
  let bytes: Buffer;
  try {
    before = runtimeFileBindingFromHandle(expected.path, await handle.stat({ bigint: true }));
    if (!sameRuntimeObject(expected, before)) throw new FluxError("PATH_POLICY", `${label} changed before its descriptor-bound read`);
    bytes = await handle.readFile();
    after = runtimeFileBindingFromHandle(expected.path, await handle.stat({ bigint: true }));
  } finally {
    await handle.close();
  }
  if (!sameRuntimeObject(before, after) || bytes.byteLength > 512 * 1024 * 1024) throw new FluxError("PATH_POLICY", `${label} changed during its descriptor-bound read`);
  await assertRuntimeBinding(expected, "file", parent, label);
  return Object.freeze({ algorithm: "sha256", digest: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength });
};

const ensureRuntimeChildDirectory = async (parent: RuntimeFsBinding, name: string, label: string): Promise<RuntimeFsBinding> => {
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(name) && !/^[0-9a-f]{64}$/u.test(name)) throw new FluxError("PATH_POLICY", `${label} has an unsafe path segment`);
  await assertRuntimeBinding(parent, "directory", undefined, `${label} parent`);
  const candidate = path.join(parent.path, name);
  if (!within(parent.path, candidate) || !sameRuntimePath(path.dirname(candidate), parent.path)) throw new FluxError("PATH_POLICY", `${label} escapes its bound parent`);
  try { await mkdir(candidate); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const child = await bindRuntimeDirectory(candidate, label);
  await assertRuntimeBinding(parent, "directory", undefined, `${label} parent`);
  if (!within(parent.path, child.path)) throw new FluxError("PATH_POLICY", `${label} is outside its bound parent`);
  return child;
};

const catalog = async (sourceRoot: string): Promise<readonly SourceBinding[]> => {
  const candidates = (await hasProject(sourceRoot))
    ? [sourceRoot]
    : (await readdir(sourceRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => path.join(sourceRoot, entry.name));
  const copies: SourceBinding[] = [];
  for (const candidate of candidates) {
    if (!(await hasProject(candidate))) continue;
    const digest = await fingerprint(candidate);
    const keyDigest = createHash("sha256").update(`copy\0${candidate.toLocaleLowerCase("en-US")}`).digest("hex");
    copies.push({ key: `source_${keyDigest.slice(0, 16)}`, label: path.basename(candidate), sourceRoot: candidate, fingerprint: digest, mode: "copy" });
  }
  const newDigest = fluxDigest({ kind: "empty-kicad-10-project", formatVersion: 1 });
  const newKeyDigest = createHash("sha256").update(`new\0${sourceRoot.toLocaleLowerCase("en-US")}`).digest("hex");
  return Object.freeze([
    { key: `source_${newKeyDigest.slice(0, 16)}`, label: "New KiCad project", sourceRoot, fingerprint: newDigest, mode: "new" },
    ...copies,
  ]);
};

const exactlyOne = async (root: string, extension: ".kicad_sch" | ".kicad_pcb"): Promise<string> => {
  const matches = (await nativeFiles(root)).filter((file) => file.toLocaleLowerCase("en-US").endsWith(extension));
  if (matches.length !== 1) throw new Error(`Prepared Flux project must contain exactly one ${extension} file.`);
  return matches[0]!;
};

const kicadCliPath = (toolchain: FluxKicadToolchainBinding): string => toolchain.kicadCli.path;
const cliOptions = (
  request: FluxPrepareRequest | FluxExecuteRequest,
  binding: SourceBinding,
  outputRoot: string,
  mode: "prepare" | "resume",
  environment: NodeJS.ProcessEnv,
  toolchain: FluxKicadToolchainBinding,
): PcbAgentCliOptions => {
  const common = {
    provider: request.providerModel.provider as PcbAgentCliOptions["provider"],
    model: request.providerModel.model,
    outputDir: outputRoot,
    iterations: request.iterationCap,
    openAiServiceTier: request.providerModel.tier === "priority" ? "fast" as const : "standard" as const,
    mode,
    kicadCliPath: kicadCliPath(toolchain),
  };
  if (request.workflowKind === "generic") {
    if (binding.mode !== "new") throw new FluxError("INVALID_ARGUMENT", "Generic bundle execution requires the explicit fresh-project source");
    return {
      ...common,
      workflowKind: "generic",
      newProjectName: freshName(request.runId),
      compilationBundle: request.compilationBundle,
      compilationBundleRef: request.compilationBundleRef
    };
  }
  return { ...common, workflowKind: "led_compatibility_fixture", prompt: request.prompt, newProjectName: freshName(request.runId) };
};

const freshName = (runId: string): string => `flux-${runId.replace(/[^a-z0-9]/giu, "").toLowerCase().slice(-32)}`;
const CONFIDENTIAL_TEXT = /(?:\b(?:bearer|basic)\s+[A-Za-z0-9._~+\/-]{8,}=*|-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----|\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}|\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{16,}|\bgithub_pat_[A-Za-z0-9_]{16,}|\bAKIA[A-Z0-9]{16}|\bxox(?:a|b|p|r|s)-[A-Za-z0-9-]{8,}|\b(?:api[_ -]?(?:key|token)|access[_ -]?token|auth(?:orization)?[_ -]?token|password|passwd|client[_ -]?secret|private[_ -]?key|secret|cookie|set-cookie)\s*(?:=|:)\s*(?:"[^"\r\n]{4,}"|'[^'\r\n]{4,}'|[^\s,;]{4,}))/iu;
const KICAD_CLI_HOST_ENVIRONMENT_KEYS = Object.freeze([
  "SystemRoot", "WINDIR", "TEMP", "TMP", "KICAD_CONFIG_HOME",
  "KICAD10_SYMBOL_DIR", "KICAD10_FOOTPRINT_DIR", "KICAD10_3DMODEL_DIR",
  "KICAD10_TEMPLATE_DIR", "KICAD10_USER_TEMPLATE_DIR",
] as const);
const minimalKicadCliEnvironment = (environment: NodeJS.ProcessEnv): Readonly<Record<string, string>> => {
  const selected: Record<string, string> = {};
  for (const key of KICAD_CLI_HOST_ENVIRONMENT_KEYS) {
    const matches = Object.entries(environment).filter(([candidate]) => process.platform === "win32"
      ? candidate.toLocaleLowerCase("en-US") === key.toLocaleLowerCase("en-US")
      : candidate === key);
    if (matches.length > 1) throw new FluxError("PATH_POLICY", "KiCad CLI environment contains an ambiguous key.");
    const value = matches[0]?.[1];
    if (value === undefined || value === "") continue;
    if (/[\0\r\n]/u.test(value)) throw new FluxError("PATH_POLICY", "KiCad CLI environment contains controls.");
    selected[key] = value;
  }
  return Object.freeze(selected);
};
const safeText = (value: string): string => CONFIDENTIAL_TEXT.test(value)
  ? "Sensitive diagnostic text was withheld."
  : value.replace(/(?:[A-Za-z]:[\\/]|\\\\|file:)[^\s"'<>]*/giu, "[redacted path]").replace(/(^|\s)\/(?!\/)[^\s"'<>]*/gu, "$1[redacted path]").slice(0, 4_000);
const reportSummary = (status: PcbAgentCliReport["status"]): string => status === "completed"
  ? "PCB agent candidate execution completed."
  : status === "needs_review" ? "PCB agent candidate execution requires review."
    : status === "blocked" ? "PCB agent candidate execution reported a blocker."
      : "PCB agent candidate execution failed.";
const clearanceKicadIdentity = (identity: KicadExecutableIdentity) => Object.freeze({
  kind: identity.kind,
  version: identity.version,
  commit: identity.commit,
  sha256: identity.sha256,
  sizeBytes: identity.sizeBytes,
  capabilityHelpSha256: identity.capabilityHelpSha256,
  confirmedCapabilities: Object.freeze([...identity.confirmedCapabilities]),
});
/** The parsed report must match the executor return, whose native receipt retains host provenance. */
export const verifyFluxSchematicRenderReceiptForReport = (
  persistedReport: PcbAgentCliReport,
  executionReport: PcbAgentCliReport,
  expectedPlanIdentity: FluxCanonicalIdentityDto,
  executable: Readonly<{ sha256: string; sizeBytes: number }>,
): ReturnType<typeof verifyHostSchematicRenderClearanceEvidence> => {
  if (canonicalJson(persistedReport) !== canonicalJson(executionReport) || expectedPlanIdentity.schemaVersion !== "evleda.pcb-acceptance-plan.v2") throw new FluxError("STORE_CORRUPT", "Native schematic receipt report differs from the current executor and plan.");
  const validation = executionReport.harness?.validation.sourceBinding;
  if (validation?.unchanged !== true || validation.after.projectSettings === undefined || canonicalJson(validation.before) !== canonicalJson(validation.after)) throw new FluxError("STORE_CORRUPT", "Generic report lacks an unchanged current native-validation source binding.");
  const { identity: validationIdentity, ...validationPayload } = validation;
  if (canonicalJson(validationIdentity) !== canonicalJson(canonicalIdentity(validationPayload, "evleda.pcb-harness-validation-source-binding.v1"))) throw new FluxError("STORE_CORRUPT", "Generic native-validation identity is inconsistent.");
  const render = verifyHostSchematicRenderClearanceEvidence(executionReport.freshSchematicRenderClearanceEvidence, {
    sources: { schematic: validation.after.schematic, pcb: validation.after.pcb, projectSettings: validation.after.projectSettings }, executable, validationSourceBindingIdentity: validation.identity,
  });
  const acceptance = persistedReport.freshAcceptance;
  if (acceptance === undefined || !("acceptancePlanIdentity" in acceptance) || acceptance.schemaVersion !== "evleda.fresh-design-acceptance.v2" || canonicalJson(acceptance.acceptancePlanIdentity) !== canonicalJson(expectedPlanIdentity)) throw new FluxError("STORE_CORRUPT", "Native schematic receipt is not bound to current acceptance.");
  const ink = acceptance.requirements.filter((entry) => entry.id === "schematic-render-clearance");
  if (ink.length !== 1 || ink[0]?.status !== render.status || acceptance.sourceHashes.schematicSha256 !== render.sources.schematic.digest || acceptance.sourceHashes.pcbSha256 !== render.sources.pcb.digest) throw new FluxError("STORE_CORRUPT", "Native schematic receipt differs from its current acceptance row or source hashes.");
  return render;
};

const projectAcceptance = (value: PcbAgentCliReport["freshAcceptance"]): FluxFreshAcceptanceProjection | undefined => value === undefined ? undefined : {
  passed: value.passed,
  requirements: value.requirements.map((entry) => ({ id: entry.id, status: entry.status, detail: safeText(entry.detail) })),
  missing: value.missing.map(safeText), sourceHashes: { ...value.sourceHashes }, evidenceLimitations: value.evidenceLimitations.map(safeText),
};
const projectReport = (
  report: PcbAgentCliReport,
  reportSha256: string,
  executionBridgeIdentity: FluxCanonicalIdentityDto,
  writeSessionAuthorityIdentity: FluxCanonicalIdentityDto,
  writeSessionReceiptIdentity: FluxCanonicalIdentityDto,
  executionInspectionSessionReceiptIdentity: FluxCanonicalIdentityDto,
  freshClearanceEvidenceBinding?: ReturnType<typeof createFluxFreshClearanceEvidenceBinding>,
): Omit<FluxReportMetadata, "reportId" | "createdAt"> => ({
  title: "PCB agent candidate report", digest: reportSha256, reportSha256, mediaType: "application/json", disposition: report.status, summary: reportSummary(report.status),
  executionBridgeIdentity,
  writeSessionAuthorityIdentity,
  writeSessionReceiptIdentity,
  executionInspectionSessionReceiptIdentity,
  ...(freshClearanceEvidenceBinding === undefined ? {} : { freshClearanceEvidenceBinding }),
  ...(projectAcceptance(report.freshAcceptance) === undefined ? {} : { freshAcceptance: projectAcceptance(report.freshAcceptance)! }),
  ...(report.freshBoardSaveAudits === undefined ? {} : { freshBoardSaveAudits: report.freshBoardSaveAudits.map((audit) => ({ before: { ...audit.before }, live: { ...audit.live }, after: { ...audit.after }, directorySync: audit.directorySync })) }),
});

const writeSessionReceiptForReport = (
  report: PcbAgentCliReport,
  expectedAuthorityIdentity: FluxCanonicalIdentityDto,
  expectedSocketIdentity: FluxCanonicalIdentityDto,
): FluxCanonicalIdentityDto => {
  const receipt = validateCanonicalIdentity(report.writeSessionReceiptIdentity, "PCB-agent write-session receipt identity");
  if (receipt.schemaVersion !== KICAD_MCP_SESSION_RECEIPT_SCHEMA_VERSION) {
    throw new FluxError("STORE_CORRUPT", "PCB-agent report has an invalid write-session receipt schema.");
  }
  const sidecar = report.sidecar as Readonly<{
    readonly identity?: Readonly<{
      readonly sessionReceiptIdentity?: unknown;
      readonly launch?: Readonly<{ readonly sessionAuthorityIdentity?: unknown; readonly ipcSocketIdentity?: unknown }>;
    }> | null;
  }> | undefined;
  if (sidecar?.identity === undefined || sidecar.identity === null
      || sidecar.identity.sessionReceiptIdentity === undefined
      || sidecar.identity.launch?.sessionAuthorityIdentity === undefined
      || sidecar.identity.launch.ipcSocketIdentity === undefined
      || canonicalJson(sidecar.identity.sessionReceiptIdentity) !== canonicalJson(receipt)
      || canonicalJson(sidecar.identity.launch.sessionAuthorityIdentity) !== canonicalJson(expectedAuthorityIdentity)
      || canonicalJson(sidecar.identity.launch.ipcSocketIdentity) !== canonicalJson(expectedSocketIdentity)) {
    throw new FluxError("STORE_CORRUPT", "PCB-agent report does not match its approved write-session and IPC socket authority.");
  }
  return receipt;
};

const freshClearanceEvidenceBindingForReport = (
  report: PcbAgentCliReport,
  captured: RuntimeFreshClearanceEvidencePort,
  preparedNetClasses: RuntimePreparedNetClassAuthority,
): ReturnType<typeof createFluxFreshClearanceEvidenceBinding> | undefined => {
  const materialization = preparedNetClasses.materialization;
  const semanticAuthority = captured.semanticAuthority();
  const receipt = captured.receipt();
  const sameOptional = (left: unknown, right: unknown): boolean => left === undefined
    ? right === undefined
    : right !== undefined && canonicalJson(left) === canonicalJson(right);
  if (!sameOptional(report.freshNetClassMaterialization, materialization)
      || !sameOptional(report.freshNetClassSemanticAuthority, semanticAuthority)
      || !sameOptional(report.freshClearanceEvidenceReceipt, receipt)) {
    throw new FluxError("STORE_CORRUPT", "PCB-agent clearance evidence does not match the trusted host port results.");
  }
  if (report.status === "completed" && (semanticAuthority === undefined || receipt === undefined)) {
    throw new FluxError("STORE_CORRUPT", "Completed generic execution lacks verified clearance materialization and receipt evidence.");
  }
  if (receipt === undefined) return undefined;
  if (semanticAuthority === undefined) throw new FluxError("STORE_CORRUPT", "Fresh clearance receipt lacks its exact semantic authority.");
  let semanticLinkedReceipt: FreshClearanceEvidenceReceipt;
  try { semanticLinkedReceipt = verifyFreshClearanceEvidenceReceiptAgainstSemanticAuthority(receipt, preparedNetClasses.semanticAuthority); }
  catch { throw new FluxError("STORE_CORRUPT", "Fresh clearance receipt does not match the approved full semantic authority."); }
  if (canonicalJson(semanticLinkedReceipt) !== canonicalJson(receipt)) throw new FluxError("STORE_CORRUPT", "Fresh clearance semantic linkage changed the terminal receipt.");
  const materializationIdentity = validateCanonicalIdentity(materialization.identity, "Fresh net-class materialization identity");
  const receiptIdentity = validateCanonicalIdentity(receipt.identity, "Fresh clearance evidence receipt identity");
  if (materializationIdentity.schemaVersion !== FRESH_NETCLASS_MATERIALIZATION_SCHEMA_VERSION
      || receiptIdentity.schemaVersion !== FRESH_CLEARANCE_EVIDENCE_RECEIPT_SCHEMA_VERSION
      || canonicalJson(semanticAuthority.identity) !== canonicalJson(preparedNetClasses.evidence.semanticAuthorityIdentity)
      || canonicalJson(materialization.kicad) !== canonicalJson(receipt.kicad)
      || canonicalJson(receipt.kicad) !== canonicalJson(clearanceKicadIdentity(captured.kicad))) {
    throw new FluxError("STORE_CORRUPT", "Fresh clearance evidence identities do not share the pinned KiCad CLI authority.");
  }
  return createFluxFreshClearanceEvidenceBinding({
    kicad: receipt.kicad,
    materializationIdentity,
    receiptIdentity,
    semanticAuthorityIdentity: preparedNetClasses.evidence.semanticAuthorityIdentity,
  });
};

export async function createFluxRuntime(environment: NodeJS.ProcessEnv, dependencies: FluxRuntimeDependencies): Promise<FluxRuntime> {
  const sourceRoot = await ordinaryDirectory(requiredPath(environment, "EVLEDA_FLUX_SOURCE_ROOT"), "EVLEDA_FLUX_SOURCE_ROOT");
  const workspaceRoot = await ordinaryDirectory(requiredPath(environment, "EVLEDA_FLUX_WORKSPACE_ROOT"), "EVLEDA_FLUX_WORKSPACE_ROOT", true);
  const workspaceIdentity = await bindRuntimeDirectory(workspaceRoot, "Flux workspace root");
  const sources = await catalog(sourceRoot);
  const byKey = new Map(sources.map((entry) => [entry.key, entry]));
  const activeKicadToolchain = parseFluxKicadToolchainBinding(dependencies.kicadToolchain);
  const kicadMcpRuntime = dependencies.kicadMcpRuntime;
  validateCanonicalIdentity(kicadMcpRuntime.identity, "Flux KiCad MCP runtime identity");
  const activeInspectionBridgeIdentity = validateCanonicalIdentity(kicadMcpRuntime.inspectionBridgeIdentity, "Flux inspection bridge identity");
  const activeExecutionBridgeIdentity = validateCanonicalIdentity(kicadMcpRuntime.executionBridgeIdentity, "Flux execution bridge identity");
  for (const [key, expected] of [["EVLEDA_KICAD_CLI", activeKicadToolchain?.kicadCli.path], ["EVLEDA_PCBNEW", activeKicadToolchain?.pcbnew.path]] as const) {
    const configured = environment[key]?.trim();
    if (configured !== undefined && (expected === undefined || !sameRuntimePath(path.resolve(configured), expected))) {
      throw new FluxError("PATH_POLICY", `${key} does not exactly match the server-owned KiCad toolchain binding`);
    }
  }
  const prepared = new Map<string, PreparedBinding>();
  const preparedNetClasses = new Map<string, RuntimePreparedNetClassAuthority>();
  const manifests = new Map<string, RuntimePreviewManifestBinding>();
  const openPreflights = new Map<string, RuntimeOpenPreflightBinding>();
  let inspectorSnapshot: FluxInspectorSnapshot | undefined;
  let openedRunId: string | undefined;
  let openedAuthorityDigest: string | undefined;
  let openedProcessId: number | undefined;
  let openedIpcBinding: RuntimeOpenedIpcBinding | undefined;
  const editorExitedSockets = new WeakSet<KicadMcpInspectionIpcSocketBinding>();
  const socketReleasePromises = new WeakMap<KicadMcpInspectionIpcSocketBinding, Promise<void>>();
  const inspectorOperations = new Map<string, Map<string, RuntimeInspectorOperation>>();
  let ipcReleaseUncertainty: unknown;
  const runCli = dependencies.runCli ?? runPcbAgentCli;
  const checkpointOpen: FluxRuntimeCheckpointNormalizer = dependencies.checkpointOpen ?? (async ({ newProjectName, ...options }) =>
    await checkpointFreshProjectOpenNormalization({ ...options, name: newProjectName }));
  const createAdapter = dependencies.createAdapter ?? KicadCliAdapter.create;
  const checkpointProcessRunner = (context: FluxCheckpointOperationContext): BoundedProcessRunner => {
    const base = dependencies.runKicadCliIdentityProbe ?? runBoundedProcess;
    return async (options) => await checkpointStep(context, async () => {
      const remainingMs = context.deadlineAtMs - Date.now();
      assertCheckpointOperationActive(context);
      const signal = options.signal === undefined ? context.signal : AbortSignal.any([options.signal, context.signal]);
      return await base({ ...options, timeoutMs: Math.max(1, Math.min(options.timeoutMs, Math.ceil(remainingMs))), signal });
    });
  };
  const createPinnedKicadCliAdapter = async (options: KicadCliAdapterOptions): Promise<KicadCliAdapter> => {
    const adapter = await createAdapter({
      workspaceRoot: options.workspaceRoot,
      projectRoot: options.projectRoot,
      ...(options.outputRoot === undefined ? {} : { outputRoot: options.outputRoot }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
      ...(options.maxReportBytes === undefined ? {} : { maxReportBytes: options.maxReportBytes }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      executablePath: activeKicadToolchain.kicadCli.path,
      expectedExecutableIdentity: {
        sha256: activeKicadToolchain.kicadCli.contentIdentity.digest,
        sizeBytes: activeKicadToolchain.kicadCli.contentIdentity.size,
      },
      environment: minimalKicadCliEnvironment(environment),
      ...(dependencies.runKicadCliIdentityProbe === undefined ? {} : { runner: dependencies.runKicadCliIdentityProbe }),
    });
    const identity = adapter.identity;
    if (!sameRuntimePath(identity.path, activeKicadToolchain.kicadCli.path)
        || identity.sha256 !== activeKicadToolchain.kicadCli.contentIdentity.digest
        || identity.sizeBytes !== activeKicadToolchain.kicadCli.contentIdentity.size
        || identity.version !== activeKicadToolchain.kicadCli.operationalVersion
        || identity.commit !== activeKicadToolchain.kicadCli.operationalCommit) {
      throw new FluxError("APPROVAL_MISMATCH", "KiCad CLI adapter does not match the active server-owned toolchain authority.");
    }
    return adapter;
  };
  const currentHarnessPolicy = dependencies.currentHarnessPolicy ?? (() => ({ harnessRuleIdentity: PCB_AGENT_HARNESS_RULE_IDENTITY, mutationAllowlist: PCB_AGENT_MUTATION_ALLOWLIST }));
  const isPcbEditorProcessAlive = dependencies.isPcbEditorProcessAlive ?? ((pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  });
  const releaseExitedIpcSocket = async (ipcBinding: RuntimeOpenedIpcBinding): Promise<void> => {
    if (!editorExitedSockets.has(ipcBinding.ipcSocket)) return;
    const existing = socketReleasePromises.get(ipcBinding.ipcSocket);
    if (existing !== undefined) return await existing;
    let deferredForActiveSession = false;
    const releasing = (async () => {
      const outcome = await kicadMcpRuntime.releaseIpcSocket(ipcBinding.ipcSocket, ipcBinding.runBindingIdentity);
      if (outcome === "deferred_active") { deferredForActiveSession = true; return; }
      if (openedIpcBinding?.ipcSocket === ipcBinding.ipcSocket) {
        openedRunId = undefined;
        openedAuthorityDigest = undefined;
        openedProcessId = undefined;
        openedIpcBinding = undefined;
      }
    })();
    socketReleasePromises.set(ipcBinding.ipcSocket, releasing);
    try { await releasing; }
    finally {
      if (deferredForActiveSession && socketReleasePromises.get(ipcBinding.ipcSocket) === releasing) {
        socketReleasePromises.delete(ipcBinding.ipcSocket);
      }
    }
  };
  const assertIpcReleaseCertain = (): void => {
    if (ipcReleaseUncertainty !== undefined) {
      throw new FluxError("OPERATION_UNCERTAIN", "A prior KiCad IPC socket release could not be confirmed; the runtime is blocked.");
    }
  };
  const cancelStoredOpenPreflight = async (receipt: FluxOpenPreflightReceipt): Promise<void> => {
    const binding = openPreflights.get(receipt.identity.digest);
    if (binding === undefined) return;
    if (canonicalJson(binding.receipt) !== canonicalJson(receipt) || openedIpcBinding?.ipcSocket === binding.ipcSocket) {
      throw new FluxError("APPROVAL_MISMATCH", "Open preflight cancellation does not match one unlaunched IPC socket allocation.");
    }
    try {
      const outcome = await kicadMcpRuntime.releaseIpcSocket(binding.ipcSocket, binding.runBindingIdentity);
      if (outcome !== "released") throw new Error("preflight socket unexpectedly active");
      openPreflights.delete(receipt.identity.digest);
    } catch {
      throw new FluxError("OPERATION_UNCERTAIN", "Open preflight IPC socket cancellation could not be confirmed; the allocation was retained.");
    }
  };
  const activeProviderProfile = dependencies.providerProfile === undefined ? undefined : parsePcbProviderProfileBinding(dependencies.providerProfile);
  const providerModel = Object.freeze(dependencies.providerModel ?? (activeProviderProfile === undefined
    ? { provider: "server-managed", model: "generic-contract", tier: "standard" }
    : { provider: activeProviderProfile.provider, model: activeProviderProfile.model, tier: activeProviderProfile.tier }));
  if (activeProviderProfile !== undefined && (providerModel.provider !== activeProviderProfile.provider || providerModel.model !== activeProviderProfile.model || providerModel.tier !== activeProviderProfile.tier)) {
    throw new FluxError("INVALID_ARGUMENT", "Flux provider model policy does not match its canonical provider profile");
  }
  const policy = (): FluxRuntimePolicyDto => {
    const harness = currentHarnessPolicy();
    return Object.freeze({ providerModel, iterationCap: FLUX_ITERATION_CAP_POLICY, harnessRuleIdentity: harness.harnessRuleIdentity,
      mutationAllowlist: canonicalPolicyMutationAllowlist(harness.mutationAllowlist), freshProjectNamePattern: FRESH_NAME_PATTERN,
      checkpointOpenRequiredForFresh: true, freshAcceptanceProfileIdentity: FLUX_GENERIC_ACCEPTANCE_PROFILE_IDENTITY,
      freshPersistenceProfileIdentity: FLUX_FRESH_PERSISTENCE_PROFILE_IDENTITY });
  };
  const compilationBundleStore = dependencies.compilationBundleStore ?? (dependencies.compilationBundleDependencies === undefined
    ? undefined
    : new FileFluxCompilationBundleStore(workspaceRoot, dependencies.compilationBundleDependencies));
  let manager!: FluxRunManager;

  const authorityDigestFor = (request: FluxPrepareRequest | FluxExecuteRequest): string =>
    request.workflowKind === "generic" ? request.compilationBundleRef.contentIdentity.digest : request.contractIdentity.digest;

  const openRunBindingIdentityFor = (
    projectId: string,
    preparation: FluxPrepareRequest,
    preparationDigest: string,
    binding: PreparedBinding,
  ): FluxCanonicalIdentityDto => canonicalIdentity({
    schemaVersion: FLUX_OPEN_RUN_BINDING_SCHEMA_VERSION,
    projectId,
    runId: preparation.runId,
    preparationDigest,
    preparedAuthorityDigest: binding.authorityDigest,
  }, FLUX_OPEN_RUN_BINDING_SCHEMA_VERSION);

  const previewAuthorityDescriptor = (request: FluxPrepareRequest): Readonly<{
    readonly directoryName: string;
    readonly marker: Readonly<Record<string, unknown>>;
    readonly markerBytes: Buffer;
  }> => {
    const payload = {
      schemaVersion: "evleda.flux-preview-authority.v1" as const,
      runId: request.runId,
      workflowKind: request.workflowKind,
      sourceKey: request.sourceKey,
      sourceFingerprint: request.sourceFingerprint,
      authorityDigest: authorityDigestFor(request),
      contractIdentity: request.contractIdentity,
      compilationBundleIdentity: request.workflowKind === "generic" ? request.compilationBundle.identity : null,
      providerProfileIdentity: request.workflowKind === "generic" ? request.providerProfile.identity : null,
    };
    const marker = Object.freeze({ ...payload, identity: canonicalIdentity(payload, payload.schemaVersion) });
    return Object.freeze({
      directoryName: `authority-${marker.identity.digest.slice(0, 24)}`,
      marker,
      markerBytes: Buffer.from(`${canonicalJson(marker)}\n`, "utf8"),
    });
  };

  const bindPreviewAuthorityRoot = async (
    descriptor: ReturnType<typeof previewAuthorityDescriptor>,
  ): Promise<Readonly<{ readonly storeRoot: RuntimeFsBinding; readonly authorityRoot: RuntimeFsBinding; readonly marker: RuntimeFsBinding }>> => {
    await assertRuntimeBinding(workspaceIdentity, "directory", undefined, "Flux workspace root");
    const previewRoot = await ensureRuntimeChildDirectory(workspaceIdentity, "preview-revisions", "Flux preview store root");
    const authorityRoot = await ensureRuntimeChildDirectory(previewRoot, descriptor.directoryName, "Flux preview authority root");
    const markerPath = path.join(authorityRoot.path, "authority.json");
    try {
      await writeFile(markerPath, descriptor.markerBytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const markerIdentity = await bindRuntimeFile(markerPath, authorityRoot, "Flux preview authority marker");
    const storedMarker = await readFile(markerPath);
    if (!storedMarker.equals(descriptor.markerBytes)) {
      throw new FluxError("PATH_POLICY", "Flux preview authority directory collides with a different full authority identity");
    }
    await assertRuntimeBinding(markerIdentity, "file", authorityRoot, "Flux preview authority marker");
    await assertRuntimeBinding(authorityRoot, "directory", undefined, "Flux preview authority root");
    await assertRuntimeBinding(previewRoot, "directory", undefined, "Flux preview store root");
    await assertRuntimeBinding(workspaceIdentity, "directory", undefined, "Flux workspace root");
    return Object.freeze({ storeRoot: previewRoot, authorityRoot, marker: markerIdentity });
  };

  const assertPreviewAuthorityBinding = async (
    binding: Awaited<ReturnType<typeof bindPreviewAuthorityRoot>>,
    descriptor: ReturnType<typeof previewAuthorityDescriptor>,
  ): Promise<void> => {
    await assertRuntimeBinding(workspaceIdentity, "directory", undefined, "Flux workspace root");
    await assertRuntimeBinding(binding.storeRoot, "directory", undefined, "Flux preview store root");
    await assertRuntimeBinding(binding.authorityRoot, "directory", undefined, "Flux preview authority root");
    await assertRuntimeBinding(binding.marker, "file", binding.authorityRoot, "Flux preview authority marker");
    if (!(await readFile(binding.marker.path)).equals(descriptor.markerBytes)) {
      throw new FluxError("PATH_POLICY", "Flux preview authority marker changed after it was bound");
    }
  };

  const expectedOutputRoot = (request: FluxPrepareRequest | FluxExecuteRequest): string => {
    if (!/^[a-z][a-z0-9_-]{0,127}$/u.test(request.runId)) throw new FluxError("PATH_POLICY", "Flux run identity is unsafe for materialization");
    const authorityDigest = authorityDigestFor(request);
    if (!/^[0-9a-f]{64}$/u.test(authorityDigest)) throw new FluxError("PATH_POLICY", "Flux compilation authority digest is invalid");
    const candidate = path.resolve(workspaceRoot, "runs", request.runId, "compilations", authorityDigest);
    if (!within(workspaceRoot, candidate)) throw new FluxError("PATH_POLICY", "Flux output root escapes its workspace");
    return candidate;
  };

  const ensureOutputRoot = async (request: FluxPrepareRequest | FluxExecuteRequest): Promise<string> => {
    await assertRuntimeBinding(workspaceIdentity, "directory", undefined, "Flux workspace root");
    let current = await ensureRuntimeChildDirectory(workspaceIdentity, "runs", "Flux runs directory");
    current = await ensureRuntimeChildDirectory(current, request.runId, "Flux run directory");
    current = await ensureRuntimeChildDirectory(current, "compilations", "Flux run compilations directory");
    current = await ensureRuntimeChildDirectory(current, authorityDigestFor(request), "Flux compilation output directory");
    const expected = expectedOutputRoot(request);
    if (!sameRuntimePath(current.path, expected) || !within(workspaceRoot, current.path)) throw new FluxError("PATH_POLICY", "Flux output directory does not match its bound workspace path");
    return current.path;
  };

  const createPreparedBinding = async (request: FluxPrepareRequest | FluxExecuteRequest, source: SourceBinding, outputRoot: string, projectRoot: string): Promise<PreparedBinding> => {
    const expected = expectedOutputRoot(request);
    if (!sameRuntimePath(path.resolve(outputRoot), expected) || !within(workspaceRoot, expected)) throw new FluxError("PATH_POLICY", "Prepared output root does not match its compilation authority");
    await assertRuntimeBinding(workspaceIdentity, "directory", undefined, "Flux workspace root");
    const outputIdentity = await bindRuntimeDirectory(expected, "Prepared output root");
    if (!within(workspaceRoot, outputIdentity.path)) throw new FluxError("PATH_POLICY", "Prepared output root escapes the Flux workspace");
    const expectedProjectRoot = path.join(expected, "project");
    if (!sameRuntimePath(path.resolve(projectRoot), expectedProjectRoot)) throw new FluxError("PATH_POLICY", "Prepared project root does not match its fixed output binding");
    const projectIdentity = await bindRuntimeDirectory(expectedProjectRoot, "Prepared project root");
    if (!within(outputIdentity.path, projectIdentity.path) || !sameRuntimePath(path.dirname(projectIdentity.path), outputIdentity.path)) throw new FluxError("PATH_POLICY", "Prepared project root escapes its output root");
    const schematicPath = await exactlyOne(projectIdentity.path, ".kicad_sch");
    const pcbPath = await exactlyOne(projectIdentity.path, ".kicad_pcb");
    const schematicIdentity = await bindRuntimeFile(schematicPath, projectIdentity, "Prepared schematic");
    const pcbIdentity = await bindRuntimeFile(pcbPath, projectIdentity, "Prepared board");
    return Object.freeze({ source, outputRoot: outputIdentity.path, projectRoot: projectIdentity.path, schematicPath, pcbPath,
      authorityDigest: authorityDigestFor(request), outputIdentity, projectIdentity, schematicIdentity, pcbIdentity });
  };

  const assertPreparedBinding = async (binding: PreparedBinding): Promise<void> => {
    await assertRuntimeBinding(workspaceIdentity, "directory", undefined, "Flux workspace root");
    if (!within(workspaceRoot, binding.outputRoot) || !within(binding.outputRoot, binding.projectRoot)) throw new FluxError("PATH_POLICY", "Prepared binding escaped its workspace hierarchy");
    await assertRuntimeBinding(binding.outputIdentity, "directory", undefined, "Prepared output root");
    await assertRuntimeBinding(binding.projectIdentity, "directory", undefined, "Prepared project root");
    await assertRuntimeBinding(binding.schematicIdentity, "file", binding.projectIdentity, "Prepared schematic");
    await assertRuntimeBinding(binding.pcbIdentity, "file", binding.projectIdentity, "Prepared board");
  };

  const refreshPreparedFiles = async (binding: PreparedBinding): Promise<PreparedBinding> => {
    await assertRuntimeBinding(workspaceIdentity, "directory", undefined, "Flux workspace root");
    await assertRuntimeBinding(binding.outputIdentity, "directory", undefined, "Prepared output root");
    await assertRuntimeBinding(binding.projectIdentity, "directory", undefined, "Prepared project root");
    const schematicIdentity = await bindRuntimeFile(binding.schematicPath, binding.projectIdentity, "Prepared schematic");
    const pcbIdentity = await bindRuntimeFile(binding.pcbPath, binding.projectIdentity, "Prepared board");
    return Object.freeze({ ...binding, schematicIdentity, pcbIdentity });
  };

  const bindingFor = async (request: FluxPrepareRequest | FluxExecuteRequest): Promise<PreparedBinding> => {
    const authorityDigest = authorityDigestFor(request);
    const cached = prepared.get(request.runId);
    if (cached !== undefined && cached.authorityDigest === authorityDigest) { await assertPreparedBinding(cached); return cached; }
    const source = byKey.get(request.sourceKey);
    if (source === undefined) throw new FluxError("NOT_FOUND", "Flux source binding is unavailable.");
    const outputRoot = expectedOutputRoot(request);
    const projectRoot = path.join(outputRoot, "project");
    const result = await createPreparedBinding(request, source, outputRoot, projectRoot);
    prepared.set(request.runId, result);
    return result;
  };

  const bindingForRun = async (runId: string): Promise<PreparedBinding> => {
    return bindingFor(await manager.verifiedPreparation(runId));
  };

  const renderPrepared = async (
    runId: string,
    preparation: FluxPrepareRequest,
    binding: PreparedBinding,
    checkpointContext?: FluxCheckpointOperationContext,
    publish = true,
  ): Promise<RuntimePreviewManifestBinding> => {
    const descriptor = previewAuthorityDescriptor(preparation);
    const authorityPath = path.join(workspaceRoot, "preview-revisions", descriptor.directoryName);
    return await withPreviewAuthorityLease(authorityPath, async () => {
      if (checkpointContext !== undefined) assertCheckpointOperationActive(checkpointContext);
      const authority = await optionalCheckpointStep(checkpointContext, async () => await bindPreviewAuthorityRoot(descriptor));
      const adapter = await optionalCheckpointStep(checkpointContext, async () => await createPinnedKicadCliAdapter({
        workspaceRoot: binding.outputRoot,
        projectRoot: binding.projectRoot,
        outputRoot: authority.authorityRoot.path,
        executablePath: kicadCliPath(activeKicadToolchain),
        expectedExecutableIdentity: { sha256: activeKicadToolchain.kicadCli.contentIdentity.digest, sizeBytes: activeKicadToolchain.kicadCli.contentIdentity.size },
        environment: minimalKicadCliEnvironment(environment),
        ...(checkpointContext === undefined
          ? dependencies.runKicadCliIdentityProbe === undefined ? {} : { runner: dependencies.runKicadCliIdentityProbe }
          : { runner: checkpointProcessRunner(checkpointContext), signal: checkpointContext.signal }),
      }));
      await optionalCheckpointStep(checkpointContext, async () => await assertPreviewAuthorityBinding(authority, descriptor));
      if (checkpointContext !== undefined) assertCheckpointOperationActive(checkpointContext);
      const rendered = await optionalCheckpointStep(checkpointContext, async () => await new FluxPreviewRenderer({
        adapter,
        workspaceRoot: binding.outputRoot,
        projectRoot: binding.projectRoot,
        outputRoot: authority.authorityRoot.path,
        revisionRoot: "revisions",
      }).renderForRuntime({ schematicPath: binding.schematicPath, pcbPath: binding.pcbPath }));
      await optionalCheckpointStep(checkpointContext, async () => await assertPreviewAuthorityBinding(authority, descriptor));
      const artifacts = rendered.result.artifacts.map((artifact) => Object.freeze({ kind: artifact.name === "schematic.svg" ? "schematic" as const : artifact.name === "board-top.png" ? "pcb_top" as const : "pcb_bottom" as const, relativePath: artifact.name, mediaType: artifact.mediaType, sizeBytes: artifact.sizeBytes, sha256: artifact.sha256 }));
      const manifest: RuntimePreviewManifestBinding = Object.freeze({
        root: rendered.root,
        refreshedAt: new Date().toISOString(),
        artifacts,
        authorityDigest: binding.authorityDigest,
        previewDigest: fluxDigest(artifacts.map(({ kind, sha256 }) => ({ kind, sha256 })))
      });
      if (checkpointContext !== undefined) assertCheckpointOperationActive(checkpointContext);
      if (publish) manifests.set(runId, manifest);
      return manifest;
    });
  };

  const render = async (runId: string): Promise<RuntimePreviewManifestBinding> => {
    const preparation = await manager.verifiedPreparation(runId);
    const binding = await bindingFor(preparation);
    return await renderPrepared(runId, preparation, binding);
  };

  const bindFreshClearanceEvidencePort = async (
    clearanceWorkspaceRoot: string,
    clearanceProjectRoot: string,
    checkpointContext?: FluxCheckpointOperationContext,
  ): Promise<RuntimeFreshClearanceEvidencePort> => {
    const adapter = await optionalCheckpointStep(checkpointContext, async () => await createPinnedKicadCliAdapter({
      workspaceRoot: clearanceWorkspaceRoot,
      projectRoot: clearanceProjectRoot,
      outputRoot: clearanceWorkspaceRoot,
      executablePath: activeKicadToolchain.kicadCli.path,
      environment: minimalKicadCliEnvironment(environment),
      expectedExecutableIdentity: {
        sha256: activeKicadToolchain.kicadCli.contentIdentity.digest,
        sizeBytes: activeKicadToolchain.kicadCli.contentIdentity.size,
      },
      ...(checkpointContext === undefined
        ? dependencies.runKicadCliIdentityProbe === undefined ? {} : { runner: dependencies.runKicadCliIdentityProbe }
        : { runner: checkpointProcessRunner(checkpointContext), signal: checkpointContext.signal }),
    }));
    const identity: KicadExecutableIdentity = adapter.identity;
    if (!sameRuntimePath(identity.path, activeKicadToolchain.kicadCli.path)
        || identity.sha256 !== activeKicadToolchain.kicadCli.contentIdentity.digest
        || identity.sizeBytes !== activeKicadToolchain.kicadCli.contentIdentity.size
        || identity.version !== activeKicadToolchain.kicadCli.operationalVersion
        || identity.commit !== activeKicadToolchain.kicadCli.operationalCommit
        || !/^[0-9a-f]{64}$/u.test(identity.capabilityHelpSha256)
        || !Array.isArray(identity.confirmedCapabilities)) {
      throw new FluxError("APPROVAL_MISMATCH", "KiCad CLI clearance authority does not match the active toolchain profile.");
    }
    const kicad = Object.freeze({ ...identity, confirmedCapabilities: Object.freeze([...identity.confirmedCapabilities]) });
    const sourcePort = dependencies.createFreshDesignClearanceEvidencePort?.(kicad) ?? Object.freeze({
      kicad,
      materialize: async ({ bundle, project }) => await materializeFreshNetClasses({ project, compilationBundle: bundle, kicad }),
      readSemanticAuthority: async ({ bundle, project }) => await readFreshNetClassSemanticAuthority({ project, compilationBundle: bundle, kicad }),
      read: async ({ bundle, project }) => await readFreshClearanceEvidence({ project, compilationBundle: bundle, kicad }),
    });
    if (canonicalJson(sourcePort.kicad) !== canonicalJson(kicad)) throw new FluxError("APPROVAL_MISMATCH", "Clearance evidence port changed its pinned KiCad CLI authority.");
    let capturedMaterialization: FreshNetClassMaterialization | undefined;
    let capturedSemanticAuthority: FreshNetClassSemanticAuthority | undefined;
    let capturedReceipt: FreshClearanceEvidenceReceipt | undefined;
    const expectedKicad = clearanceKicadIdentity(kicad);
    const validateResult = <Value extends FreshNetClassMaterialization | FreshClearanceEvidenceReceipt>(
      value: Value,
      expectedSchema: typeof FRESH_NETCLASS_MATERIALIZATION_SCHEMA_VERSION | typeof FRESH_CLEARANCE_EVIDENCE_RECEIPT_SCHEMA_VERSION,
      label: string,
    ): Value => {
      if (value.schemaVersion !== expectedSchema || canonicalJson(value.kicad) !== canonicalJson(expectedKicad)) throw new FluxError("APPROVAL_MISMATCH", `${label} changed its pinned KiCad CLI authority.`);
      const identity = validateCanonicalIdentity(value.identity, `${label} identity`);
      const { identity: _identity, ...payload } = value;
      if (identity.schemaVersion !== expectedSchema || canonicalJson(identity) !== canonicalJson(canonicalIdentity(payload, expectedSchema))) throw new FluxError("APPROVAL_MISMATCH", `${label} identity is invalid.`);
      return value;
    };
    const port = Object.freeze({
      kicad,
      materialize: async (input: Parameters<typeof sourcePort.materialize>[0]) => {
        const value = validateResult(await sourcePort.materialize(input), FRESH_NETCLASS_MATERIALIZATION_SCHEMA_VERSION, "Fresh net-class materialization");
        capturedMaterialization = value;
        return value;
      },
      readSemanticAuthority: async (input: Parameters<typeof sourcePort.readSemanticAuthority>[0]) => {
        const value = await verifyFreshNetClassSemanticAuthority(await sourcePort.readSemanticAuthority(input), {
          project: input.project,
          compilationBundle: input.bundle,
          kicad,
        });
        capturedSemanticAuthority = value;
        return value;
      },
      read: async (input: Parameters<typeof sourcePort.read>[0]) => {
        const observed = await sourcePort.read(input);
        const value = await verifyFreshClearanceEvidenceReceipt(observed, { project: input.project, compilationBundle: input.bundle, kicad });
        capturedReceipt = value;
        return value;
      },
    });
    return Object.freeze({
      port,
      kicad,
      materialization: () => capturedMaterialization,
      semanticAuthority: () => capturedSemanticAuthority,
      receipt: () => capturedReceipt,
    });
  };

  const capturePreparedNetClassAuthority = async (
    request: Extract<FluxPrepareRequest, Readonly<{ readonly workflowKind: "generic" }>>,
    outputRoot: string,
    execution: PcbAgentCliExecution,
    port: RuntimeFreshClearanceEvidencePort,
  ): Promise<RuntimePreparedNetClassAuthority> => {
    const materialization = port.materialization();
    const semanticAuthority = port.semanticAuthority();
    if (materialization === undefined || semanticAuthority === undefined
        || execution.report.freshNetClassMaterialization === undefined
        || execution.report.freshNetClassSemanticAuthority === undefined
        || canonicalJson(execution.report.freshNetClassMaterialization) !== canonicalJson(materialization)
        || canonicalJson(execution.report.freshNetClassSemanticAuthority) !== canonicalJson(semanticAuthority)) {
      throw new FluxError("STORE_CORRUPT", "Generic prepare report does not match host net-class materialization and semantic readback.");
    }
    let evidence: FreshNetClassPreparationEvidence;
    try {
      evidence = parseFreshNetClassPreparationEvidence(execution.report.freshNetClassPreparationEvidence);
    } catch {
      throw new FluxError("STORE_CORRUPT", "Generic prepare report lacks valid net-class preparation evidence.");
    }
    if (canonicalJson(evidence) !== canonicalJson(createFreshNetClassPreparationEvidence(materialization, semanticAuthority))) {
      throw new FluxError("STORE_CORRUPT", "Generic prepare evidence does not reproduce from its trusted host results.");
    }
    let preparedSourceAuthority: FreshProjectOpenPreparedSourceAuthority;
    try { preparedSourceAuthority = parseFreshProjectOpenPreparedSourceAuthority(execution.report.freshProjectOpenPreparedSourceAuthority); }
    catch { throw new FluxError("STORE_CORRUPT", "Generic prepare report lacks valid pre-Open source authority."); }
    if (canonicalJson(preparedSourceAuthority.pro) !== canonicalJson(materialization.projectSettingsIdentity)
        || canonicalJson(preparedSourceAuthority.pcb) !== canonicalJson(materialization.pcbIdentityAtMaterialization)
        || canonicalJson(preparedSourceAuthority.marker) !== canonicalJson(materialization.freshMarkerContentIdentity)) {
      throw new FluxError("STORE_CORRUPT", "Generic pre-Open source authority does not match net-class materialization bytes.");
    }
    const expectedReportPath = path.join(outputRoot, "pcb-agent-report.json");
    if (!sameRuntimePath(await realpath(execution.reportPath), expectedReportPath)) throw new FluxError("PATH_POLICY", "Generic prepare report used an invalid path.");
    let storedReport: unknown;
    try { storedReport = JSON.parse(await readFile(expectedReportPath, "utf8")) as unknown; }
    catch { throw new FluxError("STORE_CORRUPT", "Generic prepare report is unreadable."); }
    if (canonicalJson(storedReport) !== canonicalJson(execution.report)) throw new FluxError("STORE_CORRUPT", "Generic prepare report bytes differ from the settled prepare result.");
    return Object.freeze({ authorityDigest: authorityDigestFor(request), evidence, materialization, semanticAuthority, preparedSourceAuthority });
  };

  const freshProjectForGeneric = async (
    request: Extract<FluxPrepareRequest, Readonly<{ readonly workflowKind: "generic" }>>,
    binding: PreparedBinding,
  ): Promise<FreshProject> => await prepareFreshProject({
    outputDir: binding.outputRoot,
    name: freshName(request.runId),
    resume: true,
    workflowKind: "generic",
    compilationBundle: request.compilationBundle,
    compilationBundleRef: request.compilationBundleRef,
  });

  const loadPreparedNetClassAuthority = async (
    request: Extract<FluxPrepareRequest, Readonly<{ readonly workflowKind: "generic" }>>,
    binding: PreparedBinding,
    checkpointContext?: FluxCheckpointOperationContext,
  ): Promise<RuntimePreparedNetClassAuthority> => {
    const reportPath = path.join(binding.outputRoot, "pcb-agent-report.json");
    let report: PcbAgentCliReport;
    try { report = JSON.parse(await optionalCheckpointStep(checkpointContext, async () => await readFile(reportPath, "utf8"))) as PcbAgentCliReport; }
    catch { throw new FluxError("STORE_CORRUPT", "Generic prepare report is unreadable during net-class authority reload."); }
    if (report.freshNetClassMaterialization === undefined || report.freshNetClassSemanticAuthority === undefined) throw new FluxError("STORE_CORRUPT", "Generic prepare report lacks its net-class authority children.");
    let evidence: FreshNetClassPreparationEvidence;
    try {
      evidence = parseFreshNetClassPreparationEvidence(report.freshNetClassPreparationEvidence);
      if (canonicalJson(evidence) !== canonicalJson(createFreshNetClassPreparationEvidence(report.freshNetClassMaterialization, report.freshNetClassSemanticAuthority))) throw new Error("evidence mismatch");
    } catch {
      throw new FluxError("STORE_CORRUPT", "Generic prepare report net-class authority does not reproduce.");
    }
    let expectedEvidence: FreshNetClassPreparationEvidence;
    try { expectedEvidence = parseFreshNetClassPreparationEvidence(request.freshNetClassPreparationEvidence); }
    catch { throw new FluxError("APPROVAL_MISMATCH", "Generic lifecycle request lacks its prepared net-class authority."); }
    if (canonicalJson(expectedEvidence) !== canonicalJson(evidence)) throw new FluxError("APPROVAL_MISMATCH", "Generic lifecycle net-class authority differs from the settled prepare report.");
    let expectedSemanticAuthority: FreshNetClassSemanticAuthority;
    try { expectedSemanticAuthority = parseFreshNetClassSemanticAuthority(request.freshNetClassSemanticAuthority); }
    catch { throw new FluxError("APPROVAL_MISMATCH", "Generic lifecycle request lacks its full net-class semantic authority."); }
    if (canonicalJson(expectedSemanticAuthority) !== canonicalJson(report.freshNetClassSemanticAuthority)) throw new FluxError("APPROVAL_MISMATCH", "Generic lifecycle semantic authority differs from the settled prepare report.");
    let preparedSourceAuthority: FreshProjectOpenPreparedSourceAuthority;
    let expectedPreparedSourceAuthority: FreshProjectOpenPreparedSourceAuthority;
    try {
      preparedSourceAuthority = parseFreshProjectOpenPreparedSourceAuthority(report.freshProjectOpenPreparedSourceAuthority);
      expectedPreparedSourceAuthority = parseFreshProjectOpenPreparedSourceAuthority(request.freshProjectOpenPreparedSourceAuthority);
    } catch {
      throw new FluxError("APPROVAL_MISMATCH", "Generic lifecycle request or prepare report lacks its pre-Open source authority.");
    }
    if (canonicalJson(preparedSourceAuthority) !== canonicalJson(expectedPreparedSourceAuthority)) throw new FluxError("APPROVAL_MISMATCH", "Generic pre-Open source authority differs from the settled prepare report.");
    const loaded = Object.freeze({ authorityDigest: authorityDigestFor(request), evidence, materialization: report.freshNetClassMaterialization, semanticAuthority: report.freshNetClassSemanticAuthority, preparedSourceAuthority });
    const cached = preparedNetClasses.get(request.runId);
    if (cached !== undefined && (cached.authorityDigest !== loaded.authorityDigest || canonicalJson(cached) !== canonicalJson(loaded))) throw new FluxError("APPROVAL_MISMATCH", "Generic net-class preparation authority changed after capture.");
    preparedNetClasses.set(request.runId, loaded);
    return loaded;
  };

  const reverifyPreparedNetClassAuthority = async (
    request: Extract<FluxPrepareRequest, Readonly<{ readonly workflowKind: "generic" }>>,
    binding: PreparedBinding,
    sourcePhase: "pre_open" | "pre_authoring" | "post_authoring" = "pre_authoring",
    checkpointContext?: FluxCheckpointOperationContext,
  ): Promise<Readonly<{ readonly prepared: RuntimePreparedNetClassAuthority; readonly port: RuntimeFreshClearanceEvidencePort; readonly project: FreshProject }>> => {
    const preparedAuthority = await optionalCheckpointStep(checkpointContext, async () => await loadPreparedNetClassAuthority(request, binding, checkpointContext));
    const project = await optionalCheckpointStep(checkpointContext, async () => await freshProjectForGeneric(request, binding));
    if (sourcePhase === "post_authoring") {
      const expectedSources = preparedAuthority.preparedSourceAuthority;
      const [symbolTableBinding, footprintTableBinding, markerBinding] = await Promise.all([
        bindRuntimeFile(path.join(binding.projectRoot, "sym-lib-table"), binding.projectIdentity, "Prepared symbol library table"),
        bindRuntimeFile(path.join(binding.projectRoot, "fp-lib-table"), binding.projectIdentity, "Prepared footprint library table"),
        bindRuntimeFile(project.markerPath, binding.outputIdentity, "Prepared fresh-project marker"),
      ]);
      const [symbolTable, footprintTable, marker] = await Promise.all([
        contentIdentityForBoundFile(symbolTableBinding, binding.projectIdentity, "Prepared symbol library table"),
        contentIdentityForBoundFile(footprintTableBinding, binding.projectIdentity, "Prepared footprint library table"),
        contentIdentityForBoundFile(markerBinding, binding.outputIdentity, "Prepared fresh-project marker"),
      ]);
      if (canonicalJson(project.projectIdentity) !== canonicalJson(expectedSources.projectIdentity)
          || canonicalJson(symbolTable) !== canonicalJson(expectedSources.sym)
          || canonicalJson(footprintTable) !== canonicalJson(expectedSources.fp)
          || canonicalJson(marker) !== canonicalJson(expectedSources.marker)) {
        throw new FluxError("APPROVAL_MISMATCH", "Generic immutable prepared-source authority changed after authoring.");
      }
    } else {
      const currentSources = await optionalCheckpointStep(checkpointContext, async () => await captureFreshProjectOpenPreparedSourceAuthority(project));
      const expectedSources = preparedAuthority.preparedSourceAuthority;
      const keys = sourcePhase === "pre_open"
        ? (["projectIdentity", "pro", "sch", "pcb", "sym", "fp", "marker", "identity"] as const)
        : (["projectIdentity", "sch", "pcb", "sym", "fp", "marker"] as const);
      if (keys.some((key) => canonicalJson(currentSources[key]) !== canonicalJson(expectedSources[key]))) {
        throw new FluxError("APPROVAL_MISMATCH", "Generic prepared source authority changed before its authorized lifecycle boundary.");
      }
    }
    const port = await optionalCheckpointStep(checkpointContext, async () => await bindFreshClearanceEvidencePort(binding.outputRoot, binding.projectRoot, checkpointContext));
    const semanticAuthority = await optionalCheckpointStep(checkpointContext, async () => await port.port.readSemanticAuthority({ bundle: request.compilationBundle, project }));
    const currentEvidence = createFreshNetClassPreparationEvidence(preparedAuthority.materialization, semanticAuthority);
    if (canonicalJson(currentEvidence) !== canonicalJson(preparedAuthority.evidence)) throw new FluxError("APPROVAL_MISMATCH", "Generic net-class semantic authority changed after prepare.");
    return Object.freeze({ prepared: preparedAuthority, port, project });
  };

  const netClassProjection = (authority: FreshNetClassSemanticAuthority): FreshProjectNetClassSemanticProjection => Object.freeze({
    netClasses: Object.freeze([...authority.netClasses]),
    contractNetAssignments: Object.freeze([...authority.contractNetAssignments]),
  });

  const inspectionAuthorityFor = async (
    runId: string,
    ipcBinding: RuntimeOpenedIpcBinding,
    checkpointContext?: FluxCheckpointOperationContext,
  ): Promise<FluxInspectionAuthorityDto> => {
    const writeSessionAuthority = ipcBinding.writeSessionAuthority;
    if (writeSessionAuthority === undefined) throw new FluxError("ILLEGAL_TRANSITION", "Checkpoint Open before requesting run-bound inspection.");
    const status = await optionalCheckpointStep(checkpointContext, async () => await kicadMcpRuntime.assertIpcSocket(
      ipcBinding.ipcSocket,
      ipcBinding.runBindingIdentity,
      checkpointContext === undefined ? undefined : checkpointMcpContext(checkpointContext),
    ));
    if (canonicalJson(status.bindingIdentity) !== canonicalJson(ipcBinding.ipcSocket.identity)
        || !Number.isSafeInteger(status.remainingConnections) || status.remainingConnections < 0
        || status.remainingConnections > KICAD_MCP_IPC_SOCKET_MAX_CONNECTIONS) {
      throw new FluxError("APPROVAL_MISMATCH", "KiCad MCP runtime returned an invalid connection budget.");
    }
    return Object.freeze({
      runId,
      inspectionBridgeIdentity: activeInspectionBridgeIdentity,
      executionBridgeIdentity: activeExecutionBridgeIdentity,
      ipcSocketIdentity: ipcBinding.ipcSocket.identity,
      writeSessionAuthorityIdentity: writeSessionAuthority.identity,
      connectionBudget: Object.freeze({
        used: KICAD_MCP_IPC_SOCKET_MAX_CONNECTIONS - status.remainingConnections,
        remaining: status.remainingConnections,
        limit: KICAD_MCP_IPC_SOCKET_MAX_CONNECTIONS,
      }),
    });
  };

  const inspectorAuthorityDigestFor = (
    runId: string,
    authorityDigest: string,
    ipcBinding: RuntimeOpenedIpcBinding & Readonly<{ readonly writeSessionAuthority: KicadMcpBoundSessionAuthority }>,
  ): string => fluxDigest({
    schemaVersion: "evleda.flux-inspection-operation-authority.v1",
    runId,
    authorityDigest,
    inspectionBridgeIdentity: activeInspectionBridgeIdentity,
    executionBridgeIdentity: activeExecutionBridgeIdentity,
    ipcSocketIdentity: ipcBinding.ipcSocket.identity,
    writeSessionAuthorityIdentity: ipcBinding.writeSessionAuthority.identity,
  });

  const connectReadOnlyInspector = async (
    binding: PreparedBinding,
    ipcBinding: RuntimeOpenedIpcBinding,
    preparation: FluxPrepareRequest,
    sourcePhase: "pre_authoring" | "post_authoring" = "pre_authoring",
    checkpointContext?: FluxCheckpointOperationContext,
  ): Promise<KicadMcpSession> => {
    assertIpcReleaseCertain();
    if (checkpointContext !== undefined) assertCheckpointOperationActive(checkpointContext);
    if (preparation.workflowKind === "generic") await reverifyPreparedNetClassAuthority(preparation, binding, sourcePhase, checkpointContext);
    await optionalCheckpointStep(checkpointContext, async () => await kicadMcpRuntime.assertCurrent(
      checkpointContext === undefined ? undefined : checkpointMcpContext(checkpointContext),
    ));
    await optionalCheckpointStep(checkpointContext, async () => await kicadMcpRuntime.assertIpcSocket(
      ipcBinding.ipcSocket,
      ipcBinding.runBindingIdentity,
      checkpointContext === undefined ? undefined : checkpointMcpContext(checkpointContext),
    ));
    const inspectionOutputRoot = path.join(binding.outputRoot, ".flux-inspection");
    if (checkpointContext !== undefined) assertCheckpointOperationActive(checkpointContext);
    let readSessionAuthority: KicadMcpBoundSessionAuthority | undefined;
    let session: KicadMcpSession | undefined;
    try {
      readSessionAuthority = await kicadMcpRuntime.bindSession({
        runBindingIdentity: ipcBinding.runBindingIdentity,
        ipcSocket: ipcBinding.ipcSocket,
        mode: "readonly",
        requiredTools: KICAD_MCP_INSPECTION_TOOL_ALLOWLIST,
        roots: { workspaceRoot: binding.outputRoot, projectRoot: binding.projectRoot, outputRoot: inspectionOutputRoot },
      }, checkpointContext === undefined ? undefined : checkpointMcpContext(checkpointContext));
      if (checkpointContext !== undefined) assertCheckpointOperationActive(checkpointContext);
      session = await readSessionAuthority.connect({
        workspaceRoot: binding.outputRoot,
        projectRoot: binding.projectRoot,
        outputRoot: inspectionOutputRoot,
        mode: "readonly",
        requiredTools: KICAD_MCP_INSPECTION_TOOL_ALLOWLIST,
      }, checkpointContext === undefined ? undefined : checkpointMcpContext(checkpointContext));
      if (checkpointContext !== undefined) assertCheckpointOperationActive(checkpointContext);
      await optionalCheckpointStep(checkpointContext, async () => await kicadMcpRuntime.assertCurrent(
        checkpointContext === undefined ? undefined : checkpointMcpContext(checkpointContext),
      ));
      await optionalCheckpointStep(checkpointContext, async () => await kicadMcpRuntime.assertIpcSocket(
        ipcBinding.ipcSocket,
        ipcBinding.runBindingIdentity,
        checkpointContext === undefined ? undefined : checkpointMcpContext(checkpointContext),
      ));
      if (session.identity.mode !== "readonly"
          || canonicalJson(session.identity.launch.sessionAuthorityIdentity) !== canonicalJson(readSessionAuthority.identity)
          || canonicalJson(session.identity.launch.sessionSemanticAuthorityIdentity) !== canonicalJson(readSessionAuthority.semanticIdentity)
          || canonicalJson(session.identity.launch.ipcSocketIdentity) !== canonicalJson(ipcBinding.ipcSocket.identity)) {
        throw new FluxError("PATH_POLICY", "Flux inspection bridge returned a non-read-only or incorrectly bound session");
      }
      return session;
    } catch (error) {
      try {
        if (session !== undefined) await session.close();
        else if (readSessionAuthority !== undefined && await readSessionAuthority.disposeUnused() !== "disposed") throw new Error("read authority was connected");
      } catch (cleanupError) {
        ipcReleaseUncertainty = cleanupError;
        throw new FluxError("OPERATION_UNCERTAIN", FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE);
      }
      if (checkpointContext !== undefined) assertCheckpointOperationActive(checkpointContext);
      throw error;
    }
  };

  const editorLockIdentity = async (binding: PreparedBinding) => {
    const lockPath = path.join(binding.projectRoot, `~${path.basename(binding.pcbPath)}.lck`);
    const lockBinding = await bindRuntimeFile(lockPath, binding.projectIdentity, "KiCad PCB editor lock");
    const identity = await contentIdentityForBoundFile(lockBinding, binding.projectIdentity, "KiCad PCB editor lock");
    return Object.freeze({ binding: lockBinding, identity });
  };

  const probeOpenIpc = async (
    binding: PreparedBinding,
    ipcBinding: RuntimeOpenedIpcBinding,
    boardContentIdentity: Readonly<{ readonly algorithm: "sha256"; readonly digest: string; readonly size: number }>,
    preparation: FluxPrepareRequest,
    checkpointContext?: FluxCheckpointOperationContext,
  ): Promise<Readonly<{ readonly semanticIdentity: FluxCanonicalIdentityDto; readonly sessionReceiptIdentity: FluxCanonicalIdentityDto }>> => {
    const session = await connectReadOnlyInspector(binding, ipcBinding, preparation, "pre_authoring", checkpointContext);
    let closePromise: Promise<void> | undefined;
    const closeSession = (): Promise<void> => {
      closePromise ??= session.close();
      return closePromise;
    };
    const abortClose = (): void => { void closeSession().catch((error: unknown) => { ipcReleaseUncertainty = error; }); };
    checkpointContext?.signal.addEventListener("abort", abortClose, { once: true });
    try {
      let totalResultBytes = 0;
      const results: Array<Readonly<{ readonly tool: string; readonly resultSha256: string }>> = [];
      for (const tool of KICAD_MCP_INSPECTION_TOOL_ALLOWLIST) {
        const result = await optionalCheckpointStep(checkpointContext, async () => await session.callTool(tool, {}, checkpointContext === undefined ? {} : {
          signal: checkpointContext.signal,
          timeoutMs: Math.max(1, Math.min(30_000, Math.ceil(checkpointContext.deadlineAtMs - Date.now()))),
        }));
        const portableResult = canonicalJson(result.structuredContent ?? result.content ?? null);
        totalResultBytes += Buffer.byteLength(portableResult, "utf8");
        if (totalResultBytes > 2 * 1024 * 1024) throw new FluxError("INVALID_ARGUMENT", "KiCad IPC checkpoint probes exceeded their bounded aggregate result limit");
        results.push(Object.freeze({ tool, resultSha256: createHash("sha256").update(portableResult, "utf8").digest("hex") }));
      }
      const sessionIdentity = session.identity;
      const inspectionSessionSemanticIdentity = validateCanonicalIdentity(sessionIdentity.sessionSemanticIdentity, "KiCad MCP read-session semantic identity");
      const sessionReceiptIdentity = validateCanonicalIdentity(sessionIdentity.sessionReceiptIdentity, "KiCad MCP read-session receipt identity");
      const ipcSocketIdentity = validateCanonicalIdentity(sessionIdentity.launch.ipcSocketIdentity, "KiCad MCP IPC socket identity");
      if (sessionIdentity.server === null || sessionIdentity.server.authenticated !== true
          || sessionIdentity.sidecar.distribution !== "kicad-mcp-pro"
          || inspectionSessionSemanticIdentity.schemaVersion !== KICAD_MCP_SESSION_SEMANTIC_IDENTITY_SCHEMA_VERSION
          || sessionReceiptIdentity.schemaVersion !== KICAD_MCP_SESSION_RECEIPT_SCHEMA_VERSION
          || canonicalJson(ipcSocketIdentity) !== canonicalJson(ipcBinding.ipcSocket.identity)) {
        throw new FluxError("APPROVAL_MISMATCH", "KiCad IPC checkpoint probe returned invalid stable session authority.");
      }
      const payload = {
        schemaVersion: FLUX_OPEN_IPC_PROBE_SEMANTIC_SCHEMA_VERSION,
        tools: [...KICAD_MCP_INSPECTION_TOOL_ALLOWLIST],
        results,
        server: sessionIdentity.server ?? null,
        sidecar: sessionIdentity.sidecar === undefined ? null : {
          distribution: sessionIdentity.sidecar.distribution,
          version: sessionIdentity.sidecar.version,
          auditedCommit: sessionIdentity.sidecar.auditedCommit,
        },
        inspectionBridgeIdentity: activeInspectionBridgeIdentity,
        ipcSocketIdentity,
        inspectionSessionSemanticIdentity,
        projectAuthorityDigest: binding.authorityDigest,
        boardContentIdentity,
        sourceFingerprint: binding.source.fingerprint,
      };
      return Object.freeze({
        semanticIdentity: canonicalIdentity(payload, payload.schemaVersion),
        sessionReceiptIdentity,
      });
    } finally {
      checkpointContext?.signal.removeEventListener("abort", abortClose);
      try {
        await closeSession();
        if (checkpointContext?.signal.aborted || (checkpointContext !== undefined && Date.now() >= checkpointContext.deadlineAtMs)) {
          await kicadMcpRuntime.assertCurrent();
          await kicadMcpRuntime.assertIpcSocket(ipcBinding.ipcSocket, ipcBinding.runBindingIdentity);
        } else {
          await optionalCheckpointStep(checkpointContext, async () => await kicadMcpRuntime.assertCurrent(
            checkpointContext === undefined ? undefined : checkpointMcpContext(checkpointContext),
          ));
          await optionalCheckpointStep(checkpointContext, async () => await kicadMcpRuntime.assertIpcSocket(
            ipcBinding.ipcSocket,
            ipcBinding.runBindingIdentity,
            checkpointContext === undefined ? undefined : checkpointMcpContext(checkpointContext),
          ));
        }
        await releaseExitedIpcSocket(ipcBinding);
      } catch (error) {
        if (checkpointContext?.signal.aborted || (checkpointContext !== undefined && Date.now() >= checkpointContext.deadlineAtMs)) {
          if (!(error instanceof FluxError && error.code === "OPERATION_UNCERTAIN")) ipcReleaseUncertainty = error;
          throw new FluxError("OPERATION_UNCERTAIN", FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE);
        }
        throw error;
      }
      if (checkpointContext !== undefined) assertCheckpointOperationActive(checkpointContext);
    }
  };

  const assertOpenCheckpointAuthority = async (
    request: FluxExecuteRequest,
    binding: PreparedBinding,
  ): Promise<Readonly<{
    readonly suite: FluxPcbEditorSuiteHostBinding;
    readonly ipcBinding: RuntimeOpenedIpcBinding & Readonly<{ readonly writeSessionAuthority: KicadMcpBoundSessionAuthority }>;
    readonly inspectionSessionReceiptIdentity: FluxCanonicalIdentityDto;
  }>> => {
    assertIpcReleaseCertain();
    const preflightReceipt = request.openPreflightReceipt;
    const checkpointReceipt = request.openCheckpointReceipt;
    const activeIpcBinding = openedIpcBinding;
    const expectedNetClassSemanticIdentity = request.workflowKind === "generic"
      ? request.freshNetClassPreparationEvidence?.semanticAuthorityIdentity ?? null
      : null;
    const expectedNetClassPreparationEvidenceIdentity = request.workflowKind === "generic"
      ? request.freshNetClassPreparationEvidence?.identity ?? null
      : null;
    const expectedPreparedSourceAuthorityIdentity = request.workflowKind === "generic"
      ? request.freshProjectOpenPreparedSourceAuthority?.identity ?? null
      : null;
    if (preflightReceipt === undefined || checkpointReceipt === undefined ||
      activeIpcBinding?.writeSessionAuthority === undefined || openedRunId !== request.runId || openedProcessId === undefined || editorExitedSockets.has(activeIpcBinding.ipcSocket) || !isPcbEditorProcessAlive(openedProcessId) ||
      canonicalJson(request.approval.kicadToolchainIdentity) !== canonicalJson(activeKicadToolchain.identity) ||
      canonicalJson(request.approval.inspectionBridgeIdentity) !== canonicalJson(activeInspectionBridgeIdentity) ||
      canonicalJson(request.approval.executionBridgeIdentity) !== canonicalJson(activeExecutionBridgeIdentity) ||
      canonicalJson(request.approval.ipcSocketIdentity) !== canonicalJson(activeIpcBinding.ipcSocket.identity) ||
      canonicalJson(request.approval.writeSessionAuthorityIdentity) !== canonicalJson(activeIpcBinding.writeSessionAuthority.identity) ||
      canonicalJson(request.approval.ipcProbeSemanticIdentity) !== canonicalJson(checkpointReceipt?.ipcProbeSemanticIdentity) ||
      canonicalJson(request.approval.freshNetClassSemanticAuthorityIdentity) !== canonicalJson(expectedNetClassSemanticIdentity) ||
      canonicalJson(request.approval.freshNetClassPreparationEvidenceIdentity) !== canonicalJson(expectedNetClassPreparationEvidenceIdentity) ||
      canonicalJson(request.approval.freshProjectOpenPreparedSourceAuthorityIdentity) !== canonicalJson(expectedPreparedSourceAuthorityIdentity) ||
      canonicalJson(request.approval.openPreflightReceiptIdentity) !== canonicalJson(preflightReceipt.identity) ||
      canonicalJson(request.approval.openCheckpointReceiptIdentity) !== canonicalJson(checkpointReceipt.identity) ||
      canonicalJson(checkpointReceipt.kicadToolchainIdentity) !== canonicalJson(activeKicadToolchain.identity) ||
      canonicalJson(checkpointReceipt.inspectionBridgeIdentity) !== canonicalJson(activeInspectionBridgeIdentity) ||
      canonicalJson(checkpointReceipt.executionBridgeIdentity) !== canonicalJson(activeExecutionBridgeIdentity) ||
      canonicalJson(checkpointReceipt.ipcSocketIdentity) !== canonicalJson(activeIpcBinding.ipcSocket.identity) ||
      canonicalJson(checkpointReceipt.writeSessionAuthorityIdentity) !== canonicalJson(activeIpcBinding.writeSessionAuthority.identity) ||
      canonicalJson(checkpointReceipt.freshNetClassSemanticAuthorityIdentity) !== canonicalJson(expectedNetClassSemanticIdentity) ||
      canonicalJson(checkpointReceipt.freshNetClassPreparationEvidenceIdentity) !== canonicalJson(expectedNetClassPreparationEvidenceIdentity) ||
      canonicalJson(checkpointReceipt.freshProjectOpenPreparedSourceAuthorityIdentity) !== canonicalJson(expectedPreparedSourceAuthorityIdentity) ||
      canonicalJson(preflightReceipt.inspectionBridgeIdentity) !== canonicalJson(activeInspectionBridgeIdentity) ||
      canonicalJson(preflightReceipt.ipcSocketIdentity) !== canonicalJson(activeIpcBinding.ipcSocket.identity) ||
      canonicalJson(preflightReceipt.freshNetClassSemanticAuthorityIdentity) !== canonicalJson(expectedNetClassSemanticIdentity) ||
      canonicalJson(preflightReceipt.freshNetClassPreparationEvidenceIdentity) !== canonicalJson(expectedNetClassPreparationEvidenceIdentity) ||
      canonicalJson(preflightReceipt.freshProjectOpenPreparedSourceAuthorityIdentity) !== canonicalJson(expectedPreparedSourceAuthorityIdentity) ||
      canonicalJson(checkpointReceipt.openPreflightReceiptIdentity) !== canonicalJson(preflightReceipt.identity)) {
      throw new FluxError("APPROVAL_MISMATCH", "Approved Open/checkpoint authority does not match the active KiCad toolchain, MCP runtime, or IPC socket.");
    }
    await kicadMcpRuntime.assertCurrent();
    await kicadMcpRuntime.assertIpcSocket(activeIpcBinding.ipcSocket, activeIpcBinding.runBindingIdentity);
    const suite = await bindFluxPcbEditorSuite({
      toolchain: activeKicadToolchain,
      ...(dependencies.runKicadCliIdentityProbe === undefined ? {} : { runner: dependencies.runKicadCliIdentityProbe }),
      environment,
    });
    if (canonicalJson(suite.installationRootIdentity) !== canonicalJson(preflightReceipt.installationRootIdentity)) throw new FluxError("APPROVAL_MISMATCH", "KiCad installation root changed after approval.");
    const fingerprintBeforeIpc = await fingerprint(binding.projectRoot);
    const board = await contentIdentityForBoundFile(binding.pcbIdentity, binding.projectIdentity, "Prepared board");
    const editorLock = await editorLockIdentity(binding);
    const ipcProbe = await probeOpenIpc(binding, activeIpcBinding, board, request);
    if (editorExitedSockets.has(activeIpcBinding.ipcSocket)) throw new FluxError("APPROVAL_MISMATCH", "The approved PCB editor exited during IPC revalidation.");
    const fingerprintAfterIpc = await fingerprint(binding.projectRoot);
    const boardAfterIpc = await contentIdentityForBoundFile(binding.pcbIdentity, binding.projectIdentity, "Prepared board");
    const lockAfterIpc = await editorLockIdentity(binding);
    if (canonicalJson(board) !== canonicalJson(checkpointReceipt.board) || canonicalJson(editorLock.identity) !== canonicalJson(checkpointReceipt.editorLock) ||
      canonicalJson(ipcProbe.semanticIdentity) !== canonicalJson(checkpointReceipt.ipcProbeSemanticIdentity) || fingerprintBeforeIpc !== checkpointReceipt.isolatedFingerprint ||
      fingerprintAfterIpc !== fingerprintBeforeIpc || canonicalJson(boardAfterIpc) !== canonicalJson(board) || canonicalJson(lockAfterIpc.identity) !== canonicalJson(editorLock.identity)) {
      throw new FluxError("APPROVAL_MISMATCH", "Project, editor lock, IPC, or source identity changed after approval.");
    }
    return Object.freeze({
      suite,
      ipcBinding: activeIpcBinding as RuntimeOpenedIpcBinding & Readonly<{ readonly writeSessionAuthority: KicadMcpBoundSessionAuthority }>,
      inspectionSessionReceiptIdentity: ipcProbe.sessionReceiptIdentity,
    });
  };

  manager = new FluxRunManager({
    workspaceRoot,
    sources,
    activeKicadToolchainIdentity: activeKicadToolchain.identity,
    activeInspectionBridgeIdentity,
    activeExecutionBridgeIdentity,
    ...(dependencies.contractInterpreter === undefined ? {} : { contractInterpreter: dependencies.contractInterpreter }),
    ...(compilationBundleStore === undefined ? {} : { compilationBundleStore }),
    ...(activeProviderProfile === undefined ? {} : { activeProviderProfile }),
    genericHarnessRuleIdentity: computeGenericPcbAgentHarnessRuleIdentity,
    genericAcceptanceProfileIdentity: computeFluxGenericAcceptanceProfileIdentity,
    sourceFingerprint: async ({ key, sourceRoot: requestedRoot }) => {
      const source = byKey.get(key);
      if (source === undefined || source.sourceRoot.toLocaleLowerCase("en-US") !== requestedRoot.toLocaleLowerCase("en-US")) throw new FluxError("APPROVAL_MISMATCH", "Flux source binding changed");
      return source.mode === "new" ? source.fingerprint : fingerprint(source.sourceRoot);
    },
    ports: {
      prepare: async (request) => {
        if (!(["openai", "anthropic", "codex", "claude-cli"] as readonly string[]).includes(request.providerModel.provider)) throw new FluxError("INVALID_ARGUMENT", "Flux provider must be openai, anthropic, codex, or claude-cli.");
        if (canonicalJson(request.providerModel) !== canonicalJson(providerModel)) throw new FluxError("INVALID_ARGUMENT", "Flux provider/model/tier does not match the active server policy.");
        if (request.workflowKind === "generic" && (activeProviderProfile === undefined || canonicalJson(request.providerProfile) !== canonicalJson(activeProviderProfile))) throw new FluxError("APPROVAL_MISMATCH", "Flux compilation provider profile does not match the active interpreter adapter.");
        const source = byKey.get(request.sourceKey);
        if (source === undefined) throw new FluxError("NOT_FOUND", "Flux source binding is unavailable.");
        if (request.iterationCap < FLUX_ITERATION_CAP_POLICY.minimum || request.iterationCap > FLUX_ITERATION_CAP_POLICY.maximum) throw new FluxError("INVALID_ARGUMENT", `Flux iterationCap must be from ${FLUX_ITERATION_CAP_POLICY.minimum} through ${FLUX_ITERATION_CAP_POLICY.maximum}.`);
        const activePolicy = currentHarnessPolicy();
        const expectedHarnessIdentity = request.workflowKind === "generic" ? computeGenericPcbAgentHarnessRuleIdentity(request.compilationBundle) : activePolicy.harnessRuleIdentity;
        if (request.harnessRuleIdentity !== expectedHarnessIdentity) throw new FluxError("INVALID_ARGUMENT", "Flux harnessRuleIdentity does not match the verified workflow rule profile.");
        if (!exactStrings(request.mutationAllowlist, activePolicy.mutationAllowlist)) throw new FluxError("INVALID_ARGUMENT", "Flux mutationAllowlist must exactly match the active PCB-agent mutation tools.");
        const expectedAcceptanceIdentity = request.workflowKind === "generic" ? computeFluxGenericAcceptanceProfileIdentity(request.compilationBundle) : FLUX_FRESH_ACCEPTANCE_PROFILE_IDENTITY;
        if (request.freshAcceptanceProfileIdentity !== expectedAcceptanceIdentity || request.freshPersistenceProfileIdentity !== FLUX_FRESH_PERSISTENCE_PROFILE_IDENTITY) throw new FluxError("INVALID_ARGUMENT", "Flux fresh-project policy identities do not match the active server profiles.");
        const authorityDigest = authorityDigestFor(request);
        const outputRoot = await ensureOutputRoot(request);
        const prepareToolchain = await bindFluxPcbEditorSuite({
          toolchain: activeKicadToolchain,
          ...(dependencies.runKicadCliIdentityProbe === undefined ? {} : { runner: dependencies.runKicadCliIdentityProbe }),
          environment,
        });
        const prepareClearancePort = request.workflowKind === "generic"
          ? await bindFreshClearanceEvidencePort(outputRoot, outputRoot)
          : undefined;
        const prepareCliOptions = cliOptions(request, source, outputRoot, "prepare", environment, activeKicadToolchain);
        let execution: PcbAgentCliExecution;
        try {
          execution = await runCli(prepareCliOptions, {
            environment,
            createKicadCliAdapter: createPinnedKicadCliAdapter,
            ...(prepareClearancePort === undefined ? {} : { freshDesignClearanceEvidencePort: prepareClearancePort.port }),
            ...(request.workflowKind === "generic" && dependencies.compilationBundleDependencies !== undefined
              ? { compilationBundleDependencies: dependencies.compilationBundleDependencies }
              : {})
          });
        } finally {
          await assertFluxPcbEditorSuite(prepareToolchain);
        }
        const expectedProjectRoot = path.join(outputRoot, "project");
        const isolatedProjectPath = await ordinaryDirectory(execution.isolatedProjectPath, "Prepared isolated project");
        if (isolatedProjectPath.toLocaleLowerCase("en-US") !== path.resolve(expectedProjectRoot).toLocaleLowerCase("en-US") || !within(workspaceRoot, isolatedProjectPath)) throw new FluxError("PATH_POLICY", "CLI preparation returned an invalid isolated-project binding.");
        const binding = await createPreparedBinding(request, source, outputRoot, isolatedProjectPath);
        prepared.set(request.runId, binding);
        const netClassAuthority = request.workflowKind === "generic" && prepareClearancePort !== undefined
          ? await capturePreparedNetClassAuthority(request, outputRoot, execution, prepareClearancePort)
          : undefined;
        if (netClassAuthority !== undefined) preparedNetClasses.set(request.runId, netClassAuthority);
        const manifest = await render(request.runId);
        return {
          isolatedFingerprint: await fingerprint(binding.projectRoot),
          checkpointRequired: true,
          freshNetClassPreparationEvidence: netClassAuthority?.evidence ?? null,
          freshNetClassSemanticAuthority: netClassAuthority?.semanticAuthority ?? null,
          freshProjectOpenPreparedSourceAuthority: netClassAuthority?.preparedSourceAuthority ?? null,
          preview: { title: `${source.label} candidate`, summary: "Prepared isolated candidate preview.", artifactCount: manifest.artifacts.length, digest: manifest.previewDigest },
        };
      },
      preflightOpen: async ({ projectId, runId, preparation }) => {
        assertIpcReleaseCertain();
        if (runId === undefined || preparation === undefined || preparation.runId !== runId) throw new FluxError("INVALID_ARGUMENT", "Opening Flux requires an explicit verified run binding.");
        const binding = await bindingFor(preparation);
        const netClassVerification = preparation.workflowKind === "generic"
          ? await reverifyPreparedNetClassAuthority(preparation, binding, "pre_open")
          : undefined;
        if (!within(workspaceRoot, binding.pcbPath)) throw new FluxError("PATH_POLICY", "Prepared board failed the isolated-workspace boundary.");
        const boardBefore = await contentIdentityForBoundFile(binding.pcbIdentity, binding.projectIdentity, "Prepared board");
        let suite: FluxPcbEditorSuiteHostBinding;
        try {
          suite = await bindFluxPcbEditorSuite({
            toolchain: activeKicadToolchain,
            ...(dependencies.runKicadCliIdentityProbe === undefined ? {} : { runner: dependencies.runKicadCliIdentityProbe }),
            environment,
          });
        } catch (error) {
          if (error instanceof FluxPcbEditorProbeUncertainError) throw new FluxError("OPERATION_UNCERTAIN", error.message);
          throw error;
        }
        const board = await contentIdentityForBoundFile(binding.pcbIdentity, binding.projectIdentity, "Prepared board");
        if (canonicalJson(boardBefore) !== canonicalJson(board)) throw new FluxError("APPROVAL_MISMATCH", "Prepared board changed during PCB editor preflight.");
        for (const stale of [...openPreflights.values()].filter((candidate) => candidate.receipt.runId === runId)) {
          await cancelStoredOpenPreflight(stale.receipt);
        }
        const preparationDigest = fluxOpenPreparationDigest(preparation);
        const runBindingIdentity = openRunBindingIdentityFor(projectId, preparation, preparationDigest, binding);
        const ipcSocket = await kicadMcpRuntime.allocateIpcSocket({ runBindingIdentity });
        try {
          await kicadMcpRuntime.assertIpcSocket(ipcSocket, runBindingIdentity);
          const payload = {
            schemaVersion: FLUX_OPEN_PREFLIGHT_SCHEMA_VERSION,
            projectId,
            runId,
            preparationDigest,
            suiteVersion: activeKicadToolchain.kicadCli.operationalVersion,
            installationRootIdentity: suite.installationRootIdentity,
            inspectionBridgeIdentity: activeInspectionBridgeIdentity,
            ipcSocketIdentity: ipcSocket.identity,
            freshNetClassSemanticAuthorityIdentity: netClassVerification?.prepared.evidence.semanticAuthorityIdentity ?? null,
            freshNetClassPreparationEvidenceIdentity: netClassVerification?.prepared.evidence.identity ?? null,
            freshProjectOpenPreparedSourceAuthorityIdentity: netClassVerification?.prepared.preparedSourceAuthority.identity ?? null,
            kicadCli: activeKicadToolchain.kicadCli.contentIdentity,
            pcbnew: activeKicadToolchain.pcbnew.contentIdentity,
            board,
          };
          const receipt = createFluxOpenPreflightReceipt(payload);
          openPreflights.set(receipt.identity.digest, Object.freeze({
            receipt,
            preparationDigest,
            prepared: binding,
            suite,
            runBindingIdentity,
            ipcSocket,
            ...(netClassVerification === undefined ? {} : { freshNetClassPreparationEvidence: netClassVerification.prepared.evidence }),
            ...(netClassVerification === undefined ? {} : { freshProjectOpenPreparedSourceAuthority: netClassVerification.prepared.preparedSourceAuthority }),
          }));
          return receipt;
        } catch (error) {
          try {
            const outcome = await kicadMcpRuntime.releaseIpcSocket(ipcSocket, runBindingIdentity);
            if (outcome !== "released") throw new Error("preflight socket unexpectedly active");
          }
          catch { throw new FluxError("OPERATION_UNCERTAIN", "KiCad IPC preflight cleanup could not be confirmed; the run is blocked."); }
          throw error;
        }
      },
      cancelOpenPreflight: cancelStoredOpenPreflight,
      open: async ({ runId, preparation, preflightReceipt }) => {
        if (runId === undefined || preparation === undefined || preparation.runId !== runId) throw new FluxError("INVALID_ARGUMENT", "Opening Flux requires an explicit verified run binding.");
        const preflight = openPreflights.get(preflightReceipt.identity.digest);
        if (preflight === undefined || canonicalJson(preflight.receipt) !== canonicalJson(preflightReceipt) || preflight.preparationDigest !== fluxOpenPreparationDigest(preparation)) {
          throw new FluxError("APPROVAL_MISMATCH", "PCB editor launch lacks its exact current host preflight binding.");
        }
        const expectedNetClassSemanticIdentity = preflight.freshNetClassPreparationEvidence?.semanticAuthorityIdentity ?? null;
        const expectedNetClassPreparationEvidenceIdentity = preflight.freshNetClassPreparationEvidence?.identity ?? null;
        const expectedPreparedSourceAuthorityIdentity = preflight.freshProjectOpenPreparedSourceAuthority?.identity ?? null;
        if (canonicalJson(preflightReceipt.inspectionBridgeIdentity) !== canonicalJson(activeInspectionBridgeIdentity)
            || canonicalJson(preflightReceipt.ipcSocketIdentity) !== canonicalJson(preflight.ipcSocket.identity)
            || canonicalJson(preflightReceipt.freshNetClassSemanticAuthorityIdentity) !== canonicalJson(expectedNetClassSemanticIdentity)
            || canonicalJson(preflightReceipt.freshNetClassPreparationEvidenceIdentity) !== canonicalJson(expectedNetClassPreparationEvidenceIdentity)
            || canonicalJson(preflightReceipt.freshProjectOpenPreparedSourceAuthorityIdentity) !== canonicalJson(expectedPreparedSourceAuthorityIdentity)) {
          throw new FluxError("APPROVAL_MISMATCH", "PCB editor launch does not match its current bridge and IPC socket authority.");
        }
        const binding = await bindingFor(preparation);
        if (!sameRuntimeObject(preflight.prepared.outputIdentity, binding.outputIdentity) ||
          !sameRuntimeObject(preflight.prepared.projectIdentity, binding.projectIdentity) ||
          !sameRuntimeObject(preflight.prepared.pcbIdentity, binding.pcbIdentity)) {
          throw new FluxError("APPROVAL_MISMATCH", "Prepared project identity changed after PCB editor preflight.");
        }
        const openedIpc = Object.freeze({ runBindingIdentity: preflight.runBindingIdentity, ipcSocket: preflight.ipcSocket });
        const editorContext = await kicadMcpRuntime.getEditorLaunchContext(preflight.ipcSocket, preflight.runBindingIdentity);
        let launchClaimed = false;
        const launchResult = await launchFluxPcbEditor(
          preflight.suite,
          binding.pcbPath,
          editorContext,
          dependencies.launchPcbEditor,
          async () => {
            await kicadMcpRuntime.assertCurrent();
            await kicadMcpRuntime.assertIpcSocket(preflight.ipcSocket, preflight.runBindingIdentity);
            if (preparation.workflowKind === "generic") {
              const currentNetClasses = await reverifyPreparedNetClassAuthority(preparation, binding, "pre_open");
              if (preflight.freshNetClassPreparationEvidence === undefined
                  || preflight.freshProjectOpenPreparedSourceAuthority === undefined
                  || canonicalJson(currentNetClasses.prepared.evidence) !== canonicalJson(preflight.freshNetClassPreparationEvidence)) {
                throw new FluxError("APPROVAL_MISMATCH", "Generic net-class preparation authority changed before PCB editor launch.");
              }
              if (canonicalJson(currentNetClasses.prepared.preparedSourceAuthority) !== canonicalJson(preflight.freshProjectOpenPreparedSourceAuthority)) throw new FluxError("APPROVAL_MISMATCH", "Generic prepared source authority changed before PCB editor launch.");
            }
            await assertPreparedBinding(binding);
            const currentBoard = await contentIdentityForBoundFile(binding.pcbIdentity, binding.projectIdentity, "Prepared board");
            if (canonicalJson(currentBoard) !== canonicalJson(preflightReceipt.board)) throw new FluxError("APPROVAL_MISMATCH", "Prepared board changed after PCB editor preflight.");
          },
          environment,
          (result) => {
            if (launchClaimed) throw new FluxError("OPERATION_UNCERTAIN", "PCB editor launcher reported more than one process boundary.");
            launchClaimed = true;
            openPreflights.delete(preflightReceipt.identity.digest);
            openedRunId = runId;
            openedAuthorityDigest = binding.authorityDigest;
            openedProcessId = result.pid;
            openedIpcBinding = openedIpc;
            void result.exited.then(async () => {
              editorExitedSockets.add(openedIpc.ipcSocket);
              await releaseExitedIpcSocket(openedIpc);
            }).catch((error: unknown) => { ipcReleaseUncertainty = error; });
          },
        );
        if (!launchClaimed || launchResult.pid !== openedProcessId) throw new FluxError("OPERATION_UNCERTAIN", "PCB editor process ownership was not established.");
        await kicadMcpRuntime.assertCurrent();
        await kicadMcpRuntime.assertIpcSocket(preflight.ipcSocket, preflight.runBindingIdentity);
        openPreflights.delete(preflightReceipt.identity.digest);
        inspectorSnapshot = undefined;
        return { opened: true, label: "Opened isolated candidate in KiCad PCB Editor", checkpointRequired: true };
      },
      checkpointOpen: async (request: FluxCheckpointOpenRequest, context: FluxCheckpointOperationContext) => {
        const checkpointStartedAtMs = performance.now();
        let checkpointStage: CheckpointFailureStage = "initial_validation";
        let writeSessionAuthority: KicadMcpBoundSessionAuthority | undefined;
        let authorityCommitted = false;
        try {
          assertCheckpointOperationActive(context);
          assertIpcReleaseCertain();
          const { openPreflightReceipt: _openPreflightReceipt, ...checkpointPreparation } = request;
          const activeIpcBinding = openedIpcBinding;
          if (openedRunId !== request.runId || openedAuthorityDigest !== authorityDigestFor(request) || openedProcessId === undefined
              || activeIpcBinding === undefined || editorExitedSockets.has(activeIpcBinding.ipcSocket) || !isPcbEditorProcessAlive(openedProcessId)) {
            throw new FluxError("ILLEGAL_TRANSITION", "Checkpoint-open requires the exact live PCB editor process launched for this run.");
          }
          if (request.openPreflightReceipt.runId !== request.runId || request.openPreflightReceipt.preparationDigest !== fluxOpenPreparationDigest(checkpointPreparation)) {
            throw new FluxError("APPROVAL_MISMATCH", "Checkpoint-open preflight receipt does not bind this preparation.");
          }
          checkpointStage = "prepared_binding";
          let binding = await checkpointStep(context, async () => await bindingFor(request));
          const expectedRunBindingIdentity = openRunBindingIdentityFor(
            request.openPreflightReceipt.projectId,
            checkpointPreparation,
            request.openPreflightReceipt.preparationDigest,
            binding,
          );
          if (canonicalJson(activeIpcBinding.runBindingIdentity) !== canonicalJson(expectedRunBindingIdentity)
              || canonicalJson(activeIpcBinding.ipcSocket.identity) !== canonicalJson(request.openPreflightReceipt.ipcSocketIdentity)
              || canonicalJson(request.openPreflightReceipt.inspectionBridgeIdentity) !== canonicalJson(activeInspectionBridgeIdentity)) {
            throw new FluxError("APPROVAL_MISMATCH", "Checkpoint-open IPC socket authority does not match its Open preflight.");
          }
          checkpointStage = "runtime_revalidation";
          await checkpointStep(context, async () => await kicadMcpRuntime.assertCurrent(checkpointMcpContext(context)));
          checkpointStage = "ipc_validation";
          await checkpointStep(context, async () => await kicadMcpRuntime.assertIpcSocket(activeIpcBinding.ipcSocket, activeIpcBinding.runBindingIdentity, checkpointMcpContext(context)));
          checkpointStage = "toolchain_probe";
          const suite = await checkpointStep(context, async () => await bindFluxPcbEditorSuite({
            toolchain: activeKicadToolchain,
            runner: checkpointProcessRunner(context),
            environment,
          }));
          if (canonicalJson(suite.installationRootIdentity) !== canonicalJson(request.openPreflightReceipt.installationRootIdentity) ||
            canonicalJson(activeKicadToolchain.kicadCli.contentIdentity) !== canonicalJson(request.openPreflightReceipt.kicadCli) ||
            canonicalJson(activeKicadToolchain.pcbnew.contentIdentity) !== canonicalJson(request.openPreflightReceipt.pcbnew)) {
            throw new FluxError("APPROVAL_MISMATCH", "KiCad toolchain changed after Open preflight.");
          }
          checkpointStage = "prepared_source_readback";
          const beforeNormalization = request.workflowKind === "generic"
            ? await reverifyPreparedNetClassAuthority(request, binding, "pre_authoring", context)
            : undefined;
          if (canonicalJson(request.openPreflightReceipt.freshNetClassSemanticAuthorityIdentity)
              !== canonicalJson(beforeNormalization?.prepared.evidence.semanticAuthorityIdentity ?? null)) {
            throw new FluxError("APPROVAL_MISMATCH", "Open preflight net-class semantic authority does not match checkpoint readback.");
          }
          if (canonicalJson(request.openPreflightReceipt.freshNetClassPreparationEvidenceIdentity)
              !== canonicalJson(beforeNormalization?.prepared.evidence.identity ?? null)) {
            throw new FluxError("APPROVAL_MISMATCH", "Open preflight net-class preparation evidence does not match checkpoint input.");
          }
          if (canonicalJson(request.openPreflightReceipt.freshProjectOpenPreparedSourceAuthorityIdentity)
              !== canonicalJson(beforeNormalization?.prepared.preparedSourceAuthority.identity ?? null)) {
            throw new FluxError("APPROVAL_MISMATCH", "Open preflight prepared-source authority does not match checkpoint input.");
          }
          if (binding.source.mode === "new") {
            checkpointStage = "normalization";
            assertCheckpointOperationActive(context);
            await checkpointStep(context, async () => await checkpointOpen({
              outputDir: binding.outputRoot,
              newProjectName: freshName(request.runId),
              ...(beforeNormalization === undefined ? {} : { expectedNetClassProjection: netClassProjection(beforeNormalization.prepared.semanticAuthority) }),
              ...(beforeNormalization === undefined ? {} : { expectedPreparedSourceAuthority: beforeNormalization.prepared.preparedSourceAuthority }),
              assertCanCommit: () => assertCheckpointOperationActive(context),
            }));
          }
          checkpointStage = "prepared_source_readback";
          binding = await checkpointStep(context, async () => await refreshPreparedFiles(binding));
          const afterNormalization = request.workflowKind === "generic"
            ? await reverifyPreparedNetClassAuthority(request, binding, "pre_authoring", context)
            : undefined;
          if (beforeNormalization !== undefined && (afterNormalization === undefined
              || canonicalJson(afterNormalization.prepared.evidence) !== canonicalJson(beforeNormalization.prepared.evidence))) {
            throw new FluxError("APPROVAL_MISMATCH", "Generic net-class authority changed during PCB editor normalization.");
          }
          const isolatedFingerprint = await checkpointStep(context, async () => await fingerprint(binding.projectRoot));
          const board = await checkpointStep(context, async () => await contentIdentityForBoundFile(binding.pcbIdentity, binding.projectIdentity, "Prepared board"));
          const editorLock = await checkpointStep(context, async () => await editorLockIdentity(binding));
          checkpointStage = "readonly_ipc_probe";
          assertCheckpointOperationActive(context);
          const ipcProbe = await checkpointStep(context, async () => await probeOpenIpc(binding, activeIpcBinding, board, request, context));
          if (editorExitedSockets.has(activeIpcBinding.ipcSocket)) throw new FluxError("ILLEGAL_TRANSITION", "The PCB editor exited during checkpoint IPC verification.");
          checkpointStage = "write_binding";
          const approvedWriteCliOptions = cliOptions(request, binding.source, binding.outputRoot, "resume", environment, activeKicadToolchain);
          assertCheckpointOperationActive(context);
          writeSessionAuthority = await kicadMcpRuntime.bindSession({
            runBindingIdentity: activeIpcBinding.runBindingIdentity,
            ipcSocket: activeIpcBinding.ipcSocket,
            mode: "write",
            requiredTools: pcbAgentRequiredSessionTools(approvedWriteCliOptions),
            roots: { workspaceRoot: binding.outputRoot, projectRoot: binding.projectRoot, outputRoot: path.join(binding.outputRoot, ".evleda-mcp-output") },
          }, checkpointMcpContext(context));
          assertCheckpointOperationActive(context);
          checkpointStage = "final_validation_publication";
          await checkpointStep(context, async () => await kicadMcpRuntime.assertCurrent(checkpointMcpContext(context)));
          await checkpointStep(context, async () => await kicadMcpRuntime.assertIpcSocket(activeIpcBinding.ipcSocket, activeIpcBinding.runBindingIdentity, checkpointMcpContext(context)));
          if (editorExitedSockets.has(activeIpcBinding.ipcSocket)) throw new FluxError("ILLEGAL_TRANSITION", "The PCB editor exited while write-session authority was being bound.");
          const fingerprintAfterIpc = await checkpointStep(context, async () => await fingerprint(binding.projectRoot));
          const boardAfterIpc = await checkpointStep(context, async () => await contentIdentityForBoundFile(binding.pcbIdentity, binding.projectIdentity, "Prepared board"));
          const lockAfterIpc = await checkpointStep(context, async () => await editorLockIdentity(binding));
          if (fingerprintAfterIpc !== isolatedFingerprint || canonicalJson(boardAfterIpc) !== canonicalJson(board) || canonicalJson(lockAfterIpc.identity) !== canonicalJson(editorLock.identity)) {
            throw new FluxError("APPROVAL_MISMATCH", "Project or editor lock changed during the KiCad IPC checkpoint probe.");
          }
          assertCheckpointOperationActive(context);
          const openCheckpointReceipt = createFluxOpenCheckpointReceipt({
            schemaVersion: FLUX_OPEN_CHECKPOINT_SCHEMA_VERSION,
            runId: request.runId,
            openPreflightReceiptIdentity: request.openPreflightReceipt.identity,
            kicadToolchainIdentity: activeKicadToolchain.identity,
            inspectionBridgeIdentity: activeInspectionBridgeIdentity,
            executionBridgeIdentity: activeExecutionBridgeIdentity,
            ipcSocketIdentity: activeIpcBinding.ipcSocket.identity,
            writeSessionAuthorityIdentity: writeSessionAuthority.identity,
            freshNetClassSemanticAuthorityIdentity: afterNormalization?.prepared.evidence.semanticAuthorityIdentity ?? null,
            freshNetClassPreparationEvidenceIdentity: afterNormalization?.prepared.evidence.identity ?? null,
            freshProjectOpenPreparedSourceAuthorityIdentity: afterNormalization?.prepared.preparedSourceAuthority.identity ?? null,
            isolatedFingerprint,
            board,
            editorLock: editorLock.identity,
            ipcProbeSemanticIdentity: ipcProbe.semanticIdentity,
            checkpointInspectionSessionReceiptIdentity: ipcProbe.sessionReceiptIdentity,
          });
          const checkpointIpcBinding = Object.freeze({
            runBindingIdentity: activeIpcBinding.runBindingIdentity,
            ipcSocket: activeIpcBinding.ipcSocket,
            writeSessionAuthority,
          });
          const nextInspectorSnapshot = Object.freeze({
            ...await inspectionAuthorityFor(request.runId, checkpointIpcBinding, context),
            state: "idle" as const,
            busy: false as const,
            completedTools: 0 as const,
            totalTools: 6 as const,
          });
          assertCheckpointOperationActive(context);
          const manifest = await renderPrepared(request.runId, request, binding, context, false);
          assertCheckpointOperationActive(context);
          prepared.set(request.runId, binding);
          openedIpcBinding = checkpointIpcBinding;
          inspectorSnapshot = nextInspectorSnapshot;
          manifests.set(request.runId, manifest);
          authorityCommitted = true;
          return { isolatedFingerprint, checkpointRequired: false, openCheckpointReceipt, preview: { title: `${binding.source.label} candidate`, summary: "KiCad Open, lock, IPC, and project checkpoint recorded.", artifactCount: manifest.artifacts.length, digest: manifest.previewDigest } };
        } catch (error) {
          reportCheckpointFailure(request.runId, checkpointStage, checkpointStartedAtMs, error);
          if (writeSessionAuthority !== undefined && !authorityCommitted) {
            try {
              if (await writeSessionAuthority.disposeUnused() !== "disposed") throw new Error("checkpoint write authority was already connected");
            } catch (cleanupError) {
              ipcReleaseUncertainty = cleanupError;
              throw new FluxError("OPERATION_UNCERTAIN", FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE);
            }
          }
          if (error instanceof KicadMcpTerminationUncertainError || error instanceof FluxPcbEditorProbeUncertainError) {
            ipcReleaseUncertainty = error;
            throw new FluxError("OPERATION_UNCERTAIN", FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE);
          }
          assertCheckpointOperationActive(context);
          throw error;
        }
      },
      execute: async (request) => {
        if (request.workflowKind === "generic" && (activeProviderProfile === undefined || canonicalJson(request.providerProfile) !== canonicalJson(activeProviderProfile) || request.approval.workflowKind !== "generic" || canonicalJson(request.approval.providerProfile) !== canonicalJson(activeProviderProfile))) throw new FluxError("APPROVAL_MISMATCH", "Approved compilation provider profile does not match the active interpreter adapter.");
        const binding = await bindingFor(request);
        const preExecutionNetClasses = request.workflowKind === "generic"
          ? await reverifyPreparedNetClassAuthority(request, binding)
          : undefined;
        const executionAuthority = await assertOpenCheckpointAuthority(request, binding);
        const freshClearanceEvidence = preExecutionNetClasses?.port;
        const activePolicy = currentHarnessPolicy();
        const expectedHarnessIdentity = request.workflowKind === "generic" ? computeGenericPcbAgentHarnessRuleIdentity(request.compilationBundle) : activePolicy.harnessRuleIdentity;
        if (request.approval.harnessRuleIdentity !== expectedHarnessIdentity || request.harnessRuleIdentity !== expectedHarnessIdentity || !exactStrings(request.approval.mutationAllowlist, activePolicy.mutationAllowlist) || !exactStrings(request.mutationAllowlist, activePolicy.mutationAllowlist)) throw new FluxError("APPROVAL_MISMATCH", "The active PCB-agent rule or mutation policy changed after approval; prepare and approve a new run.");
        const expectedAcceptanceIdentity = request.workflowKind === "generic" ? computeFluxGenericAcceptanceProfileIdentity(request.compilationBundle) : FLUX_FRESH_ACCEPTANCE_PROFILE_IDENTITY;
        if (request.approval.freshAcceptanceProfileIdentity !== expectedAcceptanceIdentity || request.approval.freshPersistenceProfileIdentity !== FLUX_FRESH_PERSISTENCE_PROFILE_IDENTITY || request.freshAcceptanceProfileIdentity !== expectedAcceptanceIdentity || request.freshPersistenceProfileIdentity !== FLUX_FRESH_PERSISTENCE_PROFILE_IDENTITY) throw new FluxError("APPROVAL_MISMATCH", "The active fresh acceptance or persistence profile changed after approval; prepare and approve a new run.");
        for (const key of ["contractIdentity", "libraryBindingIdentity", "deepRuleBindingIdentity", "acceptancePlanIdentity"] as const) if (fluxDigest(request[key]) !== fluxDigest(request.approval[key])) throw new FluxError("APPROVAL_MISMATCH", "The compiled contract identity closure changed after approval; prepare and approve a new run.");
        if (request.workflowKind === "generic" && request.approval.workflowKind === "generic" &&
          (canonicalJson(request.compilationBundleRef) !== canonicalJson(request.approval.compilationBundleRef) ||
            canonicalJson(request.providerProfile) !== canonicalJson(request.approval.providerProfile) ||
            canonicalJson(request.compilationBundle.identity) !== canonicalJson(request.approval.bundleIdentity))) throw new FluxError("APPROVAL_MISMATCH", "The generic bundle or provider binding changed after approval.");
        if (await fingerprint(binding.projectRoot) !== request.approval.isolatedFingerprint) throw new FluxError("APPROVAL_MISMATCH", "The isolated project changed after approval; prepare and approve a new run.");
        let progressEvents = 0;
        let execution: PcbAgentCliExecution;
        const approvedCliOptions = cliOptions(request, binding.source, binding.outputRoot, "resume", environment, activeKicadToolchain);
        try {
          execution = await runCli(approvedCliOptions, { environment,
            createKicadCliAdapter: createPinnedKicadCliAdapter,
            sessionFactory: async (options) => await executionAuthority.ipcBinding.writeSessionAuthority.connect(options),
            sessionAuthorityIdentity: executionAuthority.ipcBinding.writeSessionAuthority.identity,
            ...(freshClearanceEvidence === undefined ? {} : { freshDesignClearanceEvidencePort: freshClearanceEvidence.port }),
            ...(preExecutionNetClasses === undefined ? {} : { expectedFreshNetClassPreparationEvidence: preExecutionNetClasses.prepared.evidence }),
            ...(preExecutionNetClasses === undefined ? {} : { expectedFreshProjectOpenPreparedSourceAuthority: preExecutionNetClasses.prepared.preparedSourceAuthority }),
            ...(request.workflowKind === "generic" && dependencies.compilationBundleDependencies !== undefined
              ? { compilationBundleDependencies: dependencies.compilationBundleDependencies }
              : {}), observer: async (observed: PcbAgentCliEvent) => {
            progressEvents += 1;
            const detail = observed.type === "report" ? `Harness report recorded with status ${observed.report.status}.` : observed.type === "operation" ? `Iteration ${observed.operation.iteration}: ${observed.operation.name} ${observed.operation.status}.` : `Iteration ${observed.iteration}: validation progress recorded.`;
            await manager.recordProgress(request.runId, detail);
          } });
        } finally {
          await assertFluxPcbEditorSuite(executionAuthority.suite);
          await kicadMcpRuntime.assertCurrent();
          await kicadMcpRuntime.assertIpcSocket(executionAuthority.ipcBinding.ipcSocket, executionAuthority.ipcBinding.runBindingIdentity);
          await releaseExitedIpcSocket(executionAuthority.ipcBinding);
        }
        if (editorExitedSockets.has(executionAuthority.ipcBinding.ipcSocket)) throw new FluxError("OPERATION_UNCERTAIN", "The PCB editor exited during approved execution.");
        const refreshedBinding = await refreshPreparedFiles(binding);
        prepared.set(request.runId, refreshedBinding);
        const expectedReport = path.join(refreshedBinding.outputRoot, "pcb-agent-report.json");
        if ((await realpath(execution.reportPath)).toLocaleLowerCase("en-US") !== expectedReport.toLocaleLowerCase("en-US")) throw new FluxError("PATH_POLICY", "PCB-agent report did not use the canonical run report binding.");
        const reportBytes = await readFile(expectedReport); const reportSha256 = createHash("sha256").update(reportBytes).digest("hex");
        const report = JSON.parse(reportBytes.toString("utf8")) as PcbAgentCliReport;
        if (report.schemaVersion !== PCB_AGENT_CLI_REPORT_SCHEMA_VERSION || !["completed", "needs_review", "blocked", "failed"].includes(report.status) || canonicalJson(report) !== canonicalJson(execution.report)) throw new FluxError("STORE_CORRUPT", "Canonical PCB-agent report has an invalid or inconsistent v2 envelope.");
        const { identity: workflowIdentity, ...workflowPayload } = report.workflow;
        if (canonicalJson(workflowIdentity) !== canonicalJson(canonicalIdentity(workflowPayload, report.workflow.schemaVersion)) ||
          report.workflow.kind !== request.workflowKind || report.provider !== request.providerModel.provider || report.model !== request.providerModel.model ||
          report.ruleProfile.harnessRuleIdentity !== expectedHarnessIdentity) throw new FluxError("STORE_CORRUPT", "PCB-agent report workflow or policy binding does not match the verified Flux execution.");
        if (request.workflowKind === "generic") {
          if (request.compilationBundle.acceptancePlan.schemaVersion !== "evleda.pcb-acceptance-plan.v2" || request.compilationBundle.compilerProfile.schemaVersion !== "evleda.pcb-design-compiler-profile.v2") throw new FluxError("APPROVAL_MISMATCH", "Current generic execution requires the schematic ink-clearance acceptance profile.");
          if (report.workflow.kind !== "generic" || [
            [report.workflow.bundleRef, request.compilationBundleRef],
            [report.workflow.contractIdentity, request.contractIdentity],
            [report.workflow.libraryBindingIdentity, request.libraryBindingIdentity],
            [report.workflow.deepRuleBindingIdentity, request.deepRuleBindingIdentity],
            [report.workflow.practiceProfileBindingIdentity, request.practiceProfileBindingIdentity],
            [report.workflow.acceptancePlanIdentity, request.acceptancePlanIdentity],
            [report.workflow.executionPromptContentIdentity, request.executionPromptContentIdentity]
          ].some(([left, right]) => canonicalJson(left) !== canonicalJson(right))) {
            throw new FluxError("STORE_CORRUPT", "PCB-agent report child identities do not match the verified compilation bundle.");
          }
        }
        const writeSessionReceiptIdentity = writeSessionReceiptForReport(
          report,
          executionAuthority.ipcBinding.writeSessionAuthority.identity,
          executionAuthority.ipcBinding.ipcSocket.identity,
        );
        if (request.workflowKind === "generic" && report.status === "completed") {
          const render = verifyFluxSchematicRenderReceiptForReport(report, execution.report, request.acceptancePlanIdentity, preExecutionNetClasses!.prepared.evidence.kicad);
          if (render.status !== "pass" || report.freshAcceptance?.passed !== true) throw new FluxError("STORE_CORRUPT", "Completed generic report lacks verified current schematic ink-clearance acceptance.");
        }
        const freshClearanceEvidenceBinding = freshClearanceEvidence === undefined
          ? undefined
          : freshClearanceEvidenceBindingForReport(report, freshClearanceEvidence, preExecutionNetClasses!.prepared);
        const verifiedFreshClearanceEvidenceReceipt = freshClearanceEvidence?.receipt();
        return {
          disposition: report.status,
          ...(report.status === "blocked" || report.status === "failed" ? { blockedReason: reportSummary(report.status) } : {}),
          ...(verifiedFreshClearanceEvidenceReceipt === undefined ? {} : { freshClearanceEvidenceReceipt: verifiedFreshClearanceEvidenceReceipt }),
          reports: [projectReport(
            report,
            reportSha256,
            activeExecutionBridgeIdentity,
            executionAuthority.ipcBinding.writeSessionAuthority.identity,
            writeSessionReceiptIdentity,
            executionAuthority.inspectionSessionReceiptIdentity,
            freshClearanceEvidenceBinding,
          )],
        };
      },
      afterTerminal: async ({ runId }) => {
        const manifest = await render(runId);
        const current = await manager.getRun(runId);
        return { title: current.preview?.title ?? "Flux candidate", summary: "Candidate preview refreshed after the terminal harness state.", artifactCount: manifest.artifacts.length, digest: manifest.previewDigest };
      },
    },
  });
  await manager.initialize();

  const currentPreview = async (runId: string, refresh: boolean): Promise<RuntimePreviewManifestBinding> => {
    const run = await manager.getRun(runId);
    if (run.preview === undefined || ["draft", "interpreting", "awaiting_clarification", "contract_ready", "preparing", "opening", "checkpointing", "queued", "running"].includes(run.phase)) throw new FluxError("ILLEGAL_TRANSITION", "Run has no current stable prepared preview authority");
    const binding = await bindingForRun(runId);
    const cached = manifests.get(runId);
    if (!refresh && cached !== undefined && cached.authorityDigest === binding.authorityDigest && cached.previewDigest === run.preview.digest) return cached;
    return render(runId);
  };

  const currentOpenedBinding = async (): Promise<Readonly<{ readonly binding: PreparedBinding; readonly ipcBinding: RuntimeOpenedIpcBinding }>> => {
    assertIpcReleaseCertain();
    const ipcBinding = openedIpcBinding;
    if (openedRunId === undefined || openedAuthorityDigest === undefined || openedProcessId === undefined || ipcBinding === undefined || editorExitedSockets.has(ipcBinding.ipcSocket) || !isPcbEditorProcessAlive(openedProcessId)) throw new FluxError("ILLEGAL_TRANSITION", "Open an isolated run in a live KiCad PCB Editor process before inspection.");
    const openedRun = await manager.getRun(openedRunId);
    if (openedRun.preview === undefined || ["draft", "interpreting", "awaiting_clarification", "contract_ready", "preparing", "awaiting_open", "opening", "checkpointing", "queued", "running"].includes(openedRun.phase)) throw new FluxError("ILLEGAL_TRANSITION", "The previously opened run no longer has current inspection authority.");
    const binding = await bindingForRun(openedRunId);
    if (binding.authorityDigest !== openedAuthorityDigest) throw new FluxError("APPROVAL_MISMATCH", "The opened project no longer matches current compilation authority.");
    await kicadMcpRuntime.assertCurrent();
    await kicadMcpRuntime.assertIpcSocket(ipcBinding.ipcSocket, ipcBinding.runBindingIdentity);
    return Object.freeze({ binding, ipcBinding });
  };

  return {
    manager,
    routes: {
      manager,
      policy,
      ports: {
        preview: { get: async (runId) => currentPreview(runId, false), refresh: async (runId) => currentPreview(runId, true) },
        inspector: {
          snapshot: async (runId) => {
            const { ipcBinding } = await currentOpenedBinding();
            if (runId !== openedRunId) throw new FluxError("APPROVAL_MISMATCH", "Inspection request does not match the opened run authority.");
            const authority = await inspectionAuthorityFor(openedRunId!, ipcBinding);
            inspectorSnapshot = inspectorSnapshot === undefined
              ? Object.freeze({ ...authority, state: "idle", busy: false, completedTools: 0, totalTools: 6 })
              : Object.freeze({ ...inspectorSnapshot, ...authority });
            return inspectorSnapshot;
          },
          inspect: async (runId, idempotencyKey) => {
            if (!/^[A-Za-z0-9._:-]{1,200}$/u.test(idempotencyKey)) throw new FluxError("INVALID_ARGUMENT", "Inspection requires one canonical idempotency key.");
            const { binding, ipcBinding } = await currentOpenedBinding();
            if (runId !== openedRunId) throw new FluxError("APPROVAL_MISMATCH", "Inspection request does not match the opened run authority.");
            const preparation = await manager.verifiedPreparation(runId);
            const inspectionRun = await manager.getRun(runId);
            const sourcePhase = (["completed", "needs_review", "blocked", "failed"] as const).includes(inspectionRun.phase as "completed" | "needs_review" | "blocked" | "failed")
              ? "post_authoring" as const
              : "pre_authoring" as const;
            if (ipcBinding.writeSessionAuthority === undefined) throw new FluxError("ILLEGAL_TRANSITION", "Checkpoint Open before requesting run-bound inspection.");
            const operationAuthorityDigest = inspectorAuthorityDigestFor(runId, binding.authorityDigest, ipcBinding as RuntimeOpenedIpcBinding & Readonly<{ readonly writeSessionAuthority: KicadMcpBoundSessionAuthority }>);
            let runOperations = inspectorOperations.get(runId);
            if (runOperations === undefined) { runOperations = new Map(); inspectorOperations.set(runId, runOperations); }
            const existing = runOperations.get(idempotencyKey);
            if (existing !== undefined) {
              if (existing.authorityDigest !== operationAuthorityDigest) throw new FluxError("APPROVAL_MISMATCH", "Inspection idempotency key belongs to different run authority.");
              return await existing.result;
            }
            if (runOperations.size >= KICAD_MCP_IPC_SOCKET_MAX_CONNECTIONS) throw new FluxError("INVALID_ARGUMENT", "Inspection idempotency history is exhausted for this run.");
            const result = (async (): Promise<FluxInspectorSnapshot> => {
              const session = await connectReadOnlyInspector(binding, ipcBinding, preparation, sourcePhase);
              let completed: FluxInspectorSnapshot | undefined;
              try {
                const inspector = new FluxInspector(session, await inspectionAuthorityFor(runId, ipcBinding));
                inspectorSnapshot = await inspector.inspect((snapshot) => { inspectorSnapshot = snapshot; });
                completed = inspectorSnapshot;
              } finally {
                try { await session.close(); }
                finally {
                  await kicadMcpRuntime.assertCurrent();
                  await kicadMcpRuntime.assertIpcSocket(ipcBinding.ipcSocket, ipcBinding.runBindingIdentity);
                  await releaseExitedIpcSocket(ipcBinding);
                }
              }
              if (editorExitedSockets.has(ipcBinding.ipcSocket) || completed === undefined) throw new FluxError("ILLEGAL_TRANSITION", "The PCB editor exited during run-bound inspection.");
              return completed;
            })();
            runOperations.set(idempotencyKey, Object.freeze({ authorityDigest: operationAuthorityDigest, result }));
            return await result;
          },
        },
      },
    },
  };
}
