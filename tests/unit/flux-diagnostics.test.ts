import { describe, expect, it } from "vitest";

import { canonicalIdentity, canonicalJson } from "../../src/core/canonical.js";
import {
  FLUX_DIAGNOSTIC_EVIDENCE_SCHEMA_VERSION,
  FLUX_DIAGNOSTIC_SCHEMA_VERSION,
  PROVIDER_FAILURE_ADAPTER_IDENTITY_SCHEMA_VERSION,
  PROVIDER_FAILURE_EVIDENCE_MAX_BYTES,
  PROVIDER_FAILURE_EVIDENCE_MAX_ISSUES,
  PROVIDER_FAILURE_EVIDENCE_SCHEMA_VERSION,
  PROVIDER_FAILURE_PARSER_IDENTITY_SCHEMA_VERSION,
  PROVIDER_FAILURE_TRANSPORT_IDENTITY_SCHEMA_VERSION,
  assertProviderFailureEvidenceMatchesDiagnostic,
  createFluxDiagnostic,
  createProviderFailureDiagnostic,
  createProviderFailureEvidence,
  parseFluxDiagnostic,
  parseProviderFailureEvidence,
  providerFailureEvidenceIdentity,
  type ProviderFailureEvidenceV1,
} from "../../src/domain/diagnostics.js";

const identity = (schemaVersion: string) => canonicalIdentity(
  { schemaVersion },
  schemaVersion,
);

const evidenceFixture = (): ProviderFailureEvidenceV1 => createProviderFailureEvidence({
  adapter: "codex",
  boundary: "cli_turn_output",
  leaf: "ARGUMENTS_JSON_INVALID",
  providerErrorClass: "MALFORMED",
  checkpoints: {
    outerBytesWithinLimit: true,
    outerJsonParsed: true,
    outerShapeClosed: true,
    outerVersionMatched: true,
    outerTypesValid: true,
    argumentsStringsWithinLimit: true,
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
  },
  identities: {
    adapter: identity(PROVIDER_FAILURE_ADAPTER_IDENTITY_SCHEMA_VERSION),
    parser: identity(PROVIDER_FAILURE_PARSER_IDENTITY_SCHEMA_VERSION),
    transportSchema: identity(PROVIDER_FAILURE_TRANSPORT_IDENTITY_SCHEMA_VERSION),
  },
  observations: {
    outerBytes: 413,
    outerSha256: "1".repeat(64),
    argumentsBytes: 17,
    argumentsSha256: "2".repeat(64),
    issues: [{ path: "$.toolCalls[].argumentsJson", code: "INVALID_JSON", observedType: "string" }],
  },
});

