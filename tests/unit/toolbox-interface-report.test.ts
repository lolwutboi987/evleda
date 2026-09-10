import { mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import { assessDifferentialPairGeometry } from "../../src/harness/differential-pair-geometry.js";
import type { SavedInterfaceAssessment } from "../../src/harness/saved-interface-assessment.js";
import { captureToolboxInterface, sanitizePcbDiagnosticText, summarizeSavedInterface } from "../../src/mcp/toolbox-interface-report.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function outputRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "evleda-interface-report-")); roots.push(root); return root;
}

const sourceIdentity = contentIdentity("saved interface source");
const authorityIdentity = canonicalIdentity({ fixture: true }, "fixture.v1");
function geometryFixture() {
  const point = (xNm: number, yNm: number) => ({ xNm, yNm });
  return assessDifferentialPairGeometry({ tracks: [
    { uuid: "p", net: "P", layer: "F.Cu", widthNm: 2, start: point(0, 0), end: point(10, 10), sourceIdentity },
    { uuid: "n", net: "N", layer: "F.Cu", widthNm: 2, start: point(0, 1), end: point(10, 11), sourceIdentity }],
  pads: [{ uuid: "sp", reference: "J1", pad: "1", net: "P", layers: ["F.Cu"], center: point(0, 0), sourceIdentity },
    { uuid: "sn", reference: "J1", pad: "2", net: "N", layers: ["F.Cu"], center: point(0, 1), sourceIdentity },
    { uuid: "rp", reference: "J2", pad: "1", net: "P", layers: ["F.Cu"], center: point(10, 10), sourceIdentity },
    { uuid: "rn", reference: "J2", pad: "2", net: "N", layers: ["F.Cu"], center: point(10, 11), sourceIdentity }],
  vias: [], positiveNet: "P", negativeNet: "N", source: { positive: { reference: "J1", pad: "1" }, negative: { reference: "J1", pad: "2" } },
  receiver: { positive: { reference: "J2", pad: "1" }, negative: { reference: "J2", pad: "2" } }, receiverMapping: "preserved",
  terminationAnchors: [{ reference: "J2", pad: "1" }],
  limits: { minimumWidthNm: 2, maximumWidthNm: 2, minimumGapNm: 0, maximumCoupledGapNm: 10, maximumMainLengthNm: 1000,
    maximumSkewNm: 100, maximumStubLengthNm: 0, maximumUncoupledLengthNm: 100, transitions: "forbidden", allowedLayers: ["F.Cu"] } });
}

/** Projection-only fixtures do not mint source or native evaluator authority. */
const calculationFixture = () => ({ status: "calculated", request: { contours: [[0, 1, 2]], privatePath: "C:/private/request" },
  native: { schemaVersion: 4, sourceCommit: "146a4f2a7585c65bc580427a19b6fe2ec4a3f622", implementationRevision: "evleda-uncovered-coupled-microstrip-v1",
    model: "coupled_microstrip", operation: "analyze", converged: true, valid: true, inputs: { privatePath: "C:/private/inputs" },
    results: { Z0_O: { value: 52, status: "ok", unit: "ohm", privatePath: "C:/private/metric" },
      Z_DIFF: { value: 101, status: "warning", unit: "ohm" }, UNIT_PROP_DELAY_ODD: { value: 48.9, status: "warning", unit: "ps/cm" } } },
  impedance: { singleEndedOhm: null, oddModeOhm: 52, differentialAtFrequencyOhm: 104, nativeDifferentialOhm: 101,
    nativeDifferentialBasis: "quasistatic", privatePath: "C:/private/impedance" }, targetResidualOhm: 4,
  executableIdentity: { sha256: "a".repeat(64), sizeBytes: 123, privatePath: "C:/private/executable" },
  modelWarnings: [{ code: "NATIVE_DELAY_APPROXIMATION", message: "Native delay uses 2.99e8 m/s.", affectedResults: ["UNIT_PROP_DELAY_ODD"] },
    { code: "COUPLED_MICROSTRIP_MODEL_RANGE", message: "W/H and S/H are outside the model envelope.", affectedResults: ["Z0_O", "Z_DIFF"] },
    { code: "COUPLED_MICROSTRIP_UNCOVERED_MODEL", message: "Native helper used C:/private/helper.exe", affectedResults: ["Z_DIFF"] }],
  scope: "Pinned single/coupled-microstrip support; conditional analytical prediction only.", invocation: { stderr: "raw native error C:/private" } });

