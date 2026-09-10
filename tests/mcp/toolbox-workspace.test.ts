import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalIdentity, canonicalJson } from "../../src/core/canonical.js";
import { createToolboxWorkspaceStore } from "../../src/mcp/toolbox-workspace-store.js";
import { createKicadToolboxWorkspace, type KicadToolboxWorkspaceOptions } from "../../src/mcp/toolbox-workspace.js";
import type { openFreshNativeToolboxBinding } from "../../src/mcp/toolbox-fresh-main.js";
import type { ConnectedKicadToolbox } from "../../src/mcp/toolbox-session.js";
import { compilePcbDesignIntentDraft } from "../../src/harness/pcb-design-compiler.js";
import { createPcbDesignCompilationBundle, createPcbDesignCompilerProfile } from "../../src/harness/pcb-design-compilation-bundle.js";
import { compilePcbPlaneDesignIntentDraft, normalizePcbPlaneSelectionPolicy } from "../../src/harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { createGenericDividerBundleFixture, genericDividerDraft } from "../helpers/generic-divider-bundle.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";

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
  compilerOptions: Partial<Pick<KicadToolboxWorkspaceOptions, "dependencies" | "deepRuleSelectionOptions">> = {}) {
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
  it("provides idle/schema/library tools without creating files or opening native CAD", async () => {
    const f = await fixture();
    try {
      expect(body(await f.call("evleda_workspace_status"))).toMatchObject({ nativeState: "absent", activeProject: null, pendingDrafts: [] });
      const defaultSchema = body(await f.call("evleda_design_schema"));
      expect(defaultSchema).toMatchObject({ family: "routed-v1", supportedFamilies: ["routed-v1", "plane-v2"],
        schema: { properties: { schemaVersion: { const: "evleda.pcb-design-intent-draft.v1" } } },
        guide: expect.any(String), example: { schemaVersion: "evleda.pcb-design-intent-draft.v1" }, instruction: expect.any(String) });
      expect(body(await f.call("evleda_design_schema", { family: "routed-v1" }))).toEqual(defaultSchema);
      expect(body(await f.call("evleda_design_schema", { family: "plane-v2" }))).toMatchObject({ family: "plane-v2",
        supportedFamilies: ["routed-v1", "plane-v2"],
        schema: { properties: { schemaVersion: { const: "evleda.pcb-design-intent-draft.v2" }, planes: expect.any(Object) } },
        guide: expect.any(String), example: { schemaVersion: "evleda.pcb-design-intent-draft.v2" }, instruction: expect.any(String) });
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
