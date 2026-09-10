import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { access, lstat, mkdtemp, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { canonicalIdentity, canonicalJson, constantTimeDigestEqual } from "../core/canonical.js";
import { parsePortableJsonBytes } from "../core/portable-artifact.js";
import {
  PROVIDER_FAILURE_LEAVES,
  PROVIDER_FAILURE_ADAPTER_IDENTITY_SCHEMA_VERSION,
  PROVIDER_FAILURE_CHECKPOINT_KEYS,
  PROVIDER_FAILURE_EVIDENCE_MAX_ISSUES,
  PROVIDER_FAILURE_ISSUE_CODES,
  PROVIDER_FAILURE_ISSUE_PATHS,
  PROVIDER_FAILURE_OBSERVED_TYPES,
  PROVIDER_FAILURE_PARSER_IDENTITY_SCHEMA_VERSION,
  createFluxDiagnostic,
  createProviderFailureDiagnostic,
  createProviderFailureEvidence,
  type FluxDiagnosticCode,
  type ProviderFailureEvidenceV1,
  type ProviderFailureIssueV1,
  type ProviderFailureLeaf,
} from "../domain/diagnostics.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import {
  HARNESS_DEFAULT_LIMITS,
  HARNESS_SCHEMA_VERSION,
  createHarnessProviderTurnJsonSchema,
  harnessProviderMessageSchema,
  harnessProviderTurnSchema,
  harnessToolCallSchema,
  type HarnessProvider,
  type HarnessProviderRequest,
  type HarnessProviderTurnContext,
  type HarnessProviderTurn,
} from "./contracts.js";
import { HarnessProviderError } from "./providers.js";
import {
  runBoundedWindowsProcessTreeTermination,
  type BoundedWindowsProcessTreeTermination,
} from "../integrations/bounded-process.js";

export const DEFAULT_CLI_PROVIDER_TIMEOUT_MS = 90_000;
export const MAXIMUM_CLI_PROVIDER_TIMEOUT_MS = 300_000;
/** Reserved inside production's 270-second interpreter ceiling for kill + cleanup. */
export const CLI_PROVIDER_SHUTDOWN_RESERVE_MS = 8_000;
export const CLI_PROVIDER_TERM_GRACE_MS = 250;
export const CLI_PROVIDER_TREE_KILL_TIMEOUT_MS = 2_000;
export const CLI_PROVIDER_CLEANUP_TIMEOUT_MS = 2_000;
export const CLI_PROVIDER_SHUTDOWN_WORST_CASE_MS =
  CLI_PROVIDER_TERM_GRACE_MS
  + CLI_PROVIDER_TREE_KILL_TIMEOUT_MS
  + CLI_PROVIDER_TREE_KILL_TIMEOUT_MS
  + CLI_PROVIDER_CLEANUP_TIMEOUT_MS;
if (CLI_PROVIDER_SHUTDOWN_RESERVE_MS <= CLI_PROVIDER_SHUTDOWN_WORST_CASE_MS) {
  throw new Error("CLI provider shutdown reserve must exceed the bounded worst-case teardown path");
}
export const DEFAULT_CLI_PROVIDER_OUTPUT_BYTES = HARNESS_DEFAULT_LIMITS.maxPayloadBytes;
export const MAXIMUM_CLI_PROVIDER_OUTPUT_BYTES = 1024 * 1024;
export const CODEX_CLI_HARNESS_PROVIDER_ADAPTER_SCHEMA_VERSION =
  "evleda.codex-cli-harness-provider.v10" as const;
export const CLAUDE_CLI_HARNESS_PROVIDER_ADAPTER_SCHEMA_VERSION =
  "evleda.claude-cli-harness-provider.v7" as const;

export const CLI_PROVIDER_EXECUTABLE_PIN_ENVIRONMENT = Object.freeze({
  codex: Object.freeze({
    sha256: "EVLEDA_CODEX_CLI_SHA256",
    sizeBytes: "EVLEDA_CODEX_CLI_SIZE_BYTES",
  }),
  "claude-cli": Object.freeze({
    sha256: "EVLEDA_CLAUDE_CLI_SHA256",
    sizeBytes: "EVLEDA_CLAUDE_CLI_SIZE_BYTES",
  }),
} as const);

/**
 * Exact config/permission closure shared by startup compatibility preflight
 * and every model turn. These pinned-0.153.4 keys were verified through its
 * local feature/tool manifest boundary without making a model request.
 */
export const CODEX_CLI_ISOLATION_ARGUMENTS = Object.freeze([
  "-c", "shell_environment_policy.inherit=\"none\"",
  "-c", "shell_environment_policy.ignore_default_excludes=false",
  "-c", "features.view_image=false",
  "-c", "web_search=\"disabled\"",
  "-c", "mcp_servers={}",
  "-c", "features.plugins=false",
  "-c", "features.apps=false",
  "-c", "features.remote_plugin=false",
  "-c", "features.plugin_sharing=false",
  "-c", "features.tool_suggest=false",
  "-c", "features.skill_search=false",
  "-c", "features.skill_mcp_dependency_install=false",
  "-c", "features.image_generation=false",
  "-c", "features.browser_use=false",
  "-c", "features.browser_use_external=false",
  "-c", "features.browser_use_full_cdp_access=false",
  "-c", "features.computer_use=false",
  "-c", "features.workspace_dependencies=false",
  "-c", "features.goals=false",
  "-c", "features.multi_agent=false",
  "-c", "features.multi_agent_v2=false",
  "-c", "agents.enabled=false",
  "-c", "tools.experimental_request_user_input.enabled=false",
  "-c", "tools.update_plan.enabled=false",
  "-c", "features.shell_tool=false",
  "-c", "features.unified_exec=false",
  "-c", "orchestrator.skills.enabled=false",
  "--sandbox", "read-only",
  "--skip-git-repo-check",
  "--ephemeral",
  "--ignore-user-config",
  "--ignore-rules",
  "--strict-config",
  "--color", "never",
] as const);

export const CODEX_CLI_IMAGE_INSPECTION_POLICY =
  "disabled_by_pinned_feature" as const;

/** No-model fake-endpoint capture for the only production-supported binary. */
export const CODEX_CLI_PINNED_VERSION = "codex-cli 0.153.4" as const;
export const CODEX_CLI_CAPTURED_EXECUTABLE_IDENTITY: ContentIdentity = Object.freeze({
  algorithm: "sha256",
  digest: "a1cf6360ca71918d5466bc3a32d9f18b7044c9128756d1949e715d277b88c9b6",
  size: 295_408_944,
});
export const CODEX_CLI_CAPTURED_MODEL = "gpt-5.6-sol" as const;
export const CODEX_CLI_CAPTURED_TOOL_PROFILE = Object.freeze({
  schemaVersion: "evleda.codex-cli-captured-tool-profile.v2" as const,
  captureMethod: "local-fake-responses-no-model" as const,
  model: CODEX_CLI_CAPTURED_MODEL,
  originalInventorySha256: "e05f4d1a88a9b58adca4e475fe2c5a2cadabe15a354d5712d5a98a12f1c60b62" as const,
  inventorySha256: "72e35cf8ba0499e9868c26b19bdfbcbc75241e0c47b019dce15b70d1ca90a926" as const,
  inventoryCanonicalJson: "{\"model\":\"gpt-5.6-sol\",\"responsesRequestToolsFieldPresent\":false,\"responsesRequestAdditionalToolsFieldPresent\":true,\"toolChoice\":\"auto\",\"namespaces\":[{\"name\":\"functions\",\"type\":\"namespace\",\"tools\":[{\"name\":\"exec\",\"type\":\"custom\"},{\"name\":\"wait\",\"type\":\"function\"}]}],\"nestedHeadings\":[\"apply_patch\"]}" as const,
  responsesRequestToolsFieldPresent: false as const,
  responsesRequestAdditionalToolsFieldPresent: true as const,
  toolChoice: "auto" as const,
  namespacedTools: Object.freeze(["functions.exec", "wait"] as const),
  nestedExecTools: Object.freeze(["apply_patch"] as const),
  viewImage: false as const,
  webSearch: false as const,
  mcpResources: false as const,
  pluginInstall: false as const,
  collaboration: false as const,
  requestUserInput: false as const,
  writeSandbox: "read-only" as const,
});
if (createHash("sha256")
  .update(CODEX_CLI_CAPTURED_TOOL_PROFILE.inventoryCanonicalJson, "utf8")
  .digest("hex") !== CODEX_CLI_CAPTURED_TOOL_PROFILE.inventorySha256) {
  throw new Error("Codex CLI captured tool-profile evidence digest is invalid");
}

/** Additive model-specific capture; the retained Sol profile and its canonical identity remain unchanged. */
export const CODEX_CLI_ASTRA_CAPTURED_MODEL = "gpt-6-astra" as const;
export const CODEX_CLI_ASTRA_CAPTURED_TOOL_PROFILE = Object.freeze({
  schemaVersion: "evleda.codex-cli-captured-tool-profile.v3" as const,
  captureMethod: "local-fake-responses-no-model" as const,
  model: CODEX_CLI_ASTRA_CAPTURED_MODEL,
  inventorySha256: "50b441dad797ab840c90c3185d680d0a029fadad930f195c6e368b3a985def0d" as const,
  inventoryCanonicalJson: "{\"model\":\"gpt-6-astra\",\"responsesRequestToolsFieldPresent\":false,\"responsesRequestAdditionalToolsFieldPresent\":true,\"toolChoice\":\"auto\",\"namespaces\":[{\"name\":\"functions\",\"type\":\"namespace\",\"tools\":[{\"name\":\"exec\",\"type\":\"custom\"},{\"name\":\"wait\",\"type\":\"function\"},{\"name\":\"request_user_input_async\",\"type\":\"function\"}]},{\"name\":\"clock\",\"type\":\"namespace\",\"tools\":[{\"name\":\"sleep\",\"type\":\"function\"}]}],\"nestedHeadings\":[\"apply_patch\",\"clock__curr_time\"]}" as const,
  toolInventoryLocation: "request.input[type=additional_tools].tools" as const,
  responsesRequestToolsFieldPresent: false as const,
  responsesRequestAdditionalToolsFieldPresent: true as const,
  toolChoice: "auto" as const,
  namespacedTools: Object.freeze(["functions.exec", "wait", "request_user_input_async", "sleep"] as const),
  nestedExecTools: Object.freeze(["apply_patch", "clock__curr_time"] as const),
  fullyQualifiedTools: Object.freeze(["functions.exec", "functions.wait", "functions.request_user_input_async", "clock.sleep"] as const),
  viewImage: false as const,
  webSearch: false as const,
  mcpResources: false as const,
  pluginInstall: false as const,
  collaboration: false as const,
  requestUserInput: true as const,
  clockSleep: true as const,
  clockCurrentTime: true as const,
  writeSandbox: "read-only" as const,
});
if (createHash("sha256")
  .update(CODEX_CLI_ASTRA_CAPTURED_TOOL_PROFILE.inventoryCanonicalJson, "utf8")
  .digest("hex") !== CODEX_CLI_ASTRA_CAPTURED_TOOL_PROFILE.inventorySha256) {
  throw new Error("Codex CLI Astra captured tool-profile evidence digest is invalid");
}

