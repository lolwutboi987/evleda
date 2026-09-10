import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const runtimeRoot = path.resolve(process.env.EVLEDA_KICAD_INSPECTION_RUNTIME_ROOT
  ?? path.join("..", "working-runtime", "inspection-runtime-3.33.3-doc5"));
const python = path.join(runtimeRoot, "environment", "Scripts", "python.exe");
const launcher = path.join(runtimeRoot, "kicad-inspection-launcher.py");
const launcherSource = path.resolve("sidecars", "kicad-inspection-launcher-doc4.py");
const kicadCli = process.env.EVLEDA_KICAD_CLI
  ?? path.join(process.env.ProgramFiles ?? "C:\\Program Files", "KiCad", "10.0", "bin", "kicad-cli.exe");
const temporaryRoot = path.resolve(tmpdir());
const owned: string[] = [];

afterEach(async () => {
  for (const root of owned.splice(0)) {
    const relative = path.relative(temporaryRoot, root);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Workspace test cleanup escaped its temporary root.");
    await rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 });
  }
});

const fixture = async () => {
  const root = await mkdtemp(path.join(temporaryRoot, "evleda-workspace-startup-"));
  owned.push(root);
  const workspace = path.join(root, "compilation");
  const project = path.join(workspace, "project");
  const output = path.join(workspace, ".evleda-mcp-output");
  const cwd = path.join(root, "private-cwd");
  const home = path.join(root, "private-home");
  await Promise.all([project, cwd, home].map(async (directory) => await mkdir(directory, { recursive: true })));
  await Promise.all([workspace, project].map(async (directory) => await writeFile(path.join(directory, ".env"), "KICAD_MCP_OPERATING_MODE=manufacturing\nKICAD_MCP_TELEMETRY_ENABLED=true\n", "utf8")));
  return { root, workspace, project, output, cwd, home };
};

// Invoke the actual launcher entrypoint and the actual pinned sidecar settings
// and ERC output setup. Only the blocking MCP server loop is replaced; no GUI,
// CLI process, MCP connection, or package file modification is performed.
const settingsProbe = String.raw`
import json, os, sys
from pathlib import Path
launcher, scenario, mode, workspace, project, output = sys.argv[1:]
def run_server(**options):
    from kicad_mcp.config import get_config, reset_config
    reset_config()
    cfg = get_config()
    startup = cfg.project_dir is None and cfg.output_dir is None
    workspace_matches = cfg.workspace == Path(workspace).resolve()
    if scenario == "mismatched-project":
        try:
            cfg.apply_project(Path(project), output_dir=Path(output))
        except ValueError:
            print(json.dumps({"workspaceMatches": workspace_matches, "mismatchRejected": True}))
            return
        raise AssertionError("mismatched workspace accepted project/output")
    cfg.apply_project(Path(project), output_dir=Path(output))
    from kicad_mcp.tools.export_support import _ensure_output_dir
    result = _ensure_output_dir()
    try:
        cfg.ensure_output_dir("../outside")
    except ValueError:
        escape_rejected = True
    else:
        escape_rejected = False
    print(json.dumps({
        "workspaceMatches": workspace_matches,
        "startupProjectAndOutputDeferred": startup,
        "siblingOutputResolved": result == Path(output).resolve() and result.parent == Path(project).parent,
        "outputCreated": result.is_dir(),
        "escapeRejected": escape_rejected,
        "mode": cfg.operating_mode,
        "telemetry": cfg.telemetry_enabled,
        "projectArgumentDeferred": options["project_dir"] is None,
        "bytecodeDisabled": bool(sys.flags.dont_write_bytecode and sys.dont_write_bytecode),
    }))
from kicad_mcp import server as upstream_server
upstream_server._run_server_from_options = run_server
sys.argv = [launcher, "--profile", "full", "--mode", mode]
namespace = {"__name__": "launcher_probe", "__file__": launcher}
with open(launcher, encoding="utf-8") as source:
    exec(compile(source.read(), launcher, "exec"), namespace)
namespace["main"]()
`;

