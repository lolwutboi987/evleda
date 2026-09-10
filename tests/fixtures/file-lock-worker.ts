import { access, readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { acquireExclusiveFileLock } from "../../src/persistence/file-lock.js";

const [lockPath, readyFile, startFile, resultFile, workerId] = process.argv.slice(2);
if (
  lockPath === undefined ||
  readyFile === undefined ||
  startFile === undefined ||
  resultFile === undefined ||
  workerId === undefined
) {
  throw new Error("file-lock-worker requires lock, ready, start, result, and worker-id arguments");
}

await writeFile(readyFile, `${process.pid}\n`, "utf8");
for (let attempt = 0; attempt < 1_000; attempt += 1) {
  try {
    await access(startFile);
    break;
  } catch {
    await delay(5);
  }
}
await access(startFile);
const release = await acquireExclusiveFileLock(lockPath, {
  timeoutMs: 10_000,
  retryDelayMs: 2
});
const enteredAt = Date.now();
const observedOwnerBytes = (await readFile(lockPath)).byteLength;
await delay(100);
const exitedAt = Date.now();
await release();
await writeFile(resultFile, `${JSON.stringify({
  workerId,
  pid: process.pid,
  enteredAt,
  exitedAt,
  observedOwnerBytes
})}\n`, "utf8");
