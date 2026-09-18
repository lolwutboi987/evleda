import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, opendir, realpath, unlink } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { canonicalJson, contentIdentity } from "../core/canonical.js";
import { hardenPortableValue, parsePortableJsonBytes, validateContentIdentity } from "../core/portable-artifact.js";
import type { ContentIdentity } from "../domain/types.js";
import { validateFreshProjectName } from "../harness/fresh-project.js";
import { schematicSeedLineageSchema, parseSchematicSeedLineage, type SchematicSeedLineage } from "./toolbox-schematic-seed.js";
import { runtimeSourceImportLineageSchema, parseRuntimeSourceImportLineage, type RuntimeSourceImportLineage } from "./toolbox-runtime-source-import.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DRAFT_LIMIT = 256 * 1024;
const MANIFEST_LIMIT = 64 * 1024;
const MAX_PROJECTS = 10_000;
const MANIFEST = "allocation.json";
const DRAFT = "draft.json";
const LEASE = ".toolbox-lease.json";
const SCHEMA = "evleda.toolbox-workspace-allocation.v1";
const jsonLimits = { maxBytes: DRAFT_LIMIT, maxDepth: 40, maxNodes: 120_000,
  maxArrayLength: 1024, maxOwnKeys: 2048, maxKeyBytes: 512, maxStringBytes: 64 * 1024 } as const;
const manifestSchema = z.object({ schemaVersion: z.literal(SCHEMA), projectId: z.string().regex(UUID),
  name: z.string(), originalPrompt: z.string().min(1), draftIdentity: z.object({
    algorithm: z.literal("sha256"), digest: z.string().regex(/^[0-9a-f]{64}$/u), size: z.number().int().min(1).max(DRAFT_LIMIT),
  }).strict(), schematicSeedLineage: schematicSeedLineageSchema.optional(), runtimeSourceImportLineage: runtimeSourceImportLineageSchema.optional() }).strict()
  .refine(value => value.schematicSeedLineage === undefined || value.runtimeSourceImportLineage === undefined, "Distinct seed/import lineage cannot be combined");

