import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { canonicalIdentity, canonicalJson, constantTimeDigestEqual, contentIdentity } from "../core/canonical.js";
import { hardenPortableValue, parsePortableJsonBytes, validateCanonicalIdentity, validateContentIdentity } from "../core/portable-artifact.js";
import { parseFluxDiagnostic, type FluxDiagnosticDto } from "../domain/diagnostics.js";
import type { CanonicalIdentity } from "../domain/types.js";
import { parsePcbDesignCompilationBundleRef } from "../harness/pcb-design-compilation-bundle.js";
import { parsePcbProviderProfileBinding, PCB_DESIGN_INTERPRETER_SCHEMA_VERSION } from "../harness/pcb-design-interpreter.js";
import { PCB_AGENT_MAX_FRESH_ITERATIONS, PCB_AGENT_MIN_ITERATIONS, PCB_AGENT_RECOMMENDED_FRESH_ITERATIONS } from "../harness/pcb-agent-harness.js";
import {
  FLUX_CHECKPOINT_FAILURE_RECEIPT_SCHEMA_VERSION,
  FLUX_CHECKPOINT_FAILURE_SCHEMA_VERSION,
  FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE,
  FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE,
  FLUX_REQUEST_ID_PATTERN,
  FLUX_TERMINAL_FAILURE_DIAGNOSTIC_SCHEMA_VERSION,
  FLUX_TERMINAL_FAILURE_RECEIPT_SCHEMA_VERSION,
  approvalSubjectDigest,
  fluxDigest,
  type FluxApprovalSubject,
  type FluxClarificationAnswerDto,
  type FluxCheckpointFailureReceiptDto,
  type FluxInterpretationFailureReceiptDto,
  type FluxProjectDto,
  type FluxRunDto,
  type FluxRuntimePolicyDto,
  type FluxSourceCatalogDto,
  type FluxTerminalFailureReceiptDto,
  type FluxThreadDto,
} from "../flux/contracts.js";
import { parseFluxPersistedFreshClearanceEvidenceBinding } from "../flux/fresh-clearance-evidence-binding.js";
import {
  projectFluxContractStateDto,
  projectFluxPollResult,
  projectFluxRunDto,
} from "../flux/public-projection.js";

export const FLUX_CONTROL_DEFAULT_BASE_URL = "http://127.0.0.1:8765" as const;
export const FLUX_CONTROL_INTENT_STORE_SCHEMA_VERSION = "evleda.flux-control-intent-store.v1" as const;
export const FLUX_CONTROL_INTENT_SCHEMA_VERSION = "evleda.flux-control-intent.v1" as const;
export const FLUX_CONTROL_APPROVAL_VIEW_SCHEMA_VERSION = "evleda.flux-control-approval-view.v1" as const;

export const FLUX_CONTROL_READINESS_REASON_CODES = Object.freeze([
  "FLUX_DISABLED", "ROOTS_INCOMPLETE", "PROVIDER_NOT_CONFIGURED", "MODEL_NOT_CONFIGURED", "AUTH_NOT_CONFIGURED",
  "PROVIDER_EXECUTABLE_UNAVAILABLE", "PROVIDER_PROCESS_TERMINATION_UNCONFIRMED", "CODEX_LOCAL_READ_ACK_REQUIRED",
  "CODEX_CONFIG_INCOMPATIBLE", "COMPILER_PROFILE_MISSING", "COMPILER_PROFILE_INVALID", "KICAD_MCP_RUNTIME_UNAVAILABLE",
  "KICAD_PROCESS_TERMINATION_UNCONFIRMED", "KICAD_TOOLCHAIN_UNAVAILABLE", "KICAD_LIBRARY_UNAVAILABLE", "RULE_CATALOG_UNAVAILABLE",
] as const);
const readinessReasonCodes = new Set<string>(FLUX_CONTROL_READINESS_REASON_CODES);
export const FLUX_CONTROL_KICAD_MCP_CONNECTION_POLICY = Object.freeze({
  maxConnections: 8 as const,
  concurrency: 1 as const,
  reuse: "same-live-run-bounded" as const,
  restart: "fail-closed-reallocate-reapprove" as const,
  cleanup: "after-confirmed-session-and-editor-stop" as const,
  unconfirmed: "retain-poison-no-retry" as const,
});
export const FLUX_CONTROL_REQUEST_TIMEOUT_MS = 30_000 as const;
export const FLUX_CONTROL_OPEN_TIMEOUT_MS = 120_000 as const;
export const FLUX_CONTROL_INTERPRETATION_TIMEOUT_MS = 300_000 as const;
export const FLUX_CONTROL_CHECKPOINT_TIMEOUT_MS = 300_000 as const;
const INTERPRETATION_TIMEOUT_OPERATIONS = new Set(["flux_interpret", "flux_clarify"]);
const requestTimeoutForOperation = (operation: string): number => operation === "flux_open"
  ? FLUX_CONTROL_OPEN_TIMEOUT_MS
  : operation === "flux_checkpoint_open" ? FLUX_CONTROL_CHECKPOINT_TIMEOUT_MS
    : INTERPRETATION_TIMEOUT_OPERATIONS.has(operation) ? FLUX_CONTROL_INTERPRETATION_TIMEOUT_MS : FLUX_CONTROL_REQUEST_TIMEOUT_MS;

export const FLUX_CONTROL_LIMITS = Object.freeze({
  responseBytes: 2 * 1024 * 1024,
  responseChunks: 4_096,
  responseChunkBytes: 256 * 1024,
  stateBytes: 2 * 1024 * 1024,
  stateIntents: 2_048,
  stateApprovalViews: 512,
  requestTimeoutMs: FLUX_CONTROL_REQUEST_TIMEOUT_MS,
  openTimeoutMs: FLUX_CONTROL_OPEN_TIMEOUT_MS,
  interpretationTimeoutMs: FLUX_CONTROL_INTERPRETATION_TIMEOUT_MS,
  checkpointTimeoutMs: FLUX_CONTROL_CHECKPOINT_TIMEOUT_MS,
  promptBytes: 32 * 1024,
  answerBytes: 256 * 1024,
});

export type FluxControlErrorCode =
  | "UNSAFE_BASE_URL"
  | "INPUT_INVALID"
  | "TRANSPORT_FAILED"
  | "INCOMPLETE"
  | "RESPONSE_LIMIT"
  | "RESPONSE_MALFORMED"
  | "REMOTE_ERROR"
  | "AUTHORITY_DRIFT"
  | "PHASE_MISMATCH"
  | "INTENT_CONFLICT"
  | "APPROVAL_NOT_OBSERVED"
  | "STORE_CAPACITY"
  | "STORE_CORRUPT"
  | "STORE_BUSY";

export class FluxControlError extends Error {
  public override readonly name: string = "FluxControlError";
  public constructor(
    public readonly code: FluxControlErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly requestId?: string,
  ) { super(message); }
}

export interface FluxControlRemoteFailure {
  readonly code: FluxControlRemoteErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>>;
  readonly diagnostic?: FluxDiagnosticDto;
  readonly terminalFailureReceipt?: FluxTerminalFailureReceiptDto;
}

export const FLUX_CONTROL_REMOTE_ERROR_CODES = Object.freeze([
  "ARTIFACT_INTEGRITY_ERROR", "CAPABILITY_REQUIRED", "DIGEST_MISMATCH",
  "EVIDENCE_MISSING", "EVIDENCE_STALE", "EXTERNAL_ACCEPTANCE_REQUIRED",
  "GATE_FAILED", "IDEMPOTENCY_CONFLICT", "INVALID_ARGUMENT", "NOT_FOUND",
  "PATH_OUTSIDE_WORKSPACE", "POLICY_DENIED", "REQUIREMENTS_NOT_APPROVED",
  "REVISION_CONFLICT", "STAGE_ALREADY_RUNNING", "STAGE_BLOCKED",
  "TOOL_RESULT_INCONCLUSIVE", "TOOLCHAIN_UNAVAILABLE", "TOOLCHAIN_UNSUPPORTED",
  "OPEN_PREFLIGHT_FAILED", "EVIDENCE_CAPACITY", "OPERATION_UNCERTAIN",
] as const);
export type FluxControlRemoteErrorCode = (typeof FLUX_CONTROL_REMOTE_ERROR_CODES)[number] | "REMOTE_FAILURE";
const remoteErrorCodes = new Set<string>(FLUX_CONTROL_REMOTE_ERROR_CODES);

export class FluxControlRemoteError extends FluxControlError {
  public override readonly name = "FluxControlRemoteError";
  public constructor(
    public readonly status: number,
    requestId: string,
    public readonly remote: FluxControlRemoteFailure,
  ) { super("REMOTE_ERROR", "Flux server rejected the request.", remote.retryable, requestId); }
}

type PlainRecord = Record<string, unknown>;
const ID = /^[a-z][a-z0-9_-]{0,127}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,200}$/u;

const fail = (code: FluxControlErrorCode, message: string, retryable = false): never => {
  throw new FluxControlError(code, message, retryable);
};

const record = (value: unknown, label: string): PlainRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail("RESPONSE_MALFORMED", `${label} must be an object.`);
  return value as PlainRecord;
};

const exactKeys = (value: PlainRecord, required: readonly string[], optional: readonly string[] = [], label = "object"): void => {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key))) {
    fail("RESPONSE_MALFORMED", `${label} does not match its exact envelope.`);
  }
};

const text = (value: unknown, label: string, maximumBytes = 16_384, allowEmpty = false): string => {
  if (typeof value !== "string" || value.includes("\0") || (!allowEmpty && value.trim().length === 0) || Buffer.byteLength(value, "utf8") > maximumBytes) {
    return fail("RESPONSE_MALFORMED", `${label} is invalid.`);
  }
  return value;
};

const identifier = (value: unknown, label: string): string => {
  const result = text(value, label, 128);
  return ID.test(result) ? result : fail("RESPONSE_MALFORMED", `${label} is not a safe identifier.`);
};

const inputIdentifier = (value: string, label: string): string =>
  typeof value === "string" && ID.test(value) ? value : fail("INPUT_INVALID", `${label} is not a safe Flux identifier.`);

const digest = (value: unknown, label: string): string => {
  const result = text(value, label, 64);
  return DIGEST.test(result) ? result : fail("RESPONSE_MALFORMED", `${label} is not a SHA-256 digest.`);
};

const timestamp = (value: unknown, label: string): string => {
  const result = text(value, label, 64);
  return !Number.isNaN(Date.parse(result)) && new Date(result).toISOString() === result
    ? result
    : fail("RESPONSE_MALFORMED", `${label} is not a canonical timestamp.`);
};

const same = (left: unknown, right: unknown): boolean => {
  try { return canonicalJson(left) === canonicalJson(right); } catch { return false; }
};

const normalizedTextInput = (value: string, label: string, maximumBytes: number): string => {
  if (typeof value !== "string" || value.includes("\0")) return fail("INPUT_INVALID", `${label} contains invalid text.`);
  const normalized = value.trim();
  if (normalized.length === 0 || Buffer.byteLength(normalized, "utf8") > maximumBytes) return fail("INPUT_INVALID", `${label} is empty or exceeds its byte limit.`);
  return normalized;
};

interface FluxControlPhysicalFileIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly mode: string;
  readonly nlink: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

interface FluxControlLockLease {
  readonly handle: FileHandle;
  readonly identity: FluxControlPhysicalFileIdentity;
  readonly token: Buffer;
}

export interface FluxControlBoundedFileReadOptions {
  readonly maximumBytes: number;
  readonly label: string;
  readonly failureCode: "INPUT_INVALID" | "STORE_CORRUPT";
  /** Deterministic race seam; production callers must omit it. */
  readonly afterHandleReadForTesting?: (label: string, filePath: string) => void | Promise<void>;
}

const physicalIdentity = (metadata: BigIntStats): FluxControlPhysicalFileIdentity => Object.freeze({
  dev: metadata.dev.toString(10), ino: metadata.ino.toString(10), mode: metadata.mode.toString(10),
  nlink: metadata.nlink.toString(10), size: metadata.size.toString(10),
  mtimeNs: metadata.mtimeNs.toString(10), ctimeNs: metadata.ctimeNs.toString(10),
});

const fileReadFailure = (options: FluxControlBoundedFileReadOptions, detail: string): never =>
  fail(options.failureCode, `${options.label} ${detail}`);

/**
 * Read one immutable pathname through its opened descriptor, then prove both
 * the handle and pathname still identify the same single-link regular file.
 */
export async function readFluxControlBoundedFile(filePath: string, options: FluxControlBoundedFileReadOptions): Promise<Buffer> {
  const resolved = path.resolve(filePath);
  if (!Number.isSafeInteger(options.maximumBytes) || options.maximumBytes < 1 || options.maximumBytes > 16 * 1024 * 1024) return fileReadFailure(options, "has an invalid byte bound.");
  let beforePath;
  try { beforePath = await lstat(resolved, { bigint: true }); }
  catch { return fileReadFailure(options, "is unavailable."); }
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.nlink !== 1n || beforePath.size > BigInt(options.maximumBytes)) return fileReadFailure(options, "must be a bounded single-link regular file.");
  let canonicalBefore: string;
  try { canonicalBefore = await realpath(resolved); }
  catch { return fileReadFailure(options, "cannot be canonically resolved."); }
  if (canonicalBefore !== resolved) return fileReadFailure(options, "resolves through a link or spelling alias.");
  const flags = fsConstants.O_RDONLY | (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW);
  let handle;
  try { handle = await open(resolved, flags); }
  catch { return fileReadFailure(options, "could not be opened without following links."); }
  try {
    const beforeHandle = await handle.stat({ bigint: true });
    if (!beforeHandle.isFile() || beforeHandle.isSymbolicLink() || beforeHandle.nlink !== 1n || beforeHandle.size > BigInt(options.maximumBytes) || !same(physicalIdentity(beforePath), physicalIdentity(beforeHandle))) return fileReadFailure(options, "changed between pathname validation and descriptor open.");
    const bytes = await handle.readFile();
    if (bytes.byteLength !== Number(beforeHandle.size) || bytes.byteLength > options.maximumBytes) return fileReadFailure(options, "changed size while being read.");
    await options.afterHandleReadForTesting?.(options.label, resolved);
    const afterHandle = await handle.stat({ bigint: true });
    let afterPath; let canonicalAfter: string;
    try { afterPath = await lstat(resolved, { bigint: true }); canonicalAfter = await realpath(resolved); }
    catch { return fileReadFailure(options, "was replaced or removed during its descriptor-bound read."); }
    if (!afterHandle.isFile() || afterHandle.isSymbolicLink() || afterHandle.nlink !== 1n || !afterPath.isFile() || afterPath.isSymbolicLink() || afterPath.nlink !== 1n || canonicalAfter !== resolved
      || !same(physicalIdentity(beforeHandle), physicalIdentity(afterHandle)) || !same(physicalIdentity(beforeHandle), physicalIdentity(afterPath))) return fileReadFailure(options, "was modified, replaced, linked, or re-resolved during its descriptor-bound read.");
    return bytes;
  } catch (error) {
    if (error instanceof FluxControlError) throw error;
    return fileReadFailure(options, "failed its descriptor-bound read.");
  } finally { await handle.close().catch(() => undefined); }
}

const loopbackHostname = (hostname: string): boolean => {
  const normalized = hostname.toLocaleLowerCase("en-US");
  if (normalized === "localhost" || normalized === "::1" || normalized === "[::1]") return true;
  if (isIP(normalized) !== 4) return false;
  const octets = normalized.split(".").map(Number);
  return octets.length === 4 && octets[0] === 127 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255);
};

/** Normalize one authority root. Remote operation requires an explicit HTTPS-only override. */
export function normalizeFluxControlBaseUrl(
  input: string = FLUX_CONTROL_DEFAULT_BASE_URL,
  allowRemoteHttps = false,
): string {
  let parsed: URL;
  try { parsed = new URL(input); }
  catch { return fail("UNSAFE_BASE_URL", "Flux base URL is invalid."); }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || !["", "/"].includes(parsed.pathname)) {
    return fail("UNSAFE_BASE_URL", "Flux base URL must contain only an origin without credentials, path, query, or fragment.");
  }
  const local = loopbackHostname(parsed.hostname);
  if (local) {
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return fail("UNSAFE_BASE_URL", "Loopback Flux uses HTTP or HTTPS only.");
  } else if (!allowRemoteHttps || parsed.protocol !== "https:") {
    return fail("UNSAFE_BASE_URL", "Non-loopback Flux requires the explicit remote override and HTTPS.");
  }
  return parsed.origin;
}

export interface FluxControlTransportOptions {
  readonly baseUrl?: string;
  readonly allowRemoteHttps?: boolean;
  readonly fetch?: typeof globalThis.fetch;
  readonly responseBytes?: number;
  readonly responseChunks?: number;
  readonly responseChunkBytes?: number;
}

type ParsedSuccess = Readonly<{ ok: true; operation: string; requestId: string; result: unknown; status: number }>;
type ParsedFailure = Readonly<{ ok: false; requestId: string; error: FluxControlRemoteFailure; status: number }>;
type ParsedEnvelope = ParsedSuccess | ParsedFailure;

const boundedPositive = (value: number | undefined, fallback: number, maximum: number, label: string): number => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) return fail("INPUT_INVALID", `${label} is outside its trusted bound.`);
  return result;
};

