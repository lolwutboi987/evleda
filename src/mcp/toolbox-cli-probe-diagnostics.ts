import { randomUUID } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import { getFluxPcbEditorCliProbeFailure } from "../flux/pcb-editor-launcher.js";

const VERSION = "evleda.toolbox-cli-probe-diagnostic.v1";
// Each runner stream is bounded to 16 KiB of bytes. UTF-8 replacement and JSON
// control escaping can expand those bytes; retain them completely within 256 KiB.
const MAX_BYTES = 256 * 1024;

/** Accepts only a failure branded by the host's exact CLI identity probe. */
export async function writeToolboxCliProbeDiagnostic(outputRoot: string, error: unknown) {
  const failure = getFluxPcbEditorCliProbeFailure(error);
  if (failure === undefined) throw new Error("CLI probe diagnostic requires a captured host failure.");
  const body = { schemaVersion: VERSION, phase: "primary-failure", stage: "cli-identity-probe", failure };
  const bytes = Buffer.from(`${canonicalJson({ ...body, identity: canonicalIdentity(body, VERSION) })}\n`, "utf8");
  if (bytes.byteLength > MAX_BYTES) throw new Error("CLI probe diagnostic exceeds its complete private artifact bound.");
  const root = path.resolve(outputRoot);
  if (!path.isAbsolute(outputRoot) || root !== outputRoot || await realpath(root) !== root) {
    throw new Error("CLI probe diagnostic requires the exact host output directory.");
  }
  const before = await lstat(root, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("CLI probe diagnostic output is not an ordinary directory.");
  const assertRoot = async () => {
    const current = await lstat(root, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino
        || current.mode !== before.mode || current.birthtimeNs !== before.birthtimeNs
        || await realpath(root) !== root) throw new Error("CLI probe diagnostic output changed during publication.");
  };
  // Same reservation and descriptor readback policy as toolbox-startup-diagnostics.
  const filename = `startup-diagnostic-cli-probe-${randomUUID()}.json`;
  const target = path.join(root, filename);
  const handle = await open(target, "wx+", 0o600);
  try {
    const reserved = await handle.stat({ bigint: true });
    if (!reserved.isFile() || reserved.nlink !== 1n || reserved.size !== 0n) throw new Error("CLI probe diagnostic reservation is not exclusive.");
    await assertRoot(); await handle.writeFile(bytes); await handle.sync();
    const written = await handle.stat({ bigint: true });
    const physical = await lstat(target, { bigint: true });
    if (written.dev !== reserved.dev || written.ino !== reserved.ino || written.nlink !== 1n || written.size !== BigInt(bytes.length)
        || physical.dev !== written.dev || physical.ino !== written.ino || !physical.isFile() || physical.isSymbolicLink()
        || physical.nlink !== 1n || physical.size !== written.size || await realpath(target) !== target) throw new Error("CLI probe diagnostic artifact changed.");
    const readback = Buffer.alloc(bytes.length + 1); let count = 0;
    while (count < readback.length) {
      const part = await handle.read(readback, count, readback.length - count, count);
      if (part.bytesRead === 0) break;
      count += part.bytesRead;
    }
    const settled = await lstat(target, { bigint: true });
    if (!readback.subarray(0, count).equals(bytes) || !settled.isFile() || settled.isSymbolicLink()
        || settled.dev !== written.dev || settled.ino !== written.ino || settled.size !== written.size
        || settled.nlink !== 1n || settled.mtimeNs !== physical.mtimeNs || settled.ctimeNs !== physical.ctimeNs
        || await realpath(target) !== target) throw new Error("CLI probe diagnostic readback differs.");
    await assertRoot();
    return Object.freeze({ filename, identity: contentIdentity(bytes) });
  } finally {
    // Retain partial reservations on failure; make no cleanup claim.
    await handle.close();
  }
}
