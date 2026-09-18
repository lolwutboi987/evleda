import { describe, expect, it } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { FRESH_CONNECTIVITY_CONTRACT_SCHEMA_VERSION, type FreshConnectivityContract } from "../../src/harness/fresh-connectivity-contract.js";
import { buildSchematicTerminalGroups, type FreshSchematicCardinalAngle } from "../../src/harness/fresh-schematic-terminal-groups.js";
import { planFreshTerminalGlobalLabels, type FreshTerminalLabelObstacle } from "../../src/harness/fresh-schematic-terminal-labels.js";
import { FreshSchematicWorkBudget, type FreshSchematicWorkKind } from "../../src/harness/fresh-schematic-work-budget.js";

type Input = Parameters<typeof planFreshTerminalGlobalLabels>[0];
type Blocker = "native-glyph" | "body" | "source-body" | "label-envelope" | "pin" | "planned-label" | "planned-wire" | "sheet";
const round = (value: number) => Number(value.toFixed(4));

/** Synthetic metadata/geometry only: this fixture never claims native proof. */
function fixture(options: { count?: number; separated?: boolean; blocker?: Blocker } = {}) {
  const { count = 9, separated = false, blocker } = options;
  const sourceIdentity = contentIdentity("synthetic bounded previous-terminal retry fixture");
  const components = [
    ...(blocker === "planned-label" || blocker === "planned-wire" ? ["A1"] : []), "U1",
    ...Array.from({ length: count - (blocker === "planned-label" || blocker === "planned-wire" ? 2 : 1) }, (_, index) => `Z${index + 1}`),
  ].map(reference => ({ reference, symbolLibId: "Test:Retry", value: "SYNTHETIC", footprintLibId: "Test:Footprint" }));
  const points = components.flatMap((component, index) => component.reference === "U1" ? [
    { reference: "U1", pin: "1", x: 50.8, y: 50.8, angleDeg: 180 as FreshSchematicCardinalAngle, net: "GPIO23_SMPS_PS" },
    // An intervening NC is deliberately present in partition order.
    { reference: "U1", pin: "2", x: blocker === "pin" ? 99.06 : 45.72, y: blocker === "pin" ? 50.8 : 40.64, angleDeg: 180 as FreshSchematicCardinalAngle, net: null },
    { reference: "U1", pin: "3", x: 50.8, y: separated ? 63.5 : 53.34, angleDeg: 180 as FreshSchematicCardinalAngle, net: "GPIO24_VBUS_SENSE" },
  ] : component.reference === "A1" ? [{ reference: "A1", pin: "1", x: blocker === "planned-label" ? 106.68 : 99.06,
    y: blocker === "planned-label" ? 50.8 : 48.26, angleDeg: (blocker === "planned-label" ? 0 : 90) as FreshSchematicCardinalAngle,
    net: blocker === "planned-label" ? "N" : "CROSSING" }]
    : [{ reference: component.reference, pin: "1", x: round(20.32 + index * 7.62), y: 80.01, angleDeg: 180 as FreshSchematicCardinalAngle, net: null }]);
  const nets = [...new Set(points.flatMap(point => point.net === null ? [] : [point.net]))].map(name => ({ name,
    endpoints: points.filter(point => point.net === name).map(({ reference, pin }) => ({ reference, pin })) }));
  const noConnects = points.filter(point => point.net === null).map(({ reference, pin }) => ({ reference, pin }));
  const payload = { schemaVersion: FRESH_CONNECTIVITY_CONTRACT_SCHEMA_VERSION,
    sourceContractIdentity: canonicalIdentity({ components, nets, noConnects }, "test.terminal-retry-contract.v1"), components, nets, noConnects };
  const contract: FreshConnectivityContract = { ...payload, identity: canonicalIdentity(payload, payload.schemaVersion) };
  const partition = buildSchematicTerminalGroups({ contractIdentity: contract.sourceContractIdentity,
    components: components.map(component => ({ reference: component.reference, symbolLibId: component.symbolLibId, unit: 1, sourceIdentity,
      placement: { at: { xMm: 0, yMm: 0 }, rotationDeg: 0 }, pins: points.filter(point => point.reference === component.reference)
        .map(point => ({ number: point.pin, at: { xMm: point.x, yMm: -point.y }, angleDeg: point.angleDeg })) })),
    assignments: points.map(point => ({ reference: point.reference, pin: point.pin,
      assignment: point.net === null ? { kind: "no_connect" as const } : { kind: "net" as const, net: point.net } })),
    livePins: points.map(point => ({ reference: point.reference, pin: point.pin, at: { xMm: point.x, yMm: point.y }, angleDeg: point.angleDeg })),
  });
  if (partition.status !== "complete") throw new Error(JSON.stringify(partition));
  const pins = new Map(points.map(point => [`${point.reference}:${point.pin}`, { x: point.x, y: point.y, angleDeg: point.angleDeg }]));
  const boxes: FreshTerminalLabelObstacle[] = components.map(component => {
    const pin = points.find(point => point.reference === component.reference)!;
    return component.reference === "U1" ? { reference: "U1", minX: 46.99, maxX: 50.8, minY: 49.53, maxY: 54.61 }
      : component.reference === "A1" && blocker === "planned-wire" ? { reference: "A1", minX: pin.x - 1.27, maxX: pin.x + 1.27, minY: pin.y - 2.54, maxY: pin.y }
        : { reference: component.reference, minX: pin.x, maxX: pin.x + 1.27, minY: pin.y - 0.635, maxY: pin.y + 0.635 };
  });
  boxes.push(
    // Ink above the first row forces its greedy label out to distance 20.32.
    { reference: "@first-row-ink", nativeText: { coveringLabel: null }, minX: 50.9, maxX: 67, minY: 49.5, maxY: 49.7 },
    // Full native label frames extend farther than the old 0.66 estimate; the
    // slot is widened accordingly, preserving the need for the previous retry.
    // Ink below the second row permits its shortest label only. Its wire is clear.
    { reference: "@second-row-ink", nativeText: { coveringLabel: null }, minX: 78, maxX: blocker === "planned-wire" ? 88 : 99, minY: separated ? 64.5 : 54.3, maxY: separated ? 64.7 : 54.5 },
  );
  if (blocker === "planned-wire") boxes.push({ reference: "@vertical-label-ink", nativeText: { coveringLabel: null }, minX: 100, maxX: 100.2, minY: 52.5, maxY: 54.5 });
  const obstruction: FreshTerminalLabelObstacle = { reference: "@intrusion", minX: 99, maxX: 99.2, minY: 50.7, maxY: 50.9,
    ...(blocker === "native-glyph" ? { nativeText: { coveringLabel: null } } : {}) };
  if (blocker === "native-glyph" || blocker === "body") boxes.push(obstruction);
  if (blocker === "label-envelope") boxes.push({ reference: "@label-ink", nativeText: { coveringLabel: null }, minX: 99, maxX: 99.2, minY: 51, maxY: 51.2 });
  const input: Input = { contract, sourceIdentity, partition: partition.value, pins, boxes,
    sheet: { minX: 15.24, minY: 15.24, maxX: blocker === "sheet" ? 99.06 : 109.22, maxY: 100.33 },
    ...(blocker === "source-body" ? { sourceBodyBoxes: [obstruction] } : {}) };
  return { input, run: (budget = new FreshSchematicWorkBudget()) => planFreshTerminalGlobalLabels(input, budget) };
}

