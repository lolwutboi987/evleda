import {
  type DeepPcbRule,
  type DeepRuleCatalog,
  type DeepRuleSelector
} from "./deep-rule-catalog.js";

export type DeepRuleDesignFeatureName =
  | "powerCurrent"
  | "signalSpeedInterfaces"
  | "differentialPairs"
  | "stackupImpedance"
  | "thermal"
  | "emi"
  | "placement"
  | "dfm"
  | "assembly"
  | "bga"
  | "gpio";

export interface DeepRuleFeatureDetails {
  /** An object is enabled by default. Set false to suppress it explicitly. */
  readonly enabled?: boolean;
  /**
   * Bounded design vocabulary such as `USB 2.0`, `1 ns edge`, `buck`, or
   * `0.5 mm pitch`. Terms influence ranking only and are never copied into the
   * provider prompt.
   */
  readonly terms?: readonly string[];
  readonly priority?: "normal" | "high";
}

export type DeepRuleFeatureInput = boolean | DeepRuleFeatureDetails;

/** Structured result of prompt/design feature extraction. */
export interface DeepRuleDesignFeatures {
  readonly powerCurrent?: DeepRuleFeatureInput;
  readonly signalSpeedInterfaces?: DeepRuleFeatureInput;
  readonly differentialPairs?: DeepRuleFeatureInput;
  readonly stackupImpedance?: DeepRuleFeatureInput;
  readonly thermal?: DeepRuleFeatureInput;
  readonly emi?: DeepRuleFeatureInput;
  readonly placement?: DeepRuleFeatureInput;
  readonly dfm?: DeepRuleFeatureInput;
  readonly assembly?: DeepRuleFeatureInput;
  readonly bga?: DeepRuleFeatureInput;
  readonly gpio?: DeepRuleFeatureInput;
}

export type DeepRuleBaselineProfile = "general" | "zero-via";

export interface DeepRuleSelectionOptions {
  /** Hard-capped at 40. The nine mandatory baseline rules count toward it. */
  readonly maxRules?: number;
  /** UTF-8 byte cap for the compact prompt; hard-capped at 16 KiB. */
  readonly maxPromptBytes?: number;
  /** Token cap according to tokenCounter; hard-capped at 16,384. */
  readonly maxPromptTokens?: number;
  /**
   * `require-all` is fail-closed and is the default. `report-incomplete` is
   * intended for UI diagnostics only: callers must not send an incomplete
   * selection to a provider as if all active features were represented.
   */
  readonly featureCoveragePolicy?: "require-all" | "report-incomplete";
  /**
   * Supply the target model's tokenizer for exact accounting. Without one,
   * every UTF-8 byte is counted as one token: deliberately conservative for
   * byte-level tokenizers and deterministic across providers.
   */
  readonly tokenCounter?: (prompt: string) => number;
}

/** Host-reviewed task profile, deliberately separate from general caller budgets. */
export interface DeepRuleTaskProfile {
  /** Zero-via replaces return-via insertion guidance with avoid-unnecessary-via guidance. */
  readonly baselineProfile?: DeepRuleBaselineProfile;
  /** Every preferred ID must remain eligible and topic-relevant to its feature. */
  readonly featureRulePreferences?: Partial<Record<DeepRuleDesignFeatureName, readonly string[]>>;
}

export interface CompactDeepRuleSource {
  readonly dossierPath: string;
  readonly headingAnchor: string;
  readonly dossierLineStart: number;
  readonly dossierLineEnd: number;
  readonly articleUrl: string;
}

export interface CompactSelectedDeepRule {
  readonly id: string;
  readonly topic: string;
  readonly category: string;
  readonly severity: DeepPcbRule["severity"];
  readonly instructionExcerpt: string;
  readonly source: CompactDeepRuleSource;
  readonly reasons: readonly ("baseline" | DeepRuleDesignFeatureName)[];
}

