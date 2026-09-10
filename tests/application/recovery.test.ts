import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ApplicationService } from "../../src/application/application-service.js";
import { localHumanContext } from "../../src/contracts/capabilities.js";
import type { AuditEvent, AuditOutboxSnapshot } from "../../src/persistence/audit-log.js";
import {
  EVLEDA_AUDIT_EVENT_SCHEMA_VERSION,
  HashChainAuditLog
} from "../../src/persistence/audit-log.js";
import { FileContentStore } from "../../src/persistence/content-store.js";
import { AtomicStateStore } from "../../src/persistence/state-store.js";
import { fixtureRegistry, reviewer, validPrompt } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const storesAt = (root: string) => ({
  state: new AtomicStateStore(path.join(root, "state")),
  content: new FileContentStore(path.join(root, "content")),
  audit: new HashChainAuditLog(path.join(root, "audit"))
});

const waitForFile = async (file: string): Promise<void> => {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await access(file);
      return;
    } catch {
      await delay(10);
    }
  }
  throw new Error(`Timed out waiting for child readiness: ${file}`);
};

const runDrainWorker = (
  root: string,
  readyFile: string,
  startFile: string
): Promise<{ readonly pid: number; readonly events: number }> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.resolve("node_modules", "tsx", "dist", "cli.mjs"),
        path.resolve("tests", "fixtures", "audit-drain-worker.ts"),
        root,
        readyFile,
        startFile
      ],
      { cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Audit drain worker timed out: ${stderr}`));
    }, 15_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Audit drain worker exited ${String(code)}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()) as { readonly pid: number; readonly events: number });
      } catch (error) {
        reject(error);
      }
    });
  });

describe("durable command recovery", () => {
  it("repairs a state-committed audit event from the in-state outbox", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-recovery-"));
    roots.push(root);
    const stores = storesAt(root);
    let fail = true;
    const service = new ApplicationService(
      {
        ...stores,
        audit: {
          root: stores.audit.root,
          readAndVerify: () => stores.audit.readAndVerify(),
          drain: async (loadSnapshot: () => Promise<AuditOutboxSnapshot>) => {
            const snapshot = await loadSnapshot();
            if (fail && snapshot.stateRevision > 0) {
              fail = false;
              throw new Error("simulated append interruption");
            }
            return stores.audit.drain(async () => snapshot);
          },
          append: async (event: AuditEvent) => {
            return stores.audit.append(event);
          }
        },
        stages: fixtureRegistry
      },
      { workspaceRoot: path.join(root, "workspaces") }
    );
    const request = { name: "Recovered", idempotencyKey: "recover-project-001" } as const;
    await expect(service.createProject(request)).rejects.toThrow(/simulated append/iu);

    const recovered = new ApplicationService(
      { ...stores, stages: fixtureRegistry },
      { workspaceRoot: path.join(root, "workspaces") }
    );
    await recovered.initialize();
    const result = await recovered.createProject(request);
    expect(result.project.name).toBe("Recovered");
    expect(await recovered.listProjects()).toHaveLength(1);
    const events = await stores.audit.readAndVerify();
    const state = await stores.state.read();
    expect(events).toHaveLength(1);
    expect(events[0]?.event.type).toBe("project.created");
    expect(events[0]?.event).toEqual(state.auditOutbox["1"]);
  });

  it("resumes a reserved command after interruption with its original expectedRevision", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-resume-recovery-"));
    roots.push(root);
    const stores = storesAt(root);
    const setup = new ApplicationService(
      { ...stores, stages: fixtureRegistry },
      { workspaceRoot: path.join(root, "workspaces") }
    );
    const project = await setup.createProject({
      name: "Resume Recovery",
      idempotencyKey: "resume-recovery-create"
    });
    const started = await setup.startDesignRun({
      projectId: project.project.id,
      prompt: validPrompt,
      configuration: {},
      expectedRevision: project.project.revision,
      idempotencyKey: "resume-recovery-start1"
    });
    const requirements = await setup.inspectRequirements({ runId: started.run.id });
    const approved = await setup.approveRequirements(
      {
        runId: started.run.id,
        requirementsDigest: requirements.requirementsDigest,
        actor: reviewer,
        rationale: "Reviewed.",
        scope: "exact requirements document",
        expectedRevision: started.run.revision,
        idempotencyKey: "resume-recovery-approve"
      },
      localHumanContext(reviewer, "requirements_approval")
    );

    let failStageAudit = true;
    const interrupted = new ApplicationService(
      {
        ...stores,
        audit: {
          root: stores.audit.root,
          readAndVerify: () => stores.audit.readAndVerify(),
          drain: async (loadSnapshot: () => Promise<AuditOutboxSnapshot>) => {
            const snapshot = await loadSnapshot();
            const pending = snapshot.outbox[String(snapshot.stateRevision)];
            if (failStageAudit && pending?.type === "stage.started") {
              failStageAudit = false;
              throw new Error("simulated process interruption after stage start");
            }
            return stores.audit.drain(async () => snapshot);
          },
          append: async (event: AuditEvent) => {
            return stores.audit.append(event);
          }
        },
        stages: fixtureRegistry
      },
      { workspaceRoot: path.join(root, "workspaces") }
    );
    const resumeInput = {
      runId: approved.run.id,
      expectedRevision: approved.run.revision,
      idempotencyKey: "resume-recovery-command"
    } as const;
    await expect(interrupted.resumeRun(resumeInput)).rejects.toThrow(/simulated process/iu);

    const recovered = new ApplicationService(
      { ...stores, stages: fixtureRegistry },
      { workspaceRoot: path.join(root, "workspaces") }
    );
    const completed = await recovered.resumeRun(resumeInput);
    expect(completed.run.state).toBe("completed");
    expect(completed.run.attempts.system_architecture.some((attempt) => attempt.state === "interrupted")).toBe(true);
  });

  it("does not duplicate an event when delivery succeeded before acknowledgment was lost", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-audit-ack-recovery-"));
    roots.push(root);
    const stores = storesAt(root);
    let loseAcknowledgment = true;
    const interrupted = new ApplicationService(
      {
        ...stores,
        audit: {
          root: stores.audit.root,
          readAndVerify: () => stores.audit.readAndVerify(),
          append: (event: AuditEvent) => stores.audit.append(event),
          drain: async (loadSnapshot: () => Promise<AuditOutboxSnapshot>) => {
            const events = await stores.audit.drain(loadSnapshot);
            if (loseAcknowledgment && events.length > 0) {
              loseAcknowledgment = false;
              throw new Error("simulated lost audit acknowledgment");
            }
            return events;
          }
        },
        stages: fixtureRegistry
      },
      { workspaceRoot: path.join(root, "workspaces") }
    );
    const request = { name: "Lost acknowledgment", idempotencyKey: "lost-audit-ack-001" } as const;

    await expect(interrupted.createProject(request)).rejects.toThrow(/lost audit acknowledgment/iu);
    const recovered = new ApplicationService(
      { ...storesAt(root), stages: fixtureRegistry },
      { workspaceRoot: path.join(root, "workspaces") }
    );
    const replay = await recovered.createProject(request);

    expect(replay.project.name).toBe(request.name);
    const events = await stores.audit.readAndVerify();
    const state = await stores.state.read();
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toEqual(state.auditOutbox["1"]);
  });

  it("serializes simultaneous initializers over one pending outbox", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-concurrent-recovery-"));
    roots.push(root);
    const stores = storesAt(root);
    await Promise.all([stores.state.initialize(), stores.content.initialize()]);
    const pending: AuditEvent = {
      eventSchemaVersion: EVLEDA_AUDIT_EVENT_SCHEMA_VERSION,
      type: "project.created",
      actorType: "system",
      actorId: "evleda",
      occurredAt: "2026-09-04T00:00:00.000Z",
      payload: { projectId: "project_pending", stateRevision: 1 }
    };
    await stores.state.transaction(0, (state) => {
      state.auditOutbox["1"] = pending;
    });
    const firstStores = storesAt(root);
    const secondStores = storesAt(root);
    const first = new ApplicationService(
      { ...firstStores, stages: fixtureRegistry },
      { workspaceRoot: path.join(root, "workspaces") }
    );
    const second = new ApplicationService(
      { ...secondStores, stages: fixtureRegistry },
      { workspaceRoot: path.join(root, "workspaces") }
    );

    await Promise.all([first.initialize(), second.initialize()]);

    const events = await stores.audit.readAndVerify();
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toEqual(pending);
  });

  it("keeps concurrent committed transitions ordered and exactly bound to the outbox", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-concurrent-audit-delivery-"));
    roots.push(root);
    const firstStores = storesAt(root);
    const secondStores = storesAt(root);
    let initialDrains = 0;
    let openBarrier: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      openBarrier = resolve;
    });
    const gatedAudit = (stores: ReturnType<typeof storesAt>) => {
      let firstDrain = true;
      return {
        root: stores.audit.root,
        append: (event: AuditEvent) => stores.audit.append(event),
        readAndVerify: () => stores.audit.readAndVerify(),
        drain: async (loadSnapshot: () => Promise<AuditOutboxSnapshot>) => {
          const events = await stores.audit.drain(loadSnapshot);
          if (firstDrain) {
            firstDrain = false;
            initialDrains += 1;
            if (initialDrains === 2) openBarrier?.();
            await barrier;
          }
          return events;
        }
      };
    };
    const first = new ApplicationService(
      { ...firstStores, audit: gatedAudit(firstStores), stages: fixtureRegistry },
      { workspaceRoot: path.join(root, "workspaces") }
    );
    const second = new ApplicationService(
      { ...secondStores, audit: gatedAudit(secondStores), stages: fixtureRegistry },
      { workspaceRoot: path.join(root, "workspaces") }
    );

    await Promise.all([
      first.createProject({ name: "Concurrent A", idempotencyKey: "concurrent-audit-a" }),
      second.createProject({ name: "Concurrent B", idempotencyKey: "concurrent-audit-b" })
    ]);

    const state = await firstStores.state.read();
    const events = await firstStores.audit.readAndVerify();
    expect(state.revision).toBe(2);
    expect(events.map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(events.map((entry) => entry.event)).toEqual([
      state.auditOutbox["1"],
      state.auditOutbox["2"]
    ]);
  });

  it("rejects an audit event that claims a revision bound to a different outbox event", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-audit-conflict-"));
    roots.push(root);
    const stores = storesAt(root);
    await Promise.all([stores.state.initialize(), stores.content.initialize()]);
    const expected: AuditEvent = {
      eventSchemaVersion: EVLEDA_AUDIT_EVENT_SCHEMA_VERSION,
      type: "expected.transition",
      actorType: "system",
      actorId: "evleda",
      occurredAt: "2026-09-04T00:00:00.000Z",
      payload: { stateRevision: 1 }
    };
    await stores.state.transaction(0, (state) => {
      state.auditOutbox["1"] = expected;
    });
    await stores.audit.append({ ...expected, type: "wrong.transition" });
    const service = new ApplicationService(
      { ...stores, stages: fixtureRegistry },
      { workspaceRoot: path.join(root, "workspaces") }
    );

    await expect(service.initialize()).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR"
    });
    expect(await stores.audit.readAndVerify()).toHaveLength(1);
  });

  it("initializes an existing v1 state and audit pair with legacy recovery events", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-legacy-audit-compatibility-"));
    roots.push(root);
    const stores = storesAt(root);
    await Promise.all([stores.state.initialize(), stores.content.initialize()]);
    const legacyOutbox: AuditEvent = {
      type: "command.create_project.committed.recovered",
      actorType: "system",
      actorId: "evleda",
      occurredAt: "2026-09-03T00:00:00.000Z",
      payload: { projectId: "legacy", crashRecovered: true, stateRevision: 1 }
    };
    const legacyAudit: AuditEvent = {
      type: "project.created",
      actorType: "system",
      actorId: "evleda",
      occurredAt: "2026-09-03T00:00:01.000Z",
      payload: { projectId: "legacy", stateRevision: 1 }
    };
    await stores.state.transaction(0, (state) => {
      delete state.auditOutboxSchemaVersion;
      state.auditOutbox["1"] = legacyOutbox;
    });
    await stores.audit.append(legacyAudit);
    const service = new ApplicationService(
      { ...stores, stages: fixtureRegistry },
      { workspaceRoot: path.join(root, "workspaces") }
    );

    await expect(service.initialize()).resolves.toBeUndefined();
    expect((await stores.audit.readAndVerify())[0]?.event).toEqual(legacyAudit);
  });

  it("requires migration when a legacy recovery event is paired with an unrelated audit event", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-legacy-audit-mismatch-"));
    roots.push(root);
    const stores = storesAt(root);
    await Promise.all([stores.state.initialize(), stores.content.initialize()]);
    const claimedRecovery: AuditEvent = {
      type: "command.create_project.committed.recovered",
      actorType: "system",
      actorId: "evleda",
      projectId: "legacy",
      occurredAt: "2026-09-03T00:00:00.000Z",
      payload: { projectId: "legacy", crashRecovered: true, stateRevision: 1 }
    };
    await stores.state.transaction(0, (state) => {
      delete state.auditOutboxSchemaVersion;
      state.auditOutbox["1"] = claimedRecovery;
    });
    await stores.audit.append({
      type: "attestation.revoked",
      actorType: "system",
      actorId: "evleda",
      projectId: "legacy",
      occurredAt: "2026-09-03T00:00:01.000Z",
      payload: { approvalId: "approval_unrelated", stateRevision: 1 }
    });
    const service = new ApplicationService(
      { ...stores, stages: fixtureRegistry },
      { workspaceRoot: path.join(root, "workspaces") }
    );

    await expect(service.initialize()).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR",
      message: expect.stringMatching(/explicit migration/iu)
    });
    expect(await stores.audit.readAndVerify()).toHaveLength(1);
  });

  it("serializes audit recovery across distinct operating-system processes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-process-audit-recovery-"));
    roots.push(root);
    const stores = storesAt(root);
    await stores.state.initialize();
    for (let stateRevision = 1; stateRevision <= 3; stateRevision += 1) {
      await stores.state.transaction(stateRevision - 1, (state) => {
        state.auditOutbox[String(stateRevision)] = {
          eventSchemaVersion: EVLEDA_AUDIT_EVENT_SCHEMA_VERSION,
          type: `transition.${stateRevision}`,
          actorType: "system",
          actorId: "evleda",
          occurredAt: `2026-09-04T00:00:0${stateRevision}.000Z`,
          payload: { stateRevision }
        };
      });
    }
    const firstReady = path.join(root, "first.ready");
    const secondReady = path.join(root, "second.ready");
    const startFile = path.join(root, "start.signal");
    const first = runDrainWorker(root, firstReady, startFile);
    const second = runDrainWorker(root, secondReady, startFile);
    await Promise.all([waitForFile(firstReady), waitForFile(secondReady)]);
    await writeFile(startFile, "start\n", "utf8");

    const workers = await Promise.all([first, second]);
    const state = await stores.state.read();
    const events = await stores.audit.readAndVerify();
    expect(new Set(workers.map((worker) => worker.pid)).size).toBe(2);
    expect(workers.map((worker) => worker.events)).toEqual([3, 3]);
    expect(events.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    expect(events.map((entry) => entry.event)).toEqual([
      state.auditOutbox["1"],
      state.auditOutbox["2"],
      state.auditOutbox["3"]
    ]);
  });
});
