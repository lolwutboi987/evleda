import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import type { HarnessToolCall, HarnessToolResult } from "../../src/harness/contracts.js";
import { serializeFreshContractConnectivityResult } from "../../src/harness/kicad-tools.js";
import { PCB_EXTERNAL_POWER_BINDING_SCHEMA_VERSION, parsePcbExternalPowerBinding } from "../../src/harness/pcb-external-power.js";
import { createKicadToolboxMcpServer } from "../../src/mcp/toolbox-server.js";
import type { ConnectedKicadToolbox } from "../../src/mcp/toolbox-session.js";

// Synthetic host bindings and native responses only; these tests never open KiCad.
const toolName = "fresh_apply_contract_connectivity";
const sourceContractIdentity = canonicalIdentity({ purpose: "synthetic external connector supply" }, "evleda.pcb-design-contract.v2");
const connectivityIdentity = canonicalIdentity({ sourceContractIdentity }, "evleda.fresh-connectivity-contract.v1");
const projectBindingIdentity = canonicalIdentity({ sourceContractIdentity }, "evleda.pcb-agent-plane-fresh-binding.v1");
const bindingPayload = {
  schemaVersion: PCB_EXTERNAL_POWER_BINDING_SCHEMA_VERSION,
  contractIdentity: sourceContractIdentity,
  source: {
    symbolLibId: "power:PWR_FLAG",
    sourceIdentity: contentIdentity("synthetic stock flag library"),
    definitionIdentity: contentIdentity("synthetic stock flag definition"),
    definitionSemanticIdentity: contentIdentity("synthetic stock flag semantics"),
    inspectionIdentity: canonicalIdentity({ synthetic: "inspection" }, "evleda.pcb-external-power-flag-inspection.v1"),
    policyIdentity: canonicalIdentity({ synthetic: "policy" }, "evleda.pcb-external-power-flag-policy.v1"),
  },
  flags: [
    { reference: "#FLG001", net: "GND", anchorEndpoint: { reference: "J1", pin: "2" }, symbolLibId: "power:PWR_FLAG" },
    { reference: "#FLG002", net: "VIN", anchorEndpoint: { reference: "J1", pin: "1" }, symbolLibId: "power:PWR_FLAG" },
  ],
};
const externalPowerBinding = parsePcbExternalPowerBinding({
  ...bindingPayload, identity: canonicalIdentity(bindingPayload, PCB_EXTERNAL_POWER_BINDING_SCHEMA_VERSION),
}, sourceContractIdentity);

function connectivityPayload(options: { annotations?: boolean; idempotent?: boolean } = {}): Record<string, unknown> {
  const fields = {
    applied: true, mutated: !options.idempotent, idempotent: options.idempotent ?? false, issues: [],
    ...(options.annotations === false ? {} : {
      externalPowerAnnotations: [
        { reference: "#FLG001", x: 25.4, y: 25.4, rotation: 0 as const },
        { reference: "#FLG002", x: 50.8, y: 25.4, rotation: 0 as const },
      ],
      externalPowerBindingIdentity: externalPowerBinding.identity,
    }),
  };
  return JSON.parse(serializeFreshContractConnectivityResult({ identity: connectivityIdentity }, fields)) as Record<string, unknown>;
}

