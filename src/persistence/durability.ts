import {
  open,
  readFile,
  rename,
  type FileHandle
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const UNSUPPORTED_DIRECTORY_SYNC = new Set(["EBADF", "EINVAL", "EISDIR", "ENOTSUP"]);
const TRANSIENT_REPLACE_ERRORS = new Set(["EACCES", "EBUSY", "EPERM"]);

export type DurabilityBarrierKind = "file_sync" | "directory_sync";

export interface DurabilityBarrierObservation {
  readonly kind: DurabilityBarrierKind;
  /** File whose bytes or containing-directory entry is being made durable. */
  readonly target: string;
}

/**
 * Read-only instrumentation for counting real durability barriers. The
 * observer cannot replace or suppress fsync; production durability always runs.
 */
export type DurabilityBarrierObserver = (
  observation: DurabilityBarrierObservation
) => void;

const observeBarrier = (
  observer: DurabilityBarrierObserver | undefined,
  observation: DurabilityBarrierObservation
): void => {
  try {
    observer?.(Object.freeze(observation));
  } catch {
    // Instrumentation is deliberately observational. It must never suppress a
    // barrier or change a production persistence outcome.
  }
};

export const syncFileHandle = async (
  handle: FileHandle,
  filePath: string,
  observer?: DurabilityBarrierObserver
): Promise<void> => {
  await handle.sync();
  observeBarrier(observer, { kind: "file_sync", target: filePath });
};

export interface AtomicReplaceOptions {
  readonly maxRetries?: number;
  readonly retryDelayMs?: number;
  readonly renameFile?: (source: string, destination: string) => Promise<void>;
}

const matchesExpectedBytes = async (
  destination: string,
  expected: Buffer
): Promise<boolean> => {
  try {
    return (await readFile(destination)).equals(expected);
  } catch {
    return false;
  }
};

export const replaceFileAtomically = async (
  source: string,
  destination: string,
  expectedBytes: Uint8Array | string,
  options: AtomicReplaceOptions = {}
): Promise<void> => {
  const maxRetries = options.maxRetries ?? (process.platform === "win32" ? 20 : 0);
  const retryDelayMs = options.retryDelayMs ?? 10;
  const renameFile = options.renameFile ?? rename;
  const expected = typeof expectedBytes === "string"
    ? Buffer.from(expectedBytes, "utf8")
    : Buffer.from(expectedBytes);

  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFile(source, destination);
      return;
    } catch (error) {
      if (await matchesExpectedBytes(destination, expected)) {
        return;
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (!TRANSIENT_REPLACE_ERRORS.has(code ?? "") || attempt >= maxRetries) {
        throw error;
      }
      await delay(retryDelayMs * (attempt + 1));
    }
  }
};

export const syncContainingDirectory = async (
  filePath: string,
  observer?: DurabilityBarrierObserver
): Promise<void> => {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path.dirname(filePath), "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (UNSUPPORTED_DIRECTORY_SYNC.has(code ?? "") || (process.platform === "win32" && code === "EPERM")) {
    } else {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
  // Count the logical barrier after the real sync attempt. Platforms that do
  // not expose directory fsync still execute this durability boundary; the
  // observer cannot alter either outcome.
  observeBarrier(observer, { kind: "directory_sync", target: filePath });
};
