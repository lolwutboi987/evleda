import { describe, expect, it } from "vitest";
import {
  AnthropicHarnessProvider,
  HarnessProviderError,
  MAXIMUM_OPENAI_CONVERSATION_STATE_ENTRIES,
  OpenAIHarnessProvider,
  isOpenAIStrictFunctionSchema,
  type ProviderFetch
} from "../../src/harness/providers.js";
import { PCB_DESIGN_INTENT_TOOL } from "../../src/harness/pcb-design-interpreter.js";
import { FRESH_INCREMENTAL_INPUT_SCHEMAS } from "../../src/harness/fresh-project.js";
import { parseHarnessProviderRequest, type HarnessProviderMessage, type HarnessToolPort } from "../../src/harness/contracts.js";
import { DEFAULT_PCB_HARNESS_VALIDATION_TOOLS, runPcbAgentHarness } from "../../src/harness/pcb-agent-harness.js";

const request = {
  messages: [
    { role: "system" as const, content: "Use tools." },
    { role: "user" as const, content: "Add a mounting hole." },
    { role: "tool" as const, toolCallId: "call-old", content: "previous result" }
  ],
  tools: [{ name: "kicad.add_mounting_hole", description: "Add a hole.", inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false } }]
};

const completedOpenAiResponse = (fields: Record<string, unknown>): Record<string, unknown> => ({
  id: "resp-test",
  status: "completed",
  error: null,
  incomplete_details: null,
  ...fields,
  ...(Array.isArray(fields.output) ? {
    output: fields.output.map((item: unknown, index: number) => {
      if (item === null || typeof item !== "object") return item;
      const record = item as Record<string, unknown>;
      if (record.type === "function_call") return {
        id: record.id ?? `fc-test-${index}`,
        ...record,
        status: record.status ?? "completed",
      };
      if (record.type === "message") return {
        id: record.id ?? `msg-test-${index}`,
        ...record,
        role: record.role ?? "assistant",
        status: record.status ?? "completed",
        content: Array.isArray(record.content) ? record.content.map((part) => {
          if (part !== null && typeof part === "object" && (part as Record<string, unknown>).type === "output_text") {
            return { annotations: [], ...(part as Record<string, unknown>) };
          }
          return part;
        }) : record.content,
      };
      return item;
    }),
  } : {}),
});

const expectedRefusalTurn = (content: string) => ({
  message: { role: "assistant" as const, content },
  toolCalls: [],
  stopReason: "blocked" as const,
});

const fetchFor = (body: unknown, status = 200): { fetch: ProviderFetch; calls: { url: string; init: RequestInit }[] } => {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    fetch: async (input, init = {}) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }
  };
};

const refusalCases = [
  {
    name: "OpenAI top-level",
    bodyFor: (reason: string) => completedOpenAiResponse({ refusal: reason }),
    providerFor: (fetch: ProviderFetch, maxOutputBytes: number) => new OpenAIHarnessProvider({ model: "gpt-test", apiKey: "x", fetch, maxOutputBytes }),
  },
  {
    name: "OpenAI nested",
    bodyFor: (reason: string) => completedOpenAiResponse({ output: [{ type: "message", content: [{ type: "refusal", refusal: reason }] }] }),
    providerFor: (fetch: ProviderFetch, maxOutputBytes: number) => new OpenAIHarnessProvider({ model: "gpt-test", apiKey: "x", fetch, maxOutputBytes }),
  },
  {
    name: "Anthropic top-level",
    bodyFor: (reason: string) => ({ stop_reason: "refusal", refusal: reason }),
    providerFor: (fetch: ProviderFetch, maxOutputBytes: number) => new AnthropicHarnessProvider({ model: "claude-test", apiKey: "x", fetch, maxOutputBytes }),
  },
  {
    name: "Anthropic nested",
    bodyFor: (reason: string) => ({ content: [{ type: "refusal", text: reason }] }),
    providerFor: (fetch: ProviderFetch, maxOutputBytes: number) => new AnthropicHarnessProvider({ model: "claude-test", apiKey: "x", fetch, maxOutputBytes }),
  },
] as const;

