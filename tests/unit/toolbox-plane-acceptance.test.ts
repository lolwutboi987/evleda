import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import type { FreshPlaneAcceptanceAssessment } from "../../src/harness/fresh-plane-acceptance.js";
import { captureToolboxPlaneAcceptance, summarizePlaneAcceptance } from "../../src/mcp/toolbox-plane-acceptance.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function outputRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "evleda-plane-acceptance-")); roots.push(root); return root;
}
/** Synthetic projection facts only; this does not issue native drill authority. */
function drillFixture() {
  const id = canonicalIdentity({ drillFixture: true }, "fixture.v1");
  const body = { schemaVersion: "evleda.fresh-plane-drill-topology.v1", status: "verified", issues: [],
    savedEvidenceIdentity: id, savedPcbIdentity: contentIdentity("saved source"), cachedGeometryIdentity: id,
    zoneUuid: "zone", layer: "B.Cu", planarInteriorConnected: true,
    cachedAreaTwiceNm2: "2000000000000000", conservativeAreaLowerBoundTwiceNm2: "1999280000000000",
    areaMeaning: "stored-zone-fill-and-conservative-drill-subtracted-lower-bound",
    bores: [{ uuid: "pad-bore", kind: "pad", netName: "GND", centerNm: { x: 1_000_000, y: 2_000_000 }, diameterNm: 600_000,
      enclosureNm: { minX: 700_000, minY: 1_700_000, maxX: 1_300_000, maxY: 2_300_000 },
      classification: "new_interior_void", classificationBasis: "strict_outward_enclosure", geometrySource: "exact-source-and-native-pad",
      privatePath: "C:/private/bore-source" },
    { uuid: "via-bore", kind: "via", netName: "VIN", centerNm: { x: 3_000_000, y: 2_000_000 }, diameterNm: 300_000,
      enclosureNm: { minX: 2_850_000, minY: 1_850_000, maxX: 3_150_000, maxY: 2_150_000 },
      classification: "inside_cached_hole", classificationBasis: "exact_circle_inside_cached_hole", geometrySource: "exact-saved-through-via" },
    { uuid: "outside-bore", kind: "pad", netName: null, centerNm: { x: 20_000_000, y: 2_000_000 }, diameterNm: 600_000,
      enclosureNm: { minX: 19_700_000, minY: 1_700_000, maxX: 20_300_000, maxY: 2_300_000 },
      classification: "outside_component", classificationBasis: "strict_outward_enclosure", geometrySource: "exact-source-and-native-pad" }],
    inventory: { sourcePadCount: 7, nativePadCount: 7, sourceViaCount: 1, boreCount: 3, complete: true, privatePath: "C:/private/inventory" },
    physicalConnectivity: "not_assessed", actualMinimumCopperWidth: "not_assessed", terminalContactContinuity: "not_assessed",
    bounds: { predicateOperations: 123, maximumBores: 4096, maximumPredicateOperations: 4_000_000 },
    rawRequest: { path: "C:/private/drill-request" },
  };
  return { ...body, identity: canonicalIdentity(body, body.schemaVersion) };
}
function assessment(changes: Record<string, unknown> = {}): FreshPlaneAcceptanceAssessment {
  const id = canonicalIdentity({ fixture: true }, "fixture.v1"), source = contentIdentity("saved source");
  const verified = { status: "verified", reasons: ["Source-bound fact."], privateRequest: { document: "C:/private/native-board" } };
  const unknown = { status: "unknown", reasons: ["Actual copper width remains unmeasured."] };
  const geometry = { status: "verified", issues: [], geometryEquivalent: true,
    sourceGeometryIdentity: id, nativeGeometryIdentity: id,
    components: [{ nativePolygonIndex: 0, areaTwiceNm2: "2000000000000000", topologyCertificate: "simple_outer_minus_strict_disjoint_holes",
      outer: [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 0, y: 1000 }],
      holes: [[{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 100, y: 200 }]] }],
    bounds: { aggregateVertices: 6, predicateOperations: 20, limits: { aggregateVertices: 8192, predicateOperations: 4_000_000 } } };
  const body = {
    schemaVersion: "evleda.fresh-plane-acceptance.v1", family: "plane-v2", status: "failed",
    bundleIdentity: { ...id, privatePath: "C:/private/bundle" }, contractIdentity: id, verificationPlanIdentity: id,
    sourceIdentities: { pcb: { ...source, privatePath: "C:/private/board" }, project: source, rules: source },
    savedEvidenceIdentity: id, endpointConnectivityIdentity: id,
    endpointConnectivity: { status: "connected", nets: [{ net: "GND", status: "connected", everyEligiblePhysicalMemberReachable: true,
      rawCapture: { document: "C:/private/board" } }] },
    authority: verified, sourceScope: { status: "failed", reasons: ["Cannot inspect C:/private/board", "Missing source /private/source/board"] },
    nativeInventory: verified,
    planes: [{ planeId: "GND_PLANE", zoneUuid: "zone", configuration: verified, geometry, nativeGeometry: geometry,
      componentCount: 1, nativePolygonAttribution: verified, drillTopology: drillFixture(),
      minimumArea: { ...verified, requiredAreaTwiceNm2: "1000000000000000", observedAreaTwiceNm2: ["2000000000000000"],
        conservativeAreaLowerBoundTwiceNm2: "1999280000000000" },
      intendedPlaneConnectivity: { ...verified, scope: "native-pad-reachability-to-stored-zone-component",
        directEligiblePadAnchors: ["pad"], nativeDirectVias: ["via"] },
      islandPolicy: verified, actualMinimumCopperWidth: unknown, thermalPolicy: unknown, actualThermalWidth: unknown }],
    references: [{ net: "VIN", planeId: "GND_PLANE", status: "unknown", reasons: ["Reference terminal evidence is incomplete."],
      segmentIds: ["track-1", "track-2"], marginNm: 100_000, geometricStatus: "boundary_uncertain", referenceTerminals: unknown, intersectingBoreUuids: [],tangentBoreUuids:[],
      calculation: { artifacts: { path: "C:/private/calculation.json" }, request: { groups: [{ rings: [[1, 2, 3]] }] } } }],
    rows: [{ id: "contract:integrity", kind: "contract_integrity", status: "pass", reasons: ["Bound source agrees."] },
      { id: "plane-net:GND", kind: "plane_connectivity", status: "fail", reasons: ["Intended component is not connected."] },
      { id: "plane-fill:GND_PLANE", kind: "plane_fill", status: "unknown", reasons: ["No complete width evaluation."] }],
    verificationPlanRowsPassed: ["contract:integrity"], mandatoryRowsRemaining: ["plane-net:GND", "plane-fill:GND_PLANE"],
    acceptanceEvaluated: true, accepted: false, fabricationAuthorized: false,
    limitations: { overallAcceptance: "requires-every-mandatory-V2-row-and-independent-general-gates", physicalThermalWidth: "not-measured",
      actualMinimumCopperWidth: "not-measured", terminalContactContinuity: "native-model-only-not-drill-clipped-global-copper",
      highFrequencyElectricalValidity: "not-established", impedance: "not-evaluated",
      currentSourceGuards: "required-of-owning-host-before-and-after-assessment", internalPath: "C:/private/policy" },
    evidence: { savedFill: { privateDocument: "C:/private/board", rawGeometry: geometry },
      endpointConnectivity: { rawRequests: [{ document: "C:/private/board" }] },
      nativeContacts: { contours: geometry.components }, nativeChecks: { reportPath: "C:/private/drc.json" }, commonChecks: null },
    ...changes,
  };
  return { ...body, identity: canonicalIdentity(body, "evleda.fresh-plane-acceptance.v1") } as unknown as FreshPlaneAcceptanceAssessment;
}

