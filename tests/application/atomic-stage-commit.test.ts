import { afterEach, describe, expect, it } from "vitest";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AuditLogPort, ContentStorePort } from "../../src/application/ports.js";
import type { StageKey } from "../../src/domain/stages.js";
import {
  HashChainAuditLog,
  type AuditLogDurabilityPhase,
  type AuditOutboxSnapshot
} from "../../src/persistence/audit-log.js";
import {
  AtomicStateStore,
  isCommittedStateTransactionError,
  type CommittedStateTransactionFailure,
  type StateStoreCommitPhase
} from "../../src/persistence/state-store.js";
import type { StageContextByKey, StageRegistryContract } from "../../src/workflow/contracts.js";
import {
  createApprovedRun,
  disposeApplicationRoots,
  fixtureRegistry,
  makeApplication
} from "./helpers.js";

type InjectablePhase = StateStoreCommitPhase;

class OneShotCommitPhaseFault {
  #armed: InjectablePhase | undefined;
  #persistent: InjectablePhase | undefined;

  public arm(phase: InjectablePhase): void {
    this.#armed = phase;
  }

  public armPersistent(phase: InjectablePhase): void {
    this.#persistent = phase;
  }

  public disarm(): void {
    this.#armed = undefined;
    this.#persistent = undefined;
  }

