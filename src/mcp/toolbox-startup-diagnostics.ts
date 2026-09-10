import { randomUUID } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import { hardenPortableValue } from "../core/portable-artifact.js";
import type { KicadStartupEvidence } from "../integrations/kicad-startup-diagnostic.js";

export const TOOLBOX_STARTUP_DIAGNOSTIC_VERSION = "evleda.toolbox-startup-diagnostic.v1";
export function createToolboxStartupDiagnostic(phase: "primary-failure" | "cleanup-finished", record: KicadStartupEvidence) {
  const body = Object.freeze({ schemaVersion: TOOLBOX_STARTUP_DIAGNOSTIC_VERSION, phase, ...record });
  return Object.freeze({ ...body, identity: canonicalIdentity(body, TOOLBOX_STARTUP_DIAGNOSTIC_VERSION) });
}
export type ToolboxStartupDiagnostic = ReturnType<typeof createToolboxStartupDiagnostic>;

/** Compact immutable evidence in the already-authorized output directory. */
export async function writeToolboxStartupDiagnostic(outputRoot: string, diagnostic: ToolboxStartupDiagnostic) {
  const captured = hardenPortableValue(diagnostic, { maxBytes: 16 * 1024, maxStringBytes: 256, maxDepth: 12,
    maxNodes: 256, maxArrayLength: 4, maxOwnKeys: 16, maxKeyBytes: 64 }) as ToolboxStartupDiagnostic;
  const { identity, ...body } = captured;
  if (captured.schemaVersion !== TOOLBOX_STARTUP_DIAGNOSTIC_VERSION || !["primary-failure", "cleanup-finished"].includes(captured.phase)
      || canonicalJson(identity) !== canonicalJson(canonicalIdentity(body, TOOLBOX_STARTUP_DIAGNOSTIC_VERSION))) throw new Error("Startup diagnostic identity is invalid.");
  const bytes = Buffer.from(`${canonicalJson(captured)}\n`, "utf8");
  const root = path.resolve(outputRoot);
  if (!path.isAbsolute(outputRoot) || await realpath(root) !== root) throw new Error("Startup diagnostic requires the exact host output directory.");
  const before = await lstat(root, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("Startup diagnostic output is not an ordinary directory.");
  const assertRoot = async () => {
    const current = await lstat(root, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino
        || await realpath(root) !== root) throw new Error("Startup diagnostic output changed during publication.");
  };
  const filename = `startup-diagnostic-${captured.phase}-${randomUUID()}.json`;
  const target = path.join(root, filename);
  const handle = await open(target, "wx+", 0o600);
  try {
    const reserved = await handle.stat({ bigint: true });
    if (!reserved.isFile() || reserved.nlink !== 1n || reserved.size !== 0n) throw new Error("Startup diagnostic reservation is not exclusive.");
    await assertRoot(); await handle.writeFile(bytes); await handle.sync();
    const written = await handle.stat({ bigint: true });
    const physical = await lstat(target, { bigint: true });
    if (written.dev !== reserved.dev || written.ino !== reserved.ino || written.nlink !== 1n || written.size !== BigInt(bytes.length)
        || physical.dev !== written.dev || physical.ino !== written.ino || !physical.isFile() || physical.isSymbolicLink()
        || physical.nlink !== 1n || physical.size !== written.size || await realpath(target) !== target) throw new Error("Startup diagnostic artifact changed.");
    const readback = Buffer.alloc(bytes.length + 1); let count = 0;
    while (count < readback.length) {
      const part = await handle.read(readback, count, readback.length - count, count);
      if (part.bytesRead === 0) break;
      count += part.bytesRead;
    }
    const settled = await lstat(target, { bigint: true });
    if (!readback.subarray(0, count).equals(bytes) || settled.dev !== written.dev || settled.ino !== written.ino
        || settled.size !== written.size || settled.nlink !== 1n || settled.mtimeNs !== physical.mtimeNs
        || settled.ctimeNs !== physical.ctimeNs) throw new Error("Startup diagnostic readback differs.");
    await assertRoot();
    return Object.freeze({ filename, identity: contentIdentity(bytes) });
  } finally { await handle.close(); }
}