const readBoundedResponseBytes = async (
  response: Response,
  limits: Readonly<{ bytes: number; chunks: number; chunkBytes: number }>,
): Promise<Buffer> => {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > limits.bytes)) {
    return fail("RESPONSE_LIMIT", "Flux response Content-Length is invalid or exceeds the byte limit.");
  }
  if (response.body === null) return fail("RESPONSE_MALFORMED", "Flux response has no body.");
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = response.body.getReader(); }
  catch { return fail("TRANSPORT_FAILED", "Flux response stream could not be opened.", true); }
  const chunks: Buffer[] = [];
  let total = 0;
  let count = 0;
  try {
    for (;;) {
      let next: Awaited<ReturnType<typeof reader.read>>;
      try { next = await reader.read(); }
      catch { return fail("TRANSPORT_FAILED", "Flux response stream failed before a complete envelope was received.", true); }
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) return fail("TRANSPORT_FAILED", "Flux response stream yielded a non-byte chunk.", true);
      count += 1;
      if (count > limits.chunks || next.value.byteLength > limits.chunkBytes) {
        await reader.cancel().catch(() => undefined);
        return fail("RESPONSE_LIMIT", "Flux response exceeds its chunk-count or per-chunk bound.");
      }
      total += next.value.byteLength;
      if (total > limits.bytes) {
        await reader.cancel().catch(() => undefined);
        return fail("RESPONSE_LIMIT", "Flux response exceeds its aggregate byte limit.");
      }
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    try { reader.releaseLock(); } catch { /* fixed stream result above remains authoritative */ }
  }
  if (total === 0) return fail("RESPONSE_MALFORMED", "Flux response body is empty.");
  if (declared !== null && Number(declared) !== total) return fail("RESPONSE_MALFORMED", "Flux response byte count differs from Content-Length.");
  return Buffer.concat(chunks, total);
};

const checkpointFailureIdentity = (message: string): CanonicalIdentity => canonicalIdentity({ code: "OPERATION_UNCERTAIN", message, details: {} }, FLUX_CHECKPOINT_FAILURE_SCHEMA_VERSION);

const checkpointFailureMessage = (identity: unknown): string => {
  for (const message of [FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE, FLUX_CHECKPOINT_OPERATION_TIMEOUT_MESSAGE]) {
    if (same(identity, checkpointFailureIdentity(message))) return message;
  }
  return fail("RESPONSE_MALFORMED", "Flux checkpoint failure identity does not bind a supported failure.");
};

const parseCheckpointTerminalReceiptShape = (value: unknown, error: PlainRecord, details: PlainRecord): FluxCheckpointFailureReceiptDto => {
  if (error.code !== "OPERATION_UNCERTAIN" || error.retryable !== false || Object.keys(details).length !== 0 || error.diagnostic !== undefined) return fail("RESPONSE_MALFORMED", "Flux checkpoint terminal failure has invalid error authority.");
  const receipt = record(value, "Flux checkpoint terminal receipt");
  exactKeys(receipt, ["schemaVersion", "operation", "idempotencyKey", "requestDigest", "projectId", "threadId", "runId", "failureIdentity", "terminalPhase", "outcome", "completedAt", "identity"], [], "Flux checkpoint terminal receipt");
  if (receipt.schemaVersion !== FLUX_CHECKPOINT_FAILURE_RECEIPT_SCHEMA_VERSION || receipt.operation !== "checkpoint_open" || typeof receipt.idempotencyKey !== "string" || !/^fluxctl\.[a-f0-9]{32}$/u.test(receipt.idempotencyKey) || receipt.terminalPhase !== "blocked" || receipt.outcome !== "failed") return fail("RESPONSE_MALFORMED", "Flux checkpoint terminal receipt has invalid operation authority.");
  const message = checkpointFailureMessage(receipt.failureIdentity);
  if (error.message !== message) return fail("RESPONSE_MALFORMED", "Flux checkpoint terminal receipt differs from its current response failure.");
  const payload = {
    schemaVersion: FLUX_CHECKPOINT_FAILURE_RECEIPT_SCHEMA_VERSION,
    operation: "checkpoint_open" as const,
    idempotencyKey: receipt.idempotencyKey,
    requestDigest: digest(receipt.requestDigest, "Checkpoint terminal request digest"),
    projectId: identifier(receipt.projectId, "Checkpoint terminal projectId"),
    threadId: identifier(receipt.threadId, "Checkpoint terminal threadId"),
    runId: identifier(receipt.runId, "Checkpoint terminal runId"),
    failureIdentity: checkpointFailureIdentity(message),
    terminalPhase: "blocked" as const,
    outcome: "failed" as const,
    completedAt: timestamp(receipt.completedAt, "Checkpoint terminal completedAt"),
  };
  const identity = canonicalIdentity(payload, FLUX_CHECKPOINT_FAILURE_RECEIPT_SCHEMA_VERSION);
  if (!same(receipt.identity, identity)) return fail("RESPONSE_MALFORMED", "Flux checkpoint terminal receipt identity does not reproduce.");
  return Object.freeze({ ...payload, identity });
};

const parseTerminalReceiptShape = (value: unknown, diagnostic: FluxDiagnosticDto, expectedEnvelopeOperation: string): FluxInterpretationFailureReceiptDto => {
  if (expectedEnvelopeOperation !== "flux_interpret" && expectedEnvelopeOperation !== "flux_clarify") return fail("RESPONSE_MALFORMED", "Terminal failure receipt is not eligible for this operation.");
  const receipt = record(value, "Flux terminal failure receipt");
  exactKeys(receipt, ["schemaVersion", "operation", "idempotencyKey", "requestDigest", "projectId", "threadId", "runId", "diagnosticIdentity", "terminalPhase", "outcome", "completedAt", "identity"], [], "Flux terminal failure receipt");
  const operation = expectedEnvelopeOperation === "flux_interpret" ? "interpret_run" as const : "clarify_run" as const;
  if (receipt.schemaVersion !== FLUX_TERMINAL_FAILURE_RECEIPT_SCHEMA_VERSION || receipt.operation !== operation || typeof receipt.idempotencyKey !== "string" || !/^fluxctl\.[a-f0-9]{32}$/u.test(receipt.idempotencyKey) || receipt.terminalPhase !== "blocked" || receipt.outcome !== "failed") return fail("RESPONSE_MALFORMED", "Flux terminal failure receipt has invalid operation authority.");
  const payload = {
    schemaVersion: FLUX_TERMINAL_FAILURE_RECEIPT_SCHEMA_VERSION,
    operation,
    idempotencyKey: receipt.idempotencyKey,
    requestDigest: digest(receipt.requestDigest, "Terminal receipt request digest"),
    projectId: identifier(receipt.projectId, "Terminal receipt projectId"),
    threadId: identifier(receipt.threadId, "Terminal receipt threadId"),
    runId: identifier(receipt.runId, "Terminal receipt runId"),
    diagnosticIdentity: canonicalIdentity(diagnostic, FLUX_TERMINAL_FAILURE_DIAGNOSTIC_SCHEMA_VERSION),
    terminalPhase: "blocked" as const,
    outcome: "failed" as const,
    completedAt: timestamp(receipt.completedAt, "Terminal receipt completedAt"),
  };
  if (!same(receipt.diagnosticIdentity, payload.diagnosticIdentity) || !same(receipt.identity, canonicalIdentity(payload, FLUX_TERMINAL_FAILURE_RECEIPT_SCHEMA_VERSION))) return fail("RESPONSE_MALFORMED", "Flux terminal failure receipt identity does not reproduce from this response diagnostic.");
  return Object.freeze({ ...payload, identity: canonicalIdentity(payload, FLUX_TERMINAL_FAILURE_RECEIPT_SCHEMA_VERSION) });
};

const parseRemoteFailure = (value: unknown, expectedOperation: string): FluxControlRemoteFailure => {
  const error = record(value, "Flux failure error");
  exactKeys(error, ["code", "message", "retryable", "details"], ["diagnostic", "terminalFailureReceipt"], "Flux failure error");
  const wireCode = text(error.code, "Flux error code", 256);
  const code: FluxControlRemoteErrorCode = remoteErrorCodes.has(wireCode)
    ? wireCode as (typeof FLUX_CONTROL_REMOTE_ERROR_CODES)[number]
    : "REMOTE_FAILURE";
  text(error.message, "Flux error message", 64 * 1024, true);
  if (typeof error.retryable !== "boolean") return fail("RESPONSE_MALFORMED", "Flux retryable flag is invalid.");
  let details: unknown;
  try { details = hardenPortableValue(error.details, { maxBytes: 256 * 1024, maxDepth: 16, maxNodes: 8_192, maxArrayLength: 1_024, maxOwnKeys: 256, maxKeyBytes: 256, maxStringBytes: 32 * 1024 }); }
  catch { return fail("RESPONSE_MALFORMED", "Flux error details exceed the closed client bound."); }
  const detailRecord = record(details, "Flux error details");
  let diagnosticValue: FluxDiagnosticDto | undefined;
  if (error.diagnostic !== undefined) {
    try { diagnosticValue = parseFluxDiagnostic(error.diagnostic); }
    catch { return fail("RESPONSE_MALFORMED", "Flux diagnostic is invalid."); }
  }
  if (error.terminalFailureReceipt !== undefined && expectedOperation !== "flux_checkpoint_open" && diagnosticValue === undefined) return fail("RESPONSE_MALFORMED", "Flux terminal receipt lacks a current response diagnostic.");
  const terminalReceipt = error.terminalFailureReceipt === undefined
    ? undefined
    : expectedOperation === "flux_checkpoint_open"
      ? parseCheckpointTerminalReceiptShape(error.terminalFailureReceipt, error, detailRecord)
      : parseTerminalReceiptShape(error.terminalFailureReceipt, diagnosticValue!, expectedOperation);
  return Object.freeze({
    code, message: "Flux server rejected the request.", retryable: error.retryable, details: Object.freeze({}),
    ...(diagnosticValue === undefined ? {} : { diagnostic: diagnosticValue }),
    ...(terminalReceipt === undefined ? {} : { terminalFailureReceipt: terminalReceipt }),
  });
};

/** Parse one exact JSON envelope from the current Response object only. */
export async function parseFluxControlResponse(
  response: Response,
  expectedOperation: string,
  options: Pick<FluxControlTransportOptions, "responseBytes" | "responseChunks" | "responseChunkBytes"> = {},
): Promise<ParsedEnvelope> {
  const contentType = response.headers.get("content-type")?.toLocaleLowerCase("en-US") ?? "";
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/u.test(contentType.trim())) return fail("RESPONSE_MALFORMED", "Flux response Content-Type is not exact JSON UTF-8.");
  const bytes = await readBoundedResponseBytes(response, {
    bytes: boundedPositive(options.responseBytes, FLUX_CONTROL_LIMITS.responseBytes, 16 * 1024 * 1024, "responseBytes"),
    chunks: boundedPositive(options.responseChunks, FLUX_CONTROL_LIMITS.responseChunks, 65_536, "responseChunks"),
    chunkBytes: boundedPositive(options.responseChunkBytes, FLUX_CONTROL_LIMITS.responseChunkBytes, 1024 * 1024, "responseChunkBytes"),
  });
  let parsed: unknown;
  try { parsed = parsePortableJsonBytes(bytes, { maxBytes: FLUX_CONTROL_LIMITS.responseBytes, maxDepth: 64, maxNodes: 200_000, maxArrayLength: 20_000, maxOwnKeys: 2_048, maxKeyBytes: 512, maxStringBytes: 1024 * 1024 }); }
  catch { return fail("RESPONSE_MALFORMED", "Flux response is not strict fatal-UTF-8 JSON within structural limits."); }
  const envelope = record(parsed, "Flux response");
  if (envelope.ok === true) {
    exactKeys(envelope, ["ok", "operation", "requestId", "result"], [], "Flux success response");
    if (response.status < 200 || response.status >= 300 || envelope.operation !== expectedOperation) return fail("RESPONSE_MALFORMED", "Flux success status or operation does not match the current request.");
    const requestId = text(envelope.requestId, "Flux requestId", 128);
    if (!FLUX_REQUEST_ID_PATTERN.test(requestId)) return fail("RESPONSE_MALFORMED", "Flux requestId is invalid.");
    return Object.freeze({ ok: true, operation: expectedOperation, requestId, result: envelope.result, status: response.status });
  }
  if (envelope.ok === false) {
    exactKeys(envelope, ["ok", "requestId", "error"], [], "Flux failure response");
    if (response.status >= 200 && response.status < 300) return fail("RESPONSE_MALFORMED", "Flux failure arrived with a success HTTP status.");
    const requestId = text(envelope.requestId, "Flux requestId", 128);
    if (!FLUX_REQUEST_ID_PATTERN.test(requestId)) return fail("RESPONSE_MALFORMED", "Flux requestId is invalid.");
    return Object.freeze({ ok: false, requestId, error: parseRemoteFailure(envelope.error, expectedOperation), status: response.status });
  }
  return fail("RESPONSE_MALFORMED", "Flux response has no exact boolean ok discriminator.");
}

export type FluxControlIntentOperation =
  | "create_project" | "create_thread" | "create_generic_run"
  | "interpret_run" | "clarify_run" | "prepare_run" | "open_project"
  | "checkpoint_open" | "approve_run" | "resume_run" | "preview_refresh" | "inspect_run";

export interface FluxControlAuthorityBinding {
  readonly baseUrl: string;
  readonly policyDigest: string;
  readonly sourceKey: string | null;
  readonly sourceFingerprint: string | null;
  readonly projectDigest: string | null;
  readonly threadDigest: string | null;
  readonly runDigest: string | null;
}

export interface FluxControlIntent {
  readonly schemaVersion: typeof FLUX_CONTROL_INTENT_SCHEMA_VERSION;
  readonly intentId: string;
  readonly operation: FluxControlIntentOperation;
  readonly idempotencyKey: string;
  readonly logicalDigest: string;
  readonly requestDigest: string;
  readonly authority: FluxControlAuthorityBinding;
  readonly status: "pending" | "completed" | "terminal";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resultDigest: string | null;
  readonly lastRequestId: string | null;
  readonly terminalReceiptIdentity: CanonicalIdentity | null;
  readonly identity: CanonicalIdentity;
}

export interface FluxControlApprovalView {
  readonly schemaVersion: typeof FLUX_CONTROL_APPROVAL_VIEW_SCHEMA_VERSION;
  readonly runId: string;
  readonly subjectDigest: string;
  readonly authorityDigest: string;
  readonly requestId: string;
  readonly observedAt: string;
  readonly identity: CanonicalIdentity;
}

interface FluxControlIntentStoreState {
  readonly schemaVersion: typeof FLUX_CONTROL_INTENT_STORE_SCHEMA_VERSION;
  readonly baseUrl: string;
  readonly revision: number;
  readonly intents: Readonly<Record<string, FluxControlIntent>>;
  readonly approvalViews: Readonly<Record<string, FluxControlApprovalView>>;
  readonly identity: CanonicalIdentity;
}

const identityPayload = <Value extends { readonly identity: CanonicalIdentity }>(value: Value): Omit<Value, "identity"> => {
  const { identity: _identity, ...payload } = value;
  return payload;
};

const intentIdentity = (value: Omit<FluxControlIntent, "identity">): CanonicalIdentity => canonicalIdentity(value, FLUX_CONTROL_INTENT_SCHEMA_VERSION);
const approvalViewIdentity = (value: Omit<FluxControlApprovalView, "identity">): CanonicalIdentity => canonicalIdentity(value, FLUX_CONTROL_APPROVAL_VIEW_SCHEMA_VERSION);
const stateIdentity = (value: Omit<FluxControlIntentStoreState, "identity">): CanonicalIdentity => canonicalIdentity(value, FLUX_CONTROL_INTENT_STORE_SCHEMA_VERSION);

const emptyState = (baseUrl: string): FluxControlIntentStoreState => {
  const payload = { schemaVersion: FLUX_CONTROL_INTENT_STORE_SCHEMA_VERSION, baseUrl, revision: 0, intents: {}, approvalViews: {} };
  return Object.freeze({ ...payload, identity: stateIdentity(payload) });
};

const parseCanonicalIdentity = (value: unknown, label: string): CanonicalIdentity => {
  try { return validateCanonicalIdentity(value, label); }
  catch { return fail("STORE_CORRUPT", `${label} is invalid.`); }
};

const parseAuthority = (value: unknown): FluxControlAuthorityBinding => {
  const authority = record(value, "Intent authority");
  exactKeys(authority, ["baseUrl", "policyDigest", "sourceKey", "sourceFingerprint", "projectDigest", "threadDigest", "runDigest"], [], "Intent authority");
  const nullable = (entry: unknown, label: string, pattern?: RegExp): string | null => {
    if (entry === null) return null;
    const result = text(entry, label, 512);
    if (pattern !== undefined && !pattern.test(result)) return fail("STORE_CORRUPT", `${label} is invalid.`);
    return result;
  };
  return Object.freeze({
    baseUrl: text(authority.baseUrl, "Intent baseUrl", 2_048),
    policyDigest: digest(authority.policyDigest, "Intent policy digest"),
    sourceKey: nullable(authority.sourceKey, "Intent source key", ID),
    sourceFingerprint: nullable(authority.sourceFingerprint, "Intent source fingerprint", DIGEST),
    projectDigest: nullable(authority.projectDigest, "Intent project digest", DIGEST),
    threadDigest: nullable(authority.threadDigest, "Intent thread digest", DIGEST),
    runDigest: nullable(authority.runDigest, "Intent run digest", DIGEST),
  });
};

