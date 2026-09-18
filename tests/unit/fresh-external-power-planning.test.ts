import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { FRESH_CONNECTIVITY_CONTRACT_SCHEMA_VERSION, type FreshConnectivityContract } from "../../src/harness/fresh-connectivity-contract.js";
import { freshPowerFlagDefinitionSemanticIdentity, parseFreshSymbolLibraryTerminalGeometrySource } from "../../src/harness/fresh-kicad-parser.js";
import { FreshSchematicWorkBudget } from "../../src/harness/fresh-schematic-work-budget.js";
import { buildSchematicTerminalGroups, type FreshSchematicTerminalPartition } from "../../src/harness/fresh-schematic-terminal-groups.js";
import { createFreshTerminalLabelPlanningSession, planFreshTerminalGlobalLabels } from "../../src/harness/fresh-schematic-terminal-labels.js";
import {
  createFreshSchematicStrokeStyleEvidence,
  FRESH_SCHEMATIC_STROKE_NATIVE_PROFILE as profile,
  type FreshSchematicStrokeStyleCapture,
} from "../../src/harness/fresh-schematic-stroke-style.js";
import {
  createFreshSchematicPlanningWork, planFreshExternalPowerGeometry, planFreshTerminalGlobalLabelsAndPower, createKicadHarnessTools,
  KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES, type KicadHarnessSession, type KicadHarnessToolsOptions,
} from "../../src/harness/kicad-tools.js";
import type { PcbReadOnlyLibraryResolver } from "../../src/harness/pcb-design-compiler.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle, createPcbPlaneCompilationBundleRef } from "../../src/harness/pcb-design-plane-bundle.js";
import { preparePlaneFreshProject } from "../../src/harness/fresh-project.js";
import { genericDividerLibraryResolver } from "../helpers/generic-divider-bundle.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";
import {
  PCB_EXTERNAL_POWER_BINDING_SCHEMA_VERSION,
  PCB_EXTERNAL_POWER_FLAG_INSPECTION_SCHEMA_VERSION,
  PCB_EXTERNAL_POWER_FLAG_POLICY_SCHEMA_VERSION,
  type PcbExternalPowerBinding,
  type PcbExternalPowerFlagInspection,
} from "../../src/harness/pcb-external-power.js";

// All captures, libraries, geometry, and contracts below are synthetic test data.
// The harness tests create temporary prepared projects; no KiCad process or native observation is produced.
const schematicSource = '(kicad_sch (version 20250114) (generator "synthetic-planner-fixture"))';
const sourceIdentity = contentIdentity(schematicSource);
const defaultGraphic = `(polyline
  (pts (xy 0 0) (xy 0 1.27) (xy -1.016 1.27) (xy 0 2.54) (xy 1.016 1.27) (xy 0 1.27))
  (stroke (width 0) (type default)) (fill (type none)))`;
const librarySource = (graphic = defaultGraphic) => `(kicad_symbol_lib (version 20250114)
  (symbol "PWR_FLAG" (power global) (in_bom yes) (on_board yes)
    (property "Reference" "#FLG") (property "Value" "PWR_FLAG") (property "Footprint" "")
    (symbol "PWR_FLAG_0_1" ${graphic}
      (pin power_out line (at 0 0 90) (length 0) (name "pwr") (number "1")))))`;

function syntheticStyle(svgSource?: string) {
  const cwd = path.resolve("D:/owned-style-test/project");
  const output = path.resolve("D:/owned-style-test/artifacts/render");
  const executablePath = path.resolve("D:/pinned-runtime/kicad-cli.exe");
  const projectSettingsSource = "{}", applicationSource = "{}";
  const sourceIdentities = { schematic: sourceIdentity, pcb: contentIdentity("synthetic PCB"), projectSettings: contentIdentity(projectSettingsSource) };
  const executable = {
    kind: "kicad-cli" as const, path: executablePath, version: profile.version, commit: "a".repeat(40),
    sha256: profile.executable.digest, sizeBytes: profile.executable.size,
    capabilityHelpSha256: "b".repeat(64), confirmedCapabilities: ["sch export svg"],
  };
  const svg = svgSource ?? '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
  const svgIdentity = contentIdentity(svg), configIdentity = contentIdentity(applicationSource);
  const tree = canonicalIdentity({ schemaVersion: "evleda.kicad-schematic-configuration-tree.v1",
    files: [{ relativePath: "10.0/eeschema.json", identity: configIdentity }], directories: ["10.0"],
  }, "evleda.kicad-schematic-configuration-tree.v1");
  const capture: FreshSchematicStrokeStyleCapture = {
    render: {
      classification: "candidate-validation", releaseAuthorized: false, executable, outputDirectory: output,
      sourceHashes: { "test.kicad_sch": sourceIdentity.digest }, sourceIdentities,
      invocation: {
        executable, command: executablePath,
        args: ["sch", "export", "svg", "--output", output, "--black-and-white", "--exclude-drawing-sheet", "--no-background-color", path.join(cwd, "test.kicad_sch")],
        cwd, exitCode: 0, stdout: "", stderr: "", durationMs: 1, startedAt: "2026-09-09T12:00:00.000Z",
      },
      schematicSvg: { path: path.join(output, "test.svg"), relativePath: "test.svg", sha256: svgIdentity.digest, sizeBytes: svgIdentity.size },
      source: svg,
    },
    projectSettingsSource,
    schematicEngine: { path: path.join(path.dirname(executablePath), "_eeschema.dll"), before: profile.schematicEngine, after: profile.schematicEngine },
    configuration: {
      isolation: "caller-owned-isolated", configHome: path.resolve("D:/owned-style-test/config"), treeBefore: tree, treeAfter: tree,
      applicationConfig: { relativePath: "10.0/eeschema.json", source: applicationSource, before: configIdentity, after: configIdentity },
    },
  };
  return createFreshSchematicStrokeStyleEvidence(capture, sourceIdentities);
}

function syntheticInspection(source = librarySource()): PcbExternalPowerFlagInspection {
  const identity = contentIdentity(source);
  const geometry = parseFreshSymbolLibraryTerminalGeometrySource(source, identity, "power:PWR_FLAG");
  const payload = {
    schemaVersion: PCB_EXTERNAL_POWER_FLAG_INSPECTION_SCHEMA_VERSION,
    symbolLibId: "power:PWR_FLAG" as const, sourceIdentity: identity, definitionIdentity: geometry.definitionIdentity,
    definitionSemanticIdentity: freshPowerFlagDefinitionSemanticIdentity(source, identity, false),
    policyIdentity: canonicalIdentity({ purpose: "synthetic planner policy" }, PCB_EXTERNAL_POWER_FLAG_POLICY_SCHEMA_VERSION),
    powerScope: "global" as const, footprint: "" as const, inBom: true as const, onBoard: true as const, geometry,
  };
  return { ...payload, identity: canonicalIdentity(payload, PCB_EXTERNAL_POWER_FLAG_INSPECTION_SCHEMA_VERSION) };
}

