import { describe, expect, it } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";

import type {
  HarnessProvider,
  HarnessProviderRequest,
  HarnessProviderTurn,
  HarnessToolCall,
  HarnessToolDefinition,
  HarnessToolPort,
  HarnessToolResult
} from "../../src/harness/contracts.js";
import {
  DEFAULT_PCB_HARNESS_VALIDATION_TOOLS,
  PCB_AGENT_MAX_FRESH_ITERATIONS,
  runPcbAgentHarness
} from "../../src/harness/pcb-agent-harness.js";
import { serializeFreshContractConnectivityResult } from "../../src/harness/kicad-tools.js";
import { compareFreshNativeNetlists } from "../../src/harness/fresh-native-netlist-comparison.js";

const designTool: HarnessToolDefinition = {
  name: "pcb_place_component",
  description: "Place one footprint.",
  inputSchema: { type: "object" }
};
const compoundIdentity = {
  algorithm: "sha256",
  digest: "a".repeat(64),
  schemaVersion: "evleda.fresh-connectivity-contract.v1",
  canonicalizationVersion: "evleda-c14n-json-v1",
} as const;
const syncMetadata = () => ({
  schematicContentIdentity: contentIdentity("exact saved schematic bytes"),
  nativeNetlistComparison: compareFreshNativeNetlists(
    '(export (design (source "fixture.kicad_sch") (date "2026-09-08T23:44:50")))',
    '(export (design (source "fixture.kicad_sch") (date "2026-09-08T23:44:55")))',
  ),
  receivedSidecarResponseIdentity: contentIdentity("complete received sync response"),
  placementReview: { status: "pending-final-acceptance", interimFindings: [] as string[] },
});
const completeSyncPayload = () => {
  const content = contentIdentity("fixture source");
  const payload = {
    schemaVersion: "evleda.fresh-sync-from-schematic-result.v1",
    contractIdentity: compoundIdentity,
    genericProjectBindingIdentity: { ...compoundIdentity, schemaVersion: "evleda.pcb-agent-generic-fresh-binding.v1" },
    freshMarkerContentIdentity: content,
    applied: true, mutated: true, idempotent: false,
    beforePcbContentIdentity: content, afterPcbContentIdentity: contentIdentity("synced PCB source"),
    ...syncMetadata(), footprintLibraryTableIdentity: content,
    componentCount: 3, padCount: 7, namedPadCount: 7, noConnectPadCount: 0, unresolvedMappingCount: 0, issues: [],
  };
  return { ...payload, identity: canonicalIdentity(payload, payload.schemaVersion) };
};
const recommendationMoves = [{ reference: "C1", xMm: 25.4, yMm: 25.4, rotationDeg: 0 as const }];
const completeSyncV2Payload = () => {
  const { identity: _identity, padCount: _pads, namedPadCount: _named, noConnectPadCount: _nc, ...base } = completeSyncPayload();
  const payload = {
    ...base, schemaVersion: "evleda.fresh-sync-from-schematic-result.v2",
    physicalPadCount: 10, logicalTerminalCount: 7, numberedCopperPrimitiveCount: 9,
    namedCopperPrimitiveCount: 6, noConnectCopperPrimitiveCount: 3,
    logicalNamedTerminalCount: 5, logicalNoConnectTerminalCount: 2,
    nonElectricalFeatureCount: 1, platedFootprintHoleCount: 2,
    nativePadSnapshotIdentity: contentIdentity("native physical pad snapshot"),
    physicalPadExpectedIdentity: canonicalIdentity({ physicalPadCount: 10 }, "evleda.kicad-native-pad-expected.v1"),
    upstreamMetrics: {
      totalPadsConsidered: 9, namedPads: 6, noNetPads: 3, transferQuality: "DEGRADED",
      namedPadCoveragePercent: 66.7, fullyNamedReferences: 1, partiallyNamedReferences: 2,
      unresolvedPadReferences: "U1, J1", additionalUnresolvedReferences: 0,
      literalLines: ["Transfer quality: DEGRADED", "Named pads: 6", "No-net pads: 3"],
    },
  };
  return { ...payload, identity: canonicalIdentity(payload, payload.schemaVersion) };
};
const recommendationTargetPlacements = [...recommendationMoves];
const recommendationStartingIdentity = { ...compoundIdentity, schemaVersion: "evleda.fresh-schematic-placement-state.v1", digest: "b".repeat(64) } as const;
const recommendationStartingSchematicSha256 = "9".repeat(64);
const recommendationTargetIdentity = { ...compoundIdentity, schemaVersion: "evleda.fresh-schematic-placement-state.v1", digest: "c".repeat(64) } as const;
const recommendationSearchProfile = {
  schemaVersion: "evleda.fresh-connectivity-placement-search.v1" as const,
  gridMm: 2.54, workingBoundsMm: { minX: 15.24, minY: 15.24, maxX: 279.4, maxY: 195.58 }, slotPitchMm: 25.4, rotationPolicy: "current-only" as const,
  maxComponents: 8, maxEndpoints: 64, maxCandidatesPerComponent: 64, maxTotalCandidates: 512, maxConfigurations: 2048, maxStates: 100000, maxPlanEvaluations: 2048, maxSegmentChecks: 20000000,
} as const;
const recommendationEvidence = {
  schemaVersion: recommendationSearchProfile.schemaVersion, status: "found" as const, gridMm: 2.54 as const, slotPitchMm: 25.4 as const, rotationPolicy: "current-only" as const,
  workingBoundsMm: recommendationSearchProfile.workingBoundsMm,
  limits: { maxComponents: 8 as const, maxEndpoints: 64 as const, maxCandidatesPerComponent: 64 as const, maxTotalCandidates: 512 as const, maxConfigurations: 2048 as const, maxStates: 100000 as const, maxPlanEvaluations: 2048 as const, maxSegmentChecks: 20000000 as const },
  configurationsEvaluated: 1, statesVisited: 1, planEvaluations: 1, segmentChecks: 4, candidateCount: 4, exhaustionReason: "none" as const,
  blockingEdgeEvidence: { total: 0, returned: 0, truncated: false },
};
const recommendationPlanIdentity = canonicalIdentity({
  schemaVersion: "evleda.fresh-connectivity-placement-plan.v2",
  contractIdentity: compoundIdentity,
  startingPlacementIdentity: recommendationStartingIdentity,
  startingSchematicSha256: recommendationStartingSchematicSha256,
  targetPlacementIdentity: recommendationTargetIdentity,
  targetPlacements: recommendationTargetPlacements,
  searchProfile: recommendationSearchProfile,
  recommendedMoves: recommendationMoves,
}, "evleda.fresh-connectivity-placement-plan.v2");
const recommendationPlanArgument = {
  algorithm: recommendationPlanIdentity.algorithm,
  digest: recommendationPlanIdentity.digest,
  schemaVersion: recommendationPlanIdentity.schemaVersion,
  canonicalizationVersion: recommendationPlanIdentity.canonicalizationVersion,
};

const validationDefinitions: HarnessToolDefinition[] = Object.values(DEFAULT_PCB_HARNESS_VALIDATION_TOOLS).map((name) => ({
  name,
  description: `Run ${name}.`,
  inputSchema: { type: "object" }
}));

const options = (overrides: Record<string, unknown> = {}) => ({
  userPrompt: "Place U1 near J1.",
  fixedRules: ["Keep the connector on the left edge."],
  projectPath: "C:/work/board.kicad_pro",
  reportPath: "C:/work/harness-report.json",
  editsRequired: true,
  allowedToolNames: [designTool],
  maxIterations: 3,
  ...overrides
});

class FakeProvider implements HarnessProvider {
  readonly provider = "fake";
  readonly requests: HarnessProviderRequest[] = [];
  constructor(private readonly turns: readonly HarnessProviderTurn[]) {}
  async turn(request: HarnessProviderRequest): Promise<HarnessProviderTurn> {
    this.requests.push(request);
    const turn = this.turns[this.requests.length - 1];
    if (!turn) throw new Error("unexpected provider call");
    return turn;
  }
}

