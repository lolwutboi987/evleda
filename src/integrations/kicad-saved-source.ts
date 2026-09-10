import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { types as nodeTypes } from "node:util";
import { contentIdentity } from "../core/canonical.js";
import type { ContentIdentity } from "../domain/types.js";

export const KICAD_SAVED_SOURCE_MAX_BYTES = 64 * 1024 * 1024;
export interface KicadSavedSourceObservation<Value> {
  readonly value: Value;
  /** Exact file bytes, not a normalized/re-serialized parser result. */
  readonly sourceIdentity: ContentIdentity;
}
export type KicadSavedSourceReader = <Value>(parse: (text: string) => Value) => Promise<KicadSavedSourceObservation<Value>>;

const sameFile = (left: BigIntStats, right: BigIntStats): boolean => left.dev === right.dev && left.ino === right.ino
  && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.nlink === right.nlink;

async function boundedRead(handle: FileHandle): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let count = 0;
  while (true) {
    const buffer = Buffer.alloc(Math.min(64 * 1024, KICAD_SAVED_SOURCE_MAX_BYTES + 1 - count));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, count);
    if (bytesRead === 0) break;
    count += bytesRead;
    if (count > KICAD_SAVED_SOURCE_MAX_BYTES) throw new Error("Saved PCB source exceeds the bounded read limit.");
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, count);
}

/**
 * Bind once from host-owned state; no model-selected filename reaches the returned observer.
 * The parser must be synchronous and is bracketed by the same descriptor/path/byte checks.
 * UTF-8 is fatal-decoded with ignoreBOM:true, which retains an initial U+FEFF instead of
 * stripping it. CRLF and other source text are unchanged; authority always hashes raw bytes.
 */
export async function createKicadSavedSourceReader(input: { readonly pcbPath: string }): Promise<KicadSavedSourceReader> {
  if (!path.isAbsolute(input.pcbPath) || path.extname(input.pcbPath).toLowerCase() !== ".kicad_pcb") throw new Error("Saved-source reader requires an absolute host-owned PCB path.");
  const requested = path.resolve(input.pcbPath);
  const bound = await realpath(requested);
  const inspect = async (): Promise<BigIntStats> => {
    const metadata = await lstat(requested, { bigint: true });
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n || await realpath(requested) !== bound || bound !== requested) throw new Error("Saved PCB must remain the exact ordinary canonical host-bound file.");
    if (metadata.size > BigInt(KICAD_SAVED_SOURCE_MAX_BYTES)) throw new Error("Saved PCB source exceeds the bounded read limit.");
    return metadata;
  };
  await inspect();
  return async <Value>(parse: (text: string) => Value): Promise<KicadSavedSourceObservation<Value>> => {
    const before = await inspect();
    const handle = await open(requested, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat({ bigint: true });
      if (!sameFile(before, opened)) throw new Error("Saved PCB changed while opening.");
      const bytes = await boundedRead(handle);
      const sourceIdentity = Object.freeze(contentIdentity(bytes));
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      const value = parse(text);
      if (nodeTypes.isPromise(value)) {
        // Do not leak a rejected asynchronous result while refusing its unbracketed work.
        void value.catch(() => {});
        throw new Error("Saved-source observation requires a synchronous parser.");
      }
      if (value !== null && (typeof value === "object" || typeof value === "function") && "then" in value && typeof value.then === "function") throw new Error("Saved-source observation requires a synchronous parser.");
      if (!bytes.equals(await boundedRead(handle)) || !sameFile(opened, await handle.stat({ bigint: true })) || !sameFile(opened, await inspect())) throw new Error("Saved PCB changed during observation; discard the result.");
      return Object.freeze({ value, sourceIdentity });
    } finally { await handle.close(); }
  };
}
