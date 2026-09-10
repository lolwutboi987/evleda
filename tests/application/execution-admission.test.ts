import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ApplicationService } from "../../src/application/application-service.js";
import type { StateStorePort } from "../../src/application/ports.js";
import { localHumanContext } from "../../src/contracts/capabilities.js";
import type { RerunStageInput, ResumeRunInput } from "../../src/contracts/operations.js";
import type { EvlEdaState, MutableEvlEdaState } from "../../src/persistence/state-store.js";
import { HashChainAuditLog } from "../../src/persistence/audit-log.js";
import { FileContentStore } from "../../src/persistence/content-store.js";
import { AtomicStateStore } from "../../src/persistence/state-store.js";
import { fixtureRegistry, reviewer, validPrompt } from "./helpers.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 })
    )
  );
});

class BeforeTransactionGate implements StateStorePort {
  public readonly root: string;
  #remaining = 0;
  #entered: Promise<void> = Promise.resolve();
  #enter: (() => void) | undefined;
  #released: Promise<void> = Promise.resolve();
  #release: (() => void) | undefined;

  public constructor(private readonly base: AtomicStateStore) {
    this.root = base.root;
  }

  public arm(relativeCall: number): void {
    if (!Number.isSafeInteger(relativeCall) || relativeCall < 1) {
      throw new Error("Transaction gate call must be a positive integer");
    }
    this.#remaining = relativeCall;
    this.#entered = new Promise<void>((resolve) => {
      this.#enter = resolve;
    });
    this.#released = new Promise<void>((resolve) => {
      this.#release = resolve;
    });
  }

  public get entered(): Promise<void> {
    return this.#entered;
  }

  public release(): void {
    this.#release?.();
  }

  public initialize(): Promise<void> {
    return this.base.initialize();
  }

  public read(): Promise<EvlEdaState> {
    return this.base.read();
  }

  public async transaction<Result>(
    expectedRevision: number | undefined,
    mutate: (state: MutableEvlEdaState) => Result | Promise<Result>
  ): Promise<{ readonly state: EvlEdaState; readonly result: Result }> {
    if (this.#remaining > 0) {
      this.#remaining -= 1;
      if (this.#remaining === 0) {
        this.#enter?.();
        await this.#released;
      }
    }
    return this.base.transaction(expectedRevision, mutate);
  }
}

const storesAt = (root: string) => ({
  state: new AtomicStateStore(path.join(root, "state")),
  content: new FileContentStore(path.join(root, "content")),
  audit: new HashChainAuditLog(path.join(root, "audit"))
});

const serviceAt = async (
  root: string,
  state: StateStorePort,
  content = new FileContentStore(path.join(root, "content"))
): Promise<ApplicationService> => {
  const service = new ApplicationService(
    {
      state,
      content,
      audit: new HashChainAuditLog(path.join(root, "audit")),
      stages: fixtureRegistry
    },
    { workspaceRoot: path.join(root, "workspaces") }
  );
  await service.initialize();
  return service;
};

const approvedRun = async (service: ApplicationService, suffix: string) => {
  const project = await service.createProject({
    name: `Execution admission ${suffix}`,
    idempotencyKey: `lease-create-${suffix}`
  });
  const started = await service.startDesignRun({
    projectId: project.project.id,
    prompt: validPrompt,
    configuration: {},
    expectedRevision: project.project.revision,
    idempotencyKey: `lease-start-${suffix}`
  });
  const requirements = await service.inspectRequirements({ runId: started.run.id });
  return service.approveRequirements(
    {
      runId: started.run.id,
      requirementsDigest: requirements.requirementsDigest,
      actor: reviewer,
      rationale: "Exercise exclusive execution admission.",
      scope: "exact requirements document",
      expectedRevision: started.run.revision,
      idempotencyKey: `lease-approve-${suffix}`
    },
    localHumanContext(reviewer, "requirements_approval")
  );
};

type ExecutionOperation = "resume_run" | "rerun_stage";
type ExecutionInput = ResumeRunInput | RerunStageInput;

const inputFor = (
  operation: ExecutionOperation,
  runId: string,
  expectedRevision: number,
  key: string
): ExecutionInput =>
  operation === "resume_run"
    ? { runId, expectedRevision, idempotencyKey: key }
    : {
        runId,
        stage: "system_architecture",
        reason: "Exercise exclusive execution admission.",
        expectedRevision,
        idempotencyKey: key
      };