/** Projection-only fixture using the KiCad DRC shape; not authenticated native evidence. */
function nativeFindingFixture() {
  const raw = assessment(), source = raw.sourceIdentities.pcb, id = canonicalIdentity({ nativeFixture: true }, "fixture.v1");
  const item = (uuid: string, description: string) => ({ uuid, description, pos: { x: 3, y: 7 } });
  const finding = (type: string, severity: string, description: string, uuid: string) => ({
    type, severity, description, items: [item(uuid, "Native item")],
  });
  const report = { coordinate_units: "mm", source: "C:/private/board.kicad_pcb", date: "2026-09-10T01:54:32",
    included_severities: ["error", "warning", "exclusion"],
    ignored_checks: [{ key: "missing_courtyard", description: "Footprint has no courtyard defined" },
      { key: "footprint_filters_mismatch", description: "Private report C:/private/check.json", severity: "ignore" }],
    violations: [finding("clearance", "error", "Copper clearance is below the declared rule", "pad-j1-3")],
    unconnected_items: [finding("unconnected_items", "error", "Missing connection near [/private/board]", "unmapped-uuid")],
    schematic_parity: [finding("footprint_symbol_mismatch", "warning", "PinHeader_1x03_P2.54mm_Vertical doesn't match footprint given by symbol (Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical)", "fp-j1"),
      finding("footprint_symbol_mismatch", "warning", "R_0603_1608Metric doesn't match footprint given by symbol (Resistor_SMD:R_0603_1608Metric)", "fp-r1"),
      finding("footprint_symbol_mismatch", "warning", "R_0603_1608Metric doesn't match footprint given by symbol (Resistor_SMD:R_0603_1608Metric)", "fp-r2")],
  };
  const nativeContacts = { sourceBefore: source, sourceAfter: source, report: {
    allFootprints: [{ uuid: "fp-j1", reference: "J1" }, { uuid: "fp-r1", reference: "R1" }, { uuid: "fp-r2", reference: "R2" }],
    allPads: [{ uuid: "pad-j1-3", footprintUuid: "fp-j1", reference: "J1", number: "3" }],
    rawRequest: { path: "C:/private/contacts.json" },
  } };
  const checks = { identity: id, status: "failed", nativeDrcIdentity: id,
    checks: { drcClearanceShorts: { status: "failed", reasons: ["native-drc-has-findings"] },
      thermalPolicy: { status: "failed", reasons: ["native-drc-has-findings"] } },
    nativeInput: { clean: false, sourceHashes: { "C:/private/board": "private-hash" },
      erc: { reportPath: "C:/private/erc.json" },
      drc: { kind: "drc", status: "violations", reportPath: "C:/private/drc.json", violationCount: 5, schematicParityCount: 3, report,
        invocation: { command: "C:/private/kicad-cli.exe", cwd: "C:/private", args: ["--output", "C:/private/drc.json"],
          stdout: "C:/private/raw-output", stderr: "C:/private/raw-error" } } },
    thermalPads: [{ physicalPadUuid: "pad-j1-3", footprintUuid: "fp-j1", reference: "J1", number: "3", layer: "B.Cu",
      zoneUuid: "zone", applicability: "direct-native-zone-contact", minimumResolvedSpokes: 2, proof: "unproven" },
    { physicalPadUuid: "pad-r2-2", footprintUuid: "fp-r2", reference: "R2", number: "2", layer: "B.Cu",
      zoneUuid: "zone", applicability: "no-pad-copper-on-plane-layer", minimumResolvedSpokes: null, proof: "not-applicable" }],
    ruleApplicability: "source-derived-under-pinned-native-semantics",
    drcScope: "configured-native-clearance-short-checks-not-complete-plane-acceptance",
    nativeProviderCompletion: "stock-cli-process-evidence-not-explicit-provider-telemetry",
    physicalSpokeCount: "not_measured", physicalThermalWidth: "not_measured", actualMinimumPlaneCopperWidth: "not_evaluated",
  };
  return { raw: assessment({ evidence: { ...raw.evidence, nativeChecks: checks, nativeContacts } }), checks, nativeContacts, report };
}

