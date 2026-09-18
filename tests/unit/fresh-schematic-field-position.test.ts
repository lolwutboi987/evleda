import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { link, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { planFreshSchematicFieldPositions, FRESH_SCHEMATIC_FIELD_POSITION_TOOL } from "../../src/harness/fresh-schematic-field-position.js";
import { planFreshSchematicSymbolPoses, FRESH_SCHEMATIC_SYMBOL_POSE_TOOL } from "../../src/harness/fresh-schematic-symbol-pose.js";
import { parseFreshSchematicSource, parseFreshSchematicSourceDocument } from "../../src/harness/fresh-kicad-parser.js";
import { harnessToolResultSchema } from "../../src/harness/contracts.js";
import { FreshSchematicRollback } from "../../src/harness/fresh-schematic-rollback.js";
import { createKicadHarnessTools, type KicadHarnessSession } from "../../src/harness/kicad-tools.js";
import { createFreshSchematicStrokeStyleEvidence, FRESH_SCHEMATIC_STROKE_NATIVE_PROFILE as profile, type FreshSchematicStrokeStyleCapture } from "../../src/harness/fresh-schematic-stroke-style.js";
import { prepareFreshProject, parseFreshIncrementalArguments } from "../../src/harness/fresh-project.js";
import { createGenericDividerBundleFixture } from "../helpers/generic-divider-bundle.js";
import { createToolboxSchematicFieldDiagnostics } from "../../src/mcp/toolbox-schematic-field-diagnostics.js";
import { createKicadToolboxMcpServer } from "../../src/mcp/toolbox-server.js";

const source = `(kicad_sch (version 20250316) (lib_symbols (symbol "Transistor_FET:DMG1012T"
  (symbol "DMG1012T_0_1" (arc (start 0 0) (mid 1 1) (end 2 0) (stroke (width 0) (type default))))))
  (symbol (lib_id "Transistor_FET:DMG1012T") (at 130.81 172.72 270) (unit 1) (uuid "f13fedce-2b15-420f-a394-d17f7d696a71")
    (property "Reference" "Q1" (at 139.7 173.2915 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Value" "DMG1012T" (at 139.7 175.3235 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Footprint" "Resistor_SMD:R_0603_1608Metric")
    (property "custom" "literal (at 139.7 175.3235 0)"))
  (wire (pts (xy 10 10) (xy 15 10))) (label "NET" (at 15 10 0) (effects (font (size 1.27 1.27))))
  (no_connect (at 20 20)))`;
const update = { reference: "Q1", field: "Value" as const, x_mm: 139.7, y_mm: 177.8 };
const partial = source.replaceAll("Transistor_FET:DMG1012T", "Device:R").replaceAll("DMG1012T", "10k").replaceAll('"Q1"', '"R1"');
const request = { updates: [{ ...update, reference: "R1" }] };
const call = { id: "positions", name: FRESH_SCHEMATIC_FIELD_POSITION_TOOL, arguments: request };
const save = { id: "positions-save", name: "pcb_save", arguments: {} };
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(root));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Fixture cleanup escaped its temporary root.");
    await rm(root, { recursive: true, force: true });
  }
});

