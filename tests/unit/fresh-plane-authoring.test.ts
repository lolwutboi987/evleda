import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createKicadToolboxMcpServer } from "../../src/mcp/toolbox-server.js";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle, createPcbPlaneCompilationBundleRef } from "../../src/harness/pcb-design-plane-bundle.js";
import { preparePlaneFreshProject, type PlaneFreshProject } from "../../src/harness/fresh-project.js";
import { createFreshConnectivityContract } from "../../src/harness/fresh-connectivity-contract.js";
import { createKicadHarnessTools, KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES, type KicadHarnessSession, type KicadHarnessToolsOptions } from "../../src/harness/kicad-tools.js";
import { genericDividerLibraryResolver, createGenericDividerBundleFixture } from "../helpers/generic-divider-bundle.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";
import { nativePadObservationFixture } from "../helpers/native-pad-observation-fixture.js";
import { normalizeFakeSchematicWriterSource } from "../helpers/normalizing-schematic-writer.js";
import { parseFreshPcbSource, parseFreshSchematicSource } from "../../src/harness/fresh-kicad-parser.js";
import { planeCompoundMutationState } from "../../src/mcp/toolbox-plane-results.js";
import { usbChannelBundle } from "../helpers/usb-channel-bundle.js";
import { usbChannelPcb, usbChannelSourceId } from "../helpers/usb-channel-source.js";
import { routeMmToNativeNm } from "../../src/harness/fresh-route-native-units.js";
import { planFreshFootprintFields } from "../../src/harness/fresh-footprint-field.js";
import { planFreshFootprintPoses } from "../../src/harness/fresh-footprint-pose-batch.js";

// Offline source/native-port simulation only. No plane, route, or native KiCad qualification is asserted.
const roots=new Set<string>();
afterEach(async()=>{for(const root of roots){await rm(root,{recursive:true,force:true});roots.delete(root);}});
const dependencies={libraryResolver:genericDividerLibraryResolver,deepRuleCatalog:loadDeepRuleCatalog()};
function bundle(prompt="Genuine V2 authoring fixture with GND plane intent."){
  const compilation=compilePcbPlaneDesignIntentDraft(planeDividerDraft(),dependencies);
  if(compilation.disposition!=="ready")throw new Error(JSON.stringify(compilation.issues));
  return createPcbPlaneCompilationBundle({originalPrompt:prompt,compilation},dependencies);
}
const header='(kicad_pcb (version 20260206) (generator "pcbnew") (generator_version "10.0") (general (thickness 1.6)) (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user)) (gr_rect (start 0 0) (end 30 20) (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts"))';
const empty=header+'\n)';
const fixtureUuid=(index:number)=>`aaaaaaaa-aaaa-aaaa-aaaa-${String(index).padStart(12,'0')}`;
const fp=(reference:string,libraryId:string,value:string,x:number,y:number,nets:readonly string[])=>{const index=reference==='J1'?1:reference==='R1'?2:3;return `(footprint "${libraryId}" (uuid "${fixtureUuid(index)}") (layer "F.Cu") (at ${x} ${y} 0) (property "Reference" "${reference}") (property "Value" "${value}") ${nets.map((net,i)=>`(pad "${i+1}" smd rect (uuid "${fixtureUuid(index*100+i)}") (at ${i*2} 0) (size 1 1) (layers "F.Cu") (net "${net}"))`).join(' ')})`;};
const pcb=header+fp('J1','Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical','DIVIDER_IO',5,10,['VIN','VOUT','GND'])+fp('R1','Resistor_SMD:R_0603_1608Metric','10k',15,8,['VIN','VOUT'])+fp('R2','Resistor_SMD:R_0603_1608Metric','10k',15,14,['VOUT','GND'])+')';
const netlist=(b:ReturnType<typeof bundle>,omitGround=false)=>`(export (design (source "plane.kicad_sch") (date "2026-09-10T10:00:00")) (components ${b.contract.components.map(c=>{const [lib,part]=c.symbolLibId.split(':');return `(comp (ref "${c.reference}") (value "${c.value}") (footprint "${c.footprintLibId}") (libsource (lib "${lib}") (part "${part}")))`;}).join(' ')}) (nets ${b.contract.nets.filter(net=>!omitGround||net.name!=='GND').map((net,i)=>`(net (code "${i+1}") (name "${net.name}") ${net.endpoints.map(e=>`(node (ref "${e.reference}") (pin "${e.pin}") (pintype "passive"))`).join(' ')})`).join(' ')}))`;
const schematic=(b:ReturnType<typeof bundle>)=>`(kicad_sch (version 20250316) (lib_symbols) ${b.contract.nets.map((net,i)=>`(global_label "${net.name}" (shape passive) (at ${10+i*5} 10 0))`).join(' ')} ${b.contract.components.map(c=>`(symbol (lib_id "${c.symbolLibId}") (at 20 20 0) (unit 1) (property "Reference" "${c.reference}" (at 20 18 0) (effects (font (size 1.27 1.27)))) (property "Value" "${c.value}" (at 20 22 0) (effects (font (size 1.27 1.27)))) (property "Footprint" "${c.footprintLibId}"))`).join(' ')})`;
const syncText=['Schematic components considered: 3','New footprints added: 3','Mismatched footprints replaced: 0','Total pads considered: 7','Pads with named nets: 7','Pads left as <no net>: 0','Transfer quality: CLEAN (100.0% pad coverage)','Fully net-mapped refs: 3','Partially net-mapped refs: 0','Refs with unresolved pad nets: (none)','The PCB file was updated and KiCad was asked to reload it.'].join('\n');

async function fixture(options:{initial?:string;physicalSource?:string;compilationBundle?:ReturnType<typeof bundle>;widthReadbackOffsetNm?:number;routeReadbackOffsetNm?:number;omitGround?:boolean;tamperMarkerOnCall?:boolean;tamperMarkerOnPhysicalRead?:boolean;nativeFailureOnSave?:boolean;nativeParityFailureOnSave?:boolean;saveChangesPad?:boolean;nativeDisconnectedOnSave?:boolean;wrongRouteWidth?:boolean;changeUnrelatedOnPush?:boolean;reassignViaNetAt?:'push'|'save'}={}){
  const b=options.compilationBundle??bundle(),root=await mkdtemp(path.join(os.tmpdir(),'evleda-plane-authoring-'));roots.add(root);
  const project=await preparePlaneFreshProject({outputDir:path.join(root,'output'),name:'plane',resume:false,compilationBundle:b,compilationBundleRef:createPcbPlaneCompilationBundleRef(b)});
  let live=options.initial??empty,physicalReads=0,saveCount=0,routeOrdinal=0,transaction=live;const calls:string[]=[];
  await writeFile(project.pcbPath,live,'utf8');await writeFile(project.schematicPath,schematic(b),'utf8');
  const physicalBaseline=options.physicalSource??pcb;
  const physical=await nativePadObservationFixture(physicalBaseline);
  const nativeCoordinate=(value:unknown,deltaNm=0)=>(Math.trunc(Number(value)*1e6)+deltaNm)/1e6;
  const viaNetFaults:Array<{before:string;after:string;viaId:string}>=[];
  const reassignViaNet=()=>{
    const vias=parseFreshPcbSource(live).vias;
    if(vias.length!==1||vias[0]!.id===null||vias[0]!.netName!=='GND')throw new Error('Via-net fault requires exactly one admitted GND via.');
    const viaId=vias[0]!.id,before=live;
    // Boundary-response fault only: retain the exact UUID and all geometry.
    // This does not simulate pcbnew's connectivity-based net propagation.
    live=live.replace(`(net "GND") (uuid "${viaId}")`,`(net "VIN") (uuid "${viaId}")`);
    if(live===before)throw new Error('Via-net fault did not match the exact fixture via.');
    viaNetFaults.push({before,after:live,viaId});
  };
  const session:KicadHarnessSession={
    supportsNativeRouteTransactions:()=>true,
    supportsQualifiedFootprintIdentitySync:()=>true,
    listTools:()=>KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES.map(name=>({name,permission:'write' as const,description:name,inputSchema:{type:'object',additionalProperties:true}})),
    assertActivePcb:async expected=>{if(expected!==project.pcbPath)throw new Error('wrong PCB');},readActivePcbSource:async()=>live,
    readLivePcbPadSnapshot:async ids=>{
      physicalReads++;const captured=await nativePadObservationFixture(live,physicalBaseline);const payload=structuredClone(captured.observation.rawSnapshot) as Record<string,any>;
      const document={type:'DOCTYPE_PCB',board_filename:path.basename(project.pcbPath),project:{name:project.name,path:path.dirname(project.pcbPath)}};
      payload.documentBefore=document;payload.documentAfter=document;payload.enabledLayers.request.board=document;payload.footprintInventory.request.header.document=document;payload.padstackPresence.request.board=document;
      const byId=new Map<string,any>(payload.connectivity.map((query:any)=>[query.sourcePrimitiveId,query]));
      payload.connectivity=ids.map(id=>{const query=structuredClone(byId.get(id));query.request.header.document=document;if(saveCount>0&&options.nativeDisconnectedOnSave)query.padRecordIndexes=query.padRecordIndexes.filter((index:number)=>payload.padRecords[index].id.value===id);return query;});
      if(saveCount>0&&options.nativeFailureOnSave)payload.boardSourceAfter+='\n';
      if(options.tamperMarkerOnPhysicalRead)await writeFile(project.markerPath,(await readFile(project.markerPath,'utf8'))+'\n','utf8');
      return {isError:false,content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:payload};
    },
    callTool:async(name,args={})=>{
      calls.push(name);let result='ok';
      if(name==='pcb_sync_from_schematic'){live=pcb;await writeFile(project.pcbPath,live,'utf8');result=syncText;}
      if(name==='pcb_begin_commit'){transaction=live;result='Transaction group started. Use pcb_push_commit to apply or pcb_drop_commit to discard.';}
      if(name==='pcb_drop_commit'){live=transaction;result='Transaction group discarded successfully.';}
      if(name==='pcb_push_commit')result='Transaction group committed successfully.';
      if(name==='pcb_delete_items')live=live.split(/(?<=\n)/u).filter(line=>!(args.item_ids as string[]).some(id=>line.includes(`(uuid "${id}")`))).join('');
      if(name==='pcb_add_track')live=live.slice(0,live.lastIndexOf(')'))+`\n(segment (start ${nativeCoordinate(args.x1_mm,options.routeReadbackOffsetNm)} ${nativeCoordinate(args.y1_mm)}) (end ${nativeCoordinate(args.x2_mm)} ${nativeCoordinate(args.y2_mm)}) (width ${options.wrongRouteWidth?0.1:(routeMmToNativeNm(Number(args.width_mm))+(options.widthReadbackOffsetNm??0))/1e6}) (layer "${String(args.layer).replace('_','.')}") (net "${args.net_name}") (uuid "${fixtureUuid(1000+ ++routeOrdinal)}"))\n)`;
      if(name==='pcb_add_via')live=live.slice(0,live.lastIndexOf(')'))+`\n(via (at ${nativeCoordinate(args.x_mm)} ${nativeCoordinate(args.y_mm)}) (size ${args.diameter_mm}) (drill ${args.drill_mm}) (layers "F.Cu" "B.Cu") (net "${args.net_name}") (uuid "${fixtureUuid(1000+ ++routeOrdinal)}"))\n)`;
      if(name==='pcb_push_commit'&&options.changeUnrelatedOnPush)live=live.replace('(thickness 1.6)','(thickness 1.7)');
      if(name==='pcb_push_commit'&&options.reassignViaNetAt==='push')reassignViaNet();
      if(name==='pcb_save'){saveCount++;if(options.saveChangesPad)live=live.replace('(size 1 1)','(size 1.1 1)');if(options.reassignViaNetAt==='save')reassignViaNet();await writeFile(project.pcbPath,live,'utf8');result='Board saved.';}
      if(name==='pcb_revert'){live=await readFile(project.pcbPath,'utf8');result='Board reverted to last saved state. All unsaved changes have been discarded.';}
      if(name==='sch_get_symbols')result='Symbols (0 total):';
      if(name==='sch_modify_property')await writeFile(project.schematicPath,(await readFile(project.schematicPath,'utf8')).replace('(at 20 18 0)','(at 21 18 0)'),'utf8');
      if(name==='sch_move_symbol')await writeFile(project.schematicPath,(await readFile(project.schematicPath,'utf8')).replace('(at 20 20 0)',`(at ${args.x_mm} ${args.y_mm} 0)`),'utf8');
      if(options.tamperMarkerOnCall)await writeFile(project.markerPath,(await readFile(project.markerPath,'utf8'))+'\n','utf8');
      return {content:[],structuredContent:{result}};
    },
  };
  const toolOptions:KicadHarnessToolsOptions={freshProject:project,freshConnectivityContract:b.contract,freshPlaneCompilationBundle:b,
    freshPhysicalFootprintResolver:physical.expected.physicalFootprintResolver!,freshPhysicalFootprintSourcePins:physical.expected.physicalFootprints!,
    captureFreshNativeNetlist:async()=>netlist(b,options.omitGround||saveCount>0&&options.nativeParityFailureOnSave),capturePersistedMutationBaseline:async()=>contentIdentity(await readFile(project.pcbPath)).digest,
    verifyPersistedMutation:async baseline=>baseline!==contentIdentity(await readFile(project.pcbPath)).digest};
  const bridge=createKicadHarnessTools(session,toolOptions);
  return {bundle:b,project,session,toolOptions,bridge,calls,viaNetFaults,physicalReads:()=>physicalReads,replaceOwnedSource:async(source:string)=>{live=source;await writeFile(project.pcbPath,source,'utf8');}};
}

