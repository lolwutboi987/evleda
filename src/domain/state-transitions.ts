import { canonicalJson, contentIdentity } from "../core/canonical.js";
import {
  GENERATED_BRINGUP_PLAN_CONTRACT,
  generatedBringupPlan
} from "./candidate-generation-contract.js";
import { DomainError } from "./errors.js";
import {
  assertNewToolInvocationRecord,
  assertToolInvocationRecordTransition,
  isExactMillisecondUtcTimestamp,
  isTerminalToolInvocationOutcome,
  toolInvocationRecordSchema
} from "./invocation-ledger.js";
import type { ApprovedNativeProcessContractRegistryV2 } from "./native-process-plan.js";
import { STAGE_ORDER, type StageKey } from "./stages.js";
import type {
  ApprovalRecord,
  ArtifactRecord,
  DesignRevision,
  DesignRun,
  EvidenceRecord,
  Project,
  RequirementsDocument,
  RunState,
  StageAttempt,
  StageAttemptState,
  ToolInvocationRecord
} from "./types.js";

type TransitionTable<State extends string> = Readonly<Record<State, readonly State[]>>;

const freezeTransitionTable = <State extends string>(
  table: Record<State, readonly State[]>
): TransitionTable<State> => {
  for (const targets of Object.values(table)) Object.freeze(targets);
  return Object.freeze(table);
};

/**
 * The complete durable run-state graph.
 *
 * Identity entries are explicit because transactions may update other aggregate
 * fields without changing execution state. `completed` can only be reopened by
 * explicit rerun preparation. `interrupted` is readable/resumable for recovery,
 * but no current command creates it. `cancelled` is deliberately absorbing.
 */
export const RUN_STATE_TRANSITIONS = freezeTransitionTable<RunState>({
  queued: ["queued", "running", "completed"],
  running: ["running", "queued", "blocked", "completed"],
  waiting_requirements_approval: ["waiting_requirements_approval", "queued"],
  blocked: ["blocked", "queued", "running"],
  interrupted: ["interrupted", "queued", "running"],
  completed: ["completed", "queued"],
  cancelled: ["cancelled"]
});

/**
 * The complete durable stage-attempt graph.
 *
 * An outcome is never reopened: retry creates a new attempt. Rerun invalidation
 * may only move an outcome (or a fenced orphan still marked running) to `stale`.
 * `pending` remains readable for schema compatibility but has no current writer.
 */
export const STAGE_ATTEMPT_STATE_TRANSITIONS =
  freezeTransitionTable<StageAttemptState>({
    pending: ["pending"],
    running: ["running", "blocked", "interrupted", "succeeded", "stale"],
    waiting_approval: ["waiting_approval", "succeeded"],
    blocked: ["blocked", "stale"],
    interrupted: ["interrupted", "stale"],
    succeeded: ["succeeded", "stale"],
    stale: ["stale"]
  });

export const RUN_STATES = Object.freeze(
  Object.keys(RUN_STATE_TRANSITIONS) as RunState[]
);

export const STAGE_ATTEMPT_STATES = Object.freeze(
  Object.keys(STAGE_ATTEMPT_STATE_TRANSITIONS) as StageAttemptState[]
);

const permits = <State extends string>(
  table: TransitionTable<State>,
  from: State,
  to: State
): boolean => table[from]?.includes(to) ?? false;

export const canTransitionRunState = (from: RunState, to: RunState): boolean =>
  permits(RUN_STATE_TRANSITIONS, from, to);

export const canTransitionStageAttemptState = (
  from: StageAttemptState,
  to: StageAttemptState
): boolean => permits(STAGE_ATTEMPT_STATE_TRANSITIONS, from, to);

const rejectTransition = (
  entity: "run" | "stage_attempt",
  id: string,
  from: string,
  to: string,
  stage?: StageKey
): never => {
  throw new DomainError(
    "REVISION_CONFLICT",
    `Invalid ${entity === "run" ? "run" : "stage-attempt"} state transition: ${from} -> ${to}`,
    { entity, id, from, to, ...(stage === undefined ? {} : { stage }) }
  );
};

export const assertRunStateTransition = (
  from: RunState,
  to: RunState,
  runId = "unknown"
): void => {
  if (!canTransitionRunState(from, to)) rejectTransition("run", runId, from, to);
};

export const assertStageAttemptStateTransition = (
  from: StageAttemptState,
  to: StageAttemptState,
  attemptId = "unknown",
  stage?: StageKey
): void => {
  if (!canTransitionStageAttemptState(from, to)) {
    rejectTransition("stage_attempt", attemptId, from, to, stage);
  }
};

const rejectAggregate = (
  message: string,
  details: Readonly<Record<string, unknown>>
): never => {
  throw new DomainError("REVISION_CONFLICT", message, details);
};

const rejectIntegrity = (
  message: string,
  details: Readonly<Record<string, unknown>> = {}
): never => {
  throw new DomainError("ARTIFACT_INTEGRITY_ERROR", message, details);
};

const sameJson = (left: unknown, right: unknown): boolean => {
  if (left === undefined || right === undefined) return left === right;
  return canonicalJson(left) === canonicalJson(right);
};

const assertImmutableField = (
  entity: "run" | "stage_attempt",
  id: string,
  field: string,
  previous: unknown,
  next: unknown
): void => {
  if (!sameJson(previous, next)) {
    rejectAggregate(`Immutable ${entity === "run" ? "run" : "stage-attempt"} field changed`, {
      entity,
      id,
      field
    });
  }
};

const attemptsFor = (run: DesignRun, stage: StageKey): readonly StageAttempt[] => {
  const histories = run.attempts as Partial<Record<StageKey, unknown>> | undefined;
  const attempts: unknown = histories?.[stage];
  if (!Array.isArray(attempts)) {
    throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Run has an invalid stage-attempt history", {
      runId: run.id,
      stage
    });
  }
  return attempts as readonly StageAttempt[];
};

