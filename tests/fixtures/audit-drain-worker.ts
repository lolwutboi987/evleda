import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { HashChainAuditLog } from "../../src/persistence/audit-log.js";
import { AtomicStateStore } from "../../src/persistence/state-store.js";

const [dataRoot, readyFile, startFile] = process.argv.slice(2);
if (dataRoot === undefined || readyFile === undefined || startFile === undefined) {
  throw new Error("usage: audit-drain-worker <data-root> <ready-file> <start-file>");
}

const state = new AtomicStateStore(path.join(dataRoot, "state"));
const audit = new HashChainAuditLog(path.join(dataRoot, "audit"));
await writeFile(readyFile, `${process.pid}\n`, "utf8");
for (;;) {
  try {
    await access(startFile);
    break;
  } catch {
    await delay(10);
  }
}

const events = await audit.drain(async () => {
  const snapshot = await state.read();
  return {
    stateRevision: snapshot.revision,
    ...(snapshot.auditOutboxSchemaVersion === undefined
      ? {}
      : { outboxSchemaVersion: snapshot.auditOutboxSchemaVersion }),
    outbox: snapshot.auditOutbox
  };
});
const readyPid = Number((await readFile(readyFile, "utf8")).trim());
process.stdout.write(`${JSON.stringify({ pid: readyPid, events: events.length })}\n`);
