import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const root=import.meta.dirname,hash=b=>createHash('sha256').update(b).digest('hex');
const bytes=fs.readFileSync(path.join(root,'inputs.json')),input=JSON.parse(bytes);
const priorBytes=fs.readFileSync(path.join(root,'../usb-startup-screen-20260920/inputs.json')),prior=JSON.parse(priorBytes);
const pcbPath=path.join(root,'../native-r1-launches/native/rp2350-pico-4layer.kicad_pcb'),pcb=fs.readFileSync(pcbPath);
assert.equal(hash(pcb),input.sourcePcbSha256);assert.equal(prior.part,input.existingPart);
const output=path.resolve(process.argv[2]??path.join(root,'results.json'));
assert.ok(!fs.existsSync(output),'Use a fresh output path to preserve prior results.');
function integrate(curve,target){
  assert.ok(Number.isFinite(target)&&target>0&&target<=curve.at(-1)[0]);
  let chargeUc=0,energyUj=0;
  for(let i=0;i<curve.length;i++){const [v,c]=curve[i];assert.ok(Number.isFinite(v)&&Number.isFinite(c)&&c>0);assert.ok(i===0?v===0:v>curve[i-1][0]);}
  for(let i=1;i<curve.length;i++){
    const [a,ca]=curve[i-1],[b,cb]=curve[i];if(a>=target)break;
    const end=Math.min(target,b),slope=(cb-ca)/(b-a),intercept=ca-slope*a,ce=ca+slope*(end-a);
    chargeUc+=(end-a)*(ca+ce)/2;
    energyUj+=intercept*(end*end-a*a)/2+slope*(end**3-a**3)/3;
  }
  return{chargeUc,energyUj};
}
const cases=input.voltagesV.map(voltageV=>{
  const existing=integrate(prior.curve,voltageV),candidate=integrate(input.curveUf,voltageV);
  return{voltageV,existing,candidate,candidateGraphReadingOnlyChargeUncertaintyUc:voltageV*input.readingUncertaintyUf,
    nominalChargeReductionPercent:100*(1-candidate.chargeUc/existing.chargeUc)};
});
const existingOutput=integrate(prior.curve,input.outputVoltageV),candidateOutput=integrate(input.curveUf,input.outputVoltageV);
const result={schemaVersion:input.schemaVersion,inputsSha256:hash(bytes),existingCurveInputsSha256:hash(priorBytes),sourcePcbSha256:hash(pcb),
  cases,outputCapacitorOnly:{voltageV:input.outputVoltageV,existing:existingOutput,candidate:candidateOutput,
    inputEnergyEquivalentChargeExamples:input.voltagesV.map(v=>({inputVoltageV:v,
      candidateLosslessChargeUc:candidateOutput.energyUj/v,
      candidateChargeUcAtAssumedEfficiency:candidateOutput.energyUj/(v*input.efficiencySensitivityOnly)}))},
  scope:'Nominal capacitor comparison only. Total charge and stored energy are not USB above-threshold region charge or a complete converter startup waveform.',
  referenceMpnIdentified:false,wholeStartupAssessed:false,actualWaveformKnown:false,guaranteedCapacitanceEnvelopeKnown:false,
  nativeSourceChanged:false,decision:'A smaller reference-class47uF part reduces nominal charging demand but does not establish a complete startup fix. No substitution is adopted.'};
assert.deepEqual(fs.readFileSync(pcbPath),pcb);
fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({at5V:cases.find(c=>c.voltageV===5),outputCapacitorOnly:result.outputCapacitorOnly,wholeStartupAssessed:false}));
