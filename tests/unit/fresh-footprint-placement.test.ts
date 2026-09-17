import { describe, expect, it } from "vitest";
import { planFreshFootprintPlacement } from "../../src/harness/fresh-footprint-placement.js";
import { parseFreshPcbSource, parseFreshPcbSourceDocument, type FreshKicadSourceNode } from "../../src/harness/fresh-kicad-parser.js";

const ID = "11111111-1111-4111-8111-111111111111";
// WSON physical pad dimensions and model block are taken from the installed
// KiCad 10 stock WSON-6-1EP_2x2mm_P0.65mm_EP1x1.6mm. The fixture adds deliberate
// angle/formatting variants and metadata to expose lossy reconstruction.
const model = String.raw`(model "${"${KICAD10_3DMODEL_DIR}"}/Package_SON.3dshapes/WSON-6-1EP_2x2mm_P0.65mm_EP1x1.6mm.step"
    (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))`;
const physicalPads = [
  ["", "0 -0.4", "0.81 0.64", '"F.Paste"'],
  ["", "0 0.4", "0.81 0.64", '"F.Paste"'],
  ["1", "-0.8875 -0.65", "0.375 0.4", '"F.Cu" "F.Mask" "F.Paste"'],
  ["2", "-0.8875 0 90", "0.375 0.4", '"F.Cu" "F.Mask" "F.Paste"'],
  ["3", "-0.8875 0.65 -90", "0.375 0.4", '"F.Cu" "F.Mask" "F.Paste"'],
  ["4", "0.8875 0.65 0", "0.375 0.4", '"F.Cu" "F.Mask" "F.Paste"'],
  ["5", "0.8875 0", "0.375 0.4", '"F.Cu" "F.Mask" "F.Paste"'],
  ["6", "0.8875 -0.65", "0.375 0.4", '"F.Cu" "F.Mask" "F.Paste"'],
  ["7", "0 0", "1 1.6", '"F.Cu" "F.Mask"'],
].map(([number, at, size, layers], index) => `(pad "${number}" smd roundrect
    (at ${at}) (size ${size}) (layers ${layers}) (roundrect_rratio 0.25)
    (uuid "22222222-2222-4222-8222-${String(index).padStart(12, "0")}")
    ${number === "7" ? '(property pad_prop_heatsink)' : ""}
    ${number !== "" && number !== "5" ? '(net "GND")' : ""}
    (vendor_metadata "literal (at 1 2 3), \\"quoted\\" and unknown data"))`).join("\n");
const footprint = `(footprint "Package_SON:WSON-6-1EP_2x2mm_P0.65mm_EP1x1.6mm"
  (descr "A (pad fake) before root placement")
  (property "Reference" "U1" (at 0 -1.95 0) (layer "F.SilkS") (effects (font (size 1 1))))
  (layer "F.Cu") (uuid "${ID}") (at 10.000000 2e1)
  (property "Value" "WSON" (at 0 1.95) (layer "F.Fab") (effects (font (size 1 1))))
  (property "KiLib_Generator" "package/no_lead" (at 0 0 90) (layer "F.SilkS") (hide yes))
  (fp_text user "${"${REFERENCE}"}" (at 0 0 -90) (unlocked yes) (layer "F.Fab") (effects (font (size .5 .5)) (justify left top)))
  (fp_line (start -1.33 -1.1) (end -1.25 -1.1) (stroke (width .05) (type solid)) (layer "F.CrtYd"))
  (fp_poly (pts (xy -1 -1) (xy 1 -1) (xy 1 1)) (stroke (width .1) (type solid)) (fill no) (layer "F.Fab"))
  (attr smd) (duplicate_pad_numbers_are_jumpers no)
  (future_metadata (supplier "preserve this exact raw data"))
  ${physicalPads}
  ${model})`;
