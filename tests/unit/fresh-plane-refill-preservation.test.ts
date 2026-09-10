import { describe, expect, it } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { compareFreshPlaneRefillPreservation } from "../../src/harness/fresh-kicad-parser.js";

const Z = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const Z2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const S = "11111111-1111-4111-8111-111111111111";
const P = "33333333-3333-4333-8333-333333333333";
const V = "44444444-4444-4444-8444-444444444444";
const points = "(xy 1 1) (xy 9 1) (xy 9 9) (xy 1 9)";
const changedPoints = "(xy 1 1) (xy 8 1) (xy 8 9) (xy 1 9)";
const filled = (chain = points, island = "") => `(filled_polygon (layer "B.Cu") ${island} (pts ${chain}))`;
const zone = (cache: string, uuid = Z, extra = "") => `(zone (net "GND") (layer "B.Cu") (uuid "${uuid}")
 (name "HOST_PLANE") (hatch edge 0.5) (connect_pads yes (clearance 0.3)) (min_thickness 0.25)
 (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5) (island_removal_mode 1))
 (polygon (pts ${points})) ${cache} ${extra})`;
const segment = `(segment (start 2 3) (end 8 3) (width 0.25) (layer "F.Cu") (net "SIG") (uuid "${S}"))`;
const via = `(via (at 3 3) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "SIG") (uuid "${V}"))`;
const footprint = `(footprint "Test:FP" (layer "F.Cu")
 (property "Reference" "R1" (at 0 0 -90) (layer "F.SilkS"))
 (property "Value" "literal filled_polygon text")
 (pad "1" smd rect (at 0 0 -90) (size 1 1) (layers "F.Cu") (net "SIG") (uuid "${P}"))
 (model "model.step" (offset (xyz 0 0 0))))`;
const board = (zones: string, extra = "") => `(kicad_pcb
 (version 20260206) (generator "pcbnew") (generator_version "10.0")
 (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
 (setup (pad_to_mask_clearance 0)) ${segment} ${via} ${footprint} ${zones} ${extra}
)\n`;
const compare = (beforePcbSource: string, afterPcbSource: string, zoneUuids: readonly string[] = [Z]) =>
  compareFreshPlaneRefillPreservation({ beforePcbSource, afterPcbSource, zoneUuids });

