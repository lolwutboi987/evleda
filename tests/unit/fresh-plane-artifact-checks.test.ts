import { describe, expect, it } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { assessFreshPlaneComponentArtifacts, freshPlaneArtifactNetlistScope, freshPlaneArtifactSourceIdentities, type FreshPlaneArtifactSources } from "../../src/harness/fresh-plane-artifact-checks.js";
import { assessFreshPlaneAcceptance } from "../../src/harness/fresh-plane-acceptance.js";
import { summarizePlaneArtifactChecks } from "../../src/mcp/toolbox-artifact-checks.js";
import { prepareFreshPlaneConnectivity, assessFreshPlaneConnectivity } from "../../src/harness/fresh-plane-connectivity.js";
import { createFreshNativeTerminalBinding } from "../../src/harness/fresh-native-terminal-binding.js";
import { createFreshConnectivityContract } from "../../src/harness/fresh-connectivity-contract.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { createPcbLibrarySourceSelection } from "../../src/harness/pcb-library-source-binding.js";
import { createFreshPlaneRules } from "../../src/harness/fresh-plane-rules.js";
import { parseFreshSymbolLibraryTerminalGeometrySource } from "../../src/harness/fresh-kicad-parser.js";
import { collectKicadNativePadObservation } from "../../src/integrations/kicad-native-pad-observation.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { genericDividerLibraryResolver } from "../helpers/generic-divider-bundle.js";
import { nativePadObservationFixture } from "../helpers/native-pad-observation-fixture.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";

