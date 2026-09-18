import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { exactFreshSchematicGeometryMatches, expectedFreshSchematicGeometryPrefixes, type FreshSchematicWriterGeometry } from "../../src/harness/fresh-schematic-writer-geometry.js";
import { parseFreshSchematicSource, type FreshSchematicWire } from "../../src/harness/fresh-kicad-parser.js";
import { createKicadHarnessTools, type KicadHarnessSession } from "../../src/harness/kicad-tools.js";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { createFreshConnectivityContract } from "../../src/harness/fresh-connectivity-contract.js";
import { runPcbAgentHarness } from "../../src/harness/pcb-agent-harness.js";
import type { HarnessProviderTurn, HarnessToolPort, HarnessToolResult } from "../../src/harness/contracts.js";
import { prepareFreshProject } from "../../src/harness/fresh-project.js";
import { FreshSchematicRollback } from "../../src/harness/fresh-schematic-rollback.js";
import { FRESH_SCHEMATIC_FIELD_DIAGNOSTIC_TIMEOUT_MS, type FreshSchematicFieldDiagnosticObserver } from "../../src/harness/fresh-schematic-field-diagnostics.js";
import { createToolboxSchematicFieldDiagnostics } from "../../src/mcp/toolbox-schematic-field-diagnostics.js";
import { createSchematicFailureSession, schematicFailureReply } from "../helpers/schematic-failure-session.js";
import { createGenericDividerBundleFixture } from "../helpers/generic-divider-bundle.js";
import { normalizeFakeSchematicWriterSource, replaceFakeSchematicGeometry } from "../helpers/normalizing-schematic-writer.js";

type Segment = readonly [number, number, number, number];
type OraclePrefix = { readonly prefix: number; readonly requestedWire?: Segment; readonly wires: readonly Segment[]; readonly junctions: readonly (readonly [number, number])[] };
const oracle = JSON.parse(await readFile(new URL("../fixtures/fresh-project/attempt10-writer-normalization.json", import.meta.url), "utf8")) as {
  readonly inputPlan: {
    readonly wires: readonly { readonly x: number; readonly y: number; readonly endX: number; readonly endY: number }[];
    readonly pins: readonly (readonly [string, { readonly x: number; readonly y: number }])[];
    readonly boxes: readonly { readonly reference: string; readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number }[];
  };
  readonly prefixes: readonly OraclePrefix[];
  readonly roundingCases: readonly { readonly input: number; readonly serializedCoordinate: number }[];
  readonly additionalPrefixOracles: Readonly<Record<string, readonly OraclePrefix[]>>;
};
// Captured schematic/oracle fixtures preserve content with LF line endings;
// sourceHashes in the oracle identify the original evidence artifact bytes.
const baseline = await readFile(new URL("../fixtures/fresh-project/attempt10-post-placement.kicad_sch", import.meta.url), "utf8");
const fromSegment = ([x, y, endX, endY]: Segment): FreshSchematicWire => ({ start: { x, y }, end: { x: endX, y: endY } });
const fromOracle = (prefix: OraclePrefix): FreshSchematicWriterGeometry => ({
  wires: prefix.wires.map(fromSegment), junctions: prefix.junctions.map(([x, y]) => ({ x, y })),
});
const requestedWires = oracle.inputPlan.wires.map(({ x, y, endX, endY }) => fromSegment([x, y, endX, endY]));
// Current planner expectations are separate from the historical Python oracle.
// Clearance-adjusted escapes and outer lanes lie on the 50 mil connection grid.
const onGridPlan = JSON.parse(await readFile(new URL("../fixtures/fresh-project/native-frame-label-reserved-plan.json", import.meta.url), "utf8")) as {
  readonly connectionGridMm: number; readonly wires: readonly Segment[];
};
const onGridRequestedWires = onGridPlan.wires.map(fromSegment);
const onGridPrefixes = expectedFreshSchematicGeometryPrefixes(onGridRequestedWires);
// R2's off-grid bound still rounds outward; the reserved label terminal is
// already farther left than either historical outer channel.
const offGridBoundsRequestedWires = onGridRequestedWires;
const independentRecords = ({ wires, junctions }: FreshSchematicWriterGeometry) => ({
  wires: wires.map(({ start, end }) => [JSON.stringify([start.x, start.y]), JSON.stringify([end.x, end.y])].sort().join("|")).sort(),
  junctions: junctions.map(({ x, y }) => JSON.stringify([x, y])).sort(),
});
const addForm = (source: string, form: string): string => {
  const close = source.lastIndexOf(")");
  return normalizeFakeSchematicWriterSource(`${source.slice(0, close)}\n${form}\n${source.slice(close)}`);
};

describe("pinned schematic writer geometry", () => {
  it("matches the actual pinned Python oracle at every prefix of the reconstructed attempt10 plan", () => {
    const prefixes = expectedFreshSchematicGeometryPrefixes(requestedWires);
    expect(prefixes).toEqual(oracle.prefixes.map(fromOracle));
    expect(prefixes.map((prefix) => prefix.wires.length)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 10, 11, 12, 12, 13, 14, 14]);
    expect(prefixes[10]!.wires).toContainEqual(fromSegment([39.35, 50.8, 45.72, 50.8]));
    expect(prefixes[14]!.junctions).toEqual([]);
    expect(prefixes[15]!.junctions).toEqual([{ x: 76.2, y: 58.44 }]);
  });

  it.each(oracle.roundingCases)("matches Python's exact binary rounding for $input", ({ input, serializedCoordinate }) => {
    const result = expectedFreshSchematicGeometryPrefixes([fromSegment([0, input, 2, input])]).at(-1)!;
    expect(result.wires).toEqual([fromSegment([0, serializedCoordinate, 2, serializedCoordinate])]);
  });

  it.each(Object.entries(oracle.additionalPrefixOracles))("matches the pinned %s prefix oracle", (_name, prefixes) => {
    expect(expectedFreshSchematicGeometryPrefixes(prefixes.slice(1).map((prefix) => fromSegment(prefix.requestedWire!))))
      .toEqual(prefixes.map(fromOracle));
  });

  it("makes the independent fake normalize persisted wires and accumulate junctions on every operation", () => {
    let source = baseline;
    expect(independentRecords(parseFreshSchematicSource(source))).toEqual(independentRecords(fromOracle(oracle.prefixes[0]!)));
    for (const [index, wire] of requestedWires.entries()) {
      source = addForm(source, `(wire (pts (xy ${wire.start.x} ${wire.start.y}) (xy ${wire.end.x} ${wire.end.y})))`);
      expect(independentRecords(parseFreshSchematicSource(source))).toEqual(independentRecords(fromOracle(oracle.prefixes[index + 1]!)));
    }
    expect(independentRecords(parseFreshSchematicSource(addForm(source, '(label "VOUT" (at 45.72 50.8 0))'))))
      .toEqual(independentRecords(fromOracle(oracle.prefixes.at(-1)!)));
  });

  it("accepts record order and reversed direction without relaxing actual coordinates", () => {
    const expected = fromOracle(oracle.prefixes.at(-1)!);
    const reversed = { wires: [...expected.wires].reverse().map(({ start, end }) => ({ start: end, end: start })), junctions: [...expected.junctions].reverse() };
    expect(exactFreshSchematicGeometryMatches(reversed, expected)).toBe(true);
    const changed = { ...reversed, wires: reversed.wires.map((wire, index) => ({
      ...wire, start: { ...wire.start, x: wire.start.x + (index === 0 ? 1e-8 : 0) },
    })) };
    expect(exactFreshSchematicGeometryMatches(changed, expected)).toBe(false);
  });
});

