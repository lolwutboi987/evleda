import { access, lstat, mkdir, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

export class PathBoundaryError extends Error {
  override readonly name = "PathBoundaryError";

  constructor(message: string) {
    super(message);
  }
}

function normalizedForComparison(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

export function isPathWithin(root: string, candidate: string, allowEqual = true): boolean {
  const normalizedRoot = normalizedForComparison(root);
  const normalizedCandidate = normalizedForComparison(candidate);
  const relative = path.relative(normalizedRoot, normalizedCandidate);

  if (relative === "") {
    return allowEqual;
  }

  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function assertPathWithin(
  root: string,
  candidate: string,
  label: string,
  allowEqual = true,
): void {
  if (!isPathWithin(root, candidate, allowEqual)) {
    throw new PathBoundaryError(`${label} escapes its allowed root.`);
  }
}

export async function resolveExistingDirectory(rawPath: string, label: string): Promise<string> {
  if (!rawPath.trim()) {
    throw new PathBoundaryError(`${label} must not be empty.`);
  }

  const resolved = await realpath(path.resolve(rawPath));
  const metadata = await stat(resolved);
  if (!metadata.isDirectory()) {
    throw new PathBoundaryError(`${label} is not a directory.`);
  }
  return resolved;
}

export async function resolveExistingFile(rawPath: string, label: string): Promise<string> {
  if (!rawPath.trim()) {
    throw new PathBoundaryError(`${label} must not be empty.`);
  }

  const original = path.resolve(rawPath);
  const originalMetadata = await lstat(original);
  if (originalMetadata.isSymbolicLink()) {
    throw new PathBoundaryError(`${label} must not be a symbolic link.`);
  }

  const resolved = await realpath(original);
  const metadata = await stat(resolved);
  if (!metadata.isFile()) {
    throw new PathBoundaryError(`${label} is not a regular file.`);
  }
  return resolved;
}

async function nearestExistingAncestor(candidate: string): Promise<{
  ancestor: string;
  suffix: string[];
}> {
  let cursor = candidate;
  const suffix: string[] = [];

  for (;;) {
    try {
      await access(cursor);
      return { ancestor: cursor, suffix };
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        throw new PathBoundaryError("No existing ancestor was found for the requested path.");
      }
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

export async function resolveConfinedCandidate(
  allowedRoot: string,
  baseDirectory: string,
  rawPath: string,
  label: string,
  allowRoot = false,
): Promise<string> {
  if (!rawPath.trim() || rawPath.includes("\0")) {
    throw new PathBoundaryError(`${label} must be a non-empty path without NUL bytes.`);
  }

  const lexical = path.resolve(baseDirectory, rawPath);
  assertPathWithin(allowedRoot, lexical, label, allowRoot);

  const { ancestor, suffix } = await nearestExistingAncestor(lexical);
  const ancestorMetadata = await stat(ancestor);
  if (!ancestorMetadata.isDirectory() && suffix.length > 0) {
    throw new PathBoundaryError(`${label} has a non-directory path component.`);
  }

  const canonicalAncestor = await realpath(ancestor);
  const canonicalCandidate = path.resolve(canonicalAncestor, ...suffix);
  assertPathWithin(allowedRoot, canonicalCandidate, label, allowRoot);
  return canonicalCandidate;
}

export async function resolveConfinedExistingFile(
  allowedRoot: string,
  baseDirectory: string,
  rawPath: string,
  label: string,
): Promise<string> {
  const requested = path.resolve(baseDirectory, rawPath);
  assertPathWithin(allowedRoot, requested, label, false);
  const requestedMetadata = await lstat(requested);
  if (requestedMetadata.isSymbolicLink()) {
    throw new PathBoundaryError(`${label} must not be a symbolic link.`);
  }
  const candidate = await resolveConfinedCandidate(
    allowedRoot,
    baseDirectory,
    rawPath,
    label,
  );
  const resolved = await resolveExistingFile(candidate, label);
  assertPathWithin(allowedRoot, resolved, label, false);
  return resolved;
}

export async function prepareEmptyOutputDirectory(
  allowedRoot: string,
  baseDirectory: string,
  rawPath: string,
  protectedRoots: readonly string[] = [],
): Promise<string> {
  const requested = path.resolve(baseDirectory, rawPath);
  try {
    if ((await lstat(requested)).isSymbolicLink()) {
      throw new PathBoundaryError("KiCad output directory must not be a symbolic link.");
    }
  } catch (error) {
    if (
      error instanceof PathBoundaryError ||
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw error;
    }
  }
  const candidate = await resolveConfinedCandidate(
    allowedRoot,
    baseDirectory,
    rawPath,
    "KiCad output directory",
  );

  for (const protectedRoot of protectedRoots) {
    if (
      isPathWithin(protectedRoot, candidate, true) ||
      isPathWithin(candidate, protectedRoot, true)
    ) {
      throw new PathBoundaryError(
        "KiCad output directory must not overlap a protected source directory.",
      );
    }
  }

  try {
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new PathBoundaryError(
        "KiCad output directory must be an ordinary directory, not a file or symbolic link.",
      );
    }
  } catch (error) {
    if (error instanceof PathBoundaryError) {
      throw error;
    }
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode !== "ENOENT") {
      throw error;
    }
    await mkdir(candidate, { recursive: true });
  }

  const canonical = await realpath(candidate);
  assertPathWithin(allowedRoot, canonical, "KiCad output directory", false);
  if ((await readdir(canonical)).length !== 0) {
    throw new PathBoundaryError("KiCad output directory must be empty before invocation.");
  }
  return canonical;
}

export function assertDisjointDirectories(
  first: string,
  second: string,
  firstLabel: string,
  secondLabel: string,
): void {
  if (isPathWithin(first, second, true) || isPathWithin(second, first, true)) {
    throw new PathBoundaryError(`${firstLabel} and ${secondLabel} must not overlap.`);
  }
}
