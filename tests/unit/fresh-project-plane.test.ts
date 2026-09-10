import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import {
  captureFreshProjectCheckpointGuard, assertFreshProjectCheckpointGuardCurrent,
  refreshFreshProjectCheckpointGuardAfterOwnedClose, captureFreshProjectOpenPreparedSourceAuthority,
  checkpointFreshProjectOpenNormalization, checkpointPlaneFreshProjectOpenNormalization,
  createGenericFreshProjectBinding, createPlaneFreshProjectBinding,
  isVerifiedFreshProject, isVerifiedPlaneFreshProject, migrateFreshProjectCheckpoint,
  prepareFreshProject, preparePlaneFreshProject, type FreshProjectManagedNetClass,
  type FreshProjectNetClassSemanticProjection,
} from "../../src/harness/fresh-project.js";
import {
  createPcbPlaneCompilationBundle, createPcbPlaneCompilationBundleRef,
  isAuthenticatedPcbPlaneCompilationBundle, parsePcbPlaneCompilationBundle,
  serializePcbPlaneCompilationBundle,
} from "../../src/harness/pcb-design-plane-bundle.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { createFreshPlaneRules } from "../../src/harness/fresh-plane-rules.js";
import { createExactContractNetClassPatterns } from "../../src/harness/fresh-netclass-assignment.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";
import { createGenericDividerBundleFixture, genericDividerLibraryResolver } from "../helpers/generic-divider-bundle.js";

const dependencies = { libraryResolver: genericDividerLibraryResolver, deepRuleCatalog: loadDeepRuleCatalog() };
const compilation = compilePcbPlaneDesignIntentDraft(planeDividerDraft(), dependencies);
if (compilation.disposition !== "ready") throw new Error(JSON.stringify(compilation.issues));
const bundle = createPcbPlaneCompilationBundle({ originalPrompt: "Synthetic plane preparation fixture.", compilation }, dependencies);
const bundleRef = createPcbPlaneCompilationBundleRef(bundle);
const rules = createFreshPlaneRules(bundle);
const owned = new Set<string>();
afterEach(async () => {
  for (const directory of owned) {
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) throw new Error("Unsafe test cleanup target");
    await rm(resolved, { recursive: true, force: true });
  }
  owned.clear();
});
const directory = async () => { const value = await mkdtemp(path.join(os.tmpdir(), "evleda-plane-project-")); owned.add(value); return value; };
const options = (outputDir: string, resume = false, name = "plane-fixture") => ({ outputDir, name, resume, compilationBundle: bundle, compilationBundleRef: bundleRef });
const report = async (project: { outputPath: string }) => {
  const file = path.join(project.outputPath, "pcb-agent-report.json");
  await writeFile(file, JSON.stringify({ status: "needs_review" })); return file;
};
const definition = (name: string, track: number, clearance: number, priority = -1): FreshProjectManagedNetClass => ({
  bus_width: 12, clearance, diff_pair_gap: 0.25, diff_pair_via_gap: 0.25, diff_pair_width: track,
  line_style: 0, microvia_diameter: 0.3, microvia_drill: 0.1, name, pcb_color: "rgba(0, 0, 0, 0.000)",
  priority, schematic_color: "rgba(0, 0, 0, 0.000)", track_width: track, tuning_profile: "",
  via_diameter: 0.6, via_drill: 0.3, wire_width: 6,
});
async function initialOpenFixture() {
  const project = await preparePlaneFreshProject(options(await directory()));
  const netClasses = bundle.contract.netClasses.map((netClass, index) => definition(
    `EVLEDA_${bundle.identity.digest.slice(0, 12)}_C${String(index + 1).padStart(2, "0")}`, netClass.traceWidthMm, netClass.clearanceMm));
  const projection: FreshProjectNetClassSemanticProjection = { netClasses,
    contractNetAssignments: bundle.contract.nets.map(net => ({ netName: net.name, contractNetClassId: net.netClassId,
      kicadNetClassName: netClasses[bundle.contract.netClasses.findIndex(entry => entry.id === net.netClassId)]!.name })) };
  const proPath = path.join(project.projectPath, `${project.name}.kicad_pro`);
  const pro = JSON.parse(await readFile(proPath, "utf8"));
  pro.board.design_settings = { rules: { min_clearance: 0 } };
  pro.net_settings = { meta: { version: 5 }, classes: [definition("Default", 0.2, 0.2, 2_147_483_647), ...netClasses],
    net_colors: null, netclass_assignments: {}, netclass_patterns: createExactContractNetClassPatterns(projection.contractNetAssignments) };
  await writeFile(proPath, JSON.stringify(pro, null, 2) + "\n");
  const prepared = await captureFreshProjectOpenPreparedSourceAuthority(project);
  await report(project);
  return { project, projection, proPath, pro, prepared };
}