const corruptions = ["changed-endpoint", "extra-wire", "duplicate-wire", "missing-wire", "split-wire", "missing-junction", "extra-junction", "wrong-junction", "duplicate-junction"] as const;
type Corruption = typeof corruptions[number];
function corruptGeometry(geometry: FreshSchematicWriterGeometry, corruption: Corruption): FreshSchematicWriterGeometry {
  const wires = geometry.wires.map((wire) => ({ start: { ...wire.start }, end: { ...wire.end } }));
  const junctions = geometry.junctions.map((point) => ({ ...point }));
  if (corruption === "changed-endpoint") wires[0]!.end.x += 0.00001;
  if (corruption === "extra-wire") wires.push(fromSegment([180, 180, 190, 180]));
  if (corruption === "duplicate-wire") wires.push({ start: { ...wires[0]!.end }, end: { ...wires[0]!.start } });
  if (corruption === "missing-wire") wires.pop();
  if (corruption === "split-wire") {
    const index = wires.findIndex(({ start, end }) => start.y === end.y && start.x !== end.x);
    const { start, end } = wires[index]!;
    const middle = { x: (start.x + end.x) / 2, y: start.y };
    wires.splice(index, 1, { start, end: middle }, { start: middle, end });
  }
  if (corruption === "missing-junction") junctions.pop();
  if (corruption === "extra-junction") junctions.push({ x: 40.62, y: 53.34 });
  if (corruption === "wrong-junction") junctions[0]!.y += 0.00001;
  if (corruption === "duplicate-junction") junctions.push({ ...junctions[0]! });
  return { wires, junctions };
}

describe("exact actual-record comparison", () => {
  it.each(corruptions)("rejects %s instead of repairing actual readback", (corruption) => {
    const expected = fromOracle(oracle.prefixes.at(-1)!);
    const actual = parseFreshSchematicSource(replaceFakeSchematicGeometry(baseline, corruptGeometry(expected, corruption)));
    expect(exactFreshSchematicGeometryMatches(actual, expected)).toBe(false);
  });
});

const owned = new Set<string>();
afterEach(async () => { for (const directory of owned) { await rm(directory, { recursive: true, force: true }); owned.delete(directory); } });

async function capturedPlanBridge(fault?: { readonly corruption: Corruption; readonly when: "prefix" | "final" }, offGridBounds = false, labelFault?: (source: string) => string) {
  const root = await mkdtemp(path.join(tmpdir(), "evleda-writer-regression-")); owned.add(root);
  const fixture = createGenericDividerBundleFixture();
  const fresh = await prepareFreshProject({ outputDir: root, name: "writer-regression", resume: false, workflowKind: "generic", compilationBundle: fixture.bundle, compilationBundleRef: fixture.reference });
  await writeFile(fresh.schematicPath, baseline);
  const contract = fixture.bundle.contract;
  const centers: Readonly<Record<string, readonly [number, number]>> = { J1: [50.8, 50.8], R1: [76.2, 50.8], R2: [50.8, 152.4] };
  const symbols = contract.components.map((component) => `- ${component.reference} ${component.value} ${component.symbolLibId} @ (${centers[component.reference]![0]}, ${centers[component.reference]![1]}) rot=0 unit=1 footprint=${component.footprintLibId}`).join("\n");
  const boxes = `Schematic bounding boxes (3 symbols):\nRef Value X Y X_min Y_min X_max Y_max\n--------------------\n${oracle.inputPlan.boxes.map((box) => `${box.reference} value ${centers[box.reference]![0]} ${centers[box.reference]![1]} ${box.minX} ${box.minY} ${box.maxX} ${offGridBounds && box.reference === "R2" ? 160.03 : box.maxY}`).join("\n")}\n\nSheet occupied region: X=[40.64, 86.36] Y=[43.18, ${offGridBounds ? 160.03 : 160.02}] mm`;
  const expectedPrefixes = offGridBounds ? expectedFreshSchematicGeometryPrefixes(offGridBoundsRequestedWires) : onGridPrefixes;
  const pristine = oracle.inputPlan.pins.map(([endpoint], index) => `Group ${index + 1}: ~unnamed | pins=${endpoint}`).join("\n");
  const exact = contract.nets.map((net, index) => `Group ${index + 1}: ${net.name} | pins=${net.endpoints.map((endpoint) => `${endpoint.reference}:${endpoint.pin}`).join(", ")}`).join("\n");
  const nativeNetlist = `(export (components ${contract.components.map((component) => {
    const [library, part] = component.symbolLibId.split(":");
    return `(comp (ref "${component.reference}") (value "${component.value}") (footprint "${component.footprintLibId}") (libsource (lib "${library}") (part "${part}")))`;
  }).join(" ")}) (nets ${contract.nets.map((net, index) => `(net (code "${index + 1}") (name "${net.name}") ${net.endpoints.map((endpoint) => `(node (ref "${endpoint.reference}") (pin "${endpoint.pin}") (pintype "passive"))`).join(" ")})`).join(" ")}))`;
  const calls: string[] = [];
  const labelRequests: Readonly<Record<string, unknown>>[] = [];
  const requests: FreshSchematicWire[] = [];
  let applied = false;
  const sidecar: KicadHarnessSession = {
    supportsQualifiedFootprintIdentitySync: () => true,
    supportsQualifiedFootprintPoseSync: () => true,
    assertActivePcb: async (expected) => { expect(expected).toBe(fresh.pcbPath); },
    readActivePcbSource: async (expected) => { expect(expected).toBe(fresh.pcbPath); return await readFile(fresh.pcbPath, "utf8"); },
    listTools: () => ["sch_get_symbols", "sch_modify_property", "sch_get_bounding_boxes", "sch_get_pin_positions", "sch_get_connectivity_graph", "sch_add_wire", "sch_add_labels", "sch_add_no_connect", "sch_add_missing_junctions", "run_erc", "pcb_save"].map((name) => ({ name, permission: "write", inputSchema: { type: "object" } })),
    callTool: async (name, args = {}) => {
      calls.push(name);
      let result = "ok";
      if (name === "sch_get_symbols") result = symbols;
      if (name === "sch_get_bounding_boxes") result = boxes;
      if (name === "sch_get_pin_positions") {
        const reference = args.symbol_name === "Conn_01x03" ? "J1" : args.y_mm === 152.4 ? "R2" : "R1";
        result = oracle.inputPlan.pins.filter(([id]) => id.startsWith(`${reference}:`)).map(([id, point]) => `- Pin ${id.split(":")[1]}: (${point.x}, ${point.y}) mm`).join("\n");
      }
      if (name === "sch_get_connectivity_graph") result = applied ? exact : pristine;
      if (["sch_add_wire", "sch_add_labels", "sch_add_no_connect", "sch_add_missing_junctions"].includes(name)) {
        let source = await readFile(fresh.schematicPath, "utf8");
        if (name === "sch_add_wire") {
          requests.push(fromSegment([Number(args.x1_mm), Number(args.y1_mm), Number(args.x2_mm), Number(args.y2_mm)]));
          source = addForm(source, `(wire (pts (xy ${args.x1_mm} ${args.y1_mm}) (xy ${args.x2_mm} ${args.y2_mm})))`);
        } else if (name === "sch_add_labels") {
          for (const label of args.labels as Readonly<Record<string, unknown>>[]) {
            labelRequests.push(label);
            source = addForm(source, `(global_label "${label.name}" (shape ${label.shape}) (at ${label.x_mm} ${label.y_mm} ${label.rotation}) (effects (font (size 1.524 1.524)) (justify ${label.justify})))`);
          }
          source = labelFault?.(source) ?? source;
        }
        else source = normalizeFakeSchematicWriterSource(source);
        expect(independentRecords(parseFreshSchematicSource(source))).toEqual(independentRecords(expectedPrefixes[requests.length]!));
        const faultPrefix = fault?.corruption.includes("junction") ? 15 : 10;
        if (fault !== undefined && ((fault.when === "prefix" && name === "sch_add_wire" && requests.length === faultPrefix)
          || (fault.when === "final" && name === "sch_add_missing_junctions"))) {
          source = replaceFakeSchematicGeometry(source, corruptGeometry(parseFreshSchematicSource(source), fault.corruption));
        }
        await writeFile(fresh.schematicPath, source);
        if (name === "sch_add_missing_junctions") applied = true;
      }
      if (name === "run_erc") return { content: [], structuredContent: { status: "clean", findings: [], metadata: { violation_count: 0 } } };
      return { content: [], structuredContent: { result } };
    },
  };
  const bridge = createKicadHarnessTools(sidecar, { freshProject: fresh, freshConnectivityContract: contract, freshCompilationBundle: fixture.bundle, verifyPersistedMutation: async () => true, captureFreshNativeNetlist: async () => nativeNetlist });
  return { bridge, fresh, calls, requests, labelRequests, sidecar, fixture, nativeNetlist };
}

