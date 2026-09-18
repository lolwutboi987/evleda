/**
 * Interactive, local-only MCP adapter; the operator chooses every tool action.
 *
 * node --import tsx scripts/toolbox-workspace-client.ts --profile <file>
 *   --profile-sha256 <sha256> --profile-bytes <bytes> --workspace-root <existing-dir>
 *   --evidence-dir <dir> [--edit]
 *   [--call-timeout-ms <30000..1800000>]
 *   [--initial-command <json-file> --initial-command-sha256 <sha256> --initial-command-bytes <bytes>]
 *
 * Keep stdin open (for example an exec TTY); send one JSON command per line:
 * {"id":"tools-1","operation":"tools"}
 * {"id":"status-1","operation":"call","name":"evleda_workspace_status","arguments":{}}
 * {"id":"resource-1","operation":"resource","uri":"<returned resource URI>"}
 * {"id":"close-1","operation":"close"}
 *
 * IDs are unique for this connection, including failed commands. No retries,
 * model, tool-list refresh, or board workflow runs automatically. Close refuses
 * a non-idle workspace: first call evleda_close_project explicitly and inspect
 * its result. EOF/signals request SDK shutdown without claiming native cleanup.
 * Full results are retained in exclusive, SHA-256-named evidence files; stdout
 * summaries over 16 KiB omit the payload explicitly. Input frames are <= 1 MiB.
 * The compiled dist host must already exist; this script does not build it.
 */
import { Client, type CallToolResult } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createWriteStream } from "node:fs";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { finished } from "node:stream/promises";
import type { Readable } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspect, parseArgs } from "node:util";

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024;
// Large source-bound native edits can exceed three minutes. This is only the
// client's observation window; it does not change native admission, ownership,
// source checks or recovery deadlines. A timeout still has an unknown outcome.
const DEFAULT_CALL_TIMEOUT_MS = 600_000;
type OperatorId = string | number;
type Command = { id: OperatorId } & ({ operation: "tools" | "close" }
  | { operation: "call"; name: string; arguments: Record<string, unknown> }
  | { operation: "resource"; uri: string });
type Artifact = { path: string; identity: { algorithm: "sha256"; digest: string; size: number } };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (bytes: Buffer) => ({ algorithm: "sha256" as const, digest: createHash("sha256").update(bytes).digest("hex"), size: bytes.length });
const errorDetails = (error: unknown) => ({
  message: error instanceof Error ? error.message : String(error),
  // inspect retains Error causes, AggregateError children and non-enumerable fields.
  details: inspect(error, { depth: null, maxArrayLength: null, maxStringLength: null, getters: false, customInspect: false }),
});

/** Bounds SDK phases such as the final initialization notification as well. */
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    })]);
  } finally { if (abort !== undefined) signal.removeEventListener("abort", abort); }
}

function parseCommand(value: unknown): Command {
  if (!object(value)) throw new Error("Expected a JSON object.");
  if (!(typeof value.id === "string" && value.id.length > 0 && value.id.length <= 128)
    && !(typeof value.id === "number" && Number.isSafeInteger(value.id))) throw new Error("id must be a nonempty string of at most 128 characters or a safe integer.");
  const allowed = value.operation === "call" ? ["id", "operation", "name", "arguments"]
    : value.operation === "resource" ? ["id", "operation", "uri"] : ["id", "operation"];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Unexpected command property.");
  switch (value.operation) {
    case "tools": case "close": return { id: value.id, operation: value.operation };
    case "call":
      if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 256 || !object(value.arguments)) throw new Error("call requires name and an arguments object.");
      return { id: value.id, operation: "call", name: value.name, arguments: value.arguments };
    case "resource":
      if (typeof value.uri !== "string" || !value.uri.trim() || value.uri.length > 4096) throw new Error("resource requires a URI of at most 4096 characters.");
      return { id: value.id, operation: "resource", uri: value.uri };
    default: throw new Error("operation must be tools, call, resource, or close.");
  }
}

