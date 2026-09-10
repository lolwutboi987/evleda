import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { createKiCad10StockLibraryResolver } from "../../src/harness/kicad-library-resolver.js";
import { parseFreshPcbSource } from "../../src/harness/fresh-kicad-parser.js";
import { compilePcbDesignIntentDraft, type PcbReadOnlyLibraryResolver } from "../../src/harness/pcb-design-compiler.js";
import { createPcbDesignCompilationBundle, createPcbDesignCompilationBundleRef } from "../../src/harness/pcb-design-compilation-bundle.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { genericDividerDraft } from "../helpers/generic-divider-bundle.js";
import { nativePadObservationFixture, withNativePadFixtureIds } from "../helpers/native-pad-observation-fixture.js";
import { prepareFreshProject } from "../../src/harness/fresh-project.js";
import { createKicadHarnessTools, KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES, type KicadHarnessSession, type KicadHarnessToolsOptions } from "../../src/harness/kicad-tools.js";
import { compoundMutationState, runPcbAgentHarness } from "../../src/harness/pcb-agent-harness.js";
import { createFreshConnectivityContract } from "../../src/harness/fresh-connectivity-contract.js";
import type { HarnessProviderTurn, HarnessToolPort, HarnessToolResult } from "../../src/harness/contracts.js";

// These tests replay real stock footprint geometry through an offline native
// transport. They do not run KiCad, design an MCU circuit, or claim native proof.
const roots = new Set<string>();
afterEach(async()=>{for(const root of roots){await rm(root,{recursive:true,force:true});roots.delete(root);}});
const catalog=loadDeepRuleCatalog();
const header='(kicad_pcb (version 20260206) (generator "pcbnew") (generator_version "10.0") (general (thickness 1.6)) (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user)) (gr_rect (start 0 0) (end 80 50) (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts"))';
const empty=header+'\n)\n';
const addItem=(source:string,item:string)=>source.slice(0,source.lastIndexOf(')'))+item+'\n)\n';
const routeId="99999999-9999-4999-8999-999999999999";

function bundleFor(source:string){
  const parsed=parseFreshPcbSource(source),base=genericDividerDraft();
  const components=parsed.footprints.map(fp=>({reference:fp.reference,symbolLibId:`Fixture:Terminals_${fp.reference}`,value:fp.value,footprintLibId:fp.libraryId,unit:1,
    pins:[...new Set(fp.pads.map(p=>p.number).filter(Boolean))].map(pin=>({pin,assignment:fp.pads.find(p=>p.number===pin)!.netName===null?{kind:"no_connect" as const}:{kind:"net" as const,net:fp.pads.find(p=>p.number===pin)!.netName!}}))}));
  const endpoints=components.flatMap(c=>c.pins.flatMap(p=>p.assignment.kind==="net"?[{reference:c.reference,pin:p.pin}]:[]));
  const draft={...base,scope:{...base.scope,board:{...base.scope.board,widthMm:80,heightMm:50}},components,
    nets:[{...base.nets[0]!,name:"LINK",role:"passive",netClassId:"SIGNAL",endpoints}],
    netClasses:[{id:"SIGNAL",traceWidthMm:0.25,clearanceMm:0.2,copperToEdgeMm:0.5,allowedLayers:["F.Cu"]}],
    placementConstraints:components.map(c=>({reference:c.reference,side:"front",regionMm:{minXmm:1,maxXmm:79,minYmm:1,maxYmm:49},allowedRotationsDeg:[0],minimumEdgeClearanceMm:1,minimumCourtyardClearanceMm:0.25,edgePreference:"none"})),
    routingConstraints:{...base.routingConstraints,nets:[{net:"LINK",topology:endpoints.length===2?"point_to_point":"tree",preferredLayer:"F.Cu",maxVias:0,routeLength:{mode:"unbounded"}}]}};
  const resolver:PcbReadOnlyLibraryResolver={
    resolveSymbol:libraryId=>{const c=components.find(c=>c.symbolLibId===libraryId);return c?{libraryId,source:"kicad-stock",unitCount:1,componentKind:"generic",polarized:false,pins:c.pins.map(p=>({number:p.pin,function:`Terminal ${p.pin}`}))}:null;},
    resolveFootprint:libraryId=>{const c=components.find(c=>c.footprintLibId===libraryId);return c?{libraryId,source:"kicad-stock",packageKind:"generic",pads:c.pins.map(p=>p.pin)}:null;},
  };
  const dependencies={libraryResolver:resolver,deepRuleCatalog:catalog};
  const compilation=compilePcbDesignIntentDraft(draft,dependencies);
  if(compilation.disposition!=="ready")throw new Error(JSON.stringify(compilation.issues));
  const bundle=createPcbDesignCompilationBundle({originalPrompt:"Offline complete physical footprint transfer fixture; not an MCU circuit.",compilation},dependencies);
  return {bundle,reference:createPcbDesignCompilationBundleRef(bundle)};
}

