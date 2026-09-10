import { access, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { DomainError } from "../domain/errors.js";

const normalizeForComparison = (value: string): string =>
  process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;

const isWithin = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};

export const resolveWithinRoot = (root: string, candidate: string): string => {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(resolvedRoot, candidate);
  if (!isWithin(normalizeForComparison(resolvedRoot), normalizeForComparison(resolvedCandidate))) {
    throw new DomainError("PATH_OUTSIDE_WORKSPACE", "Path escapes the approved workspace", {
      root: resolvedRoot,
      candidate: resolvedCandidate
    });
  }
  return resolvedCandidate;
};

export const resolveExistingWithinRoot = async (
  root: string,
  candidate: string
): Promise<string> => {
  const lexical = resolveWithinRoot(root, candidate);
  const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(lexical)]);
  if (!isWithin(normalizeForComparison(realRoot), normalizeForComparison(realCandidate))) {
    throw new DomainError("PATH_OUTSIDE_WORKSPACE", "Resolved path escapes through a link", {
      root: realRoot,
      candidate: realCandidate
    });
  }
  return realCandidate;
};

export const resolveWriteTargetWithinRoot = async (
  root: string,
  candidate: string
): Promise<string> => {
  const lexical = resolveWithinRoot(root, candidate);
  const realRoot = await realpath(root);
  let ancestor = path.dirname(lexical);

  while (true) {
    try {
      await access(ancestor);
      const stat = await lstat(ancestor);
      if (!stat.isDirectory()) {
        throw new DomainError("PATH_OUTSIDE_WORKSPACE", "Write target parent is not a directory", {
          ancestor
        });
      }
      const realAncestor = await realpath(ancestor);
      if (!isWithin(normalizeForComparison(realRoot), normalizeForComparison(realAncestor))) {
        throw new DomainError("PATH_OUTSIDE_WORKSPACE", "Write target escapes through a link", {
          root: realRoot,
          ancestor: realAncestor
        });
      }
      return lexical;
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        throw new DomainError("PATH_OUTSIDE_WORKSPACE", "No approved existing ancestor", {
          root: realRoot,
          candidate: lexical
        });
      }
      ancestor = parent;
    }
  }
};

