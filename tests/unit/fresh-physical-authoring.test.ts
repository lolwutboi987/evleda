import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
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
import { createKicadHarnessTools, KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES, type FreshFootprintPlacementDiagnostic, type KicadHarnessSession, type KicadHarnessToolsOptions } from "../../src/harness/kicad-tools.js";
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

function bundleFor(source:string,allowedRotationsDeg:readonly number[]=[0]){
  const parsed=parseFreshPcbSource(source),base=genericDividerDraft();
  const components=parsed.footprints.map(fp=>({reference:fp.reference,symbolLibId:`Fixture:Terminals_${fp.reference}`,value:fp.value,footprintLibId:fp.libraryId,unit:1,
    pins:[...new Set(fp.pads.map(p=>p.number).filter(Boolean))].map(pin=>({pin,assignment:(fp.pads.find(p=>p.number===pin)!.netName===null||fp.pads.find(p=>p.number===pin)!.netName!.startsWith("unconnected-("))?{kind:"no_connect" as const}:{kind:"net" as const,net:fp.pads.find(p=>p.number===pin)!.netName!}}))}));
  const nets=[...new Set(components.flatMap(c=>c.pins.flatMap(p=>p.assignment.kind==="net"?[p.assignment.net]:[])))].map(name=>({
    ...structuredClone(base.nets[0]!),name,role:"passive",netClassId:"SIGNAL",endpoints:components.flatMap(c=>c.pins.flatMap(p=>p.assignment.kind==="net"&&p.assignment.net===name?[{reference:c.reference,pin:p.pin}]:[])),
  }));
  const draft={...base,scope:{...base.scope,board:{...base.scope.board,widthMm:80,heightMm:50}},components,
    nets,
    netClasses:[{id:"SIGNAL",traceWidthMm:0.25,clearanceMm:0.2,copperToEdgeMm:0.5,allowedLayers:["F.Cu"]}],
    placementConstraints:components.map(c=>({reference:c.reference,side:"front",regionMm:{minXmm:1,maxXmm:79,minYmm:1,maxYmm:49},allowedRotationsDeg:[...allowedRotationsDeg],minimumEdgeClearanceMm:1,minimumCourtyardClearanceMm:0.25,edgePreference:"none"})),
    routingConstraints:{...base.routingConstraints,nets:nets.map(net=>({net:net.name,topology:net.endpoints.length===2?"point_to_point":"tree",preferredLayer:"F.Cu",maxVias:0,routeLength:{mode:"unbounded"}}))}};
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
  return `(kicad_sch (version 20250316) (generator "fixture") ${bundle.contract.nets.map(net=>`(global_label "${net.name}" (shape passive) (at 10 10 0))`).join(' ')} ${bundle.contract.components.map(c=>`(symbol (lib_id "${c.symbolLibId}") (at 20 20 0) (property "Reference" "${c.reference}") (property "Value" "${c.value}") (property "Footprint" "${c.footprintLibId}"))`).join(' ')} ${bundle.contract.components.flatMap(c=>c.pins.filter(p=>p.assignment.kind==="no_connect").map((_,i)=>`(no_connect (at ${40+i} 30))`)).join(' ')})`;
}
function netlistFor(bundle:ReturnType<typeof bundleFor>["bundle"],source:string):string{
  const board=parseFreshPcbSource(source);
  const nets=bundle.contract.nets.map((net,index)=>`(net (code "${index+1}") (name "${net.name}") ${net.endpoints.map(p=>`(node (ref "${p.reference}") (pin "${p.pin}") (pintype "passive"))`).join(' ')})`);
  const nc=bundle.contract.components.flatMap(c=>c.pins.flatMap(p=>p.assignment.kind==="no_connect"?[`(net (code "nc-${c.reference}-${p.pin}") (name "${board.footprints.find(fp=>fp.reference===c.reference)!.pads.find(pad=>pad.number===p.pin)!.netName??`unconnected-(${c.reference}-Pin_${p.pin}-Pad${p.pin})`}") (node (ref "${c.reference}") (pin "${p.pin}") (pintype "passive+no_connect")))`]:[]));
  return `(export (design (source "fixture.kicad_sch") (date "2026-09-09T10:00:00")) (components ${bundle.contract.components.map(c=>`(comp (ref "${c.reference}") (value "${c.value}") (footprint "${c.footprintLibId}") (libsource (lib "Fixture") (part "Terminals_${c.reference}")))`).join(' ')}) (nets ${nets.join(' ')} ${nc.join(' ')}))`;
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
    if(pad.number){const net=nc&&fp.reference===`T${count}`&&pad.number===String(count+1)?`unconnected-(${fp.reference}-Pin_${pad.number}-Pad${pad.number})`:"LINK";source=source.replace(pad.physical.source,pad.physical.source.slice(0,-1)+` (net "${net}"))`);}
  }
  const sourcePins=ids.map((libraryId,i)=>({reference:`${i===0?'S':'T'}${count}`,libraryId,sourceIdentity:physicalResolver.inspectFootprint(libraryId)!.sourceIdentity}));
  return {source,physicalResolver,sourcePins};
}
function routeSource():string{
  const fp=(ref:string,x:number,extra:string)=>`(footprint "Fixture:${ref}" (layer "F.Cu") (at ${x} 10 0) (property "Reference" "${ref}") (property "Value" "TEST") (pad "1" smd rect (at 0 0) (size 2 2) (layers "F.Cu") (net "LINK")) (pad "2" smd rect (at 0 2) (size 1 1) (layers "F.Cu") (net "unconnected-(${ref}-Pin_2-Pad2)")) ${extra})`;
  return withNativePadFixtureIds(header+fp('A1',5,'')+fp('B1',15,'(pad "1" thru_hole circle (at -0.5 0) (size 0.5 0.5) (drill 0.2) (layers "*.Cu") (net "LINK")) (pad "" smd rect (at 0 0) (size 0.7 0.7) (layers "F.Paste"))')+`\n(segment (start 5 10) (end 15 9) (width 0.25) (layer "F.Cu") (net "LINK") (uuid "${routeId}"))\n)\n`);
}
interface Options {
  syncSource?:string;syncReply?:CallToolResult;
  routePushAutosave?:boolean;forbidUnsavedRouteNetlist?:boolean;historyDriftDuringParity?:boolean;
  routePushDrift?:"schematic"|"project"|"custom-rules"|"symbol-library"|"footprint-library"|"symbol-table"|"footprint-table"|"marker"|"authoritative-pcb"|"physical-library"|"live-pad-geometry";
  nativeNoConnectReachesFunctional?:boolean;nativeNoConnectSeparated?:boolean;schematicDriftDuringRead?:boolean;schematicDriftDuringParity?:boolean;
  initial?:string;legacy?:boolean;nativeFailureOnSave?:boolean;nativeDisconnectedOnSave?:boolean;nativeParityFailureOnSave?:boolean;
  driftDuringRead?:boolean;badMetrics?:boolean;saveChangesPad?:boolean;corruptSyncNet?:boolean;pcbDriftDuringParity?:boolean;
  initialLive?:string;allowedRotationsDeg?:readonly number[];reloadFailure?:boolean;reloadDrift?:boolean;saveFailure?:boolean;
  saveDropsMetadata?:boolean;reloadReply?:string;saveReply?:string;
  readonlyTools?:readonly string[];qualifiedFootprintWriter?:boolean;
  placementDiagnosticObserver?:(diagnostic:FreshFootprintPlacementDiagnostic,savedSource:string)=>void|Promise<void>;
}
async function fixture(source:string,options:Options={},physical?:Awaited<ReturnType<typeof qfnSource>>){
  const generic=bundleFor(source,options.allowedRotationsDeg),root=await mkdtemp(path.join(os.tmpdir(),'evleda-physical-authoring-'));roots.add(root);
  const project=await prepareFreshProject({outputDir:path.join(root,'output'),name:'physical',resume:false,workflowKind:'generic',compilationBundle:generic.bundle,compilationBundleRef:generic.reference});
  let live=options.initialLive??options.initial??empty,transaction=live,saveCount=0,reloadCount=0,nativeReads=0,netlistReads=0,trackOrdinal=0;
  let routePushedUnsaved=false,postPushReadObserved=false,physicalLibraryDrift=false;
  await writeFile(project.pcbPath,options.initial??empty,'utf8');await writeFile(project.schematicPath,schematicFor(generic.bundle),'utf8');
  const historyPcbPath=path.join(project.projectPath,'.history',`${project.name}.kicad_pcb`);
  if(options.routePushAutosave){await mkdir(path.dirname(historyPcbPath));await writeFile(historyPcbPath,options.initial??empty,'utf8');}
  const fakeBaseline=await nativePadObservationFixture(source);
  const calls:string[]=[];
  const nativeWriteSources:Array<{name:string;source:string;liveSource:string}>=[];
  const netlistExports:Array<{saveCount:number;routePushedUnsaved:boolean}>=[];
  const postPushReads:Array<{savedSource:string;liveSource:string}>=[];
  const postPushMutations:Array<{path:string;source:string}>=[];
  async function observePostPushLiveRead(){
    if(!routePushedUnsaved||postPushReadObserved||(!options.routePushAutosave&&options.routePushDrift===undefined))return;
    postPushReadObserved=true;
    postPushReads.push({savedSource:await readFile(project.pcbPath,'utf8'),liveSource:live});
    if(options.routePushAutosave)await writeFile(historyPcbPath,live,'utf8');
    const changedFiles:Partial<Record<NonNullable<Options['routePushDrift']>,string>>={
      schematic:project.schematicPath,project:path.join(project.projectPath,`${project.name}.kicad_pro`),
      'custom-rules':path.join(project.projectPath,`${project.name}.kicad_dru`),
      'symbol-library':path.join(project.projectPath,'introduced.kicad_sym'),'footprint-library':path.join(project.projectPath,'introduced.kicad_mod'),
      'symbol-table':path.join(project.projectPath,'sym-lib-table'),'footprint-table':path.join(project.projectPath,'fp-lib-table'),
      marker:project.markerPath,'authoritative-pcb':project.pcbPath,
    };
    const changedPath=options.routePushDrift===undefined?undefined:changedFiles[options.routePushDrift];
    if(changedPath!==undefined){
      const introduced=options.routePushDrift==='custom-rules'?'(version 1)\n':options.routePushDrift==='symbol-library'?'(kicad_symbol_lib (version 20241209) (generator "fixture"))\n':options.routePushDrift==='footprint-library'?'(footprint "introduced" (layer "F.Cu"))\n':undefined;
      const changedSource=introduced??(await readFile(changedPath,'utf8'))+'\n';
      await writeFile(changedPath,changedSource,'utf8');postPushMutations.push({path:changedPath,source:changedSource});
    }
    if(options.routePushDrift==='physical-library')physicalLibraryDrift=true;
    if(options.routePushDrift==='live-pad-geometry')live=live.replace('(size 2 2)','(size 2.1 2)');
  }
  const session:KicadHarnessSession={
    supportsNativeRouteTransactions:()=>true,
    supportsQualifiedFootprintIdentitySync:()=>options.qualifiedFootprintWriter??true,
    supportsQualifiedFootprintPoseSync:()=>true,
    listTools:()=>KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES.filter(name=>!name.startsWith('evleda_get_live')).map(name=>({name,permission:options.readonlyTools?.includes(name)?'read' as const:'write' as const,inputSchema:{type:'object',additionalProperties:true}})),
    assertActivePcb:async expected=>{if(expected!==project.pcbPath)throw new Error('wrong active path');},
    readActivePcbSource:async()=>{await observePostPushLiveRead();return live;},
    readLivePcbPadSnapshot:async ids=>{
      nativeReads++;calls.push('private-pad-read');
      const generated=await nativePadObservationFixture(live,source);
      const payload=structuredClone(generated.observation.rawSnapshot) as Record<string,any>;
      const document={type:'DOCTYPE_PCB',board_filename:path.basename(project.pcbPath),project:{name:project.name,path:path.dirname(project.pcbPath)}};
      payload.documentBefore=document;payload.documentAfter=document;payload.enabledLayers.request.board=document;payload.footprintInventory.request.header.document=document;payload.padstackPresence.request.board=document;
      const byId=new Map<string,any>(payload.connectivity.map((query:any)=>[query.sourcePrimitiveId,query]));
      payload.connectivity=ids.map(id=>{const query=structuredClone(byId.get(id));if(!query)throw new Error('unrequested fixture pad');query.request.header.document=document;
        if(saveCount>0&&options.nativeDisconnectedOnSave)query.padRecordIndexes=query.padRecordIndexes.filter((index:number)=>payload.padRecords[index].id.value===id);return query;});
      if(options.nativeNoConnectReachesFunctional||options.nativeNoConnectSeparated){
        const parsed=parseFreshPcbSource(live),ncIds=new Set(parsed.footprints.flatMap(fp=>fp.pads.filter(pad=>pad.netName?.startsWith("unconnected-(")).map(pad=>pad.physical.id)));
        const functionalId=parsed.footprints.flatMap(fp=>fp.pads).find(pad=>pad.netName==="LINK")!.physical.id;
        for(const query of payload.connectivity)if(ncIds.has(query.sourcePrimitiveId))query.padRecordIndexes=options.nativeNoConnectSeparated?[payload.padRecords.findIndex((pad:any)=>pad.id.value===query.sourcePrimitiveId)]:[...query.padRecordIndexes,payload.padRecords.findIndex((pad:any)=>pad.id.value===functionalId)];
      }
      if(options.schematicDriftDuringRead)await writeFile(project.schematicPath,schematicFor(generic.bundle)+"\n",'utf8');
      if(saveCount>0&&options.nativeFailureOnSave)payload.boardSourceAfter+='\n';
      if(options.driftDuringRead)await writeFile(project.pcbPath,live+'\n','utf8');
      return {isError:false,structuredContent:payload,content:[{type:'text',text:JSON.stringify(payload)}]};
    },
    callTool:async(name,args={})=>{
      calls.push(name);let result='ok';
      if(name==='pcb_revert'||name==='pcb_save')nativeWriteSources.push({name,source:await readFile(project.pcbPath,'utf8'),liveSource:live});
      if(name==='pcb_sync_from_schematic'){live=options.syncSource??(options.corruptSyncNet?source.replace('(net "LINK")','(net "BAD")'):source);await writeFile(project.pcbPath,live,'utf8');if(options.syncReply)return options.syncReply;result=upstream(source);if(options.badMetrics)result=result.replace(/Total pads considered: \d+/u,'Total pads considered: 1');}
      if(name==='pcb_begin_commit'){transaction=live;result='Transaction group started. Use pcb_push_commit to apply or pcb_drop_commit to discard.';}
      if(name==='pcb_drop_commit'){live=transaction;routePushedUnsaved=false;result='Transaction group discarded successfully.';}
      if(name==='pcb_push_commit'){routePushedUnsaved=true;result='Transaction group committed successfully.';}
      if(name==='pcb_delete_items'){const ids=args.item_ids as string[];live=live.split(/(?<=\n)/u).filter(line=>!ids.some(id=>line.includes(`(uuid "${id}")`))).join('');result='Route items deleted.';}
      if(name==='pcb_add_track'){const id=`66666666-6666-4666-8666-${String(++trackOrdinal).padStart(12,'0')}`;live=addItem(live,`(segment (start ${args.x1_mm} ${args.y1_mm}) (end ${args.x2_mm} ${args.y2_mm}) (width ${args.width_mm}) (layer "${String(args.layer).replace('_','.')}") (net "${args.net_name}") (uuid "${id}"))`);result='Track added.';}
      if(name==='pcb_save'){
        saveCount++;
        if(options.saveFailure)return {isError:true,content:[{type:'text',text:'native save fixture failure'}]};
        if(options.saveChangesPad)live=live.replace('(size 2 2)','(size 2.1 2)');
        if(options.saveDropsMetadata)live=live.replace('(property pad_prop_heatsink)','');
        await writeFile(project.pcbPath,live,'utf8');routePushedUnsaved=false;result=options.saveReply??'Board saved.';
      }
      if(name==='pcb_revert'){
        reloadCount++;
        if(reloadCount===1&&options.reloadDrift){live=(await readFile(project.pcbPath,'utf8')).replace('(property pad_prop_heatsink)','');await writeFile(project.pcbPath,live,'utf8');}
        if(reloadCount===1&&(options.reloadFailure||options.reloadDrift))return {isError:true,content:[{type:'text',text:'native reload fixture failure'}]};
        live=await readFile(project.pcbPath,'utf8');routePushedUnsaved=false;result=options.reloadReply??'Board reverted to last saved state. All unsaved changes have been discarded.';
      }
      return {content:[],structuredContent:{result}};
    },
  };
  const baselinePhysicalResolver=physical?.physicalResolver??fakeBaseline.expected.physicalFootprintResolver!;
  const physicalResolver:NonNullable<KicadHarnessToolsOptions['freshPhysicalFootprintResolver']>=options.routePushDrift==='physical-library'?{
    inspectFootprint(libraryId){const inspected=baselinePhysicalResolver.inspectFootprint(libraryId);return inspected===null||!physicalLibraryDrift?inspected:{...inspected,sourceIdentity:contentIdentity(`changed-library:${libraryId}`)};},
  }:baselinePhysicalResolver;
  const toolOptions:KicadHarnessToolsOptions={freshProject:project,freshConnectivityContract:generic.bundle.contract,freshCompilationBundle:generic.bundle,
    ...(options.placementDiagnosticObserver===undefined?{}:{observeFreshFootprintPlacementDiagnostic:async(diagnostic:FreshFootprintPlacementDiagnostic)=>{await options.placementDiagnosticObserver!(diagnostic,await readFile(project.pcbPath,'utf8'));}}),
    capturePersistedMutationBaseline:async()=>contentIdentity(await readFile(project.pcbPath)).digest,verifyPersistedMutation:async baseline=>baseline!==contentIdentity(await readFile(project.pcbPath)).digest,
    captureFreshNativeNetlist:async()=>{netlistReads++;netlistExports.push({saveCount,routePushedUnsaved});if(options.historyDriftDuringParity)await writeFile(historyPcbPath,source+"\n",'utf8');if(options.forbidUnsavedRouteNetlist&&routePushedUnsaved)throw new Error('Fixture forbids native netlist export while pushed route remains unsaved.');if(options.schematicDriftDuringParity)await writeFile(project.schematicPath,schematicFor(generic.bundle)+"\n",'utf8');if(saveCount>0&&options.pcbDriftDuringParity)await writeFile(project.pcbPath,live+'\n','utf8');const value=netlistFor(generic.bundle,source);return saveCount>0&&options.nativeParityFailureOnSave?value.replace('(name "LINK")','(name "WRONG")'):value;},
    ...(options.legacy?{}:{freshPhysicalFootprintResolver:physicalResolver,freshPhysicalFootprintSourcePins:physical?.sourcePins??fakeBaseline.expected.physicalFootprints!})};
  const bridge=createKicadHarnessTools(session,toolOptions);
  return {...generic,project,bridge,calls,nativeWriteSources,historyPcbPath,netlistExports,postPushReads,postPushMutations,live:()=>live,nativeReads:()=>nativeReads,netlistReads:()=>netlistReads,
    replaceOwnedSource:async(next:string)=>{live=next;await writeFile(project.pcbPath,next,'utf8');}};
}
const syncCall={id:'sync',name:'fresh_sync_from_schematic' as const,arguments:{}};
const saveCall={id:'save',name:'pcb_save' as const,arguments:{}};
const placementAliases=['pcb_move_footprint','pcb_move_component','pcb_place_component'] as const;
const placementCall=(name:typeof placementAliases[number]='pcb_move_footprint',arguments_:{reference:string;x_mm:number;y_mm:number;rotation_deg?:number}={reference:'S60',x_mm:22,y_mm:24})=>({id:`place-${name}`,name,arguments:arguments_});