function schematicFor(bundle:ReturnType<typeof bundleFor>["bundle"]):string{
  return `(kicad_sch (version 20250316) (generator "fixture") (global_label "LINK" (shape passive) (at 10 10 0)) ${bundle.contract.components.map(c=>`(symbol (lib_id "${c.symbolLibId}") (at 20 20 0) (property "Reference" "${c.reference}") (property "Value" "${c.value}") (property "Footprint" "${c.footprintLibId}"))`).join(' ')} ${bundle.contract.components.flatMap(c=>c.pins.filter(p=>p.assignment.kind==="no_connect").map((_,i)=>`(no_connect (at ${40+i} 30))`)).join(' ')})`;
}
function netlistFor(bundle:ReturnType<typeof bundleFor>["bundle"]):string{
  const nodes=bundle.contract.components.flatMap(c=>c.pins.flatMap(p=>p.assignment.kind==="net"?[`(node (ref "${c.reference}") (pin "${p.pin}") (pintype "passive"))`]:[]));
  const nc=bundle.contract.components.flatMap(c=>c.pins.flatMap(p=>p.assignment.kind==="no_connect"?[`(net (code "nc-${c.reference}-${p.pin}") (name "unconnected-(${c.reference}-Pin_${p.pin}-Pad${p.pin})") (node (ref "${c.reference}") (pin "${p.pin}") (pintype "passive+no_connect")))`]:[]));
  return `(export (design (source "fixture.kicad_sch") (date "2026-09-09T10:00:00")) (components ${bundle.contract.components.map(c=>`(comp (ref "${c.reference}") (value "${c.value}") (footprint "${c.footprintLibId}") (libsource (lib "Fixture") (part "Terminals_${c.reference}")))`).join(' ')}) (nets (net (code "1") (name "LINK") ${nodes.join(' ')} ) ${nc.join(' ')}))`;
}
function upstream(source:string):string{
  const board=parseFreshPcbSource(source),pads=board.footprints.flatMap(fp=>fp.pads.filter(p=>p.number)),named=pads.filter(p=>p.netName!==null).length;
  const unresolved=board.footprints.flatMap(fp=>{const p=fp.pads.filter(p=>p.number),nc=p.filter(p=>p.netName===null).length;return nc?[`${fp.reference} (${nc}/${p.length} pad(s) without net names)`]:[];});
  const coverage=Number((100*named/pads.length).toFixed(1)),quality=named===pads.length?"CLEAN":coverage>=50?"DEGRADED":"POOR";
  return [`Schematic components considered: ${board.footprints.length}`,`New footprints added: ${board.footprints.length}`,"Mismatched footprints replaced: 0",`Total pads considered: ${pads.length}`,`Pads with named nets: ${named}`,`Pads left as <no net>: ${pads.length-named}`,`Transfer quality: ${quality} (${coverage.toFixed(1)}% pad coverage)`,`Fully net-mapped refs: ${board.footprints.length-unresolved.length}`,`Partially net-mapped refs: ${unresolved.length}`,`Refs with unresolved pad nets: ${unresolved.join(', ')||'(none)'}`,"The PCB file was updated and KiCad was asked to reload it."].join('\n');
}

