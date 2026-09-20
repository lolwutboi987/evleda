import { describe, expect, it } from "vitest";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import type { KicadCheckResult, KicadExecutableIdentity } from "../../src/integrations/kicad-cli.js";
import type { KicadPlaneContactsNativeReport } from "../../src/integrations/kicad-plane-contacts.js";
import { assessFreshPlaneNativeChecks, isFreshPlaneNativeChecksAssessment, type FreshPlaneNativeChecksInput } from "../../src/harness/fresh-plane-native-checks.js";
import { createSavedFreshPlaneEvidence } from "../../src/harness/fresh-plane-evidence.js";
import { validateFreshPlaneStageObservation } from "../../src/harness/fresh-plane-stage-observation.js";
import { prepareFreshPlaneMutation } from "../../src/harness/fresh-plane-mutation.js";
import { createFreshPlaneRules } from "../../src/harness/fresh-plane-rules.js";
import { derivePcbNativeNumericRules } from "../../src/harness/pcb-native-numeric-rules.js";
import { parseFreshPcbReferenceGeometry, parseFreshPcbSource } from "../../src/harness/fresh-kicad-parser.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { genericDividerLibraryResolver } from "../helpers/generic-divider-bundle.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";
import { planeStageObservationFixture } from "../helpers/plane-stage-observation-fixture.js";
import { withNativePadFixtureIds } from "../helpers/native-pad-observation-fixture.js";
import { createPlaneContactsFixture } from "../helpers/kicad-plane-contacts-fixture.js";
import { fourLayerPlaneBundle } from "../helpers/four-layer-plane-bundle.js";

// All reports in this suite are synthetic offline host-port fixtures, not native qualification.
const dependencies = { libraryResolver: genericDividerLibraryResolver, deepRuleCatalog: loadDeepRuleCatalog() };
const bundle = createPcbPlaneCompilationBundle({ originalPrompt: "Synthetic native plane-check policy fixture",
  compilation: compilePcbPlaneDesignIntentDraft(planeDividerDraft(), dependencies) }, dependencies);
const current = { projectBindingIdentity: canonicalIdentity({ fixture: "project" }, "evleda.test-project.v1"),
  sourceScopeIdentity: canonicalIdentity({ fixture: "scope" }, "evleda.test-scope.v1") };
const executable: KicadExecutableIdentity = { kind: "kicad-cli", path: "C:\\pinned-native\\kicad-cli.exe", version: "10.0.3",
  commit: "146a4f2a7585c65bc580427a19b6fe2ec4a3f622", sha256: "1".repeat(64), sizeBytes: 1234,
  capabilityHelpSha256: "2".repeat(64), confirmedCapabilities: ["pcb drc"] };
const boardSource = (padFields = "", footprintFields = "", extraPad = "") => withNativePadFixtureIds(`(kicad_pcb (version 20260206)
  (generator "pcbnew") (generator_version "10.0") (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
  (footprint "Test:J1" (layer "F.Cu") (at 2 2) (property "Reference" "J1") (property "Value" "TEST") ${footprintFields}
    (pad "3" thru_hole circle (at 0 0) (size 1.8 1.8) (drill 0.8) (layers "*.Cu") (net "GND") ${padFields}) ${extraPad})
  (footprint "Test:R2" (layer "F.Cu") (at 5 5) (property "Reference" "R2") (property "Value" "TEST")
    (pad "2" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "GND"))))\n`);
