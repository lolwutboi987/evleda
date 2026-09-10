import { Client, type CallToolResult, type JsonSchemaType, type RequestOptions, type Tool } from "@modelcontextprotocol/client";
import { DEFAULT_INHERITED_ENV_VARS, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { constants, type BigIntStats } from "node:fs";
import { access, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { Stream } from "node:stream";
import { finished } from "node:stream/promises";
import { bindKicadStartupEvidence, captureKicadStartupFailure, registerKicadStartupError,
  registeredKicadStartupCategory, withKicadStartupCleanup, type KicadStartupStage } from "./kicad-startup-diagnostic.js";

import { canonicalIdentity, canonicalJson, constantTimeDigestEqual, contentIdentity } from "../core/canonical.js";
import { parsePortableJsonBytes } from "../core/portable-artifact.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import {
  KICAD_PLANE_STAGE_TOOL,
  KICAD_PLANE_STAGE_TIMEOUT_MS,
  KICAD_PLANE_STAGE_ANNOTATIONS,
  KICAD_PLANE_STAGE_INPUT_JSON_SCHEMA,
  KICAD_PLANE_STAGE_OUTPUT_JSON_SCHEMA,
  kicadPlaneStageInputSchema,
  kicadPlaneStageArtifactSchema,
  readKicadPlaneStageArtifact,
  type KicadPlaneStageInput,
  type KicadPlaneStageReceipt,
} from "./kicad-plane-stage.js";

import {
  assertDisjointDirectories,
  assertPathWithin,
  isPathWithin,
  resolveConfinedCandidate,
  resolveExistingDirectory,
} from "./path-boundary.js";
import {
  ProcessTreeTerminationUnconfirmedError,
  runBoundedProcess,
  type BoundedProcessRunner,
} from "./bounded-process.js";

export const KICAD_MCP_PRO_VERSION = "3.33.3";
export const KICAD_MCP_PRO_AUDITED_COMMIT = "817969d7e302ad470c2cac3d7c20961419400c47";
export const KICAD_MCP_SERVER_NAME = "kicad-mcp-pro";
export const KICAD_MCP_SERVER_VERSION = "1.29.1";
export const KICAD_MCP_PRO_PYPI_DISTRIBUTIONS = Object.freeze([
  Object.freeze({
    filename: "kicad_mcp_pro-3.33.3-py3-none-any.whl",
    packageType: "bdist_wheel" as const,
    sizeBytes: 905_627,
    sha256: "c26f4dc6e2360375330056864490aab96f30f1d3f1c7d51bc57e42d4f9e4c26f",
    coreMetadataSha256:
      "6bd08b36cb18b43b2584e37d2c6b344254d16b72472ed9e7b5ee7993865184f2",
  }),
  Object.freeze({
    filename: "kicad_mcp_pro-3.33.3.tar.gz",
    packageType: "sdist" as const,
    sizeBytes: 757_540,
    sha256: "688e54a1f721ca0318d597564c654257dab98c06469870e8e6bb7af2612d4f76",
  }),
]);
/** Audited distribution metadata only; connect() never resolves this bare name through PATH. */
export const DEFAULT_KICAD_MCP_COMMAND = Object.freeze({
  command: "uvx",
  args: Object.freeze([
    "--from",
    `kicad-mcp-pro==${KICAD_MCP_PRO_VERSION}`,
    "kicad-mcp-pro",
  ]),
});

export const KICAD_MCP_READ_TOOL_ALLOWLIST = Object.freeze([
  "kicad_get_project_info",
  "kicad_get_version",
  "kicad_get_server_info",
  "kicad_list_tool_categories",
  "kicad_get_tools_in_category",
  "project_get_next_action",
  "project_design_workflow",
  "pcb_get_board_summary",
  // Host-only recovery read for fresh marker-bound projects.  The harness
  // projection deliberately does not make this provider-callable.
  "pcb_get_board_as_string",
  "pcb_get_design_rules",
  "pcb_get_tracks",
  "pcb_get_vias",
  "pcb_get_zones",
  "pcb_get_footprints",
  "pcb_get_stackup",
  "sch_get_symbols",
  "sch_get_connectivity_graph",
  "sch_get_bounding_boxes",
  "sch_get_pin_positions",
  "validate_design",
  "run_drc",
  "run_erc",
  "validate_footprints_vs_schematic",
  "pcb_visual_qa",
  "project_quality_gate",
  "lib_verify_component_contract",
  "sch_visual_qa",
  "lib_get_bom_with_pricing",
] as const);

export const KICAD_MCP_WRITE_TOOL_ALLOWLIST = Object.freeze([
  "kicad_set_project",
  "project_get_design_spec",
  "project_assess_edit_impact",
  "sch_plan_from_spec",
  "sch_preview_plan",
  "sch_apply_plan",
  "sch_verify_plan",
  "sch_rollback_plan",
  "sch_add_symbol",
  "sch_add_wire",
  "sch_add_label",
  "sch_add_labels",
  "sch_add_missing_junctions",
  "sch_add_power_symbol",
  "sch_add_no_connect",
  "sch_modify_property",
  "sch_autoplace_fields",
  "sch_move_symbol",
  "sch_route_wire_between_pins",
  "lib_assign_footprint",
  "pcb_begin_commit",
  "pcb_delete_items",
  "pcb_delete_object",
  "pcb_push_commit",
  "pcb_drop_commit",
  "pcb_revert",
  "pcb_set_board_outline",
  "pcb_add_text",
  "pcb_add_track",
  "pcb_add_via",
  "pcb_place_component",
  "pcb_move_component",
  "pcb_move_footprint",
  "pcb_sync_from_schematic",
  "pcb_add_zone",
  "pcb_save",
] as const);

export const KICAD_MCP_INSPECTION_TOOL_ALLOWLIST = Object.freeze([
  "pcb_get_board_summary",
  "pcb_get_design_rules",
  "pcb_get_footprints",
  "pcb_get_tracks",
  "pcb_get_vias",
  "pcb_get_zones",
] as const);

export const KICAD_MCP_INSPECTION_BRIDGE_SCHEMA_VERSION =
  "evleda.kicad-mcp-inspection-bridge.v2" as const;
export const KICAD_MCP_RUNTIME_IDENTITY_SCHEMA_VERSION =
  "evleda.kicad-mcp-runtime.v1" as const;
export const KICAD_MCP_EXECUTION_BRIDGE_SCHEMA_VERSION =
  "evleda.kicad-mcp-execution-bridge.v1" as const;
export const KICAD_MCP_RUNTIME_MANIFEST_SCHEMA_VERSION =
  "evleda.kicad-mcp-runtime-manifest.v2" as const;
export const KICAD_MCP_INSPECTION_RUNTIME_MANIFEST_SCHEMA_VERSION = KICAD_MCP_RUNTIME_MANIFEST_SCHEMA_VERSION;
export const KICAD_MCP_INSPECTION_RUNTIME_TREE_SCHEMA_VERSION =
  "evleda.kicad-mcp-inspection-runtime-tree.v1" as const;
export const KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS = 30_000;
export const KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY =
  "taskkill-tree-before-sdk-close-v1" as const;
export const KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS = 5_000;
export const KICAD_MCP_WINDOWS_PROCESS_TREE_OUTPUT_LIMIT_BYTES = 8 * 1024;
export const KICAD_MCP_IPC_SOCKET_BINDING_SCHEMA_VERSION =
  "evleda.kicad-api-socket-binding.v1" as const;
export const KICAD_MCP_IPC_SOCKET_MAX_ENDPOINT_BYTES = 128;
export const KICAD_MCP_IPC_SOCKET_MAX_CONNECTIONS = 8;
export const KICAD_MCP_SESSION_AUTHORITY_SCHEMA_VERSION =
  "evleda.kicad-mcp-session-authority.v1" as const;
export const KICAD_MCP_SESSION_RECEIPT_SCHEMA_VERSION =
  "evleda.kicad-mcp-session-receipt.v1" as const;
export const KICAD_MCP_SESSION_SEMANTIC_IDENTITY_SCHEMA_VERSION =
  "evleda.kicad-mcp-session-semantic.v1" as const;
export const KICAD_MCP_SESSION_SEMANTIC_AUTHORITY_SCHEMA_VERSION =
  "evleda.kicad-mcp-session-semantic-authority.v1" as const;

export const KICAD_MCP_FORBIDDEN_TOOL_NAMES = Object.freeze([
  "export_manufacturing_package",
  "manufacturing_quality_gate",
  "jobset_export",
  "vcs_tag_release",
] as const);

const MINIMAL_HOST_ENVIRONMENT_KEYS = Object.freeze([
  "SYSTEMROOT",
  "WINDIR",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "HOME",
] as const);

const EXTRA_ENVIRONMENT_KEYS = new Set([
  "KICAD_CONFIG_HOME",
  "KICAD10_SYMBOL_DIR",
  "KICAD10_FOOTPRINT_DIR",
  "KICAD10_3DMODEL_DIR",
  "KICAD10_TEMPLATE_DIR",
  "KICAD10_USER_TEMPLATE_DIR",
  "XDG_CACHE_HOME",
  "UV_CACHE_DIR",
  "UV_PYTHON",
  "NO_COLOR",
  "PYTHONUTF8",
  "PYTHONIOENCODING",
]);

const PATH_ARGUMENT_KEY = /(?:^|_)(?:path|file|dir|directory|root)(?:_|$)/i;
const OUTPUT_ARGUMENT_KEY = /(?:^|_)(?:output|destination|dest)(?:_|$)/i;
const WINDOWS_ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/;
const FILE_URI = /^file:/i;
const MAX_PINNED_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const SHELL_LAUNCHER_EXTENSION = /\.(?:bat|cmd)$/iu;
const SENSITIVE_OUTPUT_TEXT = /(?:\b(?:api[_ -]?(?:key|token)|access[_ -]?token|auth[_ -]?token|password|passwd|client[_ -]?secret|private[_ -]?key|credential|authorization|cookie|secret)\b\s*(?:=|:)\s*(?:"[^"\r\n]{4,}"|'[^'\r\n]{4,}'|[^\s,;]{4,})|\bBearer\s+[A-Za-z0-9._~+\/-]{4,}|\bBasic\s+[A-Za-z0-9+/=]{8,}|\bsk-[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|ORIGINAL USER REQUEST|Requested PCB work|GENERAL FRESH PCB WORKFLOW|provider (?:prompt|response))/iu;
const WINDOWS_PATH_TEXT = /(?:[A-Za-z]:[\\/]|\\\\|\/\/)[^\s"'<>]*/gu;
const FILE_URI_TEXT = /file:[^\s"'<>]*/giu;
const POSIX_PATH_TEXT = /(^|[\s"'=(])\/(?:[^\s"'<>/]+\/)+[^\s"'<>]*/gu;
const LIVE_PCB_DOCUMENT_TOOL = "evleda_get_live_pcb_document";
const LIVE_PCB_DOCUMENT_SCHEMA_VERSION = "evleda.kicad-live-pcb-document.v1";
const LIVE_PCB_PAD_SNAPSHOT_TOOL = "evleda_get_live_pcb_pad_snapshot";
const LIVE_PCB_PAD_UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const LIVE_PCB_PAD_MAX_REQUESTS = 512;
const LIVE_PCB_PAD_SNAPSHOT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    requested_primitive_ids: {
      type: "array", items: { type: "string", pattern: LIVE_PCB_PAD_UUID_PATTERN },
      minItems: 0, maxItems: LIVE_PCB_PAD_MAX_REQUESTS, uniqueItems: true,
    },
  },
  required: ["requested_primitive_ids"],
  additionalProperties: false,
} as const;
const LIVE_PCB_PAD_SNAPSHOT_ANNOTATIONS = {
  readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
} as const;
// Producer protocol v1 metadata pin; electrical payload decoding remains in
// the host pad decoder rather than a second session-layer implementation.
const LIVE_PCB_PAD_SNAPSHOT_OUTPUT_SCHEMA_SHA256 = "8dba3fcbc787eee3c32a244e6c26095678b77c0bb33e3ad5082692976a4c4260";
const SCHEMATIC_CONNECTIVITY_BATCH_TOOL = "sch_apply_connectivity_batch_v1";
const SCHEMATIC_CONNECTIVITY_BATCH_INPUT_SCHEMA_SHA256 = "b116d237b4e8bd7dce07e4147262da50a688f65e96f02a7b2b65cb4a1e3c4733";
const SCHEMATIC_CONNECTIVITY_BATCH_OUTPUT_SCHEMA_SHA256 = "30847d7283bc52bf13ae58c80e30f113d83aa0003f64e7fdba110dec4d9cb9f0";
const SCHEMATIC_CONNECTIVITY_BATCH_ANNOTATIONS = {
  readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false,
} as const;
const SCHEMATIC_CONNECTIVITY_BATCH_MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const NATIVE_COMMIT_META_KEY = "evledaNativeCommitLifecycle";
const QUALIFIED_FOOTPRINT_SYNC_META_KEY = "evledaQualifiedFootprintIdentitySync";
const QUALIFIED_FOOTPRINT_SYNC_SCHEMA_VERSION = "evleda.kicad-qualified-footprint-identity-sync.v1";
// Actual DOC6 KiCadFastMCP Tool, normalized by the pinned Node MCP SDK.
const QUALIFIED_FOOTPRINT_SYNC_TOOL_SHA256 = "4cd5981b622b80ff90341b67ebe08fea9c8e317d41530fe496583eed2d38a2b3";
const NATIVE_COMMIT_SCHEMA_VERSION = "evleda.kicad-native-commit-lifecycle.v1";
const NATIVE_COMMIT_TOOL_NAMES = ["pcb_begin_commit", "pcb_push_commit", "pcb_drop_commit"] as const;
// Actual KiCadFastMCP DOC5 descriptors as parsed by the pinned Node MCP SDK.
// Its Tool schema drops the nonstandard requiresKiCadRunning annotation.
// DOC3/DOC4 name-only declarations discard the native Commit and do not qualify.
const NATIVE_COMMIT_TOOL_SHA256: Readonly<Record<string, string>> = Object.freeze({
  pcb_begin_commit: "13993bfd2681b3c8e06de22dee63b65dabd2433960696429c296b66a57fbfe64",
  pcb_push_commit: "5f8f87a7fdf69b8be23b6a15e75f71321fd4f591072a3c14a4b64e62415b9249",
  pcb_drop_commit: "14502d71fe532b7061112ee94f0d50387b7bed8c458a919fa74fe53f8edd3bbd",
});
const NATIVE_COMMIT_REPLIES: Readonly<Record<string, string>> = Object.freeze({
  pcb_begin_commit: "Transaction group started. Use pcb_push_commit to apply or pcb_drop_commit to discard.",
  pcb_push_commit: "Transaction group committed successfully.",
  pcb_drop_commit: "Transaction group discarded successfully.",
});

export type KicadMcpOperatingMode = "readonly" | "write";

export interface KicadMcpCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export interface KicadMcpFilesystemWitness {
  readonly device: string;
  readonly inode: string;
  readonly sizeBytes: number;
  readonly modifiedNs: string;
  readonly changedNs: string;
  readonly createdNs: string;
  readonly mode: string;
  readonly linkCount: number;
}

/** Private launch input. The raw path is never included in a session/report identity. */
export interface KicadMcpExpectedExecutableIdentity {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly filesystem: KicadMcpFilesystemWitness;
}

export interface KicadMcpSessionOptions {
  readonly workspaceRoot: string;
  readonly projectRoot: string;
  readonly outputRoot?: string;
  readonly launchCwd?: string;
  /** Manifest bridge bootstrap: select the project only through a host-only tool after initialization. */
  readonly deferProjectBinding?: boolean;
  readonly mode?: KicadMcpOperatingMode;
  readonly isolatedWorkingCopy?: {
    readonly canonicalProjectRoot: string;
  };
  /** A CLI-verified, marker-hashed empty project. Cannot be combined with a copied source. */
  readonly freshProject?: boolean;
  readonly command?: KicadMcpCommand;
  /** Required by connect(); optional in the type only for injected test session factories. */
  readonly expectedLauncherIdentity?: KicadMcpExpectedExecutableIdentity;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly extraEnvironment?: Readonly<Record<string, string>>;
  readonly kicadCliPath?: string;
  readonly expectedKicadCliIdentity?: KicadMcpExpectedExecutableIdentity;
  /** Deterministic probe seam. Production must omit it. */
  readonly processRunnerForTesting?: BoundedProcessRunner;
  readonly readToolAllowlist?: readonly string[];
  readonly writeToolAllowlist?: readonly string[];
  /** Required only by callers that need a specific provider capability surface. */
  readonly requiredTools?: readonly string[];
  readonly timeoutMs?: number;
  readonly maxMessageBytes?: number;
  readonly maxStderrBytes?: number;
  readonly maxToolPages?: number;
  readonly maxTools?: number;
  readonly signal?: AbortSignal;
  /**
   * Closed Windows process-tree supervision for the production inspection bridge.
   * The taskkill path is derived from the minimal SYSTEMROOT/WINDIR environment;
   * callers may pin its bytes, but may not choose another helper path.
   */
  readonly processTreeSupervision?: {
    readonly strategy: typeof KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY;
    readonly terminator: KicadMcpExpectedExecutableIdentity;
    readonly timeoutMs: typeof KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS;
    /** Deterministic teardown seam. Production must omit it. */
    readonly processRunnerForTesting?: BoundedProcessRunner;
    /** Deterministic pre-proof scheduling seam. Production must omit it. */
    readonly beforeFinalRootProofForTesting?: () => Promise<void>;
  };
  /** Exact bridge-owned KiCad IPC endpoint; never reconstructed from TEMP. */
  readonly ipcSocket?: KicadMcpInspectionIpcSocketBinding;
  /** Path-free authority produced by the manifest-bound bridge. */
  readonly sessionAuthorityIdentity?: CanonicalIdentity;
  /** Stable mode/socket/run/root/tool authority; excludes per-connect allocation. */
  readonly sessionSemanticAuthorityIdentity?: CanonicalIdentity;
  /** Private bridge check executed synchronously immediately before stdio spawn. */
  readonly assertLaunchAuthority?: () => void;
  /** Host-private progress for preserving the active stage if an outer deadline fires. */
  readonly observeStartupStage?: (stage: KicadStartupStage) => void;
}

export interface KicadMcpLauncherIdentity {
  readonly pathIdentity: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface KicadMcpToolDiscoveryIdentity {
  readonly pageCount: number;
  readonly toolCount: number;
  readonly pageCursorIdentities: readonly (string | null)[];
}

export interface KicadMcpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly permission: "read" | "write";
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
}

export interface KicadMcpSessionIdentity {
  readonly sessionSemanticIdentity: CanonicalIdentity;
  readonly sessionReceiptIdentity: CanonicalIdentity;
  readonly sidecar: {
    readonly distribution: "kicad-mcp-pro";
    readonly version: string;
    readonly auditedCommit: string;
    readonly publishedDistributionSha256: readonly string[];
  };
  readonly launch: {
    readonly schemaVersion: "evleda.kicad-mcp-launch.v1";
    readonly transport: "stdio";
    readonly profile: "full";
    readonly mode: KicadMcpOperatingMode;
    readonly launcherPathIdentity: string;
    readonly argumentsSha256: string;
    readonly argumentCount: number;
    readonly workingDirectoryPathIdentity: string;
    readonly projectBinding: "launch-argument" | "post-connect-protocol";
    readonly rootProcessIncarnationIdentity: CanonicalIdentity;
    readonly processTreeSupervision: {
      readonly strategy: "sdk-root-only" | typeof KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY;
      readonly terminator: KicadMcpLauncherIdentity | null;
      readonly timeoutMs: number;
      readonly rootExitBeforeTermination: "unconfirmed";
      readonly runtimeCleanup: "caller-owned-after-confirmation";
    };
    readonly ipcSocketIdentity: CanonicalIdentity | null;
    readonly sessionAuthorityIdentity: CanonicalIdentity | null;
    readonly sessionSemanticAuthorityIdentity: CanonicalIdentity | null;
  };
  readonly launcher: KicadMcpLauncherIdentity;
  readonly toolDiscovery: KicadMcpToolDiscoveryIdentity;
  readonly pid: number | null;
  readonly server: {
    readonly name: typeof KICAD_MCP_SERVER_NAME;
    readonly version: typeof KICAD_MCP_SERVER_VERSION;
    readonly authenticated: true;
  } | null;
  readonly mode: KicadMcpOperatingMode;
  readonly roots: {
    readonly workspacePathIdentity: string;
    readonly projectPathIdentity: string;
    readonly outputPathIdentity: string;
  };
}

export interface KicadMcpToolCallOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export class KicadMcpSessionError extends Error {
  override readonly name: string = "KicadMcpSessionError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    registerKicadStartupError(this, "kicad-session");
  }
}

export class KicadMcpAuthorizationError extends KicadMcpSessionError {
  override readonly name = "KicadMcpAuthorizationError";
  constructor(message: string, options?: ErrorOptions) { super(message, options); registerKicadStartupError(this, "kicad-authorization"); }
}

export class KicadPlaneStageMayHaveMutatedError extends KicadMcpSessionError {
  override readonly name = "KicadPlaneStageMayHaveMutatedError";
  readonly mayHaveMutated = true;
  readonly writesQuarantined = true;

  constructor(options?: ErrorOptions) {
    super("PLANE_STAGE_MAY_HAVE_MUTATED: Plane staging did not yield a complete bounded host-readable receipt. Further writes are quarantined; reads, host PCB revert, and explicit close remain available for recovery.", options);
  }
}

export class KicadNativeRouteRecoveryRequiredError extends KicadMcpSessionError {
  override readonly name = "KicadNativeRouteRecoveryRequiredError";
  readonly mayHaveMutated = true;
  readonly writesQuarantined = true;

  constructor(readonly operation: string, cause: unknown) {
    super(`NATIVE_ROUTE_RECOVERY_REQUIRED: ${operation} failed during a host native route transaction. Further edits are quarantined; checked reads, transaction drop, PCB revert, and explicit close remain available.`, { cause });
  }
}

export class KicadMcpOutputError extends KicadMcpSessionError {
  override readonly name = "KicadMcpOutputError";
  constructor(message: string, options?: ErrorOptions) { super(message, options); registerKicadStartupError(this, "kicad-output"); }
}

export class KicadMcpOutputLimitError extends KicadMcpSessionError {
  override readonly name = "KicadMcpOutputLimitError";
  readonly limitBytes: number;
  readonly seenBytes: number;

  constructor(limitBytes: number, seenBytes: number) {
    super(`KiCad MCP stderr exceeded its ${limitBytes}-byte limit (${seenBytes} bytes observed).`);
    this.limitBytes = limitBytes;
    this.seenBytes = seenBytes;
    registerKicadStartupError(this, "kicad-output-limit");
  }
}

export class KicadMcpTerminationUncertainError extends KicadMcpSessionError {
  override readonly name: string = "KicadMcpTerminationUncertainError";
  readonly retainRuntimeDirectory = true;
  constructor(message: string, options?: ErrorOptions) { super(message, options); registerKicadStartupError(this, "kicad-termination-uncertain"); }
}

export class KicadMcpRuntimeVerificationDeadlineError extends KicadMcpTerminationUncertainError {
  override readonly name = "KicadMcpRuntimeVerificationDeadlineError";
  constructor(readonly reason: "deadline" | "aborted") {
    super(reason === "aborted"
      ? "KiCad MCP runtime verification was aborted before it could be confirmed."
      : "KiCad MCP runtime verification exceeded its absolute deadline.");
    registerKicadStartupError(this, "kicad-verification-deadline");
  }
}

const processIsAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
};

const waitForProcessExit = async (pid: number, timeoutMs = 750): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return true;
};

interface BoundWindowsProcessTreeSupervision {
  readonly strategy: typeof KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY;
  readonly terminator: KicadMcpExpectedExecutableIdentity;
  readonly timeoutMs: typeof KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS;
  readonly environment: Readonly<Record<string, string>>;
  readonly processRunner: BoundedProcessRunner;
  readonly beforeFinalRootProofForTesting: (() => Promise<void>) | undefined;
}

export interface KicadMcpRuntimeVerificationHooks {
  readonly now?: () => number;
  readonly beforeOperation?: (label: string) => Promise<void>;
  readonly operationForTesting?: (label: string, operation: () => Promise<unknown>) => Promise<unknown>;
  readonly deadlineMsForTesting?: number;
}

export interface KicadMcpRuntimeOperationContext {
  /** Absolute monotonic deadline in the current process's performance.now() domain. */
  readonly deadlineAtMs?: number;
  readonly signal?: AbortSignal;
}

interface InspectionDeadline {
  readonly deadlineAtMs: number;
  readonly signal: AbortSignal | undefined;
  readonly hooks: KicadMcpRuntimeVerificationHooks | undefined;
}

const inspectionNow = (hooks?: KicadMcpRuntimeVerificationHooks): number => hooks?.now?.() ?? performance.now();

function createInspectionDeadline(
  operation: KicadMcpRuntimeOperationContext | undefined,
  hooks?: KicadMcpRuntimeVerificationHooks,
): InspectionDeadline {
  const now = inspectionNow(hooks);
  const testWindow = hooks?.deadlineMsForTesting;
  if (testWindow !== undefined && (!Number.isSafeInteger(testWindow) || testWindow < 1 || testWindow > 5_000)) {
    throw new KicadMcpSessionError("KiCad MCP test verification deadline is invalid.");
  }
  if (operation?.deadlineAtMs !== undefined
      && (!Number.isFinite(operation.deadlineAtMs) || operation.deadlineAtMs < 0)) {
    throw new KicadMcpSessionError("KiCad MCP runtime operation deadline is invalid.");
  }
  return Object.freeze({
    deadlineAtMs: Math.min(
      now + (testWindow ?? KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS),
      operation?.deadlineAtMs ?? Number.POSITIVE_INFINITY,
    ),
    signal: operation?.signal,
    hooks,
  });
}

function assertInspectionDeadline(deadline: InspectionDeadline): void {
  if (deadline.signal?.aborted) throw new KicadMcpRuntimeVerificationDeadlineError("aborted");
  if (inspectionNow(deadline.hooks) >= deadline.deadlineAtMs) {
    throw new KicadMcpRuntimeVerificationDeadlineError("deadline");
  }
}

async function withinInspectionDeadline<T>(
  operation: () => Promise<T>,
  deadline: InspectionDeadline | undefined,
  label: string,
  disposeLateResult?: (value: T) => Promise<void> | void,
  cancel?: () => void,
): Promise<T> {
  if (deadline === undefined) return await operation();
  const runBounded = async <R>(factory: () => Promise<R>): Promise<R> => {
    assertInspectionDeadline(deadline);
    const remaining = deadline.deadlineAtMs - inspectionNow(deadline.hooks);
    let promise: Promise<R>;
    try { promise = factory(); }
    catch (error) { throw error; }
    let timer: NodeJS.Timeout | undefined;
    let aborted = false;
    let rejectAbort!: (error: KicadMcpRuntimeVerificationDeadlineError) => void;
    const abort = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = (): void => {
      aborted = true;
      cancel?.();
      rejectAbort(new KicadMcpRuntimeVerificationDeadlineError("aborted"));
    };
    if (deadline.signal?.aborted) onAbort();
    else deadline.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        cancel?.();
        reject(new KicadMcpRuntimeVerificationDeadlineError("deadline"));
      }, Math.max(1, remaining));
    });
    try { return await Promise.race([promise, timeout, abort]); }
    finally {
      if (timer !== undefined) clearTimeout(timer);
      deadline.signal?.removeEventListener("abort", onAbort);
      if (aborted) cancel?.();
    }
  };
  if (deadline.hooks?.beforeOperation !== undefined) {
    await runBounded(async () => await deadline.hooks!.beforeOperation!(label));
  }
  let promise: Promise<T> | undefined;
  try {
    return await runBounded(() => {
      promise = deadline.hooks?.operationForTesting === undefined
        ? operation()
        : deadline.hooks.operationForTesting(label, operation) as Promise<T>;
      return promise;
    });
  } catch (error) {
    if (disposeLateResult !== undefined && promise !== undefined) {
      void promise.then(async (value) => await disposeLateResult(value), () => undefined);
    }
    throw error;
  }
}

function valueForEnvironmentKey(
  environment: Readonly<Record<string, string | undefined>>,
  requestedKey: string,
): string | undefined {
  const exact = environment[requestedKey];
  if (exact !== undefined) return exact;
  if (process.platform !== "win32") return undefined;
  const entry = Object.entries(environment).find(
    ([key]) => key.toLocaleLowerCase("en-US") === requestedKey.toLocaleLowerCase("en-US"),
  );
  return entry?.[1];
}

const pathIdentity = (value: string): string => createHash("sha256")
  .update("evleda.kicad-mcp-path.v1\0", "utf8")
  .update(process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value, "utf8")
  .digest("hex");

const sameCanonicalPath = (left: string, right: string): boolean => {
  const normalize = (value: string) => process.platform === "win32"
    ? path.resolve(value).toLocaleLowerCase("en-US")
    : path.resolve(value);
  return normalize(left) === normalize(right);
};

async function assertCanonicalAncestorChain(
  candidate: string,
  label: string,
  deadline?: InspectionDeadline,
): Promise<void> {
  const resolved = path.resolve(candidate);
  const parsed = path.parse(resolved);
  const components = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let cursor = parsed.root;
  for (const component of components) {
    cursor = path.join(cursor, component);
    let metadata: BigIntStats;
    let canonical: string;
    try {
      metadata = await withinInspectionDeadline(
        async () => await lstat(cursor, { bigint: true }), deadline, `${label}:ancestor-stat`,
      );
      canonical = await withinInspectionDeadline(
        async () => await realpath(cursor), deadline, `${label}:ancestor-realpath`,
      );
    } catch (error) {
      if (error instanceof KicadMcpRuntimeVerificationDeadlineError) throw error;
      throw new KicadMcpSessionError(`${label} ancestor chain is unavailable.`);
    }
    if (metadata.isSymbolicLink() || !sameCanonicalPath(cursor, canonical)) {
      throw new KicadMcpSessionError(`${label} ancestor chain contains an alias or reparse point.`);
    }
  }
}

const argumentIdentity = (args: readonly string[]): string => createHash("sha256")
  .update("evleda.kicad-mcp-arguments.v1\0", "utf8")
  .update(JSON.stringify(args), "utf8")
  .digest("hex");

const witnessFor = (metadata: BigIntStats): KicadMcpFilesystemWitness => ({
  device: metadata.dev.toString(10),
  inode: metadata.ino.toString(10),
  sizeBytes: Number(metadata.size),
  modifiedNs: metadata.mtimeNs.toString(10),
  changedNs: metadata.ctimeNs.toString(10),
  createdNs: metadata.birthtimeNs.toString(10),
  mode: metadata.mode.toString(10),
  linkCount: Number(metadata.nlink),
});

const sameWitness = (left: KicadMcpFilesystemWitness, right: KicadMcpFilesystemWitness): boolean =>
  left.device === right.device
  && left.inode === right.inode
  && left.sizeBytes === right.sizeBytes
  && left.modifiedNs === right.modifiedNs
  && left.changedNs === right.changedNs
  && left.createdNs === right.createdNs
  && left.mode === right.mode
  && left.linkCount === right.linkCount;

const validWitness = (value: unknown): value is KicadMcpFilesystemWitness => {
  if (!isPlainRecord(value)) return false;
  return [value.device, value.inode, value.modifiedNs, value.changedNs, value.createdNs, value.mode]
    .every((entry) => typeof entry === "string" && /^\d+$/u.test(entry))
    && Number.isSafeInteger(value.sizeBytes) && (value.sizeBytes as number) > 0
    && value.linkCount === 1;
};

function rejectShellLauncher(filePath: string): void {
  if (SHELL_LAUNCHER_EXTENSION.test(filePath)) {
    throw new KicadMcpSessionError("KiCad MCP launchers must be native executables; shell .bat/.cmd fallbacks are forbidden.");
  }
}

async function captureExecutableIdentity(
  filePath: string,
  label: string,
  deadline?: InspectionDeadline,
): Promise<KicadMcpExpectedExecutableIdentity> {
  if (!path.isAbsolute(filePath) || /[\0\r\n]/u.test(filePath)) {
    throw new KicadMcpSessionError(`${label} must be one explicit absolute executable path.`);
  }
  rejectShellLauncher(filePath);
  const captured = await captureRegularFileIdentity(
    filePath,
    label,
    MAX_PINNED_EXECUTABLE_BYTES,
    deadline,
  );
  if (captured.sizeBytes <= 0) {
    throw new KicadMcpSessionError(`${label} has an invalid executable-file identity.`);
  }
  try {
    await withinInspectionDeadline(
      async () => await access(captured.path, constants.X_OK),
      deadline,
      `${label}:executable-access`,
    );
  } catch (error) {
    if (error instanceof KicadMcpRuntimeVerificationDeadlineError) throw error;
    throw new KicadMcpSessionError(`${label} is not an executable regular non-link file.`);
  }
  return captured;
}

