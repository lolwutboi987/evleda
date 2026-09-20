import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseFreshPcbSourceDocument } from "../../src/harness/fresh-kicad-parser.js";
import { freshBoardSerializationsEqual } from "../../src/harness/fresh-board-serialization.js";
import { FRESH_PCB_RESOURCE_LIMITS } from "../../src/harness/fresh-resource-limits.js";
import { assertOnlyRequestedFootprintFieldChanged, assertOnlyRequestedFootprintFieldsChanged, parseFreshFootprintFieldRequest, parseFreshFootprintFieldUpdates,
  planFreshFootprintField, planFreshFootprintFields } from "../../src/harness/fresh-footprint-field.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const modelPath = '${KICAD10_3DMODEL_DIR}/Library/Part.step';
const field = (name: string, text: string, uid: number, layer = "F.SilkS") => `(property "${name}" "${text}" (at 0 -2 0) (layer "${layer}") (uuid "${id(uid)}") (effects (font (size 1 1) (thickness 0.15))))`;
const footprint = (ref: string, n: number, rotation = 0) => `(footprint "Library:Part_${ref}" (layer "F.Cu") (at 10 20 ${rotation}) (uuid "${id(n)}")
  ${field("Reference", ref, n + 1)} ${field("Value", '47k \\"exact\\"', n + 2, "F.Fab")}
  (property "custom" "unchanged \\"metadata\\"" (at 0 0 0) (layer "F.Fab") (hide yes) (uuid "${id(n + 3)}") (effects (font (size 0.6 0.6))))
  (fp_rect (start -1 -1) (end 1 1) (stroke (width .12) (type default)) (layer "F.SilkS") (uuid "${id(n + 4)}"))
  (pad "1" smd roundrect (at -1 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask") (net 1 "N") (uuid "${id(n + 5)}"))
  (pad "" np_thru_hole circle (at 0 0) (size .65 .65) (drill .65) (layers "*.Cu" "*.Mask") (uuid "${id(n + 6)}"))
  (model "${modelPath}" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0))))`;
const board = (rotation = 0) => `(kicad_pcb (version 20260206) (generator "pcbnew") (net 1 "N")
  ${footprint("R1", 1, rotation)} ${footprint("R2", 21)}
  (gr_text "unrelated board text" (at 1 2) (layer "F.SilkS") (uuid "${id(99)}") (effects (font (size 1 1)))))\n`;
const request = { reference: "R1", field: "Reference" as const, x_mm: 5, y_mm: 6, rotation_deg: 90 as const, size_mm: 0.8, thickness_mm: 0.08 };
function maskSelected(source: string, ref = "R1", kind = "Reference") {
  const root = parseFreshPcbSourceDocument(source);
  const owner = root.children.find(node => node.name === "footprint" && node.children.some(child => child.name === "property" && child.values[0]?.value === "Reference" && child.values[1]?.value === ref))!;
  const selected = owner.children.find(node => node.name === "property" && node.values[0]?.value === kind)!;
  return source.slice(0, selected.start) + "FIELD" + source.slice(selected.end);
}

