import { randomUUID } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rm,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";

import { constantTimeDigestEqual, contentIdentity } from "../core/canonical.js";
import { DomainError } from "../domain/errors.js";
import type { ContentIdentity } from "../domain/types.js";
import {
  PCB_DESIGN_COMPILATION_BUNDLE_LIMITS,
  createPcbDesignCompilationBundleRef,
  parsePcbDesignCompilationBundle,
  parsePcbDesignCompilationBundleRef,
  serializePcbDesignCompilationBundle,
  verifyPcbDesignCompilationBundleRef,
  type PcbDesignCompilationBundle,
  type PcbDesignCompilationBundleDependencies,
  type PcbDesignCompilationBundleRef,
} from "../harness/pcb-design-compilation-bundle.js";
import { syncContainingDirectory } from "../persistence/durability.js";
import { FluxError } from "./contracts.js";

export interface FluxCompilationBundleStore {
  put(input: unknown | PcbDesignCompilationBundle): Promise<PcbDesignCompilationBundleRef>;
  get(input: unknown | PcbDesignCompilationBundleRef): Promise<PcbDesignCompilationBundle>;
}

/** Narrow deterministic race seams. Production composition must omit these. */
export interface FileFluxCompilationBundleStoreTestHooks {
  readonly afterReadPathValidation?: () => void | Promise<void>;
  readonly afterReadHandleValidation?: () => void | Promise<void>;
  readonly afterStageHandleValidation?: () => void | Promise<void>;
  readonly afterStageWriteBeforeSync?: () => void | Promise<void>;
  readonly afterPublishPathValidation?: () => void | Promise<void>;
  readonly afterPublish?: () => void | Promise<void>;
  readonly onReadChunk?: (bytesRead: number, totalBytesRead: number) => void | Promise<void>;
}

export interface FileFluxCompilationBundleStoreOptions {
  /** @internal Test-only fault-injection boundary. */
  readonly testHooks?: FileFluxCompilationBundleStoreTestHooks;
}

interface DirectoryBinding {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
}

interface FileBinding {
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: bigint;
  readonly linkCount: bigint;
  readonly size: bigint;
  readonly modifiedNs: bigint;
  readonly changedNs: bigint;
  readonly createdNs: bigint;
}

const NO_FOLLOW = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
const READ_FLAGS = fsConstants.O_RDONLY | NO_FOLLOW;
const CREATE_FLAGS = fsConstants.O_WRONLY
  | fsConstants.O_CREAT
  | fsConstants.O_EXCL
  | NO_FOLLOW;
const READ_CHUNK_BYTES = 64 * 1024;

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;

const comparable = (value: string): string =>
  process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;

const samePath = (left: string, right: string): boolean =>
  comparable(left) === comparable(right);

const isStrictlyWithin = (root: string, candidate: string): boolean => {
  const relative = path.relative(comparable(root), comparable(candidate));
  return relative.length > 0
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
};

const pathFailure = (message: string): never => {
  throw new FluxError("PATH_POLICY", message);
};

const integrityFailure = (message: string): never => {
  throw new DomainError("ARTIFACT_INTEGRITY_ERROR", message);
};

const missingFailure = (): never => {
  throw new DomainError("NOT_FOUND", "Content-addressed compilation bundle is missing");
};

const canonicalWorkspaceRoot = (input: string): string => {
  if (
    typeof input !== "string"
    || input.length === 0
    || input.includes("\0")
    || !path.isAbsolute(input)
  ) {
    return pathFailure("Flux compilation-bundle workspace root must be an absolute canonical path");
  }
  const resolved = path.resolve(input);
  if (
    !samePath(input, resolved)
    || samePath(resolved, path.parse(resolved).root)
  ) {
    return pathFailure("Flux compilation-bundle workspace root must be an absolute canonical non-root path");
  }
  return resolved;
};

const bindDirectory = async (candidate: string, label: string): Promise<DirectoryBinding> => {
  try {
    const metadata = await lstat(candidate, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      return pathFailure(`${label} must be an ordinary non-link directory`);
    }
    const physical = await realpath(candidate);
    if (!samePath(candidate, physical)) {
      return pathFailure(`${label} must not resolve through a link, reparse point, or alias`);
    }
    return Object.freeze({
      path: candidate,
      device: metadata.dev,
      inode: metadata.ino,
    });
  } catch (error) {
    if (error instanceof FluxError) throw error;
    return pathFailure(`${label} could not be bound to an ordinary directory`);
  }
};