describe('bounded V2 whole-board route inventory', () => {
  const routedBoard = (tracks: number, vias = 0) => pcb.slice(0, -1)
    + Array.from({ length: tracks }, (_, index) => `\n(segment (start 1 ${(1 + index / 100).toFixed(2)}) (end 1.05 ${(1 + index / 100).toFixed(2)}) (width 0.5) (layer "F.Cu") (net "GND") (uuid "${fixtureUuid(20000 + index)}"))`).join('')
    + Array.from({ length: vias }, (_, index) => `\n(via (at ${(20 + index % 10 / 10).toFixed(1)} ${(2 + Math.floor(index / 10) / 10).toFixed(1)}) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "GND") (uuid "${fixtureUuid(30000 + index)}"))`).join('') + '\n)';

  it('reads and incrementally saves more than 96 retained routes without changing small reply shape', async () => {
    const f = await fixture({ initial: routedBoard(107) });
    const selection = JSON.parse((await f.bridge.execute({ id: 'large-read', name: 'fresh_get_route_items', arguments: {} })).content);
    expect(selection.schemaVersion).toBe('evleda.fresh-plane-route-selection.v1');
    expect(selection.items).toHaveLength(107); expect(selection.pagination).toBeUndefined();
    const call = { id: 'large-append', name: 'fresh_replace_route_items' as const, arguments: { selectionIdentity: selection.identity,
      net: 'GND', deleteItemIds: [], tracks: [{ x1Mm: 2, y1Mm: 1, x2Mm: 3, y2Mm: 1, layer: 'F.Cu' }], vias: [] } };
    expect(JSON.parse((await f.bridge.execute(call)).content)).toMatchObject({ mutationValidity: 'verified', addedTrackCount: 1, completion: 'not_evaluated' });
    expect((await f.bridge.internal.saveAfterMutation({ id: 'large-save', name: 'pcb_save', arguments: {} })).isError).not.toBe(true);
    const next = JSON.parse((await f.bridge.execute({ id: 'large-next', name: 'fresh_get_route_items', arguments: {} })).content);
    expect(next.items).toHaveLength(108); expect(next.identity).not.toEqual(selection.identity);
    expect(next.items.filter((item: any) => selection.items.some((before: any) => before.id === item.id))).toEqual(selection.items);
  });

  it('pages all 1280 exact items under 32k while retaining one independently reproducible full selection identity', async () => {
    const f = await fixture({ initial: routedBoard(1024, 256) });
    let result = await f.bridge.execute({ id: 'capacity-read', name: 'fresh_get_route_items', arguments: {} });
    const first = JSON.parse(result.content), gathered: any[] = [];
    expect(first).toMatchObject({ schemaVersion: 'evleda.fresh-plane-route-selection-page.v1',
      selectionSchemaVersion: 'evleda.fresh-plane-route-selection.v1', pagination: { offset: 0, totalItemCount: 1280, returnedItemCount: 32, completeInventoryReturned: false } });
    for (let pageIndex = 0; pageIndex < 40; pageIndex++) {
      expect(result.content.length).toBeLessThanOrEqual(32000);
      const page = JSON.parse(result.content), { pageIdentity, ...pagePayload } = page;
      expect(pageIdentity).toEqual(canonicalIdentity(pagePayload, page.schemaVersion));
      expect(page.identity).toEqual(first.identity); expect(page.pcbContentIdentity).toEqual(first.pcbContentIdentity);
      expect(page.pagination.offset).toBe(gathered.length); gathered.push(...page.items);
      if (page.pagination.nextPage === null) { expect(pageIndex).toBe(39); break; }
      result = await f.bridge.execute({ id: `capacity-page-${pageIndex + 1}`, name: 'fresh_get_route_items', arguments: { page: page.pagination.nextPage } });
    }
    expect(gathered).toHaveLength(1280); expect(new Set(gathered.map(item => item.id)).size).toBe(1280);
    expect(gathered.filter(item => item.kind === 'track')).toHaveLength(1024);
    expect(gathered.filter(item => item.kind === 'via')).toHaveLength(256);
    const { pagination: _page, pageIdentity: _pageIdentity, selectionSchemaVersion, schemaVersion: _schema, identity, ...fields } = first;
    expect(identity).toEqual(canonicalIdentity({ ...fields, schemaVersion: selectionSchemaVersion, items: gathered }, selectionSchemaVersion));
    expect(f.calls).not.toContain('pcb_begin_commit');
  }, 20_000);

  it('rejects forged, skipped, replayed and source-drifted continuation pages', async () => {
    const f = await fixture({ initial: routedBoard(256) });
    const first = JSON.parse((await f.bridge.execute({ id: 'page-start', name: 'fresh_get_route_items', arguments: {} })).content);
    const continuation = first.pagination.nextPage;
    await expect(f.bridge.execute({ id: 'page-id-is-not-selection', name: 'fresh_replace_route_items', arguments: {
      selectionIdentity: first.pageIdentity, net: 'GND', deleteItemIds: [], tracks: [{ x1Mm: 2, y1Mm: 1, x2Mm: 3, y2Mm: 1, layer: 'F.Cu' }], vias: [],
    } })).rejects.toThrow();
    for (const page of [{ ...continuation, offset: 64 }, { ...continuation, selectionIdentity: { ...continuation.selectionIdentity, digest: '0'.repeat(64) } }]) {
      await expect(f.bridge.execute({ id: 'bad-page', name: 'fresh_get_route_items', arguments: { page } })).rejects.toThrow(/previous exact selection/);
    }
    await f.bridge.execute({ id: 'page-two', name: 'fresh_get_route_items', arguments: { page: continuation } });
    await expect(f.bridge.execute({ id: 'replayed-page', name: 'fresh_get_route_items', arguments: { page: continuation } })).rejects.toThrow(/previous exact selection/);
    const restart = JSON.parse((await f.bridge.execute({ id: 'restart', name: 'fresh_get_route_items', arguments: {} })).content);
    await f.replaceOwnedSource(routedBoard(256).replace('(thickness 1.6)', '(thickness 1.7)'));
    await expect(f.bridge.execute({ id: 'drifted-page', name: 'fresh_get_route_items', arguments: { page: restart.pagination.nextPage } })).rejects.toThrow(/changed between pages/);
    expect(f.calls).not.toContain('pcb_begin_commit');
  });

  it('uses the complete private selection for a paged mutation and its mandatory save', async () => {
    const f = await fixture({ initial: routedBoard(200) });
    const first = JSON.parse((await f.bridge.execute({ id: 'paged-edit-read', name: 'fresh_get_route_items', arguments: {} })).content);
    const farId = fixtureUuid(20199);
    expect(first.items).toHaveLength(32); expect(first.items.some((item: any) => item.id === farId)).toBe(false);
    const result = JSON.parse((await f.bridge.execute({ id: 'paged-edit', name: 'fresh_replace_route_items', arguments: {
      selectionIdentity: first.identity, net: 'GND', deleteItemIds: [farId],
      tracks: [{ x1Mm: 2, y1Mm: 1, x2Mm: 2.03125, y2Mm: 1, layer: 'F.Cu' }], vias: [],
    } })).content);
    expect(result).toMatchObject({ mutationValidity: 'verified', deletedItemIds: [farId], addedTrackCount: 1 });
    expect((await f.bridge.internal.saveAfterMutation({ id: 'paged-edit-save', name: 'pcb_save', arguments: {} })).isError).not.toBe(true);
    const saved = parseFreshPcbSource(await readFile(f.project.pcbPath, 'utf8'));
    expect(saved.segments).toHaveLength(200); expect(saved.segments.some(track => track.id === farId)).toBe(false);
  });

  it('does not omit invalid retained geometry outside the returned page during mutation checks', async () => {
    const badId = fixtureUuid(20199), source = routedBoard(200).replace(
      `(width 0.5) (layer "F.Cu") (net "GND") (uuid "${badId}")`, `(width 0.1) (layer "F.Cu") (net "GND") (uuid "${badId}")`);
    const f = await fixture({ initial: source });
    const first = JSON.parse((await f.bridge.execute({ id: 'hidden-invalid-read', name: 'fresh_get_route_items', arguments: {} })).content);
    expect(first.items.some((item: any) => item.id === badId)).toBe(false);
    await expect(f.bridge.execute({ id: 'hidden-invalid-edit', name: 'fresh_replace_route_items', arguments: {
      selectionIdentity: first.identity, net: 'GND', deleteItemIds: [fixtureUuid(20000)],
      tracks: [{ x1Mm: 2, y1Mm: 1, x2Mm: 2.03125, y2Mm: 1, layer: 'F.Cu' }], vias: [],
    } })).rejects.toThrow(/width/);
    expect(f.calls).not.toContain('pcb_begin_commit');
  });

  it('retains the per-mutation 128-track, 32-via and 128-deletion limits', async () => {
    const f = await fixture({ initial: pcb });
    const selection = JSON.parse((await f.bridge.execute({ id: 'batch-bound-read', name: 'fresh_get_route_items', arguments: {} })).content);
    const base = { selectionIdentity: selection.identity, net: 'GND', deleteItemIds: [], tracks: [], vias: [] };
    for (const extra of [
      { tracks: Array.from({ length: 129 }, () => ({ x1Mm: 2, y1Mm: 1, x2Mm: 3, y2Mm: 1, layer: 'F.Cu' })) },
      { vias: Array.from({ length: 33 }, () => ({ xMm: 3, yMm: 3 })) },
      { deleteItemIds: Array.from({ length: 129 }, (_, index) => fixtureUuid(20000 + index)) },
    ]) await expect(f.bridge.execute({ id: 'batch-bound-reject', name: 'fresh_replace_route_items', arguments: { ...base, ...extra } })).rejects.toThrow();
    expect(f.calls).not.toContain('pcb_begin_commit');
  });

  it.each([[1025, 0], [0, 257]])('rejects over-capacity readback with %d tracks and %d vias without truncation', async (tracks, vias) => {
    const f = await fixture({ initial: routedBoard(tracks, vias) });
    await expect(f.bridge.execute({ id: 'over-capacity', name: 'fresh_get_route_items', arguments: {} })).rejects.toThrow(/whole-board route inventory exceeds/);
    expect(f.calls).not.toContain('pcb_begin_commit');
  });

  it('rejects a projected 1025th track before starting the native transaction', async () => {
    const f = await fixture({ initial: routedBoard(1024) });
    const first = JSON.parse((await f.bridge.execute({ id: 'full-read', name: 'fresh_get_route_items', arguments: {} })).content);
    await expect(f.bridge.execute({ id: 'overflow-add', name: 'fresh_replace_route_items', arguments: { selectionIdentity: first.identity,
      net: 'GND', deleteItemIds: [], tracks: [{ x1Mm: 2, y1Mm: 1, x2Mm: 3, y2Mm: 1, layer: 'F.Cu' }], vias: [] } })).rejects.toThrow(/whole-board route inventory exceeds/);
    expect(f.calls).not.toContain('pcb_begin_commit');
    expect(await readFile(f.project.pcbPath, 'utf8')).toBe(routedBoard(1024));
  });
});

