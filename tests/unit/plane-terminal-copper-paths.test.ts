import { describe, expect, it } from "vitest";
import { findTerminalCopperPaths, type TerminalCopperPathInput } from "../../src/harness/plane-terminal-copper-paths.js";
import type { FreshPlaneFilledComponent } from "../../src/harness/fresh-plane-filled-geometry.js";

const region = (x0 = 400, y0 = 0, x1 = 800, y1 = 400): FreshPlaneFilledComponent => ({
  nativePolygonIndex: 0, outer: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
  holes: [], areaTwiceNm2: String(2 * (x1 - x0) * (y1 - y0)), topologyCertificate: "simple_outer_minus_strict_disjoint_holes",
});
function fixture(): TerminalCopperPathInput {
  return { boardBoundsNm: { minX: 0, minY: 0, maxX: 2000, maxY: 2000 }, pads: [{ uuid: "pad", reference: "U1", pin: "GND", centerNm: { x: 100, y: 100 }, layers: ["F.Cu"], platedThrough: false,
    shape: "rectangle", sizeNm: { x: 100, y: 100 }, cornerRadiusNm: 0 }],
  vias: [{ uuid: "via", centerNm: { x: 500, y: 100 }, diameterNm: 120, drillNm: 40, layers: ["F.Cu", "In1.Cu", "B.Cu"] }],
  tracks: [{ uuid: "track", startNm: { x: 100, y: 100 }, endNm: { x: 500, y: 100 }, widthNm: 80, layer: "F.Cu" }],
  bores: [{ uuid: "via", centerNm: { x: 500, y: 100 }, diameterNm: 40 }],
  planes: [{ id: "GROUND", layer: "In1.Cu", component: region() }], targetPlaneId: "GROUND" };
}
describe("positive-width terminal copper paths", () => {
  it("connects a surface pad through a real track, intact via annulus and inner plane", () => {
    const result = findTerminalCopperPaths(fixture());
    expect(result.allTerminalsWitnessed).toBe(true);
    expect(result.terminals[0]!.path).toContain("via:via");
    expect(result.terminals[0]!.path.at(-1)).toBe("plane:GROUND:0");
    expect(result.witnessLinks.some(l => l.kind === "clear-track-capsule")).toBe(true);
    expect(result.witnessPorts.every(p => p.radiusNm > 0)).toBe(true);
    expect(result.currentCapacityClaimed).toBe(false);
    expect(result.fabricationAuthorized).toBe(false);
  });
  it("does not connect equal coordinates on different layers without plated copper", () => {
    const f = fixture();
    expect(findTerminalCopperPaths({ ...f, vias: [], bores: [] }).allTerminalsWitnessed).toBe(false);
  });
  it("rejects a bore cutting the only trace corridor", () => {
    const f = fixture();
    const result = findTerminalCopperPaths({ ...f, bores: [...f.bores, { uuid: "cut", centerNm: { x: 300, y: 100 }, diameterNm: 120 }] });
    expect(result.allTerminalsWitnessed).toBe(false);
    expect(result.terminals[0]!.path).toEqual([]);
  });
  it("withholds an annulus exactly touched by another bore", () => {
    const f = fixture();
    const result = findTerminalCopperPaths({ ...f, bores: [...f.bores, { uuid: "foreign", centerNm: { x: 500, y: 180 }, diameterNm: 40 }] });
    expect(result.allTerminalsWitnessed).toBe(false);
    expect(result.primitiveInteriors.find(p => p.id === "via:via")!.status).toBe("unproven");
  });
  it("accepts strict separation one nanometre beyond foreign-bore tangency", () => {
    const f = fixture();
    const result = findTerminalCopperPaths({ ...f, bores: [...f.bores, { uuid: "foreign", centerNm: { x: 500, y: 181 }, diameterNm: 40 }] });
    expect(result.allTerminalsWitnessed).toBe(true);
  });
  it("does not bridge through an empty plane cache hole", () => {
    const f = fixture(), component = { ...region(), holes: [region(420, 20, 580, 180).outer] };
    expect(findTerminalCopperPaths({ ...f, planes: [{ ...f.planes[0]!, component }] }).allTerminalsWitnessed).toBe(false);
  });
  it("supports an actual plated oblong shell pad without treating its hole as copper", () => {
    const f = fixture();
    const result = findTerminalCopperPaths({ ...f, vias: [], tracks: [],
      pads: [{ ...f.pads[0]!, uuid: "shell", centerNm: { x: 600, y: 150 }, layers: ["F.Cu", "In1.Cu"], platedThrough: true,
        shape: "oval", sizeNm: { x: 100, y: 200 } }],
      bores: [{ uuid: "shell", centerNm: { x: 600, y: 150 }, diameterNm: 60, slot: { majorDiameterNm: 160, axis: "y" } }] });
    expect(result.allTerminalsWitnessed).toBe(true);
    expect(result.witnessPorts.every(p => p.centerNm.x !== 600 || Math.abs(p.centerNm.y - 150) > 80)).toBe(true);
  });
  it("withholds a plated slot touching its outer pad boundary", () => {
    const f = fixture();
    const result = findTerminalCopperPaths({ ...f, vias: [], tracks: [],
      pads: [{ ...f.pads[0]!, uuid: "shell", centerNm: { x: 600, y: 150 }, layers: ["F.Cu", "In1.Cu"], platedThrough: true,
        shape: "oval", sizeNm: { x: 100, y: 200 } }],
      bores: [{ uuid: "shell", centerNm: { x: 600, y: 150 }, diameterNm: 60, slot: { majorDiameterNm: 200, axis: "y" } }] });
    expect(result.allTerminalsWitnessed).toBe(false);
  });
  it("requires every repeated logical pin's separate physical pad to reach the plane", () => {
    const f = fixture();
    const result = findTerminalCopperPaths({ ...f, pads: [...f.pads, { ...f.pads[0]!, uuid: "split", centerNm: { x: 1000, y: 1000 } }] });
    expect(result.terminals.map(t => t.status)).toEqual(["witnessed", "unproven"]);
    expect(result.allTerminalsWitnessed).toBe(false);
  });
  it("does not count tangent pad-to-plane boundaries as a contact", () => {
    const f = fixture();
    const result = findTerminalCopperPaths({ ...f, vias: [], tracks: [], bores: [], planes: [{ id: "GROUND", layer: "F.Cu", component: region(150, 0, 400, 300) }] });
    expect(result.allTerminalsWitnessed).toBe(false);
  });
  it("preserves rounded corners instead of substituting the pad bounding box", () => {
    const f = fixture();
    const result = findTerminalCopperPaths({ ...f, vias: [], tracks: [], bores: [],
      pads: [{ ...f.pads[0]!, shape: "roundrect", cornerRadiusNm: 25 }],
      planes: [{ id: "GROUND", layer: "F.Cu", component: region(148, 148, 200, 200) }] });
    expect(result.allTerminalsWitnessed).toBe(false);
  });
  it("keeps overlapping internal bores unproven instead of assuming a connected pad", () => {
    const f = fixture();
    const result = findTerminalCopperPaths({ ...f, vias: [], tracks: [], pads: [{ ...f.pads[0]!, centerNm: { x: 600, y: 150 }, sizeNm: { x: 300, y: 200 } }],
      bores: [{ uuid: "hole1", centerNm: { x: 580, y: 150 }, diameterNm: 50 }, { uuid: "hole2", centerNm: { x: 620, y: 150 }, diameterNm: 50 }],
      planes: [{ id: "GROUND", layer: "F.Cu", component: region() }] });
    expect(result.allTerminalsWitnessed).toBe(false);
  });
  it("does not invent barrels or accept duplicate identities and noninteger geometry", () => {
    const f = fixture();
    expect(() => findTerminalCopperPaths({ ...f, bores: [] })).toThrow(/via bore/);
    expect(() => findTerminalCopperPaths({ ...f, pads: [{ ...f.pads[0]!, layers: ["F.Cu", "B.Cu"] }] })).toThrow(/drill and layer/);
    expect(() => findTerminalCopperPaths({ ...f, tracks: [...f.tracks, ...f.tracks] })).toThrow(/duplicate/);
    expect(() => findTerminalCopperPaths({ ...f, vias: [{ ...f.vias[0]!, drillNm: 40.5 }] })).toThrow(/bound/);
    expect(() => findTerminalCopperPaths({ ...f, tracks: Array.from({ length: 4097 }, () => f.tracks[0]!) })).toThrow(/count bound/);
    expect(() => findTerminalCopperPaths({ ...f, planes: [...f.planes, { ...f.planes[0]!, component: { ...region(), nativePolygonIndex: 1 } }] })).toThrow(/one target/);
  });
  it("does not use a pad whose connected interior would be clipped by the board edge", () => {
    const f = fixture();
    expect(findTerminalCopperPaths({ ...f, boardBoundsNm: { ...f.boardBoundsNm, minX: 60 } }).allTerminalsWitnessed).toBe(false);
  });
  it("retains exact decisions under a large signed coordinate translation", () => {
    const f = fixture(), shift = (p: { x: number; y: number }) => ({ x: p.x - 1_000_000_000, y: p.y + 999_000_000 });
    const moved = { ...f, boardBoundsNm: { minX: -1_000_000_000, minY: 999_000_000, maxX: -999_998_000, maxY: 999_002_000 },
      pads: f.pads.map(p => ({ ...p, centerNm: shift(p.centerNm) })), vias: f.vias.map(v => ({ ...v, centerNm: shift(v.centerNm) })),
      tracks: f.tracks.map(t => ({ ...t, startNm: shift(t.startNm), endNm: shift(t.endNm) })), bores: f.bores.map(b => ({ ...b, centerNm: shift(b.centerNm) })),
      planes: f.planes.map(p => ({ ...p, component: { ...p.component, outer: p.component.outer.map(shift) } })) };
    const result = findTerminalCopperPaths(moved);
    expect(result.allTerminalsWitnessed).toBe(true);
    expect(result.witnessPorts.map(p => p.radiusNm)).toEqual(findTerminalCopperPaths(f).witnessPorts.map(p => p.radiusNm));
  });
});
