import { describe, expect, it } from "vitest";

import { contentIdentity } from "../../src/core/canonical.js";
import {
  compareFreshSchematicFieldPresentationSources,
  FreshKicadParseError,
  freshSchematicClassSourcesSupported,
  parseFreshSchematicPresentationSource,
  parseFreshSchematicSource,
  type FreshSchematicPresentationFieldTarget,
} from "../../src/harness/fresh-kicad-parser.js";

const REFERENCE = '(property "Reference" "R1" (at 45 47 0) (effects (font (size 1.27 1.27) (thickness 0.15)) (justify left)))';
const VALUE = '(property "Value" "10k" (at 53 54 90) (effects (font (size 1.2 1.8)) (justify right)))';
const SYMBOL = `(symbol (lib_id "Device:R") (at 50 50 270) (unit 1)
  (uuid "11111111-1111-4111-8111-111111111111")
  ${REFERENCE} ${VALUE}
  (property "Footprint" "Resistor_SMD:R_0603_1608Metric" (at 50 50 0) (effects (font (size 1.27 1.27)) (hide yes)))
  (property "private" "Reference" (at 1 2 0)))`;
const LABEL = '(global_label "VIN" (shape passive) (at 10 20 180) (effects (font (size 1.524 1.524)) (justify right)))';
const SOURCE = `(kicad_sch (version 20250114) (lib_symbols) ${SYMBOL} ${LABEL}
  (wire (pts (xy 10 20) (xy 15 20))) (junction (at 15 20))
  (polyline (pts (xy 1 2) (xy 3 4)) (stroke (width 0.1))))\n`;
const target: readonly FreshSchematicPresentationFieldTarget[] = [{ symbolIndex: 0, kind: "Reference" }];
const compare = (before: string, after: string, targets = target) =>
  compareFreshSchematicFieldPresentationSources(before, after, contentIdentity(before), targets);
const labelSource = (attributes: string) => `(kicad_sch (version 20250114) (global_label "NET" (shape passive) (at 1 2 0) ${attributes}))`;

