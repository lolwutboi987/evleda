import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { createPcbDesignCompilationBundle, createPcbDesignCompilationBundleRef, parsePcbDesignCompilationBundle } from "../../src/harness/pcb-design-compilation-bundle.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { PCB_DESIGN_INTENT_DRAFT_SCHEMA_VERSION } from "../../src/harness/pcb-design-contract.js";
import { compilePcbDesignIntentDraft, type PcbReadOnlyLibraryResolver } from "../../src/harness/pcb-design-compiler.js";
import type { KicadCliAdapter, KicadExecutableIdentity } from "../../src/integrations/kicad-cli.js";
import { prepareKicadToolboxFreshProject, resumeKicadToolboxFreshProject, assertKicadToolboxFreshPreparation } from "../../src/mcp/toolbox-fresh-preparation.js";

const owned: string[] = [];
afterEach(async () => {
  for (const directory of owned.splice(0)) {
    if (!directory.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) throw new Error("Unsafe test cleanup");
    await rm(directory, { recursive: true, force: true });
  }
});
const resolver: PcbReadOnlyLibraryResolver = {
  resolveSymbol: libraryId => libraryId === "Connector_Generic:Conn_01x02" ? {
    libraryId, source: "kicad-stock", unitCount: 1, componentKind: "connector", polarized: false,
    pins: [{ number: "1", function: "Pin 1" }, { number: "2", function: "Pin 2" }],
  } : null,
  resolveFootprint: libraryId => libraryId === "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical" ? {
    libraryId, source: "kicad-stock", packageKind: "generic", pads: ["1", "2"],
  } : null,
};
const dependencies = { libraryResolver: resolver, deepRuleCatalog: loadDeepRuleCatalog() };
const draft = () => ({
  schemaVersion: PCB_DESIGN_INTENT_DRAFT_SCHEMA_VERSION, kind: "pcb_design_intent_draft",
  scope: { sheetCount: 1, componentUnitPolicy: "single_unit",
    board: { shape: "rectangle", widthMm: 30, heightMm: 20, layerCount: 2, copperLayers: ["F.Cu", "B.Cu"] } },
  components: ["J1", "J2"].map(reference => ({ reference, symbolLibId: "Connector_Generic:Conn_01x02",
    value: reference === "J1" ? "POWER_IN" : "POWER_OUT", unit: 1,
    footprintLibId: "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical",
    pins: [{ pin: "1", assignment: { kind: "net", net: "VIN" } }, { pin: "2", assignment: { kind: "net", net: "GND" } }] })),
  nets: ["VIN", "GND"].map((name, index) => ({ name, role: index === 0 ? "power_input" : "ground",
    endpoints: ["J1", "J2"].map(reference => ({ reference, pin: String(index + 1) })), netClassId: "POWER",
    electrical: { voltage: { minimumV: index === 0 ? 5 : 0, nominalV: index === 0 ? 5 : 0, maximumV: index === 0 ? 5 : 0 },
      current: { nominalA: 0.1, maximumContinuousA: 0.1, peakA: 0.1, peakDurationMs: 1000 },
      speed: { kind: "dc", maximumFrequencyMHz: 0, minimumEdgeTimeNs: null } } })),
  netClasses: [{ id: "POWER", traceWidthMm: 0.5, clearanceMm: 0.25, copperToEdgeMm: 0.3, allowedLayers: ["F.Cu"] }],
  placementConstraints: ["J1", "J2"].map((reference, index) => ({ reference, side: "front",
    regionMm: { minXmm: 1, maxXmm: 29, minYmm: 1, maxYmm: 19 }, allowedRotationsDeg: [index === 0 ? 0 : 180],
    minimumEdgeClearanceMm: 1, minimumCourtyardClearanceMm: 0.25, edgePreference: index === 0 ? "left" : "right" })),
  routingConstraints: { cornerStyle: "miter_45", maximumTurnAngleDeg: 45, minimumStraightBeforeTurnMm: 0.25,
    allowRightAngleCorners: false, allowAcuteInteriorCorners: false, allowBacktracking: false, allowSelfIntersections: false,
    viaPolicy: { mode: "forbidden", maxTotal: 0 }, nets: ["VIN", "GND"].map(net => ({ net, topology: "point_to_point",
      preferredLayer: "F.Cu", maxVias: 0, routeLength: { mode: "unbounded" } })) }, unresolved: [],
});
const identity: KicadExecutableIdentity = { kind: "kicad-cli", path: path.resolve("test-only-kicad.exe"),
  version: "10.0.3", commit: "146a4f2a7585c65bc580427a19b6fe2ec4a3f622", sha256: "a".repeat(64), sizeBytes: 100,
  capabilityHelpSha256: "b".repeat(64), confirmedCapabilities: ["pcb drc"] };
