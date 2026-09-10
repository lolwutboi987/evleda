import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalPortableBytes,
  canonicalPortableJson,
  portableCanonicalIdentity,
  portableContentIdentity,
  withCommandPlanIdentity,
  withPrivateRawCaptureReceiptV2Identities,
  withSemanticIdentity,
  type PortableReportKind,
  type ToolContentIdentityV1
} from "../../src/core/portable-artifact.js";
import {
  normalizeKiCadD356,
  normalizeKiCadDrc,
  normalizeKiCadErc,
  normalizeKiCadNetlist,
  normalizeKiCadPdfV2,
  normalizeKiCadStats,
  validatePortableNormalizationResultV2,
  verifyPortableNormalizationCompoundV2,
  verifyPortablePdfCompoundV2,
  type PortableNormalizationBindingsV2,
  type PortableNormalizationResultV2
} from "../../src/integrations/kicad-validation-normalizer.js";
import { DomainError } from "../../src/domain/errors.js";

interface PairVector {
  readonly rawA: string;
  readonly rawB: string;
  readonly semanticCanonicalUtf8A: string;
  readonly semanticCanonicalUtf8B: string;
  readonly semanticCanonicalSha256A: string;
  readonly semanticCanonicalSha256B: string;
  readonly semanticIdentityDigest: string;
  readonly semanticIdentitiesEqual: boolean;
  readonly documentIdentityDigestA: string;
  readonly documentIdentityDigestB: string;
  readonly rawAIdentity: { readonly algorithm: "sha256"; readonly digest: string; readonly size: number };
  readonly rawBIdentity: { readonly algorithm: "sha256"; readonly digest: string; readonly size: number };
  readonly receiptADigest: string;
  readonly receiptBDigest: string;
}

interface NormalizerVectorFixture {
  readonly collisionCorpus: readonly { readonly name: string; readonly rawStatsUtf8?: string }[];
  readonly publicRecursiveLeakCases: readonly {
    readonly name: string;
    readonly kind: "stats" | "erc" | "drc" | "netlist";
    readonly rawUtf8: string;
  }[];
  readonly registeredSeparatorPositiveCases: readonly {
    readonly name: string;
    readonly kind: "stats" | "erc" | "drc" | "netlist";
    readonly rawUtf8: string;
    readonly semanticIdentityDigest: string;
    readonly documentIdentityDigest: string;
  }[];
  readonly d356RejectCases: readonly { readonly name: string; readonly rawUtf8?: string; readonly rawHex?: string }[];
  readonly netlistRejectCases: readonly { readonly name: string; readonly rawUtf8?: string; readonly rawHex?: string }[];
  readonly shallowDocumentRejectCases: readonly {
    readonly name: string;
    readonly kind: "erc" | "drc" | "stats";
    readonly rawUtf8: string;
  }[];
  readonly crossRootD356: PairVector & {
    readonly payloadCanonicalUtf8: string;
    readonly payloadSha256: string;
  };
  readonly directVolatileErc: PairVector;
  readonly directVolatileDrc: PairVector;
  readonly directVolatileStats: PairVector;
  readonly directVolatileNetlist: PairVector;
  readonly pdfNotRun: {
    readonly rawUtf8: string;
    readonly canonicalUtf8: string;
    readonly canonicalSha256: string;
    readonly value: unknown;
  };
}

const vectors = JSON.parse(
  readFileSync(new URL("../fixtures/portable-artifact-canonical-v1.json", import.meta.url), "utf8")
) as NormalizerVectorFixture;

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

const pathRef = (root: "reference" | "run_input" | "run_private", relativePath: string) => ({
  schemaVersion: "evleda.portable-path-ref.v1" as const, root, relativePath
});

const bindings = (capture: string, reportKind: PortableReportKind): PortableNormalizationBindingsV2 => {
  const schematic = reportKind === "kicad_erc" || reportKind === "kicad_netlist";
  const sourceName = schematic ? "robotics-controller-v0.kicad_sch" : "robotics-controller-v0.kicad_pcb";
  const outputName = ({
    kicad_erc: "capture.erc.json", kicad_drc: "capture.drc.json", kicad_netlist: "capture.kicad_net",
    kicad_stats: "capture.stats.json", kicad_d356: "capture.d356"
  } as const)[reportKind];
  const literal = (value: string) => ({ kind: "literal" as const, value });
  const path = (value: ReturnType<typeof pathRef>) => ({ kind: "path" as const, value });
  const prefix = ({
    kicad_erc: ["sch", "erc", "--format", "json", "--units", "mm", "--severity-all", "--exit-code-violations", "--output"],
    kicad_drc: ["pcb", "drc", "--schematic-parity", "--refill-zones", "--save-board", "--format", "json", "--units", "mm", "--severity-all", "--exit-code-violations", "--output"],
    kicad_netlist: ["sch", "export", "netlist", "--output"],
    kicad_stats: ["pcb", "export", "stats", "--format", "json", "--output"],
    kicad_d356: ["pcb", "export", "ipcd356", "--output"]
  } as const)[reportKind];
  const outputPath = pathRef("run_private", `captures/${outputName}`);
  const commandPlan = withCommandPlanIdentity({
    schemaVersion: "evleda.typed-command-plan.v1",
    tool: tool("native_validator", "kicad-cli"),
    logicalCwd: pathRef("run_input", "candidate"),
    argv: [...prefix.map(literal), path(outputPath), path(pathRef("run_input", sourceName))],
    environment: {
      schemaVersion: "evleda.portable-environment-policy.v1", pythonHashSeed: "0", pythonUtf8: "1", locale: "C", timezone: "UTC",
      privateFields: [
        { name: "HOME", disposition: "excluded-private" }, { name: "KICAD_CONFIG_HOME", disposition: "excluded-private" },
        { name: "TEMP", disposition: "excluded-private" }, { name: "TMP", disposition: "excluded-private" }
      ]
    },
    expectedOutputs: [outputPath]
  });
  return {
  schemaVersion: "evleda.portable-normalization-bindings.v2",
  sourceBinding: {
    schemaVersion: "evleda.portable-source-binding.v1",
    sourceRevisionIdentity: portableCanonicalIdentity({ revision: "rev-a" }, "evleda.source-revision.v1"),
    sourceArtifactIdentity: portableContentIdentity("source bytes"),
    sourcePath: pathRef("run_input", sourceName),
    sourceContractIdentity: portableCanonicalIdentity({ contract: "native" }, "evleda.source-contract.v1")
  },
  nativeContractIdentity: portableCanonicalIdentity({ native: 1 }, "evleda.native-validation-contract.v1"),
  normalizerContractIdentity: portableCanonicalIdentity({ normalizer: 1 }, "evleda.portable-normalizer-contract.v1"),
  normalizer: tool("portable_normalizer", "portable-normalizer"),
  commandPlan,
  nativeOutcome: {
    schemaVersion: "evleda.native-command-outcome.v1",
    invocationIdentity: portableCanonicalIdentity({ capture, reportKind }, "evleda.tool-invocation.v1"),
    outcome: "succeeded", exitCode: 0, accepted: true, complete: true
  }
  };
};

