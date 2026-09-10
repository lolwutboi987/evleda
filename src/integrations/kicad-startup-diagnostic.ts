import { types } from "node:util";

export type KicadStartupStage =
  | "session-policy" | "session-workspace-root" | "session-project-root" | "session-launch-directory" | "session-output-root"
  | "session-launcher" | "session-supervision" | "session-environment"
  | "cli-runtime-binding" | "cli-library-layout" | "cli-version-probe" | "sidecar-transport"
  | "mcp-handshake" | "mcp-server-identity" | "mcp-catalog" | "mcp-contracts" | "launcher-recheck" | "required-capabilities"
  | "bridge-connect" | "deferred-project-binding" | "bridge-revalidation" | "bridge-session-identity"
  | "session-cleanup" | "bridge-cleanup" | "toolbox-session-cleanup"
  | "ipc-allocation" | "editor-context" | "editor-preflight" | "editor-launch" | "editor-readiness" | "session-authority"
  | "session-connect" | "session-recheck" | "lock-capture" | "preview-binding" | "stackup-binding" | "reference-binding"
  | "host-cleanup" | "diagnostic-write";
export type KicadStartupCategory = "kicad-session" | "kicad-authorization" | "kicad-output" | "kicad-output-limit"
  | "kicad-termination-uncertain" | "kicad-verification-deadline";
export type KicadEditorReadinessStage = "connection" | "version" | "ping" | "document";
export type KicadEditorReadinessCode = "DEADLINE" | "EDITOR_EXITED" | "WRONG_DOCUMENT" | "NATIVE_FAILURE" | "INVALID_ENDPOINT" | "VERSION_MISMATCH" | "CANCELLED";
export interface KicadEditorReadinessFailure {
  readonly code: KicadEditorReadinessCode;
  readonly stage: KicadEditorReadinessStage;
  readonly attempts: number;
  readonly elapsedMs: number;
  readonly nativeCode: number | null;
  readonly firstFailure: Readonly<{ stage: KicadEditorReadinessStage; code: KicadEditorReadinessCode | "NOT_READY" | "CONNECTION_NOT_READY"; nativeCode: number | null; attempt: number }> | null;
}
export interface KicadStartupCause {
  readonly category: KicadStartupCategory | "native-error" | "foreign-value";
  readonly code?: string | number;
  readonly errno?: number;
  readonly exitCode?: number;
  readonly editorReadiness?: KicadEditorReadinessFailure;
}
export interface KicadStartupStderr {
  readonly category: "empty" | "present" | "limit_exceeded";
  readonly truncated: boolean;
  readonly seenBytes: number;
}
export interface KicadStartupEvidence {
  readonly failure: Readonly<{ stage: KicadStartupStage; cause: KicadStartupCause; stderr: KicadStartupStderr | null }>;
  readonly cleanup: readonly Readonly<{ stage: KicadStartupStage; status: "confirmed" | "unconfirmed"; cause: KicadStartupCause | null }>[];
}

// These maps are process-private. Foreign objects never become public causes.
const categories = new WeakMap<object, KicadStartupCategory>();
const evidence = new WeakMap<object, KicadStartupEvidence>();
const objectKey = (value: unknown): value is object => value !== null && (typeof value === "object" || typeof value === "function");
export function registerKicadStartupError(error: Error, category: KicadStartupCategory): void { categories.set(error, category); }
export function registeredKicadStartupCategory(error: unknown): KicadStartupCategory | undefined {
  return objectKey(error) ? categories.get(error) : undefined;
}
const OS_CODES = new Set(["ENOENT", "EACCES", "EPERM", "EPIPE", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTDIR", "EISDIR", "ENOSPC", "EIO", "EINVAL", "ENOTSUP", "EBUSY", "EEXIST", "ABORT_ERR"]);
const numericCode = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647;

/** No messages, paths, causes, stack strings, getters, proxies or custom inspectors. */
export function captureKicadStartupCause(error: unknown): KicadStartupCause {
  const registered = registeredKicadStartupCategory(error);
  if (!objectKey(error) || types.isProxy(error) || !types.isNativeError(error)) return Object.freeze({ category: "foreign-value" });
  const data = (key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    return descriptor !== undefined && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  };
  const code = data("code"), errno = data("errno"), exitCode = data("exitCode");
  return Object.freeze({ category: registered ?? "native-error",
    ...(numericCode(code) || typeof code === "string" && OS_CODES.has(code) ? { code } : {}),
    ...(numericCode(errno) ? { errno } : {}), ...(numericCode(exitCode) ? { exitCode } : {}) });
}

export function captureKicadStartupFailure(error: unknown, stage: KicadStartupStage, stderr?: KicadStartupStderr): KicadStartupEvidence {
  const prior = objectKey(error) ? evidence.get(error) : undefined;
  if (prior !== undefined) return prior;
  return Object.freeze({ failure: Object.freeze({ stage, cause: captureKicadStartupCause(error),
    stderr: stderr === undefined ? null : Object.freeze({ category: stderr.category, truncated: stderr.truncated, seenBytes: stderr.seenBytes }) }), cleanup: Object.freeze([]) });
}

export function withKicadStartupCleanup(record: KicadStartupEvidence, stage: KicadStartupStage, status: "confirmed" | "unconfirmed", error?: unknown): KicadStartupEvidence {
  return Object.freeze({ failure: record.failure, cleanup: Object.freeze([...record.cleanup,
    Object.freeze({ stage, status, cause: status === "confirmed" ? null : captureKicadStartupCause(error) })].slice(0, 4)) });
}

export function bindKicadStartupEvidence<T extends Error>(error: T, record: KicadStartupEvidence): T {
  evidence.set(error, record);
  return error;
}
