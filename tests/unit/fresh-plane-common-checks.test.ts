import { beforeAll, describe, expect, it } from "vitest";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import { assessFreshPlaneCommonChecks, isFreshPlaneCommonChecksAssessment } from "../../src/harness/fresh-plane-common-checks.js";
import { prepareFreshPlaneConnectivity, assessFreshPlaneConnectivity } from "../../src/harness/fresh-plane-connectivity.js";
import { createSavedFreshPlaneEvidence } from "../../src/harness/fresh-plane-evidence.js";
import { prepareFreshPlaneMutation } from "../../src/harness/fresh-plane-mutation.js";
import { validateFreshPlaneStageObservation } from "../../src/harness/fresh-plane-stage-observation.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { collectKicadNativePadObservation } from "../../src/integrations/kicad-native-pad-observation.js";
import { genericDividerLibraryResolver } from "../helpers/generic-divider-bundle.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";
import { nativePadObservationFixture } from "../helpers/native-pad-observation-fixture.js";
import { planeStageObservationFixture } from "../helpers/plane-stage-observation-fixture.js";

// Offline native-shaped process-port fixtures; no CAD executable is launched and
// none of the production evidence/authenticity predicates is mocked.
type Raw = Record<string, any>;
const id = (n: number) => `44444444-4444-4444-8444-${String(n).padStart(12, "0")}`;
let bundle: ReturnType<typeof createPcbPlaneCompilationBundle>, forbiddenBundle: typeof bundle;
interface ConstraintOptions { forbidden?: boolean; maximumTurnAngleDeg?: number; minimumStraightMm?: number; maximumVinLengthMm?: number }
function buildBundle(options: ConstraintOptions = {}) {
  const dependencies = { libraryResolver: genericDividerLibraryResolver, deepRuleCatalog: loadDeepRuleCatalog() };
  const draft: Raw = planeDividerDraft();
  if (options.forbidden) {
    draft.routingConstraints.viaPolicy = { mode: "forbidden", maxTotal: 0 };
    for (const net of draft.routingConstraints.nets) { if (net.topology === "plane") net.accessRouting.maxVias = 0; else net.maxVias = 0; }
  }
  if (options.maximumTurnAngleDeg !== undefined) draft.routingConstraints.maximumTurnAngleDeg = options.maximumTurnAngleDeg;
  if (options.minimumStraightMm !== undefined) draft.routingConstraints.minimumStraightBeforeTurnMm = options.minimumStraightMm;
  if (options.maximumVinLengthMm !== undefined) draft.routingConstraints.nets.find((net: Raw) => net.net === "VIN").routeLength = { mode: "bounded", maximumMm: options.maximumVinLengthMm };
  const compilation = compilePcbPlaneDesignIntentDraft(draft, dependencies);
  if (compilation.disposition !== "ready") throw new Error(JSON.stringify(compilation.issues));
  return createPcbPlaneCompilationBundle({ compilation, originalPrompt: "Synthetic common-source test fixture; no electrical qualification." }, dependencies);
}
beforeAll(() => {
  bundle = buildBundle(); forbiddenBundle = buildBundle({ forbidden: true });
});
const rectangle = (width = "30") => `(gr_rect (start 0 0) (end ${width} 20) (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts") (uuid "${id(1)}"))`;
const line = (n: number, a: string, b: string) => `(gr_line (start ${a}) (end ${b}) (stroke (width 0.05) (type default)) (layer "Edge.Cuts") (uuid "${id(n)}"))`;
const lines = () => [line(1, "0 0", "30 0"), line(2, "30 0", "30 20"), line(3, "30 20", "0 20"), line(4, "0 20", "0 0")];
const track = (n = 10, a = "3 3", b = "8 3", width = "0.5", layer = "F.Cu") => `(segment (start ${a}) (end ${b}) (width ${width}) (layer "${layer}") (net "VIN") (uuid "${id(n)}"))`;
const via = (options: { n?: number; at?: string; diameter?: string; drill?: string; net?: string; extra?: string } = {}) =>
  `(via ${options.extra ?? ""} (at ${options.at ?? "20 8"}) (size ${options.diameter ?? "0.6"}) (drill ${options.drill ?? "0.3"}) (layers "F.Cu" "B.Cu") (net "${options.net ?? "GND"}") (uuid "${id(options.n ?? 20)}"))`;
