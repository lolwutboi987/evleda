import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import {
  completeToolInvocationRecord,
  MAX_INVOCATION_STREAM_BYTES,
  portableReceiptInvocationIdentityV1,
  projectToolInvocationRecordV4ToLegacyV2,
  TOOL_INVOCATION_RECORD_SCHEMA_VERSION,
  toolInvocationIdentityV1,
  toolInvocationIdentityV2,
  toolInvocationRecordSchema
} from "../../src/domain/invocation-ledger.js";
import {
  buildNativeProcessPlanV2,
  createApprovedNativeProcessContractRegistryV2,
  projectNativeProcessPlanV2ToLegacyV1
} from "../../src/domain/native-process-plan.js";
import {
  APPROVED_PORTABLE_KICAD_RUNTIME_CONTRACT_VALIDATOR_V2,
  buildPortableKicadCommandPlanV1,
  buildPortableKicadNativeProcessPlanV2
} from "../../src/integrations/portable-kicad-runtime.js";
import {
  GENERATED_BRINGUP_PLAN_CONTRACT,
  generatedBringupPlan
} from "../../src/domain/candidate-generation-contract.js";
import {
  RUN_STATES,
  RUN_STATE_TRANSITIONS,
  STAGE_ATTEMPT_STATES,
  STAGE_ATTEMPT_STATE_TRANSITIONS,
  assertDesignRunRecordTransitions,
  assertDesignRunTransition,
  assertRunStateTransition,
  assertStageAttemptStateTransition,
  assertWorkflowStateSnapshot as assertWorkflowStateSnapshotBase,
  assertWorkflowStateTransitions as assertWorkflowStateTransitionsBase,
  canTransitionRunState,
  canTransitionStageAttemptState
} from "../../src/domain/state-transitions.js";
import { STAGE_ORDER, type StageKey } from "../../src/domain/stages.js";
import type {
  CanonicalIdentity,
  ApprovalRecord,
  ArtifactRecord,
  DesignRevision,
  DesignRun,
  EvidenceRecord,
  LegacyToolInvocationRecordV2,
  RequirementsDocument,
  RunState,
  StageAttempt,
  StageAttemptState,
  ToolInvocationRecord
} from "../../src/domain/types.js";
import {
  AtomicStateStore,
  EVLEDA_STATE_SCHEMA_VERSION,
  LEGACY_EVLEDA_STATE_SCHEMA_VERSION,
  LEGACY_EVLEDA_STATE_V2_SCHEMA_VERSION,
  LEGACY_EVLEDA_STATE_V3_SCHEMA_VERSION,
  type EvlEdaState
} from "../../src/persistence/state-store.js";

const TEST_TEMP_ROOT = path.join(tmpdir(), "evleda-state-transition-tests");
const temporaryRoots: string[] = [];

const identity: CanonicalIdentity = {
  algorithm: "sha256",
  digest: "0".repeat(64),
  schemaVersion: "evleda.test.v1",
  canonicalizationVersion: "evleda-c14n-json-v1"
};

const SOURCE_PROMPT = { algorithm: "sha256", digest: "1".repeat(64), size: 1 } as const;
const APPROVAL_ID = "approval_requirements";
const REVISION_ID = "revision_requirements";
const REQUIREMENTS_ARTIFACT_ID = "artifact_requirements";
const REVISION_MANIFEST: CanonicalIdentity = {
  ...identity,
  digest: "7".repeat(64),
  schemaVersion: "evleda.design-revision.v1"
};
const APPROVED_NATIVE_PROCESS_CONTRACTS = createApprovedNativeProcessContractRegistryV2([
  APPROVED_PORTABLE_KICAD_RUNTIME_CONTRACT_VALIDATOR_V2
]);
const assertWorkflowStateSnapshot = (
  state: Parameters<typeof assertWorkflowStateSnapshotBase>[0]
): void => assertWorkflowStateSnapshotBase(state, {
  approvedNativeProcessContracts: APPROVED_NATIVE_PROCESS_CONTRACTS
});
const assertWorkflowStateTransitions = (
  previous: Parameters<typeof assertWorkflowStateTransitionsBase>[0],
  next: Parameters<typeof assertWorkflowStateTransitionsBase>[1]
): void => assertWorkflowStateTransitionsBase(previous, next, {
  approvedNativeProcessContracts: APPROVED_NATIVE_PROCESS_CONTRACTS
});

const invocationCommandPlan = () => {
  const tool = {
    schemaVersion: "evleda.tool-content-identity.v1" as const,
    role: "native_validator" as const,
    kind: "native_executable" as const,
    name: "kicad-cli",
    version: "10.0.0",
    commit: "1".repeat(40),
    contentIdentity: { algorithm: "sha256" as const, digest: "9".repeat(64), size: 1024 },
    capabilitiesIdentity: { algorithm: "sha256" as const, digest: "c".repeat(64), size: 128 },
    helpIdentity: { algorithm: "sha256" as const, digest: "d".repeat(64), size: 256 }
  };
  const commandPlan = buildPortableKicadCommandPlanV1({
    commandKind: "kicad_netlist",
    tool,
    logicalCwd: {
      schemaVersion: "evleda.portable-path-ref.v1",
      root: "run_input",
      relativePath: "snapshots/kicad_netlist"
    },
    sourcePath: {
      schemaVersion: "evleda.portable-path-ref.v1",
      root: "run_input",
      relativePath: "snapshots/kicad_netlist/controller.kicad_sch"
    },
    outputPath: {
      schemaVersion: "evleda.portable-path-ref.v1",
      root: "run_private",
      relativePath: "captures/kicad_netlist/controller.kicad_net"
    }
  });
  return buildPortableKicadNativeProcessPlanV2({
    commandKind: "kicad_netlist",
    commandPlan
  });
};

const requirementsDocument = (approved: boolean): RequirementsDocument => ({
  schemaVersion: "evleda.requirements.v1",
  identity: { ...identity, digest: "2".repeat(64), schemaVersion: "evleda.requirements.v1" },
  sourcePrompt: SOURCE_PROMPT,
  requirements: [],
  constraints: {},
  exclusions: [],
  unresolvedAssumptions: [],
  ...(approved ? { approvalId: APPROVAL_ID } : {})
});

const blocker = (stage: StageKey) => ({
  code: "TEST_BLOCKER",
  message: "Test blocker.",
  stage,
  affectedInputDigests: [identity.digest],
  requiredAction: "Resolve the test blocker.",
  retryable: true,
  createdAt: "2026-09-03T00:00:01.000Z"
});

const emptyAttempts = (): Record<StageKey, readonly StageAttempt[]> =>
  Object.fromEntries(STAGE_ORDER.map((stage) => [stage, []])) as unknown as Record<
    StageKey,
    readonly StageAttempt[]
  >;

const attempt = (
  stage: StageKey,
  state: StageAttemptState,
  attemptNumber = 1,
  fencingEpoch = attemptNumber
): StageAttempt => {
  const succeeded = state === "succeeded";
  const failed = state === "blocked" || state === "interrupted";
  const ordinary = stage !== "requirements";
  return {
    id: `attempt_${stage}_${attemptNumber}`,
    stage,
    attemptNumber,
    state,
    inputManifest: identity,
    ...(ordinary && state !== "pending"
      ? {
          provisionIdentity: { ...identity, digest: "3".repeat(64), schemaVersion: "evleda.stage-provision.v1" },
          provisionManifestBlob: { algorithm: "sha256", digest: "4".repeat(64), size: 1 },
          executionFence: {
            inputManifest: identity,
            parentRevisionId: REVISION_ID,
            parentRevisionManifest: identity,
            projectHeadRevisionId: REVISION_ID,
            requirementsApprovalId: APPROVAL_ID,
            requirementsApprovalDigest: requirementsDocument(true).identity.digest
          }
        }
      : {}),
    ...(succeeded
      ? { outputIdentity: { ...identity, digest: "5".repeat(64) } }
      : {}),
    artifactIds: succeeded
      ? [stage === "requirements" ? REQUIREMENTS_ARTIFACT_ID : `artifact_${stage}_${attemptNumber}`]
      : [],
    evidenceIds: [],
    blockers: failed ? [blocker(stage)] : [],
    ...(state === "pending" ? {} : { startedAt: "2026-09-03T00:00:00.000Z" }),
    ...(failed || succeeded ? { completedAt: "2026-09-03T00:00:01.000Z" } : {}),
    fencingEpoch
  };
};

const run = (
  state: RunState = "waiting_requirements_approval",
  requirementState: StageAttemptState = "waiting_approval"
): DesignRun => {
  const attempts = emptyAttempts();
  attempts.requirements = [attempt("requirements", requirementState)];
  return {
    id: "run_transition_fixture",
    projectId: "project_transition_fixture",
    sourcePrompt: SOURCE_PROMPT,
    workflowVersion: "evleda.workflow.v1",
    configuration: identity,
    state,
    lifecycle: "candidate",
    requirements: requirementsDocument(requirementState === "succeeded"),
    attempts,
    ...(requirementState === "succeeded" ? { headRevisionId: REVISION_ID } : {}),
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: requirementState === "succeeded"
      ? "2026-09-03T00:00:01.000Z"
      : "2026-09-03T00:00:00.000Z",
    revision: requirementState === "succeeded" ? 1 : 0
  };
};

const replaceStageAttempts = (
  source: DesignRun,
  stage: StageKey,
  stageAttempts: readonly StageAttempt[],
  state: RunState = source.state
): DesignRun => ({
  ...source,
  state,
  attempts: { ...source.attempts, [stage]: stageAttempts },
  updatedAt: "2026-09-03T00:00:01.000Z",
  revision: source.revision + 1
});

const approvalRecord = (source: DesignRun): ApprovalRecord => ({
  id: APPROVAL_ID,
  kind: "requirements",
  projectId: source.projectId,
  runId: source.id,
  subjectDigest: requirementsDocument(true).identity.digest,
  policyVersion: "evleda.policy.v1",
  actor: {
    type: "human",
    id: "reviewer",
    displayName: "Reviewer",
    role: "requirements_reviewer"
  },
  scope: "exact requirements",
  rationale: "Test approval.",
  createdAt: "2026-09-03T00:00:01.000Z"
});

const emptyProject = () => ({
  id: "project_transition_fixture",
  name: "Transition fixture",
  root: "transition-fixture",
  policyVersion: "evleda.policy.v1",
  runIds: [] as readonly string[],
  createdAt: "2026-09-03T00:00:00.000Z",
  updatedAt: "2026-09-03T00:00:00.000Z",
  revision: 0
});

const owningProject = (source: DesignRun) => ({
  ...emptyProject(),
  runIds: [source.id],
  ...(source.headRevisionId === undefined ? {} : { headRevisionId: source.headRevisionId }),
  updatedAt: source.updatedAt,
  revision: source.requirements?.approvalId === undefined ? 1 : 2
});

const artifactRecord = (
  source: DesignRun,
  id: string,
  stage: StageKey
): ArtifactRecord => ({
  id,
  projectId: source.projectId,
  runId: source.id,
  designRevisionId: REVISION_ID,
  stage,
  logicalName: `${id}.json`,
  mediaType: "application/json",
  blob: { algorithm: "sha256", digest: "6".repeat(64), size: 1 },
  exactInputs: [identity],
  derivedFrom: [],
  tool: { name: "test", version: "1", adapter: "evleda" },
  validationStatus: "pass",
  unresolvedAssumptions: [],
  lifecycle: "candidate",
  createdAt: "2026-09-03T00:00:01.000Z"
});

