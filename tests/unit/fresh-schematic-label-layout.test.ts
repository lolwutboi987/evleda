import { describe, expect, it } from "vitest";
import { approximateFreshGlobalLabelBounds, FRESH_LABEL_PLANNING_MODEL, freshGlobalLabelOrientation } from "../../src/harness/fresh-schematic-label-layout.js";
import { planFreshGlobalLabelTerminals } from "../../src/harness/kicad-tools.js";
import { createFreshConnectivityContract } from "../../src/harness/fresh-connectivity-contract.js";
import { createGenericDividerBundleFixture } from "../helpers/generic-divider-bundle.js";

const contract = createFreshConnectivityContract(createGenericDividerBundleFixture().bundle.contract);
const overlap = (a: { minX: number; minY: number; maxX: number; maxY: number }, b: typeof a) =>
  Math.min(a.maxX, b.maxX) > Math.max(a.minX, b.minX) && Math.min(a.maxY, b.maxY) > Math.max(a.minY, b.minY);

describe("approximate outward global-label terminal planning", () => {
  it.each([
    [0, 180, "right", -1, 0], [90, 270, "top", 0, 1],
    [180, 0, "left", 1, 0], [270, 90, "bottom", 0, -1],
  ] as const)("reserves an outward on-grid stub for pin angle %i", (angleDeg, rotationDeg, justify, dx, dy) => {
    const pin = { x: 127, y: 101.6, angleDeg };
    const box = { reference: "J1", minX: pin.x - dx * 5.08 - 1.27, maxX: pin.x - dx * 5.08 + 1.27,
      minY: pin.y - dy * 5.08 - 1.27, maxY: pin.y - dy * 5.08 + 1.27 };
    const oneNet = { ...contract, nets: [contract.nets[0]!] };
    const plan = planFreshGlobalLabelTerminals(oneNet, new Map([["J1:3", pin]]), [box]);
    expect(plan.issues).toEqual([]);
    expect(plan.labels).toHaveLength(1);
    const label = plan.labels[0]!;
    expect(label).toMatchObject({ name: "GND", endpointId: "J1:3", rotationDeg, justify, fontMm: 1.524 });
    expect(freshGlobalLabelOrientation(angleDeg)).toEqual({ rotationDeg, justify });
    expect((label.at.x - pin.x) * dx + (label.at.y - pin.y) * dy).toBeGreaterThanOrEqual(5.08 - 1e-8);
    expect((label.at.x - pin.x) * dy - (label.at.y - pin.y) * dx).toBeCloseTo(0);
    for (const value of [label.at.x, label.at.y]) expect(value / 1.27).toBeCloseTo(Math.round(value / 1.27));
    expect(overlap(label.bounds, box)).toBe(false);
  });

  it("reserves non-overlapping staggered terminal envelopes for a dense connector without substituting power symbols", () => {
    const pins = new Map([
      ["J1:1", { x: 71.12, y: 73.66, angleDeg: 0 as const }],
      ["J1:2", { x: 71.12, y: 76.2, angleDeg: 0 as const }],
      ["J1:3", { x: 71.12, y: 78.74, angleDeg: 0 as const }],
    ]);
    const plan = planFreshGlobalLabelTerminals(contract, pins, [{ reference: "J1", minX: 66.04, maxX: 86.36, minY: 68.58, maxY: 83.82 }]);
    expect(plan.issues).toEqual([]);
    expect(plan.labels.map((label) => label.name)).toEqual(contract.nets.map((net) => net.name));
    expect(plan.labels.every((label) => label.rotationDeg === 180 && label.justify === "right")).toBe(true);
    for (const [index, label] of plan.labels.entries()) for (const other of plan.labels.slice(index + 1)) expect(overlap(label.bounds, other.bounds)).toBe(false);
    expect(plan.labels.every((label) => label.at.x < pins.get(label.endpointId)!.x)).toBe(true);
    expect(plan).not.toHaveProperty("powerSymbols");
  });

  it("reuses the existing approximate text model with padding, including long and Unicode names", () => {
    const at = { x: 127, y: 101.6 };
    const short = approximateFreshGlobalLabelBounds("VIN", at, 180)!;
    const long = approximateFreshGlobalLabelBounds("LONG_SENSOR_REFERENCE_NET_001", at, 180)!;
    expect(long.minX).toBeLessThan(short.minX);
    expect(long.maxX).toBe(at.x);
    expect(FRESH_LABEL_PLANNING_MODEL).toMatchObject({ approximate: true, glyphAspect: 0.66, fontMm: 1.524 });
    const oneGlyph = approximateFreshGlobalLabelBounds("😀", at, 0)!;
    expect(oneGlyph.maxX - oneGlyph.minX).toBeCloseTo(1.524 * 0.66 + 2 * 1.27);
    expect(FRESH_LABEL_PLANNING_MODEL).not.toHaveProperty("nativeClearancePassed");
    const named = { ...contract, nets: [{ ...contract.nets[0]!, name: "LONG_SENSOR_REFERENCE_NET_001" }] };
    const plan = planFreshGlobalLabelTerminals(named, new Map([["J1:3", { ...at, angleDeg: 0 as const }]]),
      [{ reference: "J1", minX: 127, maxX: 140.97, minY: 99.06, maxY: 104.14 }]);
    expect(plan.issues).toEqual([]);
    expect(plan.labels[0]).toMatchObject({ name: named.nets[0]!.name, endpointId: "J1:3", rotationDeg: 180, justify: "right" });
    expect(plan.labels[0]!.bounds.maxX - plan.labels[0]!.bounds.minX).toBeCloseTo(long.maxX - long.minX);
  });

  it.each(["", "bad\nname", "bad\u0000name", "x".repeat(129), "\ud800"])("refuses unsupported label extent input %j", (name) => {
    expect(approximateFreshGlobalLabelBounds(name, { x: 100, y: 100 }, 0)).toBeNull();
  });

  it("reports unavailable planning space without moving a pin or inventing an extent", () => {
    const pins = new Map([["J1:3", { x: 17.78, y: 101.6, angleDeg: 0 as const }]]);
    const before = JSON.stringify([...pins]);
    const plan = planFreshGlobalLabelTerminals({ ...contract, nets: [contract.nets[0]!] }, pins,
      [{ reference: "J1", minX: 17.78, maxX: 30.48, minY: 99.06, maxY: 104.14 }]);
    expect(plan.labels).toEqual([]);
    expect(plan.issues).toMatchObject([{ code: "LABEL_PLANNING_SPACE_UNAVAILABLE", endpoints: ["J1:3"] }]);
    expect(JSON.stringify([...pins])).toBe(before);
  });
});
