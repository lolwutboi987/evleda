import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalIdentity } from "../../src/core/canonical.js";
import { createFreshToolboxCheckpointLifecycle } from "../../src/mcp/toolbox-fresh-checkpoint.js";
import { prepareKicadToolboxFreshProject } from "../../src/mcp/toolbox-fresh-preparation.js";
import { prepareFreshProject } from "../../src/harness/fresh-project.js";
import { genericDividerDraft, createGenericDividerBundleFixture } from "../helpers/generic-divider-bundle.js";
import type { KicadCliAdapter, KicadExecutableIdentity } from "../../src/integrations/kicad-cli.js";
import type { KicadMcpSession } from "../../src/integrations/kicad-mcp-session.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "toolbox-checkpoint-")); roots.push(root);
  const identity: KicadExecutableIdentity = { kind: "kicad-cli", path: path.join(root, "kicad-cli.exe"), version: "10.0.3",
    commit: "146a4f2a7585c65bc580427a19b6fe2ec4a3f622", sha256: "a".repeat(64), sizeBytes: 100,
    capabilityHelpSha256: "b".repeat(64), confirmedCapabilities: ["pcb drc"] };
  const expectedKicadCli = { path: identity.path, contentIdentity: { algorithm: "sha256" as const, digest: identity.sha256, size: identity.sizeBytes },
    operationalVersion: identity.version, operationalCommit: identity.commit, peFileVersion: "10.0.3", peProductVersion: "10.0.3",
    identity: canonicalIdentity({ fixture: true }, "evleda.flux-kicad-cli-binding.v1") };
  const createKicadCliAdapter = vi.fn<typeof KicadCliAdapter.create>().mockResolvedValue({ identity } as KicadCliAdapter);
  const dependencies = createGenericDividerBundleFixture().dependencies;
  const input = { draft: genericDividerDraft(), originalPrompt: "Build divider", outputDir: path.join(root, "output"), name: "divider",
    dependencies, expectedKicadCli, createKicadCliAdapter };
  const prepared = await prepareKicadToolboxFreshProject(input);
  if (prepared.status !== "prepared") throw new Error("Fixture preparation failed");
  const preparation = prepared.preparation;
  const readActivePcbSource = vi.fn().mockImplementation(async () => readFile(preparation.project.pcbPath, "utf8"));
  const session = { readActivePcbSource } as unknown as KicadMcpSession;
  const lifecycle = createFreshToolboxCheckpointLifecycle({ project: preparation.project, preparation, session });
  return { preparation, lifecycle, readActivePcbSource, session, input };
}

describe("fresh toolbox saved-candidate checkpoint lifecycle", () => {
  it("publishes a guarded needs-review checkpoint once and permits exact source resume", async () => {
    const f = await fixture();
    const before = JSON.parse(await readFile(f.preparation.project.checkpointPath, "utf8"));
    const publish = await f.lifecycle.prepareCheckpoint();
    expect(JSON.parse(await readFile(f.preparation.project.checkpointPath, "utf8")).attempt).toBe(before.attempt);
    await publish();
    const report = JSON.parse(await readFile(f.preparation.reportPath, "utf8"));
    expect(report.status).toBe("needs_review"); expect(report.assurance).toContain("not design acceptance");
    const after = JSON.parse(await readFile(f.preparation.project.checkpointPath, "utf8"));
    expect(after.attempt).toBe(before.attempt + 1);
    await expect(publish()).rejects.toThrow("already consumed");
    await expect(prepareFreshProject({ outputDir: f.input.outputDir, name: f.input.name, resume: true, workflowKind: "generic",
      compilationBundle: f.preparation.bundle, compilationBundleRef: f.preparation.bundleRef })).resolves.toMatchObject({ pcbPath: f.preparation.project.pcbPath });
  });

  it("refuses divergent live PCB before exposing publication", async () => {
    const f = await fixture(); f.readActivePcbSource.mockResolvedValue("(kicad_pcb (version 20260206) (different yes))");
    await expect(f.lifecycle.prepareCheckpoint()).rejects.toThrow("Live PCB differs");
  });

  it.each(["board", "report", "bundle"])("refuses %s drift during teardown and preserves previous checkpoint", async kind => {
    const f = await fixture(); const publish = await f.lifecycle.prepareCheckpoint();
    const prior = await readFile(f.preparation.project.checkpointPath);
    const target = kind === "board" ? f.preparation.project.pcbPath : kind === "report" ? f.preparation.reportPath : f.preparation.bundlePath;
    await writeFile(target, `${await readFile(target, "utf8")}\n`);
    await expect(publish()).rejects.toThrow();
    expect(await readFile(f.preparation.project.checkpointPath)).toEqual(prior);
  });

  it("rejects altered report semantics before preparing a checkpoint", async () => {
    const f = await fixture(); const report = JSON.parse(await readFile(f.preparation.reportPath, "utf8"));
    report.status = "completed"; await writeFile(f.preparation.reportPath, JSON.stringify(report));
    await expect(f.lifecycle.prepareCheckpoint()).rejects.toThrow("Preparation report changed");
  });

  it("records uncertainty as an unsafe terminal that prevents resume", async () => {
    const f = await fixture(); await f.lifecycle.recordRecoveryRequired("native teardown uncertain");
    expect(JSON.parse(await readFile(f.preparation.project.unsafeTerminalPath, "utf8")).reason).toBe("native teardown uncertain");
    await expect(prepareFreshProject({ outputDir: f.input.outputDir, name: f.input.name, resume: true, workflowKind: "generic",
      compilationBundle: f.preparation.bundle, compilationBundleRef: f.preparation.bundleRef })).rejects.toThrow("unsafe");
  });
});