async function qfnSource(count:60|80,nc=true){
  const stem=count===60?'QFN-60-1EP_7x7mm_P0.4mm_EP3.4x3.4mm':'QFN-80-1EP_10x10mm_P0.4mm_EP3.4x3.4mm';
  const libraryRoot=fileURLToPath(new URL('../fixtures/fresh-pcb-pads',import.meta.url));
  const ids=[`Package_DFN_QFN:${stem}`,`Package_DFN_QFN:${stem}_ThermalVias`];
  const physicalResolver=createKiCad10StockLibraryResolver({symbolRoot:libraryRoot,footprintRoot:libraryRoot,exactSymbolIds:[],exactFootprintIds:ids,stockSymbolNicknames:[],stockFootprintNicknames:['Package_DFN_QFN']});
  const blocks=ids.map((libraryId,i)=>{
    const leaf=libraryId.split(':')[1]!;
    return readFileSync(path.join(libraryRoot,'Package_DFN_QFN.pretty',leaf+'.kicad_mod'),'utf8')
      // Library-file header metadata is not copied into a saved board instance;
      // all physical pad forms below remain the exact stock definitions.
      .replace(/^\t\((?:version|generator|generator_version)\b[^\r\n]*\)\r?\n/gmu,'')
      .replace(`(footprint "${leaf}"`,`(footprint "${libraryId}"`).replace('(layer "F.Cu")',`(layer "F.Cu") (at ${15+i*25} 20 0)`)
      .replace('(property "Reference" "REF**"',`(property "Reference" "${i===0?'S':'T'}${count}"`).replace(`(property "Value" "${leaf}"`,'(property "Value" "PAD_FIXTURE"');
  });
  let source=withNativePadFixtureIds(header+'\n'+blocks.join('\n')+'\n)');
  for(const fp of parseFreshPcbSource(source).footprints)for(const pad of fp.pads){
    if(pad.number&&!(nc&&fp.reference===`T${count}`&&pad.number===String(count+1)))source=source.replace(pad.physical.source,pad.physical.source.slice(0,-1)+' (net "LINK"))');
  }
  const sourcePins=ids.map((libraryId,i)=>({reference:`${i===0?'S':'T'}${count}`,libraryId,sourceIdentity:physicalResolver.inspectFootprint(libraryId)!.sourceIdentity}));
  return {source,physicalResolver,sourcePins};
}
function routeSource():string{
  const fp=(ref:string,x:number,extra:string)=>`(footprint "Fixture:${ref}" (layer "F.Cu") (at ${x} 10 0) (property "Reference" "${ref}") (property "Value" "TEST") (pad "1" smd rect (at 0 0) (size 2 2) (layers "F.Cu") (net "LINK")) (pad "2" smd rect (at 0 2) (size 1 1) (layers "F.Cu")) ${extra})`;
  return withNativePadFixtureIds(header+fp('A1',5,'')+fp('B1',15,'(pad "1" thru_hole circle (at -0.5 0) (size 0.5 0.5) (drill 0.2) (layers "*.Cu") (net "LINK")) (pad "" smd rect (at 0 0) (size 0.7 0.7) (layers "F.Paste"))')+`\n(segment (start 5 10) (end 15 9) (width 0.25) (layer "F.Cu") (net "LINK") (uuid "${routeId}"))\n)\n`);
}
interface Options {initial?:string;legacy?:boolean;nativeFailureOnSave?:boolean;nativeDisconnectedOnSave?:boolean;nativeParityFailureOnSave?:boolean;driftDuringRead?:boolean;badMetrics?:boolean;saveChangesPad?:boolean;corruptSyncNet?:boolean;pcbDriftDuringParity?:boolean;}
async function fixture(source:string,options:Options={},physical?:Awaited<ReturnType<typeof qfnSource>>){
  const generic=bundleFor(source),root=await mkdtemp(path.join(os.tmpdir(),'evleda-physical-authoring-'));roots.add(root);
  const project=await prepareFreshProject({outputDir:path.join(root,'output'),name:'physical',resume:false,workflowKind:'generic',compilationBundle:generic.bundle,compilationBundleRef:generic.reference});
  let live=options.initial??empty,transaction=live,saveCount=0,nativeReads=0,netlistReads=0,trackOrdinal=0;
  await writeFile(project.pcbPath,live,'utf8');await writeFile(project.schematicPath,schematicFor(generic.bundle),'utf8');
  const fakeBaseline=await nativePadObservationFixture(source);
  const calls:string[]=[];
  const session:KicadHarnessSession={
    supportsNativeRouteTransactions:()=>true,
    listTools:()=>KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES.filter(name=>!name.startsWith('evleda_get_live')).map(name=>({name,permission:'write' as const,inputSchema:{type:'object',additionalProperties:true}})),
    assertActivePcb:async expected=>{if(expected!==project.pcbPath)throw new Error('wrong active path');},
    readActivePcbSource:async()=>live,
    readLivePcbPadSnapshot:async ids=>{
      nativeReads++;calls.push('private-pad-read');
      const generated=await nativePadObservationFixture(live,source);
      const payload=structuredClone(generated.observation.rawSnapshot) as Record<string,any>;
      const document={type:'DOCTYPE_PCB',board_filename:path.basename(project.pcbPath),project:{name:project.name,path:path.dirname(project.pcbPath)}};
      payload.documentBefore=document;payload.documentAfter=document;payload.enabledLayers.request.board=document;payload.footprintInventory.request.header.document=document;payload.padstackPresence.request.board=document;
      const byId=new Map<string,any>(payload.connectivity.map((query:any)=>[query.sourcePrimitiveId,query]));
      payload.connectivity=ids.map(id=>{const query=structuredClone(byId.get(id));if(!query)throw new Error('unrequested fixture pad');query.request.header.document=document;
        if(saveCount>0&&options.nativeDisconnectedOnSave)query.padRecordIndexes=query.padRecordIndexes.filter((index:number)=>payload.padRecords[index].id.value===id);return query;});
      if(saveCount>0&&options.nativeFailureOnSave)payload.boardSourceAfter+='\n';
      if(options.driftDuringRead)await writeFile(project.pcbPath,live+'\n','utf8');
      return {isError:false,structuredContent:payload,content:[{type:'text',text:JSON.stringify(payload)}]};
    },
    callTool:async(name,args={})=>{
      calls.push(name);let result='ok';
      if(name==='pcb_sync_from_schematic'){live=options.corruptSyncNet?source.replace('(net "LINK")','(net "BAD")'):source;await writeFile(project.pcbPath,live,'utf8');result=upstream(source);if(options.badMetrics)result=result.replace(/Total pads considered: \d+/u,'Total pads considered: 1');}
      if(name==='pcb_begin_commit'){transaction=live;result='Transaction group started. Use pcb_push_commit to apply or pcb_drop_commit to discard.';}
      if(name==='pcb_drop_commit'){live=transaction;result='Transaction group discarded successfully.';}
      if(name==='pcb_push_commit')result='Transaction group committed successfully.';
      if(name==='pcb_delete_items'){const ids=args.item_ids as string[];live=live.split(/(?<=\n)/u).filter(line=>!ids.some(id=>line.includes(`(uuid "${id}")`))).join('');result='Route items deleted.';}
      if(name==='pcb_add_track'){const id=`66666666-6666-4666-8666-${String(++trackOrdinal).padStart(12,'0')}`;live=addItem(live,`(segment (start ${args.x1_mm} ${args.y1_mm}) (end ${args.x2_mm} ${args.y2_mm}) (width ${args.width_mm}) (layer "${String(args.layer).replace('_','.')}") (net "${args.net_name}") (uuid "${id}"))`);result='Track added.';}
      if(name==='pcb_save'){saveCount++;if(options.saveChangesPad)live=live.replace('(size 2 2)','(size 2.1 2)');await writeFile(project.pcbPath,live,'utf8');result='Board saved.';}
      if(name==='pcb_revert'){live=await readFile(project.pcbPath,'utf8');result='Board reverted.';}
      return {content:[],structuredContent:{result}};
    },
  };
  const toolOptions:KicadHarnessToolsOptions={freshProject:project,freshConnectivityContract:generic.bundle.contract,freshCompilationBundle:generic.bundle,
    capturePersistedMutationBaseline:async()=>contentIdentity(await readFile(project.pcbPath)).digest,verifyPersistedMutation:async baseline=>baseline!==contentIdentity(await readFile(project.pcbPath)).digest,
    captureFreshNativeNetlist:async()=>{netlistReads++;if(saveCount>0&&options.pcbDriftDuringParity)await writeFile(project.pcbPath,live+'\n','utf8');const value=netlistFor(generic.bundle);return saveCount>0&&options.nativeParityFailureOnSave?value.replace('(name "LINK")','(name "WRONG")'):value;},
    ...(options.legacy?{}:{freshPhysicalFootprintResolver:physical?.physicalResolver??fakeBaseline.expected.physicalFootprintResolver!,freshPhysicalFootprintSourcePins:physical?.sourcePins??fakeBaseline.expected.physicalFootprints!})};
  const bridge=createKicadHarnessTools(session,toolOptions);
  return {...generic,project,bridge,calls,live:()=>live,nativeReads:()=>nativeReads,netlistReads:()=>netlistReads,
    replaceOwnedSource:async(next:string)=>{live=next;await writeFile(project.pcbPath,next,'utf8');}};
}
const syncCall={id:'sync',name:'fresh_sync_from_schematic' as const,arguments:{}};
const saveCall={id:'save',name:'pcb_save' as const,arguments:{}};