describe("live harness providers", () => {
  it("uses provider-specific environment keys when an explicit key is not supplied", async () => {
    const openAiPrevious = process.env.OPENAI_API_KEY;
    const anthropicPrevious = process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = "env-openai";
    process.env.ANTHROPIC_API_KEY = "env-anthropic";
    try {
      const openAi = fetchFor(completedOpenAiResponse({ output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }] }));
      const anthropic = fetchFor({ content: [{ type: "text", text: "Done." }] });
      await new OpenAIHarnessProvider({ model: "gpt-test", fetch: openAi.fetch }).turn(request);
      await new AnthropicHarnessProvider({ model: "claude-test", fetch: anthropic.fetch }).turn(request);
      expect(new Headers(openAi.calls[0]!.init.headers).get("authorization")).toBe("Bearer env-openai");
      expect(new Headers(anthropic.calls[0]!.init.headers).get("x-api-key")).toBe("env-anthropic");
    } finally {
      if (openAiPrevious === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = openAiPrevious;
      if (anthropicPrevious === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = anthropicPrevious;
    }
  });

  it("sends an OpenAI Responses request with the selected model, fast tier, and function schema", async () => {
    const fake = fetchFor(completedOpenAiResponse({ output: [{ type: "function_call", call_id: "call-1", name: "kicad.add_mounting_hole", arguments: '{"diameterMm":3.2}' }] }));
    const provider = new OpenAIHarnessProvider({ model: "gpt-test", apiKey: "test-openai", fetch: fake.fetch });
    await expect(provider.turn(request)).resolves.toMatchObject({ stopReason: "tool_calls", toolCalls: [{ id: "call-1", arguments: { diameterMm: 3.2 } }] });
    const call = fake.calls[0]!;
    expect(call.url).toBe("https://api.openai.com/v1/responses");
    expect(new Headers(call.init.headers).get("authorization")).toBe("Bearer test-openai");
    const body = JSON.parse(String(call.init.body));
    expect(body).toMatchObject({
      model: "gpt-test",
      service_tier: "priority",
      store: false,
      max_output_tokens: 4096,
      include: ["reasoning.encrypted_content"],
      tool_choice: "auto",
      parallel_tool_calls: true,
    });
    expect(body.tools).toEqual([{ type: "function", name: "kicad.add_mounting_hole", description: "Add a hole.", parameters: request.tools[0]!.inputSchema, strict: true }]);
    expect(body.input[2]).toEqual({ type: "function_call_output", call_id: "call-old", output: "previous result" });
  });

  it("enables strict mode only for already-compatible extraction/fresh-tool schemas without rewriting optionals", async () => {
    expect(isOpenAIStrictFunctionSchema(PCB_DESIGN_INTENT_TOOL.inputSchema)).toBe(false);
    expect(JSON.stringify(PCB_DESIGN_INTENT_TOOL.inputSchema)).toContain('"oneOf"');
    const inventory = Object.entries(FRESH_INCREMENTAL_INPUT_SCHEMAS).map(([name, schema]) => ({
      name,
      strict: isOpenAIStrictFunctionSchema(schema),
    }));
    expect(inventory).toHaveLength(Object.keys(FRESH_INCREMENTAL_INPUT_SCHEMAS).length);
    expect(inventory.find((entry) => entry.name === "fresh_apply_contract_connectivity")?.strict).toBe(true);
    expect(inventory.find((entry) => entry.name === "sch_add_symbol")?.strict).toBe(false);
    expect(inventory.find((entry) => entry.name === "sch_add_labels")?.strict).toBe(false);
    for (const [name, schema] of Object.entries(FRESH_INCREMENTAL_INPUT_SCHEMAS)) {
      if (isOpenAIStrictFunctionSchema(schema)) {
        expect(JSON.stringify(schema), name).not.toMatch(/"(?:oneOf|allOf|not|if|then|else|patternProperties|unevaluatedProperties|dependentSchemas|dependentRequired)"/u);
      }
    }

    const optionalSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        requiredValue: { type: "string" },
        optionalValue: { anyOf: [{ type: "number" }, { type: "null" }] },
      },
      required: ["requiredValue"],
    };
    expect(isOpenAIStrictFunctionSchema({
      type: "object", properties: {}, required: [], additionalProperties: false, dependentRequired: {},
    })).toBe(false);
    expect(isOpenAIStrictFunctionSchema({
      type: "object", properties: { value: { type: "number", minimum: 0 } }, required: ["value"], additionalProperties: false,
    })).toBe(false);
    const fake = fetchFor(completedOpenAiResponse({ output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }] }));
    await new OpenAIHarnessProvider({ model: "gpt-test", apiKey: "x", fetch: fake.fetch }).turn({
      messages: request.messages,
      tools: [
        request.tools[0]!,
        { name: "optional_tool", description: "Optional field semantics.", inputSchema: optionalSchema },
      ],
    });
    const tools = (JSON.parse(String(fake.calls[0]!.init.body)) as { tools: { name: string; strict: boolean; parameters: unknown }[] }).tools;
    expect(tools.map(({ name, strict }) => ({ name, strict }))).toEqual([
      { name: "kicad.add_mounting_hole", strict: true },
      { name: "optional_tool", strict: false },
    ]);
    expect(tools[1]!.parameters).toEqual(optionalSchema);
  });

  it("accepts the documented completed/null/null OpenAI envelope", async () => {
    const fake = fetchFor(completedOpenAiResponse({ output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }] }));
    const provider = new OpenAIHarnessProvider({ model: "gpt-test", apiKey: "x", fetch: fake.fetch, serviceTier: "standard" });
    await expect(provider.turn(request)).resolves.toEqual({
      message: { role: "assistant", content: "Done.", responseId: "resp-test" },
      toolCalls: [],
      stopReason: "completed",
      responseId: "resp-test",
    });
    expect(JSON.parse(String(fake.calls[0]!.init.body)).service_tier).toBe("default");
  });

  it("sends Anthropic Messages input and translates tool_use blocks", async () => {
    const fake = fetchFor({ content: [{ type: "text", text: "I will do that." }, { type: "tool_use", id: "tool-1", name: "kicad.add_mounting_hole", input: { diameterMm: 3.2 } }], stop_reason: "tool_use" });
    const provider = new AnthropicHarnessProvider({ model: "claude-test", apiKey: "test-anthropic", fetch: fake.fetch });
    await expect(provider.turn(request)).resolves.toMatchObject({ stopReason: "tool_calls", toolCalls: [{ id: "tool-1", name: "kicad.add_mounting_hole" }] });
    const call = fake.calls[0]!;
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = new Headers(call.init.headers);
    expect(headers.get("x-api-key")).toBe("test-anthropic");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    const body = JSON.parse(String(call.init.body));
    expect(body).toMatchObject({ model: "claude-test", max_tokens: 4096, system: "Use tools." });
    expect(body.tools[0]).toEqual({ name: "kicad.add_mounting_hole", description: "Add a hole.", input_schema: request.tools[0]!.inputSchema });
    expect(body.messages[1]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "call-old", content: "previous result" }] });
  });

  it("fails closed for non-2xx, malformed, unknown, and duplicate calls", async () => {
    const secret = "sk-reflected-by-gateway";
    const http = fetchFor({ error: { message: `do not expose ${secret}` } }, 401);
    const httpError = await new OpenAIHarnessProvider({ model: "gpt-test", apiKey: "x", fetch: http.fetch }).turn(request).catch((error: unknown) => error);
    expect(httpError).toMatchObject({ code: "HTTP", status: 401 });
    expect(String(httpError)).not.toContain(secret);
    const malformed = fetchFor(completedOpenAiResponse({ output: "not-an-array" }));
    await expect(new OpenAIHarnessProvider({ model: "gpt-test", apiKey: "x", fetch: malformed.fetch }).turn(request)).rejects.toBeInstanceOf(HarnessProviderError);
    const unknown = fetchFor(completedOpenAiResponse({ output: [{ type: "function_call", call_id: "call-1", name: "shell.exec", arguments: "{}" }] }));
    await expect(new OpenAIHarnessProvider({ model: "gpt-test", apiKey: "x", fetch: unknown.fetch }).turn(request)).rejects.toThrow(/unsupported tool/u);
    const duplicate = fetchFor({ content: [{ type: "tool_use", id: "same", name: "kicad.add_mounting_hole", input: {} }, { type: "tool_use", id: "same", name: "kicad.add_mounting_hole", input: {} }] });
    await expect(new AnthropicHarnessProvider({ model: "claude-test", apiKey: "x", fetch: duplicate.fetch }).turn(request)).rejects.toThrow(/duplicate/i);
  });

  it("preserves native tool-call history across a second request", async () => {
    const history = {
      messages: [
        { role: "system" as const, content: "Use tools." },
        { role: "user" as const, content: "Route it." },
        { role: "assistant" as const, content: "Calling the router.", toolCalls: [{ id: "call-1", name: "kicad.add_mounting_hole", arguments: { diameterMm: 3.2 } }] },
        { role: "tool" as const, toolCallId: "call-1", content: "placed" },
      ],
      tools: request.tools,
    };
    const openAi = fetchFor(completedOpenAiResponse({ output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }] }));
    await new OpenAIHarnessProvider({ model: "gpt-test", apiKey: "x", fetch: openAi.fetch }).turn(history);
    const openAiInput = JSON.parse(String(openAi.calls[0]!.init.body)).input;
    expect(JSON.parse(String(openAi.calls[0]!.init.body))).not.toHaveProperty("previous_response_id");
    expect(openAiInput).toContainEqual({ type: "function_call", call_id: "call-1", name: "kicad.add_mounting_hole", arguments: "{\"diameterMm\":3.2}" });
    expect(openAiInput).toContainEqual({ type: "function_call_output", call_id: "call-1", output: "placed" });

    const anthropic = fetchFor({ content: [{ type: "text", text: "Done." }] });
    await new AnthropicHarnessProvider({ model: "claude-test", apiKey: "x", fetch: anthropic.fetch }).turn(history);
    const messages = JSON.parse(String(anthropic.calls[0]!.init.body)).messages;
    expect(messages[1]).toMatchObject({ role: "assistant", content: [{ type: "text", text: "Calling the router." }, { type: "tool_use", id: "call-1", name: "kicad.add_mounting_hole", input: { diameterMm: 3.2 } }] });
    expect(messages[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "placed" }] });
  });

  it("rejects incomplete turns and object reasons before exposing their tool calls", async () => {
    const incomplete = fetchFor({ status: "incomplete", error: null, incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "function_call", call_id: "x", name: "kicad.add_mounting_hole", arguments: "{}" }] });
    await expect(new OpenAIHarnessProvider({ model: "gpt-test", apiKey: "x", fetch: incomplete.fetch }).turn(request)).rejects.toMatchObject({ code: "INCOMPLETE" });
    const secret = "secret-in-incomplete-reason";
    const contradictory = fetchFor({ status: "completed", error: null, incomplete_details: { reason: `content_filter:${secret}` }, output: [{ type: "function_call", call_id: "x", name: "kicad.add_mounting_hole", arguments: "{}" }] });
    const contradictoryError = await new OpenAIHarnessProvider({ model: "gpt-test", apiKey: "x", fetch: contradictory.fetch }).turn(request).catch((error: unknown) => error);
    expect(contradictoryError).toMatchObject({ code: "INCOMPLETE" });
    expect(String(contradictoryError)).not.toContain(secret);
    const maxTokens = fetchFor({ stop_reason: "max_tokens", content: [{ type: "tool_use", id: "x", name: "kicad.add_mounting_hole", input: {} }] });
    await expect(new AnthropicHarnessProvider({ model: "claude-test", apiKey: "x", fetch: maxTokens.fetch }).turn(request)).rejects.toMatchObject({ code: "INCOMPLETE" });
  });

  it.each(["failed", "cancelled", "queued", "in_progress"])(
    "rejects OpenAI %s responses without exposing error details or staged tool calls",
    async (status) => {
      const secret = `secret-from-${status}-body`;
      const fake = fetchFor({
        status,
        error: status === "failed" ? { code: "server_error", message: secret } : null,
        incomplete_details: null,
        output: [{ type: "function_call", call_id: "x", name: "kicad.add_mounting_hole", arguments: "{}" }],
      });
      const error = await new OpenAIHarnessProvider({ model: "gpt-test", apiKey: "x", fetch: fake.fetch }).turn(request).catch((reason: unknown) => reason);
      expect(error).toMatchObject({ code: "INCOMPLETE" });
      expect(String(error)).not.toContain(secret);
    }
  );

  it.each([
    ["status", { error: null, incomplete_details: null }],
    ["error", { status: "completed", incomplete_details: null }],
    ["incomplete_details", { status: "completed", error: null }],
  ])("rejects a completed-looking OpenAI response with omitted %s", async (_field, envelope) => {
    const fake = fetchFor({ ...envelope, output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }] });
    await expect(new OpenAIHarnessProvider({ model: "gpt-test", apiKey: "x", fetch: fake.fetch }).turn(request)).rejects.toMatchObject({ code: "MALFORMED" });
  });

  it.each([
    ["status", { status: 200, error: null, incomplete_details: null }],
    ["unsupported status", { status: "refused", error: null, incomplete_details: null }],
    ["error", { status: "completed", error: "none", incomplete_details: null }],
    ["incomplete_details", { status: "completed", error: null, incomplete_details: "none" }],
    ["incomplete_details array", { status: "completed", error: null, incomplete_details: [] }],
  ])("rejects an OpenAI response with malformed or unsupported %s", async (_field, envelope) => {
    const fake = fetchFor({ ...envelope, output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }] });
    await expect(new OpenAIHarnessProvider({ model: "gpt-test", apiKey: "x", fetch: fake.fetch }).turn(request)).rejects.toMatchObject({ code: "MALFORMED" });
  });

  it("does not expose a completed response error body", async () => {
    const secret = "sk-completed-error-body";
    const fake = fetchFor({
      status: "completed",
      error: { code: "server_error", message: secret },
      incomplete_details: null,
      output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }],
    });
    const error = await new OpenAIHarnessProvider({ model: "gpt-test", apiKey: "x", fetch: fake.fetch }).turn(request).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "MALFORMED" });
    expect(String(error)).not.toContain(secret);
  });

  it("keeps store:false multi-turn requests stateless and replays the complete normalized transcript", async () => {
    const bodies: unknown[] = [];
    const responses = [
      completedOpenAiResponse({ id: "resp-1", output: [
        { id: "rs-1", type: "reasoning", summary: [], encrypted_content: "opaque-reasoning-1", status: "completed" },
        { id: "msg-1", type: "message", role: "assistant", status: "completed", phase: "commentary", content: [{ type: "output_text", text: "Calling the router." }] },
        { id: "fc-1", type: "function_call", status: "completed", call_id: "call-1", name: "kicad.add_mounting_hole", arguments: "{}" },
      ] }),
      completedOpenAiResponse({ id: "resp-2", output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }] }),
    ];
    const fetch: ProviderFetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(responses.shift()), { status: 200 });
    };
    const provider = new OpenAIHarnessProvider({ model: "gpt-test", apiKey: "x", fetch });
    const first = await provider.turn({ messages: request.messages.slice(0, 2), tools: request.tools });
    await provider.turn({
      messages: [...request.messages.slice(0, 2), { ...first.message, toolCalls: first.toolCalls }, { role: "tool", toolCallId: "call-1", content: "placed" }],
      tools: request.tools,
      previousResponseId: first.responseId,
    });
    expect(first.responseId).toBe("resp-1");
    expect(JSON.stringify(first)).not.toContain("opaque-reasoning-1");
    expect(bodies[1]).not.toHaveProperty("previous_response_id");
    expect((bodies[1] as { input: unknown[] }).input).toEqual([
      { role: "system", content: [{ type: "input_text", text: "Use tools." }] },
      { role: "user", content: [{ type: "input_text", text: "Add a mounting hole." }] },
      { id: "rs-1", summary: [], type: "reasoning", encrypted_content: "opaque-reasoning-1", status: "completed" },
      { id: "msg-1", content: [{ annotations: [], text: "Calling the router.", type: "output_text" }], role: "assistant", status: "completed", type: "message", phase: "commentary" },
      {
      id: "fc-1",
      type: "function_call",
      status: "completed",
      call_id: "call-1",
      name: "kicad.add_mounting_hole",
      arguments: "{}",
      },
      { type: "function_call_output", call_id: "call-1", output: "placed" },
    ]);
  });

  it("fails closed when store:false continuation state is missing after restart or mismatches the normalized transcript", async () => {
    const responses = [
      completedOpenAiResponse({ id: "resp-state", output: [{ type: "function_call", status: "completed", call_id: "call-1", name: "kicad.add_mounting_hole", arguments: "{}" }] }),
    ];
    let calls = 0;
    const fetch: ProviderFetch = async () => {
      calls += 1;
      return new Response(JSON.stringify(responses.shift()), { status: 200 });
    };
    const provider = new OpenAIHarnessProvider({ model: "gpt-test", apiKey: "x", fetch });
    const initial = { messages: request.messages.slice(0, 2), tools: request.tools };
    const first = await provider.turn(initial);
    const continuation = {
      messages: [...initial.messages, { ...first.message, toolCalls: first.toolCalls }, { role: "tool" as const, toolCallId: "call-1", content: "placed" }],
      tools: request.tools,
      previousResponseId: first.responseId,
    };
    const restarted = new OpenAIHarnessProvider({ model: "gpt-test", apiKey: "x", fetch });
    await expect(restarted.turn(continuation)).rejects.toMatchObject({ code: "MALFORMED" });
    expect(calls).toBe(1);

    const mismatched = structuredClone(continuation);
    mismatched.messages[2]!.content = "changed normalized assistant text";
    await expect(provider.turn(mismatched)).rejects.toMatchObject({ code: "MALFORMED" });
    expect(calls).toBe(1);
  });

  it("accepts schema-reordered assistant and nested argument keys without rewriting native replay items", async () => {
    const argumentsText = '{"reference":"U1","coordinates":{"x":4,"y":5},"ordered":[1,2]}';
    const nativeItems = [
      { id: "rs-schema", summary: [], type: "reasoning", encrypted_content: "opaque-schema", status: "completed" },
      { id: "msg-schema", content: [{ annotations: [], text: "Place U1.", type: "output_text" }], role: "assistant", status: "completed", type: "message", phase: "commentary" },
      { id: "fc-schema", arguments: argumentsText, call_id: "call-schema", name: "kicad.add_mounting_hole", status: "completed", type: "function_call" },
    ];
    const bodies: Array<Record<string, unknown>> = [];
    const fetch: ProviderFetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify(completedOpenAiResponse(bodies.length === 1
        ? { id: "resp-schema", output: nativeItems }
        : { id: "resp-schema-next", output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }] })), { status: 200 });
    };
    const provider = new OpenAIHarnessProvider({ model: "gpt-test", apiKey: "x", fetch });
    const initial = { messages: request.messages.slice(0, 2), tools: request.tools };
    const first = await provider.turn(initial);
    const message = { ...first.message, toolCalls: first.toolCalls };
    expect(Object.keys(message)).toEqual(["role", "content", "responseId", "toolCalls"]);
    const parsed = parseHarnessProviderRequest({
      ...initial,
      messages: [...initial.messages, {
        ...message,
        // Explicit undefined is valid for these optional message fields.
        toolCallId: undefined,
        toolCalls: [{ arguments: { ordered: [1, 2], coordinates: { y: 5, x: 4 }, reference: "U1" }, name: first.toolCalls[0]!.name, id: first.toolCalls[0]!.id }],
      }, { role: "tool", toolCallId: "call-schema", content: "placed" }],
      previousResponseId: first.responseId,
    }, { maxMessages: 64, maxPayloadBytes: 256 * 1024 });
    expect(Object.keys(parsed.messages[2]!)).toEqual(["role", "content", "toolCallId", "toolCalls", "responseId"]);
    expect(JSON.stringify(parsed.messages[2])).not.toBe(JSON.stringify(message));
    await expect(provider.turn(parsed)).resolves.toMatchObject({ responseId: "resp-schema-next" });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).not.toHaveProperty("previous_response_id");
    expect(bodies[1]!.store).toBe(false);
    expect((bodies[1]!.input as unknown[]).slice(2, 5)).toStrictEqual(nativeItems);
    expect((bodies[1]!.input as unknown[]).at(-1)).toEqual({ type: "function_call_output", call_id: "call-schema", output: "placed" });
    expect(JSON.stringify(first)).not.toContain("opaque-schema");
  });

  it("accepts explicit undefined optional fields on schema-parsed no-tool continuation messages", async () => {
    let calls = 0;
    const provider = new OpenAIHarnessProvider({ model: "gpt-test", apiKey: "x", fetch: async () => new Response(JSON.stringify(completedOpenAiResponse({
      id: `resp-optional-${++calls}`, output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }],
    })), { status: 200 }) });
    const initial = { messages: request.messages.slice(0, 2), tools: request.tools };
    const first = await provider.turn(initial);
    const parsed = parseHarnessProviderRequest({ ...initial, previousResponseId: first.responseId,
      messages: [...initial.messages, { ...first.message, toolCalls: undefined, toolCallId: undefined }],
    }, { maxMessages: 64, maxPayloadBytes: 256 * 1024 });
    await expect(provider.turn(parsed)).resolves.toMatchObject({ responseId: "resp-optional-2" });
    expect(calls).toBe(2);
  });

  it.each([
    ["assistant text", (message: HarnessProviderMessage) => { message.content += " changed"; }],
    ["response ID", (message: HarnessProviderMessage) => { message.responseId = "resp-substituted"; }],
    ["tool-call ID", (message: HarnessProviderMessage) => { message.toolCalls![0]!.id = "call-substituted"; }],
    ["tool name", (message: HarnessProviderMessage) => { message.toolCalls![0]!.name = "kicad.other_tool"; }],
    ["argument value", (message: HarnessProviderMessage) => { message.toolCalls![0]!.arguments.value = 99; }],
    ["argument type", (message: HarnessProviderMessage) => { message.toolCalls![0]!.arguments.value = "4"; }],
    ["argument array order", (message: HarnessProviderMessage) => { message.toolCalls![0]!.arguments.ordered = [2, 1]; }],
    ["tool-call array order", (message: HarnessProviderMessage) => { message.toolCalls!.reverse(); }],
    ["removed argument", (message: HarnessProviderMessage) => { delete message.toolCalls![0]!.arguments.value; }],
    ["extra argument", (message: HarnessProviderMessage) => { message.toolCalls![0]!.arguments.extra = null; }],
  ] as const)("still rejects changed %s before fetch after schema normalization", async (_label, mutate) => {
    let calls = 0;
    const provider = new OpenAIHarnessProvider({ model: "gpt-test", apiKey: "x", fetch: async () => {
      calls += 1;
      return new Response(JSON.stringify(completedOpenAiResponse({ id: `resp-equality-${calls}`, output: calls === 1
        ? [1, 2].map(index => ({ type: "function_call", call_id: `call-equality-${index}`, name: "kicad.add_mounting_hole", arguments: '{"value":4,"ordered":[1,2]}' }))
        : [{ type: "message", content: [{ type: "output_text", text: "Done." }] }],
      })), { status: 200 });
    } });
    const initial = { messages: request.messages.slice(0, 2), tools: request.tools };
    const first = await provider.turn(initial);
    const parsed = parseHarnessProviderRequest({ ...initial, previousResponseId: first.responseId,
      messages: [...initial.messages, { ...first.message, toolCalls: first.toolCalls }, ...first.toolCalls.map(call => ({ role: "tool", toolCallId: call.id, content: "placed" }))],
    }, { maxMessages: 64, maxPayloadBytes: 256 * 1024 });
    const changed = structuredClone(parsed);
    mutate(changed.messages[2]!);
    await expect(provider.turn(changed)).rejects.toMatchObject({ code: "MALFORMED" });
    expect(calls).toBe(1);
    await expect(provider.turn(parsed)).resolves.toMatchObject({ responseId: "resp-equality-2" });
    expect(calls).toBe(2);
  });

  it("executes a second OpenAI turn through the actual harness after required quality-repair feedback", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const provider = new OpenAIHarnessProvider({ model: "gpt-test", apiKey: "x", fetch: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const index = bodies.length;
      return new Response(JSON.stringify(completedOpenAiResponse({ id: `resp-repair-${index}`, output: [
        { id: `fc-repair-${index}`, type: "function_call", call_id: `call-repair-${index}`, name: "kicad.add_mounting_hole", arguments: "{}" },
      ] })), { status: 200 });
    } });
    const calls: string[] = [];
    const port: HarnessToolPort = {
      tools: [...request.tools, ...Object.values(DEFAULT_PCB_HARNESS_VALIDATION_TOOLS).map(name => ({ name, description: `Fake ${name}.`, inputSchema: { type: "object" } }))],
      async execute(call) {
        calls.push(call.name);
        const payloads: Record<string, unknown> = {
          "kicad.add_mounting_hole": { status: "placed" }, pcb_save: { status: "saved" },
          run_erc: { status: "clean", findings: [], metadata: { available: true, violation_count: 0 } },
          run_drc: { status: "clean", findings: [], metadata: { available: true, violations: 0, unconnected_items: 0, courtyard_issues: 0 } },
          pcb_get_board_summary: { status: "clean", findings: [], metadata: { footprints: 4, pads: 8, nets: 3, tracks: 5, shapes: 1 } },
          pcb_visual_qa: { status: "PASS", findings: [], footprint_count: 4, board_bounds: [0, 0, 30, 20] },
        };
        return { toolCallId: call.id, content: JSON.stringify(payloads[call.name]) };
      },
    };
    let gates = 0;
    const report = await runPcbAgentHarness({
      userPrompt: "Place a fixture mounting hole.", fixedRules: ["Use fake tools only."], projectPath: "C:/fixture/board.kicad_pro", reportPath: "C:/fixture/report.json",
      editsRequired: true, allowedToolNames: request.tools, maxIterations: 2,
    }, provider, port, { mutationToolNames: ["kicad.add_mounting_hole"], repairCompletionGateFailures: true,
      completionGate: async () => ({ passed: ++gates === 2, missing: gates === 1 ? ["schematic-render-clearance [fail]: repair the fixture text overlap."] : [] }),
    });
    expect(report.status, report.summary).toBe("completed");
    expect(bodies).toHaveLength(2);
    expect(gates).toBe(2);
    expect(report.validation.runs).toBe(2);
    expect(calls.filter(name => name === "pcb_save")).toHaveLength(2);
    const replay = bodies[1]!.input as Array<Record<string, unknown>>;
    expect(replay.filter(item => item.type === "function_call")).toEqual([
      { id: "fc-repair-1", arguments: "{}", call_id: "call-repair-1", name: "kicad.add_mounting_hole", status: "completed", type: "function_call" },
    ]);
    expect(JSON.stringify(replay.at(-1))).toContain("schematic-render-clearance [fail]");
  });

  it("detaches retained native state from caller mutation", async () => {
    let calls = 0;
    const fetch: ProviderFetch = async () => {
      calls += 1;
      return new Response(JSON.stringify(completedOpenAiResponse({
        id: "resp-detached",
        output: [{ id: "fc-detached", type: "function_call", status: "completed", call_id: "call-detached", name: "kicad.add_mounting_hole", arguments: "{\"diameterMm\":3.2}" }],
      })), { status: 200 });
    };
    const provider = new OpenAIHarnessProvider({ model: "gpt-test", apiKey: "x", fetch });
    const messages = request.messages.slice(0, 2);
    const first = await provider.turn({ messages, tools: request.tools });
    (first.toolCalls[0]!.arguments as { diameterMm: number }).diameterMm = 99;
    await expect(provider.turn({
      messages: [...messages, { ...first.message, toolCalls: first.toolCalls }, { role: "tool", toolCallId: "call-detached", content: "placed" }],
      tools: request.tools,
      previousResponseId: first.responseId,
    })).rejects.toMatchObject({ code: "MALFORMED" });
    expect(calls).toBe(1);
  });

  it("uses bounded LRU state across unrelated first turns and rejects an evicted continuation before fetch", async () => {
    let calls = 0;
    const fetch: ProviderFetch = async () => {
      const index = calls++;
      return new Response(JSON.stringify(completedOpenAiResponse({
        id: `resp-independent-${index}`,
        output: [{ id: `msg-independent-${index}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: `Done ${index}.` }] }],
      })), { status: 200 });
    };
    const provider = new OpenAIHarnessProvider({ model: "gpt-test", apiKey: "x", fetch });
    const initialMessages = request.messages.slice(0, 2);
    const turns: Awaited<ReturnType<OpenAIHarnessProvider["turn"]>>[] = [];
    expect(MAXIMUM_OPENAI_CONVERSATION_STATE_ENTRIES).toBe(64);
    for (let index = 0; index < MAXIMUM_OPENAI_CONVERSATION_STATE_ENTRIES; index += 1) {
      turns.push(await provider.turn({ messages: initialMessages, tools: request.tools }));
    }
    expect(calls).toBe(64);
    const continuation = (turn: (typeof turns)[number]) => ({
      messages: [...initialMessages, turn.message],
      tools: request.tools,
      previousResponseId: turn.responseId,
    });
    // All 64 entries fit. Touching the oldest makes the second entry the eviction victim.
    await expect(provider.turn(continuation(turns[0]!))).resolves.toMatchObject({ responseId: "resp-independent-64" });
    await expect(provider.turn(continuation(turns[1]!))).rejects.toMatchObject({ code: "MALFORMED" });
    await expect(provider.turn({
      messages: [...initialMessages, { ...turns[0]!.message, responseId: "resp-unknown" }],
      tools: request.tools,
      previousResponseId: "resp-unknown",
    })).rejects.toMatchObject({ code: "MALFORMED" });
    expect(calls).toBe(65);
    await expect(provider.turn(continuation(turns[0]!))).resolves.toMatchObject({ responseId: "resp-independent-65" });
    expect(calls).toBe(66);
  });

  it.each([12, 24, 64])("retains and replays a %i-turn harness chain without cross-run state substitution", async (turnCount) => {
    const bodies: Array<Record<string, unknown>> = [];
    let responseIndex = 0;
    const fetch: ProviderFetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const index = responseIndex++;
      return new Response(JSON.stringify(completedOpenAiResponse({
        id: `resp-chain-${index}`,
        output: [
          { id: `rs-chain-${index}`, type: "reasoning", summary: [], encrypted_content: `opaque-chain-${index}`, status: "completed" },
          { id: `fc-chain-${index}`, type: "function_call", status: "completed", call_id: `call-chain-${index}`, name: "kicad.add_mounting_hole", arguments: "{}" },
        ],
      })), { status: 200 });
    };
    const provider = new OpenAIHarnessProvider({ model: "gpt-test", apiKey: "x", fetch });
    const messages: HarnessProviderMessage[] = [...request.messages.slice(0, 2)];
    let previousResponseId: string | undefined;
    for (let index = 0; index < turnCount; index += 1) {
      const parsedRequest = parseHarnessProviderRequest({ messages, tools: request.tools, ...(previousResponseId === undefined ? {} : { previousResponseId }) }, { maxMessages: 256, maxPayloadBytes: 4 * 1024 * 1024 });
      const turn = await provider.turn(parsedRequest);
      expect(JSON.stringify(turn)).not.toContain("opaque-chain-");
      messages.push({ ...turn.message, toolCalls: turn.toolCalls });
      messages.push({ role: "tool", toolCallId: `call-chain-${index}`, content: "placed" });
      previousResponseId = turn.responseId;
    }
    expect(responseIndex).toBe(turnCount);
    const finalInput = bodies.at(-1)!.input as Array<{ type?: string; call_id?: string; encrypted_content?: string }>;
    expect(finalInput.filter((item) => item.type === "function_call").map((item) => item.call_id))
      .toEqual(Array.from({ length: turnCount - 1 }, (_, index) => `call-chain-${index}`));
    expect(finalInput.filter((item) => item.type === "reasoning").map((item) => item.encrypted_content))
      .toEqual(Array.from({ length: turnCount - 1 }, (_, index) => `opaque-chain-${index}`));

    const unrelated = await provider.turn({ messages: request.messages.slice(0, 2), tools: request.tools });
    const substituted = [...messages];
    substituted[substituted.length - 2] = unrelated.message;
    await expect(provider.turn({
      messages: substituted,
      tools: request.tools,
      previousResponseId,
    })).rejects.toMatchObject({ code: "MALFORMED" });
    expect(responseIndex).toBe(turnCount + 1);
  });

  it("evicts opaque replay state at the aggregate byte budget before reaching the entry limit", async () => {
    const maxConversationStateBytes = 1_000;
    let calls = 0;
    const fetch: ProviderFetch = async () => {
      const index = calls++;
      const response = completedOpenAiResponse({
        id: `resp-byte-${index}`,
        output: [{ id: `msg-byte-${index}`, type: "message", content: [{ type: "output_text", text: "x".repeat(600) }] }],
      });
      const outputBytes = Buffer.byteLength(JSON.stringify(response.output), "utf8");
      expect(outputBytes).toBeLessThan(maxConversationStateBytes);
      expect(outputBytes * 2).toBeGreaterThan(maxConversationStateBytes);
      return new Response(JSON.stringify(response), { status: 200 });
    };
    const provider = new OpenAIHarnessProvider({ model: "gpt-test", apiKey: "x", fetch, maxConversationStateBytes });
    const initial = { messages: request.messages.slice(0, 2), tools: request.tools };
    const first = await provider.turn(initial);
    const second = await provider.turn(initial);
    await expect(provider.turn({ ...initial, messages: [...initial.messages, first.message], previousResponseId: first.responseId }))
      .rejects.toMatchObject({ code: "MALFORMED" });
    expect(calls).toBe(2);
    await expect(provider.turn({ ...initial, messages: [...initial.messages, second.message], previousResponseId: second.responseId }))
      .resolves.toMatchObject({ responseId: "resp-byte-2" });
    expect(calls).toBe(3);
  });

  it("bounds private opaque replay state before returning a turn", async () => {
    const fake = fetchFor(completedOpenAiResponse({
      id: "resp-large-state",
      output: [
        { id: "rs-large", type: "reasoning", summary: [], encrypted_content: "x".repeat(256), status: "completed" },
        { type: "function_call", status: "completed", call_id: "call-1", name: "kicad.add_mounting_hole", arguments: "{}" },
      ],
    }));
    await expect(new OpenAIHarnessProvider({
      model: "gpt-test",
      apiKey: "x",
      fetch: fake.fetch,
      maxConversationStateBytes: 128,
    }).turn({ messages: request.messages.slice(0, 2), tools: request.tools })).rejects.toMatchObject({ code: "OUTPUT_LIMIT" });
  });

  it.each(["function_call", "message"] as const)(
    "rejects missing, incomplete, in-progress, and unknown %s item status before exposing output",
    async (type) => {
      const content = type === "function_call"
        ? { id: "fc-status", type, call_id: "x", name: "kicad.add_mounting_hole", arguments: "{}" }
        : { id: "msg-status", type, role: "assistant", content: [{ annotations: [], type: "output_text", text: "must-not-be-exposed" }] };
      for (const status of [undefined, "incomplete", "in_progress", "future_status"] as const) {
        const item = status === undefined ? content : { ...content, status };
        const fake = fetchFor({ id: "resp-item-status", status: "completed", error: null, incomplete_details: null, output: [item] });
        const error = await new OpenAIHarnessProvider({ model: "gpt-test", apiKey: "x", fetch: fake.fetch })
          .turn(request).catch((reason: unknown) => reason);
        expect(error).toMatchObject({
          code: status === "incomplete" || status === "in_progress" ? "INCOMPLETE" : "MALFORMED",
        });
        expect(String(error)).not.toContain("must-not-be-exposed");
      }
    },
  );

  it("rejects elevated roles and unknown native output fields instead of retaining them for replay", async () => {
    const invalidItems = [
      { id: "msg-system", type: "message", role: "system", status: "completed", content: [{ annotations: [], type: "output_text", text: "elevated" }] },
      { id: "msg-extra", type: "message", role: "assistant", status: "completed", content: [{ annotations: [], type: "output_text", text: "extra" }], privileged: true },
      { id: "fc-extra", type: "function_call", status: "completed", call_id: "x", name: "kicad.add_mounting_hole", arguments: "{}", phase: "commentary" },
      { id: "rs-extra", type: "reasoning", status: "completed", summary: [], encrypted_content: "opaque", secret_field: "must-not-replay" },
    ];
    for (const [index, item] of invalidItems.entries()) {
      const fake = fetchFor({ id: `resp-invalid-${index}`, status: "completed", error: null, incomplete_details: null, output: [item] });
      const error = await new OpenAIHarnessProvider({ model: "gpt-test", apiKey: "x", fetch: fake.fetch })
        .turn(request).catch((reason: unknown) => reason);
      expect(error).toMatchObject({ code: "MALFORMED" });
      expect(String(error)).not.toContain("must-not-replay");
    }
  });

  it.each(refusalCases)("normalizes and byte-bounds $name refusals", async ({ bodyFor, providerFor }) => {
    const ordinaryReason = "Cannot help.";
    const ordinary = fetchFor(bodyFor(ordinaryReason));
    await expect(providerFor(ordinary.fetch, 4_096).turn(request)).resolves.toEqual(expectedRefusalTurn(ordinaryReason));

    const oversizedReason = `sensitive-refusal-${"x".repeat(64)}`;
    const oversized = fetchFor(bodyFor(oversizedReason));
    const oversizedError = await providerFor(oversized.fetch, 16).turn(request).catch((error: unknown) => error);
    expect(oversizedError).toMatchObject({ code: "OUTPUT_LIMIT" });
    expect(String(oversizedError)).not.toContain(oversizedReason);

    const multibyteReason = "拒否🔒";
    const normalizedBytes = Buffer.byteLength(JSON.stringify(expectedRefusalTurn(multibyteReason)), "utf8");
    expect(normalizedBytes).toBeGreaterThan(JSON.stringify(expectedRefusalTurn(multibyteReason)).length);
    const exactBoundary = fetchFor(bodyFor(multibyteReason));
    await expect(providerFor(exactBoundary.fetch, normalizedBytes).turn(request)).resolves.toEqual(expectedRefusalTurn(multibyteReason));
    const oneByteOver = fetchFor(bodyFor(multibyteReason));
    const boundaryError = await providerFor(oneByteOver.fetch, normalizedBytes - 1).turn(request).catch((error: unknown) => error);
    expect(boundaryError).toMatchObject({ code: "OUTPUT_LIMIT" });
    expect(String(boundaryError)).not.toContain(multibyteReason);
  });

  it("limits streaming response bodies", async () => {
    const huge: ProviderFetch = async () => new Response("x".repeat(64), { status: 200 });
    await expect(new OpenAIHarnessProvider({ model: "gpt-test", apiKey: "x", fetch: huge, maxResponseBytes: 16 }).turn(request)).rejects.toMatchObject({ code: "OUTPUT_LIMIT" });
    const largeOutput = fetchFor(completedOpenAiResponse({ output: [{ type: "message", content: [{ type: "output_text", text: "x".repeat(64) }] }] }));
    await expect(new OpenAIHarnessProvider({ model: "gpt-test", apiKey: "x", fetch: largeOutput.fetch, maxResponseBytes: 1_024, maxOutputBytes: 16 }).turn(request)).rejects.toMatchObject({ code: "OUTPUT_LIMIT" });
  });

  it("passes cancellation to fetch and preserves the caller abort reason", async () => {
    const controller = new AbortController();
    const aborted = new DOMException("cancelled", "AbortError");
    let received: AbortSignal | null | undefined;
    const fetch: ProviderFetch = async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      received = init?.signal ?? undefined;
      received?.addEventListener("abort", () => reject(received?.reason), { once: true });
      controller.abort(aborted);
    });
    await expect(new OpenAIHarnessProvider({ model: "gpt-test", apiKey: "x", fetch, signal: controller.signal }).turn(request)).rejects.toBe(aborted);
    expect(received).toBeInstanceOf(AbortSignal);
    expect(received?.aborted).toBe(true);
  });

  it("bounds a fetch implementation that ignores AbortSignal", async () => {
    let received: AbortSignal | undefined;
    const fetch: ProviderFetch = async (_input, init) => await new Promise<Response>(() => {
      received = init?.signal ?? undefined;
    });
    await expect(new OpenAIHarnessProvider({
      model: "gpt-test",
      apiKey: "x",
      fetch,
      timeoutMs: 10,
    }).turn(request)).rejects.toMatchObject({ code: "INCOMPLETE" });
    expect(received?.aborted).toBe(true);
  });
});
