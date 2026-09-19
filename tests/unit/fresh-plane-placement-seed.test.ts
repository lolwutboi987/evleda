import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import { captureClosedPlanePlacementRevisionSource, qualifyClosedPlanePlacementRevision, assertClosedPlanePlacementRevisionSourceCurrent } from "../../src/mcp/toolbox-placement-revision.js";
import { assertFreshPlanePlacementSeedProfile, freshPlanePlacementSeedPlan } from "../../src/harness/fresh-plane-placement-seed.js";
import { checkpointPlaneFreshProjectOpenNormalization, preparePlaneFreshProject, captureFreshProjectOpenPreparedSourceAuthority, FRESH_PROJECT_MARKER_NAME } from "../../src/harness/fresh-project.js";
import { createPcbPlaneCompilationBundleRef } from "../../src/harness/pcb-design-plane-bundle.js";
import { resumeKicadToolboxPlaneProject } from "../../src/mcp/toolbox-plane-preparation.js";
import { placementRevisionFixture } from "../helpers/placement-revision-fixture.js";

const fixtures: Awaited<ReturnType<typeof placementRevisionFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.f.cleanup(); });
async function qualified(authoredSettings = false) {
  const f = await placementRevisionFixture(); fixtures.push(f);
  const { preparation, input } = f;
  await writeFile(preparation.project.pcbPath, input.sources.pcb);
  await writeFile(preparation.project.schematicPath, input.sources.sch);
  await writeFile(path.join(preparation.project.projectPath, "seeded.kicad_pro"), input.sources.pro);
  if (authoredSettings) {
    const project = JSON.parse(input.sources.pro);
    project.board.viewports = [{ name: "Saved user view", x: 1, y: 2 }];
    project.user_note = "Preserve unrelated authored settings";
    input.sources.pro = JSON.stringify(project, null, 2) + "\n";
    await writeFile(preparation.project.projectPath + "/seeded.kicad_pro", input.sources.pro);
  }
  await preparation.project.checkpointAfterReport(preparation.reportPath, "needs_review");
  const context = { project: preparation.project, bundle: preparation.bundle, profile: f.f.profile,
    dependencies: f.f.dependencies, symbolRoot: f.f.symbolRoot };
  const receipt = await captureClosedPlanePlacementRevisionSource(context);
  if (receipt === undefined) throw new Error("Expected complete materialized source");
  let currentChecks = 0;
  const args = { receipt, sourceProjectId: f.sourceAllocation.projectId, targetProjectId: randomUUID(), sourceOutputDir: preparation.project.outputPath,
    name: "seeded", targetBundle: f.target, profile: f.f.profile, assertLeaseCurrent: async () => { currentChecks++; } };
  const selected = await qualifyClosedPlanePlacementRevision(args);
  return { ...f, args, receipt, selected, currentChecks: () => currentChecks };
}

