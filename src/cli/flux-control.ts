#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parsePortableJsonBytes } from "../core/portable-artifact.js";
import {
  FLUX_CONTROL_DEFAULT_BASE_URL,
  FLUX_CONTROL_LIMITS,
  FluxControlClient,
  FluxControlError,
  FluxControlIntentStore,
  FluxControlRemoteError,
  normalizeFluxControlBaseUrl,
  redactFluxControlOutput,
  readFluxControlBoundedFile,
  type FluxControlCommandResult,
} from "../integrations/flux-control-client.js";
import type { FluxClarificationAnswerDto } from "../flux/contracts.js";
import { PCB_AGENT_MAX_FRESH_ITERATIONS, PCB_AGENT_MIN_ITERATIONS } from "../harness/pcb-agent-harness.js";

export const FLUX_CONTROL_COMMANDS = Object.freeze([
  "readiness", "policy", "sources", "projects", "threads",
  "create-project", "create-thread", "create-run", "interpret", "answer",
  "prepare", "open", "checkpoint", "approval-subject", "approve", "resume",
  "status", "poll", "contract", "previews", "refresh-previews", "inspection-status", "inspect", "reports",
] as const);
export type FluxControlCommand = (typeof FLUX_CONTROL_COMMANDS)[number];

const VALUE_FLAGS = new Set([
  "--base-url", "--state-file", "--source-key", "--name", "--project-id", "--title",
  "--thread-id", "--run-id", "--prompt-file", "--answers-file", "--iterations",
  "--subject-digest", "--after-event-seq",
]);
const BOOLEAN_FLAGS = new Set(["--allow-remote-https", "--prompt-stdin", "--answers-stdin"]);

export interface FluxControlCliOptions {
  readonly command: FluxControlCommand | "help";
  readonly values: Readonly<Record<string, string>>;
  readonly flags: readonly string[];
}

const cliFail = (message: string): never => { throw new FluxControlError("INPUT_INVALID", message); };

/** Strict parser. In particular, no prompt-text argv switch exists. */
export function parseFluxControlCliArgs(argv: readonly string[]): FluxControlCliOptions {
  if (argv.length === 0) return { command: "help", values: {}, flags: [] };
  const command = argv[0];
  if (command === "--help" || command === "help") {
    if (argv.length !== 1) return cliFail("Help accepts no additional arguments.");
    return { command: "help", values: {}, flags: [] };
  }
  if (!(FLUX_CONTROL_COMMANDS as readonly string[]).includes(command ?? "")) return cliFail(`Unsupported candidate-only Flux command: ${command ?? ""}.`);
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--prompt" || argument === "--prompt-text") return cliFail("Prompt text is forbidden in argv; use --prompt-file or --prompt-stdin.");
    if (BOOLEAN_FLAGS.has(argument)) {
      if (flags.has(argument)) return cliFail(`${argument} may be supplied once.`);
      flags.add(argument);
      continue;
    }
    if (!VALUE_FLAGS.has(argument)) return cliFail(`Unsupported Flux control argument: ${argument}.`);
    if (Object.hasOwn(values, argument)) return cliFail(`${argument} may be supplied once.`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--") || value.includes("\0")) return cliFail(`${argument} requires one non-option value.`);
    values[argument] = value;
    index += 1;
  }
  return Object.freeze({ command: command as FluxControlCommand, values: Object.freeze(values), flags: Object.freeze([...flags].sort()) });
}

const required = (options: FluxControlCliOptions, key: string): string => {
  const value = options.values[key]?.trim();
  return value ? value : cliFail(`${key} is required for ${options.command}.`);
};

const noExtra = (options: FluxControlCliOptions, allowedValues: readonly string[], allowedFlags: readonly string[] = []): void => {
  const unknownValues = Object.keys(options.values).filter((key) => !["--base-url", "--state-file", ...allowedValues].includes(key));
  const unknownFlags = options.flags.filter((key) => !["--allow-remote-https", ...allowedFlags].includes(key));
  if (unknownValues.length > 0 || unknownFlags.length > 0) cliFail(`Command ${options.command} received unrelated arguments: ${[...unknownValues, ...unknownFlags].join(", ")}.`);
};