const CODEX_CLI_CAPTURED_TOOL_PROFILES = Object.freeze({
  [CODEX_CLI_CAPTURED_MODEL]: CODEX_CLI_CAPTURED_TOOL_PROFILE,
  [CODEX_CLI_ASTRA_CAPTURED_MODEL]: CODEX_CLI_ASTRA_CAPTURED_TOOL_PROFILE,
});
export type CodexCliCapturedToolProfile = (typeof CODEX_CLI_CAPTURED_TOOL_PROFILES)[keyof typeof CODEX_CLI_CAPTURED_TOOL_PROFILES];
export const codexCliCapturedToolProfileForModel = (model: string): CodexCliCapturedToolProfile | undefined =>
  Object.hasOwn(CODEX_CLI_CAPTURED_TOOL_PROFILES, model)
    ? CODEX_CLI_CAPTURED_TOOL_PROFILES[model as keyof typeof CODEX_CLI_CAPTURED_TOOL_PROFILES]
    : undefined;

/**
 * Codex 0.153.4 always asks the Responses API to enforce output schemas in
 * strict mode.  The full PCB draft schema exceeds that subset's nesting bound
 * and contains unsupported `oneOf` nodes, so Codex transports one bounded JSON
 * arguments JSON string inside this deliberately shallow, closed and explicit
 * envelope. The host reconstructs the turn and applies full Zod/tool
 * validation before accepting it.
 */
export const CODEX_CLI_TURN_ENVELOPE_SCHEMA_VERSION =
  "evleda.harness-cli-turn-envelope.v3" as const;
export const CODEX_CLI_TURN_ENVELOPE_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: Object.freeze({
    schemaVersion: Object.freeze({
      type: "string",
      enum: Object.freeze([CODEX_CLI_TURN_ENVELOPE_SCHEMA_VERSION]),
    }),
    messageContent: Object.freeze({ type: "string" }),
    hasToolCalls: Object.freeze({ type: "boolean" }),
    toolCalls: Object.freeze({
      type: "array",
      items: Object.freeze({
        type: "object",
        additionalProperties: false,
        properties: Object.freeze({
          id: Object.freeze({ type: "string" }),
          name: Object.freeze({ type: "string" }),
          argumentsJson: Object.freeze({ type: "string" }),
        }),
        required: Object.freeze(["id", "name", "argumentsJson"]),
      }),
    }),
    stopReason: Object.freeze({ type: "string", enum: Object.freeze(["tool_calls", "completed", "blocked"]) }),
  }),
  required: Object.freeze(["schemaVersion", "messageContent", "hasToolCalls", "toolCalls", "stopReason"]),
});

export interface CodexStrictSchemaInspection {
  readonly nodeCount: number;
  readonly maximumDepth: number;
}

const CODEX_STRICT_SCHEMA_KEYS = new Set([
  "type", "additionalProperties", "properties", "required", "enum", "items",
]);
const CODEX_STRICT_SCHEMA_MAX_PROPERTIES = 100;
const CODEX_STRICT_SCHEMA_MAX_ENUM_VALUES = 500;
const CODEX_STRICT_SCHEMA_MAX_NAMING_BYTES = 15_000;
const CODEX_STRICT_SCHEMA_LARGE_ENUM_VALUES = 250;
const CODEX_STRICT_SCHEMA_LARGE_ENUM_BYTES = 7_500;

/** Validate only the conservative strict subset used by our Codex envelope. */
export const inspectCodexStrictOutputSchema = (value: unknown): CodexStrictSchemaInspection => {
  let nodeCount = 0;
  let maximumDepth = 0;
  let propertyCount = 0;
  let enumValueCount = 0;
  let namingBytes = 0;
  const visit = (candidate: unknown, depth: number): void => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("Codex strict output schema contains a non-object schema node");
    }
    nodeCount += 1;
    maximumDepth = Math.max(maximumDepth, depth);
    if (nodeCount > 100 || depth > 10) throw new Error("Codex strict output schema exceeds its structural limits");
    const record = candidate as Record<string, unknown>;
    if (Reflect.ownKeys(record).some((key) => typeof key !== "string" || !CODEX_STRICT_SCHEMA_KEYS.has(key))) {
      throw new Error("Codex strict output schema contains an unsupported keyword");
    }
    if (record.type !== "object" && record.type !== "string" && record.type !== "boolean" && record.type !== "array") {
      throw new Error("Codex strict output schema contains an unsupported type");
    }
    if (record.type === "string" || record.type === "boolean") {
      if (record.properties !== undefined || record.required !== undefined
        || record.additionalProperties !== undefined || record.items !== undefined) {
        throw new Error("Codex strict string schema contains object-only keywords");
      }
      if (record.type === "boolean" && record.enum !== undefined) {
        throw new Error("Codex strict boolean schema contains an enum");
      }
      if (record.enum !== undefined && (
        !Array.isArray(record.enum)
        || record.enum.length < 1
        || record.enum.length > CODEX_STRICT_SCHEMA_MAX_ENUM_VALUES
        || record.enum.some((entry) => typeof entry !== "string")
      )) throw new Error("Codex strict output schema contains an invalid enum");
      if (Array.isArray(record.enum)) {
        const values = record.enum as string[];
        if (new Set(values).size !== values.length) {
          throw new Error("Codex strict output schema contains a duplicate enum value");
        }
        const enumBytes = values.reduce((total, entry) => total + Buffer.byteLength(entry, "utf8"), 0);
        enumValueCount += values.length;
        namingBytes += enumBytes;
        if (enumValueCount > CODEX_STRICT_SCHEMA_MAX_ENUM_VALUES
          || namingBytes > CODEX_STRICT_SCHEMA_MAX_NAMING_BYTES
          || (values.length > CODEX_STRICT_SCHEMA_LARGE_ENUM_VALUES
            && enumBytes > CODEX_STRICT_SCHEMA_LARGE_ENUM_BYTES)) {
          throw new Error("Codex strict output schema exceeds its enum limits");
        }
      }
      return;
    }
    if (record.type === "array") {
      if (record.enum !== undefined || record.properties !== undefined || record.required !== undefined
        || record.additionalProperties !== undefined || record.items === undefined) {
        throw new Error("Codex strict array schema is malformed");
      }
      visit(record.items, depth + 1);
      return;
    }
    if (record.items !== undefined) throw new Error("Codex strict object schema contains array-only keywords");
    if (record.enum !== undefined) throw new Error("Codex strict object schema contains an enum");
    if (record.additionalProperties !== false) {
      throw new Error("Codex strict object schemas must be closed");
    }
    if (record.properties === null || typeof record.properties !== "object" || Array.isArray(record.properties)) {
      throw new Error("Codex strict object schema is missing properties");
    }
    const properties = record.properties as Record<string, unknown>;
    const names = Object.keys(properties);
    propertyCount += names.length;
    namingBytes += names.reduce((total, name) => total + Buffer.byteLength(name, "utf8"), 0);
    if (propertyCount > CODEX_STRICT_SCHEMA_MAX_PROPERTIES
      || namingBytes > CODEX_STRICT_SCHEMA_MAX_NAMING_BYTES
      || Reflect.ownKeys(properties).length !== names.length) {
      throw new Error("Codex strict object schema exceeds its property limits");
    }
    if (!Array.isArray(record.required)
      || record.required.length !== names.length
      || record.required.some((entry) => typeof entry !== "string")
      || new Set(record.required as string[]).size !== names.length
      || names.some((name) => !(record.required as string[]).includes(name))) {
      throw new Error("Codex strict object schemas must require every property");
    }
    for (const child of Object.values(properties)) visit(child, depth + 1);
  };
  visit(value, 1);
  return Object.freeze({ nodeCount, maximumDepth });
};

// Fail module initialization if a future edit drifts outside the pinned subset.
export const CODEX_CLI_TURN_ENVELOPE_SCHEMA_INSPECTION = Object.freeze(
  inspectCodexStrictOutputSchema(CODEX_CLI_TURN_ENVELOPE_JSON_SCHEMA),
);

const CODEX_PROVIDER_FAILURE_ADAPTER_IDENTITY = canonicalIdentity({
  adapterSchemaVersion: CODEX_CLI_HARNESS_PROVIDER_ADAPTER_SCHEMA_VERSION,
  envelopeSchemaVersion: CODEX_CLI_TURN_ENVELOPE_SCHEMA_VERSION,
}, PROVIDER_FAILURE_ADAPTER_IDENTITY_SCHEMA_VERSION);
const CODEX_OUTER_ENVELOPE_LIMITS = Object.freeze({
  maximumDepth: 8,
  maximumNodes: 512,
  maximumArrayLength: 64,
  maximumOwnKeys: 16,
  maximumKeyBytes: 64,
});
const CODEX_ARGUMENTS_LIMITS = Object.freeze({
  byteFractionNumerator: 3,
  byteFractionDenominator: 4,
  maximumDepth: 64,
  maximumNodes: 65_536,
  maximumArrayLength: 4_096,
  maximumOwnKeys: 512,
  maximumKeyBytes: 512,
});
const CODEX_PROVIDER_FAILURE_PARSER_IDENTITY = canonicalIdentity({
  leaves: PROVIDER_FAILURE_LEAVES,
  boundaries: {
    cleanup: "cli_temporary_output",
    output: "cli_turn_output",
  },
  checkpointKeys: PROVIDER_FAILURE_CHECKPOINT_KEYS,
  issuePaths: PROVIDER_FAILURE_ISSUE_PATHS,
  issueCodes: PROVIDER_FAILURE_ISSUE_CODES,
  observedTypes: PROVIDER_FAILURE_OBSERVED_TYPES,
  envelopeSchemaVersion: CODEX_CLI_TURN_ENVELOPE_SCHEMA_VERSION,
  maximumIssues: PROVIDER_FAILURE_EVIDENCE_MAX_ISSUES,
  outerEnvelopeLimits: CODEX_OUTER_ENVELOPE_LIMITS,
  argumentsLimits: CODEX_ARGUMENTS_LIMITS,
  hostValidators: {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    names: ["HarnessProviderMessage", "HarnessToolCall", "HarnessProviderTurn"],
  },
}, PROVIDER_FAILURE_PARSER_IDENTITY_SCHEMA_VERSION);

type ProviderFailureCheckpoints = ProviderFailureEvidenceV1["checkpoints"];
const providerFailureCheckpoints = (): Record<keyof ProviderFailureCheckpoints, boolean> => ({
  outerBytesWithinLimit: false,
  outerJsonParsed: false,
  outerShapeClosed: false,
  outerVersionMatched: false,
  outerTypesValid: false,
  argumentsStringsWithinLimit: false,
  argumentsJsonParsed: false,
  argumentsWithinLimit: false,
  turnSchemaValid: false,
  messageSchemaValid: false,
  callSchemaValid: false,
  toolNamesAllowed: false,
  callIdsUnique: false,
  parallelPolicyValid: false,
  requiredToolValid: false,
  stopReasonValid: false,
  cleanupCompleted: false,
});

const observedType = (value: unknown): ProviderFailureIssueV1["observedType"] => {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "unknown";
};

interface ClosedSchemaIssue {
  readonly code?: unknown;
  readonly path?: unknown;
}

const normalizedSchemaIssueCode = (code: unknown): ProviderFailureIssueV1["code"] => {
  if (code === "invalid_type") return "INVALID_TYPE";
  if (code === "unrecognized_keys") return "EXTRA_FIELD";
  if (code === "too_big") return "BYTE_LIMIT";
  if (code === "invalid_format" || code === "invalid_value") return "INVALID_VALUE";
  return "SCHEMA";
};

