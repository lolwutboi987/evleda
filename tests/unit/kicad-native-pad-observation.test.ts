import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { KICAD_NATIVE_PAD_SNAPSHOT_COMPACT_TEXT, collectKicadNativePadObservation, decodeKicadNativePadObservation, verifyHostKicadNativePadObservation, type KicadNativePadObservationExpected } from "../../src/integrations/kicad-native-pad-observation.js";
import { assessCopperCommon } from "../../src/harness/fresh-pcb-pad-model.js";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { createKiCad10StockLibraryResolver } from "../../src/harness/kicad-library-resolver.js";
import { parseFreshPcbSource } from "../../src/harness/fresh-kicad-parser.js";

const bytes = readFileSync(new URL("../fixtures/fresh-pcb-pads/native-pad-snapshot-envelope.json", import.meta.url));
const envelope = JSON.parse(bytes.toString("utf8")) as CallToolResult;
const snapshot = envelope.structuredContent as Record<string, any>;
const saved = readFileSync(new URL("../fixtures/fresh-pcb-pads/saved.kicad_pcb", import.meta.url), "utf8");
const expected: KicadNativePadObservationExpected = {
  pcbPath: "D:\\EvlEDA-qfn-pad-semantics-20260909\\fixture-v2\\project\\pad-semantics.kicad_pcb",
  pcbSource: saved, requestedPrimitiveIds: (snapshot.connectivity as {sourcePrimitiveId:string}[]).map(q => q.sourcePrimitiveId),
  enabledCopperLayers: ["F.Cu", "B.Cu"], scopeIdentity:canonicalIdentity({kind:"offline-producer-envelope-fixture"},"evleda.test-pad-scope.v1"),
};
const mutate = (change:(value:Record<string, any>)=>void): CallToolResult => {
  const value=structuredClone(snapshot); change(value);
  return {isError:false,content:[{type:"text",text:JSON.stringify(value)}],structuredContent:value};
};
const compact = (value: CallToolResult): CallToolResult => ({ ...value, content: [{ type: "text", text: KICAD_NATIVE_PAD_SNAPSHOT_COMPACT_TEXT }] });

