export type DomainErrorCode =
  | "ARTIFACT_INTEGRITY_ERROR"
  | "CAPABILITY_REQUIRED"
  | "DIGEST_MISMATCH"
  | "EVIDENCE_MISSING"
  | "EVIDENCE_STALE"
  | "EXTERNAL_ACCEPTANCE_REQUIRED"
  | "GATE_FAILED"
  | "IDEMPOTENCY_CONFLICT"
  | "INVALID_ARGUMENT"
  | "NOT_FOUND"
  | "PATH_OUTSIDE_WORKSPACE"
  | "POLICY_DENIED"
  | "REQUIREMENTS_NOT_APPROVED"
  | "REVISION_CONFLICT"
  | "STAGE_ALREADY_RUNNING"
  | "STAGE_BLOCKED"
  | "TOOL_RESULT_INCONCLUSIVE"
  | "TOOLCHAIN_UNAVAILABLE"
  | "TOOLCHAIN_UNSUPPORTED";

export interface DomainErrorDetails {
  readonly [key: string]: unknown;
}

export class DomainError extends Error {
  public constructor(
    public readonly code: DomainErrorCode,
    message: string,
    public readonly details: DomainErrorDetails = {},
    public readonly retryable = false
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export const isDomainError = (value: unknown): value is DomainError =>
  value instanceof DomainError;