describe("grid-aligned planning on captured attempt10 placement", () => {
  it("aligns raw off-grid bounding-box extrema before constructing outer route channels", async () => {
    const { bridge, requests } = await capturedPlanBridge(undefined, true);
    const applied = await bridge.execute({ id: "off-grid-bounds", name: "fresh_apply_contract_connectivity", arguments: {} });
    expect(JSON.parse(applied.content)).toMatchObject({ applied: true, mutated: true, issues: [] });
    expect(requests).toEqual(offGridBoundsRequestedWires);
    expect(requests).toContainEqual(fromSegment([31.75, 50.8, 31.75, 40.64]));
  });

  it("applies the label-port leads and tree with every required T junction, ERC and native parity", async () => {
    expect(onGridPlan.connectionGridMm).toBe(1.27);
    const { bridge, fresh, requests, calls } = await capturedPlanBridge();
    const applied = await bridge.execute({ id: "captured-plan", name: "fresh_apply_contract_connectivity", arguments: {} });
    expect(JSON.parse(applied.content)).toMatchObject({ applied: true, mutated: true, issues: [] });
    expect(requests).toEqual(onGridRequestedWires);
    for (const wire of requests) for (const point of [wire.start, wire.end]) {
      expect(Math.round(point.x * 100) % 127).toBe(0);
      expect(Math.round(point.y * 100) % 127).toBe(0);
    }
    for (const [, point] of oracle.inputPlan.pins) expect(requests.some((wire) =>
      [wire.start, wire.end].some((endpoint) => endpoint.x === point.x && endpoint.y === point.y))).toBe(true);
    expect(independentRecords(parseFreshSchematicSource(await readFile(fresh.schematicPath, "utf8"))))
      .toEqual(independentRecords(onGridPrefixes.at(-1)!));
    expect(onGridPrefixes.at(-1)!.junctions).toEqual([{ x: 31.75, y: 50.8 }, { x: 39.37, y: 48.26 }, { x: 39.37, y: 53.34 }, { x: 76.2, y: 59.69 }]);
    expect(calls.filter((name) => name === "run_erc")).toHaveLength(1);
    await expect(bridge.internal.saveAfterMutation({ id: "save", name: "pcb_save", arguments: {} }))
      .resolves.toMatchObject({ content: expect.stringContaining("saved-and-native-connectivity-verified") });
  });

  it.each(corruptions)("restores exact bytes and fails terminally when a prefix contains %s", async (corruption) => {
    const { bridge, fresh, requests, calls } = await capturedPlanBridge({ corruption, when: "prefix" });
    await expect(bridge.execute({ id: corruption, name: "fresh_apply_contract_connectivity", arguments: {} }))
      .rejects.toThrow(/FRESH_CONNECTIVITY_ROLLED_BACK_TERMINAL.*wire or junction geometry diverged.*session must close without retry/iu);
    expect(requests).toHaveLength(corruption.includes("junction") ? 15 : 10);
    expect(calls.filter((name) => name === "sch_get_connectivity_graph")).toHaveLength(1);
    expect(calls).not.toContain("run_erc");
    expect(await readFile(fresh.schematicPath, "utf8")).toBe(baseline);
  });

  it.each(["changed-endpoint", "missing-junction", "extra-junction", "wrong-junction", "duplicate-junction"] as const)("checks final persisted geometry and rolls back %s introduced by a later write", async (corruption) => {
    const { bridge, fresh, requests } = await capturedPlanBridge({ corruption, when: "final" });
    await expect(bridge.execute({ id: corruption, name: "fresh_apply_contract_connectivity", arguments: {} }))
      .rejects.toThrow(/FRESH_CONNECTIVITY_ROLLED_BACK_TERMINAL.*expected wires and junctions/iu);
    expect(requests).toHaveLength(20);
    expect(await readFile(fresh.schematicPath, "utf8")).toBe(baseline);
  });
});

const relocateR1Value = (source: string): string => source.replace('(at 76.2 54.61 0)', '(at 80.01 52.07 0)');