export interface BoundedDeepRuleSelection {
  /** Pass this field directly to PcbDesignerPromptConstraints.deepRuleSelection. */
  readonly deepRuleSelection: DeepRuleSelector;
  readonly rules: readonly CompactSelectedDeepRule[];
  /** A compact alternative rendering with stable IDs and source anchors. */
  readonly prompt: string;
  /** Selection coverage only; never a board/manufacturing readiness claim. */
  readonly disposition: "ready-for-prompt" | "incomplete";
  readonly activeFeatures: readonly DeepRuleDesignFeatureName[];
  readonly coveredFeatures: readonly DeepRuleDesignFeatureName[];
  readonly uncoveredFeatures: readonly DeepRuleDesignFeatureName[];
  readonly omittedCandidateCount: number;
  readonly budget: {
    readonly maxRules: number;
    readonly usedRules: number;
    readonly maxPromptBytes: number;
    readonly usedPromptBytes: number;
    readonly maxPromptTokens: number;
    readonly usedPromptTokens: number;
    readonly tokenAccounting: "utf8-byte-upper-bound" | "caller-supplied";
  };
}

interface FeatureDefinition {
  readonly name: DeepRuleDesignFeatureName;
  readonly topics: readonly string[];
  readonly keywords: readonly string[];
  readonly priority: number;
}

interface ActiveFeature extends FeatureDefinition {
  readonly terms: readonly NormalizedSearchTerm[];
  readonly requestedPriority: "normal" | "high";
}

interface NormalizedSearchTerm {
  readonly key: string;
  readonly tokens: readonly string[];
}

interface RankedRule {
  readonly rule: DeepPcbRule;
  readonly score: number;
}

const DEFAULT_MAX_RULES = 24;
const HARD_MAX_RULES = 40;
const DEFAULT_MAX_PROMPT_BYTES = 8_192;
const HARD_MAX_PROMPT_BYTES = 16_384;
const DEFAULT_MAX_PROMPT_TOKENS = 8_192;
const HARD_MAX_PROMPT_TOKENS = 16_384;
const MAX_FEATURE_TERMS = 24;
const MAX_FEATURE_TERM_CHARS = 80;
const MAX_RULES_PER_FEATURE = 8;
const MAX_INSTRUCTION_EXCERPT_CHARS = 240;

const PROMPT_BOUNDARY =
  "Deep PCB guidance only: do not fabricate, order, certify, qualify, or release from these excerpts; vendor-specific values are not universal.";

const GENERAL_BASELINE_RULES = Object.freeze([
  { id: "PCB01-R002", purpose: "schematic" },
  { id: "PCB01-R017", purpose: "erc" },
  { id: "PCB16-R004", purpose: "placement" },
  { id: "PCB03-R040", purpose: "routing" },
  { id: "PCB05-R020", purpose: "routing-geometry" },
  { id: "PCB02-R005", purpose: "trace-width" },
  { id: "PCB02-R070", purpose: "via-current" },
  { id: "PCB05-R066", purpose: "via-return-path" },
  { id: "PCB13-R057", purpose: "drc" }
] as const);

const ZERO_VIA_BASELINE_RULES = Object.freeze([
  { id: "PCB01-R002", purpose: "schematic" },
  { id: "PCB01-R017", purpose: "erc" },
  { id: "PCB16-R004", purpose: "placement" },
  { id: "PCB03-R040", purpose: "routing" },
  { id: "PCB05-R020", purpose: "routing-geometry" },
  { id: "PCB02-R005", purpose: "trace-width" },
  { id: "PCB02-R070", purpose: "via-current" },
  { id: "PCB05-R072", purpose: "avoid-unnecessary-vias" },
  { id: "PCB13-R057", purpose: "drc" }
] as const);

const BASELINE_RULE_PROFILES = Object.freeze({
  general: GENERAL_BASELINE_RULES,
  "zero-via": ZERO_VIA_BASELINE_RULES,
});

/** Stable baseline IDs. Changing this list is a reviewed rule-policy change. */
export const BASELINE_DEEP_RULE_IDS: readonly string[] = Object.freeze(
  GENERAL_BASELINE_RULES.map(({ id }) => id)
);

