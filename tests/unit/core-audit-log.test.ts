import { spawn } from "node:child_process";
import { access, appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalIdentity, canonicalJson } from "../../src/core/canonical.js";
import type { DurabilityBarrierObservation } from "../../src/persistence/durability.js";
import type { AuditEvent } from "../../src/persistence/audit-log.js";
import {
  EVLEDA_AUDIT_EVENT_SCHEMA_VERSION,
  EVLEDA_AUDIT_ENVELOPE_SCHEMA_VERSION,
  EVLEDA_AUDIT_OUTBOX_SCHEMA_VERSION,
  HashChainAuditLog
} from "../../src/persistence/audit-log.js";

const roots: string[] = [];

const makeLog = async (): Promise<HashChainAuditLog> => {
  const root = await mkdtemp(path.join(tmpdir(), "evleda-audit-"));
  roots.push(root);
  return new HashChainAuditLog(root);
};

const crashAuditWorkerAt = async (
  root: string,
  phase: "file_sync" | "directory_sync",
  readyFile: string
): Promise<void> => {
  const child = spawn(
    process.execPath,
    [
      path.resolve("node_modules", "tsx", "dist", "cli.mjs"),
      path.resolve("tests", "fixtures", "audit-log-crash-worker.ts"),
      root,
      phase,
      readyFile
    ],
    { cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "ignore", "pipe"] }
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    try {
      await access(readyFile);
      break;
    } catch {
      if (child.exitCode !== null) {
        throw new Error(`Audit crash worker exited before ${phase}: ${stderr}`);
      }
      await delay(5);
    }
  }
  const ownerPid = Number((await readFile(readyFile, "utf8")).trim());
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) {
    throw new Error(`Audit crash worker did not publish a valid PID at ${phase}`);
  }
  process.kill(ownerPid);
  await exited;
};

