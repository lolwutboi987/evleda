/**
 * Explicit host route materialization for the pinned DOC5/KiPy ABI.
 * Coordinates: Vector2.from_xy_mm -> int(binary64_mm * 1_000_000).
 * Width/drill: kicad_mcp.utils.mm_to_nm -> int(round(binary64_mm * 1_000_000)).
 * This is unit conversion, never a geometric comparison tolerance.
 */
const SCALE=1_000_000;
const MAX_NM=2_000_000_000;
function boundedNm(value:number):number{
  if(!Number.isSafeInteger(value)||Math.abs(value)>MAX_NM)throw new Error("Route native coordinate exceeds the bounded integer-nanometre domain.");
  return value===0?0:value;
}
/** Explicit nearest-even materialization of the requested binary64 millimetres. */
export function routeMmToNativeNm(mm:number):number{
  if(!Number.isFinite(mm)||Math.abs(mm)>MAX_NM/SCALE)throw new Error("Route millimetres are outside the native materialization bound.");
  const scaled=mm*SCALE,low=Math.floor(scaled),fraction=scaled-low;
  return boundedNm(fraction<0.5?low:fraction>0.5?low+1:low%2===0?low:low+1);
}
export const routeNativeNmToMm=(nm:number):number=>boundedNm(nm)/SCALE;
/** Exact source decimal projection: do not round actual readback into compliance. */
export function routeSourceMmToNativeNm(mm:number):number{
  if(!Number.isFinite(mm))throw new Error("Native route readback is not finite.");
  const match=/^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/u.exec(String(mm));
  if(match===null)throw new Error("Native route readback has unsupported decimal syntax.");
  let value=BigInt(match[2]!+(match[3]??""));
  const power=6+Number(match[4]??0)-(match[3]?.length??0);
  if(Math.abs(power)>40)throw new Error("Native route readback is outside integer-nanometre precision.");
  if(power>=0)value*=10n**BigInt(power);
  else{const divisor=10n**BigInt(-power);if(value%divisor!==0n)throw new Error("Actual route readback is not an exact integer nanometre.");value/=divisor;}
  if(match[1]==="-")value=-value;
  return boundedNm(Number(value));
}
function nextFloat(value:number,increasing:boolean):number{
  if(value===0)return increasing?Number.MIN_VALUE:-Number.MIN_VALUE;
  const storage=new ArrayBuffer(8),view=new DataView(storage);view.setFloat64(0,value,false);
  const bits=view.getBigUint64(0,false);view.setBigUint64(0,bits+((value>0)===increasing?1n:-1n),false);
  return view.getFloat64(0,false);
}
/**
 * Choose an IEEE-754 wire value whose *actual pinned* truncating conversion is
 * exactly the desired nm. A neighbouring float may be required (e.g.249 nm).
 * Verify after a JSON round trip as that is the real cross-language transport.
 */
export function routeNativeNmToKipyMm(nm:number):number{
  boundedNm(nm);let wire=nm/SCALE;
  for(let step=0;step<4;step++){
    const transported=Number(JSON.parse(JSON.stringify(wire))),actual=Math.trunc(transported*SCALE);
    if(actual===nm)return transported===0?0:transported;
    wire=nextFloat(wire,actual<nm);
  }
  throw new Error("Could not encode the exact desired native coordinate through the pinned KiPy millimetre ABI.");
}
/** Already validated native PAD scalar, including ordinary proto3 zero omission. */
export function validatedNativePadPositionMm(raw:Readonly<Record<string,unknown>>):Readonly<{xMm:number;yMm:number}>{
  const position=raw.position;
  if(position===null||typeof position!=="object"||Array.isArray(position))throw new Error("Validated native pad lacks its position record.");
  const value=(key:string)=>{
    const scalar=(position as Record<string,unknown>)[key];
    if(scalar===undefined)return 0;
    if(typeof scalar!=="number"&&!(typeof scalar==="string"&&/^-?[0-9]+$/u.test(scalar)))throw new Error("Native pad position is not an integer scalar.");
    const nm=Number(scalar);if(!Number.isSafeInteger(nm))throw new Error("Native pad position is not a safe integer nanometre.");return nm/SCALE;
  };
  return Object.freeze({xMm:value("x_nm"),yMm:value("y_nm")});
}
