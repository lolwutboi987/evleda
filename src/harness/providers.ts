import { isDeepStrictEqual } from "node:util";
import {
  HARNESS_DEFAULT_LIMITS,
  harnessProviderTurnSchema,
  type HarnessProvider,
  type HarnessProviderMessage,
  type HarnessProviderRequest,
  type HarnessProviderTurnContext,
  type HarnessProviderTurn
} from "./contracts.js";
import {
  assertProviderFailureEvidenceMatchesDiagnostic,
  createFluxDiagnostic,
  parseFluxDiagnostic,
  parseProviderFailureEvidence,
  type FluxDiagnosticDto,
  type ProviderFailureEvidenceV1,
} from "../domain/diagnostics.js";

/** The largest vendor response accepted before JSON parsing. */
export const DEFAULT_PROVIDER_RESPONSE_BYTES = HARNESS_DEFAULT_LIMITS.maxPayloadBytes;
/** Every network-backed provider turn has an independent wall-clock ceiling. */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 90_000;
export const MAXIMUM_PROVIDER_TIMEOUT_MS = 300_000;
/** Deliberately finite for both Responses `max_output_tokens` and Messages `max_tokens`. */
export const DEFAULT_PROVIDER_MAX_OUTPUT_TOKENS = 4_096;
export const MAXIMUM_PROVIDER_MAX_OUTPUT_TOKENS = 16_384;
export const DEFAULT_OPENAI_CONVERSATION_STATE_BYTES = 4 * 1024 * 1024;
export const MAXIMUM_OPENAI_CONVERSATION_STATE_BYTES = 16 * 1024 * 1024;
/** Retain a supported 64-turn harness chain independently of the default turn budget. */
export const MAXIMUM_OPENAI_CONVERSATION_STATE_ENTRIES = 64;
export const OPENAI_HARNESS_PROVIDER_ADAPTER_SCHEMA_VERSION =
  "evleda.openai-responses-harness-provider.v4" as const;
export const ANTHROPIC_HARNESS_PROVIDER_ADAPTER_SCHEMA_VERSION =
  "evleda.anthropic-messages-harness-provider.v3" as const;

export type ProviderFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface HarnessProviderAdapterOptions {
  /** Required deliberately: a host must make the model choice explicit. */
  readonly model: string;
  /** Uses the provider-specific environment variable when omitted. */
  readonly apiKey?: string;
  /** Injectable for offline tests; defaults to Node's native fetch. */
  readonly fetch?: ProviderFetch;
  /** Lets a host cancel an in-flight provider request. */
  readonly signal?: AbortSignal;
  /** Bounds bytes read from either a success or error response. */
  readonly maxResponseBytes?: number;
  /** Bounds the normalized assistant turn independently of envelope size. */
  readonly maxOutputBytes?: number;
  /** Defaults to 90 seconds and covers fetch plus bounded response-body intake. */
  readonly timeoutMs?: number;
  /** Optional endpoint override, mainly for a controlled gateway or test server. */
  readonly endpoint?: string;
}

export interface OpenAIHarnessProviderOptions extends HarnessProviderAdapterOptions {
  /** Fast maps to Responses' documented priority tier; standard maps to default. */
  readonly serviceTier?: "fast" | "standard";
  /** Finite Responses output reservation; serialized as `max_output_tokens`. */
  readonly maxOutputTokens?: number;
  /** Aggregate private native-output replay budget for store:false continuations. */
  readonly maxConversationStateBytes?: number;
}

export interface AnthropicHarnessProviderOptions extends HarnessProviderAdapterOptions {
  /** Messages requires a finite output reservation. */
  readonly maxTokens?: number;
}

