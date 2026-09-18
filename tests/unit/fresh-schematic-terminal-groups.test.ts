import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { buildSchematicTerminalGroups, transformFreshSchematicSourcePin, validatePristineTerminalPartition, type FreshSchematicCardinalAngle, type FreshSchematicSourceComponent, type FreshSchematicSourcePin, type FreshSchematicTerminalInput, type FreshSchematicTerminalPartition } from "../../src/harness/fresh-schematic-terminal-groups.js";
import { FreshSchematicWorkBudget } from "../../src/harness/fresh-schematic-work-budget.js";

interface StockPin extends FreshSchematicSourcePin { readonly name: string; readonly electricalType: string; readonly unit: number; readonly bodyStyle: number; readonly sourceLine: number }
const stock = JSON.parse(readFileSync(new URL("../fixtures/fresh-project/rp2350-stock-schematic-pins.json", import.meta.url), "utf8")) as {
  provenance: { sourceIdentity: ReturnType<typeof contentIdentity>; nativeExecution: boolean; liveGeometryIncluded: boolean };
  symbols: { libraryId: string; unit: number; pins: StockPin[] }[];
};
const inputIdentity = canonicalIdentity({ purpose: "synthetic-test-contract-not-board-design" }, "test.schematic.contract.v1");
const fixtureSource = contentIdentity("synthetic source metadata fixture, not a real symbol");
const independentLivePin = (component: FreshSchematicSourceComponent, pin: FreshSchematicSourcePin) => {
  // Test placement synthesis only: actual stock *local* metadata is frozen;
  // no fixture in this file pretends these coordinates are native captures.
  const x = pin.at.xMm;
  const y = -pin.at.yMm;
  const coordinates = { 0: [x, y], 90: [y, -x], 180: [-x, -y], 270: [-y, x] }[component.placement.rotationDeg]!;
  return { reference: component.reference, pin: pin.number,
    at: { xMm: component.placement.at.xMm + coordinates[0]!, yMm: component.placement.at.yMm + coordinates[1]! },
    angleDeg: ((pin.angleDeg + component.placement.rotationDeg) % 360) as FreshSchematicCardinalAngle };
};
const fromComponents = (components: readonly FreshSchematicSourceComponent[]): FreshSchematicTerminalInput => ({
  contractIdentity: inputIdentity,
  components,
  assignments: components.flatMap((component) => component.pins.map((pin) => ({ reference: component.reference, pin: pin.number, assignment: { kind: "net" as const, net: "N" } }))),
  livePins: components.flatMap((component) => component.pins.map((pin) => independentLivePin(component, pin))),
});
const small = (): FreshSchematicTerminalInput => fromComponents([{
  reference: "U1", symbolLibId: "Test:Stack", unit: 1, sourceIdentity: fixtureSource,
  placement: { at: { xMm: 100, yMm: 100 }, rotationDeg: 0 },
  pins: [
    { number: "1", at: { xMm: 0, yMm: 0 }, angleDeg: 270 },
    { number: "2", at: { xMm: 0, yMm: 0 }, angleDeg: 270 },
    { number: "3", at: { xMm: 2.54, yMm: 0 }, angleDeg: 270 },
  ],
}]);
const complete = (input: FreshSchematicTerminalInput): FreshSchematicTerminalPartition => {
  const result = buildSchematicTerminalGroups(input);
  expect(result.status).toBe("complete");
  if (result.status !== "complete") throw new Error(JSON.stringify(result));
  return result.value;
};
const withAssignment = (input: FreshSchematicTerminalInput, pin: string, assignment: FreshSchematicTerminalInput["assignments"][number]["assignment"]): FreshSchematicTerminalInput => ({
  ...input, assignments: input.assignments.map((value) => value.pin === pin ? { ...value, assignment } : value),
});
const pristine = (partition: FreshSchematicTerminalPartition) => partition.groups.map((group) => ({ name: "~unnamed", endpoints: [...group.memberEndpointIds] }));
const sourcePin = (input: FreshSchematicTerminalInput, pin: string, change: Partial<FreshSchematicSourcePin>): FreshSchematicTerminalInput => {
  const components = input.components.map((component) => ({ ...component, pins: component.pins.map((value) => value.number === pin ? { ...value, ...change } : value) }));
  return { ...input, components, livePins: fromComponents(components).livePins };
};

