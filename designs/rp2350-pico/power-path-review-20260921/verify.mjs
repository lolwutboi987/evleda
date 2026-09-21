import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {parseFreshPcbSource} from '../../../src/harness/fresh-kicad-parser.ts';

const here=import.meta.dirname;
const saved=fs.readFileSync(path.join(here,'report.json'));
const replay=execFileSync(process.execPath,['--import','tsx',path.join(here,'analyze.mjs')],{maxBuffer:4*1024*1024});
assert.ok(saved.equals(replay),'Published arithmetic must replay byte-for-byte.');
const report=JSON.parse(saved), pcb=parseFreshPcbSource(fs.readFileSync(path.join(here,'../native-r1-launches/native/rp2350-pico-4layer.kicad_pcb'),'utf8'));
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-10,`${a} != ${b}`);
const decode=k=>{const [x,y,layer]=k.split(',');return {x:Number(x),y:Number(y),layer};};
const terminalPoint=name=>{const [ref,pin]=name.split('.');const p=pcb.footprints.find(f=>f.reference===ref).pads.find(p=>p.number===pin);return {x:Math.round(p.at.x*1e6),y:Math.round(p.at.y*1e6)};};
let routes=0,edges=0,unassessed=0;
for(const row of report.results) {
  const scenario=report.scenarios.find(s=>s.id===row.scenario);
  const rho=17e-6*(1+0.0039*(scenario.temperatureC-25));
  for(const p of row.paths) {
    if(p.status==='unassessed') {unassessed++;assert.equal(p.resistanceOhm,undefined);continue;}
    routes++;
    const start=decode(p.route[0].fromNode),end=decode(p.route.at(-1).to);
    assert.deepEqual({x:start.x,y:start.y},terminalPoint(row.source));
    assert.deepEqual({x:end.x,y:end.y},terminalPoint(p.terminal));
    let total=0;
    for(let i=0;i<p.route.length;i++) {
      const edge=p.route[i],a=decode(edge.fromNode),b=decode(edge.to);edges++;
      if(i)assert.equal(p.route[i-1].to,edge.fromNode,'A path may not jump between disconnected source nodes.');
      let expected;
      if(edge.kind==='via') {
        const v=pcb.vias.find(v=>v.id===edge.uuid);assert.equal(v.netName,row.net);
        assert.equal(a.x,b.x);assert.equal(a.y,b.y);assert.notEqual(a.layer,b.layer);
        assert.equal(a.x,Math.round(v.at.x*1e6));assert.equal(a.y,Math.round(v.at.y*1e6));
        expected=rho*1.016/(Math.PI*0.015*(v.drillMm-0.015));
      } else {
        assert.equal(a.layer,b.layer);
        const length=Math.hypot(a.x-b.x,a.y-b.y)/1e6;close(length,edge.lengthMm);
        const copper=['F.Cu','B.Cu'].includes(a.layer)?(scenario.outerCopperMm??0.043):0.035;
        if(edge.kind==='track') {
          const s=pcb.segments.find(s=>s.id===edge.uuid);assert.equal(s.netName,row.net);assert.equal(s.layer,a.layer);
          assert.equal(s.widthMm,edge.widthMm);
          // Independent distance-additivity check against the original segment.
          for(const v of [a,b])close(Math.hypot(v.x/1e6-s.start.x,v.y/1e6-s.start.y)+
            Math.hypot(v.x/1e6-s.end.x,v.y/1e6-s.end.y),Math.hypot(s.end.x-s.start.x,s.end.y-s.start.y));
        } else {
          assert.equal(edge.kind,'pad_corridor');
          const pad=pcb.footprints.flatMap(f=>f.pads).find(p=>p.physical.id===edge.uuid);
          assert.equal(pad.netName,row.net);assert.equal(pad.physical.padType,'smd');assert.equal(pad.physical.drill,null);
          const rotation=((pad.physical.rotationDeg%360)+360)%360;
          const size=pad.physical.sizeMm;
          const radius=pad.physical.shape==='roundrect'?Math.min(size.x,size.y)*pad.physical.roundrectRatio:0;
          const hx=(rotation%180===0?size.x:size.y)/2-radius,hy=(rotation%180===0?size.y:size.x)/2-radius;
          for(const v of [a,b]) {
            assert.ok(Math.abs(v.x/1e6-pad.at.x)+edge.widthMm/2<hx);
            assert.ok(Math.abs(v.y/1e6-pad.at.y)+edge.widthMm/2<hy);
          }
        }
        expected=rho*length/(edge.widthMm*scenario.widthScale*copper);
      }
      close(edge.r,expected);total+=expected;
    }
    close(p.resistanceOhm,total);
    close(p.continuousDropV,row.currentEnvelope.maximumContinuousA*total);
    close(p.continuousLossW,row.currentEnvelope.maximumContinuousA**2*total);
    close(p.peakDropV,row.currentEnvelope.peakA*total);
  }
}
const find=(scenario,net,source,terminal)=>report.results.find(r=>r.scenario===scenario&&r.net===net&&r.source===source).paths.find(p=>p.terminal===terminal);
for(const row of report.results.filter(r=>r.scenario==='nominal_25C'))for(const p of row.paths.filter(p=>p.status==='calculated')) {
  close(find('nominal_85C',row.net,row.source,p.terminal).resistanceOhm,p.resistanceOhm*1.234);
  assert.ok(find('sensitivity_85C_80pct_width_35um_outer',row.net,row.source,p.terminal).resistanceOhm>=p.resistanceOhm*1.234);
}
assert.equal(find('nominal_25C','3V3','U2.1','R8.1').status,'unassessed');
assert.equal(find('nominal_25C','VBUS','J1.A4','J1.B9').status,'unassessed');
assert.equal(report.accepted,false);assert.equal(report.boardChanged,false);
console.log(JSON.stringify({byteIdenticalReplay:true,scenarios:report.scenarios.length,requests:report.results.length,
  calculatedPaths:routes,unassessedPaths:unassessed,independentlyCheckedPathEdges:edges,sourceGeometryAndArithmeticChecked:true}));
