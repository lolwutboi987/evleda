import { describe, expect, it } from "vitest";
import { planFreshSchematicSymbolPoses } from "../../src/harness/fresh-schematic-symbol-pose.js";
import { parseFreshSchematicPresentationSource, parseFreshSchematicSourceDocument } from "../../src/harness/fresh-kicad-parser.js";

const documentId = '11111111-1111-4111-8111-111111111111';
const id = (i: number) => `22222222-2222-4222-8222-${String(i).padStart(12, '0')}`;
const symbol = (reference: string, index: number, y: number) => `(symbol (lib_id "Fixture:Header") (at 250.19 ${y} 0) (unit 1) (uuid "${id(index)}")
  (property "Reference" "${reference}" (at 252.73 ${y + .254} 0) (effects (font (size 1.27 1.27)) (justify left)))
  (property "Value" "PICO_${index}" (at 252.73 ${y + 2.286} 0) (effects (font (size 1.27 1.27)) (justify left)))
  (property "Footprint" "Fixture:Header" (at 250.19 ${y} 0) (effects (font (size 1.27 1.27)) (hide yes)))
  (property "Notes" "literal (wire (pts (xy 1 1) (xy 2 2)))")
  (instances (project "fixture" (path "/${documentId}" (reference "${reference}") (unit 1)))))`;
const root = (symbols = symbol('J2', 2, 64.77) + symbol('J3', 3, 123.19)) => `(kicad_sch (version 20250316) (generator "fixture") (uuid "${documentId}") (paper "A4")
  (lib_symbols (symbol "Fixture:Header" (symbol "Header_0_1" (arc (start 0 0) (mid 0 0) (end 0 0) (stroke (width 0) (type default))))))
  ${symbols} (sheet_instances (path "/" (page "1"))) (embedded_fonts no))`;
const updates = [{ reference: 'J2', x_mm: 242.57, y_mm: 64.77, rotation: 180 as const }, { reference: 'J3', x_mm: 242.57, y_mm: 123.19, rotation: 180 as const }];
function maskPoses(source: string) {
  const poses = parseFreshSchematicSourceDocument(source).children.filter(node => node.name === 'symbol')
    .map(node => node.children.find(child => child.name === 'at')!).sort((a, b) => b.start - a.start);
  let result = source; for (const pose of poses) result = result.slice(0, pose.start) + '(at <pose>)' + result.slice(pose.end); return result;
}

