/** Synthetic host-port receipts exercise scope binding; not native KiCad qualification. */
import { describe, expect, it } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { createInterfaceConstructionBoardSeed } from "../../src/harness/interface-construction-seed.js";
import { prepareFreshPlaneMutation, resolveFreshPlaneSourceZones, assertFreshPlaneDeclaredZoneSettings } from "../../src/harness/fresh-plane-mutation.js";
import { validateFreshPlaneStageObservation } from "../../src/harness/fresh-plane-stage-observation.js";
import { createSavedFreshPlaneEvidence } from "../../src/harness/fresh-plane-evidence.js";
import { assessFreshPlaneDrillTopology } from "../../src/harness/fresh-plane-drill-topology.js";
import { parseFreshPcbReferenceGeometry } from "../../src/harness/fresh-kicad-parser.js";
import { createFreshPlaneRules } from "../../src/harness/fresh-plane-rules.js";
import { fourLayerPlaneDraft } from "../helpers/four-layer-plane-bundle.js";
import { interfaceConstructionBundle } from "../helpers/interface-construction-bundle.js";
import { planeStageObservationFixture } from "../helpers/plane-stage-observation-fixture.js";

const id=(n:number)=>`88888888-8888-4888-8888-${String(n).padStart(12,"0")}`;
async function fixture() {
  const draft=fourLayerPlaneDraft(); draft.planes.find((p:any)=>p.id==="BACK_GND").boundary.maxXmm=20.5;
  const bundle=interfaceConstructionBundle(draft), seed=createInterfaceConstructionBoardSeed(bundle);
  const footprints=bundle.contract.components.map((c,i)=>`(footprint ${JSON.stringify(c.footprintLibId)} (uuid "${id(i+1)}") (layer "F.Cu") (at ${2+10*i} 2)
    (property "Reference" "${c.reference}") (property "Value" "TEST")
    ${c.pins.map((pin,j)=>`(pad "${pin.pin}" thru_hole circle (uuid "${id(100+10*i+j)}") (at 0 ${2*j}) (size 1 1) (drill 0.4) (layers "*.Cu" "*.Mask") (net "${pin.assignment.kind==="net"?pin.assignment.net:""}"))`).join("\n")})`).join("\n");
  const before=seed.slice(0,seed.lastIndexOf(")"))+footprints+"\n)\n";
  const a=prepareFreshPlaneMutation({compilationBundle:bundle,beforePcbSource:before,planeId:"GND_PLANE",operation:"create"});
  const first=await planeStageObservationFixture({beforePcbSource:before,mutation:a.mutation,zoneId:id(900)});
  validateFreshPlaneStageObservation(first.receipt,{...first,prepared:a});
  const b=prepareFreshPlaneMutation({compilationBundle:bundle,beforePcbSource:first.stagedSource,planeId:"BACK_GND",operation:"create"});
  const second=await planeStageObservationFixture({beforePcbSource:first.stagedSource,mutation:b.mutation,zoneId:id(901),beforeZoneProtos:[first.stagedZoneProto]});
  const stage=validateFreshPlaneStageObservation(second.receipt,{...second,prepared:b});
  const saved=createSavedFreshPlaneEvidence({compilationBundle:bundle,stage,savedPcbSource:second.stagedSource,
    projectBindingIdentity:canonicalIdentity({fixture:"project"},"evleda.test.v1"),sourceScopeIdentity:canonicalIdentity({fixture:"scope"},"evleda.test.v1"),
    projectSettingsIdentity:contentIdentity("{}"),rulesIdentity:createFreshPlaneRules(bundle).identity});
  return {bundle,stage,saved,source:second.stagedSource,first,second};
}

describe("complete multi-plane fill witness mapping",()=>{
  it("uses each zone's own captured geometry even when the last mutation targeted the other plane",async()=>{
    const f=await fixture(), zones=resolveFreshPlaneSourceZones(f.bundle,parseFreshPcbReferenceGeometry(f.source).zones);
    expect(f.stage.targetZoneUuid).toBe(id(901));
    expect(f.stage.nativeFilledZones.map(z=>z.uuid)).toEqual([id(900),id(901)]);
    for(const [planeId,zone] of zones) {
      expect(()=>assertFreshPlaneDeclaredZoneSettings({compilationBundle:f.bundle,pcbSource:f.source,planeId,sourceZone:zone,
        nativeZone:f.stage.nativeFilledZones.find(z=>z.uuid===zone.uuid)!.raw})).not.toThrow();
    }
    const front=assessFreshPlaneDrillTopology({savedEvidence:f.saved,pcbSource:f.source,layer:"In1.Cu",zoneUuid:id(900)});
    const back=assessFreshPlaneDrillTopology({savedEvidence:f.saved,pcbSource:f.source,layer:"In2.Cu",zoneUuid:id(901)});
    expect(front.zoneUuid).toBe(id(900)); expect(back.zoneUuid).toBe(id(901));
    expect(front.cachedAreaTwiceNm2,front.issues.join(",")).not.toBeNull();
    expect(back.cachedAreaTwiceNm2,back.issues.join(",")).not.toBeNull();
    expect(BigInt(front.cachedAreaTwiceNm2!)).toBeGreaterThan(BigInt(back.cachedAreaTwiceNm2!));
    expect(front.bores).toHaveLength(back.bores.length);
  });
  it("does not substitute another zone for a missing or wrong-layer selector",async()=>{
    const f=await fixture();
    const missing=assessFreshPlaneDrillTopology({savedEvidence:f.saved,pcbSource:f.source,layer:"In1.Cu",zoneUuid:null});
    expect(missing.zoneUuid).toBeNull(); expect(missing.cachedAreaTwiceNm2).toBeNull(); expect(missing.status).toBe("unknown");
    const wrong=assessFreshPlaneDrillTopology({savedEvidence:f.saved,pcbSource:f.source,layer:"In1.Cu",zoneUuid:id(901)});
    expect(wrong.status).toBe("unknown"); expect(wrong.cachedAreaTwiceNm2).toBeNull();
  });
  it("rejects unbound/duplicate zone names and independently mismatched native settings",async()=>{
    const f=await fixture(), parsed=parseFreshPcbReferenceGeometry(f.source), mapped=resolveFreshPlaneSourceZones(f.bundle,parsed.zones);
    const front=mapped.get("GND_PLANE")!,back=mapped.get("BACK_GND")!;
    expect(()=>resolveFreshPlaneSourceZones(f.bundle,[front,{...back,uuid:front.uuid}])).toThrow("duplicated");
    expect(()=>resolveFreshPlaneSourceZones(f.bundle,[front,{...front,uuid:back.uuid}])).toThrow("duplicate declared");
    const raw=structuredClone(f.stage.nativeFilledZones.find(z=>z.uuid===back.uuid)!.raw) as any;
    raw.copper_settings.clearance.value_nm="1";
    expect(()=>assertFreshPlaneDeclaredZoneSettings({compilationBundle:f.bundle,pcbSource:f.source,planeId:"BACK_GND",sourceZone:back,nativeZone:raw})).toThrow("dimensions differ");
    expect(()=>assertFreshPlaneDeclaredZoneSettings({compilationBundle:f.bundle,pcbSource:f.source,planeId:"BACK_GND",sourceZone:back,
      nativeZone:f.stage.nativeFilledZones.find(z=>z.uuid===front.uuid)!.raw})).toThrow("UUID differs");
  });
});
