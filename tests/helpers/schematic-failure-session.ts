import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { KicadMcpSession, createKicadMcpExpectedExecutableIdentity } from "../../src/integrations/kicad-mcp-session.js";

export const schematicFailureReply = Object.freeze({
  isError: true,
  content: [{ type: "text", text: "Unsupported graphical item 'arc': six USB symbol arcs. api_key=synthetic-private-test-token C:/private/fixture" }],
});

const SERVER = String.raw`
const fs=require('node:fs');
const f=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const rl=require('node:readline').createInterface({input:process.stdin,crlfDelay:Infinity});
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const text=value=>({content:[{type:'text',text:value}],structuredContent:{result:value},isError:false});
let mutationFailed=false;
rl.on('line',line=>{
  const m=JSON.parse(line);
  if(m.method==='initialize')return send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'kicad-mcp-pro',version:'1.29.1'}}});
  if(m.method==='tools/list')return send({jsonrpc:'2.0',id:m.id,result:{tools:f.tools}});
  if(m.method!=='tools/call')return;
  const name=m.params.name;
  fs.appendFileSync(f.callsPath,JSON.stringify(m.params)+'\n');
  if(name===f.replyToolName){
    mutationFailed=true;
    if(f.failure==='hang')return;
    if(f.failure==='rpc')return send({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:'private RPC failure'}});
    if(f.failure==='transport')return process.exit(0);
    if(f.failure==='malformed')return send({jsonrpc:'2.0',id:m.id,result:{isError:'invalid',content:[]}});
    if(f.failure==='protocol-negative'){process.stdout.write('{}\n');return setTimeout(()=>send({jsonrpc:'2.0',id:m.id,result:f.reply}),20);}
    return send({jsonrpc:'2.0',id:m.id,result:f.reply});
  }
  if(name==='sch_get_symbols'&&mutationFailed&&f.readToolFailure)return send({jsonrpc:'2.0',id:m.id,result:f.reply});
  if(name==='evleda_get_live_pcb_document'){
    if(mutationFailed&&f.liveFailure==='transport')return process.exit(0);
    const d={schemaVersion:'evleda.kicad-live-pcb-document.v1',documentType:'pcb',projectPath:f.project,
      boardFilename:mutationFailed&&f.liveFailure==='document'?'other.kicad_pcb':pathBasename(f.boardFile),boardSource:f.source};
    return send({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:JSON.stringify(d)}],structuredContent:d,isError:false}});
  }
  return send({jsonrpc:'2.0',id:m.id,result:text('checked fixture read')});
});
function pathBasename(file){return require('node:path').basename(file);}
`;

/** Starts only an owned synthetic Node MCP peer; never launches or contacts KiCad. */
export async function createSchematicFailureSession(input: {
  workspace: string; project: string; boardFile: string;
  failure?: "tool" | "rpc" | "transport" | "malformed" | "hang" | "protocol-negative";
  liveFailure?: "document" | "transport";
  readToolFailure?: boolean;
  reply?: unknown;
  replyToolName?: "sch_autoplace_fields" | "sch_add_symbol";
}) {
  const outputRoot = path.join(input.workspace, "session-output");
  await mkdir(outputRoot, { recursive: true });
  const file = path.join(outputRoot, "schematic-failure-peer.json"), callsPath = `${file}.calls`;
  const names = ["sch_autoplace_fields", "sch_get_symbols", "pcb_get_board_summary", "pcb_save", "pcb_revert", ...(input.replyToolName === "sch_add_symbol" ? ["sch_add_symbol"] : [])];
  const tools = names.map(name => ({ name, inputSchema: { type: "object", additionalProperties: true },
    outputSchema: { type: "object", properties: { result: { type: "string" } }, required: ["result"], additionalProperties: false } }));
  await writeFile(file, JSON.stringify({ project: input.project, boardFile: input.boardFile, source: await readFile(input.boardFile, "utf8"),
    failure: input.failure ?? "tool", readToolFailure: input.readToolFailure ?? false, liveFailure: input.liveFailure ?? null, reply: input.reply ?? schematicFailureReply, replyToolName: input.replyToolName ?? "sch_autoplace_fields", callsPath,
    tools: [...tools, { name: "evleda_get_live_pcb_document", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
  }), "utf8");
  const session = await KicadMcpSession.connect({ workspaceRoot: input.workspace, projectRoot: input.project, outputRoot,
    mode: "write", freshProject: true, environment: process.env, timeoutMs: 500, maxMessageBytes: 32_768,
    command: { command: process.execPath, args: ["-e", "eval(Buffer.from(process.argv[1], 'base64').toString('utf8'))", Buffer.from(SERVER).toString("base64"), file] },
    expectedLauncherIdentity: await createKicadMcpExpectedExecutableIdentity(process.execPath),
  });
  return { session, calls: async () => (await readFile(callsPath, "utf8")).trim().split("\n")
    .map(line => (JSON.parse(line) as { name: string }).name) };
}