/** Bounded byte framing, with stream backpressure while a command is running. */
async function* inputLines(initialCommand?: Buffer): AsyncGenerator<{ raw: Buffer; frameError?: string }> {
  // An operator-pinned initial frame avoids terminal line-length limits for a
  // complete board draft. It uses the same parser, ID rules and evidence path.
  if (initialCommand !== undefined) yield { raw: initialCommand };
  let pending = Buffer.alloc(0);
  for await (const value of process.stdin) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as string);
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(10, start);
      const part = chunk.subarray(start, end < 0 ? chunk.length : end);
      if (pending.length + part.length > MAX_INPUT_BYTES) {
        yield { raw: Buffer.concat([pending, part.subarray(0, MAX_INPUT_BYTES - pending.length)]),
          frameError: `Input exceeds ${MAX_INPUT_BYTES} bytes; only the bounded frame prefix was retained, and nothing was dispatched.` };
        return;
      }
      pending = pending.length === 0 ? Buffer.from(part) : Buffer.concat([pending, part]);
      if (end < 0) break;
      yield { raw: pending };
      pending = Buffer.alloc(0);
      start = end + 1;
    }
  }
  if (pending.length > 0) yield { raw: pending, frameError: "EOF in an unterminated input frame; incomplete command was not dispatched." };
}

