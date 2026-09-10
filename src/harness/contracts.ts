import { z } from "zod";

/** Vendor-neutral contracts for a bounded KiCad-editing conversation. */
export const HARNESS_SCHEMA_VERSION = "evleda.harness.v1";

export const HARNESS_FINAL_STATUSES = ["completed", "needs_review", "blocked", "failed"] as const;
export type HarnessFinalStatus = (typeof HARNESS_FINAL_STATUSES)[number];

export const HARNESS_DEFAULT_LIMITS = Object.freeze({
  maxMessages: 64,
  maxToolCallsPerTurn: 16,
  maxPayloadBytes: 256 * 1024,
  maxIterations: 12
});

/**
 * Exact compiler-owned execution prompts may be larger than an ordinary CLI
 * request.  Only user frames receive this wider bound; provider output and
 * tool feedback retain the existing 32,000-character ceiling.
 */
export const HARNESS_EXACT_USER_MESSAGE_MAX_CHARS = 512 * 1024;
const HARNESS_PROVIDER_OUTPUT_MESSAGE_MAX_CHARS = 32_000;

const HARNESS_HARD_LIMITS = Object.freeze({
  maxMessages: 256,
  maxToolCallsPerTurn: 64,
  maxIterations: 64,
  maxPayloadBytes: 4 * 1024 * 1024
});

const nonBlank = z.string().trim().min(1);
const positiveInteger = z.number().int().positive();
const jsonValue = z.json();
const jsonObject = z.record(z.string(), jsonValue);

const byteLength = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

const limited = <Schema extends z.ZodType>(schema: Schema, maxPayloadBytes: number): Schema =>
  schema.superRefine((value, context) => {
    if (byteLength(value) > maxPayloadBytes) {
      context.addIssue({
        code: "custom",
        message: `Payload exceeds the ${maxPayloadBytes}-byte limit`
      });
    }
  }) as Schema;

export const harnessToolDefinitionSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_.-]{0,95}$/u),
    description: nonBlank.max(2_000),
    inputSchema: jsonObject
  })
  .strict();
export type HarnessToolDefinition = z.infer<typeof harnessToolDefinitionSchema>;

export const harnessToolCallSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/u),
    name: z.string().regex(/^[a-z][a-z0-9_.-]{0,95}$/u),
    arguments: jsonObject
  })
  .strict();
export type HarnessToolCall<Operation extends string = string> = Omit<
  z.infer<typeof harnessToolCallSchema>,
  "name"
> & { readonly name: Operation };

export const harnessToolResultSchema = z
  .object({
    toolCallId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/u),
    content: nonBlank.max(32_000),
    isError: z.boolean().optional()
  })
  .strict();
export type HarnessToolResult = z.infer<typeof harnessToolResultSchema>;

export const harnessProviderMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.string().max(HARNESS_EXACT_USER_MESSAGE_MAX_CHARS),
    toolCallId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/u).optional(),
    toolCalls: z.array(harnessToolCallSchema).max(HARNESS_HARD_LIMITS.maxToolCallsPerTurn).optional(),
    responseId: z.string().min(1).max(256).optional()
  })
  .strict()
  .superRefine((message, context) => {
    if (message.role !== "user" && message.content.length > HARNESS_PROVIDER_OUTPUT_MESSAGE_MAX_CHARS) {
      context.addIssue({
        code: "custom",
        path: ["content"],
        message: `Only exact user prompts may exceed ${HARNESS_PROVIDER_OUTPUT_MESSAGE_MAX_CHARS} characters`
      });
    }
    if ((message.role === "tool") !== (message.toolCallId !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Tool messages must have a toolCallId; other messages must not"
      });
    }
    if (message.toolCalls !== undefined && message.role !== "assistant") {
      context.addIssue({ code: "custom", message: "Only assistant messages may carry tool calls" });
    }
    if (message.responseId !== undefined && message.role !== "assistant") {
      context.addIssue({ code: "custom", message: "Only assistant messages may carry a provider response ID" });
    }
  });
export type HarnessProviderMessage = z.infer<typeof harnessProviderMessageSchema>;

export const harnessProviderTurnSchema = z
  .object({
    message: harnessProviderMessageSchema.refine((message) => message.role === "assistant", {
      message: "Provider turns must contain an assistant message"
    }),
    toolCalls: z.array(harnessToolCallSchema).max(HARNESS_HARD_LIMITS.maxToolCallsPerTurn),
    stopReason: z.enum(["tool_calls", "completed", "blocked"]),
    responseId: z.string().min(1).max(256).optional()
  })
  .strict()
  .superRefine((turn, context) => {
    if (turn.stopReason === "tool_calls" && turn.toolCalls.length === 0) {
      context.addIssue({ code: "custom", message: "tool_calls requires at least one tool call" });
    }
    if (turn.stopReason !== "tool_calls" && turn.toolCalls.length !== 0) {
      context.addIssue({ code: "custom", message: "Only tool_calls may include tool calls" });
    }
  });
