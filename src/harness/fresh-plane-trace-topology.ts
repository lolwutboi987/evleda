import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import { prepareFreshPlaneConnectivity, isFreshPlaneConnectivityAssessment, type FreshPlaneConnectivityInput, type FreshPlaneConnectivityAssessment } from "./fresh-plane-connectivity.js";
import { verifyHostKicadNativePadObservation, type KicadNativePadObservation } from "../integrations/kicad-native-pad-observation.js";
import { collectQualifiedPcbBores } from "./fresh-plane-drill-topology.js";
import { collectTerminalCopperSource } from "./plane-terminal-copper-source.js";
import { assessTraceCopperTopology, TraceCopperTopologyBoundError } from "./trace-copper-topology.js";
import { routeMmToNativeNm } from "./fresh-route-native-units.js";
import { freezePcbPlaneArtifact } from "./pcb-design-plane-contract.js";

const issued=new WeakSet<object>(),same=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);
const need:(v:unknown,s:string)=>asserts v=(v,s)=>{if(!v)throw new Error(`Plane trace topology: ${s}`);};
export function assessFreshPlaneTraceTopology(input:{readonly connectivity:FreshPlaneConnectivityInput;readonly nativePads:KicadNativePadObservation;readonly endpoints:FreshPlaneConnectivityAssessment}){
  const {compilationBundle:bundle,pcbSource}=input.connectivity,prepared=prepareFreshPlaneConnectivity(input.connectivity);
  const native=verifyHostKicadNativePadObservation(input.nativePads,prepared.nativePadExpected);
  need(isFreshPlaneConnectivityAssessment(input.endpoints)&&same(input.endpoints.bundleIdentity,bundle.identity)
    &&same(input.endpoints.savedSourceIdentity,contentIdentity(pcbSource))&&same(input.endpoints.nativeObservationIdentity,native.rawEnvelopeIdentity)
    &&same(input.endpoints.hostScopeIdentity,input.connectivity.scopeIdentity),'current complete native endpoint and source authority required');
  need(native.inventory!==null,'native physical inventory required');
  const inventory=native.inventory;
  let drillInventory:ReturnType<typeof collectQualifiedPcbBores>|undefined,drillProblem:string|undefined;
  try{drillInventory=collectQualifiedPcbBores(pcbSource,native);}catch(error){drillProblem=error instanceof Error?error.message:'Unsupported complete drill inventory';}
  const rows=bundle.contract.routingConstraints.nets.filter(route=>route.topology!=='plane').map(route=>{
    let calculation:ReturnType<typeof assessTraceCopperTopology>|null=null,problem:string|undefined,knownViolations:readonly string[]=[];
    const endpoint=input.endpoints.nets.find(n=>n.net===route.net);need(endpoint!==undefined,'missing declared native net');
    try{
      need(drillInventory!==undefined,drillProblem??'Complete drill geometry unavailable');
      const pads=inventory.physicalPads.filter(p=>p.role==='numbered-copper'&&p.netName===route.net);
      // The path collector uses an inward-safe rounded-rectangle radius. For a
      // complete contact audit require an exact native-unit radius instead.
      for(const pad of pads){const stack=pad.rawNative.pad_stack as Record<string,any>,copper=(stack.copper_layers as Record<string,any>[])[0]!;
        if(copper.shape==='PSS_ROUNDRECT'){
          const text=String(copper.corner_rounding_ratio),m=/^(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/u.exec(text);need(m!==null,'unsupported roundrect ratio');
          const power=Number(m[3]??0)-(m[2]?.length??0);need(Math.abs(power)<=30,'roundrect exponent bound');
          let n=BigInt(m[1]!+(m[2]??'')),d=1n;if(power>=0)n*=10n**BigInt(power);else d=10n**BigInt(-power);
          const size=copper.size as Record<string,unknown>,x=BigInt(String(size.x_nm??0)),y=BigInt(String(size.y_nm??0));
          need(((x<y?x:y)*n)%d===0n,'sub-nanometre roundrect radius is not supported by the complete contact model');
        }
      }
      const geometry=collectTerminalCopperSource({pcbSource,inventory,net:route.net,eligiblePadUuids:pads.map(p=>p.uuid),copperLayers:bundle.contract.scope.board.copperLayers,bores:drillInventory.bores});
      calculation=assessTraceCopperTopology({...geometry,bores:drillInventory.bores,topology:route.topology,
        boardBoundsNm:{minX:0,minY:0,maxX:routeMmToNativeNm(bundle.contract.scope.board.widthMm),maxY:routeMmToNativeNm(bundle.contract.scope.board.heightMm)}});
    }catch(error){problem=error instanceof Error?error.message:'Unsupported complete trace topology';if(error instanceof TraceCopperTopologyBoundError)knownViolations=error.knownViolations;}
    const nativeConnected=endpoint.status==='connected'&&endpoint.everyEligiblePhysicalMemberReachable;
    const status=calculation?.status==='fail'||knownViolations.length>0||endpoint.status==='disconnected'?'fail' as const
      :calculation?.status==='pass'&&nativeConnected?'pass' as const:'unknown' as const;
    return{id:`trace-net:${route.net}`,kind:'trace_connectivity' as const,net:route.net,topology:route.topology,status,nativeConnected,
      reasons:[...knownViolations,...(calculation?.violations??[]),...(calculation?.unresolved??[]),...(problem?[problem]:[]),
        ...(nativeConnected?[]:['Complete native reachability of every physical terminal is not established.']),
        ...(status==='pass'?['Exact authored source spine and every finite-envelope contact are accounted for without plane copper; current native clearances remain required.']:[])],calculation};
  });
  const payload={schemaVersion:'evleda.fresh-plane-trace-topology.v1' as const,bundleIdentity:bundle.identity,contractIdentity:bundle.contract.identity,
    libraryBindingIdentity:bundle.libraryBinding.identity,verificationPlanIdentity:bundle.verificationPlan.identity,hostScopeIdentity:input.connectivity.scopeIdentity,
    pcbIdentity:contentIdentity(pcbSource),endpointConnectivityIdentity:input.endpoints.identity,nativeObservationIdentity:native.rawEnvelopeIdentity,
    rows,scope:'source-spine-and-finite-copper-contact-cover-with-complete-native-physical-evidence' as const,
    numericalPolicy:'exact-rational-nanometres-with-bounded-positive-witness-search' as const,planeCopperUsed:false as const,
    electricalSuitabilityEvaluated:false as const,fabricationAuthorized:false as const,accepted:false as const};
  const result=freezePcbPlaneArtifact({...payload,identity:canonicalIdentity(payload,payload.schemaVersion)});issued.add(result);return result;
}
export type FreshPlaneTraceTopologyAssessment=ReturnType<typeof assessFreshPlaneTraceTopology>;
export const isFreshPlaneTraceTopologyAssessment=(value:unknown):value is FreshPlaneTraceTopologyAssessment=>value!==null&&typeof value==='object'&&issued.has(value);
