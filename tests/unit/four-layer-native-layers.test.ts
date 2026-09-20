import { describe, expect, it } from "vitest";
import { createInterfaceConstructionBoardSeed } from "../../src/harness/interface-construction-seed.js";
import { assertFreshPlaneReferenceCopperScope } from "../../src/harness/fresh-clearance-evidence.js";
import { assertPlaneIncrementalRouteGeometry, parsePlaneRouteMutationArguments } from "../../src/harness/fresh-plane-route-mutation.js";
import { prepareFreshPlaneMutation } from "../../src/harness/fresh-plane-mutation.js";
import { fourLayerPlaneBundle } from "../helpers/four-layer-plane-bundle.js";
import { canonicalIdentity } from "../../src/core/canonical.js";
import type { FreshRouteSelectionItem } from "../../src/harness/kicad-tools.js";

const bundle = fourLayerPlaneBundle(), layers = bundle.contract.scope.board.copperLayers;
const seed = createInterfaceConstructionBoardSeed(bundle);
const insert = (item: string) => seed.slice(0,seed.lastIndexOf(")"))+item+"\n)\n";
const width = bundle.contract.netClasses.find(c=>c.id==="POWER")!.traceWidthMm;
const track = (id:string,layer:string,x1=9,y1=10,x2=10,y2=10): FreshRouteSelectionItem => ({
  kind:"track",id,net:"GND",start:{xMm:x1,yMm:y1},end:{xMm:x2,yMm:y2},layer,widthMm:width });
const groundSegment = '(segment (start 9 10) (end 10 10) (width 0.5) (layer "In1.Cu") (net "GND") (uuid "22222222-2222-4222-8222-222222222222"))';

describe("four-layer source and mutation layer boundaries",()=>{
  it("requires the exact host-selected enabled layer scope and native ordinal mapping",()=>{
    expect(()=>assertFreshPlaneReferenceCopperScope(seed,layers)).not.toThrow();
    expect(()=>assertFreshPlaneReferenceCopperScope(seed)).toThrow("declared construction");
    expect(()=>assertFreshPlaneReferenceCopperScope(seed.replace('(4 "In1.Cu"','(8 "In1.Cu"'),layers)).toThrow("ordinal");
    expect(()=>assertFreshPlaneReferenceCopperScope(seed.replace('(4 "In1.Cu" signal)','(4 "In1.Cu" signal) (8 "HiddenCopper" signal)'),layers)).toThrow("canonical copper-layer name");
    expect(()=>assertFreshPlaneReferenceCopperScope(seed.replaceAll('In2.Cu','In3.Cu'),layers)).toThrow("canonical copper-layer name");
    expect(()=>assertFreshPlaneReferenceCopperScope(seed.replace('20260206','20250316'),layers)).toThrow();
  });
  it("retains inner tracks while rejecting ambiguous copper, inner footprint faces and unsupported graphics",()=>{
    expect(()=>assertFreshPlaneReferenceCopperScope(insert(groundSegment),layers)).not.toThrow();
    for(const item of [
      groundSegment.replace('(layer "In1.Cu")','(layers "*.Cu")'),
      groundSegment.replace('(layer "In1.Cu")','(layers "In1.Cu" "F.Mask")'),
      '(footprint "Fixture:Pad" (layer "In1.Cu") (at 10 10))',
      '(gr_text "copper" (at 10 10) (layer "In2.Cu") (effects (font (size 1 1))))',
      '(footprint "Fixture:Pad" (layer "F.Cu") (property "Value" "copper" (at 0 0) (layer "In1.Cu")))',
      '(via (at 10 10) (size 0.6) (drill 0.3) (layers "F.Cu" "In1.Cu") (net "GND"))',
    ]) expect(()=>assertFreshPlaneReferenceCopperScope(insert(item),layers)).toThrow();
  });
  it("accepts explicit inner routing only within the board and net-class scope",()=>{
    for(const layer of ["In1.Cu","In2.Cu"]) expect(()=>assertPlaneIncrementalRouteGeometry(bundle.contract,"GND",[track("t",layer)])).not.toThrow();
    expect(()=>assertPlaneIncrementalRouteGeometry(bundle.contract,"GND",[track("t","In3.Cu")])).toThrow("layer");
    const input={selectionIdentity:canonicalIdentity({},"evleda.fresh-plane-route-selection.v1"),net:"GND",deleteItemIds:[],
      tracks:[{x1Mm:9,y1Mm:10,x2Mm:10,y2Mm:10,layer:"In1.Cu"}],vias:[]};
    expect(parsePlaneRouteMutationArguments(input).tracks[0]!.layer).toBe("In1.Cu");
    expect(()=>parsePlaneRouteMutationArguments({...input,tracks:[{...input.tracks[0],layer:"In3.Cu"}]})).toThrow();
  });
  it("recognizes through-barrel contact on inner layers while rejecting blind spans",()=>{
    const joined=[track("a","In1.Cu"),track("b","In1.Cu",10,10,11,10),track("c","In1.Cu",10,10,11,11)];
    expect(()=>assertPlaneIncrementalRouteGeometry(bundle.contract,"GND",joined)).toThrow();
    const via:FreshRouteSelectionItem={kind:"via",id:"v",net:"GND",at:{xMm:10,yMm:10},diameterMm:.6,drillMm:.3,layers:["F.Cu","B.Cu"]};
    // Contact attribution is distinct from complete-board turn and route acceptance.
    expect(()=>assertPlaneIncrementalRouteGeometry(bundle.contract,"GND",[...joined,via])).not.toThrow();
    expect(()=>assertPlaneIncrementalRouteGeometry(bundle.contract,"GND",[...joined,{...via,layers:["In1.Cu","B.Cu"]}])).toThrow();
    expect(()=>assertPlaneIncrementalRouteGeometry(bundle.contract,"GND",[track("a","In1.Cu"),track("b","In1.Cu",10,10,10,11),via])).toThrow("turn bound");
  });
  it("requires an explicit plane selector when preparing a multi-plane mutation",()=>{
    const source=insert(groundSegment);
    expect(()=>prepareFreshPlaneMutation({compilationBundle:bundle,beforePcbSource:source,operation:"create"})).toThrow("explicit plane ID");
    const prepared=prepareFreshPlaneMutation({compilationBundle:bundle,beforePcbSource:source,planeId:"GND_PLANE",operation:"create"});
    expect(prepared.mutation.layer).toBe("In1.Cu");
    expect(()=>prepareFreshPlaneMutation({compilationBundle:bundle,beforePcbSource:source.replace('(4 "In1.Cu"','(8 "In1.Cu"'),planeId:"GND_PLANE",operation:"create"})).toThrow("ordinal");
  });
});
