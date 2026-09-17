import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({ read: vi.fn(), bridge: vi.fn(), run: vi.fn(), uuid: vi.fn() }));
vi.mock("node:crypto", async importOriginal => ({ ...await importOriginal<typeof import("node:crypto")>(), randomUUID: seams.uuid }));
vi.mock("../../src/flux/production-composition.js", () => ({ readKicadNativeProfile: seams.read }));
vi.mock("../../src/integrations/bounded-process.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/integrations/bounded-process.js")>(), runBoundedProcess: seams.run,
}));
vi.mock("../../src/integrations/kicad-mcp-session.js", () => ({
  createKicadMcpRuntimeBridge: seams.bridge, KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS: 123,
  KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY: "pinned-strategy", KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS: 456,
}));

import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { bindFluxPcbEditorSuite, FluxPcbEditorIdentityError, getFluxPcbEditorCliProbeFailure } from "../../src/flux/pcb-editor-launcher.js";
import type { BoundedProcessOptions, BoundedProcessResult } from "../../src/integrations/bounded-process.js";
import { writeToolboxCliProbeDiagnostic } from "../../src/mcp/toolbox-cli-probe-diagnostics.js";
import { loadKicadToolboxNativeProfile } from "../../src/mcp/toolbox-native-profile.js";
import { createFakeFluxKicadToolchain } from "../helpers/flux-kicad-toolchain.js";

const roots: string[] = [];
const uuid = "00000000-0000-4000-8000-000000000001";
const filename = `startup-diagnostic-cli-probe-${uuid}.json`;
const message = "Pinned KiCad CLI identity probe failed its exact transcript policy.";
const pin = { algorithm: "sha256" as const, digest: "1".repeat(64), size: 17 };
beforeEach(() => { vi.resetAllMocks(); seams.uuid.mockReturnValue(uuid); });
afterEach(async () => {
  const temporaryRoot = await realpath(tmpdir());
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== temporaryRoot || !path.basename(root).startsWith("cli-probe-diag-")) {
      throw new Error("CLI probe test cleanup escaped its owned temporary root.");
    }
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "cli-probe-diag-"))); roots.push(root);
  const at = (...parts: string[]) => path.join(root, ...parts);
  const kicad = await createFakeFluxKicadToolchain(root);
  await Promise.all([mkdir(at("source")), mkdir(at("output"))]);
  const { kicadCli, pcbnew, binRoot } = kicad.toolchain;
  const profile = {
    path: at("config", "profile.json"), contentIdentity: pin,
    kicadToolchain: { binRoot, kicadCli: { ...kicadCli, identity: kicadCli.contentIdentity },
      pcbnew: { ...pcbnew, identity: pcbnew.contentIdentity } },
    kicadMcpRuntime: { lock: { path: at("lock", "lock.json"), identity: pin },
      runtimeBundle: { root: at("bundle"), manifest: { path: at("manifest", "manifest.json"), identity: pin },
        expectedClosure: { fileCount: 29, manifestIdentity: pin, treeIdentity: pin, protocol: "protocol",
          python: { relativePath: "python.exe", identity: pin }, entrypoint: { relativePath: "main.py", identity: pin } } },
      runtimeParentRoot: at("private-runtime"), ipcSocketParentRoot: at("sockets"), runtimePolicy: { verificationTimeoutMs: 123 },
      processTreeSupervision: { terminator: { path: at("system", "taskkill.exe"), identity: pin } } },
  };
  const input = { profile: { path: profile.path, contentIdentity: pin }, sourceRoot: at("source"), outputRoot: at("output"),
    environment: { SYSTEMROOT: at("system"), WINDIR: at("system"), OPENAI_API_KEY: "environment-secret", PATH: "host-private-path" } };
  const bridge = { assertCurrent: vi.fn().mockResolvedValue(undefined) };
  seams.read.mockResolvedValue(profile); seams.bridge.mockResolvedValue(bridge); seams.run.mockImplementation(kicad.runner);
  return { root, at, kicad, input, bridge };
}

async function caught(operation: Promise<unknown>): Promise<Error> {
  const error: unknown = await operation.catch((value: unknown) => value);
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) throw new Error("Expected a captured test failure.");
  return error;
}

