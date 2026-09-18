import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preparePlaneFreshProject, checkpointPlaneFreshProjectOpenNormalization } from "../../src/harness/fresh-project.js";
import { createPcbPlaneCompilationBundleRef } from "../../src/harness/pcb-design-plane-bundle.js";
import { derivePcbNativeNumericRules } from "../../src/harness/pcb-native-numeric-rules.js";
import { resumeKicadToolboxPlaneProject } from "../../src/mcp/toolbox-plane-preparation.js";
import { unwiredPlaneSeedFixture } from "../helpers/unwired-plane-seed.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";

const fixtures: Awaited<ReturnType<typeof unwiredPlaneSeedFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });
const fixture = async () => { const f = await unwiredPlaneSeedFixture(); fixtures.push(f); return f; };
const numericDraft = () => { const draft = planeDividerDraft(); return { ...draft, nativeRuleMode: "contract-derived-v1" as const,
  netClasses: draft.netClasses.map(c => ({ ...c, traceWidthMm: c.id === "SENSE" ? 0.15 : 0.3, copperToEdgeMm: c.id === "SENSE" ? 0.25 : 0.5 })),
  routingConstraints: { ...draft.routingConstraints, minimumHoleToHoleMm: 0.5,
    viaPolicy: { mode: "bounded", maxTotal: 2, diameterMm: 0.6, drillMm: 0.25, minimumAnnularRingMm: 0.15 } } }; };

describe("opt-in project numeric production and initial Open authority", () => {
  it("preserves exact legacy project bytes and creates exact opted-in floors before the marker", async () => {
    const f = await fixture();
    for (const opted of [false, true]) {
      const bundle = f.compile(opted ? numericDraft() : planeDividerDraft()), name = "seeded";
      const project = await preparePlaneFreshProject({ outputDir: path.join(f.root, opted ? "numeric" : "legacy"), name, resume: false,
        compilationBundle: bundle, compilationBundleRef: createPcbPlaneCompilationBundleRef(bundle) });
      const text = await readFile(path.join(project.projectPath, `${name}.kicad_pro`), "utf8");
      const base = { meta: { filename: name, version: 1, fixtureId: "evleda-fresh-kicad10", generatedBy: "evleda pcb-agent fresh project" },
        schematic: { file: `${name}.kicad_sch` }, board: { file: `${name}.kicad_pcb` } };
      if (!opted) expect(text).toBe(JSON.stringify(base, null, 2) + "\n");
      else expect(JSON.parse(text)).toEqual({ ...base, board: { ...base.board, design_settings: {
        rules: { min_track_width: 0.15, min_copper_edge_clearance: 0.25, min_through_hole_diameter: 0.25,
          min_via_annular_width: 0.1, min_via_diameter: 0.5, min_clearance: 0, min_hole_clearance: 0.25, min_hole_to_hole: 0.5 },
        rule_severities: { track_width: "error", track_angle: "error" } } } });
      await project.assertSchematicEmpty();
    }
  });

  it("retains the private numeric projection across resume and permits exact sparse serialization only", async () => {
    const f = await fixture(), prepared = await f.prepare(path.join(f.root, "numeric"), numericDraft());
    const resumed = await resumeKicadToolboxPlaneProject({ outputDir: prepared.project.outputPath, name: "seeded", dependencies: f.dependencies,
      expectedKicadCli: f.expectedKicadCli, createKicadCliAdapter: f.createKicadCliAdapter });
    const proPath = path.join(prepared.project.projectPath, "seeded.kicad_pro"), source = JSON.parse(await readFile(proPath, "utf8"));
    expect(source.board.design_settings.rules).toEqual(derivePcbNativeNumericRules(prepared.bundle.contract)!.boardRules);
    await writeFile(proPath, JSON.stringify(source));
    const args = { project: resumed.project, expectedPreparedSourceAuthority: prepared.preparedSourceAuthority,
      expectedNetClassProjection: { netClasses: prepared.netClassSemanticAuthority.netClasses, contractNetAssignments: prepared.netClassSemanticAuthority.contractNetAssignments } };
    expect(await checkpointPlaneFreshProjectOpenNormalization(args)).toMatchObject({ changed: true });
    expect(await checkpointPlaneFreshProjectOpenNormalization(args)).toMatchObject({ changed: false });
    for (const field of ["min_track_width", "min_through_hole_diameter", "min_hole_clearance", "min_hole_to_hole"]) {
      const altered = structuredClone(source); altered.board.design_settings.rules[field] += 0.01;
      await writeFile(proPath, JSON.stringify(altered)); await expect(checkpointPlaneFreshProjectOpenNormalization(args)).rejects.toThrow(/non-net-settings drift/);
    }
    for (const field of ["track_width", "track_angle"]) {
      const altered = structuredClone(source); altered.board.design_settings.rule_severities[field] = "ignore";
      await writeFile(proPath, JSON.stringify(altered)); await expect(checkpointPlaneFreshProjectOpenNormalization(args)).rejects.toThrow(/non-net-settings drift/);
    }
    await writeFile(proPath, JSON.stringify(source));
    const bundle = f.compile(planeDividerDraft());
    await expect(preparePlaneFreshProject({ outputDir: prepared.project.outputPath, name: "seeded", resume: true, compilationBundle: bundle,
      compilationBundleRef: createPcbPlaneCompilationBundleRef(bundle) })).rejects.toThrow();
  });

  it("replays genuine native-expanded settings with only the exact opted-in floor/severity overlay", async () => {
    const f = await fixture(), prepared = await f.prepare(path.join(f.root, "expanded"), numericDraft());
    const proPath = path.join(prepared.project.projectPath, "seeded.kicad_pro"), source = JSON.parse(await readFile(proPath, "utf8"));
    const native = JSON.parse((await readFile(new URL("../fixtures/fresh-project/native-expanded-non-net-settings.json", import.meta.url), "utf8"))
      .replaceAll("__EVLEDA_FRESH_NAME__", "seeded"));
    const projection = derivePcbNativeNumericRules(prepared.bundle.contract)!;
    Object.assign(native.board.design_settings.rules, projection.boardRules);
    Object.assign(native.board.design_settings.rule_severities, projection.requiredNativeCheckSeverities);
    native.net_settings = source.net_settings;
    const args = { project: prepared.project, expectedPreparedSourceAuthority: prepared.preparedSourceAuthority,
      expectedNetClassProjection: { netClasses: prepared.netClassSemanticAuthority.netClasses, contractNetAssignments: prepared.netClassSemanticAuthority.contractNetAssignments } };
    await writeFile(proPath, JSON.stringify(native));
    expect(await checkpointPlaneFreshProjectOpenNormalization(args)).toMatchObject({ changed: true });
    native.board.design_settings.rules.min_track_width = 0.2;
    await writeFile(proPath, JSON.stringify(native));
    await expect(checkpointPlaneFreshProjectOpenNormalization(args)).rejects.toThrow(/non-net-settings drift/);
    native.board.design_settings.rules.min_track_width = 0.15;
    native.board.design_settings.rule_severities.hole_to_hole = "ignore";
    await writeFile(proPath, JSON.stringify(native));
    await expect(checkpointPlaneFreshProjectOpenNormalization(args)).rejects.toThrow(/non-net-settings drift/);
  });
});
