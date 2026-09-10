import { describe, expect, it } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { parseFreshPcbReferenceGeometry, parseFreshPcbSource } from "../../src/harness/fresh-kicad-parser.js";

const S = "11111111-1111-4111-8111-111111111111";
const Z = "22222222-2222-4222-8222-222222222222";
const board = (body: string, nets = "") => `(kicad_pcb (version 20260206) (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user)) ${nets} ${body})`;
const segment = (net = '"SIG"', extra = "") => `(segment (start -2 3.000001) (end 4e0 5) (width 0.250000) (layer "F.Cu") (net ${net}) (uuid "${S}") ${extra})`;
const zone = (fills: string, extra = "", net = '"GND"') => `(zone (net ${net}) (layer "B.Cu") (uuid "${Z}") (name "OWNED_GND_PLANE")
  (hatch edge 0.5) (connect_pads yes (clearance 0.3)) (min_thickness 0.25)
  (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5) (island_removal_mode 1))
  (polygon (pts (xy 2 2) (xy 28 2) (xy 28 18) (xy 2 18))) ${fills} ${extra})`;
const filled = (points = "(xy 2 2) (xy 28 2) (xy 28 18) (xy 2 18)", extra = "") => `(filled_polygon (layer "B.Cu") ${extra} (pts ${points}))`;

// Exact saved fill chains inspected from the closed native probe, not rerun by these tests:
// D:/EvlEDA-native-plane-probe-20260909/positive-v2/saved-after-refill.kicad_pcb
// SHA256 b80cd79dcb08380c0ee504b085a97da5af8963db1f6f210e37d17c04a70ac809.
const nativePositiveChain = `(xy 27.943039 2.019685) (xy 27.988794 2.072489) (xy 28 2.124) (xy 28 17.876) (xy 27.980315 17.943039)
  (xy 27.927511 17.988794) (xy 27.876 18) (xy 2.124 18) (xy 2.056961 17.980315) (xy 2.011206 17.927511)
  (xy 2 17.876) (xy 2 12) (xy 14 12) (xy 16 12) (xy 16 8) (xy 14 8) (xy 14 12) (xy 2 12) (xy 2 2.124)
  (xy 2.019685 2.056961) (xy 2.072489 2.011206) (xy 2.124 2) (xy 27.876 2)`;
// Negative-v2 saved source SHA256 8ed017cdbbe3473183f89308cc8ca65a07a021cb248231d04ed2ff673bf3f543.
const nativeNegativeLeft = `(xy 13.943039 2.019685) (xy 13.988794 2.072489) (xy 14 2.124) (xy 14 17.876) (xy 13.980315 17.943039)
  (xy 13.927511 17.988794) (xy 13.876 18) (xy 2.124 18) (xy 2.056961 17.980315) (xy 2.011206 17.927511)
  (xy 2 17.876) (xy 2 12) (xy 8 12) (xy 10 12) (xy 10 8) (xy 8 8) (xy 8 12) (xy 2 12) (xy 2 2.124)
  (xy 2.019685 2.056961) (xy 2.072489 2.011206) (xy 2.124 2) (xy 13.876 2)`;
const nativeNegativeRight = `(xy 27.943039 2.019685) (xy 27.988794 2.072489) (xy 28 2.124) (xy 28 17.876) (xy 27.980315 17.943039)
  (xy 27.927511 17.988794) (xy 27.876 18) (xy 16.124 18) (xy 16.056961 17.980315) (xy 16.011206 17.927511)
  (xy 16 17.876) (xy 16 2.124) (xy 16.019685 2.056961) (xy 16.072489 2.011206) (xy 16.124 2) (xy 27.876 2)`;

