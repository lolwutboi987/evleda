import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareFreshProject } from "../../src/harness/fresh-project.js";
import { createKicadHarnessTools, kicadHarnessToolEffect } from "../../src/harness/kicad-tools.js";
import { assertOnlyRequestedPcbTextAdded, parsePcbSilkscreenText } from "../../src/harness/pcb-silkscreen-text.js";
import { contentIdentity } from "../../src/core/canonical.js";
import { createGenericDividerBundleFixture } from "../helpers/generic-divider-bundle.js";
import { parseFreshPcbTextItems } from "../../src/harness/fresh-kicad-parser.js";
import capturedText from "../fixtures/fresh-project/native-board-text-line-spacing.json" with { type: "json" };

const id = "6df340ba-c23c-40e3-a9e4-915911684dcf";
const requested = parsePcbSilkscreenText({ text: "VIN", x_mm: 4, y_mm: 5 });
const textNode = `(gr_text "VIN" (at 4 5 0) (layer "F.SilkS") (uuid "${id}") (effects (font (size 1 1) (thickness 0.15)) (justify left bottom)))`;
const insert = (source: string, node = textNode): string => { const position = source.lastIndexOf(")"); return source.slice(0, position) + node + "\n" + source.slice(position); };
const baseline = '(kicad_pcb (version 20260206) (generator "pcbnew") (gr_rect (start 0 0) (end 30 20) (layer "Edge.Cuts")) (segment (start 1 1) (end 2 2) (width 0.5) (layer "F.Cu") (net 1)) (footprint "Device:R" (layer "F.Cu") (at 2 3) (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "VIN"))) (gr_text "OLD" (at 1 2) (layer "F.SilkS") (uuid "00000000-0000-4000-8000-000000000002") (effects (font (size 1 1)) (justify left bottom))))\n';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("bounded PCB silkscreen text", () => {
  it("accepts the captured native single-line spacing without changing other source", () => {
    const expected = parsePcbSilkscreenText(capturedText.request);
    const after = insert(baseline, capturedText.nativeTextSource);
    const item = parseFreshPcbTextItems(after).find(item => item.text === "VIN")!;
    expect(item.supported).toBe(true);
    expect(item.presentation).toMatchObject({ at: { x: 5, y: 6.1 }, rotationDeg: 0,
      fontSizeMm: { x: 0.8, y: 0.8 }, justify: ["left", "bottom"], bold: false, italic: false, hidden: false });
    expect(() => assertOnlyRequestedPcbTextAdded(baseline, after, expected)).not.toThrow();
  });
  it.each(['(line_spacing 1)', '(line_spacing 0.0)', '(line_spacing "0")', '(line_spacing 0 0)',
    '(line_spacing 0 (extra 0))', '(line_spacing 0) (line_spacing 0)'])("rejects uncaptured native font metadata %s", replacement => {
    const after = insert(baseline, capturedText.nativeTextSource.replace('(line_spacing 0)', replacement));
    expect(parseFreshPcbTextItems(after).find(item => item.text === "VIN")!.supported).toBe(false);
    expect(() => assertOnlyRequestedPcbTextAdded(baseline, after, parsePcbSilkscreenText(capturedText.request))).toThrow();
  });
  it("does not admit multiline text through the captured line-spacing exception", () => {
    const after = insert(baseline, capturedText.nativeTextSource.replace('"VIN"', '"VIN\\nVOUT"'));
    expect(parseFreshPcbTextItems(after).find(item => item.text.includes("\n"))!.supported).toBe(false);
  });
  it("fills only reviewed native defaults and classifies text as mutation", () => {
    expect(requested).toEqual({ text: "VIN", x_mm: 4, y_mm: 5, layer: "F_SilkS", size_mm: 1, rotation_deg: 0, bold: false, italic: false });
    expect(kicadHarnessToolEffect("pcb_add_text")).toBe("mutation");
  });
  it.each([{ layer: "F_Cu" }, { rotation_deg: 90 }, { size_mm: 0 }, { size_mm: 0.79 }, { size_mm: 20 }, { x_mm: -1 }, { text: "${REFERENCE}" }, { text: "a\nb" }, { object_id: id }])("rejects unsupported presentation %j", change => {
    expect(() => parsePcbSilkscreenText({ text: "VIN", x_mm: 4, y_mm: 5, ...change })).toThrow();
  });
  it("accepts exactly one requested text while preserving all other source", () => {
    expect(() => assertOnlyRequestedPcbTextAdded(baseline, insert(baseline), requested)).not.toThrow();
  });
  it.each(['(thickness 0.079)', '(thickness "0.15")', '(thickness 0x1)', '(thickness 0.15) (thickness 0.2)'])("rejects unverified or below-minimum native text stroke %s", replacement => {
    expect(() => assertOnlyRequestedPcbTextAdded(baseline, insert(baseline, textNode.replace('(thickness 0.15)', replacement)), requested)).toThrow(/thickness/);
  });
  it.each([
    (source: string) => source.replace('(width 0.5)', '(width 0.25)'),
    (source: string) => source.replace('(end 30 20)', '(end 31 20)'),
    (source: string) => source.replace('(at 2 3)', '(at 2 4)'),
    (source: string) => source.replace('(pad "1"', '(pad "2"'),
    (source: string) => source.replace('"OLD"', '"changed"'),
    (source: string) => source.replace('(at 4 5 0)', '(at 4 5 90)'),
    (source: string) => source.replace('(size 1 1)', '(size 2 2)'),
    (source: string) => source.replace('"VIN"', '"VOUT"'),
    (source: string) => insert(source, textNode.replace(id, "00000000-0000-4000-8000-000000000001")),
  ])("rejects collateral changes or an inaccurate/new extra label", mutate => {
    expect(() => assertOnlyRequestedPcbTextAdded(baseline, mutate(insert(baseline)), requested)).toThrow();
  });
  it("does not advertise text for copied or unbound sessions", () => {
    const session = { listTools: () => [{ name: "pcb_add_text", permission: "write" as const, inputSchema: {} }], callTool: vi.fn() };
    expect(createKicadHarnessTools(session).tools.some(tool => tool.name === "pcb_add_text")).toBe(false);
  });
  it("rejects native success without a created item and retains the causal diagnosis", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "evleda-text-noop-test-")); roots.push(outputDir);
    const { bundle, reference } = createGenericDividerBundleFixture();
    const freshProject = await prepareFreshProject({ outputDir, name: "text-proof", resume: false, workflowKind: "generic", compilationBundle: bundle, compilationBundleRef: reference });
    const before = await readFile(freshProject.pcbPath, "utf8");
    const callTool = vi.fn(async () => ({ content: [{ type: "text" as const, text: "Board text added successfully." }] }));
    const session = { listTools: () => ["pcb_add_text", "pcb_save", "pcb_revert"].map(name => ({ name, permission: "write" as const, inputSchema: { type: "object" } })),
      callTool, assertActivePcb: async () => undefined, readActivePcbSource: async () => before };
    const fingerprint = async () => contentIdentity(await readFile(freshProject.pcbPath)).digest;
    const tools = createKicadHarnessTools(session, { freshProject, freshCompilationBundle: bundle, freshConnectivityContract: bundle.contract,
      capturePersistedMutationBaseline: fingerprint, verifyPersistedMutation: async baseline => baseline !== await fingerprint() });
    await expect(tools.execute({ id: "text", name: "pcb_add_text", arguments: { text: "VIN", x_mm: 4, y_mm: 5 } }))
      .rejects.toThrow(/FRESH_BOARD_COMPOUND_ROLLED_BACK_TERMINAL:.*did not add exactly one identified text item/u);
    expect(await readFile(freshProject.pcbPath, "utf8")).toBe(before);
  });
  it.each([false, true])("requires exact mandatory save/readback (tamper=%s)", async tamper => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "evleda-text-test-")); roots.push(outputDir);
    const { bundle, reference } = createGenericDividerBundleFixture();
    const freshProject = await prepareFreshProject({ outputDir, name: "text-proof", resume: false, workflowKind: "generic", compilationBundle: bundle, compilationBundleRef: reference });
    const before = await readFile(freshProject.pcbPath, "utf8"); let live = before;
    const callTool = vi.fn().mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === "pcb_add_text") { expect(args).toEqual(requested); live = insert(live); }
      if (name === "pcb_save") await writeFile(freshProject.pcbPath, tamper ? live.replace('"VIN"', '"BAD"') : live);
      if (name === "pcb_revert") live = await readFile(freshProject.pcbPath, "utf8");
      return { content: [{ type: "text", text: "ok" }] };
    });
    const session = { listTools: () => ["pcb_add_text", "pcb_save", "pcb_revert"].map(name => ({ name, permission: "write" as const, inputSchema: { type: "object" } })),
      callTool, assertActivePcb: async () => undefined, readActivePcbSource: async () => live };
    const fingerprint = async () => contentIdentity(await readFile(freshProject.pcbPath)).digest;
    const tools = createKicadHarnessTools(session, { freshProject, freshCompilationBundle: bundle, freshConnectivityContract: bundle.contract, capturePersistedMutationBaseline: fingerprint,
      verifyPersistedMutation: async baseline => baseline !== await fingerprint() });
    expect(tools.tools.find(tool => tool.name === "pcb_add_text")?.inputSchema).toMatchObject({ additionalProperties: false });
    await tools.execute({ id: "text", name: "pcb_add_text", arguments: { text: "VIN", x_mm: 4, y_mm: 5 } });
    expect(await readFile(freshProject.pcbPath, "utf8")).toBe(before);
    const saved = await tools.internal.saveAfterMutation({ id: "save", name: "pcb_save", arguments: {} });
    if (tamper) { expect(saved.isError).toBe(true); expect(await readFile(freshProject.pcbPath, "utf8")).toBe(before); }
    else { expect(saved.isError).not.toBe(true); assertOnlyRequestedPcbTextAdded(before, await readFile(freshProject.pcbPath, "utf8"), requested); }
  });
});
