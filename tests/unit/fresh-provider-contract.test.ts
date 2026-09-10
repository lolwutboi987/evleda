import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import {
  ClaudeCliHarnessProvider,
  CODEX_CLI_TURN_ENVELOPE_SCHEMA_VERSION,
  CodexCliHarnessProvider,
  FRESH_LED_INDICATOR_PROVIDER_CONTRACT,
  FRESH_LED_INDICATOR_PROVIDER_CONTRACT_MAX_BYTES,
  FRESH_LED_DEEP_RULE_POLICY,
  KICAD_FRESH_SIDECAR_REQUIRED_TOOL_NAMES,
  LED_INDICATOR_EXAMPLE,
  OpenAIHarnessProvider,
  AnthropicHarnessProvider,
  PCB_HARNESS_TASK_CONTRACT_MAX_BYTES,
  runPcbAgentHarness,
  type CliProcess,
  type CliSpawner,
  type HarnessProvider,
  type HarnessProviderRequest,
  type HarnessProviderTurn,
  type HarnessToolDefinition,
  type HarnessToolPort,
} from "../../src/harness/index.js";
import { PCB_AGENT_HARNESS_RULE_IDENTITY, runPcbAgentCli } from "../../src/cli/pcb-agent.js";

const owned = new Set<string>();
afterEach(async () => {
  await Promise.all([...owned].map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
    owned.delete(directory);
  }));
});

const completed: HarnessProviderTurn = {
  message: { role: "assistant", content: "Done." }, toolCalls: [], stopReason: "completed",
};
const oneTool: HarnessToolDefinition = {
  name: "pcb_get_board_summary", description: "Inspect the board.", inputSchema: { type: "object" },
};
const providerRequest: HarnessProviderRequest = {
  messages: [
    { role: "system", content: "Use supplied tools only." },
    { role: "user", content: FRESH_LED_INDICATOR_PROVIDER_CONTRACT },
  ],
  tools: [oneTool],
};

class FakeProcess extends EventEmitter implements CliProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly pid = 4321;
  kill(): boolean { return true; }
}

const cliTranscript = (stdin: string): HarnessProviderRequest => {
  const marker = "HARNESS_REQUEST_JSON:\n";
  const offset = stdin.indexOf(marker);
  expect(offset).toBeGreaterThanOrEqual(0);
  const framed = JSON.parse(stdin.slice(offset + marker.length)) as { transcript: HarnessProviderRequest["messages"]; tools: HarnessProviderRequest["tools"] };
  return { messages: framed.transcript, tools: framed.tools };
};

