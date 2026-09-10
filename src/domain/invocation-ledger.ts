import { z } from "zod";
import { canonicalIdentity, canonicalJson } from "../core/canonical.js";
import { stageSchema } from "../contracts/operations.js";
import { DomainError } from "./errors.js";
import {
  NATIVE_PROCESS_MAX_STREAM_BYTES,
  nativeProcessPlanSchema,
  nativeProcessPlanV2Schema,
  projectNativeProcessPlanV2ToLegacyV1,
  validateNativeProcessPlanV1,
  validateNativeProcessPlanV2
} from "./native-process-plan.js";
import type {
  CanonicalIdentity,
  ContentIdentity,
  LegacyToolInvocationRecordV2,
  ToolInvocationOutcome,
  ToolInvocationRecord
} from "./types.js";

export const TOOL_INVOCATION_RECORD_SCHEMA_VERSION =
  "evleda.tool-invocation-record.v4" as const;
/** Stable compatibility identity domain consumed only by frozen Phase-1 receipts. */
export const TOOL_INVOCATION_IDENTITY_SCHEMA_VERSION = "evleda.tool-invocation.v1" as const;
export const CURRENT_TOOL_INVOCATION_IDENTITY_SCHEMA_VERSION =
  "evleda.tool-invocation.v2" as const;
export const MAX_INVOCATION_STREAM_BYTES = NATIVE_PROCESS_MAX_STREAM_BYTES;

export const TOOL_INVOCATION_TERMINAL_OUTCOMES = Object.freeze([
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "error"
] as const satisfies readonly ToolInvocationOutcome[]);

const terminalOutcomes = new Set<ToolInvocationOutcome>(TOOL_INVOCATION_TERMINAL_OUTCOMES);

export const isTerminalToolInvocationOutcome = (
  outcome: ToolInvocationOutcome
): outcome is Exclude<ToolInvocationOutcome, "unknown"> => terminalOutcomes.has(outcome);

const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u);
const contentIdentitySchema = z.object({
  algorithm: z.literal("sha256"),
  digest: z.string().regex(/^[0-9a-f]{64}$/u),
  size: z.number().int().safe().nonnegative()
}).strict();
const boundedContentIdentitySchema = contentIdentitySchema.extend({
  size: z.number().int().nonnegative().max(MAX_INVOCATION_STREAM_BYTES)
}).strict();
const canonicalIdentitySchema = z.object({
  algorithm: z.literal("sha256"),
  digest: z.string().regex(/^[0-9a-f]{64}$/u),
  schemaVersion: z.string().regex(/^evleda\.[a-z0-9][a-z0-9._-]*\.v[1-9][0-9]*$/u),
  canonicalizationVersion: z.literal("evleda-c14n-json-v1")
}).strict();
const nativeProcessPlanIdentitySchema = canonicalIdentitySchema.extend({
  schemaVersion: z.literal("evleda.native-process-plan.v2")
}).strict();
const legacyNativeProcessPlanIdentitySchema = canonicalIdentitySchema.extend({
  schemaVersion: z.literal("evleda.native-process-plan.v1")
}).strict();
const compatibilityInvocationIdentitySchema = canonicalIdentitySchema.extend({
  schemaVersion: z.literal(TOOL_INVOCATION_IDENTITY_SCHEMA_VERSION)
}).strict();
const invocationIdentitySchema = canonicalIdentitySchema.extend({
  schemaVersion: z.literal(CURRENT_TOOL_INVOCATION_IDENTITY_SCHEMA_VERSION)
}).strict();
const executionFenceSchema = z.object({
  inputManifest: canonicalIdentitySchema,
  parentRevisionId: identifierSchema,
  parentRevisionManifest: canonicalIdentitySchema,
  projectHeadRevisionId: identifierSchema,
  requirementsApprovalId: identifierSchema,
  requirementsApprovalDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  nativeProcessPlanBindings: z.array(z.object({
    schemaVersion: z.literal("evleda.native-process-plan-binding.v3"),
    profileDomain: z.enum(["kicad", "firmware"]),
    operation: z.enum([
      "kicad_erc",
      "kicad_drc",
      "kicad_netlist",
      "kicad_stats",
      "kicad_d356",
      "kicad_pdf",
      "compile",
      "link",
      "objcopy"
    ]),
    contractIdentity: canonicalIdentitySchema,
    planIdentity: nativeProcessPlanIdentitySchema,
    portableReceiptPlanIdentityV1: legacyNativeProcessPlanIdentitySchema
  }).strict()).optional()
}).strict();

