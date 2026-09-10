import { randomUUID } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import { hardenPortableValue } from "../core/portable-artifact.js";
import type { FreshRouteMutationDiagnostic } from "../harness/kicad-tools.js";

const VERSION = "evleda.fresh-route-mutation-diagnostic.v1";
const MAX_BYTES = 64 * 1024;

/** Host-private failure evidence. Never accepts a model-selected output path. */
export async function writeToolboxRouteDiagnostic(outputRoot: string, diagnostic: FreshRouteMutationDiagnostic) {
  const captured = hardenPortableValue(diagnostic, { maxBytes: MAX_BYTES, maxStringBytes: 8192,
    maxDepth: 16, maxNodes: 8192, maxArrayLength: 128, maxOwnKeys: 64, maxKeyBytes: 256 }) as FreshRouteMutationDiagnostic;
  const { identity, ...body } = captured;
  if (captured.schemaVersion !== VERSION || !["primary-failure", "recovery-finished"].includes(captured.phase)
      || canonicalJson(identity) !== canonicalJson(canonicalIdentity(body, VERSION))) {
    throw new Error("Route diagnostic identity or phase differs from its complete payload.");
  }
  const bytes = Buffer.from(`${canonicalJson(captured)}\n`, "utf8");
  if (bytes.byteLength > MAX_BYTES) throw new Error("Route diagnostic exceeds its private artifact limit.");
  const root = path.resolve(outputRoot);
  if (!path.isAbsolute(outputRoot) || await realpath(root) !== root) throw new Error("Route diagnostic output must be the exact host-owned directory.");
  const rootBefore = await lstat(root, { bigint: true });
  if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) throw new Error("Route diagnostic output is not an ordinary directory.");
  const assertRoot = async () => {
    const current = await lstat(root, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== rootBefore.dev || current.ino !== rootBefore.ino
        || await realpath(root) !== root) throw new Error("Route diagnostic output changed during publication.");
  };
  const target = path.join(root, `route-diagnostic-${captured.phase}-${randomUUID()}.json`);
  const handle = await open(target, "wx+", 0o600);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.size !== 0n) throw new Error("Route diagnostic reservation is not exclusive.");
    await assertRoot();
    await handle.writeFile(bytes); await handle.sync();
    const written = await handle.stat({ bigint: true });
    const physical = await lstat(target, { bigint: true });
    if (written.dev !== opened.dev || written.ino !== opened.ino || written.nlink !== 1n || written.size !== BigInt(bytes.length)
        || physical.dev !== written.dev || physical.ino !== written.ino || !physical.isFile() || physical.isSymbolicLink()
        || physical.nlink !== 1n || physical.size !== written.size || await realpath(target) !== target) throw new Error("Route diagnostic artifact identity changed.");
    const readback = Buffer.alloc(bytes.length + 1); let count = 0;
    while (count < readback.length) {
      const part = await handle.read(readback, count, readback.length - count, count);
      if (part.bytesRead === 0) break;
      count += part.bytesRead;
    }
    const settled = await lstat(target, { bigint: true });
    if (!readback.subarray(0, count).equals(bytes) || settled.dev !== written.dev || settled.ino !== written.ino
        || settled.size !== written.size || settled.nlink !== 1n || settled.mtimeNs !== physical.mtimeNs
        || settled.ctimeNs !== physical.ctimeNs) throw new Error("Route diagnostic readback differs from the full failure record.");
    await assertRoot();
    return Object.freeze({ path: target, identity: contentIdentity(bytes) });
  } finally {
    // Failed/partial reservations are retained; never erase failure evidence.
    await handle.close();
  }
}