const fatalUtf8 = (bytes: Uint8Array, label: string): string => {
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return cliFail(`${label} must not contain a UTF-8 BOM.`);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return cliFail(`${label} is not fatal-valid UTF-8.`); }
};

const readOrdinaryFile = async (filePath: string, maximumBytes: number, label: string, afterHandleReadForTesting?: (label: string, filePath: string) => void | Promise<void>): Promise<Buffer> =>
  readFluxControlBoundedFile(filePath, { maximumBytes, label, failureCode: "INPUT_INVALID", ...(afterHandleReadForTesting === undefined ? {} : { afterHandleReadForTesting }) });

async function readBoundedStream(stream: AsyncIterable<unknown>, maximumBytes: number, label: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  let count = 0;
  for await (const raw of stream) {
    const chunk = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw instanceof Uint8Array ? Buffer.from(raw) : cliFail(`${label} yielded an unsupported chunk.`);
    count += 1;
    if (count > 4_096 || chunk.byteLength > 256 * 1024) return cliFail(`${label} exceeds its chunk bound.`);
    total += chunk.byteLength;
    if (total > maximumBytes) return cliFail(`${label} exceeds its aggregate byte limit.`);
    chunks.push(chunk);
  }
  if (total === 0) return cliFail(`${label} is empty.`);
  return Buffer.concat(chunks, total);
}

const parseAnswers = (bytes: Buffer): readonly FluxClarificationAnswerDto[] => {
  let value: unknown;
  try { value = parsePortableJsonBytes(bytes, { maxBytes: FLUX_CONTROL_LIMITS.answerBytes, maxDepth: 8, maxNodes: 2_048, maxArrayLength: 128, maxOwnKeys: 8, maxKeyBytes: 64, maxStringBytes: 16_384 }); }
  catch { return cliFail("Clarification input is not strict bounded JSON."); }
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, "answers")) return cliFail("Clarification input must be exactly {\"answers\":[...]}.");
  const answers = (value as { answers: unknown }).answers;
  if (!Array.isArray(answers) || answers.length < 1 || answers.length > 128) return cliFail("Clarification answers must be a non-empty bounded array.");
  return answers.map((entry): FluxClarificationAnswerDto => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry) || Object.keys(entry).sort().join("\0") !== "answer\0id") return cliFail("Each clarification answer must contain only id and answer strings.");
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.answer !== "string") return cliFail("Clarification id and answer must be strings.");
    return { id: item.id, answer: item.answer };
  });
};

export interface FluxControlCliDependencies {
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetch?: typeof globalThis.fetch;
  readonly stdin?: AsyncIterable<unknown>;
  /** Deterministic file-swap seam; production callers must omit it. */
  readonly afterFileReadForTesting?: (label: string, filePath: string) => void | Promise<void>;
}

export interface FluxControlCliExecution {
  readonly exitCode: number;
  readonly output: Readonly<Record<string, unknown>>;
}

const successOutput = (command: string, value: FluxControlCommandResult): FluxControlCliExecution => ({
  exitCode: 0,
  output: Object.freeze(redactFluxControlOutput({ ok: true, command, requestId: value.requestId, result: value.result, ...(value.intent === undefined ? {} : { intent: value.intent }) }) as Record<string, unknown>),
});

const helpOutput = (): FluxControlCliExecution => ({
  exitCode: 0,
  output: Object.freeze({
    ok: true,
    command: "help",
    result: {
      classification: "candidate-only",
      commands: FLUX_CONTROL_COMMANDS,
      promptInput: ["--prompt-file", "--prompt-stdin"],
      approval: "Run approval-subject first, read its exact subject, then pass that exact digest to approve. No command auto-approves.",
      omittedOperations: ["manufacturing", "release", "qualification", "fabrication"],
    },
  }),
});

