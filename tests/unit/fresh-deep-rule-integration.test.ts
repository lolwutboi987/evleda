import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  AnthropicHarnessProvider,
  ClaudeCliHarnessProvider,
  CODEX_CLI_TURN_ENVELOPE_SCHEMA_VERSION,
  CodexCliHarnessProvider,
  FRESH_LED_DEEP_RULE_POLICY,
  FRESH_LED_DEEP_RULE_PROFILE_ID,
  FRESH_LED_DEEP_RULE_SELECTION_PARAMETERS,
  FRESH_LED_DESIGNER_PROMPT_MAX_CHARS,
  FRESH_LED_REVIEWED_DEEP_RULE_IDS,
  LED_INDICATOR_EXAMPLE,
  loadDeepRuleCatalog,
  OpenAIHarnessProvider,
  createFreshLedDeepRulePolicy,
  deriveFreshLedDeepRuleFeatures,
  renderPcbDesignerPrompt,
  type CliProcess,
  type CliSpawner,
  type HarnessProviderRequest,
  type HarnessProviderTurn,
} from "../../src/harness/index.js";
import { computePcbAgentHarnessRuleIdentity } from "../../src/cli/pcb-agent.js";

const completed: HarnessProviderTurn = {
  message: { role: "assistant", content: "Done." },
  toolCalls: [],
  stopReason: "completed",
};

const integratedRulePrompt = renderPcbDesignerPrompt({
  boardPurpose: LED_INDICATOR_EXAMPLE.purpose,
  constraints: ["local proof only"],
  maxChars: FRESH_LED_DESIGNER_PROMPT_MAX_CHARS,
  deepRuleSelection: FRESH_LED_DEEP_RULE_POLICY.selection.deepRuleSelection,
  exactDeepRulePrompt: FRESH_LED_DEEP_RULE_POLICY.providerPrompt,
  deepRuleMaxChars: FRESH_LED_DEEP_RULE_POLICY.selection.budget.maxPromptBytes,
  deepRuleMaxRules: FRESH_LED_DEEP_RULE_POLICY.selection.budget.maxRules,
});

const providerRequest: HarnessProviderRequest = {
  messages: [
    { role: "system", content: "Use supplied tools only." },
    { role: "user", content: integratedRulePrompt },
  ],
  tools: [{ name: "pcb_get_board_summary", description: "Inspect board.", inputSchema: { type: "object" } }],
};

class FakeProcess extends EventEmitter implements CliProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly pid = 4321;
  kill(): boolean { return true; }
}

const framedCliUserPrompt = (stdin: string): string => {
  const marker = "HARNESS_REQUEST_JSON:\n";
  const offset = stdin.indexOf(marker);
  expect(offset).toBeGreaterThanOrEqual(0);
  const framed = JSON.parse(stdin.slice(offset + marker.length)) as { transcript: HarnessProviderRequest["messages"] };
  return framed.transcript.find((message) => message.role === "user")!.content;
};

