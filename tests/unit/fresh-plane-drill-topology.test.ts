import { beforeAll, describe, expect, it } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { assessFreshPlaneDrillTopology } from "../../src/harness/fresh-plane-drill-topology.js";
import { createSavedFreshPlaneEvidence } from "../../src/harness/fresh-plane-evidence.js";
import { validateFreshPlaneStageObservation } from "../../src/harness/fresh-plane-stage-observation.js";
import { prepareFreshPlaneMutation } from "../../src/harness/fresh-plane-mutation.js";
import { parseFreshPcbReferenceGeometry, parseFreshPcbSource } from "../../src/harness/fresh-kicad-parser.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { genericDividerLibraryResolver } from "../helpers/generic-divider-bundle.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";
import { planeStageObservationFixture } from "../helpers/plane-stage-observation-fixture.js";
import { withNativePadFixtureIds } from "../helpers/native-pad-observation-fixture.js";

type Raw = Record<string, any>;
let bundle: ReturnType<typeof createPcbPlaneCompilationBundle>;
beforeAll(() => {
  const dependencies = { libraryResolver: genericDividerLibraryResolver, deepRuleCatalog: loadDeepRuleCatalog() };
  const compilation = compilePcbPlaneDesignIntentDraft(planeDividerDraft(), dependencies);
  if (compilation.disposition !== "ready") throw new Error(JSON.stringify(compilation.issues));
  bundle = createPcbPlaneCompilationBundle({ compilation, originalPrompt: "Offline drill topology fixture; no native execution." }, dependencies);
});
const pad = (x = "5", y = "5", drill = "1", net = "GND", extra = "") => `(pad "1" thru_hole circle (at ${x} ${y}) (size 2 2) (drill ${drill}) (layers "F.Cu" "B.Cu") (net "${net}") ${extra})`;
const smd = `(pad "1" smd rect (at 5 5) (size 1 1) (layers "F.Cu") (net "GND"))`;
const via = (at = "10 10", drill = "0.3", extra = "", uuid = "33333333-3333-4333-8333-333333333333", net = "GND") =>
  `(via ${extra} (at ${at}) (size 0.6) (drill ${drill}) (layers "F.Cu" "B.Cu") (net "${net}") (uuid "${uuid}"))`;
const board = (pads: string[], routes = "", rotation = "0", origin = "0 0") => withNativePadFixtureIds(`(kicad_pcb (version 20260206) (generator "pcbnew") (generator_version "10.0")
  (general (thickness 1.6)) (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
  (footprint "Test:X" (layer "F.Cu") (at ${origin} ${rotation}) (property "Reference" "J1") (property "Value" "TEST") ${pads.join(" ")}) ${routes})\n`);
