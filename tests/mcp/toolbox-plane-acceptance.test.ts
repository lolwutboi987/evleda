import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { createKicadToolboxMcpServer } from "../../src/mcp/toolbox-server.js";
import type { ConnectedKicadToolbox } from "../../src/mcp/toolbox-session.js";

async function fixture(available = true) {
  // This fixture tests transport/dispatch only; the assessor's native evidence
  // and row semantics are tested with its authenticated producers separately.
  const check = vi.fn(async () => ({ report: { schemaVersion: "evleda.toolbox-plane-acceptance.v1", status: "incomplete",
    accepted: false, fabricationAuthorized: false, rows: [{ id: "plane-fill:GND", status: "unknown" }] },
    diagnostic: { filename: "plane-acceptance-fixture.json", identity: { digest: "transport-fixture" } } }));
  const captureSources = vi.fn(async () => "same-source");
  const cad = { tools: { tools: [], execute: vi.fn(), internal: {} }, assertCurrent: vi.fn(async () => {}),
    captureSources, close: vi.fn(async () => {}), ...(available ? { checkPlaneAcceptance: check } : {}) } as unknown as ConnectedKicadToolbox;
  const toolbox = createKicadToolboxMcpServer({ cad, access: "read-only" }), client = new Client({ name: "plane-transport-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair(); await toolbox.server.connect(right); await client.connect(left);
  return { client, check, captureSources, close: async () => { await client.close(); await toolbox.close(); } };
}

describe("public V2 plane acceptance transport", () => {
  it("preserves unresolved rows in read-only mode and accepts no caller evidence", async () => {
    const f = await fixture();
    try {
      const descriptor = (await f.client.listTools()).tools.find(tool => tool.name === "evleda_check_plane_acceptance");
      expect(descriptor?.annotations?.readOnlyHint).toBe(true);
      const result = await f.client.callTool({ name: "evleda_check_plane_acceptance", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ sourceUnchanged: true, sourceBefore: "same-source", sourceAfter: "same-source",
        report: { status: "incomplete", accepted: false, rows: [{ id: "plane-fill:GND", status: "unknown" }] } });
      expect(f.check).toHaveBeenCalledWith();
      for (const argumentsValue of [{ pcbPath: "elsewhere" }, { planeId: "GND" }, { accepted: true }, { savedEvidence: {} }]) {
        expect((await f.client.callTool({ name: "evleda_check_plane_acceptance", arguments: argumentsValue })).isError).toBe(true);
      }
      expect(f.check).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });
  it("omits unavailable capability", async () => {
    const f = await fixture(false);
    try { expect((await f.client.listTools()).tools.map(tool => tool.name)).not.toContain("evleda_check_plane_acceptance"); }
    finally { await f.close(); }
  });
  it("discards the result when sources drift", async () => {
    const f = await fixture(); f.captureSources.mockResolvedValueOnce("before").mockResolvedValueOnce("after");
    try { expect((await f.client.callTool({ name: "evleda_check_plane_acceptance", arguments: {} })).isError).toBe(true); }
    finally { await f.close(); }
  });
  it("propagates failure without fabricating a row result", async () => {
    const f = await fixture(); f.check.mockRejectedValue(new Error("unqualified native evidence"));
    try {
      const result = await f.client.callTool({ name: "evleda_check_plane_acceptance", arguments: {} });
      expect(result.isError).toBe(true); expect(result.structuredContent).not.toHaveProperty("report");
    } finally { await f.close(); }
  });
});
