import { writeFile } from "node:fs/promises";
import { acquireExclusiveFileLock } from "../../src/persistence/file-lock.js";

const [lockPath, readyFile] = process.argv.slice(2);
if (lockPath === undefined || readyFile === undefined) {
  throw new Error("file-lock-claim-crash-worker requires lock and ready-file arguments");
}

const never = new Promise<void>(() => undefined);
setInterval(() => undefined, 1_000);
await acquireExclusiveFileLock(lockPath, {
  claimPreparedHook: async (claimPath) => {
    await writeFile(readyFile, `${process.pid}\n${claimPath}\n`, "utf8");
    await never;
  }
});
