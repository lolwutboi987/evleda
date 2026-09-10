import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/core/canonical.js";
import {
  KicadMcpTerminationUncertainError,
  createKicadMcpExpectedExecutableIdentity,
} from "../../src/integrations/kicad-mcp-session.js";

import {
  KICAD_FRESH_SIDECAR_REQUIRED_TOOL_NAMES,
  KICAD_HARNESS_TOOL_NAMES,
  evaluateLedIndicatorAcceptance,
  PCB_AGENT_MIN_ITERATIONS,
  PCB_AGENT_MAX_FRESH_ITERATIONS,
  type FreshAcceptanceResult,
  type KicadHarnessSession,
} from "../../src/harness/index.js";
import {
  parsePcbAgentCliArgs,
  compactNativeValidationEvidence,
  DIRECT_KICAD_MCP_VERSION_PROBE_MAX_OUTPUT_BYTES,
  DIRECT_KICAD_MCP_VERSION_PROBE_TIMEOUT_MS,
  directKicadMcpCandidateLabel,
  directKicadMcpFallbackFailure,
  freshConnectivityParityOutputDirectory,
  isUnsafeFreshConnectivityTerminal,
  pcbAgentUsage,
  reconcileFreshTerminalHarness,
  runPcbAgentCli,
  verifyDirectKicadMcpExecutable,
  type PcbAgentCliOptions,
} from "../../src/cli/pcb-agent.js";

const owned = new Set<string>();

async function temporaryProject(): Promise<{ readonly source: string; readonly output: string; readonly root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "evleda-pcb-agent-"));
  owned.add(root);
  const source = path.join(root, "source");
  const output = path.join(root, "output");
  await writeFile(path.join(root, "placeholder"), "x");
  await mkdir(source);
  await writeFile(path.join(source, "board.kicad_pcb"), "(kicad_pcb (version 20240108))\n");
  return { source, output, root };
}

afterEach(async () => {
  await Promise.all([...owned].map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
    owned.delete(directory);
  }));
});

const options = (source: string, output: string, iterations = 1): PcbAgentCliOptions => ({
  workflowKind: "copied_project",
  prompt: "Add a short route to U1.",
  provider: "openai",
  model: "gpt-test",
  projectDir: source,
  outputDir: output,
  iterations,
  openAiServiceTier: "fast",
  mode: "run",
});

const freshOptions = (outputDir: string, name: string, mode: "run" | "prepare" = "run"): PcbAgentCliOptions => ({
  workflowKind: "led_compatibility_fixture",
  prompt: "Build the closed fresh LED fixture.", provider: "openai", model: "gpt-test",
  newProjectName: name, outputDir, iterations: 1, openAiServiceTier: "fast", mode,
});

const toolNames = [...KICAD_HARNESS_TOOL_NAMES];

function fakeSession(drc = "clean"): KicadHarnessSession {
  return {
    listTools: () => toolNames.map((name) => ({ name, permission: "write" as const, description: name, inputSchema: { type: "object" } })),
    callTool: async (name) => ({
      content: [],
      structuredContent: name === "run_drc"
        ? { status: drc, findings: drc === "clean" ? [] : [{ severity: "error", message: "clearance violation" }], metadata: { violations: drc === "clean" ? 0 : 1, unconnected_items: 0, courtyard_issues: 0 } }
        : name === "run_erc"
          ? { status: "clean", findings: [], metadata: { violation_count: 0 } }
          : name === "pcb_visual_qa"
            ? { status: "clean", findings: [], footprint_count: 1, board_bounds: [0, 0, 30, 20] }
          : name === "pcb_get_board_summary"
            ? { status: "clean", findings: [], metadata: { footprints: 1, nets: 1, tracks: 1, shapes: 1 } }
            : { ok: true },
    }),
  };
}

