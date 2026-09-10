import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { compareFreshPlaneLiteralMutation, compareFreshPlaneMutation, prepareFreshPlaneMutation } from "../../src/harness/fresh-plane-mutation.js";
import { parseFreshPcbRouteSourceSpans } from "../../src/harness/fresh-kicad-parser.js";
import type { PlaneRectangleMutation } from "../../src/integrations/kicad-plane-stage.js";
import { genericDividerLibraryResolver } from "../helpers/generic-divider-bundle.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";

const Z = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TRACK = "11111111-1111-4111-8111-111111111111", PAD = "22222222-2222-4222-8222-222222222222";
const VIA = "33333333-3333-4333-8333-333333333333";
const request = (extra: Record<string, unknown> = {}): PlaneRectangleMutation => ({ operation: "create", netName: "GND", layer: "B.Cu",
  rectangleNm: { x1: 1000000, y1: 1000000, x2: 9000000, y2: 9000000 }, clearanceNm: 300000, minWidthNm: 250000,
  connection: "thermal", thermalGapNm: 500000, thermalSpokeWidthNm: 500000, minimumSpokes: 2,
  islandPolicy: "always", priority: 0, name: "HOST_PLANE", ...extra } as PlaneRectangleMutation);
const decimal = (value: bigint, scale: number) => {
  const text = value.toString().padStart(scale + 1, "0"); const fraction = text.slice(-scale).replace(/0+$/u, "");
  return text.slice(0, -scale) + (fraction ? "." + fraction : "");
};
const mm = (value: number) => decimal(BigInt(value), 6);
function zone(m: PlaneRectangleMutation, uuid = Z, filled = true, gap = 500000, spoke = 500000, cache?: string) {
  const r = m.rectangleNm, points = `(xy ${mm(r.x1)} ${mm(r.y1)}) (xy ${mm(r.x2)} ${mm(r.y1)}) (xy ${mm(r.x2)} ${mm(r.y2)}) (xy ${mm(r.x1)} ${mm(r.y2)})`;
  return `(zone (net "${m.netName}") (layer "${m.layer}") (uuid "${uuid}") (name "${m.name}") (hatch edge 0.5)
    ${m.priority === 0 ? "" : `(priority ${m.priority})`} (connect_pads ${m.connection === "full" ? "yes" : ""} (clearance ${mm(m.clearanceNm)})) (min_thickness ${mm(m.minWidthNm)})
    (fill ${filled ? "yes" : ""} (thermal_gap ${mm(m.connection === "thermal" ? m.thermalGapNm : gap)}) (thermal_bridge_width ${mm(m.connection === "thermal" ? m.thermalSpokeWidthNm : spoke)})
      (island_removal_mode ${{ always: 0, never: 1, area: 2 }[m.islandPolicy]}) ${m.islandPolicy === "area" ? `(island_area_min ${decimal(BigInt(m.minIslandAreaNm2), 12)})` : ""})
    (polygon (pts ${points})) ${filled ? `(filled_polygon (layer "${m.layer}") (pts ${cache ?? points}))` : ""})`;
}
const track = `(segment (start 1 2) (end 8 2) (width 0.25) (layer "F.Cu") (net "GND") (uuid "${TRACK}"))`;
const via = `(via (at 3 2) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "GND") (uuid "${VIA}"))`;
const board = (zones = "", extra = "") => `(kicad_pcb (version 20260206) (generator "pcbnew") (generator_version "10.0")
  (general (thickness 1.6)) (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
  (property "note" "literal (zone) and filled_polygon text")
  (footprint "Test:X" (layer "B.Cu") (at 1 1) (property "Reference" "J1") (property "Value" "TEST")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "B.Cu") (net "GND") (uuid "${PAD}")))
  ${track} ${zones} ${extra})\n`;