const event = (
  stateRevision: number,
  type = `state.${stateRevision}`,
  payload: Readonly<Record<string, unknown>> = {}
): AuditEvent => ({
  eventSchemaVersion: EVLEDA_AUDIT_EVENT_SCHEMA_VERSION,
  type,
  actorType: "system",
  actorId: "evleda",
  occurredAt: `2026-09-03T00:00:0${stateRevision}.000Z`,
  payload: { ...payload, stateRevision }
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("HashChainAuditLog", () => {
  it("appends a verifiable ordered hash chain", async () => {
    const log = await makeLog();
    const first = await log.append({
      type: "project.created",
      actorType: "human",
      actorId: "operator",
      occurredAt: "2026-09-03T00:00:00.000Z",
      payload: { projectId: "project_1", stateRevision: 1 }
    });
    const second = await log.append({
      type: "run.started",
      actorType: "system",
      actorId: "evleda",
      occurredAt: "2026-09-03T00:00:01.000Z",
      payload: { runId: "run_1", stateRevision: 2 }
    });

    expect(second.previousDigest).toBe(first.digest);
    await expect(log.readAndVerify()).resolves.toHaveLength(2);
  });

  it("detects mutation of a prior event", async () => {
    const log = await makeLog();
    await log.append({
      type: "project.created",
      actorType: "human",
      actorId: "operator",
      occurredAt: "2026-09-03T00:00:00.000Z",
      payload: { projectId: "project_1", stateRevision: 1 }
    });
    const file = path.join(log.root, "audit.jsonl");
    const raw = await readFile(file, "utf8");
    await writeFile(file, raw.replace("project_1", "project_X"), "utf8");

    await expect(log.readAndVerify()).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR"
    });
  });

  it("rejects a truncated final record", async () => {
    const log = await makeLog();
    await log.append({
      type: "project.created",
      actorType: "human",
      actorId: "operator",
      occurredAt: "2026-09-03T00:00:00.000Z",
      payload: { stateRevision: 1 }
    });
    const file = path.join(log.root, "audit.jsonl");
    const raw = await readFile(file, "utf8");
    await writeFile(file, raw.slice(0, -1), "utf8");

    await expect(log.readAndVerify()).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR"
    });
  });

  it("makes canonically identical state-revision appends idempotent across instances", async () => {
    const log = await makeLog();
    const other = new HashChainAuditLog(log.root);
    const first = event(1, "project.created", { alpha: 1, beta: 2 });
    const reordered: AuditEvent = {
      eventSchemaVersion: EVLEDA_AUDIT_EVENT_SCHEMA_VERSION,
      payload: { stateRevision: 1, beta: 2, alpha: 1 },
      occurredAt: first.occurredAt,
      actorId: first.actorId,
      actorType: first.actorType,
      type: first.type
    };

    const [left, right] = await Promise.all([log.append(first), other.append(reordered)]);

    expect(right.digest).toBe(left.digest);
    expect(await log.readAndVerify()).toHaveLength(1);
  });

  it("rejects a conflicting event for an existing state revision without changing bytes", async () => {
    const log = await makeLog();
    await log.append(event(1, "project.created"));
    const file = path.join(log.root, "audit.jsonl");
    const before = await readFile(file, "utf8");

    await expect(log.append(event(1, "project.deleted"))).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR"
    });
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("rejects missing and out-of-order state revisions", async () => {
    const log = await makeLog();
    await expect(log.append(event(2))).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR"
    });
    await log.append(event(1));
    await expect(log.append(event(3))).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR"
    });
    expect(await log.readAndVerify()).toHaveLength(1);
  });

  it("returns an older exact revision without rewriting a later chain", async () => {
    const log = await makeLog();
    const first = await log.append(event(1));
    await log.append(event(2));
    const file = path.join(log.root, "audit.jsonl");
    const before = await readFile(file, "utf8");

    const replay = await log.append(event(1));

    expect(replay.digest).toBe(first.digest);
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("serializes concurrent drains and appends the exact outbox suffix once", async () => {
    const log = await makeLog();
    const other = new HashChainAuditLog(log.root);
    const outbox = { "1": event(1), "2": event(2) };
    const snapshot = async () => ({
      stateRevision: 2,
      outboxSchemaVersion: EVLEDA_AUDIT_OUTBOX_SCHEMA_VERSION,
      outbox
    });

    await Promise.all([log.drain(snapshot), other.drain(snapshot)]);

    const envelopes = await log.readAndVerify();
    expect(envelopes.map((entry) => entry.event.payload)).toEqual([
      outbox["1"].payload,
      outbox["2"].payload
    ]);
  });

  it("uses zero durability barriers only for an empty current chain", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-audit-empty-barriers-"));
    roots.push(root);
    const barriers: DurabilityBarrierObservation[] = [];
    const log = new HashChainAuditLog(root, {
      durabilityObserver: (barrier) => barriers.push(barrier)
    });

    const current = await log.drain(async () => ({ stateRevision: 0, outbox: {} }));

    expect(current).toEqual([]);
    expect(barriers).toEqual([]);
    await expect(access(path.join(root, "audit.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("re-syncs a nonempty current chain before acknowledging outbox replay", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-audit-current-barriers-"));
    roots.push(root);
    const barriers: DurabilityBarrierObservation[] = [];
    const log = new HashChainAuditLog(root, {
      durabilityObserver: (barrier) => barriers.push(barrier)
    });
    const outbox = { "1": event(1), "2": event(2) };
    const snapshot = async () => ({
      stateRevision: 2,
      outboxSchemaVersion: EVLEDA_AUDIT_OUTBOX_SCHEMA_VERSION,
      outbox
    });
    await log.drain(snapshot);
    const file = path.join(root, "audit.jsonl");
    const before = await readFile(file);
    barriers.length = 0;

    const current = await log.drain(snapshot);

    expect(current).toHaveLength(2);
    expect(barriers.map(({ kind }) => kind)).toEqual(["file_sync", "directory_sync"]);
    expect(await readFile(file)).toEqual(before);
  });

  it("re-syncs an exact same-event append without changing its identity or bytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-audit-idempotent-sync-"));
    roots.push(root);
    const firstLog = new HashChainAuditLog(root);
    const first = await firstLog.append(event(1));
    const file = path.join(root, "audit.jsonl");
    const before = await readFile(file);
    const barriers: DurabilityBarrierObservation[] = [];
    const restarted = new HashChainAuditLog(root, {
      durabilityObserver: (barrier) => barriers.push(barrier)
    });

    const replay = await restarted.append(event(1));

    expect(replay).toEqual(first);
    expect(await readFile(file)).toEqual(before);
    expect(barriers.map(({ kind }) => kind)).toEqual(["file_sync", "directory_sync"]);
  });

  it.each(["file_sync", "directory_sync"] as const)(
    "re-syncs an exact outbox event in a fresh process after its writer dies at %s",
    async (phase) => {
      const root = await mkdtemp(path.join(tmpdir(), `evleda-audit-crash-${phase}-`));
      roots.push(root);
      const readyFile = path.join(root, `${phase}.ready`);
      await crashAuditWorkerAt(root, phase, readyFile);
      const file = path.join(root, "audit.jsonl");
      const before = await readFile(file);
      const barriers: DurabilityBarrierObservation[] = [];
      const restarted = new HashChainAuditLog(root, {
        durabilityObserver: (barrier) => barriers.push(barrier)
      });
      const pending = event(1);

      const recovered = await restarted.drain(async () => ({
        stateRevision: 1,
        outboxSchemaVersion: EVLEDA_AUDIT_OUTBOX_SCHEMA_VERSION,
        outbox: { "1": pending }
      }));

      expect(recovered).toHaveLength(1);
      expect(recovered[0]!.event).toEqual(pending);
      expect(await readFile(file)).toEqual(before);
      expect(barriers.map(({ kind }) => kind)).toEqual(["file_sync", "directory_sync"]);
    }
  );

  it("uses only the lock and append barriers when draining a missing suffix", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-audit-append-barriers-"));
    roots.push(root);
    const barriers: DurabilityBarrierObservation[] = [];
    const log = new HashChainAuditLog(root, {
      durabilityObserver: (barrier) => barriers.push(barrier)
    });
    const outbox = { "1": event(1), "2": event(2) };

    const drained = await log.drain(async () => ({
      stateRevision: 2,
      outboxSchemaVersion: EVLEDA_AUDIT_OUTBOX_SCHEMA_VERSION,
      outbox
    }));

    expect(drained).toHaveLength(2);
    expect(barriers.map(({ kind }) => kind)).toEqual([
      "file_sync",
      "directory_sync",
      "file_sync",
      "directory_sync"
    ]);
    expect(barriers.some(({ target }) => target.includes(".lock.claim-"))).toBe(false);
  });

  it("does not accept an already-written event until its concurrent writer finishes durability", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-audit-writer-race-"));
    roots.push(root);
    let enter!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    let armed = true;
    const writer = new HashChainAuditLog(root, {
      phaseHook: async (phase) => {
        if (!armed || phase !== "file_sync") return;
        armed = false;
        enter();
        await resumed;
      }
    });
    const reader = new HashChainAuditLog(root);
    const pending = event(1);
    const append = writer.append(pending);
    await entered;
    let settled = false;
    const drain = reader.drain(async () => ({
      stateRevision: 1,
      outboxSchemaVersion: EVLEDA_AUDIT_OUTBOX_SCHEMA_VERSION,
      outbox: { "1": pending }
    })).finally(() => { settled = true; });

    await delay(25);
    expect(settled).toBe(false);
    resume();
    const [written, drained] = await Promise.all([append, drain]);

    expect(drained).toEqual([written]);
    expect(await reader.readAndVerify()).toEqual([written]);
  });

  it("fails closed when audit and outbox bind different events or audit is ahead", async () => {
    const log = await makeLog();
    await log.append(event(1, "wrong.transition"));
    const file = path.join(log.root, "audit.jsonl");
    const before = await readFile(file, "utf8");

    await expect(
      log.drain(async () => ({
        stateRevision: 1,
        outbox: { "1": event(1, "expected.transition") }
      }))
    ).rejects.toMatchObject({ code: "ARTIFACT_INTEGRITY_ERROR" });
    await expect(
      log.drain(async () => ({ stateRevision: 0, outbox: {} }))
    ).rejects.toMatchObject({ code: "ARTIFACT_INTEGRITY_ERROR" });
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("rejects missing, extra, and mis-keyed outbox revisions before appending", async () => {
    const log = await makeLog();

    await expect(
      log.drain(async () => ({ stateRevision: 2, outbox: { "1": event(1) } }))
    ).rejects.toMatchObject({ code: "ARTIFACT_INTEGRITY_ERROR" });
    await expect(
      log.drain(async () => ({
        stateRevision: 1,
        outbox: { "1": event(1), "2": event(2) }
      }))
    ).rejects.toMatchObject({ code: "ARTIFACT_INTEGRITY_ERROR" });
    await expect(
      log.drain(async () => ({ stateRevision: 1, outbox: { "1": event(2) } }))
    ).rejects.toMatchObject({ code: "ARTIFACT_INTEGRITY_ERROR" });
    await expect(log.readAndVerify()).resolves.toEqual([]);
  });

  it("recovers only a byte-prefix partial tail backed by the exact durable outbox event", async () => {
    const log = await makeLog();
    const first = await log.append(event(1));
    const secondEvent = event(2);
    const unsigned = {
      schemaVersion: EVLEDA_AUDIT_ENVELOPE_SCHEMA_VERSION,
      sequence: 2,
      previousDigest: first.digest,
      event: secondEvent
    } as const;
    const secondEnvelope = {
      ...unsigned,
      digest: canonicalIdentity(unsigned, "evleda.audit-envelope.v1").digest
    };
    const secondLine = Buffer.from(`${canonicalJson(secondEnvelope)}\n`, "utf8");
    const file = path.join(log.root, "audit.jsonl");
    await appendFile(file, secondLine.subarray(0, Math.floor(secondLine.length / 2)));

    await expect(log.readAndVerify()).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR"
    });
    await log.drain(async () => ({
      stateRevision: 2,
      outboxSchemaVersion: EVLEDA_AUDIT_OUTBOX_SCHEMA_VERSION,
      outbox: { "1": event(1), "2": secondEvent }
    }));

    const repaired = await log.readAndVerify();
    expect(repaired).toHaveLength(2);
    expect(repaired[1]).toEqual(secondEnvelope);
  });

  it("does not discard a partial tail that differs from the durable event", async () => {
    const log = await makeLog();
    await log.append(event(1));
    const file = path.join(log.root, "audit.jsonl");
    await appendFile(file, "{\"not\":\"the durable envelope", "utf8");
    const before = await readFile(file);

    await expect(
      log.drain(async () => ({
        stateRevision: 2,
        outboxSchemaVersion: EVLEDA_AUDIT_OUTBOX_SCHEMA_VERSION,
        outbox: { "1": event(1), "2": event(2) }
      }))
    ).rejects.toMatchObject({ code: "ARTIFACT_INTEGRITY_ERROR" });
    expect(await readFile(file)).toEqual(before);
  });

  it("explicitly accepts known v1 business events paired with semantically equivalent recovery events", async () => {
    const log = await makeLog();
    const audited: AuditEvent = {
      type: "project.created",
      actorType: "system",
      actorId: "evleda",
      occurredAt: "2026-09-03T00:00:01.000Z",
      payload: { projectId: "legacy", stateRevision: 1 }
    };
    const legacyOutbox: AuditEvent = {
      type: "command.create_project.committed.recovered",
      actorType: "system",
      actorId: "evleda",
      occurredAt: "2026-09-03T00:00:00.000Z",
      payload: { projectId: "legacy", crashRecovered: true, stateRevision: 1 }
    };
    const existing = await log.append(audited);
    const auditedStage: AuditEvent = {
      type: "stage.started",
      actorType: "system",
      actorId: "evleda",
      projectId: "legacy",
      runId: "run_legacy",
      subjectDigest: "input_digest",
      occurredAt: "2026-09-03T00:00:03.000Z",
      payload: { stage: "schematic", attemptId: "attempt_1", stateRevision: 2 }
    };
    const legacyStageOutbox: AuditEvent = {
      type: "stage.started.recovered",
      actorType: "system",
      actorId: "evleda",
      projectId: "legacy",
      runId: "run_legacy",
      subjectDigest: "input_digest",
      occurredAt: "2026-09-03T00:00:02.000Z",
      payload: { crashRecovered: true, stateRevision: 2 }
    };
    const existingStage = await log.append(auditedStage);

    const repaired = await log.drain(async () => ({
      stateRevision: 2,
      outbox: { "1": legacyOutbox, "2": legacyStageOutbox }
    }));

    expect(repaired).toHaveLength(2);
    expect(repaired[0]?.digest).toBe(existing.digest);
    expect(repaired[0]?.event).toEqual(audited);
    expect(repaired[1]?.digest).toBe(existingStage.digest);
    expect(repaired[1]?.event).toEqual(auditedStage);
  });

  it("rejects an unrelated same-revision legacy event and requires explicit migration", async () => {
    const log = await makeLog();
    const unrelated: AuditEvent = {
      type: "attestation.revoked",
      actorType: "system",
      actorId: "evleda",
      projectId: "legacy",
      occurredAt: "2026-09-03T00:00:01.000Z",
      payload: { approvalId: "approval_unrelated", stateRevision: 1 }
    };
    const claimedRecovery: AuditEvent = {
      type: "command.create_project.committed.recovered",
      actorType: "system",
      actorId: "evleda",
      projectId: "legacy",
      occurredAt: "2026-09-03T00:00:00.000Z",
      payload: { projectId: "legacy", crashRecovered: true, stateRevision: 1 }
    };
    await log.append(unrelated);
    const file = path.join(log.root, "audit.jsonl");
    const before = await readFile(file);

    await expect(
      log.drain(async () => ({ stateRevision: 1, outbox: { "1": claimedRecovery } }))
    ).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR",
      message: expect.stringMatching(/explicit migration/iu)
    });
    expect(await readFile(file)).toEqual(before);
  });

  it.each([
    ["actor", { actorId: "different-actor" }],
    ["project", { projectId: "different-project" }],
    ["payload", { payload: { projectId: "different-project", stateRevision: 1 } }]
  ] as const)("rejects a known legacy type pair when its %s binding differs", async (_name, change) => {
    const log = await makeLog();
    const audited: AuditEvent = {
      type: "project.created",
      actorType: "system",
      actorId: "evleda",
      projectId: "legacy",
      occurredAt: "2026-09-03T00:00:01.000Z",
      payload: { projectId: "legacy", stateRevision: 1 },
      ...change
    };
    const recovered: AuditEvent = {
      type: "command.create_project.committed.recovered",
      actorType: "system",
      actorId: "evleda",
      projectId: "legacy",
      occurredAt: "2026-09-03T00:00:00.000Z",
      payload: { projectId: "legacy", crashRecovered: true, stateRevision: 1 }
    };
    await log.append(audited);

    await expect(
      log.drain(async () => ({ stateRevision: 1, outbox: { "1": recovered } }))
    ).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR",
      message: expect.stringMatching(/explicit migration/iu)
    });
  });
});
