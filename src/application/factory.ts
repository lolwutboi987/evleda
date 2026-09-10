import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_KICAD_10_CLI_PATH } from "../integrations/kicad-cli.js";
import {
  ReferenceStageContextProvider,
} from "../integrations/reference-stage-context.js";
import { isPathWithin } from "../integrations/path-boundary.js";
import { FileContentStore } from "../persistence/content-store.js";
import { HashChainAuditLog } from "../persistence/audit-log.js";
import { AtomicStateStore } from "../persistence/state-store.js";
import type { StageRegistryContract } from "../workflow/contracts.js";
import { createDefaultStageRegistry } from "../workflow/stage-registry.js";
import { ApplicationService } from "./application-service.js";
import type { StageContextProvider } from "./ports.js";
import type { ContentIdentity } from "../domain/types.js";

export interface DefaultApplicationOptions {
  readonly dataRoot: string;
  readonly workspaceRoot?: string;
  readonly stages?: StageRegistryContract;
  readonly stageContext?: StageContextProvider;
}

export interface ProductionApplicationPaths {
  readonly dataRoot: string;
  readonly workspaceRoot: string;
  readonly snapshotPath: string;
  readonly sourceRoot: string;
  readonly referenceDesignRoot: string;
  readonly kicadWorkRoot: string;
  /** First candidate, retained for compatibility and diagnostics. */
  readonly kicadExecutablePath: string;
  /** Ordered explicit override, user-local, then system discovery candidates. */
  readonly kicadExecutableCandidates?: readonly string[];
}

export interface ProductionApplicationOptions {
  readonly paths: ProductionApplicationPaths;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly trustRoot?: {
    readonly path: string;
    readonly identity: ContentIdentity;
  };
}

const configuredAbsolutePath = (
  configured: string | undefined,
  fallback: string,
  environmentName: string,
): string => {
  if (configured === undefined) return path.resolve(fallback);
  if (configured.trim().length === 0 || !path.isAbsolute(configured)) {
    throw new Error(`${environmentName} must be a non-empty absolute path.`);
  }
  return path.normalize(configured);
};

const orderedKicadCandidates = (
  environment: Readonly<Record<string, string | undefined>>,
  localAppData: string | undefined,
): readonly string[] => {
  const explicit = environment.EVLEDA_KICAD_CLI;
  if (explicit !== undefined) {
    return [configuredAbsolutePath(explicit, explicit, "EVLEDA_KICAD_CLI")];
  }
  const userLocal = localAppData === undefined
    ? []
    : [path.join(localAppData, "Programs", "KiCad", "10.0", "bin", "kicad-cli.exe")];
  return [...userLocal, DEFAULT_KICAD_10_CLI_PATH].map((candidate) => path.normalize(candidate));
};

const normalizedProductionPaths = (
  paths: ProductionApplicationPaths,
): ProductionApplicationPaths => {
  const candidates = paths.kicadExecutableCandidates ?? [paths.kicadExecutablePath];
  for (const [label, value] of [
    ["dataRoot", paths.dataRoot],
    ["workspaceRoot", paths.workspaceRoot],
    ["snapshotPath", paths.snapshotPath],
    ["sourceRoot", paths.sourceRoot],
    ["referenceDesignRoot", paths.referenceDesignRoot],
    ["kicadWorkRoot", paths.kicadWorkRoot],
    ["kicadExecutablePath", paths.kicadExecutablePath],
    ...candidates.map((candidate, index) => [`kicadExecutableCandidates[${index}]`, candidate] as const),
  ] as const) {
    if (value.trim().length === 0 || !path.isAbsolute(value)) {
      throw new Error(`Production ${label} must be a non-empty absolute path.`);
    }
  }
  if (candidates.length === 0) throw new Error("Production KiCad discovery requires at least one candidate.");
  const normalizedCandidates = [...new Set(candidates.map((candidate) => path.normalize(candidate)))];
  return {
    dataRoot: path.normalize(paths.dataRoot),
    workspaceRoot: path.normalize(paths.workspaceRoot),
    snapshotPath: path.normalize(paths.snapshotPath),
    sourceRoot: path.normalize(paths.sourceRoot),
    referenceDesignRoot: path.normalize(paths.referenceDesignRoot),
    kicadWorkRoot: path.normalize(paths.kicadWorkRoot),
    kicadExecutablePath: normalizedCandidates[0]!,
    kicadExecutableCandidates: normalizedCandidates,
  };
};

