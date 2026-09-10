import { EventEmitter } from "node:events";
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { copyFile, link, mkdtemp, open, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import {
  BOUNDED_WINDOWS_PROCESS_TREE_TERMINATION_SCHEMA_VERSION,
  type BoundedWindowsProcessTreeTermination,
} from "../../src/integrations/bounded-process.js";
import {
  PROVIDER_FAILURE_EVIDENCE_MAX_BYTES,
  assertProviderFailureEvidenceMatchesDiagnostic,
  type ProviderFailureLeaf,
} from "../../src/domain/diagnostics.js";
import {
  ClaudeCliHarnessProvider,
  CLI_PROVIDER_CLEANUP_TIMEOUT_MS,
  CODEX_CLI_ASTRA_CAPTURED_MODEL,
  CODEX_CLI_ASTRA_CAPTURED_TOOL_PROFILE,
  CODEX_CLI_CAPTURED_EXECUTABLE_IDENTITY,
  CODEX_CLI_CAPTURED_MODEL,
  CODEX_CLI_CAPTURED_TOOL_PROFILE,
  CODEX_CLI_ISOLATION_ARGUMENTS,
  CODEX_CLI_PINNED_VERSION,
  CODEX_CLI_TURN_ENVELOPE_JSON_SCHEMA,
  CODEX_CLI_TURN_ENVELOPE_SCHEMA_INSPECTION,
  CODEX_CLI_TURN_ENVELOPE_SCHEMA_VERSION,
  CodexCliHarnessProvider,
  codexCliCapturedToolProfileForModel,
  inspectCodexStrictOutputSchema,
  type CliProcess,
  type CliSpawner,
} from "../../src/harness/cli-providers.js";
import {
  createHarnessProviderTurnJsonSchema,
  HARNESS_PROVIDER_TURN_JSON_SCHEMA,
  type HarnessProviderRequest,
  type HarnessProviderTurnContext,
} from "../../src/harness/contracts.js";
import { HarnessProviderError } from "../../src/harness/providers.js";

const request = {
  messages: [
    { role: "system" as const, content: "Use only supplied tools." },
    { role: "user" as const, content: "Inspect the board." },
  ],
  tools: [{ name: "pcb_get_board_summary", description: "Inspect.", inputSchema: { type: "object" } }],
};

const completed = { message: { role: "assistant", content: "Done." }, toolCalls: [], stopReason: "completed" };
const codexEnvelopeObject = (turn: unknown) => ({
  schemaVersion: CODEX_CLI_TURN_ENVELOPE_SCHEMA_VERSION,
  messageContent: (turn as typeof completed).message.content,
  hasToolCalls: (turn as typeof completed).toolCalls.length > 0,
  toolCalls: (turn as { toolCalls: Array<{ id: string; name: string; arguments: unknown }> }).toolCalls.map((call) => ({
    id: call.id,
    name: call.name,
    argumentsJson: JSON.stringify(call.arguments),
  })),
  stopReason: (turn as typeof completed).stopReason,
});
const codexEnvelope = (turn: unknown): string => JSON.stringify(codexEnvelopeObject(turn));
const originalPlatform = process.platform;

const copiedWindowsTerminationBinding = async (
  root: string,
): Promise<BoundedWindowsProcessTreeTermination | undefined> => {
  if (process.platform !== "win32") return undefined;
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (windowsRoot === undefined || !path.win32.isAbsolute(windowsRoot)) {
    throw new Error("Windows CLI tree test requires an explicit system-root source.");
  }
  const executablePath = path.join(root, "pinned-tree-terminator.exe");
  await copyFile(path.win32.join(windowsRoot, "System32", "taskkill.exe"), executablePath);
  const identity = contentIdentity(await readFile(executablePath));
  return Object.freeze({
    schemaVersion: BOUNDED_WINDOWS_PROCESS_TREE_TERMINATION_SCHEMA_VERSION,
    executablePath,
    executableIdentity: identity,
    cwd: root,
    env: Object.freeze({ SYSTEMROOT: windowsRoot, WINDIR: windowsRoot }),
  });
};

afterEach(() => { Object.defineProperty(process, "platform", { value: originalPlatform }); });

class FakeProcess extends EventEmitter implements CliProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly pid: number | undefined = undefined;
  killed = false;
  unrefCalls = 0;
  kill(): boolean {
    if (!this.killed) queueMicrotask(() => this.emit("close", null, "SIGTERM"));
    this.killed = true;
    return true;
  }
  unref(): void { this.unrefCalls += 1; }
}

const confirmFakeProcessTermination = async (
  child: CliProcess,
  closed: Promise<void>,
): Promise<void> => {
  child.kill("SIGKILL");
  await closed;
};

const codexOutputSpawner = (outputText: string): CliSpawner => (_command, args) => {
  const child = new FakeProcess();
  child.stdin.on("finish", () => {
    const output = args[args.indexOf("--output-last-message") + 1]!;
    void writeFile(output, outputText, "utf8").then(
      () => child.emit("close", 0, null),
      (error) => child.emit("error", error),
    );
  });
  return child;
};

const captureProviderError = async (operation: Promise<unknown>): Promise<HarnessProviderError> => {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(HarnessProviderError);
    return error as HarnessProviderError;
  }
  throw new Error("Expected provider operation to fail");
};

