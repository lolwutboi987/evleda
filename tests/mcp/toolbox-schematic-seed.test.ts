import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKicadToolboxWorkspace } from "../../src/mcp/toolbox-workspace.js";
import { createPlaneToolboxCheckpointLifecycle } from "../../src/mcp/toolbox-plane-checkpoint.js";
import { resumeKicadToolboxPlaneProject, type KicadToolboxPlanePreparation } from "../../src/mcp/toolbox-plane-preparation.js";
import { captureClosedPlaneSchematicSeedSource } from "../../src/mcp/toolbox-schematic-seed.js";
import { createFreshConnectivityContract } from "../../src/harness/fresh-connectivity-contract.js";
import { createInterfaceConstructionBoardSeed } from "../../src/harness/interface-construction-seed.js";
import { parseFreshPcbSource } from "../../src/harness/fresh-kicad-parser.js";
import type { openFreshNativeToolboxBinding } from "../../src/mcp/toolbox-fresh-main.js";
import type { ConnectedKicadToolbox } from "../../src/mcp/toolbox-session.js";
import type { KicadMcpSession } from "../../src/integrations/kicad-mcp-session.js";
import { unwiredPlaneSeedFixture, unwiredPlaneSeedGeometryDraft } from "../helpers/unwired-plane-seed.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";

