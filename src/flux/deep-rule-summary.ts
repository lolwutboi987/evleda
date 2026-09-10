import { canonicalIdentity, canonicalJson } from "../core/canonical.js";
import { hardenPortableValue, validateCanonicalIdentity } from "../core/portable-artifact.js";
import type { CanonicalIdentity } from "../domain/types.js";
import type { PcbDeepRuleBinding } from "../harness/pcb-design-compiler.js";
import type { DeepRuleDesignFeatureName } from "../harness/deep-rule-selector.js";

export const FLUX_DEEP_RULE_SUMMARY_SCHEMA_VERSION = "evleda.flux-deep-rule-summary.v1" as const;
export const FLUX_DEEP_RULE_SUMMARY_MAX_SELECTED = 24;
export const FLUX_DEEP_RULE_FEATURE_NAMES = Object.freeze([
  "powerCurrent", "signalSpeedInterfaces", "differentialPairs", "stackupImpedance", "thermal", "emi", "placement", "dfm", "assembly", "bga", "gpio",
] as const satisfies readonly DeepRuleDesignFeatureName[]);

export interface FluxDeepRuleSummaryDto {
  readonly schemaVersion: typeof FLUX_DEEP_RULE_SUMMARY_SCHEMA_VERSION;
  readonly deepRuleBindingIdentity: CanonicalIdentity;
  readonly catalogIdentity: CanonicalIdentity;
  readonly selectedCount: number;
  readonly selectedRuleIds: readonly string[];
  readonly coveredFeatures: readonly DeepRuleDesignFeatureName[];
  readonly uncoveredFeatures: readonly DeepRuleDesignFeatureName[];
  readonly identity: CanonicalIdentity;
}

const featureNames = new Set<string>(FLUX_DEEP_RULE_FEATURE_NAMES);
const sortedUnique = (values: readonly string[]): readonly string[] => Object.freeze([...new Set(values)].sort((left, right) => left.localeCompare(right, "en-US")));

export const parseFluxDeepRuleSummary = (value: unknown): FluxDeepRuleSummaryDto => {
  const safe = hardenPortableValue(value, { maxBytes: 16 * 1024, maxDepth: 5, maxNodes: 256, maxArrayLength: FLUX_DEEP_RULE_SUMMARY_MAX_SELECTED, maxOwnKeys: 16, maxKeyBytes: 64, maxStringBytes: 160 });
  if (typeof safe !== "object" || safe === null || Array.isArray(safe)) throw new Error("Flux deep-rule summary is malformed");
  const record = safe as Record<string, unknown>; const keys = ["schemaVersion", "deepRuleBindingIdentity", "catalogIdentity", "selectedCount", "selectedRuleIds", "coveredFeatures", "uncoveredFeatures", "identity"];
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key)) || record.schemaVersion !== FLUX_DEEP_RULE_SUMMARY_SCHEMA_VERSION ||
    !Number.isSafeInteger(record.selectedCount) || (record.selectedCount as number) < 0 || (record.selectedCount as number) > FLUX_DEEP_RULE_SUMMARY_MAX_SELECTED ||
    !Array.isArray(record.selectedRuleIds) || !Array.isArray(record.coveredFeatures) || !Array.isArray(record.uncoveredFeatures)) throw new Error("Flux deep-rule summary is malformed");
  const selectedRuleIds = record.selectedRuleIds as unknown[]; const covered = record.coveredFeatures as unknown[]; const uncovered = record.uncoveredFeatures as unknown[];
  if (selectedRuleIds.some((id) => typeof id !== "string" || !/^PCB\d{2}-R\d{3}$/u.test(id)) || selectedRuleIds.length !== record.selectedCount ||
    selectedRuleIds.join("\0") !== sortedUnique(selectedRuleIds as string[]).join("\0") || covered.some((feature) => typeof feature !== "string" || !featureNames.has(feature)) ||
    uncovered.some((feature) => typeof feature !== "string" || !featureNames.has(feature)) || covered.join("\0") !== sortedUnique(covered as string[]).join("\0") ||
    uncovered.join("\0") !== sortedUnique(uncovered as string[]).join("\0") || covered.some((feature) => uncovered.includes(feature))) throw new Error("Flux deep-rule summary arrays are invalid");
  const deepRuleBindingIdentity = validateCanonicalIdentity(record.deepRuleBindingIdentity, "deepRuleBindingIdentity");
  const catalogIdentity = validateCanonicalIdentity(record.catalogIdentity, "catalogIdentity");
  const identity = validateCanonicalIdentity(record.identity, "identity");
  const payload = { schemaVersion: FLUX_DEEP_RULE_SUMMARY_SCHEMA_VERSION, deepRuleBindingIdentity, catalogIdentity, selectedCount: record.selectedCount as number,
    selectedRuleIds: Object.freeze([...(selectedRuleIds as string[])]), coveredFeatures: Object.freeze([...(covered as DeepRuleDesignFeatureName[])]), uncoveredFeatures: Object.freeze([...(uncovered as DeepRuleDesignFeatureName[])]) };
  if (canonicalJson(identity) !== canonicalJson(canonicalIdentity(payload, FLUX_DEEP_RULE_SUMMARY_SCHEMA_VERSION))) throw new Error("Flux deep-rule summary identity is invalid");
  return Object.freeze({ ...payload, identity });
};

export const createFluxDeepRuleSummary = (binding: PcbDeepRuleBinding): FluxDeepRuleSummaryDto => {
  const payload = { schemaVersion: FLUX_DEEP_RULE_SUMMARY_SCHEMA_VERSION, deepRuleBindingIdentity: binding.identity, catalogIdentity: binding.catalogIdentity,
    selectedCount: binding.selection.rules.length, selectedRuleIds: sortedUnique(binding.selection.rules.map((rule) => rule.id)),
    coveredFeatures: sortedUnique(binding.selection.coveredFeatures) as readonly DeepRuleDesignFeatureName[], uncoveredFeatures: sortedUnique(binding.selection.uncoveredFeatures) as readonly DeepRuleDesignFeatureName[] };
  return parseFluxDeepRuleSummary({ ...payload, identity: canonicalIdentity(payload, FLUX_DEEP_RULE_SUMMARY_SCHEMA_VERSION) });
};

export const assertFluxDeepRuleSummaryBinding = (summary: FluxDeepRuleSummaryDto, binding: PcbDeepRuleBinding): void => {
  if (canonicalJson(parseFluxDeepRuleSummary(summary)) !== canonicalJson(createFluxDeepRuleSummary(binding))) throw new Error("Flux deep-rule summary does not match the verified bundle binding");
};