describe('qualified physical PCB authoring and mandatory save',()=>{
  it.each([60,80] as const)('syncs both real QFN%d footprints with all paste/thermal records and weighted NC metrics',async count=>{
    const qfn=await qfnSource(count),current=await fixture(qfn.source,{},qfn);
    const result=JSON.parse((await current.bridge.execute(syncCall)).content);
    expect(result.schemaVersion).toBe('evleda.fresh-sync-from-schematic-result.v2');
    expect(result.logicalTerminalCount).toBe(2*(count+1));
    expect(result.numberedCopperPrimitiveCount).toBe(2*(count+1)+10);
    expect(result.physicalPadCount).toBe(count===60?145:206);
    expect(result.nonElectricalFeatureCount).toBe(count===60?13:34);
    expect(result.platedFootprintHoleCount).toBe(9);
    expect(result.logicalNoConnectTerminalCount).toBe(1);expect(result.noConnectCopperPrimitiveCount).toBe(11);
    expect(result.upstreamMetrics.transferQuality).toBe('DEGRADED');
    expect(result.upstreamMetrics.noNetPads).toBe(11);expect(result).not.toHaveProperty('padCount');
    const reads=current.nativeReads();expect((await current.bridge.internal.saveAfterMutation(saveCall)).isError).not.toBe(true);
    expect(current.nativeReads()).toBe(reads+1);expect(current.netlistReads()).toBe(3);
    expect(parseFreshPcbSource(await readFile(current.project.pcbPath,'utf8')).footprints.flatMap(fp=>fp.pads)).toHaveLength(result.physicalPadCount);
  });
  it('keeps legacy DEGRADED rejection and exact rollback unchanged',async()=>{
    const current=await fixture(routeSource(),{legacy:true});
    await expect(current.bridge.execute(syncCall)).rejects.toThrow(/refusal|no-change/);
    expect(await readFile(current.project.pcbPath,'utf8')).toBe(empty);
  });
  it('rejects contradictory upstream metrics despite valid native/source geometry',async()=>{
    const current=await fixture(routeSource(),{badMetrics:true});
    await expect(current.bridge.execute(syncCall)).rejects.toThrow(/metrics contradict/);
    expect(await readFile(current.project.pcbPath,'utf8')).toBe(empty);
  });
  it('does not let correct metrics override a wrong actual physical member net',async()=>{
    const current=await fixture(routeSource(),{corruptSyncNet:true});
    await expect(current.bridge.execute(syncCall)).rejects.toThrow(/wrong net/);
    expect(await readFile(current.project.pcbPath,'utf8')).toBe(empty);
  });
  it.each(['nativeFailureOnSave','nativeParityFailureOnSave','saveChangesPad','pcbDriftDuringParity'] as const)('does not complete sync save when %s',async failure=>{
    const current=await fixture(routeSource(),{[failure]:true});await current.bridge.execute(syncCall);
    expect((await current.bridge.internal.saveAfterMutation(saveCall)).isError).toBe(true);
    expect(await readFile(current.project.pcbPath,'utf8')).toBe(empty);
  });
  it('rejects source drift during private inventory capture before accepting sync',async()=>{
    const current=await fixture(routeSource(),{driftDuringRead:true});
    await expect(current.bridge.execute(syncCall)).rejects.toThrow(/source\/marker changed/);
  });
  it.each([false,true])('requires fresh native route reachability after save; disconnected=%s',async disconnected=>{
    const source=routeSource(),current=await fixture(source,{initial:source,nativeDisconnectedOnSave:disconnected});
    const selection=JSON.parse((await current.bridge.execute({id:'read',name:'fresh_get_route_items',arguments:{}})).content);
    const change=await current.bridge.execute({id:'route',name:'fresh_replace_route_items',arguments:{selectionIdentity:selection.identity,net:'LINK',deleteItemIds:[routeId],tracks:[{x1Mm:5,y1Mm:10,x2Mm:15,y2Mm:10,layer:'F.Cu'}],vias:[]}});
    expect(change.isError).not.toBe(true);const reads=current.nativeReads();
    const saved=await current.bridge.internal.saveAfterMutation(saveCall);expect(current.nativeReads()).toBeGreaterThan(reads);
    expect(saved.isError===true).toBe(disconnected);
    if(disconnected)expect(await readFile(current.project.pcbPath,'utf8')).toBe(source);
  });
  it('rejects a stale route selection before any PCB mutation',async()=>{
    const source=routeSource(),current=await fixture(source,{initial:source});
    const selection=JSON.parse((await current.bridge.execute({id:'read',name:'fresh_get_route_items',arguments:{}})).content);
    await current.replaceOwnedSource(addItem(source,'(segment (start 1 1) (end 2 2) (width 0.25) (layer "F.Cu") (net "LINK") (uuid "aaaaaaaa-0000-4000-8000-000000000001"))'));
    await expect(current.bridge.execute({id:'stale',name:'fresh_replace_route_items',arguments:{selectionIdentity:selection.identity,net:'LINK',deleteItemIds:[routeId],tracks:[{x1Mm:5,y1Mm:10,x2Mm:15,y2Mm:10,layer:'F.Cu'}],vias:[]}})).rejects.toThrow(/changed after bounded read/);
    expect(current.calls).not.toContain('pcb_begin_commit');
  });
  it('validates the complete QFN inventory before bounded candidate selection',async()=>{
    const qfn=await qfnSource(80,false),current=await fixture(qfn.source,{initial:qfn.source},qfn);
    const whole=JSON.parse((await current.bridge.execute({id:'all',name:'fresh_get_contract_pad_positions',arguments:{}})).content);
    expect(whole.boardCounts.physicalPadCount).toBe(206);
    expect(whole.status).toBe('selection-required');expect(whole).not.toHaveProperty('pads');
    const selected=JSON.parse((await current.bridge.execute({id:'ep',name:'fresh_get_contract_pad_positions',arguments:{reference:'T80',pad:'81'}})).content);
    expect(selected.status).toBe('complete-selection');expect(selected.pads).toHaveLength(11);
    expect(new Set(selected.pads.map((pad:any)=>pad.physical.id)).size).toBe(11);
    expect(selected.boardCounts.physicalPadCount).toBe(206);expect(selected.pcbContentIdentity).toEqual(whole.pcbContentIdentity);
    expect(selected.pads.filter((pad:any)=>pad.physical.padType==='thru_hole')).toHaveLength(9);
    await expect(current.bridge.execute({id:'unknown',name:'fresh_get_contract_pad_positions',arguments:{reference:'X1'}})).rejects.toThrow(/not in the complete host contract/);
    await expect(current.bridge.execute({id:'bad-pin',name:'fresh_get_contract_pad_positions',arguments:{reference:'T80',pad:'999'}})).rejects.toThrow(/does not exist exactly once/);
  });
  it('passes the real V2 sync producer through strict harness consumption and mandatory save',async()=>{
    const current=await fixture(routeSource());const produced:HarnessToolResult[]=[];const phases:string[]=[];
    const validations:Record<string,unknown>={run_erc:{status:'clean',findings:[],metadata:{available:true,violation_count:0}},run_drc:{status:'clean',findings:[],metadata:{available:true,violations:0,unconnected_items:0,courtyard_issues:0}},pcb_get_board_summary:{status:'clean',findings:[],metadata:{footprints:2,pads:6,nets:1,tracks:1,shapes:1}},pcb_visual_qa:{status:'PASS',findings:[],footprint_count:2,board_bounds:[0,0,80,50]}};
    const port:HarnessToolPort={tools:current.bridge.tools,execute:async call=>{phases.push(call.name);const result=await current.bridge.execute(call as never);produced.push(result);return result;},internal:{...current.bridge.internal,
      saveAfterMutation:async call=>{phases.push('save');return await current.bridge.internal.saveAfterMutation(call);},execute:async call=>{phases.push(call.name);return {toolCallId:call.id,content:JSON.stringify(validations[call.name])};}}};
    let gateCalls=0;
    const report=await runPcbAgentHarness({userPrompt:'Offline physical import sequencing test.',fixedRules:['Independent completion remains required.'],projectPath:current.project.projectPath,reportPath:path.join(current.project.outputPath,'physical-report.json'),editsRequired:true,allowedToolNames:current.bridge.tools,maxIterations:1},
      {provider:'fixture',turn:async():Promise<HarnessProviderTurn>=>({message:{role:'assistant',content:'Import physical fixture.'},stopReason:'tool_calls',toolCalls:[syncCall]})},port,
      {compoundMutationContractIdentity:createFreshConnectivityContract(current.bundle.contract).identity,captureValidationSource:async()=>({schematic:contentIdentity(await readFile(current.project.schematicPath)),pcb:contentIdentity(await readFile(current.project.pcbPath))}),completionGate:async()=>{gateCalls++;return {passed:false,missing:['Offline fixture is not a completed PCB design.']};}});
    expect(JSON.parse(produced[0]!.content).schemaVersion).toBe('evleda.fresh-sync-from-schematic-result.v2');
    expect(compoundMutationState(syncCall,produced[0]!,createFreshConnectivityContract(current.bundle.contract).identity)).toBe(true);
    expect(phases).toEqual(['fresh_sync_from_schematic','save','run_erc','run_drc','pcb_get_board_summary','pcb_visual_qa']);
    expect(gateCalls).toBe(1);expect(report.status).toBe('needs_review');expect(current.nativeReads()).toBe(2);
  });
});
