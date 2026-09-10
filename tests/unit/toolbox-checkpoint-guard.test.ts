import { mkdtemp, readFile, writeFile, rm, rename, mkdir, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareFreshProject, captureFreshProjectCheckpointGuard, assertFreshProjectCheckpointGuardCurrent,
  refreshFreshProjectCheckpointGuardAfterOwnedClose,
  type FreshProjectCheckpointGuard } from "../../src/harness/fresh-project.js";
import { createGenericDividerBundleFixture } from "../helpers/generic-divider-bundle.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const output = await mkdtemp(path.join(tmpdir(), "toolbox-guard-")); roots.push(output);
  const bundle = createGenericDividerBundleFixture();
  const options = { outputDir: output, name: "guard", workflowKind: "generic" as const, compilationBundle: bundle.bundle, compilationBundleRef: bundle.reference };
  const project = await prepareFreshProject({ ...options, resume: false });
  const report = path.join(output, "pcb-agent-report.json");
  await writeFile(report, JSON.stringify({ status: "needs_review" }));
  return { project, report, options, output };
}

describe("authenticated fresh checkpoint source guard", () => {
  it("refreshes only an identical ordinary project-settings replacement after owned close", async () => {
    const f = await fixture(); const guard = await captureFreshProjectCheckpointGuard(f.project);
    const pro = path.join(f.project.projectPath, "guard.kicad_pro");
    const bytes = await readFile(pro); const replacement = path.join(f.project.projectPath, "replacement.tmp");
    await writeFile(replacement, bytes); await rename(replacement, pro);
    await expect(assertFreshProjectCheckpointGuardCurrent(f.project, guard)).rejects.toThrow();
    const refreshed = await refreshFreshProjectCheckpointGuardAfterOwnedClose(f.project, guard);
    expect(refreshed).not.toBe(guard);
    await assertFreshProjectCheckpointGuardCurrent(f.project, refreshed);
    await f.project.checkpointAfterReport(f.report, "needs_review", { sourceGuard: refreshed });
    await expect(assertFreshProjectCheckpointGuardCurrent(f.project, guard)).rejects.toThrow();
  });

  it.each(["changed-pro", "identical-pcb", "identical-table", "shared-pro"])("refuses post-close guard refresh for %s", async kind => {
    const f = await fixture(); const guard = await captureFreshProjectCheckpointGuard(f.project);
    const pro = path.join(f.project.projectPath, "guard.kicad_pro");
    const target = kind === "identical-pcb" ? f.project.pcbPath : kind === "identical-table" ? path.join(f.project.projectPath, "sym-lib-table") : pro;
    if (kind === "shared-pro") await link(pro, path.join(f.output, "shared-settings"));
    else {
      const bytes = await readFile(target); const replacement = path.join(f.project.projectPath, "replacement.tmp");
      await writeFile(replacement, kind === "changed-pro" ? Buffer.concat([bytes, Buffer.from("\n")]) : bytes);
      await rename(replacement, target);
    }
    await expect(refreshFreshProjectCheckpointGuardAfterOwnedClose(f.project, guard)).rejects.toThrow();
    await expect(readFile(f.project.checkpointPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("checkpoints exactly guarded authored bytes using the existing report/checkpoint format", async () => {
    const f = await fixture();
    await writeFile(f.project.pcbPath, `${await readFile(f.project.pcbPath, "utf8")}\n`);
    const sourceGuard = await captureFreshProjectCheckpointGuard(f.project);
    await assertFreshProjectCheckpointGuardCurrent(f.project, sourceGuard);
    await f.project.checkpointAfterReport(f.report, "needs_review", { sourceGuard });
    const checkpoint = JSON.parse(await readFile(f.project.checkpointPath, "utf8"));
    expect(checkpoint.schemaVersion).toBe("evleda.pcb-agent-fresh-project-checkpoint.v2");
    expect(checkpoint.reason).toBe("run_exit");
    expect(checkpoint.reportStatus).toBe("needs_review");
    await expect(prepareFreshProject({ ...f.options, resume: true })).resolves.toMatchObject({ pcbPath: f.project.pcbPath });
  });

  it.each(["pcb", "schematic", "marker", "table", "rules"])("rejects %s drift instead of checkpointing later bytes", async kind => {
    const f = await fixture(); const sourceGuard = await captureFreshProjectCheckpointGuard(f.project);
    const target = kind === "pcb" ? f.project.pcbPath : kind === "schematic" ? f.project.schematicPath
      : kind === "marker" ? f.project.markerPath : path.join(f.project.projectPath, kind === "table" ? "sym-lib-table" : "guard.kicad_dru");
    if (kind === "rules") await writeFile(target, "(version 1)\n");
    else await writeFile(target, `${await readFile(target, "utf8")}\n`);
    await expect(assertFreshProjectCheckpointGuardCurrent(f.project, sourceGuard)).rejects.toThrow();
    await expect(f.project.checkpointAfterReport(f.report, "needs_review", { sourceGuard })).rejects.toThrow();
    await expect(readFile(f.project.checkpointPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects replaced project directory identity", async () => {
    const f = await fixture(); const sourceGuard = await captureFreshProjectCheckpointGuard(f.project);
    await rename(f.project.projectPath, path.join(f.output, "former-project")); await mkdir(f.project.projectPath);
    await expect(f.project.checkpointAfterReport(f.report, "needs_review", { sourceGuard })).rejects.toThrow();
  });

  it("rejects serialized guards and guards from a different project capability", async () => {
    const f = await fixture(); const sourceGuard = await captureFreshProjectCheckpointGuard(f.project);
    const forged = JSON.parse(JSON.stringify(sourceGuard)) as FreshProjectCheckpointGuard;
    await expect(f.project.checkpointAfterReport(f.report, "needs_review", { sourceGuard: forged })).rejects.toThrow();
    const other = await fixture();
    await expect(other.project.checkpointAfterReport(other.report, "needs_review", { sourceGuard })).rejects.toThrow("another project capability");
  });

  it("keeps the existing final synchronous commit fence and unguarded callers working", async () => {
    const f = await fixture(); const sourceGuard = await captureFreshProjectCheckpointGuard(f.project);
    await expect(f.project.checkpointAfterReport(f.report, "needs_review", { sourceGuard,
      assertCanCommit: () => { throw new Error("stopped before rename"); } })).rejects.toThrow("stopped before rename");
    await expect(readFile(f.project.checkpointPath)).rejects.toMatchObject({ code: "ENOENT" });
    await f.project.checkpointAfterReport(f.report, "needs_review");
    expect(JSON.parse(await readFile(f.project.checkpointPath, "utf8")).reportStatus).toBe("needs_review");
  });
});
