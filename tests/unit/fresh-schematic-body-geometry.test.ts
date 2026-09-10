import { describe, expect, it } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { parseFreshSymbolLibraryTerminalGeometrySource, selectFreshSymbolBodyGeometry } from "../../src/harness/fresh-kicad-parser.js";

const stroke = "(stroke (width 0.254) (type default)) (fill (type none))";
const pin = '(pin passive line (at 10 10 0) (length 2.54) (name "P") (number "1"))';
const geometry = (graphics: string) => {
  const source = `(kicad_symbol_lib (symbol "Body" (symbol "Body_1_1" ${pin} ${graphics})))`;
  return parseFreshSymbolLibraryTerminalGeometrySource(source, contentIdentity(source), "Test:Body");
};
const bodies = (graphics: string) => selectFreshSymbolBodyGeometry(geometry(graphics), 1, 1);

describe("source graphical envelopes, not native ink measurements", () => {
  it.each([
    ["rectangle", `(rectangle (start -2 -3) (end 4 5) ${stroke})`, [-2, -3, 4, 5]],
    ["polyline", `(polyline (pts (xy -2 5) (xy 4 -3) (xy 0 0)) ${stroke})`, [-2, -3, 4, 5]],
    ["circle", `(circle (center 1 1) (radius 3) ${stroke})`, [-2, -2, 4, 4]],
    ["bezier", `(bezier (pts (xy -2 5) (xy 4 -3) (xy 0 0) (xy 1 1)) ${stroke})`, [-2, -3, 4, 5]],
    ["arc", `(arc (start -3 0) (mid 0 3) (end 3 0) ${stroke})`, [-3, -3, 3, 3]],
  ] as const)("conservatively contains %s geometry with an explicit stroke envelope", (kind, source, expected) => {
    const result = bodies(source)[0]!;
    expect(result.kind).toBe(kind);
    expect(result.unsupportedReason).toBeNull();
    expect(result.bounds!.minXmm).toBeCloseTo(expected[0] - 0.255, 9);
    expect(result.bounds!.minYmm).toBeCloseTo(expected[1] - 0.255, 9);
    expect(result.bounds!.maxXmm).toBeCloseTo(expected[2] + 0.255, 9);
    expect(result.bounds!.maxYmm).toBeCloseTo(expected[3] + 0.255, 9);
    expect(Object.isFrozen(result.bounds)).toBe(true);
  });
  it("compares exact non-whitespace graphic tokens separately from raw source identity", () => {
    const a = bodies(`(rectangle (start -2 -3) (end 4 5) ${stroke})`)[0]!;
    const b = bodies(`(rectangle\n (start -2 -3)\n (end 4 5) ${stroke})`)[0]!;
    const changedSpelling = bodies(`(rectangle (start -2.0 -3) (end 4 5) ${stroke})`)[0]!;
    expect(a.tokenIdentity).toEqual(b.tokenIdentity);
    expect(a.sourceIdentity).not.toEqual(b.sourceIdentity);
    expect(a.tokenIdentity).not.toEqual(changedSpelling.tokenIdentity);
  });
  it.each([
    ["missing stroke", "(rectangle (start 0 0) (end 2 3))", "source-default-stroke-width-unbound"],
    ["default stroke", `(rectangle (start 0 0) (end 2 3) ${stroke.replace("0.254", "0")})`, "source-default-stroke-width-unbound"],
    ["text", '(text "not a measured font box" (at 0 0 0))', "graphic-text-requires-native-font"],
    ["text box", '(text_box "not a measured font box" (start 0 0) (end 4 2))', "graphic-text-requires-native-font"],
    ["unknown", "(future_graphic (huge 1000))", "unsupported-graphic:future_graphic"],
    ["private modifier", `(rectangle private (start 0 0) (end 2 3) ${stroke})`, "unsupported-graphic-modifier"],
    ["unknown metadata", `(rectangle (start 0 0) (end 2 3) (future_transform 1) ${stroke})`, "unsupported-graphic-metadata"],
    ["collinear arc", `(arc (start 0 0) (mid 1 0) (end 2 0) ${stroke})`, "degenerate-or-unstable-arc"],
  ])("preserves explicit unsupported coverage for %s", (_name, source, reason) => {
    expect(bodies(source)[0]).toMatchObject({ bounds: null, unsupportedReason: reason });
  });
  it.each([
    `(rectangle (start 0 0) (start 1 1) (end 2 3) ${stroke})`,
    `(circle (center 0 0) (radius -1) ${stroke})`,
    `(circle (center 0 0) (radius "1") ${stroke})`,
    `(polyline (pts (xy 0 0) (wrong 1 1)) ${stroke})`,
    `(bezier (pts (xy 0 0) (xy 1 1)) ${stroke})`,
    `(rectangle (start 0 0 4) (end 2 3) ${stroke})`,
    `(rectangle (start 0 0) (end 2 3) (stroke (width 1) (width 2)))`,
  ])("rejects malformed geometry rather than returning a partial envelope", (source) => expect(() => bodies(source)).toThrow());
  it("does not infer any body drawing from pin endpoints", () => {
    expect(bodies("")).toEqual([]);
  });
  it("does not silently skip unknown selected representation or root drawing forms", () => {
    const source = `(kicad_symbol_lib (symbol "Body" (future_root_graphic) (symbol "Body_0_0" (future_common_graphic)) (symbol "Body_1_1" ${pin})))`;
    const parsed = parseFreshSymbolLibraryTerminalGeometrySource(source, contentIdentity(source), "Test:Body");
    expect(selectFreshSymbolBodyGeometry(parsed, 1, 1).map((graphic) => graphic.kind)).toEqual(["future_root_graphic", "future_common_graphic"]);
  });
});