const expectedKicadCli = { path: identity.path, contentIdentity: { algorithm: "sha256" as const, digest: identity.sha256, size: identity.sizeBytes },
  operationalVersion: identity.version, operationalCommit: identity.commit, peFileVersion: "10.0.3", peProductVersion: "10.0.3",
  identity: canonicalIdentity({ fixture: true }, "evleda.flux-kicad-cli-binding.v1") };
async function input() {
  const root = await mkdtemp(path.join(os.tmpdir(), "evleda-toolbox-preparation-")); owned.push(root);
  // Only the executable factory is mocked: compilation, project creation, source
  // materialization, semantic verification, report and checkpoint remain real.
  const createKicadCliAdapter = vi.fn<typeof KicadCliAdapter.create>().mockResolvedValue({ identity } as KicadCliAdapter);
  return { draft: draft(), originalPrompt: "Create a 5 V two-connector passthrough", outputDir: path.join(root, "output"),
    name: "passthrough", dependencies, expectedKicadCli, createKicadCliAdapter };
}

describe("provider-free toolbox fresh preparation", () => {
  it("accepts an exact host preview bundle identity", async () => {
    const args = await input(); const compilation = compilePcbDesignIntentDraft(args.draft, args.dependencies);
    const preview = createPcbDesignCompilationBundle({ originalPrompt: args.originalPrompt, compilation }, args.dependencies);
    const outcome = await prepareKicadToolboxFreshProject({ ...args, expectedBundleIdentity: preview.identity });
    expect(outcome.status).toBe("prepared");
    if (outcome.status === "prepared") expect(outcome.preparation.bundle.identity).toEqual(preview.identity);
  });
  it("rejects changed compilation before creating project files or constructing an adapter", async () => {
    const args = await input(); const compilation = compilePcbDesignIntentDraft(args.draft, args.dependencies);
    const preview = createPcbDesignCompilationBundle({ originalPrompt: args.originalPrompt, compilation }, args.dependencies);
    await expect(prepareKicadToolboxFreshProject({ ...args, originalPrompt: `${args.originalPrompt}, changed after preview`,
      expectedBundleIdentity: preview.identity })).rejects.toThrow("compilation changed since preview");
    expect(args.createKicadCliAdapter).not.toHaveBeenCalled();
    await expect(stat(args.outputDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects a preview identity on the direct resume API", async () => {
    const args = await input();
    const resume = { ...args, expectedBundleIdentity: canonicalIdentity({ fixture: true }, "evleda.pcb-design-compilation-bundle.v1") };
    await expect(resumeKicadToolboxFreshProject(resume)).rejects.toThrow("resume cannot accept a previewed compilation identity");
    expect(args.createKicadCliAdapter).not.toHaveBeenCalled();
  });
  it("prepares real native sources, records needs-review evidence and authenticates only the original capability", async () => {
    const args = await input();
    const result = await prepareKicadToolboxFreshProject(args);
    expect(result.status).toBe("prepared");
    if (result.status !== "prepared") throw new Error(JSON.stringify(result.compilation));
    const prepared = result.preparation;
    expect(() => assertKicadToolboxFreshPreparation(prepared)).not.toThrow();
    expect(() => assertKicadToolboxFreshPreparation({ ...prepared })).toThrow(/original host/);
    const report = JSON.parse(await readFile(prepared.reportPath, "utf8"));
    expect(report.status).toBe("needs_review");
    expect(report.workflow.bundlePath).toBe(prepared.bundlePath);
    const bundleBytes = await readFile(prepared.bundlePath);
    expect(contentIdentity(bundleBytes)).toEqual(prepared.bundleRef.contentIdentity);
    const restoredBundle = parsePcbDesignCompilationBundle(bundleBytes, prepared.dependencies);
    expect(restoredBundle).toEqual(prepared.bundle);
    expect(createPcbDesignCompilationBundleRef(restoredBundle)).toEqual(prepared.bundleRef);
    expect(report).not.toHaveProperty("model"); expect(report).not.toHaveProperty("provider");
    expect(report.preparation.preparedSourceAuthority).toEqual(prepared.preparedSourceAuthority);
    expect(report.preparation.netClassPreparationEvidence).toEqual(prepared.netClassPreparationEvidence);
    const checkpoint = JSON.parse(await readFile(prepared.project.checkpointPath, "utf8"));
    expect(checkpoint.reportStatus).toBe("needs_review");
    const settings = JSON.parse(await readFile(path.join(prepared.project.projectPath, "passthrough.kicad_pro"), "utf8"));
    expect(settings.net_settings.classes).toEqual(expect.arrayContaining([expect.objectContaining({ track_width: 0.5, clearance: 0.25 })]));
    expect(settings.net_settings.netclass_patterns).toEqual(expect.arrayContaining([
      expect.objectContaining({ pattern: "^VIN$" }), expect.objectContaining({ pattern: "^GND$" })]));
    expect(args.createKicadCliAdapter).toHaveBeenCalledWith(expect.objectContaining({
      projectRoot: prepared.project.projectPath, expectedExecutableIdentity: { sha256: identity.sha256, sizeBytes: identity.sizeBytes } }));
  });

  it("returns unresolved input before creating a project or probing an executable", async () => {
    const args = await input();
    const result = await prepareKicadToolboxFreshProject({ ...args, draft: {} });
    expect(result.status).toBe("needs_clarification");
    expect(args.createKicadCliAdapter).not.toHaveBeenCalled();
    await expect(stat(args.outputDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["sha256", "sizeBytes", "version", "commit"] as const)("rejects mismatched native %s before publishing authority or report", async field => {
    const args = await input();
    args.createKicadCliAdapter.mockResolvedValue({ identity: { ...identity, [field]: field === "sizeBytes" ? 101 : "different" } } as KicadCliAdapter);
    await expect(prepareKicadToolboxFreshProject(args)).rejects.toThrow(/exact host-owned toolchain/);
    await expect(stat(path.join(args.outputDir, "pcb-agent-report.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resumes checkpointed changed sources without reminting the original source authority or rewriting artifacts", async () => {
    const args = await input();
    const result = await prepareKicadToolboxFreshProject(args);
    if (result.status !== "prepared") throw new Error("Fixture not ready");
    const original = result.preparation;
    await writeFile(original.project.schematicPath, `${await readFile(original.project.schematicPath, "utf8")}\n`);
    await original.project.checkpointAfterReport(original.reportPath, "needs_review");
    const before = await readFile(original.project.checkpointPath);
    const resumed = await resumeKicadToolboxFreshProject(args);
    expect(resumed.mode).toBe("resumed");
    expect(() => assertKicadToolboxFreshPreparation(resumed)).not.toThrow();
    expect(resumed.preparedSourceAuthority).toEqual(original.preparedSourceAuthority);
    expect(resumed.bundleRef).toEqual(original.bundleRef);
    expect(await readFile(original.project.checkpointPath)).toEqual(before);
  });

  it.each(["source", "report", "bundle", "unsafe", "semantic", "native"] as const)("refuses resume with %s drift", async kind => {
    const args = await input();
    const result = await prepareKicadToolboxFreshProject(args);
    if (result.status !== "prepared") throw new Error("Fixture not ready");
    const original = result.preparation;
    if (kind === "source") await writeFile(original.project.schematicPath, `${await readFile(original.project.schematicPath, "utf8")}\n`);
    if (kind === "report") await writeFile(original.reportPath, `${await readFile(original.reportPath, "utf8")}\n`);
    if (kind === "bundle") await writeFile(original.bundlePath, `${await readFile(original.bundlePath, "utf8")}\n`);
    if (kind === "unsafe") await original.project.recordUnsafeTerminal(original.reportPath, "Test recovery is uncertain");
    if (kind === "native") args.createKicadCliAdapter.mockResolvedValue({ identity: { ...identity, commit: "0".repeat(40) } } as KicadCliAdapter);
    if (kind === "semantic") {
      const settingsPath = path.join(original.project.projectPath, "passthrough.kicad_pro");
      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      settings.net_settings.classes[1].clearance = 0.75;
      await writeFile(settingsPath, JSON.stringify(settings));
      await original.project.checkpointAfterReport(original.reportPath, "needs_review");
    }
    const checkpointBefore = await readFile(original.project.checkpointPath);
    await expect(resumeKicadToolboxFreshProject(args)).rejects.toThrow();
    expect(await readFile(original.project.checkpointPath)).toEqual(checkpointBefore);
  });
});