function reidentify(value: object): SavedInterfaceAssessment {
  const { identity: _identity, ...body } = value as Record<string, unknown>;
  return { ...body, identity: canonicalIdentity(body, "evleda.saved-interface-assessment.v1") } as unknown as SavedInterfaceAssessment;
}
function fixture(changes: Record<string, unknown> = {}): SavedInterfaceAssessment {
  const geometry = geometryFixture(), good = { code: "SOURCE_FACTS", message: "Saved source matches the declaration." };
  return reidentify({ schemaVersion: "evleda.saved-interface-assessment.v1", sourceIdentity, bundleIdentity: authorityIdentity,
    contractIdentity: authorityIdentity, verificationPlanIdentity: authorityIdentity, requirementIdentity: authorityIdentity, interfaceId: "PAIR",
    sourceInventory: { status: "complete", reasons: [], selected: geometry.selected, projectionComplete: true,
      observations: [{ kind: "track", uuid: "p", net: "P", sourceIdentity, status: "supported", reasons: [] },
        { kind: "track", uuid: "n", net: "N", sourceIdentity, status: "supported", reasons: [] }] }, geometry,
    construction: { status: "matched_saved_declaration", reasons: [good], observed: { boardThicknessNm: 1_600_000,
      frontCopperThicknessNm: 35_000, backCopperThicknessNm: 35_000, dielectricThicknessNm: 1_530_000, frontMaskThicknessNm: 0, backMaskThicknessNm: 0,
      copperLayerOrder: ["F.Cu", "B.Cu"], dielectricMaterial: "FR4", relativePermittivity: 4.2, lossTangent: 0.02,
      surfaceFinish: "ENIG", stackupSourceIdentity: sourceIdentity }, physicalConstruction: "not_verified", assertionAuthority: "bound_caller_assertions",
      sourceUnverifiedAssertionFields: ["material-frequency-basis", "roughness"] },
    terminations: { status: "matched_source_facts", reasons: [good], pins: [{ side: "receiver", polarity: "positive", kind: "parallel",
      reference: "R1", pin: "1", expectedNet: "P", matchingPadUuids: ["rp"], endpointPadUuid: "rp", distanceSquaredNm2: "0", maximumDistanceNm: 10,
      status: "matched_source_facts", reasons: [good] }], assertedResistanceOhms: [{ side: "receiver", value: 100 }],
      resistanceVerification: "caller_assertion_only", deviceInternalTermination: "not_verified" },
    referenceRequirements: { declarationStatus: "matched_saved_zone", reasons: [good], planeId: "GROUND", net: "GND", layer: "B.Cu", memberNets: ["P", "N"],
      matchingZoneUuids: ["zone"], zoneSourceIdentity: sourceIdentity, savedFillCachePresent: true, fillFreshness: "not_verified",
      wholeRouteCoverage: "not_evaluated", referenceElectricalEligibility: "not_evaluated" },
    impedance: { status: "within_tolerance", reasons: [good], targetOhm: 100, absoluteToleranceOhm: 5, frequencyHz: 1e9,
      intervals: [{ index: 0, positiveRunIndex: 0, negativeRunIndex: 0, positiveMemberUuids: ["p"], negativeMemberUuids: ["n"], positiveWidthNm: 2, negativeWidthNm: 2,
        centerlineSquaredNm2: { numerator: "1", denominator: "2" }, radiusSumTwiceNm: "4", length: { twiceAxisNm: "0", twiceDiagonalNm: "19" },
        numericalGapNm: -1.2928932188134525, numericalLengthNm: 13.435028842544403, status: "within_tolerance", reasons: [good],
        applicability: { status: "conditional_model_only", widthToHeightRatio: 0.1, gapToHeightRatio: 0.1, frequencyGHzTimesHeightMm: 1.53,
          finiteThicknessCaveat: "Finite thickness remains conditional." }, calculatedDifferentialOhm: 104, residualOhm: 4, calculation: calculationFixture() }],
      completeRouteModelCoverage: false, differentialBasis: "twice_frequency_dependent_odd_mode_Z0_O", unmodeledEffects: ["bends", "launches"] },
    unevaluatedRows: [{ id: "reference:PAIR", kind: "interface_reference", reasons: [{ code: "REFERENCE", message: "Fresh reference coverage is unverified." }] }],
    limits: { maximumInputBytes: 8 * 1024 * 1024, maximumAssessedSourceBytes: 1024 * 1024, maximumModelIntervals: 128, maximumSourcePhysicalPads: 2048 },
    sourceAuthority: "saved_byte_numerical_facts_and_bound_caller_assertions", nativeReachability: "not_evaluated", libraryMembership: "not_verified",
    boardAccepted: false, interfaceAccepted: false, fabricationAuthorized: false, ...changes });
}
function contaminate(value: unknown, parentKey = ""): unknown {
  if (Array.isArray(value)) return value.map(item => contaminate(item));
  if (value === null || typeof value !== "object") return value;
  const mapped = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, contaminate(item, key)]));
  // Native result dictionary keys are the closed protocol metric namespace;
  // unrecognized keys are rejected separately, not treated as extension data.
  if (parentKey === "results") return mapped;
  return { ...mapped,
    privatePath: "C:/private/nested", rawSavedSource: "(kicad_pcb PRIVATE_SAVED_SOURCE)", rawRequest: { contours: [[1, 2, 3]] } };
}