describe('atomic V2 footprint pose batch', () => {
  const poseSource = () => pcb.replace(/\(property "(Reference|Value)" "([^"]*)"\)/gu, (_match, field: string, text: string) =>
    `(property "${field}" "${text}" (at 0 ${field === 'Reference' ? -2 : 2} 0) (layer "${field === 'Reference' ? 'F.SilkS' : 'F.Fab'}") (effects (font (size 1 1) (thickness 0.15))))`);
  const placements = [{ reference: 'R1', x_mm: 13, y_mm: 7, rotation_deg: 90 }, { reference: 'R2', x_mm: 17, y_mm: 13, rotation_deg: 270 }];
  const edit = { id: 'pose-batch', name: 'fresh_set_footprint_poses' as const, arguments: { placements } };
  const save = { id: 'pose-save', name: 'pcb_save', arguments: {} };

  it('uses one reload/save and four complete physical snapshots for the entire batch, including exact no-op replay', async () => {
    const source = poseSource(), current = await fixture({ initial: source, physicalSource: source });
    expect(current.bridge.tools.find(tool => tool.name === edit.name)).toMatchObject({ inputSchema: { additionalProperties: false,
      properties: { placements: { minItems: 1, maxItems: 64, items: { additionalProperties: false } } } } });
    const planned = planFreshFootprintPoses(source, edit.arguments, current.bundle.contract);
    const result = JSON.parse((await current.bridge.execute(edit)).content);
    expect(result).toMatchObject({ schemaVersion: 'evleda.fresh-footprint-poses-result.v1', applied: true, mutated: true, placementCount: 2, persistence: 'native-save-required' });
    expect(result.placements.map((p: { reference: string }) => p.reference)).toEqual(['R1', 'R2']);
    expect(current.calls.filter(name => name === 'pcb_revert')).toHaveLength(1);
    expect(current.calls).not.toContain('pcb_save'); expect(current.calls).not.toContain('pcb_move_footprint');
    expect(await readFile(current.project.pcbPath, 'utf8')).toBe(planned.source);
    const saved = await current.bridge.internal.saveAfterMutation(save);
    expect(saved.isError).not.toBe(true); expect(JSON.parse(saved.content)).toMatchObject({ status: 'saved-and-native-footprint-poses-verified', placementCount: 2 });
    expect(current.physicalReads()).toBe(4); expect(current.calls.filter(name => name === 'pcb_save')).toHaveLength(1);
    const repeat = JSON.parse((await current.bridge.execute({ ...edit, id: 'pose-repeat' })).content);
    expect(repeat).toMatchObject({ mutated: false, idempotent: true });
    expect((await current.bridge.internal.saveAfterMutation({ ...save, id: 'repeat-save' })).isError).not.toBe(true);
    expect(current.calls.filter(name => name === 'pcb_revert')).toHaveLength(1);
    expect(await readFile(current.project.pcbPath, 'utf8')).toBe(planned.source);
  });

  it('publishes the batch through MCP with one automatic save and no partial publication for invalid arguments', async () => {
    const source = poseSource(), current = await fixture({ initial: source, physicalSource: source });
    const toolbox = createKicadToolboxMcpServer({ access: 'edit', cad: { tools: current.bridge, assertCurrent: async () => {},
      captureSources: async () => contentIdentity(await readFile(current.project.pcbPath)).digest, close: async () => {} } });
    const client = new Client({ name: 'pose-batch-test', version: '1' }), [left, right] = InMemoryTransport.createLinkedPair();
    await toolbox.server.connect(right); await client.connect(left);
    try {
      expect((await client.listTools()).tools.find(tool => tool.name === edit.name)?.annotations).toMatchObject({ readOnlyHint: false });
      const invalid = await client.callTool({ name: edit.name, arguments: { placements: [placements[0]!, { ...placements[1]!, layer: 'B.Cu' }] } });
      expect(invalid.isError).toBe(true); expect(current.calls).toEqual([]);
      const result = await client.callTool({ name: edit.name, arguments: edit.arguments });
      expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
      expect(current.calls.filter(name => ['pcb_revert', 'pcb_save'].includes(name))).toEqual(['pcb_revert', 'pcb_save']);
      expect(current.physicalReads()).toBe(4);
      expect(await readFile(current.project.pcbPath, 'utf8')).toBe(planFreshFootprintPoses(source, edit.arguments, current.bundle.contract).source);
    } finally { await client.close(); await toolbox.close(); }
  });

  it('rejects any invalid member or duplicate before writing a partial batch', async () => {
    const source = poseSource(), current = await fixture({ initial: source, physicalSource: source });
    for (const last of [{ ...placements[1]!, reference: 'H1' }, { ...placements[1]!, reference: 'R1' },
      { ...placements[1]!, x_mm: 30 }, { ...placements[1]!, rotation_deg: 45 }]) {
      await expect(current.bridge.execute({ ...edit, arguments: { placements: [placements[0]!, last] } })).rejects.toThrow();
      expect(current.calls).not.toContain('pcb_revert'); expect(current.calls).not.toContain('pcb_save');
      expect(await readFile(current.project.pcbPath, 'utf8')).toBe(source);
    }
  });

  it.each(['pcb_move_footprint', 'pcb_revert', 'pcb_save'])('requires %s write authority for advertisement and dispatch', async required => {
    const source = poseSource(), current = await fixture({ initial: source, physicalSource: source }), original = current.session.listTools;
    current.session.listTools = () => original().map(tool => tool.name === required ? { ...tool, permission: 'read' as const } : tool);
    expect(createKicadHarnessTools(current.session, current.toolOptions).tools.some(tool => tool.name === edit.name)).toBe(false);
    await expect(current.bridge.execute(edit)).rejects.toThrow(/write authorization/);
    expect(current.calls).not.toContain('pcb_revert'); expect(await readFile(current.project.pcbPath, 'utf8')).toBe(source);
  });

  it('rechecks native move authority after planning and before the single source stage', async () => {
    const source = poseSource(), current = await fixture({ initial: source, physicalSource: source }), original = current.session.listTools;
    current.session.listTools = () => original().map(tool => tool.name === 'pcb_move_footprint' && current.physicalReads() > 0 ? { ...tool, permission: 'read' as const } : tool);
    await expect(current.bridge.execute(edit)).rejects.toThrow(/write authorization/);
    expect(current.calls).not.toContain('pcb_revert'); expect(await readFile(current.project.pcbPath, 'utf8')).toBe(source);
  });

  it('rolls the complete batch back on a negative save and makes the session terminal', async () => {
    const source = poseSource(), current = await fixture({ initial: source, physicalSource: source }), original = current.session.callTool;
    current.session.callTool = async (name, args) => { const result = await original(name, args);
      return name === 'pcb_save' ? { isError: true, content: [{ type: 'text', text: 'synthetic negative save' }] } : result; };
    await current.bridge.execute(edit); const saved = await current.bridge.internal.saveAfterMutation(save);
    expect(saved.isError).toBe(true); expect(saved.content).toContain('ROLLED_BACK_TERMINAL');
    expect(await readFile(current.project.pcbPath, 'utf8')).toBe(source);
    expect(current.calls.filter(name => ['pcb_revert', 'pcb_save'].includes(name))).toEqual(['pcb_revert', 'pcb_save', 'pcb_revert']);
    await expect(current.bridge.execute(edit)).rejects.toThrow(/recovery|close/i);
  });

  it('preserves unknown save drift and reports uncertain rollback instead of publishing a partial success', async () => {
    const source = poseSource(), current = await fixture({ initial: source, physicalSource: source }), original = current.session.callTool;
    let unknown = '';
    current.session.callTool = async (name, args) => { const result = await original(name, args);
      if (name === 'pcb_save') { unknown = (await readFile(current.project.pcbPath, 'utf8')).replace('(thickness 1.6)', '(thickness 1.7)'); await current.replaceOwnedSource(unknown); }
      return result; };
    await current.bridge.execute(edit); const saved = await current.bridge.internal.saveAfterMutation(save);
    expect(saved.isError).toBe(true); expect(saved.content).toContain('ROLLBACK_FAILED_TERMINAL');
    expect(await readFile(current.project.pcbPath, 'utf8')).toBe(unknown);
    expect(current.calls.filter(name => name === 'pcb_revert')).toHaveLength(1);
  });
});

