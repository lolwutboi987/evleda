import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, link } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { packageToolboxNativeHelper } from "./package-toolbox-native-helper.mjs";

const helper = "toolbox-editor-supervisor.py";
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "evleda-helper-package-"));
  t.after(async () => {
    if (!root.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) throw new Error("Unsafe fixture cleanup");
    await rm(root, { recursive: true, force: true });
  });
  const repository = path.join(root, "repo");
  const source = path.join(repository, "src", "mcp", helper);
  await mkdir(path.dirname(source), { recursive: true });
  const bytes = await readFile(new URL(`../src/mcp/${helper}`, import.meta.url));
  await writeFile(source, bytes);
  return { root, repository, source, bytes, destination: path.join(repository, "dist", "src", "mcp", helper) };
}

test("packages the actual helper byte-for-byte beside the compiled launcher and supports rebuilds", async t => {
  const f = await fixture(t);
  assert.equal(await packageToolboxNativeHelper(f.repository), f.destination);
  assert.deepEqual(await readFile(f.destination), f.bytes);
  await writeFile(f.destination, "stale build");
  await packageToolboxNativeHelper(f.repository);
  assert.deepEqual(await readFile(f.destination), f.bytes);
});

test("rejects a dist junction leading outside the repository without touching its contents", async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "sentinel"), "unchanged");
  await symlink(outside, path.join(f.repository, "dist"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(packageToolboxNativeHelper(f.repository), /Linked packaging path/);
  assert.equal(await readFile(path.join(outside, "sentinel"), "utf8"), "unchanged");
});

test("replaces a destination hard link without modifying the outside file", async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, "outside.py");
  await writeFile(outside, "outside bytes");
  await mkdir(path.dirname(f.destination), { recursive: true });
  await link(outside, f.destination);
  await packageToolboxNativeHelper(f.repository);
  assert.equal(await readFile(outside, "utf8"), "outside bytes");
  assert.deepEqual(await readFile(f.destination), f.bytes);
});
