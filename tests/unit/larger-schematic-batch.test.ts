import { readFile, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { largerSchematicBatchFixture } from "../helpers/larger-schematic-batch.js";
import { parseFreshSchematicSource } from "../../src/harness/fresh-kicad-parser.js";

const roots = new Set<string>();
afterEach(async () => { for (const root of roots) { await rm(root, { recursive: true, force: true }); roots.delete(root); } });
const fixture = async (...args: Parameters<typeof largerSchematicBatchFixture>) => { const value = await largerSchematicBatchFixture(...args); roots.add(value.root); return value; };
const call = { id: "connect", name: "fresh_apply_contract_connectivity", arguments: {} } as const;
const save = { id: "save", name: "pcb_save", arguments: {} } as const;

describe("source-bound larger schematic private batch path (fake MCP, not native design proof)", () => {
  it("authors repeated terminal labels through one batch, save and exact idempotent replay with current glyphs", async () => {
    const current = await fixture("terminal-label-bank");
    const result = JSON.parse((await current.bridge.execute(call)).content);
    expect(result, JSON.stringify(result)).toMatchObject({ applied: true, mutated: true, issues: [] });
    const source = await readFile(current.fresh.schematicPath, "utf8");
    expect(parseFreshSchematicSource(source).labels).toHaveLength(80);
    expect(current.batchCalls).toBe(1);
    expect((await current.bridge.internal.saveAfterMutation(save)).isError).not.toBe(true);
    const repeated = JSON.parse((await current.bridge.execute({ ...call, id: "terminal-repeat" })).content);
    expect(repeated, JSON.stringify(repeated)).toMatchObject({ applied: true, mutated: false, idempotent: true });
    expect(current.batchCalls).toBe(1);
    expect(await readFile(current.fresh.schematicPath, "utf8")).toBe(source);
  });
  it("replaces overlapping DOC9 default boxes with complete source and native-ink obstacles for a compact bank", async () => {
    const current = await fixture("resistor-bank", "compact-native-text");
    const result = JSON.parse((await current.bridge.execute(call)).content);
    expect(result).toMatchObject({ applied: true, mutated: true, issues: [] });
    expect(current.batchCalls).toBe(1);
    expect((await current.bridge.internal.saveAfterMutation(save)).isError).not.toBe(true);
    const repeated = JSON.parse((await current.bridge.execute({ ...call, id: "compact-repeat" })).content);
    expect(repeated, JSON.stringify(repeated)).toMatchObject({ applied: true, mutated: false, idempotent: true });
    expect(current.batchCalls).toBe(1);
  });

  it.each(["unsupported-native-text", "native-text-obstruction", "unsupported-pin-marker", "unsupported-source-graphic"] as const)("retains %s as a blocker before compact connectivity mutation", async fault => {
    const current = await fixture("resistor-bank", fault);
    const result = JSON.parse((await current.bridge.execute(call)).content);
    expect(result).toMatchObject({ applied: false, mutated: false });
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: fault === "native-text-obstruction" ? "LABEL_PLANNING_SPACE_UNAVAILABLE" : "UNSUPPORTED_BOUNDING_BOX_GEOMETRY" })]));
    expect(current.batchCalls).toBe(0);
    expect(await readFile(current.fresh.schematicPath, "utf8")).toBe(current.source);
  });

  it.each(["rp2350b", "resistor-bank"] as const)("preserves complete original pins through one batch and save/native parity: %s", async (kind) => {
    const current = await fixture(kind);
    const applied = await current.bridge.execute(call);
    expect(JSON.parse(applied.content)).toMatchObject({ applied: true, mutated: true, issues: [] });
    expect(current.batchCalls).toBe(1);
    expect(current.calls).not.toContain("sch_add_wire");
    const saved = await current.bridge.internal.saveAfterMutation(save);
    expect(saved.isError).not.toBe(true);
    expect(JSON.parse(saved.content)).toMatchObject({ nativeComponentCount: kind === "rp2350b" ? 1 : 16, nativeNetCount: 2 });
    expect(current.contract.nets.reduce((sum, net) => sum + net.endpoints.length, current.contract.noConnects.length)).toBe(kind === "rp2350b" ? 81 : 32);
    const repeated = await current.bridge.execute({ ...call, id: "idempotent" });
    expect(JSON.parse(repeated.content)).toMatchObject({ applied: true, mutated: false, idempotent: true });
    expect(current.batchCalls).toBe(1);
  });

  it.each(["missing-batch", "no-style"] as const)("fails before mutation when required authority/capability is absent: %s", async (fault) => {
    const current = await fixture("rp2350b", fault);
    const result = JSON.parse((await current.bridge.execute(call)).content);
    expect(result).toMatchObject({ applied: false, mutated: false });
    expect(result.issues.some((issue: { code: string }) => issue.code === (fault === "missing-batch" ? "SCHEMATIC_BATCH_CAPABILITY_UNAVAILABLE" : "UNSUPPORTED_BOUNDING_BOX_GEOMETRY"))).toBe(true);
    expect(current.batchCalls).toBe(0);
    expect(await readFile(current.fresh.schematicPath, "utf8")).toBe(current.source);
  });

  it("fails before mutation on aggregate planning exhaustion without reducing pin inventory", async () => {
    const current = await fixture("rp2350b", "none", 1);
    const result = JSON.parse((await current.bridge.execute(call)).content);
    expect(result).toMatchObject({ applied: false, mutated: false, issues: [expect.objectContaining({ code: "PLANNING_WORK_LIMIT" })] });
    expect(current.batchCalls).toBe(0);
    expect(await readFile(current.fresh.schematicPath, "utf8")).toBe(current.source);
  });

  it.each(["graph-member", "receipt-uuid", "after-source"] as const)("restores exact preimage and terminates on post-dispatch contradiction: %s", async (fault) => {
    const current = await fixture("rp2350b", fault);
    await expect(current.bridge.execute(call)).rejects.toThrow(/FRESH_CONNECTIVITY_ROLLED_BACK_TERMINAL/u);
    expect(current.batchCalls).toBe(1);
    expect(await readFile(current.fresh.schematicPath, "utf8")).toBe(current.source);
  });

  it("does not allow fake native parity to omit a stacked original member after save", async () => {
    const current = await fixture("rp2350b", "native-member");
    expect(JSON.parse((await current.bridge.execute(call)).content).applied).toBe(true);
    const saved = await current.bridge.internal.saveAfterMutation(save);
    expect(saved.isError).toBe(true);
    expect(saved.content).toMatch(/NATIVE_NET_ENDPOINT_PARITY_MISMATCH/u);
    expect(await readFile(current.fresh.schematicPath, "utf8")).toBe(current.source);
  });
});