async function main() {
  const { values } = parseArgs({ strict: true, allowPositionals: false, options: {
    profile: { type: "string" }, "profile-sha256": { type: "string" }, "profile-bytes": { type: "string" },
    "workspace-root": { type: "string" }, "evidence-dir": { type: "string" }, edit: { type: "boolean", default: false },
    "call-timeout-ms": { type: "string" },
    "initial-command": { type: "string" }, "initial-command-sha256": { type: "string" }, "initial-command-bytes": { type: "string" },
    help: { type: "boolean", default: false },
  } });
  if (values.help) {
    process.stdout.write("Usage: node --import tsx scripts/toolbox-workspace-client.ts --profile <file> --profile-sha256 <sha256> --profile-bytes <bytes> --workspace-root <existing-dir> --evidence-dir <dir> [--edit] [--call-timeout-ms <milliseconds>] [--initial-command <json-file> --initial-command-sha256 <sha256> --initial-command-bytes <bytes>]\n--call-timeout-ms: positive integer 30000..1800000; default 600000. Caller observation only; startup stays 30000 ms and native deadlines are unchanged. Timeout leaves the native outcome unknown; no automatic retries.\nCommands: {id,operation:'tools'|'close'}, {id,operation:'call',name,arguments}, {id,operation:'resource',uri}; JSON lines, unique IDs, <=1 MiB each. The optional pinned initial file contains exactly one command; all subsequent actions remain operator-selected. Keep stdin open.\n");
    return;
  }
  const callTimeoutValue = values["call-timeout-ms"] ?? String(DEFAULT_CALL_TIMEOUT_MS);
  const callTimeoutMs = Number(callTimeoutValue);
  if (!/^[1-9][0-9]*$/u.test(callTimeoutValue) || !Number.isSafeInteger(callTimeoutMs)
      || callTimeoutMs < 30_000 || callTimeoutMs > 1_800_000) {
    throw new Error("--call-timeout-ms must be a positive integer from 30000 through 1800000.");
  }
  for (const key of ["profile", "profile-sha256", "profile-bytes", "workspace-root", "evidence-dir"] as const) {
    if (!values[key]?.trim()) throw new Error(`Missing --${key}.`);
  }
  if (!/^[0-9a-f]{64}$/u.test(values["profile-sha256"]!) || !/^[1-9][0-9]*$/u.test(values["profile-bytes"]!)
    || !Number.isSafeInteger(Number(values["profile-bytes"]))) throw new Error("Profile pin requires exact SHA-256 and positive safe byte count.");
  let initialCommand: Buffer | undefined;
  const initialKeys = ["initial-command", "initial-command-sha256", "initial-command-bytes"] as const;
  if (initialKeys.some(key => values[key] !== undefined)) {
    if (initialKeys.some(key => !values[key]?.trim()) || !/^[0-9a-f]{64}$/u.test(values["initial-command-sha256"]!)
        || !/^[1-9][0-9]*$/u.test(values["initial-command-bytes"]!)) throw new Error("Initial command requires its file, SHA-256 and byte count together.");
    const expectedSize = Number(values["initial-command-bytes"]);
    if (!Number.isSafeInteger(expectedSize) || expectedSize > MAX_INPUT_BYTES) throw new Error("Initial command exceeds the bounded input frame size.");
    const handle = await open(path.resolve(values["initial-command"]!), "r");
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size !== BigInt(expectedSize)) throw new Error("Initial command file differs from its bounded byte count.");
      const bytes = Buffer.alloc(expectedSize + 1); let length = 0;
      while (length < bytes.length) { const part = await handle.read(bytes, length, bytes.length - length, length); if (!part.bytesRead) break; length += part.bytesRead; }
      const after = await handle.stat({ bigint: true });
      if (length !== expectedSize || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("Initial command file changed while reading; nothing was dispatched.");
      initialCommand = bytes.subarray(0, length);
    } finally { await handle.close(); }
    const actual = identity(initialCommand);
    if (actual.size !== expectedSize || actual.digest !== values["initial-command-sha256"]) throw new Error("Initial command bytes differ from the operator's exact pin; nothing was dispatched.");
    parseCommand(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(initialCommand)));
  }
  const repository = fileURLToPath(new URL("../", import.meta.url));
  const host = path.join(repository, "dist/src/mcp/toolbox-workspace-main.js");
  const serverArgs = ["--profile", path.resolve(values.profile!), "--profile-sha256", values["profile-sha256"]!,
    "--profile-bytes", values["profile-bytes"]!, "--workspace-root", path.resolve(values["workspace-root"]!), ...(values.edit ? ["--edit"] : [])];
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && ["SYSTEMROOT", "WINDIR"].includes(key.toUpperCase())) environment[key.toUpperCase()] = value;
  }
  if (!environment.SYSTEMROOT || !environment.WINDIR) throw new Error("SYSTEMROOT and WINDIR must be supplied to this Windows host.");
  // Preserve the qualified smoke client's SDK inheritance. On Windows, Node's
  // runtime also supplies required OS variables from its parent during spawn.
  const output = path.resolve(values["evidence-dir"]!, `workspace-client-${randomUUID()}`);
  await mkdir(output, { recursive: true });
  let fileSequence = 0;
  async function retain(label: string, bytes: Buffer, extension = "json"): Promise<Artifact> {
    const contentIdentity = identity(bytes);
    const filename = `${String(++fileSequence).padStart(6, "0")}-${label}-${contentIdentity.digest}.${extension}`;
    const target = path.join(output, filename);
    await writeFile(target, bytes, { flag: "wx" });
    return { path: target, identity: contentIdentity };
  }
  const retainJson = (label: string, value: unknown) => retain(label, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
  function print(value: Record<string, unknown>, payload?: unknown) {
    const complete = JSON.stringify({ ...value, ...(payload === undefined ? {} : { payload }) });
    if (Buffer.byteLength(complete) <= MAX_OUTPUT_BYTES) process.stdout.write(`${complete}\n`);
    else {
      const { images, ...summary } = value;
      const bounded = JSON.stringify({ ...summary, ...(Array.isArray(images) ? { imageCount: images.length } : {}),
        payloadOmitted: true, instruction: "Read the retained full response artifact; this is a summary, not the complete result." });
      const reference = value.response ?? value.evidence ?? value.session;
      process.stdout.write(`${Buffer.byteLength(bounded) <= MAX_OUTPUT_BYTES ? bounded : JSON.stringify({ event: value.event,
        id: value.id, disposition: value.disposition, payloadOmitted: true,
        evidenceFilename: object(reference) && typeof reference.path === "string" ? path.basename(reference.path) : null,
        instruction: "Summary also exceeds its bound. Read the evidence file in this session's evidence directory." })}\n`);
    }
  }
  const transport = new StdioClientTransport({ command: process.execPath, cwd: repository, env: environment, stderr: "pipe", args: [host, ...serverArgs] });
  const client = new Client({ name: "evleda-interactive-workspace-client", version: "1" }, { versionNegotiation: { mode: "legacy" } });
  const cancellation = new AbortController();
  let connecting: Promise<void> | undefined;
  const stderrPath = path.join(output, "host-stderr.log");
  const stderrLog = createWriteStream(stderrPath, { flags: "wx" });
  const stderrFinished = finished(stderrLog);
  // Register rejection handling immediately; it is also awaited before final evidence.
  void stderrFinished.catch(() => undefined);
  transport.stderr?.pipe(stderrLog);
  let stderrEnded = false;
  transport.stderr?.once("end", () => { stderrEnded = true; });
  let reason = "eof", expectedTransportClose = false, idleConfirmed = false;
  let closing: Promise<unknown> | undefined;
  let terminalError: unknown;
  const ids = new Set<string>();
  let activeRequest: Artifact | undefined;
  let wireArtifacts: Artifact[] = [];
  let incomingWrites = Promise.resolve();
  let protocolWrites = Promise.resolve();
  // Retain wire results before SDK schema validation, including late responses
  // after timeout. A validation exception must not erase what the server sent.
  const startTransport = transport.start.bind(transport);
  transport.start = async () => {
    cancellation.signal.throwIfAborted();
    const receive = transport.onmessage;
    transport.onmessage = message => {
      incomingWrites = incomingWrites.then(async () => {
        const evidence = await retainJson("mcp-received", { receivedAt: new Date().toISOString(), message });
        wireArtifacts.push(evidence);
        receive?.(message);
      }).catch(error => { terminalError ??= error; stop("wire_evidence_error"); });
    };
    await startTransport();
  };
  client.onerror = error => {
    protocolWrites = protocolWrites.then(async () => {
      const evidence = await retainJson("protocol-error", { recordedAt: new Date().toISOString(), error: errorDetails(error) });
      print({ event: "protocol_error", evidence });
    }).catch(error => { terminalError ??= error; stop("protocol_evidence_error"); });
  };
  const shutdown = () => closing ??= (async () => {
    expectedTransportClose = true;
    cancellation.abort(new Error(`Client shutdown: ${reason}`));
    let closeError: unknown;
    // Do not wait for connect: its final notification can be awaiting pipe drain.
    // start() checks cancellation before spawning, so a late start cannot leak a host.
    try { await client.close(); } catch (error) { closeError = error; }
    await incomingWrites; await protocolWrites;
    (transport.stderr as Readable | null)?.unpipe(stderrLog);
    stderrLog.end();
    let stderrArtifact: Artifact | undefined;
    try { await stderrFinished; stderrArtifact = { path: stderrPath, identity: identity(await readFile(stderrPath)) }; }
    catch (error) { closeError ??= error; }
    return { reason, sdkCloseReturned: closeError === undefined,
      nativeCleanup: idleConfirmed ? "workspace_idle_confirmed_before_shutdown" : "not_verified",
      instruction: "SDK shutdown is best-effort and may escalate termination; it does not prove a native checkpoint, lease release, or design acceptance.",
      ...(activeRequest === undefined || reason === "operator_close" ? {} : { interruptedRequest: activeRequest }),
      ...(stderrArtifact === undefined ? {} : { stderr: stderrArtifact, stderrComplete: stderrEnded }),
      ...(closeError === undefined ? {} : { error: errorDetails(closeError) }) };
  })();
  const stop = (signal: string) => {
    reason = signal; process.exitCode = 1;
    expectedTransportClose = true;
    cancellation.abort(new Error(`Client stopping: ${signal}`));
    process.stdin.destroy();
    void shutdown().catch(error => { terminalError ??= error; });
  };
  const onInterrupt = () => stop("SIGINT"), onTerminate = () => stop("SIGTERM");
  process.once("SIGINT", onInterrupt); process.once("SIGTERM", onTerminate);
  client.onclose = () => { if (!expectedTransportClose) stop("unexpected_transport_close"); };
  try {
    const session = await retainJson("session", { startedAt: new Date().toISOString(), command: process.execPath, host, serverArgs,
      environment: { explicitKeys: Object.keys(environment).sort(), sdkDefaultKeys: Object.keys(getDefaultEnvironment()).sort(),
        note: "SDK defaults plus explicit system directories; the Windows runtime may also supply required OS variables. Values are not recorded." },
      timeoutsMs: { startup: 30_000, call: callTimeoutMs }, maxInputBytes: MAX_INPUT_BYTES, maxOutputBytes: MAX_OUTPUT_BYTES });
    if (closing !== undefined || cancellation.signal.aborted) return;
    const startupSignal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(30_000)]);
    connecting = client.connect(transport, { timeout: 30_000, signal: startupSignal });
    await abortable(connecting, startupSignal);
    print({ event: "ready", session, evidenceDirectory: output, childPid: transport.pid, access: values.edit ? "edit" : "read-only" });
    for await (const { raw, frameError } of inputLines(initialCommand)) {
      if (closing !== undefined) break;
      const request = await retain(frameError === undefined ? "request" : "incomplete-request", frameError === undefined ? Buffer.concat([raw, Buffer.from("\n")]) : raw, "jsonl");
      activeRequest = request;
      wireArtifacts = [];
      let command: Command | undefined;
      let id: OperatorId | undefined;
      let outcome: Record<string, unknown>;
      try {
        if (frameError !== undefined) throw new Error(frameError);
        const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
        if (object(parsed) && ((typeof parsed.id === "string" && parsed.id.length > 0 && parsed.id.length <= 128)
          || (typeof parsed.id === "number" && Number.isSafeInteger(parsed.id)))) {
          id = parsed.id;
          const key = JSON.stringify(id);
          if (ids.has(key)) throw new Error("Duplicate operator id rejected; no MCP request was dispatched. Choose a new id only after inspecting prior evidence.");
          ids.add(key);
        }
        command = parseCommand(parsed);
        cancellation.signal.throwIfAborted();
        const requestOptions = { timeout: callTimeoutMs, maxTotalTimeout: callTimeoutMs,
          signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(callTimeoutMs)]) };
        switch (command.operation) {
          case "tools": outcome = { disposition: "response", result: await client.listTools({}, { ...requestOptions, cacheMode: "refresh" }) }; break;
          case "resource": outcome = { disposition: "response", result: await client.readResource({ uri: command.uri }, { ...requestOptions, cacheMode: "refresh" }) }; break;
          case "call": {
            idleConfirmed = false;
            const result = await client.callTool({ name: command.name, arguments: command.arguments }, requestOptions);
            outcome = { disposition: "response", isError: result.isError ?? false, result };
            break;
          }
          case "close": {
            const statusRequest = await retainJson("close-status-request", { operatorRequest: request, name: "evleda_workspace_status", arguments: {} });
            const status = await client.callTool({ name: "evleda_workspace_status", arguments: {} }, requestOptions);
            const statusResponse = await retainJson("close-status-response", { request: statusRequest, result: status });
            const body = status.structuredContent;
            if (status.isError || !object(body) || body.activeProject !== null || body.nativeState !== "absent" || body.stopping !== false) {
              outcome = { disposition: "close_refused", statusResponse, result: status,
                instruction: "Workspace is not confirmed idle. Inspect this status and explicitly call evleda_close_project before closing the client; needs-review state requires host review." };
            } else {
              idleConfirmed = true; reason = "operator_close";
              outcome = { disposition: "client_closed", statusResponse, shutdown: await shutdown() };
            }
          }
        }
      } catch (error) {
        outcome = { disposition: command === undefined ? "command_rejected" : "request_error", error: errorDetails(error),
          ...(command === undefined ? { dispatched: false } : { nativeOutcome: "unknown; inspect retained evidence before choosing another action" }) };
      }
      await incomingWrites; await protocolWrites;
      const response = await retainJson("response", { recordedAt: new Date().toISOString(), request, wireEvidence: [...wireArtifacts], ...outcome });
      const images: Artifact[] = [];
      const imageErrors: unknown[] = [];
      if (object(outcome.result) && Array.isArray(outcome.result.content)) {
        for (const item of outcome.result.content as CallToolResult["content"]) {
          if (item.type !== "image" || item.mimeType !== "image/png") continue;
          try {
            const bytes = Buffer.from(item.data, "base64");
            if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("MCP image/png content lacks a PNG signature; original content retained in response.");
            images.push(await retain("image", bytes, "png"));
          } catch (error) { imageErrors.push(errorDetails(error)); }
        }
      }
      const imageEvidence = images.length === 0 && imageErrors.length === 0 ? undefined : await retainJson("image-extraction", { response, images, errors: imageErrors });
      print({ id: id ?? null, disposition: outcome.disposition, ...(outcome.isError === undefined ? {} : { isError: outcome.isError }), request, response,
        ...(imageEvidence === undefined ? {} : { imageEvidence, images }) }, outcome);
      activeRequest = undefined;
      if (frameError !== undefined) { reason = "invalid_input_frame"; process.exitCode = 1; break; }
      if (closing !== undefined) break;
    }
  } catch (error) {
    terminalError = error; process.exitCode = 1;
    if (reason === "eof") reason = "client_error";
  } finally {
    const terminal = await retainJson("terminal", { endedAt: new Date().toISOString(), ...await shutdown() as object,
      ...(terminalError === undefined ? {} : { error: errorDetails(terminalError) }) });
    print({ event: "terminal", evidence: terminal, reason, nativeCleanup: idleConfirmed ? "workspace_idle_confirmed_before_shutdown" : "not_verified" });
    process.removeListener("SIGINT", onInterrupt); process.removeListener("SIGTERM", onTerminate);
    process.stdin.destroy();
  }
}

void main().catch(error => { process.stderr.write(`${inspect(error, { depth: null })}\n`); process.exitCode = 1; });