const parseIntent = (value: unknown, key: string): FluxControlIntent => {
  const intent = record(value, "Stored Flux intent");
  exactKeys(intent, ["schemaVersion", "intentId", "operation", "idempotencyKey", "logicalDigest", "requestDigest", "authority", "status", "createdAt", "updatedAt", "resultDigest", "lastRequestId", "terminalReceiptIdentity", "identity"], [], "Stored Flux intent");
  if (intent.schemaVersion !== FLUX_CONTROL_INTENT_SCHEMA_VERSION || intent.intentId !== key || !/^intent_[a-z_]+_[a-f0-9]{32}$/u.test(key) || !IDEMPOTENCY_KEY.test(String(intent.idempotencyKey)) || !["pending", "completed", "terminal"].includes(String(intent.status))) {
    return fail("STORE_CORRUPT", "Stored Flux intent has an invalid root binding.");
  }
    const operations: readonly FluxControlIntentOperation[] = ["create_project", "create_thread", "create_generic_run", "interpret_run", "clarify_run", "prepare_run", "open_project", "checkpoint_open", "approve_run", "resume_run", "preview_refresh", "inspect_run"];
  if (!operations.includes(intent.operation as FluxControlIntentOperation)) return fail("STORE_CORRUPT", "Stored Flux intent operation is invalid.");
  const nullableDigest = intent.resultDigest === null ? null : digest(intent.resultDigest, "Intent result digest");
  const nullableRequestId = intent.lastRequestId === null ? null : text(intent.lastRequestId, "Intent requestId", 128);
  if (nullableRequestId !== null && !FLUX_REQUEST_ID_PATTERN.test(nullableRequestId)) return fail("STORE_CORRUPT", "Stored Flux requestId is invalid.");
  const terminalIdentity = intent.terminalReceiptIdentity === null ? null : parseCanonicalIdentity(intent.terminalReceiptIdentity, "Intent terminal receipt identity");
  const parsed: FluxControlIntent = {
    schemaVersion: FLUX_CONTROL_INTENT_SCHEMA_VERSION,
    intentId: text(intent.intentId, "Intent id", 200),
    operation: intent.operation as FluxControlIntentOperation,
    idempotencyKey: String(intent.idempotencyKey),
    logicalDigest: digest(intent.logicalDigest, "Intent logical digest"),
    requestDigest: digest(intent.requestDigest, "Intent request digest"),
    authority: parseAuthority(intent.authority),
    status: intent.status as FluxControlIntent["status"],
    createdAt: timestamp(intent.createdAt, "Intent createdAt"),
    updatedAt: timestamp(intent.updatedAt, "Intent updatedAt"),
    resultDigest: nullableDigest,
    lastRequestId: nullableRequestId,
    terminalReceiptIdentity: terminalIdentity,
    identity: parseCanonicalIdentity(intent.identity, "Intent identity"),
  };
  if (!same(parsed.identity, intentIdentity(identityPayload(parsed)))) return fail("STORE_CORRUPT", "Stored Flux intent identity does not reproduce.");
  return Object.freeze(parsed);
};

const parseApprovalView = (value: unknown, key: string): FluxControlApprovalView => {
  const view = record(value, "Stored approval view");
  exactKeys(view, ["schemaVersion", "runId", "subjectDigest", "authorityDigest", "requestId", "observedAt", "identity"], [], "Stored approval view");
  const parsed: FluxControlApprovalView = {
    schemaVersion: FLUX_CONTROL_APPROVAL_VIEW_SCHEMA_VERSION,
    runId: identifier(view.runId, "Approval runId"),
    subjectDigest: digest(view.subjectDigest, "Approval subject digest"),
    authorityDigest: digest(view.authorityDigest, "Approval authority digest"),
    requestId: text(view.requestId, "Approval requestId", 128),
    observedAt: timestamp(view.observedAt, "Approval observedAt"),
    identity: parseCanonicalIdentity(view.identity, "Approval view identity"),
  };
  if (view.schemaVersion !== FLUX_CONTROL_APPROVAL_VIEW_SCHEMA_VERSION || parsed.runId !== key || !FLUX_REQUEST_ID_PATTERN.test(parsed.requestId) || !same(parsed.identity, approvalViewIdentity(identityPayload(parsed)))) {
    return fail("STORE_CORRUPT", "Stored approval view does not reproduce.");
  }
  return Object.freeze(parsed);
};

const parseStore = (value: unknown, expectedBaseUrl: string): FluxControlIntentStoreState => {
  const state = record(value, "Flux intent store");
  exactKeys(state, ["schemaVersion", "baseUrl", "revision", "intents", "approvalViews", "identity"], [], "Flux intent store");
  if (state.schemaVersion !== FLUX_CONTROL_INTENT_STORE_SCHEMA_VERSION || state.baseUrl !== expectedBaseUrl || !Number.isSafeInteger(state.revision) || (state.revision as number) < 0) {
    return fail("AUTHORITY_DRIFT", "Flux intent store base URL or revision does not match this client authority.");
  }
  const intentsRaw = record(state.intents, "Flux intent map");
  const viewsRaw = record(state.approvalViews, "Flux approval-view map");
  if (Object.keys(intentsRaw).length > FLUX_CONTROL_LIMITS.stateIntents || Object.keys(viewsRaw).length > FLUX_CONTROL_LIMITS.stateApprovalViews) return fail("STORE_CORRUPT", "Flux intent store exceeds its record limit.");
  const intents = Object.fromEntries(Object.entries(intentsRaw).map(([key, entry]) => [key, parseIntent(entry, key)]));
  const approvalViews = Object.fromEntries(Object.entries(viewsRaw).map(([key, entry]) => [key, parseApprovalView(entry, key)]));
  const parsed: FluxControlIntentStoreState = {
    schemaVersion: FLUX_CONTROL_INTENT_STORE_SCHEMA_VERSION,
    baseUrl: expectedBaseUrl,
    revision: state.revision as number,
    intents,
    approvalViews,
    identity: parseCanonicalIdentity(state.identity, "Flux intent store identity"),
  };
  if (!same(parsed.identity, stateIdentity(identityPayload(parsed)))) return fail("STORE_CORRUPT", "Flux intent store identity does not reproduce.");
  return Object.freeze(parsed);
};

export interface FluxControlIntentInput {
  readonly operation: FluxControlIntentOperation;
  readonly logicalDigest: string;
  readonly requestDigest: string;
  readonly authority: FluxControlAuthorityBinding;
}

export interface FluxControlIntentAdmission {
  readonly intent: FluxControlIntent;
  readonly disposition: "fresh" | "replay";
}

interface FluxControlFreshAdmissionRejection {
  readonly code: FluxControlErrorCode;
  readonly message: string;
  readonly retryable?: boolean;
}

export interface FluxControlIntentStoreOptions {
  /** Deterministic race seam; production callers must omit it. */
  readonly afterManifestReadForTesting?: (label: string, filePath: string) => void | Promise<void>;
  /** Lower-only cardinality seams; production callers must omit them. */
  readonly maximumIntentsForTesting?: number;
  readonly maximumApprovalViewsForTesting?: number;
}

export class FluxControlIntentStore {
  public readonly filePath: string;
  readonly #baseUrl: string;
  readonly #lockPath: string;
  readonly #afterManifestReadForTesting: FluxControlIntentStoreOptions["afterManifestReadForTesting"];
  readonly #maximumIntents: number;
  readonly #maximumApprovalViews: number;

  public constructor(filePath: string, baseUrl: string, options: FluxControlIntentStoreOptions = {}) {
    this.filePath = path.resolve(filePath);
    this.#lockPath = `${this.filePath}.lock`;
    this.#baseUrl = baseUrl;
    this.#afterManifestReadForTesting = options.afterManifestReadForTesting;
    this.#maximumIntents = boundedPositive(options.maximumIntentsForTesting, FLUX_CONTROL_LIMITS.stateIntents, FLUX_CONTROL_LIMITS.stateIntents, "maximumIntentsForTesting");
    this.#maximumApprovalViews = boundedPositive(options.maximumApprovalViewsForTesting, FLUX_CONTROL_LIMITS.stateApprovalViews, FLUX_CONTROL_LIMITS.stateApprovalViews, "maximumApprovalViewsForTesting");
  }

