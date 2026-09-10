import { describe, expect, it } from "vitest";

import { canonicalIdentity } from "../../src/core/canonical.js";
import { createPcbDesignInterpreterPort } from "../../src/flux/contract-interpreter.js";
import type { FluxInterpreterReceiptV2Dto } from "../../src/flux/contracts.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { serializePcbDesignCompilationBundle } from "../../src/harness/pcb-design-compilation-bundle.js";
import {
  compilePcbDesignIntentDraft,
  type PcbDesignCompilerOptions
} from "../../src/harness/pcb-design-compiler.js";
import { PCB_DESIGN_INTENT_DRAFT_SCHEMA_VERSION } from "../../src/harness/pcb-design-contract.js";
import {
  PCB_DESIGN_INTENT_TOOL_NAME,
  PcbDesignInterpreterError,
  createPcbProviderProfileBinding,
  type PcbDesignInterpreterDependencies,
  type PcbIntentProvider
} from "../../src/harness/pcb-design-interpreter.js";

const electrical = (voltage: number) => ({
  voltage: { minimumV: voltage, nominalV: voltage, maximumV: voltage },
  current: { nominalA: 0.01, maximumContinuousA: 0.01, peakA: 0.01, peakDurationMs: 1_000 },
  speed: { kind: "dc", maximumFrequencyMHz: 0, minimumEdgeTimeNs: null }
});

const resolvedDraft = () => ({
  schemaVersion: PCB_DESIGN_INTENT_DRAFT_SCHEMA_VERSION,
  kind: "pcb_design_intent_draft",
  scope: {
    sheetCount: 1,
    componentUnitPolicy: "single_unit",
    board: { shape: "rectangle", widthMm: 20, heightMm: 15, layerCount: 2, copperLayers: ["F.Cu", "B.Cu"] }
  },
  components: [{
    reference: "R1",
    symbolLibId: "Device:R",
    value: "1k",
    footprintLibId: "Resistor_SMD:R_0603_1608Metric",
    unit: 1,
    pins: [
      { pin: "1", assignment: { kind: "net", net: "+5V" } },
      { pin: "2", assignment: { kind: "net", net: "+5V" } }
    ]
  }],
  nets: [{
    name: "+5V",
    role: "power_input",
    endpoints: [{ reference: "R1", pin: "1" }, { reference: "R1", pin: "2" }],
    electrical: electrical(5),
    netClassId: "DEFAULT"
  }],
  netClasses: [{
    id: "DEFAULT",
    traceWidthMm: 0.5,
    clearanceMm: 0.2,
    copperToEdgeMm: 0.3,
    allowedLayers: ["F.Cu", "B.Cu"]
  }],
  placementConstraints: [{
    reference: "R1",
    side: "front",
    regionMm: { minXmm: 1, maxXmm: 19, minYmm: 1, maxYmm: 14 },
    allowedRotationsDeg: [0, 90, 180, 270],
    minimumEdgeClearanceMm: 1,
    minimumCourtyardClearanceMm: 0.25,
    edgePreference: "none"
  }],
  routingConstraints: {
    cornerStyle: "miter_45",
    maximumTurnAngleDeg: 45,
    minimumStraightBeforeTurnMm: 0.25,
    allowRightAngleCorners: false,
    allowAcuteInteriorCorners: false,
    allowBacktracking: false,
    allowSelfIntersections: false,
    viaPolicy: { mode: "forbidden", maxTotal: 0 },
    nets: [{
      net: "+5V",
      topology: "point_to_point",
      preferredLayer: "F.Cu",
      maxVias: 0,
      routeLength: { mode: "unbounded" }
    }]
  },
  unresolved: []
});

const unresolvedDraft = () => {
  const draft: any = resolvedDraft();
  draft.scope.board.widthMm = null;
  draft.unresolved = [{ path: "/scope/board/widthMm", question: "What board width is required?" }];
  return draft;
};

