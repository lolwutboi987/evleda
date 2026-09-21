import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { createKicadToolboxMcpServer } from "../../src/mcp/toolbox-server.js";
import type { ConnectedKicadToolbox } from "../../src/mcp/toolbox-session.js";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { contentIdentity } from "../../src/core/canonical.js";

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
  return { client, check, captureSources, toolbox, close: async () => { await client.close(); await toolbox.close(); } };
}

describe("public V2 plane acceptance transport", () => {
  it("delivers every large-report finding through a hash-bound resource and rejects later tampering", async () => {
    const parent = await realpath(tmpdir()), root = await mkdtemp(path.join(parent, "plane-report-"));
    const f = await fixture();
    try {
      const report = { schemaVersion: "evleda.toolbox-plane-acceptance.v1", status: "incomplete", family: "plane-v2",
        accepted: false, fabricationAuthorized: false, acceptanceEvaluated: true,
        rows: [{ id: "plane-fill:GND", status: "unknown" }], verificationPlanRowsPassed: [], mandatoryRowsRemaining: ["plane-fill:GND"],
        limitations: { overallAcceptance: "not-established" }, findings: Array.from({ length: 1400 }, (_, i) => ({ id: i, reason: "x".repeat(1000) })) };
      const bytes = Buffer.from(JSON.stringify(report)), file = path.join(root, "public.json"); await writeFile(file, bytes);
      const full = { report, diagnostic: { filename: "private.json", identity: { digest: "private-fixture" } },
        publicReportArtifact: { path: file, identity: contentIdentity(bytes) } };
      f.check.mockResolvedValue({ ...full, report: { ...report, status: "contradictory" } } as any);
      expect((await f.client.callTool({ name: "evleda_check_plane_acceptance", arguments: {} })).isError).toBe(true);
      await expect(f.client.readResource({ uri: `evleda://plane-acceptance/${contentIdentity(bytes).digest}` })).rejects.toThrow();
      f.check.mockResolvedValue(full as any);
      const result = await f.client.callTool({ name: "evleda_check_plane_acceptance", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result)).not.toContain(root);
      expect(JSON.stringify(result).length).toBeLessThan(16_000);
      const value = result.structuredContent as any;
      expect(value.report).toMatchObject({ schemaVersion: "evleda.toolbox-plane-acceptance-resource-summary.v1", rows: { total: 1, pass: 0, fail: 0, unknown: 1 }, accepted: false });
      expect(value.fullReportResource).toBe(`evleda://plane-acceptance/${contentIdentity(bytes).digest}`);
      const resource = await f.client.readResource({ uri: value.fullReportResource });
      expect(JSON.parse((resource.contents[0] as { text: string }).text)).toEqual(report);
      expect(contentIdentity(Buffer.from((resource.contents[0] as { text: string }).text))).toEqual(value.fullReportIdentity);
      await f.toolbox.finishCad(); f.toolbox.detachCad();
      expect((await f.client.readResource({ uri: value.fullReportResource })).contents).toEqual(resource.contents);
      await writeFile(file, (await readFile(file)).toString().replace('"id":0', '"id":9'));
      await expect(f.client.readResource({ uri: value.fullReportResource })).rejects.toThrow(/changed/);
      await expect(f.client.readResource({ uri: `evleda://plane-acceptance/${"0".repeat(64)}` })).rejects.toThrow(/unavailable/);
    } finally {
      await f.close();
      if (path.dirname(await realpath(root)) !== parent) throw new Error("Report cleanup escaped the test root");
      await rm(root, { recursive: true, force: true });
    }
  });
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
