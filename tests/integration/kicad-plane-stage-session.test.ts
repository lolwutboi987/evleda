import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import padProtocol from "../fixtures/kicad-mcp-live-pcb-pad-snapshot-protocol.json" with { type: "json" };
import { contentIdentity } from "../../src/core/canonical.js";
import {
  KICAD_PLANE_STAGE_TOOL, KICAD_PLANE_STAGE_TIMEOUT_MS,
  KICAD_PLANE_STAGE_INPUT_JSON_SCHEMA, KICAD_PLANE_STAGE_OUTPUT_JSON_SCHEMA, KICAD_PLANE_STAGE_ANNOTATIONS,
  type KicadPlaneStageInput,
} from "../../src/integrations/kicad-plane-stage.js";
import {
  KicadMcpSession, KicadMcpAuthorizationError, KicadPlaneStageMayHaveMutatedError,
  createKicadMcpExpectedExecutableIdentity, type KicadMcpSessionOptions,
} from "../../src/integrations/kicad-mcp-session.js";

const runtimeWitness = vi.hoisted(() => ({ marker: "" }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const originalLstat = actual.lstat as unknown as (...args: unknown[]) => Promise<Record<string, unknown>>;
  return { ...actual, lstat: async (...args: unknown[]) => {
    const observed = await originalLstat(...args);
    if (runtimeWitness.marker && String(args[0]) === process.execPath && typeof observed.mtimeNs === "bigint"
        && await actual.access(runtimeWitness.marker).then(() => true, () => false)) {
      return Object.assign(Object.create(Object.getPrototypeOf(observed)), observed, { mtimeNs: observed.mtimeNs + 1n });
    }
    return observed;
  } };
});

const FAKE_SERVER = String.raw`
const fs = require('node:fs');
const rl = require('node:readline').createInterface({ input: process.stdin, crlfDelay: Infinity });
const file = process.argv[2];
const fixture = JSON.parse(fs.readFileSync(file, 'utf8'));
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
rl.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') return send({ jsonrpc:'2.0', id:message.id, result:{ protocolVersion:message.params.protocolVersion, capabilities:{tools:{}}, serverInfo:{name:'kicad-mcp-pro',version:'1.29.1'} } });
  if (message.method === 'tools/list') return send({ jsonrpc:'2.0',id:message.id,result:{tools:fixture.tools} });
  if (message.method !== 'tools/call') return;
  fs.appendFileSync(file + '.calls', JSON.stringify(message.params) + '\n');
  const name = message.params.name;
  if (name === 'evleda_stage_plane') {
    if (fixture.corruptArtifact) fs.writeFileSync(fixture.artifactPath, '{}', 'utf8');
    if (fixture.runtimeMarker) fs.writeFileSync(fixture.runtimeMarker, 'changed witness', 'utf8');
    if (fixture.transportFailure) return send({jsonrpc:'2.0',id:message.id,error:{code:-32603,message:'bounded fake RPC failure'}});
    return setTimeout(() => send({jsonrpc:'2.0',id:message.id,result:fixture.result}), fixture.delayMs ?? 0);
  }
  if (name === 'evleda_get_live_pcb_document') return send({jsonrpc:'2.0',id:message.id,result:fixture.liveSource});
  if (name === 'evleda_get_live_pcb_pad_snapshot' || (name === 'pcb_get_board_summary' && fixture.readFailure)) return send({jsonrpc:'2.0',id:message.id,result:{content:[{type:'text',text:'categorical read failure'}],isError:true}});
  return send({jsonrpc:'2.0',id:message.id,result:{content:[{type:'text',text:JSON.stringify({ok:true,name})}],structuredContent:{ok:true,name},isError:false}});
});
`;

const temporaryRoot = path.resolve(tmpdir());
const owned = new Set<string>();
const sessions = new Set<KicadMcpSession>();
afterEach(async () => {
  runtimeWitness.marker = "";
  vi.restoreAllMocks();
  for (const session of sessions) await session.close();
  sessions.clear();
  for (const directory of owned) {
    const relative = path.relative(temporaryRoot, path.resolve(directory));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Plane session fixture cleanup escaped its owned temporary root.");
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  owned.clear();
});

const envelope = (value: Record<string, unknown>) => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError: false });
const descriptor = () => ({ name: KICAD_PLANE_STAGE_TOOL, inputSchema: KICAD_PLANE_STAGE_INPUT_JSON_SCHEMA,
  outputSchema: KICAD_PLANE_STAGE_OUTPUT_JSON_SCHEMA, annotations: KICAD_PLANE_STAGE_ANNOTATIONS });

