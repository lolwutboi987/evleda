import { writeFile } from "node:fs/promises";
import {
  AtomicStateStore,
  type StateStoreCommitPhase
} from "../../src/persistence/state-store.js";

const [root, phaseValue, readyFile] = process.argv.slice(2);
if (root === undefined || phaseValue === undefined || readyFile === undefined) {
  throw new Error("state-store-crash-worker requires root, phase, and ready-file arguments");
}
if (![
  "replacement",
  "directory_sync",
  "temporary_cleanup",
  "lock_release"
].includes(phaseValue)) {
  throw new Error(`Unsupported crash phase: ${phaseValue}`);
}
const phase = phaseValue as StateStoreCommitPhase;
let paused = false;
const never = new Promise<void>(() => undefined);
const store = new AtomicStateStore(root, {
  phaseHook: async (current) => {
    if (paused || current !== phase) return;
    paused = true;
    await writeFile(readyFile, `${process.pid}\n`, "utf8");
    await never;
  }
});

await store.transaction(0, (state) => {
  state.projects.project_crash = {
    id: "project_crash",
    name: "Crash boundary",
    root: "project_crash",
    policyVersion: "evleda.policy.v1",
    runIds: [],
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
    revision: 0
  };
});
