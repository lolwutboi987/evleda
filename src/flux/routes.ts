import { createHash } from "node:crypto";
import { open, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { DomainError } from "../domain/errors.js";
import { canonicalIdentity, canonicalJson } from "../core/canonical.js";
import { hardenPortableValue } from "../core/portable-artifact.js";
import { parseFluxDiagnostic, type FluxDiagnosticDto } from "../domain/diagnostics.js";
import { PCB_AGENT_MAX_FRESH_ITERATIONS, PCB_AGENT_MIN_ITERATIONS, PCB_AGENT_RECOMMENDED_FRESH_ITERATIONS } from "../harness/pcb-agent-harness.js";
import { isPathWithin } from "../integrations/path-boundary.js";
import { FLUX_REQUEST_ID_PATTERN, FLUX_TERMINAL_FAILURE_DIAGNOSTIC_SCHEMA_VERSION, FLUX_TERMINAL_FAILURE_RECEIPT_SCHEMA_VERSION, fluxDigest, FluxError, type FluxClarificationAnswerDto, type FluxContractStateDto, type FluxCreateRunInput, type FluxEventDto, type FluxOpenResult, type FluxProjectDto, type FluxQueueSnapshot, type FluxRunDto, type FluxRuntimePolicyDto, type FluxSourceCatalogDto, type FluxTerminalFailureReceiptDto, type FluxThreadDto } from "./contracts.js";
import { FLUX_CHECKPOINT_FAILURE_RECEIPT_SCHEMA_VERSION, FLUX_CHECKPOINT_FAILURE_SCHEMA_VERSION, FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE, FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE, type FluxCheckpointFailureReceiptDto } from "./contracts.js";
import { projectFluxInspectorSnapshot, type FluxInspectorSnapshot } from "./inspector.js";
import { projectFluxApprovalSubjectResult, projectFluxContractStateDto, projectFluxPollResult, projectFluxRunDto } from "./public-projection.js";

export const FLUX_API_PREFIX = "/api/v1/flux";
export const FLUX_PREVIEW_KINDS = ["schematic", "pcb_top", "pcb_bottom"] as const;
export type FluxPreviewKind = (typeof FLUX_PREVIEW_KINDS)[number];

const PREVIEW_FILES: Readonly<Record<FluxPreviewKind, { readonly name: string; readonly mediaType: "image/svg+xml" | "image/png" }>> = Object.freeze({
  schematic: { name: "schematic.svg", mediaType: "image/svg+xml" },
  pcb_top: { name: "board-top.png", mediaType: "image/png" },
  pcb_bottom: { name: "board-bottom.png", mediaType: "image/png" },
});

/**
 * This is deliberately a private runtime manifest.  The response projection
 * below never exposes root or relativePath to a browser.
 */
export interface FluxPreviewAssetBinding {
  readonly kind: FluxPreviewKind;
  readonly relativePath: string;
  readonly mediaType: "image/svg+xml" | "image/png";
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface FluxPreviewManifestBinding {
  readonly root: string;
  readonly artifacts: readonly FluxPreviewAssetBinding[];
  readonly refreshedAt: string;
}

export interface FluxRouteManager {
  initialize(): Promise<void>;
  sources(): Promise<readonly FluxSourceCatalogDto[]>;
  projects(): Promise<readonly FluxProjectDto[]>;
  threads(projectId: string): Promise<readonly FluxThreadDto[]>;
  runs(projectId?: string, threadId?: string): Promise<readonly FluxRunDto[]>;
  createProject(sourceKey: string, name: string, idempotencyKey?: string): Promise<FluxProjectDto>;
  createThread(projectId: string, title: string, idempotencyKey?: string): Promise<FluxThreadDto>;
  createRun(input: FluxCreateRunInput, idempotencyKey?: string): Promise<FluxRunDto>;
  interpretRun(runId: string, idempotencyKey?: string): Promise<FluxRunDto>;
  clarifyRun(runId: string, answers: readonly FluxClarificationAnswerDto[], idempotencyKey?: string): Promise<FluxRunDto>;
  contract(runId: string): Promise<FluxContractStateDto>;
  prepareRun(runId: string, idempotencyKey?: string): Promise<FluxRunDto>;
  approvalSubject(runId: string): Promise<Readonly<{ readonly subject: unknown; readonly digest: string }>>;
  approveRun(runId: string, presentedDigest: string, idempotencyKey?: string): Promise<FluxRunDto>;
  resumeRun(runId: string, idempotencyKey?: string): Promise<FluxRunDto>;
  checkpointOpenRun(runId: string, idempotencyKey?: string): Promise<FluxRunDto>;
  open(projectId: string, runId?: string, idempotencyKey?: string): Promise<FluxOpenResult>;
  queueSnapshot(): Promise<FluxQueueSnapshot>;
  getRun(runId: string): Promise<FluxRunDto>;
  events(): Promise<readonly FluxEventDto[]>;
}

export interface FluxRoutePorts {
  /** Resolves the current, runtime-private preview manifest for a run. */
  readonly preview?: {
    get(runId: string): Promise<FluxPreviewManifestBinding>;
    refresh(runId: string): Promise<FluxPreviewManifestBinding>;
  };
  /** Read-only inspector capability.  Its implementation owns its session. */
  readonly inspector?: {
    snapshot(runId: string): FluxInspectorSnapshot | Promise<FluxInspectorSnapshot>;
    inspect(runId: string, idempotencyKey: string): Promise<FluxInspectorSnapshot>;
  };
}

export interface FluxRoutesOptions {
  /** Omit while the production Flux runtime adapter is unavailable. */
  readonly manager?: FluxRouteManager;
  readonly ports?: FluxRoutePorts;
  readonly policy?: () => FluxRuntimePolicyDto;
}

type FluxSuccess<Result> = Readonly<{ readonly ok: true; readonly operation: string; readonly requestId: string; readonly result: Result }>;
type FluxFailure = Readonly<{ readonly ok: false; readonly requestId: string; readonly error: Readonly<{ readonly code: string; readonly message: string; readonly retryable: boolean; readonly details: Readonly<Record<string, unknown>>; readonly diagnostic?: FluxDiagnosticDto; readonly terminalFailureReceipt?: FluxTerminalFailureReceiptDto }> }>;

const comparable = (value: string): string => process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
const idPattern = /^[a-z][a-z0-9_-]{0,127}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;
const pathLike = /(?:^~[\\/]|^[A-Za-z]:[\\/]|^\\\\|^\/|^file:)/iu;

const sanitized = (value: unknown, depth = 0, key = ""): unknown => {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") { const text = value.trim(); const pointer = /^\/(?:[A-Za-z0-9_.~-]+(?:\/[A-Za-z0-9_.~-]+)*)?$/u.test(text) && ["id", "path", "clarificationId", "contractPath"].includes(key); return pathLike.test(text) && !pointer ? "[redacted path]" : value; }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map((entry) => sanitized(entry, depth + 1, key));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, entry]) => [childKey, sanitized(entry, depth + 1, childKey)]));
  }
  return String(value);
};

const requestIdFor = (request: FastifyRequest): string => {
  const value = String(request.id);
  return FLUX_REQUEST_ID_PATTERN.test(value) ? value : `request-${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
};

/** Legacy/untyped success surfaces retain defensive redaction. Typed Flux DTOs use projectedSuccess after exact closed validation. */
const sanitizedSuccess = <Result>(operation: string, request: FastifyRequest, result: Result): FluxSuccess<Result> => ({
  ok: true,
  operation,
  requestId: requestIdFor(request),
  result: sanitized(result) as Result,
});
const projectedSuccess = <Result>(operation: string, request: FastifyRequest, result: Result): FluxSuccess<Result> => ({ ok: true, operation, requestId: requestIdFor(request), result });

const routeError = (error: unknown): DomainError => {
  if (error instanceof DomainError) return error;
  if (error instanceof FluxError) {
    switch (error.code) {
      case "NOT_FOUND": return new DomainError("NOT_FOUND", error.message, sanitized(error.details) as Record<string, unknown>);
      case "IDEMPOTENCY_CONFLICT": return new DomainError("IDEMPOTENCY_CONFLICT", error.message, sanitized(error.details) as Record<string, unknown>);
      case "PATH_POLICY": return new DomainError("PATH_OUTSIDE_WORKSPACE", "Flux path policy rejected the request");
      case "ILLEGAL_TRANSITION":
      case "APPROVAL_MISMATCH":
      case "APPROVAL_CONSUMED": return new DomainError("STAGE_BLOCKED", error.message, sanitized(error.details) as Record<string, unknown>);
      default: return new DomainError("INVALID_ARGUMENT", error.message, sanitized(error.details) as Record<string, unknown>);
    }
  }
  return new DomainError("TOOLCHAIN_UNAVAILABLE", "Flux capability is unavailable", {}, true);
};

const statusFor = (error: DomainError): number => {
  switch (error.code) {
    case "INVALID_ARGUMENT": return 400;
    case "NOT_FOUND": return 404;
    case "IDEMPOTENCY_CONFLICT": return 409;
    case "STAGE_BLOCKED": return 422;
    case "PATH_OUTSIDE_WORKSPACE": return 403;
    case "TOOLCHAIN_UNAVAILABLE": return 503;
    default: return 500;
  }
};

const failureDiagnostic = (error: unknown): FluxDiagnosticDto | undefined => {
  if (!(error instanceof FluxError) || error.diagnostic === undefined) return undefined;
  try { return parseFluxDiagnostic(error.diagnostic); } catch { return undefined; }
};

const checkpointFailureReceipt = async (receipt: Record<string, unknown>, error: FluxError, request: FastifyRequest, manager: FluxRouteManager): Promise<FluxCheckpointFailureReceiptDto | undefined> => {
  const keys = ["schemaVersion", "operation", "idempotencyKey", "requestDigest", "projectId", "threadId", "runId", "failureIdentity", "terminalPhase", "outcome", "completedAt", "identity"];
  if (Object.keys(receipt).length !== keys.length || keys.some((key) => !Object.hasOwn(receipt, key)) ||
    receipt.schemaVersion !== FLUX_CHECKPOINT_FAILURE_RECEIPT_SCHEMA_VERSION || receipt.operation !== "checkpoint_open" ||
    typeof receipt.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/u.test(receipt.idempotencyKey) || request.headers["idempotency-key"] !== receipt.idempotencyKey ||
    typeof receipt.projectId !== "string" || !idPattern.test(receipt.projectId) || typeof receipt.threadId !== "string" || !idPattern.test(receipt.threadId) ||
    typeof receipt.runId !== "string" || !idPattern.test(receipt.runId) || receipt.requestDigest !== fluxDigest({ runId: receipt.runId }) ||
    receipt.terminalPhase !== "blocked" || receipt.outcome !== "failed" || typeof receipt.completedAt !== "string" ||
    Number.isNaN(Date.parse(receipt.completedAt)) || new Date(receipt.completedAt).toISOString() !== receipt.completedAt ||
    error.code !== "OPERATION_UNCERTAIN" || ![FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE, FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE].includes(error.message) ||
    Object.keys(error.details).length !== 0 || error.diagnostic !== undefined || request.method !== "POST" ||
    request.url.split("?", 1)[0] !== `${FLUX_API_PREFIX}/runs/${receipt.runId}/checkpoint-open` ||
    typeof request.body !== "object" || request.body === null || Array.isArray(request.body) || Object.keys(request.body).length !== 0) return undefined;
  const failureIdentity = canonicalIdentity({ code: error.code, message: error.message, details: {} }, FLUX_CHECKPOINT_FAILURE_SCHEMA_VERSION);
  if (canonicalJson(receipt.failureIdentity) !== canonicalJson(failureIdentity)) return undefined;
  const value = { schemaVersion: FLUX_CHECKPOINT_FAILURE_RECEIPT_SCHEMA_VERSION, operation: "checkpoint_open" as const,
    idempotencyKey: receipt.idempotencyKey, requestDigest: receipt.requestDigest as string, projectId: receipt.projectId, threadId: receipt.threadId, runId: receipt.runId,
    failureIdentity, terminalPhase: "blocked" as const, outcome: "failed" as const, completedAt: receipt.completedAt };
  const identity = canonicalIdentity(value, FLUX_CHECKPOINT_FAILURE_RECEIPT_SCHEMA_VERSION);
  if (canonicalJson(receipt.identity) !== canonicalJson(identity)) return undefined;
  const run = await manager.getRun(receipt.runId);
  if (run.id !== receipt.runId || run.projectId !== receipt.projectId || run.threadId !== receipt.threadId || run.phase !== "blocked" ||
    run.checkpointRequired !== true || run.updatedAt !== receipt.completedAt || run.blockedReason !== error.message || run.diagnostic !== undefined || run.approval !== undefined) return undefined;
  return { ...value, identity };
};

const terminalFailureReceipt = async (error: unknown, diagnostic: FluxDiagnosticDto | undefined, request: FastifyRequest, manager: FluxRouteManager | undefined): Promise<FluxTerminalFailureReceiptDto | undefined> => {
  if (!(error instanceof FluxError) || error.terminalFailureReceipt === undefined || manager === undefined) return undefined;
  try {
    const hardened = hardenPortableValue(error.terminalFailureReceipt, { maxBytes: 16 * 1024, maxDepth: 12, maxNodes: 256, maxArrayLength: 16, maxOwnKeys: 32, maxKeyBytes: 128, maxStringBytes: 1024 });
    if (typeof hardened !== "object" || hardened === null || Array.isArray(hardened)) return undefined;
    const receipt = hardened as Record<string, unknown>;
    if (receipt.schemaVersion === FLUX_CHECKPOINT_FAILURE_RECEIPT_SCHEMA_VERSION) return await checkpointFailureReceipt(receipt, error, request, manager);
    if (diagnostic === undefined) return undefined;
    const keys = ["schemaVersion", "operation", "idempotencyKey", "requestDigest", "projectId", "threadId", "runId", "diagnosticIdentity", "terminalPhase", "outcome", "completedAt", "identity"] as const;
    if (Object.keys(receipt).length !== keys.length || keys.some((key) => !Object.hasOwn(receipt, key)) ||
      receipt.schemaVersion !== FLUX_TERMINAL_FAILURE_RECEIPT_SCHEMA_VERSION || !["interpret_run", "clarify_run"].includes(String(receipt.operation)) ||
      typeof receipt.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/u.test(receipt.idempotencyKey) || request.headers["idempotency-key"] !== receipt.idempotencyKey ||
      typeof receipt.requestDigest !== "string" || !digestPattern.test(receipt.requestDigest) ||
      typeof receipt.projectId !== "string" || !idPattern.test(receipt.projectId) || typeof receipt.threadId !== "string" || !idPattern.test(receipt.threadId) ||
      typeof receipt.runId !== "string" || !idPattern.test(receipt.runId) || receipt.terminalPhase !== "blocked" || receipt.outcome !== "failed" ||
      typeof receipt.completedAt !== "string" || Number.isNaN(Date.parse(receipt.completedAt)) || new Date(receipt.completedAt).toISOString() !== receipt.completedAt) return undefined;
    const operation = receipt.operation as "interpret_run" | "clarify_run";
    const expectedPath = `${FLUX_API_PREFIX}/runs/${receipt.runId}/${operation === "interpret_run" ? "interpret" : "clarifications"}`;
    if (request.method !== "POST" || request.url.split("?", 1)[0] !== expectedPath) return undefined;
    const body = typeof request.body === "object" && request.body !== null && !Array.isArray(request.body) ? request.body as Record<string, unknown> : undefined;
    let answers: readonly FluxClarificationAnswerDto[];
    if (operation === "interpret_run") {
      if (body === undefined || Object.keys(body).length !== 0) return undefined;
      answers = [];
    } else {
      if (body === undefined || Object.keys(body).length !== 1 || !Object.hasOwn(body, "answers") || !Array.isArray(body.answers)) return undefined;
      const normalized: FluxClarificationAnswerDto[] = [];
      for (const item of body.answers) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
        const answer = item as Record<string, unknown>;
        if (Object.keys(answer).length !== 2 || !Object.hasOwn(answer, "id") || !Object.hasOwn(answer, "answer") || typeof answer.id !== "string" || typeof answer.answer !== "string") return undefined;
        normalized.push({ id: answer.id.trim(), answer: answer.answer.trim() });
      }
      if (normalized.some((item) => !item.id || !item.answer) || new Set(normalized.map((item) => item.id)).size !== normalized.length) return undefined;
      answers = normalized;
    }
    if (receipt.requestDigest !== fluxDigest({ runId: receipt.runId, answers })) return undefined;
    const expectedDiagnosticIdentity = canonicalIdentity(diagnostic, FLUX_TERMINAL_FAILURE_DIAGNOSTIC_SCHEMA_VERSION);
    if (canonicalJson(receipt.diagnosticIdentity) !== canonicalJson(expectedDiagnosticIdentity)) return undefined;
    const value = {
      schemaVersion: FLUX_TERMINAL_FAILURE_RECEIPT_SCHEMA_VERSION,
      operation,
      idempotencyKey: receipt.idempotencyKey,
      requestDigest: receipt.requestDigest,
      projectId: receipt.projectId,
      threadId: receipt.threadId,
      runId: receipt.runId,
      diagnosticIdentity: expectedDiagnosticIdentity,
      terminalPhase: "blocked" as const,
      outcome: "failed" as const,
      completedAt: receipt.completedAt,
    };
    const identity = canonicalIdentity(value, FLUX_TERMINAL_FAILURE_RECEIPT_SCHEMA_VERSION);
    if (canonicalJson(receipt.identity) !== canonicalJson(identity)) return undefined;
    const boundRun = await manager.getRun(receipt.runId);
    if (boundRun.projectId !== receipt.projectId || boundRun.threadId !== receipt.threadId || boundRun.phase !== "blocked" || boundRun.updatedAt !== receipt.completedAt ||
      boundRun.diagnostic === undefined || canonicalJson(parseFluxDiagnostic(boundRun.diagnostic)) !== canonicalJson(diagnostic)) return undefined;
    return { ...value, identity };
  } catch { return undefined; }
};

const failure = async (reply: FastifyReply, error: unknown, request: FastifyRequest, manager?: FluxRouteManager): Promise<FastifyReply> => {
  const diagnostic = failureDiagnostic(error);
  const terminalReceipt = await terminalFailureReceipt(error, diagnostic, request, manager);
  if (error instanceof FluxError && error.code === "OPEN_PREFLIGHT_FAILED") {
    const result: FluxFailure = { ok: false, requestId: requestIdFor(request), error: { code: "OPEN_PREFLIGHT_FAILED", message: error.message, retryable: true, details: {} } };
    return reply.code(503).send(result);
  }
  if (error instanceof FluxError && error.code === "EVIDENCE_CAPACITY") {
    const result: FluxFailure = { ok: false, requestId: requestIdFor(request), error: { code: "EVIDENCE_CAPACITY", message: error.message, retryable: true, details: {} } };
    return reply.code(503).send(result);
  }
  if (error instanceof FluxError && error.code === "OPERATION_UNCERTAIN") {
    const result: FluxFailure = { ok: false, requestId: requestIdFor(request), error: { code: "OPERATION_UNCERTAIN", message: error.message, retryable: false, details: sanitized(error.details) as Record<string, unknown>,
      ...(diagnostic === undefined ? {} : { diagnostic }), ...(terminalReceipt === undefined ? {} : { terminalFailureReceipt: terminalReceipt }) } };
    return reply.code(409).send(result);
  }
  const mapped = routeError(error);
  const result: FluxFailure = {
    ok: false,
    requestId: requestIdFor(request),
    error: { code: mapped.code, message: mapped.message, retryable: mapped.retryable, details: sanitized(mapped.details) as Record<string, unknown>,
      ...(diagnostic === undefined ? {} : { diagnostic }), ...(terminalReceipt === undefined ? {} : { terminalFailureReceipt: terminalReceipt }) },
  };
  return reply.code(statusFor(mapped)).send(result);
};

const bodyObject = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new DomainError("INVALID_ARGUMENT", "Expected one JSON object request body");
  return value as Record<string, unknown>;
};

const closedBody = (value: unknown, allowed: readonly string[]): Record<string, unknown> => {
  const body = bodyObject(value);
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key)).sort();
  if (unknown.length > 0) throw new DomainError("INVALID_ARGUMENT", "Request contains unknown body fields", { unknownFields: unknown, allowedFields: [...allowed] });
  return body;
};

const stringField = (body: Record<string, unknown>, key: string): string => {
  const value = body[key];
  if (typeof value !== "string" || !value.trim() || value.length > 16_384 || value.includes("\0")) throw new DomainError("INVALID_ARGUMENT", `${key} must be a non-empty string`);
  return value.trim();
};

const runtimePolicy = (input: unknown): FluxRuntimePolicyDto => {
  let snapshot: unknown;
  try { snapshot = hardenPortableValue(input, { maxBytes: 128 * 1024, maxDepth: 12, maxNodes: 4_096, maxArrayLength: 512, maxOwnKeys: 64, maxKeyBytes: 256, maxStringBytes: 32 * 1024 }); }
  catch { throw new DomainError("INVALID_ARGUMENT", "Flux runtime policy is not bounded plain JSON"); }
  const policy = closedBody(snapshot, ["providerModel", "iterationCap", "harnessRuleIdentity", "mutationAllowlist", "freshProjectNamePattern", "checkpointOpenRequiredForFresh", "freshAcceptanceProfileIdentity", "freshPersistenceProfileIdentity"]);
  const provider = closedBody(policy.providerModel, ["provider", "model", "tier"]);
  const iterationCap = closedBody(policy.iterationCap, ["minimum", "maximum", "recommended"]);
  if (iterationCap.minimum !== PCB_AGENT_MIN_ITERATIONS || iterationCap.maximum !== PCB_AGENT_MAX_FRESH_ITERATIONS || iterationCap.recommended !== PCB_AGENT_RECOMMENDED_FRESH_ITERATIONS) {
    throw new DomainError("INVALID_ARGUMENT", "Flux runtime iteration policy does not match the executable harness bounds");
  }
  if (!Array.isArray(policy.mutationAllowlist) || policy.mutationAllowlist.some((entry) => typeof entry !== "string" || !/^[a-z][a-z0-9_]{0,127}$/u.test(entry))) throw new DomainError("INVALID_ARGUMENT", "Flux runtime mutation policy is invalid");
  const mutationAllowlist = policy.mutationAllowlist as string[];
  const canonicalMutationAllowlist = [...new Set(mutationAllowlist)].sort();
  if (canonicalMutationAllowlist.length !== mutationAllowlist.length || mutationAllowlist.some((entry, index) => entry !== canonicalMutationAllowlist[index])) {
    throw new DomainError("INVALID_ARGUMENT", "Flux runtime mutation policy must be lexicographically sorted and duplicate-free");
  }
  if (policy.freshProjectNamePattern !== "^[a-z][a-z0-9-]{0,63}$" || policy.checkpointOpenRequiredForFresh !== true) throw new DomainError("INVALID_ARGUMENT", "Flux runtime project policy is invalid");
  return Object.freeze({
    providerModel: Object.freeze({ provider: stringField(provider, "provider"), model: stringField(provider, "model"), tier: stringField(provider, "tier") }),
    iterationCap: Object.freeze({ minimum: PCB_AGENT_MIN_ITERATIONS, maximum: PCB_AGENT_MAX_FRESH_ITERATIONS, recommended: PCB_AGENT_RECOMMENDED_FRESH_ITERATIONS }),
    harnessRuleIdentity: stringField(policy, "harnessRuleIdentity"),
    mutationAllowlist: Object.freeze([...mutationAllowlist]),
    freshProjectNamePattern: "^[a-z][a-z0-9-]{0,63}$",
    checkpointOpenRequiredForFresh: true,
    freshAcceptanceProfileIdentity: stringField(policy, "freshAcceptanceProfileIdentity"),
    freshPersistenceProfileIdentity: stringField(policy, "freshPersistenceProfileIdentity")
  });
};

const identifier = (value: string, name: string): string => {
  if (!idPattern.test(value)) throw new DomainError("INVALID_ARGUMENT", `${name} is not a safe Flux identifier`);
  return value;
};

const idempotencyKey = (request: FastifyRequest): string => {
  const raw = request.headers["idempotency-key"];
  const value = typeof raw === "string" ? raw : undefined;
  if (value === undefined || !/^[A-Za-z0-9._:-]{1,200}$/u.test(value)) throw new DomainError("INVALID_ARGUMENT", "Flux POST requests require exactly one canonical Idempotency-Key header");
  return value;
};

const closedQuery = (value: unknown, allowed: readonly string[]): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new DomainError("INVALID_ARGUMENT", "Query parameters must form one object");
  const query = value as Record<string, unknown>;
  const unknown = Object.keys(query).filter((key) => !allowed.includes(key)).sort();
  if (unknown.length > 0) throw new DomainError("INVALID_ARGUMENT", "Request contains unknown query parameters", { unknownParameters: unknown, allowedParameters: [...allowed] });
  return query;
};

const afterEventSeq = (query: Record<string, unknown>): number => {
  const raw = query.afterEventSeq;
  if (raw === undefined) return 0;
  if (typeof raw !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(raw)) throw new DomainError("INVALID_ARGUMENT", "afterEventSeq must be a canonical non-negative base-10 integer");
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new DomainError("INVALID_ARGUMENT", "afterEventSeq is too large");
  return parsed;
};

const assertNoQuery = (request: FastifyRequest): void => { closedQuery(request.query, []); };

const managerOrUnavailable = (manager: FluxRouteManager | undefined): FluxRouteManager => {
  if (manager === undefined) throw new DomainError("TOOLCHAIN_UNAVAILABLE", "Flux runtime capability is not configured", {}, true);
  return manager;
};

const previewPublic = (manifest: FluxPreviewManifestBinding) => ({
  refreshedAt: manifest.refreshedAt,
  artifacts: manifest.artifacts.map((entry) => ({ kind: entry.kind, mediaType: entry.mediaType, sizeBytes: entry.sizeBytes, sha256: entry.sha256 })),
});

const previewBinding = (manifest: FluxPreviewManifestBinding, kind: FluxPreviewKind): FluxPreviewAssetBinding => {
  if (!manifest.root.trim()) throw new DomainError("PATH_OUTSIDE_WORKSPACE", "Preview manifest failed path policy");
  const matches = manifest.artifacts.filter((entry) => entry.kind === kind);
  if (matches.length !== 1) throw new DomainError("NOT_FOUND", "Preview kind is not bound by the current manifest");
  const entry = matches[0]!;
  const expected = PREVIEW_FILES[kind];
  if (entry.relativePath !== expected.name || entry.mediaType !== expected.mediaType || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 || !digestPattern.test(entry.sha256)) {
    throw new DomainError("PATH_OUTSIDE_WORKSPACE", "Preview manifest failed integrity policy");
  }
  return entry;
};

const previewBytes = async (manifest: FluxPreviewManifestBinding, binding: FluxPreviewAssetBinding): Promise<Buffer> => {
  const lexicalRoot = path.resolve(manifest.root);
  const rootMetadata = await lstat(lexicalRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new DomainError("PATH_OUTSIDE_WORKSPACE", "Preview root is not an ordinary directory");
  const root = await realpath(lexicalRoot);
  if (comparable(root) !== comparable(lexicalRoot)) throw new DomainError("PATH_OUTSIDE_WORKSPACE", "Preview root resolves through a link");
  const candidate = path.resolve(root, binding.relativePath);
  if (!isPathWithin(root, candidate, false)) throw new DomainError("PATH_OUTSIDE_WORKSPACE", "Preview file escapes its bound root");
  const before = await lstat(candidate);
  if (!before.isFile() || before.isSymbolicLink()) throw new DomainError("PATH_OUTSIDE_WORKSPACE", "Preview file is not an ordinary regular file");
  const resolved = await realpath(candidate);
  if (!isPathWithin(root, resolved, false) || comparable(resolved) !== comparable(candidate)) throw new DomainError("PATH_OUTSIDE_WORKSPACE", "Preview file resolves through a link");
  const handle = await open(resolved, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size !== binding.sizeBytes) throw new DomainError("DIGEST_MISMATCH", "Preview size no longer matches its manifest");
    const bytes = await handle.readFile();
    if (bytes.byteLength !== binding.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== binding.sha256) throw new DomainError("DIGEST_MISMATCH", "Preview bytes no longer match their manifest");
    return bytes;
  } finally {
    await handle.close();
  }
};

  /** Mount the candidate-only Flux API. It intentionally has no generic file route. */
export const registerFluxRoutes = async (app: FastifyInstance, options: FluxRoutesOptions = {}): Promise<void> => {
  const withManager = async <Result>(request: FastifyRequest, reply: FastifyReply, operation: string, action: (manager: FluxRouteManager) => Promise<Result>, projector?: (value: Result) => unknown): Promise<FastifyReply> => {
    let manager: FluxRouteManager | undefined;
    try {
      closedQuery(request.query, request.url.split("?", 1)[0]?.endsWith("/poll") ? ["afterEventSeq"] : []);
      manager = managerOrUnavailable(options.manager);
      await manager.initialize();
      const result = await action(manager);
      return reply.send(projector === undefined ? sanitizedSuccess(operation, request, result) : projectedSuccess(operation, request, projector(result)));
    } catch (error) {
      return failure(reply, error, request, manager);
    }
  };
  const inspectionAuthority = async (manager: FluxRouteManager, runId: string) => {
    const run = await manager.getRun(runId);
    if (!["awaiting_approval", "approved", "completed", "needs_review", "failed", "blocked"].includes(run.phase)) throw new FluxError("ILLEGAL_TRANSITION", "Run does not have stable Open, socket, and checkpoint authority for inspection");
    return projectFluxApprovalSubjectResult(await manager.approvalSubject(runId));
  };
  const bindInspectionSnapshot = (value: unknown, runId: string, approval: ReturnType<typeof projectFluxApprovalSubjectResult>): FluxInspectorSnapshot => {
    const snapshot = projectFluxInspectorSnapshot(value); const subject = approval.subject;
    if (snapshot.runId !== runId || canonicalJson(snapshot.inspectionBridgeIdentity) !== canonicalJson(subject.inspectionBridgeIdentity) || canonicalJson(snapshot.executionBridgeIdentity) !== canonicalJson(subject.executionBridgeIdentity) ||
      canonicalJson(snapshot.ipcSocketIdentity) !== canonicalJson(subject.ipcSocketIdentity) || canonicalJson(snapshot.writeSessionAuthorityIdentity) !== canonicalJson(subject.writeSessionAuthorityIdentity)) {
      throw new FluxError("APPROVAL_MISMATCH", "Inspection response does not bind the run's exact approved bridge, socket, and write-session authority");
    }
    return snapshot;
  };

  app.get(`${FLUX_API_PREFIX}/sources`, (request, reply) => withManager(request, reply, "flux_sources", (manager) => manager.sources()));
  app.get(`${FLUX_API_PREFIX}/policy`, async (request, reply) => { try { assertNoQuery(request); if (options.policy === undefined) throw new DomainError("TOOLCHAIN_UNAVAILABLE", "Flux runtime policy is not configured", {}, true); return reply.send(sanitizedSuccess("flux_policy", request, runtimePolicy(options.policy()))); } catch (error) { return failure(reply, error, request); } });
  app.get(`${FLUX_API_PREFIX}/projects`, (request, reply) => withManager(request, reply, "flux_projects", async (manager) => ({ projects: await manager.projects() })));
  app.post(`${FLUX_API_PREFIX}/projects`, (request, reply) => withManager(request, reply, "flux_create_project", async (manager) => {
    const body = closedBody(request.body, ["sourceKey", "name"]);
    return manager.createProject(stringField(body, "sourceKey"), stringField(body, "name"), idempotencyKey(request));
  }));
  app.post<{ Params: { projectId: string } }>(`${FLUX_API_PREFIX}/projects/:projectId/threads`, (request, reply) => withManager(request, reply, "flux_create_thread", async (manager) => {
    const body = closedBody(request.body, ["title"]);
    return manager.createThread(identifier(request.params.projectId, "projectId"), stringField(body, "title"), idempotencyKey(request));
  }));
  app.get<{ Params: { projectId: string } }>(`${FLUX_API_PREFIX}/projects/:projectId/threads`, (request, reply) => withManager(request, reply, "flux_threads", async (manager) => ({ threads: await manager.threads(identifier(request.params.projectId, "projectId")) })));
  app.get<{ Params: { projectId: string } }>(`${FLUX_API_PREFIX}/projects/:projectId/runs`, (request, reply) => withManager(request, reply, "flux_project_runs", async (manager) => ({ runs: await manager.runs(identifier(request.params.projectId, "projectId")) }), (value) => ({ runs: value.runs.map(projectFluxRunDto) })));
  app.post(`${FLUX_API_PREFIX}/runs`, (request, reply) => withManager(request, reply, "flux_create_run", async (manager) => {
    const body = closedBody(request.body, ["projectId", "threadId", "prompt", "providerModel", "iterationCap", "harnessRuleIdentity", "mutationAllowlist", "freshAcceptanceProfileIdentity", "freshPersistenceProfileIdentity", "workflowKind"]);
    const provider = body.providerModel;
    if (typeof provider !== "object" || provider === null || Array.isArray(provider) || Object.keys(provider).length !== 3 || !["provider", "model", "tier"].every((key) => Object.hasOwn(provider, key))) throw new DomainError("INVALID_ARGUMENT", "providerModel must be a closed provider/model/tier object");
    const providerRecord = provider as Record<string, unknown>;
    const cap = body.iterationCap;
    if (!Number.isSafeInteger(cap) || (cap as number) < 1) throw new DomainError("INVALID_ARGUMENT", "iterationCap must be a positive integer");
    if (!Array.isArray(body.mutationAllowlist) || body.mutationAllowlist.some((entry) => typeof entry !== "string")) throw new DomainError("INVALID_ARGUMENT", "mutationAllowlist must be an array of strings");
    const input: FluxCreateRunInput = {
      projectId: identifier(stringField(body, "projectId"), "projectId"), threadId: identifier(stringField(body, "threadId"), "threadId"), prompt: stringField(body, "prompt"),
      providerModel: { provider: stringField(providerRecord, "provider"), model: stringField(providerRecord, "model"), tier: stringField(providerRecord, "tier") },
      iterationCap: cap as number, harnessRuleIdentity: stringField(body, "harnessRuleIdentity"), mutationAllowlist: body.mutationAllowlist.map((entry) => entry as string),
      freshAcceptanceProfileIdentity: stringField(body, "freshAcceptanceProfileIdentity"), freshPersistenceProfileIdentity: stringField(body, "freshPersistenceProfileIdentity"),
      workflowKind: body.workflowKind === undefined ? "generic" : stringField(body, "workflowKind") as FluxCreateRunInput["workflowKind"],
    };
    if (options.policy === undefined) throw new DomainError("TOOLCHAIN_UNAVAILABLE", "Flux runtime policy is not configured", {}, true);
    const activePolicy = runtimePolicy(options.policy());
    const providerPolicy = activePolicy.providerModel;
    if (input.providerModel.provider !== providerPolicy.provider || input.providerModel.model !== providerPolicy.model || input.providerModel.tier !== providerPolicy.tier) {
      throw new DomainError("INVALID_ARGUMENT", "providerModel must exactly match the active server policy");
    }
    if (input.iterationCap < activePolicy.iterationCap.minimum || input.iterationCap > activePolicy.iterationCap.maximum) {
      throw new DomainError("INVALID_ARGUMENT", `iterationCap must be from ${activePolicy.iterationCap.minimum} through ${activePolicy.iterationCap.maximum}`);
    }
    if (input.mutationAllowlist.length !== activePolicy.mutationAllowlist.length || input.mutationAllowlist.some((entry, index) => entry !== activePolicy.mutationAllowlist[index])) {
      throw new DomainError("INVALID_ARGUMENT", "mutationAllowlist must exactly match the canonical active server policy");
    }
    return manager.createRun(input, idempotencyKey(request));
  }, projectFluxRunDto));
  app.get<{ Params: { runId: string } }>(`${FLUX_API_PREFIX}/runs/:runId`, (request, reply) => withManager(request, reply, "flux_get_run", (manager) => manager.getRun(identifier(request.params.runId, "runId")), projectFluxRunDto));
  app.post<{ Params: { runId: string } }>(`${FLUX_API_PREFIX}/runs/:runId/interpret`, (request, reply) => withManager(request, reply, "flux_interpret", (manager) => { closedBody(request.body, []); return manager.interpretRun(identifier(request.params.runId, "runId"), idempotencyKey(request)); }, projectFluxRunDto));
  app.post<{ Params: { runId: string } }>(`${FLUX_API_PREFIX}/runs/:runId/clarifications`, (request, reply) => withManager(request, reply, "flux_clarify", (manager) => { const body = closedBody(request.body, ["answers"]); if (!Array.isArray(body.answers)) throw new DomainError("INVALID_ARGUMENT", "answers must be an array"); const answers = body.answers.map((entry): FluxClarificationAnswerDto => { const answer = closedBody(entry, ["id", "answer"]); return { id: stringField(answer, "id"), answer: stringField(answer, "answer") }; }); return manager.clarifyRun(identifier(request.params.runId, "runId"), answers, idempotencyKey(request)); }, projectFluxRunDto));
  app.get<{ Params: { runId: string } }>(`${FLUX_API_PREFIX}/runs/:runId/contract`, (request, reply) => withManager(request, reply, "flux_contract", async (manager) => { const run = await manager.getRun(identifier(request.params.runId, "runId")); if (run.contractState === undefined) throw new FluxError("ILLEGAL_TRANSITION", "Run has not produced a contract compilation"); return { state: run.contractState, workflowKind: run.workflowKind }; }, (value) => projectFluxContractStateDto(value.state, value.workflowKind)));
  app.get(`${FLUX_API_PREFIX}/runs`, (request, reply) => withManager(request, reply, "flux_runs", async (manager) => ({ runs: await manager.runs() }), (value) => ({ runs: value.runs.map(projectFluxRunDto) })));
  app.post<{ Params: { runId: string } }>(`${FLUX_API_PREFIX}/runs/:runId/prepare`, (request, reply) => withManager(request, reply, "flux_prepare", (manager) => { closedBody(request.body, []); return manager.prepareRun(identifier(request.params.runId, "runId"), idempotencyKey(request)); }, projectFluxRunDto));
  app.get<{ Params: { runId: string } }>(`${FLUX_API_PREFIX}/runs/:runId/approval`, (request, reply) => withManager(request, reply, "flux_approval_subject", (manager) => manager.approvalSubject(identifier(request.params.runId, "runId")), projectFluxApprovalSubjectResult));
  app.post<{ Params: { runId: string } }>(`${FLUX_API_PREFIX}/runs/:runId/approval`, (request, reply) => withManager(request, reply, "flux_approve", (manager) => { const body = closedBody(request.body, ["subjectDigest"]); return manager.approveRun(identifier(request.params.runId, "runId"), stringField(body, "subjectDigest"), idempotencyKey(request)); }, projectFluxRunDto));
  app.post<{ Params: { runId: string } }>(`${FLUX_API_PREFIX}/runs/:runId/resume`, (request, reply) => withManager(request, reply, "flux_resume", (manager) => { closedBody(request.body, []); return manager.resumeRun(identifier(request.params.runId, "runId"), idempotencyKey(request)); }, projectFluxRunDto));
  app.post<{ Params: { runId: string } }>(`${FLUX_API_PREFIX}/runs/:runId/checkpoint-open`, (request, reply) => withManager(request, reply, "flux_checkpoint_open", (manager) => { closedBody(request.body, []); return manager.checkpointOpenRun(identifier(request.params.runId, "runId"), idempotencyKey(request)); }, projectFluxRunDto));
  app.post<{ Params: { projectId: string } }>(`${FLUX_API_PREFIX}/projects/:projectId/open`, (request, reply) => withManager(request, reply, "flux_open", (manager) => { const body = closedBody(request.body, ["runId"]); const key = idempotencyKey(request); const runId = body.runId === undefined ? undefined : identifier(stringField(body, "runId"), "runId"); return manager.open(identifier(request.params.projectId, "projectId"), runId, key); }));
  app.get<{ Params: { runId: string }; Querystring: Record<string, unknown> }>(`${FLUX_API_PREFIX}/runs/:runId/poll`, (request, reply) => withManager(request, reply, "flux_poll", async (manager) => { const after = afterEventSeq(closedQuery(request.query, ["afterEventSeq"])); const runId = identifier(request.params.runId, "runId"); const events = await manager.events(); return { run: await manager.getRun(runId), queue: await manager.queueSnapshot(), events: events.filter((entry) => entry.eventSeq > after && entry.runId === runId), nextEventSeq: events.at(-1)?.eventSeq ?? 0 }; }, projectFluxPollResult));
  app.get<{ Params: { runId: string } }>(`${FLUX_API_PREFIX}/runs/:runId/reports`, (request, reply) => withManager(request, reply, "flux_reports", async (manager) => ({ run: await manager.getRun(identifier(request.params.runId, "runId")) }), (value) => ({ reports: projectFluxRunDto(value.run).reports })));
  app.get<{ Params: { runId: string } }>(`${FLUX_API_PREFIX}/runs/:runId/inspection`, (request, reply) => withManager(request, reply, "flux_inspection_snapshot", async (manager) => {
    const inspector = options.ports?.inspector; if (inspector === undefined) throw new DomainError("TOOLCHAIN_UNAVAILABLE", "Flux inspection capability is not configured", {}, true);
    const runId = identifier(request.params.runId, "runId"); const approval = await inspectionAuthority(manager, runId); return bindInspectionSnapshot(await inspector.snapshot(runId), runId, approval);
  }, projectFluxInspectorSnapshot));
  app.post<{ Params: { runId: string } }>(`${FLUX_API_PREFIX}/runs/:runId/inspection`, (request, reply) => withManager(request, reply, "flux_inspection", async (manager) => {
    closedBody(request.body, []); const key = idempotencyKey(request); const inspector = options.ports?.inspector;
    if (inspector === undefined) throw new DomainError("TOOLCHAIN_UNAVAILABLE", "Flux inspection capability is not configured", {}, true);
    const runId = identifier(request.params.runId, "runId"); const approval = await inspectionAuthority(manager, runId); return bindInspectionSnapshot(await inspector.inspect(runId, key), runId, approval);
  }, projectFluxInspectorSnapshot));
  app.get<{ Params: { runId: string } }>(`${FLUX_API_PREFIX}/runs/:runId/preview`, async (request, reply) => {
    try { assertNoQuery(request); const preview = options.ports?.preview; if (preview === undefined) throw new DomainError("TOOLCHAIN_UNAVAILABLE", "Flux preview capability is not configured", {}, true); return reply.send(sanitizedSuccess("flux_preview", request, previewPublic(await preview.get(identifier(request.params.runId, "runId"))))); } catch (error) { return failure(reply, error, request); }
  });
  app.post<{ Params: { runId: string } }>(`${FLUX_API_PREFIX}/runs/:runId/preview/refresh`, async (request, reply) => {
    try { assertNoQuery(request); closedBody(request.body, []); idempotencyKey(request); const preview = options.ports?.preview; if (preview === undefined) throw new DomainError("TOOLCHAIN_UNAVAILABLE", "Flux preview capability is not configured", {}, true); return reply.send(sanitizedSuccess("flux_preview_refresh", request, previewPublic(await preview.refresh(identifier(request.params.runId, "runId"))))); } catch (error) { return failure(reply, error, request); }
  });
  app.get<{ Params: { runId: string; kind: string } }>(`${FLUX_API_PREFIX}/runs/:runId/preview/:kind`, async (request, reply) => {
    try {
      assertNoQuery(request);
      const preview = options.ports?.preview; if (preview === undefined) throw new DomainError("TOOLCHAIN_UNAVAILABLE", "Flux preview capability is not configured", {}, true);
      identifier(request.params.runId, "runId");
      if (!(FLUX_PREVIEW_KINDS as readonly string[]).includes(request.params.kind)) throw new DomainError("NOT_FOUND", "Preview kind is not available");
      const kind = request.params.kind as FluxPreviewKind;
      const manifest = await preview.get(request.params.runId);
      const binding = previewBinding(manifest, kind);
      const bytes = await previewBytes(manifest, binding);
      reply.type(binding.mediaType);
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Content-Disposition", `inline; filename="${PREVIEW_FILES[kind].name}"`);
      reply.header("ETag", `"sha256:${binding.sha256}"`);
      return reply.send(bytes);
    } catch (error) { return failure(reply, error, request); }
  });
};