const D356_RECORD = "327USB_DM_CONN      R7    -1          A01X+019951Y-013189X0315Y0374R000S2";
const REAL_D356 = readFileSync(
  new URL(
    "../../reference-designs/robotics-controller-v0/validation/runs/20260905T041400.496613Z-8b7f124253b42c31/outputs/board-netlist.d356",
    import.meta.url
  )
);
const REAL_STATS = readFileSync(
  new URL(
    "../../reference-designs/robotics-controller-v0/validation/runs/20260905T041400.496613Z-8b7f124253b42c31/outputs/board-statistics.json",
    import.meta.url
  )
);
const REAL_PCB = readFileSync(
  new URL("../../reference-designs/robotics-controller-v0/validation/runs/20260905T041400.496613Z-8b7f124253b42c31/evidence/drc-evaluated/robotics-controller-v0.kicad_pcb", import.meta.url)
);

const alternateD356Capture = (raw: Uint8Array): Buffer => {
  const lines = Buffer.from(raw).toString("ascii").replaceAll("\r\n", "\n").trimEnd().split("\n");
  const changed = lines.map((line) =>
    /^(?:307|317).{17}VIA .+R[0-9]{3}S[+-]?[0-9]+$/u.test(line)
      ? line.replace(/S[+-]?[0-9]+$/u, "S+123456789")
      : line
  );
  return Buffer.from(`${changed.join("\r\n")}\r\n`, "ascii");
};

const d356CaptureWithTail = (raw: Uint8Array, tail: string, crlf: boolean): Buffer => {
  const lines = Buffer.from(raw).toString("ascii").replaceAll("\r\n", "\n").trimEnd().split("\n");
  const changed = lines.map((line) =>
    /^(?:307|317).{17}VIA .+R[0-9]{3}S[+-]?[0-9]+$/u.test(line)
      ? line.replace(/S[+-]?[0-9]+$/u, `S${tail}`)
      : line
  );
  const newline = crlf ? "\r\n" : "\n";
  return Buffer.from(`${changed.join(newline)}${newline}`, "ascii");
};

const netlistRaw = (drive: string, date: string, relocatedUri?: string): Buffer => {
  const sourceField =
    relocatedUri === undefined
      ? '(field (name "Source") "http://www.ti.com/lit/ds/symlink/example.pdf")'
      : `(field (name "Source") "${relocatedUri}")`;
  const comments = Array.from(
    { length: 9 },
    (_, index) => `(comment (number "${index + 1}") (value "${index < 4 ? `note-${index + 1}` : ""}"))`
  ).join(" ");
  return Buffer.from(
    `(export (version "E") (design (source "${drive}:\\\\root\\\\board.kicad_sch") (date "${date}") (tool "Eeschema 10.0.3") (sheet (number "1") (name "/") (tstamps "/") (title_block (title "Candidate") (company "EvlEDA") (rev "A") (date "nested-date") (source "nested-source") ${comments}))) (components (comp (ref "U1") (value "STM32") (footprint "Package_QFP:LQFP-48") (fields (field (name "Reference") "U") ${sourceField}) (libsource (lib "L") (part "P") (description "STM32")) (property (name "Sheetname") (value "")) (property (name "Sheetfile") (value "board.kicad_sch")) (sheetpath (names "/") (tstamps "/")) (tstamps "54bebf12-977b-4e66-a5a7-f68da859c4d2") (units (unit (name "A") (pins (pin (num "1"))))))) (groups) (variants) (libparts (libpart (lib "L") (part "P") (description "STM32") (docs "https://www.st.com/resource/en/datasheet/example.pdf") (fields (field (name "Reference") "U")) (pins (pin (num "1") (name "P") (type "passive"))))) (libraries (library (logical "L") (uri "\${KIPRJMOD}/symbols/L.kicad_sym"))) (nets (net (code "1") (name "GND") (class "Default") (node (ref "U1") (pin "1") (pintype "passive")))))`,
    "utf8"
  );
};

