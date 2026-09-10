import { describe,it,expect } from "vitest";
import { routeMmToNativeNm,routeNativeNmToMm,routeNativeNmToKipyMm,routeSourceMmToNativeNm,validatedNativePadPositionMm } from "../../src/harness/fresh-route-native-units.js";

describe('explicit native route units without geometric tolerance',()=>{
  it('retains the proof02 failure as a truncation mismatch, not an acceptable exact match',()=>{
    // Actual GetItems after the owner's Cancel: source evidence SHA
    // 0d15d16547c26a04b3b6e9be2adc2de7603bdf36b43a526c2d6f8ae10189f311.
    const request=[10.299999999999999,11.299999999999999],observed=[10299999,11299999];
    expect(request.map(mm=>Math.trunc(mm*1e6))).toEqual(observed);
    expect(request.map(routeMmToNativeNm)).toEqual([10300000,11300000]);
    expect(routeSourceMmToNativeNm(10.299999)).toBe(observed[0]);
    expect(routeSourceMmToNativeNm(10.299999)).not.toBe(routeMmToNativeNm(request[0]!));
    expect(request.map(mm=>Math.trunc(routeNativeNmToKipyMm(routeMmToNativeNm(mm))*1e6))).toEqual([10300000,11300000]);
  });
  it.each([0,1,-1,249,-249,1001,-1001,10300000,11300000,1999999999,-1999999999,2000000000,-2000000000])('round-trips exact %i nm through the pinned truncating JSON wire',nm=>{
    const wire=routeNativeNmToKipyMm(nm);
    expect(Math.trunc(Number(JSON.parse(JSON.stringify(wire)))*1e6)).toBe(nm);
    expect(routeSourceMmToNativeNm(routeNativeNmToMm(nm))).toBe(nm);
  });
  it('handles signed adjacent-float edges over a deterministic sample without treating decimal formatting as a guarantee',()=>{
    expect(Math.trunc((249/1e6)*1e6)).toBe(248);
    for(let nm=-10000;nm<=10000;nm++)expect(Math.trunc(routeNativeNmToKipyMm(nm)*1e6)).toBe(nm);
    let seed=0x7a2f3141;
    for(let i=0;i<4096;i++){
      seed=(Math.imul(seed,1664525)+1013904223)>>>0;
      const nm=(seed%4000000001)-2000000000;
      expect(Math.trunc(routeNativeNmToKipyMm(nm)*1e6)).toBe(nm);
    }
  });
  it('uses explicit nearest-even intent materialization and never rounds actual non-native readback',()=>{
    expect([0.0000005,0.0000015,0.0000025,-0.0000005,-0.0000015,-0.0000025].map(routeMmToNativeNm)).toEqual([0,2,2,0,-2,-2]);
    expect(()=>routeSourceMmToNativeNm(10.299999999999999)).toThrow(/exact integer nanometre/);
    expect(()=>routeSourceMmToNativeNm(0.0000005)).toThrow(/exact integer nanometre/);
    expect(()=>routeNativeNmToKipyMm(1.5)).toThrow();expect(()=>routeMmToNativeNm(Infinity)).toThrow();
  });
  it('reads the already-validated native pad position rather than the source-transform residue',()=>{
    expect(9.475+0.825).toBe(10.299999999999999);
    expect(validatedNativePadPositionMm({position:{x_nm:'18000000',y_nm:'10300000'}})).toEqual({xMm:18,yMm:10.3});
    expect(validatedNativePadPositionMm({position:{}})).toEqual({xMm:0,yMm:0});
    expect(()=>validatedNativePadPositionMm({position:{x_nm:'1.5'}})).toThrow();
  });
});