const compilerOptions: PcbDesignCompilerOptions = {
  libraryResolver: {
    resolveSymbol: (libraryId) => libraryId === "Device:R" ? {
      libraryId,
      source: "kicad-stock",
      unitCount: 1,
      componentKind: "generic",
      polarized: false,
      pins: [{ number: "1", function: "Terminal 1" }, { number: "2", function: "Terminal 2" }]
    } : null,
    resolveFootprint: (libraryId) => libraryId === "Resistor_SMD:R_0603_1608Metric" ? {
      libraryId,
      source: "kicad-stock",
      packageKind: "generic",
      pads: ["1", "2"]
    } : null
  },
  deepRuleCatalog: loadDeepRuleCatalog()
};

const provider = (draft: unknown): PcbIntentProvider => ({
  provider: "fixture",
  turn: async () => ({
    message: { role: "assistant", content: "" },
    toolCalls: [{ id: "intent-1", name: PCB_DESIGN_INTENT_TOOL_NAME, arguments: draft }],
    stopReason: "tool_calls"
  })
});

const dependencies = (
  draft: unknown,
  options: PcbDesignCompilerOptions = compilerOptions
): PcbDesignInterpreterDependencies => ({ provider: provider(draft), compilerOptions: options });

const providerProfile = () => createPcbProviderProfileBinding({
  provider: "fixture",
  model: "pcb-intent-model-v7",
  tier: "provider-default",
  adapterSchemaVersion: "evleda.fixture-pcb-provider.v1"
});