function fixture(source = librarySource()) {
  const inspection = syntheticInspection(source);
  const contractIdentity = canonicalIdentity({ purpose: "synthetic connector supply and return" }, "evleda.synthetic-external-power-contract.v1");
  const bindingPayload = {
    schemaVersion: PCB_EXTERNAL_POWER_BINDING_SCHEMA_VERSION, contractIdentity,
    source: {
      symbolLibId: inspection.symbolLibId, sourceIdentity: inspection.sourceIdentity,
      definitionIdentity: inspection.definitionIdentity, definitionSemanticIdentity: inspection.definitionSemanticIdentity,
      inspectionIdentity: inspection.identity, policyIdentity: inspection.policyIdentity,
    },
    flags: [
      { reference: "#FLG001", net: "SUPPLY_A", anchorEndpoint: { reference: "J1", pin: "1" }, symbolLibId: "power:PWR_FLAG" as const },
      { reference: "#FLG002", net: "SUPPLY_B", anchorEndpoint: { reference: "J1", pin: "2" }, symbolLibId: "power:PWR_FLAG" as const },
    ],
  };
  const binding: PcbExternalPowerBinding = { ...bindingPayload, identity: canonicalIdentity(bindingPayload, PCB_EXTERNAL_POWER_BINDING_SCHEMA_VERSION) };
  const payload = {
    schemaVersion: FRESH_CONNECTIVITY_CONTRACT_SCHEMA_VERSION, sourceContractIdentity: contractIdentity,
    components: [{ reference: "J1", symbolLibId: "Test:Connector", value: "Connector", footprintLibId: "Test:Connector" }],
    nets: [
      { name: "SUPPLY_A", endpoints: [{ reference: "J1", pin: "1" }] },
      { name: "SUPPLY_B", endpoints: [{ reference: "J1", pin: "2" }] },
    ],
    noConnects: [], externalPowerBinding: binding,
  };
  const contract: FreshConnectivityContract = { ...payload, identity: canonicalIdentity(payload, FRESH_CONNECTIVITY_CONTRACT_SCHEMA_VERSION) };
  const resolver: PcbReadOnlyLibraryResolver = { resolveSymbol: () => null, resolveFootprint: () => null, inspectExternalPowerFlag: () => inspection };
  return { contract, resolver, inspection, style: syntheticStyle() };
}

const pins = new Map([
  ["J1:1", { x: 101.6, y: 76.2, angleDeg: 0 as const }],
  ["J1:2", { x: 101.6, y: 86.36, angleDeg: 0 as const }],
]);
const boxes = [{ reference: "J1", minX: 104, maxX: 112, minY: 73, maxY: 90 }];
type PhysicalPlan = Parameters<typeof planFreshExternalPowerGeometry>[1];
const plan: PhysicalPlan = {
  routes: ["existing physical supply and return label stubs"], issues: [],
  wires: [
    { x: 101.6, y: 76.2, endX: 96.52, endY: 76.2, net: "SUPPLY_A", edgeEndpoints: ["J1:1"] },
    { x: 101.6, y: 86.36, endX: 96.52, endY: 86.36, net: "SUPPLY_B", edgeEndpoints: ["J1:2"] },
  ],
  labels: [
    { name: "SUPPLY_A", endpointId: "J1:1", at: { x: 96.52, y: 76.2 }, rotationDeg: 180, justify: "right", fontMm: 1.524,
      bounds: { minX: 82.55, maxX: 96.52, minY: 74.676, maxY: 77.724 } },
    { name: "SUPPLY_B", endpointId: "J1:2", at: { x: 96.52, y: 86.36 }, rotationDeg: 180, justify: "right", fontMm: 1.524,
      bounds: { minX: 82.55, maxX: 96.52, minY: 84.836, maxY: 87.884 } },
  ],
};
const run = (input = fixture(), obstacles = boxes) => planFreshExternalPowerGeometry(
  input.contract, plan, pins, obstacles, input.resolver, createFreshSchematicPlanningWork(), sourceIdentity, input.style,
);

