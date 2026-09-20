import { describe, expect, it } from "vitest";
import { fourLayerPlaneBundle, fourLayerPlaneDraft } from "../helpers/four-layer-plane-bundle.js";
import { constructionDependencies, interfaceConstructionBundle, interfaceConstructionDraft } from "../helpers/interface-construction-bundle.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { parsePcbPlaneCompilationBundle, serializePcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { createFourLayerConstructionBoardSeed, createInterfaceConstructionBoardSeed } from "../../src/harness/interface-construction-seed.js";
import { fourLayerConstruction } from "../helpers/four-layer-construction.js";
import { assessSavedInterface } from "../../src/harness/saved-interface-assessment.js";
import { pcbDesignIntentDraftSchema } from "../../src/harness/pcb-design-contract.js";
import { assertCurrentPlaneNativeAuthoringScope } from "../../src/harness/fresh-project.js";
import { summarizeSavedInterface } from "../../src/mcp/toolbox-interface-report.js";

describe("four-layer plane-family declarations and saved construction", () => {
  it("compiles two named ground planes owned by one net and seeds the authenticated physical construction", () => {
    const bundle = fourLayerPlaneBundle();
    expect(bundle.contract.scope.board.copperLayers).toEqual(["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"]);
    expect(bundle.contract.planes.map(p => [p.id,p.layer])).toEqual([["BACK_GND","In2.Cu"],["GND_PLANE","In1.Cu"]]);
    expect(bundle.verificationPlan.requirements.filter(r => r.kind === "plane_configuration")).toHaveLength(2);
    expect(bundle.verificationPlan.requirements.some(r => r.id === "interface-construction")).toBe(true);
    expect(createInterfaceConstructionBoardSeed(bundle)).toBe(createFourLayerConstructionBoardSeed(fourLayerConstruction()));
    const parsed = parsePcbPlaneCompilationBundle(serializePcbPlaneCompilationBundle(bundle), constructionDependencies);
    expect(parsed.identity).toEqual(bundle.identity);
    expect(createInterfaceConstructionBoardSeed(parsed)).toBe(createInterfaceConstructionBoardSeed(bundle));
  });

  it("canonicalizes unordered enabled/allowed layers without changing the physical order", () => {
    const draft = fourLayerPlaneDraft(); draft.scope.board.copperLayers.reverse();
    draft.netClasses.find((c: any) => c.id === "POWER").allowedLayers.reverse(); draft.planes.reverse();
    expect(interfaceConstructionBundle(draft).contract.identity).toEqual(fourLayerPlaneBundle().contract.identity);
  });

  it("asks for an explicitly unresolved construction instead of inventing it", () => {
    const draft = fourLayerPlaneDraft(); draft.interfaceRequirements.construction = null;
    const result = compilePcbPlaneDesignIntentDraft(draft,constructionDependencies);
    expect(result.disposition).toBe("needs_clarification");
    expect(result.questions.some(q => q.path === "/interfaceRequirements/construction")).toBe(true);
  });

  it("points a two-layer any-access rejection at the actual nested preference", () => {
    const draft = interfaceConstructionDraft();
    draft.routingConstraints.nets.find((r: any) => r.net === "GND").accessRouting.preferredLayer = "any";
    const result = compilePcbPlaneDesignIntentDraft(draft,constructionDependencies);
    expect(result.disposition).not.toBe("ready");
    expect(result.issues.some(issue => issue.path === "/routingConstraints/nets/GND/accessRouting/preferredLayer")).toBe(true);
  });

  it("preserves existing two-layer declarations and leaves the legacy V1 family restricted", () => {
    const draft = interfaceConstructionDraft(), before = interfaceConstructionBundle(draft);
    const parsed = parsePcbPlaneCompilationBundle(serializePcbPlaneCompilationBundle(before), constructionDependencies);
    expect(parsed.contract).toEqual(before.contract);
    const four = fourLayerPlaneDraft(); four.schemaVersion = "evleda.pcb-design-intent-draft.v1";
    expect(pcbDesignIntentDraftSchema.safeParse(four).success).toBe(false);
    expect(() => assertCurrentPlaneNativeAuthoringScope(before)).not.toThrow();
    expect(() => assertCurrentPlaneNativeAuthoringScope(fourLayerPlaneBundle())).not.toThrow();
  });

  it.each([
    ["missing physical construction", (d: any) => { delete d.interfaceRequirements; }],
    ["two-layer construction on four layers", (d: any) => { d.interfaceRequirements.construction = interfaceConstructionDraft().interfaceRequirements.construction; }],
    ["missing enabled layer", (d: any) => { d.scope.board.copperLayers.pop(); }],
    ["repeated enabled layer", (d: any) => { d.scope.board.copperLayers[2] = "In1.Cu"; }],
    ["disabled inner layer", (d: any) => { d.scope.board.layerCount = 2; d.scope.board.copperLayers = ["F.Cu","B.Cu"]; }],
    ["unowned second plane", (d: any) => { delete d.routingConstraints.nets.find((r: any) => r.net === "GND").additionalPlaneIds; }],
    ["duplicate ownership selector", (d: any) => { d.routingConstraints.nets.find((r: any) => r.net === "GND").additionalPlaneIds = ["GND_PLANE"]; }],
    ["unknown extra plane", (d: any) => { d.routingConstraints.nets.find((r: any) => r.net === "GND").additionalPlaneIds = ["UNKNOWN"]; }],
    ["two planes on one layer", (d: any) => { d.planes[1].layer = "In1.Cu"; }],
    ["nonadjacent reference", (d: any) => { d.planes[0].layer = "B.Cu"; }],
    ["ambiguous channel layer", (d: any) => { d.routingConstraints.nets.find((r: any) => r.net === "DP").preferredLayer = "any"; }],
  ] as const)("rejects %s", (_name, mutate) => {
    const draft = fourLayerPlaneDraft(); mutate(draft);
    expect(compilePcbPlaneDesignIntentDraft(draft, constructionDependencies).disposition).not.toBe("ready");
  });

  it("compares all saved gaps/materials separately without treating a blank board as a routed interface", async () => {
    const bundle = fourLayerPlaneBundle(), source = createInterfaceConstructionBoardSeed(bundle);
    const report = await assessSavedInterface({ compilationBundle: bundle, interfaceId: "LINK", savedPcbBytes: Buffer.from(source) });
    expect(report.construction.status).toBe("matched_saved_declaration");
    expect(report.construction.observed.innerCopperThicknessNm).toEqual({ "In1.Cu":15200,"In2.Cu":15200 });
    expect(report.construction.observed.dielectricThicknessNm).toBeNull();
    expect(report.construction.observed.dielectricGaps?.map(g => [g.fromCopper,g.toCopper,g.thicknessNm,g.relativePermittivity])).toEqual([
      ["F.Cu","In1.Cu",100000,4.1],["In1.Cu","In2.Cu",600000,4.6],["In2.Cu","B.Cu",200000,3.9],
    ]);
    expect(report.construction.physicalConstruction).toBe("not_verified");
    expect(report.construction.sourceUnverifiedAssertionFields).toContain("nominal_finished_board_thickness");
    const publicReport = summarizeSavedInterface(report);
    expect(publicReport.construction.observed.dielectricGaps).toEqual(report.construction.observed.dielectricGaps);
    expect(publicReport.construction.observed.innerCopperThicknessNm).toEqual(report.construction.observed.innerCopperThicknessNm);
    expect(report.sourceInventory.selected.tracks).toEqual([]);
    expect(report.sourceInventory.selected.pads).toEqual([]);
    expect(report.boardAccepted).toBe(false);
    expect(report.interfaceAccepted).toBe(false);
    expect(report.fabricationAuthorized).toBe(false);
  });

  it.each([
    ["inner copper", "(thickness 0.0152)", "(thickness 0.015201)"],
    ["core", "(thickness 0.6 locked)", "(thickness 0.600001 locked)"],
    ["back prepreg", "(epsilon_r 3.9)", "(epsilon_r 4.1)"],
  ])("detects saved %s drift independently of unrouted geometry", async (_name, before, after) => {
    const bundle = fourLayerPlaneBundle();
    const source = createInterfaceConstructionBoardSeed(bundle).replace(before,after);
    const report = await assessSavedInterface({ compilationBundle: bundle, interfaceId:"LINK", savedPcbBytes:Buffer.from(source) });
    expect(report.construction.status).toBe("failed_saved_declaration");
  });
});
