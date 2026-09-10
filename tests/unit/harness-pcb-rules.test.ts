import { describe, expect, it } from "vitest";

import {
  DEFAULT_TWO_LAYER_MVP_RULE_PROFILE,
  PCB_DESIGNER_SYSTEM_INSTRUCTIONS,
  renderPcbDesignerPrompt,
  summarizePcbFeedbackForNextIteration
} from "../../src/harness/pcb-rules.js";
import {
  createPackagedDeepRuleResourceProfile,
  loadDeepRuleCatalog
} from "../../src/harness/deep-rule-catalog.js";

describe("lean PCB harness rules", () => {
  it("contains the fixed practical routing and validation rules", () => {
    expect(PCB_DESIGNER_SYSTEM_INSTRUCTIONS).toMatch(/45-degree/iu);
    expect(PCB_DESIGNER_SYSTEM_INSTRUCTIONS).toMatch(/self-crossing|backtracking/iu);
    expect(PCB_DESIGNER_SYSTEM_INSTRUCTIONS).toMatch(/decouplers/iu);
    expect(PCB_DESIGNER_SYSTEM_INSTRUCTIONS).toMatch(/continuous ground return/iu);
    expect(PCB_DESIGNER_SYSTEM_INSTRUCTIONS).toMatch(/ERC and DRC/iu);
    expect(PCB_DESIGNER_SYSTEM_INSTRUCTIONS).toMatch(/never claim.*clean/iu);
    expect(DEFAULT_TWO_LAYER_MVP_RULE_PROFILE.layerCount).toBe(2);
  });

  it("renders custom constraints deterministically and remains bounded", () => {
    const input = {
      boardPurpose: "controller board",
      constraints: ["keep J1 on the left edge", "USB pair stays short"],
      maxChars: 900
    } as const;
    const first = renderPcbDesignerPrompt(input);
    expect(renderPcbDesignerPrompt(input)).toBe(first);
    expect(first).toContain("keep J1 on the left edge");
    expect(first).toContain("current not supplied");
    expect(first.length).toBeLessThanOrEqual(900);
  });

  it("makes unresolved checks explicit and bounds feedback", () => {
    const summary = summarizePcbFeedbackForNextIteration({
      analyzer: { outcome: "review", findings: [{ severity: "warning", code: "TURN", message: "remove reversal" }] },
      erc: { status: "clean" },
      drc: { status: "not_run" }
    }, 500);
    expect(summary).toContain("Validation unresolved");
    expect(summary).toContain("Do not claim the board is clean");
    expect(summary).toContain("remove reversal");
    expect(summary.length).toBeLessThanOrEqual(500);
  });

  it("keeps deep rules opt-in and appends only an explicit bounded selection", () => {
    const ordinary = renderPcbDesignerPrompt({ boardPurpose: "controller board" });
    expect(ordinary).not.toContain("Deep-rule excerpts");

    const deepRuleResourceProfile = createPackagedDeepRuleResourceProfile();
    const catalog = loadDeepRuleCatalog(deepRuleResourceProfile);
    const selectedId = catalog.rules.find((rule) => rule.topic === "gpio-pinouts")?.id;
    expect(selectedId).toBeDefined();
    const prompt = renderPcbDesignerPrompt({
      boardPurpose: "controller board",
      maxChars: 2_000,
      deepRuleResourceProfile,
      deepRuleSelection: { ids: [selectedId ?? "missing"] },
      deepRuleMaxRules: 1,
      deepRuleMaxChars: 800
    });
    expect(prompt).toContain(PCB_DESIGNER_SYSTEM_INSTRUCTIONS.split("\n")[0]);
    expect(prompt).toContain(`[${selectedId}]`);
    expect(prompt).toContain("do not authorize fabrication");
    expect(prompt.length).toBeLessThanOrEqual(2_000);
  });
});