/** Complete synthetic inventory: one earlier flag and one label-trapped flag. */
function terminalPowerFixture(count = 9, stacked = false) {
  const stock = fixture(), base = stock.contract;
  const components = ["A1", "J1", ...Array.from({ length: count - 2 }, (_, index) => `Z${index + 1}`)]
    .map(reference => ({ ...base.components[0]!, reference }));
  const values = [
    { reference: "A1", pin: "1", x: 30.48, y: 30.48, net: "SUPPLY_A" },
    { reference: "J1", pin: "1", x: 101.6, y: 101.6, net: "SUPPLY_B" },
    { reference: "J1", pin: "2", x: 101.6, y: 99.06, net: "ZZ_SIGNAL" },
    ...(stacked ? [{ reference: "J1", pin: "3", x: 101.6, y: 101.6, net: "SUPPLY_B" }] : []),
    ...components.filter(component => component.reference.startsWith("Z")).map((component, index) => ({ reference: component.reference,
      pin: "1", x: Number((20.32 + index * 7.62).toFixed(4)), y: 160.02, net: null })),
  ];
  const bindingPayload = { ...base.externalPowerBinding!, flags: [
    { ...base.externalPowerBinding!.flags[0]!, anchorEndpoint: { reference: "A1", pin: "1" } },
    { ...base.externalPowerBinding!.flags[1]!, anchorEndpoint: { reference: "J1", pin: stacked ? "3" : "1" } },
  ] };
  const { identity: _bindingIdentity, ...bindingContent } = bindingPayload;
  const externalPowerBinding = { ...bindingContent, identity: canonicalIdentity(bindingContent, bindingContent.schemaVersion) };
  const { identity: _contractIdentity, ...basePayload } = base;
  const payload = { ...basePayload, components, externalPowerBinding,
    nets: ["SUPPLY_A", "SUPPLY_B", "ZZ_SIGNAL"].map(name => ({ name, endpoints: values.filter(value => value.net === name)
      .map(({ reference, pin }) => ({ reference, pin })) })),
    noConnects: values.filter(value => value.net === null).map(({ reference, pin }) => ({ reference, pin })),
  };
  const contract: FreshConnectivityContract = { ...payload, identity: canonicalIdentity(payload, payload.schemaVersion) };
  const pins = new Map(values.map(value => [`${value.reference}:${value.pin}`, { x: value.x, y: value.y, angleDeg: 180 as const }]));
  const grouped = buildSchematicTerminalGroups({ contractIdentity: contract.sourceContractIdentity,
    components: components.map(component => ({ reference: component.reference, symbolLibId: component.symbolLibId, unit: 1, sourceIdentity,
      placement: { at: { xMm: 0, yMm: 0 }, rotationDeg: 0 }, pins: values.filter(value => value.reference === component.reference)
        .map(value => ({ number: value.pin, at: { xMm: value.x, yMm: -value.y }, angleDeg: 180 })) })),
    assignments: values.map(value => ({ reference: value.reference, pin: value.pin, assignment: value.net === null
      ? { kind: "no_connect" as const } : { kind: "net" as const, net: value.net } })),
    livePins: values.map(value => ({ reference: value.reference, pin: value.pin, at: { xMm: value.x, yMm: value.y }, angleDeg: 180 })),
  });
  if (grouped.status !== "complete") throw new Error(JSON.stringify(grouped));
  const boxes = components.map(component => {
    const pin = values.find(value => value.reference === component.reference)!;
    return { reference: component.reference, minX: pin.x - 2.54, maxX: pin.x, minY: component.reference === "J1" ? 97.79 : pin.y - 1.27, maxY: pin.y + 1.27 };
  });
  // The lower lane is occupied. The upper lane is trapped by the following
  // signal stub until the declared SUPPLY_B label moves beyond its short slot.
  // Full native frame strokes require more than the former guessed envelope.
  // These small ink obstacles reserve usable incoming-port length for each flag.
  boxes.push({ reference: "@a1-port-ink", minX: 31.6, maxX: 31.8, minY: 29, maxY: 29.2 });
  boxes.push({ reference: "@j1-port-ink", minX: 103.5, maxX: 104.2, minY: 102.5, maxY: 102.7 });
  boxes.push({ reference: "@lower-body", minX: 95, maxX: 180, minY: 103.3, maxY: 145 });
  const input = { contract, partition: grouped.value, sourceIdentity, pins, boxes, strokeStyle: stock.style,
    sourceBodyBoxes: [], sheet: { minX: 15.24, minY: 15.24, maxX: 279.4, maxY: 195.58 } };
  const run = (work = createFreshSchematicPlanningWork()) => planFreshTerminalGlobalLabelsAndPower(input, stock.resolver, work);
  return { ...stock, input, run };
}