async function fieldRepairBridge(
  edit: (source: string) => string = relocateR1Value,
  summary = "Auto-placed Reference/Value fields on 1 symbol(s): R1.",
  nativeFailure = false,
  thirdCaptureEdit?: (source: string) => string,
  observeFreshSchematicFieldDiagnostic?: FreshSchematicFieldDiagnosticObserver,
) {
  const current = await capturedPlanBridge();
  await current.bridge.execute({ id: "connect", name: "fresh_apply_contract_connectivity", arguments: {} });
  await current.bridge.internal.saveAfterMutation({ id: "connect-save", name: "pcb_save", arguments: {} });
  const before = await readFile(current.fresh.schematicPath, "utf8");
  const baseCall = current.sidecar.callTool;
  const baseList = current.sidecar.listTools;
  const fieldRequests: Readonly<Record<string, unknown>>[] = [];
  current.sidecar.listTools = () => [...baseList(), { name: "sch_autoplace_fields", permission: "write", inputSchema: { type: "object" } }];
  current.sidecar.callTool = async (name, args = {}) => {
    if (name !== "sch_autoplace_fields") return await baseCall(name, args);
    current.calls.push(name);
    fieldRequests.push(args);
    await writeFile(current.fresh.schematicPath, edit(await readFile(current.fresh.schematicPath, "utf8")));
    return { content: [], structuredContent: { result: `The schematic was updated.\n${summary}` } };
  };
  let captures = 0;
  const bridge = createKicadHarnessTools(current.sidecar, {
    freshProject: current.fresh, freshConnectivityContract: current.fixture.bundle.contract,
    freshCompilationBundle: current.fixture.bundle, verifyPersistedMutation: async () => true,
    ...(observeFreshSchematicFieldDiagnostic === undefined ? {} : { observeFreshSchematicFieldDiagnostic }),
    captureFreshNativeNetlist: async () => {
      captures += 1;
      if (nativeFailure && captures === 2) throw new Error("field native parity unavailable");
      if (captures === 3 && thirdCaptureEdit !== undefined) {
        await writeFile(current.fresh.schematicPath, thirdCaptureEdit(await readFile(current.fresh.schematicPath, "utf8")));
      }
      return current.nativeNetlist;
    },
  });
  return { ...current, bridge, before, fieldRequests, nativeCaptureCount: () => captures };
}