/** Stable baseline for contracts that prohibit vias entirely. */
export const ZERO_VIA_BASELINE_DEEP_RULE_IDS: readonly string[] = Object.freeze(
  ZERO_VIA_BASELINE_RULES.map(({ id }) => id)
);

const FEATURE_DEFINITIONS: readonly FeatureDefinition[] = Object.freeze([
  {
    name: "powerCurrent",
    topics: ["trace-current", "power-integrity"],
    keywords: ["rms", "peak current", "voltage drop", "trace", "via", "neck-down", "fault", "current path", "pdn", "decoupling"],
    priority: 110
  },
  {
    name: "thermal",
    topics: ["trace-current", "power-integrity", "component-placement"],
    keywords: ["thermal", "temperature", "heat", "dissipation", "ambient", "hotspot", "airflow", "junction"],
    priority: 105
  },
  {
    name: "bga",
    topics: ["bga", "assembly", "stackup-impedance"],
    keywords: ["ball map", "pitch", "escape", "fanout", "via-in-pad", "vippo", "microvia", "x-ray", "warpage"],
    priority: 100
  },
  {
    name: "stackupImpedance",
    topics: ["stackup-impedance", "impedance-matching"],
    keywords: ["stackup", "controlled impedance", "field solver", "reference plane", "dielectric", "copper", "tolerance", "impedance"],
    priority: 95
  },
  {
    name: "differentialPairs",
    topics: ["differential-pairs", "signal-integrity", "stackup-impedance"],
    keywords: ["differential", "pair", "skew", "mode conversion", "symmetry", "coupled", "p/n", "reference"],
    priority: 90
  },
  {
    name: "signalSpeedInterfaces",
    topics: ["signal-integrity", "impedance-matching", "stackup-impedance", "hf-emc-si"],
    keywords: ["edge rate", "rise time", "reflection", "topology", "termination", "crosstalk", "return path", "interface", "timing"],
    priority: 85
  },
  {
    name: "emi",
    topics: ["emi-emc", "hf-emc-si"],
    keywords: ["emi", "emc", "emissions", "immunity", "common mode", "loop area", "return path", "cable", "shield", "esd"],
    priority: 80
  },
  {
    name: "gpio",
    topics: ["gpio-pinouts", "schematic-quality"],
    keywords: ["gpio", "logic level", "threshold", "pull-up", "pull-down", "open-drain", "reset", "back-power", "connector"],
    priority: 75
  },
  {
    name: "placement",
    topics: ["component-placement", "layout-guide"],
    keywords: ["placement", "floorplan", "connector", "mechanical", "keepout", "decoupling", "functional", "ratsnest", "return"],
    priority: 70
  },
  {
    name: "dfm",
    topics: ["dfm", "layout-process"],
    keywords: ["drc", "clearance", "annular ring", "drill", "mask", "courtyard", "rule profile", "minimum", "inspect"],
    priority: 65
  },
  {
    name: "assembly",
    topics: ["assembly", "component-placement"],
    keywords: ["footprint", "courtyard", "polarity", "paste", "stencil", "reflow", "orientation", "inspection", "rework"],
    priority: 60
  }
]);

const SEVERITY_SCORE: Readonly<Record<DeepPcbRule["severity"], number>> = Object.freeze({
  critical: 40_000,
  error: 30_000,
  warning: 20_000,
  advisory: 10_000
});

const CATEGORY_SCORE: Readonly<Record<string, number>> = Object.freeze({
  "hard-stop": 900,
  "unknown-handling": 850,
  "required-input": 800,
  "prohibited-inference": 750,
  verification: 700,
  "design-action": 650,
  analysis: 500,
  "source-governance": 300,
  "required-output": 200
});

const RELEASE_OR_MANUFACTURING_ACTION =
  /\b(?:fabricate|place (?:a |the )?(?:board |fabrication )?order|order (?:the |this |a )?(?:board|pcb|assembly)|release(?:d)? (?:the |this |a )?(?:boards?|designs?|jobs?|tags?|manifests?|packages?|archives?|outputs?)|(?:generate|export|submit|send) .{0,80}(?:gerber|odb\+\+|drill|fabrication|manufacturing|assembly output|fabricator|assembler)|procure|purchase)\b/iu;
