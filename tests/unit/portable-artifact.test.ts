import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalPortableJson,
  capturePortableRawBytes,
  hardenPortableValue,
  parsePortableJsonBytes,
  parseCapturedPortableJsonBytes,
  portableCanonicalIdentity,
  portableContentIdentity,
  validateContentIdentity,
  validatePortablePathRefV1,
  validatePortablePublicValueV2,
  validatePrivateRawCaptureReceiptV2,
  validatePublicPortableSemanticsV2,
  validateRawBoundPortableReceiptV2,
  validateToolContentIdentityV1,
  validateTypedCommandPlanV1,
  withCommandPlanIdentity,
  withPrivateRawCaptureReceiptV2Identities,
  withRawBoundReceiptV2Identity,
  withSemanticIdentity,
  type PortableSourceBindingV1,
  type ToolContentIdentityV1
} from "../../src/core/portable-artifact.js";
import { DomainError } from "../../src/domain/errors.js";

interface CanonicalVectorFixture {
  readonly canonicalCases: readonly {
    readonly name: string;
    readonly value: unknown;
    readonly canonicalUtf8: string;
    readonly sha256: string;
  }[];
  readonly pathCases: readonly {
    readonly name: string;
    readonly accepted: boolean;
    readonly value: unknown;
  }[];
  readonly rawJsonAcceptCases: readonly {
    readonly name: string;
    readonly rawUtf8: string;
  }[];
  readonly rawJsonRejectCases: readonly {
    readonly name: string;
    readonly rawUtf8?: string;
    readonly rawHex?: string;
  }[];
  readonly collisionCorpus: readonly {
    readonly name: string;
    readonly relativePaths?: readonly string[];
  }[];
  readonly crossRootD356: { readonly payloadCanonicalUtf8: string };
}

const vectors = JSON.parse(
  readFileSync(new URL("../fixtures/portable-artifact-canonical-v1.json", import.meta.url), "utf8")
) as CanonicalVectorFixture;

const pathRef = (root: "reference" | "run_input" | "run_public" | "run_private", relativePath: string) => ({
  schemaVersion: "evleda.portable-path-ref.v1" as const,
  root,
  relativePath
});

const tool = (role: ToolContentIdentityV1["role"], name: string): ToolContentIdentityV1 => ({
  schemaVersion: "evleda.tool-content-identity.v1",
  role,
  kind: role === "native_validator" ? "native_executable" : "portable_implementation",
  name,
  version: "1.0.0",
  commit: "0123456789abcdef0123456789abcdef01234567",
  contentIdentity: portableContentIdentity(`${name}:content`),
  capabilitiesIdentity: portableContentIdentity(`${name}:capabilities`),
  helpIdentity: portableContentIdentity(`${name}:help`)
});

const sourceBinding: PortableSourceBindingV1 = {
  schemaVersion: "evleda.portable-source-binding.v1",
  sourceRevisionIdentity: portableCanonicalIdentity({ revision: "rev-a" }, "evleda.source-revision.v1"),
  sourceArtifactIdentity: portableContentIdentity("source bytes"),
  sourcePath: pathRef("reference", "robotics-controller-v0.kicad_pcb"),
  sourceContractIdentity: portableCanonicalIdentity({ contract: "native" }, "evleda.source-contract.v1")
};

const commandPlan = withCommandPlanIdentity({
  schemaVersion: "evleda.typed-command-plan.v1",
  tool: tool("native_validator", "kicad-cli"),
  logicalCwd: pathRef("run_input", "candidate"),
  argv: [
    { kind: "literal", value: "pcb" },
    { kind: "literal", value: "drc" },
    { kind: "path", value: pathRef("run_input", "candidate/board.kicad_pcb") }
  ],
  environment: {
    schemaVersion: "evleda.portable-environment-policy.v1",
    pythonHashSeed: "0",
    pythonUtf8: "1",
    locale: "C",
    timezone: "UTC",
    privateFields: [
      { name: "HOME", disposition: "excluded-private" },
      { name: "KICAD_CONFIG_HOME", disposition: "excluded-private" },
      { name: "TEMP", disposition: "excluded-private" },
      { name: "TMP", disposition: "excluded-private" }
    ]
  },
  expectedOutputs: [pathRef("run_private", "captures/board.d356")]
});

