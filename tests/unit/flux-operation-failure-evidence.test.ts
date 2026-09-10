import { describe, expect, it } from "vitest";

import { canonicalIdentity, canonicalJson } from "../../src/core/canonical.js";
import {
  PCB_DESIGN_INTERPRETER_ERROR_CODES,
  type PcbDesignInterpreterErrorCode,
} from "../../src/harness/pcb-design-interpreter.js";
import {
  FLUX_OPERATION_FAILURE_EVIDENCE_MAX_BYTES,
  FLUX_PCB_INTERPRETER_FAILURE_EVIDENCE_SCHEMA_VERSION,
  assertFluxOperationFailureEvidenceMatchesDiagnostic,
  createFluxOperationFailureDiagnostic,
  createFluxPcbInterpreterFailureEvidence,
  fluxOperationFailureEvidenceIdentity,
  parseFluxOperationFailureEvidence,
  type FluxPcbInterpreterFailureCategory,
} from "../../src/flux/operation-failure-evidence.js";
import type { FluxDiagnosticCode } from "../../src/domain/diagnostics.js";

const expected = Object.freeze({
  INVALID_INPUT: ["request_validation", "PROVIDER_RESPONSE_INVALID"],
  PROMPT_TOO_LARGE: ["request_validation", "PROVIDER_RESPONSE_INVALID"],
  OUTPUT_TOO_LARGE: ["provider_output", "PROVIDER_RESPONSE_INVALID"],
  MALFORMED_PROVIDER_OUTPUT: ["provider_output", "PROVIDER_RESPONSE_INVALID"],
  MISSING_TOOL_CALL: ["provider_output", "PROVIDER_RESPONSE_INVALID"],
  MULTIPLE_TOOL_CALLS: ["provider_output", "PROVIDER_RESPONSE_INVALID"],
  WRONG_TOOL: ["provider_output", "PROVIDER_RESPONSE_INVALID"],
  INVALID_DRAFT: ["provider_output", "PROVIDER_RESPONSE_INVALID"],
  REFUSED: ["provider_refusal", "PROVIDER_REQUEST_FAILED"],
  PROVIDER_FAILED: ["provider_failure", "PROVIDER_REQUEST_FAILED"],
  COMPILER_FAILED: ["compiler", "TOOLCHAIN_FAILURE"],
  COMPILATION_BUNDLE_FAILED: ["compiler", "TOOLCHAIN_FAILURE"],
  TIMEOUT: ["deadline", "PROVIDER_DEADLINE_EXCEEDED"],
  CANCELLED: ["cancellation", "PROVIDER_CANCELLED"],
  INVALID_COMPILATION: ["compiler", "TOOLCHAIN_FAILURE"],
} satisfies Readonly<Record<PcbDesignInterpreterErrorCode, readonly [FluxPcbInterpreterFailureCategory, FluxDiagnosticCode]>>);

describe("Flux PCB interpreter failure evidence", () => {
  it.each(PCB_DESIGN_INTERPRETER_ERROR_CODES)("binds the closed %s class to its category and public diagnostic", (interpreterErrorCode) => {
    const [category, diagnosticCode] = expected[interpreterErrorCode];
    const evidence = createFluxPcbInterpreterFailureEvidence(interpreterErrorCode);
    const parsed = parseFluxOperationFailureEvidence(JSON.parse(JSON.stringify(evidence)));
    const diagnostic = createFluxOperationFailureDiagnostic(evidence);

    expect(evidence).toEqual({
      schemaVersion: FLUX_PCB_INTERPRETER_FAILURE_EVIDENCE_SCHEMA_VERSION,
      kind: "pcb_interpreter",
      boundary: "pcb_design_interpretation",
      category,
      interpreterErrorCode,
      diagnosticCode,
    });
    expect(parsed).toEqual(evidence);
    expect(Reflect.ownKeys(evidence)).toEqual([
      "schemaVersion", "kind", "boundary", "category", "interpreterErrorCode", "diagnosticCode",
    ]);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Buffer.byteLength(canonicalJson(evidence), "utf8")).toBeLessThanOrEqual(FLUX_OPERATION_FAILURE_EVIDENCE_MAX_BYTES);
    expect(diagnostic).toMatchObject({ code: diagnosticCode, evidenceIdentity: fluxOperationFailureEvidenceIdentity(evidence) });
    expect(() => assertFluxOperationFailureEvidenceMatchesDiagnostic(evidence, diagnostic)).not.toThrow();
  });

  it.each([
    "PROVIDER_AUTH_UNAVAILABLE",
    "PROVIDER_DEADLINE_EXCEEDED",
    "PROVIDER_CANCELLED",
    "PROVIDER_PROCESS_EXIT",
    "PROVIDER_REQUEST_FAILED",
    "PROVIDER_RESPONSE_INVALID",
  ] as const)("retains a validated diagnosed PROVIDER_FAILED as %s", (diagnosticCode) => {
    const evidence = createFluxPcbInterpreterFailureEvidence("PROVIDER_FAILED", diagnosticCode);
    expect(evidence).toMatchObject({ category: "provider_failure", interpreterErrorCode: "PROVIDER_FAILED", diagnosticCode });
    expect(createFluxOperationFailureDiagnostic(evidence).code).toBe(diagnosticCode);
  });

  it("rejects unknown, extra, path-bearing, oversized, and internally contradictory evidence", () => {
    const valid = createFluxPcbInterpreterFailureEvidence("INVALID_DRAFT");
    const diagnostic = createFluxOperationFailureDiagnostic(valid);
    const variants: readonly unknown[] = [
      { ...valid, interpreterErrorCode: "UNKNOWN" },
      { ...valid, rawModelText: "private" },
      { ...valid, category: "compiler" },
      { ...valid, diagnosticCode: "TOOLCHAIN_FAILURE" },
      { ...valid, category: "C:\\private\\provider-output.json" },
      { ...valid, rawModelText: "x".repeat(FLUX_OPERATION_FAILURE_EVIDENCE_MAX_BYTES) },
    ];
    for (const variant of variants) expect(() => parseFluxOperationFailureEvidence(variant)).toThrow();
    expect(() => createFluxPcbInterpreterFailureEvidence("PROVIDER_FAILED", "SOURCE_DRIFT")).toThrow(/disagree/u);
    expect(() => assertFluxOperationFailureEvidenceMatchesDiagnostic(valid, {
      ...diagnostic,
      code: "TOOLCHAIN_FAILURE",
    })).toThrow(/does not match/u);
    expect(canonicalJson(fluxOperationFailureEvidenceIdentity(valid))).toBe(canonicalJson(canonicalIdentity(
      valid,
      "evleda.flux-diagnostic-evidence.v1",
    )));
    expect(JSON.stringify(valid)).not.toMatch(/private|provider-output\.json|prompt|message|stack/iu);
  });
});