const fixtures: Awaited<ReturnType<typeof unwiredPlaneSeedFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });
const body = (response: { structuredContent?: unknown }) => response.structuredContent as Record<string, any>;
async function fixture() {
  const f = await unwiredPlaneSeedFixture(); fixtures.push(f);
  const preparations: KicadToolboxPlanePreparation[] = [], nativeCloses = vi.fn(async () => {});
  let beforeReturn: ((preparation: KicadToolboxPlanePreparation, seeded: boolean) => Promise<void>) | undefined;
  let failRecovery = false;
  const openBinding = vi.fn<typeof openFreshNativeToolboxBinding>().mockImplementation(async input => {
    const preparation = input.resume ? await resumeKicadToolboxPlaneProject({ outputDir: input.outputDir, name: input.fresh.name,
      dependencies: f.dependencies, expectedKicadCli: f.expectedKicadCli, createKicadCliAdapter: f.createKicadCliAdapter })
      : await f.prepare(input.outputDir, input.fresh.draft as ReturnType<typeof planeDividerDraft>, {
        originalPrompt: input.fresh.originalPrompt!, expectedBundleIdentity: input.fresh.expectedBundleIdentity!,
        ...(input.fresh.schematicSeed === undefined ? {} : { schematicSeed: input.fresh.schematicSeed }) });
    preparations.push(preparation);
    const lifecycle = createPlaneToolboxCheckpointLifecycle({ project: preparation.project, preparation,
      session: { readActivePcbSource: async () => readFile(preparation.project.pcbPath, "utf8") } as unknown as KicadMcpSession });
    const cad = { tools: { tools: [{ name: "pcb_get_tracks", description: "Read fixture tracks", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
      execute: vi.fn() }, assertCurrent: async () => {}, captureSources: async () => "saved", ...lifecycle,
      recordRecoveryRequired: async (reason: string) => { if (failRecovery) throw new Error("test recovery write failed"); await lifecycle.recordRecoveryRequired(reason); },
      close: nativeCloses } as unknown as ConnectedKicadToolbox;
    await beforeReturn?.(preparation, input.fresh.schematicSeed !== undefined);
    return { cad, access: "edit", compoundContractIdentity: createFreshConnectivityContract(preparation.bundle.contract).identity,
      designContext: () => ({ family: "plane-v2", contract: preparation.bundle.contract }),
      captureClosedSchematicSeedSource: () => captureClosedPlaneSchematicSeedSource({ project: preparation.project, bundle: preparation.bundle,
        dependencies: f.dependencies, profile: f.profile, symbolRoot: f.symbolRoot }) };
  });
  const connect = async () => {
    const workspace = createKicadToolboxWorkspace({ store: f.store, profile: f.profile, dependencies: f.dependencies, access: "edit", openBinding });
    const client = new Client({ name: "seed-workspace-test", version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair(); await workspace.server.connect(right); await client.connect(left);
    const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
    const submit = async (revised = false, sourceDraft = planeDividerDraft()) => { const draft = structuredClone(sourceDraft); if (revised) draft.placementConstraints[1]!.regionMm.maxYmm -= 0.01;
      return body(await call("evleda_submit_design", { name: "seeded", originalPrompt: revised ? "Reviewed revised placement" : "Synthetic unwired seed test", draft })); };
    return { client, call, submit, workspace, close: async () => { await client.close(); await workspace.close(); } };
  };
  const c = await connect();
  const authoredSource = async (draft = planeDividerDraft()) => {
    const ready = await c.submit(false, draft); expect(ready.status).toBe("ready");
    expect(body(await c.call("evleda_create_project", { draftId: ready.draftId })).status).toBe("opened");
    const source = preparations.at(-1)!, bytes = f.source(source.bundle);
    await writeFile(source.project.schematicPath, bytes);
    return { ready, source, bytes };
  };
  return { ...f, c, connect, preparations, openBinding, nativeCloses, authoredSource,
    setBeforeReturn: (hook: typeof beforeReturn) => { beforeReturn = hook; }, failRecovery: () => { failRecovery = true; } };
}

describe("same-connection unwired schematic seed over real MCP", () => {
  it("submits, creates, closes and resumes a 22 x 51 target with new hole poses and the exact closed 21 x 51 source schematic", async () => {
    const f = await fixture();
    try {
      const source = await f.authoredSource(unwiredPlaneSeedGeometryDraft());
      expect((await f.c.call("evleda_close_project", { projectId: source.ready.draftId })).isError).not.toBe(true);
      const sourcePaths = [source.source.project.schematicPath, source.source.project.pcbPath, source.source.project.markerPath,
        source.source.project.checkpointPath, source.source.reportPath, path.join(source.source.project.outputPath, "toolbox-design-bundle.json")];
      const before = await Promise.all(sourcePaths.map(file => readFile(file))), revised = unwiredPlaneSeedGeometryDraft(22, 51);
      Object.assign(revised.boardFeatures[0]!.pose, { xMm: 4, yMm: 4, rotationDeg: 90 });
      Object.assign(revised.boardFeatures[1]!.pose, { xMm: 19, yMm: 47, rotationDeg: 180 });
      const ready = await f.c.submit(false, revised);
      expect(ready.status).toBe("ready");
      const created = await f.c.call("evleda_create_project", { draftId: ready.draftId, sourceProjectId: source.ready.draftId });
      expect(created.isError, JSON.stringify(body(created))).not.toBe(true);
      expect(body(created)).toMatchObject({ status: "opened", projectId: ready.draftId,
        schematicSeedLineage: { sourceProjectId: source.ready.draftId, targetProjectId: ready.draftId } });
      const target = f.preparations.at(-1)!, pcb = await readFile(target.project.pcbPath, "utf8");
      expect(target.project.pcbPath).not.toBe(source.source.project.pcbPath);
      expect(await readFile(target.project.schematicPath, "utf8")).toBe(source.bytes);
      expect(pcb).toBe(createInterfaceConstructionBoardSeed(target.bundle));
      expect(parseFreshPcbSource(pcb)).toMatchObject({ footprints: [], segments: [], vias: [], zoneNetNames: [] });
      expect(target.bundle.identity).not.toEqual(source.source.bundle.identity);
      expect(target.bundle.contract.scope.board).toMatchObject({ widthMm: 22, heightMm: 51 });
      expect(target.bundle.contract.boardFeatures).toEqual(revised.boardFeatures);
      expect((await f.c.call("evleda_close_project", { projectId: ready.draftId })).isError).not.toBe(true);
      expect(body(await f.c.call("evleda_resume_project", { projectId: ready.draftId }))).toMatchObject({ status: "opened", resumed: true });
      const resumed = f.preparations.at(-1)!;
      expect(await readFile(resumed.project.schematicPath, "utf8")).toBe(source.bytes);
      expect(await readFile(resumed.project.pcbPath, "utf8")).toBe(pcb);
      expect(resumed.bundle.contract.boardFeatures).toEqual(revised.boardFeatures);
      expect(source.source.bundle.contract.scope.board).toMatchObject({ widthMm: 21, heightMm: 51 });
      expect(await Promise.all(sourcePaths.map(file => readFile(file)))).toEqual(before);
    } finally { await f.c.close(); }
  });

  it("requires successful close, holds the source lease through issuance, binds retry selection and resumes exact seeded bytes", async () => {
    const f = await fixture();
    try {
      const source = await f.authoredSource(), target = await f.c.submit(true);
      for (const extra of [{ sourcePath: "untrusted" }, { sourceBytes: "untrusted" }, { lineage: {} }]) {
        expect((await f.c.call("evleda_create_project", { draftId: target.draftId, sourceProjectId: source.ready.draftId, ...extra })).isError).toBe(true);
      }
      expect((await f.c.call("evleda_create_project", { draftId: target.draftId, sourceProjectId: source.ready.draftId })).isError).toBe(true);
      expect((await f.c.call("evleda_close_project", { projectId: source.ready.draftId })).isError).not.toBe(true);
      expect((await f.c.call("evleda_create_project", { draftId: target.draftId, sourceProjectId: randomUUID() })).isError).toBe(true);
      expect((await f.store.list()).total).toBe(1);
      const sourceCheckpoint = await readFile(source.source.project.checkpointPath);
      f.setBeforeReturn(async (_preparation, seeded) => { if (seeded) await expect(f.store.acquireLease(source.ready.draftId)).rejects.toMatchObject({ code: "LEASE_HELD" }); });
      const created = await f.c.call("evleda_create_project", { draftId: target.draftId, sourceProjectId: source.ready.draftId });
      expect(created.isError, JSON.stringify(body(created))).not.toBe(true);
      expect(body(created)).toMatchObject({ status: "opened", projectId: target.draftId, schematicSeedLineage: { sourceProjectId: source.ready.draftId } });
      const releasedSourceLease = await f.store.acquireLease(source.ready.draftId); await releasedSourceLease.release();
      const targetPreparation = f.preparations.at(-1)!;
      expect(await readFile(targetPreparation.project.schematicPath, "utf8")).toBe(source.bytes);
      expect(body(await f.c.call("evleda_design_context")).schematicSeedLineage.sourceProjectId).toBe(source.ready.draftId);
      expect(body(await f.c.call("evleda_create_project", { draftId: target.draftId, sourceProjectId: source.ready.draftId }))).toMatchObject({ status: "already_created", active: true });
      expect((await f.c.call("evleda_create_project", { draftId: target.draftId })).isError).toBe(true);
      expect(f.openBinding).toHaveBeenCalledTimes(2);
      expect(await readFile(source.source.project.schematicPath, "utf8")).toBe(source.bytes);
      expect(await readFile(source.source.project.checkpointPath)).toEqual(sourceCheckpoint);
      expect((await f.c.call("evleda_close_project", { projectId: target.draftId })).isError).not.toBe(true);
      expect(body(await f.c.call("evleda_resume_project", { projectId: target.draftId }))).toMatchObject({ status: "opened", resumed: true });
      expect(await readFile(f.preparations.at(-1)!.project.schematicPath, "utf8")).toBe(source.bytes);
    } finally { await f.c.close(); }
  });

  it("rejects source lease replacement before attaching destination tools", async () => {
    const f = await fixture(); let original: Buffer | undefined, leasePath: string | undefined;
    try {
      const source = await f.authoredSource(); expect((await f.c.call("evleda_close_project", { projectId: source.ready.draftId })).isError).not.toBe(true);
      const target = await f.c.submit(true);
      leasePath = path.join(f.workspaceRoot, "projects", source.ready.draftId, ".toolbox-lease.json");
      f.setBeforeReturn(async (_prepared, seeded) => { if (seeded) { original = await readFile(leasePath!); await writeFile(leasePath!, "replaced lease nonce"); } });
      expect((await f.c.call("evleda_create_project", { draftId: target.draftId, sourceProjectId: source.ready.draftId })).isError).toBe(true);
      expect(body(await f.c.call("evleda_workspace_status"))).toMatchObject({ nativeState: "absent", activeProject: { projectId: target.draftId, phase: "needs-review" } });
      expect((await f.c.client.listTools()).tools.some(tool => tool.name === "pcb_get_tracks")).toBe(false);
      expect(f.nativeCloses).toHaveBeenCalledTimes(2);
    } finally {
      if (original !== undefined && leasePath !== undefined) await writeFile(leasePath, original);
      await expect(f.c.close()).rejects.toThrow(/retained/);
    }
  });

  it("does not reconstruct a close receipt in a new connection until ordinary resume and successful close", async () => {
    const f = await fixture();
    const source = await f.authoredSource();
    expect((await f.c.call("evleda_close_project", { projectId: source.ready.draftId })).isError).not.toBe(true); await f.c.close();
    const next = await f.connect();
    try {
      const target = await next.submit(true);
      const first = await next.call("evleda_create_project", { draftId: target.draftId, sourceProjectId: source.ready.draftId });
      expect(first.isError).toBe(true); expect(body(first).error).toMatch(/current workspace connection/);
      expect((await f.store.list()).total).toBe(1);
      expect((await next.call("evleda_resume_project", { projectId: source.ready.draftId })).isError).not.toBe(true);
      expect((await next.call("evleda_close_project", { projectId: source.ready.draftId })).isError).not.toBe(true);
      expect((await next.call("evleda_create_project", { draftId: target.draftId, sourceProjectId: source.ready.draftId })).isError).not.toBe(true);
    } finally { await next.close(); }
  });

  it.each([false, true])("never attaches a destination after source drift during open; close attempted even if recovery write fails=%s", async failRecovery => {
    const f = await fixture();
    try {
      const source = await f.authoredSource(); expect((await f.c.call("evleda_close_project", { projectId: source.ready.draftId })).isError).not.toBe(true);
      const target = await f.c.submit(true);
      if (failRecovery) f.failRecovery();
      f.setBeforeReturn(async (_prepared, seeded) => { if (seeded) await writeFile(source.source.project.schematicPath, source.bytes + "\n"); });
      const failed = await f.c.call("evleda_create_project", { draftId: target.draftId, sourceProjectId: source.ready.draftId });
      expect(failed.isError).toBe(true); expect(body(failed).error).toMatch(/retained for review/);
      expect(body(await f.c.call("evleda_workspace_status"))).toMatchObject({ nativeState: "absent", activeProject: { projectId: target.draftId, phase: "needs-review" } });
      expect((await f.c.client.listTools()).tools.some(tool => tool.name === "pcb_get_tracks")).toBe(false);
      expect(f.nativeCloses).toHaveBeenCalledTimes(2);
      expect((await f.store.list()).total).toBe(2);
      await expect(f.store.acquireLease(source.ready.draftId)).rejects.toMatchObject({ code: "LEASE_HELD" });
      await expect(f.store.acquireLease(target.draftId)).rejects.toMatchObject({ code: "LEASE_HELD" });
      expect(body(await f.c.call("evleda_create_project", { draftId: target.draftId, sourceProjectId: source.ready.draftId }))).toMatchObject({ status: "already_created", active: false });
    } finally { await expect(f.c.close()).rejects.toThrow(/retained/); }
  });
});