describe("portable artifact boundaries", () => {
  it("matches every shared canonical, path, raw parser, and output-collision vector", () => {
    for (const entry of vectors.canonicalCases) {
      expect(canonicalPortableJson(entry.value), entry.name).toBe(entry.canonicalUtf8);
      expect(portableContentIdentity(entry.canonicalUtf8).digest, entry.name).toBe(entry.sha256);
    }
    for (const entry of vectors.pathCases) {
      if (entry.accepted) {
        expect(validatePortablePathRefV1(entry.value), entry.name).toEqual(entry.value);
      } else {
        expect(() => validatePortablePathRefV1(entry.value), entry.name).toThrowError(DomainError);
      }
    }
    for (const entry of vectors.rawJsonAcceptCases) {
      expect(() => parsePortableJsonBytes(Buffer.from(entry.rawUtf8, "utf8")), entry.name).not.toThrow();
    }
    for (const entry of vectors.rawJsonRejectCases) {
      const raw =
        entry.rawHex === undefined
          ? Buffer.from(entry.rawUtf8 ?? "", "utf8")
          : Buffer.from(entry.rawHex, "hex");
      expect(() => parsePortableJsonBytes(raw), entry.name).toThrowError(DomainError);
    }
    const collision = vectors.collisionCorpus.find((entry) => entry.name === "case-colliding-command-outputs");
    if (collision?.relativePaths === undefined) throw new Error("missing collision vector");
    const { commandPlanIdentity: _identity, ...commandPlanDraft } = commandPlan;
    expect(() =>
      withCommandPlanIdentity({
        ...commandPlanDraft,
        expectedOutputs: collision.relativePaths!.map((relativePath) => pathRef("run_public", relativePath))
      })
    ).toThrowError(DomainError);
  });

  it("matches the existing EvlEDA canonical-number and UTF-8 semantics", () => {
    expect(canonicalPortableJson({ z: "😀", safe: 9_007_199_254_740_991, negativeZero: -0, micro: 1e-6 })).toBe(
      '{"micro":0.000001,"negativeZero":0,"safe":9007199254740991,"z":"😀"}'
    );
    expect(() => canonicalPortableJson({ unsupported: 1e21 })).toThrowError(DomainError);
  });

  it("rejects duplicate keys and trailing data before native JSON materialization", () => {
    expect(() => parsePortableJsonBytes(Buffer.from('{"a":1,"a":2}', "utf8"))).toThrowError(DomainError);
    expect(() => parsePortableJsonBytes(Buffer.from('{"a":1} false', "utf8"))).toThrowError(DomainError);
    expect(() => parsePortableJsonBytes(Uint8Array.of(0xc3, 0x28))).toThrowError(DomainError);
    for (const overrides of [
      { maxBytes: -1 },
      { maxDepth: 1.5 },
      { maxNodes: Number.POSITIVE_INFINITY },
      { maxArrayLength: Number.NaN },
      { maxBytes: 16_777_217 },
      { unknown: 1 } as never
    ]) {
      expect(() => parsePortableJsonBytes(Buffer.from("{}"), overrides)).toThrowError(DomainError);
    }
    const accessorLimits = Object.create(null) as { maxBytes?: number };
    Object.defineProperty(accessorLimits, "maxBytes", { enumerable: true, get: () => 1 });
    expect(() => parsePortableJsonBytes(Buffer.from("{}"), accessorLimits)).toThrowError(DomainError);
  });

  it("uses one detached byte snapshot and preserves exact Unicode scalar budgets", () => {
    const raw = Buffer.from('{"value":"before"}', "utf8");
    const snapshot = capturePortableRawBytes(raw);
    raw.fill(0x20);
    expect(parseCapturedPortableJsonBytes(snapshot)).toEqual({ value: "before" });
    expect(snapshot.identity).toEqual(portableContentIdentity('{"value":"before"}'));
    if (typeof SharedArrayBuffer !== "undefined") {
      expect(() => capturePortableRawBytes(new Uint8Array(new SharedArrayBuffer(8)))).toThrowError(DomainError);
    }
    const exactAstral = "😀".repeat(65_536);
    expect(Buffer.byteLength(exactAstral, "utf8")).toBe(262_144);
    expect(() => hardenPortableValue(exactAstral, { maxBytes: 262_146, maxStringBytes: 262_144 })).not.toThrow();
    expect(() => hardenPortableValue(`${exactAstral}a`, { maxBytes: 262_147, maxStringBytes: 262_144 })).toThrowError(DomainError);
    expect(() => parsePortableJsonBytes(Buffer.from('{"value":1e-999}', "utf8"))).toThrowError(DomainError);
    expect(() => parsePortableJsonBytes(Buffer.from('{"value":0.99999999999999999}', "utf8"))).toThrowError(DomainError);
    const digest = "0".repeat(64);
    for (const size of ["0.0", "0e0"]) {
      expect(validateContentIdentity(parsePortableJsonBytes(Buffer.from(`{"algorithm":"sha256","digest":"${digest}","size":${size}}`))).size).toBe(0);
    }
    expect(() => validateContentIdentity(parsePortableJsonBytes(Buffer.from(`{"algorithm":"sha256","digest":"${digest}","size":0.5}`)))).toThrowError(DomainError);
  });

  it("enforces exact canonical aggregate bytes at max and max+1 including escape expansion", () => {
    const exact = ["a".repeat(262_144), "b".repeat(262_144), "c".repeat(262_144), "d".repeat(262_131)];
    expect(Buffer.byteLength(canonicalPortableJson(exact), "utf8")).toBe(1_048_576);
    expect(() => hardenPortableValue(exact)).not.toThrow();
    const over = [...exact.slice(0, 3), "d".repeat(262_132)];
    expect(() => hardenPortableValue(over)).toThrowError(DomainError);
    expect(() => portableCanonicalIdentity({ escaped: "\0".repeat(262_144) }, "evleda.escape-budget.v1")).toThrowError(DomainError);
  });

  it("uses bounded linear public scanning with fixed confusables and cross-key state", () => {
    expect(validatePortablePublicValueV2({ note: "Voltage: 5 V", exact: "cafe\u0301" })).toEqual({ note: "Voltage: 5 V", exact: "cafe\u0301" });
    for (const value of [
      { fi: "le:" }, { C: ":private" }, "CON", "con.txt", "ＣＯＮ", "safe∕．．∕escape",
      "safe⁄..⁄escape", "safe⧵..⧵escape", "C꞉∕escape"
    ]) {
      expect(() => validatePortablePublicValueV2(value)).toThrowError(DomainError);
    }
    for (const scheme of ["file", "http", "https", "ftp", "data", "javascript", "vbscript"]) {
      for (let split = 1; split < scheme.length; split += 1) {
        const prefix = split % 2 === 0 ? scheme.slice(0, split).toUpperCase() : scheme.slice(0, split);
        const suffix = split % 2 === 0 ? scheme.slice(split).toUpperCase() : scheme.slice(split);
        expect(() => validatePortablePublicValueV2({ [`benign ${prefix}`]: `${suffix}:secret` }), `${scheme}@${split}`).toThrowError(DomainError);
      }
    }
    expect(() => validatePortablePublicValueV2({ "benign C": ":/private" })).toThrowError(DomainError);
    const payload = ["A".repeat(250_000), "B".repeat(250_000), "C".repeat(250_000), "D".repeat(250_000)];
    const started = performance.now();
    expect(validatePortablePublicValueV2(payload)).toEqual(payload);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("rejects encoded, split, UNC, device, URI, and non-ASCII paths without rewriting Unicode", () => {
    for (const relativePath of [
      "../escape",
      "safe/../escape",
      "safe/%2f/escape",
      "safe/%2e%2e/escape",
      "C:/escape",
      "\\\\server\\share",
      "\\\\?\\C:\\escape",
      "file://host/share",
      "cafe\u0301.kicad_pcb"
    ]) {
      expect(() => validatePortablePathRefV1(pathRef("run_input", relativePath))).toThrowError(DomainError);
    }
  });

  it("rejects proxies, accessors, cycles, symbols, and sparse arrays", () => {
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "secret", { enumerable: true, get: () => "value" });
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    const symbolValue = { okay: true } as Record<PropertyKey, unknown>;
    symbolValue[Symbol("hidden")] = true;
    const sparse = new Array(2);
    sparse[1] = "present";
    const proxy = new Proxy({}, { getPrototypeOf: () => { throw new Error("proxy trap must not run"); } });

    for (const value of [accessor, cycle, symbolValue, sparse, proxy]) {
      expect(() => hardenPortableValue(value)).toThrowError(DomainError);
    }
  });

  it("enforces exact tool roles/environment fields and returns detached deep-frozen snapshots", () => {
    expect(() =>
      validateToolContentIdentityV1({
        ...tool("native_validator", "bad-tool"),
        kind: "portable_implementation"
      })
    ).toThrowError(DomainError);
    const { commandPlanIdentity: _identity, ...draft } = commandPlan;
    expect(() =>
      withCommandPlanIdentity({
        ...draft,
        environment: { ...draft.environment, privateFields: [] }
      })
    ).toThrowError(DomainError);

    const mutableOutputs = [pathRef("run_private", "reports/result.json")];
    const detached = withCommandPlanIdentity({ ...draft, expectedOutputs: mutableOutputs });
    mutableOutputs[0]!.relativePath = "mutated.json";
    expect(detached.expectedOutputs[0]!.relativePath).toBe("reports/result.json");
    expect(Object.isFrozen(detached)).toBe(true);
    expect(Object.isFrozen(detached.argv)).toBe(true);
    expect(Object.isFrozen(detached.environment)).toBe(true);
    expect(Object.isFrozen(detached.environment.privateFields)).toBe(true);
    expect(Object.isFrozen(detached.expectedOutputs[0])).toBe(true);
  });
});

describe("portable artifact identities", () => {
  it("round-trips command, public semantics, raw binding, and private receipt identities", () => {
    const validatedPlan = validateTypedCommandPlanV1(commandPlan);
    const semantics = withSemanticIdentity({
      schemaVersion: "evleda.public-portable-semantics.v2",
      authority: "integrity-only",
      rawNormalizationProvenance: "requires-private-replay",
      reportKind: "kicad_d356",
      sourceBinding,
      nativeContractIdentity: portableCanonicalIdentity({ native: 1 }, "evleda.native-validation-contract.v1"),
      normalizerContractIdentity: portableCanonicalIdentity({ normalizer: 1 }, "evleda.portable-normalizer-contract.v1"),
      normalizer: tool("portable_normalizer", "portable-normalizer"),
      tool: validatedPlan.tool,
      commandPlanIdentity: validatedPlan.commandPlanIdentity,
      payload: JSON.parse(vectors.crossRootD356.payloadCanonicalUtf8),
      fieldDispositionLedger: [{
        pointer: "/records/via-random-s-tail",
        ruleId: "evleda.portable.normalize-d356-via-random-s-tail.v1",
        occurrenceCount: 273,
        disposition: "normalized",
        normalizedMarker: "<portable-via-s-tail>"
      }],
      findings: [],
      status: "PASS",
      normalizationOutcome: "succeeded",
      lifecycle: "candidate",
      releaseAuthorized: false
    });
    const validatedSemantics = validatePublicPortableSemanticsV2(semantics);
    const privateReceipt = withPrivateRawCaptureReceiptV2Identities({
      schemaVersion: "evleda.private-raw-capture-receipt.v2",
      authority: "private-non-authoritative",
      reportKind: "kicad_d356",
      sourceBinding,
      rawContentIdentity: portableContentIdentity("raw d356 root a"),
      privateRawPath: pathRef("run_private", "captures/root-a.d356"),
      nativeContractIdentity: semantics.nativeContractIdentity,
      normalizerContractIdentity: semantics.normalizerContractIdentity,
      toolIdentity: semantics.tool,
      commandPlanIdentity: validatedPlan.commandPlanIdentity,
      invocationIdentity: portableCanonicalIdentity({ invocation: 1 }, "evleda.tool-invocation.v1"),
      stdoutIdentity: portableContentIdentity("stdout"),
      stderrIdentity: portableContentIdentity(""),
      exitCode: 0,
      outcome: "succeeded",
      publicSemanticIdentity: semantics.semanticIdentity,
      capturedAt: "2026-09-05T00:00:00.000Z",
      timestampDisposition: "excluded-private"
    });
    const validatedPrivate = validatePrivateRawCaptureReceiptV2(privateReceipt);
    const rawBound = withRawBoundReceiptV2Identity({
      schemaVersion: "evleda.raw-bound-portable-receipt.v2",
      reportKind: "kicad_d356",
      sourceBinding,
      rawContentIdentity: validatedPrivate.rawContentIdentity,
      portableSemanticIdentity: validatedSemantics.semanticIdentity,
      portableDocumentIdentity: validatedSemantics.documentIdentity,
      normalizerContentIdentity: semantics.normalizer.contentIdentity,
      toolIdentity: semantics.tool,
      commandPlanIdentity: validatedPlan.commandPlanIdentity,
      captureIdentity: portableCanonicalIdentity({ capture: "manual" }, "evleda.portable-capture-command-envelope.v1"),
      lifecycle: "candidate",
      releaseAuthorized: false
    });

    expect(validateRawBoundPortableReceiptV2(rawBound).portableSemanticIdentity).toEqual(semantics.semanticIdentity);
    const wrongSchema = JSON.parse(JSON.stringify(rawBound)) as Record<string, unknown>;
    wrongSchema.portableSemanticIdentity = portableCanonicalIdentity({}, "evleda.wrong-identity.v1");
    const { receiptIdentity: _receiptIdentity, ...wrongPreimage } = wrongSchema;
    wrongSchema.receiptIdentity = portableCanonicalIdentity(wrongPreimage, "evleda.raw-bound-portable-receipt.v2");
    expect(() => validateRawBoundPortableReceiptV2(wrongSchema)).toThrowError(DomainError);

    const pdfDraft = {
      schemaVersion: "evleda.private-raw-capture-receipt.v2" as const,
      authority: "private-non-authoritative" as const,
      reportKind: "kicad_pdf" as const,
      sourceBinding,
      rawContentIdentity: portableContentIdentity("%PDF"),
      privateRawPath: pathRef("run_private", "captures/report.pdf"),
      nativeContractIdentity: semantics.nativeContractIdentity,
      normalizerContractIdentity: semantics.normalizerContractIdentity,
      toolIdentity: semantics.tool,
      commandPlanIdentity: validatedPlan.commandPlanIdentity,
      invocationIdentity: portableCanonicalIdentity({ invocation: "pdf" }, "evleda.tool-invocation.v1"),
      stdoutIdentity: portableContentIdentity(""),
      stderrIdentity: portableContentIdentity(""),
      exitCode: 0,
      outcome: "succeeded" as const,
      publicSemanticIdentity: null,
      capturedAt: "2026-09-05T00:00:00.000Z",
      timestampDisposition: "excluded-private" as const
    };
    expect(withPrivateRawCaptureReceiptV2Identities(pdfDraft).publicSemanticIdentity).toBeNull();
    expect(() =>
      withPrivateRawCaptureReceiptV2Identities({ ...pdfDraft, publicSemanticIdentity: semantics.semanticIdentity })
    ).toThrowError(DomainError);
    expect(() =>
      withPrivateRawCaptureReceiptV2Identities({ ...pdfDraft, reportKind: "kicad_stats" })
    ).toThrowError(DomainError);
    expect(() =>
      withPrivateRawCaptureReceiptV2Identities({ ...pdfDraft, outcome: "failed", exitCode: 0 })
    ).toThrowError(DomainError);
    expect(() =>
      withPrivateRawCaptureReceiptV2Identities({ ...pdfDraft, capturedAt: "٢٠٢٦-٠٩-٠٥T٠٠:٠٠:٠٠Z" })
    ).toThrowError(DomainError);
    expect(() => withPrivateRawCaptureReceiptV2Identities({ ...pdfDraft, capturedAt: "0000-01-01T00:00:00.000Z" })).toThrowError(DomainError);
    expect(withPrivateRawCaptureReceiptV2Identities({ ...pdfDraft, capturedAt: "0001-01-01T00:00:00.000Z" }).capturedAt).toBe("0001-01-01T00:00:00.000Z");
    expect(() => portableCanonicalIdentity({}, "evleda.test.v١")).toThrowError(DomainError);
  });

  it("never upcasts legacy schemas or permits run_private in public source bindings", () => {
    expect(() => validatePublicPortableSemanticsV2({ schemaVersion: "evleda.public-portable-semantics.v0" })).toThrowError(DomainError);
    const invalid = { ...sourceBinding, sourcePath: pathRef("run_private", "source.kicad_pcb") };
    expect(() =>
      withSemanticIdentity({
        schemaVersion: "evleda.public-portable-semantics.v2",
        authority: "integrity-only",
        rawNormalizationProvenance: "requires-private-replay",
        reportKind: "kicad_d356",
        sourceBinding: invalid,
        nativeContractIdentity: portableCanonicalIdentity({}, "evleda.native-validation-contract.v1"),
        normalizerContractIdentity: portableCanonicalIdentity({}, "evleda.portable-normalizer-contract.v1"),
        normalizer: tool("portable_normalizer", "normalizer"),
        tool: commandPlan.tool,
        commandPlanIdentity: commandPlan.commandPlanIdentity,
        payload: {
          schemaVersion: "evleda.portable-kicad-d356-rev-a.v2",
          reportKind: "kicad_d356",
          headers: ["P  CODE 00", "P  UNITS CUST 0", "P  arrayDim   N"],
          records: ["327USB_DM_CONN      R7    -1          A01X+019951Y-013189X0315Y0374R000S2", "999"]
        },
        fieldDispositionLedger: [],
        findings: [],
        status: "PASS",
        normalizationOutcome: "succeeded",
        lifecycle: "candidate",
        releaseAuthorized: false
      })
    ).toThrowError(DomainError);
  });
});
