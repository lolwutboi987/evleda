import { z } from "zod";

import { canonicalIdentity, canonicalJson } from "../core/canonical.js";
import { parsePcbLibrarySourceSelection, assertPcbLibraryBindingSourceKinds, assertPcbLibrarySourcesCurrent } from "./pcb-library-source-binding.js";
import {
  createFluxDiagnostic,
  parseFluxDiagnostic,
  assertProviderFailureEvidenceMatchesDiagnostic,
  parseProviderFailureEvidence,
  type FluxDiagnosticDto,
  type ProviderFailureEvidenceV1,
} from "../domain/diagnostics.js";
import {
  harnessProviderTurnSchema,
  type HarnessProviderMessage,
  type HarnessProviderTurn,
  type HarnessToolDefinition
} from "./contracts.js";
import {
  compilePcbDesignIntentDraft,
  createPcbAcceptancePlan,
  deriveDeepRuleFeaturesFromContract,
  PCB_ACCEPTANCE_PLAN_SCHEMA_VERSION,
  PCB_DEEP_RULE_BINDING_SCHEMA_VERSION,
  type PcbDesignCompilation,
  type PcbDesignCompilerOptions,
  PCB_DESIGN_COMPILATION_LIMITS,
  PCB_DESIGN_COMPILATION_SCHEMA_VERSION,
  PCB_LIBRARY_BINDING_SCHEMA_VERSION
} from "./pcb-design-compiler.js";
import {
  PCB_DESIGN_CANONICALIZATION_VERSION,
  PCB_DESIGN_CONTRACT_SCHEMA_VERSION,
  PCB_DESIGN_CONTRACT_LIMITS,
  PCB_DESIGN_INTENT_DRAFT_SCHEMA_VERSION,
  PcbDesignContractError,
  PcbDesignJsonSnapshotError,
  isPcbDesignStablePath,
  parsePcbDesignIntentDraft,
  pcbDesignContractSchema,
  pcbDesignIntentDraftSchema,
  pcbDesignStablePathSchema,
  snapshotPcbDesignJson,
  type PcbDesignIntentDraft
} from "./pcb-design-contract.js";
import {
  PCB_DESIGN_INTENT_MODEL_GUIDE,
  PCB_DESIGN_INTENT_MODEL_GUIDE_MAX_UTF8_BYTES,
  PCB_DESIGN_INTENT_MODEL_GUIDE_VERSION,
  PCB_DESIGN_INTENT_VALID_EXAMPLE,
} from "./pcb-design-intent-model-guide.js";
import { HarnessProviderError } from "./providers.js";
import { selectDeepRulesForDesign } from "./deep-rule-selector.js";
import {
  PcbDesignCompilationBundleError,
  createPcbDesignCompilationBundle,
  createPcbDesignCompilerProfile,
  parsePcbDesignCompilationBundle,
  serializePcbDesignCompilationBundle,
  type PcbDesignCompilationBundle
} from "./pcb-design-compilation-bundle.js";

export const PCB_DESIGN_INTERPRETER_SCHEMA_VERSION = "evleda.pcb-design-interpreter.v1" as const;
export const PCB_DESIGN_INTENT_TOOL_NAME = "submit_design_intent" as const;
export const PCB_PROVIDER_PROFILE_BINDING_SCHEMA_VERSION = "evleda.pcb-provider-profile-binding.v1" as const;
export const PCB_DESIGN_INTENT_REPAIR_SCHEMA_VERSION = "evleda.pcb-design-intent-repair.v1" as const;

export const PCB_DESIGN_INTENT_REPAIR_ISSUE_CODES = Object.freeze([
  "INVALID_TYPE",
  "INVALID_VALUE",
  "TOO_SMALL",
  "TOO_LARGE",
  "INVALID_FORMAT",
  "NOT_MULTIPLE_OF",
  "EXTRA_FIELD",
  "INVALID_UNION",
  "INVALID_KEY",
  "INVALID_ELEMENT",
  "RELATIONSHIP",
] as const);
export type PcbDesignIntentRepairIssueCode = (typeof PCB_DESIGN_INTENT_REPAIR_ISSUE_CODES)[number];

export const PCB_DESIGN_INTERPRETER_LIMITS = Object.freeze({
  maxUserPromptBytes: 32 * 1024,
  maxClarificationAnswers: 64,
  maxClarificationIdBytes: PCB_DESIGN_CONTRACT_LIMITS.maxNormalizedPathChars,
  maxClarificationAnswerBytes: 4 * 1024,
  maxPromptBytes: 64 * 1024,
  maxProviderRequestBytes: 128 * 1024,
  maxProviderOutputBytes: PCB_DESIGN_CONTRACT_LIMITS.maxPayloadBytes + 48 * 1024,
  maxProviderOutputDepth: 40,
  maxProviderOutputNodes: 120_000,
  maxProviderOutputArrayLength: 1_024,
  maxProviderOutputObjectKeys: 1_024,
  maxCompilationBytes: PCB_DESIGN_COMPILATION_LIMITS.maxPayloadBytes,
  maxCompilationDepth: 48,
  maxCompilationNodes: 500_000,
  maxCompilationArrayLength: PCB_DESIGN_COMPILATION_LIMITS.maxIssues,
  maxCompilationObjectKeys: 2_048,
  maxRepairIssues: PCB_DESIGN_CONTRACT_LIMITS.maxFormattedIssues,
  defaultTimeoutMs: 60_000,
  maximumTimeoutMs: 300_000,
  hardMaximumProviderOutputBytes: 1024 * 1024
});

export const PCB_DESIGN_INTERPRETER_ERROR_CODES = Object.freeze([
  "INVALID_INPUT",
  "PROMPT_TOO_LARGE",
  "OUTPUT_TOO_LARGE",
  "MALFORMED_PROVIDER_OUTPUT",
  "MISSING_TOOL_CALL",
  "MULTIPLE_TOOL_CALLS",
  "WRONG_TOOL",
  "INVALID_DRAFT",
  "REFUSED",
  "PROVIDER_FAILED",
  "COMPILER_FAILED",
  "COMPILATION_BUNDLE_FAILED",
  "TIMEOUT",
  "CANCELLED",
  "INVALID_COMPILATION",
] as const);
export type PcbDesignInterpreterErrorCode = (typeof PCB_DESIGN_INTERPRETER_ERROR_CODES)[number];

/**
 * Stable boundary errors intentionally do not echo prompts, provider text,
 * thrown provider messages, filesystem paths, or credentials.
 */
