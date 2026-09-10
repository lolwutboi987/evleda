import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DurabilityBarrierObservation } from "../../src/persistence/durability.js";
import {
  AtomicStateStore,
  EVLEDA_STATE_SCHEMA_VERSION,
  LEGACY_EVLEDA_STATE_SCHEMA_VERSION,
  LEGACY_EVLEDA_STATE_V2_SCHEMA_VERSION,
  LEGACY_EVLEDA_STATE_V3_SCHEMA_VERSION,
  isCommittedStateTransactionError,
  type CommittedStateTransactionFailure,
  type StateStoreCommitPhase
} from "../../src/persistence/state-store.js";

const temporaryRoots: string[] = [];

const makeStore = async (): Promise<AtomicStateStore> => {
  const root = await mkdtemp(path.join(tmpdir(), "evleda-state-"));
  temporaryRoots.push(root);
  const store = new AtomicStateStore(root);
  await store.initialize();
  return store;
};

const crashWorkerAt = async (
  root: string,
  phase: StateStoreCommitPhase,
  readyFile: string
): Promise<void> => {
  const child = spawn(
    process.execPath,
    [
      path.resolve("node_modules", "tsx", "dist", "cli.mjs"),
      path.resolve("tests", "fixtures", "state-store-crash-worker.ts"),
      root,
      phase,
      readyFile
    ],
    { cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "ignore", "pipe"] }
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await access(readyFile);
      break;
    } catch {
      if (child.exitCode !== null) {
        throw new Error(`Crash worker exited before ${phase}: ${stderr}`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
  await access(readyFile).catch(() => {
    throw new Error(`Timed out waiting for crash worker at ${phase}: ${stderr}`);
  });
  child.kill();
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AtomicStateStore", () => {
  it.each(["replacement", "directory_sync", "temporary_cleanup", "lock_release"] as const)(
    "classifies a %s phase failure against the commit linearization point",
    async (phase) => {
      let armed: StateStoreCommitPhase | undefined;
      const root = await mkdtemp(path.join(tmpdir(), `evleda-state-${phase}-`));
      temporaryRoots.push(root);
      const store = new AtomicStateStore(root, {
        phaseHook: (current) => {
          if (armed !== current) return;
          armed = undefined;
          throw new Error(`simulated ${current} failure`);
        }
      });
      await store.initialize();
      armed = phase;

      const transaction = store.transaction(0, (state) => {
        state.projects.project_phase = {
          id: "project_phase",
          name: "Phase fault",
          root: "project_phase",
          policyVersion: "evleda.policy.v1",
          runIds: [],
          createdAt: "2026-09-03T00:00:00.000Z",
          updatedAt: "2026-09-03T00:00:00.000Z",
          revision: 0
        };
        return "phase-result";
      });

      if (phase === "replacement") {
        expect(isCommittedStateTransactionError(await transaction.catch((error: unknown) => error)))
          .toBe(false);
        expect((await store.read()).revision).toBe(0);
        expect((await store.read()).projects.project_phase).toBeUndefined();
        return;
      }

      const failure = await transaction.catch((error: unknown) => error);
      expect(isCommittedStateTransactionError(failure)).toBe(true);
      const committed = failure as CommittedStateTransactionFailure<string>;
      expect(committed.transactionOutcome).toBe("committed_repair_required");
      expect(committed.maintenancePhases).toEqual([phase]);
      expect(committed.committed.result).toBe("phase-result");
      expect(committed.committed.state.revision).toBe(1);
      expect((await store.read()).projects.project_phase?.name).toBe("Phase fault");
      await committed.repairMaintenance();
      expect(committed.maintenanceRepairStatus).toBe("succeeded");
      const next = await store.transaction(1, () => "after-repair");
      expect(next.result).toBe("after-repair");
      expect(next.state.revision).toBe(2);
    }
  );

  it.each(["replacement", "directory_sync", "temporary_cleanup", "lock_release"] as const)(
    "recovers the exact atomic state after its owner process dies at %s",
    async (phase) => {
      const root = await mkdtemp(path.join(tmpdir(), `evleda-state-crash-${phase}-`));
      temporaryRoots.push(root);
      const initialStore = new AtomicStateStore(root);
      await initialStore.initialize();
      const readyFile = path.join(root, `${phase}.ready`);

      await crashWorkerAt(root, phase, readyFile);

      const recoveredStore = new AtomicStateStore(root);
      await recoveredStore.initialize();
      const recovered = await recoveredStore.read();
      const committed = phase !== "replacement";
      expect(recovered.revision).toBe(committed ? 1 : 0);
      expect(recovered.projects.project_crash !== undefined).toBe(committed);
      expect(JSON.parse(await readFile(path.join(root, "state.json"), "utf8"))).toEqual(recovered);
      const debris = (await readdir(root)).filter((name) =>
        name === "state.lock" ||
        name === "state-maintenance.lock" ||
        name === "state-maintenance.json" ||
        /^\.state-.*\.tmp$/u.test(name)
      );
      expect(debris).toEqual([]);
      const continued = await recoveredStore.transaction(recovered.revision, () => "continued");
      expect(continued.state.revision).toBe(recovered.revision + 1);
    }
  );

  it("does not launder an authentic committed failure through an uncommitted outer mutation", async () => {
    let armed = false;
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "evleda-state-authentic-source-"));
    const outerRoot = await mkdtemp(path.join(tmpdir(), "evleda-state-authentic-outer-"));
    temporaryRoots.push(sourceRoot, outerRoot);
    const source = new AtomicStateStore(sourceRoot, {
      phaseHook: (phase) => {
        if (armed && phase === "lock_release") {
          armed = false;
          throw new Error("source committed failure");
        }
      }
    });
    const outer = new AtomicStateStore(outerRoot);
    await Promise.all([source.initialize(), outer.initialize()]);
    armed = true;
    const authentic = await source.transaction(0, () => "source").catch((error: unknown) => error);
    expect(isCommittedStateTransactionError(authentic)).toBe(true);

    const laundering = await outer.transaction(0, () => {
      throw authentic;
    }).catch((error: unknown) => error);
    expect(isCommittedStateTransactionError(laundering)).toBe(false);
    expect(laundering).toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR",
      details: { transactionOutcome: "definitely_not_committed" }
    });
    expect((await outer.read()).revision).toBe(0);
    await (authentic as CommittedStateTransactionFailure).repairMaintenance();
  });

  it("treats a stale repair closure as superseded without touching a newer transaction journal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-state-stale-repair-"));
    temporaryRoots.push(root);
    let failOldDirectorySync = false;
    const oldStore = new AtomicStateStore(root, {
      phaseHook: (phase) => {
        if (failOldDirectorySync && phase === "directory_sync") {
          failOldDirectorySync = false;
          throw new Error("old directory sync debt");
        }
      }
    });
    await oldStore.initialize();
    failOldDirectorySync = true;
    const oldFailure = await oldStore.transaction(0, (state) => {
      state.projects.project_old_repair = {
        id: "project_old_repair",
        name: "Old repair",
        root: "project_old_repair",
        policyVersion: "evleda.policy.v1",
        runIds: [],
        createdAt: "2026-09-03T00:00:00.000Z",
        updatedAt: "2026-09-03T00:00:00.000Z",
        revision: 0
      };
    }).catch((error: unknown) => error) as CommittedStateTransactionFailure;
    expect(isCommittedStateTransactionError(oldFailure)).toBe(true);

    await new AtomicStateStore(root).initialize();
    let entered!: () => void;
    let resume!: () => void;
    const atDirectorySync = new Promise<void>((resolve) => { entered = resolve; });
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    let pauseNew = true;
    const newerStore = new AtomicStateStore(root, {
      phaseHook: async (phase) => {
        if (!pauseNew || phase !== "directory_sync") return;
        pauseNew = false;
        entered();
        await resumed;
      }
    });
    const newerTransaction = newerStore.transaction(1, (state) => {
      state.projects.project_newer_repair = {
        id: "project_newer_repair",
        name: "Newer repair",
        root: "project_newer_repair",
        policyVersion: "evleda.policy.v1",
        runIds: [],
        createdAt: "2026-09-03T00:00:01.000Z",
        updatedAt: "2026-09-03T00:00:01.000Z",
        revision: 0
      };
    });
    await atDirectorySync;
    const maintenanceFile = path.join(root, "state-maintenance.json");
    const newerJournal = await readFile(maintenanceFile, "utf8");

    await oldFailure.repairMaintenance();
    expect(oldFailure.maintenanceRepairStatus).toBe("succeeded");
    expect(await readFile(maintenanceFile, "utf8")).toBe(newerJournal);

    resume();
    await newerTransaction;
    const current = await newerStore.read();
    expect(current.revision).toBe(2);
    expect(current.projects.project_old_repair).toBeDefined();
    expect(current.projects.project_newer_repair).toBeDefined();
  });

  it("treats a stale repair closure as superseded after its journal was already recovered", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-state-absent-repair-"));
    temporaryRoots.push(root);
    let failDirectorySync = false;
    const store = new AtomicStateStore(root, {
      phaseHook: (phase) => {
        if (failDirectorySync && phase === "directory_sync") {
          failDirectorySync = false;
          throw new Error("old directory sync debt");
        }
      }
    });
    await store.initialize();
    failDirectorySync = true;
    const failure = await store.transaction(0, (state) => {
      state.projects.project_absent_repair = {
        id: "project_absent_repair",
        name: "Absent repair",
        root: "project_absent_repair",
        policyVersion: "evleda.policy.v1",
        runIds: [],
        createdAt: "2026-09-03T00:00:00.000Z",
        updatedAt: "2026-09-03T00:00:00.000Z",
        revision: 0
      };
    }).catch((error: unknown) => error) as CommittedStateTransactionFailure;
    expect(isCommittedStateTransactionError(failure)).toBe(true);

    await new AtomicStateStore(root).initialize();
    await expect(access(path.join(root, "state-maintenance.json"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await failure.repairMaintenance();
    expect(failure.maintenanceRepairStatus).toBe("succeeded");
    expect((await store.read()).projects.project_absent_repair).toBeDefined();
  });

  it("fails closed when a repair-required journal no longer matches committed state bytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-state-repair-mismatch-"));
    temporaryRoots.push(root);
    let failDirectorySync = false;
    const store = new AtomicStateStore(root, {
      phaseHook: (phase) => {
        if (failDirectorySync && phase === "directory_sync") {
          throw new Error("persistent directory sync failure");
        }
      }
    });
    await store.initialize();
    const stateFile = path.join(root, "state.json");
    const previousBytes = await readFile(stateFile);
    failDirectorySync = true;
    const failure = await store.transaction(0, (state) => {
      state.projects.project_repair_mismatch = {
        id: "project_repair_mismatch",
        name: "Repair mismatch",
        root: "project_repair_mismatch",
        policyVersion: "evleda.policy.v1",
        runIds: [],
        createdAt: "2026-09-03T00:00:00.000Z",
        updatedAt: "2026-09-03T00:00:00.000Z",
        revision: 0
      };
    }).catch((error: unknown) => error);
    expect(isCommittedStateTransactionError(failure)).toBe(true);
    await writeFile(stateFile, previousBytes);

    await expect(new AtomicStateStore(root).initialize()).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR",
      message: expect.stringContaining("no longer matches")
    });
    await expect(access(path.join(root, "state-maintenance.json"))).resolves.toBeUndefined();
  });

  it.each(["replacement", "directory_sync"] as const)(
    "exposes only the atomic old/new state while an active prepared journal pauses at %s",
    async (phase) => {
      const root = await mkdtemp(path.join(tmpdir(), `evleda-state-visible-${phase}-`));
      temporaryRoots.push(root);
      let enter!: () => void;
      let resume!: () => void;
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const resumed = new Promise<void>((resolve) => { resume = resolve; });
      let armed = false;
      const writer = new AtomicStateStore(root, {
        phaseHook: async (current) => {
          if (!armed || current !== phase) return;
          armed = false;
          enter();
          await resumed;
        }
      });
      const reader = new AtomicStateStore(root);
      await writer.initialize();
      armed = true;
      const transaction = writer.transaction(0, (state) => {
        state.projects.project_visible = {
          id: "project_visible",
          name: "Visible",
          root: "project_visible",
          policyVersion: "evleda.policy.v1",
          runIds: [],
          createdAt: "2026-09-03T00:00:00.000Z",
          updatedAt: "2026-09-03T00:00:00.000Z",
          revision: 0
        };
      });
      await entered;

      const visible = await reader.read();
      expect(visible.revision).toBe(phase === "replacement" ? 0 : 1);
      expect(visible.projects.project_visible !== undefined).toBe(phase === "directory_sync");
      resume();
      await transaction;
      expect((await reader.read()).revision).toBe(1);
    }
  );

  it("initializes before acquiring the transaction lease on a fresh store", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-fresh-state-"));
    temporaryRoots.push(root);
    const store = new AtomicStateStore(root);

    const committed = await store.transaction(0, () => "fresh");

    expect(committed.result).toBe("fresh");
    expect(committed.state.revision).toBe(1);
  }, 2_000);

  it("reads an existing current state with zero durability barriers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-state-read-barriers-"));
    temporaryRoots.push(root);
    const barriers: DurabilityBarrierObservation[] = [];
    const store = new AtomicStateStore(root, {
      durabilityObserver: (barrier) => barriers.push(barrier)
    });
    await store.initialize();
    barriers.length = 0;

    const first = await store.read();
    const second = await store.read();

    expect(first).toEqual(second);
    expect(barriers).toEqual([]);
    expect((await readdir(root)).filter((name) => name.includes("maintenance.lock"))).toEqual([]);
  });

  it("holds one maintenance lease from prepare through replace and journal clear", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-state-one-maintenance-lock-"));
    temporaryRoots.push(root);
    const barriers: DurabilityBarrierObservation[] = [];
    const observedPhases: StateStoreCommitPhase[] = [];
    const maintenanceLock = path.join(root, "state-maintenance.lock");
    const maintenanceJournal = path.join(root, "state-maintenance.json");
    let armed = false;
    const store = new AtomicStateStore(root, {
      durabilityObserver: (barrier) => barriers.push(barrier),
      phaseHook: async (phase) => {
        if (!armed) return;
        observedPhases.push(phase);
        await expect(access(maintenanceLock)).resolves.toBeUndefined();
        const journal = JSON.parse(await readFile(maintenanceJournal, "utf8")) as {
          readonly status?: unknown;
        };
        expect(journal.status).toBe("prepared");
      }
    });
    await store.initialize();
    barriers.length = 0;
    armed = true;

    await store.transaction(0, () => "committed");

    expect(observedPhases).toEqual([
      "replacement",
      "directory_sync",
      "temporary_cleanup",
      "lock_release"
    ]);
    expect(barriers.map(({ kind }) => kind)).toEqual([
      "file_sync",
      "directory_sync",
      "file_sync",
      "directory_sync",
      "directory_sync"
    ]);
    expect(barriers.some(({ target }) => target.includes(".lock.claim-"))).toBe(false);
    await expect(access(maintenanceLock)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(maintenanceJournal)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("commits atomically and increments a global revision", async () => {
    const store = await makeStore();
    const initial = await store.read();
    const committed = await store.transaction(initial.revision, (state) => {
      state.projects.project_1 = {
        id: "project_1",
        name: "Written",
        root: "project_1",
        policyVersion: "evleda.policy.v1",
        runIds: [],
        createdAt: "2026-09-03T00:00:00.000Z",
        updatedAt: "2026-09-03T00:00:00.000Z",
        revision: 0
      };
      return "ok";
    });

    expect(committed.result).toBe("ok");
    expect(committed.state.revision).toBe(1);
    expect((await store.read()).projects.project_1?.name).toBe("Written");
  });

  it("rejects stale writers without committing", async () => {
    const store = await makeStore();
    await store.transaction(0, (state) => {
      state.projects.first = {
        id: "first",
        name: "First",
        root: "first",
        policyVersion: "evleda.policy.v1",
        runIds: [],
        createdAt: "2026-09-03T00:00:00.000Z",
        updatedAt: "2026-09-03T00:00:00.000Z",
        revision: 0
      };
    });

    await expect(
      store.transaction(0, (state) => {
        state.projects.stale = {
          id: "stale",
          name: "Stale",
          root: "stale",
          policyVersion: "evleda.policy.v1",
          runIds: [],
          createdAt: "2026-09-03T00:00:00.000Z",
          updatedAt: "2026-09-03T00:00:00.000Z",
          revision: 0
        };
      })
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(Object.keys((await store.read()).projects)).toEqual(["first"]);
  });

  it("serializes independent store instances through a cross-process-compatible lease", async () => {
    const first = await makeStore();
    const second = new AtomicStateStore(first.root);
    const project = (id: string) => ({
      id,
      name: id,
      root: id,
      policyVersion: "evleda.policy.v1",
      runIds: [] as readonly string[],
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z",
      revision: 0
    });

    await Promise.all([
      first.transaction(undefined, (state) => {
        state.projects.project_a = project("project_a");
      }),
      second.transaction(undefined, (state) => {
        state.projects.project_b = project("project_b");
      })
    ]);

    const state = await first.read();
    expect(Object.keys(state.projects).sort()).toEqual(["project_a", "project_b"]);
    expect(state.revision).toBe(2);
  });

  it("removes its temporary state file when canonical serialization fails", async () => {
    const store = await makeStore();

    await expect(
      store.transaction(0, (state) => {
        (state.idempotency as unknown as Record<string, unknown>).invalidValue = 1n;
      })
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    expect((await readdir(store.root)).filter((name) => name.startsWith(".state-"))).toEqual([]);
    expect((await store.read()).revision).toBe(0);
  });

  it("migrates empty-invocation v1/v2/v3 envelopes and rejects unsafe or unknown schemas", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-state-schema-"));
    temporaryRoots.push(root);
    const stateFile = path.join(root, "state.json");
    const legacyState = {
      schemaVersion: LEGACY_EVLEDA_STATE_SCHEMA_VERSION,
      revision: 0,
      projects: {},
      runs: {},
      revisions: {},
      artifacts: {},
      evidence: {},
      approvals: {},
      invocations: {},
      idempotency: {},
      auditOutbox: {}
    };
    await writeFile(stateFile, `${JSON.stringify(legacyState)}\n`, "utf8");
    const store = new AtomicStateStore(root);

    await expect(store.read()).resolves.toMatchObject({
      schemaVersion: EVLEDA_STATE_SCHEMA_VERSION,
      revision: 0
    });

    await writeFile(stateFile, `${JSON.stringify({
      ...legacyState,
      schemaVersion: LEGACY_EVLEDA_STATE_V2_SCHEMA_VERSION
    })}\n`, "utf8");
    await expect(store.read()).resolves.toMatchObject({
      schemaVersion: EVLEDA_STATE_SCHEMA_VERSION,
      revision: 0,
      invocations: {}
    });

    await writeFile(stateFile, `${JSON.stringify({
      ...legacyState,
      schemaVersion: LEGACY_EVLEDA_STATE_V2_SCHEMA_VERSION,
      invocations: { old_v2: { schemaVersion: "evleda.tool-invocation-record.v2" } }
    })}\n`, "utf8");
    await expect(store.read()).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR",
      message: expect.stringContaining("cannot be migrated"),
      details: { actualSchemaVersion: LEGACY_EVLEDA_STATE_V2_SCHEMA_VERSION }
    });

    await writeFile(stateFile, `${JSON.stringify({
      ...legacyState,
      schemaVersion: LEGACY_EVLEDA_STATE_V3_SCHEMA_VERSION
    })}\n`, "utf8");
    await expect(store.read()).resolves.toMatchObject({
      schemaVersion: EVLEDA_STATE_SCHEMA_VERSION,
      invocations: {}
    });
    await writeFile(stateFile, `${JSON.stringify({
      ...legacyState,
      schemaVersion: LEGACY_EVLEDA_STATE_V3_SCHEMA_VERSION,
      invocations: { old_v3: { schemaVersion: "evleda.tool-invocation-record.v3" } }
    })}\n`, "utf8");
    await expect(store.read()).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR",
      message: expect.stringContaining("cannot be migrated"),
      details: { actualSchemaVersion: LEGACY_EVLEDA_STATE_V3_SCHEMA_VERSION }
    });

    await writeFile(stateFile, `${JSON.stringify({ ...legacyState, schemaVersion: "evleda.state.v5" })}\n`, "utf8");
    await expect(store.read()).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR",
      details: {
        supportedSchemaVersions: [
          EVLEDA_STATE_SCHEMA_VERSION,
          LEGACY_EVLEDA_STATE_V3_SCHEMA_VERSION,
          LEGACY_EVLEDA_STATE_V2_SCHEMA_VERSION,
          LEGACY_EVLEDA_STATE_SCHEMA_VERSION
        ]
      }
    });

    await writeFile(stateFile, `${JSON.stringify({ ...legacyState, invocations: {
      legacy: { id: "legacy", outcome: "success" }
    } })}\n`, "utf8");
    await expect(store.read()).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR",
      message: expect.stringContaining("cannot be migrated")
    });

    await writeFile(stateFile, `${JSON.stringify({ ...legacyState, invocations: [] })}\n`, "utf8");
    await expect(store.read()).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR",
      message: expect.stringContaining("legacy invocations map")
    });

    await writeFile(stateFile, `${JSON.stringify({
      ...legacyState,
      schemaVersion: EVLEDA_STATE_SCHEMA_VERSION,
      revision: -1
    })}\n`, "utf8");
    await expect(store.read()).rejects.toMatchObject({ code: "ARTIFACT_INTEGRITY_ERROR" });
  });

  it("rejects duplicate persisted JSON members at every depth before legacy migration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-state-duplicate-json-"));
    temporaryRoots.push(root);
    const stateFile = path.join(root, "state.json");
    const legacy = JSON.stringify({
      schemaVersion: LEGACY_EVLEDA_STATE_SCHEMA_VERSION,
      revision: 0,
      projects: {},
      runs: {},
      revisions: {},
      artifacts: {},
      evidence: {},
      approvals: {},
      invocations: {},
      idempotency: {},
      auditOutbox: {}
    });
    const hostile = [
      legacy.replace(
        '"invocations":{}',
        '"invocations":{"discarded":{"outcome":"success"}},"invocations":{}'
      ),
      legacy.replace(
        '"invocations":{}',
        '"invocations":{"discarded":{"outcome":"success"}},"invocatio\\u006es":{}'
      ),
      legacy.replace(
        '"idempotency":{}',
        '"idempotency":{"nested":{"member":1,"memb\\u0065r":2}}'
      )
    ];
    const store = new AtomicStateStore(root);

    for (const raw of hostile) {
      await writeFile(stateFile, `${raw}\n`, "utf8");
      await expect(store.read()).rejects.toMatchObject({
        code: "ARTIFACT_INTEGRITY_ERROR",
        message: expect.stringContaining("duplicate JSON object member")
      });
    }
  });

  it("rejects state-version relabeling and unknown root fields before replacement", async () => {
    const store = await makeStore();

    await expect(store.transaction(0, (state) => {
      (state as unknown as { schemaVersion: string }).schemaVersion = "evleda.state.v999";
    })).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR",
      message: expect.stringContaining("invalid v4 envelope")
    });
    await expect(store.transaction(0, (state) => {
      (state as unknown as { schemaVersion: string }).schemaVersion =
        LEGACY_EVLEDA_STATE_SCHEMA_VERSION;
      (state.invocations as unknown as Record<string, unknown>).discarded = { outcome: "success" };
    })).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR",
      message: expect.stringContaining("invalid v4 envelope")
    });
    await expect(store.transaction(0, (state) => {
      (state as unknown as Record<string, unknown>).undeclared = true;
    })).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR",
      message: expect.stringContaining("invalid v4 envelope")
    });

    const retained = await store.read();
    expect(retained.schemaVersion).toBe(EVLEDA_STATE_SCHEMA_VERSION);
    expect(retained.revision).toBe(0);
    expect(retained.invocations).toEqual({});
  });
});