const workflowRecords = (source: DesignRun) => {
  const outputArtifacts = Object.values(source.attempts)
    .flatMap((attempts) => attempts)
    .flatMap((entry) => entry.artifactIds.map((id) => artifactRecord(source, id, entry.stage)));
  const artifacts = Object.fromEntries(outputArtifacts.map((artifact) => [artifact.id, artifact]));
  const approved = source.requirements?.approvalId !== undefined;
  const revision: DesignRevision = {
    id: REVISION_ID,
    projectId: source.projectId,
    runId: source.id,
    ordinal: 1,
    parentRevisionIds: [],
    manifest: REVISION_MANIFEST,
    artifactIds: Object.keys(artifacts),
    evidenceIds: [],
    lifecycle: "candidate",
    createdAt: "2026-09-03T00:00:01.000Z"
  };
  return {
    projects: { [source.projectId]: owningProject(source) },
    runs: { [source.id]: source },
    revisions: approved ? { [REVISION_ID]: revision } : {},
    artifacts,
    evidence: {},
    approvals: approved ? { [APPROVAL_ID]: approvalRecord(source) } : {},
    invocations: {}
  };
};

const stateWithRun = (source: DesignRun, revision = 0): EvlEdaState => ({
  schemaVersion: EVLEDA_STATE_SCHEMA_VERSION,
  revision,
  ...workflowRecords(source),
  idempotency: {},
  auditOutbox: {}
});

const runningSystemArchitectureRun = (): DesignRun => {
  const source = run("queued", "succeeded");
  const processPlan = invocationCommandPlan();
  const legacyProcessPlan = projectNativeProcessPlanV2ToLegacyV1(processPlan);
  const inputManifest: CanonicalIdentity = {
    ...identity,
    digest: "8".repeat(64),
    schemaVersion: "evleda.stage-input.system_architecture.v1"
  };
  const runningAttempt = {
    ...attempt("system_architecture", "running"),
    inputManifest,
    executionFence: {
      inputManifest,
      parentRevisionId: REVISION_ID,
      parentRevisionManifest: REVISION_MANIFEST,
      projectHeadRevisionId: REVISION_ID,
      requirementsApprovalId: APPROVAL_ID,
      requirementsApprovalDigest: source.requirements!.identity.digest,
      nativeProcessPlanBindings: [{
        schemaVersion: "evleda.native-process-plan-binding.v3" as const,
        profileDomain: processPlan.profile.domain,
        operation: processPlan.profile.operation,
        contractIdentity: processPlan.profile.contractIdentity,
        planIdentity: processPlan.planIdentity,
        portableReceiptPlanIdentityV1: legacyProcessPlan.planIdentity
      }]
    }
  };
  return {
    ...source,
    state: "running",
    attempts: { ...source.attempts, system_architecture: [runningAttempt] },
    updatedAt: "2026-09-03T00:00:02.000Z",
    revision: source.revision + 1
  };
};

const invocationRecord = (
  source: DesignRun,
  overrides: Partial<ToolInvocationRecord> = {}
): ToolInvocationRecord => {
  const owningAttempt = source.attempts.system_architecture[0]!;
  const commandPlan = invocationCommandPlan();
  const toolContentIdentity = commandPlan.tool.contentIdentity;
  return {
    schemaVersion: TOOL_INVOCATION_RECORD_SCHEMA_VERSION,
    transport: "native_process",
    id: "invocation_system_architecture_1",
    projectId: source.projectId,
    runId: source.id,
    attemptId: owningAttempt.id,
    stage: "system_architecture",
    fencingEpoch: owningAttempt.fencingEpoch,
    inputManifest: owningAttempt.inputManifest,
    executionFence: owningAttempt.executionFence!,
    toolContentIdentity,
    commandPlan,
    commandPlanIdentity: commandPlan.planIdentity,
    stdoutIdentity: null,
    stderrIdentity: null,
    exitCode: null,
    outcome: "unknown",
    startedAt: "2026-09-03T00:00:01.500Z",
    completedAt: null,
    invocationIdentity: null,
    portableReceiptInvocationIdentityV1: null,
    portableReceiptInvocationIdentityDisposition: "compatibility_projection_only",
    ...overrides
  };
};

const persistInitialRun = async (store: AtomicStateStore): Promise<void> => {
  const initial = run();
  await store.transaction(0, (state) => {
    state.projects[initial.projectId] = emptyProject();
  });
  await store.transaction(1, (state) => {
    state.projects[initial.projectId] = owningProject(initial);
    state.runs[initial.id] = initial;
  });
};

const EXPECTED_RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  queued: ["queued", "running", "completed"],
  running: ["running", "queued", "blocked", "completed"],
  waiting_requirements_approval: ["waiting_requirements_approval", "queued"],
  blocked: ["blocked", "queued", "running"],
  interrupted: ["interrupted", "queued", "running"],
  completed: ["completed", "queued"],
  cancelled: ["cancelled"]
};

const EXPECTED_ATTEMPT_TRANSITIONS: Readonly<
  Record<StageAttemptState, readonly StageAttemptState[]>
