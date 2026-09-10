import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle, createPcbPlaneCompilationBundleRef, parsePcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { createFreshPlaneRules } from "../../src/harness/fresh-plane-rules.js";
import { prepareKicadToolboxPlaneProject, resumeKicadToolboxPlaneProject, assertKicadToolboxPlanePreparation,
  type KicadToolboxPlanePreparationInput } from "../../src/mcp/toolbox-plane-preparation.js";
import { prepareKicadToolboxFreshProject } from "../../src/mcp/toolbox-fresh-preparation.js";
import type { KicadCliAdapter, KicadExecutableIdentity } from "../../src/integrations/kicad-cli.js";
import { genericDividerDraft, genericDividerLibraryResolver } from "../helpers/generic-divider-bundle.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const dependencies = { libraryResolver: genericDividerLibraryResolver, deepRuleCatalog: loadDeepRuleCatalog() };
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "toolbox-plane-preparation-")); roots.push(root);
  const identity: KicadExecutableIdentity = { kind: "kicad-cli", path: path.join(root, "kicad-cli.exe"), version: "10.0.3",
    commit: "146a4f2a7585c65bc580427a19b6fe2ec4a3f622", sha256: "a".repeat(64), sizeBytes: 100,
    capabilityHelpSha256: "b".repeat(64), confirmedCapabilities: ["pcb drc"] };
  const expectedKicadCli = { path: identity.path, contentIdentity: { algorithm: "sha256" as const, digest: identity.sha256, size: identity.sizeBytes },
    operationalVersion: identity.version, operationalCommit: identity.commit, peFileVersion: "10.0.3", peProductVersion: "10.0.3",
    identity: canonicalIdentity({ fixture: true }, "evleda.flux-kicad-cli-binding.v1") };
  const createKicadCliAdapter = vi.fn<typeof KicadCliAdapter.create>().mockResolvedValue({ identity } as KicadCliAdapter);
  const input: KicadToolboxPlanePreparationInput = { draft: planeDividerDraft(), originalPrompt: "Create the declared divider with its reference plane",
    outputDir: path.join(root, "output"), name: "plane-divider", dependencies, expectedKicadCli, createKicadCliAdapter };
  const resumeInput = { outputDir: input.outputDir, name: input.name, dependencies, expectedKicadCli, createKicadCliAdapter };
  return { root, input, resumeInput, identity, createKicadCliAdapter };
}
async function prepared(input: KicadToolboxPlanePreparationInput) {
  const result = await prepareKicadToolboxPlaneProject(input);
  if (!("preparation" in result)) throw new Error(`Plane fixture failed preparation: ${JSON.stringify(result)}`);
  return result.preparation;
}