export type HarnessProviderTurn = z.infer<typeof harnessProviderTurnSchema>;

/**
 * Portable, strict JSON Schema for command-line providers.  Keep this beside
 * the Zod contract: the CLIs accept JSON Schema files/arguments, while every
 * received value is still parsed by `harnessProviderTurnSchema` below.
 */
export const HARNESS_PROVIDER_TURN_JSON_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["message", "toolCalls", "stopReason"],
  properties: {
    message: {
      type: "object",
      additionalProperties: false,
      required: ["role", "content"],
      properties: {
        // Codex's Structured Outputs validator requires `type` alongside a
        // singleton constraint; JSON Schema's bare `const` is rejected there.
        role: { type: "string", enum: ["assistant"] },
        content: { type: "string", maxLength: 32_000 }
      }
    },
    toolCalls: {
      type: "array",
      maxItems: HARNESS_HARD_LIMITS.maxToolCallsPerTurn,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "arguments"],
        properties: {
          id: { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,128}$" },
          name: { type: "string", pattern: "^[a-z][a-z0-9_.-]{0,95}$" },
          // The exported base schema only permits an empty argument object.
          // CLI adapters replace it with a per-tool strict variant below.
          arguments: { type: "object", additionalProperties: false, properties: {}, required: [] }
        }
      }
    },
    stopReason: { type: "string", enum: ["tool_calls", "completed", "blocked"] }
  }
} as const);

type JsonSchemaRecord = Record<string, unknown>;

const STRICT_SCHEMA_MAX_DEPTH = 48;
const STRICT_SCHEMA_MAX_NODES = 4_096;
const STRICT_SCHEMA_MAX_BYTES = HARNESS_DEFAULT_LIMITS.maxPayloadBytes;
const COMBINATORS = ["anyOf", "oneOf", "allOf"] as const;
const ARRAY_SCHEMA_KEYS = new Set([
  "$id", "$schema", "$ref", "$anchor", "$dynamicRef", "$dynamicAnchor", "$defs",
  "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly",
  "type", "const", "enum", "multipleOf", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
  "minItems", "maxItems", "uniqueItems", "contains", "minContains", "maxContains", "items", "prefixItems",
  "anyOf", "oneOf", "allOf", "not", "if", "then", "else",
]);

const record = (value: unknown, label: string): JsonSchemaRecord => {
  if (value === null || Array.isArray(value) || typeof value !== "object") throw new Error(`${label} must be a JSON Schema object`);
  return value as JsonSchemaRecord;
};

interface StrictSchemaState { nodes: number; }

/**
 * Normalizes only JSON Schema structure, never its scalar constraints. Every
 * object branch is closed for Structured Outputs; arrays deliberately carry no
 * object-only keywords. Limits make untrusted advertised tool schemas bounded.
 */
const strictStructuredSchemaNode = (value: unknown, state: StrictSchemaState, depth: number): JsonSchemaRecord => {
  if (depth > STRICT_SCHEMA_MAX_DEPTH) throw new Error(`Tool schema exceeds the ${STRICT_SCHEMA_MAX_DEPTH}-level nesting limit`);
  state.nodes += 1;
  if (state.nodes > STRICT_SCHEMA_MAX_NODES) throw new Error(`Tool schema exceeds the ${STRICT_SCHEMA_MAX_NODES}-node limit`);
  const source = record(value, "Tool schema branch");
  const sourceProperties = source.properties === undefined ? undefined : record(source.properties, "Tool schema properties");
  const isArray = source.type === "array";
  const isObject = !isArray && (source.type === "object" || sourceProperties !== undefined || source.additionalProperties !== undefined);
  const result: JsonSchemaRecord = {};

  for (const [key, child] of Object.entries(source)) {
    if (key === "properties" || key === "required" || key === "additionalProperties" || key === "items" || COMBINATORS.includes(key as typeof COMBINATORS[number])) continue;
    if (!isArray || ARRAY_SCHEMA_KEYS.has(key)) result[key] = structuredClone(child);
  }
  for (const key of COMBINATORS) {
    const branches = source[key];
    if (branches === undefined) continue;
    if (!Array.isArray(branches) || branches.length === 0) throw new Error(`Tool schema ${key} must be a non-empty array`);
    result[key] = branches.map((branch) => strictStructuredSchemaNode(branch, state, depth + 1));
  }
  if (isArray) {
    if (source.items !== undefined) result.items = strictStructuredSchemaNode(source.items, state, depth + 1);
    return result;
  }
  if (isObject) {
    const properties = Object.fromEntries(Object.entries(sourceProperties ?? {}).map(([key, child]) => [key, strictStructuredSchemaNode(child, state, depth + 1)]));
    result.type = "object";
    result.properties = properties;
    result.required = Object.keys(properties);
    result.additionalProperties = false;
  }
  return result;
};