describe("explicit source-bound schematic field repair", () => {
  it("feeds the actual producer through the strict harness consumer, mandatory save and fresh validation without promoting readability", async () => {
    const current = await fieldRepairBridge();
    const phases: string[] = [];
    const produced: HarnessToolResult[] = [];
    // These controlled reports exercise sequencing, not physical board validity.
    const validation: Readonly<Record<string, unknown>> = {
      run_erc: { status: "clean", findings: [], metadata: { available: true, violation_count: 0 } },
      run_drc: { status: "clean", findings: [], metadata: { available: true, violations: 0, unconnected_items: 0, courtyard_issues: 0 } },
      pcb_get_board_summary: { status: "clean", findings: [], metadata: { footprints: 3, pads: 7, nets: 3, tracks: 1, shapes: 1 } },
      pcb_visual_qa: { status: "PASS", findings: [], footprint_count: 3, board_bounds: [0, 0, 30, 20] },
    };
    const port: HarnessToolPort = {
      tools: current.bridge.tools,
      execute: async (call) => { phases.push(call.name); const result = await current.bridge.execute(call as never); produced.push(result); return result; },
      internal: {
        ...current.bridge.internal,
        saveAfterMutation: async (call) => { phases.push("save"); return await current.bridge.internal.saveAfterMutation(call); },
        execute: async (call) => {
          phases.push(call.name);
          if (call.name === "sch_get_connectivity_graph") return await current.bridge.internal.execute(call);
          if (!Object.hasOwn(validation, call.name)) throw new Error(`Unexpected validation ${call.name}`);
          return { toolCallId: call.id, content: JSON.stringify(validation[call.name]) };
        },
      },
    };
    let completionCalls = 0;
    const report = await runPcbAgentHarness({
      userPrompt: "Explicitly repair fields, save and require fresh independent native render evidence.",
      fixedRules: ["Field repair is not a readability pass."], projectPath: current.fresh.projectPath,
      reportPath: path.join(current.fresh.outputPath, "field-consumer-report.json"), editsRequired: true,
      allowedToolNames: current.bridge.tools, maxIterations: 1,
    }, {
      provider: "fixture", turn: async (): Promise<HarnessProviderTurn> => ({
        message: { role: "assistant", content: "Repair fields explicitly." }, stopReason: "tool_calls",
        toolCalls: [{ id: "producer-consumer-fields", name: "fresh_autoplace_schematic_fields", arguments: {} }],
      }),
    }, port, {
      compoundMutationContractIdentity: createFreshConnectivityContract(current.fixture.bundle.contract).identity,
      captureValidationSource: async () => ({ schematic: contentIdentity(await readFile(current.fresh.schematicPath)), pcb: contentIdentity(await readFile(current.fresh.pcbPath)) }),
      completionGate: async (evidence) => {
        completionCalls += 1;
        expect(evidence.sourceBinding?.unchanged).toBe(true);
        return { passed: false, missing: ["Fresh native schematic ink clearance remains unverified."] };
      },
    });
    expect(report.status).toBe("needs_review");
    expect(report.summary).toContain("ink clearance remains unverified");
    expect(completionCalls).toBe(1);
    expect(phases).toEqual(["fresh_autoplace_schematic_fields", "save", "run_erc", "run_drc", "pcb_get_board_summary", "pcb_visual_qa"]);
    expect(current.nativeCaptureCount()).toBe(3); // before repair, after repair, after mandatory save
    expect(report.operations.find((operation) => operation.phase === "agent")?.result.content).toBe(produced[0]!.content);
    expect(report.operations.filter((operation) => operation.phase === "save")).toHaveLength(1);
    expect(report.validation.sourceBinding?.before.schematic).toEqual(JSON.parse(produced[0]!.content).afterSchematicContentIdentity);
  });

  it("logs an explicit host-only field mutation with a complete receipt and mandatory save parity", async () => {
    const current = await fieldRepairBridge();
    expect(current.bridge.tools.map((tool) => tool.name)).toContain("fresh_autoplace_schematic_fields");
    expect(current.bridge.tools.map((tool) => tool.name)).not.toContain("sch_autoplace_fields");
    await expect(current.bridge.execute({ id: "raw-fields", name: "sch_autoplace_fields" as never, arguments: {} })).rejects.toThrow(/unsupported/iu);
    const result = JSON.parse((await current.bridge.execute({ id: "fields", name: "fresh_autoplace_schematic_fields", arguments: {} })).content);
    expect(current.fieldRequests).toEqual([{ references: ["J1", "R1", "R2"], dry_run: false }]);
    const after = await readFile(current.fresh.schematicPath, "utf8");
    expect(result).toMatchObject({ schemaVersion: "evleda.fresh-schematic-fields-result.v1", applied: true, mutated: true, idempotent: false,
      beforeSchematicContentIdentity: contentIdentity(current.before), afterSchematicContentIdentity: contentIdentity(after),
      references: ["J1", "R1", "R2"], movedFieldCount: 1, issues: [] });
    const { identity, ...payload } = result;
    expect(identity).toEqual(canonicalIdentity(payload, result.schemaVersion));
    expect(parseFreshSchematicSource(after)).toEqual(parseFreshSchematicSource(current.before));
    expect(after).toBe(relocateR1Value(current.before));
    await expect(current.bridge.internal.saveAfterMutation({ id: "fields-save", name: "pcb_save", arguments: {} }))
      .resolves.toMatchObject({ content: expect.stringContaining("saved-and-native-connectivity-verified") });
    expect(await readFile(current.fresh.schematicPath, "utf8")).toBe(after);
  });

  it("reports an actual no-op without claiming fields moved or readable", async () => {
    const current = await fieldRepairBridge((source) => source, "Auto-placed Reference/Value fields on 0 symbol(s).");
    const result = JSON.parse((await current.bridge.execute({ id: "fields-noop", name: "fresh_autoplace_schematic_fields", arguments: {} })).content);
    expect(result).toMatchObject({ applied: true, mutated: false, idempotent: true, movedFieldCount: 0 });
    expect(result).not.toHaveProperty("readabilityPassed");
    expect(await readFile(current.fresh.schematicPath, "utf8")).toBe(current.before);
  });

  it.each([
    ["wire", (source: string) => source.replace('(xy 45.72 53.34)', '(xy 45.72 53.35)')],
    ["value", (source: string) => source.replace('(property "Value" "10k"', '(property "Value" "11k"')],
    ["library graphics", (source: string) => source.replace('(start -1.27 3.81)', '(start -1.27 3.82)')],
    ["label", (source: string) => source.replace('(justify right)', '(justify left)')],
    ["unrelated metadata", (source: string) => source.replace('(generator "KiCad Studio Fixture Corpus")', '(generator "changed")')],
  ] as const)("restores the exact connected preimage when a field operation also changes %s", async (_name, corrupt) => {
    const current = await fieldRepairBridge((source) => corrupt(relocateR1Value(source)));
    await expect(current.bridge.execute({ id: "bad-fields", name: "fresh_autoplace_schematic_fields", arguments: {} }))
      .rejects.toMatchObject({ message: expect.stringContaining("FRESH_CONNECTIVITY_ROLLED_BACK_TERMINAL"),
        cause: expect.objectContaining({ message: expect.stringContaining("outside existing visible") }) });
    expect(await readFile(current.fresh.schematicPath, "utf8")).toBe(current.before);
  });

  it.each([false, true])("retains a real schematic negative through host rollback (rollback failure: %s)", async rollbackFails => {
    let diagnostics: ReturnType<typeof createToolboxSchematicFieldDiagnostics>;
    const phases: string[] = [];
    const current = await fieldRepairBridge(undefined, undefined, false, undefined, async diagnostic => {
      phases.push(diagnostic.phase); return diagnostics.observe(diagnostic);
    });
    diagnostics = createToolboxSchematicFieldDiagnostics(current.fresh.outputPath);
    const { session } = await createSchematicFailureSession({ workspace: current.fresh.outputPath,
      project: current.fresh.projectPath, boardFile: current.fresh.pcbPath });
    const originalRestore = FreshSchematicRollback.prototype.restore;
    let primaryBytes: Buffer | undefined;
    const restore = vi.spyOn(FreshSchematicRollback.prototype, "restore").mockImplementation(async function (this: FreshSchematicRollback, ...args) {
      phases.push("rollback");
      const files = (await readdir(current.fresh.outputPath)).filter(file => file.startsWith("schematic-field-diagnostic-"));
      expect(files).toHaveLength(1);
      primaryBytes = await readFile(path.join(current.fresh.outputPath, files[0]!));
      const first = JSON.parse(primaryBytes.toString("utf8"));
      expect(first).toMatchObject({ phase: "primary-failure", schematicRollback: "not-attempted", nativeClose: null });
      expect(first.primary.value.cause).toEqual({ operation: "sch_autoplace_fields", response: schematicFailureReply });
      if (rollbackFails) throw new Error("synthetic rollback failure");
      return await originalRestore.apply(this, args);
    });
    const baseCall = current.sidecar.callTool;
    current.sidecar.callTool = async (name, args) => name === "sch_autoplace_fields"
      ? await session.callTool(name, args) : await baseCall(name, args);
    try {
      const error = await current.bridge.execute({ id: "native-negative-fields", name: "fresh_autoplace_schematic_fields", arguments: {} })
        .catch((error: unknown) => error);
      expect((error as Error).message).toContain(rollbackFails ? "FRESH_CONNECTIVITY_ROLLBACK_FAILED_TERMINAL" : "FRESH_CONNECTIVITY_ROLLED_BACK_TERMINAL");
      expect(((error as Error).cause as Error).cause).toEqual({ operation: "sch_autoplace_fields", response: schematicFailureReply });
      expect(String(error)).not.toMatch(/synthetic-private-test-token|Unsupported graphical/iu);
      expect(JSON.stringify(error)).not.toContain("synthetic-private-test-token");
      expect((error as Error).message).toMatch(/Private primary diagnostic: schematic-field-diagnostic-primary-failure-.*sha256:[a-f0-9]{64}/u);
      expect((error as Error).message).not.toContain(current.fresh.outputPath);
      expect(phases).toEqual(["primary-failure", "rollback", "recovery-finished"]);
      const files = (await readdir(current.fresh.outputPath)).filter(file => file.startsWith("schematic-field-diagnostic-"));
      expect(files).toHaveLength(2);
      const recovery = JSON.parse(await readFile(path.join(current.fresh.outputPath, files.find(file => file.includes("recovery-finished"))!), "utf8"));
      expect(recovery).toMatchObject({ schematicRollback: rollbackFails ? "failed" : "verified", nativeClose: null,
        primaryArtifact: { identity: contentIdentity(primaryBytes!) } });
      expect(recovery.rollbackFailure).toEqual(rollbackFails ? { status: "captured", value: { name: "Error", message: "synthetic rollback failure" } } : null);
      expect(await readFile(current.fresh.schematicPath, "utf8")).toBe(current.before);
      await session.assertActivePcb(current.fresh.pcbPath);
      await expect(session.callTool("pcb_save")).rejects.toThrow(/quarantined/iu);
      await session.close();
      await diagnostics.finalize({ nativeEditorTeardown: "unconfirmed", sidecarTeardown: "confirmed", ownedHostCleanup: "unconfirmed", checkpoint: "not-observed" });
      const finalFiles = (await readdir(current.fresh.outputPath)).filter(file => file.startsWith("schematic-field-diagnostic-"));
      const closed = JSON.parse(await readFile(path.join(current.fresh.outputPath, finalFiles.find(file => file.includes("close-finished"))!), "utf8"));
      expect(closed).toMatchObject({ schematicRollback: rollbackFails ? "failed" : "verified",
        nativeClose: { nativeEditorTeardown: "unconfirmed", sidecarTeardown: "confirmed", checkpoint: "not-observed" } });
      expect(await readFile(path.join(current.fresh.outputPath, finalFiles.find(file => file.includes("primary-failure"))!))).toEqual(primaryBytes);
    } finally { restore.mockRestore(); await session.close(); }
  });

  it.each(["reject", "timeout"] as const)("preserves the first fault and exact rollback when diagnostic publication encounters %s", async mode => {
    let firstObserved!: () => void;
    const observed = new Promise<void>(resolve => { firstObserved = resolve; });
    const phases: string[] = [];
    const current = await fieldRepairBridge(undefined, undefined, false, undefined, async diagnostic => {
      phases.push(diagnostic.phase); firstObserved();
      if (mode === "reject") throw new Error("private diagnostic writer failure");
      return await new Promise(() => {});
    });
    const primary = new Error("private-original-native-fault");
    const call = current.sidecar.callTool;
    current.sidecar.callTool = async (name, args) => {
      if (name !== "sch_autoplace_fields") return await call(name, args);
      await writeFile(current.fresh.schematicPath, relocateR1Value(current.before));
      throw primary;
    };
    try {
      if (mode === "timeout") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const result = current.bridge.execute({ id: "diagnostic-failure", name: "fresh_autoplace_schematic_fields", arguments: {} }).catch(error => error as Error);
      await observed;
      if (mode === "timeout") {
        await vi.advanceTimersByTimeAsync(FRESH_SCHEMATIC_FIELD_DIAGNOSTIC_TIMEOUT_MS);
        await vi.waitFor(() => expect(phases).toHaveLength(2));
        await vi.advanceTimersByTimeAsync(FRESH_SCHEMATIC_FIELD_DIAGNOSTIC_TIMEOUT_MS);
      }
      const error = await result as Error;
      expect(error.cause).toBe(primary);
      expect(error.message).toContain("FRESH_CONNECTIVITY_ROLLED_BACK_TERMINAL");
      expect(error.message).toContain("diagnostic publication was not confirmed");
      expect(error.message).not.toMatch(/private-original|private diagnostic/);
      expect(phases).toEqual(["primary-failure", "recovery-finished"]);
      expect(await readFile(current.fresh.schematicPath, "utf8")).toBe(current.before);
    } finally { vi.useRealTimers(); }
  });

  it("rolls back a native parity failure after the field write", async () => {
    const current = await fieldRepairBridge(relocateR1Value, undefined, true);
    await expect(current.bridge.execute({ id: "native-field-failure", name: "fresh_autoplace_schematic_fields", arguments: {} }))
      .rejects.toMatchObject({ message: expect.stringContaining("ROLLED_BACK_TERMINAL"), cause: expect.objectContaining({ message: "field native parity unavailable" }) });
    expect(await readFile(current.fresh.schematicPath, "utf8")).toBe(current.before);
  });

  it.each([
    "Auto-placed Reference/Value fields on 0 symbol(s).",
    "Auto-placed Reference/Value fields on 1 symbol(s): R2.",
    "Auto-placed Reference/Value fields on 1 symbol(s): R9.",
    "Auto-placed Reference/Value fields on 2 symbol(s): R1, R1.",
  ])("rejects contradictory field completion metadata %s", async (summary) => {
    const current = await fieldRepairBridge(relocateR1Value, summary);
    await expect(current.bridge.execute({ id: "field-summary", name: "fresh_autoplace_schematic_fields", arguments: {} }))
      .rejects.toMatchObject({ message: expect.stringContaining("ROLLED_BACK_TERMINAL"), cause: expect.objectContaining({ message: expect.stringContaining("completion") }) });
    expect(await readFile(current.fresh.schematicPath, "utf8")).toBe(current.before);
  });

  it("requires the exact saved field result and restores the prior source on save drift", async () => {
    const current = await fieldRepairBridge();
    await current.bridge.execute({ id: "fields-write", name: "fresh_autoplace_schematic_fields", arguments: {} });
    await writeFile(current.fresh.schematicPath, `${await readFile(current.fresh.schematicPath, "utf8")}\n`);
    const result = await current.bridge.internal.saveAfterMutation({ id: "fields-save-drift", name: "pcb_save", arguments: {} });
    expect(result).toMatchObject({ isError: true, content: expect.stringMatching(/FRESH_CONNECTIVITY_SAVE_TERMINAL.*field-layout schematic source changed/iu) });
    expect(await readFile(current.fresh.schematicPath, "utf8")).toBe(current.before);
  });

  it("rejects source drift during only the third native capture and rolls back without promoting save success", async () => {
    // Independent review of host hash 1ABB7AD6...FA523 found that the save
    // checkpoint checked source identity before, but not after, this capture.
    let driftWrites = 0;
    const current = await fieldRepairBridge(relocateR1Value, undefined, false, (source) => {
      driftWrites += 1;
      return source.replace('(at 80.01 52.07 0)', '(at 81.28 52.07 0)');
    });
    const pcbBefore = await readFile(current.fresh.pcbPath);
    const repair = JSON.parse((await current.bridge.execute({ id: "fields-before-capture-drift", name: "fresh_autoplace_schematic_fields", arguments: {} })).content);
    expect(current.nativeCaptureCount()).toBe(2);
    expect(driftWrites).toBe(0);
    expect(repair.afterSchematicContentIdentity).toEqual(contentIdentity(await readFile(current.fresh.schematicPath)));
    const saved = await current.bridge.internal.saveAfterMutation({ id: "fields-third-capture-drift", name: "pcb_save", arguments: {} });
    expect(current.nativeCaptureCount()).toBe(3);
    expect(driftWrites).toBe(1);
    expect(saved).toMatchObject({ isError: true, content: expect.stringMatching(/FRESH_CONNECTIVITY_SAVE_TERMINAL.*field-layout schematic source changed.*native capture/iu) });
    expect(saved.content).not.toContain('"status":"saved-and-native-connectivity-verified"');
    expect(await readFile(current.fresh.schematicPath, "utf8")).toBe(current.before);
    expect(await readFile(current.fresh.pcbPath)).toEqual(pcbBefore);
  });

  it("rejects missing capability, nonempty arguments and false completion before accepting any repair", async () => {
    const missing = await fieldRepairBridge();
    missing.sidecar.listTools = () => [];
    const beforeCalls = missing.calls.length;
    await expect(missing.bridge.execute({ id: "missing-fields", name: "fresh_autoplace_schematic_fields", arguments: {} })).rejects.toThrow(/required host-only/iu);
    expect(missing.calls).toHaveLength(beforeCalls);
    const current = await fieldRepairBridge(relocateR1Value, "Dry run: would reposition Reference/Value fields on 1 symbol(s): R1.");
    await expect(current.bridge.execute({ id: "fields-args", name: "fresh_autoplace_schematic_fields", arguments: { references: ["R1"] } })).rejects.toThrow(/unrecognized/iu);
    expect(current.fieldRequests).toEqual([]);
    await expect(current.bridge.execute({ id: "fields-false-positive", name: "fresh_autoplace_schematic_fields", arguments: {} })).rejects.toMatchObject({
      message: expect.stringContaining("ROLLED_BACK_TERMINAL"), cause: expect.objectContaining({ message: expect.stringContaining("completion summary") }) });
    expect(await readFile(current.fresh.schematicPath, "utf8")).toBe(current.before);
  });
});

