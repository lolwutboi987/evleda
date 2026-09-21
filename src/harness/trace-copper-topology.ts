import type { TerminalCopperPad, TerminalCopperTrack, TerminalCopperVia } from "./plane-terminal-copper-paths.js";
import { cf,ca,cs,cm,cc,cp,cpointKey,cpointEqual,cadd,csub,cscale,cdot,ccross,copperPointOnSegment,copperProject,copperIntersection,
  copperClosest,copperContains,copperBounds,copperRelation,copperWitness,copperSerializedPoint,
  type CopperPoint, type CopperShape } from "./trace-copper-geometry.js";

export interface TraceCopperTopologyInput {
  readonly pads: readonly TerminalCopperPad[]; readonly vias: readonly TerminalCopperVia[]; readonly tracks: readonly TerminalCopperTrack[];
  /** Complete exact circular/cardinal-slot inventory, including foreign nets. */
  readonly bores: readonly Readonly<{uuid:string;centerNm:Readonly<{x:number;y:number}>;diameterNm:number;slot?:Readonly<{majorDiameterNm:number;axis:"x"|"y"}>}>[];
  readonly boardBoundsNm:Readonly<{minX:number;maxX:number;minY:number;maxY:number}>;
  readonly topology:"point_to_point"|"tree";
}
interface Primitive {readonly id:string;readonly kind:"pad"|"via"|"track";readonly layers:readonly string[];readonly shape:CopperShape;readonly terminal:string|null;readonly a?:CopperPoint;readonly b?:CopperPoint}
const requireValue:(v:unknown,why:string)=>asserts v=(v,why)=>{if(!v)throw new Error(`Trace topology: ${why}`);};
const uniquePoints=(v:readonly CopperPoint[])=>[...new Map(v.map(p=>[cpointKey(p),p])).values()];
const rectangular=(x:CopperPoint,w:ReturnType<typeof cf>,h:ReturnType<typeof cf>):readonly CopperPoint[]=>uniquePoints([
  {x:cs(x.x,w),y:cs(x.y,h)},{x:ca(x.x,w),y:cs(x.y,h)},{x:ca(x.x,w),y:ca(x.y,h)},{x:cs(x.x,w),y:ca(x.y,h)}]);
function padShape(p:TerminalCopperPad):CopperShape{
  const center=cp(p.centerNm.x,p.centerNm.y),w=cf(p.sizeNm.x,2),h=cf(p.sizeNm.y,2);
  if(p.shape==='rectangle')return{core:rectangular(center,w,h),radius:cf(0)};
  if(p.shape==='roundrect'){const r=cf(p.cornerRadiusNm);return{core:rectangular(center,cs(w,r),cs(h,r)),radius:r};}
  const radius=cc(w,h)<0?w:h;return{core:rectangular(center,cs(w,radius),cs(h,radius)),radius};
}
const pairKey=(a:number,b:number)=>a<b?`${a}:${b}`:`${b}:${a}`;
export class TraceCopperTopologyBoundError extends Error {
  constructor(message:string,readonly knownViolations:readonly string[]){super(message);this.name='TraceCopperTopologyBoundError';}
}
/** Exact source-spine topology plus complete finite-envelope contact accounting.
 * Connected intrinsic pad/via bodies may contract local copper, never a package
 * internal tie or a plane. Unproved geometry/contact coverage stays unknown. */