describe("Flux PCB contract interpreter bridge", () => {
  it("returns the full ready bundle only on the internal port and binds provider, model, profiles, and bundle in a v2 receipt", async () => {
    const profile = providerProfile();
    const port = createPcbDesignInterpreterPort(dependencies(resolvedDraft()), profile);
    const prompt = "Create the exact +5V resistor candidate, not an LED fixture.";
    const internal = await port.interpretCompilation({ prompt, clarificationAnswers: [] });

    expect(Object.keys(internal).sort()).toEqual(["bundle", "publicState"]);
    expect(internal.bundle).not.toBeNull();
    expect(internal.bundle?.executionPrompt.originalPrompt).toBe(prompt);
    expect(internal.bundle?.contract.nets[0]?.name).toBe("+5V");
    expect(serializePcbDesignCompilationBundle(internal.bundle!)).not.toHaveLength(0);
    expect(internal.publicState.disposition).toBe("ready");

    const receipt = internal.publicState.interpreterReceipt as FluxInterpreterReceiptV2Dto;
    expect(receipt.schemaVersion).toBe("evleda.flux-interpreter-receipt.v2");
    expect(receipt.provider).toBe("fixture");
    expect(receipt.providerProfile).toStrictEqual(profile);
    expect(receipt.providerProfile.model).toBe("pcb-intent-model-v7");
    expect(receipt.providerProfile.tier).toBe("provider-default");
    expect(receipt.providerProfileIdentity).toStrictEqual(profile.identity);
    expect(receipt.providerProfileIdentity.digest).toBe("2ded6fdd932893caa1b9b15bb7f3222f956abf0437586f599a9f0365b67e73b6");
    expect(receipt.compilerProfileIdentity).toStrictEqual(internal.bundle?.compilerProfile.identity);
    expect(receipt.practiceProfileBindingIdentity).toStrictEqual(internal.bundle?.practiceProfileBinding.identity);
    expect(receipt.bundleIdentity).toStrictEqual(internal.bundle?.identity);
    const receiptPayload: Record<string, unknown> = structuredClone(receipt) as unknown as Record<string, unknown>;
    delete receiptPayload.identity;
    expect(receipt.identity).toStrictEqual(canonicalIdentity(receiptPayload, "evleda.flux-interpreter-receipt.v2"));

    const publicJson = JSON.stringify(internal.publicState);
    expect(publicJson).not.toContain('"bundle":');
    expect(publicJson).not.toContain('"executionPrompt":');
    expect(publicJson).not.toContain('"practiceProfileBinding":');
    expect(Object.isFrozen(internal)).toBe(true);
    expect(Object.isFrozen(internal.bundle)).toBe(true);
    expect(Object.isFrozen(internal.publicState)).toBe(true);
  });

  it.each([
    ["needs_clarification", unresolvedDraft(), compilerOptions],
    ["unsupported", resolvedDraft(), { ...compilerOptions, requestedCapabilities: { bga: true } }]
  ] as const)("returns bundle:null for %s while preserving the safe public result", async (disposition, draft, options) => {
    const port = createPcbDesignInterpreterPort(dependencies(draft, options), providerProfile());
    const result = await port.interpretCompilation({ prompt: "Interpret this bounded candidate.", clarificationAnswers: [] });

    expect(result.publicState.disposition).toBe(disposition);
    expect(result.bundle).toBeNull();
    const receipt = result.publicState.interpreterReceipt as FluxInterpreterReceiptV2Dto;
    expect(receipt.compilerProfileIdentity).toBeNull();
    expect(receipt.practiceProfileBindingIdentity).toBeNull();
    expect(receipt.bundleIdentity).toBeNull();
    expect(JSON.stringify(result.publicState)).not.toContain('"bundle":');
  });

  it("keeps legacy interpretation public-only and exposes no compilation method without a provider profile binding", async () => {
    const port = createPcbDesignInterpreterPort(dependencies(resolvedDraft()));
    expect("interpretCompilation" in port).toBe(false);
    const state = await port.interpret({ prompt: "Legacy safe projection.", clarificationAnswers: [] });

    expect(state.disposition).toBe("ready");
    expect(state.interpreterReceipt.schemaVersion).toBe("evleda.flux-interpreter-receipt.v1");
    expect(JSON.stringify(state)).not.toContain('"bundle":');
    expect(JSON.stringify(state)).not.toContain('"executionPrompt":');
  });

  it("rejects tampered or adapter-mismatched provider profile bindings before interpretation", () => {
    const tampered = structuredClone(providerProfile()) as any;
    tampered.model = "different-model";
    expect(() => createPcbDesignInterpreterPort(dependencies(resolvedDraft()), tampered)).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT" })
    );

    const wrongProvider = createPcbProviderProfileBinding({
      provider: "other-provider",
      model: "pcb-intent-model-v7",
      tier: "provider-default",
      adapterSchemaVersion: "evleda.fixture-pcb-provider.v1"
    });
    expect(() => createPcbDesignInterpreterPort(dependencies(resolvedDraft()), wrongProvider)).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT" })
    );
  });

  it("threads the host-owned interpreter deadline through the compilation port", async () => {
    let receivedSignal: AbortSignal | undefined;
    const hanging: PcbIntentProvider = {
      provider: "fixture",
      turn: async (_request, context) => await new Promise<never>(() => {
        receivedSignal = context.signal;
      }),
    };
    const port = createPcbDesignInterpreterPort(
      { provider: hanging, compilerOptions },
      providerProfile(),
      { timeoutMs: 10 },
    );
    await expect(port.interpretCompilation({
      prompt: "Bound this interpretation turn.",
      clarificationAnswers: [],
    })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("passes a nominal closed interpreter failure through without wrapping or exposing provider fields", async () => {
    const secret = "sk-private-model-output C:\\private\\turn.json";
    const port = createPcbDesignInterpreterPort(
      dependencies({ ...resolvedDraft(), unexpected: secret }),
      providerProfile(),
    );
    let caught: unknown;
    try {
      await port.interpretCompilation({ prompt: "Reject an invalid intent draft.", clarificationAnswers: [] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PcbDesignInterpreterError);
    expect(caught).toMatchObject({ code: "INVALID_DRAFT" });
    expect(String((caught as Error).message)).not.toContain(secret);
  });
});