const EXACT_MILLISECOND_UTC =
  /^(?!0000)[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/u;

export const isExactMillisecondUtcTimestamp = (value: string): boolean => {
  if (!EXACT_MILLISECOND_UTC.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
};

const millisecondUtcTimestampSchema = z.string().refine(isExactMillisecondUtcTimestamp, {
  message: "Timestamp must be an exact canonical UTC instant with millisecond precision"
});

const LEGACY_IDENTITY_INPUT_KEYS = Object.freeze([
  "schemaVersion", "transport", "id", "projectId", "runId", "attemptId", "stage",
  "fencingEpoch", "inputManifest", "executionFence", "toolContentIdentity", "commandPlan",
  "commandPlanIdentity", "stdoutIdentity", "stderrIdentity", "exitCode", "outcome",
  "startedAt", "completedAt"
]);
const CURRENT_IDENTITY_INPUT_KEYS = Object.freeze([
  ...LEGACY_IDENTITY_INPUT_KEYS,
  "portableReceiptInvocationIdentityV1",
  "portableReceiptInvocationIdentityDisposition"
]);

const assertExactIdentityInputKeys = (
  record: object,
  expectedWithoutIdentity: readonly string[],
  label: string
): void => {
  const expected = new Set([
    ...expectedWithoutIdentity,
    ...(Object.hasOwn(record, "invocationIdentity") ? ["invocationIdentity"] : [])
  ]);
  const actual = Object.keys(record);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    throw new DomainError("ARTIFACT_INTEGRITY_ERROR", `${label} has unknown or missing fields`);
  }
};

const legacyInvocationIdentityPreimage = (
  record: Omit<LegacyToolInvocationRecordV2, "invocationIdentity"> | LegacyToolInvocationRecordV2
): Omit<LegacyToolInvocationRecordV2, "invocationIdentity"> => {
  const { invocationIdentity: _identity, ...preimage } = record as LegacyToolInvocationRecordV2;
  return preimage;
};

export const toolInvocationIdentityV1 = (
  record: Omit<LegacyToolInvocationRecordV2, "invocationIdentity"> | LegacyToolInvocationRecordV2
): CanonicalIdentity & { readonly schemaVersion: "evleda.tool-invocation.v1" } => {
  assertExactIdentityInputKeys(record, LEGACY_IDENTITY_INPUT_KEYS, "Legacy invocation identity preimage");
  if (
    record.schemaVersion !== "evleda.tool-invocation-record.v2" ||
    record.commandPlan.schemaVersion !== "evleda.native-process-plan.v1" ||
    canonicalJson(validateNativeProcessPlanV1(record.commandPlan).planIdentity) !==
      canonicalJson(record.commandPlanIdentity) ||
    (record.executionFence.nativeProcessPlanBindings?.some((binding) =>
      binding.schemaVersion !== "evleda.native-process-plan-binding.v1" ||
      binding.planIdentity.schemaVersion !== "evleda.native-process-plan.v1"
    ) ?? false)
  ) {
    throw new DomainError(
      "ARTIFACT_INTEGRITY_ERROR",
      "Legacy invocation identity V1 accepts only record-v2/plan-v1 preimages"
    );
  }
  return canonicalIdentity(
    legacyInvocationIdentityPreimage(record),
    TOOL_INVOCATION_IDENTITY_SCHEMA_VERSION
  ) as CanonicalIdentity & { readonly schemaVersion: "evleda.tool-invocation.v1" };
};

const invocationIdentityPreimageV2 = (
  record: Omit<ToolInvocationRecord, "invocationIdentity"> | ToolInvocationRecord
): Omit<ToolInvocationRecord, "invocationIdentity"> => {
  const { invocationIdentity: _identity, ...preimage } = record as ToolInvocationRecord;
  return preimage;
};

export const toolInvocationIdentityV2 = (
  record: Omit<ToolInvocationRecord, "invocationIdentity"> | ToolInvocationRecord
): CanonicalIdentity & { readonly schemaVersion: "evleda.tool-invocation.v2" } => {
  assertExactIdentityInputKeys(record, CURRENT_IDENTITY_INPUT_KEYS, "Current invocation identity preimage");
  if (
    record.schemaVersion !== TOOL_INVOCATION_RECORD_SCHEMA_VERSION ||
    record.commandPlan.schemaVersion !== "evleda.native-process-plan.v2" ||
    record.portableReceiptInvocationIdentityDisposition !== "compatibility_projection_only" ||
    canonicalJson(validateNativeProcessPlanV2(record.commandPlan).planIdentity) !==
      canonicalJson(record.commandPlanIdentity)
  ) {
    throw new DomainError(
      "ARTIFACT_INTEGRITY_ERROR",
      "Current invocation identity V2 accepts only record-v4/plan-v2 preimages"
    );
  }
  return canonicalIdentity(
    invocationIdentityPreimageV2(record),
    CURRENT_TOOL_INVOCATION_IDENTITY_SCHEMA_VERSION
  ) as CanonicalIdentity & { readonly schemaVersion: "evleda.tool-invocation.v2" };
};

const projectCurrentRecordToLegacy = (
  record: ToolInvocationRecord,
  includeIdentity: boolean
): LegacyToolInvocationRecordV2 => {
  if (record.schemaVersion !== TOOL_INVOCATION_RECORD_SCHEMA_VERSION) {
    throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Compatibility projection requires record V4");
  }
  const legacyPlan = projectNativeProcessPlanV2ToLegacyV1(record.commandPlan);
  const {
    nativeProcessPlanBindings: currentBindings,
    ...fenceCore
  } = record.executionFence;
  const legacyFence = {
    ...fenceCore,
    ...(currentBindings === undefined
      ? {}
      : {
          nativeProcessPlanBindings: currentBindings.map((binding) => ({
            schemaVersion: "evleda.native-process-plan-binding.v1" as const,
            profileDomain: binding.profileDomain,
            operation: binding.operation,
            contractIdentity: binding.contractIdentity,
            planIdentity: binding.portableReceiptPlanIdentityV1
          }))
        })
  };
  return {
    schemaVersion: "evleda.tool-invocation-record.v2",
    transport: record.transport,
    id: record.id,
    projectId: record.projectId,
    runId: record.runId,
    attemptId: record.attemptId,
    stage: record.stage,
    fencingEpoch: record.fencingEpoch,
    inputManifest: record.inputManifest,
    executionFence: legacyFence,
    toolContentIdentity: record.toolContentIdentity,
    commandPlan: legacyPlan,
    commandPlanIdentity: legacyPlan.planIdentity,
    stdoutIdentity: record.stdoutIdentity,
    stderrIdentity: record.stderrIdentity,
    exitCode: record.exitCode,
    outcome: record.outcome,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    invocationIdentity: includeIdentity ? record.portableReceiptInvocationIdentityV1 : null
  };
};

const compatibilityInvocationIdentityV1 = (
  record: ToolInvocationRecord
): CanonicalIdentity & { readonly schemaVersion: "evleda.tool-invocation.v1" } =>
  toolInvocationIdentityV1(projectCurrentRecordToLegacy(record, false));

export const toolInvocationRecordSchema = z.object({
  schemaVersion: z.literal(TOOL_INVOCATION_RECORD_SCHEMA_VERSION),
  transport: z.literal("native_process"),
  id: identifierSchema,
  projectId: identifierSchema,
  runId: identifierSchema,
  attemptId: identifierSchema,
  stage: stageSchema,
  fencingEpoch: z.number().int().safe().positive(),
  inputManifest: canonicalIdentitySchema,
  executionFence: executionFenceSchema,
  toolContentIdentity: contentIdentitySchema,
  commandPlan: nativeProcessPlanV2Schema,
  commandPlanIdentity: nativeProcessPlanIdentitySchema,
  stdoutIdentity: boundedContentIdentitySchema.nullable(),
  stderrIdentity: boundedContentIdentitySchema.nullable(),
  exitCode: z.number().int().safe().nonnegative().max(0xffff_ffff).nullable(),
  outcome: z.enum([
    "unknown",
    "succeeded",
    "failed",
    "timed_out",
    "cancelled",
    "error"
  ]),
  startedAt: millisecondUtcTimestampSchema,
  completedAt: millisecondUtcTimestampSchema.nullable(),
  invocationIdentity: invocationIdentitySchema.nullable(),
  portableReceiptInvocationIdentityV1: compatibilityInvocationIdentitySchema.nullable(),
  portableReceiptInvocationIdentityDisposition: z.literal("compatibility_projection_only")
}).strict().superRefine((record, context) => {
  if (canonicalJson(record.inputManifest) !== canonicalJson(record.executionFence.inputManifest)) {
    context.addIssue({
      code: "custom",
      path: ["executionFence", "inputManifest"],
      message: "Invocation input manifest must equal the execution-fence input manifest"
    });
  }
  if (canonicalJson(record.commandPlanIdentity) !== canonicalJson(record.commandPlan.planIdentity)) {
    context.addIssue({
      code: "custom",
      path: ["commandPlanIdentity"],
      message: "Invocation command-plan identity must equal the verified stored plan identity"
    });
  }
  if (
    canonicalJson(record.toolContentIdentity) !==
    canonicalJson(record.commandPlan.tool.contentIdentity)
  ) {
    context.addIssue({
      code: "custom",
      path: ["toolContentIdentity"],
      message: "Invocation tool content must equal the verified command-plan tool content"
    });
  }
  let legacyPlan: ReturnType<typeof projectNativeProcessPlanV2ToLegacyV1>;
  try {
    legacyPlan = projectNativeProcessPlanV2ToLegacyV1(record.commandPlan);
  } catch {
    context.addIssue({
      code: "custom",
      path: ["commandPlan"],
      message: "Current command plan cannot produce the required legacy compatibility projection"
    });
    return;
  }
  const matchingPlanBindings = record.executionFence.nativeProcessPlanBindings?.filter(
    (binding) => canonicalJson(binding.planIdentity) === canonicalJson(record.commandPlanIdentity)
  ) ?? [];
  if (
    matchingPlanBindings.length > 0 &&
    matchingPlanBindings.some((binding) =>
      canonicalJson(binding.portableReceiptPlanIdentityV1) !== canonicalJson(legacyPlan.planIdentity)
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["executionFence", "nativeProcessPlanBindings"],
      message: "Current and compatibility plan identities do not share the exact V2-to-V1 projection"
    });
  }

  const terminal = record.outcome !== "unknown";
  const hasTerminalStreams = record.stdoutIdentity !== null && record.stderrIdentity !== null;
  if (!terminal) {
    if (
      record.completedAt !== null ||
      record.exitCode !== null ||
      record.stdoutIdentity !== null ||
      record.stderrIdentity !== null ||
      record.invocationIdentity !== null ||
      record.portableReceiptInvocationIdentityV1 !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "An unknown invocation cannot contain terminal fields"
      });
    }
    return;
  }

  if (
    record.completedAt === null ||
    !hasTerminalStreams ||
    record.invocationIdentity === null ||
    record.portableReceiptInvocationIdentityV1 === null
  ) {
    context.addIssue({
      code: "custom",
      path: ["outcome"],
      message: "A terminal invocation requires completion time, stream identities, and final identity"
    });
  } else {
    if (record.completedAt < record.startedAt) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "An invocation cannot complete before it starts"
      });
    }
    const expectedCompatibilityIdentity = compatibilityInvocationIdentityV1(
      record as ToolInvocationRecord
    );
    if (
      canonicalJson(record.portableReceiptInvocationIdentityV1) !==
      canonicalJson(expectedCompatibilityIdentity)
    ) {
      context.addIssue({
        code: "custom",
        path: ["portableReceiptInvocationIdentityV1"],
        message: "Compatibility invocation identity does not reproduce the legacy projection"
      });
    }
    const expectedIdentity = toolInvocationIdentityV2(record as ToolInvocationRecord);
    if (canonicalJson(record.invocationIdentity) !== canonicalJson(expectedIdentity)) {
      context.addIssue({
        code: "custom",
        path: ["invocationIdentity"],
        message: "Final invocation identity does not reproduce the complete terminal record"
      });
    }
  }

  if (
    record.stdoutIdentity !== null &&
    record.stdoutIdentity.size > record.commandPlan.maxStdoutBytes
  ) {
    context.addIssue({
      code: "custom",
      path: ["stdoutIdentity", "size"],
      message: "Captured stdout exceeds the command plan limit"
    });
  }
  if (
    record.stderrIdentity !== null &&
    record.stderrIdentity.size > record.commandPlan.maxStderrBytes
  ) {
    context.addIssue({
      code: "custom",
      path: ["stderrIdentity", "size"],
      message: "Captured stderr exceeds the command plan limit"
    });
  }

  const acceptedExit = record.exitCode !== null &&
    record.commandPlan.acceptedExitCodes.includes(record.exitCode);
  if (record.outcome === "succeeded" && !acceptedExit) {
    context.addIssue({
      code: "custom",
      path: ["exitCode"],
      message: "A succeeded invocation requires a command-plan-accepted exit code"
    });
  } else if (record.outcome === "failed" && (record.exitCode === null || acceptedExit)) {
    context.addIssue({
      code: "custom",
      path: ["exitCode"],
      message: "A failed invocation requires a command-plan-rejected exit code"
    });
  } else if (
    ["timed_out", "cancelled", "error"].includes(record.outcome) &&
    record.exitCode !== null
  ) {
    context.addIssue({
      code: "custom",
      path: ["exitCode"],
      message: `${record.outcome} invocations cannot assert a process exit code`
    });
  }
});

