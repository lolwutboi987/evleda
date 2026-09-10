import { existsSync,readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe,it,expect } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { routeMmToNativeNm,routeNativeNmToKipyMm } from "../../src/harness/fresh-route-native-units.js";

const runtime=process.env.EVLEDA_KICAD_INSPECTION_RUNTIME_ROOT
  ?? path.resolve(import.meta.dirname,'../../../working-runtime/inspection-runtime-3.33.3-doc5');
const python=path.join(runtime,'environment/Scripts/python.exe');
const packages=path.join(runtime,'environment/Lib/site-packages');
// Actual installed conversion/protobuf constructors only. No KiCad instance,
// transport, GUI, source writes, native API or edited runtime is involved.
describe('pinned DOC5/KiPy unit conversion ABI',()=>{
  it.skipIf(!existsSync(python)&&!process.env.EVLEDA_KICAD_INSPECTION_RUNTIME_ROOT)('runs actual Vector2.from_xy_mm and the separate width/drill converter on JSON wire values',()=>{
    for(const [file,hash]of [
      ['kipy/util/units.py','963f9614a6879c5f297d207ef079235ee3f6b0fb3e8791bb2e822cbed600008a'],
      ['kipy/geometry.py','5a68c6c58e1488e2e37c18b706f5df85c74360652c4d7f47c03eba0bca99f3ec'],
      ['kicad_mcp/utils/units.py','effc0b3e87d18012431152303f16f9ef1aae52595e7ddcd484cd9fb5ec754ac9'],
    ])expect(contentIdentity(readFileSync(path.join(packages,file!))).digest).toBe(hash);
    const desired=[0,1,-1,249,-249,10300000,11300000,1999999999,-1999999999,2000000000,-2000000000];
    let seed=0x7a2f3141;
    for(let i=0;i<4096;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;desired.push((seed%4000000001)-2000000000);}
    const originals=[10.299999999999999,11.299999999999999,0.000249,-0.000249];
    const dimensions=[0.5,0.6,0.3,0.0000005,0.0000015,0.0000025];
    const payload={wire:desired.map(routeNativeNmToKipyMm),originals,dimensions};
    const code="import json,sys\nfrom kipy.geometry import Vector2\nfrom kicad_mcp.utils.units import mm_to_nm\nx=json.load(sys.stdin)\nprint(json.dumps({'wire':[Vector2.from_xy_mm(v,v).x for v in x['wire']], 'originals':[Vector2.from_xy_mm(v,v).y for v in x['originals']], 'dimensions':[mm_to_nm(v) for v in x['dimensions']]}))";
    const result=spawnSync(python,['-I','-s','-E','-B','-c',code],{input:JSON.stringify(payload),encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:256*1024});
    expect(result.error).toBeUndefined();expect(result.status,result.stderr).toBe(0);
    const actual=JSON.parse(result.stdout);
    expect(actual.wire).toEqual(desired);expect(actual.originals).toEqual([10299999,11299999,248,-248]);
    expect(actual.dimensions).toEqual(dimensions.map(routeMmToNativeNm));
  });
});
