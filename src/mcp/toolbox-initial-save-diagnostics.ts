import { randomUUID } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";

export interface InitialSaveSourceMismatch {
  readonly phase: "before-save" | "after-save";
  readonly preparedSource: string;
  readonly observedLiveSource: string;
}

/** Complete host-private mismatch evidence. It grants no source or save authority. */
export async function writeInitialSaveSourceMismatch(outputRoot: string, input: InitialSaveSourceMismatch) {
  if (!["before-save", "after-save"].includes(input.phase) || [input.preparedSource, input.observedLiveSource]
    .some(s => typeof s !== "string" || !s.isWellFormed() || Buffer.byteLength(s) > 2 * 1024 * 1024)) throw new Error("Initial-source diagnostic exceeds its supported source scope.");
  const payload = { schemaVersion: "evleda.initial-save-source-mismatch.v1", phase: input.phase,
    prepared: { source: input.preparedSource, identity: contentIdentity(input.preparedSource) },
    live: { source: input.observedLiveSource, identity: contentIdentity(input.observedLiveSource) },
    nativeSaveAttempted: input.phase === "after-save", acceptanceEvaluated: false };
  const bytes = Buffer.from(canonicalJson({ ...payload, identity: canonicalIdentity(payload, payload.schemaVersion) }) + "\n");
  if (bytes.length > 16 * 1024 * 1024) throw new Error("Initial-source diagnostic exceeds its complete artifact bound.");
  const root = path.resolve(outputRoot), before = await lstat(root, { bigint: true });
  if (root !== outputRoot || !before.isDirectory() || before.isSymbolicLink() || await realpath(root) !== root) throw new Error("Initial-source diagnostic root must be host-owned and canonical.");
  const assertRoot = async () => {
    const now = await lstat(root, { bigint: true });
    if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== before.dev || now.ino !== before.ino || await realpath(root) !== root) throw new Error("Initial-source diagnostic root changed.");
  };
  const target = path.join(root, `initial-save-source-${input.phase}-${randomUUID()}.json`), handle = await open(target, "wx+", 0o600);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.size !== 0n) throw new Error("Initial-source diagnostic reservation is not exclusive.");
    await assertRoot(); await handle.writeFile(bytes); await handle.sync();
    const actual = await handle.stat({ bigint: true }), physical = await lstat(target, { bigint: true });
    if (actual.dev !== opened.dev || actual.ino !== opened.ino || actual.nlink !== 1n || actual.size !== BigInt(bytes.length)
      || !physical.isFile() || physical.isSymbolicLink() || physical.nlink !== 1n || physical.dev !== actual.dev || physical.ino !== actual.ino
      || physical.size !== actual.size || await realpath(target) !== target) throw new Error("Initial-source diagnostic destination changed.");
    const copy = Buffer.alloc(bytes.length + 1); let used = 0;
    while (used < copy.length) { const r = await handle.read(copy, used, copy.length - used, used); if (!r.bytesRead) break; used += r.bytesRead; }
    const settled = await lstat(target, { bigint: true });
    if (!copy.subarray(0, used).equals(bytes) || settled.dev !== physical.dev || settled.ino !== physical.ino || settled.nlink !== 1n
      || settled.size !== physical.size || settled.mtimeNs !== physical.mtimeNs || settled.ctimeNs !== physical.ctimeNs) throw new Error("Initial-source diagnostic readback differs.");
    await assertRoot(); return Object.freeze({ path: target, identity: contentIdentity(bytes) });
  } finally { await handle.close(); }
}
