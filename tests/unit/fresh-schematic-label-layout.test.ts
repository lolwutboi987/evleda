import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { approximateFreshGlobalLabelBounds, FRESH_LABEL_PLANNING_MODEL, freshGlobalLabelOrientation, freshGlobalLabelOwnPortTouch } from "../../src/harness/fresh-schematic-label-layout.js";
import { planFreshGlobalLabelTerminals } from "../../src/harness/kicad-tools.js";
import { createFreshConnectivityContract } from "../../src/harness/fresh-connectivity-contract.js";
import { createGenericDividerBundleFixture } from "../helpers/generic-divider-bundle.js";

const contract = createFreshConnectivityContract(createGenericDividerBundleFixture().bundle.contract);
const overlap = (a: { minX: number; minY: number; maxX: number; maxY: number }, b: typeof a) =>
  Math.min(a.maxX, b.maxX) > Math.max(a.minX, b.minX) && Math.min(a.maxY, b.maxY) > Math.max(a.minY, b.minY);

describe("approximate outward global-label terminal planning", () => {
  it.each([
    [0, 180, "right", -1, 0], [90, 270, "right", 0, 1],
    [180, 0, "left", 1, 0], [270, 90, "left", 0, -1],
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

  it("uses stock-font advances and the complete passive frame for supported plain text", () => {
    const at = { x: 127, y: 101.6 };
    const short = approximateFreshGlobalLabelBounds("VIN", at, 180)!;
    const long = approximateFreshGlobalLabelBounds("LONG_SENSOR_REFERENCE_NET_001", at, 180)!;
    expect(long.minX).toBeLessThan(short.minX);
    expect(long.maxX).toBeCloseTo(at.x + 0.0763);
    expect(FRESH_LABEL_PLANNING_MODEL).toMatchObject({ approximate: false, fontMm: 1.524, labelSizeRatio: 0.375 });
    expect(approximateFreshGlobalLabelBounds("WWW", at, 0)!.maxX).toBeGreaterThan(approximateFreshGlobalLabelBounds("III", at, 0)!.maxX);
    expect(FRESH_LABEL_PLANNING_MODEL).not.toHaveProperty("nativeClearancePassed");
    const named = { ...contract, nets: [{ ...contract.nets[0]!, name: "LONG_SENSOR_REFERENCE_NET_001" }] };
    const plan = planFreshGlobalLabelTerminals(named, new Map([["J1:3", { ...at, angleDeg: 0 as const }]]),
      [{ reference: "J1", minX: 127, maxX: 140.97, minY: 99.06, maxY: 104.14 }]);
    expect(plan.issues).toEqual([]);
    expect(plan.labels[0]).toMatchObject({ name: named.nets[0]!.name, endpointId: "J1:3", rotationDeg: 180, justify: "right" });
    expect(plan.labels[0]!.bounds.maxX - plan.labels[0]!.bounds.minX).toBeCloseTo(long.maxX - long.minX);
  });

  it.each(["", "bad\nname", "bad\u0000name", "x".repeat(129), "\ud800", "😀", "${NET}", "~{RESET}", "A_{1}", "A B", "<b>NET</b>"])("refuses unsupported label extent input %j", (name) => {
    expect(approximateFreshGlobalLabelBounds(name, { x: 100, y: 100 }, 0)).toBeNull();
  });

  it("contains all 584 independent native glyph and stroked-frame observations at every cardinal rotation", () => {
    const native = JSON.parse(readFileSync(new URL("../fixtures/fresh-project/native-global-label-metrics.json", import.meta.url), "utf8")) as {
      cases: { name: string; rotation: 0 | 90 | 180 | 270; justify: string; at: { x: number; y: number };
        frame: { minX: number; minY: number; maxX: number; maxY: number }; glyph: { minX: number; minY: number; maxX: number; maxY: number } }[];
    };
    expect(native.cases).toHaveLength(584);
    for (const fixture of native.cases) {
      const planned = approximateFreshGlobalLabelBounds(fixture.name, fixture.at, fixture.rotation)!;
      expect(planned, `${fixture.name}/${fixture.rotation}`).not.toBeNull();
      for (const ink of [fixture.glyph, fixture.frame]) {
        expect(planned.minX).toBeLessThanOrEqual(ink.minX + 1e-9);
        expect(planned.minY).toBeLessThanOrEqual(ink.minY + 1e-9);
        expect(planned.maxX).toBeGreaterThanOrEqual(ink.maxX - 1e-9);
        expect(planned.maxY).toBeGreaterThanOrEqual(ink.maxY - 1e-9);
      }
      for (const key of ["minX", "minY", "maxX", "maxY"] as const) expect(Math.abs(planned[key] - fixture.frame[key])).toBeLessThanOrEqual(0.00011);
    }
  });

  it("reserves the actual USB label ink missed by the 0.66 model", () => {
    const observed = { minX: 78.0284, maxX: 91.8242, minY: 48.7357, maxY: 50.5573 };
    const bounds = approximateFreshGlobalLabelBounds("USB_DP_ESD", { x: 92.71, y: 49.53 }, 180)!;
    expect(bounds.minX).toBeLessThan(observed.minX);
    expect(bounds.maxX).toBeGreaterThan(observed.maxX);
    expect(bounds.minY).toBeLessThan(observed.minY);
    expect(bounds.maxY).toBeGreaterThan(observed.maxY);
  });

  it.each([0, 90, 180, 270] as const)("permits only a bounded incoming owned port touch at rotation %s", rotation => {
    const at = { x: 100, y: 100 }, name = "USB_DP_ESD";
    const orientation = freshGlobalLabelOrientation(((rotation + 180) % 360) as 0 | 90 | 180 | 270);
    const label = { name, endpointId: "U1:1", at, ...orientation, fontMm: 1.524 as const,
      bounds: approximateFreshGlobalLabelBounds(name, at, rotation)! };
    const dx = rotation === 0 ? -1 : rotation === 180 ? 1 : 0, dy = rotation === 90 ? 1 : rotation === 270 ? -1 : 0;
    const inward = { x: at.x + dx * 1.27, y: at.y + dy * 1.27 };
    expect(freshGlobalLabelOwnPortTouch(label, { start: inward, end: at }, name, ["U1:1"])).toBe(true);
    expect(freshGlobalLabelOwnPortTouch(label, { start: at, end: inward }, name, ["U1:1"])).toBe(true);
    expect(freshGlobalLabelOwnPortTouch(label, { start: inward, end: at }, "OTHER", ["U1:1"])).toBe(false);
    expect(freshGlobalLabelOwnPortTouch(label, { start: inward, end: at }, name, ["U2:1"])).toBe(false);
    expect(freshGlobalLabelOwnPortTouch(label, { start: inward, end: { x: at.x - dx, y: at.y - dy } }, name, ["U1:1"])).toBe(false);
    expect(freshGlobalLabelOwnPortTouch(label, { start: at, end: { x: at.x - dx, y: at.y - dy } }, name, ["U1:1"])).toBe(false);
    expect(freshGlobalLabelOwnPortTouch(label, { start: at, end: { x: at.x + dy, y: at.y + dx } }, name, ["U1:1"])).toBe(false);
    expect(freshGlobalLabelOwnPortTouch(label, { start: { x: at.x + dx * 0.02, y: at.y + dy * 0.02 }, end: at }, name, ["U1:1"])).toBe(false);
    expect(freshGlobalLabelOwnPortTouch({ ...label, bounds: { ...label.bounds, maxX: label.bounds.maxX + 1 } }, { start: inward, end: at }, name, ["U1:1"])).toBe(false);
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