/** Historical projection data only; genuine common-check branding is exercised
 * by the integrated assessor tests, not minted by this serialization fixture. */
function commonFindingFixture() {
  const { raw: base } = nativeFindingFixture();
  const rows = [
    { id: "board:outline", kind: "outline", status: "pass", reasons: ["Complete rectangle."], observations: {
      completeAnalyzedOutline: true, primitiveCount: 4, sourcePrimitiveKinds: ["gr_rect"], footprintLocalOutlineContributors: false,
      widthNm: 30_000_000, heightNm: 20_000_000, edgeKeysNm: ["0,0;30000000,0", "30000000,0;30000000,20000000", "0,20000000;30000000,20000000", "0,0;0,20000000"],
      privateSourcePath: "C:/private/outline" } },
    { id: "vias:GND", kind: "via_policy", status: "fail", reasons: ["One via violates its minimum ring."], observations: {
      net: "GND", viaCount: 2, globalViaCount: 2, perNetMaximum: 2, globalMaximum: 2, footprintDrillsAreNotRoutedVias: true,
      dimensions: [{ uuid: "via-1", diameterNm: 600000, drillNm: 300001, annularRingTwiceNm: 299999, xNm: 5_000_000, yNm: 6_000_000,
        layers: ["F.Cu", "B.Cu"], privateSourcePath: "C:/private/via" },
      { uuid: "via-2", diameterNm: 600000, drillNm: 300000, annularRingTwiceNm: 300000, xNm: 7_000_000, yNm: 6_000_000, layers: ["F.Cu", "B.Cu"] }] } },
    { id: "trace-geometry:VIN", kind: "trace_geometry", status: "unknown", reasons: ["Unsupported geometry detail C:/private/route"], observations: {
      net: "VIN", trackUuids: ["track-1", "track-2"], fullRouteInventorySupplied: true,
      padExemptionsSource: "current-source-and-qualified-native-pad-inventory", numericalToleranceMm: 0.000001, rawTrackRequest: { path: "C:/private/tracks" } } },
  ];
  const body = { schemaVersion: "evleda.fresh-plane-common-checks.v1", bundleIdentity: base.bundleIdentity, contractIdentity: base.contractIdentity,
    verificationPlanIdentity: base.verificationPlanIdentity, savedEvidenceIdentity: base.savedEvidenceIdentity,
    endpointConnectivityIdentity: base.endpointConnectivityIdentity, pcbSourceIdentity: base.sourceIdentities.pcb,
    sourceInventory: { complete: true, footprintCount: 3, physicalPadCount: 7, trackCount: 2, viaCount: 2, zoneCount: 1, privatePath: "C:/private/inventory" },
    rows, evidence: { profile: { privatePath: "C:/private/profile" }, analysis: { rawGeometry: [[0, 0], [1, 1]], sourcePath: "C:/private/analysis" } },
    scope: "saved-source-numerical-contract-checks-not-electrical-sizing",
    numericalPolicy: { outlineAndViaDimensions: "exact-integer-nanometres", traceValidatorToleranceMm: 0.000001 },
    notEvaluated: ["trace-connectivity", "drill-clipped-contact-continuity", "plane-access", "placement", "ampacity", "impedance", "manufacturing"], accepted: false };
  const common = { ...body, identity: canonicalIdentity(body, body.schemaVersion) };
  const mergedRows = [...base.rows, ...rows.map(({ observations: _observations, ...row }) => row)];
  return { common, raw: assessment({ evidence: { ...base.evidence, commonChecks: common }, rows: mergedRows,
    verificationPlanRowsPassed: mergedRows.filter(row => row.status === "pass").map(row => row.id),
    mandatoryRowsRemaining: mergedRows.filter(row => row.status !== "pass").map(row => row.id) }) };
}

