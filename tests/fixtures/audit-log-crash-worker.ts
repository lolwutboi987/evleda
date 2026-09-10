import { writeFile } from "node:fs/promises";
import {
  EVLEDA_AUDIT_EVENT_SCHEMA_VERSION,
  HashChainAuditLog,
  type AuditLogDurabilityPhase
} from "../../src/persistence/audit-log.js";

const [root, phaseValue, readyFile] = process.argv.slice(2);
if (root === undefined || readyFile === undefined) {
  throw new Error("audit-log-crash-worker requires root, phase, and ready-file arguments");
}
if (phaseValue !== "file_sync" && phaseValue !== "directory_sync") {
  throw new Error(`Unsupported audit crash phase: ${String(phaseValue)}`);
}
const phase = phaseValue as AuditLogDurabilityPhase;
const never = new Promise<void>(() => undefined);
setInterval(() => undefined, 1_000);
let paused = false;
const log = new HashChainAuditLog(root, {
  phaseHook: async (current) => {
    if (paused || current !== phase) return;
    paused = true;
    await writeFile(readyFile, `${process.pid}\n`, "utf8");
    await never;
  }
});

await log.append({
  eventSchemaVersion: EVLEDA_AUDIT_EVENT_SCHEMA_VERSION,
  type: "state.1",
  actorType: "system",
  actorId: "evleda",
  occurredAt: "2026-09-03T00:00:01.000Z",
  payload: { stateRevision: 1 }
});