/** Resolve configuration only; evidence and tool existence is checked inside the provider. */
export const resolveProductionApplicationPaths = (
  environment: Readonly<Record<string, string | undefined>>,
  cwd: string,
): ProductionApplicationPaths => {
  if (cwd.trim().length === 0 || !path.isAbsolute(cwd)) {
    throw new Error("The production working directory must be a non-empty absolute path.");
  }
  const localAppData = environment.LOCALAPPDATA;
  if (
    localAppData !== undefined &&
    (localAppData.trim().length === 0 || !path.isAbsolute(localAppData))
  ) {
    throw new Error("LOCALAPPDATA must be a non-empty absolute path when configured.");
  }
  const dataRoot = configuredAbsolutePath(
    environment.EVLEDA_DATA_DIR,
    path.join(localAppData ?? cwd, "EvlEDA"),
    "EVLEDA_DATA_DIR",
  );
  const workspaceRoot = configuredAbsolutePath(
    environment.EVLEDA_WORKSPACE_ROOT,
    path.join(dataRoot, "workspaces"),
    "EVLEDA_WORKSPACE_ROOT",
  );
  const referenceDesignRoot = configuredAbsolutePath(
    environment.EVLEDA_REFERENCE_DESIGN_ROOT,
    path.join(cwd, "reference-designs", "robotics-controller-v0"),
    "EVLEDA_REFERENCE_DESIGN_ROOT",
  );
  const snapshotPath = configuredAbsolutePath(
    environment.EVLEDA_STAGE_CONTEXT_SNAPSHOT,
    path.join(referenceDesignRoot, "evidence", "reference-stage-context.v1.json"),
    "EVLEDA_STAGE_CONTEXT_SNAPSHOT",
  );
  const sourceRoot = configuredAbsolutePath(
    environment.EVLEDA_STAGE_CONTEXT_SOURCE_ROOT,
    path.join(referenceDesignRoot, "evidence"),
    "EVLEDA_STAGE_CONTEXT_SOURCE_ROOT",
  );
  const kicadWorkRoot = configuredAbsolutePath(
    environment.EVLEDA_KICAD_WORK_ROOT,
    path.join(dataRoot, "kicad-work"),
    "EVLEDA_KICAD_WORK_ROOT",
  );
  const candidates = orderedKicadCandidates(environment, localAppData);
  return normalizedProductionPaths({
    dataRoot,
    workspaceRoot,
    snapshotPath,
    sourceRoot,
    referenceDesignRoot,
    kicadWorkRoot,
    kicadExecutablePath: candidates[0]!,
    kicadExecutableCandidates: candidates,
  });
};

interface CanonicalPathSet extends ProductionApplicationPaths {
  readonly kicadExecutableCandidates: readonly string[];
}

