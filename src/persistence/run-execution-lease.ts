import path from "node:path";
import { canonicalIdentity } from "../core/canonical.js";
import { DomainError } from "../domain/errors.js";
import { acquireExclusiveFileLock } from "./file-lock.js";

export const RUN_EXECUTION_LEASE_SCHEMA_VERSION = "evleda.run-execution-lease.v1" as const;

export const runExecutionLeasePath = (stateRoot: string, runId: string): string => {
  const identity = canonicalIdentity(
    { schemaVersion: RUN_EXECUTION_LEASE_SCHEMA_VERSION, runId },
    RUN_EXECUTION_LEASE_SCHEMA_VERSION
  );
  return path.join(path.resolve(stateRoot), `.run-execution-${identity.digest}.lock`);
};

const sanitizedLeaseError = (
  error: unknown,
  runId: string,
  action: "acquire" | "release"
): DomainError => {
  if (error instanceof DomainError && error.code === "STAGE_ALREADY_RUNNING") {
    return new DomainError(
      "STAGE_ALREADY_RUNNING",
      "This design run already has an active execution command",
      { runId },
      true
    );
  }
  if (error instanceof DomainError) {
    return new DomainError(
      error.code,
      action === "acquire"
        ? "The exclusive run execution lease could not be established safely"
        : "The exclusive run execution lease could not be released safely",
      { runId },
      error.retryable
    );
  }
  const causeCode = (error as NodeJS.ErrnoException | undefined)?.code;
  return new DomainError(
    "ARTIFACT_INTEGRITY_ERROR",
    action === "acquire"
      ? "The exclusive run execution lease could not be established safely"
      : "The exclusive run execution lease could not be released safely",
    { runId, ...(causeCode === undefined ? {} : { causeCode }) }
  );
};

export const acquireRunExecutionLease = async (
  stateRoot: string,
  runId: string
): Promise<() => Promise<void>> => {
  let release: () => Promise<void>;
  try {
    release = await acquireExclusiveFileLock(runExecutionLeasePath(stateRoot, runId), {
      timeoutMs: 0
    });
  } catch (error) {
    throw sanitizedLeaseError(error, runId, "acquire");
  }

  let releasePromise: Promise<void> | undefined;
  return () => {
    releasePromise ??= release().catch((error: unknown) => {
      throw sanitizedLeaseError(error, runId, "release");
    });
    return releasePromise;
  };
};