describe("bounded preserving footprint field presentation", () => {
  it("preserves a real fully routed 616 KB board while editing a footprint field", () => {
    const before = readFileSync(new URL("../fixtures/fresh-project/native-large-field-source.kicad_pcb", import.meta.url), "utf8");
    expect(Buffer.byteLength(before)).toBe(616071);
    const edit = { reference: "U1", field: "Reference" as const, visible: false };
    const result = planFreshFootprintField(before, edit);
    expect(result.changed).toBe(true); expect(result.afterField.visible).toBe(false);
    expect(maskSelected(result.source, "U1")).toBe(maskSelected(before, "U1"));
    expect(() => assertOnlyRequestedFootprintFieldChanged(before, result.source, edit)).not.toThrow();
  });

  it("counts UTF-8 input bytes and rejects malformed or over-limit source before planning", () => {
    const base = board(), max = FRESH_PCB_RESOURCE_LIMITS.maximumLiveSourceBytes;
    const exact = base + " ".repeat(max - Buffer.byteLength(base));
    expect(planFreshFootprintField(exact, { reference: "R1", field: "Reference", visible: true })).toMatchObject({ source: exact, changed: false });
    expect(() => planFreshFootprintField(exact + " ", request)).toThrow(/bounded well-formed text/);
    const unicode = base.replace("unrelated board text", "é".repeat(Math.ceil(max / 2)));
    expect(unicode.length).toBeLessThan(max); expect(Buffer.byteLength(unicode)).toBeGreaterThan(max);
    expect(() => planFreshFootprintField(unicode, request)).toThrow(/bounded well-formed text/);
    expect(() => planFreshFootprintField(base + "\ud800", request)).toThrow(/bounded well-formed text/);
  });

  it("rejects output growth beyond the same live byte bound, including the final batch item", () => {
    const base = board(), max = FRESH_PCB_RESOURCE_LIMITS.maximumLiveSourceBytes;
    const exact = base + " ".repeat(max - Buffer.byteLength(base));
    const hide = { reference: "R1", field: "Reference" as const, visible: false };
    expect(() => planFreshFootprintField(exact, hide)).toThrow(/planned source exceeds/);
    const oneHideAddedBytes = Buffer.byteLength(planFreshFootprintField(base, hide).source) - Buffer.byteLength(base);
    const nearlyFull = exact.slice(0, -oneHideAddedBytes);
    expect(Buffer.byteLength(planFreshFootprintField(nearlyFull, hide).source)).toBe(max);
    expect(() => planFreshFootprintFields(nearlyFull, { updates: [hide, { reference: "R2", field: "Reference", visible: false }] })).toThrow(/planned source exceeds/);
  });

  it.each([0, 90, 180, 270])("moves one field in board coordinates at footprint rotation %s, preserving all physical source", rotation => {
    const before = board(rotation), result = planFreshFootprintField(before, request);
    expect(result.afterField).toMatchObject({ xMm: 5, yMm: 6, rotationDeg: 90, visible: true, sizeMm: { x: 0.8, y: 0.8 }, thicknessMm: 0.08 });
    expect(result.before).toEqual(result.after);
    expect(result.footprintId).toBe(id(1)); expect(result.fieldId).toBe(id(2)); expect(result.fieldText).toBe("R1");
    expect(maskSelected(result.source)).toBe(maskSelected(before));
    expect(() => assertOnlyRequestedFootprintFieldChanged(before, result.source, request)).not.toThrow();
    expect(planFreshFootprintField(result.source, request)).toMatchObject({ changed: false, source: result.source });
    const expectedLocal = rotation === 0 ? "-5 -14" : rotation === 90 ? "14 -5" : rotation === 180 ? "5 14" : "-14 5";
    expect(result.source).toContain(`(property "Reference" "R1" (at ${expectedLocal} 90)`);
  });

  it("hides without changing text/UUID/size and uses native property child ordering", () => {
    const before = board(); const hidden = planFreshFootprintField(before, { reference: "R1", field: "Reference", visible: false });
    expect(hidden.source).toContain(`(layer "F.SilkS") (hide yes) (uuid "${id(2)}")`);
    expect(hidden.afterField).toEqual({ ...hidden.beforeField, visible: false });
    const shown = planFreshFootprintField(hidden.source, { reference: "R1", field: "Reference", visible: true });
    expect(freshBoardSerializationsEqual(shown.source, before)).toBe(true);
    expect(maskSelected(hidden.source)).toBe(maskSelected(before));
  });

  it("allows hiding undersized stock text while refusing to expose it below existing minima", () => {
    const small = board().replace('(size 1 1) (thickness 0.15)', '(size 0.6 0.6) (thickness 0.06)');
    expect(() => planFreshFootprintField(small, { reference: "R1", field: "Reference", x_mm: 1, y_mm: 2 })).toThrow(/0.8 mm/);
    const hidden = planFreshFootprintField(small, { reference: "R1", field: "Reference", visible: false });
    expect(hidden.source).toContain('(size 0.6 0.6) (thickness 0.06)');
    expect(() => planFreshFootprintField(hidden.source, { reference: "R1", field: "Reference", visible: true })).toThrow(/0.8 mm/);
    expect(planFreshFootprintField(hidden.source, { reference: "R1", field: "Reference", visible: true, size_mm: .8, thickness_mm: .08 }).afterField.visible).toBe(true);
  });

  it("changes only the selected field layer between the admitted front presentation layers", () => {
    const before = board(), result = planFreshFootprintField(before, { reference: "R1", field: "Value", layer: "F.SilkS" });
    expect(result.afterField.layer).toBe("F.SilkS");
    expect(result.fieldText).toBe('47k "exact"');
    expect(maskSelected(result.source, "R1", "Value")).toBe(maskSelected(before, "R1", "Value"));
  });

  it.each([
    {}, { x_mm: 1 }, { y_mm: 1 }, { size_mm: .79 }, { thickness_mm: .079 }, { layer: "F.Cu" }, { layer: "B.SilkS" },
    { field: "Datasheet", visible: false }, { text: "rewritten", visible: false }, { rotation_deg: 45 }, { rotation_deg: -90 },
    { x_mm: NaN, y_mm: 1 }, { x_mm: .0000001, y_mm: 1 }, { x_mm: -1, y_mm: 0 }, { visible: "false" },
  ])("rejects an unsupported or widening request %j", change => {
    expect(() => parseFreshFootprintFieldRequest({ reference: "R1", field: "Reference", ...change })).toThrow();
  });

  it.each([
    (source: string) => source.replace('(property "Reference" "R1"', '(property "Reference" "R1" (hide yes) (hide no)'),
    (source: string) => source.replace(`(uuid "${id(2)}")`, ""),
    (source: string) => source.replace('(layer "F.SilkS")', '(layer "F.Cu")'),
    (source: string) => source.replace('(font (size 1 1)', '(font (face "Other Font") (size 1 1)'),
    (source: string) => source.replace('(at 0 -2 0)', '(at 0 -2 45)'),
    (source: string) => source.replace('(size 1 1)', '(size 1 1) (size 2 2)'),
    (source: string) => source.replace('(property "Reference" "R2"', '(property "Reference" "R1"'),
  ])("refuses ambiguous field identity or unsupported source before staging", change => {
    expect(() => planFreshFootprintField(change(board()), request)).toThrow();
  });

  it.each([
    (source: string) => source.replace('"R1"', '"R9"'), (source: string) => source.replace('(net 1 "N")', '(net 1 "X")'),
    (source: string) => source.replace('(at -1 0)', '(at -2 0)'), (source: string) => source.replace('(drill .65)', '(drill .7)'),
    (source: string) => source.replace('(width .12)', '(width .2)'), (source: string) => source.replace('Library/Part.step', 'Library/Other.step'),
  ])("rejects collateral native changes after an otherwise correct field edit", change => {
    const before = board(), planned = planFreshFootprintField(before, request);
    expect(() => assertOnlyRequestedFootprintFieldChanged(before, change(planned.source), request)).toThrow(/readback differs/);
  });

  it("plans one bounded atomic list and rejects late errors or duplicate fields before producing a staged source", () => {
    const before = board(), updates = [{ reference: "R1", field: "Reference", visible: false }, { reference: "R2", field: "Value", size_mm: .8, thickness_mm: .08 }];
    const plan = planFreshFootprintFields(before, { updates });
    expect(plan.updates).toHaveLength(2); expect(plan.changed).toBe(true);
    expect(() => assertOnlyRequestedFootprintFieldsChanged(before, plan.source, { updates })).not.toThrow();
    expect(() => assertOnlyRequestedFootprintFieldsChanged(before, plan.source.replace('(drill .65)', '(drill .7)'), { updates })).toThrow(/complete atomic field plan/);
    expect(planFreshFootprintFields(plan.source, { updates })).toMatchObject({ changed: false, source: plan.source });
    expect(() => planFreshFootprintFields(before, { updates: [...updates, { reference: "MISSING", field: "Reference", visible: false }] })).toThrow(/exactly one/);
    expect(() => parseFreshFootprintFieldUpdates({ updates: [updates[0], updates[0]] })).toThrow(/duplicate/);
    expect(() => parseFreshFootprintFieldUpdates({ updates: [] })).toThrow();
    expect(() => parseFreshFootprintFieldUpdates({ updates: Array.from({ length: 129 }, () => updates[0]) })).toThrow();
  });

  it("preserves every nonselected byte of captured native USB-C footprint data", () => {
    const before = readFileSync(new URL("../fixtures/usb-c-native-pads/native05-saved-post-move.kicad_pcb", import.meta.url), "utf8");
    const result = planFreshFootprintField(before, { reference: "J1", field: "Reference", visible: false });
    expect(maskSelected(result.source, "J1")).toBe(maskSelected(before, "J1"));
    expect(result.fieldText).toBe("J1"); expect(result.afterField.visible).toBe(false);
  });
});