describe("real V2 plane toolbox preparation and resume", () => {
  it("creates genuine V2 bundle/ref, V3 marker/checkpoint, and exact owned DRU with needs-review report", async () => {
    const f = await fixture(); const p = await prepared(f.input);
    assertKicadToolboxPlanePreparation(p);
    expect(p).toMatchObject({ family: "plane-v2", mode: "fresh", project: { workflowKind: "plane" } });
    expect(p.bundle.schemaVersion).toBe("evleda.pcb-design-compilation-bundle.v2");
    expect(p.bundleRef).toEqual(createPcbPlaneCompilationBundleRef(p.bundle));
    expect(parsePcbPlaneCompilationBundle(await readFile(p.bundlePath), dependencies).identity).toEqual(p.bundle.identity);
    const marker = JSON.parse(await readFile(p.project.markerPath, "utf8"));
    expect(marker).toMatchObject({ schemaVersion: "evleda.pcb-agent-fresh-project.v3", workflowKind: "plane" });
    const rulesPath = path.join(p.project.projectPath, "plane-divider.kicad_dru"), rules = createFreshPlaneRules(p.bundle);
    const bytes = await readFile(rulesPath); expect(bytes.toString("utf8")).toBe(rules.source); expect(contentIdentity(bytes)).toEqual(rules.identity);
    expect(Object.values(marker.files)).toEqual(expect.arrayContaining([expect.objectContaining({ path: rulesPath, sha256: rules.identity.digest })]));
    const report = JSON.parse(await readFile(p.reportPath, "utf8"));
    expect(report).toMatchObject({ schemaVersion: "evleda.toolbox-plane-preparation-report.v1", status: "needs_review",
      workflow: { kind: "plane", bundleRef: p.bundleRef }, native: { kicad: f.identity },
      preparation: { netClassSemanticAuthority: p.netClassSemanticAuthority, netClassPreparationEvidence: p.netClassPreparationEvidence } });
    const checkpoint = JSON.parse(await readFile(p.project.checkpointPath, "utf8"));
    expect(checkpoint).toMatchObject({ schemaVersion: "evleda.pcb-agent-fresh-project-checkpoint.v3", reportStatus: "needs_review",
      reportSha256: contentIdentity(await readFile(p.reportPath)).digest });
    expect(Object.values(checkpoint.files)).toEqual(expect.arrayContaining([expect.objectContaining({ path: rulesPath, sha256: rules.identity.digest })]));
    expect(f.createKicadCliAdapter).toHaveBeenCalledOnce();
    expect(f.createKicadCliAdapter).toHaveBeenCalledWith(expect.objectContaining({ executablePath: f.identity.path,
      expectedExecutableIdentity: { sha256: f.identity.sha256, sizeBytes: f.identity.sizeBytes } }));
    expect(p.bundle.acceptanceEvaluated).toBe(false);
  });

  it("returns compiler clarification without allocating output or probing native adapter", async () => {
    const f = await fixture(); const base = planeDividerDraft();
    const result = await prepareKicadToolboxPlaneProject({ ...f.input, draft: { ...base, scope: { ...base.scope, board: { ...base.scope.board, widthMm: null } } } });
    expect(result).toMatchObject({ status: "needs_clarification", projectCreated: false });
    await expect(stat(f.input.outputDir)).rejects.toMatchObject({ code: "ENOENT" }); expect(f.createKicadCliAdapter).not.toHaveBeenCalled();
  });

  it("rejects mismatched preview identity before creation and accepts the exact compiled identity", async () => {
    const f = await fixture();
    const compilation = compilePcbPlaneDesignIntentDraft(f.input.draft, dependencies);
    if (compilation.disposition !== "ready") throw new Error("Fixture must compile");
    const bundle = createPcbPlaneCompilationBundle({ originalPrompt: f.input.originalPrompt, compilation }, dependencies);
    await expect(prepareKicadToolboxPlaneProject({ ...f.input, expectedBundleIdentity: { ...bundle.identity, digest: "0".repeat(64) } })).rejects.toThrow("preview");
    await expect(stat(f.input.outputDir)).rejects.toMatchObject({ code: "ENOENT" }); expect(f.createKicadCliAdapter).not.toHaveBeenCalled();
    expect((await prepared({ ...f.input, expectedBundleIdentity: bundle.identity })).bundle.identity).toEqual(bundle.identity);
  });

  it("resumes an exact checkpoint as a newly authenticated capability without replacement intent", async () => {
    const f = await fixture(); const p = await prepared(f.input);
    // A later saved byte state is checkpointed without replacing the original
    // preparation evidence or claiming that engineering acceptance was run.
    await writeFile(p.project.pcbPath, `${await readFile(p.project.pcbPath, "utf8")}\n`);
    await p.project.checkpointAfterReport(p.reportPath, "needs_review");
    const resumed = await resumeKicadToolboxPlaneProject(f.resumeInput);
    expect(resumed).not.toBe(p); assertKicadToolboxPlanePreparation(resumed);
    expect(resumed.mode).toBe("resumed"); expect(resumed.bundle.identity).toEqual(p.bundle.identity);
    expect(resumed.preparedSourceAuthority).toEqual(p.preparedSourceAuthority);
    await expect(resumeKicadToolboxPlaneProject({ ...f.resumeInput, expectedBundleIdentity: p.bundle.identity } as typeof f.resumeInput)).rejects.toThrow("saved V2 bundle");
  });

  it.each(["pcb", "schematic", "dru", "report", "bundle"])("rejects uncheckpointed %s drift", async kind => {
    const f = await fixture(); const p = await prepared(f.input);
    const target = kind === "pcb" ? p.project.pcbPath : kind === "schematic" ? p.project.schematicPath
      : kind === "dru" ? path.join(p.project.projectPath, "plane-divider.kicad_dru") : kind === "report" ? p.reportPath : p.bundlePath;
    if (kind === "bundle") {
      const bundle = JSON.parse(await readFile(target, "utf8")); bundle.originalPrompt = "altered"; await writeFile(target, JSON.stringify(bundle));
    } else await writeFile(target, `${await readFile(target, "utf8")}\n`);
    await expect(resumeKicadToolboxPlaneProject(f.resumeInput)).rejects.toThrow();
  });

  it("rejects changed full native executable evidence on resume", async () => {
    const f = await fixture(); await prepared(f.input);
    f.createKicadCliAdapter.mockResolvedValue({ identity: { ...f.identity, capabilityHelpSha256: "c".repeat(64) } } as KicadCliAdapter);
    await expect(resumeKicadToolboxPlaneProject(f.resumeInput)).rejects.toThrow("recorded toolchain");
  });

  it("cannot bless altered bundle-owned DRU bytes by creating another checkpoint", async () => {
    const f = await fixture(); const p = await prepared(f.input);
    const rulesPath = path.join(p.project.projectPath, "plane-divider.kicad_dru");
    await writeFile(rulesPath, `${await readFile(rulesPath, "utf8")}\n`);
    await expect(p.project.checkpointAfterReport(p.reportPath, "needs_review")).rejects.toThrow();
    await expect(resumeKicadToolboxPlaneProject(f.resumeInput)).rejects.toThrow();
  });

  it("rejects adapter mismatch at preparation without minting a plane capability", async () => {
    const f = await fixture(); f.createKicadCliAdapter.mockResolvedValue({ identity: { ...f.identity, version: "wrong" } } as KicadCliAdapter);
    await expect(prepareKicadToolboxPlaneProject(f.input)).rejects.toThrow("approved executable/version/commit");
  });

  it("rejects serialized preparation and the real legacy-family preparation", async () => {
    const f = await fixture(); const p = await prepared(f.input);
    expect(() => assertKicadToolboxPlanePreparation(JSON.parse(JSON.stringify(p)))).toThrow("authenticated V2");
    expect(() => assertKicadToolboxPlanePreparation({ ...p })).toThrow("authenticated V2");
    const legacyInput = { ...f.input, outputDir: path.join(f.root, "legacy"), draft: genericDividerDraft() };
    const legacy = await prepareKicadToolboxFreshProject(legacyInput);
    if (legacy.status !== "prepared") throw new Error("Legacy fixture must prepare");
    expect(() => assertKicadToolboxPlanePreparation(legacy.preparation)).toThrow("authenticated V2");
    await expect(resumeKicadToolboxPlaneProject({ ...f.resumeInput, outputDir: legacyInput.outputDir })).rejects.toThrow();
    expect(canonicalJson(legacy.preparation.bundle.identity)).not.toBe(canonicalJson(p.bundle.identity));
  });
});
