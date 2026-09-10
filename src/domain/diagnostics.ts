import { canonicalIdentity, canonicalJson } from "../core/canonical.js";
import { hardenPortableValue } from "../core/portable-artifact.js";
import type { CanonicalIdentity } from "./types.js";

export const FLUX_DIAGNOSTIC_SCHEMA_VERSION = "evleda.flux-diagnostic.v1" as const;
export const FLUX_DIAGNOSTIC_EVIDENCE_SCHEMA_VERSION =
  "evleda.flux-diagnostic-evidence.v1" as const;

export const FLUX_DIAGNOSTIC_CODES = Object.freeze([
  "CODEX_CONFIG_INCOMPATIBLE",
  "PROVIDER_AUTH_UNAVAILABLE",
  "PROVIDER_DEADLINE_EXCEEDED",
  "PROVIDER_CANCELLED",
  "PROVIDER_PROCESS_EXIT",
  "PROVIDER_REQUEST_FAILED",
  "PROVIDER_RESPONSE_INVALID",
  "SOURCE_DRIFT",
  "TOOLCHAIN_FAILURE",
] as const);

export type FluxDiagnosticCode = (typeof FLUX_DIAGNOSTIC_CODES)[number];

export interface FluxDiagnosticDto {
  readonly schemaVersion: typeof FLUX_DIAGNOSTIC_SCHEMA_VERSION;
  readonly code: FluxDiagnosticCode;
  readonly evidenceIdentity: CanonicalIdentity;
}

export interface FluxDiagnosticCarrier {
  readonly diagnostic: FluxDiagnosticDto;
}

export const PROVIDER_FAILURE_EVIDENCE_SCHEMA_VERSION =
  "evleda.provider-failure-evidence.v1" as const;
export const PROVIDER_FAILURE_ADAPTER_IDENTITY_SCHEMA_VERSION =
  "evleda.codex-cli-provider-failure-adapter.v1" as const;
export const PROVIDER_FAILURE_PARSER_IDENTITY_SCHEMA_VERSION =
  "evleda.codex-cli-provider-failure-parser.v1" as const;
export const PROVIDER_FAILURE_TRANSPORT_IDENTITY_SCHEMA_VERSION =
  "evleda.harness-cli-turn-envelope.v3" as const;
export const PROVIDER_FAILURE_EVIDENCE_MAX_BYTES = 4_096;
export const PROVIDER_FAILURE_EVIDENCE_MAX_ISSUES = 16;

export const PROVIDER_FAILURE_LEAVES = Object.freeze([
  "OUTER_JSON_INVALID",
  "OUTER_BUDGET_EXCEEDED",
  "OUTER_SHAPE_INVALID",
  "OUTER_VERSION_MISMATCH",
  "OUTER_FIELD_TYPE_INVALID",
  "ARGUMENTS_STRING_BUDGET_EXCEEDED",
  "ARGUMENTS_JSON_INVALID",
  "ARGUMENTS_BUDGET_EXCEEDED",
  "TURN_SCHEMA_INVALID",
  "MESSAGE_SCHEMA_INVALID",
  "CALL_SCHEMA_INVALID",
  "UNSUPPORTED_TOOL",
  "DUPLICATE_CALL_ID",
  "PARALLEL_CALL_COUNT",
  "REQUIRED_TOOL_MISSING",
  "REQUIRED_TOOL_NAME_MISMATCH",
  "REQUIRED_TOOL_STOP_MISMATCH",
  "CLEANUP_SECONDARY",
] as const);
export type ProviderFailureLeaf = (typeof PROVIDER_FAILURE_LEAVES)[number];

export const PROVIDER_FAILURE_ISSUE_PATHS = Object.freeze([
  "$",
  "$.schemaVersion",
  "$.messageContent",
  "$.hasToolCalls",
  "$.toolCalls",
  "$.toolCalls[]",
  "$.toolCalls[].id",
  "$.toolCalls[].name",
  "$.toolCalls[].argumentsJson",
  "$.stopReason",
  "$.message",
  "$.toolCalls[].arguments",
] as const);
export type ProviderFailureIssuePath = (typeof PROVIDER_FAILURE_ISSUE_PATHS)[number];