interface FixtureOptions extends ConstraintOptions { outline?: string; tracks?: string; vias?: string; extraCopper?: string; platedPads?: boolean; footprintProperty?: string }
async function fixture(options: FixtureOptions = {}) {
  const compilationBundle = options.maximumTurnAngleDeg !== undefined || options.minimumStraightMm !== undefined || options.maximumVinLengthMm !== undefined
    ? buildBundle(options) : options.forbidden ? forbiddenBundle : bundle;
  const before = `(kicad_pcb (version 20260206) (generator "pcbnew") (generator_version "10.0") (general (thickness 1.6))
    (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
    ${compilationBundle.contract.components.map((component, i) => `(footprint ${JSON.stringify(component.footprintLibId)} (uuid "${id(100 + i)}") (layer "F.Cu") (at ${3 + 5 * i} 3)
      (property "Reference" ${JSON.stringify(component.reference)}) (property "Value" ${JSON.stringify(component.value)})
      ${i === 0 ? options.footprintProperty ?? "" : ""}
      ${component.pins.map((pin, j) => `(pad ${JSON.stringify(pin.pin)} ${options.platedPads ? "thru_hole circle" : "smd rect"}
        (uuid "${id(200 + i * 10 + j)}") (at 0 ${j * 2}) (size 1 1) ${options.platedPads ? "(drill 0.4) (layers \"F.Cu\" \"B.Cu\")" : "(layers \"F.Cu\")"}
        (net ${JSON.stringify(pin.assignment.kind === "net" ? pin.assignment.net : "")}))`).join("\n")})`).join("\n")}
    ${options.outline ?? rectangle()} ${options.tracks ?? track()} ${options.vias ?? ""} ${options.extraCopper ?? ""})\n`;
  const prepared = prepareFreshPlaneMutation({ compilationBundle, beforePcbSource: before, operation: "create" });
  const f = await planeStageObservationFixture({ beforePcbSource: before, mutation: prepared.mutation });
  const stage = validateFreshPlaneStageObservation(f.receipt, { ...f, prepared });
  const pcbSource = f.stagedSource, physical = await nativePadObservationFixture(pcbSource);
  const scopeIdentity = canonicalIdentity({ source: "current common-check fixture" }, "evleda.common-test-scope.v1");
  const expectedInput = { compilationBundle, pcbPath: physical.expected.pcbPath, pcbSource, scopeIdentity,
    physicalFootprints: physical.expected.physicalFootprints!, physicalFootprintResolver: physical.expected.physicalFootprintResolver! };
  const request = prepareFreshPlaneConnectivity(expectedInput), payload: Raw = structuredClone(physical.observation.rawSnapshot);
  payload.connectivity = request.nativePadExpected.requestedPrimitiveIds.map(uuid => payload.connectivity.find((query: Raw) => query.sourcePrimitiveId === uuid));
  const observed = await collectKicadNativePadObservation({ async readLivePcbPadSnapshot() {
    return { isError: false, structuredContent: payload, content: [{ type: "text", text: JSON.stringify(payload) }] };
  } }, request.nativePadExpected);
  const endpointConnectivity = assessFreshPlaneConnectivity({ ...expectedInput, nativePads: observed });
  const savedEvidence = createSavedFreshPlaneEvidence({ compilationBundle, stage, savedPcbSource: pcbSource,
    projectBindingIdentity: canonicalIdentity({ project: "fixture" }, "evleda.common-project-fixture.v1"), sourceScopeIdentity: scopeIdentity,
    projectSettingsIdentity: contentIdentity("{}\n"), rulesIdentity: prepared.rulesIdentity });
  return { compilationBundle, savedEvidence, pcbSource, endpointConnectivity };
}
const row = (value: ReturnType<typeof assessFreshPlaneCommonChecks>, name: string) => value.rows.find(row => row.id === name)!;

