import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const root=import.meta.dirname,inputsBytes=fs.readFileSync(path.join(root,'inputs.json')),input=JSON.parse(inputsBytes);
const output=path.resolve(process.argv[2]??path.join(root,'results.json'));
assert.ok(!fs.existsSync(output),'Preserve prior results; choose a fresh output path');
const pcb=path.resolve(root,'../native-r1/native/rp2350-pico-4layer.kicad_pcb'),source=fs.readFileSync(pcb),sha=b=>createHash('sha256').update(b).digest('hex');
assert.equal(sha(source),input.sourcePcbSha256);
for(const [i,[v,c]]of input.curve.entries()){assert.ok(Number.isFinite(v)&&Number.isFinite(c)&&c>0);assert.ok(i===0?v===0:v>input.curve[i-1][0]);}
function pieces(curve,target){assert.ok(target>0&&target<=curve.at(-1)[0]);const result=[];for(let i=1;i<curve.length;i++){const [a,ca]=curve[i-1],[b,cb]=curve[i];if(a>=target)break;const end=Math.min(b,target);result.push([a,end,ca,ca+(cb-ca)*(end-a)/(b-a)]);}return result;}
const charge=(curve,target)=>pieces(curve,target).reduce((q,[a,b,ca,cb])=>q+(b-a)*(ca+cb)/2,0); // uF*V = uC
function energy(curve,target){return pieces(curve,target).reduce((sum,[a,b,ca,cb])=>{const slope=(cb-ca)/(b-a),intercept=ca-slope*a;return sum+intercept*(b*b-a*a)/2+slope*(b*b*b-a*a*a)/3;},0);} // uF*V^2 = uJ
function positiveAffineIntegral(a,b,ya,yb){if(ya<=0&&yb<=0)return 0;if(ya>=0&&yb>=0)return(b-a)*(ya+yb)/2;const zero=a+(b-a)*(-ya)/(yb-ya);return ya>0?(zero-a)*ya/2:(b-zero)*yb/2;}
function excess(curve,target,rampMs,thresholdMa){assert.ok(rampMs>0);const slope=target/rampMs;return pieces(curve,target).reduce((q,[a,b,ca,cb])=>q+positiveAffineIntegral(a,b,ca*slope-thresholdMa,cb*slope-thresholdMa)/slope,0);} // mA*ms = uC
function minimumRamp(curve,target,limitUc,thresholdMa){let lo=0,hi=10;while(excess(curve,target,hi,thresholdMa)>limitUc)hi*=2;for(let i=0;i<70;i++){const mid=(lo+hi)/2;if(excess(curve,target,mid,thresholdMa)>limitUc)lo=mid;else hi=mid;}return hi;}
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);
// Independent analytic cases: constant C, threshold crossing, and stored energy.
near(charge([[0,10],[5,10]],5),50);near(energy([[0,10],[5,10]],3.3),54.45);
near(excess([[0,10],[5,10]],5,.1,100),40);near(excess([[0,10],[5,10]],5,1,100),0);
near(excess([[0,30],[5,10]],5,1,100),12.5);near(minimumRamp([[0,47],[5,47]],5,50,100),1.85);
const scenarios=[];
for(const [label,scale]of [['approximate-reference-curve',1],['illustrative-1.38-scale-not-guaranteed',input.illustrativeScaleOnly]]){
  const curve=input.curve.map(([v,c])=>[v,c*scale]);
  for(const voltage of input.targetVsysV){const q=charge(curve,voltage),m=minimumRamp(curve,voltage,input.comparisonScreenUc,input.thresholdMa);scenarios.push({label,scale,voltage,capacitorChargeUc:q,graphReadingOnlyChargeUncertaintyUc:input.readingUncertaintyUf*scale*voltage,energyUj:energy(curve,voltage),minimumAssumedLinearRampFor50UcMs:m,minimumAssumedLinearRampForNo100MaEventMs:Math.max(...curve.map(x=>x[1]))*voltage/input.thresholdMa,rampResults:input.assumedLinearRampMs.map(rampMs=>({rampMs,peakCapacitorCurrentMa:Math.max(...pieces(curve,voltage).flatMap(x=>[x[2],x[3]]))*voltage/rampMs,capacitorOnlyExcessChargeUc:excess(curve,voltage,rampMs,input.thresholdMa)}))});}
}
const outputCapEnergy=energy(input.curve,3.3);
const result={schemaVersion:'evleda.rp2350-usb-startup-screen.v1',sourcePcbSha256:input.sourcePcbSha256,inputsSha256:sha(inputsBytes),scope:input.scope,
  assumptions:['Approximate reference C(V), treated as incremental capacitance on one charging branch.','The VSYS voltage ramp is imposed by the calculation. The actual diode path does not impose that ramp.','Capacitor-only result: C22/C26, converter input current, downstream capacitors and load are excluded.','The curve has one small peak, so the positive-threshold portions in these simple capacitor-only ramps form at most one region. This is not a general USBET waveform evaluator.','No result is a whole-board or production compliance pass.'],
  analyticChecksPassed:6,scenarios,outputCapacitorC21:{energyTo3v3Uj:outputCapEnergy,inputChargeEnergyExamples:[3.6,4.7,5].map(vin=>({vinV:vin,idealLosslessChargeUc:outputCapEnergy/vin,assumed70PercentEfficiencyChargeUc:outputCapEnergy/(vin*.7)})),scope:'Energy screen for C21 alone. No regulator waveform, minimum startup duration, loss model, other rail capacitance or startup load is established.'},
  actualWaveformKnown:false,guaranteedJointCapacitanceEnvelopeKnown:false,completeStartupAssessed:false,pcbChanged:false};
assert.deepEqual(fs.readFileSync(pcb),source);fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({at5V:scenarios.filter(s=>s.voltage===5).map(s=>({label:s.label,chargeUc:s.capacitorChargeUc,minRampMs:s.minimumAssumedLinearRampFor50UcMs,noEventRampMs:s.minimumAssumedLinearRampForNo100MaEventMs})),c21:result.outputCapacitorC21,completeStartupAssessed:false}));