describe("explicit V2 plane fresh-project preparation", () => {
  it("binds actual authenticated plane children and owned rules without invented V1 fields", () => {
    const value = createPlaneFreshProjectBinding(bundle, bundleRef);
    expect(value.binding).toMatchObject({ schemaVersion: "evleda.pcb-agent-plane-fresh-binding.v1", family: "plane-v2",
      bundleRef, contractIdentity: bundle.contract.identity, libraryBindingIdentity: bundle.libraryBinding.identity,
      deepRuleBindingIdentity: bundle.deepRuleBinding.identity, verificationPlanIdentity: bundle.verificationPlan.identity,
      guidanceContentIdentity: contentIdentity(bundle.executionGuidance), originalPromptContentIdentity: bundle.originalPromptContentIdentity,
      expectedRulesContentIdentity: rules.identity });
    expect(value.rulesSource).toBe(rules.source);
    for (const field of ["practiceProfileBindingIdentity", "acceptancePlanIdentity", "executionPromptContentIdentity", "genericBinding"]) expect(value.binding).not.toHaveProperty(field);
    expect(isAuthenticatedPcbPlaneCompilationBundle(bundle)).toBe(true);
    expect(isAuthenticatedPcbPlaneCompilationBundle(structuredClone(bundle))).toBe(false);
    expect(() => createPlaneFreshProjectBinding(structuredClone(bundle), bundleRef)).toThrow(/authenticated/);
    const parsed = parsePcbPlaneCompilationBundle(serializePcbPlaneCompilationBundle(bundle), dependencies);
    expect(createPlaneFreshProjectBinding(parsed, bundleRef).binding).toEqual(value.binding);
    const forgedRef = { ...bundleRef, contentIdentity: { ...bundleRef.contentIdentity, digest: "0".repeat(64) } };
    expect(() => createPlaneFreshProjectBinding(bundle, forgedRef)).toThrow();
  });

  it("prepares and resumes a blank V3 marker with exactly six original files", async () => {
    const input = options(await directory());
    const project = await preparePlaneFreshProject(input);
    expect(isVerifiedFreshProject(project)).toBe(true);
    expect(isVerifiedPlaneFreshProject(project)).toBe(true);
    expect(isVerifiedPlaneFreshProject({ ...project })).toBe(false);
    expect(project.workflowKind).toBe("plane");
    expect(project).not.toHaveProperty("genericBinding");
    expect(Object.isFrozen(project.planeBinding.bundleRef)).toBe(true);
    const markerBytes = await readFile(project.markerPath);
    const marker = JSON.parse(markerBytes.toString());
    expect(Object.keys(marker.files)).toEqual(["pro", "sch", "pcb", "symLibTable", "fpLibTable", "dru"]);
    expect(marker.files.dru).toEqual({ path: project.rulesPath, sha256: rules.identity.digest });
    expect(marker.schemaVersion).toBe("evleda.pcb-agent-fresh-project.v3");
    expect(marker.planeBinding).toEqual(project.planeBinding);
    expect(await readFile(project.rulesPath, "utf8")).toBe(rules.source);
    expect(await project.assertMarkerCurrent()).toEqual(contentIdentity(markerBytes));
    await expect(project.assertSchematicEmpty()).resolves.toBeUndefined();
    const authority = await captureFreshProjectOpenPreparedSourceAuthority(project);
    expect(authority.marker).toEqual(contentIdentity(markerBytes));
    const resumed = await preparePlaneFreshProject({ ...input, resume: true });
    expect(isVerifiedPlaneFreshProject(resumed)).toBe(true);
    expect(resumed.planeBinding.identity).toEqual(project.planeBinding.identity);
    expect(await readFile(project.markerPath)).toEqual(markerBytes);
    const otherBundle = createPcbPlaneCompilationBundle({ originalPrompt: "Another independently authenticated request.", compilation }, dependencies);
    await expect(preparePlaneFreshProject({ ...input, resume: true, compilationBundle: otherBundle,
      compilationBundleRef: createPcbPlaneCompilationBundleRef(otherBundle) })).rejects.toThrow(/another V2 compilation bundle/);
    expect(await readFile(project.markerPath)).toEqual(markerBytes);
    expect((await readdir(project.projectPath)).sort()).toEqual([
      "fp-lib-table", "plane-fixture.kicad_dru", "plane-fixture.kicad_pcb", "plane-fixture.kicad_pro", "plane-fixture.kicad_sch", "sym-lib-table",
    ]);
  });

  it("checkpoints authored plane bytes and resumes them without inventing an empty prepared baseline", async () => {
    const input = options(await directory());
    const project = await preparePlaneFreshProject(input);
    const marker = await readFile(project.markerPath);
    const pcb = (await readFile(project.pcbPath, "utf8")).replace("(general)", '(general) (zone (net "GND") (layer "B.Cu"))');
    await writeFile(project.pcbPath, pcb);
    const reportPath = await report(project);
    const guard = await captureFreshProjectCheckpointGuard(project);
    await project.checkpointAfterReport(reportPath, "needs_review", { sourceGuard: guard });
    const checkpointBytes = await readFile(project.checkpointPath);
    const checkpoint = JSON.parse(checkpointBytes.toString());
    expect(checkpoint).toMatchObject({ schemaVersion: "evleda.pcb-agent-fresh-project-checkpoint.v3", planeBindingIdentity: project.planeBinding.identity,
      files: { dru: { path: project.rulesPath, sha256: rules.identity.digest }, pcb: { sha256: contentIdentity(pcb).digest } } });
    expect(checkpoint).not.toHaveProperty("genericBindingIdentity");
    const resumed = await preparePlaneFreshProject({ ...input, resume: true });
    expect(await readFile(resumed.pcbPath, "utf8")).toBe(pcb);
    await expect(captureFreshProjectOpenPreparedSourceAuthority(resumed)).rejects.toThrow(/immutable marker baseline/);
    expect(await readFile(project.markerPath)).toEqual(marker);
    expect(await readFile(project.checkpointPath)).toEqual(checkpointBytes);
  });

  it("rejects V2 in generic, LED, migration, and legacy Open paths before any fallback", async () => {
    const output = await directory();
    const old = createGenericDividerBundleFixture();
    expect(() => createGenericFreshProjectBinding(bundle as any, bundleRef as any)).toThrow();
    expect(() => createPlaneFreshProjectBinding(old.bundle as any, old.reference as any)).toThrow(/authenticated/);
    await expect(prepareFreshProject({ ...options(output), workflowKind: "generic" } as any)).rejects.toThrow();
    await expect(prepareFreshProject(options(output) as any)).rejects.toThrow(/explicit.*workflow/);
    expect(await readdir(output)).toEqual([]);
    const project = await preparePlaneFreshProject(options(output));
    await report(project);
    await expect(prepareFreshProject({ outputDir: output, name: project.name, resume: true })).rejects.toThrow(/explicit plane workflow/);
    await expect(prepareFreshProject({ outputDir: output, name: project.name, resume: true, workflowKind: "generic", compilationBundle: old.bundle, compilationBundleRef: old.reference })).rejects.toThrow(/explicit plane workflow/);
    await expect(migrateFreshProjectCheckpoint({ outputDir: output, name: project.name })).rejects.toThrow(/explicit plane workflow/);
    await expect(checkpointFreshProjectOpenNormalization({ outputDir: output, name: project.name })).rejects.toThrow(/explicit plane Open/);
    await expect(preparePlaneFreshProject({ outputDir: await directory(), name: "old-family", resume: false, compilationBundle: old.bundle as any, compilationBundleRef: old.reference as any })).rejects.toThrow(/authenticated/);
  });

  it("rejects marker, child-binding, checkpoint, and file-inventory drift", async () => {
    const input = options(await directory());
    const project = await preparePlaneFreshProject(input);
    const markerBytes = await readFile(project.markerPath);
    const original = JSON.parse(markerBytes.toString());
    for (const mutate of [
      (m: any) => { m.planeBinding.family = "generic"; },
      (m: any) => { m.planeBinding.contractIdentity.schemaVersion = "evleda.pcb-design-contract.v1"; },
      (m: any) => { m.planeBinding.verificationPlanIdentity.digest = "a".repeat(64); },
      (m: any) => { m.genericBinding = m.planeBinding; },
      (m: any) => { delete m.files.dru; },
      (m: any) => { m.files.dru.path += ".other"; },
    ]) {
      const changed = structuredClone(original); mutate(changed);
      await writeFile(project.markerPath, JSON.stringify(changed));
      await expect(preparePlaneFreshProject({ ...input, resume: true })).rejects.toThrow();
    }
    await writeFile(project.markerPath, markerBytes);
    const reportPath = await report(project); await project.checkpointAfterReport(reportPath, "needs_review");
    const checkpointBytes = await readFile(project.checkpointPath);
    const checkpoint = JSON.parse(checkpointBytes.toString());
    checkpoint.planeBindingIdentity.digest = "b".repeat(64);
    await writeFile(project.checkpointPath, JSON.stringify(checkpoint));
    await expect(preparePlaneFreshProject({ ...input, resume: true })).rejects.toThrow(/exact V2 bundle/);
    await writeFile(project.checkpointPath, checkpointBytes);
    await writeFile(path.join(project.projectPath, "sym-lib-table"), "changed");
    await expect(preparePlaneFreshProject({ ...input, resume: true })).rejects.toThrow(/library tables/);
  });

  it("rejects owned-rule changes at marker, resume, checkpoint, and source-guard boundaries", async () => {
    const input = options(await directory()); const project = await preparePlaneFreshProject(input);
    const reportPath = await report(project); await project.checkpointAfterReport(reportPath, "needs_review");
    const checkpointBytes = await readFile(project.checkpointPath);
    const guard = await captureFreshProjectCheckpointGuard(project);
    await writeFile(project.rulesPath, rules.source + "\n");
    await expect(project.assertMarkerCurrent()).rejects.toThrow(/owned rules/);
    await expect(preparePlaneFreshProject({ ...input, resume: true })).rejects.toThrow(/owned rules/);
    await expect(project.checkpointAfterReport(reportPath, "needs_review")).rejects.toThrow(/owned rules/);
    await expect(assertFreshProjectCheckpointGuardCurrent(project, guard)).rejects.toThrow();
    expect(await readFile(project.checkpointPath)).toEqual(checkpointBytes);
    await writeFile(project.rulesPath, rules.source);
    const ruleGuard = await captureFreshProjectCheckpointGuard(project);
    const replacement = `${project.rulesPath}.replacement`;
    await writeFile(replacement, rules.source, { flag: "wx" }); await rename(replacement, project.rulesPath);
    await expect(assertFreshProjectCheckpointGuardCurrent(project, ruleGuard)).rejects.toThrow(/validated snapshot changed/);
    await expect(refreshFreshProjectCheckpointGuardAfterOwnedClose(project, ruleGuard)).rejects.toThrow(/validated snapshot changed/);
  });

  it("normalizes initial plane Open explicitly, preserving rules and publishing a V3 checkpoint", async () => {
    const { project, proPath, pro, projection, prepared } = await initialOpenFixture();
    await writeFile(proPath, JSON.stringify(pro));
    const args = { project, expectedNetClassProjection: projection, expectedPreparedSourceAuthority: prepared };
    await expect(checkpointPlaneFreshProjectOpenNormalization(args)).resolves.toMatchObject({ changed: true });
    await expect(checkpointPlaneFreshProjectOpenNormalization(args)).resolves.toMatchObject({ changed: false });
    const checkpoint = JSON.parse(await readFile(project.checkpointPath, "utf8"));
    expect(checkpoint.schemaVersion).toBe("evleda.pcb-agent-fresh-project-checkpoint.v3");
    expect(checkpoint.files.dru).toEqual({ path: project.rulesPath, sha256: rules.identity.digest });
    expect(await readFile(project.rulesPath, "utf8")).toBe(rules.source);
    await expect(checkpointPlaneFreshProjectOpenNormalization({ ...args, project: { ...project } })).rejects.toThrow(/authenticated plane/);
    const altered = { ...prepared, marker: { ...prepared.marker, digest: "c".repeat(64) } };
    await expect(checkpointPlaneFreshProjectOpenNormalization({ ...args, expectedPreparedSourceAuthority: altered })).rejects.toThrow(/authority identity/);
  });

  it("fences a .dru race before initial Open checkpoint publication", async () => {
    const { project, proPath, pro, projection, prepared } = await initialOpenFixture();
    await writeFile(proPath, JSON.stringify(pro));
    await expect(checkpointPlaneFreshProjectOpenNormalization({ project, expectedNetClassProjection: projection,
      expectedPreparedSourceAuthority: prepared, testHooks: { beforeCheckpointCommit: async () => {
        await writeFile(project.rulesPath, rules.source + "\n");
      } } })).rejects.toThrow(/validated snapshot changed/);
    await expect(readFile(project.checkpointPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(project.outputPath)).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });

  it("does not promote authored-plane checkpoints through initial Open normalization", async () => {
    const { project, proPath, pro, projection, prepared } = await initialOpenFixture();
    const pcb = (await readFile(project.pcbPath, "utf8")).replace("(general)", '(general) (zone (net "GND") (layer "B.Cu"))');
    await writeFile(project.pcbPath, pcb); await project.checkpointAfterReport(await report(project), "needs_review");
    await writeFile(proPath, JSON.stringify(pro));
    await expect(checkpointPlaneFreshProjectOpenNormalization({ project, expectedNetClassProjection: projection,
      expectedPreparedSourceAuthority: prepared })).rejects.toThrow(/immutable empty marker baseline/);
  });

  it("retains exact V1/generic binding bytes and five-file marker/checkpoint serialization", async () => {
    const old = createGenericDividerBundleFixture(); const generated = createGenericFreshProjectBinding(old.bundle, old.reference);
    expect(generated.binding.identity.digest).toBe("e766d74035197f4d2db275a933fd0624f641c81cf38724cfda6b15185586d543");
    expect(contentIdentity(canonicalJson(generated.binding))).toEqual({ algorithm: "sha256", digest: "5bf83299da47afe63b8d55f092d0b6f7bef6e39b2961e5c012a36fbcbfda1748", size: 2467 });
    expect(contentIdentity(generated.symbolTable).digest).toBe("407135ab05709f05c8b0f408eda1a2247436f160045e081783a39d8872c805ec");
    expect(contentIdentity(generated.footprintTable).digest).toBe("46b138d4edfa14567c1a2f84f7d7cbf6ab50ab40ce03c7fde708832710468cff");
    for (const generic of [false, true]) {
      const outputDir = await directory();
      const project = await prepareFreshProject(generic ? { outputDir, name: "legacy-bytes", resume: false, workflowKind: "generic", compilationBundle: old.bundle, compilationBundleRef: old.reference }
        : { outputDir, name: "legacy-bytes", resume: false });
      const text = await readFile(project.markerPath, "utf8"); const m = JSON.parse(text);
      const expected = generic ? { schemaVersion: "evleda.pcb-agent-fresh-project.v2", workflowKind: "generic", name: m.name, outputPath: m.outputPath, projectPath: m.projectPath, projectIdentity: m.projectIdentity, files: m.files, genericBinding: generated.binding }
        : { schemaVersion: "evleda.pcb-agent-fresh-project.v1", name: m.name, outputPath: m.outputPath, projectPath: m.projectPath, projectIdentity: m.projectIdentity, files: m.files };
      expect(text).toBe(JSON.stringify(expected, null, 2) + "\n");
      expect(Object.keys(m.files)).toEqual(["pro", "sch", "pcb", "symLibTable", "fpLibTable"]);
      await project.checkpointAfterReport(await report(project), "needs_review");
      const cText = await readFile(project.checkpointPath, "utf8"); const c = JSON.parse(cText);
      expect(c.schemaVersion).toBe(generic ? "evleda.pcb-agent-fresh-project-checkpoint.v2" : "evleda.pcb-agent-fresh-project-checkpoint.v1");
      expect(Object.keys(c.files)).toHaveLength(5); expect(c).not.toHaveProperty("planeBindingIdentity");
      const { schemaVersion, baselineMarkerSha256, projectPath, files, reportPath, reportSha256, reportStatus, attempt, reason } = c;
      const base = { schemaVersion, baselineMarkerSha256, projectPath, files, reportPath, reportSha256, reportStatus, attempt, reason };
      const expectedCheckpoint = generic ? { ...base, genericBindingIdentity: generated.binding.identity,
        symbolLibraryTableIdentity: generated.binding.symbolLibraryTableIdentity, footprintLibraryTableIdentity: generated.binding.footprintLibraryTableIdentity } : base;
      expect(cText).toBe(JSON.stringify(expectedCheckpoint, null, 2) + "\n");
    }
  });

  it("retains the common unsafe-terminal resume prohibition for the plane family", async () => {
    const input = options(await directory());
    const project = await preparePlaneFreshProject(input);
    await project.recordUnsafeTerminal(await report(project), "Synthetic unresolved native transaction for guard testing.");
    await expect(preparePlaneFreshProject({ ...input, resume: true })).rejects.toThrow(/unsafe connectivity terminal/);
    expect(await readFile(project.rulesPath, "utf8")).toBe(rules.source);
  });
});