/** Native-sized frames in a synthetic local conflict chain; no native authority. */
function windowFixture(options: { count?: number; padding?: boolean; blocked?: boolean } = {}) {
  const { count = 9, padding = false, blocked = false } = options;
  const sourceIdentity = contentIdentity("synthetic four-terminal conflict window");
  const components = ["C1", "R1", "R2", "U1", ...Array.from({ length: count - 4 }, (_, index) => `Z${index + 1}`)]
    .map(reference => ({ reference, symbolLibId: "Test:Window", value: "SYNTHETIC", footprintLibId: "Test:Footprint" }));
  const points = [
    { reference: "C1", pin: "1", x: 88.9, y: 129.54, angleDeg: 270, net: "VSYS_DIV" },
    { reference: "R1", pin: "1", x: 78.74, y: 125.73, angleDeg: 270, net: "QSPI_CS" },
    { reference: "R2", pin: "1", x: 102.87, y: 127, angleDeg: 270, net: "VSYS" },
    { reference: "U1", pin: "55", x: 135.89, y: 125.73, angleDeg: 0, net: "QSPI_SD3" },
    { reference: "U1", pin: "56", x: 135.89, y: 115.57, angleDeg: 0, net: "QSPI_SCLK" },
    ...(padding ? [{ reference: "U1", pin: "56A", x: 135.89, y: 170.18, angleDeg: 0, net: "PADDING" }] : []),
    { reference: "U1", pin: "57", x: 135.89, y: 118.11, angleDeg: 0, net: "QSPI_SD0" },
    { reference: "U1", pin: "58", x: 135.89, y: 123.19, angleDeg: 0, net: "QSPI_SD2" },
    { reference: "U1", pin: "59", x: 135.89, y: 120.65, angleDeg: 0, net: "QSPI_SD1" },
    { reference: "U1", pin: "60", x: 135.89, y: 113.03, angleDeg: 0, net: "TAIL" },
    ...components.filter(component => component.reference.startsWith("Z")).map((component, index) => ({ reference: component.reference,
      pin: "1", x: round(203.2 + index * 12.7), y: 30.48, angleDeg: 180, net: null })),
  ].map(point => ({ ...point, angleDeg: point.angleDeg as FreshSchematicCardinalAngle }));
  const nets = points.filter(point => point.net !== null).map(point => ({ name: point.net!, endpoints: [{ reference: point.reference, pin: point.pin }] }));
  const noConnects = points.filter(point => point.net === null).map(({ reference, pin }) => ({ reference, pin }));
  const payload = { schemaVersion: FRESH_CONNECTIVITY_CONTRACT_SCHEMA_VERSION,
    sourceContractIdentity: canonicalIdentity({ components, nets, noConnects }, "test.terminal-window-contract.v1"), components, nets, noConnects };
  const contract: FreshConnectivityContract = { ...payload, identity: canonicalIdentity(payload, payload.schemaVersion) };
  const grouped = buildSchematicTerminalGroups({ contractIdentity: contract.sourceContractIdentity,
    components: components.map(component => ({ reference: component.reference, symbolLibId: component.symbolLibId, unit: 1, sourceIdentity,
      placement: { at: { xMm: 0, yMm: 0 }, rotationDeg: 0 }, pins: points.filter(point => point.reference === component.reference)
        .map(point => ({ number: point.pin, at: { xMm: point.x, yMm: -point.y }, angleDeg: point.angleDeg })) })),
    assignments: points.map(point => ({ reference: point.reference, pin: point.pin, assignment: point.net === null
      ? { kind: "no_connect" as const } : { kind: "net" as const, net: point.net } })),
    livePins: points.map(point => ({ reference: point.reference, pin: point.pin, at: { xMm: point.x, yMm: point.y }, angleDeg: point.angleDeg })),
  });
  if (grouped.status !== "complete") throw new Error(JSON.stringify(grouped));
  const pins = new Map(points.map(point => [`${point.reference}:${point.pin}`, { x: point.x, y: point.y, angleDeg: point.angleDeg }]));
  const boxes: FreshTerminalLabelObstacle[] = components.map(component => {
    const pin = points.find(point => point.reference === component.reference)!;
    return component.reference === "U1" ? { reference: "U1", minX: 135.89, maxX: 146.05, minY: 111.76, maxY: 172.72 }
      : { reference: component.reference, minX: pin.x - 1.27, maxX: pin.x + 1.27, minY: pin.y, maxY: pin.y + 2.54 };
  });
  if (blocked) boxes.push({ reference: "@immutable-ink", minX: 100, maxX: 100.2, minY: 115.4, maxY: 115.7, nativeText: { coveringLabel: null } });
  const input: Input = { contract, sourceIdentity, partition: grouped.value, pins, boxes,
    sheet: { minX: 15.24, minY: 15.24, maxX: 279.4, maxY: 195.58 } };
  return { input, run: (budget = new FreshSchematicWorkBudget()) => planFreshTerminalGlobalLabels(input, budget) };
}