const assertAttemptShape = (run: DesignRun, stage: StageKey, attempt: StageAttempt): void => {
  if (attempt.stage !== stage) {
    throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Stage attempt is stored under the wrong stage", {
      runId: run.id,
      stage,
      attemptId: attempt.id,
      recordedStage: attempt.stage
    });
  }
  if (!STAGE_ATTEMPT_STATES.includes(attempt.state)) {
    throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Stage attempt has an unknown state", {
      runId: run.id,
      stage,
      attemptId: attempt.id,
      state: attempt.state
    });
  }
  if (attempt.id.length === 0) {
    rejectIntegrity("Stage attempt has an empty identifier", { runId: run.id, stage });
  }
  if (!Number.isSafeInteger(attempt.attemptNumber) || attempt.attemptNumber <= 0) {
    rejectIntegrity("Stage attempt has an invalid attempt number", {
      runId: run.id,
      stage,
      attemptId: attempt.id,
      attemptNumber: attempt.attemptNumber
    });
  }
  if (!Number.isSafeInteger(attempt.fencingEpoch) || attempt.fencingEpoch <= 0) {
    rejectIntegrity("Stage attempt has an invalid fencing epoch", {
      runId: run.id,
      stage,
      attemptId: attempt.id,
      fencingEpoch: attempt.fencingEpoch
    });
  }
  if (new Set(attempt.artifactIds).size !== attempt.artifactIds.length ||
      new Set(attempt.evidenceIds).size !== attempt.evidenceIds.length) {
    rejectIntegrity("Stage attempt contains duplicate output identifiers", {
      runId: run.id,
      stage,
      attemptId: attempt.id
    });
  }
  if (attempt.blockers.some((blocker) => blocker.stage !== stage)) {
    rejectIntegrity("Stage attempt contains a blocker for a different stage", {
      runId: run.id,
      stage,
      attemptId: attempt.id
    });
  }
  if (
    attempt.startedAt !== undefined &&
    attempt.completedAt !== undefined &&
    Date.parse(attempt.completedAt) < Date.parse(attempt.startedAt)
  ) {
    rejectIntegrity("Stage attempt completes before it starts", {
      runId: run.id,
      stage,
      attemptId: attempt.id
    });
  }

  if (stage === "requirements") {
    if (
      attempt.provisionIdentity !== undefined ||
      attempt.provisionManifestBlob !== undefined ||
      attempt.executionFence !== undefined
    ) {
      rejectIntegrity("Requirements attempts cannot contain an execution provision or fence", {
        runId: run.id,
        attemptId: attempt.id
      });
    }
  } else if (
    attempt.state !== "pending" &&
    (attempt.provisionIdentity === undefined ||
      attempt.provisionManifestBlob === undefined ||
      attempt.executionFence === undefined ||
      !sameJson(attempt.executionFence.inputManifest, attempt.inputManifest))
  ) {
    rejectIntegrity("Ordinary stage attempt is missing its immutable provision or fence", {
      runId: run.id,
      stage,
      attemptId: attempt.id
    });
  }

  const processBindings = attempt.executionFence?.nativeProcessPlanBindings;
  if (processBindings !== undefined) {
    const bindingKeys = processBindings.map((binding) => [
      binding.profileDomain,
      binding.operation,
      binding.contractIdentity.schemaVersion,
      binding.contractIdentity.digest,
      binding.planIdentity.digest
    ].join("\u0000"));
    const sortedKeys = [...bindingKeys].sort();
    if (
      processBindings.length === 0 ||
      processBindings.length > 32 ||
      new Set(bindingKeys).size !== bindingKeys.length ||
      bindingKeys.some((key, index) => key !== sortedKeys[index]) ||
      processBindings.some((binding) =>
        binding.schemaVersion !== "evleda.native-process-plan-binding.v3" ||
        binding.planIdentity.schemaVersion !== "evleda.native-process-plan.v2" ||
        binding.portableReceiptPlanIdentityV1.schemaVersion !== "evleda.native-process-plan.v1" ||
        (binding.profileDomain === "kicad"
          ? ![
              "kicad_erc",
              "kicad_drc",
              "kicad_netlist",
              "kicad_stats",
              "kicad_d356",
              "kicad_pdf"
            ].includes(binding.operation) ||
            binding.contractIdentity.schemaVersion !== "evleda.kicad-runtime-command-contract.v1"
          : !["compile", "link", "objcopy"].includes(binding.operation) ||
            binding.contractIdentity.schemaVersion !== "evleda.firmware-runtime-command-contract.v1")
      )
    ) {
      rejectIntegrity("Stage attempt has invalid or noncanonical native-process plan bindings", {
        runId: run.id,
        stage,
        attemptId: attempt.id
      });
    }
  }

  if (
    attempt.resultRevisionId !== undefined &&
    attempt.state !== "succeeded" &&
    attempt.state !== "stale"
  ) {
    rejectIntegrity("Only a succeeded or subsequently stale attempt may bind a result revision", {
      runId: run.id,
      stage,
      attemptId: attempt.id,
      state: attempt.state,
      resultRevisionId: attempt.resultRevisionId
    });
  }

  switch (attempt.state) {
    case "pending":
      if (
        attempt.outputIdentity !== undefined ||
        attempt.artifactIds.length !== 0 ||
        attempt.evidenceIds.length !== 0 ||
        attempt.blockers.length !== 0 ||
        attempt.completedAt !== undefined
      ) {
        rejectIntegrity("Pending attempt contains terminal output", { runId: run.id, stage, attemptId: attempt.id });
      }
      break;
    case "running":
      if (
        attempt.startedAt === undefined ||
        attempt.completedAt !== undefined ||
        attempt.outputIdentity !== undefined ||
        attempt.artifactIds.length !== 0 ||
        attempt.evidenceIds.length !== 0 ||
        attempt.blockers.length !== 0
      ) {
        rejectIntegrity("Running attempt contains terminal output", { runId: run.id, stage, attemptId: attempt.id });
      }
      break;
    case "waiting_approval":
      if (
        stage !== "requirements" ||
        attempt.startedAt === undefined ||
        attempt.completedAt !== undefined ||
        attempt.outputIdentity !== undefined ||
        attempt.artifactIds.length !== 0 ||
        attempt.evidenceIds.length !== 0 ||
        attempt.blockers.length !== 0
      ) {
        rejectIntegrity("Waiting-approval attempt has invalid fields", { runId: run.id, stage, attemptId: attempt.id });
      }
      break;
    case "blocked":
    case "interrupted":
      if (attempt.completedAt === undefined || attempt.blockers.length === 0) {
        rejectIntegrity("Blocked or interrupted attempt lacks completion and blocker data", {
          runId: run.id,
          stage,
          attemptId: attempt.id,
          state: attempt.state
        });
      }
      break;
    case "succeeded":
      if (
        attempt.completedAt === undefined ||
        attempt.outputIdentity === undefined ||
        attempt.artifactIds.length === 0 ||
        attempt.blockers.length !== 0
      ) {
        rejectIntegrity("Successful attempt lacks committed output", { runId: run.id, stage, attemptId: attempt.id });
      }
      break;
    case "stale":
      // A rerun may fence a still-running attempt, so completedAt is not mandatory.
      break;
  }
};

const assertCandidateRun = (run: DesignRun): void => {
  if (run.lifecycle !== "candidate") {
    throw new DomainError(
      "GATE_FAILED",
      "Stored workflow execution state must remain candidate-only",
      { runId: run.id, lifecycle: run.lifecycle }
    );
  }
};

const requirementCore = (document: RequirementsDocument | undefined): unknown => {
  if (document === undefined) return undefined;
  const { approvalId: _approvalId, ...core } = document;
  return core;
};

interface RunAnalysis {
  readonly activeAttempts: readonly StageAttempt[];
  readonly firstIncompleteStage?: StageKey;
  readonly firstIncompleteAttempt?: StageAttempt;
}

const assertRunSnapshot = (run: DesignRun): RunAnalysis => {
  if (run.id.length === 0 || run.projectId.length === 0 || run.workflowVersion.length === 0) {
    rejectIntegrity("Run has an empty identity or workflow field", { runId: run.id });
  }
  if (!RUN_STATES.includes(run.state)) {
    rejectIntegrity("Run has an unknown state", { runId: run.id, state: run.state });
  }
  if (!Number.isSafeInteger(run.revision) || run.revision < 0) {
    rejectIntegrity("Run has an invalid entity revision", { runId: run.id, revision: run.revision });
  }
  if (run.lifecycle !== "candidate") {
    rejectIntegrity("Stored workflow execution state must remain candidate-only", {
      runId: run.id,
      lifecycle: run.lifecycle
    });
  }
  const requirements = run.requirements;
  if (requirements === undefined || !sameJson(requirements.sourcePrompt, run.sourcePrompt)) {
    rejectIntegrity("Run lacks requirements bound to its immutable source prompt", { runId: run.id });
  }
  const recordedStageKeys = Object.keys(run.attempts).sort();
  const expectedStageKeys = [...STAGE_ORDER].sort();
  if (!sameJson(recordedStageKeys, expectedStageKeys)) {
    rejectIntegrity("Run must contain exactly one attempt history for every workflow stage", {
      runId: run.id,
      recordedStageKeys
    });
  }

  const requirementAttempts = attemptsFor(run, "requirements");
  if (requirementAttempts.length !== 1) {
    rejectIntegrity("Run must contain exactly one immutable requirements attempt", {
      runId: run.id,
      count: requirementAttempts.length
    });
  }

  const seenIds = new Set<string>();
  const activeAttempts: StageAttempt[] = [];
  let prefixComplete = true;
  let firstIncompleteStage: StageKey | undefined;
  let firstIncompleteAttempt: StageAttempt | undefined;
  let illegalDownstreamStage: StageKey | undefined;

  for (const stage of STAGE_ORDER) {
    const attempts = attemptsFor(run, stage);
    for (const [index, attempt] of attempts.entries()) {
      assertAttemptShape(run, stage, attempt);
      if (seenIds.has(attempt.id)) {
        rejectIntegrity("Stage-attempt identifiers must be globally unique within a run", {
          runId: run.id,
          attemptId: attempt.id
        });
      }
      seenIds.add(attempt.id);
      if (attempt.attemptNumber !== index + 1 || attempt.fencingEpoch !== index + 1) {
        rejectIntegrity("Attempt numbers and fencing epochs must be contiguous and monotonic", {
          runId: run.id,
          stage,
          attemptId: attempt.id,
          expected: index + 1
        });
      }
      if (ACTIVE_ATTEMPT_STATES.has(attempt.state)) activeAttempts.push(attempt);
    }

    const current = attempts.filter((attempt) => attempt.state !== "stale");
    if (current.length > 0 && !prefixComplete && illegalDownstreamStage === undefined) {
      illegalDownstreamStage = stage;
    }
    const successful = current.filter((attempt) => attempt.state === "succeeded");
    if (successful.length > 1 || (successful.length === 1 && current.at(-1)?.state !== "succeeded")) {
      rejectIntegrity("A stage has multiple or superseded current successful attempts", {
        runId: run.id,
        stage
      });
    }
    const stageComplete = successful.length === 1;
    if (!stageComplete && firstIncompleteStage === undefined) {
      firstIncompleteStage = stage;
      firstIncompleteAttempt = current.at(-1);
    }
    prefixComplete = prefixComplete && stageComplete;
  }

  if (activeAttempts.length > 1) {
    rejectIntegrity("Only one active attempt is allowed across an entire run", {
      runId: run.id,
      attemptIds: activeAttempts.map((attempt) => attempt.id)
    });
  }
  if (illegalDownstreamStage !== undefined) {
    rejectIntegrity("A downstream stage exists before all prerequisites succeeded", {
      runId: run.id,
      stage: illegalDownstreamStage,
      firstIncompleteStage
    });
  }

  const requirementAttempt = requirementAttempts[0]!;
  if (!["waiting_approval", "blocked", "succeeded"].includes(requirementAttempt.state)) {
    rejectIntegrity("Requirements attempt has an invalid durable state", {
      runId: run.id,
      attemptState: requirementAttempt.state
    });
  }
  if (requirementAttempt.state === "succeeded") {
    if (requirements!.approvalId === undefined || run.headRevisionId === undefined) {
      rejectIntegrity("Approved requirements lack an approval or committed head", { runId: run.id });
    }
  } else if (requirements!.approvalId !== undefined || run.headRevisionId !== undefined) {
    rejectIntegrity("Unapproved requirements cannot have an approval or committed head", { runId: run.id });
  }

  switch (run.state) {
    case "waiting_requirements_approval":
      if (firstIncompleteStage !== "requirements" || firstIncompleteAttempt?.state !== "waiting_approval") {
        rejectIntegrity("Waiting run is not aligned with its requirements attempt", { runId: run.id });
      }
      break;
    case "blocked":
      if (firstIncompleteAttempt?.state !== "blocked" || activeAttempts.length !== 0) {
        rejectIntegrity("Blocked run is not aligned with the first incomplete stage", {
          runId: run.id,
          firstIncompleteStage
        });
      }
      break;
    case "interrupted":
      if (firstIncompleteAttempt?.state !== "interrupted" || activeAttempts.length !== 0) {
        rejectIntegrity("Interrupted run is not aligned with the first incomplete stage", {
          runId: run.id,
          firstIncompleteStage
        });
      }
      break;
    case "queued":
      if (
        requirementAttempt.state !== "succeeded" ||
        activeAttempts.length !== 0 ||
        firstIncompleteStage === undefined ||
        firstIncompleteAttempt !== undefined
      ) {
        rejectIntegrity("Queued run must be approved, inactive, and incomplete", { runId: run.id });
      }
      break;
    case "running": {
      const active = activeAttempts[0];
      const betweenStages = active === undefined && firstIncompleteAttempt === undefined;
      const executingFirstIncomplete =
        active !== undefined &&
        active === firstIncompleteAttempt &&
        active.state === "running" &&
        active.stage === firstIncompleteStage;
      if (
        requirementAttempt.state !== "succeeded" ||
        firstIncompleteStage === undefined ||
        (!betweenStages && !executingFirstIncomplete)
      ) {
        rejectIntegrity("Running run is not aligned with the first incomplete stage", {
          runId: run.id,
          firstIncompleteStage,
          activeAttemptId: active?.id
        });
      }
      break;
    }
    case "completed":
      if (firstIncompleteStage !== undefined || activeAttempts.length !== 0) {
        rejectIntegrity("Completed run does not have a current success for every stage", {
          runId: run.id,
          firstIncompleteStage
        });
      }
      break;
    case "cancelled":
      if (activeAttempts.length !== 0) {
        rejectIntegrity("Cancelled run cannot retain an active attempt", { runId: run.id });
      }
      break;
  }

  return {
    activeAttempts,
    ...(firstIncompleteStage === undefined ? {} : { firstIncompleteStage }),
    ...(firstIncompleteAttempt === undefined ? {} : { firstIncompleteAttempt })
  };
};