export const PROVIDER_FAILURE_ISSUE_CODES = Object.freeze([
  "INVALID_JSON",
  "BYTE_LIMIT",
  "MISSING_FIELD",
  "EXTRA_FIELD",
  "INVALID_TYPE",
  "INVALID_VALUE",
  "SCHEMA",
  "NOT_ALLOWED",
  "DUPLICATE",
  "COUNT",
  "MISMATCH",
  "SECONDARY",
] as const);
export type ProviderFailureIssueCode = (typeof PROVIDER_FAILURE_ISSUE_CODES)[number];
export const PROVIDER_FAILURE_OBSERVED_TYPES = Object.freeze([
  "null", "array", "object", "string", "number", "boolean", "missing", "unknown",
] as const);
export type ProviderFailureObservedType = (typeof PROVIDER_FAILURE_OBSERVED_TYPES)[number];

export const PROVIDER_FAILURE_CHECKPOINT_KEYS = Object.freeze([
  "outerBytesWithinLimit", "outerJsonParsed", "outerShapeClosed", "outerVersionMatched",
  "outerTypesValid", "argumentsStringsWithinLimit", "argumentsJsonParsed", "argumentsWithinLimit",
  "turnSchemaValid", "messageSchemaValid", "callSchemaValid", "toolNamesAllowed", "callIdsUnique",
  "parallelPolicyValid", "requiredToolValid", "stopReasonValid", "cleanupCompleted",
] as const);
export type ProviderFailureCheckpoint = (typeof PROVIDER_FAILURE_CHECKPOINT_KEYS)[number];

export interface ProviderFailureIssueV1 {
  readonly path: ProviderFailureIssuePath;
  readonly code: ProviderFailureIssueCode;
  readonly observedType: ProviderFailureObservedType;
}

export interface ProviderFailureEvidenceV1 {
  readonly schemaVersion: typeof PROVIDER_FAILURE_EVIDENCE_SCHEMA_VERSION;
  readonly adapter: "codex";
  readonly boundary: "cli_turn_output" | "cli_temporary_output";
  readonly leaf: ProviderFailureLeaf;
  readonly providerErrorClass: "MALFORMED" | "OUTPUT_LIMIT" | "HTTP" | "INCOMPLETE";
  readonly checkpoints: Readonly<Record<ProviderFailureCheckpoint, boolean>>;
  readonly identities: Readonly<{
    readonly adapter: CanonicalIdentity;
    readonly parser: CanonicalIdentity;
    readonly transportSchema: CanonicalIdentity;
  }>;
  readonly observations: Readonly<{
    readonly outerBytes: number | null;
    readonly outerSha256: string | null;
    readonly argumentsBytes: number | null;
    readonly argumentsSha256: string | null;
    readonly issues: readonly ProviderFailureIssueV1[];
  }>;
}

export type ProviderFailureEvidenceInput = Omit<ProviderFailureEvidenceV1, "schemaVersion">;

export interface ProviderFailureDiagnosticBundle {
  readonly diagnostic: FluxDiagnosticDto;
  readonly providerFailureEvidence: ProviderFailureEvidenceV1;
}

const codes = new Set<string>(FLUX_DIAGNOSTIC_CODES);
const forbiddenKey = /(?:path|argv|command|prompt|stdout|stderr|output|response|message|text|key|secret|token|authorization|cookie|credential)/iu;
const forbiddenString = /(?:[A-Za-z]:[\\/]|\\\\|(?:^|\s)\.{0,2}\/|file:|\b(?:bearer|basic)\s+[A-Za-z0-9._~+\/-]+=*|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-(?:proj-)?[A-Za-z0-9_-]{8,})/iu;

