import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { validateFreshPlaneLiteralStageObservation, validateFreshPlaneStageObservation, isValidatedFreshPlaneStageObservation } from "../../src/harness/fresh-plane-stage-observation.js";
import type { KicadPlaneStageInput } from "../../src/integrations/kicad-plane-stage.js";
import { prepareFreshPlaneMutation } from "../../src/harness/fresh-plane-mutation.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { genericDividerLibraryResolver } from "../helpers/generic-divider-bundle.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";
import { planeStageObservationFixture } from "../helpers/plane-stage-observation-fixture.js";
import { withNativePadFixtureIds } from "../helpers/native-pad-observation-fixture.js";
import { compactPlaneStageFixture } from "../helpers/compact-plane-stage-fixture.js";

const source = withNativePadFixtureIds(`(kicad_pcb (version 20260206) (generator "pcbnew") (generator_version "10.0")
  (general (thickness 1.6)) (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
  (footprint "Test:X" (layer "F.Cu") (at 2 2) (property "Reference" "J1") (property "Value" "TEST")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "GND"))))\n`);
function bundle() {
  const dependencies = { libraryResolver: genericDividerLibraryResolver, deepRuleCatalog: loadDeepRuleCatalog() };
  const compilation = compilePcbPlaneDesignIntentDraft(planeDividerDraft(), dependencies);
  if (compilation.disposition !== "ready") throw new Error(JSON.stringify(compilation.issues));
  return createPcbPlaneCompilationBundle({ compilation, originalPrompt: "Synthetic offline stage validation." }, dependencies);
}
async function fixture() {
  const compilationBundle = bundle(), prepared = prepareFreshPlaneMutation({ compilationBundle, beforePcbSource: source, operation: "create" });
  const f = await planeStageObservationFixture({ beforePcbSource: source, mutation: prepared.mutation });
  return { ...f, prepared, compilationBundle };
}
describe.each(["v1", "v2"])("source-bound plane stage adapter %s", encoding => {
  const validate = (receipt: Record<string, any>, expected: Parameters<typeof validateFreshPlaneStageObservation>[1]) =>
    validateFreshPlaneStageObservation(encoding === "v2" ? compactPlaneStageFixture(receipt) : receipt, expected);
  it("validates authenticated CREATE then source-equivalent UPDATE without minting saved/PAD host authority", async () => {
    const f = await fixture(), first = validate(f.receipt, f);
    expect(isValidatedFreshPlaneStageObservation(first)).toBe(true);
    expect(isValidatedFreshPlaneStageObservation(structuredClone(first))).toBe(false);
    expect(first).toMatchObject({ savedAuthorityMinted: false, acceptanceEvaluated: false, nativePadsSource: "validated-staged-native-not-saved", beforeZoneProto: null,
      comparison: { binding: "authenticated-v2-mutation-spec", acceptanceEvaluated: false } });
    expect(first.nativePads.savedPcbIdentity).toEqual(contentIdentity(f.stagedSource));
    expect(first.savedSourceIdentity).toEqual(contentIdentity(source));
    const prepared = prepareFreshPlaneMutation({ compilationBundle: f.compilationBundle, beforePcbSource: f.stagedSource, operation: "update", zoneId: first.targetZoneUuid });
    const update = await planeStageObservationFixture({ beforePcbSource: f.stagedSource, mutation: prepared.mutation, beforeZoneProtos: [f.stagedZoneProto] });
    const result = validate(update.receipt, { ...update, prepared });
    expect(result.beforeZoneProto).toEqual(f.stagedZoneProto); expect(result.nativeSourceStaged).toBe(f.stagedSource);
  });
  it("binds explicit board path and a source-owned PAD selection, without decoder mocks", async () => {
    const f = await fixture();
    const request = { ...f.request, board_file: "D:\\owned-stage-test\\exact-board.kicad_pcb" };
    const rebound = await planeStageObservationFixture({ beforePcbSource: source, request });
    expect(validate(rebound.receipt, { ...rebound, prepared: f.prepared }).comparison.valid).toBe(true);
  });
  it.each([
    ["disk changed", (r: any) => { r.savedSourceStaged += "\n"; }],
    ["preimage echo", (r: any) => { r.request.expectedLiveIdentity.digest = "0".repeat(64); }],
    ["wrong document", (r: any) => { r.document.project.path = "D:\\different"; }],
    ["partial inventory", (r: any) => { r.zonesUnfilled = []; }],
    ["false unfilled witness", (r: any) => { r.zonesUnfilled[0].filled = true; }],
    ["fabricated count", (r: any) => { r.zonesStaged[0].fillCounts.polygonCount++; }],
    ["invented epoch", (r: any) => { r.epoch.busyPollCount = 1; }],
    ["unbound source hash", (r: any) => { r.identities.nativeSourceStaged.digest = "0".repeat(64); }],
    ["unsaved PAD source substituted", (r: any) => { r.padSnapshot.boardSourceBefore = r.savedSourceBefore; }],
    ["PAD filter weakened", (r: any) => { r.padSnapshot.connectivity[0].request.types = []; }],
    ["raw PAD query replaced", (r: any) => { r.rpc.find((c: any) => c.requestType.endsWith("GetConnectedItems")).response.items = []; }],
    ["partial raw zone response", (r: any) => { r.rpc.find((c: any) => c.request.types?.[0] === "KOT_PCB_ZONE").response.header = { field_mask: { paths: ["id"] } }; }],
    ["extra native save", (r: any) => { r.rpc.push({ requestType: "kiapi.common.commands.SaveDocument", request: {}, responseType: "kiapi.common.commands.SaveDocumentResponse", response: {} }); }],
    ["spurious configured minimum spokes", (r: any) => { r.zoneMutation.minimumSpokes.configured = true; }],
    ["inactive area promoted", (r: any) => { r.zoneMutation.islandMinimumArea.enforced = true; }],
  ])("rejects %s", async (_name, change) => {
    const f = await fixture(), receipt = structuredClone(f.receipt); change(receipt);
    expect(() => validate(receipt, f)).toThrow();
  });
  it("requires ordered raw unfill before fill even when both acknowledgements are present", async () => {
    const f = await fixture(), receipt = structuredClone(f.receipt), actions = receipt.rpc.filter((call: any) => call.requestType.endsWith("RunAction"));
    [actions[0].request, actions[1].request] = [actions[1].request, actions[0].request];
    expect(() => validate(receipt, f)).toThrow("epoch actions");
  });
  it("allows only bounded AS_BUSY zone polling between fill and observed filled inventory", async () => {
    const f = await fixture(), receipt = structuredClone(f.receipt), fill = receipt.rpc.findIndex((call: any) => call.request.action === "pcbnew.ZoneFiller.zoneFillAll");
    const error = { requestType: "kiapi.common.commands.GetItems", request: { header: { document: receipt.document }, types: ["KOT_PCB_ZONE"] }, error: { type: "ApiError", code: 7, message: "busy" } };
    receipt.rpc.splice(fill + 1, 0, error); receipt.epoch.busyPollCount = 1;
    expect(validate(receipt, f).epochStatus).toBe("raw-transcript-observed-unfill-fill");
    error.error.code = 2; expect(() => validate(receipt, f)).toThrow("unqualified RPC error");
  });
  it("does not accept copied preparation tokens or mismatched PAD ownership", async () => {
    const f = await fixture();
    expect(() => validate(f.receipt, { ...f, prepared: structuredClone(f.prepared) })).toThrow("original in-process");
    const request = structuredClone(f.request); request.reference_pads[0]!.reference = "J999";
    expect(() => validate(f.receipt, { ...f, request })).toThrow("ownership");
  });
});

