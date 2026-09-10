import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKicadStackupReader } from "../../src/integrations/kicad-stackup.js";
import { createKicadToolboxMcpServer } from "../../src/mcp/toolbox-server.js";
import type { ConnectedKicadToolbox } from "../../src/mcp/toolbox-session.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "toolbox-stackup-mcp-")); roots.push(root);
  const pcbPath = path.join(root, "board.kicad_pcb");
  await writeFile(pcbPath, '(kicad_pcb (version 20260206) (general (thickness 1.6)) (layers (0 "F.Cu" signal) (2 "B.Cu" signal)))\n');
  const captureSources = vi.fn(async () => "stable-project");
  const reader = await createKicadStackupReader({ pcbPath }); const readStackup = vi.fn(reader);
  const cad = { tools: { tools: [] }, readStackup, captureSources, assertCurrent: vi.fn(async () => {}), close: vi.fn(async () => {}) } as unknown as ConnectedKicadToolbox;
  const toolbox = createKicadToolboxMcpServer({ cad }); const client = new Client({ name: "stackup-test", version: "1" });
  const [clientWire, serverWire] = InMemoryTransport.createLinkedPair(); await toolbox.server.connect(serverWire); await client.connect(clientWire);
  return { client, captureSources, readStackup, close: async () => { await client.close(); await toolbox.close(); } };
}
describe("saved-source stackup MCP tool", () => {
  it("reports missing physical construction without substituting total board thickness", async () => {
    const f = await fixture();
    try {
      const result = await f.client.callTool({ name: "evleda_read_stackup", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ stackup: { status: "missing" }, impedanceValidation: "not_performed", sourceUnchanged: true });
      expect(f.readStackup).toHaveBeenCalledWith();
    } finally { await f.close(); }
  });
  it("does not accept a caller-selected PCB path", async () => {
    const f = await fixture();
    try {
      const result = await f.client.callTool({ name: "evleda_read_stackup", arguments: { pcbPath: "other.kicad_pcb" } });
      expect(result.isError).toBe(true); expect(f.readStackup).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it("suppresses observations when the surrounding project changes", async () => {
    const f = await fixture(); f.captureSources.mockResolvedValueOnce("before").mockResolvedValueOnce("after");
    try {
      const result = await f.client.callTool({ name: "evleda_read_stackup", arguments: {} });
      expect(result.isError).toBe(true); expect(result.structuredContent).not.toHaveProperty("stackup");
    } finally { await f.close(); }
  });
});