/** Capture a one-run physical and byte pin. Callers must additionally compare it with their durable profile. */
export async function createKicadMcpExpectedExecutableIdentity(
  filePath: string,
): Promise<KicadMcpExpectedExecutableIdentity> {
  return await captureExecutableIdentity(filePath, "Pinned KiCad executable");
}

function validateExpectedExecutableIdentity(
  actual: KicadMcpExpectedExecutableIdentity,
  expected: KicadMcpExpectedExecutableIdentity | undefined,
  label: string,
): void {
  if (expected === undefined) throw new KicadMcpSessionError(`${label} requires an explicit expected path and byte identity.`);
  if (!path.isAbsolute(expected.path) || SHELL_LAUNCHER_EXTENSION.test(expected.path)
      || !/^[0-9a-f]{64}$/iu.test(expected.sha256)
      || !Number.isSafeInteger(expected.sizeBytes) || expected.sizeBytes <= 0
      || !validWitness(expected.filesystem)
      || !sameWitness(expected.filesystem, actual.filesystem)) {
    throw new KicadMcpSessionError(`${label} has an invalid or changed expected executable identity.`);
  }
  const expectedPath = process.platform === "win32" ? expected.path.toLocaleLowerCase("en-US") : expected.path;
  const actualPath = process.platform === "win32" ? actual.path.toLocaleLowerCase("en-US") : actual.path;
  if (path.resolve(expectedPath) !== path.resolve(actualPath)
      || actual.sha256.toLocaleLowerCase("en-US") !== expected.sha256.toLocaleLowerCase("en-US")
      || actual.sizeBytes !== expected.sizeBytes) {
    throw new KicadMcpSessionError(`${label} does not match its expected path and byte identity.`);
  }
}

async function resolvePinnedExecutable(
  command: string,
  expected: KicadMcpExpectedExecutableIdentity | undefined,
  label: string,
): Promise<KicadMcpExpectedExecutableIdentity> {
  const actual = await captureExecutableIdentity(command, label);
  validateExpectedExecutableIdentity(actual, expected, label);
  return actual;
}

async function assertExecutableIdentity(
  expected: KicadMcpExpectedExecutableIdentity,
  label: string,
  deadline?: InspectionDeadline,
): Promise<void> {
  const actual = await captureExecutableIdentity(expected.path, label, deadline);
  validateExpectedExecutableIdentity(actual, expected, label);
}

async function bindWindowsProcessTreeSupervision(
  input: KicadMcpSessionOptions["processTreeSupervision"],
  sourceEnvironment: Readonly<Record<string, string | undefined>>,
): Promise<BoundWindowsProcessTreeSupervision | undefined> {
  if (input === undefined) return undefined;
  if (process.platform !== "win32"
      || input.strategy !== KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY
      || input.timeoutMs !== KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS) {
    throw new KicadMcpSessionError("KiCad MCP process-tree supervision does not match the fixed Windows production policy.");
  }
  const systemRoot = valueForEnvironmentKey(sourceEnvironment, "SYSTEMROOT");
  const windowsDirectory = valueForEnvironmentKey(sourceEnvironment, "WINDIR");
  if (systemRoot === undefined || windowsDirectory === undefined
      || !path.isAbsolute(systemRoot) || !path.isAbsolute(windowsDirectory)
      || /[\0\r\n]/u.test(systemRoot) || /[\0\r\n]/u.test(windowsDirectory)
      || !sameCanonicalPath(systemRoot, windowsDirectory)) {
    throw new KicadMcpSessionError("KiCad MCP process-tree supervision requires one exact SYSTEMROOT/WINDIR authority.");
  }
  const canonicalSystemRoot = await realpath(systemRoot);
  const canonicalWindowsDirectory = await realpath(windowsDirectory);
  if (!sameCanonicalPath(canonicalSystemRoot, canonicalWindowsDirectory)) {
    throw new KicadMcpSessionError("KiCad MCP SYSTEMROOT/WINDIR canonical authorities differ.");
  }
  const terminator = await resolvePinnedExecutable(
    input.terminator.path,
    input.terminator,
    "KiCad MCP process-tree terminator",
  );
  return Object.freeze({
    strategy: KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY,
    terminator,
    timeoutMs: KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
    environment: Object.freeze({ SYSTEMROOT: canonicalSystemRoot, WINDIR: canonicalSystemRoot }),
    processRunner: input.processRunnerForTesting ?? runPinnedTreeTerminator,
    beforeFinalRootProofForTesting: input.beforeFinalRootProofForTesting,
  });
}

const runPinnedTreeTerminator: BoundedProcessRunner = async (options) => {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  return await new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(options.command, [...options.args], {
        cwd: options.cwd,
        env: { ...options.env },
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      reject(new KicadMcpTerminationUncertainError("Pinned KiCad MCP tree terminator could not be spawned."));
      return;
    }
    let settled = false;
    let timedOut = false;
    let confirmationTimer: NodeJS.Timeout | undefined;
    const finish = (error?: KicadMcpTerminationUncertainError, exitCode?: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (confirmationTimer !== undefined) clearTimeout(confirmationTimer);
      if (error !== undefined || exitCode === undefined) {
        child.unref();
        reject(error ?? new KicadMcpTerminationUncertainError("Pinned KiCad MCP tree terminator has no exit evidence."));
      } else {
        resolve({
          command: options.command,
          args: [...options.args],
          cwd: options.cwd,
          exitCode,
          stdout: "",
          stderr: "",
          durationMs: Math.round((performance.now() - started) * 1000) / 1000,
          startedAt,
        });
      }
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      // This is the exact ChildProcess handle for the already-pinned helper;
      // there is no secondary taskkill/PATH/shell fallback.
      try { child.kill("SIGKILL"); } catch { /* confirmation below remains uncertain */ }
      confirmationTimer = setTimeout(() => finish(new KicadMcpTerminationUncertainError(
        "Pinned KiCad MCP tree terminator did not settle after its deadline.",
      )), 500);
    }, options.timeoutMs);
    child.once("error", () => finish(new KicadMcpTerminationUncertainError("Pinned KiCad MCP tree terminator failed.")));
    child.once("close", (code) => {
      if (timedOut) {
        finish(new KicadMcpTerminationUncertainError("Pinned KiCad MCP tree terminator exceeded its deadline."));
        return;
      }
      if (code === null) finish(new KicadMcpTerminationUncertainError("Pinned KiCad MCP tree terminator ended without an exit code."));
      else finish(undefined, code);
    });
  });
};

function startBoundWindowsProcessTreeTermination(
  supervision: BoundWindowsProcessTreeSupervision,
  pid: number,
  workingDirectory: string,
): Promise<void> {
  // Deliberately invoke the already-pinned runner synchronously.  The caller
  // performs the handle-bound root proof immediately before this call, so
  // there is no awaited pathname work in the PID-use window.
  const completion = (() => {
    try {
      return supervision.processRunner({
      command: supervision.terminator.path,
      args: ["/PID", String(pid), "/T", "/F"],
      cwd: workingDirectory,
      env: supervision.environment,
      timeoutMs: supervision.timeoutMs,
      maxOutputBytes: KICAD_MCP_WINDOWS_PROCESS_TREE_OUTPUT_LIMIT_BYTES,
      });
    } catch {
      return Promise.reject(new KicadMcpTerminationUncertainError("KiCad MCP process-tree terminator did not start with closed evidence."));
    }
  })();
  return (async () => {
    let result: Awaited<ReturnType<BoundedProcessRunner>>;
    let timer: NodeJS.Timeout | undefined;
    try {
      result = await Promise.race([
        completion,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new KicadMcpTerminationUncertainError(
            "KiCad MCP process-tree terminator exceeded its fixed deadline.",
          )), supervision.timeoutMs);
        }),
      ]);
    } catch {
      throw new KicadMcpTerminationUncertainError("KiCad MCP process-tree terminator did not complete with closed evidence.");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    await assertExecutableIdentity(supervision.terminator, "KiCad MCP process-tree terminator");
    if (result.exitCode !== 0) {
      throw new KicadMcpTerminationUncertainError("KiCad MCP process-tree terminator reported categorical failure.");
    }
  })();
}

const publicExecutableIdentity = (value: KicadMcpExpectedExecutableIdentity): KicadMcpLauncherIdentity => Object.freeze({
  pathIdentity: pathIdentity(value.path),
  sha256: value.sha256,
  sizeBytes: value.sizeBytes,
});

function minimalHostEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  maskTransportDefaults = false,
): Record<string, string> {
  // The upstream transport always merges a default inherited set. Explicitly
  // mask every such key first, then restore only this controller's narrow set.
  const result: Record<string, string> = maskTransportDefaults
    ? Object.fromEntries(DEFAULT_INHERITED_ENV_VARS.map((key) => [key, ""]))
    : {};
  for (const key of MINIMAL_HOST_ENVIRONMENT_KEYS) {
    const value = valueForEnvironmentKey(source, key);
    if (value === undefined || value === "") continue;
    if (/[\0\r\n]/u.test(value)) throw new KicadMcpSessionError("A required host runtime environment value contains controls.");
    result[key] = value;
  }
  return result;
}

function validateCommand(command: KicadMcpCommand): void {
  if (!command.command.trim() || /[\0\r\n]/.test(command.command)) {
    throw new KicadMcpSessionError("KiCad MCP command must be non-empty and contain no controls.");
  }
  if (command.args.some((argument) => /[\0\r\n]/.test(argument))) {
    throw new KicadMcpSessionError("KiCad MCP command arguments must contain no controls.");
  }
}

/**
 * The provider's profile is deliberately fixed by the controller.  In
 * particular, do not let a launcher argument silently select the upstream
 * default/review profile: the catalog is filtered here, after discovery.
 */
function sidecarLaunchCommand(
  command: KicadMcpCommand,
  mode: KicadMcpOperatingMode,
  projectRoot: string,
  deferProjectBinding: boolean,
): KicadMcpCommand {
  const policyArguments = new Set(["--profile", "--mode", "--project-dir"]);
  if (command.args.some((argument) => policyArguments.has(argument))) {
    throw new KicadMcpAuthorizationError(
      "KiCad MCP profile, mode, and project directory are controller-managed launch options.",
    );
  }
  return {
    command: command.command,
    args: [
      ...command.args,
      "--profile", "full", "--mode", mode,
      ...(deferProjectBinding ? [] : ["--project-dir", projectRoot]),
    ],
  };
}

function assertRequiredTools(
  requiredTools: readonly string[] | undefined,
  toolsByName: ReadonlyMap<string, Tool>,
  mode: KicadMcpOperatingMode,
  readAllowlist: ReadonlySet<string>,
  writeAllowlist: ReadonlySet<string>,
): void {
  if (requiredTools === undefined) return;
  const missing = [...new Set(requiredTools)].flatMap((name) => {
    if (isForbiddenTool(name)) return [`${name} (permanently forbidden)`];
    if (!toolsByName.has(name)) return [`${name} (not advertised)`];
    if (mode === "write" && (name === LIVE_PCB_DOCUMENT_TOOL || name === LIVE_PCB_PAD_SNAPSHOT_TOOL || name === SCHEMATIC_CONNECTIVITY_BATCH_TOOL || name === KICAD_PLANE_STAGE_TOOL)) return [];
    if (readAllowlist.has(name) || (mode === "write" && writeAllowlist.has(name))) return [];
    return [`${name} (not in the ${mode} capability allowlist)`];
  });
  if (missing.length > 0) {
    throw new KicadMcpAuthorizationError(
      `Required KiCad MCP capability/allowlist mismatch in ${mode} mode: ${missing.join(", ")}.`,
    );
  }
}

async function kicad10RuntimeBinding(
  kicadCliPath: string,
  expected: KicadMcpExpectedExecutableIdentity | undefined,
  sourceEnvironment: Readonly<Record<string, string | undefined>>,
  runner: BoundedProcessRunner,
): Promise<Readonly<Record<string, string>>> {
  const executable = await resolvePinnedExecutable(kicadCliPath, expected, "KiCad CLI executable");
  const installRoot = path.dirname(path.dirname(executable.path));
  let shareRoot: string;
  let symbols: string;
  let footprints: string;
  let templates: string;
  try {
    shareRoot = await resolveExistingDirectory(path.join(installRoot, "share", "kicad"), "KiCad share directory");
    symbols = await resolveExistingDirectory(path.join(shareRoot, "symbols"), "KiCad symbol library directory");
    footprints = await resolveExistingDirectory(path.join(shareRoot, "footprints"), "KiCad footprint library directory");
    templates = await resolveExistingDirectory(path.join(shareRoot, "template"), "KiCad template directory");
  } catch (error) {
    const diagnostic = captureKicadStartupFailure(error, "cli-library-layout");
    throw bindKicadStartupEvidence(new KicadMcpSessionError("The pinned KiCad CLI installation has an incomplete runtime layout.", { cause: diagnostic }), diagnostic);
  }
  const probeEnvironment = minimalHostEnvironment(sourceEnvironment);
  probeEnvironment.NO_COLOR = "1";
  probeEnvironment.LANG = "C";
  probeEnvironment.LANGUAGE = "C";
  probeEnvironment.LC_ALL = "C";
  let result;
  try {
    result = await runner({
      command: executable.path,
      args: ["version"],
      cwd: installRoot,
      env: probeEnvironment,
      timeoutMs: 5_000,
      maxOutputBytes: 16 * 1024,
    });
  } catch (error) {
    const diagnostic = captureKicadStartupFailure(error, "cli-version-probe");
    if (error instanceof ProcessTreeTerminationUnconfirmedError) {
      throw bindKicadStartupEvidence(new KicadMcpTerminationUncertainError("The pinned KiCad CLI probe process tree could not be confirmed terminated.", { cause: diagnostic }), diagnostic);
    }
    throw bindKicadStartupEvidence(new KicadMcpSessionError("The pinned KiCad CLI version probe did not complete safely.", { cause: diagnostic }), diagnostic);
  }
  await assertExecutableIdentity(executable, "KiCad CLI executable");
  if (result.exitCode !== 0 || result.stderr !== "" || !/^10\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?(?:\r?\n)?$/u.test(result.stdout)) {
    const error = new KicadMcpSessionError("The pinned KiCad CLI version probe returned unsupported categorical evidence.");
    Object.defineProperty(error, "exitCode", { value: result.exitCode });
    const diagnostic = captureKicadStartupFailure(error, "cli-version-probe", { category: result.stderr === "" ? "empty" : "present", truncated: false, seenBytes: Buffer.byteLength(result.stderr) });
    throw bindKicadStartupEvidence(error, diagnostic);
  }
  return Object.freeze({ cli: executable.path, bin: path.dirname(executable.path), symbols, footprints, templates });
}

function validatePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new KicadMcpSessionError(`${label} must be a positive integer.`);
  }
  return value;
}

function validateBoundedPositiveInteger(
  value: number,
  label: string,
  maximum: number,
): number {
  validatePositiveInteger(value, label);
  if (value > maximum) {
    throw new KicadMcpSessionError(`${label} must not exceed ${maximum}.`);
  }
  return value;
}

function narrowAllowlist(
  requested: readonly string[] | undefined,
  builtIn: readonly string[],
  label: string,
): ReadonlySet<string> {
  const builtInSet = new Set(builtIn);
  const selected = requested === undefined ? builtIn : requested;
  for (const name of selected) {
    if (!builtInSet.has(name)) {
      throw new KicadMcpAuthorizationError(`${label} cannot add unreviewed tool '${name}'.`);
    }
  }
  return new Set(selected);
}

function isForbiddenTool(name: string): boolean {
  const normalized = name.toLocaleLowerCase("en-US");
  return (
    KICAD_MCP_FORBIDDEN_TOOL_NAMES.includes(
      normalized as (typeof KICAD_MCP_FORBIDDEN_TOOL_NAMES)[number],
    ) ||
    normalized.startsWith("export_") ||
    normalized.startsWith("variant_export_") ||
    normalized.startsWith("mfg_") ||
    normalized.includes("manufactur") ||
    normalized.includes("release")
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function validCanonicalIdentityForSchema(value: unknown, schemaVersion?: string): value is CanonicalIdentity {
  if (!isPlainRecord(value) || Object.keys(value).sort().join("\0")
      !== ["algorithm", "canonicalizationVersion", "digest", "schemaVersion"].sort().join("\0")) return false;
  return value.algorithm === "sha256"
    && typeof value.digest === "string" && /^[a-f0-9]{64}$/u.test(value.digest)
    && typeof value.schemaVersion === "string" && value.schemaVersion.length >= 1 && value.schemaVersion.length <= 128
    && (schemaVersion === undefined || value.schemaVersion === schemaVersion)
    && value.canonicalizationVersion === "evleda-c14n-json-v1";
}

function validateIpcSocketBindingShape(binding: KicadMcpInspectionIpcSocketBinding): string {
  if (!isPlainRecord(binding) || Object.keys(binding).sort().join("\0") !== ["endpoint", "identity"].sort().join("\0")
      || typeof binding.endpoint !== "string" || !binding.endpoint.startsWith("ipc://")
      || /[\0\r\n]/u.test(binding.endpoint)
      || Buffer.byteLength(binding.endpoint, "utf8") > KICAD_MCP_IPC_SOCKET_MAX_ENDPOINT_BYTES
      || !validCanonicalIdentityForSchema(binding.identity, KICAD_MCP_IPC_SOCKET_BINDING_SCHEMA_VERSION)) {
    throw new KicadMcpAuthorizationError("KiCad IPC socket binding is not an exact closed bridge capability.");
  }
  const socketPath = binding.endpoint.slice("ipc://".length);
  if (!path.isAbsolute(socketPath)) throw new KicadMcpAuthorizationError("KiCad IPC socket binding path is not absolute.");
  return socketPath;
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left.localeCompare(right, "en-US"))
        .map((key) => [key, stableJsonValue(value[key])]),
    );
  }
  return value;
}

function toolDefinitionIdentity(tool: Tool): string {
  return JSON.stringify(stableJsonValue(tool));
}

interface DiscoveredToolCatalog {
  readonly toolsByName: ReadonlyMap<string, Tool>;
  readonly identity: KicadMcpToolDiscoveryIdentity;
}

