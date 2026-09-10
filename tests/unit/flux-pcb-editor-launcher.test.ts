import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFluxKicadToolchainBinding } from "../../src/flux/kicad-toolchain-binding.js";
import { bindFluxPcbEditorSuite, FluxPcbEditorProbeUncertainError, launchFluxPcbEditor } from "../../src/flux/pcb-editor-launcher.js";
import { ProcessTreeTerminationUnconfirmedError } from "../../src/integrations/bounded-process.js";
import type { KicadMcpEditorLaunchContext } from "../../src/integrations/kicad-mcp-session.js";
import { createFakeFluxKicadToolchain } from "../helpers/flux-kicad-toolchain.js";

const temporaryRoot = path.resolve(tmpdir());
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const relative = path.relative(temporaryRoot, path.resolve(root));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("PCB editor fixture cleanup escaped its owned temporary root.");
    await rm(root, { recursive: true, force: true });
  }
});
const fixture = async () => { const root = await mkdtemp(path.join(temporaryRoot, "evleda-pcb-editor-")); roots.push(root); return { root, kicad: await createFakeFluxKicadToolchain(root) }; };
const ipcEndpoint = (root: string): KicadMcpEditorLaunchContext => {
  const tempRoot = path.join(root, "ipc");
  return { endpoint: `ipc://${path.join(tempRoot, "kicad", "api.sock")}`, tempRoot, configRoot: path.join(tempRoot, "config"), prepareLaunch: async () => undefined, observeExit: () => undefined };
};
const launched = (pid: number) => ({ pid, exited: new Promise<never>(() => undefined) });