describe("exact position-only schematic source planning", () => {
  it("moves only the two selected coordinate spans, without interpreting symbol rotation or library arcs", () => {
    const result = planFreshSchematicFieldPositions(source, [update]);
    expect(result.source).toBe(source.replace('(property "Value" "DMG1012T" (at 139.7 175.3235 0)', '(property "Value" "DMG1012T" (at 139.7 177.8 0)'));
    expect(result.fields[0]).toMatchObject({ text: "DMG1012T", symbolId: "f13fedce-2b15-420f-a394-d17f7d696a71", before: { x: 139.7, y: 175.3235 }, after: { x: 139.7, y: 177.8 } });
    expect(parseFreshSchematicSource(result.source)).toEqual(parseFreshSchematicSource(source));
    expect(planFreshSchematicFieldPositions(result.source, [update])).toMatchObject({ source: result.source, changed: false });
  });
  it.each([0, 90, 180, 270])("keeps source field and symbol angles untouched at symbol rotation %s", rotation => {
    const before = source.replace('(at 130.81 172.72 270)', `(at 130.81 172.72 ${rotation})`);
    expect(planFreshSchematicFieldPositions(before, [update]).source).toBe(before.replace('(property "Value" "DMG1012T" (at 139.7 175.3235 0)', '(property "Value" "DMG1012T" (at 139.7 177.8 0)'));
  });
  it.each([
    { field: "Footprint" }, { text: "renamed" }, { rotation_deg: 90 }, { visible: false }, { x_mm: .00001 }, { y_mm: Infinity },
    { reference: "missing" }, { x_mm: 2001 },
  ])("rejects unsupported or nonnative update %j before producing any edited source", change => {
    expect(() => planFreshSchematicFieldPositions(source, [{ ...update, ...change } as typeof update])).toThrow();
  });
  it("rejects late missing/duplicate entries and preserves hidden field metadata", () => {
    expect(() => planFreshSchematicFieldPositions(source, [update, { ...update }])).toThrow(/unique/);
    expect(() => planFreshSchematicFieldPositions(source, [update, { ...update, reference: "Q2" }])).toThrow(/exactly one/);
    expect(() => planFreshSchematicFieldPositions(source.replace('(at 139.7 175.3235 0)', ''), [update])).toThrow(/explicit native position/);
    const hidden = source.replace('(property "Value" "DMG1012T"', '(property "Value" "DMG1012T" (hide yes)');
    expect(planFreshSchematicFieldPositions(hidden, [update])).toMatchObject({ fields: [expect.objectContaining({ hidden: true })] });
    expect(planFreshSchematicFieldPositions(hidden, [update]).source).toContain('(property "Value" "DMG1012T" (hide yes)');
  });
  it("keeps existing argument schemas closed and admits ordinary decimal Q1 coordinates", () => {
    expect(parseFreshIncrementalArguments(call.name, { updates: [update] })).toEqual({ updates: [update] });
    expect(() => parseFreshIncrementalArguments(call.name, { updates: [{ ...update, value: "changed" }] })).toThrow();
    expect(() => parseFreshIncrementalArguments(call.name, { updates: Array.from({ length: 129 }, () => update) })).toThrow();
  });
  it("supports the complete 128-field ceiling while preserving every nonposition field", () => {
    const symbol = parseFreshSchematicSourceDocument(source).children.find(node => node.name === "symbol")!;
    const block = source.slice(symbol.start, symbol.end);
    const symbols = Array.from({ length: 64 }, (_, i) => block.replaceAll('"Q1"', `"Q${i + 1}"`)
      .replace('f13fedce-2b15-420f-a394-d17f7d696a71', `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`));
    const before = `(kicad_sch (lib_symbols) ${symbols.join('\n')})`;
    const updates = symbols.flatMap((_, i) => (['Reference', 'Value'] as const).map(field => ({ reference: `Q${i + 1}`, field, x_mm: 100 + i, y_mm: field === 'Value' ? 177.8 : 170 })));
    const planned = planFreshSchematicFieldPositions(before, updates);
    expect(planned.fields).toHaveLength(128); expect(planned.fields.every(field => field.changed)).toBe(true);
    expect(parseFreshSchematicSource(planned.source)).toEqual(parseFreshSchematicSource(before));
  });
});