/** Makes a detached, bounded provider-supplied tool input object strict for Structured Outputs. */
const strictStructuredSchema = (value: unknown): JsonSchemaRecord => {
  const schema = strictStructuredSchemaNode(value, { nodes: 0 }, 0);
  const serialized = JSON.stringify(schema);
  if (Buffer.byteLength(serialized, "utf8") > STRICT_SCHEMA_MAX_BYTES) {
    throw new Error(`Tool schema exceeds the ${STRICT_SCHEMA_MAX_BYTES}-byte limit`);
  }
  return JSON.parse(serialized) as JsonSchemaRecord;
};

/**
 * Codex and Claude require every object in a strict response schema to forbid
 * unknown properties.  A generic `arguments: Record<string, unknown>` cannot
 * meet that rule, so specialize the turn schema to the supplied tool list.
 */
export const createHarnessProviderTurnJsonSchema = (tools: readonly HarnessToolDefinition[]): JsonSchemaRecord => ({
  ...HARNESS_PROVIDER_TURN_JSON_SCHEMA,
  properties: {
    ...HARNESS_PROVIDER_TURN_JSON_SCHEMA.properties,
    toolCalls: {
      type: "array",
      maxItems: HARNESS_HARD_LIMITS.maxToolCallsPerTurn,
      items: {
        anyOf: tools.map((tool) => ({
          type: "object",
          additionalProperties: false,
          required: ["id", "name", "arguments"],
          properties: {
            id: { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,128}$" },
            name: { type: "string", enum: [tool.name] },
            arguments: strictStructuredSchema(tool.inputSchema),
          },
        })),
      },
    },
  },
});

export const harnessOptionsSchema = z
  .object({
    userPrompt: nonBlank.max(32_000),
    fixedRules: z.array(nonBlank.max(4_000)).min(1).max(64),
    projectPath: nonBlank.max(4_000),
    reportPath: nonBlank.max(4_000),
    editsRequired: z.boolean(),
    allowedToolNames: z.array(harnessToolDefinitionSchema).min(1).max(64),
    maxMessages: positiveInteger.max(HARNESS_HARD_LIMITS.maxMessages).default(HARNESS_DEFAULT_LIMITS.maxMessages),
    maxToolCallsPerTurn: positiveInteger
      .max(HARNESS_HARD_LIMITS.maxToolCallsPerTurn)
      .default(HARNESS_DEFAULT_LIMITS.maxToolCallsPerTurn),
    maxPayloadBytes: positiveInteger
      .max(HARNESS_HARD_LIMITS.maxPayloadBytes)
      .default(HARNESS_DEFAULT_LIMITS.maxPayloadBytes),
    maxIterations: positiveInteger
      .max(HARNESS_HARD_LIMITS.maxIterations)
      .default(HARNESS_DEFAULT_LIMITS.maxIterations)
  })
  .strict()
  .superRefine((options, context) => {
    const names = new Set<string>();
    for (const tool of options.allowedToolNames) {
      if (names.has(tool.name)) context.addIssue({ code: "custom", message: `Duplicate tool definition: ${tool.name}` });
      names.add(tool.name);
    }
  });
export type HarnessOptions = z.infer<typeof harnessOptionsSchema>;

export const harnessProviderRequestSchema = z
  .object({
    messages: z.array(harnessProviderMessageSchema).min(2).max(HARNESS_HARD_LIMITS.maxMessages),
    tools: z.array(harnessToolDefinitionSchema).min(1).max(64),
    previousResponseId: z.string().min(1).max(256).optional()
  })
  .strict();
export type HarnessProviderRequest = z.infer<typeof harnessProviderRequestSchema>;

export const harnessValidationFeedbackSchema = z
  .object({
    passed: z.boolean(),
    summary: nonBlank.max(16_000),
    issues: z.array(nonBlank.max(4_000)).max(128).default([])
  })
  .strict();
export type HarnessValidationFeedback = z.infer<typeof harnessValidationFeedbackSchema>;