function runProbe(value: Awaited<ReturnType<typeof fixture>>, mode: "readonly" | "write", extraEnvironment: NodeJS.ProcessEnv = {}, scenario = "valid", entrypoint = launcher) {
  return spawnSync(python, ["-I", "-s", "-E", "-B", "-c", settingsProbe, entrypoint, scenario, mode, value.workspace, value.project, value.output], {
    cwd: value.cwd,
    env: {
      SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      PATH: "",
      HOME: value.home, USERPROFILE: value.home,
      LOCALAPPDATA: path.join(value.home, "AppData", "Local"), APPDATA: path.join(value.home, "AppData", "Roaming"),
      TEMP: value.cwd, TMP: value.cwd,
      KICAD_MCP_WORKSPACE_ROOT: value.workspace,
      KICAD_MCP_KICAD_CLI: kicadCli,
      KICAD_MCP_TRANSPORT: "stdio", KICAD_MCP_OPERATING_MODE: mode, KICAD_MCP_PROFILE: "full",
      KICAD_MCP_TELEMETRY_ENABLED: "false", KICAD_MCP_ENABLE_EXPERIMENTAL_TOOLS: "false",
      PYTHONNOUSERSITE: "1", PYTHONSAFEPATH: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHON_DOTENV_DISABLED: "1",
      KICAD_API_SOCKET: `ipc://${path.join(value.root, "api.sock")}`,
      KICAD_MCP_KICAD_SOCKET_PATH: `ipc://${path.join(value.root, "api.sock")}`,
      ...extraEnvironment,
    },
    encoding: "utf8", timeout: 15_000, maxBuffer: 128 * 1024, windowsHide: true, shell: false,
  });
}

describe.runIf(process.platform === "win32")("manifested sidecar startup workspace", () => {
  it.each(["readonly", "write"] as const)("reproduces source and installed launcher behavior in %s mode", async (mode) => {
    const value = await fixture();
    expect(await readFile(launcher)).toEqual(await readFile(launcherSource));
    const result = runProbe(value, mode);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ workspaceMatches: true, startupProjectAndOutputDeferred: true, siblingOutputResolved: true, outputCreated: true, escapeRejected: true, mode, telemetry: false, bytecodeDisabled: true });
  });

  it.each(["readonly", "write"] as const)("keeps sibling ERC output inside the host workspace in %s mode through pinned settings", async (mode) => {
    const value = await fixture();
    const result = runProbe(value, mode);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ workspaceMatches: true, startupProjectAndOutputDeferred: true, siblingOutputResolved: true, outputCreated: true, escapeRejected: true, mode, telemetry: false, projectArgumentDeferred: true, bytecodeDisabled: true });
    expect(await readFile(path.join(value.project, ".env"), "utf8")).toContain("manufacturing");
  });

  it.each(["missing", "relative", "file", "alias"])("rejects a %s startup workspace before loading sidecar settings", async (kind) => {
    const value = await fixture();
    let workspace: string | undefined;
    if (kind === "relative") workspace = "compilation";
    else if (kind === "file") {
      workspace = path.join(value.root, "not-a-directory");
      await writeFile(workspace, "ordinary file", "utf8");
    } else if (kind === "alias") {
      workspace = path.join(value.root, "alias");
      await symlink(value.workspace, workspace, "junction");
    }
    const result = runProbe(value, "readonly", { KICAD_MCP_WORKSPACE_ROOT: workspace });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(64);
    expect(result.stdout).toBe("");
  });

  it.each(["KICAD_MCP_PROJECT_DIR", "KICAD_MCP_PROJECT_FILE", "KICAD_MCP_PCB_FILE", "KICAD_MCP_SCH_FILE", "KICAD_MCP_OUTPUT_DIR"])("rejects startup %s while project binding is deferred", async (key) => {
    const value = await fixture();
    const result = runProbe(value, "write", { [key]: "" });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(64);
    expect(result.stdout).toBe("");
  });

  it("rejects a deferred project/output pair outside the explicit startup workspace", async () => {
    const value = await fixture();
    const otherWorkspace = path.join(value.root, "other-workspace");
    await mkdir(otherWorkspace);
    const result = runProbe(value, "write", { KICAD_MCP_WORKSPACE_ROOT: otherWorkspace }, "mismatched-project");
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ workspaceMatches: false, mismatchRejected: true });
  });
});
