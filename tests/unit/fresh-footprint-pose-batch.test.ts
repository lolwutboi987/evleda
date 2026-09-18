import { describe, expect, it } from "vitest";
import { parseFreshPcbSourceDocument } from "../../src/harness/fresh-kicad-parser.js";
import { planFreshFootprintPlacement } from "../../src/harness/fresh-footprint-placement.js";
import { FRESH_FOOTPRINT_POSE_BATCH_LIMITS, parseFreshFootprintPoses, planFreshFootprintPoses,
  type FreshFootprintPoseBatchContract } from "../../src/harness/fresh-footprint-pose-batch.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const footprint = (reference: string, n: number) => `(footprint "Test:Preserved" (layer "F.Cu") (at 10 20) (uuid "${id(n * 10)}")
  (property "Reference" "${reference}" (at 0 -2 0) (layer "F.SilkS") (effects (font (size 1 1))))
  (property "Value" "exact value" (at 0 2 0) (layer "F.Fab") (hide yes))
  (property "Vendor" "unrelated (at 4 5)" (at 0 0 90) (layer "F.Fab"))
  (fp_line (start -1 -1) (end 1 -1) (stroke (width .1) (type solid)) (layer "F.Fab"))
  (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu" "F.Mask") (net "N") (uuid "${id(n * 10 + 1)}"))
  (pad "1" smd rect (at 1 0 90) (size 1 1) (layers "F.Cu" "F.Mask") (net "N") (uuid "${id(n * 10 + 2)}"))
  (pad "" smd rect (at 0 0) (size .2 .2) (layers "F.Paste") (uuid "${id(n * 10 + 3)}"))
  (pad "" np_thru_hole circle (at 0 0) (size .65 .65) (drill .65) (layers "*.Cu" "*.Mask") (uuid "${id(n * 10 + 4)}"))
  (model "${"${KICAD10_3DMODEL_DIR}"}/exact.step" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0))))`;
const feature = `(footprint "MountingHole:Hole" (layer "F.Cu") (at 3 3) (uuid "${id(9000)}")
  (property "Reference" "H1" (at 0 0 0)) (attr board_only exclude_from_bom exclude_from_pos_files)
  (pad "" np_thru_hole circle (at 0 0) (size 1 1) (drill 1) (layers "*.Cu" "*.Mask") (uuid "${id(9001)}")))`;
const board = (count = 2) => `\n(kicad_pcb (version 20260206) (generator "pcbnew")
  (gr_text "outside" (at 1 2) (layer "F.SilkS"))
  ${Array.from({ length: count }, (_, n) => footprint(`R${n + 1}`, n + 1)).join("\n")}
  ${feature}
  (segment (start 1 1) (end 2 2) (width .5) (layer "F.Cu") (net "N") (uuid "${id(9999)}")))\n`;
const contract = (count = 2): FreshFootprintPoseBatchContract => ({
  components: Array.from({ length: count }, (_, n) => ({ reference: `R${n + 1}` })),
  placementConstraints: Array.from({ length: count }, (_, n) => ({ reference: `R${n + 1}`, side: "front", allowedRotationsDeg: [0, 90, 180, 270],
    regionMm: { minXmm: 1, minYmm: 1, maxXmm: 100, maxYmm: 100 } })),
});
const request = (reference = "R1", x_mm = 20, rotation_deg = 90) => ({ reference, x_mm, y_mm: 30, rotation_deg });
const maskPoses = (source: string) => {
  const spans = parseFreshPcbSourceDocument(source).children.filter(node => node.name === "footprint" && node.children.some(child => child.name === "property"
    && child.values[0]?.value === "Reference" && /^R/u.test(child.values[1]?.value ?? ""))).flatMap(node => node.children
      .filter(child => child.name === "at" || ["property", "pad"].includes(child.name))
      .map(child => child.name === "at" ? child : child.children.find(item => item.name === "at")!))
    .map(node => ({ start: node.start, end: node.end })).sort((a, b) => b.start - a.start);
  for (const span of spans) source = source.slice(0, span.start) + "POSE" + source.slice(span.end);
  return source;
};

describe("bounded preserving footprint pose batch", () => {
  it("composes two moves with exact unrelated fields, models, physical pads and board features", () => {
    const source = board().replaceAll("\n", "\r\n"), placements = [request(), request("R2", 40, 270)];
    const plan = planFreshFootprintPoses(source, { placements }, contract());
    expect(plan.placements).toHaveLength(2); expect(plan.changed).toBe(true);
    expect(plan.placements.map(p => [p.reference, p.footprintId, p.after])).toEqual([
      ["R1", id(10), { xMm: 20, yMm: 30, rotationDeg: 90 }], ["R2", id(20), { xMm: 40, yMm: 30, rotationDeg: 270 }],
    ]);
    expect(maskPoses(plan.source)).toBe(maskPoses(source));
    expect(plan.source).toContain(feature.replaceAll("\n", "\r\n"));
    expect(plan.placements.every(p => !("source" in p))).toBe(true);
    const sequential = placements.reduce((text, p) => planFreshFootprintPlacement(text, {
      reference: p.reference, xMm: p.x_mm, yMm: p.y_mm, rotationDeg: p.rotation_deg }).source, source);
    expect(plan.source).toBe(sequential);
    expect(planFreshFootprintPoses(plan.source, { placements }, contract())).toMatchObject({ changed: false, source: plan.source });
  });

  it("accepts64 distinct electrical placements without a phantom board-feature entry", () => {
    const placements = Array.from({ length: 64 }, (_, n) => request(`R${n + 1}`, n + 1, n % 4 * 90));
    const plan = planFreshFootprintPoses(board(64), { placements }, contract(64));
    expect(plan.placements).toHaveLength(64); expect(plan.source).toContain(feature);
    expect(plan.placements.every(placement => Object.isFrozen(placement))).toBe(true);
    expect(Object.isFrozen(plan.placements)).toBe(true);
    // Reserve room for the fixed marker/contract/source identities in the public
    // response; individual reference/pose fields are independently bounded.
    const worstCase = plan.placements.map(p => ({ ...p, reference: "R".repeat(32),
      before: { xMm: -1999.999999, yMm: -1999.999999, rotationDeg: 270 }, after: { xMm: 1999.999999, yMm: 1999.999999, rotationDeg: 270 } }));
    expect(Buffer.byteLength(JSON.stringify({ placements: worstCase }))).toBeLessThan(25_000);
  });

  it("retains exact source for all no-op poses and does not retain mutable request aliases", () => {
    const placements = [request("R1", 10, 0), request("R2", 10, 0)].map(p => ({ ...p, y_mm: 20 }));
    const source = board(), plan = planFreshFootprintPoses(source, { placements }, contract());
    placements[0]!.x_mm = 50;
    expect(plan).toMatchObject({ source, changed: false }); expect(plan.placements[0]!.after.xMm).toBe(10);
  });

  it.each([
    { placements: [] }, { placements: Array.from({ length: 65 }, (_, n) => request(`R${n + 1}`)) },
    { placements: [request(), request()] }, { placements: [request("H1")] }, { placements: [request("R9")] },
    { placements: [request(), request("R2", 100.000001)] }, { placements: [request("R1", .999999)] },
    { placements: [{ ...request(), rotation_deg: 45 }] }, { placements: [{ ...request(), rotation_deg: -90 }] },
    { placements: [{ ...request(), x_mm: .0000001 }] }, { placements: [{ ...request(), x_mm: Infinity }] },
    { placements: [{ ...request(), reference: "../R1" }] }, { placements: [{ ...request(), layer: "B.Cu" }] },
    { placements: [request()], source: board() }, { updates: [request()] },
  ])("rejects the complete invalid request before any pose plan is returned: %j", args => {
    expect(() => planFreshFootprintPoses(board(), args, contract())).toThrow();
  });

  it("enforces each host-bound front/cardinal constraint and exact region boundary", () => {
    const restricted = { ...contract(), placementConstraints: contract().placementConstraints.map(c => ({ ...c, allowedRotationsDeg: [0] })) };
    expect(() => parseFreshFootprintPoses({ placements: [request()] }, restricted)).toThrow(/contract/);
    expect(() => parseFreshFootprintPoses({ placements: [request()] }, { ...contract(), placementConstraints: contract().placementConstraints.map(c => ({ ...c, side: "back" })) })).toThrow(/contract/);
    expect(parseFreshFootprintPoses({ placements: [{ ...request("R1", 1, 0), y_mm: 100 }] }, contract())).toHaveLength(1);
  });

  it("rejects a later malformed physical footprint without exposing an earlier partial board", () => {
    const source = board().replace('(property "Reference" "R2"', '(property "Reference" "R2" (unknown (at 1 2))');
    expect(() => planFreshFootprintPoses(source, { placements: [request(), request("R2")] }, contract())).toThrow();
  });

  it("keeps the existing live-board byte bound", () => {
    const source = board(), oversized = source + " ".repeat(FRESH_FOOTPRINT_POSE_BATCH_LIMITS.maximumSourceBytes - Buffer.byteLength(source) + 1);
    expect(() => planFreshFootprintPoses(oversized, { placements: [request()] }, contract())).toThrow(/live-board domain/);
  });
});