export const harnessIterationRecordSchema = z
  .object({
    iteration: positiveInteger,
    providerTurn: harnessProviderTurnSchema,
    toolResults: z.array(harnessToolResultSchema).max(HARNESS_HARD_LIMITS.maxToolCallsPerTurn),
    validation: harnessValidationFeedbackSchema
  })
  .strict();
export type HarnessIterationRecord = z.infer<typeof harnessIterationRecordSchema>;

export const harnessFinalResultSchema = z
  .object({
    status: z.enum(HARNESS_FINAL_STATUSES),
    projectPath: nonBlank.max(4_000),
    reportPath: nonBlank.max(4_000),
    summary: nonBlank.max(16_000),
    iterations: z.array(harnessIterationRecordSchema).max(HARNESS_HARD_LIMITS.maxIterations)
  })
  .strict();
export type HarnessFinalResult = z.infer<typeof harnessFinalResultSchema>;

/** Per-turn controls used when a narrower caller must force one tool/cancellation boundary. */
export interface HarnessProviderTurnContext {
  readonly signal?: AbortSignal;
  readonly requiredToolName?: string;
  readonly allowParallelToolCalls?: boolean;
}

export interface HarnessProvider {
  readonly provider: "openai" | "anthropic" | (string & {});
  turn(request: HarnessProviderRequest, context?: HarnessProviderTurnContext): Promise<HarnessProviderTurn>;
}

export interface HarnessToolPort<Operation extends string = string> {
  readonly tools: readonly HarnessToolDefinition[];
  execute(call: HarnessToolCall<Operation>): Promise<HarnessToolResult>;
  /** Host-only operations are deliberately not exposed as provider-callable tools. */
  readonly internal?: HarnessInternalToolPort;
}

export interface HarnessInternalToolPort {
  execute(call: HarnessToolCall): Promise<HarnessToolResult>;
  /** Saves a verified mutation, or verifies that the sidecar already persisted it. */
  saveAfterMutation(call: HarnessToolCall): Promise<HarnessToolResult>;
  /**
   * Host-only authoritative-file assessment. It is deliberately unavailable to
   * the provider and can report only a completed no-governed-effect boundary.
   */
  classifyPendingMutationBatch?(): Promise<HarnessMutationBatchDisposition | undefined>;
}

export interface HarnessMutationBatchDisposition {
  readonly schemaVersion: "evleda.mutation-batch-disposition.v1";
  readonly status: "no-governed-effect";
  readonly domain: "schematic-file";
  readonly baselineSha256: string;
  readonly observedSha256: string;
}

export const parseHarnessOptions = (value: unknown): HarnessOptions => harnessOptionsSchema.parse(value);

/** Parses untrusted provider output against the current harness limits and allowlist. */
export const parseHarnessProviderTurn = (
  value: unknown,
  options: Pick<
    HarnessOptions,
    "allowedToolNames" | "maxToolCallsPerTurn" | "maxPayloadBytes" | "editsRequired"
  >
): HarnessProviderTurn => {
  const turn = limited(harnessProviderTurnSchema, options.maxPayloadBytes).parse(value);
  if (turn.toolCalls.length > options.maxToolCallsPerTurn) {
    throw new Error(`Provider returned more than ${options.maxToolCallsPerTurn} tool calls`);
  }
  const allowed = new Set(options.allowedToolNames.map((tool) => tool.name));
  const ids = new Set<string>();
  for (const call of turn.toolCalls) {
    if (!allowed.has(call.name)) throw new Error(`Unsupported tool: ${call.name}`);
    if (ids.has(call.id)) throw new Error(`Duplicate tool-call ID: ${call.id}`);
    ids.add(call.id);
  }
  if (options.editsRequired && turn.stopReason === "completed" && turn.toolCalls.length === 0) {
    throw new Error("Prose-only completion is invalid when edits are required");
  }
  return turn;
};

export const parseHarnessProviderRequest = (
  value: unknown,
  options: Pick<HarnessOptions, "maxMessages" | "maxPayloadBytes">
): HarnessProviderRequest => {
  const request = limited(harnessProviderRequestSchema, options.maxPayloadBytes).parse(value);
  if (request.messages.length > options.maxMessages) {
    throw new Error(`Request contains more than ${options.maxMessages} messages`);
  }
  return request;
};

export const parseHarnessFinalResult = (
  value: unknown,
  options: Pick<HarnessOptions, "maxIterations" | "maxPayloadBytes">
): HarnessFinalResult => {
  const result = limited(harnessFinalResultSchema, options.maxPayloadBytes).parse(value);
  if (result.iterations.length > options.maxIterations) {
    throw new Error(`Result contains more than ${options.maxIterations} iterations`);
  }
  return result;
};
