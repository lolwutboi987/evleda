import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalIdentity } from "../../src/core/canonical.js";
import { createKicadToolboxWorkspace } from "../../src/mcp/toolbox-workspace.js";
import type { openFreshNativeToolboxBinding } from "../../src/mcp/toolbox-fresh-main.js";
import type { ConnectedKicadToolbox } from "../../src/mcp/toolbox-session.js";
import { resumeKicadToolboxPlaneProject } from "../../src/mcp/toolbox-plane-preparation.js";
import { captureClosedPlanePlacementRevisionSource } from "../../src/mcp/toolbox-placement-revision.js";
import { placementRevisionFixture } from "../helpers/placement-revision-fixture.js";

const owned: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of owned.splice(0)) { await f.client.close(); await f.workspace.close(); await f.f.cleanup(); } });
const body = (response: { structuredContent?: unknown }) => response.structuredContent as Record<string, any>;
async function fixture(access: "read-only" | "edit" = "edit") {
  const h = await placementRevisionFixture();
  await writeFile(h.preparation.project.pcbPath, h.input.sources.pcb);
  await writeFile(h.preparation.project.schematicPath, h.input.sources.sch);
  await writeFile(path.join(h.preparation.project.projectPath, "seeded.kicad_pro"), h.input.sources.pro);
  await h.preparation.project.checkpointAfterReport(h.preparation.reportPath, "needs_review");
  const openBinding = vi.fn<typeof openFreshNativeToolboxBinding>(async options => {
    const preparation = options.resume && options.outputDir === h.sourceAllocation.outputDir ? h.preparation
      : options.resume ? await resumeKicadToolboxPlaneProject({ outputDir: options.outputDir, name: options.fresh.name,
        dependencies: h.f.dependencies, expectedKicadCli: h.f.expectedKicadCli, createKicadCliAdapter: h.f.createKicadCliAdapter,
        ...(options.fresh.placementRevisionLineage === undefined ? {} : { placementRevisionLineage: options.fresh.placementRevisionLineage }) })
      : await h.f.prepare(options.outputDir, options.fresh.draft as typeof h.revised, { originalPrompt: options.fresh.originalPrompt!,
        ...(options.fresh.placementSeed === undefined ? {} : { placementSeed: options.fresh.placementSeed }),
        ...(options.fresh.placementRevisionLineage === undefined ? {} : { placementRevisionLineage: options.fresh.placementRevisionLineage }) });
    const cad = { tools: { tools: [], execute: vi.fn() }, assertCurrent: async () => {}, captureSources: async () => "fixture-saved",
      prepareCheckpoint: async () => async () => { await preparation.project.checkpointAfterReport(preparation.reportPath, "needs_review"); },
      recordRecoveryRequired: async () => {}, close: async () => {} } as unknown as ConnectedKicadToolbox;
    return { cad, access, compoundContractIdentity: canonicalIdentity({ fixture: "placement-revision" }, "test.contract"),
      designContext: () => ({ bundleIdentity: preparation.bundle.identity }),
      captureClosedPlacementRevisionSource: () => captureClosedPlanePlacementRevisionSource({ project: preparation.project,
        bundle: preparation.bundle, profile: h.f.profile, dependencies: h.f.dependencies, symbolRoot: h.f.symbolRoot }) };
  });
  const workspace = createKicadToolboxWorkspace({ profile: h.f.profile, store: h.f.store, dependencies: h.f.dependencies, access, openBinding });
  const client = new Client({ name: "placement-revision-test", version: "1" }), [left, right] = InMemoryTransport.createLinkedPair();
  await workspace.server.connect(right); await client.connect(left);
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  const submit = async (draft: unknown = h.revised) => body(await call("evleda_submit_design", { name: "seeded", draft, originalPrompt: h.target.originalPrompt }));
  const closeSource = async () => {
    expect(body(await call("evleda_resume_project", { projectId: h.sourceAllocation.projectId })).status).toBe("opened");
    expect(body(await call("evleda_close_project", { projectId: h.sourceAllocation.projectId })).status).toBe("closed");
  };
  return { ...h, workspace, client, call, submit, closeSource, openBinding };
}

describe("placement revision through public MCP", () => {
  it("retains source files, creates a distinct project, replays creation and resumes with its stored lineage", async () => {
    const f = await fixture(); owned.push(f);
    const before = await readFile(f.preparation.project.pcbPath);
    await f.closeSource();
    const ready = await f.submit(); expect(ready.status).toBe("ready");
    const request = { draftId: ready.draftId, sourceProjectId: f.sourceAllocation.projectId };
    const opened = await f.call("evleda_revise_placement", request);
    expect(opened.isError).not.toBe(true); expect(body(opened)).toMatchObject({ status: "opened", resumed: false,
      placementRevisionLineage: { sourceProjectId: f.sourceAllocation.projectId, targetProjectId: ready.draftId } });
    expect((await f.f.store.list()).total).toBe(2);
    expect(body(await f.call("evleda_revise_placement", request))).toMatchObject({ status: "already_created", active: true });
    expect((await f.call("evleda_create_project", { draftId: ready.draftId })).isError).toBe(true);
    expect(body(await f.call("evleda_close_project", { projectId: ready.draftId })).status).toBe("closed");
    expect(body(await f.call("evleda_resume_project", { projectId: ready.draftId }))).toMatchObject({ status: "opened", resumed: true });
    expect(f.openBinding.mock.calls.at(-1)![0].fresh.placementRevisionLineage).toEqual(body(opened).placementRevisionLineage);
    expect(body(await f.call("evleda_close_project", { projectId: ready.draftId })).status).toBe("closed");
    expect(await readFile(f.preparation.project.pcbPath)).toEqual(before);
  });

  it.each(["not-closed", "read-only", "circuit-change", "source-drift"])("rejects %s before creating a target", async reason => {
    const f = await fixture(reason === "read-only" ? "read-only" : "edit"); owned.push(f);
    if (reason !== "not-closed" && reason !== "read-only") await f.closeSource();
    const revised = structuredClone(f.revised);
    if (reason === "circuit-change") revised.components[1]!.value += " changed";
    const ready = await f.submit(revised); expect(ready.status).toBe("ready");
    if (reason === "source-drift") await writeFile(f.preparation.project.pcbPath, f.input.sources.pcb + "\n");
    expect((await f.call("evleda_revise_placement", { draftId: ready.draftId, sourceProjectId: f.sourceAllocation.projectId })).isError).toBe(true);
    expect((await f.f.store.list()).total).toBe(1);
    expect((await f.call("evleda_revise_placement", { draftId: ready.draftId, sourceProjectId: f.sourceAllocation.projectId, sourcePath: "/arbitrary" })).isError).toBe(true);
  });
});