export async function runFluxControlCli(argv: readonly string[], dependencies: FluxControlCliDependencies = {}): Promise<FluxControlCliExecution> {
  const parsed = parseFluxControlCliArgs(argv);
  if (parsed.command === "help") return helpOutput();
  const cwd = dependencies.cwd ?? process.cwd();
  const allowRemoteHttps = parsed.flags.includes("--allow-remote-https");
  const baseUrl = normalizeFluxControlBaseUrl(parsed.values["--base-url"] ?? FLUX_CONTROL_DEFAULT_BASE_URL, allowRemoteHttps);
  const stateFile = path.resolve(cwd, parsed.values["--state-file"] ?? dependencies.environment?.EVLEDA_FLUX_CONTROL_STATE_FILE ?? ".evleda-flux-control-intents.json");
  const client = new FluxControlClient({ baseUrl, allowRemoteHttps, ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }), intentStore: new FluxControlIntentStore(stateFile, baseUrl, dependencies.afterFileReadForTesting === undefined ? {} : { afterManifestReadForTesting: dependencies.afterFileReadForTesting }) });
  const runId = () => required(parsed, "--run-id");
  let result: FluxControlCommandResult;
  switch (parsed.command) {
    case "readiness": noExtra(parsed, []); result = await client.readiness(); break;
    case "policy": noExtra(parsed, []); result = await client.policy(); break;
    case "sources": noExtra(parsed, []); result = await client.sources(); break;
    case "projects": noExtra(parsed, []); result = await client.projects(); break;
    case "threads": noExtra(parsed, ["--project-id"]); result = await client.threads(required(parsed, "--project-id")); break;
    case "create-project": noExtra(parsed, ["--source-key", "--name"]); result = await client.createProject(required(parsed, "--source-key"), required(parsed, "--name")); break;
    case "create-thread": noExtra(parsed, ["--project-id", "--title"]); result = await client.createThread(required(parsed, "--project-id"), required(parsed, "--title")); break;
    case "create-run": {
      noExtra(parsed, ["--project-id", "--thread-id", "--prompt-file", "--iterations"], ["--prompt-stdin"]);
      const file = parsed.values["--prompt-file"];
      const useStdin = parsed.flags.includes("--prompt-stdin");
      if ((file === undefined) === !useStdin) cliFail("Create-run requires exactly one of --prompt-file or --prompt-stdin.");
      if (file !== undefined && path.resolve(cwd, file) === stateFile) cliFail("Prompt and durable intent store must be different files.");
      const bytes = file === undefined
        ? await readBoundedStream(dependencies.stdin ?? process.stdin, FLUX_CONTROL_LIMITS.promptBytes, "Prompt stdin")
        : await readOrdinaryFile(path.resolve(cwd, file), FLUX_CONTROL_LIMITS.promptBytes, "Prompt file", dependencies.afterFileReadForTesting);
      const rawIterations = parsed.values["--iterations"];
      if (rawIterations !== undefined && (!/^[1-9]\d*$/u.test(rawIterations) || !Number.isSafeInteger(Number(rawIterations)) || Number(rawIterations) < PCB_AGENT_MIN_ITERATIONS || Number(rawIterations) > PCB_AGENT_MAX_FRESH_ITERATIONS)) cliFail(`--iterations must be from ${PCB_AGENT_MIN_ITERATIONS} through ${PCB_AGENT_MAX_FRESH_ITERATIONS}.`);
      result = await client.createGenericRun(required(parsed, "--project-id"), required(parsed, "--thread-id"), fatalUtf8(bytes, "Prompt"), rawIterations === undefined ? undefined : Number(rawIterations));
      break;
    }
    case "interpret": noExtra(parsed, ["--run-id"]); result = await client.interpret(runId()); break;
    case "answer": {
      noExtra(parsed, ["--run-id", "--answers-file"], ["--answers-stdin"]);
      const file = parsed.values["--answers-file"];
      const useStdin = parsed.flags.includes("--answers-stdin");
      if ((file === undefined) === !useStdin) cliFail("Answer requires exactly one of --answers-file or --answers-stdin.");
      if (file !== undefined && path.resolve(cwd, file) === stateFile) cliFail("Answers and durable intent store must be different files.");
      const bytes = file === undefined
        ? await readBoundedStream(dependencies.stdin ?? process.stdin, FLUX_CONTROL_LIMITS.answerBytes, "Answers stdin")
        : await readOrdinaryFile(path.resolve(cwd, file), FLUX_CONTROL_LIMITS.answerBytes, "Answers file", dependencies.afterFileReadForTesting);
      result = await client.answerClarifications(runId(), parseAnswers(bytes));
      break;
    }
    case "prepare": noExtra(parsed, ["--run-id"]); result = await client.prepare(runId()); break;
    case "open": noExtra(parsed, ["--run-id"]); result = await client.open(runId()); break;
    case "checkpoint": noExtra(parsed, ["--run-id"]); result = await client.checkpoint(runId()); break;
    case "approval-subject": noExtra(parsed, ["--run-id"]); result = await client.approvalSubject(runId()); break;
    case "approve": noExtra(parsed, ["--run-id", "--subject-digest"]); result = await client.approve(runId(), required(parsed, "--subject-digest")); break;
    case "resume": noExtra(parsed, ["--run-id"]); result = await client.resume(runId()); break;
    case "status": noExtra(parsed, ["--run-id"]); result = await client.status(runId()); break;
    case "poll": {
      noExtra(parsed, ["--run-id", "--after-event-seq"]);
      const after = parsed.values["--after-event-seq"] ?? "0";
      if (!/^(?:0|[1-9][0-9]*)$/u.test(after) || !Number.isSafeInteger(Number(after))) cliFail("--after-event-seq must be a canonical safe integer.");
      result = await client.poll(runId(), Number(after));
      break;
    }
    case "contract": noExtra(parsed, ["--run-id"]); result = await client.contract(runId()); break;
    case "previews": noExtra(parsed, ["--run-id"]); result = await client.previews(runId()); break;
    case "refresh-previews": noExtra(parsed, ["--run-id"]); result = await client.refreshPreviews(runId()); break;
    case "inspection-status": noExtra(parsed, ["--run-id"]); result = await client.inspectionStatus(runId()); break;
    case "inspect": noExtra(parsed, ["--run-id"]); result = await client.inspect(runId()); break;
    case "reports": noExtra(parsed, ["--run-id"]); result = await client.reports(runId()); break;
  }
  return successOutput(parsed.command, result);
}

