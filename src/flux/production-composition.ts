import { createHash } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  canonicalIdentity,
  canonicalJson,
  constantTimeDigestEqual,
  contentIdentity,
} from "../core/canonical.js";
import { parsePortableJsonBytes, validateCanonicalIdentity } from "../core/portable-artifact.js";
import {
  parseFluxDiagnostic,
  type FluxDiagnosticDto,
} from "../domain/diagnostics.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import {
  ANTHROPIC_HARNESS_PROVIDER_ADAPTER_SCHEMA_VERSION,
  AnthropicHarnessProvider,
  DEFAULT_PROVIDER_MAX_OUTPUT_TOKENS,
  MAXIMUM_PROVIDER_TIMEOUT_MS,
  OPENAI_HARNESS_PROVIDER_ADAPTER_SCHEMA_VERSION,
  OpenAIHarnessProvider,
  type ProviderFetch,
} from "../harness/providers.js";
import {
  CLAUDE_CLI_HARNESS_PROVIDER_ADAPTER_SCHEMA_VERSION,
  CLI_PROVIDER_SHUTDOWN_RESERVE_MS,
  CLI_PROVIDER_SHUTDOWN_WORST_CASE_MS,
  CLI_PROVIDER_EXECUTABLE_PIN_ENVIRONMENT,
  CODEX_CLI_IMAGE_INSPECTION_POLICY,
  CODEX_CLI_ISOLATION_ARGUMENTS,
  CODEX_CLI_CAPTURED_EXECUTABLE_IDENTITY,
  CODEX_CLI_PINNED_VERSION,
  CODEX_CLI_TURN_ENVELOPE_JSON_SCHEMA,
  CODEX_CLI_TURN_ENVELOPE_SCHEMA_INSPECTION,
  CODEX_CLI_TURN_ENVELOPE_SCHEMA_VERSION,
  CODEX_CLI_HARNESS_PROVIDER_ADAPTER_SCHEMA_VERSION,
  ClaudeCliHarnessProvider,
  CodexCliHarnessProvider,
  codexCliCapturedToolProfileForModel,
  createCliProviderChildEnvironment,
  type CodexCliCapturedToolProfile,
  type CliSpawner,
} from "../harness/cli-providers.js";
import {
  PCB_DESIGN_COMPILATION_BUNDLE_LIMITS,
  type PcbDesignCompilationBundleDependencies,
} from "../harness/pcb-design-compilation-bundle.js";
import {
  PCB_DESIGN_INTERPRETER_LIMITS,
  createPcbProviderProfileBinding,
  type PcbIntentProvider,
  type PcbProviderProfileBinding,
} from "../harness/pcb-design-interpreter.js";
import {
  KICAD_STOCK_LIBRARY_RESOLVER_LIMITS,
  createKiCad10StockLibraryResolver,
} from "../harness/kicad-library-resolver.js";
import type { PcbDesignCompilerOptions } from "../harness/pcb-design-compiler.js";
import {
  createDeepRuleResourceProfile,
  loadDeepRuleResource,
} from "../harness/deep-rule-catalog.js";
import {
  BOUNDED_WINDOWS_PROCESS_TREE_TERMINATION_SCHEMA_VERSION,
  runBoundedProcess,
  ProcessTreeTerminationUnconfirmedError,
  type BoundedProcessOptions,
  type BoundedProcessResult,
  type BoundedProcessRunner,
  type BoundedWindowsProcessTreeTermination,
} from "../integrations/bounded-process.js";
import {
  KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS,
  KICAD_MCP_RUNTIME_IDENTITY_SCHEMA_VERSION,
  KICAD_MCP_INSPECTION_BRIDGE_SCHEMA_VERSION,
  KICAD_MCP_EXECUTION_BRIDGE_SCHEMA_VERSION,
  KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY,
  KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
  createKicadMcpRuntimeBridge as createKicadMcpRuntimeFactory,
  type KicadMcpRuntimeBridge as KicadMcpRuntime,
} from "../integrations/kicad-mcp-session.js";
import { createPcbDesignInterpreterPort } from "./contract-interpreter.js";
import { FileFluxCompilationBundleStore } from "./compilation-bundle-store.js";
import {
  createFluxKicadToolchainBinding,
  type FluxKicadToolchainBinding,
} from "./kicad-toolchain-binding.js";
import { parsePeVersionInfo } from "./pe-version-info.js";
import type {
  FluxCompilationInterpreterPort,
  FluxContractInterpretationPort,
} from "./contracts.js";
import {
  createFluxRuntime,
  type FluxRuntime,
  type FluxRuntimeDependencies,
} from "./runtime.js";

export const FLUX_PRODUCTION_PROFILE_SCHEMA_VERSION =
  "evleda.flux-production-profile.v3" as const;
export const FLUX_LEGACY_PRODUCTION_PROFILE_SCHEMA_VERSION =
  "evleda.flux-production-profile.v1" as const;
export const FLUX_LEGACY_TOOLCHAIN_PRODUCTION_PROFILE_SCHEMA_VERSION =
  "evleda.flux-production-profile.v2" as const;
export const FLUX_READINESS_SCHEMA_VERSION = "evleda.flux-readiness.v1" as const;
export const FLUX_PRODUCTION_COMPILER_PROFILE_SCHEMA_VERSION =
  "evleda.flux-production-compiler-profile.v2" as const;
export const FLUX_PROVIDER_ADAPTER_PROFILE_SCHEMA_VERSION =
  "evleda.flux-provider-adapter-profile.v2" as const;
export const FLUX_PROVIDER_EXECUTABLE_IDENTITY_SCHEMA_VERSION =
  "evleda.flux-provider-executable-identity.v1" as const;
export const FLUX_CODEX_CAPABILITY_PROFILE_SCHEMA_VERSION =
  "evleda.flux-codex-capability-profile.v1" as const;
export const FLUX_CODEX_CONFIG_PREFLIGHT_SCHEMA_VERSION =
  "evleda.flux-codex-config-preflight.v1" as const;
export const FLUX_CODEX_CONFIG_PREFLIGHT_TRANSCRIPT_PROFILE_SCHEMA_VERSION =
  "evleda.flux-codex-config-preflight-transcripts.v1" as const;
export const FLUX_KICAD_TOOLCHAIN_PROFILE_SCHEMA_VERSION =
  "evleda.flux-kicad-toolchain-profile.v1" as const;
export const FLUX_KICAD_MCP_RUNTIME_PROFILE_SCHEMA_VERSION =
  "evleda.flux-kicad-mcp-runtime-profile.v2" as const;
export const FLUX_KICAD_MCP_RUNTIME_MANIFEST_IDENTITY_SCHEMA_VERSION =
  "evleda.kicad-mcp-runtime-manifest.v2" as const;
export const FLUX_KICAD_MCP_RUNTIME_TREE_IDENTITY_SCHEMA_VERSION =
  "evleda.kicad-mcp-inspection-runtime-tree.v1" as const;
export const FLUX_KICAD_PROBE_FAILURE_SCHEMA_VERSION =
  "evleda.flux-kicad-probe-failure.v1" as const;
export const FLUX_PROVIDER_PROBE_FAILURE_SCHEMA_VERSION =
  "evleda.flux-provider-probe-failure.v1" as const;
export const FLUX_SUPPORTED_KICAD_OPERATIONAL_VERSION = "10.0.3" as const;
export const FLUX_KICAD_MCP_RUNTIME_CONNECTION_POLICY = Object.freeze({
  maxConnections: 8 as const,
  concurrency: 1 as const,
  reuse: "same-live-run-bounded" as const,
  restart: "fail-closed-reallocate-reapprove" as const,
  cleanup: "after-confirmed-session-and-editor-stop" as const,
  unconfirmed: "retain-poison-no-retry" as const,
});

export const FLUX_CODEX_CONFIG_PREFLIGHT_TRANSCRIPTS = Object.freeze([
  Object.freeze({
    kind: "no_prompt" as const,
    text: "No prompt provided via stdin.\n" as const,
    identity: Object.freeze({
      algorithm: "sha256" as const,
      digest: "9d207bb1613f71b10fdfdc9e0bcc9c191d8f6d7084780e5d21c86e2e7af396d4",
      size: 30,
    }),
  }),
  Object.freeze({
    kind: "reading_then_no_prompt" as const,
    text: "Reading prompt from stdin...\nNo prompt provided via stdin.\n" as const,
    identity: Object.freeze({
      algorithm: "sha256" as const,
      digest: "26d2eca3250a63e4eb08ad2afcc7b09fc2f5976a2ed7a09875d7d6079b6363a3",
      size: 59,
    }),
  }),
] as const);
if (FLUX_CODEX_CONFIG_PREFLIGHT_TRANSCRIPTS.some((entry) => {
  const observed = contentIdentity(Buffer.from(entry.text, "utf8"));
  return observed.size !== entry.identity.size
    || !constantTimeDigestEqual(observed.digest, entry.identity.digest);
})) throw new Error("Codex configuration-preflight transcript identity is invalid");

export const FLUX_PRODUCTION_PROFILE_ENVIRONMENT = Object.freeze({
  path: "EVLEDA_FLUX_PRODUCTION_PROFILE_PATH",
  sha256: "EVLEDA_FLUX_PRODUCTION_PROFILE_SHA256",
  sizeBytes: "EVLEDA_FLUX_PRODUCTION_PROFILE_SIZE_BYTES",
} as const);

/**
 * Public whole-interpretation ceiling. Local CLI adapters stop eight seconds
 * earlier so their confirmed tree teardown and private cleanup remain inside
 * this bound; the source control client reserves another thirty seconds for
 * durable commit and response delivery.
 */
export const FLUX_PRODUCTION_INTERPRETATION_TIMEOUT_MS = 270_000 as const;

export const FLUX_PRODUCTION_LIMITS = Object.freeze({
  profileBytes: 256 * 1024,
  kicadMcpRuntimeLockBytes: 64 * 1024,
  kicadMcpRuntimeManifestBytes: 8 * 1024 * 1024,
  kicadMcpRuntimeFileCount: 50_000,
  catalogBytes: PCB_DESIGN_COMPILATION_BUNDLE_LIMITS.maxCatalogBytes,
  executableBytes: 512 * 1024 * 1024,
  modelBytes: 256,
  pathBytes: 32 * 1024,
  versionBytes: 256,
  probeOutputBytes: 16 * 1024,
  probeTimeoutMs: 5_000,
  deadlineMs: FLUX_PRODUCTION_INTERPRETATION_TIMEOUT_MS,
  maxOutputTokens: DEFAULT_PROVIDER_MAX_OUTPUT_TOKENS,
} as const);
if (
  FLUX_PRODUCTION_INTERPRETATION_TIMEOUT_MS > MAXIMUM_PROVIDER_TIMEOUT_MS
  || FLUX_PRODUCTION_INTERPRETATION_TIMEOUT_MS > PCB_DESIGN_INTERPRETER_LIMITS.maximumTimeoutMs
) throw new Error("Flux production interpretation timeout exceeds a provider/interpreter hard bound");

export type FluxProductionProvider = "openai" | "anthropic" | "codex" | "claude-cli";
export type FluxRequestedProviderTier = "standard" | "fast" | "provider-default";
export type FluxCanonicalProviderTier = "standard" | "priority" | "provider-default";

export type FluxReadinessReasonCode =
  | "FLUX_DISABLED"
  | "ROOTS_INCOMPLETE"
  | "PROVIDER_NOT_CONFIGURED"
  | "MODEL_NOT_CONFIGURED"
  | "AUTH_NOT_CONFIGURED"
  | "PROVIDER_EXECUTABLE_UNAVAILABLE"
  | "PROVIDER_PROCESS_TERMINATION_UNCONFIRMED"
  | "CODEX_LOCAL_READ_ACK_REQUIRED"
  | "CODEX_CONFIG_INCOMPATIBLE"
  | "COMPILER_PROFILE_MISSING"
  | "COMPILER_PROFILE_INVALID"
  | "KICAD_MCP_RUNTIME_UNAVAILABLE"
  | "KICAD_PROCESS_TERMINATION_UNCONFIRMED"
  | "KICAD_TOOLCHAIN_UNAVAILABLE"
  | "KICAD_LIBRARY_UNAVAILABLE"
  | "RULE_CATALOG_UNAVAILABLE";

export interface FluxReadinessDto {
  readonly schemaVersion: typeof FLUX_READINESS_SCHEMA_VERSION;
  readonly configured: boolean;
  readonly status: "ready" | "setup_required";
  readonly reasonCodes: readonly FluxReadinessReasonCode[];
  readonly provider: null | Readonly<{
    readonly provider: FluxProductionProvider;
    readonly model: string;
    readonly requestedTier: FluxRequestedProviderTier;
    readonly canonicalTier: FluxCanonicalProviderTier;
    readonly adapterSchemaVersion: string;
    readonly providerProfileIdentity: CanonicalIdentity;
    readonly localReadCapability: "none" | "read_only_host_files";
    readonly configurationPreflight: null | Readonly<{
      readonly status: "passed";
      readonly evidenceIdentity: CanonicalIdentity;
      readonly capabilityProfileIdentity: CanonicalIdentity;
      readonly imageInspectionPolicy: typeof CODEX_CLI_IMAGE_INSPECTION_POLICY;
    }>;
  }>;
  readonly compiler: null | Readonly<{
    readonly profileIdentity: CanonicalIdentity;
    readonly catalogIdentity: CanonicalIdentity;
    readonly exactSymbolCount: number;
    readonly exactFootprintCount: number;
    readonly symbolNicknameCount: number;
    readonly footprintNicknameCount: number;
  }>;
  readonly toolchain: null | Readonly<{
    readonly identity: CanonicalIdentity;
    readonly kicadCli: Readonly<{
      readonly identity: CanonicalIdentity;
      readonly operationalVersion: string;
      readonly operationalCommit: string;
      readonly peFileVersion: string;
      readonly peProductVersion: string;
    }>;
    readonly pcbnew: Readonly<{
      readonly identity: CanonicalIdentity;
      readonly peFileVersion: string;
      readonly peProductVersion: string;
    }>;
  }>;
  readonly kicadMcpRuntime: null | Readonly<{
    readonly identity: CanonicalIdentity;
    readonly inspectionBridgeIdentity: CanonicalIdentity;
    readonly executionBridgeIdentity: CanonicalIdentity;
    readonly connectionPolicy: typeof FLUX_KICAD_MCP_RUNTIME_CONNECTION_POLICY;
  }>;
  readonly diagnostic: FluxDiagnosticDto | null;
}

const READINESS_REASON_CODES = new Set<FluxReadinessReasonCode>([
  "FLUX_DISABLED",
  "ROOTS_INCOMPLETE",
  "PROVIDER_NOT_CONFIGURED",
  "MODEL_NOT_CONFIGURED",
  "AUTH_NOT_CONFIGURED",
  "PROVIDER_EXECUTABLE_UNAVAILABLE",
  "PROVIDER_PROCESS_TERMINATION_UNCONFIRMED",
  "CODEX_LOCAL_READ_ACK_REQUIRED",
  "CODEX_CONFIG_INCOMPATIBLE",
  "COMPILER_PROFILE_MISSING",
  "COMPILER_PROFILE_INVALID",
  "KICAD_MCP_RUNTIME_UNAVAILABLE",
  "KICAD_PROCESS_TERMINATION_UNCONFIRMED",
  "KICAD_TOOLCHAIN_UNAVAILABLE",
  "KICAD_LIBRARY_UNAVAILABLE",
  "RULE_CATALOG_UNAVAILABLE",
]);

const ERROR_MESSAGES: Readonly<Record<FluxReadinessReasonCode, string>> = Object.freeze({
  FLUX_DISABLED: "Flux production composition is disabled.",
  ROOTS_INCOMPLETE: "Flux source and workspace roots must be configured together as canonical ordinary directories.",
  PROVIDER_NOT_CONFIGURED: "Flux production provider is not explicitly configured.",
  MODEL_NOT_CONFIGURED: "Flux production model is not explicitly configured.",
  AUTH_NOT_CONFIGURED: "Flux production provider authentication is unavailable.",
  PROVIDER_EXECUTABLE_UNAVAILABLE: "Flux production provider executable failed its pinned identity or authentication check.",
  PROVIDER_PROCESS_TERMINATION_UNCONFIRMED: "Flux production provider process-tree termination could not be confirmed.",
  CODEX_LOCAL_READ_ACK_REQUIRED: "Codex CLI requires an explicit profile acknowledgement of its local read capability.",
  CODEX_CONFIG_INCOMPATIBLE: "Pinned Codex CLI configuration is incompatible with the required isolation profile.",
  COMPILER_PROFILE_MISSING: "Flux production compiler/provider profile and its exact content pin are required.",
  COMPILER_PROFILE_INVALID: "Flux production compiler/provider profile failed closed validation.",
  KICAD_MCP_RUNTIME_UNAVAILABLE: "Pinned KiCad MCP runtime authority is unavailable or incompatible.",
  KICAD_PROCESS_TERMINATION_UNCONFIRMED: "KiCad readiness-probe process-tree termination could not be confirmed.",
  KICAD_TOOLCHAIN_UNAVAILABLE: "Pinned KiCad CLI and PCB editor toolchain identity is unavailable or incompatible.",
  KICAD_LIBRARY_UNAVAILABLE: "Pinned KiCad 10 stock-library roots or exact IDs are unavailable.",
  RULE_CATALOG_UNAVAILABLE: "Pinned deep-rule catalog is unavailable or has changed.",
});