/** Validate a newly inserted aggregate against the only current creation path. */
export const assertInitialDesignRunState = (run: DesignRun): void => {
  assertRunSnapshot(run);
  if (run.state !== "waiting_requirements_approval" && run.state !== "blocked") {
    rejectAggregate("New run has an invalid initial state", {
      runId: run.id,
      state: run.state,
      allowed: ["waiting_requirements_approval", "blocked"]
    });
  }

  if (
    run.parentRunId !== undefined ||
    run.headRevisionId !== undefined ||
    run.revision !== 0 ||
    run.createdAt !== run.updatedAt ||
    run.requirements?.approvalId !== undefined
  ) {
    rejectAggregate("New run has invalid immutable creation metadata", {
      runId: run.id,
      parentRunId: run.parentRunId,
      headRevisionId: run.headRevisionId,
      revision: run.revision
    });
  }

  const requirementAttempts = attemptsFor(run, "requirements");
  if (requirementAttempts.length !== 1) {
    rejectAggregate("New run must contain exactly one requirements attempt", {
      runId: run.id,
      count: requirementAttempts.length
    });
  }
  const requirementAttempt = requirementAttempts[0]!;
  const expectedAttemptState =
    run.state === "waiting_requirements_approval" ? "waiting_approval" : "blocked";
  if (requirementAttempt.state !== expectedAttemptState) {
    rejectAggregate("Initial run and requirements-attempt states do not agree", {
      runId: run.id,
      runState: run.state,
      attemptId: requirementAttempt.id,
      attemptState: requirementAttempt.state,
      expectedAttemptState
    });
  }

  for (const stage of STAGE_ORDER.slice(1)) {
    if (attemptsFor(run, stage).length !== 0) {
      rejectAggregate("New run contains a downstream attempt before requirements approval", {
        runId: run.id,
        stage
      });
    }
  }
};

const ACTIVE_ATTEMPT_STATES: ReadonlySet<StageAttemptState> = new Set([
  "pending",
  "running",
  "waiting_approval"
]);

const assertAttemptTransitionFields = (
  previous: StageAttempt,
  next: StageAttempt
): void => {
  for (const [field, left, right] of [
    ["id", previous.id, next.id],
    ["stage", previous.stage, next.stage],
    ["attemptNumber", previous.attemptNumber, next.attemptNumber],
    ["inputManifest", previous.inputManifest, next.inputManifest],
    ["provisionIdentity", previous.provisionIdentity, next.provisionIdentity],
    ["provisionManifestBlob", previous.provisionManifestBlob, next.provisionManifestBlob],
    ["executionFence", previous.executionFence, next.executionFence],
    ["startedAt", previous.startedAt, next.startedAt],
    ["fencingEpoch", previous.fencingEpoch, next.fencingEpoch]
  ] as const) {
    assertImmutableField("stage_attempt", previous.id, field, left, right);
  }

  if (previous.state === next.state) {
    if (!sameJson(previous, next)) {
      rejectAggregate("A stage-attempt self transition cannot rewrite fields", {
        attemptId: previous.id,
        stage: previous.stage,
        state: previous.state
      });
    }
    return;
  }

  if (next.state === "stale") {
    const { state: _previousState, ...previousWithoutState } = previous;
    const { state: _nextState, ...nextWithoutState } = next;
    if (!sameJson(previousWithoutState, nextWithoutState)) {
      rejectAggregate("Staling an attempt may only change its state", {
        attemptId: previous.id,
        stage: previous.stage,
        previousState: previous.state
      });
    }
    return;
  }

  if (previous.state === "running" && next.state === "interrupted") {
    if (
      !sameJson(previous.outputIdentity, next.outputIdentity) ||
      !sameJson(previous.artifactIds, next.artifactIds) ||
      !sameJson(previous.evidenceIds, next.evidenceIds) ||
      next.blockers.length <= previous.blockers.length ||
      !sameJson(previous.blockers, next.blockers.slice(0, previous.blockers.length)) ||
      previous.completedAt !== undefined ||
      next.completedAt === undefined
    ) {
      rejectAggregate("Interrupting an attempt may only append recovery blockers and completion", {
        attemptId: previous.id,
        stage: previous.stage
      });
    }
    return;
  }

  if (
    (previous.state === "running" && (next.state === "blocked" || next.state === "succeeded")) ||
    (previous.state === "waiting_approval" && next.state === "succeeded")
  ) {
    return;
  }

  rejectAggregate("Stage-attempt transition has no legal field mutation contract", {
    attemptId: previous.id,
    stage: previous.stage,
    from: previous.state,
    to: next.state
  });
};

/**
 * Validate an aggregate update before it crosses the persistence boundary.
 * Histories are append-only, existing attempts follow the table, and a retry is
 * represented by one newly appended `running` attempt.
 */