describe("saved-board reference source geometry", () => {
  it("exports exact integer-nm straight segments with source identities and no connectivity/freshness claim", () => {
    const source = board(segment()); const result = parseFreshPcbReferenceGeometry(source);
    expect(result.sourceIdentity).toEqual(contentIdentity(Buffer.from(source)));
    expect(result.status).toBe("observed");
    expect(result.segments).toEqual([expect.objectContaining({ uuid: S, netName: "SIG", layer: "F.Cu", startNm: { x: -2000000, y: 3000001 }, endNm: { x: 4000000, y: 5000000 }, widthNm: 250000 })]);
    expect(result.segments[0]!.sourceIdentity).toEqual(contentIdentity(Buffer.from(segment())));
    expect(result.coverage).toEqual({ coordinateUnits: "nm", filledContours: "saved-fractured-contour-groups", fillCacheFreshness: "unverified", dcConnectivity: "not_evaluated", fullBoardGeometry: false });
    expect(result).not.toHaveProperty("passed");
    expect(Object.isFrozen(result.segments[0]!.startNm)).toBe(true);
  });

  it("preserves the native positive fractured contour and repeated bridge points as one group", () => {
    const result = parseFreshPcbReferenceGeometry(board(zone(filled(nativePositiveChain))));
    const z = result.zones[0]!, group = z.filledPolygons[0]!, chain = group.contourGroup[0]!;
    expect(z).toMatchObject({ status: "supported", uuid: Z, netName: "GND", layers: ["B.Cu"], kind: "copper", filledCachePresent: true });
    expect(group).toMatchObject({ status: "supported", layer: "B.Cu", islandFlag: { status: "omitted", value: null } });
    expect(z.filledPolygons).toHaveLength(1); expect(group.contourGroup).toHaveLength(1);
    expect(chain.pointsNm).toHaveLength(23);
    expect(chain.pointsNm!.filter(point => point.x === 14000000 && point.y === 12000000)).toHaveLength(2);
    expect(chain.pointsNm!.filter(point => point.x === 2000000 && point.y === 12000000)).toHaveLength(2);
    expect(group).not.toHaveProperty("holes"); expect(chain).not.toHaveProperty("holes");
    expect(z.settings.find(setting => setting.name === "connect_pads")!.children[0]).toMatchObject({ name: "clearance", quantityNm: 300000, source: "(clearance 0.3)" });
  });

  it("keeps both native negative filled polygons separate without inferring source DC connectivity", () => {
    const result = parseFreshPcbReferenceGeometry(board(zone(filled(nativeNegativeLeft) + filled(nativeNegativeRight))));
    const groups = result.zones[0]!.filledPolygons;
    expect(groups.map(group => group.contourGroup[0]!.pointsNm!.length)).toEqual([23, 16]);
    expect(Math.max(...groups[0]!.contourGroup[0]!.pointsNm!.map(point => point.x))).toBe(14000000);
    expect(Math.min(...groups[1]!.contourGroup[0]!.pointsNm!.map(point => point.x))).toBe(16000000);
    expect(result.coverage.dcConnectivity).toBe("not_evaluated");
  });

  it.each([{ flag: "(island)", value: true }, { flag: "(island yes)", value: true }, { flag: "(island no)", value: false }])("retains explicit island syntax $flag", ({ flag, value }) => {
    expect(parseFreshPcbReferenceGeometry(board(zone(filled(undefined, flag)))).zones[0]!.filledPolygons[0]!.islandFlag).toEqual({ status: "explicit", value, source: flag });
  });

  it("distinguishes fill intent from cache presence and keepouts/placement areas from copper", () => {
    const empty = parseFreshPcbReferenceGeometry(board(zone(""))).zones[0]!;
    expect(empty.filledCachePresent).toBe(false); expect(empty.settings.some(setting => setting.name === "fill")).toBe(true);
    const legacy = parseFreshPcbReferenceGeometry(board(zone("", "(fill_segments (pts (xy 2 2) (xy 3 2)))"))).zones[0]!;
    expect(legacy).toMatchObject({ status: "unsupported", filledCachePresent: true });
    expect(legacy.unknownForms).toContain("(fill_segments (pts (xy 2 2) (xy 3 2)))");
    const keepout = parseFreshPcbReferenceGeometry(board(zone("", "(keepout (tracks not_allowed) (vias allowed) (copperpour not_allowed))", '""'))).zones[0]!;
    expect(keepout).toMatchObject({ kind: "rule_area", netName: null, status: "supported" });
    expect(parseFreshPcbReferenceGeometry(board(zone("", '(placement (enabled yes) (group "G"))'))).zones[0]!.kind).toBe("rule_area");
  });

  it("keeps unsupported arcs, vias, unknown segment fields and unrelated source observations", () => {
    const source = board(`${segment()} (arc (uuid "33333333-3333-4333-8333-333333333333")) (via (uuid "44444444-4444-4444-8444-444444444444"))
      (future_copper (layer "B.Cu")) (footprint "X" (layer "F.Cu"))`);
    const result = parseFreshPcbReferenceGeometry(source);
    expect(result.status).toBe("unsupported"); expect(result.segments).toHaveLength(1);
    expect(result.unsupportedRouteItems.map(item => item.kind)).toEqual(["arc", "via"]);
    expect(result.otherObservations.map(item => item.kind)).toEqual(["future_copper", "footprint"]);
    const unknown = parseFreshPcbReferenceGeometry(board(segment('"SIG"', "(future_width 7)")));
    expect(unknown.segments).toEqual([]); expect(unknown.unsupportedRouteItems[0]!.source).toContain("future_width");
  });

  it.each(["0.0000001", "2147.483638", "NaN", '"1"'])("rejects unrepresentable native nanometre quantity %s without rounding", value => {
    const invalid = segment().replace("-2 3.000001", `${value} 3.000001`);
    const result = parseFreshPcbReferenceGeometry(board(invalid));
    expect(result.segments).toEqual([]); expect(result.unsupportedRouteItems).toHaveLength(1);
    const fillResult = parseFreshPcbReferenceGeometry(board(zone(filled(`(xy ${value} 2) (xy 4 2) (xy 4 5)`))));
    expect(fillResult.zones[0]!.filledPolygons[0]!.contourGroup[0]).toMatchObject({ status: "unsupported", pointsNm: null });
  });

  it("preserves unknown fill fields, extra pts groups and malformed flags as unsupported rather than dropping them", () => {
    const malformed = `(filled_polygon (layer "B.Cu") (island maybe) (future_hole (pts (xy 3 3)))
      (pts (xy 2 2) (xy 4 2) (xy 4 4)) (pts (xy 5 5) (xy 7 5) (xy 7 7)))`;
    const z = parseFreshPcbReferenceGeometry(board(zone(malformed, "(future_zone_mode 1)"))).zones[0]!;
    expect(z.status).toBe("unsupported"); expect(z.filledPolygons[0]!.contourGroup).toHaveLength(2);
    expect(z.filledPolygons[0]!.unknownForms).toEqual(["(future_hole (pts (xy 3 3)))"]);
    expect(z.unknownForms).toEqual(["(future_zone_mode 1)"]);
    expect(z.filledPolygons[0]!.islandFlag.status).toBe("unsupported");
    expect(z.settings.some(setting => setting.name === "future_zone_mode")).toBe(true);
  });

  it("does not infer a filled layer from a zone or resolve wildcard selectors silently", () => {
    const absent = filled().replace('(layer "B.Cu")', "");
    const result = parseFreshPcbReferenceGeometry(board(zone(absent)));
    expect(result.zones[0]!.filledPolygons[0]).toMatchObject({ status: "unsupported", layer: null });
    expect(parseFreshPcbReferenceGeometry(board(zone(filled()).replace('(layer "B.Cu")', '(layers "*.Cu")'))).zones[0]!.status).toBe("unsupported");
  });

  it("reuses legacy net identity semantics and preserves conflicting/duplicate net observations", () => {
    const source = board(segment("7").replace("4e0", "4"), '(net 7 "SIG")');
    expect(parseFreshPcbReferenceGeometry(source).segments[0]!.netName).toBe("SIG");
    expect(parseFreshPcbSource(source).segments[0]!.netName).toBe("SIG");
    expect(parseFreshPcbReferenceGeometry(board(segment('"7"'))).segments[0]!.netName).toBe("7");
    expect(parseFreshPcbReferenceGeometry(board(zone(filled(), '(net_name "WRONG")', "1"), '(net 1 "GND")')).zones[0]!.status).toBe("unsupported");
    const duplicated = parseFreshPcbReferenceGeometry(board(segment() + segment()));
    expect(duplicated.segments).toEqual([]); expect(duplicated.unsupportedRouteItems).toHaveLength(2);
    expect(duplicated.issues.some(issue => issue.includes("Repeated UUID"))).toBe(true);
  });

  it("retains nested local-frame copper separately and rejects malformed whole source", () => {
    const result = parseFreshPcbReferenceGeometry(board(`(footprint "local" ${zone(filled())})`));
    expect(result.zones).toEqual([]); expect(result.status).toBe("unsupported");
    expect(result.otherObservations.some(item => item.kind === "zone" && item.reason.includes("local coordinate"))).toBe(true);
    expect(() => parseFreshPcbReferenceGeometry("(kicad_pcb")).toThrow();
  });
});
