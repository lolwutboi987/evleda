import { createHash } from "node:crypto";

import {
  DEEP_RULE_SELECTOR_PROMPT_BOUNDARY,
  selectDeepRulesForDesign,
  type BoundedDeepRuleSelection,
  type DeepRuleDesignFeatures,
  type DeepRuleSelectionOptions,
  type DeepRuleTaskProfile,
} from "./deep-rule-selector.js";
import { loadDeepRuleCatalog, type DeepRuleCatalog } from "./deep-rule-catalog.js";
import {
  LED_INDICATOR_EXAMPLE,
  parseFreshLedIndicatorContract,
  type FreshLedIndicatorContract,
} from "./fresh-project.js";

/** Relevance-audited stable rule profile for the small zero-via LED proof. */
export const FRESH_LED_REVIEWED_DEEP_RULE_IDS: readonly string[] = Object.freeze([
  "PCB01-R002",
  "PCB01-R017",
  "PCB16-R004",
  "PCB03-R040",
  "PCB05-R020",
  "PCB02-R005",
  "PCB02-R070",
  "PCB05-R072",
  "PCB13-R057",
  "PCB02-R002",
  "PCB16-R084",
  "PCB02-R001",
]);

export const FRESH_LED_DEEP_RULE_PROFILE_ID = "evleda.fresh-led-zero-via.deep-rules.v2";

export const FRESH_LED_DEEP_RULE_SELECTION_OPTIONS = Object.freeze({
  maxRules: 12,
  maxPromptBytes: 4_608,
  maxPromptTokens: 4_608,
  featureCoveragePolicy: "require-all",
} as const satisfies DeepRuleSelectionOptions);

export const FRESH_LED_DEEP_RULE_TASK_PROFILE = Object.freeze({
  baselineProfile: "zero-via",
  featureRulePreferences: Object.freeze({
    powerCurrent: Object.freeze(["PCB02-R002"]),
    placement: Object.freeze(["PCB16-R084"]),
    thermal: Object.freeze(["PCB02-R001"]),
  }),
} as const satisfies DeepRuleTaskProfile);

/** Reviewed, deterministic selector profile and prompt budget. */
export const FRESH_LED_DEEP_RULE_SELECTION_PARAMETERS = Object.freeze({
  selectionOptions: FRESH_LED_DEEP_RULE_SELECTION_OPTIONS,
  taskProfile: FRESH_LED_DEEP_RULE_TASK_PROFILE,
});

/** The exact selected block plus the compact base prompt must fit this bound. */
export const FRESH_LED_DESIGNER_PROMPT_MAX_CHARS = 6_144;

export interface FreshDeepRuleSourceAnchor {
  readonly topic: string;
  readonly headingAnchor: string;
  readonly dossierLineStart: number;
  readonly dossierLineEnd: number;
}

export interface FreshDeepRuleMetadataRecord {
  readonly id: string;
  readonly topic: string;
  readonly severity: string;
  readonly instructionExcerpt: string;
  readonly source: FreshDeepRuleSourceAnchor;
}

export interface FreshDeepRuleReportMetadata {
  readonly schemaVersion: "evleda.fresh-deep-rule-selection.v2";
  readonly profileId: typeof FRESH_LED_DEEP_RULE_PROFILE_ID;
  readonly catalogIdentity: string;
  readonly selectionIdentity: string;
  readonly providerPromptSha256: string;
  readonly parameters: typeof FRESH_LED_DEEP_RULE_SELECTION_PARAMETERS;
  readonly disposition: "ready-for-prompt";
  readonly activeFeatures: readonly string[];
  readonly coveredFeatures: readonly string[];
  readonly selectedRuleIds: readonly string[];
  readonly budget: BoundedDeepRuleSelection["budget"];
  readonly providerPromptBudget: {
    readonly usedBytes: number;
    readonly usedTokens: number;
    readonly tokenAccounting: "utf8-byte-upper-bound";
  };
  readonly rules: readonly FreshDeepRuleMetadataRecord[];
}