function projectSettings() {
  return { erc: { erc_exclusions: [], rule_severities: {
    single_global_label: "error", footprint_filter: "error", simulation_model_issue: "error", four_way_junction: "error",
  } } as { erc_exclusions: unknown[]; rule_severities: Record<string, string>; pin_map?: number[][] },
  board: { file: "fixture.kicad_pcb", design_settings: {
    rule_severities: { clearance: "error", hole_clearance: "error", hole_to_hole: "warning", holes_co_located: "warning", annular_width: "error", drill_out_of_range: "error", copper_edge_clearance: "error", shorting_items: "error", tracks_crossing: "error", zones_intersect: "error", unconnected_items: "error", starved_thermal: "error" },
    rules: { min_resolved_spokes: 2, max_error: 0.005 }, drc_exclusions: [] as unknown[],
  } } };
}
async function fixture(options: { padFields?: string; footprintFields?: string; project?: ReturnType<typeof projectSettings>;
  numericRules?: boolean; numericSettingsEdit?: (settings: Record<string, any>) => void;
  minimumSpokes?: number; rawPadOverride?: "global" | "layer"; extraPad?: string;
  rawPadZoneConnection?: { number: string; value: unknown }; fourLayer?: boolean } = {}): Promise<FreshPlaneNativeChecksInput> {
  const draft = planeDividerDraft();
  if (options.minimumSpokes !== undefined) draft.planes[0]!.padConnection.minimumConnectedSpokes = options.minimumSpokes;
  const compilationBundle = options.fourLayer ? fourLayerPlaneBundle() : options.minimumSpokes === undefined && !options.numericRules ? bundle : createPcbPlaneCompilationBundle({ originalPrompt: "Synthetic four-spoke rule fixture",
    compilation: compilePcbPlaneDesignIntentDraft({ ...draft, ...(options.numericRules ? { nativeRuleMode: "contract-derived-v1" } : {}) }, dependencies) }, dependencies);
  let before = boardSource(options.padFields, options.footprintFields, options.extraPad);
  if (options.fourLayer) before=before.replace('(0 "F.Cu" signal) (2 "B.Cu" signal)','(0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal)');
  const firstPlane=compilationBundle.contract.planes[0]!;
  let prepared = prepareFreshPlaneMutation({ compilationBundle, beforePcbSource: before, planeId:firstPlane.id, operation: "create" });
  let staged = await planeStageObservationFixture({ beforePcbSource: before, mutation: prepared.mutation });
  if (options.fourLayer) {
    prepared=prepareFreshPlaneMutation({compilationBundle,beforePcbSource:staged.stagedSource,planeId:compilationBundle.contract.planes[1]!.id,operation:"create"});
    staged=await planeStageObservationFixture({beforePcbSource:staged.stagedSource,mutation:prepared.mutation,beforeZoneProtos:[staged.stagedZoneProto],zoneId:"99999999-9999-4999-8999-999999999998"});
  }
  if (options.rawPadOverride !== undefined) {
    const padUuid = staged.receipt.padSnapshot.padRecords[0].id.value;
    const patch = (value: any): void => {
      if (value === null || typeof value !== "object") return;
      if (value.id?.value === padUuid && value.pad_stack) {
        const target = options.rawPadOverride === "global" ? value.pad_stack : value.pad_stack.copper_layers[0];
        target.zone_settings = { zone_connection: "ZCS_INHERITED", thermal_spokes: { gap: { value_nm: "100000" } } };
      }
      for (const child of Object.values(value)) patch(child);
    };
    patch(staged.receipt);
  }
  if (options.rawPadZoneConnection !== undefined) {
    const setting = options.rawPadZoneConnection;
    const padUuid = parseFreshPcbSource(before).footprints.flatMap(fp => fp.pads).find(pad => pad.number === setting.number)!.physical.id;
    const patch = (value: any): void => {
      if (value === null || typeof value !== "object") return;
      if (value.id?.value === padUuid && value.pad_stack) value.pad_stack.zone_settings = { zone_connection: setting.value };
      for (const child of Object.values(value)) patch(child);
    };
    patch(staged.receipt);
  }
  const stage = validateFreshPlaneStageObservation(staged.receipt, { ...staged, prepared });
  const projectRoot = "D:\\evleda-offline-pad-fixture", pcbPath = `${projectRoot}\\fixture.kicad_pcb`;
  const project = options.project ?? projectSettings(), numeric = derivePcbNativeNumericRules(compilationBundle.contract);
  if (numeric !== undefined) {
    Object.assign(project.board.design_settings.rules, numeric.boardRules);
    Object.assign(project.board.design_settings.rule_severities, numeric.requiredNativeCheckSeverities);
  }
  options.numericSettingsEdit?.(project);
  const projectSource = JSON.stringify(project), rulesSource = createFreshPlaneRules(compilationBundle).source;
  const sources = { projectRoot, pcbPath, pcbSource: staged.stagedSource,
    projectPath: `${projectRoot}\\fixture.kicad_pro`, projectSource, rulesPath: `${projectRoot}\\fixture.kicad_dru`, rulesSource };
  const savedEvidence = createSavedFreshPlaneEvidence({ compilationBundle, stage, ...current,
    savedPcbSource: sources.pcbSource, projectSettingsIdentity: contentIdentity(projectSource), rulesIdentity: contentIdentity(rulesSource) });
  const expectedSourceHashes = { "fixture.kicad_pcb": contentIdentity(sources.pcbSource).digest, "fixture.kicad_pro": contentIdentity(projectSource).digest,
    "fixture.kicad_dru": contentIdentity(rulesSource).digest, "fixture.kicad_sch": "3".repeat(64), "fp-lib-table": "4".repeat(64), "sym-lib-table": "5".repeat(64) };
  const reportPath = "D:\\evleda-offline-check-output\\drc.json";
  const invocation = { executable, command: executable.path, cwd: projectRoot, exitCode: 0, stdout: "Found 0 DRC violations\n", stderr: "",
    durationMs: 1, startedAt: "2026-09-10T00:00:00.000Z", args: ["pcb", "drc", "--output", reportPath, "--format", "json", "--units", "mm", "--severity-all",
      "--exit-code-violations", "--schematic-parity", pcbPath] };
  const report = { $schema: "https://schemas.kicad.org/drc.v1.json", coordinate_units: "mm", kicad_version: executable.version,
    source: "fixture.kicad_pcb", date: "2026-09-10T00:00:00.000Z", included_severities: ["error", "warning", "exclusion"],
    ignored_checks: [], violations: [], unconnected_items: [], schematic_parity: [] };
  const drc = { kind: "drc" as const, status: "clean" as const, reportPath, violationCount: 0, schematicParityCount: 0, invocation, report };
  const ercPath = "D:\\evleda-offline-check-output\\erc.json", schematicPath = `${projectRoot}\\fixture.kicad_sch`;
  const erc = { kind: "erc" as const, status: "clean" as const, reportPath: ercPath, violationCount: 0, schematicParityCount: 0,
    invocation: { ...invocation, stdout: "Found 0 ERC violations\n", args: ["sch", "erc", "--output", ercPath, "--format", "json", "--units", "mm",
      "--severity-all", "--exit-code-violations", schematicPath] },
    report: { $schema: "https://schemas.kicad.org/erc.v1.json", coordinate_units: "mm", kicad_version: executable.version,
      source: "fixture.kicad_sch", date: report.date, included_severities: ["error", "warning", "exclusion"], ignored_checks: [],
      sheets: [{ path: "/", uuid_path: "/11111111-1111-4111-8111-111111111111/", violations: [] }] } };
  const nativeChecks: KicadCheckResult = { classification: "candidate-validation", releaseAuthorized: false, executable,
    sourceHashes: expectedSourceHashes, drc, erc, clean: true };
  return { compilationBundle, savedEvidence, current, sources, expectedSourceHashes, expectedExecutable: executable, nativeChecks };
}
function changeNative(input: FreshPlaneNativeChecksInput, change: (native: any) => void): FreshPlaneNativeChecksInput {
  const nativeChecks = structuredClone(input.nativeChecks); change(nativeChecks); return { ...input, nativeChecks };
}

async function withContacts(input: FreshPlaneNativeChecksInput, change: (report: KicadPlaneContactsNativeReport) => void = () => {}): Promise<FreshPlaneNativeChecksInput> {
  const pcb = parseFreshPcbSource(input.sources.pcbSource), parsedZones = parseFreshPcbReferenceGeometry(input.sources.pcbSource).zones;
  const copperLayers=input.compilationBundle.contract.scope.board.copperLayers;
  const layerId=(name:string)=>{const ids:Record<string,number>={"F.Cu":0,"B.Cu":2,"In1.Cu":4,"In2.Cu":6};
    if(ids[name]===undefined)throw new Error("Unsupported fixture layer");return ids[name];};
  const allFootprints = pcb.footprints.map(fp => ({ uuid: fp.id!, reference: fp.reference, localZoneConnection: -1, resolvedZoneConnectionOverride: -1 }));
  const allPads: KicadPlaneContactsNativeReport["allPads"] = pcb.footprints.flatMap(fp => fp.pads.map(pad => ({
    uuid: pad.physical.id!, nativeType: 15, nativeClass: "PAD" as const, netCode: 1, netName: pad.netName!, footprintUuid: fp.id!, reference: fp.reference,
    number: pad.number, attribute: pad.physical.padType === "thru_hole" ? 0 : 1,
    localZoneConnection: -1, resolvedZoneConnectionOverride: -1, localThermalGapOverride: null, localThermalSpokeWidthOverride: null,
    padstackMode: 0, padstackUniqueLayers: [0], layers: (pad.layers.includes("*.Cu") ? copperLayers : pad.layers.filter(layer => layer.endsWith(".Cu"))).map(name => ({
      id: layerId(name), name, zoneLayerOverride: 0, effectivePadstackLayer: 0, hasExplicitPadstackDefinition: name === "F.Cu",
    })),
  })));
  const zones: KicadPlaneContactsNativeReport["zones"] = parsedZones.map(parsedZone=>{
  const selectedLayer=parsedZone.layers[0]!;
  const polygons = parsedZone.filledPolygons.map((group, index) => {
    const geometry = { outline: group.contourGroup[0]!.pointsNm!.map(p => [p.x, p.y] as [number, number]), holes: [] as [number, number][][] };
    return { index, sha256: contentIdentity(canonicalJson(geometry)).digest, isIsland: false, ...geometry };
  });
  return { uuid: parsedZone.uuid!, nativeType: 28, nativeClass: "ZONE", netCode: 1, netName: "GND",
    isRuleArea: false, isFilled: true, needRefill: false, padConnection: 1, minimumThicknessNm: 500000,
    layers: [{ id: layerId(selectedLayer), name: selectedLayer, hasFilledPolys: true, fillFlag: 1, filledSubpolygonCount: polygons.length,
      filledGeometrySha256: contentIdentity(canonicalJson(polygons.map(({ outline, holes }) => ({ outline, holes })))).digest, subpolygons: polygons }],
    directPads: allPads.filter(pad => pad.layers.some(layer => layer.name === selectedLayer)).map(pad => ({ uuid: pad.uuid, nativeType: pad.nativeType,
      nativeClass: "PAD", netCode: pad.netCode, netName: pad.netName, proxyType: "PAD" })), directTracks: [], directVias: [],
  }; });
  const f = await createPlaneContactsFixture({ pcbSource: input.sources.pcbSource, report: { allFootprints, allPads, zones } });
  try { change(f.report); return { ...input, contacts: await f.reader.read() }; }
  finally { await f.cleanup(); }
}
const contactTest = it.runIf(process.platform === "win32");

