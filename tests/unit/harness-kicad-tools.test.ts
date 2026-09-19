import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import {
  connectKicadHarnessTools,
  createKicadHarnessTools,
  KICAD_HARNESS_TOOL_NAMES,
  KICAD_FRESH_HARNESS_TOOL_NAMES,
  projectKicadHarnessToolDefinitions,
  type KicadHarnessSession,
} from "../../src/harness/kicad-tools.js";
import { prepareFreshProject } from "../../src/harness/fresh-project.js";

const schema = { type: "object", additionalProperties: true };
const stableNames = [
  "kicad_set_project", "sch_plan_from_spec", "sch_apply_plan", "sch_verify_plan",
  "run_erc", "run_drc", "pcb_get_board_summary", "pcb_get_design_rules", "pcb_visual_qa",
  "pcb_get_tracks", "pcb_get_vias", "pcb_get_zones", "pcb_get_footprints",
  "pcb_set_board_outline", "pcb_add_track", "pcb_add_via", "pcb_place_component",
  "pcb_move_component", "pcb_move_footprint", "pcb_sync_from_schematic", "pcb_add_zone", "pcb_save",
];
const providerNames = stableNames.filter((name) => !["kicad_set_project", "run_erc", "run_drc", "pcb_get_board_summary", "pcb_visual_qa", "pcb_save"].includes(name));

function fakeSession(onCall?: (name: string) => Promise<void>): KicadHarnessSession {
  return {
    supportsQualifiedFootprintIdentitySync: () => true,
    supportsQualifiedFootprintPoseSync: () => true,
    listTools: () => stableNames.map((name) => ({ name, description: `Fake ${name}`, permission: "write" as const, inputSchema: schema })),
    callTool: async (name, argumentsValue = {}) => {
      await onCall?.(name);
      return { content: [{ type: "text", text: "ignored" }], structuredContent: { name, argumentsValue } };
    },
  };
}