/** Synthetic trusted-producer-shaped SVG only; this does not run native KiCad. */
async function style(project: Awaited<ReturnType<typeof prepareFreshProject>>) {
  const schematic = await readFile(project.schematicPath, "utf8"), pcb = await readFile(project.pcbPath, "utf8");
  const settings = await readFile(path.join(project.projectPath, `${project.name}.kicad_pro`), "utf8");
  const current = planFreshSchematicFieldPositions(schematic, request.updates).fields[0]!.before;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300mm" height="210mm" viewBox="0 0 300 210"><g fill="none" stroke="black" stroke-width="0.1524" stroke-linecap="round" stroke-linejoin="round"><text x="${current.x}" y="${current.y}" opacity="0">10k</text><g class="stroked-text"><desc>10k</desc><path d="M${current.x} ${current.y} L${current.x + 1} ${current.y}"/></g><path d="M1 1 A1 1 0 0 0 2 2"/></g></svg>`;
  const identities = { schematic: contentIdentity(schematic), pcb: contentIdentity(pcb), projectSettings: contentIdentity(settings) };
  const executable = { kind: "kicad-cli" as const, path: path.join(project.outputPath, "fake-bin", "kicad-cli.exe"), version: profile.version,
    sha256: profile.executable.digest, sizeBytes: profile.executable.size, commit: "fixture", capabilityHelpSha256: "a".repeat(64), confirmedCapabilities: ["sch export svg"] };
  const output = path.join(project.outputPath, "fake-svg"), config = "{}";
  const tree = canonicalIdentity({}, "evleda.kicad-schematic-configuration-tree.v1");
  const capture: FreshSchematicStrokeStyleCapture = { projectSettingsSource: settings,
    render: { classification: "candidate-validation", releaseAuthorized: false, executable, outputDirectory: output,
      sourceHashes: { [`${project.name}.kicad_sch`]: identities.schematic.digest }, sourceIdentities: identities, source: svg,
      schematicSvg: { path: path.join(output, "test.svg"), relativePath: "test.svg", sha256: contentIdentity(svg).digest, sizeBytes: Buffer.byteLength(svg) },
      invocation: { executable, command: executable.path, args: ["sch", "export", "svg", "--output", output, "--black-and-white", "--exclude-drawing-sheet", "--no-background-color", project.schematicPath],
        cwd: project.projectPath, exitCode: 0, stdout: "", stderr: "", durationMs: 1, startedAt: "2026-09-17T00:00:00Z" } },
    schematicEngine: { path: path.join(path.dirname(executable.path), "_eeschema.dll"), before: profile.schematicEngine, after: profile.schematicEngine },
    configuration: { isolation: "caller-owned-isolated", configHome: path.join(project.outputPath, "fake-config"), treeBefore: tree, treeAfter: tree,
      applicationConfig: { relativePath: "10.0/eeschema.json", source: config, before: contentIdentity(config), after: contentIdentity(config) } } };
  return createFreshSchematicStrokeStyleEvidence(capture, identities);
}

async function fixture(options: { source?: string; netlistFaultAt?: number; membershipFaultAt?: number; initiallyJoined?: boolean; sourceFaultAt?: number; replaceAt?: number; saveFailure?: boolean; diagnosticFailure?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "evleda-field-positions-")); roots.push(root);
  const { bundle, reference } = createGenericDividerBundleFixture();
  const project = await prepareFreshProject({ outputDir: root, name: "positions", resume: false, workflowKind: "generic", compilationBundle: bundle, compilationBundleRef: reference });
  await writeFile(project.schematicPath, options.source ?? partial, "utf8");
  const calls: string[] = [], phases: string[] = [];
  let netlistCalls = 0, glyphCalls = 0;
  const session: KicadHarnessSession = { supportsSchematicConnectivityBatch: () => true,
    listTools: () => ["sch_modify_property", "pcb_save", "sch_get_symbols", "sch_get_connectivity_graph"].map(name => ({ name, permission: name.startsWith("sch_get") ? "read" as const : "write" as const, inputSchema: { type: "object", properties: {}, additionalProperties: false } })),
    assertActivePcb: async () => undefined, readActivePcbSource: async () => await readFile(project.pcbPath, "utf8"),
    callTool: async name => { calls.push(name); return name === "pcb_save" && options.saveFailure
      ? { isError: true, content: [{ type: "text", text: "private-position-token original native save failure" }] }
      : { content: [], structuredContent: { result: name === "pcb_save" ? "Board saved." : "Group 1: ~unnamed | pins=R1:1" } }; },
  };
  const diagnostics = createToolboxSchematicFieldDiagnostics(root);
  const bridge = createKicadHarnessTools(session, { freshProject: project, freshConnectivityContract: bundle.contract, freshCompilationBundle: bundle,
    captureFreshNativeNetlist: async () => {
      netlistCalls++;
      const text = await readFile(project.schematicPath, "utf8");
      if (netlistCalls === options.sourceFaultAt) await writeFile(project.schematicPath, text + "\nexternal-change\n", "utf8");
      if (netlistCalls === options.replaceAt) { const replacement = path.join(project.projectPath, "replacement.tmp"); await writeFile(replacement, text); await rename(replacement, project.schematicPath); }
      const components = parseFreshSchematicSource(text).symbols.map(symbol => `(comp (ref "${symbol.reference}") (value "${netlistCalls === options.netlistFaultAt ? 'CHANGED' : symbol.value}"))`).join(' ');
      const joined = options.initiallyJoined === true ? netlistCalls !== options.membershipFaultAt : netlistCalls === options.membershipFaultAt;
      const nets = joined ? '(net (code "1") (name "unnamed-coincident") (node (ref "R1") (pin "1")) (node (ref "R2") (pin "1")))' : '';
      return `(export (design (source "positions.kicad_sch") (date "2026-09-17T00:00:0${netlistCalls}")) (components ${components}) (nets ${nets}))`;
    },
    captureFreshSchematicStrokeStyle: async () => { glyphCalls++; return await style(project); },
    observeFreshSchematicFieldDiagnostic: async diagnostic => { phases.push(diagnostic.phase); if (options.diagnosticFailure) throw new Error("private diagnostic failure"); return await diagnostics.observe(diagnostic); },
  });
  return { project, session, bridge, root, calls, phases, netlistCalls: () => netlistCalls, glyphCalls: () => glyphCalls };
}