const deepFreeze = <Value>(value: Value): Value => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const exactIdentity = (value: unknown): CanonicalIdentity => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Diagnostic evidence identity is malformed");
  }
  const record = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(record);
  if (keys.length !== 4 || !["algorithm", "digest", "schemaVersion", "canonicalizationVersion"]
    .every((key) => Object.hasOwn(record, key))) throw new Error("Diagnostic evidence identity is malformed");
  if (
    record.algorithm !== "sha256"
    || typeof record.digest !== "string"
    || !/^[0-9a-f]{64}$/u.test(record.digest)
    || record.schemaVersion !== FLUX_DIAGNOSTIC_EVIDENCE_SCHEMA_VERSION
    || record.canonicalizationVersion !== "evleda-c14n-json-v1"
  ) throw new Error("Diagnostic evidence identity is malformed");
  return Object.freeze({
    algorithm: "sha256",
    digest: record.digest,
    schemaVersion: FLUX_DIAGNOSTIC_EVIDENCE_SCHEMA_VERSION,
    canonicalizationVersion: "evleda-c14n-json-v1",
  });
};

const assertSafeEvidence = (value: unknown, depth = 0): void => {
  if (depth > 12) throw new Error("Diagnostic evidence exceeds its depth bound");
  if (typeof value === "string") {
    if (forbiddenString.test(value) || Buffer.byteLength(value, "utf8") > 256) {
      throw new Error("Diagnostic evidence contains unsafe text");
    }
    return;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return;
  if (Array.isArray(value)) {
    for (const entry of value) assertSafeEvidence(entry, depth + 1);
    return;
  }
  if (typeof value !== "object") throw new Error("Diagnostic evidence must be JSON data");
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (forbiddenKey.test(key)) throw new Error("Diagnostic evidence contains an unsafe field");
    assertSafeEvidence(entry, depth + 1);
  }
};

/** Create a public diagnostic from safe categorical evidence; raw evidence is discarded. */
export const createFluxDiagnostic = (
  code: FluxDiagnosticCode,
  categoricalEvidence: unknown,
): FluxDiagnosticDto => {
  if (!codes.has(code)) throw new Error("Diagnostic code is unsupported");
  const evidence = hardenPortableValue(categoricalEvidence, {
    maxBytes: 16 * 1024,
    maxDepth: 12,
    maxNodes: 512,
    maxArrayLength: 64,
    maxOwnKeys: 64,
    maxKeyBytes: 128,
    maxStringBytes: 256,
  });
  assertSafeEvidence(evidence);
  return deepFreeze({
    schemaVersion: FLUX_DIAGNOSTIC_SCHEMA_VERSION,
    code,
    evidenceIdentity: canonicalIdentity(evidence, FLUX_DIAGNOSTIC_EVIDENCE_SCHEMA_VERSION),
  });
};

/** Revalidate the exact path-free public shape without needing the private evidence preimage. */
export const parseFluxDiagnostic = (value: unknown): FluxDiagnosticDto => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Flux diagnostic is malformed");
  }
  const record = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(record);
  if (keys.length !== 3 || !["schemaVersion", "code", "evidenceIdentity"]
    .every((key) => Object.hasOwn(record, key))) throw new Error("Flux diagnostic is malformed");
  if (record.schemaVersion !== FLUX_DIAGNOSTIC_SCHEMA_VERSION
    || typeof record.code !== "string" || !codes.has(record.code)) throw new Error("Flux diagnostic is malformed");
  return deepFreeze({
    schemaVersion: FLUX_DIAGNOSTIC_SCHEMA_VERSION,
    code: record.code as FluxDiagnosticCode,
    evidenceIdentity: exactIdentity(record.evidenceIdentity),
  });
};