describe("joint repeated terminal labels and declared power flags", () => {
  it.each([false, true])("regenerates the affected suffix and all flags for a trapped declared anchor; stacked=%s", stacked => {
    const f = terminalPowerFixture(9, stacked), before = JSON.stringify({ ...f.input, pins: [...f.input.pins] });
    const greedy = planFreshTerminalGlobalLabels(f.input);
    expect(greedy.issues).toEqual([]);
    const initial = planFreshExternalPowerGeometry(f.input.contract, { ...greedy, wires: [...greedy.wires], routes: [...greedy.routes], issues: [] },
      f.input.pins, f.input.boxes, f.resolver, createFreshSchematicPlanningWork(), sourceIdentity, f.style, undefined, f.input.partition);
    expect(initial.flags).toHaveLength(1);
    expect(initial.issues).toEqual([expect.objectContaining({ code: "EXTERNAL_POWER_PLACEMENT_UNSUPPORTED", endpoints: [`J1:${stacked ? "3" : "1"}`] })]);
    const work = createFreshSchematicPlanningWork(), result = f.run(work);
    expect(result.issues).toEqual([]);
    expect(result.flags).toHaveLength(2);
    expect(new Set(result.flags.map(flag => flag.reference)).size).toBe(2);
    expect(result.labels.find(label => label.endpointId === "J1:1")!.at.x).toBeGreaterThan(greedy.labels.find(label => label.endpointId === "J1:1")!.at.x);
    expect(result.labels.find(label => label.endpointId === "J1:2")!.at.x).toBeLessThan(greedy.labels.find(label => label.endpointId === "J1:2")!.at.x);
    const cleanReplay = planFreshExternalPowerGeometry(f.input.contract, { wires: result.wires.slice(0, result.labels.length), labels: result.labels, routes: result.routes, issues: [] },
      f.input.pins, f.input.boxes, f.resolver, createFreshSchematicPlanningWork(), sourceIdentity, f.style, undefined, f.input.partition);
    expect(result).toEqual(cleanReplay);
    expect(JSON.stringify({ ...f.input, pins: [...f.input.pins] })).toBe(before);
    const second = createFreshSchematicPlanningWork();
    expect(f.run(second)).toEqual(result); expect(second.budget.snapshot()).toEqual(work.budget.snapshot());
  });

  it("preserves the <=8-component flag failure and successful earlier flag", () => {
    const f = terminalPowerFixture(8), result = f.run();
    expect(result.flags).toHaveLength(1);
    expect(result.issues[0]!.code).toBe("EXTERNAL_POWER_PLACEMENT_UNSUPPORTED");
    expect(result.labels).toEqual(planFreshTerminalGlobalLabels(f.input).labels);
  });

  it("keeps an already successful whole greedy plan unchanged above the legacy boundary", () => {
    const small = terminalPowerFixture(8), larger = terminalPowerFixture(9);
    small.input.boxes.pop(); larger.input.boxes.pop();
    const previous = small.run(), current = larger.run();
    expect(previous.issues).toEqual([]); expect(current).toEqual(previous);
    expect(current.labels).toEqual(planFreshTerminalGlobalLabels(larger.input).labels);
  });

  it.each([5.08, 8.89])("uses a late finite %s mm lane only when every old flag candidate is blocked", transverse => {
    const small = terminalPowerFixture(8), larger = terminalPowerFixture(9);
    for (const f of [small, larger]) {
      f.input.boxes.push({ reference: "@upper-ink", minX: 95, maxX: 180, minY: 40, maxY: transverse === 5.08 ? 89 : 85.3 });
      if (transverse === 8.89) f.input.boxes.push({ reference: "@short-lane-ink", minX: 122, maxX: 180, minY: 94.8, maxY: 95 });
    }
    const session = createFreshTerminalLabelPlanningSession(larger.input);
    let plan = session.plan;
    while (plan.labels.find(label => label.endpointId === "J1:1")!.at.x < 121.92) plan = session.retryDeclaredPowerAnchor("J1:1")!;
    const run = (f: typeof larger) => planFreshExternalPowerGeometry(f.input.contract,
      { ...plan, wires: [...plan.wires], routes: [...plan.routes], issues: [] }, f.input.pins, f.input.boxes, f.resolver,
      createFreshSchematicPlanningWork(), sourceIdentity, f.style, undefined, f.input.partition);
    expect(run(small).issues[0]!.code).toBe("EXTERNAL_POWER_PLACEMENT_UNSUPPORTED");
    const result = run(larger);
    expect(result.issues).toEqual([]);
    expect(result.flags[1]!.y).toBeCloseTo(larger.input.pins.get("J1:1")!.y - transverse, 8);
  });

  it("retains the old whole flag pass before using the late 25.4 mm lane for downward anchors", () => {
    const source = fixture(), geometry = cardinalFixture(90);
    const make = (count: number) => {
      const extras = Array.from({ length: count - 1 }, (_, index) => ({ ...source.contract.components[0]!, reference: `Z${index + 1}` }));
      const { identity: _identity, ...base } = source.contract;
      const payload = { ...base, components: [...base.components, ...extras], noConnects: extras.map(component => ({ reference: component.reference, pin: "1" })) };
      const contract = { ...payload, identity: canonicalIdentity(payload, payload.schemaVersion) };
      const pins = new Map([...geometry.pins, ...extras.map((component, index) => [`${component.reference}:1`, { x: 20.32 + index * 7.62, y: 180.34, angleDeg: 90 as const }] as const)]);
      const boxes = [{ reference: "J1", minX: 83.82, maxX: 119.38, minY: 65, maxY: 76.2 },
        ...extras.map((component, index) => ({ reference: component.reference, minX: 20.32 + index * 7.62, maxX: 21.59 + index * 7.62, minY: 179.07, maxY: 180.34 }))];
      return planFreshExternalPowerGeometry(contract, geometry.plan, pins, boxes, source.resolver, createFreshSchematicPlanningWork(), sourceIdentity, source.style);
    };
    expect(make(8).issues[0]!.code).toBe("EXTERNAL_POWER_PLACEMENT_UNSUPPORTED");
    const result = make(9);
    expect(result.issues).toEqual([]);
    expect(Math.abs(result.flags[0]!.x - geometry.pins.get("J1:1")!.x)).toBeCloseTo(25.4, 8);
  });

  it("uses one nonrefundable budget for the initial plan, every suffix, and every complete flag retry", () => {
    const f = terminalPowerFixture(), work = createFreshSchematicPlanningWork(), before = JSON.stringify({ ...f.input, pins: [...f.input.pins] });
    expect(f.run(work).issues).toEqual([]);
    const consumed = work.budget.snapshot().consumed;
    const limited = createFreshSchematicPlanningWork(new FreshSchematicWorkBudget(consumed - 1)), result = f.run(limited);
    expect(result).toMatchObject({ wires: [], labels: [], routes: [], flags: [], issues: [{ code: "PLANNING_WORK_LIMIT" }] });
    expect(limited.budget.snapshot()).toMatchObject({ status: "exhausted", consumed: consumed - 1, remaining: 0 });
    expect(f.run(createFreshSchematicPlanningWork(new FreshSchematicWorkBudget(consumed))).issues).toEqual([]);
    expect(JSON.stringify({ ...f.input, pins: [...f.input.pins] })).toBe(before);
  });

  it.each([0, 4])("fails closed when the extra continuation budget %s exhausts during anchor lookup or suffix truncation", extra => {
    const f = terminalPowerFixture(), initial = new FreshSchematicWorkBudget();
    expect(createFreshTerminalLabelPlanningSession(f.input, initial).plan.issues).toEqual([]);
    // Two singleton functional groups precede/contain J1:1: four lookup units.
    // Its own choice and one later group require two suffix-removal units.
    const budget = new FreshSchematicWorkBudget(initial.snapshot().consumed + extra), session = createFreshTerminalLabelPlanningSession(f.input, budget);
    expect(session.plan.issues).toEqual([]);
    expect(session.retryDeclaredPowerAnchor("J1:1")).toMatchObject({ wires: [], labels: [], routes: [], issues: [{ code: "PLANNING_WORK_LIMIT" }] });
    expect(budget.snapshot()).toMatchObject({ status: "exhausted", remaining: 0,
      exhaustion: { kind: extra === 0 ? "terminal_group" : "label", requested: 2, remaining: 0 } });
  });

  it("fails closed with no partial labels, wires, or flags when all bounded anchor choices remain blocked", () => {
    const f = terminalPowerFixture(), work = createFreshSchematicPlanningWork();
    f.input.boxes.push({ reference: "@upper-body", minX: 95, maxX: 180, minY: 40, maxY: 97.3 });
    expect(planFreshTerminalGlobalLabels(f.input).issues).toEqual([]);
    expect(f.run(work)).toMatchObject({ wires: [], labels: [], routes: [], flags: [], issues: [{ code: "EXTERNAL_POWER_PLACEMENT_UNSUPPORTED" }] });
    expect(work.budget.snapshot().status).toBe("available");
    expect(work.budget.snapshot().consumed).toBeLessThan(1_000_000);
  });

  it("only advances declared anchors, keeps promoted floors on earlier-anchor retry, and isolates private state", () => {
    const f = terminalPowerFixture(), session = createFreshTerminalLabelPlanningSession(f.input);
    expect(session.retryDeclaredPowerAnchor("J1:2")).toBeNull();
    expect(session.retryDeclaredPowerAnchor("FOREIGN:1")).toBeNull();
    const first = session.retryDeclaredPowerAnchor("J1:1")!;
    const promoted = first.labels.find(label => label.endpointId === "J1:1")!.at.x;
    const originalPrefix = structuredClone(first.labels[0]!);
    Object.assign(first.labels[0]!.at, { x: 999 }); Object.assign(first.labels[0]!.bounds, { minX: 999 });
    (first.wires[0]!.edgeEndpoints as string[])[0] = "INJECTED";
    f.input.pins.set("A1:1", { x: 999, y: 999, angleDeg: 180 });
    Object.assign(f.input.boxes[0]!, { minX: -999, maxX: 999 }); Object.assign(f.input.sheet, { maxX: 0 });
    const second = session.retryDeclaredPowerAnchor("J1:1")!;
    expect(second.labels[0]).toEqual(originalPrefix);
    expect(second.wires[0]!.edgeEndpoints).toEqual(["A1:1"]);
    const later = session.retryDeclaredPowerAnchor("A1:1")!;
    expect(later.labels.find(label => label.endpointId === "J1:1")!.at.x).toBeGreaterThanOrEqual(second.labels.find(label => label.endpointId === "J1:1")!.at.x);
    expect(later.labels.find(label => label.endpointId === "J1:1")!.at.x).toBeGreaterThan(promoted);
  });

  it("propagates flag source assertion failures without turning them into geometry retries", () => {
    const f = terminalPowerFixture();
    const resolver = { ...f.resolver, inspectExternalPowerFlag: () => { throw new Error("flag source changed"); } };
    expect(() => planFreshTerminalGlobalLabelsAndPower(f.input, resolver, createFreshSchematicPlanningWork())).toThrow("flag source changed");
  });
});