describe("source-authored schematic presentation", () => {
  it("retains label rotation, explicit justification, font size and default origins separately from electrical data", () => {
    const result = parseFreshSchematicPresentationSource(SOURCE);
    expect(result.version).toBe(20250114);
    expect(result.labels).toEqual([{
      name: "VIN", kind: "global", shape: "passive", at: { x: 10, y: 20 }, rotationDeg: 180,
      justify: ["right"], fontSizeMm: { x: 1.524, y: 1.524 }, bold: false, italic: false, hidden: false,
      origins: { at: "explicit", rotationDeg: "explicit", justify: "explicit", fontSizeMm: "explicit",
        bold: "omitted-default", italic: "omitted-default", hidden: "omitted-default" },
    }]);
    const changedStyle = SOURCE.replace("(at 10 20 180)", "(at 10 20 90)").replace("(justify right)", "(justify top)");
    expect(parseFreshSchematicSource(changedStyle)).toEqual(parseFreshSchematicSource(SOURCE));
    expect(result.labels[0]).not.toHaveProperty("bounds");
    expect(result.labels[0]).not.toHaveProperty("measuredWidth");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.labels)).toBe(true);
    expect(Object.isFrozen(result.labels[0]!.origins)).toBe(true);
  });

  it("reads root-instance Reference/Value text at stored page coordinates without applying symbol rotation", () => {
    const result = parseFreshSchematicPresentationSource(SOURCE);
    expect(result.symbolFields).toHaveLength(2);
    expect(result.symbolFields[0]).toMatchObject({ kind: "Reference", text: "R1", reference: "R1", sourcePresent: true,
      symbolIndex: 0, symbolUuid: "11111111-1111-4111-8111-111111111111", at: { x: 45, y: 47 }, rotationDeg: 0,
      justify: ["left"], fontSizeMm: { x: 1.27, y: 1.27 }, hidden: false });
    expect(result.symbolFields[1]).toMatchObject({ kind: "Value", text: "10k", reference: "R1",
      at: { x: 53, y: 54 }, rotationDeg: 90, justify: ["right"], fontSizeMm: { x: 1.2, y: 1.8 } });
    const withLibraryFields = SOURCE.replace("(lib_symbols)", `(lib_symbols (symbol "Device:R" ${REFERENCE} ${VALUE}))`);
    expect(parseFreshSchematicPresentationSource(withLibraryFields)).toEqual(result);
  });

  it("represents missing legacy positions/styles/fields as explicit unknowns without inventing geometry", () => {
    const result = parseFreshSchematicPresentationSource('(kicad_sch (symbol (at 90 80 270) (property "Value" "legacy")) (label "LOCAL" (at 1 2)))');
    expect(result.version).toBeNull();
    expect(result.labels[0]).toMatchObject({ kind: "local", shape: null, at: { x: 1, y: 2 }, rotationDeg: null,
      justify: null, fontSizeMm: null, bold: false, italic: false, hidden: false,
      origins: { at: "explicit", rotationDeg: "omitted", justify: "omitted", fontSizeMm: "omitted", hidden: "omitted-default" } });
    expect(result.symbolFields[0]).toMatchObject({ kind: "Reference", text: null, sourcePresent: false,
      reference: null, symbolUuid: null, at: null, rotationDeg: null, fontSizeMm: null });
    expect(result.symbolFields[1]).toMatchObject({ kind: "Value", text: "legacy", sourcePresent: true,
      reference: null, at: null, rotationDeg: null, fontSizeMm: null });
  });

  it("supports explicit modern and legacy boolean flags and an explicit empty justification", () => {
    const modern = parseFreshSchematicPresentationSource(labelSource('(effects (font (size 1 2) (bold yes) (italic no)) (justify) (hide yes))')).labels[0]!;
    expect(modern).toMatchObject({ bold: true, italic: false, hidden: true, justify: [], origins: { bold: "explicit", italic: "explicit", hidden: "explicit", justify: "explicit" } });
    const legacy = parseFreshSchematicPresentationSource(labelSource('(effects (font (size 1 2) bold italic) hide)')).labels[0]!;
    expect(legacy).toMatchObject({ bold: true, italic: true, hidden: true });
    const field = parseFreshSchematicPresentationSource(SOURCE.replace(REFERENCE, REFERENCE.replace('(at 45 47 0)', '(hide no) (at 45 47 0)'))).symbolFields[0]!;
    expect(field.hidden).toBe(false);
    expect(field.origins.hidden).toBe("explicit");
  });

  it("preserves hierarchical shape and decoded Unicode/escaped text", () => {
    const source = String.raw`(kicad_sch (hierarchical_label "rail \"quoted\"\nΩ" (shape input) (at 3 4 -90) (effects (font (size 1 1)) (justify left bottom))))`;
    expect(parseFreshSchematicPresentationSource(source).labels[0]).toMatchObject({ name: 'rail "quoted"\nΩ', kind: "hierarchical", shape: "input", rotationDeg: -90, justify: ["left", "bottom"] });
  });

  it("keeps unquoted private modifiers distinct from a quoted property named private", () => {
    const privateReference = SOURCE.replace('(property "Reference"', '(property private "Reference"');
    expect(parseFreshSchematicPresentationSource(privateReference).symbolFields[0]).toMatchObject({ reference: "R1", text: "R1" });
    const literalPrivate = '(kicad_sch (symbol (property "private" "Reference") (property "Value" "10k")))';
    expect(parseFreshSchematicPresentationSource(literalPrivate).symbolFields[0]).toMatchObject({ sourcePresent: false, text: null, reference: null });
    const classSource = SOURCE.replace('(global_label "VIN"', '(global_label "VIN" (property private "Netclass" "OTHER" (at 0 0 0))');
    parseFreshSchematicPresentationSource(classSource);
    expect(parseFreshSchematicSource(classSource).classSources.netclassPropertyCount).toBe(1);
    expect(freshSchematicClassSourcesSupported(parseFreshSchematicSource(classSource))).toBe(false);
  });

  it.each([
    '(at 2 3 90)',
    '(effects) (effects)',
    '(effects (font (size 1 1)) (font (size 1 1)))',
    '(effects (font (size 1 1) (size 2 2)))',
    '(effects (font (size 0 1)))',
    '(effects (font (size -1 1)))',
    '(effects (font (size "1" 1)))',
    '(effects (font (size 1 1 2)))',
    '(effects (font (size 1 NaN)))',
    '(effects (font (size 1 1) bold (bold yes)))',
    '(effects (font (size 1 1) "bold"))',
    '(effects (font (size 1 1) (italic yes) (italic no)))',
    '(effects (font (size 1 1) (bold maybe)))',
    '(effects hide (hide yes))',
    '(hide no) (effects (hide yes))',
    '(effects "hide")',
    '(effects (justify left right))',
    '(effects (justify top bottom))',
    '(effects (justify left left))',
    '(effects (justify "left"))',
    '(effects (justify center))',
    '(effects (justify left (extra 1)))',
    '(effects (justify left) (justify right))',
  ])("rejects malformed or duplicate presentation metadata: %s", (style) => {
    expect(() => parseFreshSchematicPresentationSource(labelSource(style))).toThrow(FreshKicadParseError);
  });

  it.each([
    SOURCE.replace('(at 10 20 180)', '(at "10" 20 180)'),
    SOURCE.replace('(at 10 20 180)', '(at 10 20 180 1)'),
    SOURCE.replace('(shape passive)', '(shape passive) (shape input)'),
    SOURCE.replace(REFERENCE, `${REFERENCE} ${REFERENCE}`),
    SOURCE.replace('(property "private" "Reference"', '(property "private" "Reference" "unexpected"'),
    SOURCE.replace('(uuid "11111111-1111-4111-8111-111111111111")', '(uuid "one") (uuid "two")'),
    SOURCE.replace('(version 20250114)', '(version "20250114")'),
    SOURCE.replace('(global_label "VIN" (shape passive)', '(global_label (shape passive) "VIN"'),
    SOURCE.replace(REFERENCE, '(property (at 45 47 0) "Reference" "R1" (effects (font (size 1.27 1.27))))'),
  ])("rejects duplicate/malformed identity or placement metadata", (source) => {
    expect(() => parseFreshSchematicPresentationSource(source)).toThrow(FreshKicadParseError);
  });
});

