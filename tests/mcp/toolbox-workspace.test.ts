import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import { createToolboxWorkspaceStore } from "../../src/mcp/toolbox-workspace-store.js";
import { createKicadToolboxWorkspace, type KicadToolboxWorkspaceOptions } from "../../src/mcp/toolbox-workspace.js";
import type { openFreshNativeToolboxBinding } from "../../src/mcp/toolbox-fresh-main.js";
import type { ConnectedKicadToolbox } from "../../src/mcp/toolbox-session.js";
import { compilePcbDesignIntentDraft } from "../../src/harness/pcb-design-compiler.js";
import { createPcbDesignCompilationBundle, createPcbDesignCompilerProfile } from "../../src/harness/pcb-design-compilation-bundle.js";
import { compilePcbPlaneDesignIntentDraft, normalizePcbPlaneSelectionPolicy } from "../../src/harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle, isAuthenticatedPcbPlaneCompilationBundle,
  parsePcbPlaneCompilationBundle, serializePcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { getPcbPlaneDesignIntentModelGuide, PCB_PLANE_DESIGN_INTENT_EXTENDED_MODEL_GUIDE_MAX_UTF8_BYTES } from "../../src/harness/pcb-design-plane-model-guide.js";
import { PCB_INTERFACE_REQUIREMENTS_SCHEMA_VERSION } from "../../src/harness/pcb-interface-requirements.js";
import { createFreshPlaneRules } from "../../src/harness/fresh-plane-rules.js";
import { createFreshConnectivityContract } from "../../src/harness/fresh-connectivity-contract.js";
import { createPcbLibrarySourceSelection } from "../../src/harness/pcb-library-source-binding.js";
import { prepareKicadToolboxPlaneProject, resumeKicadToolboxPlaneProject, assertKicadToolboxPlanePreparation,
  type KicadToolboxPlanePreparation } from "../../src/mcp/toolbox-plane-preparation.js";
import { createPlaneToolboxCheckpointLifecycle } from "../../src/mcp/toolbox-plane-checkpoint.js";
import type { KicadCliAdapter, KicadExecutableIdentity } from "../../src/integrations/kicad-cli.js";
import type { KicadMcpSession } from "../../src/integrations/kicad-mcp-session.js";
import { createGenericDividerBundleFixture, genericDividerDraft } from "../helpers/generic-divider-bundle.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";
import { constructionAssertion, constructionDependencies, interfaceConstructionDraft } from "../helpers/interface-construction-bundle.js";

