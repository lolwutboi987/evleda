import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

import { parseFreshSchematicSource } from "./fresh-kicad-parser.js";
import {
  assertFreshProjectDirectoryChain,
  isVerifiedFreshProject,
  type FreshFilesystemIdentity,
  type FreshProject,
} from "./fresh-project.js";

export interface FreshSchematicPreimage {
  readonly source: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly projectIdentity: FreshFilesystemIdentity;
  readonly schematicPath: string;
}

const identity = (value: Buffer): Pick<FreshSchematicPreimage, "sha256" | "bytes"> => ({
  sha256: createHash("sha256").update(value).digest("hex"),
  bytes: value.byteLength,
});

const sameRoot = (left: FreshFilesystemIdentity, right: FreshFilesystemIdentity): boolean =>
  left.canonicalPath === right.canonicalPath
  && (left.dev === null || left.ino === null || (left.dev === right.dev && left.ino === right.ino));

const physicalIdentity = (canonicalPath: string, metadata: { readonly dev: bigint; readonly ino: bigint }): FreshFilesystemIdentity => {
  const dev = metadata.dev > 0n ? metadata.dev.toString(10) : null;
  const ino = metadata.ino > 0n ? metadata.ino.toString(10) : null;
  return { canonicalPath, dev: dev === null || ino === null ? null : dev, ino: dev === null || ino === null ? null : ino };
};

async function assertDirectRegularFile(filePath: string, root: FreshFilesystemIdentity): Promise<void> {
  const expected = path.join(root.canonicalPath, path.basename(filePath));
  if (path.resolve(filePath) !== expected) throw new Error("Fresh schematic path is not bound directly to its marker root.");
  const metadata = await lstat(expected, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
    throw new Error("Fresh schematic target is not one unlinked physical regular file.");
  }
  if (await realpath(expected) !== expected) throw new Error("Fresh schematic target resolves through a link or unexpected path.");
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!["EPERM", "EISDIR", "EINVAL", "ENOTSUP", "EBADF"].includes(code ?? "")) throw error;
  }
}

/** Marker-root-confined exact preimage capture and atomic rollback for fresh schematics. */
export class FreshSchematicRollback {
  readonly #freshProject: FreshProject;
  readonly #owned = new WeakMap<FreshSchematicPreimage, Readonly<{ source: string; physical: FreshFilesystemIdentity }>>();

  constructor(freshProject: FreshProject) {
    if (!isVerifiedFreshProject(freshProject)) throw new Error("Fresh schematic rollback requires a marker-bound fresh project.");
    this.#freshProject = freshProject;
  }