async function placementFailure(operation:Promise<unknown>){
  const failure=await operation.then(()=>undefined,(error:unknown)=>error);
  expect(failure).toBeInstanceOf(Error);
  return failure as Error&{placementDiagnostic:{phase:string;firstOperation:string;primary:{name:string;message:string};beforePcbContentIdentity:unknown;plannedPcbContentIdentity:unknown;savedPcbAtFailure:{source:string;contentIdentity:unknown};nativeResponse?:unknown}};
}

describe('native04 saved USB-C source through the physical authoring boundary',()=>{
  // Real saved post-import source/reply; native04 failed BEFORE a full PAD capture.
  // The native-pad responses and schematic transport below are constructed offline.
  const source=readFileSync(new URL('../fixtures/usb-c-native-pads/native04-saved-post-import.kicad_pcb',import.meta.url),'utf8');
  const syncReply=JSON.parse(readFileSync(new URL('../fixtures/usb-c-native-pads/native04-sync-reply.json',import.meta.url),'utf8')) as CallToolResult;
  const original=parseFreshPcbSource(source),connector=original.footprints.find(fp=>fp.reference==='J1')!;
  const hole=connector.pads.find(pad=>pad.physical.padType==='np_thru_hole')!;
  const padRead={id:'read-usb',name:'fresh_get_contract_pad_positions' as const,arguments:{reference:'J1'}};

  it('syncs, reads terminals and preserves every native04 physical feature through a saved move',async()=>{
    expect(contentIdentity(source)).toEqual({algorithm:'sha256',digest:'3bcb34016b6385a7d943ffdb9617d2d6619cbc2e847163351aa416741fc25014',size:14257});
    const current=await fixture(source,{syncReply,allowedRotationsDeg:[0,90]});
    const synced=JSON.parse((await current.bridge.execute(syncCall)).content);
    expect(synced).toMatchObject({applied:true,physicalPadCount:24,logicalTerminalCount:19,numberedCopperPrimitiveCount:22,
      nonElectricalFeatureCount:2,platedFootprintHoleCount:6,logicalNoConnectTerminalCount:8,noConnectCopperPrimitiveCount:8,
      functionalCopperPrimitiveCount:14,netlessCopperPrimitiveCount:0,upstreamMetrics:{totalPadsConsidered:22,namedPads:22,noNetPads:0}});
    expect(synced.afterPcbContentIdentity).toEqual(contentIdentity(source));
    expect(synced.placementReview.interimFindings).toHaveLength(3);
    expect((await current.bridge.internal.saveAfterMutation(saveCall)).isError).not.toBe(true);
    const read=JSON.parse((await current.bridge.execute(padRead)).content);
    expect(read.components.find((component:any)=>component.reference==='J1')).toEqual({reference:'J1',logicalTerminalCount:17,physicalPadCount:22});
    expect(read.terminals.find((terminal:any)=>terminal.pad==='SH').physicalPadIds).toHaveLength(4);
    expect(read.terminals.find((terminal:any)=>terminal.pad==='A5')).toMatchObject({net:null,disposition:'no_connect',nativeNetName:'unconnected-(J1-CC1-PadA5)'});
    expect(read.pads).toHaveLength(12);
    expect(read.pads.every((pad:any)=>pad.pad!==''&&!pad.net.startsWith('unconnected-('))).toBe(true);
    expect(read.pads.some((pad:any)=>pad.physical.id===hole.physical.id)).toBe(false);
    const moved=JSON.parse((await current.bridge.execute(placementCall('pcb_move_footprint',{reference:'J1',x_mm:22,y_mm:24,rotation_deg:90}))).content);
    expect(moved).toMatchObject({applied:true,reference:'J1',footprintId:connector.id,after:{xMm:22,yMm:24,rotationDeg:90}});
    expect((await current.bridge.internal.saveAfterMutation(saveCall)).isError).not.toBe(true);
    const after=parseFreshPcbSource(await readFile(current.project.pcbPath,'utf8')),placed=after.footprints.find(fp=>fp.reference==='J1')!;
    expect(placed.libraryId).toBe(connector.libraryId);
    expect(placed.pads.map(pad=>[pad.physical.id,pad.number,pad.netName,pad.physical.definitionKey])).toEqual(connector.pads.map(pad=>[pad.physical.id,pad.number,pad.netName,pad.physical.definitionKey]));
    expect(after.footprints.find(fp=>fp.reference==='J2')).toEqual(original.footprints.find(fp=>fp.reference==='J2'));
    const reread=JSON.parse((await current.bridge.execute(padRead)).content);
    expect(reread.boardCounts).toEqual(read.boardCounts);
  });

  it.each(['oval','explicit zero net and offset'] as const)('admits the bounded constructed %s variant without exposing a hole terminal',async kind=>{
    const changedHole=kind==='oval'?hole.physical.source.replace('np_thru_hole circle','np_thru_hole oval')
      .replace('(size 0.65 0.65)','(size 0.65 0.9)').replace('(drill 0.65)','(drill oval 0.65 0.9)')
      :`${hole.physical.source.slice(0,-1).replace('(drill 0.65)','(drill 0.65 (offset 0 0))')} (net 0 ""))`;
    const variant=source.replace(hole.physical.source,changedHole),current=await fixture(variant,{initial:variant});
    const read=JSON.parse((await current.bridge.execute(padRead)).content);
    expect(read.boardCounts).toMatchObject({physicalPadCount:24,logicalTerminalCount:19,nonElectricalFeatureCount:2});
    expect(read.terminals.some((terminal:any)=>terminal.pad==='')).toBe(false);
    expect(read.pads.some((pad:any)=>pad.physical.id===hole.physical.id)).toBe(false);
  });

  it.each([
    ['numbered NPTH',(pad:string)=>pad.replace('(pad ""','(pad "LOCATOR"')],
    ['assigned NPTH',(pad:string)=>`${pad.slice(0,-1)} (net "GND"))`],
    ['annular NPTH',(pad:string)=>pad.replace('(size 0.65 0.65)','(size 0.8 0.8)')],
    ['offset NPTH',(pad:string)=>pad.replace('(drill 0.65)','(drill 0.65 (offset 0.1 0))')],
    ['unsupported shape',(pad:string)=>pad.replace('np_thru_hole circle','np_thru_hole rect')],
    ['unsupported type',(pad:string)=>pad.replace('np_thru_hole','unknown_pad')],
    ['unsupported layer',(pad:string)=>pad.replace('"*.Cu" "*.Mask"','"*.Cu" "Dwgs.User"')],
    ['paste layer',(pad:string)=>pad.replace('"*.Cu" "*.Mask"','"*.Cu" "F.Paste"')],
    ['missing drill',(pad:string)=>pad.replace('(drill 0.65)','')],
    ['duplicate size',(pad:string)=>pad.replace('(size 0.65 0.65)','(size 0.65 0.65) (size 0.65 0.65)')],
    ['unknown source field',(pad:string)=>`${pad.slice(0,-1)} (uncharacterized 1))`],
    ['unknown drill field',(pad:string)=>pad.replace('(drill 0.65)','(drill 0.65 (uncharacterized 1))')],
    ['sub-nm dimensions',(pad:string)=>pad.replace('(size 0.65 0.65)','(size 0.65000000000000000001 0.65)')],
  ] as const)('rejects %s at sync and contract pad read before raw PAD collection',async(_label,change)=>{
    const damaged=source.replace(hole.physical.source,change(hole.physical.source));
    const syncing=await fixture(source,{syncSource:damaged,syncReply});
    await expect(syncing.bridge.execute(syncCall)).rejects.toThrow();
    expect(syncing.nativeReads()).toBe(0);
    expect(await readFile(syncing.project.pcbPath,'utf8')).toBe(empty);
    const reading=await fixture(source,{initial:source});
    await reading.replaceOwnedSource(damaged);
    await expect(reading.bridge.execute(padRead)).rejects.toThrow();
    expect(reading.nativeReads()).toBe(0);
    expect(await readFile(reading.project.pcbPath,'utf8')).toBe(damaged);
  });

  it.each(['removed hole','changed bore','wrong library','wrong NC net'] as const)('retains complete source/library/NC checks for %s',async change=>{
    const current=await fixture(source,{initial:source});
    const damaged=change==='removed hole'?source.replace(hole.physical.source,'')
      :change==='changed bore'?source.replace(hole.physical.source,hole.physical.source.replaceAll('0.65','0.7'))
      :change==='wrong library'?source.replace(connector.libraryId,'Other:Different')
      :source.replace('(net "unconnected-(J1-CC1-PadA5)")','(net "GND")');
    await current.replaceOwnedSource(damaged);
    await expect(current.bridge.execute(padRead)).rejects.toThrow();
    expect(await readFile(current.project.pcbPath,'utf8')).toBe(damaged);
  });
});

