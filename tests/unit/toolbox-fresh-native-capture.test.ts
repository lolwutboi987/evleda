import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { prepareFreshProject } from "../../src/harness/fresh-project.js";
import type { KicadCliAdapter } from "../../src/integrations/kicad-cli.js";
import { createGenericDividerBundleFixture } from "../helpers/generic-divider-bundle.js";

// Native style evidence is tested independently; these tests exercise the host
// collector's revision, cache, configuration and output-preservation checks.
vi.mock("../../src/harness/fresh-schematic-stroke-style.js", async (original) => ({
  ...await original<typeof import("../../src/harness/fresh-schematic-stroke-style.js")>(),
  assertFreshSchematicStrokeStyleEvidence: vi.fn(),
}));
import { createFreshNativeCaptures } from "../../src/cli/pcb-agent.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const outputDir = await mkdtemp(path.join(tmpdir(), "evleda-native-capture-")); roots.push(outputDir);
  const { bundle, reference } = createGenericDividerBundleFixture();
  const project = await prepareFreshProject({ outputDir, name: "divider", resume: false, workflowKind: "generic",
    compilationBundle: bundle, compilationBundleRef: reference });
  const executablePath = path.join(outputDir, "host-pinned-kicad-cli.exe");
  const configuration = canonicalIdentity({ fixture: "config" }, "test-config");
  const captureConfiguration = vi.fn().mockResolvedValue({ identity: configuration });
  const render = vi.fn().mockImplementation(async ({ outputDirectory }: { outputDirectory: string }) => {
    await mkdir(outputDirectory, { recursive: true });
    const svgPath = path.join(outputDirectory, "divider.svg");
    const source = "<svg/>"; await writeFile(svgPath, source);
    return { sourceIdentities: { schematic: contentIdentity(await readFile(project.schematicPath)),
      pcb: contentIdentity(await readFile(project.pcbPath)),
      projectSettings: contentIdentity(await readFile(path.join(project.projectPath, "divider.kicad_pro"))) },
      schematicSvg: { path: svgPath, sha256: contentIdentity(source).digest, sizeBytes: Buffer.byteLength(source) },
      strokeStyleEvidence: { synthetic: true } };
  });
  const netlist = vi.fn().mockImplementation(async ({ outputDirectory }: { outputDirectory: string }) => {
    await mkdir(outputDirectory, { recursive: true }); await writeFile(path.join(outputDirectory, "netlist.xml"), "fixture");
    return { source: await readFile(project.schematicPath, "utf8") };
  });
  const create = vi.fn().mockImplementation(async () => ({ identity: { path: executablePath },
    captureSchematicConfiguration: captureConfiguration, exportSchematicSvgWithStrokeStyle: render,
    exportSchematicNetlist: netlist }));
  const captures = createFreshNativeCaptures({ project, executablePath, createAdapter: create as unknown as typeof KicadCliAdapter.create });
  return { project, create, captures, render, netlist, captureConfiguration };
}

describe("shared fresh native collectors", () => {
  it("reuses a source-bound render and recreates the adapter after source revision changes", async () => {
    const f = await fixture();
    const first = await f.captures.captureNativeSchematicRender();
    expect(await f.captures.captureNativeSchematicRender()).toBe(first);
    expect(f.create).toHaveBeenCalledTimes(1); expect(f.render).toHaveBeenCalledTimes(1);
    await writeFile(f.project.schematicPath, `${await readFile(f.project.schematicPath, "utf8")}\n`);
    await f.captures.captureNativeSchematicRender();
    expect(f.create).toHaveBeenCalledTimes(2); expect(f.render).toHaveBeenCalledTimes(2);
  });

  it("rejects configuration drift before cached render reuse", async () => {
    const f = await fixture(); await f.captures.captureNativeSchematicRender();
    f.captureConfiguration.mockResolvedValue({ identity: canonicalIdentity({ fixture: "changed" }, "test-config") });
    await expect(f.captures.captureNativeSchematicRender()).rejects.toThrow("configuration changed");
  });

  it("rejects cached SVG byte drift", async () => {
    const f = await fixture(); const first = await f.captures.captureNativeSchematicRender();
    await writeFile(first.schematicSvg.path, "<modified/>");
    await expect(f.captures.captureNativeSchematicRender()).rejects.toThrow("SVG changed");
  });

  it("rejects an obsolete schematic identity before invoking any native adapter", async () => {
    const f = await fixture();
    await expect(f.captures.captureNativeSchematicStrokeStyle!(contentIdentity("obsolete"))).rejects.toThrow("Schematic changed");
    expect(f.create).not.toHaveBeenCalled();
  });

  it("rejects source changes during native rendering before caching the result", async () => {
    const f = await fixture();
    f.render.mockImplementationOnce(async () => {
      await writeFile(f.project.schematicPath, "changed during native render");
      return {};
    });
    await expect(f.captures.captureNativeSchematicRender()).rejects.toThrow("exact current design-source triple");
  });

  it("creates netlist adapters per collection and removes their private output after success and failure", async () => {
    const f = await fixture(); await f.captures.captureNativeNetlist(); await f.captures.captureNativeNetlist();
    expect(f.create).toHaveBeenCalledTimes(2);
    for (const [request] of f.netlist.mock.calls) await expect(access(request.outputDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    f.netlist.mockImplementationOnce(async ({ outputDirectory }: { outputDirectory: string }) => {
      await mkdir(outputDirectory, { recursive: true }); throw new Error("native failed");
    });
    await expect(f.captures.captureNativeNetlist()).rejects.toThrow("native failed");
    await expect(access(f.netlist.mock.calls[2]![0].outputDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
