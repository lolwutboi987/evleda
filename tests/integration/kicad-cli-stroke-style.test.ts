import { existsSync } from "node:fs";
import { appendFile, copyFile, link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { assertFreshSchematicStrokeStyleEvidence, FRESH_SCHEMATIC_STROKE_NATIVE_PROFILE } from "../../src/harness/fresh-schematic-stroke-style.js";
import { KicadCliAdapter, KicadCliInvocationError, KicadSchematicConfigurationError, KicadSourceMutationError } from "../../src/integrations/kicad-cli.js";
import { ProcessTimeoutError, type BoundedProcessOptions, type BoundedProcessResult, type BoundedProcessRunner } from "../../src/integrations/bounded-process.js";

// The production pin is never overridden. These files are copied/read, never executed.
const executable = process.env.EVLEDA_TEST_APPROVED_KICAD_CLI;
const available = executable !== undefined && existsSync(executable) && existsSync(path.join(path.dirname(executable), "_eeschema.dll"));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const help = "--format json --exit-code-violations --severity-all --units --schematic-parity --refill-zones --save-board --output --fields --labels --group-by --sort-field kicadsexpr --black-and-white --no-background-color --layers --precision --no-protel-ext --drill-origin --excellon-units --generate-report --side --exclude-dnp --width --height --quality --preset";
const result = (options: BoundedProcessOptions, extra: Partial<BoundedProcessResult> = {}): BoundedProcessResult => ({ command: options.command, args: [...options.args], cwd: options.cwd, exitCode: 0, stdout: "", stderr: "", durationMs: 1, startedAt: "2026-09-09T00:00:00.000Z", ...extra });
const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M1 1 L2 1" stroke-width="0.1524"/></svg>\r\n';
interface Fixture {
  root: string; project: string; schematic: string; pcb: string; config: string; cache: string; output: string; exe: string; engine: string;
  adapter: KicadCliAdapter; calls: BoundedProcessOptions[]; options: Parameters<KicadCliAdapter["exportSchematicSvgWithStrokeStyle"]>[0];
}
async function fixture(effect?: (call: BoundedProcessOptions, value: Omit<Fixture, "adapter" | "options">) => Promise<BoundedProcessResult | void>, version = "10.0.3"): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "evleda-style-capture-")); roots.push(root);
  const project = path.join(root, "project"); const config = path.join(root, "config"); const cache = path.join(root, "cache"); const bin = path.join(root, "bin");
  await Promise.all([mkdir(project), mkdir(path.join(config, "10.0", "colors"), { recursive: true }), mkdir(path.join(cache, "KiCad", "10.0"), { recursive: true }), mkdir(bin)]);
  const schematic = path.join(project, "fixture.kicad_sch"); const pcb = path.join(project, "fixture.kicad_pcb"); const exe = path.join(bin, "kicad-cli.exe"); const engine = path.join(bin, "_eeschema.dll");
  await Promise.all([copyFile(executable!, exe), copyFile(path.join(path.dirname(executable!), "_eeschema.dll"), engine),
    writeFile(schematic, '(kicad_sch (version 20250114))\n'), writeFile(pcb, '(kicad_pcb (version 20250114))\n'),
    writeFile(path.join(project, "fixture.kicad_pro"), '{"schematic":{"drawing":{"default_line_thickness":17}}}\n'),
    writeFile(path.join(config, "10.0", "eeschema.json"), '{"meta":{"version":3},"drawing":{"default_line_thickness":9}}\n'),
    writeFile(path.join(config, "10.0", "kicad_common.json"), '{"api":{"enable_server":false}}\n')]);
  const value = { root, project, schematic, pcb, config, cache, output: path.join(root, "svg"), exe, engine, calls: [] as BoundedProcessOptions[] };
  const runner: BoundedProcessRunner = async (call) => {
    if (call.args.join(" ") === "version") return result(call, { stdout: version });
    if (call.args.join(" ") === "version --format commit") return result(call, { stdout: "146a4f2a7585c65bc580427a19b6fe2ec4a3f622" });
    if (call.args.at(-1) === "--help") return result(call, { stdout: help });
    value.calls.push(call); const output = call.args[call.args.indexOf("--output") + 1]!;
    await writeFile(path.join(output, "fixture.svg"), svg); return await effect?.(call, value) ?? result(call);
  };
  const adapter = await KicadCliAdapter.create({ workspaceRoot: root, projectRoot: project, executablePath: exe, runner, environment: {
    SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, KICAD_CONFIG_HOME: "C:/ambient/config", USERPROFILE: "C:/ambient/home", APPDATA: "C:/ambient/appdata", LOCALAPPDATA: "C:/ambient/local", TEMP: "C:/ambient/temp", TMP: "C:/ambient/tmp", PATH: "C:/ambient/bin", PATHEXT: ".MALICIOUS", OPENAI_API_KEY: "do-not-forward", KICAD10_SYMBOL_DIR: "D:/pinned/symbols",
  } });
  const snapshot = await adapter.captureSchematicConfiguration(config);
  return { ...value, adapter, options: { schematicPath: schematic, pcbPath: pcb, outputDirectory: value.output, configuration: { configHome: config, cacheHome: cache, expectedTreeIdentity: snapshot.identity } } };
}

