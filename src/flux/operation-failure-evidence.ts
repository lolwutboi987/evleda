import { canonicalIdentity, canonicalJson } from "../core/canonical.js";
import { hardenPortableValue } from "../core/portable-artifact.js";
import {
  assertProviderFailureEvidenceMatchesDiagnostic,
  createFluxDiagnostic,
  parseFluxDiagnostic,
  parseProviderFailureEvidence,
  PROVIDER_FAILURE_EVIDENCE_MAX_BYTES,
  PROVIDER_FAILURE_EVIDENCE_SCHEMA_VERSION,
  providerFailureEvidenceIdentity,
  FLUX_DIAGNOSTIC_CODES,
  FLUX_DIAGNOSTIC_EVIDENCE_SCHEMA_VERSION,
  type FluxDiagnosticCode,
  type FluxDiagnosticDto,
  type ProviderFailureEvidenceV1
} from "../domain/diagnostics.js";
import type { CanonicalIdentity } from "../domain/types.js";
import {
  PCB_DESIGN_INTERPRETER_ERROR_CODES,
  type PcbDesignInterpreterErrorCode,
} from "../harness/pcb-design-interpreter.js";

export const FLUX_GENERIC_OPERATION_FAILURE_EVIDENCE_SCHEMA_VERSION = "evleda.flux-generic-operation-failure-evidence.v1" as const;
export const FLUX_PCB_INTERPRETER_FAILURE_EVIDENCE_SCHEMA_VERSION = "evleda.flux-pcb-interpreter-failure-evidence.v1" as const;
export const FLUX_LEGACY_OPERATION_FAILURE_EVIDENCE_SCHEMA_VERSION = "evleda.flux-legacy-operation-failure-evidence.v1" as const;
export const FLUX_OPERATION_FAILURE_EVIDENCE_MAX_BYTES = PROVIDER_FAILURE_EVIDENCE_MAX_BYTES;

export const FLUX_GENERIC_OPERATION_FAILURE_CATEGORIES = Object.freeze([
  "flux_error",
  "external_error",
  "invalid_diagnostic",
  "invalid_provider_evidence",
] as const);
export type FluxGenericOperationFailureCategory = (typeof FLUX_GENERIC_OPERATION_FAILURE_CATEGORIES)[number];

export const FLUX_PCB_INTERPRETER_FAILURE_CATEGORIES = Object.freeze([
  "request_validation",
  "provider_output",
  "provider_refusal",
  "provider_failure",
  "compiler",
  "deadline",
  "cancellation",
] as const);
export type FluxPcbInterpreterFailureCategory = (typeof FLUX_PCB_INTERPRETER_FAILURE_CATEGORIES)[number];

const PCB_INTERPRETER_CATEGORY_BY_CODE = Object.freeze({
  INVALID_INPUT: "request_validation",
  PROMPT_TOO_LARGE: "request_validation",
  OUTPUT_TOO_LARGE: "provider_output",
  MALFORMED_PROVIDER_OUTPUT: "provider_output",
  MISSING_TOOL_CALL: "provider_output",
  MULTIPLE_TOOL_CALLS: "provider_output",
  WRONG_TOOL: "provider_output",
  INVALID_DRAFT: "provider_output",
  REFUSED: "provider_refusal",
  PROVIDER_FAILED: "provider_failure",
  COMPILER_FAILED: "compiler",
  COMPILATION_BUNDLE_FAILED: "compiler",
  TIMEOUT: "deadline",
  CANCELLED: "cancellation",
  INVALID_COMPILATION: "compiler",
} satisfies Readonly<Record<PcbDesignInterpreterErrorCode, FluxPcbInterpreterFailureCategory>>);

