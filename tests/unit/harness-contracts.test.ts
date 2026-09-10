import { describe, expect, it } from "vitest";
import {
  HARNESS_DEFAULT_LIMITS,
  harnessFinalResultSchema,
  parseHarnessFinalResult,
  parseHarnessOptions,
  parseHarnessProviderRequest,
  parseHarnessProviderTurn
} from "../../src/harness/contracts.js";

const options = () =>
  parseHarnessOptions({
    userPrompt: "Add a mounting hole.",
    fixedRules: ["Use only supplied KiCad operations."],
    projectPath: "C:/work/board.kicad_pro",
    reportPath: "C:/work/report.json",
    editsRequired: true,
    allowedToolNames: [
      {
        name: "kicad.add_mounting_hole",
        description: "Adds a mounting hole to the board.",
        inputSchema: { type: "object" }
      }
    ]
  });

const toolTurn = (overrides: Record<string, unknown> = {}) => ({
  message: { role: "assistant", content: "Adding the hole now." },
  stopReason: "tool_calls",
  toolCalls: [
    { id: "call-1", name: "kicad.add_mounting_hole", arguments: { diameterMm: 3.2 } }
  ],
  ...overrides
});

describe("harness contracts", () => {
  it("accepts a bounded allowlisted KiCad tool turn", () => {
    const turn = parseHarnessProviderTurn(toolTurn(), options());
    expect(turn.toolCalls[0]?.name).toBe("kicad.add_mounting_hole");
  });

  it("rejects unknown contract fields and duplicate tool definitions", () => {
    expect(() => parseHarnessOptions({ ...options(), unexpected: true })).toThrow();
    expect(() =>
      parseHarnessOptions({
        ...options(),
        allowedToolNames: [...options().allowedToolNames, options().allowedToolNames[0]]
      })
    ).toThrow(/Duplicate tool definition/u);
  });

  it("rejects unsupported and duplicate provider tool calls", () => {
    expect(() =>
      parseHarnessProviderTurn(toolTurn({ toolCalls: [{ id: "call-1", name: "shell.exec", arguments: {} }] }), options())
    ).toThrow(/Unsupported tool/u);
    expect(() =>
      parseHarnessProviderTurn(
        toolTurn({
          toolCalls: [
            { id: "call-1", name: "kicad.add_mounting_hole", arguments: {} },
            { id: "call-1", name: "kicad.add_mounting_hole", arguments: {} }
          ]
        }),
        options()
      )
    ).toThrow(/Duplicate tool-call ID/u);
  });

  it("rejects prose-only completion when an edit is required", () => {
    expect(() =>
      parseHarnessProviderTurn(
        { message: { role: "assistant", content: "Done." }, stopReason: "completed", toolCalls: [] },
        options()
      )
    ).toThrow(/Prose-only completion/u);
  });

  it("caps messages, calls, payloads, and final iteration records", () => {
    const base = options();
    expect(() =>
      parseHarnessProviderRequest(
        { messages: Array.from({ length: 3 }, (_, index) => ({ role: index ? "assistant" : "system", content: "x" })), tools: base.allowedToolNames },
        { maxMessages: 2, maxPayloadBytes: HARNESS_DEFAULT_LIMITS.maxPayloadBytes }
      )
    ).toThrow(/more than 2 messages/u);
    expect(() =>
      parseHarnessProviderTurn(toolTurn(), { ...base, maxToolCallsPerTurn: 0 })
    ).toThrow(/more than 0 tool calls/u);
    expect(() =>
      parseHarnessProviderTurn(toolTurn({ message: { role: "assistant", content: "x".repeat(100) } }), {
        ...base,
        maxPayloadBytes: 10
      })
    ).toThrow(/Payload exceeds/u);
    const overLimit = {
        status: "completed",
        projectPath: "C:/work/board.kicad_pro",
        reportPath: "C:/work/report.json",
        summary: "Saved.",
        iterations: Array.from({ length: HARNESS_DEFAULT_LIMITS.maxIterations + 1 }, () => ({
          iteration: 1,
          providerTurn: toolTurn(),
          toolResults: [],
          validation: { passed: true, summary: "Clean." }
        }))
      };
    expect(harnessFinalResultSchema.safeParse(overLimit).success).toBe(true);
    expect(() => parseHarnessFinalResult(overLimit, { maxIterations: 1, maxPayloadBytes: 1_000_000 })).toThrow();
  });
});