async function discoverToolCatalog(parameters: {
  readonly client: Client;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly maxPages: number;
  readonly maxTools: number;
  readonly assertHealthy: () => void;
}): Promise<DiscoveredToolCatalog> {
  const toolsByName = new Map<string, Tool>();
  const foldedNames = new Map<string, Tool>();
  const pageCursorIdentities: (string | null)[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pageCount = 0;

  for (;;) {
    if (pageCount >= parameters.maxPages) {
      throw new KicadMcpSessionError(
        `KiCad MCP tool discovery exceeded its ${parameters.maxPages}-page limit.`,
      );
    }
    parameters.assertHealthy();
    pageCursorIdentities.push(cursor === undefined ? null : createHash("sha256").update("evleda.kicad-mcp-cursor.v1\0").update(cursor).digest("hex"));
    const page = await parameters.client.request(
      {
        method: "tools/list",
        params: cursor === undefined ? {} : { cursor },
      },
      requestOptions(parameters.timeoutMs, parameters.signal),
    );
    pageCount += 1;
    parameters.assertHealthy();

    if (toolsByName.size + page.tools.length > parameters.maxTools) {
      throw new KicadMcpSessionError(
        `KiCad MCP tool discovery exceeded its ${parameters.maxTools}-tool limit.`,
      );
    }
    for (const tool of page.tools) {
      if (tool.name.trim() !== tool.name || !tool.name.trim()) {
        throw new KicadMcpSessionError("KiCad MCP discovery returned an invalid tool-name category.");
      }
      if (!isPlainRecord(tool.inputSchema)) {
        throw new KicadMcpSessionError("KiCad MCP discovery returned an invalid input-schema category.");
      }
      if (tool.outputSchema !== undefined && !isPlainRecord(tool.outputSchema)) {
        throw new KicadMcpSessionError("KiCad MCP discovery returned an invalid output-schema category.");
      }

      const foldedName = tool.name.toLocaleLowerCase("en-US");
      const existing = foldedNames.get(foldedName);
      if (existing !== undefined) {
        const exactDuplicate =
          existing.name === tool.name &&
          toolDefinitionIdentity(existing) === toolDefinitionIdentity(tool);
        throw new KicadMcpSessionError(
          exactDuplicate
            ? "KiCad MCP discovery returned a duplicate tool name category."
            : "KiCad MCP discovery returned a conflicting tool name category.",
        );
      }
      foldedNames.set(foldedName, tool);
      toolsByName.set(tool.name, tool);
    }

    const nextCursor = page.nextCursor;
    if (nextCursor === undefined) break;
    if (nextCursor === "" || nextCursor.length > 4_096) {
      throw new KicadMcpSessionError("KiCad MCP discovery returned an invalid next cursor.");
    }
    if (seenCursors.has(nextCursor)) {
      throw new KicadMcpSessionError("KiCad MCP discovery repeated cursor evidence and did not converge.");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return {
    toolsByName,
    identity: {
      pageCount,
      toolCount: toolsByName.size,
      pageCursorIdentities,
    },
  };
}

function assertJsonValue(
  value: unknown,
  label: string,
  depth = 0,
  state: { entries: number } = { entries: 0 },
): void {
  if (depth > 64) {
    throw new KicadMcpOutputError(`${label} exceeds the maximum JSON nesting depth.`);
  }
  state.entries += 1;
  if (state.entries > 100_000) {
    throw new KicadMcpOutputError(`${label} exceeds the maximum JSON entry count.`);
  }

  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new KicadMcpOutputError(`${label} contains a non-finite number.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertJsonValue(entry, label, depth + 1, state);
    return;
  }
  if (isPlainRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (key.includes("\0")) {
        throw new KicadMcpOutputError(`${label} contains a key with a NUL byte.`);
      }
      assertJsonValue(entry, label, depth + 1, state);
    }
    return;
  }
  throw new KicadMcpOutputError(`${label} is not JSON-compatible.`);
}

const redactedForKey = (key: string): string =>
  /(?:path|file|directory|dir|root|command|argv)/iu.test(key)
    ? "[redacted path]"
    : /(?:error|message|stderr|stdout)/iu.test(key)
      ? "[redacted sidecar diagnostic]"
      : "[redacted sensitive sidecar value]";

const sensitiveOutputKey = (key: string): boolean => {
  const compact = key.replace(/[^A-Za-z0-9]/gu, "").toLocaleLowerCase("en-US");
  if (compact === "profile") return false;
  const boundaryWords = [
    "file", "filename", "root", "command", "argv", "environment", "env", "stdout", "stderr",
    "secret", "token", "password", "passwd", "credential", "authorization", "cookie", "prompt",
    "provider", "raw", "error", "message",
  ];
  return compact.includes("path") || compact.includes("directory")
    || boundaryWords.some((word) => compact === word || compact.startsWith(word) || compact.endsWith(word));
};

const safeEvidenceKey = (key: string): string => {
  if (key.length <= 256 && !/[\0\r\n]/u.test(key) && !SENSITIVE_OUTPUT_TEXT.test(key)
      && !WINDOWS_ABSOLUTE_PATH.test(key) && !FILE_URI.test(key)) return key;
  return `redacted_${createHash("sha256").update(key, "utf8").digest("hex").slice(0, 16)}`;
};

function sanitizeEvidenceText(value: string, roots: readonly string[]): string {
  let text = value.replace(/\u0000/gu, "").replace(/\r\n?/gu, "\n");
  if (SENSITIVE_OUTPUT_TEXT.test(text)) return "[redacted sensitive sidecar text]";
  for (const root of [...roots].sort((left, right) => right.length - left.length)) {
    if (root.length === 0) continue;
    text = text.split(root).join("[redacted path]");
    if (process.platform === "win32") {
      const folded = root.toLocaleLowerCase("en-US");
      let cursor = 0;
      for (;;) {
        const index = text.toLocaleLowerCase("en-US").indexOf(folded, cursor);
        if (index < 0) break;
        text = `${text.slice(0, index)}[redacted path]${text.slice(index + root.length)}`;
        cursor = index + "[redacted path]".length;
      }
    }
  }
  text = text
    .replace(/\[redacted path\](?:[\\/][^\s"'<>]*)?/gu, "[redacted path]")
    .replace(FILE_URI_TEXT, "[redacted path]")
    .replace(WINDOWS_PATH_TEXT, "[redacted path]")
    .replace(POSIX_PATH_TEXT, "$1[redacted path]");
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= 64 * 1024) return text;
  return `${bytes.subarray(0, 64 * 1024 - 32).toString("utf8")}\n[truncated sidecar evidence]`;
}

function sanitizeEvidenceValue(
  value: unknown,
  roots: readonly string[],
  key = "result",
  depth = 0,
  state: { entries: number } = { entries: 0 },
): unknown {
  if (depth > 64) throw new KicadMcpOutputError("KiCad MCP evidence exceeds the closed nesting limit.");
  state.entries += 1;
  if (state.entries > 100_000) throw new KicadMcpOutputError("KiCad MCP evidence exceeds the closed entry limit.");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new KicadMcpOutputError("KiCad MCP evidence contains a non-finite number.");
    return value;
  }
  if (typeof value === "string") {
    if (sensitiveOutputKey(key)) return redactedForKey(key);
    return sanitizeEvidenceText(value, roots);
  }
  if (Array.isArray(value)) {
    if (value.length > 100_000) throw new KicadMcpOutputError("KiCad MCP evidence exceeds the closed array limit.");
    return value.map((entry) => sanitizeEvidenceValue(entry, roots, key, depth + 1, state));
  }
  if (!isPlainRecord(value)) throw new KicadMcpOutputError("KiCad MCP evidence is not closed JSON data.");
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
    safeEvidenceKey(childKey),
    sensitiveOutputKey(childKey)
      ? child === null ? null : redactedForKey(childKey)
      : sanitizeEvidenceValue(child, roots, childKey, depth + 1, state),
  ]));
}

function sanitizeToolResult(
  result: CallToolResult,
  roots: readonly string[],
  maximumBytes: number,
): CallToolResult {
  if (result.isError === true) {
    throw new KicadMcpOutputError("KiCad MCP returned categorical tool-failure evidence.");
  }
  let structured: Record<string, unknown>;
  if (result.structuredContent !== undefined) {
    assertJsonValue(result.structuredContent, "KiCad MCP structured evidence");
    const sanitized = sanitizeEvidenceValue(result.structuredContent, roots);
    if (!isPlainRecord(sanitized)) throw new KicadMcpOutputError("KiCad MCP structured evidence has an invalid root.");
    structured = sanitized;
  } else {
    const text = result.content.flatMap((entry) => entry.type === "text" ? [entry.text] : []).join("\n");
    structured = {
      schemaVersion: "evleda.kicad-mcp-text-evidence.v1",
      category: "validated_text",
      result: sanitizeEvidenceText(text, roots),
    };
  }
  const serialized = JSON.stringify(structured);
  if (Buffer.byteLength(serialized, "utf8") > maximumBytes) {
    throw new KicadMcpOutputError("KiCad MCP structured evidence exceeds the configured byte limit.");
  }
  return {
    content: [{
      type: "text",
      text: "{\"schemaVersion\":\"evleda.kicad-mcp-result.v1\",\"category\":\"validated_structured_evidence\"}",
    }],
    structuredContent: structured,
  };
}

interface LivePcbDocumentSnapshot {
  readonly projectPath: string;
  readonly boardFilename: string;
  readonly boardSource: string;
}

function assertLivePcbPadSnapshotRegistration(tool: Tool): void {
  if (tool.name !== LIVE_PCB_PAD_SNAPSHOT_TOOL
      || canonicalJson(tool.inputSchema) !== canonicalJson(LIVE_PCB_PAD_SNAPSHOT_INPUT_SCHEMA)
      || canonicalJson(tool.annotations ?? null) !== canonicalJson(LIVE_PCB_PAD_SNAPSHOT_ANNOTATIONS)
      || tool.outputSchema === undefined
      || createHash("sha256").update(canonicalJson(tool.outputSchema), "utf8").digest("hex") !== LIVE_PCB_PAD_SNAPSHOT_OUTPUT_SCHEMA_SHA256
      || tool._meta !== undefined) {
    throw new KicadMcpAuthorizationError("KiCad MCP live PCB pad snapshot registration does not match its host-private protocol.");
  }
}

function assertSchematicConnectivityBatchRegistration(tool: Tool): void {
  if (tool.name !== SCHEMATIC_CONNECTIVITY_BATCH_TOOL
      || createHash("sha256").update(canonicalJson(tool.inputSchema), "utf8").digest("hex") !== SCHEMATIC_CONNECTIVITY_BATCH_INPUT_SCHEMA_SHA256
      || tool.outputSchema === undefined
      || createHash("sha256").update(canonicalJson(tool.outputSchema), "utf8").digest("hex") !== SCHEMATIC_CONNECTIVITY_BATCH_OUTPUT_SCHEMA_SHA256
      || canonicalJson(tool.annotations ?? null) !== canonicalJson(SCHEMATIC_CONNECTIVITY_BATCH_ANNOTATIONS)
      || tool._meta !== undefined) {
    throw new KicadMcpAuthorizationError("KiCad MCP schematic connectivity batch registration does not match its host-private mutating protocol.");
  }
}

function assertPlaneStageRegistration(tool: Tool): void {
  if (tool.name !== KICAD_PLANE_STAGE_TOOL
      || canonicalJson(tool.inputSchema) !== canonicalJson(KICAD_PLANE_STAGE_INPUT_JSON_SCHEMA)
      || canonicalJson(tool.outputSchema ?? null) !== canonicalJson(KICAD_PLANE_STAGE_OUTPUT_JSON_SCHEMA)
      || canonicalJson(tool.annotations ?? null) !== canonicalJson(KICAD_PLANE_STAGE_ANNOTATIONS)
      || tool._meta !== undefined) {
    throw new KicadMcpAuthorizationError("KiCad MCP plane stage registration does not match its host-private mutating protocol.");
  }
}

function nativeCommitToolQualified(tool: Tool | undefined): boolean {
  if (tool === undefined || !NATIVE_COMMIT_TOOL_NAMES.includes(tool.name as typeof NATIVE_COMMIT_TOOL_NAMES[number])) return false;
  const expected = NATIVE_COMMIT_TOOL_SHA256[tool.name];
  return expected !== undefined
    && canonicalJson(tool._meta ?? null) === canonicalJson({ [NATIVE_COMMIT_META_KEY]: NATIVE_COMMIT_SCHEMA_VERSION })
    && createHash("sha256").update(canonicalJson(tool), "utf8").digest("hex") === expected;
}

function footprintIdentitySyncQualified(tool: Tool | undefined): boolean {
  return tool?.name === "pcb_sync_from_schematic"
    && canonicalJson(tool._meta ?? null) === canonicalJson({ [QUALIFIED_FOOTPRINT_SYNC_META_KEY]: QUALIFIED_FOOTPRINT_SYNC_SCHEMA_VERSION })
    && createHash("sha256").update(canonicalJson(tool), "utf8").digest("hex") === QUALIFIED_FOOTPRINT_SYNC_TOOL_SHA256;
}

function qualifiedNativeCommitReply(result: CallToolResult, expected: string): boolean {
  if (result.isError === true) return false;
  const matches = (value: unknown): boolean => typeof value === "string" ? value.trim() === expected
    : isPlainRecord(value) && Object.keys(value).length === 1 && typeof value.result === "string" && value.result.trim() === expected;
  let present = false;
  if (result.structuredContent !== undefined) { if (!matches(result.structuredContent)) return false; present = true; }
  if (result.content.length > 0) {
    if (result.content.length !== 1 || result.content[0]!.type !== "text") return false;
    const text = result.content[0]!.text;
    let valid = matches(text);
    if (!valid) { try { valid = matches(JSON.parse(text)); } catch { return false; } }
    if (!valid) return false;
    present = true;
  }
  return present;
}

function nativeRouteResultCause(name: string, result: CallToolResult, maximumBytes: number): unknown {
  assertJsonValue(result, "KiCad MCP native route failure response");
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > maximumBytes) return { operation: name, responseExceededBound: true };
  return Object.freeze({ operation: name, response: structuredClone(result) });
}

function parsePlaneStageArtifactReference(result: CallToolResult, maximumBytes: number) {
  assertJsonValue(result, "KiCad MCP plane stage artifact envelope");
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > maximumBytes) throw new KicadMcpOutputError("KiCad MCP plane stage artifact reference exceeds the configured message limit.");
  const envelope = inspectionRecord(result, "KiCad MCP plane stage artifact envelope");
  inspectionExactKeys(envelope, ["content", "structuredContent"], ["isError"], "KiCad MCP plane stage artifact envelope");
  if (envelope.isError !== undefined && envelope.isError !== false) throw new KicadMcpOutputError("KiCad MCP returned categorical plane stage failure evidence.");
  if (!Array.isArray(envelope.content) || envelope.content.length !== 1) throw new KicadMcpOutputError("KiCad MCP plane stage artifact requires one exact text result.");
  const block = inspectionRecord(envelope.content[0], "KiCad MCP plane stage artifact text");
  inspectionExactKeys(block, ["type", "text"], [], "KiCad MCP plane stage artifact text");
  if (block.type !== "text" || typeof block.text !== "string") throw new KicadMcpOutputError("KiCad MCP plane stage artifact text is invalid.");
  const text = parsePortableJsonBytes(Buffer.from(block.text, "utf8"), {
    maxBytes: Math.min(maximumBytes, 16 * 1024 * 1024), maxDepth: 4, maxNodes: 16,
    maxOwnKeys: 4, maxArrayLength: 1, maxKeyBytes: 32, maxStringBytes: 4096,
  });
  const reference = kicadPlaneStageArtifactSchema.parse(envelope.structuredContent);
  if (canonicalJson(text) !== canonicalJson(reference)) throw new KicadMcpOutputError("KiCad MCP plane stage artifact envelopes disagree.");
  return reference;
}

/** Raw host-only authority. The complete duplicated envelope must fit the configured message budget;
 * each decoded string additionally retains the portable JSON parser's 1 MiB UTF-8 ceiling. */
function parseLivePcbDocumentSnapshot(result: CallToolResult, maximumBytes: number): LivePcbDocumentSnapshot {
  assertJsonValue(result, "KiCad MCP live PCB document envelope");
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > maximumBytes) throw new KicadMcpOutputError("KiCad MCP live PCB document exceeds the configured message limit.");
  const envelope = inspectionRecord(result, "KiCad MCP live PCB document envelope");
  inspectionExactKeys(envelope, ["content", "structuredContent"], ["isError"], "KiCad MCP live PCB document envelope");
  if (envelope.isError !== undefined && envelope.isError !== false) throw new KicadMcpOutputError("KiCad MCP returned categorical live PCB document failure evidence.");
  if (!Array.isArray(envelope.content) || envelope.content.length !== 1) throw new KicadMcpOutputError("KiCad MCP live PCB document requires one exact text result.");
  const content = inspectionRecord(envelope.content[0], "KiCad MCP live PCB document content");
  inspectionExactKeys(content, ["type", "text"], [], "KiCad MCP live PCB document content");
  if (content.type !== "text" || typeof content.text !== "string" || !content.text.isWellFormed()) throw new KicadMcpOutputError("KiCad MCP live PCB document text is invalid.");
  let textPayload: unknown;
  try {
    textPayload = parsePortableJsonBytes(Buffer.from(content.text, "utf8"), {
      maxBytes: Math.min(maximumBytes, 16 * 1024 * 1024), maxStringBytes: Math.min(maximumBytes, 1024 * 1024),
      maxDepth: 2, maxNodes: 16, maxOwnKeys: 5, maxKeyBytes: 32, maxArrayLength: 1,
    });
  } catch { throw new KicadMcpOutputError("KiCad MCP live PCB document text is not strict bounded JSON."); }
  const document = inspectionRecord(envelope.structuredContent, "KiCad MCP live PCB document");
  inspectionExactKeys(document, ["schemaVersion", "documentType", "projectPath", "boardFilename", "boardSource"], [], "KiCad MCP live PCB document");
  if (document.schemaVersion !== LIVE_PCB_DOCUMENT_SCHEMA_VERSION || document.documentType !== "pcb"
    || typeof document.projectPath !== "string" || !document.projectPath.isWellFormed() || document.projectPath.length === 0 || Buffer.byteLength(document.projectPath, "utf8") > 4_096 || /[\0-\x1f\x7f]/u.test(document.projectPath) || !path.isAbsolute(document.projectPath) || FILE_URI.test(document.projectPath)
    || typeof document.boardFilename !== "string" || !document.boardFilename.isWellFormed() || Buffer.byteLength(document.boardFilename, "utf8") > 255 || /[\0-\x1f\x7f\\/:]/u.test(document.boardFilename) || !/\.kicad_pcb$/iu.test(document.boardFilename) || path.basename(document.boardFilename) !== document.boardFilename
    || typeof document.boardSource !== "string" || !document.boardSource.isWellFormed() || document.boardSource.length === 0 || document.boardSource.includes("\0") || Buffer.byteLength(document.boardSource, "utf8") > maximumBytes) {
    throw new KicadMcpOutputError("KiCad MCP live PCB document has invalid source or document authority.");
  }
  if (canonicalJson(textPayload) !== canonicalJson(document)) throw new KicadMcpOutputError("KiCad MCP live PCB document envelopes disagree.");
  return { projectPath: document.projectPath, boardFilename: document.boardFilename, boardSource: document.boardSource };
}

function requestOptions(timeoutMs: number, signal: AbortSignal | undefined): RequestOptions {
  return {
    timeout: timeoutMs,
    maxTotalTimeout: timeoutMs,
    ...(signal === undefined ? {} : { signal }),
  };
}

class BoundedStderrCapture {
  readonly #maxBytes: number;
  readonly #onLimitExceeded: (error: KicadMcpOutputLimitError) => void;
  #seenBytes = 0;
  #stream: Stream | null = null;
  #limitError: KicadMcpOutputLimitError | undefined;

  constructor(
    maxBytes: number,
    onLimitExceeded: (error: KicadMcpOutputLimitError) => void,
  ) {
    this.#maxBytes = maxBytes;
    this.#onLimitExceeded = onLimitExceeded;
  }

  readonly onData = (chunk: Buffer | string): void => {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.#seenBytes += data.length;
    if (this.#seenBytes > this.#maxBytes && this.#limitError === undefined) {
      this.#limitError = new KicadMcpOutputLimitError(
        this.#maxBytes,
        this.#seenBytes,
      );
      this.#onLimitExceeded(this.#limitError);
    }
  };

  attach(stream: Stream | null): void {
    this.#stream = stream;
    stream?.on("data", this.onData);
  }

  detach(): void {
    this.#stream?.off("data", this.onData);
    this.#stream = null;
  }

  snapshot(): { category: "empty" | "present" | "limit_exceeded"; truncated: boolean; seenBytes: number } {
    return {
      category: this.#limitError === undefined ? this.#seenBytes === 0 ? "empty" : "present" : "limit_exceeded",
      truncated: this.#limitError !== undefined,
      seenBytes: this.#seenBytes,
    };
  }

  get limitError(): KicadMcpOutputLimitError | undefined {
    return this.#limitError;
  }

  assertWithinLimit(): void {
    if (this.#limitError !== undefined) throw this.#limitError;
  }
}

async function validateArgumentPaths(
  value: unknown,
  context: {
    readonly workspaceRoot: string;
    readonly projectRoot: string;
    readonly outputRoot: string;
  },
  key = "arguments",
): Promise<void> {
  if (typeof value === "string") {
    if (FILE_URI.test(value)) {
      throw new KicadMcpAuthorizationError(
        "A KiCad MCP path argument must use a confined filesystem path, not a file URI.",
      );
    }
    const isPathKey = PATH_ARGUMENT_KEY.test(key) || OUTPUT_ARGUMENT_KEY.test(key);
    const looksAbsolute = path.isAbsolute(value) || WINDOWS_ABSOLUTE_PATH.test(value);
    const hasTraversal = value.split(/[\\/]+/).includes("..");
    if (!isPathKey && !looksAbsolute && !hasTraversal) return;

    const outputPath = OUTPUT_ARGUMENT_KEY.test(key);
    const allowedRoot = outputPath ? context.outputRoot : context.projectRoot;
    const base = outputPath ? context.outputRoot : context.projectRoot;
    const candidate = await resolveConfinedCandidate(allowedRoot, base, value, "KiCad MCP path argument", true);
    assertPathWithin(context.workspaceRoot, candidate, "KiCad MCP path argument", true);
    return;
  }
  if (Array.isArray(value)) {
    await Promise.all(value.map(async (entry) => await validateArgumentPaths(entry, context, key)));
    return;
  }
  if (isPlainRecord(value)) {
    for (const [nestedKey, entry] of Object.entries(value)) {
      await validateArgumentPaths(entry, context, nestedKey);
    }
  }
}

/**
 * The upstream transport deliberately exposes only a numeric PID.  The
 * inspection bridge additionally retains the exact ChildProcess object and
 * its kernel-backed handle for incarnation checks immediately before any
 * numeric tree operation.  This avoids ever signalling a PID after the root
 * exit event has been observed or the transport has released that process.
 */
class IncarnationBoundStdioClientTransport extends StdioClientTransport {
  #rootWasStarted = false;
  #rootProcess: ChildProcess | undefined;
  #rootExitObserved = false;
  #rootCloseObserved = false;
  #markRootExit: (() => void) | undefined;
  #markRootClose: (() => void) | undefined;
  readonly #rootExit = new Promise<void>((resolve) => { this.#markRootExit = resolve; });
  readonly #rootClose = new Promise<void>((resolve) => { this.#markRootClose = resolve; });
  #incarnationIdentity: CanonicalIdentity | undefined;

  override async start(): Promise<void> {
    await super.start();
    // super.start() resolves only from the ChildProcess 'spawn' event.  Record
    // that fact before reading any mutable transport field so an immediate
    // exit can never be mistaken for "nothing was launched".
    this.#rootWasStarted = true;
    const root = (this as unknown as { readonly _process?: ChildProcess })._process;
    if (root === undefined || root.pid === undefined || !Number.isSafeInteger(root.pid) || root.pid <= 0
        || (root as unknown as { readonly _handle?: unknown })._handle == null) {
      throw new KicadMcpSessionError("KiCad MCP transport did not retain an exact root-process handle.");
    }
    this.#rootProcess = root;
    this.#incarnationIdentity = canonicalIdentity({
      pid: root.pid,
      launchObservedNs: process.hrtime.bigint().toString(10),
      executablePathIdentity: pathIdentity(root.spawnfile),
      argumentsSha256: argumentIdentity(root.spawnargs),
    }, "evleda.kicad-mcp-root-process-incarnation.v1");
    root.once("exit", () => {
      this.#rootExitObserved = true;
      this.#markRootExit?.();
      this.#markRootExit = undefined;
    });
    root.once("close", () => {
      this.#rootCloseObserved = true;
      this.#markRootClose?.();
      this.#markRootClose = undefined;
    });
  }

  get rootIncarnationIdentity(): CanonicalIdentity {
    if (this.#incarnationIdentity === undefined) {
      throw new KicadMcpSessionError("KiCad MCP root-process incarnation is unavailable.");
    }
    return this.#incarnationIdentity;
  }

  get rootWasStarted(): boolean { return this.#rootWasStarted; }
  get rootExitObserved(): boolean { return this.#rootExitObserved; }
  get hasBoundRootIncarnation(): boolean { return this.#rootProcess !== undefined && this.#incarnationIdentity !== undefined; }

  /** Fresh proof immediately before a numeric tree operation. */
  assertCurrentLiveRoot(expectedPid: number): void {
    const root = this.#rootProcess;
    const transportRoot = (this as unknown as { readonly _process?: ChildProcess })._process;
    if (root === undefined || root !== transportRoot || root.pid !== expectedPid
        || this.#rootExitObserved || this.#rootCloseObserved
        || root.exitCode !== null || root.signalCode !== null
        || (root as unknown as { readonly _handle?: unknown })._handle == null) {
      throw new KicadMcpTerminationUncertainError("KiCad MCP root process exited or changed before tree termination.");
    }
    try {
      if (!root.kill(0)) throw new Error("root handle is not signalable");
    } catch {
      throw new KicadMcpTerminationUncertainError("KiCad MCP root process could not be proven live before tree termination.");
    }
    if (this.#rootExitObserved || root.exitCode !== null || root.signalCode !== null
        || (this as unknown as { readonly _process?: ChildProcess })._process !== root) {
      throw new KicadMcpTerminationUncertainError("KiCad MCP root process changed during its pre-termination proof.");
    }
  }

  async waitForExactRootSettlement(timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      Promise.all([this.#rootExit, this.#rootClose]).then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    return settled && this.#rootExitObserved && this.#rootCloseObserved;
  }
}

export class KicadMcpSession {
  readonly #client: Client;
  readonly #transport: IncarnationBoundStdioClientTransport;
  readonly #stderrCapture: BoundedStderrCapture;
  readonly #mode: KicadMcpOperatingMode;
  readonly #workspaceRoot: string;
  readonly #projectRoot: string;
  readonly #outputRoot: string;
  readonly #launchCwd: string;
  readonly #command: KicadMcpCommand;
  readonly #launcherIdentity: KicadMcpLauncherIdentity;
  readonly #trustedLauncher: KicadMcpExpectedExecutableIdentity;
  readonly #toolDiscoveryIdentity: KicadMcpToolDiscoveryIdentity;
  readonly #timeoutMs: number;
  readonly #maxMessageBytes: number;
  readonly #pid: number;
  readonly #deferredProjectBinding: boolean;
  readonly #ipcSocketIdentity: CanonicalIdentity | null;
  readonly #sessionAuthorityIdentity: CanonicalIdentity | null;
  readonly #sessionSemanticAuthorityIdentity: CanonicalIdentity | null;
  readonly #processTreeSupervision: BoundWindowsProcessTreeSupervision | undefined;
  readonly #readAllowlist: ReadonlySet<string>;
  readonly #writeAllowlist: ReadonlySet<string>;
  readonly #toolsByName: ReadonlyMap<string, Tool>;
  readonly #activeOperationAbortControllers = new Set<AbortController>();
  readonly #activeOperationDrainWaiters = new Set<() => void>();
  #closed = false;
  #projectBound: boolean;
  #schematicConnectivityBatchInFlight = false;
  #planeStageInFlight = false;
  #planeStageWritesQuarantined = false;
  #lastVerifiedLivePcbPath: string | undefined;
  #nativeRouteTransaction: {
    readonly boardPath: string;
    phase: "beginning" | "open" | "pushed" | "dropped";
    quarantined: boolean;
    firstFailure?: unknown;
  } | undefined;
  #closePromise: Promise<void> | undefined;

  private constructor(parameters: {
    client: Client;
    transport: IncarnationBoundStdioClientTransport;
    stderrCapture: BoundedStderrCapture;
    mode: KicadMcpOperatingMode;
    workspaceRoot: string;
    projectRoot: string;
    outputRoot: string;
    launchCwd: string;
    command: KicadMcpCommand;
    launcherIdentity: KicadMcpLauncherIdentity;
    trustedLauncher: KicadMcpExpectedExecutableIdentity;
    toolDiscoveryIdentity: KicadMcpToolDiscoveryIdentity;
    timeoutMs: number;
    maxMessageBytes: number;
    pid: number;
    deferredProjectBinding: boolean;
    ipcSocketIdentity: CanonicalIdentity | null;
    sessionAuthorityIdentity: CanonicalIdentity | null;
    sessionSemanticAuthorityIdentity: CanonicalIdentity | null;
    processTreeSupervision: BoundWindowsProcessTreeSupervision | undefined;
    readAllowlist: ReadonlySet<string>;
    writeAllowlist: ReadonlySet<string>;
    toolsByName: ReadonlyMap<string, Tool>;
  }) {
    this.#client = parameters.client;
    this.#transport = parameters.transport;
    this.#stderrCapture = parameters.stderrCapture;
    this.#mode = parameters.mode;
    this.#workspaceRoot = parameters.workspaceRoot;
    this.#projectRoot = parameters.projectRoot;
    this.#outputRoot = parameters.outputRoot;
    this.#launchCwd = parameters.launchCwd;
    this.#command = parameters.command;
    this.#launcherIdentity = parameters.launcherIdentity;
    this.#trustedLauncher = parameters.trustedLauncher;
    this.#toolDiscoveryIdentity = parameters.toolDiscoveryIdentity;
    this.#timeoutMs = parameters.timeoutMs;
    this.#maxMessageBytes = parameters.maxMessageBytes;
    this.#pid = parameters.pid;
    this.#deferredProjectBinding = parameters.deferredProjectBinding;
    this.#ipcSocketIdentity = parameters.ipcSocketIdentity;
    this.#sessionAuthorityIdentity = parameters.sessionAuthorityIdentity;
    this.#sessionSemanticAuthorityIdentity = parameters.sessionSemanticAuthorityIdentity;
    this.#processTreeSupervision = parameters.processTreeSupervision;
    this.#projectBound = !parameters.deferredProjectBinding;
    this.#readAllowlist = parameters.readAllowlist;
    this.#writeAllowlist = parameters.writeAllowlist;
    this.#toolsByName = parameters.toolsByName;
  }

  #beginOperation(externalSignal?: AbortSignal): Readonly<{ readonly signal: AbortSignal; release(): void }> {
    if (this.#closed) throw new KicadMcpSessionError("KiCad MCP session is closed or terminating.");
    if (this.#schematicConnectivityBatchInFlight) throw new KicadMcpAuthorizationError("KiCad MCP schematic connectivity batch requires exclusive session access until its call settles.");
    if (this.#planeStageInFlight) throw new KicadMcpAuthorizationError("KiCad MCP plane stage requires exclusive session access until its call settles.");
    const controller = new AbortController();
    this.#activeOperationAbortControllers.add(controller);
    let released = false;
    return Object.freeze({
      signal: externalSignal === undefined
        ? controller.signal
        : AbortSignal.any([externalSignal, controller.signal]),
      release: () => {
        if (released) return;
        released = true;
        this.#activeOperationAbortControllers.delete(controller);
        if (this.#activeOperationAbortControllers.size === 0) {
          for (const resolve of this.#activeOperationDrainWaiters) resolve();
          this.#activeOperationDrainWaiters.clear();
        }
      },
    });
  }

  async #waitForOperationDrain(timeoutMs: number): Promise<boolean> {
    if (this.#activeOperationAbortControllers.size === 0) return true;
    let timer: NodeJS.Timeout | undefined;
    let resolveDrain!: () => void;
    const drained = new Promise<void>((resolve) => { resolveDrain = resolve; });
    this.#activeOperationDrainWaiters.add(resolveDrain);
    const timedOut = await Promise.race([
      drained.then(() => false),
      new Promise<true>((resolve) => { timer = setTimeout(() => resolve(true), timeoutMs); }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    this.#activeOperationDrainWaiters.delete(resolveDrain);
    return !timedOut && this.#activeOperationAbortControllers.size === 0;
  }

  static async connect(options: KicadMcpSessionOptions): Promise<KicadMcpSession> {
    let startupStage: KicadStartupStage = "session-policy";
    let startupStderr: BoundedStderrCapture | undefined;
    const setStartupStage = (stage: KicadStartupStage): void => {
      startupStage = stage;
      try { options.observeStartupStage?.(stage); } catch { /* Diagnostics cannot replace an operation result. */ }
    };
    try {
    const mode = options.mode ?? "readonly";
    const deferredProjectBinding = options.deferProjectBinding === true;
    if (deferredProjectBinding && options.launchCwd === undefined) {
      throw new KicadMcpAuthorizationError("Deferred project binding requires an explicit private launch directory.");
    }
    const ipcSocketIdentity = options.ipcSocket === undefined ? null : options.ipcSocket.identity;
    if (options.ipcSocket !== undefined) {
      if (!deferredProjectBinding) {
        throw new KicadMcpAuthorizationError("The bridge-owned KiCad IPC socket requires deferred host project binding.");
      }
      validateIpcSocketBindingShape(options.ipcSocket);
    }
    const sessionAuthorityIdentity = options.sessionAuthorityIdentity ?? null;
    const sessionSemanticAuthorityIdentity = options.sessionSemanticAuthorityIdentity ?? null;
    if ((options.ipcSocket === undefined) !== (sessionAuthorityIdentity === null)
        || (options.ipcSocket === undefined) !== (sessionSemanticAuthorityIdentity === null)
        || (sessionAuthorityIdentity !== null
          && !validCanonicalIdentityForSchema(sessionAuthorityIdentity, KICAD_MCP_SESSION_AUTHORITY_SCHEMA_VERSION))
        || (sessionSemanticAuthorityIdentity !== null
          && !validCanonicalIdentityForSchema(sessionSemanticAuthorityIdentity, KICAD_MCP_SESSION_SEMANTIC_AUTHORITY_SCHEMA_VERSION))) {
      throw new KicadMcpAuthorizationError("KiCad MCP session/socket authority identity is missing or invalid.");
    }
    const timeoutMs = validatePositiveInteger(options.timeoutMs ?? 30_000, "KiCad MCP timeout");
    const maxMessageBytes = validatePositiveInteger(
      options.maxMessageBytes ?? 2 * 1024 * 1024,
      "KiCad MCP message limit",
    );
    const maxStderrBytes = validatePositiveInteger(
      options.maxStderrBytes ?? 256 * 1024,
      "KiCad MCP stderr limit",
    );
    const maxToolPages = validateBoundedPositiveInteger(
      options.maxToolPages ?? 8,
      "KiCad MCP tool page limit",
      64,
    );
    const maxTools = validateBoundedPositiveInteger(
      options.maxTools ?? 512,
      "KiCad MCP tool count limit",
      2_048,
    );
    setStartupStage("session-workspace-root");
    const workspaceRoot = await resolveExistingDirectory(options.workspaceRoot, "MCP workspace root");
    setStartupStage("session-project-root");
    const projectRoot = await resolveExistingDirectory(options.projectRoot, "MCP project root");
    setStartupStage("session-launch-directory");
    const launchCwd = options.launchCwd === undefined
      ? projectRoot
      : await resolveExistingDirectory(options.launchCwd, "MCP launch working directory");
    assertPathWithin(workspaceRoot, projectRoot, "MCP project root", true);

    if (mode === "write") {
      if (options.freshProject === true && options.isolatedWorkingCopy !== undefined) {
        throw new KicadMcpAuthorizationError("Fresh-project write mode cannot also declare a copied working copy.");
      }
      if (options.isolatedWorkingCopy === undefined && options.freshProject !== true) {
        throw new KicadMcpAuthorizationError(
          "Write mode requires an isolated working copy or a CLI-verified fresh project.",
        );
      }
      if (options.isolatedWorkingCopy !== undefined) {
        const canonicalRoot = await resolveExistingDirectory(
          options.isolatedWorkingCopy.canonicalProjectRoot,
          "canonical project root",
        );
        assertDisjointDirectories(
          canonicalRoot,
          projectRoot,
          "canonical project root",
          "MCP working copy",
        );
      }
    }

    setStartupStage("session-output-root");
    const rawOutputRoot = options.outputRoot ?? path.join(projectRoot, ".evleda-mcp-output");
    const outputRoot = await resolveConfinedCandidate(
      workspaceRoot,
      workspaceRoot,
      rawOutputRoot,
      "MCP output root",
      false,
    );
    assertPathWithin(workspaceRoot, outputRoot, "MCP output root", false);

    setStartupStage("session-launcher");
    const sourceEnvironment = options.environment ?? {};
    if (options.command === undefined) {
      throw new KicadMcpSessionError("KiCad MCP launch requires an explicit production-profile command and executable identity.");
    }
    const commandSource = options.command;
    validateCommand(commandSource);
    const trustedLauncher = await resolvePinnedExecutable(
      commandSource.command,
      options.expectedLauncherIdentity,
      "KiCad MCP launcher",
    );
    const launcherIdentity = publicExecutableIdentity(trustedLauncher);
    const resolvedCommand: KicadMcpCommand = {
      command: trustedLauncher.path,
      args: [...commandSource.args],
    };
    validateCommand(resolvedCommand);
    const command = sidecarLaunchCommand(resolvedCommand, mode, projectRoot, deferredProjectBinding);
    validateCommand(command);
    setStartupStage("session-supervision");
    const processTreeSupervision = await bindWindowsProcessTreeSupervision(
      options.processTreeSupervision,
      sourceEnvironment,
    );

    const readAllowlist = narrowAllowlist(
      options.readToolAllowlist,
      KICAD_MCP_READ_TOOL_ALLOWLIST,
      "Read allowlist",
    );
    const writeAllowlist = narrowAllowlist(
      options.writeToolAllowlist,
      KICAD_MCP_WRITE_TOOL_ALLOWLIST,
      "Write allowlist",
    );

    setStartupStage("session-environment");
    const environment = minimalHostEnvironment(sourceEnvironment, true);
    for (const [key, value] of Object.entries(options.extraEnvironment ?? {})) {
      if (!EXTRA_ENVIRONMENT_KEYS.has(key)) {
        throw new KicadMcpAuthorizationError(
          `Environment variable '${key}' is not allowlisted for the KiCad sidecar.`,
        );
      }
      if (/[\0\r\n]/.test(value)) {
        throw new KicadMcpSessionError(`Environment variable '${key}' contains controls.`);
      }
      environment[key] = value;
    }

    environment.NO_COLOR = "1";
    environment.LANG = "C";
    environment.LANGUAGE = "C";
    environment.LC_ALL = "C";
    environment.PYTHONUTF8 = "1";
    environment.PYTHONIOENCODING = "utf-8";
    environment.PYTHONNOUSERSITE = "1";
    environment.PYTHONSAFEPATH = "1";
    environment.PYTHONDONTWRITEBYTECODE = "1";
    environment.PYTHON_DOTENV_DISABLED = "1";
    environment.KICAD_MCP_TRANSPORT = "stdio";
    environment.KICAD_MCP_OPERATING_MODE = mode;
    environment.KICAD_MCP_PROFILE = "full";
    // Workspace is the host's enclosing authority, including sibling report
    // output. Only project/output selection is deferred to kicad_set_project.
    environment.KICAD_MCP_WORKSPACE_ROOT = workspaceRoot;
    if (!deferredProjectBinding) {
      environment.KICAD_MCP_PROJECT_DIR = projectRoot;
      environment.KICAD_MCP_OUTPUT_DIR = outputRoot;
    }
    environment.KICAD_MCP_TELEMETRY_ENABLED = "false";
    environment.KICAD_MCP_ENABLE_EXPERIMENTAL_TOOLS = "false";
    environment.KICAD_MCP_LOG_LEVEL = "WARNING";
    environment.KICAD_MCP_LOG_FORMAT = "json";
    if (options.ipcSocket !== undefined) {
      environment.KICAD_API_SOCKET = options.ipcSocket.endpoint;
      environment.KICAD_MCP_KICAD_SOCKET_PATH = options.ipcSocket.endpoint;
    }

    if ((options.kicadCliPath === undefined) !== (options.expectedKicadCliIdentity === undefined)) {
      throw new KicadMcpSessionError("KiCad CLI path and expected identity must be supplied together.");
    }
    if (options.kicadCliPath !== undefined) {
      setStartupStage("cli-runtime-binding");
      const runtime = await kicad10RuntimeBinding(
        options.kicadCliPath,
        options.expectedKicadCliIdentity,
        sourceEnvironment,
        options.processRunnerForTesting ?? runBoundedProcess,
      );
      environment.KICAD_MCP_KICAD_CLI = runtime.cli!;
      environment.KICAD_MCP_SYMBOL_LIBRARY_DIR = runtime.symbols!;
      environment.KICAD_MCP_FOOTPRINT_LIBRARY_DIR = runtime.footprints!;
      environment.KICAD10_SYMBOL_DIR = runtime.symbols!;
      environment.KICAD10_FOOTPRINT_DIR = runtime.footprints!;
      environment.KICAD10_TEMPLATE_DIR = runtime.templates!;
    }

    setStartupStage("sidecar-transport");
    const transport = new IncarnationBoundStdioClientTransport({
      command: command.command,
      args: [...command.args],
      cwd: launchCwd,
      env: environment,
      stderr: "pipe",
      maxBufferSize: maxMessageBytes,
    });
    let cachedPid: number | null = null;
    const cachePid = (): void => {
      const candidate = transport.pid;
      if (cachedPid === null && typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0) cachedPid = candidate;
    };
    const stderrCapture = new BoundedStderrCapture(maxStderrBytes, () => {
      cachePid();
      void transport.close().catch(() => undefined);
    });
    startupStderr = stderrCapture;
    stderrCapture.attach(transport.stderr);
    const client = new Client(
      { name: "evleda-kicad-controller", version: "0.1.0" },
      {
        enforceStrictCapabilities: true,
        versionNegotiation: { mode: "legacy" },
        inputRequired: { autoFulfill: false },
        listMaxPages: maxToolPages,
      },
    );

    try {
      options.assertLaunchAuthority?.();
      setStartupStage("mcp-handshake");
      await client.connect(transport, requestOptions(timeoutMs, options.signal));
      cachePid();
      if (cachedPid === null) throw new KicadMcpSessionError("KiCad MCP launch did not expose a stable process identity.");
      stderrCapture.assertWithinLimit();
      setStartupStage("mcp-server-identity");
      const server = client.getServerVersion();
      if (server?.name !== KICAD_MCP_SERVER_NAME || server.version !== KICAD_MCP_SERVER_VERSION) {
        throw new KicadMcpSessionError("KiCad MCP server identity does not match the pinned production profile.");
      }
      setStartupStage("mcp-catalog");
      const discovered = await discoverToolCatalog({
        client,
        timeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        maxPages: maxToolPages,
        maxTools,
        assertHealthy: () => stderrCapture.assertWithinLimit(),
      });
      setStartupStage("mcp-contracts");
      const syncTool=discovered.toolsByName.get("pcb_sync_from_schematic");
      if(isPlainRecord(syncTool?._meta)&&Object.hasOwn(syncTool._meta,QUALIFIED_FOOTPRINT_SYNC_META_KEY)&&!footprintIdentitySyncQualified(syncTool)){
        throw new KicadMcpAuthorizationError("KiCad MCP footprint identity sync claims a mismatched qualified tool contract.");
      }
      const livePadSnapshotTool = discovered.toolsByName.get(LIVE_PCB_PAD_SNAPSHOT_TOOL);
      if (livePadSnapshotTool !== undefined) assertLivePcbPadSnapshotRegistration(livePadSnapshotTool);
      const connectivityBatchTool = discovered.toolsByName.get(SCHEMATIC_CONNECTIVITY_BATCH_TOOL);
      if (connectivityBatchTool !== undefined) assertSchematicConnectivityBatchRegistration(connectivityBatchTool);
      const planeStageTool = discovered.toolsByName.get(KICAD_PLANE_STAGE_TOOL);
      if (planeStageTool !== undefined) assertPlaneStageRegistration(planeStageTool);
      for (const name of NATIVE_COMMIT_TOOL_NAMES) {
        const tool = discovered.toolsByName.get(name);
        if (isPlainRecord(tool?._meta) && Object.hasOwn(tool._meta, NATIVE_COMMIT_META_KEY) && !nativeCommitToolQualified(tool)) {
          throw new KicadMcpAuthorizationError("KiCad MCP native commit lifecycle claims a mismatched qualified tool contract.");
        }
      }
      setStartupStage("launcher-recheck");
      await assertExecutableIdentity(trustedLauncher, "KiCad MCP launcher");
      stderrCapture.assertWithinLimit();
      setStartupStage("required-capabilities");
      assertRequiredTools(options.requiredTools, discovered.toolsByName, mode, readAllowlist, writeAllowlist);

      return new KicadMcpSession({
        client,
        transport,
        stderrCapture,
        mode,
        workspaceRoot,
        projectRoot,
        outputRoot,
        launchCwd,
        command,
        launcherIdentity,
        trustedLauncher,
        toolDiscoveryIdentity: discovered.identity,
        timeoutMs,
        maxMessageBytes,
        pid: cachedPid,
        deferredProjectBinding,
        ipcSocketIdentity,
        sessionAuthorityIdentity,
        sessionSemanticAuthorityIdentity,
        processTreeSupervision,
        readAllowlist,
        writeAllowlist,
        toolsByName: discovered.toolsByName,
      });
    } catch (error) {
      const primary = captureKicadStartupFailure(error, startupStage, stderrCapture.snapshot());
      cachePid();
      const limitError = stderrCapture.limitError;
      let treeTerminationUncertain = false;
      let cleanupFailure: unknown;
      try {
        if (processTreeSupervision !== undefined && transport.rootWasStarted) {
          if (cachedPid === null || !transport.hasBoundRootIncarnation || transport.rootExitObserved) {
            // A spawned root without a still-bound handle/PID can have left
            // descendants.  There is no safe numeric target in this state.
            treeTerminationUncertain = true;
          } else {
            try {
              await assertExecutableIdentity(processTreeSupervision.terminator, "KiCad MCP process-tree terminator");
              await processTreeSupervision.beforeFinalRootProofForTesting?.();
              transport.assertCurrentLiveRoot(cachedPid);
              await startBoundWindowsProcessTreeTermination(processTreeSupervision, cachedPid, launchCwd);
              if (!await transport.waitForExactRootSettlement(processTreeSupervision.timeoutMs)) {
                throw new KicadMcpTerminationUncertainError("KiCad MCP root-process settlement was not confirmed after initialization failure.");
              }
            } catch (cleanupError) {
              cleanupFailure = cleanupError;
              // The exact root may already have exited.  Never issue another
              // numeric signal in that state; retain caller-owned runtime state.
              treeTerminationUncertain = true;
            }
          }
        }
        await client.close().catch(() => transport.close().catch(() => undefined));
      } finally {
        stderrCapture.detach();
      }
      if (treeTerminationUncertain) {
        const diagnostic = withKicadStartupCleanup(primary, "session-cleanup", "unconfirmed", cleanupFailure);
        throw bindKicadStartupEvidence(new KicadMcpTerminationUncertainError("KiCad MCP process-tree teardown could not be confirmed after initialization failure.", { cause: diagnostic }), diagnostic);
      }
      if (cachedPid !== null && !await waitForProcessExit(cachedPid)) {
        const diagnostic = withKicadStartupCleanup(primary, "session-cleanup", "unconfirmed");
        throw bindKicadStartupEvidence(new KicadMcpTerminationUncertainError("KiCad MCP sidecar teardown could not be confirmed after initialization failure.", { cause: diagnostic }), diagnostic);
      }
      const diagnostic = withKicadStartupCleanup(primary, "session-cleanup", "confirmed");
      if (limitError !== undefined) throw bindKicadStartupEvidence(limitError, diagnostic);
      if (registeredKicadStartupCategory(error) !== undefined) throw bindKicadStartupEvidence(error as Error, diagnostic);
      throw bindKicadStartupEvidence(new KicadMcpSessionError("Failed to initialize the pinned KiCad MCP sidecar.", { cause: diagnostic }), diagnostic);
    }
    } catch (error) {
      const diagnostic = captureKicadStartupFailure(error, startupStage, startupStderr?.snapshot());
      if (registeredKicadStartupCategory(error) !== undefined) throw bindKicadStartupEvidence(error as Error, diagnostic);
      throw bindKicadStartupEvidence(new KicadMcpSessionError("Failed to initialize the pinned KiCad MCP sidecar.", { cause: diagnostic }), diagnostic);
    }
  }

  get identity(): KicadMcpSessionIdentity {
    const sidecar = {
      distribution: "kicad-mcp-pro" as const,
      version: KICAD_MCP_PRO_VERSION,
      auditedCommit: KICAD_MCP_PRO_AUDITED_COMMIT,
      publishedDistributionSha256: KICAD_MCP_PRO_PYPI_DISTRIBUTIONS.map((distribution) => distribution.sha256),
    };
    const processTreeSupervision = this.#processTreeSupervision === undefined
      ? {
          strategy: "sdk-root-only" as const, terminator: null, timeoutMs: 750,
          rootExitBeforeTermination: "unconfirmed" as const,
          runtimeCleanup: "caller-owned-after-confirmation" as const,
        }
      : {
          strategy: this.#processTreeSupervision.strategy,
          terminator: publicExecutableIdentity(this.#processTreeSupervision.terminator),
          timeoutMs: this.#processTreeSupervision.timeoutMs,
          rootExitBeforeTermination: "unconfirmed" as const,
          runtimeCleanup: "caller-owned-after-confirmation" as const,
        };
    const launch = {
      schemaVersion: "evleda.kicad-mcp-launch.v1" as const,
      transport: "stdio" as const,
      profile: "full" as const,
      mode: this.#mode,
      launcherPathIdentity: this.#launcherIdentity.pathIdentity,
      argumentsSha256: argumentIdentity(this.#command.args),
      argumentCount: this.#command.args.length,
      workingDirectoryPathIdentity: pathIdentity(this.#launchCwd),
      projectBinding: this.#deferredProjectBinding ? "post-connect-protocol" as const : "launch-argument" as const,
      rootProcessIncarnationIdentity: this.#transport.rootIncarnationIdentity,
      processTreeSupervision,
      ipcSocketIdentity: this.#ipcSocketIdentity,
      sessionAuthorityIdentity: this.#sessionAuthorityIdentity,
      sessionSemanticAuthorityIdentity: this.#sessionSemanticAuthorityIdentity,
    };
    const launcher = { ...this.#launcherIdentity };
    const toolDiscovery = {
      ...this.#toolDiscoveryIdentity,
      pageCursorIdentities: [...this.#toolDiscoveryIdentity.pageCursorIdentities],
    };
    const server = {
      name: KICAD_MCP_SERVER_NAME,
      version: KICAD_MCP_SERVER_VERSION,
      authenticated: true,
    } as const;
    const roots = {
      workspacePathIdentity: pathIdentity(this.#workspaceRoot),
      projectPathIdentity: pathIdentity(this.#projectRoot),
      outputPathIdentity: pathIdentity(this.#outputRoot),
    };
    const sessionSemanticIdentity = canonicalIdentity({
      schemaVersion: KICAD_MCP_SESSION_SEMANTIC_IDENTITY_SCHEMA_VERSION,
      sidecar,
      launch: {
        schemaVersion: launch.schemaVersion,
        transport: launch.transport,
        profile: launch.profile,
        mode: launch.mode,
        launcherPathIdentity: launch.launcherPathIdentity,
        argumentsSha256: launch.argumentsSha256,
        argumentCount: launch.argumentCount,
        projectBinding: launch.projectBinding,
        processTreeSupervision: launch.processTreeSupervision,
        ipcSocketIdentity: launch.ipcSocketIdentity,
        sessionSemanticAuthorityIdentity: launch.sessionSemanticAuthorityIdentity,
      },
      launcher,
      toolDiscovery,
      server,
      mode: this.#mode,
    }, KICAD_MCP_SESSION_SEMANTIC_IDENTITY_SCHEMA_VERSION);
    const sessionReceiptIdentity = canonicalIdentity({
      schemaVersion: KICAD_MCP_SESSION_RECEIPT_SCHEMA_VERSION,
      sessionSemanticIdentity,
      actual: {
        roots,
        workingDirectoryPathIdentity: launch.workingDirectoryPathIdentity,
        rootProcessIncarnationIdentity: launch.rootProcessIncarnationIdentity,
        sessionAuthorityIdentity: launch.sessionAuthorityIdentity,
      },
    }, KICAD_MCP_SESSION_RECEIPT_SCHEMA_VERSION);
    return {
      sessionSemanticIdentity,
      sessionReceiptIdentity,
      sidecar,
      launch,
      launcher,
      toolDiscovery,
      pid: this.#pid,
      server,
      mode: this.#mode,
      roots,
    };
  }

  get stderr(): { category: "empty" | "present" | "limit_exceeded"; truncated: boolean; seenBytes: number } {
    return this.#stderrCapture.snapshot();
  }

  listTools(): readonly KicadMcpToolDescriptor[] {
    this.#stderrCapture.assertWithinLimit();
    const result: KicadMcpToolDescriptor[] = [];
    for (const tool of this.#toolsByName.values()) {
      if (isForbiddenTool(tool.name)) continue;
      const permission = this.#readAllowlist.has(tool.name)
        ? "read"
        : this.#mode === "write" && this.#writeAllowlist.has(tool.name)
          ? "write"
          : undefined;
      if (permission === undefined) continue;
      result.push({
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: sanitizeEvidenceText(tool.description, [this.#workspaceRoot, this.#projectRoot, this.#outputRoot, this.#launchCwd, this.#trustedLauncher.path]) }),
        permission,
        inputSchema: sanitizeEvidenceValue(tool.inputSchema, [this.#workspaceRoot, this.#projectRoot, this.#outputRoot, this.#launchCwd, this.#trustedLauncher.path]),
        ...(tool.outputSchema === undefined
          ? {}
          : { outputSchema: sanitizeEvidenceValue(tool.outputSchema, [this.#workspaceRoot, this.#projectRoot, this.#outputRoot, this.#launchCwd, this.#trustedLauncher.path]) }),
      });
    }
    return result;
  }

  async #assertTrustedRuntime(): Promise<void> {
    this.#stderrCapture.assertWithinLimit();
    await assertExecutableIdentity(this.#trustedLauncher, "KiCad MCP launcher");
    this.#stderrCapture.assertWithinLimit();
  }

  #assertPlaneStageWriteAdmission(name: string): void {
    if (this.#planeStageWritesQuarantined && name !== "pcb_revert") {
      throw new KicadMcpAuthorizationError("KiCad MCP writes are quarantined after plane staging; only host PCB revert is admitted for recovery.");
    }
    if (this.#nativeRouteTransaction?.quarantined && name !== "pcb_drop_commit" && name !== "pcb_revert") {
      throw new KicadMcpAuthorizationError("KiCad MCP writes are quarantined after a native route transaction failure; only checked transaction drop or PCB revert is admitted for recovery.");
    }
    if (this.#nativeRouteTransaction !== undefined && (name === KICAD_PLANE_STAGE_TOOL || name === SCHEMATIC_CONNECTIVITY_BATCH_TOOL)) {
      throw new KicadMcpAuthorizationError("KiCad MCP must finish the host native route transaction before another private mutation compound.");
    }
  }

  /** Host-detected geometry/source faults enter the same terminal recovery state as RPC faults. */
  quarantineNativeRouteTransaction(cause?: unknown): void {
    const transaction = this.#nativeRouteTransaction;
    if (transaction === undefined) return;
    transaction.quarantined = true;
    if (transaction.firstFailure === undefined && cause !== undefined) transaction.firstFailure = cause;
  }

  /** Called only after the owning host finishes mandatory saved/native/physical source verification. */
  finishNativeRouteTransaction(): void {
    if (this.#closed) throw new KicadMcpSessionError("KiCad MCP session is closed.");
    const transaction = this.#nativeRouteTransaction;
    if (transaction === undefined || transaction.phase !== "pushed" || transaction.quarantined) {
      throw new KicadMcpAuthorizationError("KiCad MCP native route recovery scope cannot finish before a clean push and host verification.");
    }
    this.#nativeRouteTransaction = undefined;
  }

  #nativeRouteFailure(operation: string, cause: unknown): KicadNativeRouteRecoveryRequiredError {
    this.quarantineNativeRouteTransaction(cause);
    return cause instanceof KicadNativeRouteRecoveryRequiredError ? cause : new KicadNativeRouteRecoveryRequiredError(operation, cause);
  }

  /** Fixed runtime capability, independent of whether a healthy transaction is awaiting host verification. */
  supportsNativeRouteTransactions(): boolean {
    return !this.#closed && this.#mode === "write" && this.#projectBound
      && !this.#planeStageWritesQuarantined && !this.#nativeRouteTransaction?.quarantined
      && NATIVE_COMMIT_TOOL_NAMES.every(name => nativeCommitToolQualified(this.#toolsByName.get(name)));
  }

  supportsQualifiedFootprintIdentitySync(): boolean {
    return !this.#closed && this.#mode === "write" && this.#projectBound
      && !this.#planeStageWritesQuarantined && !this.#nativeRouteTransaction?.quarantined
      && footprintIdentitySyncQualified(this.#toolsByName.get("pcb_sync_from_schematic"));
  }

  /** One-shot host-only project selection for the isolated manifested bridge. */
  async bindDeferredInspectionProject(): Promise<void> {
    if (this.#closed) throw new KicadMcpSessionError("KiCad MCP session is closed.");
    if (!this.#deferredProjectBinding || this.#projectBound) {
      throw new KicadMcpAuthorizationError("KiCad MCP deferred project binding is unavailable or already consumed.");
    }
    const tool = this.#toolsByName.get("kicad_set_project");
    if (tool === undefined) throw new KicadMcpSessionError("Pinned KiCad MCP sidecar lacks its host project-binding capability.");
    const operation = this.#beginOperation();
    try {
      await this.#assertTrustedRuntime();
      const result = await this.#client.callTool(
        { name: "kicad_set_project", arguments: { project_dir: this.#projectRoot, output_dir: this.#outputRoot } },
        { ...requestOptions(this.#timeoutMs, operation.signal), toolDefinition: tool },
      );
      if (result.isError === true) throw new KicadMcpOutputError("KiCad MCP returned categorical project-binding failure evidence.");
      sanitizeToolResult(result, [this.#workspaceRoot, this.#projectRoot, this.#outputRoot, this.#launchCwd, this.#trustedLauncher.path], this.#maxMessageBytes);
      await this.#assertTrustedRuntime();
      this.#projectBound = true;
    } catch (error) {
      operation.release();
      if (!this.#closed) await this.close().catch(() => undefined);
      if (error instanceof KicadMcpSessionError) throw error;
      throw new KicadMcpSessionError("KiCad MCP deferred project binding did not complete safely.");
    } finally {
      operation.release();
    }
  }

  /** Host-private live IPC check. Configured project paths and existing board files are not live authority. */
  async assertActivePcb(expectedPath: string): Promise<void> {
    await this.readActivePcbSource(expectedPath);
  }

  supportsPlaneStage(): boolean {
    return !this.#closed && this.#mode === "write" && this.#projectBound
      && !this.#planeStageWritesQuarantined && !this.#planeStageInFlight
      && this.#nativeRouteTransaction === undefined
      && !this.#schematicConnectivityBatchInFlight && this.#activeOperationAbortControllers.size === 0
      && this.#toolsByName.has(KICAD_PLANE_STAGE_TOOL);
  }

  /** Stage only. The owning host validates and recovers the full receipt before any durable save. */
  async stagePlane(argumentsValue: KicadPlaneStageInput): Promise<KicadPlaneStageReceipt> {
    if (this.#closed) throw new KicadMcpSessionError("KiCad MCP session is closed.");
    if (this.#mode !== "write") throw new KicadMcpAuthorizationError("KiCad MCP plane stage is a host-only write-session capability.");
    if (!this.#projectBound) throw new KicadMcpAuthorizationError("KiCad MCP project must be host-bound before plane staging.");
    this.#assertPlaneStageWriteAdmission(KICAD_PLANE_STAGE_TOOL);
    if (this.#activeOperationAbortControllers.size !== 0) throw new KicadMcpAuthorizationError("KiCad MCP plane stage requires an idle session.");
    const operation = this.#beginOperation();
    this.#planeStageInFlight = true;
    // Plane work has its own 90 s budget (native staging <= 60 s), including
    // artifact capture. Do not cap it by the startup or 30 s inspection budget.
    const deadline: InspectionDeadline = {
      deadlineAtMs: performance.now() + KICAD_PLANE_STAGE_TIMEOUT_MS,
      signal: operation.signal, hooks: undefined,
    };
    let dispatched = false;
    try {
      const tool = this.#toolsByName.get(KICAD_PLANE_STAGE_TOOL);
      if (tool === undefined) throw new KicadMcpSessionError("Pinned KiCad MCP sidecar lacks its host plane stage capability.");
      assertPlaneStageRegistration(tool);
      assertJsonValue(argumentsValue, "KiCad MCP plane stage arguments");
      const args = kicadPlaneStageInputSchema.parse(parsePortableJsonBytes(Buffer.from(JSON.stringify(argumentsValue), "utf8"), {
        maxBytes: Math.min(this.#maxMessageBytes, 16 * 1024 * 1024), maxDepth: 8, maxNodes: 4096,
        maxOwnKeys: 32, maxArrayLength: 128, maxKeyBytes: 64, maxStringBytes: 4096,
      }));
      if (!path.isAbsolute(args.board_file) || !args.board_file.isWellFormed() || FILE_URI.test(args.board_file)
          || /[\0-\x1f\x7f]/u.test(args.board_file) || path.extname(args.board_file) !== ".kicad_pcb"
          || args.board_file.split(/[\\/]+/u).some(segment => segment === "." || segment === "..")
          || !sameCanonicalPath(path.dirname(args.board_file), this.#projectRoot)) {
        throw new KicadMcpAuthorizationError("KiCad MCP plane stage requires the exact PCB file in its bound project root.");
      }
      const boardFile = await withinInspectionDeadline(
        async () => await resolveConfinedCandidate(this.#projectRoot, this.#projectRoot, args.board_file, "KiCad MCP plane stage board", true),
        deadline, "plane stage PCB binding",
      );
      if (!sameCanonicalPath(boardFile, args.board_file)) throw new KicadMcpAuthorizationError("KiCad MCP plane stage PCB path is aliased.");
      await withinInspectionDeadline(async () => await this.#assertTrustedRuntime(), deadline, "plane stage runtime check");
      await assertCanonicalAncestorChain(this.#outputRoot, "KiCad MCP plane stage artifact root", deadline);
      const saved = await captureRegularFileIdentity(boardFile, "KiCad MCP plane stage saved PCB", 1024 * 1024, deadline);
      if (saved.sizeBytes !== args.request.expectedSavedIdentity.size
          || !constantTimeDigestEqual(saved.sha256, args.request.expectedSavedIdentity.digest)) {
        throw new KicadMcpAuthorizationError("KiCad MCP plane stage saved PCB differs from the independently captured source identity.");
      }
      this.#assertPlaneStageWriteAdmission(KICAD_PLANE_STAGE_TOOL);
      assertInspectionDeadline(deadline);
      dispatched = true;
      const result = await this.#client.callTool(
        { name: KICAD_PLANE_STAGE_TOOL, arguments: args },
        { ...requestOptions(Math.max(1, Math.ceil(deadline.deadlineAtMs - performance.now())), operation.signal), toolDefinition: tool },
      );
      const reference = parsePlaneStageArtifactReference(result, this.#maxMessageBytes);
      const receipt = await withinInspectionDeadline(
        async () => await readKicadPlaneStageArtifact(this.#outputRoot, reference, args.request),
        deadline, "plane stage complete artifact read",
      );
      await assertCanonicalAncestorChain(this.#outputRoot, "KiCad MCP plane stage artifact root", deadline);
      await withinInspectionDeadline(async () => await this.#assertTrustedRuntime(), deadline, "plane stage final runtime check");
      if (!receipt.complete && (receipt.mutationDispatched || receipt.recoveryRequired)) this.#planeStageWritesQuarantined = true;
      return receipt;
    } catch (error) {
      if (dispatched) {
        this.#planeStageWritesQuarantined = true;
        throw new KicadPlaneStageMayHaveMutatedError({ cause: error });
      }
      if (error instanceof KicadMcpSessionError) throw error;
      throw new KicadMcpSessionError("KiCad MCP plane stage was rejected before dispatch.");
    } finally {
      this.#planeStageInFlight = false;
      operation.release();
    }
  }

  /** Capability/readiness only. Workflow phase and rollback admission stay with the host consumer. */
  supportsSchematicConnectivityBatch(): boolean {
    return !this.#closed && this.#mode === "write" && this.#projectBound
      && !this.#planeStageWritesQuarantined && !this.#planeStageInFlight
      && this.#nativeRouteTransaction === undefined
      && !this.#schematicConnectivityBatchInFlight
      && this.#activeOperationAbortControllers.size === 0
      && this.#toolsByName.has(SCHEMATIC_CONNECTIVITY_BATCH_TOOL);
  }

  /** Host-only mutating call. A raw disk receipt does not establish native save, reload, or connectivity. */
  async applySchematicConnectivityBatch(argumentsValue: Readonly<Record<string, unknown>>): Promise<CallToolResult> {
    if (this.#closed) throw new KicadMcpSessionError("KiCad MCP session is closed.");
    if (this.#mode !== "write") throw new KicadMcpAuthorizationError("KiCad MCP schematic connectivity batch is a host-only write-session capability.");
    if (!this.#projectBound) throw new KicadMcpAuthorizationError("KiCad MCP project must be host-bound before schematic connectivity batch mutation.");
    this.#assertPlaneStageWriteAdmission(SCHEMATIC_CONNECTIVITY_BATCH_TOOL);
    if (this.#activeOperationAbortControllers.size !== 0) throw new KicadMcpAuthorizationError("KiCad MCP schematic connectivity batch requires an idle session.");
    const operation = this.#beginOperation();
    this.#schematicConnectivityBatchInFlight = true;
    const deadline = createInspectionDeadline({ signal: operation.signal, deadlineAtMs: performance.now() + this.#timeoutMs });
    let dispatched = false;
    try {
      const tool = this.#toolsByName.get(SCHEMATIC_CONNECTIVITY_BATCH_TOOL);
      if (tool === undefined) throw new KicadMcpSessionError("Pinned KiCad MCP sidecar lacks its host schematic connectivity batch capability.");
      assertSchematicConnectivityBatchRegistration(tool);
      assertJsonValue(argumentsValue, "KiCad MCP schematic connectivity batch arguments");
      // Detach the full nested plan synchronously before any filesystem await.
      // Schema validation neither fills defaults nor coerces primitive arrays.
      const detached = parsePortableJsonBytes(Buffer.from(JSON.stringify(argumentsValue), "utf8"), {
        maxBytes: Math.min(this.#maxMessageBytes, 16 * 1024 * 1024), maxStringBytes: 1024 * 1024,
        maxDepth: 8, maxNodes: 100_000, maxOwnKeys: 16, maxKeyBytes: 64, maxArrayLength: 4096,
      });
      if (!new AjvJsonSchemaValidator().getValidator(tool.inputSchema as JsonSchemaType)(detached).valid) {
        throw new KicadMcpAuthorizationError("KiCad MCP schematic connectivity batch arguments do not match the pinned complete-plan schema.");
      }
      const args = inspectionRecord(detached, "KiCad MCP detached schematic connectivity batch");
      const projectFile = args.project_file as string;
      const schematicFile = args.schematic_file as string;
      for (const [file, suffix] of [[projectFile, ".kicad_pro"], [schematicFile, ".kicad_sch"]] as const) {
        if (!path.isAbsolute(file) || !file.isWellFormed() || /[\0-\x1f\x7f]/u.test(file) || FILE_URI.test(file)
            || file.split(/[\\/]+/u).some((segment) => segment === "." || segment === "..")
            || path.extname(file) !== suffix || !sameCanonicalPath(path.dirname(file), this.#projectRoot)) {
          throw new KicadMcpAuthorizationError("KiCad MCP schematic connectivity batch files must be exact files in the bound project root.");
        }
        const confined = await withinInspectionDeadline(
          async () => await resolveConfinedCandidate(this.#projectRoot, this.#projectRoot, file, "KiCad MCP schematic connectivity batch file", true),
          deadline, "schematic connectivity batch path binding",
        );
        if (!sameCanonicalPath(file, confined)) throw new KicadMcpAuthorizationError("KiCad MCP schematic connectivity batch file is aliased.");
      }
      if (path.basename(projectFile, ".kicad_pro") !== path.basename(schematicFile, ".kicad_sch")) {
        throw new KicadMcpAuthorizationError("KiCad MCP schematic connectivity batch project and schematic must have the same bound basename.");
      }
      await withinInspectionDeadline(async () => await this.#assertTrustedRuntime(), deadline, "schematic connectivity batch runtime check");
      const projectIdentity = await captureRegularFileIdentity(projectFile, "KiCad MCP schematic connectivity batch project", SCHEMATIC_CONNECTIVITY_BATCH_MAX_SOURCE_BYTES, deadline);
      const before = await captureRegularFileIdentity(schematicFile, "KiCad MCP schematic connectivity batch source", SCHEMATIC_CONNECTIVITY_BATCH_MAX_SOURCE_BYTES, deadline);
      if (before.sizeBytes !== args.expected_before_size_bytes || !constantTimeDigestEqual(before.sha256, args.expected_before_sha256 as string)) {
        throw new KicadMcpAuthorizationError("KiCad MCP schematic connectivity batch source does not match the independently captured before identity.");
      }
      assertInspectionDeadline(deadline);
      dispatched = true;
      const result = await this.#client.callTool(
        { name: SCHEMATIC_CONNECTIVITY_BATCH_TOOL, arguments: args },
        { ...requestOptions(Math.max(1, Math.ceil(deadline.deadlineAtMs - performance.now())), operation.signal), toolDefinition: tool },
      );
      assertJsonValue(result, "KiCad MCP schematic connectivity batch envelope");
      if (Buffer.byteLength(JSON.stringify(result), "utf8") > this.#maxMessageBytes) {
        throw new KicadMcpOutputError("KiCad MCP schematic connectivity batch exceeds the configured message limit.");
      }
      if (result.isError === true) throw new KicadMcpOutputError("KiCad MCP returned categorical schematic connectivity batch failure evidence.");
      await withinInspectionDeadline(async () => await assertExecutableIdentity(projectIdentity, "KiCad MCP schematic connectivity batch project"), deadline, "schematic connectivity batch project preservation");
      await withinInspectionDeadline(async () => await this.#assertTrustedRuntime(), deadline, "schematic connectivity batch final runtime check");
      return result;
    } catch (error) {
      const limitError = this.#stderrCapture.limitError;
      operation.release();
      let closureUnconfirmed = false;
      try { await this.close(); } catch { closureUnconfirmed = true; }
      if (closureUnconfirmed) throw new KicadMcpTerminationUncertainError(dispatched
        ? "SCHEMATIC_CONNECTIVITY_BATCH_WRITE_UNCERTAIN_TERMINAL: The mutating call failed and process closure is unconfirmed. Retain runtime evidence; host rollback is required."
        : "KiCad MCP schematic connectivity batch was not dispatched, but process closure is unconfirmed. Retain runtime evidence.");
      if (dispatched) {
        throw new KicadMcpSessionError("SCHEMATIC_CONNECTIVITY_BATCH_WRITE_UNCERTAIN_TERMINAL: The mutating call did not complete with a bounded host-verifiable receipt. Exact host rollback and session closure are required; native reload is unproven.");
      }
      if (limitError !== undefined) throw limitError;
      if (error instanceof KicadMcpSessionError) throw error;
      throw new KicadMcpSessionError("KiCad MCP schematic connectivity batch was rejected before dispatch.");
    } finally {
      this.#schematicConnectivityBatchInFlight = false;
      operation.release();
    }
  }

  /** Host-private raw protocol seam. The pad decoder owns document, source, and electrical validation. */
  async readLivePcbPadSnapshot(requestedPrimitiveIds: readonly string[]): Promise<CallToolResult> {
    if (this.#closed) throw new KicadMcpSessionError("KiCad MCP session is closed.");
    if (this.#mode !== "write") throw new KicadMcpAuthorizationError("KiCad MCP live PCB pad snapshot is a host-only write-session capability.");
    if (this.#deferredProjectBinding && !this.#projectBound) throw new KicadMcpAuthorizationError("KiCad MCP project must be host-bound before live PCB pad reads.");
    const operation = this.#beginOperation();
    try {
      const tool = this.#toolsByName.get(LIVE_PCB_PAD_SNAPSHOT_TOOL);
      if (tool === undefined) throw new KicadMcpSessionError("Pinned KiCad MCP sidecar lacks its host live PCB pad snapshot capability.");
      assertLivePcbPadSnapshotRegistration(tool);
      if (!Array.isArray(requestedPrimitiveIds) || requestedPrimitiveIds.length > LIVE_PCB_PAD_MAX_REQUESTS) {
        throw new KicadMcpAuthorizationError("KiCad MCP live PCB pad selection must be a bounded physical UUID array.");
      }
      // Copy before the first await: caller mutation must not change the exact
      // host-selected sequence while runtime identity is being checked.
      const requestedIds = [...requestedPrimitiveIds];
      const uuid = new RegExp(LIVE_PCB_PAD_UUID_PATTERN, "u");
      if (requestedIds.some((id) => typeof id !== "string" || !uuid.test(id))
          || new Set(requestedIds).size !== requestedIds.length) {
        throw new KicadMcpAuthorizationError("KiCad MCP live PCB pad selection contains an invalid or duplicate physical UUID.");
      }
      await this.#assertTrustedRuntime();
      const result = await this.#client.callTool(
        { name: LIVE_PCB_PAD_SNAPSHOT_TOOL, arguments: { requested_primitive_ids: requestedIds } },
        { ...requestOptions(this.#timeoutMs, operation.signal), toolDefinition: tool },
      );
      assertJsonValue(result, "KiCad MCP live PCB pad snapshot envelope");
      if (Buffer.byteLength(JSON.stringify(result), "utf8") > this.#maxMessageBytes) {
        throw new KicadMcpOutputError("KiCad MCP live PCB pad snapshot exceeds the configured message limit.");
      }
      if (result.isError === true) throw new KicadMcpOutputError("KiCad MCP returned categorical live PCB pad snapshot failure evidence.", this.#nativeRouteTransaction === undefined ? undefined : { cause: nativeRouteResultCause(LIVE_PCB_PAD_SNAPSHOT_TOOL, result, this.#maxMessageBytes) });
      await this.#assertTrustedRuntime();
      return result;
    } catch (error) {
      const limitError = this.#stderrCapture.limitError;
      operation.release();
      if (this.#nativeRouteTransaction !== undefined) throw this.#nativeRouteFailure(LIVE_PCB_PAD_SNAPSHOT_TOOL, limitError ?? error);
      if (!this.#closed && !this.#planeStageWritesQuarantined) await this.close().catch(() => undefined);
      if (limitError !== undefined) throw limitError;
      if (error instanceof KicadMcpSessionError) throw error;
      throw new KicadMcpSessionError("KiCad MCP live PCB pad snapshot did not complete safely.");
    } finally { operation.release(); }
  }

  /** Returns exact native serialization after live document validation; oversize/invalid source is rejected, never projected or truncated. */
  async readActivePcbSource(expectedPath: string): Promise<string> {
    if (this.#closed) throw new KicadMcpSessionError("KiCad MCP session is closed.");
    if (this.#mode !== "write") throw new KicadMcpAuthorizationError("KiCad MCP live PCB authority is a host-only write-session capability.");
    if (this.#deferredProjectBinding && !this.#projectBound) throw new KicadMcpAuthorizationError("KiCad MCP project must be host-bound before live PCB checks.");
    const operation = this.#beginOperation();
    try {
      const tool = this.#toolsByName.get(LIVE_PCB_DOCUMENT_TOOL);
      if (tool === undefined) throw new KicadMcpSessionError("Pinned KiCad MCP sidecar lacks its host live PCB document capability.");
      if (typeof expectedPath !== "string" || !expectedPath.isWellFormed() || !path.isAbsolute(expectedPath) || /[\0-\x1f\x7f]/u.test(expectedPath) || !/\.kicad_pcb$/iu.test(expectedPath)) throw new KicadMcpAuthorizationError("KiCad MCP expected live PCB must be one absolute board path.");
      await this.#assertTrustedRuntime();
      await assertCanonicalAncestorChain(this.#projectRoot, "KiCad MCP bound live PCB project");
      const expected = await resolveConfinedCandidate(this.#projectRoot, this.#projectRoot, expectedPath, "KiCad MCP expected live PCB");
      if (!sameCanonicalPath(expectedPath, expected) || !sameCanonicalPath(path.dirname(expected), this.#projectRoot)) throw new KicadMcpAuthorizationError("KiCad MCP expected live PCB differs from the bound project root.");
      if (this.#nativeRouteTransaction !== undefined && !sameCanonicalPath(expected, this.#nativeRouteTransaction.boardPath)) {
        throw new KicadMcpAuthorizationError("KiCad MCP live PCB read differs from the route transaction's bound document.");
      }
      const result = await this.#client.callTool(
        { name: LIVE_PCB_DOCUMENT_TOOL, arguments: {} },
        { ...requestOptions(this.#timeoutMs, operation.signal), toolDefinition: tool },
      );
      let snapshot: LivePcbDocumentSnapshot;
      try { snapshot = parseLivePcbDocumentSnapshot(result, this.#maxMessageBytes); }
      catch (error) {
        if (this.#nativeRouteTransaction !== undefined) throw new KicadMcpOutputError("KiCad MCP live PCB document response failed transaction readback validation.", {
          cause: { failure: error, native: nativeRouteResultCause(LIVE_PCB_DOCUMENT_TOOL, result, this.#maxMessageBytes) },
        });
        throw error;
      }
      await assertCanonicalAncestorChain(snapshot.projectPath, "KiCad MCP live PCB project");
      const liveProject = await resolveExistingDirectory(snapshot.projectPath, "KiCad MCP live PCB project");
      assertPathWithin(this.#workspaceRoot, liveProject, "KiCad MCP live PCB project", true);
      if (!sameCanonicalPath(liveProject, this.#projectRoot)) throw new KicadMcpAuthorizationError("KiCad MCP live PCB belongs to another project root.");
      const livePath = await resolveConfinedCandidate(this.#projectRoot, liveProject, snapshot.boardFilename, "KiCad MCP live PCB document");
      if (!sameCanonicalPath(path.join(liveProject, snapshot.boardFilename), livePath) || !sameCanonicalPath(livePath, expected)) throw new KicadMcpAuthorizationError("KiCad MCP live PCB does not match the exact expected board.");
      await assertCanonicalAncestorChain(this.#projectRoot, "KiCad MCP bound live PCB project");
      await this.#assertTrustedRuntime();
      this.#lastVerifiedLivePcbPath = expected;
      return snapshot.boardSource;
    } catch (error) {
      const limitError = this.#stderrCapture.limitError;
      operation.release();
      if (this.#nativeRouteTransaction !== undefined) throw this.#nativeRouteFailure(LIVE_PCB_DOCUMENT_TOOL, limitError ?? error);
      if (!this.#closed && !this.#planeStageWritesQuarantined) await this.close().catch(() => undefined);
      if (limitError !== undefined) throw limitError;
      if (error instanceof KicadMcpSessionError) throw error;
      throw new KicadMcpSessionError("KiCad MCP live PCB authority did not complete safely.");
    } finally { operation.release(); }
  }

  async callTool(
    name: string,
    argumentsValue: Readonly<Record<string, unknown>> = {},
    options: KicadMcpToolCallOptions = {},
  ): Promise<CallToolResult> {
    if (this.#closed) {
      throw new KicadMcpSessionError("KiCad MCP session is closed.");
    }
    if (this.#deferredProjectBinding && !this.#projectBound) {
      throw new KicadMcpAuthorizationError("KiCad MCP inspection project must be host-bound before tool calls.");
    }
    if (isForbiddenTool(name)) {
      throw new KicadMcpAuthorizationError(
        `Upstream manufacturing/release tool '${name}' is permanently forbidden.`,
      );
    }

    const readAllowed = this.#readAllowlist.has(name);
    const writeAllowed = this.#mode === "write" && this.#writeAllowlist.has(name);
    if (!readAllowed && !writeAllowed) {
      throw new KicadMcpAuthorizationError(
        `Tool '${name}' is not allowed in ${this.#mode} mode.`,
      );
    }
    if (writeAllowed) this.#assertPlaneStageWriteAdmission(name);
    const tool = this.#toolsByName.get(name);
    if (tool === undefined) {
      throw new KicadMcpSessionError(`Allowed tool '${name}' was not advertised by the sidecar.`);
    }
    const commitOperation = NATIVE_COMMIT_TOOL_NAMES.includes(name as typeof NATIVE_COMMIT_TOOL_NAMES[number]);
    if(name==="pcb_sync_from_schematic"&&!footprintIdentitySyncQualified(tool)){
      throw new KicadMcpAuthorizationError("KiCad MCP schematic sync requires the qualified full-footprint-library-identity writer.");
    }
    if (commitOperation && !NATIVE_COMMIT_TOOL_NAMES.every(entry => nativeCommitToolQualified(this.#toolsByName.get(entry)))) {
      throw new KicadMcpAuthorizationError("KiCad MCP qualified native route transactions are unavailable on this runtime.");
    }
    if (commitOperation && (!isPlainRecord(argumentsValue) || Object.keys(argumentsValue).length !== 0)) throw new KicadMcpAuthorizationError("KiCad MCP native commit lifecycle accepts only host-owned empty arguments.");
    if (name === "pcb_begin_commit" && this.#nativeRouteTransaction !== undefined) throw new KicadMcpAuthorizationError("KiCad MCP already has a native route transaction awaiting host completion.");
    if (name === "pcb_begin_commit" && this.#activeOperationAbortControllers.size !== 0) throw new KicadMcpAuthorizationError("KiCad MCP native route begin requires an idle session.");
    if ((name === "pcb_push_commit" || name === "pcb_drop_commit") && this.#nativeRouteTransaction === undefined) throw new KicadMcpAuthorizationError("KiCad MCP native route transaction scope is unavailable.");
    if (name === "pcb_drop_commit" && this.#nativeRouteTransaction?.phase === "beginning") throw new KicadMcpAuthorizationError("KiCad MCP native begin was not positively acknowledged; do not guess a transaction drop.");

    assertJsonValue(argumentsValue, "KiCad MCP arguments");
    await validateArgumentPaths(argumentsValue, {
      workspaceRoot: this.#workspaceRoot,
      projectRoot: this.#projectRoot,
      outputRoot: this.#outputRoot,
    });

    const timeoutMs = validatePositiveInteger(
      options.timeoutMs ?? this.#timeoutMs,
      "KiCad MCP call timeout",
    );
    if (writeAllowed) this.#assertPlaneStageWriteAdmission(name);
    const routeBoardPath = this.#nativeRouteTransaction?.boardPath ?? this.#lastVerifiedLivePcbPath;
    if (writeAllowed && (name === "pcb_begin_commit" || this.#nativeRouteTransaction !== undefined)) {
      if (routeBoardPath === undefined) throw new KicadMcpAuthorizationError("KiCad MCP requires an exact private live PCB observation before native route mutation.");
      await this.readActivePcbSource(routeBoardPath);
    }
    if (writeAllowed) this.#assertPlaneStageWriteAdmission(name);
    if (name === "pcb_begin_commit" && (this.#activeOperationAbortControllers.size !== 0
        || this.#lastVerifiedLivePcbPath === undefined || !sameCanonicalPath(this.#lastVerifiedLivePcbPath, routeBoardPath!))) {
      throw new KicadMcpAuthorizationError("KiCad MCP native route document admission changed before begin.");
    }
    const operation = this.#beginOperation(options.signal);
    try {
      await this.#assertTrustedRuntime();
      if (writeAllowed) this.#assertPlaneStageWriteAdmission(name);
      if (name === "pcb_begin_commit") {
        if (this.#nativeRouteTransaction !== undefined || this.#activeOperationAbortControllers.size !== 1
            || this.#lastVerifiedLivePcbPath === undefined || !sameCanonicalPath(this.#lastVerifiedLivePcbPath, routeBoardPath!)) {
          throw new KicadMcpAuthorizationError("KiCad MCP native route begin admission changed before dispatch.");
        }
        this.#nativeRouteTransaction = { boardPath: routeBoardPath!, phase: "beginning", quarantined: false };
      }
      const result = await this.#client.callTool(
        { name, arguments: { ...argumentsValue } },
        {
          ...requestOptions(timeoutMs, operation.signal),
          toolDefinition: tool,
        },
      );
      if (result.isError === true) {
        throw new KicadMcpOutputError("KiCad MCP returned categorical tool-failure evidence.", this.#nativeRouteTransaction === undefined ? undefined : { cause: nativeRouteResultCause(name, result, this.#maxMessageBytes) });
      }
      if (tool.outputSchema !== undefined && result.structuredContent === undefined) {
        throw new KicadMcpOutputError(
          `KiCad MCP tool '${name}' declared an output schema but returned no structured output.`,
        );
      }
      if (result.structuredContent !== undefined) {
        assertJsonValue(result.structuredContent, `KiCad MCP tool '${name}' structured output`);
      }
      await this.#assertTrustedRuntime();
      if (commitOperation && !qualifiedNativeCommitReply(result, NATIVE_COMMIT_REPLIES[name]!)) {
        throw new KicadMcpOutputError("KiCad MCP native commit lifecycle did not return its exact positive acknowledgement.", { cause: nativeRouteResultCause(name, result, this.#maxMessageBytes) });
      }
      const sanitized = sanitizeToolResult(
        result,
        [this.#workspaceRoot, this.#projectRoot, this.#outputRoot, this.#launchCwd, this.#trustedLauncher.path],
        this.#maxMessageBytes,
      );
      if (this.#nativeRouteTransaction !== undefined) {
        if (name === "pcb_begin_commit") this.#nativeRouteTransaction.phase = "open";
        else if (name === "pcb_push_commit") this.#nativeRouteTransaction.phase = "pushed";
        else if (name === "pcb_drop_commit") this.#nativeRouteTransaction.phase = "dropped";
      }
      return sanitized;
    } catch (error) {
      const limitError = this.#stderrCapture.limitError;
      operation.release();
      if (this.#nativeRouteTransaction !== undefined) throw this.#nativeRouteFailure(name, limitError ?? error);
      if (!this.#closed && !this.#planeStageWritesQuarantined) await this.close().catch(() => undefined);
      if (limitError !== undefined) throw limitError;
      if (error instanceof KicadMcpSessionError) throw error;
      throw new KicadMcpSessionError(`KiCad MCP tool '${name}' did not complete safely.`);
    } finally {
      operation.release();
    }
  }

  async #closeOnce(): Promise<void> {
    this.#closed = true;
    for (const controller of this.#activeOperationAbortControllers) controller.abort();
    const supervision = this.#processTreeSupervision;
    if (supervision === undefined) {
      try {
        await this.#client.close();
      } finally {
        this.#stderrCapture.detach();
      }
      if (!await waitForProcessExit(this.#pid)) {
        throw new KicadMcpTerminationUncertainError("KiCad MCP sidecar teardown could not be confirmed.");
      }
      return;
    }

    let treeConfirmed = false;
    try {
      // The custom transport owns the actual ChildProcess object and its
      // kernel-backed handle.  This proof is deliberately adjacent to the
      // only numeric PID use; an observed/changed root causes zero taskkill.
      await assertExecutableIdentity(supervision.terminator, "KiCad MCP process-tree terminator");
      await supervision.beforeFinalRootProofForTesting?.();
      this.#transport.assertCurrentLiveRoot(this.#pid);
      await startBoundWindowsProcessTreeTermination(supervision, this.#pid, this.#launchCwd);
      if (!await this.#transport.waitForExactRootSettlement(supervision.timeoutMs)) {
        throw new KicadMcpTerminationUncertainError("KiCad MCP exact root-process settlement was not confirmed after tree termination.");
      }
      treeConfirmed = true;
      if (!await this.#waitForOperationDrain(supervision.timeoutMs)) {
        throw new KicadMcpTerminationUncertainError("KiCad MCP active calls did not drain after process-tree termination.");
      }
      await this.#client.close().catch(() => undefined);
    } catch (error) {
      // SDK close uses the retained ChildProcess handle, not a fresh numeric
      // lookup.  It is only best-effort after a failed tree proof; callers
      // must retain mutable state and poison the bridge.
      await this.#client.close().catch(() => undefined);
      if (error instanceof KicadMcpTerminationUncertainError) throw error;
      throw new KicadMcpTerminationUncertainError("KiCad MCP process-tree teardown did not produce closed confirmation evidence.");
    } finally {
      this.#stderrCapture.detach();
    }
    if (!treeConfirmed) {
      throw new KicadMcpTerminationUncertainError("KiCad MCP process-tree teardown remained unconfirmed.");
    }
  }

  async close(): Promise<void> {
    this.#closePromise ??= this.#closeOnce();
    await this.#closePromise;
  }
}

export interface KicadMcpPinnedFileInput {
  readonly path: string;
  readonly contentIdentity: ContentIdentity;
}

export interface KicadMcpRuntimeBridgeFactoryOptions {
  readonly lockFile: KicadMcpPinnedFileInput;
  readonly runtimeBundle: {
    readonly root: string;
    readonly manifestFile: KicadMcpPinnedFileInput;
    readonly expectedClosure: KicadMcpInspectionRuntimeManifestSummary;
  };
  readonly runtimeParentRoot: string;
  readonly ipcSocketParentRoot: string;
  readonly verificationTimeoutMs: typeof KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS;
  readonly kicadCli: KicadMcpPinnedFileInput;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly processTreeSupervision: {
    readonly strategy: typeof KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY;
    readonly terminator: KicadMcpPinnedFileInput;
    readonly timeoutMs: typeof KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS;
  };
  /** Canonical Flux source/workspace/profile/toolchain roots that mutable sidecar state must never overlap. */
  readonly protectedRoots: readonly string[];
  /** Deterministic wiring seam. Production must omit it. */
  readonly connectSessionForTesting?: (options: KicadMcpSessionOptions) => Promise<KicadMcpSession>;
  /** Deterministic tree-helper seam. Production must omit it. */
  readonly processTreeRunnerForTesting?: BoundedProcessRunner;
  /** Deterministic absolute-deadline seam. Production must omit it. */
  readonly runtimeVerificationHooksForTesting?: KicadMcpRuntimeVerificationHooks;
}

export type KicadMcpInspectionBridgeFactoryOptions = KicadMcpRuntimeBridgeFactoryOptions;

export interface KicadMcpInspectionRuntimeManifestSummary {
  readonly fileCount: number;
  readonly treeIdentity: CanonicalIdentity;
  readonly manifestIdentity: CanonicalIdentity;
  readonly python: { readonly relativePath: string; readonly contentIdentity: ContentIdentity };
  readonly entrypoint: { readonly relativePath: string; readonly contentIdentity: ContentIdentity };
  readonly protocol: {
    readonly distribution: "kicad-mcp-pro";
    readonly distributionVersion: typeof KICAD_MCP_PRO_VERSION;
    readonly serverName: typeof KICAD_MCP_SERVER_NAME;
    readonly serverVersion: typeof KICAD_MCP_SERVER_VERSION;
    readonly transport: "stdio";
    readonly modes: readonly ["readonly", "write"];
  };
}

export interface KicadMcpInspectionBridgeConnectRequest {
  readonly workspaceRoot: string;
  readonly projectRoot: string;
  readonly outputRoot: string;
  readonly ipcSocket: KicadMcpInspectionIpcSocketBinding;
  readonly runBindingIdentity: CanonicalIdentity;
}

export interface KicadMcpInspectionIpcSocketBinding {
  readonly endpoint: string;
  readonly identity: CanonicalIdentity;
}

export interface KicadMcpInspectionIpcSocketStatus {
  readonly bindingIdentity: CanonicalIdentity;
  readonly remainingConnections: number;
  readonly active: boolean;
}

/** Host-only, one-use GUI launch authority; never part of a public receipt. */
export interface KicadMcpEditorLaunchContext {
  readonly endpoint: string;
  readonly tempRoot: string;
  readonly configRoot: string;
  prepareLaunch(): Promise<void>;
  observeExit(exited: Promise<unknown>): void;
}

export interface KicadMcpBoundSessionAuthority {
  readonly identity: CanonicalIdentity;
  readonly semanticIdentity: CanonicalIdentity;
  connect(options: KicadMcpSessionOptions, operation?: KicadMcpRuntimeOperationContext): Promise<KicadMcpSession>;
  disposeUnused(operation?: KicadMcpRuntimeOperationContext): Promise<"disposed" | "already_connected">;
}

export interface KicadMcpSessionAuthorityRequest {
  readonly runBindingIdentity: CanonicalIdentity;
  readonly ipcSocket: KicadMcpInspectionIpcSocketBinding;
  readonly mode: KicadMcpOperatingMode;
  readonly requiredTools: readonly string[];
  readonly roots: {
    readonly workspaceRoot: string;
    readonly projectRoot: string;
    readonly outputRoot: string;
  };
}

export interface KicadMcpRuntimeBridge {
  readonly identity: CanonicalIdentity;
  readonly inspectionBridgeIdentity: CanonicalIdentity;
  readonly executionBridgeIdentity: CanonicalIdentity;
  allocateIpcSocket(input: Readonly<{ readonly runBindingIdentity: CanonicalIdentity }>, operation?: KicadMcpRuntimeOperationContext): Promise<KicadMcpInspectionIpcSocketBinding>;
  assertIpcSocket(binding: KicadMcpInspectionIpcSocketBinding, runBindingIdentity: CanonicalIdentity, operation?: KicadMcpRuntimeOperationContext): Promise<KicadMcpInspectionIpcSocketStatus>;
  getEditorLaunchContext(binding: KicadMcpInspectionIpcSocketBinding, runBindingIdentity: CanonicalIdentity): Promise<KicadMcpEditorLaunchContext>;
  releaseIpcSocket(
    binding: KicadMcpInspectionIpcSocketBinding,
    runBindingIdentity: CanonicalIdentity,
    operation?: KicadMcpRuntimeOperationContext,
  ): Promise<"released" | "deferred_active">;
  bindSession(input: KicadMcpSessionAuthorityRequest, operation?: KicadMcpRuntimeOperationContext): Promise<KicadMcpBoundSessionAuthority>;
  connect(request: KicadMcpInspectionBridgeConnectRequest, operation?: KicadMcpRuntimeOperationContext): Promise<KicadMcpSession>;
  assertCurrent(operation?: KicadMcpRuntimeOperationContext): Promise<void>;
}

/** Compatibility name for callers migrating from the original read-only bridge. */
export type KicadMcpInspectionBridge = KicadMcpRuntimeBridge;

interface InspectionLockedFile {
  readonly filename: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly coreMetadataSha256?: string;
}

interface InspectionSidecarLock {
  readonly schemaVersion: 2;
  readonly sidecar: { readonly distribution: string; readonly version: string };
  readonly auditedSource: { readonly commit: string };
  readonly publishedDistribution: { readonly files: readonly InspectionLockedFile[] };
  readonly verifiedWindowsRuntime: {
    readonly uv: { readonly executables: { readonly uv: InspectionLockedFile; readonly uvx: InspectionLockedFile } };
    readonly python: { readonly executable: InspectionLockedFile };
    readonly observedPackageIdentity: {
      readonly distribution: string;
      readonly version: string;
      readonly wheelSha256: string;
      readonly coreMetadataSha256: string;
      readonly mcpServerInfo: { readonly name: string; readonly version: string };
    };
    readonly defaultPaths: Readonly<Record<string, string>>;
    readonly environmentOverrides: Readonly<Record<string, string>>;
    readonly offlineLaunchArgs: readonly string[];
  };
}

interface BoundInspectionDirectory {
  readonly path: string;
  readonly pathIdentity: string;
  readonly filesystem: {
    readonly device: string;
    readonly inode: string;
    readonly createdNs: string;
    readonly mode: string;
    readonly linkCount: number;
  };
}

const inspectionRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!isPlainRecord(value)) throw new KicadMcpSessionError(`${label} is not a closed record.`);
  return value;
};

const inspectionExactKeys = (
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void => {
  const keys = Object.keys(record).sort();
  const allowed = [...required, ...optional].sort();
  if (required.some((key) => !Object.hasOwn(record, key)) || keys.some((key) => !allowed.includes(key))) {
    throw new KicadMcpSessionError(`${label} contains missing or unexpected keys.`);
  }
};

const validContentPin = (value: ContentIdentity): boolean =>
  value?.algorithm === "sha256" && Number.isSafeInteger(value.size) && value.size > 0
  && /^[a-f0-9]{64}$/u.test(value.digest);

const sameContentPin = (left: ContentIdentity, right: ContentIdentity): boolean =>
  left.algorithm === "sha256" && right.algorithm === "sha256" && left.size === right.size
  && constantTimeDigestEqual(left.digest, right.digest);

async function captureRegularFileIdentity(
  filePath: string,
  label: string,
  maximumBytes: number,
  deadline?: InspectionDeadline,
): Promise<KicadMcpExpectedExecutableIdentity> {
  if (deadline !== undefined) assertInspectionDeadline(deadline);
  if (!path.isAbsolute(filePath) || /[\0\r\n]/u.test(filePath)) {
    throw new KicadMcpSessionError(`${label} must be one explicit absolute path.`);
  }
  let canonicalPath: string;
  try {
    await assertCanonicalAncestorChain(filePath, label, deadline);
    const linkMetadata = await withinInspectionDeadline(
      async () => await lstat(filePath, { bigint: true }), deadline, `${label}:path-stat`,
    );
    if (!linkMetadata.isFile() || linkMetadata.isSymbolicLink()) throw new Error("not a regular non-link file");
    canonicalPath = await withinInspectionDeadline(
      async () => await realpath(filePath), deadline, `${label}:realpath`,
    );
    if (!sameCanonicalPath(canonicalPath, filePath)) throw new Error("ancestor alias");
  } catch (error) {
    if (error instanceof KicadMcpRuntimeVerificationDeadlineError) throw error;
    throw new KicadMcpSessionError(`${label} is not a regular non-link file.`);
  }
  const handle = await withinInspectionDeadline(
    async () => await open(canonicalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)),
    deadline,
    `${label}:open`,
    async (lateHandle) => await lateHandle.close(),
  );
  try {
    const before = await withinInspectionDeadline(
      async () => await handle.stat({ bigint: true }), deadline, `${label}:descriptor-stat-before`,
    );
    if (!before.isFile() || before.size < 0n || before.size > BigInt(maximumBytes)) {
      throw new KicadMcpSessionError(`${label} is outside its byte bound.`);
    }
    const hash = createHash("sha256");
    const readAbort = new AbortController();
    const stream = handle.createReadStream({ autoClose: false, start: 0, signal: readAbort.signal });
    let streamError: unknown;
    try {
      await withinInspectionDeadline(async () => {
        for await (const chunk of stream) {
          if (deadline !== undefined) assertInspectionDeadline(deadline);
          hash.update(chunk as Buffer);
        }
      }, deadline, `${label}:stream-read`, undefined, () => readAbort.abort());
    } catch (error) {
      streamError = error;
    } finally {
      if (streamError !== undefined) {
        readAbort.abort();
        stream.destroy();
      }
      const settled = finished(stream).then(() => undefined, () => undefined);
      try { await withinInspectionDeadline(async () => await settled, deadline, `${label}:stream-settle`); }
      catch (error) { streamError ??= error; void settled.catch(() => undefined); }
    }
    if (streamError !== undefined) throw streamError;
    const after = await withinInspectionDeadline(
      async () => await handle.stat({ bigint: true }), deadline, `${label}:descriptor-stat-after`,
    );
    const pathAfter = await withinInspectionDeadline(
      async () => await lstat(canonicalPath, { bigint: true }), deadline, `${label}:path-stat-after`,
    );
    const witness = witnessFor(before);
    if (witness.linkCount !== 1) throw new KicadMcpSessionError(`${label} must have exactly one filesystem link.`);
    if (!sameWitness(witness, witnessFor(after)) || !sameWitness(witness, witnessFor(pathAfter))) {
      throw new KicadMcpSessionError(`${label} changed during identity capture.`);
    }
    return Object.freeze({ path: canonicalPath, sha256: hash.digest("hex"), sizeBytes: witness.sizeBytes, filesystem: Object.freeze(witness) });
  } finally {
    const closing = handle.close();
    try {
      await withinInspectionDeadline(async () => await closing, deadline, `${label}:close`);
    } catch (error) {
      void closing.catch(() => undefined);
      throw error;
    }
  }
}

async function captureRegularFileBytes(
  filePath: string,
  label: string,
  maximumBytes: number,
  deadline?: InspectionDeadline,
): Promise<Readonly<{ readonly bytes: Buffer; readonly physical: KicadMcpExpectedExecutableIdentity }>> {
  if (deadline !== undefined) assertInspectionDeadline(deadline);
  if (!path.isAbsolute(filePath) || /[\0\r\n]/u.test(filePath)) {
    throw new KicadMcpSessionError(`${label} must be one explicit absolute path.`);
  }
  let canonicalPath: string;
  try {
    await assertCanonicalAncestorChain(filePath, label, deadline);
    const linkMetadata = await withinInspectionDeadline(
      async () => await lstat(filePath, { bigint: true }), deadline, `${label}:path-stat`,
    );
    if (!linkMetadata.isFile() || linkMetadata.isSymbolicLink()) throw new Error("not a regular non-link file");
    canonicalPath = await withinInspectionDeadline(
      async () => await realpath(filePath), deadline, `${label}:realpath`,
    );
    if (!sameCanonicalPath(canonicalPath, filePath)) throw new Error("ancestor alias");
  } catch (error) {
    if (error instanceof KicadMcpRuntimeVerificationDeadlineError) throw error;
    throw new KicadMcpSessionError(`${label} is not a canonical regular non-link file.`);
  }
  const handle = await withinInspectionDeadline(
    async () => await open(canonicalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)),
    deadline,
    `${label}:open`,
    async (lateHandle) => await lateHandle.close(),
  );
  try {
    const before = await withinInspectionDeadline(
      async () => await handle.stat({ bigint: true }), deadline, `${label}:descriptor-stat-before`,
    );
    if (!before.isFile() || before.size < 0n || before.size > BigInt(maximumBytes)) {
      throw new KicadMcpSessionError(`${label} is outside its byte bound.`);
    }
    const chunks: Buffer[] = [];
    const hash = createHash("sha256");
    let seen = 0;
    const readAbort = new AbortController();
    const stream = handle.createReadStream({ autoClose: false, start: 0, signal: readAbort.signal });
    let streamError: unknown;
    try {
      await withinInspectionDeadline(async () => {
        for await (const chunkValue of stream) {
          if (deadline !== undefined) assertInspectionDeadline(deadline);
          const chunk = Buffer.from(chunkValue as Buffer);
          seen += chunk.byteLength;
          if (seen > maximumBytes) throw new KicadMcpSessionError(`${label} exceeded its byte bound while being read.`);
          chunks.push(chunk);
          hash.update(chunk);
        }
      }, deadline, `${label}:stream-read`, undefined, () => readAbort.abort());
    } catch (error) {
      streamError = error;
    } finally {
      if (streamError !== undefined) {
        readAbort.abort();
        stream.destroy();
      }
      const settled = finished(stream).then(() => undefined, () => undefined);
      try { await withinInspectionDeadline(async () => await settled, deadline, `${label}:stream-settle`); }
      catch (error) { streamError ??= error; void settled.catch(() => undefined); }
    }
    if (streamError !== undefined) throw streamError;
    const after = await withinInspectionDeadline(
      async () => await handle.stat({ bigint: true }), deadline, `${label}:descriptor-stat-after`,
    );
    const pathAfter = await withinInspectionDeadline(
      async () => await lstat(canonicalPath, { bigint: true }), deadline, `${label}:path-stat-after`,
    );
    const witness = witnessFor(before);
    if (witness.linkCount !== 1) throw new KicadMcpSessionError(`${label} must have exactly one filesystem link.`);
    if (seen !== witness.sizeBytes || !sameWitness(witness, witnessFor(after)) || !sameWitness(witness, witnessFor(pathAfter))) {
      throw new KicadMcpSessionError(`${label} changed during descriptor-bound capture.`);
    }
    return Object.freeze({
      bytes: Buffer.concat(chunks, seen),
      physical: Object.freeze({ path: canonicalPath, sha256: hash.digest("hex"), sizeBytes: witness.sizeBytes, filesystem: Object.freeze(witness) }),
    });
  } finally {
    const closing = handle.close();
    try { await withinInspectionDeadline(async () => await closing, deadline, `${label}:close`); }
    catch (error) { void closing.catch(() => undefined); throw error; }
  }
}

async function capturePinnedBytes(
  input: KicadMcpPinnedFileInput,
  label: string,
  maximumBytes: number,
  deadline?: InspectionDeadline,
): Promise<Readonly<{ readonly bytes: Buffer; readonly physical: KicadMcpExpectedExecutableIdentity }>> {
  if (!validContentPin(input.contentIdentity)) throw new KicadMcpSessionError(`${label} has an invalid expected content identity.`);
  const captured = await captureRegularFileBytes(input.path, label, maximumBytes, deadline);
  if (deadline !== undefined) assertInspectionDeadline(deadline);
  const physical = captured.physical;
  if (physical.sizeBytes !== input.contentIdentity.size
      || !constantTimeDigestEqual(physical.sha256, input.contentIdentity.digest)) {
    throw new KicadMcpSessionError(`${label} does not match its expected content identity.`);
  }
  const capturedContentIdentity = contentIdentity(captured.bytes);
  if (deadline !== undefined) assertInspectionDeadline(deadline);
  if (!sameContentPin(capturedContentIdentity, input.contentIdentity)) throw new KicadMcpSessionError(`${label} bytes do not match their content identity.`);
  return captured;
}

async function bindInspectionDirectory(
  directory: string,
  label: string,
  deadline?: InspectionDeadline,
): Promise<BoundInspectionDirectory> {
  if (!path.isAbsolute(directory) || /[\0\r\n]/u.test(directory)) throw new KicadMcpSessionError(`${label} must be one absolute path.`);
  let canonicalPath: string;
  let metadata: BigIntStats;
  try {
    await assertCanonicalAncestorChain(directory, label, deadline);
    metadata = await withinInspectionDeadline(
      async () => await lstat(directory, { bigint: true }), deadline, `${label}:directory-stat-before`,
    );
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("not a directory");
    canonicalPath = await withinInspectionDeadline(
      async () => await realpath(directory), deadline, `${label}:directory-realpath`,
    );
    if (!sameCanonicalPath(canonicalPath, directory)) throw new Error("ancestor alias");
    const after = await withinInspectionDeadline(
      async () => await lstat(canonicalPath, { bigint: true }), deadline, `${label}:directory-stat-after`,
    );
    const stableWitness = (value: BigIntStats) => ({
      device: value.dev.toString(10), inode: value.ino.toString(10), createdNs: value.birthtimeNs.toString(10),
      mode: value.mode.toString(10), linkCount: Number(value.nlink),
    });
    if (canonicalJson(stableWitness(metadata)) !== canonicalJson(stableWitness(after)) || metadata.nlink !== 1n) {
      throw new Error("directory witness changed or has multiple links");
    }
  } catch (error) {
    if (error instanceof KicadMcpRuntimeVerificationDeadlineError) throw error;
    throw new KicadMcpSessionError(`${label} is not an ordinary directory.`);
  }
  return Object.freeze({
    path: canonicalPath,
    pathIdentity: pathIdentity(canonicalPath),
    filesystem: Object.freeze({
      device: metadata.dev.toString(10), inode: metadata.ino.toString(10), createdNs: metadata.birthtimeNs.toString(10),
      mode: metadata.mode.toString(10), linkCount: Number(metadata.nlink),
    }),
  });
}

async function assertInspectionDirectory(
  expected: BoundInspectionDirectory,
  label: string,
  deadline?: InspectionDeadline,
): Promise<void> {
  const actual = await bindInspectionDirectory(expected.path, label, deadline);
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new KicadMcpSessionError(`${label} physical identity changed.`);
}

const inspectionLockedFile = (value: unknown, label: string, published = false): InspectionLockedFile => {
  const record = inspectionRecord(value, label);
  inspectionExactKeys(
    record,
    published ? ["filename", "packageType", "sizeBytes", "sha256", "url", "uploadedAt"] : ["filename", "sizeBytes", "sha256"],
    published ? ["coreMetadataSha256"] : [],
    label,
  );
  if (typeof record.filename !== "string" || record.filename.length < 1 || record.filename.length > 256
      || (published && record.packageType !== "bdist_wheel" && record.packageType !== "sdist")
      || (published && (typeof record.url !== "string" || typeof record.uploadedAt !== "string"))
      || !Number.isSafeInteger(record.sizeBytes) || (record.sizeBytes as number) <= 0
      || typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.sha256)
      || (record.coreMetadataSha256 !== undefined
        && (typeof record.coreMetadataSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.coreMetadataSha256)))) {
    throw new KicadMcpSessionError(`${label} has an invalid file identity.`);
  }
  return Object.freeze({
    filename: record.filename,
    sizeBytes: record.sizeBytes as number,
    sha256: record.sha256,
    ...(record.coreMetadataSha256 === undefined ? {} : { coreMetadataSha256: record.coreMetadataSha256 }),
  });
};

function parseInspectionSidecarLock(bytes: Buffer): InspectionSidecarLock {
  let value: unknown;
  try {
    value = parsePortableJsonBytes(bytes, {
      maxBytes: 256 * 1024, maxDepth: 32, maxNodes: 20_000, maxArrayLength: 1_024,
      maxOwnKeys: 256, maxKeyBytes: 256, maxStringBytes: 32 * 1024,
    });
  } catch {
    throw new KicadMcpSessionError("KiCad MCP sidecar lock is not bounded duplicate-free JSON.");
  }
  const root = inspectionRecord(value, "KiCad MCP sidecar lock");
  const sidecar = inspectionRecord(root.sidecar, "KiCad MCP lock sidecar");
  const sidecarLaunch = inspectionRecord(sidecar.launch, "KiCad MCP lock sidecar launch");
  const audited = inspectionRecord(root.auditedSource, "KiCad MCP lock audited source");
  const published = inspectionRecord(root.publishedDistribution, "KiCad MCP lock published distribution");
  const runtime = inspectionRecord(root.verifiedWindowsRuntime, "KiCad MCP lock runtime");
  const uv = inspectionRecord(runtime.uv, "KiCad MCP lock uv runtime");
  const executables = inspectionRecord(uv.executables, "KiCad MCP lock uv executables");
  const python = inspectionRecord(runtime.python, "KiCad MCP lock Python runtime");
  const observed = inspectionRecord(runtime.observedPackageIdentity, "KiCad MCP lock observed package");
  const server = inspectionRecord(observed.mcpServerInfo, "KiCad MCP lock server identity");
  const defaults = inspectionRecord(runtime.defaultPaths, "KiCad MCP lock default paths");
  const overrides = inspectionRecord(runtime.environmentOverrides, "KiCad MCP lock environment overrides");
  const controller = inspectionRecord(root.controllerPolicy, "KiCad MCP lock controller policy");
  const uvArchive = inspectionRecord(uv.archive, "KiCad MCP lock uv archive");
  const uvChecksum = inspectionRecord(uv.checksumAsset, "KiCad MCP lock uv checksum");
  const pythonArchive = inspectionRecord(python.archive, "KiCad MCP lock Python archive");
  inspectionExactKeys(root, ["schemaVersion", "sidecar", "auditedSource", "publishedDistribution", "verifiedWindowsRuntime", "controllerPolicy", "notice"], [], "KiCad MCP sidecar lock");
  inspectionExactKeys(sidecar, ["name", "distribution", "version", "launch"], [], "KiCad MCP lock sidecar");
  inspectionExactKeys(sidecarLaunch, ["command", "args"], [], "KiCad MCP lock sidecar launch");
  inspectionExactKeys(audited, ["repository", "repositoryId", "commit", "pyprojectVersion", "pythonRequires", "mcpDependency", "license", "copyright"], [], "KiCad MCP lock audited source");
  inspectionExactKeys(published, ["verifiedAgainst", "pypiLastSerial", "verifiedOn", "files", "identityCaveat"], [], "KiCad MCP lock published distribution");
  inspectionExactKeys(runtime, ["uv", "python", "observedPackageIdentity", "defaultPaths", "environmentOverrides", "offlineLaunchArgs"], [], "KiCad MCP lock runtime");
  inspectionExactKeys(uv, ["version", "upstreamPinSource", "repository", "release", "archive", "checksumAsset", "executables"], [], "KiCad MCP lock uv runtime");
  inspectionExactKeys(executables, ["uv", "uvx"], [], "KiCad MCP lock uv executables");
  inspectionExactKeys(python, ["version", "upstreamPinSource", "repository", "archive", "executable"], [], "KiCad MCP lock Python runtime");
  inspectionExactKeys(observed, ["distribution", "version", "wheelSha256", "coreMetadataSha256", "mcpServerInfo", "mcpServerInfoCaveat"], [], "KiCad MCP lock observed package");
  inspectionExactKeys(server, ["name", "version"], [], "KiCad MCP lock server identity");
  inspectionExactKeys(defaults, ["uv", "uvx", "uvArchive", "uvChecksum", "python", "pythonArchive", "wheel", "uvCache", "runtimeHome", "runtimeTemp", "runRoot"], [], "KiCad MCP lock default paths");
  inspectionExactKeys(overrides, ["uv", "uvx", "uvArchive", "uvChecksum", "python", "pythonArchive", "wheel", "uvCache", "runtimeHome", "runtimeTemp", "runRoot"], [], "KiCad MCP lock environment overrides");
  inspectionExactKeys(controller, ["defaultOperatingMode", "writeModeRequiresIsolatedWorkingCopy", "manufacturingAndReleaseToolsForbidden", "environmentInheritance", "pathConfinement", "launcherResolution", "toolDiscovery", "stderrOverflow"], [], "KiCad MCP lock controller policy");
  for (const [record, label] of [[uvArchive, "uv archive"], [uvChecksum, "uv checksum"], [pythonArchive, "Python archive"]] as const) {
    inspectionExactKeys(record, ["assetId", "filename", "sizeBytes", "sha256", "url"], [], `KiCad MCP lock ${label}`);
  }
  if (root.schemaVersion !== 2 || sidecar.distribution !== "kicad-mcp-pro" || sidecar.version !== KICAD_MCP_PRO_VERSION
      || sidecar.name !== "kicad-mcp-pro" || sidecarLaunch.command !== "uvx"
      || canonicalJson(sidecarLaunch.args) !== canonicalJson(["--from", "kicad-mcp-pro==3.33.3", "kicad-mcp-pro"])
      || audited.commit !== KICAD_MCP_PRO_AUDITED_COMMIT || observed.distribution !== "kicad-mcp-pro"
      || observed.version !== KICAD_MCP_PRO_VERSION || server.name !== KICAD_MCP_SERVER_NAME
      || server.version !== KICAD_MCP_SERVER_VERSION || !Array.isArray(published.files)
      || !Array.isArray(runtime.offlineLaunchArgs)
      || runtime.offlineLaunchArgs.length !== 7
      || canonicalJson(runtime.offlineLaunchArgs) !== canonicalJson(["--offline", "--no-config", "--python", "{python}", "--from", "{wheel}", "kicad-mcp-pro"])) {
    throw new KicadMcpSessionError("KiCad MCP sidecar lock does not match the audited production profile.");
  }
  const defaultPaths = Object.fromEntries(Object.entries(defaults).map(([key, item]) => {
    if (typeof item !== "string" || !path.isAbsolute(item) || /[\0\r\n]/u.test(item)) throw new KicadMcpSessionError("KiCad MCP lock contains an invalid runtime path.");
    return [key, item];
  }));
  const environmentOverrides = Object.fromEntries(Object.entries(overrides).map(([key, item]) => {
    if (typeof item !== "string" || !/^EVLEDA_KICAD_MCP_[A-Z0-9_]+$/u.test(item)) throw new KicadMcpSessionError("KiCad MCP lock contains an invalid override key.");
    return [key, item];
  }));
  for (const key of ["uv", "uvx", "python", "wheel", "uvCache", "runtimeHome"]) {
    if (defaultPaths[key] === undefined || environmentOverrides[key] === undefined) throw new KicadMcpSessionError("KiCad MCP lock is missing a required runtime binding.");
  }
  const files = published.files.map((item, index) => inspectionLockedFile(item, `KiCad MCP published file ${index + 1}`, true));
  if (new Set(files.map((item) => item.filename)).size !== files.length) {
    throw new KicadMcpSessionError("KiCad MCP published distribution contains duplicate filenames.");
  }
  const uvIdentity = inspectionLockedFile(executables.uv, "KiCad MCP uv executable");
  const uvxIdentity = inspectionLockedFile(executables.uvx, "KiCad MCP uvx executable");
  const pythonIdentity = inspectionLockedFile(python.executable, "KiCad MCP Python executable");
  if (typeof observed.wheelSha256 !== "string" || typeof observed.coreMetadataSha256 !== "string") {
    throw new KicadMcpSessionError("KiCad MCP observed package identity is incomplete.");
  }
  return Object.freeze({
    schemaVersion: 2,
    sidecar: Object.freeze({ distribution: "kicad-mcp-pro", version: KICAD_MCP_PRO_VERSION }),
    auditedSource: Object.freeze({ commit: KICAD_MCP_PRO_AUDITED_COMMIT }),
    publishedDistribution: Object.freeze({ files: Object.freeze(files) }),
    verifiedWindowsRuntime: Object.freeze({
      uv: Object.freeze({ executables: Object.freeze({ uv: uvIdentity, uvx: uvxIdentity }) }),
      python: Object.freeze({ executable: pythonIdentity }),
      observedPackageIdentity: Object.freeze({
        distribution: "kicad-mcp-pro", version: KICAD_MCP_PRO_VERSION,
        wheelSha256: observed.wheelSha256,
        coreMetadataSha256: observed.coreMetadataSha256,
        mcpServerInfo: Object.freeze({ name: KICAD_MCP_SERVER_NAME, version: KICAD_MCP_SERVER_VERSION }),
      }),
      defaultPaths: Object.freeze(defaultPaths),
      environmentOverrides: Object.freeze(environmentOverrides),
      offlineLaunchArgs: Object.freeze([...(runtime.offlineLaunchArgs as string[])]),
    }),
  });
}

interface InspectionRuntimeFileRecord {
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly mode: number;
}

interface InspectionRuntimeDirectoryRecord {
  readonly path: string;
  readonly mode: number;
}

interface ParsedInspectionRuntimeManifest {
  readonly summary: KicadMcpInspectionRuntimeManifestSummary;
  readonly files: readonly InspectionRuntimeFileRecord[];
  readonly directories: readonly InspectionRuntimeDirectoryRecord[];
  readonly totalBytes: number;
}

const safeRuntimeRelativePath = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length < 1 || value.length > 1_024 || value.includes("\\")
      || value.startsWith("/") || value.endsWith("/") || value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new KicadMcpSessionError(`${label} has an invalid relative path.`);
  }
  return value;
};

const parseManifestContentIdentity = (value: unknown, label: string, allowEmpty = false): ContentIdentity => {
  const record = inspectionRecord(value, label);
  inspectionExactKeys(record, ["algorithm", "digest", "size"], [], label);
  if (record.algorithm !== "sha256" || typeof record.digest !== "string" || !/^[a-f0-9]{64}$/u.test(record.digest)
      || !Number.isSafeInteger(record.size) || (record.size as number) < (allowEmpty ? 0 : 1)) {
    throw new KicadMcpSessionError(`${label} is invalid.`);
  }
  return Object.freeze({ algorithm: "sha256", digest: record.digest, size: record.size as number });
};

const parseManifestCanonicalIdentity = (value: unknown, schemaVersion: string, label: string): CanonicalIdentity => {
  const record = inspectionRecord(value, label);
  inspectionExactKeys(record, ["algorithm", "digest", "schemaVersion", "canonicalizationVersion"], [], label);
  if (record.algorithm !== "sha256" || typeof record.digest !== "string" || !/^[a-f0-9]{64}$/u.test(record.digest)
      || record.schemaVersion !== schemaVersion || record.canonicalizationVersion !== "evleda-c14n-json-v1") {
    throw new KicadMcpSessionError(`${label} is invalid.`);
  }
  return Object.freeze({
    algorithm: "sha256", digest: record.digest, schemaVersion,
    canonicalizationVersion: "evleda-c14n-json-v1",
  });
};

function parseInspectionRuntimeManifest(bytes: Buffer): ParsedInspectionRuntimeManifest {
  let value: unknown;
  try {
    value = parsePortableJsonBytes(bytes, {
      maxBytes: 8 * 1024 * 1024, maxDepth: 32, maxNodes: 250_000, maxArrayLength: 25_000,
      maxOwnKeys: 512, maxKeyBytes: 256, maxStringBytes: 128 * 1024,
    });
  } catch {
    throw new KicadMcpSessionError("KiCad MCP runtime manifest is not bounded duplicate-free JSON.");
  }
  const root = inspectionRecord(value, "KiCad MCP runtime manifest");
  inspectionExactKeys(root, [
    "schemaVersion", "classification", "platform", "distribution", "protocol", "python", "entrypoint",
    "packageMetadata", "pthPolicy", "nativeDependencyPolicy", "fileCount", "directoryCount", "totalBytes",
    "treeIdentity", "directories", "files", "identity",
  ], [], "KiCad MCP runtime manifest");
  if (root.schemaVersion !== KICAD_MCP_INSPECTION_RUNTIME_MANIFEST_SCHEMA_VERSION
      || root.classification !== "pinned-local-kicad-mcp-runtime" || root.platform !== "win32-x64") {
    throw new KicadMcpSessionError("KiCad MCP runtime manifest has an unsupported root policy.");
  }
  const distribution = inspectionRecord(root.distribution, "KiCad MCP runtime distribution");
  const protocol = inspectionRecord(root.protocol, "KiCad MCP runtime protocol");
  const python = inspectionRecord(root.python, "KiCad MCP runtime Python");
  const entrypoint = inspectionRecord(root.entrypoint, "KiCad MCP runtime entrypoint");
  const packageMetadata = inspectionRecord(root.packageMetadata, "KiCad MCP runtime package metadata");
  const pthPolicy = inspectionRecord(root.pthPolicy, "KiCad MCP runtime pth policy");
  const nativePolicy = inspectionRecord(root.nativeDependencyPolicy, "KiCad MCP runtime native policy");
  inspectionExactKeys(distribution, ["name", "version"], [], "KiCad MCP runtime distribution");
  inspectionExactKeys(protocol, ["serverName", "serverVersion", "transport", "modes"], [], "KiCad MCP runtime protocol");
  inspectionExactKeys(python, ["version", "relativePath", "contentIdentity"], [], "KiCad MCP runtime Python");
  inspectionExactKeys(entrypoint, ["relativePath", "callable", "contentIdentity"], [], "KiCad MCP runtime entrypoint");
  inspectionExactKeys(packageMetadata, ["relativePath", "consoleEntryPointRelativePath", "packages"], [], "KiCad MCP runtime package metadata");
  inspectionExactKeys(pthPolicy, ["paths", "siteCustomization", "bytecode"], [], "KiCad MCP runtime pth policy");
  inspectionExactKeys(nativePolicy, ["systemDlls", "images"], [], "KiCad MCP runtime native policy");
  if (distribution.name !== "kicad-mcp-pro" || distribution.version !== KICAD_MCP_PRO_VERSION
      || protocol.serverName !== KICAD_MCP_SERVER_NAME || protocol.serverVersion !== KICAD_MCP_SERVER_VERSION
      || protocol.transport !== "stdio" || canonicalJson(protocol.modes) !== canonicalJson(["readonly", "write"]) || python.version !== "3.13.12"
      || entrypoint.callable !== "kicad_mcp.server:_run_server_from_options"
      || pthPolicy.siteCustomization !== "forbidden" || pthPolicy.bytecode !== "forbidden"
      || !Array.isArray(packageMetadata.packages) || !Array.isArray(pthPolicy.paths)
      || !Array.isArray(nativePolicy.systemDlls) || !Array.isArray(nativePolicy.images)) {
    throw new KicadMcpSessionError("KiCad MCP runtime manifest policy does not match the closed inspection profile.");
  }
  if (!Array.isArray(root.files) || !Array.isArray(root.directories)
      || !Number.isSafeInteger(root.fileCount) || !Number.isSafeInteger(root.directoryCount)
      || !Number.isSafeInteger(root.totalBytes) || (root.totalBytes as number) < 1
      || root.fileCount !== root.files.length || root.directoryCount !== root.directories.length
      || (root.fileCount as number) < 1 || (root.fileCount as number) > 20_000
      || (root.directoryCount as number) < 1 || (root.directoryCount as number) > 5_000
      || (root.totalBytes as number) > 1024 * 1024 * 1024) {
    throw new KicadMcpSessionError("KiCad MCP runtime manifest inventory bounds are invalid.");
  }
  const files = root.files.map((item, index): InspectionRuntimeFileRecord => {
    const record = inspectionRecord(item, `KiCad MCP runtime file ${index + 1}`);
    inspectionExactKeys(record, ["path", "sizeBytes", "sha256", "mode"], [], `KiCad MCP runtime file ${index + 1}`);
    if (!Number.isSafeInteger(record.sizeBytes) || (record.sizeBytes as number) < 0 || (record.sizeBytes as number) > MAX_PINNED_EXECUTABLE_BYTES
        || typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.sha256)
        || !Number.isSafeInteger(record.mode) || (record.mode as number) < 0 || (record.mode as number) > 0o777) {
      throw new KicadMcpSessionError("KiCad MCP runtime file record is invalid.");
    }
    return Object.freeze({ path: safeRuntimeRelativePath(record.path, "KiCad MCP runtime file"), sizeBytes: record.sizeBytes as number, sha256: record.sha256, mode: record.mode as number });
  });
  const directories = root.directories.map((item, index): InspectionRuntimeDirectoryRecord => {
    const record = inspectionRecord(item, `KiCad MCP runtime directory ${index + 1}`);
    inspectionExactKeys(record, ["path", "mode"], [], `KiCad MCP runtime directory ${index + 1}`);
    if (!Number.isSafeInteger(record.mode) || (record.mode as number) < 0 || (record.mode as number) > 0o777) throw new KicadMcpSessionError("KiCad MCP runtime directory record is invalid.");
    return Object.freeze({ path: safeRuntimeRelativePath(record.path, "KiCad MCP runtime directory"), mode: record.mode as number });
  });
  const sortedFilePaths = files.map((item) => item.path).sort((left, right) => left.localeCompare(right, "en-US"));
  const sortedDirectoryPaths = directories.map((item) => item.path).sort((left, right) => left.localeCompare(right, "en-US"));
  if (new Set(sortedFilePaths).size !== files.length || new Set(sortedDirectoryPaths).size !== directories.length
      || canonicalJson(files.map((item) => item.path)) !== canonicalJson(sortedFilePaths)
      || canonicalJson(directories.map((item) => item.path)) !== canonicalJson(sortedDirectoryPaths)
      || files.reduce((sum, item) => sum + item.sizeBytes, 0) !== root.totalBytes) {
    throw new KicadMcpSessionError("KiCad MCP runtime manifest inventory is duplicate, unsorted, or inconsistent.");
  }
  const treePayload = { directories, files };
  const expectedTreeIdentity = canonicalIdentity(treePayload, KICAD_MCP_INSPECTION_RUNTIME_TREE_SCHEMA_VERSION);
  const treeIdentity = parseManifestCanonicalIdentity(root.treeIdentity, KICAD_MCP_INSPECTION_RUNTIME_TREE_SCHEMA_VERSION, "KiCad MCP runtime tree identity");
  if (canonicalJson(treeIdentity) !== canonicalJson(expectedTreeIdentity)) throw new KicadMcpSessionError("KiCad MCP runtime tree identity does not reproduce.");
  const claimedManifestIdentity = parseManifestCanonicalIdentity(root.identity, KICAD_MCP_INSPECTION_RUNTIME_MANIFEST_SCHEMA_VERSION, "KiCad MCP runtime manifest identity");
  const payload = Object.fromEntries(Object.entries(root).filter(([key]) => key !== "identity"));
  if (canonicalJson(claimedManifestIdentity) !== canonicalJson(canonicalIdentity(payload, KICAD_MCP_INSPECTION_RUNTIME_MANIFEST_SCHEMA_VERSION))) {
    throw new KicadMcpSessionError("KiCad MCP runtime manifest identity does not reproduce.");
  }
  const pythonPath = safeRuntimeRelativePath(python.relativePath, "KiCad MCP runtime Python");
  const entrypointPath = safeRuntimeRelativePath(entrypoint.relativePath, "KiCad MCP runtime entrypoint");
  const pythonIdentity = parseManifestContentIdentity(python.contentIdentity, "KiCad MCP runtime Python identity");
  const entrypointIdentity = parseManifestContentIdentity(entrypoint.contentIdentity, "KiCad MCP runtime entrypoint identity");
  const pythonFile = files.find((item) => item.path === pythonPath);
  const entrypointFile = files.find((item) => item.path === entrypointPath);
  if (pythonFile === undefined || entrypointFile === undefined
      || pythonFile.sizeBytes !== pythonIdentity.size || pythonFile.sha256 !== pythonIdentity.digest
      || entrypointFile.sizeBytes !== entrypointIdentity.size || entrypointFile.sha256 !== entrypointIdentity.digest) {
    throw new KicadMcpSessionError("KiCad MCP runtime entrypoint identities do not bind manifest files.");
  }
  const summary: KicadMcpInspectionRuntimeManifestSummary = Object.freeze({
    fileCount: files.length,
    treeIdentity,
    manifestIdentity: claimedManifestIdentity,
    python: Object.freeze({ relativePath: pythonPath, contentIdentity: pythonIdentity }),
    entrypoint: Object.freeze({ relativePath: entrypointPath, contentIdentity: entrypointIdentity }),
    protocol: Object.freeze({
      distribution: "kicad-mcp-pro", distributionVersion: KICAD_MCP_PRO_VERSION,
      serverName: KICAD_MCP_SERVER_NAME, serverVersion: KICAD_MCP_SERVER_VERSION,
      transport: "stdio", modes: Object.freeze(["readonly", "write"] as const),
    }),
  });
  return Object.freeze({ summary, files: Object.freeze(files), directories: Object.freeze(directories), totalBytes: root.totalBytes as number });
}

export function parseKicadMcpInspectionRuntimeManifestSummary(bytes: Uint8Array): KicadMcpInspectionRuntimeManifestSummary {
  return parseInspectionRuntimeManifest(Buffer.from(bytes)).summary;
}

interface VerifiedInspectionRuntimeTree {
  readonly root: BoundInspectionDirectory;
  readonly physicalFiles: ReadonlyMap<string, KicadMcpExpectedExecutableIdentity>;
  readonly physicalDirectories: ReadonlyMap<string, BoundInspectionDirectory>;
}

async function verifyInspectionRuntimeTree(
  rootPath: string,
  manifest: ParsedInspectionRuntimeManifest,
  expectedPhysical?: VerifiedInspectionRuntimeTree,
  deadline?: InspectionDeadline,
): Promise<VerifiedInspectionRuntimeTree> {
  const activeDeadline = deadline ?? createInspectionDeadline(undefined);
  assertInspectionDeadline(activeDeadline);
  const root = await bindInspectionDirectory(rootPath, "KiCad MCP inspection runtime root", activeDeadline);
  const filesByPath = new Map(manifest.files.map((item) => [item.path, item]));
  const directoriesByPath = new Map(manifest.directories.map((item) => [item.path, item]));
  const physicalFiles = new Map<string, KicadMcpExpectedExecutableIdentity>();
  const physicalDirectories = new Map<string, BoundInspectionDirectory>();
  const actualFiles: InspectionRuntimeFileRecord[] = [];
  const actualDirectories: InspectionRuntimeDirectoryRecord[] = [];
  const fileJobs: Array<{ candidate: string; relative: string; expected: InspectionRuntimeFileRecord }> = [];
  const pending = [root.path];
  while (pending.length > 0) {
    assertInspectionDeadline(activeDeadline);
    const directory = pending.pop()!;
    const entries = await withinInspectionDeadline(
      async () => await readdir(directory, { withFileTypes: true }), activeDeadline, "KiCad MCP runtime:readdir",
    );
    assertInspectionDeadline(activeDeadline);
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new KicadMcpSessionError("KiCad MCP runtime contains a link or reparse point.");
      const relative = path.relative(root.path, candidate).split(path.sep).join("/");
      safeRuntimeRelativePath(relative, "KiCad MCP runtime entry");
      if (entry.isDirectory()) {
        const expected = directoriesByPath.get(relative);
        if (expected === undefined) throw new KicadMcpSessionError("KiCad MCP runtime contains an extra directory.");
        const physical = await bindInspectionDirectory(candidate, "KiCad MCP runtime directory", activeDeadline);
        const directoryMetadata = await withinInspectionDeadline(
          async () => await lstat(candidate, { bigint: true }), activeDeadline, "KiCad MCP runtime directory:mode-stat",
        );
        const mode = Number(BigInt(directoryMetadata.mode) & 0o777n);
        if (mode !== expected.mode) throw new KicadMcpSessionError("KiCad MCP runtime directory mode differs from its manifest.");
        physicalDirectories.set(relative, physical);
        actualDirectories.push({ path: relative, mode });
        pending.push(candidate);
      } else if (entry.isFile()) {
        const expected = filesByPath.get(relative);
        if (expected === undefined) throw new KicadMcpSessionError("KiCad MCP runtime contains an extra file.");
        if (fileJobs.length >= manifest.files.length) throw new KicadMcpSessionError("KiCad MCP runtime file worklist exceeds its manifest bound.");
        fileJobs.push({ candidate, relative, expected });
      } else throw new KicadMcpSessionError("KiCad MCP runtime contains an unsupported filesystem entry.");
    }
  }
  // One call-local queue keeps the existing four readers occupied even when
  // directories contain only one file. No ancestor/content/witness check is cached.
  const readerAbort = new AbortController();
  const readerDeadline: InspectionDeadline = Object.freeze({ ...activeDeadline,
    signal: activeDeadline.signal === undefined ? readerAbort.signal : AbortSignal.any([activeDeadline.signal, readerAbort.signal]) });
  let nextFile = 0, failed = false;
  let firstFailure: unknown;
  const readFiles = async (): Promise<void> => {
    try {
      while (!failed) {
        assertInspectionDeadline(readerDeadline);
        const job = fileJobs[nextFile++];
        if (job === undefined) return;
        const { candidate, relative, expected } = job;
        const physical = await captureRegularFileIdentity(candidate, "KiCad MCP runtime file", MAX_PINNED_EXECUTABLE_BYTES, readerDeadline);
        const mode = Number(BigInt(physical.filesystem.mode) & 0o777n);
        if (physical.sizeBytes !== expected.sizeBytes || physical.sha256 !== expected.sha256 || mode !== expected.mode) {
          throw new KicadMcpSessionError("KiCad MCP runtime file differs from its manifest.");
        }
        physicalFiles.set(relative, physical);
        actualFiles.push({ path: relative, sizeBytes: physical.sizeBytes, sha256: physical.sha256, mode });
      }
    } catch (error) {
      if (!failed) { failed = true; firstFailure = error; readerAbort.abort(); }
    }
  };
  // Every worker settles under the same deadline; existing stream abort and
  // late-handle disposal remain inside captureRegularFileIdentity.
  await Promise.allSettled(Array.from({ length: Math.min(4, fileJobs.length) }, readFiles));
  if (failed) throw firstFailure;
  assertInspectionDeadline(activeDeadline);
  actualFiles.sort((left, right) => left.path.localeCompare(right.path, "en-US"));
  actualDirectories.sort((left, right) => left.path.localeCompare(right.path, "en-US"));
  assertInspectionDeadline(activeDeadline);
  if (actualFiles.length !== manifest.files.length || actualDirectories.length !== manifest.directories.length
      || canonicalJson(canonicalIdentity({ directories: actualDirectories, files: actualFiles }, KICAD_MCP_INSPECTION_RUNTIME_TREE_SCHEMA_VERSION)) !== canonicalJson(manifest.summary.treeIdentity)) {
    throw new KicadMcpSessionError("KiCad MCP runtime tree is missing manifest entries or has a different aggregate identity.");
  }
  const verified = Object.freeze({ root, physicalFiles, physicalDirectories });
  if (expectedPhysical !== undefined) {
    if (canonicalJson(root) !== canonicalJson(expectedPhysical.root)
        || [...physicalFiles].some(([relative, identity]) => canonicalJson(identity) !== canonicalJson(expectedPhysical.physicalFiles.get(relative)))
        || [...physicalDirectories].some(([relative, identity]) => canonicalJson(identity) !== canonicalJson(expectedPhysical.physicalDirectories.get(relative)))) {
      throw new KicadMcpSessionError("KiCad MCP runtime physical witnesses changed after verification.");
    }
  }
  assertInspectionDeadline(activeDeadline);
  return verified;
}

/** Build the only production KiCad-MCP runtime accepted by Flux's read/write IPC boundary. */
export async function createKicadMcpRuntimeBridge(
  input: KicadMcpRuntimeBridgeFactoryOptions,
): Promise<KicadMcpRuntimeBridge> {
  const environment = Object.freeze({ ...input.environment });
  const factoryDeadline = createInspectionDeadline(undefined, input.runtimeVerificationHooksForTesting);
  if (!Array.isArray(input.protectedRoots)) throw new KicadMcpSessionError("KiCad MCP protected roots must be an array.");
  const protectedRootInputs = [...input.protectedRoots].map((item) => String(item));
  if (protectedRootInputs.length < 1 || protectedRootInputs.length > 32) {
    throw new KicadMcpSessionError("KiCad MCP inspection bridge requires a bounded nonempty protected-root set.");
  }
  const lockInput = Object.freeze({ path: String(input.lockFile.path), contentIdentity: { ...input.lockFile.contentIdentity } });
  const cliInput = Object.freeze({ path: String(input.kicadCli.path), contentIdentity: { ...input.kicadCli.contentIdentity } });
  const manifestInput = Object.freeze({ path: String(input.runtimeBundle.manifestFile.path), contentIdentity: { ...input.runtimeBundle.manifestFile.contentIdentity } });
  const terminatorInput = Object.freeze({
    path: String(input.processTreeSupervision.terminator.path),
    contentIdentity: { ...input.processTreeSupervision.terminator.contentIdentity },
  });
  if (input.processTreeSupervision.strategy !== KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY
      || input.processTreeSupervision.timeoutMs !== KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS) {
    throw new KicadMcpSessionError("KiCad MCP inspection bridge process-tree policy does not match the fixed production policy.");
  }
  const lockCapture = await capturePinnedBytes(lockInput, "KiCad MCP sidecar lock", 256 * 1024, factoryDeadline);
  assertInspectionDeadline(factoryDeadline);
  const lock = parseInspectionSidecarLock(lockCapture.bytes);
  assertInspectionDeadline(factoryDeadline);
  const manifestCapture = await capturePinnedBytes(manifestInput, "KiCad MCP inspection runtime manifest", 8 * 1024 * 1024, factoryDeadline);
  assertInspectionDeadline(factoryDeadline);
  const manifest = parseInspectionRuntimeManifest(manifestCapture.bytes);
  assertInspectionDeadline(factoryDeadline);
  if (canonicalJson(manifest.summary) !== canonicalJson(input.runtimeBundle.expectedClosure)) {
    throw new KicadMcpSessionError("KiCad MCP runtime manifest summary does not match the production profile closure.");
  }
  if (lock.sidecar.distribution !== manifest.summary.protocol.distribution
      || lock.sidecar.version !== manifest.summary.protocol.distributionVersion
      || lock.verifiedWindowsRuntime.observedPackageIdentity.mcpServerInfo.name !== manifest.summary.protocol.serverName
      || lock.verifiedWindowsRuntime.observedPackageIdentity.mcpServerInfo.version !== manifest.summary.protocol.serverVersion) {
    throw new KicadMcpSessionError("KiCad MCP runtime manifest does not match the audited sidecar lock provenance.");
  }
  if (input.verificationTimeoutMs !== KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS) {
    throw new KicadMcpSessionError("KiCad MCP inspection verification timeout must match the fixed production policy.");
  }
  const [runtimeTree, kicadCli, runtimeParent, ipcSocketParent, processTreeTerminator] = await Promise.all([
    verifyInspectionRuntimeTree(String(input.runtimeBundle.root), manifest, undefined, factoryDeadline),
    captureExecutableIdentity(cliInput.path, "KiCad CLI executable", factoryDeadline),
    bindInspectionDirectory(String(input.runtimeParentRoot), "KiCad MCP private runtime parent", factoryDeadline),
    bindInspectionDirectory(String(input.ipcSocketParentRoot), "KiCad MCP IPC socket parent", factoryDeadline),
    captureExecutableIdentity(terminatorInput.path, "KiCad MCP process-tree terminator", factoryDeadline),
  ]);
  const protectedRoots = await Promise.all(protectedRootInputs.map(async (root, index) =>
    await bindInspectionDirectory(root, `KiCad MCP protected root ${index + 1}`, factoryDeadline)));
  assertInspectionDeadline(factoryDeadline);
  if (!validContentPin(cliInput.contentIdentity) || kicadCli.sizeBytes !== cliInput.contentIdentity.size
      || !constantTimeDigestEqual(kicadCli.sha256, cliInput.contentIdentity.digest)) {
    throw new KicadMcpSessionError("KiCad CLI executable does not match its production content identity.");
  }
  if (!validContentPin(terminatorInput.contentIdentity)
      || processTreeTerminator.sizeBytes !== terminatorInput.contentIdentity.size
      || !constantTimeDigestEqual(processTreeTerminator.sha256, terminatorInput.contentIdentity.digest)) {
    throw new KicadMcpSessionError("KiCad MCP process-tree terminator does not match its production content identity.");
  }
  const boundProcessTreeSupervision = await bindWindowsProcessTreeSupervision({
    strategy: KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY,
    terminator: processTreeTerminator,
    timeoutMs: KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
    ...(input.processTreeRunnerForTesting === undefined ? {} : { processRunnerForTesting: input.processTreeRunnerForTesting }),
  }, environment);
  if (boundProcessTreeSupervision === undefined) throw new KicadMcpSessionError("KiCad MCP process-tree supervision is unavailable.");
  const runtimePython = runtimeTree.physicalFiles.get(manifest.summary.python.relativePath);
  const runtimeEntrypoint = runtimeTree.physicalFiles.get(manifest.summary.entrypoint.relativePath);
  if (runtimePython === undefined || runtimeEntrypoint === undefined) throw new KicadMcpSessionError("KiCad MCP runtime entrypoint files are unavailable.");
  const terminatorRelativePath = path.relative(runtimeTree.root.path, processTreeTerminator.path).split(path.sep).join("/");
  const runtimeTerminator = runtimeTree.physicalFiles.get(terminatorRelativePath);
  if (!isPathWithin(runtimeTree.root.path, processTreeTerminator.path, false)
      || runtimeTerminator === undefined
      || canonicalJson(runtimeTerminator) !== canonicalJson(processTreeTerminator)) {
    throw new KicadMcpSessionError("KiCad MCP process-tree terminator is not an exact manifest-bound runtime file.");
  }
  const authorityPaths = [
    runtimeTree.root.path, lockCapture.physical.path, manifestCapture.physical.path, kicadCli.path, processTreeTerminator.path,
    ...protectedRoots.map((root) => root.path),
  ];
  if (authorityPaths.some((authority) =>
    isPathWithin(runtimeParent.path, authority, true) || isPathWithin(authority, runtimeParent.path, true)
    || isPathWithin(ipcSocketParent.path, authority, true) || isPathWithin(authority, ipcSocketParent.path, true))
      || isPathWithin(runtimeParent.path, ipcSocketParent.path, true)
      || isPathWithin(ipcSocketParent.path, runtimeParent.path, true)) {
    throw new KicadMcpSessionError("KiCad MCP private runtime parent overlaps a protected authority path.");
  }
  const baseArgs = ["-I", "-s", "-E", "-B", runtimeEntrypoint.path] as const;

  const publicFile = (value: KicadMcpExpectedExecutableIdentity) => ({
    pathIdentity: pathIdentity(value.path), sha256: value.sha256, sizeBytes: value.sizeBytes,
    filesystem: value.filesystem,
  });
  const identityPayload = {
    schemaVersion: KICAD_MCP_RUNTIME_IDENTITY_SCHEMA_VERSION,
    classification: "candidate-kicad-mcp-runtime" as const,
    supportedModes: ["readonly", "write"] as const,
    lockContentIdentity: lockInput.contentIdentity,
    runtimeManifestContentIdentity: manifestInput.contentIdentity,
    runtimeManifestIdentity: manifest.summary.manifestIdentity,
    runtimeTreeIdentity: manifest.summary.treeIdentity,
    runtimeFileCount: manifest.summary.fileCount,
    auditedCommit: KICAD_MCP_PRO_AUDITED_COMMIT,
    distribution: { name: "kicad-mcp-pro", version: KICAD_MCP_PRO_VERSION, runtimeStrategy: "direct-manifest-bundle-v1" },
    protocol: { name: KICAD_MCP_SERVER_NAME, version: KICAD_MCP_SERVER_VERSION, transport: "stdio" },
    executables: {
      python: publicFile(runtimePython), entrypoint: publicFile(runtimeEntrypoint),
      kicadCli: publicFile(kicadCli), processTreeTerminator: publicFile(processTreeTerminator),
    },
    launch: {
      argumentsSha256: argumentIdentity(baseArgs), argumentCount: baseArgs.length,
      workingDirectory: "fresh-private" as const, projectBinding: "post-connect-protocol" as const,
      workspaceBinding: "host-validated-at-startup" as const,
      environmentFiles: "disabled" as const, bytecodeWrites: "disabled" as const,
      verificationTimeoutMs: KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS,
      processTreeSupervision: {
        strategy: KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY,
        rootProof: "exact-child-process-handle-immediately-before-spawn" as const,
        earlyRootExit: "zero-numeric-signal-retain-poison" as const,
        activeCalls: "fence-abort-drain-before-cleanup" as const,
        confirmation: "taskkill-success-plus-exact-root-exit-and-close" as const,
        terminationTimeoutMs: KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
        runtimeCleanup: "after-tree-confirmation-and-runtime-revalidation-only" as const,
        unconfirmed: "retain-poison-no-retry" as const,
      },
      ipcSocketPolicy: {
        schemaVersion: KICAD_MCP_IPC_SOCKET_BINDING_SCHEMA_VERSION,
        parentPathIdentity: ipcSocketParent.pathIdentity,
        parentFilesystem: ipcSocketParent.filesystem,
        allocation: "unique-per-run" as const,
        scheme: "ipc" as const,
        maxEndpointBytes: KICAD_MCP_IPC_SOCKET_MAX_ENDPOINT_BYTES,
        maxConnections: KICAD_MCP_IPC_SOCKET_MAX_CONNECTIONS,
        concurrency: 1,
        editorListener: "private-temp-kicad-api-sock" as const,
        editorConfig: "private-kicad-10-api-enabled-offline-startup" as const,
        editorCache: "private-empty-cache" as const,
        reuse: "same-live-run-bounded" as const,
        restart: "fail-closed-reallocate-reapprove" as const,
        cleanup: "after-confirmed-session-and-editor-stop" as const,
        unconfirmed: "retain-poison-no-retry" as const,
      },
    },
    capabilityPolicies: {
      inspection: {
        mode: "readonly" as const,
        readToolAllowlist: [...KICAD_MCP_INSPECTION_TOOL_ALLOWLIST],
        writeToolAllowlist: [] as const,
      },
      execution: {
        mode: "write" as const,
        readToolAllowlist: [...KICAD_MCP_READ_TOOL_ALLOWLIST],
        writeToolAllowlist: [...KICAD_MCP_WRITE_TOOL_ALLOWLIST],
        projectAuthorization: "exactly-one-of-isolated-copy-or-verified-fresh" as const,
      },
      forbiddenTools: [...KICAD_MCP_FORBIDDEN_TOOL_NAMES],
      manufacturingAndReleaseTools: "permanently-forbidden" as const,
    },
    environmentPolicy: {
      inheritedDefaults: "masked" as const,
      keys: [...new Set([...DEFAULT_INHERITED_ENV_VARS, "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "HOME", "KICAD_CONFIG_HOME", "XDG_CACHE_HOME", "KICAD_API_SOCKET", "KICAD_MCP_KICAD_SOCKET_PATH", "PYTHONNOUSERSITE", "PYTHONSAFEPATH", "PYTHONDONTWRITEBYTECODE", "PYTHON_DOTENV_DISABLED"])].sort(),
      pathIdentities: {
        runtimeParent: runtimeParent.pathIdentity,
        runtimeBundle: runtimeTree.root.pathIdentity, python: pathIdentity(runtimePython.path), kicadCli: pathIdentity(kicadCli.path),
        processTreeTerminator: pathIdentity(processTreeTerminator.path),
        ipcSocketParent: ipcSocketParent.pathIdentity,
      },
      protectedRootPathIdentities: protectedRoots.map((root) => root.pathIdentity).sort(),
    },
  };
  const kicadMcpRuntimeIdentity = canonicalIdentity(identityPayload, KICAD_MCP_RUNTIME_IDENTITY_SCHEMA_VERSION);
  const inspectionBridgeIdentity = canonicalIdentity({
    schemaVersion: KICAD_MCP_INSPECTION_BRIDGE_SCHEMA_VERSION,
    runtimeIdentity: kicadMcpRuntimeIdentity,
    capabilityPolicy: identityPayload.capabilityPolicies.inspection,
    forbiddenTools: identityPayload.capabilityPolicies.forbiddenTools,
  }, KICAD_MCP_INSPECTION_BRIDGE_SCHEMA_VERSION);
  const executionBridgeIdentity = canonicalIdentity({
    schemaVersion: KICAD_MCP_EXECUTION_BRIDGE_SCHEMA_VERSION,
    runtimeIdentity: kicadMcpRuntimeIdentity,
    capabilityPolicy: identityPayload.capabilityPolicies.execution,
    forbiddenTools: identityPayload.capabilityPolicies.forbiddenTools,
    manufacturingAndReleaseTools: identityPayload.capabilityPolicies.manufacturingAndReleaseTools,
  }, KICAD_MCP_EXECUTION_BRIDGE_SCHEMA_VERSION);
  let poisoned = false;
  const sessionRuntimePrefix = "evleda-kicad-inspection-";

  interface IpcSocketState {
    readonly binding: KicadMcpInspectionIpcSocketBinding;
    readonly runBindingIdentity: CanonicalIdentity;
    readonly directory: BoundInspectionDirectory;
    readonly listenerDirectory: BoundInspectionDirectory;
    readonly configDirectory: BoundInspectionDirectory;
    readonly versionConfigDirectory: BoundInspectionDirectory;
    readonly cacheDirectory: BoundInspectionDirectory;
    readonly initialConfigFiles: readonly KicadMcpExpectedExecutableIdentity[];
    readonly socketPath: string;
    editorLaunchClaimed: boolean;
    editorExitObserved: boolean;
    editorExitBound: boolean;
    active: boolean;
    connectionCount: number;
    released: boolean;
    readonly sessionAllocations: Set<SessionRuntimeAllocation>;
    operationTail: Promise<void>;
  }
  interface SessionRuntimeAllocation {
    readonly root: BoundInspectionDirectory;
    readonly home: BoundInspectionDirectory;
    readonly appData: BoundInspectionDirectory;
    readonly localAppData: BoundInspectionDirectory;
    readonly roamingAppData: BoundInspectionDirectory;
    readonly cache: BoundInspectionDirectory;
    readonly cwd: BoundInspectionDirectory;
    readonly temp: BoundInspectionDirectory;
    readonly config: BoundInspectionDirectory;
    used: boolean;
    disposed: boolean;
  }
  interface BoundAuthorityRoots {
    readonly workspaceRoot: string;
    readonly projectRoot: string;
    readonly outputRoot: string;
    readonly identities: {
      readonly workspacePathIdentity: string;
      readonly projectPathIdentity: string;
      readonly outputPathIdentity: string;
    };
    readonly physicalDirectories: {
      readonly workspace: BoundInspectionDirectory;
      readonly project: BoundInspectionDirectory;
    };
  }
  const ipcSocketStates = new WeakMap<KicadMcpInspectionIpcSocketBinding, IpcSocketState>();
  const withSocketStateLock = async <Result>(
    state: IpcSocketState,
    deadline: InspectionDeadline,
    operation: () => Promise<Result>,
  ): Promise<Result> => {
    const previous = state.operationTail;
    let unlock!: () => void;
    state.operationTail = new Promise<void>((resolve) => { unlock = resolve; });
    try {
      await withinInspectionDeadline(async () => await previous, deadline, "KiCad MCP socket operation-tail wait");
    } catch (error) {
      poisoned = true;
      // This caller returns immediately, but its queue node must remain behind
      // the predecessor. Otherwise a later caller could bypass still-running
      // authority work merely because this waiter timed out.
      void previous.then(unlock, unlock);
      throw error;
    }
    try { return await operation(); }
    catch (error) {
      if (error instanceof KicadMcpRuntimeVerificationDeadlineError) poisoned = true;
      throw error;
    } finally { unlock(); }
  };
  const assertMutationAuthority = async (deadline: InspectionDeadline, label: string): Promise<void> => {
    await withinInspectionDeadline(async () => undefined, deadline, `KiCad MCP authority checkpoint:${label}`);
    assertInspectionDeadline(deadline);
    if (poisoned) {
      throw new KicadMcpTerminationUncertainError("KiCad MCP runtime was poisoned before an authority mutation.");
    }
  };

  const assertCurrentWithin = async (deadline: InspectionDeadline): Promise<void> => {
    if (poisoned) throw new KicadMcpTerminationUncertainError("KiCad MCP inspection bridge is poisoned after uncertain teardown or authority drift.");
    try {
      assertInspectionDeadline(deadline);
      const currentLock = await capturePinnedBytes(lockInput, "KiCad MCP sidecar lock", 256 * 1024, deadline);
      if (canonicalJson(currentLock.physical) !== canonicalJson(lockCapture.physical)) throw new KicadMcpSessionError("KiCad MCP sidecar lock physical identity changed.");
      assertInspectionDeadline(deadline);
      const currentManifest = await capturePinnedBytes(manifestInput, "KiCad MCP inspection runtime manifest", 8 * 1024 * 1024, deadline);
      if (canonicalJson(currentManifest.physical) !== canonicalJson(manifestCapture.physical)) throw new KicadMcpSessionError("KiCad MCP runtime manifest physical identity changed.");
      assertInspectionDeadline(deadline);
      await verifyInspectionRuntimeTree(runtimeTree.root.path, manifest, runtimeTree, deadline);
      await Promise.all([
        assertExecutableIdentity(kicadCli, "KiCad CLI executable", deadline),
        assertExecutableIdentity(processTreeTerminator, "KiCad MCP process-tree terminator", deadline),
        assertInspectionDirectory(runtimeParent, "KiCad MCP private runtime parent", deadline),
        assertInspectionDirectory(ipcSocketParent, "KiCad MCP IPC socket parent", deadline),
      ]);
      // The checkpoint AbortSignal is shared across this whole verification.
      // Keep the fixed four-item base batch concurrent, then verify the bounded
      // protected-root set sequentially to stay below Node's default
      // AbortSignal listener warning threshold.
      for (const [index, root] of protectedRoots.entries()) {
        assertInspectionDeadline(deadline);
        await assertInspectionDirectory(root, `KiCad MCP protected root ${index + 1}`, deadline);
      }
      assertInspectionDeadline(deadline);
      if (poisoned) throw new KicadMcpTerminationUncertainError("KiCad MCP runtime was poisoned by a concurrent uncertain verification.");
    } catch (error) {
      poisoned = true;
      throw error;
    }
  };

  const assertCurrent = async (operation?: KicadMcpRuntimeOperationContext): Promise<void> => {
    await assertCurrentWithin(createInspectionDeadline(operation, input.runtimeVerificationHooksForTesting));
  };

  const assertSocketPathAbsent = async (socketPath: string, deadline?: InspectionDeadline): Promise<void> => {
    try {
      await withinInspectionDeadline(
        async () => await lstat(socketPath), deadline, "KiCad MCP IPC socket collision stat",
      );
      throw new KicadMcpSessionError("KiCad IPC socket path collides with an existing filesystem entry.");
    } catch (error) {
      if (error instanceof KicadMcpRuntimeVerificationDeadlineError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };

  const stateForSocket = (
    binding: KicadMcpInspectionIpcSocketBinding,
    runBindingIdentity: CanonicalIdentity,
  ): IpcSocketState => {
    validateIpcSocketBindingShape(binding);
    if (!validCanonicalIdentityForSchema(runBindingIdentity)) {
      throw new KicadMcpAuthorizationError("KiCad IPC run binding identity is invalid.");
    }
    const state = ipcSocketStates.get(binding);
    if (state === undefined || state.binding !== binding || state.released
        || canonicalJson(state.runBindingIdentity) !== canonicalJson(runBindingIdentity)) {
      throw new KicadMcpAuthorizationError("KiCad IPC socket binding is forged, released, or belongs to another run.");
    }
    return state;
  };

  const assertIpcSocketWithin = async (
    binding: KicadMcpInspectionIpcSocketBinding,
    runBindingIdentity: CanonicalIdentity,
    deadline: InspectionDeadline,
  ): Promise<KicadMcpInspectionIpcSocketStatus> => {
    const state = stateForSocket(binding, runBindingIdentity);
    await Promise.all([
      assertInspectionDirectory(ipcSocketParent, "KiCad MCP IPC socket parent", deadline),
      assertInspectionDirectory(state.directory, "KiCad MCP IPC socket allocation", deadline),
      assertInspectionDirectory(state.listenerDirectory, "KiCad MCP editor listener directory", deadline),
      assertInspectionDirectory(state.configDirectory, "KiCad MCP editor config directory", deadline),
      assertInspectionDirectory(state.versionConfigDirectory, "KiCad MCP editor version config directory", deadline),
      assertInspectionDirectory(state.cacheDirectory, "KiCad MCP editor cache directory", deadline),
      assertSocketPathAbsent(state.socketPath, deadline),
    ]);
    if (binding.endpoint !== `ipc://${state.socketPath}`) {
      throw new KicadMcpAuthorizationError("KiCad IPC socket endpoint changed after allocation.");
    }
    return Object.freeze({
      bindingIdentity: binding.identity,
      remainingConnections: KICAD_MCP_IPC_SOCKET_MAX_CONNECTIONS - state.connectionCount,
      active: state.active,
    });
  };

  const assertIpcSocket = async (
    binding: KicadMcpInspectionIpcSocketBinding,
    runBindingIdentity: CanonicalIdentity,
    operation?: KicadMcpRuntimeOperationContext,
  ): Promise<KicadMcpInspectionIpcSocketStatus> => {
    if (poisoned) throw new KicadMcpTerminationUncertainError("KiCad MCP runtime is poisoned after uncertain verification.");
    const deadline = createInspectionDeadline(operation, input.runtimeVerificationHooksForTesting);
    try { return await assertIpcSocketWithin(binding, runBindingIdentity, deadline); }
    catch (error) {
      if (error instanceof KicadMcpTerminationUncertainError) poisoned = true;
      throw error;
    }
  };

  const getEditorLaunchContext = async (
    binding: KicadMcpInspectionIpcSocketBinding,
    runBindingIdentity: CanonicalIdentity,
  ): Promise<KicadMcpEditorLaunchContext> => {
    const state = stateForSocket(binding, runBindingIdentity);
    await assertIpcSocket(binding, runBindingIdentity);
    return Object.freeze({
      endpoint: binding.endpoint,
      tempRoot: state.directory.path,
      configRoot: state.configDirectory.path,
      prepareLaunch: async () => {
        const deadline = createInspectionDeadline(undefined, input.runtimeVerificationHooksForTesting);
        await withSocketStateLock(state, deadline, async () => {
          if (poisoned || state.editorLaunchClaimed) throw new KicadMcpAuthorizationError("KiCad editor launch authority is unavailable or already claimed.");
          await assertIpcSocketWithin(binding, runBindingIdentity, deadline);
          for (const expected of state.initialConfigFiles) {
            const currentConfig = await captureRegularFileIdentity(expected.path, "KiCad MCP initial editor config", 64 * 1024, deadline);
            if (canonicalJson(currentConfig) !== canonicalJson(expected)) {
              throw new KicadMcpAuthorizationError("KiCad editor startup config changed before launch.");
            }
          }
          for (const [directory, expectedNames] of [
            [state.directory, ["cache", "config", "kicad"]],
            [state.listenerDirectory, []],
            [state.configDirectory, ["10.0"]],
            [state.versionConfigDirectory, state.initialConfigFiles.map((file) => path.basename(file.path))],
          ] as const) {
            const names = await withinInspectionDeadline(async () => await readdir(directory.path), deadline, "KiCad MCP initial editor allocation readdir");
            if (canonicalJson(names.sort()) !== canonicalJson([...expectedNames].sort())) {
              throw new KicadMcpAuthorizationError("KiCad editor startup config changed before launch.");
            }
          }
          const cacheEntries = await withinInspectionDeadline(async () => await readdir(state.cacheDirectory.path), deadline, "KiCad MCP initial editor cache readdir");
          if (cacheEntries.length !== 0) throw new KicadMcpAuthorizationError("KiCad editor cache changed before launch.");
          await assertMutationAuthority(deadline, "before-editor-launch-claim");
          // A rejected launcher without an exit witness leaves this allocation
          // retained: an unobserved GUI must never lose its temp/config tree.
          state.editorLaunchClaimed = true;
        });
      },
      observeExit: (exited: Promise<unknown>) => {
        if (!state.editorLaunchClaimed || state.editorExitBound || typeof exited?.then !== "function") {
          throw new KicadMcpAuthorizationError("KiCad editor exit witness does not match one claimed launch.");
        }
        state.editorExitBound = true;
        void exited.then(() => { state.editorExitObserved = true; }, () => { poisoned = true; });
      },
    });
  };

  const removeIpcAllocationTree = async (directory: BoundInspectionDirectory, deadline: InspectionDeadline): Promise<void> => {
    if (!isPathWithin(ipcSocketParent.path, directory.path, false)
        || !sameCanonicalPath(path.dirname(directory.path), ipcSocketParent.path)
        || !/^e-[A-Za-z0-9_-]{1,29}$/u.test(path.basename(directory.path))) {
      throw new KicadMcpTerminationUncertainError("KiCad editor cleanup target is not one owned IPC allocation.");
    }
    await assertInspectionDirectory(ipcSocketParent, "KiCad MCP IPC cleanup parent", deadline);
    await assertInspectionDirectory(directory, "KiCad MCP IPC cleanup allocation", deadline);
    const pending = [directory];
    const checkedDirectories: BoundInspectionDirectory[] = [];
    let entryCount = 0;
    while (pending.length > 0) {
      const current = pending.pop()!;
      await assertInspectionDirectory(current, "KiCad MCP editor cleanup directory", deadline);
      checkedDirectories.push(current);
      const entries = await withinInspectionDeadline(async () => await readdir(current.path, { withFileTypes: true }), deadline, "KiCad MCP editor cleanup readdir");
      for (const entry of entries) {
        if (++entryCount > 4096) throw new KicadMcpTerminationUncertainError("KiCad editor cleanup tree exceeds its bounded entry limit.");
        const candidate = path.join(current.path, entry.name);
        if (!isPathWithin(directory.path, candidate, false) || path.relative(directory.path, candidate).split(path.sep).length > 32) {
          throw new KicadMcpTerminationUncertainError("KiCad editor cleanup entry escaped its allocation.");
        }
        const metadata = await withinInspectionDeadline(async () => await lstat(candidate, { bigint: true }), deadline, "KiCad MCP editor cleanup entry stat");
        if (metadata.isSymbolicLink() || metadata.nlink !== 1n || (!metadata.isDirectory() && !metadata.isFile())) {
          throw new KicadMcpTerminationUncertainError("KiCad editor cleanup contains a link or unsupported entry; allocation retained.");
        }
        if (metadata.isDirectory()) pending.push(await bindInspectionDirectory(candidate, "KiCad MCP editor cleanup child", deadline));
      }
    }
    for (const current of checkedDirectories) await assertInspectionDirectory(current, "KiCad MCP editor cleanup final directory", deadline);
    await assertInspectionDirectory(ipcSocketParent, "KiCad MCP IPC cleanup parent", deadline);
    await assertInspectionDirectory(directory, "KiCad MCP IPC cleanup allocation", deadline);
    await withinInspectionDeadline(async () => await rm(directory.path, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 }), deadline, "KiCad MCP owned editor allocation removal");
    try {
      await withinInspectionDeadline(async () => await lstat(directory.path), deadline, "KiCad MCP owned editor allocation removal stat");
      throw new KicadMcpTerminationUncertainError("KiCad editor allocation removal was not confirmed.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };

  const disposeLateIpcAllocation = async (directoryPath: string): Promise<void> => {
    try {
      if (!isPathWithin(ipcSocketParent.path, directoryPath, false)
          || !sameCanonicalPath(path.dirname(directoryPath), ipcSocketParent.path)
          || !path.basename(directoryPath).startsWith("e-")
          || path.basename(directoryPath).length > 32) {
        throw new Error("late IPC allocation escaped its authority");
      }
      await assertInspectionDirectory(ipcSocketParent, "KiCad MCP late IPC parent");
      const directory = await bindInspectionDirectory(directoryPath, "KiCad MCP late IPC allocation");
      if ((await readdir(directory.path)).length !== 0) {
        throw new Error("late IPC allocation is not empty");
      }
      await assertInspectionDirectory(directory, "KiCad MCP late IPC allocation");
      await rmdir(directory.path);
      try {
        await lstat(directory.path);
        throw new Error("late IPC allocation removal was not confirmed");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } catch {
      // The originating timeout already poisoned the bridge. Retain any
      // non-empty or unverifiable late result for forensic cleanup.
      poisoned = true;
    }
  };

  const allocateIpcSocket = async (
    allocation: Readonly<{ readonly runBindingIdentity: CanonicalIdentity }>,
    operation?: KicadMcpRuntimeOperationContext,
  ): Promise<KicadMcpInspectionIpcSocketBinding> => {
    if (!isPlainRecord(allocation) || Object.keys(allocation).join("") !== "runBindingIdentity"
        || !validCanonicalIdentityForSchema(allocation.runBindingIdentity)) {
      throw new KicadMcpAuthorizationError("KiCad IPC allocation requires one exact run-binding identity.");
    }
    const deadline = createInspectionDeadline(operation, input.runtimeVerificationHooksForTesting);
    await assertCurrentWithin(deadline);
    let directoryPath: string | undefined;
    let allocatedDirectory: BoundInspectionDirectory | undefined;
    try {
      await assertMutationAuthority(deadline, "before-ipc-mkdtemp");
      directoryPath = await withinInspectionDeadline(
        async () => await mkdtemp(path.join(ipcSocketParent.path, "e-")),
        deadline,
        "KiCad MCP IPC socket allocation mkdtemp",
        async (latePath) => await disposeLateIpcAllocation(latePath),
      );
      const directory = await bindInspectionDirectory(directoryPath, "KiCad MCP IPC socket allocation", deadline);
      allocatedDirectory = directory;
      const listenerPath = path.join(directory.path, "kicad");
      const configPath = path.join(directory.path, "config");
      const versionConfigPath = path.join(configPath, "10.0");
      const cachePath = path.join(directory.path, "cache");
      const socketPath = path.join(listenerPath, "api.sock");
      const endpoint = `ipc://${socketPath}`;
      if (Buffer.byteLength(endpoint, "utf8") > KICAD_MCP_IPC_SOCKET_MAX_ENDPOINT_BYTES) {
        throw new KicadMcpSessionError("KiCad IPC endpoint exceeds the fixed short-path limit.");
      }
      const createdDirectories = new Map<string, BoundInspectionDirectory>([[directory.path, directory]]);
      for (const child of [listenerPath, configPath, versionConfigPath, cachePath]) {
        await assertMutationAuthority(deadline, "before-editor-directory-create");
        const parent = createdDirectories.get(path.dirname(child));
        if (parent === undefined) throw new KicadMcpAuthorizationError("KiCad editor directory creation has no bound parent.");
        await assertInspectionDirectory(parent, "KiCad MCP editor directory parent", deadline);
        await withinInspectionDeadline(async () => await mkdir(child), deadline, "KiCad MCP editor directory mkdir");
        createdDirectories.set(child, await bindInspectionDirectory(child, "KiCad MCP editor created directory", deadline));
      }
      const listenerDirectory = await bindInspectionDirectory(listenerPath, "KiCad MCP editor listener directory", deadline);
      const configDirectory = await bindInspectionDirectory(configPath, "KiCad MCP editor config directory", deadline);
      const versionConfigDirectory = await bindInspectionDirectory(versionConfigPath, "KiCad MCP editor version config directory", deadline);
      const cacheDirectory = await bindInspectionDirectory(cachePath, "KiCad MCP editor cache directory", deadline);
      // Exact KiCad10 startup prerequisites: enable API; avoid first-run
      // settings/library/privacy dialogs; disable both update checks. Project
      // tables and the explicitly allowlisted library environment stay intact.
      const configSeeds: ReadonlyArray<readonly [string, string]> = [
        ["kicad_common.json", `${canonicalJson({
          meta: { version: 6 }, api: { enable_server: true },
          do_not_show_again: { data_collection_prompt: true, update_check_prompt: true },
        })}\n`],
        ["kicad.json", `${canonicalJson({ meta: { version: 0 }, system: { check_for_kicad_updates: false }, pcm: { check_for_updates: false } })}\n`],
        ["sym-lib-table", "(sym_lib_table (version 7))\n"],
        ["fp-lib-table", "(fp_lib_table (version 7))\n"],
        ["design-block-lib-table", "(design_block_lib_table (version 7))\n"],
      ];
      const initialConfigFiles: KicadMcpExpectedExecutableIdentity[] = [];
      for (const [filename, bytes] of configSeeds) {
        const configFilePath = path.join(versionConfigDirectory.path, filename);
        await assertMutationAuthority(deadline, "before-editor-config-write");
        await assertInspectionDirectory(versionConfigDirectory, "KiCad MCP editor version config directory", deadline);
        await withinInspectionDeadline(async () => await writeFile(configFilePath, bytes, { encoding: "utf8", flag: "wx" }), deadline, "KiCad MCP editor config write");
        const initialConfig = await captureRegularFileIdentity(configFilePath, "KiCad MCP initial editor config", 64 * 1024, deadline);
        if (initialConfig.sha256 !== contentIdentity(Buffer.from(bytes, "utf8")).digest) throw new KicadMcpSessionError("KiCad editor config did not retain its initialized bytes.");
        initialConfigFiles.push(initialConfig);
      }
      await assertSocketPathAbsent(socketPath, deadline);
      const nonceIdentity = contentIdentity(randomBytes(32));
      const bindingIdentity = canonicalIdentity({
        schemaVersion: KICAD_MCP_IPC_SOCKET_BINDING_SCHEMA_VERSION,
        runtimeIdentity: kicadMcpRuntimeIdentity,
        parent: { pathIdentity: ipcSocketParent.pathIdentity, filesystem: ipcSocketParent.filesystem },
        allocation: { directoryPathIdentity: directory.pathIdentity, filesystem: directory.filesystem },
        editor: {
          listenerDirectory: { pathIdentity: listenerDirectory.pathIdentity, filesystem: listenerDirectory.filesystem },
          configDirectory: { pathIdentity: configDirectory.pathIdentity, filesystem: configDirectory.filesystem },
          versionConfigDirectory: { pathIdentity: versionConfigDirectory.pathIdentity, filesystem: versionConfigDirectory.filesystem },
          cacheDirectory: { pathIdentity: cacheDirectory.pathIdentity, filesystem: cacheDirectory.filesystem },
          initialConfigFiles: initialConfigFiles.map((config) => ({ pathIdentity: pathIdentity(config.path), sha256: config.sha256, filesystem: config.filesystem })),
        },
        endpointPathIdentity: pathIdentity(socketPath),
        endpointValueSha256: createHash("sha256").update(endpoint, "utf8").digest("hex"),
        allocationNonceSha256: nonceIdentity.digest,
        runBindingIdentity: allocation.runBindingIdentity,
        policy: identityPayload.launch.ipcSocketPolicy,
      }, KICAD_MCP_IPC_SOCKET_BINDING_SCHEMA_VERSION);
      const binding = Object.freeze({ endpoint, identity: bindingIdentity });
      await assertMutationAuthority(deadline, "before-ipc-binding-publication");
      ipcSocketStates.set(binding, {
        binding,
        runBindingIdentity: allocation.runBindingIdentity,
        directory,
        listenerDirectory, configDirectory, versionConfigDirectory, cacheDirectory, initialConfigFiles: Object.freeze(initialConfigFiles),
        socketPath,
        editorLaunchClaimed: false, editorExitObserved: false, editorExitBound: false,
        active: false,
        connectionCount: 0,
        released: false,
        sessionAllocations: new Set(),
        operationTail: Promise.resolve(),
      });
      await assertIpcSocketWithin(binding, allocation.runBindingIdentity, deadline);
      await assertMutationAuthority(deadline, "before-ipc-binding-return");
      return binding;
    } catch (error) {
      if (error instanceof KicadMcpRuntimeVerificationDeadlineError) {
        poisoned = true;
        // Once mkdtemp returned, this exact directory is ours even if a later
        // verification step exhausted the caller's deadline.  Cleanup cannot
        // consume the expired authority, so attach the same confined late
        // disposer used when mkdtemp itself resolves after the timeout.
        if (directoryPath !== undefined) void disposeLateIpcAllocation(directoryPath);
        throw error;
      }
      if (directoryPath === undefined) {
        poisoned = true;
        throw error;
      }
      try {
        if (allocatedDirectory !== undefined) {
          await removeIpcAllocationTree(allocatedDirectory, deadline);
        } else {
          const failedAllocation = await bindInspectionDirectory(directoryPath, "KiCad MCP failed IPC allocation", deadline);
          const entries = await withinInspectionDeadline(
            async () => await readdir(failedAllocation.path), deadline, "KiCad MCP failed IPC allocation readdir",
          );
          if (entries.length !== 0) throw new Error("allocation is not empty");
          await withinInspectionDeadline(
            async () => await rmdir(failedAllocation.path), deadline, "KiCad MCP failed IPC allocation rmdir",
          );
        }
      } catch {
        poisoned = true;
        throw new KicadMcpTerminationUncertainError("KiCad IPC allocation cleanup was not provably empty and was retained.");
      }
      throw error;
    }
  };

  const releaseIpcSocket = async (
    binding: KicadMcpInspectionIpcSocketBinding,
    runBindingIdentity: CanonicalIdentity,
    operation?: KicadMcpRuntimeOperationContext,
  ): Promise<"released" | "deferred_active"> => {
    validateIpcSocketBindingShape(binding);
    if (!validCanonicalIdentityForSchema(runBindingIdentity)) {
      throw new KicadMcpAuthorizationError("KiCad IPC run binding identity is invalid.");
    }
    const state = ipcSocketStates.get(binding);
    if (state === undefined || state.binding !== binding
        || canonicalJson(state.runBindingIdentity) !== canonicalJson(runBindingIdentity)) {
      throw new KicadMcpAuthorizationError("KiCad IPC socket binding is forged or belongs to another run.");
    }
    const deadline = createInspectionDeadline(operation, input.runtimeVerificationHooksForTesting);
    return await withSocketStateLock(state, deadline, async () => {
      if (state.released) return "released";
      await assertCurrentWithin(deadline);
      if (state.active || (state.editorLaunchClaimed && !state.editorExitObserved)) return "deferred_active";
      try {
        await assertIpcSocketWithin(binding, runBindingIdentity, deadline);
        for (const allocation of state.sessionAllocations) {
          if (allocation.used && !allocation.disposed) {
            throw new KicadMcpTerminationUncertainError("KiCad MCP session runtime remains active or unconfirmed.");
          }
          if (!allocation.disposed) {
            await removePrivateRuntime(allocation.root, deadline);
            allocation.disposed = true;
          }
          state.sessionAllocations.delete(allocation);
        }
        await removeIpcAllocationTree(state.directory, deadline);
        state.released = true;
        await assertInspectionDirectory(ipcSocketParent, "KiCad MCP IPC socket parent", deadline);
        return "released";
      } catch (error) {
        poisoned = true;
        if (error instanceof KicadMcpTerminationUncertainError) throw error;
        throw new KicadMcpTerminationUncertainError("KiCad IPC socket release could not be confirmed; the allocation was retained.");
      }
    });
  };

  async function removePrivateRuntime(runRoot: BoundInspectionDirectory, deadline?: InspectionDeadline): Promise<void> {
    await assertInspectionDirectory(runRoot, "KiCad MCP private runtime allocation", deadline);
    if (!isPathWithin(runtimeParent.path, runRoot.path, false) || !path.basename(runRoot.path).startsWith(sessionRuntimePrefix)) {
      throw new KicadMcpTerminationUncertainError("KiCad MCP private runtime cleanup target is not confined.");
    }
    await withinInspectionDeadline(
      async () => await rm(runRoot.path, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 }),
      deadline,
      "KiCad MCP private runtime recursive removal",
    );
    try {
      await withinInspectionDeadline(
        async () => await lstat(runRoot.path), deadline, "KiCad MCP private runtime removal stat",
      );
      throw new KicadMcpTerminationUncertainError("KiCad MCP private runtime cleanup could not be verified.");
    } catch (error) {
      if (error instanceof KicadMcpRuntimeVerificationDeadlineError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const disposeLateSessionRuntimeAllocation = async (directoryPath: string): Promise<void> => {
    try {
      const name = path.basename(directoryPath);
      if (!isPathWithin(runtimeParent.path, directoryPath, false)
          || !sameCanonicalPath(path.dirname(directoryPath), runtimeParent.path)
          || !name.startsWith(sessionRuntimePrefix)
          || name.length <= sessionRuntimePrefix.length
          || name.length > 64) {
        throw new Error("late session runtime allocation escaped its authority");
      }
      await assertInspectionDirectory(runtimeParent, "KiCad MCP late session runtime parent");
      const directory = await bindInspectionDirectory(directoryPath, "KiCad MCP late session runtime allocation");
      if ((await readdir(directory.path)).length !== 0) {
        throw new Error("late session runtime allocation is not empty");
      }
      await assertInspectionDirectory(directory, "KiCad MCP late session runtime allocation");
      await rmdir(directory.path);
      try {
        await lstat(directory.path);
        throw new Error("late session runtime allocation removal was not confirmed");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } catch {
      // A timeout already revoked all bridge authority.  Never recursively
      // remove a non-empty or unverifiable late result; retain it as evidence.
      poisoned = true;
    }
  };

  const allocateSessionRuntime = async (
    state: IpcSocketState,
    deadline: InspectionDeadline,
  ): Promise<SessionRuntimeAllocation> => {
    let runRoot: string;
    try {
      await assertMutationAuthority(deadline, "before-session-runtime-mkdtemp");
      runRoot = await withinInspectionDeadline(
        async () => await mkdtemp(path.join(runtimeParent.path, sessionRuntimePrefix)),
        deadline,
        "KiCad MCP session runtime mkdtemp",
        async (latePath) => await disposeLateSessionRuntimeAllocation(latePath),
      );
    } catch (error) {
      if (error instanceof KicadMcpRuntimeVerificationDeadlineError) { poisoned = true; throw error; }
      throw new KicadMcpSessionError("KiCad MCP private runtime allocation failed.");
    }
    let root: BoundInspectionDirectory;
    try { root = await bindInspectionDirectory(runRoot, "KiCad MCP private runtime allocation", deadline); }
    catch (error) {
      if (error instanceof KicadMcpRuntimeVerificationDeadlineError) {
        poisoned = true;
        void disposeLateSessionRuntimeAllocation(runRoot);
        throw error;
      }
      try {
        await withinInspectionDeadline(async () => await rmdir(runRoot), deadline, "KiCad MCP failed runtime rmdir");
      } catch { poisoned = true; }
      throw new KicadMcpSessionError("KiCad MCP private runtime allocation could not be bound.");
    }
    const allocationPaths = {
      home: path.join(runRoot, "home"), cache: path.join(runRoot, "cache"),
      cwd: path.join(runRoot, "cwd"), temp: path.join(runRoot, "temp"), config: path.join(runRoot, "config"),
      appData: path.join(runRoot, "home", "AppData"),
      localAppData: path.join(runRoot, "home", "AppData", "Local"),
      roamingAppData: path.join(runRoot, "home", "AppData", "Roaming"),
    };
    try {
      await assertMutationAuthority(deadline, "before-session-runtime-directory-mkdir");
      await Promise.all([
        withinInspectionDeadline(async () => await mkdir(allocationPaths.home), deadline, "KiCad MCP private home mkdir"),
        withinInspectionDeadline(async () => await mkdir(allocationPaths.cache), deadline, "KiCad MCP private cache mkdir"),
        withinInspectionDeadline(async () => await mkdir(allocationPaths.cwd), deadline, "KiCad MCP private cwd mkdir"),
        withinInspectionDeadline(async () => await mkdir(allocationPaths.temp), deadline, "KiCad MCP private temp mkdir"),
        withinInspectionDeadline(async () => await mkdir(allocationPaths.config), deadline, "KiCad MCP private config mkdir"),
      ]);
      // Windows KiCad's known-folder lookup needs these declared environment
      // directories to exist. Otherwise even `version` can fall back to cwd
      // and try to create configuration inside the read-only installation.
      await withinInspectionDeadline(async () => await mkdir(allocationPaths.appData), deadline, "KiCad MCP private AppData mkdir");
      await Promise.all([
        withinInspectionDeadline(async () => await mkdir(allocationPaths.localAppData), deadline, "KiCad MCP private local AppData mkdir"),
        withinInspectionDeadline(async () => await mkdir(allocationPaths.roamingAppData), deadline, "KiCad MCP private roaming AppData mkdir"),
      ]);
    } catch (error) {
      if (error instanceof KicadMcpRuntimeVerificationDeadlineError) {
        poisoned = true;
        void disposeLateSessionRuntimeAllocation(runRoot);
        throw error;
      }
      try { await removePrivateRuntime(root, deadline); }
      catch {
        poisoned = true;
        throw new KicadMcpTerminationUncertainError("KiCad MCP partial runtime cleanup could not be confirmed.");
      }
      throw new KicadMcpSessionError("KiCad MCP private runtime initialization failed.");
    }
    let home: BoundInspectionDirectory;
    let appData: BoundInspectionDirectory;
    let localAppData: BoundInspectionDirectory;
    let roamingAppData: BoundInspectionDirectory;
    let cache: BoundInspectionDirectory;
    let cwd: BoundInspectionDirectory;
    let temp: BoundInspectionDirectory;
    let config: BoundInspectionDirectory;
    try {
      [home, cache, cwd, temp, config, appData, localAppData, roamingAppData] = await Promise.all([
        bindInspectionDirectory(allocationPaths.home, "KiCad MCP private home", deadline),
        bindInspectionDirectory(allocationPaths.cache, "KiCad MCP private cache", deadline),
        bindInspectionDirectory(allocationPaths.cwd, "KiCad MCP private working directory", deadline),
        bindInspectionDirectory(allocationPaths.temp, "KiCad MCP private temp", deadline),
        bindInspectionDirectory(allocationPaths.config, "KiCad MCP private config", deadline),
        bindInspectionDirectory(allocationPaths.appData, "KiCad MCP private AppData", deadline),
        bindInspectionDirectory(allocationPaths.localAppData, "KiCad MCP private local AppData", deadline),
        bindInspectionDirectory(allocationPaths.roamingAppData, "KiCad MCP private roaming AppData", deadline),
      ]);
    } catch (error) {
      if (error instanceof KicadMcpRuntimeVerificationDeadlineError) {
        poisoned = true;
        void disposeLateSessionRuntimeAllocation(runRoot);
        throw error;
      }
      try { await removePrivateRuntime(root, deadline); }
      catch {
        poisoned = true;
        throw new KicadMcpTerminationUncertainError("KiCad MCP private-directory binding cleanup could not be confirmed.");
      }
      throw new KicadMcpSessionError("KiCad MCP private runtime directories could not be bound.");
    }
    const allocation: SessionRuntimeAllocation = {
      root, home, cache, cwd, temp, config, appData, localAppData, roamingAppData, used: false, disposed: false,
    };
    try { await assertMutationAuthority(deadline, "before-session-runtime-registration"); }
    catch (error) {
      const cleanupDeadline = createInspectionDeadline(undefined, input.runtimeVerificationHooksForTesting);
      try { await removePrivateRuntime(root, cleanupDeadline); }
      catch { poisoned = true; }
      throw error;
    }
    state.sessionAllocations.add(allocation);
    try { assertInspectionDeadline(deadline); }
    catch (error) { poisoned = true; throw error; }
    return allocation;
  };

  const bindAuthorityRoots = async (
    roots: KicadMcpSessionAuthorityRequest["roots"],
    deadline?: InspectionDeadline,
  ): Promise<BoundAuthorityRoots> => {
    if (!isPlainRecord(roots)
        || Object.keys(roots).sort().join("\0") !== ["outputRoot", "projectRoot", "workspaceRoot"].sort().join("\0")
        || typeof roots.workspaceRoot !== "string" || typeof roots.projectRoot !== "string" || typeof roots.outputRoot !== "string") {
      throw new KicadMcpAuthorizationError("KiCad MCP session authority roots are not an exact closed record.");
    }
    const workspaceRoot = await withinInspectionDeadline(
      async () => await resolveExistingDirectory(roots.workspaceRoot, "MCP authority workspace root"),
      deadline,
      "MCP authority workspace root resolution",
    );
    const projectRoot = await withinInspectionDeadline(
      async () => await resolveExistingDirectory(roots.projectRoot, "MCP authority project root"),
      deadline,
      "MCP authority project root resolution",
    );
    assertPathWithin(workspaceRoot, projectRoot, "MCP authority project root", true);
    const outputRoot = await withinInspectionDeadline(
      async () => await resolveConfinedCandidate(
        workspaceRoot, workspaceRoot, roots.outputRoot, "MCP authority output root", false,
      ),
      deadline,
      "MCP authority output root resolution",
    );
    assertPathWithin(workspaceRoot, outputRoot, "MCP authority output root", false);
    if ([workspaceRoot, projectRoot, outputRoot].some((runtimePath) =>
      isPathWithin(runtimeParent.path, runtimePath, true) || isPathWithin(runtimePath, runtimeParent.path, true)
      || isPathWithin(ipcSocketParent.path, runtimePath, true) || isPathWithin(runtimePath, ipcSocketParent.path, true))) {
      throw new KicadMcpAuthorizationError("KiCad MCP authority roots overlap a mutable bridge directory.");
    }
    const [workspace, project] = await Promise.all([
      bindInspectionDirectory(workspaceRoot, "MCP authority workspace root", deadline),
      bindInspectionDirectory(projectRoot, "MCP authority project root", deadline),
    ]);
    return Object.freeze({
      workspaceRoot,
      projectRoot,
      outputRoot,
      identities: Object.freeze({
        workspacePathIdentity: pathIdentity(workspaceRoot),
        projectPathIdentity: pathIdentity(projectRoot),
        outputPathIdentity: pathIdentity(outputRoot),
      }),
      physicalDirectories: Object.freeze({ workspace, project }),
    });
  };

  const connectBoundSession = async (
    authorityIdentity: CanonicalIdentity,
    semanticAuthorityIdentity: CanonicalIdentity,
    bindingState: IpcSocketState,
    mode: KicadMcpOperatingMode,
    requiredTools: readonly string[],
    expectedRoots: BoundAuthorityRoots,
    allocation: SessionRuntimeAllocation,
    requestedOptions: KicadMcpSessionOptions,
    operation?: KicadMcpRuntimeOperationContext,
  ): Promise<KicadMcpSession> => {
    const deadline = createInspectionDeadline(operation, input.runtimeVerificationHooksForTesting);
    return await withSocketStateLock(bindingState, deadline, async () => {
    if (poisoned) throw new KicadMcpTerminationUncertainError("KiCad MCP runtime is poisoned after uncertain verification.");
    if (bindingState.released) throw new KicadMcpAuthorizationError("KiCad IPC socket binding was released before session connection.");
    const allowedOptionKeys = ["freshProject", "isolatedWorkingCopy", "mode", "outputRoot", "projectRoot", "requiredTools", "workspaceRoot"];
    if (Object.keys(requestedOptions).some((key) => !allowedOptionKeys.includes(key))
        || requestedOptions.mode !== mode
        || canonicalJson(requestedOptions.requiredTools) !== canonicalJson(requiredTools)
        || typeof requestedOptions.workspaceRoot !== "string" || typeof requestedOptions.projectRoot !== "string"
        || typeof requestedOptions.outputRoot !== "string") {
      throw new KicadMcpAuthorizationError("KiCad MCP bound-session options exceed their mode authority.");
    }
    if (mode === "readonly" && (requestedOptions.freshProject !== undefined || requestedOptions.isolatedWorkingCopy !== undefined)) {
      throw new KicadMcpAuthorizationError("KiCad MCP read-only authority cannot carry write isolation options.");
    }
    if (mode === "write" && ((requestedOptions.freshProject === true) === (requestedOptions.isolatedWorkingCopy !== undefined))) {
      throw new KicadMcpAuthorizationError("KiCad MCP write authority requires exactly one fresh/copy isolation proof.");
    }
    const paths = {
      workspaceRoot: String(requestedOptions.workspaceRoot),
      projectRoot: String(requestedOptions.projectRoot),
      outputRoot: String(requestedOptions.outputRoot),
    };
    const currentRoots = await bindAuthorityRoots(paths, deadline);
    if (canonicalJson(currentRoots) !== canonicalJson(expectedRoots)) {
      throw new KicadMcpAuthorizationError("KiCad MCP session roots changed after authority binding.");
    }
    await assertCurrentWithin(deadline);
    await assertIpcSocketWithin(bindingState.binding, bindingState.runBindingIdentity, deadline);
    if (allocation.used || allocation.disposed) {
      throw new KicadMcpAuthorizationError("KiCad MCP session authority allocation is already consumed or disposed.");
    }
    await Promise.all([
      assertInspectionDirectory(allocation.root, "KiCad MCP bound runtime allocation", deadline),
      assertInspectionDirectory(allocation.home, "KiCad MCP bound private home", deadline),
      assertInspectionDirectory(allocation.appData, "KiCad MCP bound private AppData", deadline),
      assertInspectionDirectory(allocation.localAppData, "KiCad MCP bound private local AppData", deadline),
      assertInspectionDirectory(allocation.roamingAppData, "KiCad MCP bound private roaming AppData", deadline),
      assertInspectionDirectory(allocation.cache, "KiCad MCP bound private cache", deadline),
      assertInspectionDirectory(allocation.cwd, "KiCad MCP bound working directory", deadline),
      assertInspectionDirectory(allocation.temp, "KiCad MCP bound private temp", deadline),
      assertInspectionDirectory(allocation.config, "KiCad MCP bound private config", deadline),
    ]);
    if (bindingState.active || bindingState.connectionCount >= KICAD_MCP_IPC_SOCKET_MAX_CONNECTIONS) {
      throw new KicadMcpAuthorizationError("KiCad IPC socket connection budget or concurrency policy is exhausted.");
    }
    await assertMutationAuthority(deadline, "before-session-state-and-connect");
    allocation.used = true;
    bindingState.active = true;
    bindingState.connectionCount += 1;
    const runRootBinding = allocation.root;
    const runHome = allocation.home.path;
    const runCache = allocation.cache.path;
    const runCwd = allocation.cwd.path;
    const runTemp = allocation.temp.path;
    const runConfig = allocation.config.path;
    const assertLaunchAuthority = (): void => {
      assertInspectionDeadline(deadline);
      if (poisoned) {
        throw new KicadMcpTerminationUncertainError("KiCad MCP runtime was poisoned before sidecar launch.");
      }
    };
    const baseEnvironment = Object.freeze({
      ...(valueForEnvironmentKey(environment, "SYSTEMROOT") === undefined ? {} : { SYSTEMROOT: valueForEnvironmentKey(environment, "SYSTEMROOT") }),
      ...(valueForEnvironmentKey(environment, "WINDIR") === undefined ? {} : { WINDIR: valueForEnvironmentKey(environment, "WINDIR") }),
      TEMP: runTemp, TMP: runTemp,
      USERPROFILE: runHome, LOCALAPPDATA: allocation.localAppData.path, APPDATA: allocation.roamingAppData.path, HOME: runHome,
    }) as Readonly<Record<string, string | undefined>>;
    let session: KicadMcpSession;
    let connectorStage: KicadStartupStage = "bridge-connect";
    try {
      assertInspectionDeadline(deadline);
      session = await withinInspectionDeadline(async () => {
        // This synchronous check is adjacent to invoking the connector.  The
        // production connector repeats it immediately before transport spawn,
        // after its own asynchronous identity validation has completed.
        assertLaunchAuthority();
        return await (input.connectSessionForTesting ?? KicadMcpSession.connect)({
        ...paths,
        mode,
        ...(requestedOptions.freshProject === true ? { freshProject: true }
          : requestedOptions.isolatedWorkingCopy === undefined ? {}
            : { isolatedWorkingCopy: requestedOptions.isolatedWorkingCopy }),
        launchCwd: runCwd,
        deferProjectBinding: true,
        command: { command: runtimePython.path, args: baseArgs },
        expectedLauncherIdentity: runtimePython,
        environment: baseEnvironment,
        extraEnvironment: { KICAD_CONFIG_HOME: runConfig, XDG_CACHE_HOME: runCache },
        kicadCliPath: kicadCli.path,
        expectedKicadCliIdentity: kicadCli,
        ipcSocket: bindingState.binding,
        sessionAuthorityIdentity: authorityIdentity,
        sessionSemanticAuthorityIdentity: semanticAuthorityIdentity,
        processTreeSupervision: {
          strategy: KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY,
          terminator: processTreeTerminator,
          timeoutMs: KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
          ...(input.processTreeRunnerForTesting === undefined ? {} : { processRunnerForTesting: input.processTreeRunnerForTesting }),
        },
        readToolAllowlist: mode === "readonly" ? KICAD_MCP_INSPECTION_TOOL_ALLOWLIST : KICAD_MCP_READ_TOOL_ALLOWLIST,
        writeToolAllowlist: mode === "write" ? KICAD_MCP_WRITE_TOOL_ALLOWLIST : [],
        requiredTools,
        assertLaunchAuthority,
        observeStartupStage: stage => { connectorStage = stage; },
        timeoutMs: Math.max(1, Math.floor(deadline.deadlineAtMs - inspectionNow(deadline.hooks))),
        ...(deadline.signal === undefined ? {} : { signal: deadline.signal }),
        });
      }, deadline, "KiCad MCP bound session connect", async (lateSession) => {
        await lateSession.close().catch(() => undefined);
      });
    } catch (error) {
      const primary = captureKicadStartupFailure(error, connectorStage);
      const category = registeredKicadStartupCategory(error);
      if (category === "kicad-termination-uncertain" || category === "kicad-verification-deadline") {
        poisoned = true;
        throw bindKicadStartupEvidence(error as Error, primary);
      } else {
        bindingState.active = false;
        try {
          await removePrivateRuntime(runRootBinding, deadline);
          allocation.disposed = true;
          bindingState.sessionAllocations.delete(allocation);
        }
        catch (cleanupError) {
          poisoned = true;
          const diagnostic = withKicadStartupCleanup(primary, "bridge-cleanup", "unconfirmed", cleanupError);
          throw bindKicadStartupEvidence(new KicadMcpTerminationUncertainError("KiCad MCP failed-connect runtime cleanup could not be confirmed.", { cause: diagnostic }), diagnostic);
        }
      }
      const diagnostic = withKicadStartupCleanup(primary, "bridge-cleanup", "confirmed");
      throw bindKicadStartupEvidence(new KicadMcpSessionError("Pinned KiCad MCP bridge failed to connect.", { cause: diagnostic }), diagnostic);
    }
    const originalClose = session.close.bind(session);
    let disposed = false;
    let secureClosePromise: Promise<void> | undefined;
    const closeOnce = async (): Promise<void> => {
      if (disposed) return;
      try {
        await originalClose();
        await assertCurrent();
        await removePrivateRuntime(runRootBinding);
        allocation.disposed = true;
        bindingState.sessionAllocations.delete(allocation);
        bindingState.active = false;
        disposed = true;
      } catch (error) {
        poisoned = true;
        if (error instanceof KicadMcpTerminationUncertainError) throw error;
        throw new KicadMcpTerminationUncertainError("KiCad MCP inspection teardown or runtime revalidation is uncertain.");
      }
    };
    const secureClose = async (): Promise<void> => {
      secureClosePromise ??= closeOnce();
      await secureClosePromise;
    };
    Object.defineProperty(session, "close", { configurable: false, enumerable: false, writable: false, value: secureClose });
    let bindingStage: KicadStartupStage = "deferred-project-binding";
    try {
      await assertMutationAuthority(deadline, "before-bound-project-bind");
      await withinInspectionDeadline(
        async () => await session.bindDeferredInspectionProject(),
        deadline,
        "KiCad MCP deferred project binding",
      );
      bindingStage = "bridge-revalidation";
      await assertCurrentWithin(deadline);
      await assertIpcSocketWithin(bindingState.binding, bindingState.runBindingIdentity, deadline);
      bindingStage = "bridge-session-identity";
      if (session.identity.mode !== mode
          || canonicalJson(session.identity.launch.sessionAuthorityIdentity) !== canonicalJson(authorityIdentity)
          || canonicalJson(session.identity.launch.sessionSemanticAuthorityIdentity) !== canonicalJson(semanticAuthorityIdentity)
          || canonicalJson(session.identity.launch.ipcSocketIdentity) !== canonicalJson(bindingState.binding.identity)
          || canonicalJson(session.identity.roots) !== canonicalJson(expectedRoots.identities)
          || session.identity.launch.workingDirectoryPathIdentity !== allocation.cwd.pathIdentity
          || session.identity.sessionSemanticIdentity.schemaVersion !== KICAD_MCP_SESSION_SEMANTIC_IDENTITY_SCHEMA_VERSION
          || session.identity.sessionReceiptIdentity.schemaVersion !== KICAD_MCP_SESSION_RECEIPT_SCHEMA_VERSION
          || session.identity.launch.rootProcessIncarnationIdentity.schemaVersion !== "evleda.kicad-mcp-root-process-incarnation.v1") {
        throw new KicadMcpSessionError("KiCad MCP bridge returned an invalid mode/socket/session authority.");
      }
      await assertMutationAuthority(deadline, "before-session-return");
      return session;
    } catch (error) {
      const primary = captureKicadStartupFailure(error, bindingStage);
      const category = registeredKicadStartupCategory(error);
      const uncertain = category === "kicad-termination-uncertain" || category === "kicad-verification-deadline";
      if (uncertain) poisoned = true;
      try { await session.close(); }
      catch (closeError) {
        const diagnostic = withKicadStartupCleanup(primary, "bridge-cleanup", "unconfirmed", closeError);
        throw bindKicadStartupEvidence(new KicadMcpTerminationUncertainError("KiCad MCP deferred binding failed and cleanup was not confirmed.", { cause: diagnostic }), diagnostic);
      }
      const diagnostic = withKicadStartupCleanup(primary, "bridge-cleanup", "confirmed");
      if (uncertain) throw bindKicadStartupEvidence(error as Error, diagnostic);
      throw bindKicadStartupEvidence(new KicadMcpSessionError("Pinned KiCad MCP bridge changed during connection.", { cause: diagnostic }), diagnostic);
    }
    });
  };

  const bindSession = async (
    request: KicadMcpSessionAuthorityRequest,
    operation?: KicadMcpRuntimeOperationContext,
  ): Promise<KicadMcpBoundSessionAuthority> => {
    if (!isPlainRecord(request)
        || Object.keys(request).sort().join("\0") !== ["ipcSocket", "mode", "requiredTools", "roots", "runBindingIdentity"].sort().join("\0")) {
      throw new KicadMcpAuthorizationError("KiCad MCP session authority request is not an exact closed record.");
    }
    const state = stateForSocket(request.ipcSocket, request.runBindingIdentity);
    const deadline = createInspectionDeadline(operation, input.runtimeVerificationHooksForTesting);
    return await withSocketStateLock(state, deadline, async () => {
    if (poisoned) throw new KicadMcpTerminationUncertainError("KiCad MCP runtime is poisoned after uncertain verification.");
    if (state.released) throw new KicadMcpAuthorizationError("KiCad IPC socket binding was released during authority binding.");
    await assertCurrentWithin(deadline);
    await assertIpcSocketWithin(request.ipcSocket, request.runBindingIdentity, deadline);
    if (state.connectionCount >= KICAD_MCP_IPC_SOCKET_MAX_CONNECTIONS) {
      throw new KicadMcpAuthorizationError("KiCad IPC socket connection budget is exhausted before authority allocation.");
    }
    if (request.mode !== "readonly" && request.mode !== "write") throw new KicadMcpAuthorizationError("KiCad MCP session authority has an invalid mode.");
    if (!Array.isArray(request.requiredTools) || request.requiredTools.length < 1 || request.requiredTools.length > 128
        || request.requiredTools.some((name) => typeof name !== "string" || !/^[a-z][a-z0-9_]{1,127}$/u.test(name))
        || new Set(request.requiredTools).size !== request.requiredTools.length) {
      throw new KicadMcpAuthorizationError("KiCad MCP session authority has an invalid required-tool set.");
    }
    const requiredTools = Object.freeze([...request.requiredTools].sort());
    const permittedTools = new Set<string>(request.mode === "readonly"
      ? KICAD_MCP_INSPECTION_TOOL_ALLOWLIST
      : [...KICAD_MCP_READ_TOOL_ALLOWLIST, ...KICAD_MCP_WRITE_TOOL_ALLOWLIST, LIVE_PCB_DOCUMENT_TOOL, LIVE_PCB_PAD_SNAPSHOT_TOOL, SCHEMATIC_CONNECTIVITY_BATCH_TOOL, KICAD_PLANE_STAGE_TOOL]);
    if (requiredTools.some((name) => !permittedTools.has(name))) {
      throw new KicadMcpAuthorizationError("KiCad MCP session authority requests a tool outside its closed mode policy.");
    }
    if (request.mode === "readonly"
        && canonicalJson(requiredTools) !== canonicalJson([...KICAD_MCP_INSPECTION_TOOL_ALLOWLIST].sort())) {
      throw new KicadMcpAuthorizationError("KiCad MCP read-only authority must bind the exact inspection tool set.");
    }
    const expectedRoots = await bindAuthorityRoots(request.roots, deadline);
    await assertMutationAuthority(deadline, "before-session-runtime-allocation");
    const allocation = await allocateSessionRuntime(state, deadline);
    try { assertInspectionDeadline(deadline); }
    catch (error) {
      const cleanupDeadline = createInspectionDeadline(undefined, input.runtimeVerificationHooksForTesting);
      try {
        await removePrivateRuntime(allocation.root, cleanupDeadline);
        allocation.disposed = true;
        state.sessionAllocations.delete(allocation);
      } catch {
        poisoned = true;
      }
      poisoned = true;
      throw error;
    }
    const modeBridgeIdentity = request.mode === "readonly" ? inspectionBridgeIdentity : executionBridgeIdentity;
    const semanticAuthorityIdentity = canonicalIdentity({
      schemaVersion: KICAD_MCP_SESSION_SEMANTIC_AUTHORITY_SCHEMA_VERSION,
      modeBridgeIdentity,
      runtimeIdentity: kicadMcpRuntimeIdentity,
      ipcSocketIdentity: request.ipcSocket.identity,
      runBindingIdentity: request.runBindingIdentity,
      expectedRoots: {
        identities: expectedRoots.identities,
        physicalDirectories: expectedRoots.physicalDirectories,
      },
      mode: request.mode,
      profile: "full",
      requiredTools,
      readToolAllowlist: request.mode === "readonly" ? [...KICAD_MCP_INSPECTION_TOOL_ALLOWLIST] : [...KICAD_MCP_READ_TOOL_ALLOWLIST],
      writeToolAllowlist: request.mode === "write" ? [...KICAD_MCP_WRITE_TOOL_ALLOWLIST] : [],
      runtimeStrategy: identityPayload.distribution.runtimeStrategy,
      environmentPolicy: identityPayload.environmentPolicy,
      processTreeSupervision: identityPayload.launch.processTreeSupervision,
    }, KICAD_MCP_SESSION_SEMANTIC_AUTHORITY_SCHEMA_VERSION);
    const authorityIdentity = canonicalIdentity({
      schemaVersion: KICAD_MCP_SESSION_AUTHORITY_SCHEMA_VERSION,
      semanticAuthorityIdentity,
      runtimeAllocation: {
        root: { pathIdentity: allocation.root.pathIdentity, filesystem: allocation.root.filesystem },
        home: { pathIdentity: allocation.home.pathIdentity, filesystem: allocation.home.filesystem },
        appData: { pathIdentity: allocation.appData.pathIdentity, filesystem: allocation.appData.filesystem },
        localAppData: { pathIdentity: allocation.localAppData.pathIdentity, filesystem: allocation.localAppData.filesystem },
        roamingAppData: { pathIdentity: allocation.roamingAppData.pathIdentity, filesystem: allocation.roamingAppData.filesystem },
        cache: { pathIdentity: allocation.cache.pathIdentity, filesystem: allocation.cache.filesystem },
        workingDirectory: { pathIdentity: allocation.cwd.pathIdentity, filesystem: allocation.cwd.filesystem },
        temp: { pathIdentity: allocation.temp.pathIdentity, filesystem: allocation.temp.filesystem },
        config: { pathIdentity: allocation.config.pathIdentity, filesystem: allocation.config.filesystem },
      },
    }, KICAD_MCP_SESSION_AUTHORITY_SCHEMA_VERSION);
    const authority = Object.freeze({
      identity: authorityIdentity,
      semanticIdentity: semanticAuthorityIdentity,
      connect: async (options: KicadMcpSessionOptions, connectOperation?: KicadMcpRuntimeOperationContext) =>
        await connectBoundSession(
          authorityIdentity, semanticAuthorityIdentity, state, request.mode,
          requiredTools, expectedRoots, allocation, options, connectOperation,
        ),
      disposeUnused: async (disposeOperation?: KicadMcpRuntimeOperationContext): Promise<"disposed" | "already_connected"> => {
        const disposeDeadline = createInspectionDeadline(disposeOperation, input.runtimeVerificationHooksForTesting);
        return await withSocketStateLock(state, disposeDeadline, async () => {
          if (allocation.disposed) return "disposed";
          if (allocation.used) return "already_connected";
          await assertCurrentWithin(disposeDeadline);
          await removePrivateRuntime(allocation.root, disposeDeadline);
          allocation.disposed = true;
          state.sessionAllocations.delete(allocation);
          return "disposed";
        });
      },
    });
    try { await assertMutationAuthority(deadline, "before-session-authority-return"); }
    catch (error) {
      const cleanupDeadline = createInspectionDeadline(undefined, input.runtimeVerificationHooksForTesting);
      try {
        await removePrivateRuntime(allocation.root, cleanupDeadline);
        allocation.disposed = true;
        state.sessionAllocations.delete(allocation);
      } catch { poisoned = true; }
      throw error;
    }
    return authority;
    });
  };

  const connect = async (
    request: KicadMcpInspectionBridgeConnectRequest,
    operation?: KicadMcpRuntimeOperationContext,
  ): Promise<KicadMcpSession> => {
    const deadline = createInspectionDeadline(operation, input.runtimeVerificationHooksForTesting);
    const sharedOperation: KicadMcpRuntimeOperationContext = {
      deadlineAtMs: deadline.deadlineAtMs,
      ...(deadline.signal === undefined ? {} : { signal: deadline.signal }),
    };
    const authority = await bindSession({
      runBindingIdentity: request.runBindingIdentity,
      ipcSocket: request.ipcSocket,
      mode: "readonly",
      requiredTools: KICAD_MCP_INSPECTION_TOOL_ALLOWLIST,
      roots: {
        workspaceRoot: request.workspaceRoot,
        projectRoot: request.projectRoot,
        outputRoot: request.outputRoot,
      },
    }, sharedOperation);
    return await authority.connect({
      workspaceRoot: request.workspaceRoot,
      projectRoot: request.projectRoot,
      outputRoot: request.outputRoot,
      mode: "readonly",
      requiredTools: [...KICAD_MCP_INSPECTION_TOOL_ALLOWLIST].sort(),
    }, sharedOperation);
  };

  return Object.freeze({
    identity: kicadMcpRuntimeIdentity, inspectionBridgeIdentity, executionBridgeIdentity,
    allocateIpcSocket, assertIpcSocket, getEditorLaunchContext, releaseIpcSocket, bindSession, connect, assertCurrent,
  });
}

/** Compatibility export; new production composition should use createKicadMcpRuntimeBridge. */
export const createKicadMcpInspectionBridge = createKicadMcpRuntimeBridge;

export function isPathConfinedForKicadMcp(root: string, candidate: string): boolean {
  return isPathWithin(root, candidate, true);
}