describe("pre-connectivity schematic field positions through owned lifecycle", () => {
  it("supports a partial one-of-three component schematic and preserves electrical export through mandatory save", async () => {
    const current = await fixture(), beforePcb = await readFile(current.project.pcbPath);
    const result = JSON.parse((await current.bridge.execute(call)).content);
    expect(result).toMatchObject({ applied: true, mutated: true, persistence: "native-save-required", nativeNetlistComparison: { equal: true },
      nativeGlyphDiagnostic: { association: "literal-text-candidates-not-field-ownership", fields: [expect.objectContaining({ reference: "R1", candidateCount: 1 })] } });
    expect(await current.bridge.internal.classifyPendingMutationBatch?.()).toBeUndefined();
    expect(current.calls).toEqual([]);
    const saved = await current.bridge.internal.saveAfterMutation(save);
    expect(saved.isError).not.toBe(true); expect(JSON.parse(saved.content).status).toBe("saved-and-native-schematic-field-positions-verified");
    expect(current.calls).toEqual(["pcb_save"]); expect(current.netlistCalls()).toBe(3); expect(current.glyphCalls()).toBe(2);
    expect(await readFile(current.project.pcbPath)).toEqual(beforePcb);
    expect(await readFile(current.project.schematicPath, "utf8")).toBe(planFreshSchematicFieldPositions(partial, request.updates).source);
  });
  it("keeps source no-ops in the same native save/equivalence boundary", async () => {
    const current = await fixture();
    const noOp = { ...call, arguments: { updates: [{ ...request.updates[0]!, y_mm: 175.3235 }] } };
    expect(JSON.parse((await current.bridge.execute(noOp)).content)).toMatchObject({ mutated: false, idempotent: true });
    expect(await current.bridge.internal.classifyPendingMutationBatch?.()).toBeUndefined();
    expect((await current.bridge.internal.saveAfterMutation(save)).isError).not.toBe(true);
    expect(current.calls).toEqual(["pcb_save"]); expect(current.netlistCalls()).toBe(3);
    expect(await readFile(current.project.schematicPath, "utf8")).toBe(partial);
  });
  it.each([2, 3])("restores the whole owned preimage when native partial-state equivalence fails at capture %s", async netlistFaultAt => {
    const current = await fixture({ netlistFaultAt });
    if (netlistFaultAt === 2) await expect(current.bridge.execute(call)).rejects.toThrow(/ROLLED_BACK_TERMINAL/);
    else { await current.bridge.execute(call); expect((await current.bridge.internal.saveAfterMutation(save)).isError).toBe(true); }
    expect(await readFile(current.project.schematicPath, "utf8")).toBe(partial);
    expect(current.phases).toEqual(["primary-failure", "recovery-finished"]);
    await expect(current.bridge.execute(call)).rejects.toThrow(/RECOVERY_REQUIRED/);
  });
  it.each(["sourceFaultAt", "replaceAt"] as const)("preserves unknown bytes or same-bytes replacement identity (%s) instead of rolling over it", async fault => {
    const current = await fixture({ [fault]: 3 }); await current.bridge.execute(call);
    const result = await current.bridge.internal.saveAfterMutation(save);
    expect(result.isError).toBe(true); expect(result.content).toContain("ROLLBACK_FAILED_TERMINAL");
    const planned = planFreshSchematicFieldPositions(partial, request.updates).source;
    expect(await readFile(current.project.schematicPath, "utf8")).toBe(fault === "sourceFaultAt" ? planned + "\nexternal-change\n" : planned);
  });
  it.each([false, true])("keeps the native save cause private and recovers even when diagnostic publication fails=%s", async diagnosticFailure => {
    const current = await fixture({ saveFailure: true, diagnosticFailure }); await current.bridge.execute(call);
    const saved = await current.bridge.internal.saveAfterMutation(save);
    expect(saved.isError).toBe(true); expect(saved.content).not.toContain("private-position-token");
    expect(await readFile(current.project.schematicPath, "utf8")).toBe(partial);
    if (!diagnosticFailure) {
      const filename = (await readdir(current.root)).find(name => name.startsWith("schematic-field-diagnostic-primary-failure"))!;
      expect(await readFile(path.join(current.root, filename), "utf8")).toContain("private-position-token original native save failure");
    }
  });
  it("rejects the entire update list and unqualified write sessions before any source or native save mutation", async () => {
    const current = await fixture();
    await expect(current.bridge.execute({ ...call, arguments: { updates: [request.updates[0]!, { ...request.updates[0]!, reference: "R2" }] } })).rejects.toThrow(/exactly one/);
    expect(current.netlistCalls()).toBe(0); expect(current.calls).toEqual([]);
    current.session.supportsSchematicConnectivityBatch = () => false;
    await expect(current.bridge.execute(call)).rejects.toThrow(/qualified native/);
    expect(await readFile(current.project.schematicPath, "utf8")).toBe(partial);
  });
  it("handles a concurrently queued mandatory save through the dedicated boundary", async () => {
    const current = await fixture();
    const [edited, saved] = await Promise.all([current.bridge.execute(call), current.bridge.internal.saveAfterMutation(save)]);
    expect(edited.isError).not.toBe(true); expect(saved.isError).not.toBe(true);
    expect(current.calls).toEqual(["pcb_save"]); expect(current.netlistCalls()).toBe(3);
  });
  it("rolls back a staged batch when a queued non-save call would bypass its mandatory save", async () => {
    const current = await fixture();
    const results = await Promise.allSettled([current.bridge.execute(call), current.bridge.execute({ id: 'queued-read', name: 'sch_get_symbols', arguments: {} })]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(await readFile(current.project.schematicPath, 'utf8')).toBe(partial);
    expect(current.calls).toEqual([]);
    await expect(current.bridge.execute(call)).rejects.toThrow(/RECOVERY_REQUIRED/);
  });
  it("preserves source drift occurring only after result construction and rejects post-result authority", async () => {
    const current = await fixture(); const parse = harnessToolResultSchema.parse.bind(harnessToolResultSchema);
    const drift = '(kicad_sch (sheet))'; let injected = false;
    vi.spyOn(harnessToolResultSchema, 'parse').mockImplementation((...args) => {
      const result = parse(...args);
      if (!injected && result.content.includes('evleda.fresh-schematic-field-positions-result.v1')) {
        injected = true; writeFileSync(current.project.schematicPath, drift, 'utf8');
      }
      return result;
    });
    await expect(current.bridge.execute(call)).rejects.toThrow(/ROLLBACK_FAILED_TERMINAL/);
    expect(injected).toBe(true); expect(await readFile(current.project.schematicPath, 'utf8')).toBe(drift);
    const primary = (await readdir(current.root)).find(name => name.startsWith('schematic-field-diagnostic-primary-failure'))!;
    expect(JSON.parse(await readFile(path.join(current.root, primary), 'utf8')).firstOperation).toBe('result-authority');
  });
  it("admits 139.7/177.8 through actual public MCP schema validation and performs automatic save/graph readback", async () => {
    const current = await fixture();
    const toolbox = createKicadToolboxMcpServer({ access: "edit", cad: { tools: current.bridge, assertCurrent: async () => undefined,
      captureSources: async () => contentIdentity(await readFile(current.project.schematicPath)).digest, close: async () => undefined } });
    const client = new Client({ name: "field-position-test", version: "1" }); const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await toolbox.server.connect(b); await client.connect(a);
      const result = await client.callTool({ name: call.name, arguments: request });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(current.calls).toEqual(["pcb_save", "sch_get_connectivity_graph"]);
      expect(current.netlistCalls()).toBe(3);
    } finally { await client.close(); await toolbox.close(); }
  });
});

