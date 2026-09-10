import { mkdir, mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { KicadCliAdapter } from "../../src/integrations/kicad-cli.js";
import type { BoundedProcessOptions, BoundedProcessResult } from "../../src/integrations/bounded-process.js";
import { createToolboxPreview } from "../../src/mcp/toolbox-preview.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const help = "--format json --exit-code-violations --severity-all --units --schematic-parity --refill-zones --save-board --output --fields --labels --group-by --sort-field kicadsexpr --black-and-white --no-background-color --layers --precision --no-protel-ext --drill-origin --excellon-units --generate-report --side --exclude-dnp --width --height --quality --preset";
async function fixture() {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "toolbox-preview-")); roots.push(workspaceRoot);
  const projectRoot = path.join(workspaceRoot, "project"); const outputRoot = path.join(workspaceRoot, "renders");
  await Promise.all([mkdir(projectRoot), mkdir(outputRoot)]);
  const pcbPath = path.join(projectRoot, "board.kicad_pcb"); const schematicPath = path.join(projectRoot, "board.kicad_sch");
  const executablePath = path.join(workspaceRoot, "fake-cli.exe"); const executable = Buffer.from("fake executable never launched");
  await Promise.all([writeFile(executablePath, executable), writeFile(pcbPath, '(kicad_pcb (version 20260206))'),
    writeFile(schematicPath, '(kicad_sch (version 20250316))'), writeFile(path.join(projectRoot, "board.kicad_pro"), "{}")]);
  const nativeExport = vi.fn(async (options: BoundedProcessOptions) => {
    await writeFile(options.args[options.args.indexOf("--output") + 1]!, '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10" viewBox="0 0 20 10"><path d="M0 0 L10 5"/></svg>');
  });
  const runner = vi.fn(async (options: BoundedProcessOptions): Promise<BoundedProcessResult> => {
    let stdout = "";
    if (options.args[0] === "version") stdout = options.args.length === 1 ? "10.0.3" : "146a4f2a7585c65bc580427a19b6fe2ec4a3f622";
    else if (options.args.at(-1) === "--help") stdout = help;
    else await nativeExport(options);
    return { command: options.command, args: [...options.args], cwd: options.cwd, exitCode: 0, stdout, stderr: "", durationMs: 1, startedAt: "2026-09-09T00:00:00Z" };
  });
  const identity = contentIdentity(executable);
  const adapterOptions = { workspaceRoot, projectRoot, outputRoot, executablePath, environment: {}, runner,
    expectedExecutableIdentity: { sha256: identity.digest, sizeBytes: identity.size } };
  const preview = createToolboxPreview({ pcbPath, schematicPath, adapterOptions, createAdapter: KicadCliAdapter.create });
  return { preview, pcbPath, schematicPath, nativeExport, runner, adapterOptions };
}