const RESEARCH_NARRATIVE = /^(?:research stopped|article proposition|claim family)\b/iu;
const VENDOR_REFERENCE = /\b(?:jlcpcb|jlc|pcbway|osh[ _-]?park|eurocircuits)\b/iu;
const NAMED_FAB_PROFILE = /\b(?:jlc(?:pcb)?|pcbway|osh[ _-]?park|eurocircuits)[_-][\p{L}\p{N}._-]+/iu;
const NUMERIC_PROCESS_VALUE = /(?:\d|\b(?:mm|mil|mils|oz|µm|μm|um|layers?)\b)/iu;
const ALLOWED_SHORT_TECHNICAL_TERMS: ReadonlySet<string> = new Set(["io", "pi", "rf", "si"]);
const NON_SEMANTIC_TERM_TOKENS: ReadonlySet<string> = new Set([
  "a", "c", "f", "hz", "khz", "mhz", "ghz", "mm", "mil", "mils", "ms", "ns", "oz", "ps", "s", "um", "us", "v", "w", "µm", "μm"
]);

const compact = (value: string): string => value.replace(/\s+/gu, " ").trim();
const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");
const compareAscii = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const wordTokens = (value: string): readonly string[] =>
  value.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

const containsTokenPhrase = (haystack: readonly string[], needle: readonly string[]): boolean => {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    if (needle.every((token, offset) => haystack[start + offset] === token)) return true;
  }
  return false;
};

const positiveInteger = (value: number | undefined, fallback: number, name: string, hardMaximum: number): number => {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Math.min(value, hardMaximum);
};

const normalizeTerms = (terms: readonly string[] | undefined, featureName: string): readonly NormalizedSearchTerm[] => {
  if (terms === undefined) return [];
  if (terms.length > MAX_FEATURE_TERMS) {
    throw new Error(`${featureName}.terms must contain at most ${MAX_FEATURE_TERMS} entries`);
  }
  const normalized = new Map<string, NormalizedSearchTerm>();
  for (const [index, term] of terms.entries()) {
    if (typeof term !== "string") throw new Error(`${featureName}.terms[${index}] must be a string`);
    const value = compact(term.normalize("NFKC")).toLowerCase();
    if (value.length === 0) throw new Error(`${featureName}.terms[${index}] must not be blank`);
    if (value.length > MAX_FEATURE_TERM_CHARS) {
      throw new Error(`${featureName}.terms[${index}] must be at most ${MAX_FEATURE_TERM_CHARS} characters`);
    }
    const tokens = wordTokens(value).filter((token) =>
      !NON_SEMANTIC_TERM_TOKENS.has(token)
      && !/^\d+$/u.test(token)
      && (token.length >= 3 || ALLOWED_SHORT_TECHNICAL_TERMS.has(token))
    );
    if (tokens.length === 0) {
      throw new Error(`${featureName}.terms[${index}] must include a meaningful whole technical token`);
    }
    const key = tokens.join(" ");
    if (!normalized.has(key)) normalized.set(key, { key, tokens });
  }
  return [...normalized.values()];
};

const activeFeatures = (features: DeepRuleDesignFeatures): readonly ActiveFeature[] => {
  const active: ActiveFeature[] = [];
  for (const definition of FEATURE_DEFINITIONS) {
    const input = features[definition.name];
    if (input === undefined || input === false) continue;
    if (typeof input !== "boolean" && (input === null || typeof input !== "object" || Array.isArray(input))) {
      throw new Error(`${definition.name} must be a boolean or feature-details object`);
    }
    if (typeof input !== "boolean" && input.enabled === false) continue;
    const details = typeof input === "boolean" ? undefined : input;
    const priority = details?.priority ?? "normal";
    if (priority !== "normal" && priority !== "high") throw new Error(`${definition.name}.priority is invalid`);
    active.push({
      ...definition,
      terms: normalizeTerms(details?.terms, definition.name),
      requestedPriority: priority
    });
  }
  return active.sort((left, right) => {
    const requested = Number(right.requestedPriority === "high") - Number(left.requestedPriority === "high");
    return requested !== 0 ? requested : right.priority - left.priority;
  });
};

