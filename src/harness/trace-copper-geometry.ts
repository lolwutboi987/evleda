/** Exact rational geometry for bounded convex copper envelopes. A found witness
 * is a positive certificate; an unsuccessful search is never a separation proof. */
export interface CopperFraction { readonly n: bigint; readonly d: bigint }
export interface CopperPoint { readonly x: CopperFraction; readonly y: CopperFraction }
export interface CopperShape { readonly core: readonly CopperPoint[]; readonly radius: CopperFraction }
export type CopperWork = () => void;
const abs = (n: bigint) => n < 0n ? -n : n;
const gcd = (a: bigint, b: bigint): bigint => { a=abs(a);b=abs(b);while(b){const r=a%b;a=b;b=r;}return a||1n; };
export function copperFraction(n: bigint | number, d: bigint | number = 1n): CopperFraction {
  let a=BigInt(n),b=BigInt(d);if(b===0n)throw new Error("Copper geometry: zero denominator");if(b<0n){a=-a;b=-b;}const g=gcd(a,b);a/=g;b/=g;
  if(abs(a).toString(2).length>512||b.toString(2).length>512)throw new Error("Copper geometry: rational work bound");return {n:a,d:b};
}
export const cf = copperFraction;
export const ca=(a:CopperFraction,b:CopperFraction)=>cf(a.n*b.d+b.n*a.d,a.d*b.d);
export const cs=(a:CopperFraction,b:CopperFraction)=>cf(a.n*b.d-b.n*a.d,a.d*b.d);
export const cm=(a:CopperFraction,b:CopperFraction)=>cf(a.n*b.n,a.d*b.d);
export const cd=(a:CopperFraction,b:CopperFraction)=>cf(a.n*b.d,a.d*b.n);
export const cc=(a:CopperFraction,b:CopperFraction)=>a.n*b.d<b.n*a.d?-1:a.n*b.d>b.n*a.d?1:0;
export const cp=(x:number|bigint,y:number|bigint):CopperPoint=>({x:cf(x),y:cf(y)});
export const cpointKey=(p:CopperPoint)=>`${p.x.n}/${p.x.d},${p.y.n}/${p.y.d}`;
export const cpointEqual=(a:CopperPoint,b:CopperPoint)=>cc(a.x,b.x)===0&&cc(a.y,b.y)===0;
export const cadd=(a:CopperPoint,b:CopperPoint):CopperPoint=>({x:ca(a.x,b.x),y:ca(a.y,b.y)});
export const csub=(a:CopperPoint,b:CopperPoint):CopperPoint=>({x:cs(a.x,b.x),y:cs(a.y,b.y)});
export const cscale=(p:CopperPoint,s:CopperFraction):CopperPoint=>({x:cm(p.x,s),y:cm(p.y,s)});
export const cdot=(a:CopperPoint,b:CopperPoint)=>ca(cm(a.x,b.x),cm(a.y,b.y));
export const ccross=(a:CopperPoint,b:CopperPoint)=>cs(cm(a.x,b.y),cm(a.y,b.x));
export const cdist2=(a:CopperPoint,b:CopperPoint)=>cdot(csub(a,b),csub(a,b));
export const cmix=(a:CopperPoint,b:CopperPoint,t:CopperFraction)=>cadd(a,cscale(csub(b,a),t));
const zero=cf(0),one=cf(1),half=cf(1,2);
const between=(v:CopperFraction,a:CopperFraction,b:CopperFraction)=>cc(v,cc(a,b)<0?a:b)>=0&&cc(v,cc(a,b)>0?a:b)<=0;
export function copperPointOnSegment(p:CopperPoint,a:CopperPoint,b:CopperPoint):boolean {
  return cc(ccross(csub(b,a),csub(p,a)),zero)===0&&between(p.x,a.x,b.x)&&between(p.y,a.y,b.y);
}
export function copperProject(p:CopperPoint,a:CopperPoint,b:CopperPoint):CopperPoint {
  const v=csub(b,a),length=cdot(v,v);if(length.n===0n)return a;const t=cd(cdot(csub(p,a),v),length);
  return cc(t,zero)<=0?a:cc(t,one)>=0?b:cmix(a,b,t);
}
function edges(core:readonly CopperPoint[]):readonly (readonly [CopperPoint,CopperPoint])[]{
  if(core.length===1)return [[core[0]!,core[0]!]];if(core.length===2)return [[core[0]!,core[1]!]];
  return core.map((p,i)=>[p,core[(i+1)%core.length]!] as const);
}
function coreContains(core:readonly CopperPoint[],p:CopperPoint,strict=false):boolean {
  if(core.length===1)return !strict&&cpointEqual(core[0]!,p);
  if(core.length===2)return !strict&&copperPointOnSegment(p,core[0]!,core[1]!);
  return edges(core).every(([a,b])=>cc(ccross(csub(b,a),csub(p,a)),zero)>=(strict?1:0));
}
export function copperIntersection(a:CopperPoint,b:CopperPoint,c:CopperPoint,d:CopperPoint):CopperPoint|null {
  const u=csub(b,a),v=csub(d,c),det=ccross(u,v);if(det.n===0n)return [a,b,c,d].find(p=>copperPointOnSegment(p,a,b)&&copperPointOnSegment(p,c,d))??null;
  const t=cd(ccross(csub(c,a),v),det),s=cd(ccross(csub(c,a),u),det);
  return cc(t,zero)>=0&&cc(t,one)<=0&&cc(s,zero)>=0&&cc(s,one)<=0?cmix(a,b,t):null;
}
export function copperClosest(a:CopperShape,b:CopperShape,work:CopperWork) {
  work();for(const p of a.core)if(coreContains(b.core,p))return {a:p,b:p,distanceSquared:zero};
  for(const p of b.core)if(coreContains(a.core,p))return {a:p,b:p,distanceSquared:zero};
  let best:{a:CopperPoint;b:CopperPoint;distanceSquared:CopperFraction}|undefined;
  const consider=(p:CopperPoint,q:CopperPoint)=>{const distanceSquared=cdist2(p,q);if(best===undefined||cc(distanceSquared,best.distanceSquared)<0)best={a:p,b:q,distanceSquared};};
  for(const [p,q]of edges(a.core))for(const [r,s]of edges(b.core)){
    work();const crossing=copperIntersection(p,q,r,s);if(crossing)return {a:crossing,b:crossing,distanceSquared:zero};
    consider(p,copperProject(p,r,s));consider(q,copperProject(q,r,s));consider(copperProject(r,p,q),r);consider(copperProject(s,p,q),s);
  }
  if(!best)throw new Error("Copper geometry: empty convex core");return best;
}
export function copperContains(shape:CopperShape,p:CopperPoint,strict=true,work:CopperWork=()=>{}):boolean {
  work();if(shape.radius.n===0n)return coreContains(shape.core,p,strict);
  if(coreContains(shape.core,p))return true;
  let minimum:CopperFraction|undefined;for(const[a,b]of edges(shape.core)){const d=cdist2(p,copperProject(p,a,b));if(minimum===undefined||cc(d,minimum)<0)minimum=d;}
  return minimum!==undefined&&cc(minimum,cm(shape.radius,shape.radius))<=(strict?-1:0);
}
export function copperBounds(shape:CopperShape){
  const xs=shape.core.map(p=>p.x),ys=shape.core.map(p=>p.y),min=(v:CopperFraction[])=>v.reduce((a,b)=>cc(a,b)<0?a:b),max=(v:CopperFraction[])=>v.reduce((a,b)=>cc(a,b)>0?a:b);
  return {minX:cs(min(xs),shape.radius),maxX:ca(max(xs),shape.radius),minY:cs(min(ys),shape.radius),maxY:ca(max(ys),shape.radius)};
}
export function copperRelation(a:CopperShape,b:CopperShape,work:CopperWork):"separate"|"touching"|"overlapping" {
  const x=copperBounds(a),y=copperBounds(b);work();if(cc(x.maxX,y.minX)<0||cc(y.maxX,x.minX)<0||cc(x.maxY,y.minY)<0||cc(y.maxY,x.minY)<0)return "separate";
  const closest=copperClosest(a,b,work),radius=ca(a.radius,b.radius),relation=cc(closest.distanceSquared,cm(radius,radius));
  if(relation>0)return "separate";if(relation<0)return "overlapping";
  if(radius.n===0n){const loX=cc(x.minX,y.minX)>0?x.minX:y.minX,hiX=cc(x.maxX,y.maxX)<0?x.maxX:y.maxX,loY=cc(x.minY,y.minY)>0?x.minY:y.minY,hiY=cc(x.maxY,y.maxY)<0?x.maxY:y.maxY;
    if(cc(loX,hiX)<0&&cc(loY,hiY)<0){const p={x:cm(ca(loX,hiX),half),y:cm(ca(loY,hiY),half)};if(copperContains(a,p,true,work)&&copperContains(b,p,true,work))return "overlapping";}}
  return "touching";
}
export const copperCentroid=(shape:CopperShape):CopperPoint=>cscale(shape.core.reduce(cadd,cp(0,0)),cf(1,shape.core.length));
/** Finite deterministic rational candidates; every returned point is checked. */
export function copperWitness(shapes:readonly CopperShape[],work:CopperWork,extra:readonly CopperPoint[]=[],allowed:(p:CopperPoint)=>boolean=()=>true,strict=true):CopperPoint|null {
  const candidates: CopperPoint[]=[...extra,...shapes.flatMap(s=>[copperCentroid(s),...s.core,...edges(s.core).map(([a,b])=>cmix(a,b,half))])];
  for(let i=0;i<shapes.length;i++)for(let j=i+1;j<shapes.length;j++){
    const a=shapes[i]!,b=shapes[j]!,c=copperClosest(a,b,work),r=ca(a.radius,b.radius);
    candidates.push(c.a,c.b,cmix(c.a,c.b,half));if(r.n!==0n)candidates.push(cmix(c.a,c.b,cd(a.radius,r)));
  }
  const bounds=shapes.map(copperBounds),loX=bounds.map(b=>b.minX).reduce((a,b)=>cc(a,b)>0?a:b),hiX=bounds.map(b=>b.maxX).reduce((a,b)=>cc(a,b)<0?a:b),loY=bounds.map(b=>b.minY).reduce((a,b)=>cc(a,b)>0?a:b),hiY=bounds.map(b=>b.maxY).reduce((a,b)=>cc(a,b)<0?a:b);
  if(cc(loX,hiX)<0&&cc(loY,hiY)<0)for(const x of[1,2,4,6,7])for(const y of[1,2,4,6,7])candidates.push({x:ca(loX,cm(cs(hiX,loX),cf(x,8))),y:ca(loY,cm(cs(hiY,loY),cf(y,8)))});
  const centers=shapes.map(copperCentroid),initial=[...candidates];
  for(const p of initial){work();if(shapes.every(s=>copperContains(s,p,strict,work))&&allowed(p))return p;}
  for(const p of initial)for(const center of centers)for(const denominator of[2,4,16,256,65536]){
    work();const q=cmix(p,center,cf(1,denominator));if(shapes.every(s=>copperContains(s,q,strict,work))&&allowed(q))return q;
  }
  return null;
}
export function copperSerializedPoint(p:CopperPoint){return {x:{numerator:String(p.x.n),denominator:String(p.x.d)},y:{numerator:String(p.y.n),denominator:String(p.y.d)}};}
