import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DomainError, isDomainError, type DomainErrorCode } from "../domain/errors.js";
import type { OperationName } from "./operations.js";

export type PublicErrorCode = DomainErrorCode | "INTERNAL_ERROR";

export interface ErrorPayload {
  readonly code: PublicErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface SuccessEnvelope<Result = unknown> {
  readonly ok: true;
  readonly operation:
    | OperationName
    | "health"
    | "list_projects"
    | "list_runs"
    | "submit_external_evidence"
    | "qualify_revision"
    | "authorize_manufacturing_release"
    | "revoke_attestation";
  readonly requestId: string;
  readonly result: Result;
}

export interface FailureEnvelope {
  readonly ok: false;
  readonly error: ErrorPayload;
}

export type OperationEnvelope<Result = unknown> = SuccessEnvelope<Result> | FailureEnvelope;

export const errorPayloadSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean(),
    details: z.record(z.string(), z.unknown())
  })
  .strict();

export const failureEnvelopeSchema = z
  .object({
    ok: z.literal(false),
    error: errorPayloadSchema
  })
  .strict();

export const successEnvelopeSchema = z
  .object({
    ok: z.literal(true),
    operation: z.string().min(1),
    requestId: z.string().min(1),
    result: z.unknown()
  })
  .strict();

const safeDetails = (details: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
  try {
    return structuredClone(details);
  } catch {
    return {};
  }
};

export const normalizeError = (error: unknown): ErrorPayload => {
  if (isDomainError(error)) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: safeDetails(error.details)
    };
  }
  if (error instanceof z.ZodError) {
    return {
      code: "INVALID_ARGUMENT",
      message: "Request failed schema validation",
      retryable: false,
      details: {
        issues: error.issues.map((issue) => ({
          code: issue.code,
          path: issue.path.map(String),
          message: issue.message
        }))
      }
    };
  }
  return {
    code: "INTERNAL_ERROR",
    message: "The operation failed unexpectedly",
    retryable: false,
    details: {}
  };
};

export const successEnvelope = <Result>(
  operation: SuccessEnvelope["operation"],
  result: Result,
  requestId: string = randomUUID()
): SuccessEnvelope<Result> => ({ ok: true, operation, requestId, result });

export const failureEnvelope = (error: unknown): FailureEnvelope => ({
  ok: false,
  error: normalizeError(error)
});

export const assertHumanCapability = (
  condition: boolean,
  message: string,
  details: Readonly<Record<string, unknown>> = {}
): void => {
  if (!condition) {
    throw new DomainError("CAPABILITY_REQUIRED", message, details, false);
  }
};

export const httpStatusForError = (code: PublicErrorCode): number => {
  switch (code) {
    case "INVALID_ARGUMENT":
      return 400;
    case "NOT_FOUND":
      return 404;
    case "CAPABILITY_REQUIRED":
    case "POLICY_DENIED":
    case "PATH_OUTSIDE_WORKSPACE":
      return 403;
    case "IDEMPOTENCY_CONFLICT":
    case "REQUIREMENTS_NOT_APPROVED":
    case "REVISION_CONFLICT":
    case "STAGE_ALREADY_RUNNING":
      return 409;
    case "STAGE_BLOCKED":
    case "EVIDENCE_MISSING":
    case "EVIDENCE_STALE":
    case "GATE_FAILED":
    case "DIGEST_MISMATCH":
    case "ARTIFACT_INTEGRITY_ERROR":
    case "EXTERNAL_ACCEPTANCE_REQUIRED":
    case "TOOLCHAIN_UNSUPPORTED":
    case "TOOL_RESULT_INCONCLUSIVE":
      return 422;
    case "TOOLCHAIN_UNAVAILABLE":
      return 503;
    case "INTERNAL_ERROR":
    default:
      return 500;
  }
};
