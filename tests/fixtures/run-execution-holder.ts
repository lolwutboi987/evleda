import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ApplicationService } from "../../src/application/application-service.js";
import type { StateStorePort } from "../../src/application/ports.js";
import type { EvlEdaState, MutableEvlEdaState } from "../../src/persistence/state-store.js";
import { HashChainAuditLog } from "../../src/persistence/audit-log.js";
import { FileContentStore } from "../../src/persistence/content-store.js";
import { AtomicStateStore } from "../../src/persistence/state-store.js";
import { fixtureRegistry } from "../application/helpers.js";

const [root, runId, expectedRevisionRaw, idempotencyKey, enteredFile, releaseFile] =
  process.argv.slice(2);
if (
  root === undefined ||
  runId === undefined ||
  expectedRevisionRaw === undefined ||
  idempotencyKey === undefined ||
  enteredFile === undefined ||
  releaseFile === undefined
) {
  throw new Error(
    "usage: run-execution-holder <root> <run-id> <expected-revision> <idempotency-key> <entered-file> <release-file>"
  );
}
const expectedRevision = Number(expectedRevisionRaw);
if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
  throw new Error("expected revision must be a nonnegative integer");
}
const dataRoot = root;
const selectedRunId = runId;
const selectedIdempotencyKey = idempotencyKey;
const enteredPath = enteredFile;
const releasePath = releaseFile;

class FirstTransactionFileGate implements StateStorePort {
  public readonly root: string;
  #gated = false;

  public constructor(private readonly base: AtomicStateStore) {
    this.root = base.root;
  }

  public initialize(): Promise<void> {
    return this.base.initialize();
  }

  public read(): Promise<EvlEdaState> {
    return this.base.read();
  }

  public async transaction<Result>(
    expectedStateRevision: number | undefined,
    mutate: (state: MutableEvlEdaState) => Result | Promise<Result>
  ): Promise<{ readonly state: EvlEdaState; readonly result: Result }> {
    if (!this.#gated) {
      this.#gated = true;
      await writeFile(enteredPath, `${process.pid}\n`, "utf8");
      for (;;) {
        try {
          await access(releasePath);
          break;
        } catch {
          await delay(10);
        }
      }
    }
    return this.base.transaction(expectedStateRevision, mutate);
  }
}

const state = new FirstTransactionFileGate(
  new AtomicStateStore(path.join(dataRoot, "state"))
);
const service = new ApplicationService(
  {
    state,
    content: new FileContentStore(path.join(dataRoot, "content")),
    audit: new HashChainAuditLog(path.join(dataRoot, "audit")),
    stages: fixtureRegistry
  },
  { workspaceRoot: path.join(dataRoot, "workspaces") }
);
await service.initialize();
const result = await service.resumeRun({
  runId: selectedRunId,
  expectedRevision,
  idempotencyKey: selectedIdempotencyKey
});
process.stdout.write(`${JSON.stringify({ pid: process.pid, state: result.run.state })}\n`);