/** Synthetic complete source/live metadata; production obtains this partition from its source adapter. */
function stackedFixture(nonRepresentativeAnchor = false, source = sourceIdentity, wrongContract = false) {
  const input = fixture(), contract = structuredClone(input.contract);
  Object.assign(contract.nets[0]!, { endpoints: [...contract.nets[0]!.endpoints, { reference: "J1", pin: "3" }] });
  Object.assign(contract.nets[1]!, { endpoints: [...contract.nets[1]!.endpoints, { reference: "J1", pin: "4" }] });
  const stackedPins = new Map([...pins, ["J1:3", { ...pins.get("J1:1")! }] as const, ["J1:4", { ...pins.get("J1:2")! }] as const]);
  if (nonRepresentativeAnchor) {
    const binding = structuredClone(contract.externalPowerBinding!) as any;
    binding.flags[0].anchorEndpoint.pin = "3";
    const { identity: _identity, ...payload } = binding;
    binding.identity = canonicalIdentity(payload, binding.schemaVersion);
    Object.assign(contract, { externalPowerBinding: binding });
  }
  const { identity: _identity, ...payload } = contract;
  Object.assign(contract, { identity: canonicalIdentity(payload, contract.schemaVersion) });
  const grouped = buildSchematicTerminalGroups({
    contractIdentity: wrongContract ? canonicalIdentity({ other: true }, "test.other-contract.v1") : contract.sourceContractIdentity,
    components: [{ reference: "J1", symbolLibId: "Test:Connector", unit: 1, sourceIdentity: source,
      placement: { at: { xMm: 0, yMm: 0 }, rotationDeg: 0 },
      pins: [...stackedPins].map(([id, point]) => ({ number: id.split(":")[1]!, at: { xMm: point.x, yMm: -point.y }, angleDeg: point.angleDeg })) }],
    assignments: contract.nets.flatMap(net => net.endpoints.map(endpoint => ({ ...endpoint, assignment: { kind: "net" as const, net: net.name } }))),
    livePins: [...stackedPins].map(([id, point]) => ({ reference: "J1", pin: id.split(":")[1]!, at: { xMm: point.x, yMm: point.y }, angleDeg: point.angleDeg })),
  });
  if (grouped.status !== "complete") throw new Error(JSON.stringify(grouped));
  const runStack = (partition: FreshSchematicTerminalPartition | undefined = grouped.value) => planFreshExternalPowerGeometry(
    contract, plan, stackedPins, boxes, input.resolver, createFreshSchematicPlanningWork(), sourceIdentity, input.style, undefined, partition,
  );
  return { ...input, contract, pins: stackedPins, partition: grouped.value, run: runStack };
}

function cardinalFixture(angleDeg: 0 | 90 | 180 | 270) {
  const origin = pins.get("J1:1")!;
  const rotate = (point: { x: number; y: number }) => {
    const x = point.x - origin.x, y = point.y - origin.y;
    const delta = angleDeg === 0 ? { x, y } : angleDeg === 90 ? { x: y, y: -x }
      : angleDeg === 180 ? { x: -x, y: -y } : { x: -y, y: x };
    return { x: Number((origin.x + delta.x).toFixed(6)), y: Number((origin.y + delta.y).toFixed(6)) };
  };
  const rotateBox = (box: { minX: number; maxX: number; minY: number; maxY: number }) => {
    const corners = [rotate({ x: box.minX, y: box.minY }), rotate({ x: box.maxX, y: box.maxY })];
    return { minX: Math.min(...corners.map(point => point.x)), maxX: Math.max(...corners.map(point => point.x)),
      minY: Math.min(...corners.map(point => point.y)), maxY: Math.max(...corners.map(point => point.y)) };
  };
  const rotatedPlan: PhysicalPlan = { ...plan,
    wires: plan.wires.map(wire => { const start = rotate(wire), end = rotate({ x: wire.endX, y: wire.endY });
      return { ...wire, ...start, endX: end.x, endY: end.y }; }),
    labels: plan.labels.map(label => ({ ...label, at: rotate(label.at), bounds: rotateBox(label.bounds),
      rotationDeg: ((label.rotationDeg + 360 - angleDeg) % 360) as 0 | 90 | 180 | 270 })),
  };
  return { plan: rotatedPlan, pins: new Map([...pins].map(([id, pin]) => [id, { ...rotate(pin), angleDeg }])),
    boxes: boxes.map(box => ({ ...box, ...rotateBox(box) })) };
}

function runCardinal(angleDeg: 0 | 90 | 180 | 270, work = createFreshSchematicPlanningWork(),
  obstacles: readonly typeof boxes[number][] = []) {
  const input = fixture(), geometry = cardinalFixture(angleDeg);
  return { ...geometry, result: planFreshExternalPowerGeometry(input.contract, geometry.plan, geometry.pins,
    [...geometry.boxes, ...obstacles], input.resolver, work, sourceIdentity, input.style) };
}

// Independent closed rectangle/segment intersection assertion for this axis-aligned fixture.
const touches = (wire: PhysicalPlan["wires"][number], rect: { minX: number; maxX: number; minY: number; maxY: number }) =>
  Math.max(Math.min(wire.x, wire.endX), rect.minX) <= Math.min(Math.max(wire.x, wire.endX), rect.maxX)
  && Math.max(Math.min(wire.y, wire.endY), rect.minY) <= Math.min(Math.max(wire.y, wire.endY), rect.maxY);
const reaches = (wires: PhysicalPlan["wires"], from: { x: number; y: number }, to: { x: number; y: number }) => {
  const reached = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [index, wire] of wires.entries()) {
      if (reached.has(index)) continue;
      if (touches(wire, { minX: from.x, maxX: from.x, minY: from.y, maxY: from.y })
        || [...reached].some(other => {
          const previous = wires[other]!;
          return touches(wire, { minX: Math.min(previous.x, previous.endX), maxX: Math.max(previous.x, previous.endX),
            minY: Math.min(previous.y, previous.endY), maxY: Math.max(previous.y, previous.endY) });
        })) { reached.add(index); changed = true; }
    }
  }
  return [...reached].some(index => touches(wires[index]!, { minX: to.x, maxX: to.x, minY: to.y, maxY: to.y }));
};