describe("local CLI harness providers", () => {
  it("uses a shallow closed Codex strict envelope and rejects unsupported schema drift", () => {
    expect(CODEX_CLI_TURN_ENVELOPE_JSON_SCHEMA).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        schemaVersion: { type: "string", enum: [CODEX_CLI_TURN_ENVELOPE_SCHEMA_VERSION] },
        messageContent: { type: "string" },
        hasToolCalls: { type: "boolean" },
        toolCalls: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              argumentsJson: { type: "string" },
            },
            required: ["id", "name", "argumentsJson"],
          },
        },
        stopReason: { type: "string", enum: ["tool_calls", "completed", "blocked"] },
      },
      required: ["schemaVersion", "messageContent", "hasToolCalls", "toolCalls", "stopReason"],
    });
    expect(CODEX_CLI_TURN_ENVELOPE_SCHEMA_INSPECTION).toEqual({ nodeCount: 10, maximumDepth: 4 });
    expect(JSON.stringify(CODEX_CLI_TURN_ENVELOPE_JSON_SCHEMA)).not.toMatch(/\$schema|oneOf|allOf|\$ref/u);
    expect(() => inspectCodexStrictOutputSchema({
      ...CODEX_CLI_TURN_ENVELOPE_JSON_SCHEMA,
      oneOf: [],
    })).toThrow(/unsupported keyword/u);
    expect(() => inspectCodexStrictOutputSchema({ type: "string", enum: ["same", "same"] }))
      .toThrow(/duplicate enum/u);
    expect(() => inspectCodexStrictOutputSchema({ type: "string", enum: ["x".repeat(15_001)] }))
      .toThrow(/enum limits/u);
  });

  it("uses Codex-compatible typed singleton fields in the strict output schema", () => {
    const schema = HARNESS_PROVIDER_TURN_JSON_SCHEMA as { properties: { message: { properties: { role: unknown } } } };
    expect(schema.properties.message.properties.role).toEqual({ type: "string", enum: ["assistant"] });
    const toolSchema = createHarnessProviderTurnJsonSchema(request.tools) as { properties: { toolCalls: { items: { anyOf: { properties: { arguments: unknown } }[] } } } };
    expect(toolSchema.properties.toolCalls.items.anyOf[0]!.properties.arguments).toMatchObject({ type: "object", additionalProperties: false, required: [] });
  });

  it("normalizes the captured sch_build_circuit nested-combinator schema without adding object fields to arrays", () => {
    const tools = [{
      name: "sch_build_circuit", description: "Build a fresh schematic.", inputSchema: {
        type: "object", additionalProperties: false, properties: {
          symbols: {
            anyOf: [
              { type: "array", items: { anyOf: [
                { type: "object", properties: { library: { type: "string" }, symbol_name: { type: "string" } }, required: ["library"] },
                { type: "object", properties: { reference: { type: "string" } }, additionalProperties: true },
              ] } },
              { type: "null" },
            ],
          },
        },
      },
    }];
    const schema = createHarnessProviderTurnJsonSchema(tools) as Record<string, unknown>;
    const toolCalls = (schema.properties as Record<string, unknown>).toolCalls as { items: { anyOf: { properties: { arguments: { properties: { symbols: { anyOf: unknown[] } } } } }[] } };
    const symbols = toolCalls.items.anyOf[0]!.properties.arguments.properties.symbols;
    const arrayBranch = symbols.anyOf[0] as { type: string; items: { anyOf: { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean }[] }; properties?: unknown; required?: unknown; additionalProperties?: unknown };
    expect(arrayBranch).toMatchObject({ type: "array" });
    expect(arrayBranch).not.toHaveProperty("properties");
    expect(arrayBranch).not.toHaveProperty("required");
    expect(arrayBranch).not.toHaveProperty("additionalProperties");
    expect(arrayBranch.items.anyOf[0]).toMatchObject({ required: ["library", "symbol_name"], additionalProperties: false });
    expect(arrayBranch.items.anyOf[1]).toMatchObject({ required: ["reference"], additionalProperties: false });
  });

  it("runs Codex with a stdin prompt, read-only sandbox, strict schema, and isolated last-message output", async () => {
    const seen: { command?: string; args?: readonly string[]; cwd?: string | URL | undefined; env?: NodeJS.ProcessEnv; stdin?: string } = {};
    const spawn: CliSpawner = (command, args, options) => {
      const child = new FakeProcess();
      seen.command = command; seen.args = args; seen.cwd = options.cwd;
      if (options.env !== undefined) seen.env = options.env;
      child.stdin.on("data", (chunk) => { seen.stdin = (seen.stdin ?? "") + String(chunk); });
      child.stdin.on("finish", () => {
        const outputPath = args[args.indexOf("--output-last-message") + 1]!;
        void writeFile(outputPath, codexEnvelope(completed)).then(() => child.emit("close", 0, null));
      });
      return child;
    };
    const provider = new CodexCliHarnessProvider({
      model: "gpt-test",
      executablePath: process.execPath,
      spawn,
      environment: { PATH: "safe-path", CODEX_HOME: "safe-home", OPENAI_API_KEY: "provider-key", EVLEDA_PRIVATE_SECRET: "must-not-cross" },
    });
    await expect(provider.turn(request)).resolves.toEqual(completed);
    expect(seen.command).toBe(process.execPath);
    expect(seen.args).toEqual(expect.arrayContaining([
      "exec", "--model", "gpt-test", "--sandbox", "read-only", "--skip-git-repo-check", "--output-schema", "--output-last-message", "-",
    ]));
    expect(seen.args).toEqual(expect.arrayContaining(["--ephemeral", "--ignore-user-config", "--ignore-rules", "--strict-config"]));
    expect(seen.args).toEqual(expect.arrayContaining([
      "-c", "shell_environment_policy.inherit=\"none\"",
      "-c", "shell_environment_policy.ignore_default_excludes=false",
      "-c", "features.view_image=false",
      "-c", "web_search=\"disabled\"",
      "-c", "mcp_servers={}",
      "-c", "features.plugins=false",
      "-c", "features.apps=false",
      "-c", "features.remote_plugin=false",
      "-c", "features.plugin_sharing=false",
      "-c", "features.tool_suggest=false",
      "-c", "features.skill_search=false",
      "-c", "features.skill_mcp_dependency_install=false",
      "-c", "features.image_generation=false",
      "-c", "features.browser_use=false",
      "-c", "features.browser_use_external=false",
      "-c", "features.browser_use_full_cdp_access=false",
      "-c", "features.computer_use=false",
      "-c", "features.workspace_dependencies=false",
      "-c", "features.goals=false",
      "-c", "features.multi_agent=false",
      "-c", "features.multi_agent_v2=false",
      "-c", "agents.enabled=false",
      "-c", "tools.experimental_request_user_input.enabled=false",
      "-c", "tools.update_plan.enabled=false",
      "-c", "features.shell_tool=false",
      "-c", "features.unified_exec=false",
      "-c", "orchestrator.skills.enabled=false",
    ]));
    expect(seen.args).not.toContain("tools.view_image=false");
    expect(seen.args).not.toContain("tools.web_search=false");
    expect(seen.env).toEqual({ PATH: "safe-path", CODEX_HOME: "safe-home" });
    expect(seen.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(seen.env).not.toHaveProperty("EVLEDA_PRIVATE_SECRET");
    expect(CODEX_CLI_PINNED_VERSION).toBe("codex-cli 0.153.4");
    expect(CODEX_CLI_CAPTURED_EXECUTABLE_IDENTITY).toEqual({
      algorithm: "sha256",
      digest: "a1cf6360ca71918d5466bc3a32d9f18b7044c9128756d1949e715d277b88c9b6",
      size: 295_408_944,
    });
    expect(CODEX_CLI_CAPTURED_TOOL_PROFILE).toEqual(expect.objectContaining({
      model: "gpt-5.6-sol",
      originalInventorySha256: "e05f4d1a88a9b58adca4e475fe2c5a2cadabe15a354d5712d5a98a12f1c60b62",
      inventorySha256: "72e35cf8ba0499e9868c26b19bdfbcbc75241e0c47b019dce15b70d1ca90a926",
      responsesRequestToolsFieldPresent: false,
      responsesRequestAdditionalToolsFieldPresent: true,
      toolChoice: "auto",
      namespacedTools: ["functions.exec", "wait"],
      nestedExecTools: ["apply_patch"],
      viewImage: false,
      webSearch: false,
      mcpResources: false,
      writeSandbox: "read-only",
    }));
    expect(createHash("sha256")
      .update(CODEX_CLI_CAPTURED_TOOL_PROFILE.inventoryCanonicalJson, "utf8")
      .digest("hex")).toBe(CODEX_CLI_CAPTURED_TOOL_PROFILE.inventorySha256);
    expect(String(seen.cwd)).not.toBe(process.cwd());
    expect(seen.stdin).toContain("HARNESS_REQUEST_JSON:");
    expect(seen.stdin).toContain("CODEX_EXPLICIT_ENVELOPE_TEMPLATE_JSON:");
    expect(seen.stdin).toContain('"id":"call_1","name":"pcb_get_board_summary","argumentsJson":"{}"');
    expect(seen.stdin).toContain("The argumentsJson field is a string containing JSON, not an object.");
    expect(seen.stdin).toContain('Replace its string value "{}" with a JSON-encoded string');
    expect(seen.stdin).toContain("argumentsJson itself must remain a string.");
    expect(seen.stdin).not.toContain("empty argumentsJson object");
    expect(seen.stdin).toContain("pcb_get_board_summary");
  });

  it("preserves the Sol capture and selects only exact independently captured Codex models", async () => {
    expect(codexCliCapturedToolProfileForModel(CODEX_CLI_CAPTURED_MODEL)).toBe(CODEX_CLI_CAPTURED_TOOL_PROFILE);
    expect(contentIdentity(Buffer.from(canonicalJson(CODEX_CLI_CAPTURED_TOOL_PROFILE), "utf8"))).toEqual({
      algorithm: "sha256", digest: "ee835ac10e2551eb0955cd32ec5d41a767e3e9ffcbe39e60bda33d3066cf7876", size: 1025,
    });
    expect(codexCliCapturedToolProfileForModel(CODEX_CLI_ASTRA_CAPTURED_MODEL)).toBe(CODEX_CLI_ASTRA_CAPTURED_TOOL_PROFILE);
    const evidence = JSON.parse(await readFile(new URL("../fixtures/codex-cli-0.153.4-gpt-6-astra-no-model-tool-profile.json", import.meta.url), "utf8"));
    expect(CODEX_CLI_ASTRA_CAPTURED_TOOL_PROFILE).toMatchObject({
      ...evidence.derivedCapabilityProfile,
      model: evidence.model,
      inventorySha256: evidence.inventorySha256,
      inventoryCanonicalJson: evidence.inventoryCanonicalJson,
      toolInventoryLocation: evidence.toolInventoryLocation,
    });
    expect(CODEX_CLI_ASTRA_CAPTURED_TOOL_PROFILE).toMatchObject({ requestUserInput: true, clockSleep: true, clockCurrentTime: true, fullyQualifiedTools: ["functions.exec", "functions.wait", "functions.request_user_input_async", "clock.sleep"] });
    expect(CODEX_CLI_ASTRA_CAPTURED_TOOL_PROFILE).not.toHaveProperty("originalInventorySha256");
    expect(createHash("sha256").update(CODEX_CLI_ASTRA_CAPTURED_TOOL_PROFILE.inventoryCanonicalJson, "utf8").digest("hex")).toBe("50b441dad797ab840c90c3185d680d0a029fadad930f195c6e368b3a985def0d");
    for (const unsupported of ["gpt-6", "gpt-6-astra-latest", "GPT-6-ASTRA", "gpt-5.6-terra", "constructor", "__proto__"]) expect(codexCliCapturedToolProfileForModel(unsupported)).toBeUndefined();
  });

  it.each([CODEX_CLI_CAPTURED_MODEL, CODEX_CLI_ASTRA_CAPTURED_MODEL])("sends exact captured model %s with unchanged Codex isolation and strict output transport", async (model) => {
    const calls: string[][] = [];
    const delegate = codexOutputSpawner(codexEnvelope(completed));
    const provider = new CodexCliHarnessProvider({ model, executablePath: process.execPath, environment: {}, spawn: (command, args, options) => {
      calls.push([...args]); return delegate(command, args, options);
    } });
    await expect(provider.turn(request)).resolves.toEqual(completed);
    expect(calls).toHaveLength(1); const args = calls[0]!;
    expect(args.slice(0, 1 + CODEX_CLI_ISOLATION_ARGUMENTS.length)).toEqual(["exec", ...CODEX_CLI_ISOLATION_ARGUMENTS]);
    expect(args[args.indexOf("--model") + 1]).toBe(model);
    expect(args).toContain("--output-schema"); expect(args).toContain("--output-last-message");
    expect(args.some((argument) => /model_provider|reasoning_effort|service_tier|temperature|top_p/u.test(argument))).toBe(false);
  });

  it("dynamically restricts the shallow Codex call-name enum to allowed and required tools", async () => {
    const secondTool = { name: "pcb_other", description: "Other.", inputSchema: { type: "object" } };
    const controlledRequest: HarnessProviderRequest = { ...request, tools: [...request.tools, secondTool] };
    const schemas: Array<Record<string, any>> = [];
    let turn = 0;
    const spawn: CliSpawner = (_command, args) => {
      const child = new FakeProcess();
      child.stdin.on("finish", () => {
        const schemaPath = args[args.indexOf("--output-schema") + 1]!;
        const outputPath = args[args.indexOf("--output-last-message") + 1]!;
        const output = turn++ === 0
          ? codexEnvelope(completed)
          : codexEnvelope({
            message: { role: "assistant", content: "Required." },
            toolCalls: [{ id: "required-one", name: "pcb_get_board_summary", arguments: {} }],
            stopReason: "tool_calls",
          });
        void Promise.all([
          readFile(schemaPath, "utf8").then((value) => { schemas.push(JSON.parse(value)); }),
          writeFile(outputPath, output, "utf8"),
        ]).then(() => child.emit("close", 0, null), (error) => child.emit("error", error));
      });
      return child;
    };
    const provider = new CodexCliHarnessProvider({
      model: "gpt-test",
      executablePath: process.execPath,
      spawn,
      environment: {},
    });
    await expect(provider.turn(controlledRequest)).resolves.toEqual(completed);
    await expect(provider.turn(controlledRequest, {
      requiredToolName: "pcb_get_board_summary",
      allowParallelToolCalls: false,
    })).resolves.toMatchObject({ toolCalls: [{ name: "pcb_get_board_summary" }] });
    expect(schemas.map((schema) => schema.properties.toolCalls.items.properties.name.enum)).toEqual([
      ["pcb_get_board_summary", "pcb_other"],
      ["pcb_get_board_summary"],
    ]);
    for (const schema of schemas) {
      expect(inspectCodexStrictOutputSchema(schema)).toEqual({ nodeCount: 10, maximumDepth: 4 });
    }
  });

  it("runs Claude Code with tools disabled and parses its structured result envelope", async () => {
    let args: readonly string[] = [];
    const spawn: CliSpawner = (_command, received) => {
      args = received;
      const child = new FakeProcess();
      child.stdin.on("finish", () => {
        child.stdout.end(JSON.stringify({ type: "result", is_error: false, structured_output: completed }));
        child.emit("close", 0, null);
      });
      return child;
    };
    const provider = new ClaudeCliHarnessProvider({
      model: "claude-test",
      executablePath: process.execPath,
      spawn,
      environment: { ANTHROPIC_API_KEY: "provider-key", CLAUDE_CONFIG_DIR: "safe-home", EVLEDA_PRIVATE_SECRET: "must-not-cross" },
    });
    await expect(provider.turn(request)).resolves.toEqual(completed);
    expect(args).toEqual(expect.arrayContaining(["--print", "--output-format", "json", "--json-schema", "--tools", "", "--model", "claude-test"]));
    expect(args).toContain("--no-session-persistence");
  });

  it("fails closed for malformed output, oversized output, and unauthenticated Claude Code", async () => {
    const malformed: CliSpawner = () => {
      const child = new FakeProcess();
      queueMicrotask(() => { child.stdout.end("not-json"); child.emit("close", 0, null); });
      return child;
    };
    await expect(new ClaudeCliHarnessProvider({ model: "x", executablePath: process.execPath, spawn: malformed }).turn(request)).rejects.toMatchObject({ code: "MALFORMED" });
    const unauthenticated: CliSpawner = () => {
      const child = new FakeProcess();
      queueMicrotask(() => { child.stderr.end("Not logged in. Please run /login."); child.emit("close", 1, null); });
      return child;
    };
    await expect(new ClaudeCliHarnessProvider({ model: "x", executablePath: process.execPath, spawn: unauthenticated }).turn(request)).rejects.toMatchObject({ code: "AUTH" });
    const outputRoot = await mkdtemp(path.join(tmpdir(), "evleda-cli-output-limit-"));
    let outputSpawned = false;
    const excessive: CliSpawner = () => {
      outputSpawned = true;
      const child = new FakeProcess();
      queueMicrotask(() => child.stdout.write("x".repeat(8_192)));
      return child;
    };
    await expect(new ClaudeCliHarnessProvider({
      model: "x",
      executablePath: process.execPath,
      spawn: excessive,
      maxOutputBytes: 4_096,
      temporaryDirectory: outputRoot,
      testHooks: { terminateProcessForTesting: confirmFakeProcessTermination },
    }).turn(request)).rejects.toMatchObject({
      code: "OUTPUT_LIMIT",
      diagnostic: { code: "PROVIDER_RESPONSE_INVALID" },
    });
    expect(outputSpawned).toBe(true);
    expect(await readdir(outputRoot)).toEqual([]);
    await rm(outputRoot, { recursive: true, force: true });
  });

  it("handles asynchronous stdin EPIPE and split or invalid UTF-8 without an unhandled stream error", async () => {
    const epipe: CliSpawner = () => {
      const child = new FakeProcess();
      queueMicrotask(() => child.stdin.emit("error", Object.assign(new Error("write failed"), { code: "EPIPE" })));
      return child;
    };
    await expect(new CodexCliHarnessProvider({
      model: "gpt-test",
      executablePath: process.execPath,
      spawn: epipe,
      environment: {},
      testHooks: { terminateProcessForTesting: confirmFakeProcessTermination },
    }).turn({ ...request, messages: [{ role: "user", content: "x".repeat(100_000) }] })).rejects.toMatchObject({
      code: "HTTP",
      diagnostic: { code: "PROVIDER_REQUEST_FAILED" },
    });

    const splitUtf8: CliSpawner = () => {
      const child = new FakeProcess();
      child.stdin.on("finish", () => {
        const output = Buffer.from(JSON.stringify({
          type: "result",
          is_error: false,
          structured_output: { ...completed, message: { role: "assistant", content: "Done ✓" } },
        }), "utf8");
        const marker = output.indexOf(Buffer.from("✓", "utf8"));
        child.stdout.write(output.subarray(0, marker + 1));
        child.stdout.write(output.subarray(marker + 1));
        child.stdout.end();
        child.emit("close", 0, null);
      });
      return child;
    };
    await expect(new ClaudeCliHarnessProvider({
      model: "claude-test",
      executablePath: process.execPath,
      spawn: splitUtf8,
    }).turn(request)).resolves.toMatchObject({ message: { content: "Done ✓" } });

    const invalidUtf8: CliSpawner = () => {
      const child = new FakeProcess();
      queueMicrotask(() => {
        child.stdout.write(Buffer.from([0xc3, 0x28]));
        child.emit("close", 0, null);
      });
      return child;
    };
    await expect(new ClaudeCliHarnessProvider({
      model: "claude-test",
      executablePath: process.execPath,
      spawn: invalidUtf8,
    }).turn(request)).rejects.toMatchObject({
      code: "MALFORMED",
      diagnostic: { code: "PROVIDER_RESPONSE_INVALID" },
    });
  });

  it("retains an unconfirmed child directory permanently and poisons later turns", async () => {
    class ResistantProcess extends FakeProcess {
      override kill(): boolean { this.killed = true; return true; }
    }
    const root = await mkdtemp(path.join(tmpdir(), "evleda-cli-resistant-"));
    const child = new ResistantProcess();
    let spawns = 0;
    const provider = new CodexCliHarnessProvider({
      model: "gpt-test",
      executablePath: process.execPath,
      environment: {},
      temporaryDirectory: root,
      timeoutMs: 10,
      spawn: () => { spawns += 1; return child; },
    });
    await expect(provider.turn(request)).rejects.toMatchObject({
      code: "INCOMPLETE",
      diagnostic: { code: "PROVIDER_REQUEST_FAILED" },
      retainTemporaryDirectory: true,
    });
    expect(await readdir(root)).toHaveLength(1);
    expect(child.unrefCalls).toBe(1);
    expect(child.stdin.destroyed).toBe(true);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.stderr.listenerCount("data")).toBe(0);
    expect(child.stdout.emit("data", Buffer.alloc(1024 * 1024, 120))).toBe(false);
    expect(() => child.stdin.emit("error", new Error("late retained-stream error"))).not.toThrow();
    await expect(provider.turn(request)).rejects.toMatchObject({ diagnostic: { code: "PROVIDER_REQUEST_FAILED" } });
    expect(spawns).toBe(1);
    child.emit("close", null, "SIGKILL");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await readdir(root)).toHaveLength(1);
    await rm(root, { recursive: true, force: true });
  }, 10_000);

  it("allows concurrent isolated turns and cleans both temporary directories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-cli-concurrent-"));
    let spawns = 0;
    const spawn: CliSpawner = (_command, args) => {
      spawns += 1;
      const child = new FakeProcess();
      child.stdin.on("finish", () => {
        const output = args[args.indexOf("--output-last-message") + 1]!;
        void writeFile(output, codexEnvelope(completed), "utf8").then(() => child.emit("close", 0, null));
      });
      return child;
    };
    const provider = new CodexCliHarnessProvider({
      model: "gpt-test",
      executablePath: process.execPath,
      environment: {},
      temporaryDirectory: root,
      spawn,
    });
    await expect(Promise.all([provider.turn(request), provider.turn(request)])).resolves.toEqual([completed, completed]);
    expect(spawns).toBe(2);
    expect(await readdir(root)).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  describe("Codex bounded private failure leaf classification", () => {
    const secondTool = { name: "pcb_other", description: "Other.", inputSchema: { type: "object" } };
    const controlledRequest: HarnessProviderRequest = { ...request, tools: [...request.tools, secondTool] };
    const call = (id = "one", name = "pcb_get_board_summary", argumentsJson = "{}") => ({ id, name, argumentsJson });
    const envelope = (overrides: Record<string, unknown> = {}) => ({
      schemaVersion: CODEX_CLI_TURN_ENVELOPE_SCHEMA_VERSION,
      messageContent: "Done.",
      hasToolCalls: false,
      toolCalls: [],
      stopReason: "completed",
      ...overrides,
    });
    interface FailureCase {
      readonly leaf: ProviderFailureLeaf;
      readonly raw: () => string;
      readonly request?: HarnessProviderRequest;
      readonly context?: HarnessProviderTurnContext;
      readonly code?: "MALFORMED" | "OUTPUT_LIMIT";
    }
    const cases: readonly FailureCase[] = [
      { leaf: "OUTER_JSON_INVALID", raw: () => "not-json PRIVATE_OUTPUT_SENTINEL" },
      { leaf: "OUTER_SHAPE_INVALID", raw: () => JSON.stringify({ ...envelope(), extra: true }) },
      { leaf: "OUTER_VERSION_MISMATCH", raw: () => JSON.stringify(envelope({ schemaVersion: "wrong" })) },
      { leaf: "OUTER_FIELD_TYPE_INVALID", raw: () => JSON.stringify(envelope({ messageContent: 7 })) },
      {
        leaf: "ARGUMENTS_STRING_BUDGET_EXCEEDED",
        raw: () => JSON.stringify(envelope({ hasToolCalls: true, toolCalls: [call("one", "pcb_get_board_summary", "x".repeat(200_000))], stopReason: "tool_calls" })),
        code: "OUTPUT_LIMIT",
      },
      {
        leaf: "ARGUMENTS_JSON_INVALID",
        raw: () => JSON.stringify(envelope({ hasToolCalls: true, toolCalls: [call("one", "pcb_get_board_summary", "not-json PRIVATE_ARGUMENT_SENTINEL")], stopReason: "tool_calls" })),
      },
      {
        leaf: "ARGUMENTS_JSON_INVALID",
        raw: () => JSON.stringify(envelope({ hasToolCalls: true, toolCalls: [call("one", "pcb_get_board_summary", '{"value":1,"value":2}')], stopReason: "tool_calls" })),
      },
      {
        leaf: "ARGUMENTS_JSON_INVALID",
        raw: () => JSON.stringify(envelope({ hasToolCalls: true, toolCalls: [call("one", "pcb_get_board_summary", '{"value":"\\ud800"}')], stopReason: "tool_calls" })),
      },
      {
        leaf: "ARGUMENTS_BUDGET_EXCEEDED",
        raw: () => JSON.stringify(envelope({
          hasToolCalls: true,
          toolCalls: [
            call("one", "pcb_get_board_summary", JSON.stringify({ value: "a".repeat(100_000) })),
            call("two", "pcb_get_board_summary", JSON.stringify({ value: "b".repeat(100_000) })),
          ],
          stopReason: "tool_calls",
        })),
        code: "OUTPUT_LIMIT",
      },
      { leaf: "MESSAGE_SCHEMA_INVALID", raw: () => JSON.stringify(envelope({ messageContent: "m".repeat(32_001) })) },
      {
        leaf: "CALL_SCHEMA_INVALID",
        raw: () => JSON.stringify(envelope({ hasToolCalls: true, toolCalls: [call("bad id")], stopReason: "tool_calls" })),
      },
      {
        leaf: "TURN_SCHEMA_INVALID",
        raw: () => JSON.stringify(envelope({ hasToolCalls: false, toolCalls: [call()], stopReason: "tool_calls" })),
      },
      {
        leaf: "TURN_SCHEMA_INVALID",
        raw: () => JSON.stringify(envelope({ stopReason: "unknown" })),
      },
      {
        leaf: "UNSUPPORTED_TOOL",
        raw: () => JSON.stringify(envelope({ hasToolCalls: true, toolCalls: [call("one", "pcb_other")], stopReason: "tool_calls" })),
      },
      {
        leaf: "DUPLICATE_CALL_ID",
        raw: () => JSON.stringify(envelope({ hasToolCalls: true, toolCalls: [call(), call()], stopReason: "tool_calls" })),
      },
      {
        leaf: "PARALLEL_CALL_COUNT",
        raw: () => JSON.stringify(envelope({ hasToolCalls: true, toolCalls: [call("one"), call("two")], stopReason: "tool_calls" })),
        context: { allowParallelToolCalls: false },
      },
      {
        leaf: "REQUIRED_TOOL_MISSING",
        raw: () => JSON.stringify(envelope()),
        context: { requiredToolName: "pcb_get_board_summary", allowParallelToolCalls: false },
      },
      {
        leaf: "REQUIRED_TOOL_NAME_MISMATCH",
        raw: () => JSON.stringify(envelope({ hasToolCalls: true, toolCalls: [call("one", "pcb_other")], stopReason: "tool_calls" })),
        request: controlledRequest,
        context: { requiredToolName: "pcb_get_board_summary", allowParallelToolCalls: false },
      },
      {
        leaf: "REQUIRED_TOOL_STOP_MISMATCH",
        raw: () => JSON.stringify(envelope({ hasToolCalls: true, toolCalls: [call()], stopReason: "completed" })),
        context: { requiredToolName: "pcb_get_board_summary", allowParallelToolCalls: false },
      },
    ];
    it.each(cases)("classifies $leaf without retaining raw text", async (testCase) => {
      const raw = testCase.raw();
      const error = await captureProviderError(new CodexCliHarnessProvider({
        model: "gpt-test",
        executablePath: process.execPath,
        environment: {},
        spawn: codexOutputSpawner(raw),
      }).turn(testCase.request ?? request, testCase.context));
      expect(error).toMatchObject({
        code: testCase.code ?? "MALFORMED",
        diagnostic: { code: "PROVIDER_RESPONSE_INVALID" },
        providerFailureEvidence: {
          schemaVersion: "evleda.provider-failure-evidence.v1",
          adapter: "codex",
          boundary: "cli_turn_output",
          leaf: testCase.leaf,
          checkpoints: { cleanupCompleted: true },
          identities: {
            adapter: { schemaVersion: "evleda.codex-cli-provider-failure-adapter.v1" },
            parser: { schemaVersion: "evleda.codex-cli-provider-failure-parser.v1" },
            transportSchema: { schemaVersion: CODEX_CLI_TURN_ENVELOPE_SCHEMA_VERSION },
          },
        },
      });
      expect(error.providerFailureEvidence).toBeDefined();
      expect(error.diagnostic).toBeDefined();
      expect(Object.keys(error)).not.toContain("providerFailureEvidence");
      expect(error.providerFailureEvidence?.observations.outerBytes).toBe(Buffer.byteLength(raw, "utf8"));
      expect(error.providerFailureEvidence?.observations.outerSha256)
        .toBe(createHash("sha256").update(raw, "utf8").digest("hex"));
      if (testCase.leaf === "MESSAGE_SCHEMA_INVALID") {
        expect(error.providerFailureEvidence?.observations.issues[0]?.path).toBe("$.messageContent");
      }
      assertProviderFailureEvidenceMatchesDiagnostic(error.providerFailureEvidence!, error.diagnostic!);
      expect(Buffer.byteLength(JSON.stringify(error.providerFailureEvidence), "utf8"))
        .toBeLessThanOrEqual(PROVIDER_FAILURE_EVIDENCE_MAX_BYTES);
      const serialized = JSON.stringify({ diagnostic: error.diagnostic, evidence: error.providerFailureEvidence });
      expect(serialized).not.toContain("PRIVATE_OUTPUT_SENTINEL");
      expect(serialized).not.toContain("PRIVATE_ARGUMENT_SENTINEL");
    });

    it("normalizes invalid call IDs and names to distinct value-free paths and evidence identities", async () => {
      const invalidCalls = [
        call("bad id", "pcb_get_board_summary"),
        call("valid-id", "Bad Name"),
      ];
      const errors = await Promise.all(invalidCalls.map(async (invalidCall) => await captureProviderError(
        new CodexCliHarnessProvider({
          model: "gpt-test",
          executablePath: process.execPath,
          environment: {},
          spawn: codexOutputSpawner(JSON.stringify(envelope({
            hasToolCalls: true,
            toolCalls: [invalidCall],
            stopReason: "tool_calls",
          }))),
        }).turn(request),
      )));
      expect(errors.map((error) => error.providerFailureEvidence?.observations.issues[0])).toEqual([
        { path: "$.toolCalls[].id", code: "INVALID_VALUE", observedType: "string" },
        { path: "$.toolCalls[].name", code: "INVALID_VALUE", observedType: "string" },
      ]);
      expect(errors[0]!.diagnostic!.evidenceIdentity.digest)
        .not.toBe(errors[1]!.diagnostic!.evidenceIdentity.digest);
    });
  });

  it("classifies Codex output-file byte overflow before allocation with bounded private evidence", async () => {
    const excessive: CliSpawner = (_command, args) => {
      const child = new FakeProcess();
      child.stdin.on("finish", () => {
        const output = args[args.indexOf("--output-last-message") + 1]!;
        void open(output, "w").then(async (handle) => {
          await handle.truncate(262_145);
          await handle.close();
          child.emit("close", 0, null);
        });
      });
      return child;
    };
    const error = await captureProviderError(new CodexCliHarnessProvider({
      model: "gpt-test",
      executablePath: process.execPath,
      environment: {},
      spawn: excessive,
    }).turn(request));
    expect(error).toMatchObject({
      code: "OUTPUT_LIMIT",
      providerFailureEvidence: {
        leaf: "OUTER_BUDGET_EXCEEDED",
        checkpoints: { cleanupCompleted: true },
      },
    });
    expect(error.providerFailureEvidence?.observations).toMatchObject({
      outerBytes: null,
      outerSha256: null,
    });
    assertProviderFailureEvidenceMatchesDiagnostic(error.providerFailureEvidence!, error.diagnostic!);
  });

  it("does not let cleanup failure replace a primary provider failure", async () => {
    const cleanupRoot = await mkdtemp(path.join(tmpdir(), "evleda-cli-cleanup-failure-"));
    let successSpawns = 0;
    const successSpawn: CliSpawner = (_command, args) => {
      successSpawns += 1;
      const child = new FakeProcess();
      child.stdin.on("finish", () => {
        const output = args[args.indexOf("--output-last-message") + 1]!;
        void writeFile(output, codexEnvelope(completed), "utf8").then(() => child.emit("close", 0, null));
      });
      return child;
    };
    const cleanupFailedProvider = new CodexCliHarnessProvider({
      model: "gpt-test",
      executablePath: process.execPath,
      spawn: successSpawn,
      environment: {},
      temporaryDirectory: cleanupRoot,
      testHooks: { beforeCleanup: () => { throw new Error("private cleanup failure"); } },
    });
    const cleanupError = await captureProviderError(cleanupFailedProvider.turn(request));
    expect(cleanupError).toMatchObject({
      code: "MALFORMED",
      diagnostic: { code: "PROVIDER_RESPONSE_INVALID" },
      providerFailureEvidence: {
        leaf: "CLEANUP_SECONDARY",
        boundary: "cli_temporary_output",
        checkpoints: { cleanupCompleted: false },
      },
    });
    assertProviderFailureEvidenceMatchesDiagnostic(
      cleanupError.providerFailureEvidence!,
      cleanupError.diagnostic!,
    );
    await expect(cleanupFailedProvider.turn(request)).rejects.toMatchObject({
      diagnostic: { code: "PROVIDER_RESPONSE_INVALID" },
    });
    expect(successSpawns).toBe(1);

    let malformedSpawns = 0;
    const malformedProvider = new CodexCliHarnessProvider({
      model: "gpt-test",
      executablePath: process.execPath,
      spawn: (command, args, options) => {
        malformedSpawns += 1;
        return codexOutputSpawner("not-json")(command, args, options);
      },
      environment: {},
      temporaryDirectory: cleanupRoot,
      testHooks: { beforeCleanup: () => { throw new Error("private cleanup failure"); } },
    });
    const malformedPrimary = await captureProviderError(malformedProvider.turn(request));
    expect(malformedPrimary).toMatchObject({
      providerFailureEvidence: {
        leaf: "OUTER_JSON_INVALID",
        checkpoints: { outerJsonParsed: false, cleanupCompleted: false },
      },
    });
    const cleanupPoison = await captureProviderError(malformedProvider.turn(request));
    expect(cleanupPoison).toMatchObject({
      providerFailureEvidence: {
        leaf: "CLEANUP_SECONDARY",
        boundary: "cli_temporary_output",
        checkpoints: {
          outerBytesWithinLimit: true,
          outerJsonParsed: false,
          outerShapeClosed: false,
          cleanupCompleted: false,
        },
      },
    });
    expect(malformedSpawns).toBe(1);

    const authSpawn: CliSpawner = () => {
      const child = new FakeProcess();
      queueMicrotask(() => { child.stderr.end("Not logged in"); child.emit("close", 1, null); });
      return child;
    };
    await expect(new CodexCliHarnessProvider({
      model: "gpt-test",
      executablePath: process.execPath,
      spawn: authSpawn,
      environment: {},
      temporaryDirectory: cleanupRoot,
      testHooks: { beforeCleanup: () => { throw new Error("private cleanup failure"); } },
    }).turn(request)).rejects.toMatchObject({
      code: "AUTH",
      diagnostic: { code: "PROVIDER_AUTH_UNAVAILABLE" },
    });
    // A failed cleanup hook deliberately starts a background child-directory
    // removal. Observe that removal before this fixture deletes its parent.
    await expect.poll(async () => await readdir(cleanupRoot), { timeout: CLI_PROVIDER_CLEANUP_TIMEOUT_MS }).toEqual([]);
    await rm(cleanupRoot, { recursive: true, force: true });
  });

  it.each(["win32", "linux"] as const)(
    "never invokes PID-based teardown after a signal-only CLI close on %s",
    async (platform) => {
      Object.defineProperty(process, "platform", { value: platform });
      let spawns = 0;
      let terminationCalls = 0;
      let directKillCalls = 0;
      const root = await mkdtemp(path.join(tmpdir(), "evleda-cli-signal-close-"));
      class SignalOnlyProcess extends FakeProcess {
        override readonly pid = 12_345;
        override kill(): boolean {
          directKillCalls += 1;
          return true;
        }
      }
      const spawn: CliSpawner = () => {
        spawns += 1;
        const child = new SignalOnlyProcess();
        queueMicrotask(() => child.emit("close", null, "SIGKILL"));
        return child;
      };
      const provider = new CodexCliHarnessProvider({
        model: "gpt-test",
        executablePath: process.execPath,
        spawn,
        environment: {},
        temporaryDirectory: root,
        testHooks: {
          terminateProcessForTesting: async () => {
            terminationCalls += 1;
          },
        },
      });
      await expect(provider.turn(request)).rejects.toMatchObject({
        code: "INCOMPLETE",
        diagnostic: { code: "PROVIDER_REQUEST_FAILED" },
        retainTemporaryDirectory: true,
      });
      expect(terminationCalls).toBe(0);
      expect(directKillCalls).toBe(0);
      expect(await readdir(root)).toHaveLength(1);
      await expect(provider.turn(request)).rejects.toMatchObject({
        code: "INCOMPLETE",
        retainTemporaryDirectory: true,
      });
      expect(spawns).toBe(1);
      await rm(root, { recursive: true, force: true });
    },
  );

  it.each([
    { platform: "win32", stream: "stdin" },
    { platform: "win32", stream: "stdout" },
    { platform: "win32", stream: "stderr" },
    { platform: "linux", stream: "stdin" },
    { platform: "linux", stream: "stdout" },
    { platform: "linux", stream: "stderr" },
  ] as const)(
    "retains and poisons without PID teardown after CLI exit then late $stream error on $platform",
    async ({ platform, stream }) => {
      Object.defineProperty(process, "platform", { value: platform });
      let spawns = 0;
      let terminationCalls = 0;
      let directKillCalls = 0;
      const root = await mkdtemp(path.join(tmpdir(), "evleda-cli-exit-epipe-"));
      class ExitedProcess extends FakeProcess {
        override readonly pid = 12_345;
        override kill(): boolean {
          directKillCalls += 1;
          return true;
        }
      }
      let publishChild!: (child: ExitedProcess) => void;
      const childReady = new Promise<ExitedProcess>((resolve) => { publishChild = resolve; });
      const provider = new CodexCliHarnessProvider({
        model: "gpt-test",
        executablePath: process.execPath,
        environment: {},
        temporaryDirectory: root,
        spawn: () => {
          spawns += 1;
          const spawnedChild = new ExitedProcess();
          publishChild(spawnedChild);
          queueMicrotask(() => {
            spawnedChild.emit("exit", 0, null);
            spawnedChild[stream].emit("error", new Error("late stream failure"));
          });
          return spawnedChild;
        },
        testHooks: {
          terminateProcessForTesting: async () => {
            terminationCalls += 1;
          },
        },
      });
      const turn = provider.turn(request);
      const child = await childReady;
      const early = await Promise.race([
        turn.then(() => "settled", () => "settled"),
        new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
      ]);
      expect(early).toBe("pending");
      child.emit("close", 0, null);
      await expect(turn).rejects.toMatchObject({
        code: "INCOMPLETE",
        diagnostic: { code: "PROVIDER_REQUEST_FAILED" },
        retainTemporaryDirectory: true,
      });
      expect(terminationCalls).toBe(0);
      expect(directKillCalls).toBe(0);
      expect(child.unrefCalls).toBe(1);
      expect(child.stdout.listenerCount("data")).toBe(0);
      expect(child.stderr.listenerCount("data")).toBe(0);
      expect(await readdir(root)).toHaveLength(1);
      await expect(provider.turn(request)).rejects.toMatchObject({
        code: "INCOMPLETE",
        retainTemporaryDirectory: true,
      });
      expect(spawns).toBe(1);
      await rm(root, { recursive: true, force: true });
    },
  );

  it("does not infer tree death from root close when a started CLI has no PID", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-cli-missing-pid-"));
    let spawns = 0;
    const provider = new ClaudeCliHarnessProvider({
      model: "claude-test",
      executablePath: process.execPath,
      temporaryDirectory: root,
      maxOutputBytes: 4_096,
      spawn: () => {
        spawns += 1;
        const child = new FakeProcess();
        queueMicrotask(() => child.stdout.write("x".repeat(4_097)));
        return child;
      },
    });
    await expect(provider.turn(request)).rejects.toMatchObject({
      code: "INCOMPLETE",
      diagnostic: { code: "PROVIDER_REQUEST_FAILED" },
      retainTemporaryDirectory: true,
    });
    expect(await readdir(root)).toHaveLength(1);
    await expect(provider.turn(request)).rejects.toMatchObject({
      code: "INCOMPLETE",
      retainTemporaryDirectory: true,
    });
    expect(spawns).toBe(1);
    await rm(root, { recursive: true, force: true });
  });

  it("retains and poisons when a signal-only Windows wrapper close leaves a resistant descendant", async () => {
    if (process.platform !== "win32") return;
    const root = await mkdtemp(path.join(tmpdir(), "evleda-cli-signal-tree-"));
    const spawnedAfterUtc = new Date(Date.now() - 1_000).toISOString();
    let descendantPid: number | undefined;
    let descendantWasAliveBeforeRootSignal = false;
    let wrapper: ChildProcessWithoutNullStreams | undefined;
    let wrapperClosed: Promise<void> | undefined;
    let spawns = 0;
    const spawn: CliSpawner = (_command, _args, options) => {
      spawns += 1;
      const childSource = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.send({ready:true})";
      const parentSource = [
        "const {spawn}=require('node:child_process')",
        // Detachment makes survival of the wrapper real, not a startup race.
        // Publish the PID immediately for cleanup, but trigger invalid output
        // only after the descendant has installed its persistent work.
        `const child=spawn(process.execPath,['-e',${JSON.stringify(childSource)},'--',${JSON.stringify(root)}],{stdio:['ignore','ignore','ignore','ipc'],detached:true,windowsHide:true})`,
        "process.stdout.write(String(child.pid)+'\\n')",
        "child.once('message',()=>process.stdout.write(Buffer.from([0xc3,0x28])))",
        "setInterval(()=>{},1000)",
      ].join(";");
      const actual = nodeSpawn(process.execPath, ["-e", parentSource], { ...options, shell: false }) as ChildProcessWithoutNullStreams;
      wrapper = actual;
      wrapperClosed = new Promise<void>((resolve) => actual.once("close", () => resolve()));
      let fixtureOutput = Buffer.alloc(0);
      let rootSignalScheduled = false;
      actual.stdout.on("data", (chunk: Buffer) => {
        fixtureOutput = Buffer.concat([fixtureOutput, chunk]);
        const match = /^\d+\n/u.exec(fixtureOutput.toString("utf8"));
        if (match !== null) descendantPid = Number(match[0].trim());
        if (!rootSignalScheduled && fixtureOutput.includes(Buffer.from([0xc3, 0x28]))) {
          rootSignalScheduled = true;
          if (descendantPid !== undefined) {
            try { process.kill(descendantPid, 0); descendantWasAliveBeforeRootSignal = true; } catch { /* assertion below */ }
          }
          setTimeout(() => actual.kill("SIGTERM"), 10);
        }
      });
      const proxy: CliProcess = {
        stdout: actual.stdout,
        stderr: actual.stderr,
        stdin: actual.stdin,
        pid: actual.pid,
        kill: (signal) => actual.kill(signal),
        once(event, listener) {
          if (event === "error") actual.once("error", listener as (error: Error) => void);
          else actual.once("close", () => (listener as (code: number | null, signal: NodeJS.Signals | null) => void)(null, "SIGTERM"));
          return this;
        },
      };
      return proxy;
    };
    const provider = new CodexCliHarnessProvider({
      model: "gpt-test",
      executablePath: process.execPath,
      environment: process.env,
      temporaryDirectory: root,
      timeoutMs: 5_000,
      spawn,
    });
    try {
      await expect(provider.turn(request)).rejects.toMatchObject({
        code: "INCOMPLETE",
        diagnostic: { code: "PROVIDER_REQUEST_FAILED" },
        retainTemporaryDirectory: true,
      });
      expect(descendantPid).toBeDefined();
      expect(descendantWasAliveBeforeRootSignal).toBe(true);
      await wrapperClosed;
      expect(wrapper).toBeDefined();
      expect(wrapper!.exitCode !== null || wrapper!.signalCode !== null).toBe(true);
      expect(wrapper!.stdout.destroyed && wrapper!.stderr.destroyed).toBe(true);
      expect(() => process.kill(descendantPid!, 0)).not.toThrow();
      expect(await readdir(root)).toHaveLength(1);
      await expect(provider.turn(request)).rejects.toMatchObject({ diagnostic: { code: "PROVIDER_REQUEST_FAILED" } });
      expect(spawns).toBe(1);
    } finally {
      if (wrapper !== undefined) {
        if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill("SIGKILL");
        await wrapperClosed;
        if (descendantPid === undefined) throw new Error(`Owned descendant identity was not captured; retained fixture ${root}, wrapper PID ${wrapper.pid}.`);
        const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
        if (windowsRoot === undefined || !path.win32.isAbsolute(windowsRoot)) throw new Error(`Cannot bind Windows cleanup helper; retained fixture ${root}.`);
        const powershell = path.win32.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        // PID-zero/ESRCH and a successful kill request do not prove Windows has
        // released cwd. Bind the owned incarnation, wait on its native process
        // handle, dispose that handle, and await the helper's real close first.
        const cleanupScript = [
          "$ErrorActionPreference='Stop'",
          `$owned=[System.Diagnostics.Process]::GetProcessById(${descendantPid})`,
          "try {",
          "$null=$owned.Handle",
          `if(-not [String]::Equals($owned.MainModule.FileName,'${process.execPath.replaceAll("'", "''")}',[StringComparison]::OrdinalIgnoreCase)){throw 'Owned executable mismatch'}`,
          `if($owned.StartTime.ToUniversalTime() -lt [DateTime]::Parse('${spawnedAfterUtc}').ToUniversalTime()){throw 'Owned incarnation predates fixture'}`,
          `$marker='${root.replaceAll("'", "''")}'`,
          "$record=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$owned.Id)",
          "$suffix='\\s--\\s+(?:\"'+[Regex]::Escape($marker)+'\"|'+[Regex]::Escape($marker)+')\\s*$'",
          "if($null -eq $record -or $record.CommandLine -notmatch $suffix){throw 'Owned unique argument marker mismatch'}",
          "if($owned.HasExited){throw 'Held owned incarnation exited before cleanup'}",
          "[Console]::Out.WriteLine(('BOUND {0} {1:o}' -f $owned.Id,$owned.StartTime.ToUniversalTime()))",
          "[Console]::Out.WriteLine(('MARKER_CONFIRMED '+$marker))",
          "$owned.Kill()",
          "if(-not $owned.WaitForExit(5000)){throw 'Owned descendant exit deadline exceeded'}",
          "} finally { $owned.Dispose() }",
          "[Console]::Out.WriteLine('EXIT_CONFIRMED_HANDLE_DISPOSED')",
        ].join(";");
        const helper = nodeSpawn(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(cleanupScript, "utf16le").toString("base64")], {
          cwd: path.dirname(root), stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 6_000,
        });
        let stdout = "", stderr = "";
        helper.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
        helper.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
        const code = await new Promise<number | null>((resolve, reject) => { helper.once("error", reject); helper.once("close", resolve); });
        if (code !== 0 || !stdout.includes(`BOUND ${descendantPid} `) || !stdout.includes(`MARKER_CONFIRMED ${root}`) || !stdout.includes("EXIT_CONFIRMED_HANDLE_DISPOSED")) {
          throw new Error(`Owned descendant cleanup was not verified; retained fixture ${root}, PID ${descendantPid}. ${stdout} ${stderr}`);
        }
        expect(() => process.kill(descendantPid!, 0)).toThrow();
      }
      // Exactly one deletion of this newly created root after both real process
      // closes. No filesystem retries or suppressed cleanup errors.
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("bounds unconfirmed cleanup, poisons reuse, and completes late deletion", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-cli-cleanup-timeout-"));
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let spawns = 0;
    const spawn: CliSpawner = (_command, args) => {
      spawns += 1;
      const child = new FakeProcess();
      child.stdin.on("finish", () => {
        const output = args[args.indexOf("--output-last-message") + 1]!;
        void writeFile(output, codexEnvelope(completed), "utf8").then(() => child.emit("close", 0, null));
      });
      return child;
    };
    const provider = new CodexCliHarnessProvider({
      model: "gpt-test",
      executablePath: process.execPath,
      spawn,
      environment: {},
      temporaryDirectory: root,
      timeoutMs: 10_000,
      testHooks: { beforeCleanup: async () => await cleanupGate },
    });
    await expect(provider.turn(request)).rejects.toMatchObject({
      code: "INCOMPLETE",
      diagnostic: { code: "PROVIDER_REQUEST_FAILED" },
      providerFailureEvidence: {
        boundary: "cli_temporary_output",
        leaf: "CLEANUP_SECONDARY",
        providerErrorClass: "INCOMPLETE",
        checkpoints: { cleanupCompleted: false },
      },
    });
    await expect(provider.turn(request)).rejects.toMatchObject({ diagnostic: { code: "PROVIDER_REQUEST_FAILED" } });
    expect(spawns).toBe(1);
    expect(await readdir(root)).toHaveLength(1);
    releaseCleanup();
    for (let index = 0; index < 20 && (await readdir(root)).length > 0; index += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(await readdir(root)).toEqual([]);
    await rm(root, { recursive: true, force: true });
  }, 10_000);

  it.each(["resistant-parent", "early-parent-exit"] as const)(
  "waits for a real child tree to die before cleanup and deadline settlement: %s", async (mode) => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-cli-real-tree-"));
    const windowsProcessTreeTermination = await copiedWindowsTerminationBinding(root);
    let parent: ChildProcessWithoutNullStreams | undefined;
    let descendantPid: number | undefined;
    const spawn: CliSpawner = (_command, _args, options) => {
      const script = [
        "const {spawn}=require('node:child_process')",
        `const child=spawn(process.execPath,['-e',${JSON.stringify(mode === "early-parent-exit"
          ? "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"
          : "setInterval(()=>{},1000)")}],{stdio:'ignore'})`,
        "process.stdout.write(String(child.pid)+'\\n')",
        ...(mode === "resistant-parent" ? ["process.on('SIGTERM',()=>{})"] : []),
        "setInterval(()=>{},1000)",
      ].join(";");
      parent = nodeSpawn(process.execPath, ["-e", script], { ...options, shell: false }) as ChildProcessWithoutNullStreams;
      parent.stdout.once("data", (chunk) => { descendantPid = Number(String(chunk).trim()); });
      return parent;
    };
    await expect(new CodexCliHarnessProvider({
      model: "gpt-test",
      executablePath: process.execPath,
      environment: process.env,
      temporaryDirectory: root,
      timeoutMs: 250,
      spawn,
      ...(windowsProcessTreeTermination === undefined ? {} : { windowsProcessTreeTermination }),
    }).turn(request)).rejects.toMatchObject({
      code: "INCOMPLETE",
      diagnostic: { code: "PROVIDER_DEADLINE_EXCEEDED" },
    });
    expect(parent?.exitCode !== null || parent?.signalCode !== null).toBe(true);
    expect(await readdir(root)).toEqual(
      windowsProcessTreeTermination === undefined ? [] : ["pinned-tree-terminator.exe"],
    );
    if (descendantPid !== undefined) expect(() => process.kill(descendantPid!, 0)).toThrow();
    await rm(root, { recursive: true, force: true });
  }, 10_000);

  it("terminates CLI providers on their deadline and on caller cancellation", async () => {
    const timedChildren: FakeProcess[] = [];
    const hanging: CliSpawner = () => {
      const child = new FakeProcess();
      timedChildren.push(child);
      return child;
    };
    await expect(new CodexCliHarnessProvider({
      model: "gpt-test",
      executablePath: process.execPath,
      spawn: hanging,
      environment: {},
      timeoutMs: 10,
      testHooks: { terminateProcessForTesting: confirmFakeProcessTermination },
    }).turn(request)).rejects.toMatchObject({ code: "INCOMPLETE" });
    expect(timedChildren[0]?.killed).toBe(true);

    const controller = new AbortController();
    const cancelled = new DOMException("cancelled", "AbortError");
    const cancelledChildren: FakeProcess[] = [];
    const cancelSpawn: CliSpawner = () => {
      const child = new FakeProcess();
      cancelledChildren.push(child);
      queueMicrotask(() => controller.abort(cancelled));
      return child;
    };
    await expect(new ClaudeCliHarnessProvider({
      model: "claude-test",
      executablePath: process.execPath,
      spawn: cancelSpawn,
      environment: {},
      signal: controller.signal,
      testHooks: { terminateProcessForTesting: confirmFakeProcessTermination },
    }).turn(request)).rejects.toMatchObject({
      code: "INCOMPLETE",
      diagnostic: { code: "PROVIDER_CANCELLED" },
    });
    expect(cancelledChildren[0]?.killed).toBe(true);
  });

  it.each(["codex", "claude-cli"] as const)(
    "clamps the %s child turn to the caller's remaining outer-deadline budget",
    async (providerName) => {
      const children: FakeProcess[] = [];
      const spawn: CliSpawner = () => {
        const child = new FakeProcess();
        children.push(child);
        return child;
      };
      const options = {
        model: "test-model",
        executablePath: process.execPath,
        environment: {},
        timeoutMs: 5_000,
        spawn,
        testHooks: { terminateProcessForTesting: confirmFakeProcessTermination },
      };
      const provider = providerName === "codex"
        ? new CodexCliHarnessProvider(options)
        : new ClaudeCliHarnessProvider(options);
      const started = performance.now();
      await expect(provider.turn(request, {
        timeoutMs: 10,
      } as HarnessProviderTurnContext)).rejects.toMatchObject({
        code: "INCOMPLETE",
        diagnostic: { code: "PROVIDER_DEADLINE_EXCEEDED" },
      });
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(children).toHaveLength(1);
      expect(children[0]!.killed).toBe(true);
    },
  );

  it("applies one deadline across pre-spawn identity work and post-process output intake", async () => {
    let prehashSpawns = 0;
    let releasePrehash!: () => void;
    const prehashGate = new Promise<void>((resolve) => { releasePrehash = resolve; });
    const prehashTurn = new CodexCliHarnessProvider({
      model: "gpt-test",
      executablePath: process.execPath,
      environment: {},
      timeoutMs: 10,
      spawn: () => { prehashSpawns += 1; return new FakeProcess(); },
      testHooks: { beforeExecutableValidation: async () => await prehashGate },
    }).turn(request);
    await expect(prehashTurn).rejects.toMatchObject({ code: "INCOMPLETE" });
    expect(prehashSpawns).toBe(0);
    releasePrehash();

    let postreadSpawns = 0;
    const completedSpawn: CliSpawner = (_command, args) => {
      postreadSpawns += 1;
      const child = new FakeProcess();
      child.stdin.on("finish", () => {
        const output = args[args.indexOf("--output-last-message") + 1]!;
        void writeFile(output, codexEnvelope(completed), "utf8").then(() => child.emit("close", 0, null));
      });
      return child;
    };
    let releasePostread!: () => void;
    const postreadGate = new Promise<void>((resolve) => { releasePostread = resolve; });
    const postreadTurn = new CodexCliHarnessProvider({
      model: "gpt-test",
      executablePath: process.execPath,
      environment: {},
      timeoutMs: 10,
      spawn: completedSpawn,
      testHooks: { beforeOutputRead: async () => await postreadGate },
    }).turn(request);
    await expect(postreadTurn).rejects.toMatchObject({ code: "INCOMPLETE" });
    expect(postreadSpawns).toBe(1);
    releasePostread();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it("revalidates pinned executable bytes before spawn", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-cli-executable-pin-"));
    try {
      const executable = path.join(root, process.platform === "win32" ? "provider.exe" : "provider");
      const original = Buffer.from("pinned executable bytes\n", "utf8");
      await writeFile(executable, original);
      let spawns = 0;
      const identity = contentIdentity(original);
      const provider = new CodexCliHarnessProvider({
        model: "gpt-test",
        environment: {
          EVLEDA_CODEX_CLI: executable,
          EVLEDA_CODEX_CLI_SHA256: identity.digest,
          EVLEDA_CODEX_CLI_SIZE_BYTES: String(identity.size),
        },
        spawn: () => { spawns += 1; return new FakeProcess(); },
      });
      await writeFile(executable, "replaced executable bytes\n", "utf8");
      await expect(provider.turn(request)).rejects.toMatchObject({ code: "MALFORMED" });
      expect(spawns).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bounds and identity-checks Codex last-message files before allocation or parsing", async () => {
    const excessive: CliSpawner = (_command, args) => {
      const child = new FakeProcess();
      child.stdin.on("finish", () => {
        const output = args[args.indexOf("--output-last-message") + 1]!;
        void open(output, "w").then(async (handle) => {
          await handle.truncate(4_097);
          await handle.close();
          child.emit("close", 0, null);
        });
      });
      return child;
    };
    await expect(new CodexCliHarnessProvider({
      model: "gpt-test",
      executablePath: process.execPath,
      spawn: excessive,
      environment: {},
      maxOutputBytes: 4_096,
    }).turn(request)).rejects.toMatchObject({ code: "OUTPUT_LIMIT" });

    const linked: CliSpawner = (_command, args, options) => {
      const child = new FakeProcess();
      child.stdin.on("finish", () => {
        const output = args[args.indexOf("--output-last-message") + 1]!;
        const target = path.join(String(options.cwd), "linked-output-target.json");
        void writeFile(target, JSON.stringify(completed), "utf8").then(async () => {
          await unlink(output).catch(() => undefined);
          await link(target, output);
          child.emit("close", 0, null);
        });
      });
      return child;
    };
    await expect(new CodexCliHarnessProvider({
      model: "gpt-test",
      executablePath: process.execPath,
      spawn: linked,
      environment: {},
    }).turn(request)).rejects.toMatchObject({ code: "MALFORMED" });
  });
});