describe("Flux non-GUI PCB editor identity", () => {
  it("probes only the pinned CLI and launches the exact editor and board once after preflight", async () => {
    const value = await fixture();
    const binding = await bindFluxPcbEditorSuite({ toolchain: value.kicad.toolchain, runner: value.kicad.runner, environment: { SystemRoot: "C:\\Windows", OPENAI_API_KEY: "must-not-forward" } });
    expect(value.kicad.calls.map((call) => ({ command: call.command, args: call.args }))).toEqual([
      { command: value.kicad.cliPath, args: ["version"] },
      { command: value.kicad.cliPath, args: ["version", "--format", "commit"] },
    ]);
    expect(value.kicad.calls.every((call) => call.env.SystemRoot === "C:\\Windows" && !Object.hasOwn(call.env, "OPENAI_API_KEY"))).toBe(true);
    const board = path.join(value.root, "project", "candidate.kicad_pcb");
    const launches: Array<{ executablePath: string; boardPath: string }> = [];
    let childEnvironment: Readonly<Record<string, string>> = {};
    const result = await launchFluxPcbEditor(binding, board, ipcEndpoint(value.root), async (request) => {
      launches.push({ executablePath: request.executablePath, boardPath: request.boardPath }); childEnvironment = request.environment; return launched(4242);
    }, undefined, { SystemRoot: "C:\\Windows", TEMP: "C:\\ambient-temp", TMP: "C:\\ambient-tmp", KICAD_CONFIG_HOME: "C:\\ambient-config", KICAD10_SYMBOL_DIR: "D:\\libraries\\symbols", PATH: "C:\\host-injection", PATHEXT: ".MALICIOUS", KICAD_API_SOCKET: "ipc://C:\\attacker.sock", OPENAI_API_KEY: "secret", ANTHROPIC_API_KEY: "secret", GITHUB_TOKEN: "secret", AWS_SECRET_ACCESS_KEY: "secret", COOKIE: "secret" });
    expect(result.pid).toBe(4242);
    expect(typeof result.exited.then).toBe("function");
    expect(launches).toEqual([{ executablePath: value.kicad.pcbnewPath, boardPath: board }]);
    expect(childEnvironment).toEqual({ SystemRoot: "C:\\Windows", KICAD10_SYMBOL_DIR: "D:\\libraries\\symbols", TEMP: ipcEndpoint(value.root).tempRoot, TMP: ipcEndpoint(value.root).tempRoot, KICAD_CONFIG_HOME: ipcEndpoint(value.root).configRoot, KICAD_CACHE_HOME: path.join(ipcEndpoint(value.root).tempRoot, "cache"), KICAD_API_SOCKET: ipcEndpoint(value.root).endpoint });
    expect(`ipc://${path.join(childEnvironment.TEMP!, "kicad", "api.sock")}`).toBe(childEnvironment.KICAD_API_SOCKET);
    expect(value.kicad.calls.every((call) => call.command !== value.kicad.pcbnewPath)).toBe(true);
  });

  it("classifies an unconfirmed CLI-probe teardown as non-retryable uncertainty", async () => {
    const value = await fixture();
    const options = { command: value.kicad.cliPath, args: ["version"], cwd: value.kicad.toolchain.binRoot, env: {}, timeoutMs: 5_000, maxOutputBytes: 16_384 };
    const error = await bindFluxPcbEditorSuite({ toolchain: value.kicad.toolchain, runner: async () => { throw new ProcessTreeTerminationUnconfirmedError("tree uncertain", options, "", ""); } }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FluxPcbEditorProbeUncertainError);
    expect(error).toMatchObject({ retryable: false });
  });

  it.each([
    ["LF", (value: string) => value.replaceAll("\r\n", "\n")],
    ["no terminator", (value: string) => value.replaceAll("\r\n", "")],
    ["leading whitespace", (value: string) => ` ${value}`],
  ])("rejects %s KiCad CLI identity transcripts", async (_label, mutate) => {
    const value = await fixture();
    await expect(bindFluxPcbEditorSuite({ toolchain: value.kicad.toolchain, runner: async (options) => {
      const result = await value.kicad.runner(options);
      return { ...result, stdout: mutate(result.stdout) };
    } })).rejects.toThrow(/exact transcript/iu);
    expect(value.kicad.calls.every((call) => call.command === value.kicad.cliPath)).toBe(true);
  });

  it("rejects same-version wrong bytes and a hard-linked editor before any CLI probe", async () => {
    const wrong = await fixture();
    const bytes = await readFile(wrong.kicad.pcbnewPath); bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff; await writeFile(wrong.kicad.pcbnewPath, bytes);
    await expect(bindFluxPcbEditorSuite({ toolchain: wrong.kicad.toolchain, runner: wrong.kicad.runner })).rejects.toThrow(/SHA-256/iu);
    expect(wrong.kicad.calls).toHaveLength(0);

    const aliased = await fixture();
    const source = path.join(aliased.root, "editor-source.exe");
    await rename(aliased.kicad.pcbnewPath, source); await link(source, aliased.kicad.pcbnewPath);
    await expect(bindFluxPcbEditorSuite({ toolchain: aliased.kicad.toolchain, runner: aliased.kicad.runner })).rejects.toThrow(/single-link/iu);
    expect(aliased.kicad.calls).toHaveLength(0);
  });

  it.skipIf(process.platform !== "win32")("rejects a junctioned installation root", async () => {
    const value = await fixture();
    const alias = path.join(value.root, "aliased-bin"); await symlink(value.kicad.toolchain.binRoot, alias, "junction");
    const rebound = createFluxKicadToolchainBinding({
      binRoot: alias,
      kicadCli: { path: path.join(alias, "kicad-cli.exe"), contentIdentity: value.kicad.toolchain.kicadCli.contentIdentity, operationalVersion: value.kicad.toolchain.kicadCli.operationalVersion, operationalCommit: value.kicad.toolchain.kicadCli.operationalCommit, peFileVersion: value.kicad.toolchain.kicadCli.peFileVersion, peProductVersion: value.kicad.toolchain.kicadCli.peProductVersion },
      pcbnew: { path: path.join(alias, "pcbnew.exe"), contentIdentity: value.kicad.toolchain.pcbnew.contentIdentity, peFileVersion: value.kicad.toolchain.pcbnew.peFileVersion, peProductVersion: value.kicad.toolchain.pcbnew.peProductVersion },
    });
    await expect(bindFluxPcbEditorSuite({ toolchain: rebound, runner: value.kicad.runner })).rejects.toThrow(/link|junction|canonical/iu);
    expect(value.kicad.calls).toHaveLength(0);
  });

  it("rejects replacement before launch and detects replacement immediately after one injected launch", async () => {
    const before = await fixture(); const first = await bindFluxPcbEditorSuite({ toolchain: before.kicad.toolchain, runner: before.kicad.runner });
    const original = await readFile(before.kicad.pcbnewPath); await rename(before.kicad.pcbnewPath, `${before.kicad.pcbnewPath}.old`); await writeFile(before.kicad.pcbnewPath, original);
    let launches = 0;
    await expect(launchFluxPcbEditor(first, path.join(before.root, "board.kicad_pcb"), ipcEndpoint(before.root), async () => { launches += 1; return launched(1); })).rejects.toThrow(/replaced/iu);
    expect(launches).toBe(0);

    const after = await fixture(); const second = await bindFluxPcbEditorSuite({ toolchain: after.kicad.toolchain, runner: after.kicad.runner });
    launches = 0;
    let claimedLaunches = 0;
    await expect(launchFluxPcbEditor(second, path.join(after.root, "board.kicad_pcb"), ipcEndpoint(after.root), async () => {
      launches += 1;
      const current = await readFile(after.kicad.pcbnewPath); await rename(after.kicad.pcbnewPath, `${after.kicad.pcbnewPath}.old`); await writeFile(after.kicad.pcbnewPath, current);
      return launched(2);
    }, undefined, {}, () => { claimedLaunches += 1; })).rejects.toThrow(/replaced/iu);
    expect(launches).toBe(1);
    expect(claimedLaunches).toBe(1);

    const duringCallback = await fixture(); const third = await bindFluxPcbEditorSuite({ toolchain: duringCallback.kicad.toolchain, runner: duringCallback.kicad.runner });
    launches = 0;
    await expect(launchFluxPcbEditor(third, path.join(duringCallback.root, "board.kicad_pcb"), ipcEndpoint(duringCallback.root), async () => { launches += 1; return launched(3); }, async () => {
      const current = await readFile(duringCallback.kicad.pcbnewPath);
      await rename(duringCallback.kicad.pcbnewPath, `${duringCallback.kicad.pcbnewPath}.during-callback`);
      await writeFile(duringCallback.kicad.pcbnewPath, current);
    })).rejects.toThrow(/replaced/iu);
    expect(launches).toBe(0);

    const rootSwap = await fixture(); const fourth = await bindFluxPcbEditorSuite({ toolchain: rootSwap.kicad.toolchain, runner: rootSwap.kicad.runner });
    const oldRoot = `${rootSwap.kicad.toolchain.binRoot}.old`;
    await rename(rootSwap.kicad.toolchain.binRoot, oldRoot); await mkdir(rootSwap.kicad.toolchain.binRoot);
    await Promise.all([
      readFile(path.join(oldRoot, "kicad-cli.exe")).then((bytes) => writeFile(rootSwap.kicad.cliPath, bytes)),
      readFile(path.join(oldRoot, "pcbnew.exe")).then((bytes) => writeFile(rootSwap.kicad.pcbnewPath, bytes)),
    ]);
    launches = 0;
    await expect(launchFluxPcbEditor(fourth, path.join(rootSwap.root, "board.kicad_pcb"), ipcEndpoint(rootSwap.root), async () => { launches += 1; return launched(4); })).rejects.toThrow(/replaced/iu);
    expect(launches).toBe(0);
  });

  it("propagates an awaited launch error without a second launch attempt", async () => {
    const value = await fixture(); const binding = await bindFluxPcbEditorSuite({ toolchain: value.kicad.toolchain, runner: value.kicad.runner });
    let launches = 0;
    await expect(launchFluxPcbEditor(binding, path.join(value.root, "board.kicad_pcb"), ipcEndpoint(value.root), async () => { launches += 1; throw new Error("spawn rejected"); })).rejects.toThrow("spawn rejected");
    expect(launches).toBe(1);
  });

  it("rejects an invalid explicit IPC endpoint before the GUI launch", async () => {
    const value = await fixture();
    const binding = await bindFluxPcbEditorSuite({ toolchain: value.kicad.toolchain, runner: value.kicad.runner });
    let launches = 0;
    await expect(launchFluxPcbEditor(binding, path.join(value.root, "board.kicad_pcb"), { ...ipcEndpoint(value.root), endpoint: "ipc://relative.sock" }, async () => {
      launches += 1;
      return launched(7);
    })).rejects.toThrow(/socket endpoint/iu);
    expect(launches).toBe(0);
  });

  it.skipIf(process.platform !== "win32")("preflights the installed KiCad 10.0.3 suite through CLI and PE bytes without executing pcbnew", async () => {
    const cliPath = path.resolve(process.env.EVLEDA_KICAD_CLI ?? "C:\\Program Files\\KiCad\\10.0\\bin\\kicad-cli.exe");
    const binRoot = path.dirname(cliPath);
    const toolchain = createFluxKicadToolchainBinding({
      binRoot,
      kicadCli: { path: cliPath, contentIdentity: { algorithm: "sha256", digest: "4e1910666330fa8f2321d4e616957dacab218a0d835c343c869a87757481c2f4", size: 2_696_544 }, operationalVersion: "10.0.3", operationalCommit: "146a4f2a7585c65bc580427a19b6fe2ec4a3f622", peFileVersion: "10.0.3.49839", peProductVersion: "10.0.3" },
      pcbnew: { path: path.join(binRoot, "pcbnew.exe"), contentIdentity: { algorithm: "sha256", digest: "dd82d65ab09c293d1778b643b2f0b529e161e0dfc50445f1a0dd70c26efbb20f", size: 996_192 }, peFileVersion: "10.0.3.49839", peProductVersion: "10.0.3" },
    });
    const binding = await bindFluxPcbEditorSuite({ toolchain });
    expect(binding.kicadCli.pe).toMatchObject({ fileVersion: "10.0.3.49839", productVersion: "10.0.3" });
    expect(binding.pcbnew.pe).toMatchObject({ originalFilename: "pcbnew.exe", internalName: "pcbnew" });
    expect(createHash("sha256").update(await readFile(binding.pcbnew.file.path)).digest("hex")).toBe(toolchain.pcbnew.contentIdentity.digest);
  });
});