const canonicalCandidatePath = async (rawPath: string): Promise<string> => {
  let cursor = path.resolve(rawPath);
  const suffix: string[] = [];
  for (;;) {
    try {
      const metadata = await lstat(cursor);
      if (!metadata.isDirectory() && suffix.length > 0) {
        throw new Error(`${cursor} is a non-directory path component.`);
      }
      const canonicalAncestor = await realpath(cursor);
      return path.resolve(canonicalAncestor, ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error(`No existing ancestor exists for ${rawPath}.`);
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
};

const canonicalizePathSet = async (
  paths: ProductionApplicationPaths,
): Promise<CanonicalPathSet> => {
  const candidates = paths.kicadExecutableCandidates ?? [paths.kicadExecutablePath];
  const [
    dataRoot,
    workspaceRoot,
    snapshotPath,
    sourceRoot,
    referenceDesignRoot,
    kicadWorkRoot,
    ...kicadExecutableCandidates
  ] = await Promise.all([
    canonicalCandidatePath(paths.dataRoot),
    canonicalCandidatePath(paths.workspaceRoot),
    canonicalCandidatePath(paths.snapshotPath),
    canonicalCandidatePath(paths.sourceRoot),
    canonicalCandidatePath(paths.referenceDesignRoot),
    canonicalCandidatePath(paths.kicadWorkRoot),
    ...candidates.map(canonicalCandidatePath),
  ]);
  return {
    dataRoot: dataRoot!,
    workspaceRoot: workspaceRoot!,
    snapshotPath: snapshotPath!,
    sourceRoot: sourceRoot!,
    referenceDesignRoot: referenceDesignRoot!,
    kicadWorkRoot: kicadWorkRoot!,
    kicadExecutablePath: kicadExecutableCandidates[0]!,
    kicadExecutableCandidates,
  };
};

const assertWritableImmutableDisjoint = (
  paths: CanonicalPathSet,
  additionalImmutable: readonly string[] = [],
): void => {
  const writable = [paths.dataRoot, paths.workspaceRoot, paths.kicadWorkRoot];
  const immutable = [
    paths.snapshotPath,
    paths.sourceRoot,
    paths.referenceDesignRoot,
    ...paths.kicadExecutableCandidates,
    ...additionalImmutable,
  ];
  for (const writablePath of writable) {
    for (const immutablePath of immutable) {
      if (
        isPathWithin(writablePath, immutablePath, true) ||
        isPathWithin(immutablePath, writablePath, true)
      ) {
        throw new Error(
          `Writable path ${writablePath} must not overlap immutable path ${immutablePath}.`,
        );
      }
    }
  }
};

const configuredTrustRoot = (
  options: ProductionApplicationOptions,
): ProductionApplicationOptions["trustRoot"] => {
  if (options.trustRoot !== undefined) {
    if (
      !path.isAbsolute(options.trustRoot.path) ||
      options.trustRoot.identity.algorithm !== "sha256" ||
      !/^[0-9a-f]{64}$/u.test(options.trustRoot.identity.digest) ||
      !Number.isSafeInteger(options.trustRoot.identity.size) ||
      options.trustRoot.identity.size <= 0
    ) {
      throw new Error("Production trust root must have an absolute path and valid content identity.");
    }
    return options.trustRoot;
  }
  const environment = options.environment ?? {};
  const configuredPath = environment.EVLEDA_STAGE_CONTEXT_TRUST_ROOT;
  const digest = environment.EVLEDA_STAGE_CONTEXT_TRUST_ROOT_SHA256;
  const sizeText = environment.EVLEDA_STAGE_CONTEXT_TRUST_ROOT_SIZE;
  if (configuredPath === undefined && digest === undefined && sizeText === undefined) return undefined;
  if (
    configuredPath === undefined ||
    !path.isAbsolute(configuredPath) ||
    digest === undefined ||
    !/^[0-9a-f]{64}$/u.test(digest) ||
    sizeText === undefined ||
    !/^\d+$/u.test(sizeText) ||
    Number(sizeText) <= 0 ||
    !Number.isSafeInteger(Number(sizeText))
  ) {
    throw new Error(
      "EVLEDA_STAGE_CONTEXT_TRUST_ROOT, _SHA256, and _SIZE must jointly pin one absolute nonempty trust-root file.",
    );
  }
  return {
    path: path.normalize(configuredPath),
    identity: { algorithm: "sha256", digest, size: Number(sizeText) },
  };
};

const assertOrdinaryDirectory = async (directory: string, label: string): Promise<string> => {
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be an ordinary directory, not a file or symbolic link.`);
  }
  return realpath(directory);
};

export const createDefaultApplicationService = (
  options: DefaultApplicationOptions,
): ApplicationService => {
  const dataRoot = path.resolve(options.dataRoot);
  return new ApplicationService(
    {
      state: new AtomicStateStore(path.join(dataRoot, "state")),
      content: new FileContentStore(path.join(dataRoot, "content")),
      audit: new HashChainAuditLog(path.join(dataRoot, "audit")),
      stages: options.stages ?? createDefaultStageRegistry(),
      ...(options.stageContext === undefined ? {} : { stageContext: options.stageContext }),
    },
    {
      workspaceRoot: path.resolve(options.workspaceRoot ?? path.join(dataRoot, "workspaces")),
    },
  );
};

export const createProductionApplicationService = async (
  options: ProductionApplicationOptions,
): Promise<ApplicationService> => {
  const normalized = normalizedProductionPaths(options.paths);
  const requestedTrustRoot = configuredTrustRoot(options);
  const canonicalTrustRootPath = requestedTrustRoot === undefined
    ? undefined
    : await canonicalCandidatePath(requestedTrustRoot.path);
  const before = await canonicalizePathSet(normalized);
  assertWritableImmutableDisjoint(
    before,
    canonicalTrustRootPath === undefined ? [] : [canonicalTrustRootPath],
  );

  await mkdir(before.dataRoot, { recursive: true });
  await mkdir(before.workspaceRoot, { recursive: true });
  await mkdir(before.kicadWorkRoot, { recursive: true });
  await Promise.all([
    assertOrdinaryDirectory(before.dataRoot, "Data root"),
    assertOrdinaryDirectory(before.workspaceRoot, "Workspace root"),
    assertOrdinaryDirectory(before.kicadWorkRoot, "KiCad work root"),
  ]);

  const paths = await canonicalizePathSet(before);
  const trustRootPath = requestedTrustRoot === undefined
    ? undefined
    : await canonicalCandidatePath(requestedTrustRoot.path);
  assertWritableImmutableDisjoint(paths, trustRootPath === undefined ? [] : [trustRootPath]);
  const stageContext = new ReferenceStageContextProvider({
    snapshotPath: paths.snapshotPath,
    sourceRoot: paths.sourceRoot,
    referenceDesignRoot: paths.referenceDesignRoot,
    kicadWorkRoot: paths.kicadWorkRoot,
    kicadExecutableCandidates: paths.kicadExecutableCandidates,
    ...(requestedTrustRoot === undefined || trustRootPath === undefined
      ? {}
      : { trustRoot: { path: trustRootPath, identity: requestedTrustRoot.identity } }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  });
  return createDefaultApplicationService({
    dataRoot: paths.dataRoot,
    workspaceRoot: paths.workspaceRoot,
    stageContext,
  });
};