describe("DOC12 compact private PAD envelope", () => {
  it("retains every raw observation and the same physical result without duplicating the payload", () => {
    const legacy = decodeKicadNativePadObservation(envelope, expected);
    const single = decodeKicadNativePadObservation(compact(envelope), expected);
    expect(single.rawSnapshot).toEqual(legacy.rawSnapshot);
    expect(single.inventory).toEqual(legacy.inventory);
    expect(single.clusters).toEqual(legacy.clusters);
    expect(single.expectedIdentity).toEqual(legacy.expectedIdentity);
    expect(single.rawEnvelopeIdentity).not.toEqual(legacy.rawEnvelopeIdentity);
    expect(() => verifyHostKicadNativePadObservation(single, expected)).toThrow(/current private host collector/);
  });
  it("accepts complete evidence that exceeded the old duplicate encoding, within unchanged bounds", () => {
    const padding = "\n".repeat(350_000);
    const large = mutate(v => { v.boardSourceBefore += padding; v.boardSourceAfter += padding; });
    expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(2 * 1024 * 1024);
    expect(Buffer.byteLength(JSON.stringify(compact(large)))).toBeLessThan(2 * 1024 * 1024);
    const binding = { ...expected, pcbSource: saved + padding };
    expect(() => decodeKicadNativePadObservation(large, binding)).toThrow();
    const observed = decodeKicadNativePadObservation(compact(large), binding);
    expect(observed.inventory!.physicalPads).toHaveLength(357);
    expect(observed.rawSnapshot).toEqual(large.structuredContent);
  });
  it.each([
    ["source drift", (v: Record<string, any>) => { v.boardSourceAfter += "\n"; }],
    ["missing pad", (v: Record<string, any>) => { v.padRecords.pop(); }],
    ["missing presence", (v: Record<string, any>) => { v.padstackPresence.response.entries.pop(); }],
    ["missing connectivity", (v: Record<string, any>) => { v.connectivity.pop(); }],
    ["foreign document", (v: Record<string, any>) => { v.documentBefore.project.path = "D:\\foreign"; }],
    ["wrong schema", (v: Record<string, any>) => { v.schemaVersion = "wrong"; }],
    ["extra payload field", (v: Record<string, any>) => { v.truncated = false; }],
  ] as const)("still rejects %s", (_label, change) => {
    expect(() => decodeKicadNativePadObservation(compact(mutate(change)), expected)).toThrow();
  });
  it.each([
    "{}", KICAD_NATIVE_PAD_SNAPSHOT_COMPACT_TEXT + "\n",
    KICAD_NATIVE_PAD_SNAPSHOT_COMPACT_TEXT.replace("envelope.v2", "envelope.v3"),
    KICAD_NATIVE_PAD_SNAPSHOT_COMPACT_TEXT.replace("structuredContent", "content"),
    KICAD_NATIVE_PAD_SNAPSHOT_COMPACT_TEXT.replace("snapshot.v1", "snapshot.v2"),
    KICAD_NATIVE_PAD_SNAPSHOT_COMPACT_TEXT.replace("}", ',"truncated":false}'),
  ])("rejects unqualified compact marker %s", text => {
    expect(() => decodeKicadNativePadObservation({ ...envelope, content: [{ type: "text", text }] }, expected)).toThrow();
  });
  it("retains the total envelope limit and legacy disagreement rejection", () => {
    const tooLarge = compact(mutate(v => { v.connectivity = Array.from({ length: 4096 }, () => structuredClone(v.connectivity[0])); }));
    expect(Buffer.byteLength(JSON.stringify(tooLarge))).toBeGreaterThan(2 * 1024 * 1024);
    expect(() => decodeKicadNativePadObservation(tooLarge, expected)).toThrow();
    expect(() => decodeKicadNativePadObservation({ ...envelope, content: [{ type: "text", text: JSON.stringify({ ...snapshot, schemaVersion: "wrong" }) }] }, expected)).toThrow(/disagree/);
    expect(() => decodeKicadNativePadObservation({ ...compact(envelope), structuredContent: {} }, expected)).toThrow();
  });
});
const fixture=JSON.parse(readFileSync(new URL("../fixtures/fresh-pcb-pads/fixture.json",import.meta.url),"utf8")) as {footprints:{reference:string;kind:string;source?:{path:string;sha256:string;sizeBytes:number}}[]};
const stockFixtures=fixture.footprints.filter(fp=>fp.kind==="stock");
const stockId=(fp:typeof stockFixtures[number])=>`Package_DFN_QFN:${fp.source!.path.split(/[/\\]/u).at(-1)!.replace(/\.kicad_mod$/u,"")}`;
const physicalResolver=createKiCad10StockLibraryResolver({symbolRoot:fileURLToPath(new URL("../fixtures/fresh-pcb-pads",import.meta.url)),footprintRoot:fileURLToPath(new URL("../fixtures/fresh-pcb-pads",import.meta.url)),exactSymbolIds:[],exactFootprintIds:stockFixtures.map(stockId),stockSymbolNicknames:[],stockFootprintNicknames:["Package_DFN_QFN"]});
const withLibrary:KicadNativePadObservationExpected={...expected,physicalFootprintResolver:physicalResolver,physicalFootprints:stockFixtures.map(fp=>({reference:fp.reference,libraryId:stockId(fp),sourceIdentity:{algorithm:"sha256",digest:fp.source!.sha256,size:fp.source!.sizeBytes}}))};

