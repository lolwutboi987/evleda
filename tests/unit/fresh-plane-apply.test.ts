import { mkdtemp,mkdir,readFile,writeFile,rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach,describe,it,expect } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle,createPcbPlaneCompilationBundleRef } from "../../src/harness/pcb-design-plane-bundle.js";
import { preparePlaneFreshProject } from "../../src/harness/fresh-project.js";
import { createKicadHarnessTools,KICAD_PLANE_FRESH_SIDECAR_REQUIRED_TOOL_NAMES,type KicadHarnessSession } from "../../src/harness/kicad-tools.js";
import { genericDividerLibraryResolver } from "../helpers/generic-divider-bundle.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";
import { nativePadObservationFixture } from "../helpers/native-pad-observation-fixture.js";
import type { KicadPlaneStageInput,KicadPlaneStageReceipt } from "../../src/integrations/kicad-plane-stage.js";
import { planeStageObservationFixture } from "../helpers/plane-stage-observation-fixture.js";
import { planeCompoundMutationState } from "../../src/mcp/toolbox-plane-results.js";
import { createFreshConnectivityContract } from "../../src/harness/fresh-connectivity-contract.js";
import type { PcbReadOnlyLibraryResolver } from "../../src/harness/pcb-design-compiler.js";

const owned=new Set<string>();
afterEach(async()=>{for(const root of owned){await rm(root,{recursive:true,force:true});owned.delete(root);}});
const uuid=(index:number)=>`aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12,'0')}`;
const deps={libraryResolver:genericDividerLibraryResolver,deepRuleCatalog:loadDeepRuleCatalog()};
const compiled=compilePcbPlaneDesignIntentDraft(planeDividerDraft(),deps);
if(compiled.disposition!=='ready')throw new Error(JSON.stringify(compiled.issues));
const bundle=createPcbPlaneCompilationBundle({originalPrompt:'Offline true V2 plane APPLY lifecycle test, not native board qualification.',compilation:compiled},deps);
const pcb=`(kicad_pcb (version 20260206) (generator "pcbnew") (generator_version "10.0") (general (thickness 1.6)) (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user)) (gr_rect (start 0 0) (end 30 20) (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts")) ${bundle.contract.components.map((c,i)=>`(footprint "${c.footprintLibId}" (uuid "${uuid(i+1)}") (layer "F.Cu") (at ${5+i*8} 10 0) (property "Reference" "${c.reference}") (property "Value" "${c.value}") ${c.pins.map((p,j)=>`(pad "${p.pin}" smd rect (uuid "${uuid(100+i*10+j)}") (at ${j*2} 0) (size 1 1) (layers "F.Cu") (net "${p.assignment.kind==='net'?p.assignment.net:''}"))`).join(' ')})`).join(' ')})`;
const schematic=`(kicad_sch (version 20250316) (lib_symbols) ${bundle.contract.nets.map(n=>`(global_label "${n.name}" (shape passive) (at 10 10 0))`).join(' ')} ${bundle.contract.components.map(c=>`(symbol (lib_id "${c.symbolLibId}") (at 20 20 0) (unit 1) (property "Reference" "${c.reference}") (property "Value" "${c.value}") (property "Footprint" "${c.footprintLibId}"))`).join(' ')})`;
const nativeNoConnectName='isolated native plane-stage terminal J1.4';
function noConnectDocuments(){
  const draft=planeDividerDraft(),connector=draft.components.find(component=>component.reference==='J1')!;
  connector.symbolLibId='Connector_Generic:Conn_01x04';connector.footprintLibId='Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical';
  connector.pins.push({pin:'4',assignment:{kind:'no_connect'}});
  const libraryResolver:PcbReadOnlyLibraryResolver={
    resolveSymbol(libraryId){return libraryId===connector.symbolLibId?{...genericDividerLibraryResolver.resolveSymbol('Connector_Generic:Conn_01x03')!,libraryId,pins:['1','2','3','4'].map(number=>({number,function:`Pin ${number}`}))}:genericDividerLibraryResolver.resolveSymbol(libraryId);},
    resolveFootprint(libraryId){return libraryId===connector.footprintLibId?{...genericDividerLibraryResolver.resolveFootprint('Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical')!,libraryId,pads:['1','2','3','4']}:genericDividerLibraryResolver.resolveFootprint(libraryId);},
  };
  const dependencies={libraryResolver,deepRuleCatalog:deps.deepRuleCatalog},compilation=compilePcbPlaneDesignIntentDraft(draft,dependencies);
  if(compilation.disposition!=='ready')throw new Error(JSON.stringify(compilation.issues));
  const ncBundle=createPcbPlaneCompilationBundle({originalPrompt:'Offline true V2 NC unsaved plane stage regression.',compilation},dependencies);
  const ncPcb=pcb.replace('Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical',connector.footprintLibId)
    .replace(`(property "Value" "${connector.value}")`,`(property "Value" "${connector.value}") (pad "4" smd rect (uuid "${uuid(103)}") (at 6 0) (size 1 1) (layers "F.Cu") (net "${nativeNoConnectName}"))`);
  const ncSchematic=schematic.replace('Connector_Generic:Conn_01x03',connector.symbolLibId)
    .replace('Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical',connector.footprintLibId)
    .replace('(lib_symbols)','(lib_symbols) (no_connect (at 40 30))');
  const node=(reference:string,pin:string,pinType:string)=>`(node (ref "${reference}") (pin "${pin}") (pintype "${pinType}"))`;
  const ncNetlist=`(export (design (source "apply.kicad_sch") (date "2026-09-16T12:00:00")) (components ${ncBundle.contract.components.map(c=>{const [lib,part]=c.symbolLibId.split(':');return `(comp (ref "${c.reference}") (value "${c.value}") (footprint "${c.footprintLibId}") (libsource (lib "${lib}") (part "${part}")))`;}).join(' ')})
    (nets ${ncBundle.contract.nets.map(net=>`(net (name "${net.name}") ${net.endpoints.map(endpoint=>node(endpoint.reference,endpoint.pin,'passive')).join(' ')})`).join(' ')}
    (net (name "${nativeNoConnectName}") ${node('J1','4','passive+no_connect')})))`;
  return {bundle:ncBundle,pcb:ncPcb,schematic:ncSchematic,netlist:ncNetlist};
}
interface FixtureOptions{noConnect?:boolean;historyAutosave?:boolean;forbidDirtyNetlist?:boolean;stageSourceDrift?:'schematic'|'project'|'rules'}
type StageHandler=(request:KicadPlaneStageInput)=>Promise<KicadPlaneStageReceipt>;
async function fixture(mode:'missing'|'partial'|'unknown'|'transport'='partial',options:FixtureOptions={}){
  const documents=options.noConnect?noConnectDocuments():{bundle,pcb,schematic},fixtureBundle=documents.bundle,beforePcbSource=documents.pcb;
  const nativeNetlistSource='netlist' in documents?documents.netlist:undefined;
  const root=await mkdtemp(path.join(os.tmpdir(),'evleda-plane-apply-'));owned.add(root);
  const project=await preparePlaneFreshProject({outputDir:path.join(root,'output'),name:'apply',resume:false,compilationBundle:fixtureBundle,compilationBundleRef:createPcbPlaneCompilationBundleRef(fixtureBundle)});
  await writeFile(project.pcbPath,beforePcbSource,'utf8');await writeFile(project.schematicPath,documents.schematic,'utf8');
  const historyPcbPath=path.join(project.projectPath,'.history',`${project.name}.kicad_pcb`);
  if(options.historyAutosave){await mkdir(path.dirname(historyPcbPath));await writeFile(historyPcbPath,beforePcbSource,'utf8');}
  const physical=await nativePadObservationFixture(beforePcbSource);let live=beforePcbSource,dirty=false,saveCount=0,nativeReads=0;const calls:string[]=[];
  const netlistExports:Array<{dirty:boolean;saveCount:number}>=[],stageSourceMutations:Array<{path:string;source:string}>=[];
  let stage:StageHandler=async request=>{
    dirty=true;
    if(mode==='unknown')live=live.replace('(thickness 1.6)','(thickness 1.7)');
    if(mode==='transport')throw new Error('Uncertain transport after native unfill.');
    return {schemaVersion:'evleda.native-plane-stage.v1',complete:false,nativeSaveCalled:false,mutationDispatched:true,recoveryRequired:true,request:request.request,rpc:[],assurance:{accepted:false,minimumSpokes:'not_configured_by_zone_api',highFrequencyValidity:'not_established'}};
  };
  const session:KicadHarnessSession={listTools:()=>KICAD_PLANE_FRESH_SIDECAR_REQUIRED_TOOL_NAMES.map(name=>({name,permission:'write' as const,inputSchema:{type:'object',additionalProperties:true}})),
    supportsNativeRouteTransactions:()=>true,
    assertActivePcb:async expected=>{expect(expected).toBe(project.pcbPath);},readActivePcbSource:async()=>live,
    readLivePcbPadSnapshot:async ids=>{
      nativeReads++;
      const generated=await nativePadObservationFixture(live,beforePcbSource),payload=structuredClone(generated.observation.rawSnapshot) as Record<string,any>;
      const doc={type:'DOCTYPE_PCB',board_filename:path.basename(project.pcbPath),project:{name:project.name,path:path.dirname(project.pcbPath)}};
      payload.documentBefore=doc;payload.documentAfter=doc;payload.enabledLayers.request.board=doc;payload.footprintInventory.request.header.document=doc;payload.padstackPresence.request.board=doc;
      const queries=new Map<string,any>(payload.connectivity.map((q:any)=>[q.sourcePrimitiveId,q]));payload.connectivity=ids.map(id=>{const q=structuredClone(queries.get(id));q.request.header.document=doc;return q;});
      return {isError:false,content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:payload};
    },
    supportsPlaneStage:()=>mode!=='missing',stagePlane:async request=>{calls.push('stage');return await stage(request);},
    callTool:async name=>{calls.push(name);if(name==='pcb_revert'){live=await readFile(project.pcbPath,'utf8');dirty=false;}if(name==='pcb_save'){await writeFile(project.pcbPath,live,'utf8');dirty=false;saveCount++;}return {content:[],structuredContent:{result:name==='pcb_save'?'Board saved.':'Board reverted to last saved state. All unsaved changes have been discarded.'}};},
  };
  const bridge=createKicadHarnessTools(session,{freshProject:project,freshConnectivityContract:fixtureBundle.contract,freshPlaneCompilationBundle:fixtureBundle,
    freshPhysicalFootprintResolver:physical.expected.physicalFootprintResolver!,freshPhysicalFootprintSourcePins:physical.expected.physicalFootprints!,
    ...(typeof nativeNetlistSource==='string'?{captureFreshNativeNetlist:async()=>{netlistExports.push({dirty,saveCount});if(options.forbidDirtyNetlist&&dirty)throw new Error('Fixture forbids native netlist export while native plane stage remains dirty.');return nativeNetlistSource;}}:{}),
    capturePersistedMutationBaseline:async()=>contentIdentity(await readFile(project.pcbPath)).digest,verifyPersistedMutation:async()=>false});
  return {bundle:fixtureBundle,project,session,bridge,calls,beforePcbSource,historyPcbPath,netlistExports,stageSourceMutations,nativeReads:()=>nativeReads,dirty:()=>dirty,live:()=>live,setLive:(source:string)=>{live=source;dirty=true;},setStage:(next:StageHandler)=>{stage=next;},physical};
}
const apply={id:'apply',name:'fresh_apply_contract_plane' as const,arguments:{}};
const save={id:'save',name:'pcb_save' as const,arguments:{}};
async function validFixture(options:FixtureOptions={}){
  const f=await fixture('partial',options);let beforeZones:Record<string,any>[]=[];
  let generated:Awaited<ReturnType<typeof planeStageObservationFixture>>|undefined;
  f.setStage(async request=>{
    generated=await planeStageObservationFixture({beforePcbSource:await readFile(f.project.pcbPath,'utf8'),request,beforeZoneProtos:beforeZones});
    beforeZones=[generated.stagedZoneProto];f.setLive(generated.stagedSource);
    if(options.historyAutosave)await writeFile(f.historyPcbPath,generated.stagedSource,'utf8');
    if(options.stageSourceDrift!==undefined){
      const changedPath=options.stageSourceDrift==='schematic'?f.project.schematicPath:options.stageSourceDrift==='project'?path.join(f.project.projectPath,`${f.project.name}.kicad_pro`):f.project.rulesPath;
      const changedSource=(await readFile(changedPath,'utf8'))+'\n';await writeFile(changedPath,changedSource,'utf8');f.stageSourceMutations.push({path:changedPath,source:changedSource});
    }
    return generated.receipt as KicadPlaneStageReceipt;
  });
  const context={connectivityIdentity:createFreshConnectivityContract(f.bundle.contract).identity,projectBindingIdentity:f.project.planeBinding.identity,sourceContractIdentity:f.bundle.contract.identity};
  return {...f,context,generated:()=>generated!};
}

