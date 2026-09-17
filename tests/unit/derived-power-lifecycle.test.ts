import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalIdentity, canonicalJson } from "../../src/core/canonical.js";
import { createFreshConnectivityContract } from "../../src/harness/fresh-connectivity-contract.js";
import { createPcbPlaneCompilationBundleRef, serializePcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { createPlaneFreshProjectBinding } from "../../src/harness/fresh-project.js";
import type { KicadCliAdapter, KicadExecutableIdentity } from "../../src/integrations/kicad-cli.js";
import type { KicadMcpBoundSessionAuthority } from "../../src/integrations/kicad-mcp-session.js";
import { assertKicadToolboxPlanePreparation, prepareKicadToolboxPlaneProject, resumeKicadToolboxPlaneProject } from "../../src/mcp/toolbox-plane-preparation.js";
import { openKicadToolboxPlaneSession } from "../../src/mcp/toolbox-plane-session.js";
import { cleanupDerivedPowerFixtures, derivedPowerDraft, derivedPowerFixture } from "../helpers/derived-power-bundle.js";
import { externalDiodePowerFixture } from "../helpers/external-diode-power-bundle.js";

const seams = vi.hoisted(() => ({ tools: vi.fn(), initialize: vi.fn(), initialSave: vi.fn(), nativeNetlist: vi.fn(), strokeStyle: vi.fn() }));
vi.mock("../../src/cli/pcb-agent.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/cli/pcb-agent.js")>(),
  initializeIsolatedKicadProject: seams.initialize,
  createFreshNativeCaptures: () => ({ captureNativeNetlist: seams.nativeNetlist, captureNativeSchematicStrokeStyle: seams.strokeStyle }),
}));
vi.mock("../../src/mcp/toolbox-fresh-initial-save.js", () => ({ saveInitialFreshProjectSettings: seams.initialSave }));
vi.mock("../../src/harness/kicad-tools.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/harness/kicad-tools.js")>(), createKicadHarnessTools: seams.tools,
}));
beforeEach(() => vi.resetAllMocks());
afterEach(cleanupDerivedPowerFixtures);

async function preparedFixture(mixed: boolean | "external-diode" = false) {
  const draft = derivedPowerDraft(); if (!mixed) delete draft.externalPowerInputs;
  const f = mixed === "external-diode" ? externalDiodePowerFixture() : derivedPowerFixture(draft);
  const identity: KicadExecutableIdentity = { kind: "kicad-cli", path: path.join(f.root, "synthetic-kicad-cli.exe"), version: "10.0.3",
    commit: "146a4f2a7585c65bc580427a19b6fe2ec4a3f622", sha256: "a".repeat(64), sizeBytes: 100,
    capabilityHelpSha256: "b".repeat(64), confirmedCapabilities: ["pcb drc"] };
  const expectedKicadCli = { path: identity.path, contentIdentity: { algorithm: "sha256" as const, digest: identity.sha256, size: identity.sizeBytes },
    operationalVersion: identity.version, operationalCommit: identity.commit, peFileVersion: "10.0.3", peProductVersion: "10.0.3",
    identity: canonicalIdentity({ synthetic: true }, "evleda.flux-kicad-cli-binding.v1") };
  const createKicadCliAdapter = vi.fn<typeof KicadCliAdapter.create>().mockResolvedValue({ identity } as KicadCliAdapter);
  const input = { draft: f.draft, originalPrompt: "Reviewed derived supply lifecycle fixture", outputDir: path.join(f.root, "output"), name: "derived",
    dependencies: f.dependencies, expectedKicadCli, createKicadCliAdapter };
  const result = await prepareKicadToolboxPlaneProject(input);
  if (result.status !== "prepared") throw new Error(JSON.stringify(result));
  const preparation = result.preparation;
  const resumeInput = { outputDir: input.outputDir, name: input.name, dependencies: input.dependencies, expectedKicadCli, createKicadCliAdapter };
  const changeFlagSource = async () => {
    const file = path.join(f.symbolRoot, "power.kicad_sym"); await writeFile(file, `${await readFile(file, "utf8")}\n`, "utf8");
  };
  const annotationGuard = vi.fn(async () => {});
  seams.tools.mockReturnValue({ tools: [], assertExternalPowerAnnotationsCurrent: annotationGuard, assessPlaneConnectivity: vi.fn() });
  const authorityIdentity = canonicalIdentity({ synthetic: true }, "evleda.synthetic-session-authority.v1");
  const nativeSession = { identity: { launch: { sessionAuthorityIdentity: authorityIdentity } },
    assertActivePcb: vi.fn(async () => {}), close: vi.fn(async () => {}),
    readActivePcbSource: vi.fn(async () => readFile(preparation.project.pcbPath, "utf8")) };
  const authority = { identity: authorityIdentity, connect: vi.fn(async () => nativeSession), disposeUnused: vi.fn() };
  const sessionInput = { preparation, authority: authority as unknown as KicadMcpBoundSessionAuthority, createCliAdapter: createKicadCliAdapter };
  return { ...f, input, preparation, resumeInput, changeFlagSource, createKicadCliAdapter, annotationGuard, nativeSession, authority, sessionInput };
}

