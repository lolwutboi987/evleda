import { link, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { createKicadPlaneContactsReader, isKicadPlaneContactsObservation } from "../../src/integrations/kicad-plane-contacts.js";
import { cleanupPlaneContactsFixture, createPlaneContactsFixture } from "../helpers/kicad-plane-contacts-fixture.js";

type Fixture = Awaited<ReturnType<typeof createPlaneContactsFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });
async function fixture() { const f = await createPlaneContactsFixture(); fixtures.push(f); return f; }
async function duringRun(f: Fixture, mutate: () => Promise<void>) {
  const success = f.runner.getMockImplementation()!;
  f.runner.mockImplementationOnce(async input => { const result = await success(input); await mutate(); return result; });
}

describe("host-bound isolated plane-contacts reader", () => {
  it("brands an immutable source-bound observation and stores the exact validated process output", async () => {
    const f = await fixture(), observation = await f.reader.read();
    expect(isKicadPlaneContactsObservation(observation)).toBe(true);
    expect(isKicadPlaneContactsObservation(structuredClone(observation))).toBe(false);
    expect(isKicadPlaneContactsObservation({ ...observation })).toBe(false);
    expect(isKicadPlaneContactsObservation(null)).toBe(false);
    expect(observation.sourceBefore).toEqual(contentIdentity(f.pcbSource));
    expect(observation.sourceAfter).toEqual(observation.sourceBefore);
    expect(observation.sourceUnchanged).toBe(true);
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(observation.report.runtime.loadedPythonModules)).toBe(true);
    expect(observation.limitations).toEqual({ foreignNetGeometricOverlaps: "not_assessed_by_direct_neighbors",
      contactScope: "aggregate-native-subpolygons", savedFillFreshness: "not_established" });
    const raw = await readFile(observation.artifacts.rawOutput.path);
    expect(raw.toString("utf8")).toBe(JSON.stringify(f.report));
    expect(observation.artifacts.rawOutput.identity).toEqual(contentIdentity(raw));
    expect(observation.runtime.manifestIdentity).toEqual(f.options.manifest.contentIdentity);
    expect(observation.runtime.helperIdentity).toEqual(f.options.helper.contentIdentity);
  });

  it("uses fixed isolated flags, a private empty cwd, and a closed environment for every run", async () => {
    const f = await fixture();
    const success = f.runner.getMockImplementation()!;
    f.runner.mockImplementation(async input => { expect(await readdir(input.cwd)).toEqual([]); return success(input); });
    const reader = await createKicadPlaneContactsReader({ ...f.options,
      environment: { ...f.options.environment, PYTHONPATH: "ignored-python-path", KICAD_CONFIG_HOME: "ignored-config", PROVIDER_TOKEN: "synthetic-test-value" } });
    await reader.read(); await reader.read();
    const first = f.runner.mock.calls[0]![0], second = f.runner.mock.calls[1]![0];
    expect(first.command).toBe(path.join(f.options.runtimeRoot, "bin", "python.exe"));
    expect(first.args).toEqual(["-I", "-s", "-E", "-B", "-S", f.options.helper.path, "--board", f.options.pcbPath,
      "--expected-source-sha256", f.options.expectedSourceIdentity.digest]);
    expect(first.cwd).not.toBe(second.cwd);
    expect(path.relative(f.options.outputRoot, first.cwd)).not.toMatch(/^\.\./u);
    expect(Object.keys(first.env).sort()).toEqual(["SystemRoot", "WINDIR", "PATH", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
      "APPDATA", "LOCALAPPDATA", "KICAD_CONFIG_HOME", "TEMP", "TMP"].sort());
    expect(first.env.PATH).toBe(path.join(first.env.SystemRoot!, "System32"));
    for (const name of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "KICAD_CONFIG_HOME", "TEMP", "TMP"]) {
      expect(path.relative(path.dirname(first.cwd), first.env[name]!)).not.toMatch(/^\.\./u);
    }
    expect(first.timeoutMs).toBe(15000);
    expect(first.maxOutputBytes).toBeGreaterThan(0); expect(first.maxOutputBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
  });

  it("accepts no per-call path or PAD selectors", async () => {
    const f = await fixture();
    const untypedRead = f.reader.read as (...args: unknown[]) => Promise<unknown>;
    await expect(untypedRead({ pcbPath: "C:\\different.kicad_pcb", pads: ["J1.1"] })).rejects.toThrow("no caller path or pad selectors");
    expect(f.runner).not.toHaveBeenCalled();
  });

  it("rejects a stale saved source before invoking the process", async () => {
    const f = await fixture(); await writeFile(f.options.pcbPath, f.pcbSource + "\n");
    await expect(f.reader.read()).rejects.toThrow("stale"); expect(f.runner).not.toHaveBeenCalled();
  });

  it("rejects changed saved source after the process", async () => {
    const f = await fixture(); await duringRun(f, () => writeFile(f.options.pcbPath, f.pcbSource + "\n"));
    await expect(f.reader.read()).rejects.toThrow("source changed");
  });

  it("detects saved source rewrite even if the child restores the original bytes", async () => {
    const f = await fixture(); await duringRun(f, async () => {
      await writeFile(f.options.pcbPath, f.pcbSource + "\n"); await writeFile(f.options.pcbPath, f.pcbSource);
    });
    await expect(f.reader.read()).rejects.toThrow("source changed");
  });

  it.each(["extra.dll", "bin/Lib/site-packages/pcbnew.pyd", "bin/Lib/site-packages/pcbnew.pyc", "pyvenv.cfg", "bin/python311._pth"])(
    "rejects an unapproved runtime file %s before the process", async relative => {
      const f = await fixture(); await writeFile(path.join(f.options.runtimeRoot, relative), "unapproved fixture content");
      await expect(f.reader.read()).rejects.toThrow(); expect(f.runner).not.toHaveBeenCalled();
    });

  it.each(["bin/Lib/site-packages/pcbnew", "bin/Lib/__pycache__", "empty-extra-directory"])(
    "rejects an unapproved runtime directory %s", async relative => {
      const f = await fixture(); await mkdir(path.join(f.options.runtimeRoot, relative));
      await expect(f.reader.read()).rejects.toThrow(); expect(f.runner).not.toHaveBeenCalled();
    });

  it("rejects a hard-linked pinned runtime file", async () => {
    const f = await fixture(); await link(path.join(f.options.runtimeRoot, "bin", "python.exe"), path.join(f.root, "linked-python.exe"));
    await expect(f.reader.read()).rejects.toThrow("type/size/pin"); expect(f.runner).not.toHaveBeenCalled();
  });

  it("rejects a runtime addition introduced during the child process", async () => {
    const f = await fixture(); await duringRun(f, () => writeFile(path.join(f.options.runtimeRoot, "added.dll"), "added"));
    await expect(f.reader.read()).rejects.toThrow("extra or shadow file");
  });

  it.each(["helper", "manifest"] as const)("rejects mutation of the pinned %s before execution", async name => {
    const f = await fixture(); await writeFile(f.options[name].path, "changed");
    await expect(f.reader.read()).rejects.toThrow("pin mismatch"); expect(f.runner).not.toHaveBeenCalled();
  });

  it("rejects a helper mutation during execution", async () => {
    const f = await fixture(); await duringRun(f, () => writeFile(f.options.helper.path, "changed"));
    await expect(f.reader.read()).rejects.toThrow("pin mismatch");
  });

  it("detects a pinned runtime rewrite even after identical bytes are restored", async () => {
    const f = await fixture(), target = path.join(f.options.runtimeRoot, "bin", "Lib", "os.py"), original = await readFile(target);
    await duringRun(f, async () => { await writeFile(target, "changed"); await writeFile(target, original); });
    await expect(f.reader.read()).rejects.toThrow("runtime/helper/manifest changed");
  });

  it("detects a pinned manifest rewrite even after identical bytes are restored", async () => {
    const f = await fixture(), original = await readFile(f.options.manifest.path);
    await duringRun(f, async () => { await writeFile(f.options.manifest.path, "changed"); await writeFile(f.options.manifest.path, original); });
    await expect(f.reader.read()).rejects.toThrow(/changed during observation/u);
  });

  it("rejects mislabeled core Python modules even when the same pinned file inventory remains present", async () => {
    const f = await fixture(), modules = f.report.runtime.loadedPythonModules;
    [modules.pcbnew, modules.os] = [modules.os!, modules.pcbnew!];
    await expect(f.reader.read()).rejects.toThrow(/core Python module name/u);
  });

  it.each(["invalid JSON", "[]"])(
    "rejects malformed or ambiguous output %s", async stdout => {
      const f = await fixture(), success = f.runner.getMockImplementation()!;
      f.runner.mockImplementationOnce(async input => ({ ...await success(input), stdout }));
      await expect(f.reader.read()).rejects.toThrow();
    });

  it("rejects duplicate keys in an otherwise valid complete report", async () => {
    const f = await fixture(), success = f.runner.getMockImplementation()!;
    f.runner.mockImplementationOnce(async input => ({ ...await success(input),
      stdout: JSON.stringify(f.report).replace('"ok":true', '"ok":true,"ok":true') }));
    await expect(f.reader.read()).rejects.toThrow(/duplicate/iu);
  });

  it.each([
    ["unknown key", /Unrecognized key/u], ["inventory count", /inventory counts differ/u],
    ["child source", /child source observations/u], ["child runtime hash", /child runtime file observation/u],
    ["child helper hash", /child helper observation/u], ["module origin", /module origin/u],
    ["missing module", /source module inventory/u], ["missing native dependency", /native dependency inventory/u],
    ["import path", /import search/u], ["system dependency", /system native dependency/u],
  ] as const)("rejects a report with %s disagreement", async (scenario, message) => {
      const f = await fixture();
      if (scenario === "unknown key") Object.assign(f.report, { surprise: true });
      else if (scenario === "inventory count") f.report.inventory.padCount = 1;
      else if (scenario === "child source") f.report.source.after.sha256 = "0".repeat(64);
      else if (scenario === "child runtime hash") f.report.runtime.pythonExecutable.sha256 = "0".repeat(64);
      else if (scenario === "child helper hash") f.report.runtime.helper.sha256 = "0".repeat(64);
      else if (scenario === "module origin") f.report.runtime.loadedPythonModules.os!.origin = path.join(f.root, "outside.py");
      else if (scenario === "missing module") delete f.report.runtime.loadedPythonModules.os;
      else if (scenario === "missing native dependency") f.report.runtime.bundledNativeDependencies.pop();
      else if (scenario === "import path") f.report.runtime.importPaths[0] = f.root;
      else f.report.runtime.windowsSystemNativeDependencyPaths = [path.join(f.root, "foreign.dll")];
      await expect(f.reader.read()).rejects.toThrow(message);
    });

  it("rejects runner failure and remains usable for a later clean observation", async () => {
    const f = await fixture(); f.runner.mockRejectedValueOnce(new Error("simulated bounded runner failure"));
    await expect(f.reader.read()).rejects.toThrow("process failed");
    expect(isKicadPlaneContactsObservation(await f.reader.read())).toBe(true);
  });

  it("rejects concurrent observations while allowing the original process to settle", async () => {
    const f = await fixture(), success = f.runner.getMockImplementation()!;
    let release!: () => void, announce!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { announce = resolve; });
    f.runner.mockImplementationOnce(async input => { announce(); await gate; return success(input); });
    const first = f.reader.read(); await started;
    try { await expect(f.reader.read()).rejects.toThrow("active observation"); }
    finally { release(); }
    expect(isKicadPlaneContactsObservation(await first)).toBe(true);
    expect(f.runner).toHaveBeenCalledTimes(1);
  });

  it.each(["nonzero", "stderr", "signal", "wrong command", "wrong argv", "wrong cwd", "overflow"])(
    "rejects the bounded runner result on %s", async scenario => {
      const f = await fixture(), success = f.runner.getMockImplementation()!;
      f.runner.mockImplementationOnce(async input => {
        const result = await success(input);
        if (scenario === "nonzero") return { ...result, exitCode: 3 };
        if (scenario === "stderr") return { ...result, stderr: "unexpected diagnostics" };
        if (scenario === "signal") return { ...result, signal: "SIGTERM" };
        if (scenario === "wrong command") return { ...result, command: "wrong-python.exe" };
        if (scenario === "wrong argv") return { ...result, args: [...result.args, "--unapproved"] };
        if (scenario === "wrong cwd") return { ...result, cwd: f.root };
        return { ...result, stdout: "x".repeat(input.maxOutputBytes + 1) };
      });
      await expect(f.reader.read()).rejects.toThrow();
    });

  it("rejects caller-pinned manifests that weaken the execution policy", async () => {
    const f = await fixture(), manifest = { ...f.manifest, pythonArgs: ["-I", "-s", "-E", "-B"] }, bytes = JSON.stringify(manifest);
    await writeFile(f.options.manifest.path, bytes);
    await expect(createKicadPlaneContactsReader({ ...f.options,
      manifest: { path: f.options.manifest.path, contentIdentity: contentIdentity(bytes) } })).rejects.toThrow();
    expect(f.runner).not.toHaveBeenCalled();
  });

  it("preserves failed native outcome when a later runtime recheck also fails", async () => {
    const f=await fixture(),success=f.runner.getMockImplementation()!;
    const response=JSON.stringify({schemaVersion:"evleda.native-plane-contacts.v1",ok:false,error:{code:"NATIVE_LOAD_FAILED"}});
    f.runner.mockImplementationOnce(async input=>{
      const result=await success(input);
      await writeFile(f.options.helper.path,"changed helper after native failure");
      return {...result,exitCode:2,stdout:response};
    });
    const error=await f.reader.read().catch(error=>error as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("process failed and post-execution verification failed");
    expect((error as Error).cause).toMatchObject({processFailure:null,processOutcome:{exitCode:2,stdout:response}});
    expect((error as Error).cause).toHaveProperty("verificationFailure");
  });

  it("rejects overlapping private-output/runtime roots", async () => {
    const f = await fixture();
    await expect(createKicadPlaneContactsReader({ ...f.options, outputRoot: f.options.runtimeRoot })).rejects.toThrow("overlaps");
  });

  it("allows an unused approved OS DLL while rejecting an unapproved loaded OS DLL", async () => {
    const f=await fixture();
    const manifest={...f.manifest,windowsSystemNativeDependencyPaths:[...f.manifest.windowsSystemNativeDependencyPaths,
      path.win32.join(f.options.environment.SystemRoot!,"System32","windows.storage.dll")]};
    const bytes=JSON.stringify(manifest);await writeFile(f.options.manifest.path,bytes);
    const reader=await createKicadPlaneContactsReader({...f.options,manifest:{path:f.options.manifest.path,contentIdentity:contentIdentity(bytes)}});
    expect(isKicadPlaneContactsObservation(await reader.read())).toBe(true);
    f.report.runtime.windowsSystemNativeDependencyPaths.push(path.win32.join(f.options.environment.SystemRoot!,"System32","unapproved.dll"));
    await expect(reader.read()).rejects.toThrow("unexpected system native dependency path");
  });

  it("refuses cleanup of paths outside fixture ownership", async () => {
    const f = await fixture();
    await expect(cleanupPlaneContactsFixture(path.dirname(f.root))).rejects.toThrow("unowned");
    await expect(cleanupPlaneContactsFixture(path.join(f.root, "runtime"))).rejects.toThrow("unowned");
    expect(await readFile(f.options.pcbPath, "utf8")).toBe(f.pcbSource);
  });
});
