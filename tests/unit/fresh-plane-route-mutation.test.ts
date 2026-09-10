import { describe, expect, it } from "vitest";
import { canonicalIdentity } from "../../src/core/canonical.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { genericDividerLibraryResolver } from "../helpers/generic-divider-bundle.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";
import { assertPlaneIncrementalRouteGeometry, assertPlaneRouteSourcePreservation, parsePlaneRouteMutationArguments } from "../../src/harness/fresh-plane-route-mutation.js";
import type { FreshContractPadPosition, FreshRouteSelectionItem } from "../../src/harness/kicad-tools.js";

const compiled=compilePcbPlaneDesignIntentDraft(planeDividerDraft(),{libraryResolver:genericDividerLibraryResolver,deepRuleCatalog:loadDeepRuleCatalog()});
if(compiled.disposition!=="ready")throw new Error(JSON.stringify(compiled.issues));
const contract=compiled.contract;
const width=contract.netClasses.find(c=>c.id===contract.nets.find(n=>n.name==='GND')!.netClassId)!.traceWidthMm;
const track=(id:string,x1:number,y1:number,x2:number,y2:number,overrides:Partial<Extract<FreshRouteSelectionItem,{kind:'track'}>>={}):FreshRouteSelectionItem=>({kind:'track',id,net:'GND',start:{xMm:x1,yMm:y1},end:{xMm:x2,yMm:y2},widthMm:width,layer:'F.Cu',...overrides});
const via=(id:string,x=10,y=10,overrides:Partial<Extract<FreshRouteSelectionItem,{kind:'via'}>>={}):FreshRouteSelectionItem=>({kind:'via',id,net:'GND',at:{xMm:x,yMm:y},diameterMm:0.6,drillMm:0.3,layers:['F.Cu','B.Cu'],...overrides});
const run=(items:readonly FreshRouteSelectionItem[],pads:readonly FreshContractPadPosition[]=[])=>assertPlaneIncrementalRouteGeometry(contract,'GND',items,pads);
const pad:FreshContractPadPosition={reference:'J1',pad:'3',net:'GND',xMm:10,yMm:10,layers:['F.Cu'],physical:{id:'pad',footprintId:'fp',padType:'smd',shape:'rect',sizeMm:{x:1,y:1},drill:null}};

describe('incremental plane route geometry, not completed-route acceptance',()=>{
  it('permits empty selected-net copper after deletion, partial access ends, and separated strokes',()=>{
    expect(()=>run([])).not.toThrow();
    expect(()=>run([track('a',5,10,6,10)])).not.toThrow();
    expect(()=>run([track('a',5,10,6,10),track('b',15,10,16,10)])).not.toThrow();
  });
  it('permits a through via with no track on its declared plane layer without claiming plane contact',()=>{
    expect(()=>run([track('a',9,10,10,10),via('v')])).not.toThrow();
  });
  it('does not apply the V1 acyclic-tree requirement to a nonintersecting 45-degree closed loop',()=>{
    const points=[[10,10],[10.5,10],[11,10.5],[11,11],[10.5,11.5],[10,11.5],[9.5,11],[9.5,10.5]];
    const items=points.map((p,i)=>{const q=points[(i+1)%points.length]!;return track(String(i),p[0]!,p[1]!,q[0]!,q[1]!);});
    expect(()=>run(items)).not.toThrow();
  });
  it.each([
    ['undersized retained width',()=>[track('a',5,10,6,10,{widthMm:width/2})]],
    ['wrong layer',()=>[track('a',5,10,6,10,{layer:'B.Cu'})]],
    ['non-45 segment',()=>[track('a',5,10,6,10.2)]],
    ['zero span',()=>[track('a',5,10,5,10)]],
    ['copper outside edge margin',()=>[track('a',0.6,10,1.6,10)]],
    ['90-degree turn',()=>[track('a',5,10,6,10),track('b',6,10,6,11)]],
    ['short pre-turn segment',()=>[track('a',5,10,5.01,10),track('b',5.01,10,6.01,11)]],
    ['backtracking overlap',()=>[track('a',5,10,7,10),track('b',7,10,6,10)]],
    ['crossing',()=>[track('a',5,10,7,12),track('b',5,12,7,10)]],
    ['duplicate track',()=>[track('a',5,10,6,10),track('b',5,10,6,10)]],
    ['unsupported via layer',()=>[via('v',10,10,{layers:['F.Cu']})]],
    ['undersized via diameter',()=>[via('v',10,10,{diameterMm:0.5})]],
    ['invalid via annular ring',()=>[via('v',10,10,{drillMm:0.5})]],
    ['duplicate via',()=>[via('v'),via('w')]],
    ['too many vias',()=>[via('v'),via('w',12),via('x',14)]],
    ['route length excess',()=>[track('a',5,10,16,10)]],
  ] as const)('rejects known %s without demanding full connectivity',(_label,items)=>{expect(()=>run(items())).toThrow();});
  it('does not drop GND route ownership or permit an unknown net',()=>{
    expect(()=>assertPlaneIncrementalRouteGeometry(contract,'MISSING',[])).toThrow(/exact V2/);
  });
  it('rejects a via on a continuous-plane referenced signal which forbids layer transitions',()=>{
    expect(()=>assertPlaneIncrementalRouteGeometry(contract,'VIN',[via('v',10,10,{net:'VIN'})])).toThrow(/via bound|layer transitions/);
  });
  it('permits characterized pad/via center junctions but explicitly rejects unresolved free-space branching',()=>{
    const items=[track('a',9,10,10,10),track('b',10,10,11,10),track('c',10,10,10,11)];
    expect(()=>run(items)).toThrow(/multiway/);
    expect(()=>run(items,[pad])).not.toThrow();
    expect(()=>run([...items,via('v')])).not.toThrow();
    expect(()=>run(items,[{...pad,layers:['B.Cu']}])).toThrow(/multiway/);
    expect(()=>run(items,[{...pad,physical:{...pad.physical!,padType:'np_thru_hole'}}])).toThrow(/multiway/);
    const corner=[track('a',9,10,10,10),track('b',10,10,10,11)];
    expect(()=>run(corner,[pad])).toThrow(/turn bound/);
    expect(()=>run([...corner,via('v')])).toThrow(/turn bound/);
  });
  it('permits append/deletion-only args but excludes V1 selections, fabricated dimensions and empty no-ops',()=>{
    const args={selectionIdentity:canonicalIdentity({},'evleda.fresh-plane-route-selection.v1'),net:'GND',deleteItemIds:[],tracks:[{x1Mm:9,y1Mm:10,x2Mm:10,y2Mm:10,layer:'F.Cu'}],vias:[]};
    expect(parsePlaneRouteMutationArguments(args).deleteItemIds).toEqual([]);
    expect(parsePlaneRouteMutationArguments({...args,deleteItemIds:['id'],tracks:[]}).tracks).toEqual([]);
    expect(()=>parsePlaneRouteMutationArguments({...args,tracks:[]})).toThrow(/at least one/);
    expect(()=>parsePlaneRouteMutationArguments({...args,selectionIdentity:canonicalIdentity({},'evleda.fresh-route-selection.v1')})).toThrow();
    expect(()=>parsePlaneRouteMutationArguments({...args,tracks:[{...args.tracks[0],widthMm:0.01}]})).toThrow();
    expect(()=>parsePlaneRouteMutationArguments({...args,deleteItemIds:['id','id']})).toThrow(/unique/);
  });
});

