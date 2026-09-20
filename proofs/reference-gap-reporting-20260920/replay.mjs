import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseFreshPcbSource} from '../../src/harness/fresh-kicad-parser.ts';
import {createReferenceCoverageCalculator} from '../../src/integrations/kicad-reference-coverage.ts';
import {createToolboxReferenceCoverage} from '../../src/mcp/toolbox-reference-coverage.ts';

assert.equal(process.argv.length,4,'Supply the qualified helper and a fresh output directory');
const executablePath=path.resolve(process.argv[2]),out=path.resolve(process.argv[3]);
assert.ok(!fs.existsSync(out),'Preserve existing output');
const file=path.resolve(import.meta.dirname,'../../designs/rp2350-pico/native-r1-regional/native/rp2350-pico-4layer.kicad_pcb');
const bytes=fs.readFileSync(file),sha=createHash('sha256').update(bytes).digest('hex');
assert.equal(sha,'5fd653d353838cdc4a2dfb36b856d18de65c55d3911aa57cbc9595bac812f05d');
const board=parseFreshPcbSource(bytes.toString('utf8'));
fs.mkdirSync(out);
const calculator=await createReferenceCoverageCalculator({executablePath,
  expectedExecutableIdentity:{sha256:'11f52b6031a30f0e5a7a4a3a0b4479774df829dc85caf845d97127b2b49c7b62',sizeBytes:980480},
  cwd:path.dirname(executablePath),outputRoot:out,
  environment:{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,TEMP:out,TMP:out}});
const assess=await createToolboxReferenceCoverage({pcbPath:file,calculator}),reports=[];
for(const net of ['SWCLK_HDR','SWDIO_HDR']){
  const segments=board.segments.filter(s=>s.netName===net);
  assert.equal(segments.length,net==='SWCLK_HDR'?11:10);
  assert.ok(segments.every(s=>s.layer==='F.Cu'));
  const report=await assess({signalNets:[net],signalLayer:'F.Cu',referenceNet:'GND',referenceLayer:'In1.Cu',
    segmentIds:segments.map(s=>s.id),marginNm:250000,
    marginBasis:'Unchanged bound reference margin; stored geometry only, no native fill authority or electrical acceptance.',expectedSourceSha256:sha});
  fs.writeFileSync(path.join(out,net+'-0.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  reports.push({net,geometricStatus:report.geometricStatus,segments:report.selectedSegments.length,
    noncovered:report.routeResults?.filter(r=>r.status!=='covered').map(r=>({segmentId:r.segmentId,status:r.status,outsideWitnessDoubledNm:r.outsideWitnessDoubledNm}))});
}
assert.deepEqual(fs.readFileSync(file),bytes);
const summary={sourcePcbSha256:sha,reports,sourceUnchanged:true,liveFillAuthorityClaimed:false,electricalAcceptanceClaimed:false};
fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(summary));
