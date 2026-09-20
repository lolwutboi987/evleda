import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const root=import.meta.dirname;
const mapFile=path.join(root,'regions.json'),mapBytes=fs.readFileSync(mapFile),map=JSON.parse(mapBytes);
const source=path.resolve(root,'../native-r1/native/rp2350-pico-4layer.kicad_pcb');
const hash=b=>createHash('sha256').update(b).digest('hex');assert.equal(hash(fs.readFileSync(source)),map.sourceSha256);
const out=path.resolve(process.argv[2]??path.join(root,'exact-debug-distance-replayed.json'));assert.ok(!fs.existsSync(out));
const toNm=x=>{const n=Math.round(x*1e6);assert.ok(Number.isSafeInteger(n)&&Math.abs(n-x*1e6)<.001);return BigInt(n)};
const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
const on=(a,b,p)=>cross(a,b,p)===0n&&p[0]>=min(a[0],b[0])&&p[0]<=max(a[0],b[0])&&p[1]>=min(a[1],b[1])&&p[1]<=max(a[1],b[1]);
const min=(a,b)=>a<b?a:b,max=(a,b)=>a>b?a:b,sign=x=>x<0n?-1:x>0n?1:0;
function intersects(a,b,c,d){const x=cross(a,b,c),y=cross(a,b,d),u=cross(c,d,a),v=cross(c,d,b);return(x===0n&&on(a,b,c))||(y===0n&&on(a,b,d))||(u===0n&&on(c,d,a))||(v===0n&&on(c,d,b))||(sign(x)*sign(y)<0&&sign(u)*sign(v)<0)}
function ringLocation(r,p){let w=0;for(let i=0;i<r.length;i++){const a=r[i],b=r[(i+1)%r.length];if(on(a,b,p))return -1;if(a[1]<=p[1]){if(b[1]>p[1]&&cross(a,b,p)>0n)w++;}else if(b[1]<=p[1]&&cross(a,b,p)<0n)w--;}return w===0?0:1}
function pointDistance(p,a,b){const dx=b[0]-a[0],dy=b[1]-a[1],l=dx*dx+dy*dy,px=p[0]-a[0],py=p[1]-a[1],dot=px*dx+py*dy;if(l===0n||dot<=0n)return{n:px*px+py*py,d:1n};if(dot>=l){const x=p[0]-b[0],y=p[1]-b[1];return{n:x*x+y*y,d:1n}}const c=dx*py-dy*px;return{n:c*c,d:l}}
const smaller=(a,b)=>a.n*b.d<b.n*a.d;
function segmentDistance(a,b,c,d){if(intersects(a,b,c,d))return{n:0n,d:1n};return[pointDistance(a,c,d),pointDistance(b,c,d),pointDistance(c,a,b),pointDistance(d,a,b)].reduce((x,y)=>smaller(x,y)?x:y)}
// Independent analytic cases exercise interior projection, parallel/disjoint,
// proper crossing, degenerate edges and exact tangency comparisons.
assert.deepEqual(pointDistance([3n,4n],[0n,0n],[10n,0n]),{n:1600n,d:100n});
assert.deepEqual(segmentDistance([0n,0n],[10n,0n],[0n,5n],[10n,5n]),{n:25n,d:1n});
assert.equal(segmentDistance([0n,0n],[10n,10n],[0n,10n],[10n,0n]).n,0n);
assert.deepEqual(pointDistance([3n,4n],[0n,0n],[0n,0n]),{n:25n,d:1n});
const plane=map.zones.find(z=>z.layer==='In1.Cu');assert.equal(plane.regions.length,1);
const region=plane.regions[0],rings=[region.outer,...region.holes].map(r=>r.map(p=>p.map(toNm)));
const edges=[];let cancelledPairs=0;
for(const ring of rings){const retained=new Map();for(let i=0;i<ring.length;i++){const a=ring[i],b=ring[(i+1)%ring.length],key=a.join(',')+';'+b.join(','),rev=b.join(',')+';'+a.join(',');if(a[0]===b[0]&&a[1]===b[1])continue;if(retained.has(rev)){const x=retained.get(rev);x.count--;if(!x.count)retained.delete(rev);cancelledPairs++;}else if(retained.has(key))retained.get(key).count++;else retained.set(key,{a,b,count:1});}for(const x of retained.values())for(let i=0;i<x.count;i++)edges.push([x.a,x.b]);}
const strictlyInside=p=>ringLocation(rings[0],p)===1&&rings.slice(1).every(r=>ringLocation(r,p)===0);
const report=JSON.parse(fs.readFileSync(path.join(root,'../native-r1/verification/reference-complete-nets-1.json')));
assert.equal(report.sourceIdentity.digest,map.sourceSha256);
const selected=report.selectedSegments.filter(s=>s.netName==='SWDIO_MCU'),results=[];
assert.equal(selected.length,6);assert.ok(selected.length*edges.length<1000000);
for(const s of selected){const a=[BigInt(s.startNm.x),BigInt(s.startNm.y)],b=[BigInt(s.endNm.x),BigInt(s.endNm.y)],diameter=BigInt(s.widthNm+2*report.request.marginNm);let best=null,index=-1;for(let i=0;i<edges.length;i++){const d=segmentDistance(a,b,...edges[i]);if(best===null||smaller(d,best)){best=d;index=i;}}
 const inside=strictlyInside(a)&&strictlyInside(b),comparison=4n*best.n-diameter*diameter*best.d;
 results.push({segmentId:s.uuid,net:s.netName,startNm:s.startNm,endNm:s.endNm,widthNm:s.widthNm,marginNm:report.request.marginNm,endpointsStrictlyInside:inside,minimumBoundaryDistanceSquaredNm:{numerator:best.n.toString(),denominator:best.d.toString()},nearestBoundaryEdgeNm:edges[index].map(p=>p.map(String)),strictClearanceComparison:sign(comparison),displayMinimumBoundaryDistanceMm:Math.sqrt(Number(best.n)/Number(best.d))/1e6,displayExcessBeyondRequiredRibbonMm:(Math.sqrt(Number(best.n)/Number(best.d))-Number(diameter)/2)/1e6,status:inside&&comparison>0n?'strictly-covered':comparison===0n?'boundary-uncertain':'not-proven-covered'});
}
assert.equal(hash(fs.readFileSync(source)),map.sourceSha256);
const result={scope:'Independent exact integer/rational distance review of the original SWDIO_MCU Euclidean capsules against every retained In1 stored-fill boundary. Strictly interior endpoints plus distance greater than the capsule radius establish containment in that stored region. This does not change the public helper report, restore native fill authority, prove drill-clipped connectivity, or qualify electrical return behavior.',sourceSha256:map.sourceSha256,geometryMapSha256:hash(mapBytes),ringCount:rings.length,boundaryEdges:edges.length,cancelledOppositePairs:cancelledPairs,radiusComparison:'4 * squared-distance numerator > (width + 2*margin)^2 * denominator; exact BigInt, with equality uncertain',results,sourceUnchanged:true};
fs.writeFileSync(out,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(results.map(r=>({id:r.segmentId,status:r.status,excessMm:r.displayExcessBeyondRequiredRibbonMm}))));