describe.skipIf(!available)("approved native-shaped stroke capture with a fake bounded runner", () => {
  it("binds exact sources, argv, approved binaries and stable isolated config without assuming drawing defaults", async () => {
    const value = await fixture(async (_call, source) => { await writeFile(path.join(source.project, "fixture.kicad_prl"), '{"local":true}\n'); });
    const before = await value.adapter.captureSchematicConfiguration(value.config);
    const captured = await value.adapter.exportSchematicSvgWithStrokeStyle(value.options);
    expect(value.calls).toHaveLength(1); expect(value.calls[0]!.args).toEqual(["sch", "export", "svg", "--output", value.output, "--black-and-white", "--exclude-drawing-sheet", "--no-background-color", value.schematic]);
    expect(before.directories).toEqual([".", "10.0", "10.0/colors"]);
    expect(captured.strokeStyleCapture.configuration).toMatchObject({ isolation: "caller-owned-isolated", configHome: value.config, treeBefore: before.identity, treeAfter: before.identity });
    expect(captured.strokeStyleEvidence).toMatchObject({ applicationDefaultLineThicknessMils: 9, projectDefaultLineThicknessMils: 17, minimumPlotStrokeWidthMm: 0.0847,
      executableIdentity: FRESH_SCHEMATIC_STROKE_NATIVE_PROFILE.executable, schematicEngineIdentity: FRESH_SCHEMATIC_STROKE_NATIVE_PROFILE.schematicEngine, configurationTreeIdentity: before.identity, nativeSvgIdentity: contentIdentity(svg) });
    expect(captured.strokeStyleEvidence.symbolDefaultStrokeWidthMm).toBeCloseTo(0.1524, 12);
    expect(captured.sourceIdentities).toEqual({ schematic: contentIdentity(await readFile(value.schematic)), pcb: contentIdentity(await readFile(value.pcb)), projectSettings: contentIdentity(await readFile(path.join(value.project, "fixture.kicad_pro"))) });
    expect(captured.localPreferences).toEqual({ relativePath: "fixture.kicad_prl", before: null, after: contentIdentity('{"local":true}\n') });
    expect(() => assertFreshSchematicStrokeStyleEvidence(captured.strokeStyleEvidence, captured.sourceIdentities.schematic)).not.toThrow();
    expect(() => assertFreshSchematicStrokeStyleEvidence(structuredClone(captured.strokeStyleEvidence), captured.sourceIdentities.schematic)).toThrow();
    expect(captured.strokeStyleEvidence.invocationIdentity).toEqual(canonicalIdentity(captured.invocation, "evleda.kicad-schematic-svg-invocation.v1"));
    expect(captured.strokeStyleCapture.render).not.toHaveProperty("strokeStyleEvidence");
    expect(await value.adapter.captureSchematicConfiguration(value.config)).toEqual(before);
  });

  it("uses only explicit owned config/cache/scratch locations for the SVG process", async () => {
    const value = await fixture(); await value.adapter.exportSchematicSvgWithStrokeStyle(value.options);
    const environment = value.calls[0]!.env;
    expect(environment.KICAD_CONFIG_HOME).toBe(value.config);
    for (const name of ["KICAD_CACHE_HOME", "XDG_CACHE_HOME", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]) expect(environment[name]).toBe(value.cache);
    expect(environment).not.toHaveProperty("OPENAI_API_KEY"); expect(environment).not.toHaveProperty("PATH"); expect(environment).not.toHaveProperty("PATHEXT");
    expect(environment.KICAD10_SYMBOL_DIR).toBe("D:/pinned/symbols"); expect(JSON.stringify(environment)).not.toContain("ambient");
  });

  it("keeps ordinary SVG export historical shape without minting stroke evidence", async () => {
    const value = await fixture(); const exported = await value.adapter.exportSchematicSvg(value.options);
    expect(exported).not.toHaveProperty("strokeStyleEvidence"); expect(exported).not.toHaveProperty("strokeStyleCapture"); expect(exported).not.toHaveProperty("localPreferences");
    expect(exported.source).toBe(svg);
  });

  it.each(["before", "during"] as const)("rejects linked cache descendants %s export", async (when) => {
    const addLink = async (source: Pick<Fixture, "root" | "cache">): Promise<void> => {
      const ownedTarget = path.join(source.root, "other-private-cache"); await mkdir(ownedTarget);
      await symlink(ownedTarget, path.join(source.cache, "KiCad", "10.0", "linked-cache"), "junction");
    };
    const value = await fixture(when === "during" ? async (_call, source) => { await addLink(source); } : undefined);
    if (when === "before") await addLink(value);
    await expect(value.adapter.exportSchematicSvgWithStrokeStyle(value.options)).rejects.toMatchObject({ code: when === "before" ? "INVALID_CONFIGURATION" : "CONFIGURATION_DRIFT" });
    expect(value.calls).toHaveLength(when === "before" ? 0 : 1);
  });

  it.each(["before", "during"] as const)("rejects multiply linked cache files %s export", async (when) => {
    const addLink = async (source: Pick<Fixture, "root" | "cache">): Promise<void> => {
      const ownedTarget = path.join(source.root, "private-cache-entry"); await writeFile(ownedTarget, "cache");
      await link(ownedTarget, path.join(source.cache, "KiCad", "10.0", "entry"));
    };
    const value = await fixture(when === "during" ? async (_call, source) => { await addLink(source); } : undefined);
    if (when === "before") await addLink(value);
    await expect(value.adapter.exportSchematicSvgWithStrokeStyle(value.options)).rejects.toMatchObject({ code: when === "before" ? "INVALID_CONFIGURATION" : "CONFIGURATION_DRIFT" });
    expect(value.calls).toHaveLength(when === "before" ? 0 : 1);
  });

  it("accepts ordinary native cache changes and repeat reuse including empty and dot files", async () => {
    const value = await fixture(async (_call, source) => {
      const nativeCache = path.join(source.cache, ".cache", "KiCad native"); await mkdir(nativeCache, { recursive: true });
      await writeFile(path.join(nativeCache, "font.cache"), `generation ${source.calls.length}`);
      await writeFile(path.join(nativeCache, ".lock"), "");
      const scratch = path.join(source.cache, "scratch"); await writeFile(scratch, "temporary"); await rm(scratch);
    });
    await value.adapter.exportSchematicSvgWithStrokeStyle(value.options);
    const second = await value.adapter.exportSchematicSvgWithStrokeStyle({ ...value.options, outputDirectory: path.join(value.root, "second-svg") });
    expect(value.calls).toHaveLength(2);
    expect(await readFile(path.join(value.cache, ".cache", "KiCad native", "font.cache"), "utf8")).toBe("generation 2");
    expect(second.strokeStyleEvidence).toBeDefined();
  });

  it("bounds cache traversal depth before dispatch", async () => {
    const value = await fixture(); await mkdir(path.join(value.cache, ...Array<string>(33).fill("nested")), { recursive: true });
    await expect(value.adapter.exportSchematicSvgWithStrokeStyle(value.options)).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    expect(value.calls).toHaveLength(0);
  });

  it.each(["missing", "changed", "empty-directory-added"] as const)("rejects %s admitted configuration before native dispatch", async (kind) => {
    const value = await fixture(); const application = path.join(value.config, "10.0", "eeschema.json");
    if (kind === "missing") await rm(application); else if (kind === "changed") await appendFile(application, " "); else await mkdir(path.join(value.config, "extra"));
    await expect(value.adapter.exportSchematicSvgWithStrokeStyle(value.options)).rejects.toThrow(); expect(value.calls).toHaveLength(0);
  });

  it.each(["file", "directory", "replacement"] as const)("rejects configuration %s drift during export", async (kind) => {
    const value = await fixture(async (_call, source) => {
      if (kind === "file") await appendFile(path.join(source.config, "10.0", "eeschema.json"), " ");
      else if (kind === "directory") await mkdir(path.join(source.config, "new-directory"));
      else { const file = path.join(source.config, "10.0", "eeschema.json"); const bytes = await readFile(file); await rename(file, `${file}.old`); await writeFile(file, bytes); await rm(`${file}.old`); }
    });
    await expect(value.adapter.exportSchematicSvgWithStrokeStyle(value.options)).rejects.toMatchObject({ code: "CONFIGURATION_DRIFT" }); expect(value.calls).toHaveLength(1);
  });

  it.each(["outside", "project", "overlapping-output", "linked-directory", "hardlinked-file"] as const)("rejects %s config authority", async (kind) => {
    const value = await fixture(); let configHome = value.config;
    if (kind === "outside") { configHome = await mkdtemp(path.join(tmpdir(), "external-style-config-")); roots.push(configHome); }
    if (kind === "project") configHome = value.project;
    if (kind === "linked-directory") { const alias = path.join(value.root, "linked-config"); await symlink(value.config, alias, "junction"); configHome = alias; }
    if (kind === "hardlinked-file") { const target = path.join(value.config, "10.0", "eeschema.json"); await rename(target, path.join(value.root, "external-eeschema.json")); await link(path.join(value.root, "external-eeschema.json"), target); }
    const options = { ...value.options, ...(kind === "overlapping-output" ? { outputDirectory: path.join(value.config, "svg-output") } : {}), configuration: { ...value.options.configuration, configHome } };
    await expect(value.adapter.exportSchematicSvgWithStrokeStyle(options)).rejects.toThrow(); expect(value.calls).toHaveLength(0);
  });

  it.each(["before", "during"] as const)("rejects source mutation %s export", async (when) => {
    const value = await fixture(when === "during" ? async (_call, source) => { await appendFile(source.schematic, " "); } : undefined);
    if (when === "before") await appendFile(value.schematic, " ");
    await expect(value.adapter.exportSchematicSvgWithStrokeStyle(value.options)).rejects.toBeInstanceOf(KicadSourceMutationError); expect(value.calls).toHaveLength(when === "before" ? 0 : 1);
  });

  it.each(["engine-before", "engine-during", "executable-before", "wrong-version"] as const)("rejects unapproved native authority: %s", async (kind) => {
    const value = await fixture(kind === "engine-during" ? async (_call, source) => { await appendFile(source.engine, " "); } : undefined, kind === "wrong-version" ? "10.0.4" : "10.0.3");
    if (kind === "engine-before") await appendFile(value.engine, " "); if (kind === "executable-before") await appendFile(value.exe, " ");
    await expect(value.adapter.exportSchematicSvgWithStrokeStyle(value.options)).rejects.toThrow(); expect(value.calls).toHaveLength(kind === "engine-during" ? 1 : 0);
  });

  it.each(["argv", "command", "exit", "abort", "timeout", "invalid-utf8"] as const)("rejects or propagates malformed native outcome: %s", async (kind) => {
    let thrown: Error | undefined;
    const value = await fixture(async (call, source) => {
      if (kind === "argv") return result(call, { args: [...call.args, "--min-pen-width", "0.001"] });
      if (kind === "command") return result(call, { command: "C:/not-approved.exe" });
      if (kind === "exit") return result(call, { exitCode: 2 });
      if (kind === "abort") { thrown = new DOMException("Native export aborted", "AbortError"); throw thrown; }
      if (kind === "timeout") { thrown = new ProcessTimeoutError("Native export timed out", call, "", ""); throw thrown; }
      if (kind === "invalid-utf8") await writeFile(path.join(source.output, "fixture.svg"), Buffer.from([0xc3, 0x28]));
    });
    const pending = value.adapter.exportSchematicSvgWithStrokeStyle(value.options);
    if (kind === "abort" || kind === "timeout") { const caught = await pending.catch((error: unknown) => error); expect(caught).toBe(thrown); }
    else if (kind === "exit") await expect(pending).rejects.toBeInstanceOf(KicadCliInvocationError);
    else await expect(pending).rejects.toThrow();
    expect(value.calls).toHaveLength(1);
  });

  it("does no dispatch for a pre-aborted operation", async () => {
    const value = await fixture(); const controller = new AbortController(); const failure = new DOMException("Already aborted", "AbortError"); controller.abort(failure);
    await expect(value.adapter.exportSchematicSvgWithStrokeStyle({ ...value.options, signal: controller.signal })).rejects.toBe(failure);
    expect(value.calls).toHaveLength(0);
  });

  it("requires explicit configuration and rejects mismatched tree schemas", async () => {
    const value = await fixture();
    await expect(value.adapter.exportSchematicSvgWithStrokeStyle({ ...value.options, configuration: undefined } as never)).rejects.toBeInstanceOf(KicadSchematicConfigurationError);
    await expect(value.adapter.exportSchematicSvgWithStrokeStyle({ ...value.options, configuration: { ...value.options.configuration, expectedTreeIdentity: canonicalIdentity({}, "evleda.unrelated-tree.v1") } })).rejects.toBeInstanceOf(KicadSchematicConfigurationError);
    expect(value.calls).toHaveLength(0);
  });
});