describe("original V2 ERC native evidence", () => {
  it("binds the actual ERC invocation/report and complete schematic/library source scope", async () => {
    const input = await fixture(), result = assessFreshPlaneNativeChecks(input);
    expect(result.checks.erc).toEqual({ status: "verified", reasons: [] });
    expect(result.nativeErcIdentity).toEqual(canonicalIdentity(input.nativeChecks.erc, "evleda.fresh-plane-native-erc-input.v1"));
    expect(result.ercSourceScope).toEqual({ schematic: { relativePath: "fixture.kicad_sch", sha256: "3".repeat(64) },
      symbolLibraryTable: { relativePath: "sym-lib-table", sha256: "5".repeat(64) },
      footprintLibraryTable: { relativePath: "fp-lib-table", sha256: "4".repeat(64) },
      sourceSetIdentity: canonicalIdentity(input.expectedSourceHashes, "evleda.fresh-plane-native-source-set.v1") });
    expect(result.ercCoverage).toMatchObject({ ignoredChecks: [], projectIgnoredCheckKeys: [], projectExclusionCount: 0,
      reportExcludedViolationCount: 0, unexcludedViolationCount: 0, sheetCount: 1, pinMapApplicability: "native-default-absent" });
    expect(Object.isFrozen(result.ercCoverage)).toBe(true);
    expect(result.nativeInput.erc).toEqual(input.nativeChecks.erc);
    expect(isFreshPlaneNativeChecksAssessment(structuredClone(result))).toBe(false);
  });
  it.each(["fixture.kicad_sch", "sym-lib-table", "fp-lib-table"])("rejects stale %s before ERC can be promoted", async key => {
    const input = changeNative(await fixture(), native => { native.sourceHashes[key] = "a".repeat(64); });
    expect(() => assessFreshPlaneNativeChecks(input)).toThrow("sourceHashes");
  });
  it.each([
    ["missing ERC", (native: any) => { delete native.erc; }],
    ["wrong kind", (native: any) => { native.erc.kind = "drc"; }],
    ["wrong executable", (native: any) => { native.erc.invocation.executable = { ...native.erc.invocation.executable, sha256: "f".repeat(64) }; }],
    ["another schematic path", (native: any) => { native.erc.invocation.args[native.erc.invocation.args.length - 1] = "D:\\another.kicad_sch"; }],
    ["extra selector", (native: any) => { native.erc.invocation.args.push("--severity-error"); }],
    ["missing all-severity flag", (native: any) => { native.erc.invocation.args = native.erc.invocation.args.filter((value: string) => value !== "--severity-all"); }],
    ["wrong report source", (native: any) => { native.erc.report.source = "another.kicad_sch"; }],
    ["wrong report schema", (native: any) => { native.erc.report.$schema = "https://schemas.kicad.org/drc.v1.json"; }],
    ["wrong report units", (native: any) => { native.erc.report.coordinate_units = "in"; }],
    ["wrong report version", (native: any) => { native.erc.report.kicad_version = "10.0.2"; }],
    ["filtered report", (native: any) => { native.erc.report.included_severities = ["error"]; }],
    ["missing ignored-check inventory", (native: any) => { delete native.erc.report.ignored_checks; }],
    ["missing sheets", (native: any) => { delete native.erc.report.sheets; }],
    ["empty sheets", (native: any) => { native.erc.report.sheets = []; }],
    ["missing root sheet", (native: any) => { native.erc.report.sheets[0].path = "/child"; }],
    ["duplicate sheets", (native: any) => { native.erc.report.sheets.push(structuredClone(native.erc.report.sheets[0])); }],
    ["missing sheet violation inventory", (native: any) => { delete native.erc.report.sheets[0].violations; }],
    ["exit mismatch", (native: any) => { native.erc.invocation.exitCode = 5; }],
    ["count mismatch", (native: any) => { native.erc.violationCount = 1; }],
  ] as const)("keeps %s ERC evidence unknown without changing the DRC/thermal facts", async (_name, mutate) => {
    const input = await fixture(), before = assessFreshPlaneNativeChecks(input), result = assessFreshPlaneNativeChecks(changeNative(input, mutate));
    expect(result.checks.erc.status).toBe("unsupported");
    expect(result.checks.drcClearanceShorts).toEqual(before.checks.drcClearanceShorts);
    expect(result.checks.thermalPolicy).toEqual(before.checks.thermalPolicy);
  });
  it("reports an actual unexcluded ERC violation as failed", async () => {
    const input = changeNative(await fixture(), native => {
      native.erc.report.sheets[0].violations = [{ type: "pin_not_connected", severity: "error", description: "Unconnected pin" }];
      native.erc.violationCount = 1; native.erc.status = "violations"; native.erc.invocation.exitCode = 5; native.clean = false;
    });
    const result = assessFreshPlaneNativeChecks(input);
    expect(result.checks.erc).toEqual({ status: "failed", reasons: ["native-erc-has-violations"] });
    expect(result.ercCoverage.unexcludedViolationCount).toBe(1);
    expect(result.checks.drcClearanceShorts.status).toBe("verified");
  });
  it("counts warning findings on child sheets as actual ERC violations", async () => {
    const input = changeNative(await fixture(), native => {
      native.erc.report.sheets.push({ path: "/child", uuid_path: "/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/",
        violations: [{ type: "pin_to_pin", severity: "warning", description: "Pin conflict" }] });
      native.erc.violationCount = 1; native.erc.status = "violations"; native.erc.invocation.exitCode = 5;
    });
    const result = assessFreshPlaneNativeChecks(input);
    expect(result.checks.erc.status).toBe("failed");
    expect(result.ercCoverage).toMatchObject({ sheetCount: 2, unexcludedViolationCount: 1 });
  });
  it("keeps excluded ERC findings visible and unresolved", async () => {
    const input = changeNative(await fixture(), native => {
      native.erc.report.sheets[0].violations = [{ type: "pin_not_connected", severity: "error", excluded: true, description: "Excluded pin" }];
      native.erc.violationCount = 1; native.erc.status = "violations"; native.erc.invocation.exitCode = 5; native.clean = false;
    });
    const result = assessFreshPlaneNativeChecks(input);
    expect(result.checks.erc.status).toBe("unsupported");
    expect(result.ercCoverage).toMatchObject({ reportExcludedViolationCount: 1, unexcludedViolationCount: 0 });
  });
  it("does not waive KiCad's four default ignored ERC checks", async () => {
    const project = projectSettings(); project.erc.rule_severities = {};
    const keys = ["single_global_label", "footprint_filter", "simulation_model_issue", "four_way_junction"];
    const input = changeNative(await fixture({ project }), native => { native.erc.report.ignored_checks = keys.map(key => ({ key, description: key })); });
    const result = assessFreshPlaneNativeChecks(input);
    expect(result.checks.erc.status).toBe("unsupported");
    expect(result.ercCoverage.ignoredChecks.map(entry => entry.key)).toEqual(keys);
    expect(result.ercCoverage.projectIgnoredCheckKeys).toEqual([...keys].sort());
    expect(result.checks.erc.reasons).not.toContain("erc-report-project-ignored-checks-mismatch");
  });
  it("detects ignored-check disagreement between the exact project and report", async () => {
    const project = projectSettings(); project.erc.rule_severities.pin_to_pin = "ignore";
    const result = assessFreshPlaneNativeChecks(await fixture({ project }));
    expect(result.checks.erc.status).toBe("unsupported");
    expect(result.ercCoverage.projectIgnoredCheckKeys).toEqual(["pin_to_pin"]);
    expect(result.checks.erc.reasons).toContain("erc-report-project-ignored-checks-mismatch");
  });
  it("rejects project ERC exclusions without changing any project bytes", async () => {
    const project = projectSettings(); project.erc.erc_exclusions = [["native-marker", "comment"]];
    const input = await fixture({ project }), before = input.sources.projectSource;
    const result = assessFreshPlaneNativeChecks(input);
    expect(result.checks.erc.status).toBe("unsupported");
    expect(result.ercCoverage.projectExclusionCount).toBe(1);
    expect(input.sources.projectSource).toBe(before);
  });
  it("does not accept an arbitrary pin-conflict matrix even when ignored_checks is empty", async () => {
    const project = projectSettings(); project.erc.pin_map = Array.from({ length: 12 }, () => Array(12).fill(0) as number[]);
    const result = assessFreshPlaneNativeChecks(await fixture({ project }));
    expect(result.checks.erc.status).toBe("unsupported");
    expect(result.ercCoverage.pinMapApplicability).toBe("non-default");
    expect(result.ercCoverage.pinMapIdentity).not.toBeNull();
  });
  it("recognizes the exact KiCad 10 default pin map when explicitly serialized", async () => {
    const project = projectSettings();
    // Independent interoperability fixture from pinned ERC_SETTINGS::m_defaultPinMap.
    project.erc.pin_map = ["000000100002", "020100102222", "000000101012", "010000112112",
      "000000100002", "000000000002", "111110111112", "000100100002",
      "021200102222", "020100102002", "021100102002", "222222222222"].map(row => [...row].map(Number));
    const implicit = assessFreshPlaneNativeChecks(await fixture()), explicit = assessFreshPlaneNativeChecks(await fixture({ project }));
    expect(explicit.checks.erc.status).toBe("verified");
    expect(explicit.ercCoverage.pinMapApplicability).toBe("native-default-explicit");
    expect(explicit.ercCoverage.pinMapIdentity).toEqual(implicit.ercCoverage.pinMapIdentity);
  });
  it("keeps malformed pin-map policy unknown", async () => {
    const project = projectSettings(); project.erc.pin_map = [[0]];
    const result = assessFreshPlaneNativeChecks(await fixture({ project }));
    expect(result.checks.erc.status).toBe("unsupported");
    expect(result.ercCoverage.pinMapApplicability).toBe("unavailable");
  });
  it("keeps unexplained ERC stderr unresolved", async () => {
    const input = changeNative(await fixture(), native => { native.erc.invocation.stderr = "Schematic read warning"; });
    const result = assessFreshPlaneNativeChecks(input);
    expect(result.checks.erc).toEqual({ status: "unsupported", reasons: ["native-erc-stderr-needs-review"] });
  });
});