const sameDirectoryObject = (left: DirectoryBinding, right: DirectoryBinding): boolean =>
  left.device === right.device && left.inode === right.inode;

const assertStableDirectory = async (
  binding: DirectoryBinding,
  label: string,
): Promise<void> => {
  const current = await bindDirectory(binding.path, label);
  if (!sameDirectoryObject(current, binding)) {
    pathFailure(`${label} was replaced after the store bound it`);
  }
};

const createAndBindDirectory = async (
  candidate: string,
  parent: DirectoryBinding,
  label: string,
): Promise<DirectoryBinding> => {
  if (!isStrictlyWithin(parent.path, candidate) || !samePath(path.dirname(candidate), parent.path)) {
    return pathFailure(`${label} escapes its bound parent`);
  }
  await assertStableDirectory(parent, `${label} parent`);
  try {
    await mkdir(candidate);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  await assertStableDirectory(parent, `${label} parent`);
  const binding = await bindDirectory(candidate, label);
  const physicalParent = await realpath(parent.path);
  const physicalCandidate = await realpath(candidate);
  if (!isStrictlyWithin(physicalParent, physicalCandidate)) {
    return pathFailure(`${label} escapes the Flux compilation-bundle root`);
  }
  return binding;
};

const fileBinding = (metadata: BigIntStats): FileBinding => Object.freeze({
  device: metadata.dev,
  inode: metadata.ino,
  mode: metadata.mode,
  linkCount: metadata.nlink,
  size: metadata.size,
  modifiedNs: metadata.mtimeNs,
  changedNs: metadata.ctimeNs,
  createdNs: metadata.birthtimeNs,
});

const sameFileObject = (left: FileBinding, right: FileBinding): boolean =>
  left.device === right.device
  && left.inode === right.inode
  && left.mode === right.mode;

const sameFileVersion = (left: FileBinding, right: FileBinding): boolean =>
  sameFileObject(left, right)
  && left.linkCount === right.linkCount
  && left.size === right.size
  && left.modifiedNs === right.modifiedNs
  && left.changedNs === right.changedNs
  && left.createdNs === right.createdNs;

const sameContentIdentity = (left: ContentIdentity, right: ContentIdentity): boolean =>
  left.algorithm === right.algorithm
  && left.size === right.size
  && constantTimeDigestEqual(left.digest, right.digest);

const ensureExpectedIdentity = (actual: ContentIdentity, expected: ContentIdentity): void => {
  if (!sameContentIdentity(actual, expected)) {
    integrityFailure("Stored compilation-bundle bytes do not match their exact content identity");
  }
};

/**
 * Content-addressed persistence for fully authenticated PCB compilation bundles.
 * Its on-disk layout is FileContentStore-compatible, but its bounded handle I/O
 * is deliberately narrower than FileContentStore's general-purpose API.
 * Portable Node.js exposes neither openat/linkat nor a deny-hard-link lease, so
 * a syscall-width namespace race cannot be eliminated; every observable link
 * transition is nevertheless bounded, checked before/after, and failed closed.
 */
export class FileFluxCompilationBundleStore implements FluxCompilationBundleStore {
  public readonly workspaceRoot: string;

  readonly #contentRoot: string;
  readonly #blobRoot: string;
  readonly #stagingRoot: string;
  readonly #bundleDependencies: PcbDesignCompilationBundleDependencies;
  readonly #testHooks: FileFluxCompilationBundleStoreTestHooks;
  readonly #inflightPuts = new Map<string, Promise<PcbDesignCompilationBundleRef>>();
  readonly #shardBindings = new Map<string, DirectoryBinding>();
  readonly #blobBindings = new Map<string, FileBinding>();
  #initialization: Promise<void> | undefined;
  #directoryBindings: readonly DirectoryBinding[] = [];
  #sha256Binding: DirectoryBinding | undefined;
  #stagingBinding: DirectoryBinding | undefined;

  public constructor(
    workspaceRoot: string,
    bundleDependencies: PcbDesignCompilationBundleDependencies,
    options: FileFluxCompilationBundleStoreOptions = {},
  ) {
    this.workspaceRoot = canonicalWorkspaceRoot(workspaceRoot);
    this.#contentRoot = path.join(this.workspaceRoot, "content", "compilation-bundles");
    this.#blobRoot = path.join(this.#contentRoot, "blobs", "sha256");
    this.#stagingRoot = path.join(this.#contentRoot, "staging");
    this.#bundleDependencies = bundleDependencies;
    this.#testHooks = options.testHooks ?? {};
  }

  public async put(
    input: unknown | PcbDesignCompilationBundle,
  ): Promise<PcbDesignCompilationBundleRef> {
    const bundle = parsePcbDesignCompilationBundle(input, this.#bundleDependencies);
    const bytes = serializePcbDesignCompilationBundle(bundle);
    if (bytes.byteLength > PCB_DESIGN_COMPILATION_BUNDLE_LIMITS.maxBundleBytes) {
      throw new FluxError("INVALID_ARGUMENT", "Flux compilation bundle exceeds its hard byte limit");
    }
    const reference = parsePcbDesignCompilationBundleRef(
      createPcbDesignCompilationBundleRef(bundle),
    );
    ensureExpectedIdentity(contentIdentity(bytes), reference.contentIdentity);

    const key = `${reference.contentIdentity.digest}:${reference.contentIdentity.size}`;
    const existing = this.#inflightPuts.get(key);
    if (existing !== undefined) return existing;

    const operation = this.#persistAndVerify(reference, bytes);
    this.#inflightPuts.set(key, operation);
    const clear = (): void => {
      if (this.#inflightPuts.get(key) === operation) this.#inflightPuts.delete(key);
    };
    void operation.then(clear, clear);
    return operation;
  }

  public async get(
    input: unknown | PcbDesignCompilationBundleRef,
  ): Promise<PcbDesignCompilationBundle> {
    const reference = parsePcbDesignCompilationBundleRef(input);
    const bytes = await this.#readExact(reference.contentIdentity);
    return verifyPcbDesignCompilationBundleRef(reference, bytes, this.#bundleDependencies);
  }

  async #persistAndVerify(
    reference: PcbDesignCompilationBundleRef,
    bytes: Buffer,
  ): Promise<PcbDesignCompilationBundleRef> {
    await this.#initialize();
    const shard = await this.#bindShard(reference.contentIdentity.digest.slice(0, 2), true);
    const target = this.#targetPath(reference.contentIdentity, shard);
    const existing = await this.#inspectTargetPath(target, shard, true);
    let expectedTarget = existing;
    if (existing === undefined) {
      const staged = await this.#writeStaging(bytes);
      try {
        expectedTarget = await this.#publishStaging(staged.path, staged.binding, target, shard);
      } finally {
        await this.#removeStagingSafely(staged.path, staged.binding);
      }
    }
    if (expectedTarget === undefined) {
      return integrityFailure("Compilation-bundle publish produced no bound target");
    }

    const persistedBytes = await this.#readExact(reference.contentIdentity, expectedTarget);
    verifyPcbDesignCompilationBundleRef(reference, persistedBytes, this.#bundleDependencies);
    return reference;
  }

  async #initialize(): Promise<void> {
    if (this.#initialization === undefined) this.#initialization = this.#initializeOnce();
    return this.#initialization;
  }

  async #initializeOnce(): Promise<void> {
    const workspace = await bindDirectory(this.workspaceRoot, "Flux workspace root");
    const content = await createAndBindDirectory(path.join(workspace.path, "content"), workspace, "Flux content directory");
    const bundleRoot = await createAndBindDirectory(path.join(content.path, "compilation-bundles"), content, "Flux compilation-bundle directory");
    const blobs = await createAndBindDirectory(path.join(bundleRoot.path, "blobs"), bundleRoot, "Flux compilation-bundle blob directory");
    const sha256 = await createAndBindDirectory(path.join(blobs.path, "sha256"), blobs, "Flux compilation-bundle SHA-256 directory");
    const staging = await createAndBindDirectory(path.join(bundleRoot.path, "staging"), bundleRoot, "Flux compilation-bundle staging directory");
    if (!samePath(bundleRoot.path, this.#contentRoot)
      || !samePath(sha256.path, this.#blobRoot)
      || !samePath(staging.path, this.#stagingRoot)) {
      pathFailure("Flux compilation-bundle storage roots do not match their fixed layout");
    }
    this.#directoryBindings = Object.freeze([workspace, content, bundleRoot, blobs, sha256, staging]);
    this.#sha256Binding = sha256;
    this.#stagingBinding = staging;
    await this.#assertInfrastructureStable();
  }

  async #assertInfrastructureStable(): Promise<void> {
    if (this.#directoryBindings.length !== 6) {
      throw new FluxError("STORE_CORRUPT", "Compilation-bundle store is not initialized");
    }
    await Promise.all(this.#directoryBindings.map((binding, index) =>
      assertStableDirectory(binding, `Flux compilation-bundle directory ${index}`)));
  }

  async #bindShard(prefix: string, create: boolean): Promise<DirectoryBinding> {
    if (!/^[0-9a-f]{2}$/u.test(prefix)) {
      throw new FluxError("STORE_CORRUPT", "Compilation-bundle digest prefix is invalid");
    }
    await this.#initialize();
    await this.#assertInfrastructureStable();
    const sha256 = this.#sha256Binding;
    if (sha256 === undefined) {
      throw new FluxError("STORE_CORRUPT", "Compilation-bundle SHA-256 root is not bound");
    }
    const shardPath = path.join(this.#blobRoot, prefix);
    let current: DirectoryBinding;
    if (create) {
      current = await createAndBindDirectory(shardPath, sha256, "Flux compilation-bundle digest shard");
    } else {
      try {
        current = await bindDirectory(shardPath, "Flux compilation-bundle digest shard");
      } catch (error) {
        if (error instanceof FluxError && !(await this.#pathExists(shardPath))) return missingFailure();
        throw error;
      }
    }
    const physicalRoot = await realpath(this.#blobRoot);
    const physicalShard = await realpath(current.path);
    if (!isStrictlyWithin(physicalRoot, physicalShard)) {
      return pathFailure("Compilation-bundle digest shard escapes the bound SHA-256 root");
    }
    const bound = this.#shardBindings.get(prefix);
    if (bound !== undefined && !sameDirectoryObject(bound, current)) {
      return pathFailure("Compilation-bundle digest shard was replaced after it was bound");
    }
    if (bound === undefined) this.#shardBindings.set(prefix, current);
    return bound ?? current;
  }

  async #assertShardStable(shard: DirectoryBinding): Promise<void> {
    await this.#assertInfrastructureStable();
    await assertStableDirectory(shard, "Flux compilation-bundle digest shard");
    const physicalRoot = await realpath(this.#blobRoot);
    const physicalShard = await realpath(shard.path);
    if (!isStrictlyWithin(physicalRoot, physicalShard)) {
      pathFailure("Compilation-bundle digest shard left its bound SHA-256 root");
    }
  }

  #targetPath(identity: ContentIdentity, shard: DirectoryBinding): string {
    const target = path.join(shard.path, identity.digest.slice(2));
    if (!isStrictlyWithin(this.#blobRoot, target)
      || !samePath(path.dirname(target), shard.path)
      || path.basename(target) !== identity.digest.slice(2)) {
      return pathFailure("Compilation-bundle identity produced an invalid blob path");
    }
    return target;
  }

  async #inspectTargetPath(target: string, shard: DirectoryBinding, allowMissing: boolean): Promise<FileBinding | undefined> {
    await this.#assertShardStable(shard);
    let metadata: BigIntStats;
    try {
      metadata = await lstat(target, { bigint: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        if (allowMissing) return undefined;
        return missingFailure();
      }
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      return pathFailure("Compilation-bundle blob must be an ordinary non-link file");
    }
    const physicalTarget = await realpath(target);
    if (!samePath(target, physicalTarget)
      || !isStrictlyWithin(shard.path, physicalTarget)
      || !isStrictlyWithin(this.#blobRoot, physicalTarget)) {
      return pathFailure("Compilation-bundle blob resolves outside its bound digest shard");
    }
    return fileBinding(metadata);
  }

  async #assertOpenedTarget(target: string, shard: DirectoryBinding, opened: FileBinding, requireSameVersion: boolean): Promise<void> {
    const pathBinding = await this.#inspectTargetPath(target, shard, false);
    if (pathBinding === undefined
      || (requireSameVersion ? !sameFileVersion(pathBinding, opened) : !sameFileObject(pathBinding, opened))) {
      return integrityFailure("Compilation-bundle blob path changed while its file handle was open");
    }
  }

  async #readExact(identity: ContentIdentity, requiredTarget?: FileBinding): Promise<Buffer> {
    await this.#initialize();
    const shard = await this.#bindShard(identity.digest.slice(0, 2), false);
    const target = this.#targetPath(identity, shard);
    const beforePath = await this.#inspectTargetPath(target, shard, false);
    if (beforePath === undefined) return missingFailure();
    const previouslyBound = this.#blobBindings.get(identity.digest);
    if ((requiredTarget !== undefined && !sameFileObject(requiredTarget, beforePath))
      || (previouslyBound !== undefined && !sameFileObject(previouslyBound, beforePath))) {
      return integrityFailure("Compilation-bundle blob was replaced after its file identity was bound");
    }
    if (beforePath.linkCount !== 1n
      || beforePath.size !== BigInt(identity.size)
      || beforePath.size > BigInt(PCB_DESIGN_COMPILATION_BUNDLE_LIMITS.maxBundleBytes)) {
      return integrityFailure("Compilation-bundle blob link count or size violates its bounded identity");
    }

    await this.#testHooks.afterReadPathValidation?.();

    let handle: FileHandle;
    try {
      handle = await open(target, READ_FLAGS);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return integrityFailure("Compilation-bundle blob disappeared while it was opened");
      if (errorCode(error) === "ELOOP") return pathFailure("Compilation-bundle blob became a link while it was opened");
      throw error;
    }

    try {
      const openedMetadata = await handle.stat({ bigint: true });
      if (!openedMetadata.isFile()) return integrityFailure("Opened compilation-bundle object is not an ordinary file");
      const opened = fileBinding(openedMetadata);
      if (!sameFileVersion(beforePath, opened)
        || opened.linkCount !== 1n
        || opened.size !== BigInt(identity.size)
        || opened.size > BigInt(PCB_DESIGN_COMPILATION_BUNDLE_LIMITS.maxBundleBytes)) {
        return integrityFailure("Compilation-bundle blob changed before its bounded read");
      }
      await this.#assertOpenedTarget(target, shard, opened, true);
      await this.#testHooks.afterReadHandleValidation?.();

      const bytes = await this.#readHandleBounded(handle, identity.size);
      const after = fileBinding(await handle.stat({ bigint: true }));
      if (!sameFileVersion(opened, after)
        || after.linkCount !== 1n
        || after.size !== BigInt(bytes.byteLength)) {
        return integrityFailure("Compilation-bundle blob changed while it was read");
      }
      await this.#assertOpenedTarget(target, shard, after, true);
      ensureExpectedIdentity(contentIdentity(bytes), identity);
      const bound = this.#blobBindings.get(identity.digest);
      if (bound !== undefined && !sameFileObject(bound, after)) {
        return integrityFailure("Compilation-bundle blob changed before its verified identity could be retained");
      }
      if (bound === undefined) this.#blobBindings.set(identity.digest, after);
      return bytes;
    } finally {
      await handle.close();
    }
  }

  async #readHandleBounded(handle: FileHandle, expectedBytes: number): Promise<Buffer> {
    const hardLimit = Math.min(expectedBytes, PCB_DESIGN_COMPILATION_BUNDLE_LIMITS.maxBundleBytes) + 1;
    const bounded = Buffer.allocUnsafe(hardLimit);
    let total = 0;
    while (total < hardLimit) {
      const capacity = Math.min(READ_CHUNK_BYTES, hardLimit - total);
      const { bytesRead } = await handle.read(bounded, total, capacity, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      await this.#testHooks.onReadChunk?.(bytesRead, total);
    }
    if (total !== expectedBytes) {
      return integrityFailure("Compilation-bundle blob was truncated or grew beyond its exact bounded size");
    }
    return bounded.subarray(0, total);
  }

  async #writeStaging(bytes: Buffer): Promise<{ readonly path: string; readonly binding: FileBinding }> {
    await this.#assertInfrastructureStable();
    const staging = this.#stagingBinding;
    if (staging === undefined) throw new FluxError("STORE_CORRUPT", "Compilation-bundle staging root is not bound");
    const stagingPath = path.join(staging.path, `${randomUUID()}.tmp`);
    if (!isStrictlyWithin(staging.path, stagingPath) || !samePath(path.dirname(stagingPath), staging.path)) {
      return pathFailure("Compilation-bundle staging path escapes its bound root");
    }

    const handle = await open(stagingPath, CREATE_FLAGS, 0o600);
    let lastBinding: FileBinding | undefined;
    let openedBinding: FileBinding | undefined;
    try {
      const openedMetadata = await handle.stat({ bigint: true });
      if (!openedMetadata.isFile() || openedMetadata.size !== 0n || openedMetadata.nlink !== 1n) {
        return integrityFailure("Compilation-bundle staging object is not a new ordinary file");
      }
      const opened = fileBinding(openedMetadata);
      openedBinding = opened;
      await this.#assertOpenedStaging(stagingPath, staging, opened, true);
      await this.#testHooks.afterStageHandleValidation?.();
      await this.#assertOpenedStaging(stagingPath, staging, opened, true);

      let offset = 0;
      while (offset < bytes.byteLength) {
        const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
        if (bytesWritten <= 0) return integrityFailure("Compilation-bundle staging write made no progress");
        offset += bytesWritten;
      }
      await this.#testHooks.afterStageWriteBeforeSync?.();
      const afterWrite = fileBinding(await handle.stat({ bigint: true }));
      if (!sameFileObject(opened, afterWrite)
        || afterWrite.linkCount !== 1n
        || afterWrite.size !== BigInt(bytes.byteLength)) {
        return await this.#rejectAndScrubUnpublishedStaging(
          handle,
          "Compilation-bundle staging link count or size changed during its write",
        );
      }
      await handle.sync();
      const afterSync = fileBinding(await handle.stat({ bigint: true }));
      if (!sameFileVersion(afterWrite, afterSync) || afterSync.linkCount !== 1n) {
        return await this.#rejectAndScrubUnpublishedStaging(
          handle,
          "Compilation-bundle staging object changed while it was synchronized",
        );
      }
      try {
        await this.#assertOpenedStaging(stagingPath, staging, afterSync, true);
      } catch {
        return await this.#rejectAndScrubUnpublishedStaging(
          handle,
          "Compilation-bundle staging path or link count changed after synchronization",
        );
      }
      lastBinding = afterSync;
      return Object.freeze({ path: stagingPath, binding: afterSync });
    } finally {
      await handle.close();
      if (lastBinding === undefined && openedBinding !== undefined) {
        await this.#removeStagingSafely(stagingPath, openedBinding);
      }
    }
  }

  async #rejectAndScrubUnpublishedStaging(
    handle: FileHandle,
    message: string,
  ): Promise<never> {
    try {
      // The descriptor remains bound even if an alias was added. Clearing it
      // prevents an unexpected pre-publication hard link from retaining bytes.
      await handle.truncate(0);
      await handle.sync();
    } catch {
      // Integrity rejection is mandatory even if best-effort scrubbing fails.
    }
    return integrityFailure(message);
  }

  async #assertOpenedStaging(
    stagingPath: string,
    staging: DirectoryBinding,
    opened: FileBinding,
    requireSameVersion: boolean,
  ): Promise<FileBinding> {
    await this.#assertInfrastructureStable();
    await assertStableDirectory(staging, "Flux compilation-bundle staging directory");
    const metadata = await lstat(stagingPath, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      return pathFailure("Compilation-bundle staging path became a link or non-file");
    }
    const physical = await realpath(stagingPath);
    const pathBound = fileBinding(metadata);
    if (!samePath(stagingPath, physical)
      || !isStrictlyWithin(staging.path, physical)
      || (requireSameVersion ? !sameFileVersion(pathBound, opened) : !sameFileObject(pathBound, opened))) {
      return pathFailure("Compilation-bundle staging path changed while its handle was open");
    }
    return pathBound;
  }

  async #publishStaging(
    stagingPath: string,
    stagingFile: FileBinding,
    target: string,
    shard: DirectoryBinding,
  ): Promise<FileBinding> {
    const staging = this.#stagingBinding;
    if (staging === undefined) throw new FluxError("STORE_CORRUPT", "Compilation-bundle staging root is not bound");
    let created = false;
    try {
      if (stagingFile.linkCount !== 1n) {
        return integrityFailure("Compilation-bundle staging file has an unexpected pre-publish link count");
      }
      await this.#assertOpenedStaging(stagingPath, staging, stagingFile, true);
      await this.#assertShardStable(shard);
      const existing = await this.#inspectTargetPath(target, shard, true);
      if (existing !== undefined) return existing;
      await this.#testHooks.afterPublishPathValidation?.();

      await this.#assertOpenedStaging(stagingPath, staging, stagingFile, true);
      await this.#assertShardStable(shard);
      const racedExisting = await this.#inspectTargetPath(target, shard, true);
      if (racedExisting !== undefined) return racedExisting;
      try {
        await link(stagingPath, target);
        created = true;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }

      await this.#assertShardStable(shard);
      let published = await this.#inspectTargetPath(target, shard, false);
      if (published === undefined) return integrityFailure("Compilation-bundle publish target disappeared");
      if (created) {
        const stagedAfterLink = await this.#assertOpenedStaging(
          stagingPath,
          staging,
          stagingFile,
          false,
        );
        if (!sameFileObject(stagingFile, published)
          || published.linkCount !== 2n
          || stagedAfterLink.linkCount !== 2n
          || !sameFileVersion(published, stagedAfterLink)) {
          return integrityFailure("Compilation-bundle publish did not make the exact one-to-two link transition");
        }
        await syncContainingDirectory(target);
        await this.#assertShardStable(shard);
        published = await this.#requirePublishedPair(
          stagingPath,
          staging,
          stagingFile,
          target,
          shard,
        );
      } else if (published.linkCount !== 1n) {
        return integrityFailure("Concurrent compilation-bundle target has an unexpected link count");
      }

      await this.#testHooks.afterPublish?.();
      if (created) {
        return await this.#requirePublishedPair(
          stagingPath,
          staging,
          stagingFile,
          target,
          shard,
        );
      }
      const afterHook = await this.#inspectTargetPath(target, shard, false);
      if (afterHook === undefined
        || afterHook.linkCount !== 1n
        || !sameFileVersion(published, afterHook)) {
        return integrityFailure("Concurrent compilation-bundle target changed before verification");
      }
      return afterHook;
    } catch (error) {
      if (created) await this.#removePublishedSafely(target, stagingFile, shard);
      await this.#scrubStagingSafely(stagingPath, stagingFile, staging);
      throw error;
    }
  }

  async #requirePublishedPair(
    stagingPath: string,
    staging: DirectoryBinding,
    stagingFile: FileBinding,
    target: string,
    shard: DirectoryBinding,
  ): Promise<FileBinding> {
    const [staged, published] = await Promise.all([
      this.#assertOpenedStaging(stagingPath, staging, stagingFile, false),
      this.#inspectTargetPath(target, shard, false),
    ]);
    if (published === undefined
      || staged.linkCount !== 2n
      || published.linkCount !== 2n
      || !sameFileObject(stagingFile, staged)
      || !sameFileVersion(staged, published)) {
      return integrityFailure("Published compilation bundle has an unexpected hard-link topology");
    }
    return published;
  }

  async #removePublishedSafely(
    target: string,
    expected: FileBinding,
    shard: DirectoryBinding,
  ): Promise<void> {
    try {
      const current = await this.#inspectTargetPath(target, shard, true);
      if (current === undefined || !sameFileObject(current, expected)) return;
      await rm(target);
      await syncContainingDirectory(target);
    } catch {
      // If destination identity is uncertain, never unlink through that path.
    }
  }

  async #scrubStagingSafely(
    stagingPath: string,
    expected: FileBinding,
    staging: DirectoryBinding,
  ): Promise<void> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(stagingPath, fsConstants.O_WRONLY | NO_FOLLOW);
      const openedMetadata = await handle.stat({ bigint: true });
      if (!openedMetadata.isFile()) return;
      const opened = fileBinding(openedMetadata);
      if (!sameFileObject(opened, expected)) return;
      await this.#assertOpenedStaging(stagingPath, staging, opened, false);
      await handle.truncate(0);
      await handle.sync();
    } catch {
      // Portable Node cannot reopen relative to a directory handle. If this
      // pathname is no longer provably bound, leave it untouched and fail.
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async #removeStagingSafely(stagingPath: string, expected: FileBinding): Promise<void> {
    try {
      const staging = this.#stagingBinding;
      if (staging === undefined) return;
      await this.#assertInfrastructureStable();
      await assertStableDirectory(staging, "Flux compilation-bundle staging directory");
      const metadata = await lstat(stagingPath, { bigint: true });
      if (metadata.isSymbolicLink() || !metadata.isFile()) return;
      const current = fileBinding(metadata);
      if (!sameFileObject(current, expected)) return;
      const physical = await realpath(stagingPath);
      if (!samePath(stagingPath, physical) || !isStrictlyWithin(staging.path, physical)) return;
      await rm(stagingPath);
      await syncContainingDirectory(stagingPath);
    } catch {
      // Do not follow an uncertain pathname merely to remove a temporary file.
    }
  }

  async #pathExists(candidate: string): Promise<boolean> {
    try {
      await lstat(candidate);
      return true;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }
  }
}