const outside = `(gr_text "unrelated (at 9 9 90)" (at 8 7) (layer "F.SilkS"))`;
const board = (selected = footprint, extra = "") => `\n(kicad_pcb (version 20260206) (generator "pcbnew")\n${outside}\n${selected}\n${extra})\n\n`;
const request = (rotationDeg = 90) => ({ reference: "U1", xMm: 22.000001, yMm: -24.000001, rotationDeg });
const fp = (source: string) => parseFreshPcbSourceDocument(source).children.find(node => node.name === "footprint")!;
const at = (node: FreshKicadSourceNode) => node.children.find(child => child.name === "at")!;
const nodeId = (node: FreshKicadSourceNode) => node.children.find(child => child.name === "uuid")!.values[0]!.value;
const graphicId = (index: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`;
const drawingBoard = (drawings: string) => `(kicad_pcb (version 20260206)
  (footprint "Test:Ordering" (layer "F.Cu") (uuid "${ID}") (at 10 20)
    (property "Reference" "U1" (at 0 0 0)) ${drawings}))`;

/** Independently mask only the documented editable atoms, including inserted
 * optional angles. Everything else, including whitespace and child XY, is exact. */
function invariantBytes(source: string): string {
  const target = fp(source), edits: { start: number; end: number; text: string }[] = [];
  const rootAt = at(target);
  edits.push({ start: rootAt.values[0]!.start, end: rootAt.end - 1, text: "POSE" });
  for (const node of target.children.filter(node => ["pad", "property", "fp_text"].includes(node.name))) {
    const position = at(node);
    edits.push({ start: position.values[1]!.end, end: position.end - 1, text: "" });
  }
  let result = source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}

describe("lossless cardinal footprint source placement", () => {
  it.each([
    [0, [0, 0, 0, 90, -90, 0, 0, 0, 0], [0, 0, 90, -90]],
    [90, [90, 90, 90, 180, 0, 90, 90, 90, 90], [90, 90, 180, 0]],
    [180, [180, 180, 180, 270, 90, 180, 180, 180, 180], [180, 180, 270, 90]],
    [270, [270, 270, 270, 0, 180, 270, 270, 270, 270], [270, 270, 0, 180]],
  ] as const)("preserves nine physical pads, metadata, models and unrelated bytes at %i degrees", (rotation, padAngles, textAngles) => {
    const original = board().replaceAll("\n", "\r\n");
    const result = planFreshFootprintPlacement(original, request(rotation));
    expect(result).toMatchObject({ changed: true, reference: "U1", footprintId: ID,
      before: { xMm: 10, yMm: 20, rotationDeg: 0 }, after: { xMm: 22.000001, yMm: -24.000001, rotationDeg: rotation } });
    expect(invariantBytes(result.source)).toBe(invariantBytes(original));
    expect(result.source).toContain(model.replaceAll("\n", "\r\n"));
    expect(result.source).toContain("(property pad_prop_heatsink)");
    expect(result.source).toContain(outside);
    expect(result.source).toContain("(at 22.000001 -24.000001");
    const target = fp(result.source);
    expect(target.children.filter(node => node.name === "pad").map(node => Number(at(node).values[2]?.value ?? 0))).toEqual(padAngles);
    expect(target.children.filter(node => ["property", "fp_text"].includes(node.name)).map(node => Number(at(node).values[2]?.value ?? 0))).toEqual(textAngles);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.before)).toBe(true);
    expect(Object.isFrozen(result.after)).toBe(true);
  });

  // Exact geometry/UUID excerpt from native06 diagnostic SHA-256
  // cf1896f8cfaae08687ceb004cdfd3778e895de3241f69b1019d8b5ea56fa6451.
  // Full-board before/plan/live and pinned CLI replay are retained separately.
  it.each([[0, false], [90, false], [180, true], [270, true]] as const)(
    "reproduces native06 complete silk-line subtree order at %i degrees", (rotation, reverse) => {
      const lower = '(fp_line\r\n\t\t\t(start -0.711252 -1.36)\r\n\t\t\t(end 0.711252 -1.36)\r\n\t\t\t(stroke\r\n\t\t\t\t(width 0.12)\r\n\t\t\t\t(type solid)\r\n\t\t\t)\r\n\t\t\t(layer "F.SilkS")\r\n\t\t\t(uuid "40ddb024-b28e-4dfa-be32-da2209fd00b8")\r\n\t\t)';
      const upper = '(fp_line\r\n\t\t\t(start -0.711252 1.36)\r\n\t\t\t(end 0.711252 1.36)\r\n\t\t\t(stroke\r\n\t\t\t\t(width 0.12)\r\n\t\t\t\t(type solid)\r\n\t\t\t)\r\n\t\t\t(layer "F.SilkS")\r\n\t\t\t(uuid "57c8dfba-d737-409e-b923-228c8deff25d")\r\n\t\t)';
      const original = `(kicad_pcb (footprint "Capacitor_SMD:C_1210_3225Metric" (layer "F.Cu") (uuid "8ce40009-1d6b-4870-b388-9cbe90d2d1a6")
        (at 66 25) (property "Reference" "C1" (at 0 -2.3 0))\r\n\t\t${lower}\r\n\t\t${upper}))`;
      const result = planFreshFootprintPlacement(original, { reference: "C1", xMm: 12, yMm: 12.825, rotationDeg: rotation });
      const drawings = fp(result.source).children.filter(node => node.name === "fp_line");
      expect(drawings.map(node => result.source.slice(node.start, node.end))).toEqual(reverse ? [upper, lower] : [lower, upper]);
      const rootAngle = rotation === 0 ? "" : ` ${rotation === 270 ? -90 : rotation}`;
      const expected = original.replace('(at 66 25)', `(at 12 12.825${rootAngle})`)
        .replace('(at 0 -2.3 0)', `(at 0 -2.3 ${rotation})`)
        .replace(`${lower}\r\n\t\t${upper}`, reverse ? `${upper}\r\n\t\t${lower}` : `${lower}\r\n\t\t${upper}`);
      expect(result.source).toBe(expected);
    });

  it.each(["fp_line", "fp_rect", "fp_circle", "fp_poly", "fp_curve", "fp_text"])(
    "orders %s by exact transformed world keys and preserves complete items at every cardinal angle", kind => {
      const positions = [[-2, -1], [-1, 2], [1, -2], [2, 1]];
      const originals = positions.map(([x, y], index) => {
        const geometry = kind === "fp_text" ? `user "T${index}" (at ${x} ${y} 0)`
          : kind === "fp_circle" ? `(center ${x} ${y}) (end ${x! + 1} ${y})`
          : kind === "fp_poly" ? `(pts (xy ${x} ${y}) (xy ${x! + 1} ${y}) (xy ${x} ${y! + 1}))`
          : kind === "fp_curve" ? `(pts (xy ${x} ${y}) (xy ${x! + 1} ${y}) (xy ${x! + 1} ${y! + 1}) (xy ${x} ${y! + 1}))`
          : `(start ${x} ${y}) (end ${x! + 1} ${y! + 1})`;
        return `(${kind} ${geometry} (layer "F.Fab") (uuid "${graphicId(index)}")${kind === "fp_text" ? ' (effects (font (size 1 1) (thickness .15)))' : ' (stroke (width .1) (type solid))'})`;
      });
      const cases = [[0, [0, 1, 2, 3]], [90, [2, 0, 3, 1]], [180, [3, 2, 1, 0]], [270, [1, 3, 0, 2]]] as const;
      for (const [rotation, order] of cases) {
        const result = planFreshFootprintPlacement(drawingBoard(originals.join("\n")), request(rotation));
        const items = fp(result.source).children.filter(node => node.name === kind);
        expect(items.map(nodeId)).toEqual(order.map(graphicId));
        expect(items.map(node => result.source.slice(node.start, node.end))).toEqual(order.map(index => kind === "fp_text"
          ? originals[index]!.replace(`(at ${positions[index]![0]} ${positions[index]![1]} 0)`, `(at ${positions[index]![0]} ${positions[index]![1]} ${rotation})`)
          : originals[index]));
        expect(planFreshFootprintPlacement(result.source, request(rotation)).source).toBe(result.source);
      }
    });

  it("keeps invariant native type/layer/shape groups in place", () => {
    const silk = `(fp_line (start 0 2) (end 1 2) (stroke (width .1)) (layer "F.SilkS") (uuid "${graphicId(1)}"))`;
    const fab = `(fp_line (start 0 -2) (end 1 -2) (stroke (width .1)) (layer "F.Fab") (uuid "${graphicId(2)}"))`;
    const circle = `(fp_circle (center 0 0) (end 1 0) (stroke (width .1)) (layer "F.Fab") (uuid "${graphicId(3)}"))`;
    const result = planFreshFootprintPlacement(drawingBoard([silk, fab, circle].join("\n")), request(270));
    expect(fp(result.source).children.filter(node => node.name.startsWith("fp_")).map(nodeId)).toEqual([1, 2, 3].map(graphicId));
  });

  it("retains exact slots while merging moved/stationary text angles and interleaved child edits", () => {
    const text = (id: number, x: number, angle: number) => `(fp_text user "T${id}" (at ${x} 0 ${angle}) (layer "F.Fab") (uuid "${graphicId(id)}"))`;
    const line = `(fp_line (start 0 0) (end 1 1) (stroke (width .1)) (layer "F.SilkS") (uuid "${graphicId(4)}"))`;
    const source = `(kicad_pcb (footprint "Test:Mixed" (layer "F.Cu") (uuid "${ID}") (at 10 20)
      (property "Reference" "U1" (at 0 0 0))
      ${text(1, -1, 0)}\t\t(property "Value" "V" (at 0 2 0))
      ${text(2, 0, 0)}\r\n\t(pad "1" smd rect (at 1 1) (size 1 1) (layers "F.Cu"))
      ${line}\n\t  ${text(3, 1, 0)}))`;
    const expected = `(kicad_pcb (footprint "Test:Mixed" (layer "F.Cu") (uuid "${ID}") (at 10 20 180)
      (property "Reference" "U1" (at 0 0 180))
      ${text(3, 1, 180)}\t\t(property "Value" "V" (at 0 2 180))
      ${text(2, 0, 180)}\r\n\t(pad "1" smd rect (at 1 1 180) (size 1 1) (layers "F.Cu"))
      ${line}\n\t  ${text(1, -1, 180)}))`;
    expect(planFreshFootprintPlacement(source, { reference: "U1", xMm: 10, yMm: 20, rotationDeg: 180 }).source).toBe(expected);
  });

  it("uses polygon vertex count before transformed vertices and UUID after identical stroke geometry", () => {
    const polygon = (id: number, points: string) => `(fp_poly (pts ${points}) (stroke (width .1)) (layer "F.Fab") (uuid "${graphicId(id)}"))`;
    const line = (id: number) => `(fp_line (start 0 0) (end 1 1) (stroke (width .1)) (layer "F.Fab") (uuid "${graphicId(id)}"))`;
    const result = planFreshFootprintPlacement(drawingBoard([line(4), line(3), polygon(2, '(xy 0 0) (xy 1 0) (xy 1 1) (xy 0 1)'),
      polygon(1, '(xy 10 10) (xy 11 10) (xy 11 11)')].join("\n")), request(90));
    expect(fp(result.source).children.filter(node => node.name.startsWith("fp_")).map(nodeId)).toEqual([3, 4, 1, 2].map(graphicId));
  });

  it("sorts text using changed absolute angles, native width/height order and literal ASCII text", () => {
    const text = (id: number, angle: number, size: string, label: string) => `(fp_text user "${label}" (at 0 0 ${angle})
      (layer "F.Fab") (uuid "${graphicId(id)}") (effects (font (size ${size}) (thickness .15))))`;
    const result = planFreshFootprintPlacement(drawingBoard([text(1, 0, "1 2", "A"), text(2, 0, "2 1", "B"),
      text(3, 0, "2 1", "A"), text(4, 270, "1 1", "Z")].join("\n")), request(90));
    const items = fp(result.source).children.filter(node => node.name === "fp_text");
    expect(items.map(nodeId)).toEqual([4, 3, 2, 1].map(graphicId));
    expect(items.map(node => Number(at(node).values[2]!.value))).toEqual([0, 90, 90, 90]);
  });

  it.each([
    ['arc winding/center', '(fp_arc (start 0 0) (mid 1 1) (end 2 0)', '(fp_arc (start 2 2) (mid 3 3) (end 4 2)'],
    ['native polygon vertex suppression', '(fp_poly (pts (xy 0 0) (xy 0 0) (xy 1 1))', '(fp_poly (pts (xy 2 2) (xy 3 2) (xy 3 3))'],
    ['missing UUID on complete key tie', '(fp_line (start 0 0) (end 1 1)', '(fp_line (start 0 0) (end 1 1)'],
  ])("rejects uncharacterized %s sort keys", (_label, first, second) => {
    const drawings = [first, second].map(item => `${item} (stroke (width .1)) (layer "F.Fab"))`).join("\n");
    expect(() => planFreshFootprintPlacement(drawingBoard(drawings), request(90))).toThrow(/ordering/u);
  });

  it.each(["constructor", "__proto__", "toString", "F.Uncharacterized"])("rejects unknown graphic layer %s without object-prototype fallback", layer => {
    const drawings = [0, 1].map(index => `(fp_line (start ${index} 0) (end ${index + 1} 1)
      (stroke (width .1)) (layer "${layer}") (uuid "${graphicId(index)}"))`).join("\n");
    expect(() => planFreshFootprintPlacement(drawingBoard(drawings), request(90))).toThrow(/characterized KiCad 10 layer/u);
  });

  it("binds transformed physical pad anchors to exact cardinal geometry", () => {
    const cases = [
      [0, 21.112501, -24.650001], [90, 21.350001, -23.112501],
      [180, 22.887501, -23.350001], [270, 22.650001, -24.887501],
    ];
    for (const [rotation, x, y] of cases) {
      const result = planFreshFootprintPlacement(board(), request(rotation!));
      const pad = parseFreshPcbSource(result.source).footprints[0]!.pads.find(pad => pad.number === "1")!;
      // Projection arithmetic is a separate existing mm API; compare native nm.
      expect(Math.round(pad.at.x * 1e6)).toBe(Math.round(x! * 1e6));
      expect(Math.round(pad.at.y * 1e6)).toBe(Math.round(y! * 1e6));
      expect(pad.physical.relativeAt).toEqual({ x: -0.8875, y: -0.65 });
    }
  });

  it("retains exact source on semantic no-op, including exponent spelling and angle aliases", () => {
    const source = board(footprint.replace("(at 10.000000 2e1)", "(at 10.000000 2e1 -90)"));
    const result = planFreshFootprintPlacement(source, { reference: "U1", xMm: 10, yMm: 20, rotationDeg: 270 });
    expect(result.source).toBe(source);
    expect(result.changed).toBe(false);
    expect(result.before.rotationDeg).toBe(270);
  });

  it("uses the old root pose and source absolute angles instead of stock angles", () => {
    const source = board(footprint.replace("(at 10.000000 2e1)", "(at 10.000000 2e1 -90)"));
    const result = planFreshFootprintPlacement(source, request(0));
    expect(result.source).toContain("(at 22.000001 -24.000001 )");
    expect(result.source).toContain('(property "Reference" "U1" (at 0 -1.95 90)');
    expect(result.source).toContain('(at -0.8875 0 180)');
    expect(result.source).toContain('(at -0.8875 0.65 )');
    expect(invariantBytes(result.source)).toBe(invariantBytes(source));
  });

  it("emits native root signed orientation and omits changed zero pad angles", () => {
    const result = planFreshFootprintPlacement(board(), request(270));
    expect(result.after.rotationDeg).toBe(270);
    expect(result.source).toContain('(at 22.000001 -24.000001 -90)');
    expect(result.source).toContain('(at -0.8875 -0.65 270)');
    expect(result.source).toContain('(at -0.8875 0 )');
    expect(result.source).toContain('(property "KiLib_Generator" "package/no_lead" (at 0 0 0)');
    expect(result.source).toContain('(fp_text user "${REFERENCE}" (at 0 0 180)');
  });

  it("preserves every trivia and legacy modifier byte when replacing and deleting angle atoms", () => {
    const original = `(kicad_pcb\r\n (footprint "Test:Trivia" (layer "F.Cu") (uuid "${ID}")
      (at \t1  2 \t-90  \t)
      (property "Reference" "U1" (at  0 \t-1  -90\t ))
      (pad "1" smd rect (at\t0  0 \t-90 \t) (size 1 1) (layers "F.Cu"))
      (fp_text user "literal" (at 0\t0 -90 \tunlocked\t))))\r\n`;
    const expected = `(kicad_pcb\r\n (footprint "Test:Trivia" (layer "F.Cu") (uuid "${ID}")
      (at \t3.000001  4.000002 \t  \t)
      (property "Reference" "U1" (at  0 \t-1  0\t ))
      (pad "1" smd rect (at\t0  0 \t \t) (size 1 1) (layers "F.Cu"))
      (fp_text user "literal" (at 0\t0 0 \tunlocked\t))))\r\n`;
    expect(planFreshFootprintPlacement(original, { reference: "U1", xMm: 3.000001, yMm: 4.000002, rotationDeg: 0 }).source)
      .toBe(expected);
  });

  it("inserts only missing angle tokens before original suffix trivia and legacy unlocked", () => {
    const original = `(kicad_pcb (footprint "Test:Trivia" (layer "F.Cu") (uuid "${ID}")
      (at \t1  2 \t)
      (property "Reference" "U1" (at  0 \t-1\t ))
      (pad "1" smd rect (at\t0  0 \t) (size 1 1) (layers "F.Cu"))
      (fp_text user "literal" (at 0\t0 \tunlocked\t))))`;
    const expected = `(kicad_pcb (footprint "Test:Trivia" (layer "F.Cu") (uuid "${ID}")
      (at \t1  2 -90 \t)
      (property "Reference" "U1" (at  0 \t-1 270\t ))
      (pad "1" smd rect (at\t0  0 270 \t) (size 1 1) (layers "F.Cu"))
      (fp_text user "literal" (at 0\t0 270 \tunlocked\t))))`;
    expect(planFreshFootprintPlacement(original, { reference: "U1", xMm: 1, yMm: 2, rotationDeg: 270 }).source)
      .toBe(expected);
  });

  it("preserves through-drill and custom pad geometry, layers and relative offset", () => {
    const source = board(footprint.replace('(pad "7" smd roundrect', '(pad "7" thru_hole custom')
      .replace('(size 1 1.6)', '(size 1 1.6) (drill oval 0.3 0.5 (offset 0.1 -0.2)) (primitives (gr_line (start 0 0) (end .5 .5) (width .1)))'));
    const result = planFreshFootprintPlacement(source, request(180));
    expect(invariantBytes(result.source)).toBe(invariantBytes(source));
    expect(result.source).toContain('(drill oval 0.3 0.5 (offset 0.1 -0.2))');
  });

  it.each(["(at 0 0 unlocked)", "(at 0 0 -90 unlocked)"])("preserves the legacy text unlocked modifier %s", legacy => {
    const source = board(footprint.replace('(at 0 0 -90) (unlocked yes)', legacy));
    const result = planFreshFootprintPlacement(source, request(90));
    expect(result.source).toContain(legacy.includes("-90") ? "(at 0 0 0 unlocked)" : "(at 0 0 90 unlocked)");
    expect(result.source).toContain("(justify left top)");
  });

  it.each([
    ["duplicate reference", source => board(footprint, footprint.replace(ID, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))],
    ["missing reference", source => source.replace('"U1"', '"U2"')],
    ["duplicate root at", source => source.replace("(at 10.000000 2e1)", "(at 10 20) (at 10 20)")],
    ["duplicate Reference field", source => source.replace('(attr smd)', '(property "Reference" "U1" (at 0 0)) (attr smd)')],
    ["duplicate Value field", source => source.replace('(attr smd)', '(property "Value" "WSON" (at 0 0)) (attr smd)')],
    ["duplicate pad field", source => source.replace('(at -0.8875 -0.65)', '(at -0.8875 -0.65) (at 0 0)')],
    ["unknown pad type", source => source.replace('(pad "1" smd roundrect', '(pad "1" future_type roundrect')],
    ["unknown pad shape", source => source.replace('(pad "1" smd roundrect', '(pad "1" smd future_shape')],
    ["quoted pad type", source => source.replace('(pad "1" smd roundrect', '(pad "1" "smd" roundrect')],
    ["quoted pad shape", source => source.replace('(pad "1" smd roundrect', '(pad "1" smd "roundrect"')],
    ["duplicate graphic point", source => source.replace('(start -1.33 -1.1)', '(start -1.33 -1.1) (start 0 0)')],
    ["unexpected graphic point kind", source => source.replace('(start -1.33 -1.1)', '(start -1.33 -1.1) (mid 0 0)')],
    ["duplicate UUID", source => source.replace('22222222-2222-4222-8222-000000000000', ID)],
    ["missing UUID", source => source.replace(`(uuid "${ID}")`, "")],
    ["back side", source => source.replace('(layer "F.Cu")', '(layer "B.Cu")')],
    ["mirror", source => source.replace('(justify left top)', '(justify left top mirror)')],
    ["zone", source => source.replace('(attr smd)', '(zone (polygon (pts (xy 0 0) (xy 1 1)))) (attr smd)')],
    ["text box", source => source.replace('(attr smd)', '(fp_text_box "x" (start 0 0) (end 1 1)) (attr smd)')],
    ["render cache", source => source.replace('(justify left top)', '(render_cache "x" 0 (polygon (pts (xy 0 0)))) (justify left top)')],
    ["unknown geometry", source => source.replace('(future_metadata (supplier "preserve this exact raw data"))', '(future_geometry (at 0 0 0))')],
    ["unknown flat numeric geometry", source => source.replace('(future_metadata (supplier "preserve this exact raw data"))', '(future_geometry 1 2 90)')],
    ["unknown numeric metadata subtree", source => source.replace('(future_metadata (supplier "preserve this exact raw data"))', '(future_geometry (size 1 2))')],
    ["misplaced known geometry", source => source.replace('(future_metadata (supplier "preserve this exact raw data"))', '(size 1 2)')],
    ["unknown nested text pose", source => source.replace('(justify left top)', '(future (at 0 0)) (justify left top)')],
    ["unsupported custom pad text", source => source.replace('(size 1 1.6)', '(size 1 1.6) (primitives (gr_text "x" (at 0 0)))')],
    ["conflicting unlocked", source => source.replace('(at 0 0 -90) (unlocked yes)', '(at 0 0 -90 unlocked) (unlocked yes)')],
    ["non-cardinal old root", source => source.replace('(at 10.000000 2e1)', '(at 10 20 45)')],
    ["non-cardinal old text", source => source.replace('(at 0 -1.95 0)', '(at 0 -1.95 1)')],
    ["sub-nm old root", source => source.replace('(at 10.000000 2e1)', '(at 10.0000001 20)')],
    ["sub-nm local pad", source => source.replace('(at -0.8875 -0.65)', '(at -0.8875001 -0.65)')],
    ["sub-nm local graphic", source => source.replace('(xy -1 -1)', '(xy -1.0000001 -1)')],
    ["sub-nm drill offset", source => source.replace('(size 1 1.6)', '(size 1 1.6) (drill .5 (offset .0000001 0))')],
    ["quoted coordinate", source => source.replace('(at 10.000000 2e1)', '(at "10" 20)')],
    ["adjacent quoted atoms", source => source.replace('"Reference" "U1"', '"Reference""U1"')],
    ["interleaved property header", source => source.replace('"Reference" "U1" (at 0 -1.95 0)', '"Reference" (at 0 -1.95 0) "U1"')],
    ["interleaved pad header", source => source.replace('"1" smd roundrect\n    (at -0.8875 -0.65)', '"1" smd (at -0.8875 -0.65) roundrect')],
    ["embedded bare quote", source => source.replace('(at 10.000000 2e1)', '(at 10.000000"x" 2e1)')],
    ["unsupported physical whitespace", source => source.replace('(at 10.000000 2e1)', '(at 10.000000\u00a02e1)')],
    ["malformed source", source => source.slice(0, -4)],
  ] satisfies [string, (source: string) => string][])("rejects %s without yielding a mutation", (_name, mutate) => {
    expect(() => planFreshFootprintPlacement(mutate(board()), request())).toThrow();
  });

  it.each([0.0000001, 22.000000000000004, 2000.000001, Infinity, NaN])("rejects requested coordinate precision/bound %s", xMm => {
    expect(() => planFreshFootprintPlacement(board(), { ...request(), xMm })).toThrow();
  });
  it.each([45, 90.00000000000001, 450, NaN, Infinity])("rejects unsupported requested angle %s", rotationDeg => {
    expect(() => planFreshFootprintPlacement(board(), request(rotationDeg))).toThrow();
  });
  it("rejects a target whose root fits but a local child exceeds the coordinate bound", () => {
    expect(() => planFreshFootprintPlacement(board(), { ...request(0), xMm: 2000 })).toThrow(/child position/u);
  });
  it("enforces bounded source depth and selected footprint node inventory", () => {
    const deep = "(metadata ".repeat(257) + "value" + ")".repeat(257);
    expect(() => planFreshFootprintPlacement(board(footprint, deep), request())).toThrow(/nesting/u);
    const large = footprint.replace('(attr smd)', '(annotation "x")'.repeat(100_001));
    expect(() => planFreshFootprintPlacement(board(large), request())).toThrow(/node inventory/u);
  });
  it.each([
    '(primitives (gr_line (start 0 0) (end 2 0) (width .1)))',
    '(drill .5 (offset 2 0))',
  ])("bounds composed custom/drill positions through the absolute pad angle: %s", geometry => {
    const minimal = `(footprint "Test:Pad" (layer "F.Cu") (uuid "${ID}") (at 0 0)
      (property "Reference" "U1" (at 0 0))
      (pad "1" thru_hole custom (at 0 0 90) (size 1 1) (layers "*.Cu") ${geometry}))`;
    // Old pad90 plus root90 delta gives absolute pad180, so local +X points
    // beyond the negative board bound. Looking at pad anchors alone misses it.
    expect(() => planFreshFootprintPlacement(board(minimal), { reference: "U1", xMm: -1999.999999, yMm: 0, rotationDeg: 90 }))
      .toThrow(/child position/u);
  });
});