const PCB_INTERPRETER_DIAGNOSTIC_BY_CODE = Object.freeze({
  INVALID_INPUT: "PROVIDER_RESPONSE_INVALID",
  PROMPT_TOO_LARGE: "PROVIDER_RESPONSE_INVALID",
  OUTPUT_TOO_LARGE: "PROVIDER_RESPONSE_INVALID",
  MALFORMED_PROVIDER_OUTPUT: "PROVIDER_RESPONSE_INVALID",
  MISSING_TOOL_CALL: "PROVIDER_RESPONSE_INVALID",
  MULTIPLE_TOOL_CALLS: "PROVIDER_RESPONSE_INVALID",
  WRONG_TOOL: "PROVIDER_RESPONSE_INVALID",
  INVALID_DRAFT: "PROVIDER_RESPONSE_INVALID",
  REFUSED: "PROVIDER_REQUEST_FAILED",
  PROVIDER_FAILED: "PROVIDER_REQUEST_FAILED",
  COMPILER_FAILED: "TOOLCHAIN_FAILURE",
  COMPILATION_BUNDLE_FAILED: "TOOLCHAIN_FAILURE",
  TIMEOUT: "PROVIDER_DEADLINE_EXCEEDED",
  CANCELLED: "PROVIDER_CANCELLED",
  INVALID_COMPILATION: "TOOLCHAIN_FAILURE",
} satisfies Readonly<Record<PcbDesignInterpreterErrorCode, FluxDiagnosticCode>>);

const PCB_INTERPRETER_PROVIDER_FAILURE_DIAGNOSTIC_CODES = new Set<FluxDiagnosticCode>([
  "PROVIDER_AUTH_UNAVAILABLE",
  "PROVIDER_DEADLINE_EXCEEDED",
  "PROVIDER_CANCELLED",
  "PROVIDER_PROCESS_EXIT",
  "PROVIDER_REQUEST_FAILED",
  "PROVIDER_RESPONSE_INVALID",
]);

export interface FluxGenericOperationFailureEvidenceV1 {
  readonly schemaVersion: typeof FLUX_GENERIC_OPERATION_FAILURE_EVIDENCE_SCHEMA_VERSION;
  readonly kind: "generic";
  readonly boundary: "generic_interpretation";
  readonly category: FluxGenericOperationFailureCategory;
  readonly diagnosticCode: FluxDiagnosticCode;
}

export interface FluxPcbInterpreterFailureEvidenceV1 {
  readonly schemaVersion: typeof FLUX_PCB_INTERPRETER_FAILURE_EVIDENCE_SCHEMA_VERSION;
  readonly kind: "pcb_interpreter";
  readonly boundary: "pcb_design_interpretation";
  readonly category: FluxPcbInterpreterFailureCategory;
  readonly interpreterErrorCode: PcbDesignInterpreterErrorCode;
  readonly diagnosticCode: FluxDiagnosticCode;
}

export interface FluxLegacyOperationFailureEvidenceV1 {
  readonly schemaVersion: typeof FLUX_LEGACY_OPERATION_FAILURE_EVIDENCE_SCHEMA_VERSION;
  readonly kind: "legacy_opaque";
  readonly boundary: "generic_interpretation";
  readonly sourceSchemaVersion: "evleda.flux.v1" | "evleda.flux.v2" | "evleda.flux.v3";
}

export type FluxOperationFailureEvidence =
  | ProviderFailureEvidenceV1
  | FluxGenericOperationFailureEvidenceV1
  | FluxPcbInterpreterFailureEvidenceV1
  | FluxLegacyOperationFailureEvidenceV1;

const genericCategories = new Set<string>(FLUX_GENERIC_OPERATION_FAILURE_CATEGORIES);
const pcbInterpreterCodes = new Set<string>(PCB_DESIGN_INTERPRETER_ERROR_CODES);
const pcbInterpreterCategories = new Set<string>(FLUX_PCB_INTERPRETER_FAILURE_CATEGORIES);
const diagnosticCodes = new Set<string>(FLUX_DIAGNOSTIC_CODES);
const exactKeys = (record: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Reflect.ownKeys(record);
  return actual.length === keys.length && actual.every((key) => typeof key === "string" && keys.includes(key));
};
const freeze = <Value>(value: Value): Value => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