// Native-source-shaped fractured walk around an explicit rectangular cached void.
const holeChain = [[0.5, 0.5], [29.5, 0.5], [29.5, 19.5], [0.5, 19.5], [0.5, 7], [3, 7], [7, 7], [7, 3], [3, 3], [3, 7], [0.5, 7]];
// Historical plane05 geometry from the saved PCB whose SHA256 is
// 0463630819eb0889ebba6eaeb078e7a34bfbafe9e65c51d6a56e905c93d1e70e.
// This recorded contour is exercised inside synthetic stage fixtures below;
// replaying it neither restores historical authority nor runs native KiCad.
const plane05Chain = [
  [29.345788, 0.519454], [29.42657, 0.57343], [29.480546, 0.654212], [29.4995, 0.7495], [29.4995, 19.2505],
  [29.480546, 19.345788], [29.42657, 19.42657], [29.345788, 19.480546], [29.2505, 19.4995], [0.7495, 19.4995],
  [0.654212, 19.480546], [0.57343, 19.42657], [0.519454, 19.345788], [0.5005, 19.2505], [0.5005, 6.125323],
  [1.8995, 6.125323], [1.8995, 7.874676], [1.914033, 7.947739], [1.969397, 8.030599], [1.969399, 8.030601],
  [2.05226, 8.085966], [2.125324, 8.100499], [2.125325, 8.1005], [2.36396, 8.1005], [2.459248, 8.119454],
  [2.54003, 8.17343], [2.594006, 8.254212], [2.61296, 8.3495], [2.594006, 8.444788], [2.54003, 8.52557],
  [2.477002, 8.571361], [2.423211, 8.598768], [2.423208, 8.59877], [2.283077, 8.700581], [2.160581, 8.823077],
  [2.05877, 8.963207], [1.980126, 9.117556], [1.980124, 9.117562], [1.926597, 9.282302], [1.899501, 9.453378],
  [1.8995, 9.453393], [1.8995, 9.626606], [1.899501, 9.626621], [1.926597, 9.797697], [1.980124, 9.962437],
  [1.980126, 9.962443], [2.05877, 10.116792], [2.160581, 10.256922], [2.160583, 10.256924], [2.160586, 10.256928],
  [2.283072, 10.379414], [2.283075, 10.379416], [2.283077, 10.379418], [2.423207, 10.481229], [2.423209, 10.48123],
  [2.423212, 10.481232], [2.577555, 10.559873], [2.619338, 10.573449], [2.704104, 10.620919], [2.764253, 10.697216],
  [2.790625, 10.790723], [2.779207, 10.887205], [2.731736, 10.971973], [2.655439, 11.032122], [2.619342, 11.047074],
  [2.57775, 11.060588], [2.577741, 11.060592], [2.42348, 11.139192], [2.423473, 11.139196], [2.417261, 11.143708],
  [2.870591, 11.597037], [2.807007, 11.614075], [2.692993, 11.679901], [2.599901, 11.772993], [2.534075, 11.887007],
  [2.517037, 11.95059], [2.063708, 11.497261], [2.059196, 11.503473], [2.059192, 11.50348], [1.980592, 11.657741],
  [1.980586, 11.657754], [1.927085, 11.822415], [1.927085, 11.822416], [1.9, 11.993418], [1.9, 12.166581],
  [1.927085, 12.337583], [1.927085, 12.337584], [1.980586, 12.502245], [1.980592, 12.502258], [2.059193, 12.65652],
  [2.063708, 12.662736], [2.517037, 12.209407], [2.534075, 12.272993], [2.599901, 12.387007], [2.692993, 12.480099],
  [2.807007, 12.545925], [2.870589, 12.562962], [2.417261, 13.016289], [2.417261, 13.01629], [2.423475, 13.020804],
  [2.577741, 13.099407], [2.577754, 13.099413], [2.742416, 13.152914], [2.913418, 13.179999], [2.913431, 13.18],
  [3.086569, 13.18], [3.086581, 13.179999], [3.257583, 13.152914], [3.257584, 13.152914], [3.422245, 13.099413],
  [3.422258, 13.099407], [3.576523, 13.020805], [3.582736, 13.01629], [3.129408, 12.562962], [3.192993, 12.545925],
  [3.307007, 12.480099], [3.400099, 12.387007], [3.465925, 12.272993], [3.482962, 12.209408], [3.93629, 12.662736],
  [3.940805, 12.656523], [4.019407, 12.502258], [4.019413, 12.502245], [4.072914, 12.337584], [4.072914, 12.337583],
  [4.099999, 12.166581], [4.1, 12.166569], [4.1, 11.99343], [4.099999, 11.993418], [4.072914, 11.822416],
  [4.072914, 11.822415], [4.019413, 11.657754], [4.019407, 11.657741], [3.940804, 11.503475], [3.936289, 11.497261],
  [3.482962, 11.950589], [3.465925, 11.887007], [3.400099, 11.772993], [3.307007, 11.679901], [3.192993, 11.614075],
  [3.129407, 11.597036], [3.582736, 11.143708], [3.57652, 11.139193], [3.422258, 11.060592], [3.422246, 11.060587],
  [3.380658, 11.047074], [3.295892, 10.999601], [3.235744, 10.923303], [3.209373, 10.829796], [3.220794, 10.733314],
  [3.268267, 10.648548], [3.344565, 10.5884], [3.380657, 10.57345], [3.422445, 10.559873], [3.576788, 10.481232],
  [3.716928, 10.379414], [3.839414, 10.256928], [3.941232, 10.116788], [4.019873, 9.962445], [4.073402, 9.797701],
  [4.1005, 9.626611], [4.1005, 9.453389], [4.073402, 9.282299], [4.019873, 9.117555], [3.941232, 8.963212],
  [3.94123, 8.963209], [3.941229, 8.963207], [3.839418, 8.823077], [3.839416, 8.823075], [3.839414, 8.823072],
  [3.716928, 8.700586], [3.716924, 8.700583], [3.716922, 8.700581], [3.576791, 8.59877], [3.576788, 8.598768],
  [3.522998, 8.571361], [3.4467, 8.511214], [3.399227, 8.426446], [3.387807, 8.329965], [3.414179, 8.236458],
  [3.474326, 8.16016], [3.559094, 8.112687], [3.63604, 8.1005], [3.874675, 8.1005], [3.874675, 8.100499],
  [3.94774, 8.085966], [4.030601, 8.030601], [4.085966, 7.94774], [4.1005, 7.874674], [4.1005, 6.125326],
  [4.085966, 6.05226], [4.030601, 5.969399], [4.030599, 5.969397], [3.975607, 5.932653], [3.94774, 5.914034],
  [3.947739, 5.914033], [3.874676, 5.8995], [3.874674, 5.8995], [2.125326, 5.8995], [2.125323, 5.8995],
  [2.05226, 5.914033], [1.9694, 5.969397], [1.969397, 5.9694], [1.914033, 6.05226], [1.8995, 6.125323],
  [0.5005, 6.125323], [0.5005, 0.7495], [0.519454, 0.654212], [0.57343, 0.57343], [0.654212, 0.519454],
  [0.7495, 0.5005], [29.2505, 0.5005],
];