async function fixture(options: { advertised?: boolean; complete?: boolean; mutationDispatched?: boolean; recoveryRequired?: boolean;
  large?: boolean; delayMs?: number; corruptArtifact?: boolean; badReference?: boolean; mismatchedText?: boolean;
  malformedReceipt?: boolean; runtimeChange?: boolean; tool?: Record<string, unknown>; savedMismatch?: boolean; readFailure?: boolean;
  badFilename?: boolean; transportFailure?: boolean; toolFailure?: boolean } = {}) {
  await mkdir(temporaryRoot, { recursive: true });
  const workspace = await mkdtemp(path.join(temporaryRoot, "evleda-plane-session-")); owned.add(workspace);
  const project = path.join(workspace, "project"), outputRoot = path.join(workspace, "output");
  await Promise.all([mkdir(project), mkdir(outputRoot)]);
  const boardFile = path.join(project, "board.kicad_pcb");
  const source = "(kicad_pcb (version 20260101))\n";
  await writeFile(boardFile, source, "utf8");
  const saved = contentIdentity(Buffer.from(source, "utf8"));
  const args: KicadPlaneStageInput = {
    board_file: boardFile, zone_ids: ["10000000-0000-0000-0000-000000000001"],
    reference_pads: [{ reference: "U1", pad: "1", primitiveId: "20000000-0000-0000-0000-000000000002" }],
    request: { expectedSavedIdentity: options.savedMismatch ? { ...saved, digest: "0".repeat(64) } : saved,
      expectedLiveIdentity: saved, mutation: { operation: "create", netName: "GND", layer: "B.Cu", rectangleNm: { x1: 0, y1: 0, x2: 10_000_000, y2: 10_000_000 },
        clearanceNm: 250_000, minWidthNm: 200_000, priority: 1, name: "Owned plane", connection: "full", islandPolicy: "always" } },
  };
  const receipt: Record<string, unknown> = {
    schemaVersion: "evleda.native-plane-stage.v1", complete: options.complete ?? true, nativeSaveCalled: false,
    mutationDispatched: options.mutationDispatched ?? true, recoveryRequired: options.recoveryRequired ?? false,
    request: structuredClone(args.request), rpc: [],
    assurance: { accepted: false, minimumSpokes: "not_configured_by_zone_api", highFrequencyValidity: "not_established" },
    rawNative: { path: "C:/private/native-records", coordinateNm: "1234567890123456789", ...(options.large ? { records: Array(6).fill("Ω".repeat(260_000)) } : {}) },
  };
  if (options.malformedReceipt) receipt.nativeSaveCalled = true;
  const bytes = Buffer.from(JSON.stringify(receipt), "utf8");
  const filename = "evleda-plane-stage-30000000-0000-0000-0000-000000000003.json";
  const artifactPath = path.join(outputRoot, filename);
  await writeFile(artifactPath, bytes);
  const reference = { schemaVersion: "evleda.native-plane-stage-artifact.v1", filename: options.badFilename ? `../${filename}` : filename,
    identity: options.badReference ? { ...contentIdentity(bytes), digest: "0".repeat(64) } : contentIdentity(bytes) };
  const result = envelope(reference);
  if (options.mismatchedText) result.content[0]!.text = JSON.stringify({ ...reference, filename: "evleda-plane-stage-40000000-0000-0000-0000-000000000004.json" });
  const runtimeMarker = options.runtimeChange ? path.join(workspace, "runtime-witness-change") : undefined;
  const fixtureFile = path.join(workspace, "server.json");
  const tools = ["pcb_get_board_summary", "pcb_get_board_as_string", "pcb_save", "pcb_revert", "pcb_add_zone", "evleda_get_live_pcb_document"]
    .map(name => ({ name, inputSchema: { type: "object", properties: {}, additionalProperties: false } }));
  const privateTool = options.tool ?? descriptor();
  const padTool = { name: padProtocol.toolName, inputSchema: padProtocol.inputSchema, outputSchema: padProtocol.outputSchema, annotations: padProtocol.annotations };
  await writeFile(fixtureFile, JSON.stringify({ tools: [...tools, padTool, ...(options.advertised === false ? [] : [privateTool])],
    result: options.toolFailure ? { isError: true, content: [{ type: "text", text: "original private plane failure" }] } : result,
    delayMs: options.delayMs ?? 0, corruptArtifact: options.corruptArtifact ?? false, artifactPath, runtimeMarker,
    transportFailure: options.transportFailure ?? false,
    readFailure: options.readFailure ?? false,
    liveSource: options.readFailure ? { content: [{ type: "text", text: "categorical source read failure" }], isError: true }
      : envelope({ schemaVersion: "evleda.kicad-live-pcb-document.v1", documentType: "pcb", projectPath: project, boardFilename: "board.kicad_pcb", boardSource: source }),
  }), "utf8");
  return { workspace, project, outputRoot, boardFile, source, args, receipt, reference, artifactPath, runtimeMarker,
    callsPath: `${fixtureFile}.calls`, command: { command: process.execPath,
      args: ["-e", "eval(Buffer.from(process.argv[1], 'base64').toString('utf8'))", Buffer.from(FAKE_SERVER).toString("base64"), fixtureFile] } };
}

