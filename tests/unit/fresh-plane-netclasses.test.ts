import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import type { KicadExecutableIdentity } from "../../src/integrations/kicad-cli.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle, createPcbPlaneCompilationBundleRef } from "../../src/harness/pcb-design-plane-bundle.js";
import { preparePlaneFreshProject } from "../../src/harness/fresh-project.js";
import { createFreshPlaneRules } from "../../src/harness/fresh-plane-rules.js";
import { FRESH_NETCLASS_ASSIGNMENT_MODEL } from "../../src/harness/fresh-netclass-assignment.js";
import { materializeFreshNetClasses, parseFreshNetClassSemanticAuthority, parseFreshNetClassPreparationEvidence, readFreshClearanceEvidence } from "../../src/harness/fresh-clearance-evidence.js";
import { materializeFreshPlaneNetClasses, readFreshPlaneNetClassSemanticAuthority, verifyFreshPlaneNetClassSemanticAuthority,
  parseFreshPlaneNetClassMaterialization, parseFreshPlaneNetClassSemanticAuthority, createFreshPlaneNetClassPreparationEvidence,
  parseFreshPlaneNetClassPreparationEvidence } from "../../src/harness/fresh-plane-netclasses.js";
import { genericDividerLibraryResolver } from "../helpers/generic-divider-bundle.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const dependencies = { libraryResolver: genericDividerLibraryResolver, deepRuleCatalog: loadDeepRuleCatalog() };
const kicad: KicadExecutableIdentity = { kind: "kicad-cli", path: "C:/fixture/kicad-cli.exe", version: "10.0.3", commit: "146a4f2a7585c65bc580427a19b6fe2ec4a3f622",
  sha256: "a".repeat(64), sizeBytes: 1, capabilityHelpSha256: "b".repeat(64), confirmedCapabilities: ["pcb drc"] };
function bundle(prompt = "Synthetic V2 plane net-class preparation.", solid = false) {
  const draft: Record<string, any> = structuredClone(planeDividerDraft());
  if (solid) draft.planes[0].padConnection = { mode: "solid" };
  const compilation = compilePcbPlaneDesignIntentDraft(draft, dependencies);
  if (compilation.disposition !== "ready") throw new Error(JSON.stringify(compilation.issues));
  return createPcbPlaneCompilationBundle({ originalPrompt: prompt, compilation }, dependencies);
}
async function fixture(solid = false) {
  const root = await mkdtemp(path.join(tmpdir(), "evleda-plane-classes-")); roots.push(root);
  const compilationBundle = bundle(undefined, solid);
  const project = await preparePlaneFreshProject({ outputDir: root, name: "plane-test", resume: false, compilationBundle,
    compilationBundleRef: createPcbPlaneCompilationBundleRef(compilationBundle) });
  const proPath = path.join(project.projectPath, `${project.name}.kicad_pro`);
  const druPath = path.join(project.projectPath, `${project.name}.kicad_dru`);
  return { project, compilationBundle, options: { project, compilationBundle, kicad }, proPath, druPath };
}
const rehash = <T extends { schemaVersion: string; identity: unknown }>(value: T): T => {
  const { identity: _identity, ...payload } = value;
  return { ...payload, identity: canonicalIdentity(payload, value.schemaVersion) } as T;
};
async function editProject(file: string, edit: (value: any) => void) {
  const value = JSON.parse(await readFile(file, "utf8")); edit(value); await writeFile(file, JSON.stringify(value));
}