export class FluxProductionCompositionError extends Error {
  public readonly evidenceIdentity: CanonicalIdentity | undefined;
  public constructor(
    public readonly reasonCode: FluxReadinessReasonCode,
    evidenceIdentity?: CanonicalIdentity,
  ) {
    super(ERROR_MESSAGES[reasonCode]);
    this.name = "FluxProductionCompositionError";
    this.evidenceIdentity = evidenceIdentity === undefined ? undefined : Object.freeze({ ...evidenceIdentity });
  }
}

const fail = (reasonCode: FluxReadinessReasonCode, evidenceIdentity?: CanonicalIdentity): never => {
  throw new FluxProductionCompositionError(reasonCode, evidenceIdentity);
};

const protect = async <Value>(
  reasonCode: FluxReadinessReasonCode,
  operation: () => Value | Promise<Value>,
): Promise<Value> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof FluxProductionCompositionError) throw error;
    return fail(reasonCode);
  }
};

const protectSync = <Value>(
  reasonCode: FluxReadinessReasonCode,
  operation: () => Value,
): Value => {
  try {
    return operation();
  } catch (error) {
    if (error instanceof FluxProductionCompositionError) throw error;
    return fail(reasonCode);
  }
};

const deepFreeze = <Value>(value: Value): Value => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const comparablePath = (value: string): string =>
  process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
const samePath = (left: string, right: string): boolean =>
  comparablePath(path.resolve(left)) === comparablePath(path.resolve(right));
const overlaps = (left: string, right: string): boolean => {
  const relative = path.relative(left, right);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
};

const exactRecord = (
  value: unknown,
  keys: readonly string[],
  reasonCode: FluxReadinessReasonCode,
): Readonly<Record<string, unknown>> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail(reasonCode);
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length
    || actual.some((key) => typeof key !== "string" || !keys.includes(key))
    || keys.some((key) => !Object.hasOwn(value, key))
  ) return fail(reasonCode);
  return value as Readonly<Record<string, unknown>>;
};

const exactText = (
  value: unknown,
  maximumBytes: number,
  reasonCode: FluxReadinessReasonCode,
): string => {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || !value.isWellFormed()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > maximumBytes
  ) return fail(reasonCode);
  return value;
};

const canonicalPathText = (value: unknown, reasonCode: FluxReadinessReasonCode): string => {
  const candidate = exactText(value, FLUX_PRODUCTION_LIMITS.pathBytes, reasonCode);
  if (
    !path.isAbsolute(candidate)
    || comparablePath(candidate) !== comparablePath(path.normalize(candidate))
  ) return fail(reasonCode);
  return candidate;
};

const canonicalDecimal = (
  value: string | undefined,
  maximum: number,
  reasonCode: FluxReadinessReasonCode,
): number => {
  if (value === undefined || !/^[1-9][0-9]*$/u.test(value)) return fail(reasonCode);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) return fail(reasonCode);
  return parsed;
};

const contentPin = (
  digest: unknown,
  size: unknown,
  maximum: number,
  reasonCode: FluxReadinessReasonCode,
): ContentIdentity => {
  if (
    typeof digest !== "string"
    || !/^[0-9a-f]{64}$/u.test(digest)
    || typeof size !== "number"
    || !Number.isSafeInteger(size)
    || size < 1
    || size > maximum
  ) return fail(reasonCode);
  return Object.freeze({ algorithm: "sha256", digest, size });
};

interface FileBinding {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

const fileBinding = (metadata: BigIntStats): FileBinding => Object.freeze({
  dev: metadata.dev,
  ino: metadata.ino,
  mode: metadata.mode,
  nlink: metadata.nlink,
  size: metadata.size,
  mtimeNs: metadata.mtimeNs,
  ctimeNs: metadata.ctimeNs,
});

const sameFileBinding = (left: FileBinding, right: FileBinding): boolean =>
  left.dev === right.dev
  && left.ino === right.ino
  && left.mode === right.mode
  && left.nlink === right.nlink
  && left.size === right.size
  && left.mtimeNs === right.mtimeNs
  && left.ctimeNs === right.ctimeNs;

const readOrdinaryFile = async (
  rawPath: string,
  maximumBytes: number,
  reasonCode: FluxReadinessReasonCode,
): Promise<Readonly<{ readonly path: string; readonly bytes: Buffer; readonly identity: ContentIdentity }>> =>
  await protect(reasonCode, async () => {
    const requested = canonicalPathText(rawPath, reasonCode);
    const beforeMetadata = await lstat(requested, { bigint: true });
    if (!beforeMetadata.isFile() || beforeMetadata.isSymbolicLink() || beforeMetadata.nlink !== 1n) return fail(reasonCode);
    if (beforeMetadata.size < 1n || beforeMetadata.size > BigInt(maximumBytes)) return fail(reasonCode);
    const canonical = await realpath(requested);
    if (!samePath(canonical, requested)) return fail(reasonCode);
    const before = fileBinding(beforeMetadata);
    const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
    const handle = await open(canonical, fsConstants.O_RDONLY | noFollow);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || !sameFileBinding(before, fileBinding(opened))) return fail(reasonCode);
      const bytes = await handle.readFile();
      if (bytes.byteLength < 1 || bytes.byteLength > maximumBytes || BigInt(bytes.byteLength) !== opened.size) return fail(reasonCode);
      const afterHandle = await handle.stat({ bigint: true });
      if (!sameFileBinding(before, fileBinding(afterHandle))) return fail(reasonCode);
      const afterPath = await lstat(canonical, { bigint: true });
      if (afterPath.isSymbolicLink() || !sameFileBinding(before, fileBinding(afterPath))) return fail(reasonCode);
      if (!samePath(await realpath(canonical), canonical)) return fail(reasonCode);
      return Object.freeze({ path: canonical, bytes, identity: Object.freeze(contentIdentity(bytes)) });
    } finally {
      await handle.close();
    }
  });

const readPinnedFile = async (
  rawPath: string,
  expected: ContentIdentity,
  maximumBytes: number,
  reasonCode: FluxReadinessReasonCode,
) => {
  const result = await readOrdinaryFile(rawPath, maximumBytes, reasonCode);
  if (
    result.identity.size !== expected.size
    || !constantTimeDigestEqual(result.identity.digest, expected.digest)
  ) return fail(reasonCode);
  return result;
};

const bindOrdinaryDirectory = async (
  rawPath: string,
  reasonCode: FluxReadinessReasonCode,
): Promise<string> => await protect(reasonCode, async () => {
  const requested = canonicalPathText(rawPath, reasonCode);
  const metadata = await lstat(requested, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return fail(reasonCode);
  const canonical = await realpath(requested);
  if (!samePath(canonical, requested)) return fail(reasonCode);
  const after = await lstat(canonical, { bigint: true });
  if (
    !after.isDirectory()
    || after.isSymbolicLink()
    || metadata.dev !== after.dev
    || metadata.ino !== after.ino
  ) return fail(reasonCode);
  return canonical;
});

const sortedUniqueTextArray = (
  value: unknown,
  maximumCount: number,
  pattern: RegExp,
  reasonCode: FluxReadinessReasonCode,
): readonly string[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximumCount) return fail(reasonCode);
  const output = value.map((entry) => {
    const text = exactText(entry, 256, reasonCode);
    if (!pattern.test(text)) return fail(reasonCode);
    return text;
  });
  if (new Set(output).size !== output.length) return fail(reasonCode);
  const sorted = [...output].sort(compareText);
  if (sorted.some((entry, index) => entry !== output[index])) return fail(reasonCode);
  return Object.freeze(output);
};

interface ExecutableProfile {
  readonly path: string;
  readonly identity: ContentIdentity;
  readonly version: string;
}

interface ProviderProfile {
  readonly provider: FluxProductionProvider;
  readonly model: string;
  readonly tier: FluxRequestedProviderTier;
  readonly deadlineMs: typeof FLUX_PRODUCTION_INTERPRETATION_TIMEOUT_MS;
  readonly executable?: ExecutableProfile;
  readonly allowCodexLocalRead?: true;
}

interface LibraryProfile {
  readonly kicadMajorVersion: 10;
  readonly symbolRoot: string;
  readonly footprintRoot: string;
  readonly exactSymbolIds: readonly string[];
  readonly exactFootprintIds: readonly string[];
  readonly stockSymbolNicknames: readonly string[];
  readonly stockFootprintNicknames: readonly string[];
}

/** Explicit toolbox-only authority to discover stock parts in approved namespaces. */
export interface KiCadToolboxStockCatalogPolicy {
  readonly schemaVersion: "evleda.kicad-stock-catalog-policy.v1";
  readonly mode: "stock_catalog";
  readonly kicadMajorVersion: 10;
  readonly symbolRoot: string;
  readonly footprintRoot: string;
  readonly stockSymbolNicknames: readonly string[];
  readonly stockFootprintNicknames: readonly string[];
}

interface KicadToolchainExecutableProfile {
  readonly path: string;
  readonly identity: ContentIdentity;
  readonly peFileVersion: string;
  readonly peProductVersion: string;
}

interface KicadCliToolchainProfile extends KicadToolchainExecutableProfile {
  readonly operationalVersion: string;
  readonly operationalCommit: string;
}

interface KicadToolchainProfile {
  readonly schemaVersion: typeof FLUX_KICAD_TOOLCHAIN_PROFILE_SCHEMA_VERSION;
  readonly binRoot: string;
  readonly kicadCli: KicadCliToolchainProfile;
  readonly pcbnew: KicadToolchainExecutableProfile;
}

interface KicadMcpRuntimeProfile {
  readonly schemaVersion: typeof FLUX_KICAD_MCP_RUNTIME_PROFILE_SCHEMA_VERSION;
  readonly lock: Readonly<{
    readonly path: string;
    readonly identity: ContentIdentity;
  }>;
  readonly runtimeBundle: Readonly<{
    readonly root: string;
    readonly manifest: Readonly<{
      readonly path: string;
      readonly identity: ContentIdentity;
    }>;
    readonly expectedClosure: Readonly<{
      readonly fileCount: number;
      readonly totalBytes: number;
      readonly manifestIdentity: CanonicalIdentity;
      readonly treeIdentity: CanonicalIdentity;
      readonly python: Readonly<{
        readonly relativePath: string;
        readonly identity: ContentIdentity;
      }>;
      readonly entrypoint: Readonly<{
        readonly relativePath: string;
        readonly identity: ContentIdentity;
      }>;
      readonly protocol: Readonly<{
        readonly distribution: "kicad-mcp-pro";
        readonly distributionVersion: "3.33.3";
        readonly serverName: "kicad-mcp-pro";
        readonly serverVersion: "1.29.1";
        readonly transport: "stdio";
        readonly modes: readonly ["readonly", "write"];
      }>;
    }>;
  }>;
  readonly runtimeParentRoot: string;
  readonly ipcSocketParentRoot: string;
  readonly runtimePolicy: Readonly<{
    readonly allocation: "fresh-per-connect";
    readonly cleanup: "required";
    readonly dependencyNetwork: "disabled";
    readonly packageResolution: "none";
    readonly workingDirectory: "fresh-private";
    readonly projectBinding: "post-connect-protocol";
    readonly environmentFiles: "disabled";
    readonly pythonLaunch: Readonly<{
      readonly flags: readonly ["-I", "-s", "-E", "-B"];
      readonly argumentCount: 5;
      readonly argumentsSha256: string;
      readonly bytecodeWrites: "disabled";
    }>;
    readonly verificationTimeoutMs: typeof KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS;
    readonly connectionDeadlinePolicy?: "bounded-phases-v1";
  }>;
  readonly processTreeSupervision: Readonly<{
    readonly platform: "win32";
    readonly strategy: typeof KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY;
    readonly terminator: Readonly<{
      readonly path: string;
      readonly relativePath: string;
      readonly identity: ContentIdentity;
    }>;
    readonly terminationTimeoutMs: typeof KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS;
    readonly rootProof: "exact-child-process-handle-immediately-before-spawn";
    readonly earlyRootExit: "zero-numeric-signal-retain-poison";
    readonly activeCalls: "fence-abort-drain-before-cleanup";
    readonly confirmation: "taskkill-success-plus-exact-root-exit-and-close";
    readonly runtimeCleanup: "after-tree-confirmation-and-runtime-revalidation-only";
    readonly unconfirmed: "retain-poison-no-retry";
  }>;
  readonly connectionPolicy: typeof FLUX_KICAD_MCP_RUNTIME_CONNECTION_POLICY;
}

interface DeepRuleProfile {
  readonly resourceRoot: string;
  readonly resourceIdentity: string;
  readonly catalogIdentity: CanonicalIdentity;
  readonly selection: Readonly<{
    readonly maxRules: number;
    readonly maxPromptBytes: number;
    readonly maxPromptTokens: number;
    readonly featureCoveragePolicy: "require-all";
  }>;
}

interface ProductionProfile {
  readonly schemaVersion: typeof FLUX_PRODUCTION_PROFILE_SCHEMA_VERSION;
  readonly provider: ProviderProfile;
  readonly kicadToolchain: KicadToolchainProfile;
  readonly kicadMcpRuntime: KicadMcpRuntimeProfile;
  readonly libraries: LibraryProfile;
  readonly deepRules: DeepRuleProfile;
}

const executableProfile = (value: unknown): ExecutableProfile => {
  const record = exactRecord(
    value,
    ["path", "sha256", "sizeBytes", "version"],
    "PROVIDER_EXECUTABLE_UNAVAILABLE",
  );
  return deepFreeze({
    path: canonicalPathText(record.path, "PROVIDER_EXECUTABLE_UNAVAILABLE"),
    identity: contentPin(
      record.sha256,
      record.sizeBytes,
      FLUX_PRODUCTION_LIMITS.executableBytes,
      "PROVIDER_EXECUTABLE_UNAVAILABLE",
    ),
    version: exactText(
      record.version,
      FLUX_PRODUCTION_LIMITS.versionBytes,
      "PROVIDER_EXECUTABLE_UNAVAILABLE",
    ),
  });
};

const parseProviderProfile = (value: unknown): ProviderProfile => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("PROVIDER_NOT_CONFIGURED");
  }
  const provider = (value as Readonly<Record<string, unknown>>).provider;
  if (!(["openai", "anthropic", "codex", "claude-cli"] as const).includes(provider as FluxProductionProvider)) {
    return fail("PROVIDER_NOT_CONFIGURED");
  }
  const providerName = provider as FluxProductionProvider;
  const cli = providerName === "codex" || providerName === "claude-cli";
  const codexKeys = ["provider", "model", "tier", "deadlineMs", "executable", "allowCodexLocalRead"] as const;
  if (providerName === "codex") {
    const raw = value as Readonly<Record<string, unknown>>;
    const actual = Reflect.ownKeys(raw);
    if (
      actual.some((key) => typeof key !== "string" || !codexKeys.includes(key as typeof codexKeys[number]))
      || codexKeys.filter((key) => key !== "allowCodexLocalRead").some((key) => !Object.hasOwn(raw, key))
    ) return fail("COMPILER_PROFILE_INVALID");
    if (raw.allowCodexLocalRead !== true) return fail("CODEX_LOCAL_READ_ACK_REQUIRED");
  }
  const record = providerName === "codex"
    ? exactRecord(value, codexKeys, "COMPILER_PROFILE_INVALID")
    : cli
      ? exactRecord(value, ["provider", "model", "tier", "deadlineMs", "executable"], "PROVIDER_NOT_CONFIGURED")
      : exactRecord(value, ["provider", "model", "tier", "deadlineMs"], "PROVIDER_NOT_CONFIGURED");
  const model = exactText(record.model, FLUX_PRODUCTION_LIMITS.modelBytes, "MODEL_NOT_CONFIGURED");
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u.test(model)
    || model.toLocaleLowerCase("en-US").includes("file:")
    || /(?:^|[.:@+_-])(?:sk-(?:proj-)?|api[_-]?key|bearer[:_-]|token[:_-])/iu.test(model)
  ) return fail("MODEL_NOT_CONFIGURED");
  if (record.deadlineMs !== FLUX_PRODUCTION_LIMITS.deadlineMs) return fail("PROVIDER_NOT_CONFIGURED");
  const tier = record.tier;
  if (providerName === "openai") {
    if (tier !== "standard" && tier !== "fast") return fail("PROVIDER_NOT_CONFIGURED");
  } else if (tier !== "provider-default") return fail("PROVIDER_NOT_CONFIGURED");
  if (providerName === "codex" && record.allowCodexLocalRead !== true) {
    return fail("CODEX_LOCAL_READ_ACK_REQUIRED");
  }
  return deepFreeze({
    provider: providerName,
    model,
    tier: tier as FluxRequestedProviderTier,
    deadlineMs: FLUX_PRODUCTION_LIMITS.deadlineMs,
    ...(cli ? { executable: executableProfile(record.executable) } : {}),
    ...(providerName === "codex" ? { allowCodexLocalRead: true as const } : {}),
  });
};