export class PcbDesignInterpreterError extends Error {
  public constructor(
    public readonly code: PcbDesignInterpreterErrorCode,
    message: string,
    diagnostic?: FluxDiagnosticDto,
    providerFailureEvidence?: ProviderFailureEvidenceV1,
  ) {
    super(message);
    this.name = "PcbDesignInterpreterError";
    this.diagnostic = diagnostic === undefined ? undefined : parseFluxDiagnostic(diagnostic);
    this.providerFailureEvidence = providerFailureEvidence === undefined
      ? undefined
      : parseProviderFailureEvidence(providerFailureEvidence);
    if (this.providerFailureEvidence !== undefined) {
      if (this.diagnostic === undefined) throw new Error("Provider failure evidence requires a public diagnostic");
      assertProviderFailureEvidenceMatchesDiagnostic(this.providerFailureEvidence, this.diagnostic);
    }
    Object.defineProperty(this, "providerFailureEvidence", {
      value: this.providerFailureEvidence,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  public readonly diagnostic: FluxDiagnosticDto | undefined;
  public readonly providerFailureEvidence: ProviderFailureEvidenceV1 | undefined;
}

/** Private provenance marker: external providers/compilers cannot mint one. */
class PcbDesignDeadlineBoundaryError extends PcbDesignInterpreterError {}

/** Private provenance marker for errors created by bounded JSON inspection. */
class PcbDesignSnapshotBoundaryError extends PcbDesignInterpreterError {}

export interface PcbIntentClarificationAnswer {
  /** Stable clarification ID returned by the host compiler. */
  readonly id: string;
  readonly answer: string;
}

export interface PcbDesignInterpretationInput {
  readonly prompt: string;
  /** All answers are supplied to one interpretation turn as a single batch. */
  readonly clarificationAnswers?: readonly PcbIntentClarificationAnswer[];
}

/**
 * Immutable host-supplied identity for the exact provider adapter and model.
 * It contains no credential, endpoint, executable path, or local filesystem data.
 */
export interface PcbProviderProfileBinding {
  readonly schemaVersion: typeof PCB_PROVIDER_PROFILE_BINDING_SCHEMA_VERSION;
  readonly provider: string;
  readonly model: string;
  readonly tier: PcbProviderCanonicalTier;
  readonly adapterSchemaVersion: string;
  readonly identity: ReturnType<typeof canonicalIdentity>;
}

export type PcbProviderCanonicalTier = "provider-default" | "standard" | "priority";

export interface PcbProviderProfileBindingInput {
  readonly provider: string;
  readonly model: string;
  /** Canonical bounded tier label, for example priority, standard, or provider-default. */
  readonly tier: PcbProviderCanonicalTier;
  readonly adapterSchemaVersion: string;
}

/** A validated compilation plus its complete ready-only execution artifact. */
export type PcbDesignInterpretationResult = PcbDesignCompilation & Readonly<{
  readonly bundle: PcbDesignCompilationBundle | null;
}>;

export interface PcbIntentRequiredToolChoice {
  readonly type: "required";
  readonly name: typeof PCB_DESIGN_INTENT_TOOL_NAME;
}

/**
 * Provider-neutral request. It is deliberately not the general editing
 * harness request: this boundary has exactly one structured extraction tool.
 */
export interface PcbIntentProviderRequest {
  readonly schemaVersion: typeof PCB_DESIGN_INTERPRETER_SCHEMA_VERSION;
  readonly messages: [HarnessProviderMessage, HarnessProviderMessage];
  readonly tools: [HarnessToolDefinition];
  readonly toolChoice: PcbIntentRequiredToolChoice;
  readonly allowParallelToolCalls: false;
  readonly maxOutputBytes: number;
}

export interface PcbIntentProviderContext {
  /** Aborted by either the caller or the interpreter's deadline. */
  readonly signal: AbortSignal;
  /** Remaining milliseconds in the interpreter's one global outer deadline. */
  readonly timeoutMs: number;
  readonly requiredToolName: typeof PCB_DESIGN_INTENT_TOOL_NAME;
  readonly allowParallelToolCalls: false;
}

/**
 * A provider adapter must normalize its native response to HarnessProviderTurn.
 * OpenAI Responses, Anthropic Messages, Codex CLI, and Claude CLI can therefore
 * share this boundary without exposing their native envelopes to the compiler.
 */
export interface PcbIntentProvider {
  readonly provider: "openai" | "anthropic" | "codex" | "claude-cli" | (string & {});
  turn(request: PcbIntentProviderRequest, context: PcbIntentProviderContext): Promise<unknown>;
}

export type PcbIntentCompiler = (
  draft: PcbDesignIntentDraft,
  options: PcbDesignCompilerOptions
) => PcbDesignCompilation;

export interface PcbDesignInterpreterDependencies {
  readonly provider: PcbIntentProvider;
  readonly compilerOptions: PcbDesignCompilerOptions;
  /** Injectable for isolated tests; production defaults to the host compiler. */
  readonly compiler?: PcbIntentCompiler;
}

export interface PcbDesignInterpreterOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxProviderOutputBytes?: number;
  /** Injectable monotonic clock for deterministic deadline tests. */
  readonly nowNanoseconds?: () => bigint;
}

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

const deepFreeze = <Value>(value: Value): Value => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const providerProfileSnapshot = (value: unknown, label: string): Readonly<Record<string, unknown>> => {
  let snapshot: unknown;
  try {
    snapshot = snapshotPcbDesignJson(value, {
      maxBytes: 4 * 1024,
      maxDepth: 4,
      maxNodes: 32,
      maxArrayLength: 0,
      maxObjectKeys: 8,
      rejectAliases: true
    }).value;
  } catch {
    throw new PcbDesignInterpreterError("INVALID_INPUT", `${label} must be bounded plain JSON data.`);
  }
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new PcbDesignInterpreterError("INVALID_INPUT", `${label} must be a structured object.`);
  }
  return snapshot as Readonly<Record<string, unknown>>;
};

const exactProfileKeys = (
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string
): void => {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(value, key))) {
    throw new PcbDesignInterpreterError("INVALID_INPUT", `${label} contains missing or unsupported fields.`);
  }
};

const profileSlug = (value: unknown, maximumBytes: number, label: string): string => {
  if (typeof value !== "string" || value.trim() !== value ||
      !/^[a-z0-9][a-z0-9._-]*$/u.test(value) || byteLength(value) > maximumBytes) {
    throw new PcbDesignInterpreterError("INVALID_INPUT", `${label} must be a bounded canonical identifier.`);
  }
  return value;
};

const profileModel = (value: unknown): string => {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 ||
      !value.isWellFormed() || /[\u0000-\u001f\u007f]/u.test(value) || byteLength(value) > 256) {
    throw new PcbDesignInterpreterError("INVALID_INPUT", "Provider profile model must be bounded canonical text.");
  }
  return value;
};

const profileTier = (value: unknown): PcbProviderCanonicalTier => {
  if (value !== "provider-default" && value !== "standard" && value !== "priority") {
    throw new PcbDesignInterpreterError("INVALID_INPUT", "Provider profile tier must be a supported canonical tier.");
  }
  return value;
};

const providerProfilePayload = (input: PcbProviderProfileBindingInput) => ({
  schemaVersion: PCB_PROVIDER_PROFILE_BINDING_SCHEMA_VERSION,
  provider: profileSlug(input.provider, 64, "Provider profile provider"),
  model: profileModel(input.model),
  tier: profileTier(input.tier),
  adapterSchemaVersion: profileSlug(input.adapterSchemaVersion, 192, "Provider adapter schema version")
});

/** Mint a canonical provider/model binding at the trusted host boundary. */
export const createPcbProviderProfileBinding = (
  value: PcbProviderProfileBindingInput
): PcbProviderProfileBinding => {
  const snapshot = providerProfileSnapshot(value, "Provider profile input");
  exactProfileKeys(snapshot, ["provider", "model", "tier", "adapterSchemaVersion"], "Provider profile input");
  const payload = providerProfilePayload(snapshot as unknown as PcbProviderProfileBindingInput);
  return deepFreeze({
    ...payload,
    identity: canonicalIdentity(payload, PCB_PROVIDER_PROFILE_BINDING_SCHEMA_VERSION)
  });
};

/** Revalidate a supplied provider/model binding without trusting its identity. */
export const parsePcbProviderProfileBinding = (value: unknown): PcbProviderProfileBinding => {
  const snapshot = providerProfileSnapshot(value, "Provider profile binding");
  exactProfileKeys(
    snapshot,
    ["schemaVersion", "provider", "model", "tier", "adapterSchemaVersion", "identity"],
    "Provider profile binding"
  );
  if (snapshot.schemaVersion !== PCB_PROVIDER_PROFILE_BINDING_SCHEMA_VERSION) {
    throw new PcbDesignInterpreterError("INVALID_INPUT", "Provider profile binding has an unsupported schema version.");
  }
  const expected = createPcbProviderProfileBinding({
    provider: snapshot.provider as string,
    model: snapshot.model as string,
    tier: snapshot.tier as PcbProviderCanonicalTier,
    adapterSchemaVersion: snapshot.adapterSchemaVersion as string
  });
  if (canonicalJson(snapshot) !== canonicalJson(expected)) {
    throw new PcbDesignInterpreterError("INVALID_INPUT", "Provider profile binding identity is invalid.");
  }
  return expected;
};

const draftJsonSchema = JSON.parse(JSON.stringify(
  z.toJSONSchema(pcbDesignIntentDraftSchema, { target: "draft-2020-12" })
)) as HarnessToolDefinition["inputSchema"];

/** Exact, detached schema advertised to every provider implementation. */
export const PCB_DESIGN_INTENT_TOOL: HarnessToolDefinition = deepFreeze({
  name: PCB_DESIGN_INTENT_TOOL_NAME,
  description:
    "Submit the complete bounded PCB design-intent draft. This records intent only; it cannot edit or approve a design.",
  inputSchema: draftJsonSchema
});

/** Smallest normalized exact-one call; below this no repair turn can be valid. */
export const PCB_DESIGN_INTENT_MINIMUM_REPAIR_OUTPUT_BYTES = byteLength(JSON.stringify({
  message: { role: "assistant", content: "" },
  toolCalls: [{ id: "x", name: PCB_DESIGN_INTENT_TOOL_NAME, arguments: {} }],
  stopReason: "tool_calls",
}));

if (byteLength(PCB_DESIGN_INTENT_MODEL_GUIDE) > PCB_DESIGN_INTENT_MODEL_GUIDE_MAX_UTF8_BYTES) {
  throw new Error("The bundled PCB design-intent model guide exceeds its declared byte limit.");
}