describe("actual V2 plane net-class preparation", () => {
  it.each([false, true])("materializes authentic V2 classes and verifies original %s-solid rule bytes without a V1 clearance claim", async solid => {
    const f = await fixture(solid);
    const before = await Promise.all([readFile(f.project.pcbPath), readFile(f.project.markerPath), readFile(f.druPath)]);
    const materialization = await materializeFreshPlaneNetClasses(f.options);
    const authority = await readFreshPlaneNetClassSemanticAuthority(f.options);
    const rules = createFreshPlaneRules(f.compilationBundle);
    expect(materialization).toMatchObject({ family: "plane-v2", classification: "candidate-configuration", acceptanceEvaluated: false, changed: true,
      bundleIdentity: f.compilationBundle.identity, contractIdentity: f.compilationBundle.contract.identity, planeProjectBindingIdentity: f.project.planeBinding.identity,
      customRulesIdentity: rules.identity, assignmentModel: FRESH_NETCLASS_ASSIGNMENT_MODEL, evaluation: { zones: "not-evaluated", planeClearance: "not-evaluated" } });
    expect(materialization).not.toHaveProperty("genericProjectBindingIdentity");
    expect(authority).toMatchObject({ ruleResolution: { zones: "not-evaluated", planeClearance: "not-evaluated", customRules: "exact-bundle-owned-plane-rules",
      localPadOrFootprintOverrides: "clearance-only-rejected", localThermalOverrides: "not-evaluated", contractNetAssignments: "exclusive" } });
    expect(authority).not.toHaveProperty("acceptanceEvidence");
    expect(authority.kicad).not.toHaveProperty("path");
    const pro = JSON.parse(await readFile(f.proPath, "utf8"));
    expect(pro.net_settings.meta).toEqual({ version: 5 });
    expect(pro.net_settings.netclass_assignments).toEqual({});
    expect(pro.net_settings.netclass_patterns.map((entry: any) => entry.pattern).sort()).toEqual(["^GND$", "^VIN$", "^VOUT$"]);
    for (const definition of authority.netClasses) expect(definition.name).toMatch(new RegExp(`^EVLEDA_${f.compilationBundle.identity.digest.slice(0, 12)}_C0[12]$`));
    expect(pro.net_settings.classes.filter((entry: any) => entry.name.startsWith("EVLEDA_"))).toEqual(authority.netClasses);
    const after = await Promise.all([readFile(f.project.pcbPath), readFile(f.project.markerPath), readFile(f.druPath)]);
    expect(after).toEqual(before);
    expect(after[2]!.toString()).toBe(rules.source);
    if (solid) expect(rules.source).toBe("(version 1)\n");
    else expect(rules.source).toContain("(constraint min_resolved_spokes 2)");
    expect(parseFreshPlaneNetClassMaterialization(structuredClone(materialization))).toEqual(materialization);
    expect(parseFreshPlaneNetClassSemanticAuthority(structuredClone(authority))).toEqual(authority);
    const evidence = createFreshPlaneNetClassPreparationEvidence(materialization, authority);
    expect(parseFreshPlaneNetClassPreparationEvidence(structuredClone(evidence))).toEqual(evidence);
    expect(evidence).toMatchObject({ materializationIdentity: materialization.identity, semanticAuthorityIdentity: authority.identity, customRulesIdentity: rules.identity });
  });

  it("replays unchanged semantics through native-style formatting/null cache and never weakens V1 entry points", async () => {
    const f = await fixture(); const materialization = await materializeFreshPlaneNetClasses(f.options);
    const authority = await readFreshPlaneNetClassSemanticAuthority(f.options);
    expect((await materializeFreshPlaneNetClasses(f.options)).changed).toBe(false);
    await editProject(f.proPath, pro => { pro.net_settings.netclass_assignments = null; });
    expect(await verifyFreshPlaneNetClassSemanticAuthority(authority, f.options)).toEqual(authority);
    const evidence = createFreshPlaneNetClassPreparationEvidence(materialization, authority);
    expect(() => parseFreshNetClassSemanticAuthority(authority)).toThrow();
    expect(() => parseFreshNetClassPreparationEvidence(evidence)).toThrow();
    await expect(materializeFreshNetClasses(f.options as never)).rejects.toMatchObject({ code: "UNVERIFIED_PROJECT" });
    await expect(readFreshClearanceEvidence(f.options as never)).rejects.toMatchObject({ code: "UNVERIFIED_PROJECT" });
  });

  it("keeps semantic authority configuration-only after zones exist; it does not certify their local rules or geometry", async () => {
    const f = await fixture(); await materializeFreshPlaneNetClasses(f.options);
    const original = await readFreshPlaneNetClassSemanticAuthority(f.options);
    const pcb = await readFile(f.project.pcbPath, "utf8");
    await writeFile(f.project.pcbPath, pcb.replace(/\)\s*$/u, '(zone (net "GND") (layer "B.Cu") (connect_pads (clearance 0.7)) (fill yes) (polygon (pts (xy 1 1) (xy 20 1) (xy 20 15))))\n)\n'));
    const current = await readFreshPlaneNetClassSemanticAuthority(f.options);
    expect(current).toEqual(original);
    expect(current.ruleResolution).toMatchObject({ zones: "not-evaluated", planeClearance: "not-evaluated" });
    expect(current.acceptanceEvaluated).toBe(false);
  });

  it.each(["missing", "different", "additional"])("rejects %s original owned rule source without repairing or overwriting it", async mode => {
    const f = await fixture(); const proBefore = await readFile(f.proPath);
    if (mode === "missing") await unlink(f.druPath);
    else await writeFile(f.druPath, mode === "different" ? "(version 1)\n" : createFreshPlaneRules(f.compilationBundle).source + '(rule "foreign" (constraint clearance (min 0.1mm)))\n');
    const changed = mode === "missing" ? null : await readFile(f.druPath);
    await expect(materializeFreshPlaneNetClasses(f.options)).rejects.toThrow();
    expect(await readFile(f.proPath)).toEqual(proBefore);
    if (changed !== null) expect(await readFile(f.druPath)).toEqual(changed);
  });

  it.each(["class", "patterns", "derived", "meta"])("rejects %s semantic drift without silently rematerializing it", async kind => {
    const f = await fixture(); await materializeFreshPlaneNetClasses(f.options);
    await editProject(f.proPath, pro => {
      if (kind === "class") pro.net_settings.classes.find((entry: any) => entry.name.startsWith("EVLEDA_")).track_width += 0.1;
      if (kind === "patterns") pro.net_settings.netclass_patterns[0].pattern = "*";
      if (kind === "derived") pro.net_settings.netclass_assignments = { GND: "Default" };
      if (kind === "meta") pro.net_settings.meta.version = 4;
    });
    const changed = await readFile(f.proPath);
    await expect(readFreshPlaneNetClassSemanticAuthority(f.options)).rejects.toThrow();
    await expect(materializeFreshPlaneNetClasses(f.options)).rejects.toThrow();
    expect(await readFile(f.proPath)).toEqual(changed);
  });

  it("rejects cloned bundles/projects and another authenticated bundle before publication", async () => {
    const f = await fixture();
    await expect(materializeFreshPlaneNetClasses({ ...f.options, compilationBundle: structuredClone(f.compilationBundle) })).rejects.toMatchObject({ code: "UNVERIFIED_BUNDLE" });
    await expect(materializeFreshPlaneNetClasses({ ...f.options, project: { ...f.project } })).rejects.toMatchObject({ code: "UNVERIFIED_PROJECT" });
    await expect(materializeFreshPlaneNetClasses({ ...f.options, compilationBundle: bundle("Different actual V2 bundle.") })).rejects.toMatchObject({ code: "UNVERIFIED_BUNDLE" });
  });

  it("rejects rehashed authority escalation, V1 domains, class conflicts and crossed preparation children", async () => {
    const f = await fixture(); const materialization = await materializeFreshPlaneNetClasses(f.options);
    const authority = await readFreshPlaneNetClassSemanticAuthority(f.options);
    for (const change of [
      (value: any) => { value.ruleResolution.zones = "rejected"; },
      (value: any) => { value.evaluation.planeClearance = "pass"; },
      (value: any) => { value.acceptanceEvaluated = true; },
      (value: any) => { value.contractIdentity.schemaVersion = "evleda.pcb-design-contract.v1"; },
      (value: any) => { value.contractNetAssignments[1] = { ...value.contractNetAssignments[0] }; },
      (value: any) => { value.netClasses[0].diff_pair_gap = 0.3; },
    ]) {
      const value = structuredClone(authority); change(value);
      expect(() => parseFreshPlaneNetClassSemanticAuthority(rehash(value))).toThrow();
    }
    const changed = structuredClone(materialization) as unknown as Record<string, any>;
    changed.customRulesIdentity = contentIdentity("(version 1)\n");
    changed.identity = canonicalIdentity(Object.fromEntries(Object.entries(changed).filter(([key]) => key !== "identity")), changed.schemaVersion);
    expect(() => createFreshPlaneNetClassPreparationEvidence(changed as never, authority)).toThrow("customRulesIdentity");
  });

  it("restores exact project preimage on a post-commit failure and leaves the owned rule source unchanged", async () => {
    const f = await fixture(); const before = await readFile(f.proPath), rules = await readFile(f.druPath);
    vi.stubEnv("EVLEDA_TEST_ONLY_FRESH_CLEARANCE_POST_COMMIT_FAULT", "throw");
    await expect(materializeFreshPlaneNetClasses(f.options)).rejects.toMatchObject({ code: "SOURCE_DRIFT" });
    expect(await readFile(f.proPath)).toEqual(before); expect(await readFile(f.druPath)).toEqual(rules);
  });
});