describe("narrow native plane-refill source preservation", () => {
  it("permits changed direct filled_polygon caches while preserving complete raw source identities", () => {
    const before = board(zone(filled())).replaceAll("\n", "\r\n");
    const after = board(zone(filled(changedPoints)));
    const result = compare(before, after);
    expect(result).toMatchObject({ schemaVersion: "evleda.fresh-plane-refill-preservation.v1", equal: true,
      beforeIdentity: contentIdentity(before), afterIdentity: contentIdentity(after), zoneUuids: [Z], changedZoneCount: 1,
      beforeFilledPolygonCount: 1, afterFilledPolygonCount: 1,
      fillCacheFreshness: "unverified", dcConnectivity: "not_evaluated", acceptanceEvaluated: false });
    expect(result.zones).toEqual([{ uuid: Z, beforeFilledState: "yes", afterFilledState: "yes", filledStateTransition: "yes-to-yes",
      beforeFilledPolygonCount: 1, afterFilledPolygonCount: 1,
      beforePointCount: 4, afterPointCount: 4, cacheChanged: true }]);
    expect(result.beforeIdentity.digest).not.toBe(result.afterIdentity.digest);
    expect(Object.isFrozen(result.zones[0])).toBe(true);
    expect(result).not.toHaveProperty("passed");
    expect(result).not.toHaveProperty("normalizedSource");
  });

  it("permits cache creation/removal and multiple distinct polygons without creating or removing zones", () => {
    const empty = board(zone(""));
    const populated = board(zone(filled() + filled("(xy 11 1) (xy 19 1) (xy 19 9) (xy 11 9)", "(island no)")));
    expect(compare(empty, populated)).toMatchObject({ equal: true, beforeFilledPolygonCount: 0, afterFilledPolygonCount: 2, changedZoneCount: 1 });
    expect(compare(populated, empty)).toMatchObject({ equal: true, beforeFilledPolygonCount: 2, afterFilledPolygonCount: 0, changedZoneCount: 1 });
    expect(compare(empty, empty)).toMatchObject({ equal: true, beforeFilledPolygonCount: 0, afterFilledPolygonCount: 0, changedZoneCount: 0, fillCacheFreshness: "unverified" });
  });

  it.each(["omitted", "no"] as const)("admits initial %s-to-yes state with unchanged fill settings and reports the transition", state => {
    const before = board(zone("")).replace("(fill yes ", state === "omitted" ? "(fill " : "(fill no ");
    const after = board(zone(filled(changedPoints)));
    const result = compare(before, after);
    expect(result).toMatchObject({ equal: true, changedZoneCount: 1, changedFilledStateZoneCount: 1,
      beforeIdentity: contentIdentity(before), afterIdentity: contentIdentity(after),
      fillCacheFreshness: "unverified", dcConnectivity: "not_evaluated", acceptanceEvaluated: false });
    expect(result.zones[0]).toMatchObject({ beforeFilledState: state, afterFilledState: "yes",
      filledStateTransition: `${state}-to-yes`, beforeFilledPolygonCount: 0, afterFilledPolygonCount: 1, cacheChanged: true });
    expect(compare(before, after.replace("(thermal_gap 0.5)", "(thermal_gap 0.6)")).equal).toBe(false);
  });

  it("reports a derived state-only transition without pretending unchanged polygons prove freshness", () => {
    const after = board(zone(filled()));
    const before = after.replace("(fill yes ", "(fill ");
    const result = compare(before, after);
    expect(result).toMatchObject({ equal: true, changedZoneCount: 1, changedFilledStateZoneCount: 1, fillCacheFreshness: "unverified" });
    expect(result.zones[0]).toMatchObject({ cacheChanged: false, filledStateTransition: "omitted-to-yes" });
  });

  it("requires every after zone to be explicitly filled and rejects yes-to-omitted/no transient states", () => {
    const filledSource = board(zone(filled()));
    for (const after of [filledSource.replace("(fill yes ", "(fill "), filledSource.replace("(fill yes ", "(fill no ")]) {
      expect(() => compare(filledSource, after)).toThrow(/after-refill.*explicit filled-state yes/);
      expect(() => compare(after, after)).toThrow(/after-refill.*explicit filled-state yes/);
    }
    const before = board(zone("") + zone("", Z2)).replaceAll("(fill yes ", "(fill ");
    const after = board(zone(filled()) + zone(filled(), Z2).replace("(fill yes ", "(fill "));
    expect(() => compare(before, after, [Z, Z2])).toThrow(/after-refill.*explicit filled-state yes/);
  });

  it("binds the complete selected inventory and reports only changed zones", () => {
    const before = board(zone(filled()) + zone(filled(), Z2));
    const after = board(zone(filled(changedPoints)) + zone(filled(), Z2));
    const result = compare(before, after, [Z2, Z]);
    expect(result).toMatchObject({ equal: true, zoneUuids: [Z, Z2], changedZoneCount: 1 });
    expect(result.zones.map(entry => [entry.uuid, entry.cacheChanged])).toEqual([[Z, true], [Z2, false]]);
    expect(() => compare(before, after, [Z])).toThrow(/inventory/);
    expect(compare(before, board(zone(filled(), Z2) + zone(filled(changedPoints))), [Z, Z2]).equal).toBe(false);
  });

  it("retains repeated bridge vertices in a native fractured contour without claiming hole interpretation", () => {
    // Synthetic chain using the repeated-bridge form documented by the native
    // contours in kicad-reference-source.test.ts; no native execution here.
    const fractured = "(xy 9 1) (xy 9 9) (xy 1 9) (xy 1 6) (xy 4 6) (xy 6 6) (xy 6 4) (xy 4 4) (xy 4 6) (xy 1 6) (xy 1 1)";
    const result = compare(board(zone(filled())), board(zone(filled(fractured))));
    expect(result.equal).toBe(true);
    expect(result.zones[0]!.afterPointCount).toBe(11);
    expect(result.dcConnectivity).toBe("not_evaluated");
  });

  it("inherits only already accepted serializer whitespace, footprint-header and child-angle equivalences", () => {
    const before = board(zone(filled()));
    const after = board(zone(filled(changedPoints)))
      .replace('(footprint "Test:FP"', '(footprint "Test:FP" (version 20260206) (generator "pcbnew") (generator_version "10.0")')
      .replaceAll("(at 0 0 -90)", "(at 0 0 270)").replaceAll(" ", "\t");
    // Do not change whitespace inside quoted tokens in this positive variant.
    const corrected = after.replace("literal\tfilled_polygon\ttext", "literal filled_polygon text");
    expect(compare(before, corrected).equal).toBe(true);
    expect(compare(before, corrected.replace("(at\t0\t0\t270)", "(at\t0.1\t0\t270)")).equal).toBe(false);
    expect(compare(before, after).equal).toBe(false);
  });

  it.each([
    ["zone net", '(net "GND")', '(net "OTHER")'],
    ["zone name", '"HOST_PLANE"', '"RENAMED_PLANE"'],
    ["zone clearance", '(clearance 0.3)', '(clearance 0.4)'],
    ["thermal setting", '(thermal_bridge_width 0.5)', '(thermal_bridge_width 0.6)'],
    ["island setting", '(island_removal_mode 1)', '(island_removal_mode 0)'],
    ["minimum thickness", '(min_thickness 0.25)', '(min_thickness 0.3)'],
    ["zone boundary", '(polygon (pts (xy 1 1)', '(polygon (pts (xy 2 1)'],
    ["segment geometry", '(end 8 3)', '(end 8.1 3)'],
    ["segment width", '(width 0.25)', '(width 0.3)'],
    ["numeric spelling", '(width 0.25)', '(width 0.250)'],
    ["segment net", '(net "SIG")', '(net "OTHER")'],
    ["pad geometry", '(size 1 1)', '(size 1.1 1)'],
    ["pad drill", '(drill 0.3)', '(drill 0.4)'],
    ["model path", '"model.step"', '"other.step"'],
    ["property content", '"literal filled_polygon text"', '"literal filled_polygon  text"'],
    ["root version", '(version 20260206)', '(version 20250316)'],
    ["board setup", '(pad_to_mask_clearance 0)', '(pad_to_mask_clearance 0.1)'],
  ])("does not exclude %s changes", (_name, from, to) => {
    const before = board(zone(filled()));
    const after = board(zone(filled(changedPoints))).replace(from!, to!);
    expect(after).not.toBe(board(zone(filled(changedPoints))));
    expect(compare(before, after).equal).toBe(false);
  });

  it("preserves zone layer, root layer table, extra source forms and EOF whitespace", () => {
    const before = board(zone(filled()));
    const movedLayer = board(zone(filled(changedPoints)).replaceAll('"B.Cu"', '"F.Cu"'));
    expect(compare(before, movedLayer).equal).toBe(false);
    expect(compare(before, board(zone(filled()), '(property "extra" "source")')).equal).toBe(false);
    expect(compare(before, before.replace('(25 "Edge.Cuts" user)', '(25 "Edge.Cuts" user) (27 "Margin" user)')).equal).toBe(false);
    expect(compare(before, before + "\n").equal).toBe(false);
    expect(compare(before, before.slice(0, -1)).equal).toBe(false);
  });

  it.each([
    ["empty selection", []], ["duplicate selection", [Z, Z]], ["unknown UUID", [Z2]],
    ["noncanonical UUID", [Z.toUpperCase()]], ["malformed UUID", ["not-a-uuid"]], ["sparse selection", new Array<string>(1)],
    ["overbound selection", Array.from({ length: 513 }, (_, index) => `${index.toString(16).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`)],
  ] as const)("rejects %s", (_name, zoneUuids) => {
    expect(() => compare(board(zone(filled())), board(zone(filled())), zoneUuids)).toThrow();
  });

  it("rejects zone creation/removal, identity changes, duplicate identities and nested zones", () => {
    const before = board(zone(filled()));
    expect(() => compare(before, board(""))).toThrow(/inventory/);
    expect(() => compare(before, board(zone(filled()) + zone(filled(), Z2)))).toThrow(/inventory/);
    expect(() => compare(before, board(zone(filled(), Z2)))).toThrow(/selection/);
    expect(() => compare(board(zone(filled()) + zone(filled(), Z2)), board(zone(filled()) + zone(filled())), [Z, Z2])).toThrow(/duplicated/);
    const sharedIdentity = before.replace(S, Z);
    expect(() => compare(sharedIdentity, sharedIdentity)).toThrow(/duplicated/);
    const nested = board(zone(filled()), `(footprint "nested" ${zone(filled(), Z2)})`);
    expect(() => compare(nested, nested)).toThrow(/Nested zones/);
    const ambiguous = board(zone(filled(), Z, `(tstamp "${Z2}")`));
    expect(() => compare(ambiguous, ambiguous)).toThrow(/identity/);
  });

  it.each([
    ["duplicate cache", filled() + filled()],
    ["whitespace-normalized duplicate cache", filled() + filled().replaceAll(" ", "\t")],
    ["duplicate layer", filled().replace('(layer "B.Cu")', '(layer "B.Cu") (layer "B.Cu")')],
    ["unquoted layer", filled().replace('"B.Cu"', 'B.Cu')],
    ["wrong cache layer", filled().replace('"B.Cu"', '"F.Cu"')],
    ["missing cache layer", filled().replace('(layer "B.Cu")', '')],
    ["duplicate pts", filled().replace('(pts ', `(pts ${points}) (pts `)],
    ["unknown cache child", filled().replace('(pts ', '(future_cache 1) (pts ')],
    ["nested cache", filled().replace('(pts ', `${filled()} (pts `)],
    ["malformed island flag", filled(points, '(island maybe)')],
    ["duplicate island flags", filled(points, '(island yes) (island no)')],
    ["nonrepresentable point", filled().replace('(xy 1 1)', '(xy 0.0000001 1)')],
    ["quoted coordinate", filled().replace('(xy 1 1)', '(xy "1" 1)')],
    ["nested point data", filled().replace('(xy 1 1)', '(xy 1 1 (segment hidden))')],
    ["short contour", filled('(xy 1 1) (xy 2 2)')],
    ["bare cache tokens", filled().replace('(filled_polygon ', '(filled_polygon unexpected ')],
    ["unknown cache format", '(filled_triangle (layer "B.Cu") (pts (xy 1 1) (xy 2 1) (xy 2 2)))'],
    ["legacy fill_segments", '(fill_segments (pts (xy 1 1) (xy 2 2)))'],
  ])("rejects %s instead of excluding it", (_name, cache) => {
    const source = board(zone(cache!));
    expect(() => compare(source, source)).toThrow();
  });

  it("rejects rule areas, hatch fill, malformed settings and cache forms outside direct board zones", () => {
    for (const source of [
      board(zone(filled(), Z, '(keepout (tracks allowed) (vias allowed) (copperpour not_allowed))')),
      board(zone(filled()).replace('(fill yes ', '(fill yes (mode 1) ')),
      board(zone(filled()).replace('(fill yes ', '(fill yes (thermal_gap 0.6) ')),
      board(zone(filled()).replace('(fill yes ', '(fill yes (unknown_fill_setting 1) ')),
      board(zone(filled()).replace('(fill yes ', '(fill yes yes ')),
      board(zone(filled()).replace('(fill yes (thermal_gap 0.5)', '(fill (thermal_gap 0.5) yes')),
      board(zone(filled()).replace('(layer "B.Cu")', '(layer B.Cu)')),
      board(zone(filled()), filled()),
      board(zone("").replace('(fill yes ', `(fill yes ${filled()} `)),
      board(zone(filled()).replace('(polygon (pts ' + points + '))', '')),
    ]) expect(() => compare(source, source)).toThrow();
  });

  it("rejects malformed/oversized syntax before caches can conceal invalid source tokens", () => {
    for (const source of ["(kicad_pcb", `\uFEFF${board(zone(filled()))}`,
      board(zone(filled())).replace('(xy 1 1)', '(xy 1\r 1)'),
      board(zone(filled())).replace('(layer "B.Cu")', '(layer "B.\nCu")'),
      board(zone(filled())).replace('(xy 1 1)', '(xy 1\u00a01)'),
      board(zone(filled())).replace('"HOST_PLANE"', '"unterminated'),
      `(kicad_pcb ${"(nested ".repeat(257)}x${")".repeat(257)})`,
      board(zone(Array.from({ length: 4097 }, () => filled()).join(" "))),
    ]) expect(() => compare(source, source)).toThrow();
  });
});