const errorOutput = (command: string, error: unknown): FluxControlCliExecution => {
  const safeCommand = command === "help" || (FLUX_CONTROL_COMMANDS as readonly string[]).includes(command) ? command : "unsupported";
  if (error instanceof FluxControlRemoteError) return {
    exitCode: 1,
    output: Object.freeze(redactFluxControlOutput({ ok: false, command: safeCommand, requestId: error.requestId ?? null, error: {
      code: "REMOTE_ERROR",
      remoteCode: error.remote.code,
      message: "Flux server rejected the request.",
      retryable: error.retryable,
      ...(error.remote.diagnostic === undefined ? {} : { diagnostic: error.remote.diagnostic }),
      ...(error.remote.terminalFailureReceipt === undefined ? {} : { terminalFailureReceipt: error.remote.terminalFailureReceipt }),
    } }) as Record<string, unknown>),
  };
  const local = error instanceof FluxControlError ? error : new FluxControlError("TRANSPORT_FAILED", "Flux control failed without a trusted response.");
  return { exitCode: 1, output: Object.freeze(redactFluxControlOutput({ ok: false, command: safeCommand, requestId: local.requestId ?? null, error: { code: local.code, message: local.message, retryable: local.retryable } }) as Record<string, unknown>) };
};

export async function main(argv = process.argv.slice(2), dependencies: FluxControlCliDependencies = {}): Promise<number> {
  const command = argv[0] ?? "help";
  let execution: FluxControlCliExecution;
  try { execution = await runFluxControlCli(argv, dependencies); }
  catch (error) { execution = errorOutput(command, error); }
  process.stdout.write(`${JSON.stringify(execution.output)}\n`);
  return execution.exitCode;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().then((code) => { process.exitCode = code; });
}
