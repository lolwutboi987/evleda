import type {
  FluxApi,
  FluxApprovalSubjectDto,
  FluxCanonicalIdentityDto,
  FluxContractStateDto,
  FluxCreateInput,
  FluxDiagnosticDto,
  FluxInspectorSnapshot,
  FluxOpenResult,
  FluxPollResult,
  FluxPreviewDto,
  FluxPreviewKind,
  FluxProjectDto,
  FluxRunDto,
  FluxRunBindingDto,
  FluxRuntimePolicyDto,
  FluxRuntimeReadinessDto,
  FluxSourceCatalogDto,
  FluxThreadDto,
} from "./model";
import { parseFluxDiagnostic } from "./DiagnosticNotice";
import { iterationCapFromBounds, parseFluxIterationCapPolicy } from "./iteration-policy";

const encoded = (value: string): string => encodeURIComponent(value);
const record = (value: unknown): Record<string, unknown> | undefined => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
const canonicalId = /^[a-z][a-z0-9_-]{0,127}$/u;
const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{1,200}$/u;

export const FLUX_INTENT_STORAGE_PREFIX = "evleda.flux.pending-intent.v1.";
export const FLUX_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const requestIdPattern = /^[A-Za-z0-9._:-]{1,128}$/u;
const operationPattern = /^[a-z][a-z0-9_]{0,63}$/u;
const failureCodes = new Set(["INVALID_ARGUMENT", "NOT_FOUND", "IDEMPOTENCY_CONFLICT", "STAGE_BLOCKED", "PATH_OUTSIDE_WORKSPACE", "TOOLCHAIN_UNAVAILABLE", "OPERATION_UNCERTAIN", "OPEN_PREFLIGHT_FAILED"]);

interface IntentStorage {
  readonly length?: number;
  getItem(key: string): string | null;
  key?(index: number): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface FluxApiDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly storage?: IntentStorage;
  readonly crypto?: Pick<Crypto, "subtle" | "randomUUID" | "getRandomValues">;
}

interface PendingIntent { readonly storageKey: string; readonly idempotencyKey: string }
interface TerminalFailureBinding { readonly operation: "interpret_run" | "clarify_run"; readonly request: unknown; readonly runId: string; readonly run: FluxRunBindingDto }
interface StoredIntent { readonly schemaVersion: "evleda.flux-browser-intent.v1"; readonly state: "pending" | "consumed"; readonly idempotencyKey: string }
interface StoredProjectResult { readonly id: string; readonly sourceKey: string; readonly name: string; readonly createdAt: string }
interface StoredThreadResult { readonly id: string; readonly projectId: string; readonly title: string; readonly createdAt: string }
interface StoredRunResult { readonly id: string; readonly projectId: string; readonly threadId: string }
interface StoredCreateStage<Result> { readonly idempotencyKey: string; readonly state: "not_started" | "pending" | "completed"; readonly result: Result | null }
interface StoredCreateTransaction {
  readonly schemaVersion: "evleda.flux-browser-create-transaction.v1";
  readonly state: "pending" | "consumed";
  readonly project: StoredCreateStage<StoredProjectResult>;
  readonly thread: StoredCreateStage<StoredThreadResult>;
  readonly run: StoredCreateStage<StoredRunResult>;
}

export interface FluxTerminalFailureReceiptDto {
  readonly schemaVersion: "evleda.flux-terminal-failure-receipt.v1";
  readonly operation: "interpret_run" | "clarify_run";
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly diagnosticIdentity: FluxCanonicalIdentityDto;
  readonly terminalPhase: "blocked";
  readonly outcome: "failed";
  readonly completedAt: string;
  readonly identity: FluxCanonicalIdentityDto;
}

type Parsed<Value> = Readonly<{ readonly state: "absent" }> | Readonly<{ readonly state: "valid"; readonly value: Value }> | Readonly<{ readonly state: "malformed" }>;

export class FluxApiError extends Error {
  public constructor(readonly code: string, message: string, readonly retryable: boolean, readonly diagnostic?: FluxDiagnosticDto, readonly terminalFailureReceipt?: FluxTerminalFailureReceiptDto, readonly requestId?: string) { super(message); this.name = "FluxApiError"; }
}

export class FluxIntentStorageError extends Error {
  public readonly resetRequired = true;
  public constructor(message: string) { super(message); this.name = "FluxIntentStorageError"; }
}

