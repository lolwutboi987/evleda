import { access, link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preflightOwnedEditorLocks } from "../../src/mcp/toolbox-owned-editor-locks.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const outputRoot = await mkdtemp(path.join(tmpdir(), "evleda-owned-locks-")); roots.push(outputRoot);
  const projectRoot = path.join(outputRoot, "project"); await mkdir(projectRoot);
  const pcbPath = path.join(projectRoot, "proof.kicad_pcb"); await writeFile(pcbPath, "(kicad_pcb)");
  const paths = [path.join(projectRoot, "~proof.kicad_pcb.lck"), path.join(projectRoot, "~proof.kicad_pro.lck")];
  let stopped = false;
  const input = { outputRoot, projectRoot, pcbPath, isEditorTeardownConfirmed: () => stopped };
  const create = async () => { for (const file of paths) await writeFile(file, "same-host-pid-is-not-authority"); };
  return { input, paths, create, stop: () => { stopped = true; } };
}

describe("owned KiCad editor lock lifecycle", () => {
  it("refreshes same-file same-content saves before release", async () => {
    const f = await fixture(); const owner = await preflightOwnedEditorLocks(f.input); await f.create(); await owner.capture();
    await writeFile(f.paths[0]!, await readFile(f.paths[0]!));
    await owner.refresh(); f.stop(); await owner.release();
    for (const file of f.paths) await expect(access(file)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects changed contents during refresh and retains the original release witness", async () => {
    const f = await fixture(); const owner = await preflightOwnedEditorLocks(f.input); await f.create(); await owner.capture();
    const original = await readFile(f.paths[0]!); const changed = Buffer.from(original); changed[0] = changed[0] === 65 ? 66 : 65;
    await writeFile(f.paths[0]!, changed);
    await expect(owner.refresh()).rejects.toThrow("original contents changed"); f.stop();
    await expect(owner.release()).rejects.toThrow("changed after capture");
    for (const file of f.paths) await expect(access(file)).resolves.toBeUndefined();
  });
  it("rejects a replacement file with identical content during refresh", async () => {
    const f = await fixture(); const owner = await preflightOwnedEditorLocks(f.input); await f.create(); await owner.capture();
    const original = await readFile(f.paths[0]!); await rename(f.paths[0]!, `${f.paths[0]}.retained-original`); await writeFile(f.paths[0]!, original);
    await expect(owner.refresh()).rejects.toThrow("identity or original contents changed"); f.stop();
    await expect(owner.release()).rejects.toThrow("changed after capture");
  });
  it("removes only the captured pair after exact teardown and is idempotent", async () => {
    const f = await fixture(); const owner = await preflightOwnedEditorLocks(f.input); await f.create(); await owner.capture();
    const unrelated = path.join(f.input.projectRoot, "~unrelated.kicad_pcb.lck"); await writeFile(unrelated, "retain");
    f.stop(); await Promise.all([owner.release(), owner.release()]);
    for (const file of f.paths) await expect(access(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(unrelated, "utf8")).toBe("retain");
  });
  it("rejects either preexisting expected lock without deleting it", async () => {
    const f = await fixture(); await writeFile(f.paths[1]!, "preexisting");
    await expect(preflightOwnedEditorLocks(f.input)).rejects.toThrow("Preexisting");
    expect(await readFile(f.paths[1]!, "utf8")).toBe("preexisting");
  });
  it("retains both files when teardown is unconfirmed", async () => {
    const f = await fixture(); const owner = await preflightOwnedEditorLocks(f.input); await f.create(); await owner.capture();
    await expect(owner.release()).rejects.toThrow("teardown is not confirmed");
    for (const file of f.paths) await expect(access(file)).resolves.toBeUndefined();
  });
  it("retains the complete pair if either captured file changes", async () => {
    const f = await fixture(); const owner = await preflightOwnedEditorLocks(f.input); await f.create(); await owner.capture();
    await writeFile(f.paths[1]!, "changed"); f.stop();
    await expect(owner.release()).rejects.toThrow("changed after capture");
    for (const file of f.paths) await expect(access(file)).resolves.toBeUndefined();
  });
  it("rejects a hardlinked lock during capture", async () => {
    const f = await fixture(); const owner = await preflightOwnedEditorLocks(f.input); await f.create();
    await link(f.paths[0]!, path.join(f.input.projectRoot, "shared-lock"));
    await expect(owner.capture()).rejects.toThrow("single-link"); f.stop();
    await expect(owner.release()).rejects.toThrow("capture did not complete");
  });
  it("retains newly appeared locks if active-board capture never completed", async () => {
    const f = await fixture(); const owner = await preflightOwnedEditorLocks(f.input); await f.create(); f.stop();
    await expect(owner.release()).rejects.toThrow("Uncaptured");
    for (const file of f.paths) await expect(access(file)).resolves.toBeUndefined();
  });
  it("accepts normal editor removal of its captured locks", async () => {
    const f = await fixture(); const owner = await preflightOwnedEditorLocks(f.input); await f.create(); await owner.capture();
    await rm(f.paths[0]!); f.stop(); await owner.release();
    await expect(access(f.paths[1]!)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects a junction alias before launch", async () => {
    const f = await fixture(); const alias = path.join(f.input.outputRoot, "alias"); await symlink(f.input.projectRoot, alias, "junction");
    await expect(preflightOwnedEditorLocks({ ...f.input, projectRoot: alias, pcbPath: path.join(alias, "proof.kicad_pcb") })).rejects.toThrow(/aliased|link/u);
  });
  it("rejects a project outside the owned output", async () => {
    const f = await fixture(), other = await fixture();
    await expect(preflightOwnedEditorLocks({ ...f.input, projectRoot: other.input.projectRoot, pcbPath: other.input.pcbPath })).rejects.toThrow("confined");
  });
});
