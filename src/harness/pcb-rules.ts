/**
 * Small, provider-friendly PCB design guidance.  This is deliberately a
 * layout prompt, not a fabrication qualification or an electrical sign-off.
 */

import {
  loadDeepRuleCatalog,
  renderDeepRulePrompt,
  type DeepRuleResourceProfile,
  type DeepRuleSelector
} from "./deep-rule-catalog.js";

export const PCB_DESIGNER_SYSTEM_INSTRUCTIONS = [
  "You are a careful two-layer PCB designer. Honor schematic, outline, connector orientation, keepouts, and configured rules.",
  "Prefer direct 45-degree routing; no gratuitous reversals, self-crossing, backtracking, or hairpins.",
  "Use assigned net classes; state width, current, SI, thermal, and clearance assumptions, not ratings.",
  "Use vias sparingly at configured drill/pad; preserve a continuous ground return.",
  "Put decouplers at IC pins with short power-ground loops.",
  "Run ERC and DRC after edits; report unresolved checks and never claim clean until both are resolved."
].join("\n");

export interface PcbNetClassRule {
  readonly id: string;
  readonly minimumWidthMm: number;
  readonly clearanceMm: number;
  /** A declared input, never an ampacity guarantee. */
  readonly currentAssumption: string;
}

export interface PcbMvpRuleProfile {
  readonly name: "two-layer-mvp";
  readonly layerCount: 2;
  readonly routingTarget: "45-degree";
  readonly designRules: {
    readonly minimumClearanceMm: number;
    readonly viaDrillMm: number;
    readonly viaPadMm: number;
  };
  readonly netClasses: readonly PcbNetClassRule[];
  readonly assumptions: readonly string[];
}

export const DEFAULT_TWO_LAYER_MVP_RULE_PROFILE: PcbMvpRuleProfile = Object.freeze({
  name: "two-layer-mvp",
  layerCount: 2,
  routingTarget: "45-degree",
  designRules: Object.freeze({ minimumClearanceMm: 0.2, viaDrillMm: 0.3, viaPadMm: 0.6 }),
  netClasses: Object.freeze([
    Object.freeze({ id: "signal", minimumWidthMm: 0.25, clearanceMm: 0.2, currentAssumption: "current not supplied" }),
    Object.freeze({ id: "power", minimumWidthMm: 0.5, clearanceMm: 0.25, currentAssumption: "current not supplied; verify from load" })
  ]),
  assumptions: Object.freeze([
    "Widths are starting geometry, not current-capacity claims.",
    "Signal integrity, impedance, thermal performance, and load current remain assumptions until supplied or checked."
  ])
});

export interface PcbDesignerPromptConstraints {
  readonly boardPurpose?: string;
  readonly constraints?: readonly string[];
  /** Alias for callers that label their input explicitly. */
  readonly userConstraints?: readonly string[];
  readonly profile?: PcbMvpRuleProfile;
  /** Upper bound for provider calls; ordinary calls default to 2,400 characters. */
  readonly maxChars?: number;
  /** Deep rules are omitted unless the caller supplies an explicit selector. */
  readonly deepRuleSelection?: DeepRuleSelector;
  /** Optional explicit absolute path + corpus-identity binding; defaults to the packaged resource. */
  readonly deepRuleResourceProfile?: DeepRuleResourceProfile;
  readonly deepRuleMaxChars?: number;
  readonly deepRuleMaxRules?: number;
  /**
   * Host-rendered compact selection. When present, every selector ID must be
   * retained and the combined prompt fails closed instead of truncating it.
   */
  readonly exactDeepRulePrompt?: string;
}

export interface PcbCheckFinding {
  readonly severity?: "advisory" | "warning" | "error" | string;
  readonly code?: string;
  readonly message: string;
}

export interface PcbCheckFeedback {
  readonly analyzer?: { readonly outcome?: "pass" | "review" | "fail" | string; readonly findings?: readonly PcbCheckFinding[] };
  readonly erc?: { readonly status?: "clean" | "failed" | "unresolved" | "not_run" | string; readonly findings?: readonly PcbCheckFinding[] };
  readonly drc?: { readonly status?: "clean" | "failed" | "unresolved" | "not_run" | string; readonly findings?: readonly PcbCheckFinding[] };
}

const DEFAULT_PROMPT_CHARS = 2_400;
const MAX_PROMPT_CHARS = 16_384;
const MAX_FEEDBACK_CHARS = 1_400;