  async capture(expectedSource: string): Promise<FreshSchematicPreimage> {
    parseFreshSchematicSource(expectedSource);
    const root = await assertFreshProjectDirectoryChain(this.#freshProject);
    await assertDirectRegularFile(this.#freshProject.schematicPath, root);
    const bytes = await readFile(this.#freshProject.schematicPath);
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (source !== expectedSource) throw new Error("Fresh schematic changed between preflight and rollback-checkpoint capture.");
    const checkpoint = Object.freeze({ source, ...identity(bytes), projectIdentity: root, schematicPath: this.#freshProject.schematicPath });
    this.#owned.set(checkpoint, { source, physical: physicalIdentity(checkpoint.schematicPath, await lstat(checkpoint.schematicPath, { bigint: true })) });
    return checkpoint;
  }

  /** Position-only host edits use this guarded replacement, never blind restore. */
  async stageOwnedSource(checkpoint: FreshSchematicPreimage, plannedSource: string): Promise<void> {
    if (this.#owned.get(checkpoint)?.source !== checkpoint.source) throw new Error("Schematic stage requires its original owned preimage.");
    await this.#replaceOwnedSource(checkpoint, plannedSource);
  }

  /** Unknown current bytes or a replaced file are preserved for explicit recovery. */
  async restoreOwnedSource(checkpoint: FreshSchematicPreimage): Promise<void> {
    await this.#replaceOwnedSource(checkpoint, checkpoint.source);
  }

  /** Read-only currentness proof; equal bytes alone cannot replace file ownership. */
  async assertOwnedSource(checkpoint: FreshSchematicPreimage, expectedSource: string): Promise<void> {
    if (this.#owned.get(checkpoint)?.source !== expectedSource) throw new Error("Schematic expected source differs from this owned stage.");
    await this.#replaceOwnedSource(checkpoint, expectedSource); // Equal-source path only; never creates a temporary or renames.
  }

  async #replaceOwnedSource(checkpoint: FreshSchematicPreimage, replacement: string): Promise<void> {
    const owned = this.#owned.get(checkpoint);
    if (owned === undefined || checkpoint.schematicPath !== this.#freshProject.schematicPath) throw new Error("Schematic replacement lacks this host's exact owned checkpoint.");
    parseFreshSchematicSource(replacement);
    const expected = Buffer.from(owned.source, "utf8"), bytes = Buffer.from(replacement, "utf8");
    if (bytes.length > 8 * 1024 * 1024 || !replacement.isWellFormed()) throw new Error("Schematic replacement exceeds its bounded UTF-8 source authority.");
    const assertCurrent = async (): Promise<FreshFilesystemIdentity> => {
      if (owned.physical.dev === null || owned.physical.ino === null) throw new Error("Guarded schematic replacement requires observable physical file identity.");
      await this.#freshProject.assertMarkerCurrent();
      const root = await assertFreshProjectDirectoryChain(this.#freshProject);
      if (!sameRoot(root, checkpoint.projectIdentity) || this.#owned.get(checkpoint) !== owned) throw new Error("Schematic root/checkpoint authority changed; current state was preserved.");
      await assertDirectRegularFile(checkpoint.schematicPath, root);
      const before = await lstat(checkpoint.schematicPath, { bigint: true });
      if (!sameRoot(physicalIdentity(checkpoint.schematicPath, before), owned.physical) || before.size !== BigInt(expected.length)) throw new Error("Schematic file identity or bytes changed; current state was preserved.");
      const current = await readFile(checkpoint.schematicPath), after = await lstat(checkpoint.schematicPath, { bigint: true });
      if (!current.equals(expected) || !after.isFile() || after.isSymbolicLink() || after.nlink !== 1n
          || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
          || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("Unknown concurrent schematic source was preserved.");
      return root;
    };
    const root = await assertCurrent();
    if (bytes.equals(expected)) return;
    const temporary = path.join(root.canonicalPath, `.${path.basename(checkpoint.schematicPath)}.${process.pid}.${randomUUID()}.evleda-position.tmp`);
    let stagedIdentity: FreshFilesystemIdentity | undefined;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); stagedIdentity = physicalIdentity(checkpoint.schematicPath, await handle.stat({ bigint: true })); }
      finally { await handle.close(); }
      await assertCurrent();
      const metadata = await lstat(temporary, { bigint: true });
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n || await realpath(temporary) !== temporary
          || stagedIdentity === undefined || !sameRoot(stagedIdentity, physicalIdentity(checkpoint.schematicPath, metadata))
          || !(await readFile(temporary)).equals(bytes)) throw new Error("Owned schematic temporary identity/source changed.");
      await assertCurrent();
      await rename(temporary, checkpoint.schematicPath);
      this.#owned.set(checkpoint, Object.freeze({ source: replacement, physical: stagedIdentity }));
      await syncDirectory(root.canonicalPath);
    } finally { await rm(temporary, { force: true }).catch(() => undefined); }
    const afterRoot = await assertFreshProjectDirectoryChain(this.#freshProject);
    await assertDirectRegularFile(checkpoint.schematicPath, afterRoot);
    if (!sameRoot(afterRoot, checkpoint.projectIdentity)
        || !sameRoot(physicalIdentity(checkpoint.schematicPath, await lstat(checkpoint.schematicPath, { bigint: true })), stagedIdentity!)
        || !(await readFile(checkpoint.schematicPath)).equals(bytes)) throw new Error("Owned schematic replacement readback changed; preserve current source.");
  }

  async restore(checkpoint: FreshSchematicPreimage): Promise<void> {
    if (checkpoint.schematicPath !== this.#freshProject.schematicPath) throw new Error("Fresh schematic rollback checkpoint targets another file.");
    const baseline = Buffer.from(checkpoint.source, "utf8");
    const baselineIdentity = identity(baseline);
    if (baselineIdentity.sha256 !== checkpoint.sha256 || baselineIdentity.bytes !== checkpoint.bytes) {
      throw new Error("Fresh schematic rollback checkpoint identity does not reproduce.");
    }
    parseFreshSchematicSource(checkpoint.source);

    const initialRoot = await assertFreshProjectDirectoryChain(this.#freshProject);
    if (!sameRoot(initialRoot, checkpoint.projectIdentity)) throw new Error("Fresh project root identity changed before schematic rollback.");
    await assertDirectRegularFile(checkpoint.schematicPath, initialRoot);
    const temporary = path.join(initialRoot.canonicalPath, `.${path.basename(checkpoint.schematicPath)}.${process.pid}.${randomUUID()}.evleda-rollback.tmp`);
    let temporaryIdentity: FreshFilesystemIdentity | undefined;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(baseline);
        await handle.sync();
        temporaryIdentity = physicalIdentity(temporary, await handle.stat({ bigint: true }));
      } finally { await handle.close(); }
      const temporaryMetadata = await lstat(temporary, { bigint: true });
      if (!temporaryMetadata.isFile() || temporaryMetadata.isSymbolicLink() || temporaryMetadata.nlink !== 1n || await realpath(temporary) !== temporary) {
        throw new Error("Fresh schematic rollback temporary is not an unlinked physical sibling file.");
      }
      const beforeRenameRoot = await assertFreshProjectDirectoryChain(this.#freshProject);
      if (!sameRoot(beforeRenameRoot, checkpoint.projectIdentity)) throw new Error("Fresh project root identity changed before schematic rollback replacement.");
      await assertDirectRegularFile(checkpoint.schematicPath, beforeRenameRoot);
      const temporaryBeforeRename = physicalIdentity(temporary, await lstat(temporary, { bigint: true }));
      if (temporaryIdentity === undefined || !sameRoot(temporaryBeforeRename, temporaryIdentity)) {
        throw new Error("Fresh schematic rollback temporary changed physical identity before replacement.");
      }
      const staged = await readFile(temporary);
      if (!staged.equals(baseline)) throw new Error("Fresh schematic rollback temporary bytes do not match the captured preimage.");
      await rename(temporary, checkpoint.schematicPath);
      await syncDirectory(beforeRenameRoot.canonicalPath);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    const afterRoot = await assertFreshProjectDirectoryChain(this.#freshProject);
    if (!sameRoot(afterRoot, checkpoint.projectIdentity)) throw new Error("Fresh project root identity changed during schematic rollback.");
    await assertDirectRegularFile(checkpoint.schematicPath, afterRoot);
    const restored = await readFile(checkpoint.schematicPath);
    if (!restored.equals(baseline)) throw new Error("Fresh schematic rollback readback differs from the captured exact preimage.");
    parseFreshSchematicSource(new TextDecoder("utf-8", { fatal: true }).decode(restored));
  }
}