export const PCB_DESIGN_INTERPRETER_SYSTEM_PROMPT = [
  "You are a non-mutating PCB design-intent interpreter.",
  `Translate the user's request into exactly one ${PCB_DESIGN_INTENT_TOOL_NAME} tool call whose arguments are the complete ${PCB_DESIGN_INTENT_DRAFT_SCHEMA_VERSION} object.`,
  "The tool arguments are the draft itself; do not wrap them in another object.",
  "Do not return a prose-only answer, do not call the tool more than once, and do not request or perform editor actions.",
  "Use only facts stated by the user or safely explicit in the supplied clarification answers.",
  "Emit every required key for the selected schema branch. Preserve an unknown nullable decision as an explicit null; never omit its key.",
  "The host compiler automatically asks about null fields and unresolved pin assignments. unresolved is required and may be []; use it only for additional ambiguity not already represented by a null or unresolved pin assignment.",
  "Do not invent pin mappings, electrical limits, package choices, board dimensions, layer requirements, clearances, trace widths, via rules, placement constraints, or routing constraints.",
  "This interpretation stage has no filesystem, project, approval, editor, KiCad, network, shell, or manufacturing-output capability.",
  `Follow the complete versioned model guide ${PCB_DESIGN_INTENT_MODEL_GUIDE_VERSION}:`,
  PCB_DESIGN_INTENT_MODEL_GUIDE,
  "PARSER_VALID_NULL_PRESERVING_EXAMPLE_JSON:",
  JSON.stringify(PCB_DESIGN_INTENT_VALID_EXAMPLE),
].join("\n");

export interface PcbDesignIntentRepairIssue {
  readonly code: PcbDesignIntentRepairIssueCode;
  /** Stable domain-keyed field path; never a raw rejected value or message. */
  readonly path: string;
}

const repairIssueCode = (code: string): PcbDesignIntentRepairIssueCode => {
  switch (code) {
    case "invalid_type": return "INVALID_TYPE";
    case "invalid_value": return "INVALID_VALUE";
    case "too_small": return "TOO_SMALL";
    case "too_big": return "TOO_LARGE";
    case "invalid_format": return "INVALID_FORMAT";
    case "not_multiple_of": return "NOT_MULTIPLE_OF";
    case "unrecognized_keys": return "EXTRA_FIELD";
    case "invalid_union": return "INVALID_UNION";
    case "invalid_key": return "INVALID_KEY";
    case "invalid_element": return "INVALID_ELEMENT";
    default: return "RELATIONSHIP";
  }
};

const repairPathFields = new Set([
  "schemaVersion", "kind", "scope", "board", "sheetCount", "componentUnitPolicy", "shape", "widthMm",
  "heightMm", "layerCount", "copperLayers", "components", "reference", "symbolLibId", "value",
  "footprintLibId", "unit", "pins", "pin", "assignment", "nets", "net", "role", "endpoints",
  "electrical", "voltage", "minimumV", "nominalV", "maximumV", "current", "nominalA", "maximumContinuousA",
  "peakA", "peakDurationMs", "speed", "maximumFrequencyMHz", "minimumEdgeTimeNs", "netClassId", "netClasses",
  "id", "traceWidthMm", "clearanceMm", "copperToEdgeMm", "allowedLayers", "placementConstraints",
  "side", "regionMm", "minXmm", "maxXmm", "minYmm", "maxYmm", "allowedRotationsDeg",
  "minimumEdgeClearanceMm", "minimumCourtyardClearanceMm", "edgePreference", "routingConstraints",
  "cornerStyle", "maximumTurnAngleDeg", "minimumStraightBeforeTurnMm", "allowRightAngleCorners",
  "allowAcuteInteriorCorners", "allowBacktracking", "allowSelfIntersections", "viaPolicy", "mode", "maxTotal",
  "diameterMm", "drillMm", "minimumAnnularRingMm", "topology", "preferredLayer", "maxVias", "routeLength",
  "maximumMm", "unresolved", "path", "question",
]);

const appendKnownPathTail = (target: string[], path: readonly PropertyKey[], start: number): void => {
  for (let index = start; index < path.length; index += 1) {
    const segment = path[index];
    if (typeof segment === "string" && repairPathFields.has(segment)) target.push(segment);
  }
};

/** Convert private positional Zod paths into value-free domain-keyed field families. */
const repairIssuePath = (path: readonly PropertyKey[]): string => {
  if (path.length === 0) return "$";
  const segments: string[] = [];
  const collection = path[0];

  if (collection === "components" && typeof path[1] === "number") {
    segments.push("components", "*");
    if (path[2] === "pins" && typeof path[3] === "number") {
      segments.push("pins", "*");
      appendKnownPathTail(segments, path, 4);
    } else {
      appendKnownPathTail(segments, path, 2);
    }
  } else if (collection === "nets" && typeof path[1] === "number") {
    segments.push("nets", "*");
    if (path[2] === "endpoints" && typeof path[3] === "number") {
      segments.push("endpoints", "*");
      appendKnownPathTail(segments, path, 4);
    } else {
      appendKnownPathTail(segments, path, 2);
    }
  } else if (collection === "netClasses" && typeof path[1] === "number") {
    segments.push("netClasses", "*");
    appendKnownPathTail(segments, path, 2);
  } else if (collection === "placementConstraints" && typeof path[1] === "number") {
    segments.push("placementConstraints", "*");
    appendKnownPathTail(segments, path, 2);
  } else if (collection === "routingConstraints" && path[1] === "nets" && typeof path[2] === "number") {
    segments.push("routingConstraints", "nets", "*");
    appendKnownPathTail(segments, path, 3);
  } else if (collection === "unresolved" && typeof path[1] === "number") {
    segments.push("unresolved", "*");
    appendKnownPathTail(segments, path, 2);
  } else {
    appendKnownPathTail(segments, path, 0);
  }

  const candidate = segments.length === 0 ? "$" : segments.join(".");
  return candidate.length <= PCB_DESIGN_CONTRACT_LIMITS.maxNormalizedPathChars ? candidate : "$";
};

const repairIssuesFor = (error: PcbDesignContractError): readonly PcbDesignIntentRepairIssue[] => {
  const cause = error.cause;
  if (!(cause instanceof z.ZodError)) return Object.freeze([{ code: "RELATIONSHIP", path: "$" }]);
  const issues = cause.issues.slice(0, PCB_DESIGN_INTERPRETER_LIMITS.maxRepairIssues).map((entry) => Object.freeze({
    code: repairIssueCode(entry.code),
    path: repairIssuePath(entry.path),
  }));
  return Object.freeze(issues.length === 0 ? [{ code: "RELATIONSHIP", path: "$" }] : issues);
};

const normalizeClarifications = (
  answers: readonly PcbIntentClarificationAnswer[] | undefined
): readonly PcbIntentClarificationAnswer[] => {
  if (answers === undefined) return [];
  if (!Array.isArray(answers) || answers.length > PCB_DESIGN_INTERPRETER_LIMITS.maxClarificationAnswers) {
    throw new PcbDesignInterpreterError("INVALID_INPUT", "The clarification-answer batch is invalid or exceeds its item limit.");
  }
  const identifiers = new Set<string>();
  const normalized: PcbIntentClarificationAnswer[] = [];
  for (const entry of answers) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new PcbDesignInterpreterError("INVALID_INPUT", "Every clarification answer must be a structured entry.");
    }
    const keys = Reflect.ownKeys(entry);
    if (keys.length !== 2 || !keys.includes("id") || !keys.includes("answer")) {
      throw new PcbDesignInterpreterError("INVALID_INPUT", "Clarification-answer entries must contain only id and answer.");
    }
    const { id, answer } = entry;
    if (!isPcbDesignStablePath(id) ||
        byteLength(id) > PCB_DESIGN_INTERPRETER_LIMITS.maxClarificationIdBytes) {
      throw new PcbDesignInterpreterError("INVALID_INPUT", "A clarification answer has an invalid ID.");
    }
    if (typeof answer !== "string" || answer.trim().length === 0 ||
        byteLength(answer) > PCB_DESIGN_INTERPRETER_LIMITS.maxClarificationAnswerBytes || /\u0000/u.test(answer)) {
      throw new PcbDesignInterpreterError("INVALID_INPUT", "A clarification answer is empty, invalid, or exceeds its byte limit.");
    }
    if (identifiers.has(id)) {
      throw new PcbDesignInterpreterError("INVALID_INPUT", "The clarification-answer batch contains a duplicate ID.");
    }
    identifiers.add(id);
    normalized.push({ id, answer });
  }
  return normalized.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
};

