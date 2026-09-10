import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({ read: vi.fn(), realpath: vi.fn(), toolchain: vi.fn(), bridge: vi.fn(), suite: vi.fn(), run: vi.fn(), calculator: vi.fn(), reference: vi.fn(), plane: vi.fn() }));
vi.mock("node:fs/promises", () => ({ realpath: seams.realpath }));
vi.mock("../../src/flux/production-composition.js", () => ({ readKicadNativeProfile: seams.read }));
vi.mock("../../src/flux/kicad-toolchain-binding.js", () => ({ createFluxKicadToolchainBinding: seams.toolchain }));
vi.mock("../../src/flux/pcb-editor-launcher.js", () => ({ bindFluxPcbEditorSuite: seams.suite }));
vi.mock("../../src/integrations/kicad-transmission-line.js", () => ({ createKicadTransmissionLineCalculator: seams.calculator }));
vi.mock("../../src/integrations/kicad-reference-coverage.js", () => ({ createReferenceCoverageCalculator: seams.reference }));
vi.mock("../../src/integrations/kicad-plane-contacts.js", () => ({ createKicadPlaneContactsReader: seams.plane }));
vi.mock("../../src/integrations/bounded-process.js", () => ({
  BOUNDED_WINDOWS_PROCESS_TREE_TERMINATION_SCHEMA_VERSION: "termination-schema", runBoundedProcess: seams.run,
}));
vi.mock("../../src/integrations/kicad-mcp-session.js", () => ({
  createKicadMcpRuntimeBridge: seams.bridge, KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS: 123,
  KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY: "pinned-strategy", KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS: 456,
}));
import { loadKicadToolboxNativeProfile } from "../../src/mcp/toolbox-native-profile.js";

const root = path.resolve("toolbox-profile-fixture");
const at = (...parts: string[]) => path.join(root, ...parts);
const pin = (character: string) => ({ algorithm: "sha256" as const, digest: character.repeat(64), size: 17 });
function fixture() {
  const profile = {
    path: at("config", "profile.json"), contentIdentity: pin("a"),
    kicadToolchain: { binRoot: at("bin"),
      kicadCli: { path: at("bin", "kicad-cli.exe"), identity: pin("b"), operationalVersion: "10.0", operationalCommit: "commit", peFileVersion: "10.0.1", peProductVersion: "10.0.2" },
      pcbnew: { path: at("bin", "pcbnew.exe"), identity: pin("c"), peFileVersion: "10.0.3", peProductVersion: "10.0.4" } },
    kicadMcpRuntime: { lock: { path: at("lock", "lock.json"), identity: pin("d") },
      runtimeBundle: { root: at("bundle"), manifest: { path: at("manifest", "manifest.json"), identity: pin("e") },
        expectedClosure: { fileCount: 29, manifestIdentity: pin("f"), treeIdentity: pin("1"), protocol: "protocol",
          python: { relativePath: "python.exe", identity: pin("2") }, entrypoint: { relativePath: "main.py", identity: pin("3") } } },
      runtimeParentRoot: at("private-runtime"), ipcSocketParentRoot: at("sockets"),
      runtimePolicy: { verificationTimeoutMs: 123 },
      processTreeSupervision: { terminator: { path: at("system", "taskkill.exe"), identity: pin("4") } } },
  };
  const input = { profile: { path: profile.path, contentIdentity: profile.contentIdentity }, sourceRoot: at("source"), outputRoot: at("output"),
    environment: { SYSTEMROOT: at("system"), WINDIR: at("system"), OPENAI_API_KEY: "must-not-forward", ANTHROPIC_API_KEY: "also-private", PYTHONPATH: "untrusted", PATH: "unrelated" } };
  const bridge = { assertCurrent: vi.fn().mockResolvedValue(undefined) };
  const toolchain = { bound: "toolchain" };
  const suite = { bound: "suite" };
  seams.read.mockResolvedValue(profile);
  seams.realpath.mockImplementation(async (value: string) => value);
  seams.toolchain.mockReturnValue(toolchain);
  seams.bridge.mockResolvedValue(bridge);
  seams.suite.mockResolvedValue(suite);
  return { profile, input, bridge, toolchain, suite };
}
beforeEach(() => vi.resetAllMocks());

