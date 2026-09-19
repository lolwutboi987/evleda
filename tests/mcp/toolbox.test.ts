import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { createKicadHarnessTools, type KicadHarnessSession, type KicadHarnessToolsOptions } from "../../src/harness/kicad-tools.js";
import { createKicadToolboxMcpServer } from "../../src/mcp/toolbox-server.js";
import { canonicalIdentity } from "../../src/core/canonical.js";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { prepareFreshProject, preparePlaneFreshProject } from "../../src/harness/fresh-project.js";
import { captureKicadNativeSourceHashes } from "../../src/integrations/kicad-cli.js";
import { nativeCheckReply, nativeErcReport } from "../helpers/native-check-verdict.js";
import { cleanupDerivedPowerFixtures, derivedPowerFixture } from "../helpers/derived-power-bundle.js";
import { createPcbPlaneCompilationBundleRef } from "../../src/harness/pcb-design-plane-bundle.js";

const payload = (result: unknown): Record<string, unknown> => (result as { structuredContent: Record<string, unknown> }).structuredContent;

async function connect(options: Parameters<typeof createKicadToolboxMcpServer>[0] = {}) {
  const toolbox = createKicadToolboxMcpServer(options);
  const client = new Client({ name: "toolbox-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await toolbox.server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, toolbox, close: async () => { await client.close(); await toolbox.close(); } };
}

function makeCad() {
  const calls: string[] = [];
  let revision = 0;
  const close = vi.fn(async () => {});
  const callTool = vi.fn(async (name: string) => {
    calls.push(name);
    if (name === "pcb_add_track") revision += 1;
    return { content: [{ type: "text" as const, text: JSON.stringify({ status: "ok", operation: name }) }],
      structuredContent: { status: "ok", operation: name } };
  });
  const schema = { type: "object", properties: { width: { type: "number", minimum: 0.1 } }, required: ["width"], additionalProperties: false };
  const session: KicadHarnessSession = {
    listTools: () => [
      { name: "pcb_get_tracks", permission: "read", description: "Read tracks", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
      { name: "pcb_add_track", permission: "write", description: "Add track", inputSchema: schema },
      ...["pcb_save", "run_erc", "run_drc", "pcb_get_board_summary", "pcb_visual_qa", "evleda_get_live_pcb_pad_snapshot", "kicad_set_project"].map(name => ({ name, permission: "read" as const, inputSchema: { type: "object", properties: {} } })),
    ],
    callTool,
  };
  const tools = createKicadHarnessTools(session, {
    capturePersistedMutationBaseline: async () => String(revision),
    verifyPersistedMutation: async baseline => baseline !== String(revision),
  });
  return { calls, callTool, cad: { tools, assertCurrent: vi.fn(async () => {}), captureSources: async () => String(revision), close } };
}

describe("direct KiCad toolbox MCP", () => {
  async function withActualNativeReport(body: (f: { root: string; project: Awaited<ReturnType<typeof prepareFreshProject>>;
    connection: Awaited<ReturnType<typeof connect>>; calls: string[]; drc: ReturnType<typeof nativeCheckReply>;
    onDrc: { run?: () => Promise<void>; oversizedSummary?: boolean }; postDrcSourceChecks: () => number;
    libraryPath?: string }) => Promise<void>, annotated = false) {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-toolbox-check-report-"));
    let connection: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      const power = annotated ? derivedPowerFixture() : undefined;
      const project = power === undefined ? await prepareFreshProject({ outputDir: root, name: "rp2350-pico", resume: false })
        : await preparePlaneFreshProject({ outputDir: root, name: "rp2350-pico", resume: false,
          compilationBundle: power.bundle, compilationBundleRef: createPcbPlaneCompilationBundleRef(power.bundle) });
      const calls: string[] = [], drc = nativeCheckReply(), onDrc: { run?: () => Promise<void>; oversizedSummary?: boolean } = {};
      let postDrcSourceChecks = 0;
      const annotationOptions: Partial<KicadHarnessToolsOptions> = power === undefined ? {} : {
        freshPlaneCompilationBundle: power.bundle, freshConnectivityContract: power.bundle.contract,
        freshLibraryResolver: {
          resolveSymbol: power.resolver.resolveSymbol.bind(power.resolver), resolveFootprint: power.resolver.resolveFootprint.bind(power.resolver),
          inspectSymbol: power.resolver.inspectSymbol.bind(power.resolver), inspectFootprint: power.resolver.inspectFootprint.bind(power.resolver),
          inspectSymbolTerminalGeometry: power.resolver.inspectSymbolTerminalGeometry.bind(power.resolver),
          inspectExternalPowerFlag: power.resolver.inspectExternalPowerFlag.bind(power.resolver),
          captureSourceSelection: request => { if (calls.at(-1) === "run_drc") postDrcSourceChecks++; return power.resolver.captureSourceSelection(request); },
        }, freshPhysicalFootprintResolver: power.resolver,
        freshPhysicalFootprintSourcePins: power.bundle.contract.components.map(c => ({ reference: c.reference, libraryId: c.footprintLibId,
          sourceIdentity: power.resolver.inspectFootprint(c.footprintLibId)!.sourceIdentity })),
        captureFreshNativeNetlist: async () => { throw new Error("Unexpected netlist operation in validation regression"); },
      };
      const session: KicadHarnessSession = { listTools: () => ["run_erc", "run_drc", "pcb_get_board_summary", "pcb_visual_qa"].map(name => ({ name, permission: "read", inputSchema: { type: "object", properties: {} } })),
        supportsExternalPowerFlagConnectivity: () => true, supportsQualifiedFootprintIdentitySync: () => true,
        readActivePcbSource: async () => await readFile(project.pcbPath, "utf8"), assertActivePcb: async () => {},
        readLivePcbPadSnapshot: async () => { throw new Error("Unexpected physical pad operation in validation regression"); },
        callTool: async name => { calls.push(name); if (name === "run_drc") { await onDrc.run?.(); return structuredClone(drc); }
          if (name === "pcb_get_board_summary" && onDrc.oversizedSummary) return { content: [], structuredContent: { result: "x".repeat(32_001) } };
          return name === "run_erc" ? nativeCheckReply("run_erc", nativeErcReport([])) : { content: [], structuredContent: { status: "ok", operation: name } }; } };
      const tools = createKicadHarnessTools(session, { freshProject: project, ...annotationOptions });
      connection = await connect({ cad: { tools, assertCurrent: async () => {}, captureSources: async () => JSON.stringify(await captureKicadNativeSourceHashes(project.projectPath)), close: async () => {} } });
      if (power !== undefined) { expect(power.bundle.derivedPowerBinding).toBeDefined(); expect(power.bundle.externalPowerBinding).toBeDefined(); }
      await body({ root, project, connection, calls, drc, onDrc, postDrcSourceChecks: () => postDrcSourceChecks,
        ...(power === undefined ? {} : { libraryPath: power.symbolFiles.Device! }) });
    } finally { await connection?.close(); cleanupDerivedPowerFixtures(); expect(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)).toBe(true); await rm(root, { recursive: true, force: true }); }
  }

  it("completes public validation with all 192 DRC errors retained privately and blocking in its bounded report", async () => {
    await withActualNativeReport(async f => {
      const response = await f.connection.client.callTool({ name: "evleda_validate_design", arguments: {} });
      expect(response.isError).not.toBe(true); // Collection succeeded; the DRC verdict below is explicitly FAIL.
      const output = payload(response), checks = output.checks as Array<{ name: string; result: { content: string } }>;
      expect(f.calls).toEqual(["run_erc", "run_drc", "pcb_get_board_summary", "pcb_visual_qa"]);
      expect(output.sourceUnchanged).toBe(true);
      const drc = JSON.parse(checks.find(c => c.name === "run_drc")!.result.content);
      expect(drc).toMatchObject({ verdict: "FAIL", status: "failed", metadata: { unconnected_items: 192, violations: 0 },
        findingEvidence: { total: 192, returned: 8, omitted: 184, counts: { error: 192 } }, coverage: { ignoredCheckCount: 5 } });
      expect(Buffer.byteLength(checks[1]!.result.content)).toBeLessThan(32_000);
      const record = JSON.parse(await readFile(path.join(f.root, ".evleda-mcp-output", drc.diagnostic.filename), "utf8"));
      expect(record.response).toEqual(f.drc);
      expect(record.response.structuredContent.findings).toHaveLength(192);
      expect(record.response.structuredContent.evidence[0].violations.unconnected_items).toHaveLength(192);
      expect(record.sourceHashes).toEqual(await captureKicadNativeSourceHashes(f.project.projectPath));
      expect(payload(await f.connection.client.callTool({ name: "evleda_toolbox_status", arguments: {} }))).toMatchObject({ recoveryRequired: false });
    });
  });

  it.each(["bad-count", "source-drift", "artifact-failure"] as const)("fails public validation closed on %s without claiming complete checks", async fault => {
    await withActualNativeReport(async f => {
      if (fault === "bad-count") f.drc.structuredContent.metadata.unconnected_items = 0;
      if (fault === "source-drift") f.onDrc.run = async () => { await writeFile(f.project.schematicPath, `${await readFile(f.project.schematicPath, "utf8")}\n`); };
      if (fault === "artifact-failure") await writeFile(path.join(f.root, ".evleda-mcp-output"), "blocked");
      const response = await f.connection.client.callTool({ name: "evleda_validate_design", arguments: {} });
      expect(response.isError).toBe(true); expect(payload(response)).not.toHaveProperty("checks");
      expect(f.calls).toEqual(["run_erc", "run_drc"]);
      if (fault !== "artifact-failure") expect(await readdir(f.root)).not.toContain(".evleda-mcp-output");
    });
  });

  it("projects the actual 192-row report through annotated V2 public validation and all post-reply source guards", async () => {
    await withActualNativeReport(async f => {
      expect(f.project.workflowKind).toBe("plane");
      const response = await f.connection.client.callTool({ name: "evleda_validate_design", arguments: {} });
      expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
      const checks = payload(response).checks as Array<{ name: string; result: { content: string } }>;
      const report = JSON.parse(checks.find(c => c.name === "run_drc")!.result.content);
      expect(report).toMatchObject({ verdict: "FAIL", status: "failed", metadata: { unconnected_items: 192 }, findingEvidence: { total: 192, counts: { error: 192 } } });
      expect(f.calls).toEqual(["run_erc", "run_drc", "pcb_get_board_summary", "pcb_visual_qa"]);
      expect(f.postDrcSourceChecks()).toBeGreaterThan(0);
      const saved = JSON.parse(await readFile(path.join(f.root, ".evleda-mcp-output", report.diagnostic.filename), "utf8"));
      expect(saved.response).toEqual(f.drc); expect(saved.response.structuredContent.findings).toHaveLength(192);
      expect(payload(response).sourceUnchanged).toBe(true);
    }, true);
  });

  it.each(["malformed", "source-drift", "library-drift", "native-error", "other-overflow"] as const)("retains annotated V2 public validation rejection for %s", async fault => {
    await withActualNativeReport(async f => {
      if (fault === "malformed") f.drc.structuredContent.metadata.unconnected_items = 0;
      if (fault === "source-drift") f.onDrc.run = async () => { await writeFile(f.project.schematicPath, `${await readFile(f.project.schematicPath, "utf8")}\n`); };
      if (fault === "library-drift") f.onDrc.run = async () => { await writeFile(f.libraryPath!, `${await readFile(f.libraryPath!, "utf8")}\n`); };
      if (fault === "native-error") f.onDrc.run = async () => { await writeFile(f.libraryPath!, `${await readFile(f.libraryPath!, "utf8")}\n`); throw new Error("primary native report failure"); };
      if (fault === "other-overflow") f.onDrc.oversizedSummary = true;
      const response = await f.connection.client.callTool({ name: "evleda_validate_design", arguments: {} });
      expect(response.isError).toBe(true); expect(payload(response)).not.toHaveProperty("checks");
      if (fault === "native-error") { expect(payload(response).error).toBe("primary native report failure"); expect(f.postDrcSourceChecks()).toBe(0); }
      else expect(f.postDrcSourceChecks()).toBeGreaterThan(0);
      expect(f.calls).toEqual(fault === "other-overflow" ? ["run_erc", "run_drc", "pcb_get_board_summary"] : ["run_erc", "run_drc"]);
      if (fault === "other-overflow") {
        expect(payload(response).error).toBe("KiCad MCP result exceeds the 32000-byte limit.");
        const files = await readdir(path.join(f.root, ".evleda-mcp-output")); expect(files).toHaveLength(1);
      } else expect(await readdir(f.root)).not.toContain(".evleda-mcp-output");
    }, true);
  });

  it("finishes native state over MCP before the client disconnects, without certifying the design", async () => {
    const fixture = makeCad(); const publish = vi.fn(); const prepareCheckpoint = vi.fn().mockResolvedValue(publish);
    const connection = await connect({ cad: { ...fixture.cad, prepareCheckpoint }, access: "edit" });
    try {
      const result = await connection.client.callTool({ name: "evleda_finish_session", arguments: {} });
      expect(result.structuredContent).toMatchObject({ nativeSessionClosed: true, checkpointPublished: true, recoveryRequired: false });
      expect(publish).toHaveBeenCalledOnce(); expect(fixture.cad.close).toHaveBeenCalledOnce();
      const late = await connection.client.callTool({ name: "pcb_add_track", arguments: { width: 0.5 } });
      expect(late.isError).toBe(true); expect(fixture.callTool).not.toHaveBeenCalled();
      await connection.client.callTool({ name: "evleda_finish_session", arguments: {} });
      expect(prepareCheckpoint).toHaveBeenCalledOnce();
      expect((await connection.client.callTool({ name: "evleda_rule_topics", arguments: {} })).isError).not.toBe(true);
    } finally { await connection.close(); }
    expect(fixture.cad.close).toHaveBeenCalledOnce();
  });

  it("publishes a captured checkpoint only after clean owned teardown", async () => {
    const fixture = makeCad(); const order: string[] = [];
    const cad = { ...fixture.cad, prepareCheckpoint: async () => { order.push("capture"); return async () => { order.push("publish"); }; },
      close: async () => { order.push("close"); } };
    const connection = await connect({ cad }); await connection.close();
    expect(order).toEqual(["capture", "close", "publish"]);
  });

  it("does not publish a checkpoint after uncertain teardown", async () => {
    const fixture = makeCad(); const publish = vi.fn(); const recordRecoveryRequired = vi.fn();
    const connection = await connect({ cad: { ...fixture.cad, prepareCheckpoint: async () => publish,
      close: async () => { throw new Error("teardown uncertain"); }, recordRecoveryRequired } });
    await expect(connection.close()).rejects.toThrow("teardown uncertain");
    expect(publish).not.toHaveBeenCalled(); expect(recordRecoveryRequired).toHaveBeenCalledOnce();
  });

  it("poisons recovery instead of checkpointing a failed mutation", async () => {
    const fixture = makeCad(); fixture.callTool.mockRejectedValue(new Error("mutation uncertain"));
    const prepareCheckpoint = vi.fn(); const recordRecoveryRequired = vi.fn();
    const connection = await connect({ access: "edit", cad: { ...fixture.cad, prepareCheckpoint, recordRecoveryRequired } });
    const result = await connection.client.callTool({ name: "pcb_add_track", arguments: { width: 0.5 } });
    expect(result.isError).toBe(true); await connection.close();
    expect(prepareCheckpoint).not.toHaveBeenCalled(); expect(recordRecoveryRequired).toHaveBeenCalledOnce();
  });

  it("exposes only host-bound practice analysis and includes it with native validation", async () => {
    const fixture = makeCad();
    const report = { turnPolicy: { violations: [{ directionChangeDeg: 90 }] }, checks: { electricalSuitability: "unverified" } };
    const analyzePractices = vi.fn().mockResolvedValue(report);
    const connection = await connect({ cad: { ...fixture.cad, analyzePractices } });
    try {
      const result = await connection.client.callTool({ name: "evleda_check_board_practices", arguments: {} });
      expect(result.structuredContent).toMatchObject({ sourceUnchanged: true, report });
      expect(analyzePractices).toHaveBeenCalledWith();
      const invalid = await connection.client.callTool({ name: "evleda_check_board_practices", arguments: { pcbPath: "another.kicad_pcb" } });
      expect(invalid.isError).toBe(true);
      expect(analyzePractices).toHaveBeenCalledTimes(1);
      const validation = await connection.client.callTool({ name: "evleda_validate_design", arguments: {} });
      expect(validation.structuredContent).toMatchObject({ practices: { available: true, result: report } });
      expect(analyzePractices).toHaveBeenCalledTimes(2);
    } finally { await connection.close(); }
  });

  it("does not associate practice findings with changed project sources", async () => {
    const fixture = makeCad(); let revision = 0;
    const connection = await connect({ cad: { ...fixture.cad, captureSources: async () => String(revision),
      analyzePractices: async () => { revision += 1; return { geometry: "stale" }; } } });
    try {
      const result = await connection.client.callTool({ name: "evleda_check_board_practices", arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ sourceUnchanged: false });
    } finally { await connection.close(); }
  });

  it("runs verified guidance without pretending a CAD session exists", async () => {
    const connection = await connect();
    try {
      const listed = await connection.client.listTools();
      expect(listed.tools.map(tool => tool.name)).toEqual([
        "evleda_toolbox_status", "evleda_rule_topics", "evleda_find_rules", "evleda_read_guide",
      ]);
      const status = await connection.client.callTool({ name: "evleda_toolbox_status", arguments: {} });
      expect(status.structuredContent).toMatchObject({ cadConnected: false, access: "guidance-only", cadTools: [] });
      const topics = await connection.client.callTool({ name: "evleda_rule_topics", arguments: {} });
      expect(topics.structuredContent).toMatchObject({ ruleCount: 1773 });
      expect((payload(topics).topics as unknown[]).length).toBe(17);
      expect((await connection.client.listResources()).resources).toHaveLength(17);
    } finally { await connection.close(); }
  });

  it("preserves full rule fields and guide resources", async () => {
    const connection = await connect();
    try {
      const resources = await connection.client.listResources();
      const topic = decodeURIComponent(new URL(resources.resources[0]!.uri).pathname.split("/").at(-1)!);
      const first = await connection.client.callTool({ name: "evleda_find_rules", arguments: { topics: [topic], limit: 1 } });
      const rule = (payload(first).rules as Record<string, unknown>[])[0]!;
      expect(rule).toHaveProperty("instruction");
      expect(rule).toHaveProperty("requiredInputs");
      expect(rule).toHaveProperty("primarySourceUrls");
      expect(payload(first).returnedRuleCount).toBe(1);
      expect(payload(first).nextOffset).toBe(1);
      const read = await connection.client.readResource({ uri: resources.resources[0]!.uri });
      const guide = await connection.client.callTool({ name: "evleda_read_guide", arguments: { topic } });
      expect(payload(guide).text).toBe((read.contents[0] as { text: string }).text);
      const invalid = await connection.client.callTool({ name: "evleda_find_rules", arguments: { limit: 1 } });
      expect(invalid.isError).toBe(true);
    } finally { await connection.close(); }
  });

  it("does not expose private/internal tools or enable edits through arguments", async () => {
    const fixture = makeCad();
    const connection = await connect({ cad: fixture.cad });
    try {
      const names = (await connection.client.listTools()).tools.map(tool => tool.name);
      expect(names).toContain("pcb_get_tracks");
      expect(names).toContain("evleda_validate_design");
      expect(names).not.toContain("pcb_add_track");
      expect(names).not.toContain("pcb_save");
      expect(names).not.toContain("kicad_set_project");
      expect(names).not.toContain("evleda_get_live_pcb_pad_snapshot");
      await expect(connection.client.callTool({ name: "pcb_add_track", arguments: { width: 0.5 } })).rejects.toThrow("not found");
      expect(fixture.calls).toEqual([]);
    } finally { await connection.close(); }
  });

  it("validates actual advertised schema before dispatch and uses existing mandatory save", async () => {
    const fixture = makeCad();
    const connection = await connect({ cad: fixture.cad, access: "edit" });
    try {
      const invalid = await connection.client.callTool({ name: "pcb_add_track", arguments: { width: "0.5" } });
      expect(invalid.isError).toBe(true);
      expect(fixture.calls).toEqual([]);
      const result = await connection.client.callTool({ name: "pcb_add_track", arguments: { width: 0.5 } });
      expect(result.isError).not.toBe(true);
      expect(fixture.calls).toEqual(["pcb_add_track", "pcb_save"]);
      expect(result.structuredContent).toMatchObject({ operation: "pcb_add_track", persistence: { toolCallId: expect.any(String) }, noGovernedEffect: false });
    } finally { await connection.close(); }
  });

  it("serializes whole edit/save intervals", async () => {
    const fixture = makeCad();
    const connection = await connect({ cad: fixture.cad, access: "edit" });
    try {
      await Promise.all([1, 2].map(() => connection.client.callTool({ name: "pcb_add_track", arguments: { width: 0.5 } })));
      expect(fixture.calls).toEqual(["pcb_add_track", "pcb_save", "pcb_add_track", "pcb_save"]);
    } finally { await connection.close(); }
  });

  it("retains uncertain mutation state rather than admitting more edits", async () => {
    const fixture = makeCad();
    const original = fixture.callTool.getMockImplementation()!;
    fixture.callTool.mockImplementation(async name => {
      if (name === "pcb_save") { fixture.calls.push(name); throw new Error("Native save unavailable"); }
      return await original(name);
    });
    const connection = await connect({ cad: fixture.cad, access: "edit" });
    try {
      expect((await connection.client.callTool({ name: "pcb_add_track", arguments: { width: 0.5 } })).isError).toBe(true);
      expect((await connection.client.callTool({ name: "pcb_add_track", arguments: { width: 0.5 } })).isError).toBe(true);
      expect(fixture.calls).toEqual(["pcb_add_track", "pcb_save"]);
      const status = await connection.client.callTool({ name: "evleda_toolbox_status", arguments: {} });
      expect(payload(status).recoveryRequired).toBe(true);
    } finally { await connection.close(); }
  });

  it("reports native results with source association without manufacturing a pass", async () => {
    const fixture = makeCad();
    const connection = await connect({ cad: fixture.cad });
    try {
      const result = await connection.client.callTool({ name: "evleda_validate_design", arguments: {} });
      expect(fixture.calls).toEqual(["run_erc", "run_drc", "pcb_get_board_summary", "pcb_visual_qa"]);
      expect(result.structuredContent).toMatchObject({ sourceBefore: "0", sourceAfter: "0", sourceUnchanged: true });
      expect(result.structuredContent).not.toHaveProperty("passed");
    } finally { await connection.close(); }
    expect(fixture.cad.close).toHaveBeenCalledTimes(1);
  });

  it("does not associate changed sources with a clean validation collection", async () => {
    const fixture = makeCad();
    const captureSources = vi.fn().mockResolvedValueOnce("before").mockResolvedValueOnce("after");
    const connection = await connect({ cad: { ...fixture.cad, captureSources } });
    try {
      const result = await connection.client.callTool({ name: "evleda_validate_design", arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ sourceUnchanged: false, sourceBefore: "before", sourceAfter: "after" });
      expect(result.structuredContent).not.toHaveProperty("passed");
    } finally { await connection.close(); }
  });

  it("rejects changed active-document binding before a mutation and reports unavailable CAD", async () => {
    const fixture = makeCad();
    fixture.cad.assertCurrent.mockRejectedValue(new Error("Active PCB differs from the bound document"));
    const connection = await connect({ cad: fixture.cad, access: "edit" });
    try {
      const result = await connection.client.callTool({ name: "pcb_add_track", arguments: { width: 0.5 } });
      expect(result.isError).toBe(true);
      expect(fixture.calls).toEqual([]);
      expect(payload(await connection.client.callTool({ name: "evleda_toolbox_status", arguments: {} })))
        .toMatchObject({ cadBound: true, cadConnected: false, connectionProblem: expect.stringContaining("Active PCB") });
    } finally { await connection.close(); }
  });

  it("does not save another active document when binding changes during the edit", async () => {
    const fixture = makeCad();
    let current = true;
    fixture.cad.assertCurrent.mockImplementation(async () => { if (!current) throw new Error("Active document changed"); });
    const original = fixture.callTool.getMockImplementation()!;
    fixture.callTool.mockImplementation(async name => {
      const result = await original(name);
      if (name === "pcb_add_track") current = false;
      return result;
    });
    const connection = await connect({ cad: fixture.cad, access: "edit" });
    try {
      const result = await connection.client.callTool({ name: "pcb_add_track", arguments: { width: 0.5 } });
      expect(result.isError).toBe(true);
      expect(fixture.calls).toEqual(["pcb_add_track"]);
      expect(payload(await connection.client.callTool({ name: "evleda_toolbox_status", arguments: {} })).recoveryRequired).toBe(true);
    } finally { await connection.close(); }
  });

  it("surfaces uncertain teardown instead of reporting successful close", async () => {
    const fixture = makeCad();
    fixture.cad.close.mockRejectedValue(new Error("Native teardown unconfirmed"));
    const connection = await connect({ cad: fixture.cad });
    await connection.client.close();
    await expect(connection.toolbox.close()).rejects.toThrow("teardown unconfirmed");
    await expect(connection.toolbox.close()).rejects.toThrow("teardown unconfirmed");
    expect(fixture.cad.close).toHaveBeenCalledTimes(1);
  });

  it("requires host contract identity for compound exposure and rejects invalid compound evidence", async () => {
    const fixture = makeCad();
    const tools = { ...fixture.cad.tools,
      tools: [{ name: "fresh_sync_from_schematic", description: "Bound sync", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
      execute: vi.fn(async (call: { id: string }) => ({ toolCallId: call.id, content: "{}" })),
      internal: fixture.cad.tools.internal,
      freshBoardSaveAudits: [],
      captureFreshPcbPadEvidence: fixture.cad.tools.captureFreshPcbPadEvidence.bind(fixture.cad.tools),
      runFinalValidation: fixture.cad.tools.runFinalValidation.bind(fixture.cad.tools),
    };
    const unbound = await connect({ cad: { ...fixture.cad, tools }, access: "edit" });
    try {
      expect((await unbound.client.listTools()).tools.map(tool => tool.name)).not.toContain("fresh_sync_from_schematic");
    } finally { await unbound.close(); }
    const bound = await connect({ cad: { ...fixture.cad, tools }, access: "edit",
      compoundContractIdentity: canonicalIdentity({ test: "contract" }, "evleda.pcb-design-contract.v1") });
    try {
      const result = await bound.client.callTool({ name: "fresh_sync_from_schematic", arguments: {} });
      expect(result.isError).toBe(true);
      expect(fixture.calls).toEqual([]);
      expect(payload(await bound.client.callTool({ name: "evleda_toolbox_status", arguments: {} })).recoveryRequired).toBe(true);
    } finally { await bound.close(); }
  });

  it("paginates beyond the existing selector's250-record cap without losing records", async () => {
    const connection = await connect();
    try {
      const result = await connection.client.callTool({ name: "evleda_find_rules", arguments: {
        severities: ["advisory", "warning", "error", "critical"], offset: 250, limit: 10,
      } });
      expect(payload(result)).toMatchObject({ matchingRuleCount: 1773, offset: 250, returnedRuleCount: 10, nextOffset: 260 });
      expect(new Set((payload(result).rules as { id: string }[]).map(rule => rule.id)).size).toBe(10);
    } finally { await connection.close(); }
  });
});
