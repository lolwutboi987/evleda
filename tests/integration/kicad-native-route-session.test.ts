import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { specTypeSchemas, type CallToolResult } from "@modelcontextprotocol/client";
import contracts from "../fixtures/kicad-native-commit-tool-contracts.json" with { type: "json" };
import { hasQualifiedNativeBoardReply } from "../../src/harness/fresh-board-persistence.js";
import {
  KicadMcpSession, KicadMcpAuthorizationError, KicadNativeRouteRecoveryRequiredError,
  createKicadMcpExpectedExecutableIdentity, type KicadMcpSessionOptions,
} from "../../src/integrations/kicad-mcp-session.js";

const SERVER = String.raw`
const fs=require('node:fs');
const fixtureFile=process.argv[2], f=JSON.parse(fs.readFileSync(fixtureFile,'utf8'));
const rl=require('node:readline').createInterface({input:process.stdin,crlfDelay:Infinity});
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const text=value=>({content:[{type:'text',text:value}],structuredContent:{result:value},isError:false});
const seen=new Set();let pushed=false,sourceFailed=false,boardName='board.kicad_pcb';
const replies={pcb_begin_commit:'Transaction group started. Use pcb_push_commit to apply or pcb_drop_commit to discard.',pcb_push_commit:'Transaction group committed successfully.',pcb_drop_commit:'Transaction group discarded successfully.',pcb_revert:'Board reverted to last saved state. All unsaved changes have been discarded.',pcb_save:'Board saved.'};
rl.on('line',line=>{
  const m=JSON.parse(line);
  if(m.method==='initialize')return send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'kicad-mcp-pro',version:'1.29.1'}}});
  if(m.method==='tools/list')return send({jsonrpc:'2.0',id:m.id,result:{tools:f.tools}});
  if(m.method!=='tools/call')return;
  const name=m.params.name;
  fs.appendFileSync(fixtureFile+'.calls',JSON.stringify(m.params)+'\n');
  if(name==='evleda_get_live_pcb_document'){
    if(pushed&&f.sourceFailureAfterPush&&!sourceFailed){sourceFailed=true;return send({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'post-write native read failure'}],isError:true}});}
    const d={schemaVersion:'evleda.kicad-live-pcb-document.v1',documentType:'pcb',projectPath:f.project,boardFilename:boardName,boardSource:f.source};
    return send({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:JSON.stringify(d)}],structuredContent:d,isError:false}});
  }
  if(name==='pcb_push_commit')pushed=true;
  const failure=f.failures[name];
  if(failure&&!seen.has(name)){
    seen.add(name);if(f.switchDocumentOnFailure)boardName='other.kicad_pcb';
    if(failure==='hang')return;
    if(failure==='rpc')return send({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:'original native RPC fault'}});
    if(failure==='malformed')return send({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'malformed native body'}],structuredContent:{result:42},isError:false}});
    if(failure==='ambiguous')return send({jsonrpc:'2.0',id:m.id,result:text('Native commit may have changed; acknowledgement unavailable.')});
    return send({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'original native tool failure detail'}],isError:true}});
  }
  return send({jsonrpc:'2.0',id:m.id,result:text(replies[name]??'native operation succeeded')});
});
`;

