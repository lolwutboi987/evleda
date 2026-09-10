import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import ts from "typescript";
import { describe,it,expect } from "vitest";

// Compile only pure diagnostic assertions: importing the executable smoke would
// parse CLI arguments and could open native CAD, which these tests must never do.
const source=readFileSync(new URL("../../scripts/smoke-toolbox-plane-apply.ts",import.meta.url),"utf8");
const pure=source.slice(source.indexOf("function assertPlanePhysicalLogicalCounts"),source.indexOf("function withoutZones"));
const context=vm.createContext({assert});
vm.runInContext(ts.transpile(pure+"\nglobalThis.checks={planeFixtureRoutes,assertPlaneApplyResult,assertGround45Turn};",{target:ts.ScriptTarget.ES2024}),context);
const evaluate=(expression:string)=>vm.runInContext(expression,context);
const rows=[["J1","1","VIN",3,7],["J1","2","VOUT",3,9.54],["J1","3","GND",3,12.08],["R1","1","VIN",10,7],["R1","2","VOUT",10,8.65],["R2","1","VOUT",18,8.65],["R2","2","GND",18,10.3]];
function padFixture(){return {schemaVersion:"evleda.fresh-plane-pad-positions.v1",status:"complete-selection",boardCounts:{physicalPadCount:7,logicalTerminalCount:7,numberedCopperPrimitiveCount:7,namedCopperPrimitiveCount:7,logicalNamedTerminalCount:7,noConnectCopperPrimitiveCount:0,logicalNoConnectTerminalCount:0,nonElectricalFeatureCount:0,platedFootprintHoleCount:3},terminals:rows.map(([reference,pad,net])=>({reference,pad,net})),pads:rows.map(([reference,pad,net,xMm,yMm])=>({reference,pad,net,xMm,yMm,layers:["F.Cu"]}))};}
const uuid="11111111-1111-4111-8111-111111111111";
function applyFixture(){return {schemaVersion:"evleda.fresh-plane-apply-result.v1",operation:"create",applied:true,mutated:true,idempotent:false,nativeActionsPerformed:true,nativeSaveCalledByStage:false,acceptanceEvaluated:false,targetZoneUuid:uuid,completion:"not_evaluated",connection:"not_evaluated",referenceCoverage:"not_evaluated",thermalAcceptance:"not_evaluated",islandAreaAcceptance:"not_evaluated",issues:[],requirements:{minimumAreaEnforcement:"not-enforced-by-always-mode",spokeEnforcement:"external-owned-rule-and-native-evidence"}};}
describe("prepared public plane apply smoke assertions (offline only)",()=>{
 it("derives meaningful VIN and GND-via geometry from matched physical pads",()=>{
  const routes=evaluate(`checks.planeFixtureRoutes(${JSON.stringify(padFixture())})`);
  expect(JSON.parse(JSON.stringify(routes))).toEqual([{net:"VIN",tracks:[{x1Mm:3,y1Mm:7,x2Mm:10,y2Mm:7,layer:"F.Cu"}],vias:[]},{net:"GND",tracks:[{x1Mm:18,y1Mm:10.3,x2Mm:19,y2Mm:10.3,layer:"F.Cu"},{x1Mm:19,y1Mm:10.3,x2Mm:20,y2Mm:11.3,layer:"F.Cu"}],vias:[{xMm:20,yMm:11.3}]}]);
 });
 it("verifies the same-layer degree-two45degree turn",()=>{expect(evaluate(`checks.assertGround45Turn(checks.planeFixtureRoutes(${JSON.stringify(padFixture())})[1].tracks)`)).toBeCloseTo(45,8);});
 it.each(["right-angle","straight","wrong-layer","too-short"])("rejects %s GND replacement geometry",kind=>{
  const tracks=[{x1Mm:18,y1Mm:10.3,x2Mm:19,y2Mm:10.3,layer:"F.Cu"},{x1Mm:19,y1Mm:10.3,x2Mm:20,y2Mm:11.3,layer:"F.Cu"}];
  if(kind==="right-angle")tracks[1]!.x2Mm=19;
  if(kind==="straight")tracks[1]!.y2Mm=10.3;
  if(kind==="wrong-layer")tracks[1]!.layer="B.Cu";
  if(kind==="too-short")tracks[0]!.x1Mm=18.9;
  expect(()=>evaluate(`checks.assertGround45Turn(${JSON.stringify(tracks)})`)).toThrow();
 });
 it("rejects orientation drift before any route plan",()=>{const f=padFixture();f.pads[0]!.xMm=4;expect(()=>evaluate(`checks.planeFixtureRoutes(${JSON.stringify(f)})`)).toThrow();});
 it("rejects incomplete physical inventory",()=>{const f=padFixture();f.pads.pop();expect(()=>evaluate(`checks.planeFixtureRoutes(${JSON.stringify(f)})`)).toThrow();});
 it("requires qualified CREATE result without acceptance claims",()=>{expect(()=>evaluate(`checks.assertPlaneApplyResult(${JSON.stringify(applyFixture())},'create')`)).not.toThrow();});
 it.each(["nativeSaveCalledByStage","acceptanceEvaluated"])("rejects invalid %s claim",key=>{const f={...applyFixture(),[key]:true};expect(()=>evaluate(`checks.assertPlaneApplyResult(${JSON.stringify(f)},'create')`)).toThrow();});
 it("requires UPDATE to retain exact plane UUID",()=>{const f={...applyFixture(),operation:"update"};expect(()=>evaluate(`checks.assertPlaneApplyResult(${JSON.stringify(f)},'update','22222222-2222-4222-8222-222222222222')`)).toThrow();});
 it("keeps mandatory save evidence checks and readonly reopen in executable",()=>{expect(source).toContain('assert.ok(updated.outer.persistence');expect(source).toContain('edit:false, resume: true');expect(source).toContain('bytesActuallyIdentical:afterCreate===afterUpdate');});
});