export const assertDesignRunTransition = (previous: DesignRun, next: DesignRun): void => {
  assertRunSnapshot(previous);
  if (previous.id !== next.id || previous.projectId !== next.projectId) {
    rejectAggregate("Run identity cannot change during a state transition", {
      previousRunId: previous.id,
      nextRunId: next.id,
      previousProjectId: previous.projectId,
      nextProjectId: next.projectId
    });
  }
  assertCandidateRun(next);
  assertRunSnapshot(next);
  assertRunStateTransition(previous.state, next.state, previous.id);

  for (const [field, left, right] of [
    ["id", previous.id, next.id],
    ["projectId", previous.projectId, next.projectId],
    ["parentRunId", previous.parentRunId, next.parentRunId],
    ["sourcePrompt", previous.sourcePrompt, next.sourcePrompt],
    ["workflowVersion", previous.workflowVersion, next.workflowVersion],
    ["configuration", previous.configuration, next.configuration],
    ["createdAt", previous.createdAt, next.createdAt]
  ] as const) {
    assertImmutableField("run", previous.id, field, left, right);
  }
  if (!sameJson(requirementCore(previous.requirements), requirementCore(next.requirements))) {
    rejectAggregate("Requirements content is immutable within a run", { runId: previous.id });
  }
  const previousApprovalId = previous.requirements?.approvalId;
  const nextApprovalId = next.requirements?.approvalId;
  if (previousApprovalId !== undefined && previousApprovalId !== nextApprovalId) {
    rejectAggregate("Requirements approval cannot be removed or replaced", { runId: previous.id });
  }

  const seenAttemptIds = new Set<string>();
  const previousAnalysis = assertRunSnapshot(previous);
  let appendedAttempts = 0;
  for (const stage of STAGE_ORDER) {
    const before = attemptsFor(previous, stage);
    const after = attemptsFor(next, stage);
    if (after.length < before.length) {
      rejectAggregate("Stage-attempt history is append-only", {
        runId: next.id,
        stage,
        previousCount: before.length,
        nextCount: after.length
      });
    }

    for (const [index, attempt] of after.entries()) {
      assertAttemptShape(next, stage, attempt);
      if (seenAttemptIds.has(attempt.id)) {
        rejectAggregate("Stage-attempt identifiers must be unique within a run", {
          runId: next.id,
          stage,
          attemptId: attempt.id
        });
      }
      seenAttemptIds.add(attempt.id);

      const prior = before[index];
      if (prior !== undefined) {
        if (prior.id !== attempt.id) {
          rejectAggregate("Stage-attempt history cannot be reordered or replaced", {
            runId: next.id,
            stage,
            index,
            previousAttemptId: prior.id,
            nextAttemptId: attempt.id
          });
        }
        assertStageAttemptStateTransition(prior.state, attempt.state, attempt.id, stage);
        assertAttemptTransitionFields(prior, attempt);
      } else {
        if (stage === "requirements" || attempt.state !== "running") {
          rejectAggregate("Retries must append a new running non-requirements attempt", {
            runId: next.id,
            stage,
            attemptId: attempt.id,
            state: attempt.state
          });
        }
        appendedAttempts += 1;
        if (previousAnalysis.firstIncompleteStage !== stage) {
          rejectAggregate("A new attempt must target the first incomplete workflow stage", {
            runId: next.id,
            stage,
            firstIncompleteStage: previousAnalysis.firstIncompleteStage
          });
        }
      }
    }
  }

  if (appendedAttempts > 1) {
    rejectAggregate("A run transition may append at most one new attempt", {
      runId: next.id,
      appendedAttempts
    });
  }

  const requirementBefore = previous.attempts.requirements[0]!;
  const requirementAfter = next.attempts.requirements[0]!;
  if (previousApprovalId === undefined && nextApprovalId !== undefined) {
    if (
      previous.state !== "waiting_requirements_approval" ||
      next.state !== "queued" ||
      requirementBefore.state !== "waiting_approval" ||
      requirementAfter.state !== "succeeded"
    ) {
      rejectAggregate("Requirements approval must atomically resolve the waiting attempt", {
        runId: next.id,
        approvalId: nextApprovalId
      });
    }
  }

  const changed = !sameJson(previous, next);
  if (changed && next.revision !== previous.revision + 1) {
    rejectAggregate("A changed run must increment its entity revision exactly once", {
      runId: next.id,
      previousRevision: previous.revision,
      nextRevision: next.revision
    });
  }
  if (!changed && next.revision !== previous.revision) {
    rejectAggregate("An unchanged run cannot change its entity revision", { runId: next.id });
  }
  if (Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)) {
    rejectAggregate("Run updatedAt cannot move backwards", {
      runId: next.id,
      previousUpdatedAt: previous.updatedAt,
      nextUpdatedAt: next.updatedAt
    });
  }
};

export interface WorkflowStateRecords {
  readonly projects: Readonly<Record<string, Project>>;
  readonly runs: Readonly<Record<string, DesignRun>>;
  readonly revisions: Readonly<Record<string, DesignRevision>>;
  readonly artifacts: Readonly<Record<string, ArtifactRecord>>;
  readonly evidence: Readonly<Record<string, EvidenceRecord>>;
  readonly approvals: Readonly<Record<string, ApprovalRecord>>;
  readonly invocations: Readonly<Record<string, ToolInvocationRecord>>;
}

export interface WorkflowStateValidationOptions {
  readonly approvedNativeProcessContracts?: ApprovedNativeProcessContractRegistryV2;
}

const ownRecord = <Value>(
  record: Readonly<Record<string, Value>>,
  key: string
): Value | undefined => Object.hasOwn(record, key) ? record[key] : undefined;

const assertProjectSnapshot = (key: string, project: Project): void => {
  if (project.id !== key || project.id.length === 0) {
    rejectIntegrity("Project map key must match a nonempty internal identifier", {
      key,
      projectId: project.id
    });
  }
  if (!Number.isSafeInteger(project.revision) || project.revision < 0) {
    rejectIntegrity("Project has an invalid entity revision", {
      projectId: project.id,
      revision: project.revision
    });
  }
  if (new Set(project.runIds).size !== project.runIds.length) {
    rejectIntegrity("Project run history contains duplicate run identifiers", {
      projectId: project.id
    });
  }
};

const assertCandidateRecord = (
  kind: "revision" | "artifact" | "evidence",
  key: string,
  record: DesignRevision | ArtifactRecord | EvidenceRecord
): void => {
  if (record.id !== key) {
    rejectIntegrity(`${kind} map key does not match its internal identifier`, {
      kind,
      key,
      id: record.id
    });
  }
  if (record.id.length === 0 || record.lifecycle !== "candidate") {
    rejectIntegrity(`Stored ${kind} must have a nonempty ID and candidate lifecycle`, {
      kind,
      key,
      lifecycle: record.lifecycle
    });
  }
};