describe("public plane acceptance projection and private evidence", () => {
  it.each(["verified", "failed", "unsupported"] as const)("projects the concise %s ERC fact and coverage while keeping native invocations private", status => {
    const { raw, checks } = nativeFindingFixture(), identity = canonicalIdentity({ erc: status }, "fixture-erc.v1");
    const native = { ...checks, checks: { ...checks.checks, erc: { status, reasons: [status === "unsupported" ? "ERC omitted C:/private/checks" : "Explicit native ERC result"] } },
      nativeErcIdentity: identity,
      ercSourceScope: { sourceSetIdentity: identity, schematic: { relativePath: "C:/private/schematic", sha256: "1".repeat(64) },
        symbolLibraryTable: { relativePath: "C:/private/symbols", sha256: "2".repeat(64) }, footprintLibraryTable: { relativePath: "C:/private/footprints", sha256: "3".repeat(64) } },
      ercCoverage: { ignoredChecks: status === "unsupported" ? [{ key: "pin_to_pin", description: "Ignored check near C:/private/rules" }] : [],
        projectIgnoredCheckKeys: status === "unsupported" ? ["pin_to_pin"] : [], projectExclusionCount: 0, reportExcludedViolationCount: 0,
        unexcludedViolationCount: status === "failed" ? 1 : 0, sheetCount: 1, pinMapApplicability: "native-default-absent", pinMapIdentity: identity } };
    const report = summarizePlaneAcceptance(assessment({ evidence: { ...raw.evidence, nativeChecks: native } }));
    expect(report.nativeChecks!.checks.erc!.status).toBe(status);
    expect(report.nativeChecks!.nativeErcIdentity).toEqual(identity); expect(report.nativeChecks!.ercSourceSetIdentity).toEqual(identity);
    expect(report.nativeChecks!.ercCoverage).toMatchObject({ unexcludedViolationCount: status === "failed" ? 1 : 0, sheetCount: 1,
      pinMapApplicability: "native-default-absent", pinMapIdentity: identity });
    expect(report.nativeChecks!.drc.schematicParity).toHaveLength(3);
    expect(JSON.stringify(report)).not.toContain("C:/private"); expect(report.nativeChecks).not.toHaveProperty("nativeInput");
  });
  it("projects every common row observation compactly while retaining the full private assessment and existing native findings", async () => {
    const { raw, common } = commonFindingFixture(), root = await outputRoot();
    const captured = await captureToolboxPlaneAcceptance(root, raw), report = captured.report;
    expect(report.commonChecks).toMatchObject({ assessmentIdentity: common.identity, evaluatedRowIds: common.rows.map(row => row.id),
      scope: "saved-source-numerical-contract-checks-not-electrical-sizing", sourceInventory: { complete: true, viaCount: 2 }, accepted: false });
    expect(report.rows.map(row => row.id)).toEqual(raw.rows.map(row => row.id));
    expect(report.rows.find(row => row.id === "board:outline")!.observations).toMatchObject({ primitiveCount: 4, widthNm: 30_000_000, heightNm: 20_000_000, edgeKeysNm: common.rows[0]!.observations.edgeKeysNm });
    const via = report.rows.find(row => row.id === "vias:GND")!;
    expect(via.status).toBe("fail"); expect(via.observations!.dimensions).toHaveLength(2);
    expect(report.rows.find(row => row.id === "trace-geometry:VIN")!).toMatchObject({ status: "unknown", reasons: ["Private diagnostic detail retained in the complete assessment."],
      observations: { trackUuids: ["track-1", "track-2"], fullRouteInventorySupplied: true } });
    expect(report.rows.find(row => row.id === "plane-net:GND")!.status).toBe("fail");
    expect(report.nativeChecks!.drc.violations).toHaveLength(1); expect(report.nativeChecks!.drc.unconnectedItems).toHaveLength(1);
    expect(report.nativeChecks!.drc.schematicParity).toHaveLength(3);
    expect(report).not.toHaveProperty("evidence"); expect(JSON.stringify(report)).not.toMatch(/C:\/private|rawGeometry|rawTrackRequest|privateSourcePath/);
    const stored = JSON.parse(await readFile(path.join(root, captured.diagnostic.filename), "utf8"));
    expect(stored.evidence.commonChecks).toEqual(common); expect(stored.evidence.nativeChecks).toEqual(raw.evidence.nativeChecks);
  });
  it("rejects detached common source or row results rather than projecting mismatched observations", () => {
    const { raw, common } = commonFindingFixture();
    const changed = { ...common, pcbSourceIdentity: contentIdentity("other PCB") }, { identity: _identity, ...body } = changed;
    const wrongSource = { ...changed, identity: canonicalIdentity(body, changed.schemaVersion) };
    expect(() => summarizePlaneAcceptance(assessment({ ...raw, evidence: { ...raw.evidence, commonChecks: wrongSource } }))).toThrow(/source binding/);
    const rows = raw.rows.map(row => row.id === "vias:GND" ? { ...row, status: "pass" } : row);
    expect(() => summarizePlaneAcceptance(assessment({ ...raw, rows }))).toThrow(/original V2 verification row/);
  });
  it("keeps common checks absent when the saved witness is missing", () => {
    const { raw } = commonFindingFixture();
    const report = summarizePlaneAcceptance(assessment({ ...raw, savedEvidenceIdentity: null }));
    expect(report.commonChecks).toBeNull(); expect(report.rows.every(row => !Object.hasOwn(row, "observations"))).toBe(true);
  });
  it("separates stored fill area from bore-aware lower bounds without promoting native contact or covered geometry to completed rows", async () => {
    const root = await outputRoot(), initial = assessment();
    const raw = assessment({ status: "incomplete", rows: [
      { id: "plane-net:GND", kind: "plane_connectivity", status: "unknown", reasons: ["Global drill-clipped terminal contact remains unverified."] },
      { id: "reference:VIN", kind: "reference_path", status: "unknown", reasons: ["Complete terminal contact continuity remains unverified."] }],
    verificationPlanRowsPassed: [], mandatoryRowsRemaining: ["plane-net:GND", "reference:VIN"],
    references: [{ ...initial.references[0]!, status: "verified", geometricStatus: "covered", referenceTerminals: { status: "verified", reasons: [] } }] });
    const captured = await captureToolboxPlaneAcceptance(root, raw), plane = captured.report.planes[0]!;
    expect(plane.geometry).toMatchObject({ areaMeaning: "stored-zone-fill-geometry", components: [{ areaTwiceNm2: "2000000000000000" }] });
    expect(plane.minimumArea).toMatchObject({ observedAreaMeaning: "stored-zone-fill-components",
      observedAreaTwiceNm2: ["2000000000000000"], conservativeAreaLowerBoundTwiceNm2: "1999280000000000" });
    expect(plane.drillTopology).toMatchObject({ status: "verified", planarInteriorConnected: true,
      cachedAreaTwiceNm2: "2000000000000000", conservativeAreaLowerBoundTwiceNm2: "1999280000000000",
      areaMeaning: "stored-zone-fill-and-conservative-drill-subtracted-lower-bound", inventory: { boreCount: 3, complete: true },
      physicalConnectivity: "not_assessed", terminalContactContinuity: "not_assessed", actualMinimumCopperWidth: "not_assessed" });
    expect(plane.drillTopology.bores.map(bore => [bore.uuid, bore.classification, bore.classificationBasis])).toEqual([
      ["pad-bore", "new_interior_void", "strict_outward_enclosure"],
      ["via-bore", "inside_cached_hole", "exact_circle_inside_cached_hole"],
      ["outside-bore", "outside_component", "strict_outward_enclosure"]]);
    expect(plane.drillTopology.bores[0]).toMatchObject({ centerNm: { x: 1_000_000, y: 2_000_000 }, diameterNm: 600_000,
      enclosureNm: { minX: 700_000, minY: 1_700_000, maxX: 1_300_000, maxY: 2_300_000 } });
    expect(plane.intendedPlaneConnectivity).toMatchObject({ status: "verified", scope: "native-pad-reachability-to-stored-zone-component" });
    expect(captured.report.references[0]).toMatchObject({ status: "verified", geometricStatus: "covered", intersectingBoreUuids: [] });
    expect(captured.report.rows.every(row => row.status === "unknown")).toBe(true);
    expect(captured.report.verificationPlanRowsPassed).toEqual([]);
    expect(captured.report.limitations.terminalContactContinuity).toBe("native-model-only-not-drill-clipped-global-copper");
    expect(captured.report.accepted).toBe(false);
    expect(JSON.stringify(captured)).not.toContain("C:/private");
    expect(JSON.stringify(captured)).not.toContain("rawRequest");
    const stored = JSON.parse(await readFile(path.join(root, captured.diagnostic.filename), "utf8")) as FreshPlaneAcceptanceAssessment;
    expect(stored.planes[0]!.drillTopology).toEqual(raw.planes[0]!.drillTopology);
  });

  it("keeps unsupported drill topology unknown with no invented lower bound and preserves definite reference bore failures", () => {
    const initial = assessment(), { identity: _identity, ...body } = drillFixture();
    const unknownDrill = { ...body, status: "unknown", issues: ["Unsupported slot geometry in [/private/board]"],
      planarInteriorConnected: null, conservativeAreaLowerBoundTwiceNm2: null, bores: [], inventory: { ...body.inventory, complete: false } };
    const raw = assessment({ status: "incomplete", planes: [{ ...initial.planes[0]!,
      drillTopology: { ...unknownDrill, identity: canonicalIdentity(unknownDrill, body.schemaVersion) },
      minimumArea: { ...initial.planes[0]!.minimumArea, status: "unknown", conservativeAreaLowerBoundTwiceNm2: null } }],
    rows: [{ id: "plane-policy:GND_PLANE", kind: "plane_policy", status: "unknown", reasons: ["Complete drill topology is unknown."] }],
    verificationPlanRowsPassed: [], mandatoryRowsRemaining: ["plane-policy:GND_PLANE"] });
    const report = summarizePlaneAcceptance(raw);
    expect(report.planes[0]!.drillTopology).toMatchObject({ status: "unknown", planarInteriorConnected: null,
      conservativeAreaLowerBoundTwiceNm2: null, inventory: { complete: false },
      issues: ["Private diagnostic detail retained in the complete assessment."] });
    expect(report.planes[0]!.minimumArea.conservativeAreaLowerBoundTwiceNm2).toBeNull();
    expect(report.rows[0]!.status).toBe("unknown");
    const failed = summarizePlaneAcceptance(assessment({
      references: [{ ...initial.references[0]!, status: "failed", geometricStatus: "uncovered", intersectingBoreUuids: ["pad-bore", "via-bore"] }],
      rows: [{ id: "reference:VIN", kind: "reference_path", status: "fail", reasons: ["The required ribbon intersects round bores."] }],
      verificationPlanRowsPassed: [], mandatoryRowsRemaining: ["reference:VIN"] }));
    expect(failed.references[0]).toMatchObject({ status: "failed", geometricStatus: "uncovered", intersectingBoreUuids: ["pad-bore", "via-bore"] });
    expect(failed.rows[0]!.status).toBe("fail"); expect(failed.accepted).toBe(false);
  });

  it("retains complete actionable native findings and source-bound owners without exposing CLI internals", () => {
    const { raw, report } = nativeFindingFixture(), projected = summarizePlaneAcceptance(raw);
    expect(projected.nativeChecks).toMatchObject({ status: "failed", drc: { status: "violations", violationCount: 5,
      schematicParityCount: 3, includedSeverities: ["error", "warning", "exclusion"],
      ignoredChecks: [{ key: "missing_courtyard", severity: null }, { key: "footprint_filters_mismatch", severity: "ignore" }] },
      thermalPads: [{ reference: "J1", number: "3", minimumResolvedSpokes: 2, proof: "unproven" },
        { reference: "R2", number: "2", minimumResolvedSpokes: null, proof: "not-applicable" }],
      minimumResolvedSpokesMeaning: "declared-lower-bound-requires-qualified-proof",
      physicalSpokeCount: "not_measured", physicalThermalWidth: "not_measured", actualMinimumPlaneCopperWidth: "not_evaluated" });
    const drc = projected.nativeChecks!.drc;
    expect(drc.violations).toHaveLength(1); expect(drc.unconnectedItems).toHaveLength(1); expect(drc.schematicParity).toHaveLength(3);
    expect(drc.schematicParity.map(finding => finding.description)).toEqual(report.schematic_parity.map(finding => finding.description));
    expect(drc.schematicParity.map(finding => finding.items[0]!.owner?.reference)).toEqual(["J1", "R1", "R2"]);
    expect(drc.violations[0]!.items[0]).toMatchObject({ uuid: "pad-j1-3", sourceBinding: "matched",
      owner: { kind: "pad", reference: "J1", padNumber: "3", footprintUuid: "fp-j1" }, position: { x: 3, y: 7 } });
    expect(drc.unconnectedItems[0]).toMatchObject({ type: "unconnected_items", severity: "error",
      description: "Private diagnostic detail retained in the complete assessment.",
      items: [{ uuid: "unmapped-uuid", sourceBinding: "unavailable", owner: null }] });
    for (const privateText of ["C:/private", "/private/board", '"invocation"', '"command"', '"cwd"', '"args"', '"reportPath"', '"rawRequest"']) {
      expect(JSON.stringify(projected)).not.toContain(privateText);
    }
    expect(projected.accepted).toBe(false); expect(projected.fabricationAuthorized).toBe(false);
  });

  it("preserves duplicate findings rather than sampling or deduplicating and leaves raw nativeInput unchanged", async () => {
    const root = await outputRoot(), fixture = nativeFindingFixture();
    fixture.report.schematic_parity.push(...Array.from({ length: 150 }, () => structuredClone(fixture.report.schematic_parity[0]!)));
    fixture.checks.nativeInput.drc.schematicParityCount = fixture.report.schematic_parity.length;
    fixture.checks.nativeInput.drc.violationCount = fixture.report.schematic_parity.length + 2;
    const raw = assessment({ evidence: { ...fixture.raw.evidence, nativeChecks: fixture.checks } });
    const before = canonicalJson(raw.evidence.nativeChecks!.nativeInput), captured = await captureToolboxPlaneAcceptance(root, raw);
    expect(captured.report.nativeChecks!.drc.schematicParity).toHaveLength(153);
    expect(captured.report.nativeChecks!.drc.violations).toHaveLength(1);
    expect(captured.report.nativeChecks!.drc.unconnectedItems).toHaveLength(1);
    const stored = JSON.parse(await readFile(path.join(root, captured.diagnostic.filename), "utf8")) as FreshPlaneAcceptanceAssessment;
    expect(canonicalJson(stored.evidence.nativeChecks!.nativeInput)).toBe(before);
    expect(canonicalJson(raw.evidence.nativeChecks!.nativeInput)).toBe(before);
  });

  it("retains findings with unavailable or ambiguous source owners instead of inventing a reference", () => {
    const fixture = nativeFindingFixture();
    fixture.nativeContacts.report.allFootprints.push({ uuid: "fp-j1", reference: "OTHER" });
    let raw = assessment({ evidence: { ...fixture.raw.evidence, nativeContacts: fixture.nativeContacts } });
    expect(summarizePlaneAcceptance(raw).nativeChecks!.drc.schematicParity[0]!.items[0]).toMatchObject({
      uuid: "fp-j1", sourceBinding: "ambiguous", owner: null });
    fixture.nativeContacts.sourceAfter = contentIdentity("different saved source");
    raw = assessment({ evidence: { ...fixture.raw.evidence, nativeContacts: fixture.nativeContacts } });
    const findings = summarizePlaneAcceptance(raw).nativeChecks!.drc.schematicParity;
    expect(findings).toHaveLength(3);
    expect(findings.every(finding => finding.items[0]!.sourceBinding === "unavailable" && finding.items[0]!.owner === null)).toBe(true);
  });

  it("rejects a complete projection above the MCP budget without publishing a truncated or unusable report", async () => {
    const root = await outputRoot(), fixture = nativeFindingFixture();
    fixture.report.schematic_parity = Array.from({ length: 1000 }, () => ({ ...fixture.report.schematic_parity[0]!, description: "x".repeat(1200) }));
    fixture.checks.nativeInput.drc.schematicParityCount = 1000;
    fixture.checks.nativeInput.drc.violationCount = 1002;
    const raw = assessment({ evidence: { ...fixture.raw.evidence, nativeChecks: fixture.checks } });
    expect(Buffer.byteLength(canonicalJson(raw))).toBeLessThan(16 * 1024 * 1024);
    expect(Buffer.byteLength(JSON.stringify(summarizePlaneAcceptance(raw)))).toBeGreaterThan(1024 * 1024);
    await expect(captureToolboxPlaneAcceptance(root, raw)).rejects.toThrow(/public response limit; no findings were truncated/);
    expect(await readdir(root)).toEqual([]);
  });

  it("reports native findings as unavailable without fresh evidence and rejects missing collections or false counts", async () => {
    const root = await outputRoot(), fixture = nativeFindingFixture();
    expect(summarizePlaneAcceptance(assessment()).nativeChecks).toBeNull();
    expect(summarizePlaneAcceptance(assessment({ savedEvidenceIdentity: null, evidence: fixture.raw.evidence })).nativeChecks).toBeNull();
    fixture.checks.nativeInput.drc.violationCount = 0;
    await expect(captureToolboxPlaneAcceptance(root, assessment({ evidence: { ...fixture.raw.evidence, nativeChecks: fixture.checks } })))
      .rejects.toThrow(/counts differ/);
    fixture.checks.nativeInput.drc.violationCount = 5;
    delete (fixture.report as Partial<typeof fixture.report>).schematic_parity;
    await expect(captureToolboxPlaneAcceptance(root, assessment({ evidence: { ...fixture.raw.evidence, nativeChecks: fixture.checks } })))
      .rejects.toThrow(/complete finding arrays/);
    expect(await readdir(root)).toEqual([]);
  });

  it("keeps every row and actual fact while withholding nested paths, raw requests and contours", () => {
    const raw = assessment(), report = summarizePlaneAcceptance(raw), text = JSON.stringify(report);
    expect(report).toMatchObject({ schemaVersion: "evleda.toolbox-plane-acceptance.v1",
      assessmentSchemaVersion: "evleda.fresh-plane-acceptance.v1", assessmentIdentity: raw.identity,
      status: "failed", accepted: false, fabricationAuthorized: false, acceptanceEvaluated: true,
      planes: [{ componentCount: 1, geometry: { geometryEquivalent: true,
        components: [{ areaTwiceNm2: "2000000000000000", holeCount: 1 }] },
      intendedPlaneConnectivity: { status: "verified", directEligiblePadAnchors: ["pad"], nativeDirectVias: ["via"] },
      actualMinimumCopperWidth: { status: "unknown" } }],
      references: [{ segmentIds: ["track-1", "track-2"], geometricStatus: "boundary_uncertain", status: "unknown" }],
      rows: raw.rows, mandatoryRowsRemaining: ["plane-net:GND", "plane-fill:GND_PLANE"] });
    expect(report.rows).toHaveLength(raw.rows.length);
    expect(report.sourceScope.reasons).toHaveLength(2);
    for (const privateText of ["C:/private", "/private/source", "privatePath", "privateRequest", "rawCapture", '"evidence":', '"outer"', '"holes"', '"calculation"']) {
      expect(text).not.toContain(privateText);
    }
    expect(report).not.toHaveProperty("passed");
    expect(report).not.toHaveProperty("completed");
  });

  it("writes canonical complete evidence with exact readback and never replaces an earlier artifact", async () => {
    const root = await outputRoot(), raw = assessment(), first = await captureToolboxPlaneAcceptance(root, raw);
    expect(first.diagnostic.filename).toMatch(/^plane-acceptance-[a-f0-9-]+\.json$/u);
    expect(Object.keys(first.diagnostic).sort()).toEqual(["filename", "identity"]);
    const bytes = await readFile(path.join(root, first.diagnostic.filename));
    expect(bytes.toString("utf8")).toBe(`${canonicalJson(raw)}\n`);
    expect(contentIdentity(bytes)).toEqual(first.diagnostic.identity);
    expect(JSON.parse(bytes.toString("utf8"))).toEqual(raw);
    expect(bytes.toString("utf8")).toContain("C:/private/calculation.json");
    expect(JSON.stringify(first)).not.toContain("C:/private");
    const second = await captureToolboxPlaneAcceptance(root, raw);
    expect(second.diagnostic.filename).not.toBe(first.diagnostic.filename);
    expect(second.diagnostic.identity).toEqual(first.diagnostic.identity);
    expect(await readFile(path.join(root, first.diagnostic.filename))).toEqual(bytes);
  });

  it("binds the public report to the detached artifact snapshot across asynchronous publication", async () => {
    const root = await outputRoot(), raw = assessment(), original = structuredClone(raw);
    const pending = captureToolboxPlaneAcceptance(root, raw);
    const mutable = raw as unknown as { rows: { status: string }[]; planes: { minimumArea: { observedAreaTwiceNm2: string[] } }[] };
    mutable.rows[1]!.status = "pass";
    mutable.planes[0]!.minimumArea.observedAreaTwiceNm2[0] = "1";
    const captured = await pending;
    expect(captured.report.rows[1]!.status).toBe("fail");
    expect(captured.report.planes[0]!.minimumArea.observedAreaTwiceNm2).toEqual(["2000000000000000"]);
    expect(JSON.parse(await readFile(path.join(root, captured.diagnostic.filename), "utf8"))).toEqual(original);
  });

  it.each(["Cannot inspect [/private/board]", "Native source:/private/board", "Cannot inspect C:private-board", "Native source C:\\private\\board"])("withholds embedded native paths: %s", reason => {
    const report=summarizePlaneAcceptance(assessment({sourceScope:{status:"failed",reasons:[reason]}}));
    expect(report.sourceScope.reasons).toEqual(["Private diagnostic detail retained in the complete assessment."]);
  });

  it("rejects stale identity before creating any file", async () => {
    const root = await outputRoot(), raw = assessment();
    await expect(captureToolboxPlaneAcceptance(root, { ...raw, status: "incomplete" })).rejects.toThrow(/identity/);
    expect(await readdir(root)).toEqual([]);
  });

  it.each([{ schemaVersion: "foreign.v1" }, { family: "routed-v1" }, { accepted: true }, { fabricationAuthorized: true }])
    ("rejects unsupported schema or whole-design claims even with a new identity: %j", async changes => {
      const root = await outputRoot();
      await expect(captureToolboxPlaneAcceptance(root, assessment(changes))).rejects.toThrow(/schema|claims/);
      expect(await readdir(root)).toEqual([]);
    });

  it("rejects oversized complete evidence without truncating it into a report", async () => {
    const root = await outputRoot();
    const raw = assessment({ evidence: { rawNativeCaptures: Array.from({ length: 17 }, () => "x".repeat(1_048_576)) } });
    await expect(captureToolboxPlaneAcceptance(root, raw)).rejects.toThrow(/bound; no findings were truncated/);
    expect(await readdir(root)).toEqual([]);
  });

  it("does not invoke accessors while taking its detached snapshot", async () => {
    const root = await outputRoot(), raw = assessment(); let called = false;
    Object.defineProperty(raw, "evidence", { enumerable: true, get: () => { called = true; return {}; } });
    await expect(captureToolboxPlaneAcceptance(root, raw)).rejects.toThrow(/invalid/);
    expect(called).toBe(false); expect(await readdir(root)).toEqual([]);
  });

  it("rejects relative, missing, non-directory and aliased output roots without leaking their paths", async () => {
    const root = await outputRoot(), real = path.join(root, "real"), alias = path.join(root, "alias"), file = path.join(root, "file");
    await mkdir(real); await writeFile(file, "retained");
    await symlink(real, alias, process.platform === "win32" ? "junction" : "dir");
    for (const target of [path.relative(process.cwd(), real), path.join(root, "missing"), file, alias]) {
      const error = await captureToolboxPlaneAcceptance(target, assessment()).catch(error => error as Error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Plane acceptance private evidence publication failed; the host must inspect retained state.");
      expect((error as Error).message).not.toContain(root);
      expect((error as Error).cause).toBeInstanceOf(Error);
    }
    expect(await readdir(real)).toEqual([]);
    expect(await readFile(file, "utf8")).toBe("retained");
  });
});