const assertPairVector = (
  vector: PairVector,
  normalize: (rawBytes: Uint8Array, inputBindings: PortableNormalizationBindingsV2) => PortableNormalizationResultV2,
  capturePrefix: string,
  reportKind: PortableReportKind
): readonly [PortableNormalizationResultV2, PortableNormalizationResultV2] => {
  const left = normalize(Buffer.from(vector.rawA, "utf8"), bindings(`${capturePrefix}-a`, reportKind));
  const right = normalize(Buffer.from(vector.rawB, "utf8"), bindings(`${capturePrefix}-b`, reportKind));
  expect(canonicalPortableJson(left.semantics)).toBe(vector.semanticCanonicalUtf8A);
  expect(canonicalPortableJson(right.semantics)).toBe(vector.semanticCanonicalUtf8B);
  expect(portableContentIdentity(canonicalPortableBytes(left.semantics)).digest).toBe(vector.semanticCanonicalSha256A);
  expect(portableContentIdentity(canonicalPortableBytes(right.semantics)).digest).toBe(vector.semanticCanonicalSha256B);
  expect(vector.semanticIdentitiesEqual).toBe(true);
  expect(left.semantics.semanticIdentity.digest).toBe(vector.semanticIdentityDigest);
  expect(right.semantics.semanticIdentity.digest).toBe(vector.semanticIdentityDigest);
  expect(left.semantics.documentIdentity.digest).toBe(vector.documentIdentityDigestA);
  expect(right.semantics.documentIdentity.digest).toBe(vector.documentIdentityDigestB);
  expect(left.rawBoundReceipt.rawContentIdentity).toEqual(vector.rawAIdentity);
  expect(right.rawBoundReceipt.rawContentIdentity).toEqual(vector.rawBIdentity);
  expect(left.rawBoundReceipt.receiptIdentity.digest).toBe(vector.receiptADigest);
  expect(right.rawBoundReceipt.receiptIdentity.digest).toBe(vector.receiptBDigest);
  return [left, right];
};