const invoke = (
  service: ApplicationService,
  operation: ExecutionOperation,
  input: ExecutionInput
) =>
  operation === "resume_run"
    ? service.resumeRun(input as ResumeRunInput)
    : service.rerunStage(input as RerunStageInput);

const stateAndAuditBytes = async (root: string) => ({
  state: await readFile(path.join(root, "state", "state.json")),
  audit: await readFile(path.join(root, "audit", "audit.jsonl"))
});

const expectSameBytes = (
  before: Awaited<ReturnType<typeof stateAndAuditBytes>>,
  after: Awaited<ReturnType<typeof stateAndAuditBytes>>
): void => {
  expect(after.state.equals(before.state)).toBe(true);
  expect(after.audit.equals(before.audit)).toBe(true);
};

const pendingExecutionRecords = (state: EvlEdaState, runId: string) =>
  Object.values(state.idempotency).filter((record) => {
    if (record.operation !== "resume_run" && record.operation !== "rerun_stage") return false;
    const result = record.result;
    return typeof result === "object" &&
      result !== null &&
      "status" in result &&
      result.status === "pending" &&
      "runId" in result &&
      result.runId === runId;
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
  throw new Error(`Timed out waiting for child execution lease: ${file}`);
};

const runExecutionHolder = (
  root: string,
  runId: string,
  expectedRevision: number,
  idempotencyKey: string,
  enteredFile: string,
  releaseFile: string
): Promise<{ readonly pid: number; readonly state: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.resolve("node_modules", "tsx", "dist", "cli.mjs"),
        path.resolve("tests", "fixtures", "run-execution-holder.ts"),
        root,
        runId,
        String(expectedRevision),
        idempotencyKey,
        enteredFile,
        releaseFile
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
      reject(new Error(`Run execution holder timed out: ${stderr}`));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Run execution holder exited ${String(code)}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()) as { readonly pid: number; readonly state: string });
      } catch (error) {
        reject(error);
      }
    });
  });

