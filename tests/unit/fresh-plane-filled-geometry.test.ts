import { describe, expect, it } from "vitest";
import { assessFreshPlaneFilledGeometry, FRESH_PLANE_FILLED_GEOMETRY_LIMITS } from "../../src/harness/fresh-plane-filled-geometry.js";
import { parseFreshPcbReferenceGeometry, type FreshReferencePointNm, type FreshReferenceZone } from "../../src/harness/fresh-kicad-parser.js";

type Point = FreshReferencePointNm;
const Z = "22222222-2222-4222-8222-222222222222";
const points = (values: number[][]): Point[] => values.map(([x, y]) => ({ x: x!, y: y! }));
const outer = points([[0, 0], [100, 0], [100, 100], [0, 100]]);
const hole = points([[30, 70], [70, 70], [70, 30], [30, 30]]);
const fractured = points([[0, 0], [100, 0], [100, 100], [0, 100], [0, 70], [30, 70], [70, 70], [70, 30], [30, 30], [30, 70], [0, 70]]);
function mm(nm: number) {
  const value = BigInt(nm), magnitude = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${magnitude / 1_000_000n}.${String(magnitude % 1_000_000n).padStart(6, "0")}`;
}
function saved(chains: readonly (readonly Point[])[], layer = "B.Cu"): FreshReferenceZone {
  const pts = (chain: readonly Point[]) => `(pts ${chain.map(p => `(xy ${mm(p.x)} ${mm(p.y)})`).join(" ")})`;
  const innerLayers = layer === "In1.Cu" || layer === "In2.Cu" ? '(4 "In1.Cu" signal) (6 "In2.Cu" signal)' : '';
  const source = `(kicad_pcb (version 20260206) (layers (0 "F.Cu" signal) ${innerLayers} (2 "B.Cu" signal))
    (zone (net "GND") (layer "${layer}") (uuid "${Z}") (hatch edge 0.5) (connect_pads yes (clearance 0.3))
      (min_thickness 0.25) (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5)) (polygon ${pts(outer)})
      ${chains.map(chain => `(filled_polygon (layer "${layer}") ${pts(chain)})`).join(" ")}))`;
  return parseFreshPcbReferenceGeometry(source).zones[0]!;
}
function chain(nodes: readonly Point[]) {
  return { closed: true, nodes: nodes.map(p => ({ point: { ...(p.x ? { x_nm: String(p.x) } : {}), ...(p.y ? { y_nm: String(p.y) } : {}) } })) };
}
function native(polygons: readonly { outer: readonly Point[]; holes?: readonly (readonly Point[])[] }[], layer = "B.Cu") {
  const nativeLayer = `BL_${layer.replace(".", "_")}`;
  return { id: { value: Z }, type: "ZT_COPPER", layers: [nativeLayer], filled: true,
    filled_polygons: [{ layer: nativeLayer, shapes: { polygons: polygons.map(p => ({ outline: chain(p.outer), holes: (p.holes ?? []).map(chain) })) } }] };
}
const assess = (source: readonly (readonly Point[])[], polygons = source.map(outer => ({ outer }))) =>
  assessFreshPlaneFilledGeometry({ nativeZone: native(polygons), savedZone: saved(source), layer: "B.Cu" });
const shifted = (chain: readonly Point[], dx: number, dy = 0) => chain.map(p => ({ x: p.x + dx, y: p.y + dy }));
function expectUnverified(result: ReturnType<typeof assess>, issue?: RegExp) {
  expect(result.status).toBe("not_verified"); expect(result.geometryEquivalent).toBe(false);
  expect(result.issues.length).toBeGreaterThan(0); if (issue) expect(result.issues.join(" ")).toMatch(issue);
}

describe("bounded exact native/saved plane filled geometry", () => {
  it.each(["In1.Cu","In2.Cu"] as const)("retains exact %s source/native layer identity", layer => {
    const result = assessFreshPlaneFilledGeometry({ savedZone:saved([outer],layer), nativeZone:native([{outer}],layer), layer });
    expect(result.status).toBe("verified");
    expect(assessFreshPlaneFilledGeometry({ savedZone:saved([outer],layer), nativeZone:native([{outer}],"B.Cu"), layer }).status).toBe("not_verified");
  });
  it("unfractures a hole without counting its reverse bridge as copper", () => {
    const result = assess([fractured]);
    expect(result).toMatchObject({ status: "verified", geometryEquivalent: true, issues: [], components: [{ nativePolygonIndex: 0,
      areaTwiceNm2: "16800", topologyCertificate: "simple_outer_minus_strict_disjoint_holes" }] });
    expect(result.components[0]!.outer).toHaveLength(4); expect(result.components[0]!.holes).toHaveLength(1);
    expect(result.components[0]!.holes[0]).toHaveLength(4);
    expect(result.nativeGeometryIdentity).toEqual(result.sourceGeometryIdentity);
    expect(Object.isFrozen(result.components[0]!.outer[0])).toBe(true);
    expect(result).not.toHaveProperty("netConnected"); expect(result).not.toHaveProperty("fillFreshness");
  });

  it.each([false, true])("matches native explicit holes, reversed=%s, cyclic shifts and collinear splits", reverse => {
    const splitOuter = points([[0, 0], [50, 0], [100, 0], [100, 50], [100, 100], [0, 100]]);
    const reordered = [...splitOuter.slice(2), ...splitOuter.slice(0, 2)]; if (reverse) reordered.reverse();
    const result = assessFreshPlaneFilledGeometry({ savedZone: saved([fractured]), nativeZone: native([{ outer: reordered, holes: [[...hole].reverse()] }]), layer: "B.Cu" });
    expect(result.status).toBe("verified"); expect(result.nativeGeometryIdentity).toEqual(result.sourceGeometryIdentity);
  });

  it("normalizes a differently split exact reverse bridge before cancellation", () => {
    const split = [...fractured.slice(0, 5), { x: 10, y: 70 }, ...fractured.slice(5)];
    const shiftedStart = [...split.slice(4), ...split.slice(0, 4)].reverse();
    expect(assess([fractured], [{ outer: shiftedStart }]).status).toBe("verified");
  });

  it("matches the actual saved native positive probe's fractured point chain", () => {
    // Closed probe saved-after-refill.kicad_pcb, SHA256
    // b80cd79dcb08380c0ee504b085a97da5af8963db1f6f210e37d17c04a70ac809.
    // Offline replay of captured integer coordinates; no native program runs.
    const actual = points([[27943039, 2019685], [27988794, 2072489], [28000000, 2124000], [28000000, 17876000],
      [27980315, 17943039], [27927511, 17988794], [27876000, 18000000], [2124000, 18000000], [2056961, 17980315],
      [2011206, 17927511], [2000000, 17876000], [2000000, 12000000], [14000000, 12000000], [16000000, 12000000],
      [16000000, 8000000], [14000000, 8000000], [14000000, 12000000], [2000000, 12000000], [2000000, 2124000],
      [2019685, 2056961], [2072489, 2011206], [2124000, 2000000], [27876000, 2000000]]);
    const result = assess([actual], [{ outer: [...actual].reverse() }]);
    expect(result.status).toBe("verified"); expect(result.components).toHaveLength(1);
    expect(result.components[0]!.holes).toHaveLength(1);
    expect(result.components[0]!.areaTwiceNm2).toBe("815969044240724");
  });

  it("supports an inferred fractured hole alongside a disjoint explicit native hole", () => {
    const small = points([[5, 10], [10, 10], [10, 5], [5, 5]]);
    const both = [...fractured, ...points([[0, 10], [5, 10], [10, 10], [10, 5], [5, 5], [5, 10], [0, 10]])];
    const result = assessFreshPlaneFilledGeometry({ savedZone: saved([both]), nativeZone: native([{ outer: fractured, holes: [small] }]), layer: "B.Cu" });
    expect(result.status).toBe("verified"); expect(result.components[0]!.holes).toHaveLength(2);
    expect(result.components[0]!.areaTwiceNm2).toBe("16750");
  });

  it("accepts one repeated final closing point and proto3 zero omission", () => {
    expect(assess([outer], [{ outer: [...outer, outer[0]!] }]).status).toBe("verified");
    const raw = native([{ outer }]);
    expect(raw.filled_polygons[0]!.shapes.polygons[0]!.outline.nodes[0]).toEqual({ point: {} });
    expect(assessFreshPlaneFilledGeometry({ savedZone: saved([outer], "F.Cu"), nativeZone: native([{ outer }], "F.Cu"), layer: "F.Cu" }).status).toBe("verified");
  });

  it("preserves native polygon indexes after source polygon order changes", () => {
    const right = shifted(outer, 200);
    const result = assess([right, outer], [{ outer }, { outer: right }]);
    expect(result.status).toBe("verified"); expect(result.components.map(c => c.nativePolygonIndex)).toEqual([0, 1]);
    expect(result.components.map(c => c.areaTwiceNm2)).toEqual(["20000", "20000"]);
  });

  it("derives two separate open components even within one native fractured polygon", () => {
    const left = points([[0, 0], [10, 0], [10, 10], [0, 10]]), right = shifted(left, 20);
    const bridged = points([[0, 0], [10, 0], [20, 0], [30, 0], [30, 10], [20, 10], [20, 0], [10, 0], [10, 10], [0, 10]]);
    const result = assess([left, right], [{ outer: bridged }]);
    expect(result.status).toBe("verified"); expect(result.components.map(c => c.nativePolygonIndex)).toEqual([0, 0]);
    expect(result.components.map(c => c.areaTwiceNm2)).toEqual(["200", "200"]);
  });

  it("allows a floating island inside another polygon's hole without proving a net tie", () => {
    const island = points([[40, 40], [60, 40], [60, 60], [40, 60]]);
    const result = assessFreshPlaneFilledGeometry({ savedZone: saved([fractured, island]), nativeZone: native([{ outer, holes: [hole] }, { outer: island }]), layer: "B.Cu" });
    expect(result.status).toBe("verified"); expect(result.components).toHaveLength(2);
    expect(result.components.map(c => c.areaTwiceNm2)).toEqual(["16800", "800"]);
    expect(result).not.toHaveProperty("connected");
  });

  it("derives a nested island in a hole from one fractured native polygon", () => {
    const nested = points([[0, 0], [100, 0], [100, 100], [0, 100], [0, 70], [30, 70], [70, 70], [70, 30], [30, 30],
      [30, 40], [40, 40], [60, 40], [60, 60], [40, 60], [40, 40], [30, 40], [30, 70], [0, 70]]);
    const island = points([[40, 40], [60, 40], [60, 60], [40, 60]]);
    const result = assess([fractured, island], [{ outer: nested }]);
    expect(result.status).toBe("verified"); expect(result.components.map(c => c.nativePolygonIndex)).toEqual([0, 0]);
    expect(result.components.map(c => c.areaTwiceNm2)).toEqual(["16800", "800"]);
  });

  it("retains an exact half-square-nanometre area and areas above Number safe precision", () => {
    expect(assess([points([[0, 0], [1, 0], [0, 1]])]).components[0]!.areaTwiceNm2).toBe("1");
    const huge = points([[-2_000_000_000, -2_000_000_000], [2_000_000_000, -2_000_000_000], [2_000_000_000, 2_000_000_000], [-2_000_000_000, 2_000_000_000]]);
    expect(assess([huge]).components[0]!.areaTwiceNm2).toBe("32000000000000000000");
  });

  it.each([
    ["single point pinch", points([[0, 0], [10, 0], [10, 10], [20, 10], [20, 20], [10, 20], [10, 10], [0, 10]])],
    ["consecutive duplicate", points([[0, 0], [10, 0], [10, 0], [10, 10], [0, 10]])],
    ["repeated full contour", [...outer, ...outer]],
    ["partially overlapping edges", points([[0, 0], [100, 0], [100, 100], [20, 0], [80, 0], [0, 100]])],
    ["crossing edges", points([[0, 0], [100, 100], [0, 100], [80, 0]])],
    ["bridge-only spur", points([[0, 0], [100, 0], [100, 100], [0, 100], [-10, 100], [0, 100]])],
    ["zero area", points([[0, 0], [10, 0], [20, 0]])],
  ] as const)("rejects %s", (_name, chain) => expectUnverified(assess([chain])));

  it("rejects point-touching islands and overlapping native polygon interiors", () => {
    expectUnverified(assess([outer, shifted(outer, 100, 100)]), /touch|boundar/i);
    const inner = points([[30, 30], [70, 30], [70, 70], [30, 70]]);
    expectUnverified(assess([outer, inner]), /interiors overlap/i);
    expectUnverified(assess([outer], [{ outer }, { outer }]), /boundar/i);
  });

  it("rejects same-winding inferred holes instead of inventing subtraction", () => {
    const sameWinding = [...fractured.slice(0, 5), ...[hole[0]!, ...hole.slice(1).reverse(), hole[0]!], fractured.at(-1)!];
    expectUnverified(assess([sameWinding]), /same-direction winding/i);
  });

  it("does not erase geometrically crossing reverse bridges", () => {
    const crossing = points([[0, 0], [100, 0], [100, 100], [0, 100], [0, 90], [60, 20], [70, 20], [70, 10], [60, 10],
      [60, 20], [0, 90], [0, 10], [60, 80], [70, 80], [70, 70], [60, 70], [60, 80], [0, 10]]);
    expectUnverified(assess([crossing]), /bridges cross/i);
  });

  it("rejects two reverse bridges attaching the same pair of residual boundaries", () => {
    const doubleAttachment = points([[0, 0], [100, 0], [100, 100], [0, 100], [0, 70], [30, 70], [70, 70], [70, 30],
      [30, 30], [0, 30], [30, 30], [30, 70], [0, 70]]);
    expectUnverified(assess([doubleAttachment]), /graph contains a cycle|reconnects the same boundary/i);
  });

  it.each([
    ["outside", shifted(hole, 200)],
    ["tangent", points([[0, 30], [30, 30], [30, 70], [0, 70]])],
    ["crossing", points([[-10, 30], [30, 30], [30, 70], [-10, 70]])],
  ] as const)("rejects an explicit hole that is %s", (_name, invalidHole) => {
    expectUnverified(assessFreshPlaneFilledGeometry({ savedZone: saved([outer]), nativeZone: native([{ outer, holes: [invalidHole] }]), layer: "B.Cu" }));
  });

  it("rejects duplicate or nested explicit holes", () => {
    const inner = points([[40, 40], [60, 40], [60, 60], [40, 60]]);
    for (const holes of [[hole, hole], [hole, inner], [inner, hole]]) {
      expectUnverified(assessFreshPlaneFilledGeometry({ savedZone: saved([fractured]), nativeZone: native([{ outer, holes }]), layer: "B.Cu" }));
    }
  });

  it("rejects an explicit hole swallowing an already inferred fractured hole", () => {
    const enclosing = points([[20, 20], [80, 20], [80, 80], [20, 80]]);
    const result = assessFreshPlaneFilledGeometry({ savedZone: saved([fractured]), nativeZone: native([{ outer: fractured, holes: [enclosing] }]), layer: "B.Cu" });
    expectUnverified(result, /holes nest or swallow/i);
  });

  it("reports mismatched saved/native fill with distinct geometry identities", () => {
    const result = assess([outer], [{ outer: shifted(outer, 1) }]);
    expectUnverified(result, /boundaries.*differ/i);
    expect(result.sourceGeometryIdentity?.digest).not.toBe(result.nativeGeometryIdentity?.digest);
    expect(result.components).toHaveLength(1);
  });

  it.each([
    ["native arc", (raw: any) => { raw.filled_polygons[0].shapes.polygons[0].outline.nodes[0] = { arc: { start: {} } }; }],
    ["unknown node field", (raw: any) => { raw.filled_polygons[0].shapes.polygons[0].outline.nodes[0].radius = "1"; }],
    ["not closed", (raw: any) => { raw.filled_polygons[0].shapes.polygons[0].outline.closed = false; }],
    ["numeric coordinate", (raw: any) => { raw.filled_polygons[0].shapes.polygons[0].outline.nodes[0].point.x_nm = 0; }],
    ["noncanonical coordinate", (raw: any) => { raw.filled_polygons[0].shapes.polygons[0].outline.nodes[0].point.x_nm = "01"; }],
    ["coordinate overflow", (raw: any) => { raw.filled_polygons[0].shapes.polygons[0].outline.nodes[0].point.x_nm = "2000000001"; }],
    ["wrong UUID", (raw: any) => { raw.id.value = "33333333-3333-4333-8333-333333333333"; }],
    ["wrong layer", (raw: any) => { raw.filled_polygons[0].layer = "BL_F_Cu"; }],
    ["extra layer", (raw: any) => { raw.filled_polygons.push(raw.filled_polygons[0]); }],
    ["unfilled", (raw: any) => { raw.filled = false; }],
  ] as const)("returns explicit not_verified for %s", (_name, change) => {
    const raw = native([{ outer }]); change(raw);
    expectUnverified(assessFreshPlaneFilledGeometry({ savedZone: saved([outer]), nativeZone: raw, layer: "B.Cu" }));
  });

  it("rejects unsupported source contours and source coordinate bounds without silent dropping", () => {
    const source = structuredClone(saved([outer]));
    const unknown = { ...source, filledPolygons: [{ ...source.filledPolygons[0]!, status: "unsupported" as const }] };
    expectUnverified(assessFreshPlaneFilledGeometry({ savedZone: unknown, nativeZone: native([{ outer }]), layer: "B.Cu" }));
    expectUnverified(assess([shifted(outer, 2_000_000_000)]), /coordinate/i);
  });

  it("rejects aggregate vertex bounds before pairwise geometry work", () => {
    const source = saved([outer]);
    const long = Array.from({ length: 8193 }, (_, i) => ({ x: i, y: i % 2 }));
    const overLimit = { ...source, filledPolygons: [{ ...source.filledPolygons[0]!, contourGroup: [{ ...source.filledPolygons[0]!.contourGroup[0]!, pointsNm: long }] }] };
    expectUnverified(assessFreshPlaneFilledGeometry({ savedZone: overLimit, nativeZone: native([{ outer }]), layer: "B.Cu" }), /bound|array/i);
    expect(FRESH_PLANE_FILLED_GEOMETRY_LIMITS.aggregateVertices).toBe(8192);
  });

  it("verifies a large simple contour within the unchanged work budget", () => {
    // A simple parabola closed by its chord; many exact collinear-free vertices.
    const curve = Array.from({ length: 2200 }, (_, x) => ({ x, y: x * x }));
    const result = assess([curve]);
    expect(result.status).toBe("verified");
    expect(result.geometryEquivalent).toBe(true);
    expect(result.bounds.predicateOperations).toBeLessThan(FRESH_PLANE_FILLED_GEOMETRY_LIMITS.predicateOperations);
    expect(result.components[0]!.outer).toHaveLength(2200);
  });
  it("still terminates when overlapping broad-phase candidates exhaust the work bound", () => {
    const crossing = Array.from({ length: 7000 }, (_, i) => i % 2 ? { x: 1_000_000 - i, y: 1_000_000 + i } : { x: i, y: i });
    const result = assess([crossing]);
    expectUnverified(result, /work bound exhausted/i);
    expect(result.bounds.predicateOperations).toBe(FRESH_PLANE_FILLED_GEOMETRY_LIMITS.predicateOperations + 1);
  });
});