const validateOutputLimit = (value: number | undefined): number => {
  const limit = value ?? PCB_DESIGN_INTERPRETER_LIMITS.maxProviderOutputBytes;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PCB_DESIGN_INTERPRETER_LIMITS.hardMaximumProviderOutputBytes) {
    throw new PcbDesignInterpreterError("INVALID_INPUT", "The provider-output byte limit is invalid.");
  }
  return limit;
};

const validateTimeout = (value: number | undefined): number => {
  const timeout = value ?? PCB_DESIGN_INTERPRETER_LIMITS.defaultTimeoutMs;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > PCB_DESIGN_INTERPRETER_LIMITS.maximumTimeoutMs) {
    throw new PcbDesignInterpreterError("INVALID_INPUT", "The interpretation timeout is invalid.");
  }
  return timeout;
};

/**
 * Capture interpretation input exactly once so the provider request and later
 * execution bundle bind the same detached original prompt.
 */
export interface PcbCapturedDesignInterpretationInput {
  readonly prompt: string;
  readonly clarificationAnswers: readonly PcbIntentClarificationAnswer[];
}

export const capturePcbDesignInterpretationInput = (
  input: PcbDesignInterpretationInput
): PcbCapturedDesignInterpretationInput => {
  let capturedInput: unknown;
  try {
    capturedInput = snapshotPcbDesignJson(input, {
      maxBytes: PCB_DESIGN_INTERPRETER_LIMITS.maxPromptBytes,
      maxDepth: 4,
      maxNodes: 512,
      maxArrayLength: PCB_DESIGN_INTERPRETER_LIMITS.maxClarificationAnswers,
      maxObjectKeys: 2,
      rejectAliases: true
    }).value;
  } catch (error) {
    if (error instanceof PcbDesignJsonSnapshotError && error.failure === "bytes") {
      throw new PcbDesignInterpreterError("PROMPT_TOO_LARGE", "The PCB design prompt and clarification batch exceed their combined byte limit.");
    }
    throw new PcbDesignInterpreterError("INVALID_INPUT", "PCB interpretation input must be bounded plain JSON data.");
  }
  if (capturedInput === null || typeof capturedInput !== "object" || Array.isArray(capturedInput)) {
    throw new PcbDesignInterpreterError("INVALID_INPUT", "PCB interpretation input must be a structured object.");
  }
  const keys = Reflect.ownKeys(capturedInput);
  if (keys.some((key) => key !== "prompt" && key !== "clarificationAnswers")) {
    throw new PcbDesignInterpreterError("INVALID_INPUT", "PCB interpretation input contains an unsupported field.");
  }
  const captured = capturedInput as unknown as PcbDesignInterpretationInput;
  if (typeof captured.prompt !== "string" || captured.prompt.trim().length === 0 || /\u0000/u.test(captured.prompt)) {
    throw new PcbDesignInterpreterError("INVALID_INPUT", "The PCB design prompt must be non-empty text without NUL characters.");
  }
  if (byteLength(captured.prompt) > PCB_DESIGN_INTERPRETER_LIMITS.maxUserPromptBytes) {
    throw new PcbDesignInterpreterError("PROMPT_TOO_LARGE", "The PCB design prompt exceeds its byte limit.");
  }
  const clarificationAnswers = normalizeClarifications(captured.clarificationAnswers);
  return deepFreeze({ prompt: captured.prompt, clarificationAnswers });
};

const createPcbIntentProviderRequestFromCaptured = (
  captured: PcbCapturedDesignInterpretationInput,
  outputLimit: number,
  repairIssues?: readonly PcbDesignIntentRepairIssue[],
): PcbIntentProviderRequest => {
  const userContent = JSON.stringify({ request: captured.prompt, clarificationAnswers: captured.clarificationAnswers });
  if (byteLength(userContent) > PCB_DESIGN_INTERPRETER_LIMITS.maxPromptBytes) {
    throw new PcbDesignInterpreterError("PROMPT_TOO_LARGE", "The PCB design prompt and clarification batch exceed their combined byte limit.");
  }
  const systemContent = repairIssues === undefined
    ? PCB_DESIGN_INTERPRETER_SYSTEM_PROMPT
    : [
        PCB_DESIGN_INTERPRETER_SYSTEM_PROMPT,
        `PCB DESIGN INTENT REPAIR ${PCB_DESIGN_INTENT_REPAIR_SCHEMA_VERSION}`,
        `Correct the previous invalid draft and return exactly one complete ${PCB_DESIGN_INTENT_TOOL_NAME} call. Re-read the repeated tool schema, model guide, and parser-valid example; preserve every user-stated fact and use null for unknown nullable fields.`,
        "REPAIR_VALIDATION_ISSUES_JSON:",
        JSON.stringify(repairIssues),
      ].join("\n");
  if (byteLength(systemContent) > PCB_DESIGN_INTERPRETER_LIMITS.maxPromptBytes) {
    throw new PcbDesignInterpreterError("PROMPT_TOO_LARGE", "The PCB design system request exceeds its byte limit.");
  }
  const request: PcbIntentProviderRequest = {
    schemaVersion: PCB_DESIGN_INTERPRETER_SCHEMA_VERSION,
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: userContent }
    ],
    tools: [structuredClone(PCB_DESIGN_INTENT_TOOL)],
    toolChoice: { type: "required", name: PCB_DESIGN_INTENT_TOOL_NAME },
    allowParallelToolCalls: false,
    maxOutputBytes: outputLimit
  };
  const serialized = JSON.stringify(request);
  if (byteLength(serialized) > PCB_DESIGN_INTERPRETER_LIMITS.maxProviderRequestBytes) {
    throw new PcbDesignInterpreterError("PROMPT_TOO_LARGE", "The structured PCB interpretation request exceeds its byte limit.");
  }
  return deepFreeze(request);
};

/**
 * Construct the complete provider-visible request deterministically. Compiler
 * dependencies remain outside this projection, so local paths and credentials
 * captured by host adapters cannot accidentally enter a model prompt.
 */
export const createPcbIntentProviderRequest = (
  input: PcbDesignInterpretationInput,
  maxProviderOutputBytes = PCB_DESIGN_INTERPRETER_LIMITS.maxProviderOutputBytes
): PcbIntentProviderRequest => createPcbIntentProviderRequestFromCaptured(
  capturePcbDesignInterpretationInput(input),
  validateOutputLimit(maxProviderOutputBytes)
);

interface BoundedSnapshotPolicy {
  readonly limit: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxArrayLength: number;
  readonly maxObjectKeys: number;
  readonly malformedCode: PcbDesignInterpreterErrorCode;
  readonly oversizedCode: PcbDesignInterpreterErrorCode;
  readonly label: string;
  readonly rejectAliases: boolean;
  readonly checkpoint: () => void;
}

/** Translate the shared one-view JSON capture into this boundary's redacted errors. */
const captureBoundedJson = (
  value: unknown,
  policy: BoundedSnapshotPolicy,
): ReturnType<typeof snapshotPcbDesignJson> => {
  const malformed = (message: string): PcbDesignSnapshotBoundaryError =>
    new PcbDesignSnapshotBoundaryError(policy.malformedCode, `${policy.label} ${message}`);
  const oversized = (message: string): PcbDesignSnapshotBoundaryError =>
    new PcbDesignSnapshotBoundaryError(policy.oversizedCode, `${policy.label} ${message}`);
  try {
    return snapshotPcbDesignJson(value, {
      maxBytes: policy.limit,
      maxDepth: policy.maxDepth,
      maxNodes: policy.maxNodes,
      maxArrayLength: policy.maxArrayLength,
      maxObjectKeys: policy.maxObjectKeys,
      rejectAliases: policy.rejectAliases,
      checkpoint: policy.checkpoint
    });
  } catch (error) {
    if (error instanceof PcbDesignDeadlineBoundaryError) throw error;
    if (error instanceof PcbDesignJsonSnapshotError && error.reason === "too_large") {
      throw oversized(error.failure === "bytes" ? "exceeds its byte limit." : "exceeds its structural limit.");
    }
    throw malformed("could not be inspected as bounded JSON.");
  }
};

const snapshotBoundedJson = (value: unknown, policy: BoundedSnapshotPolicy): unknown =>
  captureBoundedJson(value, policy).value;