describe("run-scoped execution admission", () => {
  it.each([
    ["resume_run", "resume_run"],
    ["rerun_stage", "rerun_stage"],
    ["resume_run", "rerun_stage"],
    ["rerun_stage", "resume_run"]
  ] as const)(
    "rejects fresh %s / %s contention before reservation with zero durable loser effects",
    async (winnerOperation, loserOperation) => {
      const root = await mkdtemp(path.join(tmpdir(), "evleda-execution-admission-"));
      roots.push(root);
      const winnerBase = new AtomicStateStore(path.join(root, "state"));
      const winnerGate = new BeforeTransactionGate(winnerBase);
      const winner = await serviceAt(root, winnerGate);
      const loser = await serviceAt(root, new AtomicStateStore(path.join(root, "state")));
      const suffix = `${winnerOperation}-${loserOperation}-fresh`;
      const approved = await approvedRun(winner, suffix);
      const runId = approved.run.id;
      const winnerInput = inputFor(
        winnerOperation,
        runId,
        approved.run.revision,
        `lease-winner-${suffix}`
      );
      let winnerPromise: ReturnType<typeof invoke> | undefined;

      winnerGate.arm(1);
      try {
        winnerPromise = invoke(winner, winnerOperation, winnerInput);
        await winnerGate.entered;
        const beforeState = await winnerBase.read();
        const beforeRun = beforeState.runs[runId]!;
        expect(beforeRun.state).toBe("queued");
        expect(pendingExecutionRecords(beforeState, runId)).toHaveLength(0);
        expect(
          Object.values(beforeRun.attempts)
            .flat()
            .some((attempt) => attempt.state === "running" || attempt.state === "pending")
        ).toBe(false);
        const before = await stateAndAuditBytes(root);
        const loserInput = inputFor(
          loserOperation,
          runId,
          beforeRun.revision,
          `lease-loser-${suffix}`
        );

        await expect(invoke(loser, loserOperation, loserInput)).rejects.toMatchObject({
          code: "STAGE_ALREADY_RUNNING",
          details: { runId }
        });
        expectSameBytes(before, await stateAndAuditBytes(root));
      } finally {
        winnerGate.release();
        await winnerPromise;
      }
    },
    60_000
  );

  it.each(["resume_run", "rerun_stage"] as const)(
    "does not let an exact pending %s replay steal a live execution lease",
    async (operation) => {
      const root = await mkdtemp(path.join(tmpdir(), "evleda-execution-replay-admission-"));
      roots.push(root);
      const winnerBase = new AtomicStateStore(path.join(root, "state"));
      const winnerGate = new BeforeTransactionGate(winnerBase);
      const winner = await serviceAt(root, winnerGate);
      const loser = await serviceAt(root, new AtomicStateStore(path.join(root, "state")));
      const approved = await approvedRun(winner, `${operation}-pending`);
      const input = inputFor(
        operation,
        approved.run.id,
        approved.run.revision,
        `lease-pending-${operation}`
      );
      let winnerPromise: ReturnType<typeof invoke> | undefined;

      winnerGate.arm(2);
      try {
        winnerPromise = invoke(winner, operation, input);
        await winnerGate.entered;
        const state = await winnerBase.read();
        expect(pendingExecutionRecords(state, approved.run.id)).toHaveLength(1);
        const before = await stateAndAuditBytes(root);

        await expect(invoke(loser, operation, input)).rejects.toMatchObject({
          code: "STAGE_ALREADY_RUNNING",
          details: { runId: approved.run.id }
        });
        expectSameBytes(before, await stateAndAuditBytes(root));
      } finally {
        winnerGate.release();
        await winnerPromise;
      }
    },
    60_000
  );

  it("rejects a contender while a distinct process holds the same run lease", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-process-run-admission-"));
    roots.push(root);
    const state = new AtomicStateStore(path.join(root, "state"));
    const contender = await serviceAt(root, state);
    const approved = await approvedRun(contender, "process-holder");
    const enteredFile = path.join(root, "holder.entered");
    const releaseFile = path.join(root, "holder.release");
    const holderKey = "lease-process-holder-resume";
    const holder = runExecutionHolder(
      root,
      approved.run.id,
      approved.run.revision,
      holderKey,
      enteredFile,
      releaseFile
    );

    try {
      await waitForFile(enteredFile);
      const childPid = Number((await readFile(enteredFile, "utf8")).trim());
      expect(childPid).not.toBe(process.pid);
      const current = (await state.read()).runs[approved.run.id]!;
      expect(current.state).toBe("queued");
      expect(pendingExecutionRecords(await state.read(), approved.run.id)).toHaveLength(0);
      const before = await stateAndAuditBytes(root);
      const rejected = await contender.resumeRun({
        runId: approved.run.id,
        expectedRevision: current.revision,
        idempotencyKey: "lease-process-contender-resume"
      }).catch((error: unknown) => error);

      expect(rejected).toMatchObject({ code: "STAGE_ALREADY_RUNNING" });
      expect((rejected as { readonly details: unknown }).details).toEqual({
        runId: approved.run.id
      });
      expectSameBytes(before, await stateAndAuditBytes(root));
    } finally {
      await writeFile(releaseFile, "release\n", "utf8");
    }

    await expect(holder).resolves.toMatchObject({ state: "completed" });
  }, 60_000);

  it("allows different runs in different projects to reach reservation concurrently", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-independent-run-admission-"));
    roots.push(root);
    const firstBase = new AtomicStateStore(path.join(root, "state"));
    const secondBase = new AtomicStateStore(path.join(root, "state"));
    const firstGate = new BeforeTransactionGate(firstBase);
    const secondGate = new BeforeTransactionGate(secondBase);
    const first = await serviceAt(root, firstGate);
    const second = await serviceAt(root, secondGate);
    const firstApproved = await approvedRun(first, "independent-a");
    const secondApproved = await approvedRun(second, "independent-b");
    expect(firstApproved.project.id).not.toBe(secondApproved.project.id);
    expect(firstApproved.run.id).not.toBe(secondApproved.run.id);
    expect(path.resolve(firstBase.root)).toBe(path.resolve(secondBase.root));
    const firstInput = inputFor(
      "resume_run",
      firstApproved.run.id,
      firstApproved.run.revision,
      "lease-independent-winner-a"
    );
    const secondInput = inputFor(
      "resume_run",
      secondApproved.run.id,
      secondApproved.run.revision,
      "lease-independent-winner-b"
    );
    let firstPromise: ReturnType<typeof invoke> | undefined;
    let secondPromise: ReturnType<typeof invoke> | undefined;

    firstGate.arm(1);
    secondGate.arm(1);
    try {
      firstPromise = invoke(first, "resume_run", firstInput);
      await firstGate.entered;
      secondPromise = invoke(second, "resume_run", secondInput);
      const secondOutcome = await Promise.race([
        secondGate.entered.then(() => "entered" as const),
        secondPromise.then(
          () => "settled" as const,
          () => "settled" as const
        )
      ]);
      expect(secondOutcome).toBe("entered");
    } finally {
      firstGate.release();
      secondGate.release();
      await Promise.all([firstPromise, secondPromise]);
    }
  }, 60_000);
});