describe("source-shaped schematic terminal groups", () => {
  it("retains actual stock metadata provenance, unit/body structure, and complete pin ranges", () => {
    expect(stock.provenance).toMatchObject({ sourceIdentity: { digest: "c9f0fe21e8a46d7503537322833345ba4299a2e6d0e7c018a8a4a4457f563191", size: 64675 }, nativeExecution: false, liveGeometryIncluded: false });
    for (const [index, count] of [61, 81].entries()) {
      const symbol = stock.symbols[index]!;
      expect(symbol.pins.map((pin) => Number(pin.number))).toEqual(Array.from({ length: count }, (_, pin) => pin + 1));
      expect(new Set(symbol.pins.map((pin) => pin.unit))).toEqual(new Set([1]));
      expect(new Set(symbol.pins.map((pin) => pin.bodyStyle))).toEqual(new Set([0, 1]));
      expect(symbol.pins.every((pin) => Number.isInteger(pin.sourceLine) && pin.sourceLine > 1159)).toBe(true);
      expect(symbol.pins.find((pin) => pin.number === String(count))).toMatchObject({ name: "GND", electricalType: "power_in" });
    }
    expect(stock.symbols[0]!.pins.find((pin) => pin.number === "51")).toMatchObject({ name: "USB_DM", at: { xMm: -25.4, yMm: 15.24 } });
    expect(stock.symbols[1]!.pins.find((pin) => pin.number === "67")).toMatchObject({ name: "USB_DP", at: { xMm: -25.4, yMm: 22.86 } });
  });

  it.each(stock.symbols)("preserves every $libraryId pin while grouping its actual supply stacks", (symbol) => {
    const component: FreshSchematicSourceComponent = {
      reference: "U1", symbolLibId: symbol.libraryId, unit: 1, sourceIdentity: stock.provenance.sourceIdentity,
      placement: { at: { xMm: 101.6, yMm: 101.6 }, rotationDeg: 0 },
      pins: symbol.pins.map(({ number, at, angleDeg }) => ({ number, at, angleDeg })),
    };
    const input = fromComponents([component]);
    const result = complete(input);
    expect(result.endpointToGroup).toHaveLength(symbol.pins.length);
    for (const name of ["IOVDD", "DVDD"]) {
      const members = symbol.pins.filter((pin) => pin.name === name).map((pin) => `U1:${pin.number}`).sort();
      expect(result.groups.some((group) => JSON.stringify(group.memberEndpointIds) === JSON.stringify(members))).toBe(true);
    }
    expect(new Set(result.groups.flatMap((group) => group.memberEndpointIds)).size).toBe(symbol.pins.length);
    expect(validatePristineTerminalPartition(input, pristine(result)).status).toBe("complete");
  });

  it("does not turn caller-provided hashes into source extraction or native authority", () => {
    const input = small();
    const forgedCorrelation = { ...input, contractIdentity: { ...input.contractIdentity, digest: "a".repeat(64) },
      components: input.components.map((component) => ({ ...component, sourceIdentity: { ...component.sourceIdentity, digest: "b".repeat(64) } })) };
    expect(complete(forgedCorrelation)).toMatchObject({ verificationScope: "metadata_consistency_only", requiresSourceAdapterVerification: true });
    expect(complete(forgedCorrelation).identity).not.toEqual(complete(input).identity);
  });

  it("is deterministic under component/pin/assignment/live input permutations and does not mutate callers", () => {
    const first = small().components[0]!;
    const second = { ...first, reference: "U2", placement: { ...first.placement, at: { xMm: 200, yMm: 100 } } };
    const input = fromComponents([first, second]);
    const before = JSON.stringify(input);
    const reversed = { ...input, components: [...input.components].reverse().map((component) => ({ ...component, pins: [...component.pins].reverse() })), assignments: [...input.assignments].reverse(), livePins: [...input.livePins].reverse() };
    expect(buildSchematicTerminalGroups(reversed)).toEqual(buildSchematicTerminalGroups(input));
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.isFrozen(complete(input).groups[0]!.memberEndpointIds)).toBe(true);
  });

  it.each([
    [0, 102, 97, 270], [90, 97, 98, 0], [180, 98, 103, 90], [270, 103, 102, 180],
  ] as const)("corroborates asymmetric schematic coordinates at rotation %s without using PCB math", (rotationDeg, xMm, yMm, angleDeg) => {
    const input = sourcePin(sourcePin(small(), "1", { at: { xMm: 2, yMm: 3 } }), "2", { at: { xMm: 2, yMm: 3 } });
    const components = input.components.map((component) => ({ ...component, placement: { ...component.placement, rotationDeg } }));
    const rotated = fromComponents(components);
    expect(transformFreshSchematicSourcePin(components[0]!.pins[0]!, components[0]!.placement)).toEqual({ at: { xMm, yMm }, angleDeg });
    expect(complete(rotated).groups.find((group) => group.memberEndpointIds.length === 2)).toMatchObject({ liveAnchor: { xMm, yMm }, angleDeg });
  });

  it("keeps distinct terminals on one net separate, including independent singleton no-connect pins", () => {
    const input = withAssignment(small(), "3", { kind: "no_connect" });
    const partition = complete(input);
    expect(partition.groups).toHaveLength(2);
    expect(partition.groups.find((group) => group.id === "U1:3")?.assignment).toEqual({ kind: "no_connect" });
  });

  it.each(["different-net", "mixed-no-connect", "all-no-connect"] as const)("rejects conflicting or unverified stacked dispositions: %s", (kind) => {
    let input = withAssignment(small(), "2", kind === "different-net" ? { kind: "net", net: "OTHER" } : { kind: "no_connect" });
    if (kind === "all-no-connect") input = withAssignment(input, "1", { kind: "no_connect" });
    const result = buildSchematicTerminalGroups(input);
    expect(result).toMatchObject({ status: kind === "all-no-connect" ? "unsupported" : "invalid", issues: [{ code: kind === "all-no-connect" ? "NO_CONNECT_STACK_UNSUPPORTED" : "COINCIDENT_DISPOSITION_CONFLICT" }] });
    expect(result).not.toHaveProperty("value");
  });

  it("rejects same-net coincidence across independent components", () => {
    const first = small().components[0]!;
    expect(buildSchematicTerminalGroups(fromComponents([first, { ...first, reference: "U2" }]))).toMatchObject({ status: "invalid", issues: [{ code: "CROSS_COMPONENT_COLLISION" }] });
  });

  it("rejects near local points rather than proximity-grouping them", () => {
    expect(buildSchematicTerminalGroups(sourcePin(small(), "2", { at: { xMm: 0.0005, yMm: 0 } }))).toMatchObject({ status: "invalid", issues: [{ code: "NEAR_PIN_COLLISION" }] });
  });

  it.each(["position", "angle", "near-stack", "source-angle"] as const)("rejects inconsistent source/live geometry: %s", (kind) => {
    let input = small();
    if (kind === "source-angle") input = sourcePin(input, "2", { angleDeg: 90 });
    else input = { ...input, livePins: input.livePins.map((pin) => pin.pin !== "2" ? pin : {
      ...pin,
      at: { ...pin.at, xMm: pin.at.xMm + (kind === "position" ? 0.1 : kind === "near-stack" ? 0.00005 : 0) },
      angleDeg: kind === "angle" ? 90 : pin.angleDeg,
    }) };
    expect(buildSchematicTerminalGroups(input)).toMatchObject({ status: "invalid", issues: [{ code: kind === "source-angle" || kind === "near-stack" ? "SOURCE_STACK_CONFLICT" : "SOURCE_LIVE_GEOMETRY_MISMATCH" }] });
  });

  it.each(["assignment-missing", "assignment-extra", "live-missing", "live-duplicate", "source-duplicate", "component-duplicate"] as const)("requires exact complete input inventories: %s", (kind) => {
    const input = small();
    const changed = kind === "assignment-missing" ? { ...input, assignments: input.assignments.slice(1) }
      : kind === "assignment-extra" ? { ...input, assignments: [...input.assignments, { ...input.assignments[0]!, pin: "99" }] }
        : kind === "live-missing" ? { ...input, livePins: input.livePins.slice(1) }
          : kind === "live-duplicate" ? { ...input, livePins: [...input.livePins, input.livePins[0]!] }
            : kind === "source-duplicate" ? { ...input, components: [{ ...input.components[0]!, pins: [...input.components[0]!.pins, input.components[0]!.pins[0]!] }] }
              : { ...input, components: [...input.components, input.components[0]!] };
    expect(buildSchematicTerminalGroups(changed)).toMatchObject({ status: "invalid", issues: [{ code: "INVENTORY_MISMATCH" }] });
  });

  it.each(["nonfinite", "noncardinal", "malformed-identity", "unknown-field", "too-many-components", "too-many-pins"] as const)("rejects malformed metadata: %s", (kind) => {
    const input = small();
    const invalid = kind === "nonfinite" ? { ...input, livePins: [{ ...input.livePins[0]!, at: { xMm: Infinity, yMm: 1 } }] }
      : kind === "noncardinal" ? { ...input, components: [{ ...input.components[0]!, placement: { at: { xMm: 1, yMm: 2 }, rotationDeg: 45 } }] }
        : kind === "malformed-identity" ? { ...input, contractIdentity: { ...input.contractIdentity, digest: "not-a-hash" } }
          : kind === "unknown-field" ? { ...input, claimTrusted: true }
            : kind === "too-many-components" ? { ...input, components: Array.from({ length: 65 }, () => input.components[0]!) }
              : { ...input, components: [{ ...input.components[0]!, pins: Array.from({ length: 129 }, () => input.components[0]!.pins[0]!) }] };
    expect(buildSchematicTerminalGroups(invalid as FreshSchematicTerminalInput)).toMatchObject({ status: "invalid", issues: [{ code: "INVALID_INPUT" }] });
  });
});

