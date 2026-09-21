/** Offline host-port fixture only. These constructed responses are NOT native KiCad evidence. */
import type { CallToolResult } from "@modelcontextprotocol/client";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import { parseFreshPcbSource, parseFreshPcbStackup } from "../../src/harness/fresh-kicad-parser.js";
import type { KiCadStockFootprintInspection } from "../../src/harness/kicad-library-resolver.js";
import { collectKicadNativePadObservation, KICAD_NATIVE_PAD_SNAPSHOT_COMPACT_TEXT, type KicadNativePadObservationExpected } from "../../src/integrations/kicad-native-pad-observation.js";

const id=(index:number)=>`77777777-7777-4777-8777-${String(index).padStart(12,"0")}`;
export function withNativePadFixtureIds(source:string):string {
  let result=source;
  for(const [fpIndex,fp] of parseFreshPcbSource(source).footprints.entries()){
    const head=`(footprint ${JSON.stringify(fp.libraryId)}`;
    result=result.replace(head,`${head} (uuid "${id(fpIndex+1)}")`);
    for(const [padIndex,pad]of fp.pads.entries())result=result.replace(pad.physical.source,pad.physical.source.slice(0,-1)+` (uuid "${id((fpIndex+1)*100+padIndex+1)}"))`);
  }
  return result;
}

