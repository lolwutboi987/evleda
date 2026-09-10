import { describe, expect, it } from "vitest";
import { FRESH_SCHEMATIC_MAX_WORK_UNITS, FRESH_SCHEMATIC_WORK_KINDS, FreshSchematicWorkBudget, withFreshSchematicWorkBudget } from "../../src/harness/fresh-schematic-work-budget.js";

describe("aggregate deterministic schematic work", () => {
  it.each([0, -1, 1.5, NaN, Infinity, FRESH_SCHEMATIC_MAX_WORK_UNITS + 1])("rejects invalid maximum %s", (maximum) => {
    expect(() => new FreshSchematicWorkBudget(maximum)).toThrow(RangeError);
  });

  it("admits the exact boundary, then latches the first rejected charge without a partial reservation", () => {
    const budget = new FreshSchematicWorkBudget(7);
    expect(budget.charge("input", 3)).toBe(true);
    expect(budget.charge("route", 4)).toBe(true);
    expect(budget.snapshot()).toMatchObject({ status: "available", consumed: 7, remaining: 0, counters: { input: 3, route: 4 } });
    expect(budget.charge("collision", 2)).toBe(false);
    const exhausted = budget.snapshot();
    expect(exhausted).toMatchObject({ status: "exhausted", consumed: 7, remaining: 0, exhaustion: { kind: "collision", requested: 2, remaining: 0 } });
    expect(budget.charge("label")).toBe(false);
    expect(budget.snapshot()).toEqual(exhausted);
  });

  it("does not permit a small later charge after an oversized charge failed", () => {
    const budget = new FreshSchematicWorkBudget(10);
    expect(budget.charge("input", 2)).toBe(true);
    expect(budget.charge("tree", 9)).toBe(false);
    expect(budget.charge("label", 1)).toBe(false);
    expect(budget.snapshot()).toMatchObject({ consumed: 2, remaining: 8, exhaustion: { kind: "tree", requested: 9, remaining: 8 } });
  });

  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid charge %s", (units) => {
    expect(() => new FreshSchematicWorkBudget().charge("route", units)).toThrow(RangeError);
  });

  it("counts all operation categories in one aggregate", () => {
    const budget = new FreshSchematicWorkBudget(FRESH_SCHEMATIC_WORK_KINDS.length);
    for (const kind of FRESH_SCHEMATIC_WORK_KINDS) expect(budget.charge(kind)).toBe(true);
    expect(Object.values(budget.snapshot().counters).reduce((sum, value) => sum + value, 0)).toBe(FRESH_SCHEMATIC_WORK_KINDS.length);
    expect(budget.charge("route")).toBe(false);
    expect(() => budget.charge("unknown" as "route")).toThrow(RangeError);
  });

  it("returns immutable detached snapshots", () => {
    const budget = new FreshSchematicWorkBudget(3);
    const before = budget.snapshot();
    budget.charge("tree");
    expect(before.consumed).toBe(0);
    expect(before.counters.tree).toBe(0);
    expect(Object.isFrozen(before)).toBe(true);
    expect(Object.isFrozen(before.counters)).toBe(true);
    expect(budget.snapshot().consumed).toBe(1);
  });

  it("publishes no partial value when a producer ignores exhaustion", () => {
    const budget = new FreshSchematicWorkBudget(2);
    const result = withFreshSchematicWorkBudget(budget, (work) => {
      work.charge("route", 3);
      return { wires: ["incomplete"] };
    });
    expect(result.status).toBe("exhausted");
    expect(result).not.toHaveProperty("value");
    let called = false;
    expect(withFreshSchematicWorkBudget(budget, () => { called = true; return "not allowed"; }).status).toBe("exhausted");
    expect(called).toBe(false);
  });

  it("retains aggregate consumption across separate planning phases and propagates exceptions", () => {
    const budget = new FreshSchematicWorkBudget(3);
    expect(withFreshSchematicWorkBudget(budget, (work) => { work.charge("tree", 2); return "tree"; })).toMatchObject({ status: "complete", value: "tree", work: { consumed: 2 } });
    expect(withFreshSchematicWorkBudget(budget, (work) => { work.charge("label", 2); return "partial labels"; })).not.toHaveProperty("value");
    expect(() => withFreshSchematicWorkBudget(new FreshSchematicWorkBudget(), () => { throw new Error("producer failed"); })).toThrow("producer failed");
  });

  it("cannot publish promises or thenables as a completed planning phase", () => {
    expect(() => withFreshSchematicWorkBudget(new FreshSchematicWorkBudget(), () => Promise.resolve("unfinished"))).toThrow(/synchronously/u);
    expect(() => withFreshSchematicWorkBudget(new FreshSchematicWorkBudget(), () => ({ then: () => undefined }))).toThrow(/synchronously/u);
  });
});
