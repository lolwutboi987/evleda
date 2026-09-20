import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { mkdtemp, writeFile, rm, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { createKicadToolboxMcpServer } from "../../src/mcp/toolbox-server.js";
import type { ConnectedKicadToolbox } from "../../src/mcp/toolbox-session.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const query = { signalNets: ["SIG"], signalLayer: "F.Cu", referenceNet: "GND", referenceLayer: "B.Cu", marginNm: 100000, marginBasis: "Explicit reviewed geometry requirement" };
async function fixture(available = true, withStudy = false) {
  const root = await mkdtemp(path.join(tmpdir(), "reference-mcp-")); roots.push(root);
  let ordinal = 0;
  const check = vi.fn(async (_args: unknown) => {
    const route = { routeIndex: 0, segmentId: "signal-segment", netName: "SIG", status: "covered", certificate: "exact_outer_envelope_containment",
      innerEnvelope: [[[0, 0], [100, 0], [100, 100]]], outerEnvelope: [[[0, 0], [200, 0], [200, 200]]], uncoveredOuterEnvelope: [] };
    const raw = JSON.stringify({ request: query, routes: [route], ordinal: ++ordinal });
    const artifact = { path: path.join(root, `${ordinal}.json`), identity: contentIdentity(Buffer.from(raw)) }; await writeFile(artifact.path, raw);
    const studyRaw = JSON.stringify({ scope: "Prospective remainder only", routes: [route] });
    const studyArtifact = { path: path.join(root, `${ordinal}-study.json`), identity: contentIdentity(Buffer.from(studyRaw)) };
    if (withStudy) await writeFile(studyArtifact.path, studyRaw);
    return { status: "computed", geometricStatus: withStudy ? "uncovered" : "covered", routeResults: [route],
      ...(withStudy ? { terminalLaunchStudy: { status: "computed", remainderGeometricStatus: "covered", acceptanceChanged: false,
        artifacts: { rawOutput: studyArtifact }, routeResults: [{ segmentId: "signal-segment", status: "covered" }] } } : {}),
      evidenceStatus: { fillFreshness: "unverified_saved_cache", dcConnectivity: "not_evaluated", impedance: "not_evaluated" },
      limitations: ["Selected cached geometry only; no electrical approval."], calculation: { artifacts: { rawOutput: artifact }, diagnosticGeometry: "conservative envelopes" } };
  });
  const assertCurrent = vi.fn(async () => {}), captureSources = vi.fn(async () => "saved-source");
  const cad = { tools: { tools: [] }, assertCurrent, captureSources, close: vi.fn(async () => {}), ...(available ? { checkReferenceCoverage: check } : {}) } as unknown as ConnectedKicadToolbox;
  const toolbox = createKicadToolboxMcpServer({ cad, access: "read-only" });
  const client = new Client({ name: "reference-test", version: "1" }); const [left, right] = InMemoryTransport.createLinkedPair();
  await toolbox.server.connect(right); await client.connect(left);
  const call = (args: Record<string, unknown> = query) => client.callTool({ name: "evleda_check_reference_coverage", arguments: args });
  return { root, check, assertCurrent, captureSources, toolbox, client, call, close: async () => { await client.close(); await toolbox.close(); } };
}

describe("MCP source-bound reference coverage", () => {
  it("exposes separate launch-study diagnostics while preserving the original full-ribbon finding", async () => {
    const f = await fixture(true, true);
    try {
      const args = { ...query, terminalLaunchStudy: [{ signalEndpoint: { reference: "J1", pin: "1" },
        referenceEndpoint: { reference: "J1", pin: "2" }, maximumLengthNm: 1_500_000, maximumReturnSpacingNm: 2_540_000,
        engineeringBasis: "Prospective analysis only" }] };
      const result = await f.call(args), metadata = result.structuredContent as Record<string, any>;
      expect(result.isError).not.toBe(true); expect(f.check).toHaveBeenCalledWith(args);
      expect(metadata.geometricStatus).toBe("uncovered");
      expect(metadata.terminalLaunchStudy).toMatchObject({ remainderGeometricStatus: "covered", acceptanceChanged: false });
      expect(metadata.terminalLaunchDiagnosticResource).not.toBe(metadata.diagnosticResource);
      expect(result.content.filter(item => item.type === "resource_link")).toHaveLength(2);
      const resource = await f.client.readResource({ uri: metadata.terminalLaunchDiagnosticResource });
      expect(JSON.parse((resource.contents[0] as { text: string }).text).scope).toBe("Prospective remainder only");
      const report = await f.check.mock.results[0]!.value;
      await writeFile(report.terminalLaunchStudy!.artifacts.rawOutput.path, "changed");
      await expect(f.client.readResource({ uri: metadata.terminalLaunchDiagnosticResource })).rejects.toThrow("changed");
    } finally { await f.close(); }
  });

  it("advertises the read-only tool only when the owning host provides it", async () => {
    const absent = await fixture(false);
    try { expect((await absent.client.listTools()).tools.map(tool => tool.name)).not.toContain("evleda_check_reference_coverage"); }
    finally { await absent.close(); }
    const f = await fixture();
    try {
      expect((await f.client.listTools()).tools.find(tool => tool.name === "evleda_check_reference_coverage")?.annotations?.readOnlyHint).toBe(true);
      expect((await f.call()).isError).not.toBe(true); expect(f.check).toHaveBeenCalledWith(query);
    } finally { await f.close(); }
  });
  it("keeps compact geometry summaries and exposes the complete exact diagnostic resource", async () => {
    const f = await fixture();
    try {
      const result = await f.call(); const metadata = result.structuredContent as Record<string, any>;
      const report = await f.check.mock.results[0]!.value; const artifact = report.calculation.artifacts.rawOutput;
      expect(metadata.routeResults).toEqual([expect.objectContaining({ status: "covered", diagnosticPolygonCounts: { inner: 1, outer: 1, uncoveredOuter: 0 } })]);
      expect(metadata.routeResults[0]).not.toHaveProperty("outerEnvelope");
      expect(metadata.evidenceStatus).toEqual(report.evidenceStatus); expect(metadata.limitations).toEqual(report.limitations);
      expect(metadata).not.toHaveProperty("passed");
      expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "resource_link", uri: metadata.diagnosticResource, mimeType: "application/json" })]));
      const resource = await f.client.readResource({ uri: metadata.diagnosticResource });
      const raw = resource.contents[0] as { text: string };
      expect(contentIdentity(Buffer.from(raw.text))).toEqual(artifact.identity);
      expect(JSON.parse(raw.text).routes[0].outerEnvelope).toEqual(report.routeResults[0]!.outerEnvelope);
    } finally { await f.close(); }
  });
  it.each(["boundary_uncertain", "uncovered", "not_assessed"])("preserves %s and limitations without manufacturing a pass", async status => {
    const f = await fixture();
    try {
      const original = f.check.getMockImplementation()!;
      f.check.mockImplementation(async args => { const report = await original(args); return { ...report,
        status: status === "not_assessed" ? "not_assessed" : "computed", geometricStatus: status,
        routeResults: report.routeResults.map(route => ({ ...route, status })) }; });
      const result = await f.call(); const metadata = result.structuredContent as Record<string, any>;
      expect(metadata.geometricStatus).toBe(status); expect(metadata.limitations).toHaveLength(1);
      expect(metadata.evidenceStatus.dcConnectivity).toBe("not_evaluated"); expect(metadata).not.toHaveProperty("passed");
      if (status === "not_assessed") expect(result.content.some(item => item.type === "resource_link")).toBe(false);
    } finally { await f.close(); }
  });
  it("rejects filesystem/profile/geometry arguments and invalid margin before host dispatch", async () => {
    const f = await fixture();
    try {
      for (const args of [{ ...query, pcbPath: "other.kicad_pcb" }, { ...query, profile: {} }, { ...query, groups: [] }, { ...query, marginNm: -1 }, { ...query, marginBasis: "" }]) expect((await f.call(args)).isError).toBe(true);
      expect(f.check).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it("retains semantic schema refinements before invoking the host capability", async () => {
    const f = await fixture();
    try {
      for (const args of [{ ...query, signalNets: ["SIG", "SIG"] }, { ...query, referenceLayer: query.signalLayer }]) {
        expect((await f.call(args)).isError).toBe(true);
      }
      expect(f.check).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it.each(["project", "document"])("suppresses reference results and resource registration on %s drift", async kind => {
    const f = await fixture();
    try {
      if (kind === "project") f.captureSources.mockResolvedValueOnce("before").mockResolvedValueOnce("after");
      else f.assertCurrent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("document drift"));
      const result = await f.call(); expect(result.isError).toBe(true);
      expect(result.content.some(item => item.type === "resource_link")).toBe(false);
      expect(result.structuredContent).not.toHaveProperty("routeResults");
      const report = await f.check.mock.results[0]!.value;
      await expect(f.client.readResource({ uri: `evleda://reference-coverage/${report.calculation.artifacts.rawOutput.identity.digest}` })).rejects.toThrow("unavailable");
    } finally { await f.close(); }
  });
  it.each(["tamper", "size", "hardlink"])("rejects diagnostic artifact %s on resource read", async kind => {
    const f = await fixture();
    try {
      const result = await f.call(); const report = await f.check.mock.results[0]!.value; const artifact = report.calculation.artifacts.rawOutput;
      if (kind === "hardlink") await link(artifact.path, path.join(f.root, "shared.json"));
      else if (kind === "size") await writeFile(artifact.path, "short");
      else await writeFile(artifact.path, "x".repeat(artifact.identity.size));
      await expect(f.client.readResource({ uri: (result.structuredContent as Record<string, string>).diagnosticResource! })).rejects.toThrow("changed");
    } finally { await f.close(); }
  });
  it("keeps historical hash resources after finish/detach while removing the CAD tool", async () => {
    const f = await fixture();
    try {
      const result = await f.call(); const uri = (result.structuredContent as Record<string, string>).diagnosticResource!;
      await f.toolbox.finishCad(); expect((await f.call()).isError).toBe(true); f.toolbox.detachCad();
      expect((await f.client.listTools()).tools.map(tool => tool.name)).not.toContain("evleda_check_reference_coverage");
      expect((await f.client.readResource({ uri })).contents).toHaveLength(1);
      await expect(f.client.readResource({ uri: `evleda://reference-coverage/${"0".repeat(64)}` })).rejects.toThrow("unavailable");
      await expect(f.client.readResource({ uri: "evleda://reference-coverage/not-a-digest" })).rejects.toThrow("Invalid");
    } finally { await f.close(); }
  });
});