/** Validate state-correlated run, attempt, head, and candidate-only invariants. */
export const assertWorkflowStateSnapshot = (
  state: WorkflowStateRecords,
  options: WorkflowStateValidationOptions = {}
): void => {
  const projectIds = new Set<string>();
  for (const [key, project] of Object.entries(state.projects)) {
    if (projectIds.has(project.id)) {
      rejectIntegrity("Project internal identifiers must be unique", { key, projectId: project.id });
    }
    projectIds.add(project.id);
    assertProjectSnapshot(key, project);
  }

  const runIds = new Set<string>();
  for (const [key, run] of Object.entries(state.runs)) {
    if (run.id !== key || runIds.has(run.id)) {
      rejectIntegrity("Run map key and internal identifiers must be unique and equal", {
        key,
        runId: run.id
      });
    }
    runIds.add(run.id);
    assertRunSnapshot(run);
    const project = ownRecord(state.projects, run.projectId);
    if (project === undefined || !project.runIds.includes(run.id)) {
      rejectIntegrity("Run is not owned by its recorded project", {
        runId: run.id,
        projectId: run.projectId
      });
    }
  }

  for (const [key, revision] of Object.entries(state.revisions)) {
    assertCandidateRecord("revision", key, revision);
    if (
      new Set(revision.parentRevisionIds).size !== revision.parentRevisionIds.length ||
      new Set(revision.artifactIds).size !== revision.artifactIds.length ||
      new Set(revision.evidenceIds).size !== revision.evidenceIds.length
    ) {
      rejectIntegrity("Revision parent and inventory identifiers must be unique", {
        revisionId: revision.id
      });
    }
    const run = ownRecord(state.runs, revision.runId);
    if (run === undefined || run.projectId !== revision.projectId) {
      rejectIntegrity("Revision does not belong to its recorded run and project", {
        revisionId: revision.id,
        runId: revision.runId
      });
    }
    if (revision.createdByAttemptId !== undefined) {
      const creatingAttempts = STAGE_ORDER.flatMap((stage) =>
        attemptsFor(run!, stage).filter((attempt) => attempt.id === revision.createdByAttemptId)
      );
      if (
        creatingAttempts.length !== 1 ||
        creatingAttempts[0]!.resultRevisionId !== revision.id ||
        !["succeeded", "stale"].includes(creatingAttempts[0]!.state)
      ) {
        rejectIntegrity("Revision created-by-attempt binding is missing, ambiguous, or inconsistent", {
          revisionId: revision.id,
          createdByAttemptId: revision.createdByAttemptId
        });
      }
    }
    const siblingOrdinals = Object.values(state.revisions)
      .filter((entry) => entry.runId === revision.runId && entry.ordinal === revision.ordinal);
    if (siblingOrdinals.length !== 1) {
      rejectIntegrity("Revision ordinal must be unique within its run", {
        revisionId: revision.id,
        runId: revision.runId,
        ordinal: revision.ordinal
      });
    }
    for (const parentId of revision.parentRevisionIds) {
      const parent = ownRecord(state.revisions, parentId);
      if (
        parent === undefined ||
        parent.runId !== revision.runId ||
        parent.projectId !== revision.projectId ||
        parent.ordinal >= revision.ordinal
      ) {
        rejectIntegrity("Revision parent is missing or outside its ordered run ancestry", {
          revisionId: revision.id,
          parentRevisionId: parentId
        });
      }
    }
    for (const artifactId of revision.artifactIds) {
      const artifact = ownRecord(state.artifacts, artifactId);
      if (
        artifact === undefined ||
        artifact.runId !== revision.runId ||
        artifact.projectId !== revision.projectId
      ) {
        rejectIntegrity("Revision artifact inventory references a missing or foreign artifact", {
          revisionId: revision.id,
          artifactId
        });
      }
    }
    for (const evidenceId of revision.evidenceIds) {
      const entry = ownRecord(state.evidence, evidenceId);
      if (
        entry === undefined ||
        entry.runId !== revision.runId ||
        entry.projectId !== revision.projectId
      ) {
        rejectIntegrity("Revision evidence inventory references missing or foreign evidence", {
          revisionId: revision.id,
          evidenceId
        });
      }
    }
  }
  for (const [key, artifact] of Object.entries(state.artifacts)) {
    assertCandidateRecord("artifact", key, artifact);
    if (
      new Set(artifact.derivedFrom).size !== artifact.derivedFrom.length ||
      artifact.derivedFrom.includes(artifact.id)
    ) {
      rejectIntegrity("Artifact derivation cannot contain duplicates or a self-reference", {
        artifactId: artifact.id
      });
    }
    const revision = ownRecord(state.revisions, artifact.designRevisionId);
    if (
      revision === undefined ||
      revision.runId !== artifact.runId ||
      revision.projectId !== artifact.projectId
    ) {
      rejectIntegrity("Artifact does not belong to its recorded revision", {
        artifactId: artifact.id,
        revisionId: artifact.designRevisionId
      });
    }
    if (artifact.staleAt !== undefined && artifact.validationStatus !== "stale") {
      rejectIntegrity("Artifact stale timestamp and validation state disagree", {
        artifactId: artifact.id,
        validationStatus: artifact.validationStatus,
        staleAt: artifact.staleAt
      });
    }
    for (const sourceId of artifact.derivedFrom) {
      const source = ownRecord(state.artifacts, sourceId);
      if (source === undefined || source.runId !== artifact.runId) {
        rejectIntegrity("Artifact derivation references a missing or foreign-run artifact", {
          artifactId: artifact.id,
          sourceArtifactId: sourceId
        });
      }
    }
  }
  for (const [key, entry] of Object.entries(state.evidence)) {
    assertCandidateRecord("evidence", key, entry);
    const revision = ownRecord(state.revisions, entry.designRevisionId);
    if (
      revision === undefined ||
      revision.runId !== entry.runId ||
      revision.projectId !== entry.projectId
    ) {
      rejectIntegrity("Evidence does not belong to its recorded revision", {
        evidenceId: entry.id,
        revisionId: entry.designRevisionId
      });
    }
    if (entry.staleAt !== undefined && entry.validationStatus !== "stale") {
      rejectIntegrity("Evidence stale timestamp and validation state disagree", {
        evidenceId: entry.id,
        validationStatus: entry.validationStatus,
        staleAt: entry.staleAt
      });
    }
    for (const artifactId of [entry.rawArtifactId, entry.parsedArtifactId]) {
      if (artifactId === undefined) continue;
      const artifact = ownRecord(state.artifacts, artifactId);
      if (
        artifact === undefined ||
        artifact.runId !== entry.runId ||
        artifact.projectId !== entry.projectId ||
        artifact.designRevisionId !== entry.designRevisionId ||
        artifact.stage !== entry.stage
      ) {
        rejectIntegrity("Evidence references a missing or foreign-run artifact", {
          evidenceId: entry.id,
          artifactId
        });
      }
    }
    if (
      entry.rawArtifactId !== undefined &&
      entry.parsedArtifactId !== undefined &&
      entry.rawArtifactId === entry.parsedArtifactId
    ) {
      rejectIntegrity("Evidence raw and parsed artifact references must be distinct", {
        evidenceId: entry.id,
        artifactId: entry.rawArtifactId
      });
    }
  }

  const artifactVisitState = new Map<string, "visiting" | "complete">();
  const visitArtifact = (artifactId: string): void => {
    const visitState = artifactVisitState.get(artifactId);
    if (visitState === "visiting") {
      rejectIntegrity("Artifact derivation graph contains a cycle", { artifactId });
    }
    if (visitState === "complete") return;
    artifactVisitState.set(artifactId, "visiting");
    const artifact = ownRecord(state.artifacts, artifactId)!;
    for (const sourceId of artifact.derivedFrom) visitArtifact(sourceId);
    artifactVisitState.set(artifactId, "complete");
  };
  for (const artifactId of Object.keys(state.artifacts)) visitArtifact(artifactId);

  const revisionAncestry = (revisionId: string): ReadonlySet<string> => {
    const ancestry = new Set<string>();
    const pending = [revisionId];
    while (pending.length > 0) {
      const currentId = pending.pop()!;
      if (ancestry.has(currentId)) continue;
      ancestry.add(currentId);
      const current = ownRecord(state.revisions, currentId)!;
      pending.push(...current.parentRevisionIds);
    }
    return ancestry;
  };
  for (const revision of Object.values(state.revisions)) {
    const ancestry = revisionAncestry(revision.id);
    for (const artifactId of revision.artifactIds) {
      const origin = ownRecord(state.artifacts, artifactId)!;
      if (!ancestry.has(origin.designRevisionId)) {
        rejectIntegrity("Revision inventory contains an artifact from a sibling branch", {
          revisionId: revision.id,
          artifactId,
          originRevisionId: origin.designRevisionId
        });
      }
    }
    for (const evidenceId of revision.evidenceIds) {
      const origin = ownRecord(state.evidence, evidenceId)!;
      if (!ancestry.has(origin.designRevisionId)) {
        rejectIntegrity("Revision inventory contains evidence from a sibling branch", {
          revisionId: revision.id,
          evidenceId,
          originRevisionId: origin.designRevisionId
        });
      }
    }
  }
  for (const artifact of Object.values(state.artifacts)) {
    const ancestry = revisionAncestry(artifact.designRevisionId);
    for (const sourceId of artifact.derivedFrom) {
      const source = ownRecord(state.artifacts, sourceId)!;
      if (!ancestry.has(source.designRevisionId)) {
        rejectIntegrity("Artifact derivation crosses a sibling revision branch", {
          artifactId: artifact.id,
          sourceArtifactId: source.id,
          originRevisionId: artifact.designRevisionId,
          sourceRevisionId: source.designRevisionId
        });
      }
    }
  }

  for (const project of Object.values(state.projects)) {
    for (const runId of project.runIds) {
      const run = ownRecord(state.runs, runId);
      if (run === undefined || run.projectId !== project.id) {
        rejectIntegrity("Project run history references a missing or foreign project run", {
          projectId: project.id,
          runId
        });
      }
    }
    if (project.headRevisionId !== undefined) {
      const head = ownRecord(state.revisions, project.headRevisionId);
      const owningRun = head === undefined ? undefined : ownRecord(state.runs, head.runId);
      if (
        head === undefined ||
        head.projectId !== project.id ||
        owningRun?.headRevisionId !== head.id
      ) {
        rejectIntegrity("Project head references a missing or foreign project revision", {
          projectId: project.id,
          headRevisionId: project.headRevisionId
        });
      }
    }
  }

  for (const [key, approval] of Object.entries(state.approvals)) {
    if (approval.id !== key || approval.id.length === 0) {
      rejectIntegrity("Approval map key must match a nonempty internal identifier", {
        key,
        approvalId: approval.id
      });
    }
    const project = ownRecord(state.projects, approval.projectId);
    const run = approval.runId === undefined ? undefined : ownRecord(state.runs, approval.runId);
    const revision = approval.designRevisionId === undefined
      ? undefined
      : ownRecord(state.revisions, approval.designRevisionId);
    if (
      project === undefined ||
      (approval.runId !== undefined && (run === undefined || run.projectId !== approval.projectId)) ||
      (approval.designRevisionId !== undefined &&
        (revision === undefined ||
          revision.projectId !== approval.projectId ||
          (approval.runId !== undefined && revision.runId !== approval.runId)))
    ) {
      rejectIntegrity("Approval ownership references a missing or foreign aggregate", {
        approvalId: approval.id,
        projectId: approval.projectId,
        runId: approval.runId,
        designRevisionId: approval.designRevisionId
      });
    }
  }

  for (const run of Object.values(state.runs)) {
    if (run.headRevisionId !== undefined) {
      const head = ownRecord(state.revisions, run.headRevisionId);
      if (head === undefined || head.runId !== run.id || head.projectId !== run.projectId) {
        rejectIntegrity("Run head does not reference a candidate revision in the same run", {
          runId: run.id,
          headRevisionId: run.headRevisionId
        });
      }
    }
    const approvalId = run.requirements?.approvalId;
    if (approvalId !== undefined) {
      const approval = ownRecord(state.approvals, approvalId);
      if (
        approval === undefined ||
        approval.kind !== "requirements" ||
        approval.runId !== run.id ||
        approval.projectId !== run.projectId ||
        approval.subjectDigest !== run.requirements?.identity.digest
      ) {
        rejectIntegrity("Requirements approval does not bind the exact run and digest", {
          runId: run.id,
          approvalId
        });
      }
    }
    for (const stage of STAGE_ORDER) {
      for (const attempt of attemptsFor(run, stage)) {
        if (attempt.resultRevisionId !== undefined) {
          const resultRevision = ownRecord(state.revisions, attempt.resultRevisionId);
          if (
            resultRevision === undefined ||
            resultRevision.projectId !== run.projectId ||
            resultRevision.runId !== run.id ||
            resultRevision.createdByAttemptId !== attempt.id ||
            (attempt.executionFence !== undefined &&
              !resultRevision.parentRevisionIds.includes(attempt.executionFence.parentRevisionId)) ||
            attempt.artifactIds.some((artifactId) =>
              ownRecord(state.artifacts, artifactId)?.designRevisionId !== resultRevision.id ||
              !resultRevision.artifactIds.includes(artifactId)
            ) ||
            attempt.evidenceIds.some((evidenceId) =>
              ownRecord(state.evidence, evidenceId)?.designRevisionId !== resultRevision.id ||
              !resultRevision.evidenceIds.includes(evidenceId)
            )
          ) {
            rejectIntegrity("Attempt result revision is not its exact committed child output", {
              runId: run.id,
              stage,
              attemptId: attempt.id,
              resultRevisionId: attempt.resultRevisionId
            });
          }
        }
        for (const artifactId of attempt.artifactIds) {
          const artifact = ownRecord(state.artifacts, artifactId);
          if (artifact === undefined || artifact.runId !== run.id || artifact.stage !== stage) {
            rejectIntegrity("Attempt artifact does not bind the same run and stage", {
              runId: run.id,
              stage,
              attemptId: attempt.id,
              artifactId
            });
          }
        }
        for (const evidenceId of attempt.evidenceIds) {
          const entry = ownRecord(state.evidence, evidenceId);
          if (entry === undefined || entry.runId !== run.id || entry.stage !== stage) {
            rejectIntegrity("Attempt evidence does not bind the same run and stage", {
              runId: run.id,
              stage,
              attemptId: attempt.id,
              evidenceId
            });
          }
        }
      }
    }
  }

  const commandPlanBindings = new Set<string>();
  for (const [key, invocation] of Object.entries(state.invocations)) {
    const parsed = toolInvocationRecordSchema.safeParse(invocation);
    if (!parsed.success) {
      rejectIntegrity("State tool-invocation record is invalid", {
        key,
        issues: parsed.error.issues.slice(0, 10).map((issue) => ({
          path: issue.path,
          code: issue.code,
          message: issue.message
        }))
      });
    }
    if (invocation.id !== key) {
      rejectIntegrity("Tool-invocation map key does not match its internal identifier", {
        key,
        invocationId: invocation.id
      });
    }
    const approvedContracts = options.approvedNativeProcessContracts;
    if (approvedContracts === undefined) {
      rejectIntegrity("State contains a native-process invocation without an approved command-contract registry", {
        invocationId: invocation.id,
        profileDomain: invocation.commandPlan.profile.domain,
        operation: invocation.commandPlan.profile.operation
      });
    }
    try {
      approvedContracts!.assertApproved(invocation.commandPlan);
    } catch (error) {
      rejectIntegrity("State native-process invocation fails its approved operation-specific command contract", {
        invocationId: invocation.id,
        causeCode: error instanceof DomainError ? error.code : undefined,
        cause: error instanceof Error ? error.message : String(error)
      });
    }
    const project = ownRecord(state.projects, invocation.projectId);
    const run = ownRecord(state.runs, invocation.runId);
    if (project === undefined || run === undefined || run.projectId !== project.id) {
      rejectIntegrity("Tool invocation is not owned by its recorded project and run", {
        invocationId: invocation.id,
        projectId: invocation.projectId,
        runId: invocation.runId
      });
    }
    const owningRun = run!;
    const attempt = attemptsFor(owningRun, invocation.stage).find(
      (candidate) => candidate.id === invocation.attemptId
    );
    if (
      attempt === undefined ||
      attempt.stage !== invocation.stage ||
      attempt.fencingEpoch !== invocation.fencingEpoch ||
      attempt.executionFence === undefined ||
      !sameJson(attempt.inputManifest, invocation.inputManifest) ||
      !sameJson(attempt.executionFence, invocation.executionFence)
    ) {
      rejectIntegrity("Tool invocation does not bind the exact owning attempt and execution fence", {
        invocationId: invocation.id,
        runId: invocation.runId,
        attemptId: invocation.attemptId,
        stage: invocation.stage
      });
    }
    const owningAttempt = attempt!;
    if (invocation.inputManifest.schemaVersion !== `evleda.stage-input.${invocation.stage}.v1`) {
      rejectIntegrity("Tool invocation input manifest has the wrong stage schema", {
        invocationId: invocation.id,
        stage: invocation.stage,
        schemaVersion: invocation.inputManifest.schemaVersion
      });
    }
    if (
      owningAttempt.startedAt === undefined ||
      !isExactMillisecondUtcTimestamp(owningAttempt.startedAt) ||
      (owningAttempt.completedAt !== undefined &&
        !isExactMillisecondUtcTimestamp(owningAttempt.completedAt)) ||
      invocation.startedAt < owningAttempt.startedAt ||
      (owningAttempt.completedAt !== undefined &&
        invocation.startedAt > owningAttempt.completedAt) ||
      (invocation.completedAt !== null &&
        owningAttempt.completedAt !== undefined &&
        invocation.completedAt > owningAttempt.completedAt)
    ) {
      rejectIntegrity("Tool invocation timestamps fall outside its owning attempt", {
        invocationId: invocation.id,
        attemptId: owningAttempt.id
      });
    }
    if (
      invocation.outcome === "unknown" &&
      !["running", "interrupted", "stale"].includes(owningAttempt.state)
    ) {
      rejectIntegrity("Only a running or crash-fenced attempt may retain an unknown tool invocation", {
        invocationId: invocation.id,
        attemptId: owningAttempt.id,
        attemptState: owningAttempt.state
      });
    }
    if (
      (owningAttempt.state === "succeeded" || owningAttempt.resultRevisionId !== undefined) &&
      invocation.outcome !== "succeeded"
    ) {
      rejectIntegrity("A successful or subsequently stale attempt cannot own a non-successful tool invocation", {
        invocationId: invocation.id,
        attemptId: owningAttempt.id,
        invocationOutcome: invocation.outcome
      });
    }
    if (
      invocation.outcome !== "unknown" &&
      !isTerminalToolInvocationOutcome(invocation.outcome)
    ) {
      rejectIntegrity("Tool invocation has an unsupported terminal outcome", {
        invocationId: invocation.id,
        outcome: invocation.outcome
      });
    }
    const fence = owningAttempt.executionFence!;
    const parentRevision = ownRecord(state.revisions, fence.parentRevisionId);
    const approval = ownRecord(state.approvals, fence.requirementsApprovalId);
    if (
      fence.projectHeadRevisionId !== fence.parentRevisionId ||
      parentRevision === undefined ||
      parentRevision.projectId !== invocation.projectId ||
      parentRevision.runId !== invocation.runId ||
      !sameJson(parentRevision.manifest, fence.parentRevisionManifest) ||
      approval === undefined ||
      approval.kind !== "requirements" ||
      approval.projectId !== invocation.projectId ||
      approval.runId !== invocation.runId ||
      approval.id !== fence.requirementsApprovalId ||
      approval.subjectDigest !== fence.requirementsApprovalDigest ||
      owningRun.requirements?.approvalId !== approval.id ||
      owningRun.requirements.identity.digest !== approval.subjectDigest
    ) {
      rejectIntegrity("Tool invocation execution fence is not authentic to durable revision and approval records", {
        invocationId: invocation.id,
        attemptId: owningAttempt.id,
        parentRevisionId: fence.parentRevisionId,
        approvalId: fence.requirementsApprovalId
      });
    }
    const approvedPlanBindings = fence.nativeProcessPlanBindings?.filter((binding) =>
      binding.profileDomain === invocation.commandPlan.profile.domain &&
      binding.operation === invocation.commandPlan.profile.operation &&
      sameJson(binding.contractIdentity, invocation.commandPlan.profile.contractIdentity) &&
      sameJson(binding.planIdentity, invocation.commandPlanIdentity)
    ) ?? [];
    if (approvedPlanBindings.length !== 1) {
      rejectIntegrity("Tool invocation command plan is not prebound by its durable execution fence", {
        invocationId: invocation.id,
        attemptId: owningAttempt.id,
        matchingPlanBindings: approvedPlanBindings.length
      });
    }
    if (
      owningAttempt.state === "running" &&
      (owningRun.headRevisionId !== fence.parentRevisionId ||
        project!.headRevisionId !== fence.parentRevisionId)
    ) {
      rejectIntegrity("An unfinished or failed attempt fence no longer matches the durable run head", {
        invocationId: invocation.id,
        attemptId: owningAttempt.id,
        parentRevisionId: fence.parentRevisionId,
        runHeadRevisionId: owningRun.headRevisionId,
        projectHeadRevisionId: project!.headRevisionId
      });
    }
    if (owningAttempt.state === "succeeded") {
      const resultRevision = owningAttempt.resultRevisionId === undefined
        ? undefined
        : ownRecord(state.revisions, owningAttempt.resultRevisionId);
      if (
        resultRevision === undefined ||
        resultRevision.createdByAttemptId !== owningAttempt.id ||
        !resultRevision.parentRevisionIds.includes(fence.parentRevisionId) ||
        resultRevision.runId !== owningRun.id ||
        resultRevision.projectId !== project!.id
      ) {
        rejectIntegrity("A successful attempt invocation is not connected to its committed child revision", {
          invocationId: invocation.id,
          attemptId: owningAttempt.id,
          resultRevisionId: owningAttempt.resultRevisionId
        });
      }
    }
    const binding = [
      invocation.projectId,
      invocation.runId,
      invocation.attemptId,
      invocation.commandPlanIdentity.digest
    ].join("\u0000");
    if (commandPlanBindings.has(binding)) {
      rejectIntegrity("An attempt cannot record the same typed command plan more than once", {
        invocationId: invocation.id,
        attemptId: invocation.attemptId,
        commandPlanDigest: invocation.commandPlanIdentity.digest
      });
    }
    commandPlanBindings.add(binding);
  }
};

