import { mkdtemp, mkdir, writeFile, link, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { readToolboxReferenceArtifact, REFERENCE_RESOURCE_MAX_BYTES } from "../../src/mcp/toolbox-reference-resource.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(bytes = Buffer.from('{"complete":[1,2,3]}\n')) {
  const root = await mkdtemp(path.join(tmpdir(), "reference-resource-")); roots.push(root);
  const directory = path.join(root, "real"); await mkdir(directory);
  const file = path.join(directory, "diagnostic.json"); await writeFile(file, bytes);
  return { root, directory, bytes, artifact: { path: file, identity: contentIdentity(bytes) } };
}

describe("hash-bound reference diagnostic artifact reader", () => {
  it("returns the exact complete UTF-8 artifact", async () => {
    const f = await fixture(); expect(await readToolboxReferenceArtifact(f.artifact)).toBe(f.bytes.toString("utf8"));
  });
  it("rejects same-length content replacement", async () => {
    const f = await fixture(); await writeFile(f.artifact.path, f.bytes.toString().replace("1,2,3", "3,2,1"));
    await expect(readToolboxReferenceArtifact(f.artifact)).rejects.toThrow("changed");
  });
  it.each(["relative", "oversize", "wrong-size", "wrong-digest", "empty", "noninteger"])("rejects %s metadata", async kind => {
    const f = await fixture(); const artifact = { ...f.artifact, identity: { ...f.artifact.identity } };
    if (kind === "relative") artifact.path = "diagnostic.json";
    if (kind === "oversize") artifact.identity.size = REFERENCE_RESOURCE_MAX_BYTES + 1;
    if (kind === "wrong-size") artifact.identity.size += 1;
    if (kind === "wrong-digest") artifact.identity.digest = "0".repeat(64);
    if (kind === "empty") artifact.identity.size = 0;
    if (kind === "noninteger") artifact.identity.size = 1.5;
    await expect(readToolboxReferenceArtifact(artifact)).rejects.toThrow();
  });
  it("rejects shared hard-linked files", async () => {
    const f = await fixture(); await link(f.artifact.path, path.join(f.root, "shared.json"));
    await expect(readToolboxReferenceArtifact(f.artifact)).rejects.toThrow("changed");
  });
  it("rejects a directory alias even when artifact bytes match", async () => {
    const f = await fixture(); const alias = path.join(f.root, "alias"); await symlink(f.directory, alias, "junction");
    await expect(readToolboxReferenceArtifact({ ...f.artifact, path: path.join(alias, "diagnostic.json") })).rejects.toThrow("changed");
  });
  it("rejects malformed UTF-8 despite matching hash and size", async () => {
    const f = await fixture(Buffer.from([0xc3, 0x28]));
    await expect(readToolboxReferenceArtifact(f.artifact)).rejects.toThrow();
  });
});