describe("fresh deep-rule provider integration", () => {
  it("derives a deterministic strict feature request from the validated LED contract", () => {
    expect(deriveFreshLedDeepRuleFeatures(structuredClone(LED_INDICATOR_EXAMPLE))).toEqual({
      powerCurrent: { priority: "high", terms: ["current path", "voltage drop", "trace width", "via current"] },
      placement: { priority: "high", terms: ["connector", "component placement"] },
      thermal: { priority: "normal", terms: ["thermal", "dissipation"] },
    });
    const second = createFreshLedDeepRulePolicy(structuredClone(LED_INDICATOR_EXAMPLE));
    expect(second).toEqual(FRESH_LED_DEEP_RULE_POLICY);
    expect(second.selection.disposition).toBe("ready-for-prompt");
    expect(second.selection.activeFeatures).toEqual(["powerCurrent", "placement", "thermal"]);
    expect(second.selection.coveredFeatures).toEqual(second.selection.activeFeatures);
    expect(second.selection.uncoveredFeatures).toEqual([]);
    expect(second.reportMetadata.parameters.taskProfile.baselineProfile).toBe("zero-via");
    expect(second.reportMetadata.profileId).toBe(FRESH_LED_DEEP_RULE_PROFILE_ID);
    expect(second.reportMetadata.parameters).toEqual(FRESH_LED_DEEP_RULE_SELECTION_PARAMETERS);
    expect(second.features.placement && typeof second.features.placement !== "boolean" ? second.features.placement.terms : [])
      .not.toContain("decoupling");
  });

  it("uses the exact relevance-audited zero-via rule profile under deterministic budgets", () => {
    const ids = FRESH_LED_DEEP_RULE_POLICY.selection.rules.map((rule) => rule.id);
    expect(ids).toEqual(FRESH_LED_REVIEWED_DEEP_RULE_IDS);
    expect(ids).toEqual(expect.arrayContaining(["PCB03-R040", "PCB05-R020", "PCB02-R005", "PCB02-R070", "PCB05-R072", "PCB02-R002", "PCB16-R084", "PCB02-R001"]));
    for (const banned of [
      "PCB02-R021", "PCB02-R025", "PCB02-R033", "PCB16-R022", "PCB16-R027", "PCB16-R043", "PCB03-R033", "PCB05-R066",
    ]) expect(ids).not.toContain(banned);
    expect(FRESH_LED_DEEP_RULE_POLICY.selection.budget).toMatchObject({
      maxRules: 12,
      usedRules: 12,
      maxPromptBytes: 4_608,
      usedPromptBytes: 4_037,
      maxPromptTokens: 4_608,
      usedPromptTokens: 4_037,
      tokenAccounting: "utf8-byte-upper-bound",
    });
    const providerBytes = Buffer.byteLength(FRESH_LED_DEEP_RULE_POLICY.providerPrompt, "utf8");
    expect(providerBytes)
      .toBeLessThanOrEqual(FRESH_LED_DEEP_RULE_POLICY.selection.budget.maxPromptBytes);
    expect(providerBytes).toBeGreaterThan(3 * 1_024);
    expect(providerBytes).toBeLessThan(4 * 1_024);
    expect(providerBytes).toBeLessThan(Math.floor(7_131 * 0.6));
    expect(FRESH_LED_DEEP_RULE_POLICY.reportMetadata.providerPromptBudget).toEqual({
      usedBytes: providerBytes,
      usedTokens: providerBytes,
      tokenAccounting: "utf8-byte-upper-bound",
    });
    for (const rule of FRESH_LED_DEEP_RULE_POLICY.selection.rules) {
      expect(integratedRulePrompt).toContain(`[${rule.id}|`);
      expect(integratedRulePrompt).toContain(`${rule.topic}#${rule.source.headingAnchor}:L${rule.source.dossierLineStart}-L${rule.source.dossierLineEnd}`);
      expect(integratedRulePrompt).toContain(rule.instructionExcerpt.replace(/\s+/gu, " ").trim());
    }
  });

  it("binds catalog, selection, parameters, and provider bytes into stable identities and safe metadata", () => {
    const metadata = FRESH_LED_DEEP_RULE_POLICY.reportMetadata;
    expect(metadata.catalogIdentity).toMatch(/^[a-f0-9]{64}$/u);
    expect(metadata.selectionIdentity).toMatch(/^[a-f0-9]{64}$/u);
    expect(metadata.providerPromptSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(computePcbAgentHarnessRuleIdentity()).toBe(computePcbAgentHarnessRuleIdentity());
    expect(computePcbAgentHarnessRuleIdentity(undefined, { ...metadata, selectionIdentity: "f".repeat(64) }))
      .not.toBe(computePcbAgentHarnessRuleIdentity());
    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toMatch(/[A-Za-z]:[\\/]|\\\\|file:\/\/|\/(?:home|Users|tmp|var|mnt)\//u);
    expect(serialized).not.toMatch(/dossierPath|articleUrl|\.md/iu);
    expect(FRESH_LED_DEEP_RULE_POLICY.providerPrompt).not.toMatch(/[A-Za-z]:[\\/]|\\\\|file:\/\/|\/(?:home|Users|tmp|var|mnt)\//u);
    expect(FRESH_LED_DEEP_RULE_POLICY.providerPrompt).not.toMatch(/docs\/|\.md/iu);
    expect(FRESH_LED_DEEP_RULE_POLICY.selection.rules.every((rule) => rule.category !== "release-gate")).toBe(true);
    const selectedIds = new Set(FRESH_LED_DEEP_RULE_POLICY.selection.rules.map((rule) => rule.id));
    const selectedCatalogRules = loadDeepRuleCatalog().rules.filter((rule) => selectedIds.has(rule.id));
    expect(selectedCatalogRules.every((rule) => !rule.vendorScope.toLocaleLowerCase().startsWith("jlcpcb-specific"))).toBe(true);
    expect(FRESH_LED_DEEP_RULE_POLICY.providerPrompt).not.toMatch(/JLC(?:PCB)?[-_][\p{L}\p{N}._-]*\d/iu);
    expect(FRESH_LED_DEEP_RULE_POLICY.providerPrompt).toMatch(/Do not infer component roles/iu);
  });

  it("fails closed instead of truncating or omitting an exact selection", () => {
    expect(() => renderPcbDesignerPrompt({
      constraints: ["proof"],
      maxChars: FRESH_LED_DEEP_RULE_POLICY.providerPrompt.length,
      deepRuleSelection: FRESH_LED_DEEP_RULE_POLICY.selection.deepRuleSelection,
      exactDeepRulePrompt: FRESH_LED_DEEP_RULE_POLICY.providerPrompt,
      deepRuleMaxChars: FRESH_LED_DEEP_RULE_POLICY.selection.budget.maxPromptBytes,
    })).toThrow(/cannot retain the exact deep-rule selection/iu);
    expect(() => renderPcbDesignerPrompt({
      constraints: ["proof"],
      maxChars: FRESH_LED_DESIGNER_PROMPT_MAX_CHARS,
      deepRuleSelection: FRESH_LED_DEEP_RULE_POLICY.selection.deepRuleSelection,
      exactDeepRulePrompt: FRESH_LED_DEEP_RULE_POLICY.providerPrompt.split("\n").slice(0, -1).join("\n"),
      deepRuleMaxChars: FRESH_LED_DEEP_RULE_POLICY.selection.budget.maxPromptBytes,
    })).toThrow(/IDs do not exactly match/iu);

    const changedViaContract = structuredClone(LED_INDICATOR_EXAMPLE);
    changedViaContract.routing.maximumViaCount = 1;
    expect(() => createFreshLedDeepRulePolicy(changedViaContract)).toThrow(/requires maximumViaCount to remain zero/iu);

    const catalog = loadDeepRuleCatalog();
    expect(() => createFreshLedDeepRulePolicy(LED_INDICATOR_EXAMPLE, {
      ...catalog,
      rules: catalog.rules.filter((rule) => rule.id !== "PCB16-R084"),
    })).toThrow(/preferred rule PCB16-R084 is missing/iu);
  });

  it("forwards the integrated selection byte-for-byte through OpenAI and Anthropic", async () => {
    let openAiBody: Record<string, unknown> | undefined;
    const openAi = new OpenAIHarnessProvider({
      model: "test", apiKey: "test", fetch: async (_input, init) => {
        openAiBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ id: "resp-deep-rule", status: "completed", error: null, incomplete_details: null, output: [{ id: "msg-deep-rule", type: "message", role: "assistant", status: "completed", content: [{ annotations: [], type: "output_text", text: "Done." }] }] }), { status: 200 });
      },
    });
    await expect(openAi.turn(providerRequest)).resolves.toMatchObject(completed);
    const openAiInput = openAiBody!.input as Array<{ role?: string; content?: Array<{ text?: string }> }>;
    expect(openAiInput.find((message) => message.role === "user")!.content![0]!.text).toBe(integratedRulePrompt);

    let anthropicBody: Record<string, unknown> | undefined;
    const anthropic = new AnthropicHarnessProvider({
      model: "test", apiKey: "test", fetch: async (_input, init) => {
        anthropicBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ content: [{ type: "text", text: "Done." }] }), { status: 200 });
      },
    });
    await expect(anthropic.turn(providerRequest)).resolves.toEqual(completed);
    const anthropicMessages = anthropicBody!.messages as Array<{ role: string; content: string }>;
    expect(anthropicMessages.find((message) => message.role === "user")!.content).toBe(integratedRulePrompt);
  });

  it("forwards the integrated selection byte-for-byte through Codex and Claude CLI", async () => {
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
    expect(framedCliUserPrompt(codexStdin)).toBe(integratedRulePrompt);

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
    expect(framedCliUserPrompt(claudeStdin)).toBe(integratedRulePrompt);
  });
});
