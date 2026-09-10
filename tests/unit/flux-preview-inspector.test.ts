import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalIdentity } from "../../src/core/canonical.js";
import { FluxInspector, FluxInspectorError } from "../../src/flux/inspector.js";
import { FLUX_PREVIEW_WINDOWS_REALIZED_PATH_LIMIT, FluxPreviewRenderer } from "../../src/flux/preview-renderer.js";
import { KicadCliAdapter, type KicadPreviewExportResult } from "../../src/integrations/kicad-cli.js";
import type { BoundedProcessOptions, BoundedProcessResult, BoundedProcessRunner } from "../../src/integrations/bounded-process.js";
import type { KicadMcpSession } from "../../src/integrations/kicad-mcp-session.js";

const temporaryRoots: string[] = [];
const inspectionAuthority = () => ({ runId: "run_inspection", inspectionBridgeIdentity: canonicalIdentity({ bridge: "readonly" }, "evleda.kicad-mcp-inspection-bridge.v2"),
  executionBridgeIdentity: canonicalIdentity({ bridge: "write" }, "evleda.kicad-mcp-execution-bridge.v1"), ipcSocketIdentity: canonicalIdentity({ socket: "run" }, "evleda.kicad-api-socket-binding.v1"),
  writeSessionAuthorityIdentity: canonicalIdentity({ mode: "write" }, "evleda.kicad-mcp-session-authority.v1"), connectionBudget: { used: 1, remaining: 7, limit: 8 as const } });

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

const processResult = (options: BoundedProcessOptions, stdout = ""): BoundedProcessResult => ({
  command: options.command, args: [...options.args], cwd: options.cwd, exitCode: 0,
  stdout, stderr: "", durationMs: 1, startedAt: "2026-09-06T00:00:00.000Z",
});

const help = [
  "--format json --exit-code-violations --severity-all --units --schematic-parity --refill-zones --save-board",
  "--output --fields --labels --group-by --sort-field kicadsexpr --black-and-white --no-background-color",
  "--layers --precision --no-protel-ext --drill-origin --excellon-units --generate-report --side --exclude-dnp",
  "--width --height --quality --preset",
].join(" ");

async function previewFixture(): Promise<{ root: string; project: string; schematic: string; pcb: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "evleda-flux-preview-"));
  temporaryRoots.push(root);
  const project = path.join(root, "project");
  await mkdir(project);
  const schematic = path.join(project, "robot.kicad_sch");
  const pcb = path.join(project, "robot.kicad_pcb");
  await Promise.all([
    writeFile(path.join(project, "robot.kicad_pro"), "{}\n"),
    writeFile(schematic, "(kicad_sch (version 20250114))\n"),
    writeFile(pcb, "(kicad_pcb (version 20250114) (layers (0 \"F.Cu\" signal) (31 \"B.Cu\" signal) (44 \"Edge.Cuts\" user)))\n"),
  ]);
  return { root, project, schematic, pcb };
}

const fakePreviewAdapter = (onExport?: () => void): KicadCliAdapter => ({
  exportPreviewArtifacts: async ({ outputDirectory }: { outputDirectory: string }): Promise<KicadPreviewExportResult> => {
    onExport?.();
    const schematicDirectory = path.join(outputDirectory, "schematic");
    const renderDirectory = path.join(outputDirectory, "renders");
    await Promise.all([mkdir(schematicDirectory), mkdir(renderDirectory)]);
    const definitions = [
      ["schematic/robot.svg", "<svg/>\n"],
      ["renders/board-top.png", "top\n"],
      ["renders/board-bottom.png", "bottom\n"],
    ] as const;
    const artifacts = [];
    for (const [relativePath, body] of definitions) {
      const target = path.join(outputDirectory, relativePath);
      await writeFile(target, body);
      artifacts.push({
        path: target,
        relativePath,
        sizeBytes: Buffer.byteLength(body),
        sha256: createHash("sha256").update(body).digest("hex"),
      });
    }
    return {
      classification: "candidate-preview",
      releaseAuthorized: false,
      executable: {
        kind: "kicad-cli", path: "redacted", version: "10.0.3", commit: "abcdef0",
        sha256: "a".repeat(64), sizeBytes: 1, capabilityHelpSha256: "b".repeat(64), confirmedCapabilities: [],
      },
      outputDirectory,
      sourceHashes: { schematic: "c".repeat(64), pcb: "d".repeat(64) },
      invocations: [],
      artifacts,
    };
  },
} as unknown as KicadCliAdapter);

