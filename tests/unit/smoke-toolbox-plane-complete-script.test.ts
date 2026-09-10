import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import ts from "typescript";
import { mkdtemp,writeFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createToolboxPracticeAnalyzer } from "../../src/mcp/toolbox-practices.js";
import { describe,it,expect } from "vitest";

// Compile only pure diagnostic assertions: importing the executable smoke would
// parse CLI arguments and could open native CAD, which these tests must never do.
const source=readFileSync(new URL("../../scripts/smoke-toolbox-plane-complete.ts",import.meta.url),"utf8");
const pure=source.slice(source.indexOf("function assertPlanePhysicalLogicalCounts"),source.indexOf("function withoutZones"));
const context=vm.createContext({assert});
vm.runInContext(ts.transpile(pure+"\nglobalThis.checks={planeFixtureRoutes,assertPlaneApplyResult,assertGround45Turn,completeVoutRoute,assertEndpointAssessment,assertEndpointWrapper,assertProfileFreePractice,assertNativeValidation};",{target:ts.ScriptTarget.ES2024}),context);
const evaluate=(expression:string)=>vm.runInContext(expression,context);
const rows=[["J1","1","VIN",3,7],["J1","2","VOUT",3,9.54],["J1","3","GND",3,12.08],["R1","1","VIN",10,7],["R1","2","VOUT",10,8.65],["R2","1","VOUT",17.175,9.475],["R2","2","GND",18.825,9.475]];
function padFixture(){return {schemaVersion:"evleda.fresh-plane-pad-positions.v1",status:"complete-selection",boardCounts:{physicalPadCount:7,logicalTerminalCount:7,numberedCopperPrimitiveCount:7,namedCopperPrimitiveCount:7,logicalNamedTerminalCount:7,noConnectCopperPrimitiveCount:0,logicalNoConnectTerminalCount:0,nonElectricalFeatureCount:0,platedFootprintHoleCount:3},terminals:rows.map(([reference,pad,net])=>({reference,pad,net})),pads:rows.map(([reference,pad,net,xMm,yMm])=>({reference,pad,net,xMm,yMm,layers:["F.Cu"]}))};}
const uuid="11111111-1111-4111-8111-111111111111";
function applyFixture(){return {schemaVersion:"evleda.fresh-plane-apply-result.v1",operation:"create",applied:true,mutated:true,idempotent:false,nativeActionsPerformed:true,nativeSaveCalledByStage:false,acceptanceEvaluated:false,targetZoneUuid:uuid,completion:"not_evaluated",connection:"not_evaluated",referenceCoverage:"not_evaluated",thermalAcceptance:"not_evaluated",islandAreaAcceptance:"not_evaluated",issues:[],requirements:{minimumAreaEnforcement:"not-enforced-by-always-mode",spokeEnforcement:"external-owned-rule-and-native-evidence"}};}
describe("prepared complete public plane smoke assertions (offline only)",()=>{
 it("accepts the actual profile-free practice producer without inventing analysis",async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"complete-driver-practice-"));
  try{
   const pcbPath=path.join(root,"board.kicad_pcb");
   await writeFile(pcbPath,'(kicad_pcb (version 20260206) (layers (0 "F.Cu" signal) (2 "B.Cu" signal)) (net 1 "SIG") (segment (start 0 0) (end 1 0) (width 0.5) (layer "F.Cu") (net 1) (uuid "a")) (segment (start 1 0) (end 2 1) (width 0.5) (layer "F.Cu") (net 1) (uuid "b")))');
   const report=await(await createToolboxPracticeAnalyzer({pcbPath}))();
   expect(()=>evaluate(`checks.assertProfileFreePractice(${JSON.stringify({sourceUnchanged:true,report})})`)).not.toThrow();
   expect(report.analysis).toBeNull();expect(report.reviewedProfileIdentity).toBeNull();
   expect(()=>evaluate(`checks.assertProfileFreePractice(${JSON.stringify({sourceUnchanged:true,report:{...report,analysis:{findings:[]}}})})`)).toThrow();
   expect(()=>evaluate(`checks.assertProfileFreePractice(${JSON.stringify({sourceUnchanged:true,report:{...report,turnPolicy:{...report.turnPolicy,violations:[{angle:90}]}}})})`)).toThrow();
  }finally{assert.equal(path.dirname(root),tmpdir());await rm(root,{recursive:true,force:true});}
 });
 it("accepts retained native verdict.v1 metadata shape and rejects unavailable/unclean checks",()=>{
  // Shape verified from retained real STDIO proof11 report and pinned DOC5 validation.py.
  const erc={schema_version:"verdict.v1",verdict:"PASS",status:"clean",metadata:{available:true,violation_count:0,violations:[],summary:{}}};
  const drc={schema_version:"verdict.v1",verdict:"PASS",status:"clean",metadata:{available:true,violations:0,unconnected_items:0,courtyard_issues:0,report_status:"clean"}};
  const wrap=()=>({sourceUnchanged:true,checks:[{name:"run_erc",result:{content:JSON.stringify(erc)}},{name:"run_drc",result:{content:JSON.stringify(drc)}}]});
  expect(()=>evaluate(`checks.assertNativeValidation(${JSON.stringify(wrap())})`)).not.toThrow();
  drc.metadata.unconnected_items=1;expect(()=>evaluate(`checks.assertNativeValidation(${JSON.stringify(wrap())})`)).toThrow();
  drc.metadata.unconnected_items=0;erc.metadata.available=false;expect(()=>evaluate(`checks.assertNativeValidation(${JSON.stringify(wrap())})`)).toThrow();
 });
 it("completes VOUT through both resistor terminals using45degree and collinear segments",()=>{
  const route=JSON.parse(JSON.stringify(evaluate(`checks.completeVoutRoute(${JSON.stringify(padFixture())})`)));
  expect(route.net).toBe("VOUT");expect(route.vias).toEqual([]);expect(route.tracks).toHaveLength(5);
  expect(route.tracks[0]).toMatchObject({x1Mm:3,y1Mm:9.54,x2Mm:7,y2Mm:9.54});
  expect(route.tracks[1].x2Mm).toBeCloseTo(7.89,12);expect(route.tracks[1].y2Mm).toBe(8.65);
  expect(route.tracks[2]).toMatchObject({x2Mm:10,y2Mm:8.65});expect(route.tracks[3]).toMatchObject({x1Mm:10,y1Mm:8.65,y2Mm:8.65});expect(route.tracks[3].x2Mm).toBeCloseTo(16.35,12);expect(route.tracks[4]).toMatchObject({x2Mm:17.175,y2Mm:9.475});
 });
 it.each([false,true])("checks actual assessment transition complete=%s without acceptance promotion",complete=>{
  const assessment={schemaVersion:"evleda.toolbox-endpoint-connectivity.v1",assessmentSchemaVersion:"evleda.fresh-plane-connectivity.v1",family:"plane-v2",status:complete?"connected":"partially-connected",acceptanceEvaluated:false,verificationPlanRowsPassed:[],nets:["GND","VIN","VOUT"].map(net=>({net,status:complete||net!=="VOUT"?"connected":"disconnected",logicalEndpointReachability:{status:complete||net!=="VOUT"?"reachable":"disconnected"},everyEligiblePhysicalMemberReachable:complete||net!=="VOUT"}))};
  expect(()=>evaluate(`checks.assertEndpointAssessment(${JSON.stringify(assessment)},${complete})`)).not.toThrow();
  assessment.nets[0]!.everyEligiblePhysicalMemberReachable=false;
  expect(()=>evaluate(`checks.assertEndpointAssessment(${JSON.stringify(assessment)},${complete})`)).toThrow();
 });
 it("derives meaningful VIN and GND-via geometry from matched physical pads",()=>{
  const routes=evaluate(`checks.planeFixtureRoutes(${JSON.stringify(padFixture())})`);
  expect(JSON.parse(JSON.stringify(routes))).toEqual([{net:"VIN",tracks:[{x1Mm:3,y1Mm:7,x2Mm:10,y2Mm:7,layer:"F.Cu"}],vias:[]},{net:"GND",tracks:[{x1Mm:18.825,y1Mm:9.475,x2Mm:19.825,y2Mm:9.475,layer:"F.Cu"},{x1Mm:19.825,y1Mm:9.475,x2Mm:20.825,y2Mm:10.475,layer:"F.Cu"}],vias:[{xMm:20.825,yMm:10.475}]}]);
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
 it("rejects the old R2 rotation geometry before routing",()=>{const f=padFixture();f.pads[5]!.xMm=18;f.pads[5]!.yMm=8.65;expect(()=>evaluate(`checks.completeVoutRoute(${JSON.stringify(f)})`)).toThrow();});
 it("rejects legacy raw assessment schema in the public summary",()=>{expect(()=>evaluate(`checks.assertEndpointAssessment({schemaVersion:'evleda.fresh-plane-connectivity.v1'},true)`)).toThrow();});
 it("rejects incomplete physical inventory",()=>{const f=padFixture();f.pads.pop();expect(()=>evaluate(`checks.planeFixtureRoutes(${JSON.stringify(f)})`)).toThrow();});
 it("requires qualified CREATE result without acceptance claims",()=>{expect(()=>evaluate(`checks.assertPlaneApplyResult(${JSON.stringify(applyFixture())},'create')`)).not.toThrow();});
 it.each(["nativeSaveCalledByStage","acceptanceEvaluated"])("rejects invalid %s claim",key=>{const f={...applyFixture(),[key]:true};expect(()=>evaluate(`checks.assertPlaneApplyResult(${JSON.stringify(f)},'create')`)).toThrow();});
 it("requires UPDATE to retain exact plane UUID",()=>{const f={...applyFixture(),operation:"update"};expect(()=>evaluate(`checks.assertPlaneApplyResult(${JSON.stringify(f)},'update','22222222-2222-4222-8222-222222222222')`)).toThrow();});
 it("keeps mandatory save evidence checks and readonly reopen in executable",()=>{expect(source).toContain('assert.ok(updated.outer.persistence');expect(source).toContain('edit:false, resume: true');expect(source).toContain('bytesActuallyIdentical:beforeReapply===afterUpdate');});
});