describe('genuine plane APPLY capability and recovery lifecycle',()=>{
  it('keeps true NC plane staging unsaved across a PCB history autosave and captures fresh native evidence only after Save',async()=>{
    const f=await validFixture({noConnect:true,historyAutosave:true,forbidDirtyNetlist:true});
    expect(createFreshConnectivityContract(f.bundle.contract).noConnects).toEqual([{reference:'J1',pin:'4'}]);
    expect(f.beforePcbSource).toContain(`(net "${nativeNoConnectName}")`);
    expect(await readFile(f.historyPcbPath,'utf8')).toBe(f.beforePcbSource);
    const markerBefore=await readFile(f.project.markerPath,'utf8');
    const applied=await f.bridge.execute(apply);
    expect(applied.isError).not.toBe(true);expect(planeCompoundMutationState(apply,applied,f.context)).toBe(true);
    expect(JSON.parse(applied.content)).toMatchObject({operation:'create',applied:true,mutated:true,nativeActionsPerformed:true,nativeSaveCalledByStage:false});
    // Keep the real helper's complete RPC receipt and native fill epoch proof.
    expect(f.generated().receipt).toMatchObject({complete:true,nativeSaveCalled:false,savedSourceBefore:f.beforePcbSource,savedSourceStaged:f.beforePcbSource});
    expect(f.generated().receipt.nativeSourceStaged).toBe(f.generated().stagedSource);
    expect(f.generated().stagedSource).not.toBe(f.beforePcbSource);
    expect(f.dirty()).toBe(true);expect(f.live()).toBe(f.generated().stagedSource);
    expect(await readFile(f.project.pcbPath,'utf8')).toBe(f.beforePcbSource);
    expect(await readFile(f.historyPcbPath,'utf8')).toBe(f.generated().stagedSource);
    expect(await readFile(f.project.markerPath,'utf8')).toBe(markerBefore);
    expect(f.calls).toEqual(['stage']);expect(f.netlistExports.length).toBeGreaterThan(0);
    expect(f.netlistExports.every(entry=>!entry.dirty&&entry.saveCount===0)).toBe(true);
    const exportsBeforeSave=f.netlistExports.length,readsBeforeSave=f.nativeReads();
    const saved=await f.bridge.internal.saveAfterMutation(save);
    expect(saved.isError).not.toBe(true);expect(saved.content).toContain('plane-native-saved-and-source-verified');
    expect(f.calls).toEqual(['stage','pcb_save']);expect(f.dirty()).toBe(false);
    expect(f.netlistExports.length).toBeGreaterThan(exportsBeforeSave);
    expect(f.netlistExports.slice(exportsBeforeSave).every(entry=>!entry.dirty&&entry.saveCount>0)).toBe(true);
    expect(f.nativeReads()).toBeGreaterThan(readsBeforeSave);
    expect(await readFile(f.project.pcbPath,'utf8')).toBe(f.generated().stagedSource);
  });
  it.each(['schematic','project','rules'] as const)('rejects %s drift during a true NC native plane stage despite unrelated PCB history activity',async stageSourceDrift=>{
    const f=await validFixture({noConnect:true,historyAutosave:true,forbidDirtyNetlist:true,stageSourceDrift});
    const failed=await f.bridge.execute(apply);
    expect(failed.isError).toBe(true);
    const result=JSON.parse(failed.content);
    expect(result).toMatchObject({schemaVersion:'evleda.fresh-plane-apply-failure.v1',recoveryRequired:true,editingSessionMustClose:true});
    expect(result.message).toMatch(/source|scope|schematic|project|rules|changed|drift/iu);
    expect(failed.content).not.toContain('Fixture forbids native netlist export');
    expect(f.generated().receipt).toMatchObject({complete:true,nativeSaveCalled:false,savedSourceStaged:f.beforePcbSource});
    expect(f.stageSourceMutations).toHaveLength(1);
    expect(await readFile(f.stageSourceMutations[0]!.path,'utf8')).toBe(f.stageSourceMutations[0]!.source);
    expect(await readFile(f.project.pcbPath,'utf8')).toBe(f.beforePcbSource);
    expect(await readFile(f.historyPcbPath,'utf8')).toBe(f.generated().stagedSource);
    expect(f.calls).toContain('stage');expect(f.calls).not.toContain('pcb_save');
    expect(f.netlistExports.every(entry=>!entry.dirty)).toBe(true);
  });
  it('keeps a compatible transaction-only plane session usable without exposing APPLY',async()=>{
    const f=await fixture('missing');expect(f.bridge.tools.some(t=>t.name==='fresh_apply_contract_plane')).toBe(false);
    expect(f.bridge.tools.some(t=>t.name==='fresh_replace_route_items')).toBe(true);
    await expect(f.bridge.execute(apply)).rejects.toThrow(/Unsupported/);expect(f.calls).toEqual([]);
  });
  it('accepts no arbitrary model geometry, settings, UUID or unknown plane choice',async()=>{
    const f=await fixture();for(const argumentsValue of [{planeId:'UNKNOWN'},{rectangleNm:{}},{zoneId:uuid(3)},{clearance:0.1}])await expect(f.bridge.execute({...apply,arguments:argumentsValue})).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
  it.each(['partial','transport'] as const)('settles a same-bytes dirty %s stage using guarded native revert, never no-op clearance',async mode=>{
    const f=await fixture(mode);const failed=await f.bridge.execute(apply);
    expect(failed.isError).toBe(true);expect(JSON.parse(failed.content)).toMatchObject({schemaVersion:'evleda.fresh-plane-apply-failure.v1',recoveryRequired:true,rollback:'restored-known-preimage',editingSessionMustClose:true});
    expect(f.calls).toEqual(['stage','pcb_revert']);expect(f.dirty()).toBe(false);expect(await readFile(f.project.pcbPath,'utf8')).toBe(pcb);
    expect((await f.bridge.internal.saveAfterMutation(save)).isError).toBe(true);expect(f.calls).not.toContain('pcb_save');
  });
  it('preserves unknown partial native changes without save or blind revert',async()=>{
    const f=await fixture('unknown');const failed=await f.bridge.execute(apply);
    expect(failed.isError).toBe(true);expect(JSON.parse(failed.content).rollback).toBe('not-attempted-unknown-or-external-state');
    expect(f.live()).toContain('(thickness 1.7)');expect(f.dirty()).toBe(true);expect(f.calls).toEqual(['stage']);expect(await readFile(f.project.pcbPath,'utf8')).toBe(pcb);
    expect((await f.bridge.internal.saveAfterMutation(save)).isError).toBe(true);expect(f.calls).not.toContain('pcb_save');
    await expect(f.bridge.execute({id:'read',name:'pcb_get_footprints',arguments:{}})).resolves.toMatchObject({toolCallId:'read'});
  });
  it('feeds real CREATE/UPDATE receipts through actual validation, consumer and mandatory save including unchanged bytes',async()=>{
    const f=await validFixture();const created=await f.bridge.execute(apply);
    expect(created.isError).not.toBe(true);expect(planeCompoundMutationState(apply,created,f.context)).toBe(true);
    expect(JSON.parse(created.content)).toMatchObject({schemaVersion:'evleda.fresh-plane-apply-result.v1',operation:'create',nativeActionsPerformed:true,nativeSaveCalledByStage:false,sourceChanged:true,acceptanceEvaluated:false});
    expect(await readFile(f.project.pcbPath,'utf8')).toBe(pcb);expect(f.dirty()).toBe(true);
    expect(await f.bridge.internal.classifyPendingMutationBatch?.()).toBeUndefined();
    expect(await f.bridge.internal.saveAfterMutation(save)).toMatchObject({toolCallId:'save',content:expect.stringContaining('plane-native-saved-and-source-verified')});
    expect(f.dirty()).toBe(false);const saved=await readFile(f.project.pcbPath,'utf8');expect(saved).toBe(f.generated().stagedSource);
    const updated=await f.bridge.execute({...apply,id:'update'});expect(updated.isError).not.toBe(true);
    expect(JSON.parse(updated.content)).toMatchObject({operation:'update',sourceChanged:false,applied:true,mutated:true,idempotent:false,nativeActionsPerformed:true});
    expect(f.dirty()).toBe(true);expect(await f.bridge.internal.classifyPendingMutationBatch?.()).toBeUndefined();
    expect(planeCompoundMutationState({...apply,id:'update'},updated,f.context)).toBe(true);
    expect((await f.bridge.internal.saveAfterMutation({...save,id:'update-save'})).isError).not.toBe(true);
    expect(f.calls.filter(name=>name==='pcb_save')).toHaveLength(2);expect(f.dirty()).toBe(false);
    expect(await readFile(f.project.pcbPath,'utf8')).toBe(saved);expect(f.bridge.freshBoardSaveAudits).toHaveLength(0);
  });
  it('preserves external staged-live drift before save without calling save or revert',async()=>{
    const f=await validFixture();expect((await f.bridge.execute(apply)).isError).not.toBe(true);
    const external=f.live().replace('(thickness 1.6)','(thickness 1.7)');f.setLive(external);
    const failure=await f.bridge.internal.saveAfterMutation(save);expect(failure.isError).toBe(true);
    expect(JSON.parse(failure.content).rollback).toBe('not-attempted-unknown-or-external-state');
    expect(f.calls).toEqual(['stage']);expect(f.live()).toBe(external);expect(await readFile(f.project.pcbPath,'utf8')).toBe(pcb);
  });
  it('does not overwrite unknown disk/live state introduced during native save',async()=>{
    const f=await validFixture();await f.bridge.execute(apply);const base=f.session.callTool;
    f.session.callTool=async(name,args)=>{if(name==='pcb_save')f.setLive(f.live().replace('(thickness 1.6)','(thickness 1.7)'));return await base(name,args);};
    const failed=await f.bridge.internal.saveAfterMutation(save);expect(failed.isError).toBe(true);
    expect(f.calls).toEqual(['stage','pcb_save']);expect(await readFile(f.project.pcbPath,'utf8')).toContain('(thickness 1.7)');expect(f.live()).toContain('(thickness 1.7)');
  });
  it('uses only the accepted live stage for bounded persistence when native save leaves the preimage',async()=>{
    const f=await validFixture();await f.bridge.execute(apply);const base=f.session.callTool;
    f.session.callTool=async(name,args)=>{if(name==='pcb_save'){f.calls.push(name);return {content:[],structuredContent:{result:'Board saved.'}};}return await base(name,args);};
    expect((await f.bridge.internal.saveAfterMutation(save)).isError).not.toBe(true);
    expect(f.calls).toContain('pcb_save');expect(f.bridge.freshBoardSaveAudits).toHaveLength(1);expect(await readFile(f.project.pcbPath,'utf8')).toBe(f.generated().stagedSource);
  });
  it('guards rollback after a failed post-save full native physical recapture',async()=>{
    const f=await validFixture();await f.bridge.execute(apply);f.session.readLivePcbPadSnapshot=async()=>({isError:true,content:[{type:'text',text:'native capture failed'}]});
    const failed=await f.bridge.internal.saveAfterMutation(save);expect(failed.isError).toBe(true);
    expect(JSON.parse(failed.content).rollback).toBe('restored-known-preimage');expect(f.calls).toEqual(['stage','pcb_save','pcb_revert']);expect(await readFile(f.project.pcbPath,'utf8')).toBe(pcb);
  });
  it('rejects corrupted actual epoch proof without saving or assuming the unknown stage is safe to revert',async()=>{
    const f=await validFixture();const stage=f.session.stagePlane!;
    f.session.stagePlane=async request=>{const receipt=await stage(request);(receipt.epoch as Record<string,unknown>).filledObserved=false;return receipt;};
    const failed=await f.bridge.execute(apply);expect(failed.isError).toBe(true);
    expect(JSON.parse(failed.content).rollback).toBe('not-attempted-unknown-or-external-state');expect(f.calls).toEqual(['stage']);expect(f.dirty()).toBe(true);
  });
  it('rechecks quarantine when a second APPLY was queued before the first failed',async()=>{
    const f=await fixture('partial');
    const results=await Promise.allSettled([f.bridge.execute(apply),f.bridge.execute({...apply,id:'queued-apply'})]);
    expect(results[0]).toMatchObject({status:'fulfilled',value:{isError:true}});
    expect(results[1]).toMatchObject({status:'rejected',reason:expect.objectContaining({message:expect.stringContaining('RECOVERY_REQUIRED')})});
    expect(f.calls).toEqual(['stage','pcb_revert']);expect(f.dirty()).toBe(false);
  });
  it('rechecks mandatory save order when a second APPLY was already queued',async()=>{
    const f=await validFixture();
    const [first,second]=await Promise.all([f.bridge.execute(apply),f.bridge.execute({...apply,id:'queued-apply'})]);
    expect(first.isError).not.toBe(true);expect(second).toMatchObject({toolCallId:'queued-apply',isError:true});
    expect(JSON.parse(second.content)).toMatchObject({stage:'queued-save-order',rollback:'restored-known-preimage'});
    expect(f.calls).toEqual(['stage','pcb_revert']);expect(await readFile(f.project.pcbPath,'utf8')).toBe(pcb);
  });
  it('prevents an already queued ordinary mutation from escaping a failed-stage quarantine',async()=>{
    const f=await fixture('partial');
    const results=await Promise.allSettled([f.bridge.execute(apply),f.bridge.execute({id:'queued-move',name:'pcb_move_footprint',arguments:{reference:'J1',x_mm:5,y_mm:10}})]);
    expect(results[1]).toMatchObject({status:'rejected',reason:expect.objectContaining({message:expect.stringContaining('RECOVERY_REQUIRED')})});
    expect(f.calls).toEqual(['stage','pcb_revert']);
  });
  it('does not let an early queued save use the legacy save path for a newly staged plane',async()=>{
    const f=await validFixture();
    const [first,earlySave]=await Promise.all([f.bridge.execute(apply),f.bridge.internal.saveAfterMutation(save)]);
    expect(first.isError).not.toBe(true);expect(earlySave.isError).toBe(true);expect(f.calls).toEqual(['stage','pcb_revert']);
  });
  it.each(['Board not saved.','Save skipped.','ok'])('rejects ambiguous/no-save acknowledgement on source-equivalent UPDATE: %s',async acknowledgement=>{
    const f=await validFixture();await f.bridge.execute(apply);await f.bridge.internal.saveAfterMutation(save);
    const update=await f.bridge.execute({...apply,id:'update'});expect(JSON.parse(update.content).sourceChanged).toBe(false);expect(f.dirty()).toBe(true);
    const base=f.session.callTool;f.session.callTool=async(name,args)=>{if(name==='pcb_save'){f.calls.push(name);return {content:[],structuredContent:{result:acknowledgement}};}return await base(name,args);};
    const failed=await f.bridge.internal.saveAfterMutation({...save,id:'update-save'});expect(failed.isError).toBe(true);
    expect(JSON.parse(failed.content).message).toContain('qualified positive');expect(f.calls.at(-1)).toBe('pcb_revert');expect(f.dirty()).toBe(false);
  });
  it('retains same-source dirty recovery when native revert returns unsupported prose',async()=>{
    const f=await fixture('partial');f.session.callTool=async name=>{f.calls.push(name);return {content:[],structuredContent:{result:'Revert is not supported by the current KiCad IPC version. Please save and reload the board manually.'}};};
    const failed=await f.bridge.execute(apply);expect(failed.isError).toBe(true);
    expect(JSON.parse(failed.content)).toMatchObject({rollback:'guarded-recovery-failed-state-preserved',recoveryRequired:true});expect(f.dirty()).toBe(true);
    expect((await f.bridge.internal.saveAfterMutation(save)).isError).toBe(true);expect(f.calls).toEqual(['stage','pcb_revert']);
  });
});
