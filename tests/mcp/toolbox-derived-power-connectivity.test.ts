import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import type { HarnessToolCall, HarnessToolResult } from "../../src/harness/contracts.js";
import { createFreshConnectivityContract } from "../../src/harness/fresh-connectivity-contract.js";
import { serializeFreshContractConnectivityResult } from "../../src/harness/kicad-tools.js";
import { DEFAULT_PCB_HARNESS_VALIDATION_TOOLS, runPcbAgentHarness } from "../../src/harness/pcb-agent-harness.js";
import { createKicadToolboxMcpServer } from "../../src/mcp/toolbox-server.js";
import type { ConnectedKicadToolbox } from "../../src/mcp/toolbox-session.js";
import { cleanupDerivedPowerFixtures, derivedPowerDraft, derivedPowerFixture } from "../helpers/derived-power-bundle.js";

// All CAD operations are synthetic responses. No native process is started.
afterEach(cleanupDerivedPowerFixtures);
const toolName = "fresh_apply_contract_connectivity";
function boundDesign(mixed = true) {
  const draft = derivedPowerDraft();
  if (!mixed) delete draft.externalPowerInputs;
  const f = derivedPowerFixture(draft);
  const contract = createFreshConnectivityContract(f.bundle.contract, f.bundle.externalPowerBinding, f.bundle.derivedPowerBinding);
  return { ...f, contract };
}
type Design = ReturnType<typeof boundDesign>;
function payloadFor(f: Design, idempotent = false, advisories = false): Record<string, unknown> {
  return JSON.parse(serializeFreshContractConnectivityResult(f.contract, {
    applied: true, mutated: !idempotent, idempotent, issues: [],
    ...(idempotent ? { nativeNetlistSha256: "a".repeat(64), nativeNetCount: f.contract.nets.length, nativeComponentCount: f.contract.components.length } : {
      powerAnnotations: f.bundle.derivedPowerBinding!.flags.map((flag, index) => ({ reference: flag.reference, x: 25.4 * (index + 1), y: 25.4, rotation: 0 as const })),
      powerAnnotationBindingIdentity: f.bundle.derivedPowerBinding!.identity,
      ...(advisories ? { powerFlagPlacementAdvisories: f.bundle.derivedPowerBinding!.flags.map((flag, index) => {
        const x = 25.4 * (index + 1), y = 25.4, nearX = x + 8.89, nearY = y + 2.54;
        return { code: "NATIVE_SYMBOL_CENTER_PROXIMITY" as const, reference: flag.reference, at: { x, y }, nearReference: "R3", nearAt: { x: nearX, y: nearY },
          warning: `WARNING: coordinate (${x.toFixed(2)}, ${y.toFixed(2)}) is 9.2 mm from 'R3' at (${nearX.toFixed(2)}, ${nearY.toFixed(2)}) — symbols may overlap. Use sch_find_free_placement to get a safe coordinate.`,
          beforeSchematicContentIdentity: contentIdentity(`synthetic before ${index}`), afterSchematicContentIdentity: contentIdentity(`synthetic after ${index}`),
          nativeReplyContentIdentity: contentIdentity(`synthetic reply ${index}`) };
      }) } : {}),
    }),
  }));
}
async function fixture(f: Design, payload = payloadFor(f), bound = true, alterContext?: (context: Record<string, unknown>) => void) {
  const order: string[] = [];
  const execute = vi.fn(async (call: HarnessToolCall): Promise<HarnessToolResult> => {
    order.push(call.name); return { toolCallId: call.id, content: JSON.stringify(payload) };
  });
  const save = vi.fn(async (call: HarnessToolCall): Promise<HarnessToolResult> => {
    order.push("save"); return { toolCallId: call.id, content: "synthetic saved readback" };
  });
  const readback = vi.fn(async (call: HarnessToolCall): Promise<HarnessToolResult> => {
    order.push(call.name); return { toolCallId: call.id, content: "synthetic connectivity" };
  });
  const context = {
    projectBindingIdentity: canonicalIdentity({ fixture: true }, "evleda.pcb-agent-plane-fresh-binding.v1"),
    sourceContractIdentity: f.bundle.contract.identity,
    ...(bound ? {
      ...(f.bundle.externalPowerBinding === undefined ? {} : { externalPowerBinding: structuredClone(f.bundle.externalPowerBinding) }),
      derivedPowerBinding: structuredClone(f.bundle.derivedPowerBinding!),
    } : {}),
  };
  alterContext?.(context);
  const publish = vi.fn(async () => {}), closeNative = vi.fn(async () => {});
  const prepareCheckpoint = vi.fn(async () => publish), recordRecoveryRequired = vi.fn(async () => {});
  const cad: ConnectedKicadToolbox = {
    tools: {
      tools: [{ name: toolName, description: "Apply bound connectivity", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
      execute, internal: { execute: readback, saveAfterMutation: save }, freshBoardSaveAudits: [],
      captureFreshPcbPadEvidence: async () => undefined,
      runFinalValidation: async () => ({ erc: {}, drc: {}, boardSummary: {}, visualQa: {} }),
    },
    planeAuthoringContext: context, assertCurrent: vi.fn(async () => {}), captureSources: async () => "synthetic saved source",
    prepareCheckpoint, recordRecoveryRequired, close: closeNative,
  };
  const toolbox = createKicadToolboxMcpServer({ cad, access: "edit", compoundContractIdentity: f.contract.identity });
  const client = new Client({ name: "derived-power-boundary", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await toolbox.server.connect(right); await client.connect(left);
  return { client, toolbox, order, context, execute, save, readback, publish, closeNative, prepareCheckpoint, recordRecoveryRequired,
    close: async () => { await client.close(); await toolbox.close(); } };
}
const annotations = (payload: Record<string, unknown>) => payload.powerAnnotations as Array<Record<string, unknown>>;
const faults: ReadonlyArray<{ name: string; corrupt(payload: Record<string, unknown>, f: Design): void }> = [
  { name: "missing annotation identity", corrupt: p => { delete p.powerAnnotationBindingIdentity; } },
  { name: "missing annotation inventory", corrupt: p => { delete p.powerAnnotations; } },
  { name: "missing both annotation fields", corrupt: p => { delete p.powerAnnotations; delete p.powerAnnotationBindingIdentity; } },
  { name: "foreign identity", corrupt: p => { p.powerAnnotationBindingIdentity = { ...(p.powerAnnotationBindingIdentity as object), digest: "f".repeat(64) }; } },
  { name: "wrong identity schema", corrupt: p => { p.powerAnnotationBindingIdentity = { ...(p.powerAnnotationBindingIdentity as object), schemaVersion: "evleda.pcb-external-power-binding.v1" }; } },
  { name: "missing combined flag", corrupt: p => { annotations(p).pop(); } },
  { name: "duplicate reference", corrupt: p => { annotations(p)[1]!.reference = annotations(p)[0]!.reference; } },
  { name: "noncanonical references", corrupt: p => { annotations(p).reverse(); } },
  { name: "unknown annotation field", corrupt: p => { annotations(p)[0]!.net = "GND"; } },
  { name: "invalid coordinates", corrupt: p => { annotations(p)[0]!.x = 2000.001; } },
  { name: "unsupported rotation", corrupt: p => { annotations(p)[0]!.rotation = 90; } },
  { name: "inventory beyond combined limit", corrupt: p => { p.powerAnnotations = Array.from({ length: 17 }, (_, i) => ({ reference: `#FLG${String(i + 1).padStart(3, "0")}`, x: i, y: 0, rotation: 0 })); } },
  { name: "conflicting receipt branches", corrupt: (p, f) => { p.externalPowerAnnotations = annotations(p).slice(0, f.bundle.externalPowerBinding!.flags.length); p.externalPowerBindingIdentity = f.bundle.externalPowerBinding!.identity; } },
  { name: "legacy external receipt for mixed design", corrupt: (p, f) => { p.externalPowerAnnotations = annotations(p).slice(0, f.bundle.externalPowerBinding!.flags.length); p.externalPowerBindingIdentity = f.bundle.externalPowerBinding!.identity; delete p.powerAnnotations; delete p.powerAnnotationBindingIdentity; } },
];

describe("public toolbox combined derived power receipt boundary", () => {
  it.each([false, true])("accepts complete or truncated production advisories for mixed=%s through save/readback/checkpoint", async mixed => {
    const d = boundDesign(mixed), payload = payloadFor(d, false, true), f = await fixture(d, payload);
    try {
      const result = await f.client.callTool({ name: toolName, arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(f.order).toEqual([toolName, "save", "sch_get_connectivity_graph"]);
      expect(JSON.parse((result.structuredContent as { result: HarnessToolResult }).result.content).powerFlagPlacementAdvisories).toEqual(payload.powerFlagPlacementAdvisories);
      expect((await f.client.callTool({ name: "evleda_toolbox_status", arguments: {} })).structuredContent).toMatchObject({ recoveryRequired: false });
    } finally { await f.close(); }
    expect(f.publish).toHaveBeenCalledOnce(); expect(f.recordRecoveryRequired).not.toHaveBeenCalled();
  });
  it.each([false, true])("accepts %s mixed binding, saves and reads back before checkpoint publication", async mixed => {
    const f = await fixture(boundDesign(mixed));
    try {
      expect((await f.client.callTool({ name: toolName, arguments: {} })).isError).not.toBe(true);
      expect(f.order).toEqual([toolName, "save", "sch_get_connectivity_graph"]);
    } finally { await f.close(); }
    expect(f.publish).toHaveBeenCalledOnce(); expect(f.closeNative).toHaveBeenCalledOnce();
    expect(f.recordRecoveryRequired).not.toHaveBeenCalled();
  });
  it("accepts idempotent native parity without annotation receipt or another save", async () => {
    const d = boundDesign(false), f = await fixture(d, payloadFor(d, true));
    try {
      expect((await f.client.callTool({ name: toolName, arguments: {} })).isError).not.toBe(true);
      expect(f.order).toEqual([toolName, "sch_get_connectivity_graph"]); expect(f.save).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it("detaches the combined host binding from later caller mutation", async () => {
    const f = await fixture(boundDesign());
    Object.assign(f.context.derivedPowerBinding!.identity, { digest: "f".repeat(64) });
    Object.assign(f.context.derivedPowerBinding!.flags[0]!, { reference: "#FLG999" });
    try { expect((await f.client.callTool({ name: toolName, arguments: {} })).isError).not.toBe(true); }
    finally { await f.close(); }
  });
  it.each(["missing external child", "wrong external child", "wrong source contract"] as const)("rejects %s during host attachment", async fault => {
    const d = boundDesign();
    await expect(fixture(d, payloadFor(d), true, context => {
      if (fault === "missing external child") delete context.externalPowerBinding;
      else if (fault === "wrong source contract") context.sourceContractIdentity = { ...d.bundle.contract.identity, digest: "f".repeat(64) };
      else context.externalPowerBinding = { ...d.bundle.externalPowerBinding!, identity: { ...d.bundle.externalPowerBinding!.identity, digest: "f".repeat(64) } };
    })).rejects.toThrow();
  });
  it.each(faults)("rejects $name before save/readback and poisons checkpoint publication", async ({ corrupt }) => {
    const d = boundDesign(), payload = payloadFor(d); corrupt(payload, d);
    const f = await fixture(d, payload);
    try {
      expect((await f.client.callTool({ name: toolName, arguments: {} })).isError).toBe(true);
      expect((await f.client.callTool({ name: "evleda_toolbox_status", arguments: {} })).structuredContent).toMatchObject({ recoveryRequired: true });
      expect((await f.client.callTool({ name: toolName, arguments: {} })).isError).toBe(true);
      expect(f.execute).toHaveBeenCalledOnce(); expect(f.save).not.toHaveBeenCalled(); expect(f.readback).not.toHaveBeenCalled();
    } finally { await f.close(); }
    expect(f.prepareCheckpoint).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled();
    expect(f.recordRecoveryRequired).toHaveBeenCalledOnce();
  });
  it("rejects generic receipts without trusted derived binding", async () => {
    const d = boundDesign(false), f = await fixture(d, payloadFor(d), false);
    try { expect((await f.client.callTool({ name: toolName, arguments: {} })).isError).toBe(true); expect(f.save).not.toHaveBeenCalled(); }
    finally { await f.close(); }
    expect(f.publish).not.toHaveBeenCalled();
  });
  it.each(["save", "readback"] as const)("requires recovery when %s fails after accepted combined receipt", async boundary => {
    const d = boundDesign(), f = await fixture(d, payloadFor(d, false, true));
    f[boundary].mockImplementation(async call => ({ toolCallId: call.id, content: "synthetic boundary failure", isError: true }));
    try {
      expect((await f.client.callTool({ name: toolName, arguments: {} })).isError).toBe(true);
      expect((await f.client.callTool({ name: "evleda_toolbox_status", arguments: {} })).structuredContent).toMatchObject({ recoveryRequired: true });
    } finally { await f.close(); }
    expect(f.publish).not.toHaveBeenCalled(); expect(f.recordRecoveryRequired).toHaveBeenCalledOnce();
  });
  it.each([false, true])("validates derived receipts in the provider harness after a preceding mutation: malformed=%s", async malformed => {
    const d = boundDesign(), payload = payloadFor(d, false, true), calls: string[] = [];
    if (malformed) { delete payload.powerAnnotations; delete payload.powerAnnotationBindingIdentity; }
    const compound = { name: toolName, description: "Apply connectivity", inputSchema: { type: "object" } };
    const earlier = { name: "pcb_place_component", description: "Synthetic earlier mutation", inputSchema: { type: "object" } };
    const readback = { name: "sch_get_connectivity_graph", description: "Read connectivity", inputSchema: { type: "object" } };
    const validation = Object.values(DEFAULT_PCB_HARNESS_VALIDATION_TOOLS).map(name => ({ name, description: name, inputSchema: { type: "object" } }));
    const report = await runPcbAgentHarness({ userPrompt: "Apply reviewed derived supplies", fixedRules: ["Preserve the complete bound annotation inventory."],
      projectPath: "C:/synthetic/board.kicad_pro", reportPath: "C:/synthetic/report.json", editsRequired: true,
      allowedToolNames: [earlier, compound], maxIterations: 1 },
    { provider: "synthetic", turn: async () => ({ message: { role: "assistant", content: "Apply bound supplies." }, stopReason: "tool_calls",
      toolCalls: [{ id: "earlier", name: earlier.name, arguments: {} }, { id: "power", name: toolName, arguments: {} }] }) },
    { tools: [earlier, compound, readback, ...validation], execute: async call => {
      calls.push(call.name);
      const result = call.name === toolName ? payload : call.name === "pcb_get_board_summary"
        ? { status: "clean", findings: [], metadata: { footprints: 5, pads: 15, nets: 7, tracks: 1, shapes: 1 } }
        : call.name === "pcb_visual_qa" ? { status: "PASS", findings: [], footprint_count: 5, board_bounds: [0, 0, 30, 20] }
          : { status: "clean", findings: [] };
      return { toolCallId: call.id, content: JSON.stringify(result) };
    } },
    { compoundMutationContractIdentity: d.contract.identity, compoundMutationDerivedPowerBinding: d.bundle.derivedPowerBinding!,
      compoundMutationExternalPowerBinding: d.bundle.externalPowerBinding!, postSchematicReadbackTool: readback.name,
      completionGate: async () => ({ passed: false, missing: ["Synthetic fixture remains unqualified."] }) });
    expect(report.status).toBe(malformed ? "blocked" : "needs_review");
    if (malformed) { expect(calls).toEqual([earlier.name, toolName]); expect(report.validation.runs).toBe(0); }
    else { expect(calls).toEqual([earlier.name, toolName, "pcb_save", readback.name, "run_erc", "run_drc", "pcb_get_board_summary", "pcb_visual_qa"]); expect(report.validation.runs).toBe(1); }
  });
});