const providerFailureLeaves = new Set<string>(PROVIDER_FAILURE_LEAVES);
const providerFailureIssuePaths = new Set<string>(PROVIDER_FAILURE_ISSUE_PATHS);
const providerFailureIssueCodes = new Set<string>(PROVIDER_FAILURE_ISSUE_CODES);
const providerFailureObservedTypes = new Set<string>(PROVIDER_FAILURE_OBSERVED_TYPES);
const providerErrorClasses = new Set<string>(["MALFORMED", "OUTPUT_LIMIT", "HTTP", "INCOMPLETE"]);
const providerOutputLimitLeaves = new Set<ProviderFailureLeaf>([
  "OUTER_BUDGET_EXCEEDED",
  "ARGUMENTS_STRING_BUDGET_EXCEEDED",
  "ARGUMENTS_BUDGET_EXCEEDED",
]);

const exactKeys = (value: Record<string, unknown>, keys: readonly string[], label: string): void => {
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length
    || actual.some((key) => typeof key !== "string" || !keys.includes(key))) {
    throw new Error(`${label} has missing or unsupported fields`);
  }
};

const providerCanonicalIdentity = (
  value: unknown,
  expectedSchemaVersion: string,
): CanonicalIdentity => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Provider failure identity is malformed");
  }
  const record = value as Record<string, unknown>;
  exactKeys(record, ["algorithm", "digest", "schemaVersion", "canonicalizationVersion"], "Provider failure identity");
  if (record.algorithm !== "sha256"
    || typeof record.digest !== "string" || !/^[0-9a-f]{64}$/u.test(record.digest)
    || record.schemaVersion !== expectedSchemaVersion
    || record.canonicalizationVersion !== "evleda-c14n-json-v1") {
    throw new Error("Provider failure identity is malformed");
  }
  return Object.freeze({
    algorithm: "sha256",
    digest: record.digest,
    schemaVersion: expectedSchemaVersion,
    canonicalizationVersion: "evleda-c14n-json-v1",
  });
};

const boundedObservation = (value: unknown, label: string): number | null => {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 4 * 1024 * 1024) {
    throw new Error(`${label} is invalid`);
  }
  return value as number;
};

const optionalDigest = (value: unknown, label: string): string | null => {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw new Error(`${label} is invalid`);
  return value;
};