describe("closed saved-interface public report", () => {
  it("preserves all geometry facts, exact interval metrics and authority limits", () => {
    const raw = fixture(), report = summarizeSavedInterface(raw);
    expect(report).toMatchObject({ schemaVersion: "evleda.toolbox-interface-assessment.v1", assessmentSchemaVersion: raw.schemaVersion,
      assessmentIdentity: raw.identity, sourceIdentity, bundleIdentity: authorityIdentity, contractIdentity: authorityIdentity,
      verificationPlanIdentity: authorityIdentity, requirementIdentity: authorityIdentity, interfaceId: "PAIR", boardAccepted: false,
      interfaceAccepted: false, fabricationAuthorized: false, nativeReachability: "not_evaluated", libraryMembership: "not_verified" });
    expect(report.sourceInventory).toEqual(raw.sourceInventory);
    expect(report.geometry).toEqual(raw.geometry);
    expect(report.geometry!.coupling!.paired[0]).toMatchObject({ positiveStart: { xTwiceNm: "1", yTwiceNm: "1" },
      length: { twiceAxisNm: "0", twiceDiagonalNm: "19" }, centerlineSquaredNm2: { numerator: "1", denominator: "2" } });
    expect(report.construction).toEqual(raw.construction); expect(report.terminations).toEqual(raw.terminations);
    expect(report.referenceRequirements).toEqual(raw.referenceRequirements); expect(report.unevaluatedRows).toEqual(raw.unevaluatedRows);
    expect(report.impedance.intervals[0]).toMatchObject({ radiusSumTwiceNm: "4", calculatedDifferentialOhm: 104, residualOhm: 4,
      centerlineSquaredNm2: { numerator: "1", denominator: "2" }, numericalGapNm: -1.2928932188134525,
      applicability: { widthToHeightRatio: 0.1, gapToHeightRatio: 0.1, frequencyGHzTimesHeightMm: 1.53 } });
    expect(report.impedance.completeRouteModelCoverage).toBe(false);
  });

  it("removes unknown fields at every depth while retaining every native result and readable scientific warning", () => {
    const raw = reidentify(contaminate(fixture()) as object), before = canonicalJson(raw), report = summarizeSavedInterface(raw);
    const printed = JSON.stringify(report), calc = report.impedance.intervals[0]!.calculation!;
    for (const forbidden of ["C:/private", "privatePath", "PRIVATE_SAVED_SOURCE", "rawSavedSource", "rawRequest", "contours", "invocation", "stderr"]) {
      expect(printed).not.toContain(forbidden);
    }
    expect(calc).not.toHaveProperty("request"); expect(calc.native).not.toHaveProperty("inputs");
    expect(Object.keys(calc.native.results)).toEqual(["Z0_O", "Z_DIFF", "UNIT_PROP_DELAY_ODD"]);
    expect(calc.native.results.UNIT_PROP_DELAY_ODD).toEqual({ value: 48.9, status: "warning", unit: "ps/cm" });
    expect(calc.impedance).toMatchObject({ differentialAtFrequencyOhm: 104, nativeDifferentialOhm: 101, nativeDifferentialBasis: "quasistatic" });
    expect(calc.modelWarnings).toHaveLength(3);
    expect(calc.modelWarnings[0]!.message).toBe("Native delay uses 2.99e8 m/s.");
    expect(calc.modelWarnings[1]!.message).toBe("W/H and S/H are outside the model envelope.");
    expect(calc.modelWarnings[2]!.message).toBe("Private diagnostic detail retained in the complete assessment.");
    expect(calc.scope).toContain("single/coupled-microstrip");
    expect(canonicalJson(raw)).toBe(before);
  });

  it("retains duplicate unsupported findings, null metrics, and every unsuccessful interval", () => {
    const base = fixture(), finding = { code: "UNSUPPORTED", message: "Unsupported route primitive in C:/private/board" };
    const unassessed = { ...base.impedance.intervals[0]!, status: "unassessed", reasons: [finding, finding],
      numericalGapNm: null, numericalLengthNm: null, calculatedDifferentialOhm: null, residualOhm: null, calculation: null };
    const raw = fixture({ geometry: null, sourceInventory: { ...base.sourceInventory, status: "unsupported", projectionComplete: false,
      reasons: [finding, finding], observations: Array.from({ length: 150 }, () => ({ ...base.sourceInventory.observations[0]!, status: "unsupported", reasons: [finding] })) },
    impedance: { ...base.impedance, status: "unassessed", intervals: [unassessed, unassessed], completeRouteModelCoverage: false } });
    const report = summarizeSavedInterface(raw);
    expect(report.geometry).toBeNull(); expect(report.sourceInventory.observations).toHaveLength(150);
    expect(report.sourceInventory.reasons).toHaveLength(2); expect(report.impedance.intervals).toHaveLength(2);
    expect(report.impedance.intervals.every(item => item.status === "unassessed" && item.calculation === null && item.calculatedDifferentialOhm === null)).toBe(true);
    expect(report.impedance.intervals[0]!.reasons).toHaveLength(2);
    expect(JSON.stringify(report)).not.toContain("C:/private");
  });

  it("rejects changed identities, unsupported acceptance claims, malformed collections and metric names", () => {
    const base = fixture();
    expect(() => summarizeSavedInterface({ ...base, interfaceId: "OTHER" })).toThrow(/complete source-bound public report/);
    for (const field of ["boardAccepted", "interfaceAccepted", "fabricationAuthorized"]) {
      expect(() => summarizeSavedInterface(fixture({ [field]: true }))).toThrow(/no findings were truncated/);
    }
    expect(() => summarizeSavedInterface(fixture({ sourceInventory: { ...base.sourceInventory, observations: null } }))).toThrow(/public report/);
    const calc = calculationFixture(); Object.assign(calc.native.results, { "C:/private/metric": { value: 1, unit: "m", status: "ok" } });
    const raw = fixture({ impedance: { ...base.impedance, intervals: [{ ...base.impedance.intervals[0]!, calculation: calc }] } });
    expect(() => summarizeSavedInterface(raw)).toThrow(/public report/);
  });

  it("rejects nested records masquerading as scalar metric and status fields", () => {
    const base = fixture(), privateValue = { path: "C:/private/metric" };
    const malformed = [
      fixture({ sourceAuthority: privateValue }),
      fixture({ sourceInventory: { ...base.sourceInventory, projectionComplete: privateValue } }),
      fixture({ geometry: { ...base.geometry, selected: { ...base.geometry!.selected,
        tracks: [{ ...base.geometry!.selected.tracks[0]!, widthNm: privateValue }] } } }),
      fixture({ impedance: { ...base.impedance, intervals: [{ ...base.impedance.intervals[0]!, calculation: {
        ...calculationFixture(), native: { ...calculationFixture().native, results: { Z0_O: { value: privateValue, status: "ok", unit: "ohm" } } } } }] } }),
    ];
    for (const value of malformed) expect(() => summarizeSavedInterface(value)).toThrow(/complete source-bound public report/);
  });

  it("rejects invented scalar authority and status labels even when their enclosing identity is recomputed", () => {
    const base = fixture();
    const altered = [fixture({ sourceAuthority: "fabrication_release_authority" }), fixture({ nativeReachability: "verified" }),
      fixture({ libraryMembership: "verified" }), fixture({ construction: { ...base.construction, physicalConstruction: "verified" } }),
      fixture({ geometry: { ...base.geometry, checks: { ...base.geometry!.checks, topology: { status: "verified", reasons: [] } } } }),
      fixture({ impedance: { ...base.impedance, intervals: [{ ...base.impedance.intervals[0]!, calculation: {
        ...calculationFixture(), status: "calculated_and_authoritative" } }] } }),
      fixture({ impedance: { ...base.impedance, intervals: [{ ...base.impedance.intervals[0]!, calculation: {
        ...calculationFixture(), native: { ...calculationFixture().native, results: { Z0_O: { value: 52, status: "ok", unit: "m" } } } } }] } }),
    ];
    for (const value of altered) expect(() => summarizeSavedInterface(value)).toThrow(/complete source-bound public report/);
  });

  it("preserves declared slash-bearing pin identifiers and known engineering phrases without admitting drive paths", () => {
    const base = fixture(), messages = ["Adjacent signal/reference copper needs explicit core/prepreg records.",
      "Saved dielectric material/permittivity/loss declaration differs.", "The reference net/layer does not establish fresh coverage.",
      "Unsupported/ambiguous intervals remain unassessed.", "Native terminal/library authority is unverified.", "Exact W/H or S/H is outside the model envelope."];
    const raw = fixture({ geometry: null, sourceInventory: { ...base.sourceInventory, selected: { ...base.sourceInventory.selected,
      pads: [{ ...base.sourceInventory.selected.pads[0]!, pad: "1/2" }] }, reasons: messages.map(message => ({ code: "SOURCE_FACT", message })) },
    terminations: { ...base.terminations, pins: [{ ...base.terminations.pins[0]!, pin: "1/2" }] } });
    const report = summarizeSavedInterface(raw);
    expect(report.sourceInventory.selected.pads[0]!.pad).toBe("1/2"); expect(report.terminations.pins[0]!.pin).toBe("1/2");
    expect(report.sourceInventory.reasons.map(reason => reason.message)).toEqual(messages);
    const materials = summarizeSavedInterface(fixture({ construction: { ...base.construction,
      observed: { ...base.construction.observed, dielectricMaterial: "Isola/370HR", surfaceFinish: "ENIG / OSP" } } }));
    expect(materials.construction.observed).toMatchObject({ dielectricMaterial: "Isola/370HR", surfaceFinish: "ENIG / OSP" });
    const privateMaterial = summarizeSavedInterface(fixture({ construction: { ...base.construction,
      observed: { ...base.construction.observed, dielectricMaterial: "C:/private/material", surfaceFinish: "/private/finish" } } }));
    expect(JSON.stringify(privateMaterial)).not.toContain("/private");
    const assignedPaths = summarizeSavedInterface(fixture({ construction: { ...base.construction,
      observed: { ...base.construction.observed, dielectricMaterial: "material=/private/stackup", surfaceFinish: "finish=/private/finish" } } }));
    expect(assignedPaths.construction.observed).toMatchObject({ dielectricMaterial: "Private diagnostic detail retained in the complete assessment.",
      surfaceFinish: "Private diagnostic detail retained in the complete assessment." });
    expect(() => summarizeSavedInterface(fixture({ terminations: { ...base.terminations, pins: [{ ...base.terminations.pins[0]!, pin: "C:/private/board" }] } })))
      .toThrow(/complete source-bound public report/);
  });

  it("withholds raw saved syntax embedded in otherwise valid diagnostic fields without dropping findings", () => {
    const base = fixture(), calc = calculationFixture();
    calc.modelWarnings[0]!.message = "Native response: (zone (net 1) (polygon (pts (xy 1 2))))";
    const raw = fixture({ sourceInventory: { ...base.sourceInventory, reasons: [{ code: "SOURCE_FAILURE", message: "(kicad_pcb SECRET_TOKEN)" }] },
      geometry: { ...base.geometry, diagnostics: ["Unsupported item (segment (start 1 2) (end 3 4))", "Gap comparison is exact."] },
      impedance: { ...base.impedance, intervals: [{ ...base.impedance.intervals[0]!, calculation: calc }] } });
    const report = summarizeSavedInterface(raw), printed = JSON.stringify(report);
    expect(printed).not.toMatch(/SECRET_TOKEN|\(kicad_pcb|\(segment|\(zone/);
    expect(report.sourceInventory.reasons).toHaveLength(1); expect(report.geometry!.diagnostics).toHaveLength(2);
    expect(report.geometry!.diagnostics[1]).toBe("Gap comparison is exact.");
    expect(report.impedance.intervals[0]!.calculation!.modelWarnings).toHaveLength(3);
    for (const snippet of ["(group SECRET_TOKEN)", "(effects (font SECRET_TOKEN))", "(model SECRET_TOKEN)", "(embedded_fonts yes)",
      "(wire SECRET_TOKEN)", "(future_native_form SECRET_TOKEN)", "prefix (future-form) suffix"]) {
      expect(sanitizePcbDiagnosticText(snippet)).toBe("Private diagnostic detail retained in the complete assessment.");
    }
    expect(sanitizePcbDiagnosticText("Frequency (GHz) times height (mm); permittivity (relative permittivity); correction (H-T)."))
      .toBe("Frequency (GHz) times height (mm); permittivity (relative permittivity); correction (H-T).");
  });

  it("preserves the complete metadata and source identity for unsupported route forms", () => {
    const base = fixture(), observation = { kind: "unsupported_route", uuid: "arc-uuid", net: "P", sourceIdentity,
      status: "unsupported", reasons: [{ code: "UNSUPPORTED_ROUTE", message: "An arc remains unsupported by the source geometry model." }] };
    const raw = fixture({ sourceInventory: { ...base.sourceInventory, status: "unsupported", projectionComplete: false,
      observations: [...base.sourceInventory.observations, observation] } });
    const report = summarizeSavedInterface(raw);
    expect(report.sourceInventory.observations).toHaveLength(base.sourceInventory.observations.length + 1);
    expect(report.sourceInventory.observations.at(-1)).toEqual(observation);
  });

  it("rejects accessors without invocation and returns no foreign error text", () => {
    const raw = fixture(); let calls = 0;
    Object.defineProperty(raw, "C:/private/getter", { enumerable: true, get() { calls++; throw new Error("PRIVATE_SAVED_SOURCE"); } });
    let error: unknown;
    try { summarizeSavedInterface(raw); } catch (cause) { error = cause; }
    expect(calls).toBe(0); expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toMatch(/C:\/private|PRIVATE_SAVED_SOURCE|getter/);
    expect(error).not.toHaveProperty("cause"); expect(JSON.stringify(error)).not.toMatch(/C:\/private|PRIVATE_SAVED_SOURCE|getter/);
  });

  it("rejects a complete report above the MCP budget without truncating source findings", () => {
    const base = fixture(), raw = fixture({ sourceInventory: { ...base.sourceInventory,
      reasons: Array.from({ length: 1000 }, () => ({ code: "LONG_FINDING", message: "x".repeat(1200) })) } });
    expect(Buffer.byteLength(canonicalJson(raw))).toBeLessThan(16 * 1024 * 1024);
    expect(() => summarizeSavedInterface(raw)).toThrow(/no findings were truncated/);
    expect(raw.sourceInventory.reasons).toHaveLength(1000);
  });
});

describe("complete private interface evidence capture", () => {
  it.each(["writeFile", "sync", "stat", "read"] as const)("retains the original %s failure when closing also fails", async operation => {
    const root = await outputRoot(), actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const first = new Error(`Private ${operation} failure at ${root}`), closing = new Error(`Private close failure at ${root}`);
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args);
      return new Proxy(handle, { get(target, key) {
        if (key === operation) return async () => { throw first; };
        if (key === "close") return async () => { await target.close(); throw closing; };
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    });
    try {
      let failure: unknown; try { await captureToolboxInterface(root, fixture()); } catch (cause) { failure = cause; }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("Interface private evidence publication failed; the host must inspect retained state.");
      expect((failure as Error).message).not.toContain(root);
      const retained = (failure as Error).cause;
      expect(retained).toBeInstanceOf(AggregateError);
      expect((retained as AggregateError).cause).toBe(first);
      expect((retained as AggregateError).errors).toHaveLength(2);
      expect((retained as AggregateError).errors[0]).toBe(first); expect((retained as AggregateError).errors[1]).toBe(closing);
      expect(await readdir(root)).toHaveLength(1);
    } finally { vi.mocked(open).mockReset().mockImplementation(actual.open); }
  });

  it("writes canonical complete bytes, pins the readback, and preserves earlier artifacts", async () => {
    const root = await outputRoot(), raw = reidentify(contaminate(fixture()) as object);
    const first = await captureToolboxInterface(root, raw), second = await captureToolboxInterface(root, raw);
    expect(first.diagnostic.filename).toMatch(/^interface-assessment-[a-f0-9-]+\.json$/u);
    expect(first.diagnostic.filename).not.toBe(second.diagnostic.filename);
    const stored = await readFile(path.join(root, first.diagnostic.filename));
    expect(stored.toString("utf8")).toBe(`${canonicalJson(raw)}\n`);
    expect(first.diagnostic.identity).toEqual(contentIdentity(stored));
    expect(first.report.assessmentIdentity).toEqual(raw.identity);
    expect(JSON.parse(stored.toString("utf8"))).toEqual(raw);
    expect(JSON.stringify(first)).not.toMatch(/C:\/private|PRIVATE_SAVED_SOURCE|rawRequest|contours/);
    expect((await readdir(root)).sort()).toEqual([first.diagnostic.filename, second.diagnostic.filename].sort());
  });

  it("binds the public report and private artifact to the same detached input before any await", async () => {
    const root = await outputRoot(), raw = fixture(), before = structuredClone(raw), pending = captureToolboxInterface(root, raw);
    const mutable = raw as unknown as { interfaceId: string; impedance: { intervals: { calculatedDifferentialOhm: number }[] } };
    mutable.interfaceId = "CHANGED"; mutable.impedance.intervals[0]!.calculatedDifferentialOhm = 1;
    const result = await pending;
    expect(result.report.interfaceId).toBe("PAIR");
    expect(result.report.impedance.intervals[0]!.calculatedDifferentialOhm).toBe(104);
    expect(JSON.parse(await readFile(path.join(root, result.diagnostic.filename), "utf8"))).toEqual(before);
  });

  it("rejects stale or oversized findings before reserving a private file", async () => {
    const root = await outputRoot(), base = fixture();
    await expect(captureToolboxInterface(root, { ...base, interfaceId: "STALE" })).rejects.toThrow(/complete source-bound public report/);
    const oversized = fixture({ sourceInventory: { ...base.sourceInventory,
      reasons: Array.from({ length: 1000 }, () => ({ code: "LONG_FINDING", message: "x".repeat(1200) })) } });
    await expect(captureToolboxInterface(root, oversized)).rejects.toThrow(/no findings were truncated/);
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects relative, missing, file and aliased directories without returning host paths", async () => {
    const root = await outputRoot(), ordinary = path.join(root, "ordinary"), alias = path.join(root, "alias"), file = path.join(root, "file");
    await mkdir(ordinary); await symlink(ordinary, alias, process.platform === "win32" ? "junction" : "dir"); await writeFile(file, "unchanged");
    for (const target of ["relative-interface-output", path.join(root, "missing"), file, alias]) {
      let error: unknown; try { await captureToolboxInterface(target, fixture()); } catch (cause) { error = cause; }
      expect(error).toBeInstanceOf(Error); expect((error as Error).message).toBe("Interface private evidence publication failed; the host must inspect retained state.");
      expect((error as Error).message).not.toContain(root); expect((error as Error).cause).toBeInstanceOf(Error);
      if (target === path.join(root, "missing")) {
        expect((error as Error).cause).toMatchObject({ code: "ENOENT", syscall: "lstat", path: target });
      }
    }
    expect(await readFile(file, "utf8")).toBe("unchanged"); expect(await readdir(ordinary)).toEqual([]);
  });
});
