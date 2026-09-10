import { describe, expect, it } from "vitest";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import type { KicadCheckResult, KicadExecutableIdentity } from "../../src/integrations/kicad-cli.js";
import type { KicadPlaneContactsNativeReport } from "../../src/integrations/kicad-plane-contacts.js";
import { assessFreshPlaneNativeChecks, isFreshPlaneNativeChecksAssessment, type FreshPlaneNativeChecksInput } from "../../src/harness/fresh-plane-native-checks.js";
import { createSavedFreshPlaneEvidence } from "../../src/harness/fresh-plane-evidence.js";
import { validateFreshPlaneStageObservation } from "../../src/harness/fresh-plane-stage-observation.js";
import { prepareFreshPlaneMutation } from "../../src/harness/fresh-plane-mutation.js";
import { createFreshPlaneRules } from "../../src/harness/fresh-plane-rules.js";
import { parseFreshPcbReferenceGeometry, parseFreshPcbSource } from "../../src/harness/fresh-kicad-parser.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { genericDividerLibraryResolver } from "../helpers/generic-divider-bundle.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";
import { planeStageObservationFixture } from "../helpers/plane-stage-observation-fixture.js";
import { withNativePadFixtureIds } from "../helpers/native-pad-observation-fixture.js";
import { createPlaneContactsFixture } from "../helpers/kicad-plane-contacts-fixture.js";

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
  return { board: { file: "fixture.kicad_pcb", design_settings: {
    rule_severities: { clearance: "error", hole_clearance: "error", copper_edge_clearance: "error", shorting_items: "error", tracks_crossing: "error", zones_intersect: "error", unconnected_items: "error", starved_thermal: "error" },
    rules: { min_resolved_spokes: 2, max_error: 0.005 }, drc_exclusions: [] as unknown[],
  } } };
}
async function fixture(options: { padFields?: string; footprintFields?: string; project?: ReturnType<typeof projectSettings>;
  minimumSpokes?: number; rawPadOverride?: "global" | "layer"; extraPad?: string } = {}): Promise<FreshPlaneNativeChecksInput> {
  const draft = planeDividerDraft();
  if (options.minimumSpokes !== undefined) draft.planes[0]!.padConnection.minimumConnectedSpokes = options.minimumSpokes;
  const compilationBundle = options.minimumSpokes === undefined ? bundle : createPcbPlaneCompilationBundle({ originalPrompt: "Synthetic four-spoke rule fixture",
    compilation: compilePcbPlaneDesignIntentDraft(draft, dependencies) }, dependencies);
  const before = boardSource(options.padFields, options.footprintFields, options.extraPad);
  const prepared = prepareFreshPlaneMutation({ compilationBundle, beforePcbSource: before, operation: "create" });
  const staged = await planeStageObservationFixture({ beforePcbSource: before, mutation: prepared.mutation });
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
  const stage = validateFreshPlaneStageObservation(staged.receipt, { ...staged, prepared });
  const projectRoot = "D:\\evleda-offline-pad-fixture", pcbPath = `${projectRoot}\\fixture.kicad_pcb`;
  const projectSource = JSON.stringify(options.project ?? projectSettings()), rulesSource = createFreshPlaneRules(compilationBundle).source;
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
  const nativeChecks: KicadCheckResult = { classification: "candidate-validation", releaseAuthorized: false, executable,
    sourceHashes: expectedSourceHashes, drc, erc: { ...drc, kind: "erc" }, clean: true };
  return { compilationBundle, savedEvidence, current, sources, expectedSourceHashes, expectedExecutable: executable, nativeChecks };
}
function changeNative(input: FreshPlaneNativeChecksInput, change: (native: any) => void): FreshPlaneNativeChecksInput {
  const nativeChecks = structuredClone(input.nativeChecks); change(nativeChecks); return { ...input, nativeChecks };
}

async function withContacts(input: FreshPlaneNativeChecksInput, change: (report: KicadPlaneContactsNativeReport) => void = () => {}): Promise<FreshPlaneNativeChecksInput> {
  const pcb = parseFreshPcbSource(input.sources.pcbSource), parsedZone = parseFreshPcbReferenceGeometry(input.sources.pcbSource).zones[0]!;
  const allFootprints = pcb.footprints.map(fp => ({ uuid: fp.id!, reference: fp.reference, localZoneConnection: -1, resolvedZoneConnectionOverride: -1 }));
  const allPads: KicadPlaneContactsNativeReport["allPads"] = pcb.footprints.flatMap(fp => fp.pads.map(pad => ({
    uuid: pad.physical.id!, nativeType: 15, nativeClass: "PAD" as const, netCode: 1, netName: pad.netName!, footprintUuid: fp.id!, reference: fp.reference,
    number: pad.number, attribute: pad.physical.padType === "thru_hole" ? 0 : 1,
    localZoneConnection: -1, resolvedZoneConnectionOverride: -1, localThermalGapOverride: null, localThermalSpokeWidthOverride: null,
    padstackMode: 0, padstackUniqueLayers: [0], layers: (pad.layers.includes("*.Cu") ? ["F.Cu", "B.Cu"] : ["F.Cu"]).map(name => ({
      id: name === "F.Cu" ? 0 : 2, name, zoneLayerOverride: 0, effectivePadstackLayer: 0, hasExplicitPadstackDefinition: name === "F.Cu",
    })),
  })));
  const polygons = parsedZone.filledPolygons.map((group, index) => {
    const geometry = { outline: group.contourGroup[0]!.pointsNm!.map(p => [p.x, p.y] as [number, number]), holes: [] as [number, number][][] };
    return { index, sha256: contentIdentity(canonicalJson(geometry)).digest, isIsland: false, ...geometry };
  });
  const zones: KicadPlaneContactsNativeReport["zones"] = [{ uuid: parsedZone.uuid!, nativeType: 28, nativeClass: "ZONE", netCode: 1, netName: "GND",
    isRuleArea: false, isFilled: true, needRefill: false, padConnection: 1, minimumThicknessNm: 500000,
    layers: [{ id: 2, name: "B.Cu", hasFilledPolys: true, fillFlag: 1, filledSubpolygonCount: polygons.length,
      filledGeometrySha256: contentIdentity(canonicalJson(polygons.map(({ outline, holes }) => ({ outline, holes })))).digest, subpolygons: polygons }],
    directPads: allPads.filter(pad => pad.layers.some(layer => layer.name === "B.Cu")).map(pad => ({ uuid: pad.uuid, nativeType: pad.nativeType,
      nativeClass: "PAD", netCode: pad.netCode, netName: pad.netName, proxyType: "PAD" })), directTracks: [], directVias: [],
  }];
  const f = await createPlaneContactsFixture({ pcbSource: input.sources.pcbSource, report: { allFootprints, allPads, zones } });
  try { change(f.report); return { ...input, contacts: await f.reader.read() }; }
  finally { await f.cleanup(); }
}
const contactTest = it.runIf(process.platform === "win32");

describe("source-bound native plane policy evidence", () => {
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
  it.each(["clearance", "hole_clearance", "copper_edge_clearance", "shorting_items", "tracks_crossing", "zones_intersect"])("rejects relevant ignored check %s in scoped clearance/short evidence", async key => {
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
    const extraPad = '(pad "" smd rect (at 2 0) (size 1 1) (layers "F.Cu") (net "GND") (zone_connect 2))';
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