describe('preserving physical footprint placement',()=>{
  it.each(placementAliases)('stages an exact stock-footprint translation for %s and requires native save/readback',async name=>{
    const qfn=await qfnSource(60),source=qfn.source,current=await fixture(source,{initial:source},qfn);
    const staged=source.replace('(at 15 20 0)','(at 22 24 0)');
    const original=parseFreshPcbSource(source).footprints[0]!;
    expect(source).toContain('(property pad_prop_heatsink)');expect(source).toContain('(model "${KICAD10_3DMODEL_DIR}');
    const moved=JSON.parse((await current.bridge.execute(placementCall(name))).content);
    expect(moved).toMatchObject({schemaVersion:'evleda.fresh-footprint-placement-result.v1',mutated:true,applied:true,idempotent:false,reference:'S60',footprintId:original.id,persistence:'native-save-required'});
    expect(moved.before).toEqual({xMm:15,yMm:20,rotationDeg:0});expect(moved.after).toEqual({xMm:22,yMm:24,rotationDeg:0});
    expect(await readFile(current.project.pcbPath,'utf8')).toBe(staged);expect(current.live()).toBe(staged);
    expect(current.nativeWriteSources).toEqual([{name:'pcb_revert',source:staged,liveSource:source}]);
    expect(current.calls.filter(call=>call==='pcb_revert'||call==='private-pad-read')).toEqual(['private-pad-read','pcb_revert','private-pad-read']);
    for(const alias of placementAliases)expect(current.calls).not.toContain(alias);
    const reads=current.nativeReads();
    expect((await current.bridge.internal.saveAfterMutation(saveCall)).isError).not.toBe(true);
    expect(current.nativeReads()).toBe(reads+2);expect(current.calls.at(-1)).toBe('private-pad-read');
    expect(current.nativeWriteSources.at(-1)).toEqual({name:'pcb_save',source:staged,liveSource:staged});
    expect(await readFile(current.project.pcbPath,'utf8')).toBe(staged);
    const saved=parseFreshPcbSource(current.live()).footprints;
    expect(saved[0]!.id).toBe(original.id);expect(saved[0]!.pads.map(p=>p.physical.source)).toEqual(original.pads.map(p=>p.physical.source));
    expect(saved[1]).toEqual(parseFreshPcbSource(source).footprints[1]);
  });

  it('rotates every stock pad angle while retaining physical members, models, tags and UUIDs',async()=>{
    const qfn=await qfnSource(60),current=await fixture(qfn.source,{initial:qfn.source,allowedRotationsDeg:[0,90]},qfn);
    const original=parseFreshPcbSource(qfn.source).footprints;
    await current.bridge.execute(placementCall('pcb_move_footprint',{reference:'S60',x_mm:22,y_mm:24,rotation_deg:90}));
    expect((await current.bridge.internal.saveAfterMutation(saveCall)).isError).not.toBe(true);
    const saved=await readFile(current.project.pcbPath,'utf8'),moved=parseFreshPcbSource(saved).footprints;
    expect(moved[0]).toMatchObject({id:original[0]!.id,reference:'S60',libraryId:original[0]!.libraryId,at:{x:22,y:24},rotationDeg:90});
    expect(moved[0]!.pads).toHaveLength(original[0]!.pads.length);
    for(const [index,pad]of moved[0]!.pads.entries()){
      const before=original[0]!.pads[index]!;
      expect(pad.at.x).toBeCloseTo(22+before.physical.relativeAt.y,8);expect(pad.at.y).toBeCloseTo(24-before.physical.relativeAt.x,8);
      expect(((pad.physical.rotationDeg-before.physical.rotationDeg)%360+360)%360).toBe(90);
      expect(pad.physical.relativeAt).toEqual(before.physical.relativeAt);
      expect(pad.physical.source.replace(/\(at [^)]*\)/u,'(at POSE)')).toBe(before.physical.source.replace(/\(at [^)]*\)/u,'(at POSE)'));
    }
    expect(saved.match(/\t\(model\b[\s\S]*?\r?\n\t\)/gu)).toEqual(qfn.source.match(/\t\(model\b[\s\S]*?\r?\n\t\)/gu));
    expect(saved.match(/\(property pad_prop_heatsink\)/gu)).toEqual(qfn.source.match(/\(property pad_prop_heatsink\)/gu));
    expect(moved[1]).toEqual(original[1]);
    for(const alias of placementAliases)expect(current.calls).not.toContain(alias);
    // Omitting the existing optional argument resets rotation to its public 0 default.
    const reset=JSON.parse((await current.bridge.execute(placementCall('pcb_move_component',{reference:'S60',x_mm:23,y_mm:24}))).content);
    expect(reset.before).toEqual({xMm:22,yMm:24,rotationDeg:90});expect(reset.after).toEqual({xMm:23,yMm:24,rotationDeg:0});
    expect((await current.bridge.internal.saveAfterMutation(saveCall)).isError).not.toBe(true);
    expect(parseFreshPcbSource(current.live()).footprints[0]!.pads.map(p=>p.physical.rotationDeg)).toEqual(original[0]!.pads.map(p=>p.physical.rotationDeg));
  });

  it('still performs the qualified mandatory save/readback for an idempotent placement',async()=>{
    const qfn=await qfnSource(60),current=await fixture(qfn.source,{initial:qfn.source},qfn);
    const result=JSON.parse((await current.bridge.execute(placementCall('pcb_move_footprint',{reference:'S60',x_mm:15,y_mm:20}))).content);
    expect(result).toMatchObject({mutated:false,applied:true,idempotent:true,persistence:'native-save-required'});
    expect(current.nativeWriteSources).toEqual([]);
    const reads=current.nativeReads();expect((await current.bridge.internal.saveAfterMutation(saveCall)).isError).not.toBe(true);
    expect(current.nativeReads()).toBe(reads+2);expect(current.nativeWriteSources.map(call=>call.name)).toEqual(['pcb_save']);
    expect(await readFile(current.project.pcbPath,'utf8')).toBe(qfn.source);
  });

  it.each([
    {reference:'MISSING',x_mm:22,y_mm:24},
    {reference:'S60',x_mm:80,y_mm:24},
    {reference:'S60',x_mm:22,y_mm:24,rotation_deg:90},
    {reference:'S60',x_mm:22,y_mm:24,rotation_deg:45},
  ])('rejects an invalid reference, region or rotation before native writes: %j',async args=>{
    const qfn=await qfnSource(60),current=await fixture(qfn.source,{initial:qfn.source},qfn);
    await expect(current.bridge.execute(placementCall('pcb_move_footprint',args))).rejects.toThrow();
    expect(current.nativeWriteSources).toEqual([]);expect(await readFile(current.project.pcbPath,'utf8')).toBe(qfn.source);
    for(const alias of placementAliases)expect(current.calls).not.toContain(alias);
  });

  it('rejects already-lost stock pad metadata at preflight without repairing the damaged source',async()=>{
    const qfn=await qfnSource(60),damaged=qfn.source.replace('(property pad_prop_heatsink)','');
    const current=await fixture(qfn.source,{initial:damaged},qfn);
    await expect(current.bridge.execute(placementCall())).rejects.toThrow();
    expect(current.nativeWriteSources).toEqual([]);expect(await readFile(current.project.pcbPath,'utf8')).toBe(damaged);expect(current.live()).toBe(damaged);
  });

  it.each(['pcb_move_footprint','pcb_revert','pcb_save','unqualified writer'])('requires actual native write authority before staging: %s',async capability=>{
    const qfn=await qfnSource(60),options:Options=capability==='unqualified writer'?{qualifiedFootprintWriter:false}:{readonlyTools:[capability]};
    const current=await fixture(qfn.source,{...options,initial:qfn.source},qfn);
    await expect(current.bridge.execute(placementCall())).rejects.toThrow();
    expect(current.calls).toEqual([]);expect(current.nativeWriteSources).toEqual([]);
    expect(await readFile(current.project.pcbPath,'utf8')).toBe(qfn.source);expect(current.live()).toBe(qfn.source);
  });

  it('preserves unsaved native edits when placement preflight detects disk/live drift',async()=>{
    const qfn=await qfnSource(60),unsaved=qfn.source.replace('(at 15 20 0)','(at 16 20 0)');
    const current=await fixture(qfn.source,{initial:qfn.source,initialLive:unsaved},qfn);
    await expect(current.bridge.execute(placementCall())).rejects.toThrow(/saved|unsaved|preimage|live|drift/i);
    expect(current.nativeWriteSources).toEqual([]);expect(await readFile(current.project.pcbPath,'utf8')).toBe(qfn.source);expect(current.live()).toBe(unsaved);
  });

  it('retains the reload fault and pre-cleanup stage evidence while rolling back only known source',async()=>{
    const qfn=await qfnSource(60),current=await fixture(qfn.source,{initial:qfn.source,reloadFailure:true},qfn);
    const staged=qfn.source.replace('(at 15 20 0)','(at 22 24 0)');
    const failure=await placementFailure(current.bridge.execute(placementCall()));
    expect(failure.message).toMatch(/TERMINAL/);expect(failure.message).toContain('native-reload');
    expect(failure.placementDiagnostic.nativeResponse).toMatchObject({isError:true,content:[{type:'text',text:'native reload fixture failure'}]});
    expect(failure.placementDiagnostic).toMatchObject({phase:'primary-failure',firstOperation:'native-reload',beforePcbContentIdentity:contentIdentity(qfn.source),plannedPcbContentIdentity:contentIdentity(staged),savedPcbAtFailure:{source:staged,contentIdentity:contentIdentity(staged)}});
    expect(failure.placementDiagnostic.primary.message).toContain('reload');
    expect(current.nativeWriteSources.map(call=>call.name)).toEqual(['pcb_revert','pcb_revert']);
    expect(current.nativeWriteSources[1]!.source).toBe(qfn.source);expect(await readFile(current.project.pcbPath,'utf8')).toBe(qfn.source);expect(current.live()).toBe(qfn.source);
    const writes=current.nativeWriteSources.length;
    await expect(current.bridge.execute(placementCall())).rejects.toThrow(/recovery|required|terminal|close/i);
    expect((await current.bridge.internal.saveAfterMutation(saveCall)).isError).toBe(true);expect(current.nativeWriteSources).toHaveLength(writes);
  });

  it('preserves unknown reload-time changes and keeps the original reload failure primary',async()=>{
    const qfn=await qfnSource(60),current=await fixture(qfn.source,{initial:qfn.source,reloadDrift:true},qfn);
    const staged=qfn.source.replace('(at 15 20 0)','(at 22 24 0)'),unknown=staged.replace('(property pad_prop_heatsink)','');
    const failure=await placementFailure(current.bridge.execute(placementCall()));
    expect(failure.message).toContain('native-reload');expect(failure.placementDiagnostic.firstOperation).toBe('native-reload');
    expect(failure.placementDiagnostic.nativeResponse).toMatchObject({isError:true,content:[{type:'text',text:'native reload fixture failure'}]});
    expect(failure.placementDiagnostic.savedPcbAtFailure).toEqual({source:unknown,contentIdentity:contentIdentity(unknown)});
    expect(current.nativeWriteSources.map(call=>call.name)).toEqual(['pcb_revert']);
    expect(await readFile(current.project.pcbPath,'utf8')).toBe(unknown);expect(current.live()).toBe(unknown);
  });

  it.each([false,true])('publishes frozen failure-time source before rollback without replacing the primary fault; observer throws=%s',async observerThrows=>{
    const qfn=await qfnSource(60),staged=qfn.source.replace('(at 15 20 0)','(at 22 24 0)');
    const observed:Array<{diagnostic:FreshFootprintPlacementDiagnostic;source:string}>=[];
    const current=await fixture(qfn.source,{initial:qfn.source,reloadFailure:true,placementDiagnosticObserver:(diagnostic,source)=>{
      observed.push({diagnostic,source});
      if(observerThrows)throw new Error('diagnostic observer fixture failure');
    }},qfn);
    const failure=await placementFailure(current.bridge.execute(placementCall()));
    expect(observed).toHaveLength(1);expect(observed[0]!.source).toBe(staged);expect(Object.isFrozen(observed[0]!.diagnostic)).toBe(true);
    expect(observed[0]!.diagnostic).toEqual(failure.placementDiagnostic);
    expect(failure.message).toContain('native-reload');expect(failure.message).not.toContain('diagnostic observer fixture failure');
    expect(failure.placementDiagnostic.nativeResponse).toMatchObject({isError:true,content:[{type:'text',text:'native reload fixture failure'}]});
    expect(await readFile(current.project.pcbPath,'utf8')).toBe(qfn.source);
  });

  it('rolls back a known placement stage after native save failure and retains the primary fault',async()=>{
    const qfn=await qfnSource(60),current=await fixture(qfn.source,{initial:qfn.source,saveFailure:true},qfn);
    const staged=qfn.source.replace('(at 15 20 0)','(at 22 24 0)');
    await current.bridge.execute(placementCall());
    const failure=await current.bridge.internal.saveAfterMutation(saveCall),diagnostic=current.bridge.freshFootprintPlacementDiagnostics!.at(-1)!;
    expect(failure.isError).toBe(true);expect(failure.content).toContain('native-save');
    expect(diagnostic.nativeResponse).toMatchObject({isError:true,content:[{type:'text',text:'native save fixture failure'}]});
    expect(diagnostic).toMatchObject({phase:'primary-failure',firstOperation:'native-save',beforePcbContentIdentity:contentIdentity(qfn.source),plannedPcbContentIdentity:contentIdentity(staged),savedPcbAtFailure:{source:staged,contentIdentity:contentIdentity(staged)}});
    expect(current.nativeWriteSources.map(call=>call.name)).toEqual(['pcb_revert','pcb_save','pcb_revert']);
    expect(await readFile(current.project.pcbPath,'utf8')).toBe(qfn.source);expect(current.live()).toBe(qfn.source);
    const writes=current.nativeWriteSources.length;
    await expect(current.bridge.execute(placementCall())).rejects.toThrow(/recovery|required|terminal|close/i);
    expect((await current.bridge.internal.saveAfterMutation(saveCall)).isError).toBe(true);expect(current.nativeWriteSources).toHaveLength(writes);
  });

  it('preserves unrecognized metadata loss during save instead of overwriting it with a rollback',async()=>{
    const qfn=await qfnSource(60),current=await fixture(qfn.source,{initial:qfn.source,saveDropsMetadata:true},qfn);
    const staged=qfn.source.replace('(at 15 20 0)','(at 22 24 0)'),unknown=staged.replace('(property pad_prop_heatsink)','');
    await current.bridge.execute(placementCall());
    const failure=await current.bridge.internal.saveAfterMutation(saveCall),diagnostic=current.bridge.freshFootprintPlacementDiagnostics!.at(-1)!;
    expect(failure.isError).toBe(true);expect(failure.content).toMatch(/TERMINAL/);expect(diagnostic.phase).toBe('primary-failure');
    expect(diagnostic.savedPcbAtFailure).toEqual({source:unknown,contentIdentity:contentIdentity(unknown)});
    expect(current.nativeWriteSources.map(call=>call.name)).toEqual(['pcb_revert','pcb_save']);
    expect(await readFile(current.project.pcbPath,'utf8')).toBe(unknown);expect(current.live()).toBe(unknown);
  });

  it.each(['reloadReply','saveReply'] as const)('requires the exact qualified native acknowledgement for %s',async reply=>{
    const qfn=await qfnSource(60),current=await fixture(qfn.source,{initial:qfn.source,[reply]:'ok'},qfn);
    if(reply==='reloadReply')await expect(current.bridge.execute(placementCall())).rejects.toThrow(/acknowledgement|qualified/i);
    else{await current.bridge.execute(placementCall());const saved=await current.bridge.internal.saveAfterMutation(saveCall);expect(saved.isError).toBe(true);expect(saved.content).toMatch(/acknowledgement|qualified/i);}
  });

  it('rejects a second queued placement, rolls back the known stage, and requires recovery',async()=>{
    const qfn=await qfnSource(60),current=await fixture(qfn.source,{initial:qfn.source},qfn);
    const queued=await Promise.allSettled([
      current.bridge.execute(placementCall()),
      current.bridge.execute(placementCall('pcb_place_component',{reference:'T60',x_mm:48,y_mm:24})),
    ]);
    expect(queued[0]!.status).toBe('fulfilled');expect(queued[1]!.status).toBe('rejected');
    if(queued[1]!.status==='rejected')expect(String(queued[1]!.reason)).toMatch(/save|pending/i);
    expect(current.nativeWriteSources.map(call=>call.name)).toEqual(['pcb_revert','pcb_revert']);
    expect(await readFile(current.project.pcbPath,'utf8')).toBe(qfn.source);expect(current.live()).toBe(qfn.source);
    const writes=current.nativeWriteSources.length;
    expect((await current.bridge.internal.saveAfterMutation(saveCall)).isError).toBe(true);
    await expect(current.bridge.execute(placementCall())).rejects.toThrow(/recovery|required|terminal|close/i);
    expect(current.nativeWriteSources).toHaveLength(writes);
  });

  it.each(['execute','saveAfterMutation'] as const)('uses mandatory placement guards for a concurrently queued internal %s save',async method=>{
    const qfn=await qfnSource(60),current=await fixture(qfn.source,{initial:qfn.source},qfn);
    const [moved,saved]=await Promise.all([
      current.bridge.execute(placementCall()),
      current.bridge.internal[method](saveCall),
    ]);
    expect(moved.isError).not.toBe(true);expect(saved.isError).not.toBe(true);
    expect(JSON.parse(saved.content).status).toBe('saved-and-native-footprint-placement-verified');
    expect(current.nativeReads()).toBe(4);
    expect(current.nativeWriteSources.map(call=>call.name)).toEqual(['pcb_revert','pcb_save']);
    expect((await current.bridge.execute({id:'after-queued-save',name:'fresh_get_contract_pad_positions',arguments:{reference:'S60',pad:'1'}})).isError).not.toBe(true);
  });
});

