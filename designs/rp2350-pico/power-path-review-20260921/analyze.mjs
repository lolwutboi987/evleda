// Read-only engineering screen for the exact published candidate; no native session.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseFreshPcbSource, parseFreshPcbStackup} from '../../../src/harness/fresh-kicad-parser.ts';
import {COPPER_LINEAR_MATERIAL_MODEL as material, COPPER_LINEAR_MATERIAL_MODEL_IDENTITY,
  calculateCopperVoltageDrop, calculateCopperI2RLoss} from '../../../src/knowledge/pcb-engineering-practices.ts';

const base = path.resolve(import.meta.dirname, '../native-r1-launches');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pcbBytes = fs.readFileSync(path.join(base, 'native/rp2350-pico-4layer.kicad_pcb'));
assert.equal(sha(pcbBytes), '1409f3775ebec294987b2b9fdcd984b8cf4ab7e8884700fa1c91250847ff62da');
const intentBytes = fs.readFileSync(path.join(base, 'basis/design-intent.json'));
const constructionBytes = fs.readFileSync(path.join(base, 'basis/construction.json'));
const intent = JSON.parse(intentBytes), construction = JSON.parse(constructionBytes);
const board = parseFreshPcbSource(pcbBytes.toString('utf8'));
const stackup = parseFreshPcbStackup(pcbBytes.toString('utf8'));
assert.equal(stackup.observationsComplete, true);
assert.deepEqual(stackup.boardCopperLayerOrder, ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']);
const thickness = new Map(stackup.layers.filter(x => x.kind === 'copper').map(layer => {
  assert.equal(layer.sublayers.length, 1);
  assert.equal(layer.sublayers[0].thicknessMm.status, 'explicit');
  return [layer.name, layer.sublayers[0].thicknessMm.value];
}));
assert.deepEqual([...thickness.values()], [construction.frontCopperThicknessMm,
  construction.inner1CopperThicknessMm, construction.inner2CopperThicknessMm, construction.backCopperThicknessMm]);
assert.equal(stackup.generalBoardThicknessMm.value, construction.boardThicknessMm);
assert.equal(board.segments.length, 1099); assert.equal(board.vias.length, 118);

// Only floating arithmetic roundoff from cardinal footprint transforms is removed.
// A half-nanometre/smaller actual gap is not silently merged: non-integer-nm inputs reject.
function nm(mm) {
  const value = mm * 1e6, integer = Math.round(value);
  assert.ok(Number.isSafeInteger(integer) && Math.abs(value - integer) < 1e-5);
  return integer;
}
const point = p => ({x: nm(p.x), y: nm(p.y)});
const key = (p, layer) => `${p.x},${p.y},${layer}`;
function onSegment(p, a, b) {
  const dx = BigInt(b.x - a.x), dy = BigInt(b.y - a.y);
  return BigInt(p.x - a.x) * dy === BigInt(p.y - a.y) * dx
    && p.x >= Math.min(a.x,b.x) && p.x <= Math.max(a.x,b.x)
    && p.y >= Math.min(a.y,b.y) && p.y <= Math.max(a.y,b.y);
}

const scenarios = [
  {id:'nominal_25C', temperatureC:25, widthScale:1, outerCopperMm:null, barrelWallMm:0.015},
  {id:'nominal_85C', temperatureC:85, widthScale:1, outerCopperMm:null, barrelWallMm:0.015},
  {id:'sensitivity_85C_80pct_width_35um_outer', temperatureC:85, widthScale:0.8, outerCopperMm:0.035, barrelWallMm:0.015},
];

function graphFor(net, scenario) {
  assert.ok(!board.zoneNetNames.includes(net), 'This screen does not model power zones.');
  const segments = board.segments.filter(s => s.netName === net);
  const vias = board.vias.filter(v => v.netName === net);
  const nodes = new Map(), adjacency = new Map(), terminals = new Map(), padCorridors=[];
  const addNode = (p,layer) => {
    assert.ok(thickness.has(layer));
    const k = key(p,layer);
    if (!nodes.has(k)) { nodes.set(k,{point:p,layer}); adjacency.set(k,[]); }
    return k;
  };
  const addEdge = (a,b,r,detail) => {
    assert.ok(a !== b && Number.isFinite(r) && r > 0);
    adjacency.get(a).push({to:b,r,...detail}); adjacency.get(b).push({to:a,r,...detail});
  };
  for (const s of segments) { addNode(point(s.start),s.layer); addNode(point(s.end),s.layer); }
  for (const via of vias) {
    assert.deepEqual(via.layers,['F.Cu','B.Cu']);
    for (const layer of thickness.keys()) addNode(point(via.at),layer);
  }
  for (const fp of board.footprints) for (const pad of fp.pads.filter(p => p.netName === net)) {
    assert.ok([0,90,180,270,-90,-180,-270].includes(fp.rotationDeg));
    assert.ok(['smd','thru_hole'].includes(pad.physical.padType));
    const layers = pad.layers.includes('*.Cu') ? [...thickness.keys()] : pad.layers.filter(l => thickness.has(l));
    const terminal = `${fp.reference}.${pad.number}`;
    assert.ok(!terminals.has(terminal), 'Repeated physical pads require a separate contact model.');
    terminals.set(terminal,layers.map(layer => addNode(point(pad.at),layer)));
    if (pad.physical.padType==='smd' && pad.physical.drill===null && ['rect','roundrect'].includes(pad.physical.shape)) {
      const angle=((pad.physical.rotationDeg%360)+360)%360;
      assert.ok([0,90,180,270].includes(angle));
      const size=pad.physical.sizeMm; assert.ok(size);
      const radius=pad.physical.shape==='roundrect'?Math.min(size.x,size.y)*pad.physical.roundrectRatio:0;
      // The central rectangle with the corner radius removed on BOTH axes is
      // inside the real roundrect. A capsule whose end discs fit this convex
      // rectangle stays inside it. Keep 2 nm margin; never bridge a pad edge.
      const hx=nm((angle%180===0?size.x:size.y)/2-radius), hy=nm((angle%180===0?size.y:size.x)/2-radius);
      const center=point(pad.at);
      for(const [k,n] of nodes) if(layers.includes(n.layer) && k!==key(center,n.layer)) {
        const margin=Math.min(hx-Math.abs(n.point.x-center.x),hy-Math.abs(n.point.y-center.y));
        const incident=segments.filter(s=>s.layer===n.layer && (key(point(s.start),s.layer)===k||key(point(s.end),s.layer)===k));
        if(margin<=2 || incident.length===0)continue;
        const widthMm=Math.min(...incident.map(s=>s.widthMm),2*(margin-2)/1e6);
        padCorridors.push({a:k,b:key(center,n.layer),widthMm,layer:n.layer,padUuid:pad.physical.id,
          lengthMm:Math.hypot(n.point.x-center.x,n.point.y-center.y)/1e6,startNm:n.point,endNm:center});
      }
    }
  }
  const rho = material.resistivityOhmMmAtReferenceTemperature *
    (1 + material.linearTemperatureCoefficientPerC * (scenario.temperatureC - material.referenceTemperatureC));
  for (const s of segments) {
    assert.ok(s.id && s.widthMm > 0);
    const a = point(s.start), b = point(s.end);
    const ordered = [...nodes].filter(([,n]) => n.layer === s.layer && onSegment(n.point,a,b))
      .sort(([,p],[,q]) => Math.hypot(p.point.x-a.x,p.point.y-a.y) - Math.hypot(q.point.x-a.x,q.point.y-a.y));
    for (let i=1; i<ordered.length; i++) {
      const [ak,av]=ordered[i-1], [bk,bv]=ordered[i];
      const lengthMm = Math.hypot(bv.point.x-av.point.x,bv.point.y-av.point.y)/1e6;
      const copperMm = ['F.Cu','B.Cu'].includes(s.layer) && scenario.outerCopperMm !== null
        ? scenario.outerCopperMm : thickness.get(s.layer);
      addEdge(ak,bk,rho*lengthMm/(s.widthMm*scenario.widthScale*copperMm),
        {kind:'track',uuid:s.id,lengthMm,layer:s.layer,widthMm:s.widthMm,startNm:av.point,endNm:bv.point});
    }
  }
  for (const via of vias) {
    assert.ok(via.id && via.drillMm > 2*scenario.barrelWallMm);
    // Explicit scenario: interpret CAD drill as pre-plating OUTER barrel diameter.
    // This is not a fabricator guarantee about the meaning/tolerance of drill size.
    // Charge full board thickness for EVERY transition, including adjacent layers.
    const r = rho*construction.boardThicknessMm/(Math.PI*scenario.barrelWallMm*(via.drillMm-scenario.barrelWallMm));
    const layers = [...thickness.keys()];
    for (let i=0;i<layers.length;i++) for (let j=i+1;j<layers.length;j++)
      addEdge(key(point(via.at),layers[i]),key(point(via.at),layers[j]),r,
        {kind:'via',uuid:via.id,lengthMm:construction.boardThicknessMm,layers:[layers[i],layers[j]]});
  }
  for(const c of padCorridors) {
    const copperMm=['F.Cu','B.Cu'].includes(c.layer)&&scenario.outerCopperMm!==null?scenario.outerCopperMm:thickness.get(c.layer);
    addEdge(c.a,c.b,rho*c.lengthMm/(c.widthMm*scenario.widthScale*copperMm),
      {kind:'pad_corridor',uuid:c.padUuid,lengthMm:c.lengthMm,layer:c.layer,widthMm:c.widthMm,startNm:c.startNm,endNm:c.endNm});
  }
  return {adjacency,terminals,segments,vias};
}

function pathsFrom(graph, source) {
  assert.ok(graph.terminals.has(source));
  const distances = new Map(), previous = new Map(), pending = new Set(graph.adjacency.keys());
  for (const k of graph.terminals.get(source)) distances.set(k,0);
  while (pending.size) {
    const next = [...pending].filter(k=>distances.has(k)).sort((a,b)=>distances.get(a)-distances.get(b))[0];
    if (next === undefined) break;
    pending.delete(next);
    for (const edge of graph.adjacency.get(next)) {
      const d = distances.get(next)+edge.r;
      if (pending.has(edge.to) && d < (distances.get(edge.to) ?? Infinity)) {
        distances.set(edge.to,d); previous.set(edge.to,{from:next,edge});
      }
    }
  }
  return [...graph.terminals].filter(([name])=>name!==source).map(([terminal,keys])=>{
    const end=keys.filter(k=>distances.has(k)).sort((a,b)=>distances.get(a)-distances.get(b))[0];
    if (end === undefined) return {terminal,status:'unassessed',reason:'No path through exact centerline junctions; physical pad-overlap conduction is not modeled.'};
    const route=[];
    for(let k=end; previous.has(k);) { const p=previous.get(k); route.unshift({...p.edge,fromNode:p.from}); k=p.from; }
    if (route.length === 0) return {terminal,status:'unassessed',reason:'Coincident terminal centers have no modeled track; pad/contact resistance is excluded.'};
    const resistanceOhm=route.reduce((sum,e)=>sum+e.r,0);
    assert.ok(Math.abs(resistanceOhm-distances.get(end)) < 1e-12);
    return {terminal,status:'calculated',resistanceOhm,traceLengthMm:route.filter(e=>e.kind==='track').reduce((sum,e)=>sum+e.lengthMm,0),
      padCorridorLengthMm:route.filter(e=>e.kind==='pad_corridor').reduce((sum,e)=>sum+e.lengthMm,0),
      vias:route.filter(e=>e.kind==='via').map(e=>e.uuid),route};
  });
}

const requests = [
  {net:'VBUS',source:'J1.A4'}, {net:'VSYS',source:'J3.19'}, {net:'VSYS',source:'D1.1'},
  {net:'3V3',source:'U2.1'}, {net:'1V1',source:'L1.1'},
  {net:'VREG_AVDD',source:'R8.2'}, {net:'ADC_VREF',source:'R16.2'}, {net:'ADC_AVDD',source:'R17.2'},
];
const results=[];
for (const scenario of scenarios) for (const request of requests) {
  const declaration=intent.nets.find(n=>n.name===request.net); assert.ok(declaration);
  const graph=graphFor(request.net,scenario);
  assert.deepEqual([...graph.terminals.keys()].sort(),declaration.endpoints.map(e=>`${e.reference}.${e.pin}`).sort());
  const currentA=declaration.electrical.current.maximumContinuousA;
  const paths=pathsFrom(graph,request.source).map(p=>p.status==='unassessed'?p:({...p,
    continuousDropV:calculateCopperVoltageDrop({currentA,resistanceOhm:p.resistanceOhm}).voltageDropV,
    continuousLossW:calculateCopperI2RLoss({rmsCurrentA:currentA,resistanceOhm:p.resistanceOhm}).lossW,
    peakDropV:calculateCopperVoltageDrop({currentA:declaration.electrical.current.peakA,resistanceOhm:p.resistanceOhm}).voltageDropV}));
  results.push({...request,scenario:scenario.id,currentEnvelope:declaration.electrical.current,
    tracksOnNet:graph.segments.length,viasOnNet:graph.vias.length,paths});
}
assert.equal(sha(fs.readFileSync(path.join(base,'native/rp2350-pico-4layer.kicad_pcb'))),sha(pcbBytes));
process.stdout.write(JSON.stringify({schemaVersion:'evleda.rp2350-power-path-review.v1',
  source:{pcb:{sha256:sha(pcbBytes),bytes:pcbBytes.length},intentSha256:sha(intentBytes),constructionSha256:sha(constructionBytes)},
  material,materialIdentity:COPPER_LINEAR_MATERIAL_MODEL_IDENTITY,scenarios,
  interpretation:'Conditional straight-centerline trace, inscribed pad-corridor and cylindrical-barrel arithmetic. Full rail current applied to each selected minimum-resistance path separately. Not an effective-resistance solution or predicted load sharing.',
  excluded:['ground-return impedance','pad current spreading/contact constriction and header barrel resistance','component/package resistance and diode loss',
    'thermal rise and ampacity','manufacturing tolerances or guaranteed minimum material dimensions','switching ripple, inductance and transient response'],
  accepted:false,boardChanged:false,results})+'\n');