const roots: string[] = [];
const testOwnedLeases: Array<{ release(): Promise<void> }> = [];
afterEach(async () => {
  // Production intentionally retains uncertain leases. Tests release their own
  // captured capabilities only after asserting retention, so Windows can clean up.
  for (const lease of testOwnedLeases.splice(0)) await lease.release();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const body = (response: { structuredContent?: unknown }) => response.structuredContent as Record<string, any>;
const draftFamilies = [["routed-v1", genericDividerDraft], ["plane-v2", planeDividerDraft]] as const;
async function fixture(access: "read-only" | "edit" = "edit",
  compilerOptions: Partial<Pick<KicadToolboxWorkspaceOptions, "dependencies" | "deepRuleSelectionOptions" | "searchLibrary">> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "toolbox-workspace-mcp-")); roots.push(root);
  const workspaceRoot = path.join(root, "workspace"), fixed = path.join(root, "fixed");
  await Promise.all([mkdir(workspaceRoot), mkdir(fixed)]);
  const filesystemStore = await createToolboxWorkspaceStore({ workspaceRoot, protectedRoots: [fixed] });
  const store = { ...filesystemStore, acquireLease: async (projectId: string) => {
    const lease = await filesystemStore.acquireLease(projectId); testOwnedLeases.push(lease); return lease;
  } };
  const closeNative = vi.fn(async () => {}), publish = vi.fn(async () => {});
  const prepareCheckpoint = vi.fn(async () => publish), recordRecoveryRequired = vi.fn(async () => {});
  const native = { tools: { tools: [{ name: "pcb_get_tracks", description: "Read tracks", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
    execute: vi.fn() }, assertCurrent: vi.fn(async () => {}), captureSources: vi.fn(async () => "saved"),
    prepareCheckpoint, recordRecoveryRequired, close: closeNative } as unknown as ConnectedKicadToolbox;
  const binding = { cad: native, access, compoundContractIdentity: canonicalIdentity({ fixture: true }, "test.contract"), designContext: () => ({ test: "requirements" }) };
  const openBinding = vi.fn<typeof openFreshNativeToolboxBinding>().mockResolvedValue(binding);
  const inspectLibrary = vi.fn((kind: string, libraryId: string) => ({ kind, libraryId, approved: true }));
  const workspace = createKicadToolboxWorkspace({ profile: { path: path.join(fixed, "profile.json"), contentIdentity: { algorithm: "sha256", digest: "a".repeat(64), size: 1 } },
    store, access, dependencies: createGenericDividerBundleFixture().dependencies, ...compilerOptions, inspectLibrary, openBinding });
  const client = new Client({ name: "workspace-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair(); await workspace.server.connect(right); await client.connect(left);
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  const submit = async (name = "divider", draft: unknown = genericDividerDraft()) => body(await call("evleda_submit_design", { name, originalPrompt: "Make this divider", draft }));
  return { root, workspaceRoot, store, workspace, client, call, submit, openBinding, binding, native, inspectLibrary, publish, prepareCheckpoint, recordRecoveryRequired, closeNative,
    close: async () => { await client.close(); await workspace.close(); } };
}

describe("in-chat workspace controller over actual MCP", () => {
  it("exposes bounded read-only catalog discovery only when the host supplies it", async () => {
    const searchLibrary = vi.fn<NonNullable<KicadToolboxWorkspaceOptions["searchLibrary"]>>().mockReturnValue({
      schemaVersion: "evleda.kicad-stock-catalog-search.v1", namespaceAuthority: "host-approved-kicad-10-stock",
      policyIdentity: canonicalIdentity({ fixture: "stock-policy" }, "evleda.kicad-stock-catalog-policy.v1"),
      kind: "symbol", query: "resistor", library: "Device", candidates: [], complete: false, exhausted: false,
      nextCursor: "a".repeat(32), scanned: { sources: 1, candidates: 1, sourceBytes: 32, libraries: 1 },
      totalScanned: { sources: 1, candidates: 1, sourceBytes: 32, libraries: 1 }, totalUnsupportedSources: 0,
      unsupported: [], snapshot: "per-source-read-not-atomic",
    });
    const f = await fixture("read-only", { searchLibrary });
    try {
      const tool = (await f.client.listTools()).tools.find(item => item.name === "evleda_search_library");
      expect(tool?.annotations?.readOnlyHint).toBe(true);
      expect(tool?.annotations?.idempotentHint).toBe(false);
      expect(body(await f.call("evleda_search_library", { kind: "symbol", query: "resistor", library: "Device", limit: 10 })))
        .toMatchObject({ complete: false, exhausted: false, nextCursor: "a".repeat(32) });
      expect(searchLibrary).toHaveBeenCalledExactlyOnceWith({ kind: "symbol", query: "resistor", library: "Device", limit: 10 });
      for (const args of [{ kind: "symbol", query: "r", root: "/other" }, { kind: "symbol", query: "../R" },
        { kind: "symbol", query: "r", limit: 101 }, { kind: "symbol", query: "r", cursor: "fake" }]) {
        expect((await f.call("evleda_search_library", args)).isError).toBe(true);
      }
      expect(searchLibrary).toHaveBeenCalledTimes(1);
      expect(f.openBinding).not.toHaveBeenCalled(); expect((await f.store.list()).total).toBe(0);
    } finally { await f.close(); }
    const exact = await fixture();
    try { expect((await exact.client.listTools()).tools.map(item => item.name)).not.toContain("evleda_search_library"); }
    finally { await exact.close(); }
  });

  it.each(draftFamilies)("rejects %s catalog source drift since ready submission before allocating a project", async (_family, makeDraft) => {
    const base = createGenericDividerBundleFixture().dependencies;
    let sourceRevision = 1;
    const libraryResolver = { ...base.libraryResolver,
      captureSourceSelection: (selected: { symbolIds: readonly string[]; footprintIds: readonly string[] }) => createPcbLibrarySourceSelection({
        policyIdentity: canonicalIdentity({ fixture: "stock-policy" }, "evleda.kicad-stock-catalog-policy.v1"),
        records: [
          ...selected.symbolIds.map(libraryId => ({ kind: "symbol" as const, libraryId,
            sourceIdentity: contentIdentity(Buffer.from(`symbol-source-${sourceRevision}`)),
            inspectionIdentity: canonicalIdentity({ libraryId }, "evleda.kicad-stock-symbol-inspection.v1") })),
          ...selected.footprintIds.map(libraryId => ({ kind: "footprint" as const, libraryId,
            sourceIdentity: contentIdentity(Buffer.from("footprint-source")),
            inspectionIdentity: canonicalIdentity({ libraryId }, "evleda.kicad-stock-footprint-inspection.v2") })),
        ],
      }, selected),
    };
    const f = await fixture("edit", { dependencies: { ...base, libraryResolver } });
    try {
      const ready = await f.submit("source-bound", makeDraft());
      expect(ready.status).toBe("ready");
      expect(ready.compilation.libraryBinding.sourceSelection.records.length).toBeGreaterThan(0);
      sourceRevision++;
      const changed = await f.call("evleda_create_project", { draftId: ready.draftId });
      expect(changed.isError).toBe(true);
      expect(body(changed).error).toContain("Compilation changed since preview");
      expect((await f.store.list()).total).toBe(0); expect(f.openBinding).not.toHaveBeenCalled();
      expect(body(await f.call("evleda_workspace_status")).pendingDrafts).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("provides idle/schema/library tools without creating files or opening native CAD", async () => {
    const f = await fixture();
    try {
      expect(body(await f.call("evleda_workspace_status"))).toMatchObject({ nativeState: "absent", activeProject: null, pendingDrafts: [] });
      const defaultSchema = body(await f.call("evleda_design_schema"));
      expect(defaultSchema).toMatchObject({ family: "routed-v1", supportedFamilies: ["routed-v1", "plane-v2"],
        schema: { properties: { schemaVersion: { const: "evleda.pcb-design-intent-draft.v1" } } },
        guide: expect.any(String), example: { schemaVersion: "evleda.pcb-design-intent-draft.v1" }, instruction: expect.any(String) });
      expect(body(await f.call("evleda_design_schema", { family: "routed-v1" }))).toEqual(defaultSchema);
      const planeSchema = body(await f.call("evleda_design_schema", { family: "plane-v2" }));
      expect(planeSchema).toMatchObject({ family: "plane-v2",
        supportedFamilies: ["routed-v1", "plane-v2"],
        schema: { properties: { schemaVersion: { const: "evleda.pcb-design-intent-draft.v2" }, planes: expect.any(Object), interfaceRequirements: expect.any(Object) } },
        guide: getPcbPlaneDesignIntentModelGuide(true, true, false, true), guideMaxUtf8Bytes: PCB_PLANE_DESIGN_INTENT_EXTENDED_MODEL_GUIDE_MAX_UTF8_BYTES,
        optionalRequirements: { interfaceRequirements: { schemaVersion: PCB_INTERFACE_REQUIREMENTS_SCHEMA_VERSION,
          kinds: ["differential_pair"], sourceAuthority: "caller_asserted_intent", physicalVerification: "not_performed" } },
        example: { schemaVersion: "evleda.pcb-design-intent-draft.v2" }, instruction: expect.any(String) });
      expect(Buffer.byteLength(planeSchema.guide, "utf8")).toBeLessThanOrEqual(20 * 1024);
      expect(planeSchema.schema.required).not.toContain("interfaceRequirements");
      expect(planeSchema.schema.required).not.toContain("externalPowerInputs");
      expect(planeSchema.schema.required).not.toContain("derivedPowerSources");
      expect(planeSchema.optionalRequirements.externalPowerInputs).toMatchObject({ sourceAuthority: "caller_asserted_external_supply", physicalComponentsAdded: false });
      expect(planeSchema.optionalRequirements.derivedPowerSources).toMatchObject({ sourceAuthority: "source_inspected_driver_and_caller_reviewed_path", physicalComponentsAdded: false });
      for (const term of ["Without externalPowerInput", "externalPowerInput={id,diodeForwardDropAssumption,operatingModes}",
        "exact bound external connector supply", "one stock Device:D_Schottky step 2/A to 1/K", "power_in consumer", "same external ground", "not electrical qualification"])
        expect(planeSchema.optionalRequirements.derivedPowerSources.instruction).toContain(term);
      expect(planeSchema.guide).toContain("exactly one stock Device:D_Schottky");
      const channelSchema = body(await f.call("evleda_design_schema", { family: "plane-v2", includeChannel: true }));
      expect(Buffer.byteLength(channelSchema.guide, "utf8")).toBeLessThanOrEqual(channelSchema.guideMaxUtf8Bytes);
      expect(planeSchema.example).not.toHaveProperty("externalPowerInputs");
      expect(planeSchema.example).not.toHaveProperty("derivedPowerSources");
      expect(planeSchema.example).not.toHaveProperty("interfaceRequirements");
      expect(defaultSchema).not.toHaveProperty("optionalRequirements");
      expect((await f.client.listTools()).tools.find(tool => tool.name === "evleda_design_schema")!.description).toContain("interfaceRequirements");
      expect((await f.client.listTools()).tools.find(tool => tool.name === "evleda_design_schema")!.description).toContain("explicit external-input forward Schottky");
      expect((await f.call("evleda_design_schema", { family: "plane-v3" })).isError).toBe(true);
      expect(body(await f.call("evleda_inspect_library", { kind: "symbol", libraryId: "Device:R" })).found).toBe(true);
      expect(f.inspectLibrary).toHaveBeenCalledWith("symbol", "Device:R");
      expect((await f.store.list()).total).toBe(0); expect(f.openBinding).not.toHaveBeenCalled();
      expect((await f.client.listTools()).tools.map(tool => tool.name)).not.toContain("pcb_get_tracks");
    } finally { await f.close(); }
  });

  it.each(["unresolved", "unsupported"])("returns %s draft findings with no project allocation", async mode => {
    const f = await fixture();
    try {
      const base = genericDividerDraft();
      const draft = { ...base, scope: { ...base.scope, board: { ...base.scope.board, ...(mode === "unresolved" ? { widthMm: null } : { shape: "circle" }) } } };
      const result = await f.submit("divider", draft);
      expect(result.status).toBe(mode === "unresolved" ? "needs_clarification" : "unsupported");
      expect(result.projectCreated).toBe(false); expect(result.draftId).toBeUndefined();
      expect((await f.store.list()).total).toBe(0); expect(f.openBinding).not.toHaveBeenCalled();
      expect(await readdir(path.join(f.workspaceRoot, "projects"))).toEqual([]);
    } finally { await f.close(); }
  });

  it("returns V2 plane clarifications without allocating or substituting a V1 contract", async () => {
    const f = await fixture();
    try {
      const draft = planeDividerDraft();
      const incomplete = { ...draft, planes: draft.planes.map(plane => ({ ...plane, clearanceMm: null })) };
      const result = await f.submit("plane", incomplete);
      expect(result).toMatchObject({ status: "needs_clarification", projectCreated: false,
        compilation: { schemaVersion: "evleda.pcb-design-compilation.v2", contract: null, verificationPlan: null,
          questions: expect.arrayContaining([expect.objectContaining({ path: "/planes/GND_PLANE/clearanceMm" })]) } });
      expect(result.draftId).toBeUndefined(); expect(result.bundleIdentity).toBeUndefined();
      expect(body(await f.call("evleda_workspace_status")).pendingDrafts).toEqual([]);
      expect((await f.store.list()).total).toBe(0); expect(f.openBinding).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("returns a keyed external-power clarification before allocating or inventing flags", async () => {
    const f = await fixture();
    try {
      const submitted = await f.submit("power-input", { ...planeDividerDraft(), externalPowerInputs: null });
      expect(submitted).toMatchObject({ status: "needs_clarification", projectCreated: false,
        compilation: { questions: expect.arrayContaining([expect.objectContaining({ path: "/externalPowerInputs" })]) } });
      expect(submitted.draftId).toBeUndefined();
      expect((await f.store.list()).total).toBe(0); expect(f.openBinding).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("returns a keyed interface clarification in chat without issuing a ready ID or opening CAD", async () => {
    const f = await fixture();
    try {
      const draft = interfaceConstructionDraft(); draft.interfaceRequirements.interfaces[0].geometry.maxEtchSkewMm = null;
      const result = await f.submit("pair", draft);
      expect(result).toMatchObject({ status: "needs_clarification", projectCreated: false,
        compilation: { schemaVersion: "evleda.pcb-design-compilation.v2", contract: null,
          questions: expect.arrayContaining([expect.objectContaining({ path: "/interfaceRequirements/interfaces/LINK/geometry/maxEtchSkewMm" })]) } });
      expect(result.draftId).toBeUndefined(); expect(result.bundleIdentity).toBeUndefined();
      expect(body(await f.call("evleda_workspace_status")).pendingDrafts).toEqual([]);
      expect((await f.store.list()).total).toBe(0); expect(f.openBinding).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("keeps a closed interface through ready ID, real preparation/checkpoint and authenticated saved-bundle resume", async () => {
    const f = await fixture("edit", { dependencies: constructionDependencies });
    const identity: KicadExecutableIdentity = { kind: "kicad-cli", path: path.join(f.root, "fixture-kicad-cli.exe"), version: "10.0.3",
      commit: "146a4f2a7585c65bc580427a19b6fe2ec4a3f622", sha256: "a".repeat(64), sizeBytes: 100,
      capabilityHelpSha256: "b".repeat(64), confirmedCapabilities: ["pcb drc"] };
    const expectedKicadCli = { path: identity.path, contentIdentity: { algorithm: "sha256" as const, digest: identity.sha256, size: identity.sizeBytes },
      operationalVersion: identity.version, operationalCommit: identity.commit, peFileVersion: "10.0.3", peProductVersion: "10.0.3",
      identity: canonicalIdentity({ fixture: true }, "evleda.flux-kicad-cli-binding.v1") };
    // Synthetic libraries, the executable probe, and native binding/context adapter
    // are test dependencies. Compilation, allocation, native-file preparation,
    // checkpointing and authenticated saved-bundle resume use production code.
    const createKicadCliAdapter = vi.fn<typeof KicadCliAdapter.create>().mockResolvedValue({ identity } as KicadCliAdapter);
    const preparations: KicadToolboxPlanePreparation[] = [];
    f.openBinding.mockImplementation(async options => {
      const input = { outputDir: options.outputDir, name: options.fresh.name, dependencies: constructionDependencies,
        expectedKicadCli, createKicadCliAdapter };
      const prepared = options.resume ? { status: "prepared" as const, preparation: await resumeKicadToolboxPlaneProject(input) }
        : await prepareKicadToolboxPlaneProject({ ...input, draft: options.fresh.draft, originalPrompt: options.fresh.originalPrompt!,
          expectedBundleIdentity: options.fresh.expectedBundleIdentity! });
      if (prepared.status !== "prepared") throw new Error(`Interface preparation failed: ${JSON.stringify(prepared)}`);
      const preparation = prepared.preparation; assertKicadToolboxPlanePreparation(preparation); preparations.push(preparation);
      const lifecycle = createPlaneToolboxCheckpointLifecycle({ project: preparation.project, preparation,
        session: { readActivePcbSource: async () => readFile(preparation.project.pcbPath, "utf8") } as unknown as KicadMcpSession });
      return { ...f.binding, cad: { ...f.native, ...lifecycle },
        compoundContractIdentity: createFreshConnectivityContract(preparation.bundle.contract).identity,
        designContext: () => ({ family: "plane-v2", contract: preparation.bundle.contract, verificationPlan: preparation.bundle.verificationPlan,
          bundleIdentity: preparation.bundle.identity, resumedFromSavedBundle: options.resume === true, acceptanceEvaluated: false }) };
    });
    let completed = false;
    try {
      const draft = interfaceConstructionDraft();
      draft.interfaceRequirements.interfaces[0].impedance = { mode: "differential", targetOhms: 100, toleranceOhms: 10,
        frequencyHz: 100_000_000, constructionId: "STACK", source: constructionAssertion() };
      const originalDraft = structuredClone(draft), originalPrompt = "Create exactly these supplied differential interface requirements.";
      const ready = body(await f.call("evleda_submit_design", { name: "pair", originalPrompt, draft }));
      const duplicate = body(await f.call("evleda_submit_design", { name: "pair", originalPrompt, draft }));
      expect(ready).toMatchObject({ status: "ready", projectCreated: false,
        compilation: { schemaVersion: "evleda.pcb-design-compilation.v2", contract: { interfaceRequirements: originalDraft.interfaceRequirements },
          acceptanceEvaluated: false, nativeAuthoringPerformed: false } });
      expect(duplicate.draftId).toBe(ready.draftId);
      expect(ready.compilation.verificationPlan.requirements.filter((row: any) => row.kind.startsWith("interface_"))).toHaveLength(5);
      const expectedBundle = createPcbPlaneCompilationBundle({ originalPrompt,
        compilation: compilePcbPlaneDesignIntentDraft(originalDraft, constructionDependencies) }, constructionDependencies);
      expect(ready.bundleIdentity).toEqual(expectedBundle.identity);
      expect((await f.store.list()).total).toBe(0);
      // The ready ID owns the submitted snapshot, not this caller's mutable object.
      draft.interfaceRequirements.interfaces[0].geometry.maxEtchSkewMm = 1;
      expect(body(await f.call("evleda_create_project", { draftId: ready.draftId }))).toMatchObject({ status: "opened", resumed: false });
      const original = preparations[0]!; assertKicadToolboxPlanePreparation(original);
      expect(original.bundle.identity).toEqual(ready.bundleIdentity);
      expect(isAuthenticatedPcbPlaneCompilationBundle(original.bundle)).toBe(true);
      expect(original.bundle.contract.interfaceRequirements).toEqual(originalDraft.interfaceRequirements);
      const stored = (await f.store.lookup(ready.draftId))!;
      expect(await readFile(path.join(stored.inputDir, "draft.json"), "utf8")).toBe(canonicalJson(originalDraft));
      const originalBundleBytes = await readFile(original.bundlePath), originalRulesBytes = await readFile(original.project.rulesPath);
      expect(originalBundleBytes).toEqual(serializePcbPlaneCompilationBundle(expectedBundle));
      const expectedRules = createFreshPlaneRules(expectedBundle);
      expect(originalRulesBytes.toString("utf8")).toBe(expectedRules.source);
      expect(contentIdentity(originalRulesBytes)).toEqual(expectedRules.identity);
      expect(body(await f.call("evleda_design_context"))).toMatchObject({ contract: { interfaceRequirements: originalDraft.interfaceRequirements },
        bundleIdentity: expectedBundle.identity, resumedFromSavedBundle: false });
      const initialCheckpoint = JSON.parse(await readFile(original.project.checkpointPath, "utf8"));
      expect((await f.call("evleda_finish_session")).isError).not.toBe(true);
      const closedCheckpoint = JSON.parse(await readFile(original.project.checkpointPath, "utf8"));
      expect(closedCheckpoint.attempt).toBe(initialCheckpoint.attempt + 1);
      expect(closedCheckpoint).toMatchObject({ schemaVersion: "evleda.pcb-agent-fresh-project-checkpoint.v3", reportStatus: "needs_review" });
      expect((await f.call("evleda_resume_project", { projectId: ready.draftId, draft })).isError).toBe(true);
      expect(body(await f.call("evleda_resume_project", { projectId: ready.draftId }))).toMatchObject({ status: "opened", resumed: true });
      expect(f.openBinding).toHaveBeenCalledTimes(2);
      expect(f.openBinding.mock.calls[1]![0].fresh).toEqual({ name: "pair" });
      const resumed = preparations[1]!; expect(resumed).not.toBe(original); assertKicadToolboxPlanePreparation(resumed);
      expect(() => assertKicadToolboxPlanePreparation({ ...resumed })).toThrow(/authenticated V2/);
      expect(resumed.mode).toBe("resumed"); expect(isAuthenticatedPcbPlaneCompilationBundle(resumed.bundle)).toBe(true);
      expect(resumed.bundle.identity).toEqual(expectedBundle.identity);
      expect(resumed.bundle.contract.interfaceRequirements).toEqual(originalDraft.interfaceRequirements);
      expect(resumed.bundle.verificationPlan).toEqual(expectedBundle.verificationPlan);
      expect(await readFile(resumed.bundlePath)).toEqual(originalBundleBytes);
      expect(await readFile(resumed.project.rulesPath)).toEqual(originalRulesBytes);
      expect(parsePcbPlaneCompilationBundle(await readFile(resumed.bundlePath), constructionDependencies).identity).toEqual(expectedBundle.identity);
      expect(body(await f.call("evleda_design_context"))).toMatchObject({ contract: { interfaceRequirements: originalDraft.interfaceRequirements },
        bundleIdentity: expectedBundle.identity, resumedFromSavedBundle: true, acceptanceEvaluated: false });
      completed = true;
    } finally {
      const cleanup = f.close();
      // A retained-lease cleanup error must not hide the failing persistence assertion.
      if (completed) await cleanup; else await cleanup.catch(() => {});
    }
  });

  it.each([undefined, null, "evleda.pcb-design-intent-draft.v3", "plane-v2"])("rejects unsupported or missing draft schema %s before issuing a ready ID", async schemaVersion => {
    const f = await fixture();
    try {
      const { schemaVersion: _old, ...draft } = planeDividerDraft();
      const response = await f.call("evleda_submit_design", { name: "plane", originalPrompt: "Keep the plane constraints",
        draft: { ...draft, ...(schemaVersion === undefined ? {} : { schemaVersion }) } });
      expect(response.isError).toBe(true);
      expect(body(response).error).toMatch(/Unsupported or missing draft schemaVersion/);
      expect(body(response).draftId).toBeUndefined();
      expect(body(await f.call("evleda_workspace_status")).pendingDrafts).toEqual([]);
      expect((await f.store.list()).total).toBe(0); expect(f.openBinding).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("honors the V2 policy in both preview and create while retaining V1 host dependencies", async () => {
    const base = createGenericDividerBundleFixture();
    const dependencies = { ...base.dependencies, compilerProfile: base.bundle.compilerProfile };
    const policy = { maxRules: 39 };
    const f = await fixture("edit", { dependencies, deepRuleSelectionOptions: policy });
    try {
      const draft = planeDividerDraft();
      const planeDependencies = { libraryResolver: dependencies.libraryResolver, deepRuleCatalog: dependencies.deepRuleCatalog,
        deepRuleSelectionOptions: normalizePcbPlaneSelectionPolicy(policy) };
      const expected = createPcbPlaneCompilationBundle({ originalPrompt: "Make this divider",
        compilation: compilePcbPlaneDesignIntentDraft(draft, planeDependencies) }, planeDependencies);
      const ready = await f.submit("plane", draft);
      expect(ready).toMatchObject({ status: "ready", bundleIdentity: expected.identity,
        compilation: { selectionPolicy: { maxRules: 39 }, contract: { schemaVersion: "evleda.pcb-design-contract.v2" } } });
      expect(body(await f.call("evleda_create_project", { draftId: ready.draftId })).status).toBe("opened");
      expect(f.openBinding.mock.calls[0]![0].fresh.expectedBundleIdentity).toEqual(expected.identity);
    } finally { await f.close(); }
  });

  it("preserves the V1 compiler profile and larger policy range without applying it to V2", async () => {
    const base = createGenericDividerBundleFixture().dependencies;
    const policy = { maxRules: 100 };
    const compilation = compilePcbDesignIntentDraft(genericDividerDraft(), { ...base, deepRuleSelectionOptions: policy });
    expect(compilation.disposition).toBe("ready");
    const compilerProfile = createPcbDesignCompilerProfile(compilation, base.deepRuleCatalog);
    const dependencies = { ...base, compilerProfile };
    const expected = createPcbDesignCompilationBundle({ originalPrompt: "Make this divider", compilation }, dependencies);
    const f = await fixture("edit", { dependencies, deepRuleSelectionOptions: policy });
    try {
      const ready = await f.submit();
      expect(ready).toMatchObject({ status: "ready", bundleIdentity: expected.identity });
      const invalidPlane = await f.call("evleda_submit_design", { name: "plane", originalPrompt: "Make this divider", draft: planeDividerDraft() });
      expect(invalidPlane.isError).toBe(true);
      expect(body(invalidPlane).error).toContain("maxRules");
      expect(body(await f.call("evleda_create_project", { draftId: ready.draftId })).status).toBe("opened");
      expect(f.openBinding.mock.calls[0]![0].fresh.expectedBundleIdentity).toEqual(expected.identity);
    } finally { await f.close(); }
  });

  it("rechecks V2 library identity before allocation and requires a new reviewed ready ID after drift", async () => {
    const base = createGenericDividerBundleFixture().dependencies;
    let changed = false;
    const dependencies = { ...base, libraryResolver: { ...base.libraryResolver, resolveSymbol: (libraryId: string) => {
      const symbol = base.libraryResolver.resolveSymbol(libraryId);
      return !changed || symbol === null ? symbol : { ...symbol, pins: symbol.pins.map(pin => ({ ...pin, function: `${pin.function} revised` })) };
    } } };
    const f = await fixture("edit", { dependencies });
    try {
      const ready = await f.submit("plane", planeDividerDraft()); expect(ready.status).toBe("ready");
      changed = true;
      const create = await f.call("evleda_create_project", { draftId: ready.draftId });
      expect(create.isError).toBe(true); expect(body(create).error).toContain("Compilation changed since preview");
      expect((await f.store.list()).total).toBe(0); expect(f.openBinding).not.toHaveBeenCalled();
      expect(body(await f.call("evleda_workspace_status")).pendingDrafts).toEqual([{ draftId: ready.draftId, name: "plane" }]);
      const revised = await f.submit("plane", planeDividerDraft());
      expect(revised.status).toBe("ready"); expect(revised.draftId).not.toBe(ready.draftId);
      expect(revised.bundleIdentity).not.toEqual(ready.bundleIdentity);
      expect(body(await f.call("evleda_create_project", { draftId: revised.draftId })).status).toBe("opened");
      expect(f.openBinding.mock.calls[0]![0].fresh.expectedBundleIdentity).toEqual(revised.bundleIdentity);
    } finally { await f.close(); }
  });

  it.each(draftFamilies)("%s caches ready IDs, persists exact input, passes previewed bundle identity and opens only once", async (family, makeDraft) => {
    const f = await fixture();
    try {
      const draft = makeDraft();
      const ready = await f.submit("divider", draft), duplicate = await f.submit("divider", draft);
      expect(ready.status).toBe("ready"); expect(duplicate.draftId).toBe(ready.draftId);
      const version = family === "plane-v2" ? "v2" : "v1";
      expect(ready.compilation.schemaVersion).toBe(`evleda.pcb-design-compilation.${version}`);
      expect(ready.compilation.contract.schemaVersion).toBe(`evleda.pcb-design-contract.${version}`);
      expect(ready.bundleIdentity.schemaVersion).toBe(`evleda.pcb-design-compilation-bundle.${version}`);
      if (family === "plane-v2") {
        expect(ready.compilation.verificationPlan.requirements).toEqual(expect.arrayContaining([
          expect.objectContaining({ kind: "plane_connectivity" }), expect.objectContaining({ kind: "reference_path" }),
        ]));
        expect(ready.compilation.acceptancePlan).toBeUndefined();
        expect(ready.compilation.acceptanceEvaluated).toBe(false);
      }
      expect((await f.store.list()).total).toBe(0);
      const created = await f.call("evleda_create_project", { draftId: ready.draftId });
      expect(body(created)).toMatchObject({ status: "opened", projectId: ready.draftId, resumed: false });
      const stored = (await f.store.lookup(ready.draftId))!;
      expect(await readFile(path.join(stored.inputDir, "draft.json"), "utf8")).toBe(canonicalJson(draft));
      expect(f.openBinding).toHaveBeenCalledWith(expect.objectContaining({ projectDir: stored.inputDir, outputDir: stored.outputDir, resume: false,
        fresh: { name: "divider", draft, originalPrompt: "Make this divider", expectedBundleIdentity: ready.bundleIdentity } }));
      expect((await f.client.listTools()).tools.map(tool => tool.name)).toContain("pcb_get_tracks");
      expect(body(await f.call("evleda_create_project", { draftId: ready.draftId }))).toMatchObject({ status: "already_created", active: true });
      expect(f.openBinding).toHaveBeenCalledOnce();
      await expect(f.store.acquireLease(ready.draftId)).rejects.toMatchObject({ code: "LEASE_HELD" });
    } finally { await f.close(); }
  });

  it.each(draftFamilies)("%s denies read-only creation before allocation or native opening", async (_family, makeDraft) => {
    const f = await fixture("read-only");
    try {
      const ready = await f.submit("divider", makeDraft()); expect(ready.status).toBe("ready");
      expect((await f.call("evleda_create_project", { draftId: ready.draftId })).isError).toBe(true);
      expect((await f.store.list()).total).toBe(0); expect(f.openBinding).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it.each(draftFamilies)("%s native finish publishes checkpoint, releases lease and resumes only from saved project identity", async (_family, makeDraft) => {
    const f = await fixture();
    try {
      const ready = await f.submit("divider", makeDraft()); await f.call("evleda_create_project", { draftId: ready.draftId });
      expect((await f.call("evleda_finish_session")).isError).not.toBe(true);
      expect(f.publish).toHaveBeenCalledOnce();
      expect(body(await f.call("evleda_workspace_status"))).toMatchObject({ activeProject: null, nativeState: "closed" });
      const lease = await f.store.acquireLease(ready.draftId); await lease.release();
      expect((await f.call("evleda_resume_project", { projectId: ready.draftId, draft: genericDividerDraft() })).isError).toBe(true);
      expect((await f.call("evleda_resume_project", { projectId: ready.draftId, originalPrompt: "replacement" })).isError).toBe(true);
      expect(body(await f.call("evleda_resume_project", { projectId: ready.draftId }))).toMatchObject({ status: "opened", resumed: true });
      expect(f.openBinding).toHaveBeenCalledTimes(2);
      expect(f.openBinding.mock.calls[1]![0]).toMatchObject({ resume: true, fresh: { name: "divider" } });
      expect(Object.keys(f.openBinding.mock.calls[1]![0].fresh)).toEqual(["name"]);
    } finally { await f.close(); }
  });

  it("serializes concurrent different-draft creates into one active native binding", async () => {
    const f = await fixture();
    try {
      const first = await f.submit("first"), second = await f.submit("second");
      const results = await Promise.all([f.call("evleda_create_project", { draftId: first.draftId }), f.call("evleda_create_project", { draftId: second.draftId })]);
      expect(results.filter(result => result.isError === true)).toHaveLength(1);
      expect(results.filter(result => result.isError !== true)).toHaveLength(1);
      expect(f.openBinding).toHaveBeenCalledOnce(); expect((await f.store.list()).total).toBe(1);
    } finally { await f.close(); }
  });

  it("retains a V2 allocation after uncertain native startup and a create retry never opens it again", async () => {
    const f = await fixture();
    const ready = await f.submit("plane", planeDividerDraft());
    f.openBinding.mockRejectedValue(new Error("native startup unconfirmed"));
    const create = await f.call("evleda_create_project", { draftId: ready.draftId });
    expect(create.isError).toBe(true);
    expect(body(await f.call("evleda_create_project", { draftId: ready.draftId }))).toMatchObject({ status: "already_created", active: false });
    expect((await f.call("evleda_resume_project", { projectId: ready.draftId })).isError).toBe(true);
    expect(body(await f.call("evleda_workspace_status"))).toMatchObject({ activeProject: { projectId: ready.draftId, phase: "needs-review" } });
    expect(f.openBinding).toHaveBeenCalledOnce(); expect((await f.store.list()).total).toBe(1);
    await expect(f.store.acquireLease(ready.draftId)).rejects.toMatchObject({ code: "LEASE_HELD" });
    await f.client.close(); await expect(f.workspace.close()).rejects.toThrow("lease was retained");
  });

  it.each(["checkpoint", "close"])("retains lease and reconciles stale active status after %s failure in native finish", async stage => {
    const f = await fixture(); const ready = await f.submit(); await f.call("evleda_create_project", { draftId: ready.draftId });
    if (stage === "checkpoint") f.publish.mockRejectedValue(new Error("checkpoint publication failed"));
    else f.closeNative.mockRejectedValue(new Error("native close unconfirmed"));
    const finish = await f.call("evleda_finish_session"); expect(finish.isError).toBe(true);
    const status = body(await f.call("evleda_workspace_status"));
    expect(status).toMatchObject({ nativeState: "uncertain", activeProject: { projectId: ready.draftId, phase: "needs-review" } });
    expect((await f.call("evleda_resume_project", { projectId: ready.draftId })).isError).toBe(true);
    expect(body(await f.call("evleda_create_project", { draftId: ready.draftId }))).toMatchObject({ status: "already_created", active: false });
    await expect(f.store.acquireLease(ready.draftId)).rejects.toMatchObject({ code: "LEASE_HELD" });
    expect(f.recordRecoveryRequired).toHaveBeenCalled();
    await f.client.close(); await expect(f.workspace.close()).rejects.toThrow();
  });

  it("rejects a non-checkpoint-capable host binding and retains its lease for review", async () => {
    const f = await fixture(); delete f.native.prepareCheckpoint;
    const ready = await f.submit(); expect((await f.call("evleda_create_project", { draftId: ready.draftId })).isError).toBe(true);
    expect(body(await f.call("evleda_workspace_status"))).toMatchObject({ activeProject: { phase: "needs-review" } });
    await expect(f.store.acquireLease(ready.draftId)).rejects.toMatchObject({ code: "LEASE_HELD" });
    expect(f.closeNative).toHaveBeenCalledOnce();
    await f.client.close(); await expect(f.workspace.close()).rejects.toThrow("lease was retained");
  });

  it("waits for opening on disconnect and then finishes and releases the resulting native session", async () => {
    const f = await fixture(); const ready = await f.submit();
    let opened!: (value: typeof f.binding) => void;
    let bindingRequested!: () => void;
    const requested = new Promise<void>(resolve => { bindingRequested = resolve; });
    f.openBinding.mockImplementation(() => {
      bindingRequested();
      return new Promise(resolve => { opened = resolve; });
    });
    const create = f.call("evleda_create_project", { draftId: ready.draftId }).catch(error => error);
    await Promise.race([requested, create.then(() => { throw new Error("Creation completed before requesting the native binding."); })]);
    expect(f.openBinding).toHaveBeenCalledOnce();
    await f.client.close();
    let closed = false; const closing = f.workspace.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve)); expect(closed).toBe(false); expect(f.closeNative).not.toHaveBeenCalled();
    opened(f.binding); await create; await closing;
    expect(f.publish).toHaveBeenCalledOnce(); expect(f.closeNative).toHaveBeenCalledOnce();
    const lease = await f.store.acquireLease(ready.draftId); await lease.release();
  });
});
