import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGenericDividerBundleFixture } from "../helpers/generic-divider-bundle.js";
import { createFreshConnectivityContract } from "../../src/harness/fresh-connectivity-contract.js";
import { serializePcbDesignCompilationBundle } from "../../src/harness/pcb-design-compilation-bundle.js";
import { compilePcbPlaneDesignIntentDraft, normalizePcbPlaneSelectionPolicy } from "../../src/harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle, serializePcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";
import { canonicalIdentity } from "../../src/core/canonical.js";
import type { KicadCliAdapter, KicadExecutableIdentity } from "../../src/integrations/kicad-cli.js";

const seams = vi.hoisted(() => ({ design: vi.fn(), native: vi.fn(), prepare: vi.fn(), resume: vi.fn(), planePrepare: vi.fn(), planeResume: vi.fn(), open: vi.fn(), server: vi.fn() }));
vi.mock("../../src/mcp/toolbox-fresh-profile.js", () => ({ loadKicadToolboxFreshProfile: seams.design }));
vi.mock("../../src/mcp/toolbox-native-profile.js", () => ({ loadKicadToolboxNativeProfile: seams.native }));
vi.mock("../../src/mcp/toolbox-fresh-preparation.js", async original => ({
  ...await original<typeof import("../../src/mcp/toolbox-fresh-preparation.js")>(),
  prepareKicadToolboxFreshProject: seams.prepare, resumeKicadToolboxFreshProject: seams.resume }));
vi.mock("../../src/mcp/toolbox-plane-preparation.js", () => ({ prepareKicadToolboxPlaneProject: seams.planePrepare, resumeKicadToolboxPlaneProject: seams.planeResume }));
vi.mock("../../src/mcp/toolbox-native-host.js", () => ({ openKicadToolboxNativeHost: seams.open }));
vi.mock("../../src/mcp/toolbox-server.js", () => ({ createKicadToolboxMcpServer: seams.server }));
import { createFreshNativeToolbox, openFreshNativeToolboxBinding } from "../../src/mcp/toolbox-fresh-main.js";
import { parseNativeToolboxArgs } from "../../src/mcp/toolbox-native-main.js";

const roots: string[] = [];
afterEach(async () => { vi.resetAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "evleda-fresh-main-")); roots.push(root);
  const source = path.join(root, "input"), output = path.join(root, "output"); await mkdir(source);
  const binRoot = path.join(root, "kicad", "bin");
  const symbolRoot = path.join(root, "kicad", "share", "kicad", "symbols");
  const footprintRoot = path.join(root, "kicad", "share", "kicad", "footprints");
  await Promise.all([binRoot, symbolRoot, footprintRoot].map(directory => mkdir(directory, { recursive: true })));
  const intentPath = path.join(source, "intent.json"); await writeFile(intentPath, '{"draft":"data"}');
  const { bundle, dependencies } = createGenericDividerBundleFixture();
  const createCliAdapter = vi.fn();
  const expectedKicadCli = { path: "host-pinned" };
  const project = { projectPath: path.join(output, "project"), outputPath: output, pcbPath: path.join(output, "project", "proof.kicad_pcb") };
  const preparation = { project, dependencies, reportPath: path.join(output, "report.json"), bundle: {
    contract: bundle.contract, libraryBinding: bundle.libraryBinding,
    executionPrompt: { text: "compiled guidance", originalPrompt: "original request" }, acceptancePlan: { requirements: ["native-check"] }, identity: { digest: "bundle" },
  } };
  const cad = { close: vi.fn().mockResolvedValue(undefined), tools: { tools: [] as Array<{ name: string }> } };
  const design = { dependencies, protectedRoots: [symbolRoot, footprintRoot], deepRuleSelectionOptions: { maxRules: 10 },
    libraryEnvironment: { KICAD10_SYMBOL_DIR: symbolRoot, KICAD10_FOOTPRINT_DIR: footprintRoot } };
  seams.design.mockResolvedValue(design);
  seams.native.mockResolvedValue({ bridge: {}, editorSuite: { profile: { binRoot, kicadCli: expectedKicadCli } }, termination: {},
    environment: { SYSTEMROOT: "host-system" }, createCliAdapter });
  seams.prepare.mockResolvedValue({ status: "prepared", preparation }); seams.open.mockResolvedValue(cad); seams.server.mockReturnValue({ server: "mcp" });
  seams.resume.mockResolvedValue(preparation);
  const options = { profile: { path: path.join(root, "profile.json"), contentIdentity: { algorithm: "sha256" as const, digest: "a".repeat(64), size: 1 } },
    projectDir: source, outputDir: output, fresh: { name: "proof", intentPath, originalPrompt: "original request" } };
  return { options, dependencies, createCliAdapter, expectedKicadCli, preparation, cad, design, savedBundle: bundle };
}