describe("owned schematic replacement guards", () => {
  it("stages atomically, restores exactly and rejects foreign checkpoints", async () => {
    const current = await fixture(), owner = new FreshSchematicRollback(current.project), baseline = await owner.capture(partial);
    const planned = planFreshSchematicFieldPositions(partial, request.updates).source;
    await owner.stageOwnedSource(baseline, planned); await owner.assertOwnedSource(baseline, planned); await owner.restoreOwnedSource(baseline);
    expect(await readFile(current.project.schematicPath, "utf8")).toBe(partial);
    await expect(owner.stageOwnedSource({ ...baseline }, planned)).rejects.toThrow(/owned preimage/);
    expect((await readdir(current.project.projectPath)).filter(name => name.endsWith('.evleda-position.tmp'))).toEqual([]);
  });
  it("refuses a newly shared schematic before replacement without touching either hardlink", async () => {
    const current = await fixture(), owner = new FreshSchematicRollback(current.project), baseline = await owner.capture(partial);
    const alias = path.join(current.project.projectPath, 'shared.tmp'); await link(current.project.schematicPath, alias);
    await expect(owner.stageOwnedSource(baseline, planFreshSchematicFieldPositions(partial, request.updates).source)).rejects.toThrow(/unlinked/);
    expect(await readFile(alias, 'utf8')).toBe(partial);
    expect(await readFile(current.project.schematicPath, 'utf8')).toBe(partial);
  });
});