describe('qualified physical PCB authoring and mandatory save',()=>{
  it('keeps every native repeated NC member in inventory but exposes zero routing candidates',async()=>{
    const qfn=await qfnSource(60),current=await fixture(qfn.source,{initial:qfn.source,nativeNoConnectSeparated:true},qfn);
    const result=JSON.parse((await current.bridge.execute({id:'nc',name:'fresh_get_contract_pad_positions',arguments:{reference:'T60',pad:'61'}})).content);
    expect(result.pads).toEqual([]);expect(result.selectedCandidateCount).toBe(0);
    expect(result.terminals).toHaveLength(1);expect(result.terminals[0]).toMatchObject({reference:'T60',pad:'61',net:null,disposition:'no_connect',nativeNetName:'unconnected-(T60-Pin_61-Pad61)'});
    expect(result.terminals[0].physicalPadIds).toHaveLength(11);
    expect(result.boardCounts).toMatchObject({namedCopperPrimitiveCount:132,functionalCopperPrimitiveCount:121,noConnectCopperPrimitiveCount:11,netlessCopperPrimitiveCount:0});
    expect(await readFile(current.project.pcbPath,'utf8')).toBe(qfn.source);
  });
  it('rejects native NC reachability into a functional terminal',async()=>{
    const source=routeSource(),current=await fixture(source,{initial:source,nativeNoConnectReachesFunctional:true});
    await expect(current.bridge.execute({id:'nc-escape',name:'fresh_get_contract_pad_positions',arguments:{reference:'A1',pad:'2'}})).rejects.toThrow(/NC native reachability escaped/);
  });
  it.each(['schematicDriftDuringRead','schematicDriftDuringParity'] as const)('rejects NC source authority drift during %s',async failure=>{
    const source=routeSource(),current=await fixture(source,{initial:source,[failure]:true});
    await expect(current.bridge.execute({id:'nc-drift',name:'fresh_get_contract_pad_positions',arguments:{reference:'A1',pad:'2'}})).rejects.toThrow(/source.*changed/);
  });

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
    expect(result.upstreamMetrics.transferQuality).toBe('CLEAN');
    expect(result.namedCopperPrimitiveCount).toBe(result.numberedCopperPrimitiveCount);
    expect(result.functionalCopperPrimitiveCount).toBe(result.numberedCopperPrimitiveCount-11);expect(result.netlessCopperPrimitiveCount).toBe(0);
    expect(result.upstreamMetrics.noNetPads).toBe(0);expect(result).not.toHaveProperty('padCount');
    const reads=current.nativeReads();expect((await current.bridge.internal.saveAfterMutation(saveCall)).isError).not.toBe(true);
    expect(current.nativeReads()).toBe(reads+1);expect(current.netlistReads()).toBeGreaterThanOrEqual(3);
    const saved=parseFreshPcbSource(await readFile(current.project.pcbPath,'utf8'));
    expect(saved.footprints.flatMap(fp=>fp.pads)).toHaveLength(result.physicalPadCount);
    expect(Object.fromEntries(saved.footprints.map(fp=>[fp.reference,fp.libraryId]))).toEqual(Object.fromEntries(current.bundle.contract.components.map(component=>[component.reference,component.footprintLibId])));
  });
  it('keeps legacy DEGRADED rejection and exact rollback unchanged',async()=>{
    const current=await fixture(routeSource().replace(/ \(net "unconnected-\([^"]+"\)/gu,""),{legacy:true});
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
  it('retains the fresh-export fault and records the exact changed history operand without claiming authoritative PCB drift',async()=>{
    const source=routeSource(),current=await fixture(source,{initial:source,routePushAutosave:true,historyDriftDuringParity:true});
    const failure=await current.bridge.execute({id:'history-export-fault',name:'fresh_get_contract_pad_positions',arguments:{reference:'A1',pad:'2'}}).then(()=>undefined,(error:unknown)=>error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({message:'Native NC source/marker binding changed during complete netlist export.',cause:{phase:'fresh-native-terminal-export',changedSourceCount:1,
      changedSources:[{path:'.history/physical.kicad_pcb',pathTruncated:false}],changedSourcesTruncated:false,savedPcbChanged:false,markerBeforeChanged:false,markerAfterChanged:false}});
    expect(await readFile(current.project.pcbPath,'utf8')).toBe(source);
    expect(current.calls).not.toContain('pcb_begin_commit');
  });
  it('reuses qualified NC authority across an unsaved live route and PCB history autosave, then exports fresh evidence after Save',async()=>{
    const source=routeSource(),current=await fixture(source,{initial:source,routePushAutosave:true,forbidUnsavedRouteNetlist:true});
    const markerBefore=await readFile(current.project.markerPath,'utf8');
    expect(await readFile(current.historyPcbPath,'utf8')).toBe(source);
    const selection=JSON.parse((await current.bridge.execute({id:'read-autosave',name:'fresh_get_route_items',arguments:{}})).content);
    const change=await current.bridge.execute({id:'route-autosave',name:'fresh_replace_route_items',arguments:{selectionIdentity:selection.identity,net:'LINK',deleteItemIds:[routeId],tracks:[{x1Mm:5,y1Mm:10,x2Mm:15,y2Mm:10,layer:'F.Cu'}],vias:[]}});
    expect(change.isError).not.toBe(true);
    expect(JSON.parse(change.content)).toMatchObject({applied:true,mutated:true,addedTrackCount:1});
    expect(current.postPushReads).toHaveLength(1);
    const staged=current.postPushReads[0]!.liveSource;
    expect(staged).not.toBe(source);expect(current.postPushReads[0]!.savedSource).toBe(source);
    expect(current.live()).toBe(staged);expect(await readFile(current.historyPcbPath,'utf8')).toBe(staged);
    expect(await readFile(current.project.pcbPath,'utf8')).toBe(source);
    expect(await readFile(current.project.markerPath,'utf8')).toBe(markerBefore);
    expect(current.calls).toContain('pcb_push_commit');expect(current.calls).not.toContain('pcb_save');
    expect(current.netlistExports.length).toBeGreaterThan(0);
    expect(current.netlistExports.every(entry=>entry.saveCount===0&&!entry.routePushedUnsaved)).toBe(true);
    const exportsBeforeSave=current.netlistExports.length,readsBeforeSave=current.nativeReads();
    const saved=await current.bridge.internal.saveAfterMutation(saveCall);
    expect(saved.isError).not.toBe(true);expect(current.nativeReads()).toBeGreaterThan(readsBeforeSave);
    expect(current.netlistExports.length).toBeGreaterThan(exportsBeforeSave);
    expect(current.netlistExports.slice(exportsBeforeSave).every(entry=>entry.saveCount>0&&!entry.routePushedUnsaved)).toBe(true);
    expect(current.nativeWriteSources.find(entry=>entry.name==='pcb_save')).toEqual({name:'pcb_save',source,liveSource:staged});
    expect(await readFile(current.project.pcbPath,'utf8')).toBe(staged);
    expect(await readFile(current.historyPcbPath,'utf8')).toBe(staged);
  });
  it.each(['schematic','project','custom-rules','symbol-library','footprint-library','symbol-table','footprint-table','marker','authoritative-pcb','physical-library','live-pad-geometry'] as const)(
    'rejects post-Push %s drift despite allowing a separate PCB history autosave',async routePushDrift=>{
      const source=routeSource(),current=await fixture(source,{initial:source,routePushAutosave:true,forbidUnsavedRouteNetlist:true,routePushDrift});
      const selection=JSON.parse((await current.bridge.execute({id:'read-drift',name:'fresh_get_route_items',arguments:{}})).content);
      const operation=current.bridge.execute({id:'route-drift',name:'fresh_replace_route_items',arguments:{selectionIdentity:selection.identity,net:'LINK',deleteItemIds:[routeId],tracks:[{x1Mm:5,y1Mm:10,x2Mm:15,y2Mm:10,layer:'F.Cu'}],vias:[]}});
      let failure:unknown;
      try{await operation;}catch(error){failure=error;}
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/source|scope|marker|library|physical|geometry|preimage|changed|drift|identity/iu);
      expect((failure as Error).message).not.toContain('Fixture forbids native netlist export');
      expect(current.postPushReads).toHaveLength(1);
      expect(current.postPushReads[0]!.savedSource).toBe(source);
      expect(current.postPushReads[0]!.liveSource).not.toBe(source);
      expect(await readFile(current.historyPcbPath,'utf8')).toBe(current.postPushReads[0]!.liveSource);
      expect(current.calls).toContain('pcb_push_commit');expect(current.calls).not.toContain('pcb_save');
      expect(current.netlistExports.every(entry=>!entry.routePushedUnsaved)).toBe(true);
      // Rollback disposition remains governed by the existing host implementation;
      // the regression checks rejection, not an invented cleanup permission.
      if(routePushDrift!=='physical-library'&&routePushDrift!=='live-pad-geometry')expect(current.postPushMutations).toHaveLength(1);
    },
  );
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