const parseLibraryProfile = (value: unknown): LibraryProfile => {
  const record = exactRecord(value, [
    "kicadMajorVersion",
    "symbolRoot",
    "footprintRoot",
    "exactSymbolIds",
    "exactFootprintIds",
    "stockSymbolNicknames",
    "stockFootprintNicknames",
  ], "KICAD_LIBRARY_UNAVAILABLE");
  if (record.kicadMajorVersion !== 10) return fail("KICAD_LIBRARY_UNAVAILABLE");
  const libraryId = /^[A-Za-z0-9][A-Za-z0-9_.+@~-]{0,127}:[A-Za-z0-9][A-Za-z0-9_.+@~-]{0,127}$/u;
  const nickname = /^[A-Za-z0-9][A-Za-z0-9_.+@~-]{0,127}$/u;
  const exactSymbolIds = sortedUniqueTextArray(
    record.exactSymbolIds,
    KICAD_STOCK_LIBRARY_RESOLVER_LIMITS.maxExactSymbolIds,
    libraryId,
    "KICAD_LIBRARY_UNAVAILABLE",
  );
  const exactFootprintIds = sortedUniqueTextArray(
    record.exactFootprintIds,
    KICAD_STOCK_LIBRARY_RESOLVER_LIMITS.maxExactFootprintIds,
    libraryId,
    "KICAD_LIBRARY_UNAVAILABLE",
  );
  const stockSymbolNicknames = sortedUniqueTextArray(
    record.stockSymbolNicknames,
    KICAD_STOCK_LIBRARY_RESOLVER_LIMITS.maxStockNicknames,
    nickname,
    "KICAD_LIBRARY_UNAVAILABLE",
  );
  const stockFootprintNicknames = sortedUniqueTextArray(
    record.stockFootprintNicknames,
    KICAD_STOCK_LIBRARY_RESOLVER_LIMITS.maxStockNicknames,
    nickname,
    "KICAD_LIBRARY_UNAVAILABLE",
  );
  const symbolNicknames = new Set(exactSymbolIds.map((id) => id.split(":", 1)[0]!));
  const footprintNicknames = new Set(exactFootprintIds.map((id) => id.split(":", 1)[0]!));
  if (
    canonicalJson([...symbolNicknames].sort(compareText)) !== canonicalJson(stockSymbolNicknames)
    || canonicalJson([...footprintNicknames].sort(compareText)) !== canonicalJson(stockFootprintNicknames)
  ) return fail("KICAD_LIBRARY_UNAVAILABLE");
  return deepFreeze({
    kicadMajorVersion: 10,
    symbolRoot: canonicalPathText(record.symbolRoot, "KICAD_LIBRARY_UNAVAILABLE"),
    footprintRoot: canonicalPathText(record.footprintRoot, "KICAD_LIBRARY_UNAVAILABLE"),
    exactSymbolIds,
    exactFootprintIds,
    stockSymbolNicknames,
    stockFootprintNicknames,
  });
};

const boundedInteger = (value: unknown, maximum: number): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    return fail("RULE_CATALOG_UNAVAILABLE");
  }
  return value;
};

const parseToolboxLibraryProfile = (value: unknown): LibraryProfile | KiCadToolboxStockCatalogPolicy => {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (value as Record<string, unknown>).mode !== "stock_catalog") return parseLibraryProfile(value);
  const record = exactRecord(value, ["schemaVersion", "mode", "kicadMajorVersion", "symbolRoot", "footprintRoot",
    "stockSymbolNicknames", "stockFootprintNicknames"], "KICAD_LIBRARY_UNAVAILABLE");
  if (record.schemaVersion !== "evleda.kicad-stock-catalog-policy.v1" || record.kicadMajorVersion !== 10) {
    return fail("KICAD_LIBRARY_UNAVAILABLE");
  }
  const nickname = /^[A-Za-z0-9][A-Za-z0-9_.+@~-]{0,127}$/u;
  return deepFreeze({ schemaVersion: "evleda.kicad-stock-catalog-policy.v1", mode: "stock_catalog", kicadMajorVersion: 10,
    symbolRoot: canonicalPathText(record.symbolRoot, "KICAD_LIBRARY_UNAVAILABLE"),
    footprintRoot: canonicalPathText(record.footprintRoot, "KICAD_LIBRARY_UNAVAILABLE"),
    stockSymbolNicknames: sortedUniqueTextArray(record.stockSymbolNicknames,
      KICAD_STOCK_LIBRARY_RESOLVER_LIMITS.maxStockNicknames, nickname, "KICAD_LIBRARY_UNAVAILABLE"),
    stockFootprintNicknames: sortedUniqueTextArray(record.stockFootprintNicknames,
      KICAD_STOCK_LIBRARY_RESOLVER_LIMITS.maxStockNicknames, nickname, "KICAD_LIBRARY_UNAVAILABLE") });
};

const parseDeepRuleProfile = (value: unknown): DeepRuleProfile => {
  const record = exactRecord(
    value,
    ["resourceRoot", "resourceIdentity", "catalogIdentity", "selection"],
    "RULE_CATALOG_UNAVAILABLE",
  );
  const selection = exactRecord(
    record.selection,
    ["maxRules", "maxPromptBytes", "maxPromptTokens", "featureCoveragePolicy"],
    "RULE_CATALOG_UNAVAILABLE",
  );
  if (selection.featureCoveragePolicy !== "require-all") return fail("RULE_CATALOG_UNAVAILABLE");
  const resourceIdentity = exactText(record.resourceIdentity, 96, "RULE_CATALOG_UNAVAILABLE");
  if (!/^sha256:[0-9a-f]{64}$/u.test(resourceIdentity)) return fail("RULE_CATALOG_UNAVAILABLE");
  return deepFreeze({
    resourceRoot: canonicalPathText(record.resourceRoot, "RULE_CATALOG_UNAVAILABLE"),
    resourceIdentity,
    catalogIdentity: record.catalogIdentity as CanonicalIdentity,
    selection: {
      maxRules: boundedInteger(selection.maxRules, 40),
      maxPromptBytes: boundedInteger(selection.maxPromptBytes, 16 * 1024),
      maxPromptTokens: boundedInteger(selection.maxPromptTokens, 16_384),
      featureCoveragePolicy: "require-all",
    },
  });
};

const toolchainVersion = (value: unknown): string => {
  const text = exactText(value, 128, "KICAD_TOOLCHAIN_UNAVAILABLE");
  if (!/^(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){2,3}(?:[-+][A-Za-z0-9.-]+)?$/u.test(text)) {
    return fail("KICAD_TOOLCHAIN_UNAVAILABLE");
  }
  return text;
};

function toolchainExecutableProfile(
  value: unknown,
  kind: "kicad-cli",
): KicadCliToolchainProfile;
function toolchainExecutableProfile(
  value: unknown,
  kind: "pcbnew",
): KicadToolchainExecutableProfile;
function toolchainExecutableProfile(
  value: unknown,
  kind: "kicad-cli" | "pcbnew",
): KicadToolchainExecutableProfile | KicadCliToolchainProfile {
  const keys = kind === "kicad-cli"
    ? [
        "path", "sha256", "sizeBytes", "operationalVersion", "operationalCommit",
        "peFileVersion", "peProductVersion",
      ] as const
    : ["path", "sha256", "sizeBytes", "peFileVersion", "peProductVersion"] as const;
  const record = exactRecord(value, keys, "KICAD_TOOLCHAIN_UNAVAILABLE");
  const base = {
    path: canonicalPathText(record.path, "KICAD_TOOLCHAIN_UNAVAILABLE"),
    identity: contentPin(
      record.sha256,
      record.sizeBytes,
      FLUX_PRODUCTION_LIMITS.executableBytes,
      "KICAD_TOOLCHAIN_UNAVAILABLE",
    ),
    peFileVersion: toolchainVersion(record.peFileVersion),
    peProductVersion: toolchainVersion(record.peProductVersion),
  };
  if (kind === "pcbnew") return deepFreeze(base);
  const operationalCommit = exactText(
    record.operationalCommit,
    40,
    "KICAD_TOOLCHAIN_UNAVAILABLE",
  );
  if (!/^[0-9a-f]{40}$/u.test(operationalCommit)) return fail("KICAD_TOOLCHAIN_UNAVAILABLE");
  return deepFreeze({
    ...base,
    operationalVersion: toolchainVersion(record.operationalVersion),
    operationalCommit,
  });
}

const parseKicadToolchainProfile = (value: unknown): KicadToolchainProfile => {
  const record = exactRecord(
    value,
    ["schemaVersion", "binRoot", "kicadCli", "pcbnew"],
    "KICAD_TOOLCHAIN_UNAVAILABLE",
  );
  if (record.schemaVersion !== FLUX_KICAD_TOOLCHAIN_PROFILE_SCHEMA_VERSION) {
    return fail("KICAD_TOOLCHAIN_UNAVAILABLE");
  }
  const profile = {
    schemaVersion: FLUX_KICAD_TOOLCHAIN_PROFILE_SCHEMA_VERSION,
    binRoot: canonicalPathText(record.binRoot, "KICAD_TOOLCHAIN_UNAVAILABLE"),
    kicadCli: toolchainExecutableProfile(record.kicadCli, "kicad-cli"),
    pcbnew: toolchainExecutableProfile(record.pcbnew, "pcbnew"),
  };
  if (!samePath(path.dirname(profile.kicadCli.path), profile.binRoot)
    || !samePath(path.dirname(profile.pcbnew.path), profile.binRoot)
    || path.basename(profile.kicadCli.path).toLocaleLowerCase("en-US") !== "kicad-cli.exe"
    || path.basename(profile.pcbnew.path).toLocaleLowerCase("en-US") !== "pcbnew.exe") {
    return fail("KICAD_TOOLCHAIN_UNAVAILABLE");
  }
  return deepFreeze(profile);
};

const inspectionRelativePath = (value: unknown): string => {
  const text = exactText(value, 4 * 1024, "KICAD_MCP_RUNTIME_UNAVAILABLE");
  if (text.includes("\\") || text.startsWith("/") || path.posix.normalize(text) !== text
    || text.split("/").some((part) => part === "" || part === "." || part === "..")) {
    return fail("KICAD_MCP_RUNTIME_UNAVAILABLE");
  }
  return text;
};

const kicadMcpArgumentsSha256 = (arguments_: readonly string[]): string => createHash("sha256")
  .update("evleda.kicad-mcp-arguments.v1\0", "utf8")
  .update(JSON.stringify(arguments_), "utf8")
  .digest("hex");

