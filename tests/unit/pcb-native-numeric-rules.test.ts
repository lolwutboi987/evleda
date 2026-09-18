import { describe, expect, it } from "vitest";
import { closePcbPlaneDesignIntentDraft, parsePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-contract.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle, parsePcbPlaneCompilationBundle, serializePcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { createFreshPlaneRules } from "../../src/harness/fresh-plane-rules.js";
import { derivePcbNativeNumericRules, assertPcbNativeNumericProjectSettings, pcbNativeNumericRuleLines } from "../../src/harness/pcb-native-numeric-rules.js";
import { genericDividerLibraryResolver } from "../helpers/generic-divider-bundle.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";
import { usbChannelDraft } from "../helpers/usb-channel-bundle.js";

const dependencies = { libraryResolver: genericDividerLibraryResolver, deepRuleCatalog: loadDeepRuleCatalog() };
export const numericDraft = () => {
  const draft = planeDividerDraft();
  return { ...draft, nativeRuleMode: "contract-derived-v1" as const,
    netClasses: draft.netClasses.map(c => ({ ...c, traceWidthMm: c.id === "SENSE" ? 0.15 : 0.3, copperToEdgeMm: c.id === "SENSE" ? 0.25 : 0.5 })),
    routingConstraints: { ...draft.routingConstraints, viaPolicy: { mode: "bounded", maxTotal: 2, diameterMm: 0.6, drillMm: 0.25, minimumAnnularRingMm: 0.15 } } };
};
const contract = () => closePcbPlaneDesignIntentDraft(numericDraft());
const settings = () => { const projection = derivePcbNativeNumericRules(contract())!; return { board: { design_settings: { rules: { ...projection.boardRules }, rule_severities: { ...projection.requiredNativeCheckSeverities } } } }; };
describe("explicit V2 contract-native numeric mode", () => {
  it("derives absolute floors while preserving stricter named nets, unassigned copper and Pad defaults", () => {
    const c = contract(), p = derivePcbNativeNumericRules(c)!;
    expect(p.boardRules).toEqual({ min_track_width: 0.15, min_copper_edge_clearance: 0.25, min_through_hole_diameter: 0.25,
      min_via_annular_width: 0.1, min_via_diameter: 0.5, min_clearance: 0, min_hole_clearance: 0.25, min_hole_to_hole: 0.25 });
    expect(p.nets.find(n => n.name === "VOUT")).toMatchObject({ minimumTrackWidthMm: 0.15, copperToEdgeMm: 0.25 });
    expect(p.nets.find(n => n.name === "VIN")).toMatchObject({ minimumTrackWidthMm: 0.3, copperToEdgeMm: 0.5 });
    const rules = pcbNativeNumericRuleLines(c).join("\n");
    expect(rules.indexOf("EVLEDA_NUMERIC_FALLBACK")).toBeLessThan(rules.indexOf("EVLEDA_NUMERIC_NET_1"));
    expect(rules).toContain("(constraint track_width (min 0.2mm))"); expect(rules).toContain("(constraint edge_clearance (min 0.5mm))");
    expect(rules).toContain("A.Type == 'Pad'"); expect(rules).toContain("(constraint hole_size (min 0.3mm))");
    expect(rules).toContain("A.Type == 'Via'"); expect(rules).toContain("(constraint via_diameter (min 0.6mm))");
    expect(rules).toContain("(constraint hole_size (min 0.25mm))"); expect(rules).toContain("(constraint annular_width (min 0.15mm))");
    expect(() => assertPcbNativeNumericProjectSettings(c, settings())).not.toThrow();
  });
  it("takes only the same channel net's declared body/terminal escape minimum", () => {
    const draft = { ...usbChannelDraft(), nativeRuleMode: "contract-derived-v1" as const };
    const c = closePcbPlaneDesignIntentDraft(draft), p = derivePcbNativeNumericRules(c)!;
    const pair = c.interfaceRequirements!.interfaces[0]!;
    for (const net of c.nets) {
      const isChannel = [pair.nets.positive,pair.nets.negative,pair.channel!.launchNets.positive,pair.channel!.launchNets.negative].includes(net.name);
      const expected = isChannel ? Math.min(pair.geometry.traceWidthMm.minimumMm, ...pair.channel!.escapes.filter(e => net.endpoints.some(p => p.reference === e.terminal.reference && p.pin === e.terminal.pin)).map(e => e.traceWidthMm.minimumMm))
        : c.netClasses.find(c => c.id === net.netClassId)!.traceWidthMm;
      expect(p.nets.find(n => n.name === net.name)!.minimumTrackWidthMm).toBe(expected);
    }
  });
  it("keeps omission byte-compatible and refuses unsupported mode strings or unresolved closure", () => {
    const legacy = closePcbPlaneDesignIntentDraft(planeDividerDraft());
    expect(derivePcbNativeNumericRules(legacy)).toBeUndefined(); expect(pcbNativeNumericRuleLines(legacy)).toEqual([]);
    expect(() => assertPcbNativeNumericProjectSettings(legacy, {})).not.toThrow();
    expect(() => parsePcbPlaneDesignIntentDraft({ ...planeDividerDraft(), nativeRuleMode: "automatic" })).toThrow();
    expect(() => closePcbPlaneDesignIntentDraft({ ...planeDividerDraft(), nativeRuleMode: null })).toThrow();
  });
  it("binds opt-in through compilation, bundle roundtrip, verification plan and canonical DRU", () => {
    const compilation = compilePcbPlaneDesignIntentDraft(numericDraft(), dependencies);
    expect(compilation.disposition, JSON.stringify(compilation.issues)).toBe("ready");
    const bundle = createPcbPlaneCompilationBundle({ compilation, originalPrompt: "Explicit numerical native policy" }, dependencies);
    expect(parsePcbPlaneCompilationBundle(serializePcbPlaneCompilationBundle(bundle), dependencies)).toEqual(bundle);
    expect(bundle.verificationPlan.requirements.some(row => row.id === "native-numeric-rules")).toBe(true);
    expect(createFreshPlaneRules(bundle).source).toContain("EVLEDA_NUMERIC_VIA");
    expect(bundle.executionGuidance).toContain("escape locality");
    expect(bundle.executionGuidance).not.toContain("minimumHoleToHoleMm");
    const changed = structuredClone(bundle) as any; delete changed.contract.nativeRuleMode;
    expect(() => parsePcbPlaneCompilationBundle(changed, dependencies)).toThrow();
  });
  it.each(Object.keys(settings().board.design_settings.rules))("rejects current project drift of %s rather than repairing it", key => {
    const s = settings(); (s.board.design_settings.rules as Record<string, number>)[key]! += 0.001;
    expect(() => assertPcbNativeNumericProjectSettings(contract(), s)).toThrow(/differs/);
  });
  it.each(["track_width", "track_angle"])("requires enabled error severity for %s", key => {
    const s = settings(); delete (s.board.design_settings.rule_severities as Record<string, string>)[key];
    expect(() => assertPcbNativeNumericProjectSettings(contract(), s)).toThrow(/severity/);
  });
  it("admits the qualified absent via-diameter default or explicit error only", () => {
    for (const value of [undefined, "error", "ignore", "warning", "unknown", null]) {
      const s = settings(); if (value !== undefined) Object.assign(s.board.design_settings.rule_severities, { via_diameter: value });
      if (value === undefined || value === "error") expect(() => assertPcbNativeNumericProjectSettings(contract(), s)).not.toThrow();
      else expect(() => assertPcbNativeNumericProjectSettings(contract(), s)).toThrow(/severity/);
    }
  });
  it("refuses sub-nanometre contract dimensions instead of rounding a native rule", () => {
    const draft = numericDraft(); draft.netClasses[0]!.traceWidthMm = 0.15000001;
    expect(compilePcbPlaneDesignIntentDraft(draft, dependencies).disposition).not.toBe("ready");
  });
  it("binds an explicit .50 hole-edge spacing without inserting a default when omitted", () => {
    const omitted = contract();
    expect(omitted.routingConstraints).not.toHaveProperty("minimumHoleToHoleMm");
    expect(derivePcbNativeNumericRules(omitted)!.boardRules.min_hole_to_hole).toBe(0.25);
    const draft = numericDraft();
    const spaced = closePcbPlaneDesignIntentDraft({ ...draft, routingConstraints: { ...draft.routingConstraints, minimumHoleToHoleMm: 0.5 } });
    expect(derivePcbNativeNumericRules(spaced)!.boardRules.min_hole_to_hole).toBe(0.5);
    const s = settings(); s.board.design_settings.rules.min_hole_to_hole = 0.5;
    expect(() => assertPcbNativeNumericProjectSettings(spaced, s)).not.toThrow();
    s.board.design_settings.rules.min_hole_to_hole = 0.49;
    expect(() => assertPcbNativeNumericProjectSettings(spaced, s)).toThrow(/min_hole_to_hole/);
    expect(spaced.identity).not.toEqual(omitted.identity);
    const compilation = compilePcbPlaneDesignIntentDraft({ ...draft, routingConstraints: { ...draft.routingConstraints, minimumHoleToHoleMm: 0.5 } }, dependencies);
    const b = createPcbPlaneCompilationBundle({ compilation, originalPrompt: "Explicit hole spacing" }, dependencies);
    expect(b.executionGuidance).toContain("minimumHoleToHoleMm");
    expect(parsePcbPlaneCompilationBundle(serializePcbPlaneCompilationBundle(b), dependencies)).toEqual(b);
  });
  it.each([0, 0.049, 10.001, 0.5000001, -0])("rejects invalid/non-native hole spacing %s", value => {
    const draft = numericDraft();
    expect(() => parsePcbPlaneDesignIntentDraft({ ...draft, routingConstraints: { ...draft.routingConstraints, minimumHoleToHoleMm: value } })).toThrow();
  });
  it("requires explicit opt-in for hole spacing and keeps unresolved null out of closed contracts", () => {
    const legacy = planeDividerDraft();
    expect(() => parsePcbPlaneDesignIntentDraft({ ...legacy, routingConstraints: { ...legacy.routingConstraints, minimumHoleToHoleMm: 0.5 } })).toThrow(/nativeRuleMode/);
    const draft = numericDraft(), unresolved = { ...draft, routingConstraints: { ...draft.routingConstraints, minimumHoleToHoleMm: null } };
    expect(() => parsePcbPlaneDesignIntentDraft(unresolved)).not.toThrow();
    expect(() => closePcbPlaneDesignIntentDraft(unresolved)).toThrow();
  });
});