describe("native toolbox profile composition", () => {
  it("binds plane contacts to fixed runtime/helper pins and a host-selected source", async () => {
    const f=fixture(), reader={read:vi.fn()};
    const config={runtimeRoot:at("contacts-runtime"),manifest:{path:at("contacts-profile","manifest.json"),identity:pin("7")},helper:{path:at("contacts-helper","read.py"),identity:pin("8")}};
    seams.read.mockResolvedValue({...f.profile,kicadPlaneContacts:config});seams.plane.mockResolvedValue(reader);
    const loaded=await loadKicadToolboxNativeProfile(f.input);
    expect(seams.plane).not.toHaveBeenCalled();
    expect(await loaded.createPlaneContactsReader!({pcbPath:at("output","project","board.kicad_pcb"),expectedSourceIdentity:pin("9")})).toBe(reader);
    expect(seams.plane).toHaveBeenCalledWith({pcbPath:at("output","project","board.kicad_pcb"),expectedSourceIdentity:pin("9"),runtimeRoot:config.runtimeRoot,
      manifest:{path:config.manifest.path,contentIdentity:pin("7")},helper:{path:config.helper.path,contentIdentity:pin("8")},
      outputRoot:at("output"),environment:{SYSTEMROOT:at("system"),WINDIR:at("system")},windowsProcessTreeTermination:loaded.termination});
    expect(seams.bridge.mock.calls[0]![0].protectedRoots).toEqual(expect.arrayContaining([config.runtimeRoot,at("contacts-profile"),at("contacts-helper")]));
  });
  it.each(["runtimeRoot","manifest","helper"] as const)("rejects a plane %s resource inside editable output before native probes", async field=>{
    const f=fixture();
    const config={runtimeRoot:at("contacts-runtime"),manifest:{path:at("contacts-profile","manifest.json"),identity:pin("7")},helper:{path:at("contacts-helper","read.py"),identity:pin("8")}};
    if(field==="runtimeRoot")config.runtimeRoot=at("output","runtime");else config[field].path=at("output",field,"file");
    seams.read.mockResolvedValue({...f.profile,kicadPlaneContacts:config});
    await expect(loadKicadToolboxNativeProfile(f.input)).rejects.toThrow("overlap fixed native resources");
    expect(seams.bridge).not.toHaveBeenCalled();expect(seams.plane).not.toHaveBeenCalled();
  });
  it("binds reference coverage to its pin, per-project output and sanitized native authority", async () => {
    const f = fixture(); const calculator = { calculate: vi.fn() };
    seams.read.mockResolvedValue({ ...f.profile, kicadReferenceCoverage: { path: at("reference", "helper.exe"), identity: pin("6") } });
    seams.reference.mockResolvedValue(calculator);
    const result = await loadKicadToolboxNativeProfile(f.input);
    expect(result.referenceCoverage).toBe(calculator);
    expect(seams.reference).toHaveBeenCalledWith({ executablePath: at("reference", "helper.exe"),
      expectedExecutableIdentity: { sha256: "6".repeat(64), sizeBytes: 17 }, cwd: at("reference"), outputRoot: at("output"),
      environment: { SYSTEMROOT: at("system"), WINDIR: at("system") }, windowsProcessTreeTermination: result.termination });
    expect(seams.bridge.mock.calls[0]![0].protectedRoots).toContain(at("reference"));
  });
  it("rejects reference coverage overlapping the project before probing native capabilities", async () => {
    const f = fixture();
    seams.read.mockResolvedValue({ ...f.profile, kicadReferenceCoverage: { path: at("output", "helper.exe"), identity: pin("6") } });
    await expect(loadKicadToolboxNativeProfile(f.input)).rejects.toThrow("overlap fixed native resources");
    expect(seams.bridge).not.toHaveBeenCalled(); expect(seams.reference).not.toHaveBeenCalled();
  });
  it("leaves the reference calculator absent for existing profiles", async () => {
    const f = fixture();
    expect(await loadKicadToolboxNativeProfile(f.input)).not.toHaveProperty("referenceCoverage");
    expect(seams.reference).not.toHaveBeenCalled();
  });
  it("binds the optional calculator with its exact pin and protects its host directory", async () => {
    const f = fixture(); const calculator = { calculate: vi.fn() };
    seams.read.mockResolvedValue({ ...f.profile, kicadTransmissionLine: { path: at("calculator", "helper.exe"), identity: pin("5") } });
    seams.calculator.mockResolvedValue(calculator);
    const result = await loadKicadToolboxNativeProfile(f.input);
    expect(result.transmissionLine).toBe(calculator);
    expect(seams.calculator).toHaveBeenCalledWith({ executablePath: at("calculator", "helper.exe"),
      expectedExecutableIdentity: { sha256: "5".repeat(64), sizeBytes: 17 }, cwd: at("calculator"),
      environment: { SYSTEMROOT: at("system"), WINDIR: at("system") }, windowsProcessTreeTermination: result.termination });
    expect(seams.bridge.mock.calls[0]![0].protectedRoots).toContain(at("calculator"));
  });

  it("rejects a calculator inside the editable project before native probing", async () => {
    const f = fixture();
    seams.read.mockResolvedValue({ ...f.profile, kicadTransmissionLine: { path: at("output", "helper.exe"), identity: pin("5") } });
    await expect(loadKicadToolboxNativeProfile(f.input)).rejects.toThrow("overlap fixed native resources");
    expect(seams.bridge).not.toHaveBeenCalled(); expect(seams.calculator).not.toHaveBeenCalled();
  });

  it("forwards the opt-in connection deadline policy exactly", async () => {
    const f = fixture();
    seams.read.mockResolvedValue({ ...f.profile, kicadMcpRuntime: { ...f.profile.kicadMcpRuntime,
      runtimePolicy: { ...f.profile.kicadMcpRuntime.runtimePolicy, connectionDeadlinePolicy: "bounded-phases-v1" } } });
    await loadKicadToolboxNativeProfile(f.input);
    expect(seams.bridge.mock.calls[0]![0].connectionDeadlinePolicy).toBe("bounded-phases-v1");
  });

  it("preserves parsed executable pins, closure, roots and sanitized environment", async () => {
    const f = fixture();
    const result = await loadKicadToolboxNativeProfile(f.input);
    const runtime = f.profile.kicadMcpRuntime;
    const expected = runtime.runtimeBundle.expectedClosure;
    const environment = { SYSTEMROOT: at("system"), WINDIR: at("system") };
    expect(seams.read).toHaveBeenCalledWith(f.input.profile);
    expect(seams.toolchain).toHaveBeenCalledWith({ binRoot: at("bin"),
      kicadCli: { path: at("bin", "kicad-cli.exe"), contentIdentity: pin("b"), operationalVersion: "10.0", operationalCommit: "commit", peFileVersion: "10.0.1", peProductVersion: "10.0.2" },
      pcbnew: { path: at("bin", "pcbnew.exe"), contentIdentity: pin("c"), peFileVersion: "10.0.3", peProductVersion: "10.0.4" } });
    expect(seams.bridge).toHaveBeenCalledWith({
      lockFile: { path: runtime.lock.path, contentIdentity: runtime.lock.identity },
      runtimeBundle: { root: runtime.runtimeBundle.root, manifestFile: { path: runtime.runtimeBundle.manifest.path, contentIdentity: runtime.runtimeBundle.manifest.identity },
        expectedClosure: { fileCount: 29, manifestIdentity: expected.manifestIdentity, treeIdentity: expected.treeIdentity, protocol: expected.protocol,
          python: { relativePath: "python.exe", contentIdentity: pin("2") }, entrypoint: { relativePath: "main.py", contentIdentity: pin("3") } } },
      runtimeParentRoot: at("private-runtime"), ipcSocketParentRoot: at("sockets"), verificationTimeoutMs: 123,
      processTreeSupervision: { strategy: "pinned-strategy", terminator: { path: at("system", "taskkill.exe"), contentIdentity: pin("4") }, timeoutMs: 456 },
      kicadCli: { path: at("bin", "kicad-cli.exe"), contentIdentity: pin("b") }, environment,
      protectedRoots: [at("source"), at("output"), at("config"), at("bin"), at("bundle"), at("lock"), at("manifest")],
    });
    expect(seams.suite).toHaveBeenCalledWith({ toolchain: f.toolchain, environment, runner: expect.any(Function) });
    expect(result).toMatchObject({ bridge: f.bridge, editorSuite: f.suite, profileIdentity: pin("a"), environment });
    expect(f.bridge.assertCurrent).toHaveBeenCalledOnce();
    expect(seams.run).not.toHaveBeenCalled();
  });

  it("pins process-tree termination on every suite probe", async () => {
    const f = fixture();
    const result = await loadKicadToolboxNativeProfile(f.input);
    const { runner } = seams.suite.mock.calls[0]![0];
    const probe = { command: "verified-cli", args: ["--version"], timeoutMs: 300, windowsProcessTreeTermination: { untrusted: true } };
    await runner(probe);
    expect(seams.run).toHaveBeenCalledWith({ ...probe, windowsProcessTreeTermination: {
      schemaVersion: "termination-schema", executablePath: at("system", "taskkill.exe"), executableIdentity: pin("4"),
      cwd: at("bundle"), env: { SYSTEMROOT: at("system"), WINDIR: at("system") },
    } });
    expect(result.termination).toEqual(seams.run.mock.calls[0]![0].windowsProcessTreeTermination);
  });

  it.each(["same", "nested-output", "nested-source", "resolved-alias"])("rejects %s project roots before composing native capabilities", async kind => {
    const f = fixture();
    if (kind === "same") f.input.outputRoot = f.input.sourceRoot;
    if (kind === "nested-output") f.input.outputRoot = path.join(f.input.sourceRoot, "out");
    if (kind === "nested-source") f.input.sourceRoot = path.join(f.input.outputRoot, "source");
    if (kind === "resolved-alias") seams.realpath.mockResolvedValue(at("same-real-directory"));
    await expect(loadKicadToolboxNativeProfile(f.input)).rejects.toThrow("must be separate");
    expect(seams.toolchain).not.toHaveBeenCalled();
    expect(seams.bridge).not.toHaveBeenCalled();
    expect(seams.suite).not.toHaveBeenCalled();
  });

  it.each(["profile", "suite", "bundle", "lock", "manifest", "terminator"])("rejects source overlap with pinned %s before any probe", async kind => {
    const f = fixture();
    const runtime = f.profile.kicadMcpRuntime;
    if (kind === "profile") f.profile.path = path.join(f.input.sourceRoot, "profile.json");
    if (kind === "suite") f.profile.kicadToolchain.binRoot = f.input.sourceRoot;
    if (kind === "bundle") runtime.runtimeBundle.root = f.input.sourceRoot;
    if (kind === "lock") runtime.lock.path = path.join(f.input.sourceRoot, "lock.json");
    if (kind === "manifest") runtime.runtimeBundle.manifest.path = path.join(f.input.sourceRoot, "manifest.json");
    if (kind === "terminator") runtime.processTreeSupervision.terminator.path = path.join(f.input.sourceRoot, "taskkill.exe");
    await expect(loadKicadToolboxNativeProfile(f.input)).rejects.toThrow("overlap fixed native resources");
    expect(seams.bridge).not.toHaveBeenCalled();
    expect(seams.suite).not.toHaveBeenCalled();
    expect(seams.run).not.toHaveBeenCalled();
  });

  it("rejects mismatched Windows environment before native probes", async () => {
    const f = fixture();
    f.input.environment.WINDIR = at("different-system");
    await expect(loadKicadToolboxNativeProfile(f.input)).rejects.toThrow("matching SYSTEMROOT and WINDIR");
    expect(seams.bridge).not.toHaveBeenCalled();
    expect(seams.suite).not.toHaveBeenCalled();
  });

  it.each(["profile", "bridge", "suite", "current"])("propagates %s verification failure without invoking a process", async stage => {
    const f = fixture();
    const error = new Error(`${stage} verification failed`);
    const failing = stage === "profile" ? seams.read : stage === "bridge" ? seams.bridge
      : stage === "suite" ? seams.suite : f.bridge.assertCurrent;
    failing.mockRejectedValue(error);
    await expect(loadKicadToolboxNativeProfile(f.input)).rejects.toBe(error);
    if (stage === "profile") expect(seams.bridge).not.toHaveBeenCalled();
    if (stage === "profile" || stage === "bridge") expect(seams.suite).not.toHaveBeenCalled();
    expect(seams.run).not.toHaveBeenCalled();
  });
});