const parseKicadMcpRuntimeProfile = (value: unknown): KicadMcpRuntimeProfile => {
  const record = exactRecord(
    value,
    ["schemaVersion", "lock", "runtimeBundle", "runtimeParentRoot", "ipcSocketParentRoot", "runtimePolicy", "processTreeSupervision", "connectionPolicy"],
    "KICAD_MCP_RUNTIME_UNAVAILABLE",
  );
  if (record.schemaVersion !== FLUX_KICAD_MCP_RUNTIME_PROFILE_SCHEMA_VERSION) {
    return fail("KICAD_MCP_RUNTIME_UNAVAILABLE");
  }
  const lock = exactRecord(
    record.lock,
    ["path", "sha256", "sizeBytes"],
    "KICAD_MCP_RUNTIME_UNAVAILABLE",
  );
  const runtimeBundle = exactRecord(
    record.runtimeBundle,
    ["root", "manifest", "expectedClosure"],
    "KICAD_MCP_RUNTIME_UNAVAILABLE",
  );
  const manifest = exactRecord(
    runtimeBundle.manifest,
    ["path", "sha256", "sizeBytes"],
    "KICAD_MCP_RUNTIME_UNAVAILABLE",
  );
  const expectedClosure = exactRecord(
    runtimeBundle.expectedClosure,
    ["fileCount", "totalBytes", "manifestIdentity", "treeIdentity", "python", "entrypoint", "protocol"],
    "KICAD_MCP_RUNTIME_UNAVAILABLE",
  );
  if (!Number.isSafeInteger(expectedClosure.fileCount)
    || (expectedClosure.fileCount as number) < 1
    || (expectedClosure.fileCount as number) > FLUX_PRODUCTION_LIMITS.kicadMcpRuntimeFileCount) {
    return fail("KICAD_MCP_RUNTIME_UNAVAILABLE");
  }
  if (!Number.isSafeInteger(expectedClosure.totalBytes)
    || (expectedClosure.totalBytes as number) < 1
    || (expectedClosure.totalBytes as number) > 1024 * 1024 * 1024) {
    return fail("KICAD_MCP_RUNTIME_UNAVAILABLE");
  }
  const python = exactRecord(
    expectedClosure.python,
    ["relativePath", "sha256", "sizeBytes"],
    "KICAD_MCP_RUNTIME_UNAVAILABLE",
  );
  const entrypoint = exactRecord(
    expectedClosure.entrypoint,
    ["relativePath", "sha256", "sizeBytes"],
    "KICAD_MCP_RUNTIME_UNAVAILABLE",
  );
  const protocol = exactRecord(
    expectedClosure.protocol,
    ["distribution", "distributionVersion", "serverName", "serverVersion", "transport", "modes"],
    "KICAD_MCP_RUNTIME_UNAVAILABLE",
  );
  if (protocol.distribution !== "kicad-mcp-pro"
    || protocol.distributionVersion !== "3.33.3"
    || protocol.serverName !== "kicad-mcp-pro"
    || protocol.serverVersion !== "1.29.1"
    || protocol.transport !== "stdio"
    || canonicalJson(protocol.modes) !== canonicalJson(["readonly", "write"])) {
    return fail("KICAD_MCP_RUNTIME_UNAVAILABLE");
  }
  const runtimePolicy = exactRecord(
    record.runtimePolicy,
    ["allocation", "cleanup", "dependencyNetwork", "packageResolution", "workingDirectory", "projectBinding", "environmentFiles", "pythonLaunch", "verificationTimeoutMs",
      ...(record.runtimePolicy !== null && typeof record.runtimePolicy === "object" && Object.hasOwn(record.runtimePolicy, "connectionDeadlinePolicy") ? ["connectionDeadlinePolicy"] : [])],
    "KICAD_MCP_RUNTIME_UNAVAILABLE",
  );
  const pythonLaunch = exactRecord(
    runtimePolicy.pythonLaunch,
    ["flags", "argumentCount", "argumentsSha256", "bytecodeWrites"],
    "KICAD_MCP_RUNTIME_UNAVAILABLE",
  );
  if (runtimePolicy.allocation !== "fresh-per-connect"
    || runtimePolicy.cleanup !== "required"
    || runtimePolicy.dependencyNetwork !== "disabled"
    || runtimePolicy.packageResolution !== "none"
    || runtimePolicy.workingDirectory !== "fresh-private"
    || runtimePolicy.projectBinding !== "post-connect-protocol"
    || runtimePolicy.environmentFiles !== "disabled"
    || canonicalJson(pythonLaunch.flags) !== canonicalJson(["-I", "-s", "-E", "-B"])
    || pythonLaunch.argumentCount !== 5
    || typeof pythonLaunch.argumentsSha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(pythonLaunch.argumentsSha256)
    || pythonLaunch.bytecodeWrites !== "disabled"
    || runtimePolicy.verificationTimeoutMs !== KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS
    || (Object.hasOwn(runtimePolicy, "connectionDeadlinePolicy") && runtimePolicy.connectionDeadlinePolicy !== "bounded-phases-v1")) {
    return fail("KICAD_MCP_RUNTIME_UNAVAILABLE");
  }
  const processTreeSupervision = exactRecord(
    record.processTreeSupervision,
    ["platform", "strategy", "terminator", "terminationTimeoutMs", "rootProof", "earlyRootExit", "activeCalls", "confirmation", "runtimeCleanup", "unconfirmed"],
    "KICAD_MCP_RUNTIME_UNAVAILABLE",
  );
  const terminator = exactRecord(
    processTreeSupervision.terminator,
    ["path", "relativePath", "sha256", "sizeBytes"],
    "KICAD_MCP_RUNTIME_UNAVAILABLE",
  );
  if (processTreeSupervision.platform !== "win32"
    || processTreeSupervision.strategy !== KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY
    || processTreeSupervision.terminationTimeoutMs !== KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS
    || processTreeSupervision.rootProof !== "exact-child-process-handle-immediately-before-spawn"
    || processTreeSupervision.earlyRootExit !== "zero-numeric-signal-retain-poison"
    || processTreeSupervision.activeCalls !== "fence-abort-drain-before-cleanup"
    || processTreeSupervision.confirmation !== "taskkill-success-plus-exact-root-exit-and-close"
    || processTreeSupervision.runtimeCleanup !== "after-tree-confirmation-and-runtime-revalidation-only"
    || processTreeSupervision.unconfirmed !== "retain-poison-no-retry") {
    return fail("KICAD_MCP_RUNTIME_UNAVAILABLE");
  }
  const connectionPolicy = exactRecord(
    record.connectionPolicy,
    ["maxConnections", "concurrency", "reuse", "restart", "cleanup", "unconfirmed"],
    "KICAD_MCP_RUNTIME_UNAVAILABLE",
  );
  if (canonicalJson(connectionPolicy) !== canonicalJson(FLUX_KICAD_MCP_RUNTIME_CONNECTION_POLICY)) {
    return fail("KICAD_MCP_RUNTIME_UNAVAILABLE");
  }
  const bundleRoot = canonicalPathText(runtimeBundle.root, "KICAD_MCP_RUNTIME_UNAVAILABLE");
  const manifestPath = canonicalPathText(manifest.path, "KICAD_MCP_RUNTIME_UNAVAILABLE");
  if (overlaps(bundleRoot, manifestPath) || overlaps(manifestPath, bundleRoot)) {
    return fail("KICAD_MCP_RUNTIME_UNAVAILABLE");
  }
  const runtimeParentRoot = canonicalPathText(record.runtimeParentRoot, "KICAD_MCP_RUNTIME_UNAVAILABLE");
  const ipcSocketParentRoot = canonicalPathText(record.ipcSocketParentRoot, "KICAD_MCP_RUNTIME_UNAVAILABLE");
  const terminatorPath = canonicalPathText(terminator.path, "KICAD_MCP_RUNTIME_UNAVAILABLE");
  const terminatorRelativePath = inspectionRelativePath(terminator.relativePath);
  const pythonRelativePath = inspectionRelativePath(python.relativePath);
  const entrypointRelativePath = inspectionRelativePath(entrypoint.relativePath);
  if (!samePath(path.resolve(bundleRoot, ...terminatorRelativePath.split("/")), terminatorPath)) {
    return fail("KICAD_MCP_RUNTIME_UNAVAILABLE");
  }
  const pythonBaseArguments = [
    "-I", "-s", "-E", "-B",
    path.resolve(bundleRoot, ...entrypointRelativePath.split("/")),
  ] as const;
  if (pythonLaunch.argumentCount !== pythonBaseArguments.length
    || !constantTimeDigestEqual(
      pythonLaunch.argumentsSha256 as string,
      kicadMcpArgumentsSha256(pythonBaseArguments),
    )) return fail("KICAD_MCP_RUNTIME_UNAVAILABLE");
  if (!samePath(path.parse(bundleRoot).root, path.parse(runtimeParentRoot).root)
    || !samePath(path.parse(bundleRoot).root, path.parse(ipcSocketParentRoot).root)) {
    return fail("KICAD_MCP_RUNTIME_UNAVAILABLE");
  }
  const manifestIdentity = protectSync(
    "KICAD_MCP_RUNTIME_UNAVAILABLE",
    () => validateCanonicalIdentity(expectedClosure.manifestIdentity, "Inspection bridge manifest identity"),
  );
  const treeIdentity = protectSync(
    "KICAD_MCP_RUNTIME_UNAVAILABLE",
    () => validateCanonicalIdentity(expectedClosure.treeIdentity, "Inspection bridge tree identity"),
  );
  if (manifestIdentity.schemaVersion !== FLUX_KICAD_MCP_RUNTIME_MANIFEST_IDENTITY_SCHEMA_VERSION
    || treeIdentity.schemaVersion !== FLUX_KICAD_MCP_RUNTIME_TREE_IDENTITY_SCHEMA_VERSION) {
    return fail("KICAD_MCP_RUNTIME_UNAVAILABLE");
  }
  return deepFreeze({
    schemaVersion: FLUX_KICAD_MCP_RUNTIME_PROFILE_SCHEMA_VERSION,
    lock: {
      path: canonicalPathText(lock.path, "KICAD_MCP_RUNTIME_UNAVAILABLE"),
      identity: contentPin(
        lock.sha256,
        lock.sizeBytes,
        FLUX_PRODUCTION_LIMITS.kicadMcpRuntimeLockBytes,
        "KICAD_MCP_RUNTIME_UNAVAILABLE",
      ),
    },
    runtimeBundle: {
      root: bundleRoot,
      manifest: {
        path: manifestPath,
        identity: contentPin(
          manifest.sha256,
          manifest.sizeBytes,
          FLUX_PRODUCTION_LIMITS.kicadMcpRuntimeManifestBytes,
          "KICAD_MCP_RUNTIME_UNAVAILABLE",
        ),
      },
      expectedClosure: {
        fileCount: expectedClosure.fileCount as number,
        totalBytes: expectedClosure.totalBytes as number,
        manifestIdentity,
        treeIdentity,
        python: {
          relativePath: pythonRelativePath,
          identity: contentPin(
            python.sha256,
            python.sizeBytes,
            FLUX_PRODUCTION_LIMITS.executableBytes,
            "KICAD_MCP_RUNTIME_UNAVAILABLE",
          ),
        },
        entrypoint: {
          relativePath: entrypointRelativePath,
          identity: contentPin(
            entrypoint.sha256,
            entrypoint.sizeBytes,
            FLUX_PRODUCTION_LIMITS.kicadMcpRuntimeManifestBytes,
            "KICAD_MCP_RUNTIME_UNAVAILABLE",
          ),
        },
        protocol: {
          distribution: "kicad-mcp-pro",
          distributionVersion: "3.33.3",
          serverName: "kicad-mcp-pro",
          serverVersion: "1.29.1",
          transport: "stdio",
          modes: Object.freeze(["readonly", "write"] as const),
        },
      },
    },
    runtimeParentRoot,
    ipcSocketParentRoot,
    runtimePolicy: {
      allocation: "fresh-per-connect",
      cleanup: "required",
      dependencyNetwork: "disabled",
      packageResolution: "none",
      workingDirectory: "fresh-private",
      projectBinding: "post-connect-protocol",
      environmentFiles: "disabled",
      pythonLaunch: {
        flags: Object.freeze(["-I", "-s", "-E", "-B"] as const),
        argumentCount: 5,
        argumentsSha256: pythonLaunch.argumentsSha256 as string,
        bytecodeWrites: "disabled",
      },
      verificationTimeoutMs: KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS,
      ...(runtimePolicy.connectionDeadlinePolicy === undefined ? {} : { connectionDeadlinePolicy: "bounded-phases-v1" as const }),
    },
    processTreeSupervision: {
      platform: "win32",
      strategy: KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY,
      terminator: {
        path: terminatorPath,
        relativePath: terminatorRelativePath,
        identity: contentPin(
          terminator.sha256,
          terminator.sizeBytes,
          FLUX_PRODUCTION_LIMITS.executableBytes,
          "KICAD_MCP_RUNTIME_UNAVAILABLE",
        ),
      },
      terminationTimeoutMs: KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
      rootProof: "exact-child-process-handle-immediately-before-spawn",
      earlyRootExit: "zero-numeric-signal-retain-poison",
      activeCalls: "fence-abort-drain-before-cleanup",
      confirmation: "taskkill-success-plus-exact-root-exit-and-close",
      runtimeCleanup: "after-tree-confirmation-and-runtime-revalidation-only",
      unconfirmed: "retain-poison-no-retry",
    },
    connectionPolicy: { ...FLUX_KICAD_MCP_RUNTIME_CONNECTION_POLICY },
  });
};

const assertKicadProfileCompatibility = (
  kicadToolchain: KicadToolchainProfile,
  libraries: LibraryProfile,
): void => {
  const toolchainVersions = [
    kicadToolchain.kicadCli.operationalVersion,
    kicadToolchain.kicadCli.peFileVersion,
    kicadToolchain.kicadCli.peProductVersion,
    kicadToolchain.pcbnew.peFileVersion,
    kicadToolchain.pcbnew.peProductVersion,
  ];
  if (toolchainVersions.some((version) => version.split(".", 1)[0] !== String(libraries.kicadMajorVersion))) {
    return fail("KICAD_TOOLCHAIN_UNAVAILABLE");
  }
  if (kicadToolchain.kicadCli.operationalVersion !== FLUX_SUPPORTED_KICAD_OPERATIONAL_VERSION
    || kicadToolchain.kicadCli.peProductVersion !== FLUX_SUPPORTED_KICAD_OPERATIONAL_VERSION
    || kicadToolchain.pcbnew.peProductVersion !== FLUX_SUPPORTED_KICAD_OPERATIONAL_VERSION
    || !kicadToolchain.kicadCli.peFileVersion.startsWith(`${FLUX_SUPPORTED_KICAD_OPERATIONAL_VERSION}.`)
    || !kicadToolchain.pcbnew.peFileVersion.startsWith(`${FLUX_SUPPORTED_KICAD_OPERATIONAL_VERSION}.`)) {
    return fail("KICAD_TOOLCHAIN_UNAVAILABLE");
  }
};

const parseProductionProfile = (value: unknown): ProductionProfile => protectSync(
  "COMPILER_PROFILE_INVALID",
  () => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const candidate = value as Readonly<Record<string, unknown>>;
      const schemaVersion = candidate.schemaVersion;
      if (schemaVersion === FLUX_LEGACY_PRODUCTION_PROFILE_SCHEMA_VERSION
        && !Object.hasOwn(candidate, "kicadToolchain")) {
        const withoutToolchain = exactRecord(
          value,
          ["schemaVersion", "provider", "libraries", "deepRules"],
          "COMPILER_PROFILE_INVALID",
        );
        try {
          parseProviderProfile(withoutToolchain.provider);
          parseLibraryProfile(withoutToolchain.libraries);
          parseDeepRuleProfile(withoutToolchain.deepRules);
        } catch {
          return fail("COMPILER_PROFILE_INVALID");
        }
        return fail("KICAD_TOOLCHAIN_UNAVAILABLE");
      }
      if (schemaVersion === FLUX_PRODUCTION_PROFILE_SCHEMA_VERSION
        && !Object.hasOwn(candidate, "kicadToolchain")) {
        const withoutToolchain = exactRecord(
          value,
          ["schemaVersion", "provider", "kicadMcpRuntime", "libraries", "deepRules"],
          "COMPILER_PROFILE_INVALID",
        );
        try {
          parseProviderProfile(withoutToolchain.provider);
          parseKicadMcpRuntimeProfile(withoutToolchain.kicadMcpRuntime);
          parseLibraryProfile(withoutToolchain.libraries);
          parseDeepRuleProfile(withoutToolchain.deepRules);
        } catch {
          return fail("COMPILER_PROFILE_INVALID");
        }
        return fail("KICAD_TOOLCHAIN_UNAVAILABLE");
      }
      if ((schemaVersion === FLUX_LEGACY_TOOLCHAIN_PRODUCTION_PROFILE_SCHEMA_VERSION
          || schemaVersion === FLUX_PRODUCTION_PROFILE_SCHEMA_VERSION)
        && Object.hasOwn(candidate, "kicadToolchain")
        && !Object.hasOwn(candidate, "kicadMcpRuntime")) {
        const withoutBridge = exactRecord(
          value,
          ["schemaVersion", "provider", "kicadToolchain", "libraries", "deepRules"],
          "COMPILER_PROFILE_INVALID",
        );
        try {
          parseProviderProfile(withoutBridge.provider);
          const kicadToolchain = parseKicadToolchainProfile(withoutBridge.kicadToolchain);
          const libraries = parseLibraryProfile(withoutBridge.libraries);
          assertKicadProfileCompatibility(kicadToolchain, libraries);
          parseDeepRuleProfile(withoutBridge.deepRules);
        } catch {
          return fail("COMPILER_PROFILE_INVALID");
        }
        return fail("KICAD_MCP_RUNTIME_UNAVAILABLE");
      }
    }
    const record = exactRecord(
      value,
      ["schemaVersion", "provider", "kicadToolchain", "kicadMcpRuntime", "libraries", "deepRules"],
      "COMPILER_PROFILE_INVALID",
    );
    if (record.schemaVersion !== FLUX_PRODUCTION_PROFILE_SCHEMA_VERSION) return fail("COMPILER_PROFILE_INVALID");
    const kicadToolchain = parseKicadToolchainProfile(record.kicadToolchain);
    const libraries = parseLibraryProfile(record.libraries);
    assertKicadProfileCompatibility(kicadToolchain, libraries);
    return deepFreeze({
      schemaVersion: FLUX_PRODUCTION_PROFILE_SCHEMA_VERSION,
      provider: parseProviderProfile(record.provider),
      kicadToolchain,
      kicadMcpRuntime: parseKicadMcpRuntimeProfile(record.kicadMcpRuntime),
      libraries,
      deepRules: parseDeepRuleProfile(record.deepRules),
    });
  },
);

const requiredRootPair = async (environment: NodeJS.ProcessEnv) => {
  const sourceValue = environment.EVLEDA_FLUX_SOURCE_ROOT;
  const workspaceValue = environment.EVLEDA_FLUX_WORKSPACE_ROOT;
  if (sourceValue === undefined || workspaceValue === undefined) return fail("ROOTS_INCOMPLETE");
  const sourceRoot = await bindOrdinaryDirectory(sourceValue, "ROOTS_INCOMPLETE");
  const workspaceRoot = await bindOrdinaryDirectory(workspaceValue, "ROOTS_INCOMPLETE");
  if (overlaps(sourceRoot, workspaceRoot) || overlaps(workspaceRoot, sourceRoot)) return fail("ROOTS_INCOMPLETE");
  return Object.freeze({ sourceRoot, workspaceRoot });
};

const profilePinFromEnvironment = (environment: NodeJS.ProcessEnv): Readonly<{
  readonly path: string;
  readonly identity: ContentIdentity;
}> => {
  const profilePath = environment[FLUX_PRODUCTION_PROFILE_ENVIRONMENT.path];
  const digest = environment[FLUX_PRODUCTION_PROFILE_ENVIRONMENT.sha256];
  const sizeText = environment[FLUX_PRODUCTION_PROFILE_ENVIRONMENT.sizeBytes];
  if (profilePath === undefined || digest === undefined || sizeText === undefined) {
    return fail("COMPILER_PROFILE_MISSING");
  }
  const size = canonicalDecimal(
    sizeText,
    FLUX_PRODUCTION_LIMITS.profileBytes,
    "COMPILER_PROFILE_INVALID",
  );
  return deepFreeze({
    path: canonicalPathText(profilePath, "COMPILER_PROFILE_INVALID"),
    identity: contentPin(digest, size, FLUX_PRODUCTION_LIMITS.profileBytes, "COMPILER_PROFILE_INVALID"),
  });
};

const configuredSecret = (environment: NodeJS.ProcessEnv, key: "OPENAI_API_KEY" | "ANTHROPIC_API_KEY"): string => {
  const value = environment[key];
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > 16 * 1024
  ) return fail("AUTH_NOT_CONFIGURED");
  return value;
};

const definedEnvironment = (environment: NodeJS.ProcessEnv): Readonly<Record<string, string>> => {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value === "string") output[key] = value;
  }
  return Object.freeze(output);
};

const INSPECTION_BRIDGE_ENVIRONMENT_KEYS = Object.freeze([
  "SYSTEMROOT",
  "WINDIR",
] as const);

const kicadMcpRuntimeEnvironment = (
  environment: NodeJS.ProcessEnv,
): Readonly<Record<string, string | undefined>> => {
  const output: Record<string, string | undefined> = {};
  for (const key of INSPECTION_BRIDGE_ENVIRONMENT_KEYS) {
    const matches = Object.entries(environment).filter(([candidate]) =>
      process.platform === "win32"
        ? candidate.toLocaleUpperCase("en-US") === key
        : candidate === key);
    if (matches.length > 1) return fail("KICAD_MCP_RUNTIME_UNAVAILABLE");
    const value = matches[0]?.[1];
    if (value !== undefined) output[key] = value;
  }
  return Object.freeze(output);
};

const boundedProcessPrimaryClass = (
  value: string | null,
): "BoundedProcessError" | "ProcessAbortError" | "ProcessOutputLimitError" | "ProcessTimeoutError" | "none" | "other" => {
  switch (value) {
    case null: return "none";
    case "BoundedProcessError":
    case "ProcessAbortError":
    case "ProcessOutputLimitError":
    case "ProcessTimeoutError": return value;
    default: return "other";
  }
};

const providerProbeFailureEvidence = (
  provider: "codex" | "claude-cli",
  probe: "version" | "auth",
  executableIdentity: CanonicalIdentity,
  error: ProcessTreeTerminationUnconfirmedError,
): CanonicalIdentity => canonicalIdentity({
  schemaVersion: FLUX_PROVIDER_PROBE_FAILURE_SCHEMA_VERSION,
  boundary: "provider_startup_probe" as const,
  provider,
  probe,
  outcome: "termination_unconfirmed" as const,
  executableIdentity,
  primaryClass: boundedProcessPrimaryClass(error.primaryErrorName),
  confirmationFailure: error.confirmationFailure,
  retainWorkingDirectory: true as const,
}, FLUX_PROVIDER_PROBE_FAILURE_SCHEMA_VERSION);