// Independent recorded producer receipts. Reading these never launches native KiCad.
for (const operation of ["create", "update"] as const) {
  const filename = `D:/EvlEDA-plane-stage-native-20260909-${operation === "create" ? "02" : "03"}/${operation}-receipt.json`;
  describe.skipIf(!existsSync(filename))(`closed native ${operation} stage replay`, () => {
    it("validates actual raw source, four inventories, epoch and individual PAD queries", () => {
      const receipt = JSON.parse(readFileSync(filename, "utf8"));
      const raw = receipt.padSnapshot;
      const reference_pads = raw.connectivity.map((query: any) => {
        const index = raw.padRecords.findIndex((pad: any) => pad.id.value === query.sourcePrimitiveId);
        const owner = raw.footprintInventory.footprints.find((fp: any) => fp.padRecordIndexes.includes(index));
        return { reference: owner.reference, pad: raw.padRecords[index].number, primitiveId: query.sourcePrimitiveId };
      });
      const request: KicadPlaneStageInput = { board_file: path.win32.join(receipt.document.project.path, receipt.document.board_filename), zone_ids: receipt.zonesBefore.map((zone: any) => zone.uuid), reference_pads, request: receipt.request };
      const result = validateFreshPlaneLiteralStageObservation(receipt, { request, padExpected: { pcbPath: request.board_file, pcbSource: receipt.savedSourceBefore,
        requestedPrimitiveIds: reference_pads.map((pad: any) => pad.primitiveId), enabledCopperLayers: ["F.Cu", "B.Cu"], scopeIdentity: canonicalIdentity({ operation }, "evleda.offline-plane-stage-test.v1") } });
      expect(result.comparison.valid).toBe(true); expect(result.nativeSourceStaged).toBe(receipt.nativeSourceStaged);
      expect(result.savedSourceIdentity).toEqual(contentIdentity(receipt.savedSourceBefore));
      expect(result.nativePadsSource).toBe("validated-staged-native-not-saved");
      expect(result.acceptanceEvaluated).toBe(false); expect(result.savedAuthorityMinted).toBe(false);
      expect(isValidatedFreshPlaneStageObservation(result)).toBe(false);
      expect(result.beforeZoneProto === null).toBe(operation === "create");
    });
  });
}