describe("Flux public diagnostics", () => {
  it("projects only a stable closed code and evidence identity", () => {
    const diagnostic = createFluxDiagnostic("PROVIDER_PROCESS_EXIT", {
      adapter: "codex",
      boundary: "cli_process_exit",
      category: "nonzero",
    });
    expect(diagnostic).toEqual(createFluxDiagnostic("PROVIDER_PROCESS_EXIT", {
      category: "nonzero",
      boundary: "cli_process_exit",
      adapter: "codex",
    }));
    expect(diagnostic).toMatchObject({
      schemaVersion: FLUX_DIAGNOSTIC_SCHEMA_VERSION,
      code: "PROVIDER_PROCESS_EXIT",
      evidenceIdentity: {
        algorithm: "sha256",
        schemaVersion: FLUX_DIAGNOSTIC_EVIDENCE_SCHEMA_VERSION,
        canonicalizationVersion: "evleda-c14n-json-v1",
      },
    });
    expect(Reflect.ownKeys(diagnostic)).toEqual(["schemaVersion", "code", "evidenceIdentity"]);
    expect(Object.isFrozen(diagnostic)).toBe(true);
    expect(Object.isFrozen(diagnostic.evidenceIdentity)).toBe(true);
    expect(JSON.stringify(diagnostic)).not.toContain("cli_process_exit");
  });

  it.each([
    { stdout: "private" },
    { apiKey: "private" },
    { category: "C:\\private\\profile.json" },
    { category: "file:/private/profile.json" },
    { category: "Bearer abcdefghijklmnopqrstuvwxyz" },
    { category: "sk-proj-secretvalue" },
  ])("rejects unsafe private diagnostic evidence %#", (evidence) => {
    expect(() => createFluxDiagnostic("PROVIDER_REQUEST_FAILED", evidence)).toThrow();
  });

  it("rejects legacy, extra-field, and wrong-identity public shapes", () => {
    const valid = createFluxDiagnostic("CODEX_CONFIG_INCOMPATIBLE", {
      boundary: "codex_configuration_preflight",
      category: "strict_config",
    });
    expect(parseFluxDiagnostic(valid)).toEqual(valid);
    expect(() => parseFluxDiagnostic({ code: valid.code, evidenceIdentity: valid.evidenceIdentity })).toThrow();
    expect(() => parseFluxDiagnostic({ ...valid, raw: "private" })).toThrow();
    expect(() => parseFluxDiagnostic({
      ...valid,
      evidenceIdentity: { ...valid.evidenceIdentity, schemaVersion: "wrong" },
    })).toThrow();
  });

  it("creates one closed, immutable, bounded private provider-failure record and binds its public identity", () => {
    const evidence = evidenceFixture();
    const bundle = createProviderFailureDiagnostic("PROVIDER_RESPONSE_INVALID", evidence);
    expect(parseProviderFailureEvidence(JSON.parse(JSON.stringify(evidence)))).toEqual(evidence);
    expect(evidence.schemaVersion).toBe(PROVIDER_FAILURE_EVIDENCE_SCHEMA_VERSION);
    expect(Buffer.byteLength(canonicalJson(evidence), "utf8")).toBe(1_614);
    expect(providerFailureEvidenceIdentity(evidence).digest)
      .toBe("1b2b9f2f4002c0d44fe599ad7834ecff21232d0c785680147a953930efc94ffe");
    expect(Buffer.byteLength(canonicalJson(evidence), "utf8")).toBeLessThanOrEqual(PROVIDER_FAILURE_EVIDENCE_MAX_BYTES);
    expect(bundle.diagnostic.evidenceIdentity).toEqual(providerFailureEvidenceIdentity(evidence));
    expect(() => assertProviderFailureEvidenceMatchesDiagnostic(evidence, bundle.diagnostic)).not.toThrow();
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.checkpoints)).toBe(true);
    expect(Object.isFrozen(evidence.identities.transportSchema)).toBe(true);
    expect(Object.isFrozen(evidence.observations.issues)).toBe(true);
    expect(Reflect.ownKeys(evidence)).toEqual([
      "schemaVersion", "adapter", "boundary", "leaf", "providerErrorClass",
      "checkpoints", "identities", "observations",
    ]);
  });

  it("rejects evidence tampering, extra fields, unsafe identity text, and mismatched observation pairs", () => {
    const valid = evidenceFixture();
    const diagnostic = createProviderFailureDiagnostic("PROVIDER_RESPONSE_INVALID", valid).diagnostic;
    const tampered = { ...valid, leaf: "OUTER_JSON_INVALID" };
    expect(() => assertProviderFailureEvidenceMatchesDiagnostic(
      parseProviderFailureEvidence(tampered),
      diagnostic,
    )).toThrow(/does not match/u);
    expect(() => parseProviderFailureEvidence({ ...valid, rawOutput: "private" })).toThrow(/unsupported fields/u);
    expect(() => parseProviderFailureEvidence({
      ...valid,
      identities: {
        ...valid.identities,
        parser: { ...valid.identities.parser, schemaVersion: "sk-proj-secretvalue" },
      },
    })).toThrow(/identity/u);
    expect(() => parseProviderFailureEvidence({
      ...valid,
      observations: { ...valid.observations, outerSha256: null },
    })).toThrow(/sizes and digests disagree/u);
    expect(() => parseProviderFailureEvidence({
      ...valid,
      providerErrorClass: "HTTP",
    })).toThrow(/leaf and error class disagree/u);
    expect(() => parseProviderFailureEvidence({
      ...valid,
      boundary: "cli_temporary_output",
    })).toThrow(/leaf and boundary disagree/u);
    expect(() => parseProviderFailureEvidence({
      ...valid,
      observations: {
        ...valid.observations,
        issues: [{ path: "$", code: "SECONDARY", observedType: "unknown" }],
      },
    })).toThrow(/cleanup-only issue/u);
    expect(() => parseProviderFailureEvidence({
      ...valid,
      checkpoints: { ...valid.checkpoints, raw: false },
    })).toThrow(/unsupported fields/u);
  });

  it.each(["adapter", "parser", "transportSchema"] as const)(
    "rejects a valid-digest provider evidence identity in the wrong %s schema domain",
    (field) => {
      const valid = evidenceFixture();
      expect(() => parseProviderFailureEvidence({
        ...valid,
        identities: {
          ...valid.identities,
          [field]: canonicalIdentity({ field, validDigest: true }, `evleda.wrong-${field.toLowerCase()}.v1`),
        },
      })).toThrow(/identity/u);
    },
  );

  it("binds the public diagnostic code to the private failure leaf and provider class", () => {
    const ordinary = evidenceFixture();
    expect(() => createProviderFailureDiagnostic("SOURCE_DRIFT", ordinary)).toThrow(/diagnostic code disagree/u);
    const ordinaryDiagnostic = createProviderFailureDiagnostic("PROVIDER_RESPONSE_INVALID", ordinary).diagnostic;
    expect(() => assertProviderFailureEvidenceMatchesDiagnostic(
      ordinary,
      { ...ordinaryDiagnostic, code: "PROVIDER_AUTH_UNAVAILABLE" },
    )).toThrow(/diagnostic code disagree/u);

    const cleanupMalformed = createProviderFailureEvidence({
      ...ordinary,
      boundary: "cli_temporary_output",
      leaf: "CLEANUP_SECONDARY",
      providerErrorClass: "MALFORMED",
      observations: {
        ...ordinary.observations,
        issues: [{ path: "$", code: "SECONDARY", observedType: "unknown" }],
      },
    });
    expect(() => createProviderFailureDiagnostic("PROVIDER_RESPONSE_INVALID", cleanupMalformed)).not.toThrow();
    expect(() => createProviderFailureDiagnostic("PROVIDER_REQUEST_FAILED", cleanupMalformed)).toThrow(/diagnostic code disagree/u);
    expect(() => parseProviderFailureEvidence({
      ...cleanupMalformed,
      checkpoints: { ...cleanupMalformed.checkpoints, cleanupCompleted: true },
    })).toThrow(/cleanup failure evidence is contradictory/u);
    expect(() => parseProviderFailureEvidence({
      ...cleanupMalformed,
      observations: { ...cleanupMalformed.observations, issues: [] },
    })).toThrow(/cleanup failure evidence is contradictory/u);

    const cleanupIncomplete = createProviderFailureEvidence({
      ...ordinary,
      boundary: "cli_temporary_output",
      leaf: "CLEANUP_SECONDARY",
      providerErrorClass: "INCOMPLETE",
      observations: {
        ...ordinary.observations,
        issues: [{ path: "$", code: "SECONDARY", observedType: "unknown" }],
      },
    });
    expect(() => createProviderFailureDiagnostic("PROVIDER_REQUEST_FAILED", cleanupIncomplete)).not.toThrow();
    expect(() => createProviderFailureDiagnostic("PROVIDER_RESPONSE_INVALID", cleanupIncomplete)).toThrow(/diagnostic code disagree/u);
  });

  it("enforces the issue allowlists, issue-count ceiling, and 4-KiB hard admission bound", () => {
    const valid = evidenceFixture();
    const maximumIssues = parseProviderFailureEvidence({
      ...valid,
      observations: {
        ...valid.observations,
        issues: Array.from({ length: PROVIDER_FAILURE_EVIDENCE_MAX_ISSUES }, () => ({
          path: "$", code: "SCHEMA", observedType: "unknown",
        })),
      },
    });
    expect(maximumIssues.observations.issues).toHaveLength(PROVIDER_FAILURE_EVIDENCE_MAX_ISSUES);
    expect(Buffer.byteLength(canonicalJson(maximumIssues), "utf8"))
      .toBeLessThanOrEqual(PROVIDER_FAILURE_EVIDENCE_MAX_BYTES);
    expect(() => parseProviderFailureEvidence({
      ...valid,
      observations: {
        ...valid.observations,
        issues: [{ path: "C:\\private\\output.json", code: "INVALID_JSON", observedType: "string" }],
      },
    })).toThrow(/issue/u);
    expect(() => parseProviderFailureEvidence({
      ...valid,
      observations: {
        ...valid.observations,
        issues: Array.from({ length: PROVIDER_FAILURE_EVIDENCE_MAX_ISSUES + 1 }, () => ({
          path: "$", code: "SCHEMA", observedType: "unknown",
        })),
      },
    })).toThrow();
    expect(() => parseProviderFailureEvidence({
      ...valid,
      identities: {
        adapter: {
          ...valid.identities.adapter,
          digest: "a".repeat(PROVIDER_FAILURE_EVIDENCE_MAX_BYTES),
        },
        parser: valid.identities.parser,
        transportSchema: valid.identities.transportSchema,
      },
    })).toThrow();
  });
});