/** Detach and bound provider data before Zod or the draft parser traverses it. */
const snapshotProviderOutput = (
  value: unknown,
  limit: number,
  checkpoint: () => void,
): ReturnType<typeof snapshotPcbDesignJson> => captureBoundedJson(value, {
    limit,
    maxDepth: PCB_DESIGN_INTERPRETER_LIMITS.maxProviderOutputDepth,
    maxNodes: PCB_DESIGN_INTERPRETER_LIMITS.maxProviderOutputNodes,
    maxArrayLength: PCB_DESIGN_INTERPRETER_LIMITS.maxProviderOutputArrayLength,
    maxObjectKeys: PCB_DESIGN_INTERPRETER_LIMITS.maxProviderOutputObjectKeys,
    malformedCode: "MALFORMED_PROVIDER_OUTPUT",
    oversizedCode: "OUTPUT_TOO_LARGE",
    label: "Provider output",
    rejectAliases: true,
    checkpoint
  });

interface CapturedPcbIntentProviderTurn {
  readonly turn: HarnessProviderTurn;
  readonly bytes: number;
}

const requireSingleDesignIntentCall = (
  value: unknown,
  limit: number,
  checkpoint: () => void
): CapturedPcbIntentProviderTurn => {
  const snapshot = snapshotProviderOutput(value, limit, checkpoint);
  checkpoint();
  const parsed = harnessProviderTurnSchema.safeParse(snapshot.value);
  checkpoint();
  if (!parsed.success) {
    throw new PcbDesignInterpreterError("MALFORMED_PROVIDER_OUTPUT", "Provider output does not match the normalized turn contract.");
  }
  if (parsed.data.stopReason === "blocked") {
    throw new PcbDesignInterpreterError("REFUSED", "The provider refused to interpret the PCB design request.");
  }
  if (parsed.data.stopReason !== "tool_calls" || parsed.data.toolCalls.length === 0) {
    throw new PcbDesignInterpreterError("MISSING_TOOL_CALL", `The provider did not call ${PCB_DESIGN_INTENT_TOOL_NAME}.`);
  }
  if (parsed.data.toolCalls.length !== 1) {
    throw new PcbDesignInterpreterError("MULTIPLE_TOOL_CALLS", `The provider must call ${PCB_DESIGN_INTENT_TOOL_NAME} exactly once.`);
  }
  if (parsed.data.toolCalls[0]!.name !== PCB_DESIGN_INTENT_TOOL_NAME) {
    throw new PcbDesignInterpreterError("WRONG_TOOL", `The provider called a tool other than ${PCB_DESIGN_INTENT_TOOL_NAME}.`);
  }
  return Object.freeze({ turn: parsed.data, bytes: snapshot.bytes });
};

interface ProviderDeadline {
  readonly signal: AbortSignal;
  readonly wait: <Value>(operation: Promise<Value>) => Promise<Value>;
  readonly checkpoint: () => void;
  readonly remainingMilliseconds: () => number;
  readonly dispose: () => void;
}

const createProviderDeadline = (
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
  suppliedClock: (() => bigint) | undefined
): ProviderDeadline => {
  const controller = new AbortController();
  let terminal: "cancelled" | "timeout" | null = null;
  const clock = suppliedClock ?? process.hrtime.bigint;
  let lastNanoseconds: bigint;
  try {
    lastNanoseconds = clock();
    if (typeof lastNanoseconds !== "bigint") throw new Error("not bigint");
  } catch {
    throw new PcbDesignInterpreterError("INVALID_INPUT", "The interpretation clock is invalid.");
  }
  const nowNanoseconds = (): bigint => {
    let current: bigint;
    try {
      current = clock();
      if (typeof current !== "bigint" || current < lastNanoseconds) throw new Error("not monotonic");
    } catch {
      throw new PcbDesignDeadlineBoundaryError("INVALID_INPUT", "The interpretation clock is invalid.");
    }
    lastNanoseconds = current;
    return current;
  };
  const deadlineNanoseconds = lastNanoseconds + BigInt(timeoutMs) * 1_000_000n;
  let rejectBoundary: ((error: PcbDesignInterpreterError) => void) | undefined;
  const boundary = new Promise<never>((_resolve, reject) => { rejectBoundary = reject; });
  // A synchronous deadline checkpoint may reject before wait() is attached.
  // Mark the promise handled while retaining it for the later race.
  void boundary.catch(() => undefined);
  const errorFor = (kind: "cancelled" | "timeout"): PcbDesignDeadlineBoundaryError => kind === "cancelled"
    ? new PcbDesignDeadlineBoundaryError(
        "CANCELLED",
        "PCB design interpretation was cancelled.",
        createFluxDiagnostic("PROVIDER_CANCELLED", { boundary: "pcb_design_interpretation", category: "caller_cancelled" }),
      )
    : new PcbDesignDeadlineBoundaryError(
        "TIMEOUT",
        "PCB design interpretation exceeded its deadline.",
        createFluxDiagnostic("PROVIDER_DEADLINE_EXCEEDED", { boundary: "pcb_design_interpretation", category: "deadline" }),
      );
  const transition = (kind: "cancelled" | "timeout"): void => {
    if (terminal !== null) return;
    terminal = kind;
    controller.abort();
    rejectBoundary!(errorFor(kind));
  };
  const cancel = (): void => transition("cancelled");
  const checkpoint = (): void => {
    if (terminal !== null) throw errorFor(terminal);
    if (callerSignal?.aborted === true) transition("cancelled");
    else if (nowNanoseconds() >= deadlineNanoseconds) transition("timeout");
    if (terminal !== null) throw errorFor(terminal);
  };
  const remainingMilliseconds = (): number => {
    checkpoint();
    const remainingNanoseconds = deadlineNanoseconds - lastNanoseconds;
    if (remainingNanoseconds <= 0n) {
      transition("timeout");
      throw errorFor("timeout");
    }
    return Number((remainingNanoseconds + 999_999n) / 1_000_000n);
  };
  const timer = setTimeout(() => transition("timeout"), timeoutMs);
  callerSignal?.addEventListener("abort", cancel, { once: true });
  if (callerSignal?.aborted === true) cancel();

  return {
    signal: controller.signal,
    wait: async <Value>(operation: Promise<Value>): Promise<Value> => {
      checkpoint();
      const guarded = operation.catch((error: unknown) => {
        if (terminal === "cancelled") {
          throw errorFor("cancelled");
        }
        if (terminal === "timeout") {
          throw errorFor("timeout");
        }
        let diagnostic: FluxDiagnosticDto | undefined;
        let providerFailureEvidence: ProviderFailureEvidenceV1 | undefined;
        try {
          const candidate = typeof error === "object" && error !== null && "diagnostic" in error
            ? (error as { readonly diagnostic?: unknown }).diagnostic
            : undefined;
          diagnostic = candidate === undefined ? undefined : parseFluxDiagnostic(candidate);
          const evidenceCandidate = typeof error === "object" && error !== null && "providerFailureEvidence" in error
            ? (error as { readonly providerFailureEvidence?: unknown }).providerFailureEvidence
            : undefined;
          providerFailureEvidence = evidenceCandidate === undefined
            ? undefined
            : parseProviderFailureEvidence(evidenceCandidate);
          if (providerFailureEvidence !== undefined) {
            if (diagnostic === undefined) throw new Error("Provider failure evidence is missing its diagnostic");
            assertProviderFailureEvidenceMatchesDiagnostic(providerFailureEvidence, diagnostic);
          }
          if (diagnostic === undefined && error instanceof HarnessProviderError) {
            const diagnosticCode = error.code === "AUTH" || error.status === 401 || error.status === 403
              ? "PROVIDER_AUTH_UNAVAILABLE"
              : error.code === "HTTP"
                ? "PROVIDER_REQUEST_FAILED"
                : "PROVIDER_RESPONSE_INVALID";
            diagnostic = createFluxDiagnostic(diagnosticCode, {
              boundary: "pcb_design_interpretation",
              category: `provider_${error.code.toLocaleLowerCase("en-US")}`,
            });
          }
        } catch {
          diagnostic = createFluxDiagnostic("PROVIDER_RESPONSE_INVALID", {
            boundary: "pcb_design_interpretation",
            category: "invalid_provider_diagnostic",
          });
          providerFailureEvidence = undefined;
        }
        throw new PcbDesignInterpreterError(
          "PROVIDER_FAILED",
          "The PCB design-intent provider failed.",
          diagnostic ?? createFluxDiagnostic("PROVIDER_REQUEST_FAILED", {
            boundary: "pcb_design_interpretation",
            category: "provider_failure",
          }),
          providerFailureEvidence,
        );
      });
      return await Promise.race([guarded, boundary]);
    },
    checkpoint,
    remainingMilliseconds,
    dispose: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", cancel);
    }
  };
};