class FakeTools implements HarnessToolPort {
  readonly tools = [designTool, ...validationDefinitions];
  readonly calls: HarnessToolCall[] = [];
  readonly validationToolNames = Object.values(DEFAULT_PCB_HARNESS_VALIDATION_TOOLS)
    .filter((name) => name !== DEFAULT_PCB_HARNESS_VALIDATION_TOOLS.save) as string[];
  constructor(private readonly validation: readonly string[] = ["clean", "clean", "summary", "clean"]) {}
  async execute(call: HarnessToolCall): Promise<HarnessToolResult> {
    this.calls.push(call);
    if (call.name === DEFAULT_PCB_HARNESS_VALIDATION_TOOLS.save) {
      return { toolCallId: call.id, content: JSON.stringify({ status: "saved" }) };
    }
    const validationIndex = this.validationToolNames.indexOf(call.name);
    const content = validationIndex < 0 ? "placed" : this.validation[(this.calls.filter((entry) => this.validationToolNames.includes(entry.name)).length - 1) % this.validation.length]!;
    const payload = call.name === "pcb_get_board_summary"
      ? { status: "clean", findings: [], metadata: { footprints: 12, pads: 24, nets: 4, tracks: 10, shapes: 4 } }
      : call.name === "pcb_visual_qa"
        ? { status: content, findings: content === "clean" ? [] : [{ message: content }], footprint_count: 12, board_bounds: [0, 0, 30, 20] }
        : { status: content, findings: content === "clean" ? [] : [{ message: content }] };
    return { toolCallId: call.id, content: JSON.stringify(payload) };
  }
}

const editTurn = (id = "edit-1"): HarnessProviderTurn => ({
  message: { role: "assistant", content: "I will place U1." },
  stopReason: "tool_calls",
  toolCalls: [{ id, name: designTool.name, arguments: { ref: "U1" } }]
});

const rawValidationPort = (overrides: Partial<Record<"run_erc" | "run_drc" | "pcb_get_board_summary" | "pcb_visual_qa", unknown>> = {}): HarnessToolPort => ({
  tools: [designTool, ...validationDefinitions],
  async execute(call) {
    const defaults: Record<string, unknown> = {
      run_erc: { status: "clean", findings: [], metadata: { available: true, violation_count: 0 } },
      run_drc: { status: "clean", findings: [], metadata: { available: true, violations: 0, unconnected_items: 0, courtyard_issues: 0 } },
      pcb_get_board_summary: { status: "clean", findings: [], metadata: { footprints: 4, pads: 8, nets: 3, tracks: 5, shapes: 1 } },
      pcb_visual_qa: { status: "PASS", findings: [], footprint_count: 4, board_bounds: [0, 0, 30, 20] },
      pcb_save: { status: "saved" },
      pcb_place_component: { status: "placed" },
    };
    return { toolCallId: call.id, content: JSON.stringify(overrides[call.name as keyof typeof overrides] ?? defaults[call.name] ?? { status: "clean" }) };
  },
});

const cleanValidationResult = (call: HarnessToolCall): HarnessToolResult => {
  const payload = call.name === "pcb_get_board_summary"
    ? { status: "clean", findings: [], metadata: { footprints: 4, pads: 8, nets: 3, tracks: 5, shapes: 1 } }
    : call.name === "pcb_visual_qa"
      ? { status: "PASS", findings: [], footprint_count: 4, board_bounds: [0, 0, 30, 20] }
      : { status: "clean", findings: [] };
  return { toolCallId: call.id, content: JSON.stringify(payload) };
};

