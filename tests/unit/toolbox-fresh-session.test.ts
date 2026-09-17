import path from "node:path";
import { KicadMcpTerminationUncertainError } from "../../src/integrations/kicad-mcp-session.js";
import { captureKicadStartupFailure } from "../../src/integrations/kicad-startup-diagnostic.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KicadToolboxFreshSessionInput } from "../../src/mcp/toolbox-fresh-session.js";
import { sourceAwareLibraryFixture } from "../helpers/pcb-library-source-fixture.js";

const seams = vi.hoisted(() => ({ authenticate: vi.fn(), initialize: vi.fn(), initialSave: vi.fn(), checkpoint: vi.fn(), verifyClasses: vi.fn(),
  resume: vi.fn(), captures: vi.fn(), tools: vi.fn(), practices: vi.fn(), fingerprint: vi.fn(), lifecycle: vi.fn(), placementDiagnostic: vi.fn() }));
vi.mock("../../src/mcp/toolbox-fresh-checkpoint.js", () => ({ createFreshToolboxCheckpointLifecycle: seams.lifecycle }));
vi.mock("../../src/mcp/toolbox-fresh-initial-save.js", () => ({ saveInitialFreshProjectSettings: seams.initialSave }));
vi.mock("../../src/cli/pcb-agent.js", () => ({ createFreshNativeCaptures: seams.captures,
  initializeIsolatedKicadProject: seams.initialize, nativeProjectFingerprint: seams.fingerprint }));
vi.mock("../../src/harness/fresh-project.js", () => ({ checkpointFreshProjectOpenNormalization: seams.checkpoint, prepareFreshProject: seams.resume }));
vi.mock("../../src/harness/fresh-clearance-evidence.js", () => ({ verifyFreshNetClassSemanticAuthority: seams.verifyClasses }));
vi.mock("../../src/harness/kicad-tools.js", () => ({ createKicadHarnessTools: seams.tools,
  KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES: ["sch_add_labels", "evleda_get_live_pcb_document", "pcb_save", "kicad_set_project"] }));
vi.mock("../../src/mcp/toolbox-fresh-preparation.js", () => ({ assertKicadToolboxFreshPreparation: seams.authenticate }));
vi.mock("../../src/mcp/toolbox-practices.js", () => ({ createToolboxPracticeAnalyzer: seams.practices }));
vi.mock("../../src/mcp/toolbox-footprint-placement-diagnostics.js", () => ({ writeToolboxFootprintPlacementDiagnostic: seams.placementDiagnostic }));
import { openKicadToolboxFreshSession } from "../../src/mcp/toolbox-fresh-session.js";

beforeEach(() => vi.resetAllMocks());
function fixture() {
  const order: string[] = [];
  const identity = { authority: "host" };
  const session = { identity: { launch: { sessionAuthorityIdentity: identity } }, close: vi.fn().mockResolvedValue(undefined), callTool: vi.fn(),
    assertActivePcb: vi.fn().mockImplementation(async () => { order.push("active"); }) };
  const authority = { identity, connect: vi.fn().mockImplementation(async () => { order.push("connect"); return session; }), disposeUnused: vi.fn() };
  const original = { outputPath: "output", projectPath: "output/project", pcbPath: "output/project/board.kicad_pcb", name: "board" };
  const resumed = { ...original, checkpoint: "normalized" };
  const sourceIdentity = { algorithm: "sha256", digest: "a".repeat(64), size: 10 };
  const resolver = { inspectFootprint: vi.fn().mockReturnValue({ libraryId: "Lib:Footprint", sourceIdentity }), inspectSymbolTerminalGeometry: vi.fn() };
  const bundle = { libraryBinding: { symbols: [{ libraryId: "Lib:Symbol" }], footprints: [{ libraryId: "Lib:Footprint" }] },
    contract: { components: [{ reference: "R1", footprintLibId: "Lib:Footprint" }] }, practiceProfileBinding: { profile: { reviewed: "practice" } } };
  const preparation = { mode: "fresh", project: original, bundle, bundleRef: { pinned: "bundle" }, dependencies: { libraryResolver: resolver }, reportPath: "output/report",
    preparedSourceAuthority: { exact: "original-preparation" }, netClassSemanticAuthority: { netClasses: [{ id: "signal" }], contractNetAssignments: [{ net: "SIG" }] },
    kicadIdentity: { path: "host/kicad-cli.exe" } };
  seams.authenticate.mockImplementation(value => { if (value !== preparation) throw new Error("Unauthenticated preparation"); });
  seams.initialize.mockImplementation(async () => { order.push("initialize"); });
  seams.initialSave.mockImplementation(async () => { order.push("initial-save"); });
  seams.checkpoint.mockImplementation(async () => { order.push("normalize"); });
  seams.verifyClasses.mockImplementation(async () => { order.push("classes"); });
  seams.resume.mockImplementation(async () => { order.push("resume"); return resumed; });
  const captures = { captureNativeNetlist: vi.fn(), captureNativeSchematicStrokeStyle: vi.fn() };
  seams.captures.mockReturnValue(captures);
  const tools = { tools: [] }; seams.tools.mockReturnValue(tools);
  const practices = vi.fn(); seams.practices.mockResolvedValue(practices);
  const lifecycle = { prepareCheckpoint: vi.fn(), recordRecoveryRequired: vi.fn() }; seams.lifecycle.mockReturnValue(lifecycle);
  const createCliAdapter = vi.fn();
  const input = { authority, preparation, createCliAdapter } as unknown as KicadToolboxFreshSessionInput;
  return { input, order, session, authority, original, resumed, resolver, bundle, preparation, captures, tools, practices, createCliAdapter, sourceIdentity, lifecycle };
}

