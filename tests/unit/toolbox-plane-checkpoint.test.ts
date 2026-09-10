import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalIdentity } from "../../src/core/canonical.js";
import { createPlaneToolboxCheckpointLifecycle } from "../../src/mcp/toolbox-plane-checkpoint.js";
import { prepareKicadToolboxPlaneProject } from "../../src/mcp/toolbox-plane-preparation.js";
import { preparePlaneFreshProject } from "../../src/harness/fresh-project.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";
import { createKicadToolboxMcpServer } from "../../src/mcp/toolbox-server.js";
import type { ConnectedKicadToolbox } from "../../src/mcp/toolbox-session.js";
import { createGenericDividerBundleFixture } from "../helpers/generic-divider-bundle.js";
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
  const input = { draft: planeDividerDraft(), originalPrompt: "Build divider", outputDir: path.join(root, "output"), name: "divider",
    dependencies, expectedKicadCli, createKicadCliAdapter };
  const prepared = await prepareKicadToolboxPlaneProject(input);
  if (prepared.status !== "prepared") throw new Error("Fixture preparation failed");
  const preparation = prepared.preparation;
  const readActivePcbSource = vi.fn().mockImplementation(async () => readFile(preparation.project.pcbPath, "utf8"));
  const session = { readActivePcbSource } as unknown as KicadMcpSession;
  const lifecycle = createPlaneToolboxCheckpointLifecycle({ project: preparation.project, preparation, session });
  return { preparation, lifecycle, readActivePcbSource, session, input };
}

describe("plane toolbox saved-candidate checkpoint lifecycle", () => {
  it("publishes only after confirmed owning-host close while retaining the V2 bundle", async () => {
    const f = await fixture(); const order: string[] = [];
    const previousCheckpoint = await readFile(f.preparation.project.checkpointPath);
    const originalBundle = await readFile(f.preparation.bundlePath);
    const cad = { tools: { tools: [] }, assertCurrent: async () => {}, captureSources: async () => "saved",
      ...f.lifecycle, prepareCheckpoint: async () => {
        const publish = await f.lifecycle.prepareCheckpoint(); order.push("guard");
        return async () => { order.push("publish"); await publish(); };
      }, close: async () => {
        expect(await readFile(f.preparation.project.checkpointPath)).toEqual(previousCheckpoint);
        order.push("closed");
      } } as unknown as ConnectedKicadToolbox;
    const toolbox = createKicadToolboxMcpServer({ cad }); await toolbox.close();
    expect(order).toEqual(["guard", "closed", "publish"]);
    expect(await readFile(f.preparation.bundlePath)).toEqual(originalBundle);
    expect(JSON.parse(await readFile(f.preparation.reportPath, "utf8")).status).toBe("needs_review");
  });
  it("does not publish after uncertain close and poisons plane resume", async () => {
    const f = await fixture(); const previous = await readFile(f.preparation.project.checkpointPath);
    const cad = { tools: { tools: [] }, assertCurrent: async () => {}, captureSources: async () => "saved",
      ...f.lifecycle, close: async () => { throw new Error("owned exit unconfirmed"); } } as unknown as ConnectedKicadToolbox;
    const toolbox = createKicadToolboxMcpServer({ cad });
    await expect(toolbox.close()).rejects.toThrow("owned exit unconfirmed");
    expect(await readFile(f.preparation.project.checkpointPath)).toEqual(previous);
    expect(JSON.parse(await readFile(f.preparation.project.unsafeTerminalPath, "utf8")).reason).toContain("not confirmed");
  });
  it("rejects copied plane preparation shapes before creating a checkpoint lifecycle", async () => {
    const f = await fixture();
    expect(() => createPlaneToolboxCheckpointLifecycle({ project: f.preparation.project,
      preparation: { ...f.preparation }, session: f.session })).toThrow("authenticated V2");
  });
  it("publishes a guarded needs-review checkpoint once and permits exact source resume", async () => {
    const f = await fixture();
    const before = JSON.parse(await readFile(f.preparation.project.checkpointPath, "utf8"));
    const originalBundle = await readFile(f.preparation.bundlePath);
    const publish = await f.lifecycle.prepareCheckpoint();
    expect(JSON.parse(await readFile(f.preparation.project.checkpointPath, "utf8")).attempt).toBe(before.attempt);
    await publish();
    const report = JSON.parse(await readFile(f.preparation.reportPath, "utf8"));
    expect(report.status).toBe("needs_review"); expect(report.assurance).toContain("not design acceptance");
    const after = JSON.parse(await readFile(f.preparation.project.checkpointPath, "utf8"));
    expect(after.attempt).toBe(before.attempt + 1);
    expect(after.schemaVersion).toBe("evleda.pcb-agent-fresh-project-checkpoint.v3");
    expect(Object.keys(after.files)).toHaveLength(6);
    expect(await readFile(f.preparation.bundlePath)).toEqual(originalBundle);
    expect(report.workflow).toMatchObject({ kind: "plane", bundleRef: f.preparation.bundleRef });
    await expect(publish()).rejects.toThrow("already consumed");
    await expect(preparePlaneFreshProject({ outputDir: f.input.outputDir, name: f.input.name, resume: true,
      compilationBundle: f.preparation.bundle, compilationBundleRef: f.preparation.bundleRef })).resolves.toMatchObject({ pcbPath: f.preparation.project.pcbPath });
  });

  it("refuses divergent live PCB before exposing publication", async () => {
    const f = await fixture(); f.readActivePcbSource.mockResolvedValue("(kicad_pcb (version 20260206) (different yes))");
    await expect(f.lifecycle.prepareCheckpoint()).rejects.toThrow("Live PCB differs");
  });

  it.each(["board", "report", "bundle", "rules"])("refuses %s drift during teardown and preserves previous checkpoint", async kind => {
    const f = await fixture(); const publish = await f.lifecycle.prepareCheckpoint();
    const prior = await readFile(f.preparation.project.checkpointPath);
    const target = kind === "board" ? f.preparation.project.pcbPath : kind === "report" ? f.preparation.reportPath : kind === "rules" ? f.preparation.project.rulesPath : f.preparation.bundlePath;
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
    await expect(preparePlaneFreshProject({ outputDir: f.input.outputDir, name: f.input.name, resume: true,
      compilationBundle: f.preparation.bundle, compilationBundleRef: f.preparation.bundleRef })).rejects.toThrow("unsafe");
  });
});