export const projectToolInvocationRecordV4ToLegacyV2 = (
  record: ToolInvocationRecord
): LegacyToolInvocationRecordV2 => {
  const parsed = toolInvocationRecordSchema.safeParse(record);
  if (!parsed.success) {
    throw new DomainError(
      "ARTIFACT_INTEGRITY_ERROR",
      "Cannot project an invalid current invocation record to legacy V2",
      { issues: parsed.error.issues.slice(0, 20) }
    );
  }
  return structuredClone(projectCurrentRecordToLegacy(record, true));
};

export const portableReceiptInvocationIdentityV1 = (
  record: ToolInvocationRecord
): CanonicalIdentity & { readonly schemaVersion: "evleda.tool-invocation.v1" } => {
  const projected = projectToolInvocationRecordV4ToLegacyV2(record);
  return toolInvocationIdentityV1(projected);
};

const rejectTransition = (
  message: string,
  details: Readonly<Record<string, unknown>>
): never => {
  throw new DomainError("REVISION_CONFLICT", message, details);
};

const sameJson = (left: unknown, right: unknown): boolean =>
  canonicalJson(left) === canonicalJson(right);

const immutableInvocationCore = (record: ToolInvocationRecord): unknown => {
  const {
    stdoutIdentity: _stdoutIdentity,
    stderrIdentity: _stderrIdentity,
    exitCode: _exitCode,
    outcome: _outcome,
    completedAt: _completedAt,
    invocationIdentity: _invocationIdentity,
    portableReceiptInvocationIdentityV1: _portableReceiptInvocationIdentityV1,
    ...core
  } = record;
  return core;
};