describe("KiCad validation normalizers", () => {
  it("matches exact shared cross-language vectors for every public kind and PDF NOT_RUN", () => {
    const d356 = vectors.crossRootD356;
    const [d356A] = assertPairVector(d356, normalizeKiCadD356, "root", "kicad_d356");
    expect(canonicalPortableJson(d356A.semantics.payload)).toBe(d356.payloadCanonicalUtf8);
    expect(portableContentIdentity(canonicalPortableBytes(d356A.semantics.payload)).digest).toBe(d356.payloadSha256);
    assertPairVector(vectors.directVolatileErc, normalizeKiCadErc, "erc", "kicad_erc");
    assertPairVector(vectors.directVolatileDrc, normalizeKiCadDrc, "drc", "kicad_drc");
    assertPairVector(vectors.directVolatileStats, normalizeKiCadStats, "stats", "kicad_stats");
    assertPairVector(vectors.directVolatileNetlist, normalizeKiCadNetlist, "netlist", "kicad_netlist");

    const pdf = normalizeKiCadPdfV2(Buffer.from(vectors.pdfNotRun.rawUtf8, "utf8"));
    expect(pdf).toEqual(vectors.pdfNotRun.value);
    expect(canonicalPortableJson(pdf)).toBe(vectors.pdfNotRun.canonicalUtf8);
    expect(portableContentIdentity(canonicalPortableBytes(pdf)).digest).toBe(vectors.pdfNotRun.canonicalSha256);
  });

  it("produces byte-identical D356 semantics across roots while raw receipts remain distinct", () => {
    const lf = REAL_D356;
    const crlf = alternateD356Capture(lf);
    const left = normalizeKiCadD356(lf, bindings("root-a", "kicad_d356"));
    const right = normalizeKiCadD356(crlf, bindings("root-b", "kicad_d356"));

    expect(canonicalPortableJson(left.semantics)).toBe(canonicalPortableJson(right.semantics));
    expect(left.semantics.semanticIdentity).toEqual(right.semantics.semanticIdentity);
    expect(left.rawBoundReceipt.rawContentIdentity).not.toEqual(right.rawBoundReceipt.rawContentIdentity);
    expect(left.rawBoundReceipt.receiptIdentity).not.toEqual(right.rawBoundReceipt.receiptIdentity);
  });

  it("normalizes six distinct 273-record VIA-tail captures to one public D356 identity", () => {
    const tails = ["-1", "+1", "0", "+123456789", "-2147483648", "+2147483647"];
    const results = tails.map((tail, index) =>
      normalizeKiCadD356(d356CaptureWithTail(REAL_D356, tail, index % 2 === 1), bindings(`six-${index}`, "kicad_d356"))
    );
    expect(new Set(results.map((entry) => entry.semantics.payloadIdentity.digest)).size).toBe(1);
    expect(new Set(results.map((entry) => entry.rawBoundReceipt.rawContentIdentity.digest)).size).toBe(6);
    for (const result of results) {
      expect(result.semantics.fieldDispositionLedger).toContainEqual({
        pointer: "/records/via-random-s-tail", ruleId: "evleda.portable.normalize-d356-via-random-s-tail.v1",
        occurrenceCount: 273, disposition: "normalized", normalizedMarker: "<portable-via-s-tail>"
      });
    }
  });

  it("normalizes direct ERC source/date into a closed projection and derives fail-closed findings", () => {
    const rawDocument = {
      $schema: "https://schemas.kicad.org/erc.v1.json",
      coordinate_units: "mm",
      date: "2026-09-05T10:00:00",
      ignored_checks: [{ key: "ignored", description: "Ignored rule" }],
      included_severities: ["error", "warning"],
      kicad_version: "10.0.3",
      sheets: [
        {
          path: "/",
          uuid_path: "/54bebf12-977b-4e66-a5a7-f68da859c4d2",
          violations: [{ type: "pin_not_connected", severity: "warning", description: "Pin is not connected" }]
        }
      ],
      source: "C:\\root-a\\board.kicad_sch"
    };
    const raw = Buffer.from(JSON.stringify(rawDocument), "utf8");
    const before = Buffer.from(raw);
    const result = normalizeKiCadErc(raw, bindings("erc", "kicad_erc"));
    const payload = result.semantics.payload;

    expect(raw).toEqual(before);
    expect(payload.reportKind).toBe("kicad_erc");
    if (payload.reportKind !== "kicad_erc") throw new Error("unexpected payload");
    expect(payload.document.date).toBe("<portable-date>");
    expect(payload.document.source).toBe("<portable-source>");
    expect(payload.document.sheets).toMatchObject([{ path: "/", uuid_path: "/54bebf12-977b-4e66-a5a7-f68da859c4d2" }]);
    expect(result.semantics.fieldDispositionLedger.map((entry) => entry.pointer)).toEqual(["/date", "/source"]);
    expect(result.semantics.status).toBe("UNKNOWN");
    expect(result.semantics.findings).toContainEqual(
      { ruleId: "pin_not_connected", severity: "warning", message: "Pin is not connected", occurrenceCount: 1 }
    );
    expect(result.semantics.findings).toContainEqual(
      { ruleId: "ignored_check.ignored", severity: "exclusion", message: "Ignored rule", occurrenceCount: 1 }
    );
  });

  it("keeps DRC and observational statistics UNKNOWN and emits closed projections", () => {
    const drc = Buffer.from(
      JSON.stringify({
        $schema: "https://schemas.kicad.org/drc.v1.json",
        coordinate_units: "mm",
        date: "2026-09-05T10:00:00",
        ignored_checks: [],
        included_severities: ["error"],
        kicad_version: "10.0.3",
        schematic_parity: [],
        source: "D:\\root-b\\board.kicad_pcb",
        unconnected_items: [],
        violations: []
      }),
      "utf8"
    );
    expect(normalizeKiCadDrc(drc, bindings("drc", "kicad_drc")).semantics.status).toBe("UNKNOWN");

    const stats = REAL_STATS;
    const statsResult = normalizeKiCadStats(stats, bindings("stats", "kicad_stats"));
    if (statsResult.semantics.payload.reportKind !== "kicad_stats") throw new Error("unexpected payload");
    expect(statsResult.semantics.status).toBe("UNKNOWN");
    expect(statsResult.semantics.payload.document.metadata).toEqual({
      date: "<portable-date>", generator: "KiCad 10.0.3", project: "robotics-controller-v0", board_name: "robotics-controller-v0"
    });
  });

  it("preserves netlist atom/string distinction and normalizes only direct design source/date", () => {
    const raw = netlistRaw("C", "2026-09-05");
    const result = normalizeKiCadNetlist(raw, bindings("netlist", "kicad_netlist"));
    const encoded = canonicalPortableJson(result.semantics.payload);

    expect(encoded).toContain('"value":"<portable-source>"');
    expect(encoded).toContain('"value":"<portable-date>"');
    expect(encoded).toContain('"kind":"string","value":"STM32"');
    expect(encoded).toContain('"kind":"atom","value":"value"');
    expect(encoded).toContain('"value":"nested-source"');
    expect(encoded).toContain('"value":"nested-date"');
  });

  it("implements exact KiCad lexer whitespace, escape, control, and astral boundaries", () => {
    const base = netlistRaw("C", "now").toString("utf8");
    const run = (text: string, capture: string) => normalizeKiCadNetlist(Buffer.from(text, "utf8"), bindings(capture, "kicad_netlist"));
    const hex = run(base.replace('(value "STM32")', `(value "${String.raw`\x41`}")`), "hex-two");
    expect(canonicalPortableJson(hex.semantics.payload)).toContain('"value":"A"');
    const octal = run(base.replace('(value "STM32")', `(value "${String.raw`\101`}")`), "octal-three");
    expect(canonicalPortableJson(octal.semantics.payload)).toContain('"value":"A"');
    expect(() => run(base.replace('(version "E") (design', '(version "E")\0(design'), "nul-space")).not.toThrow();
    expect(() => run(base.replace('(version "E")', '(version"E")'), "adjacent-quote")).toThrowError(/Invalid character/u);
    expect(() => run(base.replace('(value "STM32")', `(value "${String.raw`\u0041`}")`), "unicode-escape")).toThrowError(/Invalid KiCad netlist escape/u);
    expect(() => run(base.replace('(version "E") (design', '(version "E")\u00a0(design'), "unicode-space")).toThrowError(DomainError);
    expect(() => run(base.replace('(version "E") (design', '(version "E")\u0001(design'), "control-space")).toThrowError(/Invalid character/u);
    for (const escaped of [String.raw`\a`, String.raw`\v`, String.raw`\x4`]) {
      expect(() => run(base.replace('(value "STM32")', `(value "${escaped}")`), `control-${escaped}`)).toThrowError(/control leak|Public path|closed-relative-logical-path/u);
    }
    const exactAstral = "😀".repeat(65_536);
    expect(() => run(base.replace('(title "Candidate")', `(title "${exactAstral}")`), "astral-max")).not.toThrow();
    expect(() => run(base.replace('(title "Candidate")', `(title "${exactAstral}😀")`), "astral-over")).toThrowError(/string budget/u);
  });

  it("rejects relationally corrupt KiCad netlists even when every local form is well-shaped", () => {
    const base = netlistRaw("C", "now").toString("utf8");
    const replaceLast = (text: string, search: string, replacement: string): string => {
      const index = text.lastIndexOf(search);
      if (index < 0) throw new Error("mutation source missing");
      return `${text.slice(0, index)}${replacement}${text.slice(index + search.length)}`;
    };
    const libpartsStart = base.indexOf("(libparts");
    const absentLibrary = `${base.slice(0, libpartsStart)}${base.slice(libpartsStart).replace('(lib "L")', '(lib "X")')}`;
    const netOne = '(net (code "1") (name "GND") (class "Default") (node (ref "U1") (pin "1") (pintype "passive")))';
    const netTwo = '(net (code "2") (name "VCC") (class "Default") (node (ref "U1") (pin "1") (pintype "passive")))';
    const mutations = [
      base.replace('(libsource (lib "L") (part "P")', '(libsource (lib "L") (part "Q")'),
      absentLibrary,
      base.replace('(units (unit (name "A") (pins (pin (num "1")))))', '(units (unit (name "A") (pins (pin (num "2")))))'),
      replaceLast(base, '(ref "U1")', '(ref "U2")'),
      replaceLast(base, '(pin "1")', '(pin "2")'),
      base.replace(`(nets ${netOne})`, `(nets ${netOne} ${netTwo})`)
    ];
    for (const [index, mutation] of mutations.entries()) {
      expect(() => normalizeKiCadNetlist(Buffer.from(mutation), bindings(`relational-${index}`, "kicad_netlist"))).toThrowError(DomainError);
    }
  });

  it("rejects drive-relative nicknames and every drive-relative filter token", () => {
    const base = netlistRaw("C", "now").toString("utf8");
    expect(() => normalizeKiCadNetlist(Buffer.from(base), bindings("valid-nickname", "kicad_netlist"))).not.toThrow();
    for (const nickname of ["C:private", "C:.", "C:..", "Ｃ：private"]) {
      const changed = base.replace('Package_QFP:LQFP-48', nickname);
      expect(() => normalizeKiCadNetlist(Buffer.from(changed), bindings(`nickname-${nickname}`, "kicad_netlist"))).toThrowError(DomainError);
    }
    for (const token of ["C:private", "C:.", "C:..", "Ｃ：private"]) {
      const changed = base.replace(
        '(property (name "Sheetfile") (value "board.kicad_sch")) (sheetpath',
        `(property (name "Sheetfile") (value "board.kicad_sch")) (property (name "ki_fp_filters") (value "Package_QFP:LQFP-* ${token}")) (sheetpath`
      );
      expect(() => normalizeKiCadNetlist(Buffer.from(changed), bindings(`filter-${token}`, "kicad_netlist"))).toThrowError(DomainError);
    }
  });

  it("derives authority/status, rejects coherent privacy and ledger tampering, and deeply freezes outputs", () => {
    const errorErc = Buffer.from(
      JSON.stringify({
        $schema: "https://schemas.kicad.org/erc.v1.json",
        coordinate_units: "mm",
        date: "now",
        ignored_checks: [],
        included_severities: ["error"],
        kicad_version: "10.0.3",
        sheets: [
          {
            path: "/",
            uuid_path: "/54bebf12-977b-4e66-a5a7-f68da859c4d2",
            violations: [{ type: "fatal", severity: "error", description: "Fatal finding" }]
          }
        ],
        source: "board.kicad_sch"
      })
    );
    const failed = normalizeKiCadErc(errorErc, bindings("failed", "kicad_erc"));
    expect(failed.semantics.status).toBe("FAIL");
    const statusDraft = JSON.parse(JSON.stringify(failed.semantics)) as Record<string, unknown>;
    for (const key of ["payloadIdentity", "findingsIdentity", "semanticIdentity", "documentIdentity"]) delete statusDraft[key];
    statusDraft.status = "PASS";
    expect(() => withSemanticIdentity(statusDraft as never)).toThrowError(DomainError);

    const safeStats = REAL_STATS;
    const result = normalizeKiCadStats(safeStats, bindings("mutation", "kicad_stats"));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.semantics)).toBe(true);
    expect(Object.isFrozen(result.semantics.payload)).toBe(true);
    expect(Object.isFrozen(result.semantics.fieldDispositionLedger)).toBe(true);
    expect(Object.isFrozen(result.rawBoundReceipt)).toBe(true);

    const privacyDraft = JSON.parse(JSON.stringify(result.semantics)) as Record<string, unknown>;
    for (const key of ["payloadIdentity", "findingsIdentity", "semanticIdentity", "documentIdentity"]) delete privacyDraft[key];
    (
      privacyDraft.payload as { document: { metadata: Record<string, unknown> } }
    ).document.metadata.extension = { note: "prefix C:\\private suffix" };
    expect(() => withSemanticIdentity(privacyDraft as never)).toThrowError(DomainError);

    const tampered = JSON.parse(JSON.stringify(result)) as {
      semantics: Record<string, any>;
      rawBoundReceipt: Record<string, unknown>;
      schemaVersion: string;
    };
    tampered.semantics.fieldDispositionLedger[0].rawValueIdentity = portableContentIdentity("tampered");
    const { documentIdentity: _documentIdentity, ...documentPreimage } = tampered.semantics;
    tampered.semantics.documentIdentity = portableCanonicalIdentity(
      documentPreimage,
      "evleda.public-portable-semantics-document.v2"
    );
    expect(tampered.semantics.semanticIdentity).toEqual(result.semantics.semanticIdentity);
    expect(() => validatePortableNormalizationResultV2(tampered)).toThrowError(DomainError);
  });

  it("accepts the exact current Rev-A D356 380x73 + 273x82 profile", () => {
    const raw = readFileSync(
      new URL(
        "../../reference-designs/robotics-controller-v0/validation/runs/20260905T041400.496613Z-8b7f124253b42c31/outputs/board-netlist.d356",
        import.meta.url
      )
    );
    const lines = raw.toString("utf8").split(/\r?\n/u).filter((line) => line.length > 0);
    expect(lines.filter((line) => line.length === 73)).toHaveLength(380);
    expect(lines.filter((line) => line.length === 82)).toHaveLength(273);
    expect(normalizeKiCadD356(raw, bindings("actual-d356", "kicad_d356")).semantics.status).toBe("PASS");
  });

  it("accepts the exact current KiCad-E netlist including the TI http documentation field", () => {
    const raw = readFileSync(
      new URL(
        "../../reference-designs/robotics-controller-v0/validation/runs/20260905T041400.496613Z-8b7f124253b42c31/outputs/schematic-netlist.kicad_net",
        import.meta.url
      )
    );
    expect(raw.toString("utf8")).toContain("http://www.ti.com/lit/ds/symlink/tlv755p.pdf");
    expect(normalizeKiCadNetlist(raw, bindings("actual-netlist", "kicad_netlist")).semantics.status).toBe("PASS");
  });

  it("rejects duplicate/unknown JSON, path leaks, D356 duplicates, and malformed netlists", () => {
    const duplicateJson = Buffer.from('{"$schema":"https://schemas.kicad.org/erc.v1.json","date":"a","date":"b"}', "utf8");
    expect(() => normalizeKiCadErc(duplicateJson, bindings("bad-json", "kicad_erc"))).toThrowError(DomainError);

    const leakedStats = Buffer.from(
      JSON.stringify({
        metadata: { date: "now", extension: { note: "file:///private/root" } },
        board: {},
        pads: {},
        vias: {},
        components: {},
        drill_holes: []
      }),
      "utf8"
    );
    expect(() => normalizeKiCadStats(leakedStats, bindings("leak", "kicad_stats"))).toThrowError(DomainError);
    expect(() => normalizeKiCadD356(Buffer.from("P  CODE 00\n317GND VIA A01\n317GND VIA A01\n999\n"), bindings("duplicate", "kicad_d356"))).toThrowError(DomainError);
    expect(() => normalizeKiCadNetlist(Buffer.from('(export (design (source "a")))'), bindings("malformed", "kicad_netlist"))).toThrowError(DomainError);
    const collision = vectors.collisionCorpus.find((entry) => entry.name === "case-colliding-json-keys");
    if (collision?.rawStatsUtf8 === undefined) throw new Error("missing JSON collision vector");
    const collisionRaw = collision.rawStatsUtf8;
    expect(() => normalizeKiCadStats(Buffer.from(collisionRaw, "utf8"), bindings("collision", "kicad_stats"))).toThrowError(DomainError);
    const leakNormalizers = {
      stats: normalizeKiCadStats,
      erc: normalizeKiCadErc,
      drc: normalizeKiCadDrc,
      netlist: normalizeKiCadNetlist
    } as const;
    for (const leak of vectors.publicRecursiveLeakCases) {
      expect(
        () => leakNormalizers[leak.kind](Buffer.from(leak.rawUtf8, "utf8"), bindings(`leak-${leak.name}`, ({ stats: "kicad_stats", erc: "kicad_erc", drc: "kicad_drc", netlist: "kicad_netlist" } as const)[leak.kind])),
        leak.name
      ).toThrowError(DomainError);
    }
    for (const entry of vectors.registeredSeparatorPositiveCases) {
      const result = leakNormalizers[entry.kind](
        Buffer.from(entry.rawUtf8, "utf8"),
        bindings(`positive-${entry.name}`, ({ stats: "kicad_stats", erc: "kicad_erc", drc: "kicad_drc", netlist: "kicad_netlist" } as const)[entry.kind])
      );
      expect(result.semantics.semanticIdentity.digest, entry.name).toBe(entry.semanticIdentityDigest);
      expect(result.semantics.documentIdentity.digest, entry.name).toBe(entry.documentIdentityDigest);
    }
    for (const entry of vectors.d356RejectCases) {
      const raw = entry.rawHex === undefined ? Buffer.from(entry.rawUtf8 ?? "", "utf8") : Buffer.from(entry.rawHex, "hex");
      expect(() => normalizeKiCadD356(raw, bindings(`d356-${entry.name}`, "kicad_d356")), entry.name).toThrowError(
        DomainError
      );
    }
    for (const entry of vectors.netlistRejectCases) {
      const raw = entry.rawHex === undefined ? Buffer.from(entry.rawUtf8 ?? "", "utf8") : Buffer.from(entry.rawHex, "hex");
      expect(
        () => normalizeKiCadNetlist(raw, bindings(`netlist-${entry.name}`, "kicad_netlist")),
        entry.name
      ).toThrowError(DomainError);
    }
    const shallowNormalizers = { erc: normalizeKiCadErc, drc: normalizeKiCadDrc, stats: normalizeKiCadStats } as const;
    for (const entry of vectors.shallowDocumentRejectCases) {
      expect(
        () => shallowNormalizers[entry.kind](Buffer.from(entry.rawUtf8, "utf8"), bindings(`shallow-${entry.name}`, ({ erc: "kicad_erc", drc: "kicad_drc", stats: "kicad_stats" } as const)[entry.kind])),
        entry.name
      ).toThrowError(DomainError);
    }
  });

  it("keeps PDFs private and explicitly NOT_RUN", () => {
    expect(normalizeKiCadPdfV2(Buffer.from("%PDF-1.7\nprivate"))).toEqual({
      schemaVersion: "evleda.portable-kicad-pdf-not-run.v2",
      authority: "consistency-only",
      reportKind: "kicad_pdf",
      status: "NOT_RUN",
      blocker: "PDF_PRIVATE_NON_SEMANTIC",
      reason: "PDF bytes remain private and cannot create portable public authority",
      portableSemantics: null,
      rawContentIdentity: null,
      privateReceiptRequired: true,
      releaseAuthorized: false
    });
    expect(() => normalizeKiCadPdfV2(new Uint8Array(16_777_217))).toThrowError(DomainError);
    expect(() => normalizeKiCadNetlist(Buffer.from(`(${"A".repeat(4_097)})`), bindings("atom-budget", "kicad_netlist"))).toThrowError(DomainError);
    expect(() =>
      normalizeKiCadNetlist(Buffer.from(`(value "${"A".repeat(262_145)}")`), bindings("string-budget", "kicad_netlist"))
    ).toThrowError(DomainError);
  });

  it("replays a raw/source/private-receipt compound and rejects every mismatched link", () => {
    const sourceBytes = Buffer.from(REAL_PCB);
    const base = bindings("compound", "kicad_d356");
    const coherentBindings: PortableNormalizationBindingsV2 = {
      ...base,
      sourceBinding: {
        ...base.sourceBinding,
        sourceArtifactIdentity: portableContentIdentity(sourceBytes)
      }
    };
    const rawBytes = Buffer.from(REAL_D356);
    const expected = normalizeKiCadD356(rawBytes, coherentBindings);
    const privateReceipt = withPrivateRawCaptureReceiptV2Identities({
      schemaVersion: "evleda.private-raw-capture-receipt.v2",
      authority: "private-non-authoritative",
      reportKind: "kicad_d356",
      sourceBinding: coherentBindings.sourceBinding,
      rawContentIdentity: portableContentIdentity(rawBytes),
      privateRawPath: coherentBindings.commandPlan.expectedOutputs[0]!,
      nativeContractIdentity: coherentBindings.nativeContractIdentity,
      normalizerContractIdentity: coherentBindings.normalizerContractIdentity,
      toolIdentity: coherentBindings.commandPlan.tool,
      commandPlanIdentity: coherentBindings.commandPlan.commandPlanIdentity,
      invocationIdentity: coherentBindings.nativeOutcome.invocationIdentity,
      stdoutIdentity: portableContentIdentity(""), stderrIdentity: portableContentIdentity(""),
      exitCode: 0, outcome: "succeeded", publicSemanticIdentity: expected.semantics.semanticIdentity,
      capturedAt: "2026-09-05T00:00:00.000Z", timestampDisposition: "excluded-private"
    });
    const verified = verifyPortableNormalizationCompoundV2({
      reportKind: "kicad_d356", rawBytes, sourceBytes, bindings: coherentBindings, expectedResult: expected, privateReceipt
    });
    expect(verified).toMatchObject({ authority: "consistency-only", hostAuthenticated: false, consistent: true, releaseAuthorized: false });
    const verifiedRawIdentity = verified.result.rawBoundReceipt.rawContentIdentity;
    rawBytes.fill(0x20);
    expect(verified.result.rawBoundReceipt.rawContentIdentity).toEqual(verifiedRawIdentity);
    rawBytes.set(REAL_D356);

    expect(() => verifyPortableNormalizationCompoundV2({
      reportKind: "kicad_d356", rawBytes, sourceBytes: Buffer.from("wrong"), bindings: coherentBindings, expectedResult: expected, privateReceipt
    })).toThrowError(DomainError);
    const attackerPlanDraft = JSON.parse(JSON.stringify(coherentBindings.commandPlan));
    delete attackerPlanDraft.commandPlanIdentity;
    attackerPlanDraft.argv[attackerPlanDraft.argv.length - 1].value = pathRef("run_input", "attacker/robotics-controller-v0.kicad_pcb");
    const attackerPlan = withCommandPlanIdentity(attackerPlanDraft);
    expect(() => verifyPortableNormalizationCompoundV2({
      reportKind: "kicad_d356", rawBytes, sourceBytes, bindings: { ...coherentBindings, commandPlan: attackerPlan }, expectedResult: expected, privateReceipt
    })).toThrowError(DomainError);
    const changedRaw = Buffer.from(rawBytes);
    changedRaw[50] = changedRaw[50]! ^ 1;
    expect(() => verifyPortableNormalizationCompoundV2({
      reportKind: "kicad_d356", rawBytes: changedRaw, sourceBytes, bindings: coherentBindings, expectedResult: expected, privateReceipt
    })).toThrowError(DomainError);
    const publicTamper = JSON.parse(JSON.stringify(expected));
    publicTamper.semantics.status = "UNKNOWN";
    expect(() => verifyPortableNormalizationCompoundV2({
      reportKind: "kicad_d356", rawBytes, sourceBytes, bindings: coherentBindings, expectedResult: publicTamper, privateReceipt
    })).toThrowError(DomainError);
    const receiptTamperDraft = JSON.parse(JSON.stringify(privateReceipt));
    delete receiptTamperDraft.captureIdentity;
    delete receiptTamperDraft.receiptIdentity;
    receiptTamperDraft.rawContentIdentity = portableContentIdentity("wrong raw");
    const receiptTamper = withPrivateRawCaptureReceiptV2Identities(receiptTamperDraft);
    expect(() => verifyPortableNormalizationCompoundV2({
      reportKind: "kicad_d356", rawBytes, sourceBytes, bindings: coherentBindings, expectedResult: expected, privateReceipt: receiptTamper
    })).toThrowError(DomainError);
    const locatorTamperDraft = JSON.parse(JSON.stringify(privateReceipt));
    delete locatorTamperDraft.captureIdentity;
    delete locatorTamperDraft.receiptIdentity;
    locatorTamperDraft.privateRawPath = pathRef("run_private", "captures/other.d356");
    const locatorTamper = withPrivateRawCaptureReceiptV2Identities(locatorTamperDraft);
    expect(() => verifyPortableNormalizationCompoundV2({
      reportKind: "kicad_d356", rawBytes, sourceBytes, bindings: coherentBindings, expectedResult: expected, privateReceipt: locatorTamper
    })).toThrowError(DomainError);
  });

  it("binds PDF NOT_RUN to an exact private receipt and outcome/exit matrix", () => {
    const rawBytes = Buffer.from("%PDF-1.7\nprivate", "utf8");
    const sourceBytes = Buffer.from("schematic source", "utf8");
    const sourceBinding = {
      schemaVersion: "evleda.portable-source-binding.v1" as const,
      sourceRevisionIdentity: portableCanonicalIdentity({ revision: "pdf" }, "evleda.source-revision.v1"),
      sourceArtifactIdentity: portableContentIdentity(sourceBytes),
      sourcePath: pathRef("run_input", "robotics-controller-v0.kicad_sch"),
      sourceContractIdentity: portableCanonicalIdentity({ contract: "pdf" }, "evleda.source-contract.v1")
    };
    const outputPath = pathRef("run_private", "captures/schematic.pdf");
    const commandPlan = withCommandPlanIdentity({
      schemaVersion: "evleda.typed-command-plan.v1", tool: tool("native_validator", "kicad-cli"),
      logicalCwd: pathRef("run_input", "candidate"),
      argv: [...["sch", "export", "pdf", "--output"].map((value) => ({ kind: "literal" as const, value })),
        { kind: "path" as const, value: outputPath }, { kind: "path" as const, value: pathRef("run_input", "robotics-controller-v0.kicad_sch") }
      ],
      environment: bindings("pdf-env", "kicad_netlist").commandPlan.environment,
      expectedOutputs: [outputPath]
    });
    const nativeContractIdentity = portableCanonicalIdentity({ native: "pdf" }, "evleda.native-validation-contract.v1");
    const normalizerContractIdentity = portableCanonicalIdentity({ normalizer: "pdf" }, "evleda.portable-normalizer-contract.v1");
    const nativeOutcome = {
      schemaVersion: "evleda.pdf-native-command-outcome.v1" as const,
      invocationIdentity: portableCanonicalIdentity({ invocation: "pdf" }, "evleda.tool-invocation.v1"),
      outcome: "succeeded" as const, exitCode: 0, accepted: true, complete: true
    };
    const marker = normalizeKiCadPdfV2(rawBytes);
    const privateReceipt = withPrivateRawCaptureReceiptV2Identities({
      schemaVersion: "evleda.private-raw-capture-receipt.v2", authority: "private-non-authoritative", reportKind: "kicad_pdf",
      sourceBinding, rawContentIdentity: portableContentIdentity(rawBytes), privateRawPath: pathRef("run_private", "captures/schematic.pdf"),
      nativeContractIdentity, normalizerContractIdentity, toolIdentity: commandPlan.tool, commandPlanIdentity: commandPlan.commandPlanIdentity,
      invocationIdentity: nativeOutcome.invocationIdentity, stdoutIdentity: portableContentIdentity(""), stderrIdentity: portableContentIdentity(""),
      exitCode: 0, outcome: "succeeded", publicSemanticIdentity: null, capturedAt: "2026-09-05T00:00:00.000Z", timestampDisposition: "excluded-private"
    });
    expect(verifyPortablePdfCompoundV2({ rawBytes, sourceBytes, sourceBinding, nativeContractIdentity, normalizerContractIdentity, commandPlan, nativeOutcome, expectedMarker: marker, privateReceipt }))
      .toMatchObject({ authority: "consistency-only", hostAuthenticated: false, consistent: true });
    expect(() => verifyPortablePdfCompoundV2({ rawBytes, sourceBytes, sourceBinding, nativeContractIdentity, normalizerContractIdentity, commandPlan, nativeOutcome, expectedMarker: marker, privateReceipt: undefined }))
      .toThrowError(DomainError);
    const pdfAttackerDraft = JSON.parse(JSON.stringify(commandPlan));
    delete pdfAttackerDraft.commandPlanIdentity;
    pdfAttackerDraft.argv[pdfAttackerDraft.argv.length - 1].value = pathRef("run_input", "attacker/robotics-controller-v0.kicad_sch");
    const pdfAttackerPlan = withCommandPlanIdentity(pdfAttackerDraft);
    expect(() => verifyPortablePdfCompoundV2({ rawBytes, sourceBytes, sourceBinding, nativeContractIdentity, normalizerContractIdentity, commandPlan: pdfAttackerPlan, nativeOutcome, expectedMarker: marker, privateReceipt }))
      .toThrowError(DomainError);
    expect(() => verifyPortablePdfCompoundV2({ rawBytes, sourceBytes, sourceBinding, nativeContractIdentity, normalizerContractIdentity, commandPlan, nativeOutcome: { ...nativeOutcome, exitCode: 5 }, expectedMarker: marker, privateReceipt }))
      .toThrowError(DomainError);
    expect(() => verifyPortablePdfCompoundV2({ rawBytes, sourceBytes, sourceBinding, nativeContractIdentity, normalizerContractIdentity, commandPlan, nativeOutcome: { ...nativeOutcome, outcome: "failed", exitCode: 0, accepted: false }, expectedMarker: marker, privateReceipt }))
      .toThrowError(DomainError);
    const invalidPdfRaw = Buffer.from("not-a-pdf", "utf8");
    const invalidPdfDraft = JSON.parse(JSON.stringify(privateReceipt));
    delete invalidPdfDraft.captureIdentity; delete invalidPdfDraft.receiptIdentity;
    invalidPdfDraft.rawContentIdentity = portableContentIdentity(invalidPdfRaw);
    const invalidPdfReceipt = withPrivateRawCaptureReceiptV2Identities(invalidPdfDraft);
    expect(() => verifyPortablePdfCompoundV2({ rawBytes: invalidPdfRaw, sourceBytes, sourceBinding, nativeContractIdentity, normalizerContractIdentity, commandPlan, nativeOutcome, expectedMarker: marker, privateReceipt: invalidPdfReceipt }))
      .toThrowError(DomainError);
    const emptyRaw = new Uint8Array();
    const failedOutcome = { ...nativeOutcome, outcome: "failed" as const, exitCode: 1, accepted: false };
    const failedDraft = JSON.parse(JSON.stringify(privateReceipt));
    delete failedDraft.captureIdentity; delete failedDraft.receiptIdentity;
    failedDraft.rawContentIdentity = portableContentIdentity(emptyRaw);
    failedDraft.outcome = "failed"; failedDraft.exitCode = 1;
    const failedReceipt = withPrivateRawCaptureReceiptV2Identities(failedDraft);
    expect(() => verifyPortablePdfCompoundV2({ rawBytes: emptyRaw, sourceBytes, sourceBinding, nativeContractIdentity, normalizerContractIdentity, commandPlan, nativeOutcome, expectedMarker: normalizeKiCadPdfV2(emptyRaw), privateReceipt: failedReceipt }))
      .toThrowError(DomainError);
    expect(verifyPortablePdfCompoundV2({ rawBytes: emptyRaw, sourceBytes, sourceBinding, nativeContractIdentity, normalizerContractIdentity, commandPlan, nativeOutcome: failedOutcome, expectedMarker: normalizeKiCadPdfV2(emptyRaw), privateReceipt: failedReceipt }).consistent).toBe(true);
    const pdfLocatorDraft = JSON.parse(JSON.stringify(privateReceipt));
    delete pdfLocatorDraft.captureIdentity; delete pdfLocatorDraft.receiptIdentity;
    pdfLocatorDraft.privateRawPath = pathRef("run_private", "captures/other.pdf");
    const pdfLocatorReceipt = withPrivateRawCaptureReceiptV2Identities(pdfLocatorDraft);
    expect(() => verifyPortablePdfCompoundV2({ rawBytes, sourceBytes, sourceBinding, nativeContractIdentity, normalizerContractIdentity, commandPlan, nativeOutcome, expectedMarker: marker, privateReceipt: pdfLocatorReceipt }))
      .toThrowError(DomainError);
  });
});