function rewrite(value: any, transform: (value: any) => any): any {
  const changed = transform(value);
  if (changed !== value) return changed;
  if (Array.isArray(value)) return value.map(child => rewrite(child, transform));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rewrite(child, transform)]));
  return value;
}
async function fixture(source = board([pad()]), outline?: number[][]) {
  const prepared = prepareFreshPlaneMutation({ compilationBundle: bundle, beforePcbSource: source, operation: "create" });
  const slot = source.includes("(drill oval 1 0.5)"), producerSource = slot ? source.replace("(drill oval 1 0.5)", "(drill 1)") : source;
  const f = await planeStageObservationFixture({ beforePcbSource: producerSource, mutation: prepared.mutation });
  let receipt = structuredClone(f.receipt) as Raw, stagedSource = f.stagedSource;
  let request = f.request, padExpected = f.padExpected;
  // The existing producer characterizes circular drills only. Adapt its entire
  // source/identity/native transcript and approved synthetic library together,
  // so the slot test reaches this assessor with a genuinely validated stage.
  if (slot) {
    const sources = [producerSource, f.stagedSource, String(receipt.nativeSourceUnfilled)];
    const replacements = new Map(sources.map(text => [text, text.replace("(drill 1)", "(drill oval 1 0.5)")]));
    const identities = new Map(sources.map(text => [contentIdentity(text).digest, contentIdentity(replacements.get(text)!)]));
    receipt = rewrite(receipt, value => {
      if (typeof value === "string" && replacements.has(value)) return replacements.get(value);
      if (value?.algorithm === "sha256" && identities.has(value.digest)) return identities.get(value.digest);
      if (value?.type === "PT_PTH" && value.pad_stack?.drill) return { ...value, pad_stack: { ...value.pad_stack,
        drill: { ...value.pad_stack.drill, shape: "DS_OBLONG", diameter: { x_nm: "1000000", y_nm: "500000" } } } };
      return value;
    });
    stagedSource = replacements.get(f.stagedSource)!;
    request = { ...request, request: { ...request.request, expectedSavedIdentity: contentIdentity(source), expectedLiveIdentity: contentIdentity(source) } };
    const sourcePads = parseFreshPcbSource(source).footprints[0]!.pads;
    const inspection = f.padExpected.physicalFootprintResolver!.inspectFootprint("Test:X")!;
    const sourceIdentity = contentIdentity(sourcePads.map(pad => pad.physical.source).join("\n"));
    const updated = { ...inspection, sourceIdentity, physicalPads: inspection.physicalPads.map((pad, i) => ({ ...pad, definitionKey: sourcePads[i]!.physical.definitionKey })) };
    padExpected = { ...padExpected, pcbSource: source, physicalFootprints: padExpected.physicalFootprints!.map(pin => ({ ...pin, sourceIdentity })),
      physicalFootprintResolver: { inspectFootprint: () => updated } };
  }
  if (outline) {
    const oldFill = parseFreshPcbReferenceGeometry(stagedSource).zones[0]!.filledPolygons[0]!.source;
    stagedSource = stagedSource.replace(oldFill, `(filled_polygon (layer "B.Cu") (pts ${outline.map(([x, y]) => `(xy ${x} ${y})`).join(" ")}))`);
    const polygon = { outline: { closed: true, nodes: outline.map(([x, y]) => ({ point: { x_nm: String(Math.round(x! * 1e6)), y_nm: String(Math.round(y! * 1e6)) } })) } };
    receipt = rewrite(receipt, value => {
      if (value === f.stagedSource) return stagedSource;
      if (value?.type === "ZT_COPPER" && value.filled === true) return { ...value, filled_polygons: [{ layer: "BL_B_Cu", shapes: { polygons: [polygon] } }] };
      return value;
    });
    const z = receipt.zonesStaged[0]; z.filledPolygons = { BL_B_Cu: [polygon] }; z.fillCounts.outlineNodeCount = outline.length;
    receipt.identities.nativeSourceStaged = contentIdentity(stagedSource);
  }
  const stage = validateFreshPlaneStageObservation(receipt, { request, padExpected, prepared });
  const savedEvidence = createSavedFreshPlaneEvidence({ compilationBundle: bundle, stage, savedPcbSource: stagedSource,
    projectBindingIdentity: canonicalIdentity({ fixture: "drill" }, "evleda.pcb-agent-plane-fresh-binding.v1"), sourceScopeIdentity: padExpected.scopeIdentity,
    projectSettingsIdentity: contentIdentity("{}\n"), rulesIdentity: prepared.rulesIdentity });
  return { savedEvidence, pcbSource: stagedSource, layer: "B.Cu" as const };
}
function unknown(result: ReturnType<typeof assessFreshPlaneDrillTopology>, issue?: RegExp) {
  expect(result.status).toBe("unknown"); expect(result.planarInteriorConnected).toBeNull();
  expect(result.conservativeAreaLowerBoundTwiceNm2).toBeNull(); expect(result.issues.length).toBeGreaterThan(0);
  if (issue) expect(result.issues.join(" ")).toMatch(issue);
}