describe("authenticated V2 common numerical source checks", () => {
  it("passes complete rectangle, supported via and trace geometry as original V2 rows without claiming connectivity or electrical sizing", async () => {
    const input = await fixture({ vias: via() }), result = assessFreshPlaneCommonChecks(input);
    expect(result.sourceInventory.complete).toBe(true); expect(row(result, "board:outline").status).toBe("pass");
    expect(result.rows.filter(row => row.kind === "via_policy").every(row => row.status === "pass")).toBe(true);
    expect(row(result, "trace-geometry:VIN").status).toBe("pass"); expect(row(result, "trace-geometry:VOUT").status).toBe("unknown");
    expect(result.rows.map(row => row.id)).toEqual(input.compilationBundle.verificationPlan.requirements.filter(row => ["outline", "via_policy", "trace_geometry"].includes(row.kind)).map(row => row.id));
    expect(result.evidence.analysis!.summary.completeBoardGeometryCoverage).toBe(false);
    expect(result.scope).toBe("saved-source-numerical-contract-checks-not-electrical-sizing"); expect(result.accepted).toBe(false);
    expect(result.notEvaluated).toContain("trace-connectivity"); expect(result.notEvaluated).toContain("ampacity");
    expect(isFreshPlaneCommonChecksAssessment(result)).toBe(true); expect(isFreshPlaneCommonChecksAssessment(structuredClone(result))).toBe(false);
    const { identity, ...payload } = result; expect(identity).toEqual(canonicalIdentity(payload, result.schemaVersion)); expect(Object.isFrozen(result.rows)).toBe(true);
  });

  it("accepts reversed and reordered complete line edges without using bounding-box shape inference", async () => {
    const input = await fixture({ outline: [line(4, "0 0", "0 20"), line(2, "30 20", "30 0"), line(1, "30 0", "0 0"), line(3, "0 20", "30 20")].join("\n") });
    expect(row(assessFreshPlaneCommonChecks(input), "board:outline").status).toBe("pass");
  });
  it.each([
    ["open rectangle sharing the correct bounds", () => lines().slice(0, 3).join("\n")],
    ["additional circular cutout", () => `${rectangle()} (gr_circle (center 15 10) (end 16 10) (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts") (uuid "${id(5)}"))`],
    ["additional curved primitive", () => `${rectangle()} (gr_arc (start 12 10) (mid 13 11) (end 14 10) (stroke (width 0.05) (type default)) (layer "Edge.Cuts") (uuid "${id(5)}"))`],
    ["wrong exact width by 1 nm", () => rectangle("30.000001")],
    ["duplicate edge with missing fourth side", () => [...lines().slice(0, 3), line(5, "0 0", "30 0")].join("\n")],
  ] as const)("does not accept %s", async (_name, outline) => {
    const result = assessFreshPlaneCommonChecks(await fixture({ outline: outline() }));
    expect(row(result, "board:outline").status).not.toBe("pass");
  });
  it("does not round a non-nm outline dimension into an exact pass", async () => {
    const result = assessFreshPlaneCommonChecks(await fixture({ outline: rectangle("30.0000001") }));
    expect(row(result, "board:outline").status).toBe("unknown"); expect(row(result, "board:outline").reasons.join(" ")).toMatch(/integer nanometres/);
  });
  it("does not omit footprint property text on Edge.Cuts from the complete outline inventory", async () => {
    const input = await fixture({ footprintProperty: '(property "User" "extra outline text" (at 0 0) (layer "Edge.Cuts"))' });
    const result = assessFreshPlaneCommonChecks(input);
    expect(result.evidence.analysis!.summary.outlineComplete).toBe(true);
    expect(row(result, "board:outline").status).toBe("fail");
    expect(row(result, "board:outline").observations.footprintLocalOutlineContributors).toBe(true);
  });
  it("does not mistake quoted property text resembling a layer form for outline geometry", async () => {
    const property = `(property "User" ${JSON.stringify('note (layer "Edge.Cuts")')} (at 0 0) (layer "F.Fab"))`;
    expect(row(assessFreshPlaneCommonChecks(await fixture({ footprintProperty: property })), "board:outline").status).toBe("pass");
  });

  it.each([
    ["diameter one nm below minimum", { diameter: "0.599999" }],
    ["drill one nm below minimum", { drill: "0.299999" }],
    ["annular ring one half nm below minimum", { drill: "0.300001" }],
    ["copper edge one nm below minimum", { at: "0.799999 8" }],
  ] as const)("fails exact via geometry: %s", async (_name, options) => {
    const result = assessFreshPlaneCommonChecks(await fixture({ vias: via(options) })); expect(row(result, "vias:GND").status).toBe("fail");
  });
  it("counts the global via inventory on every net while preserving plane-access per-net limits", async () => {
    const input = await fixture({ vias: [via({ n: 20, at: "20 8" }), via({ n: 21, at: "23 8" }), via({ n: 22, at: "26 8" })].join("\n") });
    const result = assessFreshPlaneCommonChecks(input);
    expect(result.rows.filter(row => row.kind === "via_policy").every(row => row.status === "fail")).toBe(true);
    expect(row(result, "vias:GND").observations).toMatchObject({ viaCount: 3, globalViaCount: 3, perNetMaximum: 2, globalMaximum: 2 });
  });
  it("rejects signal vias under the explicit continuous-reference policy", async () => {
    expect(row(assessFreshPlaneCommonChecks(await fixture({ vias: via({ net: "VIN" }) })), "vias:VIN").status).toBe("fail");
  });
  it("enforces zero-via policy without counting real plated footprint bores as vias", async () => {
    const zero = assessFreshPlaneCommonChecks(await fixture({ forbidden: true, platedPads: true }));
    expect(zero.sourceInventory.physicalPadCount).toBe(7); expect(zero.sourceInventory.viaCount).toBe(0);
    expect(zero.rows.filter(row => row.kind === "via_policy").every(row => row.status === "pass")).toBe(true);
    const failed = assessFreshPlaneCommonChecks(await fixture({ forbidden: true, vias: via() }));
    expect(failed.rows.filter(row => row.kind === "via_policy").every(row => row.status === "fail")).toBe(true);
  });
  it("does not silently remove an extended via modifier or unmodeled copper graphic", async () => {
    for (const options of [{ vias: via({ extra: "free" }) }, { extraCopper: `(gr_circle (center 15 10) (end 16 10) (stroke (width 0.05) (type default)) (fill none) (layer "F.Cu") (uuid "${id(5)}"))` }]) {
      const result = assessFreshPlaneCommonChecks(await fixture(options)); expect(result.sourceInventory.complete).toBe(false); expect(result.rows.every(row => row.status === "unknown")).toBe(true);
    }
  });
  it.each([
    ["width one nm below class", track(10, "3 3", "8 3", "0.499999")],
    ["right-angle corner", `${track(10, "3 3", "5 3")} ${track(11, "5 3", "5 5")}`],
    ["wrong declared signal layer", track(10, "3 3", "8 3", "0.5", "B.Cu")],
  ] as const)("fails complete trace geometry: %s", async (_name, tracks) => {
    const result = assessFreshPlaneCommonChecks(await fixture({ tracks })); expect(row(result, "trace-geometry:VIN").status).toBe("fail");
  });
  it.each(["8 3.000001", "8 4"])("keeps unsupported heading %s unknown without rounding or inventing a requirement violation", async end => {
    const result = assessFreshPlaneCommonChecks(await fixture({ tracks: track(10, "3 3", end) }));
    expect(row(result, "trace-geometry:VIN").status).toBe("unknown");
    expect(row(result, "trace-geometry:VIN").reasons.join(" ")).toMatch(/unsupported source orientation/);
  });
  it("keeps absent trace geometry unknown even when source-only via and outline constraints pass", async () => {
    const result = assessFreshPlaneCommonChecks(await fixture({ tracks: "" })); expect(row(result, "board:outline").status).toBe("pass");
    expect(result.rows.filter(row => row.kind === "trace_geometry").every(row => row.status === "unknown")).toBe(true);
  });
  it("reuses the V2 validator for a complete 45-degree chain without inferring terminal or topology completion", async () => {
    const result = assessFreshPlaneCommonChecks(await fixture({ tracks: `${track(10, "3 3", "5 3")} ${track(11, "5 3", "7 5")}` }));
    expect(row(result, "trace-geometry:VIN").status).toBe("pass");
    expect(result.rows.some(row => row.id === "trace-net:VIN")).toBe(false); expect(result.accepted).toBe(false);
  });
  it.each([
    ["one nm over a horizontal length bound", { maximumVinLengthMm: 4.999999, tracks: track() }],
    ["fractional-nm diagonal excess", { maximumVinLengthMm: 4.828427, tracks: `${track(10, "3 3", "5 3")} ${track(11, "5 3", "7 5")}` }],
    ["45-degree turn over a tighter exact bound", { maximumTurnAngleDeg: 44.9999999, tracks: `${track(10, "3 3", "5 3")} ${track(11, "5 3", "7 5")}` }],
    ["one nm short of the straight-leg bound", { minimumStraightMm: 2.000001, tracks: `${track(10, "3 3", "5 3")} ${track(11, "5 3", "7 5")}` }],
  ] as const)("does not spend numerical matching tolerance on a supplied constraint: %s", async (_name, options) => {
    expect(row(assessFreshPlaneCommonChecks(await fixture(options)), "trace-geometry:VIN").status).toBe("fail");
  });
  it("accepts a diagonal length just below its exact rational bound", async () => {
    const result = assessFreshPlaneCommonChecks(await fixture({ maximumVinLengthMm: 4.828428, tracks: `${track(10, "3 3", "5 3")} ${track(11, "5 3", "7 5")}` }));
    expect(row(result, "trace-geometry:VIN").status).toBe("pass");
  });
  it("keeps an uncharacterized multiway junction unknown rather than dropping a branch into a geometry pass", async () => {
    const tracks = `${track(10, "3 3", "5 3")} ${track(11, "5 3", "7 3")} ${track(12, "5 3", "5 5")}`;
    const result = assessFreshPlaneCommonChecks(await fixture({ tracks }));
    expect(row(result, "trace-geometry:VIN").status).toBe("unknown");
    expect(row(result, "trace-geometry:VIN").observations.trackUuids).toHaveLength(3);
  });
  it("rejects partial collinear overlap even when both overlap ends coincide with source/native PAD contacts", async () => {
    const tracks = `${track(10, "2 3", "8 3")} ${track(11, "3 3", "9 3")}`;
    const result = assessFreshPlaneCommonChecks(await fixture({ tracks }));
    expect(row(result, "trace-geometry:VIN").status).toBe("fail");
    expect(row(result, "trace-geometry:VIN").reasons.join(" ")).toMatch(/overlapping copper tracks/);
  });
  it("rejects copied provenance and changed source before issuing any common-check receipt", async () => {
    const input = await fixture();
    expect(() => assessFreshPlaneCommonChecks({ ...input, savedEvidence: structuredClone(input.savedEvidence) })).toThrow(/authorities/);
    expect(() => assessFreshPlaneCommonChecks({ ...input, endpointConnectivity: structuredClone(input.endpointConnectivity) })).toThrow(/authorities/);
    expect(() => assessFreshPlaneCommonChecks({ ...input, compilationBundle: structuredClone(input.compilationBundle) })).toThrow(/authorities/);
    expect(() => assessFreshPlaneCommonChecks({ ...input, pcbSource: `${input.pcbSource}\n` })).toThrow(/identities disagree/);
    expect(canonicalJson(input.compilationBundle)).toContain('"evleda.pcb-design-contract.v2"');
  });
});
