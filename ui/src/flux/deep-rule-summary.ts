import type { FluxCanonicalIdentityDto, FluxDeepRuleFeatureName, FluxDeepRuleSummaryDto } from "./model";

const SUMMARY_SCHEMA = "evleda.flux-deep-rule-summary.v1" as const;
const BINDING_SCHEMA = "evleda.pcb-deep-rule-binding.v1";
const CATALOG_SCHEMA = "evleda.deep-rule-catalog.v1";
const FEATURES = new Set<FluxDeepRuleFeatureName>(["powerCurrent", "signalSpeedInterfaces", "differentialPairs", "stackupImpedance", "thermal", "emi", "placement", "dfm", "assembly", "bga", "gpio"]);
const exactKeys = (value: object, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const record = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : undefined; }
  catch { return undefined; }
};
const identity = (value: unknown, schemaVersion: string): FluxCanonicalIdentityDto | undefined => {
  const item = record(value);
  return item !== undefined && exactKeys(item, ["algorithm", "digest", "schemaVersion", "canonicalizationVersion"]) && item.algorithm === "sha256" && typeof item.digest === "string" && /^[0-9a-f]{64}$/u.test(item.digest) && item.schemaVersion === schemaVersion && item.canonicalizationVersion === "evleda-c14n-json-v1"
    ? item as unknown as FluxCanonicalIdentityDto : undefined;
};
const sameIdentity = (left: FluxCanonicalIdentityDto, right: FluxCanonicalIdentityDto): boolean => left.algorithm === right.algorithm && left.digest === right.digest && left.schemaVersion === right.schemaVersion && left.canonicalizationVersion === right.canonicalizationVersion;
const sortedUnique = (values: readonly string[]): boolean => values.every((value, index) => index === 0 || values[index - 1]!.localeCompare(value, "en-US") < 0);

export const parseFluxDeepRuleSummary = (value: unknown, contractBinding: FluxCanonicalIdentityDto | null | undefined): FluxDeepRuleSummaryDto | undefined => {
  try {
    const item = record(value);
    if (item === undefined || !exactKeys(item, ["schemaVersion", "deepRuleBindingIdentity", "catalogIdentity", "selectedCount", "selectedRuleIds", "coveredFeatures", "uncoveredFeatures", "identity"]) || item.schemaVersion !== SUMMARY_SCHEMA) return undefined;
    const deepRuleBindingIdentity = identity(item.deepRuleBindingIdentity, BINDING_SCHEMA);
    const catalogIdentity = identity(item.catalogIdentity, CATALOG_SCHEMA);
    const summaryIdentity = identity(item.identity, SUMMARY_SCHEMA);
    if (deepRuleBindingIdentity === undefined || catalogIdentity === undefined || summaryIdentity === undefined || contractBinding === null || contractBinding === undefined || !sameIdentity(deepRuleBindingIdentity, contractBinding)) return undefined;
    if (!Number.isSafeInteger(item.selectedCount) || (item.selectedCount as number) < 0 || (item.selectedCount as number) > 24 || !Array.isArray(item.selectedRuleIds) || !Array.isArray(item.coveredFeatures) || !Array.isArray(item.uncoveredFeatures)) return undefined;
    const ids = item.selectedRuleIds;
    const covered = item.coveredFeatures;
    const uncovered = item.uncoveredFeatures;
    if (ids.length !== item.selectedCount || ids.length > 24 || ids.some((entry) => typeof entry !== "string" || !/^PCB\d{2}-R\d{3}$/u.test(entry)) || !sortedUnique(ids as string[])) return undefined;
    if (covered.length > FEATURES.size || uncovered.length > FEATURES.size || covered.some((entry) => typeof entry !== "string" || !FEATURES.has(entry as FluxDeepRuleFeatureName)) || uncovered.some((entry) => typeof entry !== "string" || !FEATURES.has(entry as FluxDeepRuleFeatureName)) || !sortedUnique(covered as string[]) || !sortedUnique(uncovered as string[]) || covered.some((entry) => uncovered.includes(entry))) return undefined;
    return {
      schemaVersion: SUMMARY_SCHEMA,
      deepRuleBindingIdentity,
      catalogIdentity,
      selectedCount: item.selectedCount as number,
      selectedRuleIds: [...ids] as string[],
      coveredFeatures: [...covered] as FluxDeepRuleFeatureName[],
      uncoveredFeatures: [...uncovered] as FluxDeepRuleFeatureName[],
      identity: summaryIdentity,
    };
  } catch { return undefined; }
};

const canonical = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite canonical value");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const item = record(value); if (item === undefined) throw new Error("non-plain canonical value");
  return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`).join(",")}}`;
};

export const verifyFluxDeepRuleSummary = async (value: unknown, contractBinding: FluxCanonicalIdentityDto | null | undefined): Promise<boolean> => {
  try {
    const summary = parseFluxDeepRuleSummary(value, contractBinding); if (summary === undefined || globalThis.crypto?.subtle === undefined) return false;
    const { identity: summaryIdentity, ...payload } = summary;
    const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(payload)));
    const digest = [...new Uint8Array(bytes)].map((entry) => entry.toString(16).padStart(2, "0")).join("");
    return summaryIdentity.digest === digest;
  } catch { return false; }
};