describe('unwired symbol poses through the shared owned-source lifecycle', () => {
  const unwired = () => {
    const spans = parseFreshSchematicSourceDocument(partial).children.filter(node => ['wire', 'label', 'no_connect'].includes(node.name)).sort((a, b) => b.start - a.start);
    let text = partial; for (const span of spans) text = text.slice(0, span.start) + text.slice(span.end);
    return text.replace('(kicad_sch', '(kicad_sch (uuid "11111111-1111-4111-8111-111111111111")');
  };
  const poseCall = { id: 'pose', name: FRESH_SCHEMATIC_SYMBOL_POSE_TOOL, arguments: { updates: [{ reference: 'R1', x_mm: 60, y_mm: 70, rotation: 180 }] } };
  const withSecond = () => {
    const text = unwired(), node = parseFreshSchematicSourceDocument(text).children.find(node => node.name === 'symbol')!;
    const copy = text.slice(node.start, node.end).replaceAll('"R1"', '"R2"').replace('f13fedce-2b15-420f-a394-d17f7d696a71', '33333333-3333-4333-8333-333333333333');
    return text.slice(0, text.lastIndexOf(')')) + copy + ')';
  };
  it('moves and rotates a partial instance while preserving field tokens and requiring one native save', async () => {
    const before = unwired(), current = await fixture({ source: before });
    const expected = planFreshSchematicSymbolPoses(before, [{ reference: 'R1', x_mm: 60, y_mm: 70, rotation: 180 }]);
    const result = JSON.parse((await current.bridge.execute(poseCall)).content);
    expect(result).toMatchObject({ schemaVersion: 'evleda.fresh-schematic-symbol-poses-result.v1', applied: true, mutated: true,
      poses: [{ reference: 'R1', after: { x: 60, y: 70, rotation: 180 } }], nativeNetlistComparison: { equal: true } });
    expect(await readFile(current.project.schematicPath, 'utf8')).toBe(expected.source);
    expect(current.calls).toEqual([]);
    const saved = await current.bridge.internal.saveAfterMutation(save);
    expect(saved.isError).not.toBe(true); expect(JSON.parse(saved.content).status).toBe('saved-and-native-schematic-symbol-poses-verified');
    expect(current.calls).toEqual(['pcb_save']); expect(current.netlistCalls()).toBe(3);
    const repeat = await current.bridge.execute(poseCall);
    expect(JSON.parse(repeat.content)).toMatchObject({ mutated: false, idempotent: true });
    expect(await current.bridge.internal.classifyPendingMutationBatch?.()).toBeUndefined();
    expect((await current.bridge.internal.saveAfterMutation({ ...save, id: 'pose-repeat-save' })).isError).not.toBe(true);
  });
  it.each([false, true])('rolls back new/broken implicit coincident-pin connectivity (initially joined=%s)', async initiallyJoined => {
    const before = withSecond(), current = await fixture({ source: before, membershipFaultAt: 2, initiallyJoined });
    await expect(current.bridge.execute(poseCall)).rejects.toThrow(/SCHEMATIC_SYMBOL_POSE_ROLLED_BACK_TERMINAL/);
    expect(await readFile(current.project.schematicPath, 'utf8')).toBe(before);
    expect(current.calls).toEqual([]);
    await expect(current.bridge.execute(poseCall)).rejects.toThrow(/RECOVERY_REQUIRED/);
  });
  it('rejects source connections before native capture or mutation', async () => {
    const current = await fixture();
    await expect(current.bridge.execute(poseCall)).rejects.toThrow(/not admitted/);
    expect(current.netlistCalls()).toBe(0); expect(current.calls).toEqual([]);
    expect(await readFile(current.project.schematicPath, 'utf8')).toBe(partial);
  });
  it('refuses an undeclared unselected placed reference', async () => {
    const before = withSecond().replaceAll('"R2"', '"EXTRA1"'), current = await fixture({ source: before });
    await expect(current.bridge.execute(poseCall)).rejects.toThrow(/entire placed inventory/);
    expect(current.netlistCalls()).toBe(0); expect(await readFile(current.project.schematicPath, 'utf8')).toBe(before);
  });
  it('preserves unknown source after saved pose verification instead of rolling over it', async () => {
    const before = unwired(), current = await fixture({ source: before, replaceAt: 3 });
    await current.bridge.execute(poseCall);
    const saved = await current.bridge.internal.saveAfterMutation(save);
    expect(saved.isError).toBe(true); expect(saved.content).toContain('SCHEMATIC_SYMBOL_POSE_ROLLBACK_FAILED_TERMINAL');
    expect(await readFile(current.project.schematicPath, 'utf8')).toBe(planFreshSchematicSymbolPoses(before, [{ reference: 'R1', x_mm: 60, y_mm: 70, rotation: 180 }]).source);
  });
  it('handles queued mandatory save and denies a subsequent unsaved call', async () => {
    const before = unwired(), current = await fixture({ source: before });
    const pair = await Promise.all([current.bridge.execute(poseCall), current.bridge.internal.saveAfterMutation(save)]);
    expect(pair.every(result => result.isError !== true)).toBe(true); expect(current.calls).toEqual(['pcb_save']);
    const another = await fixture({ source: before });
    const denied = await Promise.allSettled([another.bridge.execute(poseCall), another.bridge.execute({ id: 'later-read', name: 'sch_get_symbols', arguments: {} })]);
    expect(denied.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(await readFile(another.project.schematicPath, 'utf8')).toBe(before);
  });
  it('exposes the closed pose schema through public MCP with automatic save and schematic readback', async () => {
    const current = await fixture({ source: unwired() });
    const toolbox = createKicadToolboxMcpServer({ access: 'edit', cad: { tools: current.bridge, assertCurrent: async () => undefined,
      captureSources: async () => contentIdentity(await readFile(current.project.schematicPath)).digest, close: async () => undefined } });
    const client = new Client({ name: 'symbol-pose-test', version: '1' }), [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await toolbox.server.connect(b); await client.connect(a);
      const result = await client.callTool({ name: poseCall.name, arguments: { updates: [{ reference: 'R1', x_mm: 242.57, y_mm: 64.77, rotation: 180 }] } });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(current.calls).toEqual(['pcb_save', 'sch_get_connectivity_graph']);
    } finally { await client.close(); await toolbox.close(); }
  });
});
