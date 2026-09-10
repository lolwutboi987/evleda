import type { CallToolResult } from "@modelcontextprotocol/client";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { prepareFreshSchematicConnectivityBatch, validateFreshSchematicConnectivityBatchReceipt, type FreshSchematicBatchLabel, type FreshSchematicBatchRequest } from "../../src/harness/fresh-schematic-connectivity-batch.js";
import { parseFreshSchematicConnectivityPrimitiveInventory } from "../../src/harness/fresh-kicad-parser.js";
import { expectedFreshSchematicCompletePlanGeometry } from "../../src/harness/fresh-schematic-writer-geometry.js";
import { FreshSchematicWorkBudget } from "../../src/harness/fresh-schematic-work-budget.js";

interface Case { name: string; request: FreshSchematicBatchRequest; reply: CallToolResult; beforeSource: string; afterSource: string }
const fixtures = JSON.parse(readFileSync(new URL("../fixtures/fresh-project/schematic-batch-offline-producer.json", import.meta.url), "utf8")) as {
  provenance: { nativeCalls: number; actualDoc2WriterCallsPerCase: number; producerProtocolSha256: string }; cases: Case[];
};
const prepare = (example: Case, budget = new FreshSchematicWorkBudget()) => prepareFreshSchematicConnectivityBatch({
  projectFile: example.request.project_file, schematicFile: example.request.schematic_file, beforeSource: example.beforeSource,
  wires: example.request.wires.map((wire) => ({ start: { x: wire.x1_mm, y: wire.y1_mm }, end: { x: wire.x2_mm, y: wire.y2_mm } })),
  labels: example.request.global_labels, noConnects: example.request.no_connects.map((point) => ({ x: point.x_mm, y: point.y_mm })),
}, budget);
const validate = (example: Case) => {
  const plan = prepare(example);
  if (plan.status !== "complete") throw new Error("fixture planning exhausted");
  return validateFreshSchematicConnectivityBatchReceipt({ result: example.reply, plan: plan.value,
    beforeSource: Buffer.from(example.beforeSource), afterSource: Buffer.from(example.afterSource),
    beforeInventory: parseFreshSchematicConnectivityPrimitiveInventory(example.beforeSource), afterInventory: parseFreshSchematicConnectivityPrimitiveInventory(example.afterSource),
  });
};
const changedReceipt = (example: Case, change: (receipt: Record<string, any>) => void): Case => {
  const clone = structuredClone(example);
  change(clone.reply.structuredContent!);
  clone.reply.content = [{ type: "text", text: JSON.stringify(clone.reply.structuredContent) }];
  return clone;
};

describe("versioned complete-plan batch normalization", () => {
  it("uses actual offline producer captures, not hand-authored/native receipts", () => {
    expect(fixtures.provenance).toMatchObject({ nativeCalls: 0, actualDoc2WriterCallsPerCase: 1, producerProtocolSha256: "aee9ad59039ee512a13b8d7f3994841e0200eacabfd58bc2b2f2f793a7ede8c9" });
  });
  it.each(fixtures.cases)("independently matches actual producer request/receipt/source: $name", (example) => {
    const plan = prepare(example);
    expect(plan.status).toBe("complete");
    if (plan.status !== "complete") throw new Error("fixture planning exhausted");
    expect(plan.value.request).toEqual(example.request);
    expect(plan.value.expectedGeometry.wires).toHaveLength(2);
    expect(plan.value.expectedGeometry.junctions).toHaveLength(1);
    expect(validate(example)).toMatchObject({ applied: true, before: contentIdentity(example.beforeSource), after: contentIdentity(example.afterSource),
      submittedCounts: { wires: 3, global_labels: 2, no_connects: 1, junctions: 1 }, appliedCounts: { wires: 2 } });
  });
  it("does not invent a junction at an unanchored four-way interior crossing", () => {
    const result = expectedFreshSchematicCompletePlanGeometry([
      { start: { x: 0, y: 1 }, end: { x: 2, y: 1 } }, { start: { x: 1, y: 0 }, end: { x: 1, y: 2 } },
    ]);
    expect(result.status).toBe("complete");
    if (result.status === "complete") expect(result.value.junctions).toEqual([]);
  });
  it("preserves explicit planned endpoint connection intent when one-pass merging makes a four-way crossing", () => {
    const result = expectedFreshSchematicCompletePlanGeometry([
      { start: { x: 0, y: 1 }, end: { x: 1, y: 1 } }, { start: { x: 1, y: 1 }, end: { x: 2, y: 1 } },
      { start: { x: 1, y: 0 }, end: { x: 1, y: 2 } },
    ]);
    expect(result.status).toBe("complete");
    if (result.status === "complete") expect(result.value.junctions).toEqual([{ x: 1, y: 1 }]);
  });
  it.each(["diagonal", "zero", "duplicate", "reversed", "rounding"] as const)("rejects unsupported complete input: %s", (kind) => {
    const segment = { start: { x: 0, y: 0 }, end: { x: 1, y: 0 } };
    const wires = kind === "diagonal" ? [{ ...segment, end: { x: 1, y: 1 } }]
      : kind === "zero" ? [{ ...segment, end: segment.start }]
        : kind === "rounding" ? [{ ...segment, end: { x: 0.12345, y: 0 } }]
          : kind === "duplicate" ? [segment, segment] : [segment, { start: segment.end, end: segment.start }];
    expect(() => expectedFreshSchematicCompletePlanGeometry(wires)).toThrow();
  });
  it("exposes no partial geometry or request after aggregate exhaustion", () => {
    const result = prepare(fixtures.cases[0]!, new FreshSchematicWorkBudget(1));
    expect(result.status).toBe("exhausted");
    expect(result).not.toHaveProperty("value");
  });
  it("rejects non-four-decimal markers and duplicate label payloads before dispatch", () => {
    const example = structuredClone(fixtures.cases[0]!);
    example.request = { ...example.request, no_connects: [{ x_mm: 0.12345, y_mm: 0 }] };
    expect(() => prepare(example)).toThrow();
    const repeated = structuredClone(fixtures.cases[0]!);
    repeated.request = { ...repeated.request, global_labels: [...repeated.request.global_labels, repeated.request.global_labels[0]! as FreshSchematicBatchLabel] };
    expect(() => prepare(repeated)).toThrow(/duplicate/u);
  });
});