const normalizedCallSchemaIssues = (
  issues: readonly ClosedSchemaIssue[],
  call: Readonly<{ readonly id: unknown; readonly name: unknown; readonly arguments: unknown }>,
): readonly ProviderFailureIssueV1[] => issues.slice(0, PROVIDER_FAILURE_EVIDENCE_MAX_ISSUES).map((issue) => {
  const first = Array.isArray(issue.path) ? issue.path[0] : undefined;
  const field = first === "id" ? Object.freeze({ path: "$.toolCalls[].id" as const, value: call.id })
    : first === "name" ? Object.freeze({ path: "$.toolCalls[].name" as const, value: call.name })
      : first === "arguments" ? Object.freeze({ path: "$.toolCalls[].arguments" as const, value: call.arguments })
        : undefined;
  return Object.freeze({
    path: field?.path ?? "$.toolCalls[]",
    code: normalizedSchemaIssueCode(issue.code),
    observedType: field === undefined ? "object" : observedType(field.value),
  }) as ProviderFailureIssueV1;
});

const normalizedMessageSchemaIssues = (
  issues: readonly ClosedSchemaIssue[],
  messageContent: unknown,
): readonly ProviderFailureIssueV1[] => issues.slice(0, PROVIDER_FAILURE_EVIDENCE_MAX_ISSUES).map((issue) => Object.freeze({
  path: Array.isArray(issue.path) && issue.path[0] === "content" ? "$.messageContent" : "$.message",
  code: normalizedSchemaIssueCode(issue.code),
  observedType: Array.isArray(issue.path) && issue.path[0] === "content"
    ? observedType(messageContent)
    : "object",
}) as ProviderFailureIssueV1);

const normalizedTurnSchemaIssues = (
  issues: readonly ClosedSchemaIssue[],
  turn: Readonly<Record<string, unknown>>,
): readonly ProviderFailureIssueV1[] => issues.slice(0, PROVIDER_FAILURE_EVIDENCE_MAX_ISSUES).map((issue) => {
  const first = Array.isArray(issue.path) ? issue.path[0] : undefined;
  const path = first === "stopReason" ? "$.stopReason"
    : first === "toolCalls" ? "$.toolCalls"
      : first === "message" ? "$.message" : "$";
  return Object.freeze({
    path,
    code: normalizedSchemaIssueCode(issue.code),
    observedType: typeof first === "string" && Object.hasOwn(turn, first)
      ? observedType(turn[first])
      : "object",
  }) as ProviderFailureIssueV1;
});

interface CodexFailureContext {
  readonly transportSchemaIdentity: CanonicalIdentity;
  readonly checkpoints: Record<keyof ProviderFailureCheckpoints, boolean>;
  readonly outerText?: string;
  readonly argumentTexts?: readonly string[];
  readonly issues?: readonly ProviderFailureIssueV1[];
}

const digestText = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

const codexFailure = (
  leaf: ProviderFailureLeaf,
  providerErrorClass: ProviderFailureEvidenceV1["providerErrorClass"],
  context: CodexFailureContext,
): HarnessProviderError => {
  const argumentTexts = context.argumentTexts ?? [];
  const argumentsCanonical = argumentTexts.length === 0 ? undefined : canonicalJson(argumentTexts);
  const evidence = createProviderFailureEvidence({
    adapter: "codex",
    boundary: leaf === "CLEANUP_SECONDARY" ? "cli_temporary_output" : "cli_turn_output",
    leaf,
    providerErrorClass,
    checkpoints: Object.freeze({ ...context.checkpoints }),
    identities: Object.freeze({
      adapter: CODEX_PROVIDER_FAILURE_ADAPTER_IDENTITY,
      parser: CODEX_PROVIDER_FAILURE_PARSER_IDENTITY,
      transportSchema: context.transportSchemaIdentity,
    }),
    observations: Object.freeze({
      outerBytes: context.outerText === undefined ? null : byteLength(context.outerText),
      outerSha256: context.outerText === undefined ? null : digestText(context.outerText),
      argumentsBytes: argumentTexts.length === 0
        ? null
        : argumentTexts.reduce((total, text) => total + byteLength(text), 0),
      argumentsSha256: argumentsCanonical === undefined ? null : digestText(argumentsCanonical),
      issues: Object.freeze([...(context.issues ?? [])].slice(0, PROVIDER_FAILURE_EVIDENCE_MAX_ISSUES)),
    }),
  });
  const bundle = createProviderFailureDiagnostic(
    leaf === "CLEANUP_SECONDARY" && providerErrorClass === "INCOMPLETE"
      ? "PROVIDER_REQUEST_FAILED"
      : "PROVIDER_RESPONSE_INVALID",
    evidence,
  );
  return new HarnessProviderError(
    "Codex CLI returned invalid structured output",
    providerErrorClass,
    undefined,
    bundle.diagnostic,
    bundle.providerFailureEvidence,
  );
};

const providerFailureAfterCompletedCleanup = (error: HarnessProviderError): HarnessProviderError => {
  if (error.providerFailureEvidence === undefined || error.diagnostic === undefined) return error;
  const evidence = createProviderFailureEvidence({
    adapter: error.providerFailureEvidence.adapter,
    boundary: error.providerFailureEvidence.boundary,
    leaf: error.providerFailureEvidence.leaf,
    providerErrorClass: error.providerFailureEvidence.providerErrorClass,
    checkpoints: {
      ...error.providerFailureEvidence.checkpoints,
      cleanupCompleted: true,
    },
    identities: error.providerFailureEvidence.identities,
    observations: error.providerFailureEvidence.observations,
  });
  const bundle = createProviderFailureDiagnostic(error.diagnostic.code, evidence);
  return new HarnessProviderError(
    error.message,
    error.code,
    error.status,
    bundle.diagnostic,
    bundle.providerFailureEvidence,
  );
};

type CliName = "codex" | "claude-cli";

const cliDiagnostic = (
  cli: CliName,
  code: FluxDiagnosticCode,
  boundary: string,
  category: string,
) => createFluxDiagnostic(code, { adapter: cli, boundary, category });

class CliTerminationUnconfirmedError extends HarnessProviderError {
  readonly retainTemporaryDirectory = true;
  constructor(cli: CliName) {
    super(
      "CLI provider process-tree termination could not be confirmed",
      "INCOMPLETE",
      undefined,
      cliDiagnostic(cli, "PROVIDER_REQUEST_FAILED", "cli_termination", "unconfirmed"),
    );
  }
}

