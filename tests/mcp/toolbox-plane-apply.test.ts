import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import type { HarnessToolCall, HarnessToolResult } from "../../src/harness/contracts.js";
import { createKicadToolboxMcpServer } from "../../src/mcp/toolbox-server.js";
import type { ConnectedKicadToolbox } from "../../src/mcp/toolbox-session.js";

const sourceContractIdentity = canonicalIdentity({ plane: "GND" }, "evleda.pcb-design-contract.v2");
const connectivityIdentity = canonicalIdentity({ sourceContractIdentity }, "evleda.fresh-connectivity-contract.v1");
const projectBindingIdentity = canonicalIdentity({ sourceContractIdentity }, "evleda.pcb-agent-plane-fresh-binding.v1");
const schemaVersion = "evleda.fresh-plane-apply-result.v1";
const toolName = "fresh_apply_contract_plane";

function applyPayload(sourceChanged: boolean) {
  const before = contentIdentity("saved plane");
  const body = {
    schemaVersion, contractIdentity: connectivityIdentity, sourceContractIdentity,
    planeProjectBindingIdentity: projectBindingIdentity, freshMarkerContentIdentity: contentIdentity("marker"),
    planeId: "GND", targetZoneUuid: "11111111-1111-4111-8111-111111111111", operation: "update",
    preparedSpecIdentity: canonicalIdentity({ plane: "GND" }, "evleda.fresh-plane-mutation-spec.v1"),
    beforePcbContentIdentity: before, stagedPcbContentIdentity: sourceChanged ? contentIdentity("refilled plane") : before,
    stageReceiptIdentity: contentIdentity("full native stage receipt"),
    mutationComparisonIdentity: canonicalIdentity({ valid: true }, "evleda.fresh-plane-mutation-comparison.v1"),
    requirements: { minimumIslandAreaMm2: 2, minimumAreaEnforcement: "not-enforced-by-always-mode",
      minimumSpokes: 2, spokeEnforcement: "external-owned-rule-and-native-evidence" },
    applied: true, mutated: true, idempotent: false, nativeActionsPerformed: true, sourceChanged,
    completion: "not_evaluated", connection: "not_evaluated", referenceCoverage: "not_evaluated",
    thermalAcceptance: "not_evaluated", islandAreaAcceptance: "not_evaluated",
    nativeSaveCalledByStage: false, acceptanceEvaluated: false, issues: [],
  };
  return { ...body, identity: canonicalIdentity(body, schemaVersion) };
}