const boundedCompilationText = z.string().max(32_000);
const canonicalIdentitySchemaFor = <Version extends string>(version: Version) => z.object({
  algorithm: z.literal("sha256"),
  digest: z.string().regex(/^[0-9a-f]{64}$/u),
  schemaVersion: z.literal(version),
  canonicalizationVersion: z.literal(PCB_DESIGN_CANONICALIZATION_VERSION)
}).strict();

const libraryBindingSchema = z.object({
  schemaVersion: z.literal(PCB_LIBRARY_BINDING_SCHEMA_VERSION),
  contractIdentity: canonicalIdentitySchemaFor(PCB_DESIGN_CONTRACT_SCHEMA_VERSION),
  symbols: z.array(z.object({
    reference: z.string().regex(/^[A-Z][A-Z0-9_-]{0,31}$/u),
    libraryId: z.string().min(1).max(192),
    source: z.enum(["kicad-stock", "project-custom"]),
    unitCount: z.literal(1),
    componentKind: z.enum(["generic", "connector", "gpio"]),
    polarized: z.boolean(),
    pins: z.array(z.object({
      number: z.string().min(1).max(32),
      function: z.string().max(192).nullable()
    }).strict()).min(1).max(PCB_DESIGN_CONTRACT_LIMITS.maxPinsPerComponent)
  }).strict()).min(1).max(PCB_DESIGN_CONTRACT_LIMITS.maxComponents),
  footprints: z.array(z.object({
    reference: z.string().regex(/^[A-Z][A-Z0-9_-]{0,31}$/u),
    libraryId: z.string().min(1).max(192),
    source: z.enum(["kicad-stock", "project-custom"]),
    packageKind: z.literal("generic"),
    pads: z.array(z.string().min(1).max(32)).min(1).max(PCB_DESIGN_CONTRACT_LIMITS.maxPinsPerComponent)
  }).strict()).min(1).max(PCB_DESIGN_CONTRACT_LIMITS.maxComponents),
  sourceSelection: z.unknown().optional(),
  identity: canonicalIdentitySchemaFor(PCB_LIBRARY_BINDING_SCHEMA_VERSION)
}).strict();

const deepRuleFeatureNameSchema = z.enum([
  "powerCurrent", "signalSpeedInterfaces", "differentialPairs", "stackupImpedance", "thermal",
  "emi", "placement", "dfm", "assembly", "bga", "gpio"
]);
const deepRuleFeatureInputSchema = z.union([
  z.boolean(),
  z.object({
    enabled: z.boolean().optional(),
    terms: z.array(z.string().min(1).max(80)).max(24).optional(),
    priority: z.enum(["normal", "high"]).optional()
  }).strict()
]);
const deepRuleFeaturesSchema = z.object({
  powerCurrent: deepRuleFeatureInputSchema.optional(),
  signalSpeedInterfaces: deepRuleFeatureInputSchema.optional(),
  differentialPairs: deepRuleFeatureInputSchema.optional(),
  stackupImpedance: deepRuleFeatureInputSchema.optional(),
  thermal: deepRuleFeatureInputSchema.optional(),
  emi: deepRuleFeatureInputSchema.optional(),
  placement: deepRuleFeatureInputSchema.optional(),
  dfm: deepRuleFeatureInputSchema.optional(),
  assembly: deepRuleFeatureInputSchema.optional(),
  bga: deepRuleFeatureInputSchema.optional(),
  gpio: deepRuleFeatureInputSchema.optional()
}).strict();
const deepRuleSelectorSchema = z.object({
  topics: z.array(z.string().min(1).max(128)).max(250).optional(),
  tags: z.array(z.string().min(1).max(128)).max(250).optional(),
  ids: z.array(z.string().min(1).max(128)).max(250).optional(),
  categories: z.array(z.string().min(1).max(128)).max(250).optional(),
  severities: z.array(z.enum(["advisory", "warning", "error", "critical"])).max(4).optional(),
  limit: z.number().int().min(1).max(250).optional()
}).strict();
const boundedDeepRuleSelectionSchema = z.object({
  deepRuleSelection: deepRuleSelectorSchema,
  rules: z.array(z.object({
    id: z.string().min(1).max(128),
    topic: z.string().min(1).max(256),
    category: z.string().min(1).max(256),
    severity: z.enum(["advisory", "warning", "error", "critical"]),
    instructionExcerpt: z.string().min(1).max(240),
    source: z.object({
      dossierPath: z.string().min(1).max(1_024),
      headingAnchor: z.string().min(1).max(512),
      dossierLineStart: z.number().int().positive(),
      dossierLineEnd: z.number().int().positive(),
      articleUrl: z.string().url().max(2_048)
    }).strict(),
    reasons: z.array(z.union([z.literal("baseline"), deepRuleFeatureNameSchema])).min(1).max(12)
  }).strict()).max(40),
  prompt: z.string().max(16_384),
  disposition: z.enum(["ready-for-prompt", "incomplete"]),
  activeFeatures: z.array(deepRuleFeatureNameSchema).max(11),
  coveredFeatures: z.array(deepRuleFeatureNameSchema).max(11),
  uncoveredFeatures: z.array(deepRuleFeatureNameSchema).max(11),
  omittedCandidateCount: z.number().int().nonnegative(),
  budget: z.object({
    maxRules: z.number().int().min(1).max(40),
    usedRules: z.number().int().min(0).max(40),
    maxPromptBytes: z.number().int().min(1).max(16_384),
    usedPromptBytes: z.number().int().nonnegative().max(16_384),
    maxPromptTokens: z.number().int().min(1).max(16_384),
    usedPromptTokens: z.number().int().nonnegative().max(16_384),
    tokenAccounting: z.enum(["utf8-byte-upper-bound", "caller-supplied"])
  }).strict()
}).strict();

const deepRuleBindingSchema = z.object({
  schemaVersion: z.literal(PCB_DEEP_RULE_BINDING_SCHEMA_VERSION),
  contractIdentity: canonicalIdentitySchemaFor(PCB_DESIGN_CONTRACT_SCHEMA_VERSION),
  catalogIdentity: canonicalIdentitySchemaFor("evleda.deep-rule-catalog.v1"),
  features: deepRuleFeaturesSchema,
  selection: boundedDeepRuleSelectionSchema,
  identity: canonicalIdentitySchemaFor(PCB_DEEP_RULE_BINDING_SCHEMA_VERSION)
}).strict();

const acceptancePlanSchema = z.object({
  schemaVersion: z.literal(PCB_ACCEPTANCE_PLAN_SCHEMA_VERSION),
  contractIdentity: canonicalIdentitySchemaFor(PCB_DESIGN_CONTRACT_SCHEMA_VERSION),
  libraryBindingIdentity: canonicalIdentitySchemaFor(PCB_LIBRARY_BINDING_SCHEMA_VERSION),
  deepRuleBindingIdentity: canonicalIdentitySchemaFor(PCB_DEEP_RULE_BINDING_SCHEMA_VERSION),
  rows: z.array(z.object({
    id: z.string().min(1).max(256),
    kind: z.enum([
      "contract_integrity", "library_symbol", "library_footprint", "schematic_component",
      "pin_disposition", "schematic_net", "pcb_component", "board_outline", "placement",
      "routed_net", "netclass_width", "netclass_clearance", "route_turns", "route_vias", "erc", "drc", "visual_practice", "schematic_render_clearance"
    ]),
    mandatory: z.literal(true),
    contractPath: z.string().min(1).max(512),
    description: z.string().min(1).max(2_000)
  }).strict()).min(1).max(20_000),
  identity: canonicalIdentitySchemaFor(PCB_ACCEPTANCE_PLAN_SCHEMA_VERSION)
}).strict();

