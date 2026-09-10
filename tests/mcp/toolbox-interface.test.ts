import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import type { ConnectedKicadToolbox } from "../../src/mcp/toolbox-session.js";
import type { KicadTransmissionLineCalculator } from "../../src/integrations/kicad-transmission-line.js";
import { snapshotToolboxInterfaceQuery, TOOLBOX_INTERFACE_ERROR } from "../../src/mcp/toolbox-interface.js";

// These tests exercise MCP capability isolation and queue/source guards. The
// genuine producer and closed public projection have their own focused tests.
import { createKicadToolboxMcpServer } from "../../src/mcp/toolbox-server.js";

const TOOL = "evleda_check_interface";
const report = { schemaVersion: "test-bound-interface", interfaceId: "USB.1+P",
  sourceIdentity: { algorithm: "sha256", digest: "a".repeat(64), size: 100 },
  geometry: { checks: { width: { status: "fail" } } }, interfaceAccepted: false, fabricationAuthorized: false };
const observation = { report, diagnostic: { filename: "interface-test.json", identity: report.sourceIdentity } };

async function fixture(options: { absent?: boolean; noPort?: boolean; calculator?: KicadTransmissionLineCalculator } = {}) {
  const checkInterface = vi.fn(async (interfaceId: string, _calculator?: KicadTransmissionLineCalculator) => ({ ...observation, report: { ...report, interfaceId } }));
  const assertCurrent = vi.fn().mockResolvedValue(undefined);
  const captureSources = vi.fn().mockResolvedValue("same-complete-project");
  const cad = { tools: { tools: [], execute: vi.fn(), internal: {} }, assertCurrent, captureSources,
    close: vi.fn().mockResolvedValue(undefined), ...(options.noPort ? {} : { checkInterface }) } as unknown as ConnectedKicadToolbox;
  const toolbox = createKicadToolboxMcpServer({ access: "read-only", ...(options.absent ? {} : { cad }),
    ...(options.calculator === undefined ? {} : { transmissionLine: options.calculator }) });
  const client = new Client({ name: "bound-interface-port-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await toolbox.server.connect(right); await client.connect(left);
  return { client, toolbox, checkInterface, assertCurrent, captureSources,
    close: async () => { await client.close(); await toolbox.close(); } };
}

describe("contract-bound interface MCP read", () => {
  it("selects only a bound ID and publishes complete source-guarded observations read-only", async () => {
    const f = await fixture();
    try {
      const descriptor = (await f.client.listTools()).tools.find(tool => tool.name === TOOL)!;
      expect(Object.keys(descriptor.inputSchema.properties ?? {})).toEqual(["interfaceId"]);
      expect(descriptor.inputSchema.additionalProperties).toBe(false);
      expect(descriptor.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      const result = await f.client.callTool({ name: TOOL, arguments: { interfaceId: "USB.1+P" } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ ...observation, sourceBefore: "same-complete-project",
        sourceAfter: "same-complete-project", sourceUnchanged: true });
      expect(f.checkInterface).toHaveBeenCalledExactlyOnceWith("USB.1+P", undefined);
      expect(f.assertCurrent).toHaveBeenCalledTimes(2); expect(f.captureSources).toHaveBeenCalledTimes(2);
    } finally { await f.close(); }
  });

  it.each(["targetOhms", "geometry", "construction", "endpoints", "bundle", "pcbPath", "savedPcbBytes", "calculator", "accepted"])(
    "rejects caller-supplied %s before host dispatch", async field => {
      const f = await fixture();
      try {
        const result = await f.client.callTool({ name: TOOL, arguments: { interfaceId: "USB.1+P", [field]: "injected" } });
        expect(result.isError).toBe(true); expect(f.checkInterface).not.toHaveBeenCalled();
        expect(f.assertCurrent).not.toHaveBeenCalled(); expect(f.captureSources).not.toHaveBeenCalled();
      } finally { await f.close(); }
    });

  it.each(["", "../LINK", " LINK", "LINK\n", "a".repeat(65)])("rejects invalid selector %j", async interfaceId => {
    const f = await fixture();
    try {
      expect((await f.client.callTool({ name: TOOL, arguments: { interfaceId } })).isError).toBe(true);
      expect(f.checkInterface).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("detaches the request and never executes getters", () => {
    const argument = { interfaceId: "LINK" }, snapshot = snapshotToolboxInterfaceQuery(argument);
    argument.interfaceId = "CHANGED"; expect(snapshot.interfaceId).toBe("LINK");
    const getter = vi.fn(() => "LINK");
    expect(() => snapshotToolboxInterfaceQuery(Object.defineProperty({}, "interfaceId", { enumerable: true, get: getter }))).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(["before", "assessment", "after", "sources"] as const)("suppresses all evidence when %s fails", async stage => {
    const f = await fixture();
    const privateError = new Error("C:\\private\\native.kicad_pcb (kicad_pcb PRIVATE_SOURCE)");
    if (stage === "before") f.assertCurrent.mockRejectedValueOnce(privateError);
    if (stage === "assessment") f.checkInterface.mockRejectedValueOnce(privateError);
    if (stage === "after") f.assertCurrent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(privateError);
    if (stage === "sources") f.captureSources.mockResolvedValueOnce("first").mockResolvedValueOnce("changed");
    try {
      const result = await f.client.callTool({ name: TOOL, arguments: { interfaceId: "LINK" } });
      expect(result.isError).toBe(true); expect(result.structuredContent).toEqual({ error: TOOLBOX_INTERFACE_ERROR });
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE_SOURCE|native\.kicad_pcb|sourceIdentity|sourceUnchanged/u);
    } finally { await f.close(); }
  });

  it.each([{ absent: true }, { noPort: true }])("does not advertise a missing bound interface capability: %j", async options => {
    const f = await fixture(options);
    try {
      expect((await f.client.listTools()).tools.map(tool => tool.name)).not.toContain(TOOL);
      const attempted = await f.client.callTool({ name: TOOL, arguments: { interfaceId: "LINK" } }).then(
        result => result.isError === true, () => true);
      expect(attempted).toBe(true); expect(f.checkInterface).not.toHaveBeenCalled();
    }
    finally { await f.close(); }
  });

  it("forwards only the host calculator capability", async () => {
    const calculator = Object.freeze({ identity: { testOnly: true } }) as unknown as KicadTransmissionLineCalculator;
    const f = await fixture({ calculator });
    try {
      const result = await f.client.callTool({ name: TOOL, arguments: { interfaceId: "LINK" } });
      expect(result.isError).not.toBe(true); expect(f.checkInterface).toHaveBeenCalledExactlyOnceWith("LINK", calculator);
      expect(JSON.stringify(result)).not.toContain("testOnly");
    } finally { await f.close(); }
  });

  it("refuses an assessment for a different interface", async () => {
    const f = await fixture(); f.checkInterface.mockResolvedValueOnce({ ...observation, report: { ...report, interfaceId: "OTHER" } });
    try {
      const result = await f.client.callTool({ name: TOOL, arguments: { interfaceId: "LINK" } });
      expect(result.isError).toBe(true); expect(result.structuredContent).toEqual({ error: TOOLBOX_INTERFACE_ERROR });
    } finally { await f.close(); }
  });

  it("drains the active read before closing and refuses later reads", async () => {
    const f = await fixture(); let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.checkInterface.mockImplementationOnce(async interfaceId => { entered(); await gate; return { ...observation, report: { ...report, interfaceId } }; });
    try {
      const active = f.client.callTool({ name: TOOL, arguments: { interfaceId: "LINK" } });
      await started; const finished = f.toolbox.finishCad(); release();
      expect((await active).isError).not.toBe(true); await finished;
      expect(f.toolbox.getCadState()).toBe("closed");
      const denied = await f.client.callTool({ name: TOOL, arguments: { interfaceId: "LINK" } });
      expect(denied.isError).toBe(true); expect(f.checkInterface).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });
});