async function fixture(options: { planeContext?: boolean; contract?: boolean; access?: "edit" | "read-only"; sourceChanged?: boolean } = {}) {
  const order: string[] = [];
  const execute = vi.fn(async (call: HarnessToolCall): Promise<HarnessToolResult> => {
    order.push(call.name);
    return { toolCallId: call.id, content: JSON.stringify(applyPayload(options.sourceChanged ?? true)) };
  });
  const save = vi.fn(async (call: HarnessToolCall): Promise<HarnessToolResult> => {
    order.push("save"); return { toolCallId: call.id, content: "saved and read back" };
  });
  // A generic source-only classification cannot settle a native refill. It is
  // deliberately available here so the public path must choose not to call it.
  const classify = vi.fn(async () => ({ schemaVersion: "evleda.mutation-batch-disposition.v1" as const,
    status: "no-governed-effect" as const, domain: "schematic-file" as const,
    baselineSha256: "a".repeat(64), observedSha256: "a".repeat(64) }));
  const assertCurrent = vi.fn(async () => {});
  const nativeClose = vi.fn(async () => {}), publish = vi.fn(async () => {});
  const prepareCheckpoint = vi.fn(async () => publish), recordRecoveryRequired = vi.fn(async (_reason: string) => {});
  const cad: ConnectedKicadToolbox = {
    tools: {
      tools: [{ name: toolName, description: "Apply the host-bound plane and refill", inputSchema: {
        type: "object", properties: { planeId: { type: "string", minLength: 1, maxLength: 64 } }, additionalProperties: false,
      } }],
      execute, internal: { execute, saveAfterMutation: save, classifyPendingMutationBatch: classify },
      freshBoardSaveAudits: [], captureFreshPcbPadEvidence: async () => undefined,
      runFinalValidation: async () => ({ erc: {}, drc: {}, boardSummary: {}, visualQa: {} }),
    },
    ...(options.planeContext === false ? {} : { planeAuthoringContext: { projectBindingIdentity, sourceContractIdentity } }),
    assertCurrent, captureSources: async () => "saved sources", close: nativeClose, prepareCheckpoint, recordRecoveryRequired,
  };
  const toolbox = createKicadToolboxMcpServer({ cad, access: options.access ?? "edit",
    ...(options.contract === false ? {} : { compoundContractIdentity: connectivityIdentity }) });
  const client = new Client({ name: "plane-apply-boundary-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await toolbox.server.connect(right); await client.connect(left);
  return { client, toolbox, execute, save, classify, assertCurrent, nativeClose, publish, prepareCheckpoint,
    recordRecoveryRequired, order, close: async () => { await client.close(); await toolbox.close(); } };
}

describe("public toolbox plane apply save boundary", () => {
  it.each([true, false])("saves native refill when sourceChanged=%s and never classifies it as no-effect", async sourceChanged => {
    const f = await fixture({ sourceChanged });
    try {
      const result = await f.client.callTool({ name: toolName, arguments: { planeId: "GND" } });
      expect(result.isError).not.toBe(true);
      expect(f.order).toEqual([toolName, "save"]); expect(f.classify).not.toHaveBeenCalled();
      expect(result.structuredContent).toMatchObject({ operation: toolName, noGovernedEffect: false,
        persistence: { content: "saved and read back" } });
      expect((await f.client.callTool({ name: "evleda_toolbox_status", arguments: {} })).structuredContent)
        .toMatchObject({ recoveryRequired: false });
      const outer = result.structuredContent as { result: HarnessToolResult };
      const body = JSON.parse(outer.result.content);
      expect(body).toMatchObject({ sourceChanged, nativeActionsPerformed: true, acceptanceEvaluated: false });
    } finally { await f.close(); }
    expect(f.publish).toHaveBeenCalledOnce(); expect(f.nativeClose).toHaveBeenCalledOnce();
  });

  it.each([{ planeContext: false }, { contract: false }, { access: "read-only" as const }])("requires exact host plane context, contract and edit access: %j", async options => {
    const f = await fixture(options);
    try {
      expect((await f.client.listTools()).tools.map(tool => tool.name)).not.toContain(toolName);
      await expect(f.client.callTool({ name: toolName, arguments: {} })).rejects.toThrow("not found");
      expect(f.execute).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it.each(["invalid payload", "error envelope"])("preserves uncertainty and does not save after %s", async fault => {
    const f = await fixture();
    f.execute.mockImplementation(async call => ({ toolCallId: call.id,
      content: fault === "invalid payload" ? "{}" : JSON.stringify(applyPayload(true)),
      ...(fault === "error envelope" ? { isError: true } : {}) }));
    try {
      expect((await f.client.callTool({ name: toolName, arguments: {} })).isError).toBe(true);
      expect((await f.client.callTool({ name: toolName, arguments: {} })).isError).toBe(true);
      expect(f.execute).toHaveBeenCalledOnce(); expect(f.save).not.toHaveBeenCalled(); expect(f.classify).not.toHaveBeenCalled();
    } finally { await f.close(); }
    expect(f.prepareCheckpoint).not.toHaveBeenCalled(); expect(f.recordRecoveryRequired).toHaveBeenCalledOnce();
    expect(f.nativeClose).toHaveBeenCalledOnce();
  });

  it("retains recovery state when mandatory native save fails, including source-equivalent updates", async () => {
    const f = await fixture({ sourceChanged: false });
    f.save.mockImplementation(async call => ({ toolCallId: call.id, content: "save failed", isError: true }));
    try {
      expect((await f.client.callTool({ name: toolName, arguments: {} })).isError).toBe(true);
      expect((await f.client.callTool({ name: toolName, arguments: {} })).isError).toBe(true);
      expect(f.execute).toHaveBeenCalledOnce(); expect(f.save).toHaveBeenCalledOnce();
    } finally { await f.close(); }
    expect(f.publish).not.toHaveBeenCalled(); expect(f.recordRecoveryRequired).toHaveBeenCalledOnce();
  });

  it("will not save a changed active document after a valid stage result", async () => {
    const f = await fixture(); let current = true;
    f.assertCurrent.mockImplementation(async () => { if (!current) throw new Error("active document changed"); });
    f.execute.mockImplementation(async call => { current = false; return { toolCallId: call.id, content: JSON.stringify(applyPayload(true)) }; });
    try {
      expect((await f.client.callTool({ name: toolName, arguments: {} })).isError).toBe(true);
      expect(f.save).not.toHaveBeenCalled();
    } finally { await f.close(); }
    expect(f.publish).not.toHaveBeenCalled();
  });

  it("serializes complete plane apply/save intervals", async () => {
    const f = await fixture();
    try {
      const results = await Promise.all([1, 2].map(() => f.client.callTool({ name: toolName, arguments: {} })));
      expect(results.every(result => !result.isError)).toBe(true);
      expect(f.order).toEqual([toolName, "save", toolName, "save"]);
    } finally { await f.close(); }
  });
});