describe("derived power bundle lifecycle with synthetic native boundaries", () => {
  it.each([false, true])("preserves %s mixed binding through real project/checkpoint/resume identities", async mixed => {
    const f = await preparedFixture(mixed), p = f.preparation;
    const connectivity = createFreshConnectivityContract(p.bundle.contract, p.bundle.externalPowerBinding, p.bundle.derivedPowerBinding);
    expect(connectivity.derivedPowerBinding).toEqual(p.bundle.derivedPowerBinding);
    expect(connectivity.components.map(component => component.reference)).toEqual(p.bundle.contract.components.map(component => component.reference).sort());
    expect(connectivity.components.every(component => !component.reference.startsWith("#FLG"))).toBe(true);
    const binding = createPlaneFreshProjectBinding(p.bundle, createPcbPlaneCompilationBundleRef(p.bundle));
    expect(binding.symbolTable.match(/\(name "power"\)/gu)).toHaveLength(1);
    const bytes = serializePcbPlaneCompilationBundle(p.bundle);
    expect(await readFile(p.bundlePath)).toEqual(bytes);
    const resumed = await resumeKicadToolboxPlaneProject(f.resumeInput);
    expect(resumed.mode).toBe("resumed"); expect(resumed.bundle.derivedPowerBinding).toEqual(p.bundle.derivedPowerBinding);
    expect(resumed.bundleRef).toEqual(p.bundleRef); expect(await readFile(p.bundlePath)).toEqual(bytes);
  });
  it("rejects a pinned external child omitted from the connectivity projection", async () => {
    const f = await preparedFixture(true);
    expect(() => createFreshConnectivityContract(f.bundle.contract, undefined, f.bundle.derivedPowerBinding)).toThrow();
  });
  it("rejects flag source drift before preparation authentication or resume without writes", async () => {
    const f = await preparedFixture(), p = f.preparation;
    const files = [p.bundlePath, p.reportPath, p.project.checkpointPath, p.project.schematicPath, p.project.pcbPath, p.project.rulesPath];
    const before = await Promise.all(files.map(file => readFile(file)));
    f.createKicadCliAdapter.mockClear(); await f.changeFlagSource();
    expect(() => assertKicadToolboxPlanePreparation(p)).toThrow();
    await expect(resumeKicadToolboxPlaneProject(f.resumeInput)).rejects.toThrow();
    expect(f.createKicadCliAdapter).not.toHaveBeenCalled();
    expect(await Promise.all(files.map(file => readFile(file)))).toEqual(before);
  });
  it.each(["fresh", "resumed"] as const)("requires annotation guards for derived-only %s sessions and checkpoint publication", async mode => {
    const f = await preparedFixture();
    const preparation = mode === "resumed" ? await resumeKicadToolboxPlaneProject(f.resumeInput) : f.preparation;
    const connected = await openKicadToolboxPlaneSession({ ...f.sessionInput, preparation });
    expect(connected.planeAuthoringContext?.derivedPowerBinding).toEqual(preparation.bundle.derivedPowerBinding);
    expect(connected.planeAuthoringContext).not.toHaveProperty("externalPowerBinding");
    expect(f.annotationGuard).toHaveBeenCalledOnce();
    await connected.assertCurrent(); expect(f.annotationGuard).toHaveBeenCalledTimes(2);
    const publish = await connected.prepareCheckpoint!(); expect(f.annotationGuard).toHaveBeenCalledTimes(3);
    await connected.close(); await publish();
    const resumed = await resumeKicadToolboxPlaneProject(f.resumeInput);
    expect(canonicalJson(resumed.bundle.derivedPowerBinding)).toBe(canonicalJson(preparation.bundle.derivedPowerBinding));
    expect(f.nativeSession.close).toHaveBeenCalledOnce();
  });
  it("rejects an annotated session without its complete annotation guard", async () => {
    const f = await preparedFixture(); seams.tools.mockReturnValue({ tools: [], assessPlaneConnectivity: vi.fn() });
    await expect(openKicadToolboxPlaneSession(f.sessionInput)).rejects.toThrow("complete host source/graph guard");
    expect(f.nativeSession.close).toHaveBeenCalledOnce();
  });
  it("rejects derived source drift before native connect", async () => {
    const f = await preparedFixture(); await f.changeFlagSource();
    await expect(openKicadToolboxPlaneSession(f.sessionInput)).rejects.toThrow();
    expect(f.authority.connect).not.toHaveBeenCalled(); expect(f.authority.disposeUnused).toHaveBeenCalledOnce();
  });
  it("rechecks derived sources after native connect before initialization", async () => {
    const f = await preparedFixture(); f.authority.connect.mockImplementation(async () => { await f.changeFlagSource(); return f.nativeSession; });
    await expect(openKicadToolboxPlaneSession(f.sessionInput)).rejects.toThrow();
    expect(seams.initialize).not.toHaveBeenCalled(); expect(f.nativeSession.close).toHaveBeenCalledOnce();
  });
  it("rejects later source drift in reads, current checks, checkpoint preparation and publication", async () => {
    const f = await preparedFixture(), connected = await openKicadToolboxPlaneSession(f.sessionInput);
    const checkpointBefore = await readFile(f.preparation.project.checkpointPath);
    const publish = await connected.prepareCheckpoint!(); await f.changeFlagSource();
    await expect(connected.captureSources()).rejects.toThrow();
    await expect(connected.assertCurrent()).rejects.toThrow();
    await expect(connected.prepareCheckpoint!()).rejects.toThrow();
    await connected.close(); await expect(publish()).rejects.toThrow();
    expect(await readFile(f.preparation.project.checkpointPath)).toEqual(checkpointBefore);
  });
  it("carries the exact external diode path through preparation, resume, session and checkpoint", async () => {
    const f = await preparedFixture("external-diode"), bytes = await readFile(f.preparation.bundlePath);
    const resumed = await resumeKicadToolboxPlaneProject(f.resumeInput);
    expect(resumed.bundle.derivedPowerBinding).toEqual(f.bundle.derivedPowerBinding);
    const connected = await openKicadToolboxPlaneSession({ ...f.sessionInput, preparation: resumed });
    expect(connected.planeAuthoringContext?.derivedPowerBinding).toEqual(f.bundle.derivedPowerBinding);
    expect(connected.planeAuthoringContext?.externalPowerBinding).toEqual(f.bundle.externalPowerBinding);
    await connected.assertCurrent();
    const publish = await connected.prepareCheckpoint!(); await connected.close(); await publish();
    expect(await readFile(f.preparation.bundlePath)).toEqual(bytes);
  });
  it.each(["Device", "Connector_Generic", "Regulator_Switching"])("rejects external diode %s source drift before resume/connect", async nickname => {
    const f = await preparedFixture("external-diode"), file = f.symbolFiles[nickname]!;
    const before = await readFile(f.preparation.project.checkpointPath);
    await writeFile(file, `${await readFile(file, "utf8")}\n`, "utf8");
    expect(() => assertKicadToolboxPlanePreparation(f.preparation)).toThrow();
    await expect(resumeKicadToolboxPlaneProject(f.resumeInput)).rejects.toThrow();
    await expect(openKicadToolboxPlaneSession(f.sessionInput)).rejects.toThrow();
    expect(f.authority.connect).not.toHaveBeenCalled();
    expect(await readFile(f.preparation.project.checkpointPath)).toEqual(before);
  });
});