export const parseFluxOperationFailureEvidence = (value: unknown): FluxOperationFailureEvidence => {
  const hardened = hardenPortableValue(value, { maxBytes: FLUX_OPERATION_FAILURE_EVIDENCE_MAX_BYTES, maxDepth: 8, maxNodes: 256, maxArrayLength: 16, maxOwnKeys: 32, maxKeyBytes: 64, maxStringBytes: 160 });
  if (typeof hardened !== "object" || hardened === null || Array.isArray(hardened)) throw new Error("Operation failure evidence is malformed");
  const record = hardened as Record<string, unknown>;
  if (record.schemaVersion === PROVIDER_FAILURE_EVIDENCE_SCHEMA_VERSION) return parseProviderFailureEvidence(record);
  if (record.schemaVersion === FLUX_GENERIC_OPERATION_FAILURE_EVIDENCE_SCHEMA_VERSION) {
    if (!exactKeys(record, ["schemaVersion", "kind", "boundary", "category", "diagnosticCode"]) || record.kind !== "generic" || record.boundary !== "generic_interpretation" ||
      typeof record.category !== "string" || !genericCategories.has(record.category) || typeof record.diagnosticCode !== "string" || !diagnosticCodes.has(record.diagnosticCode)) throw new Error("Generic operation failure evidence is malformed");
    return freeze({ schemaVersion: FLUX_GENERIC_OPERATION_FAILURE_EVIDENCE_SCHEMA_VERSION, kind: "generic", boundary: "generic_interpretation", category: record.category as FluxGenericOperationFailureCategory, diagnosticCode: record.diagnosticCode as FluxDiagnosticCode });
  }
  if (record.schemaVersion === FLUX_PCB_INTERPRETER_FAILURE_EVIDENCE_SCHEMA_VERSION) {
    if (!exactKeys(record, ["schemaVersion", "kind", "boundary", "category", "interpreterErrorCode", "diagnosticCode"]) || record.kind !== "pcb_interpreter" || record.boundary !== "pcb_design_interpretation" ||
      typeof record.category !== "string" || !pcbInterpreterCategories.has(record.category) || typeof record.interpreterErrorCode !== "string" || !pcbInterpreterCodes.has(record.interpreterErrorCode) ||
      typeof record.diagnosticCode !== "string" || !diagnosticCodes.has(record.diagnosticCode)) throw new Error("PCB interpreter failure evidence is malformed");
    const interpreterErrorCode = record.interpreterErrorCode as PcbDesignInterpreterErrorCode;
    const diagnosticCode = record.diagnosticCode as FluxDiagnosticCode;
    const diagnosticMatches = interpreterErrorCode === "PROVIDER_FAILED"
      ? PCB_INTERPRETER_PROVIDER_FAILURE_DIAGNOSTIC_CODES.has(diagnosticCode)
      : diagnosticCode === PCB_INTERPRETER_DIAGNOSTIC_BY_CODE[interpreterErrorCode];
    if (record.category !== PCB_INTERPRETER_CATEGORY_BY_CODE[interpreterErrorCode] || !diagnosticMatches) {
      throw new Error("PCB interpreter failure evidence code, category, and diagnostic disagree");
    }
    return freeze({
      schemaVersion: FLUX_PCB_INTERPRETER_FAILURE_EVIDENCE_SCHEMA_VERSION,
      kind: "pcb_interpreter",
      boundary: "pcb_design_interpretation",
      category: record.category as FluxPcbInterpreterFailureCategory,
      interpreterErrorCode,
      diagnosticCode,
    });
  }
  if (record.schemaVersion === FLUX_LEGACY_OPERATION_FAILURE_EVIDENCE_SCHEMA_VERSION) {
    if (!exactKeys(record, ["schemaVersion", "kind", "boundary", "sourceSchemaVersion"]) || record.kind !== "legacy_opaque" || record.boundary !== "generic_interpretation" ||
      !["evleda.flux.v1", "evleda.flux.v2", "evleda.flux.v3"].includes(String(record.sourceSchemaVersion))) throw new Error("Legacy operation failure evidence is malformed");
    return freeze({ schemaVersion: FLUX_LEGACY_OPERATION_FAILURE_EVIDENCE_SCHEMA_VERSION, kind: "legacy_opaque", boundary: "generic_interpretation", sourceSchemaVersion: record.sourceSchemaVersion as FluxLegacyOperationFailureEvidenceV1["sourceSchemaVersion"] });
  }
  throw new Error("Operation failure evidence schema is unsupported");
};