describe("bounded source-qualified external power branch planning", () => {
  it("replays exact source-qualified flags against their own current native value ink without exempting foreign ink", () => {
    const input = fixture(), first = run(input);
    const flags = first.flags.map(flag => ({ ...flag, library: "power", symbol: "PWR_FLAG", value: "PWR_FLAG", unit: 1, sourceIdentity }));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300mm" height="200mm" viewBox="0 0 300 200"><g fill="none" stroke="black" stroke-width="0.1524" stroke-linecap="round" stroke-linejoin="round">${flags.map(flag => {
      const x = flag.x - 2, y = flag.y - 5.08;
      return `<text x="${x}" y="${y}" opacity="0">PWR_FLAG</text><g class="stroked-text"><desc>PWR_FLAG</desc><path d="M${x} ${y} L${x + 4} ${y}"/></g>`;
    }).join("")}</g></svg>`;
    const style = syntheticStyle(svg);
    const glyphs = style.nativeText.bounds.map(ink => ({ reference: `@native-text:${ink.textGroupIndex}`,
      minX: ink.minX, maxX: ink.maxX, minY: ink.minY, maxY: ink.maxY,
      nativeText: { kind: "glyph" as const, svgIdentity: style.nativeSvgIdentity, groupIndex: ink.textGroupIndex, text: ink.text, coveringLabel: null } }));
    const replay = (obstacles = glyphs, existing = flags) => planFreshExternalPowerGeometry(input.contract, plan, pins, [...boxes, ...obstacles],
      input.resolver, createFreshSchematicPlanningWork(), sourceIdentity, style, undefined, undefined, existing);
    expect(replay().issues).toEqual([]); expect(replay().flags).toEqual(first.flags); expect(replay().wires).toEqual(first.wires);
    const foreign = { ...glyphs[0]!, reference: "@foreign", nativeText: { ...glyphs[0]!.nativeText, text: "FOREIGN" } };
    expect(replay([...glyphs, foreign]).issues.some(issue => issue.code === "EXTERNAL_POWER_PLACEMENT_UNSUPPORTED")).toBe(true);
    const duplicate = { ...glyphs[0]!, reference: "@duplicate", nativeText: { ...glyphs[0]!.nativeText, groupIndex: 999 } };
    expect(replay([...glyphs, duplicate]).issues.some(issue => issue.code === "EXTERNAL_POWER_PLACEMENT_UNSUPPORTED")).toBe(true);
    expect(() => replay(glyphs, flags.map(flag => ({ ...flag, sourceIdentity: contentIdentity("stale") })))).toThrow(/current source-qualified/u);
  });
  it.each([false, true])("allows only the exact qualified anchor stack, including nonrepresentative anchor=%s", nonRepresentative => {
    const input = stackedFixture(nonRepresentative), before = JSON.stringify({ contract: input.contract, pins: [...input.pins], partition: input.partition });
    const without = planFreshExternalPowerGeometry(input.contract, plan, input.pins, boxes, input.resolver,
      createFreshSchematicPlanningWork(), sourceIdentity, input.style);
    expect(without.issues.some(issue => issue.code === "EXTERNAL_POWER_PLACEMENT_UNSUPPORTED")).toBe(true);
    const result = input.run();
    expect(result.issues).toEqual([]);
    expect(result.flags).toEqual(run().flags);
    expect(result.wires.slice(0, plan.wires.length)).toEqual(plan.wires);
    expect(result.routes).toEqual(plan.routes);
    expect(result.labels).toEqual(plan.labels);
    expect(result.wires.every(wire => wire.x !== wire.endX || wire.y !== wire.endY)).toBe(true);
    expect(JSON.stringify({ contract: input.contract, pins: [...input.pins], partition: input.partition })).toBe(before);
  });
  it.each(["source", "contract"])("rejects a stack qualified for different %s evidence", kind => {
    const input = stackedFixture(false, kind === "source" ? contentIdentity("different saved source") : sourceIdentity, kind === "contract");
    expect(input.run().issues.some(issue => issue.code === "EXTERNAL_POWER_PLACEMENT_UNSUPPORTED")).toBe(true);
  });
  it.each(["foreign-net", "off-anchor", "angle", "unrelated-same-net", "nearby-same-net"])("keeps %s terminals as collisions", kind => {
    const input = stackedFixture(), anchor = input.pins.get("J1:1")!;
    if (kind === "foreign-net") {
      Object.assign(input.contract.nets[0]!, { endpoints: [{ reference: "J1", pin: "1" }] });
      Object.assign(input.contract.nets[1]!, { endpoints: [...input.contract.nets[1]!.endpoints, { reference: "J1", pin: "3" }] });
    } else if (kind === "off-anchor") input.pins.set("J1:3", { ...anchor, x: anchor.x - 0.635 });
    else if (kind === "angle") Object.assign(input.pins.get("J1:3")!, { angleDeg: 180 });
    else {
      const point = kind === "nearby-same-net" ? { ...anchor, x: anchor.x - 0.635 } : { ...anchor };
      input.pins.set("J2:1", point);
      Object.assign(input.contract.nets[0]!, { endpoints: [...input.contract.nets[0]!.endpoints, { reference: "J2", pin: "1" }] });
    }
    const result = input.run();
    expect(result.issues.some(issue => issue.code === "EXTERNAL_POWER_PLACEMENT_UNSUPPORTED")).toBe(true);
    expect(result.flags).toEqual([]);
  });
  it("places two distinct flags without passing either branch through same-net label text", () => {
    const before = JSON.stringify({ plan, pins: [...pins], boxes });
    const result = run();
    expect(result.issues).toEqual([]);
    expect(result.flags).toEqual([
      { reference: "#FLG001", x: 92.71, y: 66.04, rotation: 0 },
      { reference: "#FLG002", x: 92.71, y: 96.52, rotation: 0 },
    ]);
    expect(result.flags.map(flag => flag.reference)).toEqual(["#FLG001", "#FLG002"]);
    expect(new Set(result.flags.map(flag => `${flag.x}:${flag.y}`)).size).toBe(2);
    expect(result.wires.slice(0, plan.wires.length)).toEqual(plan.wires);
    expect(result.routes).toEqual(plan.routes);
    expect(result.labels).toEqual(plan.labels);
    const branches = result.wires.slice(plan.wires.length);
    expect(branches.length).toBeGreaterThan(0);
    for (const wire of branches) {
      expect(wire.x === wire.endX || wire.y === wire.endY).toBe(true);
      for (const label of plan.labels) expect(touches(wire, label.bounds)).toBe(false);
      for (const box of boxes) expect(touches(wire, box)).toBe(false);
    }
    for (const [index, flag] of result.flags.entries()) {
      expect(flag.rotation).toBe(0);
      expect(flag.x).toBeLessThan(96.52);
      expect(flag.y).not.toBe([76.2, 86.36][index]);
      expect(flag.x / 1.27).toBeCloseTo(Math.round(flag.x / 1.27), 8);
      expect(flag.y / 1.27).toBeCloseTo(Math.round(flag.y / 1.27), 8);
      expect(branches.some(wire => wire.net === ["SUPPLY_A", "SUPPLY_B"][index]
        && wire.endX === flag.x && wire.endY === flag.y)).toBe(true);
      expect(reaches(result.wires.filter(wire => wire.net === ["SUPPLY_A", "SUPPLY_B"][index]),
        pins.get(`J1:${index + 1}`)!, flag)).toBe(true);
    }
    expect(JSON.stringify({ plan, pins: [...pins], boxes })).toBe(before);
  });

  it.each([0, 90, 180, 270] as const)("connects flags from %i-degree terminals while preserving the exact escape direction", angleDeg => {
    const { result, plan: physical, pins: terminals, boxes: bodies } = runCardinal(angleDeg);
    expect(result.issues).toEqual([]);
    expect(result.flags).toHaveLength(2);
    expect(result.wires.slice(0, physical.wires.length)).toEqual(physical.wires);
    expect(result.labels).toEqual(physical.labels);
    expect(runCardinal(angleDeg).result).toEqual(result);
    const direction = angleDeg === 0 ? { x: -1, y: 0 } : angleDeg === 90 ? { x: 0, y: 1 }
      : angleDeg === 180 ? { x: 1, y: 0 } : { x: 0, y: -1 };
    for (const [index, flag] of result.flags.entries()) {
      const anchor = terminals.get(`J1:${index + 1}`)!;
      expect(flag.rotation).toBe(0);
      for (const value of [flag.x, flag.y]) expect(value / 1.27).toBeCloseTo(Math.round(value / 1.27), 8);
      const netWires = result.wires.filter(wire => wire.net === ["SUPPLY_A", "SUPPLY_B"][index]);
      expect(reaches(netWires, anchor, flag)).toBe(true);
      const escapes = netWires.filter(wire => wire.x === anchor.x && wire.y === anchor.y);
      expect(escapes.length).toBeGreaterThan(0);
      for (const wire of escapes) {
        const delta = { x: wire.endX - anchor.x, y: wire.endY - anchor.y };
        expect(delta.x * direction.y - delta.y * direction.x).toBe(0);
        expect(delta.x * direction.x + delta.y * direction.y).toBeGreaterThan(0);
      }
      if (angleDeg === 90) {
        const incoming = netWires.find(wire => wire.endX === flag.x && wire.endY === flag.y)!;
        expect(incoming).toBeDefined();
        expect(incoming.y).toBe(flag.y);
        expect(incoming.x).not.toBe(flag.x);
      }
      const drawing = { minX: flag.x - 6.35, maxX: flag.x + 6.35, minY: flag.y - 6.985, maxY: flag.y - 0.635 };
      for (const wire of result.wires) expect(touches(wire, drawing)).toBe(false);
    }
    for (const wire of result.wires.slice(physical.wires.length)) {
      expect(wire.x === wire.endX || wire.y === wire.endY).toBe(true);
      expect(Math.abs(wire.endX - wire.x) + Math.abs(wire.endY - wire.y)).toBeGreaterThan(0);
      for (const value of [wire.x, wire.y, wire.endX, wire.endY]) expect(value / 1.27).toBeCloseTo(Math.round(value / 1.27), 8);
      for (const label of physical.labels) expect(touches(wire, label.bounds)).toBe(false);
      for (const box of bodies) expect(touches(wire, box)).toBe(false);
      for (const [id, pin] of terminals) if (!wire.edgeEndpoints.includes(id)) {
        expect(touches(wire, { minX: pin.x, maxX: pin.x, minY: pin.y, maxY: pin.y })).toBe(false);
      }
      for (const other of result.wires) if (other.net !== wire.net) {
        expect(touches(wire, { minX: Math.min(other.x, other.endX), maxX: Math.max(other.x, other.endX),
          minY: Math.min(other.y, other.endY), maxY: Math.max(other.y, other.endY) })).toBe(false);
      }
    }
  });

  it("rejects obstructed 90-degree fallback placements without returning new geometry", () => {
    const obstruction = { reference: "BLOCK", minX: 15.24, maxX: 279.4, minY: 15.24, maxY: 195.58 };
    const { result, plan: physical } = runCardinal(90, createFreshSchematicPlanningWork(), [obstruction]);
    expect(result.flags).toEqual([]);
    expect(result.wires).toEqual(physical.wires);
    expect(result.issues).toEqual([expect.objectContaining({ code: "EXTERNAL_POWER_PLACEMENT_UNSUPPORTED", endpoints: ["J1:1"] })]);
  });

  it("discards the partial fallback plan when the shared work budget is exhausted", () => {
    const fullWork = createFreshSchematicPlanningWork();
    expect(runCardinal(90, fullWork).result.issues).toEqual([]);
    const required = fullWork.budget.snapshot().consumed;
    const limitedWork = createFreshSchematicPlanningWork(new FreshSchematicWorkBudget(required - 1));
    const { result, plan: physical } = runCardinal(90, limitedWork);
    expect(limitedWork.budget.snapshot()).toMatchObject({ status: "exhausted", consumed: required - 1, remaining: 0 });
    expect(result.flags).toEqual([]);
    expect(result.wires).toEqual(physical.wires);
    expect(result.issues).toEqual([expect.objectContaining({ code: "PLANNING_WORK_LIMIT" })]);
  });

  it("rejects current library drift even when the replacement inspection is internally consistent", () => {
    const input = fixture();
    const changed = syntheticInspection(librarySource(defaultGraphic.replace("1.016", "1.017")));
    const resolver = { ...input.resolver, inspectExternalPowerFlag: () => changed };
    expect(() => run({ ...input, resolver })).toThrow(/changed from the compilation binding/u);
  });

  it("returns an unresolved result when native stroke evidence is missing", () => {
    const input = fixture();
    const result = planFreshExternalPowerGeometry(input.contract, plan, pins, boxes, input.resolver, createFreshSchematicPlanningWork(), sourceIdentity);
    expect(result.flags).toEqual([]);
    expect(result.wires).toEqual(plan.wires);
    expect(result.issues).toEqual([expect.objectContaining({ code: "EXTERNAL_POWER_STYLE_UNAVAILABLE" })]);
  });

  it("does not turn oversized source graphics into a normal flag envelope", () => {
    const huge = '(rectangle (start -10 0) (end 10 2.54) (stroke (width 0) (type default)) (fill (type none)))';
    const result = run(fixture(librarySource(huge)));
    expect(result.flags).toEqual([]);
    expect(result.wires).toEqual(plan.wires);
    expect(result.issues).toEqual([expect.objectContaining({ code: "EXTERNAL_POWER_GEOMETRY_UNSUPPORTED" })]);
  });

  it("reports fully obstructed space without inventing a partial flag placement", () => {
    const obstruction = { reference: "BLOCK", minX: 15.24, maxX: 279.4, minY: 15.24, maxY: 195.58 };
    const result = run(fixture(), [...boxes, obstruction]);
    expect(result.flags).toEqual([]);
    expect(result.wires).toEqual(plan.wires);
    expect(result.issues).toEqual([expect.objectContaining({ code: "EXTERNAL_POWER_PLACEMENT_UNSUPPORTED", endpoints: ["J1:1"] })]);
  });

  it("rejects branded style evidence from a different schematic source", () => {
    const input = fixture();
    expect(() => planFreshExternalPowerGeometry(input.contract, plan, pins, boxes, input.resolver,
      createFreshSchematicPlanningWork(), contentIdentity("different schematic"), input.style)).toThrow(/stale/u);
  });

  it("preserves the legacy plan when no external power binding is present", () => {
    const { externalPowerBinding, ...contract } = fixture().contract;
    expect(externalPowerBinding).toBeDefined();
    const result = planFreshExternalPowerGeometry(contract, plan, pins, boxes, undefined, createFreshSchematicPlanningWork(), sourceIdentity);
    expect(result).toEqual({ ...plan, flags: [] });
  });
});

const temporaryPrefix = "evleda-external-power-gate-";
const temporaryRoots = new Set<string>();
afterEach(async () => {
  for (const root of temporaryRoots) {
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(temporaryPrefix)) {
      throw new Error("Refusing cleanup outside the exact temporary harness fixture roots.");
    }
    await rm(resolved, { recursive: true, force: true });
    temporaryRoots.delete(root);
  }
});

describe("offline external power native capability preflight", () => {
  it.each(["missing", "false"] as const)("blocks a %s graph capability before any native dispatch", async capability => {
    const inspection = syntheticInspection();
    const resolver = { ...genericDividerLibraryResolver, inspectExternalPowerFlag: () => inspection };
    const dependencies = { libraryResolver: resolver, deepRuleCatalog: loadDeepRuleCatalog() };
    const base = planeDividerDraft();
    const draft = { ...base, nets: base.nets.map(net => net.name === "VIN" ? { ...net, role: "power_input" } : net),
      externalPowerInputs: [{ id: "SUPPLY", supplyEndpoint: { reference: "J1", pin: "1" }, returnEndpoint: { reference: "J1", pin: "3" } }],
    };
    const compilation = compilePcbPlaneDesignIntentDraft(draft, dependencies);
    if (compilation.disposition !== "ready") throw new Error(JSON.stringify(compilation.issues));
    const bundle = createPcbPlaneCompilationBundle({ compilation, originalPrompt: "Synthetic external-power capability gate fixture." }, dependencies);
    expect(bundle.externalPowerBinding?.flags).toHaveLength(2);
    const root = await mkdtemp(path.join(os.tmpdir(), temporaryPrefix));
    temporaryRoots.add(root);
    const project = await preparePlaneFreshProject({ outputDir: path.join(root, "output"), name: "power-gate", resume: false,
      compilationBundle: bundle, compilationBundleRef: createPcbPlaneCompilationBundleRef(bundle),
    });
    const dispatched: string[] = [];
    const unexpectedObservations: string[] = [];
    const session: KicadHarnessSession = {
      listTools: () => KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES.map(name => ({
        name, permission: "write" as const, inputSchema: { type: "object", additionalProperties: true },
      })),
      ...(capability === "false" ? { supportsExternalPowerFlagConnectivity: () => false } : {}),
      assertActivePcb: async expected => { expect(expected).toBe(project.pcbPath); },
      readActivePcbSource: async expected => {
        expect(expected).toBe(project.pcbPath);
        return readFile(project.pcbPath, "utf8");
      },
      readLivePcbPadSnapshot: async () => {
        unexpectedObservations.push("native pad snapshot");
        throw new Error("The capability gate must precede native pad collection.");
      },
      callTool: async name => {
        dispatched.push(name);
        throw new Error(`The capability gate must precede native dispatch: ${name}`);
      },
    };
    const physicalSource = (libraryId: string) => contentIdentity(`synthetic constructor-only footprint source ${libraryId}`);
    type FootprintInspection = NonNullable<ReturnType<NonNullable<KicadHarnessToolsOptions["freshPhysicalFootprintResolver"]>["inspectFootprint"]>>;
    const tools = createKicadHarnessTools(session, {
      freshProject: project, freshConnectivityContract: bundle.contract, freshPlaneCompilationBundle: bundle, freshLibraryResolver: resolver,
      // This constructor-only source identity cannot authorize physical pad collection.
      freshPhysicalFootprintResolver: { inspectFootprint: libraryId => ({ libraryId, sourceIdentity: physicalSource(libraryId) } as FootprintInspection) },
      freshPhysicalFootprintSourcePins: bundle.contract.components.map(component => ({
        reference: component.reference, libraryId: component.footprintLibId, sourceIdentity: physicalSource(component.footprintLibId),
      })),
      captureFreshNativeNetlist: async () => {
        unexpectedObservations.push("native netlist");
        throw new Error("The capability gate must precede native netlist capture.");
      },
      capturePersistedMutationBaseline: async () => contentIdentity(await readFile(project.pcbPath)).digest,
      verifyPersistedMutation: async () => false,
    });
    const result = await tools.execute({ id: `external-power-${capability}`, name: "fresh_apply_contract_connectivity", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({ applied: false, mutated: false,
      issues: [{ code: "EXTERNAL_POWER_CONNECTIVITY_CAPABILITY_UNAVAILABLE" }],
    });
    expect(dispatched).toEqual([]);
    expect(unexpectedObservations).toEqual([]);
  });
});
