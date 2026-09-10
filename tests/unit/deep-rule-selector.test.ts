import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import {
  BASELINE_DEEP_RULE_IDS,
  DEEP_RULE_SELECTOR_HARD_MAX_PROMPT_BYTES,
  DEEP_RULE_SELECTOR_HARD_MAX_RULES,
  DEEP_RULE_SELECTOR_PROMPT_BOUNDARY,
  ZERO_VIA_BASELINE_DEEP_RULE_IDS,
  selectDeepRulesForDesign,
  type DeepRuleDesignFeatures
} from "../../src/harness/deep-rule-selector.js";

const catalog = loadDeepRuleCatalog();

const everyFeature: DeepRuleDesignFeatures = {
  powerCurrent: { terms: ["5 A motor", "switching regulator"] },
  signalSpeedInterfaces: { terms: ["USB 2.0", "1 ns edge"] },
  differentialPairs: { terms: ["USB"] },
  stackupImpedance: true,
  thermal: { terms: ["sealed enclosure"] },
  emi: true,
  placement: true,
  dfm: true,
  assembly: true,
  bga: { terms: ["0.5 mm pitch"] },
  gpio: { terms: ["open-drain", "I2C"] }
};

describe("bounded deep PCB rule selector", () => {
  it("always selects the reviewed schematic, placement, routing, width, via, ERC, and DRC baseline", () => {
    const result = selectDeepRulesForDesign(catalog);
    expect(result.rules.map((rule) => rule.id)).toEqual(BASELINE_DEEP_RULE_IDS);
    expect(result.deepRuleSelection).toEqual({ ids: BASELINE_DEEP_RULE_IDS, limit: BASELINE_DEEP_RULE_IDS.length });
    expect(result.disposition).toBe("ready-for-prompt");
    expect(result.activeFeatures).toEqual([]);
    expect(result.coveredFeatures).toEqual([]);
    expect(result.uncoveredFeatures).toEqual([]);
    expect(result.prompt).toContain(DEEP_RULE_SELECTOR_PROMPT_BOUNDARY);
    for (const rule of result.rules) {
      expect(rule.reasons).toContain("baseline");
      expect(rule.source.headingAnchor).not.toHaveLength(0);
      expect(rule.source.dossierLineStart).toBeGreaterThan(0);
      expect(rule.source.dossierLineEnd).toBeGreaterThanOrEqual(rule.source.dossierLineStart);
      expect(result.prompt).toContain(`[${rule.id}|`);
      expect(result.prompt).toContain(`#${rule.source.headingAnchor}:L${rule.source.dossierLineStart}-L${rule.source.dossierLineEnd}`);
    }
  });

  it("uses a reviewed zero-via baseline and validates task-profile preferences", () => {
    const zeroVia = selectDeepRulesForDesign(catalog, {}, {
      maxRules: ZERO_VIA_BASELINE_DEEP_RULE_IDS.length,
    }, {
      baselineProfile: "zero-via",
    });
    expect(zeroVia.rules.map((rule) => rule.id)).toEqual(ZERO_VIA_BASELINE_DEEP_RULE_IDS);
    expect(zeroVia.rules.map((rule) => rule.id)).toContain("PCB05-R072");
    expect(zeroVia.rules.map((rule) => rule.id)).not.toContain("PCB05-R066");

    const preferred = selectDeepRulesForDesign(catalog, { placement: true }, {
      maxRules: ZERO_VIA_BASELINE_DEEP_RULE_IDS.length + 1,
    }, {
      baselineProfile: "zero-via",
      featureRulePreferences: { placement: ["PCB16-R084"] },
    });
    expect(preferred.rules.at(-1)?.id).toBe("PCB16-R084");
    expect(preferred.rules.at(-1)?.reasons).toContain("placement");
    expect(() => selectDeepRulesForDesign(catalog, { placement: true }, {
      maxRules: ZERO_VIA_BASELINE_DEEP_RULE_IDS.length + 1,
    }, {
      baselineProfile: "zero-via",
      featureRulePreferences: { placement: ["PCB02-R001"] },
    })).toThrow(/missing, ineligible, or not relevant/iu);
  });

  it("is deterministic, ignores feature object order, and deduplicates overlapping feature results", () => {
    const reversed: DeepRuleDesignFeatures = {
      gpio: { terms: ["open-drain", "I2C"] },
      bga: { terms: ["0.5 mm pitch"] },
      assembly: true,
      dfm: true,
      placement: true,
      emi: true,
      thermal: { terms: ["sealed enclosure"] },
      stackupImpedance: true,
      differentialPairs: { terms: ["USB"] },
      signalSpeedInterfaces: { terms: ["USB 2.0", "1 ns edge"] },
      powerCurrent: { terms: ["5 A motor", "switching regulator"] }
    };
    const first = selectDeepRulesForDesign(catalog, everyFeature);
    const second = selectDeepRulesForDesign(catalog, reversed);
    expect(second).toEqual(first);
    const ids = first.rules.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every active feature a relevant bounded candidate before filling later rounds", () => {
    const result = selectDeepRulesForDesign(catalog, everyFeature, {
      maxRules: 20,
      maxPromptBytes: 7_000,
      maxPromptTokens: 7_000
    });
    expect(result.disposition).toBe("ready-for-prompt");
    expect(result.rules).toHaveLength(BASELINE_DEEP_RULE_IDS.length + result.activeFeatures.length);
    expect(result.coveredFeatures).toEqual(result.activeFeatures);
    expect(result.uncoveredFeatures).toEqual([]);
    for (const feature of result.activeFeatures) {
      expect(result.rules.some((rule) => rule.reasons.includes(feature)), feature).toBe(true);
    }
    expect(result.omittedCandidateCount).toBeGreaterThan(0);
  });

  it("fails closed when all eleven active features cannot fit, or explicitly reports non-ready coverage", () => {
    expect(() => selectDeepRulesForDesign(catalog, everyFeature, {
      maxRules: 19,
      maxPromptBytes: 7_000,
      maxPromptTokens: 7_000
    })).toThrow(/one distinct rule per active feature/iu);
    expect(() => selectDeepRulesForDesign(catalog, everyFeature, {
      maxRules: 20,
      maxPromptBytes: 6_500,
      maxPromptTokens: 6_500
    })).toThrow(/active feature coverage incomplete/iu);

    const diagnostic = selectDeepRulesForDesign(catalog, everyFeature, {
      maxRules: 20,
      maxPromptBytes: 6_000,
      maxPromptTokens: 6_000,
      featureCoveragePolicy: "report-incomplete"
    });
    expect(diagnostic.disposition).toBe("incomplete");
    expect(diagnostic.coveredFeatures.length).toBeGreaterThan(0);
    expect(diagnostic.uncoveredFeatures.length).toBeGreaterThan(0);
    expect([...diagnostic.coveredFeatures, ...diagnostic.uncoveredFeatures].sort()).toEqual(
      [...diagnostic.activeFeatures].sort()
    );
    expect(diagnostic.budget.usedPromptBytes).toBeLessThanOrEqual(6_000);
    expect(diagnostic.budget.usedPromptTokens).toBeLessThanOrEqual(6_000);
  });

  it("prioritizes critical correctness rules and lets explicit interface terms affect relevance", () => {
    const power = selectDeepRulesForDesign(catalog, { powerCurrent: true });
    const firstPowerRule = power.rules[BASELINE_DEEP_RULE_IDS.length];
    expect(firstPowerRule?.severity).toBe("critical");
    expect(firstPowerRule?.topic).toBe("trace-current");

    const usb = selectDeepRulesForDesign(catalog, {
      signalSpeedInterfaces: { terms: ["USB"] }
    });
    const selectedCatalogRules = usb.rules
      .slice(BASELINE_DEEP_RULE_IDS.length)
      .map((selected) => catalog.rules.find((rule) => rule.id === selected.id))
      .filter((rule) => rule !== undefined);
    expect(selectedCatalogRules.some((rule) =>
      [rule.instruction, rule.rationale, rule.applicability, ...rule.checks].join(" ").match(/\bUSB\b/iu)
    )).toBe(true);
  });

  it("excludes release gates, manufacturing actions, and JLC-specific numeric rule records", () => {
    const result = selectDeepRulesForDesign(catalog, everyFeature, {
      maxRules: 40,
      maxPromptBytes: 16_384,
      maxPromptTokens: 16_384
    });
    const selected = result.rules.map((selection) => {
      const rule = catalog.rules.find((candidate) => candidate.id === selection.id);
      expect(rule, selection.id).toBeDefined();
      return rule;
    }).filter((rule) => rule !== undefined);
    expect(selected.every((rule) => rule.category !== "release-gate")).toBe(true);
    expect(selected.every((rule) => !rule.vendorScope.toLocaleLowerCase().startsWith("jlcpcb-specific"))).toBe(true);
    expect(result.rules.map((rule) => rule.id)).not.toContain("PCB11-R049");
    expect(result.rules.map((rule) => rule.id)).not.toContain("PCB11-R034");
    expect(result.prompt).toMatch(/vendor-specific values are not universal/iu);
    expect(result.prompt).not.toMatch(/authorize fabrication|manufacturing-ready|release authorization/iu);
  });

  it("honors exact UTF-8 budgets and rejects a budget too small for the mandatory baseline", () => {
    const baseline = selectDeepRulesForDesign(catalog);
    const exact = selectDeepRulesForDesign(catalog, {}, {
      maxRules: BASELINE_DEEP_RULE_IDS.length,
      maxPromptBytes: baseline.budget.usedPromptBytes,
      maxPromptTokens: baseline.budget.usedPromptTokens
    });
    expect(exact.prompt).toBe(baseline.prompt);
    expect(Buffer.byteLength(exact.prompt, "utf8")).toBe(exact.budget.usedPromptBytes);
    expect(exact.budget.usedPromptBytes).toBeLessThanOrEqual(exact.budget.maxPromptBytes);
    expect(exact.budget.usedPromptTokens).toBeLessThanOrEqual(exact.budget.maxPromptTokens);
    expect(() => selectDeepRulesForDesign(catalog, {}, {
      maxPromptBytes: baseline.budget.usedPromptBytes - 1,
      maxPromptTokens: baseline.budget.usedPromptTokens
    })).toThrow(/cannot retain the mandatory baseline/iu);
  });

  it("uses a caller tokenizer when supplied and never crosses either prompt cap", () => {
    const tokenCounter = (prompt: string): number => Math.ceil(Buffer.byteLength(prompt, "utf8") / 3);
    const result = selectDeepRulesForDesign(catalog, everyFeature, {
      maxPromptBytes: 7_000,
      maxPromptTokens: 2_300,
      tokenCounter
    });
    expect(result.budget.tokenAccounting).toBe("caller-supplied");
    expect(result.budget.usedPromptBytes).toBeLessThanOrEqual(7_000);
    expect(result.budget.usedPromptTokens).toBe(tokenCounter(result.prompt));
    expect(result.budget.usedPromptTokens).toBeLessThanOrEqual(2_300);
  });

  it("hard-caps caller maxima and rejects rule-count and token-counter invariant violations", () => {
    const capped = selectDeepRulesForDesign(catalog, everyFeature, {
      maxRules: 999_999,
      maxPromptBytes: 999_999,
      maxPromptTokens: 999_999
    });
    expect(capped.budget.maxRules).toBe(DEEP_RULE_SELECTOR_HARD_MAX_RULES);
    expect(capped.budget.maxPromptBytes).toBe(DEEP_RULE_SELECTOR_HARD_MAX_PROMPT_BYTES);
    expect(capped.rules.length).toBeLessThanOrEqual(DEEP_RULE_SELECTOR_HARD_MAX_RULES);
    expect(capped.budget.usedPromptBytes).toBeLessThanOrEqual(DEEP_RULE_SELECTOR_HARD_MAX_PROMPT_BYTES);
    expect(() => selectDeepRulesForDesign(catalog, {}, { maxRules: BASELINE_DEEP_RULE_IDS.length - 1 })).toThrow(/mandatory baseline/iu);
    expect(() => selectDeepRulesForDesign(catalog, {}, { tokenCounter: () => -1 })).toThrow(/non-negative integer/iu);
  });

  it("treats false and enabled:false as inactive, and rejects unbounded or blank terms", () => {
    const inactive = selectDeepRulesForDesign(catalog, {
      powerCurrent: false,
      signalSpeedInterfaces: { enabled: false, terms: ["USB"] }
    });
    expect(inactive.activeFeatures).toEqual([]);
    expect(inactive.rules.map((rule) => rule.id)).toEqual(BASELINE_DEEP_RULE_IDS);
    expect(() => selectDeepRulesForDesign(catalog, {
      gpio: { terms: [" "] }
    })).toThrow(/must not be blank/iu);
    expect(() => selectDeepRulesForDesign(catalog, {
      gpio: { terms: Array.from({ length: 25 }, (_, index) => `term-${index}`) }
    })).toThrow(/at most 24 entries/iu);
  });

  it("uses whole technical tokens and rejects substring fragments and bare process units", () => {
    for (const fragment of ["lc-", "ig", "oz"]) {
      expect(() => selectDeepRulesForDesign(catalog, {
        dfm: { terms: [fragment] }
      }), fragment).toThrow(/meaningful whole technical token/iu);
    }

    const ordinary = selectDeepRulesForDesign(catalog, { dfm: true }, { maxRules: 10 });
    const nonMatchingWholeToken = selectDeepRulesForDesign(catalog, {
      dfm: { terms: ["rid"] }
    }, { maxRules: 10 });
    expect(nonMatchingWholeToken.rules.map((rule) => rule.id)).toEqual(ordinary.rules.map((rule) => rule.id));

    const vendorProfileProbe = selectDeepRulesForDesign(catalog, {
      dfm: { terms: ["JLC", "profile"] }
    }, { maxRules: 14 });
    expect(vendorProfileProbe.rules.map((rule) => rule.id)).not.toContain("PCB11-R034");
    expect(vendorProfileProbe.rules.some((rule) => rule.topic === "dfm" && !rule.reasons.includes("baseline"))).toBe(true);
    expect(vendorProfileProbe.prompt).not.toMatch(/JLC-rigid-4L-1oz/iu);
  });

  it("fails closed when a mandatory stable rule is absent from the supplied catalog", () => {
    const missingId = BASELINE_DEEP_RULE_IDS[0];
    const incomplete = {
      ...catalog,
      rules: catalog.rules.filter((rule) => rule.id !== missingId)
    };
    expect(() => selectDeepRulesForDesign(incomplete)).toThrow(new RegExp(`missing mandatory.*${missingId}`, "iu"));
  });
});