const ruleSearchTokens = (rule: DeepPcbRule): readonly string[] => wordTokens(compact([
  rule.instruction,
  rule.rationale,
  rule.applicability,
  ...rule.requiredInputs,
  ...rule.checks,
  ...rule.tags
].join(" ")));

const isEligibleOperationalRule = (rule: DeepPcbRule): boolean => {
  if (rule.category === "release-gate") return false;
  if (rule.vendorScope.toLocaleLowerCase().startsWith("jlcpcb-specific")) return false;
  const instruction = compact(rule.instruction);
  if (RESEARCH_NARRATIVE.test(instruction)) return false;
  if (RELEASE_OR_MANUFACTURING_ACTION.test(instruction)) return false;
  // A shortened excerpt must never expose a JLC process number without its
  // surrounding caveat. Vendor-neutral principles remain available instead.
  if (NAMED_FAB_PROFILE.test(instruction)) return false;
  if (VENDOR_REFERENCE.test(instruction) && NUMERIC_PROCESS_VALUE.test(instruction)) return false;
  return true;
};

const rankForFeature = (catalog: DeepRuleCatalog, feature: ActiveFeature): readonly RankedRule[] => {
  const topicPosition = new Map(feature.topics.map((topic, index) => [topic, index]));
  const keywordTerms = feature.keywords.map((keyword) => wordTokens(keyword));
  const ranked: RankedRule[] = [];
  for (const rule of catalog.rules) {
    const topicIndex = topicPosition.get(rule.topic);
    if (topicIndex === undefined || !isEligibleOperationalRule(rule)) continue;
    const tokens = ruleSearchTokens(rule);
    const keywordHits = keywordTerms.reduce((count, term) => count + Number(containsTokenPhrase(tokens, term)), 0);
    const requestedTermHits = feature.terms.reduce(
      (count, term) => count + Number(containsTokenPhrase(tokens, term.tokens)),
      0
    );
    const score = SEVERITY_SCORE[rule.severity]
      + (CATEGORY_SCORE[rule.category] ?? 0)
      + (feature.topics.length - topicIndex) * 100
      + keywordHits * 12
      // An explicit interface/package term must be able to outrank generic
      // rules from the same dossier. Severity remains the first discriminator
      // among equally relevant rules.
      + Number(requestedTermHits > 0) * 25_000
      + requestedTermHits * 1_000;
    ranked.push({ rule, score });
  }
  return ranked.sort((left, right) => right.score - left.score || compareAscii(left.rule.id, right.rule.id));
};

const excerpt = (instruction: string): string => {
  const value = compact(instruction);
  if (value.length <= MAX_INSTRUCTION_EXCERPT_CHARS) return value;
  const initial = value.slice(0, MAX_INSTRUCTION_EXCERPT_CHARS - 1);
  const candidateBreaks = [initial.lastIndexOf(". "), initial.lastIndexOf("; "), initial.lastIndexOf(", ")];
  const breakAt = Math.max(...candidateBreaks);
  const shortened = breakAt >= Math.floor(MAX_INSTRUCTION_EXCERPT_CHARS * 0.58)
    ? initial.slice(0, breakAt + 1)
    : initial;
  return `${shortened.trimEnd()}…`;
};

const compactSource = (rule: DeepPcbRule): CompactDeepRuleSource => ({
  dossierPath: rule.dossierPath,
  headingAnchor: rule.headingAnchor,
  dossierLineStart: rule.dossierLineStart,
  dossierLineEnd: rule.dossierLineEnd,
  articleUrl: rule.articleUrl
});

const toCompactRule = (
  rule: DeepPcbRule,
  reasons: readonly ("baseline" | DeepRuleDesignFeatureName)[]
): CompactSelectedDeepRule => ({
  id: rule.id,
  topic: rule.topic,
  category: rule.category,
  severity: rule.severity,
  instructionExcerpt: excerpt(rule.instruction),
  source: compactSource(rule),
  reasons
});

