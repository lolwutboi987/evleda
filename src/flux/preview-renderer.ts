import { copyFile, lstat, mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";

import {
  assertDisjointDirectories,
  assertPathWithin,
  resolveConfinedCandidate,
} from "../integrations/path-boundary.js";
import {
  KicadCliAdapter,
  type KicadPreviewExportResult,
} from "../integrations/kicad-cli.js";

export interface FluxPreviewRenderRequest {
  readonly schematicPath: string;
  readonly pcbPath: string;
  readonly signal?: AbortSignal;
}

export interface FluxPreviewArtifactManifestEntry {
  readonly name: "schematic.svg" | "board-top.png" | "board-bottom.png";
  readonly mediaType: "image/svg+xml" | "image/png";
  readonly sizeBytes: number;
  readonly sha256: string;
}

/** A path-free manifest suitable for a local Flux UI. */
export interface FluxPreviewRenderResult {
  readonly schemaVersion: "evleda.flux-preview.v1";
  readonly classification: "candidate-preview";
  readonly releaseAuthorized: false;
  readonly sourceHashes: Readonly<Record<string, string>>;
  readonly artifacts: readonly FluxPreviewArtifactManifestEntry[];
}

/** Runtime-only binding. `root` must never be projected into an HTTP response. */
export interface FluxPreviewRuntimeRender {
  readonly root: string;
  readonly result: FluxPreviewRenderResult;
}

export interface FluxPreviewRendererOptions {
  readonly adapter: KicadCliAdapter;
  /** Source workspace containing `projectRoot`. */
  readonly workspaceRoot: string;
  readonly projectRoot: string;
  /** Independent narrow boundary for preview artifacts. Defaults to `workspaceRoot`. */
  readonly outputRoot?: string;
  /** A confined parent under `outputRoot` for fresh, per-render revision directories. */
  readonly revisionRoot: string;
}

export class FluxPreviewRendererError extends Error {
  override readonly name = "FluxPreviewRendererError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** Observed safe realized mkdtemp path ceiling for the pinned Windows Node runtime. */
export const FLUX_PREVIEW_WINDOWS_REALIZED_PATH_LIMIT = 247;

interface OrdinaryDirectoryBinding {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: bigint;
  readonly createdNs: bigint;
}

const samePath = (left: string, right: string): boolean => process.platform === "win32"
  ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
  : left === right;

const bindOrdinaryDirectory = async (candidate: string, label: string): Promise<OrdinaryDirectoryBinding> => {
  const lexical = path.resolve(candidate);
  const metadata = await lstat(lexical, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new FluxPreviewRendererError(`${label} must be an ordinary non-link directory.`);
  }
  const canonical = await realpath(lexical);
  if (!samePath(canonical, lexical)) {
    throw new FluxPreviewRendererError(`${label} must not resolve through a link, junction, or alias.`);
  }
  return Object.freeze({
    path: lexical,
    device: metadata.dev,
    inode: metadata.ino,
    mode: metadata.mode,
    createdNs: metadata.birthtimeNs,
  });
};

const sameDirectoryBinding = (left: OrdinaryDirectoryBinding, right: OrdinaryDirectoryBinding): boolean =>
  samePath(left.path, right.path) && left.device === right.device && left.inode === right.inode &&
  left.mode === right.mode && left.createdNs === right.createdNs;

const assertDirectoryBinding = async (expected: OrdinaryDirectoryBinding, label: string): Promise<void> => {
  if (!sameDirectoryBinding(expected, await bindOrdinaryDirectory(expected.path, label))) {
    throw new FluxPreviewRendererError(`${label} was replaced after it was bound.`);
  }
};

const pathIsMissing = async (candidate: string): Promise<boolean> => {
  try {
    await lstat(candidate);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
};

const revisionRootTails = new Map<string, Promise<void>>();
const withRevisionRootLease = async <Result>(root: string, operation: () => Promise<Result>): Promise<Result> => {
  const key = process.platform === "win32" ? path.resolve(root).toLocaleLowerCase("en-US") : path.resolve(root);
  const previous = revisionRootTails.get(key) ?? Promise.resolve();
  const scheduled = previous.then(operation, operation);
  const tail = scheduled.then(() => undefined, () => undefined);
  revisionRootTails.set(key, tail);
  try {
    return await scheduled;
  } finally {
    if (revisionRootTails.get(key) === tail) revisionRootTails.delete(key);
  }
};

const freeze = <Value>(value: Value): Value => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  return Object.freeze(value);
};

function manifestFromPreview(preview: KicadPreviewExportResult): readonly FluxPreviewArtifactManifestEntry[] {
  const entries: FluxPreviewArtifactManifestEntry[] = [];
  for (const artifact of preview.artifacts) {
    const name = artifact.relativePath.startsWith("schematic/") && artifact.relativePath.endsWith(".svg")
      ? "schematic.svg"
      : artifact.relativePath === "renders/board-top.png"
        ? "board-top.png"
        : artifact.relativePath === "renders/board-bottom.png"
          ? "board-bottom.png"
          : undefined;
    if (name === undefined) throw new FluxPreviewRendererError("Preview adapter returned an unexpected artifact.");
    entries.push(freeze({
      name,
      mediaType: name === "schematic.svg" ? "image/svg+xml" : "image/png",
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.sha256,
    }));
  }
  const expected = new Set(["schematic.svg", "board-top.png", "board-bottom.png"]);
  if (entries.length !== expected.size || entries.some((entry) => !expected.delete(entry.name))) {
    throw new FluxPreviewRendererError("Preview adapter did not produce the complete display manifest.");
  }
  return Object.freeze(entries.sort((left, right) => left.name.localeCompare(right.name, "en-US")));
}

/**
 * A display-only KiCad renderer. The generated revision directory is private
 * to the renderer; callers receive hashes and media metadata, never paths.
 */
export class FluxPreviewRenderer {
  readonly #adapter: KicadCliAdapter;
  readonly #workspaceRoot: string;
  readonly #projectRoot: string;
  readonly #outputRoot: string;
  readonly #revisionRoot: string;

  constructor(options: FluxPreviewRendererOptions) {
    this.#adapter = options.adapter;
    this.#workspaceRoot = options.workspaceRoot;
    this.#projectRoot = options.projectRoot;
    this.#outputRoot = options.outputRoot ?? options.workspaceRoot;
    this.#revisionRoot = options.revisionRoot;
  }

  async render(request: FluxPreviewRenderRequest): Promise<FluxPreviewRenderResult> {
    return (await this.renderForRuntime(request)).result;
  }

  async #bindRevisionRoot(outputRoot: OrdinaryDirectoryBinding, projectRoot: OrdinaryDirectoryBinding): Promise<OrdinaryDirectoryBinding> {
    await assertDirectoryBinding(outputRoot, "Flux preview output root");
    await assertDirectoryBinding(projectRoot, "Flux preview project root");
    const lexicalRevisionRoot = path.resolve(outputRoot.path, this.#revisionRoot);
    assertPathWithin(outputRoot.path, lexicalRevisionRoot, "Flux preview revision root", false);
    const requestedRevisionRoot = await resolveConfinedCandidate(
      outputRoot.path,
      outputRoot.path,
      this.#revisionRoot,
      "Flux preview revision root",
    );
    if (!samePath(requestedRevisionRoot, lexicalRevisionRoot)) {
      throw new FluxPreviewRendererError("Flux preview revision root must not resolve through a link, junction, or alias.");
    }
    await mkdir(requestedRevisionRoot, { recursive: true });
    const revisionRoot = await bindOrdinaryDirectory(requestedRevisionRoot, "Flux preview revision root");
    assertPathWithin(outputRoot.path, revisionRoot.path, "Flux preview revision root", false);
    assertDisjointDirectories(projectRoot.path, revisionRoot.path, "Flux preview project root", "Flux preview revision root");
    return revisionRoot;
  }

  async #allocateRevision(
    workspaceRoot: OrdinaryDirectoryBinding,
    outputRoot: OrdinaryDirectoryBinding,
    projectRoot: OrdinaryDirectoryBinding,
    revisionRoot: OrdinaryDirectoryBinding,
  ): Promise<OrdinaryDirectoryBinding> {
    await assertDirectoryBinding(revisionRoot, "Flux preview revision root");
    const realizedCandidate = path.join(revisionRoot.path, "revision-XXXXXX");
    if (process.platform === "win32" && realizedCandidate.length > FLUX_PREVIEW_WINDOWS_REALIZED_PATH_LIMIT) {
      throw new FluxPreviewRendererError("Flux preview staging exceeds the supported Windows path-length budget; configure a shorter Flux workspace root.");
    }
    const revisionDirectory = await mkdtemp(path.join(revisionRoot.path, "revision-"));
    const boundRevision = await bindOrdinaryDirectory(revisionDirectory, "Flux preview revision directory");
    await assertDirectoryBinding(revisionRoot, "Flux preview revision root");
    await assertDirectoryBinding(workspaceRoot, "Flux preview workspace root");
    await assertDirectoryBinding(outputRoot, "Flux preview output root");
    await assertDirectoryBinding(projectRoot, "Flux preview project root");
    assertPathWithin(revisionRoot.path, boundRevision.path, "Flux preview revision directory", false);
    return boundRevision;
  }

  async #createRevisionDirectory(
    workspaceRoot: OrdinaryDirectoryBinding,
    outputRoot: OrdinaryDirectoryBinding,
    projectRoot: OrdinaryDirectoryBinding,
  ): Promise<Readonly<{ readonly revisionRoot: OrdinaryDirectoryBinding; readonly revision: OrdinaryDirectoryBinding }>> {
    let revisionRoot = await this.#bindRevisionRoot(outputRoot, projectRoot);
    try {
      return Object.freeze({ revisionRoot, revision: await this.#allocateRevision(workspaceRoot, outputRoot, projectRoot, revisionRoot) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !(await pathIsMissing(revisionRoot.path))) throw error;
      await assertDirectoryBinding(workspaceRoot, "Flux preview workspace root");
      await assertDirectoryBinding(outputRoot, "Flux preview output root");
      await assertDirectoryBinding(projectRoot, "Flux preview project root");
      revisionRoot = await this.#bindRevisionRoot(outputRoot, projectRoot);
      return Object.freeze({ revisionRoot, revision: await this.#allocateRevision(workspaceRoot, outputRoot, projectRoot, revisionRoot) });
    }
  }

  async #removeFailedRevision(revisionRoot: OrdinaryDirectoryBinding, revision: OrdinaryDirectoryBinding): Promise<void> {
    if (await pathIsMissing(revision.path)) return;
    await assertDirectoryBinding(revisionRoot, "Flux preview revision root");
    await assertDirectoryBinding(revision, "Flux preview failed revision directory");
    assertPathWithin(revisionRoot.path, revision.path, "Flux preview failed revision directory", false);
    await rm(revision.path, { recursive: true, force: false });
    await assertDirectoryBinding(revisionRoot, "Flux preview revision root");
  }

  async renderForRuntime(request: FluxPreviewRenderRequest): Promise<FluxPreviewRuntimeRender> {
    const workspaceRoot = await bindOrdinaryDirectory(this.#workspaceRoot, "Flux preview workspace root");
    const projectRoot = await bindOrdinaryDirectory(this.#projectRoot, "Flux preview project root");
    const outputRoot = await bindOrdinaryDirectory(this.#outputRoot, "Flux preview output root");
    assertPathWithin(workspaceRoot.path, projectRoot.path, "Flux preview project root", true);
    const leaseRoot = path.resolve(outputRoot.path, this.#revisionRoot);
    return await withRevisionRootLease(leaseRoot, async () => {
      const allocated = await this.#createRevisionDirectory(workspaceRoot, outputRoot, projectRoot);
      try {
        const preview = await this.#adapter.exportPreviewArtifacts({
          schematicPath: request.schematicPath,
          pcbPath: request.pcbPath,
          outputDirectory: allocated.revision.path,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        const artifacts = manifestFromPreview(preview);
        for (const artifact of artifacts) {
          const source = preview.artifacts.find((entry) => {
            if (artifact.name === "schematic.svg") return entry.relativePath.startsWith("schematic/") && entry.relativePath.endsWith(".svg");
            return entry.relativePath === (artifact.name === "board-top.png" ? "renders/board-top.png" : "renders/board-bottom.png");
          });
          if (source === undefined) throw new FluxPreviewRendererError("Preview artifact binding disappeared during normalization.");
          const bytes = (await readFile(source.path)).toString("utf8").toLocaleLowerCase("en-US");
          const privateRoots = [workspaceRoot.path, outputRoot.path, projectRoot.path, allocated.revision.path]
            .flatMap((root) => [root, root.replaceAll("\\", "/")])
            .map((root) => root.toLocaleLowerCase("en-US"));
          if (privateRoots.some((root) => bytes.includes(root))) throw new FluxPreviewRendererError("Preview artifact contains private filesystem metadata.");
          await copyFile(source.path, path.join(allocated.revision.path, artifact.name));
        }
        const result = freeze({
          schemaVersion: "evleda.flux-preview.v1" as const,
          classification: "candidate-preview" as const,
          releaseAuthorized: false as const,
          sourceHashes: { ...preview.sourceHashes },
          artifacts,
        });
        return freeze({ root: allocated.revision.path, result });
      } catch (error) {
        try {
          await this.#removeFailedRevision(allocated.revisionRoot, allocated.revision);
        } catch (cleanupError) {
          throw new FluxPreviewRendererError("Flux preview rendering failed and its private revision could not be safely removed.", {
            cause: new AggregateError([error, cleanupError]),
          });
        }
        throw error;
      }
    });
  }
}