async function connect(f: Awaited<ReturnType<typeof fixture>>, extra: Partial<KicadMcpSessionOptions> = {}) {
  const mode = extra.mode ?? "write";
  const session = await KicadMcpSession.connect({ workspaceRoot: f.workspace, projectRoot: f.project, outputRoot: f.outputRoot,
    mode, ...(mode === "write" ? { freshProject: true } : {}), command: f.command, environment: process.env,
    expectedLauncherIdentity: await createKicadMcpExpectedExecutableIdentity(process.execPath), ...extra });
  sessions.add(session);
  return session;
}
const calls = async (f: Awaited<ReturnType<typeof fixture>>) => (await readFile(f.callsPath, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { name: string; arguments: Record<string, unknown> });

describe("host-private plane stage session", () => {
  it("returns the complete multi-MiB hash-bound artifact while retaining the normal wire budget", async () => {
    const f = await fixture({ large: true });
    expect(Buffer.byteLength(JSON.stringify(f.receipt), "utf8")).toBeGreaterThan(2 * 1024 * 1024);
    const session = await connect(f, { maxMessageBytes: 64 * 1024, requiredTools: [KICAD_PLANE_STAGE_TOOL] });
    expect(session.supportsPlaneStage()).toBe(true);
    expect(session.listTools().map(tool => tool.name)).not.toContain(KICAD_PLANE_STAGE_TOOL);
    await expect(session.callTool(KICAD_PLANE_STAGE_TOOL, f.args)).rejects.toBeInstanceOf(KicadMcpAuthorizationError);
    const expectedArgs = structuredClone(f.args);
    const pending = session.stagePlane(f.args);
    f.args.reference_pads[0]!.reference = "caller changed";
    f.args.zone_ids.reverse();
    expect(await pending).toEqual(f.receipt);
    expect(await calls(f)).toEqual([{ name: KICAD_PLANE_STAGE_TOOL, arguments: expectedArgs }]);
    expect(await readFile(f.boardFile, "utf8")).toBe(f.source);
  });

  it("uses the private 90-second deadline and keeps the session exclusive only while staging", async () => {
    const f = await fixture({ delayMs: 1200 });
    const session = await connect(f, { timeoutMs: 1000 });
    const timers = vi.spyOn(globalThis, "setTimeout");
    const pending = session.stagePlane(f.args);
    expect(session.supportsPlaneStage()).toBe(false);
    await expect(session.callTool("pcb_save")).rejects.toThrow(/exclusive session access/iu);
    await expect(session.readActivePcbSource(f.boardFile)).rejects.toThrow(/exclusive session access/iu);
    await expect(session.stagePlane(f.args)).rejects.toThrow(/idle session/iu);
    await pending;
    expect(timers.mock.calls.some(([, delay]) => typeof delay === "number" && delay > 30_000 && delay <= KICAD_PLANE_STAGE_TIMEOUT_MS)).toBe(true);
    expect(session.supportsPlaneStage()).toBe(true);
    expect((await calls(f)).map(call => call.name)).toEqual([KICAD_PLANE_STAGE_TOOL]);
  });

  it("keeps absent, readonly and unbound stage capabilities unsupported without fallback", async () => {
    const absent = await fixture({ advertised: false });
    await expect(connect(absent, { requiredTools: [KICAD_PLANE_STAGE_TOOL] })).rejects.toThrow(/not advertised/iu);
    const old = await connect(absent);
    expect(old.supportsPlaneStage()).toBe(false);
    await expect(old.stagePlane(absent.args)).rejects.toThrow(/lacks its host plane stage/iu);
    expect(await old.readActivePcbSource(absent.boardFile)).toBe(absent.source);
    expect((await calls(absent)).map(call => call.name)).toEqual(["evleda_get_live_pcb_document"]);
    const present = await fixture();
    const readonly = await connect(present, { mode: "readonly" });
    expect(readonly.supportsPlaneStage()).toBe(false);
    await expect(readonly.stagePlane(present.args)).rejects.toThrow(/host-only write-session/iu);
    const launchCwd = path.join(present.workspace, "private-launch"); await mkdir(launchCwd);
    const unbound = await connect(present, { deferProjectBinding: true, launchCwd });
    expect(unbound.supportsPlaneStage()).toBe(false);
    await expect(unbound.stagePlane(present.args)).rejects.toThrow(/host-bound/iu);
    await expect(readFile(present.callsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects changed registration metadata before any call", async () => {
    for (const tool of [
      { ...descriptor(), annotations: { ...KICAD_PLANE_STAGE_ANNOTATIONS, readOnlyHint: true } },
      { ...descriptor(), inputSchema: { ...KICAD_PLANE_STAGE_INPUT_JSON_SCHEMA, additionalProperties: true } },
      { ...descriptor(), outputSchema: { ...KICAD_PLANE_STAGE_OUTPUT_JSON_SCHEMA, additionalProperties: true } },
      { ...descriptor(), _meta: {} },
    ]) {
      const f = await fixture({ tool });
      await expect(connect(f)).rejects.toThrow(/plane stage registration/iu);
      await expect(readFile(f.callsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("rejects malformed plans, wrong saved pins and foreign paths before mutation without closing", async () => {
    const f = await fixture(); const foreign = await fixture();
    const alias = path.join(f.workspace, "project-alias"); await symlink(f.project, alias, process.platform === "win32" ? "junction" : "dir");
    const session = await connect(f);
    const candidates: unknown[] = [
      { ...f.args, extra: true }, { ...f.args, reference_pads: JSON.stringify(f.args.reference_pads) },
      { ...f.args, zone_ids: [...f.args.zone_ids, ...f.args.zone_ids] },
      { ...f.args, request: { ...f.args.request, expectedSavedIdentity: { ...f.args.request.expectedSavedIdentity, digest: "0".repeat(64) } } },
      { ...f.args, board_file: foreign.boardFile }, { ...f.args, board_file: path.join(alias, "board.kicad_pcb") },
      { ...f.args, board_file: "board.kicad_pcb" },
    ];
    for (const candidate of candidates) {
      await expect(session.stagePlane(candidate as KicadPlaneStageInput)).rejects.toThrow();
      expect(session.supportsPlaneStage()).toBe(true);
    }
    await expect(readFile(f.callsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await session.readActivePcbSource(f.boardFile)).toBe(f.source);
    expect(await readFile(f.boardFile, "utf8")).toBe(f.source);
  });

  it.each([
    { mutationDispatched: false, recoveryRequired: false, quarantined: false },
    { mutationDispatched: true, recoveryRequired: true, quarantined: true },
    { mutationDispatched: false, recoveryRequired: true, quarantined: true },
  ])("returns a complete:false receipt with source-aware quarantine $quarantined", async state => {
    const f = await fixture({ complete: false, ...state });
    const session = await connect(f);
    expect(await session.stagePlane(f.args)).toEqual(f.receipt);
    expect(session.supportsPlaneStage()).toBe(!state.quarantined);
    expect(await session.readActivePcbSource(f.boardFile)).toBe(f.source);
    await expect(session.callTool("pcb_get_board_summary")).resolves.toBeDefined();
    if (state.quarantined) {
      await expect(session.callTool("pcb_save")).rejects.toThrow(/quarantined/iu);
      await expect(session.callTool("pcb_add_zone")).rejects.toThrow(/quarantined/iu);
      await expect(session.applySchematicConnectivityBatch({})).rejects.toThrow(/quarantined/iu);
      await expect(session.stagePlane(f.args)).rejects.toThrow(/quarantined/iu);
      await expect(session.callTool("pcb_revert")).resolves.toBeDefined();
      await expect(session.callTool("pcb_save")).rejects.toThrow(/quarantined/iu);
    }
    const observed = (await calls(f)).map(call => call.name);
    expect(observed.filter(name => name === KICAD_PLANE_STAGE_TOOL)).toHaveLength(1);
    expect(observed).not.toContain("pcb_save");
    expect(observed.filter(name => name === "pcb_revert")).toHaveLength(state.quarantined ? 1 : 0);
  });

  it.each(["badReference", "badFilename", "corruptArtifact", "mismatchedText", "malformedReceipt", "contradiction", "runtimeChange", "transportFailure"] as const)("quarantines post-dispatch %s failures without closing or retrying", async kind => {
    const f = await fixture(kind === "contradiction" ? { complete: false, mutationDispatched: true, recoveryRequired: false } : { [kind]: true });
    const session = await connect(f);
    if (f.runtimeMarker) runtimeWitness.marker = f.runtimeMarker;
    const error = await session.stagePlane(f.args).then(() => undefined, caught => caught as unknown);
    if (kind === "runtimeChange") await expect(session.readActivePcbSource(f.boardFile)).rejects.toThrow();
    runtimeWitness.marker = "";
    expect(error).toBeInstanceOf(KicadPlaneStageMayHaveMutatedError);
    expect(error).toMatchObject({ mayHaveMutated: true, writesQuarantined: true });
    expect(session.supportsPlaneStage()).toBe(false);
    await expect(session.stagePlane(f.args)).rejects.toThrow(/quarantined/iu);
    await expect(session.callTool("pcb_save")).rejects.toThrow(/quarantined/iu);
    expect(await session.readActivePcbSource(f.boardFile)).toBe(f.source);
    await expect(session.callTool("pcb_revert")).resolves.toBeDefined();
    expect((await calls(f)).map(call => call.name)).toEqual([KICAD_PLANE_STAGE_TOOL, "evleda_get_live_pcb_document", "pcb_revert"]);
  });

  it("retains the literal negative plane reply without requiring a success artifact envelope", async () => {
    const f = await fixture({ toolFailure: true }), session = await connect(f);
    const error = await session.stagePlane(f.args).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(KicadPlaneStageMayHaveMutatedError);
    expect(((error as Error).cause as Error).cause).toEqual({ operation: KICAD_PLANE_STAGE_TOOL,
      response: { isError: true, content: [{ type: "text", text: "original private plane failure" }] } });
    expect(String(error)).not.toContain("original private plane failure");
    await expect(session.callTool("pcb_save")).rejects.toThrow(/quarantined/iu);
    expect(await session.readActivePcbSource(f.boardFile)).toBe(f.source);
  });

  it("retains recovery ownership after quarantined public, source and pad read failures", async () => {
    const f = await fixture({ complete: false, mutationDispatched: true, recoveryRequired: true, readFailure: true });
    const session = await connect(f);
    expect(await session.stagePlane(f.args)).toEqual(f.receipt);
    await expect(session.readActivePcbSource(f.boardFile)).rejects.toThrow(/live PCB document/iu);
    await expect(session.readLivePcbPadSnapshot([])).rejects.toThrow(/pad snapshot failure/iu);
    await expect(session.callTool("pcb_get_board_summary")).rejects.toThrow(/categorical tool-failure/iu);
    await expect(session.callTool("pcb_save")).rejects.toThrow(/quarantined/iu);
    await expect(session.callTool("pcb_revert")).resolves.toBeDefined();
    expect(session.supportsPlaneStage()).toBe(false);
    expect((await calls(f)).map(call => call.name)).toEqual([KICAD_PLANE_STAGE_TOOL, "evleda_get_live_pcb_document", "evleda_get_live_pcb_pad_snapshot", "pcb_get_board_summary", "pcb_revert"]);
    await session.close();
    await expect(session.readActivePcbSource(f.boardFile)).rejects.toThrow(/closed/iu);
  });

  it("retains the underlying post-dispatch cause without changing the public uncertainty message", async () => {
    const f = await fixture({ transportFailure: true });
    const session = await connect(f);
    const error = await session.stagePlane(f.args).then(() => undefined, caught => caught as unknown);
    expect(error).toBeInstanceOf(KicadPlaneStageMayHaveMutatedError);
    const failure = error as KicadPlaneStageMayHaveMutatedError;
    expect(failure).toMatchObject({ mayHaveMutated: true, writesQuarantined: true });
    expect(failure.cause).toBeInstanceOf(Error);
    expect((failure.cause as Error).message).toContain("bounded fake RPC failure");
    expect(failure.message).not.toContain("bounded fake RPC failure");
    expect(session.supportsPlaneStage()).toBe(false);
    await expect(session.callTool("pcb_save")).rejects.toThrow(/quarantined/iu);
    expect(await session.readActivePcbSource(f.boardFile)).toBe(f.source);
    expect((await calls(f)).map(call => call.name)).toEqual([KICAD_PLANE_STAGE_TOOL, "evleda_get_live_pcb_document"]);
  });
});
