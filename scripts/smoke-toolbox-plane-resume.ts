/** Continue only the saved-candidate read/finish segment of the preserved plane smoke. */
import assert from "node:assert/strict";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { readFile, writeFile, readdir, lstat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { canonicalJson, contentIdentity } from "../src/core/canonical.js";
import { createNativeToolbox, parseNativeToolboxArgs, formatNativeToolboxError } from "../src/mcp/toolbox-native-main.js";

const options=parseNativeToolboxArgs(process.argv.slice(2));
if(!options?.resume||!options.fresh||options.edit||options.fresh.intentPath!==undefined||options.fresh.originalPrompt!==undefined)throw new Error("Resume-only smoke requires --resume, same --new-project, no intent/prompt/edit.");
const base=path.dirname(options.outputDir),evidence=path.join(base,"evidence-02"),project=path.join(options.outputDir,"project"),name=options.fresh.name;
const execFileAsync=promisify(execFile);
const identity=async(file:string)=>contentIdentity(await readFile(file));
const json=async(file:string)=>JSON.parse(await readFile(file,"utf8"));
const record=async(name:string,value:unknown)=>writeFile(path.join(evidence,name),JSON.stringify(value,null,2)+"\n",{flag:"wx"});
const sourceNames=[`${name}.kicad_pcb`,`${name}.kicad_sch`,`${name}.kicad_pro`,`${name}.kicad_dru`,"sym-lib-table","fp-lib-table"];
const sourceSnapshot=async()=>Promise.all(sourceNames.map(async name=>({name,identity:await identity(path.join(project,name))})));
const ipcSnapshot=async()=>Promise.all((await readdir("D:/EvlEDA-IPC")).sort().map(async name=>{const m=await lstat(path.join("D:/EvlEDA-IPC",name));return{name,birthtimeMs:m.birthtimeMs,mtimeMs:m.mtimeMs};}));
const bundlePath=path.join(options.outputDir,"toolbox-design-bundle.json"),checkpointPath=path.join(options.outputDir,".evleda-pcb-agent-checkpoint.json"),markerPath=path.join(options.outputDir,".evleda-pcb-agent-fresh.json");
const before={sources:await sourceSnapshot(),bundle:await identity(bundlePath),marker:await identity(markerPath),checkpoint:await identity(checkpointPath),profile:await identity(options.profile.path),ipc:await ipcSnapshot()};
assert.equal(before.bundle.digest,"59594989153b3db3c354d3563ec42fde01952f1afdce0064bd110e7c574fc6b8");
assert.equal(before.checkpoint.digest,"60c200dc5798afc811ab43c35aa8c2ebdf420dadee18fb37bdb93816465d5696");
assert.equal(before.sources.find(s=>s.name.endsWith(".kicad_dru"))!.identity.digest,"36e5706d97e81782f770b2ee183ccb36c02bd461bd32cc6d603548f0fe3fe1b1");
assert.equal((await identity(path.resolve("src/mcp/toolbox-plane-preparation.ts"))).digest,"7d36c7a0f441a6b3915b5fd227884c3231a091170d54f139ba688dea07e333f1");
assert.equal((await identity(path.resolve("dist/src/mcp/toolbox-plane-preparation.js"))).digest,"72ac77a5ecc804fe4b61666ce78a644f60bca7853607dd6bd8b8b6ee287a31d1");
const expectedBundle=await json(bundlePath),report:Record<string,any>={schemaVersion:"evleda.toolbox-plane-resume-only-smoke.v1",startedAt:new Date().toISOString(),hostPid:process.pid,before,operations:[],freshAuthoringRepeated:false,scope:"Same saved V2 candidate resume, physical pad/rule/context reads and finish only; no plane copper/route/minimum-spokes/full acceptance."};
await record("launch-claimed.json",{hostPid:process.pid,at:new Date().toISOString(),arguments:process.argv.slice(2),resumeOnly:true});
let toolbox:Awaited<ReturnType<typeof createNativeToolbox>>|undefined,client:Client|undefined,finished=false,ordinal=0;
const call=async(tool:string,args:Record<string,unknown>={})=>{
  const started=performance.now(),id=++ordinal;process.stdout.write(`resume: ${tool}\n`);
  const result=await client!.callTool({name:tool,arguments:args},{timeout:180_000});const op={id,name:tool,arguments:args,elapsedMs:performance.now()-started,result};report.operations.push(op);await record(`operation-${String(id).padStart(3,"0")}.json`,op);
  if(result.isError)throw new Error(`${tool} returned isError; retained original result.`);
  const outer=result.structuredContent as Record<string,any>;return typeof outer?.result?.content==="string"?JSON.parse(outer.result.content):outer;
};
async function processes(label:string){const {stdout}=await execFileAsync("C:/Users/pc/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe",["-NoLogo","-NoProfile","-NonInteractive","-File",path.join(base,"evidence-01/observe-owned-processes.ps1"),"-OwnerPid",String(process.pid)],{windowsHide:true,timeout:15000,maxBuffer:2*1024*1024});const value=JSON.parse(stdout);await record(`${label}-processes.json`,value);return value;}
try{
  process.stdout.write("resume: native startup from saved V2 bundle\n");const started=performance.now();toolbox=await createNativeToolbox(options);report.startupMs=performance.now()-started;
  client=new Client({name:"evleda-plane-resume-smoke",version:"1.0.0"});const [cw,sw]=InMemoryTransport.createLinkedPair();await toolbox.server.connect(sw);await client.connect(cw);
  report.openedProcesses=await processes("opened");report.status=await call("evleda_toolbox_status");assert.equal(report.status.access,"read-only");assert.equal(report.status.recoveryRequired,false);
  const tools=(await client.listTools()).tools.map(t=>t.name);report.tools=tools;for(const unavailable of ["pcb_add_track","pcb_add_via","pcb_add_zone","fresh_replace_route_items","fresh_apply_contract_plane"])assert.ok(!tools.includes(unavailable));
  report.context=await call("evleda_design_context");assert.equal(report.context.family,"plane-v2");assert.equal(report.context.resumedFromSavedBundle,true);assert.equal(report.context.intentSourceKind,"saved-bundle");assert.deepEqual(report.context.copperAuthoring,{incrementalRoutes:false,contractPlane:false});assert.equal(report.context.acceptanceEvaluated,false);assert.equal(canonicalJson(report.context.contract),canonicalJson(expectedBundle.contract));assert.equal(canonicalJson(report.context.bundleIdentity),canonicalJson(expectedBundle.identity));
  report.pads=await call("fresh_get_contract_pad_positions");assert.equal(report.pads.schemaVersion,"evleda.fresh-plane-pad-positions.v1");assert.equal(report.pads.boardCounts.physicalPadCount,7);assert.equal(report.pads.boardCounts.logicalTerminalCount,7);
  const selections: Record<string, any>[] = report.pads.status==="complete-selection"?[report.pads]:[]; // Further reads stay sequential on the native owner.
  if(report.pads.status!=="complete-selection"){assert.equal(report.pads.status,"selection-required");for(const reference of ["J1","R1","R2"])selections.push(await call("fresh_get_contract_pad_positions",{reference}));}
  report.padSelections=selections;const terminals=selections.flatMap((selection:any)=>{assert.equal(selection.status,"complete-selection");return selection.terminals;});
  assert.deepEqual(terminals.map((t:any)=>`${t.reference}:${t.pad}:${t.net}`).sort(),["J1:1:VIN","J1:2:VOUT","J1:3:GND","R1:1:VIN","R1:2:VOUT","R2:1:VOUT","R2:2:GND"].sort());
  report.rules=await call("pcb_get_design_rules");assert.deepEqual(await sourceSnapshot(),before.sources);assert.deepEqual(await identity(bundlePath),before.bundle);
  report.finish=await call("evleda_finish_session");assert.equal(report.finish.nativeSessionClosed,true);assert.equal(report.finish.checkpointPublished,true);assert.equal(report.finish.recoveryRequired,false);finished=true;
  report.closedStatus=await call("evleda_toolbox_status");assert.equal(report.closedStatus.cadState,"closed");assert.equal(report.closedStatus.cadConnected,false);
  await toolbox.close();await client.close();toolbox=undefined;client=undefined;
  report.after={sources:await sourceSnapshot(),bundle:await identity(bundlePath),marker:await identity(markerPath),checkpoint:await identity(checkpointPath),profile:await identity(options.profile.path),ipc:await ipcSnapshot()};
  assert.deepEqual(report.after.sources,before.sources);assert.deepEqual(report.after.bundle,before.bundle);assert.deepEqual(report.after.marker,before.marker);assert.deepEqual(report.after.profile,before.profile);assert.deepEqual(report.after.ipc,before.ipc);
  const checkpoint=await json(checkpointPath);assert.equal(checkpoint.schemaVersion,"evleda.pcb-agent-fresh-project-checkpoint.v3");assert.equal(checkpoint.files.dru.sha256,before.sources.find(s=>s.name.endsWith(".kicad_dru"))!.identity.digest);report.checkpoint=checkpoint;
  assert.equal((await readdir(project)).filter(n=>n.endsWith(".lck")).length,0);report.finalProcesses=await processes("closed");assert.equal(report.finalProcesses.processes.filter((p:any)=>/^(pcbnew|python|pythonw)\.exe$/i.test(p.Name)).length,0);report.passed=true;
}catch(error){report.error=formatNativeToolboxError(error);process.stdout.write(`resume: ERROR ${report.error}\n`);process.exitCode=1;}
finally{
  if(toolbox&&!finished){try{report.failureFinish=client?await call("evleda_finish_session"):await toolbox.finishCad();}catch(error){report.cleanupError=formatNativeToolboxError(error);process.exitCode=1;}}
  try{await toolbox?.close();}catch(error){report.closeError=formatNativeToolboxError(error);process.exitCode=1;}await client?.close().catch(error=>{report.clientCloseError=formatNativeToolboxError(error);process.exitCode=1;});
  report.finishedAt=new Date().toISOString();await record("result.json",report);process.stdout.write(JSON.stringify({passed:report.passed===true,report:path.join(evidence,"result.json"),noFreshRerun:true,error:report.error,cleanupError:report.cleanupError})+"\n");
}
