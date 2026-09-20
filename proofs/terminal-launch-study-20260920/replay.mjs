import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReferenceCoverageCalculator} from '../../src/integrations/kicad-reference-coverage.ts';
import {createToolboxReferenceCoverage} from '../../src/mcp/toolbox-reference-coverage.ts';
assert.equal(process.argv.length,4,'Supply the qualified helper and a fresh output directory');
const executablePath=path.resolve(process.argv[2]),out=path.resolve(process.argv[3]);
assert.ok(!fs.existsSync(out));fs.mkdirSync(out);
const file=path.resolve(import.meta.dirname,'../../designs/rp2350-pico/native-r1-regional/native/rp2350-pico-4layer.kicad_pcb');
const bytes=fs.readFileSync(file),hash=b=>createHash('sha256').update(b).digest('hex'),sha=hash(bytes);
assert.equal(sha,'5fd653d353838cdc4a2dfb36b856d18de65c55d3911aa57cbc9595bac812f05d');
const calculator=await createReferenceCoverageCalculator({executablePath,
  expectedExecutableIdentity:{sha256:'11f52b6031a30f0e5a7a4a3a0b4479774df829dc85caf845d97127b2b49c7b62',sizeBytes:980480},
  cwd:path.dirname(executablePath),outputRoot:out,
  environment:{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,TEMP:out,TMP:out}});
const assess=await createToolboxReferenceCoverage({pcbPath:file,calculator}),results=[];
for(const [net,pin,maximumLengthNm] of [['SWCLK_HDR','1',1900000],['SWDIO_HDR','3',1500000]]){
  const report=await assess({signalNets:[net],signalLayer:'F.Cu',referenceNet:'GND',referenceLayer:'In1.Cu',marginNm:250000,
    marginBasis:'Unchanged bound margin for both original ribbons and the prospective remainders.',expectedSourceSha256:sha,
    terminalLaunchStudy:[{signalEndpoint:{reference:'J4',pin},referenceEndpoint:{reference:'J4',pin:'2'},maximumLengthNm,
      maximumReturnSpacingNm:2540000,engineeringBasis:'Prospective separation of ordinary through-hole terminal approach from the continuous reference route. Retain the original failed requirement; no launch or return-path approval.'}]});
  assert.equal(report.status,'computed');assert.equal(report.geometricStatus,'uncovered');
  assert.equal(report.terminalLaunchStudy.status,'computed');assert.equal(report.terminalLaunchStudy.remainderGeometricStatus,'covered');
  assert.equal(report.terminalLaunchStudy.acceptanceChanged,false);
  fs.writeFileSync(path.join(out,net+'.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  results.push({net,selectedSegments:report.selectedSegments.length,originalGeometricStatus:report.geometricStatus,
    proposedMaximumLaunchNm:maximumLengthNm,remainderGeometricStatus:report.terminalLaunchStudy.remainderGeometricStatus,
    launch:report.terminalLaunchStudy.launches[0],launchElectricalValidity:report.terminalLaunchStudy.launchElectricalValidity});
}
assert.deepEqual(fs.readFileSync(file),bytes);
const summary={scope:'Current saved source and real pinned geometry helper through the source-reader capability. No live KiCad session, fill freshness, contract revision or acceptance transfer.',
  sourcePcbSha256:sha,sourceUnchanged:true,results,acceptanceChanged:false};
fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(results.map(r=>({net:r.net,original:r.originalGeometricStatus,remainder:r.remainderGeometricStatus,maximumLaunchNm:r.proposedMaximumLaunchNm}))));
