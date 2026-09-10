import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeIsolatedKicadProject } from "../../src/cli/pcb-agent.js";
import { prepareFreshProject } from "../../src/harness/fresh-project.js";
import { KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES } from "../../src/harness/kicad-tools.js";
import { createGenericDividerBundleFixture } from "../helpers/generic-divider-bundle.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const outputDir = await mkdtemp(path.join(tmpdir(), "evleda-fresh-init-")); roots.push(outputDir);
  const { bundle, reference } = createGenericDividerBundleFixture();
  const freshProject = await prepareFreshProject({ outputDir, name: "divider", workflowKind: "generic", resume: false,
    compilationBundle: bundle, compilationBundleRef: reference });
  const prepared = { sourceProjectPath: freshProject.projectPath, isolatedProjectPath: freshProject.projectPath,
    outputPath: outputDir, reportPath: path.join(outputDir, "report.json"), freshProject };
  const names = KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES.filter(name =>
    name !== "evleda_get_live_pcb_document" && name !== "evleda_get_live_pcb_pad_snapshot");
  const session = { listTools: () => names.map(name => ({ name, permission: "write" as const, inputSchema: { type: "object" } })),
    callTool: vi.fn().mockResolvedValue({ content: [] }), assertActivePcb: vi.fn(), readActivePcbSource: vi.fn(),
    readLivePcbPadSnapshot: vi.fn() };
  return { prepared, session, output: path.join(outputDir, ".evleda-mcp-output") };
}

describe("generic fresh host initialization", () => {
  it("accepts authenticated private ports absent from the public descriptor catalog", async () => {
    const f = await fixture();
    expect(f.session.listTools().some(tool => String(tool.name) === "evleda_get_live_pcb_pad_snapshot")).toBe(false);
    await initializeIsolatedKicadProject(f.session, f.prepared, f.output);
    expect(f.session.callTool).toHaveBeenCalledWith("kicad_set_project", expect.objectContaining({ pcb_file: f.prepared.freshProject.pcbPath }));
    expect(f.session.readLivePcbPadSnapshot).not.toHaveBeenCalled();
  });

  it("rejects a missing private pad port before project binding", async () => {
    const f = await fixture(); const { readLivePcbPadSnapshot: _privatePort, ...session } = f.session;
    await expect(initializeIsolatedKicadProject(session, f.prepared, f.output)).rejects.toThrow("private native PCB pad-snapshot port");
    expect(session.callTool).not.toHaveBeenCalled();
  });

  it("still rejects a missing public required tool", async () => {
    const f = await fixture(); const session = { ...f.session, listTools: () => f.session.listTools().filter(tool => tool.name !== "sch_add_symbol") };
    await expect(initializeIsolatedKicadProject(session, f.prepared, f.output)).rejects.toThrow("sch_add_symbol");
    expect(session.callTool).not.toHaveBeenCalled();
  });
});