export class HarnessProviderError extends Error {
  constructor(
    message: string,
    readonly code: "AUTH" | "HTTP" | "MALFORMED" | "REFUSAL" | "OUTPUT_LIMIT" | "INCOMPLETE",
    readonly status?: number,
    diagnostic?: FluxDiagnosticDto,
    providerFailureEvidence?: ProviderFailureEvidenceV1,
  ) {
    super(message);
    this.name = "HarnessProviderError";
    this.diagnostic = diagnostic === undefined ? undefined : parseFluxDiagnostic(diagnostic);
    this.providerFailureEvidence = providerFailureEvidence === undefined
      ? undefined
      : parseProviderFailureEvidence(providerFailureEvidence);
    if (this.providerFailureEvidence !== undefined) {
      if (this.diagnostic === undefined) throw new Error("Provider failure evidence requires a public diagnostic");
      assertProviderFailureEvidenceMatchesDiagnostic(this.providerFailureEvidence, this.diagnostic);
    }
    Object.defineProperty(this, "providerFailureEvidence", {
      value: this.providerFailureEvidence,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  readonly diagnostic: FluxDiagnosticDto | undefined;
  readonly providerFailureEvidence: ProviderFailureEvidenceV1 | undefined;
}

const httpProviderDiagnostic = (
  code: "PROVIDER_AUTH_UNAVAILABLE" | "PROVIDER_DEADLINE_EXCEEDED" | "PROVIDER_REQUEST_FAILED",
  boundary: string,
  category: string,
): FluxDiagnosticDto => createFluxDiagnostic(code, {
  adapter: "http_provider",
  boundary,
  category,
});

interface PreparedOptions {
  readonly model: string;
  readonly apiKey: string;
  readonly fetch: ProviderFetch;
  readonly signal: AbortSignal | undefined;
  readonly maxResponseBytes: number;
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
  readonly endpoint: string;
}

const nonBlank = (value: string | undefined, label: string): string => {
  const trimmed = value?.trim();
  if (!trimmed) throw new HarnessProviderError(`${label} is required`, "AUTH");
  return trimmed;
};

const positive = (value: number | undefined, fallback: number, label: string): number => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${label} must be a positive integer`);
  return result;
};

const boundedTimeout = (value: number | undefined): number => {
  const timeout = positive(value, DEFAULT_PROVIDER_TIMEOUT_MS, "timeoutMs");
  if (timeout > MAXIMUM_PROVIDER_TIMEOUT_MS) {
    throw new Error(`timeoutMs may not exceed ${MAXIMUM_PROVIDER_TIMEOUT_MS}`);
  }
  return timeout;
};

const prepare = (
  options: HarnessProviderAdapterOptions,
  environmentKey: "OPENAI_API_KEY" | "ANTHROPIC_API_KEY",
  defaultEndpoint: string
): PreparedOptions => ({
  model: nonBlank(options.model, "model"),
  apiKey: nonBlank(options.apiKey ?? process.env[environmentKey], environmentKey),
  fetch: options.fetch ?? globalThis.fetch,
  signal: options.signal,
  maxResponseBytes: positive(options.maxResponseBytes, DEFAULT_PROVIDER_RESPONSE_BYTES, "maxResponseBytes"),
  maxOutputBytes: positive(options.maxOutputBytes, DEFAULT_PROVIDER_RESPONSE_BYTES, "maxOutputBytes"),
  timeoutMs: boundedTimeout(options.timeoutMs),
  endpoint: options.endpoint ?? defaultEndpoint
});

const bytes = (value: string): number => Buffer.byteLength(value, "utf8");

const deepFrozenClone = <Value>(value: Value): Value => {
  const clone = structuredClone(value);
  const freeze = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== "object" || Object.isFrozen(candidate)) return;
    for (const child of Object.values(candidate as Record<string, unknown>)) freeze(child);
    Object.freeze(candidate);
  };
  freeze(clone);
  return clone;
};

/** Reads fetch streams incrementally so a lying/missing Content-Length cannot bypass the cap. */
const readBoundedBody = async (response: Response, limit: number): Promise<string> => {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > limit) {
    throw new HarnessProviderError(`Provider response exceeds the ${limit}-byte limit`, "OUTPUT_LIMIT", response.status);
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new HarnessProviderError(`Provider response exceeds the ${limit}-byte limit`, "OUTPUT_LIMIT", response.status);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
};

const parseJson = (body: string, status?: number): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(body);
    if (value === null || Array.isArray(value) || typeof value !== "object") throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch {
    throw new HarnessProviderError("Provider returned malformed JSON", "MALFORMED", status);
  }
};

const stringValue = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const objectValue = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && !Array.isArray(value) && typeof value === "object" ? value as Record<string, unknown> : undefined;

const openAiNonCompletedStatuses = new Set(["failed", "in_progress", "cancelled", "queued", "incomplete"]);

/**
 * Responses may contain usable-looking output before the request is complete.
 * Accept only the documented terminal success envelope so partial tool calls
 * can never cross the provider boundary.
 */
const requireCompletedOpenAiResponse = (response: Record<string, unknown>): void => {
  if (typeof response.status !== "string") {
    throw new HarnessProviderError("OpenAI response status is malformed", "MALFORMED");
  }
  if (openAiNonCompletedStatuses.has(response.status)) {
    throw new HarnessProviderError("OpenAI response was not completed; no tool calls will be executed", "INCOMPLETE");
  }
  if (response.status !== "completed") {
    throw new HarnessProviderError("OpenAI response status is unsupported", "MALFORMED");
  }
  if (!Object.hasOwn(response, "error") || response.error !== null) {
    throw new HarnessProviderError("OpenAI completed response has malformed error details", "MALFORMED");
  }
  if (!Object.hasOwn(response, "incomplete_details")) {
    throw new HarnessProviderError("OpenAI completed response has malformed incomplete details", "MALFORMED");
  }
  if (objectValue(response.incomplete_details) !== undefined) {
    throw new HarnessProviderError("OpenAI response was incomplete; no tool calls will be executed", "INCOMPLETE");
  }
  if (response.incomplete_details !== null) {
    throw new HarnessProviderError("OpenAI completed response has malformed incomplete details", "MALFORMED");
  }
};

const requiredToolName = (
  request: HarnessProviderRequest,
  context: HarnessProviderTurnContext | undefined
): string | undefined => {
  const required = context?.requiredToolName;
  if (required === undefined) return undefined;
  if (request.tools.filter((tool) => tool.name === required).length !== 1) {
    throw new HarnessProviderError("The required provider tool is not uniquely defined by this request", "MALFORMED");
  }
  return required;
};

const operationSignal = (
  configured: AbortSignal | undefined,
  perTurn: AbortSignal | undefined
): AbortSignal | undefined => configured === undefined
  ? perTurn
  : perTurn === undefined || perTurn === configured
    ? configured
    : AbortSignal.any([configured, perTurn]);

const validateTurn = (turn: HarnessProviderTurn, request: HarnessProviderRequest, maxOutputBytes: number): HarnessProviderTurn => {
  if (bytes(JSON.stringify(turn)) > maxOutputBytes) {
    throw new HarnessProviderError("Provider output exceeds the harness payload limit", "OUTPUT_LIMIT");
  }
  const allowed = new Set(request.tools.map((tool) => tool.name));
  const ids = new Set<string>();
  for (const call of turn.toolCalls) {
    if (!allowed.has(call.name)) throw new HarnessProviderError(`Provider requested unsupported tool: ${call.name}`, "MALFORMED");
    if (ids.has(call.id)) throw new HarnessProviderError(`Provider returned duplicate tool-call ID: ${call.id}`, "MALFORMED");
    ids.add(call.id);
  }
  return harnessProviderTurnSchema.parse(turn);
};

const assistantTurn = (content: string, toolCalls: HarnessProviderTurn["toolCalls"], responseId?: string): HarnessProviderTurn => {
  const message = { role: "assistant" as const, content: content.trim() || (toolCalls.length ? "Calling requested tools." : "Provider completed."), ...(responseId === undefined ? {} : { responseId }) };
  return { message, toolCalls, stopReason: toolCalls.length ? "tool_calls" : "completed", ...(responseId === undefined ? {} : { responseId }) };
};

/**
 * Request-schema parsing may reorder object keys without changing a transcript.
 * Only the message contract's optional undefined fields are made explicit here;
 * JSON argument values, tool-call array order, and native replay items are untouched.
 */
const comparableHistoryMessage = (message: HarnessProviderMessage): HarnessProviderMessage => ({
  ...message,
  toolCallId: message.toolCallId,
  toolCalls: message.toolCalls,
  responseId: message.responseId,
});

const refusalTurn = (reason: string): HarnessProviderTurn => ({
  message: { role: "assistant", content: reason.trim() || "The provider refused this request." },
  toolCalls: [],
  stopReason: "blocked"
});

const validatedRefusalTurn = (
  reason: string,
  request: HarnessProviderRequest,
  maxOutputBytes: number
): HarnessProviderTurn => validateTurn(refusalTurn(reason), request, maxOutputBytes);

const normalizedOpenAiInput = (messages: readonly HarnessProviderMessage[]): unknown[] =>
  messages.flatMap<unknown>((message) => {
  if (message.role === "tool") return [{ type: "function_call_output", call_id: message.toolCallId!, output: message.content }];
  const content = message.content.trim().length === 0 ? [] : [{ type: "input_text", text: message.content }];
  const assistant = { role: message.role, content };
  if (message.role !== "assistant" || message.toolCalls === undefined) return [assistant];
  return [assistant, ...message.toolCalls.map((call) => ({
    type: "function_call",
    call_id: call.id,
    name: call.name,
    arguments: JSON.stringify(call.arguments),
  }))];
  });

const requireCompletedOpenAiOutputItem = (
  item: Record<string, unknown>,
  kind: "function call" | "message" | "reasoning"
): void => {
  if (typeof item.status !== "string") {
    throw new HarnessProviderError(`OpenAI ${kind} status is malformed`, "MALFORMED");
  }
  if (item.status === "in_progress" || item.status === "incomplete") {
    throw new HarnessProviderError(`OpenAI ${kind} was not completed; no output will be exposed`, "INCOMPLETE");
  }
  if (item.status !== "completed") {
    throw new HarnessProviderError(`OpenAI ${kind} status is unsupported`, "MALFORMED");
  }
};

const exactOpenAiKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): void => {
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.has(key))
    || required.some((key) => !Object.hasOwn(value, key))
  ) throw new HarnessProviderError("OpenAI output item contains missing or unsupported fields", "MALFORMED");
};

const boundedOpenAiString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.isWellFormed() || /\u0000/u.test(value)) {
    throw new HarnessProviderError(`OpenAI ${label} is malformed`, "MALFORMED");
  }
  return value;
};

const normalizeOpenAiReasoningItem = (record: Record<string, unknown>): Readonly<Record<string, unknown>> => {
  exactOpenAiKeys(record, ["id", "summary", "type", "encrypted_content", "status"], ["content"]);
  requireCompletedOpenAiOutputItem(record, "reasoning");
  const id = boundedOpenAiString(record.id, "reasoning ID");
  const encryptedContent = boundedOpenAiString(record.encrypted_content, "reasoning encrypted content");
  if (id.length === 0 || encryptedContent.length === 0 || !Array.isArray(record.summary)) {
    throw new HarnessProviderError("OpenAI reasoning item is malformed", "MALFORMED");
  }
  const summary = record.summary.map((entry) => {
    const item = objectValue(entry);
    if (item === undefined) throw new HarnessProviderError("OpenAI reasoning summary is malformed", "MALFORMED");
    exactOpenAiKeys(item, ["text", "type"]);
    if (item.type !== "summary_text") throw new HarnessProviderError("OpenAI reasoning summary is malformed", "MALFORMED");
    return Object.freeze({ type: "summary_text", text: boundedOpenAiString(item.text, "reasoning summary text") });
  });
  const content = record.content === undefined ? undefined : (() => {
    if (!Array.isArray(record.content)) throw new HarnessProviderError("OpenAI reasoning content is malformed", "MALFORMED");
    return record.content.map((entry) => {
      const item = objectValue(entry);
      if (item === undefined) throw new HarnessProviderError("OpenAI reasoning content is malformed", "MALFORMED");
      exactOpenAiKeys(item, ["text", "type"]);
      if (item.type !== "reasoning_text") throw new HarnessProviderError("OpenAI reasoning content is malformed", "MALFORMED");
      return Object.freeze({ type: "reasoning_text", text: boundedOpenAiString(item.text, "reasoning text") });
    });
  })();
  return Object.freeze({
    id,
    summary: Object.freeze(summary),
    type: "reasoning",
    encrypted_content: encryptedContent,
    status: "completed",
    ...(content === undefined ? {} : { content: Object.freeze(content) }),
  });
};

const normalizeOpenAiFunctionCallItem = (record: Record<string, unknown>): Readonly<Record<string, unknown>> => {
  exactOpenAiKeys(record, ["id", "arguments", "call_id", "name", "status", "type"]);
  requireCompletedOpenAiOutputItem(record, "function call");
  const id = boundedOpenAiString(record.id, "function-call ID");
  const callId = boundedOpenAiString(record.call_id, "function-call call_id");
  const name = boundedOpenAiString(record.name, "function-call name");
  if (id.length === 0 || callId.length === 0 || name.length === 0) {
    throw new HarnessProviderError("OpenAI function call is malformed", "MALFORMED");
  }
  return Object.freeze({
    id,
    arguments: boundedOpenAiString(record.arguments, "function-call arguments"),
    call_id: callId,
    name,
    status: "completed",
    type: "function_call",
  });
};

const normalizeOpenAiMessageItem = (record: Record<string, unknown>): Readonly<Record<string, unknown>> => {
  exactOpenAiKeys(record, ["id", "content", "role", "status", "type"], ["phase"]);
  requireCompletedOpenAiOutputItem(record, "message");
  if (record.role !== "assistant" || !Array.isArray(record.content)) {
    throw new HarnessProviderError("OpenAI output message role or content is malformed", "MALFORMED");
  }
  const content = record.content.map((entry) => {
    const item = objectValue(entry);
    if (item === undefined) throw new HarnessProviderError("OpenAI message content is malformed", "MALFORMED");
    if (item.type === "output_text") {
      exactOpenAiKeys(item, ["annotations", "text", "type"]);
      if (!Array.isArray(item.annotations) || item.annotations.length !== 0) {
        throw new HarnessProviderError("OpenAI output-text annotations are unsupported", "MALFORMED");
      }
      return Object.freeze({ annotations: Object.freeze([]), text: boundedOpenAiString(item.text, "output text"), type: "output_text" });
    }
    if (item.type === "refusal") {
      exactOpenAiKeys(item, ["refusal", "type"]);
      return Object.freeze({ refusal: boundedOpenAiString(item.refusal, "refusal"), type: "refusal" });
    }
    throw new HarnessProviderError("OpenAI message content type is unsupported", "MALFORMED");
  });
  const phase = record.phase;
  if (phase !== undefined && phase !== "commentary" && phase !== "final_answer") {
    throw new HarnessProviderError("OpenAI output message phase is malformed", "MALFORMED");
  }
  const id = boundedOpenAiString(record.id, "message ID");
  if (id.length === 0) throw new HarnessProviderError("OpenAI output message ID is malformed", "MALFORMED");
  return Object.freeze({
    id,
    content: Object.freeze(content),
    role: "assistant",
    status: "completed",
    type: "message",
    ...(phase === undefined ? {} : { phase }),
  });
};

const normalizeOpenAiOutput = (output: readonly unknown[]): readonly Readonly<Record<string, unknown>>[] =>
  Object.freeze(output.map((item) => {
    const record = objectValue(item);
    if (record === undefined) throw new HarnessProviderError("OpenAI output item is malformed", "MALFORMED");
    if (record.type === "reasoning") return normalizeOpenAiReasoningItem(record);
    if (record.type === "function_call") return normalizeOpenAiFunctionCallItem(record);
    if (record.type === "message") return normalizeOpenAiMessageItem(record);
    throw new HarnessProviderError("OpenAI response contains an unsupported output item", "MALFORMED");
  }));

/**
 * Strict mode is enabled only when the supplied schema already has exact
 * required/closed object semantics. Optional host fields are never rewritten,
 * so `strict:false` preserves their original validation meaning.
 */
export const isOpenAIStrictFunctionSchema = (value: unknown): boolean => {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (value as Record<string, unknown>).type !== "object") return false;
  const supported = new Set([
    "$defs", "$ref", "type", "enum", "const", "anyOf", "properties",
    "required", "additionalProperties", "items", "description",
  ]);
  const active = new WeakSet<object>();
  let nodes = 0;
  let properties = 0;
  const visit = (candidate: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > 10_000 || depth > 10) return false;
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate) || active.has(candidate)) return false;
    active.add(candidate);
    try {
      const record = candidate as Record<string, unknown>;
      if (Reflect.ownKeys(record).some((key) => typeof key !== "string" || !supported.has(key))) return false;
      const type = record.type;
      if (type !== undefined && !(typeof type === "string"
        || Array.isArray(type) && type.length > 0 && type.every((entry) => typeof entry === "string"))) return false;
      const objectSchema = type === "object"
        || Array.isArray(type) && type.includes("object")
        || Object.hasOwn(record, "properties")
        || Object.hasOwn(record, "additionalProperties");
      if (objectSchema) {
        if (record.additionalProperties !== false || record.properties === null
          || typeof record.properties !== "object" || Array.isArray(record.properties)
          || !Array.isArray(record.required)) return false;
        const propertyKeys = Object.keys(record.properties as Record<string, unknown>).sort();
        properties += propertyKeys.length;
        if (properties > 500) return false;
        if (
          record.required.some((entry) => typeof entry !== "string")
          || new Set(record.required as string[]).size !== record.required.length
          || JSON.stringify([...(record.required as string[])].sort()) !== JSON.stringify(propertyKeys)
        ) return false;
        if (!Object.values(record.properties as Record<string, unknown>).every((entry) => visit(entry, depth + 1))) return false;
      } else if (Object.hasOwn(record, "required") || Object.hasOwn(record, "additionalProperties")) {
        return false;
      }
      if (record.anyOf !== undefined && (!Array.isArray(record.anyOf) || record.anyOf.length === 0
        || record.anyOf.length > 32 || !record.anyOf.every((entry) => visit(entry, depth + 1)))) return false;
      if (record.items !== undefined && !visit(record.items, depth + 1)) return false;
      if (record.$defs !== undefined) {
        if (record.$defs === null || typeof record.$defs !== "object" || Array.isArray(record.$defs)
          || !Object.values(record.$defs as Record<string, unknown>).every((entry) => visit(entry, depth + 1))) return false;
      }
      if (record.$ref !== undefined && typeof record.$ref !== "string") return false;
      if (record.description !== undefined && typeof record.description !== "string") return false;
      if (record.enum !== undefined && (!Array.isArray(record.enum) || record.enum.length === 0 || record.enum.length > 1_000)) return false;
      return true;
    } finally {
      active.delete(candidate);
    }
  };
  return visit(value, 0);
};

const anthropicMessages = (messages: readonly HarnessProviderMessage[]): { system: string | undefined; messages: unknown[] } => {
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n") || undefined;
  const translated = messages.filter((message) => message.role !== "system").map((message) => {
    if (message.role === "tool") {
      return { role: "user", content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }] };
    }
    if (message.role === "assistant" && message.toolCalls !== undefined) {
      return {
        role: "assistant",
        content: [
          ...(message.content.trim().length === 0 ? [] : [{ type: "text", text: message.content }]),
          ...message.toolCalls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.arguments })),
        ],
      };
    }
    return { role: message.role, content: message.content };
  });
  return { system, messages: translated };
};

abstract class BaseHarnessProvider implements HarnessProvider {
  abstract readonly provider: "openai" | "anthropic";
  protected readonly options: PreparedOptions;

  protected constructor(options: PreparedOptions) { this.options = options; }

  protected async boundedTurn<Value>(
    perTurnSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<Value>
  ): Promise<Value> {
    const configured = operationSignal(this.options.signal, perTurnSignal);
    configured?.throwIfAborted();
    const controller = new AbortController();
    let rejectBoundary: ((error: unknown) => void) | undefined;
    const boundary = new Promise<never>((_resolve, reject) => { rejectBoundary = reject; });
    void boundary.catch(() => undefined);
    const abort = (): void => {
      const reason = configured?.reason ?? new DOMException("Provider request aborted", "AbortError");
      controller.abort(reason);
      rejectBoundary!(reason);
    };
    configured?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      controller.abort(new DOMException("Provider request timed out", "TimeoutError"));
      rejectBoundary!(new HarnessProviderError(
        "Provider request timed out",
        "INCOMPLETE",
        undefined,
        httpProviderDiagnostic("PROVIDER_DEADLINE_EXCEEDED", "provider_turn", "deadline"),
      ));
    }, this.options.timeoutMs);
    const pending = Promise.resolve().then(async () => await operation(controller.signal));
    void pending.catch(() => undefined);
    try {
      return await Promise.race([pending, boundary]);
    } finally {
      clearTimeout(timer);
      configured?.removeEventListener("abort", abort);
      controller.abort();
    }
  }

  private async post(
    headers: Record<string, string>,
    payload: unknown,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const response = await this.options.fetch(this.options.endpoint, {
      method: "POST",
      ...(signal === undefined ? {} : { signal }),
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(payload)
    });
    const body = await readBoundedBody(response, this.options.maxResponseBytes);
    if (!response.ok) {
      // Do not surface arbitrary body text: it can contain secrets reflected by a gateway.
      throw new HarnessProviderError(
        "Provider request failed",
        "HTTP",
        response.status,
        httpProviderDiagnostic(
          response.status === 401 || response.status === 403
            ? "PROVIDER_AUTH_UNAVAILABLE"
            : "PROVIDER_REQUEST_FAILED",
          "provider_http",
          response.status === 401 || response.status === 403 ? "authentication" : "http_failure",
        ),
      );
    }
    return parseJson(body, response.status);
  }

  /**
   * Fetch implementations are expected to observe AbortSignal, but the
   * explicit race also bounds a faulty injectable transport that ignores it.
   */
  protected async boundedPost(
    headers: Record<string, string>,
    payload: unknown,
    perTurnSignal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const configured = operationSignal(this.options.signal, perTurnSignal);
    configured?.throwIfAborted();
    const controller = new AbortController();
    let rejectDeadline: ((error: unknown) => void) | undefined;
    const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
    // Keep an early timeout handled until the race is attached below.
    void deadline.catch(() => undefined);
    const abort = (): void => {
      const reason = configured?.reason ?? new DOMException("Provider request aborted", "AbortError");
      controller.abort(reason);
      rejectDeadline!(reason);
    };
    configured?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      controller.abort(new DOMException("Provider request timed out", "TimeoutError"));
      rejectDeadline!(new HarnessProviderError(
        "Provider request timed out",
        "INCOMPLETE",
        undefined,
        httpProviderDiagnostic("PROVIDER_DEADLINE_EXCEEDED", "provider_http", "deadline"),
      ));
    }, this.options.timeoutMs);
    const operation = this.post(headers, payload, controller.signal);
    // A losing transport rejection must not become unhandled after timeout.
    void operation.catch(() => undefined);
    try {
      return await Promise.race([operation, deadline]);
    } finally {
      clearTimeout(timer);
      configured?.removeEventListener("abort", abort);
      controller.abort();
    }
  }

  abstract turn(request: HarnessProviderRequest, context?: HarnessProviderTurnContext): Promise<HarnessProviderTurn>;
}

export class OpenAIHarnessProvider extends BaseHarnessProvider {
  readonly provider = "openai" as const;
  readonly serviceTier: "fast" | "standard";
  readonly maxOutputTokens: number;
  readonly maxConversationStateBytes: number;
  readonly #nativeStates = new Map<string, Readonly<{
    readonly output: readonly unknown[];
    readonly historyMessage: HarnessProviderMessage;
    readonly bytes: number;
  }>>();
  #nativeStateBytes = 0;

  constructor(options: OpenAIHarnessProviderOptions) {
    super(prepare(options, "OPENAI_API_KEY", "https://api.openai.com/v1/responses"));
    this.serviceTier = options.serviceTier ?? "fast";
    this.maxOutputTokens = positive(
      options.maxOutputTokens,
      DEFAULT_PROVIDER_MAX_OUTPUT_TOKENS,
      "maxOutputTokens"
    );
    if (this.maxOutputTokens > MAXIMUM_PROVIDER_MAX_OUTPUT_TOKENS) {
      throw new Error(`maxOutputTokens may not exceed ${MAXIMUM_PROVIDER_MAX_OUTPUT_TOKENS}`);
    }
    this.maxConversationStateBytes = positive(
      options.maxConversationStateBytes,
      DEFAULT_OPENAI_CONVERSATION_STATE_BYTES,
      "maxConversationStateBytes"
    );
    if (this.maxConversationStateBytes > MAXIMUM_OPENAI_CONVERSATION_STATE_BYTES) {
      throw new Error(`maxConversationStateBytes may not exceed ${MAXIMUM_OPENAI_CONVERSATION_STATE_BYTES}`);
    }
  }

  #input(request: HarnessProviderRequest): unknown[] {
    if (request.previousResponseId === undefined) return normalizedOpenAiInput(request.messages);
    const assistantMessages = request.messages.filter((message) => message.role === "assistant");
    if (assistantMessages.length === 0 || assistantMessages.at(-1)?.responseId !== request.previousResponseId) {
      throw new HarnessProviderError("OpenAI continuation does not bind the latest assistant response", "MALFORMED");
    }
    const seen = new Set<string>();
    const input: unknown[] = [];
    for (const message of request.messages) {
      if (message.role !== "assistant") {
        input.push(...normalizedOpenAiInput([message]));
        continue;
      }
      const responseId = message.responseId;
      if (responseId === undefined || seen.has(responseId)) {
        throw new HarnessProviderError("OpenAI continuation has missing or duplicate opaque response state", "MALFORMED");
      }
      seen.add(responseId);
      const state = this.#nativeStates.get(responseId);
      if (state === undefined || !isDeepStrictEqual(comparableHistoryMessage(message), comparableHistoryMessage(state.historyMessage))) {
        throw new HarnessProviderError("OpenAI continuation opaque state is missing or does not match its transcript", "MALFORMED");
      }
      // Deterministic access-order LRU: active-chain states survive unrelated
      // one-turn interpretations until the private byte budget requires them.
      this.#nativeStates.delete(responseId);
      this.#nativeStates.set(responseId, state);
      input.push(...state.output);
    }
    if (!seen.has(request.previousResponseId)) {
      throw new HarnessProviderError("OpenAI continuation state does not match previousResponseId", "MALFORMED");
    }
    return input;
  }

  #remember(responseId: string, output: readonly unknown[], turn: HarnessProviderTurn): void {
    const stateBytes = bytes(JSON.stringify(output));
    const historyMessage = deepFrozenClone<HarnessProviderMessage>(turn.toolCalls.length === 0
      ? { ...turn.message }
      : { ...turn.message, toolCalls: turn.toolCalls });
    const retainedOutput = deepFrozenClone(output);
    const existing = this.#nativeStates.get(responseId);
    if (existing !== undefined) {
      throw new HarnessProviderError("OpenAI reused an opaque response ID", "MALFORMED");
    }
    if (stateBytes > this.maxConversationStateBytes) {
      throw new HarnessProviderError("OpenAI opaque conversation state exceeds its private replay budget", "OUTPUT_LIMIT");
    }
    while (
      this.#nativeStates.size >= MAXIMUM_OPENAI_CONVERSATION_STATE_ENTRIES
      || this.#nativeStateBytes + stateBytes > this.maxConversationStateBytes
    ) {
      const oldest = this.#nativeStates.entries().next().value as [string, { readonly bytes: number }] | undefined;
      if (oldest === undefined) break;
      this.#nativeStates.delete(oldest[0]);
      this.#nativeStateBytes -= oldest[1].bytes;
    }
    this.#nativeStates.set(responseId, Object.freeze({
      output: retainedOutput,
      historyMessage,
      bytes: stateBytes,
    }));
    this.#nativeStateBytes += stateBytes;
  }

  async turn(request: HarnessProviderRequest, context?: HarnessProviderTurnContext): Promise<HarnessProviderTurn> {
    return await this.boundedTurn(context?.signal, async (turnSignal) => {
    const required = requiredToolName(request, context);
    const input = this.#input(request);
    const response = await this.boundedPost({ authorization: `Bearer ${this.options.apiKey}` }, {
      model: this.options.model,
      service_tier: this.serviceTier === "fast" ? "priority" : "default",
      store: false,
      include: ["reasoning.encrypted_content"],
      max_output_tokens: this.maxOutputTokens,
      input,
      tools: request.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        strict: isOpenAIStrictFunctionSchema(tool.inputSchema),
      })),
      tool_choice: required === undefined ? "auto" : { type: "function", name: required },
      parallel_tool_calls: context?.allowParallelToolCalls ?? true,
    }, turnSignal);
    requireCompletedOpenAiResponse(response);
    if (typeof response.refusal === "string") {
      return validatedRefusalTurn(response.refusal, request, this.options.maxOutputBytes);
    }
    const rawOutput = Array.isArray(response.output) ? response.output : undefined;
    if (!rawOutput) throw new HarnessProviderError("OpenAI response has no output array", "MALFORMED");
    if (rawOutput.length > 128) throw new HarnessProviderError("OpenAI response has too many output items", "OUTPUT_LIMIT");
    const output = normalizeOpenAiOutput(rawOutput);
    const responseId = stringValue(response.id);
    if (
      responseId === undefined
      || responseId.trim() !== responseId
      || responseId.length === 0
      || bytes(responseId) > 256
      || /[\u0000-\u001f\u007f]/u.test(responseId)
    ) throw new HarnessProviderError("OpenAI response ID is malformed", "MALFORMED");
    const text: string[] = [];
    const calls: HarnessProviderTurn["toolCalls"] = [];
    for (const item of output) {
      const record = objectValue(item);
      if (!record) throw new HarnessProviderError("OpenAI output item is malformed", "MALFORMED");
      if (record.type === "function_call") {
        requireCompletedOpenAiOutputItem(record, "function call");
        const id = stringValue(record.call_id); const name = stringValue(record.name); const rawArguments = stringValue(record.arguments);
        if (!id || !name || rawArguments === undefined) throw new HarnessProviderError("OpenAI function call is malformed", "MALFORMED");
        const argumentsValue = parseJson(rawArguments);
        calls.push({ id, name, arguments: argumentsValue as HarnessProviderTurn["toolCalls"][number]["arguments"] });
      } else if (record.type === "message") {
        requireCompletedOpenAiOutputItem(record, "message");
        const content = Array.isArray(record.content) ? record.content : [];
        for (const part of content) {
          const block = objectValue(part);
          if (!block) continue;
          if (block.type === "refusal") {
            return validatedRefusalTurn(
              stringValue(block.refusal) ?? "The provider refused this request.",
              request,
              this.options.maxOutputBytes
            );
          }
          if (block.type === "output_text" && typeof block.text === "string") text.push(block.text);
        }
      }
    }
    if (!calls.length && !text.join("").trim()) throw new HarnessProviderError("OpenAI response contains neither text nor tool calls", "MALFORMED");
    const turn = validateTurn(assistantTurn(text.join("\n"), calls, responseId), request, this.options.maxOutputBytes);
    this.#remember(responseId, output, turn);
    return turn;
    });
  }
}

export class AnthropicHarnessProvider extends BaseHarnessProvider {
  readonly provider = "anthropic" as const;
  readonly maxTokens: number;

  constructor(options: AnthropicHarnessProviderOptions) {
    super(prepare(options, "ANTHROPIC_API_KEY", "https://api.anthropic.com/v1/messages"));
    this.maxTokens = positive(options.maxTokens, 4_096, "maxTokens");
    if (this.maxTokens > MAXIMUM_PROVIDER_MAX_OUTPUT_TOKENS) {
      throw new Error(`maxTokens may not exceed ${MAXIMUM_PROVIDER_MAX_OUTPUT_TOKENS}`);
    }
  }

  async turn(request: HarnessProviderRequest, context?: HarnessProviderTurnContext): Promise<HarnessProviderTurn> {
    return await this.boundedTurn(context?.signal, async (turnSignal) => {
    const required = requiredToolName(request, context);
    const translated = anthropicMessages(request.messages);
    const response = await this.boundedPost({ "x-api-key": this.options.apiKey, "anthropic-version": "2023-06-01" }, {
      model: this.options.model,
      max_tokens: this.maxTokens,
      ...(translated.system === undefined ? {} : { system: translated.system }),
      messages: translated.messages,
      tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })),
      ...(required === undefined && context?.allowParallelToolCalls !== false ? {} : {
        tool_choice: required === undefined
          ? { type: "auto", disable_parallel_tool_use: true }
          : { type: "tool", name: required, disable_parallel_tool_use: context?.allowParallelToolCalls === false }
      })
    }, turnSignal);
    if (response.stop_reason === "max_tokens") {
      throw new HarnessProviderError("Anthropic response reached max_tokens; no tool calls will be executed", "INCOMPLETE");
    }
    if (response.stop_reason === "refusal" || typeof response.refusal === "string") {
      return validatedRefusalTurn(
        stringValue(response.refusal) ?? "The provider refused this request.",
        request,
        this.options.maxOutputBytes
      );
    }
    const content = Array.isArray(response.content) ? response.content : undefined;
    if (!content) throw new HarnessProviderError("Anthropic response has no content array", "MALFORMED");
    const text: string[] = [];
    const calls: HarnessProviderTurn["toolCalls"] = [];
    for (const item of content) {
      const block = objectValue(item);
      if (!block) throw new HarnessProviderError("Anthropic content block is malformed", "MALFORMED");
      if (block.type === "tool_use") {
        const id = stringValue(block.id); const name = stringValue(block.name); const input = objectValue(block.input);
        if (!id || !name || !input) throw new HarnessProviderError("Anthropic tool use is malformed", "MALFORMED");
        calls.push({ id, name, arguments: input as HarnessProviderTurn["toolCalls"][number]["arguments"] });
      } else if (block.type === "text" && typeof block.text === "string") {
        text.push(block.text);
      } else if (block.type === "refusal") {
        return validatedRefusalTurn(
          stringValue(block.text) ?? "The provider refused this request.",
          request,
          this.options.maxOutputBytes
        );
      }
    }
    if (!calls.length && !text.join("").trim()) throw new HarnessProviderError("Anthropic response contains neither text nor tool calls", "MALFORMED");
    return validateTurn(assistantTurn(text.join("\n"), calls), request, this.options.maxOutputBytes);
    });
  }
}

/** Small explicit constructors for composition roots that prefer functions to classes. */
export const createOpenAIHarnessProvider = (options: OpenAIHarnessProviderOptions): HarnessProvider => new OpenAIHarnessProvider(options);
export const createAnthropicHarnessProvider = (options: AnthropicHarnessProviderOptions): HarnessProvider => new AnthropicHarnessProvider(options);