describe("bounded PCB agent harness", () => {
  it.each(["DEGRADED", "POOR", "UNKNOWN", "CLEAN"])("accepts V2 physical NC metrics with literal %s while requiring save and final acceptance", async (quality) => {
    const payload = completeSyncV2Payload();
    payload.upstreamMetrics.transferQuality = quality;
    payload.upstreamMetrics.literalLines[0] = `Transfer quality: ${quality}`;
    const { identity: _identity, ...body } = payload;
    payload.identity = canonicalIdentity(body, payload.schemaVersion);
    const definition = { name: "fresh_sync_from_schematic", description: "Sync", inputSchema: { type: "object" } };
    const calls: string[] = [];
    const fake = new FakeTools();
    const result = await runPcbAgentHarness(options({ allowedToolNames: [definition], maxIterations: 1 }),
      new FakeProvider([{ message: { role: "assistant", content: "Sync" }, stopReason: "tool_calls", toolCalls: [{ id: "v2", name: definition.name, arguments: {} }] }]),
      { tools: [definition, ...validationDefinitions], execute: async (call) => {
        calls.push(call.name);
        return call.name === definition.name ? { toolCallId: call.id, content: JSON.stringify(payload) } : fake.execute(call);
      } },
      { compoundMutationContractIdentity: compoundIdentity, completionGate: async () => {
        calls.push("completionGate"); return { passed: false, missing: ["placement still requires final acceptance"] };
      } });
    expect(result.status).toBe("needs_review");
    expect(calls).toEqual([definition.name, "pcb_save", "run_erc", "run_drc", "pcb_get_board_summary", "pcb_visual_qa", "completionGate"]);
    expect(payload.upstreamMetrics.transferQuality).toBe(quality);
  });

  it.each([
    ["physical equation", ["physicalPadCount"], 11],
    ["copper equation", ["namedCopperPrimitiveCount"], 5],
    ["logical equation", ["logicalTerminalCount"], 8],
    ["plated bound", ["platedFootprintHoleCount"], 10],
    ["fractional count", ["physicalPadCount"], 10.5],
    ["upstream logical count substitution", ["upstreamMetrics", "totalPadsConsidered"], 7],
    ["missing snapshot", ["nativePadSnapshotIdentity"], undefined],
    ["missing expected identity", ["physicalPadExpectedIdentity"], undefined],
    ["wrong expected identity domain", ["physicalPadExpectedIdentity", "schemaVersion"], "wrong"],
    ["old pad field", ["padCount"], 10],
    ["old named field", ["namedPadCount"], 6],
    ["old NC field", ["noConnectPadCount"], 3],
    ["unknown upstream field", ["upstreamMetrics", "extra"], true],
    ["missing source binding", ["schematicContentIdentity"], undefined],
    ["unready placement", ["placementReview", "status"], "passed"],
    ["wrong host contract", ["contractIdentity", "digest"], "e".repeat(64)],
    ["forged outer identity", ["identity", "digest"], "e".repeat(64)],
  ] as const)("rejects V2 %s before save or completion", async (label, path, replacement) => {
    const payload = structuredClone(completeSyncV2Payload()) as Record<string, unknown>;
    let parent = payload;
    for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
    if (replacement === undefined) delete parent[path.at(-1)!]; else parent[path.at(-1)!] = replacement;
    if (label !== "forged outer identity") {
      const { identity: _identity, ...body } = payload;
      payload.identity = canonicalIdentity(body, "evleda.fresh-sync-from-schematic-result.v2");
    }
    const definition = { name: "fresh_sync_from_schematic", description: "Sync", inputSchema: { type: "object" } };
    const calls: string[] = [];
    const result = await runPcbAgentHarness(options({ allowedToolNames: [definition], maxIterations: 1 }),
      new FakeProvider([{ message: { role: "assistant", content: "Sync" }, stopReason: "tool_calls", toolCalls: [{ id: "v2-invalid", name: definition.name, arguments: {} }] }]),
      { tools: [definition, ...validationDefinitions], execute: async (call) => { calls.push(call.name); return { toolCallId: call.id, content: JSON.stringify(payload) }; } },
      { compoundMutationContractIdentity: compoundIdentity, completionGate: async () => { calls.push("completionGate"); return { passed: true, missing: [] }; } });
    expect(result.status).toBe("blocked");
    expect(calls).toEqual([definition.name]);
  });

  it.each([false, true])("requires successful V2 durable save before clean completion (save failure: %s)", async (saveFails) => {
    const payload = completeSyncV2Payload();
    const definition = { name: "fresh_sync_from_schematic", description: "Sync", inputSchema: { type: "object" } };
    const calls: string[] = [];
    const fake = new FakeTools();
    const result = await runPcbAgentHarness(options({ allowedToolNames: [definition], maxIterations: 1 }),
      new FakeProvider([{ message: { role: "assistant", content: "Sync" }, stopReason: "tool_calls", toolCalls: [{ id: "v2-save", name: definition.name, arguments: {} }] }]),
      { tools: [definition, ...validationDefinitions], execute: async (call) => {
        calls.push(call.name);
        if (call.name === definition.name) return { toolCallId: call.id, content: JSON.stringify(payload) };
        if (call.name === "pcb_save" && saveFails) throw new Error("durable save failed");
        return fake.execute(call);
      } },
      { compoundMutationContractIdentity: compoundIdentity, completionGate: async () => { calls.push("completionGate"); return { passed: true, missing: [] }; } });
    expect(result.status).toBe(saveFails ? "blocked" : "completed");
    expect(calls).toEqual(saveFails ? [definition.name, "pcb_save"] : [definition.name, "pcb_save", "run_erc", "run_drc", "pcb_get_board_summary", "pcb_visual_qa", "completionGate"]);
  });
  it("sends a compiler-owned provider prompt byte-for-byte without legacy rendering or truncation", async () => {
    const exact = `GENERIC DIVIDER EXECUTION\n${"exact-prompt-byte-".repeat(1_200)}\nEND`;
    const provider = new FakeProvider([editTurn()]);
    const result = await runPcbAgentHarness(options({ userPrompt: "must-not-appear" }), provider, new FakeTools(), {
      exactProviderPrompt: { text: exact, textContentIdentity: contentIdentity(exact) },
    });
    expect(provider.requests[0]?.messages[1]).toStrictEqual({ role: "user", content: exact });
    expect(result.prompt).toBe(exact);
    expect(result.prompt).not.toContain("Requested PCB work");
    expect(result.prompt).not.toContain("[truncated]");
    expect(result.providerPromptContentIdentity).toStrictEqual(contentIdentity(exact));
    expect(result.schemaVersion).toBe("evleda.pcb-agent-harness-run.v2");
  });

  it("rejects an exact provider prompt whose claimed content identity is wrong", async () => {
    await expect(runPcbAgentHarness(options(), new FakeProvider([editTurn()]), new FakeTools(), {
      exactProviderPrompt: { text: "generic divider", textContentIdentity: contentIdentity("other bytes") },
    })).rejects.toThrow(/content identity/iu);
    const exact = "generic divider exact prompt";
    await expect(runPcbAgentHarness(options(), new FakeProvider([editTurn()]), new FakeTools(), {
      exactProviderPrompt: { text: exact, textContentIdentity: contentIdentity(exact) },
      taskContract: "append me",
    })).rejects.toThrow(/cannot be combined/iu);
  });

  it("keeps native-clean validation unresolved when host sources drift during that pass", async () => {
    let captures = 0;
    const result = await runPcbAgentHarness(options({ maxIterations: 1 }), new FakeProvider([editTurn()]), new FakeTools(), {
      captureValidationSource: async () => ({
        schematic: contentIdentity(`schematic-${captures++}`),
        pcb: contentIdentity("pcb-stable"),
      }),
    });
    expect(result.status).toBe("needs_review");
    expect(result.validation.status).toBe("unresolved");
    expect(result.validation.sourceBinding?.unchanged).toBe(false);
    expect(result.validation.unresolvedItems).toContainEqual(expect.stringMatching(/changed during the native validation pass/iu));
  });

  it("passes only the unchanged host source binding from the same native validation pass to completion", async () => {
    const snapshot = { schematic: contentIdentity("stable schematic"), pcb: contentIdentity("stable pcb") };
    let observedBinding: unknown;
    const result = await runPcbAgentHarness(options({ maxIterations: 1 }), new FakeProvider([editTurn()]), new FakeTools(), {
      captureValidationSource: async () => snapshot,
      completionGate: async (evidence) => {
        observedBinding = evidence.sourceBinding;
        return { passed: false, missing: ["netclass:DEFAULT:clearance [unknown]: host rule evidence unavailable"] };
      },
    });
    expect(observedBinding).toMatchObject({
      schemaVersion: "evleda.pcb-harness-validation-source-binding.v1",
      before: snapshot,
      after: snapshot,
      unchanged: true,
      identity: expect.objectContaining({ schemaVersion: "evleda.pcb-harness-validation-source-binding.v1" }),
    });
    expect(result.status).toBe("needs_review");
    expect(result.summary).toContain("clearance [unknown]");
  });

  it("creates through the tool port and completes only after ERC, DRC, board summary, and visual validation", async () => {
    const provider = new FakeProvider([editTurn()]);
    const tools = new FakeTools();
    const result = await runPcbAgentHarness(options(), provider, tools);
    expect(result.status).toBe("completed");
    expect(result.validation).toMatchObject({ status: "passed", ercRuns: 1, drcRuns: 1, boardReviewRuns: 2 });
    expect(tools.calls.map((call) => call.name)).toEqual([
      designTool.name,
      DEFAULT_PCB_HARNESS_VALIDATION_TOOLS.save,
      ...Object.values(DEFAULT_PCB_HARNESS_VALIDATION_TOOLS)
        .filter((name) => name !== DEFAULT_PCB_HARNESS_VALIDATION_TOOLS.save)
    ]);
    expect(result.summary).not.toMatch(/manufactur|release/iu);
  });

  it.each([
    ["ERC", { run_erc: { status: "failed", findings: [], issues: [], metadata: { available: true, violation_count: 8 } } }, /ERC reported nonzero blocking counts.*violation_count=8/iu],
    ["DRC", { run_drc: { status: "failed", findings: [], issues: [], metadata: { available: true, violations: 3, unconnected_items: 2, courtyard_issues: 1 } } }, /DRC reported nonzero blocking counts.*violations=3/iu],
  ] as const)("keeps raw %s failure unresolved with explicit counts even when issues are empty and visual says PASS on an empty board", async (_label, failed, expectedIssue) => {
    const result = await runPcbAgentHarness(
      options({ maxIterations: 1 }),
      new FakeProvider([editTurn()]),
      rawValidationPort({
        ...failed,
        pcb_get_board_summary: { status: "clean", findings: [], metadata: { footprints: 0, pads: 0, nets: 0, tracks: 0, shapes: 0 } },
        pcb_visual_qa: { status: "PASS", findings: [], footprint_count: 0, board_bounds: null },
      }),
    );
    expect(result.status).toBe("needs_review");
    expect(result.validation.status).toBe("unresolved");
    expect(result.validation.unresolvedItems).toContainEqual(expect.stringMatching(expectedIssue));
    expect(result.iterations[0]?.validation.passed).toBe(false);
    expect(result.summary).toMatch(/Validation unresolved/iu);
  });

  it("keeps a native-shaped all-clean validation pass as passed", async () => {
    const result = await runPcbAgentHarness(options(), new FakeProvider([editTurn()]), rawValidationPort());
    expect(result.status).toBe("completed");
    expect(result.validation).toMatchObject({ status: "passed", unresolvedItems: [] });
    expect(result.iterations[0]?.validation.passed).toBe(true);
  });

  it.each([
    ["failed status cannot be overridden by passed true", { status: "failed", passed: true, findings: [], metadata: { violation_count: 0 } }, /contradict/iu],
    ["clean status cannot override passed false", { status: "clean", passed: false, findings: [], metadata: { violation_count: 0 } }, /contradict/iu],
    ["nonempty warning finding and count are blocking", { status: "clean", findings: [{ severity: "warning", description: "Library warning" }], metadata: { warning_count: 1 } }, /Library warning|warning_count=1/iu],
    ["malformed known count cannot pass", { status: "clean", findings: [], metadata: { violation_count: "0" } }, /malformed types.*violation_count/iu],
    ["malformed disposition type cannot ride passed true", { status: 7, passed: true, findings: [], metadata: { violation_count: 0 } }, /status\/verdict\/passed fields have malformed types/iu],
  ] as const)("fails closed for internally inconsistent native evidence: %s", async (_name, run_erc, issue) => {
    const result = await runPcbAgentHarness(
      options({ maxIterations: 1 }), new FakeProvider([editTurn()]), rawValidationPort({ run_erc }),
    );
    expect(result.status).toBe("needs_review");
    expect(result.validation.status).toBe("unresolved");
    expect(result.validation.unresolvedItems).toContainEqual(expect.stringMatching(issue));
    expect(result.iterations[0]?.validation.passed).toBe(false);
  });

  it("rejects arbitrary nonempty board JSON and zero-footprint visual PASS", async () => {
    const result = await runPcbAgentHarness(options({ maxIterations: 1 }), new FakeProvider([editTurn()]), rawValidationPort({
      pcb_get_board_summary: { status: "clean", findings: [], arbitrary: "nonempty" },
      pcb_visual_qa: { status: "PASS", findings: [], footprint_count: 0, board_bounds: [0, 0, 30, 20] },
    }));
    expect(result.status).toBe("needs_review");
    expect(result.validation.status).toBe("unresolved");
    expect(result.validation.unresolvedItems).toEqual(expect.arrayContaining([
      expect.stringMatching(/Board summary lacks required nonempty design evidence/iu),
      expect.stringMatching(/footprint_count=0/iu),
    ]));
  });

  it("emits ordered operation and validation observations without changing the run", async () => {
    const observed: string[] = [];
    const result = await runPcbAgentHarness(options(), new FakeProvider([editTurn()]), new FakeTools(), {
      observer: async (event) => {
        observed.push(event.type === "operation" ? `${event.type}:${event.operation.name}` : `${event.type}:${event.iteration}`);
        throw new Error("a local progress display failed");
      },
    });
    expect(result.status).toBe("completed");
    expect(observed).toEqual([
      "operation:pcb_place_component",
      "operation:pcb_save",
      "operation:run_erc",
      "operation:run_drc",
      "operation:pcb_get_board_summary",
      "operation:pcb_visual_qa",
      "validation:1",
    ]);
  });

  it("feeds failed DRC compactly into a repair iteration", async () => {
    const provider = new FakeProvider([editTurn("edit-1"), editTurn("edit-2")]);
    const tools = new FakeTools(["clean", "failed", "summary", "clean", "clean", "clean", "summary", "clean"]);
    const result = await runPcbAgentHarness(options(), provider, tools);
    expect(result.status).toBe("completed");
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]!.messages).toContainEqual(expect.objectContaining({
      role: "assistant",
      toolCalls: [{ id: "edit-1", name: designTool.name, arguments: { ref: "U1" } }],
    }));
    expect(provider.requests[1]!.messages.at(-1)?.content).toMatch(/Validation unresolved|DRC/iu);
    expect(result.validation.runs).toBe(2);
  });

  it("fails provider output that requests an unsupported tool", async () => {
    const provider = new FakeProvider([{ ...editTurn(), toolCalls: [{ id: "bad", name: "shell.exec", arguments: {} }] }]);
    const result = await runPcbAgentHarness(options(), provider, new FakeTools());
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/Unsupported tool/u);
  });

  it("fails duplicate provider tool-call IDs before executing either call", async () => {
    const provider = new FakeProvider([{ ...editTurn(), toolCalls: [editTurn().toolCalls[0]!, editTurn().toolCalls[0]!] }]);
    const tools = new FakeTools();
    const result = await runPcbAgentHarness(options(), provider, tools);
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/Duplicate tool-call ID/u);
    expect(tools.calls).toHaveLength(0);
  });

  it("blocks a precise tool error without starting validation", async () => {
    const provider = new FakeProvider([editTurn()]);
    const tools: HarnessToolPort = {
      tools: [designTool, ...validationDefinitions],
      async execute(call) { return { toolCallId: call.id, content: "disk full", isError: true }; }
    };
    const result = await runPcbAgentHarness(options(), provider, tools);
    expect(result.status).toBe("blocked");
    expect(result.summary).toContain("disk full");
    expect(result.validation.runs).toBe(0);
  });

  it("stops at the configured iteration bound with unresolved validation", async () => {
    const provider = new FakeProvider([editTurn("a"), editTurn("b")]);
    const tools = new FakeTools(["clean", "failed", "summary", "clean"]);
    const result = await runPcbAgentHarness(options({ maxIterations: 2 }), provider, tools);
    expect(result.status).toBe("needs_review");
    expect(result.validation.runs).toBe(2);
    expect(result.validation.unresolvedItems).toContain("failed");
  });

  it("does not accept a prose-only completion before required edits", async () => {
    const provider = new FakeProvider([{ message: { role: "assistant", content: "done" }, stopReason: "completed", toolCalls: [] }]);
    const result = await runPcbAgentHarness(options(), provider, new FakeTools());
    expect(result.status).toBe("failed");
    expect(result.validation.status).toBe("not_run");
  });

  it("frames the unique CLI request with rendered constraints in the first provider user message and report", async () => {
    const provider = new FakeProvider([editTurn()]);
    const tools = new FakeTools();
    const result = await runPcbAgentHarness(options({ userPrompt: "UNIQUE_ROUTE_REQUEST_7f3c", fixedRules: ["Keep J1 on the left edge."] }), provider, tools);
    const user = provider.requests[0]!.messages.find((message) => message.role === "user");
    expect(user?.content).toContain("UNIQUE_ROUTE_REQUEST_7f3c");
    expect(user?.content).toContain("Keep J1 on the left edge.");
    expect(result.prompt).toContain("UNIQUE_ROUTE_REQUEST_7f3c");
  });

  it("does not treat a read-only tool call as a required mutation", async () => {
    const readOnly: HarnessToolDefinition = { name: "pcb_get_tracks", description: "Inspect tracks.", inputSchema: { type: "object" } };
    const provider = new FakeProvider([{
      message: { role: "assistant", content: "Inspecting." }, stopReason: "tool_calls",
      toolCalls: [{ id: "read-1", name: readOnly.name, arguments: {} }],
    }]);
    const tools: HarnessToolPort = {
      tools: [readOnly, ...validationDefinitions],
      async execute(call) { return { toolCallId: call.id, content: JSON.stringify({ status: "clean", findings: [] }) }; },
    };
    const result = await runPcbAgentHarness(options({ allowedToolNames: [readOnly], maxIterations: 1 }), provider, tools);
    expect(result.status).toBe("needs_review");
    expect(result.validation.runs).toBe(0);
  });

  it("runs host-owned connectivity readback after an incremental schematic edit", async () => {
    const schematicTool: HarnessToolDefinition = { name: "sch_add_symbol", description: "Add one symbol.", inputSchema: { type: "object" } };
    const provider = new FakeProvider([{
      message: { role: "assistant", content: "Add R1." }, stopReason: "tool_calls",
      toolCalls: [{ id: "sch-1", name: schematicTool.name, arguments: { reference: "R1" } }],
    }]);
    const tools = new FakeTools();
    const toolPort: HarnessToolPort = {
      tools: [schematicTool, ...validationDefinitions, { name: "sch_get_connectivity_graph", description: "Read connectivity.", inputSchema: { type: "object" } }],
      execute: tools.execute.bind(tools),
    };
    const result = await runPcbAgentHarness(options({ allowedToolNames: [schematicTool] }), provider, toolPort, {
      postSchematicReadbackTool: "sch_get_connectivity_graph",
    });
    expect(result.status).toBe("completed");
    expect(tools.calls.map((call) => call.name)).toEqual(expect.arrayContaining(["sch_add_symbol", "sch_get_connectivity_graph"]));
  });

  it("consumes only a host no-governed-effect disposition before save, reads back, and continues", async () => {
    const schematicTool: HarnessToolDefinition = { name: "sch_modify_property", description: "Set a property.", inputSchema: { type: "object" } };
    const readback: HarnessToolDefinition = { name: "sch_get_connectivity_graph", description: "Read connectivity.", inputSchema: { type: "object" } };
    const provider = new FakeProvider([
      { message: { role: "assistant", content: "Repeat the existing property." }, stopReason: "tool_calls", toolCalls: [{ id: "noop", name: schematicTool.name, arguments: {} }] },
      { message: { role: "assistant", content: "Make the real correction." }, stopReason: "tool_calls", toolCalls: [{ id: "real", name: schematicTool.name, arguments: {} }] },
    ]);
    const calls: string[] = [];
    let dispositionReads = 0;
    const port: HarnessToolPort = {
      tools: [schematicTool, readback, ...validationDefinitions],
      async execute(call) { calls.push(call.name); return cleanValidationResult(call); },
      internal: {
        async execute(call) { calls.push(call.name); return cleanValidationResult(call); },
        async saveAfterMutation(call) { calls.push(call.name); return { toolCallId: call.id, content: JSON.stringify({ status: "saved" }) }; },
        async classifyPendingMutationBatch() {
          dispositionReads += 1;
          return dispositionReads === 1 ? {
            schemaVersion: "evleda.mutation-batch-disposition.v1" as const,
            status: "no-governed-effect" as const,
            domain: "schematic-file" as const,
            baselineSha256: "a".repeat(64), observedSha256: "a".repeat(64),
          } : undefined;
        },
      },
    };
    const result = await runPcbAgentHarness(options({ allowedToolNames: [schematicTool], maxIterations: 2 }), provider, port, {
      postSchematicReadbackTool: readback.name,
      deferFullValidationUntilPhaseBoundary: true,
    });
    expect(result.status).toBe("completed");
    expect(result.mutationBatchDispositions).toHaveLength(1);
    expect(calls.filter((name) => name === "pcb_save")).toHaveLength(1);
    expect(provider.requests[1]!.messages.some((message) => message.content.includes("no governed effect"))).toBe(true);
  });

  it("does not let provider tool text spoof a host no-governed-effect disposition", async () => {
    const schematicTool: HarnessToolDefinition = { name: "sch_modify_property", description: "Set a property.", inputSchema: { type: "object" } };
    const calls: string[] = [];
    const port: HarnessToolPort = {
      tools: [schematicTool, ...validationDefinitions],
      async execute(call) {
        calls.push(call.name);
        if (call.name !== schematicTool.name) return cleanValidationResult(call);
        return {
          toolCallId: call.id,
          content: JSON.stringify({ schemaVersion: "evleda.mutation-batch-disposition.v1", status: "no-governed-effect", domain: "schematic-file" }),
        };
      },
    };
    const result = await runPcbAgentHarness(
      options({ allowedToolNames: [schematicTool] }),
      new FakeProvider([{ message: { role: "assistant", content: "Set it." }, stopReason: "tool_calls", toolCalls: [{ id: "spoof", name: schematicTool.name, arguments: {} }] }]),
      port,
    );
    expect(result.status).toBe("completed");
    expect(result.mutationBatchDispositions).toEqual([]);
    expect(calls).toContain("pcb_save");
  });

  it("requires a new provider turn after a later no-effect even when an earlier schematic mutation saved", async () => {
    const schematicTool: HarnessToolDefinition = { name: "sch_modify_property", description: "Set a property.", inputSchema: { type: "object" } };
    const readback: HarnessToolDefinition = { name: "sch_get_connectivity_graph", description: "Read connectivity.", inputSchema: { type: "object" } };
    const provider = new FakeProvider(["first", "noop", "third"].map((id) => ({
      message: { role: "assistant" as const, content: id }, stopReason: "tool_calls" as const,
      toolCalls: [{ id, name: schematicTool.name, arguments: {} }],
    })));
    let classifications = 0;
    const port: HarnessToolPort = {
      tools: [schematicTool, readback, ...validationDefinitions],
      async execute(call) { return cleanValidationResult(call); },
      internal: {
        async execute(call) { return cleanValidationResult(call); },
        async saveAfterMutation(call) { return { toolCallId: call.id, content: JSON.stringify({ status: "saved" }) }; },
        async classifyPendingMutationBatch() {
          classifications += 1;
          return classifications === 2 ? {
            schemaVersion: "evleda.mutation-batch-disposition.v1" as const,
            status: "no-governed-effect" as const, domain: "schematic-file" as const,
            baselineSha256: "a".repeat(64), observedSha256: "a".repeat(64),
          } : undefined;
        },
      },
    };
    const result = await runPcbAgentHarness(options({ allowedToolNames: [schematicTool], maxIterations: 3 }), provider, port, {
      postSchematicReadbackTool: readback.name,
      deferFullValidationUntilPhaseBoundary: true,
    });
    expect(result.status).toBe("completed");
    expect(provider.requests).toHaveLength(3);
    expect(result.validation.runs).toBe(1);
  });

  it("returns needs_review rather than completing when the final iteration has no governed effect", async () => {
    const schematicTool: HarnessToolDefinition = { name: "sch_modify_property", description: "Set a property.", inputSchema: { type: "object" } };
    const readback: HarnessToolDefinition = { name: "sch_get_connectivity_graph", description: "Read connectivity.", inputSchema: { type: "object" } };
    const port: HarnessToolPort = {
      tools: [schematicTool, readback, ...validationDefinitions],
      async execute(call) { return { toolCallId: call.id, content: JSON.stringify({ status: "clean", findings: [] }) }; },
      internal: {
        async execute(call) { return { toolCallId: call.id, content: JSON.stringify({ status: "clean", findings: [] }) }; },
        async saveAfterMutation(call) { return { toolCallId: call.id, content: "unexpected save" }; },
        async classifyPendingMutationBatch() { return {
          schemaVersion: "evleda.mutation-batch-disposition.v1" as const,
          status: "no-governed-effect" as const, domain: "schematic-file" as const,
          baselineSha256: "a".repeat(64), observedSha256: "a".repeat(64),
        }; },
      },
    };
    const result = await runPcbAgentHarness(options({ allowedToolNames: [schematicTool], maxIterations: 1 }), new FakeProvider([{
      message: { role: "assistant", content: "same property" }, stopReason: "tool_calls", toolCalls: [{ id: "noop", name: schematicTool.name, arguments: {} }],
    }]), port, { postSchematicReadbackTool: readback.name });
    expect(result.status).toBe("needs_review");
    expect(result.validation.runs).toBe(0);
    expect(result.summary).toMatch(/no governed schematic-file effect/iu);
  });

  it("continues after recoverable contract feedback without attempting a false save", async () => {
    const compound: HarnessToolDefinition = { name: "fresh_apply_contract_connectivity", description: "Apply bound connectivity.", inputSchema: { type: "object", additionalProperties: false, properties: {}, required: [] } };
    const atomic: HarnessToolDefinition = { name: "fresh_apply_recommended_schematic_placement", description: "Apply recommendation.", inputSchema: { type: "object" } };
    const readback: HarnessToolDefinition = { name: "sch_get_connectivity_graph", description: "Read connectivity.", inputSchema: { type: "object" } };
    const provider = new FakeProvider([
      { message: { role: "assistant", content: "Apply the host contract." }, stopReason: "tool_calls", toolCalls: [{ id: "contract-1", name: compound.name, arguments: {} }] },
      { message: { role: "assistant", content: "Apply the complete host plan." }, stopReason: "tool_calls", toolCalls: [{ id: "move-1", name: atomic.name, arguments: { recommendationIdentity: recommendationPlanArgument } }] },
    ]);
    const tools = new FakeTools();
    const calls: string[] = [];
    const boundedRecommendation = serializeFreshContractConnectivityResult({ identity: compoundIdentity }, {
      applied: false, mutated: false, idempotent: false,
      issues: Array.from({ length: 64 }, (_, index) => ({
        code: "PIN_COORDINATE_COLLISION", message: `Collision ${index}: ${"verbose electrical placement evidence ".repeat(30)}`, remediation: `Apply only the host plan ${index}.`,
      })),
      issueEvidence: { total: 64, returned: 64, truncated: false },
      recommendedMoves: recommendationMoves,
      recommendationIdentity: recommendationPlanIdentity,
      startingPlacementIdentity: recommendationStartingIdentity,
      startingSchematicSha256: recommendationStartingSchematicSha256,
      targetPlacementIdentity: recommendationTargetIdentity,
      targetPlacements: recommendationTargetPlacements,
      recommendationInstruction: "Call fresh_apply_recommended_schematic_placement once with only this exact recommendationIdentity.",
      searchEvidence: recommendationEvidence,
      blockingEdges: [],
    });
    const port: HarnessToolPort = {
      tools: [compound, atomic, readback, ...validationDefinitions],
      async execute(call) {
        calls.push(call.name);
        if (call.name === compound.name) return {
          toolCallId: call.id,
          content: boundedRecommendation,
        };
        if (call.name === atomic.name) return {
          toolCallId: call.id,
          content: JSON.stringify({
            schemaVersion: "evleda.fresh-recommended-schematic-placement-result.v1",
            contractIdentity: compoundIdentity,
            recommendationIdentity: recommendationPlanIdentity,
            applied: true, mutated: true, idempotent: false, issues: [],
          }),
        };
        return await tools.execute(call);
      },
    };
    const result = await runPcbAgentHarness(options({ allowedToolNames: [compound, atomic], maxIterations: 2 }), provider, port, {
      postSchematicReadbackTool: readback.name,
      deferFullValidationUntilPhaseBoundary: true,
      compoundMutationContractIdentity: compoundIdentity,
    });
    expect(result.status).toBe("completed");
    expect(calls.slice(0, 3)).toEqual([compound.name, readback.name, atomic.name]);
    expect(calls.filter((name) => name === "pcb_save")).toHaveLength(1);
    expect(provider.requests).toHaveLength(2);
    const deliveredRecommendation = provider.requests[1]?.messages.find((message) => message.role === "tool");
    expect(deliveredRecommendation?.content.length).toBeLessThanOrEqual(4_000);
    expect(JSON.parse(deliveredRecommendation!.content)).toMatchObject({
      mutated: false,
      recommendationIdentity: recommendationPlanIdentity,
      targetPlacements: recommendationTargetPlacements,
      recommendationInstruction: expect.stringContaining("fresh_apply_recommended_schematic_placement"),
    });
    expect(provider.requests[1]?.messages.at(-1)?.content).toMatch(/No reviewed mutation has occurred/iu);
  });

  it("blocks a malformed compound mutation result without guessing whether to save", async () => {
    const compound: HarnessToolDefinition = { name: "fresh_apply_contract_connectivity", description: "Apply bound connectivity.", inputSchema: { type: "object" } };
    const provider = new FakeProvider([{ message: { role: "assistant", content: "Apply." }, stopReason: "tool_calls", toolCalls: [{ id: "bad-contract-result", name: compound.name, arguments: {} }] }]);
    const calls: string[] = [];
    const port: HarnessToolPort = {
      tools: [compound, ...validationDefinitions],
      async execute(call) { calls.push(call.name); return { toolCallId: call.id, content: JSON.stringify({ applied: false, issues: [] }) }; },
    };
    const result = await runPcbAgentHarness(options({ allowedToolNames: [compound], maxIterations: 1 }), provider, port, { compoundMutationContractIdentity: compoundIdentity });
    expect(result.status).toBe("blocked");
    expect(result.summary).toMatch(/invalid mutation-status contract/iu);
    expect(calls).toEqual([compound.name]);
  });

  it.each(["fresh_replace_route_items", "fresh_sync_from_schematic"] as const)(
    "accepts only identity-bound successful host board compound results: %s",
    async (name) => {
      const definition: HarnessToolDefinition = { name, description: name, inputSchema: { type: "object" } };
      const content = { algorithm: "sha256" as const, digest: "1".repeat(64), size: 10 };
      const selection = { ...compoundIdentity, schemaVersion: "evleda.fresh-route-selection.v1", digest: "2".repeat(64) } as const;
      const projectBinding = { ...compoundIdentity, schemaVersion: "evleda.pcb-agent-generic-fresh-binding.v1", digest: "4".repeat(64) } as const;
      const base = name === "fresh_replace_route_items"
        ? {
            schemaVersion: "evleda.fresh-route-replacement-result.v1" as const,
            contractIdentity: compoundIdentity, genericProjectBindingIdentity: projectBinding, freshMarkerContentIdentity: content,
            applied: true as const, mutated: true as const, idempotent: false as const,
            selectionIdentity: selection, beforePcbContentIdentity: content, livePcbContentIdentity: content,
            net: "VIN", deletedItemIds: ["11111111-1111-4111-8111-111111111111"], addedTrackCount: 1, addedViaCount: 0, issues: [] as const,
          }
        : {
            schemaVersion: "evleda.fresh-sync-from-schematic-result.v1" as const,
            contractIdentity: compoundIdentity, genericProjectBindingIdentity: projectBinding, freshMarkerContentIdentity: content,
            applied: true as const, mutated: true as const, idempotent: false as const,
            beforePcbContentIdentity: content, afterPcbContentIdentity: { ...content, digest: "3".repeat(64) }, footprintLibraryTableIdentity: content,
            ...syncMetadata(),
            componentCount: 3, padCount: 7, namedPadCount: 7, noConnectPadCount: 0, unresolvedMappingCount: 0 as const, issues: [] as const,
          };
      const schema = base.schemaVersion;
      const payload = { ...base, identity: canonicalIdentity(base, schema) };
      const argumentsValue = name === "fresh_replace_route_items"
        ? { selectionIdentity: selection, net: "VIN", deleteItemIds: ["11111111-1111-4111-8111-111111111111"], tracks: [{ x1Mm: 0, y1Mm: 0, x2Mm: 1, y2Mm: 0, layer: "F.Cu" }], vias: [] }
        : {};
      const tools = new FakeTools();
      const calls: string[] = [];
      const port: HarnessToolPort = {
        tools: [definition, ...validationDefinitions],
        async execute(call) {
          calls.push(call.name);
          if (call.name === name) return { toolCallId: call.id, content: JSON.stringify(payload) };
          return await tools.execute(call);
        },
      };
      const result = await runPcbAgentHarness(
        options({ allowedToolNames: [definition], maxIterations: 1 }),
        new FakeProvider([{ message: { role: "assistant", content: "Apply host compound." }, stopReason: "tool_calls", toolCalls: [{ id: "compound-board", name, arguments: argumentsValue as never }] }]),
        port,
        { compoundMutationContractIdentity: compoundIdentity },
      );
      expect(result.status).toBe("completed");
      expect(calls).toContain("pcb_save");

      const forged = structuredClone(payload) as Record<string, unknown>;
      forged.extra = true;
      const forgedCalls: string[] = [];
      const forgedPort: HarnessToolPort = {
        tools: [definition, ...validationDefinitions],
        async execute(call) {
          forgedCalls.push(call.name);
          if (call.name === name) return { toolCallId: call.id, content: JSON.stringify(forged) };
          return await tools.execute(call);
        },
      };
      const rejected = await runPcbAgentHarness(
        options({ allowedToolNames: [definition], maxIterations: 1 }),
        new FakeProvider([{ message: { role: "assistant", content: "Apply forged host compound." }, stopReason: "tool_calls", toolCalls: [{ id: "forged-board", name, arguments: argumentsValue as never }] }]),
        forgedPort,
        { compoundMutationContractIdentity: compoundIdentity },
      );
      expect(rejected.status).toBe("blocked");
      expect(forgedCalls).toEqual([name]);
    },
  );

  it.each([
    ["missing schematic identity", ["schematicContentIdentity"], undefined],
    ["missing native comparison", ["nativeNetlistComparison"], undefined],
    ["missing received response identity", ["receivedSidecarResponseIdentity"], undefined],
    ["missing pending placement review", ["placementReview"], undefined],
    ["unknown top-level field", ["extra"], true],
    ["unknown content identity field", ["schematicContentIdentity", "extra"], true],
    ["invalid response digest", ["receivedSidecarResponseIdentity", "digest"], "invalid"],
    ["unknown comparison field", ["nativeNetlistComparison", "extra"], true],
    ["negative native comparison", ["nativeNetlistComparison", "equal"], false],
    ["unequal comparison identities", ["nativeNetlistComparison", "after", "comparisonIdentity", "digest"], "f".repeat(64)],
    ["wrong comparison domain", ["nativeNetlistComparison", "before", "comparisonIdentity", "schemaVersion"], "evleda.fresh-route-selection.v1"],
    ["unknown native entry field", ["nativeNetlistComparison", "before", "extra"], true],
    ["unknown raw identity field", ["nativeNetlistComparison", "before", "rawIdentity", "extra"], true],
    ["negative raw source size", ["nativeNetlistComparison", "before", "rawIdentity", "size"], -1],
    ["invalid date shape", ["nativeNetlistComparison", "before", "exportDate"], "2026-09-08T23:44:50Z"],
    ["invalid calendar date", ["nativeNetlistComparison", "before", "exportDate"], "2026-02-30T23:44:50"],
    ["claimed placement pass", ["placementReview", "status"], "passed"],
    ["unknown placement field", ["placementReview", "extra"], true],
    ["non-string finding", ["placementReview", "interimFindings"], [{ message: "placement clear" }]],
    ["unsupported finding text", ["placementReview", "interimFindings"], ["PASS: placement clear"]],
    ["different contract identity", ["contractIdentity", "digest"], "e".repeat(64)],
  ] as const)("rejects current sync metadata with %s even after coherent outer rehash", async (_name, fieldPath, replacement) => {
    const payload = structuredClone(completeSyncPayload()) as Record<string, unknown>;
    let parent = payload;
    for (const key of fieldPath.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
    if (replacement === undefined) delete parent[fieldPath.at(-1)!];
    else parent[fieldPath.at(-1)!] = replacement;
    const { identity: _identity, ...body } = payload;
    payload.identity = canonicalIdentity(body, "evleda.fresh-sync-from-schematic-result.v1");
    const definition: HarnessToolDefinition = { name: "fresh_sync_from_schematic", description: "Import schematic.", inputSchema: { type: "object" } };
    const calls: string[] = [];
    const result = await runPcbAgentHarness(
      options({ allowedToolNames: [definition], maxIterations: 1 }),
      new FakeProvider([{ message: { role: "assistant", content: "Import." }, stopReason: "tool_calls", toolCalls: [{ id: "sync-metadata-negative", name: definition.name, arguments: {} }] }]),
      { tools: [definition, ...validationDefinitions], execute: async (call) => { calls.push(call.name); return { toolCallId: call.id, content: JSON.stringify(payload) }; } },
      { compoundMutationContractIdentity: compoundIdentity },
    );
    expect(result.status).toBe("blocked");
    expect(result.summary).toMatch(/invalid host board-mutation result|does not match the host-bound contract/iu);
    expect(calls).toEqual([definition.name]);
  });

  it("includes every new sync field in the canonical payload identity instead of dropping metadata", async () => {
    const payload = completeSyncPayload();
    const { identity: _identity, schematicContentIdentity: _schematic, nativeNetlistComparison: _native, receivedSidecarResponseIdentity: _received, placementReview: _placement, ...oldBody } = payload;
    payload.identity = canonicalIdentity(oldBody, payload.schemaVersion);
    const definition: HarnessToolDefinition = { name: "fresh_sync_from_schematic", description: "Import schematic.", inputSchema: { type: "object" } };
    const calls: string[] = [];
    const result = await runPcbAgentHarness(
      options({ allowedToolNames: [definition], maxIterations: 1 }),
      new FakeProvider([{ message: { role: "assistant", content: "Import." }, stopReason: "tool_calls", toolCalls: [{ id: "sync-old-identity", name: definition.name, arguments: {} }] }]),
      { tools: [definition, ...validationDefinitions], execute: async (call) => { calls.push(call.name); return { toolCallId: call.id, content: JSON.stringify(payload) }; } },
      { compoundMutationContractIdentity: compoundIdentity },
    );
    expect(result.status).toBe("blocked");
    expect(result.summary).toContain("identity does not reproduce from its closed payload");
    expect(calls).toEqual([definition.name]);
  });

  it.each([
    ["extra field", (value: Record<string, unknown>) => { value.extra = true; }],
    ["identity substitution", (value: Record<string, unknown>) => { value.recommendationIdentity = { ...recommendationPlanIdentity, digest: "e".repeat(64) }; }],
    ["impossible rejected mutation", (value: Record<string, unknown>) => { value.applied = false; value.mutated = true; value.issues = [{ code: "STALE_PLACEMENT_RECOMMENDATION", message: "stale", remediation: "retry" }]; }],
  ] as const)("rejects adversarial atomic placement result: %s", async (_label, mutate) => {
    const atomic: HarnessToolDefinition = { name: "fresh_apply_recommended_schematic_placement", description: "Apply recommendation.", inputSchema: { type: "object" } };
    const payload: Record<string, unknown> = {
      schemaVersion: "evleda.fresh-recommended-schematic-placement-result.v1",
      contractIdentity: compoundIdentity,
      recommendationIdentity: recommendationPlanIdentity,
      applied: true, mutated: true, idempotent: false, issues: [],
    };
    mutate(payload);
    const calls: string[] = [];
    const port: HarnessToolPort = {
      tools: [atomic, ...validationDefinitions],
      async execute(call) { calls.push(call.name); return { toolCallId: call.id, content: JSON.stringify(payload) }; },
    };
    const result = await runPcbAgentHarness(
      options({ allowedToolNames: [atomic], maxIterations: 1 }),
      new FakeProvider([{ message: { role: "assistant", content: "Apply." }, stopReason: "tool_calls", toolCalls: [{ id: "atomic-adversarial", name: atomic.name, arguments: { recommendationIdentity: recommendationPlanArgument } }] }]),
      port,
      { compoundMutationContractIdentity: compoundIdentity },
    );
    expect(result.status).toBe("blocked");
    expect(result.summary).toMatch(/invalid mutation-status|does not match its sole provider argument/iu);
    expect(calls).toEqual([atomic.name]);
  });

  it.each([
    ["wrong identity", (value: Record<string, unknown>) => { value.contractIdentity = { ...compoundIdentity, digest: "b".repeat(64) }; }],
    ["unknown field", (value: Record<string, unknown>) => { value.extra = true; }],
    ["mutated rejection without issues", (value: Record<string, unknown>) => { value.mutated = true; value.issues = []; }],
    ["malformed issue", (value: Record<string, unknown>) => { value.issues = [{ code: "bad-code", message: "x" }]; }],
    ["applied issue contradiction", (value: Record<string, unknown>) => { value.applied = true; }],
    ["non-idempotent no-op", (value: Record<string, unknown>) => { value.applied = true; value.issues = []; }],
    ["rolled-back success", (value: Record<string, unknown>) => { value.applied = true; value.idempotent = true; value.issues = []; value.rolledBack = true; }],
    ["unbound recommendation", (value: Record<string, unknown>) => { value.recommendedMoves = [{ reference: "C1", xMm: 25.4, yMm: 25.4, rotationDeg: 0 }]; }],
    ["recommendation move extra field", (value: Record<string, unknown>) => { value.recommendedMoves = [{ reference: "C1", xMm: 25.4, yMm: 25.4, rotationDeg: 0, extra: true }]; }],
    ["spoofed recommendation identity", (value: Record<string, unknown>) => {
      value.recommendedMoves = [{ reference: "C1", xMm: 25.4, yMm: 25.4, rotationDeg: 0 }];
      value.recommendationIdentity = { ...recommendationPlanIdentity, digest: "d".repeat(64) };
      value.startingPlacementIdentity = recommendationStartingIdentity;
      value.startingSchematicSha256 = recommendationStartingSchematicSha256;
      value.targetPlacementIdentity = recommendationTargetIdentity;
      value.targetPlacements = recommendationTargetPlacements;
      value.recommendationInstruction = "Call the atomic host tool.";
      value.searchEvidence = recommendationEvidence;
      value.blockingEdges = [];
    }],
  ] as const)("rejects adversarial compound result: %s", async (_label, mutate) => {
    const compound: HarnessToolDefinition = { name: "fresh_apply_contract_connectivity", description: "Apply bound connectivity.", inputSchema: { type: "object" } };
    const payload: Record<string, unknown> = {
      schemaVersion: "evleda.fresh-contract-connectivity-result.v1",
      contractIdentity: compoundIdentity,
      applied: false,
      mutated: false,
      idempotent: false,
      issues: [{ code: "PLACEMENT_REQUIRED", message: "Placement must change.", remediation: "Move the part." }],
    };
    mutate(payload);
    const calls: string[] = [];
    const port: HarnessToolPort = {
      tools: [compound, ...validationDefinitions],
      async execute(call) { calls.push(call.name); return { toolCallId: call.id, content: JSON.stringify(payload) }; },
    };
    const result = await runPcbAgentHarness(
      options({ allowedToolNames: [compound], maxIterations: 1 }),
      new FakeProvider([{ message: { role: "assistant", content: "Apply." }, stopReason: "tool_calls", toolCalls: [{ id: "adversarial", name: compound.name, arguments: {} }] }]),
      port,
      { compoundMutationContractIdentity: compoundIdentity },
    );
    expect(result.status).toBe("blocked");
    expect(result.summary).toMatch(/invalid mutation-status contract|does not match the host-bound contract|does not reproduce/iu);
    expect(calls).toEqual([compound.name]);
  });

  it("defers full validation across a batched fresh schematic phase but never skips the final boundary", async () => {
    const addSymbol: HarnessToolDefinition = { name: "sch_add_symbol", description: "Add a symbol.", inputSchema: { type: "object" } };
    const readback: HarnessToolDefinition = { name: "sch_get_connectivity_graph", description: "Read connectivity.", inputSchema: { type: "object" } };
    const provider = new FakeProvider([
      { message: { role: "assistant", content: "Batch independent symbols." }, stopReason: "tool_calls", toolCalls: [
        { id: "j1", name: "sch_add_symbol", arguments: { reference: "J1" } },
        { id: "r1", name: "sch_add_symbol", arguments: { reference: "R1" } },
      ] },
      { message: { role: "assistant", content: "Schematic phase complete." }, stopReason: "completed", toolCalls: [] },
    ]);
    const tools = new FakeTools();
    const port: HarnessToolPort = { tools: [addSymbol, readback, ...validationDefinitions], execute: tools.execute.bind(tools) };
    const result = await runPcbAgentHarness(options({ allowedToolNames: [addSymbol], maxIterations: 3 }), provider, port, {
      postSchematicReadbackTool: "sch_get_connectivity_graph", deferFullValidationUntilPhaseBoundary: true,
    });
    expect(result.status).toBe("completed");
    expect(result.validation.runs).toBe(1);
    expect(tools.calls.map((call) => call.name)).toEqual([
      "sch_add_symbol", "sch_add_symbol", "pcb_save", "sch_get_connectivity_graph",
      "run_erc", "run_drc", "pcb_get_board_summary", "pcb_visual_qa",
    ]);
    expect(provider.requests).toHaveLength(2);
  });

  it("allows a trusted fresh cap while copied runs retain the five-turn cap", async () => {
    const turns = Array.from({ length: 6 }, (_, index) => editTurn(`edit-${index + 1}`));
    const freshProvider = new FakeProvider(turns);
    const freshResult = await runPcbAgentHarness(options({ maxIterations: 6 }), freshProvider, new FakeTools(["failed", "failed", "summary", "failed"]), { maxIterations: 12 });
    expect(freshResult.status).toBe("needs_review");
    expect(freshProvider.requests).toHaveLength(6);

    const copiedProvider = new FakeProvider(turns);
    const copiedResult = await runPcbAgentHarness(options({ maxIterations: 6 }), copiedProvider, new FakeTools(["failed", "failed", "summary", "failed"]));
    expect(copiedResult.status).toBe("needs_review");
    expect(copiedProvider.requests).toHaveLength(5);
  });

  it("repairs unresolved validation after iteration twelve within a fresh 24-turn budget", async () => {
    const provider = new FakeProvider(Array.from({ length: 24 }, (_, index) => editTurn(`repair-${index + 1}`)));
    const clean = rawValidationPort(); let mutations = 0;
    const tools: HarnessToolPort = { tools: clean.tools, execute: async (call) => {
      if (call.name === designTool.name) mutations += 1;
      if (call.name === "run_drc" && mutations < 14) return { toolCallId: call.id, content: JSON.stringify({ status: "failed", findings: [{ message: "Route clearance needs repair" }] }) };
      return clean.execute(call);
    } };
    const result = await runPcbAgentHarness(options({ maxIterations: 24, maxMessages: 256 }), provider, tools, { maxIterations: PCB_AGENT_MAX_FRESH_ITERATIONS });
    expect(result.status).toBe("completed"); expect(provider.requests).toHaveLength(14);
    expect(result.iterations.at(-1)).toMatchObject({ iteration: 14, validation: { passed: true } });
    expect(provider.requests[12]!.messages.some((message) => message.content.includes("Route clearance needs repair"))).toBe(true);
  });

  it("exhausts a fresh 24-turn budget with bounded transcript headroom and keeps validation mandatory", async () => {
    const provider = new FakeProvider(Array.from({ length: 25 }, (_, index) => ({ ...editTurn(),
      toolCalls: Array.from({ length: 6 }, (_, callIndex) => ({ id: `exhaust-${index + 1}-${callIndex}`, name: designTool.name, arguments: { ref: "U1" } })),
    })));
    const tools = new FakeTools(["failed", "failed", "summary", "failed"]);
    const result = await runPcbAgentHarness(options({ maxIterations: 24, maxMessages: 256 }), provider, tools, { maxIterations: PCB_AGENT_MAX_FRESH_ITERATIONS });
    expect(result.status).toBe("needs_review"); expect(result.summary).toContain("after 24 bounded iteration(s)");
    expect(provider.requests).toHaveLength(24); expect(provider.requests.at(-1)!.messages.length).toBe(186);
    expect(result.validation.runs).toBe(24);
    await expect(runPcbAgentHarness(options({ maxIterations: 25 }), provider, tools, { maxIterations: 25 })).rejects.toThrow("through 24");
  });

  it("allows completion only after the closed gate passes and names every failed gate rule in feedback", async () => {
    const failed = await runPcbAgentHarness(options({ maxIterations: 1 }), new FakeProvider([editTurn()]), new FakeTools(), {
      completionGate: async (evidence) => {
        expect(evidence.erc.toolCallId).toContain("erc");
        expect(evidence.drc.toolCallId).toContain("drc");
        return { passed: false, missing: ["symbols [fail]: wrong value", "outline [unknown]: unsupported outline"] };
      },
    });
    expect(failed.status, failed.summary).toBe("needs_review");
    expect(failed.summary).toContain("symbols [fail]");
    expect(failed.summary).toContain("outline [unknown]");

    const passed = await runPcbAgentHarness(options(), new FakeProvider([editTurn()]), new FakeTools(), {
      completionGate: async () => ({ passed: true, missing: [] }),
    });
    expect(passed.status).toBe("completed");
  });

  it("returns ink-clearance feedback after provider completion and explicitly repairs with the remaining turn", async () => {
    const fields: HarnessToolDefinition = { name: "fresh_autoplace_schematic_fields", description: "Repair visible fields", inputSchema: { type: "object", additionalProperties: false, properties: {}, required: [] } };
    const before = contentIdentity("field at old position"); const after = contentIdentity("field at repaired position");
    const payload = { schemaVersion: "evleda.fresh-schematic-fields-result.v1", contractIdentity: compoundIdentity, applied: true, mutated: true, idempotent: false,
      beforeSchematicContentIdentity: before, afterSchematicContentIdentity: after, references: ["J1", "R1"], movedFieldCount: 2, nativeNetlistSha256: "d".repeat(64), issues: [] };
    const tools = new FakeTools(); const operations: string[] = []; let repaired = false; let invalidations = 0;
    const port: HarnessToolPort = { tools: [...tools.tools, fields, { name: "sch_get_connectivity_graph", description: "Read exact connectivity", inputSchema: { type: "object" } }],
      execute: async (call) => { operations.push(call.name); if (call.name === fields.name) { repaired = true; return { toolCallId: call.id, content: JSON.stringify({ ...payload, identity: canonicalIdentity(payload, payload.schemaVersion) }) }; } return tools.execute(call); } };
    const provider = new FakeProvider([editTurn(), { message: { role: "assistant", content: "Completed." }, stopReason: "completed", toolCalls: [] },
      { message: { role: "assistant", content: "Repair the reported field collision." }, stopReason: "tool_calls", toolCalls: [{ id: "repair-fields", name: fields.name, arguments: {} }] }]);
    const report = await runPcbAgentHarness(options({ allowedToolNames: [designTool, fields], maxIterations: 3 }), provider, port, {
      compoundMutationContractIdentity: compoundIdentity, repairCompletionGateFailures: true, postSchematicReadbackTool: "sch_get_connectivity_graph",
      invalidateCompletionEvidence: () => { invalidations += 1; }, captureValidationSource: async () => ({ schematic: repaired ? after : before, pcb: contentIdentity("board") }),
      completionGate: async () => ({ passed: repaired, missing: repaired ? [] : ["schematic-render-clearance [fail]: J1 and field text ink overlap at SVG elements 4 and 8."] }),
    });
    expect(report.status, report.summary).toBe("completed"); expect(provider.requests).toHaveLength(3);
    expect(provider.requests[2]?.messages.at(-1)?.content).toContain("schematic-render-clearance [fail]"); expect(invalidations).toBe(2);
    const repair = operations.indexOf(fields.name); expect(operations.slice(repair, repair + 3)).toEqual([fields.name, "pcb_save", "sch_get_connectivity_graph"]);
    expect(report.validation.sourceBinding?.after.schematic).toEqual(after); expect(report.validation.runs).toBe(3);
  });

  it("exhausts unsatisfied current ink clearance without suppressing provider failures or refusals", async () => {
    const completionGate = async () => ({ passed: false, missing: ["schematic-render-clearance [fail]: collision"] });
    const stopped = { message: { role: "assistant" as const, content: "Completed." }, stopReason: "completed" as const, toolCalls: [] };
    const exhausted = await runPcbAgentHarness(options({ maxIterations: 2 }), new FakeProvider([editTurn(), stopped]), new FakeTools(), { repairCompletionGateFailures: true, completionGate });
    expect(exhausted.status).toBe("needs_review"); expect(exhausted.summary).toContain("schematic-render-clearance");
    const failed = await runPcbAgentHarness(options(), new FakeProvider([editTurn()]), new FakeTools(), { repairCompletionGateFailures: true, completionGate });
    expect(failed.status).toBe("failed"); expect(failed.summary).toContain("Provider turn 2 failed");
    const refused = await runPcbAgentHarness(options(), new FakeProvider([{ ...stopped, stopReason: "blocked" }]), new FakeTools(), { repairCompletionGateFailures: true, completionGate });
    expect(refused.status).toBe("blocked");
  });

  it.each([new Error("gate preservation failure"), new DOMException("gate aborted", "AbortError")])("propagates rejected quality gates unchanged after provider completion: %s", async (failure) => {
    const provider = new FakeProvider([editTurn(), { message: { role: "assistant", content: "Completed." }, stopReason: "completed", toolCalls: [] }, editTurn("must-not-run")]);
    let gates = 0;
    await expect(runPcbAgentHarness(options({ maxIterations: 3 }), provider, new FakeTools(), { repairCompletionGateFailures: true,
      completionGate: async () => { gates += 1; if (gates === 1) return { passed: false, missing: ["schematic-render-clearance [fail]: repair visible overlap"] }; throw failure; },
    })).rejects.toBe(failure);
    expect(provider.requests).toHaveLength(2); expect(gates).toBe(2);
  });
});