  async #read(): Promise<FluxControlIntentStoreState> {
    try {
      try { await lstat(this.filePath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState(this.#baseUrl); throw error; }
      const bytes = await readFluxControlBoundedFile(this.filePath, { maximumBytes: FLUX_CONTROL_LIMITS.stateBytes, label: "Flux intent store", failureCode: "STORE_CORRUPT", ...(this.#afterManifestReadForTesting === undefined ? {} : { afterHandleReadForTesting: this.#afterManifestReadForTesting }) });
      let parsed: unknown;
      try { parsed = parsePortableJsonBytes(bytes, { maxBytes: FLUX_CONTROL_LIMITS.stateBytes, maxDepth: 32, maxNodes: 100_000, maxArrayLength: 4_096, maxOwnKeys: 2_048, maxKeyBytes: 512, maxStringBytes: 32 * 1024 }); }
      catch { return fail("STORE_CORRUPT", "Flux intent store is not strict fatal-UTF-8 JSON."); }
      try { return parseStore(parsed, this.#baseUrl); }
      catch (error) {
        if (error instanceof FluxControlError && error.code === "AUTHORITY_DRIFT") throw error;
        return fail("STORE_CORRUPT", "Flux intent store failed its exact schema or identity.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState(this.#baseUrl);
      if (error instanceof FluxControlError) throw error;
      return fail("STORE_CORRUPT", "Flux intent store is unreadable.");
    }
  }

  async #write(state: FluxControlIntentStoreState, assertLease: () => Promise<void>): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const directoryMetadata = await lstat(directory);
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink() || await realpath(directory) !== directory) return fail("STORE_CORRUPT", "Flux intent-store directory is not an ordinary canonical directory.");
    const bytes = Buffer.from(`${canonicalJson(state)}\n`, "utf8");
    if (bytes.byteLength > FLUX_CONTROL_LIMITS.stateBytes) return fail("STORE_CORRUPT", "Flux intent store exceeds its byte limit.");
    const temporary = path.join(directory, `.${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      let stagedIdentity: FluxControlPhysicalFileIdentity;
      try {
        const empty = await handle.stat({ bigint: true });
        if (!empty.isFile() || empty.isSymbolicLink() || empty.nlink !== 1n || empty.size !== 0n) return fail("STORE_CORRUPT", "Flux intent-store temporary file is not a new single-link regular file.");
        await handle.writeFile(bytes); await handle.sync();
        const written = await handle.stat({ bigint: true });
        if (!written.isFile() || written.isSymbolicLink() || written.nlink !== 1n || written.size !== BigInt(bytes.byteLength)) return fail("STORE_CORRUPT", "Flux intent-store temporary descriptor did not retain its exact write.");
        stagedIdentity = physicalIdentity(written);
      } finally { await handle.close(); }
      const stagedPath = await lstat(temporary, { bigint: true });
      if (!stagedPath.isFile() || stagedPath.isSymbolicLink() || stagedPath.nlink !== 1n || await realpath(temporary) !== temporary || !same(stagedIdentity!, physicalIdentity(stagedPath))) return fail("STORE_CORRUPT", "Flux intent-store temporary pathname changed before publication.");
      await assertLease();
      await rename(temporary, this.filePath);
    } finally { await rm(temporary, { force: true }).catch(() => undefined); }
    const persisted = await readFluxControlBoundedFile(this.filePath, { maximumBytes: FLUX_CONTROL_LIMITS.stateBytes, label: "Flux intent store readback", failureCode: "STORE_CORRUPT", ...(this.#afterManifestReadForTesting === undefined ? {} : { afterHandleReadForTesting: this.#afterManifestReadForTesting }) });
    if (!persisted.equals(bytes)) return fail("STORE_CORRUPT", "Flux intent store readback differs from the committed bytes.");
    try {
      const directoryHandle = await open(directory, "r");
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!["EPERM", "EISDIR", "EINVAL", "ENOTSUP", "EBADF"].includes(code ?? "")) throw error;
    }
  }

  async #assertLockLease(lease: FluxControlLockLease): Promise<void> {
    try {
      const handleMetadata = await lease.handle.stat({ bigint: true });
      const token = Buffer.alloc(lease.token.byteLength);
      const read = await lease.handle.read(token, 0, token.byteLength, 0);
      const pathHandle = await open(this.#lockPath, fsConstants.O_RDONLY | (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW));
      let pathHandleMetadata: BigIntStats; let pathToken: Buffer; let pathRead: Awaited<ReturnType<FileHandle["read"]>>;
      try {
        pathHandleMetadata = await pathHandle.stat({ bigint: true });
        pathToken = Buffer.alloc(lease.token.byteLength);
        pathRead = await pathHandle.read(pathToken, 0, pathToken.byteLength, 0);
      } finally { await pathHandle.close(); }
      const pathMetadata = await lstat(this.#lockPath, { bigint: true });
      const canonical = await realpath(this.#lockPath);
      if (!handleMetadata.isFile() || handleMetadata.isSymbolicLink() || handleMetadata.nlink !== 1n || handleMetadata.size !== BigInt(lease.token.byteLength)
        || !pathHandleMetadata.isFile() || pathHandleMetadata.isSymbolicLink() || pathHandleMetadata.nlink !== 1n || pathHandleMetadata.size !== BigInt(lease.token.byteLength)
        || !pathMetadata.isFile() || pathMetadata.isSymbolicLink() || pathMetadata.nlink !== 1n || canonical !== this.#lockPath
        || !same(physicalIdentity(handleMetadata), lease.identity) || !same(physicalIdentity(pathHandleMetadata), lease.identity) || !same(physicalIdentity(pathMetadata), lease.identity)
        || read.bytesRead !== lease.token.byteLength || !token.equals(lease.token) || pathRead.bytesRead !== lease.token.byteLength || !pathToken.equals(lease.token)) return fail("STORE_CORRUPT", "Flux intent-store lock lease changed or lost its creation token.");
    } catch (error) {
      if (error instanceof FluxControlError) throw error;
      return fail("STORE_CORRUPT", "Flux intent-store lock lease is unavailable.");
    }
  }

  async #releaseLockLease(lease: FluxControlLockLease): Promise<void> {
    await this.#assertLockLease(lease);
    await lease.handle.close();
    try {
      const pathMetadata = await lstat(this.#lockPath, { bigint: true });
      if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink() || pathMetadata.nlink !== 1n || await realpath(this.#lockPath) !== this.#lockPath || !same(physicalIdentity(pathMetadata), lease.identity)) {
        return fail("STORE_CORRUPT", "Flux intent-store lock pathname changed before release.");
      }
      await unlink(this.#lockPath);
    } catch (error) {
      if (error instanceof FluxControlError) throw error;
      return fail("STORE_CORRUPT", "Flux intent-store lock could not be safely released.");
    }
  }

  async #withLock<Value>(action: (state: FluxControlIntentStoreState) => Promise<Readonly<{ state: FluxControlIntentStoreState; value: Value }>>): Promise<Value> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const directoryMetadata = await lstat(directory);
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink() || await realpath(directory) !== directory) return fail("STORE_CORRUPT", "Flux intent-store directory is not an ordinary canonical directory.");
    let lock: FileHandle;
    try { lock = await open(this.#lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR, 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return fail("STORE_BUSY", "Another Flux control process owns the intent store.", true);
      return fail("STORE_CORRUPT", "Flux intent-store lock could not be acquired.");
    }
    let lease: FluxControlLockLease | undefined;
    let value: Value | undefined;
    let operationError: unknown;
    try {
      const token = Buffer.from(`evleda-flux-control-lock-v1:${process.pid}:${randomUUID()}\n`, "utf8");
      await lock.write(token, 0, token.byteLength, 0);
      await lock.sync();
      const metadata = await lock.stat({ bigint: true });
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n || metadata.size !== BigInt(token.byteLength)) return fail("STORE_CORRUPT", "Flux intent-store lock descriptor is not an exact single-link token file.");
      lease = Object.freeze({ handle: lock, identity: physicalIdentity(metadata), token });
      await this.#assertLockLease(lease);
      const current = await this.#read();
      await this.#assertLockLease(lease);
      const outcome = await action(current);
      await this.#assertLockLease(lease);
      await this.#write(outcome.state, async () => this.#assertLockLease(lease!));
      await this.#assertLockLease(lease);
      value = outcome.value;
    } catch (error) { operationError = error; }
    let releaseError: unknown;
    if (lease === undefined) await lock.close().catch(() => undefined);
    else {
      try { await this.#releaseLockLease(lease); }
      catch (error) { releaseError = error; await lease.handle.close().catch(() => undefined); }
    }
    if (releaseError !== undefined) throw releaseError;
    if (operationError !== undefined) throw operationError;
    return value!;
  }

  public intentId(input: FluxControlIntentInput): string {
    if (!DIGEST.test(input.logicalDigest)) return fail("INPUT_INVALID", "Flux intent logical digest is invalid.");
    return `intent_${input.operation}_${input.logicalDigest.slice(0, 32)}`;
  }

  public async getIntent(intentId: string): Promise<FluxControlIntent | undefined> {
    return (await this.#read()).intents[intentId];
  }

  public async begin(input: FluxControlIntentInput): Promise<FluxControlIntent> {
    return (await this.beginWithDisposition(input)).intent;
  }

  public async beginWithDisposition(input: FluxControlIntentInput, freshRejection?: FluxControlFreshAdmissionRejection): Promise<FluxControlIntentAdmission> {
    if (!DIGEST.test(input.logicalDigest) || !DIGEST.test(input.requestDigest) || input.authority.baseUrl !== this.#baseUrl || !DIGEST.test(input.authority.policyDigest)) return fail("INPUT_INVALID", "Flux intent input does not bind this store authority.");
    const intentId = this.intentId(input);
    return this.#withLock<FluxControlIntentAdmission>(async (state) => {
      const existing = state.intents[intentId];
      if (existing !== undefined) {
        if (existing.operation !== input.operation || existing.logicalDigest !== input.logicalDigest || existing.requestDigest !== input.requestDigest || !same(existing.authority, input.authority)) return fail("AUTHORITY_DRIFT", "Durable Flux intent no longer matches this exact request and server authority.");
        return { state, value: Object.freeze({ intent: existing, disposition: "replay" as const }) };
      }
      if (freshRejection !== undefined) return fail(freshRejection.code, freshRejection.message, freshRejection.retryable ?? false);
      if (Object.keys(state.intents).length >= this.#maximumIntents) return fail("STORE_CAPACITY", "Flux intent store has reached its intent record limit.");
      const now = new Date().toISOString();
      const payload: Omit<FluxControlIntent, "identity"> = {
        schemaVersion: FLUX_CONTROL_INTENT_SCHEMA_VERSION,
        intentId,
        operation: input.operation,
        idempotencyKey: `fluxctl.${randomUUID().replaceAll("-", "")}`,
        logicalDigest: input.logicalDigest,
        requestDigest: input.requestDigest,
        authority: Object.freeze(structuredClone(input.authority)),
        status: "pending",
        createdAt: now,
        updatedAt: now,
        resultDigest: null,
        lastRequestId: null,
        terminalReceiptIdentity: null,
      };
      const intent = Object.freeze({ ...payload, identity: intentIdentity(payload) });
      const nextPayload = { ...identityPayload(state), revision: state.revision + 1, intents: { ...state.intents, [intentId]: intent } };
      const next = Object.freeze({ ...nextPayload, identity: stateIdentity(nextPayload) });
      return { state: next, value: Object.freeze({ intent, disposition: "fresh" as const }) };
    });
  }

  public async complete(intentId: string, resultDigest: string, requestId: string): Promise<FluxControlIntent> {
    return this.#settle(intentId, "completed", resultDigest, requestId, null);
  }

  public async terminal(intentId: string, resultDigest: string, requestId: string, receiptIdentity: CanonicalIdentity): Promise<FluxControlIntent> {
    return this.#settle(intentId, "terminal", resultDigest, requestId, receiptIdentity);
  }

  async #settle(intentId: string, status: "completed" | "terminal", resultDigest: string, requestId: string, receiptIdentity: CanonicalIdentity | null): Promise<FluxControlIntent> {
    if (!DIGEST.test(resultDigest) || !FLUX_REQUEST_ID_PATTERN.test(requestId)) return fail("INTENT_CONFLICT", "Flux settlement identities are invalid.");
    return this.#withLock(async (state) => {
      const current = state.intents[intentId];
      if (current === undefined) return fail("INTENT_CONFLICT", "Flux intent disappeared before settlement.");
      if (current.status !== "pending" && (current.status !== status || current.resultDigest !== resultDigest || !same(current.terminalReceiptIdentity, receiptIdentity))) {
        return fail("INTENT_CONFLICT", "Flux replay result differs from the consumed durable receipt.");
      }
      const payload: Omit<FluxControlIntent, "identity"> = {
        ...identityPayload(current), status, resultDigest, lastRequestId: requestId,
        terminalReceiptIdentity: receiptIdentity, updatedAt: new Date().toISOString(),
      };
      const settled = Object.freeze({ ...payload, identity: intentIdentity(payload) });
      const nextPayload = { ...identityPayload(state), revision: state.revision + 1, intents: { ...state.intents, [intentId]: settled } };
      return { state: Object.freeze({ ...nextPayload, identity: stateIdentity(nextPayload) }), value: settled };
    });
  }

  public async recordApprovalView(runId: string, subjectDigest: string, authorityDigest: string, requestId: string): Promise<FluxControlApprovalView> {
    return this.#withLock(async (state) => {
      const payload: Omit<FluxControlApprovalView, "identity"> = {
        schemaVersion: FLUX_CONTROL_APPROVAL_VIEW_SCHEMA_VERSION,
        runId: identifier(runId, "Approval runId"),
        subjectDigest: digest(subjectDigest, "Approval subject digest"),
        authorityDigest: digest(authorityDigest, "Approval authority digest"),
        requestId: text(requestId, "Approval requestId", 128),
        observedAt: new Date().toISOString(),
      };
      if (state.approvalViews[payload.runId] === undefined && Object.keys(state.approvalViews).length >= this.#maximumApprovalViews) return fail("STORE_CAPACITY", "Flux intent store has reached its approval-view record limit.");
      const view = Object.freeze({ ...payload, identity: approvalViewIdentity(payload) });
      const nextPayload = { ...identityPayload(state), revision: state.revision + 1, approvalViews: { ...state.approvalViews, [runId]: view } };
      return { state: Object.freeze({ ...nextPayload, identity: stateIdentity(nextPayload) }), value: view };
    });
  }

  public async approvalView(runId: string): Promise<FluxControlApprovalView | undefined> {
    return (await this.#read()).approvalViews[runId];
  }
}

const parseSource = (value: unknown): FluxSourceCatalogDto => {
  const source = record(value, "Flux source");
  exactKeys(source, ["key", "label", "fingerprint"], [], "Flux source");
  const key = identifier(source.key, "Flux source key");
  const label = text(source.label, "Flux source label", 16_384);
  const fingerprint = digest(source.fingerprint, "Flux source fingerprint");
  return Object.freeze({ key, label, fingerprint });
};

const parseProject = (value: unknown): FluxProjectDto => {
  const project = record(value, "Flux project");
  exactKeys(project, ["id", "sourceKey", "name", "createdAt"], [], "Flux project");
  return Object.freeze({
    id: identifier(project.id, "Flux project id"),
    sourceKey: identifier(project.sourceKey, "Flux project source key"),
    name: text(project.name, "Flux project name", 16_384),
    createdAt: timestamp(project.createdAt, "Flux project createdAt"),
  });
};

const parseThread = (value: unknown): FluxThreadDto => {
  const thread = record(value, "Flux thread");
  exactKeys(thread, ["id", "projectId", "title", "createdAt"], [], "Flux thread");
  return Object.freeze({
    id: identifier(thread.id, "Flux thread id"),
    projectId: identifier(thread.projectId, "Flux thread project id"),
    title: text(thread.title, "Flux thread title", 16_384),
    createdAt: timestamp(thread.createdAt, "Flux thread createdAt"),
  });
};

const parsePolicy = (value: unknown): FluxRuntimePolicyDto => {
  const policy = record(value, "Flux policy");
  exactKeys(policy, ["providerModel", "iterationCap", "harnessRuleIdentity", "mutationAllowlist", "freshProjectNamePattern", "checkpointOpenRequiredForFresh", "freshAcceptanceProfileIdentity", "freshPersistenceProfileIdentity"], [], "Flux policy");
  const provider = record(policy.providerModel, "Flux policy provider");
  exactKeys(provider, ["provider", "model", "tier"], [], "Flux policy provider");
  const iterations = record(policy.iterationCap, "Flux iteration policy");
  exactKeys(iterations, ["minimum", "maximum", "recommended"], [], "Flux iteration policy");
  if (iterations.minimum !== PCB_AGENT_MIN_ITERATIONS || iterations.maximum !== PCB_AGENT_MAX_FRESH_ITERATIONS || iterations.recommended !== PCB_AGENT_RECOMMENDED_FRESH_ITERATIONS || policy.freshProjectNamePattern !== "^[a-z][a-z0-9-]{0,63}$" || policy.checkpointOpenRequiredForFresh !== true) {
    return fail("RESPONSE_MALFORMED", "Flux policy differs from the supported client bounds.");
  }
  if (!Array.isArray(policy.mutationAllowlist) || policy.mutationAllowlist.length < 1 || policy.mutationAllowlist.length > 256) return fail("RESPONSE_MALFORMED", "Flux mutation allowlist is invalid.");
  const mutationAllowlist = policy.mutationAllowlist.map((entry) => text(entry, "Flux mutation tool", 1_024));
  if (mutationAllowlist.some((entry) => entry.trim() !== entry) || new Set(mutationAllowlist).size !== mutationAllowlist.length) return fail("RESPONSE_MALFORMED", "Flux mutation allowlist is blank, duplicated, or non-canonical.");
  return Object.freeze({
    providerModel: Object.freeze({ provider: text(provider.provider, "Flux provider", 1_024), model: text(provider.model, "Flux model", 1_024), tier: text(provider.tier, "Flux tier", 1_024) }),
    iterationCap: Object.freeze({ minimum: PCB_AGENT_MIN_ITERATIONS, maximum: PCB_AGENT_MAX_FRESH_ITERATIONS, recommended: PCB_AGENT_RECOMMENDED_FRESH_ITERATIONS }),
    harnessRuleIdentity: text(policy.harnessRuleIdentity, "Flux harness rule identity", 16_384),
    mutationAllowlist: Object.freeze(mutationAllowlist),
    freshProjectNamePattern: "^[a-z][a-z0-9-]{0,63}$" as const,
    checkpointOpenRequiredForFresh: true as const,
    freshAcceptanceProfileIdentity: text(policy.freshAcceptanceProfileIdentity, "Flux acceptance profile identity", 16_384),
    freshPersistenceProfileIdentity: text(policy.freshPersistenceProfileIdentity, "Flux persistence profile identity", 16_384),
  });
};

const parseReadiness = (value: unknown): unknown => {
  const readiness = record(value, "Flux readiness");
  exactKeys(readiness, ["schemaVersion", "configured", "status", "reasonCodes", "provider", "compiler", "toolchain", "kicadMcpRuntime", "diagnostic"], [], "Flux readiness");
  if (readiness.schemaVersion !== "evleda.flux-readiness.v1" || typeof readiness.configured !== "boolean" || !["ready", "setup_required"].includes(String(readiness.status)) || !Array.isArray(readiness.reasonCodes) || readiness.reasonCodes.length > 16 || readiness.reasonCodes.some((entry) => typeof entry !== "string")) {
    return fail("RESPONSE_MALFORMED", "Flux readiness root is invalid.");
  }
  if (readiness.reasonCodes.some((entry) => !readinessReasonCodes.has(entry as string)) || new Set(readiness.reasonCodes).size !== readiness.reasonCodes.length) return fail("RESPONSE_MALFORMED", "Flux readiness reason codes are invalid.");
  if ((readiness.status === "ready") !== readiness.configured) return fail("RESPONSE_MALFORMED", "Flux readiness status contradicts configured state.");
  if (readiness.diagnostic !== null) {
    try { parseFluxDiagnostic(readiness.diagnostic); } catch { return fail("RESPONSE_MALFORMED", "Flux readiness diagnostic is invalid."); }
  }
  if (readiness.status === "setup_required") {
    if (readiness.reasonCodes.length < 1 || readiness.provider !== null || readiness.compiler !== null || readiness.toolchain !== null || readiness.kicadMcpRuntime !== null) return fail("RESPONSE_MALFORMED", "Setup-required readiness retains configured authority.");
    return readiness;
  }
  if (readiness.reasonCodes.length !== 0 || readiness.diagnostic !== null) return fail("RESPONSE_MALFORMED", "Ready Flux contains setup reasons or a diagnostic.");
  try {
  const provider = record(readiness.provider, "Flux readiness provider");
  exactKeys(provider, ["provider", "model", "requestedTier", "canonicalTier", "adapterSchemaVersion", "providerProfileIdentity", "localReadCapability", "configurationPreflight"], [], "Flux readiness provider");
  for (const key of ["provider", "model", "requestedTier", "canonicalTier", "adapterSchemaVersion"]) text(provider[key], `Readiness provider ${key}`, 1_024);
  if (!["openai", "anthropic", "codex", "claude-cli"].includes(String(provider.provider)) || !["standard", "fast", "provider-default"].includes(String(provider.requestedTier)) || !["standard", "priority", "provider-default"].includes(String(provider.canonicalTier))) return fail("RESPONSE_MALFORMED", "Readiness provider or tier is unsupported.");
  validateCanonicalIdentity(provider.providerProfileIdentity, "Readiness provider profile identity");
  if (!["none", "read_only_host_files"].includes(String(provider.localReadCapability))) return fail("RESPONSE_MALFORMED", "Readiness local-read capability is invalid.");
  if (provider.configurationPreflight !== null) {
    const preflight = record(provider.configurationPreflight, "Readiness configuration preflight");
    exactKeys(preflight, ["status", "evidenceIdentity", "capabilityProfileIdentity", "imageInspectionPolicy"], [], "Readiness configuration preflight");
    if (preflight.status !== "passed") return fail("RESPONSE_MALFORMED", "Readiness configuration preflight did not pass.");
    validateCanonicalIdentity(preflight.evidenceIdentity, "Readiness preflight evidence identity"); validateCanonicalIdentity(preflight.capabilityProfileIdentity, "Readiness capability profile identity");
    if (preflight.imageInspectionPolicy !== "disabled_by_pinned_feature") return fail("RESPONSE_MALFORMED", "Readiness image inspection policy is unsupported.");
  }
  if ((provider.provider === "codex") !== (provider.localReadCapability === "read_only_host_files" && provider.configurationPreflight !== null)) return fail("RESPONSE_MALFORMED", "Readiness provider local-read/preflight authority is inconsistent.");
  const compiler = record(readiness.compiler, "Flux readiness compiler");
  exactKeys(compiler, ["profileIdentity", "catalogIdentity", "exactSymbolCount", "exactFootprintCount", "symbolNicknameCount", "footprintNicknameCount"], [], "Flux readiness compiler");
  validateCanonicalIdentity(compiler.profileIdentity, "Readiness compiler profile"); validateCanonicalIdentity(compiler.catalogIdentity, "Readiness catalog identity");
  for (const key of ["exactSymbolCount", "exactFootprintCount", "symbolNicknameCount", "footprintNicknameCount"]) if (!Number.isSafeInteger(compiler[key]) || (compiler[key] as number) < 0) return fail("RESPONSE_MALFORMED", "Readiness compiler count is invalid.");
  const toolchain = record(readiness.toolchain, "Flux readiness toolchain");
  exactKeys(toolchain, ["identity", "kicadCli", "pcbnew"], [], "Flux readiness toolchain"); validateCanonicalIdentity(toolchain.identity, "Readiness toolchain identity");
  const kicad = record(toolchain.kicadCli, "Readiness kicadCli"); exactKeys(kicad, ["identity", "operationalVersion", "operationalCommit", "peFileVersion", "peProductVersion"], [], "Readiness kicadCli"); validateCanonicalIdentity(kicad.identity, "Readiness kicadCli identity");
  for (const key of ["operationalVersion", "operationalCommit", "peFileVersion", "peProductVersion"]) text(kicad[key], `Readiness kicadCli ${key}`, 1_024);
  const pcbnew = record(toolchain.pcbnew, "Readiness pcbnew"); exactKeys(pcbnew, ["identity", "peFileVersion", "peProductVersion"], [], "Readiness pcbnew"); validateCanonicalIdentity(pcbnew.identity, "Readiness pcbnew identity"); text(pcbnew.peFileVersion, "Readiness pcbnew file version", 1_024); text(pcbnew.peProductVersion, "Readiness pcbnew product version", 1_024);
  const kicadMcpRuntime = record(readiness.kicadMcpRuntime, "Flux readiness KiCad MCP runtime"); exactKeys(kicadMcpRuntime, ["identity", "inspectionBridgeIdentity", "executionBridgeIdentity", "connectionPolicy"], [], "Readiness KiCad MCP runtime");
  const runtimeIdentity = validateCanonicalIdentity(kicadMcpRuntime.identity, "Readiness KiCad MCP runtime identity");
  const inspectionBridgeIdentity = validateCanonicalIdentity(kicadMcpRuntime.inspectionBridgeIdentity, "Readiness inspection bridge identity");
  const executionBridgeIdentity = validateCanonicalIdentity(kicadMcpRuntime.executionBridgeIdentity, "Readiness execution bridge identity");
  if (runtimeIdentity.schemaVersion !== "evleda.kicad-mcp-runtime.v1" || inspectionBridgeIdentity.schemaVersion !== "evleda.kicad-mcp-inspection-bridge.v2" || executionBridgeIdentity.schemaVersion !== "evleda.kicad-mcp-execution-bridge.v1") return fail("RESPONSE_MALFORMED", "Readiness KiCad MCP runtime identities have the wrong schema domain.");
  const connectionPolicy = record(kicadMcpRuntime.connectionPolicy, "Readiness KiCad MCP connection policy");
  exactKeys(connectionPolicy, ["maxConnections", "concurrency", "reuse", "restart", "cleanup", "unconfirmed"], [], "Readiness KiCad MCP connection policy");
  if (!same(connectionPolicy, FLUX_CONTROL_KICAD_MCP_CONNECTION_POLICY)) return fail("RESPONSE_MALFORMED", "Readiness KiCad MCP connection policy is unsupported.");
  } catch (error) {
    if (error instanceof FluxControlError) throw error;
    return fail("RESPONSE_MALFORMED", "Ready Flux contains malformed nested authority.");
  }
  return readiness;
};

interface FluxControlKicadMcpAuthority {
  readonly runtimeIdentity: CanonicalIdentity;
  readonly inspectionBridgeIdentity: CanonicalIdentity;
  readonly executionBridgeIdentity: CanonicalIdentity;
  readonly kicadToolchainIdentity: CanonicalIdentity;
}

const kicadMcpAuthorityFromReadiness = (value: unknown): FluxControlKicadMcpAuthority => {
  const readiness = record(value, "Flux parsed readiness");
  if (readiness.status !== "ready") return fail("AUTHORITY_DRIFT", "Flux KiCad MCP authority is not currently ready.");
  const runtime = record(readiness.kicadMcpRuntime, "Flux parsed KiCad MCP runtime");
  const toolchain = record(readiness.toolchain, "Flux parsed KiCad toolchain");
  return Object.freeze({
    runtimeIdentity: validateCanonicalIdentity(runtime.identity, "Flux KiCad MCP runtime identity"),
    inspectionBridgeIdentity: validateCanonicalIdentity(runtime.inspectionBridgeIdentity, "Flux inspection bridge identity"),
    executionBridgeIdentity: validateCanonicalIdentity(runtime.executionBridgeIdentity, "Flux execution bridge identity"),
    kicadToolchainIdentity: validateCanonicalIdentity(toolchain.identity, "Flux KiCad toolchain identity"),
  });
};

const parsePreview = (value: unknown): unknown => {
  const preview = record(value, "Flux preview");
  exactKeys(preview, ["refreshedAt", "artifacts"], [], "Flux preview");
  timestamp(preview.refreshedAt, "Flux preview refreshedAt");
  if (!Array.isArray(preview.artifacts) || preview.artifacts.length > 3) return fail("RESPONSE_MALFORMED", "Flux preview artifact list is invalid.");
  for (const item of preview.artifacts) {
    const artifact = record(item, "Flux preview artifact");
    exactKeys(artifact, ["kind", "mediaType", "sizeBytes", "sha256"], [], "Flux preview artifact");
    if (!["schematic", "pcb_top", "pcb_bottom"].includes(String(artifact.kind)) || !["image/svg+xml", "image/png"].includes(String(artifact.mediaType)) || !Number.isSafeInteger(artifact.sizeBytes) || (artifact.sizeBytes as number) < 0) return fail("RESPONSE_MALFORMED", "Flux preview artifact is invalid.");
    digest(artifact.sha256, "Flux preview digest");
  }
  return preview;
};

const INSPECTION_TOOLS = new Set(["pcb_get_board_summary", "pcb_get_design_rules", "pcb_get_footprints", "pcb_get_tracks", "pcb_get_vias", "pcb_get_zones"]);
const INSPECTION_PHASES: readonly FluxRunDto["phase"][] = ["awaiting_approval", "approved", "completed", "needs_review", "failed", "blocked"];
const RESUME_REPLAY_PHASES: readonly FluxRunDto["phase"][] = ["queued", "running", "completed", "needs_review", "failed", "blocked"];

const inspectionAuthority = (value: PlainRecord): Readonly<Record<string, unknown>> => Object.freeze({
  runId: value.runId,
  inspectionBridgeIdentity: value.inspectionBridgeIdentity,
  executionBridgeIdentity: value.executionBridgeIdentity,
  ipcSocketIdentity: value.ipcSocketIdentity,
  writeSessionAuthorityIdentity: value.writeSessionAuthorityIdentity,
});

const parseInspection = (value: unknown, runId: string, subject: FluxApprovalSubject, kicadAuthority: FluxControlKicadMcpAuthority, baseline?: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
  const inspection = record(value, "Flux inspection");
  const baseKeys = ["runId", "inspectionBridgeIdentity", "executionBridgeIdentity", "ipcSocketIdentity", "writeSessionAuthorityIdentity", "connectionBudget", "state", "busy", "completedTools", "totalTools"];
  if (inspection.state === "idle") {
    exactKeys(inspection, baseKeys, [], "Flux idle inspection");
    if (inspection.busy !== false || inspection.completedTools !== 0 || inspection.totalTools !== 6) return fail("RESPONSE_MALFORMED", "Flux idle inspection is invalid.");
  } else if (inspection.state === "busy") {
    exactKeys(inspection, [...baseKeys, "activeTool"], [], "Flux busy inspection");
    if (inspection.busy !== true || !Number.isSafeInteger(inspection.completedTools) || (inspection.completedTools as number) < 0 || (inspection.completedTools as number) > 6 || inspection.totalTools !== 6 || !INSPECTION_TOOLS.has(String(inspection.activeTool))) return fail("RESPONSE_MALFORMED", "Flux busy inspection is invalid.");
  } else if (inspection.state === "ready") {
    exactKeys(inspection, [...baseKeys, "capturedAt", "boardSummary", "rules", "footprints", "tracks", "vias", "zones"], [], "Flux ready inspection");
    if (inspection.busy !== false || inspection.completedTools !== 6 || inspection.totalTools !== 6) return fail("RESPONSE_MALFORMED", "Flux ready inspection counters are invalid.");
    timestamp(inspection.capturedAt, "Flux inspection capturedAt");
    const toolFields = [[inspection.boardSummary, "pcb_get_board_summary"], [inspection.rules, "pcb_get_design_rules"], [inspection.footprints, "pcb_get_footprints"], [inspection.tracks, "pcb_get_tracks"], [inspection.vias, "pcb_get_vias"], [inspection.zones, "pcb_get_zones"]] as const;
    for (const [entry, expectedTool] of toolFields) {
      const tool = record(entry, "Flux inspection tool");
      exactKeys(tool, ["tool", "value"], [], "Flux inspection tool");
      if (tool.tool !== expectedTool) return fail("RESPONSE_MALFORMED", "Flux inspection tool identity is invalid.");
    }
  } else return fail("RESPONSE_MALFORMED", "Flux inspection state is unsupported.");
  if (identifier(inspection.runId, "Flux inspection runId") !== runId || subject.runId !== runId) return fail("AUTHORITY_DRIFT", "Flux inspection result is bound to a different run.");
  for (const key of ["inspectionBridgeIdentity", "executionBridgeIdentity", "ipcSocketIdentity", "writeSessionAuthorityIdentity"] as const) validateCanonicalIdentity(inspection[key], `Flux inspection ${key}`);
  if (!same(inspection.inspectionBridgeIdentity, subject.inspectionBridgeIdentity) || !same(inspection.executionBridgeIdentity, subject.executionBridgeIdentity)
    || !same(inspection.ipcSocketIdentity, subject.ipcSocketIdentity) || !same(inspection.writeSessionAuthorityIdentity, subject.writeSessionAuthorityIdentity)
    || !same(inspection.inspectionBridgeIdentity, kicadAuthority.inspectionBridgeIdentity) || !same(inspection.executionBridgeIdentity, kicadAuthority.executionBridgeIdentity)) return fail("AUTHORITY_DRIFT", "Flux inspection result differs from the current approved KiCad MCP authority.");
  const budget = record(inspection.connectionBudget, "Flux inspection connection budget"); exactKeys(budget, ["used", "remaining", "limit"], [], "Flux inspection connection budget");
  if (!Number.isSafeInteger(budget.used) || !Number.isSafeInteger(budget.remaining) || (budget.used as number) < 0 || (budget.remaining as number) < 0 || budget.limit !== 8 || (budget.used as number) + (budget.remaining as number) !== 8) return fail("RESPONSE_MALFORMED", "Flux inspection connection budget is invalid.");
  const binding = inspectionAuthority(inspection);
  if (baseline !== undefined && !same(binding, baseline)) return fail("AUTHORITY_DRIFT", "Flux active inspection differs from its immediate status authority.");
  return Object.freeze(inspection);
};

const parseActiveInspection = (value: unknown, runId: string, subject: FluxApprovalSubject, kicadAuthority: FluxControlKicadMcpAuthority, baseline: PlainRecord, allowExactReplay: boolean): Readonly<Record<string, unknown>> => {
  const candidate = record(value, "Flux active inspection");
  if (candidate.state !== "ready") return fail("INCOMPLETE", "Flux active inspection did not return complete ready evidence.", true);
  if (["capturedAt", "boardSummary", "rules", "footprints", "tracks", "vias", "zones"].some((key) => !Object.hasOwn(candidate, key))) return fail("INCOMPLETE", "Flux active inspection omitted one or more required read-tool results.", true);
  const parsed = parseInspection(candidate, runId, subject, kicadAuthority, inspectionAuthority(baseline));
  const before = record(baseline.connectionBudget, "Flux inspection baseline budget");
  const after = record(parsed.connectionBudget, "Flux active inspection budget");
  const advanced = (before.remaining as number) >= 1 && after.limit === before.limit && after.used === (before.used as number) + 1 && after.remaining === (before.remaining as number) - 1;
  if (!advanced && !(allowExactReplay && same(parsed, baseline))) return fail("AUTHORITY_DRIFT", "Flux active inspection neither advanced the current budget nor reproduced its exact durable result.");
  return parsed;
};

const OUTPUT_SECRET = /(?:\b(?:bearer|basic)\s+[A-Za-z0-9._~+\/-]+=*|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}|\b(?:password|authorization|cookie|credential)\s*[:=])/iu;
const OUTPUT_PATH = /(?:^~[\\/]|^[A-Za-z]:[\\/]|^\\\\|^file:|^\/(?:Users|home|tmp|var|etc|opt|private)\/)/iu;
const redactExactPrompt = (value: unknown, prompt: string, depth = 0, key = ""): unknown => {
  if (depth > 64) return "[truncated]";
  if (typeof value === "string") {
    const pointer = ["id", "path", "clarificationId", "contractPath"].includes(key) && /^\/(?:[A-Za-z0-9_.~-]+(?:\/[A-Za-z0-9_.~-]+)*)?$/u.test(value.trim());
    if (OUTPUT_SECRET.test(value) || (OUTPUT_PATH.test(value.trim()) && !pointer)) return "[redacted]";
    return prompt.length === 0 ? value : value.replaceAll(prompt, "[redacted prompt]");
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map((entry) => redactExactPrompt(entry, prompt, depth + 1, key));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, entry]) => [childKey, redactExactPrompt(entry, prompt, depth + 1, childKey)]));
  return null;
};

/** Final defense for JSON-facing callers; exact prompt replacement is optional. */
export const redactFluxControlOutput = (value: unknown, exactPrompt = ""): unknown =>
  redactExactPrompt(value, exactPrompt);

const INSPECTION_PRIVATE_KEY = /(?:path|file|directory|folder|root|workspace|project|output|destination|password|authorization|cookie|credential|privatekey|secret|token)/iu;
const redactInspectionOutput = (value: unknown, prompt: string, depth = 0, key = ""): unknown => {
  if (depth > 64) return "[truncated]";
  if (typeof value === "string") {
    if (INSPECTION_PRIVATE_KEY.test(key) || OUTPUT_SECRET.test(value) || OUTPUT_PATH.test(value.trim())) return "[redacted]";
    return prompt.length === 0 ? value : value.replaceAll(prompt, "[redacted prompt]");
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map((entry) => redactInspectionOutput(entry, prompt, depth + 1, key));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, entry]) => [childKey, redactInspectionOutput(entry, prompt, depth + 1, childKey)]));
  return null;
};

const safeRun = (run: FluxRunDto): Readonly<Record<string, unknown>> => {
  const { prompt, ...safe } = run;
  return Object.freeze({ ...(redactExactPrompt(safe, prompt) as Record<string, unknown>), promptContentIdentity: contentIdentity(prompt) });
};

const stableRunBinding = (run: FluxRunDto): string => fluxDigest({
  id: run.id, projectId: run.projectId, threadId: run.threadId,
  promptContentIdentity: contentIdentity(run.prompt), providerModel: run.providerModel,
  iterationCap: run.iterationCap, harnessRuleIdentity: run.harnessRuleIdentity,
  mutationAllowlist: run.mutationAllowlist,
  freshAcceptanceProfileIdentity: run.freshAcceptanceProfileIdentity,
  freshPersistenceProfileIdentity: run.freshPersistenceProfileIdentity,
  workflowKind: run.workflowKind, createdAt: run.createdAt,
});

const compilationTransitionRunBinding = (run: FluxRunDto): string => fluxDigest({
  id: run.id, projectId: run.projectId, threadId: run.threadId,
  promptContentIdentity: contentIdentity(run.prompt), providerModel: run.providerModel,
  iterationCap: run.iterationCap, mutationAllowlist: run.mutationAllowlist,
  freshPersistenceProfileIdentity: run.freshPersistenceProfileIdentity,
  workflowKind: run.workflowKind, createdAt: run.createdAt,
});

const validateIdentitySchema = (value: unknown, schemaVersion: string, label: string): void => {
  const identity = validateCanonicalIdentity(value, label);
  if (identity.schemaVersion !== schemaVersion) return fail("AUTHORITY_DRIFT", `${label} has the wrong schema domain.`);
};

const assertInterpreterReceiptAuthority = (run: FluxRunDto, expectedClarificationAnswers?: readonly FluxClarificationAnswerDto[]): void => {
  const state = run.contractState;
  if (state === undefined || state.interpreterReceipt.schemaVersion !== "evleda.flux-interpreter-receipt.v2") return fail("AUTHORITY_DRIFT", "Generic compilation lacks a current v2 interpreter receipt.");
  // compiledAt is identity-bound metadata, not proof of operation time. The
  // adapter/compiler/practice/bundle values are one-time public server pins;
  // the localhost runtime revalidates their underlying objects before use.
  const receipt = state.interpreterReceipt; const providerProfile = parsePcbProviderProfileBinding(receipt.providerProfile);
  const { identity, ...payload } = receipt;
  if (receipt.interpreterSchemaVersion !== PCB_DESIGN_INTERPRETER_SCHEMA_VERSION || !same(identity, canonicalIdentity(payload, receipt.schemaVersion)) || !same(receipt.providerProfileIdentity, providerProfile.identity) || receipt.promptDigest !== fluxDigest(run.prompt) || (expectedClarificationAnswers !== undefined && receipt.clarificationDigest !== fluxDigest(expectedClarificationAnswers))
    || receipt.provider !== providerProfile.provider || providerProfile.provider !== run.providerModel.provider || providerProfile.model !== run.providerModel.model || providerProfile.tier !== run.providerModel.tier) return fail("AUTHORITY_DRIFT", "Interpreter receipt differs from prompt or provider authority.");
};

const assertPendingCompilationAuthority = (run: FluxRunDto, policy: FluxRuntimePolicyDto, expectedClarificationAnswers?: readonly FluxClarificationAnswerDto[]): void => {
  if (run.workflowKind !== "generic" || !["draft", "awaiting_clarification"].includes(run.phase) || run.harnessRuleIdentity !== policy.harnessRuleIdentity || run.freshAcceptanceProfileIdentity !== policy.freshAcceptanceProfileIdentity || run.freshPersistenceProfileIdentity !== policy.freshPersistenceProfileIdentity || run.compilationBundleRef !== undefined) return fail("AUTHORITY_DRIFT", "Pending compilation no longer matches exact server policy placeholders.");
  if (run.phase === "draft") {
    if (run.contractState !== undefined) return fail("AUTHORITY_DRIFT", "Draft compilation unexpectedly contains contract authority.");
    return;
  }
  const state = run.contractState;
  if (state === undefined || state.disposition !== "needs_clarification" || state.questions.length < 1 || state.contract !== null || state.contractIdentity !== null || state.libraryBindingIdentity !== null || state.deepRuleBindingIdentity !== null || state.acceptancePlanIdentity !== null || state.deepRuleSummary !== undefined) return fail("AUTHORITY_DRIFT", "Awaiting clarification is not an exact unresolved clarification result.");
  assertInterpreterReceiptAuthority(run, expectedClarificationAnswers);
  const receipt = state.interpreterReceipt;
  if (receipt.schemaVersion !== "evleda.flux-interpreter-receipt.v2" || receipt.bundleIdentity !== null || receipt.compilerProfileIdentity !== null || receipt.practiceProfileBindingIdentity !== null) return fail("AUTHORITY_DRIFT", "Awaiting clarification retains bundle-specific authority.");
};

const assertResolvedCompilationAuthority = (run: FluxRunDto, expectedClarificationAnswers: readonly FluxClarificationAnswerDto[]): void => {
  const state = run.contractState;
  // The public receipt omits the execution-prompt content needed to rederive
  // this harness hash. Accept it once as a canonical server-issued digest only
  // after the complete bundle closure below; every later transition pins it.
  if (run.workflowKind !== "generic" || run.phase !== "contract_ready" || state?.disposition !== "ready" || state.questions.length !== 0 || state.issues.length !== 0 || state.contract === null || state.contractIdentity === null || state.libraryBindingIdentity === null || state.deepRuleBindingIdentity === null || state.acceptancePlanIdentity === null || state.deepRuleSummary === undefined || run.compilationBundleRef === undefined || !DIGEST.test(run.harnessRuleIdentity) || !DIGEST.test(run.freshAcceptanceProfileIdentity)) return fail("AUTHORITY_DRIFT", "Resolved compilation lacks exact contract, bundle, rule, or acceptance authority.");
  assertInterpreterReceiptAuthority(run, expectedClarificationAnswers);
  const receipt = state.interpreterReceipt;
  if (receipt.schemaVersion !== "evleda.flux-interpreter-receipt.v2" || receipt.bundleIdentity === null || receipt.compilerProfileIdentity === null || receipt.practiceProfileBindingIdentity === null) return fail("AUTHORITY_DRIFT", "Resolved compilation receipt lacks bundle-specific identities.");
  validateIdentitySchema(run.compilationBundleRef.bundleIdentity, "evleda.pcb-design-compilation-bundle.v1", "Compilation bundle identity");
  validateIdentitySchema(state.contractIdentity, "evleda.pcb-design-contract.v1", "Compilation contract identity");
  validateIdentitySchema(state.libraryBindingIdentity, "evleda.pcb-library-binding.v1", "Compilation library identity");
  validateIdentitySchema(state.deepRuleBindingIdentity, "evleda.pcb-deep-rule-binding.v1", "Compilation deep-rule identity");
  validateIdentitySchema(state.acceptancePlanIdentity, "evleda.pcb-acceptance-plan.v2", "Compilation acceptance-plan identity");
  validateIdentitySchema(receipt.compilerProfileIdentity, "evleda.pcb-design-compiler-profile.v2", "Compilation compiler-profile identity");
  validateIdentitySchema(receipt.practiceProfileBindingIdentity, "evleda.pcb-practice-profile-binding.v1", "Compilation practice-profile identity");
  const contractIdentity = record(state.contract, "Resolved PCB contract").identity;
  const expectedAcceptance = fluxDigest({ schemaVersion: "evleda.flux.generic-design-acceptance-profile.v1", acceptancePlanIdentity: state.acceptancePlanIdentity, practiceProfileBindingIdentity: receipt.practiceProfileBindingIdentity });
  if (!same(contractIdentity, state.contractIdentity) || !same(run.compilationBundleRef.bundleIdentity, receipt.bundleIdentity) || !same(state.deepRuleSummary.deepRuleBindingIdentity, state.deepRuleBindingIdentity) || run.freshAcceptanceProfileIdentity !== expectedAcceptance) return fail("AUTHORITY_DRIFT", "Resolved compilation child identities or acceptance profile do not close.");
};

const parseCompilationTransition = (value: unknown, before: FluxRunDto, policy: FluxRuntimePolicyDto, expectedClarificationAnswers: readonly FluxClarificationAnswerDto[], label: string): FluxRunDto => {
  const after = projectFluxRunDto(value);
  if (after.id !== before.id || compilationTransitionRunBinding(after) !== compilationTransitionRunBinding(before) || !["awaiting_clarification", "contract_ready"].includes(after.phase)) return fail("AUTHORITY_DRIFT", `${label} result changed immutable non-compilation authority or returned an invalid success phase.`);
  if (after.phase === "contract_ready") {
    assertResolvedCompilationAuthority(after, expectedClarificationAnswers);
    if (before.phase === "contract_ready") {
      if (stableRunBinding(after) !== stableRunBinding(before)) return fail("AUTHORITY_DRIFT", `${label} replay changed pinned resolved identities.`);
    } else {
      assertPendingCompilationAuthority(before, policy);
      if (after.harnessRuleIdentity === before.harnessRuleIdentity || after.freshAcceptanceProfileIdentity === before.freshAcceptanceProfileIdentity) return fail("AUTHORITY_DRIFT", `${label} did not resolve both pending compilation identities.`);
    }
    return after;
  }
  if (stableRunBinding(after) !== stableRunBinding(before)) return fail("AUTHORITY_DRIFT", `${label} changed compilation identities without a ready bundle.`);
  if (after.phase === "awaiting_clarification") assertPendingCompilationAuthority(after, policy, expectedClarificationAnswers);
  return after;
};

const parseRunTransition = (value: unknown, before: FluxRunDto, allowedPhases: readonly FluxRunDto["phase"][], label: string): FluxRunDto => {
  const after = projectFluxRunDto(value);
  if (after.id !== before.id || stableRunBinding(after) !== stableRunBinding(before) || !allowedPhases.includes(after.phase)) return fail("AUTHORITY_DRIFT", `${label} result changed immutable run authority or returned an invalid phase.`);
  return after;
};

const parseApprovalSubject = (value: unknown, run: FluxRunDto, authority: AuthorityContext, kicadAuthority: FluxControlKicadMcpAuthority): Readonly<{ subject: FluxApprovalSubject; digest: string }> => {
  const result = record(value, "Flux approval result");
  exactKeys(result, ["subject", "digest"], [], "Flux approval result");
  const subject = record(result.subject, "Flux approval subject");
  const base = ["schemaVersion", "runId", "workflowKind", "sourceKey", "sourceFingerprint", "isolatedFingerprint", "promptIdentity", "providerModel", "iterationCap", "harnessRuleIdentity", "mutationAllowlist", "freshAcceptanceProfileIdentity", "freshPersistenceProfileIdentity", "contractIdentity", "libraryBindingIdentity", "deepRuleBindingIdentity", "acceptancePlanIdentity", "kicadToolchainIdentity", "inspectionBridgeIdentity", "executionBridgeIdentity", "ipcSocketIdentity", "writeSessionAuthorityIdentity", "ipcProbeSemanticIdentity", "freshNetClassSemanticAuthorityIdentity", "freshProjectOpenPreparedSourceAuthorityIdentity", "freshNetClassPreparationEvidenceIdentity", "openPreflightReceiptIdentity", "openCheckpointReceiptIdentity"];
  const generic = ["compilationBundleRef", "providerProfile", "bundleIdentity", "compilerProfileIdentity", "practiceProfileBindingIdentity", "executionPromptIdentity", "executionPromptContentIdentity"];
  exactKeys(subject, [...base, "compilationBundleRef", "providerProfile", ...(subject.workflowKind === "generic" ? generic.slice(2) : [])], [], "Flux approval subject");
  identifier(subject.runId, "Approval runId"); identifier(subject.sourceKey, "Approval source key"); digest(subject.sourceFingerprint, "Approval source fingerprint"); digest(subject.isolatedFingerprint, "Approval isolated fingerprint");
  if (subject.schemaVersion !== "evleda.flux-approval-subject.v6" || subject.runId !== run.id || subject.workflowKind !== run.workflowKind || subject.iterationCap !== run.iterationCap || subject.harnessRuleIdentity !== run.harnessRuleIdentity || !same(subject.providerModel, run.providerModel) || !same(subject.mutationAllowlist, run.mutationAllowlist) || subject.freshAcceptanceProfileIdentity !== run.freshAcceptanceProfileIdentity || subject.freshPersistenceProfileIdentity !== run.freshPersistenceProfileIdentity) return fail("AUTHORITY_DRIFT", "Flux approval subject differs from the current run authority.");
  try {
    validateContentIdentity(subject.promptIdentity, "Approval prompt identity");
    if (!same(subject.promptIdentity, contentIdentity(run.prompt)) || authority.source === undefined || subject.sourceKey !== authority.source.key || subject.sourceFingerprint !== authority.source.fingerprint) return fail("AUTHORITY_DRIFT", "Flux approval prompt/source identity differs from current authority.");
    for (const key of ["contractIdentity", "libraryBindingIdentity", "deepRuleBindingIdentity", "acceptancePlanIdentity", "kicadToolchainIdentity", "inspectionBridgeIdentity", "executionBridgeIdentity", "ipcSocketIdentity", "writeSessionAuthorityIdentity", "ipcProbeSemanticIdentity", "openPreflightReceiptIdentity", "openCheckpointReceiptIdentity"]) validateCanonicalIdentity(subject[key], `Approval ${key}`);
    if (!same(subject.kicadToolchainIdentity, kicadAuthority.kicadToolchainIdentity) || !same(subject.inspectionBridgeIdentity, kicadAuthority.inspectionBridgeIdentity) || !same(subject.executionBridgeIdentity, kicadAuthority.executionBridgeIdentity)
      || (subject.ipcSocketIdentity as CanonicalIdentity).schemaVersion !== "evleda.kicad-api-socket-binding.v1" || (subject.writeSessionAuthorityIdentity as CanonicalIdentity).schemaVersion !== "evleda.kicad-mcp-session-authority.v1"
      || (subject.ipcProbeSemanticIdentity as CanonicalIdentity).schemaVersion !== "evleda.flux-open-ipc-probe-semantic.v2"
      || (subject.openPreflightReceiptIdentity as CanonicalIdentity).schemaVersion !== "evleda.flux-open-preflight.v5"
      || (subject.openCheckpointReceiptIdentity as CanonicalIdentity).schemaVersion !== "evleda.flux-open-checkpoint.v6") return fail("AUTHORITY_DRIFT", "Flux approval KiCad MCP or Open/checkpoint authority differs from the current v6 chain.");
    if (subject.workflowKind === "generic") {
      const semanticAuthorityIdentity = validateCanonicalIdentity(subject.freshNetClassSemanticAuthorityIdentity, "Approval fresh net-class semantic authority");
      const preparedSourceAuthorityIdentity = validateCanonicalIdentity(subject.freshProjectOpenPreparedSourceAuthorityIdentity, "Approval prepared-source authority");
      const preparationEvidenceIdentity = validateCanonicalIdentity(subject.freshNetClassPreparationEvidenceIdentity, "Approval net-class preparation evidence");
      if (semanticAuthorityIdentity.schemaVersion !== "evleda.fresh-netclass-semantic-authority.v2" || preparedSourceAuthorityIdentity.schemaVersion !== "evleda.fresh-project-open-prepared-source-authority.v1" || preparationEvidenceIdentity.schemaVersion !== "evleda.fresh-netclass-preparation-evidence.v2") return fail("AUTHORITY_DRIFT", "Generic approval lacks current semantic, prepared-source, or preparation-evidence authority.");
      const bundleRef = parsePcbDesignCompilationBundleRef(subject.compilationBundleRef);
      const providerProfile = parsePcbProviderProfileBinding(subject.providerProfile);
      for (const key of ["bundleIdentity", "compilerProfileIdentity", "practiceProfileBindingIdentity", "executionPromptIdentity"]) validateCanonicalIdentity(subject[key], `Approval ${key}`);
      validateContentIdentity(subject.executionPromptContentIdentity, "Approval execution prompt content identity");
      const state = run.contractState;
      if (run.compilationBundleRef === undefined || state?.disposition !== "ready" || state.contract === null || state.contractIdentity === null || state.libraryBindingIdentity === null || state.deepRuleBindingIdentity === null || state.acceptancePlanIdentity === null || state.interpreterReceipt.schemaVersion !== "evleda.flux-interpreter-receipt.v2") return fail("AUTHORITY_DRIFT", "Generic approval requires the run's complete v2 compilation authority.");
      const receipt = state.interpreterReceipt;
      const { identity: receiptIdentity, ...receiptPayload } = receipt;
      const contractRecord = record(state.contract, "Flux ready contract");
      const exactAuthority = [
        [bundleRef, run.compilationBundleRef], [bundleRef.bundleIdentity, subject.bundleIdentity], [subject.bundleIdentity, receipt.bundleIdentity],
        [providerProfile, receipt.providerProfile], [providerProfile.identity, receipt.providerProfileIdentity],
        [subject.compilerProfileIdentity, receipt.compilerProfileIdentity], [subject.practiceProfileBindingIdentity, receipt.practiceProfileBindingIdentity],
        [subject.contractIdentity, state.contractIdentity], [subject.libraryBindingIdentity, state.libraryBindingIdentity],
        [subject.deepRuleBindingIdentity, state.deepRuleBindingIdentity], [subject.acceptancePlanIdentity, state.acceptancePlanIdentity],
        [state.contractIdentity, contractRecord.identity], [receiptIdentity, canonicalIdentity(receiptPayload, receipt.schemaVersion)],
      ] as const;
      if (exactAuthority.some(([left, right]) => right === null || !same(left, right)) || state.questions.length !== 0 || state.issues.length !== 0 ||
        receipt.promptDigest !== fluxDigest(run.prompt) || receipt.provider !== providerProfile.provider || providerProfile.provider !== run.providerModel.provider || providerProfile.model !== run.providerModel.model || providerProfile.tier !== run.providerModel.tier) {
        return fail("AUTHORITY_DRIFT", "Flux approval compilation artifacts differ from the run's authenticated interpreter receipt.");
      }
    } else if (subject.compilationBundleRef !== null || subject.providerProfile !== null || subject.freshNetClassSemanticAuthorityIdentity !== null || subject.freshProjectOpenPreparedSourceAuthorityIdentity !== null || subject.freshNetClassPreparationEvidenceIdentity !== null) return fail("RESPONSE_MALFORMED", "LED approval subject has generic authority fields.");
  } catch (error) {
    if (error instanceof FluxControlError) throw error;
    return fail("RESPONSE_MALFORMED", "Flux approval subject contains invalid identities.");
  }
  const suppliedDigest = digest(result.digest, "Flux approval digest");
  const expectedDigest = approvalSubjectDigest(subject as unknown as FluxApprovalSubject);
  if (!constantTimeDigestEqual(suppliedDigest, expectedDigest)) return fail("RESPONSE_MALFORMED", "Flux approval digest does not reproduce from its exact subject.");
  return Object.freeze({ subject: subject as unknown as FluxApprovalSubject, digest: suppliedDigest });
};

export interface FluxControlCommandResult<Result = unknown> {
  readonly requestId: string;
  readonly result: Result;
  readonly intent?: Readonly<{ readonly intentId: string; readonly idempotencyKey: string; readonly status: FluxControlIntent["status"] }>;
}

interface AuthorityContext {
  readonly binding: FluxControlAuthorityBinding;
  readonly policy: FluxRuntimePolicyDto;
  readonly source?: FluxSourceCatalogDto;
  readonly project?: FluxProjectDto;
  readonly thread?: FluxThreadDto;
  readonly run?: FluxRunDto;
}

interface RunMutationSpec<Result> {
  readonly intentOperation: FluxControlIntentOperation;
  readonly routeOperation: string;
  readonly routeSuffix: string;
  readonly body: unknown;
  readonly allowedInitialPhases: readonly FluxRunDto["phase"][];
  readonly parseResult: (value: unknown, run: FluxRunDto, policy: FluxRuntimePolicyDto) => Result | Promise<Result>;
  readonly terminalAnswers?: readonly FluxClarificationAnswerDto[];
}

export interface FluxControlClientOptions extends FluxControlTransportOptions {
  readonly intentStore: FluxControlIntentStore;
}

export class FluxControlClient {
  public readonly baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #store: FluxControlIntentStore;
  readonly #responseOptions: Pick<FluxControlTransportOptions, "responseBytes" | "responseChunks" | "responseChunkBytes">;

  public constructor(options: FluxControlClientOptions) {
    this.baseUrl = normalizeFluxControlBaseUrl(options.baseUrl, options.allowRemoteHttps);
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== "function") fail("INPUT_INVALID", "Flux control requires a fetch implementation.");
    this.#store = options.intentStore;
    this.#responseOptions = {
      ...(options.responseBytes === undefined ? {} : { responseBytes: options.responseBytes }),
      ...(options.responseChunks === undefined ? {} : { responseChunks: options.responseChunks }),
      ...(options.responseChunkBytes === undefined ? {} : { responseChunkBytes: options.responseChunkBytes }),
    };
  }

  async #exchange(method: "GET" | "POST", route: string, operation: string, body?: unknown, idempotencyKey?: string): Promise<ParsedEnvelope> {
    const url = new URL(route, `${this.baseUrl}/`);
    if (url.origin !== this.baseUrl || !url.pathname.startsWith("/api/v1/")) return fail("UNSAFE_BASE_URL", "Flux route escaped its bound API origin.");
    const controller = new AbortController();
    const deadlineMs = requestTimeoutForOperation(operation);
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    try {
      const response = await this.#fetch(url, {
        method,
        redirect: "error",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          ...(method === "POST" ? { "content-type": "application/json", "idempotency-key": idempotencyKey! } : {}),
        },
        ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
      });
      return await parseFluxControlResponse(response, operation, this.#responseOptions);
    } catch (error) {
      if (error instanceof FluxControlError) throw error;
      throw new FluxControlError("TRANSPORT_FAILED", "Flux request did not return a trusted response.", true);
    } finally { clearTimeout(timer); }
  }

  async #read<Result>(route: string, operation: string, parser: (value: unknown) => Result): Promise<FluxControlCommandResult<Result>> {
    const envelope = await this.#exchange("GET", route, operation);
    if (!envelope.ok) throw new FluxControlRemoteError(envelope.status, envelope.requestId, envelope.error);
    try { return Object.freeze({ requestId: envelope.requestId, result: parser(envelope.result) }); }
    catch (error) {
      if (error instanceof FluxControlError) throw error;
      return fail("RESPONSE_MALFORMED", "Flux success result failed its closed command schema.");
    }
  }

  public async readiness(): Promise<FluxControlCommandResult> { return this.#read("/api/v1/flux/readiness", "flux_readiness", parseReadiness); }
  public async policy(): Promise<FluxControlCommandResult<FluxRuntimePolicyDto>> { return this.#read("/api/v1/flux/policy", "flux_policy", parsePolicy); }
  public async sources(): Promise<FluxControlCommandResult<readonly FluxSourceCatalogDto[]>> {
    return this.#read("/api/v1/flux/sources", "flux_sources", (value) => {
      if (!Array.isArray(value) || value.length > 1_024) return fail("RESPONSE_MALFORMED", "Flux sources result is invalid.");
      return Object.freeze(value.map(parseSource));
    });
  }
  public async projects(): Promise<FluxControlCommandResult<readonly FluxProjectDto[]>> {
    return this.#read("/api/v1/flux/projects", "flux_projects", (value) => {
      const wrapper = record(value, "Flux projects result"); exactKeys(wrapper, ["projects"], [], "Flux projects result");
      if (!Array.isArray(wrapper.projects) || wrapper.projects.length > 10_000) return fail("RESPONSE_MALFORMED", "Flux project list is invalid.");
      return Object.freeze(wrapper.projects.map(parseProject));
    });
  }
  public async threads(projectId: string): Promise<FluxControlCommandResult<readonly FluxThreadDto[]>> {
    const id = inputIdentifier(projectId, "projectId");
    return this.#read(`/api/v1/flux/projects/${id}/threads`, "flux_threads", (value) => {
      const wrapper = record(value, "Flux threads result"); exactKeys(wrapper, ["threads"], [], "Flux threads result");
      if (!Array.isArray(wrapper.threads) || wrapper.threads.length > 10_000) return fail("RESPONSE_MALFORMED", "Flux thread list is invalid.");
      const threads = wrapper.threads.map(parseThread);
      if (threads.some((thread) => thread.projectId !== id)) return fail("AUTHORITY_DRIFT", "Flux thread result crossed project authority.");
      return Object.freeze(threads);
    });
  }
  public async status(runId: string): Promise<FluxControlCommandResult<Readonly<Record<string, unknown>>>> {
    const id = inputIdentifier(runId, "runId");
    const current = await this.#rawRun(id); await this.#assertRunReportAuthority(id, current.run);
    return Object.freeze({ requestId: current.requestId, result: safeRun(current.run) });
  }

  async #rawRun(runId: string): Promise<Readonly<{ requestId: string; run: FluxRunDto }>> {
    const id = inputIdentifier(runId, "runId");
    const result = await this.#read(`/api/v1/flux/runs/${id}`, "flux_get_run", (value) => {
      const run = projectFluxRunDto(value);
      if (run.id !== id) return fail("AUTHORITY_DRIFT", "ID-addressed run read returned another run.");
      return run;
    });
    return Object.freeze({ requestId: result.requestId, run: result.result });
  }

  async #authorityForRun(run: FluxRunDto, compilationTransition = false): Promise<AuthorityContext> {
    const [policyResult, projectResult, sourceResult, threadResult] = await Promise.all([this.policy(), this.projects(), this.sources(), this.threads(run.projectId)]);
    const project = projectResult.result.find((entry) => entry.id === run.projectId);
    const thread = threadResult.result.find((entry) => entry.id === run.threadId);
    if (project === undefined || thread === undefined) return fail("AUTHORITY_DRIFT", "Run project or thread is absent from current server authority.");
    const source = sourceResult.result.find((entry) => entry.key === project.sourceKey);
    if (source === undefined) return fail("AUTHORITY_DRIFT", "Run source is absent from current server authority.");
    const binding: FluxControlAuthorityBinding = Object.freeze({
      baseUrl: this.baseUrl,
      policyDigest: fluxDigest(policyResult.result),
      sourceKey: source.key,
      sourceFingerprint: source.fingerprint,
      projectDigest: fluxDigest(project),
      threadDigest: fluxDigest(thread),
      runDigest: compilationTransition ? compilationTransitionRunBinding(run) : stableRunBinding(run),
    });
    return Object.freeze({ binding, policy: policyResult.result, source, project, thread, run });
  }

  async #authorityForSource(sourceKey: string): Promise<AuthorityContext> {
    const [policyResult, sourceResult] = await Promise.all([this.policy(), this.sources()]);
    const source = sourceResult.result.find((entry) => entry.key === sourceKey);
    if (source === undefined) return fail("AUTHORITY_DRIFT", "Requested source is absent from current server authority.");
    return Object.freeze({
      policy: policyResult.result,
      source,
      binding: Object.freeze({ baseUrl: this.baseUrl, policyDigest: fluxDigest(policyResult.result), sourceKey: source.key, sourceFingerprint: source.fingerprint, projectDigest: null, threadDigest: null, runDigest: null }),
    });
  }

  async #mutate<Result>(spec: Readonly<{
    intentOperation: FluxControlIntentOperation;
    routeOperation: string;
    route: string;
    body: unknown;
    authority: AuthorityContext;
    allowedInitialPhases?: readonly FluxRunDto["phase"][];
    parseResult: (value: unknown, admission: FluxControlIntentAdmission) => Result | Promise<Result>;
    terminalAnswers?: readonly FluxClarificationAnswerDto[];
    logicalRequest?: unknown;
    freshAdmissionRejection?: FluxControlFreshAdmissionRejection;
    admission?: FluxControlIntentAdmission;
  }>): Promise<FluxControlCommandResult<Result>> {
    const requestDigest = fluxDigest({ method: "POST", route: spec.route, body: spec.body });
    const input: FluxControlIntentInput = { operation: spec.intentOperation, logicalDigest: fluxDigest(spec.logicalRequest ?? { route: spec.route, body: spec.body }), requestDigest, authority: spec.authority.binding };
    const phaseRejection: FluxControlFreshAdmissionRejection | undefined = spec.allowedInitialPhases !== undefined && (spec.authority.run === undefined || !spec.allowedInitialPhases.includes(spec.authority.run.phase))
      ? { code: "PHASE_MISMATCH", message: `Command ${spec.intentOperation} is not allowed from server phase ${spec.authority.run?.phase ?? "unbound"}.` }
      : undefined;
    const admission = spec.admission ?? await this.#store.beginWithDisposition(input, phaseRejection ?? spec.freshAdmissionRejection);
    if (admission.intent.operation !== input.operation || admission.intent.logicalDigest !== input.logicalDigest || admission.intent.requestDigest !== input.requestDigest || !same(admission.intent.authority, input.authority)) return fail("AUTHORITY_DRIFT", "Pre-admitted Flux intent differs from the exact mutation request.");
    const intent = admission.intent;
    const envelope = await this.#exchange("POST", spec.route, spec.routeOperation, spec.body, intent.idempotencyKey);
    if (!envelope.ok) {
      const terminal = envelope.error.terminalFailureReceipt;
      if (terminal !== undefined && spec.authority.run !== undefined && (spec.intentOperation === "interpret_run" || spec.intentOperation === "clarify_run" || spec.intentOperation === "checkpoint_open")) {
        const verified = await this.#verifyTerminalReceipt(terminal, envelope.error, intent, spec.authority.run, spec.terminalAnswers ?? []);
        await this.#store.terminal(intent.intentId, fluxDigest({ errorCode: envelope.error.code, receipt: verified }), envelope.requestId, verified.identity);
      }
      throw new FluxControlRemoteError(envelope.status, envelope.requestId, envelope.error);
    }
    let result: Result;
    try { result = await spec.parseResult(envelope.result, admission); }
    catch (error) {
      if (error instanceof FluxControlError) throw error;
      return fail("RESPONSE_MALFORMED", "Flux mutation result failed its closed command schema.");
    }
    const settled = await this.#store.complete(intent.intentId, fluxDigest(result), envelope.requestId);
    return Object.freeze({ requestId: envelope.requestId, result, intent: Object.freeze({ intentId: settled.intentId, idempotencyKey: settled.idempotencyKey, status: settled.status }) });
  }

  async #verifyTerminalReceipt(receiptInput: FluxTerminalFailureReceiptDto, failure: FluxControlRemoteFailure, intent: FluxControlIntent, run: FluxRunDto, answers: readonly FluxClarificationAnswerDto[]): Promise<FluxTerminalFailureReceiptDto> {
    if (intent.operation === "checkpoint_open") return this.#verifyCheckpointTerminalReceipt(receiptInput, failure, intent, run);
    const receipt = record(receiptInput, "Flux terminal receipt");
    exactKeys(receipt, ["schemaVersion", "operation", "idempotencyKey", "requestDigest", "projectId", "threadId", "runId", "diagnosticIdentity", "terminalPhase", "outcome", "completedAt", "identity"], [], "Flux terminal receipt");
    const expectedOperation: "interpret_run" | "clarify_run" = intent.operation === "interpret_run" ? "interpret_run" : "clarify_run";
    if (receipt.schemaVersion !== FLUX_TERMINAL_FAILURE_RECEIPT_SCHEMA_VERSION || receipt.operation !== expectedOperation || receipt.idempotencyKey !== intent.idempotencyKey || receipt.projectId !== run.projectId || receipt.threadId !== run.threadId || receipt.runId !== run.id || receipt.terminalPhase !== "blocked" || receipt.outcome !== "failed") return fail("RESPONSE_MALFORMED", "Flux terminal receipt is misbound.");
    const expectedRequestDigest = fluxDigest({ runId: run.id, answers });
    if (receipt.requestDigest !== expectedRequestDigest || failure.diagnostic === undefined) return fail("RESPONSE_MALFORMED", "Flux terminal receipt request or diagnostic authority is missing.");
    const diagnosticIdentity = canonicalIdentity(failure.diagnostic, FLUX_TERMINAL_FAILURE_DIAGNOSTIC_SCHEMA_VERSION);
    if (!same(receipt.diagnosticIdentity, diagnosticIdentity)) return fail("RESPONSE_MALFORMED", "Flux terminal receipt diagnostic identity differs from the current response.");
    const completedAt = timestamp(receipt.completedAt, "Flux terminal completedAt");
    const payload = {
      schemaVersion: FLUX_TERMINAL_FAILURE_RECEIPT_SCHEMA_VERSION,
      operation: expectedOperation,
      idempotencyKey: intent.idempotencyKey,
      requestDigest: expectedRequestDigest,
      projectId: run.projectId,
      threadId: run.threadId,
      runId: run.id,
      diagnosticIdentity,
      terminalPhase: "blocked" as const,
      outcome: "failed" as const,
      completedAt,
    };
    const identity = canonicalIdentity(payload, FLUX_TERMINAL_FAILURE_RECEIPT_SCHEMA_VERSION);
    if (!same(receipt.identity, identity)) return fail("RESPONSE_MALFORMED", "Flux terminal receipt identity does not reproduce.");
    const current = (await this.#rawRun(run.id)).run;
    if (current.phase !== "blocked" || current.projectId !== run.projectId || current.threadId !== run.threadId || current.updatedAt !== completedAt || current.diagnostic === undefined || !same(current.diagnostic, failure.diagnostic)) return fail("AUTHORITY_DRIFT", "Flux terminal receipt is not authenticated by current server state.");
    return Object.freeze({ ...payload, identity });
  }

  async #verifyCheckpointTerminalReceipt(receipt: FluxTerminalFailureReceiptDto, failure: FluxControlRemoteFailure, intent: FluxControlIntent, run: FluxRunDto): Promise<FluxCheckpointFailureReceiptDto> {
    if (receipt.schemaVersion !== FLUX_CHECKPOINT_FAILURE_RECEIPT_SCHEMA_VERSION || receipt.operation !== "checkpoint_open" || receipt.idempotencyKey !== intent.idempotencyKey || receipt.requestDigest !== fluxDigest({ runId: run.id }) || receipt.projectId !== run.projectId || receipt.threadId !== run.threadId || receipt.runId !== run.id || failure.code !== "OPERATION_UNCERTAIN" || failure.retryable !== false || failure.diagnostic !== undefined) return fail("RESPONSE_MALFORMED", "Flux checkpoint terminal receipt is misbound.");
    const message = checkpointFailureMessage(receipt.failureIdentity);
    const current = (await this.#rawRun(run.id)).run;
    if (current.phase !== "blocked" || current.checkpointRequired !== true || current.updatedAt !== receipt.completedAt || current.blockedReason !== message
      || stableRunBinding(current) !== stableRunBinding(run) || !same(current.compilationBundleRef ?? null, run.compilationBundleRef ?? null) || !same(current.contractState ?? null, run.contractState ?? null)
      || current.reports.length !== 0 || current.approval !== undefined) return fail("AUTHORITY_DRIFT", "Flux checkpoint terminal receipt is not authenticated by current server state.");
    return receipt;
  }

  public async createProject(sourceKeyInput: string, nameInput: string): Promise<FluxControlCommandResult<FluxProjectDto>> {
    const sourceKey = inputIdentifier(sourceKeyInput, "sourceKey");
    const name = normalizedTextInput(nameInput, "Project name", 16_384);
    const authority = await this.#authorityForSource(sourceKey);
    return this.#mutate({ intentOperation: "create_project", routeOperation: "flux_create_project", route: "/api/v1/flux/projects", body: { sourceKey, name }, authority, parseResult: (value) => {
      const project = parseProject(value);
      if (project.sourceKey !== sourceKey || project.name !== name) return fail("AUTHORITY_DRIFT", "Created project receipt differs from the exact request.");
      return project;
    } });
  }

  public async createThread(projectIdInput: string, titleInput: string): Promise<FluxControlCommandResult<FluxThreadDto>> {
    const projectId = inputIdentifier(projectIdInput, "projectId");
    const title = normalizedTextInput(titleInput, "Thread title", 16_384);
    const [policyResult, projectResult, sourceResult] = await Promise.all([this.policy(), this.projects(), this.sources()]);
    const project = projectResult.result.find((entry) => entry.id === projectId);
    if (project === undefined) return fail("AUTHORITY_DRIFT", "Thread project is absent from current server authority.");
    const source = sourceResult.result.find((entry) => entry.key === project.sourceKey);
    if (source === undefined) return fail("AUTHORITY_DRIFT", "Thread source is absent from current server authority.");
    const authority: AuthorityContext = { policy: policyResult.result, project, source, binding: { baseUrl: this.baseUrl, policyDigest: fluxDigest(policyResult.result), sourceKey: source.key, sourceFingerprint: source.fingerprint, projectDigest: fluxDigest(project), threadDigest: null, runDigest: null } };
    return this.#mutate({ intentOperation: "create_thread", routeOperation: "flux_create_thread", route: `/api/v1/flux/projects/${projectId}/threads`, body: { title }, authority, parseResult: (value) => {
      const thread = parseThread(value); if (thread.projectId !== projectId || thread.title !== title) return fail("AUTHORITY_DRIFT", "Created thread receipt differs from the exact request."); return thread;
    } });
  }

  public async createGenericRun(projectIdInput: string, threadIdInput: string, promptInput: string, iterations?: number): Promise<FluxControlCommandResult<Readonly<Record<string, unknown>>>> {
    const projectId = inputIdentifier(projectIdInput, "projectId"); const threadId = inputIdentifier(threadIdInput, "threadId");
    const prompt = normalizedTextInput(promptInput, "Prompt", FLUX_CONTROL_LIMITS.promptBytes);
    if (prompt.length > 16_384) return fail("INPUT_INVALID", "Prompt exceeds the server character limit.");
    const [policyResult, projectResult, threadResult, sourceResult, readinessResult] = await Promise.all([this.policy(), this.projects(), this.threads(projectId), this.sources(), this.readiness()]);
    const readiness = record(readinessResult.result, "Flux readiness");
    if (readiness.status !== "ready" || readiness.configured !== true) return fail("PHASE_MISMATCH", "Flux server is not ready for a generic run.");
    const policy = policyResult.result; const project = projectResult.result.find((entry) => entry.id === projectId); const thread = threadResult.result.find((entry) => entry.id === threadId);
    const readinessProvider = record(readiness.provider, "Flux readiness provider");
    if (readinessProvider.provider !== policy.providerModel.provider || readinessProvider.model !== policy.providerModel.model || readinessProvider.canonicalTier !== policy.providerModel.tier) return fail("AUTHORITY_DRIFT", "Flux readiness provider authority differs from active run policy.");
    if (project === undefined || thread === undefined) return fail("AUTHORITY_DRIFT", "Generic run project/thread authority is absent.");
    const source = sourceResult.result.find((entry) => entry.key === project.sourceKey); if (source === undefined) return fail("AUTHORITY_DRIFT", "Generic run source authority is absent.");
    const iterationCap = iterations ?? policy.iterationCap.recommended;
    if (!Number.isSafeInteger(iterationCap) || iterationCap < policy.iterationCap.minimum || iterationCap > policy.iterationCap.maximum) return fail("INPUT_INVALID", "Iteration cap is outside current server policy.");
    const body = { projectId, threadId, prompt, providerModel: policy.providerModel, iterationCap, harnessRuleIdentity: policy.harnessRuleIdentity, mutationAllowlist: policy.mutationAllowlist, freshAcceptanceProfileIdentity: policy.freshAcceptanceProfileIdentity, freshPersistenceProfileIdentity: policy.freshPersistenceProfileIdentity, workflowKind: "generic" as const };
    const authority: AuthorityContext = { policy, project, thread, source, binding: { baseUrl: this.baseUrl, policyDigest: fluxDigest(policy), sourceKey: source.key, sourceFingerprint: source.fingerprint, projectDigest: fluxDigest(project), threadDigest: fluxDigest(thread), runDigest: null } };
    return this.#mutate({ intentOperation: "create_generic_run", routeOperation: "flux_create_run", route: "/api/v1/flux/runs", body, logicalRequest: { projectId, threadId, promptContentIdentity: contentIdentity(prompt), iterations: iterations ?? "server-recommended" }, authority, parseResult: (value) => {
      const run = projectFluxRunDto(value);
      if (run.projectId !== projectId || run.threadId !== threadId || run.workflowKind !== "generic" || run.prompt !== prompt || run.phase !== "draft"
        || !same(run.providerModel, policy.providerModel) || run.iterationCap !== iterationCap || run.harnessRuleIdentity !== policy.harnessRuleIdentity
        || !same(run.mutationAllowlist, policy.mutationAllowlist) || run.freshAcceptanceProfileIdentity !== policy.freshAcceptanceProfileIdentity
        || run.freshPersistenceProfileIdentity !== policy.freshPersistenceProfileIdentity || run.contractState !== undefined
        || run.compilationBundleRef !== undefined || run.preview !== undefined || run.approval !== undefined || run.reports.length !== 0
        || run.blockedReason !== undefined || run.diagnostic !== undefined) return fail("AUTHORITY_DRIFT", "Created generic run differs from its exact server-policy request.");
      return safeRun(run);
    } });
  }

  async #runMutation<Result>(runIdInput: string, spec: RunMutationSpec<Result>): Promise<FluxControlCommandResult<Result>> {
    const runId = inputIdentifier(runIdInput, "runId"); const current = await this.#rawRun(runId); const authority = await this.#authorityForRun(current.run, spec.intentOperation === "interpret_run" || spec.intentOperation === "clarify_run");
    if (current.run.workflowKind !== "generic") return fail("PHASE_MISMATCH", "Flux control mutating commands operate on generic runs only.");
    return this.#mutate({ ...spec, route: `/api/v1/flux/runs/${runId}${spec.routeSuffix}`, authority, parseResult: (value) => spec.parseResult(value, current.run, authority.policy) });
  }

  public async interpret(runId: string): Promise<FluxControlCommandResult<Readonly<Record<string, unknown>>>> {
    return this.#runMutation(runId, { intentOperation: "interpret_run", routeOperation: "flux_interpret", routeSuffix: "/interpret", body: {}, allowedInitialPhases: ["draft"], terminalAnswers: [], parseResult: (value, before, policy) => safeRun(parseCompilationTransition(value, before, policy, [], "Interpret")) });
  }

  public async answerClarifications(runId: string, answersInput: readonly FluxClarificationAnswerDto[]): Promise<FluxControlCommandResult<Readonly<Record<string, unknown>>>> {
    if (!Array.isArray(answersInput) || answersInput.length < 1 || answersInput.length > 128) return fail("INPUT_INVALID", "Clarification answers must be a non-empty bounded array.");
    const answers = answersInput.map((entry) => ({ id: normalizedTextInput(entry.id, "Clarification id", 1_024), answer: normalizedTextInput(entry.answer, "Clarification answer", 16_384) }));
    if (new Set(answers.map((entry) => entry.id)).size !== answers.length) return fail("INPUT_INVALID", "Clarification answer ids must be unique.");
    return this.#runMutation(runId, { intentOperation: "clarify_run", routeOperation: "flux_clarify", routeSuffix: "/clarifications", body: { answers }, allowedInitialPhases: ["awaiting_clarification"], terminalAnswers: answers, parseResult: (value, before, policy) => safeRun(parseCompilationTransition(value, before, policy, answers, "Clarification")) });
  }

  public async prepare(runId: string): Promise<FluxControlCommandResult<Readonly<Record<string, unknown>>>> {
    return this.#runMutation(runId, { intentOperation: "prepare_run", routeOperation: "flux_prepare", routeSuffix: "/prepare", body: {}, allowedInitialPhases: ["contract_ready"], parseResult: (value, before) => safeRun(parseRunTransition(value, before, ["awaiting_open", "awaiting_approval"], "Prepare")) });
  }

  public async open(runIdInput: string): Promise<FluxControlCommandResult> {
    const runId = inputIdentifier(runIdInput, "runId"); const current = await this.#rawRun(runId); const authority = await this.#authorityForRun(current.run);
    if (current.run.workflowKind !== "generic") return fail("PHASE_MISMATCH", "Open is limited to generic runs.");
    return this.#mutate({ intentOperation: "open_project", routeOperation: "flux_open", route: `/api/v1/flux/projects/${current.run.projectId}/open`, body: { runId }, authority, allowedInitialPhases: ["awaiting_open"], parseResult: async (value) => {
      const result = record(value, "Flux open result"); exactKeys(result, ["opened", "label", "checkpointRequired"], [], "Flux open result"); if (result.opened !== true || result.label !== "Opened isolated candidate in KiCad PCB Editor" || typeof result.checkpointRequired !== "boolean") return fail("RESPONSE_MALFORMED", "Flux open result did not match the fixed server confirmation.");
      const after = (await this.#rawRun(runId)).run; parseRunTransition(after, current.run, [result.checkpointRequired ? "awaiting_checkpoint" : "awaiting_approval"], "Open"); return result;
    } });
  }

  public async checkpoint(runId: string): Promise<FluxControlCommandResult<Readonly<Record<string, unknown>>>> {
    return this.#runMutation(runId, { intentOperation: "checkpoint_open", routeOperation: "flux_checkpoint_open", routeSuffix: "/checkpoint-open", body: {}, allowedInitialPhases: ["awaiting_checkpoint"], parseResult: (value, before) => safeRun(parseRunTransition(value, before, ["awaiting_approval"], "Checkpoint")) });
  }

  public async approvalSubject(runIdInput: string): Promise<FluxControlCommandResult<Readonly<{ subject: FluxApprovalSubject; digest: string }>>> {
    const runId = inputIdentifier(runIdInput, "runId"); const current = await this.#rawRun(runId); const [authority, readiness] = await Promise.all([this.#authorityForRun(current.run), this.readiness()]);
    if (current.run.workflowKind !== "generic" || !["awaiting_approval", "approved", "completed", "needs_review", "failed", "blocked"].includes(current.run.phase)) return fail("PHASE_MISMATCH", "Approval subject is unavailable before checkpoint authority exists.");
    const kicadAuthority = kicadMcpAuthorityFromReadiness(readiness.result);
    const response = await this.#read(`/api/v1/flux/runs/${runId}/approval`, "flux_approval_subject", (value) => parseApprovalSubject(value, current.run, authority, kicadAuthority));
    await this.#store.recordApprovalView(runId, response.result.digest, fluxDigest(authority.binding), response.requestId);
    return response;
  }

  public async approve(runIdInput: string, presentedDigest: string): Promise<FluxControlCommandResult<Readonly<Record<string, unknown>>>> {
    const runId = inputIdentifier(runIdInput, "runId");
    if (!DIGEST.test(presentedDigest)) return fail("INPUT_INVALID", "Presented approval digest must be an exact SHA-256 digest.");
    const exactDigest = presentedDigest;
    const current = await this.#rawRun(runId); const [authority, readiness] = await Promise.all([this.#authorityForRun(current.run), this.readiness()]);
    if (current.run.workflowKind !== "generic") return fail("PHASE_MISMATCH", "Approval is limited to generic runs.");
    const kicadAuthority = kicadMcpAuthorityFromReadiness(readiness.result);
    const currentSubjectResponse = await this.#read(`/api/v1/flux/runs/${runId}/approval`, "flux_approval_subject", (value) => parseApprovalSubject(value, current.run, authority, kicadAuthority));
    const view = await this.#store.approvalView(runId);
    if (view === undefined || !constantTimeDigestEqual(view.subjectDigest, exactDigest) || !constantTimeDigestEqual(currentSubjectResponse.result.digest, exactDigest) || view.authorityDigest !== fluxDigest(authority.binding)) return fail("APPROVAL_NOT_OBSERVED", "Approval requires the exact digest from a previously persisted approval-subject read under unchanged authority.");
    return this.#mutate({ intentOperation: "approve_run", routeOperation: "flux_approve", route: `/api/v1/flux/runs/${runId}/approval`, body: { subjectDigest: exactDigest }, authority, allowedInitialPhases: ["awaiting_approval"], parseResult: (value) => { const run = parseRunTransition(value, current.run, ["approved"], "Approval"); if (run.approval?.subjectDigest !== exactDigest) return fail("AUTHORITY_DRIFT", "Approval result differs from the exact presented subject."); return safeRun(run); } });
  }

  public async resume(runIdInput: string): Promise<FluxControlCommandResult<Readonly<Record<string, unknown>>>> {
    const runId = inputIdentifier(runIdInput, "runId"); const current = await this.#rawRun(runId);
    if (current.run.workflowKind !== "generic") return fail("PHASE_MISMATCH", "Resume is limited to generic runs.");
    const authority = await this.#authorityForRun(current.run); const approval = current.run.approval; const view = await this.#store.approvalView(runId);
    if (approval === undefined || view === undefined || !constantTimeDigestEqual(view.subjectDigest, approval.subjectDigest) || view.authorityDigest !== fluxDigest(authority.binding)) return fail("APPROVAL_NOT_OBSERVED", "Resume requires the exact locally observed current approval authority.");
    if (current.run.phase === "approved") {
      const readiness = await this.readiness(); const kicadAuthority = kicadMcpAuthorityFromReadiness(readiness.result);
      const subject = await this.#read(`/api/v1/flux/runs/${runId}/approval`, "flux_approval_subject", (value) => parseApprovalSubject(value, current.run, authority, kicadAuthority));
      if (!constantTimeDigestEqual(subject.result.digest, approval.subjectDigest)) return fail("AUTHORITY_DRIFT", "Resume approval subject differs from the approved run.");
    } else if (!RESUME_REPLAY_PHASES.includes(current.run.phase) || approval.consumedAt === undefined) return fail("PHASE_MISMATCH", "Fresh resume requires approved; post-resume phases require a consumed pending replay.");
    const route = `/api/v1/flux/runs/${runId}/resume`; const body = {}; const logicalRequest = { runId, approvalSubjectDigest: approval.subjectDigest };
    const input: FluxControlIntentInput = { operation: "resume_run", logicalDigest: fluxDigest(logicalRequest), requestDigest: fluxDigest({ method: "POST", route, body }), authority: authority.binding };
    const admission = await this.#store.beginWithDisposition(input, current.run.phase === "approved" ? undefined : { code: "PHASE_MISMATCH", message: "A post-resume run has no exact pending durable replay intent." });
    if (current.run.phase !== "approved" && (admission.disposition !== "replay" || admission.intent.status !== "pending")) return fail("PHASE_MISMATCH", "Post-resume replay requires the exact pending durable intent.");
    return this.#mutate({ intentOperation: "resume_run", routeOperation: "flux_resume", route, body, authority, allowedInitialPhases: ["approved"], logicalRequest, admission,
      parseResult: (value) => safeRun(parseRunTransition(value, current.run, RESUME_REPLAY_PHASES, "Resume")) });
  }

  public async contract(runIdInput: string): Promise<FluxControlCommandResult> {
    const runId = inputIdentifier(runIdInput, "runId"); const current = await this.#rawRun(runId);
    return this.#read(`/api/v1/flux/runs/${runId}/contract`, "flux_contract", (value) => {
      const state = projectFluxContractStateDto(value, current.run.workflowKind);
      if (current.run.contractState !== undefined && !same(state, current.run.contractState)) return fail("AUTHORITY_DRIFT", "Contract result differs from the current run projection.");
      return redactExactPrompt(state, current.run.prompt);
    });
  }

  public async poll(runIdInput: string, afterEventSeq = 0): Promise<FluxControlCommandResult> {
    const runId = inputIdentifier(runIdInput, "runId"); if (!Number.isSafeInteger(afterEventSeq) || afterEventSeq < 0) return fail("INPUT_INVALID", "afterEventSeq must be a non-negative safe integer.");
    const response = await this.#read(`/api/v1/flux/runs/${runId}/poll?afterEventSeq=${afterEventSeq}`, "flux_poll", (value) => {
      const projected = projectFluxPollResult(value as never); if (projected.run.id !== runId) return fail("AUTHORITY_DRIFT", "Poll result crossed run authority."); return projected;
    });
    await this.#assertRunReportAuthority(runId, response.result.run);
    return Object.freeze({ requestId: response.requestId, result: Object.freeze(redactExactPrompt({ ...response.result, run: safeRun(response.result.run) }, response.result.run.prompt) as Record<string, unknown>) });
  }

  public async reports(runIdInput: string): Promise<FluxControlCommandResult> {
    const runId = inputIdentifier(runIdInput, "runId"); const current = await this.#rawRun(runId);
    const response = await this.#read(`/api/v1/flux/runs/${runId}/reports`, "flux_reports", (value) => { const wrapper = record(value, "Flux reports result"); exactKeys(wrapper, ["reports"], [], "Flux reports result"); if (!same(wrapper.reports, current.run.reports)) return fail("AUTHORITY_DRIFT", "Report metadata differs from the current run authority."); return current.run.reports; });
    await this.#assertRunReportAuthority(runId, current.run);
    return Object.freeze({ requestId: response.requestId, result: Object.freeze(redactExactPrompt({ reports: response.result }, current.run.prompt) as Record<string, unknown>) });
  }

  public async previews(runIdInput: string): Promise<FluxControlCommandResult> {
    const runId = inputIdentifier(runIdInput, "runId");
    const current = await this.#rawRun(runId);
    return this.#read(`/api/v1/flux/runs/${runId}/preview`, "flux_preview", (value) => {
      const preview = parsePreview(value) as { refreshedAt: string; artifacts: readonly { kind: string; sha256: string }[] };
      if (current.run.preview !== undefined) {
        const digest = fluxDigest(preview.artifacts.map(({ kind, sha256 }) => ({ kind, sha256 })));
        if (preview.artifacts.length !== current.run.preview.artifactCount || digest !== current.run.preview.digest) return fail("AUTHORITY_DRIFT", "Preview manifest differs from the requested run's current preview authority.");
      }
      return preview;
    });
  }

  public async refreshPreviews(runIdInput: string): Promise<FluxControlCommandResult> {
    const runId = inputIdentifier(runIdInput, "runId"); const current = await this.#rawRun(runId); const authority = await this.#authorityForRun(current.run);
    return this.#mutate({ intentOperation: "preview_refresh", routeOperation: "flux_preview_refresh", route: `/api/v1/flux/runs/${runId}/preview/refresh`, body: {}, authority, allowedInitialPhases: ["awaiting_open", "awaiting_checkpoint", "awaiting_approval", "approved", "completed", "needs_review", "failed", "blocked"], parseResult: parsePreview });
  }

  async #assertRunReportAuthority(runId: string, run: FluxRunDto): Promise<void> {
    const historicalProfile = ["completed", "needs_review", "failed", "blocked"].includes(run.phase) && run.contractState?.acceptancePlanIdentity?.schemaVersion === "evleda.pcb-acceptance-plan.v1"
      && run.contractState.interpreterReceipt.schemaVersion === "evleda.flux-interpreter-receipt.v2" && run.contractState.interpreterReceipt.compilerProfileIdentity?.schemaVersion === "evleda.pcb-design-compiler-profile.v1";
    let needsSubject = false;
    const clearanceBindings = new Map<FluxRunDto["reports"][number], ReturnType<typeof parseFluxPersistedFreshClearanceEvidenceBinding>>();
    for (const report of run.reports) {
      const quartet = [report.executionBridgeIdentity, report.writeSessionAuthorityIdentity, report.writeSessionReceiptIdentity, report.executionInspectionSessionReceiptIdentity];
      const quartetCount = quartet.filter((identity) => identity !== undefined).length;
      if (report.freshClearanceEvidenceBinding !== undefined) {
        try { clearanceBindings.set(report, parseFluxPersistedFreshClearanceEvidenceBinding(report.freshClearanceEvidenceBinding)); }
        catch { return fail("RESPONSE_MALFORMED", "Fresh clearance report binding is invalid."); }
        if (quartetCount !== 4) return fail("AUTHORITY_DRIFT", "Fresh-clearance evidence requires the complete execution-session identity quartet.");
      }
      if (run.workflowKind === "generic" && run.phase === "completed" && (report.freshClearanceEvidenceBinding === undefined || clearanceBindings.get(report)?.schemaVersion !== "evleda.flux-fresh-clearance-evidence-binding.v2" || quartetCount !== 4)) return fail("AUTHORITY_DRIFT", "Completed generic reports require current semantic clearance and execution-session authority.");
      const binding = clearanceBindings.get(report);
      const historical = binding !== undefined && binding.materializationIdentity.schemaVersion === "evleda.fresh-netclass-materialization.v1";
      if (historical && !["needs_review", "blocked", "failed"].includes(run.phase)) return fail("AUTHORITY_DRIFT", "Historical cache-based clearance evidence cannot authorize a current run.");
      if (quartetCount === 4 && !historical && !historicalProfile) needsSubject = true;
    }
    if (run.workflowKind === "generic" && run.phase === "completed" && run.reports.length === 0) return fail("AUTHORITY_DRIFT", "Completed generic runs require an authority-bound report.");
    if (needsSubject) {
      const context = await this.#inspectionContext(runId);
      if (!same(context.run.reports, run.reports) || run.reports.some((report) => {
        const binding = clearanceBindings.get(report);
        return report.executionBridgeIdentity !== undefined && (!same(report.executionBridgeIdentity, context.subject.executionBridgeIdentity) || !same(report.writeSessionAuthorityIdentity, context.subject.writeSessionAuthorityIdentity)
          || (binding?.schemaVersion === "evleda.flux-fresh-clearance-evidence-binding.v2" && !same(binding.semanticAuthorityIdentity, context.subject.freshNetClassSemanticAuthorityIdentity)));
      })) return fail("AUTHORITY_DRIFT", "Execution report metadata differs from the current v6 approval authority.");
    }
  }

  async #inspectionContext(runId: string): Promise<Readonly<{ run: FluxRunDto; authority: AuthorityContext; kicadAuthority: FluxControlKicadMcpAuthority; subject: FluxApprovalSubject; subjectDigest: string }>> {
    const current = await this.#rawRun(runId);
    if (current.run.workflowKind !== "generic" || !INSPECTION_PHASES.includes(current.run.phase)) return fail("PHASE_MISMATCH", "Inspection requires a generic run with current checkpoint authority.");
    const [authority, readiness] = await Promise.all([this.#authorityForRun(current.run), this.readiness()]);
    const kicadAuthority = kicadMcpAuthorityFromReadiness(readiness.result);
    const subjectResponse = await this.#read(`/api/v1/flux/runs/${runId}/approval`, "flux_approval_subject", (value) => parseApprovalSubject(value, current.run, authority, kicadAuthority));
    if (current.run.phase !== "awaiting_approval") {
      if (current.run.approval === undefined || !constantTimeDigestEqual(current.run.approval.subjectDigest, subjectResponse.result.digest)) return fail("AUTHORITY_DRIFT", "Inspection approval authority differs from the current run.");
      if (["completed", "needs_review", "failed", "blocked"].includes(current.run.phase) && current.run.approval.consumedAt === undefined) return fail("AUTHORITY_DRIFT", "Terminal inspection requires a consumed current approval.");
    }
    return Object.freeze({ run: current.run, authority, kicadAuthority, subject: subjectResponse.result.subject, subjectDigest: subjectResponse.result.digest });
  }

  /** Read-only, run-bound status. It never allocates or connects an inspection session. */
  public async inspectionStatus(runIdInput: string): Promise<FluxControlCommandResult> {
    const runId = inputIdentifier(runIdInput, "runId"); const context = await this.#inspectionContext(runId);
    const response = await this.#read(`/api/v1/flux/runs/${runId}/inspection`, "flux_inspection_snapshot", (value) => parseInspection(value, runId, context.subject, context.kicadAuthority));
    return Object.freeze({ requestId: response.requestId, result: Object.freeze(redactInspectionOutput(response.result, context.run.prompt) as Record<string, unknown>) });
  }

  /** Explicit idempotent active inspection; never invoked by a read/status command. */
  public async inspect(runIdInput: string): Promise<FluxControlCommandResult> {
    const runId = inputIdentifier(runIdInput, "runId"); const context = await this.#inspectionContext(runId);
    const route = `/api/v1/flux/runs/${runId}/inspection`; const body = {}; const logicalRequest = { runId, approvalSubjectDigest: context.subjectDigest };
    const baselineResponse = await this.#read(`/api/v1/flux/runs/${runId}/inspection`, "flux_inspection_snapshot", (value) => parseInspection(value, runId, context.subject, context.kicadAuthority));
    const baseline = record(baselineResponse.result, "Flux inspection baseline");
    const baselineBudget = record(baseline.connectionBudget, "Flux inspection baseline budget");
    return this.#mutate({ intentOperation: "inspect_run", routeOperation: "flux_inspection", route, body, authority: context.authority, allowedInitialPhases: INSPECTION_PHASES,
      logicalRequest,
      ...((baselineBudget.remaining as number) < 1 ? { freshAdmissionRejection: { code: "INCOMPLETE" as const, message: "A fresh Flux active inspection has no remaining connection-budget unit.", retryable: true } } : {}),
      parseResult: async (value, admission) => {
        const parsed = parseActiveInspection(value, runId, context.subject, context.kicadAuthority, baseline, admission.disposition === "replay");
        const current = await this.#read(route, "flux_inspection_snapshot", (status) => parseInspection(status, runId, context.subject, context.kicadAuthority));
        if (!same(parsed, current.result)) return fail("AUTHORITY_DRIFT", "Flux active inspection response differs from the authoritative post-operation status.");
        return Object.freeze(redactInspectionOutput(parsed, context.run.prompt) as Record<string, unknown>);
      } });
  }
}