describe("private CLI identity probe failure diagnostics", () => {
  it.each([
    ["stdout", { stdout: "10.0.3\n", stderr: "", exitCode: 0 }],
    ["stderr", { stdout: "10.0.3\r\n", stderr: "native stderr detail\r\n", exitCode: 0 }],
    ["nonzero exit", { stdout: "10.0.3\r\n", stderr: "", exitCode: -1073741515 }],
  ] as const)("publishes the exact failed %s result privately and only a filename/hash publicly", async (_label, received) => {
    const f = await fixture();
    seams.run.mockImplementation(async (options: BoundedProcessOptions): Promise<BoundedProcessResult> => {
      const result = { ...await f.kicad.runner(options), ...received,
        // Returned context is deliberately ignored in favor of the actual probe.
        command: "private-result-command", cwd: "private-result-cwd", args: ["model-data-must-not-publish"],
        env: { TOKEN: "result-secret" }, input: "input-must-not-publish" };
      return result;
    });
    const error = await caught(loadKicadToolboxNativeProfile(f.input));
    expect(error).toBeInstanceOf(FluxPcbEditorIdentityError);
    expect(error.cause).toBeInstanceOf(FluxPcbEditorIdentityError);
    const failure = { args: ["version"], expectedStdout: "10.0.3\r\n", ...received };
    expect(getFluxPcbEditorCliProbeFailure(error.cause)).toEqual(failure);
    expect((error.cause as Error).cause).toEqual(failure);
    const bytes = await readFile(path.join(f.input.outputRoot, filename));
    const diagnostic = JSON.parse(bytes.toString("utf8"));
    const { identity, ...body } = diagnostic;
    expect(body).toEqual({ schemaVersion: "evleda.toolbox-cli-probe-diagnostic.v1", phase: "primary-failure", stage: "cli-identity-probe", failure });
    expect(identity).toEqual(canonicalIdentity(body, body.schemaVersion));
    expect(error.message).toBe(`${message} Diagnostic: ${filename} (sha256:${contentIdentity(bytes).digest}).`);
    const publicResult = JSON.stringify({ error: error.message });
    expect(publicResult).not.toContain("native stderr detail");
    expect(publicResult).not.toContain("10.0.3");
    expect(bytes.toString()).not.toMatch(/environment-secret|host-private-path|result-secret|input-must-not-publish|model-data-must-not-publish|private-result/u);
    expect(bytes.toString()).not.toContain(f.root.replaceAll("\\", "\\\\"));
    expect(await readdir(f.input.outputRoot)).toEqual([filename]);
    expect(f.bridge.assertCurrent).not.toHaveBeenCalled();
    expect(f.kicad.calls).toHaveLength(1);
    expect(f.kicad.calls[0]).toMatchObject({ timeoutMs: 5_000, maxOutputBytes: 16_384 });
  });

  it("retains the commit probe separately after a successful version probe", async () => {
    const f = await fixture();
    const error = await caught(bindFluxPcbEditorSuite({ toolchain: f.kicad.toolchain, runner: async options => {
      const result = await f.kicad.runner(options);
      return options.args.length === 1 ? result : { ...result, stdout: "wrong commit\r\n", stderr: "commit stderr", exitCode: 7 };
    } }));
    const failure = getFluxPcbEditorCliProbeFailure(error);
    expect(failure).toEqual({ args: ["version", "--format", "commit"], expectedStdout: `${"1".repeat(40)}\r\n`,
      stdout: "wrong commit\r\n", stderr: "commit stderr", exitCode: 7 });
    expect(error.message).toBe(message);
    expect(error.cause).toBe(failure);
    expect(Object.isFrozen(failure)).toBe(true);
    expect(Object.isFrozen(failure!.args)).toBe(true);
    expect(f.kicad.calls).toHaveLength(2);
  });

  it("preserves both complete 16 KiB streams when JSON control escaping expands them", async () => {
    const f = await fixture();
    const stdout = "\0".repeat(16_384), stderr = "\u0001".repeat(16_384);
    seams.run.mockImplementation(async (options: BoundedProcessOptions) => ({ ...await f.kicad.runner(options), stdout, stderr, exitCode: 2 }));
    const error = await caught(loadKicadToolboxNativeProfile(f.input));
    const bytes = await readFile(path.join(f.input.outputRoot, filename));
    expect(JSON.parse(bytes.toString()).failure).toMatchObject({ stdout, stderr, exitCode: 2 });
    expect(bytes.byteLength).toBeLessThanOrEqual(256 * 1024);
    expect(error.message).not.toContain("\\u0000");
  });

  it("leaves an existing file untouched and preserves the original failure if exclusive publication fails", async () => {
    const f = await fixture();
    const target = path.join(f.input.outputRoot, filename);
    await writeFile(target, "owned prior evidence", { flag: "wx" });
    seams.run.mockImplementation(async (options: BoundedProcessOptions) => ({ ...await f.kicad.runner(options), stderr: "first native failure", exitCode: 9 }));
    const error = await caught(loadKicadToolboxNativeProfile(f.input));
    expect(error.message).toBe(message);
    expect(getFluxPcbEditorCliProbeFailure(error)).toEqual({ args: ["version"], expectedStdout: "10.0.3\r\n", stdout: "10.0.3\r\n", stderr: "first native failure", exitCode: 9 });
    expect(error.cause).toBe(getFluxPcbEditorCliProbeFailure(error));
    expect(await readFile(target, "utf8")).toBe("owned prior evidence");
    expect(await readdir(f.input.outputRoot)).toEqual([filename]);
  });

  it("preserves the complete cause if its private artifact exceeds the publication bound", async () => {
    const f = await fixture();
    const stdout = "x".repeat(256 * 1024);
    seams.run.mockImplementation(async (options: BoundedProcessOptions) => ({ ...await f.kicad.runner(options), stdout, stderr: "", exitCode: 3 }));
    const error = await caught(loadKicadToolboxNativeProfile(f.input));
    expect(error.message).toBe(message);
    expect(getFluxPcbEditorCliProbeFailure(error)?.stdout).toBe(stdout);
    expect(await readdir(f.input.outputRoot)).toEqual([]);
  });

  it("propagates an unbranded error without publishing its lookalike transcript", async () => {
    const f = await fixture();
    const foreign = new FluxPcbEditorIdentityError(message, { cause: { args: ["version"], expectedStdout: "10.0.3\r\n", stdout: "model transcript", stderr: "", exitCode: 1 } });
    seams.run.mockRejectedValue(foreign);
    await expect(loadKicadToolboxNativeProfile(f.input)).rejects.toBe(foreign);
    expect(await readdir(f.input.outputRoot)).toEqual([]);
    expect(seams.uuid).not.toHaveBeenCalled();
    let invoked = 0;
    const forbidden = () => { invoked++; throw new Error("foreign hook invoked"); };
    const proxy = new Proxy({}, { get: forbidden, getPrototypeOf: forbidden, ownKeys: forbidden });
    for (const value of [foreign, foreign.cause, proxy, undefined, null]) {
      expect(getFluxPcbEditorCliProbeFailure(value)).toBeUndefined();
      await expect(writeToolboxCliProbeDiagnostic(f.input.outputRoot, value)).rejects.toThrow("captured host failure");
    }
    expect(invoked).toBe(0);
  });

  it("rejects a noncanonical directory alias before reserving an artifact", async () => {
    const f = await fixture();
    const error = await caught(bindFluxPcbEditorSuite({ toolchain: f.kicad.toolchain, runner: async options => ({
      ...await f.kicad.runner(options), stderr: "native failure",
    }) }));
    const alias = f.at("output-alias");
    await symlink(f.input.outputRoot, alias, process.platform === "win32" ? "junction" : "dir");
    await expect(writeToolboxCliProbeDiagnostic(alias, error)).rejects.toThrow("exact host output directory");
    expect(await readdir(f.input.outputRoot)).toEqual([]);
  });

  it("keeps the successful composition and both exact probes free of output artifacts", async () => {
    const f = await fixture();
    const loaded = await loadKicadToolboxNativeProfile(f.input);
    expect(loaded.editorSuite.profile).toEqual(f.kicad.toolchain);
    expect(loaded.bridge).toBe(f.bridge);
    expect(f.bridge.assertCurrent).toHaveBeenCalledOnce();
    expect(f.kicad.calls.map(call => call.args)).toEqual([["version"], ["version", "--format", "commit"]]);
    expect(f.kicad.calls.every(call => call.timeoutMs === 5_000 && call.maxOutputBytes === 16_384)).toBe(true);
    expect(await readdir(f.input.outputRoot)).toEqual([]);
    expect(seams.uuid).not.toHaveBeenCalled();
  });
});
