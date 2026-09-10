import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  ApplicationService,
  ApplicationServiceClosedError,
  ApplicationServiceIdleTimeoutError
} from "../../src/application/application-service.js";
import type {
  AuditLogPort,
  ContentStorePort,
  StateStorePort
} from "../../src/application/ports.js";
import { localHumanContext } from "../../src/contracts/capabilities.js";
import { contentIdentity } from "../../src/core/canonical.js";
import type { ContentIdentity } from "../../src/domain/types.js";
import {
  EVLEDA_AUDIT_OUTBOX_SCHEMA_VERSION,
  HashChainAuditLog,
  type AuditEnvelope,
  type AuditEvent,
  type AuditOutboxSnapshot
} from "../../src/persistence/audit-log.js";
import { FileContentStore } from "../../src/persistence/content-store.js";
import {
  AtomicStateStore,
  EVLEDA_STATE_SCHEMA_VERSION,
  type CommittedStateTransaction,
  type EvlEdaState,
  type MutableEvlEdaState
} from "../../src/persistence/state-store.js";
import {
  createCompletedRun,
  disposeApplicationRoots,
  disposeApplicationRootsWithin,
  fixtureRegistry,
  makeApplication,
  physicalEvidenceInput,
  qualifier
} from "./helpers.js";

const roots: string[] = [];
const services: ApplicationService[] = [];

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

const emptyState = (): EvlEdaState => ({
  schemaVersion: EVLEDA_STATE_SCHEMA_VERSION,
  revision: 0,
  projects: {},
  runs: {},
  revisions: {},
  artifacts: {},
  evidence: {},
  approvals: {},
  invocations: {},
  idempotency: {},
  auditOutboxSchemaVersion: EVLEDA_AUDIT_OUTBOX_SCHEMA_VERSION,
  auditOutbox: {}
});

class InstrumentedStateStore implements StateStorePort {
  public initializeCalls = 0;
  public readCalls = 0;
  public readonly root: string;
  public initializeGate: Promise<void> | undefined;
  public readGate: Promise<void> | undefined;
  public readEntered: (() => void) | undefined;
  #state = emptyState();

  public constructor(root: string) {
    this.root = root;
  }

  public async initialize(): Promise<void> {
    this.initializeCalls += 1;
    await this.initializeGate;
  }

  public async read(): Promise<EvlEdaState> {
    this.readCalls += 1;
    this.readEntered?.();
    await this.readGate;
    return structuredClone(this.#state);
  }

  public async transaction<Result>(
    _expectedRevision: number | undefined,
    mutate: (state: MutableEvlEdaState) => Result | Promise<Result>
  ): Promise<CommittedStateTransaction<Result>> {
    const state = structuredClone(this.#state) as MutableEvlEdaState;
    const result = await mutate(state);
    state.revision += 1;
    this.#state = state;
    return { state: structuredClone(this.#state), result };
  }
}

class InstrumentedContentStore implements ContentStorePort {
  public initializeCalls = 0;
  public initializeGate: Promise<void> | undefined;
  public failInitializeCalls = 0;
  public readonly root: string;
  readonly #content = new Map<string, Buffer>();

  public constructor(root: string) {
    this.root = root;
  }

  public async initialize(): Promise<void> {
    this.initializeCalls += 1;
    await this.initializeGate;
    if (this.failInitializeCalls > 0) {
      this.failInitializeCalls -= 1;
      throw new Error("injected content initialization failure");
    }
  }

  public async put(
    bytes: Uint8Array | string,
    expected?: ContentIdentity
  ): Promise<ContentIdentity> {
    const payload = typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes);
    const identity = contentIdentity(payload);
    if (expected !== undefined && expected.digest !== identity.digest) {
      throw new Error("unexpected fixture content identity");
    }
    this.#content.set(identity.digest, payload);
    return identity;
  }

  public putJson(value: unknown): Promise<ContentIdentity> {
    return this.put(JSON.stringify(value));
  }

  public async get(identity: ContentIdentity): Promise<Buffer> {
    const bytes = this.#content.get(identity.digest);
    if (bytes === undefined) throw new Error("fixture content is missing");
    return Buffer.from(bytes);
  }

  public async verify(identity: ContentIdentity): Promise<boolean> {
    return this.#content.has(identity.digest);
  }
}

class InstrumentedAuditLog implements AuditLogPort {
  public drainCalls = 0;
  public readonly root: string;
  public afterNextSnapshot: (() => void) | undefined;
  public nextReturnGate: Promise<void> | undefined;

  public constructor(root: string) {
    this.root = root;
  }

  public async append(_event: AuditEvent): Promise<AuditEnvelope> {
    throw new Error("append is not used by this fixture");
  }

  public async drain(
    loadSnapshot: () => Promise<AuditOutboxSnapshot>
  ): Promise<readonly AuditEnvelope[]> {
    this.drainCalls += 1;
    await loadSnapshot();
    const afterSnapshot = this.afterNextSnapshot;
    const returnGate = this.nextReturnGate;
    this.afterNextSnapshot = undefined;
    this.nextReturnGate = undefined;
    afterSnapshot?.();
    await returnGate;
    return [];
  }

  public async readAndVerify(): Promise<readonly AuditEnvelope[]> {
    return [];
  }
}

const instrumentedService = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "evleda-service-lifecycle-"));
  roots.push(root);
  const state = new InstrumentedStateStore(path.join(root, "state"));
  const content = new InstrumentedContentStore(path.join(root, "content"));
  const audit = new InstrumentedAuditLog(path.join(root, "audit"));
  const service = new ApplicationService(
    { state, content, audit, stages: fixtureRegistry },
    { workspaceRoot: path.join(root, "workspaces") }
  );
  services.push(service);
  return { root, state, content, audit, service };
};