const roots = new Set<string>(), sessions = new Set<KicadMcpSession>();
afterEach(async () => {
  for (const session of sessions) await session.close();
  sessions.clear();
  const base = path.resolve(tmpdir());
  for (const directory of roots) {
    const relative = path.relative(base, path.resolve(directory));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Native route fixture escaped its owned temporary root.");
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  roots.clear();
});

async function fixture(options: { legacy?: boolean; descriptors?: readonly unknown[]; failures?: Record<string, string>;
  sourceFailureAfterPush?: boolean; switchDocumentOnFailure?: boolean } = {}) {
  const base = tmpdir(); await mkdir(base, { recursive: true });
  const workspace = await mkdtemp(path.join(base, "evleda-native-route-")); roots.add(workspace);
  const project = path.join(workspace, "project"), outputRoot = path.join(workspace, "output");
  await Promise.all([mkdir(project), mkdir(outputRoot)]);
  const source = "(kicad_pcb (version 20260101))\n", boardFile = path.join(project, "board.kicad_pcb");
  await writeFile(boardFile, source, "utf8");
  const names = ["pcb_add_track", "pcb_save", "pcb_revert", "pcb_get_board_summary", "pcb_move_footprint"];
  const tools = names.map(name => ({ name, inputSchema: { type: "object", additionalProperties: true },
    outputSchema: { type: "object", properties: { result: { type: "string" } }, required: ["result"], additionalProperties: false } }));
  const file = path.join(workspace, "server.json");
  await writeFile(file, JSON.stringify({ project, source, failures: options.failures ?? {}, sourceFailureAfterPush: options.sourceFailureAfterPush ?? false,
    switchDocumentOnFailure: options.switchDocumentOnFailure ?? false,
    tools: [...tools, { name: "evleda_get_live_pcb_document", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
      ...(options.descriptors ?? (options.legacy ? contracts.before : contracts.after))],
  }), "utf8");
  return { workspace, project, outputRoot, source, boardFile, callsFile: `${file}.calls`,
    command: { command: process.execPath, args: ["-e", "eval(Buffer.from(process.argv[1], 'base64').toString('utf8'))", Buffer.from(SERVER).toString("base64"), file] } };
}

async function connect(f: Awaited<ReturnType<typeof fixture>>, extra: Partial<KicadMcpSessionOptions> = {}) {
  const mode = extra.mode ?? "write";
  const session = await KicadMcpSession.connect({ workspaceRoot: f.workspace, projectRoot: f.project, outputRoot: f.outputRoot,
    mode, ...(mode === "write" ? { freshProject: true } : {}), command: f.command, environment: process.env,
    expectedLauncherIdentity: await createKicadMcpExpectedExecutableIdentity(process.execPath), ...extra });
  sessions.add(session); return session;
}
const callNames = async (f: Awaited<ReturnType<typeof fixture>>) => (await readFile(f.callsFile, "utf8")).trim().split("\n").map(line => (JSON.parse(line) as { name: string }).name);
async function begin(session: KicadMcpSession, f: Awaited<ReturnType<typeof fixture>>) {
  await session.readActivePcbSource(f.boardFile);
  await session.callTool("pcb_begin_commit", {});
}
const track = { x1_mm: 3, y1_mm: 7, x2_mm: 10, y2_mm: 7, layer: "F_Cu", width_mm: 0.5, net_name: "VIN" };

describe("qualified native route session recovery", () => {
  it("rejects DOC3/DOC4 name-only transactions before opening a native commit", async () => {
    const f = await fixture({ legacy: true }), session = await connect(f);
    expect(session.supportsNativeRouteTransactions()).toBe(false);
    await session.readActivePcbSource(f.boardFile);
    await expect(session.callTool("pcb_begin_commit")).rejects.toThrow(/qualified native route transactions are unavailable/iu);
    await expect(session.callTool("pcb_push_commit")).rejects.toThrow(/unavailable/iu);
    expect(await session.readActivePcbSource(f.boardFile)).toBe(f.source);
    expect(await callNames(f)).toEqual(["evleda_get_live_pcb_document", "evleda_get_live_pcb_document"]);
  });

  it("binds qualification to all three actual descriptors, including marker and schemas", async () => {
    // The pinned client retains standard annotations and _meta, but ignores
    // this upstream extension. Qualification hashes its actual decoded tool.
    const decoded = specTypeSchemas.Tool["~standard"].validate(contracts.after[0]);
    expect(decoded.issues).toBeUndefined();
    if (decoded.issues !== undefined) throw new Error("Captured native Tool was rejected by the pinned client schema.");
    expect(decoded.value.annotations).toEqual({ idempotentHint: false });
    for (const mutate of [
      (tool: Record<string, unknown>) => ({ ...tool, _meta: { evledaNativeCommitLifecycle: "other" } }),
      (tool: Record<string, unknown>) => ({ ...tool, inputSchema: { type: "object", properties: { commit: { type: "string" } } } }),
      (tool: Record<string, unknown>) => ({ ...tool, description: "different declared contract" }),
    ]) {
      const descriptors = contracts.after.map(tool => structuredClone(tool)) as Record<string, unknown>[];
      descriptors[0] = mutate(descriptors[0]!);
      const f = await fixture({ descriptors });
      await expect(connect(f)).rejects.toThrow(/mismatched qualified tool contract/iu);
      await expect(readFile(f.callsFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
    const incomplete = await fixture({ descriptors: contracts.after.slice(0, 2) }), session = await connect(incomplete);
    expect(session.supportsNativeRouteTransactions()).toBe(false);
    await expect(session.callTool("pcb_begin_commit")).rejects.toThrow(/unavailable/iu);
  });

  it("requires write authority and an exact private live document observation before begin", async () => {
    const f = await fixture(), session = await connect(f);
    expect(session.supportsNativeRouteTransactions()).toBe(true);
    await expect(session.callTool("pcb_begin_commit")).rejects.toThrow(/exact private live PCB observation/iu);
    await expect(readFile(f.callsFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const readonly = await connect(f, { mode: "readonly" });
    expect(readonly.supportsNativeRouteTransactions()).toBe(false);
    await expect(readonly.callTool("pcb_begin_commit")).rejects.toBeInstanceOf(KicadMcpAuthorizationError);
  });

  it("keeps a healthy pushed transaction armed through save/readback until host finish", async () => {
    const f = await fixture(), session = await connect(f);
    await begin(session, f);
    await expect(session.callTool("pcb_begin_commit")).rejects.toThrow(/awaiting host completion/iu);
    expect(() => session.finishNativeRouteTransaction()).toThrow(/clean push/iu);
    await session.callTool("pcb_add_track", track);
    await session.callTool("pcb_push_commit");
    expect(session.supportsNativeRouteTransactions()).toBe(true);
    await session.callTool("pcb_save");
    await session.readActivePcbSource(f.boardFile);
    session.finishNativeRouteTransaction();
    expect(session.supportsNativeRouteTransactions()).toBe(true);
    await session.callTool("pcb_move_footprint", {});
    expect((await callNames(f)).filter(name => name === "pcb_begin_commit")).toHaveLength(1);
  });

  it("accepts real sanitized session lifecycle replies in the caller's qualified ACK helper", async () => {
    const assertAck = (result: CallToolResult, expected: string) => {
      // These are actual callTool outputs after SDK validation and session
      // sanitization, not hand-built imitations of its returned envelope.
      expect(result.content).toEqual([{ type: "text", text: '{"schemaVersion":"evleda.kicad-mcp-result.v1","category":"validated_structured_evidence"}' }]);
      expect(result.structuredContent).toEqual({ result: expected });
      expect(hasQualifiedNativeBoardReply(result, expected)).toBe(true);
    };
    const pushed = await fixture(), pushedSession = await connect(pushed);
    await pushedSession.readActivePcbSource(pushed.boardFile);
    assertAck(await pushedSession.callTool("pcb_begin_commit"), "Transaction group started. Use pcb_push_commit to apply or pcb_drop_commit to discard.");
    assertAck(await pushedSession.callTool("pcb_push_commit"), "Transaction group committed successfully.");
    assertAck(await pushedSession.callTool("pcb_save"), "Board saved.");
    await pushedSession.readActivePcbSource(pushed.boardFile);
    pushedSession.finishNativeRouteTransaction();

    const dropped = await fixture(), droppedSession = await connect(dropped);
    await begin(droppedSession, dropped);
    assertAck(await droppedSession.callTool("pcb_drop_commit"), "Transaction group discarded successfully.");
    assertAck(await droppedSession.callTool("pcb_revert"), "Board reverted to last saved state. All unsaved changes have been discarded.");
    expect((await callNames(pushed)).filter(name => name !== "evleda_get_live_pcb_document")).toEqual(["pcb_begin_commit", "pcb_push_commit", "pcb_save"]);
    expect((await callNames(dropped)).filter(name => name !== "evleda_get_live_pcb_document")).toEqual(["pcb_begin_commit", "pcb_drop_commit", "pcb_revert"]);
  });

  it.each(["tool", "rpc", "malformed", "hang"])("retains checked recovery after a normal %s failure instead of closing", async failure => {
    const f = await fixture({ failures: { pcb_add_track: failure } }), session = await connect(f, { timeoutMs: 500 });
    await begin(session, f);
    const error = await session.callTool("pcb_add_track", track).then(() => undefined, caught => caught as unknown);
    expect(error).toBeInstanceOf(KicadNativeRouteRecoveryRequiredError);
    expect(error).toMatchObject({ operation: "pcb_add_track", mayHaveMutated: true, writesQuarantined: true });
    expect((error as Error).cause).toBeDefined();
    if (failure === "tool") {
      const cause = (error as Error).cause as Error & { cause: { response: { content: { text: string }[] } } };
      expect(cause.cause.response.content[0]!.text).toBe("original native tool failure detail");
      expect((error as Error).message).not.toContain("original native tool failure detail");
    }
    expect(session.supportsNativeRouteTransactions()).toBe(false);
    await expect(session.callTool("pcb_save")).rejects.toThrow(/quarantined/iu);
    await expect(session.callTool("pcb_add_track", track)).rejects.toThrow(/quarantined/iu);
    expect(await session.readActivePcbSource(f.boardFile)).toBe(f.source);
    await session.callTool("pcb_drop_commit");
    await session.callTool("pcb_revert");
    expect(() => session.finishNativeRouteTransaction()).toThrow();
    await expect(session.callTool("pcb_save")).rejects.toThrow(/quarantined/iu);
    expect((await callNames(f)).filter(name => name !== "evleda_get_live_pcb_document")).toEqual(["pcb_begin_commit", "pcb_add_track", "pcb_drop_commit", "pcb_revert"]);
    await session.close();
    await expect(session.readActivePcbSource(f.boardFile)).rejects.toThrow(/closed/iu);
  });

  it.each(["hang", "ambiguous"])("arms before begin dispatch and retains recovery on unknown %s acknowledgement", async failure => {
    const f = await fixture({ failures: { pcb_begin_commit: failure } }), session = await connect(f, { timeoutMs: 500 });
    await session.readActivePcbSource(f.boardFile);
    await expect(session.callTool("pcb_begin_commit")).rejects.toMatchObject({ name: "KicadNativeRouteRecoveryRequiredError", operation: "pcb_begin_commit" });
    await expect(session.callTool("pcb_add_track", track)).rejects.toThrow(/quarantined/iu);
    await expect(session.callTool("pcb_drop_commit")).rejects.toThrow(/not positively acknowledged/iu);
    expect(await session.readActivePcbSource(f.boardFile)).toBe(f.source);
    await session.callTool("pcb_revert");
    expect((await callNames(f)).filter(name => name !== "evleda_get_live_pcb_document")).toEqual(["pcb_begin_commit", "pcb_revert"]);
  });

  it("retains the recovery scope for post-push native source-read failure", async () => {
    const f = await fixture({ sourceFailureAfterPush: true }), session = await connect(f);
    await begin(session, f);
    await session.callTool("pcb_add_track", track);
    await session.callTool("pcb_push_commit");
    const error = await session.readActivePcbSource(f.boardFile).then(() => undefined, caught => caught as unknown);
    expect(error).toMatchObject({ name: "KicadNativeRouteRecoveryRequiredError", operation: "evleda_get_live_pcb_document" });
    const native = ((error as Error).cause as Error & { cause: { native: { response: { content: { text: string }[] } } } }).cause.native;
    expect(native.response.content[0]!.text).toBe("post-write native read failure");
    await expect(session.callTool("pcb_save")).rejects.toThrow(/quarantined/iu);
    await session.callTool("pcb_revert");
    expect(() => session.finishNativeRouteTransaction()).toThrow();
  });

  it("quarantines host-detected geometry faults without losing the checked recovery handle", async () => {
    const f = await fixture(), session = await connect(f);
    session.quarantineNativeRouteTransaction(new Error("prebegin host rejection"));
    expect(session.supportsNativeRouteTransactions()).toBe(true);
    await begin(session, f);
    await session.callTool("pcb_push_commit");
    session.quarantineNativeRouteTransaction(new Error("host geometry mismatch"));
    await expect(session.callTool("pcb_save")).rejects.toThrow(/quarantined/iu);
    await session.callTool("pcb_revert");
    expect(session.supportsNativeRouteTransactions()).toBe(false);
  });

  it("refuses drop and revert when the active document no longer matches the transaction", async () => {
    const f = await fixture({ failures: { pcb_add_track: "tool" }, switchDocumentOnFailure: true }), session = await connect(f);
    await begin(session, f);
    await expect(session.callTool("pcb_add_track", track)).rejects.toBeInstanceOf(KicadNativeRouteRecoveryRequiredError);
    await expect(session.callTool("pcb_drop_commit")).rejects.toBeInstanceOf(KicadNativeRouteRecoveryRequiredError);
    await expect(session.callTool("pcb_revert")).rejects.toBeInstanceOf(KicadNativeRouteRecoveryRequiredError);
    await session.callTool("pcb_get_board_summary");
    const names = await callNames(f);
    expect(names).not.toContain("pcb_drop_commit"); expect(names).not.toContain("pcb_revert");
    expect(names).toContain("pcb_get_board_summary");
  });

  it("restores ordinary failure-close behavior after a clean host finish", async () => {
    const f = await fixture({ failures: { pcb_get_board_summary: "tool" } }), session = await connect(f);
    await begin(session, f);
    await session.callTool("pcb_push_commit");
    await session.callTool("pcb_save");
    await session.readActivePcbSource(f.boardFile);
    session.finishNativeRouteTransaction();
    await expect(session.callTool("pcb_get_board_summary")).rejects.toThrow(/categorical tool-failure/iu);
    await expect(session.readActivePcbSource(f.boardFile)).rejects.toThrow(/closed/iu);
  });
});