describe("drill-aware single-zone interior topology", () => {
  it("subtracts an omitted same-net PTH bore conservatively while keeping cached area separate", async () => {
    const input = await fixture(), result = assessFreshPlaneDrillTopology(input);
    expect(result).toMatchObject({ status: "verified", planarInteriorConnected: true, classificationComplete: true, cachedAreaTwiceNm2: "1102000000000000",
      conservativeAreaLowerBoundTwiceNm2: "1100000000000000", inventory: { sourcePadCount: 1, nativePadCount: 1, sourceViaCount: 0, boreCount: 1, complete: true },
      physicalConnectivity: "not_assessed", actualMinimumCopperWidth: "not_assessed", terminalContactContinuity: "not_assessed" });
    expect(result.bores[0]).toMatchObject({ kind: "pad", netName: "GND", centerNm: { x: 5000000, y: 5000000 }, diameterNm: 1000000,
      classification: "new_interior_void", enclosureNm: { minX: 4500000, minY: 4500000, maxX: 5500000, maxY: 5500000 }, geometrySource: "exact-source-and-native-pad" });
    expect(result.savedEvidenceIdentity).toEqual(input.savedEvidence.identity); expect(Object.isFrozen(result.bores[0]!.centerNm)).toBe(true);
    const { identity, ...body } = result; expect(identity).toEqual(canonicalIdentity(body, result.schemaVersion));
  });

  it("proves a zero-bore source without claiming width, contacts, or an exact circle area", async () => {
    const result = assessFreshPlaneDrillTopology(await fixture(board([smd])));
    expect(result.status).toBe("verified"); expect(result.inventory).toMatchObject({ boreCount: 0, complete: true });
    expect(result.cachedAreaTwiceNm2).toBe(result.conservativeAreaLowerBoundTwiceNm2);
    expect(result).not.toHaveProperty("actualCopperAreaTwiceNm2");
  });

  it("accounts for different-net PADs and all through-vias without filtering their layers/nets", async () => {
    const input = await fixture(board([pad(), pad("10", "5", "0.5", "VIN")], via("15 5", "0.3", "", undefined, "VOUT")));
    const result = assessFreshPlaneDrillTopology(input);
    expect(result.status).toBe("verified"); expect(result.inventory).toMatchObject({ sourcePadCount: 2, nativePadCount: 2, sourceViaCount: 1, boreCount: 3, complete: true });
    expect(result.bores.map(bore => bore.netName)).toEqual(["GND", "VIN", "VOUT"]);
    expect(result.bores[2]).toMatchObject({ kind: "via", geometrySource: "exact-saved-through-via", classification: "new_interior_void" });
    expect(result.conservativeAreaLowerBoundTwiceNm2).toBe("1099320000000000");
  });

  it("accounts for through bores even when the PAD's copper is not flashed on the selected layer", async () => {
    const result = assessFreshPlaneDrillTopology(await fixture(board([pad().replace('"F.Cu" "B.Cu"', '"F.Cu"')])));
    expect(result.status).toBe("verified"); expect(result.inventory.boreCount).toBe(1);
  });

  it("does not subtract outside bores or bores wholly inside an existing excluded hole twice", async () => {
    const result = assessFreshPlaneDrillTopology(await fixture(board([pad(), pad("35", "5", "1", "VIN")]), holeChain));
    expect(result.status).toBe("verified"); expect(result.bores.map(bore => bore.classification)).toEqual(["inside_cached_hole", "outside_component"]);
    expect(result.cachedAreaTwiceNm2).toBe("1070000000000000"); expect(result.conservativeAreaLowerBoundTwiceNm2).toBe(result.cachedAreaTwiceNm2);
  });

  it("certifies an actual circle inside an oblique cached hole even when its AABB crosses the boundary", async () => {
    const diamond = [[0.5, 0.5], [29.5, 0.5], [29.5, 19.5], [0.5, 19.5], [0.5, 5], [3.5, 5],
      [5, 6.5], [6.5, 5], [5, 3.5], [3.5, 5], [0.5, 5]];
    const result = assessFreshPlaneDrillTopology(await fixture(board([pad("5", "5", "2")]), diamond));
    expect(result.status).toBe("verified");
    expect(result.bores[0]).toMatchObject({ classification: "inside_cached_hole", classificationBasis: "exact_circle_inside_cached_hole",
      enclosureNm: { minX: 4000000, minY: 4000000, maxX: 6000000, maxY: 6000000 } });
    expect(result.conservativeAreaLowerBoundTwiceNm2).toBe(result.cachedAreaTwiceNm2);
  });

  it("allows exact circle tangency only within an already excluded cached hole", async () => {
    const result = assessFreshPlaneDrillTopology(await fixture(board([pad("5", "5", "4")]), holeChain));
    expect(result.status).toBe("verified");
    expect(result.bores[0]).toMatchObject({ classification: "inside_cached_hole", classificationBasis: "exact_circle_inside_cached_hole" });
    expect(result.conservativeAreaLowerBoundTwiceNm2).toBe(result.cachedAreaTwiceNm2);
    // The bore center shifts exactly one nm, leaving one nm beyond the hole.
    unknown(assessFreshPlaneDrillTopology(await fixture(board([pad("5.000001", "5", "4")]), holeChain)), /intersect|touch/i);
  });

  it("uses endpoint distances at a concave cached-hole corner without a tolerance", async () => {
    const notchedHole = [[0.5, 0.5], [29.5, 0.5], [29.5, 19.5], [0.5, 19.5], [0.5, 7], [3, 7],
      [7, 7], [7, 6], [6, 5], [7, 4], [7, 3], [3, 3], [3, 7], [0.5, 7]];
    const result = assessFreshPlaneDrillTopology(await fixture(board([pad("5", "5", "2")]), notchedHole));
    expect(result.status).toBe("verified"); expect(result.bores[0]!.classificationBasis).toBe("exact_circle_inside_cached_hole");
    unknown(assessFreshPlaneDrillTopology(await fixture(board([pad("5.000001", "5", "2")]), notchedHole)), /intersect|touch/i);
  });

  it("rounds odd-nanometre diameters outward and computes the integer area bound exactly", async () => {
    const result = assessFreshPlaneDrillTopology(await fixture(board([pad("5", "5", "0.000003")])));
    expect(result.status).toBe("verified"); expect(result.bores[0]!.enclosureNm).toEqual({ minX: 4999998, minY: 4999998, maxX: 5000002, maxY: 5000002 });
    expect(BigInt(result.cachedAreaTwiceNm2!) - BigInt(result.conservativeAreaLowerBoundTwiceNm2!)).toBe(32n);
  });

  it.each([0, 90, 180, 270])("uses the exact clockwise %s-degree footprint transform", async rotation => {
    const result = assessFreshPlaneDrillTopology(await fixture(board([pad("1", "2")], "", String(rotation), "10 10")));
    expect(result.status).toBe("verified");
    expect(result.bores[0]!.centerNm).toEqual([{ x: 11000000, y: 12000000 }, { x: 12000000, y: 9000000 }, { x: 9000000, y: 8000000 }, { x: 8000000, y: 11000000 }][rotation / 90]);
  });

  it.each([
    ["touching outer edge", [pad("1", "5")]],
    ["crossing outer edge", [pad("0.75", "5")]],
    ["overlapping bore enclosures", [pad(), pad("5.75", "5", "1", "VIN")]],
    ["touching bore enclosures", [pad(), pad("6", "5", "1", "VIN")]],
    ["duplicate physical centers", [pad(), pad("5", "5", "1", "VIN")]],
  ] as const)("returns unknown for %s rather than inventing a physical failure", async (_name, pads) => {
    unknown(assessFreshPlaneDrillTopology(await fixture(board([...pads]))), /touch|overlap|intersect/i);
  });

  it("returns unknown when a bore/enclosure touches or surrounds a whole cached hole/component", async () => {
    unknown(assessFreshPlaneDrillTopology(await fixture(board([pad("2.5", "5")]), holeChain)), /intersect|touch/i);
    unknown(assessFreshPlaneDrillTopology(await fixture(board([pad("5", "5", "6")]), holeChain)), /surrounds/i);
    unknown(assessFreshPlaneDrillTopology(await fixture(board([pad("15", "10", "40")]))), /surrounds/i);
  });

  it("does not use corners-only containment across a concave boundary", async () => {
    const concave = [[0.5, 0.5], [29.5, 0.5], [29.5, 19.5], [0.5, 19.5], [0.5, 5.2], [6, 5.2], [6, 4.8], [0.5, 4.8]];
    unknown(assessFreshPlaneDrillTopology(await fixture(board([pad()]), concave)), /intersect/i);
  });

  it.each([
    ["slot", () => board([pad("5", "5", "oval 1 0.5")]), /Slots/i],
    ["offset", () => board([pad("5", "5", "1 (offset 0.1 0)")]), /offset/i],
    ["noncardinal footprint", () => board([pad("1", "2")], "", "45", "10 10"), /projection/i],
    ["subnanometre bore", () => board([pad("5", "5", "0.0000014")]), /exactly integer/i],
    ["subnanometre local center", () => board([pad("5.0000004", "5")]), /exactly integer/i],
    ["non-through via token", () => board([smd], via("10 10", "0.3", "blind")), /uncharacterized/i],
  ] as const)("rejects unsupported %s despite any permissive ordinary projection", async (_name, source, issue) => {
    unknown(assessFreshPlaneDrillTopology(await fixture(source())), issue);
  });

  it("accepts explicit zero drill offset, but refuses out-of-bound envelopes", async () => {
    expect(assessFreshPlaneDrillTopology(await fixture(board([pad("5", "5", "1 (offset 0 0)")]))).status).toBe("verified");
    const result = assessFreshPlaneDrillTopology(await fixture(board([pad("1999.9", "5", "1")])));
    unknown(result, /bounds/i);
    expect(result.inventory).toMatchObject({ complete: true, boreCount: 1 }); expect(result.bores).toHaveLength(1);
    expect(result.bores[0]).toMatchObject({ centerNm: { x: 1999900000, y: 5000000 }, diameterNm: 1000000,
      enclosureNm: null, classification: "unknown", classificationBasis: "not_certified" });
  });

  it("retains every trusted bore before an unavailable filled-component certificate", async () => {
    const crossing = [[0.5, 0.5], [29.5, 19.5], [0.5, 19.5], [29.5, 0.5]];
    const result = assessFreshPlaneDrillTopology(await fixture(board([pad(), pad("10", "5", "1", "VIN")], via("15 5")), crossing));
    unknown(result, /normalized/i);
    expect(result.inventory).toMatchObject({ complete: true, boreCount: 3 }); expect(result.bores).toHaveLength(3);
    expect(result.classificationComplete).toBe(false);
    expect(result.bores.every(bore => bore.classification === "not_classified" && bore.issues.length > 0)).toBe(true);
    expect(result.bores.map(bore => bore.diameterNm)).toEqual([1000000, 1000000, 300000]);
  });

  it("continues after separate unknown bore relations and reports every known issue", async () => {
    const result = assessFreshPlaneDrillTopology(await fixture(board([pad("1", "5"), pad("1", "10", "1", "VIN")], via("15 5"))));
    unknown(result, /intersects or touches/i);
    expect(result.inventory).toMatchObject({ complete: true, boreCount: 3 }); expect(result.bores).toHaveLength(3);
    expect(result.bores.map(bore => bore.classification)).toEqual(["unknown", "unknown", "new_interior_void"]);
    expect(result.bores.slice(0, 2).every(bore => bore.issues.some(issue => issue.includes("intersects or touches")))).toBe(true);
    expect(result.issues).toHaveLength(2);
  });

  it("bounds overlap diagnostics per bore while retaining every overlapping bore", async () => {
    const count = 24;
    const vias = Array.from({ length: count }, (_, i) => via("10 10", "0.3", "", `44444444-4444-4444-8444-${String(i + 1).padStart(12, "0")}`));
    const result = assessFreshPlaneDrillTopology(await fixture(board([smd], vias.join(" "))));
    unknown(result, /overlap/i);
    expect(result.inventory).toMatchObject({ complete: true, boreCount: count }); expect(result.bores).toHaveLength(count);
    expect(result.issues).toHaveLength(count); expect(result.bores.every(bore => bore.issues.length === 1 && bore.classification === "unknown")).toBe(true);
    expect(result.classificationComplete).toBe(false);
  });

  it("replays historical plane05 geometry without losing the GND bore or later via after an unknown intersection", async () => {
    // These are the recorded three PTH bores, via, and fill contour, transplanted
    // into the synthetic test producer. No historical witness is reauthenticated.
    const padIds = ["d0e64ecf-cdb2-4ec3-80d3-3698d5395285", "3a9900f4-821a-4a99-891c-08c2ea5f391e", "acbd5ddd-8ffc-4eb6-b12e-9f58c591eaf3"];
    const viaId = "637d9ff0-0a64-4e67-89a0-d99fae271a5b";
    let source = board([pad("3", "7", "1", "VIN"), pad("3", "9.54", "1", "VOUT"), pad("3", "12.08", "1", "GND")], via("20.825 10.475", "0.3", "", viaId));
    const syntheticIds = parseFreshPcbSource(source).footprints[0]!.pads.map(pad => pad.physical.id!);
    syntheticIds.forEach((id, index) => { source = source.replace(id, padIds[index]!); });
    const result = assessFreshPlaneDrillTopology(await fixture(source, plane05Chain));
    unknown(result, /intersects or touches/i);
    expect(plane05Chain).toHaveLength(212); expect(result.cachedAreaTwiceNm2).toBe("1078418742011869");
    expect(result.inventory).toMatchObject({ complete: true, boreCount: 4 }); expect(result.bores).toHaveLength(4);
    expect(result.classificationComplete).toBe(false);
    expect(result.bores.map(bore => bore.uuid)).toEqual([...padIds, viaId]);
    expect(result.bores.map(bore => bore.classification)).toEqual(["inside_cached_hole", "inside_cached_hole", "unknown", "new_interior_void"]);
    expect(result.bores[2]).toMatchObject({ centerNm: { x: 3000000, y: 12080000 }, diameterNm: 1000000, classificationBasis: "not_certified" });
    expect(result.bores[3]).toMatchObject({ centerNm: { x: 20825000, y: 10475000 }, diameterNm: 300000, geometrySource: "exact-saved-through-via", issues: [] });
    expect(result.issues).toHaveLength(1); expect(result.issues[0]).toContain(padIds[2]);
    expect(result.issues[0]).not.toContain("intersects/touches");
    // The exact recorded nearest vertex is inside the physical radius. This
    // remains a real circle/cache intersection; no nanometre tolerance is used.
    const dx = 3482962n - 3000000n, dy = 12209408n - 12080000n;
    expect(dx * dx + dy * dy).toBe(249998723908n); expect(dx * dx + dy * dy).toBeLessThan(500000n ** 2n);
  });

  it("rejects copied/serialized witnesses and any source/layer mismatch", async () => {
    const input = await fixture();
    unknown(assessFreshPlaneDrillTopology({ ...input, savedEvidence: structuredClone(input.savedEvidence) }), /genuine/i);
    unknown(assessFreshPlaneDrillTopology({ ...input, savedEvidence: JSON.parse(JSON.stringify(input.savedEvidence)) }), /genuine/i);
    unknown(assessFreshPlaneDrillTopology({ ...input, pcbSource: input.pcbSource + "\n" }), /differs/i);
    unknown(assessFreshPlaneDrillTopology({ ...input, layer: "F.Cu" }), /normalized/i);
  });

  it("captures wrapper inputs once so checked source bytes cannot change during assessment", async () => {
    const input = await fixture(board([smd], via())); let sourceReads = 0, layerReads = 0;
    const result = assessFreshPlaneDrillTopology({ savedEvidence: input.savedEvidence,
      get pcbSource() { sourceReads++; return sourceReads === 1 ? input.pcbSource : input.pcbSource.replace("(drill 0.3)", "(drill 0.2)"); },
      get layer() { layerReads++; return layerReads === 1 ? "B.Cu" : "F.Cu"; } });
    expect(result.status).toBe("verified"); expect(sourceReads).toBe(1); expect(layerReads).toBe(1);
    expect(result.bores[0]!.diameterNm).toBe(300000); expect(result.layer).toBe("B.Cu");
  });
});
