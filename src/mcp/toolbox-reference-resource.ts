import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { contentIdentity } from "../core/canonical.js";
import type { ContentIdentity } from "../domain/types.js";

export interface ToolboxReferenceArtifact { readonly path: string; readonly identity: ContentIdentity }
export const REFERENCE_RESOURCE_MAX_BYTES = 16 * 1024 * 1024;

/** Read only a previously registered host artifact; caller URLs never select a path. */
export async function readToolboxReferenceArtifact(artifact: ToolboxReferenceArtifact): Promise<string> {
  if (!path.isAbsolute(artifact.path) || artifact.identity.algorithm !== "sha256"
      || !/^[a-f0-9]{64}$/u.test(artifact.identity.digest) || !Number.isSafeInteger(artifact.identity.size)
      || artifact.identity.size < 1 || artifact.identity.size > REFERENCE_RESOURCE_MAX_BYTES) throw new Error("Invalid reference-coverage artifact identity.");
  const inspect = async () => {
    const metadata = await lstat(artifact.path, { bigint: true });
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n
        || metadata.size !== BigInt(artifact.identity.size) || await realpath(artifact.path) !== path.resolve(artifact.path)) {
      throw new Error("Reference-coverage artifact changed.");
    }
    return metadata;
  };
  const before = await inspect();
  const handle = await open(artifact.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const same = (value: typeof before) => value.ino === before.ino && value.dev === before.dev
      && value.size === before.size && value.mtimeNs === before.mtimeNs && value.ctimeNs === before.ctimeNs && value.nlink === before.nlink;
    if (!same(await handle.stat({ bigint: true }))) throw new Error("Reference-coverage artifact changed while opening.");
    const bytes = Buffer.alloc(artifact.identity.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, count);
      if (read.bytesRead === 0) break;
      count += read.bytesRead;
    }
    const captured = bytes.subarray(0, count);
    if (count !== artifact.identity.size || contentIdentity(captured).digest !== artifact.identity.digest
        || !same(await handle.stat({ bigint: true })) || !same(await inspect())) throw new Error("Reference-coverage artifact changed during reading.");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(captured);
  } finally { await handle.close(); }
}