function freshSession(
  projectRoot: string,
  drc = "clean",
  connectivityResults: readonly string[] = ["The active schematic has no connectivity to summarize."],
): KicadHarnessSession {
  let connectivityReads = 0;
  return {
    assertActivePcb: async (expected) => { expect(path.dirname(expected)).toBe(projectRoot); },
    readActivePcbSource: async (expected) => await readFile(expected, "utf8"),
    listTools: () => KICAD_FRESH_SIDECAR_REQUIRED_TOOL_NAMES.filter((name) => name !== "evleda_get_live_pcb_document").map((name) => ({
      name, permission: "write" as const, description: name, inputSchema: { type: "object" },
    })),
    callTool: async (name) => {
      if (name === "pcb_save") {
        const pcb = (await readdir(projectRoot)).find((entry) => entry.endsWith(".kicad_pcb"));
        if (pcb !== undefined) await writeFile(path.join(projectRoot, pcb), `${await readFile(path.join(projectRoot, pcb), "utf8")} `);
      }
      return {
        content: [],
        structuredContent: name === "run_drc"
          ? { status: drc, findings: drc === "clean" ? [] : [{ severity: "error", message: "clearance violation" }], metadata: { violations: drc === "clean" ? 0 : 1, unconnected_items: 0, courtyard_issues: 0 } }
          : name === "run_erc"
            ? { status: "clean", findings: [], metadata: { violation_count: 0 } }
            : name === "pcb_visual_qa"
              ? { status: "clean", findings: [], footprint_count: 4, board_bounds: [0, 0, 30, 20] }
            : name === "pcb_get_board_summary"
              ? { status: "clean", findings: [], metadata: { footprints: 4, nets: 3, tracks: 5, shapes: 1 } }
              : name === "sch_get_connectivity_graph"
                ? { result: connectivityResults[Math.min(connectivityReads++, connectivityResults.length - 1)] }
                : { ok: true },
      };
    },
  };
}

const editFetch = async (): Promise<Response> => new Response(JSON.stringify({
  status: "completed",
  id: "resp-edit-1",
  error: null,
  incomplete_details: null,
  output: [{ id: "fc-edit-1", type: "function_call", status: "completed", call_id: "edit-1", name: "pcb_add_track", arguments: "{}" }],
}), { status: 200, headers: { "content-type": "application/json" } });