function pinSources(f: ReturnType<typeof fixture>) {
  const sources = sourceAwareLibraryFixture(f.resolver);
  Object.assign(f.resolver, { captureSourceSelection: sources.resolver.captureSourceSelection });
  Object.assign(f.bundle.libraryBinding, { sourceSelection: sources.resolver.captureSourceSelection({ symbolIds: ["Lib:Symbol"], footprintIds: ["Lib:Footprint"] }) });
  return sources;
}

describe("fresh toolbox session composition", () => {
  it.each(["symbol", "footprint"] as const)("rejects persisted %s source drift before native connect", async kind => {
    const f = fixture(); const sources = pinSources(f); f.preparation.mode = "resumed";
    sources.changeSource(kind);
    await expect(openKicadToolboxFreshSession(f.input)).rejects.toThrow(/library sources|catalog policy/);
    expect(f.authority.connect).not.toHaveBeenCalled(); expect(seams.initialize).not.toHaveBeenCalled();
    expect(f.authority.disposeUnused).toHaveBeenCalledOnce();
  });

  it("rejects symbol drift while connecting before initialization or initial save", async () => {
    const f = fixture(); const sources = pinSources(f);
    f.authority.connect.mockImplementation(async () => { sources.changeSource("symbol"); return f.session; });
    await expect(openKicadToolboxFreshSession(f.input)).rejects.toThrow(/library sources|catalog policy/);
    expect(seams.initialize).not.toHaveBeenCalled(); expect(seams.initialSave).not.toHaveBeenCalled();
    expect(f.session.close).toHaveBeenCalledOnce();
  });

  it.each(["symbol", "footprint"] as const)("rejects later %s drift at current-source reads and checkpoint publication", async kind => {
    const f = fixture(); const sources = pinSources(f); const connected = await openKicadToolboxFreshSession(f.input);
    expect(seams.tools.mock.calls[0]![1].freshLibraryResolver).toBe(f.resolver);
    const publish = vi.fn().mockResolvedValue(undefined); f.lifecycle.prepareCheckpoint.mockResolvedValue(publish);
    const commit = await connected.prepareCheckpoint!();
    sources.changeSource(kind);
    await expect(connected.captureSources()).rejects.toThrow(/library sources|catalog policy/);
    await expect(connected.assertCurrent()).rejects.toThrow(/library sources|catalog policy/);
    await expect(connected.prepareCheckpoint!()).rejects.toThrow(/library sources|catalog policy/);
    await expect(commit()).rejects.toThrow(/library sources|catalog policy/);
    expect(publish).not.toHaveBeenCalled(); expect(seams.fingerprint).not.toHaveBeenCalled();
  });

  it("saves initial settings after live assertion, normalizes with original authority, then wires resumed capabilities", async () => {
    const f = fixture(); const connected = await openKicadToolboxFreshSession(f.input);
    expect(f.order).toEqual(["connect", "initialize", "active", "initial-save", "normalize", "classes", "resume", "active"]);
    expect(f.authority.connect).toHaveBeenCalledWith({ workspaceRoot: f.original.outputPath, projectRoot: f.original.projectPath,
      outputRoot: path.join(f.original.outputPath, ".evleda-mcp-output"), mode: "write", freshProject: true,
      requiredTools: ["evleda_get_live_pcb_document", "kicad_set_project", "pcb_save", "sch_add_labels"] });
    expect(seams.initialize.mock.calls[0]![1].freshProject).toBe(f.original);
    expect(seams.initialSave).toHaveBeenCalledExactlyOnceWith({ project: f.original,
      expectedPreparedSourceAuthority: f.preparation.preparedSourceAuthority, session: f.session });
    expect(seams.checkpoint).toHaveBeenCalledWith({ outputDir: f.original.outputPath, name: f.original.name,
      expectedPreparedSourceAuthority: f.preparation.preparedSourceAuthority,
      expectedNetClassProjection: { netClasses: f.preparation.netClassSemanticAuthority.netClasses, contractNetAssignments: f.preparation.netClassSemanticAuthority.contractNetAssignments } });
    expect(seams.verifyClasses).toHaveBeenCalledWith(f.preparation.netClassSemanticAuthority,
      { project: f.original, compilationBundle: f.bundle, kicad: f.preparation.kicadIdentity });
    expect(seams.resume).toHaveBeenCalledWith({ outputDir: f.original.outputPath, name: f.original.name, resume: true, workflowKind: "generic",
      compilationBundle: f.bundle, compilationBundleRef: f.preparation.bundleRef });
    expect(seams.captures).toHaveBeenCalledWith({ project: f.resumed, executablePath: f.preparation.kicadIdentity.path, createAdapter: f.createCliAdapter });
    const options = seams.tools.mock.calls[0]![1];
    expect(options).toMatchObject({ freshProject: f.resumed, freshConnectivityContract: f.bundle.contract, freshCompilationBundle: f.bundle,
      freshSchematicGeometryResolver: f.resolver, freshPhysicalFootprintResolver: f.resolver,
      freshPhysicalFootprintSourcePins: [{ reference: "R1", libraryId: "Lib:Footprint", sourceIdentity: f.sourceIdentity }],
      captureFreshNativeNetlist: f.captures.captureNativeNetlist, captureFreshSchematicStrokeStyle: f.captures.captureNativeSchematicStrokeStyle });
    expect(options.freshProject).toBe(f.resumed);
    const placementDiagnostic = { phase: "primary-failure", firstOperation: "native-reload" };
    await options.observeFreshFootprintPlacementDiagnostic(placementDiagnostic);
    expect(seams.placementDiagnostic).toHaveBeenCalledWith(path.join(f.original.outputPath, ".evleda-mcp-output"), placementDiagnostic);
    expect(options.freshPhysicalFootprintSourcePins[0].sourceIdentity).not.toBe(f.sourceIdentity);
    expect(seams.practices).toHaveBeenCalledWith({ pcbPath: f.resumed.pcbPath, profile: f.bundle.practiceProfileBinding.profile });
    expect(connected.analyzePractices).toBe(f.practices);
    expect(seams.lifecycle).toHaveBeenCalledWith({ project: f.resumed, preparation: f.preparation, session: f.session });
    const publish = vi.fn().mockResolvedValue(undefined); f.lifecycle.prepareCheckpoint.mockResolvedValue(publish);
    await (await connected.prepareCheckpoint!())();
    expect(f.lifecycle.prepareCheckpoint).toHaveBeenCalledOnce(); expect(publish).toHaveBeenCalledOnce();
    expect(connected.recordRecoveryRequired).toBe(f.lifecycle.recordRecoveryRequired);
    seams.fingerprint.mockResolvedValue("after");
    expect(await options.verifyPersistedMutation("before")).toBe(true);
    expect(await options.verifyPersistedMutation(undefined)).toBe(false);
    expect(await connected.captureSources()).toBe("after");
    await connected.assertCurrent(); expect(f.session.assertActivePcb).toHaveBeenLastCalledWith(f.resumed.pcbPath);
    await Promise.all([connected.close(), connected.close()]); expect(f.session.close).toHaveBeenCalledOnce();
    expect(f.createCliAdapter).not.toHaveBeenCalled();
  });

  it("never saves or runs blank Open normalization on authored resume but revalidates netclasses and checkpoint", async () => {
    const f = fixture(); f.preparation.mode = "resumed";
    await openKicadToolboxFreshSession(f.input);
    expect(seams.initialSave).not.toHaveBeenCalled();
    expect(f.session.callTool).not.toHaveBeenCalled();
    expect(seams.checkpoint).not.toHaveBeenCalled();
    expect(f.order).toEqual(["connect", "initialize", "active", "classes", "resume", "active"]);
    expect(seams.lifecycle).toHaveBeenCalledWith({ project: f.resumed, preparation: f.preparation, session: f.session });
  });

  it("rejects unauthenticated preparation before connecting and disposes unused authority", async () => {
    const f = fixture(); seams.authenticate.mockImplementation(() => { throw new Error("Unauthenticated preparation"); });
    await expect(openKicadToolboxFreshSession(f.input)).rejects.toThrow("Unauthenticated");
    expect(f.authority.connect).not.toHaveBeenCalled(); expect(f.authority.disposeUnused).toHaveBeenCalledOnce();
  });

  it("rejects missing or mismatched approved physical footprint before connecting", async () => {
    const f = fixture(); f.resolver.inspectFootprint.mockReturnValue({ libraryId: "Wrong:Part", sourceIdentity: f.sourceIdentity });
    await expect(openKicadToolboxFreshSession(f.input)).rejects.toThrow("physical footprint is unavailable");
    expect(f.authority.connect).not.toHaveBeenCalled(); expect(f.authority.disposeUnused).toHaveBeenCalledOnce();
  });

  it("rejects a different connected authority before initialization", async () => {
    const f = fixture(); f.session.identity.launch.sessionAuthorityIdentity = { authority: "different" };
    await expect(openKicadToolboxFreshSession(f.input)).rejects.toThrow("bound native authority");
    expect(seams.initialize).not.toHaveBeenCalled(); expect(f.session.close).toHaveBeenCalledOnce();
  });

  it.each(["initialize", "initial-save", "normalize", "classes", "resume", "practices"])("closes native session after %s failure without reporting readiness", async stage => {
    const f = fixture();
    const failed = stage === "initialize" ? seams.initialize : stage === "initial-save" ? seams.initialSave : stage === "normalize" ? seams.checkpoint
      : stage === "classes" ? seams.verifyClasses : stage === "resume" ? seams.resume : seams.practices;
    failed.mockRejectedValue(new Error(`${stage} failed`));
    await expect(openKicadToolboxFreshSession(f.input)).rejects.toThrow(`${stage} failed`);
    expect(f.session.close).toHaveBeenCalledOnce(); expect(f.authority.disposeUnused).not.toHaveBeenCalled();
    expect(seams.lifecycle).not.toHaveBeenCalled();
    if (stage === "initialize") expect(f.session.assertActivePcb).not.toHaveBeenCalled();
    if (stage === "initial-save") {
      expect(seams.checkpoint).not.toHaveBeenCalled(); expect(seams.verifyClasses).not.toHaveBeenCalled();
      expect(seams.resume).not.toHaveBeenCalled(); expect(seams.tools).not.toHaveBeenCalled();
    }
    if (stage === "classes") expect(seams.resume).not.toHaveBeenCalled();
  });

  it("retains both startup and teardown errors when cleanup is uncertain", async () => {
    const f = fixture();
    seams.initialize.mockRejectedValue(Object.assign(new Error("startup failure secret"), { code: "ENOENT" }));
    f.session.close.mockRejectedValue(Object.assign(new Error("teardown failure secret"), { code: "EACCES" }));
    const result = await openKicadToolboxFreshSession(f.input).catch(error => error);
    expect(result).toBeInstanceOf(KicadMcpTerminationUncertainError);
    expect(result.retainRuntimeDirectory).toBe(true);
    const diagnostic = captureKicadStartupFailure(result, "host-cleanup");
    expect(diagnostic.failure).toMatchObject({ stage: "session-connect", cause: { code: "ENOENT" } });
    expect(diagnostic.cleanup).toEqual([{ stage: "toolbox-session-cleanup", status: "unconfirmed", cause: { category: "native-error", code: "EACCES" } }]);
    expect(JSON.stringify(result.cause)).not.toContain("secret");
  });

  it("preserves a proxy failure without invoking foreign prototype traps during cleanup", async () => {
    const f = fixture();
    let invoked = 0;
    const proxy = new Proxy({}, { getPrototypeOf: () => { invoked++; throw new Error("foreign trap"); } });
    // Use the real callback boundary; Vitest spies inspect thrown values before
    // the production catch gets them.
    const input = { ...f.input, authority: { ...f.input.authority, connect: async () => { throw proxy; } } };
    const result = await openKicadToolboxFreshSession(input).catch(error => error);
    expect(invoked).toBe(0);
    expect(captureKicadStartupFailure(result, "host-cleanup").failure).toMatchObject({
      stage: "session-connect", cause: { category: "foreign-value" },
    });
    expect(f.session.close).not.toHaveBeenCalled();
    expect(f.authority.disposeUnused).toHaveBeenCalledOnce();
  });
});