function proto(m: PlaneRectangleMutation, uuid = Z, gap = 500000, width = 500000, area?: string): Record<string, any> {
  const r = m.rectangleNm;
  return { id: { value: uuid }, type: "ZT_COPPER", layers: [m.layer === "F.Cu" ? "BL_F_Cu" : "BL_B_Cu"], name: m.name,
    ...(m.priority ? { priority: m.priority } : {}),
    outline: { polygons: [{ outline: { nodes: [[r.x1, r.y1], [r.x2, r.y1], [r.x2, r.y2], [r.x1, r.y2]].map(([x, y]) => ({ point: { x_nm: String(x), y_nm: String(y) } })), closed: true } }] },
    copper_settings: { connection: { zone_connection: m.connection === "full" ? "ZCS_FULL" : "ZCS_THERMAL",
      thermal_spokes: { gap: { value_nm: String(m.connection === "thermal" ? m.thermalGapNm : gap) }, width: { value_nm: String(m.connection === "thermal" ? m.thermalSpokeWidthNm : width) } } },
      clearance: { value_nm: String(m.clearanceNm) }, min_thickness: { value_nm: String(m.minWidthNm) }, fill_mode: "ZFM_SOLID",
      island_mode: { always: "IRM_ALWAYS", never: "IRM_NEVER", area: "IRM_AREA" }[m.islandPolicy], net: { name: m.netName },
      ...(m.islandPolicy === "area" ? { min_island_area: m.minIslandAreaNm2 } : area === undefined ? {} : { min_island_area: area }),
      teardrop: { type: "TDT_NONE" } }, border: { style: "ZBS_DIAGONAL_EDGE", pitch: { value_nm: "500000" } } };
}
const compare = (m: PlaneRectangleMutation, before: string, after: string, native = proto(m), oldNative?: unknown) => compareFreshPlaneLiteralMutation({ mutation: m,
  beforePcbSource: before, afterPcbSource: after, returnedZoneProto: native, ...(oldNative === undefined ? {} : { beforeZoneProto: oldNative }), phase: "refilled" });