describe("complete pristine terminal partitions", () => {
  it("review regression: pristine permutation preserves exact exhaustion evidence", () => {
    const input = small();
    const built = buildSchematicTerminalGroups(input);
    if (built.status !== "complete") throw new Error("expected fixture complete");
    const readback = pristine(built.value);
    const maximum = built.work.consumed + 2;
    const original = validatePristineTerminalPartition(input, readback, new FreshSchematicWorkBudget(maximum));
    const reversed = validatePristineTerminalPartition(input, [...readback].reverse(), new FreshSchematicWorkBudget(maximum));
    expect(original.status).toBe("exhausted");
    expect(original).not.toHaveProperty("value");
    expect(reversed).toEqual(original);
  });

  it("review regression: live rounding allowance cannot erase source-proven near-pin collision", () => {
    const input = sourcePin(small(), "2", { at: { xMm: 0.0009, yMm: 0 } });
    const jittered = { ...input, livePins: input.livePins.map((pin) => pin.pin === "1"
      ? { ...pin, at: { ...pin.at, xMm: 99.9999 } }
      : pin.pin === "2" ? { ...pin, at: { ...pin.at, xMm: 100.001 } } : pin) };
    const result = buildSchematicTerminalGroups(jittered);
    expect(result).toMatchObject({ status: "invalid", issues: [{ code: "NEAR_PIN_COLLISION" }] });
    expect(result).not.toHaveProperty("value");
  });

  it("accepts complete source-shaped stacks, not just singleton-only readback", () => {
    const input = small();
    const readback = pristine(complete(input)).reverse().map((group) => ({ ...group, endpoints: group.endpoints.reverse() }));
    expect(validatePristineTerminalPartition(input, readback).status).toBe("complete");
  });

  it.each(["split-stack", "merged-groups", "named", "missing", "extra", "duplicate-group", "duplicate-pin", "empty"] as const)("rejects incorrect pristine partition: %s", (kind) => {
    const input = small();
    const valid = pristine(complete(input));
    const bad = kind === "split-stack" ? ["U1:1", "U1:2", "U1:3"].map((id) => ({ name: "~unnamed", endpoints: [id] }))
      : kind === "merged-groups" ? [{ name: "~unnamed", endpoints: ["U1:1", "U1:2", "U1:3"] }]
        : kind === "named" ? valid.map((group) => ({ ...group, name: "N" }))
          : kind === "missing" ? valid.slice(1)
            : kind === "extra" ? [...valid, { name: "~unnamed", endpoints: ["U2:1"] }]
              : kind === "duplicate-group" ? [...valid, valid[0]!]
                : kind === "duplicate-pin" ? [{ name: "~unnamed", endpoints: ["U1:1", "U1:1", "U1:2"] }, valid[1]!]
                  : [{ name: "~unnamed", endpoints: [] }];
    const result = validatePristineTerminalPartition(input, bad);
    expect(result).toMatchObject({ status: "invalid", issues: [{ code: "PRISTINE_PARTITION_MISMATCH" }] });
    expect(result).not.toHaveProperty("value");
  });
});