> = {
  pending: ["pending"],
  running: ["running", "blocked", "interrupted", "succeeded", "stale"],
  waiting_approval: ["waiting_approval", "succeeded"],
  blocked: ["blocked", "stale"],
  interrupted: ["interrupted", "stale"],
  succeeded: ["succeeded", "stale"],
  stale: ["stale"]
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("complete durable state-transition tables", () => {
  it("enumerates every declared state exactly once and freezes the public tables", () => {
    expect(RUN_STATES).toEqual(Object.keys(EXPECTED_RUN_TRANSITIONS));
    expect(STAGE_ATTEMPT_STATES).toEqual(Object.keys(EXPECTED_ATTEMPT_TRANSITIONS));
    expect(Object.isFrozen(RUN_STATE_TRANSITIONS)).toBe(true);
    expect(Object.values(RUN_STATE_TRANSITIONS).every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(STAGE_ATTEMPT_STATE_TRANSITIONS)).toBe(true);
    expect(Object.values(STAGE_ATTEMPT_STATE_TRANSITIONS).every(Object.isFrozen)).toBe(true);
  });

  it.each(
    RUN_STATES.flatMap((from) => RUN_STATES.map((to) => [from, to] as const))
  )("classifies run transition %s -> %s", (from, to) => {
    const expected = EXPECTED_RUN_TRANSITIONS[from].includes(to);
    expect(canTransitionRunState(from, to)).toBe(expected);
    if (expected) {
      expect(() => assertRunStateTransition(from, to, "run_table")).not.toThrow();
    } else {
      expect(() => assertRunStateTransition(from, to, "run_table")).toThrowError(
        expect.objectContaining({
          code: "REVISION_CONFLICT",
          details: { entity: "run", id: "run_table", from, to }
        })
      );
    }
  });

  it.each(
    STAGE_ATTEMPT_STATES.flatMap((from) =>
      STAGE_ATTEMPT_STATES.map((to) => [from, to] as const)
    )
  )("classifies stage-attempt transition %s -> %s", (from, to) => {
    const expected = EXPECTED_ATTEMPT_TRANSITIONS[from].includes(to);
    expect(canTransitionStageAttemptState(from, to)).toBe(expected);
    if (expected) {
      expect(() =>
        assertStageAttemptStateTransition(from, to, "attempt_table", "system_architecture")
      ).not.toThrow();
    } else {
      expect(() =>
        assertStageAttemptStateTransition(from, to, "attempt_table", "system_architecture")
      ).toThrowError(
        expect.objectContaining({
          code: "REVISION_CONFLICT",
          details: {
            entity: "stage_attempt",
            id: "attempt_table",
            from,
            to,
            stage: "system_architecture"
          }
        })
      );
    }
  });

  it("keeps stale attempts and cancelled runs absorbing", () => {
    expect(STAGE_ATTEMPT_STATE_TRANSITIONS.stale).toEqual(["stale"]);
    expect(RUN_STATE_TRANSITIONS.cancelled).toEqual(["cancelled"]);
  });
});

describe("durable tool-invocation ledger foundation", () => {
  const terminalRecord = (
    pending: ToolInvocationRecord,
    outcome: "succeeded" | "failed" | "timed_out" | "cancelled" | "error",
    exitCode: number | null,
    completedAt = "2026-09-03T00:00:01.750Z"
  ): ToolInvocationRecord => completeToolInvocationRecord(pending, {
    outcome,
    exitCode,
    stdoutIdentity: contentIdentity("stdout"),
    stderrIdentity: contentIdentity("stderr"),
    completedAt
  });

  it("accepts only the closed record-v4 envelope and exact outcome/time/exit matrix", () => {
    const source = runningSystemArchitectureRun();
    const pending = invocationRecord(source);
    expect(toolInvocationRecordSchema.safeParse(pending).success).toBe(true);
    expect(toolInvocationRecordSchema.safeParse(terminalRecord(pending, "succeeded", 0)).success)
      .toBe(true);
    expect(toolInvocationRecordSchema.safeParse(terminalRecord(pending, "failed", 5)).success)
      .toBe(true);
    expect(toolInvocationRecordSchema.safeParse(terminalRecord(pending, "timed_out", null)).success)
      .toBe(true);
    expect(() => terminalRecord(pending, "succeeded", 99)).toThrowError(/accepted exit code/iu);
    const { planIdentity: _smallPlanIdentity, ...smallPlanDraft } = pending.commandPlan;
    const smallPlan = buildNativeProcessPlanV2({ ...smallPlanDraft, maxStdoutBytes: 1 });
    expect(() => terminalRecord({
      ...pending,
      commandPlan: smallPlan,
      commandPlanIdentity: smallPlan.planIdentity
    }, "succeeded", 0)).toThrowError(/stdout exceeds/iu);

    const success = terminalRecord(pending, "succeeded", 0);
    const { planIdentity: _planIdentity, ...planPreimage } = pending.commandPlan;
    const hostileExitPreimage = { ...planPreimage, acceptedExitCodes: [0, 99] };
    const hostileExitPlan = {
      ...hostileExitPreimage,
      planIdentity: canonicalIdentity(hostileExitPreimage, "evleda.native-process-plan.v2")
    };
    for (const invalid of [
      { ...pending, completedAt: "2026-09-03T00:00:01.750Z" },
      { ...success, exitCode: null },
      { ...terminalRecord(pending, "failed", 5), exitCode: 0 },
      { ...terminalRecord(pending, "failed", 5), exitCode: -1 },
      { ...terminalRecord(pending, "cancelled", null), exitCode: 1 },
      { ...pending, commandPlanIdentity: { ...pending.commandPlanIdentity, schemaVersion: "wrong" } },
      { ...pending, schemaVersion: "evleda.tool-invocation-record.v2" },
      { ...pending, schemaVersion: "evleda.tool-invocation-record.v3" },
      {
        ...pending,
        commandPlan: {
          ...pending.commandPlan,
          schemaVersion: "evleda.native-process-plan.v1",
          planIdentity: {
            ...pending.commandPlan.planIdentity,
            schemaVersion: "evleda.native-process-plan.v1"
          }
        }
      },
      { ...pending, commandPlanIdentity: { ...pending.commandPlanIdentity, digest: "f".repeat(64) } },
      {
        ...pending,
        commandPlan: hostileExitPlan,
        commandPlanIdentity: hostileExitPlan.planIdentity
      },
      {
        ...pending,
        commandPlan: {
          ...pending.commandPlan,
          command: {
            ...pending.commandPlan.command,
            value: {
              ...pending.commandPlan.command.value,
              argv: [{ kind: "literal", value: "tampered" }]
            }
          }
        }
      },
      { ...pending, toolContentIdentity: { ...pending.toolContentIdentity, digest: "b".repeat(64) } },
      { ...pending, transport: "human_rpc" },
      { ...pending, startedAt: "2026-09-03T00:00:01.5001Z" },
      {
        ...terminalRecord(pending, "error", null),
        stdoutIdentity: { ...contentIdentity(""), size: MAX_INVOCATION_STREAM_BYTES + 1 }
      },
      {
        ...terminalRecord(pending, "error", null),
        stderrIdentity: { ...contentIdentity(""), size: MAX_INVOCATION_STREAM_BYTES + 1 }
      },
      {
        ...success,
        completedAt: "2026-09-03T00:00:01.000Z"
      },
      { ...pending, unexpected: true }
    ]) {
      expect(toolInvocationRecordSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("separates authoritative V2 identity from the stable Phase-1 V1 projection", () => {
    const source = runningSystemArchitectureRun();
    const pending = invocationRecord(source);
    const terminal = terminalRecord(pending, "succeeded", 0);
    const terminalAgain = terminalRecord(pending, "succeeded", 0);
    const projected = projectToolInvocationRecordV4ToLegacyV2(terminal);

    expect(projected.schemaVersion).toBe("evleda.tool-invocation-record.v2");
    expect(projected.commandPlan.schemaVersion).toBe("evleda.native-process-plan.v1");
    expect(toolInvocationIdentityV1(projected)).toEqual(
      terminal.portableReceiptInvocationIdentityV1
    );
    expect(toolInvocationIdentityV2(terminal)).toEqual(terminal.invocationIdentity);
    expect(terminalAgain.invocationIdentity).toEqual(terminal.invocationIdentity);
    expect(terminalAgain.portableReceiptInvocationIdentityV1).toEqual(
      terminal.portableReceiptInvocationIdentityV1
    );
    expect(toolInvocationRecordSchema.safeParse({
      ...terminal,
      invocationIdentity: terminal.portableReceiptInvocationIdentityV1
    }).success).toBe(false);
    expect(() => toolInvocationIdentityV1(
      terminal as unknown as LegacyToolInvocationRecordV2
    )).toThrowError(/Legacy invocation identity/iu);
    expect(() => toolInvocationIdentityV2(
      projected as unknown as ToolInvocationRecord
    )).toThrowError(/Current invocation identity/iu);

    const { planIdentity: _planIdentity, ...planDraft } = pending.commandPlan;
    const changedPlan = buildNativeProcessPlanV2({
      ...planDraft,
      expectedOutputs: planDraft.expectedOutputs.map((descriptor) => ({
        ...descriptor,
        maxBytes: descriptor.maxBytes - 1
      }))
    });
    const legacyChangedPlan = projectNativeProcessPlanV2ToLegacyV1(changedPlan);
    const changedFence = {
      ...pending.executionFence,
      nativeProcessPlanBindings: pending.executionFence.nativeProcessPlanBindings!.map(
        (binding) => ({
          ...binding,
          planIdentity: changedPlan.planIdentity,
          portableReceiptPlanIdentityV1: legacyChangedPlan.planIdentity
        })
      )
    };
    const changedTerminal = terminalRecord({
      ...pending,
      executionFence: changedFence,
      commandPlan: changedPlan,
      commandPlanIdentity: changedPlan.planIdentity
    }, "succeeded", 0);
    expect(changedTerminal.invocationIdentity).not.toEqual(terminal.invocationIdentity);
    expect(changedTerminal.portableReceiptInvocationIdentityV1).toEqual(
      terminal.portableReceiptInvocationIdentityV1
    );
  });

  it("binds an invocation to the exact project, run, attempt, stage, fence, and manifest", () => {
    const source = runningSystemArchitectureRun();
    const base = stateWithRun(source);
    const invocation = invocationRecord(source);
    const valid = { ...base, invocations: { [invocation.id]: invocation } };
    expect(() => assertWorkflowStateSnapshot(valid)).not.toThrow();

    for (const invalidInvocation of [
      { ...invocation, projectId: "project_foreign" },
      { ...invocation, runId: "run_foreign" },
      { ...invocation, attemptId: "attempt_foreign" },
      { ...invocation, fencingEpoch: 2 },
      {
        ...invocation,
        executionFence: { ...invocation.executionFence, parentRevisionId: "revision_foreign" }
      },
      {
        ...invocation,
        executionFence: {
          ...invocation.executionFence,
          parentRevisionManifest: {
            ...invocation.executionFence.parentRevisionManifest,
            digest: "f".repeat(64)
          }
        }
      },
      {
        ...invocation,
        executionFence: {
          ...invocation.executionFence,
          projectHeadRevisionId: "revision_foreign"
        }
      },
      {
        ...invocation,
        executionFence: {
          ...invocation.executionFence,
          requirementsApprovalDigest: "f".repeat(64)
        }
      },
      {
        ...invocation,
        inputManifest: { ...invocation.inputManifest, schemaVersion: "evleda.stage-input.firmware.v1" },
        executionFence: {
          ...invocation.executionFence,
          inputManifest: { ...invocation.inputManifest, schemaVersion: "evleda.stage-input.firmware.v1" }
        }
      },
      { ...invocation, startedAt: "2026-09-02T23:59:59.000Z" }
    ] as ToolInvocationRecord[]) {
      expect(() => assertWorkflowStateSnapshot({
        ...base,
        invocations: { [invalidInvocation.id]: invalidInvocation }
      })).toThrowError(/invocation|manifest|timestamps/iu);
    }

    const attempt = source.attempts.system_architecture[0]!;
    const {
      nativeProcessPlanBindings: _nativeProcessPlanBindings,
      ...unboundFence
    } = attempt.executionFence!;
    const unboundRun: DesignRun = {
      ...source,
      attempts: {
        ...source.attempts,
        system_architecture: [{ ...attempt, executionFence: unboundFence }]
      }
    };
    const unboundInvocation: ToolInvocationRecord = {
      ...invocation,
      executionFence: unboundFence
    };
    expect(() => assertWorkflowStateSnapshot({
      ...stateWithRun(unboundRun),
      invocations: { [unboundInvocation.id]: unboundInvocation }
    })).toThrowError(/not prebound by.*execution fence/iu);
  });

  it("rejects a self-consistent plan that fails its approved operation-specific command contract", () => {
    const source = runningSystemArchitectureRun();
    const pending = invocationRecord(source);
    const { planIdentity: _identity, ...planDraft } = pending.commandPlan;
    const crossedPlan = buildNativeProcessPlanV2({
      ...planDraft,
      profile: {
        schemaVersion: "evleda.native-process-profile.kicad.v1",
        domain: "kicad",
        operation: "kicad_erc",
        contractIdentity: planDraft.profile.contractIdentity
      },
      acceptedExitCodes: [0, 5]
    });
    const crossedBinding = {
      schemaVersion: "evleda.native-process-plan-binding.v3" as const,
      profileDomain: crossedPlan.profile.domain,
      operation: crossedPlan.profile.operation,
      contractIdentity: crossedPlan.profile.contractIdentity,
      planIdentity: crossedPlan.planIdentity,
      portableReceiptPlanIdentityV1:
        projectNativeProcessPlanV2ToLegacyV1(crossedPlan).planIdentity
    };
    const attempt = source.attempts.system_architecture[0]!;
    const executionFence = {
      ...attempt.executionFence!,
      nativeProcessPlanBindings: [crossedBinding]
    };
    const crossedRun: DesignRun = {
      ...source,
      attempts: {
        ...source.attempts,
        system_architecture: [{ ...attempt, executionFence }]
      }
    };
    const crossedInvocation: ToolInvocationRecord = {
      ...pending,
      executionFence,
      commandPlan: crossedPlan,
      commandPlanIdentity: crossedPlan.planIdentity
    };
    expect(() => assertWorkflowStateSnapshot({
      ...stateWithRun(crossedRun),
      invocations: { [crossedInvocation.id]: crossedInvocation }
    })).toThrowError(/approved operation-specific command contract/iu);

    const changedCeilingPlan = buildNativeProcessPlanV2({
      ...planDraft,
      expectedOutputs: planDraft.expectedOutputs.map((descriptor) => ({
        ...descriptor,
        maxBytes: descriptor.maxBytes - 1
      }))
    });
    const changedCeilingFence = {
      ...attempt.executionFence!,
      nativeProcessPlanBindings: [{
        schemaVersion: "evleda.native-process-plan-binding.v3" as const,
        profileDomain: changedCeilingPlan.profile.domain,
        operation: changedCeilingPlan.profile.operation,
        contractIdentity: changedCeilingPlan.profile.contractIdentity,
        planIdentity: changedCeilingPlan.planIdentity,
        portableReceiptPlanIdentityV1:
          projectNativeProcessPlanV2ToLegacyV1(changedCeilingPlan).planIdentity
      }]
    };
    const changedCeilingRun: DesignRun = {
      ...source,
      attempts: {
        ...source.attempts,
        system_architecture: [{ ...attempt, executionFence: changedCeilingFence }]
      }
    };
    const changedCeilingInvocation: ToolInvocationRecord = {
      ...pending,
      executionFence: changedCeilingFence,
      commandPlan: changedCeilingPlan,
      commandPlanIdentity: changedCeilingPlan.planIdentity
    };
    expect(() => assertWorkflowStateSnapshot({
      ...stateWithRun(changedCeilingRun),
      invocations: { [changedCeilingInvocation.id]: changedCeilingInvocation }
    })).toThrowError(/approved operation-specific command contract/iu);
  });

  it("rejects duplicate command plans and map-key substitution", () => {
    const source = runningSystemArchitectureRun();
    const base = stateWithRun(source);
    const first = invocationRecord(source);
    const duplicate = { ...first, id: "invocation_system_architecture_2" };
    expect(() => assertWorkflowStateSnapshot({
      ...base,
      invocations: { [first.id]: first, [duplicate.id]: duplicate }
    })).toThrowError(/same typed command plan/iu);
    expect(() => assertWorkflowStateSnapshot({
      ...base,
      invocations: { wrong_key: first }
    })).toThrowError(/map key/iu);
  });

  it("requires durable unknown creation and permits exactly one terminal mutation", () => {
    const source = runningSystemArchitectureRun();
    const base = stateWithRun(source);
    const pending = invocationRecord(source);
    const appended = { ...base, invocations: { [pending.id]: pending } };
    expect(() => assertWorkflowStateTransitions(base, appended)).not.toThrow();

    const terminal = terminalRecord(pending, "succeeded", 0);
    const completed = { ...appended, invocations: { [terminal.id]: terminal } };
    expect(() => assertWorkflowStateTransitions(appended, completed)).not.toThrow();

    expect(() => assertWorkflowStateTransitions(base, completed)).toThrowError(
      /appended before execution with unknown outcome/iu
    );
    const failedTerminal = terminalRecord(pending, "failed", 5);
    expect(() => assertWorkflowStateTransitions(completed, {
      ...completed,
      invocations: {
        [terminal.id]: failedTerminal
      }
    })).toThrowError(/exactly one unknown-to-terminal/iu);
    const shiftedPending = { ...pending, startedAt: "2026-09-03T00:00:01.600Z" };
    const shiftedTerminal = terminalRecord(shiftedPending, "succeeded", 0);
    expect(() => assertWorkflowStateTransitions(appended, {
      ...completed,
      invocations: {
        [terminal.id]: shiftedTerminal
      }
    })).toThrowError(/binding changed/iu);
    expect(() => assertWorkflowStateTransitions(appended, {
      ...appended,
      invocations: {}
    })).toThrowError(/append-only/iu);
  });

  it("round-trips a nonempty ledger across restart and preserves its final identity", async () => {
    await mkdir(TEST_TEMP_ROOT, { recursive: true });
    const root = await mkdtemp(path.join(TEST_TEMP_ROOT, "evleda-invocation-restart-"));
    temporaryRoots.push(root);
    const source = runningSystemArchitectureRun();
    const pending = invocationRecord(source);
    const initial = {
      ...stateWithRun(source),
      invocations: { [pending.id]: pending }
    };
    await writeFile(path.join(root, "state.json"), `${JSON.stringify(initial)}\n`, "utf8");

    await expect(new AtomicStateStore(root).read()).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR",
      message: expect.stringContaining("approved command-contract registry")
    });

    const first = new AtomicStateStore(root, {
      approvedNativeProcessContracts: APPROVED_NATIVE_PROCESS_CONTRACTS
    });
    expect((await first.read()).invocations[pending.id]).toEqual(pending);
    const terminal = terminalRecord(pending, "succeeded", 0);
    await first.transaction(initial.revision, (state) => {
      state.invocations[pending.id] = terminal;
    });

    const restarted = await new AtomicStateStore(root, {
      approvedNativeProcessContracts: APPROVED_NATIVE_PROCESS_CONTRACTS
    }).read();
    expect(restarted.invocations[pending.id]).toEqual(terminal);
    expect(restarted.invocations[pending.id]!.invocationIdentity).toEqual(
      terminal.invocationIdentity
    );
    expect(restarted.invocations[pending.id]!.invocationIdentity?.schemaVersion)
      .toBe("evleda.tool-invocation.v2");
    expect(restarted.invocations[pending.id]!.portableReceiptInvocationIdentityV1?.schemaVersion)
      .toBe("evleda.tool-invocation.v1");
    expect(portableReceiptInvocationIdentityV1(restarted.invocations[pending.id]!)).toEqual(
      terminal.portableReceiptInvocationIdentityV1
    );
  });

  it("preserves crash-left-unknown truth on interrupted attempts but rejects it for completed outcomes", () => {
    const source = runningSystemArchitectureRun();
    const pending = invocationRecord(source);
    const stoppedAttempt = {
      ...source.attempts.system_architecture[0]!,
      state: "interrupted" as const,
      blockers: [blocker("system_architecture")],
      completedAt: "2026-09-03T00:00:02.500Z"
    };
    const stoppedRun: DesignRun = {
      ...source,
      state: "interrupted",
      attempts: { ...source.attempts, system_architecture: [stoppedAttempt] },
      updatedAt: "2026-09-03T00:00:02.500Z",
      revision: source.revision + 1
    };
    const state = stateWithRun(stoppedRun);
    expect(() => assertWorkflowStateSnapshot({
      ...state,
      invocations: { [pending.id]: pending }
    })).not.toThrow();
    expect(() => assertWorkflowStateTransitions(state, {
      ...state,
      invocations: { [pending.id]: pending }
    })).toThrowError(/new unknown invocation.*running attempt/iu);
    const postInterruptionStart = {
      ...pending,
      startedAt: "2026-09-03T00:00:03.000Z"
    };
    expect(() => assertWorkflowStateSnapshot({
      ...state,
      invocations: { [postInterruptionStart.id]: postInterruptionStart }
    })).toThrowError(/timestamps/iu);
    const runningWithInvocation = {
      ...stateWithRun(source),
      invocations: { [pending.id]: pending }
    };
    const replacementAttempt = attempt("system_architecture", "running", 2, 2);
    const recoveredRetryRun: DesignRun = {
      ...source,
      attempts: {
        ...source.attempts,
        system_architecture: [stoppedAttempt, replacementAttempt]
      },
      updatedAt: "2026-09-03T00:00:02.500Z",
      revision: source.revision + 1
    };
    expect(() => assertWorkflowStateTransitions(runningWithInvocation, {
      ...runningWithInvocation,
      runs: { [recoveredRetryRun.id]: recoveredRetryRun }
    })).not.toThrow();
    expect(() => assertWorkflowStateTransitions(stateWithRun(source), {
      ...stateWithRun(source),
      runs: { [recoveredRetryRun.id]: recoveredRetryRun },
      invocations: { [pending.id]: pending }
    })).toThrowError(/new unknown invocation.*running attempt/iu);
    const staleAttempt = {
      ...source.attempts.system_architecture[0]!,
      state: "stale" as const
    };
    const staleRun: DesignRun = {
      ...source,
      state: "queued",
      attempts: { ...source.attempts, system_architecture: [staleAttempt] },
      updatedAt: "2026-09-03T00:00:02.500Z",
      revision: source.revision + 1
    };
    expect(() => assertWorkflowStateTransitions(runningWithInvocation, {
      ...runningWithInvocation,
      runs: { [staleRun.id]: staleRun }
    })).not.toThrow();
    const staleWithoutInvocation = stateWithRun(staleRun);
    expect(() => assertWorkflowStateTransitions(staleWithoutInvocation, {
      ...staleWithoutInvocation,
      invocations: { [pending.id]: pending }
    })).toThrowError(/new unknown invocation.*running attempt/iu);

    const blockedAttempt = { ...stoppedAttempt, state: "blocked" as const };
    const blockedRun: DesignRun = {
      ...stoppedRun,
      state: "blocked",
      attempts: { ...stoppedRun.attempts, system_architecture: [blockedAttempt] }
    };
    expect(() => assertWorkflowStateSnapshot({
      ...stateWithRun(blockedRun),
      invocations: { [pending.id]: pending }
    })).toThrowError(/crash-fenced attempt/iu);

    const lateTerminal = terminalRecord(
      pending,
      "succeeded",
      0,
      "2026-09-03T00:00:03.000Z"
    );
    expect(() => assertWorkflowStateSnapshot({
      ...state,
      invocations: { [lateTerminal.id]: lateTerminal }
    })).toThrowError(/timestamps/iu);
  });

  it("binds two consecutive successful attempts to their own revisions across restart", async () => {
    const source = runningSystemArchitectureRun();
    const pending = invocationRecord(source);
    const runningState = stateWithRun(source);
    expect(() => assertWorkflowStateSnapshot({
      ...runningState,
      invocations: { [pending.id]: terminalRecord(pending, "failed", 5) }
    })).not.toThrow();

    const artifactId = "artifact_system_architecture_1";
    const resultRevisionId = "revision_system_architecture_2";
    const succeededAttempt: StageAttempt = {
      ...source.attempts.system_architecture[0]!,
      state: "succeeded",
      outputIdentity: {
        ...identity,
        digest: "f".repeat(64),
        schemaVersion: "evleda.stage-result.system_architecture.v1"
      },
      artifactIds: [artifactId],
      resultRevisionId,
      completedAt: "2026-09-03T00:00:02.000Z"
    };
    const succeededRun: DesignRun = {
      ...source,
      state: "running",
      attempts: { ...source.attempts, system_architecture: [succeededAttempt] },
      headRevisionId: resultRevisionId,
      updatedAt: "2026-09-03T00:00:02.000Z",
      revision: source.revision + 1
    };
    const generatedArtifact: ArtifactRecord = {
      ...artifactRecord(source, artifactId, "system_architecture"),
      designRevisionId: resultRevisionId
    };
    const resultRevision: DesignRevision = {
      id: resultRevisionId,
      projectId: source.projectId,
      runId: source.id,
      createdByAttemptId: succeededAttempt.id,
      ordinal: 2,
      parentRevisionIds: [REVISION_ID],
      manifest: {
        ...identity,
        digest: "b".repeat(64),
        schemaVersion: "evleda.design-revision.v1"
      },
      artifactIds: [REQUIREMENTS_ARTIFACT_ID, artifactId],
      evidenceIds: [],
      lifecycle: "candidate",
      createdAt: "2026-09-03T00:00:02.000Z"
    };
    const projectBefore = runningState.projects[source.projectId]!;
    const stateFor = (invocation: ToolInvocationRecord): EvlEdaState => ({
      ...runningState,
      projects: {
        [source.projectId]: {
          ...projectBefore,
          headRevisionId: resultRevisionId,
          updatedAt: "2026-09-03T00:00:02.000Z",
          revision: projectBefore.revision + 1
        }
      },
      runs: { [source.id]: succeededRun },
      revisions: { ...runningState.revisions, [resultRevisionId]: resultRevision },
      artifacts: { ...runningState.artifacts, [artifactId]: generatedArtifact },
      invocations: { [invocation.id]: invocation }
    });

    const firstTerminal = terminalRecord(pending, "succeeded", 0);
    const firstState = stateFor(firstTerminal);
    expect(() => assertWorkflowStateSnapshot(firstState)).not.toThrow();
    for (const invalid of [
      terminalRecord(pending, "failed", 5),
      terminalRecord(pending, "timed_out", null),
      terminalRecord(pending, "cancelled", null),
      terminalRecord(pending, "error", null)
    ]) {
      expect(() => assertWorkflowStateSnapshot(stateFor(invalid)))
        .toThrowError(/successful.*attempt cannot own/iu);
    }

    const componentArtifactId = "artifact_component_selection_1";
    const componentRevisionId = "revision_component_selection_3";
    const componentInputManifest: CanonicalIdentity = {
      ...identity,
      digest: "3".repeat(64),
      schemaVersion: "evleda.stage-input.component_selection.v1"
    };
    const processPlan = invocationCommandPlan();
    const componentFence = {
      inputManifest: componentInputManifest,
      parentRevisionId: resultRevision.id,
      parentRevisionManifest: resultRevision.manifest,
      projectHeadRevisionId: resultRevision.id,
      requirementsApprovalId: APPROVAL_ID,
      requirementsApprovalDigest: source.requirements!.identity.digest,
      nativeProcessPlanBindings: [{
        schemaVersion: "evleda.native-process-plan-binding.v3" as const,
        profileDomain: processPlan.profile.domain,
        operation: processPlan.profile.operation,
        contractIdentity: processPlan.profile.contractIdentity,
        planIdentity: processPlan.planIdentity,
        portableReceiptPlanIdentityV1:
          projectNativeProcessPlanV2ToLegacyV1(processPlan).planIdentity
      }]
    };
    const componentAttempt: StageAttempt = {
      id: "attempt_component_selection_1",
      stage: "component_selection",
      attemptNumber: 1,
      state: "succeeded",
      inputManifest: componentInputManifest,
      provisionIdentity: {
        ...identity,
        digest: "4".repeat(64),
        schemaVersion: "evleda.stage-provision.v1"
      },
      provisionManifestBlob: { algorithm: "sha256", digest: "5".repeat(64), size: 1 },
      outputIdentity: {
        ...identity,
        digest: "6".repeat(64),
        schemaVersion: "evleda.stage-result.component_selection.v1"
      },
      resultRevisionId: componentRevisionId,
      executionFence: componentFence,
      artifactIds: [componentArtifactId],
      evidenceIds: [],
      blockers: [],
      startedAt: "2026-09-03T00:00:02.100Z",
      completedAt: "2026-09-03T00:00:02.500Z",
      fencingEpoch: 1
    };
    const componentPending: ToolInvocationRecord = {
      ...pending,
      id: "invocation_component_selection_1",
      stage: "component_selection",
      attemptId: componentAttempt.id,
      inputManifest: componentInputManifest,
      executionFence: componentFence,
      startedAt: "2026-09-03T00:00:02.200Z"
    };
    const componentTerminal = terminalRecord(componentPending, "succeeded", 0, "2026-09-03T00:00:02.300Z");
    const componentArtifact: ArtifactRecord = {
      ...artifactRecord(source, componentArtifactId, "component_selection"),
      designRevisionId: componentRevisionId,
      createdAt: "2026-09-03T00:00:02.500Z"
    };
    const componentRevision: DesignRevision = {
      id: componentRevisionId,
      projectId: source.projectId,
      runId: source.id,
      createdByAttemptId: componentAttempt.id,
      ordinal: 3,
      parentRevisionIds: [resultRevision.id],
      manifest: {
        ...identity,
        digest: "8".repeat(64),
        schemaVersion: "evleda.design-revision.v1"
      },
      artifactIds: [...resultRevision.artifactIds, componentArtifactId],
      evidenceIds: [],
      lifecycle: "candidate",
      createdAt: "2026-09-03T00:00:02.500Z"
    };
    const twiceRun: DesignRun = {
      ...succeededRun,
      attempts: {
        ...succeededRun.attempts,
        component_selection: [componentAttempt]
      },
      headRevisionId: componentRevision.id,
      updatedAt: "2026-09-03T00:00:02.500Z",
      revision: succeededRun.revision + 1
    };
    const twiceState: EvlEdaState = {
      ...firstState,
      projects: {
        [source.projectId]: {
          ...firstState.projects[source.projectId]!,
          headRevisionId: componentRevision.id,
          updatedAt: "2026-09-03T00:00:02.500Z",
          revision: firstState.projects[source.projectId]!.revision + 1
        }
      },
      runs: { [source.id]: twiceRun },
      revisions: { ...firstState.revisions, [componentRevision.id]: componentRevision },
      artifacts: { ...firstState.artifacts, [componentArtifact.id]: componentArtifact },
      invocations: {
        [firstTerminal.id]: firstTerminal,
        [componentTerminal.id]: componentTerminal
      }
    };
    expect(() => assertWorkflowStateSnapshot(twiceState)).not.toThrow();
    expect(() => assertWorkflowStateSnapshot({
      ...twiceState,
      runs: {
        [twiceRun.id]: {
          ...twiceRun,
          attempts: {
            ...twiceRun.attempts,
            system_architecture: [{
              ...succeededAttempt,
              resultRevisionId: componentRevision.id
            }]
          }
        }
      }
    })).toThrowError(/result revision|created-by-attempt/iu);

    await mkdir(TEST_TEMP_ROOT, { recursive: true });
    const root = await mkdtemp(path.join(TEST_TEMP_ROOT, "evleda-two-stage-invocation-restart-"));
    temporaryRoots.push(root);
    await writeFile(path.join(root, "state.json"), `${JSON.stringify(twiceState)}\n`, "utf8");
    const restarted = await new AtomicStateStore(root, {
      approvedNativeProcessContracts: APPROVED_NATIVE_PROCESS_CONTRACTS
    }).read();
    expect(restarted.runs[source.id]!.headRevisionId).toBe(componentRevision.id);
    expect(restarted.invocations[firstTerminal.id]).toEqual(firstTerminal);
    expect(restarted.invocations[componentTerminal.id]).toEqual(componentTerminal);
  });

  it("migrates v1/v2/v3 empty ledgers without changing stored revision or evidence identities", async () => {
    await mkdir(TEST_TEMP_ROOT, { recursive: true });
    const source = run("queued", "succeeded");
    const evidenceId = "evidence_legacy_identity";
    const evidence: EvidenceRecord = {
      id: evidenceId,
      projectId: source.projectId,
      runId: source.id,
      designRevisionId: REVISION_ID,
      stage: "requirements",
      evidenceClass: "evleda_check",
      claim: "Legacy identity preservation fixture.",
      subjectDigests: [source.requirements!.identity.digest],
      exactInputs: [source.requirements!.identity],
      tool: { name: "evleda", version: "0.1.0", adapter: "evleda" },
      validationStatus: "pass",
      unresolvedAssumptions: [],
      lifecycle: "candidate",
      createdAt: "2026-09-03T00:00:01.000Z"
    };
    const requirementAttempt = {
      ...source.attempts.requirements[0]!,
      evidenceIds: [evidenceId]
    };
    const sourceWithEvidence: DesignRun = {
      ...source,
      attempts: { ...source.attempts, requirements: [requirementAttempt] }
    };
    const current = stateWithRun(sourceWithEvidence);
    const revision = {
      ...current.revisions[REVISION_ID]!,
      evidenceIds: [evidenceId]
    };
    const legacy = {
      ...current,
      schemaVersion: LEGACY_EVLEDA_STATE_SCHEMA_VERSION,
      revisions: { [revision.id]: revision },
      evidence: { [evidence.id]: evidence },
      invocations: {}
    };
    const root = await mkdtemp(path.join(TEST_TEMP_ROOT, "evleda-state-v1-ledger-migration-"));
    temporaryRoots.push(root);
    const stateFile = path.join(root, "state.json");
    await writeFile(stateFile, `${JSON.stringify(legacy)}\n`, "utf8");

    const store = new AtomicStateStore(root);
    const migrated = await store.read();
    expect(migrated.schemaVersion).toBe(EVLEDA_STATE_SCHEMA_VERSION);
    expect(migrated.revisions[REVISION_ID]).toEqual(revision);
    expect(migrated.evidence[evidenceId]).toEqual(evidence);
    expect(JSON.parse(await readFile(stateFile, "utf8")).schemaVersion)
      .toBe(LEGACY_EVLEDA_STATE_SCHEMA_VERSION);

    await store.transaction(migrated.revision, () => undefined);
    expect(JSON.parse(await readFile(stateFile, "utf8")).schemaVersion)
      .toBe(EVLEDA_STATE_SCHEMA_VERSION);

    const v2Root = await mkdtemp(path.join(TEST_TEMP_ROOT, "evleda-state-v2-ledger-migration-"));
    temporaryRoots.push(v2Root);
    await writeFile(path.join(v2Root, "state.json"), `${JSON.stringify({
      ...legacy,
      schemaVersion: LEGACY_EVLEDA_STATE_V2_SCHEMA_VERSION
    })}\n`, "utf8");
    const migratedV2 = await new AtomicStateStore(v2Root).read();
    expect(migratedV2.schemaVersion).toBe(EVLEDA_STATE_SCHEMA_VERSION);
    expect(migratedV2.revisions[REVISION_ID]).toEqual(revision);
    expect(migratedV2.evidence[evidenceId]).toEqual(evidence);

    const v3Root = await mkdtemp(path.join(TEST_TEMP_ROOT, "evleda-state-v3-ledger-migration-"));
    temporaryRoots.push(v3Root);
    await writeFile(path.join(v3Root, "state.json"), `${JSON.stringify({
      ...legacy,
      schemaVersion: LEGACY_EVLEDA_STATE_V3_SCHEMA_VERSION
    })}\n`, "utf8");
    const migratedV3 = await new AtomicStateStore(v3Root).read();
    expect(migratedV3.schemaVersion).toBe(EVLEDA_STATE_SCHEMA_VERSION);
    expect(migratedV3.revisions[REVISION_ID]).toEqual(revision);
    expect(migratedV3.evidence[evidenceId]).toEqual(evidence);
  });
});

describe("run aggregate transition enforcement", () => {
  it("accepts recovery plus retry as interruption of the old attempt and one appended running attempt", () => {
    const before = run("running", "succeeded");
    const orphan = attempt("system_architecture", "running");
    const withOrphan = replaceStageAttempts(before, "system_architecture", [orphan], "running");
    const recovered = {
      ...orphan,
      state: "interrupted" as const,
      blockers: [blocker("system_architecture")],
      completedAt: "2026-09-03T00:00:02.000Z"
    };
    const replacement = attempt("system_architecture", "running", 2, 2);
    const after = replaceStageAttempts(
      withOrphan,
      "system_architecture",
      [recovered, replacement],
      "running"
    );

    expect(() => assertDesignRunTransition(withOrphan, after)).not.toThrow();
  });

  it("rejects resurrection of stale, succeeded, blocked, and interrupted attempts", () => {
    for (const terminal of ["stale", "succeeded", "blocked", "interrupted"] as const) {
      const beforeState: RunState = terminal === "blocked"
        ? "blocked"
        : terminal === "interrupted"
          ? "interrupted"
          : "queued";
      const before = run("queued", "succeeded");
      const historical = attempt("system_architecture", terminal);
      const withTerminal = replaceStageAttempts(before, "system_architecture", [historical], beforeState);
      const resurrected = replaceStageAttempts(
        withTerminal,
        "system_architecture",
        [{ ...historical, state: "running" }],
        "running"
      );
      expect(() => assertDesignRunTransition(withTerminal, resurrected), terminal).toThrowError();
    }
  });

  it("rejects history replacement, multiple active attempts, and lifecycle promotion", () => {
    const before = run("queued", "succeeded");
    const first = attempt("system_architecture", "running");
    const started = replaceStageAttempts(before, "system_architecture", [first], "running");

    expect(() =>
      assertDesignRunTransition(
        started,
        replaceStageAttempts(started, "system_architecture", [attempt("system_architecture", "running", 2, 2)])
      )
    ).toThrowError(expect.objectContaining({ code: "ARTIFACT_INTEGRITY_ERROR" }));

    expect(() =>
      assertDesignRunTransition(
        started,
        replaceStageAttempts(
          started,
          "system_architecture",
          [first, attempt("system_architecture", "running", 2, 2)]
        )
      )
    ).toThrowError(expect.objectContaining({ code: "ARTIFACT_INTEGRITY_ERROR" }));

    expect(() =>
      assertDesignRunTransition(started, { ...started, lifecycle: "qualified" })
    ).toThrowError(expect.objectContaining({ code: "GATE_FAILED" }));
  });

  it("rejects an invalid transaction without changing durable state or its revision", async () => {
    await mkdir(TEST_TEMP_ROOT, { recursive: true });
    const root = await mkdtemp(path.join(TEST_TEMP_ROOT, "evleda-state-transition-"));
    temporaryRoots.push(root);
    const store = new AtomicStateStore(root);
    await store.initialize();
    await persistInitialRun(store);
    await store.transaction(2, (state) => {
      const approved = run("queued", "succeeded");
      const records = workflowRecords(approved);
      state.projects[approved.projectId] = owningProject(approved);
      state.runs.run_transition_fixture = approved;
      Object.assign(state.revisions, records.revisions);
      Object.assign(state.artifacts, records.artifacts);
      Object.assign(state.approvals, records.approvals);
    });
    await store.transaction(3, (state) => {
      const current = state.runs.run_transition_fixture!;
      state.runs.run_transition_fixture = replaceStageAttempts(
        current,
        "system_architecture",
        [attempt("system_architecture", "running")],
        "running"
      );
    });
    await store.transaction(4, (state) => {
      const current = state.runs.run_transition_fixture!;
      state.runs.run_transition_fixture = replaceStageAttempts(
        current,
        "system_architecture",
        [{ ...current.attempts.system_architecture[0]!, state: "stale" }],
        "queued"
      );
    });
    const beforeRejected = await store.read();

    await expect(
      store.transaction(beforeRejected.revision, (state) => {
        const current = state.runs.run_transition_fixture!;
        state.runs.run_transition_fixture = replaceStageAttempts(
          current,
          "system_architecture",
          [{ ...current.attempts.system_architecture[0]!, state: "running" }],
          "running"
        );
      })
    ).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
      details: {
        entity: "stage_attempt",
        from: "stale",
        to: "running",
        stage: "system_architecture"
      }
    });

    expect(await store.read()).toEqual(beforeRejected);
  });
});

describe("adversarial aggregate integrity", () => {
  it("rejects every immutable run-field rewrite and invalid entity revision on a state self-edge", () => {
    const before = run("queued", "succeeded");
    const nextRevision = before.revision + 1;
    const nextUpdatedAt = "2026-09-03T00:00:02.000Z";
    const mutations: Readonly<Record<string, (source: DesignRun) => DesignRun>> = {
      id: (source) => ({ ...source, id: "run_rewritten", revision: nextRevision, updatedAt: nextUpdatedAt }),
      projectId: (source) => ({ ...source, projectId: "project_rewritten", revision: nextRevision, updatedAt: nextUpdatedAt }),
      parentRunId: (source) => ({ ...source, parentRunId: "run_parent", revision: nextRevision, updatedAt: nextUpdatedAt }),
      sourcePrompt: (source) => ({
        ...source,
        sourcePrompt: { ...source.sourcePrompt, digest: "8".repeat(64) },
        revision: nextRevision,
        updatedAt: nextUpdatedAt
      }),
      workflowVersion: (source) => ({ ...source, workflowVersion: "rewritten", revision: nextRevision, updatedAt: nextUpdatedAt }),
      configuration: (source) => ({
        ...source,
        configuration: { ...source.configuration, digest: "8".repeat(64) },
        revision: nextRevision,
        updatedAt: nextUpdatedAt
      }),
      requirements: (source) => ({
        ...source,
        requirements: { ...source.requirements!, exclusions: ["rewritten"] },
        revision: nextRevision,
        updatedAt: nextUpdatedAt
      }),
      createdAt: (source) => ({ ...source, createdAt: nextUpdatedAt, revision: nextRevision, updatedAt: nextUpdatedAt }),
      revisionJump: (source) => ({ ...source, revision: source.revision + 2, updatedAt: nextUpdatedAt }),
      backwardsUpdatedAt: (source) => ({
        ...source,
        revision: nextRevision,
        updatedAt: "2026-09-02T23:59:59.000Z"
      })
    };

    for (const [field, mutate] of Object.entries(mutations)) {
      expect(() => assertDesignRunTransition(before, mutate(before)), field).toThrowError();
    }
  });

  it("rejects same-state rewrites of every mutable-looking field on stale history", () => {
    const approved = run("queued", "succeeded");
    const historical = attempt("system_architecture", "stale");
    const before = replaceStageAttempts(approved, "system_architecture", [historical], "queued");
    const changedIdentity = { ...identity, digest: "9".repeat(64) };
    const mutations: Readonly<Record<string, (source: StageAttempt) => StageAttempt>> = {
      attemptNumber: (source) => ({ ...source, attemptNumber: 2 }),
      fencingEpoch: (source) => ({ ...source, fencingEpoch: 2 }),
      inputManifest: (source) => ({ ...source, inputManifest: changedIdentity }),
      provisionIdentity: (source) => ({ ...source, provisionIdentity: changedIdentity }),
      provisionManifestBlob: (source) => ({
        ...source,
        provisionManifestBlob: { algorithm: "sha256", digest: "9".repeat(64), size: 2 }
      }),
      executionFence: (source) => ({
        ...source,
        executionFence: { ...source.executionFence!, requirementsApprovalDigest: "9".repeat(64) }
      }),
      outputIdentity: (source) => ({ ...source, outputIdentity: changedIdentity }),
      artifactIds: (source) => ({ ...source, artifactIds: ["artifact_rewritten"] }),
      evidenceIds: (source) => ({ ...source, evidenceIds: ["evidence_rewritten"] }),
      blockers: (source) => ({ ...source, blockers: [blocker("system_architecture")] }),
      startedAt: (source) => ({ ...source, startedAt: "2026-09-03T00:00:03.000Z" }),
      completedAt: (source) => ({ ...source, completedAt: "2026-09-03T00:00:04.000Z" })
    };

    for (const [field, mutate] of Object.entries(mutations)) {
      const after = replaceStageAttempts(
        before,
        "system_architecture",
        [mutate(historical)],
        "queued"
      );
      expect(() => assertDesignRunTransition(before, after), field).toThrowError();
    }
  });

  it("rejects simultaneous active attempts across stages and out-of-order future-stage starts", () => {
    const before = run("queued", "succeeded");
    const system = attempt("system_architecture", "running");
    const component = attempt("component_selection", "running");
    const twoActive: DesignRun = {
      ...before,
      state: "running",
      attempts: {
        ...before.attempts,
        system_architecture: [system],
        component_selection: [component]
      },
      revision: before.revision + 1,
      updatedAt: "2026-09-03T00:00:02.000Z"
    };
    expect(() => assertDesignRunTransition(before, twoActive)).toThrowError(/one active attempt/iu);

    const futureOnly = replaceStageAttempts(
      before,
      "component_selection",
      [component],
      "running"
    );
    expect(() => assertDesignRunTransition(before, futureOnly)).toThrowError(/downstream stage/iu);
  });

  it("allows an empty between-stage running snapshot but rejects inactive blocked or interrupted work", () => {
    const betweenStages = run("running", "succeeded");
    expect(() => assertDesignRunTransition(betweenStages, betweenStages)).not.toThrow();

    for (const outcome of ["blocked", "interrupted"] as const) {
      const approved = run("queued", "succeeded");
      const incomplete = replaceStageAttempts(
        approved,
        "system_architecture",
        [attempt("system_architecture", outcome)],
        outcome
      );
      const forgedRunning: DesignRun = {
        ...incomplete,
        state: "running",
        revision: incomplete.revision + 1,
        updatedAt: "2026-09-03T00:00:03.000Z"
      };
      expect(() => assertDesignRunTransition(incomplete, forgedRunning), outcome).toThrowError(
        /not aligned with the first incomplete stage/iu
      );
    }
  });

  it("uses own-property-safe run detection and rejects mismatched or duplicate internal IDs", () => {
    const invalidInitial = { ...run(), id: "constructor", state: "queued" as const };
    const inheritedKeyMap = Object.create(null) as Record<string, DesignRun>;
    Object.defineProperty(inheritedKeyMap, "constructor", {
      value: invalidInitial,
      enumerable: true,
      writable: true,
      configurable: true
    });
    expect(() => assertDesignRunRecordTransitions({}, inheritedKeyMap)).toThrowError(
      expect.objectContaining({ code: "ARTIFACT_INTEGRITY_ERROR" })
    );

    const initial = run();
    const mismatched = workflowRecords(initial);
    expect(() =>
      assertWorkflowStateSnapshot({ ...mismatched, runs: { wrong_key: initial } })
    ).toThrowError(/map key/iu);

    expect(() =>
      assertWorkflowStateSnapshot({
        ...mismatched,
        runs: { [initial.id]: initial, duplicate_key: initial }
      })
    ).toThrowError(/identifiers/iu);
  });

  it("constrains head movement to a new child or an older rerun target", () => {
    const beforeRun = run("queued", "succeeded");
    const previous = workflowRecords(beforeRun);
    const unrelated: DesignRevision = {
      ...previous.revisions[REVISION_ID]!,
      id: "revision_unrelated",
      ordinal: 2,
      parentRevisionIds: [REVISION_ID]
    };
    const previousWithUnrelated = {
      ...previous,
      revisions: { ...previous.revisions, [unrelated.id]: unrelated }
    };
    const nextRun = {
      ...beforeRun,
      headRevisionId: unrelated.id,
      revision: beforeRun.revision + 1,
      updatedAt: "2026-09-03T00:00:02.000Z"
    };
    expect(() =>
      assertWorkflowStateTransitions(previousWithUnrelated, {
        ...previousWithUnrelated,
        runs: { [nextRun.id]: nextRun }
      })
    ).toThrowError(/head|rewind/iu);
  });

  it("rejects an arbitrary project-head switch to another unchanged run head", () => {
    const runA = run("queued", "succeeded");
    const recordsA = workflowRecords(runA);
    const promptB = { ...SOURCE_PROMPT, digest: "d".repeat(64) };
    const requirementsB = {
      ...requirementsDocument(true),
      identity: { ...requirementsDocument(true).identity, digest: "e".repeat(64) },
      sourcePrompt: promptB,
      approvalId: "approval_requirements_b"
    };
    const attemptsB = emptyAttempts();
    const requirementAttemptB = {
      ...attempt("requirements", "succeeded"),
      id: "attempt_requirements_b",
      inputManifest: { ...identity, digest: "d".repeat(64) },
      artifactIds: ["artifact_requirements_b"]
    };
    attemptsB.requirements = [requirementAttemptB];
    const runB: DesignRun = {
      ...runA,
      id: "run_b",
      sourcePrompt: promptB,
      requirements: requirementsB,
      attempts: attemptsB,
      headRevisionId: "revision_b"
    };
    const artifactB: ArtifactRecord = {
      ...artifactRecord(runA, "artifact_requirements_b", "requirements"),
      runId: runB.id,
      designRevisionId: "revision_b"
    };
    const revisionB: DesignRevision = {
      ...recordsA.revisions[REVISION_ID]!,
      id: "revision_b",
      runId: runB.id,
      artifactIds: [artifactB.id]
    };
    const approvalB: ApprovalRecord = {
      ...approvalRecord(runA),
      id: "approval_requirements_b",
      runId: runB.id,
      subjectDigest: requirementsB.identity.digest
    };
    const project = {
      ...recordsA.projects[runA.projectId]!,
      runIds: [runA.id, runB.id],
      headRevisionId: revisionB.id,
      revision: 4
    };
    const previous = {
      ...recordsA,
      projects: { [project.id]: project },
      runs: { [runA.id]: runA, [runB.id]: runB },
      revisions: { ...recordsA.revisions, [revisionB.id]: revisionB },
      artifacts: { ...recordsA.artifacts, [artifactB.id]: artifactB },
      approvals: { ...recordsA.approvals, [approvalB.id]: approvalB }
    };
    const switchedProject = {
      ...project,
      headRevisionId: runA.headRevisionId!,
      revision: project.revision + 1,
      updatedAt: "2026-09-03T00:00:03.000Z"
    };

    expect(() =>
      assertWorkflowStateTransitions(previous, {
        ...previous,
        projects: { [switchedProject.id]: switchedProject }
      })
    ).toThrowError(/head may change only/iu);
  });

  it("binds a newly successful attempt exactly to the new child-head inventory", () => {
    const approved = run("queued", "succeeded");
    const runningAttempt = attempt("system_architecture", "running");
    const beforeRun = replaceStageAttempts(
      approved,
      "system_architecture",
      [runningAttempt],
      "running"
    );
    const before = workflowRecords(beforeRun);
    const succeededAttempt = attempt("system_architecture", "succeeded");
    const headId = "revision_system_architecture";
    const afterRun = {
      ...replaceStageAttempts(
        beforeRun,
        "system_architecture",
        [succeededAttempt],
        "running"
      ),
      headRevisionId: headId
    };
    const systemArtifact = {
      ...artifactRecord(afterRun, succeededAttempt.artifactIds[0]!, "system_architecture"),
      designRevisionId: headId
    };
    const head: DesignRevision = {
      id: headId,
      projectId: afterRun.projectId,
      runId: afterRun.id,
      ordinal: 2,
      parentRevisionIds: [REVISION_ID],
      manifest: { ...identity, digest: "b".repeat(64), schemaVersion: "evleda.design-revision.v1" },
      artifactIds: [REQUIREMENTS_ARTIFACT_ID, systemArtifact.id],
      evidenceIds: [],
      lifecycle: "candidate",
      createdAt: "2026-09-03T00:00:02.000Z"
    };
    const after = {
      ...before,
      projects: {
        [afterRun.projectId]: {
          ...before.projects[afterRun.projectId]!,
          headRevisionId: headId,
          revision: before.projects[afterRun.projectId]!.revision + 1,
          updatedAt: "2026-09-03T00:00:02.000Z"
        }
      },
      runs: { [afterRun.id]: afterRun },
      revisions: { ...before.revisions, [headId]: head },
      artifacts: { ...before.artifacts, [systemArtifact.id]: systemArtifact }
    };
    expect(() => assertWorkflowStateTransitions(before, after)).not.toThrow();

    expect(() =>
      assertWorkflowStateTransitions(before, {
        ...after,
        revisions: { ...after.revisions, [headId]: { ...head, artifactIds: [REQUIREMENTS_ARTIFACT_ID] } }
      })
    ).toThrowError(/outputs must exactly match/iu);
  });

  it("rejects minting a new child head without stage success or the exact bring-up supplement", () => {
    const beforeRun = run("queued", "succeeded");
    const previous = workflowRecords(beforeRun);
    const headId = "revision_unbacked_child";
    const head: DesignRevision = {
      ...previous.revisions[REVISION_ID]!,
      id: headId,
      ordinal: 2,
      parentRevisionIds: [REVISION_ID]
    };
    const nextRun = {
      ...beforeRun,
      headRevisionId: headId,
      revision: beforeRun.revision + 1,
      updatedAt: "2026-09-03T00:00:02.000Z"
    };
    const nextProject = {
      ...previous.projects[beforeRun.projectId]!,
      headRevisionId: headId,
      revision: previous.projects[beforeRun.projectId]!.revision + 1,
      updatedAt: "2026-09-03T00:00:02.000Z"
    };
    expect(() =>
      assertWorkflowStateTransitions(previous, {
        ...previous,
        projects: { [nextProject.id]: nextProject },
        runs: { [nextRun.id]: nextRun },
        revisions: { ...previous.revisions, [head.id]: head }
      })
    ).toThrowError(/exact generated bring-up child/iu);
  });

  it("rejects any tool, blob, or warning drift in the narrow bring-up supplement", () => {
    const beforeRun = run("queued", "succeeded");
    const previous = workflowRecords(beforeRun);
    const parent = previous.revisions[REVISION_ID]!;
    const headId = "revision_generated_bringup";
    const artifactId = "artifact_generated_bringup";
    const generatedArtifact: ArtifactRecord = {
      id: artifactId,
      projectId: beforeRun.projectId,
      runId: beforeRun.id,
      designRevisionId: headId,
      stage: GENERATED_BRINGUP_PLAN_CONTRACT.stage,
      logicalName: GENERATED_BRINGUP_PLAN_CONTRACT.logicalName,
      mediaType: GENERATED_BRINGUP_PLAN_CONTRACT.mediaType,
      blob: contentIdentity(
        generatedBringupPlan(parent, beforeRun.requirements!.identity.digest)
      ),
      exactInputs: [parent.manifest, beforeRun.requirements!.identity],
      derivedFrom: parent.artifactIds,
      tool: GENERATED_BRINGUP_PLAN_CONTRACT.tool,
      validationStatus: GENERATED_BRINGUP_PLAN_CONTRACT.validationStatus,
      unresolvedAssumptions: [GENERATED_BRINGUP_PLAN_CONTRACT.warning],
      lifecycle: GENERATED_BRINGUP_PLAN_CONTRACT.lifecycle,
      createdAt: "2026-09-03T00:00:02.000Z"
    };
    const head: DesignRevision = {
      ...parent,
      id: headId,
      ordinal: 2,
      parentRevisionIds: [parent.id],
      artifactIds: [...parent.artifactIds, artifactId],
      createdAt: "2026-09-03T00:00:02.000Z"
    };
    const nextRun = {
      ...beforeRun,
      headRevisionId: headId,
      revision: beforeRun.revision + 1,
      updatedAt: "2026-09-03T00:00:02.000Z"
    };
    const nextProject = {
      ...previous.projects[beforeRun.projectId]!,
      headRevisionId: headId,
      revision: previous.projects[beforeRun.projectId]!.revision + 1,
      updatedAt: "2026-09-03T00:00:02.000Z"
    };
    const valid = {
      ...previous,
      projects: { [nextProject.id]: nextProject },
      runs: { [nextRun.id]: nextRun },
      revisions: { ...previous.revisions, [head.id]: head },
      artifacts: { ...previous.artifacts, [generatedArtifact.id]: generatedArtifact }
    };
    expect(() => assertWorkflowStateTransitions(previous, valid)).not.toThrow();

    const mutations: readonly ArtifactRecord[] = [
      {
        ...generatedArtifact,
        tool: { ...generatedArtifact.tool, version: "rewritten" }
      },
      {
        ...generatedArtifact,
        tool: { ...generatedArtifact.tool, capabilityProfile: "rewritten" }
      },
      {
        ...generatedArtifact,
        blob: { ...generatedArtifact.blob, digest: "f".repeat(64) }
      },
      {
        ...generatedArtifact,
        unresolvedAssumptions: []
      }
    ];
    for (const mutated of mutations) {
      expect(() =>
        assertWorkflowStateTransitions(previous, {
          ...valid,
          artifacts: { ...valid.artifacts, [mutated.id]: mutated }
        })
      ).toThrowError(/exact generated bring-up child/iu);
    }
  });

  it("makes approvals append-only and immutable except for one-way revocation", () => {
    const approved = run("queued", "succeeded");
    const records = workflowRecords(approved);
    const qualification: ApprovalRecord = {
      id: "approval_qualification",
      kind: "qualification",
      projectId: approved.projectId,
      runId: approved.id,
      designRevisionId: REVISION_ID,
      subjectDigest: records.revisions[REVISION_ID]!.manifest.digest,
      evidenceRootDigest: "c".repeat(64),
      policyVersion: "evleda.policy.v1",
      actor: { type: "human", id: "qualifier", displayName: "Qualifier", role: "hardware_qualifier" },
      scope: "exact revision",
      rationale: "Qualified test candidate.",
      createdAt: "2026-09-03T00:00:02.000Z"
    };
    const previous = {
      ...records,
      approvals: { ...records.approvals, [qualification.id]: qualification }
    };
    expect(() =>
      assertWorkflowStateTransitions(previous, {
        ...previous,
        approvals: records.approvals
      })
    ).toThrowError(/append-only/iu);
    expect(() =>
      assertWorkflowStateTransitions(previous, {
        ...previous,
        approvals: {
          ...previous.approvals,
          [qualification.id]: { ...qualification, rationale: "Rewritten." }
        }
      })
    ).toThrowError(/immutable except/iu);

    const bumpedRun = {
      ...approved,
      revision: approved.revision + 1,
      updatedAt: "2026-09-03T00:00:03.000Z"
    };
    expect(() =>
      assertWorkflowStateTransitions(previous, {
        ...previous,
        runs: { [bumpedRun.id]: bumpedRun },
        approvals: {
          ...previous.approvals,
          [qualification.id]: { ...qualification, revokedAt: "2026-09-03T00:00:03.000Z" }
        }
      })
    ).not.toThrow();
  });

  it("requires exact and distinct evidence raw/parsed artifact bindings", () => {
    const approved = run("queued", "succeeded");
    const records = workflowRecords(approved);
    const raw = {
      ...artifactRecord(approved, "artifact_raw", "bringup_package"),
      designRevisionId: REVISION_ID
    };
    const parsed = {
      ...artifactRecord(approved, "artifact_parsed", "bringup_package"),
      designRevisionId: REVISION_ID
    };
    const evidence: EvidenceRecord = {
      id: "evidence_physical_exact",
      projectId: approved.projectId,
      runId: approved.id,
      designRevisionId: REVISION_ID,
      stage: "bringup_package",
      evidenceClass: "human_physical",
      claim: "Exact physical evidence.",
      subjectDigests: [identity.digest],
      rawArtifactId: raw.id,
      parsedArtifactId: parsed.id,
      exactInputs: [identity],
      tool: { name: "human", version: "1", adapter: "human" },
      validationStatus: "pass",
      unresolvedAssumptions: [],
      lifecycle: "candidate",
      createdAt: "2026-09-03T00:00:02.000Z"
    };
    const valid = {
      ...records,
      artifacts: { ...records.artifacts, [raw.id]: raw, [parsed.id]: parsed },
      evidence: { [evidence.id]: evidence }
    };
    expect(() => assertWorkflowStateSnapshot(valid)).not.toThrow();
    expect(() =>
      assertWorkflowStateSnapshot({
        ...valid,
        evidence: { [evidence.id]: { ...evidence, parsedArtifactId: raw.id } }
      })
    ).toThrowError(/distinct/iu);
    expect(() =>
      assertWorkflowStateSnapshot({
        ...valid,
        artifacts: { ...valid.artifacts, [parsed.id]: { ...parsed, stage: "schematic" } }
      })
    ).toThrowError(/missing or foreign-run artifact/iu);
  });

  it("rejects duplicate revision inventories, sibling-branch inventory, and derivation cycles", () => {
    const approved = run("queued", "succeeded");
    const records = workflowRecords(approved);
    expect(() =>
      assertWorkflowStateSnapshot({
        ...records,
        revisions: {
          [REVISION_ID]: {
            ...records.revisions[REVISION_ID]!,
            artifactIds: [REQUIREMENTS_ARTIFACT_ID, REQUIREMENTS_ARTIFACT_ID]
          }
        }
      })
    ).toThrowError(/must be unique/iu);

    const siblingArtifact = {
      ...artifactRecord(approved, "artifact_sibling", "system_architecture"),
      designRevisionId: "revision_sibling"
    };
    const siblingRevision: DesignRevision = {
      ...records.revisions[REVISION_ID]!,
      id: "revision_sibling",
      ordinal: 2,
      parentRevisionIds: [REVISION_ID],
      artifactIds: [REQUIREMENTS_ARTIFACT_ID, siblingArtifact.id]
    };
    const otherBranch: DesignRevision = {
      ...records.revisions[REVISION_ID]!,
      id: "revision_other_branch",
      ordinal: 3,
      parentRevisionIds: [REVISION_ID],
      artifactIds: [REQUIREMENTS_ARTIFACT_ID, siblingArtifact.id]
    };
    expect(() =>
      assertWorkflowStateSnapshot({
        ...records,
        revisions: {
          ...records.revisions,
          [siblingRevision.id]: siblingRevision,
          [otherBranch.id]: otherBranch
        },
        artifacts: { ...records.artifacts, [siblingArtifact.id]: siblingArtifact }
      })
    ).toThrowError(/sibling branch/iu);

    const artifactA = {
      ...artifactRecord(approved, "artifact_cycle_a", "system_architecture"),
      derivedFrom: ["artifact_cycle_b"]
    };
    const artifactB = {
      ...artifactRecord(approved, "artifact_cycle_b", "system_architecture"),
      derivedFrom: ["artifact_cycle_a"]
    };
    expect(() =>
      assertWorkflowStateSnapshot({
        ...records,
        artifacts: {
          ...records.artifacts,
          [artifactA.id]: artifactA,
          [artifactB.id]: artifactB
        }
      })
    ).toThrowError(/contains a cycle/iu);
  });

  it("enforces candidate lifecycle for revisions, artifacts, and evidence", () => {
    const approved = run("queued", "succeeded");
    const records = workflowRecords(approved);
    const physical: EvidenceRecord = {
      id: "evidence_physical",
      projectId: approved.projectId,
      runId: approved.id,
      designRevisionId: REVISION_ID,
      stage: "bringup_package",
      evidenceClass: "human_physical",
      claim: "Candidate observation.",
      subjectDigests: [identity.digest],
      exactInputs: [identity],
      tool: { name: "human", version: "1", adapter: "human" },
      validationStatus: "pass",
      unresolvedAssumptions: [],
      lifecycle: "candidate",
      createdAt: "2026-09-03T00:00:01.000Z"
    };
    const qualifiedRevision = {
      ...records.revisions[REVISION_ID]!,
      lifecycle: "qualified" as const
    };
    const qualifiedArtifact = {
      ...records.artifacts[REQUIREMENTS_ARTIFACT_ID]!,
      lifecycle: "qualified" as const
    };
    const qualifiedEvidence = { ...physical, lifecycle: "qualified" as const };

    expect(() =>
      assertWorkflowStateSnapshot({
        ...records,
        revisions: { [REVISION_ID]: qualifiedRevision }
      })
    ).toThrowError(/candidate lifecycle/iu);
    expect(() =>
      assertWorkflowStateSnapshot({
        ...records,
        artifacts: { [REQUIREMENTS_ARTIFACT_ID]: qualifiedArtifact }
      })
    ).toThrowError(/candidate lifecycle/iu);
    expect(() =>
      assertWorkflowStateSnapshot({
        ...records,
        evidence: { [physical.id]: qualifiedEvidence }
      })
    ).toThrowError(/candidate lifecycle/iu);
  });

  it("rejects same-ID rewrites of committed project, revision, artifact, and evidence records", () => {
    const approved = run("queued", "succeeded");
    const records = workflowRecords(approved);
    const physical: EvidenceRecord = {
      id: "evidence_committed",
      projectId: approved.projectId,
      runId: approved.id,
      designRevisionId: REVISION_ID,
      stage: "bringup_package",
      evidenceClass: "human_physical",
      claim: "Committed candidate observation.",
      subjectDigests: [identity.digest],
      exactInputs: [identity],
      tool: { name: "human", version: "1", adapter: "human" },
      validationStatus: "pass",
      unresolvedAssumptions: [],
      lifecycle: "candidate",
      createdAt: "2026-09-03T00:00:01.000Z"
    };
    const previous = { ...records, evidence: { [physical.id]: physical } };

    expect(() =>
      assertWorkflowStateTransitions(previous, {
        ...previous,
        projects: {
          [approved.projectId]: {
            ...previous.projects[approved.projectId]!,
            root: "rewritten-root",
            revision: previous.projects[approved.projectId]!.revision + 1
          }
        }
      })
    ).toThrowError(/immutable project field/iu);

    expect(() =>
      assertWorkflowStateTransitions(previous, {
        ...previous,
        revisions: {
          [REVISION_ID]: {
            ...previous.revisions[REVISION_ID]!,
            manifest: { ...previous.revisions[REVISION_ID]!.manifest, digest: "a".repeat(64) }
          }
        }
      })
    ).toThrowError(/revision records are immutable/iu);

    expect(() =>
      assertWorkflowStateTransitions(previous, {
        ...previous,
        artifacts: {
          [REQUIREMENTS_ARTIFACT_ID]: {
            ...previous.artifacts[REQUIREMENTS_ARTIFACT_ID]!,
            blob: { algorithm: "sha256", digest: "a".repeat(64), size: 99 }
          }
        }
      })
    ).toThrowError(/immutable except for one-way staling/iu);

    expect(() =>
      assertWorkflowStateTransitions(previous, {
        ...previous,
        evidence: { [physical.id]: { ...physical, claim: "Rewritten claim." } }
      })
    ).toThrowError(/immutable except for one-way staling/iu);
  });

  it("allows rerun invalidation to timestamp a diagnostic already reporting stale", () => {
    const approved = run("queued", "succeeded");
    const records = workflowRecords(approved);
    const diagnostic = {
      ...records.artifacts[REQUIREMENTS_ARTIFACT_ID]!,
      validationStatus: "stale" as const
    };
    const previous = {
      ...records,
      artifacts: { [diagnostic.id]: diagnostic }
    };
    expect(() =>
      assertWorkflowStateTransitions(previous, {
        ...previous,
        artifacts: {
          [diagnostic.id]: { ...diagnostic, staleAt: "2026-09-03T00:00:03.000Z" }
        }
      })
    ).not.toThrow();
  });

  it("rejects dangling project, revision, artifact, evidence, and derivation ownership links", () => {
    const approved = run("queued", "succeeded");
    const records = workflowRecords(approved);
    const requirementArtifact = records.artifacts[REQUIREMENTS_ARTIFACT_ID]!;

    expect(() =>
      assertWorkflowStateSnapshot({ ...records, projects: {} })
    ).toThrowError(/owned by its recorded project/iu);

    expect(() =>
      assertWorkflowStateSnapshot({
        ...records,
        revisions: {
          [REVISION_ID]: {
            ...records.revisions[REVISION_ID]!,
            parentRevisionIds: ["revision_missing"]
          }
        }
      })
    ).toThrowError(/parent is missing/iu);

    expect(() =>
      assertWorkflowStateSnapshot({
        ...records,
        artifacts: {
          [REQUIREMENTS_ARTIFACT_ID]: {
            ...requirementArtifact,
            designRevisionId: "revision_missing"
          }
        }
      })
    ).toThrowError(/does not belong to its recorded revision/iu);

    expect(() =>
      assertWorkflowStateSnapshot({
        ...records,
        artifacts: {
          [REQUIREMENTS_ARTIFACT_ID]: {
            ...requirementArtifact,
            derivedFrom: ["artifact_missing"]
          }
        }
      })
    ).toThrowError(/derivation references/iu);

    const danglingEvidence: EvidenceRecord = {
      id: "evidence_dangling",
      projectId: approved.projectId,
      runId: approved.id,
      designRevisionId: REVISION_ID,
      stage: "bringup_package",
      evidenceClass: "human_physical",
      claim: "Dangling evidence.",
      subjectDigests: [identity.digest],
      rawArtifactId: "artifact_missing",
      exactInputs: [identity],
      tool: { name: "human", version: "1", adapter: "human" },
      validationStatus: "pass",
      unresolvedAssumptions: [],
      lifecycle: "candidate",
      createdAt: "2026-09-03T00:00:01.000Z"
    };
    expect(() =>
      assertWorkflowStateSnapshot({
        ...records,
        evidence: { [danglingEvidence.id]: danglingEvidence }
      })
    ).toThrowError(/references a missing/iu);
  });
});

describe("state-store read and serialization enforcement", () => {
  const makeRoot = async (prefix: string): Promise<string> => {
    await mkdir(TEST_TEMP_ROOT, { recursive: true });
    const root = await mkdtemp(path.join(TEST_TEMP_ROOT, prefix));
    temporaryRoots.push(root);
    return root;
  };

  it("rejects malformed run state and key-ID mismatch during initialize", async () => {
    const root = await makeRoot("evleda-invalid-state-read-");
    const malformed = stateWithRun({ ...run(), state: "not_a_state" as RunState });
    await writeFile(path.join(root, "state.json"), `${JSON.stringify(malformed)}\n`, "utf8");
    await expect(new AtomicStateStore(root).initialize()).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR"
    });

    const mismatchedRoot = await makeRoot("evleda-invalid-key-read-");
    const initial = run();
    const mismatched = { ...stateWithRun(initial), runs: { wrong_key: initial } };
    await writeFile(path.join(mismatchedRoot, "state.json"), `${JSON.stringify(mismatched)}\n`, "utf8");
    await expect(new AtomicStateStore(mismatchedRoot).read()).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR"
    });
  });

  it("rejects a non-enumerable shadow instead of serializing a silent run deletion", async () => {
    const root = await makeRoot("evleda-nonenumerable-state-");
    const store = new AtomicStateStore(root);
    await store.initialize();
    await persistInitialRun(store);
    const before = await store.read();

    await expect(
      store.transaction(before.revision, (state) => {
        const current = state.runs.run_transition_fixture!;
        delete state.runs.run_transition_fixture;
        Object.defineProperty(state.runs, "run_transition_fixture", {
          value: current,
          enumerable: false,
          writable: true,
          configurable: true
        });
      })
    ).rejects.toMatchObject({ code: "ARTIFACT_INTEGRITY_ERROR" });
    expect(await store.read()).toEqual(before);
  });

  it("serializes the detached validated snapshot before a retained callback alias can mutate", async () => {
    const root = await makeRoot("evleda-detached-state-");
    const store = new AtomicStateStore(root);
    await store.initialize();
    await persistInitialRun(store);
    const beforeRetainedMutation = await store.read();
    let mutationFinished!: Promise<void>;

    await store.transaction(beforeRetainedMutation.revision, (state) => {
      mutationFinished = new Promise<void>((resolve) => {
        queueMicrotask(() => {
          queueMicrotask(() => {
            const current = state.runs.run_transition_fixture!;
            state.runs.run_transition_fixture = {
              ...current,
              state: "completed",
              lifecycle: "release_authorized",
              revision: -1
            };
            resolve();
          });
        });
      });
    });
    await mutationFinished;

    const raw = JSON.parse(await readFile(path.join(root, "state.json"), "utf8")) as EvlEdaState;
    expect(raw.revision).toBe(beforeRetainedMutation.revision + 1);
    expect(raw.runs.run_transition_fixture).toMatchObject({
      state: "waiting_requirements_approval",
      lifecycle: "candidate",
      revision: 0
    });
    await expect(store.read()).resolves.toEqual(raw);
  });
});