export const assertNewToolInvocationRecord = (record: ToolInvocationRecord): void => {
  if (
    record.outcome !== "unknown" ||
    record.completedAt !== null ||
    record.exitCode !== null ||
    record.stdoutIdentity !== null ||
    record.stderrIdentity !== null ||
    record.invocationIdentity !== null ||
    record.portableReceiptInvocationIdentityV1 !== null
  ) {
    rejectTransition("A new tool invocation must be appended before execution with unknown outcome", {
      invocationId: record.id,
      outcome: record.outcome
    });
  }
};

export const assertToolInvocationRecordTransition = (
  previous: ToolInvocationRecord,
  next: ToolInvocationRecord
): void => {
  if (sameJson(previous, next)) return;
  if (!sameJson(immutableInvocationCore(previous), immutableInvocationCore(next))) {
    rejectTransition("Immutable tool-invocation binding changed", {
      invocationId: previous.id
    });
  }
  if (previous.outcome !== "unknown" || !isTerminalToolInvocationOutcome(next.outcome)) {
    rejectTransition("A tool invocation permits exactly one unknown-to-terminal transition", {
      invocationId: previous.id,
      previousOutcome: previous.outcome,
      nextOutcome: next.outcome
    });
  }
};

export const completeToolInvocationRecord = (
  pending: ToolInvocationRecord,
  terminal: {
    readonly outcome: Exclude<ToolInvocationOutcome, "unknown">;
    readonly stdoutIdentity: ContentIdentity;
    readonly stderrIdentity: ContentIdentity;
    readonly exitCode: number | null;
    readonly completedAt: string;
  }
): ToolInvocationRecord => {
  if (pending.outcome !== "unknown") {
    rejectTransition("Only an unknown invocation can be completed", { invocationId: pending.id });
  }
  const preimage = {
    ...pending,
    ...terminal,
    invocationIdentity: null,
    portableReceiptInvocationIdentityV1: null
  };
  const withCompatibility: ToolInvocationRecord = {
    ...preimage,
    portableReceiptInvocationIdentityV1: compatibilityInvocationIdentityV1(preimage)
  };
  const completed: ToolInvocationRecord = {
    ...withCompatibility,
    invocationIdentity: toolInvocationIdentityV2(withCompatibility)
  };
  const parsed = toolInvocationRecordSchema.safeParse(completed);
  if (!parsed.success) {
    throw new DomainError(
      "ARTIFACT_INTEGRITY_ERROR",
      `Completed tool invocation is invalid: ${parsed.error.issues[0]?.message ?? "unknown issue"}`,
      {
      invocationId: pending.id,
      issues: parsed.error.issues.slice(0, 20).map((issue) => ({
        path: issue.path,
        code: issue.code,
        message: issue.message
      }))
      }
    );
  }
  return structuredClone(completed);
};

/** Re-validate the persisted plan before any future writer executes it. */
export const validatedInvocationCommandPlan = (record: ToolInvocationRecord) =>
  validateNativeProcessPlanV2(record.commandPlan);