describe("KiCad harness tools", () => {
  const withFreshProject = async (body: (fresh: Awaited<ReturnType<typeof prepareFreshProject>>) => Promise<void>): Promise<void> => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-no-effect-"));
    try { await body(await prepareFreshProject({ outputDir: root, name: "board", resume: false })); }
    finally { await rm(root, { recursive: true, force: true }); }
  };
  const freshSession = (onCall?: (name: string) => Promise<void>): KicadHarnessSession => ({
    supportsQualifiedFootprintIdentitySync: () => true,
    supportsQualifiedFootprintPoseSync: () => true,
    assertActivePcb: async () => undefined,
    readActivePcbSource: async (expected) => await readFile(expected, "utf8"),
    listTools: () => KICAD_FRESH_HARNESS_TOOL_NAMES.map((name) => ({ name, description: name, permission: "write" as const, inputSchema: schema })),
    callTool: async (name) => { await onCall?.(name); return { content: [], structuredContent: { ok: true } }; },
  });
  const propertyArguments = { reference: "R1", field: "Footprint", value: "Resistor_SMD:R_0603" };

  it.each(["assertActivePcb", "readActivePcbSource"] as const)("rejects missing private %s before any fresh mutation", async (method) => {
    await withFreshProject(async (fresh) => {
      const calls: string[] = [];
      const session = freshSession(async (name) => { calls.push(name); });
      delete session[method];
      const bridge = createKicadHarnessTools(session, { freshProject: fresh });
      await expect(bridge.execute({ id: "missing-private-port", name: "sch_modify_property", arguments: propertyArguments })).rejects.toThrow(/private active-PCB identity and raw-source ports/iu);
      expect(calls).toEqual([]);
    });
  });

  it("keeps the generic authored-pattern schematic metadata restriction out of legacy authoring and save", async () => {
    await withFreshProject(async (fresh) => {
      await writeFile(fresh.schematicPath, '(kicad_sch (label "VIN" (at 1 2 0) (property private "Netclass" "Legacy")) (directive_label "" (at 1 2 0) (length 2.54) (shape dot)) (rule_area (polyline (pts (xy 0 0) (xy 10 0) (xy 0 0)))))', "utf8");
      const bridge = createKicadHarnessTools(freshSession(), { freshProject: fresh, verifyPersistedMutation: async () => true });
      await expect(bridge.execute({ id: "legacy-metadata", name: "sch_modify_property", arguments: propertyArguments })).resolves.toMatchObject({ toolCallId: "legacy-metadata" });
      expect(await bridge.internal.saveAfterMutation({ id: "legacy-save", name: "pcb_save", arguments: {} })).not.toHaveProperty("isError", true);
    });
  });

  it("classifies exact synchronous schematic no-ops from authoritative bytes only", async () => {
    await withFreshProject(async (fresh) => {
      const bridge = createKicadHarnessTools(freshSession(), { freshProject: fresh });
      await bridge.execute({ id: "same-property", name: "sch_modify_property", arguments: propertyArguments });
      await expect(bridge.internal.classifyPendingMutationBatch?.()).resolves.toMatchObject({
        schemaVersion: "evleda.mutation-batch-disposition.v1", status: "no-governed-effect", domain: "schematic-file",
      });
      await expect(bridge.internal.classifyPendingMutationBatch?.()).resolves.toBeUndefined();
    });
  });

  it("does not classify a real schematic change, a mixed batch, or a PCB-only no-op as schematic no-effect", async () => {
    await withFreshProject(async (fresh) => {
      const real = createKicadHarnessTools(freshSession(async (name) => {
        if (name === "sch_modify_property") await writeFile(fresh.schematicPath, "(kicad_sch changed)\n", "utf8");
      }), { freshProject: fresh });
      await real.execute({ id: "real", name: "sch_modify_property", arguments: propertyArguments });
      await expect(real.internal.classifyPendingMutationBatch?.()).resolves.toBeUndefined();

      const mixed = createKicadHarnessTools(freshSession(), { freshProject: fresh });
      await mixed.execute({ id: "same", name: "sch_modify_property", arguments: propertyArguments });
      await mixed.execute({ id: "pcb", name: "pcb_add_track", arguments: {} });
      await expect(mixed.internal.classifyPendingMutationBatch?.()).resolves.toBeUndefined();

      const mixedReversed = createKicadHarnessTools(freshSession(), { freshProject: fresh });
      await mixedReversed.execute({ id: "pcb-first", name: "pcb_add_track", arguments: {} });
      await mixedReversed.execute({ id: "schematic-second", name: "sch_modify_property", arguments: propertyArguments });
      await expect(mixedReversed.internal.classifyPendingMutationBatch?.()).resolves.toBeUndefined();

      const pcbOnly = createKicadHarnessTools(freshSession(), { freshProject: fresh });
      await pcbOnly.execute({ id: "pcb-only", name: "pcb_add_track", arguments: {} });
      await expect(pcbOnly.internal.classifyPendingMutationBatch?.()).resolves.toBeUndefined();
    });
  });

  it("ignores sidecar history artifacts when classifying the canonical schematic", async () => {
    await withFreshProject(async (fresh) => {
      const bridge = createKicadHarnessTools(freshSession(async (name) => {
        if (name === "sch_modify_property") {
          await mkdir(path.join(fresh.projectPath, ".kicad-mcp"), { recursive: true });
          await mkdir(path.join(fresh.projectPath, ".history"), { recursive: true });
          await writeFile(path.join(fresh.projectPath, ".kicad-mcp", "event.json"), "changed", "utf8");
          await writeFile(path.join(fresh.projectPath, ".history", "snapshot"), "changed", "utf8");
        }
      }), { freshProject: fresh });
      await bridge.execute({ id: "hidden", name: "sch_modify_property", arguments: propertyArguments });
      await expect(bridge.internal.classifyPendingMutationBatch?.()).resolves.toMatchObject({ status: "no-governed-effect" });
    });
  });

  it("classifies two synchronous schematic calls that cancel exactly back to the batch preimage", async () => {
    await withFreshProject(async (fresh) => {
      const original = await readFile(fresh.schematicPath, "utf8");
      let calls = 0;
      const bridge = createKicadHarnessTools(freshSession(async (name) => {
        if (name !== "sch_modify_property") return;
        calls += 1;
        await writeFile(fresh.schematicPath, calls === 1 ? `${original}\n; transient mutation\n` : original, "utf8");
      }), { freshProject: fresh });
      await bridge.execute({ id: "change", name: "sch_modify_property", arguments: propertyArguments });
      await bridge.execute({ id: "cancel", name: "sch_modify_property", arguments: propertyArguments });
      await expect(bridge.internal.classifyPendingMutationBatch?.()).resolves.toMatchObject({ status: "no-governed-effect" });
    });
  });
  it("projects only the frozen practical operation set from live sidecar schemas", () => {
    const definitions = projectKicadHarnessToolDefinitions(fakeSession());
    expect(definitions.map((tool) => tool.name)).toEqual(providerNames);
    expect(KICAD_HARNESS_TOOL_NAMES).not.toContain("export_manufacturing_package");
    expect(KICAD_HARNESS_TOOL_NAMES).not.toContain("pcb_set_net_class");
  });

  it.each(["missing", "false"] as const)("hides and refuses raw sync with %s qualified-writer support while retaining reads", async support => {
    const calls: string[] = [];
    const session = fakeSession(async name => { calls.push(name); });
    if (support === "missing") delete session.supportsQualifiedFootprintIdentitySync;
    else session.supportsQualifiedFootprintIdentitySync = () => false;
    const bridge = createKicadHarnessTools(session);
    expect(bridge.tools.map(tool => tool.name)).not.toContain("pcb_sync_from_schematic");
    expect(bridge.tools.map(tool => tool.name)).toContain("pcb_get_footprints");
    await expect(bridge.execute({ id: "old-raw-sync", name: "pcb_sync_from_schematic" as never, arguments: {} })).rejects.toThrow(/Unsupported/iu);
    expect(calls).toEqual([]);
    await expect(bridge.execute({ id: "old-runtime-read", name: "pcb_get_footprints", arguments: {} })).resolves.toMatchObject({ toolCallId: "old-runtime-read" });
    expect(calls).toEqual(["pcb_get_footprints"]);
  });

  it.each(["missing", "false"] as const)("hides raw sync with %s pose qualification while retaining identity and unrelated operations", async support => {
    const calls: string[] = [];
    const session = fakeSession(async name => { calls.push(name); });
    if (support === "missing") delete session.supportsQualifiedFootprintPoseSync;
    else session.supportsQualifiedFootprintPoseSync = () => false;
    const bridge = createKicadHarnessTools(session);
    expect(session.supportsQualifiedFootprintIdentitySync?.()).toBe(true);
    expect(bridge.tools.map(tool => tool.name)).not.toContain("pcb_sync_from_schematic");
    expect(bridge.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(["pcb_get_footprints", "pcb_add_track", "pcb_move_footprint"]));
    await expect(bridge.execute({ id: "identity-only-sync", name: "pcb_sync_from_schematic" as never, arguments: {} })).rejects.toThrow(/Unsupported/iu);
    expect(calls).toEqual([]);
    await expect(bridge.execute({ id: "identity-only-read", name: "pcb_get_footprints", arguments: {} })).resolves.toMatchObject({ toolCallId: "identity-only-read" });
    expect(calls).toEqual(["pcb_get_footprints"]);
  });

  it("keeps approved inspection and edit tools from a 288-tool-shaped live catalog", () => {
    const catalog = [
      ...stableNames,
      ...Array.from({ length: 288 - stableNames.length }, (_, index) => `unreviewed_tool_${index}`),
    ];
    const definitions = projectKicadHarnessToolDefinitions({
      supportsQualifiedFootprintIdentitySync: () => true,
      listTools: () => catalog.map((name) => ({ name, permission: "write" as const, description: name, inputSchema: schema })),
    });
    const names = definitions.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["pcb_get_tracks", "pcb_get_vias", "pcb_get_footprints", "pcb_add_track", "pcb_add_via", "pcb_move_footprint"]));
    expect(names).not.toContain("run_drc");
    expect(names).not.toContain("kicad_set_project");
  });

  it("deterministically bounds a live-shaped 2935-scalar description without changing name or schema", () => {
    const inputSchema = { type: "object", properties: { layer: { type: "string" } } };
    const description = "x".repeat(2_935);
    const session: KicadHarnessSession = {
      listTools: () => [{ name: "pcb_get_tracks", permission: "read", description, inputSchema }],
      callTool: async () => ({ content: [] }),
    };
    const first = projectKicadHarnessToolDefinitions(session)[0]!;
    const second = projectKicadHarnessToolDefinitions(session)[0]!;
    expect(Array.from(first.description)).toHaveLength(2_000);
    expect(first.description.endsWith("…")).toBe(true);
    expect(first).toMatchObject({ name: "pcb_get_tracks", inputSchema });
    expect(second.description).toBe(first.description);
  });

  it("serializes calls, detaches results, and bounds invalid requests", async () => {
    let active = 0;
    let highest = 0;
    const bridge = createKicadHarnessTools(fakeSession(async () => {
      active += 1;
      highest = Math.max(highest, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    }));
    const first = bridge.execute({ id: "call-1", name: "pcb_add_track", arguments: { width: 0.25 } });
    const second = bridge.execute({ id: "call-2", name: "pcb_add_via", arguments: { drill: 0.3 } });
    expect((await first).content).toContain("pcb_add_track");
    expect((await second).content).toContain("pcb_add_via");
    expect(highest).toBe(1);
    await expect(bridge.execute({ id: "bad", name: "pcb_set_net_class" as never, arguments: {} })).rejects.toThrow(/Unsupported/iu);
    await expect(bridge.execute({ id: "large", name: "pcb_add_track", arguments: { x: "x".repeat(300_000) } })).rejects.toThrow(/limit/iu);
  });

  it("normalizes captured read-side copper layers for approved add-track writes and rejects unknown BL layers", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const bridge = createKicadHarnessTools({
      listTools: () => fakeSession().listTools(),
      callTool: async (name, args = {}) => {
        calls.push({ name, args: { ...args } });
        return { content: [], structuredContent: name === "pcb_get_tracks" ? { result: "layer=BL_F_Cu" } : { ok: true } };
      },
    });
    await expect(bridge.execute({ id: "read", name: "pcb_get_tracks", arguments: {} })).resolves.toMatchObject({ content: expect.stringContaining("F_Cu") });
    await bridge.execute({ id: "write", name: "pcb_add_track", arguments: { layer: "BL_F_Cu" } });
    expect(calls.at(-1)).toMatchObject({ name: "pcb_add_track", args: { layer: "F_Cu" } });
    await expect(bridge.execute({ id: "bad-layer", name: "pcb_add_track", arguments: { layer: "BL_Unknown_Cu" } })).rejects.toThrow(/Unsupported read-side/i);
  });

  it("always performs ERC, DRC, board summary, and visual QA in final validation", async () => {
    const calls: string[] = [];
    const bridge = createKicadHarnessTools(fakeSession(async (name) => { calls.push(name); }));
    const result = await bridge.runFinalValidation();
    expect(calls).toEqual(["run_erc", "run_drc", "pcb_get_board_summary", "pcb_visual_qa"]);
    expect(Object.keys(result)).toEqual(["erc", "drc", "boardSummary", "visualQa"]);
  });

  it("retains the generic 32K limit for other tools and unbound native checks", async () => {
    const oversized = { content: [], structuredContent: { text: "x".repeat(32_001) } };
    const generic = createKicadHarnessTools({ listTools: () => fakeSession().listTools(), callTool: async () => oversized });
    await expect(generic.execute({ id: "large-generic", name: "pcb_get_tracks", arguments: {} })).rejects.toThrow("KiCad MCP result exceeds the 32000-byte limit.");
    await expect(generic.internal.execute({ id: "unbound-large-check", name: "run_drc", arguments: {} })).rejects.toThrow("KiCad MCP result exceeds the 32000-byte limit.");
    await withFreshProject(async freshProject => {
      const fresh = createKicadHarnessTools({ ...freshSession(), callTool: async () => oversized }, { freshProject });
      await expect(fresh.internal.execute({ id: "large-summary", name: "pcb_get_board_summary", arguments: {} })).rejects.toThrow("KiCad MCP result exceeds the 32000-byte limit.");
    });
  });

  it("uses host-only fallback validation when checks are not provider-advertised and normalizes captured verdict shapes", async () => {
    const calls: string[] = [];
    const session: KicadHarnessSession = {
      listTools: () => [{ name: "pcb_add_track", permission: "write", inputSchema: schema }],
      callTool: async () => ({ content: [], structuredContent: { result: { verdict: "pass", findings: [] } } }),
    };
    const bridge = createKicadHarnessTools(session, {
      fallback: {
        async execute(call) { calls.push(call.name); return { toolCallId: call.id, content: JSON.stringify({ result: { verdict: "pass", findings: [] } }) }; },
        async saveAfterMutation(call) { return { toolCallId: call.id, content: JSON.stringify({ status: "persisted" }) }; },
      },
    });
    expect(bridge.tools.map((tool) => tool.name)).toEqual(["pcb_add_track"]);
    await expect(bridge.runFinalValidation()).resolves.toMatchObject({ erc: { result: { verdict: "pass" } } });
    expect(calls).toEqual(["run_erc", "run_drc", "pcb_get_board_summary", "pcb_visual_qa"]);

    const normalized = createKicadHarnessTools({
      listTools: () => fakeSession().listTools(),
      callTool: async () => ({ content: [], structuredContent: { result: JSON.stringify({ verdict: "pass", findings: [] }) } }),
    });
    await expect(normalized.internal.execute({ id: "verdict", name: "run_erc", arguments: {} })).resolves.toMatchObject({ content: expect.stringContaining('"status":"clean"') });
  });

  it("routes only environment/configuration-unavailable advertised validation results to fallback", async () => {
    const fallbackCalls: string[] = [];
    const fallback = {
      async execute(call: { id: string; name: string }) { fallbackCalls.push(call.name); return { toolCallId: call.id, content: JSON.stringify({ status: "clean", findings: [] }) }; },
      async saveAfterMutation(call: { id: string }) { return { toolCallId: call.id, content: "saved" }; },
    };
    const unavailable = createKicadHarnessTools({
      listTools: () => fakeSession().listTools(),
      callTool: async () => ({ content: [], structuredContent: { failure_mode: "environment", report_status: "unavailable", metadata: { available: false }, message: "IPC connection refused" } }),
    }, { fallback });
    await unavailable.internal.execute({ id: "drc-unavailable", name: "run_drc", arguments: {} });
    expect(fallbackCalls).toEqual(["run_drc"]);

    const designFailure = createKicadHarnessTools({
      listTools: () => fakeSession().listTools(),
      callTool: async () => ({ content: [], structuredContent: { failure_mode: "design", verdict: "FAIL", report_status: "complete", findings: [{ message: "clearance" }] } }),
    }, { fallback });
    const result = await designFailure.internal.execute({ id: "drc-fail", name: "run_drc", arguments: {} });
    expect(result.content).toContain("FAIL");
    expect(fallbackCalls).toEqual(["run_drc"]);
  });

  it("preserves real MCP error results and contains save throws as terminal errors", async () => {
    const mcpError = createKicadHarnessTools({
      listTools: () => fakeSession().listTools(),
      callTool: async (name) => name === "pcb_add_track"
        ? { isError: true, content: [{ type: "text", text: "track rejected" }] }
        : { content: [], structuredContent: { result: "ok" } },
    });
    await expect(mcpError.execute({ id: "mcp-error", name: "pcb_add_track", arguments: {} })).resolves.toMatchObject({ isError: true });

    const saveError = createKicadHarnessTools({
      listTools: () => fakeSession().listTools(),
      callTool: async (name) => {
        if (name === "pcb_save") throw new Error("save transport closed");
        return { content: [], structuredContent: { result: "ok" } };
      },
    }, { verifyPersistedMutation: async () => true });
    await expect(saveError.internal.saveAfterMutation({ id: "save-throw", name: "pcb_save", arguments: {} })).resolves.toMatchObject({
      isError: true, content: expect.stringContaining("save transport closed"),
    });
  });

  it("compares save persistence with the current mutation preimage, not a run-start fingerprint", async () => {
    let fingerprint = "state-after-earlier-saved-work";
    const seen: (string | undefined)[] = [];
    const bridge = createKicadHarnessTools({
      listTools: () => fakeSession().listTools(),
      callTool: async (name) => {
        if (name === "pcb_add_track") fingerprint = "state-after-this-track";
        return { content: [], structuredContent: { result: "ok" } };
      },
    }, {
      capturePersistedMutationBaseline: async () => fingerprint,
      verifyPersistedMutation: async (baseline) => { seen.push(baseline); return baseline !== fingerprint; },
    });
    await bridge.execute({ id: "track", name: "pcb_add_track", arguments: {} });
    await expect(bridge.internal.saveAfterMutation({ id: "save-current", name: "pcb_save", arguments: {} })).resolves.not.toMatchObject({ isError: true });
    expect(seen).toEqual(["state-after-earlier-saved-work"]);

    const noOp = createKicadHarnessTools(fakeSession(), {
      capturePersistedMutationBaseline: async () => "already-changed-before-this-call",
      verifyPersistedMutation: async (baseline) => baseline !== "already-changed-before-this-call",
    });
    await noOp.execute({ id: "noop-track", name: "pcb_add_track", arguments: {} });
    await expect(noOp.internal.saveAfterMutation({ id: "save-noop", name: "pcb_save", arguments: {} })).resolves.toMatchObject({ isError: true });
  });

  it("refuses edit bridge connection without an isolated write session", async () => {
    await expect(connectKicadHarnessTools({ workspaceRoot: "x", projectRoot: "x" })).rejects.toThrow(/isolated working copy/iu);
  });
});