const renderCompactSelectionPrompt = (rules: readonly CompactSelectedDeepRule[]): string => [
  PROMPT_BOUNDARY,
  ...rules.map((rule) =>
    `- [${rule.id}|${rule.severity}|${rule.topic}] ${rule.instructionExcerpt} @ ${rule.source.dossierPath}#${rule.source.headingAnchor}:L${rule.source.dossierLineStart}-L${rule.source.dossierLineEnd}`
  )
].join("\n");

const countedTokens = (
  prompt: string,
  tokenCounter: ((prompt: string) => number) | undefined
): number => {
  const count = tokenCounter === undefined ? utf8Bytes(prompt) : tokenCounter(prompt);
  if (!Number.isFinite(count) || !Number.isInteger(count) || count < 0) {
    throw new Error("tokenCounter must return a non-negative integer");
  }
  return count;
};

const orderedReasons = (
  id: string,
  reasonIds: ReadonlyMap<string, ReadonlySet<DeepRuleDesignFeatureName>>,
  baselineIds: ReadonlySet<string>
): readonly ("baseline" | DeepRuleDesignFeatureName)[] => {
  const reasons: ("baseline" | DeepRuleDesignFeatureName)[] = [];
  if (baselineIds.has(id)) reasons.push("baseline");
  const featureReasons = reasonIds.get(id);
  if (featureReasons !== undefined) {
    for (const definition of FEATURE_DEFINITIONS) {
      if (featureReasons.has(definition.name)) reasons.push(definition.name);
    }
  }
  return reasons;
};

/**
 * Selects a safety-first, deterministic, bounded set from the deep rule
 * catalog. The selector never performs manufacturing/release work and never
 * emits JLC-specific process numbers as universal guidance.
 */