const canonical = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Flux request intent contains a non-finite number.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("Flux request intent contains unsupported data.");
    const item = value as Record<string, unknown>;
    return `{${Object.keys(item).sort().map((name) => {
      if (item[name] === undefined) throw new Error("Flux request intent contains undefined data.");
      return `${JSON.stringify(name)}:${canonical(item[name])}`;
    }).join(",")}}`;
  }
  throw new Error("Flux request intent contains unsupported data.");
};

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
const sha256Canonical = async (value: unknown, cryptoPort: Pick<Crypto, "subtle">): Promise<string> => hex(await cryptoPort.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value))));
const browserStorage = (): IntentStorage | undefined => { try { return globalThis.localStorage; } catch { return undefined; } };
const browserCrypto = (): Pick<Crypto, "subtle" | "randomUUID" | "getRandomValues"> => {
  if (globalThis.crypto === undefined) throw new FluxIntentStorageError("Secure browser randomness is unavailable; no mutation was sent. Reset is required after browser storage is restored.");
  return globalThis.crypto;
};
const newIdempotencyKey = (cryptoPort: Pick<Crypto, "randomUUID" | "getRandomValues">): string => {
  if (typeof cryptoPort.randomUUID === "function") return `flux-${cryptoPort.randomUUID()}`;
  const bytes = cryptoPort.getRandomValues(new Uint8Array(16));
  return `flux-${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
};
const storageKeyFor = async (operation: string, body: unknown, cryptoPort: Pick<Crypto, "subtle">): Promise<string> => `${FLUX_INTENT_STORAGE_PREFIX}${operation}.${await sha256Canonical({ operation, body }, cryptoPort)}`;

const receiptIdentity = (value: unknown, schemaVersion: string): value is FluxCanonicalIdentityDto => {
  const item = record(value);
  return item !== undefined && exactKeys(item, ["algorithm", "digest", "schemaVersion", "canonicalizationVersion"]) && item.algorithm === "sha256" && typeof item.digest === "string" && /^[0-9a-f]{64}$/u.test(item.digest) && item.schemaVersion === schemaVersion && item.canonicalizationVersion === "evleda-c14n-json-v1";
};
const sameIdentity = (left: FluxCanonicalIdentityDto, right: FluxCanonicalIdentityDto): boolean => left.algorithm === right.algorithm && left.digest === right.digest && left.schemaVersion === right.schemaVersion && left.canonicalizationVersion === right.canonicalizationVersion;
const canonicalIdentityFor = async (value: unknown, schemaVersion: string, cryptoPort: Pick<Crypto, "subtle">): Promise<FluxCanonicalIdentityDto> => ({ algorithm: "sha256", digest: await sha256Canonical(value, cryptoPort), schemaVersion, canonicalizationVersion: "evleda-c14n-json-v1" });

const parseTerminalFailureReceipt = async (value: unknown, diagnostic: FluxDiagnosticDto | undefined, cryptoPort: Pick<Crypto, "subtle">): Promise<FluxTerminalFailureReceiptDto | undefined> => {
  const item = record(value);
  if (diagnostic === undefined || item === undefined || !exactKeys(item, ["schemaVersion", "operation", "idempotencyKey", "requestDigest", "projectId", "threadId", "runId", "diagnosticIdentity", "terminalPhase", "outcome", "completedAt", "identity"]) || item.schemaVersion !== "evleda.flux-terminal-failure-receipt.v1" || (item.operation !== "interpret_run" && item.operation !== "clarify_run") || typeof item.idempotencyKey !== "string" || !idempotencyKeyPattern.test(item.idempotencyKey) || typeof item.requestDigest !== "string" || !/^[0-9a-f]{64}$/u.test(item.requestDigest) || typeof item.projectId !== "string" || !canonicalId.test(item.projectId) || typeof item.threadId !== "string" || !canonicalId.test(item.threadId) || typeof item.runId !== "string" || !canonicalId.test(item.runId) || item.terminalPhase !== "blocked" || item.outcome !== "failed" || typeof item.completedAt !== "string" || Number.isNaN(Date.parse(item.completedAt)) || new Date(item.completedAt).toISOString() !== item.completedAt || !receiptIdentity(item.diagnosticIdentity, "evleda.flux-terminal-failure-diagnostic.v1") || !receiptIdentity(item.identity, "evleda.flux-terminal-failure-receipt.v1")) return undefined;
  const expectedDiagnosticIdentity = await canonicalIdentityFor(diagnostic, "evleda.flux-terminal-failure-diagnostic.v1", cryptoPort);
  if (!sameIdentity(item.diagnosticIdentity, expectedDiagnosticIdentity)) return undefined;
  const { identity: _identity, ...payload } = item;
  const expectedIdentity = await canonicalIdentityFor(payload, "evleda.flux-terminal-failure-receipt.v1", cryptoPort);
  return sameIdentity(item.identity, expectedIdentity) ? item as unknown as FluxTerminalFailureReceiptDto : undefined;
};

const cancelBody = async (response: Response): Promise<void> => { try { await response.body?.cancel(); } catch { /* The response is already being rejected. */ } };
const boundedJson = async (response: Response): Promise<unknown> => {
  const mediaType = response.headers.get("content-type")?.toLocaleLowerCase("en-US") ?? "";
  if (!/^application\/json(?:\s*;.*)?$/u.test(mediaType)) { await cancelBody(response); return undefined; }
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declared)) { await cancelBody(response); throw new FluxApiError("INVALID_RESPONSE", "Flux service returned an invalid response envelope.", false); }
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes > FLUX_RESPONSE_MAX_BYTES) { await cancelBody(response); throw new FluxApiError("RESPONSE_TOO_LARGE", "Flux service response exceeded the browser safety bound.", false); }
  }
  if (response.body === null) return undefined;
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0; let chunkCount = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break; if (value === undefined) continue;
      chunkCount += 1; if (chunkCount > 4096) { try { await reader.cancel("response has too many chunks"); } catch { /* Chunk bound remains authoritative. */ } throw new FluxApiError("INVALID_RESPONSE", "Flux service response exceeded the browser chunk bound.", false); }
      if (total + value.byteLength > FLUX_RESPONSE_MAX_BYTES) { try { await reader.cancel("response exceeds browser bound"); } catch { /* Overflow remains authoritative. */ } throw new FluxApiError("RESPONSE_TOO_LARGE", "Flux service response exceeded the browser safety bound.", false); }
      total += value.byteLength; chunks.push(value);
    }
  } catch (error) {
    if (error instanceof FluxApiError) throw error;
    try { await reader.cancel(); } catch { /* Read already failed. */ }
    throw new FluxApiError("INVALID_RESPONSE", "Flux service response could not be read safely.", false);
  }
  const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let text: string; try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new FluxApiError("INVALID_RESPONSE", "Flux service returned invalid UTF-8.", false); }
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
};

const staticFailureMessage = (code: string, status: number): string => {
  switch (code) {
    case "INVALID_ARGUMENT": return "Flux rejected the request.";
    case "NOT_FOUND": return "The requested Flux record was not found.";
    case "IDEMPOTENCY_CONFLICT": return "Flux rejected a conflicting operation intent.";
    case "STAGE_BLOCKED": return "The Flux operation was blocked.";
    case "PATH_OUTSIDE_WORKSPACE": return "Flux rejected a workspace boundary violation.";
    case "TOOLCHAIN_UNAVAILABLE": return "The Flux toolchain is unavailable.";
    case "OPERATION_UNCERTAIN": return "The Flux operation outcome is uncertain.";
    case "OPEN_PREFLIGHT_FAILED": return "PCB editor Open preflight failed before launch; retrying this exact action is safe.";
    default: return `Flux service request failed with HTTP ${status}.`;
  }
};

const storedIntent = (state: StoredIntent["state"], idempotencyKey: string): StoredIntent => ({ schemaVersion: "evleda.flux-browser-intent.v1", state, idempotencyKey });
const parseStoredIntent = (raw: string | null): Parsed<StoredIntent> => {
  if (raw === null) return { state: "absent" };
  try {
    const value = JSON.parse(raw) as unknown; const item = record(value);
    if (item === undefined || !exactKeys(item, ["schemaVersion", "state", "idempotencyKey"]) || item.schemaVersion !== "evleda.flux-browser-intent.v1" || (item.state !== "pending" && item.state !== "consumed") || typeof item.idempotencyKey !== "string" || !idempotencyKeyPattern.test(item.idempotencyKey)) return { state: "malformed" };
    return { state: "valid", value: storedIntent(item.state, item.idempotencyKey) };
  } catch { return { state: "malformed" }; }
};

const storedProjectResult = (value: unknown): StoredProjectResult | undefined => {
  const item = record(value);
  return item !== undefined && exactKeys(item, ["id", "sourceKey", "name", "createdAt"]) && typeof item.id === "string" && canonicalId.test(item.id) && typeof item.sourceKey === "string" && canonicalId.test(item.sourceKey) && typeof item.name === "string" && item.name.length > 0 && item.name.length <= 128 && typeof item.createdAt === "string" && item.createdAt.length > 0 && item.createdAt.length <= 64 ? item as unknown as StoredProjectResult : undefined;
};
const storedThreadResult = (value: unknown): StoredThreadResult | undefined => {
  const item = record(value);
  return item !== undefined && exactKeys(item, ["id", "projectId", "title", "createdAt"]) && typeof item.id === "string" && canonicalId.test(item.id) && typeof item.projectId === "string" && canonicalId.test(item.projectId) && typeof item.title === "string" && item.title.length > 0 && item.title.length <= 256 && typeof item.createdAt === "string" && item.createdAt.length > 0 && item.createdAt.length <= 64 ? item as unknown as StoredThreadResult : undefined;
};
const storedRunResult = (value: unknown): StoredRunResult | undefined => {
  const item = record(value);
  return item !== undefined && exactKeys(item, ["id", "projectId", "threadId"]) && typeof item.id === "string" && canonicalId.test(item.id) && typeof item.projectId === "string" && canonicalId.test(item.projectId) && typeof item.threadId === "string" && canonicalId.test(item.threadId) ? item as unknown as StoredRunResult : undefined;
};

const parseStage = <Result,>(value: unknown, parseResult: (value: unknown) => Result | undefined): StoredCreateStage<Result> | undefined => {
  const item = record(value);
  if (item === undefined || !exactKeys(item, ["idempotencyKey", "state", "result"]) || typeof item.idempotencyKey !== "string" || !idempotencyKeyPattern.test(item.idempotencyKey) || !["not_started", "pending", "completed"].includes(String(item.state))) return undefined;
  const state = item.state as StoredCreateStage<Result>["state"];
  if (state === "completed") { const result = parseResult(item.result); return result === undefined ? undefined : { idempotencyKey: item.idempotencyKey, state, result }; }
  return item.result === null ? { idempotencyKey: item.idempotencyKey, state, result: null } : undefined;
};

const parseCreateTransaction = (raw: string | null): Parsed<StoredCreateTransaction> => {
  if (raw === null) return { state: "absent" };
  try {
    const item = record(JSON.parse(raw) as unknown);
    if (item === undefined || !exactKeys(item, ["schemaVersion", "state", "project", "thread", "run"]) || item.schemaVersion !== "evleda.flux-browser-create-transaction.v1" || (item.state !== "pending" && item.state !== "consumed")) return { state: "malformed" };
    const project = parseStage(item.project, storedProjectResult); const thread = parseStage(item.thread, storedThreadResult); const run = parseStage(item.run, storedRunResult);
    if (project === undefined || thread === undefined || run === undefined || new Set([project.idempotencyKey, thread.idempotencyKey, run.idempotencyKey]).size !== 3) return { state: "malformed" };
    const sequence = `${project.state}:${thread.state}:${run.state}`;
    const validSequence = item.state === "consumed" ? sequence === "completed:completed:completed" : ["pending:not_started:not_started", "completed:pending:not_started", "completed:completed:pending"].includes(sequence);
    if (!validSequence || (thread.result !== null && (project.result === null || thread.result.projectId !== project.result.id)) || (run.result !== null && (project.result === null || thread.result === null || run.result.projectId !== project.result.id || run.result.threadId !== thread.result.id))) return { state: "malformed" };
    return { state: "valid", value: { schemaVersion: "evleda.flux-browser-create-transaction.v1", state: item.state, project, thread, run } };
  } catch { return { state: "malformed" }; }
};

const createTransaction = (cryptoPort: Pick<Crypto, "randomUUID" | "getRandomValues">): StoredCreateTransaction => ({
  schemaVersion: "evleda.flux-browser-create-transaction.v1",
  state: "pending",
  project: { idempotencyKey: newIdempotencyKey(cryptoPort), state: "pending", result: null },
  thread: { idempotencyKey: newIdempotencyKey(cryptoPort), state: "not_started", result: null },
  run: { idempotencyKey: newIdempotencyKey(cryptoPort), state: "not_started", result: null },
});

export const createFluxApi = (dependencies: FluxApiDependencies = {}): FluxApi => {
  let intentStorageUnsafe = false;
  const resetKeys = new Set<string>();
  const fetchPort = (...parameters: Parameters<typeof globalThis.fetch>): ReturnType<typeof globalThis.fetch> => (dependencies.fetch ?? globalThis.fetch)(...parameters);
  const storage = (): IntentStorage => {
    const value = dependencies.storage ?? browserStorage();
    if (value === undefined) throw new FluxIntentStorageError("Durable browser operation storage is unavailable; no mutation was sent. Explicit reset is required after storage is restored.");
    return value;
  };
  const lock = (message: string): never => { intentStorageUnsafe = true; throw new FluxIntentStorageError(message); };
  const namespaceKeys = (port: IntentStorage): readonly string[] => {
    if (typeof port.length !== "number" || typeof port.key !== "function") return [...resetKeys];
    const keys: string[] = [];
    for (let index = 0; index < port.length; index += 1) { const key = port.key(index); if (key?.startsWith("evleda.flux.")) keys.push(key); }
    return keys;
  };
  const auditStoredIntents = (allowedPendingKey: string): void => {
    const port = storage();
    for (const key of namespaceKeys(port)) {
      resetKeys.add(key);
      if (!key.startsWith(FLUX_INTENT_STORAGE_PREFIX)) return lock("Unknown or version-mismatched Flux browser state was found. Mutations are locked until explicit reset.");
      let raw: string | null; try { raw = port.getItem(key); } catch { return lock("Durable browser operation storage is unavailable. Mutations are locked until explicit reset."); }
      const parsed = key.includes(".create-transaction.") ? parseCreateTransaction(raw) : parseStoredIntent(raw);
      if (parsed.state === "malformed") return lock("Corrupt or version-mismatched durable browser state was found. Mutations are locked until explicit reset.");
      if (parsed.state === "valid" && parsed.value.state === "pending" && key !== allowedPendingKey) return lock("Another durable browser operation remains pending. Mutations are locked until that exact action is retried or explicitly reset.");
    }
  };
  const write = (key: string, value: unknown, completed = false): void => {
    const port = storage(); const text = JSON.stringify(value); resetKeys.add(key);
    try { port.setItem(key, text); if (port.getItem(key) !== text) throw new Error("write did not round-trip"); }
    catch { lock(completed ? "The operation completed, but its durable browser transaction could not be terminalized. Mutations are locked until explicit reset." : "The durable browser transaction could not be recorded. No further mutation is allowed until explicit reset."); }
  };
  const read = (key: string): string | null => {
    resetKeys.add(key);
    try { return storage().getItem(key); } catch { return lock("Durable browser operation storage is unavailable. Mutations are locked until explicit reset."); }
  };

  const request = async <Result>(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Result> => {
    const response = await fetchPort(url, { ...init, ...(signal === undefined ? {} : { signal }), headers: { "Content-Type": "application/json", ...init.headers } });
    const parsed = await boundedJson(response);
    const envelope = record(parsed);
    const safeRequestId = typeof envelope?.requestId === "string" && requestIdPattern.test(envelope.requestId) ? envelope.requestId : undefined;
    if (!response.ok) {
      const failure = record(envelope?.error); const allowedErrorKeys = new Set(["code", "message", "retryable", "details", "diagnostic", "terminalFailureReceipt"]);
      const exactEnvelope = envelope !== undefined && exactKeys(envelope, ["ok", "requestId", "error"]) && envelope.ok === false && safeRequestId !== undefined;
      const exactError = failure !== undefined && ["code", "message", "retryable", "details"].every((key) => Object.hasOwn(failure, key)) && Object.keys(failure).every((key) => allowedErrorKeys.has(key));
      const safeCode = exactError && typeof failure.code === "string" && failureCodes.has(failure.code) ? failure.code : undefined;
      const safeMessageShape = exactError && typeof failure.message === "string" && failure.message.length > 0 && failure.message.length <= 1024 && !/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u.test(failure.message);
      const safeDetails = exactError && record(failure.details) !== undefined;
      if (!exactEnvelope || !exactError || safeCode === undefined || !safeMessageShape || typeof failure.retryable !== "boolean" || !safeDetails) throw new FluxApiError("INVALID_RESPONSE", "Flux service returned an invalid failure envelope.", false, undefined, undefined, safeRequestId);
      const diagnostic = parseFluxDiagnostic(failure.diagnostic);
      const safeDiagnostic = diagnostic.state === "valid" ? diagnostic.diagnostic : undefined;
      let terminalFailureReceipt: FluxTerminalFailureReceiptDto | undefined;
      try { terminalFailureReceipt = await parseTerminalFailureReceipt(failure.terminalFailureReceipt, safeDiagnostic, dependencies.crypto ?? browserCrypto()); } catch { terminalFailureReceipt = undefined; }
      throw new FluxApiError(safeCode, staticFailureMessage(safeCode, response.status), failure.retryable, safeDiagnostic, terminalFailureReceipt, safeRequestId);
    }
    if (envelope === undefined || !exactKeys(envelope, ["ok", "operation", "requestId", "result"]) || envelope.ok !== true || typeof envelope.operation !== "string" || !operationPattern.test(envelope.operation) || safeRequestId === undefined) throw new FluxApiError("INVALID_RESPONSE", "Flux service returned an invalid success envelope.", false, undefined, undefined, safeRequestId);
    return envelope.result as Result;
  };

  const intent = async (operation: string, body: unknown): Promise<PendingIntent> => {
    if (intentStorageUnsafe) throw new FluxIntentStorageError("Durable browser operation storage is unsafe. Explicit reset is required before another mutation.");
    const cryptoPort = dependencies.crypto ?? browserCrypto(); const storageKey = await storageKeyFor(operation, body, cryptoPort); auditStoredIntents(storageKey); const parsed = parseStoredIntent(read(storageKey));
    if (parsed.state === "malformed") return lock("A corrupt or version-mismatched durable browser intent was found. Mutations are locked until explicit reset.");
    const idempotencyKey = parsed.state === "valid" && parsed.value.state === "pending" ? parsed.value.idempotencyKey : newIdempotencyKey(cryptoPort);
    write(storageKey, storedIntent("pending", idempotencyKey));
    return { storageKey, idempotencyKey };
  };
  const consume = (pending: PendingIntent): void => write(pending.storageKey, storedIntent("consumed", pending.idempotencyKey), true);
  const terminalReceiptMatches = async (error: FluxApiError, pending: PendingIntent, binding: TerminalFailureBinding | undefined): Promise<boolean> => {
    const receipt = error.terminalFailureReceipt;
    if (binding === undefined || error.retryable || error.diagnostic === undefined || receipt === undefined || receipt.operation !== binding.operation || receipt.idempotencyKey !== pending.idempotencyKey || receipt.runId !== binding.runId || receipt.projectId !== binding.run.projectId || receipt.threadId !== binding.run.threadId) return false;
    return receipt.requestDigest === await sha256Canonical(binding.request, dependencies.crypto ?? browserCrypto());
  };
  const post = async <Result>(url: string, operation: string, body: unknown, signal?: AbortSignal, terminalBinding?: TerminalFailureBinding): Promise<Result> => {
    const pending = await intent(operation, { url, body });
    try {
      const result = await request<Result>(url, { method: "POST", headers: { "Idempotency-Key": pending.idempotencyKey }, body: JSON.stringify(body) }, signal);
      consume(pending); return result;
    } catch (error) {
      if (error instanceof FluxApiError && await terminalReceiptMatches(error, pending, terminalBinding)) consume(pending);
      throw error;
    }
  };

  const createRun = async (input: FluxCreateInput, policy: FluxRuntimePolicyDto, signal?: AbortSignal): Promise<FluxRunDto> => {
    const iterationCapPolicy = parseFluxIterationCapPolicy(policy.iterationCap);
    if (iterationCapPolicy === undefined) throw new Error("The server iteration-cap policy is missing, malformed, or does not authorize the selected value; no create request was sent.");
    const iterationCap = iterationCapFromBounds(iterationCapPolicy, input.iterationCap);
    if (intentStorageUnsafe) throw new FluxIntentStorageError("Durable browser operation storage is unsafe. Explicit reset is required before another mutation.");
    const cryptoPort = dependencies.crypto ?? browserCrypto();
    const authority = { providerModel: { provider: policy.providerModel.provider, model: policy.providerModel.model, tier: policy.providerModel.tier }, iterationCapPolicy, harnessRuleIdentity: policy.harnessRuleIdentity, mutationAllowlist: [...policy.mutationAllowlist], freshAcceptanceProfileIdentity: policy.freshAcceptanceProfileIdentity, freshPersistenceProfileIdentity: policy.freshPersistenceProfileIdentity };
    const storageKey = await storageKeyFor("create-transaction", { input: { sourceKey: input.sourceKey, projectName: input.projectName, threadTitle: input.threadTitle, prompt: input.prompt, iterationCap }, authority }, cryptoPort);
    auditStoredIntents(storageKey);
    const parsed = parseCreateTransaction(read(storageKey));
    if (parsed.state === "malformed") return lock("A corrupt or version-mismatched create transaction was found. Mutations are locked until explicit reset.");
    let transaction = parsed.state === "valid" && parsed.value.state === "pending" ? parsed.value : createTransaction(cryptoPort);
    if (parsed.state !== "valid" || parsed.value.state === "consumed") write(storageKey, transaction);
    if (transaction.project.result !== null && (transaction.project.result.sourceKey !== input.sourceKey || transaction.project.result.name !== input.projectName)) return lock("The durable create transaction does not match its project request. Explicit reset is required.");
    let project: FluxProjectDto;
    if (transaction.project.state === "completed") project = transaction.project.result!;
    else {
      const result = await request<FluxProjectDto>("/api/v1/flux/projects", { method: "POST", headers: { "Idempotency-Key": transaction.project.idempotencyKey }, body: JSON.stringify({ sourceKey: input.sourceKey, name: input.projectName }) }, signal);
      const projected = storedProjectResult(result); if (projected === undefined || projected.sourceKey !== input.sourceKey || projected.name !== input.projectName) return lock("The project response did not match the durable create transaction. Explicit reset is required.");
      project = result;
      transaction = { ...transaction, project: { ...transaction.project, state: "completed", result: projected }, thread: { ...transaction.thread, state: "pending" } };
      write(storageKey, transaction, true);
    }
    if (transaction.thread.result !== null && (transaction.thread.result.projectId !== project.id || transaction.thread.result.title !== input.threadTitle)) return lock("The durable create transaction does not match its thread request. Explicit reset is required.");
    let thread: FluxThreadDto;
    if (transaction.thread.state === "completed") thread = transaction.thread.result!;
    else {
      const result = await request<FluxThreadDto>(`/api/v1/flux/projects/${encoded(project.id)}/threads`, { method: "POST", headers: { "Idempotency-Key": transaction.thread.idempotencyKey }, body: JSON.stringify({ title: input.threadTitle }) }, signal);
      const projected = storedThreadResult(result); if (projected === undefined || projected.projectId !== project.id || projected.title !== input.threadTitle) return lock("The thread response did not match the durable create transaction. Explicit reset is required.");
      thread = result;
      transaction = { ...transaction, thread: { ...transaction.thread, state: "completed", result: projected }, run: { ...transaction.run, state: "pending" } };
      write(storageKey, transaction, true);
    }
    const runBody = { projectId: project.id, threadId: thread.id, prompt: input.prompt, providerModel: authority.providerModel, iterationCap, harnessRuleIdentity: authority.harnessRuleIdentity, mutationAllowlist: authority.mutationAllowlist, freshAcceptanceProfileIdentity: authority.freshAcceptanceProfileIdentity, freshPersistenceProfileIdentity: authority.freshPersistenceProfileIdentity, workflowKind: "generic" as const };
    const result = await request<FluxRunDto>("/api/v1/flux/runs", { method: "POST", headers: { "Idempotency-Key": transaction.run.idempotencyKey }, body: JSON.stringify(runBody) }, signal);
    const projected = storedRunResult({ id: result.id, projectId: result.projectId, threadId: result.threadId }); if (projected === undefined || projected.projectId !== project.id || projected.threadId !== thread.id) return lock("The run response did not match the durable create transaction. Explicit reset is required.");
    transaction = { ...transaction, state: "consumed", run: { ...transaction.run, state: "completed", result: projected } };
    write(storageKey, transaction, true);
    return result;
  };

  return {
    resetBrowserIntents() {
      const port = storage();
      try { for (const key of new Set([...namespaceKeys(port), ...resetKeys])) { port.removeItem(key); if (port.getItem(key) !== null) throw new Error("intent was not removed"); } intentStorageUnsafe = false; resetKeys.clear(); }
      catch { intentStorageUnsafe = true; throw new FluxIntentStorageError("Browser intent reset failed. Mutations remain locked."); }
    },
    readiness: (signal) => request<FluxRuntimeReadinessDto>("/api/v1/flux/readiness", {}, signal),
    policy: (signal) => request<FluxRuntimePolicyDto>("/api/v1/flux/policy", {}, signal),
    sources: (signal) => request<readonly FluxSourceCatalogDto[]>("/api/v1/flux/sources", {}, signal),
    projects: async (signal) => (await request<{ projects: readonly FluxProjectDto[] }>("/api/v1/flux/projects", {}, signal)).projects,
    runs: async (signal) => (await request<{ runs: readonly FluxRunDto[] }>("/api/v1/flux/runs", {}, signal)).runs,
    createRun,
    getRun: (runId, signal) => request<FluxRunDto>(`/api/v1/flux/runs/${encoded(runId)}`, {}, signal),
    interpret: (runId, signal, binding) => post<FluxRunDto>(`/api/v1/flux/runs/${encoded(runId)}/interpret`, "interpret", {}, signal, binding === undefined ? undefined : { operation: "interpret_run", request: { runId, answers: [] }, runId, run: binding }),
    clarifications: (runId, answers, signal, binding) => {
      const normalizedAnswers = answers.map((answer) => ({ id: answer.id.trim(), answer: answer.answer.trim() }));
      return post<FluxRunDto>(`/api/v1/flux/runs/${encoded(runId)}/clarifications`, "clarifications", { answers }, signal, binding === undefined ? undefined : { operation: "clarify_run", request: { runId, answers: normalizedAnswers }, runId, run: binding });
    },
    contract: (runId, signal) => request<FluxContractStateDto>(`/api/v1/flux/runs/${encoded(runId)}/contract`, {}, signal),
    prepare: (runId, signal) => post<FluxRunDto>(`/api/v1/flux/runs/${encoded(runId)}/prepare`, "prepare", {}, signal),
    poll: (runId, afterEventSeq, signal) => request<FluxPollResult>(`/api/v1/flux/runs/${encoded(runId)}/poll?afterEventSeq=${afterEventSeq}`, {}, signal),
    approvalSubject: (runId, signal) => request<FluxApprovalSubjectDto>(`/api/v1/flux/runs/${encoded(runId)}/approval`, {}, signal),
    approve: (runId, digestValue, signal) => post<FluxRunDto>(`/api/v1/flux/runs/${encoded(runId)}/approval`, "approve", { subjectDigest: digestValue }, signal),
    resume: (runId, signal) => post<FluxRunDto>(`/api/v1/flux/runs/${encoded(runId)}/resume`, "resume", {}, signal),
    open: (projectId, runId, signal) => post<FluxOpenResult>(`/api/v1/flux/projects/${encoded(projectId)}/open`, "open", runId === undefined ? {} : { runId }, signal),
    checkpointOpen: (runId, signal) => post<FluxRunDto>(`/api/v1/flux/runs/${encoded(runId)}/checkpoint-open`, "checkpoint-open", {}, signal),
    preview: (runId, signal) => request<FluxPreviewDto>(`/api/v1/flux/runs/${encoded(runId)}/preview`, {}, signal),
    refreshPreview: (runId, signal) => post<FluxPreviewDto>(`/api/v1/flux/runs/${encoded(runId)}/preview/refresh`, "preview-refresh", {}, signal),
    inspector: (signal) => request<FluxInspectorSnapshot>("/api/v1/flux/inspect", {}, signal),
    inspect: (signal) => post<FluxInspectorSnapshot>("/api/v1/flux/inspect", "inspect", {}, signal),
    previewUrl: (runId: string, kind: FluxPreviewKind) => `/api/v1/flux/runs/${encoded(runId)}/preview/${kind}`,
  };
};

export const fluxApi: FluxApi = createFluxApi();