const compilationSchema = z.object({
  schemaVersion: z.literal(PCB_DESIGN_COMPILATION_SCHEMA_VERSION),
  disposition: z.enum(["ready", "needs_clarification", "unsupported"]),
  questions: z.array(z.object({
    id: pcbDesignStablePathSchema,
    path: pcbDesignStablePathSchema,
    question: boundedCompilationText.min(1)
  }).strict()).max(PCB_DESIGN_COMPILATION_LIMITS.maxQuestions),
  issues: z.array(z.object({
    code: z.enum([
      "INVALID_DRAFT", "UNRESOLVED_FIELD", "UNKNOWN_LIBRARY_ID", "INVALID_LIBRARY_RECORD",
      "LIBRARY_PIN_PAD_MISMATCH", "POLARITY_NOT_EXPLICIT", "CONNECTOR_ORIENTATION_NOT_EXPLICIT",
      "UNSUPPORTED_V1_FEATURE"
    ]),
    severity: z.literal("error"),
    path: pcbDesignStablePathSchema,
    message: boundedCompilationText.min(1),
    clarificationId: pcbDesignStablePathSchema.nullable()
  }).strict()).max(PCB_DESIGN_COMPILATION_LIMITS.maxIssues),
  contract: z.union([pcbDesignContractSchema, z.null()]),
  contractIdentity: z.union([canonicalIdentitySchemaFor(PCB_DESIGN_CONTRACT_SCHEMA_VERSION), z.null()]),
  libraryBinding: z.union([libraryBindingSchema, z.null()]),
  deepRuleBinding: z.union([deepRuleBindingSchema, z.null()]),
  acceptancePlan: z.union([acceptancePlanSchema, z.null()])
}).strict();

const invalidCompilation = (): PcbDesignInterpreterError =>
  new PcbDesignInterpreterError("INVALID_COMPILATION", "The host compiler returned an invalid PCB design compilation.");

const canonicalEqual = (left: unknown, right: unknown): boolean =>
  canonicalJson(left) === canonicalJson(right);

const verifySelfIdentity = (
  value: { readonly identity: unknown },
  schemaVersion: string
): void => {
  const payload = { ...(value as Record<string, unknown>) };
  delete payload.identity;
  if (!canonicalEqual(value.identity, canonicalIdentity(payload, schemaVersion))) throw invalidCompilation();
};

const strictlyIncreasing = (values: readonly string[]): boolean =>
  values.every((value, index) => index === 0 || values[index - 1]! < value);

const validateCompilation = (
  value: unknown,
  compilerOptions: PcbDesignCompilerOptions,
  checkpoint: () => void
): PcbDesignCompilation => {
  let validationPhase = "snapshot";
  try {
    const snapshot = snapshotBoundedJson(value, {
      limit: PCB_DESIGN_INTERPRETER_LIMITS.maxCompilationBytes,
      maxDepth: PCB_DESIGN_INTERPRETER_LIMITS.maxCompilationDepth,
      maxNodes: PCB_DESIGN_INTERPRETER_LIMITS.maxCompilationNodes,
      maxArrayLength: PCB_DESIGN_INTERPRETER_LIMITS.maxCompilationArrayLength,
      maxObjectKeys: PCB_DESIGN_INTERPRETER_LIMITS.maxCompilationObjectKeys,
      malformedCode: "INVALID_COMPILATION",
      oversizedCode: "INVALID_COMPILATION",
      label: "Compiler output",
      rejectAliases: false,
      checkpoint
    });
    validationPhase = "schema";
    checkpoint();
    const parsed = compilationSchema.safeParse(snapshot);
    checkpoint();
    if (!parsed.success) throw invalidCompilation();
    const result = parsed.data as PcbDesignCompilation;

    validationPhase = "top-level invariants";
    if (!strictlyIncreasing(result.questions.map((entry) => entry.path)) ||
        result.questions.some((entry) => entry.id !== entry.path)) {
      throw invalidCompilation();
    }
    const questionPaths = new Set(result.questions.map((entry) => entry.path));
    const hasUnsupportedIssue = result.issues.some((entry) => entry.code === "UNSUPPORTED_V1_FEATURE");
    const issueClarificationPaths = new Set<string>();
    for (const entry of result.issues) {
      if (entry.code === "UNSUPPORTED_V1_FEATURE") {
        if (entry.clarificationId !== null) throw invalidCompilation();
        continue;
      }
      if (entry.clarificationId !== entry.path || !questionPaths.has(entry.path)) throw invalidCompilation();
      issueClarificationPaths.add(entry.path);
    }
    if (questionPaths.size !== result.questions.length ||
        result.questions.some((entry) => !issueClarificationPaths.has(entry.path)) ||
        (result.disposition === "unsupported") !== hasUnsupportedIssue) throw invalidCompilation();
    const issueKeys = result.issues.map((entry) => `${entry.path}\u0000${entry.code}\u0000${entry.message}`);
    if (!strictlyIncreasing(issueKeys)) throw invalidCompilation();

    if (result.disposition !== "ready") {
      if (result.contract !== null || result.contractIdentity !== null || result.libraryBinding !== null ||
          result.deepRuleBinding !== null || result.acceptancePlan !== null) throw invalidCompilation();
      if (result.disposition === "needs_clarification" && result.questions.length === 0) throw invalidCompilation();
      checkpoint();
      const frozen = deepFreeze(result);
      checkpoint();
      return frozen;
    }

    validationPhase = "ready bindings";
    if (result.questions.length !== 0 || result.issues.length !== 0 || result.contract === null ||
        result.contractIdentity === null || result.libraryBinding === null || result.deepRuleBinding === null ||
        result.acceptancePlan === null) throw invalidCompilation();
    if (!canonicalEqual(result.contractIdentity, result.contract.identity) ||
        !canonicalEqual(result.libraryBinding.contractIdentity, result.contract.identity) ||
        !canonicalEqual(result.deepRuleBinding.contractIdentity, result.contract.identity) ||
        !canonicalEqual(result.acceptancePlan.contractIdentity, result.contract.identity)) throw invalidCompilation();

    verifySelfIdentity(result.libraryBinding, PCB_LIBRARY_BINDING_SCHEMA_VERSION);
    verifySelfIdentity(result.deepRuleBinding, PCB_DEEP_RULE_BINDING_SCHEMA_VERSION);
    verifySelfIdentity(result.acceptancePlan, PCB_ACCEPTANCE_PLAN_SCHEMA_VERSION);

    validationPhase = "library projection";
    if (Object.hasOwn(result.libraryBinding, "sourceSelection")) parsePcbLibrarySourceSelection(result.libraryBinding.sourceSelection, {
      symbolIds: [...new Set(result.libraryBinding.symbols.map(entry => entry.libraryId))],
      footprintIds: [...new Set(result.libraryBinding.footprints.map(entry => entry.libraryId))],
    });
    assertPcbLibraryBindingSourceKinds(result.libraryBinding);
    assertPcbLibrarySourcesCurrent(result.libraryBinding, compilerOptions.libraryResolver);
    const components = new Map(result.contract.components.map((component) => [component.reference, component]));
    if (result.libraryBinding.symbols.length !== components.size || result.libraryBinding.footprints.length !== components.size ||
        !strictlyIncreasing(result.libraryBinding.symbols.map((entry) => entry.reference)) ||
        !strictlyIncreasing(result.libraryBinding.footprints.map((entry) => entry.reference))) throw invalidCompilation();
    for (const symbol of result.libraryBinding.symbols) {
      const component = components.get(symbol.reference);
      if (component === undefined || component.symbolLibId !== symbol.libraryId ||
          !strictlyIncreasing(symbol.pins.map((pin) => pin.number)) ||
          !canonicalEqual([...component.pins].map((pin) => pin.pin).sort(), [...symbol.pins].map((pin) => pin.number).sort())) {
        throw invalidCompilation();
      }
    }
    for (const footprint of result.libraryBinding.footprints) {
      const component = components.get(footprint.reference);
      if (component === undefined || component.footprintLibId !== footprint.libraryId ||
          !strictlyIncreasing(footprint.pads) ||
          !canonicalEqual([...component.pins].map((pin) => pin.pin).sort(), [...footprint.pads].sort())) {
        throw invalidCompilation();
      }
    }

    validationPhase = "rule and acceptance projection";
    if (!canonicalEqual(result.acceptancePlan.libraryBindingIdentity, result.libraryBinding.identity) ||
        !canonicalEqual(result.acceptancePlan.deepRuleBindingIdentity, result.deepRuleBinding.identity)) throw invalidCompilation();
    const expectedFeatures = deriveDeepRuleFeaturesFromContract(result.contract, result.libraryBinding);
    if (!canonicalEqual(result.deepRuleBinding.features, expectedFeatures)) throw invalidCompilation();
    const expectedCatalogIdentity = canonicalIdentity(compilerOptions.deepRuleCatalog, "evleda.deep-rule-catalog.v1");
    if (!canonicalEqual(result.deepRuleBinding.catalogIdentity, expectedCatalogIdentity)) throw invalidCompilation();
    const expectedSelection = selectDeepRulesForDesign(
      compilerOptions.deepRuleCatalog,
      expectedFeatures,
      compilerOptions.deepRuleSelectionOptions
    );
    if (!canonicalEqual(result.deepRuleBinding.selection, expectedSelection)) throw invalidCompilation();
    const expectedPlan = createPcbAcceptancePlan(result.contract, result.libraryBinding, result.deepRuleBinding);
    if (!canonicalEqual(result.acceptancePlan, expectedPlan)) throw invalidCompilation();
    checkpoint();
    const frozen = deepFreeze(result);
    checkpoint();
    return frozen;
  } catch (error) {
    if (error instanceof PcbDesignDeadlineBoundaryError) throw error;
    throw new PcbDesignInterpreterError(
      "INVALID_COMPILATION",
      `The host compiler returned an invalid PCB design compilation during ${validationPhase}.`
    );
  }
};