describe("strict receipt, actual primitive associations, and source preservation", () => {
  it.each(["version", "normalization", "before", "after", "path", "counts", "uuid-association", "operation-missing", "operation-duplicate", "operation-index", "reload", "unknown-field"] as const)("rejects contradictory receipt: %s", (kind) => {
    const example = changedReceipt(fixtures.cases[0]!, (receipt) => {
      if (kind === "version") receipt.schemaVersion = "wrong";
      if (kind === "normalization") receipt.normalizationVersion = "sequential-prefix";
      if (kind === "before") receipt.before.digest = "a".repeat(64);
      if (kind === "after") receipt.after.digest = "b".repeat(64);
      if (kind === "path") receipt.schematicFile += ".other";
      if (kind === "counts") receipt.appliedCounts.wires += 1;
      if (kind === "uuid-association") [receipt.inventory.wires[0].uuid, receipt.inventory.wires[1].uuid] = [receipt.inventory.wires[1].uuid, receipt.inventory.wires[0].uuid];
      if (kind === "operation-missing") receipt.operationReceipt.pop();
      if (kind === "operation-duplicate") receipt.operationReceipt[1] = receipt.operationReceipt[0];
      if (kind === "operation-index") receipt.operationReceipt[0].resultingPrimitiveIndices = [4095];
      if (kind === "reload") receipt.reload.confirmed = true;
      if (kind === "unknown-field") receipt.trustMe = true;
    });
    expect(() => validate(example)).toThrow();
  });
  it("rejects divergent text/structured envelopes and error results", () => {
    const text = structuredClone(fixtures.cases[0]!);
    text.reply.content = [{ type: "text", text: "{}" }];
    expect(() => validate(text)).toThrow(/contradict/u);
    const error = structuredClone(fixtures.cases[0]!);
    error.reply.isError = true;
    expect(() => validate(error)).toThrow(/envelope/u);
  });
  it("rejects unrelated source mutation even if the producer updates its after hash", () => {
    const example = structuredClone(fixtures.cases[0]!);
    example.afterSource = example.afterSource.replace("(version ", "(version 1");
    const changed = changedReceipt(example, (receipt) => { receipt.after = contentIdentity(example.afterSource); });
    expect(() => validate(changed)).toThrow(/unrelated/u);
  });
  it("rejects actual geometry drift despite coherent updated receipt/source hash", () => {
    const example = structuredClone(fixtures.cases[0]!);
    const actual = parseFreshSchematicConnectivityPrimitiveInventory(example.afterSource);
    const wire = actual.wires[0]!;
    const old = `(xy ${wire.start.x} ${wire.start.y})`;
    expect(example.afterSource).toContain(old);
    example.afterSource = example.afterSource.replace(old, `(xy ${wire.start.x - 1} ${wire.start.y})`);
    const changed = changedReceipt(example, (receipt) => {
      receipt.after = contentIdentity(example.afterSource);
      const target = receipt.inventory.wires.find((candidate: { uuid: string }) => candidate.uuid === wire.uuid);
      target.x1_mm = wire.start.x - 1;
    });
    expect(() => validate(changed)).toThrow(/host.*plan/u);
  });
});