export class ToolboxWorkspaceStoreError extends Error {
  public constructor(public readonly code: "INVALID_ARGUMENT" | "NEEDS_REVIEW" | "LEASE_HELD", message: string) {
    super(message); this.name = "ToolboxWorkspaceStoreError";
  }
}
export interface ToolboxWorkspaceAllocationInput {
  readonly projectId: string;
  readonly name: string;
  readonly draft: unknown;
  readonly originalPrompt: string;
  /** SHA-256 identity of canonicalJson(draft), UTF-8, without a trailing newline. */
  readonly draftIdentity: ContentIdentity;
  readonly schematicSeedLineage?: SchematicSeedLineage;
  readonly runtimeSourceImportLineage?: RuntimeSourceImportLineage;
}
export interface ToolboxWorkspaceProject {
  readonly projectId: string;
  readonly name: string;
  readonly inputDir: string;
  readonly outputDir: string;
}
export interface ToolboxWorkspaceRecord extends ToolboxWorkspaceProject {
  readonly originalPrompt: string;
  readonly draftIdentity: ContentIdentity;
  readonly draft: unknown;
  readonly schematicSeedLineage?: SchematicSeedLineage;
  readonly runtimeSourceImportLineage?: RuntimeSourceImportLineage;
}
export interface ToolboxWorkspaceStore {
  allocate(input: ToolboxWorkspaceAllocationInput): Promise<ToolboxWorkspaceProject & { readonly created: boolean }>;
  lookup(projectId: string): Promise<ToolboxWorkspaceRecord | undefined>;
  list(options?: { readonly offset?: number; readonly limit?: number }): Promise<{
    readonly projects: readonly ToolboxWorkspaceProject[]; readonly offset: number; readonly limit: number; readonly total: number;
  }>;
  acquireLease(projectId: string): Promise<{ release(): Promise<void>; assertCurrent?(): Promise<void> }>;
}

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const exists = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "EEXIST";
const comparable = (value: string): string => process.platform === "win32" ? value.toLowerCase() : value;
const samePath = (a: string, b: string): boolean => comparable(a) === comparable(b);
const contains = (a: string, b: string): boolean => {
  const relative = path.relative(comparable(a), comparable(b));
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const sameFile = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
const review = (message: string): never => { throw new ToolboxWorkspaceStoreError("NEEDS_REVIEW", message); };
function projectId(value: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new ToolboxWorkspaceStoreError("INVALID_ARGUMENT", "Project ID must be a canonical host-generated UUID.");
  return value;
}
function safeName(value: string): string {
  try { if (typeof value === "string" && validateFreshProjectName(value) === value) return value; } catch { /* normalized below */ }
  throw new ToolboxWorkspaceStoreError("INVALID_ARGUMENT", "Project name must be an already validated fresh name.");
}

/** Inspect only the path ancestry, never the contents of unrelated directories. */
async function directory(candidate: string): Promise<BigIntStats> {
  const metadata = await lstat(candidate, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !samePath(await realpath(candidate), candidate)) {
    return review("Workspace directory is a link, alias, or non-directory.");
  }
  return metadata;
}
async function ancestry(candidate: string): Promise<readonly { path: string; identity: BigIntStats }[]> {
  const result: { path: string; identity: BigIntStats }[] = [];
  for (let cursor = candidate; ; cursor = path.dirname(cursor)) {
    result.push({ path: cursor, identity: await directory(cursor) });
    if (path.dirname(cursor) === cursor) return result;
  }
}
async function protectedPath(candidate: string): Promise<string> {
  if (!path.isAbsolute(candidate)) throw new ToolboxWorkspaceStoreError("INVALID_ARGUMENT", "Protected resources require absolute host paths.");
  const absolute = path.resolve(candidate);
  let cursor = absolute;
  for (;;) {
    try {
      const metadata = await lstat(cursor);
      if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile()) || !samePath(await realpath(cursor), cursor)) {
        return review("Protected resource has an unsupported path alias.");
      }
      if (cursor !== absolute && !metadata.isDirectory()) return review("Protected resource has a non-directory ancestor.");
      await ancestry(metadata.isDirectory() ? cursor : path.dirname(cursor));
      return absolute;
    } catch (error) {
      if (!missing(error)) throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
}

async function readOrdinary(file: string, maxBytes: number): Promise<Buffer> {
  const before = await lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maxBytes)) return review("Workspace record is not a bounded ordinary file.");
  const handle = await open(file, "r");
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameFile(before, opened)) return review("Workspace record changed while opening.");
    // A bounded buffer prevents a concurrently growing file from allocating without a limit.
    const bytes = Buffer.alloc(maxBytes + 1);
    let used = 0;
    while (used < bytes.length) {
      const read = await handle.read(bytes, used, bytes.length - used, used);
      if (read.bytesRead === 0) break;
      used += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(file, { bigint: true });
    if (used > maxBytes || BigInt(used) !== opened.size || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs
      || !sameFile(opened, after) || !sameFile(opened, current) || current.isSymbolicLink() || current.nlink !== 1n) {
      return review("Workspace record changed during its bounded read.");
    }
    return bytes.subarray(0, used);
  } finally { await handle.close(); }
}
async function writeExclusive(file: string, bytes: string): Promise<void> {
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(bytes, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
}

/** Exclusive ownership only; crashed locks require review, never PID-based reclamation. */
async function ownedLock(file: string, assertScope: () => Promise<void>, heldCode: "LEASE_HELD" | "NEEDS_REVIEW") {
  await assertScope();
  const bytes = canonicalJson({ schemaVersion: "evleda.toolbox-owned-lock.v1", nonce: randomUUID() });
  let handle;
  try { handle = await open(file, "wx", 0o600); }
  catch (error) {
    if (exists(error)) throw new ToolboxWorkspaceStoreError(heldCode, "Workspace lock is held; no stale lock reclamation is performed.");
    throw error;
  }
  try {
    await handle.writeFile(bytes, "utf8"); await handle.sync();
    const identity = await handle.stat({ bigint: true });
    await assertScope();
    let released = false;
    let releasing: Promise<void> | undefined;
    const assertCurrent = async () => {
      if (released) review("Owned lock has already been released.");
      await assertScope();
      const current = await lstat(file, { bigint: true });
      if (!sameFile(identity, current) || current.nlink !== 1n || current.isSymbolicLink()
          || (await readOrdinary(file, 1024)).toString("utf8") !== bytes) review("Lock is no longer the exact owned file; it was retained.");
    };
    return Object.freeze({ assertCurrent, release: (): Promise<void> => {
      if (released) return Promise.resolve();
      return releasing ??= (async () => {
        try {
          await assertCurrent();
          await unlink(file);
          released = true;
        } catch (error) {
          if (error instanceof ToolboxWorkspaceStoreError) throw error;
          review("Owned lock release could not be verified; no recovery was attempted.");
        } finally { await handle.close(); }
      })();
    } });
  } catch (error) { await handle.close(); throw error; }
}

/** A small filesystem catalog, not native resume authority or a stale-lock recovery service. */
export async function createToolboxWorkspaceStore(options: {
  readonly workspaceRoot: string; readonly protectedRoots: readonly string[];
}): Promise<ToolboxWorkspaceStore> {
  if (!path.isAbsolute(options.workspaceRoot)) throw new ToolboxWorkspaceStoreError("INVALID_ARGUMENT", "Workspace requires an existing absolute host directory.");
  const root = path.resolve(options.workspaceRoot);
  const roots = await Promise.all(options.protectedRoots.map(protectedPath));
  for (const fixed of roots) if (contains(root, fixed) || contains(fixed, root)) review("Workspace overlaps a protected resource.");
  const bound = await ancestry(root);
  const assertRoot = async (): Promise<void> => {
    for (const entry of bound) if (!sameFile(await directory(entry.path), entry.identity)) review("Workspace ancestry changed; explicit host review is required.");
    for (const fixed of roots) await protectedPath(fixed);
  };
  const projects = path.join(root, "projects");
  await assertRoot();
  try { await mkdir(projects); } catch (error) { if (!exists(error)) throw error; }
  const projectsIdentity = await directory(projects);
  const assertProjects = async (): Promise<void> => {
    await assertRoot();
    if (!sameFile(await directory(projects), projectsIdentity)) review("Workspace project directory changed.");
  };
  const paths = (id: string) => {
    const projectRoot = path.join(projects, projectId(id));
    return { projectRoot, inputDir: path.join(projectRoot, "input"), outputDir: path.join(projectRoot, "output") };
  };
  const publicRecord = (record: ToolboxWorkspaceProject): ToolboxWorkspaceProject => Object.freeze({
    projectId: record.projectId, name: record.name, inputDir: record.inputDir, outputDir: record.outputDir,
  });
  const catalogIds = async (): Promise<string[]> => {
    await assertProjects();
    const ids: string[] = [];
    for await (const entry of await opendir(projects)) {
      if (!UUID.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) review("Workspace contains an unrecognized project entry.");
      ids.push(entry.name);
      if (ids.length > MAX_PROJECTS) review("Workspace listing exceeds the supported catalog bound.");
    }
    await assertProjects();
    return ids;
  };
  const lookup = async (id: string): Promise<ToolboxWorkspaceRecord | undefined> => {
    const locations = paths(id);
    await assertProjects();
    try { await lstat(locations.projectRoot); } catch (error) { if (missing(error)) return undefined; throw error; }
    try {
      const before = await directory(locations.projectRoot);
      const inputIdentity = await directory(locations.inputDir);
      const outputIdentity = await directory(locations.outputDir);
      const manifestBytes = await readOrdinary(path.join(locations.projectRoot, MANIFEST), MANIFEST_LIMIT);
      const manifest = manifestSchema.parse(parsePortableJsonBytes(manifestBytes, { ...jsonLimits, maxBytes: MANIFEST_LIMIT }));
      const lineage = manifest.schematicSeedLineage === undefined ? undefined : parseSchematicSeedLineage(manifest.schematicSeedLineage);
      const runtimeLineage = manifest.runtimeSourceImportLineage === undefined ? undefined : parseRuntimeSourceImportLineage(manifest.runtimeSourceImportLineage);
      if (lineage !== undefined && (lineage.targetProjectId !== id || lineage.sourceProjectId === id)) review("Seed lineage differs from its immutable allocation.");
      if (runtimeLineage !== undefined && (runtimeLineage.targetProjectId !== id || runtimeLineage.sourceProjectId === id)) review("Runtime import lineage differs from its immutable allocation.");
      if (manifest.projectId !== id || safeName(manifest.name) !== manifest.name || Buffer.byteLength(manifest.originalPrompt, "utf8") > 32 * 1024
        || !manifest.originalPrompt.trim() || canonicalJson(manifest) !== manifestBytes.toString("utf8")) review("Workspace allocation manifest is inconsistent.");
      const draftBytes = await readOrdinary(path.join(locations.inputDir, DRAFT), DRAFT_LIMIT);
      const draft = parsePortableJsonBytes(draftBytes, jsonLimits);
      if (canonicalJson(draft) !== draftBytes.toString("utf8") || canonicalJson(contentIdentity(draftBytes)) !== canonicalJson(manifest.draftIdentity)) {
        review("Workspace draft does not match its immutable allocation.");
      }
      if (!sameFile(before, await directory(locations.projectRoot))) review("Project directory changed during lookup.");
      if (!sameFile(inputIdentity, await directory(locations.inputDir)) || !sameFile(outputIdentity, await directory(locations.outputDir))) {
        review("Project input/output directory changed during lookup.");
      }
      await assertProjects();
      return Object.freeze({ ...publicRecord({ ...manifest, ...locations }), originalPrompt: manifest.originalPrompt,
        draftIdentity: Object.freeze({ ...manifest.draftIdentity }), draft, ...(lineage === undefined ? {} : { schematicSeedLineage: lineage }),
        ...(runtimeLineage === undefined ? {} : { runtimeSourceImportLineage: runtimeLineage }) });
    } catch (error) {
      if (error instanceof ToolboxWorkspaceStoreError && error.code === "NEEDS_REVIEW") throw error;
      return review("Workspace allocation is incomplete or inconsistent; existing files were retained for review.");
    }
  };
  const allocate: ToolboxWorkspaceStore["allocate"] = async input => {
    const id = projectId(input.projectId); const name = safeName(input.name);
    let draft: unknown; let identity: ContentIdentity;
    try { draft = hardenPortableValue(input.draft, jsonLimits); identity = validateContentIdentity(input.draftIdentity); }
    catch { throw new ToolboxWorkspaceStoreError("INVALID_ARGUMENT", "Draft and identity must be bounded portable JSON."); }
    const draftBytes = canonicalJson(draft);
    if (Buffer.byteLength(draftBytes, "utf8") > DRAFT_LIMIT || canonicalJson(contentIdentity(draftBytes)) !== canonicalJson(identity)) {
      throw new ToolboxWorkspaceStoreError("INVALID_ARGUMENT", "Draft identity must match canonical draft bytes.");
    }
    if (typeof input.originalPrompt !== "string" || !input.originalPrompt.trim() || Buffer.byteLength(input.originalPrompt, "utf8") > 32 * 1024) {
      throw new ToolboxWorkspaceStoreError("INVALID_ARGUMENT", "Original prompt must be nonempty and at most 32 KiB.");
    }
    const lineage = input.schematicSeedLineage === undefined ? undefined : parseSchematicSeedLineage(input.schematicSeedLineage);
    const runtimeLineage = input.runtimeSourceImportLineage === undefined ? undefined : parseRuntimeSourceImportLineage(input.runtimeSourceImportLineage);
    if (lineage !== undefined && runtimeLineage !== undefined) throw new ToolboxWorkspaceStoreError("INVALID_ARGUMENT", "Seed and runtime import lineage cannot be combined.");
    if (lineage !== undefined && (lineage.targetProjectId !== id || lineage.sourceProjectId === id)) throw new ToolboxWorkspaceStoreError("INVALID_ARGUMENT", "Seed lineage must identify this new allocation and a different source.");
    if (runtimeLineage !== undefined && (runtimeLineage.targetProjectId !== id || runtimeLineage.sourceProjectId === id)) throw new ToolboxWorkspaceStoreError("INVALID_ARGUMENT", "Runtime import lineage must identify this new allocation and a different source.");
    const manifest = { schemaVersion: SCHEMA, projectId: id, name, originalPrompt: input.originalPrompt, draftIdentity: identity,
      ...(lineage === undefined ? {} : { schematicSeedLineage: lineage }), ...(runtimeLineage === undefined ? {} : { runtimeSourceImportLineage: runtimeLineage }) };
    const manifestBytes = canonicalJson(hardenPortableValue(manifest, { ...jsonLimits, maxBytes: MANIFEST_LIMIT }));
    const locations = paths(id);
    const replay = (previous: ToolboxWorkspaceRecord | undefined) => {
      if (previous === undefined || previous.name !== name || previous.originalPrompt !== input.originalPrompt
        || canonicalJson(previous.draftIdentity) !== canonicalJson(identity) || canonicalJson(previous.draft) !== draftBytes
        || canonicalJson(previous.schematicSeedLineage ?? null) !== canonicalJson(lineage ?? null)
        || canonicalJson(previous.runtimeSourceImportLineage ?? null) !== canonicalJson(runtimeLineage ?? null)) {
        return review("Existing project ID has a conflicting or incomplete allocation; nothing was overwritten.");
      }
      return Object.freeze({ ...publicRecord(previous), created: false });
    };
    // Exact existing allocations remain replayable even when the catalog is full.
    const previous = await lookup(id);
    if (previous !== undefined) return replay(previous);
    // Serialize only catalog admission across processes. The reserved directory
    // counts toward capacity immediately; preparation/native work holds no global lock.
    const admission = await ownedLock(path.join(root, ".toolbox-admission.json"), assertProjects, "NEEDS_REVIEW");
    try {
      const concurrent = await lookup(id);
      if (concurrent !== undefined) return replay(concurrent);
      if ((await catalogIds()).length >= MAX_PROJECTS) return review("Workspace has reached its project limit; no new allocation was created.");
      try { await mkdir(locations.projectRoot); }
      catch (error) {
        if (!exists(error)) throw error;
        return replay(await lookup(id));
      }
    } finally {
      await admission.release();
    }
    try {
      await directory(locations.projectRoot); await assertProjects();
      await mkdir(locations.inputDir); await mkdir(locations.outputDir);
      await directory(locations.inputDir); await directory(locations.outputDir);
      await writeExclusive(path.join(locations.inputDir, DRAFT), draftBytes);
      // Publish immutable allocation last. Partial creation is intentionally never repaired here.
      await writeExclusive(path.join(locations.projectRoot, MANIFEST), manifestBytes);
      const record = await lookup(id);
      if (record === undefined) return review("New allocation disappeared.");
      return Object.freeze({ ...publicRecord(record), created: true });
    } catch (error) {
      if (error instanceof ToolboxWorkspaceStoreError && error.code === "NEEDS_REVIEW") throw error;
      return review("Allocation did not complete; partial files were retained for review.");
    }
  };
  const list: ToolboxWorkspaceStore["list"] = async (input = {}) => {
    const offset = input.offset ?? 0; const limit = input.limit ?? 20;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_PROJECTS || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new ToolboxWorkspaceStoreError("INVALID_ARGUMENT", "List offset must be 0..10000 and limit 1..100.");
    }
    const ids = await catalogIds();
    ids.sort();
    const records: ToolboxWorkspaceProject[] = [];
    for (const id of ids.slice(offset, offset + limit)) {
      const record = await lookup(id);
      if (record === undefined) return review("Workspace project changed during listing.");
      records.push(publicRecord(record));
    }
    await assertProjects();
    return Object.freeze({ projects: Object.freeze(records), offset, limit, total: ids.length });
  };
  const acquireLease: ToolboxWorkspaceStore["acquireLease"] = async id => {
    const record = await lookup(id);
    if (record === undefined) throw new ToolboxWorkspaceStoreError("INVALID_ARGUMENT", "Cannot lease an unknown project.");
    const locations = paths(id);
    const projectIdentity = await directory(locations.projectRoot);
    const leasePath = path.join(locations.projectRoot, LEASE);
    return ownedLock(leasePath, async () => {
      await assertProjects();
      if (!sameFile(projectIdentity, await directory(locations.projectRoot))) review("Project changed; lease was retained.");
    }, "LEASE_HELD");
  };
  return Object.freeze({ allocate, lookup, list, acquireLease });
}