export interface CliProcess {
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  readonly stdin: NodeJS.WritableStream;
  readonly pid?: number | undefined;
  kill(signal?: NodeJS.Signals | number): boolean;
  unref?(): void;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export type CliSpawner = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => CliProcess;

export interface CliHarnessProviderOptions {
  /** Explicit on purpose: a harness must not silently pick a model. */
  readonly model: string;
  /** Defaults to 90 seconds; a hung local client is terminated. */
  readonly timeoutMs?: number;
  /** Bounds stdout, stderr, structured output, and the serialized transcript. */
  readonly maxOutputBytes?: number;
  /** Cancellation terminates the child before rejecting. */
  readonly signal?: AbortSignal;
  /** Test seam. Production uses node:child_process.spawn with shell disabled. */
  readonly spawn?: CliSpawner;
  /** Test seam / explicit local wrapper path. Never interpreted by a shell. */
  readonly executablePath?: string;
  /** Test seam. Defaults to process.env. */
  readonly environment?: NodeJS.ProcessEnv;
  /** Test seam. Defaults to the operating-system temp directory. */
  readonly temporaryDirectory?: string;
  /** Exact host-owned binary bytes revalidated immediately before every turn. */
  readonly expectedExecutableIdentity?: ContentIdentity;
  /** Exact helper authority required to claim Windows process-tree death. */
  readonly windowsProcessTreeTermination?: BoundedWindowsProcessTreeTermination;
  /** Deterministic delay seams; production composition must omit these. */
  readonly testHooks?: Readonly<{
    readonly beforeExecutableValidation?: () => void | Promise<void>;
    readonly beforeOutputRead?: () => void | Promise<void>;
    readonly beforeCleanup?: () => void | Promise<void>;
    readonly terminateProcessForTesting?: (child: CliProcess, closed: Promise<void>) => Promise<void>;
  }>;
}

export interface CodexCliHarnessProviderOptions extends CliHarnessProviderOptions {
  readonly executablePath?: string;
}

export interface ClaudeCliHarnessProviderOptions extends CliHarnessProviderOptions {
  readonly executablePath?: string;
}

interface PreparedOptions {
  readonly cli: CliName;
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
  readonly spawn: CliSpawner;
  readonly executablePath?: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly childEnvironment: NodeJS.ProcessEnv;
  readonly temporaryDirectory: string;
  readonly expectedExecutableIdentity?: ContentIdentity;
  readonly windowsProcessTreeTermination?: BoundedWindowsProcessTreeTermination;
  readonly testHooks: NonNullable<CliHarnessProviderOptions["testHooks"]>;
}

const spawnWithoutShell: CliSpawner = (command, args, options) =>
  nodeSpawn(command, args, { ...options, shell: false }) as ChildProcessWithoutNullStreams;

const boundedPositive = (value: number | undefined, fallback: number, label: string): number => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${label} must be a positive integer`);
  return result;
};

const boundedAtMost = (
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string
): number => {
  const result = boundedPositive(value, fallback, label);
  if (result > maximum) throw new Error(`${label} may not exceed ${maximum}`);
  return result;
};

const required = (value: string, label: string): string => {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
};

const COMMON_CHILD_ENVIRONMENT_KEYS = Object.freeze([
  "PATH", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR",
  "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "LANG", "LC_ALL",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR",
] as const);

const PROVIDER_CHILD_ENVIRONMENT_KEYS: Readonly<Record<CliName, readonly string[]>> = Object.freeze({
  // Codex must use its already-authenticated CODEX_HOME. API credentials are
  // deliberately absent from the outer child and from model-run subprocesses.
  codex: Object.freeze(["CODEX_HOME"]),
  "claude-cli": Object.freeze(["CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]),
});

/** The provider process never inherits arbitrary host/application variables. */
export const createCliProviderChildEnvironment = (
  cli: CliName,
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv => {
  const output: NodeJS.ProcessEnv = {};
  for (const key of [...COMMON_CHILD_ENVIRONMENT_KEYS, ...PROVIDER_CHILD_ENVIRONMENT_KEYS[cli]]) {
    const value = environment[key];
    if (typeof value === "string" && value.length > 0 && !value.includes("\0")) output[key] = value;
  }
  return Object.freeze(output);
};

const executableIdentity = (value: unknown): ContentIdentity => {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Reflect.ownKeys(value).length !== 3
  ) throw new Error("expectedExecutableIdentity must be an exact SHA-256 content identity");
  const record = value as Record<string, unknown>;
  if (
    record.algorithm !== "sha256"
    || typeof record.digest !== "string"
    || !/^[0-9a-f]{64}$/u.test(record.digest)
    || typeof record.size !== "number"
    || !Number.isSafeInteger(record.size)
    || record.size < 1
    || record.size > 512 * 1024 * 1024
    || !["algorithm", "digest", "size"].every((key) => Object.hasOwn(record, key))
  ) throw new Error("expectedExecutableIdentity must be an exact SHA-256 content identity");
  return Object.freeze({ algorithm: "sha256", digest: record.digest, size: record.size });
};

const environmentExecutableIdentity = (
  cli: CliName,
  environment: NodeJS.ProcessEnv
): ContentIdentity | undefined => {
  const keys = CLI_PROVIDER_EXECUTABLE_PIN_ENVIRONMENT[cli];
  const digest = environment[keys.sha256];
  const sizeText = environment[keys.sizeBytes];
  if (digest === undefined && sizeText === undefined) return undefined;
  if (digest === undefined || sizeText === undefined || !/^[1-9][0-9]*$/u.test(sizeText)) {
    throw new Error(`${cli} executable identity environment is incomplete`);
  }
  return executableIdentity({ algorithm: "sha256", digest, size: Number(sizeText) });
};

const prepare = (options: CliHarnessProviderOptions, cli: CliName): PreparedOptions => {
  const environment = options.environment ?? process.env;
  const explicitIdentity = options.expectedExecutableIdentity === undefined
    ? undefined
    : executableIdentity(options.expectedExecutableIdentity);
  const environmentIdentity = environmentExecutableIdentity(cli, environment);
  if (
    explicitIdentity !== undefined
    && environmentIdentity !== undefined
    && canonicalIdentityText(explicitIdentity) !== canonicalIdentityText(environmentIdentity)
  ) throw new Error(`${cli} executable identity sources disagree`);
  const expectedExecutableIdentity = explicitIdentity ?? environmentIdentity;
  return {
    cli,
    model: required(options.model, "model"),
    timeoutMs: boundedAtMost(options.timeoutMs, DEFAULT_CLI_PROVIDER_TIMEOUT_MS, MAXIMUM_CLI_PROVIDER_TIMEOUT_MS, "timeoutMs"),
    maxOutputBytes: boundedAtMost(options.maxOutputBytes, DEFAULT_CLI_PROVIDER_OUTPUT_BYTES, MAXIMUM_CLI_PROVIDER_OUTPUT_BYTES, "maxOutputBytes"),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    spawn: options.spawn ?? spawnWithoutShell,
    ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
    environment,
    childEnvironment: createCliProviderChildEnvironment(cli, environment),
    temporaryDirectory: options.temporaryDirectory ?? os.tmpdir(),
    ...(expectedExecutableIdentity === undefined
      ? {}
      : { expectedExecutableIdentity }),
    ...(options.windowsProcessTreeTermination === undefined
      ? {}
      : { windowsProcessTreeTermination: options.windowsProcessTreeTermination }),
    testHooks: options.testHooks ?? {},
  };
};

const canonicalIdentityText = (identity: ContentIdentity): string =>
  `${identity.algorithm}:${identity.digest}:${identity.size}`;

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

interface ExecutableFileBinding {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

const executableFileBinding = (metadata: BigIntStats): ExecutableFileBinding => Object.freeze({
  dev: metadata.dev,
  ino: metadata.ino,
  mode: metadata.mode,
  nlink: metadata.nlink,
  size: metadata.size,
  mtimeNs: metadata.mtimeNs,
  ctimeNs: metadata.ctimeNs,
});

const sameExecutableFile = (left: ExecutableFileBinding, right: ExecutableFileBinding): boolean =>
  left.dev === right.dev
  && left.ino === right.ino
  && left.mode === right.mode
  && left.nlink === right.nlink
  && left.size === right.size
  && left.mtimeNs === right.mtimeNs
  && left.ctimeNs === right.ctimeNs;

const sameExecutablePath = (left: string, right: string): boolean => {
  const normalize = (value: string): string => process.platform === "win32"
    ? path.resolve(value).toLocaleLowerCase("en-US")
    : path.resolve(value);
  return normalize(left) === normalize(right);
};

/**
 * Descriptor-bounded revalidation immediately before each provider spawn.
 * The post-spawn check detects replacement during a completed turn as well.
 */
const assertPinnedExecutable = async (
  executablePath: string,
  expected: ContentIdentity | undefined,
  signal?: AbortSignal,
): Promise<void> => {
  signal?.throwIfAborted();
  if (expected === undefined) return;
  const rejected = (): never => {
    throw new HarnessProviderError("CLI provider executable no longer matches its pinned identity", "MALFORMED");
  };
  let beforeMetadata: BigIntStats;
  let canonical: string;
  try {
    beforeMetadata = await lstat(executablePath, { bigint: true });
    signal?.throwIfAborted();
    if (
      !beforeMetadata.isFile()
      || beforeMetadata.isSymbolicLink()
      || beforeMetadata.nlink !== 1n
      || beforeMetadata.size !== BigInt(expected.size)
    ) return rejected();
    canonical = await realpath(executablePath);
    signal?.throwIfAborted();
    if (!sameExecutablePath(canonical, executablePath)) return rejected();
  } catch {
    return rejected();
  }
  const before = executableFileBinding(beforeMetadata);
  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  let handle;
  try {
    handle = await open(canonical, fsConstants.O_RDONLY | noFollow);
    signal?.throwIfAborted();
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameExecutableFile(before, executableFileBinding(opened))) return rejected();
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, expected.size));
    let position = 0;
    while (position < expected.size) {
      signal?.throwIfAborted();
      const length = Math.min(buffer.byteLength, expected.size - position);
      const result = await handle.read(buffer, 0, length, position);
      if (result.bytesRead !== length) return rejected();
      hash.update(buffer.subarray(0, result.bytesRead));
      position += result.bytesRead;
    }
    const afterHandle = await handle.stat({ bigint: true });
    signal?.throwIfAborted();
    if (!sameExecutableFile(before, executableFileBinding(afterHandle))) return rejected();
    const afterPath = await lstat(canonical, { bigint: true });
    if (afterPath.isSymbolicLink() || !sameExecutableFile(before, executableFileBinding(afterPath))) return rejected();
    if (!sameExecutablePath(await realpath(canonical), canonical)) return rejected();
    if (!constantTimeDigestEqual(hash.digest("hex"), expected.digest)) return rejected();
  } catch (error) {
    if (error instanceof HarnessProviderError) throw error;
    return rejected();
  } finally {
    await handle?.close();
  }
};

const isFile = async (candidate: string): Promise<boolean> => {
  try { await access(candidate); return true; } catch { return false; }
};

const pathEntries = (environment: NodeJS.ProcessEnv): readonly string[] =>
  (environment.PATH ?? "").split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);

/** Finds a directly executable official binary; .cmd/.ps1 wrappers are never shell-launched. */
export async function resolveCliExecutable(
  cli: CliName,
  environment: NodeJS.ProcessEnv = process.env,
  explicitPath?: string,
): Promise<string> {
  if (explicitPath !== undefined) {
    if (!(await isFile(explicitPath))) throw new Error(`${cli} executable does not exist: ${explicitPath}`);
    return explicitPath;
  }
  const override = environment[cli === "codex" ? "EVLEDA_CODEX_CLI" : "EVLEDA_CLAUDE_CLI"]?.trim();
  if (override) {
    if (!(await isFile(override))) throw new Error(`${cli} executable does not exist: ${override}`);
    return override;
  }
  const windows = process.platform === "win32";
  const names = windows ? [`${cli === "claude-cli" ? "claude" : cli}.exe`] : [cli === "claude-cli" ? "claude" : cli];
  for (const directory of pathEntries(environment)) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (await isFile(candidate)) return candidate;
    }
  }
  // The desktop Codex app installs a directly executable official binary below
  // LOCALAPPDATA.  This avoids launching the npm .cmd shim through a shell.
  if (cli === "codex" && windows && environment.LOCALAPPDATA) {
    const root = path.join(environment.LOCALAPPDATA, "OpenAI", "Codex", "bin");
    try {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        const candidate = path.join(root, entry.name, "codex.exe");
        if (entry.isDirectory() && await isFile(candidate)) return candidate;
      }
    } catch { /* not installed in the desktop-app location */ }
  }
  throw new Error(`${cli} CLI was not found. Install and authenticate the official ${cli === "codex" ? "Codex" : "Claude Code"} CLI, or set ${cli === "codex" ? "EVLEDA_CODEX_CLI" : "EVLEDA_CLAUDE_CLI"}.`);
}

const requiredToolName = (
  request: HarnessProviderRequest,
  context: HarnessProviderTurnContext | undefined
): string | undefined => {
  const required = context?.requiredToolName;
  if (required === undefined) return undefined;
  if (request.tools.filter((tool) => tool.name === required).length !== 1) {
    throw new HarnessProviderError("The required CLI provider tool is not uniquely defined by this request", "MALFORMED");
  }
  return required;
};

const turnSignal = (configured: AbortSignal | undefined, perTurn: AbortSignal | undefined): AbortSignal | undefined =>
  configured === undefined
    ? perTurn
    : perTurn === undefined || configured === perTurn
      ? configured
      : AbortSignal.any([configured, perTurn]);

const turnTimeoutMs = (configured: number, context: HarnessProviderTurnContext | undefined): number => {
  const requested = (context as (HarnessProviderTurnContext & { readonly timeoutMs?: unknown }) | undefined)?.timeoutMs;
  if (requested === undefined) return configured;
  if (!Number.isSafeInteger(requested) || (requested as number) < 1 || (requested as number) > MAXIMUM_CLI_PROVIDER_TIMEOUT_MS) {
    throw new HarnessProviderError("The CLI provider turn timeout is invalid", "MALFORMED");
  }
  return Math.min(configured, requested as number);
};

const turnOutputBytes = (configured: number, request: HarnessProviderRequest): number => {
  const requested = (request as HarnessProviderRequest & { readonly maxOutputBytes?: unknown }).maxOutputBytes;
  if (requested === undefined) return configured;
  if (!Number.isSafeInteger(requested) || (requested as number) < 1 || (requested as number) > MAXIMUM_CLI_PROVIDER_OUTPUT_BYTES) {
    throw new HarnessProviderError("The CLI provider turn output-byte limit is invalid", "MALFORMED");
  }
  return Math.min(configured, requested as number);
};

const waitWithSignal = async <Value>(operation: Promise<Value>, signal: AbortSignal): Promise<Value> => {
  signal.throwIfAborted();
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = (): void => rejectAbort!(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  void operation.catch(() => undefined);
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
};

const frameRequest = (
  request: HarnessProviderRequest,
  limit: number,
  context?: HarnessProviderTurnContext,
  encoding: "direct" | "codex-explicit-envelope" = "direct",
): string => {
  const required = requiredToolName(request, context);
  const serialized = JSON.stringify({
    schemaVersion: "evleda.harness-cli-turn.v1",
    transcript: request.messages,
    tools: request.tools,
    previousResponseId: request.previousResponseId ?? null,
    control: {
      requiredToolName: required ?? null,
      allowParallelToolCalls: context?.allowParallelToolCalls ?? true,
      maxOutputBytes: turnOutputBytes(limit, request),
    }
  });
  if (byteLength(serialized) > limit) throw new HarnessProviderError("Harness transcript exceeds the CLI provider payload limit", "OUTPUT_LIMIT");
  const allowedToolNames = required === undefined
    ? request.tools.map((tool) => tool.name)
    : [required];
  const templateHasCall = allowedToolNames.length > 0;
  const template = {
    schemaVersion: CODEX_CLI_TURN_ENVELOPE_SCHEMA_VERSION,
    messageContent: "Candidate response.",
    hasToolCalls: templateHasCall,
    toolCalls: templateHasCall ? [{
      id: "call_1",
      name: allowedToolNames[0]!,
      argumentsJson: "{}",
    }] : [],
    stopReason: templateHasCall ? "tool_calls" : "completed",
  };
  const lines = [
    "You are a stateless PCB harness planning adapter.",
    "Do not invoke any CLI-provided shell, file, web, image, MCP, connector, or other tool; do not inspect, edit, or create files.",
    "Read the complete bounded transcript and supplied tool definitions below.",
    encoding === "codex-explicit-envelope"
      ? `Return exactly one shallow explicit envelope with schemaVersion=${CODEX_CLI_TURN_ENVELOPE_SCHEMA_VERSION}. The argumentsJson field is a string containing JSON, not an object. Replace its string value "{}" with a JSON-encoded string containing the tool's complete arguments object; argumentsJson itself must remain a string.`
      : "Return exactly one JSON object matching the provided HarnessProviderTurn schema.",
    ...(encoding === "codex-explicit-envelope"
      ? [`Allowed envelope tool names: ${JSON.stringify(allowedToolNames.length === 0 ? ["__none__"] : allowedToolNames)}.`]
      : []),
    required === undefined
      ? "Use only a supplied tool name. A tool call requires stopReason=tool_calls; otherwise return no toolCalls."
      : `Return exactly one ${required} call with stopReason=tool_calls; prose-only completion and every other tool name are invalid.`,
    context?.allowParallelToolCalls === false ? "Parallel or multiple tool calls are forbidden." : "Obey the supplied parallel-call control.",
    encoding === "codex-explicit-envelope"
      ? "The exact no-call sentinel is hasToolCalls=false with toolCalls=[]; then stopReason must be completed or blocked. For calls use hasToolCalls=true, one explicit id/name/argumentsJson entry per call, and stopReason=tool_calls."
      : "Do not include Markdown, explanations, or additional keys.",
    ...(encoding === "codex-explicit-envelope"
      ? ["CODEX_EXPLICIT_ENVELOPE_TEMPLATE_JSON:", JSON.stringify(template)]
      : []),
    "HARNESS_REQUEST_JSON:",
    serialized,
  ];
  const framed = lines.join("\n");
  if (byteLength(framed) > limit) throw new HarnessProviderError("Harness prompt exceeds the CLI provider payload limit", "OUTPUT_LIMIT");
  return framed;
};