export const createFluxGenericOperationFailureEvidence = (category: FluxGenericOperationFailureCategory, diagnosticCode: FluxDiagnosticCode): FluxGenericOperationFailureEvidenceV1 =>
  parseFluxOperationFailureEvidence({ schemaVersion: FLUX_GENERIC_OPERATION_FAILURE_EVIDENCE_SCHEMA_VERSION, kind: "generic", boundary: "generic_interpretation", category, diagnosticCode }) as FluxGenericOperationFailureEvidenceV1;

export const createFluxPcbInterpreterFailureEvidence = (
  interpreterErrorCode: PcbDesignInterpreterErrorCode,
  diagnosticCode: FluxDiagnosticCode = PCB_INTERPRETER_DIAGNOSTIC_BY_CODE[interpreterErrorCode],
): FluxPcbInterpreterFailureEvidenceV1 => parseFluxOperationFailureEvidence({
  schemaVersion: FLUX_PCB_INTERPRETER_FAILURE_EVIDENCE_SCHEMA_VERSION,
  kind: "pcb_interpreter",
  boundary: "pcb_design_interpretation",
  category: PCB_INTERPRETER_CATEGORY_BY_CODE[interpreterErrorCode],
  interpreterErrorCode,
  diagnosticCode,
}) as FluxPcbInterpreterFailureEvidenceV1;

export const createFluxLegacyOperationFailureEvidence = (sourceSchemaVersion: FluxLegacyOperationFailureEvidenceV1["sourceSchemaVersion"]): FluxLegacyOperationFailureEvidenceV1 =>
  parseFluxOperationFailureEvidence({ schemaVersion: FLUX_LEGACY_OPERATION_FAILURE_EVIDENCE_SCHEMA_VERSION, kind: "legacy_opaque", boundary: "generic_interpretation", sourceSchemaVersion }) as FluxLegacyOperationFailureEvidenceV1;

export const fluxOperationFailureEvidenceIdentity = (evidence: FluxOperationFailureEvidence): CanonicalIdentity => {
  const parsed = parseFluxOperationFailureEvidence(evidence);
  return parsed.schemaVersion === PROVIDER_FAILURE_EVIDENCE_SCHEMA_VERSION ? providerFailureEvidenceIdentity(parsed) : canonicalIdentity(parsed, FLUX_DIAGNOSTIC_EVIDENCE_SCHEMA_VERSION);
};

export const createFluxOperationFailureDiagnostic = (
  evidence: FluxGenericOperationFailureEvidenceV1 | FluxPcbInterpreterFailureEvidenceV1 | FluxLegacyOperationFailureEvidenceV1,
): FluxDiagnosticDto => {
  const parsed = parseFluxOperationFailureEvidence(evidence);
  if (parsed.schemaVersion === PROVIDER_FAILURE_EVIDENCE_SCHEMA_VERSION) {
    throw new Error("Provider failure evidence requires its provider diagnostic constructor");
  }
  const diagnosticCode = parsed.schemaVersion === FLUX_LEGACY_OPERATION_FAILURE_EVIDENCE_SCHEMA_VERSION
    ? "TOOLCHAIN_FAILURE"
    : parsed.diagnosticCode;
  return createFluxDiagnostic(diagnosticCode, parsed);
};

export const assertFluxOperationFailureEvidenceMatchesDiagnostic = (evidence: FluxOperationFailureEvidence, diagnostic: FluxDiagnosticDto): void => {
  const parsed = parseFluxOperationFailureEvidence(evidence); const parsedDiagnostic = parseFluxDiagnostic(diagnostic);
  if (parsed.schemaVersion === PROVIDER_FAILURE_EVIDENCE_SCHEMA_VERSION) {
    assertProviderFailureEvidenceMatchesDiagnostic(parsed, parsedDiagnostic);
    return;
  }
  const expectedCode = parsed.schemaVersion === FLUX_LEGACY_OPERATION_FAILURE_EVIDENCE_SCHEMA_VERSION ? "TOOLCHAIN_FAILURE" : parsed.diagnosticCode;
  if (parsedDiagnostic.code !== expectedCode || canonicalJson(fluxOperationFailureEvidenceIdentity(parsed)) !== canonicalJson(parsedDiagnostic.evidenceIdentity)) {
    throw new Error("Operation failure evidence does not match diagnostic identity and code");
  }
};
