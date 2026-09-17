import path from "node:path";
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { createFreshConnectivityContract } from "../../src/harness/fresh-connectivity-contract.js";
import { createFreshSchematicPlanningWork, planFreshExternalPowerGeometry, createKicadHarnessTools,
  KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES, type KicadHarnessSession, type KicadHarnessToolsOptions } from "../../src/harness/kicad-tools.js";
import { preparePlaneFreshProject } from "../../src/harness/fresh-project.js";
import { createPcbPlaneCompilationBundleRef } from "../../src/harness/pcb-design-plane-bundle.js";
import { FreshSchematicWorkBudget } from "../../src/harness/fresh-schematic-work-budget.js";
import { createFreshSchematicStrokeStyleEvidence, FRESH_SCHEMATIC_STROKE_NATIVE_PROFILE as profile,
  type FreshSchematicStrokeStyleCapture } from "../../src/harness/fresh-schematic-stroke-style.js";
import { cleanupDerivedPowerFixtures, derivedPowerDraft, derivedPowerFixture } from "../helpers/derived-power-bundle.js";

// Pure synthetic geometry/style/source fixtures; no native or physical proof.
const sourceIdentity = contentIdentity("synthetic derived annotation plan");
function syntheticStyle() {
  const cwd = path.resolve("D:/owned-derived-style/project"), output = path.resolve("D:/owned-derived-style/render");
  const executablePath = path.resolve("D:/pinned-runtime/kicad-cli.exe"), projectSettingsSource = "{}", applicationSource = "{}";
  const sourceIdentities = { schematic: sourceIdentity, pcb: contentIdentity("synthetic PCB"), projectSettings: contentIdentity(projectSettingsSource) };
  const executable = { kind: "kicad-cli" as const, path: executablePath, version: profile.version, commit: "a".repeat(40),
    sha256: profile.executable.digest, sizeBytes: profile.executable.size, capabilityHelpSha256: "b".repeat(64), confirmedCapabilities: ["sch export svg"] };
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>', svgIdentity = contentIdentity(svg), configIdentity = contentIdentity(applicationSource);
  const tree = canonicalIdentity({ schemaVersion: "evleda.kicad-schematic-configuration-tree.v1",
    files: [{ relativePath: "10.0/eeschema.json", identity: configIdentity }], directories: ["10.0"] }, "evleda.kicad-schematic-configuration-tree.v1");
  const capture: FreshSchematicStrokeStyleCapture = {
    render: { classification: "candidate-validation", releaseAuthorized: false, executable, outputDirectory: output,
      sourceHashes: { "test.kicad_sch": sourceIdentity.digest }, sourceIdentities,
      invocation: { executable, command: executablePath,
        args: ["sch", "export", "svg", "--output", output, "--black-and-white", "--exclude-drawing-sheet", "--no-background-color", path.join(cwd, "test.kicad_sch")],
        cwd, exitCode: 0, stdout: "", stderr: "", durationMs: 1, startedAt: "2026-09-09T12:00:00.000Z" },
      schematicSvg: { path: path.join(output, "test.svg"), relativePath: "test.svg", sha256: svgIdentity.digest, sizeBytes: svgIdentity.size }, source: svg },
    projectSettingsSource,
    schematicEngine: { path: path.join(path.dirname(executablePath), "_eeschema.dll"), before: profile.schematicEngine, after: profile.schematicEngine },
    configuration: { isolation: "caller-owned-isolated", configHome: path.resolve("D:/owned-derived-style/config"), treeBefore: tree, treeAfter: tree,
      applicationConfig: { relativePath: "10.0/eeschema.json", source: applicationSource, before: configIdentity, after: configIdentity } },
  };
  return createFreshSchematicStrokeStyleEvidence(capture, sourceIdentities);
}
function planningFixture(draft = derivedPowerDraft()) {
  const fixture = derivedPowerFixture(draft), bundle = fixture.bundle;
  const contract = createFreshConnectivityContract(bundle.contract, bundle.externalPowerBinding, bundle.derivedPowerBinding);
  const binding = contract.derivedPowerBinding!;
  const references = [...new Set(binding.flags.map(flag => flag.anchorEndpoint.reference))];
  const pins = new Map(binding.flags.map((flag, index) => [`${flag.anchorEndpoint.reference}:${flag.anchorEndpoint.pin}`,
    { x: 101.6 + references.indexOf(flag.anchorEndpoint.reference) * 50.8, y: 50.8 + index * 25.4, angleDeg: 0 as const }]));
  const boxes = references.map(reference => {
    const anchors = binding.flags.filter(flag => flag.anchorEndpoint.reference === reference).map(flag => pins.get(`${reference}:${flag.anchorEndpoint.pin}`)!);
    return { reference, minX: anchors[0]!.x + 2.54, maxX: anchors[0]!.x + 10.16,
      minY: Math.min(...anchors.map(pin => pin.y)) - 3.81, maxY: Math.max(...anchors.map(pin => pin.y)) + 3.81 };
  });
  const plan: Parameters<typeof planFreshExternalPowerGeometry>[1] = { routes: ["physical routes unchanged"], issues: [], labels: [],
    wires: [{ x: 25.4, y: 25.4, endX: 38.1, endY: 25.4, net: "SW", edgeEndpoints: ["U1:3", "L1:1"] }] };
  const style = syntheticStyle();
  const run = (work = createFreshSchematicPlanningWork()) => planFreshExternalPowerGeometry(contract, plan, pins, boxes, fixture.resolver, work,
    sourceIdentity, style, bundle.libraryBinding);
  return { ...fixture, contract, binding, pins, boxes, plan, style, run };
}
afterEach(cleanupDerivedPowerFixtures);

