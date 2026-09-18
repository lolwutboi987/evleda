import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import { validateUnwiredPlaneSchematicSeed, assertFreshPlaneSchematicSeedProfile, issueFreshPlaneSchematicSeed } from "../../src/harness/fresh-plane-schematic-seed.js";
import { captureFreshProjectOpenPreparedSourceAuthority, checkpointPlaneFreshProjectOpenNormalization, preparePlaneFreshProject,
  FRESH_PROJECT_MARKER_NAME } from "../../src/harness/fresh-project.js";
import { createPcbPlaneCompilationBundleRef } from "../../src/harness/pcb-design-plane-bundle.js";
import { qualifyClosedPlaneSchematicSeed, assertClosedPlaneSchematicSeedSourceCurrent,
  captureClosedPlaneSchematicSeedSource } from "../../src/mcp/toolbox-schematic-seed.js";
import { resumeKicadToolboxPlaneProject } from "../../src/mcp/toolbox-plane-preparation.js";
import { unwiredPlaneSeedFixture } from "../helpers/unwired-plane-seed.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";

const fixtures: Awaited<ReturnType<typeof unwiredPlaneSeedFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });
const fixture = async () => { const f = await unwiredPlaneSeedFixture(); fixtures.push(f); return f; };
const changedDraft = () => { const draft = planeDividerDraft(); draft.placementConstraints[1]!.regionMm.maxYmm -= 0.01; return draft; };
async function qualified(f: Awaited<ReturnType<typeof fixture>>, sourceDraft = planeDividerDraft()) {
  const source = await f.closedSource(sourceDraft), targetProjectId = randomUUID(), draft = structuredClone(sourceDraft);
  draft.placementConstraints[1]!.regionMm.maxYmm -= 0.01;
  const bundle = f.compile(draft);
  const lease = await f.store.acquireLease(source.projectId);
  const input = { receipt: source.receipt, sourceProjectId: source.projectId, sourceOutputDir: source.allocation.outputDir,
    targetProjectId, name: "seeded", targetBundle: bundle, profile: f.profile, assertLeaseCurrent: lease.assertCurrent! };
  return { source, targetProjectId, draft, bundle, lease, input, value: await qualifyClosedPlaneSchematicSeed(input) };
}

