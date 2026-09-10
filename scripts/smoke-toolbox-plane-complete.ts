/** Public V2 fixture driver. Optional acceptance qualification uses a new output directory. */
import assert from "node:assert/strict";
import { Client, InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { copyFile, mkdir, readFile, writeFile, readdir, lstat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { canonicalJson, contentIdentity } from "../src/core/canonical.js";
import { createNativeToolbox, parseNativeToolboxArgs, formatNativeToolboxError } from "../src/mcp/toolbox-native-main.js";
import { parseFreshPcbSource, parseFreshPcbReferenceGeometry, parseFreshPcbDirectZoneSourceSpans } from "../src/harness/fresh-kicad-parser.js";
import { freshBoardSerializationsEqual } from "../src/harness/fresh-board-serialization.js";
import type { PcbPlaneDesignContract } from "../src/harness/pcb-design-plane-contract.js";

// Post-proof diagnostic correction: plane results distinguish physical copper from logical terminals.
// These pure assertions are replay-tested offline against retained public MCP payloads; no native rerun implied.
function assertPlanePhysicalLogicalCounts(counts: Record<string, any>): void {
  assert.equal(counts.physicalPadCount, 7);
  assert.equal(counts.logicalTerminalCount, 7);
  assert.equal(counts.numberedCopperPrimitiveCount, 7);
  assert.equal(counts.namedCopperPrimitiveCount, 7);
  assert.equal(counts.logicalNamedTerminalCount, 7);
  assert.equal(counts.noConnectCopperPrimitiveCount, 0);
  assert.equal(counts.logicalNoConnectTerminalCount, 0);
  assert.equal(counts.nonElectricalFeatureCount, 0);
  assert.equal(counts.platedFootprintHoleCount, 3);
}
function assertPlaneSyncResult(sync: Record<string, any>): void {
  assert.equal(sync.schemaVersion, "evleda.fresh-plane-sync-from-schematic-result.v1");
  assert.equal(sync.applied, true);
  assert.equal(sync.componentCount, 3);
  assertPlanePhysicalLogicalCounts(sync);
  assert.equal(sync.unresolvedMappingCount, 0);
}
function assertPlanePadPositionsResult(pads: Record<string, any>): void {
  assert.equal(pads.schemaVersion, "evleda.fresh-plane-pad-positions.v1");
  assertPlanePhysicalLogicalCounts(pads.boardCounts);
  assert.equal(pads.status, "complete-selection", "This seven-pad fixture must return the complete physical selection.");
  assert.equal(pads.pads.length, 7);
  assert.deepEqual(pads.terminals.map((terminal: any) => `${terminal.reference}:${terminal.pad}:${terminal.net}`).sort(),
    ["J1:1:VIN", "J1:2:VOUT", "J1:3:GND", "R1:1:VIN", "R1:2:VOUT", "R2:1:VOUT", "R2:2:GND"].sort());
}

/** Pure fixture checks; coordinates for routing come from these actual native pad rows. */
function planeFixtureRoutes(pads: Record<string, any>) {
  assertPlanePadPositionsResult(pads);
  const expected = [["J1","1","VIN",3,7],["J1","2","VOUT",3,9.54],["J1","3","GND",3,12.08],
    ["R1","1","VIN",10,7],["R1","2","VOUT",10,8.65],["R2","1","VOUT",17.175,9.475],["R2","2","GND",18.825,9.475]] as const;
  for (const [reference,pad,net,x,y] of expected) {
    const rows = pads.pads.filter((p: any) => p.reference === reference && p.pad === pad && p.net === net);
    assert.equal(rows.length, 1); assert.ok(Math.abs(rows[0].xMm-x)<1e-6 && Math.abs(rows[0].yMm-y)<1e-6 && rows[0].layers.includes("F.Cu"), `Unexpected physical orientation at ${reference}.${pad}`);
  }
  const get=(reference:string,pad:string)=>pads.pads.find((p:any)=>p.reference===reference&&p.pad===pad);
  const vinStart=get("J1","1"),vinEnd=get("R1","1"),ground=get("R2","2");
  assert.equal(vinStart.yMm,vinEnd.yMm);
  const groundTracks=[{x1Mm:ground.xMm,y1Mm:ground.yMm,x2Mm:ground.xMm+1,y2Mm:ground.yMm,layer:"F.Cu"},
    {x1Mm:ground.xMm+1,y1Mm:ground.yMm,x2Mm:ground.xMm+2,y2Mm:ground.yMm+1,layer:"F.Cu"}];
  assertGround45Turn(groundTracks);
  return [{net:"VIN",tracks:[{x1Mm:vinStart.xMm,y1Mm:vinStart.yMm,x2Mm:vinEnd.xMm,y2Mm:vinEnd.yMm,layer:"F.Cu"}],vias:[]},
    {net:"GND",tracks:groundTracks,vias:[{xMm:ground.xMm+2,yMm:ground.yMm+1}]}];
}
function assertGround45Turn(tracks:readonly {x1Mm:number;y1Mm:number;x2Mm:number;y2Mm:number;layer:string}[]) {
  assert.equal(tracks.length,2);assert.ok(tracks.every(t=>t.layer==="F.Cu"));
  const points=tracks.map(t=>[[t.x1Mm,t.y1Mm],[t.x2Mm,t.y2Mm]]);
  const equal=(a:number[],b:number[])=>Math.hypot(a[0]!-b[0]!,a[1]!-b[1]!)<1e-6;
  const joints=points[0]!.filter(a=>points[1]!.some(b=>equal(a,b)));assert.equal(joints.length,1,"Exactly one degree-two GND junction required");
  const joint=joints[0]!,ends=points.map(pair=>pair.find(p=>!equal(p,joint))!);
  const vectors=ends.map(p=>[p[0]!-joint[0]!,p[1]!-joint[1]!]);
  const lengths=vectors.map(v=>Math.hypot(...v));assert.ok(lengths.every(length=>length>=0.2));assert.ok(lengths[0]!+lengths[1]!<10);
  const cosine=(vectors[0]![0]!*vectors[1]![0]!+vectors[0]![1]!*vectors[1]![1]!)/(lengths[0]!*lengths[1]!);
  const turn=180-Math.acos(Math.max(-1,Math.min(1,cosine)))*180/Math.PI;
  assert.ok(Math.abs(turn-45)<1e-6,"Saved same-layer degree-two GND turn must be45degrees");
  return turn;
}
function completeVoutRoute(pads:Record<string,any>) {
  planeFixtureRoutes(pads); // Same exact physical orientation gate; no guessed pin positions.
  const get=(reference:string,pad:string)=>pads.pads.find((p:any)=>p.reference===reference&&p.pad===pad);
  const a=get("J1","2"),b=get("R1","2"),c=get("R2","1");
  assert.equal(a.net,"VOUT");assert.equal(b.net,"VOUT");assert.equal(c.net,"VOUT");
  const x=a.xMm+4,diagonal=Math.abs(a.yMm-b.yMm);
  assert.ok(diagonal>=0.2&&b.xMm-(x+diagonal)>=0.2&&c.xMm-b.xMm>=0.2);
  const finalDiagonal=c.yMm-b.yMm,approach=c.xMm-finalDiagonal;
  assert.ok(finalDiagonal>=0.2&&approach-b.xMm>=0.2);
  const points=[[a.xMm,a.yMm],[x,a.yMm],[x+diagonal,b.yMm],[b.xMm,b.yMm],[approach,b.yMm],[c.xMm,c.yMm]];
  return {net:"VOUT",tracks:points.slice(1).map((p,index)=>({x1Mm:points[index]![0],y1Mm:points[index]![1],x2Mm:p[0],y2Mm:p[1],layer:"F.Cu"})),vias:[]};
}
function assertEndpointAssessment(assessment:Record<string,any>, complete:boolean) {
  assert.equal(assessment.schemaVersion,"evleda.toolbox-endpoint-connectivity.v1");
  assert.equal(assessment.assessmentSchemaVersion,"evleda.fresh-plane-connectivity.v1");
  assert.equal(assessment.status,complete?"connected":"partially-connected");assert.equal(assessment.acceptanceEvaluated,false);
  if(assessment.verificationPlanRowsPassed!==undefined)assert.deepEqual(assessment.verificationPlanRowsPassed,[]);
  assert.deepEqual(assessment.nets.map((n:any)=>n.net).sort(),["GND","VIN","VOUT"]);
  for(const net of assessment.nets){
    const connected=complete||net.net!=="VOUT";
    assert.equal(net.status,connected?"connected":"disconnected");
    assert.equal(net.logicalEndpointReachability.status,connected?"reachable":"disconnected");
    if(connected)assert.equal(net.everyEligiblePhysicalMemberReachable,true);
  }
}
function assertEndpointWrapper(value:Record<string,any>,complete:boolean) {
  assert.equal(value.sourceUnchanged,true);assert.equal(typeof value.sourceBefore,"string");assert.ok(value.sourceBefore.length>0);assert.equal(value.sourceBefore,value.sourceAfter);
  assert.match(value.diagnostic.filename,/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/);
  assert.equal(value.diagnostic.identity.algorithm,"sha256");assert.match(value.diagnostic.identity.digest,/^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(value.diagnostic.identity.size)&&value.diagnostic.identity.size>0);
  assertEndpointAssessment(value.report,complete);
}
function assertProfileFreePractice(value:Record<string,any>) {
  assert.equal(value.sourceUnchanged,true);const report=value.report;
  assert.equal(report.schemaVersion,"evleda.toolbox-practices.v1");
  assert.deepEqual(report.turnPolicy.violations,[]);assert.deepEqual(report.turnPolicy.unresolvedFindings,[]);
  assert.equal(report.analysis,null);assert.equal(report.reviewedProfileIdentity,null);
  for(const field of ["reviewedProfileConstraints","widthAndNetClass","vias"])assert.equal(report.checks[field],"unverified-no-profile");
  assert.equal(report.checks.electricalSuitability,"unverified");assert.equal(report.checks.manufacturingReadiness,"unverified");
}
function assertNativeValidation(value:Record<string,any>) {
  assert.equal(value.sourceUnchanged,true);assert.ok(Array.isArray(value.checks));
  for(const name of ["run_erc","run_drc"] as const){
    const matches:Record<string,any>[]=value.checks.filter((check:any)=>check.name===name);assert.equal(matches.length,1);
    const result=matches[0]!.result;assert.ok(!result.isError);const data=JSON.parse(result.content);
    assert.equal(data.schema_version,"verdict.v1");assert.equal(data.verdict,"PASS");assert.equal(data.status,"clean");
    assert.equal(data.metadata.available,true);
    if(name==="run_erc")assert.equal(data.metadata.violation_count,0);
    else{assert.equal(data.metadata.violations,0);assert.equal(data.metadata.unconnected_items,0);assert.equal(data.metadata.courtyard_issues,0);}
  }
}
function assertPlaneApplyResult(value:Record<string,any>, operation:"create"|"update", previousUuid?:string) {
  assert.equal(value.schemaVersion,"evleda.fresh-plane-apply-result.v1"); assert.equal(value.operation,operation);
  assert.equal(value.applied,true);assert.equal(value.mutated,true);assert.equal(value.idempotent,false);
  assert.equal(value.nativeActionsPerformed,true);assert.equal(value.nativeSaveCalledByStage,false);assert.equal(value.acceptanceEvaluated,false);
  assert.match(value.targetZoneUuid,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  if(previousUuid!==undefined)assert.equal(value.targetZoneUuid,previousUuid);
  for(const key of ["completion","connection","referenceCoverage","thermalAcceptance","islandAreaAcceptance"])assert.equal(value[key],"not_evaluated");
  assert.deepEqual(value.issues,[]);assert.equal(value.requirements.minimumAreaEnforcement,"not-enforced-by-always-mode");
  assert.equal(value.requirements.spokeEnforcement,"external-owned-rule-and-native-evidence");
}
function withoutZones(source:string) {
  let result="",cursor=0;for(const span of parseFreshPcbDirectZoneSourceSpans(source)){result+=source.slice(cursor,span.start);cursor=span.end;}return result+source.slice(cursor);
}

const driverArguments=process.argv.slice(2),verifyPlaneAcceptance=driverArguments.includes("--verify-plane-acceptance");
const verifyQualifiedFootprints=driverArguments.includes("--verify-qualified-footprints");
assert.ok(driverArguments.filter(arg=>arg==="--verify-plane-acceptance").length<=1,"Duplicate driver qualification flag");
assert.ok(driverArguments.filter(arg=>arg==="--verify-qualified-footprints").length<=1,"Duplicate qualified-footprint flag");
assert.ok(!verifyQualifiedFootprints||verifyPlaneAcceptance,"Qualified-footprint qualification includes the plane checks");
const options = parseNativeToolboxArgs(driverArguments.filter(arg=>!["--verify-plane-acceptance","--verify-qualified-footprints"].includes(arg)));
if (options?.fresh?.intentPath === undefined || options.resume || !options.edit) throw new Error("Use one NEW plane intent with --edit, not resume input.");
const evidence = path.join(path.dirname(options.outputDir), verifyPlaneAcceptance?"evidence-plane-acceptance-01":"evidence-plane-complete-01");
await mkdir(evidence);
const expected = JSON.parse(await readFile(path.join(options.projectDir, "expected-plane-bundle.json"), "utf8"));
const fixtureName = options.fresh.name;
const project = path.join(options.outputDir, "project");
const bundlePath = path.join(options.outputDir, "toolbox-design-bundle.json");
const markerPath = path.join(options.outputDir, ".evleda-pcb-agent-fresh.json");
const checkpointPath = path.join(options.outputDir, ".evleda-pcb-agent-checkpoint.json");
const druPath = path.join(project, `${fixtureName}.kicad_dru`);
const driverProfile=JSON.parse(await readFile(options.profile.path,"utf8"));
const ipcRoot=driverProfile.kicadMcpRuntime.ipcSocketParentRoot as string;
assert.ok(typeof ipcRoot==="string"&&path.isAbsolute(ipcRoot),"Profile must declare the actual IPC inventory root");
const powershellPath=path.join(process.env.SYSTEMROOT??process.env.SystemRoot??"C:\\Windows","System32","WindowsPowerShell","v1.0","powershell.exe");
const execFileAsync = promisify(execFile);
const report: Record<string, any> = { schemaVersion: "evleda.toolbox-plane-complete-save-resume-smoke.v1", startedAt: new Date().toISOString(),
  hostPid: process.pid, commandArguments: process.argv.slice(2), scope: "Complete-all-nets V2 public-tool demonstration: routes, plane create/refill/save, observed endpoint connectivity, configured ERC/DRC/practices/previews and checkpoint/reopen. Not primary-project, manufacturing or HF approval.",
  noModel: true, planeCopperCreated: false, routingPerformed: false, minimumSpokesAcceptance: false, fullBoardFinishClaim: false,
  planeAcceptanceQualification:verifyPlaneAcceptance,qualifiedFootprintQualification:verifyQualifiedFootprints,operations: [], phases: [] };
if(verifyPlaneAcceptance)report.scope="Qualify the integrated V2 plane evidence tool after native fill/save, after edit invalidation, and after read-only restart. Reuses the divider as a software fixture; overall acceptance, physical width, HF and fabrication remain unverified.";
const json = async (file: string) => JSON.parse(await readFile(file, "utf8"));
const identity = async (file: string) => contentIdentity(await readFile(file));
async function record(name: string, value: unknown): Promise<void> { await writeFile(path.join(evidence, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" }); }
async function ipcInventory() { return Promise.all((await readdir(ipcRoot)).sort().map(async name => { const item = await lstat(path.join(ipcRoot, name)); return { name, birthtimeMs: item.birthtimeMs, mtimeMs: item.mtimeMs, directory: item.isDirectory() }; })); }
async function processes(label: string) {
  const { stdout } = await execFileAsync(powershellPath,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `$ownerProbe=${process.pid}; $allProbe=@(Get-CimInstance Win32_Process); $idsProbe=@($ownerProbe); do{$childrenProbe=@($allProbe | Where-Object {$_.ParentProcessId -in $idsProbe -and $_.ProcessId -notin $idsProbe});$idsProbe+=@($childrenProbe.ProcessId)}while($childrenProbe.Count); [ordered]@{ownerPid=$ownerProbe;processes=@($allProbe | Where-Object {$_.ProcessId -in $idsProbe -and $_.ProcessId -ne $PID} | Select-Object ProcessId,ParentProcessId,Name,CreationDate,ExecutablePath,CommandLine)} | ConvertTo-Json -Depth 5`],
    { windowsHide: true, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
  const result = JSON.parse(stdout); await record(`${label}-processes.json`, result); return result;
}
async function snapshot(label: string) {
  const target = path.join(evidence, label); await mkdir(target);
  const manifest: unknown[] = [];
  const pending = [options!.outputDir];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const source = path.join(directory, entry.name); assert.ok(!entry.isSymbolicLink(), "Do not copy aliased native evidence.");
      const relative = path.relative(options!.outputDir, source), destination = path.join(target, relative);
      if (entry.isDirectory()) { await mkdir(destination, { recursive: true }); pending.push(source); }
      else if (entry.isFile()) { const before = await identity(source); await mkdir(path.dirname(destination), { recursive: true }); await copyFile(source, destination); const copied = await identity(destination), after = await identity(source); assert.deepEqual(copied, before); assert.deepEqual(after, before); manifest.push({ relative, identity: before }); }
    }
  }
  await record(`${label}-manifest.json`, manifest); return { directory: target, files: manifest.length };
}
const parseResult = (result: CallToolResult): Record<string, any> => {
  const outer = result.structuredContent as Record<string, any> | undefined;
  if (typeof outer?.result?.content === "string") { try { return JSON.parse(outer.result.content); } catch { return { text: outer.result.content }; } }
  return outer ?? {};
};
let ordinal = 0, baselineDru: Awaited<ReturnType<typeof identity>> | undefined, savedBundle: Awaited<ReturnType<typeof identity>> | undefined;
let savedAuthoredSources: { name: string; identity: Awaited<ReturnType<typeof identity>> }[] | undefined;
let savedZoneUuid: string | undefined;
const sourceBefore = await identity(options.fresh.intentPath);
const profileBefore = await identity(options.profile.path);
const ipcBefore = await ipcInventory(); report.ipcBefore = ipcBefore; report.intentBefore = sourceBefore; report.profileBefore = profileBefore;
await record("launch-claimed.json", { at: new Date().toISOString(), hostPid: process.pid, output: options.outputDir, oneFreshPhaseAndOneSavedResumeOnly: true });

async function diskAuthority(label: string) {
  const marker = await json(markerPath), checkpoint = await json(checkpointPath), bundle = await json(bundlePath), dru = await identity(druPath);
  assert.equal(marker.schemaVersion, "evleda.pcb-agent-fresh-project.v3"); assert.equal(marker.workflowKind, "plane");
  assert.equal(marker.planeBinding.family, "plane-v2"); assert.equal(checkpoint.schemaVersion, "evleda.pcb-agent-fresh-project-checkpoint.v3");
  assert.equal(bundle.schemaVersion, "evleda.pcb-design-compilation-bundle.v2"); assert.equal(bundle.contract.schemaVersion, "evleda.pcb-design-contract.v2");
  assert.equal(canonicalJson(bundle), canonicalJson(expected));
  assert.equal(canonicalJson(marker.planeBinding.contractIdentity), canonicalJson(bundle.contract.identity));
  assert.equal(marker.files.dru.sha256, dru.digest); assert.deepEqual(marker.planeBinding.expectedRulesContentIdentity, dru);
  assert.equal(checkpoint.files.dru.sha256, dru.digest); assert.equal(canonicalJson(checkpoint.planeBindingIdentity), canonicalJson(marker.planeBinding.identity));
  if (baselineDru) assert.deepEqual(dru, baselineDru); else baselineDru = dru;
  const currentBundle = await identity(bundlePath); if (savedBundle) assert.deepEqual(currentBundle, savedBundle); else savedBundle = currentBundle;
  const value = { label, marker, checkpoint, bundleIdentity: bundle.identity, bundleFileIdentity: currentBundle, dru };
  await record(`${label}-authority.json`, value); return value;
}
async function phase(label: "fresh" | "resume") {
  let toolbox: Awaited<ReturnType<typeof createNativeToolbox>> | undefined;
  let client: Client | undefined;
  let finished = false;
  const outcome: Record<string, any> = { label, startedAt: new Date().toISOString() }; report.phases.push(outcome);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const id = ++ordinal, started = performance.now(); process.stdout.write(`${label}: ${name}\n`);
    try {
      const result = await client!.callTool({ name, arguments: args }, { timeout: 180_000 });
      const operation = { ordinal: id, phase: label, name, arguments: args, elapsedMs: performance.now() - started, result };
      report.operations.push(operation); await record(`operation-${String(id).padStart(3, "0")}.json`, operation);
      if (result.isError) throw new Error(`${name} returned public MCP isError; original result retained.`);
      return { parsed: parseResult(result), outer: result.structuredContent as Record<string, any>, raw: result };
    } catch (error) { await record(`operation-${String(id).padStart(3, "0")}-error.json`, { phase: label, name, elapsedMs: performance.now() - started, error: formatNativeToolboxError(error) }); throw error; }
  };
  try {
    const startup = performance.now(); process.stdout.write(`${label}: native startup\n`);
    const startupOptions = label === "fresh" ? options! : { ...options!, edit:false, resume: true, fresh: { name: fixtureName } };
    toolbox = await createNativeToolbox(startupOptions); outcome.startupMs = performance.now() - startup;
    client = new Client({ name: "evleda-plane-complete-smoke", version: "1.0.0" });
    const [clientWire, serverWire] = InMemoryTransport.createLinkedPair(); await toolbox.server.connect(serverWire); await client.connect(clientWire);
    const tools = (await client.listTools()).tools.map(tool => tool.name); outcome.tools = tools;
    for (const unavailable of ["pcb_add_track", "pcb_add_via", "pcb_add_zone", "pcb_add_text"]) assert.ok(!tools.includes(unavailable), `Plane copper/route tool unexpectedly advertised: ${unavailable}`);
    const requiredTools=label==="fresh"?["evleda_design_context", "fresh_apply_contract_connectivity", "fresh_autoplace_schematic_fields", "fresh_sync_from_schematic", "fresh_get_contract_pad_positions", "fresh_get_route_items", "fresh_replace_route_items", "fresh_apply_contract_plane", "pcb_set_board_outline", "pcb_move_footprint", "evleda_finish_session"]:["evleda_design_context","fresh_get_contract_pad_positions","fresh_get_route_items","evleda_finish_session"];
    requiredTools.push("evleda_check_endpoint_connectivity","evleda_validate_design","evleda_check_board_practices","evleda_render_board");
    for (const required of requiredTools) assert.ok(tools.includes(required), `Missing public plane authoring tool: ${required}`);
    outcome.startedProcesses = await processes(`${label}-opened`);
    outcome.status = (await call("evleda_toolbox_status")).parsed; assert.equal(outcome.status.recoveryRequired, false);
    const context = (await call("evleda_design_context")).parsed; outcome.context = context;
    assert.equal(context.family, "plane-v2"); assert.equal(context.acceptanceEvaluated, false);
    assert.equal(context.copperAuthoring.incrementalRoutes,label==="fresh");
    assert.equal(context.copperAuthoring.contractPlane,label==="fresh");
    assert.equal(context.resumedFromSavedBundle, label === "resume"); assert.equal(canonicalJson(context.contract), canonicalJson(expected.contract));
    assert.equal(canonicalJson(context.bundleIdentity), canonicalJson(expected.identity));
    const contract = context.contract as PcbPlaneDesignContract;
    const gnd = contract.nets.find(net => net.name === "GND"); assert.ok(gnd); assert.deepEqual(gnd.endpoints.map(endpoint => `${endpoint.reference}:${endpoint.pin}`).sort(), ["J1:3", "R2:2"]);
    assert.equal(contract.routingConstraints.nets.find(net => net.net === "GND")?.topology, "plane");
    outcome.openAuthority = await diskAuthority(`${label}-open`);
    if (label === "fresh") {
      await call("sch_get_symbols");
      const positions = { J1: [101.6,101.6], R1: [127,101.6], R2: [127,127] } as const;
      for (const component of contract.components) {
        assert.ok(component.reference in positions); const [library,symbol_name] = component.symbolLibId.split(":");
        const position = positions[component.reference as keyof typeof positions];
        await call("sch_add_symbol", { library, symbol_name, x_mm: position[0], y_mm: position[1], reference: component.reference, value: component.value, footprint: component.footprintLibId, rotation: 0, unit: 1, snap_to_grid: true });
        assert.deepEqual(await identity(druPath), baselineDru);
      }
      let connectivity = (await call("fresh_apply_contract_connectivity")).parsed;
      if (connectivity.applied === false && connectivity.recommendationIdentity !== undefined) {
        await call("fresh_apply_recommended_schematic_placement", { recommendationIdentity: connectivity.recommendationIdentity });
        connectivity = (await call("fresh_apply_contract_connectivity")).parsed;
      }
      assert.equal(connectivity.applied, true); outcome.connectivity = connectivity;
      outcome.fieldRepair = (await call("fresh_autoplace_schematic_fields")).parsed;
      assert.deepEqual(await identity(druPath), baselineDru);
      const sync = await call("fresh_sync_from_schematic"); outcome.sync = sync;
      assertPlaneSyncResult(sync.parsed);
      assert.equal(canonicalJson(sync.parsed.sourceContractIdentity), canonicalJson(contract.identity));
      assert.equal(canonicalJson(sync.parsed.planeProjectBindingIdentity), canonicalJson(outcome.openAuthority.marker.planeBinding.identity));
      assert.ok(sync.outer.persistence, "Actual public MCP mutation wrapper did not consume/save plane sync.");
      outcome.graph = (await call("sch_get_connectivity_graph")).parsed;
    }
    outcome.pads = (await call("fresh_get_contract_pad_positions")).parsed;
    assertPlanePadPositionsResult(outcome.pads);
    const pcbPath=path.join(project,`${fixtureName}.kicad_pcb`);
    if(label==="fresh") {
      assert.equal(contract.scope.board.widthMm,30);assert.equal(contract.scope.board.heightMm,20);
      const beforeLayout=parseFreshPcbSource(await readFile(pcbPath,"utf8"));
      assert.equal(beforeLayout.outlineBounds,null);assert.equal(beforeLayout.segments.length,0);assert.equal(beforeLayout.vias.length,0);
      assert.equal(parseFreshPcbReferenceGeometry(await readFile(pcbPath,"utf8")).zones.length,0);
      await call("pcb_set_board_outline",{width_mm:30,height_mm:20,origin_x_mm:0,origin_y_mm:0});
      for(const placement of [{reference:"J1",x_mm:3,y_mm:7,rotation_deg:0},{reference:"R1",x_mm:10,y_mm:7.825,rotation_deg:270},{reference:"R2",x_mm:18,y_mm:9.475,rotation_deg:0}])await call("pcb_move_footprint",placement);
      outcome.placedPads=(await call("fresh_get_contract_pad_positions")).parsed;
      const routes=planeFixtureRoutes(outcome.placedPads);
      for(const route of routes) {
        const selected=(await call("fresh_get_route_items")).parsed;
        assert.equal(selected.schemaVersion,"evleda.fresh-plane-route-selection.v1");
        const routed=await call("fresh_replace_route_items",{selectionIdentity:selected.identity,net:route.net,deleteItemIds:[],tracks:route.tracks,vias:route.vias});
        assert.equal(routed.parsed.schemaVersion,"evleda.fresh-plane-route-mutation-result.v1");assert.equal(routed.parsed.applied,true);
        assert.equal(routed.parsed.addedTrackCount,route.tracks.length);assert.equal(routed.parsed.addedViaCount,route.vias.length);assert.ok(routed.outer.persistence);
        assert.equal(routed.parsed.completion,"not_evaluated");assert.equal(routed.parsed.connection,"not_evaluated");
      }
      report.routingPerformed=true;report.unroutedNets=[];report.routeScope="VIN straight; R2 GND access with45degree bend and one via; VOUT completed after disconnected baseline";
      const beforePlane=await readFile(pcbPath,"utf8");
      const plane=contract.planes[0]!;assert.equal(plane.id,"GND_PLANE");assert.equal(plane.padConnection.mode,"thermal");
      const applied=await call("fresh_apply_contract_plane",{planeId:plane.id});
      assertPlaneApplyResult(applied.parsed,"create");assert.ok(applied.outer.persistence,"Public CREATE did not complete mandatory persistence");
      savedZoneUuid=applied.parsed.targetZoneUuid;outcome.planeCreate=applied;report.planeCopperCreated=true;
      const afterCreate=await readFile(pcbPath,"utf8");
      assert.ok(freshBoardSerializationsEqual(withoutZones(beforePlane),withoutZones(afterCreate)),"Plane creation changed nonzone source");
      outcome.endpointBeforeVout=(await call("evleda_check_endpoint_connectivity")).outer;
      assertEndpointWrapper(outcome.endpointBeforeVout,false);
      assert.equal(canonicalJson(await identity(path.join(options!.outputDir,".evleda-mcp-output",outcome.endpointBeforeVout.diagnostic.filename))),canonicalJson(outcome.endpointBeforeVout.diagnostic.identity));
      const voutConstraint=contract.routingConstraints.nets.find(net=>net.net==="VOUT")!;
      if(voutConstraint.topology==="plane")throw new Error("VOUT fixture must remain a trace-tree net");
      assert.equal(voutConstraint.routeLength.mode,"unbounded");assert.equal(voutConstraint.maxVias,0);
      const vout=completeVoutRoute(outcome.placedPads),selected=(await call("fresh_get_route_items")).parsed;
      const completed=await call("fresh_replace_route_items",{selectionIdentity:selected.identity,net:vout.net,deleteItemIds:[],tracks:vout.tracks,vias:vout.vias});
      assert.equal(completed.parsed.applied,true);assert.equal(completed.parsed.addedTrackCount,vout.tracks.length);assert.equal(completed.parsed.addedViaCount,0);assert.ok(completed.outer.persistence);
      if(verifyPlaneAcceptance){
        outcome.planeAcceptanceAfterEdit=(await call("evleda_check_plane_acceptance")).outer;
        assert.equal(outcome.planeAcceptanceAfterEdit.sourceUnchanged,true);
        assert.equal(outcome.planeAcceptanceAfterEdit.report.accepted,false);
        assert.equal(outcome.planeAcceptanceAfterEdit.report.savedEvidenceIdentity,null);
        assert.deepEqual(outcome.planeAcceptanceAfterEdit.report.verificationPlanRowsPassed,[]);
      }
      const beforeReapply=await readFile(pcbPath,"utf8");
      const updated=await call("fresh_apply_contract_plane",{planeId:plane.id});
      assertPlaneApplyResult(updated.parsed,"update",savedZoneUuid);assert.ok(updated.outer.persistence,"Same-plane UPDATE must still complete mandatory save");
      const afterUpdate=await readFile(pcbPath,"utf8");
      assert.ok(freshBoardSerializationsEqual(withoutZones(beforeReapply),withoutZones(afterUpdate)),"Plane update changed nonzone source");
      outcome.planeUpdate=updated;outcome.samePlaneUpdate={before:contentIdentity(beforeReapply),after:contentIdentity(afterUpdate),bytesActuallyIdentical:beforeReapply===afterUpdate};
      await record("plane-save-readback.json",outcome.samePlaneUpdate);
    }
    const savedPcbSource=await readFile(pcbPath,"utf8"),savedPcb=parseFreshPcbSource(savedPcbSource),geometry=parseFreshPcbReferenceGeometry(savedPcbSource);
    assert.equal(savedPcb.outlineSupported,true);assert.deepEqual(savedPcb.outlineBounds,{minX:0,minY:0,maxX:30,maxY:20});
    assert.equal(savedPcb.segments.length,8);assert.equal(savedPcb.vias.length,1);
    if(verifyQualifiedFootprints)assert.ok(savedPcb.footprints.every(fp=>contract.components.some(component=>component.reference===fp.reference&&component.footprintLibId===fp.libraryId)),"Native saved footprint identities must include the exact library nickname");
    assert.deepEqual(savedPcb.segments.map(segment=>segment.netName).sort(),["GND","GND","VIN","VOUT","VOUT","VOUT","VOUT","VOUT"]);
    const actualGround=savedPcb.segments.filter(segment=>segment.netName==="GND").map(segment=>({x1Mm:segment.start.x,y1Mm:segment.start.y,x2Mm:segment.end.x,y2Mm:segment.end.y,layer:segment.layer}));
    outcome.savedGroundTurnDeg=assertGround45Turn(actualGround);
    const layoutPads=label==="fresh"?outcome.placedPads:outcome.pads;
    const expectedRoutes=[...planeFixtureRoutes(layoutPads),completeVoutRoute(layoutPads)];
    const round=(v:number)=>Math.round(v*1e6)/1e6;
    const trackKey=(net:string,t:{x1Mm:number;y1Mm:number;x2Mm:number;y2Mm:number;layer:string})=>JSON.stringify({net,layer:t.layer,ends:[[round(t.x1Mm),round(t.y1Mm)],[round(t.x2Mm),round(t.y2Mm)]].sort()});
    assert.deepEqual(savedPcb.segments.map(s=>trackKey(s.netName!,{x1Mm:s.start.x,y1Mm:s.start.y,x2Mm:s.end.x,y2Mm:s.end.y,layer:s.layer})).sort(),expectedRoutes.flatMap(route=>route.tracks.map(t=>trackKey(route.net,t))).sort());
    assert.ok(savedPcb.segments.every(s=>s.widthMm===(s.netName==="VOUT"?0.25:0.5)));
    const via=savedPcb.vias[0]!,expectedVia=expectedRoutes[1]!.vias[0]!;
    assert.equal(via.netName,"GND");assert.equal(round(via.at.x),round(expectedVia.xMm));assert.equal(round(via.at.y),round(expectedVia.yMm));assert.equal(via.diameterMm,0.6);assert.equal(via.drillMm,0.3);
    assert.equal(geometry.zones.length,1);const zone=geometry.zones[0]!;
    assert.equal(zone.uuid,savedZoneUuid);assert.equal(zone.netName,"GND");assert.deepEqual(zone.layers,["B.Cu"]);assert.equal(zone.filledCachePresent,true);
    assert.equal(zone.status,"supported");outcome.savedPlaneReadback={identity:contentIdentity(savedPcbSource),zone};
    outcome.savedRoutes=(await call("fresh_get_route_items")).parsed;
    assert.equal(outcome.savedRoutes.items.length,9);
    outcome.endpointConnected=(await call("evleda_check_endpoint_connectivity")).outer;
    assertEndpointWrapper(outcome.endpointConnected,true);
    assert.equal(canonicalJson(await identity(path.join(options!.outputDir,".evleda-mcp-output",outcome.endpointConnected.diagnostic.filename))),canonicalJson(outcome.endpointConnected.diagnostic.identity));
    if(verifyPlaneAcceptance){
      outcome.planeAcceptance=(await call("evleda_check_plane_acceptance")).outer;
      const assessment=outcome.planeAcceptance.report;
      assert.equal(outcome.planeAcceptance.sourceUnchanged,true);assert.equal(assessment.accepted,false);assert.equal(assessment.fabricationAuthorized,false);
      assert.equal(canonicalJson(await identity(path.join(options!.outputDir,".evleda-mcp-output",outcome.planeAcceptance.diagnostic.filename))),canonicalJson(outcome.planeAcceptance.diagnostic.identity));
      if(label==="fresh"){
        assert.ok(assessment.savedEvidenceIdentity);
        assert.equal(assessment.authority.status,"verified");
        assert.equal(assessment.planes.length,1);
        assert.equal(assessment.planes[0].intendedPlaneConnectivity.status,"verified");
        assert.equal(assessment.planes[0].minimumArea.status,"verified");
        assert.equal(assessment.planes[0].actualMinimumCopperWidth.status,"unknown");
        assert.equal(assessment.planes[0].actualThermalWidth.status,"unknown");
        if(verifyQualifiedFootprints){
          assert.deepEqual(assessment.nativeChecks.drc.schematicParity,[]);
          assert.deepEqual(assessment.nativeChecks.drc.violations,[]);
          assert.deepEqual(assessment.nativeChecks.drc.unconnectedItems,[]);
          assert.equal(assessment.planes[0].thermalPolicy.status,"verified");
          assert.equal(assessment.planes[0].drillTopology.status,"verified");
        }
        assert.ok(assessment.mandatoryRowsRemaining.length>0);
      }else{
        assert.equal(assessment.savedEvidenceIdentity,null);
        assert.deepEqual(assessment.verificationPlanRowsPassed,[]);
      }
    }
    assert.deepEqual(await identity(druPath),baselineDru);
    outcome.rules = (await call("pcb_get_design_rules")).parsed;
    outcome.previews=[];
    for(const view of ["top","assembly"] as const){
      const rendered=await call("evleda_render_board",{view}),metadata=rendered.outer;
      const images=rendered.raw.content.filter(item=>item.type==="image"),resources=rendered.raw.content.filter(item=>item.type==="resource_link");
      const image=images[0],resource=resources[0];
      assert.equal(images.length,1);assert.equal(resources.length,1);assert.ok(image?.type==="image"&&resource?.type==="resource_link");
      assert.equal(image.mimeType,"image/png");const png=Buffer.from(image.data,"base64");
      assert.equal(png.subarray(0,8).toString("hex"),"89504e470d0a1a0a");assert.equal(png.subarray(12,16).toString("ascii"),"IHDR");
      assert.equal(canonicalJson(contentIdentity(png)),canonicalJson(metadata.png.identity));
      assert.equal(png.readUInt32BE(16),metadata.png.width);assert.equal(png.readUInt32BE(20),metadata.png.height);
      assert.equal(metadata.png.sourceSvgSha256,metadata.pcbSvg.sha256);assert.equal(metadata.resourceUri,resource.uri);
      assert.equal(metadata.sourceUnchanged,true);assert.equal(metadata.sourceBefore,metadata.sourceAfter);
      const svg=await client!.readResource({uri:resource.uri}),content=svg.contents[0];
      assert.equal(svg.contents.length,1);assert.ok(content&&"text"in content);assert.equal(content.mimeType,"image/svg+xml");
      const svgIdentity=contentIdentity(content.text);assert.equal(svgIdentity.digest,metadata.pcbSvg.sha256);assert.equal(svgIdentity.size,metadata.pcbSvg.sizeBytes);
      assert.equal(resource.uri,`evleda://pcb-preview/${svgIdentity.digest}/${view}`);
      const pngFile=path.join(evidence,`${label}-${view}.png`),svgFile=path.join(evidence,`${label}-${view}.svg`);
      await writeFile(pngFile,png,{flag:"wx"});await writeFile(svgFile,content.text,{flag:"wx"});
      outcome.previews.push({view,pngFile,svgFile,pngIdentity:contentIdentity(png),svgIdentity});
    }
    outcome.practices=(await call("evleda_check_board_practices")).outer;
    assertProfileFreePractice(outcome.practices);
    outcome.routeDimensionReadback={scope:"Literal saved contract-derived geometry, not reviewed-profile or ampacity verification",
      tracks:savedPcb.segments.map(segment=>({net:segment.netName,widthMm:segment.widthMm,layer:segment.layer})),
      vias:savedPcb.vias.map(via=>({net:via.netName,diameterMm:via.diameterMm,drillMm:via.drillMm,layers:via.layers})),
      reviewedProfileConstraints:"unverified-no-profile",electricalSuitability:"unverified"};
    outcome.validation=(await call("evleda_validate_design")).outer;
    assertNativeValidation(outcome.validation);
    assert.deepEqual(await identity(druPath), baselineDru); assert.deepEqual(await identity(bundlePath), savedBundle);
    outcome.beforeFinish = await snapshot(`${label}-before-finish`);
    outcome.finish = (await call("evleda_finish_session")).parsed;
    assert.equal(outcome.finish.nativeSessionClosed, true); assert.equal(outcome.finish.checkpointPublished, true); assert.equal(outcome.finish.recoveryRequired, false);
    finished = true;
    outcome.closedStatus = (await call("evleda_toolbox_status")).parsed; assert.equal(outcome.closedStatus.cadState, "closed"); assert.equal(outcome.closedStatus.cadConnected, false);
    await toolbox.close(); await client.close(); client = undefined; toolbox = undefined;
    outcome.closedAuthority = await diskAuthority(`${label}-closed`);
    const authoredSources = await Promise.all([`${fixtureName}.kicad_pcb`,`${fixtureName}.kicad_sch`,`${fixtureName}.kicad_pro`,`${fixtureName}.kicad_dru`,"sym-lib-table","fp-lib-table"].map(async name => ({ name, identity: await identity(path.join(project,name)) })));
    if (savedAuthoredSources) assert.deepEqual(authoredSources, savedAuthoredSources, "Read-only saved-bundle resume changed authored source bytes.");
    else savedAuthoredSources = authoredSources;
    outcome.authoredSourceIdentities = authoredSources;
    const afterProcesses = await processes(`${label}-closed`); outcome.afterProcesses = afterProcesses;
    assert.equal(afterProcesses.processes.filter((entry: any) => /^(pcbnew|python|pythonw)\.exe$/i.test(entry.Name)).length, 0, "Owned editor/native Python remains after finish.");
    assert.equal((await readdir(project)).filter(name => name.endsWith(".lck")).length, 0, "Owned project locks remain.");
    assert.deepEqual(await ipcInventory(), ipcBefore, "Owned IPC was not released or an old IPC directory changed.");
    outcome.passed = true; outcome.finishedAt = new Date().toISOString();
  } catch (error) {
    outcome.error = formatNativeToolboxError(error); process.stdout.write(`${label}: ERROR ${outcome.error}\n`); process.exitCode = 1;
    if (client) { try { outcome.failureStatus = (await call("evleda_toolbox_status")).parsed; } catch (statusError) { outcome.failureStatusError = formatNativeToolboxError(statusError); } }
    try { outcome.failureSnapshot = await snapshot(`${label}-failure-preserved`); } catch (snapshotError) { outcome.snapshotError = formatNativeToolboxError(snapshotError); }
  } finally {
    if (toolbox && !finished) {
      // Only the owning API drains/settles and gracefully closes; no force kill, source rewrite or IPC deletion.
      try { if (client) { outcome.failureFinish = (await call("evleda_finish_session")).parsed; } else await toolbox.finishCad(); }
      catch (error) { outcome.cleanupError = formatNativeToolboxError(error); process.exitCode = 1; }
    }
    try { await toolbox?.close(); } catch (error) { outcome.closeError = formatNativeToolboxError(error); process.exitCode = 1; }
    await client?.close().catch(error => { outcome.protocolCloseError = formatNativeToolboxError(error); process.exitCode = 1; });
    await record(`${label}-phase.json`, outcome);
  }
  return outcome.passed === true;
}
try {
  const fresh = await phase("fresh");
  if (fresh) { report.betweenPhases = await snapshot("saved-before-resume"); report.resumePassed = await phase("resume"); }
  else report.resumeNotStarted = "Fresh phase failed; no retry/resume permitted.";
} catch (error) { report.error = formatNativeToolboxError(error); process.exitCode = 1; }
finally {
  report.intentAfter = await identity(options.fresh.intentPath); report.profileAfter = await identity(options.profile.path);
  report.sourceUnchanged = canonicalJson(report.intentAfter) === canonicalJson(sourceBefore); report.profileUnchanged = canonicalJson(report.profileAfter) === canonicalJson(profileBefore);
  report.ipcAfter = await ipcInventory(); report.ipcUnchanged = canonicalJson(report.ipcAfter) === canonicalJson(ipcBefore);
  report.finalProcesses = await processes("final");
  report.passed = report.phases.length === 2 && report.phases.every((entry: any) => entry.passed === true) && report.sourceUnchanged && report.profileUnchanged && report.ipcUnchanged;
  if (!report.passed) process.exitCode = 1;
  report.finishedAt = new Date().toISOString(); await record("result.json", report);
  process.stdout.write(`${JSON.stringify({ passed: report.passed, sourceUnchanged: report.sourceUnchanged, profileUnchanged: report.profileUnchanged, ipcUnchanged: report.ipcUnchanged, report: path.join(evidence,"result.json"), scope: report.scope, noFullBoardOrAcceptanceClaim: true })}\n`);
}
