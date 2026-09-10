import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { preparePlaneFreshProject } from "../../src/harness/fresh-project.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle, createPcbPlaneCompilationBundleRef } from "../../src/harness/pcb-design-plane-bundle.js";
import { KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES } from "../../src/harness/kicad-tools.js";
import type { KicadCliAdapter } from "../../src/integrations/kicad-cli.js";
import { createGenericDividerBundleFixture } from "../helpers/generic-divider-bundle.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";

// Native SVG evidence validation has its own tests. Here the mock allows testing
// family dispatch and source preservation without invoking a native executable.
vi.mock("../../src/harness/fresh-schematic-stroke-style.js", async original => ({
  ...await original<typeof import("../../src/harness/fresh-schematic-stroke-style.js")>(),
  assertFreshSchematicStrokeStyleEvidence: vi.fn(),
}));
import { initializeIsolatedKicadProject, createFreshNativeCaptures } from "../../src/cli/pcb-agent.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(`${path.resolve(tmpdir())}${path.sep}`)) throw new Error("Unsafe cleanup");
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const outputDir = await mkdtemp(path.join(tmpdir(), "evleda-plane-shared-")); roots.push(outputDir);
  const { dependencies } = createGenericDividerBundleFixture();
  const bundle = createPcbPlaneCompilationBundle({ originalPrompt: "Plane divider",
    compilation: compilePcbPlaneDesignIntentDraft(planeDividerDraft(), dependencies) }, dependencies);
  const project = await preparePlaneFreshProject({ outputDir, name: "plane-divider", resume: false,
    compilationBundle: bundle, compilationBundleRef: createPcbPlaneCompilationBundleRef(bundle) });
  const executablePath = path.join(outputDir, "host-pinned-fixture.exe");
  const configuration = canonicalIdentity({ fixture: "config" }, "test-config");
  const plainRender = vi.fn();
  const render = vi.fn().mockImplementation(async ({ outputDirectory }: { outputDirectory: string }) => {
    await mkdir(outputDirectory, { recursive: true });
    const svgPath = path.join(outputDirectory, "plane-divider.svg"), source = "<svg/>"; await writeFile(svgPath, source);
    return { sourceIdentities: { schematic: contentIdentity(await readFile(project.schematicPath)),
      pcb: contentIdentity(await readFile(project.pcbPath)),
      projectSettings: contentIdentity(await readFile(path.join(project.projectPath, `${project.name}.kicad_pro`))) },
      schematicSvg: { path: svgPath, sha256: contentIdentity(source).digest, sizeBytes: Buffer.byteLength(source) },
      strokeStyleEvidence: { fixtureOnly: true } };
  });
  const netlist = vi.fn().mockResolvedValue({ source: "fixture netlist" });
  const create = vi.fn().mockImplementation(async () => ({ identity: { path: executablePath },
    captureSchematicConfiguration: vi.fn().mockResolvedValue({ identity: configuration }),
    exportSchematicSvgWithStrokeStyle: render, exportSchematicSvg: plainRender, exportSchematicNetlist: netlist }));
  const captures = createFreshNativeCaptures({ project, executablePath, createAdapter: create as unknown as typeof KicadCliAdapter.create });
  const names = KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES.filter(name =>
    name !== "evleda_get_live_pcb_document" && name !== "evleda_get_live_pcb_pad_snapshot");
  const session = { listTools: () => names.map(name => ({ name, permission: "write" as const, inputSchema: { type: "object" } })),
    callTool: vi.fn().mockResolvedValue({ content: [] }), assertActivePcb: vi.fn(), readActivePcbSource: vi.fn(), readLivePcbPadSnapshot: vi.fn() };
  const prepared = { sourceProjectPath: project.projectPath, isolatedProjectPath: project.projectPath,
    outputPath: outputDir, reportPath: path.join(outputDir, "report.json"), freshProject: project };
  return { project, captures, create, render, plainRender, netlist, session, prepared };
}

describe("plane family shared native helpers", () => {
  it("initializes with genuine plane paths and requires the private pad snapshot port", async () => {
    const f = await fixture();
    expect(f.project.workflowKind).toBe("plane");
    await initializeIsolatedKicadProject(f.session, f.prepared, path.join(f.project.outputPath, "mcp-output"));
    expect(f.session.callTool).toHaveBeenCalledWith("kicad_set_project", expect.objectContaining({
      pcb_file: f.project.pcbPath, sch_file: f.project.schematicPath }));
    const { readLivePcbPadSnapshot: omitted, ...missing } = f.session; void omitted; missing.callTool.mockClear();
    await expect(initializeIsolatedKicadProject(missing, f.prepared, path.join(f.project.outputPath, "mcp-output"))).rejects.toThrow("pad-snapshot port");
    expect(missing.callTool).not.toHaveBeenCalled();
  });
  it("selects source-bound stroke-style capture rather than the legacy plain SVG branch", async () => {
    const f = await fixture();
    expect(f.captures.captureNativeSchematicStrokeStyle).toBeTypeOf("function");
    const expected = contentIdentity(await readFile(f.project.schematicPath));
    await f.captures.captureNativeSchematicStrokeStyle!(expected);
    expect(f.render).toHaveBeenCalledOnce(); expect(f.plainRender).not.toHaveBeenCalled();
    expect(f.render.mock.calls[0]![0]).toMatchObject({ schematicPath: f.project.schematicPath, pcbPath: f.project.pcbPath,
      configuration: { expectedTreeIdentity: expect.objectContaining({ algorithm: "sha256" }) } });
    await f.captures.captureNativeNetlist();
    expect(f.netlist).toHaveBeenCalledWith(expect.objectContaining({ schematicPath: f.project.schematicPath, pcbPath: f.project.pcbPath }));
  });
  it("does not reuse the style capture after plane custom-rule source changes", async () => {
    const f = await fixture(); await f.captures.captureNativeSchematicRender();
    const rules = path.join(f.project.projectPath, `${f.project.name}.kicad_dru`);
    await writeFile(rules, `${await readFile(rules, "utf8")}\n`);
    await f.captures.captureNativeSchematicRender();
    expect(f.create).toHaveBeenCalledTimes(2); expect(f.render).toHaveBeenCalledTimes(2);
  });
  it("rejects stale schematic identity before a native adapter is created", async () => {
    const f = await fixture();
    await expect(f.captures.captureNativeSchematicStrokeStyle!(contentIdentity("obsolete"))).rejects.toThrow("Schematic changed");
    expect(f.create).not.toHaveBeenCalled();
  });
});
