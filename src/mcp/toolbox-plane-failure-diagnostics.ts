import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import { hardenPortableValue } from "../core/portable-artifact.js";
import { planeFailureDiagnosticFilename, type FreshPlaneFailureDiagnostic } from "../harness/fresh-plane-failure-diagnostics.js";

const VERSION = "evleda.fresh-plane-failure-diagnostic.v1";
const MAX_BYTES = 4 * 1024 * 1024;

/** Complete host-private first-failure evidence; the output directory is never model-selected. */
export async function writeToolboxPlaneFailureDiagnostic(outputRoot: string, diagnostic: FreshPlaneFailureDiagnostic) {
  const captured = hardenPortableValue(diagnostic, { maxBytes: MAX_BYTES, maxStringBytes: 1024 * 1024,
    maxDepth: 32, maxNodes: 65_536, maxArrayLength: 8192, maxOwnKeys: 512, maxKeyBytes: 256 }) as FreshPlaneFailureDiagnostic;
  const { identity, ...body } = captured;
  if (captured.schemaVersion !== VERSION || captured.phase !== "primary-failure"
      || typeof captured.failureId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(captured.failureId)
      || canonicalJson(identity) !== canonicalJson(canonicalIdentity(body, VERSION))) {
    throw new Error("Plane failure diagnostic identity or phase differs from its complete payload.");
  }
  const bytes = Buffer.from(`${canonicalJson(captured)}\n`, "utf8");
  if (bytes.byteLength > MAX_BYTES) throw new Error("Plane failure diagnostic exceeds its private artifact limit.");
  const root = path.resolve(outputRoot);
  if (!path.isAbsolute(outputRoot) || root !== outputRoot || await realpath(root) !== root) {
    throw new Error("Plane failure diagnostic output must be the exact host-owned directory.");
  }
  const rootBefore = await lstat(root, { bigint: true });
  if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) throw new Error("Plane failure diagnostic output is not an ordinary directory.");
  const assertRoot = async () => {
    const current = await lstat(root, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== rootBefore.dev || current.ino !== rootBefore.ino
        || await realpath(root) !== root) throw new Error("Plane failure diagnostic output changed during publication.");
  };
  const target = path.join(root, planeFailureDiagnosticFilename(captured));
  const handle = await open(target, "wx+", 0o600);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.size !== 0n) throw new Error("Plane failure diagnostic reservation is not exclusive.");
    await assertRoot();
    await handle.writeFile(bytes);
    await handle.sync();
    const written = await handle.stat({ bigint: true });
    const physical = await lstat(target, { bigint: true });
    if (written.dev !== opened.dev || written.ino !== opened.ino || written.nlink !== 1n || written.size !== BigInt(bytes.length)
        || physical.dev !== written.dev || physical.ino !== written.ino || !physical.isFile() || physical.isSymbolicLink()
        || physical.nlink !== 1n || physical.size !== written.size || await realpath(target) !== target) {
      throw new Error("Plane failure diagnostic artifact identity changed.");
    }
    const readback = Buffer.alloc(bytes.length + 1);
    let count = 0;
    while (count < readback.length) {
      const part = await handle.read(readback, count, readback.length - count, count);
      if (part.bytesRead === 0) break;
      count += part.bytesRead;
    }
    const settled = await lstat(target, { bigint: true });
    if (!readback.subarray(0, count).equals(bytes) || settled.dev !== written.dev || settled.ino !== written.ino
        || !settled.isFile() || settled.isSymbolicLink() || settled.size !== written.size || settled.nlink !== 1n || settled.mtimeNs !== physical.mtimeNs
        || settled.ctimeNs !== physical.ctimeNs) throw new Error("Plane failure diagnostic readback differs from the full failure record.");
    await assertRoot();
    return Object.freeze({ filename: path.basename(target), identity: contentIdentity(bytes) });
  } finally {
    // Retain incomplete reservations as failure evidence; never overwrite them.
    await handle.close();
  }
}