describe("pcb-agent CLI", () => {
  it("uses collision-free confined parity directories across resumed process counters", () => {
    const root = path.resolve("C:/isolated/fresh-run");
    const first = freshConnectivityParityOutputDirectory(root, "11111111-1111-4111-8111-111111111111");
    const resumed = freshConnectivityParityOutputDirectory(root, "22222222-2222-4222-8222-222222222222");
    expect(first).not.toBe(resumed);
    expect(path.dirname(first)).toBe(root);
    expect(path.dirname(resumed)).toBe(root);
    expect(() => freshConnectivityParityOutputDirectory(root, "../escape")).toThrow(/UUID/iu);
    expect(isUnsafeFreshConnectivityTerminal({ summary: "FRESH_CONNECTIVITY_ROLLBACK_FAILED_TERMINAL: disk uncertain" })).toBe(true);
    expect(isUnsafeFreshConnectivityTerminal({ summary: "FRESH_CONNECTIVITY_PLACEMENT_ROLLED_BACK_TERMINAL: live state uncertain" })).toBe(true);
    expect(isUnsafeFreshConnectivityTerminal({ summary: "FRESH_ROUTE_REPLACEMENT_ROLLED_BACK_TERMINAL: recovered" })).toBe(true);
    expect(isUnsafeFreshConnectivityTerminal({ summary: "FRESH_SYNC_ROLLBACK_FAILED_TERMINAL: uncertain" })).toBe(true);
    expect(isUnsafeFreshConnectivityTerminal({ summary: "FRESH_BOARD_COMPOUND_ROLLED_BACK_TERMINAL: recovered" })).toBe(true);
    expect(isUnsafeFreshConnectivityTerminal({ summary: "ordinary validation failure" })).toBe(false);
  });
  it("accepts a direct sidecar fallback only after a bounded exact-version check", async () => {
    const { root } = await temporaryProject();
    const invocations: Parameters<import("../../src/integrations/bounded-process.js").BoundedProcessRunner>[0][] = [];
    const runner = async (invocation: Parameters<import("../../src/integrations/bounded-process.js").BoundedProcessRunner>[0]) => {
      invocations.push(invocation);
      return {
        command: invocation.command, args: invocation.args, cwd: invocation.cwd, exitCode: 0,
        stdout: JSON.stringify({ package: { name: "kicad-mcp-pro", version: "3.33.3" } }), stderr: "",
        // Simulates a valid probe that needed longer than the former five-second bound without sleeping.
        durationMs: 6_001, startedAt: "2026-09-06T00:00:00.000Z",
      };
    };
    const expected = await createKicadMcpExpectedExecutableIdentity(process.execPath);
    await expect(verifyDirectKicadMcpExecutable(process.execPath, root, expected, {
      ...process.env,
      PATH: "C:\\attacker-path",
      PATHEXT: ".EXE;.BAT;.CMD",
      OPENAI_API_KEY: "sk-must-not-cross-probe",
    }, runner)).resolves.toBe(await realpath(process.execPath));
    expect(invocations).toEqual([expect.objectContaining({
      command: await realpath(process.execPath),
      args: ["version", "--json"],
      cwd: root,
      timeoutMs: 30_000,
      maxOutputBytes: 16 * 1024,
    })]);
    expect(invocations[0]!.env).not.toHaveProperty("PATH");
    expect(invocations[0]!.env).not.toHaveProperty("PATHEXT");
    expect(invocations[0]!.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(DIRECT_KICAD_MCP_VERSION_PROBE_TIMEOUT_MS).toBe(30_000);
    expect(DIRECT_KICAD_MCP_VERSION_PROBE_MAX_OUTPUT_BYTES).toBe(16_384);
    await expect(verifyDirectKicadMcpExecutable(process.execPath, root, expected, process.env, async (invocation) => ({
      command: invocation.command, args: invocation.args, cwd: invocation.cwd, exitCode: 0,
      stdout: JSON.stringify({ package: { name: "kicad-mcp-pro", version: "9.9.9" } }), stderr: "", durationMs: 1, startedAt: "2026-09-06T00:00:00.000Z",
    }))).rejects.toThrow(/not kicad-mcp-pro 3\.33\.3/iu);
  });

  it("collapses raw launch failures and path-labels into categorical evidence", () => {
    const cached = path.join("D:\\cache", "archive-v0", "3leWt0H2aCaOpxjF", "Scripts", "kicad-mcp-pro.exe");
    const configured = path.join("D:\\runtime", "bin", "kicad-mcp-pro.exe");
    expect(directKicadMcpCandidateLabel(cached)).toMatch(/^direct-candidate-[a-f0-9]{16}$/u);
    expect(directKicadMcpCandidateLabel(configured)).toMatch(/^direct-candidate-[a-f0-9]{16}$/u);
    expect(directKicadMcpCandidateLabel(cached)).not.toBe(directKicadMcpCandidateLabel(configured));

    const original = new Error("uvx startup exceeded its MCP readiness bound");
    const rejected = new Error("version probe returned invalid JSON");
    const failure = directKicadMcpFallbackFailure(original, [
      { label: directKicadMcpCandidateLabel(cached), status: "rejected", error: rejected },
      { label: "other/kicad-mcp-pro.exe", status: "unavailable" },
    ]);
    expect(failure.message).toContain("failed closed");
    expect(failure.message).not.toContain(original.message);
    expect(failure.message).not.toContain(rejected.message);
    expect(failure.message).not.toContain("3leWt0H2aCaOpxjF");
    expect(failure.cause).toBeUndefined();
  });

  it("detects an executable A-to-B-to-A replacement during a direct probe", async () => {
    const { root } = await temporaryProject();
    const executable = path.join(root, process.platform === "win32" ? "direct.exe" : "direct");
    const replacement = path.join(root, "replacement.bin");
    const parked = path.join(root, "parked.bin");
    await copyFile(process.execPath, executable);
    await writeFile(replacement, "replacement executable bytes", "utf8");
    if (process.platform !== "win32") await Promise.all([chmod(executable, 0o700), chmod(replacement, 0o700)]);
    const expected = await createKicadMcpExpectedExecutableIdentity(executable);
    await expect(verifyDirectKicadMcpExecutable(executable, root, expected, process.env, async (invocation) => {
      await rename(executable, parked);
      await rename(replacement, executable);
      await rename(executable, replacement);
      await rename(parked, executable);
      return {
        command: invocation.command, args: invocation.args, cwd: invocation.cwd, exitCode: 0,
        stdout: JSON.stringify({ package: { name: "kicad-mcp-pro", version: "3.33.3" } }), stderr: "",
        durationMs: 1, startedAt: "2026-09-07T00:00:00.000Z",
      };
    })).rejects.toThrow(/identity changed during its probe/iu);
    expect((await createKicadMcpExpectedExecutableIdentity(executable)).sha256).toBe(expected.sha256);
  });

  it("never reflects raw direct-probe output into a stable error", async () => {
    const { root } = await temporaryProject();
    const expected = await createKicadMcpExpectedExecutableIdentity(process.execPath);
    const secret = "sk-direct-probe-secret C:/private/provider-prompt.txt";
    let caught: unknown;
    try {
      await verifyDirectKicadMcpExecutable(process.execPath, root, expected, process.env, async (invocation) => ({
        command: invocation.command, args: invocation.args, cwd: invocation.cwd, exitCode: 0,
        stdout: secret, stderr: secret, durationMs: 1, startedAt: "2026-09-07T00:00:00.000Z",
      }));
    } catch (error) { caught = error; }
    expect(String(caught)).not.toContain(secret);
    expect(JSON.stringify(caught)).not.toContain(secret);
  });

  it("parses prompt files and rejects ambiguous or unsafe arguments", async () => {
    const { root, source, output } = await temporaryProject();
    const promptFile = path.join(root, "prompt.txt");
    await writeFile(promptFile, "Route J1 to U1.\n");
    await expect(parsePcbAgentCliArgs([
      "--prompt", "x", "--model", "m", "--project-dir", source, "--output-dir", output,
    ])).rejects.toThrow(/--workflow is required/iu);
    await expect(parsePcbAgentCliArgs([
      "--workflow", "copied_project",
      "--prompt-file", promptFile, "--model", "claude-test", "--provider", "anthropic",
      "--project-dir", source, "--output-dir", output, "--iterations", "5",
    ])).resolves.toMatchObject({ prompt: "Route J1 to U1.", provider: "anthropic", iterations: 5 });
    await expect(parsePcbAgentCliArgs([
      "--workflow", "copied_project",
      "--prompt", "x", "--prompt-file", promptFile, "--model", "m", "--project-dir", source, "--output-dir", output,
    ])).rejects.toThrow(/exactly one/iu);
    await expect(parsePcbAgentCliArgs([
      "--workflow", "copied_project",
      "--prompt", "x", "--model", "m", "--project-dir", source, "--output-dir", output, "--iterations", "6",
    ])).rejects.toThrow(/1 through 5/iu);
    await expect(parsePcbAgentCliArgs([
      "--workflow", "copied_project",
      "--prompt", "x", "--model", "m", "--provider", "codex", "--project-dir", source, "--output-dir", output,
    ])).resolves.toMatchObject({ provider: "codex", openAiServiceTier: "fast", iterations: 3 });
    await expect(parsePcbAgentCliArgs([
      "--workflow", "copied_project",
      "--prompt", "x", "--model", "m", "--provider", "claude-cli", "--project-dir", source, "--output-dir", output,
    ])).resolves.toMatchObject({ provider: "claude-cli" });
    const freshArguments = (iterations: number) => ["--workflow", "led_compatibility_fixture", "--prompt", "x", "--model", "m",
      "--new-project", "led", "--output-dir", path.join(root, `fresh-${iterations}`), "--prepare", "--iterations", String(iterations)];
    await expect(parsePcbAgentCliArgs(freshArguments(PCB_AGENT_MAX_FRESH_ITERATIONS))).resolves.toMatchObject({ workflowKind: "led_compatibility_fixture", iterations: PCB_AGENT_MAX_FRESH_ITERATIONS });
    await expect(parsePcbAgentCliArgs(freshArguments(PCB_AGENT_MAX_FRESH_ITERATIONS + 1))).rejects.toThrow(`through ${PCB_AGENT_MAX_FRESH_ITERATIONS}`);
    await expect(parsePcbAgentCliArgs(freshArguments(PCB_AGENT_MIN_ITERATIONS - 1))).rejects.toThrow(`from ${PCB_AGENT_MIN_ITERATIONS}`);
    expect(pcbAgentUsage).toContain("openai|anthropic|codex|claude-cli");
  });

  it("copies the source, saves, validates with actual sidecar names, and writes an offline report", async () => {
    const { source, output } = await temporaryProject();
    await mkdir(path.join(source, ".kicad-mcp"));
    await writeFile(path.join(source, ".kicad-mcp", "visual-diff-before.kicad_sch"), "(backup snapshot)\n");
    const calls: string[] = [];
    const initializations: Record<string, unknown>[] = [];
    const execution = await runPcbAgentCli(options(source, output), {
      environment: { OPENAI_API_KEY: "test-key" },
      fetch: editFetch,
      sessionFactory: async (sessionOptions) => {
        const session = fakeSession();
        return { ...session, callTool: async (name, args) => {
          calls.push(name);
          if (name === "kicad_set_project") initializations.push({ ...args });
          if (name === "pcb_save") await writeFile(path.join(sessionOptions.projectRoot, "board.kicad_pcb"), "(kicad_pcb (version 20240108) (saved yes))\n");
          return await session.callTool(name, args);
        } };
      },
    });
    expect(execution.exitCode).toBe(0);
    expect(execution.report.status).toBe("completed");
    expect(calls).toEqual(["kicad_set_project", "pcb_add_track", "pcb_save", "run_erc", "run_drc", "pcb_get_board_summary", "pcb_visual_qa"]);
    expect(initializations).toEqual([expect.objectContaining({
      project_dir: execution.isolatedProjectPath,
      pcb_file: path.join(execution.isolatedProjectPath, "board.kicad_pcb"),
      output_dir: path.join(output, ".evleda-mcp-output"),
    })]);
    expect(initializations[0]).not.toHaveProperty("sch_file");
    expect(Object.values(initializations[0]!).every((value) => typeof value !== "string" || value.length > 0)).toBe(true);
    await expect(readFile(path.join(source, "board.kicad_pcb"), "utf8")).resolves.toContain("kicad_pcb");
    await expect(readFile(path.join(execution.isolatedProjectPath, "board.kicad_pcb"), "utf8")).resolves.toContain("kicad_pcb");
    await expect(readFile(execution.reportPath, "utf8")).resolves.toContain('"status": "completed"');
    const terminalMismatch = reconcileFreshTerminalHarness(execution.report.harness!, {
      passed: false, missing: ["drc [unknown]: transient terminal evidence loss"],
    } as FreshAcceptanceResult);
    expect(terminalMismatch.status).toBe("needs_review");
    expect(terminalMismatch.summary).toContain("drc [unknown]");
    expect(terminalMismatch.validation.status).toBe("unresolved");
    expect(terminalMismatch.validation.unresolvedItems).toContain("drc [unknown]: transient terminal evidence loss");
  });

  it.each([
    { status: "completed", identity: undefined },
    { status: "completed", identity: { session: "test-session" } },
    { status: "blocked", identity: undefined },
    { status: "blocked", identity: { session: "test-session" } },
  ] as const)("returns a canonical $status report matching disk without an unavailable lock (identity: $identity)", async ({ status, identity }) => {
    const { source, output } = await temporaryProject();
    const execution = await runPcbAgentCli(options(source, output), {
      environment: { OPENAI_API_KEY: "test-key" },
      fetch: status === "completed" ? editFetch : async () => new Response(JSON.stringify({
        id: "resp-blocked", status: "completed", error: null, incomplete_details: null,
        output: [], refusal: "The provider cannot perform this edit.",
      }), { status: 200, headers: { "content-type": "application/json" } }),
      sessionFactory: async (sessionOptions) => {
        const session = fakeSession();
        return { ...session, ...(identity === undefined ? {} : { identity }), callTool: async (name, args) => {
          if (name === "pcb_save") await writeFile(path.join(sessionOptions.projectRoot, "board.kicad_pcb"), "(kicad_pcb (saved yes))\n");
          return await session.callTool(name, args);
        } };
      },
    });
    expect(execution.report.status).toBe(status);
    expect(execution.exitCode).toBe(status === "completed" ? 0 : 1);
    const persistedReport = JSON.parse(await readFile(execution.reportPath, "utf8"));
    expect(canonicalJson(execution.report)).toBe(canonicalJson(persistedReport));
    expect(execution.report).toStrictEqual(persistedReport);
    expect(execution.report.sidecar).toStrictEqual({ identity: identity ?? null });
    expect(Object.hasOwn(execution.report.sidecar as object, "lock")).toBe(false);
    expect(Object.hasOwn(persistedReport.sidecar, "lock")).toBe(false);
  });

  it("relays ordered local progress and emits the persisted report last", async () => {
    const { source, output } = await temporaryProject();
    const events: string[] = [];
    const execution = await runPcbAgentCli(options(source, output), {
      environment: { OPENAI_API_KEY: "test-key" },
      fetch: editFetch,
      observer: async (event) => {
        events.push(event.type === "operation" ? `operation:${event.operation.name}` : event.type);
        throw new Error("observer failure must not alter the CLI result");
      },
      sessionFactory: async (sessionOptions) => {
        const session = fakeSession();
        return { ...session, callTool: async (name, args) => {
          if (name === "pcb_save") await writeFile(path.join(sessionOptions.projectRoot, "board.kicad_pcb"), "(kicad_pcb (saved yes))\n");
          return await session.callTool(name, args);
        } };
      },
    });
    expect(execution.report.status).toBe("completed");
    expect(events).toEqual([
      "operation:pcb_add_track", "operation:pcb_save", "operation:run_erc", "operation:run_drc",
      "operation:pcb_get_board_summary", "operation:pcb_visual_qa", "validation", "report",
    ]);
  });

  it("returns the documented distinct needs-review exit code and saves its report", async () => {
    const { source, output } = await temporaryProject();
    const execution = await runPcbAgentCli(options(source, output), {
      environment: { OPENAI_API_KEY: "test-key" },
      fetch: editFetch,
      sessionFactory: async (sessionOptions) => {
        const session = fakeSession("failed");
        return { ...session, callTool: async (name, args) => {
          if (name === "pcb_save") await writeFile(path.join(sessionOptions.projectRoot, "board.kicad_pcb"), "(kicad_pcb (version 20240108) (saved yes))\n");
          return await session.callTool(name, args);
        } };
      },
    });
    expect(execution.report.status).toBe("needs_review");
    expect(execution.exitCode).toBe(2);
    await expect(readFile(execution.reportPath, "utf8")).resolves.toContain('"needs_review"');
  });

  it("persists a failed report when sidecar setup fails after the isolated copy exists", async () => {
    const { source, output } = await temporaryProject();
    const execution = await runPcbAgentCli(options(source, output), {
      environment: { OPENAI_API_KEY: "test-key" },
      fetch: editFetch,
      sessionFactory: async () => { throw new Error("fake sidecar unavailable"); },
    });
    expect(execution.exitCode).toBe(1);
    expect(execution.report.summary).toContain("fake sidecar unavailable");
    await expect(readFile(execution.reportPath, "utf8")).resolves.toContain('"status": "failed"');
  });

  it("fails closed when a fresh sidecar omits host-only durable-board recovery tools", async () => {
    const { root } = await temporaryProject();
    const execution = await runPcbAgentCli(freshOptions(path.join(root, "fresh-missing-recovery"), "fresh-missing-recovery"), {
      environment: { OPENAI_API_KEY: "test-key" },
      fetch: editFetch,
      sessionFactory: async (sessionOptions) => {
        const session = freshSession(sessionOptions.projectRoot);
        return { ...session, listTools: () => session.listTools().filter((tool) => tool.name !== "pcb_get_board_as_string") };
      },
    });
    expect(execution.report.status).toBe("failed");
    expect(execution.report.summary).toContain("pcb_get_board_as_string");
  });

  it.each(["assertActivePcb", "readActivePcbSource"] as const)("rejects missing private %s at fresh initialization before provider or project calls", async (method) => {
    const { root } = await temporaryProject();
    let providerCalls = 0;
    let projectCalls = 0;
    const execution = await runPcbAgentCli(freshOptions(path.join(root, "missing-private"), "missing-private"), {
      environment: { OPENAI_API_KEY: "test-key" },
      fetch: async () => { providerCalls += 1; return await editFetch(); },
      sessionFactory: async (sessionOptions) => {
        const session = freshSession(sessionOptions.projectRoot);
        delete session[method];
        return { ...session, callTool: async (...args) => { projectCalls += 1; return await session.callTool(...args); } };
      },
    });
    expect(execution.report.status).toBe("failed");
    expect(execution.report.summary).toContain("private active-PCB identity and raw-source ports");
    expect(providerCalls).toBe(0);
    expect(projectCalls).toBe(0);
  });

  it("requires the private native capability through bound discovery while allowing its public catalog omission", async () => {
    const { root } = await temporaryProject();
    let projectCalls = 0;
    let providerCalls = 0;
    await runPcbAgentCli(freshOptions(path.join(root, "private-hidden"), "private-hidden"), {
      environment: { OPENAI_API_KEY: "test-key" },
      fetch: async () => { providerCalls += 1; return await editFetch(); },
      sessionFactory: async (sessionOptions) => {
        expect(sessionOptions.requiredTools).toContain("evleda_get_live_pcb_document");
        const session = freshSession(sessionOptions.projectRoot);
        expect(session.listTools().map((tool) => tool.name)).not.toContain("evleda_get_live_pcb_document");
        return { ...session, callTool: async (...args) => { if (args[0] === "kicad_set_project") projectCalls += 1; return await session.callTool(...args); } };
      },
    });
    expect(projectCalls).toBe(1);
    expect(providerCalls).toBeGreaterThan(0);
  });

  it("fails before provider invocation when initialization leaves no provider-callable tools", async () => {
    const { source, output } = await temporaryProject();
    let providerCalls = 0;
    const execution = await runPcbAgentCli(options(source, output), {
      environment: { OPENAI_API_KEY: "test-key" },
      fetch: async () => { providerCalls += 1; return await editFetch(); },
      sessionFactory: async () => ({
        listTools: () => [{ name: "kicad_set_project", permission: "write", inputSchema: { type: "object" } }],
        callTool: async () => ({ content: [], structuredContent: { ok: true } }),
      }),
    });
    expect(execution.exitCode).toBe(1);
    expect(execution.report.summary).toMatch(/no controller-allowed provider-callable/i);
    expect(providerCalls).toBe(0);
  });

  it("prepares a marked copy and resumes only that matching isolated project", async () => {
    const { source, output } = await temporaryProject();
    const prepared = await runPcbAgentCli({ ...options(source, output), mode: "prepare" });
    expect(prepared.exitCode).toBe(0);
    await expect(readFile(path.join(output, ".evleda-pcb-agent-prepared.json"), "utf8")).resolves.toContain("sourceProjectPath");
    const resumed = await runPcbAgentCli({ ...options(source, output), mode: "resume" }, {
      environment: { OPENAI_API_KEY: "test-key" }, fetch: editFetch,
      sessionFactory: async (sessionOptions) => {
        const session = fakeSession();
        return { ...session, callTool: async (name, args) => {
          if (name === "pcb_save") await writeFile(path.join(sessionOptions.projectRoot, "board.kicad_pcb"), "(kicad_pcb (saved yes))\n");
          return await session.callTool(name, args);
        } };
      },
    });
    expect(resumed.report.status).toBe("completed");
  });

  it("persists closed UNKNOWN acceptance rows and current hashes on every early fresh terminal report", async () => {
    const { root } = await temporaryProject();
    const prepared = await runPcbAgentCli(freshOptions(path.join(root, "fresh-prepare"), "fresh-prepare", "prepare"));
    expect(prepared.report.status).toBe("needs_review");
    expect(prepared.report.freshAcceptance).toMatchObject({ passed: false, sourceHashes: {
      schematicSha256: expect.stringMatching(/^[a-f0-9]{64}$/u), pcbSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    } });
    expect(prepared.report.freshAcceptance?.missing).toContainEqual(expect.stringMatching(/^erc \[unknown\]:/u));

    const early = await runPcbAgentCli(freshOptions(path.join(root, "fresh-early"), "fresh-early"), {
      environment: { OPENAI_API_KEY: "test-key" },
      fetch: async () => new Response(JSON.stringify({ id: "resp-done", status: "completed", error: null, incomplete_details: null, output: [{ id: "msg-done", type: "message", role: "assistant", status: "completed", content: [{ annotations: [], type: "output_text", text: "Done." }] }] }), { status: 200, headers: { "content-type": "application/json" } }),
      sessionFactory: async (sessionOptions) => freshSession(sessionOptions.projectRoot),
    });
    expect(early.report.status).toBe("failed");
    expect(early.report.freshAcceptance?.passed).toBe(false);
    expect(early.report.freshAcceptance?.requirements.map((row) => row.id)).toEqual(expect.arrayContaining(["symbols", "schematic-nets", "erc", "drc", "visual-practice"]));
    expect(early.report.freshAcceptance?.missing).toContainEqual(expect.stringMatching(/^drc \[unknown\]:/u));
    await expect(readFile(early.reportPath, "utf8")).resolves.toContain('"freshAcceptance"');
  });

  it("persists fresh acceptance independently when native validation remains unresolved", async () => {
    const { root } = await temporaryProject();
    const output = path.join(root, "fresh-unresolved");
    const execution = await runPcbAgentCli(freshOptions(output, "fresh-unresolved"), {
      environment: { OPENAI_API_KEY: "test-key" }, fetch: editFetch,
      sessionFactory: async (sessionOptions) => freshSession(sessionOptions.projectRoot, "failed"),
    });
    expect(execution.report.status).toBe("needs_review");
    expect(execution.report.freshAcceptance?.passed).toBe(false);
    expect(execution.report.freshAcceptance?.requirements.find((row) => row.id === "drc")?.status).toBe("fail");
    expect(execution.report.freshAcceptance?.sourceHashes.pcbSha256).toMatch(/^[a-f0-9]{64}$/u);
    await expect(readFile(execution.reportPath, "utf8")).resolves.toContain('"freshAcceptance"');
  });

  it("downgrades completed when the terminal connectivity evidence differs from the passing completion gate", async () => {
    const { root } = await temporaryProject();
    let evaluations = 0;
    const execution = await runPcbAgentCli(freshOptions(path.join(root, "fresh-terminal-drift"), "fresh-terminal-drift"), {
      environment: { OPENAI_API_KEY: "test-key" }, fetch: editFetch,
      sessionFactory: async (sessionOptions) => freshSession(sessionOptions.projectRoot, "clean", [
        "Connectivity groups (3 total):\n- Group 1: +5V | pins=J1:1, R1:1, C1:1 | points=3\n- Group 2: LED_A | pins=R1:2, D1:2 | points=2\n- Group 3: GND | pins=J1:2, D1:1, C1:2 | points=3",
        "terminal connectivity read failed",
      ]),
      freshAcceptanceEvaluator: (acceptanceEvidence) => {
        evaluations += 1;
        const actual = evaluateLedIndicatorAcceptance(acceptanceEvidence);
        return evaluations === 1 ? { ...actual, passed: true, missing: [] } : actual;
      },
    });
    expect(evaluations).toBe(2);
    expect(execution.report.status).toBe("needs_review");
    expect(execution.report.harness?.status).toBe("needs_review");
    expect(execution.report.summary).toContain("Terminal fresh acceptance recheck did not pass");
    expect(execution.report.freshAcceptance?.passed).toBe(false);
    expect(execution.report.freshAcceptance?.requirements.find((row) => row.id === "schematic-nets")?.status).toBe("unknown");
    expect(execution.report.freshAcceptance?.missing).toContainEqual(expect.stringMatching(/^schematic-nets \[unknown\]:/u));
    expect(execution.report.harness?.validation.status).toBe("unresolved");
    expect(execution.report.harness?.validation.unresolvedItems).toContainEqual(expect.stringMatching(/^schematic-nets \[unknown\]:/u));
  });

  it("compacts captured large native reports without losing count-relevant rule samples", () => {
    const report = { violations: Array.from({ length: 1_000 }, (_, index) => ({ code: `R${index}`, message: "x".repeat(220), location: `U${index}` })) };
    expect(JSON.stringify(report).length).toBeGreaterThan(225_000);
    const compact = compactNativeValidationEvidence(report);
    expect(compact).toHaveLength(12);
    expect(JSON.stringify(compact).length).toBeLessThan(4_000);
    expect(compact[0]).toContain("R0");
  });

  it("fully awaits a valid close longer than the removed legacy two-second race", async () => {
    const { source, output } = await temporaryProject();
    let closes = 0;
    const started = Date.now();
    const execution = await runPcbAgentCli(options(source, output), {
      environment: { OPENAI_API_KEY: "test-key" }, fetch: editFetch,
      sessionFactory: async (sessionOptions) => {
        const session = fakeSession("failed");
        return {
          ...session,
          callTool: async (name, args) => {
            if (name === "pcb_save") await writeFile(path.join(sessionOptions.projectRoot, "board.kicad_pcb"), "(kicad_pcb (saved yes))\n");
            return await session.callTool(name, args);
          },
          get identity() { return { sessionReceiptIdentity: { algorithm: "sha256", digest: "a".repeat(64), schemaVersion: "evleda.test-session-receipt.v1", canonicalizationVersion: "evleda-c14n-json-v1" } }; },
          close: async () => { closes += 1; await new Promise<void>((resolve) => setTimeout(resolve, 2_100)); },
        };
      },
    });
    expect(execution.exitCode).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_000);
    expect(closes).toBe(1);
    await expect(readFile(execution.reportPath, "utf8")).resolves.toContain('"needs_review"');
  }, 10_000);

  it("propagates uncertain tree teardown and never publishes a success report", async () => {
    const { source, output } = await temporaryProject();
    let closes = 0;
    const execution = runPcbAgentCli(options(source, output), {
      environment: { OPENAI_API_KEY: "test-key" }, fetch: editFetch,
      sessionFactory: async (sessionOptions) => {
        const session = fakeSession("failed");
        return {
          ...session,
          callTool: async (name, args) => {
            if (name === "pcb_save") await writeFile(path.join(sessionOptions.projectRoot, "board.kicad_pcb"), "(kicad_pcb (saved yes))\n");
            return await session.callTool(name, args);
          },
          identity: { pid: 999_999_999 },
          close: async () => { closes += 1; throw new KicadMcpTerminationUncertainError("categorical unconfirmed tree"); },
        };
      },
    });
    await expect(execution).rejects.toBeInstanceOf(KicadMcpTerminationUncertainError);
    expect(closes).toBe(1);
    const reportPath = path.join(output, "pcb-agent-report.json");
    const report = await readFile(reportPath, "utf8");
    expect(JSON.parse(report)).toMatchObject({ status: "failed" });
    expect(report).not.toContain('"status": "completed"');
  });
});