export const parseProviderFailureEvidence = (value: unknown): ProviderFailureEvidenceV1 => {
  const hardened = hardenPortableValue(value, {
    maxBytes: PROVIDER_FAILURE_EVIDENCE_MAX_BYTES,
    maxDepth: 8,
    maxNodes: 256,
    maxArrayLength: PROVIDER_FAILURE_EVIDENCE_MAX_ISSUES,
    maxOwnKeys: 32,
    maxKeyBytes: 64,
    maxStringBytes: 160,
  });
  if (hardened === null || typeof hardened !== "object" || Array.isArray(hardened)) {
    throw new Error("Provider failure evidence is malformed");
  }
  const record = hardened as Record<string, unknown>;
  exactKeys(record, [
    "schemaVersion", "adapter", "boundary", "leaf", "providerErrorClass",
    "checkpoints", "identities", "observations",
  ], "Provider failure evidence");
  if (record.schemaVersion !== PROVIDER_FAILURE_EVIDENCE_SCHEMA_VERSION
    || record.adapter !== "codex"
    || (record.boundary !== "cli_turn_output" && record.boundary !== "cli_temporary_output")
    || typeof record.leaf !== "string" || !providerFailureLeaves.has(record.leaf)
    || typeof record.providerErrorClass !== "string" || !providerErrorClasses.has(record.providerErrorClass)) {
    throw new Error("Provider failure evidence is malformed");
  }
  const expectedBoundary = record.leaf === "CLEANUP_SECONDARY"
    ? "cli_temporary_output"
    : "cli_turn_output";
  if (record.boundary !== expectedBoundary) {
    throw new Error("Provider failure leaf and boundary disagree");
  }
  const errorClassMatchesLeaf = record.leaf === "CLEANUP_SECONDARY"
    ? record.providerErrorClass === "MALFORMED" || record.providerErrorClass === "INCOMPLETE"
    : providerOutputLimitLeaves.has(record.leaf as ProviderFailureLeaf)
      ? record.providerErrorClass === "OUTPUT_LIMIT"
      : record.providerErrorClass === "MALFORMED";
  if (!errorClassMatchesLeaf) {
    throw new Error("Provider failure leaf and error class disagree");
  }
  if (record.checkpoints === null || typeof record.checkpoints !== "object" || Array.isArray(record.checkpoints)) {
    throw new Error("Provider failure checkpoints are malformed");
  }
  const checkpoints = record.checkpoints as Record<string, unknown>;
  exactKeys(checkpoints, PROVIDER_FAILURE_CHECKPOINT_KEYS, "Provider failure checkpoints");
  if (PROVIDER_FAILURE_CHECKPOINT_KEYS.some((key) => typeof checkpoints[key] !== "boolean")) {
    throw new Error("Provider failure checkpoints are malformed");
  }
  if (record.identities === null || typeof record.identities !== "object" || Array.isArray(record.identities)) {
    throw new Error("Provider failure identities are malformed");
  }
  const identities = record.identities as Record<string, unknown>;
  exactKeys(identities, ["adapter", "parser", "transportSchema"], "Provider failure identities");
  if (record.observations === null || typeof record.observations !== "object" || Array.isArray(record.observations)) {
    throw new Error("Provider failure observations are malformed");
  }
  const observations = record.observations as Record<string, unknown>;
  exactKeys(observations, ["outerBytes", "outerSha256", "argumentsBytes", "argumentsSha256", "issues"], "Provider failure observations");
  if (!Array.isArray(observations.issues) || observations.issues.length > PROVIDER_FAILURE_EVIDENCE_MAX_ISSUES) {
    throw new Error("Provider failure issues are malformed");
  }
  const issues = observations.issues.map((issue) => {
    if (issue === null || typeof issue !== "object" || Array.isArray(issue)) {
      throw new Error("Provider failure issue is malformed");
    }
    const issueRecord = issue as Record<string, unknown>;
    exactKeys(issueRecord, ["path", "code", "observedType"], "Provider failure issue");
    if (typeof issueRecord.path !== "string" || !providerFailureIssuePaths.has(issueRecord.path)
      || typeof issueRecord.code !== "string" || !providerFailureIssueCodes.has(issueRecord.code)
      || typeof issueRecord.observedType !== "string" || !providerFailureObservedTypes.has(issueRecord.observedType)) {
      throw new Error("Provider failure issue is malformed");
    }
    return Object.freeze({
      path: issueRecord.path as ProviderFailureIssuePath,
      code: issueRecord.code as ProviderFailureIssueCode,
      observedType: issueRecord.observedType as ProviderFailureObservedType,
    });
  });
  if (record.leaf === "CLEANUP_SECONDARY" && (
    checkpoints.cleanupCompleted !== false
    || !issues.some((issue) => issue.code === "SECONDARY")
  )) {
    throw new Error("Provider cleanup failure evidence is contradictory");
  }
  if (record.leaf !== "CLEANUP_SECONDARY" && issues.some((issue) => issue.code === "SECONDARY")) {
    throw new Error("Provider output failure evidence contains a cleanup-only issue");
  }
  const outerBytes = boundedObservation(observations.outerBytes, "outerBytes");
  const outerSha256 = optionalDigest(observations.outerSha256, "outerSha256");
  const argumentsBytes = boundedObservation(observations.argumentsBytes, "argumentsBytes");
  const argumentsSha256 = optionalDigest(observations.argumentsSha256, "argumentsSha256");
  if ((outerBytes === null) !== (outerSha256 === null)
    || (argumentsBytes === null) !== (argumentsSha256 === null)) {
    throw new Error("Provider failure observation sizes and digests disagree");
  }
  const parsed: ProviderFailureEvidenceV1 = {
    schemaVersion: PROVIDER_FAILURE_EVIDENCE_SCHEMA_VERSION,
    adapter: "codex",
    boundary: record.boundary as ProviderFailureEvidenceV1["boundary"],
    leaf: record.leaf as ProviderFailureLeaf,
    providerErrorClass: record.providerErrorClass as ProviderFailureEvidenceV1["providerErrorClass"],
    checkpoints: Object.freeze(Object.fromEntries(
      PROVIDER_FAILURE_CHECKPOINT_KEYS.map((key) => [key, checkpoints[key] as boolean]),
    )) as ProviderFailureEvidenceV1["checkpoints"],
    identities: Object.freeze({
      adapter: providerCanonicalIdentity(
        identities.adapter,
        PROVIDER_FAILURE_ADAPTER_IDENTITY_SCHEMA_VERSION,
      ),
      parser: providerCanonicalIdentity(
        identities.parser,
        PROVIDER_FAILURE_PARSER_IDENTITY_SCHEMA_VERSION,
      ),
      transportSchema: providerCanonicalIdentity(
        identities.transportSchema,
        PROVIDER_FAILURE_TRANSPORT_IDENTITY_SCHEMA_VERSION,
      ),
    }),
    observations: Object.freeze({
      outerBytes,
      outerSha256,
      argumentsBytes,
      argumentsSha256,
      issues: Object.freeze(issues),
    }),
  };
  if (Buffer.byteLength(canonicalJson(parsed), "utf8") > PROVIDER_FAILURE_EVIDENCE_MAX_BYTES) {
    throw new Error("Provider failure evidence exceeds its byte limit");
  }
  return deepFreeze(parsed);
};