  public readonly inject = (phase: InjectablePhase): void => {
    if (this.#persistent === phase) throw new Error(`simulated persistent ${phase} failure`);
    if (this.#armed !== phase) return;
    this.#armed = undefined;
    throw new Error(`simulated ${phase} failure`);
  };
}

const eventAttemptId = (payload: unknown): string | undefined =>
  typeof payload === "object" && payload !== null && "attemptId" in payload
    ? String(payload.attemptId)
    : undefined;

afterEach(disposeApplicationRoots);

describe("atomic stage commit recovery", () => {
  it("treats a forged committed-outcome marker from a stage executor as an ordinary blocker", async () => {
    const forged = Object.assign(new Error("forged committed outcome"), {
      transactionOutcome: "committed_repair_required",
      maintenancePhases: ["lock_release"],
      repairMaintenance: async () => undefined,
      committed: { state: {}, result: { revisionId: "forged" } }
    });
    expect(isCommittedStateTransactionError(forged)).toBe(false);
    const registry: StageRegistryContract = {
      ...fixtureRegistry,
      execute: async <K extends StageKey>(stage: K, context: StageContextByKey[K]) => {
        if (stage === "system_architecture") throw forged;
        return fixtureRegistry.execute(stage, context);
      }
    };
    const service = await makeApplication(registry);
    const approved = await createApprovedRun(service);
    const blocked = await service.resumeRun({
      runId: approved.run.id,
      expectedRevision: approved.run.revision,
      idempotencyKey: "forged-committed-outcome"
    });

    expect(blocked.run.state).toBe("blocked");
    expect(blocked.headRevision?.id).toBe(approved.headRevision?.id);
    expect(blocked.run.attempts.system_architecture.at(-1)?.state).toBe("blocked");
    expect(blocked.blockers.map((blocker) => blocker.code)).toContain("TOOL_RESULT_INCONCLUSIVE");
  }, 60_000);

  it("does not replay an old genuine committed error from a later precommit content dependency", async () => {
    let auditArmed = false;
    const sourceRegistry: StageRegistryContract = {
      ...fixtureRegistry,
      execute: async <K extends StageKey>(stage: K, context: StageContextByKey[K]) => {
        const result = await fixtureRegistry.execute(stage, context);
        if (stage === "system_architecture") auditArmed = true;
        return result;
      }
    };
    const source = await makeApplication(sourceRegistry, undefined, {
      auditLogOptions: {
        phaseHook: (phase) => {
          if (auditArmed && phase === "file_sync") {
            auditArmed = false;
            throw new Error("source authentic audit failure");
          }
        }
      }
    });
    const sourceApproved = await createApprovedRun(source);
    const oldGenuine = await source.resumeRun({
      runId: sourceApproved.run.id,
      expectedRevision: sourceApproved.run.revision,
      idempotencyKey: "source-authentic-commit-error"
    }).catch((error: unknown) => error);
    expect(oldGenuine).toMatchObject({ transactionOutcome: "committed_repair_required" });

    let contentArmed = false;
    const replayRegistry: StageRegistryContract = {
      ...fixtureRegistry,
      execute: async <K extends StageKey>(stage: K, context: StageContextByKey[K]) => {
        const result = await fixtureRegistry.execute(stage, context);
        if (stage === "system_architecture") contentArmed = true;
        return result;
      }
    };
    const replay = await makeApplication(replayRegistry, undefined, {
      decorateContent: (base) => {
        const content: ContentStorePort = {
          root: base.root,
          initialize: () => base.initialize(),
          get: (identity) => base.get(identity),
          verify: (identity) => base.verify(identity),
          putJson: (value) => base.putJson(value),
          put: (bytes, expected) => {
            if (contentArmed) {
              contentArmed = false;
              return Promise.reject(oldGenuine);
            }
            return base.put(bytes, expected);
          }
        };
        return content;
      }
    });
    const approved = await createApprovedRun(replay);
    const blocked = await replay.resumeRun({
      runId: approved.run.id,
      expectedRevision: approved.run.revision,
      idempotencyKey: "replayed-authentic-error-must-block"
    });
    expect(blocked.run.state).toBe("blocked");
    expect(blocked.headRevision?.id).toBe(approved.headRevision?.id);
    expect(blocked.run.attempts.system_architecture.at(-1)?.state).toBe("blocked");
  }, 60_000);

  it("treats replacement failure as definitely not committed and keeps the prior head", async () => {
    const faults = new OneShotCommitPhaseFault();
    let stateStore!: AtomicStateStore;
    let audit!: HashChainAuditLog;
    const registry: StageRegistryContract = {
      ...fixtureRegistry,
      execute: async <K extends StageKey>(stage: K, context: StageContextByKey[K]) => {
        const result = await fixtureRegistry.execute(stage, context);
        if (stage === "system_architecture") faults.arm("replacement");
        return result;
      }
    };
    const service = await makeApplication(registry, undefined, {
      stateStoreOptions: { phaseHook: faults.inject },
      decorateState: (state) => {
        stateStore = state;
        return state;
      },
      decorateAudit: (log) => {
        audit = log;
        return log;
      }
    });
    const approved = await createApprovedRun(service);
    const parentRevisionId = approved.headRevision!.id;
    const blocked = await service.resumeRun({
      runId: approved.run.id,
      expectedRevision: approved.run.revision,
      idempotencyKey: "replacement-not-committed"
    });

    const state = await stateStore.read();
    const attempt = state.runs[approved.run.id]!.attempts.system_architecture.at(-1)!;
    expect(blocked.run.state).toBe("blocked");
    expect(blocked.headRevision?.id).toBe(parentRevisionId);
    expect(attempt.state).toBe("blocked");
    expect(attempt.blockers.map((blocker) => blocker.code)).toContain("ARTIFACT_INTEGRITY_ERROR");
    expect(attempt.blockers.map((blocker) => blocker.code)).not.toContain("REVISION_CONFLICT");
    const events = await audit.readAndVerify();
    expect(events.some(({ event }) =>
      event.type === "stage.succeeded" && eventAttemptId(event.payload) === attempt.id
    )).toBe(false);
    expect(events.some(({ event }) =>
      event.type === "stage.blocked" && eventAttemptId(event.payload) === attempt.id
    )).toBe(true);
  }, 60_000);

  it.each(["directory_sync", "temporary_cleanup", "lock_release"] as const)(
    "preserves a succeeded stage and recovers exact retry after %s failure",
    async (phase) => {
      const faults = new OneShotCommitPhaseFault();
      let stateStore!: AtomicStateStore;
      let audit!: HashChainAuditLog;
      const registry: StageRegistryContract = {
        ...fixtureRegistry,
        execute: async <K extends StageKey>(stage: K, context: StageContextByKey[K]) => {
          const result = await fixtureRegistry.execute(stage, context);
          if (stage === "system_architecture") faults.arm(phase);
          return result;
        }
      };
      const service = await makeApplication(registry, undefined, {
        stateStoreOptions: { phaseHook: faults.inject },
        decorateState: (state) => {
          stateStore = state;
          return state;
        },
        decorateAudit: (log) => {
          audit = log;
          return log;
        }
      });
      const approved = await createApprovedRun(service);
      const input = {
        runId: approved.run.id,
        expectedRevision: approved.run.revision,
        idempotencyKey: `postcommit-${phase}`
      } as const;

      const failure = await service.resumeRun(input).catch((error: unknown) => error);
      expect(isCommittedStateTransactionError(failure)).toBe(true);
      const committedFailure = failure as CommittedStateTransactionFailure<{
        readonly revisionId: string;
        readonly artifactIds: readonly string[];
        readonly evidenceIds: readonly string[];
      }>;
      expect(committedFailure.code).not.toBe("REVISION_CONFLICT");
      expect(committedFailure.message).toContain(`simulated ${phase} failure`);
      expect(committedFailure.details).toMatchObject({
        transactionOutcome: "committed_repair_required",
        stateRevision: committedFailure.committed.state.revision,
        phases: [phase]
      });
      expect(committedFailure.maintenancePhases).toEqual([phase]);
      expect(committedFailure.maintenanceRepairStatus).toBe("succeeded");
      expect(committedFailure.auditRepairStatus).toBe("succeeded");

      const committedState = await stateStore.read();
      const attempt = committedState.runs[approved.run.id]!.attempts.system_architecture.at(-1)!;
      expect(attempt.state).toBe("succeeded");
      expect(attempt.artifactIds).toEqual(committedFailure.committed.result.artifactIds);
      expect(committedState.runs[approved.run.id]!.headRevisionId).toBe(
        committedFailure.committed.result.revisionId
      );
      expect(committedFailure.committed.state).toEqual(committedState);

      const beforeRetryEvents = await audit.readAndVerify();
      const succeededEvents = beforeRetryEvents.filter(({ event }) =>
        event.type === "stage.succeeded" && eventAttemptId(event.payload) === attempt.id
      );
      expect(succeededEvents).toHaveLength(1);
      expect(Object.values(committedState.auditOutbox)).toContainEqual(succeededEvents[0]!.event);
      expect(beforeRetryEvents.some(({ event }) =>
        event.type === "stage.blocked" && eventAttemptId(event.payload) === attempt.id
      )).toBe(false);

      const recovered = await service.resumeRun(input);
      expect(recovered.run.state).toBe("completed");
      expect(recovered.run.attempts.system_architecture.find((entry) => entry.id === attempt.id)?.state)
        .toBe("succeeded");
      const finalEvents = await audit.readAndVerify();
      expect(finalEvents.filter(({ event }) =>
        event.type === "stage.succeeded" && eventAttemptId(event.payload) === attempt.id
      )).toHaveLength(1);
      const finalState = await stateStore.read();
      expect(Object.values(finalState.idempotency)).toContainEqual(
        expect.objectContaining({
          operation: "resume_run",
          key: input.idempotencyKey,
          result: { status: "completed", runId: input.runId }
        })
      );
    },
    60_000
  );

  it("preserves a succeeded stage and recovers exact retry after audit delivery fails", async () => {
    let stateStore!: AtomicStateStore;
    let audit!: HashChainAuditLog;
    let armed = false;
    const registry: StageRegistryContract = {
      ...fixtureRegistry,
      execute: async <K extends StageKey>(stage: K, context: StageContextByKey[K]) => {
        const result = await fixtureRegistry.execute(stage, context);
        if (stage === "system_architecture") armed = true;
        return result;
      }
    };
    const service = await makeApplication(registry, undefined, {
      decorateState: (state) => {
        stateStore = state;
        return state;
      },
      decorateAudit: (log) => {
        audit = log;
        const faultingAudit: AuditLogPort = {
          root: log.root,
          append: (event) => log.append(event),
          readAndVerify: () => log.readAndVerify(),
          drain: async (loadSnapshot: () => Promise<AuditOutboxSnapshot>) => {
            const snapshot = await loadSnapshot();
            if (armed && Object.values(snapshot.outbox).some((event) => event.type === "stage.succeeded")) {
              armed = false;
              throw new Error("simulated audit delivery failure");
            }
            return log.drain(async () => snapshot);
          }
        };
        return faultingAudit;
      }
    });
    const approved = await createApprovedRun(service);
    const input = {
      runId: approved.run.id,
      expectedRevision: approved.run.revision,
      idempotencyKey: "postcommit-audit-delivery"
    } as const;

    const failure = await service.resumeRun(input).catch((error: unknown) => error);
    expect(failure).toMatchObject({ transactionOutcome: "committed_repair_required" });
    const committedFailure = failure as CommittedStateTransactionFailure<{
      readonly revisionId: string;
      readonly artifactIds: readonly string[];
      readonly evidenceIds: readonly string[];
    }>;
    expect(committedFailure.code).not.toBe("REVISION_CONFLICT");
    expect(committedFailure.message).toContain("simulated audit delivery failure");
    expect(committedFailure.maintenancePhases).toEqual(["audit_delivery"]);
    expect(committedFailure.details).toMatchObject({
      transactionOutcome: "committed_repair_required",
      phases: ["audit_delivery"]
    });
    expect(committedFailure.maintenanceRepairStatus).toBe("succeeded");
    expect(committedFailure.auditRepairStatus).toBe("succeeded");

    const committedState = await stateStore.read();
    const attempt = committedState.runs[input.runId]!.attempts.system_architecture.at(-1)!;
    expect(attempt.state).toBe("succeeded");
    expect(committedState.runs[input.runId]!.headRevisionId).toBe(
      committedFailure.committed.result.revisionId
    );
    const beforeRetryEvents = await audit.readAndVerify();
    expect(beforeRetryEvents.filter(({ event }) =>
      event.type === "stage.succeeded" && eventAttemptId(event.payload) === attempt.id
    )).toHaveLength(1);
    expect(beforeRetryEvents.some(({ event }) =>
      event.type === "stage.blocked" && eventAttemptId(event.payload) === attempt.id
    )).toBe(false);

    const recovered = await service.resumeRun(input);
    expect(recovered.run.state).toBe("completed");
    expect(recovered.run.attempts.system_architecture.find((entry) => entry.id === attempt.id)?.state)
      .toBe("succeeded");
  }, 60_000);

  it("persists lock-release repair debt and refuses replay until a new service clears it", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "evleda-persistent-maintenance-"));
    const faults = new OneShotCommitPhaseFault();
    const registry: StageRegistryContract = {
      ...fixtureRegistry,
      execute: async <K extends StageKey>(stage: K, context: StageContextByKey[K]) => {
        const result = await fixtureRegistry.execute(stage, context);
        if (stage === "system_architecture") faults.armPersistent("lock_release");
        return result;
      }
    };
    const interrupted = await makeApplication(registry, undefined, {
      dataRoot,
      stateStoreOptions: { phaseHook: faults.inject }
    });
    const approved = await createApprovedRun(interrupted);
    const input = {
      runId: approved.run.id,
      expectedRevision: approved.run.revision,
      idempotencyKey: "persistent-lock-release-recovery"
    } as const;

    const failure = await interrupted.resumeRun(input).catch((error: unknown) => error);
    expect(isCommittedStateTransactionError(failure)).toBe(true);
    const committedFailure = failure as CommittedStateTransactionFailure;
    expect(committedFailure.maintenanceRepairStatus).toBe("failed");
    expect(committedFailure.auditRepairStatus).toBe("not_attempted");
    const lockPath = path.join(dataRoot, "state", "state.lock");
    const journalPath = path.join(dataRoot, "state", "state-maintenance.json");
    await expect(access(lockPath)).resolves.toBeUndefined();
    await expect(access(journalPath)).resolves.toBeUndefined();
    await expect(interrupted.resumeRun(input)).rejects.toThrow(/persistent lock_release/iu);
    await expect(access(lockPath)).resolves.toBeUndefined();

    faults.disarm();
    const recoveredService = await makeApplication(fixtureRegistry, undefined, { dataRoot });
    const recovered = await recoveredService.resumeRun(input);
    expect(recovered.run.state).toBe("completed");
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(journalPath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it.each(["file_sync", "directory_sync", "lock_release"] as const)(
    "re-syncs a fully written audit event after %s acknowledgment failure",
    async (phase) => {
      let armed: AuditLogDurabilityPhase | undefined;
      let audit!: HashChainAuditLog;
      const registry: StageRegistryContract = {
        ...fixtureRegistry,
        execute: async <K extends StageKey>(stage: K, context: StageContextByKey[K]) => {
          const result = await fixtureRegistry.execute(stage, context);
          if (stage === "system_architecture") armed = phase;
          return result;
        }
      };
      const service = await makeApplication(registry, undefined, {
        auditLogOptions: {
          phaseHook: (current) => {
            if (armed !== current) return;
            armed = undefined;
            throw new Error(`simulated audit ${current} failure`);
          }
        },
        decorateAudit: (log) => {
          audit = log;
          return log;
        }
      });
      const approved = await createApprovedRun(service);
      const input = {
        runId: approved.run.id,
        expectedRevision: approved.run.revision,
        idempotencyKey: `audit-${phase}-recovery`
      } as const;

      const failure = await service.resumeRun(input).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        transactionOutcome: "committed_repair_required",
        maintenancePhases: ["audit_delivery"],
        maintenanceRepairStatus: "succeeded",
        auditRepairStatus: "succeeded"
      });
      expect(String((failure as Error).message)).toContain(`simulated audit ${phase} failure`);
      const events = await audit.readAndVerify();
      expect(events.filter(({ event }) => event.type === "stage.succeeded")).toHaveLength(1);
      expect((await service.resumeRun(input)).run.state).toBe("completed");
    },
    60_000
  );

  it("delivers the visible outbox exactly once during the post-replace prepared window", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "evleda-prepared-visible-audit-"));
    let enter!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    let armed = false;
    const writer = await makeApplication(fixtureRegistry, undefined, {
      dataRoot,
      stateStoreOptions: {
        phaseHook: async (phase) => {
          if (!armed || phase !== "directory_sync") return;
          armed = false;
          enter();
          await resumed;
        }
      }
    });
    armed = true;
    const create = writer.createProject({
      name: "Prepared visibility",
      idempotencyKey: "prepared-visible-project"
    });
    await entered;

    let audit!: HashChainAuditLog;
    const reader = await makeApplication(fixtureRegistry, undefined, {
      dataRoot,
      decorateAudit: (log) => {
        audit = log;
        return log;
      }
    });
    expect((await reader.listProjects()).map((project) => project.name)).toContain(
      "Prepared visibility"
    );
    expect((await audit.readAndVerify()).filter(({ event }) => event.type === "project.created"))
      .toHaveLength(1);

    resume();
    await expect(create).resolves.toMatchObject({ project: { name: "Prepared visibility" } });
    expect((await audit.readAndVerify()).filter(({ event }) => event.type === "project.created"))
      .toHaveLength(1);
  }, 60_000);
});