describe("closed plane mutation source and native-control comparison", () => {
  it("validates create while preserving all other settings and allowing only their qualified-refill cache changes", () => {
    const m = request(), other = request({ name: "OTHER_PLANE" });
    const before = board(zone(other, OTHER));
    const after = board(zone(m) + zone(other, OTHER, true, 500000, 500000, "(xy 1 1) (xy 8 1) (xy 8 9) (xy 1 9)"));
    const result = compare(m, before, after);
    expect(result).toMatchObject({ valid: true, status: "conformant", binding: "host-literal-only", beforeIdentity: contentIdentity(before), afterIdentity: contentIdentity(after),
      sourceComparison: { equal: true, extraZoneUuids: [OTHER] }, acceptanceEvaluated: false, nativeEpochValidated: false, dcConnectivity: "not_evaluated", thermalAcceptance: "not_evaluated" });
    expect(result.sourceComparison.nonTargetRefillChanges[0]!.cacheChanged).toBe(true);
    expect(result.observed.minimumSpokes).toMatchObject({ required: 2, zoneApiConfigured: false });
  });

  it("validates update without dropping inactive native/source fields or changing target identity", () => {
    const beforeRequest = request({ connection: "full", thermalGapNm: undefined, thermalSpokeWidthNm: undefined, minimumSpokes: undefined });
    delete (beforeRequest as any).thermalGapNm; delete (beforeRequest as any).thermalSpokeWidthNm; delete (beforeRequest as any).minimumSpokes;
    const update = { ...beforeRequest, operation: "update" as const, zoneId: Z, clearanceNm: 400000, minWidthNm: 300000, name: "UPDATED" };
    const before = board(zone(beforeRequest)), after = board(zone(update));
    const result = compare(update, before, after, proto(update, Z, 500000, 500000, "10000000000000"), proto(beforeRequest, Z, 500000, 500000, "10000000000000"));
    expect(result.valid).toBe(true);
    expect(result.observed.islandMinimumArea.status).toBe("not-serialized-not-enforced");
    expect(result.observed.native.inactiveNativeAreaNm2).toBe("10000000000000");
    expect(compare(update, before, board(zone(update, Z, true, 600000)), proto(update, Z, 600000, 500000, "10000000000000"), proto(beforeRequest, Z, 500000, 500000, "10000000000000")).valid).toBe(false);
  });

  it("handles active area as exact decimal strings above JS safe integers", () => {
    const m = request({ islandPolicy: "area", minIslandAreaNm2: "250000000000000000" });
    const result = compare(m, board(), board(zone(m)));
    expect(result.valid).toBe(true);
    expect(result.observed.islandMinimumArea).toMatchObject({ status: "explicit-active", requiredNm2: "250000000000000000", sourceMm2: "250000" });
    const incorrect = proto(m); incorrect.copper_settings.min_island_area = 250000000000000000;
    expect(() => compare(m, board(), board(zone(m)), incorrect)).toThrow(/integer string|MAX_SAFE_INTEGER/u);
  });

  it.each([
    ["name", '"HOST_PLANE"', '"RENAMED"'], ["net", '(net "GND")', '(net "OTHER")'],
    ["clearance", '(clearance 0.3)', '(clearance 0.4)'], ["minimum width", '(min_thickness 0.25)', '(min_thickness 0.3)'],
    ["thermal gap", '(thermal_gap 0.5)', '(thermal_gap 0.6)'], ["island mode", '(island_removal_mode 0)', '(island_removal_mode 1)'],
    ["rectangle", '(xy 9 1)', '(xy 8 1)'],
  ])("rejects target %s mismatch", (_label, from, to) => {
    const m = request(); expect(() => compare(m, board(), board(zone(m).replace(from!, to!)))).toThrow();
  });

  it.each([
    ["non-zone thickness", '(thickness 1.6)', '(thickness 1.7)'],
    ["non-zone literal", 'literal (zone) and filled_polygon text', 'changed literal'],
    ["unselected track", '(width 0.25)', '(width 0.3)'],
  ])("does not exclude %s drift", (_label, from, to) => {
    const m = request(); expect(compare(m, board(), board(zone(m)).replace(from!, to!)).valid).toBe(false);
  });

  it("rejects changed other-zone settings, extra zones, duplicate names and hidden nested target data", () => {
    const m = request(), other = request({ name: "OTHER_PLANE" }), original = board(zone(other, OTHER));
    expect(compare(m, original, board(zone(m) + zone(other, OTHER).replace('(thermal_gap 0.5)', '(thermal_gap 0.6)'))).valid).toBe(false);
    expect(() => compare(m, board(), board(zone(m) + zone(other, OTHER)))).toThrow("non-target zone");
    expect(() => compare(m, original, board(zone(m) + zone(request(), OTHER)))).toThrow("name is ambiguous");
    expect(() => compare(m, board(), board(zone(m).replace('(min_thickness 0.25)', '(min_thickness 0.25) (footprint "hidden" (layer "B.Cu"))')))).toThrow("unsupported zone source");
  });

  it("distinguishes immediate unfilled mutation from post-refill source and rejects identity substitution", () => {
    const m = request(), before = board(), after = board(zone(m, Z, false));
    expect(compareFreshPlaneLiteralMutation({ mutation: m, beforePcbSource: before, afterPcbSource: after, returnedZoneProto: proto(m), phase: "mutation" }).valid).toBe(true);
    expect(() => compare(m, before, after)).toThrow("filled state");
    expect(() => compare(m, before, board(zone(m)), proto(m, OTHER))).toThrow("target zone");
  });

  it("cross-checks observed border defaults and rejects uncharacterized native overrides", () => {
    const m = request(), before = board(), after = board(zone(m));
    const wrongBorder = proto(m); wrongBorder.border.pitch.value_nm = "600000";
    expect(() => compare(m, before, after, wrongBorder)).toThrow("hatch border observations differ");
    const teardrop = proto(m); teardrop.copper_settings.teardrop.type = "TDT_VIA_PAD";
    expect(() => compare(m, before, after, teardrop)).toThrow("active teardrop");
    const layerOverride = proto(m); layerOverride.layer_properties = [{ layer: "BL_B_Cu", hatching_offset: {} }];
    expect(() => compare(m, before, after, layerOverride)).toThrow("per-layer overrides");
    const angle = proto(m); angle.copper_settings.connection.thermal_spokes.angle = {};
    expect(() => compare(m, before, after, angle)).toThrow("unsupported fields");
    expect(() => compare(m, before, after.replace('(hatch edge 0.5)', '(hatch edge 0.5) (hatch full 0.5)'))).toThrow(/duplicate|unsupported zone source/u);
    const nativeFullBorder = proto(m); nativeFullBorder.border.style = "ZBS_DIAGONAL_FULL";
    expect(compare(m, before, after.replace('(hatch edge 0.5)', '(hatch full 0.5)'), nativeFullBorder).valid).toBe(true);
  });

  it("uses existing strict native serializer aliases after save without normalizing original identities", () => {
    const m = request(), before = board().replaceAll("\n", "\r\n"), after = board(zone(m));
    const result = compare(m, before, after);
    expect(result.valid).toBe(true); expect(result.beforeIdentity).toEqual(contentIdentity(before));
    expect(compare(m, before, after + "\n").valid).toBe(false);
  });

  it("derives real V2 specs and keeps inactive island/minimum-spoke requirements outside mutation acceptance", () => {
    const dependencies = { libraryResolver: genericDividerLibraryResolver, deepRuleCatalog: loadDeepRuleCatalog() };
    const compilation = compilePcbPlaneDesignIntentDraft(planeDividerDraft(), dependencies);
    if (compilation.disposition !== "ready") throw new Error(JSON.stringify(compilation.issues));
    const bundle = createPcbPlaneCompilationBundle({ compilation, originalPrompt: "Synthetic V2 plane mutation." }, dependencies);
    const before = board(); const prepared = prepareFreshPlaneMutation({ compilationBundle: bundle, beforePcbSource: before, operation: "create" });
    expect(prepared.mutation).toMatchObject({ name: `EVLEDA_PLANE_${bundle.identity.digest.slice(0, 12)}_P01`, islandPolicy: "always", priority: 0 });
    expect(prepared.mutation).not.toHaveProperty("minIslandAreaNm2");
    expect(prepared.requirements).toMatchObject({ minimumAreaEnforcement: "not-enforced-by-always-mode", minimumSpokes: 2, spokeEnforcement: "external-owned-rule-and-native-evidence" });
    const result = compareFreshPlaneMutation({ prepared, afterPcbSource: board(zone(prepared.mutation)), returnedZoneProto: proto(prepared.mutation), phase: "refilled" });
    expect(result).toMatchObject({ valid: true, binding: "authenticated-v2-mutation-spec", bundleIdentity: bundle.identity, acceptanceEvaluated: false });
    expect(() => prepareFreshPlaneMutation({ compilationBundle: structuredClone(bundle), beforePcbSource: before, operation: "create" })).toThrow("authenticated");
    expect(() => compareFreshPlaneMutation({ prepared: structuredClone(prepared), afterPcbSource: board(zone(prepared.mutation)), returnedZoneProto: proto(prepared.mutation), phase: "refilled" })).toThrow("original in-process");
    const wrong = { ...prepared.mutation, minWidthNm: 600000 };
    const existing = board(zone(wrong));
    const update = prepareFreshPlaneMutation({ compilationBundle: bundle, beforePcbSource: existing, operation: "update", zoneId: Z });
    expect(compareFreshPlaneMutation({ prepared: update, afterPcbSource: board(zone(update.mutation)), returnedZoneProto: proto(update.mutation),
      beforeZoneProto: proto(wrong), phase: "refilled" }).valid).toBe(true);
    expect(() => prepareFreshPlaneMutation({ compilationBundle: bundle, beforePcbSource: existing, operation: "create" })).toThrow("duplicate");
  });

  it("exports only exact characterized direct track/via spans and rejects nested or optional modifier loss", () => {
    const source = board("", via); const spans = parseFreshPcbRouteSourceSpans(source);
    expect(spans.map(span => [span.kind, span.id])).toEqual([["track", TRACK], ["via", VIA]]);
    expect(source.slice(spans[0]!.start, spans[0]!.end)).toBe(track);
    expect(source.slice(spans[1]!.start, spans[1]!.end)).toBe(via);
    expect(() => parseFreshPcbRouteSourceSpans(source.replace('(width 0.25)', '(width 0.25) (locked yes)'))).toThrow("modifiers");
    expect(() => parseFreshPcbRouteSourceSpans(board("", `(footprint "hidden" ${via})`))).toThrow("Nested route");
  });
});

