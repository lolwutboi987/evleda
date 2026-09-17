import type { CallToolResult } from "@modelcontextprotocol/client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { planFreshFootprintPlacement } from "../../src/harness/fresh-footprint-placement.js";
import { parseFreshPcbSource } from "../../src/harness/fresh-kicad-parser.js";
import { assessCopperCommon, matchLogicalTerminalNumbers } from "../../src/harness/fresh-pcb-pad-model.js";
import { createKiCad10StockLibraryResolver } from "../../src/harness/kicad-library-resolver.js";
import { decodeKicadNativePadObservation } from "../../src/integrations/kicad-native-pad-observation.js";
import { nativePadObservationFixture } from "../helpers/native-pad-observation-fixture.js";

// Exact installed KiCad 10.0.3 stock file; the IPC responses below are constructed
// offline tests, NOT a native connector capture. Enum and NPTH flash semantics:
// https://github.com/KiCad/kicad-source-mirror/blob/10.0.3/api/proto/board/board_types.proto
// https://github.com/KiCad/kicad-source-mirror/blob/10.0.3/pcbnew/pad.cpp
const leaf = "USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal";
const libraryId = `Connector_USB:${leaf}`;
const fixtureRoot = new URL("../fixtures/usb-c-native-pads/", import.meta.url);
const stockBytes = readFileSync(new URL(`Connector_USB.pretty/${leaf}.kicad_mod`, fixtureRoot));
const resolver = createKiCad10StockLibraryResolver({symbolRoot:fileURLToPath(fixtureRoot),footprintRoot:fileURLToPath(fixtureRoot),
  exactSymbolIds:[],exactFootprintIds:[libraryId],stockSymbolNicknames:[],stockFootprintNicknames:["Connector_USB"]});
const inspection = resolver.inspectFootprint(libraryId)!;