const staleTransitionCount = (previous: DesignRun, next: DesignRun): number =>
  STAGE_ORDER.reduce((count, stage) =>
    count + previous.attempts[stage].filter(
      (attempt, index) =>
        attempt.state !== "stale" && next.attempts[stage][index]?.state === "stale"
    ).length, 0);

const newlySucceededAttempts = (
  previous: DesignRun,
  next: DesignRun
): readonly StageAttempt[] =>
  STAGE_ORDER.flatMap((stage) =>
    previous.attempts[stage].flatMap((attempt, index) => {
      const after = next.attempts[stage][index];
      return attempt.state !== "succeeded" && after?.state === "succeeded" ? [after] : [];
    })
  );

const sameStringSet = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length &&
  [...left].sort().every((value, index) => value === [...right].sort()[index]);

const assertGeneratedBringupHead = (
  previousRun: DesignRun,
  nextRun: DesignRun,
  previous: WorkflowStateRecords,
  next: WorkflowStateRecords,
  head: DesignRevision
): void => {
  const parentId = previousRun.headRevisionId;
  const parent = parentId === undefined ? undefined : ownRecord(previous.revisions, parentId);
  const newRevisions = Object.values(next.revisions).filter(
    (revision) => !Object.hasOwn(previous.revisions, revision.id)
  );
  const newArtifacts = Object.values(next.artifacts).filter(
    (artifact) => !Object.hasOwn(previous.artifacts, artifact.id)
  );
  const newEvidence = Object.values(next.evidence).filter(
    (entry) => !Object.hasOwn(previous.evidence, entry.id)
  );
  const generated = newArtifacts[0];
  const expectedInputs = parent === undefined
    ? []
    : [parent.manifest, nextRun.requirements!.identity];
  const expectedBlob = parent === undefined
    ? undefined
    : contentIdentity(generatedBringupPlan(parent, nextRun.requirements!.identity.digest));
  if (
    parent === undefined ||
    previousRun.state !== nextRun.state ||
    !sameJson(previousRun.attempts, nextRun.attempts) ||
    newRevisions.length !== 1 ||
    newRevisions[0]?.id !== head.id ||
    newArtifacts.length !== 1 ||
    newEvidence.length !== 0 ||
    generated === undefined ||
    generated.designRevisionId !== head.id ||
    generated.stage !== GENERATED_BRINGUP_PLAN_CONTRACT.stage ||
    generated.logicalName !== GENERATED_BRINGUP_PLAN_CONTRACT.logicalName ||
    generated.mediaType !== GENERATED_BRINGUP_PLAN_CONTRACT.mediaType ||
    generated.validationStatus !== GENERATED_BRINGUP_PLAN_CONTRACT.validationStatus ||
    generated.lifecycle !== GENERATED_BRINGUP_PLAN_CONTRACT.lifecycle ||
    !sameJson(generated.tool, GENERATED_BRINGUP_PLAN_CONTRACT.tool) ||
    !sameJson(generated.blob, expectedBlob) ||
    !sameJson(generated.unresolvedAssumptions, [GENERATED_BRINGUP_PLAN_CONTRACT.warning]) ||
    !sameStringSet(generated.derivedFrom, parent.artifactIds) ||
    !sameStringSet(head.artifactIds, [...parent.artifactIds, generated.id]) ||
    !sameStringSet(head.evidenceIds, parent.evidenceIds) ||
    !sameJson(head.parentRevisionIds, [parent.id]) ||
    !sameStringSet(
      generated.exactInputs.map((entry) => canonicalJson(entry)),
      expectedInputs.map((entry) => canonicalJson(entry))
    )
  ) {
    rejectAggregate("A head without stage success must be an exact generated bring-up child", {
      runId: nextRun.id,
      headRevisionId: head.id,
      newRevisionIds: newRevisions.map((revision) => revision.id),
      newArtifactIds: newArtifacts.map((artifact) => artifact.id),
      newEvidenceIds: newEvidence.map((entry) => entry.id)
    });
  }
};