const compact = (value: string): string => value.replace(/\s+/gu, " ").trim();
const bounded = (value: string, maxChars: number): string =>
  value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 15)).trimEnd()} [truncated]`;
const usableLines = (values: readonly string[] | undefined): readonly string[] =>
  (values ?? []).map(compact).filter((value) => value.length > 0);

/** Renders stable, compact instructions without treating default geometry as qualification. */
export function renderPcbDesignerPrompt(constraints: PcbDesignerPromptConstraints = {}): string {
  const profile = constraints.profile ?? DEFAULT_TWO_LAYER_MVP_RULE_PROFILE;
  const requestedLimit = constraints.maxChars ?? DEFAULT_PROMPT_CHARS;
  const limit = Math.min(MAX_PROMPT_CHARS, Math.max(400, Math.floor(requestedLimit)));
  const custom = [...usableLines(constraints.constraints), ...usableLines(constraints.userConstraints)];
  const netClasses = profile.netClasses
    .map((netClass) => `${netClass.id}: >=${netClass.minimumWidthMm} mm, clearance >=${netClass.clearanceMm} mm (${netClass.currentAssumption})`)
    .join("; ");
  const sections = [
    PCB_DESIGNER_SYSTEM_INSTRUCTIONS,
    `Profile: ${profile.layerCount}-layer MVP; configured minimum clearance ${profile.designRules.minimumClearanceMm} mm; via drill/pad ${profile.designRules.viaDrillMm}/${profile.designRules.viaPadMm} mm.`,
    `Net classes: ${netClasses}.`,
    constraints.boardPurpose === undefined || compact(constraints.boardPurpose).length === 0
      ? "Board purpose: not supplied."
      : `Board purpose: ${compact(constraints.boardPurpose)}.`,
    custom.length === 0 ? "User constraints: none supplied." : `User constraints: ${custom.map((item) => `- ${item}`).join(" ")}`,
    `Assumptions: ${profile.assumptions.join(" ")}.`
  ];
  const basePrompt = sections.join("\n");
  if (constraints.deepRuleSelection === undefined) return bounded(basePrompt, limit);

  if (constraints.exactDeepRulePrompt !== undefined) {
    const deepPrompt = constraints.exactDeepRulePrompt;
    if (deepPrompt.trim().length === 0) throw new Error("Exact deep-rule prompt must not be blank.");
    if (deepPrompt.includes("[truncated]") || deepPrompt.includes("[shortened]")) {
      throw new Error("Exact deep-rule prompt must not contain shortened or truncated records.");
    }
    const selectedIds = constraints.deepRuleSelection.ids;
    if (selectedIds === undefined || selectedIds.length === 0) {
      throw new Error("Exact deep-rule prompt requires an explicit non-empty ID selector.");
    }
    if (constraints.deepRuleMaxRules !== undefined && selectedIds.length > Math.floor(constraints.deepRuleMaxRules)) {
      throw new Error(`Exact deep-rule selection exceeds the ${constraints.deepRuleMaxRules}-rule budget.`);
    }
    const renderedIds = [...deepPrompt.matchAll(/^- \[([^|\]]+)(?:\||\])/gmu)].map((match) => match[1]!);
    if (renderedIds.length !== selectedIds.length || renderedIds.some((id, index) => id !== selectedIds[index])) {
      throw new Error("Exact deep-rule prompt IDs do not exactly match the selected rule IDs.");
    }
    const deepByteLimit = constraints.deepRuleMaxChars ?? MAX_PROMPT_CHARS;
    if (Buffer.byteLength(deepPrompt, "utf8") > deepByteLimit) {
      throw new Error(`Exact deep-rule prompt exceeds the ${deepByteLimit}-byte budget.`);
    }
    const combined = `${basePrompt}\n${deepPrompt}`;
    if (combined.length > limit) {
      throw new Error(`PCB designer prompt cannot retain the exact deep-rule selection within ${limit} characters.`);
    }
    return combined;
  }

  const catalog = loadDeepRuleCatalog(constraints.deepRuleResourceProfile);
  const deepBudget = Math.min(
    constraints.deepRuleMaxChars ?? 1_000,
    Math.max(320, Math.floor(limit * 0.48))
  );
  const deepPrompt = renderDeepRulePrompt(catalog, {
    selector: constraints.deepRuleSelection,
    maxChars: deepBudget,
    ...(constraints.deepRuleMaxRules === undefined ? {} : { maxRules: constraints.deepRuleMaxRules })
  });
  const baseBudget = Math.max(1, limit - deepPrompt.length - 1);
  return `${bounded(basePrompt, baseBudget)}\n${deepPrompt}`.slice(0, limit);
}

const checkState = (status: string | undefined): "clean" | "unresolved" =>
  status === "clean" ? "clean" : "unresolved";

/** Converts the latest analyzer/ERC/DRC result into a bounded next-edit instruction. */
export function summarizePcbFeedbackForNextIteration(
  feedback: PcbCheckFeedback,
  maxChars = MAX_FEEDBACK_CHARS
): string {
  const limit = Math.min(MAX_FEEDBACK_CHARS, Math.max(240, Math.floor(maxChars)));
  const ercState = checkState(feedback.erc?.status);
  const drcState = checkState(feedback.drc?.status);
  const analyzerOutcome = feedback.analyzer?.outcome ?? "unresolved";
  const findings = [
    ...(feedback.analyzer?.findings ?? []),
    ...(feedback.erc?.findings ?? []),
    ...(feedback.drc?.findings ?? [])
  ];
  const unique = [...new Set(findings.map((finding) => {
    const prefix = [finding.severity, finding.code].filter(Boolean).join("/");
    return `${prefix ? `${prefix}: ` : ""}${compact(finding.message)}`;
  }).filter((finding) => finding.length > 0))];
  const validation = ercState === "clean" && drcState === "clean" && analyzerOutcome === "pass"
    ? "Checks reported clean: analyzer pass, ERC clean, DRC clean."
    : `Validation unresolved: analyzer ${analyzerOutcome}; ERC ${ercState}; DRC ${drcState}. Do not claim the board is clean.`;
  const next = unique.length === 0
    ? "No finding details were supplied; rerun ERC and DRC after the next edit."
    : `Fix next: ${unique.map((finding) => `- ${finding}`).join(" ")}`;
  return bounded(`${validation}\n${next}\nRecheck ERC and DRC after edits; preserve assumptions for SI, thermal, and current limits.`, limit);
}

/** Short aliases for integration code that uses generic prompt/feedback names. */
export const renderPcbConstraintsPrompt = renderPcbDesignerPrompt;
export const summarizePcbCheckFeedback = summarizePcbFeedbackForNextIteration;