describe('atomic V2 footprint field presentation', () => {
  const fieldSource = () => {
    let index = 0;
    return pcb.replace(/\(property "(Reference|Value)" "([^"]*)"\)/gu, (_match, field: string, text: string) =>
      `(property "${field}" "${text}" (at 0 ${field === 'Reference' ? -2 : 2} 0) (layer "${field === 'Reference' ? 'F.SilkS' : 'F.Fab'}") (uuid "${fixtureUuid(800 + ++index)}") (effects (font (size 1 1) (thickness 0.15))))`);
  };
  const updates = [{ reference: 'R1', field: 'Reference', x_mm: 12, y_mm: 6, rotation_deg: 90, size_mm: .8, thickness_mm: .08 },
    { reference: 'R2', field: 'Reference', visible: false }];
  const edit = { id: 'field-batch', name: 'fresh_set_footprint_fields' as const, arguments: { updates } };
  const save = { id: 'field-save', name: 'pcb_save', arguments: {} };

  it('advertises a closed batch schema and commits all fields through one reload/save with complete physical readback', async () => {
    const source = fieldSource(), current = await fixture({ initial: source, physicalSource: source });
    expect(current.bridge.tools.find(tool => tool.name === edit.name)).toMatchObject({ inputSchema: { additionalProperties: false,
      properties: { updates: { minItems: 1, maxItems: 128 } } } });
    const planned = planFreshFootprintFields(source, edit.arguments);
    const result = JSON.parse((await current.bridge.execute(edit)).content);
    expect(result).toMatchObject({ schemaVersion: 'evleda.fresh-footprint-fields-result.v1', applied: true, mutated: true, updateCount: 2, persistence: 'native-save-required' });
    expect(current.calls.filter(name => name === 'pcb_revert')).toHaveLength(1);
    expect(current.calls).not.toContain('pcb_save');
    expect(await readFile(current.project.pcbPath, 'utf8')).toBe(planned.source);
    const saved = await current.bridge.internal.saveAfterMutation(save);
    expect(saved.isError).not.toBe(true);
    expect(JSON.parse(saved.content)).toMatchObject({ status: 'saved-and-native-footprint-fields-verified', updateCount: 2 });
    expect(current.calls.filter(name => name === 'pcb_save')).toHaveLength(1);
    expect(current.physicalReads()).toBe(4);
    expect(parseFreshPcbSource(await readFile(current.project.pcbPath, 'utf8')).footprints.map(fp => fp.pads))
      .toEqual(parseFreshPcbSource(source).footprints.map(fp => fp.pads));
    const repeat = JSON.parse((await current.bridge.execute({ ...edit, id: 'field-idempotent' })).content);
    expect(repeat).toMatchObject({ mutated: false, idempotent: true });
    expect((await current.bridge.internal.saveAfterMutation({ ...save, id: 'repeat-save' })).isError).not.toBe(true);
    expect(current.calls.filter(name => name === 'pcb_revert')).toHaveLength(1);
  });

  it('validates the complete list and board bounds before any staged source or native write', async () => {
    const source = fieldSource(), current = await fixture({ initial: source, physicalSource: source });
    for (const last of [{ reference: 'ABSENT', field: 'Reference', visible: false }, { reference: 'R2', field: 'Reference', x_mm: 31, y_mm: 6 }]) {
      await expect(current.bridge.execute({ ...edit, arguments: { updates: [updates[0]!, last] } })).rejects.toThrow();
      expect(current.calls).not.toContain('pcb_revert'); expect(current.calls).not.toContain('pcb_save');
      expect(await readFile(current.project.pcbPath, 'utf8')).toBe(source);
    }
  });

  it('rolls the known entire list back on negative native save and refuses later writes', async () => {
    const source = fieldSource(), current = await fixture({ initial: source, physicalSource: source });
    const original = current.session.callTool;
    current.session.callTool = async (name, args) => {
      const result = await original(name, args);
      return name === 'pcb_save' ? { isError: true, content: [{ type: 'text', text: 'synthetic native save failure' }] } : result;
    };
    await current.bridge.execute(edit);
    const saved = await current.bridge.internal.saveAfterMutation(save);
    expect(saved.isError).toBe(true); expect(saved.content).toContain('native-save');
    expect(await readFile(current.project.pcbPath, 'utf8')).toBe(source);
    expect(current.calls.filter(name => ['pcb_revert', 'pcb_save'].includes(name))).toEqual(['pcb_revert', 'pcb_save', 'pcb_revert']);
    const count = current.calls.length;
    await expect(current.bridge.execute(edit)).rejects.toThrow(/recovery|close/i);
    expect(current.calls).toHaveLength(count);
  });

  it('preserves unknown collateral save drift and marks the editing session terminal', async () => {
    const source = fieldSource(), current = await fixture({ initial: source, physicalSource: source });
    const original = current.session.callTool;
    let drift = '';
    current.session.callTool = async (name, args) => {
      const result = await original(name, args);
      if (name === 'pcb_save') { drift = (await readFile(current.project.pcbPath, 'utf8')).replace('(thickness 1.6)', '(thickness 1.7)'); await current.replaceOwnedSource(drift); }
      return result;
    };
    await current.bridge.execute(edit);
    const saved = await current.bridge.internal.saveAfterMutation(save);
    expect(saved.isError).toBe(true); expect(saved.content).toContain('ROLLBACK_FAILED_TERMINAL');
    expect(await readFile(current.project.pcbPath, 'utf8')).toBe(drift);
    expect(current.calls.filter(name => name === 'pcb_revert')).toHaveLength(1);
  });

  it('rechecks native write admission before staging a field batch', async () => {
    const source = fieldSource(), current = await fixture({ initial: source, physicalSource: source });
    const original = current.session.listTools;
    current.session.listTools = () => original().map(tool => tool.name === 'pcb_save' ? { ...tool, permission: 'read' as const } : tool);
    await expect(current.bridge.execute(edit)).rejects.toThrow(/write authorization/);
    expect(current.calls).not.toContain('pcb_revert');
    expect(await readFile(current.project.pcbPath, 'utf8')).toBe(source);
  });

  it('recovers the staged field batch when final host-result source authority fails', async () => {
    const source = fieldSource(), current = await fixture({ initial: source, physicalSource: source });
    const original = current.toolOptions.freshPhysicalFootprintResolver!;
    const changed = '(kicad_sch (sheet))'; let changedOnce = false;
    const bridge = createKicadHarnessTools(current.session, { ...current.toolOptions, freshPhysicalFootprintResolver: {
      inspectFootprint(libraryId) {
        // The second complete native PAD observation has finished. This drift
        // is unrelated to PCB presentation and must survive guarded recovery.
        if (!changedOnce && current.physicalReads() === 2) { changedOnce = true; writeFileSync(current.project.schematicPath, changed, 'utf8'); }
        return original.inspectFootprint(libraryId);
      },
    } });
    await expect(bridge.execute(edit)).rejects.toThrow(/result-authority/);
    expect(bridge.freshFootprintPlacementDiagnostics?.at(-1)?.firstOperation).toBe('result-authority');
    expect(await readFile(current.project.pcbPath, 'utf8')).toBe(source);
    expect(await readFile(current.project.schematicPath, 'utf8')).toBe(changed);
    expect(current.calls.filter(name => name === 'pcb_revert')).toHaveLength(2);
    await expect(bridge.execute(edit)).rejects.toThrow(/recovery|close/i);
  });
});

describe('source-preserving V2 standalone silkscreen text', () => {
  async function textFixture() {
    const current = await fixture({ initial: pcb });
    const list = current.session.listTools, call = current.session.callTool;
    current.session.listTools = () => [...list(), { name: 'pcb_add_text', permission: 'write' as const, inputSchema: { type: 'object' } }];
    current.session.callTool = async (name, args = {}) => {
      if (name !== 'pcb_add_text') return await call(name, args);
      current.calls.push(name);
      const source = await readFile(current.project.pcbPath, 'utf8');
      const text = `(gr_text "${args.text}" (at ${args.x_mm} ${args.y_mm} 0) (layer "F.SilkS") (uuid "${fixtureUuid(9000)}") (effects (font (size ${args.size_mm} ${args.size_mm}) (thickness 0.12)) (justify left bottom)))`;
      await current.replaceOwnedSource(source.slice(0, source.lastIndexOf(')')) + text + '\n)');
      return { content: [], structuredContent: { result: 'Board text added.' } };
    };
    return { ...current, bridge: createKicadHarnessTools(current.session, current.toolOptions) };
  }
  const textCall = { id: 'boot-label', name: 'pcb_add_text' as const, arguments: { text: 'BOOT', x_mm: 2, y_mm: 2, size_mm: .8 } };
  const save = { id: 'boot-label-save', name: 'pcb_save', arguments: {} };

  it('exposes existing one-at-a-time text with V2 bounds, physical verification and mandatory save', async () => {
    const current = await textFixture();
    expect(current.bridge.tools.find(tool => tool.name === 'pcb_add_text')?.description).toContain('V1/V2');
    await current.bridge.execute(textCall);
    expect((await current.bridge.internal.saveAfterMutation(save)).isError).not.toBe(true);
    expect(current.calls.filter(name => name === 'pcb_add_text')).toHaveLength(1);
    expect(current.calls.filter(name => name === 'pcb_save')).toHaveLength(1);
    expect(current.physicalReads()).toBe(2);
  });

  it('refuses an out-of-board text anchor before native insertion', async () => {
    const current = await textFixture();
    await expect(current.bridge.execute({ ...textCall, arguments: { ...textCall.arguments, x_mm: 31 } })).rejects.toThrow(/board bounds/);
    expect(current.calls).not.toContain('pcb_add_text');
    expect(await readFile(current.project.pcbPath, 'utf8')).toBe(pcb);
  });

  it('fences unknown disk/live drift before native save and preserves it during failure recovery', async () => {
    const current = await textFixture();
    await current.bridge.execute(textCall);
    const drift = (await readFile(current.project.pcbPath, 'utf8')).replace('(thickness 1.6)', '(thickness 1.7)');
    await current.replaceOwnedSource(drift);
    const saved = await current.bridge.internal.saveAfterMutation(save);
    expect(saved.isError).toBe(true); expect(saved.content).toContain('ROLLBACK_FAILED_TERMINAL');
    expect(current.calls).not.toContain('pcb_save'); expect(current.calls).not.toContain('pcb_revert');
    expect(await readFile(current.project.pcbPath, 'utf8')).toBe(drift);
    await expect(current.bridge.execute(textCall)).rejects.toThrow(/recovery|close/i);
  });
});

async function completeSchematicFixture(){
  const current=await fixture();
  const baseline=await readFile(new URL('../fixtures/fresh-project/attempt10-post-placement.kicad_sch',import.meta.url),'utf8');
  const oracle=JSON.parse(await readFile(new URL('../fixtures/fresh-project/attempt10-writer-normalization.json',import.meta.url),'utf8')) as {inputPlan:{pins:[string,{x:number;y:number}][];boxes:{reference:string;minX:number;minY:number;maxX:number;maxY:number}[]}};
  await writeFile(current.project.schematicPath,baseline,'utf8');
  const centers:Readonly<Record<string,readonly[number,number]>>={J1:[50.8,50.8],R1:[76.2,50.8],R2:[50.8,152.4]};
  const symbols=current.bundle.contract.components.map(c=>`- ${c.reference} ${c.value} ${c.symbolLibId} @ (${centers[c.reference]![0]}, ${centers[c.reference]![1]}) rot=0 unit=1 footprint=${c.footprintLibId}`).join('\n');
  const boxes=`Schematic bounding boxes (3 symbols):\nRef Value X Y X_min Y_min X_max Y_max\n--------------------\n${oracle.inputPlan.boxes.map(box=>`${box.reference} value ${centers[box.reference]![0]} ${centers[box.reference]![1]} ${box.minX} ${box.minY} ${box.maxX} ${box.maxY}`).join('\n')}\n\nSheet occupied region: X=[40.64, 86.36] Y=[43.18, 160.02] mm`;
  let applied=false;const labels:Record<string,unknown>[]=[];const baseCall=current.session.callTool;
  const addForm=(source:string,form:string)=>normalizeFakeSchematicWriterSource(source.slice(0,source.lastIndexOf(')'))+'\n'+form+'\n)');
  current.session.callTool=async(name,args={})=>{
    let result:string|undefined;
    if(name==='sch_get_symbols')result=symbols;
    if(name==='sch_get_bounding_boxes')result=boxes;
    if(name==='sch_get_pin_positions'){
      const reference=args.symbol_name==='Conn_01x03'?'J1':args.y_mm===152.4?'R2':'R1';
      result=oracle.inputPlan.pins.filter(([id])=>id.startsWith(reference+':')).map(([id,point])=>`- Pin ${id.split(':')[1]}: (${point.x}, ${point.y}) mm`).join('\n');
    }
    if(name==='sch_get_connectivity_graph')result=applied?current.bundle.contract.nets.map((net,i)=>`Group ${i+1}: ${net.name} | pins=${net.endpoints.map(e=>`${e.reference}:${e.pin}`).join(', ')}`).join('\n'):oracle.inputPlan.pins.map(([id],i)=>`Group ${i+1}: ~unnamed | pins=${id}`).join('\n');
    if(['sch_add_wire','sch_add_labels','sch_add_missing_junctions','sch_autoplace_fields'].includes(name)){
      let source=await readFile(current.project.schematicPath,'utf8');
      if(name==='sch_add_wire')source=addForm(source,`(wire (pts (xy ${args.x1_mm} ${args.y1_mm}) (xy ${args.x2_mm} ${args.y2_mm})))`);
      if(name==='sch_add_labels')for(const label of args.labels as Record<string,unknown>[]){labels.push(label);source=addForm(source,`(global_label "${label.name}" (shape ${label.shape}) (at ${label.x_mm} ${label.y_mm} ${label.rotation}) (effects (font (size 1.524 1.524)) (justify ${label.justify})))`);}
      if(name==='sch_add_missing_junctions'){source=normalizeFakeSchematicWriterSource(source);applied=true;}
      if(name==='sch_autoplace_fields')source=source.replace('(at 76.2 54.61 0)','(at 80.01 52.07 0)');
      await writeFile(current.project.schematicPath,source,'utf8');result=name==='sch_autoplace_fields'?'Auto-placed Reference/Value fields on 1 symbol(s): R1.':'ok';
    }
    if(name==='run_erc'){current.calls.push(name);return {content:[],structuredContent:{status:'clean',findings:[],metadata:{violation_count:0}}};}
    if(result!==undefined){current.calls.push(name);return {content:[],structuredContent:{result}};}
    return await baseCall(name,args);
  };
  // The independent fake writer persists each requested schematic edit. Native
  // source/graph checks still execute; this fixture is not native qualification.
  const bridge=createKicadHarnessTools(current.session,{...current.toolOptions,verifyPersistedMutation:async()=>true});
  return {...current,bridge,labels};
}