describe("exact-token visible field presentation permission", () => {
  it("allows only a selected existing visible field's coordinates, angle and positional justification", () => {
    const after = SOURCE.replace('(at 45 47 0)', '(at 42.5 49 -90)').replace('(justify left)', '(justify right bottom)');
    expect(compare(SOURCE, SOURCE)).toEqual({ equal: true, changedFieldCount: 0 });
    expect(compare(SOURCE, after)).toEqual({ equal: true, changedFieldCount: 1 });
    expect(parseFreshSchematicSource(after)).toEqual(parseFreshSchematicSource(SOURCE));
    expect(compare(SOURCE, SOURCE.replace('(at 45 47 0)', '(at 45.0 47.0 0.0)'))).toEqual({ equal: true, changedFieldCount: 0 });
  });

  it("supports positional justify insertion/removal without dropping any other effects or mirror token", () => {
    const none = SOURCE.replace('(justify left)', '');
    expect(compare(none, SOURCE)).toEqual({ equal: true, changedFieldCount: 1 });
    expect(compare(SOURCE, none)).toEqual({ equal: true, changedFieldCount: 1 });
    const mirrored = SOURCE.replace('(justify left)', '(justify left mirror)');
    const moved = mirrored.replace('(justify left mirror)', '(justify top mirror right)');
    expect(compare(mirrored, moved)).toEqual({ equal: true, changedFieldCount: 1 });
    expect(compare(mirrored, SOURCE).equal).toBe(false);
    expect(compare(SOURCE, mirrored).equal).toBe(false);
    expect(compare(none, SOURCE.replace('(justify left)', '(justify)'))).toEqual({ equal: true, changedFieldCount: 0 });
  });

  it("counts changes per selected field and retains all unselected field positions", () => {
    const after = SOURCE.replace('(at 45 47 0)', '(at 43 46 0)').replace('(at 53 54 90)', '(at 55 56 0)');
    expect(compare(SOURCE, after).equal).toBe(false);
    expect(compare(SOURCE, after, [{ symbolIndex: 0, kind: "Value" }, ...target])).toEqual({ equal: true, changedFieldCount: 2 });
  });

  it.each([
    ['field text', SOURCE.replace('"10k"', '"11k"')],
    ['raw escape spelling', SOURCE.replace('"10k"', String.raw`"10\k"`)],
    ['reference text', SOURCE.replace('"R1"', '"R9"')],
    ['symbol placement', SOURCE.replace('(at 50 50 270)', '(at 50 51 270)')],
    ['label position', SOURCE.replace('(at 10 20 180)', '(at 11 20 180)')],
    ['label style', SOURCE.replace('(size 1.524 1.524)', '(size 1.524 1.5)')],
    ['font size', SOURCE.replace('(size 1.27 1.27)', '(size 1.3 1.27)')],
    ['font stroke', SOURCE.replace('(thickness 0.15)', '(thickness 0.16)')],
    ['font bold', SOURCE.replace('(thickness 0.15)', '(thickness 0.15) bold')],
    ['font italic', SOURCE.replace('(thickness 0.15)', '(thickness 0.15) italic')],
    ['font face', SOURCE.replace('(thickness 0.15)', '(thickness 0.15) (face "Other Font")')],
    ['unknown metadata', SOURCE.replace('(thickness 0.15)', '(thickness 0.15) (future_metadata 1)')],
    ['UUID', SOURCE.replace('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222')],
    ['wire coordinate', SOURCE.replace('(xy 15 20)', '(xy 16 20)')],
    ['wire numeric spelling', SOURCE.replace('(xy 15 20)', '(xy 15.0 20)')],
    ['root form', SOURCE.replace('(lib_symbols)', '(lib_symbols) (unknown_root "retained")')],
    ['property order', SOURCE.replace(`${REFERENCE} ${VALUE}`, `${VALUE} ${REFERENCE}`)],
  ])("rejects nonpositional %s changes without reconstructing the source", (_kind, after) => {
    expect(compare(SOURCE, after).equal).toBe(false);
  });

  it("requires the exact before-source identity before using the source or target set", () => {
    expect(() => compareFreshSchematicFieldPresentationSources(SOURCE, 'malformed', { ...contentIdentity(SOURCE), digest: '0'.repeat(64) }, target)).toThrow(/identity/iu);
    expect(() => compareFreshSchematicFieldPresentationSources(SOURCE, SOURCE, { ...contentIdentity(SOURCE), size: 1 }, target)).toThrow(/identity/iu);
  });

  it.each([
    { targets: [] as FreshSchematicPresentationFieldTarget[] },
    { targets: [...target, ...target] },
    { targets: [{ symbolIndex: -1, kind: "Reference" as const }] },
    { targets: [{ symbolIndex: 99, kind: "Reference" as const }] },
    { targets: [{ symbolIndex: 0, kind: "Footprint" as "Reference" }] },
  ])("rejects missing, duplicate or unsupported targets", ({ targets }) => {
    expect(() => compare(SOURCE, SOURCE, targets)).toThrow(FreshKicadParseError);
  });

  it.each([
    SOURCE.replace(REFERENCE, ''),
    SOURCE.replace('(at 45 47 0)', ''),
    SOURCE.replace('(at 45 47 0)', '(at 45 47)'),
    SOURCE.replace('(at 45 47 0)', '(at 45 47 0) (hide yes)'),
    SOURCE.replace(REFERENCE, '(property "Reference" "R1" (at 45 47 0))'),
    SOURCE.replace(SYMBOL, `${SYMBOL} ${SYMBOL.replace('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222')}`),
  ])("refuses missing, hidden, incomplete or ambiguously addressed fields", (source) => {
    expect(() => compare(source, source)).toThrow(FreshKicadParseError);
  });

  it("allows ASCII layout trivia but rejects token-merging/BOM/comment ambiguity", () => {
    expect(compare(SOURCE, SOURCE.replaceAll('\n', '\r\n')).equal).toBe(true);
    expect(compare(SOURCE, SOURCE.replace('(at 45 47 0)', '(at\n45\t47 0)')).equal).toBe(true);
    for (const malformed of [SOURCE.replace('"Reference" "R1"', '"Reference""R1"'), `\uFEFF${SOURCE}`,
      SOURCE.replace('(at 45 47 0)', '(at 45\u00a047 0)'), SOURCE.replace('(lib_symbols)', '(lib_symbols #comment\n)')]) {
      expect(() => compare(malformed, malformed)).toThrow(FreshKicadParseError);
    }
  });
});