describe('positive collinear overlap is not exempted by characterized centers',()=>{
  // The ordinary GND fixture's 10 mm length cap would mask several overlap failures.
  const overlapContract={...contract,routingConstraints:{...contract.routingConstraints,
    nets:contract.routingConstraints.nets.map(route=>route.net==='GND'&&route.topology==='plane'
      ? {...route,accessRouting:{...route.accessRouting,routeLength:{mode:'bounded' as const,maximumMm:100}}}
      : route),
  }};
  const overlapRun=(items:readonly FreshRouteSelectionItem[],pads:readonly FreshContractPadPosition[]=[])=>assertPlaneIncrementalRouteGeometry(overlapContract,'GND',items,pads);
  const padAt=(xMm:number,yMm:number,index:number):FreshContractPadPosition=>({...pad,pad:String(index+1),xMm,yMm,
    physical:{...pad.physical!,id:`overlap-pad-${index}`}});

  describe.each(['no characterized contacts','pad centers','via centers'] as const)('%s',contacts=>{
    it.each([
      ['partial',[2,3,8,3],[3,3,9,3],[[3,3],[8,3]]],
      ['contained',[2,3,8,3],[3,3,7,3],[[3,3],[7,3]]],
      ['reversed partial',[8,3,2,3],[9,3,3,3],[[3,3],[8,3]]],
      ['oppositely directed partial',[2,3,8,3],[9,3,3,3],[[3,3],[8,3]]],
      ['identical',[2,3,8,3],[2,3,8,3],[[2,3],[8,3]]],
      ['reversed identical',[2,3,8,3],[8,3,2,3],[[2,3],[8,3]]],
      ['vertical',[3,2,3,8],[3,3,3,9],[[3,3],[3,8]]],
      ['rising 45-degree',[2,2,8,8],[3,3,9,9],[[3,3],[8,8]]],
      ['falling 45-degree',[2,9,8,3],[3,8,9,2],[[3,8],[8,3]]],
    ] as const)('rejects %s positive collinear overlap',(_name,a,b,boundaries)=>{
      const tracks=[track('a',a[0],a[1],a[2],a[3]),track('b',b[0],b[1],b[2],b[3])];
      const pads=contacts==='pad centers'?boundaries.map(([x,y],index)=>padAt(x,y,index)):[];
      const vias=contacts==='via centers'?boundaries.map(([x,y],index)=>via(`v${index}`,x,y)):[];
      expect(()=>overlapRun([...tracks,...vias],pads)).toThrow(/overlap/);
    });
  });

  it.each([false,true])('rejects a one-nanometre positive overlap with characterized pad centers: %s',withPads=>{
    const items=[track('a',2,3,6,3),track('b',5.999999,3,9,3)];
    const pads=withPads?[padAt(5.999999,3,0),padAt(6,3,1)]:[];
    expect(()=>overlapRun(items,pads)).toThrow(/overlap/);
  });

  it.each([
    ['horizontal',[2,3,6,3],[6,3,9,3]],
    ['reversed horizontal',[6,3,2,3],[9,3,6,3]],
    ['vertical',[3,2,3,6],[3,6,3,9]],
    ['rising 45-degree',[2,2,6,6],[6,6,9,9]],
    ['falling 45-degree',[2,9,6,5],[6,5,9,2]],
  ] as const)('permits %s segments touching at one shared endpoint',(_name,a,b)=>{
    expect(()=>overlapRun([track('a',a[0],a[1],a[2],a[3]),track('b',b[0],b[1],b[2],b[3])])).not.toThrow();
  });

  it('keeps coincident copper on distinct layers outside the overlap comparison',()=>{
    const signalNet=contract.nets.find(net=>net.name==='VOUT')!;
    const signalClass=contract.netClasses.find(netClass=>netClass.id===signalNet.netClassId)!;
    const eitherLayerContract={...contract,
      netClasses:contract.netClasses.map(netClass=>netClass.id===signalClass.id
        ? {...netClass,allowedLayers:['F.Cu','B.Cu'] as const}
        : netClass),
      routingConstraints:{...contract.routingConstraints,
        nets:contract.routingConstraints.nets.map(route=>route.net===signalNet.name&&route.topology!=='plane'
          ? {...route,preferredLayer:'either' as const,referencePath:{mode:'none' as const}}
          : route),
      },
    };
    expect(()=>assertPlaneIncrementalRouteGeometry(eitherLayerContract,signalNet.name,[
      track('a',2,3,8,3,{net:signalNet.name,widthMm:signalClass.traceWidthMm}),
      track('b',2,3,8,3,{net:signalNet.name,widthMm:signalClass.traceWidthMm,layer:'B.Cu'}),
    ])).not.toThrow();
  });

  it('compares only tracks belonging to the selected net',()=>{
    expect(()=>overlapRun([track('a',2,3,8,3),track('b',2,3,8,3,{net:'VIN'})])).not.toThrow();
  });
});