const labelCorruptions: readonly (readonly [string, (source: string) => string])[] = [
  ["local-for-global", (source) => source.replace('(global_label "GND" (shape passive)', '(label "GND"')],
  ["hierarchical-for-global", (source) => source.replace('(global_label "GND"', '(hierarchical_label "GND"')],
  ["wrong-shape", (source) => source.replace('(global_label "GND" (shape passive)', '(global_label "GND" (shape input)')],
  ["wrong-anchor", (source) => source.replace(/\(global_label "GND" \(shape passive\) \(at [^)]+\)/u, '(global_label "GND" (shape passive) (at 999 999 0)')],
  ["inward-rotation", (source) => source.replace('(at 38.1 53.34 180)', '(at 38.1 53.34 0)')],
  ["inward-justify", (source) => source.replace('(justify right)', '(justify left)')],
  ["centered-label", (source) => source.replace(' (justify right)', '')],
  ["wrong-font", (source) => source.replace('(size 1.524 1.524)', '(size 2.54 2.54)')],
  ["missing-font", (source) => source.replace('(font (size 1.524 1.524)) ', '')],
  ["bold-label", (source) => source.replace('(font (size 1.524 1.524))', '(font (size 1.524 1.524) (bold yes))')],
  ["italic-label", (source) => source.replace('(font (size 1.524 1.524))', '(font (size 1.524 1.524) (italic yes))')],
  ["hidden-label", (source) => source.replace('(justify right)', '(justify right) (hide yes)')],
  ["extra-at-atom", (source) => source.replace('(at 38.1 53.34 180)', '(at 38.1 53.34 180 0)')],
  ["duplicate-justify", (source) => source.replace('(justify right)', '(justify right) (justify right)')],
  ["duplicate-global", (source) => addForm(source, '(global_label "GND" (shape passive) (at 999 999 0))')],
  ["extra-local", (source) => addForm(source, '(label "EXTRA" (at 999 999 0))')],
  ["extra-hierarchical", (source) => addForm(source, '(hierarchical_label "EXTRA" (shape passive) (at 999 999 0))')],
];

