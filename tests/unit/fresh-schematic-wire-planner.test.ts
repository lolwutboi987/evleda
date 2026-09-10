import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { contentIdentity } from "../../src/core/canonical.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle, createPcbPlaneCompilationBundleRef } from "../../src/harness/pcb-design-plane-bundle.js";
import { preparePlaneFreshProject } from "../../src/harness/fresh-project.js";
import { parseFreshSchematicSource } from "../../src/harness/fresh-kicad-parser.js";
import { normalizeFakeSchematicWriterSource } from "../helpers/normalizing-schematic-writer.js";
import { nativePadObservationFixture } from "../helpers/native-pad-observation-fixture.js";
import { createFreshConnectivityContract, type FreshConnectivityContract } from "../../src/harness/fresh-connectivity-contract.js";
import { closePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-contract.js";
import { FreshSchematicWorkBudget } from "../../src/harness/fresh-schematic-work-budget.js";
import { createKicadHarnessTools, KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES, inspectFreshConnectivityWirePlan, planFreshGlobalLabelTerminals, type KicadHarnessSession } from "../../src/harness/kicad-tools.js";
import { interfaceFixtureDraft } from "../../scripts/smoke-toolbox-interface-fixture.js";

type Point = { x: number; y: number };
type Pin = Point & { angleDeg: 0 | 90 | 180 | 270 };
type Box = { reference: string; minX: number; minY: number; maxX: number; maxY: number };
const grid = 1.27;
const rounded = (n: number) => Math.round(n * 10_000) / 10_000;
const draft = interfaceFixtureDraft();
const contract = createFreshConnectivityContract(closePcbPlaneDesignIntentDraft({ ...draft,
  components: draft.components.map(component => component.reference === "J1" ? { ...component, symbolLibId: "Connector:Conn_01x03_Pin" } : component),
}));

// KiCad stock local pins are (+5.08,+2.54/0/-2.54), angle 180 for
// Connector:Conn_01x03_Pin; Generic uses x=-5.08, angle 0. Screen y is inverted.
// The pinned sidecar _symbol_bbox_bounds supplies +/-10.16 by +/-7.62 mm;
// both stock graphical bodies lie inside those conservative source envelopes.
// These are source-derived planner inputs, not a native rendered-clearance claim.
const fixture = (rotation: 0 | 90 | 180 | 270 = 0, dx = 0, dy = 0) => {
  const transform = (point: Point): Point => {
    const x = rounded(point.x - 127), y = rounded(point.y - 101.6);
    const [rx, ry] = rotation === 0 ? [x, y] : rotation === 90 ? [-y, x] : rotation === 180 ? [-x, -y] : [y, -x];
    return { x: rounded(127 + rx! + dx), y: rounded(101.6 + ry! + dy) };
  };
  const pins = new Map<string, Pin>();
  for (const [reference, x, angle] of [["J1", 106.68, 180], ["J2", 147.32, 0]] as const) {
    for (const [index, y] of [99.06, 101.6, 104.14].entries()) pins.set(`${reference}:${index + 1}`,
      { ...transform({ x, y }), angleDeg: ((angle - rotation + 360) % 360) as Pin["angleDeg"] });
  }
  const boxes: Box[] = [101.6, 152.4].map((x, index) => {
    const corners = [-10.16, 10.16].flatMap(ox => [-7.62, 7.62].map(oy => transform({ x: x + ox, y: 101.6 + oy })));
    return { reference: `J${index + 1}`, minX: Math.min(...corners.map(p => p.x)), maxX: Math.max(...corners.map(p => p.x)),
      minY: Math.min(...corners.map(p => p.y)), maxY: Math.max(...corners.map(p => p.y)) };
  });
  return { pins, boxes };
};

function assertCompleteGeometry(c: FreshConnectivityContract, pins: Map<string, Pin>, boxes: Box[]) {
  const before = JSON.stringify({ c, pins: [...pins], boxes });
  const budget = new FreshSchematicWorkBudget();
  const plan = inspectFreshConnectivityWirePlan(c, pins, boxes, true, undefined, budget);
  expect(plan.issues).toEqual([]);
  expect(plan.routes).toHaveLength(c.nets.length);
  expect(plan.labels).toHaveLength(c.nets.length);
  expect(budget.snapshot().consumed).toBeLessThan(100_000);
  const onSegment = (point: Point, wire: typeof plan.wires[number]) =>
    Math.abs((point.x - wire.x) * (wire.endY - wire.y) - (point.y - wire.y) * (wire.endX - wire.x)) < 1e-7
    && point.x >= Math.min(wire.x, wire.endX) - 1e-7 && point.x <= Math.max(wire.x, wire.endX) + 1e-7
    && point.y >= Math.min(wire.y, wire.endY) - 1e-7 && point.y <= Math.max(wire.y, wire.endY) + 1e-7;
  for (const wire of plan.wires) {
    expect(wire.x === wire.endX || wire.y === wire.endY).toBe(true);
    for (const value of [wire.x, wire.y, wire.endX, wire.endY]) expect(value / grid).toBeCloseTo(Math.round(value / grid), 8);
    for (const label of plan.labels) {
      const b = label.bounds;
      const enters = wire.x === wire.endX
        ? wire.x > b.minX && wire.x < b.maxX && Math.max(Math.min(wire.y, wire.endY), b.minY) < Math.min(Math.max(wire.y, wire.endY), b.maxY)
        : wire.y > b.minY && wire.y < b.maxY && Math.max(Math.min(wire.x, wire.endX), b.minX) < Math.min(Math.max(wire.x, wire.endX), b.maxX);
      expect(enters).toBe(false);
    }
    for (const [id, pin] of pins) if (!wire.edgeEndpoints.includes(id)) expect(onSegment(pin, wire)).toBe(false);
  }
  for (const [index, wire] of plan.wires.entries()) for (const other of plan.wires.slice(index + 1)) {
    if (wire.net === other.net) continue;
    expect([wire, other].some((a, i, both) => {
      const b = both[1 - i]!;
      return [a, { x: a.endX, y: a.endY }].some(p => onSegment(p, b))
        || (a.x === a.endX && b.y === b.endY && onSegment({ x: a.x, y: b.y }, a) && onSegment({ x: a.x, y: b.y }, b));
    })).toBe(false);
  }
  for (const net of c.nets) {
    const wires = plan.wires.filter(wire => wire.net === net.name);
    const first = pins.get(`${net.endpoints[0]!.reference}:${net.endpoints[0]!.pin}`)!;
    const reached = new Set([`${first.x},${first.y}`]);
    for (let pass = 0; pass <= wires.length; pass += 1) for (const wire of wires) {
      const a = `${wire.x},${wire.y}`, b = `${wire.endX},${wire.endY}`;
      if (reached.has(a) || reached.has(b)) { reached.add(a); reached.add(b); }
    }
    for (const endpoint of net.endpoints) {
      const pin = pins.get(`${endpoint.reference}:${endpoint.pin}`)!;
      expect(reached.has(`${pin.x},${pin.y}`)).toBe(true);
    }
    const label = plan.labels.find(label => label.name === net.name)!;
    expect(reached.has(`${label.at.x},${label.at.y}`)).toBe(true);
  }
  expect(JSON.stringify({ c, pins: [...pins], boxes })).toBe(before);
  expect(inspectFreshConnectivityWirePlan(c, new Map([...pins].reverse()), [...boxes].reverse(), true)).toEqual(plan);
  return plan;
}

describe("bounded joint schematic label and wire planning", () => {
  it("routes the stock facing three-pin fixture with one passive global terminal and a complete wire tree per net", () => {
    const { pins, boxes } = fixture();
    const original = planFreshGlobalLabelTerminals(contract, pins, boxes);
    expect(original.labels.find(label => label.name === "DN")!.at).toEqual({ x: 113.03, y: 101.6 });
    const plan = assertCompleteGeometry(contract, pins, boxes);
    expect(plan.labels.find(label => label.name === "DN")!.at).toEqual({ x: 119.38, y: 101.6 });
    expect(plan.wireCount).toBe(16);
    expect(plan.wires.some(wire => wire.net === "DN" && wire.x === 124.46 && wire.endX === 124.46)).toBe(true);
  });

  it.each([[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]])("completes with net order %j,%j,%j", (...order) => {
    const { pins, boxes } = fixture();
    assertCompleteGeometry({ ...contract, nets: order.map(index => contract.nets[index]!) }, pins, boxes);
  });

  it.each([0, 90, 180, 270] as const)("routes translated and rotated geometry at %i degrees with different label names", rotation => {
    const { pins, boxes } = fixture(rotation, 10.16, 7.62);
    const renamed = { ...contract, nets: contract.nets.map((net, index) => ({ ...net, name: ["RETURN", "INPUT", "OUTPUT"][index]! })) };
    assertCompleteGeometry(renamed, pins, boxes);
  });

  it("retains the successful legacy label and five-segment outer route exactly", () => {
    const { pins, boxes } = fixture();
    const single = { ...contract, nets: [contract.nets.find(net => net.name === "DP")!] };
    const plan = inspectFreshConnectivityWirePlan(single, pins, boxes, true);
    expect(plan.issues).toEqual([]);
    expect(plan.labels).toEqual(planFreshGlobalLabelTerminals(single, pins, boxes).labels);
    expect(plan.wires.map(w => [w.x, w.y, w.endX, w.endY])).toEqual([
      [106.68, 99.06, 113.03, 99.06], [113.03, 99.06, 113.03, 92.71], [113.03, 92.71, 140.97, 92.71],
      [140.97, 92.71, 140.97, 99.06], [140.97, 99.06, 147.32, 99.06],
    ]);
  });

  it.each(["pin", "body"])("still refuses an unavoidable unrelated %s in an endpoint escape", kind => {
    const { pins, boxes } = fixture();
    if (kind === "pin") pins.set("X1:1", { x: 146.05, y: 101.6, angleDeg: 0 });
    else boxes.push({ reference: "X1", minX: 144.78, maxX: 146.05, minY: 100.33, maxY: 102.87 });
    const plan = inspectFreshConnectivityWirePlan(contract, pins, boxes, true);
    expect(plan.issues).toContainEqual(expect.objectContaining({ code: "NO_PROVEN_COLLISION_FREE_WIRE_PLAN", endpoints: ["J1:2", "J2:2"] }));
    expect(plan.routes).not.toContain("J1:2-J2:2");
  });

  it("retains structured label failure when first-endpoint geometry is unresolved", () => {
    const plan = inspectFreshConnectivityWirePlan(contract, new Map(), [], true);
    expect(plan.issues).toHaveLength(3);
    expect(plan.issues.every(issue => issue.code === "LABEL_PLANNING_SPACE_UNAVAILABLE")).toBe(true);
    expect(plan.wires).toEqual([]);
    expect(plan.labels).toEqual([]);
  });

  it("authors, saves, replays and repairs fields using the same fallback anchors through fake native ports", async () => {
    const stockIds = contract.components.map(component => component.symbolLibId);
    const dependencies = { deepRuleCatalog: loadDeepRuleCatalog(), libraryResolver: {
      resolveSymbol: (libraryId: string) => !stockIds.includes(libraryId) ? null : { libraryId, source: "kicad-stock" as const,
        unitCount: 1, componentKind: "connector" as const, polarized: false, pins: ["1", "2", "3"].map(number => ({ number, function: `Pin ${number}` })) },
      resolveFootprint: (libraryId: string) => libraryId !== contract.components[0]!.footprintLibId ? null : { libraryId,
        source: "kicad-stock" as const, packageKind: "generic" as const, pads: ["1", "2", "3"] },
    } };
    const compilation = compilePcbPlaneDesignIntentDraft({ ...draft,
      components: draft.components.map(component => ({ ...component, symbolLibId: contract.components.find(c => c.reference === component.reference)!.symbolLibId })),
    }, dependencies);
    if (compilation.disposition !== "ready") throw new Error(JSON.stringify(compilation.issues));
    const bundle = createPcbPlaneCompilationBundle({ originalPrompt: "Offline schematic planner/replay software test only.", compilation }, dependencies);
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-wire-replay-"));
    try {
      const project = await preparePlaneFreshProject({ outputDir: path.join(root, "output"), name: "replay", resume: false,
        compilationBundle: bundle, compilationBundleRef: createPcbPlaneCompilationBundleRef(bundle) });
      const { pins, boxes } = fixture();
      const centers = new Map([["J1", 101.6], ["J2", 152.4]]);
      const definitions = contract.components.map(component => {
        const leaf = component.symbolLibId.split(":")[1]!;
        const x = component.reference === "J1" ? 5.08 : -5.08, angle = component.reference === "J1" ? 180 : 0;
        return `(symbol "${component.symbolLibId}" (symbol "${leaf}_1_1" ${[2.54, 0, -2.54].map((y, index) =>
          `(pin passive line (at ${x} ${y} ${angle}) (length 3.81) (name "Pin_${index + 1}") (number "${index + 1}"))`).join(" ")}))`;
      });
      const source = `(kicad_sch (version 20250114) (lib_symbols ${definitions.join(" ")}) ${contract.components.map(component =>
        `(symbol (lib_id "${component.symbolLibId}") (at ${centers.get(component.reference)} 101.6 0) (unit 1)
          (property "Reference" "${component.reference}" (at ${centers.get(component.reference)} 96.52 0) (effects (font (size 1.27 1.27))))
          (property "Value" "${component.value}" (at ${centers.get(component.reference)} 106.68 0) (effects (font (size 1.27 1.27))))
          (property "Footprint" "${component.footprintLibId}"))`).join(" ")})`;
      await writeFile(project.schematicPath, source, "utf8");
      const pcbSource = await readFile(project.pcbPath, "utf8");
      const uuid = (n: number) => `aaaaaaaa-aaaa-aaaa-aaaa-${String(n).padStart(12, "0")}`;
      const physicalBoard = pcbSource.slice(0, pcbSource.lastIndexOf(")")) + contract.components.map((c, index) =>
        `(footprint "${c.footprintLibId}" (uuid "${uuid(index + 1)}") (layer "F.Cu") (at ${5 + index * 20} 10 0)
          (property "Reference" "${c.reference}") (property "Value" "${c.value}") ${["DP", "DN", "GND"].map((net, pin) =>
            `(pad "${pin + 1}" smd rect (uuid "${uuid(100 + index * 10 + pin)}") (at ${pin * 2} 0) (size 1 1) (layers "F.Cu") (net "${net}"))`).join(" ")})`).join(" ") + ")";
      const physical = await nativePadObservationFixture(physicalBoard);
      const labels: Record<string, unknown>[] = [];
      let applied = false;
      const session: KicadHarnessSession = {
        listTools: () => KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES.map(name => ({ name, permission: "write", inputSchema: { type: "object" } })),
        assertActivePcb: async () => undefined, readActivePcbSource: async () => pcbSource,
        readLivePcbPadSnapshot: async () => { throw new Error("Schematic replay must not request native PCB pads"); },
        callTool: async (name, args = {}) => {
          let result = "ok";
          if (name === "sch_get_symbols") result = contract.components.map(c => `- ${c.reference} ${c.value} ${c.symbolLibId} @ (${centers.get(c.reference)}, 101.6) rot=0 unit=1 footprint=${c.footprintLibId}`).join("\n");
          if (name === "sch_get_bounding_boxes") result = `Schematic bounding boxes (2 symbols):\nRef Value X Y X_min Y_min X_max Y_max\n--------------------\n${boxes.map(box => `${box.reference} value ${centers.get(box.reference)} 101.6 ${box.minX} ${box.minY} ${box.maxX} ${box.maxY}`).join("\n")}\n\nSheet occupied region: X=[91.44, 162.56] Y=[93.98, 109.22] mm`;
          if (name === "sch_get_pin_positions") result = [...pins].filter(([id]) => id.startsWith(args.library === "Connector" ? "J1:" : "J2:")).map(([id, pin]) => `- Pin ${id.split(":")[1]}: (${pin.x}, ${pin.y}) mm`).join("\n");
          if (name === "sch_get_connectivity_graph") result = applied ? contract.nets.map((net, i) => `Group ${i + 1}: ${net.name} | pins=${net.endpoints.map(e => `${e.reference}:${e.pin}`).join(", ")}`).join("\n")
            : [...pins].map(([id], i) => `Group ${i + 1}: ~unnamed | pins=${id}`).join("\n");
          if (["sch_add_wire", "sch_add_labels", "sch_add_missing_junctions", "sch_autoplace_fields"].includes(name)) {
            let current = await readFile(project.schematicPath, "utf8");
            const add = (form: string) => { current = `${current.slice(0, current.lastIndexOf(")"))}\n${form}\n)`; };
            if (name === "sch_add_wire") add(`(wire (pts (xy ${args.x1_mm} ${args.y1_mm}) (xy ${args.x2_mm} ${args.y2_mm})))`);
            if (name === "sch_add_labels") for (const label of args.labels as Record<string, unknown>[]) {
              labels.push(label);
              add(`(global_label "${label.name}" (shape ${label.shape}) (at ${label.x_mm} ${label.y_mm} ${label.rotation}) (effects (font (size 1.524 1.524)) (justify ${label.justify})))`);
            }
            if (name === "sch_add_missing_junctions") applied = true;
            if (name === "sch_autoplace_fields") {
              current = current.replace("(at 101.6 106.68 0)", "(at 100.33 107.95 0)");
              result = "Auto-placed Reference/Value fields on 1 symbol(s): J1.";
            }
            await writeFile(project.schematicPath, normalizeFakeSchematicWriterSource(current), "utf8");
          }
          if (name === "run_erc") return { content: [], structuredContent: { status: "clean", findings: [], metadata: { violation_count: 0 } } };
          if (name === "pcb_save") result = "Board saved.";
          return { content: [], structuredContent: { result } };
        },
      };
      const native = `(export (components ${contract.components.map(c => `(comp (ref "${c.reference}") (value "${c.value}") (footprint "${c.footprintLibId}") (libsource (lib "${c.symbolLibId.split(":")[0]}") (part "${c.symbolLibId.split(":")[1]}")))`).join(" ")})
        (nets ${contract.nets.map((net, i) => `(net (code "${i + 1}") (name "${net.name}") ${net.endpoints.map(e => `(node (ref "${e.reference}") (pin "${e.pin}") (pintype "passive"))`).join(" ")})`).join(" ")}))`;
      const bridge = createKicadHarnessTools(session, { freshProject: project, freshConnectivityContract: bundle.contract, freshPlaneCompilationBundle: bundle,
        freshPhysicalFootprintResolver: physical.expected.physicalFootprintResolver!, freshPhysicalFootprintSourcePins: physical.expected.physicalFootprints!,
        captureFreshNativeNetlist: async () => native, capturePersistedMutationBaseline: async () => contentIdentity(await readFile(project.pcbPath)).digest,
        verifyPersistedMutation: async () => true });
      const apply = JSON.parse((await bridge.execute({ id: "apply", name: "fresh_apply_contract_connectivity", arguments: {} })).content);
      expect(apply).toMatchObject({ applied: true, mutated: true, issues: [] });
      expect(labels.find(label => label.name === "DN")).toMatchObject({ x_mm: 119.38, y_mm: 101.6, kind: "global", shape: "passive" });
      await bridge.internal.saveAfterMutation({ id: "save", name: "pcb_save", arguments: {} });
      const replay = JSON.parse((await bridge.execute({ id: "replay", name: "fresh_apply_contract_connectivity", arguments: {} })).content);
      expect(replay).toMatchObject({ applied: true, mutated: false, idempotent: true, issues: [] });
      const before = parseFreshSchematicSource(await readFile(project.schematicPath, "utf8"));
      const fields = JSON.parse((await bridge.execute({ id: "fields", name: "fresh_autoplace_schematic_fields", arguments: {} })).content);
      expect(fields).toMatchObject({ applied: true, mutated: true, movedFieldCount: 1 });
      await bridge.internal.saveAfterMutation({ id: "field-save", name: "pcb_save", arguments: {} });
      const after = parseFreshSchematicSource(await readFile(project.schematicPath, "utf8"));
      expect(after.labels).toEqual(before.labels);
      expect(after.wires).toEqual(before.wires);
    } finally {
      const resolved = await realpath(root);
      if (path.dirname(resolved) !== await realpath(os.tmpdir()) || !path.basename(resolved).startsWith("evleda-wire-replay-")) throw new Error("Unexpected owned test directory");
      await rm(resolved, { recursive: true, force: true });
    }
  });

  it("shares and exhausts the original budget across fallback attempts without publishing a wire plan", () => {
    const { pins, boxes } = fixture();
    const completeBudget = new FreshSchematicWorkBudget();
    expect(inspectFreshConnectivityWirePlan(contract, pins, boxes, true, undefined, completeBudget).issues).toEqual([]);
    for (const maximum of [20_000, completeBudget.snapshot().consumed - 1]) {
      const budget = new FreshSchematicWorkBudget(maximum);
      const plan = inspectFreshConnectivityWirePlan(contract, pins, boxes, true, undefined, budget);
      expect(budget.snapshot()).toMatchObject({ status: "exhausted", consumed: maximum });
      expect(plan.issues).toContainEqual(expect.objectContaining({ code: "PLANNING_WORK_LIMIT" }));
      expect(plan.wires).toEqual([]);
      expect(plan.routes).toEqual([]);
    }
  });
});
