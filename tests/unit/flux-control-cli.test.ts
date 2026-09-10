import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FLUX_CONTROL_COMMANDS, main, parseFluxControlCliArgs, runFluxControlCli } from "../../src/cli/flux-control.js";
import { canonicalIdentity } from "../../src/core/canonical.js";
import { FLUX_CHECKPOINT_FAILURE_RECEIPT_SCHEMA_VERSION, FLUX_CHECKPOINT_FAILURE_SCHEMA_VERSION, FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE, fluxDigest } from "../../src/flux/contracts.js";
import { FakeFluxControlServer } from "../helpers/fake-flux-control-server.js";

const owned = new Set<string>();
afterEach(async () => Promise.all([...owned].map(async (root) => { await rm(root, { recursive: true, force: true }); owned.delete(root); })));
const temporary = async () => { const root = await mkdtemp(path.join(os.tmpdir(), "evleda-fluxctl-")); owned.add(root); return root; };
const stdin = (value: string): AsyncIterable<unknown> => ({ async *[Symbol.asyncIterator]() { yield Buffer.from(value, "utf8"); } });

describe("JSON-only Flux control CLI", () => {
  it("has a closed candidate-only command surface and never accepts prompt text in argv", async () => {
    expect(() => parseFluxControlCliArgs(["create-run", "--prompt", "private"])).toThrow(/forbidden in argv/iu);
    expect(() => parseFluxControlCliArgs(["manufacturing-release"])).toThrow(/unsupported candidate-only/iu);
    expect(() => parseFluxControlCliArgs(["create-run", "--prompt-file", "a", "--prompt-stdin"])).not.toThrow();
    const help = await runFluxControlCli([]);
    expect(help.output).toMatchObject({ ok: true, command: "help", result: { classification: "candidate-only" } });
    expect(JSON.stringify(help.output)).not.toMatch(/authorize|execute.*manufactur|release[_-]operation/iu);
    expect(FLUX_CONTROL_COMMANDS).not.toContain("inspect-and-run");
    expect(FLUX_CONTROL_COMMANDS).not.toContain("inspection");
    expect(FLUX_CONTROL_COMMANDS).toEqual(expect.arrayContaining(["inspection-status", "inspect"]));
  });

  it("reads a prompt from stdin, sends it only in the request body, and excludes it from output and durable state", async () => {
    const root = await temporary(); const server = new FakeFluxControlServer(); const project = server.addProject(); const thread = server.addThread(project.id);
    const secret = "SECRET_STDIN_PROMPT_voltage divider";
    const stateFile = path.join(root, "intent.json");
    const argv = ["create-run", "--project-id", project.id, "--thread-id", thread.id, "--prompt-stdin", "--state-file", stateFile];
    expect(argv).not.toContain(secret);
    const execution = await runFluxControlCli(argv, { cwd: root, fetch: server.fetch, stdin: stdin(secret) });
    expect(execution.exitCode).toBe(0);
    expect(JSON.stringify(execution.output)).not.toContain(secret);
    expect(await readFile(stateFile, "utf8")).not.toContain(secret);
    const post = server.requests.find((entry) => entry.method === "POST" && entry.pathname === "/api/v1/flux/runs");
    expect(post?.body).toMatchObject({ prompt: secret, workflowKind: "generic", iterationCap: 12 });
  });

  it("accepts an explicit twenty-four iteration budget and rejects twenty-five before any request", async () => {
    const root = await temporary(); const server = new FakeFluxControlServer(); const project = server.addProject(); const thread = server.addThread(project.id);
    const argv = ["create-run", "--project-id", project.id, "--thread-id", thread.id, "--prompt-stdin", "--state-file", path.join(root, "intent.json")];
    const result = await runFluxControlCli([...argv, "--iterations", "24"], { cwd: root, fetch: server.fetch, stdin: stdin("Fresh repair budget") });
    expect(result).toMatchObject({ exitCode: 0, output: { result: { iterationCap: 24 } } });
    const count = server.requests.length;
    for (const invalid of ["25", "0", "1.5", "9007199254740992"]) {
      await expect(runFluxControlCli([...argv, "--iterations", invalid], { cwd: root, fetch: server.fetch, stdin: stdin("Fresh repair budget") })).rejects.toMatchObject({ code: "INPUT_INVALID" });
    }
    expect(server.requests).toHaveLength(count);
  });

  it("never emits an unknown server error code, remote text, credential, or path", async () => {
    const root = await temporary();
    const secretCode = "SECRET_PROMPT_CODE_LEAK";
    const secretPath = "C:\\private\\prompt-and-key.pem";
    const secretCredential = "Bearer sk-proj-not-for-output";
    const maliciousFetch: typeof globalThis.fetch = async () => new Response(JSON.stringify({
      ok: false,
      requestId: "request-malicious-code",
      error: { code: secretCode, message: secretPath, retryable: false, details: { credential: secretCredential } },
    }), { status: 422, headers: { "content-type": "application/json" } });
    let stdout = "";
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    });
    try {
      await expect(main(["readiness", "--state-file", path.join(root, "state.json")], { cwd: root, fetch: maliciousFetch })).resolves.toBe(1);
    } finally { write.mockRestore(); }
    expect(stdout).not.toContain(secretCode);
    expect(stdout).not.toContain(secretPath);
    expect(stdout).not.toContain(secretCredential);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, command: "readiness", requestId: "request-malicious-code", error: { code: "REMOTE_ERROR", remoteCode: "REMOTE_FAILURE", message: "Flux server rejected the request." } });
  });

  it("projects the closed unconfirmed-KiCad-process and inspection-bridge readiness state as JSON", async () => {
    const root = await temporary();
    const fetch: typeof globalThis.fetch = async () => new Response(JSON.stringify({
      ok: true,
      operation: "flux_readiness",
      requestId: "request-readiness-cli",
      result: { schemaVersion: "evleda.flux-readiness.v1", configured: false, status: "setup_required", reasonCodes: ["KICAD_PROCESS_TERMINATION_UNCONFIRMED", "KICAD_MCP_RUNTIME_UNAVAILABLE"], provider: null, compiler: null, toolchain: null, kicadMcpRuntime: null, diagnostic: null },
    }), { headers: { "content-type": "application/json" } });
    await expect(runFluxControlCli(["readiness", "--state-file", path.join(root, "state.json")], { cwd: root, fetch })).resolves.toMatchObject({
      exitCode: 0,
      output: { ok: true, command: "readiness", result: { configured: false, status: "setup_required", reasonCodes: ["KICAD_PROCESS_TERMINATION_UNCONFIRMED", "KICAD_MCP_RUNTIME_UNAVAILABLE"], kicadMcpRuntime: null } },
    });
  });

  it("emits a nonretryable checkpoint failure receipt and reuses the durable key on the next invocation", async () => {
    const root = await temporary(); const server = new FakeFluxControlServer(); const project = server.addProject(); const thread = server.addThread(project.id);
    const secret = "PRIVATE_CHECKPOINT_PROMPT"; const run = server.addRun(project.id, thread.id, "awaiting_checkpoint", secret);
    const statePath = path.join(root, "checkpoint-cli.json"); const keys: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if ((init?.method ?? "GET") !== "POST" || !url.pathname.endsWith("/checkpoint-open")) return server.fetch(input, init);
      const key = new Headers(init?.headers).get("idempotency-key")!; keys.push(key);
      const completedAt = "2026-09-08T00:02:00.000Z";
      server.replaceRun(run.id, { phase: "blocked", checkpointRequired: true, blockedReason: FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE, updatedAt: completedAt });
      const payload = { schemaVersion: FLUX_CHECKPOINT_FAILURE_RECEIPT_SCHEMA_VERSION, operation: "checkpoint_open", idempotencyKey: key, requestDigest: fluxDigest({ runId: run.id }), projectId: project.id, threadId: thread.id, runId: run.id,
        failureIdentity: canonicalIdentity({ code: "OPERATION_UNCERTAIN", message: FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE, details: {} }, FLUX_CHECKPOINT_FAILURE_SCHEMA_VERSION), terminalPhase: "blocked", outcome: "failed", completedAt };
      return new Response(JSON.stringify({ ok: false, requestId: `checkpoint-cli-${keys.length}`, error: { code: "OPERATION_UNCERTAIN", message: FLUX_CHECKPOINT_OPERATION_FAILURE_MESSAGE, retryable: false, details: {}, terminalFailureReceipt: { ...payload, identity: canonicalIdentity(payload, FLUX_CHECKPOINT_FAILURE_RECEIPT_SCHEMA_VERSION) } } }), { status: 409, headers: { "content-type": "application/json" } });
    };
    let stdout = "";
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"); return true; });
    try {
      for (let invocation = 0; invocation < 2; invocation += 1) await expect(main(["checkpoint", "--run-id", run.id, "--state-file", statePath], { cwd: root, fetch })).resolves.toBe(1);
    } finally { write.mockRestore(); }
    const lines = stdout.trim().split("\n"); expect(lines).toHaveLength(2);
    lines.forEach((line, index) => expect(JSON.parse(line)).toMatchObject({ ok: false, command: "checkpoint", requestId: `checkpoint-cli-${index + 1}`, error: { code: "REMOTE_ERROR", remoteCode: "OPERATION_UNCERTAIN", retryable: false, message: "Flux server rejected the request.", terminalFailureReceipt: { schemaVersion: FLUX_CHECKPOINT_FAILURE_RECEIPT_SCHEMA_VERSION, operation: "checkpoint_open", outcome: "failed", terminalPhase: "blocked" } } }));
    expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]); expect(stdout).not.toContain(secret);
    const state = await readFile(statePath, "utf8"); expect(state).toContain('"status":"terminal"'); expect(state).toContain('"lastRequestId":"checkpoint-cli-2"'); expect(state).not.toContain(secret);
  });

  it("emits pending Open timeout JSON at 120 seconds and replays the same key on the next invocation", async () => {
    vi.useFakeTimers();
    const root = await temporary(); const server = new FakeFluxControlServer(); const project = server.addProject(); const thread = server.addThread(project.id); const run = server.addRun(project.id, thread.id, "awaiting_open");
    const statePath = path.join(root, "open-timeout-cli.json");
    let hang = true; let postStarted!: () => void; const postStart = new Promise<void>((resolve) => { postStarted = resolve; });
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (hang && (init?.method ?? "GET") === "POST" && url.pathname.endsWith("/open")) {
        await server.fetch(input, init);
        return new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(new Error("lost Open response")), { once: true }); postStarted(); });
      }
      return server.fetch(input, init);
    };
    let stdout = "";
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"); return true; });
    try {
      const argv = ["open", "--run-id", run.id, "--state-file", statePath];
      const first = main(argv, { cwd: root, fetch }); await postStart;
      await vi.advanceTimersByTimeAsync(30_000); expect(stdout).toBe("");
      await vi.advanceTimersByTimeAsync(89_999); expect(stdout).toBe("");
      await vi.advanceTimersByTimeAsync(1); await expect(first).resolves.toBe(1);
      expect(JSON.parse(stdout)).toMatchObject({ ok: false, command: "open", requestId: null, error: { code: "TRANSPORT_FAILED", retryable: true } });
      expect(await readFile(statePath, "utf8")).toContain('"status":"pending"');
      stdout = ""; hang = false;
      await expect(main(argv, { cwd: root, fetch })).resolves.toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({ ok: true, command: "open", result: { opened: true }, intent: { status: "completed" } });
      const attempts = server.requests.filter((request) => request.method === "POST" && request.pathname.endsWith("/open"));
      expect(attempts).toHaveLength(2); expect(attempts[0]?.idempotencyKey).toBe(attempts[1]?.idempotencyKey); expect(vi.getTimerCount()).toBe(0);
    } finally { write.mockRestore(); vi.useRealTimers(); }
  });

  it("keeps status-only and active run-bound inspection as separate JSON commands", async () => {
    const root = await temporary(); const server = new FakeFluxControlServer(); const project = server.addProject(); const thread = server.addThread(project.id); const run = server.addRun(project.id, thread.id);
    const state = path.join(root, "inspection-state.json"); const options = { cwd: root, fetch: server.fetch };
    for (const command of ["interpret", "prepare", "open", "checkpoint"] as const) await runFluxControlCli([command, "--run-id", run.id, "--state-file", state], options);
    const status = await runFluxControlCli(["inspection-status", "--run-id", run.id, "--state-file", state], options);
    expect(status).toMatchObject({ exitCode: 0, output: { command: "inspection-status", result: { runId: run.id, state: "idle", connectionBudget: { used: 0, remaining: 8, limit: 8 } } } });
    expect(server.requests.filter((request) => request.method === "POST" && request.pathname.endsWith("/inspection"))).toHaveLength(0);
    const active = await runFluxControlCli(["inspect", "--run-id", run.id, "--state-file", state], options);
    expect(active).toMatchObject({ exitCode: 0, output: { command: "inspect", result: { runId: run.id, state: "ready", connectionBudget: { used: 1, remaining: 7, limit: 8 } }, intent: { status: "completed" } } });
    expect(server.requests.filter((request) => request.method === "POST" && request.pathname.endsWith("/inspection"))).toHaveLength(1);
  });

  it("supports an ordinary UTF-8 prompt file and rejects dual, linked, invalid-UTF8, or oversized inputs", async () => {
    const root = await temporary(); const server = new FakeFluxControlServer(); const project = server.addProject(); const thread = server.addThread(project.id);
    const promptFile = path.join(root, "prompt.txt"); await writeFile(promptFile, "File supplied generic board prompt\n", "utf8");
    const common = ["create-run", "--project-id", project.id, "--thread-id", thread.id, "--state-file", path.join(root, "state.json")];
    await expect(runFluxControlCli([...common, "--prompt-file", promptFile], { cwd: root, fetch: server.fetch })).resolves.toMatchObject({ exitCode: 0 });
    await expect(runFluxControlCli([...common, "--prompt-file", promptFile, "--prompt-stdin"], { cwd: root, fetch: server.fetch, stdin: stdin("other") })).rejects.toMatchObject({ code: "INPUT_INVALID" });
    const invalid = path.join(root, "invalid.txt"); await writeFile(invalid, Buffer.from([0xff]));
    await expect(runFluxControlCli([...common, "--prompt-file", invalid], { cwd: root, fetch: server.fetch })).rejects.toMatchObject({ code: "INPUT_INVALID" });
    const oversized = path.join(root, "large.txt"); await writeFile(oversized, "x".repeat(32 * 1024 + 1), "utf8");
    await expect(runFluxControlCli([...common, "--prompt-file", oversized], { cwd: root, fetch: server.fetch })).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });

  it("rejects deterministic pathname replacement during prompt and answer descriptor reads before any request", async () => {
    for (const kind of ["prompt", "answers"] as const) {
      const root = await temporary(); const server = new FakeFluxControlServer(); const project = server.addProject(); const thread = server.addThread(project.id); const run = server.addRun(project.id, thread.id, "awaiting_clarification");
      const inputPath = path.join(root, `${kind}.txt`);
      await writeFile(inputPath, kind === "prompt" ? "private prompt" : JSON.stringify({ answers: [{ id: "x", answer: "y" }] }), "utf8");
      let swapped = false;
      const hook = async (label: string, filePath: string) => {
        if (swapped || !label.startsWith(kind === "prompt" ? "Prompt" : "Answers")) return;
        swapped = true; const bytes = await readFile(filePath); await rename(filePath, `${filePath}.preimage`); await writeFile(filePath, bytes);
      };
      const argv = kind === "prompt"
        ? ["create-run", "--project-id", project.id, "--thread-id", thread.id, "--prompt-file", inputPath, "--state-file", path.join(root, "state.json")]
        : ["answer", "--run-id", run.id, "--answers-file", inputPath, "--state-file", path.join(root, "state.json")];
      await expect(runFluxControlCli(argv, { cwd: root, fetch: server.fetch, afterFileReadForTesting: hook })).rejects.toMatchObject({ code: "INPUT_INVALID" });
      expect(swapped).toBe(true);
      expect(server.requests).toHaveLength(0);
      await expect(readFile(path.join(root, "state.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("requires strict clarification JSON from file or stdin", async () => {
    const root = await temporary(); const server = new FakeFluxControlServer(); const project = server.addProject(); const thread = server.addThread(project.id); const run = server.addRun(project.id, thread.id, "awaiting_clarification");
    const state = path.join(root, "state.json");
    const valid = JSON.stringify({ answers: [{ id: "component.R1.value", answer: "10k" }] });
    await expect(runFluxControlCli(["answer", "--run-id", run.id, "--answers-stdin", "--state-file", state], { cwd: root, fetch: server.fetch, stdin: stdin(valid) })).resolves.toMatchObject({ exitCode: 0 });
    const duplicate = '{"answers":[],"answers":[]}';
    await expect(runFluxControlCli(["answer", "--run-id", run.id, "--answers-stdin", "--state-file", state], { cwd: root, fetch: server.fetch, stdin: stdin(duplicate) })).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });

  it("uses no browser/UI globals or dependencies", async () => {
    const current = path.dirname(fileURLToPath(import.meta.url));
    const root = path.resolve(current, "..", "..");
    const sources = await Promise.all([
      readFile(path.join(root, "src", "integrations", "flux-control-client.ts"), "utf8"),
      readFile(path.join(root, "src", "cli", "flux-control.ts"), "utf8"),
    ]);
    for (const source of sources) {
      expect(source).not.toMatch(/\b(?:window|document|localStorage|sessionStorage|navigator)\b/u);
      expect(source).not.toMatch(/(?:playwright|puppeteer|selenium|jsdom|react|vite)/iu);
      expect(source).not.toMatch(/\/ui\//u);
    }
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string>; bin: Record<string, string> };
    expect(packageJson.scripts.fluxctl).toBe("tsx src/cli/flux-control.ts");
    expect(packageJson.bin["evleda-fluxctl"]).toBe("./dist/src/cli/flux-control.js");
  });
});
