#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const helper = "toolbox-editor-supervisor.py";

async function rejectLinkedAncestors(target) {
  for (let current = target; ; current = path.dirname(current)) {
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Linked packaging path: ${current}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (current === path.dirname(current)) break;
  }
}

/** Fixed source and dist-relative destination; root injection is for isolated tests. */
export async function packageToolboxNativeHelper(repositoryRoot = path.resolve(import.meta.dirname, "..")) {
  const root = path.resolve(repositoryRoot);
  const source = path.join(root, "src", "mcp", helper);
  const destination = path.join(root, "dist", "src", "mcp", helper);
  await rejectLinkedAncestors(source);
  await rejectLinkedAncestors(destination);
  if (!(await lstat(source)).isFile()) throw new Error("Toolbox native helper source must be an ordinary file.");
  const bytes = await readFile(source);
  await mkdir(path.dirname(destination), { recursive: true });
  await rejectLinkedAncestors(destination);
  const temporary = path.join(path.dirname(destination), `.${helper}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rejectLinkedAncestors(destination);
    // Rename replaces the directory entry instead of writing through an existing
    // destination hard link. Linked ancestors and symlink destinations are refused.
    await rename(temporary, destination);
    if (!(await readFile(destination)).equals(bytes)) throw new Error("Packaged toolbox helper differs from source bytes.");
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
  return destination;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 2) throw new Error("Usage: package-toolbox-native-helper.mjs");
  console.log(`Packaged toolbox native helper at ${await packageToolboxNativeHelper()}`);
}