async function planeFixture() {
  const f = await fixture(); const draft = planeDividerDraft();
  const { dependencies } = createGenericDividerBundleFixture();
  const compilation = compilePcbPlaneDesignIntentDraft(draft, dependencies);
  const bundle = createPcbPlaneCompilationBundle({ originalPrompt: "original plane request", compilation }, dependencies);
  const preparation = { ...f.preparation, family: "plane-v2" as const, bundle };
  seams.planePrepare.mockResolvedValue({ status: "prepared", preparation }); seams.planeResume.mockResolvedValue(preparation);
  await writeFile(f.options.fresh.intentPath, JSON.stringify(draft));
  return { ...f, planePreparation: preparation, planeBundle: bundle, draft };
}

describe("fresh native entrypoint composition", () => {
  it("forwards the optional reference calculator only through the source-bound native host", async () => {
    const f = await fixture(); const referenceCoverage = { calculate: vi.fn() };
    const native = await seams.native(); seams.native.mockClear();
    seams.native.mockResolvedValue({ ...native, referenceCoverage });
    await createFreshNativeToolbox(f.options);
    expect(seams.open).toHaveBeenCalledWith(expect.objectContaining({ referenceCoverage }));
    expect(seams.server.mock.calls[0]![0]).not.toHaveProperty("referenceCoverage");
  });
  it("snapshots and forwards a host preview identity before asynchronous startup", async () => {
    const f = await fixture(); const { bundle } = createGenericDividerBundleFixture();
    const expectedBundleIdentity = { ...bundle.identity };
    const pending = openFreshNativeToolboxBinding({ ...f.options, fresh: { ...f.options.fresh, expectedBundleIdentity } });
    expectedBundleIdentity.digest = "0".repeat(64);
    const binding = await pending;
    expect(seams.prepare).toHaveBeenCalledWith(expect.objectContaining({ expectedBundleIdentity: bundle.identity }));
    await binding.cad.close();
  });
  it("rejects a preview identity on saved-bundle resume before loading native capabilities", async () => {
    const f = await fixture(); const { bundle } = createGenericDividerBundleFixture();
    await expect(openFreshNativeToolboxBinding({ ...f.options, resume: true,
      fresh: { name: "proof", expectedBundleIdentity: bundle.identity } })).rejects.toThrow("resume cannot accept a previewed compilation identity");
    expect(seams.native).not.toHaveBeenCalled(); expect(seams.resume).not.toHaveBeenCalled();
  });
  it("returns an actual attachable file-route binding without creating a second MCP server", async () => {
    const f = await fixture(); const binding = await openFreshNativeToolboxBinding({ ...f.options, edit: true });
    expect(binding.cad).toBe(f.cad); expect(binding.access).toBe("edit");
    expect(binding.compoundContractIdentity).toEqual(createFreshConnectivityContract(f.preparation.bundle.contract).identity);
    expect(binding.designContext()).toMatchObject({ intentSourceKind: "file", resumedFromSavedBundle: false });
    expect(seams.server).not.toHaveBeenCalled(); expect(f.cad.close).not.toHaveBeenCalled();
    await binding.cad.close();
  });
  it("accepts and snapshots structured draft data without reading a JSON intent file", async () => {
    const f = await fixture(); await rm(f.options.fresh.intentPath);
    const draft = { draft: "original" };
    const pending = openFreshNativeToolboxBinding({ ...f.options,
      fresh: { name: "proof", originalPrompt: "original request", draft } });
    draft.draft = "changed by caller";
    const binding = await pending;
    expect(seams.prepare).toHaveBeenCalledWith(expect.objectContaining({ draft: { draft: "original" }, originalPrompt: "original request" }));
    expect(binding.designContext()).toMatchObject({ intentSourceKind: "structured", resumedFromSavedBundle: false,
      intentSourceIdentity: expect.objectContaining({ algorithm: "sha256" }) });
    expect(seams.server).not.toHaveBeenCalled(); await binding.cad.close();
  });
  it("rejects structured input mixed with either file input or authored resume", async () => {
    const f = await fixture();
    await expect(openFreshNativeToolboxBinding({ ...f.options, fresh: { ...f.options.fresh, draft: {} } })).rejects.toThrow("cannot be combined");
    await expect(openFreshNativeToolboxBinding({ ...f.options, resume: true, fresh: { name: "proof", draft: {} } })).rejects.toThrow("cannot be combined");
    expect(seams.prepare).not.toHaveBeenCalled(); expect(seams.resume).not.toHaveBeenCalled(); expect(seams.open).not.toHaveBeenCalled();
  });
  it("rejects oversized or accessor structured drafts before any profile/native work", async () => {
    const f = await fixture(); const getter = vi.fn(() => "not data");
    const draft = Object.defineProperty({}, "unsafe", { enumerable: true, get: getter });
    await expect(openFreshNativeToolboxBinding({ ...f.options, fresh: { name: "proof", originalPrompt: "original", draft } })).rejects.toThrow();
    await expect(openFreshNativeToolboxBinding({ ...f.options, fresh: { name: "proof", originalPrompt: "original", draft: { text: "x".repeat(256 * 1024) } } })).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled(); expect(seams.design).not.toHaveBeenCalled(); expect(seams.native).not.toHaveBeenCalled();
  });
  it("forwards an optional host calculator independently of CAD editing", async () => {
    const f = await fixture(); const transmissionLine = { calculate: vi.fn() };
    // The fixture configures a resolved return without calling it yet.
    const native = await seams.native(); seams.native.mockClear();
    seams.native.mockResolvedValue({ ...native, transmissionLine });
    await createFreshNativeToolbox(f.options);
    expect(seams.server).toHaveBeenCalledWith(expect.objectContaining({ transmissionLine, access: "read-only" }));
  });
  it("resumes the saved bundle without accepting new draft/prompt inputs", async () => {
    const f = await fixture(); await mkdir(f.options.outputDir); await writeFile(path.join(f.options.outputDir, "saved-state"), "retained");
    await writeFile(path.join(f.options.outputDir, "toolbox-design-bundle.json"), serializePcbDesignCompilationBundle(f.savedBundle));
    await createFreshNativeToolbox({ ...f.options, resume: true, fresh: { name: "proof" } });
    expect(seams.prepare).not.toHaveBeenCalled();
    expect(seams.resume).toHaveBeenCalledWith(expect.objectContaining({ outputDir: f.options.outputDir, name: "proof" }));
    expect(seams.server.mock.calls[0]![0].designContext()).toMatchObject({ originalPrompt: "original request", intentSourceIdentity: null, resumedFromSavedBundle: true });
    await expect(createFreshNativeToolbox({ ...f.options, resume: true })).rejects.toThrow("saved bundle, not new intent");
  });
  it("dispatches genuine V2 draft to plane preparation and exposes its distinct verification context", async () => {
    const f = await planeFixture(); const binding = await openFreshNativeToolboxBinding(f.options);
    expect(seams.planePrepare).toHaveBeenCalledWith(expect.objectContaining({ draft: f.draft,
      dependencies: { ...f.dependencies, deepRuleSelectionOptions: normalizePcbPlaneSelectionPolicy(f.design.deepRuleSelectionOptions) } }));
    expect(seams.prepare).not.toHaveBeenCalled(); expect(seams.resume).not.toHaveBeenCalled();
    const host = seams.open.mock.calls[0]![0];
    expect(host.planeFresh).toEqual({ preparation: f.planePreparation, createCliAdapter: f.createCliAdapter });
    expect(host).not.toHaveProperty("fresh");
    const context = binding.designContext();
    expect(context).toMatchObject({ family: "plane-v2", originalPrompt: "original plane request",
      contract: f.planeBundle.contract, verificationPlan: f.planeBundle.verificationPlan,
      executionGuidance: f.planeBundle.executionGuidance, acceptanceEvaluated: false,
      copperAuthoring: { incrementalRoutes: false, contractPlane: false } });
    expect(context).not.toHaveProperty("acceptancePlan");
    expect(binding.compoundContractIdentity).toEqual(createFreshConnectivityContract(f.planeBundle.contract).identity);
  });
  it.each([
    { edit: true, names: ["fresh_get_route_items", "fresh_replace_route_items"], routes: true, plane: false },
    { edit: true, names: ["fresh_get_route_items"], routes: false, plane: false },
    { edit: true, names: ["fresh_get_route_items", "fresh_replace_route_items", "fresh_apply_contract_plane"], routes: true, plane: true },
    { edit: false, names: ["fresh_get_route_items", "fresh_replace_route_items", "fresh_apply_contract_plane"], routes: false, plane: false },
  ])("reports only host-advertised copper operations with current edit access: %j", async ({ edit, names, routes, plane }) => {
    const f = await planeFixture(); f.cad.tools.tools = names.map(name => ({ name }));
    const binding = await openFreshNativeToolboxBinding({ ...f.options, edit });
    expect(binding.designContext()).toMatchObject({ copperAuthoring: { incrementalRoutes: routes, contractPlane: plane }, acceptanceEvaluated: false });
    await binding.cad.close();
  });
  it("resumes the persisted V2 family without replacing it from the original input file", async () => {
    const f = await planeFixture(); await mkdir(f.options.outputDir);
    const saved = serializePcbPlaneCompilationBundle(f.planeBundle);
    const bundlePath = path.join(f.options.outputDir, "toolbox-design-bundle.json"); await writeFile(bundlePath, saved);
    await writeFile(f.options.fresh.intentPath, "invalid replacement input");
    const binding = await openFreshNativeToolboxBinding({ ...f.options, resume: true, fresh: { name: "proof" } });
    expect(seams.planeResume).toHaveBeenCalledWith(expect.objectContaining({ name: "proof", outputDir: f.options.outputDir,
      dependencies: { ...f.dependencies, deepRuleSelectionOptions: normalizePcbPlaneSelectionPolicy(f.design.deepRuleSelectionOptions) } }));
    expect(seams.planePrepare).not.toHaveBeenCalled(); expect(seams.resume).not.toHaveBeenCalled(); expect(seams.prepare).not.toHaveBeenCalled();
    expect(binding.designContext()).toMatchObject({ family: "plane-v2", intentSourceKind: "saved-bundle", resumedFromSavedBundle: true, intentSourceIdentity: null });
    expect(await readFile(bundlePath)).toEqual(saved);
  });
  it("rejects unsupported saved family without falling back to new preparation or opening CAD", async () => {
    const f = await fixture(); await mkdir(f.options.outputDir);
    const bundlePath = path.join(f.options.outputDir, "toolbox-design-bundle.json");
    const bytes = Buffer.from('{"schemaVersion":"evleda.pcb-design-compilation-bundle.v99"}\n'); await writeFile(bundlePath, bytes);
    await expect(openFreshNativeToolboxBinding({ ...f.options, resume: true, fresh: { name: "proof" } })).rejects.toThrow("family is unsupported");
    expect(seams.planePrepare).not.toHaveBeenCalled(); expect(seams.planeResume).not.toHaveBeenCalled();
    expect(seams.prepare).not.toHaveBeenCalled(); expect(seams.resume).not.toHaveBeenCalled(); expect(seams.open).not.toHaveBeenCalled();
    expect(await readFile(bundlePath)).toEqual(bytes);
  });
  it("propagates V2 family verification failure without retrying V1 or replacing saved bytes", async () => {
    const f = await planeFixture(); await mkdir(f.options.outputDir);
    const bundlePath = path.join(f.options.outputDir, "toolbox-design-bundle.json"), bytes = serializePcbPlaneCompilationBundle(f.planeBundle);
    await writeFile(bundlePath, bytes); seams.planeResume.mockRejectedValue(new Error("bundle family does not match checkpoint"));
    await expect(openFreshNativeToolboxBinding({ ...f.options, resume: true, fresh: { name: "proof" } })).rejects.toThrow("family does not match checkpoint");
    expect(seams.resume).not.toHaveBeenCalled(); expect(seams.prepare).not.toHaveBeenCalled(); expect(seams.open).not.toHaveBeenCalled();
    expect(await readFile(bundlePath)).toEqual(bytes);
  });
  it("rejects changed current V2 policy through the real resume parser before native opening", async () => {
    const f = await fixture();
    const realPlane = await vi.importActual<typeof import("../../src/mcp/toolbox-plane-preparation.js")>("../../src/mcp/toolbox-plane-preparation.js");
    const { dependencies } = createGenericDividerBundleFixture();
    const identity: KicadExecutableIdentity = { kind: "kicad-cli", path: path.join(f.options.projectDir, "pinned-kicad-cli.exe"),
      version: "10.0.3", commit: "146a4f2a7585c65bc580427a19b6fe2ec4a3f622", sha256: "a".repeat(64), sizeBytes: 100,
      capabilityHelpSha256: "b".repeat(64), confirmedCapabilities: ["pcb drc"] };
    const expectedKicadCli = { path: identity.path, contentIdentity: { algorithm: "sha256" as const, digest: identity.sha256, size: identity.sizeBytes },
      operationalVersion: identity.version, operationalCommit: identity.commit, peFileVersion: "10.0.3", peProductVersion: "10.0.3",
      identity: canonicalIdentity({ fixture: true }, "evleda.flux-kicad-cli-binding.v1") };
    const createCliAdapter = vi.fn<typeof KicadCliAdapter.create>().mockResolvedValue({ identity } as KicadCliAdapter);
    const prepared = await realPlane.prepareKicadToolboxPlaneProject({ draft: planeDividerDraft(), originalPrompt: "saved plane request",
      outputDir: f.options.outputDir, name: "proof", dependencies, expectedKicadCli, createKicadCliAdapter: createCliAdapter });
    if (prepared.status !== "prepared") throw new Error(`Real plane fixture did not prepare: ${JSON.stringify(prepared)}`);
    const saved = prepared.preparation;
    const beforeBundle = await readFile(saved.bundlePath), beforeCheckpoint = await readFile(saved.project.checkpointPath);
    const native = await seams.native(); seams.native.mockClear();
    seams.native.mockResolvedValue({ ...native, editorSuite: { ...native.editorSuite,
      profile: { ...native.editorSuite.profile, kicadCli: expectedKicadCli } }, createCliAdapter });
    const changedPolicy = { maxRules: 39 };
    seams.design.mockResolvedValue({ ...f.design, dependencies, deepRuleSelectionOptions: changedPolicy });
    seams.planeResume.mockImplementation(realPlane.resumeKicadToolboxPlaneProject);
    createCliAdapter.mockClear();
    await expect(openFreshNativeToolboxBinding({ ...f.options, resume: true, fresh: { name: "proof" } })).rejects.toThrow(/policy/i);
    expect(seams.planeResume).toHaveBeenCalledWith(expect.objectContaining({ dependencies: {
      ...dependencies, deepRuleSelectionOptions: normalizePcbPlaneSelectionPolicy(changedPolicy) } }));
    expect(createCliAdapter).not.toHaveBeenCalled(); expect(seams.open).not.toHaveBeenCalled();
    expect(seams.resume).not.toHaveBeenCalled(); expect(seams.prepare).not.toHaveBeenCalled(); expect(seams.planePrepare).not.toHaveBeenCalled();
    expect(await readFile(saved.bundlePath)).toEqual(beforeBundle); expect(await readFile(saved.project.checkpointPath)).toEqual(beforeCheckpoint);
  });
  it("does not apply the plane-only policy normalizer to V1 dispatch", async () => {
    const f = await fixture(); const v1Policy = { maxRules: 100 };
    seams.design.mockResolvedValue({ ...f.design, deepRuleSelectionOptions: v1Policy });
    await openFreshNativeToolboxBinding(f.options);
    expect(seams.prepare).toHaveBeenCalledWith(expect.objectContaining({ dependencies: f.dependencies, deepRuleSelectionOptions: v1Policy }));
    expect(seams.planePrepare).not.toHaveBeenCalled();
  });
  it("rejects approved libraries from a different installation before preparation or editor launch", async () => {
    const f = await fixture();
    seams.design.mockResolvedValue({ ...f.design, libraryEnvironment: {
      ...f.design.libraryEnvironment, KICAD10_SYMBOL_DIR: f.options.projectDir,
    } });
    await expect(createFreshNativeToolbox(f.options)).rejects.toThrow("libraries must match the pinned KiCad installation");
    expect(seams.prepare).not.toHaveBeenCalled(); expect(seams.open).not.toHaveBeenCalled();
  });

  it("hands the compiled context and pinned factory to the fresh host with read-only default", async () => {
    const f = await fixture(); await createFreshNativeToolbox(f.options);
    expect(seams.prepare).toHaveBeenCalledWith(expect.objectContaining({ draft: { draft: "data" },
      dependencies: f.dependencies, createKicadCliAdapter: f.createCliAdapter, expectedKicadCli: f.expectedKicadCli }));
    expect(seams.open).toHaveBeenCalledWith(expect.objectContaining({ fresh: { preparation: f.preparation, createCliAdapter: f.createCliAdapter } }));
    const request = seams.server.mock.calls[0]![0];
    expect(request.access).toBe("read-only");
    const connectivityIdentity = createFreshConnectivityContract(f.preparation.bundle.contract).identity;
    expect(request.compoundContractIdentity).toEqual(connectivityIdentity);
    expect(request.compoundContractIdentity).not.toEqual(f.preparation.bundle.contract.identity);
    expect(request.designContext()).toMatchObject({ contract: f.preparation.bundle.contract,
      executionGuidance: "compiled guidance", acceptancePlan: f.preparation.bundle.acceptancePlan,
      originalPrompt: "original request", status: "requirements-only; authoring and verification remain pending" });
  });

  it("writes clarification data without opening the editor or MCP server", async () => {
    const f = await fixture(); seams.prepare.mockResolvedValue({ status: "needs_clarification", compilation: { issues: ["missing pins"] } });
    await expect(createFreshNativeToolbox(f.options)).rejects.toThrow("clarifications");
    expect(JSON.parse(await readFile(path.join(f.options.outputDir, "toolbox-clarifications.json"), "utf8"))).toMatchObject({ status: "needs_clarification" });
    expect(seams.open).not.toHaveBeenCalled(); expect(seams.server).not.toHaveBeenCalled();
  });

  it("rejects occupied output before native profile creation", async () => {
    const f = await fixture(); await mkdir(f.options.outputDir); await writeFile(path.join(f.options.outputDir, "existing"), "preserve");
    await expect(createFreshNativeToolbox(f.options)).rejects.toThrow("empty for a new design");
    expect(seams.native).not.toHaveBeenCalled(); expect(seams.open).not.toHaveBeenCalled();
  });

  it("closes the owned native session when MCP construction fails", async () => {
    const f = await fixture(); seams.server.mockImplementation(() => { throw new Error("server setup failed"); });
    await expect(createFreshNativeToolbox(f.options)).rejects.toThrow("server setup failed");
    expect(f.cad.close).toHaveBeenCalledOnce();
  });

  it("keeps copied and fresh CLI modes mutually exclusive", () => {
    const base = ["--profile", "profile.json", "--profile-sha256", "a".repeat(64), "--profile-bytes", "1", "--project-dir", "input", "--output-dir", "output"];
    const fresh = ["--new-project", "proof", "--intent", "intent.json", "--prompt", "make proof"];
    expect(parseNativeToolboxArgs([...base, ...fresh])).toMatchObject({ fresh: { name: "proof" }, edit: false });
    expect(() => parseNativeToolboxArgs([...base, ...fresh, "--resume"])).toThrow("omit --intent and --prompt");
    expect(() => parseNativeToolboxArgs([...base, ...fresh, "--board", "old.kicad_pcb"])).toThrow("cannot also select --board");
    expect(() => parseNativeToolboxArgs([...base, "--board", "old.kicad_pcb", "--intent", "intent.json"])).toThrow("require --new-project");
  });
});