export function selectDeepRulesForDesign(
  catalog: DeepRuleCatalog,
  features: DeepRuleDesignFeatures = {},
  options: DeepRuleSelectionOptions = {},
  taskProfile: DeepRuleTaskProfile = {},
): BoundedDeepRuleSelection {
  const maxRules = positiveInteger(options.maxRules, DEFAULT_MAX_RULES, "maxRules", HARD_MAX_RULES);
  const maxPromptBytes = positiveInteger(
    options.maxPromptBytes,
    DEFAULT_MAX_PROMPT_BYTES,
    "maxPromptBytes",
    HARD_MAX_PROMPT_BYTES
  );
  const maxPromptTokens = positiveInteger(
    options.maxPromptTokens,
    DEFAULT_MAX_PROMPT_TOKENS,
    "maxPromptTokens",
    HARD_MAX_PROMPT_TOKENS
  );
  const featureCoveragePolicy = options.featureCoveragePolicy ?? "require-all";
  if (featureCoveragePolicy !== "require-all" && featureCoveragePolicy !== "report-incomplete") {
    throw new Error("featureCoveragePolicy must be require-all or report-incomplete");
  }
  const baselineProfile = taskProfile.baselineProfile ?? "general";
  if (baselineProfile !== "general" && baselineProfile !== "zero-via") {
    throw new Error("baselineProfile must be general or zero-via");
  }
  const baselineRules = BASELINE_RULE_PROFILES[baselineProfile];
  if (maxRules < baselineRules.length) {
    throw new Error(`maxRules must be at least ${baselineRules.length} to retain the mandatory baseline`);
  }

  const byId = new Map<string, DeepPcbRule>();
  for (const rule of catalog.rules) {
    if (byId.has(rule.id)) throw new Error(`Duplicate deep rule ID: ${rule.id}`);
    byId.set(rule.id, rule);
  }
  const baseline = baselineRules.map(({ id, purpose }) => {
    const rule = byId.get(id);
    if (rule === undefined) throw new Error(`Deep rule catalog is missing mandatory ${purpose} baseline ${id}`);
    if (!isEligibleOperationalRule(rule)) throw new Error(`Mandatory ${purpose} baseline ${id} is no longer provider-eligible`);
    return rule;
  });
  const baselineIds = new Set(baseline.map((rule) => rule.id));
  const active = activeFeatures(features);
  if (featureCoveragePolicy === "require-all" && maxRules < baselineRules.length + active.length) {
    throw new Error(
      `maxRules must be at least ${baselineRules.length + active.length} to retain baselines and one distinct rule per active feature`
    );
  }
  const preferenceInput = taskProfile.featureRulePreferences ?? {};
  const knownFeatureNames = new Set(FEATURE_DEFINITIONS.map((definition) => definition.name));
  for (const name of Object.keys(preferenceInput)) {
    if (!knownFeatureNames.has(name as DeepRuleDesignFeatureName)) throw new Error(`Unknown featureRulePreferences key: ${name}`);
  }
  const rankings = new Map<DeepRuleDesignFeatureName, readonly RankedRule[]>();
  const reasonIds = new Map<string, Set<DeepRuleDesignFeatureName>>();
  for (const feature of active) {
    const allRanked = rankForFeature(catalog, feature);
    const preferredIds = preferenceInput[feature.name] ?? [];
    if (preferredIds.length > MAX_RULES_PER_FEATURE) {
      throw new Error(`${feature.name} featureRulePreferences must contain at most ${MAX_RULES_PER_FEATURE} IDs`);
    }
    const preferredSet = new Set<string>();
    const preferred: RankedRule[] = [];
    for (const [index, id] of preferredIds.entries()) {
      if (typeof id !== "string" || !/^PCB\d{2}-R\d{3}$/u.test(id)) {
        throw new Error(`${feature.name} featureRulePreferences[${index}] is not a stable rule ID`);
      }
      if (preferredSet.has(id)) throw new Error(`${feature.name} featureRulePreferences contains duplicate ${id}`);
      preferredSet.add(id);
      const match = allRanked.find((candidate) => candidate.rule.id === id);
      if (match === undefined) {
        throw new Error(`${feature.name} preferred rule ${id} is missing, ineligible, or not relevant to that feature`);
      }
      preferred.push(match);
    }
    rankings.set(feature.name, [...preferred, ...allRanked.filter((candidate) => !preferredSet.has(candidate.rule.id))].slice(0, MAX_RULES_PER_FEATURE));
  }

  const selected = [...baseline];
  const selectedIds = new Set(selected.map((rule) => rule.id));
  const render = (candidateRules: readonly DeepPcbRule[]): {
    readonly compactRules: readonly CompactSelectedDeepRule[];
    readonly prompt: string;
    readonly bytes: number;
    readonly tokens: number;
  } => {
    const compactRules = candidateRules.map((rule) =>
      toCompactRule(rule, orderedReasons(rule.id, reasonIds, baselineIds))
    );
    const prompt = renderCompactSelectionPrompt(compactRules);
    return {
      compactRules,
      prompt,
      bytes: utf8Bytes(prompt),
      tokens: countedTokens(prompt, options.tokenCounter)
    };
  };

  let rendered = render(selected);
  if (rendered.bytes > maxPromptBytes || rendered.tokens > maxPromptTokens) {
    throw new Error(
      `Prompt budget cannot retain the mandatory baseline: needs ${rendered.bytes} bytes/${rendered.tokens} tokens, `
      + `received ${maxPromptBytes} bytes/${maxPromptTokens} tokens`
    );
  }

  const cursors = new Map<DeepRuleDesignFeatureName, number>(active.map((feature) => [feature.name, 0]));
  const covered = new Set<DeepRuleDesignFeatureName>();
  const attributeSelection = (id: string, featureName: DeepRuleDesignFeatureName): void => {
    const reasons = reasonIds.get(id) ?? new Set<DeepRuleDesignFeatureName>();
    reasons.add(featureName);
    reasonIds.set(id, reasons);
  };

  // Coverage pass: reserve one distinct, non-baseline rule for every active
  // feature before spending budget on depth. Baseline rules never masquerade
  // as feature coverage even when their text happens to overlap a feature.
  for (const feature of active) {
    const ranked = rankings.get(feature.name) ?? [];
    let cursor = cursors.get(feature.name) ?? 0;
    while (cursor < ranked.length && selected.length < maxRules) {
      const candidate = ranked[cursor];
      cursor += 1;
      cursors.set(feature.name, cursor);
      if (candidate === undefined || selectedIds.has(candidate.rule.id)) continue;
      const proposed = render([...selected, candidate.rule]);
      if (proposed.bytes > maxPromptBytes || proposed.tokens > maxPromptTokens) continue;
      selected.push(candidate.rule);
      selectedIds.add(candidate.rule.id);
      attributeSelection(candidate.rule.id, feature.name);
      covered.add(feature.name);
      rendered = render(selected);
      break;
    }
  }

  let uncovered = active.filter((feature) => !covered.has(feature.name)).map((feature) => feature.name);
  if (uncovered.length > 0 && featureCoveragePolicy === "require-all") {
    throw new Error(
      `Active feature coverage incomplete for ${uncovered.join(", ")}; increase maxRules, maxPromptBytes, or maxPromptTokens`
    );
  }

  // Depth pass runs only after breadth is proven. A diagnostic incomplete
  // result deliberately does not spend remaining budget deepening a subset.
  let candidatesRemain = uncovered.length === 0;
  while (selected.length < maxRules && candidatesRemain) {
    candidatesRemain = false;
    for (const feature of active) {
      const ranked = rankings.get(feature.name) ?? [];
      let cursor = cursors.get(feature.name) ?? 0;
      while (cursor < ranked.length) {
        candidatesRemain = true;
        const candidate = ranked[cursor];
        cursor += 1;
        cursors.set(feature.name, cursor);
        if (candidate === undefined || selectedIds.has(candidate.rule.id)) continue;
        const proposed = render([...selected, candidate.rule]);
        if (proposed.bytes <= maxPromptBytes && proposed.tokens <= maxPromptTokens) {
          selected.push(candidate.rule);
          selectedIds.add(candidate.rule.id);
          attributeSelection(candidate.rule.id, feature.name);
          rendered = render(selected);
        }
        break;
      }
      if (selected.length >= maxRules) break;
    }
  }

  uncovered = active.filter((feature) => !covered.has(feature.name)).map((feature) => feature.name);
  const coveredFeatures = active.filter((feature) => covered.has(feature.name)).map((feature) => feature.name);
  rendered = render(selected);

  const candidateIds = new Set<string>();
  for (const ranked of rankings.values()) {
    for (const candidate of ranked) candidateIds.add(candidate.rule.id);
  }
  for (const id of baselineIds) candidateIds.delete(id);
  const selectedOptionalCount = selected.filter((rule) => !baselineIds.has(rule.id)).length;
  const omittedCandidateCount = Math.max(0, candidateIds.size - selectedOptionalCount);
  const ids = Object.freeze(selected.map((rule) => rule.id));

  return {
    deepRuleSelection: Object.freeze({ ids, limit: ids.length }),
    rules: Object.freeze(rendered.compactRules),
    prompt: rendered.prompt,
    disposition: uncovered.length === 0 ? "ready-for-prompt" : "incomplete",
    activeFeatures: Object.freeze(active.map((feature) => feature.name)),
    coveredFeatures: Object.freeze(coveredFeatures),
    uncoveredFeatures: Object.freeze(uncovered),
    omittedCandidateCount,
    budget: Object.freeze({
      maxRules,
      usedRules: selected.length,
      maxPromptBytes,
      usedPromptBytes: rendered.bytes,
      maxPromptTokens,
      usedPromptTokens: rendered.tokens,
      tokenAccounting: options.tokenCounter === undefined ? "utf8-byte-upper-bound" : "caller-supplied"
    })
  };
}

export const DEEP_RULE_SELECTOR_PROMPT_BOUNDARY = PROMPT_BOUNDARY;
export const DEEP_RULE_SELECTOR_HARD_MAX_RULES = HARD_MAX_RULES;
export const DEEP_RULE_SELECTOR_HARD_MAX_PROMPT_BYTES = HARD_MAX_PROMPT_BYTES;