// Optional replay of already-closed evidence files: no native program is launched.
const recorded = [
  ["create", "D:/EvlEDA-plane-stage-native-20260909-02/create-receipt.json"],
  ["update", "D:/EvlEDA-plane-stage-native-20260909-03/update-receipt.json"],
] as const;
describe("closed native mutation source evidence replay", () => {
  for (const [kind, filename] of recorded) it.skipIf(!existsSync(filename))(`rechecks captured ${kind} source/proto without a native launch`, async () => {
    const receipt = JSON.parse(await readFile(filename, "utf8")); const mutation = receipt.zoneMutation;
    const result = compareFreshPlaneLiteralMutation({ mutation: mutation.request, beforePcbSource: receipt.nativeSourceBefore,
      afterPcbSource: receipt.nativeSourceStaged, returnedZoneProto: mutation.returnedProto,
      ...(kind === "update" ? { beforeZoneProto: receipt.zonesBefore.find((zone: any) => zone.uuid === mutation.zoneId).raw } : {}), phase: "refilled" });
    expect(result.valid).toBe(true); expect(result.acceptanceEvaluated).toBe(false);
    expect(result.beforeIdentity).toEqual(contentIdentity(receipt.nativeSourceBefore)); expect(result.afterIdentity).toEqual(contentIdentity(receipt.nativeSourceStaged));
  });
});
