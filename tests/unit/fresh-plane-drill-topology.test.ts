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
    expect(result).toMatchObject({ status: "verified", planarInteriorConnected: true, cachedAreaTwiceNm2: "1102000000000000",
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
    unknown(assessFreshPlaneDrillTopology(await fixture(board([pad("1999.9", "5", "1")]))), /bounds/i);
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