const probe = async (
  runner: BoundedProcessRunner,
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  provider: "codex" | "claude-cli",
  probeKind: "version" | "auth",
  executableIdentity: CanonicalIdentity,
  requireSuccess = true,
  windowsProcessTreeTermination?: BoundedWindowsProcessTreeTermination,
): Promise<BoundedProcessResult> => {
  const options: BoundedProcessOptions = {
    command,
    args,
    cwd: path.dirname(command),
    env: definedEnvironment(environment),
    timeoutMs: FLUX_PRODUCTION_LIMITS.probeTimeoutMs,
    maxOutputBytes: FLUX_PRODUCTION_LIMITS.probeOutputBytes,
    ...(windowsProcessTreeTermination === undefined ? {} : { windowsProcessTreeTermination }),
  };
  let result: BoundedProcessResult;
  try {
    result = await runner(options);
  } catch (error) {
    if (error instanceof ProcessTreeTerminationUnconfirmedError) {
      return fail(
        "PROVIDER_PROCESS_TERMINATION_UNCONFIRMED",
        providerProbeFailureEvidence(provider, probeKind, executableIdentity, error),
      );
    }
    if (error instanceof FluxProductionCompositionError) throw error;
    return fail("PROVIDER_EXECUTABLE_UNAVAILABLE");
  }
  if (requireSuccess && result.exitCode !== 0) return fail("PROVIDER_EXECUTABLE_UNAVAILABLE");
  return result;
};

const exactProbeText = (result: BoundedProcessResult): string => {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  if (stdout.length > 0 && stderr.length > 0) return fail("PROVIDER_EXECUTABLE_UNAVAILABLE");
  return exactText(stdout || stderr, FLUX_PRODUCTION_LIMITS.versionBytes, "PROVIDER_EXECUTABLE_UNAVAILABLE");
};

interface ExecutableBinding {
  readonly path: string;
  readonly contentIdentity: ContentIdentity;
  readonly version: string;
  readonly identity: CanonicalIdentity;
  readonly codexConfigurationPreflight: null | Readonly<{
    readonly evidenceIdentity: CanonicalIdentity;
    readonly capabilityProfileIdentity: CanonicalIdentity;
  }>;
}

const requireCodexCapturedToolProfile = (model: string): CodexCliCapturedToolProfile =>
  codexCliCapturedToolProfileForModel(model) ?? fail("CODEX_CONFIG_INCOMPATIBLE");