// Constructed source/native-port fixtures only; never a physical KiCad qualification.
async function fixture(pcbValue = '10k') {
  const draft = planeDividerDraft();
  const uuid=(i:number)=>`88888888-8888-4888-8888-${String(i).padStart(12,'0')}`;
  const pcb = '(kicad_pcb (version 20260206) (generator "pcbnew") (general (thickness 1.6))'
    + '(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))'
    + '(gr_rect (start 0 0) (end 30 20) (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts"))'
    + draft.components.map((c,i)=>`(footprint "${c.footprintLibId}" (uuid "${uuid(i+1)}") (layer "F.Cu") (at ${5+i*8} 5)
      (property "Reference" "${c.reference}") (property "Value" "${c.reference==='R1'?pcbValue:c.value}")
      ${c.pins.map((pin,j)=>`(pad "${pin.pin}" smd rect (uuid "${uuid((i+1)*100+j)}") (at 0 ${j*2}) (size 1 1) (layers "F.Cu") (net "${pin.assignment.kind==='net'?pin.assignment.net:''}"))`).join('')})`).join('')+')';
  const native=await nativePadObservationFixture(pcb);
  const definitions=new Map<string,string>(), libraries=new Map<string,string>();
  for(const c of draft.components){const leaf=c.symbolLibId.split(':')[1]!;
    const definition=`(symbol "${leaf}" (symbol "${leaf}_1_1" ${c.pins.map((p,i)=>`(pin passive line (at ${i*2.54} 0 90) (length 2.54) (name "P${p.pin}") (number "${p.pin}"))`).join('')}))`;
    definitions.set(c.symbolLibId,definition);libraries.set(c.symbolLibId,`(kicad_symbol_lib (version 20250114) (generator "offline-test") ${definition})`);}
  const revision={symbol:0};
  const resolver={...genericDividerLibraryResolver,
    inspectFootprint:native.expected.physicalFootprintResolver!.inspectFootprint,
    inspectSymbolTerminalGeometry:(id:string)=>parseFreshSymbolLibraryTerminalGeometrySource(libraries.get(id)!,contentIdentity(libraries.get(id)!),id),
    captureSourceSelection:(request:{symbolIds:readonly string[];footprintIds:readonly string[]})=>createPcbLibrarySourceSelection({
      policyIdentity:canonicalIdentity({fixture:'artifact-policy'},'evleda.test-library-policy.v1'),
      records:([...request.symbolIds.map(libraryId=>({kind:'symbol' as const,libraryId,sourceIdentity:contentIdentity(libraries.get(libraryId)!+(revision.symbol?'changed':'')),
        inspectionIdentity:canonicalIdentity({libraryId},'evleda.kicad-stock-symbol-inspection.v1')})),
      ...request.footprintIds.map(libraryId=>({kind:'footprint' as const,libraryId,sourceIdentity:native.expected.physicalFootprints!.find(f=>f.libraryId===libraryId)!.sourceIdentity,
        inspectionIdentity:canonicalIdentity({libraryId},'evleda.kicad-stock-footprint-inspection.v2')}))])},request),
  };
  const dependencies={libraryResolver:resolver,deepRuleCatalog:loadDeepRuleCatalog()},compilation=compilePcbPlaneDesignIntentDraft(draft,dependencies);
  if(compilation.disposition!=='ready')throw new Error(JSON.stringify(compilation));
  const bundle=createPcbPlaneCompilationBundle({originalPrompt:'Offline component artifact verification only.',compilation},dependencies);
  const schematic=`(kicad_sch (version 20250114) (lib_symbols ${[...definitions].map(([id,s])=>s.replace(`(symbol "${id.split(':')[1]}"`,`(symbol "${id}"`)).join('')})
    ${draft.components.map((c,i)=>`(symbol (lib_id "${c.symbolLibId}") (unit 1) (at ${40+i*20} 40 0)
      (property "Reference" "${c.reference}") (property "Value" "${c.value}") (property "Footprint" "${c.footprintLibId}"))`).join('')})`;
  const sources:FreshPlaneArtifactSources={pcb,schematic,project:'{}',rules:createFreshPlaneRules(bundle).source,symbolLibraryTable:'(sym_lib_table)',footprintLibraryTable:'(fp_lib_table)'};
  const logical=createFreshConnectivityContract(bundle.contract),scopeIdentity=canonicalIdentity({fixture:'current-artifacts'},'evleda.test-current-artifacts.v1');
  const netlist=`(export (components ${logical.components.map(c=>{const [lib,part]=c.symbolLibId.split(':');return `(comp (ref "${c.reference}") (value "${c.value}") (footprint "${c.footprintLibId}") (libsource (lib "${lib}") (part "${part}")))`;}).join('')})
    (nets ${logical.nets.map((n,i)=>`(net (code "${i+1}") (name "${n.name}") ${n.endpoints.map(e=>`(node (ref "${e.reference}") (pin "${e.pin}") (pintype "passive"))`).join('')})`).join('')}))`;
  const terminalBinding=createFreshNativeTerminalBinding(logical,netlist,scopeIdentity);
  const connectivity={compilationBundle:bundle,pcbPath:native.expected.pcbPath,pcbSource:pcb,scopeIdentity,physicalFootprints:native.expected.physicalFootprints!,physicalFootprintResolver:native.expected.physicalFootprintResolver!,nativeTerminalBinding:terminalBinding};
  const prepared=prepareFreshPlaneConnectivity(connectivity);
  const payload=structuredClone(native.observation.rawSnapshot) as Record<string,any>;
  payload.connectivity=prepared.nativePadExpected.requestedPrimitiveIds.map(id=>payload.connectivity.find((q:{sourcePrimitiveId:string})=>q.sourcePrimitiveId===id));
  const pads=await collectKicadNativePadObservation({readLivePcbPadSnapshot:async()=>({isError:false,content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:payload})},prepared.nativePadExpected);
  const nativeNetlistBinding=createFreshNativeTerminalBinding(logical,netlist,freshPlaneArtifactNetlistScope(bundle,scopeIdentity,sources));
  const input={connectivity,sources,nativePads:pads,nativeNetlistSource:netlist,nativeNetlistBinding,libraryResolver:resolver,schematicLibraryResolver:resolver};
  const acceptance={compilationBundle:bundle,pcbSource:pcb,projectSettingsSource:sources.project,rulesSource:sources.rules,savedEvidence:null,
    endpointConnectivity:assessFreshPlaneConnectivity({...connectivity,nativePads:pads}),artifactSourceIdentities:freshPlaneArtifactSourceIdentities(sources)};
  return{input,acceptance,revision};
}

describe('current native/source V2 component artifact checks',()=>{
  it('completes the exact library, PCB, schematic and net rows without fresh fill or a V1 substitute',async()=>{
    const f=await fixture(),artifact=assessFreshPlaneComponentArtifacts(f.input);
    expect(artifact.rows).toHaveLength(12);expect(artifact.rows.every(r=>r.status==='pass')).toBe(true);
    expect(artifact.components).toHaveLength(3);expect(artifact.components.map(c=>c.physicalPadCount)).toEqual([3,2,2]);
    expect(artifact).toMatchObject({accepted:false,electricalSuitabilityEvaluated:false,fabricationAuthorized:false});
    const assessed=await assessFreshPlaneAcceptance({...f.acceptance,artifactChecks:[artifact]});
    for(const row of artifact.rows)expect(assessed.rows.find(r=>r.id===row.id)?.status).toBe('pass');
    expect(assessed.rows.find(r=>r.id==='plane-net:GND')?.status).toBe('unknown');expect(assessed.accepted).toBe(false);
    const projected=summarizePlaneArtifactChecks(artifact,assessed.rows,false);expect(projected.rows).toHaveLength(12);
    expect(projected.sourceIdentities.schematic).toEqual(contentIdentity(f.input.sources.schematic));
  });
  it('retains an observed PCB value mismatch as a failed original row even without fill',async()=>{
    const f=await fixture('1k'),artifact=assessFreshPlaneComponentArtifacts(f.input);
    expect(artifact.rows.find(r=>r.id==='pcb:R1')?.status).toBe('fail');
    const assessed=await assessFreshPlaneAcceptance({...f.acceptance,artifactChecks:[artifact]});
    expect(assessed.rows.find(r=>r.id==='pcb:R1')?.status).toBe('fail');expect(assessed.status).toBe('failed');
  });
  it('rejects a changed schematic or table against the captured native export scope',async()=>{
    const f=await fixture();
    for(const key of ['schematic','symbolLibraryTable','footprintLibraryTable'] as const)expect(()=>assessFreshPlaneComponentArtifacts({...f.input,sources:{...f.input.sources,[key]:f.input.sources[key]+'\n'}})).toThrow(/scope/);
  });
  it('rejects source/library drift and a decoded native snapshot without collection authority',async()=>{
    const f=await fixture();
    expect(()=>assessFreshPlaneComponentArtifacts({...f.input,nativePads:structuredClone(f.input.nativePads)})).toThrow();
    f.revision.symbol=1;expect(()=>assessFreshPlaneComponentArtifacts(f.input)).toThrow();
  });
  it('rejects copied artifact claims, duplicate groups, and stale complete source identities',async()=>{
    const f=await fixture(),a=assessFreshPlaneComponentArtifacts(f.input);
    await expect(assessFreshPlaneAcceptance({...f.acceptance,artifactChecks:[structuredClone(a)]})).rejects.toThrow(/unbranded/);
    await expect(assessFreshPlaneAcceptance({...f.acceptance,artifactChecks:[a,a]})).rejects.toThrow(/duplicate artifact/);
    await expect(assessFreshPlaneAcceptance({...f.acceptance,artifactChecks:[a],artifactSourceIdentities:{...f.acceptance.artifactSourceIdentities,schematic:contentIdentity('stale')}})).rejects.toThrow(/complete current source/);
    const {artifactSourceIdentities:_sources,...missingSources}=f.acceptance;
    await expect(assessFreshPlaneAcceptance({...missingSources,artifactChecks:[a]})).rejects.toThrow(/complete current source/);
  });
  it('does not project injected private metadata or a manufactured acceptance claim',async()=>{
    const f=await fixture(),a=assessFreshPlaneComponentArtifacts(f.input),assessment=await assessFreshPlaneAcceptance({...f.acceptance,artifactChecks:[a]});
    const {identity:_id,...body}=a;
    for(const altered of[{...body,privatePath:'C:/private'}, {...body,accepted:true}]){
      const forged={...altered,identity:canonicalIdentity(altered,a.schemaVersion)};
      expect(()=>summarizePlaneArtifactChecks(forged as typeof a,assessment.rows,false)).toThrow();
    }
    const omitted={...body,rows:body.rows.slice(1)};expect(()=>summarizePlaneArtifactChecks({...omitted,identity:canonicalIdentity(omitted,a.schemaVersion)},assessment.rows,false)).toThrow(/inventory/);
  });
});