const createCodexTurnOutputSchema = (
  request: HarnessProviderRequest,
  context?: HarnessProviderTurnContext,
): Record<string, unknown> => {
  const required = requiredToolName(request, context);
  const allowed = required === undefined ? request.tools.map((tool) => tool.name) : [required];
  const schema = structuredClone(CODEX_CLI_TURN_ENVELOPE_JSON_SCHEMA) as {
    properties: { toolCalls: { items: { properties: { name: Record<string, unknown> } } } };
  };
  schema.properties.toolCalls.items.properties.name = {
    type: "string",
    enum: allowed.length === 0 ? ["__none__"] : allowed,
  };
  inspectCodexStrictOutputSchema(schema);
  return schema as unknown as Record<string, unknown>;
};

const createCliTurnOutputSchema = (
  request: HarnessProviderRequest,
  context?: HarnessProviderTurnContext
): Record<string, unknown> => {
  const schema = structuredClone(createHarnessProviderTurnJsonSchema(request.tools));
  const required = requiredToolName(request, context);
  if (required === undefined) return schema;
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  properties.stopReason = { type: "string", enum: ["tool_calls"] };
  const toolCalls = properties.toolCalls!;
  toolCalls.minItems = 1;
  toolCalls.maxItems = 1;
  const items = toolCalls.items as { anyOf: Array<{ properties?: { name?: { enum?: string[] } } }> };
  items.anyOf = items.anyOf.filter((branch) => branch.properties?.name?.enum?.[0] === required);
  if (items.anyOf.length !== 1) {
    throw new HarnessProviderError("The required CLI provider output schema could not be constructed", "MALFORMED");
  }
  return schema;
};

const readBoundedFile = async (filePath: string, limit: number, signal?: AbortSignal): Promise<string> => {
  signal?.throwIfAborted();
  const malformed = (): never => {
    throw new HarnessProviderError("CLI provider output is not a stable ordinary file", "MALFORMED");
  };
  const oversized = (): never => {
    throw new HarnessProviderError("CLI provider output exceeds the byte limit", "OUTPUT_LIMIT");
  };
  let beforeMetadata: BigIntStats;
  let canonical: string;
  try {
    beforeMetadata = await lstat(filePath, { bigint: true });
    signal?.throwIfAborted();
    if (!beforeMetadata.isFile() || beforeMetadata.isSymbolicLink() || beforeMetadata.nlink !== 1n) return malformed();
    if (beforeMetadata.size > BigInt(limit)) return oversized();
    canonical = await realpath(filePath);
    signal?.throwIfAborted();
    if (!sameExecutablePath(canonical, filePath)) return malformed();
  } catch (error) {
    if (error instanceof HarnessProviderError) throw error;
    return malformed();
  }
  const before = executableFileBinding(beforeMetadata);
  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(canonical, fsConstants.O_RDONLY | noFollow);
    signal?.throwIfAborted();
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameExecutableFile(before, executableFileBinding(opened))) return malformed();
    const chunks: Buffer[] = [];
    let total = 0;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1));
    for (;;) {
      signal?.throwIfAborted();
      const result = await handle.read(buffer, 0, buffer.byteLength, total);
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
      if (total > limit) return oversized();
      chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead)));
    }
    const afterHandle = await handle.stat({ bigint: true });
    signal?.throwIfAborted();
    if (!sameExecutableFile(before, executableFileBinding(afterHandle)) || BigInt(total) !== afterHandle.size) return malformed();
    const afterPath = await lstat(canonical, { bigint: true });
    signal?.throwIfAborted();
    if (afterPath.isSymbolicLink() || !sameExecutableFile(before, executableFileBinding(afterPath))) return malformed();
    if (!sameExecutablePath(await realpath(canonical), canonical)) return malformed();
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
    } catch {
      return malformed();
    }
  } catch (error) {
    if (error instanceof HarnessProviderError) throw error;
    return malformed();
  } finally {
    await handle?.close();
  }
};

const parseStrictJson = (value: string): unknown => {
  if (byteLength(value) === 0) throw new HarnessProviderError("CLI provider returned no structured output", "MALFORMED");
  try { return JSON.parse(value); } catch { throw new HarnessProviderError("CLI provider returned malformed structured JSON", "MALFORMED"); }
};

const validateTurn = (
  value: unknown,
  request: HarnessProviderRequest,
  limit: number,
  context?: HarnessProviderTurnContext,
): HarnessProviderTurn => {
  if (byteLength(JSON.stringify(value)) > limit) throw new HarnessProviderError("CLI provider output exceeds the harness payload limit", "OUTPUT_LIMIT");
  let turn: HarnessProviderTurn;
  try { turn = harnessProviderTurnSchema.parse(value); }
  catch { throw new HarnessProviderError("CLI provider output does not match HarnessProviderTurn", "MALFORMED"); }
  const allowed = new Set(request.tools.map((tool) => tool.name));
  const ids = new Set<string>();
  for (const call of turn.toolCalls) {
    if (!allowed.has(call.name)) throw new HarnessProviderError("CLI provider requested an unsupported tool", "MALFORMED");
    if (ids.has(call.id)) throw new HarnessProviderError("CLI provider returned a duplicate tool-call ID", "MALFORMED");
    ids.add(call.id);
  }
  if (context?.allowParallelToolCalls === false && turn.toolCalls.length > 1) {
    throw new HarnessProviderError("CLI provider returned multiple tool calls when parallel calls are disabled", "MALFORMED");
  }
  const required = requiredToolName(request, context);
  if (required !== undefined && (
    turn.stopReason !== "tool_calls"
    || turn.toolCalls.length !== 1
    || turn.toolCalls[0]?.name !== required
  )) throw new HarnessProviderError("CLI provider did not return the exact required tool call", "MALFORMED");
  return turn;
};

const argumentsPortableBudgetExceeded = (value: unknown, stringByteLimit: number): boolean => {
  let nodes = 0;
  const pending: Array<readonly [unknown, number]> = [[value, 0]];
  while (pending.length > 0) {
    const [candidate, depth] = pending.pop()!;
    nodes += 1;
    if (nodes > CODEX_ARGUMENTS_LIMITS.maximumNodes
      || depth > CODEX_ARGUMENTS_LIMITS.maximumDepth) return true;
    if (typeof candidate === "string") {
      if (byteLength(candidate) > stringByteLimit) return true;
      continue;
    }
    if (candidate === null || typeof candidate !== "object") continue;
    if (Array.isArray(candidate)) {
      if (candidate.length > CODEX_ARGUMENTS_LIMITS.maximumArrayLength) return true;
      for (let index = candidate.length - 1; index >= 0; index -= 1) {
        pending.push([candidate[index], depth + 1]);
      }
      continue;
    }
    const entries = Object.entries(candidate as Record<string, unknown>);
    if (entries.length > CODEX_ARGUMENTS_LIMITS.maximumOwnKeys
      || entries.some(([key]) => byteLength(key) > CODEX_ARGUMENTS_LIMITS.maximumKeyBytes)) return true;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      pending.push([entries[index]![1], depth + 1]);
    }
  }
  return false;
};