export const createProviderFailureEvidence = (
  input: ProviderFailureEvidenceInput,
): ProviderFailureEvidenceV1 => parseProviderFailureEvidence({
  schemaVersion: PROVIDER_FAILURE_EVIDENCE_SCHEMA_VERSION,
  ...input,
});

export const providerFailureEvidenceIdentity = (
  evidence: ProviderFailureEvidenceV1,
): CanonicalIdentity => canonicalIdentity(
  parseProviderFailureEvidence(evidence),
  FLUX_DIAGNOSTIC_EVIDENCE_SCHEMA_VERSION,
);

export const providerFailureDiagnosticCode = (
  evidence: ProviderFailureEvidenceV1,
): "PROVIDER_REQUEST_FAILED" | "PROVIDER_RESPONSE_INVALID" => {
  const parsed = parseProviderFailureEvidence(evidence);
  return parsed.leaf === "CLEANUP_SECONDARY" && parsed.providerErrorClass === "INCOMPLETE"
    ? "PROVIDER_REQUEST_FAILED"
    : "PROVIDER_RESPONSE_INVALID";
};

export const createProviderFailureDiagnostic = (
  code: FluxDiagnosticCode,
  evidence: ProviderFailureEvidenceV1,
): ProviderFailureDiagnosticBundle => {
  if (!codes.has(code)) throw new Error("Diagnostic code is unsupported");
  const providerFailureEvidence = parseProviderFailureEvidence(evidence);
  if (code !== providerFailureDiagnosticCode(providerFailureEvidence)) {
    throw new Error("Provider failure evidence and diagnostic code disagree");
  }
  return deepFreeze({
    diagnostic: {
      schemaVersion: FLUX_DIAGNOSTIC_SCHEMA_VERSION,
      code,
      evidenceIdentity: providerFailureEvidenceIdentity(providerFailureEvidence),
    },
    providerFailureEvidence,
  });
};

export const assertProviderFailureEvidenceMatchesDiagnostic = (
  evidence: ProviderFailureEvidenceV1,
  diagnostic: FluxDiagnosticDto,
): void => {
  const parsedDiagnostic = parseFluxDiagnostic(diagnostic);
  const parsedEvidence = parseProviderFailureEvidence(evidence);
  if (parsedDiagnostic.code !== providerFailureDiagnosticCode(parsedEvidence)) {
    throw new Error("Provider failure evidence and diagnostic code disagree");
  }
  const identity = providerFailureEvidenceIdentity(parsedEvidence);
  if (canonicalJson(identity) !== canonicalJson(parsedDiagnostic.evidenceIdentity)) {
    throw new Error("Provider failure evidence does not match diagnostic identity");
  }
};