describe('unwired source-preserving schematic symbol poses', () => {
  it('sets the actual outward-header target poses while retaining every field and unrelated byte', () => {
    const before = root(), planned = planFreshSchematicSymbolPoses(before, updates);
    expect(planned.poses.map(pose => pose.after)).toEqual([{ x: 242.57, y: 64.77, rotation: 180 }, { x: 242.57, y: 123.19, rotation: 180 }]);
    expect(maskPoses(planned.source)).toBe(maskPoses(before));
    expect(parseFreshSchematicPresentationSource(planned.source)).toEqual(parseFreshSchematicPresentationSource(before));
    expect(planned.fields.every(field => !field.changed && field.before === field.after)).toBe(true);
    expect(planned.source).toContain('(property "Footprint" "Fixture:Header" (at 250.19 64.77 0)');
    expect(planFreshSchematicSymbolPoses(planned.source, updates)).toMatchObject({ changed: false, source: planned.source });
  });
  it.each([0, 90, 180, 270] as const)('supports cardinal instance angle %s without field transforms', rotation => {
    const before = root(), planned = planFreshSchematicSymbolPoses(before, [{ ...updates[0]!, rotation }]);
    expect(planned.poses[0]!.after.rotation).toBe(rotation);
    expect(maskPoses(planned.source)).toBe(maskPoses(before));
  });
  it('retains a semantically identical existing angle alias and numeric spelling on no-op', () => {
    const before = root().replace('(at 250.19 64.77 0)', '(at 2.5019e2 64.7700 -180)');
    expect(planFreshSchematicSymbolPoses(before, [{ reference: 'J2', x_mm: 250.19, y_mm: 64.77, rotation: 180 }])).toMatchObject({ source: before, changed: false });
  });
  it.each(['wire', 'label', 'global_label', 'hierarchical_label', 'no_connect', 'junction', 'sheet', 'bus', 'bus_entry', 'bus_alias', 'rule_area', 'unknown_electrical'])('rejects root %s before any pose edits', form => {
    const before = root().replace('(embedded_fonts no)', `(embedded_fonts no) (${form})`);
    expect(() => planFreshSchematicSymbolPoses(before, updates)).toThrow(/not admitted/);
  });
  it.each([
    ['unselected mirror', (s: string) => s.replace('(uuid "'+id(3)+'")', `(uuid "${id(3)}") (mirror x)`)],
    ['unselected unknown form', (s: string) => s.replace('(uuid "'+id(3)+'")', `(uuid "${id(3)}") (electrical_override yes)`)],
    ['unselected flag reference', (s: string) => s.replaceAll('"J3"', '"#FLG001"')],
    ['power library instance', (s: string) => s.replaceAll('"Fixture:Header"', '"power:GND"')],
    ['power-marked definition', (s: string) => s.replace('(symbol "Fixture:Header"', '(symbol "Fixture:Header" (power)')],
    ['duplicate reference', (s: string) => s.replaceAll('"J3"', '"J2"')],
    ['duplicate UUID', (s: string) => s.replace(id(3), id(2))],
    ['noncardinal existing angle', (s: string) => s.replace('(at 250.19 123.19 0)', '(at 250.19 123.19 45)')],
    ['duplicate instance at', (s: string) => s.replace('(at 250.19 64.77 0)', '(at 250.19 64.77 0) (at 1 2 0)')],
    ['missing angle token', (s: string) => s.replace('(at 250.19 64.77 0)', '(at 250.19 64.77)')],
    ['alternate project reference', (s: string) => s.replace('(reference "J2")', '(reference "OTHER")')],
    ['hierarchical path', (s: string) => s.replace(`(path "/${documentId}"`, '(path "/other/sheet"')],
    ['nested electrical property', (s: string) => s.replace('(property "Notes"', '(property (wire) "Notes"')],
    ['alternate pin metadata', (s: string) => s.replace('(unit 1)', '(unit 1) (pin "1" (net "N"))')],
  ] as const)('rejects %s across the complete placed inventory', (_name, change) => {
    expect(() => planFreshSchematicSymbolPoses(change(root()), [updates[0]!])).toThrow();
  });
  it.each([{ rotation: 45 }, { rotation: -90 }, { x_mm: .00001 }, { y_mm: 2001 }, { mirror: true }, { field: 'Value' }])('refuses unsupported request %j', change => {
    expect(() => planFreshSchematicSymbolPoses(root(), [{ ...updates[0]!, ...change } as typeof updates[number]])).toThrow();
  });
  it('requires unique existing refs and prevalidates the complete batch', () => {
    expect(() => planFreshSchematicSymbolPoses(root(), [updates[0]!, updates[0]!])).toThrow(/unique/);
    expect(() => planFreshSchematicSymbolPoses(root(), [updates[0]!, { ...updates[1]!, reference: 'ABSENT' }])).toThrow(/absent/);
    expect(() => planFreshSchematicSymbolPoses(root(), [])).toThrow();
  });
  it('admits the full64-symbol ceiling without dropping instance identities or fields', () => {
    const before = root(Array.from({ length: 64 }, (_, i) => symbol(`R${i + 1}`, i + 1, 50 + i)).join('\n'));
    const request = Array.from({ length: 64 }, (_, i) => ({ reference: `R${i + 1}`, x_mm: 100 + i, y_mm: 50 + i, rotation: 180 as const }));
    const plan = planFreshSchematicSymbolPoses(before, request);
    expect(plan.poses).toHaveLength(64); expect(plan.fields).toHaveLength(128);
    expect(maskPoses(plan.source)).toBe(maskPoses(before));
  });
});