function boardSource(): string {
  let source = `(kicad_pcb (version 20260206) ${stockBytes.toString("utf8")
    .replace(/^\t\((?:version|generator|generator_version)\b[^\r\n]*\)\r?\n/gmu, "")
    .replace(`(footprint "${leaf}"`, `(footprint "${libraryId}" (uuid "77777777-7777-4777-8777-777777777777") (at 20 20 0)`)
    .replace('(property "Reference" "REF**"', '(property "Reference" "J1"')})`;
  for (const pad of parseFreshPcbSource(source).footprints[0]!.pads) if (pad.number) {
    source = source.replace(pad.physical.source, `${pad.physical.source.slice(0,-1)} (net "${pad.number === "SH" ? "GND" : `USB_${pad.number}`}"))`);
  }
  return source;
}
const source = boardSource();
async function fixture(selectedSource = source) {
  const generated = await nativePadObservationFixture(selectedSource);
  return {...generated, expected:{...generated.expected,physicalFootprintResolver:resolver,
    physicalFootprints:[{reference:"J1",libraryId,sourceIdentity:inspection.sourceIdentity}]}};
}
function mutate(envelope: CallToolResult, change: (snapshot: Record<string, any>) => void): CallToolResult {
  const payload = structuredClone(envelope.structuredContent) as Record<string, any>;
  change(payload);
  return {isError:false,content:[{type:"text",text:JSON.stringify(payload)}],structuredContent:payload};
}

describe("stock USB-C complete native pad projection", () => {
  it.each([0,90,180,270])("retains all 22 physical features and 17 electrical terminals at %s degrees", async rotationDeg => {
    expect(contentIdentity(stockBytes)).toEqual({algorithm:"sha256",digest:"012da5bac71f8e9d4f59d0f7041c3cd8e1e5af3a3d297354b974f61ab24e8691",size:7170});
    const placed = planFreshFootprintPlacement(source,{reference:"J1",xMm:20,yMm:20,rotationDeg}).source;
    const {envelope,expected} = await fixture(placed);
    const observed = decodeKicadNativePadObservation(envelope,expected), inventory = observed.inventory!;
    expect(inventory.physicalPads).toHaveLength(22);
    expect(inventory.terminals).toHaveLength(17);
    expect(inventory.unsupportedPhysicalUuids).toEqual([]);
    expect(observed.physicalLibraryBindings[0]).toMatchObject({sourceIdentity:contentIdentity(stockBytes),physicalPadCount:22,logicalTerminalCount:17});
    expect(matchLogicalTerminalNumbers(inventory,inventory.footprintUuids[0]!,inspection.pads.map(p=>p.number)).status).toBe("match");
    const holes = inventory.physicalPads.filter(p=>p.role==="mechanical-hole");
    expect(holes).toHaveLength(2);
    expect(inventory.nonElectricalFeatureUuids).toEqual(holes.map(p=>p.uuid));
    for (const hole of holes) {
      expect(hole).toMatchObject({number:"",nativeType:"PT_NPTH",netName:null,observedUsableCopperLayers:[],issues:[]});
      expect(hole.rawNative.net).toEqual({});
      expect(hole.rawNative).toEqual((observed.rawSnapshot.padRecords as any[]).find(p=>p.id.value===hole.uuid));
      expect(inventory.terminals.some(t=>t.physicalPadUuids.includes(hole.uuid))).toBe(false);
      expect(inventory.rawLayerPresence!.observations.filter(p=>p.padUuid===hole.uuid).every(p=>p.presence==="absent")).toBe(true);
    }
    const shield = inventory.terminals.find(t=>t.number==="SH")!;
    expect(shield.physicalPadUuids).toHaveLength(4);
    for (const uuid of shield.physicalPadUuids) {
      const pad = inventory.physicalPads.find(p=>p.uuid===uuid)!;
      expect(pad.rawNative).toMatchObject({type:"PT_PTH",pad_stack:{angle:{value_degrees:rotationDeg},drill:{shape:"DS_OBLONG"},copper_layers:[{shape:"PSS_OVAL"}]}});
      expect(pad.observedUsableCopperLayers).toEqual(["BL_F_Cu","BL_B_Cu"]);
    }
  });

  it.each([
    ["oval replaced with a circle",(p:any)=>{p.pad_stack.copper_layers[0].shape="PSS_CIRCLE";}],
    ["oval dimension differs by one nm",(p:any)=>{p.pad_stack.copper_layers[0].size.x_nm="1000001";}],
    ["oval axes swapped without rotating",(p:any)=>{const size=p.pad_stack.copper_layers[0].size;[size.x_nm,size.y_nm]=[size.y_nm,size.x_nm];}],
    ["oval angle differs below the former tolerance",(p:any)=>{p.pad_stack.angle.value_degrees=0.000000001;}],
    ["oval drill replaced with a circle",(p:any)=>{p.pad_stack.drill.shape="DS_CIRCLE";}],
    ["oval drill differs by one nm",(p:any)=>{p.pad_stack.drill.diameter.y_nm="1700001";}],
    ["noninteger drill coordinate",(p:any)=>{p.pad_stack.drill.diameter.x_nm="600000.1";}],
  ] as const)("rejects %s",async(_label,change)=>{
    const {envelope,expected}=await fixture();
    expect(()=>decodeKicadNativePadObservation(mutate(envelope,v=>change(v.padRecords.find((p:any)=>p.number==="SH"))),expected)).toThrow();
  });

  it.each([
    ["wrong NPTH type",(p:any)=>{p.type="PT_PTH";}],
    ["wrong NPTH shape",(p:any)=>{p.pad_stack.copper_layers[0].shape="PSS_OVAL";}],
    ["missing drill",(p:any)=>{p.pad_stack.drill.diameter={};}],
    ["numbered NPTH",(p:any)=>{p.number="LOCATOR";}],
    ["assigned NPTH net",(p:any)=>{p.net={name:"GND"};}],
    ["wrong UUID",(p:any)=>{p.id.value="88888888-8888-4888-8888-888888888888";}],
  ] as const)("rejects %s against exact saved source",async(_label,change)=>{
    const {envelope,expected}=await fixture();
    expect(()=>decodeKicadNativePadObservation(mutate(envelope,v=>change(v.padRecords.find((p:any)=>p.type==="PT_NPTH"))),expected)).toThrow();
  });

  it("does not round sub-nm saved oval dimensions or drill geometry into an apparent match",async()=>{
    const {envelope,expected}=await fixture();
    for (const [original,changed] of [["(size 1 2.1)","(size 1.00000000000000000001 2.1)"],["(drill oval 0.6 1.7)","(drill oval 0.6000001 1.7)"]] as const) {
      const changedSource=source.replace(original,changed);
      const changedEnvelope=mutate(envelope,v=>{v.boardSourceBefore=changedSource;v.boardSourceAfter=changedSource;});
      // Omit independent stock pins here to exercise exact native/source geometry itself.
      const {physicalFootprintResolver:_resolver,physicalFootprints:_pins,...unbound}=expected;
      expect(()=>decodeKicadNativePadObservation(changedEnvelope,{...unbound,pcbSource:changedSource})).toThrow(/exact integer nanometres/);
    }
  });

  it("compares preserved source angles exactly, including values below JavaScript Number precision",async()=>{
    const rotated=planFreshFootprintPlacement(source,{reference:"J1",xMm:20,yMm:20,rotationDeg:90}).source;
    const {envelope,expected}=await fixture(rotated);
    const pad=parseFreshPcbSource(rotated).footprints[0]!.pads.find(p=>p.number==="SH")!;
    const changedPad=pad.physical.source.replace("(at -4.32 -3.105 90)","(at -4.32 -3.105 90.00000000000000000001)");
    expect(changedPad).not.toBe(pad.physical.source);
    const changedSource=rotated.replace(pad.physical.source,changedPad);
    const changedEnvelope=mutate(envelope,v=>{v.boardSourceBefore=changedSource;v.boardSourceAfter=changedSource;});
    expect(()=>decodeKicadNativePadObservation(changedEnvelope,{...expected,pcbSource:changedSource})).toThrow(/native pad angle differs/);
  });

  it("rejects malformed saved oval angle atoms instead of defaulting them to zero",async()=>{
    const {envelope,expected}=await fixture();
    const changedSource=source.replace("(at -4.32 -3.105)","(at -4.32 -3.105 invalid_angle)");
    const changed=mutate(envelope,v=>{v.boardSourceBefore=changedSource;v.boardSourceAfter=changedSource;});
    expect(()=>decodeKicadNativePadObservation(changed,{...expected,pcbSource:changedSource})).toThrow(/invalid saved geometry coordinate/);
  });

  it.each([
    ["numbered NPTH",(pad:string)=>pad.replace('(pad ""', '(pad "LOCATOR"')],
    ["assigned NPTH",(pad:string)=>`${pad.slice(0,-1)} (net "GND"))`],
    ["annular NPTH copper",(pad:string)=>pad.replace("(size 0.65 0.65)","(size 0.8 0.8)")],
    ["offset NPTH",(pad:string)=>pad.replace("(drill 0.65)","(drill 0.65 (offset 0.1 0))")],
  ] as const)("retains unsupported %s even when saved and native inputs agree",async(_label,change)=>{
    const pad=parseFreshPcbSource(source).footprints[0]!.pads.find(p=>p.physical.padType==="np_thru_hole")!;
    const changedSource=source.replace(pad.physical.source,change(pad.physical.source));
    const {observation}=await nativePadObservationFixture(changedSource);
    expect(observation.inventory!.physicalPads).toHaveLength(22);
    expect(observation.inventory!.terminals).toHaveLength(17);
    expect(observation.inventory!.unsupportedPhysicalUuids).toEqual([pad.physical.id]);
    const rejected=observation.inventory!.physicalPads.find(p=>p.uuid===pad.physical.id)!;
    expect(rejected.role).toBe("unsupported-physical");
    expect(rejected.observedUsableCopperLayers).toEqual([]);
    expect(observation.inventory!.terminals.some(t=>t.physicalPadUuids.includes(rejected.uuid))).toBe(false);
  });

  it("retains exact oval mechanical holes without creating terminals",async()=>{
    const pad=parseFreshPcbSource(source).footprints[0]!.pads.find(p=>p.physical.padType==="np_thru_hole")!;
    const changedPad=pad.physical.source.replace("np_thru_hole circle","np_thru_hole oval")
      .replace("(size 0.65 0.65)","(size 0.65 1.2)").replace("(drill 0.65)","(drill oval 0.65 1.2)");
    const {observation}=await nativePadObservationFixture(source.replace(pad.physical.source,changedPad));
    expect(observation.inventory!.unsupportedPhysicalUuids).toEqual([]);
    expect(observation.inventory!.terminals).toHaveLength(17);
    expect(observation.inventory!.physicalPads.find(p=>p.uuid===pad.physical.id)).toMatchObject({role:"mechanical-hole",netName:null,
      rawNative:{pad_stack:{drill:{shape:"DS_OBLONG",diameter:{x_nm:"650000",y_nm:"1200000"}},copper_layers:[{shape:"PSS_OVAL",size:{x_nm:"650000",y_nm:"1200000"}}]}}});
  });

  it("rejects a locating hole removed from both saved and native inventories against its exact stock pin",async()=>{
    const pad=parseFreshPcbSource(source).footprints[0]!.pads.find(p=>p.physical.padType==="np_thru_hole")!;
    const {envelope,expected,observation}=await fixture(source.replace(pad.physical.source,""));
    expect(observation.inventory!.physicalPads).toHaveLength(21);
    expect(()=>decodeKicadNativePadObservation(envelope,expected)).toThrow(/physical library pad inventory\/geometry differs/);
  });

  it.each([
    ["legacy assigned net code",(v:any,p:any)=>{p.net.code={value:1};}],
    ["malformed legacy net code",(v:any,p:any)=>{p.net.code=1;}],
    ["null legacy net code value",(v:any,p:any)=>{p.net.code={value:null};}],
    ["contradictory flashed copper",(v:any,p:any)=>{v.padstackPresence.response.entries.find((e:any)=>e.item.value===p.id.value).presence="PSP_PRESENT";}],
  ] as const)("retains and marks unsupported %s",async(_label,change)=>{
    const {envelope,expected}=await fixture();
    const changed=mutate(envelope,v=>change(v,v.padRecords.find((p:any)=>p.type==="PT_NPTH")));
    const inventory=decodeKicadNativePadObservation(changed,expected).inventory!;
    expect(inventory.physicalPads).toHaveLength(22);
    expect(inventory.terminals).toHaveLength(17);
    expect(inventory.unsupportedPhysicalUuids).toHaveLength(1);
    const invalid=inventory.physicalPads.find(p=>inventory.unsupportedPhysicalUuids.includes(p.uuid))!;
    expect(invalid.observedUsableCopperLayers).toEqual([]);
    expect(inventory.terminals.some(t=>t.physicalPadUuids.includes(invalid.uuid))).toBe(false);
    expect(matchLogicalTerminalNumbers(inventory,inventory.footprintUuids[0]!,inspection.pads.map(p=>p.number)).status).toBe("unsupported");
  });

  it("retains a requested netless mechanical query without inventing self copper connectivity",async()=>{
    const {envelope,expected}=await fixture();
    const id=parseFreshPcbSource(source).footprints[0]!.pads.find(p=>p.physical.padType==="np_thru_hole")!.physical.id!;
    const changed=mutate(envelope,v=>{const query=structuredClone(v.connectivity[0]);query.sourcePrimitiveId=id;query.request.items=[{value:id}];query.padRecordIndexes=[];v.connectivity.push(query);});
    const observed=decodeKicadNativePadObservation(changed,{...expected,requestedPrimitiveIds:[...expected.requestedPrimitiveIds,id]});
    expect(observed.clusters.queries.at(-1)!.returnedPadUuids).toEqual([]);
    const shield=observed.inventory!.terminals.find(t=>t.number==="SH")!;
    const contaminated={...observed.clusters,queries:observed.clusters.queries.map(q=>q.sourceUuids.some(s=>shield.physicalPadUuids.includes(s))?{...q,returnedPadUuids:[...q.returnedPadUuids,id]}:q)};
    expect(assessCopperCommon(observed.inventory!,{terminalKey:shield.key,requiredPhysicalPadUuids:shield.physicalPadUuids},contaminated).status).toBe("invalid-evidence");
  });
});
