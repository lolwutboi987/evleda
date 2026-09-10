import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { createKicadToolboxMcpServer } from "../../src/mcp/toolbox-server.js";
import type { ConnectedKicadToolbox } from "../../src/mcp/toolbox-session.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "toolbox-mcp-preview-")); roots.push(root);
  let ordinal = 0;
  const renderPreview = vi.fn(async (view: "top" | "assembly") => {
    const source = `<svg xmlns="http://www.w3.org/2000/svg"><text>${++ordinal}</text></svg>`;
    const identity = contentIdentity(Buffer.from(source)); const svgPath = path.join(root, `${ordinal}.svg`);
    await writeFile(svgPath, source);
    const pngBytes = Buffer.from("host-produced-png-test-bytes");
    return { source, view, layers: ["F.Cu", "F.Silkscreen", "Edge.Cuts"], classification: "candidate-preview" as const,
      releaseAuthorized: false as const, executable: { kind: "fixture" }, sourceHashes: { "board.kicad_pcb": "a".repeat(64) }, invocation: { fixture: true },
      pcbSvg: { path: svgPath, relativePath: path.basename(svgPath), sha256: identity.digest, sizeBytes: identity.size },
      mimeType: "image/svg+xml", resourceUri: `evleda://pcb-preview/${identity.digest}/${view}`,
      png: { path: path.join(root, `${ordinal}.png`), identity: contentIdentity(pngBytes), width: 320, height: 200,
        data: pngBytes.toString("base64"), mimeType: "image/png" as const, sourceSvgSha256: identity.digest }, assurance: "Native test snapshot only" };
  });
  const assertCurrent = vi.fn(async () => {}); const captureSources = vi.fn(async () => "source-before");
  const cad = { tools: { tools: [] }, assertCurrent, captureSources, renderPreview, close: vi.fn(async () => {}) } as unknown as ConnectedKicadToolbox;
  const toolbox = createKicadToolboxMcpServer({ cad });
  const client = new Client({ name: "preview-test", version: "1" });
  const [clientWire, serverWire] = InMemoryTransport.createLinkedPair();
  await toolbox.server.connect(serverWire); await client.connect(clientWire);
  return { client, renderPreview, assertCurrent, captureSources, close: async () => { await client.close(); await toolbox.close(); } };
}

describe("MCP native PCB preview presentation", () => {
  it("returns image plus metadata and exact SVG resource without embedding raw SVG or PNG data in metadata", async () => {
    const f = await fixture();
    try {
      const result = await f.client.callTool({ name: "evleda_render_board", arguments: {} });
      expect(result.isError).not.toBe(true); expect(f.renderPreview).toHaveBeenCalledWith("top");
      const preview = await f.renderPreview.mock.results[0]!.value;
      expect(result.content).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "image", mimeType: "image/png", data: preview.png.data }),
        expect.objectContaining({ type: "resource_link", uri: preview.resourceUri, mimeType: "image/svg+xml" }),
      ]));
      expect(result.structuredContent).not.toHaveProperty("source");
      expect(result.structuredContent).not.toHaveProperty("png.data");
      expect(JSON.stringify(result.structuredContent)).not.toContain("<svg");
      expect(result.structuredContent).toMatchObject({ sourceUnchanged: true, releaseAuthorized: false, png: { sourceSvgSha256: preview.pcbSvg.sha256 } });
      const resource = await f.client.readResource({ uri: preview.resourceUri });
      expect(resource.contents).toEqual([{ uri: preview.resourceUri, mimeType: "image/svg+xml", text: preview.source }]);
    } finally { await f.close(); }
  });

  it("rejects same-size SVG artifact tampering", async () => {
    const f = await fixture();
    try {
      await f.client.callTool({ name: "evleda_render_board", arguments: { view: "assembly" } });
      const preview = await f.renderPreview.mock.results[0]!.value;
      await writeFile(preview.pcbSvg.path, preview.source.replace(">1<", ">9<"));
      await expect(f.client.readResource({ uri: preview.resourceUri })).rejects.toThrow("changed");
    } finally { await f.close(); }
  });

  it("rejects unknown resources and evicts the oldest after 32 distinct previews", async () => {
    const f = await fixture();
    try {
      await expect(f.client.readResource({ uri: `evleda://pcb-preview/${"0".repeat(64)}/top` })).rejects.toThrow("unavailable or expired");
      for (let index = 0; index < 33; index++) await f.client.callTool({ name: "evleda_render_board", arguments: { view: "top" } });
      const first = await f.renderPreview.mock.results[0]!.value;
      const last = await f.renderPreview.mock.results[32]!.value;
      await expect(f.client.readResource({ uri: first.resourceUri })).rejects.toThrow("expired");
      expect((await f.client.readResource({ uri: last.resourceUri })).contents).toHaveLength(1);
    } finally { await f.close(); }
  });

  it.each(["source", "document"])("suppresses image and resource registration when %s changes during rendering", async kind => {
    const f = await fixture();
    try {
      if (kind === "source") f.captureSources.mockResolvedValueOnce("before").mockResolvedValueOnce("after");
      else f.assertCurrent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Document changed"));
      const result = await f.client.callTool({ name: "evleda_render_board", arguments: { view: "top" } });
      expect(result.isError).toBe(true);
      expect(result.content.some(item => item.type === "image" || item.type === "resource_link")).toBe(false);
      const preview = await f.renderPreview.mock.results[0]!.value;
      await expect(f.client.readResource({ uri: preview.resourceUri })).rejects.toThrow("unavailable");
    } finally { await f.close(); }
  });

  it("accepts only the fixed view selector and never model-selected paths or profiles", async () => {
    const f = await fixture();
    try {
      for (const argumentsValue of [{ view: "top", pcbPath: "other.kicad_pcb" }, { view: "assembly", profile: {} }, { view: "other" }]) {
        const result = await f.client.callTool({ name: "evleda_render_board", arguments: argumentsValue });
        expect(result.isError).toBe(true);
      }
      expect(f.renderPreview).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
});