describe('exact plane incremental route source preservation',()=>{
  const oldId='11111111-1111-4111-8111-111111111111',newId='22222222-2222-4222-8222-222222222222';
  const route=(id:string,x=10)=>`(segment (start 5 10) (end ${x} 10) (width 0.5) (layer "F.Cu") (net "GND") (uuid "${id}"))`;
  const zone='(zone (net_name "GND") (layer "B.Cu") (uuid "33333333-3333-4333-8333-333333333333") (hatch edge 0.5) (fill yes (thermal_gap 0.25)) (polygon (pts (xy 1 1) (xy 29 1) (xy 29 19) (xy 1 19))))';
  const board=(items:string)=>`(kicad_pcb (version 20260206) (general (thickness 1.6)) ${zone} ${items})`;
  it('excludes exactly selected deleted/added spans while retaining an existing zone and all settings',()=>{
    expect(()=>assertPlaneRouteSourcePreservation(board(route(oldId)),board(route(newId,11)),[oldId],[newId])).not.toThrow();
    expect(()=>assertPlaneRouteSourcePreservation(board(''),board(route(newId)),[],[newId])).not.toThrow();
    expect(()=>assertPlaneRouteSourcePreservation(board(route(oldId)),board(''),[oldId],[])).not.toThrow();
  });
  it.each([
    ['thickness',(source:string)=>source.replace('(thickness 1.6)','(thickness 1.7)')],
    ['zone thermal setting',(source:string)=>source.replace('(thermal_gap 0.25)','(thermal_gap 0.35)')],
    ['zone layer',(source:string)=>source.replace('(layer "B.Cu")','(layer "F.Cu")')],
    ['added board metadata',(source:string)=>source.replace('(version 20260206)','(version 20260206) (property "extra" "changed")')],
  ] as const)('rejects unrelated %s mutation',(_name,change)=>{
    expect(()=>assertPlaneRouteSourcePreservation(board(route(oldId)),change(board(route(newId,11))),[oldId],[newId])).toThrow(/nonselected source/);
  });
  it('does not admit a zone identity or an unselected track through the route exclusion list',()=>{
    expect(()=>assertPlaneRouteSourcePreservation(board(route(oldId)),board(''),['33333333-3333-4333-8333-333333333333'],[])).toThrow(/selected direct route/);
    expect(()=>assertPlaneRouteSourcePreservation(board(route(oldId)),board(route(oldId,11)+route(newId)),[],[newId])).toThrow(/nonselected source/);
  });
});
