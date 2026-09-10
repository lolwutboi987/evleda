import { describe, expect, it } from "vitest";

import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import { loadDeepRuleCatalog, type DeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import {
  PCB_DESIGN_COMPILATION_BUNDLE_LIMITS,
  PCB_DESIGN_COMPILATION_BUNDLE_REF_SCHEMA_VERSION,
  PCB_DESIGN_COMPILATION_BUNDLE_SCHEMA_VERSION,
  PCB_DESIGN_COMPILER_PROFILE_SCHEMA_VERSION,
  PCB_EXECUTION_PROMPT_SCHEMA_VERSION,
  PCB_PRACTICE_PROFILE_BINDING_SCHEMA_VERSION,
  createPcbDesignCompilationBundle,
  createPcbDesignCompilationBundleRef,
  createPcbDesignCompilerProfile,
  parsePcbDesignCompilationBundle,
  parsePcbDesignCompilationBundleRef,
  renderPcbDesignCompilationBundleCanonicalJson,
  serializePcbDesignCompilationBundle,
  verifyPcbDesignCompilationBundleRef,
  type PcbDesignCompilationBundle,
  type PcbDesignCompilationBundleDependencies,
  type PcbDesignCompilerProfile,
} from "../../src/harness/pcb-design-compilation-bundle.js";
import {
  PCB_ACCEPTANCE_PLAN_SCHEMA_VERSION,
  PCB_DEEP_RULE_BINDING_SCHEMA_VERSION,
  PCB_LIBRARY_BINDING_SCHEMA_VERSION,
  compilePcbDesignIntentDraft,
  compilePcbDesignIntentDraftV1,
  type PcbDesignCompilation,
  type PcbReadOnlyLibraryResolver,
} from "../../src/harness/pcb-design-compiler.js";
import { PCB_DESIGN_INTENT_DRAFT_SCHEMA_VERSION } from "../../src/harness/pcb-design-contract.js";

const catalog = loadDeepRuleCatalog();

const resolver: PcbReadOnlyLibraryResolver = {
  resolveSymbol: (libraryId) => libraryId === "Connector_Generic:Conn_01x02"
    ? {
        libraryId,
        source: "kicad-stock",
        unitCount: 1,
        componentKind: "connector",
        polarized: false,
        pins: [
          { number: "1", function: "Pin 1" },
          { number: "2", function: "Pin 2" },
        ],
      }
    : null,
  resolveFootprint: (libraryId) => libraryId === "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical"
    ? { libraryId, source: "kicad-stock", packageKind: "generic", pads: ["1", "2"] }
    : null,
};

const electrical = (voltage: number) => ({
  voltage: { minimumV: voltage, nominalV: voltage, maximumV: voltage },
  current: { nominalA: 0.1, maximumContinuousA: 0.1, peakA: 0.1, peakDurationMs: 1_000 },
  speed: { kind: "dc", maximumFrequencyMHz: 0, minimumEdgeTimeNs: null },
});

const placement = (reference: string, edgePreference: "left" | "right", rotation: 0 | 180) => ({
  reference,
  side: "front",
  regionMm: { minXmm: 1, maxXmm: 29, minYmm: 1, maxYmm: 19 },
  allowedRotationsDeg: [rotation],
  minimumEdgeClearanceMm: 1,
  minimumCourtyardClearanceMm: 0.25,
  edgePreference,
});

const draft = () => ({
  schemaVersion: PCB_DESIGN_INTENT_DRAFT_SCHEMA_VERSION,
  kind: "pcb_design_intent_draft",
  scope: {
    sheetCount: 1,
    componentUnitPolicy: "single_unit",
    board: {
      shape: "rectangle",
      widthMm: 30,
      heightMm: 20,
      layerCount: 2,
      copperLayers: ["F.Cu", "B.Cu"],
    },
  },
  components: ["J1", "J2"].map((reference) => ({
    reference,
    symbolLibId: "Connector_Generic:Conn_01x02",
    value: reference === "J1" ? "POWER_IN" : "POWER_OUT",
    footprintLibId: "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical",
    unit: 1,
    pins: [
      { pin: "1", assignment: { kind: "net", net: "VIN" } },
      { pin: "2", assignment: { kind: "net", net: "GND" } },
    ],
  })),
  nets: [
    {
      name: "VIN",
      role: "power_input",
      endpoints: [{ reference: "J1", pin: "1" }, { reference: "J2", pin: "1" }],
      electrical: electrical(5),
      netClassId: "POWER",
    },
    {
      name: "GND",
      role: "ground",
      endpoints: [{ reference: "J1", pin: "2" }, { reference: "J2", pin: "2" }],
      electrical: electrical(0),
      netClassId: "POWER",
    },
  ],
  netClasses: [{
    id: "POWER",
    traceWidthMm: 0.5,
    clearanceMm: 0.25,
    copperToEdgeMm: 0.3,
    allowedLayers: ["F.Cu"],
  }],
  placementConstraints: [placement("J1", "left", 0), placement("J2", "right", 180)],
  routingConstraints: {
    cornerStyle: "miter_45",
    maximumTurnAngleDeg: 45,
    minimumStraightBeforeTurnMm: 0.25,
    allowRightAngleCorners: false,
    allowAcuteInteriorCorners: false,
    allowBacktracking: false,
    allowSelfIntersections: false,
    viaPolicy: { mode: "forbidden", maxTotal: 0 },
    nets: ["VIN", "GND"].map((net) => ({
      net,
      topology: "point_to_point",
      preferredLayer: "F.Cu",
      maxVias: 0,
      routeLength: { mode: "unbounded" },
    })),
  },
  unresolved: [],
});

const compilation = (): PcbDesignCompilation => compilePcbDesignIntentDraft(draft(), {
  libraryResolver: resolver,
  deepRuleCatalog: catalog,
});

const dependencies = (overrides: Partial<PcbDesignCompilationBundleDependencies> = {}) => ({
  libraryResolver: overrides.libraryResolver ?? resolver,
  deepRuleCatalog: overrides.deepRuleCatalog ?? catalog,
  ...(overrides.compilerProfile === undefined ? {} : { compilerProfile: overrides.compilerProfile }),
});

const bundle = (prompt = "Build the exact two-connector power pass-through. 🧪") => {
  const result = compilation();
  expect(result.disposition).toBe("ready");
  return createPcbDesignCompilationBundle({ originalPrompt: prompt, compilation: result }, dependencies());
};

const recursivelyFrozen = (value: unknown, seen = new Set<object>()): boolean => {
  if (value === null || typeof value !== "object" || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every((entry) => recursivelyFrozen(entry, seen));
};

const firstUnfrozenPath = (value: unknown, path = "$", seen = new Set<object>()): string | null => {
  if (value === null || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  if (!Object.isFrozen(value)) return path;
  for (const [key, entry] of Object.entries(value)) {
    const child = firstUnfrozenPath(entry, `${path}.${key}`, seen);
    if (child !== null) return child;
  }
  return null;
};

type MutableRecord = Record<string, unknown>;

const reidentify = (value: MutableRecord, schemaVersion: string): void => {
  const payload = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "identity"));
  value.identity = canonicalIdentity(payload, schemaVersion);
};

describe("PCB design compilation bundle", () => {
  it("preserves exact v1 plan/profile history and binds current v2 ink clearance into new bundle identities", () => {
    const prior = compilePcbDesignIntentDraftV1(draft(), dependencies());
    const legacy = createPcbDesignCompilationBundle({ originalPrompt: "Historical candidate", compilation: prior }, dependencies());
    const historicalBytes = serializePcbDesignCompilationBundle(legacy);
    expect(legacy.compilerProfile.schemaVersion).toBe("evleda.pcb-design-compiler-profile.v1");
    expect(legacy.acceptancePlan.schemaVersion).toBe("evleda.pcb-acceptance-plan.v1");
    expect(serializePcbDesignCompilationBundle(parsePcbDesignCompilationBundle(historicalBytes, dependencies()))).toEqual(historicalBytes);
    const current = createPcbDesignCompilationBundle({ originalPrompt: "Historical candidate", compilation: compilation() }, dependencies());
    expect(current.compilerProfile.schemaVersion).toBe("evleda.pcb-design-compiler-profile.v2");
    expect(current.acceptancePlan.rows.slice(0, -1)).toEqual(legacy.acceptancePlan.rows);
    expect(current.acceptancePlan.rows.at(-1)).toMatchObject({ id: "schematic-render-clearance", mandatory: true });
    expect(current.identity).not.toEqual(legacy.identity); expect(current.executionPrompt.identity).not.toEqual(legacy.executionPrompt.identity);
    expect(legacy.executionPrompt.text).not.toContain("NATIVE SCHEMATIC INK CLEARANCE");
    const altered = structuredClone(current) as any; altered.acceptancePlan = legacy.acceptancePlan;
    expect(() => createPcbDesignCompilationBundle({ originalPrompt: "Historical candidate", compilation: { ...compilation(), acceptancePlan: altered.acceptancePlan } }, { ...dependencies(), compilerProfile: current.compilerProfile })).toThrow();
  });
  it("closes the full immutable execution contract and round-trips exact canonical LF bytes", () => {
    const originalPrompt = "Build exactly this candidate, preserving café and 🧪 verbatim.";
    const artifact = bundle(originalPrompt);
    const bytes = serializePcbDesignCompilationBundle(artifact);
    const text = renderPcbDesignCompilationBundleCanonicalJson(artifact);
    const reference = createPcbDesignCompilationBundleRef(artifact);

    expect(artifact.schemaVersion).toBe(PCB_DESIGN_COMPILATION_BUNDLE_SCHEMA_VERSION);
    expect(artifact.classification).toBe("candidate-only");
    expect(artifact.flashable).toBe(false);
    expect(artifact.fabricationAuthorized).toBe(false);
    expect(artifact.qualificationEstablished).toBe(false);
    expect(artifact.releaseAuthorized).toBe(false);
    expect(artifact.compilerProfile.schemaVersion).toBe(PCB_DESIGN_COMPILER_PROFILE_SCHEMA_VERSION);
    expect(artifact.practiceProfileBinding.schemaVersion).toBe(PCB_PRACTICE_PROFILE_BINDING_SCHEMA_VERSION);
    expect(artifact.executionPrompt.schemaVersion).toBe(PCB_EXECUTION_PROMPT_SCHEMA_VERSION);
    expect(artifact.executionPrompt.originalPrompt).toBe(originalPrompt);
    expect(artifact.executionPrompt.originalPromptContentIdentity).toStrictEqual(contentIdentity(originalPrompt));
    expect(artifact.executionPrompt.text).toContain(originalPrompt);
    expect(artifact.executionPrompt.text).toContain(canonicalJson(artifact.contract));
    expect(artifact.executionPrompt.text).toContain(artifact.deepRuleBinding.selection.prompt);
    expect(artifact.executionPrompt.text).toContain("12 bounded iterations and at most 16 provider tool calls per turn");
    expect(artifact.executionPrompt.text).toContain("Use fresh_sync_from_schematic with empty arguments instead of raw pcb_sync_from_schematic");
    expect(artifact.executionPrompt.text).toContain("fresh_get_contract_pad_positions");
    expect(artifact.executionPrompt.text).toContain("fresh_get_route_items before fresh_replace_route_items");
    expect(artifact.executionPrompt.text).toContain("daisy-chain through an actual contract pad");
    expect(artifact.executionPrompt.text).toContain("Free-space tee junctions are unsupported and forbidden");
    expect(artifact.executionPrompt.text).toContain("CANDIDATE-ONLY AUTHORITY BOUNDARY");
    expect(artifact.executionPrompt.text).not.toContain("[truncated]");
    expect(artifact.executionPrompt.usedUtf8Bytes).toBe(Buffer.byteLength(artifact.executionPrompt.text, "utf8"));
    expect(artifact.executionPrompt.textContentIdentity).toStrictEqual(contentIdentity(artifact.executionPrompt.text));
    expect(artifact.libraryBinding.symbols).toHaveLength(artifact.contract.components.length);
    expect(artifact.libraryBinding.footprints).toHaveLength(artifact.contract.components.length);
    expect(artifact.deepRuleBinding.selection.disposition).toBe("ready-for-prompt");
    expect(artifact.acceptancePlan.rows.every((row) => row.mandatory)).toBe(true);
    expect(firstUnfrozenPath(artifact)).toBe(null);
    expect(recursivelyFrozen(artifact)).toBe(true);

    expect(bytes).toStrictEqual(Buffer.from(text, "utf8"));
    expect(bytes[bytes.length - 1]).toBe(0x0a);
    expect(bytes[bytes.length - 2]).not.toBe(0x0a);
    expect(text).toBe(`${canonicalJson(artifact)}\n`);
    expect(reference.schemaVersion).toBe(PCB_DESIGN_COMPILATION_BUNDLE_REF_SCHEMA_VERSION);
    expect(reference.bundleIdentity).toStrictEqual(artifact.identity);
    expect(reference.contentIdentity).toStrictEqual(contentIdentity(bytes));
    expect(recursivelyFrozen(reference)).toBe(true);

    const parsed = parsePcbDesignCompilationBundle(bytes, dependencies());
    expect(parsed).toStrictEqual(artifact);
    expect(recursivelyFrozen(parsed)).toBe(true);
    expect(parsePcbDesignCompilationBundleRef(reference)).toStrictEqual(reference);
    expect(verifyPcbDesignCompilationBundleRef(reference, bytes, dependencies())).toStrictEqual(artifact);
  });

  it("recreates the deterministic compiler profile and accepts an independently pinned exact copy", () => {
    const compiled = compilation();
    const profile = createPcbDesignCompilerProfile(compiled, catalog);
    const artifact = createPcbDesignCompilationBundle(
      { originalPrompt: "Pinned compiler profile candidate.", compilation: compiled, compilerProfile: profile },
      dependencies({ compilerProfile: profile }),
    );

    expect(artifact.compilerProfile).toStrictEqual(profile);
    expect(profile.deepRuleSelectionOptions.tokenAccounting).toBe("utf8-byte-upper-bound");
    expect(recursivelyFrozen(profile)).toBe(true);
  });

  it("rejects non-ready compilations and non-serializable token accounting", () => {
    const notReady = compilePcbDesignIntentDraft({}, { libraryResolver: resolver, deepRuleCatalog: catalog });
    expect(notReady.disposition).not.toBe("ready");
    expect(() => createPcbDesignCompilationBundle(
      { originalPrompt: "Cannot execute unresolved work.", compilation: notReady },
      dependencies(),
    )).toThrow(expect.objectContaining({ code: "COMPILATION_NOT_READY" }));

    const compiled = structuredClone(compilation()) as unknown as MutableRecord;
    const binding = compiled.deepRuleBinding as MutableRecord;
    const selection = binding.selection as MutableRecord;
    const budget = selection.budget as MutableRecord;
    budget.tokenAccounting = "caller-supplied";
    expect(() => createPcbDesignCompilationBundle(
      { originalPrompt: "Reject function-dependent accounting.", compilation: compiled as unknown as PcbDesignCompilation },
      dependencies(),
    )).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("rejects leaf tampering even when every directly dependent claimed hash is reminted", () => {
    const baseline = bundle();
    const tampered = structuredClone(baseline) as unknown as MutableRecord;
    const library = tampered.libraryBinding as MutableRecord;
    const symbols = library.symbols as MutableRecord[];
    const pins = symbols[0]!.pins as MutableRecord[];
    pins[0]!.function = "Forged function";
    reidentify(library, PCB_LIBRARY_BINDING_SCHEMA_VERSION);

    const acceptance = tampered.acceptancePlan as MutableRecord;
    acceptance.libraryBindingIdentity = library.identity;
    reidentify(acceptance, PCB_ACCEPTANCE_PLAN_SCHEMA_VERSION);
    const execution = tampered.executionPrompt as MutableRecord;
    execution.libraryBindingIdentity = library.identity;
    execution.acceptancePlanIdentity = acceptance.identity;
    reidentify(execution, PCB_EXECUTION_PROMPT_SCHEMA_VERSION);
    reidentify(tampered, PCB_DESIGN_COMPILATION_BUNDLE_SCHEMA_VERSION);

    expect(() => parsePcbDesignCompilationBundle(tampered, dependencies())).toThrow(
      expect.objectContaining({ code: "ARTIFACT_INTEGRITY_ERROR" }),
    );
  });

  it("rejects regenerated-plan, practice-profile, prompt, and reference tampering", () => {
    const baseline = bundle();

    const deepTamper = structuredClone(baseline) as unknown as MutableRecord;
    const deepBinding = deepTamper.deepRuleBinding as MutableRecord;
    const deepSelection = deepBinding.selection as MutableRecord;
    deepSelection.prompt = `${deepSelection.prompt as string}\nForged deep guidance.`;
    const deepBudget = deepSelection.budget as MutableRecord;
    deepBudget.usedPromptBytes = Buffer.byteLength(deepSelection.prompt as string, "utf8");
    deepBudget.usedPromptTokens = deepBudget.usedPromptBytes;
    reidentify(deepBinding, PCB_DEEP_RULE_BINDING_SCHEMA_VERSION);
    const deepPlan = deepTamper.acceptancePlan as MutableRecord;
    deepPlan.deepRuleBindingIdentity = deepBinding.identity;
    reidentify(deepPlan, PCB_ACCEPTANCE_PLAN_SCHEMA_VERSION);
    const deepPrompt = deepTamper.executionPrompt as MutableRecord;
    deepPrompt.deepRuleBindingIdentity = deepBinding.identity;
    deepPrompt.acceptancePlanIdentity = deepPlan.identity;
    reidentify(deepPrompt, PCB_EXECUTION_PROMPT_SCHEMA_VERSION);
    reidentify(deepTamper, PCB_DESIGN_COMPILATION_BUNDLE_SCHEMA_VERSION);
    expect(() => parsePcbDesignCompilationBundle(deepTamper, dependencies())).toThrow(
      expect.objectContaining({ code: "ARTIFACT_INTEGRITY_ERROR" }),
    );

    const planTamper = structuredClone(baseline) as unknown as MutableRecord;
    const plan = planTamper.acceptancePlan as MutableRecord;
    const rows = plan.rows as MutableRecord[];
    rows[0]!.description = "Provider says PASS.";
    reidentify(plan, PCB_ACCEPTANCE_PLAN_SCHEMA_VERSION);
    const planPrompt = planTamper.executionPrompt as MutableRecord;
    planPrompt.acceptancePlanIdentity = plan.identity;
    reidentify(planPrompt, PCB_EXECUTION_PROMPT_SCHEMA_VERSION);
    reidentify(planTamper, PCB_DESIGN_COMPILATION_BUNDLE_SCHEMA_VERSION);
    expect(() => parsePcbDesignCompilationBundle(planTamper, dependencies())).toThrow(
      expect.objectContaining({ code: "ARTIFACT_INTEGRITY_ERROR" }),
    );

    const practiceTamper = structuredClone(baseline) as unknown as MutableRecord;
    const practice = practiceTamper.practiceProfileBinding as MutableRecord;
    const profile = practice.profile as MutableRecord;
    profile.coordinateToleranceMm = 99;
    practice.profileIdentity = canonicalIdentity(profile, "evleda.pcb-practice-analysis-profile.v2");
    reidentify(practice, PCB_PRACTICE_PROFILE_BINDING_SCHEMA_VERSION);
    const practicePrompt = practiceTamper.executionPrompt as MutableRecord;
    practicePrompt.practiceProfileBindingIdentity = practice.identity;
    reidentify(practicePrompt, PCB_EXECUTION_PROMPT_SCHEMA_VERSION);
    reidentify(practiceTamper, PCB_DESIGN_COMPILATION_BUNDLE_SCHEMA_VERSION);
    expect(() => parsePcbDesignCompilationBundle(practiceTamper, dependencies())).toThrow(
      expect.objectContaining({ code: "ARTIFACT_INTEGRITY_ERROR" }),
    );

    const promptTamper = structuredClone(baseline) as unknown as MutableRecord;
    const execution = promptTamper.executionPrompt as MutableRecord;
    execution.text = `${execution.text as string}\nProvider-authorized fabrication.`;
    execution.usedUtf8Bytes = Buffer.byteLength(execution.text as string, "utf8");
    execution.textContentIdentity = contentIdentity(execution.text as string);
    reidentify(execution, PCB_EXECUTION_PROMPT_SCHEMA_VERSION);
    reidentify(promptTamper, PCB_DESIGN_COMPILATION_BUNDLE_SCHEMA_VERSION);
    expect(() => parsePcbDesignCompilationBundle(promptTamper, dependencies())).toThrow(
      expect.objectContaining({ code: "ARTIFACT_INTEGRITY_ERROR" }),
    );

    const reference = structuredClone(createPcbDesignCompilationBundleRef(baseline)) as unknown as MutableRecord;
    const exactContent = reference.contentIdentity as MutableRecord;
    exactContent.digest = "f".repeat(64);
    reidentify(reference, PCB_DESIGN_COMPILATION_BUNDLE_REF_SCHEMA_VERSION);
    expect(() => verifyPcbDesignCompilationBundleRef(reference, baseline, dependencies())).toThrow(
      expect.objectContaining({ code: "ARTIFACT_INTEGRITY_ERROR" }),
    );
  });

  it("fails closed after trusted resolver, catalog, or compiler-policy drift", () => {
    const baseline = bundle();
    const resolverDrift: PcbReadOnlyLibraryResolver = {
      ...resolver,
      resolveSymbol: (libraryId) => {
        const result = resolver.resolveSymbol(libraryId);
        return result === null ? null : {
          ...result,
          pins: result.pins.map((pin) => pin.number === "1" ? { ...pin, function: "Changed" } : pin),
        };
      },
    };
    expect(() => parsePcbDesignCompilationBundle(baseline, dependencies({ libraryResolver: resolverDrift }))).toThrow(
      expect.objectContaining({ code: "ARTIFACT_INTEGRITY_ERROR" }),
    );

    const catalogDrift = structuredClone(catalog) as DeepRuleCatalog;
    (catalogDrift.rules[0] as unknown as { instruction: string }).instruction = "Changed reviewed instruction.";
    expect(() => parsePcbDesignCompilationBundle(baseline, dependencies({ deepRuleCatalog: catalogDrift }))).toThrow(
      expect.objectContaining({ code: "ARTIFACT_INTEGRITY_ERROR" }),
    );

    const profileDrift = structuredClone(baseline.compilerProfile) as unknown as MutableRecord;
    const selection = profileDrift.deepRuleSelectionOptions as MutableRecord;
    selection.maxPromptTokens = (selection.maxPromptTokens as number) - 1;
    reidentify(profileDrift, PCB_DESIGN_COMPILER_PROFILE_SCHEMA_VERSION);
    expect(() => parsePcbDesignCompilationBundle(
      baseline,
      dependencies({ compilerProfile: profileDrift as unknown as PcbDesignCompilerProfile }),
    )).toThrow(expect.objectContaining({ code: "ARTIFACT_INTEGRITY_ERROR" }));
  });

  it("rejects accessors without invoking them, functions, exotic objects, sparse arrays, and unknown keys", () => {
    let getterInvoked = false;
    const accessorInput: MutableRecord = { compilation: compilation() };
    Object.defineProperty(accessorInput, "originalPrompt", {
      enumerable: true,
      get: () => {
        getterInvoked = true;
        return "must not execute";
      },
    });
    expect(() => createPcbDesignCompilationBundle(
      accessorInput as unknown as { originalPrompt: string; compilation: PcbDesignCompilation },
      dependencies(),
    )).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(getterInvoked).toBe(false);

    let dependencyGetterInvoked = false;
    const accessorDependencies: MutableRecord = { libraryResolver: resolver };
    Object.defineProperty(accessorDependencies, "deepRuleCatalog", {
      enumerable: true,
      get: () => {
        dependencyGetterInvoked = true;
        return catalog;
      },
    });
    expect(() => createPcbDesignCompilationBundle(
      { originalPrompt: "Dependency accessor rejection.", compilation: compilation() },
      accessorDependencies as unknown as PcbDesignCompilationBundleDependencies,
    )).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(dependencyGetterInvoked).toBe(false);

    const functionInput = {
      originalPrompt: "Function rejection.",
      compilation: compilation(),
      compilerProfile: { invalid: () => true },
    };
    expect(() => createPcbDesignCompilationBundle(functionInput as never, dependencies())).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(() => parsePcbDesignCompilationBundle(new Date(), dependencies())).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );

    const sparseCompilation = structuredClone(compilation()) as unknown as MutableRecord;
    sparseCompilation.questions = new Array(1);
    expect(() => createPcbDesignCompilationBundle({
      originalPrompt: "Sparse array rejection.",
      compilation: sparseCompilation as unknown as PcbDesignCompilation,
    }, dependencies())).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));

    const extra = structuredClone(bundle()) as unknown as MutableRecord;
    extra.providerClaim = "PASS";
    expect(() => parsePcbDesignCompilationBundle(extra, dependencies())).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("enforces strict UTF-8 byte caps without truncating multibyte original text", () => {
    const exact = "é".repeat(PCB_DESIGN_COMPILATION_BUNDLE_LIMITS.maxOriginalPromptBytes / 2);
    const accepted = bundle(exact);
    expect(accepted.executionPrompt.originalPrompt).toBe(exact);
    expect(accepted.executionPrompt.originalPromptContentIdentity.size).toBe(
      PCB_DESIGN_COMPILATION_BUNDLE_LIMITS.maxOriginalPromptBytes,
    );

    const oversized = `${exact}é`;
    expect(Buffer.byteLength(oversized, "utf8")).toBe(
      PCB_DESIGN_COMPILATION_BUNDLE_LIMITS.maxOriginalPromptBytes + 2,
    );
    expect(() => createPcbDesignCompilationBundle({
      originalPrompt: oversized,
      compilation: compilation(),
    }, dependencies())).toThrow(expect.objectContaining({ code: "PROMPT_TOO_LARGE" }));
  });

  it("accepts only exact canonical UTF-8 JSON plus one LF", () => {
    const artifact = bundle();
    const canonicalBytes = serializePcbDesignCompilationBundle(artifact);
    expect(canonicalBytes.includes(Buffer.from("🧪", "utf8"))).toBe(true);
    const plain = JSON.parse(canonicalBytes.toString("utf8")) as unknown;
    const pretty = Buffer.from(`${JSON.stringify(plain, null, 2)}\n`, "utf8");
    const crlf = Buffer.concat([canonicalBytes.subarray(0, canonicalBytes.length - 1), Buffer.from("\r\n")]);
    const extraLf = Buffer.concat([canonicalBytes, Buffer.from("\n")]);
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), canonicalBytes]);

    for (const bytes of [pretty, crlf, extraLf]) {
      expect(() => parsePcbDesignCompilationBundle(bytes, dependencies())).toThrow(
        expect.objectContaining({ code: "NON_CANONICAL_BYTES" }),
      );
    }
    expect(() => parsePcbDesignCompilationBundle(bom, dependencies())).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(() => parsePcbDesignCompilationBundle(Buffer.from([0xff]), dependencies())).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("preserves exact-limit admission and one-over size errors for Buffer and Uint8Array inputs", () => {
    const canonicalBytes = serializePcbDesignCompilationBundle(bundle("Canonical multibyte 🧪 candidate."));
    const paddingBytes = PCB_DESIGN_COMPILATION_BUNDLE_LIMITS.maxBundleBytes - canonicalBytes.byteLength;
    expect(paddingBytes).toBeGreaterThan(0);
    const exactBuffer = Buffer.concat([canonicalBytes, Buffer.alloc(paddingBytes, 0x20)]);
    const oversizedBuffer = Buffer.concat([exactBuffer, Buffer.from(" ")]);
    const exactUint8Array = new Uint8Array(exactBuffer);
    const oversizedUint8Array = new Uint8Array(oversizedBuffer);

    expect(exactBuffer.byteLength).toBe(PCB_DESIGN_COMPILATION_BUNDLE_LIMITS.maxBundleBytes);
    expect(oversizedBuffer.byteLength).toBe(PCB_DESIGN_COMPILATION_BUNDLE_LIMITS.maxBundleBytes + 1);
    for (const exact of [exactBuffer, exactUint8Array]) {
      expect(() => parsePcbDesignCompilationBundle(exact, dependencies())).toThrow(
        expect.objectContaining({ code: "NON_CANONICAL_BYTES" }),
      );
    }
    for (const oversized of [oversizedBuffer, oversizedUint8Array]) {
      expect(() => parsePcbDesignCompilationBundle(oversized, dependencies())).toThrow(
        expect.objectContaining({ code: "PAYLOAD_TOO_LARGE" }),
      );
    }
  });
});