const assertProjectTransition = (previous: Project, next: Project): void => {
  for (const [field, left, right] of [
    ["id", previous.id, next.id],
    ["name", previous.name, next.name],
    ["description", previous.description, next.description],
    ["root", previous.root, next.root],
    ["policyVersion", previous.policyVersion, next.policyVersion],
    ["createdAt", previous.createdAt, next.createdAt]
  ] as const) {
    if (!sameJson(left, right)) {
      rejectAggregate("Immutable project field changed", {
        projectId: previous.id,
        field
      });
    }
  }
  if (
    next.runIds.length < previous.runIds.length ||
    !sameJson(previous.runIds, next.runIds.slice(0, previous.runIds.length))
  ) {
    rejectAggregate("Project run history is append-only", { projectId: previous.id });
  }
  if (next.runIds.length - previous.runIds.length > 1) {
    rejectAggregate("A project transition may append at most one run", {
      projectId: previous.id
    });
  }
  const changed = !sameJson(previous, next);
  if (changed && next.revision !== previous.revision + 1) {
    rejectAggregate("A changed project must increment its entity revision exactly once", {
      projectId: previous.id,
      previousRevision: previous.revision,
      nextRevision: next.revision
    });
  }
  if (Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)) {
    rejectAggregate("Project updatedAt cannot move backwards", { projectId: previous.id });
  }
};

const assertStaleOnlyRecordTransition = (
  kind: "artifact" | "evidence",
  previous: ArtifactRecord | EvidenceRecord,
  next: ArtifactRecord | EvidenceRecord
): void => {
  if (sameJson(previous, next)) return;
  const {
    validationStatus: previousStatus,
    staleAt: previousStaleAt,
    ...previousCore
  } = previous;
  const {
    validationStatus: nextStatus,
    staleAt: nextStaleAt,
    ...nextCore
  } = next;
  if (
    previousStaleAt !== undefined ||
    nextStaleAt === undefined ||
    nextStatus !== "stale" ||
    !sameJson(previousCore, nextCore)
  ) {
    rejectAggregate(`Existing ${kind} records are immutable except for one-way staling`, {
      kind,
      id: previous.id,
      previousStatus,
      nextStatus
    });
  }
};

