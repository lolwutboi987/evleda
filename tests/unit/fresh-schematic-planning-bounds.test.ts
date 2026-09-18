import { describe, expect, it } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { composeFreshSchematicPlanningBounds } from "../../src/harness/kicad-tools.js";
import type { FreshSchematicStrokeStyleEvidence } from "../../src/harness/fresh-schematic-stroke-style.js";

const source = '(kicad_sch (global_label "NET" (shape passive) (at 30 30 180) (effects (font (size 1.524 1.524)) (justify right))))';
const svgIdentity = contentIdentity("synthetic native fixture");
const glyphs: FreshSchematicStrokeStyleEvidence["nativeText"] = {
  completeCoverage: true, hasText: true, unsupported: [], bounds: [
    { textGroupIndex: 0, elementIndex: 5, text: "NET", minX: 26, minY: 29.9, maxX: 28, maxY: 30.1 },
    { textGroupIndex: 1, elementIndex: 9, text: "custom field", minX: 10, minY: 10, maxX: 12, maxY: 11 },
    { textGroupIndex: 2, elementIndex: 13, text: "1", minX: 40, minY: 40, maxX: 41, maxY: 41 },
    { textGroupIndex: 3, elementIndex: 17, text: "1", minX: 45, minY: 40, maxX: 46, maxY: 41 },
  ],
};

describe("pure schematic planning bounds composition (no native authority)", () => {
  it("keeps every real text group separate from component envelopes and binds its exact SVG identity", () => {
    const body = { reference: "C1", minX: 49, minY: 46, maxX: 51, maxY: 54 };
    const result = composeFreshSchematicPlanningBounds([body], glyphs, svgIdentity, source);
    expect(result[0]).toEqual(body);
    expect(result.filter(box => box.nativeText?.kind === "glyph")).toHaveLength(4);
    expect(result.filter(box => box.nativeText?.kind === "persisted-label-reservation")).toHaveLength(1);
    for (const glyph of glyphs.bounds) {
      expect(result).toContainEqual(expect.objectContaining({ reference: `@native-text:${glyph.textGroupIndex}`,
        minX: glyph.minX, minY: glyph.minY, maxX: glyph.maxX, maxY: glyph.maxY,
        nativeText: expect.objectContaining({ svgIdentity, groupIndex: glyph.textGroupIndex, text: glyph.text }) }));
    }
  });

  it("retains the entire existing label reservation and only marks fully contained ink", () => {
    const result = composeFreshSchematicPlanningBounds([], glyphs, svgIdentity, source);
    const reservation = result.find(box => box.nativeText?.kind === "persisted-label-reservation")!;
    const covered = result.find(box => box.reference === "@native-text:0")!;
    expect(covered.nativeText!.coveringLabel).toEqual({ name: "NET", at: { x: 30, y: 30 }, rotationDeg: 180 });
    expect(reservation.minX).toBeLessThan(covered.minX);
    expect(reservation.maxY).toBeGreaterThan(covered.maxY);
    expect(result.find(box => box.reference === "@native-text:1")!.nativeText!.coveringLabel).toBeNull();
    const crossing = { ...glyphs, bounds: [{ ...glyphs.bounds[0]!, maxX: 30.1 }] };
    expect(composeFreshSchematicPlanningBounds([], crossing, svgIdentity, source).find(box => box.reference === "@native-text:0")!.nativeText!.coveringLabel).toBeNull();
  });

  it("does not subsume glyphs using unsupported or ambiguous source label presentation", () => {
    for (const changed of [source.replace("1.524 1.524", "1.27 1.27"), source.replace("(justify right)", "(justify right) (hide yes)"),
      source.replace("(shape passive)", "(shape input)"), source.replace("(size 1.524 1.524)", '(size 1.524 1.524) (face "Arial")'),
      source.replace("(justify right)", "(justify right) (color 1 1 1 0)"), source.replace('"NET"', '"N_{ET}"')]) {
      const result = composeFreshSchematicPlanningBounds([], glyphs, svgIdentity, changed);
      expect(result).toHaveLength(4);
      expect(result.every(box => box.nativeText?.coveringLabel === null)).toBe(true);
    }
  });

  it("refuses incomplete glyph coverage before returning any reduced obstacle set", () => {
    expect(() => composeFreshSchematicPlanningBounds([], { ...glyphs, completeCoverage: false }, svgIdentity, source)).toThrow(/incomplete or unsupported/);
  });
});