export async function nativePadObservationFixture(source:string,libraryBaseline=source,options:{retainedPadLayers?:boolean}={}){
  const board=parseFreshPcbSource(source),baseline=parseFreshPcbSource(libraryBaseline);
  const document={type:"DOCTYPE_PCB",board_filename:"fixture.kicad_pcb",project:{name:"fixture",path:"D:\\evleda-offline-pad-fixture"}};
  const sourceCopperLayers=parseFreshPcbStackup(source).boardCopperLayerOrder;
  const copper=sourceCopperLayers.map(name=>`BL_${name.replace(".","_")}`);
  const layer=(value:string)=>value==="*.Cu"?["BL_F_Cu","BL_B_Cu",...Array.from({length:30},(_,i)=>`BL_In${i+1}_Cu`)]:value==="*.Mask"?["BL_F_Mask","BL_B_Mask"]:[`BL_${value.replace(".","_")}`];
  const rawPads=board.footprints.flatMap(fp=>fp.pads.map(p=>({id:{value:p.physical.id!},...(p.number?{number:p.number}:{}),net:p.netName?{name:p.netName}:{},
    type:p.physical.padType==="thru_hole"?"PT_PTH":p.physical.padType==="np_thru_hole"?"PT_NPTH":"PT_SMD",position:{x_nm:String(Math.round(p.at.x*1e6)),y_nm:String(Math.round(p.at.y*1e6))},
    pad_stack:{type:"PST_NORMAL",layers:p.layers.flatMap(layer),angle:{value_degrees:p.physical.rotationDeg},
      ...(options.retainedPadLayers?{unconnected_layer_removal:"ULR_KEEP"}:{}),
      drill:{start_layer:"BL_F_Cu",end_layer:"BL_B_Cu",diameter:p.physical.drill?{x_nm:String(Math.round(p.physical.drill.sizeMm.x*1e6)),y_nm:String(Math.round(p.physical.drill.sizeMm.y*1e6))}:{},shape:p.physical.drill?.shape==="oval"?"DS_OBLONG":"DS_CIRCLE"},
      copper_layers:[{layer:"BL_F_Cu",shape:p.physical.shape==="circle"?"PSS_CIRCLE":p.physical.shape==="oval"?"PSS_OVAL":p.physical.shape==="roundrect"?"PSS_ROUNDRECT":"PSS_RECTANGLE",
        size:{x_nm:String(Math.round(p.physical.sizeMm!.x*1e6)),y_nm:String(Math.round(p.physical.sizeMm!.y*1e6))},
        ...(p.physical.roundrectRatio===null?{}:{corner_rounding_ratio:p.physical.roundrectRatio}),
        offset:p.physical.drill?.offsetMm?{x_nm:String(Math.round(p.physical.drill.offsetMm.x*1e6)),y_nm:String(Math.round(p.physical.drill.offsetMm.y*1e6))}:{}}]}})));
  const byId=new Map(rawPads.map((p,index)=>[p.id.value,index]));
  const requested=rawPads.filter(p=>p.number&&p.net.name&&p.type!=="PT_NPTH").map(p=>p.id.value);
  const payload={schemaVersion:"evleda.kicad-live-pcb-pad-snapshot.v1",documentBefore:document,documentAfter:document,boardSourceBefore:source,boardSourceAfter:source,
    enabledCopperLayers:copper,enabledLayers:{requestType:"kiapi.board.commands.GetBoardEnabledLayers",request:{board:document},responseType:"kiapi.board.commands.BoardEnabledLayersResponse",response:{layers:copper,copper_layer_count:copper.length}},
    padRecords:rawPads,boardPadRecordIndexes:rawPads.map((_,i)=>i),
    footprintInventory:{requestType:"kiapi.common.commands.GetItems",request:{header:{document},types:["KOT_PCB_FOOTPRINT"]},responseType:"kiapi.common.commands.GetItemsResponse",responseMetadata:{status:"IRS_OK"},
      footprints:board.footprints.map(fp=>({footprintId:fp.id!,reference:fp.reference,padRecordIndexes:fp.pads.map(p=>byId.get(p.physical.id!)!)}))},
    padstackPresence:{requestType:"kiapi.board.commands.CheckPadstackPresenceOnLayers",request:{board:document,items:rawPads.map(p=>p.id),layers:copper},responseType:"kiapi.board.commands.PadstackPresenceResponse",
      response:{entries:rawPads.flatMap(p=>copper.map(layer=>({item:p.id,layer,presence:p.type!=="PT_NPTH"&&p.pad_stack.layers.includes(layer)?"PSP_PRESENT":"PSP_NOT_PRESENT"})))}},
    connectivity:requested.map(sourcePrimitiveId=>({sourcePrimitiveId,requestType:"kiapi.board.commands.GetConnectedItems",request:{header:{document},items:[{value:sourcePrimitiveId}],types:["KOT_PCB_PAD"]},responseType:"kiapi.common.commands.GetItemsResponse",responseMetadata:{status:"IRS_OK"},
      padRecordIndexes:rawPads.flatMap((p,i)=>p.type!=="PT_NPTH"&&p.net.name&&p.net.name===rawPads[byId.get(sourcePrimitiveId)!]!.net.name?[i]:[])}))};
  const inspections=baseline.footprints.map(fp=>{
    const pads=fp.pads.map((p,ordinal)=>({ordinal,number:p.number,padType:p.physical.padType!,shape:p.physical.shape!,layers:p.layers,copperSides:["front" as const],role:p.number?"numbered-copper" as const:p.physical.padType==="np_thru_hole"?"uncharacterized-non-electrical" as const:"paste-aperture" as const,
      definition:{name:"pad",values:[],children:[]},definitionKey:p.physical.definitionKey,at:{xMm:p.physical.relativeAt.x,yMm:p.physical.relativeAt.y,rotationDeg:p.physical.rotationDeg-fp.rotationDeg}}));
    const sourceIdentity=contentIdentity(canonicalJson(pads.map(p=>[p.definitionKey,p.at])));
    const inspection={schemaVersion:"evleda.kicad-stock-footprint-inspection.v2",libraryId:fp.libraryId,sourceIdentity,side:"front",courtyard:{front:true,back:false,availableForSide:true},fabrication:{front:true,back:false,availableForSide:true},
      pads:[...new Set(fp.pads.map(p=>p.number).filter(Boolean))].map(number=>({number,padType:"mixed",shape:"mixed",copperSides:["front"]})),physicalPads:pads,terminalPhysicalPadOrdinals:{},copperCommon:"not-assessed",
      resolverRecord:{libraryId:fp.libraryId,source:"kicad-stock",packageKind:"generic",pads:[...new Set(fp.pads.map(p=>p.number).filter(Boolean))]},identity:canonicalIdentity({sourceIdentity},"evleda.offline-physical-library-fixture.v1")} as KiCadStockFootprintInspection;
    return {reference:fp.reference,inspection};
  });
  const expected:KicadNativePadObservationExpected={pcbPath:"D:\\evleda-offline-pad-fixture\\fixture.kicad_pcb",pcbSource:source,requestedPrimitiveIds:requested,enabledCopperLayers:sourceCopperLayers,
    scopeIdentity:canonicalIdentity({kind:"offline-simulated-native-port"},"evleda.offline-pad-test.v1"),
    physicalFootprints:inspections.map(({reference,inspection})=>({reference,libraryId:inspection.libraryId,sourceIdentity:inspection.sourceIdentity})),
    physicalFootprintResolver:{inspectFootprint(libraryId){return inspections.find(p=>p.inspection.libraryId===libraryId)?.inspection??null;}}};
  const text=JSON.stringify(payload);
  const result:CallToolResult={isError:false,content:[{type:"text",text:Buffer.byteLength(text)>1024*1024?KICAD_NATIVE_PAD_SNAPSHOT_COMPACT_TEXT:text}],structuredContent:payload};
  const observation=await collectKicadNativePadObservation({async readLivePcbPadSnapshot(){return result;}},expected);
  return {observation,expected,envelope:result};
}