describe("host-bound native PCB SVG previews", () => {
  it("renders native A4 millimetre dimensions within the bounded input/output size", async () => {
    const f = await fixture();
    f.nativeExport.mockImplementation(async options => {
      await writeFile(options.args[options.args.indexOf("--output") + 1]!, '<svg xmlns="http://www.w3.org/2000/svg" width="297.0022mm" height="210.0072mm" viewBox="0 0 297.0022 210.0072"><path d="M10 10 L100 100"/></svg>');
    });
    const preview = await f.preview("top");
    expect(preview.png.width).toBe(1800);
    expect(preview.png.height).toBeGreaterThan(1200);
    expect(preview.png.height).toBeLessThanOrEqual(1400);
    expect(preview.png.identity.size).toBeLessThanOrEqual(4 * 1024 * 1024);
  });

  it("isolates child home/config/cache/temp in a fresh sibling without changing process environment", async () => {
    const f = await fixture(); const originalEnvironment = { ...process.env };
    const first = await f.preview("top"); const second = await f.preview("assembly");
    const firstEnvironment = f.nativeExport.mock.calls[0]![0].env;
    const secondEnvironment = f.nativeExport.mock.calls[1]![0].env;
    const stateRoot = path.dirname(firstEnvironment.HOME!);
    expect(path.dirname(stateRoot)).toBe(path.dirname(path.dirname(first.pcbSvg.path)));
    expect(path.basename(stateRoot)).toMatch(/^\.pcb-svg-state-/u);
    expect(stateRoot).not.toBe(path.dirname(first.pcbSvg.path));
    for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "KICAD_CONFIG_HOME", "KICAD_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
      const value = firstEnvironment[key]!;
      expect(path.relative(stateRoot, value).startsWith("..")).toBe(false);
      expect((await stat(value)).isDirectory()).toBe(true);
      expect(secondEnvironment[key]).not.toBe(value);
    }
    expect(firstEnvironment.USERPROFILE).toBe(firstEnvironment.HOME);
    expect(firstEnvironment.TEMP).toBe(firstEnvironment.TMP);
    expect(second.pcbSvg.path).not.toBe(first.pcbSvg.path);
    expect(process.env).toEqual(originalEnvironment);
  });
  it.each(["top", "assembly"] as const)("exports exact %s SVG bytes with preserved source hashes", async view => {
    const f = await fixture(); const before = await readFile(f.pcbPath); const result = await f.preview(view);
    expect(result.sourceHashes["board.kicad_pcb"]).toBe(contentIdentity(before).digest);
    expect(await readFile(f.pcbPath)).toEqual(before);
    expect(contentIdentity(Buffer.from(result.source)).digest).toBe(result.pcbSvg.sha256);
    expect(result.mimeType).toBe("image/svg+xml"); expect(result.releaseAuthorized).toBe(false);
    const command = f.nativeExport.mock.calls[0]![0].args;
    expect(command.slice(0, 3)).toEqual(["pcb", "export", "svg"]);
    expect(command[command.indexOf("--layers") + 1]).toBe(view === "top" ? "F.Cu,F.Silkscreen,Edge.Cuts" : "F.Fab,F.Silkscreen,Edge.Cuts");
    expect(command.includes("--sketch-pads-on-fab-layers")).toBe(view === "assembly");
    expect(command[command.indexOf("--page-size-mode") + 1]).toBe("1");
    expect(command[command.indexOf("--scale") + 1]).toBe("0");
    expect(command).not.toContain("--fit-page-to-board");
    expect(command.at(-1)).toBe(f.pcbPath);
    expect(result.resourceUri).toContain(result.pcbSvg.sha256);
    const png = await readFile(result.png.path);
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.toString("base64")).toBe(result.png.data);
    expect(contentIdentity(png)).toEqual(result.png.identity);
    expect(result.png.sourceSvgSha256).toBe(result.pcbSvg.sha256);
    expect(result.png.width).toBe(1800); expect(result.png.height).toBe(900);
  });

  it("freshly binds current saved source on each request and uses unique output locations", async () => {
    const f = await fixture(); const first = await f.preview("top");
    await writeFile(f.pcbPath, `${await readFile(f.pcbPath, "utf8")}\n`);
    const second = await f.preview("top");
    expect(second.sourceHashes["board.kicad_pcb"]).not.toBe(first.sourceHashes["board.kicad_pcb"]);
    expect(second.pcbSvg.path).not.toBe(first.pcbSvg.path);
  });

  it.each([false, true])("rejects source mutation even when exporter throws=%s", async fail => {
    const f = await fixture(); f.nativeExport.mockImplementation(async () => {
      await writeFile(f.pcbPath, "changed source"); if (fail) throw new Error("export failed");
    });
    await expect(f.preview("top")).rejects.toThrow(/mutat|chang/i);
  });

  it("rejects executable pin drift before any process probe", async () => {
    const f = await fixture(); await writeFile(f.adapterOptions.executablePath, "changed executable");
    await expect(f.preview("top")).rejects.toThrow("content pin"); expect(f.runner).not.toHaveBeenCalled();
  });

  it("rejects invalid views and missing SVG output", async () => {
    const f = await fixture(); await expect(f.preview("other" as "top")).rejects.toThrow("view"); expect(f.runner).not.toHaveBeenCalled();
    f.nativeExport.mockImplementation(async () => undefined);
    await expect(f.preview("top")).rejects.toThrow("matching artifact");
  });
});
