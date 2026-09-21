import { describe, expect, it } from "vitest";
import { cf,cp,copperRelation,copperWitness,copperContains,copperSerializedPoint,cc } from "../../src/harness/trace-copper-geometry.js";
import { assessTraceCopperTopology, type TraceCopperTopologyInput } from "../../src/harness/trace-copper-topology.js";
import type { TerminalCopperPad,TerminalCopperTrack,TerminalCopperVia } from "../../src/harness/plane-terminal-copper-paths.js";
const pad=(uuid:string,x:number,y:number,pin='1',reference=uuid):TerminalCopperPad=>({uuid,reference,pin,centerNm:{x,y},layers:['F.Cu'],platedThrough:false,shape:'rectangle',sizeNm:{x:600000,y:600000},cornerRadiusNm:0});
const track=(uuid:string,x1:number,y1:number,x2:number,y2:number,layer='F.Cu',widthNm=150000):TerminalCopperTrack=>({uuid,startNm:{x:x1,y:y1},endNm:{x:x2,y:y2},widthNm,layer});
const via=(uuid:string,x:number,y:number):TerminalCopperVia=>({uuid,centerNm:{x,y},diameterNm:550000,drillNm:200000,layers:['F.Cu','In1.Cu','In2.Cu','B.Cu']});
const input=(tracks:TerminalCopperTrack[],pads=[pad('A',1000000,1000000),pad('B',5000000,1000000)],vias:TerminalCopperVia[]=[]):TraceCopperTopologyInput=>({tracks,pads,vias,bores:vias.map(v=>({uuid:v.uuid,centerNm:v.centerNm,diameterNm:v.drillNm})),boardBoundsNm:{minX:0,minY:0,maxX:10000000,maxY:10000000},topology:'point_to_point'});
describe('exact copper contact predicates',()=>{
  const capsule=(y:number)=>({core:[cp(0,y),cp(1000000,y)],radius:cf(100000)});
  it('distinguishes exact touching, a one-nanometre gap and positive overlap',()=>{
    expect(copperRelation(capsule(0),capsule(200000),()=>{})).toBe('touching');
    expect(copperRelation(capsule(0),capsule(200001),()=>{})).toBe('separate');
    expect(copperRelation(capsule(0),capsule(199999),()=>{})).toBe('overlapping');
    const witness=copperWitness([capsule(0),capsule(199999)],()=>{});expect(witness).not.toBeNull();expect(copperContains(capsule(0),witness!)).toBe(true);expect(copperContains(capsule(199999),witness!)).toBe(true);
  });
  it('retains fractional witnesses without rounding them onto a boundary',()=>{
    const a={core:[cp(0,0)],radius:cf(2)},b={core:[cp(3,0)],radius:cf(2)},w=copperWitness([a,b],()=>{});expect(w).not.toBeNull();
    expect(copperSerializedPoint(w!).x).toEqual({numerator:'3',denominator:'2'});expect(cc(w!.x,cf(1))).toBe(1);
  });
  it('does not invent a common intersection from three pairwise contacts',()=>{
    const shapes=[{core:[cp(0,0)],radius:cf(10)},{core:[cp(19,0)],radius:cf(10)},{core:[cp(9,16)],radius:cf(10)}];
    expect(shapes.every((s,i)=>shapes.slice(i+1).every(t=>copperRelation(s,t,()=>{})==='overlapping'))).toBe(true);expect(copperWitness(shapes,()=>{})).toBeNull();
  });
});
describe('source spine with complete finite copper contact coverage',()=>{
  it('accepts a finite pad contact offset from its centre and preserves every primitive',()=>{
    const r=assessTraceCopperTopology(input([track('t',1100000,1000000,4900000,1000000)]));expect(r.status).toBe('pass');expect(r.physicalPadCount).toBe(2);expect(r.trackCount).toBe(1);expect(r.planeCopperUsed).toBe(false);
  });
  it('joins an inner-layer route through a qualified normal via without inventing unused-layer leaves',()=>{
    const v=via('V',3000000,1000000),p={...pad('B',5000000,1000000),layers:['In2.Cu']};
    const r=assessTraceCopperTopology(input([track('a',1000000,1000000,3000000,1000000),track('b',3000000,1000000,5000000,1000000,'In2.Cu')],[pad('A',1000000,1000000),p],[v]));
    expect(r.status).toBe('pass');expect(r.viaCount).toBe(1);expect(r.simplePath).toBe(true);
  });
  it('retains a disconnected repeated physical pad instead of inventing an internal package tie',()=>{
    const r=assessTraceCopperTopology(input([track('t',1000000,1000000,5000000,1000000)],[pad('A',1000000,1000000),pad('B1',5000000,1000000,'1','B'),pad('B2',5000000,3000000,'1','B')]));
    expect(r.status).toBe('unknown');expect(r.unresolved).toContain('NONTERMINAL_LEAF_OR_UNATTACHED_PHYSICAL_PAD');
  });
  it('rejects a real source loop and a nonterminal spur',()=>{
    const loop=assessTraceCopperTopology({...input([track('a',1000000,1000000,5000000,1000000),track('b',5000000,1000000,5000000,3000000),track('c',5000000,3000000,1000000,3000000),track('d',1000000,3000000,1000000,1000000)]),topology:'tree'});
    expect(loop.status).toBe('fail');expect(loop.violations).toContain('SOURCE_ROUTE_CYCLE');
    const spur=assessTraceCopperTopology({...input([track('a',1000000,1000000,5000000,1000000),track('b',3000000,1000000,3000000,3000000)]),topology:'tree'});expect(spur.status).toBe('unknown');expect(spur.leavesTerminateAtPads).toBe(false);
  });
  it('keeps a hidden finite-width shortcut unresolved instead of accepting the centreline path alone',()=>{
    const pads=[pad('A',1000000,1000000),pad('B',1000000,1120000)].map(p=>({...p,sizeNm:{x:20000,y:20000}}));
    const r=assessTraceCopperTopology(input([track('a',1000000,1000000,5000000,1000000),track('b',5000000,1000000,5000000,3000000),track('c',5000000,3000000,1000000,3000000),track('d',1000000,3000000,1000000,1120000)],pads));
    expect(r.connected&&r.acyclic&&r.simplePath).toBe(true);expect(r.status).toBe('unknown');expect(r.unresolved.some(s=>s.startsWith('UNACCOUNTED_FINITE_CONTACT:'))).toBe(true);
  });
  it('does not turn a foreign drill that cuts a trace into an intact carrier',()=>{
    const a=input([track('t',1000000,1000000,5000000,1000000)]),r=assessTraceCopperTopology({...a,bores:[{uuid:'hole',centerNm:{x:3000000,y:1000000},diameterNm:400000}]});
    expect(r.status).toBe('unknown');expect(r.unresolved).toContain('DRILLED_PRIMITIVE_INTERIOR:t');
  });
  it('uses the exact cardinal slot instead of a large circular enclosure',()=>{
    const a=input([track('t',1000000,1500000,5000000,1500000)],[pad('A',1000000,1500000),pad('B',5000000,1500000)]);
    const bore={uuid:'slot',centerNm:{x:3000000,y:2000000},diameterNm:200000,slot:{majorDiameterNm:2000000,axis:'x' as const}};
    expect(assessTraceCopperTopology({...a,bores:[bore]}).status).toBe('pass');
    expect(assessTraceCopperTopology({...a,bores:[{...bore,slot:{...bore.slot,axis:'y'}}]}).status).toBe('unknown');
  });
  it('retains local finite-width overlap around a bend with an explicit common-contact certificate',()=>{
    const r=assessTraceCopperTopology(input([track('a',1000000,1000000,2000000,1000000,'F.Cu',300000),track('b',2000000,1000000,2100000,1100000,'F.Cu',300000),track('c',2100000,1100000,2100000,3000000,'F.Cu',300000)],[pad('A',1000000,1000000),pad('B',2100000,3000000)]));
    expect(r.status).toBe('pass');expect(r.contacts.some(c=>c.kind==='common-convex-contact-cover')).toBe(true);expect(r.coveredContactCount).toBe(r.contactCount);
  });
});