export interface FreshLedDeepRulePolicy {
  readonly features: DeepRuleDesignFeatures;
  readonly selection: BoundedDeepRuleSelection & { readonly disposition: "ready-for-prompt" };
  /** Provider-safe compact rules. It contains no absolute or repository file paths. */
  readonly providerPrompt: string;
  readonly reportMetadata: FreshDeepRuleReportMetadata;
}

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const compact = (value: string): string => value.replace(/\s+/gu, " ").trim();
const containsAbsolutePath = (value: string): boolean =>
  /(?:[A-Za-z]:[\\/]|\\\\[^\\\s]|file:\/\/|\/(?:home|Users|tmp|var|mnt)\/)[^\s"'<>]*/iu.test(value);

const freeze = <Value>(value: Value): Value => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

/**
 * Extracts only from the validated host contract. The caller's natural-language
 * prompt cannot activate, suppress, or rank electrical rules for this proof.
 */
export function deriveFreshLedDeepRuleFeatures(contractInput: unknown): DeepRuleDesignFeatures {
  parseFreshLedIndicatorContract(contractInput);
  return freeze({
    powerCurrent: {
      priority: "high",
      terms: ["current path", "voltage drop", "trace width", "via current"],
    },
    placement: {
      priority: "high",
      // Component names and library symbols do not establish a decoupler role.
      // The selected checklist remains conditional on explicit task semantics.
      terms: ["connector", "component placement"],
    },
    // The contract supplies voltage and a bounded load, which supports thermal
    // review. It does not supply enough evidence for a temperature rating.
    thermal: {
      priority: "normal",
      terms: ["thermal", "dissipation"],
    },
  });
}

const renderProviderPrompt = (selection: BoundedDeepRuleSelection): string => [
  DEEP_RULE_SELECTOR_PROMPT_BOUNDARY,
  "Do not infer component roles from references or library symbols; apply role-specific clauses only when the task contract declares that role.",
  ...selection.rules.map((rule) =>
    `- [${rule.id}|${rule.severity}|${rule.topic}] ${compact(rule.instructionExcerpt)} @ ${rule.topic}#${rule.source.headingAnchor}:L${rule.source.dossierLineStart}-L${rule.source.dossierLineEnd}`
  ),
].join("\n");

/** Builds the fail-closed deep-rule policy for the validated fresh LED contract. */
export function createFreshLedDeepRulePolicy(
  contractInput: unknown = LED_INDICATOR_EXAMPLE,
  catalog: DeepRuleCatalog = loadDeepRuleCatalog(),
): FreshLedDeepRulePolicy {
  const contract: FreshLedIndicatorContract = parseFreshLedIndicatorContract(contractInput);
  if (contract.routing.maximumViaCount !== 0) {
    throw new Error("Fresh LED zero-via deep-rule profile requires maximumViaCount to remain zero.");
  }
  const features = deriveFreshLedDeepRuleFeatures(contract);
  const selection = selectDeepRulesForDesign(
    catalog,
    features,
    FRESH_LED_DEEP_RULE_SELECTION_OPTIONS,
    FRESH_LED_DEEP_RULE_TASK_PROFILE,
  );
  if (selection.disposition !== "ready-for-prompt" || selection.uncoveredFeatures.length !== 0) {
    throw new Error(`Fresh LED deep-rule selection is incomplete: ${selection.uncoveredFeatures.join(", ") || "unknown feature"}`);
  }
  const expectedIds = selection.rules.map((rule) => rule.id);
  const selectorIds = selection.deepRuleSelection.ids ?? [];
  if (
    expectedIds.length !== FRESH_LED_REVIEWED_DEEP_RULE_IDS.length
    || expectedIds.some((id, index) => FRESH_LED_REVIEWED_DEEP_RULE_IDS[index] !== id)
    || expectedIds.length !== selectorIds.length
    || expectedIds.some((id, index) => selectorIds[index] !== id)
  ) {
    throw new Error("Fresh LED deep-rule selector IDs do not exactly match the ready selection.");
  }
  const providerPrompt = renderProviderPrompt(selection);
  const usedBytes = Buffer.byteLength(providerPrompt, "utf8");
  // The selector's prompt includes longer dossier paths, so a path-free
  // rendering must fit inside the same exact conservative byte/token caps.
  if (usedBytes > selection.budget.maxPromptBytes || usedBytes > selection.budget.maxPromptTokens) {
    throw new Error("Fresh LED provider rule prompt exceeds the exact selector byte/token budget.");
  }
  if (containsAbsolutePath(providerPrompt)) throw new Error("Fresh LED provider rule prompt contains an absolute filesystem path.");

  const catalogIdentity = sha256(JSON.stringify(catalog));
  const selectionIdentity = sha256(JSON.stringify({
    catalogIdentity,
    profileId: FRESH_LED_DEEP_RULE_PROFILE_ID,
    contract: {
      schemaVersion: contract.schemaVersion,
      electrical: contract.electrical,
      components: contract.components.map(({ reference, symbolId }) => ({ reference, symbolId })),
      placement: contract.placement,
      routing: contract.routing,
    },
    features,
    parameters: FRESH_LED_DEEP_RULE_SELECTION_PARAMETERS,
    selector: selection.deepRuleSelection,
    rules: selection.rules,
    providerPrompt,
  }));
  const reportMetadata: FreshDeepRuleReportMetadata = {
    schemaVersion: "evleda.fresh-deep-rule-selection.v2",
    profileId: FRESH_LED_DEEP_RULE_PROFILE_ID,
    catalogIdentity,
    selectionIdentity,
    providerPromptSha256: sha256(providerPrompt),
    parameters: FRESH_LED_DEEP_RULE_SELECTION_PARAMETERS,
    disposition: "ready-for-prompt",
    activeFeatures: selection.activeFeatures,
    coveredFeatures: selection.coveredFeatures,
    selectedRuleIds: expectedIds,
    budget: selection.budget,
    providerPromptBudget: {
      usedBytes,
      usedTokens: usedBytes,
      tokenAccounting: "utf8-byte-upper-bound",
    },
    rules: selection.rules.map((rule) => ({
      id: rule.id,
      topic: rule.topic,
      severity: rule.severity,
      instructionExcerpt: compact(rule.instructionExcerpt),
      source: {
        topic: rule.topic,
        headingAnchor: rule.source.headingAnchor,
        dossierLineStart: rule.source.dossierLineStart,
        dossierLineEnd: rule.source.dossierLineEnd,
      },
    })),
  };
  const safeMetadata = JSON.stringify(reportMetadata);
  if (containsAbsolutePath(safeMetadata) || /dossierPath|articleUrl/iu.test(safeMetadata)) {
    throw new Error("Fresh LED deep-rule report metadata contains private source paths or URLs.");
  }
  return freeze({
    features,
    selection: selection as BoundedDeepRuleSelection & { readonly disposition: "ready-for-prompt" },
    providerPrompt,
    reportMetadata,
  });
}

export const FRESH_LED_DEEP_RULE_POLICY = createFreshLedDeepRulePolicy();