const parseCodexTurnEnvelope = (
  text: string,
  request: HarnessProviderRequest,
  limit: number,
  transportSchemaIdentity: CanonicalIdentity,
  context?: HarnessProviderTurnContext,
): HarnessProviderTurn => {
  const checkpoints = providerFailureCheckpoints();
  const failure = (
    leaf: ProviderFailureLeaf,
    providerErrorClass: ProviderFailureEvidenceV1["providerErrorClass"],
    issues: readonly ProviderFailureIssueV1[],
    argumentTexts: readonly string[] = [],
  ): never => {
    throw codexFailure(leaf, providerErrorClass, {
      transportSchemaIdentity,
      checkpoints,
      outerText: text,
      argumentTexts,
      issues,
    });
  };
  if (byteLength(text) > limit) {
    return failure("OUTER_BUDGET_EXCEEDED", "OUTPUT_LIMIT", [{ path: "$", code: "BYTE_LIMIT", observedType: "string" }]);
  }
  checkpoints.outerBytesWithinLimit = true;
  let rawEnvelope: unknown;
  try {
    rawEnvelope = JSON.parse(text);
  } catch {
    return failure("OUTER_JSON_INVALID", "MALFORMED", [{ path: "$", code: "INVALID_JSON", observedType: "string" }]);
  }
  checkpoints.outerJsonParsed = true;
  let envelope: unknown;
  try {
    envelope = parsePortableJsonBytes(Buffer.from(text, "utf8"), {
      maxBytes: limit,
      maxDepth: CODEX_OUTER_ENVELOPE_LIMITS.maximumDepth,
      maxNodes: CODEX_OUTER_ENVELOPE_LIMITS.maximumNodes,
      maxArrayLength: CODEX_OUTER_ENVELOPE_LIMITS.maximumArrayLength,
      maxOwnKeys: CODEX_OUTER_ENVELOPE_LIMITS.maximumOwnKeys,
      maxKeyBytes: CODEX_OUTER_ENVELOPE_LIMITS.maximumKeyBytes,
      maxStringBytes: limit,
    });
  } catch {
    return failure("OUTER_SHAPE_INVALID", "MALFORMED", [{ path: "$", code: "SCHEMA", observedType: observedType(rawEnvelope) }]);
  }
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    return failure("OUTER_FIELD_TYPE_INVALID", "MALFORMED", [{ path: "$", code: "INVALID_TYPE", observedType: observedType(envelope) }]);
  }
  const record = envelope as Record<string, unknown>;
  const envelopeKeys = ["schemaVersion", "messageContent", "hasToolCalls", "toolCalls", "stopReason"] as const;
  const ownKeys = Reflect.ownKeys(record);
  if (ownKeys.length !== envelopeKeys.length
    || ownKeys.some((key) => typeof key !== "string" || !envelopeKeys.includes(key as typeof envelopeKeys[number]))) {
    return failure("OUTER_SHAPE_INVALID", "MALFORMED", [{
      path: "$",
      code: ownKeys.length > envelopeKeys.length ? "EXTRA_FIELD" : "MISSING_FIELD",
      observedType: "object",
    }]);
  }
  checkpoints.outerShapeClosed = true;
  if (record.schemaVersion !== CODEX_CLI_TURN_ENVELOPE_SCHEMA_VERSION) {
    return failure("OUTER_VERSION_MISMATCH", "MALFORMED", [{
      path: "$.schemaVersion", code: "MISMATCH", observedType: observedType(record.schemaVersion),
    }]);
  }
  checkpoints.outerVersionMatched = true;
  const typedFields: Array<readonly [string, unknown, string]> = [
    ["$.messageContent", record.messageContent, "string"],
    ["$.hasToolCalls", record.hasToolCalls, "boolean"],
    ["$.toolCalls", record.toolCalls, "array"],
    ["$.stopReason", record.stopReason, "string"],
  ];
  const typeIssue = typedFields.find(([, value, expected]) =>
    expected === "array" ? !Array.isArray(value) : typeof value !== expected);
  if (typeIssue !== undefined) {
    return failure("OUTER_FIELD_TYPE_INVALID", "MALFORMED", [{
      path: typeIssue[0] as ProviderFailureIssueV1["path"],
      code: "INVALID_TYPE",
      observedType: observedType(typeIssue[1]),
    }]);
  }
  checkpoints.outerTypesValid = true;
  const rawCalls = record.toolCalls as unknown[];
  if (rawCalls.length > 64) {
    return failure("CALL_SCHEMA_INVALID", "MALFORMED", [{ path: "$.toolCalls", code: "COUNT", observedType: "array" }]);
  }
  const argumentTextLimit = Math.max(1, Math.floor(
    limit * CODEX_ARGUMENTS_LIMITS.byteFractionNumerator
    / CODEX_ARGUMENTS_LIMITS.byteFractionDenominator,
  ));
  const argumentTexts: string[] = [];
  const calls: HarnessProviderTurn["toolCalls"][number][] = [];
  let totalArgumentBytes = 0;
  for (const rawCall of rawCalls) {
    if (rawCall === null || typeof rawCall !== "object" || Array.isArray(rawCall)) {
      return failure("CALL_SCHEMA_INVALID", "MALFORMED", [{ path: "$.toolCalls[]", code: "INVALID_TYPE", observedType: observedType(rawCall) }], argumentTexts);
    }
    const callRecord = rawCall as Record<string, unknown>;
    const callKeys = Reflect.ownKeys(callRecord);
    if (callKeys.length !== 3 || callKeys.some((key) =>
      typeof key !== "string" || !["id", "name", "argumentsJson"].includes(key))) {
      return failure("CALL_SCHEMA_INVALID", "MALFORMED", [{ path: "$.toolCalls[]", code: "SCHEMA", observedType: "object" }], argumentTexts);
    }
    if (typeof callRecord.id !== "string" || typeof callRecord.name !== "string" || typeof callRecord.argumentsJson !== "string") {
      const field = typeof callRecord.id !== "string" ? "$.toolCalls[].id"
        : typeof callRecord.name !== "string" ? "$.toolCalls[].name"
          : "$.toolCalls[].argumentsJson";
      const value = field.endsWith("id") ? callRecord.id
        : field.endsWith("name") ? callRecord.name : callRecord.argumentsJson;
      return failure("CALL_SCHEMA_INVALID", "MALFORMED", [{
        path: field as ProviderFailureIssueV1["path"], code: "INVALID_TYPE", observedType: observedType(value),
      }], argumentTexts);
    }
    argumentTexts.push(callRecord.argumentsJson);
    const argumentBytes = byteLength(callRecord.argumentsJson);
    totalArgumentBytes += argumentBytes;
    if (argumentBytes > argumentTextLimit) {
      return failure("ARGUMENTS_STRING_BUDGET_EXCEEDED", "OUTPUT_LIMIT", [{
        path: "$.toolCalls[].argumentsJson", code: "BYTE_LIMIT", observedType: "string",
      }], argumentTexts);
    }
    let argumentValue: unknown;
    try {
      argumentValue = JSON.parse(callRecord.argumentsJson);
    } catch {
      return failure("ARGUMENTS_JSON_INVALID", "MALFORMED", [{
        path: "$.toolCalls[].argumentsJson", code: "INVALID_JSON", observedType: "string",
      }], argumentTexts);
    }
    if (argumentValue === null || typeof argumentValue !== "object" || Array.isArray(argumentValue)) {
      return failure("ARGUMENTS_JSON_INVALID", "MALFORMED", [{
        path: "$.toolCalls[].arguments", code: "INVALID_TYPE", observedType: observedType(argumentValue),
      }], argumentTexts);
    }
    const argumentsExceededPortableBudget = argumentsPortableBudgetExceeded(
      argumentValue,
      argumentTextLimit,
    );
    let boundedArguments: unknown;
    try {
      boundedArguments = parsePortableJsonBytes(Buffer.from(callRecord.argumentsJson, "utf8"), {
        maxBytes: argumentTextLimit,
        maxDepth: CODEX_ARGUMENTS_LIMITS.maximumDepth,
        maxNodes: CODEX_ARGUMENTS_LIMITS.maximumNodes,
        maxArrayLength: CODEX_ARGUMENTS_LIMITS.maximumArrayLength,
        maxOwnKeys: CODEX_ARGUMENTS_LIMITS.maximumOwnKeys,
        maxKeyBytes: CODEX_ARGUMENTS_LIMITS.maximumKeyBytes,
        maxStringBytes: argumentTextLimit,
      });
    } catch {
      return failure(
        argumentsExceededPortableBudget ? "ARGUMENTS_BUDGET_EXCEEDED" : "ARGUMENTS_JSON_INVALID",
        argumentsExceededPortableBudget ? "OUTPUT_LIMIT" : "MALFORMED",
        [{
          path: "$.toolCalls[].arguments",
          code: argumentsExceededPortableBudget ? "BYTE_LIMIT" : "INVALID_VALUE",
          observedType: "object",
        }],
        argumentTexts,
      );
    }
    if (totalArgumentBytes > argumentTextLimit) {
      return failure("ARGUMENTS_BUDGET_EXCEEDED", "OUTPUT_LIMIT", [{
        path: "$.toolCalls", code: "BYTE_LIMIT", observedType: "array",
      }], argumentTexts);
    }
    const callCandidate = { id: callRecord.id, name: callRecord.name, arguments: boundedArguments };
    const parsedCall = harnessToolCallSchema.safeParse(callCandidate);
    if (!parsedCall.success) {
      return failure(
        "CALL_SCHEMA_INVALID",
        "MALFORMED",
        normalizedCallSchemaIssues(parsedCall.error.issues, callCandidate),
        argumentTexts,
      );
    }
    calls.push(parsedCall.data);
  }
  checkpoints.argumentsStringsWithinLimit = true;
  checkpoints.argumentsJsonParsed = true;
  checkpoints.argumentsWithinLimit = true;
  checkpoints.callSchemaValid = true;
  const messageCandidate = { role: "assistant" as const, content: record.messageContent as string };
  const parsedMessage = harnessProviderMessageSchema.safeParse(messageCandidate);
  if (!parsedMessage.success) {
    return failure(
      "MESSAGE_SCHEMA_INVALID",
      "MALFORMED",
      normalizedMessageSchemaIssues(parsedMessage.error.issues, record.messageContent),
      argumentTexts,
    );
  }
  checkpoints.messageSchemaValid = true;
  const hasToolCalls = record.hasToolCalls as boolean;
  const stopReason = record.stopReason as HarnessProviderTurn["stopReason"];
  if (!(stopReason === "tool_calls" || stopReason === "completed" || stopReason === "blocked")) {
    return failure("TURN_SCHEMA_INVALID", "MALFORMED", [{
      path: "$.stopReason", code: "INVALID_VALUE", observedType: "string",
    }], argumentTexts);
  }
  if (hasToolCalls !== (calls.length > 0)) {
    return failure("TURN_SCHEMA_INVALID", "MALFORMED", [{ path: "$.hasToolCalls", code: "MISMATCH", observedType: "boolean" }], argumentTexts);
  }
  const ids = new Set<string>();
  for (const call of calls) {
    if (ids.has(call.id)) {
      return failure("DUPLICATE_CALL_ID", "MALFORMED", [{ path: "$.toolCalls[].id", code: "DUPLICATE", observedType: "string" }], argumentTexts);
    }
    ids.add(call.id);
  }
  checkpoints.callIdsUnique = true;
  if (context?.allowParallelToolCalls === false && calls.length > 1) {
    return failure("PARALLEL_CALL_COUNT", "MALFORMED", [{ path: "$.toolCalls", code: "COUNT", observedType: "array" }], argumentTexts);
  }
  checkpoints.parallelPolicyValid = true;
  const required = requiredToolName(request, context);
  if (required !== undefined) {
    if (calls.length === 0) {
      return failure("REQUIRED_TOOL_MISSING", "MALFORMED", [{ path: "$.toolCalls", code: "MISSING_FIELD", observedType: "array" }], argumentTexts);
    }
    if (calls.length !== 1 || calls[0]?.name !== required) {
      return failure("REQUIRED_TOOL_NAME_MISMATCH", "MALFORMED", [{ path: "$.toolCalls[].name", code: "MISMATCH", observedType: "string" }], argumentTexts);
    }
    if (stopReason !== "tool_calls") {
      return failure("REQUIRED_TOOL_STOP_MISMATCH", "MALFORMED", [{ path: "$.stopReason", code: "MISMATCH", observedType: "string" }], argumentTexts);
    }
  }
  checkpoints.requiredToolValid = true;
  if ((calls.length > 0) !== (stopReason === "tool_calls")) {
    return failure("TURN_SCHEMA_INVALID", "MALFORMED", [{ path: "$.stopReason", code: "MISMATCH", observedType: "string" }], argumentTexts);
  }
  checkpoints.stopReasonValid = true;
  const allowed = new Set(request.tools.map((tool) => tool.name));
  if (calls.some((call) => !allowed.has(call.name))) {
    return failure("UNSUPPORTED_TOOL", "MALFORMED", [{ path: "$.toolCalls[].name", code: "NOT_ALLOWED", observedType: "string" }], argumentTexts);
  }
  checkpoints.toolNamesAllowed = true;
  const turnCandidate = { message: parsedMessage.data, toolCalls: calls, stopReason };
  const parsedTurn = harnessProviderTurnSchema.safeParse(turnCandidate);
  if (!parsedTurn.success) {
    return failure(
      "TURN_SCHEMA_INVALID",
      "MALFORMED",
      normalizedTurnSchemaIssues(parsedTurn.error.issues, turnCandidate),
      argumentTexts,
    );
  }
  checkpoints.turnSchemaValid = true;
  return parsedTurn.data;
};

interface ProcessResult { readonly stdout: string; readonly stderr: string; readonly code: number | null; }

interface CliLauncher { readonly command: string; readonly prefixArgs: readonly string[]; }

/**
 * Windows npm installs Codex as a .cmd shim.  Never start that shim through a
 * shell: resolve its official JavaScript launcher and run it with Node instead.
 */
const resolveCodexLauncher = async (options: PreparedOptions): Promise<CliLauncher> => {
  if (options.executablePath !== undefined || options.environment.EVLEDA_CODEX_CLI?.trim()) {
    return { command: await resolveCliExecutable("codex", options.environment, options.executablePath), prefixArgs: [] };
  }
  if (process.platform === "win32") {
    const directories = [...pathEntries(options.environment), options.environment.APPDATA ? path.join(options.environment.APPDATA, "npm") : ""]
      .filter(Boolean);
    for (const directory of directories) {
      const wrapper = path.join(directory, "node_modules", "@openai", "codex", "bin", "codex.js");
      if (await isFile(wrapper)) return { command: process.execPath, prefixArgs: [wrapper] };
    }
  }
  return { command: await resolveCliExecutable("codex", options.environment), prefixArgs: [] };
};

