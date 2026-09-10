import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";

const MAX_LOCK_BYTES = 64 * 1024;
const comparable = (value: string): string => process.platform === "win32" ? value.toLowerCase() : value;
const fileWitness = (value: BigIntStats): string => JSON.stringify([
  value.dev, value.ino, value.mode, value.nlink, value.size, value.birthtimeNs, value.mtimeNs, value.ctimeNs,
].map(String));
const stableFileWitness = (value: BigIntStats): string => JSON.stringify([
  value.dev, value.ino, value.mode, value.nlink, value.size, value.birthtimeNs,
].map(String));
const directoryWitness = (value: BigIntStats): string => JSON.stringify([
  value.dev, value.ino, value.mode, value.birthtimeNs,
].map(String));

async function directory(candidate: string): Promise<string> {
  const absolute = path.resolve(candidate);
  if (comparable(await realpath(absolute)) !== comparable(absolute)) throw new Error("Owned editor lock directory is aliased.");
  let cursor = absolute;
  for (;;) {
    const value = await lstat(cursor);
    if (!value.isDirectory() || value.isSymbolicLink()) throw new Error("Owned editor lock directory contains a link or unsupported entry.");
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return directoryWitness(await lstat(absolute, { bigint: true }));
}

async function absent(candidate: string): Promise<boolean> {
  try { await lstat(candidate); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
}

interface LockCapture { readonly physical: string; readonly stable: string; readonly sha256: string; }
async function captureFile(candidate: string): Promise<LockCapture> {
  const before = await lstat(candidate, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(MAX_LOCK_BYTES)) {
    throw new Error("Owned editor lock is not a bounded ordinary single-link file; retained.");
  }
  const physical = fileWitness(before);
  if (comparable(await realpath(candidate)) !== comparable(candidate)) throw new Error("Owned editor lock is aliased; retained.");
  const handle = await open(candidate, "r");
  let bytes: Buffer;
  try {
    if (fileWitness(await handle.stat({ bigint: true })) !== physical) throw new Error("Owned editor lock changed while opening; retained.");
    const buffer = Buffer.alloc(MAX_LOCK_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== Number(before.size) || bytesRead > MAX_LOCK_BYTES
        || fileWitness(await handle.stat({ bigint: true })) !== physical) throw new Error("Owned editor lock changed while reading; retained.");
    bytes = buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
  if (fileWitness(await lstat(candidate, { bigint: true })) !== physical) throw new Error("Owned editor lock changed after capture; retained.");
  return Object.freeze({ physical, stable: stableFileWitness(before), sha256: createHash("sha256").update(bytes).digest("hex") });
}

export interface OwnedEditorLocksInput {
  readonly outputRoot: string;
  readonly projectRoot: string;
  readonly pcbPath: string;
  /** Closure over the exact owned editor exit/tree outcome, never a request flag. */
  readonly isEditorTeardownConfirmed: () => boolean;
}

export interface OwnedEditorLocks {
  /** Call only after the owning host verified the exact active native PCB. */
  capture(): Promise<void>;
  /** Host must verify the same owned live PCB immediately before this call. */
  refresh(): Promise<void>;
  /** Requires exact owned editor teardown; never removes a preexisting/changed lock. */
  release(): Promise<void>;
}

/** Host-only capability. Invoke immediately before the corresponding owned launch. */
export async function preflightOwnedEditorLocks(input: OwnedEditorLocksInput): Promise<OwnedEditorLocks> {
  const outputRoot = path.resolve(input.outputRoot), projectRoot = path.resolve(input.projectRoot), pcbPath = path.resolve(input.pcbPath);
  const relative = path.relative(comparable(outputRoot), comparable(projectRoot));
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      || comparable(path.dirname(pcbPath)) !== comparable(projectRoot) || path.extname(pcbPath).toLowerCase() !== ".kicad_pcb"
      || typeof input.isEditorTeardownConfirmed !== "function") throw new Error("Owned editor locks require one confined project and exact PCB path.");
  const roots = [outputRoot, projectRoot] as const;
  const rootWitnesses = await Promise.all(roots.map(directory));
  const assertRoots = async (): Promise<void> => {
    const actual = await Promise.all(roots.map(directory));
    if (actual.some((value, index) => value !== rootWitnesses[index])) throw new Error("Owned editor lock root identity changed; locks retained.");
  };
  const board = await lstat(pcbPath);
  if (!board.isFile() || board.isSymbolicLink() || board.nlink !== 1
      || comparable(await realpath(pcbPath)) !== comparable(pcbPath)) throw new Error("Owned editor lock PCB must be an ordinary unaliased file.");
  const stem = path.basename(pcbPath, path.extname(pcbPath));
  const paths = [path.join(projectRoot, `~${path.basename(pcbPath)}.lck`), path.join(projectRoot, `~${stem}.kicad_pro.lck`)] as const;
  for (const candidate of paths) if (!await absent(candidate)) throw new Error("Preexisting KiCad editor lock conflicts with this launch; retained.");
  await assertRoots();
  let captured: readonly LockCapture[] | undefined;
  let capturing = false;
  let refreshing = false;
  let released = false;
  let releasing: Promise<void> | undefined;
  return Object.freeze({
    capture: async () => {
      if (released || releasing !== undefined || captured !== undefined || capturing) throw new Error("Owned editor lock capture is unavailable or already consumed.");
      capturing = true;
      await assertRoots();
      const current = await Promise.all(paths.map(captureFile));
      await assertRoots();
      captured = Object.freeze(current);
    },
    refresh: async () => {
      if (captured === undefined || released || releasing !== undefined || refreshing || input.isEditorTeardownConfirmed()) {
        throw new Error("Owned editor lock refresh requires captured locks in the active owned session.");
      }
      refreshing = true;
      try {
        await assertRoots();
        const current = await Promise.all(paths.map(captureFile));
        if (current.some((value, index) => value.stable !== captured![index]!.stable || value.sha256 !== captured![index]!.sha256)) {
          throw new Error("Owned editor lock identity or original contents changed during refresh; locks retained.");
        }
        await assertRoots();
        captured = Object.freeze(current);
      } finally { refreshing = false; }
    },
    release: () => releasing ??= (async () => {
      if (!input.isEditorTeardownConfirmed()) throw new Error("Owned editor teardown is not confirmed; locks retained.");
      if (capturing && captured === undefined) throw new Error("Owned editor lock capture did not complete; locks retained.");
      if (refreshing) throw new Error("Owned editor lock refresh remains in progress; locks retained.");
      await assertRoots();
      if (captured === undefined) {
        for (const candidate of paths) if (!await absent(candidate)) throw new Error("Uncaptured editor lock remains; ownership is unconfirmed and file retained.");
      } else {
        // Verify the complete pair before any deletion. KiCad may remove its
        // own locks on normal exit; already-absent paths need no cleanup.
        for (let index = 0; index < paths.length; index++) {
          if (!await absent(paths[index]!)) {
            const current = await captureFile(paths[index]!);
            if (JSON.stringify(current) !== JSON.stringify(captured[index])) throw new Error("Owned editor lock changed after capture; pair retained.");
          }
        }
        for (let index = 0; index < paths.length; index++) {
          const candidate = paths[index]!;
          if (await absent(candidate)) continue;
          await assertRoots();
          const current = await captureFile(candidate);
          if (JSON.stringify(current) !== JSON.stringify(captured[index]) || !input.isEditorTeardownConfirmed()) {
            throw new Error("Owned editor lock identity or teardown changed before removal; file retained.");
          }
          await unlink(candidate);
          if (!await absent(candidate)) throw new Error("Owned editor lock removal was not confirmed; replacement retained.");
        }
      }
      released = true;
    })(),
  });
}