afterEach(async () => {
  const pendingServices = services.splice(0);
  const pendingRoots = roots.splice(0);
  const closeResults = await Promise.allSettled(
    pendingServices.map((service) => service.close({ timeoutMs: 5_000 }))
  );
  const closeFailures = closeResults.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );
  if (closeFailures.length > 0) {
    services.push(...pendingServices);
    roots.push(...pendingRoots);
    throw new AggregateError(closeFailures, "Lifecycle fixture services did not become idle");
  }
  const removalResults = await Promise.allSettled(
    pendingRoots.map((root) => rm(root, { recursive: true, force: true }))
  );
  const removalFailures = removalResults.flatMap((result, index) => {
    if (result.status === "fulfilled") return [];
    roots.push(pendingRoots[index]!);
    return [result.reason];
  });
  if (removalFailures.length > 0) {
    throw new AggregateError(removalFailures, "Lifecycle fixture roots were not removed");
  }
  await disposeApplicationRoots();
});

describe("ApplicationService lifecycle", () => {
  it("single-flights structural initialization and skips only same-call audit drains", async () => {
    const { state, content, audit, service } = await instrumentedService();
    const stateGate = deferred();
    const contentGate = deferred();
    state.initializeGate = stateGate.promise;
    content.initializeGate = contentGate.promise;

    const initializations = Array.from({ length: 24 }, () => service.initialize());
    await delay(0);
    expect(state.initializeCalls).toBe(1);
    expect(content.initializeCalls).toBe(1);
    stateGate.resolve();
    contentGate.resolve();
    await Promise.all(initializations);

    expect(audit.drainCalls).toBe(24);
    await Promise.all(Array.from({ length: 24 }, () => service.listProjects()));
    expect(state.initializeCalls).toBe(1);
    expect(content.initializeCalls).toBe(1);
    expect(audit.drainCalls).toBe(48);

    const beforeExport = audit.drainCalls;
    await expect(service.exportCandidateBundle({
      revisionId: "revision_missing",
      expectedRevision: 0,
      idempotencyKey: "missing-export-for-audit-count"
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // exportCandidateBundle has two explicit reconciliation boundaries before any
    // mutation, but the unchanged state/outbox identity proves the second is duplicate.
    expect(audit.drainCalls).toBe(beforeExport + 1);
  });

  it("settles every initializer before exposing failure and retries as one new flight", async () => {
    const { state, content, audit, service } = await instrumentedService();
    const gate = deferred();
    content.initializeGate = gate.promise;
    content.failInitializeCalls = 1;

    const first = Array.from({ length: 8 }, () => service.initialize());
    await delay(0);
    expect(state.initializeCalls).toBe(1);
    expect(content.initializeCalls).toBe(1);
    gate.resolve();
    const failures = await Promise.allSettled(first);
    expect(failures.every((result) => result.status === "rejected")).toBe(true);
    expect(audit.drainCalls).toBe(0);

    content.initializeGate = undefined;
    await Promise.all(Array.from({ length: 8 }, () => service.initialize()));
    expect(state.initializeCalls).toBe(2);
    expect(content.initializeCalls).toBe(2);
    expect(audit.drainCalls).toBe(8);
  });

  it("reconciles again and observes a revision committed by another service", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-service-external-change-"));
    roots.push(root);
    const observerState = new AtomicStateStore(path.join(root, "state"));
    const observerContent = new FileContentStore(path.join(root, "content"));
    const observerAuditBase = new HashChainAuditLog(path.join(root, "audit"));
    let observerDrainCalls = 0;
    const observerAudit: AuditLogPort = {
      root: observerAuditBase.root,
      append: (event) => observerAuditBase.append(event),
      readAndVerify: () => observerAuditBase.readAndVerify(),
      drain: async (loadSnapshot) => {
        observerDrainCalls += 1;
        return observerAuditBase.drain(loadSnapshot);
      }
    };
    const observer = new ApplicationService(
      {
        state: observerState,
        content: observerContent,
        audit: observerAudit,
        stages: fixtureRegistry
      },
      { workspaceRoot: path.join(root, "observer-workspaces") }
    );
    const writer = new ApplicationService(
      {
        state: new AtomicStateStore(path.join(root, "state")),
        content: new FileContentStore(path.join(root, "content")),
        audit: new HashChainAuditLog(path.join(root, "audit")),
        stages: fixtureRegistry
      },
      { workspaceRoot: path.join(root, "writer-workspaces") }
    );
    services.push(observer, writer);

    await Promise.all([observer.initialize(), writer.initialize()]);
    expect(await observer.listProjects()).toEqual([]);
    const unchangedDrainCalls = observerDrainCalls;
    const created = await writer.createProject({
      name: "External writer",
      idempotencyKey: "external-service-writer"
    });

    expect((await observer.listProjects()).map((project) => project.id)).toEqual([
      created.project.id
    ]);
    expect(observerDrainCalls).toBe(unchangedDrainCalls + 1);
  });

  it("revalidates actual audit bytes on a new call when durable state is unchanged", async () => {
    let auditRoot = "";
    const service = await makeApplication(fixtureRegistry, undefined, {
      decorateAudit: (audit) => {
        auditRoot = audit.root;
        return audit;
      }
    });
    await service.createProject({
      name: "Audit tamper fixture",
      idempotencyKey: "audit-tamper-fixture"
    });
    const auditPath = path.join(auditRoot, "audit.jsonl");
    const lines = (await readFile(auditPath, "utf8")).trimEnd().split("\n");
    const envelope = JSON.parse(lines[0]!) as { digest: string };
    envelope.digest = `${envelope.digest.startsWith("0") ? "1" : "0"}${envelope.digest.slice(1)}`;
    lines[0] = JSON.stringify(envelope);
    await writeFile(auditPath, `${lines.join("\n")}\n`, "utf8");

    await expect(service.listProjects()).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR"
    });
  });

  it("gives a detached inherited callback a fresh audit admission scope", async () => {
    let auditRoot = "";
    let service!: ApplicationService;
    let armDetached = false;
    let detached!: Promise<readonly unknown[]>;
    const triggerDetached = deferred();
    service = await makeApplication(fixtureRegistry, undefined, {
      decorateState: (base) => ({
        root: base.root,
        initialize: () => base.initialize(),
        read: async () => {
          const state = await base.read();
          if (armDetached) {
            armDetached = false;
            detached = (async () => {
              await triggerDetached.promise;
              return service.listProjects();
            })();
          }
          return state;
        },
        transaction: (expectedRevision, mutate) => base.transaction(expectedRevision, mutate)
      }),
      decorateAudit: (audit) => {
        auditRoot = audit.root;
        return audit;
      }
    });
    await service.createProject({
      name: "Detached audit fixture",
      idempotencyKey: "detached-audit-fixture"
    });
    armDetached = true;
    await service.listProjects();

    const auditPath = path.join(auditRoot, "audit.jsonl");
    const lines = (await readFile(auditPath, "utf8")).trimEnd().split("\n");
    const envelope = JSON.parse(lines[0]!) as { digest: string };
    envelope.digest = `${envelope.digest.startsWith("0") ? "1" : "0"}${envelope.digest.slice(1)}`;
    lines[0] = JSON.stringify(envelope);
    await writeFile(auditPath, `${lines.join("\n")}\n`, "utf8");
    triggerDetached.resolve();

    await expect(detached).rejects.toMatchObject({ code: "ARTIFACT_INTEGRITY_ERROR" });
  });

  it("repeats the owning audit flight when state advances after its drain snapshot", async () => {
    const { state, audit, service } = await instrumentedService();
    const snapshotLoaded = deferred();
    const returnGate = deferred();
    audit.afterNextSnapshot = snapshotLoaded.resolve;
    audit.nextReturnGate = returnGate.promise;
    const initialization = service.initialize();
    await snapshotLoaded.promise;
    await state.transaction(0, (mutable) => {
      mutable.auditOutbox["1"] = {
        eventSchemaVersion: "evleda.audit-state-transition.v2",
        type: "external.transition",
        actorType: "system",
        actorId: "external-process",
        occurredAt: "2026-09-07T00:00:00.000Z",
        payload: { stateRevision: 1 }
      };
    });
    returnGate.resolve();

    await initialization;
    expect(audit.drainCalls).toBe(2);
    // The second post-drain snapshot is the state consumed by the public call; there is
    // no unaudited fourth business read after reconciliation returns.
    expect(state.readCalls).toBe(5);
  });

  it("rejects timer-overflow bounds without fencing an otherwise open service", async () => {
    const { service } = await instrumentedService();
    await service.initialize();
    await expect(service.whenIdle({ timeoutMs: Number.MAX_SAFE_INTEGER })).rejects.toBeInstanceOf(
      RangeError
    );
    await expect(service.close({ timeoutMs: Number.MAX_SAFE_INTEGER })).rejects.toBeInstanceOf(
      RangeError
    );
    await expect(service.listProjects()).resolves.toEqual([]);
  });

  it.each(["timeout", "abort"] as const)(
    "keeps the service fenced after a %s close wait and permits a safe retry",
    async (mode) => {
      const { root, state, service } = await instrumentedService();
      await service.initialize();
      const readGate = deferred();
      const readEntered = deferred();
      state.readGate = readGate.promise;
      state.readEntered = readEntered.resolve;
      const operation = service.listProjects();
      await readEntered.promise;

      if (mode === "timeout") {
        await expect(service.close({ timeoutMs: 10 })).rejects.toBeInstanceOf(
          ApplicationServiceIdleTimeoutError
        );
      } else {
        const controller = new AbortController();
        const closing = service.close({ timeoutMs: 1_000, signal: controller.signal });
        controller.abort(new Error("cancel teardown wait"));
        await expect(closing).rejects.toThrow("cancel teardown wait");
      }
      await expect(service.listProjects()).rejects.toBeInstanceOf(
        ApplicationServiceClosedError
      );
      await expect(access(root)).resolves.toBeUndefined();

      readGate.resolve();
      await operation;
      await service.close({ timeoutMs: 1_000 });
      await rm(root, { recursive: true, force: true });
      await delay(25);
      await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it("shared teardown waits for an abandoned mutation before removing its root", async () => {
    const readGate = deferred();
    const readEntered = deferred();
    let armed = false;
    const service = await makeApplication(fixtureRegistry, undefined, {
      decorateState: (base) => ({
        root: base.root,
        initialize: () => base.initialize(),
        read: async () => {
          if (armed) {
            readEntered.resolve();
            await readGate.promise;
          }
          return base.read();
        },
        transaction: (expectedRevision, mutate) => base.transaction(expectedRevision, mutate)
      })
    });
    armed = true;
    const mutation = service.createProject({
      name: "Teardown race",
      idempotencyKey: "teardown-race-project"
    });
    await readEntered.promise;
    const disposal = disposeApplicationRoots();
    let disposed = false;
    void disposal.then(() => {
      disposed = true;
    });
    await delay(25);
    expect(disposed).toBe(false);
    readGate.resolve();
    await mutation;
    await disposal;
    await expect(service.listProjects()).rejects.toBeInstanceOf(
      ApplicationServiceClosedError
    );
  });

  it("serializes new fixture registration against ancestor teardown", async () => {
    const parentRoot = await mkdtemp(path.join(tmpdir(), "evleda-registration-parent-"));
    const lateRoot = path.join(parentRoot, "late-service");
    const readGate = deferred();
    const readEntered = deferred();
    let armed = false;
    const first = await makeApplication(fixtureRegistry, undefined, {
      dataRoot: parentRoot,
      decorateState: (base) => ({
        root: base.root,
        initialize: () => base.initialize(),
        read: async () => {
          if (armed) {
            readEntered.resolve();
            await readGate.promise;
          }
          return base.read();
        },
        transaction: (expectedRevision, mutate) => base.transaction(expectedRevision, mutate)
      })
    });
    armed = true;
    const mutation = first.createProject({
      name: "Registration teardown race",
      idempotencyKey: "registration-teardown-race"
    });
    await readEntered.promise;
    const disposal = disposeApplicationRoots();
    const lateApplication = makeApplication(fixtureRegistry, undefined, { dataRoot: lateRoot });
    await delay(25);
    await expect(access(lateRoot)).rejects.toMatchObject({ code: "ENOENT" });

    readGate.resolve();
    await mutation;
    await disposal;
    const late = await lateApplication;
    await expect(late.listProjects()).resolves.toEqual([]);
    await expect(access(lateRoot)).resolves.toBeUndefined();
    await disposeApplicationRoots();
    await expect(access(lateRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await rm(parentRoot, { recursive: true, force: true });
  });

  it("refuses to register the broad system temporary root for recursive cleanup", async () => {
    await expect(makeApplication(fixtureRegistry, undefined, { dataRoot: tmpdir() })).rejects.toThrow(
      "strict descendants of the system temporary directory"
    );
    await expect(access(tmpdir())).resolves.toBeUndefined();
  });

  it.runIf(process.platform === "win32")(
    "retains aliased nested dot-name roots and their ancestor until close can be retried",
    async () => {
    const parentRoot = await mkdtemp(path.join(tmpdir(), "evleda-overlap-parent-"));
    const childRoot = path.join(parentRoot, "..evidence");
    await mkdir(childRoot);
    const aliasBase = await mkdtemp(path.join(tmpdir(), "evleda-overlap-alias-"));
    roots.push(aliasBase);
    const childAlias = path.join(aliasBase, "child-junction");
    await symlink(childRoot, childAlias, "junction");
    await makeApplication(fixtureRegistry, undefined, { dataRoot: parentRoot });
    const readGate = deferred();
    const readEntered = deferred();
    let armed = false;
    const child = await makeApplication(fixtureRegistry, undefined, {
      dataRoot: childAlias,
      decorateState: (base) => ({
        root: base.root,
        initialize: () => base.initialize(),
        read: async () => {
          if (armed) {
            readEntered.resolve();
            await readGate.promise;
          }
          return base.read();
        },
        transaction: (expectedRevision, mutate) => base.transaction(expectedRevision, mutate)
      })
    });
    armed = true;
    const mutation = child.createProject({
      name: "Nested teardown race",
      idempotencyKey: "nested-teardown-race"
    });
    await readEntered.promise;

    await expect(disposeApplicationRootsWithin(10)).rejects.toBeInstanceOf(AggregateError);
    await expect(access(parentRoot)).resolves.toBeUndefined();
    await expect(access(childRoot)).resolves.toBeUndefined();
    readGate.resolve();
    await mutation;
    await disposeApplicationRoots();
    await expect(access(parentRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(childRoot)).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it("persists the immutable physical-evidence CAS batch concurrently with stable replay", async () => {
    let armed = false;
    let expectedWrites = 0;
    let putCalls = 0;
    let activePuts = 0;
    let peakPuts = 0;
    let settledPuts = 0;
    let failFirstWrite = true;
    let verificationMode: "throw" | "false" | "pass" = "throw";
    let verificationCalls = 0;
    let settledVerifications = 0;
    const allEntered = deferred();
    const releaseWrites = deferred();
    const allVerificationsEntered = deferred();
    const releaseVerifications = deferred();
    const service = await makeApplication(fixtureRegistry, undefined, {
      decorateContent: (base) => ({
        root: base.root,
        initialize: () => base.initialize(),
        put: (bytes, expected) => {
          if (!armed) return base.put(bytes, expected);
          putCalls += 1;
          const callNumber = putCalls;
          activePuts += 1;
          peakPuts = Math.max(peakPuts, activePuts);
          if (putCalls === expectedWrites) allEntered.resolve();
          if (failFirstWrite && callNumber === 2) {
            activePuts -= 1;
            settledPuts += 1;
            throw new Error("injected synchronous parallel CAS write failure");
          }
          return (async () => {
            await releaseWrites.promise;
            try {
              return await base.put(bytes, expected);
            } finally {
              activePuts -= 1;
              settledPuts += 1;
            }
          })();
        },
        putJson: (value) => base.putJson(value),
        get: (identity) => base.get(identity),
        verify: (identity) => {
          if (!armed) return base.verify(identity);
          verificationCalls += 1;
          const callNumber = verificationCalls;
          if (verificationCalls === expectedWrites) allVerificationsEntered.resolve();
          if (verificationMode === "throw" && callNumber === 2) {
            settledVerifications += 1;
            throw new Error("injected synchronous content verification failure");
          }
          return (async () => {
            if (verificationMode === "throw") await releaseVerifications.promise;
            try {
              const verified = await base.verify(identity);
              return verificationMode === "false" ? false : verified;
            } finally {
              settledVerifications += 1;
            }
          })();
        }
      })
    });
    const completed = await createCompletedRun(service);
    const input = await physicalEvidenceInput(
      service,
      completed.run.id,
      completed.headRevision!.id,
      completed.run.revision,
      "parallel-physical-cas",
      "PARALLEL-CAS-001"
    );
    expectedWrites = input.sourceBlobs.length + 2;
    armed = true;
    const failedSubmission = service.submitExternalEvidence(
      input,
      localHumanContext(qualifier, "hardware_qualification")
    );
    const enteredConcurrently = await Promise.race([
      allEntered.promise.then(() => true),
      delay(1_000).then(() => false)
    ]);
    releaseWrites.resolve();
    expect(enteredConcurrently).toBe(true);
    await expect(failedSubmission).rejects.toThrow(
      "injected synchronous parallel CAS write failure"
    );
    expect(settledPuts).toBe(expectedWrites);

    failFirstWrite = false;
    peakPuts = 0;
    const synchronousVerificationFailure = service.submitExternalEvidence(
      input,
      localHumanContext(qualifier, "hardware_qualification")
    );
    const verificationsEnteredConcurrently = await Promise.race([
      allVerificationsEntered.promise.then(() => true),
      delay(1_000).then(() => false)
    ]);
    releaseVerifications.resolve();
    expect(verificationsEnteredConcurrently).toBe(true);
    await expect(synchronousVerificationFailure).rejects.toThrow(
      "injected synchronous content verification failure"
    );
    expect(settledVerifications).toBe(expectedWrites);

    verificationMode = "false";
    const falseVerification = service.submitExternalEvidence(
      input,
      localHumanContext(qualifier, "hardware_qualification")
    );
    await expect(falseVerification).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR"
    });
    expect(putCalls).toBe(expectedWrites * 3);
    expect(settledPuts).toBe(expectedWrites * 3);
    expect((await service.getRunStatus({ runId: completed.run.id })).run.revision).toBe(
      completed.run.revision
    );

    verificationMode = "pass";
    peakPuts = 0;
    const submission = service.submitExternalEvidence(
      input,
      localHumanContext(qualifier, "hardware_qualification")
    );
    const first = await submission;

    expect(putCalls).toBe(expectedWrites * 4);
    expect(peakPuts).toBe(expectedWrites);
    expect(settledPuts).toBe(expectedWrites * 4);
    const replay = await service.submitExternalEvidence(
      input,
      localHumanContext(qualifier, "hardware_qualification")
    );
    expect(replay).toEqual(first);
    expect(putCalls).toBe(expectedWrites * 4);
  });
});
