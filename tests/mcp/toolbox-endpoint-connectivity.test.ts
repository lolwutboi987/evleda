import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { createKicadToolboxMcpServer } from "../../src/mcp/toolbox-server.js";
import type { ConnectedKicadToolbox } from "../../src/mcp/toolbox-session.js";

async function fixture(available = true) {
  const check = vi.fn(async () => ({ report: { schemaVersion: "evleda.toolbox-endpoint-connectivity.v1", status: "partially-connected",
    nets: [{ net: "VOUT", status: "disconnected" }], acceptanceEvaluated: false }, diagnostic: { filename: "endpoint-connectivity-fixture.json", identity: { digest: "bound" } } }));
  const captureSources = vi.fn(async () => "same-source");
  const cad = { tools: { tools: [], execute: vi.fn(), internal: {} }, assertCurrent: vi.fn(async () => {}),
    captureSources, close: vi.fn(async () => {}), ...(available ? { checkEndpointConnectivity: check } : {}) } as unknown as ConnectedKicadToolbox;
  const toolbox = createKicadToolboxMcpServer({ cad, access: "read-only" }), client = new Client({ name: "endpoints-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair(); await toolbox.server.connect(right); await client.connect(left);
  return { client, check, captureSources, close: async () => { await client.close(); await toolbox.close(); } };
}

describe("public saved-native endpoint connectivity", () => {
  it("works read-only with source association and no overall acceptance claim", async () => {
    const f = await fixture();
    try {
      const descriptor = (await f.client.listTools()).tools.find(tool => tool.name === "evleda_check_endpoint_connectivity");
      expect(descriptor?.annotations?.readOnlyHint).toBe(true);
      const result = await f.client.callTool({ name: "evleda_check_endpoint_connectivity", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ sourceUnchanged: true, sourceBefore: "same-source", sourceAfter: "same-source",
        report: { status: "partially-connected", nets: [{ net: "VOUT", status: "disconnected" }], acceptanceEvaluated: false } });
      expect(f.check).toHaveBeenCalledWith();
      expect((await f.client.callTool({ name: "evleda_check_endpoint_connectivity", arguments: { pcbPath: "elsewhere" } })).isError).toBe(true);
      expect(f.check).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });
  it("does not advertise an unavailable host capability", async () => {
    const f = await fixture(false);
    try { expect((await f.client.listTools()).tools.map(tool => tool.name)).not.toContain("evleda_check_endpoint_connectivity"); }
    finally { await f.close(); }
  });
  it("rejects findings if source changes during observation", async () => {
    const f = await fixture(); f.captureSources.mockResolvedValueOnce("before").mockResolvedValueOnce("after");
    try { expect((await f.client.callTool({ name: "evleda_check_endpoint_connectivity", arguments: {} })).isError).toBe(true); }
    finally { await f.close(); }
  });
  it("reports observation failures without inventing connectivity", async () => {
    const f = await fixture(); f.check.mockRejectedValue(new Error("missing native evidence"));
    try {
      const result = await f.client.callTool({ name: "evleda_check_endpoint_connectivity", arguments: {} });
      expect(result.isError).toBe(true); expect(result.structuredContent).not.toHaveProperty("report");
    } finally { await f.close(); }
  });
});