describe("qualified unwired V2 schematic seeding", () => {
  it.each(["initial-directory", "initial-nonempty", "final-directory", "final-source"])("fences destination %s changes across source-currentness awaits", async change => {
    const f = await fixture(), bundle = f.compile(), outputDir = path.join(f.root, "destination"), redirected = path.join(f.root, "redirected");
    await mkdir(outputDir); await mkdir(redirected); let checks = 0;
    const seed = issueFreshPlaneSchematicSeed({ source: f.source(bundle), name: "seeded", bundle, profile: f.profile, librarySources: f.librarySources,
      assertCurrent: async () => {
        checks++;
        if (checks !== (change.startsWith("initial") ? 1 : 2)) return;
        if (change.endsWith("directory")) { await rename(outputDir, outputDir + "-retained"); await symlink(redirected, outputDir, "junction"); }
        else if (change === "initial-nonempty") await writeFile(path.join(outputDir, "unexpected"), "unexpected");
        else await writeFile(path.join(outputDir, "project", "seeded.kicad_sch"), "changed source");
      } });
    await expect(preparePlaneFreshProject({ outputDir, name: "seeded", resume: false, compilationBundle: bundle,
      compilationBundleRef: createPcbPlaneCompilationBundleRef(bundle), schematicSeed: seed })).rejects.toThrow();
    await expect(readFile(path.join(outputDir, FRESH_PROJECT_MARKER_NAME))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(redirected)).toEqual([]);
  });

  it("copies the exact partial schematic before marker issuance and preserves initial Open, close and resume authority", async () => {
    const f = await fixture(), q = await qualified(f);
    const before = await Promise.all([readFile(q.source.preparation.project.schematicPath), readFile(q.source.preparation.project.markerPath), readFile(q.source.preparation.project.checkpointPath)]);
    const allocated = await f.store.allocate({ projectId: q.targetProjectId, name: "seeded", originalPrompt: "Synthetic unwired seed test",
      draft: q.draft, draftIdentity: contentIdentity(canonicalJson(q.draft)), schematicSeedLineage: q.value.lineage });
    const target = await f.prepare(allocated.outputDir, q.draft, { schematicSeed: q.value.seed });
    expect(await readFile(target.project.schematicPath, "utf8")).toBe(q.source.bytes);
    expect(JSON.parse(await readFile(target.project.markerPath, "utf8")).files.sch.sha256).toBe(contentIdentity(q.source.bytes).digest);
    expect(target.bundle.identity).not.toEqual(q.source.preparation.bundle.identity);
    expect(await captureFreshProjectOpenPreparedSourceAuthority(target.project)).toEqual(target.preparedSourceAuthority);
    await expect(target.project.assertSchematicEmpty()).rejects.toThrow();
    expect(await checkpointPlaneFreshProjectOpenNormalization({ project: target.project,
      expectedPreparedSourceAuthority: target.preparedSourceAuthority,
      expectedNetClassProjection: { netClasses: target.netClassSemanticAuthority.netClasses,
        contractNetAssignments: target.netClassSemanticAuthority.contractNetAssignments } })).toMatchObject({ changed: false });
    await target.project.checkpointAfterReport(target.reportPath, "needs_review");
    const resumed = await resumeKicadToolboxPlaneProject({ outputDir: allocated.outputDir, name: "seeded", dependencies: f.dependencies,
      expectedKicadCli: f.expectedKicadCli, createKicadCliAdapter: f.createKicadCliAdapter });
    expect(await readFile(resumed.project.schematicPath, "utf8")).toBe(q.source.bytes);
    expect((await f.store.lookup(allocated.projectId))!.schematicSeedLineage).toEqual(q.value.lineage);
    expect(await Promise.all([readFile(q.source.preparation.project.schematicPath), readFile(q.source.preparation.project.markerPath), readFile(q.source.preparation.project.checkpointPath)])).toEqual(before);
    await assertClosedPlaneSchematicSeedSourceCurrent(q.source.receipt);
    await expect(f.prepare(path.join(f.root, "reuse"), q.draft, { schematicSeed: q.value.seed })).rejects.toThrow(/reused/);
    await unlink(target.project.checkpointPath);
    await expect(resumeKicadToolboxPlaneProject({ outputDir: allocated.outputDir, name: "seeded", dependencies: f.dependencies,
      expectedKicadCli: f.expectedKicadCli, createKicadCliAdapter: f.createKicadCliAdapter })).rejects.toThrow();
  });

  it("requires a genuine close receipt, same project stem and exact native source profile", async () => {
    const f = await fixture(), q = await qualified(f);
    await expect(qualifyClosedPlaneSchematicSeed({ ...q.input, receipt: { kind: "same-connection-closed-plane-source" } })).rejects.toThrow(/successful close/);
    await expect(qualifyClosedPlaneSchematicSeed({ ...q.input, name: "renamed" })).rejects.toThrow(/name/);
    await expect(qualifyClosedPlaneSchematicSeed({ ...q.input, profile: { ...f.profile, path: path.join(f.root, "other.json") } })).rejects.toThrow(/profile/);
    expect(() => assertFreshPlaneSchematicSeedProfile(q.value.seed, { ...f.profile, contentIdentity: contentIdentity("different profile") })).toThrow(/profile/);
    await expect(qualifyClosedPlaneSchematicSeed({ ...q.input, assertLeaseCurrent: async () => { throw new Error("lease replaced"); } })).rejects.toThrow(/lease replaced/);
  });

  it("permits only the explicit PCB implementation paths and prompt metadata", async () => {
    const f = await fixture(), q = await qualified(f), draft = { ...changedDraft(), nativeRuleMode: "contract-derived-v1" as const };
    Object.assign(draft.routingConstraints, { minimumHoleToHoleMm: 0.5 });
    draft.routingConstraints.viaPolicy.maxTotal = 3;
    draft.netClasses[0]!.traceWidthMm = 0.4;
    draft.nets.find(net => net.name === "VOUT")!.netClassId = "POWER";
    draft.netClasses = draft.netClasses.filter(netClass => netClass.id !== "SENSE");
    const revised = await qualifyClosedPlaneSchematicSeed({ ...q.input, targetBundle: f.compile(draft, "Reviewed PCB routing and placement revision") });
    expect(revised.lineage.sourceSchematicIdentity).toEqual(contentIdentity(q.source.bytes));
    const target = await f.prepare(path.join(f.root, "pcb-revision"), draft, { originalPrompt: "Reviewed PCB routing and placement revision", schematicSeed: revised.seed });
    expect(await readFile(target.project.schematicPath, "utf8")).toBe(q.source.bytes);
    expect(target.bundle.contract.nativeRuleMode).toBe("contract-derived-v1");
  });

  it("permits a stricter edge margin by changing only plane rectangle coordinates and allowed class settings", async () => {
    const f = await fixture(), original = planeDividerDraft();
    original.netClasses.forEach(netClass => { netClass.copperToEdgeMm = 0.25; });
    original.planes[0]!.boundary = { kind: "rectangle", minXmm: 0.25, minYmm: 0.25, maxXmm: 29.75, maxYmm: 19.75 };
    const q = await qualified(f, original), revised = structuredClone(q.draft);
    revised.netClasses.forEach(netClass => { netClass.copperToEdgeMm = 0.5; });
    expect(() => f.compile(revised)).toThrow(/boundary/);
    revised.planes[0]!.boundary = { kind: "rectangle", minXmm: 0.5, minYmm: 0.5, maxXmm: 29.5, maxYmm: 19.5 };
    const bundle = f.compile(revised), qualifiedSeed = await qualifyClosedPlaneSchematicSeed({ ...q.input, targetBundle: bundle });
    const target = await f.prepare(path.join(f.root, "edge-revision"), revised, { schematicSeed: qualifiedSeed.seed });
    expect(await readFile(target.project.schematicPath, "utf8")).toBe(q.source.bytes);
    expect(target.bundle.contract.planes[0]!.boundary).toEqual(revised.planes[0]!.boundary);
    const { boundary: _old, ...oldSettings } = q.source.preparation.bundle.contract.planes[0]!;
    const { boundary: _new, ...newSettings } = target.bundle.contract.planes[0]!;
    expect(newSettings).toEqual(oldSettings);
    await assertClosedPlaneSchematicSeedSourceCurrent(q.source.receipt);
  });

  it.each(["id", "layer", "clearance", "minimum-copper", "thermal", "islands"])("rejects a valid adjacent plane %s revision", async change => {
    const f = await fixture(), q = await qualified(f), revised = structuredClone(q.draft), p = revised.planes[0]!;
    if (change === "id") {
      p.id = "OTHER_PLANE";
      for (const route of revised.routingConstraints.nets) {
        if (route.topology === "plane") route.planeId = p.id;
        if ("referencePath" in route && route.referencePath.mode === "continuous_plane") route.referencePath.planeId = p.id;
      }
    } else if (change === "layer") {
      p.layer = "F.Cu";
      for (const route of revised.routingConstraints.nets) if ("referencePath" in route) Object.assign(route, { referencePath: { mode: "none" } });
    } else if (change === "clearance") p.clearanceMm = 0.3;
    else if (change === "minimum-copper") p.minimumCopperWidthMm = 0.4;
    else if (change === "thermal") p.padConnection.gapMm = 0.3;
    else p.islandPolicy.minimumAreaMm2 = 0.1;
    const targetBundle = f.compile(revised);
    await expect(qualifyClosedPlaneSchematicSeed({ ...q.input, targetBundle })).rejects.toThrow(/only PCB/);
  });

  it("rejects reassignment to another unchanged ground net even with valid adjusted routing", async () => {
    const f = await fixture(), original = planeDividerDraft(), otherGround = original.nets.find(net => net.name === "VOUT")!;
    otherGround.role = "ground"; otherGround.electrical.voltage = { minimumV: 0, nominalV: 0, maximumV: 0 };
    original.netClasses.find(netClass => netClass.id === "SENSE")!.allowedLayers = ["F.Cu", "B.Cu"];
    const q = await qualified(f, original), revised = structuredClone(q.draft);
    revised.planes[0]!.net = "VOUT";
    Object.assign(revised.routingConstraints.nets.find(route => route.net === "GND")!, { net: "VOUT" });
    Object.assign(revised.routingConstraints.nets.find(route => route.topology === "tree")!, { net: "GND", topology: "point_to_point" });
    for (const route of revised.routingConstraints.nets) if ("referencePath" in route) Object.assign(route, { referencePath: { mode: "none" } });
    const targetBundle = f.compile(revised);
    await expect(qualifyClosedPlaneSchematicSeed({ ...q.input, targetBundle })).rejects.toThrow(/only PCB/);
  });

  it("keeps plane inventory and rectangle kind closed before seed qualification", async () => {
    const f = await fixture(), draft = changedDraft();
    expect(() => f.compile({ ...draft, planes: [] })).toThrow();
    expect(() => f.compile({ ...draft, planes: [draft.planes[0]!, { ...draft.planes[0]!, id: "EXTRA" }] })).toThrow();
    const changed = structuredClone(draft); Object.assign(changed.planes[0]!.boundary, { kind: "polygon" });
    expect(() => f.compile(changed)).toThrow();
  });

  it.each(["value", "role", "voltage", "current", "board", "plane"])("rejects adjacent %s changes while permitting original prompt metadata", async change => {
    const f = await fixture(), q = await qualified(f), draft = changedDraft();
    if (change === "value") draft.components[0]!.value = "changed";
    else if (change === "role") draft.nets[0]!.role = "power";
    else if (change === "voltage") draft.nets[0]!.electrical.voltage = { minimumV: 3.2, nominalV: 3.2, maximumV: 3.2 };
    else if (change === "current") draft.nets[0]!.electrical.current.peakA = 0.002;
    else if (change === "board") draft.scope.board.widthMm += 1;
    else draft.planes[0]!.islandPolicy.minimumAreaMm2 = 0.1;
    await expect(qualifyClosedPlaneSchematicSeed({ ...q.input, targetBundle: f.compile(draft) })).rejects.toThrow(/only PCB/);
    await expect(qualifyClosedPlaneSchematicSeed({ ...q.input, targetBundle: f.compile(q.draft, "Updated placement rationale") })).resolves.toHaveProperty("seed");
  });

  it.each(["schematic", "report", "profile", "library", "hardlink"])("rejects stale or shared %s bytes independently after successful close", async change => {
    const f = await fixture(), source = await f.closedSource();
    const file = change === "schematic" || change === "hardlink" ? source.preparation.project.schematicPath : change === "report" ? source.preparation.reportPath
      : change === "profile" ? f.profile.path : path.join(f.symbolRoot, "Device.kicad_sym");
    if (change === "hardlink") await link(file, path.join(f.root, "shared.kicad_sch"));
    else await writeFile(file, Buffer.concat([await readFile(file), Buffer.from(" ")]));
    await expect(assertClosedPlaneSchematicSeedSourceCurrent(source.receipt)).rejects.toThrow();
  });

  it("does not turn ordinary connected or materialized closes into seed eligibility", async () => {
    const f = await fixture(), source = await f.closedSource(), context = { project: source.preparation.project, bundle: source.preparation.bundle,
      dependencies: f.dependencies, profile: f.profile, symbolRoot: f.symbolRoot };
    await writeFile(context.project.schematicPath, source.bytes.replace("(embedded_fonts no)", "(embedded_fonts no) (wire)"));
    expect(await captureClosedPlaneSchematicSeedSource(context)).toBeUndefined();
    await writeFile(context.project.schematicPath, source.bytes);
    await writeFile(context.project.pcbPath, (await readFile(context.project.pcbPath, "utf8")) + "\n");
    expect(await captureClosedPlaneSchematicSeedSource(context)).toBeUndefined();
  });

  it("accepts only the exact needed embedded definition, including all graphic and pin source content", async () => {
    const f = await fixture(), bundle = f.compile(), source = f.source(bundle);
    expect(validateUnwiredPlaneSchematicSeed(source, "seeded", bundle, f.librarySources)).toEqual(["R1"]);
    expect(validateUnwiredPlaneSchematicSeed(f.source(bundle, ["J1", "R1", "R2"]), "seeded", bundle, f.librarySources)).toEqual(["J1", "R1", "R2"]);
    for (const bad of [source.replace("(length 2.54)", "(length 2.55)"), source.replace('(name "1"', '(name "A"'),
      source.replace('(symbol "R_1_1"', '(symbol "R_1_1" (rectangle (start 0 0) (end 1 1))'), source.replace('(lib_symbols', '(lib_symbols (symbol "Unused")'),
      source.replace('(property "Value" "10k"', '(property "Value" "20k"')]) {
      if (bad === source) continue;
      expect(() => validateUnwiredPlaneSchematicSeed(bad, "seeded", bundle, f.librarySources)).toThrow();
    }
  });

  it.each(["wire", "junction", "label", "global_label", "hierarchical_label", "no_connect", "bus", "sheet", "rule_area", "unknown"])("rejects retained electrical root form %s", async form => {
    const f = await fixture(), bundle = f.compile(), source = f.source(bundle).replace("(embedded_fonts no)", `(embedded_fonts no) (${form})`);
    expect(() => validateUnwiredPlaneSchematicSeed(source, "seeded", bundle, f.librarySources)).toThrow();
  });

  it("rejects malformed instance, presentation and root metadata even when terminal parsing could ignore it", async () => {
    const f = await fixture(), bundle = f.compile(), source = f.source(bundle);
    const bad = [source.replace("(kicad_sch", "(kicad_sch stray"), source.replace('(paper "A4")', '(paper "A4" (wire))'),
      source.replace('(project "seeded"', '(project seeded'), source.replace('(page "1")', '(page 1)'),
      source.replace('(reference "R1")', '(reference R1)'), source.replace("(embedded_fonts no)", '(embedded_fonts "no")'),
      source.replace("(unit 1)", '(unit "1")'), source.replace("(at 20 20 0)", "(at 20 20 0) (fields_autoplaced (wire))"),
      source.replace("(font (size 1.27 1.27))", "(font (size 1.27 1.27) (size 1 1))"), source.replace("(in_bom yes)", "(in_bom no)"),
      source.replace('(property "Reference" "R1"', '(property "Reference" "R9"')];
    for (const candidate of bad) expect(() => validateUnwiredPlaneSchematicSeed(candidate, "seeded", bundle, f.librarySources)).toThrow();
  });
});