describe("bounded previous functional terminal retry (synthetic, no native proof)", () => {
  it("moves one previously legal label to free the following constrained label, across an NC group", () => {
    const f = fixture(), budget = new FreshSchematicWorkBudget(), before = JSON.stringify({ ...f.input, pins: [...f.input.pins] });
    const result = f.run(budget);
    expect(result.issues).toEqual([]);
    expect(result.labels.map(label => [label.endpointId, label.at.x, label.at.y, label.fontMm])).toEqual([
      ["U1:1", 81.28, 50.8, 1.524], ["U1:3", 52.07, 53.34, 1.524],
    ]);
    expect(result.wires.map(wire => wire.edgeEndpoints)).toEqual([["U1:1"], ["U1:3"]]);
    expect(result.routes).toEqual(["GPIO23_SMPS_PS:U1:1", "GPIO24_VBUS_SENSE:U1:3"]);
    expect(result.labels[0]!.bounds.minX).toBeGreaterThan(result.labels[1]!.bounds.maxX);
    expect(JSON.stringify({ ...f.input, pins: [...f.input.pins] })).toBe(before);
    const repeatedBudget = new FreshSchematicWorkBudget();
    expect(f.run(repeatedBudget)).toEqual(result);
    expect(repeatedBudget.snapshot()).toEqual(budget.snapshot());
    expect(budget.snapshot().consumed).toBeLessThan(10_000);
  });

  it.each([2, 8])("retains the greedy dead end and empty result for the legacy %s-component boundary", count => {
    const result = fixture({ count }).run();
    expect(result).toMatchObject({ labels: [], wires: [], routes: [], issues: [{ code: "TERMINAL_LABEL_SPACE_UNAVAILABLE", endpoints: ["U1:3"] }] });
  });

  it.each([8, 9, 62])("keeps successful greedy choices unchanged at %s components", count => {
    const result = fixture({ count, separated: true }).run();
    expect(result.issues).toEqual([]);
    expect(result.labels.map(label => [label.endpointId, label.at.x, label.at.y])).toEqual([["U1:1", 71.12, 50.8], ["U1:3", 52.07, 63.5]]);
  });

  it.each<Blocker>(["native-glyph", "body", "source-body", "label-envelope", "pin", "planned-label", "planned-wire", "sheet"])("retains the %s collision constraint while retrying and publishes no partial prefix", blocker => {
    const f = fixture({ blocker }), before = JSON.stringify({ ...f.input, pins: [...f.input.pins] });
    const result = f.run();
    expect(result).toMatchObject({ labels: [], wires: [], routes: [], issues: [{ code: "TERMINAL_LABEL_SPACE_UNAVAILABLE", endpoints: ["U1:3"] }] });
    expect(JSON.stringify({ ...f.input, pins: [...f.input.pins] })).toBe(before);
  });

  it("charges retries and collision checks without refund, and fails closed when retry work exhausts", () => {
    const f = fixture(), completeBudget = new FreshSchematicWorkBudget();
    expect(f.run(completeBudget).issues).toEqual([]);
    const work = completeBudget.snapshot(), limited = new FreshSchematicWorkBudget(work.consumed - 1);
    const result = f.run(limited);
    expect(result).toMatchObject({ labels: [], wires: [], routes: [], issues: [{ code: "PLANNING_WORK_LIMIT" }] });
    expect(limited.snapshot()).toMatchObject({ status: "exhausted", consumed: work.consumed - 1, remaining: 0 });
    expect(limited.snapshot().counters.label).toBeGreaterThan(13);
    expect(limited.snapshot().counters.collision).toBeGreaterThan(0);
    expect(f.run(new FreshSchematicWorkBudget(work.consumed))).toEqual(f.run());
    expect(f.run(limited)).toMatchObject({ labels: [], wires: [], routes: [], issues: [{ code: "PLANNING_WORK_LIMIT" }] });
  });

  it("continues beyond the exhausted adjacent pair through three prior groups and then validates the remaining suffix", () => {
    const f = windowFixture(), before = JSON.stringify({ ...f.input, pins: [...f.input.pins] }), budget = new FreshSchematicWorkBudget();
    const result = f.run(budget);
    expect(result.issues).toEqual([]);
    expect(result.labels.map(label => [label.endpointId, label.at.x, label.at.y])).toEqual([
      ["C1:1", 88.9, 128.27], ["R1:1", 78.74, 124.46], ["R2:1", 102.87, 125.73], ["U1:55", 134.62, 125.73],
      ["U1:56", 105.41, 115.57], ["U1:57", 120.65, 118.11], ["U1:58", 120.65, 123.19], ["U1:59", 134.62, 120.65], ["U1:60", 134.62, 113.03],
    ]);
    expect(result.wires).toHaveLength(9); expect(result.routes).toHaveLength(9);
    expect(result.labels.every(label => label.fontMm === 1.524)).toBe(true);
    expect(JSON.stringify({ ...f.input, pins: [...f.input.pins] })).toBe(before);
    const again = new FreshSchematicWorkBudget(); expect(f.run(again)).toEqual(result); expect(again.snapshot()).toEqual(budget.snapshot());
    expect(budget.snapshot().consumed).toBeLessThan(1_000_000);
  });

  it.each([4, 8])("retains the original greedy failure at the legacy %s-component boundary", count => {
    expect(windowFixture({ count }).run()).toMatchObject({ wires: [], labels: [], routes: [],
      issues: [{ code: "TERMINAL_LABEL_SPACE_UNAVAILABLE", endpoints: ["U1:57"] }] });
  });

  it("does not expand the window to a fourth earlier functional group", () => {
    const budget = new FreshSchematicWorkBudget(), result = windowFixture({ padding: true }).run(budget);
    expect(result).toMatchObject({ wires: [], labels: [], routes: [], issues: [{ code: "TERMINAL_LABEL_SPACE_UNAVAILABLE", endpoints: ["U1:59"] }] });
    expect(budget.snapshot().status).toBe("available");
  });

  it("keeps native ink strict throughout the wider retry and publishes no failed partial prefix", () => {
    const f = windowFixture({ blocked: true }), before = JSON.stringify({ ...f.input, pins: [...f.input.pins] });
    expect(f.run()).toMatchObject({ wires: [], labels: [], routes: [], issues: [{ code: "TERMINAL_LABEL_SPACE_UNAVAILABLE", endpoints: ["U1:59"] }] });
    expect(JSON.stringify({ ...f.input, pins: [...f.input.pins] })).toBe(before);
  });

  it("charges window retries and truncation to the same budget and fails closed at its exact boundary", () => {
    const f = windowFixture(), budget = new FreshSchematicWorkBudget();
    const complete = f.run(budget); expect(complete.issues).toEqual([]);
    const maximum = budget.snapshot().consumed, limited = new FreshSchematicWorkBudget(maximum - 1);
    expect(f.run(limited)).toMatchObject({ wires: [], labels: [], routes: [], issues: [{ code: "PLANNING_WORK_LIMIT" }] });
    expect(limited.snapshot()).toMatchObject({ status: "exhausted", consumed: maximum - 1, remaining: 0 });
    expect(f.run(new FreshSchematicWorkBudget(maximum))).toEqual(complete);
  });

  it("charges the four-entry cursor setup and each rollback before evaluating the next candidate", () => {
    class ObservedBudget extends FreshSchematicWorkBudget {
      readonly calls: { kind: FreshSchematicWorkKind; units: number; before: number }[] = [];
      public override charge(kind: FreshSchematicWorkKind, units = 1): boolean {
        this.calls.push({ kind, units, before: this.snapshot().consumed });
        return super.charge(kind, units);
      }
    }
    const f = windowFixture(), budget = new ObservedBudget();
    expect(f.run(budget).issues).toEqual([]);
    const index = budget.calls.findIndex(call => call.kind === "label" && call.units === 4), setup = budget.calls[index]!;
    expect(index).toBeGreaterThan(0);
    expect(budget.calls.slice(index, index + 5).map(call => [call.kind, call.units])).toEqual([
      ["label", 4], ["label", 1], ["label", 1], ["label", 1], ["collision", 1],
    ]);
    for (const maximum of [setup.before + 3, setup.before + 4]) {
      const limited = new FreshSchematicWorkBudget(maximum);
      expect(f.run(limited)).toMatchObject({ wires: [], labels: [], routes: [], issues: [{ code: "PLANNING_WORK_LIMIT" }] });
      expect(limited.snapshot().exhaustion).toMatchObject({ kind: "label", requested: maximum === setup.before + 3 ? 4 : 1 });
    }
  });
});