describe("closed materialized placement seed", () => {
  it("preserves authored settings exactly and rejects changes during revision Open", async () => {
    const f = await qualified(true), target = await f.f.prepare(path.join(f.f.root, "authored-settings"), f.revised,
      { originalPrompt: f.target.originalPrompt, placementSeed: f.selected.seed, placementRevisionLineage: f.selected.lineage });
    const pro = path.join(target.project.projectPath, "seeded.kicad_pro");
    const settings = JSON.parse(await readFile(pro, "utf8"));
    expect(settings.board.viewports).toEqual([{ name: "Saved user view", x: 1, y: 2 }]);
    expect(settings.user_note).toBe("Preserve unrelated authored settings");
    const input = { project: target.project, placementSeed: f.selected.seed, expectedPreparedSourceAuthority: target.preparedSourceAuthority,
      expectedNetClassProjection: { netClasses: target.netClassSemanticAuthority.netClasses, contractNetAssignments: target.netClassSemanticAuthority.contractNetAssignments } };
    await expect(checkpointPlaneFreshProjectOpenNormalization(input)).resolves.toMatchObject({ changed: false });
    settings.user_note = "unexpected native change"; await writeFile(pro, JSON.stringify(settings, null, 2) + "\n");
    await expect(checkpointPlaneFreshProjectOpenNormalization(input)).rejects.toThrow(/authored project settings/);
  });
  it("issues a distinct native baseline, allows its exact Open normalization, and resumes only with its allocation lineage", async () => {
    const f = await qualified(), before = await Promise.all([readFile(f.preparation.project.pcbPath), readFile(f.preparation.project.markerPath), readFile(f.preparation.project.checkpointPath)]);
    const allocation = await f.f.store.allocate({ projectId: f.args.targetProjectId, name: "seeded", draft: f.revised,
      originalPrompt: f.target.originalPrompt, draftIdentity: contentIdentity(canonicalJson(f.revised)), placementRevisionLineage: f.selected.lineage });
    const target = await f.f.prepare(allocation.outputDir, f.revised, { originalPrompt: f.target.originalPrompt,
      placementSeed: f.selected.seed, placementRevisionLineage: f.selected.lineage });
    expect(await readFile(target.project.pcbPath, "utf8")).toBe(freshPlanePlacementSeedPlan(f.selected.seed).sources.pcb);
    expect(await readFile(target.project.schematicPath, "utf8")).toBe(f.input.sources.sch);
    expect(await captureFreshProjectOpenPreparedSourceAuthority(target.project)).toEqual(target.preparedSourceAuthority);
    expect(target.boardFeatureState).toBeDefined();
    expect(() => target.boardFeatureState!.verify("(kicad_pcb)")).toThrow();
    await expect(target.project.assertSchematicEmpty()).rejects.toThrow();
    const normalization = { project: target.project, expectedPreparedSourceAuthority: target.preparedSourceAuthority,
      expectedNetClassProjection: { netClasses: target.netClassSemanticAuthority.netClasses, contractNetAssignments: target.netClassSemanticAuthority.contractNetAssignments } };
    await expect(checkpointPlaneFreshProjectOpenNormalization(normalization)).rejects.toThrow(/authored zones/);
    await expect(checkpointPlaneFreshProjectOpenNormalization({ ...normalization, placementSeed: f.selected.seed })).resolves.toMatchObject({ changed: false });
    const resume = { outputDir: allocation.outputDir, name: "seeded", dependencies: f.f.dependencies,
      expectedKicadCli: f.f.expectedKicadCli, createKicadCliAdapter: f.f.createKicadCliAdapter };
    await expect(resumeKicadToolboxPlaneProject(resume)).rejects.toThrow(/immutable workspace allocation/);
    const reopened = await resumeKicadToolboxPlaneProject({ ...resume, placementRevisionLineage: f.selected.lineage });
    expect(reopened.mode).toBe("resumed");
    expect(reopened.placementRevisionLineage).toEqual(f.selected.lineage);
    expect((await f.f.store.lookup(allocation.projectId))!.placementRevisionLineage).toEqual(f.selected.lineage);
    expect(await Promise.all([readFile(f.preparation.project.pcbPath), readFile(f.preparation.project.markerPath), readFile(f.preparation.project.checkpointPath)])).toEqual(before);
    await assertClosedPlanePlacementRevisionSourceCurrent(f.receipt);
    expect(f.currentChecks()).toBeGreaterThanOrEqual(6);
    await expect(f.f.prepare(path.join(f.f.root, "reused"), f.revised, { originalPrompt: f.target.originalPrompt,
      placementSeed: f.selected.seed, placementRevisionLineage: f.selected.lineage })).rejects.toThrow(/reused/);
  });

  it("rejects forged close/seed authority, changed profiles and currentness failures before issuing a target", async () => {
    const f = await qualified();
    await expect(qualifyClosedPlanePlacementRevision({ ...f.args, receipt: { kind: "same-connection-closed-placement-source" } })).rejects.toThrow(/genuine close/);
    await expect(qualifyClosedPlanePlacementRevision({ ...f.args, name: "renamed" })).rejects.toThrow(/name/);
    await expect(qualifyClosedPlanePlacementRevision({ ...f.args, assertLeaseCurrent: async () => { throw new Error("Lease changed"); } })).rejects.toThrow(/Lease changed/);
    expect(() => assertFreshPlanePlacementSeedProfile(f.selected.seed, { ...f.f.profile, contentIdentity: contentIdentity("other") })).toThrow(/profile/);
    expect(() => freshPlanePlacementSeedPlan({ kind: "qualified-plane-placement-revision" })).toThrow(/issued/);
    await expect(preparePlaneFreshProject({ outputDir: path.join(f.f.root, "forged"), name: "seeded", resume: false,
      compilationBundle: f.target, compilationBundleRef: createPcbPlaneCompilationBundleRef(f.target), placementSeed: { kind: "qualified-plane-placement-revision" } })).rejects.toThrow(/issued/);
    await writeFile(f.preparation.project.schematicPath, f.input.sources.sch + "\n");
    await expect(assertClosedPlanePlacementRevisionSourceCurrent(f.receipt)).rejects.toThrow();
  });

  it("rejects changed source after qualification and does not publish a destination marker", async () => {
    const f = await qualified(), destination = path.join(f.f.root, "drifted-target");
    await writeFile(f.preparation.project.pcbPath, f.input.sources.pcb + "\n");
    await expect(f.f.prepare(destination, f.revised, { originalPrompt: f.target.originalPrompt,
      placementSeed: f.selected.seed, placementRevisionLineage: f.selected.lineage })).rejects.toThrow();
    await expect(readFile(path.join(destination, FRESH_PROJECT_MARKER_NAME))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a nonempty destination without replacing unrelated files", async () => {
    const f = await qualified(), destination = path.join(f.f.root, "occupied"); await mkdir(destination);
    await writeFile(path.join(destination, "user.txt"), "preserve");
    await expect(f.f.prepare(destination, f.revised, { originalPrompt: f.target.originalPrompt,
      placementSeed: f.selected.seed, placementRevisionLineage: f.selected.lineage })).rejects.toThrow(/empty/);
    expect(await readFile(path.join(destination, "user.txt"), "utf8")).toBe("preserve");
  });
});