async function fixture(options: { payload?: Record<string, unknown>; bound?: boolean; planeContext?: boolean } = {}) {
  const order: string[] = [];
  const payload = options.payload ?? connectivityPayload();
  const execute = vi.fn(async (call: HarnessToolCall): Promise<HarnessToolResult> => {
    order.push(call.name);
    return { toolCallId: call.id, content: JSON.stringify(payload) };
  });
  const save = vi.fn(async (call: HarnessToolCall): Promise<HarnessToolResult> => {
    order.push("save");
    return { toolCallId: call.id, content: "saved and read back" };
  });
  const readback = vi.fn(async (call: HarnessToolCall): Promise<HarnessToolResult> => {
    order.push(call.name);
    return { toolCallId: call.id, content: "synthetic schematic connectivity readback" };
  });
  const context = {
    projectBindingIdentity: structuredClone(projectBindingIdentity),
    sourceContractIdentity: structuredClone(sourceContractIdentity),
    ...(options.bound === false ? {} : { externalPowerBinding: structuredClone(externalPowerBinding) }),
  };
  const assertCurrent = vi.fn(async () => {});
  const nativeClose = vi.fn(async () => {}), publish = vi.fn(async () => {});
  const prepareCheckpoint = vi.fn(async () => publish), recordRecoveryRequired = vi.fn(async (_reason: string) => {});
  const cad: ConnectedKicadToolbox = {
    tools: {
      tools: [{ name: toolName, description: "Apply exact host-bound contract connectivity", inputSchema: {
        type: "object", properties: {}, additionalProperties: false,
      } }],
      execute, internal: { execute: readback, saveAfterMutation: save },
      freshBoardSaveAudits: [], captureFreshPcbPadEvidence: async () => undefined,
      runFinalValidation: async () => ({ erc: {}, drc: {}, boardSummary: {}, visualQa: {} }),
    },
    ...(options.planeContext === false ? {} : { planeAuthoringContext: context }),
    assertCurrent, captureSources: async () => "synthetic saved sources", close: nativeClose,
    prepareCheckpoint, recordRecoveryRequired,
  };
  const toolbox = createKicadToolboxMcpServer({ cad, access: "edit", compoundContractIdentity: connectivityIdentity });
  const client = new Client({ name: "external-power-connectivity-boundary-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await toolbox.server.connect(right); await client.connect(left);
  return { client, toolbox, execute, save, readback, context, assertCurrent, nativeClose, publish,
    prepareCheckpoint, recordRecoveryRequired, order,
    close: async () => { await client.close(); await toolbox.close(); } };
}

const annotations = (payload: Record<string, unknown>) => payload.externalPowerAnnotations as Array<Record<string, unknown>>;
interface RejectionCase {
  readonly name: string;
  readonly corrupt?: (payload: Record<string, unknown>) => void;
  readonly bound?: boolean;
  readonly planeContext?: boolean;
}
const rejectionCases: readonly RejectionCase[] = [
  { name: "annotations without binding identity", corrupt: payload => { delete payload.externalPowerBindingIdentity; } },
  { name: "binding identity without annotations", corrupt: payload => { delete payload.externalPowerAnnotations; } },
  { name: "mutated bound result without either annotation field", corrupt: payload => {
    delete payload.externalPowerAnnotations; delete payload.externalPowerBindingIdentity;
  } },
  { name: "unknown top-level key", corrupt: payload => { payload.unrecognized = true; } },
  { name: "unknown annotation key", corrupt: payload => { annotations(payload)[0]!.net = "GND"; } },
  { name: "unknown binding identity key", corrupt: payload => {
    (payload.externalPowerBindingIdentity as Record<string, unknown>).unrecognized = true;
  } },
  { name: "non-array annotations", corrupt: payload => { payload.externalPowerAnnotations = "#FLG001,#FLG002"; } },
  { name: "malformed reference", corrupt: payload => { annotations(payload)[0]!.reference = "J1"; } },
  { name: "duplicate reference", corrupt: payload => { annotations(payload)[1]!.reference = "#FLG001"; } },
  { name: "missing reference field", corrupt: payload => { delete annotations(payload)[0]!.reference; } },
  { name: "missing expected flag", corrupt: payload => { annotations(payload).pop(); } },
  { name: "extra flag outside the bound inventory", corrupt: payload => {
    annotations(payload).push({ reference: "#FLG003", x: 76.2, y: 25.4, rotation: 0 });
  } },
  { name: "noncanonical flag order", corrupt: payload => { annotations(payload).reverse(); } },
  { name: "unsupported rotation", corrupt: payload => { annotations(payload)[0]!.rotation = 90; } },
  { name: "string coordinate", corrupt: payload => { annotations(payload)[0]!.x = "25.4"; } },
  { name: "null coordinate", corrupt: payload => { annotations(payload)[0]!.y = null; } },
  { name: "missing coordinate", corrupt: payload => { delete annotations(payload)[0]!.y; } },
  { name: "x outside supported bounds", corrupt: payload => { annotations(payload)[0]!.x = 2000.001; } },
  { name: "y outside supported bounds", corrupt: payload => { annotations(payload)[0]!.y = -2000.001; } },
  { name: "foreign binding identity", corrupt: payload => {
    payload.externalPowerBindingIdentity = canonicalIdentity({ foreign: true }, PCB_EXTERNAL_POWER_BINDING_SCHEMA_VERSION);
  } },
  { name: "foreign binding identity schema", corrupt: payload => {
    payload.externalPowerBindingIdentity = canonicalIdentity({ foreign: true }, "evleda.fresh-connectivity-contract.v1");
  } },
  { name: "annotation fields on a rejected result", corrupt: payload => {
    Object.assign(payload, { applied: false, mutated: false, idempotent: false,
      issues: [{ code: "SYNTHETIC_REJECTION", message: "Synthetic plan rejected.", remediation: "Restore the synthetic fixture." }],
      issueEvidence: { total: 1, returned: 1, truncated: false } });
  } },
  { name: "annotations without a trusted host binding", bound: false },
  { name: "annotations without any host plane context", planeContext: false },
];

describe("public toolbox external-power connectivity result boundary", () => {
  it("accepts the production serialized annotated success, saves, and reads back connectivity", async () => {
    const payload = connectivityPayload();
    const f = await fixture({ payload });
    try {
      const result = await f.client.callTool({ name: toolName, arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(f.order).toEqual([toolName, "save", "sch_get_connectivity_graph"]);
      expect(f.save).toHaveBeenCalledOnce(); expect(f.readback).toHaveBeenCalledOnce();
      expect(f.save).toHaveBeenCalledWith(expect.objectContaining({ name: "pcb_save", arguments: {} }));
      expect(result.structuredContent).toMatchObject({ operation: toolName, noGovernedEffect: false,
        persistence: { content: "saved and read back" }, readback: { content: "synthetic schematic connectivity readback" } });
      const outer = result.structuredContent as { result: HarnessToolResult };
      expect(JSON.parse(outer.result.content)).toEqual(payload);
      expect((await f.client.callTool({ name: "evleda_toolbox_status", arguments: {} })).structuredContent)
        .toMatchObject({ recoveryRequired: false });
    } finally { await f.close(); }
    expect(f.publish).toHaveBeenCalledOnce(); expect(f.nativeClose).toHaveBeenCalledOnce();
    expect(f.recordRecoveryRequired).not.toHaveBeenCalled();
  });

  it("accepts bound idempotent native parity readback without annotation fields or another save", async () => {
    const payload = connectivityPayload({ annotations: false, idempotent: true });
    Object.assign(payload, { nativeNetlistSha256: "a".repeat(64), nativeNetCount: 2, nativeComponentCount: 1 });
    const f = await fixture({ payload });
    try {
      const result = await f.client.callTool({ name: toolName, arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ persistence: null });
      expect(f.order).toEqual([toolName, "sch_get_connectivity_graph"]);
      expect(f.save).not.toHaveBeenCalled(); expect(f.readback).toHaveBeenCalledOnce();
      expect((await f.client.callTool({ name: "evleda_toolbox_status", arguments: {} })).structuredContent)
        .toMatchObject({ recoveryRequired: false });
    } finally { await f.close(); }
    expect(f.recordRecoveryRequired).not.toHaveBeenCalled();
  });

  it("retains legacy connectivity success without a binding or annotation fields", async () => {
    const f = await fixture({ bound: false, planeContext: false, payload: connectivityPayload({ annotations: false }) });
    try {
      expect((await f.client.callTool({ name: toolName, arguments: {} })).isError).not.toBe(true);
      expect(f.order).toEqual([toolName, "save", "sch_get_connectivity_graph"]);
      expect((await f.client.callTool({ name: "evleda_toolbox_status", arguments: {} })).structuredContent)
        .toMatchObject({ recoveryRequired: false });
    } finally { await f.close(); }
    expect(f.recordRecoveryRequired).not.toHaveBeenCalled();
  });

  it("detaches the trusted binding from later changes to the caller-owned host context", async () => {
    const f = await fixture();
    Object.assign(f.context.externalPowerBinding!.identity, { digest: "f".repeat(64) });
    Object.assign(f.context.externalPowerBinding!.flags[0]!, { reference: "#FLG999" });
    try {
      expect((await f.client.callTool({ name: toolName, arguments: {} })).isError).not.toBe(true);
      expect(f.order).toEqual([toolName, "save", "sch_get_connectivity_graph"]);
      expect((await f.client.callTool({ name: "evleda_toolbox_status", arguments: {} })).structuredContent)
        .toMatchObject({ recoveryRequired: false });
    } finally { await f.close(); }
  });

  it.each(rejectionCases)("rejects $name before save/readback and requires recovery", async ({ corrupt, ...options }) => {
    const payload = connectivityPayload(); corrupt?.(payload);
    const f = await fixture({ ...options, payload });
    try {
      expect((await f.client.callTool({ name: toolName, arguments: {} })).isError).toBe(true);
      expect((await f.client.callTool({ name: "evleda_toolbox_status", arguments: {} })).structuredContent)
        .toMatchObject({ recoveryRequired: true });
      expect((await f.client.callTool({ name: toolName, arguments: {} })).isError).toBe(true);
      expect(f.order).toEqual([toolName]); expect(f.execute).toHaveBeenCalledOnce();
      expect(f.save).not.toHaveBeenCalled(); expect(f.readback).not.toHaveBeenCalled();
    } finally { await f.close(); }
    expect(f.prepareCheckpoint).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled();
    expect(f.recordRecoveryRequired).toHaveBeenCalledOnce(); expect(f.nativeClose).toHaveBeenCalledOnce();
  });

  it.each(["save", "readback"] as const)("retains recovery when the required %s fails after accepted annotations", async boundary => {
    const f = await fixture();
    f[boundary].mockImplementation(async call => {
      f.order.push(boundary === "save" ? "save" : call.name);
      return { toolCallId: call.id, content: `synthetic ${boundary} failure`, isError: true };
    });
    try {
      expect((await f.client.callTool({ name: toolName, arguments: {} })).isError).toBe(true);
      expect((await f.client.callTool({ name: "evleda_toolbox_status", arguments: {} })).structuredContent)
        .toMatchObject({ recoveryRequired: true });
      expect(f.save).toHaveBeenCalledOnce();
      if (boundary === "save") expect(f.readback).not.toHaveBeenCalled();
      else expect(f.readback).toHaveBeenCalledOnce();
    } finally { await f.close(); }
    expect(f.publish).not.toHaveBeenCalled(); expect(f.recordRecoveryRequired).toHaveBeenCalledOnce();
  });
});