describe("Flux display bridge", () => {
  it("creates a fresh, path-free three-file preview manifest without manufacturing commands", async () => {
    const design = await previewFixture();
    const previewOutputRoot = path.join(design.root, "preview-output");
    await mkdir(previewOutputRoot);
    const executableBytes = await readFile(process.execPath);
    const invocations: BoundedProcessOptions[] = [];
    const runner: BoundedProcessRunner = async (options) => {
      invocations.push(options);
      if (options.args.length === 1 && options.args[0] === "version") return processResult(options, "10.0.3\n");
      if (options.args.join(" ") === "version --format commit") return processResult(options, "146a4f2a7585c65bc580427a19b6fe2ec4a3f622\n");
      if (options.args.at(-1) === "--help") return processResult(options, help);
      const outputIndex = options.args.indexOf("--output");
      const output = options.args[outputIndex + 1]!;
      if (options.args.slice(0, 3).join(" ") === "sch export svg") {
        await writeFile(path.join(output, "robot.svg"), "<svg/>\n");
      } else {
        await writeFile(output, "PNG\n");
      }
      return processResult(options);
    };
    await expect(KicadCliAdapter.create({ workspaceRoot: design.project, projectRoot: design.project, outputRoot: previewOutputRoot, executablePath: process.execPath,
      expectedExecutableIdentity: { sha256: "0".repeat(64), sizeBytes: executableBytes.byteLength }, runner })).rejects.toThrow(/server-owned content pin/iu);
    expect(invocations).toHaveLength(0);
    const adapter = await KicadCliAdapter.create({ workspaceRoot: design.project, projectRoot: design.project, outputRoot: previewOutputRoot, executablePath: process.execPath,
      expectedExecutableIdentity: { sha256: createHash("sha256").update(executableBytes).digest("hex"), sizeBytes: executableBytes.byteLength }, runner });
    const renderer = new FluxPreviewRenderer({ adapter, workspaceRoot: design.project, projectRoot: design.project, outputRoot: previewOutputRoot, revisionRoot: "preview-revisions" });
    const preview = await renderer.render({ schematicPath: design.schematic, pcbPath: design.pcb });

    expect(preview.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "schematic.svg", mediaType: "image/svg+xml" }),
      expect.objectContaining({ name: "board-top.png", mediaType: "image/png" }),
      expect.objectContaining({ name: "board-bottom.png", mediaType: "image/png" }),
    ]));
    expect(JSON.stringify(preview)).not.toContain(design.root);
    expect(Object.isFrozen(preview)).toBe(true);
    expect(Object.isFrozen(preview.sourceHashes)).toBe(true);
    expect(Object.isFrozen(preview.artifacts[0]!)).toBe(true);
    const commands = invocations.filter((item) => item.args.at(-1) !== "--help").map((item) => item.args.slice(0, 2).join(" "));
    expect(commands).toContain("sch export");
    expect(commands.filter((command) => command === "pcb render")).toHaveLength(2);
    expect(commands.join(" ")).not.toMatch(/\b(?:bom|gerber|drill|pos|netlist)\b/iu);
  });

  it.skipIf(process.platform !== "win32")("accepts a realized revision path at 247 characters and rejects 248 before adapter invocation", async () => {
    const design = await previewFixture();
    const revisionRootName = "r";
    const rendererAt = async (realizedLength: number, onExport: () => void) => {
      const oneCharacterRoot = path.join(design.root, "x", revisionRootName, "revision-XXXXXX");
      const outputSegment = "o".repeat(realizedLength - oneCharacterRoot.length + 1);
      const outputRoot = path.join(design.root, outputSegment);
      await mkdir(outputRoot);
      const renderer = new FluxPreviewRenderer({
        adapter: fakePreviewAdapter(onExport),
        workspaceRoot: design.root,
        projectRoot: design.project,
        outputRoot,
        revisionRoot: revisionRootName,
      });
      return { renderer, realized: path.join(outputRoot, revisionRootName, "revision-XXXXXX") };
    };
    let exports = 0;
    const atLimit = await rendererAt(FLUX_PREVIEW_WINDOWS_REALIZED_PATH_LIMIT, () => { exports += 1; });
    expect(atLimit.realized).toHaveLength(FLUX_PREVIEW_WINDOWS_REALIZED_PATH_LIMIT);
    await expect(atLimit.renderer.renderForRuntime({ schematicPath: design.schematic, pcbPath: design.pcb })).resolves.toBeDefined();
    const overLimit = await rendererAt(FLUX_PREVIEW_WINDOWS_REALIZED_PATH_LIMIT + 1, () => { exports += 1; });
    expect(overLimit.realized).toHaveLength(FLUX_PREVIEW_WINDOWS_REALIZED_PATH_LIMIT + 1);
    await expect(overLimit.renderer.renderForRuntime({ schematicPath: design.schematic, pcbPath: design.pcb }))
      .rejects.toThrow(/path-length budget/iu);
    expect(exports).toBe(1);
  });

  it("recreates a cleaned revision parent after restart and allocates concurrent revisions without touching sources", async () => {
    const design = await previewFixture();
    const sourceBefore = await Promise.all([readFile(design.schematic), readFile(design.pcb)]);
    const options = { adapter: fakePreviewAdapter(), workspaceRoot: design.root, projectRoot: design.project, revisionRoot: "preview-revisions" };
    const first = await new FluxPreviewRenderer(options).renderForRuntime({ schematicPath: design.schematic, pcbPath: design.pcb });
    const revisionRoot = path.join(design.root, "preview-revisions");
    await rm(revisionRoot, { recursive: true, force: true });

    const restarted = new FluxPreviewRenderer(options);
    const [second, third] = await Promise.all([
      restarted.renderForRuntime({ schematicPath: design.schematic, pcbPath: design.pcb }),
      restarted.renderForRuntime({ schematicPath: design.schematic, pcbPath: design.pcb }),
    ]);

    expect(first.root).not.toBe(second.root);
    expect(second.root).not.toBe(third.root);
    expect(new Set((await readdir(revisionRoot)).filter((entry) => entry.startsWith("revision-"))).size).toBe(2);
    expect(second.result.sourceHashes).toEqual(first.result.sourceHashes);
    expect(third.result.sourceHashes).toEqual(first.result.sourceHashes);
    const sourceAfter = await Promise.all([readFile(design.schematic), readFile(design.pcb)]);
    expect(sourceAfter[0].equals(sourceBefore[0])).toBe(true);
    expect(sourceAfter[1].equals(sourceBefore[1])).toBe(true);
  });

  it("leases a shared parent across concurrent renders and removes only a failed operation revision", async () => {
    const design = await previewFixture();
    const revisionRoot = path.join(design.root, "preview-revisions");
    let failingEntered!: () => void;
    let releaseFailure!: () => void;
    const entered = new Promise<void>((resolve) => { failingEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseFailure = resolve; });
    let successfulEntered = false;
    const failingAdapter = {
      exportPreviewArtifacts: async ({ outputDirectory }: { outputDirectory: string }) => {
        await writeFile(path.join(outputDirectory, "partial.txt"), "partial\n");
        failingEntered();
        await release;
        throw new Error("fixture preview failure");
      },
    } as unknown as KicadCliAdapter;
    const successfulAdapter = fakePreviewAdapter(() => { successfulEntered = true; });
    const failing = new FluxPreviewRenderer({ adapter: failingAdapter, workspaceRoot: design.root, projectRoot: design.project, revisionRoot: "preview-revisions" });
    const successful = new FluxPreviewRenderer({ adapter: successfulAdapter, workspaceRoot: design.root, projectRoot: design.project, revisionRoot: "preview-revisions" });

    const failedRender = failing.renderForRuntime({ schematicPath: design.schematic, pcbPath: design.pcb });
    await entered;
    const successfulRender = successful.renderForRuntime({ schematicPath: design.schematic, pcbPath: design.pcb });
    await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
    expect(successfulEntered).toBe(false);
    releaseFailure();
    await expect(failedRender).rejects.toThrow("fixture preview failure");
    const completed = await successfulRender;

    expect(successfulEntered).toBe(true);
    expect(path.dirname(completed.root)).toBe(revisionRoot);
    const revisions = (await readdir(revisionRoot)).filter((entry) => entry.startsWith("revision-"));
    expect(revisions).toEqual([path.basename(completed.root)]);
    expect(await readdir(completed.root)).toEqual(expect.arrayContaining(["schematic.svg", "board-top.png", "board-bottom.png"]));
  });

  it("rejects an in-workspace linked revision parent before invoking the adapter", async () => {
    const design = await previewFixture();
    const actualRevisionRoot = path.join(design.root, "actual-preview-revisions");
    const linkedRevisionRoot = path.join(design.root, "preview-revisions");
    await mkdir(actualRevisionRoot);
    await symlink(actualRevisionRoot, linkedRevisionRoot, process.platform === "win32" ? "junction" : "dir");
    let exports = 0;
    const renderer = new FluxPreviewRenderer({
      adapter: fakePreviewAdapter(() => { exports += 1; }),
      workspaceRoot: design.root,
      projectRoot: design.project,
      revisionRoot: "preview-revisions",
    });

    await expect(renderer.renderForRuntime({ schematicPath: design.schematic, pcbPath: design.pcb }))
      .rejects.toThrow(/link|junction|alias/iu);
    expect(exports).toBe(0);
    expect(await readdir(actualRevisionRoot)).toEqual([]);
  });

  it("only reads the fixed board-inspection tools, returns bounded path-free DTOs, and reports busy state", async () => {
    const calls: string[] = [];
    const fake = {
      identity: { mode: "readonly" },
      callTool: async (name: string) => {
        calls.push(name);
        return { structuredContent: { path: "C:\\secret\\board.kicad_pcb", values: Array.from({ length: 30 }, (_, index) => ({ index })) } };
      },
    } as unknown as KicadMcpSession;
    const inspector = new FluxInspector(fake, inspectionAuthority());
    const states: string[] = [];
    const snapshot = await inspector.inspect((value) => { states.push(value.state); });
    expect(calls).toEqual([
      "pcb_get_board_summary", "pcb_get_design_rules", "pcb_get_footprints",
      "pcb_get_tracks", "pcb_get_vias", "pcb_get_zones",
    ]);
    expect(states).toEqual(["busy", "busy", "busy", "busy", "busy", "busy", "ready"]);
    expect(JSON.stringify(snapshot)).not.toContain("C:\\secret");
    expect(JSON.stringify(snapshot)).not.toContain('"path"');
    expect(snapshot.boardSummary.value).toMatchObject({ values: expect.any(Array) });
  });

  it("rejects a writable session before calling a tool", async () => {
    const fake = { identity: { mode: "write" }, callTool: async () => ({}) } as unknown as KicadMcpSession;
    await expect(new FluxInspector(fake, inspectionAuthority()).inspect()).rejects.toBeInstanceOf(FluxInspectorError);
  });
});
