import { describe, expect, it } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { auditFreshHeaderServiceRegions, auditFreshStoredFillHeaderBounds, headerServiceRoundRectRadiusNm, type FreshHeaderServicePolicy } from "../../src/harness/fresh-header-service-regions.js";

// Pure saved-source fixtures, with no native observations or clearance claims.
const id = (n: number) => `88888888-8888-4888-8888-${String(n).padStart(12,"0")}`;
const fp = (ref: string, n: number, x: number, y: number, extra = "", type = "thru_hole", shape = "circle", size = "1.7 1.7", drill = "1") =>
  `(footprint "Test:Header" (layer "F.Cu") (at ${x} ${y}) (uuid "${id(n)}") (property "Reference" "${ref}")
    (pad "${type === "np_thru_hole" ? "" : "1"}" ${type} ${shape} (at 0 0) (size ${size}) ${drill ? `(drill ${drill})` : ""} (layers "*.Cu" "*.Mask") ${type === "np_thru_hole" ? "" : '(net "GND")'} (uuid "${id(n+1)}")) ${extra})`;
const track = (n: number, start = "2 5", end = "3.5 5", width = "0.2", net = "GND", layer = "F.Cu", extra = "") =>
  `(segment (start ${start}) (end ${end}) (width ${width}) (layer "${layer}") (net "${net}") (uuid "${id(n)}") ${extra})`;
const via = (x = "3.2", diameter = "0.6", net = "GND") =>
  `(via (at ${x} 10) (size ${diameter}) (drill 0.3) (layers "F.Cu" "B.Cu") (net "${net}") (uuid "${id(40)}"))`;
const zone = (points: string | null, extra = "") => `(zone (net "GND") (layer "B.Cu") (uuid "${id(50)}") (hatch edge 0.5)
  (connect_pads (clearance 0.15)) (min_thickness 0.2) (fill yes (thermal_gap 0.3) (thermal_bridge_width 0.3))
  (polygon (pts (xy 3 1) (xy 17 1) (xy 17 39) (xy 3 39)))
  ${points === null ? "" : `(filled_polygon (layer "B.Cu") (pts ${points}))`} ${extra})`;
const board = (copper = "", extras = "") => `(kicad_pcb (version 20260206) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
  (gr_rect (start 0 0) (end 20 40) (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts"))
  ${fp("J2",1,2,5)} ${fp("J3",3,18,5)} ${copper} ${extras})`;
const policy = (): FreshHeaderServicePolicy => ({ board: {widthMm:20,heightMm:40}, left:{reference:"J2",innerXmm:3},right:{reference:"J3",innerXmm:17},
  headerPads:[{reference:"J2",pin:"1",uuid:id(2)},{reference:"J3",pin:"1",uuid:id(4)}],leads:[] });
const lead = (side: "left" | "right" = "left", layer: "F.Cu" | "B.Cu" = "F.Cu") => ({padUuid:id(side === "left" ? 2 : 4),net:"GND",layer,widthMm:.2,
  start:{xMm:side === "left" ? 2 : 18,yMm:5},end:{xMm:side === "left" ? 3.5 : 16.5,yMm:5}});
const audit = (source: string, p = policy()) => auditFreshHeaderServiceRegions({pcbSource:source,expectedSourceIdentity:contentIdentity(source),policy:p});
const codes = (r: ReturnType<typeof audit>) => [...r.violations,...r.unknown].map(f => f.code);