describe('true plane-project authoring seam',()=>{
  it('uses plane-only bundle authority and exposes guarded authoring without raw route or zone mutation',async()=>{
    const f=await fixture();expect(f.project.workflowKind).toBe('plane');expect(f.project.genericBinding).toBeUndefined();
    const names=f.bridge.tools.map(tool=>tool.name);
    for(const name of ['sch_add_symbol','sch_move_symbol','sch_modify_property','fresh_apply_contract_connectivity','fresh_apply_recommended_schematic_placement','fresh_autoplace_schematic_fields','fresh_sync_from_schematic','fresh_get_contract_pad_positions','fresh_get_route_items','fresh_replace_route_items'])expect(names).toContain(name);
    for(const name of ['pcb_add_track','pcb_add_via','pcb_add_zone']){
      expect(names).not.toContain(name);await expect(f.bridge.execute({id:'denied',name,arguments:{}} as never)).rejects.toThrow(/Plane workflow does not yet support/);
    }
    expect(f.calls).toEqual([]);expect(f.bundle).not.toHaveProperty('practiceProfileBinding');
  });
  it('appends partial GND access plus a via, saves disconnected native groups, and permits deletion-only followup without asserting connectivity',async()=>{
    const f=await fixture({initial:pcb,nativeDisconnectedOnSave:true});
    const selection=JSON.parse((await f.bridge.execute({id:'routes',name:'fresh_get_route_items',arguments:{}})).content);
    expect(selection).toMatchObject({schemaVersion:'evleda.fresh-plane-route-selection.v1',items:[],sourceContractIdentity:f.bundle.contract.identity,connection:'not_evaluated'});
    expect(selection).not.toHaveProperty('genericProjectBindingIdentity');
    const call={id:'append',name:'fresh_replace_route_items' as const,arguments:{selectionIdentity:selection.identity,net:'GND',deleteItemIds:[],tracks:[{x1Mm:9,y1Mm:10,x2Mm:10,y2Mm:10,layer:'F.Cu'},{x1Mm:17,y1Mm:14,x2Mm:18,y2Mm:14,layer:'F.Cu'}],vias:[{xMm:10,yMm:10}]}};
    const output=await f.bridge.execute(call),result=JSON.parse(output.content);
    expect(result).toMatchObject({schemaVersion:'evleda.fresh-plane-route-mutation-result.v1',mutationValidity:'verified',completion:'not_evaluated',connection:'not_evaluated',scope:'selected-net-incremental-route-geometry',addedTrackCount:2,addedViaCount:1});
    expect(result.notEvaluated).toEqual(['plane_contact','clearance','reference_coverage','completed_route_topology']);
    const context={connectivityIdentity:createFreshConnectivityContract(f.bundle.contract).identity,projectBindingIdentity:f.project.planeBinding.identity,sourceContractIdentity:f.bundle.contract.identity};
    expect(planeCompoundMutationState(call,output,context)).toBe(true);
    expect((await f.bridge.internal.saveAfterMutation({id:'save',name:'pcb_save',arguments:{}})).isError).not.toBe(true);
    const next=JSON.parse((await f.bridge.execute({id:'next',name:'fresh_get_route_items',arguments:{}})).content);
    const deletion={id:'delete',name:'fresh_replace_route_items' as const,arguments:{selectionIdentity:next.identity,net:'GND',deleteItemIds:next.items.filter((item:any)=>item.kind==='track').map((item:any)=>item.id),tracks:[],vias:[]}};
    const deleted=await f.bridge.execute(deletion);expect(planeCompoundMutationState(deletion,deleted,context)).toBe(true);
    expect((await f.bridge.internal.saveAfterMutation({id:'save-delete',name:'pcb_save',arguments:{}})).isError).not.toBe(true);
    const remaining=JSON.parse((await f.bridge.execute({id:'remaining',name:'fresh_get_route_items',arguments:{}})).content);
    expect(remaining.items).toHaveLength(1);expect(remaining.items[0].kind).toBe('via');expect(remaining.connection).toBe('not_evaluated');
    expect(f.calls).not.toContain('pcb_add_zone');
  });
  it.each(['wrongRouteWidth','changeUnrelatedOnPush'] as const)('preserves unknown live route state on exact readback violation %s',async flag=>{
    const f=await fixture({initial:pcb,[flag]:true});const selection=JSON.parse((await f.bridge.execute({id:'routes',name:'fresh_get_route_items',arguments:{}})).content);
    await expect(f.bridge.execute({id:'route',name:'fresh_replace_route_items',arguments:{selectionIdentity:selection.identity,net:'GND',deleteItemIds:[],tracks:[{x1Mm:9,y1Mm:10,x2Mm:10,y2Mm:10,layer:'F.Cu'}],vias:[]}})).rejects.toThrow(/ROLLBACK_FAILED_TERMINAL.*primary post-push-source-readback/);
    expect(await readFile(f.project.pcbPath,'utf8')).toBe(pcb);
    expect(f.calls).not.toContain('pcb_revert');
  });
  it.each(['nativeFailureOnSave','saveChangesPad'] as const)('rejects route save and only restores a positively known state for %s',async flag=>{
    const f=await fixture({initial:pcb,[flag]:true});const selection=JSON.parse((await f.bridge.execute({id:'routes',name:'fresh_get_route_items',arguments:{}})).content);
    await f.bridge.execute({id:'route',name:'fresh_replace_route_items',arguments:{selectionIdentity:selection.identity,net:'GND',deleteItemIds:[],tracks:[{x1Mm:9,y1Mm:10,x2Mm:10,y2Mm:10,layer:'F.Cu'}],vias:[]}});
    expect((await f.bridge.internal.saveAfterMutation({id:'save',name:'pcb_save',arguments:{}})).isError).toBe(true);
    if(flag==='nativeFailureOnSave')expect(await readFile(f.project.pcbPath,'utf8')).toBe(pcb);
    else expect(await readFile(f.project.pcbPath,'utf8')).toContain('(size 1.1 1)');
  });
  it.each(['push','save'] as const)('quarantines a via-only net reassignment at %s readback without successful persistence',async phase=>{
    const f=await fixture({initial:pcb,reassignViaNetAt:phase}),quarantined:unknown[]=[];let finished=0;
    f.session.quarantineNativeRouteTransaction=cause=>{quarantined.push(cause);};
    f.session.finishNativeRouteTransaction=()=>{finished++;};
    // Use the authenticated fixture's actual GND access policy; VIN's route
    // disallows this via and is only the unexpected net in the faulty response.
    expect(f.bundle.contract.routingConstraints.nets.find(route=>route.net==='GND')).toMatchObject({topology:'plane',accessRouting:{maxVias:2}});
    expect(f.bundle.contract.routingConstraints.viaPolicy).toMatchObject({mode:'bounded',diameterMm:0.6,drillMm:0.3});
    const selection=JSON.parse((await f.bridge.execute({id:'read-via-net',name:'fresh_get_route_items',arguments:{}})).content);
    const call={id:'route-via-net',name:'fresh_replace_route_items' as const,arguments:{selectionIdentity:selection.identity,net:'GND',deleteItemIds:[],
      tracks:[{x1Mm:9,y1Mm:10,x2Mm:10,y2Mm:10,layer:'F.Cu'}],vias:[{xMm:10,yMm:10}]}};
    if(phase==='push'){
      await expect(f.bridge.execute(call)).rejects.toThrow(/ROLLBACK_FAILED_TERMINAL.*primary post-push-source-readback.*geometry differs/);
      expect(f.calls).not.toContain('pcb_save');
      expect(await readFile(f.project.pcbPath,'utf8')).toBe(pcb);
    }else{
      const staged=await f.bridge.execute(call);
      expect(staged.isError).not.toBe(true);
      expect(JSON.parse(staged.content)).toMatchObject({mutationValidity:'verified',addedViaCount:1});
      expect(parseFreshPcbSource(await f.session.readActivePcbSource!(f.project.pcbPath)).vias[0]!.netName).toBe('GND');
      expect(await readFile(f.project.pcbPath,'utf8')).toBe(pcb);
      const failed=await f.bridge.internal.saveAfterMutation({id:'save-via-net',name:'pcb_save',arguments:{}});
      expect(failed).toMatchObject({isError:true,content:expect.stringMatching(/ROLLBACK_FAILED_TERMINAL.*mandatory-save\/readback.*Mandatory PCB save changed the exact verified physical board source/)});
      expect(f.calls.filter(name=>name==='pcb_save')).toHaveLength(1);
      expect(await readFile(f.project.pcbPath,'utf8')).toBe(f.viaNetFaults[0]!.after);
    }
    expect(f.calls.indexOf('pcb_add_track')).toBeLessThan(f.calls.indexOf('pcb_add_via'));
    expect(f.viaNetFaults).toHaveLength(1);
    const fault=f.viaNetFaults[0]!,before=parseFreshPcbSource(fault.before),after=parseFreshPcbSource(fault.after);
    expect(fault.after).toBe(fault.before.replace(`(net "GND") (uuid "${fault.viaId}")`,`(net "VIN") (uuid "${fault.viaId}")`));
    expect(before.vias).toHaveLength(1);expect(after.vias).toEqual([{...before.vias[0]!,netName:'VIN'}]);
    expect(before.vias[0]).toMatchObject({netName:'GND',at:{x:10,y:10},diameterMm:0.6,drillMm:0.3,layers:['F.Cu','B.Cu']});
    expect(after.segments).toEqual(before.segments);expect(after.footprints).toEqual(before.footprints);
    expect(await f.session.readActivePcbSource!(f.project.pcbPath)).toBe(fault.after);
    expect(quarantined).toHaveLength(1);expect(finished).toBe(0);
    expect(f.bridge.freshRouteMutationDiagnostics!.at(-1)).toMatchObject({phase:'recovery-finished',transactionStarted:true,transactionPushed:true,
      firstOperation:phase==='push'?'post-push-source-readback':'mandatory-save/readback',recovery:'preserved-state-recovery-required'});
    expect(f.calls).not.toContain('pcb_drop_commit');expect(f.calls).not.toContain('pcb_revert');
    const callsBeforeRetry=[...f.calls];
    await expect(f.bridge.execute(call)).rejects.toThrow(/recovery|quarantin|close/i);
    expect((await f.bridge.internal.saveAfterMutation({id:'retry-via-save',name:'pcb_save',arguments:{}})).isError).toBe(true);
    expect(f.calls).toEqual(callsBeforeRetry);expect(finished).toBe(0);
  });
  it('rejects name-only transaction support before begin but retains readonly route inventory',async()=>{
    const f=await fixture({initial:pcb});f.session.supportsNativeRouteTransactions=()=>false;
    const bridge=createKicadHarnessTools(f.session,f.toolOptions);
    expect(bridge.tools.some(tool=>tool.name==='fresh_replace_route_items')).toBe(false);
    expect(bridge.tools.some(tool=>tool.name==='fresh_get_route_items')).toBe(true);
    const selection=JSON.parse((await bridge.execute({id:'read',name:'fresh_get_route_items',arguments:{}})).content);
    await expect(bridge.execute({id:'denied',name:'fresh_replace_route_items',arguments:{selectionIdentity:selection.identity,net:'GND',deleteItemIds:[],tracks:[],vias:[]}})).rejects.toThrow(/Unsupported/);
    expect(f.calls).not.toContain('pcb_begin_commit');
  });
  it('awaits private primary evidence before cleanup and preserves typed cause when cleanup also fails',async()=>{
    const f=await fixture({initial:pcb}),first=new TypeError('First native track failure',{cause:new Error('Original SDK cause')});
    const base=f.session.callTool,events:string[]=[];
    f.session.callTool=async(name,args)=>{
      if(name==='pcb_add_track'){f.calls.push(name);throw first;}
      if(name==='pcb_drop_commit'){events.push('drop');f.calls.push(name);throw new Error('Cleanup transport closed');}
      return await base(name,args);
    };
    f.session.quarantineNativeRouteTransaction=cause=>{expect(cause).toBe(first);events.push('quarantine');};
    const bridge=createKicadHarnessTools(f.session,{...f.toolOptions,observeFreshRouteMutationDiagnostic:async diagnostic=>{
      events.push(diagnostic.phase+':start');await Promise.resolve();events.push(diagnostic.phase+':stored');
    }});
    const selection=JSON.parse((await bridge.execute({id:'read',name:'fresh_get_route_items',arguments:{}})).content);
    const error=await bridge.execute({id:'route',name:'fresh_replace_route_items',arguments:{selectionIdentity:selection.identity,net:'GND',deleteItemIds:[],tracks:[{x1Mm:9,y1Mm:10,x2Mm:10,y2Mm:10,layer:'F.Cu'}],vias:[]}}).then(()=>null,error=>error as Error);
    expect(error!.cause).toBe(first);expect(error!.message).toContain('primary pcb_add_track[0]: TypeError: First native track failure');expect(error!.message).toContain('Cleanup transport closed');
    expect(events).toEqual(['primary-failure:start','primary-failure:stored','quarantine','drop','recovery-finished:start','recovery-finished:stored']);
    expect(bridge.freshRouteMutationDiagnostics![0]!.primary).toEqual([{name:'TypeError',message:'First native track failure'},{name:'Error',message:'Original SDK cause'}]);
    expect((await bridge.internal.saveAfterMutation({id:'save',name:'pcb_save',arguments:{}})).isError).toBe(true);expect(f.calls).not.toContain('pcb_save');
  });
  it('keeps the push failure primary and preserves unvalidated post-add state instead of blindly dropping it',async()=>{
    const f=await fixture({initial:pcb}),first=new TypeError("Board.push_commit() missing required argument 'commit'");const base=f.session.callTool;
    f.session.callTool=async(name,args)=>{if(name==='pcb_push_commit'){f.calls.push(name);throw first;}return await base(name,args);};
    const selection=JSON.parse((await f.bridge.execute({id:'read',name:'fresh_get_route_items',arguments:{}})).content);
    const error=await f.bridge.execute({id:'route',name:'fresh_replace_route_items',arguments:{selectionIdentity:selection.identity,net:'GND',deleteItemIds:[],tracks:[{x1Mm:9,y1Mm:10,x2Mm:10,y2Mm:10,layer:'F.Cu'}],vias:[]}}).then(()=>null,error=>error as Error);
    expect(error!.cause).toBe(first);expect(error!.message).toContain("primary pcb_push_commit: TypeError: Board.push_commit()");
    expect(f.bridge.freshRouteMutationDiagnostics!.at(-1)).toMatchObject({transactionStarted:true,transactionPushed:false,recovery:'preserved-state-recovery-required'});
    expect(f.calls).not.toContain('pcb_drop_commit');expect(f.calls).not.toContain('pcb_revert');expect(await readFile(f.project.pcbPath,'utf8')).toBe(pcb);
  });
  it('retains primary diagnostics if the private sink throws and uses guarded known-preimage recovery',async()=>{
    const f=await fixture({initial:pcb}),first=new Error('Primary before track dispatch');const base=f.session.callTool;
    f.session.callTool=async(name,args)=>{if(name==='pcb_add_track')throw first;return await base(name,args);};
    const bridge=createKicadHarnessTools(f.session,{...f.toolOptions,observeFreshRouteMutationDiagnostic:async()=>{throw new Error('Sink failed');}});
    const selection=JSON.parse((await bridge.execute({id:'read',name:'fresh_get_route_items',arguments:{}})).content);
    const error=await bridge.execute({id:'route',name:'fresh_replace_route_items',arguments:{selectionIdentity:selection.identity,net:'GND',deleteItemIds:[],tracks:[{x1Mm:9,y1Mm:10,x2Mm:10,y2Mm:10,layer:'F.Cu'}],vias:[]}}).then(()=>null,error=>error as Error);
    expect(error!.cause).toBe(first);expect(error!.message).toContain('Primary before track dispatch');expect(error!.message).not.toContain('Sink failed');
    expect(bridge.freshRouteMutationDiagnostics).toHaveLength(2);expect(f.calls).toContain('pcb_drop_commit');expect(f.calls).toContain('pcb_revert');
  });
  it('finishes the session transaction scope only after saved physical/source readback',async()=>{
    const f=await fixture({initial:pcb});let finished=0;
    f.session.finishNativeRouteTransaction=()=>{expect(f.calls).toContain('pcb_save');expect(f.physicalReads()).toBeGreaterThan(2);finished++;};
    const selection=JSON.parse((await f.bridge.execute({id:'read',name:'fresh_get_route_items',arguments:{}})).content);
    await f.bridge.execute({id:'route',name:'fresh_replace_route_items',arguments:{selectionIdentity:selection.identity,net:'GND',deleteItemIds:[],tracks:[{x1Mm:9,y1Mm:10,x2Mm:10,y2Mm:10,layer:'F.Cu'}],vias:[]}});
    expect(finished).toBe(0);expect((await f.bridge.internal.saveAfterMutation({id:'save',name:'pcb_save',arguments:{}})).isError).not.toBe(true);expect(finished).toBe(1);
  });
  it('rechecks external disk state after the awaited first-diagnostic write before cleanup',async()=>{
    const f=await fixture({initial:pcb}),first=new Error('Initial add failed');const base=f.session.callTool;
    f.session.callTool=async(name,args)=>{if(name==='pcb_add_track')throw first;return await base(name,args);};
    const external=pcb.replace('(thickness 1.6)','(thickness 1.7)');
    const bridge=createKicadHarnessTools(f.session,{...f.toolOptions,observeFreshRouteMutationDiagnostic:async diagnostic=>{if(diagnostic.phase==='primary-failure')await writeFile(f.project.pcbPath,external,'utf8');}});
    const selection=JSON.parse((await bridge.execute({id:'read',name:'fresh_get_route_items',arguments:{}})).content);
    const error=await bridge.execute({id:'route',name:'fresh_replace_route_items',arguments:{selectionIdentity:selection.identity,net:'GND',deleteItemIds:[],tracks:[{x1Mm:9,y1Mm:10,x2Mm:10,y2Mm:10,layer:'F.Cu'}],vias:[]}}).then(()=>null,error=>error as Error);
    expect(error!.cause).toBe(first);expect(await readFile(f.project.pcbPath,'utf8')).toBe(external);expect(f.calls).not.toContain('pcb_drop_commit');expect(f.calls).not.toContain('pcb_revert');
  });
  it('retains bounded raw MCP failure evidence carried by an object cause instead of losing it as object prose',async()=>{
    const f=await fixture({initial:pcb});const native={operation:'pcb_add_track',response:{isError:true,content:[{type:'text',text:"TypeError: missing native Commit argument"}]}};
    const first=new Error('Categorical native failure',{cause:native});const base=f.session.callTool;
    f.session.callTool=async(name,args)=>{if(name==='pcb_add_track')throw first;return await base(name,args);};
    const selection=JSON.parse((await f.bridge.execute({id:'read',name:'fresh_get_route_items',arguments:{}})).content);
    await expect(f.bridge.execute({id:'route',name:'fresh_replace_route_items',arguments:{selectionIdentity:selection.identity,net:'GND',deleteItemIds:[],tracks:[{x1Mm:9,y1Mm:10,x2Mm:10,y2Mm:10,layer:'F.Cu'}],vias:[]}})).rejects.toThrow('Categorical native failure');
    const detail=f.bridge.freshRouteMutationDiagnostics![0]!.primary[1]!.detail!;
    expect(detail.truncated).toBe(false);expect(JSON.parse(detail.jsonPrefix)).toEqual(native);expect(detail.contentIdentity).toEqual(contentIdentity(JSON.stringify(native)));
  });
  it.each(['pcb_add_track','pcb_begin_commit','pcb_push_commit'] as const)('retains a returned error/negative acknowledgement from %s through the awaited private sink',async operation=>{
    const f=await fixture({initial:pcb});const reply=operation==='pcb_add_track'
      ?{isError:true,content:[{type:'text' as const,text:'TypeError: original returned native failure'}],structuredContent:{nativeError:'private native details'}}
      :{isError:false,content:[{type:'text' as const,text:'Native transaction was not acknowledged.'}],structuredContent:{result:'Native transaction was not acknowledged.'}};
    const base=f.session.callTool;f.session.callTool=async(name,args)=>{if(name===operation){f.calls.push(name);return reply;}return await base(name,args);};
    const stored:unknown[]=[];
    const bridge=createKicadHarnessTools(f.session,{...f.toolOptions,observeFreshRouteMutationDiagnostic:async diagnostic=>{
      await Promise.resolve();stored.push(diagnostic);if(diagnostic.phase==='primary-failure')expect(f.calls).not.toContain('pcb_drop_commit');
    }});
    const selection=JSON.parse((await bridge.execute({id:'read',name:'fresh_get_route_items',arguments:{}})).content);
    const error=await bridge.execute({id:'route',name:'fresh_replace_route_items',arguments:{selectionIdentity:selection.identity,net:'GND',deleteItemIds:[],tracks:[{x1Mm:9,y1Mm:10,x2Mm:10,y2Mm:10,layer:'F.Cu'}],vias:[]}}).then(()=>null,error=>error as Error);
    const primary=bridge.freshRouteMutationDiagnostics![0]!;expect(primary.firstOperation).toBe(operation==='pcb_add_track'?'pcb_add_track[0]':operation);
    expect(JSON.parse(primary.primary[1]!.detail!.jsonPrefix)).toEqual({operation,response:reply});
    expect((error!.cause as Error).cause).toEqual({operation,response:reply});expect(stored).toHaveLength(2);
  });
  it('retains a rejected returned native save acknowledgement as private primary cause',async()=>{
    const f=await fixture({initial:pcb});const events:unknown[]=[];
    const bridge=createKicadHarnessTools(f.session,{...f.toolOptions,observeFreshRouteMutationDiagnostic:async diagnostic=>{await Promise.resolve();events.push(diagnostic);}});
    const selection=JSON.parse((await bridge.execute({id:'read',name:'fresh_get_route_items',arguments:{}})).content);
    await bridge.execute({id:'route',name:'fresh_replace_route_items',arguments:{selectionIdentity:selection.identity,net:'GND',deleteItemIds:[],tracks:[{x1Mm:9,y1Mm:10,x2Mm:10,y2Mm:10,layer:'F.Cu'}],vias:[]}});
    const reply={isError:false,content:[{type:'text' as const,text:'Save skipped.'}],structuredContent:{result:'Save skipped.'}};
    const base=f.session.callTool;f.session.callTool=async(name,args)=>name==='pcb_save'?reply:await base(name,args);
    const failed=await bridge.internal.saveAfterMutation({id:'save',name:'pcb_save',arguments:{}});expect(failed.isError).toBe(true);
    expect(JSON.parse(bridge.freshRouteMutationDiagnostics![0]!.primary[1]!.detail!.jsonPrefix)).toEqual({operation:'pcb_save',response:reply});expect(events).toHaveLength(2);
  });
  it('accepts the pinned sanitized session projection for qualified transaction and save replies',async()=>{
    const f=await fixture({initial:pcb}),base=f.session.callTool;
    f.session.callTool=async(name,args)=>{
      const result=await base(name,args);
      return {...result,content:[{type:'text',text:'{"schemaVersion":"evleda.kicad-mcp-result.v1","category":"validated_structured_evidence"}'}]};
    };
    const selection=JSON.parse((await f.bridge.execute({id:'read',name:'fresh_get_route_items',arguments:{}})).content);
    await f.bridge.execute({id:'route',name:'fresh_replace_route_items',arguments:{selectionIdentity:selection.identity,net:'GND',deleteItemIds:[],tracks:[{x1Mm:9,y1Mm:10,x2Mm:10,y2Mm:10,layer:'F.Cu'}],vias:[]}});
    expect((await f.bridge.internal.saveAfterMutation({id:'save',name:'pcb_save',arguments:{}})).isError).not.toBe(true);
  });
  it('materializes the proof02 float residue and neighbouring-float wire edge before exact track/via readback',async()=>{
    const f=await fixture({initial:pcb}),base=f.session.callTool,wire:Record<string,unknown>[]=[];
    f.session.callTool=async(name,args={})=>{if(name==='pcb_add_track'||name==='pcb_add_via')wire.push({...args});return await base(name,args);};
    const selection=JSON.parse((await f.bridge.execute({id:'read',name:'fresh_get_route_items',arguments:{}})).content);
    const call={id:'route',name:'fresh_replace_route_items' as const,arguments:{selectionIdentity:selection.identity,net:'GND',deleteItemIds:[],tracks:[
      {x1Mm:1.000001,y1Mm:10.299999999999999,x2Mm:2.000001,y2Mm:10.299999999999999,layer:'F.Cu'},
      {x1Mm:2.000001,y1Mm:10.299999999999999,x2Mm:3.000001,y2Mm:11.299999999999999,layer:'F.Cu'}],vias:[{xMm:3.000001,yMm:11.299999999999999}]}};
    const original=structuredClone(call);expect(Math.trunc(call.arguments.tracks[0]!.x1Mm*1e6)).toBe(1000000);
    expect((await f.bridge.execute(call)).isError).not.toBe(true);expect(call).toEqual(original);
    expect(wire[0]!.x1_mm).not.toBe(1.000001);expect(Math.trunc(Number(wire[0]!.x1_mm)*1e6)).toBe(1000001);
    expect(Math.trunc(Number(wire[0]!.y1_mm)*1e6)).toBe(10300000);expect(Math.trunc(Number(wire[2]!.y_mm)*1e6)).toBe(11300000);
    expect((await f.bridge.internal.saveAfterMutation({id:'save',name:'pcb_save',arguments:{}})).isError).not.toBe(true);
    const source=await readFile(f.project.pcbPath,'utf8');expect(source).toContain('(start 1.000001 10.3)');expect(source).toContain('(at 3.000001 11.3)');
  });
  it('still rejects a real one-nanometre readback mutation rather than comparing with a looser tolerance',async()=>{
    const f=await fixture({initial:pcb,routeReadbackOffsetNm:1});const selection=JSON.parse((await f.bridge.execute({id:'read',name:'fresh_get_route_items',arguments:{}})).content);
    await expect(f.bridge.execute({id:'route',name:'fresh_replace_route_items',arguments:{selectionIdentity:selection.identity,net:'GND',deleteItemIds:[],tracks:[{x1Mm:1.000001,y1Mm:10.299999999999999,x2Mm:2.000001,y2Mm:10.299999999999999,layer:'F.Cu'}],vias:[]}})).rejects.toThrow(/geometry differs/);
    expect(f.calls).not.toContain('pcb_save');expect(await readFile(f.project.pcbPath,'utf8')).toBe(pcb);
  });
  it.each([0,1,-1])('writes explicit channel width from one nm plan and enforces exact width readback offset %s',async offset=>{
    // Translate the synthetic saved source into the authoring board and retain
    // one identical local land pattern for the two resistor instances.
    let source=usbChannelPcb().replaceAll('(at 0 0) (uuid','(at 5 7) (uuid')
      .replace(/\((start|end|xy) (-?[0-9.]+) (-?[0-9.]+)\)/gu,(_match,kind,x,y)=>`(${kind} ${Number(x)+5} ${Number(y)+7})`)
      .replace(`(at 5 7) (uuid "${usbChannelSourceId(30)}")`,`(at 5 8) (uuid "${usbChannelSourceId(30)}")`)
      .replace('(pad "1" smd rect (at 1 1)','(pad "1" smd rect (at 1 0)')
      .replace('(pad "2" smd rect (at 2 1)','(pad "2" smd rect (at 2 0)')
      .replace(/\)\s+(?=\(segment)/gu,')\n');
    const f=await fixture({initial:source,physicalSource:source,compilationBundle:usbChannelBundle(),widthReadbackOffsetNm:offset}),wire:Record<string,unknown>[]=[];
    const base=f.session.callTool;f.session.callTool=async(name,args={})=>{if(name==='pcb_add_track')wire.push({...args});return await base(name,args);};
    const selection=JSON.parse((await f.bridge.execute({id:'read',name:'fresh_get_route_items',arguments:{}})).content);
    const call={id:'route',name:'fresh_replace_route_items' as const,arguments:{selectionIdentity:selection.identity,net:'LP',deleteItemIds:[usbChannelSourceId(1)],tracks:[
      {x1Mm:5,y1Mm:7,x2Mm:5.5,y2Mm:7,layer:'F.Cu',widthMm:0.200000499999},
      {x1Mm:5.5,y1Mm:7,x2Mm:6,y2Mm:7,layer:'F.Cu'}],vias:[]}};
    const original=structuredClone(call);
    if(offset){await expect(f.bridge.execute(call)).rejects.toThrow(/geometry differs/);expect(await readFile(f.project.pcbPath,'utf8')).toBe(source);}
    else{expect((await f.bridge.execute(call)).isError).not.toBe(true);expect((await f.bridge.internal.saveAfterMutation({id:'save',name:'pcb_save',arguments:{}})).isError).not.toBe(true);}
    expect(call).toEqual(original);expect(wire.map(track=>track.width_mm)).toEqual([0.2,0.5]);
  });
  it.each([0,1,-1])('writes wider ordinary power copper and enforces exact width readback offset %s',async offset=>{
    const f=await fixture({initial:pcb,widthReadbackOffsetNm:offset}),wire:Record<string,unknown>[]=[];
    const base=f.session.callTool;f.session.callTool=async(name,args={})=>{if(name==='pcb_add_track')wire.push({...args});return await base(name,args);};
    const selection=JSON.parse((await f.bridge.execute({id:'read',name:'fresh_get_route_items',arguments:{}})).content);
    const call={id:'route',name:'fresh_replace_route_items' as const,arguments:{selectionIdentity:selection.identity,net:'GND',deleteItemIds:[],
      tracks:[{x1Mm:9,y1Mm:10,x2Mm:10,y2Mm:10,layer:'F.Cu',widthMm:0.800000499999}],vias:[]}};
    const original=structuredClone(call);
    if(offset){await expect(f.bridge.execute(call)).rejects.toThrow(/geometry differs/);expect(await readFile(f.project.pcbPath,'utf8')).toBe(pcb);}
    else{expect((await f.bridge.execute(call)).isError).not.toBe(true);expect((await f.bridge.internal.saveAfterMutation({id:'save',name:'pcb_save',arguments:{}})).isError).not.toBe(true);}
    expect(call).toEqual(original);expect(wire.map(track=>track.width_mm)).toEqual([0.8]);
  });
  it('rejects explicit widths below ordinary net-class floors before starting a native transaction',async()=>{
    const f=await fixture({initial:pcb});const selection=JSON.parse((await f.bridge.execute({id:'read',name:'fresh_get_route_items',arguments:{}})).content);
    await expect(f.bridge.execute({id:'route',name:'fresh_replace_route_items',arguments:{selectionIdentity:selection.identity,net:'GND',deleteItemIds:[],
      tracks:[{x1Mm:9,y1Mm:10,x2Mm:10,y2Mm:10,layer:'F.Cu',widthMm:0.499999}],vias:[]}})).rejects.toThrow(/class floor/);
    expect(f.calls).not.toContain('pcb_begin_commit');
  });
  it('returns source-bound native pad positions after a cardinal transform without leaking binary addition residue',async()=>{
    const resistor=(reference:string,x:number,y:number,nets:readonly string[],rotated=false)=>fp(reference,'Resistor_SMD:R_0603_1608Metric','10k',x,y,nets)
      .replace('(at 0 0)',rotated?'(at -0.825 0 -90)':'(at -0.825 0)').replace('(at 2 0)',rotated?'(at 0.825 0 -90)':'(at 0.825 0)')
      .replace(`(at ${x} ${y} 0)`,`(at ${x} ${y} ${rotated?-90:0})`);
    const source=header+fp('J1','Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical','DIVIDER_IO',5,10,['VIN','VOUT','GND'])
      +resistor('R1',15,8,['VIN','VOUT'])+resistor('R2',18,9.475,['VOUT','GND'],true)+')';
    const f=await fixture({initial:source,physicalSource:source});
    const result=JSON.parse((await f.bridge.execute({id:'pads',name:'fresh_get_contract_pad_positions',arguments:{reference:'R2',pad:'2'}})).content);
    expect(9.475+0.825).toBe(10.299999999999999);expect(result.pads).toHaveLength(1);expect(result.pads[0]).toMatchObject({xMm:18,yMm:10.3});
  });
  it('rejects a stale plane source selection before any transaction',async()=>{
    const f=await fixture({initial:pcb});const selection=JSON.parse((await f.bridge.execute({id:'routes',name:'fresh_get_route_items',arguments:{}})).content);
    await f.replaceOwnedSource(pcb+'\n');
    await expect(f.bridge.execute({id:'route',name:'fresh_replace_route_items',arguments:{selectionIdentity:selection.identity,net:'GND',deleteItemIds:[],tracks:[{x1Mm:9,y1Mm:10,x2Mm:10,y2Mm:10,layer:'F.Cu'}],vias:[]}})).rejects.toThrow(/changed after/);
    expect(f.calls).not.toContain('pcb_begin_commit');
  });
  it('rejects off-angle edits before any native transaction and never accepts V1 selection authority',async()=>{
    const f=await fixture({initial:pcb});const selection=JSON.parse((await f.bridge.execute({id:'routes',name:'fresh_get_route_items',arguments:{}})).content);
    const args={selectionIdentity:selection.identity,net:'GND',deleteItemIds:[],tracks:[{x1Mm:9,y1Mm:10,x2Mm:10,y2Mm:10.2,layer:'F.Cu'}],vias:[]};
    await expect(f.bridge.execute({id:'route',name:'fresh_replace_route_items',arguments:args})).rejects.toThrow(/45-degree/);
    await expect(f.bridge.execute({id:'v1',name:'fresh_replace_route_items',arguments:{...args,selectionIdentity:{...selection.identity,schemaVersion:'evleda.fresh-route-selection.v1'}}})).rejects.toThrow();
    expect(f.calls).not.toContain('pcb_begin_commit');
  });
  it('rejects absent/copied/wrong-family or mismatched authenticated bundle before CAD calls',async()=>{
    const f=await fixture();
    const {freshPlaneCompilationBundle:_planeBundle,...withoutPlaneBundle}=f.toolOptions;
    expect(()=>createKicadHarnessTools(f.session,withoutPlaneBundle)).toThrow(/full authenticated V2/);
    expect(()=>createKicadHarnessTools(f.session,{...f.toolOptions,freshPlaneCompilationBundle:structuredClone(f.bundle)})).toThrow(/full authenticated V2/);
    expect(()=>createKicadHarnessTools(f.session,{...f.toolOptions,freshPlaneCompilationBundle:bundle('Another authenticated prompt.')})).toThrow(/bundle reference/);
    expect(()=>createKicadHarnessTools(f.session,{...f.toolOptions,freshCompilationBundle:createGenericDividerBundleFixture().bundle})).toThrow(/cannot use a V1/);
    expect(()=>createKicadHarnessTools(f.session,{...f.toolOptions,freshProject:{...f.project} as PlaneFreshProject})).toThrow(/Copied or unauthenticated plane/);
    expect(f.calls).toEqual([]);
  });
  it('does not fall back to legacy pad mode when plane physical authority is omitted',async()=>{
    const f=await fixture();const {freshPhysicalFootprintResolver:_resolver,freshPhysicalFootprintSourcePins:_pins,...missing}=f.toolOptions;
    expect(()=>createKicadHarnessTools(f.session,missing)).toThrow(/no legacy pad fallback/);
  });
  it('syncs the full V2 schematic including GND and returns an actual plane result binding',async()=>{
    const f=await fixture();const call={id:'sync',name:'fresh_sync_from_schematic' as const,arguments:{}};
    const output=await f.bridge.execute(call);const result=JSON.parse(output.content);
    expect(result.schemaVersion).toBe('evleda.fresh-plane-sync-from-schematic-result.v1');
    expect(result.planeProjectBindingIdentity).toEqual(f.project.planeBinding.identity);expect(result).not.toHaveProperty('genericProjectBindingIdentity');
    expect(result.sourceContractIdentity).toEqual(f.bundle.contract.identity);expect(result.sourceContractIdentity.schemaVersion).toBe('evleda.pcb-design-contract.v2');
    expect(result.contractIdentity).toEqual(createFreshConnectivityContract(f.bundle.contract).identity);
    const context={connectivityIdentity:createFreshConnectivityContract(f.bundle.contract).identity,projectBindingIdentity:f.project.planeBinding.identity,sourceContractIdentity:f.bundle.contract.identity};
    expect(planeCompoundMutationState(call,output,context)).toBe(true);
    expect(()=>planeCompoundMutationState(call,output,{...context,sourceContractIdentity:bundle('Other source authority.').identity})).toThrow(/host-bound/);
    const {identity:_identity,...copied}=result;const wrongFamily={...copied,genericProjectBindingIdentity:copied.planeProjectBindingIdentity};
    expect(()=>planeCompoundMutationState(call,{...output,content:JSON.stringify({...wrongFamily,identity:canonicalIdentity(wrongFamily,result.schemaVersion)})},context)).toThrow(/invalid host board-mutation/);
    expect(result.logicalTerminalCount).toBe(7);expect(result.namedCopperPrimitiveCount).toBe(7);
    expect((await f.bridge.internal.saveAfterMutation({id:'save',name:'pcb_save',arguments:{}})).isError).not.toBe(true);
    const read=JSON.parse((await f.bridge.execute({id:'pads',name:'fresh_get_contract_pad_positions',arguments:{}})).content);
    expect(read.schemaVersion).toBe('evleda.fresh-plane-pad-positions.v1');expect(read).not.toHaveProperty('genericProjectBindingIdentity');
    expect(read.pads.filter((pad:any)=>pad.net==='GND')).toHaveLength(2);expect(f.physicalReads()).toBe(3);
    expect(f.bundle.contract.routingConstraints.nets.find(route=>route.net==='GND')!.topology).toBe('plane');
    expect(f.calls).not.toContain('pcb_add_zone');expect(f.calls).not.toContain('pcb_add_track');
  });
  it.each(['sync','save'] as const)('restores the exact plane preimage when the qualified writer drops a footprint nickname during %s',async phase=>{
    const f=await fixture(),base=f.session.callTool;
    f.session.callTool=async(name,args)=>{
      const result=await base(name,args);
      if(name===(phase==='sync'?'pcb_sync_from_schematic':'pcb_save')){
        const changed=(await readFile(f.project.pcbPath,'utf8')).replace('(footprint "Resistor_SMD:R_0603_1608Metric"','(footprint "R_0603_1608Metric"');
        await f.replaceOwnedSource(changed);
      }
      return result;
    };
    const call={id:'qualified-plane-sync',name:'fresh_sync_from_schematic' as const,arguments:{}};
    if(phase==='sync'){
      await expect(f.bridge.execute(call)).rejects.toThrow(/FRESH_SYNC_ROLLED_BACK_TERMINAL: Synced PCB footprint library IDs do not exactly match the complete qualified schematic assignments/);
      expect(f.calls).toEqual(['pcb_sync_from_schematic','pcb_revert']);
      expect(f.physicalReads()).toBe(0);
    }else{
      expect(JSON.parse((await f.bridge.execute(call)).content)).toMatchObject({applied:true,mutated:true});
      expect(await f.bridge.internal.saveAfterMutation({id:'bare-plane-save',name:'pcb_save',arguments:{}})).toMatchObject({isError:true,content:expect.stringContaining('complete qualified schematic assignments')});
      expect(f.calls).toEqual(['pcb_sync_from_schematic','pcb_save','pcb_revert']);
      expect(f.physicalReads()).toBe(1);
    }
    expect(await readFile(f.project.pcbPath,'utf8')).toBe(empty);
    expect(await f.session.readActivePcbSource!(f.project.pcbPath)).toBe(empty);
  });
  it('rejects a native netlist which drops plane GND instead of treating it as a V1 trace omission',async()=>{
    const f=await fixture({omitGround:true});await expect(f.bridge.execute({id:'sync',name:'fresh_sync_from_schematic',arguments:{}})).rejects.toThrow(/native netlist differs/);
    expect(f.calls).not.toContain('pcb_sync_from_schematic');expect(await readFile(f.project.pcbPath,'utf8')).toBe(empty);
  });
  it.each(['nativeFailureOnSave','nativeParityFailureOnSave','saveChangesPad'] as const)('rejects plane sync commit and restores the exact preimage when %s',async flag=>{
    const f=await fixture({[flag]:true});await f.bridge.execute({id:'sync',name:'fresh_sync_from_schematic',arguments:{}});
    expect((await f.bridge.internal.saveAfterMutation({id:'save',name:'pcb_save',arguments:{}})).isError).toBe(true);
    expect(await readFile(f.project.pcbPath,'utf8')).toBe(empty);
  });
  it('authors all schematic nets including GND, preserves them through field repair, then syncs under the actual V2 binding',async()=>{
    const f=await completeSchematicFixture();
    const connected=JSON.parse((await f.bridge.execute({id:'connect',name:'fresh_apply_contract_connectivity',arguments:{}})).content);
    expect(connected).toMatchObject({applied:true,mutated:true,issues:[],contractIdentity:createFreshConnectivityContract(f.bundle.contract).identity});
    expect(f.labels.filter(label=>label.name==='GND')).toHaveLength(1);expect(f.labels.every(label=>label.shape==='passive')).toBe(true);
    expect((await f.bridge.internal.saveAfterMutation({id:'connect-save',name:'pcb_save',arguments:{}})).isError).not.toBe(true);
    const before=parseFreshSchematicSource(await readFile(f.project.schematicPath,'utf8'));
    const fields=JSON.parse((await f.bridge.execute({id:'fields',name:'fresh_autoplace_schematic_fields',arguments:{}})).content);
    expect(fields).toMatchObject({schemaVersion:'evleda.fresh-schematic-fields-result.v1',applied:true,mutated:true,movedFieldCount:1});
    const after=parseFreshSchematicSource(await readFile(f.project.schematicPath,'utf8'));expect(after.wires).toEqual(before.wires);expect(after.labels).toEqual(before.labels);
    expect((await f.bridge.internal.saveAfterMutation({id:'field-save',name:'pcb_save',arguments:{}})).isError).not.toBe(true);
    const synced=JSON.parse((await f.bridge.execute({id:'sync',name:'fresh_sync_from_schematic',arguments:{}})).content);
    expect(synced).toMatchObject({schemaVersion:'evleda.fresh-plane-sync-from-schematic-result.v1',sourceContractIdentity:f.bundle.contract.identity,logicalTerminalCount:7});
    expect((await f.bridge.internal.saveAfterMutation({id:'pcb-save',name:'pcb_save',arguments:{}})).isError).not.toBe(true);
    expect(f.calls).not.toContain('pcb_add_zone');expect(f.calls).not.toContain('pcb_add_track');
  });
  it('reuses schematic placement/property operations without LED mode',async()=>{
    const f=await fixture();
    await expect(f.bridge.execute({id:'property',name:'sch_modify_property',arguments:{reference:'J1',field:'Value',value:'DIVIDER_IO'}})).resolves.toMatchObject({toolCallId:'property'});
    await expect(f.bridge.execute({id:'move',name:'sch_move_symbol',arguments:{reference:'J1',x_mm:25,y_mm:20}})).resolves.toMatchObject({toolCallId:'move'});
    expect(f.calls).toEqual(['sch_modify_property','sch_move_symbol']);
    expect(await readFile(f.project.schematicPath,'utf8')).toContain('(at 25 20 0)');
  });
  it('returns meaningful complete-contract schematic preflight issues under V2 identity',async()=>{
    const f=await fixture();const result=JSON.parse((await f.bridge.execute({id:'connect',name:'fresh_apply_contract_connectivity',arguments:{}})).content);
    expect(result.applied).toBe(false);expect(result.mutated).toBe(false);
    expect(result.contractIdentity).toEqual(createFreshConnectivityContract(f.bundle.contract).identity);
    expect(result.issues.some((issue:any)=>issue.endpoints?.includes('R2'))).toBe(true);
    expect(f.calls).not.toContain('sch_add_label');expect(f.calls).not.toContain('sch_add_labels');
  });
  it.each(['tamperMarkerOnCall','tamperMarkerOnPhysicalRead'] as const)('rechecks genuine plane authority after %s',async flag=>{
    const f=await fixture({initial:pcb,[flag]:true});
    const call=flag==='tamperMarkerOnCall'?{id:'read',name:'pcb_get_footprints',arguments:{}}:{id:'read',name:'fresh_get_contract_pad_positions',arguments:{}};
    await expect(f.bridge.execute(call as never)).rejects.toThrow(/marker|hash|changed/i);
  });
});