const waitForChildClose = (child: CliProcess): Promise<void> => new Promise((resolve) => {
  child.once("close", () => resolve());
});

const waitBounded = async (completion: Promise<void>, timeoutMs: number): Promise<boolean> => {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = await Promise.race([
    completion.then(() => false),
    new Promise<true>((resolve) => { timer = setTimeout(() => resolve(true), timeoutMs); }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return !timedOut;
};

const processGroupIsGone = (pid: number): boolean => {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
};

const waitForProcessGroupExit = async (pid: number, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (!processGroupIsGone(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return true;
};

const terminate = async (
  child: CliProcess,
  closed: Promise<void>,
  windowsProcessTreeTermination: BoundedWindowsProcessTreeTermination | undefined,
  rootExitObserved: () => boolean,
): Promise<void> => {
  const candidatePid = child.pid;
  const pid = candidatePid !== undefined && Number.isSafeInteger(candidatePid) && candidatePid > 0
    ? candidatePid
    : undefined;
  if (process.platform === "win32" && pid !== undefined) {
    // /T /F is the first termination operation while the root PID is still
    // actionable. Signalling the wrapper first can orphan its descendants
    // before taskkill binds the Windows process tree.
    const treeTerminated = await runBoundedWindowsProcessTreeTermination(
      pid,
      windowsProcessTreeTermination,
      rootExitObserved,
      CLI_PROVIDER_TREE_KILL_TIMEOUT_MS,
    );
    try { child.kill("SIGKILL"); } catch { /* process may already have exited */ }
    const rootClosed = await waitBounded(closed, CLI_PROVIDER_TREE_KILL_TIMEOUT_MS);
    if (!treeTerminated || !rootClosed) {
      throw new HarnessProviderError("CLI provider process-tree termination could not be confirmed", "INCOMPLETE");
    }
    return;
  }

  if (pid !== undefined) {
    try { process.kill(-pid, "SIGTERM"); } catch { /* group may already have exited */ }
  }
  try { child.kill("SIGTERM"); } catch { /* process may already have exited */ }
  await waitBounded(closed, CLI_PROVIDER_TERM_GRACE_MS);
  if (pid !== undefined) {
    // Always kill and verify the group, even when the wrapper/root closed during
    // TERM grace; root close alone says nothing about surviving descendants.
    try { process.kill(-pid, "SIGKILL"); } catch { /* group may already have exited */ }
  }
  try { child.kill("SIGKILL"); } catch { /* process may already have exited */ }
  const [rootClosed, groupGone] = await Promise.all([
    waitBounded(closed, CLI_PROVIDER_TREE_KILL_TIMEOUT_MS),
    pid === undefined
      ? Promise.resolve(false)
      : waitForProcessGroupExit(pid, CLI_PROVIDER_TREE_KILL_TIMEOUT_MS),
  ]);
  if (!rootClosed || !groupGone) {
    throw new HarnessProviderError("CLI provider process-tree termination could not be confirmed", "INCOMPLETE");
  }
};

const detachCliProcess = (child: CliProcess): void => {
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    stream.removeAllListeners("data");
    stream.removeAllListeners("error");
    stream.on("error", () => undefined);
    const destroy = (stream as NodeJS.ReadableStream & { readonly destroy?: () => void }).destroy;
    try { destroy?.call(stream); } catch { /* teardown must remain closed and bounded */ }
  }
  try { child.unref?.(); } catch { /* teardown must remain closed and bounded */ }
};

const runProcess = async (
  options: PreparedOptions,
  command: string,
  args: readonly string[],
  cwd: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<ProcessResult> => await new Promise<ProcessResult>((resolve, reject) => {
  let child: CliProcess;
  try {
    child = options.spawn(command, args, {
      cwd,
      env: options.childEnvironment,
      detached: process.platform !== "win32",
      stdio: "pipe",
      windowsHide: true,
    });
  } catch {
    reject(new HarnessProviderError(
      "CLI provider process could not be started",
      "HTTP",
      undefined,
      cliDiagnostic(options.cli, "PROVIDER_REQUEST_FAILED", "cli_spawn", "spawn_failed"),
    ));
    return;
  }
  const closed = waitForChildClose(child);
  let rootExitObserved = false;
  child.once("exit", () => { rootExitObserved = true; });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let settled = false;
  let terminating = false;
  const finish = (callback: () => void): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    callback();
  };
  const fail = (error: Error, rootIdentityGone = rootExitObserved): void => {
    if (settled || terminating) return;
    terminating = true;
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    if (rootIdentityGone) {
      void waitBounded(closed, CLI_PROVIDER_TREE_KILL_TIMEOUT_MS).then(() => {
        detachCliProcess(child);
        finish(() => reject(new CliTerminationUnconfirmedError(options.cli)));
      });
      return;
    }
    const termination = options.testHooks.terminateProcessForTesting === undefined
      ? terminate(
          child,
          closed,
          options.windowsProcessTreeTermination,
          () => rootExitObserved,
        )
      : options.testHooks.terminateProcessForTesting(child, closed);
    void termination.then(
      () => {
        detachCliProcess(child);
        finish(() => reject(error));
      },
      () => {
        detachCliProcess(child);
        finish(() => reject(new CliTerminationUnconfirmedError(options.cli)));
      },
    );
  };
  const collect = (target: "stdout" | "stderr", chunk: unknown): void => {
    if (settled || terminating) return;
    const data = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk), "utf8");
    const current = target === "stdout" ? stdoutBytes : stderrBytes;
    if (current + data.byteLength > options.maxOutputBytes) {
      fail(new HarnessProviderError(
        "CLI provider process output exceeds the byte limit",
        "OUTPUT_LIMIT",
        undefined,
        cliDiagnostic(options.cli, "PROVIDER_RESPONSE_INVALID", "cli_process_output", "byte_limit"),
      ));
      return;
    }
    if (target === "stdout") {
      stdoutBytes += data.byteLength;
      stdoutChunks.push(data);
    } else {
      stderrBytes += data.byteLength;
      stderrChunks.push(data);
    }
  };
  const abort = (): void => fail(signal?.reason instanceof Error
    ? signal.reason
    : new HarnessProviderError(
        "CLI provider request was cancelled",
        "INCOMPLETE",
        undefined,
        cliDiagnostic(options.cli, "PROVIDER_CANCELLED", "cli_process", "cancelled"),
      ));
  const timeout = setTimeout(() => fail(new HarnessProviderError(
    "CLI provider timed out",
    "INCOMPLETE",
    undefined,
    cliDiagnostic(options.cli, "PROVIDER_DEADLINE_EXCEEDED", "cli_process", "deadline"),
  )), options.timeoutMs);
  child.stdout.on("data", (chunk: unknown) => collect("stdout", chunk));
  child.stderr.on("data", (chunk: unknown) => collect("stderr", chunk));
  // Stream errors are asynchronous EventEmitter events; try/catch around end()
  // cannot catch an EPIPE from a child that exits while the prompt is written.
  const streamFailure = (): void => fail(new HarnessProviderError(
    "CLI provider process stream failed",
    "HTTP",
    undefined,
    cliDiagnostic(options.cli, "PROVIDER_REQUEST_FAILED", "cli_process_stream", "stream_error"),
  ));
  child.stdin.once("error", streamFailure);
  child.stdout.once("error", streamFailure);
  child.stderr.once("error", streamFailure);
  child.once("error", () => streamFailure());
  child.once("close", (code) => {
    if (terminating) return;
    // A signal-only/root-without-exit-code close must cross whole-tree
    // confirmation before any buffered-output decoding or error classification.
    if (code === null) {
      fail(new HarnessProviderError(
        "CLI provider process terminated without an exit code",
        "HTTP",
        undefined,
        cliDiagnostic(options.cli, "PROVIDER_PROCESS_EXIT", "cli_process_exit", "signal"),
      ), true);
      return;
    }
    let stdout: string;
    let stderr: string;
    try {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      stdout = decoder.decode(Buffer.concat(stdoutChunks, stdoutBytes));
      stderr = decoder.decode(Buffer.concat(stderrChunks, stderrBytes));
    } catch {
      finish(() => reject(new HarnessProviderError(
        "CLI provider process output is not valid UTF-8",
        "MALFORMED",
        undefined,
        cliDiagnostic(options.cli, "PROVIDER_RESPONSE_INVALID", "cli_process_output", "invalid_utf8"),
      )));
      return;
    }
    finish(() => resolve({ stdout, stderr, code }));
  });
  if (signal?.aborted === true) { abort(); return; }
  signal?.addEventListener("abort", abort, { once: true });
  try { child.stdin.end(prompt, "utf8"); } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
});

const unauthenticated = (value: string): boolean => /(?:not logged in|not authenticated|authentication (?:is )?required|please (?:run )?(?:\/login|login)|unauthorized)/iu.test(value);

abstract class BaseCliHarnessProvider implements HarnessProvider {
  abstract readonly provider: CliName;
  protected readonly options: PreparedOptions;
  #poisoned: HarnessProviderError | undefined;
  protected constructor(options: CliHarnessProviderOptions, cli: CliName) { this.options = prepare(options, cli); }
  protected async isolatedDirectory(): Promise<string> { return await mkdtemp(path.join(this.options.temporaryDirectory, "evleda-harness-provider-")); }
  protected poison(error: HarnessProviderError): void { this.#poisoned ??= error; }
  protected async cleanup(
    directory: string,
    operationFailed: boolean,
    failureFactory?: (outcome: "failed" | "timed_out") => HarnessProviderError,
  ): Promise<"completed" | "failed" | "timed_out"> {
    let cleanupOperation: Promise<void>;
    try {
      cleanupOperation = Promise.resolve(this.options.testHooks.beforeCleanup?.()).then(async () => {
        await rm(directory, { recursive: true, force: true });
      });
    } catch {
      cleanupOperation = Promise.reject(new Error("cleanup setup failed"));
    }
    void cleanupOperation.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      cleanupOperation.then(() => "completed" as const, () => "failed" as const),
      new Promise<"timed_out">((resolve) => {
        timer = setTimeout(() => resolve("timed_out"), CLI_PROVIDER_CLEANUP_TIMEOUT_MS);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (outcome === "completed") return outcome;
    const error = failureFactory?.(outcome) ?? new HarnessProviderError(
      `${this.provider === "codex" ? "Codex" : "Claude"} CLI temporary output cleanup ${outcome === "timed_out" ? "could not be confirmed" : "failed"}`,
      outcome === "timed_out" ? "INCOMPLETE" : "MALFORMED",
      undefined,
      cliDiagnostic(
        this.provider,
        outcome === "timed_out" ? "PROVIDER_REQUEST_FAILED" : "PROVIDER_RESPONSE_INVALID",
        "cli_temporary_output",
        outcome === "timed_out" ? "cleanup_unconfirmed" : "cleanup_failed",
      ),
    );
    this.poison(error);
    if (outcome === "failed") {
      // A test hook or transient remover can fail before deletion begins. Retry
      // the actual removal once in the background; poisoning remains permanent.
      void rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
    if (!operationFailed) throw error;
    return outcome;
  }
  protected async boundedTurn<Value>(
    perTurnSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<Value>,
    timeoutMs: number,
  ): Promise<Value> {
    if (this.#poisoned !== undefined) throw this.#poisoned;
    const configured = turnSignal(this.options.signal, perTurnSignal);
    configured?.throwIfAborted();
    const controller = new AbortController();
    const abort = (): void => {
      const reason = new HarnessProviderError(
        "CLI provider request was cancelled",
        "INCOMPLETE",
        undefined,
        cliDiagnostic(this.provider, "PROVIDER_CANCELLED", "cli_turn", "caller_cancelled"),
      );
      if (!controller.signal.aborted) controller.abort(reason);
    };
    configured?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      if (!controller.signal.aborted) {
        controller.abort(new HarnessProviderError(
          "CLI provider timed out",
          "INCOMPLETE",
          undefined,
          cliDiagnostic(this.provider, "PROVIDER_DEADLINE_EXCEEDED", "cli_turn", "deadline"),
        ));
      }
    }, timeoutMs);
    try {
      const result = await operation(controller.signal);
      controller.signal.throwIfAborted();
      return result;
    } catch (error) {
      if (error instanceof CliTerminationUnconfirmedError) throw error;
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
      configured?.removeEventListener("abort", abort);
      controller.abort();
    }
  }
  abstract turn(request: HarnessProviderRequest, context?: HarnessProviderTurnContext): Promise<HarnessProviderTurn>;
}

export class CodexCliHarnessProvider extends BaseCliHarnessProvider {
  readonly provider = "codex" as const;
  constructor(options: CodexCliHarnessProviderOptions) { super(options, "codex"); }
  async turn(request: HarnessProviderRequest, context?: HarnessProviderTurnContext): Promise<HarnessProviderTurn> {
    return await this.boundedTurn(context?.signal, async (signal) => {
    signal.throwIfAborted();
    const prompt = frameRequest(request, this.options.maxOutputBytes, context, "codex-explicit-envelope");
    const outputSchema = createCodexTurnOutputSchema(request, context);
    const transportSchemaIdentity = canonicalIdentity(
      outputSchema,
      CODEX_CLI_TURN_ENVELOPE_SCHEMA_VERSION,
    );
    const cwd = await this.isolatedDirectory();
    signal.throwIfAborted();
    let operationFailed = true;
    let retainTemporaryDirectory = false;
    let primaryError: unknown;
    const schemaPath = path.join(cwd, "harness-provider-turn.schema.json");
    const lastMessagePath = path.join(cwd, "harness-provider-last-message.json");
    try {
      await writeFile(schemaPath, JSON.stringify(outputSchema), "utf8");
      signal?.throwIfAborted();
      const launcher = await resolveCodexLauncher(this.options);
      signal.throwIfAborted();
      if (this.options.testHooks.beforeExecutableValidation !== undefined) {
        await waitWithSignal(Promise.resolve(this.options.testHooks.beforeExecutableValidation()), signal);
      }
      signal.throwIfAborted();
      await assertPinnedExecutable(launcher.command, this.options.expectedExecutableIdentity, signal);
      signal.throwIfAborted();
      const result = await runProcess(this.options, launcher.command, [...launcher.prefixArgs,
        "exec", ...CODEX_CLI_ISOLATION_ARGUMENTS,
        "--model", this.options.model,
        "--output-schema", schemaPath, "--output-last-message", lastMessagePath, "-",
      ], cwd, prompt, signal);
      signal.throwIfAborted();
      await assertPinnedExecutable(launcher.command, this.options.expectedExecutableIdentity, signal);
      signal.throwIfAborted();
      if (result.code !== 0) {
        if (unauthenticated(`${result.stdout}\n${result.stderr}`)) throw new HarnessProviderError(
          "Codex CLI authentication is unavailable",
          "AUTH",
          undefined,
          cliDiagnostic("codex", "PROVIDER_AUTH_UNAVAILABLE", "cli_process_exit", "authentication"),
        );
        throw new HarnessProviderError(
          "Codex CLI request failed",
          "HTTP",
          undefined,
          cliDiagnostic("codex", "PROVIDER_PROCESS_EXIT", "cli_process_exit", result.code === null ? "signal" : "nonzero"),
        );
      }
      let finalMessage: string;
      try {
        if (this.options.testHooks.beforeOutputRead !== undefined) {
          await waitWithSignal(Promise.resolve(this.options.testHooks.beforeOutputRead()), signal);
        }
        signal.throwIfAborted();
        finalMessage = await readBoundedFile(lastMessagePath, this.options.maxOutputBytes, signal);
        signal.throwIfAborted();
      }
      catch (error) {
        if (error instanceof HarnessProviderError && error.diagnostic !== undefined) throw error;
        const checkpoints = providerFailureCheckpoints();
        throw codexFailure(
          error instanceof HarnessProviderError && error.code === "OUTPUT_LIMIT"
            ? "OUTER_BUDGET_EXCEEDED"
            : "OUTER_SHAPE_INVALID",
          error instanceof HarnessProviderError && error.code === "OUTPUT_LIMIT" ? "OUTPUT_LIMIT" : "MALFORMED",
          {
            transportSchemaIdentity,
            checkpoints,
            issues: [{
              path: "$",
              code: error instanceof HarnessProviderError && error.code === "OUTPUT_LIMIT" ? "BYTE_LIMIT" : "SCHEMA",
              observedType: "unknown",
            }],
          },
        );
      }
      const turn = parseCodexTurnEnvelope(
        finalMessage,
        request,
        this.options.maxOutputBytes,
        transportSchemaIdentity,
        context,
      );
      operationFailed = false;
      return turn;
    } catch (error) {
      primaryError = error;
      if (error instanceof CliTerminationUnconfirmedError) {
        retainTemporaryDirectory = true;
        this.poison(error);
      }
      throw error;
    } finally {
      if (!retainTemporaryDirectory) {
        const cleanupOutcome = await this.cleanup(cwd, operationFailed, (outcome) => {
          const checkpoints = primaryError instanceof HarnessProviderError
            && primaryError.providerFailureEvidence !== undefined
            ? { ...primaryError.providerFailureEvidence.checkpoints }
            : providerFailureCheckpoints();
          if (!operationFailed) {
            for (const key of Object.keys(checkpoints) as Array<keyof ProviderFailureCheckpoints>) {
              checkpoints[key] = true;
            }
          }
          checkpoints.cleanupCompleted = false;
          return codexFailure(
            "CLEANUP_SECONDARY",
            outcome === "timed_out" ? "INCOMPLETE" : "MALFORMED",
            {
              transportSchemaIdentity,
              checkpoints,
              issues: [{ path: "$", code: "SECONDARY", observedType: "unknown" }],
            },
          );
        });
        if (cleanupOutcome === "completed"
          && primaryError instanceof HarnessProviderError
          && primaryError.providerFailureEvidence !== undefined) {
          throw providerFailureAfterCompletedCleanup(primaryError);
        }
      }
    }
    }, turnTimeoutMs(this.options.timeoutMs, context));
  }
}

export class ClaudeCliHarnessProvider extends BaseCliHarnessProvider {
  readonly provider = "claude-cli" as const;
  constructor(options: ClaudeCliHarnessProviderOptions) { super(options, "claude-cli"); }
  async turn(request: HarnessProviderRequest, context?: HarnessProviderTurnContext): Promise<HarnessProviderTurn> {
    return await this.boundedTurn(context?.signal, async (signal) => {
    signal.throwIfAborted();
    const prompt = frameRequest(request, this.options.maxOutputBytes, context);
    const outputSchema = createCliTurnOutputSchema(request, context);
    const cwd = await this.isolatedDirectory();
    signal.throwIfAborted();
    let operationFailed = true;
    let retainTemporaryDirectory = false;
    try {
      signal?.throwIfAborted();
      const executable = await resolveCliExecutable("claude-cli", this.options.environment, this.options.executablePath);
      signal.throwIfAborted();
      if (this.options.testHooks.beforeExecutableValidation !== undefined) {
        await waitWithSignal(Promise.resolve(this.options.testHooks.beforeExecutableValidation()), signal);
      }
      signal.throwIfAborted();
      await assertPinnedExecutable(executable, this.options.expectedExecutableIdentity, signal);
      signal.throwIfAborted();
      const result = await runProcess(this.options, executable, [
        "--print", "--output-format", "json", "--json-schema", JSON.stringify(outputSchema),
        "--tools", "", "--model", this.options.model, "--no-session-persistence",
      ], cwd, prompt, signal);
      signal.throwIfAborted();
      await assertPinnedExecutable(executable, this.options.expectedExecutableIdentity, signal);
      signal.throwIfAborted();
      if (result.code !== 0) {
        if (unauthenticated(`${result.stdout}\n${result.stderr}`)) throw new HarnessProviderError(
          "Claude CLI authentication is unavailable",
          "AUTH",
          undefined,
          cliDiagnostic("claude-cli", "PROVIDER_AUTH_UNAVAILABLE", "cli_process_exit", "authentication"),
        );
        throw new HarnessProviderError(
          "Claude Code CLI request failed",
          "HTTP",
          undefined,
          cliDiagnostic("claude-cli", "PROVIDER_PROCESS_EXIT", "cli_process_exit", result.code === null ? "signal" : "nonzero"),
        );
      }
      if (this.options.testHooks.beforeOutputRead !== undefined) {
        await waitWithSignal(Promise.resolve(this.options.testHooks.beforeOutputRead()), signal);
      }
      signal.throwIfAborted();
      const envelope = parseStrictJson(result.stdout);
      if (envelope === null || Array.isArray(envelope) || typeof envelope !== "object") throw new HarnessProviderError("Claude Code returned a malformed result envelope", "MALFORMED");
      const record = envelope as Record<string, unknown>;
      if (record.is_error === true) {
        if (unauthenticated(`${result.stdout}\n${result.stderr}`)) throw new HarnessProviderError(
          "Claude CLI authentication is unavailable",
          "AUTH",
          undefined,
          cliDiagnostic("claude-cli", "PROVIDER_AUTH_UNAVAILABLE", "cli_result_envelope", "authentication"),
        );
        throw new HarnessProviderError(
          "Claude Code CLI request failed",
          "HTTP",
          undefined,
          cliDiagnostic("claude-cli", "PROVIDER_PROCESS_EXIT", "cli_result_envelope", "reported_error"),
        );
      }
      const structured = record.structured_output;
      const output = structured === undefined ? (typeof record.result === "string" ? parseStrictJson(record.result) : undefined) : structured;
      if (output === undefined) throw new HarnessProviderError("Claude Code result contains no structured output", "MALFORMED");
      const turn = validateTurn(output, request, this.options.maxOutputBytes, context);
      operationFailed = false;
      return turn;
    } catch (error) {
      if (error instanceof CliTerminationUnconfirmedError) {
        retainTemporaryDirectory = true;
        this.poison(error);
      }
      if (error instanceof HarnessProviderError && error.diagnostic === undefined) {
        throw new HarnessProviderError(
          "Claude CLI returned invalid structured output",
          error.code,
          error.status,
          cliDiagnostic("claude-cli", "PROVIDER_RESPONSE_INVALID", "cli_turn_output", "invalid"),
        );
      }
      throw error;
    } finally {
      if (!retainTemporaryDirectory) {
        await this.cleanup(cwd, operationFailed);
      }
    }
    }, turnTimeoutMs(this.options.timeoutMs, context));
  }
}

export const createCodexCliHarnessProvider = (options: CodexCliHarnessProviderOptions): HarnessProvider => new CodexCliHarnessProvider(options);
export const createClaudeCliHarnessProvider = (options: ClaudeCliHarnessProviderOptions): HarnessProvider => new ClaudeCliHarnessProvider(options);