describe("source-only header service strip audit", () => {
  it("can prove conservative fill containment without claiming polygon validity", () => {
    const source = board(zone('(xy 4 1) (xy 16 39) (xy 16 1) (xy 4 39)'));
    expect(audit(source).status).toBe("unknown"); // Existing topology policy is unchanged.
    const bounds = auditFreshStoredFillHeaderBounds({ pcbSource: source, expectedSourceIdentity: contentIdentity(source), policy: policy() });
    expect(bounds.status).toBe("contained"); expect(bounds.topologyVerified).toBe(false); expect(bounds.nativeAuthority).toBe(false);
    expect(bounds.zones[0]).toMatchObject({ minXnm: 4000000, maxXnm: 16000000 });
    const old = source.replace("20260206", "20240101");
    expect(auditFreshStoredFillHeaderBounds({ pcbSource: old, expectedSourceIdentity: contentIdentity(old), policy: policy() }).status).toBe("unknown");
  });
  it("keeps outlying bounds, arcs and absent fill distinct", () => {
    for (const [points, expected] of [['(xy 2 1) (xy 17 1) (xy 17 39)', 'bounds-cross-service-region'], ['(xy 3 1) (arc (start 3 2) (mid 3 3) (end 4 3)) (xy 17 39)', 'unknown'], [null, 'unknown']] as const) {
      const source = board(zone(points)); expect(auditFreshStoredFillHeaderBounds({ pcbSource: source, expectedSourceIdentity: contentIdentity(source), policy: policy() }).status).toBe(expected);
    }
  });
  it("bounds a large complete contour within the existing vertex limit", () => {
    const points = Array.from({ length: 4000 }, (_, i) => `(xy ${i % 2 ? 16 : 4} ${1 + i % 38})`).join(" "), source = board(zone(points));
    const result = auditFreshStoredFillHeaderBounds({ pcbSource: source, expectedSourceIdentity: contentIdentity(source), policy: policy() });
    expect(result.status).toBe("contained"); expect(result.vertices).toBe(4000); expect(result.topologyVerified).toBe(false);
    expect(auditFreshStoredFillHeaderBounds({ pcbSource: source, expectedSourceIdentity: contentIdentity(source + " "), policy: policy() }).status).toBe("unknown");
  });
  it.each([
    [1200000,"0.208333",250000], [1000001,"0.25",250000], [1000002,"0.25",250001], [1000003,"0.25",250001],
    [1000001,"0.499999",499999], [1000000,"0",0], [1000000,"0.5",500000],
  ] as const)("matches the pinned read-only KiCad PAD radius oracle for %i nm × %s", (minimum,ratio,expected) => {
    // Independent native10.0.3 observations retained under
    // destination-verification/header-service-source-compatibility-02/radius-oracle.json.
    expect(headerServiceRoundRectRadiusNm(minimum,ratio)).toBe(expected);
  });
  it.each(["-0.1","0.500001","NaN","-0","0.208333000001"])("does not broaden radius source admission for %s", ratio => {
    expect(()=>headerServiceRoundRectRadiusNm(1200000,ratio)).toThrow();
  });
  it("admits the exact saved benign footprint scalar and fractional-product Y1 roundrect without changing bounds", () => {
    const extra=fp("Y1",20,5,12,'(duplicate_pad_numbers_are_jumpers no)',"smd","roundrect","1.4 1.2","")
      .replace('(size 1.4 1.2)','(size 1.4 1.2) (roundrect_rratio 0.208333)');
    const result=audit(board("",extra));expect(result.status).toBe("clear");
    expect(result.roundrectRadiusModel).toContain("KiCad-10.0.3");
    expect(codes(audit(board("",extra.replace('(at 5 12)','(at 3.5 12)'))))).toContain("PAD_IN_SERVICE_STRIP");
    expect(audit(board("",extra.replace('(size 1.4 1.2)','(size 1.4000001 1.2)'))).status).toBe("unknown");
    // Radius rounding is defined; the odd-size native effective-shape core is
    // separately unqualified and must never become a negative-core exemption.
    expect(headerServiceRoundRectRadiusNm(1000001,"0.5")).toBe(500001);
    const odd=extra.replace('(size 1.4 1.2)','(size 1.000001 1.2)').replace('0.208333','0.5');
    expect(audit(board("",odd)).status).toBe("unknown");
    const nearCircle=extra.replace('(size 1.4 1.2)','(size 1 1)').replace('0.208333','0.499999');
    expect(audit(board("",nearCircle)).status).toBe("unknown");
    expect(audit(board("",nearCircle.replace('0.499999','0.5'))).status).toBe("clear");
  });
  it.each(['yes','"no"','','no extra','no (unknown yes)'])("keeps unsupported duplicate-pad-jumper setting %s unknown", value => {
    expect(audit(board("",fp("R1",20,10,12,`(duplicate_pad_numbers_are_jumpers ${value})`))).status).toBe("unknown");
  });
  it("replays the candidate60 forty exact header entries, including RUN's checked offset, in a header-only source fixture", () => {
    // Frozen candidate60 local-entry-proposal.json SHA256
    // 0fec4576e5165e0600e5fe4e649c8f0cd9e62d46d9c156cd5f0a5f34662f274c;
    // source-physical-model.json fd14f701ae5757dcb17968254155f19174e439b1731b6a7f946dfcab0e5f302c.
    // This synthetic projection includes ONLY its header pads/entries; it is
    // neither a native saved candidate nor a complete-board clearance replay.
    const rows=[
      ["GPIO0","GPIO1","GND","GPIO2","GPIO3","GPIO4","GPIO5","GND","GPIO6","GPIO7","GPIO8","GPIO9","GND","GPIO10","GPIO11","GPIO12","GPIO13","GND","GPIO14","GPIO15"],
      ["GPIO16","GPIO17","GND","GPIO18","GPIO19","GPIO20","GPIO21","GND","GPIO22","RUN","GPIO26","GPIO27","GND","GPIO28","ADC_VREF","3V3","3V3_EN","GND","VSYS","VBUS"],
    ];
    const p:FreshHeaderServicePolicy={board:{widthMm:22,heightMm:60},left:{reference:"J2",innerXmm:3.46},right:{reference:"J3",innerXmm:18.54},headerPads:[],leads:[]};
    const pads:string[]=[],tracks:string[]=[];
    rows.forEach((nets,row)=>{
      const reference=row===0?"J2":"J3",x=row===0?2.11:19.89;
      const parts=nets.map((net,index)=>{
        const y=Number((row===0?5.87+index*2.54:54.13-index*2.54).toFixed(2)),pin=String(index+1),padUuid=id(1000+row*20+index);
        const w=["GND","3V3","VSYS","VBUS"].includes(net)?.3:.2;
        const layer: "F.Cu"|"B.Cu"=net==="GND"||net==="GPIO22"?"B.Cu":"F.Cu";
        const start=net==="RUN"?{xMm:19.34,yMm:31.57}:{xMm:x,yMm:y};
        const end=net==="RUN"?{xMm:17.7,yMm:31.57}:{xMm:row===0?(w===.3?3.61:3.56):(w===.3?18.39:18.44),yMm:y};
        p.headerPads.push({reference,pin,uuid:padUuid});p.leads.push({padUuid,net,layer,widthMm:w,start,end});
        tracks.push(track(2000+row*20+index,`${start.xMm} ${start.yMm}`,`${end.xMm} ${end.yMm}`,String(w),net,layer));
        return `(pad "${pin}" thru_hole ${index===0?"rect":"circle"} (at ${x} ${y} ${row===0?0:180}) (size 1.7 1.7) (drill 1) (layers "*.Cu" "*.Mask") (net "${net}") (uuid "${padUuid}"))`;
      });
      pads.push(`(footprint "Connector:Header20" (layer "F.Cu") (at 0 0) (uuid "${id(900+row)}") (property "Reference" "${reference}") ${parts.join(" ")})`);
    });
    const source=`(kicad_pcb (version 20260206) (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
      (gr_rect (start 0 0) (end 22 60) (layer "Edge.Cuts")) ${pads.join(" ")} ${tracks.join(" ")})`;
    const result=audit(source,p);expect(result).toMatchObject({status:"clear",complete:true,counts:{pads:40,tracks:40}});
    expect(result.permittedTrackIds).toHaveLength(40);expect(p.leads.filter(l=>l.layer==="B.Cu")).toHaveLength(9);
  });
  it("binds both inputs, retains original lands, and accepts explicit inward leads on both faces", () => {
    const p=policy();p.leads=[lead(),lead("right","B.Cu")];
    const source=board(track(10)+track(11,"18 5","16.5 5","0.2","GND","B.Cu")+zone('(xy 3 1) (xy 17 1) (xy 17 39) (xy 3 39)'));
    const result=audit(source,p);
    expect(result).toMatchObject({status:"clear",complete:true,nativeAuthority:false,fillFreshness:"unverified",sourceIdentity:contentIdentity(source),permittedTrackIds:[id(10),id(11)]});
    expect(result.policyIdentity.digest).not.toBe(audit(source,{...p,left:{...p.left,innerXmm:3.1}}).policyIdentity.digest);
    expect(Object.isFrozen(result)).toBe(true);expect(Object.isFrozen(result.violations)).toBe(true);
    expect(result.notAssessed).toContain("clearance");expect(result.notAssessed).toContain("soldering-or-rework-safety");
  });
  it("accepts physically identical reversed source segment orientation without reversing permission direction", () => {
    const p=policy();p.leads=[lead()];
    expect(audit(board(track(10)),p).status).toBe("clear");
    expect(audit(board(track(10,"3.5 5","2 5")),p).status).toBe("clear");
    p.leads[0]={...lead(),start:lead().end,end:lead().start};
    expect(codes(audit(board(track(10)),p))).toContain("INVALID_OWN_LEAD_PERMISSION");
  });
  it.each(["GND","GPIO0"])("never exempts unrelated %s tracks or vias by net membership", net => {
    const p=policy();p.leads=[lead()];
    const result=audit(board(track(10)+track(11,"2 8","3.5 8","0.2",net)+via("2.5","0.6",net)),p);
    expect(result.status).toBe("violations");expect(result.permittedTrackIds).toEqual([id(10)]);
    expect(result.violations.map(f=>f.id)).toEqual(expect.arrayContaining([id(11),id(40)]));
  });
  it("tests full track width exactly, including a one-nanometre diameter change across the boundary", () => {
    expect(audit(board(track(10,"3.1 8","3.1 10","0.2"))).status).toBe("clear");
    expect(codes(audit(board(track(10,"3.1 8","3.1 10","0.200001"))))).toContain("TRACK_IN_SERVICE_STRIP");
    expect(codes(audit(board(track(10,"3.01 8","5 10","0.2"))))).toContain("TRACK_IN_SERVICE_STRIP");
  });
  it("checks annulus area even when the via centre is in the interior", () => {
    expect(codes(audit(board(via("3.2"))))).toContain("VIA_IN_SERVICE_STRIP");
    expect(audit(board(via("3.3"))).status).toBe("clear");
  });
  it("checks nonheader pad copper and only excludes characterized annulus-free NPTH", () => {
    expect(codes(audit(board("",fp("R1",20,3.5,12))))).toContain("PAD_IN_SERVICE_STRIP");
    expect(audit(board("",fp("H1",20,2,12,"","np_thru_hole","circle","2 2","2"))).status).toBe("clear");
    expect(codes(audit(board("",fp("H1",20,2,12,"","np_thru_hole","circle","2.1 2.1","2"))))).toContain("UNSUPPORTED_PAD");
  });
  it("keeps malformed/missing layers unknown while retaining anonymous paste apertures as noncopper", () => {
    const extra=fp("R1",20,2,12,"","smd","rect","1 1","");
    for(const replacement of ["", "(layers)", "(layers F.Cu)"])
      expect(audit(board("",extra.replace('(layers "*.Cu" "*.Mask")',replacement))).status).toBe("unknown");
    const paste=extra.replace('(pad "1" smd','(pad "" smd').replace('(layers "*.Cu" "*.Mask")','(layers "F.Paste")').replace('(net "GND")','');
    expect(audit(board("",paste)).status).toBe("clear");
  });
  it.each(["wrong-net","wrong-layer","wrong-width","wrong-pad"])("requires exact own lead authority: %s", kind => {
    const p=policy();p.leads=[lead()];
    if(kind==="wrong-net")p.leads[0]!.net="GPIO0";
    if(kind==="wrong-layer")p.leads[0]!.layer="B.Cu";
    if(kind==="wrong-width")p.leads[0]!.widthMm=.3;
    if(kind==="wrong-pad")p.leads[0]!.padUuid=id(4);
    const result=audit(board(track(10)),p);expect(result.status).not.toBe("clear");expect(result.permittedTrackIds).toEqual([]);
  });
  it("proves full-width contact rather than accepting an anchor inside the land or its drill", () => {
    const p=policy();p.leads=[{...lead(),start:{xMm:2,yMm:5.82},end:{xMm:3.5,yMm:5.82}}];
    const r=audit(board(track(10,"2 5.82","3.5 5.82")),p);
    expect(codes(r)).toContain("INVALID_OWN_LEAD_PERMISSION");expect(r.permittedTrackIds).toEqual([]);
    p.leads=[{...lead(),start:{xMm:2,yMm:5.2},end:{xMm:3.5,yMm:5.2}}];
    expect(audit(board(track(10,"2 5.2","3.5 5.2")),p).status).toBe("clear");
  });
  it("does not let an exact own-pad permission exempt copper in the opposite strip", () => {
    const p=policy();p.leads=[{...lead(),end:{xMm:18,yMm:5}}];
    const result=audit(board(track(10,"2 5","18 5")),p);
    expect(codes(result)).toContain("INVALID_OWN_LEAD_PERMISSION");expect(codes(result)).toContain("TRACK_IN_SERVICE_STRIP");
  });
  it("does not exempt the opposite strip merely because an oversized land is a declared header pad", () => {
    const p=policy();p.left.innerXmm=9;p.right.innerXmm=11;
    const source=board().replace('(at 2 5)', '(at 8 5)').replace('thru_hole circle (at 0 0) (size 1.7 1.7)', 'thru_hole rect (at 0 0) (size 8 1.7)');
    const result=audit(source,p);expect(codes(result)).toContain("HEADER_PAD_OVERLAPS_OPPOSITE_STRIP");expect(codes(result)).toContain("PAD_IN_SERVICE_STRIP");
  });
  it("handles exact cardinal pad positions and absolute pad angles without adding root rotation twice", () => {
    const p=policy();p.leads=[lead()];
    const source=board(track(10)).replace('(at 2 5)', '(at 2 6 90)').replace('(at 0 0) (size 1.7 1.7)', '(at 1 0 90) (size 1.7 1.7)');
    expect(audit(source,p).status).toBe("clear");
  });
  it("rejects pad declarations that do not resolve the exact saved terminal", () => {
    const p=policy();p.headerPads[0]!.pin="2";
    expect(codes(audit(board(),p))).toContain("HEADER_PAD_MISMATCH");
  });
  it("cannot borrow a declared header UUID for a second pad or footprint", () => {
    const duplicate=fp("R1",20,2,12).replace(id(21),id(2));
    expect(audit(board("",duplicate)).status).toBe("unknown");
    expect(audit(board("",fp("R1",1,2,12))).status).toBe("unknown");
  });
  it("does not count the drilled hole as full-width contact when the annulus is too thin", () => {
    const p=policy();p.leads=[lead()];
    const source=board(track(10)).replace('(drill 1)', '(drill 1.69)');
    expect(codes(audit(source,p))).toContain("INVALID_OWN_LEAD_PERMISSION");
  });
  it("leaves absent or unsupported stored fill explicitly unknown", () => {
    expect(codes(audit(board(zone(null))))).toContain("UNSUPPORTED_OR_UNFILLED_ZONE");
    const r=audit(board(zone('(xy 2 1) (xy 17 1) (xy 17 39) (xy 2 39)')));
    expect(r.status).toBe("violations");expect(codes(r)).toContain("FILL_IN_SERVICE_STRIP");
    expect(audit(board(zone('(xy 3 1) (arc (start 3 2) (mid 3 3) (end 4 3)) (xy 17 39)'))).status).toBe("unknown");
    expect(audit(board(zone(null,'(keepout (tracks not_allowed) (vias not_allowed) (copperpour not_allowed))'))).status).toBe("unknown");
    expect(audit(board(zone('(xy 4 1) (xy 16 39) (xy 16 1) (xy 4 39)'))).status).toBe("unknown");
    const cached=board(zone('(xy 3 1) (xy 17 1) (xy 17 39) (xy 3 39)'));
    for(const state of ['no','maybe','"yes"','']) expect(audit(cached.replace('(fill yes ',`(fill ${state} `)).status).toBe("unknown");
  });
  it.each(["arc","copper-graphic","pad-geometry","sub-nm","route-modifier"])("does not silently pass unsupported %s", kind => {
    let source=board();
    if(kind==="arc")source=board(`(arc (start 5 5) (mid 6 6) (end 7 5) (width 0.2) (layer "F.Cu") (net "GND") (uuid "${id(10)}"))`);
    if(kind==="copper-graphic")source=board('(gr_line (start 4 4) (end 5 5) (stroke (width 0.2) (type default)) (layer "F.Cu"))');
    if(kind==="pad-geometry")source=source.replace('thru_hole circle','thru_hole custom');
    if(kind==="sub-nm")source=source.replace('(at 2 5)','(at 2.00000000000000001 5)');
    if(kind==="route-modifier")source=board(track(10,"5 5","6 5","0.2","GND","F.Cu","(custom_modifier yes)"));
    expect(audit(source).complete).toBe(false);expect(audit(source).status).not.toBe("clear");
  });
  it("requires exact source identity, exact rectangle and bounded caller policy", () => {
    const source=board();
    expect(auditFreshHeaderServiceRegions({pcbSource:source,expectedSourceIdentity:contentIdentity(source+'\n'),policy:policy()}).status).toBe("unknown");
    expect(audit(source.replace('(end 20 40)','(end 20 41)')).status).toBe("unknown");
    expect(audit(source.replace('(end 20 40)','(end 20 40) (unknown_outline_geometry 1)')).status).toBe("unknown");
    expect(audit(board("",fp("R1",20,10,12,'(fp_line (start 0 0) (end 2 0) (layer "Edge.Cuts"))'))).status).toBe("unknown");
    const p=policy();p.left.innerXmm=18;expect(()=>audit(source,p)).toThrow();
    expect(()=>audit('x'.repeat(2*1024*1024+1))).toThrow(/bound/);
  });
});