describe("generic passive global contract labels", () => {
  it("uses one private batch at verified on-grid anchors and accepts an exact saved retry", async () => {
    const { bridge, calls, labelRequests, fresh, fixture } = await capturedPlanBridge();
    expect(bridge.tools.some((tool) => tool.name === "sch_add_labels")).toBe(false);
    await expect(bridge.execute({ id: "raw-batch", name: "sch_add_labels" as never, arguments: { labels: [] } })).rejects.toThrow(/unsupported/iu);
    await bridge.execute({ id: "global", name: "fresh_apply_contract_connectivity", arguments: {} });
    expect(calls.filter((name) => name === "sch_add_labels")).toHaveLength(1);
    expect(calls).not.toContain("sch_add_label");
    expect(labelRequests).toEqual(fixture.bundle.contract.nets.map((net) => {
      const endpoint = net.endpoints[0]!;
      const [, at] = oracle.inputPlan.pins.find(([id]) => id === `${endpoint.reference}:${endpoint.pin}`)!;
      return { name: net.name, x_mm: net.name === "VOUT" ? 30.48 : 38.1, y_mm: at.y, kind: "global", shape: "passive", rotation: 180, snap_to_grid: true, justify: "right" };
    }));
    expect(parseFreshSchematicSource(await readFile(fresh.schematicPath, "utf8")).labels).toHaveLength(3);
    await bridge.internal.saveAfterMutation({ id: "save-global", name: "pcb_save", arguments: {} });
    const retry = await bridge.execute({ id: "retry-global", name: "fresh_apply_contract_connectivity", arguments: {} });
    expect(JSON.parse(retry.content)).toMatchObject({ applied: true, mutated: false, idempotent: true, issues: [] });
  });

  it("requires the private batch capability before any mutation", async () => {
    const { sidecar, fixture, fresh, calls } = await capturedPlanBridge();
    const bridge = createKicadHarnessTools({ ...sidecar, listTools: () => sidecar.listTools().filter((tool) => tool.name !== "sch_add_labels") }, {
      freshProject: fresh, freshConnectivityContract: fixture.bundle.contract, freshCompilationBundle: fixture.bundle,
    });
    await expect(bridge.execute({ id: "missing-global-api", name: "fresh_apply_contract_connectivity", arguments: {} })).rejects.toThrow(/required.*sch_add_labels/iu);
    expect(calls).toEqual([]);
  });

  it.each(labelCorruptions)("rolls back %s persisted during the label batch", async (_name, corrupt) => {
    const { bridge, fresh } = await capturedPlanBridge(undefined, false, corrupt);
    await expect(bridge.execute({ id: "bad-global-write", name: "fresh_apply_contract_connectivity", arguments: {} })).rejects.toThrow(/ROLLED_BACK_TERMINAL.*labels.*kinds.*shapes.*names.*anchors/iu);
    expect(await readFile(fresh.schematicPath, "utf8")).toBe(baseline);
  });

  it.each(labelCorruptions)("rejects an idempotent retry with %s even when graph/native names are exact", async (_name, corrupt) => {
    const { bridge, fresh } = await capturedPlanBridge();
    await bridge.execute({ id: "global-write", name: "fresh_apply_contract_connectivity", arguments: {} });
    await bridge.internal.saveAfterMutation({ id: "global-save", name: "pcb_save", arguments: {} });
    await writeFile(fresh.schematicPath, corrupt(await readFile(fresh.schematicPath, "utf8")));
    const retry = await bridge.execute({ id: "bad-global-retry", name: "fresh_apply_contract_connectivity", arguments: {} });
    expect(JSON.parse(retry.content)).toMatchObject({ applied: false, mutated: false, idempotent: true, issues: [expect.objectContaining({ code: "CONTRACT_LABEL_INVENTORY_MISMATCH" })] });
  });

  it.each(labelCorruptions)("rolls back %s observed after save", async (_name, corrupt) => {
    const { bridge, fresh } = await capturedPlanBridge();
    await bridge.execute({ id: "global-write", name: "fresh_apply_contract_connectivity", arguments: {} });
    await writeFile(fresh.schematicPath, corrupt(await readFile(fresh.schematicPath, "utf8")));
    const saved = await bridge.internal.saveAfterMutation({ id: "bad-global-save", name: "pcb_save", arguments: {} });
    expect(saved).toMatchObject({ isError: true, content: expect.stringMatching(/FRESH_CONNECTIVITY_SAVE_TERMINAL.*label.*after save/iu) });
    expect(await readFile(fresh.schematicPath, "utf8")).toBe(baseline);
  });

  it.each(["fresh_apply_contract_connectivity", "fresh_sync_from_schematic", "sch_modify_property"] as const)("rejects child sheets before generic %s can reach the sidecar", async (name) => {
    const { bridge, fresh, calls } = await capturedPlanBridge();
    await writeFile(fresh.schematicPath, addForm(baseline, '(sheet (property "Sheetfile" "child.kicad_sch"))'));
    await expect(bridge.execute({ id: "child-sheet", name, arguments: name === "sch_modify_property" ? { reference: "R1", field: "Value", value: "10k" } : {} })).rejects.toThrow(/single-sheet.*child sheets/iu);
    expect(calls).toEqual([]);
  });

  it("rolls back a child sheet introduced during the global batch or before its save", async () => {
    const child = (source: string) => addForm(source, '(sheet (property "Sheetfile" "child.kicad_sch"))');
    const during = await capturedPlanBridge(undefined, false, child);
    await expect(during.bridge.execute({ id: "child-write", name: "fresh_apply_contract_connectivity", arguments: {} })).rejects.toThrow(/ROLLED_BACK_TERMINAL.*single-sheet/iu);
    expect(await readFile(during.fresh.schematicPath, "utf8")).toBe(baseline);
    const beforeSave = await capturedPlanBridge();
    await beforeSave.bridge.execute({ id: "write", name: "fresh_apply_contract_connectivity", arguments: {} });
    await writeFile(beforeSave.fresh.schematicPath, child(await readFile(beforeSave.fresh.schematicPath, "utf8")));
    expect(await beforeSave.bridge.internal.saveAfterMutation({ id: "child-save", name: "pcb_save", arguments: {} })).toMatchObject({ isError: true, content: expect.stringContaining("single-sheet") });
    expect(await readFile(beforeSave.fresh.schematicPath, "utf8")).toBe(baseline);
  });
});