export function assessTraceCopperTopology(input:TraceCopperTopologyInput){
  const unresolved:string[]=[],violations:string[]=[];
  const bound=(value:boolean,message:string)=>{if(!value)throw new TraceCopperTopologyBoundError(`Trace topology: ${message}`,[...new Set(violations)]);};
  let operations=0;const work=()=>{bound(++operations<=4_000_000,'geometry work limit');};
  const integer=(n:number)=>requireValue(Number.isSafeInteger(n)&&Math.abs(n)<=2_000_000_000,'integer-nanometre bound');
  const point=(p:Readonly<{x:number;y:number}>)=>{integer(p.x);integer(p.y);return cp(p.x,p.y);};
  requireValue(input.tracks.length<=1536&&input.vias.length<=256&&input.pads.length<=512&&input.bores.length<=4096,'inventory bounds');
  requireValue(input.pads.length>0&&input.tracks.length>0,'physical pads and routed tracks required');
  const primitives:Primitive[]=[];
  for(const p of input.pads){point(p.centerNm);integer(p.sizeNm.x);integer(p.sizeNm.y);integer(p.cornerRadiusNm);requireValue(p.sizeNm.x>0&&p.sizeNm.y>0,'positive pad');
    requireValue(['rectangle','roundrect','oval','circle'].includes(p.shape),'supported convex pad shape');
    requireValue(p.platedThrough?p.layers.length>=2:p.layers.length===1,'qualified normal pad layers');
    requireValue(p.platedThrough?input.bores.some(b=>b.uuid===p.uuid):!input.bores.some(b=>b.uuid===p.uuid),'pad bore and plating correspondence');
    requireValue(p.shape==='roundrect'?p.cornerRadiusNm>0&&2*p.cornerRadiusNm<=Math.min(p.sizeNm.x,p.sizeNm.y):p.cornerRadiusNm===0,'pad radius');
    requireValue(p.shape!=='circle'||p.sizeNm.x===p.sizeNm.y,'circle dimensions');primitives.push({id:p.uuid,kind:'pad',layers:p.layers,shape:padShape(p),terminal:`${p.reference}:${p.pin}`});}
  for(const v of input.vias){point(v.centerNm);integer(v.diameterNm);integer(v.drillNm);requireValue(v.diameterNm>v.drillNm&&v.drillNm>0&&v.layers.length>=2,'normal through via');
    const bore=input.bores.find(b=>b.uuid===v.uuid);requireValue(bore&&!bore.slot&&bore.diameterNm===v.drillNm&&bore.centerNm.x===v.centerNm.x&&bore.centerNm.y===v.centerNm.y,'via bore correspondence');
    primitives.push({id:v.uuid,kind:'via',layers:v.layers,shape:{core:[point(v.centerNm)],radius:cf(v.diameterNm,2)},terminal:null});}
  const bodyCount=primitives.length;
  for(const t of input.tracks){const a=point(t.startNm),b=point(t.endNm);integer(t.widthNm);requireValue(t.widthNm>0&&!cpointEqual(a,b),'nonzero positive-width track');
    const dx=Math.abs(t.startNm.x-t.endNm.x),dy=Math.abs(t.startNm.y-t.endNm.y);requireValue(dx===0||dy===0||dx===dy,'straight axis/45-degree source');
    primitives.push({id:t.uuid,kind:'track',layers:[t.layer],shape:{core:[a,b],radius:cf(t.widthNm,2)},terminal:null,a,b});}
  requireValue(new Set(primitives.map(p=>p.id)).size===primitives.length&&primitives.every(p=>/^[A-Za-z0-9_-]{1,128}$/.test(p.id)),'unique bounded primitive IDs');
  for(const p of primitives)requireValue(p.layers.length>0&&new Set(p.layers).size===p.layers.length&&p.layers.every(l=>/^(?:F|B|In(?:[1-9]|[12][0-9]|30))\.Cu$/.test(l)),'copper layers');
  const bores=input.bores.map(b=>{integer(b.diameterNm);requireValue(b.diameterNm>0,'bore size');const center=point(b.centerNm);let core:readonly CopperPoint[]=[center];
    if(b.slot){integer(b.slot.majorDiameterNm);requireValue(b.slot.majorDiameterNm>=b.diameterNm&&['x','y'].includes(b.slot.axis),'cardinal slot');const d=cf(b.slot.majorDiameterNm-b.diameterNm,2),v=b.slot.axis==='x'?{x:d,y:cf(0)}:{x:cf(0),y:d};core=uniquePoints([csub(center,v),cadd(center,v)]);}
    return{id:b.uuid,shape:{core,radius:cf(b.diameterNm,2)}};});
  requireValue(new Set(bores.map(b=>b.id)).size===bores.length,'unique complete bore IDs');Object.values(input.boardBoundsNm).forEach(integer);
  const bounds=input.boardBoundsNm;requireValue(bounds.minX<bounds.maxX&&bounds.minY<bounds.maxY,'board rectangle');
  const corners=(s:CopperShape)=>{const b=copperBounds(s);return [{x:b.minX,y:b.minY},{x:b.maxX,y:b.minY},{x:b.maxX,y:b.maxY},{x:b.minX,y:b.maxY}];};
  const boreClear=(p:CopperPoint)=>bores.every(b=>!copperContains(b.shape,p,false,work));
  const interiorEvidence=primitives.map((p,i)=>{
    const b=copperBounds(p.shape),inside=cc(b.minX,cf(bounds.minX))>0&&cc(b.maxX,cf(bounds.maxX))<0&&cc(b.minY,cf(bounds.minY))>0&&cc(b.maxY,cf(bounds.maxY))<0;
    if(!inside)unresolved.push(`BOARD_CLIPPING:${p.id}`);
    const intersecting=bores.filter(b=>copperRelation(p.shape,b.shape,work)!=='separate');
    let connected=inside;
    if(i<bodyCount){
      if(i<input.pads.length&&input.pads[i]!.platedThrough){const own=bores.find(b=>b.id===p.id)!;if(!corners(own.shape).every(q=>copperContains(p.shape,q,true,work)))connected=false;}
      if(intersecting.some(b=>!corners(b.shape).every(q=>copperContains(p.shape,q,true,work))))connected=false;
      for(let a=0;a<intersecting.length;a++)for(let z=a+1;z<intersecting.length;z++)if(copperRelation(intersecting[a]!.shape,intersecting[z]!.shape,work)!=='separate')connected=false;
    }else for(const bore of intersecting){const owner=primitives.slice(0,bodyCount).find(b=>b.id===bore.id);if(!owner||!owner.layers.some(l=>p.layers.includes(l))||!corners(bore.shape).every(q=>copperContains(owner.shape,q,true,work)))connected=false;}
    if(!connected)unresolved.push(`DRILLED_PRIMITIVE_INTERIOR:${p.id}`);
    const witness=copperWitness([p.shape],work,[],boreClear);if(!witness)unresolved.push(`NO_POSITIVE_COPPER_WITNESS:${p.id}`);
    return{id:p.id,kind:p.kind,connectedCarrier:connected&&witness!==null,positiveCopperWitness:witness?copperSerializedPoint(witness):null};
  });
  const cuts=input.tracks.map(t=>uniquePoints([point(t.startNm),point(t.endNm)]));
  let cutCount=2*input.tracks.length;
  const cut=(index:number,p:CopperPoint)=>{bound(++cutCount<=65536,'source cut limit');cuts[index]!.push(p);};
  for(let i=0;i<input.tracks.length;i++)for(let j=i+1;j<input.tracks.length;j++){
    work();const a=primitives[bodyCount+i]!,b=primitives[bodyCount+j]!;if(a.layers[0]!==b.layers[0])continue;
    const hit=copperIntersection(a.a!,a.b!,b.a!,b.b!);if(hit){cut(i,hit);cut(j,hit);}
    if(cc(ccross(csub(a.b!,a.a!),csub(b.b!,b.a!)),cf(0))===0){const overlap=uniquePoints([a.a!,a.b!,b.a!,b.b!].filter(p=>copperPointOnSegment(p,a.a!,a.b!)&&copperPointOnSegment(p,b.a!,b.b!)));if(overlap.length>1)violations.push(`DUPLICATE_OR_OVERLAPPING_SOURCE:${a.id}:${b.id}`);}
  }
  const potential=new Map<string,{a:number;b:number;relation:string;layers:string[]}>(),physicalWitnesses=new Map<string,CopperPoint>(),outerWitnesses=new Map<string,CopperPoint>();
  const contacts: Array<{first:string;second:string;kind:string;witness:ReturnType<typeof copperSerializedPoint>|null;via?:string}>=[];
  const covered=new Set<string>();
  for(let i=0;i<primitives.length;i++)for(let j=i+1;j<primitives.length;j++){
    work();const a=primitives[i]!,b=primitives[j]!,layers=a.layers.filter(l=>b.layers.includes(l));if(!layers.length)continue;
    const relation=copperRelation(a.shape,b.shape,work);if(relation==='separate')continue;const key=pairKey(i,j);bound(potential.size<131072,'contact inventory limit');potential.set(key,{a:i,b:j,relation,layers});
    const outer=copperWitness([a.shape,b.shape],work,[],()=>true,false);if(outer)outerWitnesses.set(key,outer);
    if(i<bodyCount){const actual=copperWitness([a.shape,b.shape],work,outer?[outer]:[],boreClear);if(actual){physicalWitnesses.set(key,actual);covered.add(key);contacts.push({first:a.id,second:b.id,kind:'positive-body-contact',witness:copperSerializedPoint(actual)});
      if(j>=bodyCount){const nearest=copperClosest(a.shape,b.shape,work);cut(j-bodyCount,nearest.b);}}
    }
  }
  const nodes:Array<{point:CopperPoint|null;layer:string|null;bodies:Set<number>}>=[],parents:number[]=[],nodeLookup=new Map<string,number>();
  const add=(p:CopperPoint|null,layer:string|null,body?:number)=>{const key=body===undefined?`${layer}:${cpointKey(p!)}`:`body:${body}`;let index=nodeLookup.get(key);if(index===undefined){bound(nodes.length<65536,'source node limit');index=nodes.length;nodeLookup.set(key,index);nodes.push({point:p,layer,bodies:new Set(body===undefined?[]:[body])});parents.push(index);}return index;};
  const find=(i:number):number=>parents[i]===i?i:(parents[i]=find(parents[i]!));const join=(a:number,b:number)=>{parents[find(a)]=find(b);};
  const bodyNodes=primitives.slice(0,bodyCount).map((_,i)=>add(null,null,i));
  for(const[key,pair]of potential)if(pair.b<bodyCount&&physicalWitnesses.has(key))join(bodyNodes[pair.a]!,bodyNodes[pair.b]!);
  const sourceEdges:Array<{a:number;b:number;track:number}>=[],trackNodes: number[][]=[];
  for(let i=0;i<input.tracks.length;i++){
    const p=primitives[bodyCount+i]!,direction=csub(p.b!,p.a!);const ordered=uniquePoints(cuts[i]!).sort((a,b)=>cc(cdot(csub(a,p.a!),direction),cdot(csub(b,p.a!),direction)));
    const ids=ordered.map(q=>add(q,p.layers[0]!));trackNodes.push(ids);for(let j=1;j<ids.length;j++){bound(sourceEdges.length<65536,'source edge limit');sourceEdges.push({a:ids[j-1]!,b:ids[j]!,track:bodyCount+i});}
    for(let body=0;body<bodyCount;body++){
      const b=primitives[body]!;if(!b.layers.includes(p.layers[0]!)||!physicalWitnesses.has(pairKey(body,bodyCount+i)))continue;
      for(let j=0;j<ordered.length;j++){
        const crossSection:CopperShape={core:[ordered[j]!],radius:p.shape.radius};
        if(copperRelation(crossSection,b.shape,work)==='overlapping')join(ids[j]!,bodyNodes[body]!);
      }
    }
  }
  // A source junction is one common cross-section, not another independent path.
  for(const[key,pair]of potential)if(pair.a>=bodyCount){const left=trackNodes[pair.a-bodyCount]!,right=trackNodes[pair.b-bodyCount]!;
    const shared=left.find(i=>right.includes(i));if(shared!==undefined){covered.add(key);contacts.push({first:primitives[pair.a]!.id,second:primitives[pair.b]!.id,kind:'exact-source-junction',witness:copperSerializedPoint(nodes[shared]!.point!)});}}
  // Finite-width overlap around a bend can be covered by an already connected
  // third convex envelope. Every such closure retains an exact common point.
  let changed=true;
  while(changed){changed=false;for(const[key,pair]of potential){if(covered.has(key))continue;
    for(let middle=0;middle<primitives.length;middle++){
      work();if(middle===pair.a||middle===pair.b||!covered.has(pairKey(pair.a,middle))||!covered.has(pairKey(pair.b,middle)))continue;
      if(!pair.layers.some(l=>primitives[middle]!.layers.includes(l)))continue;
      const sample=copperWitness([primitives[pair.a]!.shape,primitives[pair.b]!.shape,primitives[middle]!.shape],work,
        [outerWitnesses.get(key),outerWitnesses.get(pairKey(pair.a,middle)),outerWitnesses.get(pairKey(pair.b,middle))].filter((p):p is CopperPoint=>p!==undefined),()=>true,false);
      if(sample){covered.add(key);contacts.push({first:primitives[pair.a]!.id,second:primitives[pair.b]!.id,kind:'common-convex-contact-cover',via:primitives[middle]!.id,witness:copperSerializedPoint(sample)});changed=true;break;}
    }
  }}
  for(const[key,pair]of potential)if(!covered.has(key))unresolved.push(`UNACCOUNTED_FINITE_CONTACT:${primitives[pair.a]!.id}:${primitives[pair.b]!.id}`);
  const vertices=new Map<number,{members:number[];pads:Set<string>;adj:Set<number>}>();
  nodes.forEach((n,i)=>{const root=find(i),v=vertices.get(root)??{members:[],pads:new Set<string>(),adj:new Set<number>()};v.members.push(i);for(const body of n.bodies){const terminal=primitives[body]!.terminal;if(terminal!==null)v.pads.add(terminal);}vertices.set(root,v);});
  const reduced=sourceEdges.filter(e=>find(e.a)!==find(e.b)),edgeKeys=reduced.map(e=>pairKey(find(e.a),find(e.b)));if(new Set(edgeKeys).size!==edgeKeys.length)violations.push('DUPLICATE_REDUCED_ROUTE_EDGES');
  for(const e of reduced){vertices.get(find(e.a))!.adj.add(find(e.b));vertices.get(find(e.b))!.adj.add(find(e.a));}
  const seen=new Set<number>(),queue=[...vertices.keys()].slice(0,1);for(let i=0;i<queue.length;i++){const k=queue[i]!;if(seen.has(k))continue;seen.add(k);for(const n of vertices.get(k)!.adj)if(!seen.has(n))queue.push(n);}
  const connected=seen.size===vertices.size,acyclic=connected&&reduced.length===vertices.size-1;
  const leaves=[...vertices].filter(([,v])=>v.adj.size===1),terminals=new Set(input.pads.map(p=>`${p.reference}:${p.pin}`));
  const allPhysicalPadsAttached=input.pads.every((_,i)=>vertices.get(find(bodyNodes[i]!))!.adj.size>0);
  const leavesTerminateAtPads=leaves.every(([,v])=>v.pads.size>0)&&allPhysicalPadsAttached;
  const simplePath=connected&&acyclic&&terminals.size===2&&leaves.length===2&&[...vertices.values()].every(v=>v.adj.size<=2)
    &&leaves.every(([,v])=>v.pads.size===1)&&new Set(leaves.flatMap(([,v])=>[...v.pads])).size===2;
  if(!connected)unresolved.push('SOURCE_SPINE_DISCONNECTED');if(connected&&!acyclic)violations.push('SOURCE_ROUTE_CYCLE');
  if(!leavesTerminateAtPads)unresolved.push('NONTERMINAL_LEAF_OR_UNATTACHED_PHYSICAL_PAD');
  if(input.topology==='point_to_point'&&connected&&acyclic&&!simplePath)violations.push('NOT_A_POINT_TO_POINT_SOURCE_PATH');
  const status=violations.length?'fail':unresolved.length?'unknown':'pass';
  return{scope:'qualified-source-spine-with-complete-convex-contact-cover' as const,status,topology:input.topology,connected,acyclic,leavesTerminateAtPads,simplePath,
    vertexCount:vertices.size,edgeCount:reduced.length,collapsedSourceEdges:sourceEdges.length-reduced.length,physicalPadCount:input.pads.length,
    trackCount:input.tracks.length,viaCount:input.vias.length,contactCount:potential.size,coveredContactCount:covered.size,
    violations:[...new Set(violations)],unresolved:[...new Set(unresolved)],primitiveInteriors:interiorEvidence,contacts,
    sourceEdges:reduced.map(e=>({trackUuid:primitives[e.track]!.id,from:find(e.a),to:find(e.b)})),
    nodes:[...vertices].map(([id,v])=>({id,pads:[...v.pads].sort(),degree:v.adj.size,sites:v.members.flatMap(i=>nodes[i]!.point?[{layer:nodes[i]!.layer,at:copperSerializedPoint(nodes[i]!.point!)}]:[])})),
    operations,planeCopperUsed:false as const,componentInternalTiesInferred:false as const,currentCapacityClaimed:false as const};
}