describe("source-bound native plane policy evidence", () => {
  it.each([undefined, "error"])("supports only the qualified via diameter default or explicit error (%s)", async severity => {
    const input = await fixture({ numericRules: true, numericSettingsEdit: project => {
      if (severity !== undefined) project.board.design_settings.rule_severities.via_diameter = severity;
    } });
    expect(assessFreshPlaneNativeChecks(input).checks.drcClearanceShorts.status).toBe("verified");
  });
  it.each(["ignore", "warning", "unknown", null])("rejects an explicit weakened via diameter severity %s", async severity => {
    const input = await fixture({ numericRules: true, numericSettingsEdit: project => { project.board.design_settings.rule_severities.via_diameter = severity; } });
    expect(() => assessFreshPlaneNativeChecks(input)).toThrow(/via_diameter.*severity/);
  });
  it.each(["track_width", "track_angle", "via_diameter"])("rejects ignored numeric native category %s even when project intent is exact", async key => {
    const input = changeNative(await fixture({ numericRules: true }), n => { n.drc.report.ignored_checks = [{ key, description: "Ignored numeric check" }]; });
    const result = assessFreshPlaneNativeChecks(input);
    expect(result.checks.drcClearanceShorts.status).toBe("failed");
    expect(result.checks.drcClearanceShorts.reasons).toContain(`required-native-check-disabled:${key}`);
  });
  it("rejects wrong current projected rules independently of byte freshness", async () => {
    const input = await fixture({ numericRules: true, numericSettingsEdit: project => { project.board.design_settings.rules.min_track_width = 0.01; } });
    expect(() => assessFreshPlaneNativeChecks(input)).toThrow(/min_track_width/);
  });
  it("verifies scoped native DRC while missing direct contacts cannot pass thermal policy", async () => {
    const result = assessFreshPlaneNativeChecks(await fixture());
    expect(result.checks.drcClearanceShorts.status).toBe("verified");
    expect(result.checks.thermalPolicy).toEqual({ status: "unsupported", reasons: ["current-native-direct-contacts-unavailable"] });
    expect(result).toMatchObject({ status: "unsupported", acceptanceEvaluated: false, physicalSpokeCount: "not_measured",
      physicalThermalWidth: "not_measured", actualMinimumPlaneCopperWidth: "not_evaluated" });
    expect(isFreshPlaneNativeChecksAssessment(result)).toBe(true);
    expect(isFreshPlaneNativeChecksAssessment(structuredClone(result))).toBe(false);
    expect(Object.isFrozen(result.checks)).toBe(true);
  });
  it("retains the complete immutable native report and invocation needed to reproduce its evidence identity", async () => {
    const input=await fixture(),expected=structuredClone(input.nativeChecks),result=assessFreshPlaneNativeChecks(input);
    expect(result.nativeInput).toEqual(expected);expect(result.nativeInput).not.toBe(input.nativeChecks);
    expect(Object.isFrozen(result.nativeInput.drc.invocation)).toBe(true);
    Object.assign(input.nativeChecks.drc.invocation,{stdout:"later caller mutation"});
    expect(result.nativeInput).toEqual(expected);
    expect(canonicalIdentity(result.nativeInput.drc,"evleda.fresh-plane-native-drc-input.v1")).toEqual(result.nativeDrcIdentity);
  });

  it("rejects copied saved-fill authority and copied bundle authority", async () => {
    const input = await fixture();
    expect(() => assessFreshPlaneNativeChecks({ ...input, savedEvidence: structuredClone(input.savedEvidence) })).toThrow("current plane-fill authority");
    expect(() => assessFreshPlaneNativeChecks({ ...input, compilationBundle: structuredClone(bundle) })).toThrow("authenticated");
  });
  it.each(["pcbSource", "projectSource", "rulesSource"] as const)("rejects stale current %s bytes", async field => {
    const input = await fixture();
    expect(() => assessFreshPlaneNativeChecks({ ...input, sources: { ...input.sources, [field]: input.sources[field] + "\n" } })).toThrow();
  });
  it("rejects current host scope drift independently of the retained saved witness", async () => {
    const input = await fixture();
    expect(() => assessFreshPlaneNativeChecks({ ...input, current: { ...current, sourceScopeIdentity: canonicalIdentity({ changed: true }, "evleda.test-scope.v1") } })).toThrow("stale");
  });
  it.each([
    ["wrong executable", (n: any) => { n.drc.invocation.executable.sha256 = "f".repeat(64); }],
    ["source-hash drift", (n: any) => { n.sourceHashes["fp-lib-table"] = "f".repeat(64); }],
    ["refill invocation", (n: any) => { n.drc.invocation.args.splice(-1, 0, "--refill-zones"); }],
    ["save invocation", (n: any) => { n.drc.invocation.args.splice(-1, 0, "--save-board"); }],
    ["filtered severity", (n: any) => { n.drc.report.included_severities = ["error"]; }],
    ["missing ignored inventory", (n: any) => { delete n.drc.report.ignored_checks; }],
    ["missing findings array", (n: any) => { delete n.drc.report.unconnected_items; }],
    ["wrong exit", (n: any) => { n.drc.invocation.exitCode = 5; }],
    ["fabricated count", (n: any) => { n.drc.violationCount = 1; }],
  ] as const)("rejects %s evidence", async (_label, change) => {
    const input = await fixture();
    expect(() => assessFreshPlaneNativeChecks(changeNative(input, change))).toThrow("Plane native checks");
  });
  it("retains actual native findings as failure instead of a zero-count or completion claim", async () => {
    const input = changeNative(await fixture(), n => {
      n.drc.report.violations = [{ type: "starved_thermal", severity: "error", description: "Insufficient thermal spokes" }];
      n.drc.violationCount = 1; n.drc.status = "violations"; n.drc.invocation.exitCode = 5; n.clean = false;
    });
    const result = assessFreshPlaneNativeChecks(input);
    expect(result.status).toBe("failed");
    expect(result.checks.thermalPolicy.status).toBe("failed");
    expect(result.checks.drcClearanceShorts.reasons).toContain("native-drc-has-findings");
  });
  it.each(["starved_thermal", "unconnected_items"])("rejects native ignored check %s despite empty findings", async key => {
    const input = changeNative(await fixture(), n => { n.drc.report.ignored_checks = [{ key, description: "Ignored check" }]; });
    expect(assessFreshPlaneNativeChecks(input).checks.thermalPolicy).toMatchObject({ status: "failed", reasons: expect.arrayContaining([`required-native-check-disabled:${key}`]) });
  });
  it.each(["clearance", "hole_clearance", "hole_to_hole", "holes_co_located", "annular_width", "drill_out_of_range", "copper_edge_clearance", "shorting_items", "tracks_crossing", "zones_intersect"])("rejects relevant ignored check %s in scoped clearance/short evidence", async key => {
    const input = changeNative(await fixture(), n => { n.drc.report.ignored_checks = [{ key, description: "Ignored check" }]; });
    expect(assessFreshPlaneNativeChecks(input).checks.drcClearanceShorts).toMatchObject({ status: "failed", reasons: expect.arrayContaining([`required-native-check-disabled:${key}`]) });
  });
  it("keeps unrelated configured omissions explicit without pretending to assess their criteria", async () => {
    const input = changeNative(await fixture(), n => { n.drc.report.ignored_checks = [{ key: "missing_courtyard", description: "Ignored by this fixture policy" }]; });
    const result = assessFreshPlaneNativeChecks(input);
    expect(result.checks.drcClearanceShorts.status).toBe("verified");
    expect(result.drcScope).toBe("configured-native-clearance-short-checks-not-complete-plane-acceptance");
    expect(result.acceptanceEvaluated).toBe(false);
  });
  it("rejects project exclusions including native comment-bearing entries", async () => {
    const project = projectSettings(); project.board.design_settings.drc_exclusions.push(["serialized-native-marker", "comment"]);
    const result = assessFreshPlaneNativeChecks(await fixture({ project }));
    expect(result.checks.thermalPolicy.status).toBe("failed");
    expect(result.checks.drcClearanceShorts.reasons).toContain("project-drc-exclusions-present");
  });
  it("requires project severity independently of native report ignored-check metadata", async () => {
    const project = projectSettings(); project.board.design_settings.rule_severities.starved_thermal = "ignore";
    expect(assessFreshPlaneNativeChecks(await fixture({ project })).checks.thermalPolicy.status).toBe("failed");
  });
  it.each(["hole_to_hole", "holes_co_located", "annular_width", "drill_out_of_range"] as const)("rejects disabled project via check %s even when the report omits it", async key => {
    const project = projectSettings(); project.board.design_settings.rule_severities[key] = "ignore";
    const result = assessFreshPlaneNativeChecks(await fixture({ project }));
    expect(result.checks.drcClearanceShorts).toMatchObject({ status: "failed", reasons: expect.arrayContaining([`required-native-check-disabled:${key}`]) });
  });
  it.each([undefined, "unknown"])("rejects missing or unsupported via-check severity %s", async severity => {
    const project = projectSettings();
    const settings = project.board.design_settings.rule_severities as Record<string, unknown>;
    if (severity === undefined) delete settings.hole_to_hole; else settings.hole_to_hole = severity;
    expect(assessFreshPlaneNativeChecks(await fixture({ project })).checks.drcClearanceShorts).toMatchObject({ status: "failed", reasons: expect.arrayContaining(["required-native-check-disabled:hole_to_hole"]) });
  });
  it("treats a hole-to-hole warning as a failure under all-severity native checking", async () => {
    const input = changeNative(await fixture(), n => {
      n.drc.report.violations = [{ type: "hole_to_hole", severity: "warning", description: "Drilled holes are closer than the configured minimum" }];
      n.drc.violationCount = 1; n.drc.status = "violations"; n.drc.invocation.exitCode = 5; n.clean = false;
    });
    expect(assessFreshPlaneNativeChecks(input).checks.drcClearanceShorts).toMatchObject({ status: "failed", reasons: expect.arrayContaining(["native-drc-has-findings"]) });
  });
  it("does not accept unexplained native stderr alongside a clean JSON report", async () => {
    const input = changeNative(await fixture(), n => { n.drc.invocation.stderr = "Rules failed to initialize"; });
    expect(assessFreshPlaneNativeChecks(input).checks.drcClearanceShorts.reasons).toContain("native-drc-stderr-needs-review");
  });
  it.each(["zone_connect", "thermal_width", "thermal_gap", "thermal_bridge_width", "thermal_bridge_angle", "zone_layer_connections", "padstack", "primitives", "options"])(
    "retains unsupported source override %s independently of missing native contact capability", async token => {
      const input = await fixture({ padFields: `(${token} 0)` });
      const result = assessFreshPlaneNativeChecks(input);
      expect(result.checks.thermalPolicy.status).toBe("unsupported");
      expect(result.checks.thermalPolicy.reasons.some(reason => reason.endsWith(`source-pad-${token}`))).toBe(true);
    });
  it("finds footprint-level inheritance overrides", async () => {
    const result = assessFreshPlaneNativeChecks(await fixture({ footprintFields: "(zone_connect 2)" }));
    expect(result.checks.thermalPolicy.reasons.some(reason => reason.endsWith("footprint-source-zone-override"))).toBe(true);
  });
  it("does not mistake quoted metadata for a source override form", async () => {
    const result = assessFreshPlaneNativeChecks(await fixture({ footprintFields: '(property "Description" "quoted (zone_connect 2) text")' }));
    expect(result.checks.thermalPolicy.reasons).toEqual(["current-native-direct-contacts-unavailable"]);
  });
  it("rejects unknown pad fields instead of assuming future native fields cannot override policy", async () => {
    const result = assessFreshPlaneNativeChecks(await fixture({ padFields: "(future_pad_connection_override 4)" }));
    expect(result.checks.thermalPolicy.reasons.some(reason => reason.includes("unsupported-source-pad-field:future_pad_connection_override"))).toBe(true);
  });
  contactTest("verifies a scoped thermal lower bound only with genuine decoded direct contacts and current saved fill", async () => {
    const input = await withContacts(await fixture());
    const result = assessFreshPlaneNativeChecks(input);
    expect(result.status).toBe("verified");
    expect(result.checks.thermalPolicy).toEqual({ status: "verified", reasons: [] });
    expect(result.thermalPads).toEqual([
      expect.objectContaining({ reference: "J1", number: "3", applicability: "direct-native-zone-contact", minimumResolvedSpokes: 2,
        proof: "native-drc-lower-bound-with-source-derived-applicability" }),
      expect.objectContaining({ reference: "R2", number: "2", applicability: "no-pad-copper-on-plane-layer", minimumResolvedSpokes: null, proof: "not-applicable" }),
    ]);
    expect(result.physicalSpokeCount).toBe("not_measured");
    expect(result.physicalThermalWidth).toBe("not_measured");
    expect(result.acceptanceEvaluated).toBe(false);
  });
  contactTest("matches each plane's own generated rule name instead of reusing the first plane's rule",async()=>{
    const input=await withContacts(await fixture({fourLayer:true}));
    const result=assessFreshPlaneNativeChecks(input);
    expect(result.checks.thermalPolicy.status).toBe("verified");
    expect(new Set(result.thermalPads.map(p=>p.zoneUuid)).size).toBe(2);
    expect(new Set(result.thermalPads.map(p=>p.layer))).toEqual(new Set(["In1.Cu","In2.Cu"]));
  });
  contactTest("keeps the stock WSON heatsink EP and its solid override inapplicable to a B.Cu plane", async () => {
    // Exact native07 EP geometry/metadata, placed in the synthetic producer.
    const extraPad = '(pad "7" smd rect (at 0 0) (size 1 1.6) (property pad_prop_heatsink) (layers "F.Cu" "F.Mask") (net "GND") (zone_connect 2))';
    const input = await withContacts(await fixture({ extraPad, rawPadZoneConnection: { number: "7", value: "ZCS_FULL" } }), report => {
      const ep = report.allPads.find(pad => pad.number === "7")!;
      ep.localZoneConnection = 2; ep.resolvedZoneConnectionOverride = 2;
    });
    const result = assessFreshPlaneNativeChecks(input);
    expect(result.checks.thermalPolicy).toEqual({ status: "verified", reasons: [] });
    expect(result.thermalPads.find(pad => pad.number === "7")).toMatchObject({ layer: "B.Cu",
      applicability: "no-pad-copper-on-plane-layer", minimumResolvedSpokes: null, proof: "not-applicable" });
    expect(result.thermalPads.find(pad => pad.number === "3")!.proof).toBe("native-drc-lower-bound-with-source-derived-applicability");
    expect(result.acceptanceEvaluated).toBe(false);
  });
  it.each([-1, 0, 1, 2, 3])("recognizes valid front-only zone_connect %s without treating it as applicable B.Cu policy", async connection => {
    const extraPad = `(pad "7" smd rect (at 2 0) (size 1 1.6) (layers "F.Cu") (net "GND") (property pad_prop_heatsink) (zone_connect ${connection}))`;
    const result = assessFreshPlaneNativeChecks(await fixture({ extraPad }));
    expect(result.checks.thermalPolicy).toEqual({ status: "unsupported", reasons: ["current-native-direct-contacts-unavailable"] });
  });
  contactTest("accepts explicit inherited pad and footprint connection settings", async () => {
    const result = assessFreshPlaneNativeChecks(await withContacts(await fixture({ padFields: "(zone_connect -1)", footprintFields: "(zone_connect -1)" })));
    expect(result.checks.thermalPolicy).toEqual({ status: "verified", reasons: [] });
  });
  contactTest.each(["B.Cu", "*.Cu"])("keeps a supported heatsink pad override restricted on applicable %s copper", async layer => {
    const extraPad = layer === "*.Cu"
      ? '(pad "7" thru_hole circle (at 2 0) (size 1.8 1.8) (drill 0.8) (layers "*.Cu") (net "GND") (property pad_prop_heatsink) (zone_connect 2))'
      : '(pad "7" smd rect (at 2 0) (size 1 1.6) (layers "B.Cu") (net "GND") (property pad_prop_heatsink) (zone_connect 2))';
    const result = assessFreshPlaneNativeChecks(await withContacts(await fixture({ extraPad, rawPadZoneConnection: { number: "7", value: "ZCS_FULL" } }), report => {
      const ep = report.allPads.find(pad => pad.number === "7")!;
      ep.localZoneConnection = 2; ep.resolvedZoneConnectionOverride = 2;
    }));
    expect(result.checks.thermalPolicy.status).toBe("unsupported");
    expect(result.checks.thermalPolicy.reasons).toEqual(expect.arrayContaining([
      expect.stringContaining(":source-pad-zone_connect"), expect.stringContaining(":native-pad-or-footprint-override"),
      expect.stringContaining(":native-padstack-zone-override"),
    ]));
    expect(result.checks.thermalPolicy.reasons.some(reason => reason.includes("unsupported-source-pad-property"))).toBe(false);
  });
  it.each([
    ["unknown property", "(property pad_prop_future)"],
    ["quoted property", '(property "pad_prop_heatsink")'],
    ["empty property", "(property)"],
    ["extra property atom", "(property pad_prop_heatsink extra)"],
    ["nested property", "(property pad_prop_heatsink (drill 0.1))"],
    ["duplicate property", "(property pad_prop_heatsink) (property pad_prop_heatsink)"],
    ["unknown connection", "(zone_connect 4)"],
    ["quoted connection", '(zone_connect "2")'],
    ["empty connection", "(zone_connect)"],
    ["extra connection atom", "(zone_connect 2 1)"],
    ["nested connection", "(zone_connect 2 (thermal_gap 0.1))"],
    ["duplicate connection", "(zone_connect 2) (zone_connect 2)"],
    ["future field", "(future_pad_geometry 1)"],
    ["custom geometry", "(primitives (gr_circle (center 0 0) (end 1 0)))"],
  ])("rejects %s even on front-only plane-net copper", async (_label, fields) => {
    const extraPad = `(pad "7" smd rect (at 2 0) (size 1 1.6) (layers "F.Cu") (net "GND") ${fields})`;
    if (_label === "custom geometry") { await expect(fixture({extraPad})).rejects.toThrow("gr_circle"); return; }
    const result = assessFreshPlaneNativeChecks(await fixture({ extraPad }));
    expect(result.checks.thermalPolicy.status).toBe("unsupported");
    expect(result.checks.thermalPolicy.reasons.some(reason => /unsupported-source-pad|duplicate-source-pad/.test(reason))).toBe(true);
  });
  it("rejects unknown geometry nested beneath a known leaf beside valid off-layer zone metadata", async () => {
    const extraPad = '(pad "7" smd rect (at 2 0) (size 1 1.6 (future_pad_geometry 1)) (layers "F.Cu") (net "GND") (property pad_prop_heatsink) (zone_connect 2))';
    const result = assessFreshPlaneNativeChecks(await fixture({ extraPad }));
    expect(result.checks.thermalPolicy).toMatchObject({ status: "unsupported", reasons: expect.arrayContaining([expect.stringContaining("unsupported-source-pad-nested-field:size")]) });
  });
  contactTest("rejects contradictory direct contact for front-only stock EP", async () => {
    const extraPad = '(pad "7" smd rect (at 2 0) (size 1 1.6) (layers "F.Cu") (net "GND") (property pad_prop_heatsink) (zone_connect 2))';
    const input = await withContacts(await fixture({ extraPad }), report => {
      const ep = report.allPads.find(pad => pad.number === "7")!;
      report.zones[0]!.directPads.push({ uuid: ep.uuid, nativeType: ep.nativeType, nativeClass: "PAD", netCode: ep.netCode, netName: ep.netName, proxyType: "PAD" });
    });
    expect(() => assessFreshPlaneNativeChecks(input)).toThrow("direct contact contradicts native pad-layer absence");
  });
  contactTest("rejects unknown native connection enums even when copper is absent from the plane layer", async () => {
    const result = assessFreshPlaneNativeChecks(await withContacts(await fixture(), report => { report.allPads[1]!.localZoneConnection = 4; }));
    expect(result.checks.thermalPolicy).toMatchObject({ status: "unsupported", reasons: expect.arrayContaining([expect.stringContaining("unsupported-native-zone-connection")]) });
  });
  contactTest.each(["ZCS_FUTURE", ["ZCS_FULL"], {}])("rejects malformed raw native padstack connection %j on front-only copper", async value => {
    const result = assessFreshPlaneNativeChecks(await withContacts(await fixture({ rawPadZoneConnection: { number: "2", value } })));
    expect(result.checks.thermalPolicy).toMatchObject({ status: "unsupported", reasons: expect.arrayContaining([expect.stringContaining("unsupported-native-padstack-zone-connection")]) });
  });
  contactTest("rejects a copied contact report even when all claimed hashes are current", async () => {
    const input = await withContacts(await fixture());
    expect(() => assessFreshPlaneNativeChecks({ ...input, contacts: structuredClone(input.contacts!) })).toThrow("genuine host native");
  });
  contactTest("rejects the zero-spoke skip despite connected PAD-cluster evidence", async () => {
    const input = await withContacts(await fixture(), report => { report.zones[0]!.directPads = []; });
    const result = assessFreshPlaneNativeChecks(input);
    expect(result.checks.thermalPolicy.status).toBe("failed");
    expect(result.checks.thermalPolicy.reasons.some(reason => reason.endsWith("local-intended-zone-contact-not-observed"))).toBe(true);
    expect(result.thermalPads.every(pad => pad.proof !== "native-drc-lower-bound-with-source-derived-applicability")).toBe(true);
  });
  contactTest.each([
    ["pad local solid", (r: KicadPlaneContactsNativeReport) => { r.allPads[0]!.localZoneConnection = 2; r.allPads[0]!.resolvedZoneConnectionOverride = 2; }],
    ["footprint solid", (r: KicadPlaneContactsNativeReport) => { r.allFootprints[0]!.localZoneConnection = 2; r.allFootprints[0]!.resolvedZoneConnectionOverride = 2; }],
    ["gap including explicit zero", (r: KicadPlaneContactsNativeReport) => { r.allPads[0]!.localThermalGapOverride = 0; }],
    ["spoke width", (r: KicadPlaneContactsNativeReport) => { r.allPads[0]!.localThermalSpokeWidthOverride = 200000; }],
    ["per-layer no connection", (r: KicadPlaneContactsNativeReport) => { r.allPads[0]!.layers[1]!.zoneLayerOverride = 2; }],
    ["custom padstack", (r: KicadPlaneContactsNativeReport) => { r.allPads[0]!.padstackMode = 2; }],
    ["native refill required", (r: KicadPlaneContactsNativeReport) => { r.zones[0]!.needRefill = true; }],
  ] as const)("keeps %s native state unsupported without inventing per-layer effective settings", async (_label, change) => {
    const result = assessFreshPlaneNativeChecks(await withContacts(await fixture(), change));
    expect(result.checks.thermalPolicy.status).toBe("unsupported");
    expect(result.thermalPads.every(pad => pad.proof !== "native-drc-lower-bound-with-source-derived-applicability")).toBe(true);
  });
  contactTest("does not claim a native lower bound when the clean report is replaced by a starved-thermal finding", async () => {
    const input = changeNative(await withContacts(await fixture()), n => {
      n.drc.report.violations.push({ type: "starved_thermal", severity: "error", description: "Insufficient spokes" });
      n.drc.violationCount = 1; n.drc.status = "violations"; n.drc.invocation.exitCode = 5;
    });
    const result = assessFreshPlaneNativeChecks(input);
    expect(result.checks.thermalPolicy.status).toBe("failed");
    expect(result.thermalPads[0]!.proof).toBe("unproven");
  });
  contactTest("rejects aggregate contacts from multiple native subpolygons", async () => {
    const input = await withContacts(await fixture(), report => {
      const layer = report.zones[0]!.layers[0]!, next = structuredClone(layer.subpolygons[0]!); next.index = 1;
      layer.subpolygons.push(next); layer.filledSubpolygonCount++;
      layer.filledGeometrySha256 = contentIdentity(canonicalJson(layer.subpolygons.map(({ outline, holes }) => ({ outline, holes })))).digest;
    });
    expect(assessFreshPlaneNativeChecks(input).checks.thermalPolicy).toMatchObject({ status: "unsupported",
      reasons: expect.arrayContaining(["aggregate-native-contact-has-ambiguous-subpolygon-scope"]) });
  });
  contactTest("retains the canonical four-spoke rule threshold over the project's implicit two-spoke default", async () => {
    const input = await withContacts(await fixture({ minimumSpokes: 4 }));
    expect(input.sources.rulesSource).toContain("(constraint min_resolved_spokes 4)");
    expect(JSON.parse(input.sources.projectSource).board.design_settings.rules.min_resolved_spokes).toBe(2);
    const result = assessFreshPlaneNativeChecks(input);
    expect(result.checks.thermalPolicy.status).toBe("verified");
    expect(result.thermalPads[0]!.minimumResolvedSpokes).toBe(4);
    expect(result.ruleApplicability).toBe("source-derived-under-pinned-native-semantics");
  });
  contactTest.each(["global", "layer"] as const)("rejects complete raw native %s padstack overrides despite source absence", async location => {
    const result = assessFreshPlaneNativeChecks(await withContacts(await fixture({ rawPadOverride: location })));
    expect(result.checks.thermalPolicy.status).toBe("unsupported");
    expect(result.checks.thermalPolicy.reasons.some(reason => reason.endsWith("native-padstack-thermal-override"))).toBe(true);
  });
  contactTest("rejects a genuine contact observation of different saved source bytes", async () => {
    const input = await fixture();
    const stale = await withContacts({ ...input, sources: { ...input.sources, pcbSource: input.sources.pcbSource + "\n" } });
    expect(() => assessFreshPlaneNativeChecks({ ...input, contacts: stale.contacts! })).toThrow("native contact source is stale");
  });
  contactTest("rejects contact membership for another native zone", async () => {
    const input = await withContacts(await fixture(), report => { report.zones[0]!.uuid = "88888888-8888-4888-8888-888888888888"; });
    expect(() => assessFreshPlaneNativeChecks(input)).toThrow("native zone inventory differs");
  });
  contactTest("does not add spoke counts across same-number physical members or infer an internal tie", async () => {
    const extraPad = '(pad "3" thru_hole circle (at 2 0) (size 1.8 1.8) (drill 0.8) (layers "*.Cu") (net "GND"))';
    const input = await withContacts(await fixture({ extraPad }), report => { report.zones[0]!.directPads.pop(); });
    const result = assessFreshPlaneNativeChecks(input);
    expect(result.checks.thermalPolicy.status).toBe("failed");
    expect(result.checks.thermalPolicy.reasons.some(reason => reason.endsWith("local-intended-zone-contact-not-observed"))).toBe(true);
    expect(result.thermalPads.every(pad => pad.proof !== "native-drc-lower-bound-with-source-derived-applicability")).toBe(true);
  });
  contactTest("does not discard unnumbered plane-net copper with unsupported connection policy", async () => {
    const extraPad = '(pad "" smd rect (at 2 0) (size 1 1) (layers "B.Cu") (net "GND") (zone_connect 2))';
    const result = assessFreshPlaneNativeChecks(await withContacts(await fixture({ extraPad })));
    expect(result.checks.thermalPolicy.status).toBe("unsupported");
    expect(result.checks.thermalPolicy.reasons.some(reason => reason.endsWith("source-pad-zone_connect"))).toBe(true);
    expect(result.thermalPads.every(pad => pad.proof !== "native-drc-lower-bound-with-source-derived-applicability")).toBe(true);
  });
  contactTest("accepts the canonical PTH remove_unused_layers no serialization", async () => {
    const result = assessFreshPlaneNativeChecks(await withContacts(await fixture({ padFields: "(remove_unused_layers no)" })));
    expect(result.checks.thermalPolicy.status).toBe("verified");
  });
  it.each(["(remove_unused_layers yes)", "(keep_end_layers no)", "(remove_unused_layers)"])("does not infer unconditional pad-layer flashing from %s", async padFields => {
    const result = assessFreshPlaneNativeChecks(await fixture({ padFields }));
    expect(result.checks.thermalPolicy.status).toBe("unsupported");
    expect(result.checks.thermalPolicy.reasons.some(reason => reason.includes("conditional-pad-layer-flashing") || reason.includes("keep_end_layers"))).toBe(true);
  });
});