describe("fresh LED provider contract", () => {
  it("contains the complete exact proof-board specification and is bounded without truncation", () => {
    expect(LED_INDICATOR_EXAMPLE).toMatchObject({
      schemaVersion: "evleda.fresh-led-indicator-contract.v1",
      electrical: { supplyVolts: 5, maximumTotalLoadMa: 100 },
      board: { layerCount: 2, widthMm: 30, heightMm: 20, dimensionToleranceMm: 0.05, completeOutlineRequired: true },
      components: [
        { reference: "J1", symbolId: "Connector_Generic:Conn_01x02", value: "Conn_01x02", footprintId: "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical" },
        { reference: "R1", symbolId: "Device:R", value: "1k", footprintId: "Resistor_SMD:R_0603_1608Metric" },
        { reference: "D1", symbolId: "Device:LED", value: "LED", footprintId: "LED_SMD:LED_0603_1608Metric" },
        { reference: "C1", symbolId: "Device:C", value: "100nF", footprintId: "Capacitor_SMD:C_0603_1608Metric" },
      ],
      schematic: {
        exactNets: [
          { name: "+5V", endpoints: ["J1:1", "R1:1", "C1:1"] },
          { name: "LED_A", endpoints: ["R1:2", "D1:2"] },
          { name: "GND", endpoints: ["J1:2", "D1:1", "C1:2"] },
        ],
        ledPolarity: { reference: "D1", cathodePin: "1", cathodeNet: "GND", anodePin: "2", anodeNet: "LED_A" },
        noConnectMarkers: 0,
      },
      placement: { allFootprintsOn: "F.Cu", connector: {
        reference: "J1", edge: "left", bodyAndCourtyardInsideBoard: true,
        maximumEdgeClearanceMm: 1, rotationDeg: 0, localMinusXFacesOutward: true,
      } },
      routing: {
        requiredLayer: "F.Cu", minimumWidthMm: 0.5, maximumDirectionChangeDeg: 45,
        forbidden: ["reversal", "duplicate-track", "overlap"], maximumViaCount: 0,
        everyExactNetMustBeRouted: true, danglingTrackEndpoints: 0, completeCoverageRequired: true,
        forbiddenGeometryDetection: {
          reversalMaximumInteriorAngleDeg: 0.01,
          hairpin: { parallelToleranceDeg: 0.01, maximumLegEdgeGapMm: 0.01, minimumParallelOverlapMm: 0.01, maximumConnectorPathLengthMm: 0.01 },
        },
      },
      zones: { ground: { netName: "GND", policy: "optional", addOnlyIfSafe: true, substitutesForRoutedConnectivity: false } },
      acceptance: {
        authority: expect.stringContaining("Host acceptance evaluator"),
        mandatoryRows: [
          "symbols", "schematic-nets", "no-connect", "pcb-sync-footprints", "outline", "j1-edge-orientation",
          "routed-connectivity", "trace-width", "track-turns", "vias", "erc", "drc", "visual-practice",
        ],
        native: {
          erc: { acceptedStatuses: ["clean", "pass", "passed"], availableRequired: true, maximumViolations: 0 },
          drc: { acceptedStatuses: ["clean", "pass", "passed"], availableRequired: true, maximumViolations: 0, maximumUnconnectedItems: 0, maximumCourtyardIssues: 0 },
          visualPractice: { acceptedStatuses: ["clean", "pass", "passed"], maximumFindings: 0, maximumBlockingPracticeFindings: 0 },
        },
        completedOnlyWhen: "every mandatory host row passes",
        unresolvedDisposition: "needs_review",
        prohibitedClaimsAndOutputs: ["manufacturing readiness", "release", "safety qualification", "manufacturing exports"],
      },
    });
    expect(FRESH_LED_INDICATOR_PROVIDER_CONTRACT).toContain(JSON.stringify(LED_INDICATOR_EXAMPLE, null, 2));
    expect(FRESH_LED_INDICATOR_PROVIDER_CONTRACT).not.toContain("[truncated]");
    expect(Buffer.byteLength(FRESH_LED_INDICATOR_PROVIDER_CONTRACT, "utf8")).toBeLessThanOrEqual(FRESH_LED_INDICATOR_PROVIDER_CONTRACT_MAX_BYTES);
    expect(FRESH_LED_INDICATOR_PROVIDER_CONTRACT_MAX_BYTES).toBeLessThanOrEqual(PCB_HARNESS_TASK_CONTRACT_MAX_BYTES);
  });

  it("keeps the exact task contract outside the compact general-rule budget and in the report", async () => {
    const requests: HarnessProviderRequest[] = [];
    const provider: HarnessProvider = {
      provider: "capture",
      turn: async (request) => {
        requests.push(request);
        return { message: { role: "assistant", content: "Cannot continue in this fixture." }, toolCalls: [], stopReason: "blocked" };
      },
    };
    const validationNames = ["run_erc", "run_drc", "pcb_get_board_summary", "pcb_visual_qa"];
    const tools: HarnessToolPort = {
      tools: [...new Set([oneTool.name, ...validationNames])].map((name) => ({ name, description: name, inputSchema: { type: "object" } })),
      execute: async (call) => ({ toolCallId: call.id, content: "unused" }),
    };
    const result = await runPcbAgentHarness({
      userPrompt: "Implement LED_INDICATOR_EXAMPLE.", fixedRules: ["x".repeat(4_000)],
      projectPath: "C:/isolated/project", reportPath: "C:/isolated/report.json",
      editsRequired: true, allowedToolNames: [oneTool], maxIterations: 1,
    }, provider, tools, { taskContract: FRESH_LED_INDICATOR_PROVIDER_CONTRACT });
    const outbound = requests[0]!.messages.find((message) => message.role === "user")!.content;
    expect(outbound).toContain(FRESH_LED_INDICATOR_PROVIDER_CONTRACT);
    expect(result.prompt).toContain(FRESH_LED_INDICATOR_PROVIDER_CONTRACT);
    expect(outbound).not.toMatch(/FRESH_LED_INDICATOR_TASK_CONTRACT[\s\S]*\[truncated\]/u);
    await expect(runPcbAgentHarness({
      userPrompt: "x", fixedRules: ["x"], projectPath: "C:/isolated/project", reportPath: "C:/isolated/report.json",
      editsRequired: true, allowedToolNames: [oneTool], maxIterations: 1,
    }, provider, tools, { taskContract: "x".repeat(PCB_HARNESS_TASK_CONTRACT_MAX_BYTES + 1) })).rejects.toThrow(/refusing to truncate/iu);
  });

  it("forwards every contract byte through the OpenAI and Anthropic HTTP adapters", async () => {
    let openAiBody: Record<string, unknown> | undefined;
    const openAi = new OpenAIHarnessProvider({
      model: "test", apiKey: "test", fetch: async (_input, init) => {
        openAiBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ id: "resp-provider-contract", status: "completed", error: null, incomplete_details: null, output: [{ id: "msg-provider-contract", type: "message", role: "assistant", status: "completed", content: [{ annotations: [], type: "output_text", text: "Done." }] }] }), { status: 200 });
      },
    });
    await expect(openAi.turn(providerRequest)).resolves.toMatchObject(completed);
    const openAiInput = openAiBody!.input as Array<{ role?: string; content?: Array<{ text?: string }> }>;
    expect(openAiInput.find((message) => message.role === "user")!.content![0]!.text).toBe(FRESH_LED_INDICATOR_PROVIDER_CONTRACT);

    let anthropicBody: Record<string, unknown> | undefined;
    const anthropic = new AnthropicHarnessProvider({
      model: "test", apiKey: "test", fetch: async (_input, init) => {
        anthropicBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ content: [{ type: "text", text: "Done." }] }), { status: 200 });
      },
    });
    await expect(anthropic.turn(providerRequest)).resolves.toEqual(completed);
    const anthropicMessages = anthropicBody!.messages as Array<{ role: string; content: string }>;
    expect(anthropicMessages.find((message) => message.role === "user")!.content).toBe(FRESH_LED_INDICATOR_PROVIDER_CONTRACT);
  });

  it("forwards every contract byte through the Codex and Claude CLI adapters", async () => {
    let codexStdin = "";
    const codexSpawn: CliSpawner = (_command, args) => {
      const child = new FakeProcess();
      child.stdin.on("data", (chunk) => { codexStdin += String(chunk); });
      child.stdin.on("finish", () => {
        const outputPath = args[args.indexOf("--output-last-message") + 1]!;
        void writeFile(outputPath, JSON.stringify({
          schemaVersion: CODEX_CLI_TURN_ENVELOPE_SCHEMA_VERSION,
          messageContent: completed.message.content,
          hasToolCalls: false,
          toolCalls: [],
          stopReason: completed.stopReason,
        })).then(() => child.emit("close", 0, null));
      });
      return child;
    };
    await expect(new CodexCliHarnessProvider({ model: "test", executablePath: process.execPath, spawn: codexSpawn, environment: {} }).turn(providerRequest)).resolves.toEqual(completed);
    expect(cliTranscript(codexStdin).messages.find((message) => message.role === "user")!.content).toBe(FRESH_LED_INDICATOR_PROVIDER_CONTRACT);

    let claudeStdin = "";
    const claudeSpawn: CliSpawner = () => {
      const child = new FakeProcess();
      child.stdin.on("data", (chunk) => { claudeStdin += String(chunk); });
      child.stdin.on("finish", () => {
        child.stdout.end(JSON.stringify({ type: "result", is_error: false, structured_output: completed }));
        child.emit("close", 0, null);
      });
      return child;
    };
    await expect(new ClaudeCliHarnessProvider({ model: "test", executablePath: process.execPath, spawn: claudeSpawn, environment: {} }).turn(providerRequest)).resolves.toEqual(completed);
    expect(cliTranscript(claudeStdin).messages.find((message) => message.role === "user")!.content).toBe(FRESH_LED_INDICATOR_PROVIDER_CONTRACT);
  });

  it("wires the closed contract into a real fresh CLI composition before provider output", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "evleda-fresh-contract-"));
    owned.add(output);
    await rm(output, { recursive: true, force: true });
    let body: Record<string, unknown> | undefined;
    const execution = await runPcbAgentCli({
      workflowKind: "led_compatibility_fixture",
      prompt: "Implement LED_INDICATOR_EXAMPLE only.", provider: "openai", model: "test",
      newProjectName: "contract-proof", outputDir: output, iterations: 1, openAiServiceTier: "fast", mode: "run",
    }, {
      environment: { OPENAI_API_KEY: "test" },
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ id: "resp-provider-refusal", status: "completed", error: null, incomplete_details: null, output: [{ id: "msg-provider-refusal", type: "message", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "fixture stop" }] }] }), { status: 200 });
      },
      sessionFactory: async (sessionOptions) => ({
        assertActivePcb: async (expected) => {
          expect(expected).toBe(path.join(sessionOptions.projectRoot, "contract-proof.kicad_pcb"));
        },
        readActivePcbSource: async (expected) => await readFile(expected, "utf8"),
        listTools: () => KICAD_FRESH_SIDECAR_REQUIRED_TOOL_NAMES
          .filter((name) => name !== "evleda_get_live_pcb_document")
          .map((name) => ({ name, permission: "write" as const, description: name, inputSchema: { type: "object" } })),
        callTool: async (name) => ({ content: [], structuredContent: name === "sch_get_connectivity_graph" ? { result: "" } : { ok: true } }),
      }),
    });
    expect(execution.report.status, execution.report.summary).toBe("blocked");
    expect(body).toBeDefined();
    const input = body!.input as Array<{ role?: string; content?: Array<{ text?: string }> }>;
    const freshPrompt = input.find((message) => message.role === "user")!.content![0]!.text!;
    expect(freshPrompt).toContain(FRESH_LED_INDICATOR_PROVIDER_CONTRACT);
    expect(freshPrompt).toContain(FRESH_LED_DEEP_RULE_POLICY.providerPrompt);
    expect(freshPrompt).not.toContain(output);
    for (const id of FRESH_LED_DEEP_RULE_POLICY.reportMetadata.selectedRuleIds) expect(freshPrompt).toContain(`[${id}|`);
    expect(execution.report.harness!.prompt).toContain(FRESH_LED_INDICATOR_PROVIDER_CONTRACT);
    expect(execution.report.ruleProfile).toEqual({
      harnessRuleIdentity: PCB_AGENT_HARNESS_RULE_IDENTITY,
      deepRules: FRESH_LED_DEEP_RULE_POLICY.reportMetadata,
    });
    expect(JSON.stringify(execution.report.ruleProfile.deepRules)).not.toMatch(/[A-Za-z]:[\\/]|\\\\|file:\/\/|\/(?:home|Users|tmp|var|mnt)\//u);
    await expect(readFile(execution.reportPath, "utf8")).resolves.toContain("FRESH_LED_INDICATOR_TASK_CONTRACT");
  });
});