const larger = (count: number): FreshSchematicTerminalInput => {
  const components: FreshSchematicSourceComponent[] = [];
  for (let offset = 0; offset < count; offset += 128) {
    const index = offset / 128;
    components.push({ reference: `U${index + 1}`, symbolLibId: "Test:Capacity", unit: 1, sourceIdentity: fixtureSource,
      placement: { at: { xMm: 100 + index % 8 * 100, yMm: 100 + Math.floor(index / 8) * 100 }, rotationDeg: 0 },
      pins: Array.from({ length: Math.min(128, count - offset) }, (_, pin) => ({ number: String(pin + 1), at: { xMm: pin % 16 * 0.25, yMm: Math.floor(pin / 16) * 0.25 }, angleDeg: 270 })) });
  }
  const input = fromComponents(components);
  return { ...input, assignments: input.assignments.map((assignment, index) => ({ ...assignment, assignment: { kind: "net", net: `N${Math.floor(index / 256)}` } })) };
};

describe("larger unique logical-pin inventories and bounded failure", () => {
  it.each([65, 128, 256, 512, 8192])("handles %s unique metadata terminals without claiming production capacity", (count) => {
    const result = buildSchematicTerminalGroups(larger(count));
    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error(JSON.stringify(result));
    expect(result.value.endpointToGroup).toHaveLength(count);
    expect(result.value.groups).toHaveLength(count);
    expect(result.value.requiresSourceAdapterVerification).toBe(true);
    expect(result.work.consumed).toBeLessThan(500_000);
    expect(Object.values(result.work.counters).reduce((sum, value) => sum + value, 0)).toBe(result.work.consumed);
  });

  it("accepts two actual stock metadata sets with 142 unique original endpoints", () => {
    const components = stock.symbols.map((symbol, index): FreshSchematicSourceComponent => ({
      reference: `U${index + 1}`, symbolLibId: symbol.libraryId, unit: 1, sourceIdentity: stock.provenance.sourceIdentity,
      placement: { at: { xMm: 100 + index * 150, yMm: 100 }, rotationDeg: 0 },
      pins: symbol.pins.map(({ number, at, angleDeg }) => ({ number, at, angleDeg })),
    }));
    expect(complete(fromComponents(components)).endpointToGroup).toHaveLength(142);
  });

  it("retains the existing per-net and net-count contract envelope", () => {
    const input = larger(257);
    expect(buildSchematicTerminalGroups({ ...input, assignments: input.assignments.map((assignment) => ({ ...assignment, assignment: { kind: "net", net: "N" } })) })).toMatchObject({ status: "invalid", issues: [{ code: "INVALID_INPUT" }] });
    const manyNets = larger(129);
    expect(buildSchematicTerminalGroups({ ...manyNets, assignments: manyNets.assignments.map((assignment, index) => ({ ...assignment, assignment: { kind: "net", net: `N${index}` } })) })).toMatchObject({ status: "invalid", issues: [{ code: "INVALID_INPUT" }] });
  });

  it("accepts the exact consumed-work bound and exposes no partial group data one unit below it", () => {
    const input = larger(128);
    const measured = buildSchematicTerminalGroups(input);
    expect(measured.status).toBe("complete");
    expect(buildSchematicTerminalGroups(input, new FreshSchematicWorkBudget(measured.work.consumed)).status).toBe("complete");
    const exhausted = buildSchematicTerminalGroups(input, new FreshSchematicWorkBudget(measured.work.consumed - 1));
    expect(exhausted.status).toBe("exhausted");
    expect(exhausted).not.toHaveProperty("value");
    expect(exhausted).not.toHaveProperty("groups");
  });

  it("charges one aggregate budget across grouping and pristine readback", () => {
    const input = small();
    const built = buildSchematicTerminalGroups(input);
    if (built.status !== "complete") throw new Error("expected fixture complete");
    const readback = pristine(built.value);
    const result = validatePristineTerminalPartition(input, readback, new FreshSchematicWorkBudget(built.work.consumed));
    expect(result.status).toBe("exhausted");
    expect(result).not.toHaveProperty("value");
    expect(result.work.counters.partition).toBe(0);
    expect(buildSchematicTerminalGroups(larger(8192), new FreshSchematicWorkBudget(1)).status).toBe("exhausted");
  });
});