describe("real host native physical-pad decoder",()=>{
  it("exercises the complete SDK-shaped producer envelope without native execution",()=>{
    expect(contentIdentity(bytes).digest).toBe("feed97439bff5f2ace8f4cfd43ae2547d71ac4fa1f41e2bf05bcb10e81b4da57");
    const observation=decodeKicadNativePadObservation(envelope,expected);
    expect(observation.inventory!.physicalPads).toHaveLength(357);
    expect(observation.inventory!.terminals).toHaveLength(288);
    expect(observation.inventory!.nonElectricalFeatureUuids).toHaveLength(47);
    expect(observation.inventory!.unsupportedPhysicalUuids).toEqual([]);
    expect(observation.clusters.queries).toHaveLength(34);
    expect(observation.savedPcbIdentity.digest).toBe("2668f9a598d28de0faffbb5f8707eade4824f53c15693f7ef199d31cc9466b4c");
    for(const [ref,number,status] of [["T60","61","connected"],["T80","81","connected"],["NSEP","1","disconnected"],["NLAYER","1","disconnected"]] as const){
      const terminal=observation.inventory!.terminals.find(t=>t.reference===ref&&t.number===number)!;
      expect(assessCopperCommon(observation.inventory!,{terminalKey:terminal.key,requiredPhysicalPadUuids:terminal.physicalPadUuids},observation.clusters).status).toBe(status);
    }
  });
  it("mints authority only through the current host private read and rejects copied or stale receipts",async()=>{
    const pure=decodeKicadNativePadObservation(envelope,expected);
    expect(()=>verifyHostKicadNativePadObservation(pure,expected)).toThrow(/current private host collector/);
    const collected=await collectKicadNativePadObservation({async readLivePcbPadSnapshot(ids){expect(ids).toEqual(expected.requestedPrimitiveIds);return envelope;}},expected);
    expect(verifyHostKicadNativePadObservation(collected,expected)).toBe(collected);
    expect(()=>verifyHostKicadNativePadObservation(structuredClone(collected),expected)).toThrow(/current private host collector/);
    expect(()=>verifyHostKicadNativePadObservation(collected,{...expected,pcbSource:saved+"\n"})).toThrow(/current host source/);
  });
  it.each([
    ["duplicate envelope mismatch",(v:Record<string,any>)=>{v.schemaVersion="wrong";}],
    ["source drift",(v:Record<string,any>)=>{v.boardSourceAfter+="\n";}],
    ["foreign document",(v:Record<string,any>)=>{v.documentBefore.project.path="D:\\wrong";v.documentAfter=structuredClone(v.documentBefore);} ],
    ["duplicate physical ownership",(v:Record<string,any>)=>{v.footprintInventory.footprints[1].padRecordIndexes[0]=v.footprintInventory.footprints[0].padRecordIndexes[0];}],
    ["missing aperture",(v:Record<string,any>)=>{v.footprintInventory.footprints[0].padRecordIndexes.pop();}],
    ["duplicate response index",(v:Record<string,any>)=>{v.connectivity[0].padRecordIndexes.push(v.connectivity[0].padRecordIndexes[0]);}],
    ["union request",(v:Record<string,any>)=>{v.connectivity[0].request.items.push({value:v.connectivity[1].sourcePrimitiveId});}],
    ["wrong native status",(v:Record<string,any>)=>{v.connectivity[0].responseMetadata.status="IRS_UNKNOWN";}],
    ["missing layer observation",(v:Record<string,any>)=>{v.padstackPresence.response.entries.pop();}],
    ["wrong native projection",(v:Record<string,any>)=>{v.padRecords[0].position.x_nm="123";}],
  ] as const)("rejects %s",(_label,change)=>{
    expect(()=>decodeKicadNativePadObservation(mutate(change),expected)).toThrow();
  });
  it("does not turn unknown native layer presence into false or proven connectivity",()=>{
    const observation=decodeKicadNativePadObservation(mutate(v=>{v.padstackPresence.response.entries[0].presence="PSP_UNKNOWN";}),expected);
    expect(observation.inventory!.unsupportedPhysicalUuids.length).toBeGreaterThan(0);
  });
  it("binds all four real stock physical definitions, not only logical terminal counts",()=>{
    const observation=decodeKicadNativePadObservation(envelope,withLibrary);
    expect(observation.physicalLibraryBindings.map(b=>[b.reference,b.physicalPadCount,b.logicalTerminalCount])).toEqual([["S60",70,61],["S80",90,81],["T60",75,61],["T80",116,81]]);
    for(const entry of stockFixtures){
      const inspection=physicalResolver.inspectFootprint(stockId(entry))!;
      expect(inspection.physicalPads.length).toBe(observation.physicalLibraryBindings.find(b=>b.reference===entry.reference)!.physicalPadCount);
      expect(inspection.copperCommon).toBe("not-assessed");
      expect(Object.isFrozen(inspection.physicalPads[0]!.definition)).toBe(true);
    }
  });
  it("rejects an aperture removed from BOTH saved/native sources, even if the remaining native inventory agrees",()=>{
    const board=parseFreshPcbSource(saved),nativeBoard=parseFreshPcbSource(snapshot.boardSourceBefore);
    const aperture=board.footprints.find(fp=>fp.reference==="S60")!.pads.find(p=>p.number==="")!;
    const nativeAperture=nativeBoard.footprints.find(fp=>fp.reference==="S60")!.pads.find(p=>p.physical.id===aperture.physical.id)!;
    const changedSource=saved.replace(aperture.physical.source,"");
    const changed=mutate(value=>{
      value.boardSourceBefore=value.boardSourceBefore.replace(nativeAperture.physical.source,"");value.boardSourceAfter=value.boardSourceBefore;
      const index=value.padRecords.findIndex((p:any)=>p.id.value===aperture.physical.id);
      value.padRecords.splice(index,1);
      const remap=(xs:number[])=>xs.filter(i=>i!==index).map(i=>i>index?i-1:i);
      value.boardPadRecordIndexes=remap(value.boardPadRecordIndexes);
      value.footprintInventory.footprints.forEach((fp:any)=>{fp.padRecordIndexes=remap(fp.padRecordIndexes);});
      value.padstackPresence.request.items=value.padstackPresence.request.items.filter((p:any)=>p.value!==aperture.physical.id);
      value.padstackPresence.response.entries=value.padstackPresence.response.entries.filter((p:any)=>p.item.value!==aperture.physical.id);
      value.connectivity=value.connectivity.filter((q:any)=>q.sourcePrimitiveId!==aperture.physical.id);
      value.connectivity.forEach((q:any)=>{q.padRecordIndexes=remap(q.padRecordIndexes);});
    });
    const requestedPrimitiveIds=expected.requestedPrimitiveIds.filter(id=>id!==aperture.physical.id);
    // The current-source/native inventory itself is coherent, demonstrating why an independent library comparison matters.
    expect(decodeKicadNativePadObservation(changed,{...expected,pcbSource:changedSource,requestedPrimitiveIds}).inventory!.physicalPads).toHaveLength(356);
    expect(()=>decodeKicadNativePadObservation(changed,{...withLibrary,pcbSource:changedSource,requestedPrimitiveIds})).toThrow(/physical library pad inventory\/geometry differs/);
  });
  it("rejects changed paste geometry with unchanged counts in both native/saved observations",()=>{
    const board=parseFreshPcbSource(saved),nativeBoard=parseFreshPcbSource(snapshot.boardSourceBefore);
    const aperture=board.footprints.find(fp=>fp.reference==="S60")!.pads.find(p=>p.number==="")!;
    const nativeAperture=nativeBoard.footprints.find(fp=>fp.reference==="S60")!.pads.find(p=>p.physical.id===aperture.physical.id)!;
    const changedPad=aperture.physical.source.replace(/\(size\s+0\.91\s+0\.91\)/u,"(size 1.01 0.91)");
    expect(changedPad).not.toBe(aperture.physical.source);
    const changedSource=saved.replace(aperture.physical.source,changedPad);
    const changed=mutate(value=>{
      value.boardSourceBefore=value.boardSourceBefore.replace(nativeAperture.physical.source,nativeAperture.physical.source.replace(/\(size\s+0\.91\s+0\.91\)/u,"(size 1.01 0.91)"));value.boardSourceAfter=value.boardSourceBefore;
      value.padRecords.find((p:any)=>p.id.value===aperture.physical.id).pad_stack.copper_layers[0].size.x_nm="1010000";
    });
    expect(decodeKicadNativePadObservation(changed,{...expected,pcbSource:changedSource}).inventory!.physicalPads).toHaveLength(357);
    expect(()=>decodeKicadNativePadObservation(changed,{...withLibrary,pcbSource:changedSource})).toThrow(/physical library pad inventory\/geometry differs/);
  });
  it.each([
    ["roundrect corner ratio",(v:Record<string,any>)=>{v.padRecords.find((p:any)=>p.pad_stack.copper_layers[0].shape==="PSS_ROUNDRECT").pad_stack.copper_layers[0].corner_rounding_ratio=0.45;}],
    ["numbered SMD copper offset",(v:Record<string,any>)=>{v.padRecords.find((p:any)=>p.number&&p.type==="PT_SMD").pad_stack.copper_layers[0].offset={x_nm:"2000000"};}],
    ["undeclared disabled copper layer",(v:Record<string,any>)=>{v.padRecords.find((p:any)=>p.number&&p.type==="PT_SMD").pad_stack.layers.push("BL_In1_Cu");}],
    ["complete query missing its source",(v:Record<string,any>)=>{const q=v.connectivity.find((q:any)=>q.padRecordIndexes.length>0);q.padRecordIndexes=q.padRecordIndexes.filter((i:number)=>v.padRecords[i].id.value!==q.sourcePrimitiveId);}],
    ["secondary drill",(v:Record<string,any>)=>{v.padRecords[0].pad_stack.secondary_drill={diameter:{x_nm:"500000",y_nm:"500000"}};}],
    ["custom shape addition",(v:Record<string,any>)=>{v.padRecords[0].pad_stack.copper_layers[0].custom_shapes=[{}];}],
    ["changed plated drill span",(v:Record<string,any>)=>{v.padRecords.find((p:any)=>p.type==="PT_PTH").pad_stack.drill.start_layer="BL_In1_Cu";}],
    ["unmodeled filled drill",(v:Record<string,any>)=>{v.padRecords.find((p:any)=>p.type==="PT_PTH").pad_stack.drill.filled=true;}],
  ] as const)("closes reviewed raw-to-source gap: %s",(_name,change)=>{
    expect(()=>decodeKicadNativePadObservation(mutate(change),withLibrary)).toThrow();
  });
});