/** Validate every workflow aggregate changed by one state-store transaction. */
export const assertWorkflowStateTransitions = (
  previous: WorkflowStateRecords,
  next: WorkflowStateRecords,
  options: WorkflowStateValidationOptions = {}
): void => {
  assertWorkflowStateSnapshot(previous, options);
  assertWorkflowStateSnapshot(next, options);

  for (const [projectId, previousProject] of Object.entries(previous.projects)) {
    if (!Object.hasOwn(next.projects, projectId)) {
      rejectAggregate("Project history is append-only", { projectId });
    }
    const nextProject = next.projects[projectId]!;
    assertProjectTransition(previousProject, nextProject);
    if (previousProject.headRevisionId !== nextProject.headRevisionId) {
      const matchingRun = Object.values(next.runs).find(
        (run) => {
          if (run.projectId !== projectId || run.headRevisionId !== nextProject.headRevisionId) {
            return false;
          }
          const prior = ownRecord(previous.runs, run.id);
          return prior !== undefined &&
            (prior.headRevisionId !== run.headRevisionId ||
              (run.state === "queued" && staleTransitionCount(prior, run) > 0));
        }
      );
      if (matchingRun === undefined) {
        rejectAggregate("Project head may change only with an owning run head transition", {
          projectId,
          previousHeadRevisionId: previousProject.headRevisionId,
          nextHeadRevisionId: nextProject.headRevisionId
        });
      }
    }
  }
  for (const [projectId, project] of Object.entries(next.projects)) {
    if (!Object.hasOwn(previous.projects, projectId)) {
      if (
        project.revision !== 0 ||
        project.runIds.length !== 0 ||
        project.headRevisionId !== undefined ||
        project.createdAt !== project.updatedAt
      ) {
        rejectAggregate("New project has invalid immutable creation metadata", { projectId });
      }
    }
  }

  for (const [runId, previousRun] of Object.entries(previous.runs)) {
    if (!Object.hasOwn(next.runs, runId)) {
      rejectAggregate("Run history is append-only", { runId });
    }
    const nextRun = next.runs[runId]!;
    assertDesignRunTransition(previousRun, nextRun);

    if (previousRun.headRevisionId !== nextRun.headRevisionId) {
      const project = ownRecord(next.projects, nextRun.projectId);
      if (project?.headRevisionId !== nextRun.headRevisionId) {
        rejectAggregate("Run and project heads must move atomically to the same revision", {
          runId,
          projectId: nextRun.projectId,
          runHeadRevisionId: nextRun.headRevisionId,
          projectHeadRevisionId: project?.headRevisionId
        });
      }
      const nextHeadRevisionId = nextRun.headRevisionId;
      if (nextHeadRevisionId === undefined) {
        rejectAggregate("An established run head cannot be removed", { runId });
      }
      const target = next.revisions[nextHeadRevisionId!];
      if (target === undefined) {
        rejectAggregate("Run head transition targets a missing revision", {
          runId,
          headRevisionId: nextRun.headRevisionId
        });
      }
      const targetRevision = target!;
      if (Object.hasOwn(previous.revisions, targetRevision.id)) {
        const previousHead = previousRun.headRevisionId === undefined
          ? undefined
          : previous.revisions[previousRun.headRevisionId];
        if (
          staleTransitionCount(previousRun, nextRun) === 0 ||
          previousHead === undefined ||
          targetRevision.ordinal >= previousHead.ordinal
        ) {
          rejectAggregate("A run may rewind only to an older revision while staling a suffix", {
            runId,
            previousHeadRevisionId: previousRun.headRevisionId,
            nextHeadRevisionId: targetRevision.id
          });
        }
      } else {
        const priorOrdinals = Object.values(previous.revisions)
          .filter((revision) => revision.runId === runId)
          .map((revision) => revision.ordinal);
        const expectedOrdinal = Math.max(0, ...priorOrdinals) + 1;
        if (
          targetRevision.ordinal !== expectedOrdinal ||
          (previousRun.headRevisionId === undefined
            ? targetRevision.parentRevisionIds.length !== 0
            : !targetRevision.parentRevisionIds.includes(previousRun.headRevisionId))
        ) {
          rejectAggregate("A new run head must be the next candidate child revision", {
            runId,
            headRevisionId: targetRevision.id,
            expectedOrdinal,
            parentRevisionId: previousRun.headRevisionId
          });
        }
      }
    }

    const succeeded = newlySucceededAttempts(previousRun, nextRun);
    if (succeeded.length > 0) {
      if (succeeded.length !== 1 || nextRun.headRevisionId === previousRun.headRevisionId) {
        rejectAggregate("A successful attempt must atomically create exactly one new run head", {
          runId,
          attemptIds: succeeded.map((attempt) => attempt.id)
        });
      }
      const head = ownRecord(next.revisions, nextRun.headRevisionId!);
      const successfulAttempt = succeeded[0]!;
      const previousHead = previousRun.headRevisionId === undefined
        ? undefined
        : ownRecord(previous.revisions, previousRun.headRevisionId);
      const expectedHeadArtifactIds = [
        ...(previousHead?.artifactIds.filter(
          (artifactId) => ownRecord(next.artifacts, artifactId)?.staleAt === undefined
        ) ?? []),
        ...successfulAttempt.artifactIds
      ];
      const expectedHeadEvidenceIds = [
        ...(previousHead?.evidenceIds.filter(
          (evidenceId) => ownRecord(next.evidence, evidenceId)?.staleAt === undefined
        ) ?? []),
        ...successfulAttempt.evidenceIds
      ];
      const newHeadArtifactIds = head!.artifactIds.filter(
        (artifactId) => ownRecord(next.artifacts, artifactId)?.designRevisionId === head!.id
      );
      const newHeadEvidenceIds = head!.evidenceIds.filter(
        (evidenceId) => ownRecord(next.evidence, evidenceId)?.designRevisionId === head!.id
      );
      if (
        !sameStringSet(head!.artifactIds, expectedHeadArtifactIds) ||
        !sameStringSet(head!.evidenceIds, expectedHeadEvidenceIds) ||
        !sameStringSet(successfulAttempt.artifactIds, newHeadArtifactIds) ||
        !sameStringSet(successfulAttempt.evidenceIds, newHeadEvidenceIds)
      ) {
        rejectAggregate("Successful attempt outputs must exactly match the new head inventory", {
          runId,
          attemptId: successfulAttempt.id,
          headRevisionId: head!.id,
          attemptArtifactIds: successfulAttempt.artifactIds,
          headArtifactIds: newHeadArtifactIds,
          attemptEvidenceIds: successfulAttempt.evidenceIds,
          headEvidenceIds: newHeadEvidenceIds
        });
      }
    }
    if (
      succeeded.length === 0 &&
      nextRun.headRevisionId !== previousRun.headRevisionId &&
      nextRun.headRevisionId !== undefined &&
      !Object.hasOwn(previous.revisions, nextRun.headRevisionId)
    ) {
      assertGeneratedBringupHead(
        previousRun,
        nextRun,
        previous,
        next,
        next.revisions[nextRun.headRevisionId]!
      );
    }
  }
  for (const [runId, nextRun] of Object.entries(next.runs)) {
    if (!Object.hasOwn(previous.runs, runId)) assertInitialDesignRunState(nextRun);
  }

  for (const [revisionId, previousRevision] of Object.entries(previous.revisions)) {
    if (!Object.hasOwn(next.revisions, revisionId)) {
      rejectAggregate("Revision history is append-only", { revisionId });
    }
    if (!sameJson(previousRevision, next.revisions[revisionId])) {
      rejectAggregate("Committed revision records are immutable", { revisionId });
    }
  }
  for (const [revisionId, revision] of Object.entries(next.revisions)) {
    if (!Object.hasOwn(previous.revisions, revisionId)) {
      const run = ownRecord(next.runs, revision.runId);
      if (run?.headRevisionId !== revisionId) {
        rejectAggregate("A new revision must become its owning run head atomically", {
          revisionId,
          runId: revision.runId
        });
      }
    }
  }

  for (const [artifactId, previousArtifact] of Object.entries(previous.artifacts)) {
    if (!Object.hasOwn(next.artifacts, artifactId)) {
      rejectAggregate("Artifact history is append-only", { artifactId });
    }
    assertStaleOnlyRecordTransition("artifact", previousArtifact, next.artifacts[artifactId]!);
  }
  for (const [evidenceId, previousEvidence] of Object.entries(previous.evidence)) {
    if (!Object.hasOwn(next.evidence, evidenceId)) {
      rejectAggregate("Evidence history is append-only", { evidenceId });
    }
    assertStaleOnlyRecordTransition("evidence", previousEvidence, next.evidence[evidenceId]!);
  }

  for (const [approvalId, previousApproval] of Object.entries(previous.approvals)) {
    if (!Object.hasOwn(next.approvals, approvalId)) {
      rejectAggregate("Approval history is append-only", { approvalId });
    }
    const nextApproval = next.approvals[approvalId]!;
    if (sameJson(previousApproval, nextApproval)) continue;
    const { revokedAt: previousRevokedAt, ...previousCore } = previousApproval;
    const { revokedAt: nextRevokedAt, ...nextCore } = nextApproval;
    if (
      previousRevokedAt !== undefined ||
      nextRevokedAt === undefined ||
      !sameJson(previousCore, nextCore)
    ) {
      rejectAggregate("Approvals are immutable except for one-way revocation", {
        approvalId,
        previousRevokedAt,
        nextRevokedAt
      });
    }
  }

  for (const [invocationId, previousInvocation] of Object.entries(previous.invocations)) {
    if (!Object.hasOwn(next.invocations, invocationId)) {
      rejectAggregate("Tool-invocation history is append-only", { invocationId });
    }
    assertToolInvocationRecordTransition(previousInvocation, next.invocations[invocationId]!);
  }
  for (const [invocationId, invocation] of Object.entries(next.invocations)) {
    if (!Object.hasOwn(previous.invocations, invocationId)) {
      assertNewToolInvocationRecord(invocation);
      const nextRun = ownRecord(next.runs, invocation.runId);
      const nextAttempt = nextRun === undefined
        ? undefined
        : attemptsFor(nextRun, invocation.stage).find(
            (attempt) => attempt.id === invocation.attemptId
          );
      const previousRun = ownRecord(previous.runs, invocation.runId);
      const previousAttempt = previousRun === undefined
        ? undefined
        : attemptsFor(previousRun, invocation.stage).find(
            (attempt) => attempt.id === invocation.attemptId
          );
      if (
        nextAttempt?.state !== "running" ||
        (previousAttempt !== undefined && previousAttempt.state !== "running")
      ) {
        rejectAggregate("A new unknown invocation may be inserted only for a running attempt", {
          invocationId,
          attemptId: invocation.attemptId,
          previousAttemptState: previousAttempt?.state,
          nextAttemptState: nextAttempt?.state
        });
      }
    }
  }
};

/** Compatibility export for run-only callers; prefer the full workflow validator. */
export const assertDesignRunRecordTransitions = (
  previous: Readonly<Record<string, DesignRun>>,
  next: Readonly<Record<string, DesignRun>>
): void => {
  for (const [runId, previousRun] of Object.entries(previous)) {
    if (!Object.hasOwn(next, runId)) rejectAggregate("Run history is append-only", { runId });
    assertDesignRunTransition(previousRun, next[runId]!);
  }
  for (const [runId, nextRun] of Object.entries(next)) {
    if (!Object.hasOwn(previous, runId)) assertInitialDesignRunState(nextRun);
  }
};