const codexCapabilityProfile = (
  capturedToolProfile: CodexCliCapturedToolProfile,
  capturedExecutableIdentity: ContentIdentity = CODEX_CLI_CAPTURED_EXECUTABLE_IDENTITY,
): Readonly<{
  readonly identity: CanonicalIdentity;
}> => {
  const payload = {
    schemaVersion: FLUX_CODEX_CAPABILITY_PROFILE_SCHEMA_VERSION,
    isolationArguments: [...CODEX_CLI_ISOLATION_ARGUMENTS],
    sandbox: "read-only" as const,
    shellEnvironment: "none" as const,
    webSearch: "disabled" as const,
    mcpServers: "empty" as const,
    userConfig: "ignored" as const,
    executionRules: "ignored" as const,
    sessionPersistence: "ephemeral" as const,
    imageInspection: CODEX_CLI_IMAGE_INSPECTION_POLICY,
    localReadAcknowledgementRequired: true as const,
    pinnedExecutableVersion: CODEX_CLI_PINNED_VERSION,
    capturedExecutableIdentity,
    capturedToolProfile,
    configurationPreflightTranscriptPolicy: {
      schemaVersion: FLUX_CODEX_CONFIG_PREFLIGHT_TRANSCRIPT_PROFILE_SCHEMA_VERSION,
      exitCode: 1 as const,
      terminationSignal: null,
      stdout: Object.freeze({ algorithm: "sha256" as const, digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", size: 0 }),
      outputFile: "absent" as const,
      allowedStderr: FLUX_CODEX_CONFIG_PREFLIGHT_TRANSCRIPTS.map((entry) => ({
        kind: entry.kind,
        identity: entry.identity,
      })),
    },
    outputTransport: {
      schemaVersion: CODEX_CLI_TURN_ENVELOPE_SCHEMA_VERSION,
      schemaIdentity: canonicalIdentity(
        CODEX_CLI_TURN_ENVELOPE_JSON_SCHEMA,
        CODEX_CLI_TURN_ENVELOPE_SCHEMA_VERSION,
      ),
      strictSubsetInspection: CODEX_CLI_TURN_ENVELOPE_SCHEMA_INSPECTION,
      nestedTurnValidation: "host_full_schema" as const,
    },
  };
  return deepFreeze({
    identity: canonicalIdentity(payload, FLUX_CODEX_CAPABILITY_PROFILE_SCHEMA_VERSION),
  });
};

const codexPreflightEvidence = (
  executableIdentity: CanonicalIdentity,
  capabilityProfileIdentity: CanonicalIdentity,
  outcome: "passed" | "incompatible" | "probe_failed",
  exitClass: "expected_no_prompt" | "unexpected_success" | "unexpected_failure" | "unavailable",
  stdoutClass: "empty" | "nonempty" | "unavailable",
  stderrClass: "expected_no_prompt" | "other" | "empty" | "unavailable",
  observations: Readonly<{
    readonly transcriptKind: "no_prompt" | "reading_then_no_prompt" | "other" | "empty" | "unavailable";
    readonly transcriptIdentity: ContentIdentity | null;
    readonly schemaClass: "exact" | "drifted" | "unavailable";
    readonly outputFileClass: "absent" | "present" | "unavailable";
  }> = Object.freeze({
    transcriptKind: "unavailable",
    transcriptIdentity: null,
    schemaClass: "unavailable",
    outputFileClass: "unavailable",
  }),
): CanonicalIdentity => canonicalIdentity({
  schemaVersion: FLUX_CODEX_CONFIG_PREFLIGHT_SCHEMA_VERSION,
  executableIdentity,
  capabilityProfileIdentity,
  outcome,
  exitClass,
  stdoutClass,
  stderrClass,
  observations,
}, FLUX_CODEX_CONFIG_PREFLIGHT_SCHEMA_VERSION);

const runCodexConfigurationPreflight = async (
  runner: BoundedProcessRunner,
  executable: ExecutableBinding,
  environment: NodeJS.ProcessEnv,
  temporaryDirectory: string | undefined,
  cleanup: (directory: string) => Promise<void>,
  capturedToolProfile: CodexCliCapturedToolProfile,
  capturedExecutableIdentity: ContentIdentity,
  windowsProcessTreeTermination?: BoundedWindowsProcessTreeTermination,
): Promise<Readonly<{
  readonly evidenceIdentity: CanonicalIdentity;
  readonly capabilityProfileIdentity: CanonicalIdentity;
}>> => {
  // This no-model, closed-stdin probe checks CLI configuration; its selected capture is not account/model access proof.
  const capabilityProfileIdentity = codexCapabilityProfile(capturedToolProfile, capturedExecutableIdentity).identity;
  const directory = await protect("CODEX_CONFIG_INCOMPATIBLE", async () => await mkdtemp(path.join(
    temporaryDirectory ?? os.tmpdir(),
    "evleda-codex-config-preflight-",
  )));
  let primaryFailure: unknown;
  let retainDirectory = false;
  try {
    const schemaPath = path.join(directory, "codex-turn-envelope.schema.json");
    const outputPath = path.join(directory, "codex-turn-envelope.output.json");
    const schemaBytes = Buffer.from(canonicalJson(CODEX_CLI_TURN_ENVELOPE_JSON_SCHEMA), "utf8");
    const schemaContentIdentity = contentIdentity(schemaBytes);
    await protect("CODEX_CONFIG_INCOMPATIBLE", async () => await writeFile(
      schemaPath,
      schemaBytes,
      { flag: "wx" },
    ));
    const options: BoundedProcessOptions = {
      command: executable.path,
      args: [
        "exec",
        ...CODEX_CLI_ISOLATION_ARGUMENTS,
        "--output-schema", schemaPath,
        "--output-last-message", outputPath,
        "-",
      ],
      cwd: directory,
      env: definedEnvironment(environment),
      timeoutMs: FLUX_PRODUCTION_LIMITS.probeTimeoutMs,
      maxOutputBytes: FLUX_PRODUCTION_LIMITS.probeOutputBytes,
      ...(windowsProcessTreeTermination === undefined ? {} : { windowsProcessTreeTermination }),
    };
    let result: BoundedProcessResult;
    try {
      result = await runner(options);
    } catch (error) {
      retainDirectory = error instanceof ProcessTreeTerminationUnconfirmedError;
      if (retainDirectory) {
        return fail("PROVIDER_PROCESS_TERMINATION_UNCONFIRMED", codexPreflightEvidence(
          executable.identity,
          capabilityProfileIdentity,
          "probe_failed",
          "unavailable",
          "unavailable",
          "unavailable",
        ));
      }
      return fail("CODEX_CONFIG_INCOMPATIBLE", codexPreflightEvidence(
        executable.identity,
        capabilityProfileIdentity,
        "probe_failed",
        "unavailable",
        "unavailable",
        "unavailable",
      ));
    }
    const stdout = result.stdout;
    const stderr = result.stderr;
    const matchedTranscript = FLUX_CODEX_CONFIG_PREFLIGHT_TRANSCRIPTS.find((entry) => entry.text === stderr);
    const transcriptIdentity = contentIdentity(Buffer.from(stderr, "utf8"));
    let schemaClass: "exact" | "drifted" = "exact";
    try {
      await readPinnedFile(
        schemaPath,
        schemaContentIdentity,
        FLUX_PRODUCTION_LIMITS.profileBytes,
        "CODEX_CONFIG_INCOMPATIBLE",
      );
    } catch {
      schemaClass = "drifted";
    }
    let outputFileClass: "absent" | "present" | "unavailable";
    try {
      await lstat(outputPath);
      outputFileClass = "present";
    } catch (error) {
      outputFileClass = (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unavailable";
    }
    const passed = result.exitCode === 1
      && stdout === ""
      && matchedTranscript !== undefined
      && schemaClass === "exact"
      && outputFileClass === "absent";
    const evidenceIdentity = codexPreflightEvidence(
      executable.identity,
      capabilityProfileIdentity,
      passed ? "passed" : "incompatible",
      result.exitCode === 1 && matchedTranscript !== undefined
        ? "expected_no_prompt"
        : result.exitCode === 0 ? "unexpected_success" : "unexpected_failure",
      stdout === "" ? "empty" : "nonempty",
      matchedTranscript !== undefined ? "expected_no_prompt" : stderr === "" ? "empty" : "other",
      {
        transcriptKind: matchedTranscript?.kind ?? (stderr === "" ? "empty" : "other"),
        transcriptIdentity,
        schemaClass,
        outputFileClass,
      },
    );
    if (!passed) return fail("CODEX_CONFIG_INCOMPATIBLE", evidenceIdentity);
    return deepFreeze({ evidenceIdentity, capabilityProfileIdentity });
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    if (!retainDirectory) {
      try {
        await cleanup(directory);
      } catch {
        if (primaryFailure === undefined) {
          return fail("CODEX_CONFIG_INCOMPATIBLE", codexPreflightEvidence(
            executable.identity,
            capabilityProfileIdentity,
            "probe_failed",
            "unavailable",
            "unavailable",
            "unavailable",
          ));
        }
      }
    }
  }
};

const bindProviderExecutable = async (
  profile: ProviderProfile,
  environment: NodeJS.ProcessEnv,
  runner: BoundedProcessRunner,
  temporaryDirectory?: string,
  removePreflightDirectory: (directory: string) => Promise<void> = async (directory) => await rm(directory, { recursive: true, force: true }),
  capturedExecutableIdentity: ContentIdentity = CODEX_CLI_CAPTURED_EXECUTABLE_IDENTITY,
  windowsProcessTreeTermination?: BoundedWindowsProcessTreeTermination,
): Promise<ExecutableBinding> => {
  if (profile.provider !== "codex" && profile.provider !== "claude-cli") {
    return fail("PROVIDER_EXECUTABLE_UNAVAILABLE");
  }
  const cliProvider = profile.provider;
  const capturedToolProfile = cliProvider === "codex" ? requireCodexCapturedToolProfile(profile.model) : null;
  const executable = profile.executable;
  if (executable === undefined) return fail("PROVIDER_EXECUTABLE_UNAVAILABLE");
  const pinned = await readPinnedFile(
    executable.path,
    executable.identity,
    FLUX_PRODUCTION_LIMITS.executableBytes,
    "PROVIDER_EXECUTABLE_UNAVAILABLE",
  );
  if (process.platform === "win32" && path.extname(pinned.path).toLocaleLowerCase("en-US") !== ".exe") {
    return fail("PROVIDER_EXECUTABLE_UNAVAILABLE");
  }
  const executableBindingIdentity = canonicalIdentity({
    schemaVersion: FLUX_PROVIDER_EXECUTABLE_IDENTITY_SCHEMA_VERSION,
    provider: cliProvider,
    contentIdentity: pinned.identity,
    version: executable.version,
  }, FLUX_PROVIDER_EXECUTABLE_IDENTITY_SCHEMA_VERSION);
  if (cliProvider === "codex" && (
    executable.version !== CODEX_CLI_PINNED_VERSION
    || pinned.identity.size !== capturedExecutableIdentity.size
    || !constantTimeDigestEqual(pinned.identity.digest, capturedExecutableIdentity.digest)
  )) {
    return fail("CODEX_CONFIG_INCOMPATIBLE", codexPreflightEvidence(
      executableBindingIdentity,
      codexCapabilityProfile(capturedToolProfile!, capturedExecutableIdentity).identity,
      "incompatible",
      "unavailable",
      "unavailable",
      "unavailable",
    ));
  }
  const childEnvironment = createCliProviderChildEnvironment(cliProvider, environment);
  const recheck = async (): Promise<void> => {
    const current = await readPinnedFile(
      executable.path,
      executable.identity,
      FLUX_PRODUCTION_LIMITS.executableBytes,
      "PROVIDER_EXECUTABLE_UNAVAILABLE",
    );
    if (!samePath(current.path, pinned.path)) return fail("PROVIDER_EXECUTABLE_UNAVAILABLE");
  };
  await recheck();
  const versionResult = await probe(
    runner,
    pinned.path,
    ["--version"],
    childEnvironment,
    cliProvider,
    "version",
    executableBindingIdentity,
    true,
    windowsProcessTreeTermination,
  );
  await recheck();
  if (exactProbeText(versionResult) !== executable.version) return fail("PROVIDER_EXECUTABLE_UNAVAILABLE");
  const authResult = cliProvider === "codex"
    ? await probe(
        runner,
        pinned.path,
        ["login", "status"],
        childEnvironment,
        cliProvider,
        "auth",
        executableBindingIdentity,
        false,
        windowsProcessTreeTermination,
      )
    : await probe(
        runner,
        pinned.path,
        ["auth", "status", "--json"],
        childEnvironment,
        cliProvider,
        "auth",
        executableBindingIdentity,
        false,
        windowsProcessTreeTermination,
      );
  await recheck();
  if (authResult.exitCode !== 0) return fail("AUTH_NOT_CONFIGURED");
  if (cliProvider === "codex") {
    const status = `${authResult.stdout}\n${authResult.stderr}`;
    if (
      /(?:not logged in|not authenticated|authentication (?:is )?required|unauthorized)/iu.test(status)
      || !/(?:logged in|authenticated)/iu.test(status)
    ) return fail("AUTH_NOT_CONFIGURED");
  } else {
    let status: unknown;
    try {
      status = parsePortableJsonBytes(Buffer.from(authResult.stdout, "utf8"), {
        maxBytes: FLUX_PRODUCTION_LIMITS.probeOutputBytes,
        maxDepth: 4,
        maxNodes: 64,
        maxArrayLength: 8,
        maxOwnKeys: 32,
        maxKeyBytes: 128,
        maxStringBytes: 4 * 1024,
      });
    } catch {
      return fail("AUTH_NOT_CONFIGURED");
    }
    if (status === null || typeof status !== "object" || Array.isArray(status)
      || (status as Record<string, unknown>).loggedIn !== true) return fail("AUTH_NOT_CONFIGURED");
  }
  const base = deepFreeze({
    path: pinned.path,
    contentIdentity: pinned.identity,
    version: executable.version,
    identity: executableBindingIdentity,
    codexConfigurationPreflight: null,
  });
  if (capturedToolProfile === null) return base;
  await recheck();
  const preflight = await runCodexConfigurationPreflight(
    runner,
    base,
    childEnvironment,
    temporaryDirectory,
    removePreflightDirectory,
    capturedToolProfile,
    capturedExecutableIdentity,
    windowsProcessTreeTermination,
  );
  await recheck();
  return deepFreeze({ ...base, codexConfigurationPreflight: preflight });
};

const adapterBaseVersion = (provider: FluxProductionProvider): string => {
  switch (provider) {
    case "openai": return OPENAI_HARNESS_PROVIDER_ADAPTER_SCHEMA_VERSION;
    case "anthropic": return ANTHROPIC_HARNESS_PROVIDER_ADAPTER_SCHEMA_VERSION;
    case "codex": return CODEX_CLI_HARNESS_PROVIDER_ADAPTER_SCHEMA_VERSION;
    case "claude-cli": return CLAUDE_CLI_HARNESS_PROVIDER_ADAPTER_SCHEMA_VERSION;
  }
};

const KICAD_PROBE_ENVIRONMENT_KEYS = Object.freeze([
  "PATH", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR",
  "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "LANG", "LC_ALL",
] as const);

const kicadProbeEnvironment = (environment: NodeJS.ProcessEnv): Readonly<Record<string, string>> => {
  const selected: Record<string, string> = {};
  for (const key of KICAD_PROBE_ENVIRONMENT_KEYS) {
    const matches = Object.entries(environment).filter(([candidate]) => process.platform === "win32"
      ? candidate.toLocaleLowerCase("en-US") === key.toLocaleLowerCase("en-US")
      : candidate === key);
    if (matches.length > 1) return fail("KICAD_TOOLCHAIN_UNAVAILABLE");
    const value = matches[0]?.[1];
    if (typeof value === "string" && value.length > 0 && !value.includes("\0")) selected[key] = value;
  }
  selected.NO_COLOR = "1";
  selected.LANG = "C";
  selected.LANGUAGE = "C";
  selected.LC_ALL = "C";
  return Object.freeze(selected);
};

const selectedEnvironmentPath = (
  environment: NodeJS.ProcessEnv,
  key: "EVLEDA_KICAD_CLI" | "EVLEDA_PCBNEW",
  expected: string,
): void => {
  const matches = Object.entries(environment).filter(([candidate]) =>
    process.platform === "win32"
      ? candidate.toLocaleLowerCase("en-US") === key.toLocaleLowerCase("en-US")
      : candidate === key);
  if (matches.length > 1) return fail("KICAD_TOOLCHAIN_UNAVAILABLE");
  const value = matches[0]?.[1];
  if (value !== undefined && (
    !samePath(canonicalPathText(value, "KICAD_TOOLCHAIN_UNAVAILABLE"), expected)
  )) return fail("KICAD_TOOLCHAIN_UNAVAILABLE");
};

const bindKicadToolchain = async (
  profile: KicadToolchainProfile,
  canonicalBinRoot: string,
  environment: NodeJS.ProcessEnv,
  dependencies: FluxProductionCompositionDependencies,
  windowsProcessTreeTermination?: BoundedWindowsProcessTreeTermination,
): Promise<FluxKicadToolchainBinding> => {
  const runner = dependencies.processRunner ?? runBoundedProcess;
  selectedEnvironmentPath(environment, "EVLEDA_KICAD_CLI", profile.kicadCli.path);
  selectedEnvironmentPath(environment, "EVLEDA_PCBNEW", profile.pcbnew.path);
  const [kicadCliFile, pcbnewFile] = await Promise.all([
    readPinnedFile(
      profile.kicadCli.path,
      profile.kicadCli.identity,
      FLUX_PRODUCTION_LIMITS.executableBytes,
      "KICAD_TOOLCHAIN_UNAVAILABLE",
    ),
    readPinnedFile(
      profile.pcbnew.path,
      profile.pcbnew.identity,
      FLUX_PRODUCTION_LIMITS.executableBytes,
      "KICAD_TOOLCHAIN_UNAVAILABLE",
    ),
  ]);
  if (!samePath(path.dirname(kicadCliFile.path), canonicalBinRoot)
    || !samePath(path.dirname(pcbnewFile.path), canonicalBinRoot)
    || path.basename(kicadCliFile.path).toLocaleLowerCase("en-US") !== "kicad-cli.exe"
    || path.basename(pcbnewFile.path).toLocaleLowerCase("en-US") !== "pcbnew.exe") {
    return fail("KICAD_TOOLCHAIN_UNAVAILABLE");
  }
  const kicadCliPe = protectSync("KICAD_TOOLCHAIN_UNAVAILABLE", () =>
    parsePeVersionInfo(kicadCliFile.bytes));
  const pcbnewPe = protectSync("KICAD_TOOLCHAIN_UNAVAILABLE", () =>
    parsePeVersionInfo(pcbnewFile.bytes));
  if (kicadCliPe.fileVersion !== profile.kicadCli.peFileVersion
    || kicadCliPe.productVersion !== profile.kicadCli.peProductVersion
    || pcbnewPe.fileVersion !== profile.pcbnew.peFileVersion
    || pcbnewPe.productVersion !== profile.pcbnew.peProductVersion
    || kicadCliPe.fixedFileVersion !== kicadCliPe.fileVersion
    || pcbnewPe.fixedFileVersion !== pcbnewPe.fileVersion
    || kicadCliPe.fixedProductVersion !== kicadCliPe.fixedFileVersion
    || pcbnewPe.fixedProductVersion !== pcbnewPe.fixedFileVersion
    || kicadCliPe.fileVersion !== pcbnewPe.fileVersion
    || kicadCliPe.productVersion !== pcbnewPe.productVersion
    || profile.kicadCli.operationalVersion !== kicadCliPe.productVersion
    || kicadCliPe.originalFilename.toLocaleLowerCase("en-US") !== "kicad.exe"
    || kicadCliPe.internalName.toLocaleLowerCase("en-US") !== "kicad"
    || pcbnewPe.originalFilename.toLocaleLowerCase("en-US") !== "pcbnew.exe"
    || pcbnewPe.internalName.toLocaleLowerCase("en-US") !== "pcbnew") {
    return fail("KICAD_TOOLCHAIN_UNAVAILABLE");
  }
  const recheck = async (): Promise<void> => {
    const [currentCli, currentEditor] = await Promise.all([
      readPinnedFile(
        profile.kicadCli.path,
        profile.kicadCli.identity,
        FLUX_PRODUCTION_LIMITS.executableBytes,
        "KICAD_TOOLCHAIN_UNAVAILABLE",
      ),
      readPinnedFile(
        profile.pcbnew.path,
        profile.pcbnew.identity,
        FLUX_PRODUCTION_LIMITS.executableBytes,
        "KICAD_TOOLCHAIN_UNAVAILABLE",
      ),
    ]);
    if (!samePath(currentCli.path, kicadCliFile.path)
      || !samePath(currentEditor.path, pcbnewFile.path)) return fail("KICAD_TOOLCHAIN_UNAVAILABLE");
  };
  const probeEnvironment = kicadProbeEnvironment(environment);
  const runProbe = async (
    probe: "version" | "commit",
    args: readonly string[],
    expected: string,
  ): Promise<void> => {
    await recheck();
    let result: BoundedProcessResult;
    try {
      result = await runner({
        command: kicadCliFile.path,
        args,
        cwd: canonicalBinRoot,
        env: probeEnvironment,
        timeoutMs: FLUX_PRODUCTION_LIMITS.probeTimeoutMs,
        maxOutputBytes: FLUX_PRODUCTION_LIMITS.probeOutputBytes,
        ...(windowsProcessTreeTermination === undefined ? {} : { windowsProcessTreeTermination }),
      });
    } catch (error) {
      if (error instanceof ProcessTreeTerminationUnconfirmedError) {
        const primaryClass = [
          "BoundedProcessError",
          "ProcessAbortError",
          "ProcessOutputLimitError",
          "ProcessTimeoutError",
        ].includes(error.primaryErrorName ?? "")
          ? error.primaryErrorName
          : error.primaryErrorName === null ? "none" : "other";
        return fail(
          "KICAD_PROCESS_TERMINATION_UNCONFIRMED",
          canonicalIdentity({
            schemaVersion: FLUX_KICAD_PROBE_FAILURE_SCHEMA_VERSION,
            tool: "kicad-cli",
            probe,
            outcome: "termination_unconfirmed",
            executableContentIdentity: kicadCliFile.identity,
            primaryClass,
            confirmationFailure: error.confirmationFailure,
          }, FLUX_KICAD_PROBE_FAILURE_SCHEMA_VERSION),
        );
      }
      return fail("KICAD_TOOLCHAIN_UNAVAILABLE");
    }
    await recheck();
    if (result.exitCode !== 0
      || result.stderr !== ""
      || result.stdout !== `${expected}\r\n`) return fail("KICAD_TOOLCHAIN_UNAVAILABLE");
  };
  await runProbe("version", ["version"], profile.kicadCli.operationalVersion);
  await runProbe("commit", ["version", "--format", "commit"], profile.kicadCli.operationalCommit);
  return protectSync("KICAD_TOOLCHAIN_UNAVAILABLE", () => createFluxKicadToolchainBinding({
    binRoot: canonicalBinRoot,
    kicadCli: {
      path: kicadCliFile.path,
      contentIdentity: kicadCliFile.identity,
      operationalVersion: profile.kicadCli.operationalVersion,
      operationalCommit: profile.kicadCli.operationalCommit,
      peFileVersion: kicadCliPe.fileVersion,
      peProductVersion: kicadCliPe.productVersion,
    },
    pcbnew: {
      path: pcbnewFile.path,
      contentIdentity: pcbnewFile.identity,
      peFileVersion: pcbnewPe.fileVersion,
      peProductVersion: pcbnewPe.productVersion,
    },
  }));
};

const canonicalTier = (profile: ProviderProfile): FluxCanonicalProviderTier =>
  profile.provider === "openai"
    ? profile.tier === "fast" ? "priority" : "standard"
    : "provider-default";

export interface FluxProductionCompositionDependencies {
  readonly fetch?: ProviderFetch;
  readonly cliSpawn?: CliSpawner;
  readonly processRunner?: BoundedProcessRunner;
  readonly temporaryDirectory?: string;
  /** Test seam; production recursively removes the isolated preflight directory. */
  readonly removePreflightDirectory?: (directory: string) => Promise<void>;
  /** Test-only seam for fake executable bytes; production must omit it. */
  readonly codexCapturedExecutableIdentityForTesting?: ContentIdentity;
  /** Test seam; production validates the pinned sidecar lock through the default factory. */
  readonly createKicadMcpRuntime?: typeof createKicadMcpRuntimeFactory;
}

export interface FluxProductionComposition {
  readonly readiness: FluxReadinessDto;
  readonly providerProfile: PcbProviderProfileBinding;
  readonly compilerProfileIdentity: CanonicalIdentity;
  readonly kicadToolchain: FluxKicadToolchainBinding;
  readonly kicadMcpRuntime: KicadMcpRuntime;
  readonly contractInterpreter: FluxContractInterpretationPort & FluxCompilationInterpreterPort;
  readonly compilationBundleStore: FileFluxCompilationBundleStore;
  readonly compilationBundleDependencies: PcbDesignCompilationBundleDependencies;
  readonly createRuntime: () => Promise<FluxRuntime>;
}

/**
 * Read only the native CAD sections of an explicitly pinned local profile.
 * Legacy provider/compiler fields are not interpreted, probed or instantiated.
 * Keeping this adapter here reuses the established parsers without duplicating
 * their runtime policy or making the interactive toolbox enter Flux startup.
 */
async function readPinnedToolboxProfile(input: Readonly<{ path: string; contentIdentity: ContentIdentity }>) {
  if (input.contentIdentity.algorithm !== "sha256") return fail("COMPILER_PROFILE_INVALID");
  const pin = contentPin(input.contentIdentity.digest, input.contentIdentity.size,
    FLUX_PRODUCTION_LIMITS.profileBytes, "COMPILER_PROFILE_INVALID");
  const file = await readPinnedFile(input.path, pin, FLUX_PRODUCTION_LIMITS.profileBytes, "COMPILER_PROFILE_INVALID");
  const value = parsePortableJsonBytes(file.bytes, {
    maxBytes: FLUX_PRODUCTION_LIMITS.profileBytes, maxDepth: 12, maxNodes: 8_192,
    maxArrayLength: KICAD_STOCK_LIBRARY_RESOLVER_LIMITS.maxStockNicknames,
    maxOwnKeys: 64, maxKeyBytes: 128, maxStringBytes: FLUX_PRODUCTION_LIMITS.pathBytes,
  });
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail("COMPILER_PROFILE_INVALID");
  const record = value as Readonly<Record<string, unknown>>;
  return { file, record };
}

export async function readKicadNativeProfile(input: Readonly<{ path: string; contentIdentity: ContentIdentity }>) {
  const { file, record } = await readPinnedToolboxProfile(input);
  const calculator = record.kicadTransmissionLine === undefined ? undefined
    : exactRecord(record.kicadTransmissionLine, ["path", "sha256", "sizeBytes"], "COMPILER_PROFILE_INVALID");
  const referenceCoverage = record.kicadReferenceCoverage === undefined ? undefined
    : exactRecord(record.kicadReferenceCoverage, ["path", "sha256", "sizeBytes"], "COMPILER_PROFILE_INVALID");
  const planeContacts = record.kicadPlaneContacts === undefined ? undefined
    : exactRecord(record.kicadPlaneContacts, ["runtimeRoot", "manifest", "helper"], "COMPILER_PROFILE_INVALID");
  const planeFile = (value: unknown, maximum: number) => {
    const file = exactRecord(value, ["path", "sha256", "sizeBytes"], "COMPILER_PROFILE_INVALID");
    return Object.freeze({path:canonicalPathText(file.path,"COMPILER_PROFILE_INVALID"),
      identity:contentPin(file.sha256,file.sizeBytes,maximum,"COMPILER_PROFILE_INVALID")});
  };
  return Object.freeze({ path: file.path, contentIdentity: file.identity,
    kicadToolchain: parseKicadToolchainProfile(record.kicadToolchain),
    kicadMcpRuntime: parseKicadMcpRuntimeProfile(record.kicadMcpRuntime),
    ...(planeContacts === undefined ? {} : { kicadPlaneContacts: Object.freeze({
      runtimeRoot:canonicalPathText(planeContacts.runtimeRoot,"COMPILER_PROFILE_INVALID"),
      manifest:planeFile(planeContacts.manifest,8*1024*1024),helper:planeFile(planeContacts.helper,1024*1024)}) }),
    ...(calculator === undefined ? {} : { kicadTransmissionLine: Object.freeze({
      path: canonicalPathText(calculator.path, "COMPILER_PROFILE_INVALID"),
      identity: contentPin(calculator.sha256, calculator.sizeBytes, 128 * 1024 * 1024, "COMPILER_PROFILE_INVALID"),
    }) }),
    ...(referenceCoverage === undefined ? {} : { kicadReferenceCoverage: Object.freeze({
      path: canonicalPathText(referenceCoverage.path, "COMPILER_PROFILE_INVALID"),
      identity: contentPin(referenceCoverage.sha256, referenceCoverage.sizeBytes, 128 * 1024 * 1024, "COMPILER_PROFILE_INVALID"),
    }) }) });
}

/** Native design dependencies only; no provider/compiler process is initialized. */
export async function readKicadToolboxDesignProfile(input: Readonly<{ path: string; contentIdentity: ContentIdentity }>) {
  const { file, record } = await readPinnedToolboxProfile(input);
  return Object.freeze({ path: file.path, contentIdentity: file.identity,
    libraries: parseToolboxLibraryProfile(record.libraries), deepRules: parseDeepRuleProfile(record.deepRules) });
}

const adapterAndExecutable = async (
  profile: ProviderProfile,
  profileContentIdentity: ContentIdentity,
  environment: NodeJS.ProcessEnv,
  dependencies: FluxProductionCompositionDependencies,
  windowsProcessTreeTermination: BoundedWindowsProcessTreeTermination,
  windowsProcessTreeTerminationAuthorityIdentity: CanonicalIdentity,
): Promise<Readonly<{
  readonly adapter: PcbIntentProvider;
  readonly adapterSchemaVersion: string;
  readonly executable: ExecutableBinding | null;
  readonly runtimeEnvironment: NodeJS.ProcessEnv;
}>> => {
  const runner = dependencies.processRunner ?? runBoundedProcess;
  const providerTurnTimeoutMs = profile.provider === "codex" || profile.provider === "claude-cli"
    ? profile.deadlineMs - CLI_PROVIDER_SHUTDOWN_RESERVE_MS
    : profile.deadlineMs;
  if (providerTurnTimeoutMs < 1) return fail("PROVIDER_NOT_CONFIGURED");
  const executable = profile.provider === "codex" || profile.provider === "claude-cli"
    ? await bindProviderExecutable(
        profile,
        environment,
        runner,
        dependencies.temporaryDirectory,
        dependencies.removePreflightDirectory,
        dependencies.codexCapturedExecutableIdentityForTesting,
        windowsProcessTreeTermination,
      )
    : null;
  const providerPayload = {
    schemaVersion: FLUX_PROVIDER_ADAPTER_PROFILE_SCHEMA_VERSION,
    adapterBaseVersion: adapterBaseVersion(profile.provider),
    profileContentIdentity,
    provider: profile.provider,
    model: profile.model,
    requestedTier: profile.tier,
    canonicalTier: canonicalTier(profile),
    deadlineMs: profile.deadlineMs,
    providerTurnTimeoutMs,
    cliShutdownReserveMs: profile.provider === "codex" || profile.provider === "claude-cli"
      ? CLI_PROVIDER_SHUTDOWN_RESERVE_MS
      : 0,
    cliShutdownWorstCaseMs: profile.provider === "codex" || profile.provider === "claude-cli"
      ? CLI_PROVIDER_SHUTDOWN_WORST_CASE_MS
      : 0,
    maxOutputTokens: FLUX_PRODUCTION_LIMITS.maxOutputTokens,
    executableIdentity: executable?.identity ?? null,
    codexLocalReadAcknowledged: profile.allowCodexLocalRead === true,
    codexConfigurationPreflightEvidenceIdentity: executable?.codexConfigurationPreflight?.evidenceIdentity ?? null,
    codexCapabilityProfileIdentity: executable?.codexConfigurationPreflight?.capabilityProfileIdentity ?? null,
    windowsProcessTreeTerminationAuthorityIdentity:
      profile.provider === "codex" || profile.provider === "claude-cli"
        ? windowsProcessTreeTerminationAuthorityIdentity
        : null,
  };
  const adapterProfileIdentity = canonicalIdentity(
    providerPayload,
    FLUX_PROVIDER_ADAPTER_PROFILE_SCHEMA_VERSION,
  );
  const adapterSchemaVersion = `${adapterBaseVersion(profile.provider)}.${adapterProfileIdentity.digest}`;
  const runtimeEnvironment: NodeJS.ProcessEnv = { ...environment };
  if (profile.provider === "codex") {
    runtimeEnvironment.EVLEDA_CODEX_CLI = executable!.path;
    runtimeEnvironment[CLI_PROVIDER_EXECUTABLE_PIN_ENVIRONMENT.codex.sha256] = executable!.contentIdentity.digest;
    runtimeEnvironment[CLI_PROVIDER_EXECUTABLE_PIN_ENVIRONMENT.codex.sizeBytes] = String(executable!.contentIdentity.size);
  }
  if (profile.provider === "claude-cli") {
    runtimeEnvironment.EVLEDA_CLAUDE_CLI = executable!.path;
    runtimeEnvironment[CLI_PROVIDER_EXECUTABLE_PIN_ENVIRONMENT["claude-cli"].sha256] = executable!.contentIdentity.digest;
    runtimeEnvironment[CLI_PROVIDER_EXECUTABLE_PIN_ENVIRONMENT["claude-cli"].sizeBytes] = String(executable!.contentIdentity.size);
  }
  let adapter: PcbIntentProvider;
  switch (profile.provider) {
    case "openai":
      adapter = new OpenAIHarnessProvider({
        model: profile.model,
        apiKey: configuredSecret(environment, "OPENAI_API_KEY"),
        serviceTier: profile.tier as "standard" | "fast",
        timeoutMs: providerTurnTimeoutMs,
        maxOutputTokens: FLUX_PRODUCTION_LIMITS.maxOutputTokens,
        maxOutputBytes: PCB_DESIGN_INTERPRETER_LIMITS.maxProviderOutputBytes,
        ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
      });
      break;
    case "anthropic":
      adapter = new AnthropicHarnessProvider({
        model: profile.model,
        apiKey: configuredSecret(environment, "ANTHROPIC_API_KEY"),
        timeoutMs: providerTurnTimeoutMs,
        maxTokens: FLUX_PRODUCTION_LIMITS.maxOutputTokens,
        maxOutputBytes: PCB_DESIGN_INTERPRETER_LIMITS.maxProviderOutputBytes,
        ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
      });
      break;
    case "codex":
      adapter = new CodexCliHarnessProvider({
        model: profile.model,
        executablePath: executable!.path,
        timeoutMs: providerTurnTimeoutMs,
        maxOutputBytes: PCB_DESIGN_INTERPRETER_LIMITS.maxProviderOutputBytes,
        environment: runtimeEnvironment,
        expectedExecutableIdentity: executable!.contentIdentity,
        windowsProcessTreeTermination,
        ...(dependencies.cliSpawn === undefined ? {} : { spawn: dependencies.cliSpawn }),
        ...(dependencies.temporaryDirectory === undefined ? {} : { temporaryDirectory: dependencies.temporaryDirectory }),
      });
      break;
    case "claude-cli":
      adapter = new ClaudeCliHarnessProvider({
        model: profile.model,
        executablePath: executable!.path,
        timeoutMs: providerTurnTimeoutMs,
        maxOutputBytes: PCB_DESIGN_INTERPRETER_LIMITS.maxProviderOutputBytes,
        environment: runtimeEnvironment,
        expectedExecutableIdentity: executable!.contentIdentity,
        windowsProcessTreeTermination,
        ...(dependencies.cliSpawn === undefined ? {} : { spawn: dependencies.cliSpawn }),
        ...(dependencies.temporaryDirectory === undefined ? {} : { temporaryDirectory: dependencies.temporaryDirectory }),
      });
      break;
  }
  return Object.freeze({
    adapter: Object.freeze(adapter),
    adapterSchemaVersion,
    executable,
    runtimeEnvironment: Object.freeze(runtimeEnvironment),
  });
};

/** Safe setup projection for an intentionally disabled local Flux runtime. */
export const createFluxSetupRequiredReadiness = (
  reasons: readonly FluxReadinessReasonCode[] = ["FLUX_DISABLED"],
  diagnostic: FluxReadinessDto["diagnostic"] = null,
): FluxReadinessDto => {
  const reasonCodes = [...new Set(reasons)].sort(compareText);
  if (
    reasonCodes.length < 1
    || reasonCodes.length > 16
    || reasonCodes.some((reason) => !READINESS_REASON_CODES.has(reason))
  ) throw new Error("Flux readiness reason codes are invalid.");
  const parsedDiagnostic = diagnostic === null ? null : parseFluxDiagnostic(diagnostic);
  return deepFreeze({
    schemaVersion: FLUX_READINESS_SCHEMA_VERSION,
    configured: false,
    status: "setup_required",
    reasonCodes,
    provider: null,
    compiler: null,
    toolchain: null,
    kicadMcpRuntime: null,
    diagnostic: parsedDiagnostic,
  });
};

/**
 * Read and authenticate every production authority before any application or
 * Flux state store is initialized. The returned closures retain private paths
 * and credentials; the readiness DTO is the only HTTP-safe projection.
 */
export const loadFluxProductionComposition = async (
  environment: NodeJS.ProcessEnv,
  dependencies: FluxProductionCompositionDependencies = {},
): Promise<FluxProductionComposition> => {
  const roots = await requiredRootPair(environment);
  const requestedProfile = profilePinFromEnvironment(environment);
  const profileFile = await readPinnedFile(
    requestedProfile.path,
    requestedProfile.identity,
    FLUX_PRODUCTION_LIMITS.profileBytes,
    "COMPILER_PROFILE_INVALID",
  );
  const profileValue = protectSync("COMPILER_PROFILE_INVALID", () => parsePortableJsonBytes(
    profileFile.bytes,
    {
      maxBytes: FLUX_PRODUCTION_LIMITS.profileBytes,
      maxDepth: 12,
      maxNodes: 8_192,
      maxArrayLength: KICAD_STOCK_LIBRARY_RESOLVER_LIMITS.maxStockNicknames,
      maxOwnKeys: 64,
      maxKeyBytes: 128,
      maxStringBytes: FLUX_PRODUCTION_LIMITS.pathBytes,
    },
  ));
  const profile = parseProductionProfile(profileValue);
  const configuredExecutablePath = profile.provider.executable?.path;
  if (configuredExecutablePath !== undefined && (
    overlaps(roots.workspaceRoot, configuredExecutablePath)
    || overlaps(configuredExecutablePath, roots.workspaceRoot)
    || overlaps(roots.sourceRoot, configuredExecutablePath)
    || overlaps(configuredExecutablePath, roots.sourceRoot)
  )) return fail("PROVIDER_EXECUTABLE_UNAVAILABLE");
  if (profile.provider.provider === "codex") {
    const capturedToolProfile = requireCodexCapturedToolProfile(profile.provider.model);
    const captured = dependencies.codexCapturedExecutableIdentityForTesting
      ?? CODEX_CLI_CAPTURED_EXECUTABLE_IDENTITY;
    const executable = profile.provider.executable!;
    await readPinnedFile(
      executable.path,
      executable.identity,
      FLUX_PRODUCTION_LIMITS.executableBytes,
      "PROVIDER_EXECUTABLE_UNAVAILABLE",
    );
    if (executable.version !== CODEX_CLI_PINNED_VERSION
      || executable.identity.size !== captured.size
      || !constantTimeDigestEqual(executable.identity.digest, captured.digest)) {
      const executableIdentity = canonicalIdentity({
        schemaVersion: FLUX_PROVIDER_EXECUTABLE_IDENTITY_SCHEMA_VERSION,
        provider: profile.provider.provider,
        contentIdentity: executable.identity,
        version: executable.version,
      }, FLUX_PROVIDER_EXECUTABLE_IDENTITY_SCHEMA_VERSION);
      return fail("CODEX_CONFIG_INCOMPATIBLE", codexPreflightEvidence(
        executableIdentity,
        codexCapabilityProfile(capturedToolProfile, captured).identity,
        "incompatible",
        "unavailable",
        "unavailable",
        "unavailable",
      ));
    }
  }

  const kicadBinRoot = await bindOrdinaryDirectory(
    profile.kicadToolchain.binRoot,
    "KICAD_TOOLCHAIN_UNAVAILABLE",
  );
  const symbolRoot = await bindOrdinaryDirectory(profile.libraries.symbolRoot, "KICAD_LIBRARY_UNAVAILABLE");
  const footprintRoot = await bindOrdinaryDirectory(profile.libraries.footprintRoot, "KICAD_LIBRARY_UNAVAILABLE");
  const resourceRoot = await bindOrdinaryDirectory(
    profile.deepRules.resourceRoot,
    "RULE_CATALOG_UNAVAILABLE",
  );
  const kicadMcpRuntimeLock = await readPinnedFile(
    profile.kicadMcpRuntime.lock.path,
    profile.kicadMcpRuntime.lock.identity,
    FLUX_PRODUCTION_LIMITS.kicadMcpRuntimeLockBytes,
    "KICAD_MCP_RUNTIME_UNAVAILABLE",
  );
  const inspectionBundleRoot = await bindOrdinaryDirectory(
    profile.kicadMcpRuntime.runtimeBundle.root,
    "KICAD_MCP_RUNTIME_UNAVAILABLE",
  );
  const inspectionRuntimeParentRoot = await bindOrdinaryDirectory(
    profile.kicadMcpRuntime.runtimeParentRoot,
    "KICAD_MCP_RUNTIME_UNAVAILABLE",
  );
  const inspectionIpcSocketParentRoot = await bindOrdinaryDirectory(
    profile.kicadMcpRuntime.ipcSocketParentRoot,
    "KICAD_MCP_RUNTIME_UNAVAILABLE",
  );
  const inspectionManifest = await readPinnedFile(
    profile.kicadMcpRuntime.runtimeBundle.manifest.path,
    profile.kicadMcpRuntime.runtimeBundle.manifest.identity,
    FLUX_PRODUCTION_LIMITS.kicadMcpRuntimeManifestBytes,
    "KICAD_MCP_RUNTIME_UNAVAILABLE",
  );
  const inspectionManifestValue = protectSync("KICAD_MCP_RUNTIME_UNAVAILABLE", () =>
    parsePortableJsonBytes(inspectionManifest.bytes, {
      maxBytes: FLUX_PRODUCTION_LIMITS.kicadMcpRuntimeManifestBytes,
      maxDepth: 32,
      maxNodes: 250_000,
      maxArrayLength: FLUX_PRODUCTION_LIMITS.kicadMcpRuntimeFileCount,
      maxOwnKeys: 512,
      maxKeyBytes: 256,
      maxStringBytes: 128 * 1024,
    }));
  if (inspectionManifestValue === null
    || typeof inspectionManifestValue !== "object"
    || Array.isArray(inspectionManifestValue)
    || (inspectionManifestValue as Readonly<Record<string, unknown>>).totalBytes
      !== profile.kicadMcpRuntime.runtimeBundle.expectedClosure.totalBytes) {
    return fail("KICAD_MCP_RUNTIME_UNAVAILABLE");
  }
  const inspectionPython = await readPinnedFile(
    path.resolve(
      inspectionBundleRoot,
      ...profile.kicadMcpRuntime.runtimeBundle.expectedClosure.python.relativePath.split("/"),
    ),
    profile.kicadMcpRuntime.runtimeBundle.expectedClosure.python.identity,
    FLUX_PRODUCTION_LIMITS.executableBytes,
    "KICAD_MCP_RUNTIME_UNAVAILABLE",
  );
  const inspectionEntrypoint = await readPinnedFile(
    path.resolve(
      inspectionBundleRoot,
      ...profile.kicadMcpRuntime.runtimeBundle.expectedClosure.entrypoint.relativePath.split("/"),
    ),
    profile.kicadMcpRuntime.runtimeBundle.expectedClosure.entrypoint.identity,
    FLUX_PRODUCTION_LIMITS.kicadMcpRuntimeManifestBytes,
    "KICAD_MCP_RUNTIME_UNAVAILABLE",
  );
  const inspectionTerminator = await readPinnedFile(
    profile.kicadMcpRuntime.processTreeSupervision.terminator.path,
    profile.kicadMcpRuntime.processTreeSupervision.terminator.identity,
    FLUX_PRODUCTION_LIMITS.executableBytes,
    "KICAD_MCP_RUNTIME_UNAVAILABLE",
  );
  const bridgeEnvironment = kicadMcpRuntimeEnvironment(environment);
  const systemRoot = bridgeEnvironment.SYSTEMROOT;
  const windowsDirectory = bridgeEnvironment.WINDIR;
  if (systemRoot === undefined || windowsDirectory === undefined
    || !samePath(systemRoot, windowsDirectory)) {
    return fail("KICAD_MCP_RUNTIME_UNAVAILABLE");
  }
  const windowsProcessTreeTermination: BoundedWindowsProcessTreeTermination = deepFreeze({
    schemaVersion: BOUNDED_WINDOWS_PROCESS_TREE_TERMINATION_SCHEMA_VERSION,
    executablePath: inspectionTerminator.path,
    executableIdentity: inspectionTerminator.identity,
    cwd: inspectionBundleRoot,
    env: {
      SYSTEMROOT: systemRoot,
      WINDIR: windowsDirectory,
    },
  });
  const windowsProcessTreeTerminationAuthorityIdentity = canonicalIdentity({
    schemaVersion: BOUNDED_WINDOWS_PROCESS_TREE_TERMINATION_SCHEMA_VERSION,
    executablePath: inspectionTerminator.path,
    executableIdentity: inspectionTerminator.identity,
    workingDirectory: inspectionBundleRoot,
    environment: windowsProcessTreeTermination.env,
    invocation: Object.freeze(["/PID", "<live-root-pid>", "/T", "/F"]),
    shell: false,
    inheritedEnvironment: false,
  }, BOUNDED_WINDOWS_PROCESS_TREE_TERMINATION_SCHEMA_VERSION);
  const runtimeProcessRunner: BoundedProcessRunner = async (options) => await (
    dependencies.processRunner ?? runBoundedProcess
  )({
    ...options,
    windowsProcessTreeTermination,
  });
  if (overlaps(inspectionBundleRoot, inspectionManifest.path)
    || overlaps(inspectionManifest.path, inspectionBundleRoot)
    || !overlaps(inspectionBundleRoot, inspectionPython.path)
    || !overlaps(inspectionBundleRoot, inspectionEntrypoint.path)
    || !overlaps(inspectionBundleRoot, inspectionTerminator.path)) {
    return fail("KICAD_MCP_RUNTIME_UNAVAILABLE");
  }
  if (
    overlaps(roots.workspaceRoot, kicadMcpRuntimeLock.path)
    || overlaps(kicadMcpRuntimeLock.path, roots.workspaceRoot)
    || overlaps(roots.sourceRoot, kicadMcpRuntimeLock.path)
    || overlaps(kicadMcpRuntimeLock.path, roots.sourceRoot)
    || overlaps(profileFile.path, kicadMcpRuntimeLock.path)
    || overlaps(kicadMcpRuntimeLock.path, profileFile.path)
    || overlaps(kicadBinRoot, kicadMcpRuntimeLock.path)
    || overlaps(kicadMcpRuntimeLock.path, kicadBinRoot)
    || overlaps(roots.workspaceRoot, inspectionManifest.path)
    || overlaps(inspectionManifest.path, roots.workspaceRoot)
    || overlaps(roots.sourceRoot, inspectionManifest.path)
    || overlaps(inspectionManifest.path, roots.sourceRoot)
    || overlaps(kicadBinRoot, inspectionManifest.path)
    || overlaps(inspectionManifest.path, kicadBinRoot)
    || overlaps(profileFile.path, inspectionManifest.path)
    || overlaps(inspectionManifest.path, profileFile.path)
    || overlaps(roots.workspaceRoot, inspectionBundleRoot)
    || overlaps(inspectionBundleRoot, roots.workspaceRoot)
    || overlaps(roots.sourceRoot, inspectionBundleRoot)
    || overlaps(inspectionBundleRoot, roots.sourceRoot)
    || overlaps(kicadBinRoot, inspectionBundleRoot)
    || overlaps(inspectionBundleRoot, kicadBinRoot)
    || overlaps(symbolRoot, inspectionBundleRoot)
    || overlaps(inspectionBundleRoot, symbolRoot)
    || overlaps(footprintRoot, inspectionBundleRoot)
    || overlaps(inspectionBundleRoot, footprintRoot)
    || overlaps(resourceRoot, inspectionBundleRoot)
    || overlaps(inspectionBundleRoot, resourceRoot)
    || overlaps(inspectionRuntimeParentRoot, roots.workspaceRoot)
    || overlaps(roots.workspaceRoot, inspectionRuntimeParentRoot)
    || overlaps(inspectionRuntimeParentRoot, roots.sourceRoot)
    || overlaps(roots.sourceRoot, inspectionRuntimeParentRoot)
    || overlaps(inspectionRuntimeParentRoot, kicadBinRoot)
    || overlaps(kicadBinRoot, inspectionRuntimeParentRoot)
    || overlaps(inspectionRuntimeParentRoot, inspectionBundleRoot)
    || overlaps(inspectionBundleRoot, inspectionRuntimeParentRoot)
    || overlaps(inspectionRuntimeParentRoot, kicadMcpRuntimeLock.path)
    || overlaps(kicadMcpRuntimeLock.path, inspectionRuntimeParentRoot)
    || overlaps(inspectionRuntimeParentRoot, inspectionManifest.path)
    || overlaps(inspectionManifest.path, inspectionRuntimeParentRoot)
    || overlaps(inspectionRuntimeParentRoot, symbolRoot)
    || overlaps(symbolRoot, inspectionRuntimeParentRoot)
    || overlaps(inspectionRuntimeParentRoot, footprintRoot)
    || overlaps(footprintRoot, inspectionRuntimeParentRoot)
    || overlaps(inspectionRuntimeParentRoot, resourceRoot)
    || overlaps(resourceRoot, inspectionRuntimeParentRoot)
    || overlaps(inspectionIpcSocketParentRoot, roots.workspaceRoot)
    || overlaps(roots.workspaceRoot, inspectionIpcSocketParentRoot)
    || overlaps(inspectionIpcSocketParentRoot, roots.sourceRoot)
    || overlaps(roots.sourceRoot, inspectionIpcSocketParentRoot)
    || overlaps(inspectionIpcSocketParentRoot, kicadBinRoot)
    || overlaps(kicadBinRoot, inspectionIpcSocketParentRoot)
    || overlaps(inspectionIpcSocketParentRoot, inspectionBundleRoot)
    || overlaps(inspectionBundleRoot, inspectionIpcSocketParentRoot)
    || overlaps(inspectionIpcSocketParentRoot, inspectionRuntimeParentRoot)
    || overlaps(inspectionRuntimeParentRoot, inspectionIpcSocketParentRoot)
    || overlaps(inspectionIpcSocketParentRoot, kicadMcpRuntimeLock.path)
    || overlaps(kicadMcpRuntimeLock.path, inspectionIpcSocketParentRoot)
    || overlaps(inspectionIpcSocketParentRoot, inspectionManifest.path)
    || overlaps(inspectionManifest.path, inspectionIpcSocketParentRoot)
    || overlaps(inspectionIpcSocketParentRoot, symbolRoot)
    || overlaps(symbolRoot, inspectionIpcSocketParentRoot)
    || overlaps(inspectionIpcSocketParentRoot, footprintRoot)
    || overlaps(footprintRoot, inspectionIpcSocketParentRoot)
    || overlaps(inspectionIpcSocketParentRoot, resourceRoot)
    || overlaps(resourceRoot, inspectionIpcSocketParentRoot)
    || overlaps(roots.workspaceRoot, inspectionTerminator.path)
    || overlaps(inspectionTerminator.path, roots.workspaceRoot)
    || overlaps(roots.sourceRoot, inspectionTerminator.path)
    || overlaps(inspectionTerminator.path, roots.sourceRoot)
  ) return fail("KICAD_MCP_RUNTIME_UNAVAILABLE");
  if (
    overlaps(roots.workspaceRoot, kicadBinRoot)
    || overlaps(kicadBinRoot, roots.workspaceRoot)
    || overlaps(roots.sourceRoot, kicadBinRoot)
    || overlaps(kicadBinRoot, roots.sourceRoot)
    || overlaps(roots.workspaceRoot, profile.kicadToolchain.kicadCli.path)
    || overlaps(profile.kicadToolchain.kicadCli.path, roots.workspaceRoot)
    || overlaps(roots.sourceRoot, profile.kicadToolchain.kicadCli.path)
    || overlaps(profile.kicadToolchain.kicadCli.path, roots.sourceRoot)
    || overlaps(roots.workspaceRoot, profile.kicadToolchain.pcbnew.path)
    || overlaps(profile.kicadToolchain.pcbnew.path, roots.workspaceRoot)
    || overlaps(roots.sourceRoot, profile.kicadToolchain.pcbnew.path)
    || overlaps(profile.kicadToolchain.pcbnew.path, roots.sourceRoot)
    || overlaps(kicadBinRoot, profileFile.path)
    || overlaps(profileFile.path, kicadBinRoot)
  ) return fail("KICAD_TOOLCHAIN_UNAVAILABLE");
  if (
    overlaps(roots.workspaceRoot, symbolRoot)
    || overlaps(symbolRoot, roots.workspaceRoot)
    || overlaps(roots.workspaceRoot, footprintRoot)
    || overlaps(footprintRoot, roots.workspaceRoot)
    || overlaps(roots.workspaceRoot, profileFile.path)
    || overlaps(roots.workspaceRoot, resourceRoot)
    || overlaps(resourceRoot, roots.workspaceRoot)
  ) return fail("KICAD_LIBRARY_UNAVAILABLE");

  const kicadToolchain = await bindKicadToolchain(
    profile.kicadToolchain,
    kicadBinRoot,
    environment,
    dependencies,
    windowsProcessTreeTermination,
  );
  const kicadMcpRuntime = await protect(
    "KICAD_MCP_RUNTIME_UNAVAILABLE",
    async () => await (dependencies.createKicadMcpRuntime ?? createKicadMcpRuntimeFactory)({
      lockFile: {
        path: kicadMcpRuntimeLock.path,
        contentIdentity: kicadMcpRuntimeLock.identity,
      },
      runtimeBundle: {
        root: inspectionBundleRoot,
        manifestFile: {
          path: inspectionManifest.path,
          contentIdentity: inspectionManifest.identity,
        },
        expectedClosure: {
          fileCount: profile.kicadMcpRuntime.runtimeBundle.expectedClosure.fileCount,
          manifestIdentity: profile.kicadMcpRuntime.runtimeBundle.expectedClosure.manifestIdentity,
          treeIdentity: profile.kicadMcpRuntime.runtimeBundle.expectedClosure.treeIdentity,
          python: {
            relativePath: profile.kicadMcpRuntime.runtimeBundle.expectedClosure.python.relativePath,
            contentIdentity: inspectionPython.identity,
          },
          entrypoint: {
            relativePath: profile.kicadMcpRuntime.runtimeBundle.expectedClosure.entrypoint.relativePath,
            contentIdentity: inspectionEntrypoint.identity,
          },
          protocol: profile.kicadMcpRuntime.runtimeBundle.expectedClosure.protocol,
        },
      },
      runtimeParentRoot: inspectionRuntimeParentRoot,
      ipcSocketParentRoot: inspectionIpcSocketParentRoot,
      verificationTimeoutMs: KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS,
      ...(profile.kicadMcpRuntime.runtimePolicy.connectionDeadlinePolicy === undefined ? {}
        : { connectionDeadlinePolicy: profile.kicadMcpRuntime.runtimePolicy.connectionDeadlinePolicy }),
      processTreeSupervision: {
        strategy: KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY,
        terminator: {
          path: inspectionTerminator.path,
          contentIdentity: inspectionTerminator.identity,
        },
        timeoutMs: KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
      },
      kicadCli: {
        path: kicadToolchain.kicadCli.path,
        contentIdentity: kicadToolchain.kicadCli.contentIdentity,
      },
      environment: bridgeEnvironment,
      protectedRoots: [...new Set([
        roots.sourceRoot,
        roots.workspaceRoot,
        path.dirname(profileFile.path),
        kicadBinRoot,
        inspectionBundleRoot,
        path.dirname(kicadMcpRuntimeLock.path),
        symbolRoot,
        footprintRoot,
        resourceRoot,
      ])].sort(compareText),
    }),
  );
  await protect("KICAD_MCP_RUNTIME_UNAVAILABLE", async () => await kicadMcpRuntime.assertCurrent());
  const kicadMcpRuntimeIdentity = protectSync(
    "KICAD_MCP_RUNTIME_UNAVAILABLE",
    () => validateCanonicalIdentity(kicadMcpRuntime.identity, "Flux KiCad MCP runtime identity"),
  );
  const inspectionBridgeIdentity = protectSync(
    "KICAD_MCP_RUNTIME_UNAVAILABLE",
    () => validateCanonicalIdentity(kicadMcpRuntime.inspectionBridgeIdentity, "Flux inspection bridge identity"),
  );
  const executionBridgeIdentity = protectSync(
    "KICAD_MCP_RUNTIME_UNAVAILABLE",
    () => validateCanonicalIdentity(kicadMcpRuntime.executionBridgeIdentity, "Flux execution bridge identity"),
  );
  if (kicadMcpRuntimeIdentity.schemaVersion !== KICAD_MCP_RUNTIME_IDENTITY_SCHEMA_VERSION
    || inspectionBridgeIdentity.schemaVersion !== KICAD_MCP_INSPECTION_BRIDGE_SCHEMA_VERSION
    || executionBridgeIdentity.schemaVersion !== KICAD_MCP_EXECUTION_BRIDGE_SCHEMA_VERSION) {
    return fail("KICAD_MCP_RUNTIME_UNAVAILABLE");
  }

  const catalog = protectSync("RULE_CATALOG_UNAVAILABLE", () => deepFreeze(loadDeepRuleResource(
    createDeepRuleResourceProfile(resourceRoot, profile.deepRules.resourceIdentity),
  ).catalog));
  const catalogIdentity = canonicalIdentity(catalog, "evleda.deep-rule-catalog.v1");
  if (canonicalJson(profile.deepRules.catalogIdentity) !== canonicalJson(catalogIdentity)) {
    return fail("RULE_CATALOG_UNAVAILABLE");
  }

  const libraryResolver = protectSync("KICAD_LIBRARY_UNAVAILABLE", () =>
    createKiCad10StockLibraryResolver({
      symbolRoot,
      footprintRoot,
      exactSymbolIds: profile.libraries.exactSymbolIds,
      exactFootprintIds: profile.libraries.exactFootprintIds,
      stockSymbolNicknames: profile.libraries.stockSymbolNicknames,
      stockFootprintNicknames: profile.libraries.stockFootprintNicknames,
    }));
  for (const id of profile.libraries.exactSymbolIds) {
    if (protectSync("KICAD_LIBRARY_UNAVAILABLE", () => libraryResolver.resolveSymbol(id)) === null) {
      return fail("KICAD_LIBRARY_UNAVAILABLE");
    }
  }
  for (const id of profile.libraries.exactFootprintIds) {
    if (protectSync("KICAD_LIBRARY_UNAVAILABLE", () => libraryResolver.resolveFootprint(id)) === null) {
      return fail("KICAD_LIBRARY_UNAVAILABLE");
    }
  }

  const adapterBinding = await adapterAndExecutable(
    profile.provider,
    profileFile.identity,
    environment,
    dependencies,
    windowsProcessTreeTermination,
    windowsProcessTreeTerminationAuthorityIdentity,
  );
  const runtimeEnvironment = Object.freeze({
    ...adapterBinding.runtimeEnvironment,
    EVLEDA_KICAD_CLI: kicadToolchain.kicadCli.path,
    EVLEDA_PCBNEW: kicadToolchain.pcbnew.path,
  });
  const providerProfile = createPcbProviderProfileBinding({
    provider: profile.provider.provider,
    model: profile.provider.model,
    tier: canonicalTier(profile.provider),
    adapterSchemaVersion: adapterBinding.adapterSchemaVersion,
  });
  const compilerOptions: PcbDesignCompilerOptions = deepFreeze({
    libraryResolver,
    deepRuleCatalog: catalog,
    deepRuleSelectionOptions: { ...profile.deepRules.selection },
  });
  const compilationBundleDependencies: PcbDesignCompilationBundleDependencies = Object.freeze({
    libraryResolver,
    deepRuleCatalog: catalog,
  });
  const compilerProfilePayload = {
    schemaVersion: FLUX_PRODUCTION_COMPILER_PROFILE_SCHEMA_VERSION,
    productionProfileContentIdentity: profileFile.identity,
    kicadToolchainIdentity: kicadToolchain.identity,
    kicadMcpRuntimeIdentity,
    inspectionBridgeIdentity,
    executionBridgeIdentity,
    windowsProcessTreeTerminationAuthorityIdentity,
    kicadMajorVersion: profile.libraries.kicadMajorVersion,
    symbolRoot,
    footprintRoot,
    exactSymbolIds: profile.libraries.exactSymbolIds,
    exactFootprintIds: profile.libraries.exactFootprintIds,
    stockSymbolNicknames: profile.libraries.stockSymbolNicknames,
    stockFootprintNicknames: profile.libraries.stockFootprintNicknames,
    deepRuleResourceRoot: resourceRoot,
    deepRuleResourceIdentity: profile.deepRules.resourceIdentity,
    deepRuleCatalogIdentity: catalogIdentity,
    deepRuleSelection: profile.deepRules.selection,
  };
  const compilerProfileIdentity = Object.freeze(canonicalIdentity(
    compilerProfilePayload,
    FLUX_PRODUCTION_COMPILER_PROFILE_SCHEMA_VERSION,
  ));
  const contractInterpreter = createPcbDesignInterpreterPort(
    { provider: adapterBinding.adapter, compilerOptions },
    providerProfile,
    {
      timeoutMs: FLUX_PRODUCTION_LIMITS.deadlineMs,
      maxProviderOutputBytes: PCB_DESIGN_INTERPRETER_LIMITS.maxProviderOutputBytes,
    },
  );
  const compilationBundleStore = new FileFluxCompilationBundleStore(
    roots.workspaceRoot,
    compilationBundleDependencies,
  );
  const runtimeDependencies: FluxRuntimeDependencies = Object.freeze({
    contractInterpreter,
    providerProfile,
    compilationBundleStore,
    compilationBundleDependencies,
    providerModel: Object.freeze({
      provider: providerProfile.provider,
      model: providerProfile.model,
      tier: providerProfile.tier,
    }),
    kicadToolchain,
    kicadMcpRuntime,
    runKicadCliIdentityProbe: runtimeProcessRunner,
  });
  const readiness: FluxReadinessDto = deepFreeze({
    schemaVersion: FLUX_READINESS_SCHEMA_VERSION,
    configured: true,
    status: "ready",
    reasonCodes: [],
    provider: {
      provider: profile.provider.provider,
      model: profile.provider.model,
      requestedTier: profile.provider.tier,
      canonicalTier: canonicalTier(profile.provider),
      adapterSchemaVersion: adapterBinding.adapterSchemaVersion,
      providerProfileIdentity: { ...providerProfile.identity },
      localReadCapability: profile.provider.provider === "codex" ? "read_only_host_files" : "none",
      configurationPreflight: profile.provider.provider === "codex"
        ? {
            status: "passed",
            evidenceIdentity: { ...adapterBinding.executable!.codexConfigurationPreflight!.evidenceIdentity },
            capabilityProfileIdentity: { ...adapterBinding.executable!.codexConfigurationPreflight!.capabilityProfileIdentity },
            imageInspectionPolicy: CODEX_CLI_IMAGE_INSPECTION_POLICY,
          }
        : null,
    },
    compiler: {
      profileIdentity: { ...compilerProfileIdentity },
      catalogIdentity: { ...catalogIdentity },
      exactSymbolCount: profile.libraries.exactSymbolIds.length,
      exactFootprintCount: profile.libraries.exactFootprintIds.length,
      symbolNicknameCount: profile.libraries.stockSymbolNicknames.length,
      footprintNicknameCount: profile.libraries.stockFootprintNicknames.length,
    },
    toolchain: {
      identity: { ...kicadToolchain.identity },
      kicadCli: {
        identity: { ...kicadToolchain.kicadCli.identity },
        operationalVersion: kicadToolchain.kicadCli.operationalVersion,
        operationalCommit: kicadToolchain.kicadCli.operationalCommit,
        peFileVersion: kicadToolchain.kicadCli.peFileVersion,
        peProductVersion: kicadToolchain.kicadCli.peProductVersion,
      },
      pcbnew: {
        identity: { ...kicadToolchain.pcbnew.identity },
        peFileVersion: kicadToolchain.pcbnew.peFileVersion,
        peProductVersion: kicadToolchain.pcbnew.peProductVersion,
      },
    },
    kicadMcpRuntime: {
      identity: { ...kicadMcpRuntimeIdentity },
      inspectionBridgeIdentity: { ...inspectionBridgeIdentity },
      executionBridgeIdentity: { ...executionBridgeIdentity },
      connectionPolicy: { ...FLUX_KICAD_MCP_RUNTIME_CONNECTION_POLICY },
    },
    diagnostic: null,
  });
  const createRuntimeForComposition = async (): Promise<FluxRuntime> => {
    await protect("KICAD_MCP_RUNTIME_UNAVAILABLE", async () => await kicadMcpRuntime.assertCurrent());
    return await createFluxRuntime(runtimeEnvironment, runtimeDependencies);
  };
  return Object.freeze({
    readiness,
    providerProfile,
    compilerProfileIdentity,
    kicadToolchain,
    kicadMcpRuntime,
    contractInterpreter,
    compilationBundleStore,
    compilationBundleDependencies,
    createRuntime: createRuntimeForComposition,
  });
};