const classSourceCorruptions: readonly (readonly [string, (source: string) => string])[] = [
  ["canonical Netclass", (source) => source.replace('(global_label "GND"', '(global_label "GND" (property "Netclass" "OtherClass" (at 0 0 0))')],
  ["private Netclass", (source) => source.replace('(global_label "GND"', '(global_label "GND" (property private "Netclass" "OtherClass" (at 0 0 0))')],
  ["English compatibility alias", (source) => source.replace('(global_label "GND"', '(global_label "GND" (property "Net Class" "OtherClass" (at 0 0 0))')],
  ["unsupported localized field", (source) => source.replace('(global_label "GND"', '(global_label "GND" (property "Netzklasse" "OtherClass" (at 0 0 0))')],
  ["directive_label", (source) => addForm(source, '(directive_label "" (at 0 0 0) (length 2.54) (shape dot) (property "Netclass" "OtherClass"))')],
  ["native legacy netclass_flag", (source) => addForm(source, '(netclass_flag "" (at 0 0 0) (length 2.54) (shape dot) (property "Netclass" "OtherClass"))')],
  ["native rule_area", (source) => addForm(source, '(rule_area (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (polyline (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 0)) (stroke (width 0.15) (type default)) (fill (type none))))')],
];

describe("generic schematic class-source guards", () => {
  it.each(classSourceCorruptions)("rolls back %s introduced during mutation", async (_name, corrupt) => {
    const { bridge, fresh } = await capturedPlanBridge(undefined, false, corrupt);
    await expect(bridge.execute({ id: "class-source-write", name: "fresh_apply_contract_connectivity", arguments: {} })).rejects.toThrow(/ROLLED_BACK_TERMINAL.*unsupported class sources/iu);
    expect(await readFile(fresh.schematicPath, "utf8")).toBe(baseline);
  });

  it.each(classSourceCorruptions)("rejects %s before an idempotent retry reaches any sidecar call", async (_name, corrupt) => {
    const { bridge, fresh, calls } = await capturedPlanBridge();
    await bridge.execute({ id: "write", name: "fresh_apply_contract_connectivity", arguments: {} });
    await bridge.internal.saveAfterMutation({ id: "save", name: "pcb_save", arguments: {} });
    await writeFile(fresh.schematicPath, corrupt(await readFile(fresh.schematicPath, "utf8")));
    const before = [...calls];
    await expect(bridge.execute({ id: "class-source-retry", name: "fresh_apply_contract_connectivity", arguments: {} })).rejects.toThrow(/unsupported class sources/iu);
    expect(calls).toEqual(before);
  });

  it.each(classSourceCorruptions)("rolls back %s observed after a connectivity save", async (_name, corrupt) => {
    const { bridge, fresh } = await capturedPlanBridge();
    await bridge.execute({ id: "write", name: "fresh_apply_contract_connectivity", arguments: {} });
    await writeFile(fresh.schematicPath, corrupt(await readFile(fresh.schematicPath, "utf8")));
    expect(await bridge.internal.saveAfterMutation({ id: "class-source-save", name: "pcb_save", arguments: {} })).toMatchObject({ isError: true, content: expect.stringMatching(/FRESH_CONNECTIVITY_SAVE_TERMINAL.*unsupported class sources/iu) });
    expect(await readFile(fresh.schematicPath, "utf8")).toBe(baseline);
  });

  it.each(["fresh_apply_contract_connectivity", "fresh_sync_from_schematic", "sch_modify_property"] as const)("rejects a class directive before generic source operation %s", async (name) => {
    const { bridge, fresh, calls } = await capturedPlanBridge();
    await writeFile(fresh.schematicPath, addForm(baseline, '(directive_label "" (at 0 0 0) (length 2.54) (shape dot) (property private "Netclass" "OtherClass"))'));
    await expect(bridge.execute({ id: "class-source-preflight", name, arguments: name === "sch_modify_property" ? { reference: "R1", field: "Value", value: "10k" } : {} })).rejects.toThrow(/unsupported class sources/iu);
    expect(calls).toEqual([]);
  });

  it("rejects unsupported sources after a raw generic schematic save without a pending connectivity compound", async () => {
    const { bridge, fresh } = await capturedPlanBridge();
    await bridge.execute({ id: "raw-property", name: "sch_modify_property", arguments: { reference: "R1", field: "Value", value: "10k" } });
    await writeFile(fresh.schematicPath, addForm(baseline, '(netclass_flag "" (at 0 0 0) (length 2.54) (shape dot) (property "Netclass" "OtherClass"))'));
    expect(await bridge.internal.saveAfterMutation({ id: "raw-property-save", name: "pcb_save", arguments: {} })).toMatchObject({ isError: true, content: expect.stringMatching(/SAVE_TERMINAL.*unsupported class sources/iu) });
  });

  it("preserves harmless global intersheet fields, effects, UUIDs and ordinary drawings through save and idempotent checks", async () => {
    // Preserve the one authored effects block; a duplicate/wrong-size effects
    // block is not harmless presentation metadata.
    const harmless = (source: string) => addForm(source.replace('(global_label "GND"', '(global_label "GND" (fields_autoplaced yes) (property private "INTERSHEET REFERENCES" "${INTERSHEET_REFS}" (at 0 0 0)) (uuid "00000000-0000-4000-8000-000000000003")'), '(rectangle (start 0 0) (end 10 10)) (polyline (pts (xy 0 0) (xy 10 0)))');
    const { bridge } = await capturedPlanBridge(undefined, false, harmless);
    expect(JSON.parse((await bridge.execute({ id: "harmless-write", name: "fresh_apply_contract_connectivity", arguments: {} })).content)).toMatchObject({ applied: true, mutated: true });
    expect(await bridge.internal.saveAfterMutation({ id: "harmless-save", name: "pcb_save", arguments: {} })).not.toHaveProperty("isError", true);
    expect(JSON.parse((await bridge.execute({ id: "harmless-retry", name: "fresh_apply_contract_connectivity", arguments: {} })).content)).toMatchObject({ applied: true, mutated: false, idempotent: true });
  });
});