describe("combined derived power annotation planning", () => {
  it("plans one inventory preserving external references, shared return deduplication, and every physical route", () => {
    const fixture = planningFixture(), before = JSON.stringify({ contract: fixture.contract, plan: fixture.plan, pins: [...fixture.pins], boxes: fixture.boxes });
    const result = fixture.run();
    expect(result.issues).toEqual([]);
    expect(result.flags.map(flag => flag.reference)).toEqual(fixture.binding.flags.map(flag => flag.reference));
    expect(fixture.binding.flags.slice(0, fixture.bundle.externalPowerBinding!.flags.length)).toEqual(fixture.bundle.externalPowerBinding!.flags);
    expect(fixture.binding.flags.filter(flag => flag.net === "GND")).toHaveLength(1);
    expect(new Set(result.flags.map(flag => `${flag.x}:${flag.y}`)).size).toBe(result.flags.length);
    expect(result.wires.slice(0, fixture.plan.wires.length)).toEqual(fixture.plan.wires);
    expect(result.routes).toEqual(fixture.plan.routes);
    expect(result.labels).toEqual(fixture.plan.labels);
    for (const [index, placement] of result.flags.entries()) {
      const flag = fixture.binding.flags[index]!, endpoint = `${flag.anchorEndpoint.reference}:${flag.anchorEndpoint.pin}`;
      const anchor = fixture.pins.get(endpoint)!;
      const wires = result.wires.filter(wire => wire.net === flag.net);
      expect(wires.some(wire => wire.x === anchor.x && wire.y === anchor.y)).toBe(true);
      expect(wires.some(wire => wire.endX === placement.x && wire.endY === placement.y)).toBe(true);
      expect(placement.x / 1.27).toBeCloseTo(Math.round(placement.x / 1.27), 8);
      expect(placement.y / 1.27).toBeCloseTo(Math.round(placement.y / 1.27), 8);
      expect(placement.rotation).toBe(0);
    }
    expect(JSON.stringify({ contract: fixture.contract, plan: fixture.plan, pins: [...fixture.pins], boxes: fixture.boxes })).toBe(before);
  });

  it("plans derived-only rails without an external declaration", () => {
    const draft = derivedPowerDraft(); delete draft.externalPowerInputs;
    const fixture = planningFixture(draft), result = fixture.run();
    expect(fixture.contract.externalPowerBinding).toBeUndefined();
    expect(result.issues).toEqual([]);
    expect(result.flags).toHaveLength(3);
  });

  it("accepts source-qualified inductor and resistor anchors without requiring connectors", () => {
    const draft = derivedPowerDraft();
    draft.derivedPowerSources[0].supplyEndpoint = { reference: "L1", pin: "2" };
    draft.derivedPowerSources[1].supplyEndpoint = { reference: "R2", pin: "2" };
    const fixture = planningFixture(draft), result = fixture.run();
    expect(result.issues).toEqual([]);
    expect(fixture.binding.flags.some(flag => flag.anchorEndpoint.reference === "L1")).toBe(true);
    expect(fixture.binding.flags.some(flag => flag.anchorEndpoint.reference === "R2")).toBe(true);
  });

  it("requires the physical source binding and current complete approved symbols", () => {
    const fixture = planningFixture();
    expect(() => planFreshExternalPowerGeometry(fixture.contract, fixture.plan, fixture.pins, fixture.boxes,
      fixture.resolver, createFreshSchematicPlanningWork(), sourceIdentity, fixture.style)).toThrow(/physical library/u);
    writeFileSync(fixture.symbolFiles.Regulator_Switching!, fixture.librarySources.Regulator_Switching!.replace('(name "VIN"', '(name "DRIFT"'), "utf8");
    expect(() => fixture.run()).toThrow();
  });

  it("rejects a missing physical anchor instead of deriving it from a component origin", () => {
    const fixture = planningFixture(), anchor = fixture.binding.flags.at(-1)!.anchorEndpoint;
    fixture.pins.delete(`${anchor.reference}:${anchor.pin}`);
    expect(fixture.run().issues.some(issue => issue.code === "EXTERNAL_POWER_PLACEMENT_UNSUPPORTED")).toBe(true);
  });

  it("drops the incomplete annotation plan when the shared planning budget is exhausted", () => {
    const fixture = planningFixture();
    const result = fixture.run(createFreshSchematicPlanningWork(new FreshSchematicWorkBudget(1)));
    expect(result.flags).toEqual([]);
    expect(result.issues.some(issue => issue.code === "PLANNING_WORK_LIMIT")).toBe(true);
  });

  it.each(["missing", "false"] as const)("blocks derived-only authoring with %s graph authority before native dispatch", async capability => {
    const draft = derivedPowerDraft(); delete draft.externalPowerInputs;
    const fixture = derivedPowerFixture(draft), bundle = fixture.bundle;
    const project = await preparePlaneFreshProject({ outputDir: path.join(fixture.root, "output"), name: "derived-gate", resume: false,
      compilationBundle: bundle, compilationBundleRef: createPcbPlaneCompilationBundleRef(bundle) });
    const dispatched: string[] = [];
    const session: KicadHarnessSession = {
      listTools: () => KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES.map(name => ({ name, permission: "write" as const,
        inputSchema: { type: "object", additionalProperties: true } })),
      ...(capability === "false" ? { supportsExternalPowerFlagConnectivity: () => false } : {}),
      assertActivePcb: async expected => { expect(expected).toBe(project.pcbPath); },
      readActivePcbSource: async () => readFile(project.pcbPath, "utf8"),
      readLivePcbPadSnapshot: async () => { throw new Error("Unexpected native pad collection"); },
      callTool: async name => { dispatched.push(name); throw new Error(`Unexpected native dispatch: ${name}`); },
    };
    const physicalSource = (libraryId: string) => contentIdentity(`constructor-only physical mock ${libraryId}`);
    type FootprintInspection = NonNullable<ReturnType<NonNullable<KicadHarnessToolsOptions["freshPhysicalFootprintResolver"]>["inspectFootprint"]>>;
    const tools = createKicadHarnessTools(session, {
      freshProject: project, freshConnectivityContract: bundle.contract, freshPlaneCompilationBundle: bundle, freshLibraryResolver: fixture.resolver,
      freshPhysicalFootprintResolver: { inspectFootprint: libraryId => ({ libraryId, sourceIdentity: physicalSource(libraryId) } as FootprintInspection) },
      freshPhysicalFootprintSourcePins: bundle.contract.components.map(component => ({ reference: component.reference,
        libraryId: component.footprintLibId, sourceIdentity: physicalSource(component.footprintLibId) })),
      captureFreshNativeNetlist: async () => { throw new Error("Unexpected native netlist capture"); },
      capturePersistedMutationBaseline: async () => contentIdentity(await readFile(project.pcbPath)).digest,
      verifyPersistedMutation: async () => false,
    });
    // The normal session guard also permits its pristine empty source.
    await tools.assertExternalPowerAnnotationsCurrent!();
    const result = await tools.execute({ id: `derived-${capability}`, name: "fresh_apply_contract_connectivity", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({ applied: false, mutated: false,
      issues: [{ code: "EXTERNAL_POWER_CONNECTIVITY_CAPABILITY_UNAVAILABLE" }] });
    expect(dispatched).toEqual([]);
  });
});