const createVerifiedCompilationBundle = (
  originalPrompt: string,
  compilation: PcbDesignCompilation,
  compilerOptions: PcbDesignCompilerOptions,
  checkpoint: () => void
): PcbDesignCompilationBundle => {
  try {
    checkpoint();
    const compilerProfile = createPcbDesignCompilerProfile(compilation, compilerOptions.deepRuleCatalog);
    checkpoint();
    const bundleDependencies = {
      libraryResolver: compilerOptions.libraryResolver,
      deepRuleCatalog: compilerOptions.deepRuleCatalog,
      compilerProfile
    };
    const created = createPcbDesignCompilationBundle(
      { originalPrompt, compilation, compilerProfile },
      bundleDependencies
    );
    checkpoint();
    const exactBytes = serializePcbDesignCompilationBundle(created);
    checkpoint();
    const bundle = parsePcbDesignCompilationBundle(exactBytes, bundleDependencies);
    checkpoint();
    if (compilation.contractIdentity === null || compilation.libraryBinding === null ||
        compilation.deepRuleBinding === null || compilation.acceptancePlan === null ||
        bundle.executionPrompt.originalPrompt !== originalPrompt ||
        !canonicalEqual(bundle.contract.identity, compilation.contractIdentity) ||
        !canonicalEqual(bundle.libraryBinding.identity, compilation.libraryBinding.identity) ||
        !canonicalEqual(bundle.deepRuleBinding.identity, compilation.deepRuleBinding.identity) ||
        !canonicalEqual(bundle.acceptancePlan.identity, compilation.acceptancePlan.identity) ||
        !canonicalEqual(bundle.compilerProfile.identity, compilerProfile.identity) ||
        !canonicalEqual(bundle.executionPrompt.contractIdentity, bundle.contract.identity) ||
        !canonicalEqual(bundle.executionPrompt.libraryBindingIdentity, bundle.libraryBinding.identity) ||
        !canonicalEqual(bundle.executionPrompt.deepRuleBindingIdentity, bundle.deepRuleBinding.identity) ||
        !canonicalEqual(bundle.executionPrompt.compilerProfileIdentity, bundle.compilerProfile.identity) ||
        !canonicalEqual(bundle.executionPrompt.practiceProfileBindingIdentity, bundle.practiceProfileBinding.identity) ||
        !canonicalEqual(bundle.executionPrompt.acceptancePlanIdentity, bundle.acceptancePlan.identity)) {
      throw invalidCompilation();
    }
    return bundle;
  } catch (error) {
    if (error instanceof PcbDesignDeadlineBoundaryError || error instanceof PcbDesignInterpreterError) throw error;
    if (error instanceof PcbDesignCompilationBundleError) {
      throw new PcbDesignInterpreterError(
        "COMPILATION_BUNDLE_FAILED",
        "The ready PCB compilation could not produce an exact bounded candidate-only execution bundle."
      );
    }
    throw new PcbDesignInterpreterError(
      "COMPILATION_BUNDLE_FAILED",
      "The ready PCB compilation could not be independently bundled and verified."
    );
  }
};

const interpretationResult = (
  compilation: PcbDesignCompilation,
  bundle: PcbDesignCompilationBundle | null
): PcbDesignInterpretationResult => deepFreeze({ ...compilation, bundle });

const invalidDraftError = (): PcbDesignInterpreterError =>
  new PcbDesignInterpreterError(
    "INVALID_DRAFT",
    `The ${PCB_DESIGN_INTENT_TOOL_NAME} arguments are not a valid PCB design-intent draft.`,
  );

/**
 * One model turn produces one immutable intent draft, then the host compiler
 * resolves libraries/rules and returns ready, needs_clarification, or
 * unsupported. Ready is returned only with a re-parsed exact candidate-only
 * compilation bundle; every other disposition carries bundle:null. No
 * mutation or approval callback exists at this boundary.
 */
export const interpretAndCompilePcbDesignIntent = async (
  input: PcbDesignInterpretationInput,
  dependencies: PcbDesignInterpreterDependencies,
  options: PcbDesignInterpreterOptions = {}
): Promise<PcbDesignInterpretationResult> => {
  const outputLimit = validateOutputLimit(options.maxProviderOutputBytes);
  const timeoutMs = validateTimeout(options.timeoutMs);
  if (options.signal?.aborted === true) {
    throw new PcbDesignInterpreterError(
      "CANCELLED",
      "PCB design interpretation was cancelled.",
      createFluxDiagnostic("PROVIDER_CANCELLED", {
        boundary: "pcb_design_interpretation",
        category: "cancelled_before_start",
      }),
    );
  }
  const deadline = createProviderDeadline(options.signal, timeoutMs, options.nowNanoseconds);
  try {
    deadline.checkpoint();
    const capturedInput = capturePcbDesignInterpretationInput(input);
    const request = createPcbIntentProviderRequestFromCaptured(capturedInput, outputLimit);
    const providerTurn = async (
      providerRequest: PcbIntentProviderRequest,
      turnOutputLimit: number,
    ): Promise<CapturedPcbIntentProviderTurn> => {
      deadline.checkpoint();
      const remainingTimeoutMs = deadline.remainingMilliseconds();
      const rawTurn = await deadline.wait(Promise.resolve().then(async () =>
        await dependencies.provider.turn(providerRequest, {
          signal: deadline.signal,
          timeoutMs: remainingTimeoutMs,
          requiredToolName: PCB_DESIGN_INTENT_TOOL_NAME,
          allowParallelToolCalls: false,
        })
      ));
      deadline.checkpoint();
      return requireSingleDesignIntentCall(rawTurn, turnOutputLimit, deadline.checkpoint);
    };
    deadline.checkpoint();
    const firstProviderTurn = await providerTurn(request, outputLimit);
    const turn = firstProviderTurn.turn;
    let draft: PcbDesignIntentDraft;
    deadline.checkpoint();
    try {
      draft = parsePcbDesignIntentDraft(turn.toolCalls[0]!.arguments);
    } catch (error) {
      if (!(error instanceof PcbDesignContractError) || error.code !== "INVALID_DRAFT") {
        throw invalidDraftError();
      }
      deadline.checkpoint();
      const repairOutputLimit = outputLimit - firstProviderTurn.bytes;
      if (repairOutputLimit < PCB_DESIGN_INTENT_MINIMUM_REPAIR_OUTPUT_BYTES) {
        throw invalidDraftError();
      }
      const repairRequest = createPcbIntentProviderRequestFromCaptured(
        capturedInput,
        repairOutputLimit,
        repairIssuesFor(error),
      );
      const repairedTurn = (await providerTurn(repairRequest, repairOutputLimit)).turn;
      deadline.checkpoint();
      try {
        draft = parsePcbDesignIntentDraft(repairedTurn.toolCalls[0]!.arguments);
      } catch {
        throw invalidDraftError();
      }
    }
    deadline.checkpoint();
    const compiler = dependencies.compiler ?? compilePcbDesignIntentDraft;
    let compilation: PcbDesignCompilation;
    deadline.checkpoint();
    try {
      compilation = compiler(draft, dependencies.compilerOptions);
    } catch {
      throw new PcbDesignInterpreterError("COMPILER_FAILED", "The host PCB design compiler failed.");
    }
    deadline.checkpoint();
    const validated = validateCompilation(compilation, dependencies.compilerOptions, deadline.checkpoint);
    if (validated.disposition !== "ready") return interpretationResult(validated, null);
    const bundle = createVerifiedCompilationBundle(
      capturedInput.prompt,
      validated,
      dependencies.compilerOptions,
      deadline.checkpoint
    );
    deadline.checkpoint();
    return interpretationResult(validated, bundle);
  } finally {
    deadline.dispose();
  }
};

/** Concise alias for prompt-oriented callers. */
export const interpretPcbDesignPrompt = interpretAndCompilePcbDesignIntent;
