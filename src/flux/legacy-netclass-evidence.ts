import { canonicalIdentity, canonicalJson } from "../core/canonical.js";
import { hardenPortableValue, validateCanonicalIdentity } from "../core/portable-artifact.js";
import type { FreshClearanceEvidenceReceipt, FreshNetClassPreparationEvidence, FreshNetClassSemanticAuthority } from "../harness/fresh-clearance-evidence.js";
import { parseFreshClearanceEvidenceReceipt, parseFreshNetClassPreparationEvidence, parseFreshNetClassSemanticAuthority } from "../harness/fresh-clearance-evidence.js";

const PREPARATION_V1 = "evleda.fresh-netclass-preparation-evidence.v1" as const;
const SEMANTIC_V1 = "evleda.fresh-netclass-semantic-authority.v1" as const;
const RECEIPT_V1 = "evleda.fresh-clearance-evidence-receipt.v1" as const;
const HISTORICAL_RESOLUTION = Object.freeze({ boardMinimum: "absolute-floor", netClassConflict: "larger-clearance", customRules: "absent-or-empty-only", localPadOrFootprintOverrides: "rejected", zones: "rejected" } as const);
export type FluxLegacyNetClassPreparationEvidence = Omit<FreshNetClassPreparationEvidence, "schemaVersion"> & Readonly<{ schemaVersion: typeof PREPARATION_V1 }>;
export type FluxLegacyNetClassSemanticAuthority = Omit<FreshNetClassSemanticAuthority, "schemaVersion" | "ruleResolution"> & Readonly<{ schemaVersion: typeof SEMANTIC_V1; ruleResolution: typeof HISTORICAL_RESOLUTION & Readonly<{ netClassPatterns: "rejected"; contractNetAssignments: "exclusive" }> }>;
export type FluxLegacyClearanceEvidenceReceipt = Omit<FreshClearanceEvidenceReceipt, "schemaVersion" | "ruleResolution"> & Readonly<{ schemaVersion: typeof RECEIPT_V1; ruleResolution: typeof HISTORICAL_RESOLUTION }>;

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Historical net-class evidence must be an object");
  return value as Record<string, unknown>;
};
const exact = (value: Record<string, unknown>, fields: readonly string[]): void => {
  if (Object.keys(value).length !== fields.length || fields.some((key) => !Object.hasOwn(value, key))) throw new Error("Historical net-class evidence has missing or unknown fields");
};
const content = (value: unknown): void => {
  const identity = record(value); exact(identity, ["algorithm", "digest", "size"]);
  if (identity.algorithm !== "sha256" || typeof identity.digest !== "string" || !/^[0-9a-f]{64}$/u.test(identity.digest) || !Number.isSafeInteger(identity.size) || (identity.size as number) < 1) throw new Error("Historical content identity is invalid");
};
const identity = (value: unknown, schema: string): void => {
  if (validateCanonicalIdentity(value).schemaVersion !== schema) throw new Error("Historical evidence child schema is invalid");
};
const boundedNumber = (value: unknown): void => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) throw new Error("Historical clearance dimension is invalid");
};
const named = (value: unknown): string => {
  if (typeof value !== "string" || !/^[A-Za-z0-9+_-][A-Za-z0-9_.+-]{0,127}$/u.test(value)) throw new Error("Historical net-class name is invalid");
  return value;
};
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value) || value.length > 20_000) throw new Error("Historical evidence inventory is invalid");
  return value;
};
const COMMON = ["schemaVersion", "classification", "origin", "fabricationAuthorized", "qualificationEstablished", "releaseAuthorized", "bundleIdentity", "contractIdentity", "genericProjectBindingIdentity", "freshMarkerContentIdentity", "kicad", "identity"];
/** Archive validation checks original bytes/identities, never manufactures current execution authority. */
const historical = (value: unknown, schema: string, extra: readonly string[]): Record<string, unknown> => {
  const safe = record(hardenPortableValue(value, { maxBytes: 8 * 1024 * 1024, maxDepth: 64, maxNodes: 100_000, maxArrayLength: 20_000, maxOwnKeys: 1_024, maxKeyBytes: 512, maxStringBytes: 512 * 1024 }));
  exact(safe, [...COMMON, ...extra]);
  if (safe.schemaVersion !== schema || safe.classification !== "candidate-validation" || safe.origin !== "host" || safe.fabricationAuthorized !== false || safe.qualificationEstablished !== false || safe.releaseAuthorized !== false) throw new Error("Historical evidence boundary is invalid");
  identity(safe.bundleIdentity, "evleda.pcb-design-compilation-bundle.v1"); identity(safe.contractIdentity, "evleda.pcb-design-contract.v1"); identity(safe.genericProjectBindingIdentity, "evleda.pcb-agent-generic-fresh-binding.v1"); content(safe.freshMarkerContentIdentity);
  const kicad = record(safe.kicad); exact(kicad, ["kind", "version", "commit", "sha256", "sizeBytes", "capabilityHelpSha256", "confirmedCapabilities"]);
  if (kicad.kind !== "kicad-cli" || typeof kicad.version !== "string" || !/^10\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(kicad.version) || typeof kicad.commit !== "string" || !/^[0-9a-f]{7,64}$/iu.test(kicad.commit) || !/^[0-9a-f]{64}$/u.test(String(kicad.sha256)) || !/^[0-9a-f]{64}$/u.test(String(kicad.capabilityHelpSha256)) || !Number.isSafeInteger(kicad.sizeBytes) || (kicad.sizeBytes as number) <= 0 || array(kicad.confirmedCapabilities).some((entry) => typeof entry !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:+ -]{0,255}$/u.test(entry))) throw new Error("Historical KiCad identity is invalid");
  const { identity: claimed, ...payload } = safe;
  if (canonicalJson(validateCanonicalIdentity(claimed)) !== canonicalJson(canonicalIdentity(payload, schema))) throw new Error("Historical evidence identity does not match its original payload");
  return safe;
};

export const isFluxLegacyNetClassEvidence = (value: unknown): boolean => typeof value === "object" && value !== null && [PREPARATION_V1, SEMANTIC_V1, RECEIPT_V1].includes((value as { schemaVersion: never }).schemaVersion);

export const parseFluxPersistedNetClassPreparationEvidence = (value: unknown): FreshNetClassPreparationEvidence | FluxLegacyNetClassPreparationEvidence => {
  if (!isFluxLegacyNetClassEvidence(value)) return parseFreshNetClassPreparationEvidence(value);
  const safe = historical(value, PREPARATION_V1, ["materializationIdentity", "semanticAuthorityIdentity"]);
  identity(safe.materializationIdentity, "evleda.fresh-netclass-materialization.v1"); identity(safe.semanticAuthorityIdentity, SEMANTIC_V1);
  return safe as unknown as FluxLegacyNetClassPreparationEvidence;
};

export const parseFluxPersistedNetClassSemanticAuthority = (value: unknown): FreshNetClassSemanticAuthority | FluxLegacyNetClassSemanticAuthority => {
  if (!isFluxLegacyNetClassEvidence(value)) return parseFreshNetClassSemanticAuthority(value);
  const safe = historical(value, SEMANTIC_V1, ["ruleResolution", "boardMinimumClearanceMm", "netClasses", "contractNetAssignments"]);
  if (canonicalJson(safe.ruleResolution) !== canonicalJson({ ...HISTORICAL_RESOLUTION, netClassPatterns: "rejected", contractNetAssignments: "exclusive" })) throw new Error("Historical semantic rule resolution is invalid");
  boundedNumber(safe.boardMinimumClearanceMm);
  const classes = new Set<string>();
  for (const entry of array(safe.netClasses)) {
    const cls = record(entry); exact(cls, ["bus_width", "clearance", "diff_pair_gap", "diff_pair_via_gap", "diff_pair_width", "line_style", "microvia_diameter", "microvia_drill", "name", "pcb_color", "priority", "schematic_color", "track_width", "tuning_profile", "via_diameter", "via_drill", "wire_width"]);
    const name = named(cls.name); if (classes.has(name)) throw new Error("Historical semantic classes are duplicated"); classes.add(name);
    for (const [key, child] of Object.entries(cls)) {
      if (["name", "pcb_color", "schematic_color", "tuning_profile"].includes(key)) { if (typeof child !== "string" || child.length > 256) throw new Error("Historical semantic class text is invalid"); }
      else if (typeof child !== "number" || !Number.isFinite(child)) throw new Error("Historical semantic class dimension is invalid");
    }
  }
  const nets = new Set<string>();
  for (const entry of array(safe.contractNetAssignments)) {
    const assignment = record(entry); exact(assignment, ["netName", "contractNetClassId", "kicadNetClassName"]);
    const netName = named(assignment.netName); named(assignment.contractNetClassId);
    if (!classes.has(named(assignment.kicadNetClassName)) || nets.has(netName)) throw new Error("Historical semantic assignment is invalid"); nets.add(netName);
  }
  if (classes.size === 0 || nets.size === 0) throw new Error("Historical semantic inventory is empty");
  return safe as unknown as FluxLegacyNetClassSemanticAuthority;
};

export const parseFluxPersistedClearanceEvidenceReceipt = (value: unknown): FreshClearanceEvidenceReceipt | FluxLegacyClearanceEvidenceReceipt => {
  if (!isFluxLegacyNetClassEvidence(value)) return parseFreshClearanceEvidenceReceipt(value);
  const safe = historical(value, RECEIPT_V1, ["sourceIdentities", "ruleResolution", "boardMinimumClearanceMm", "netClasses", "nets", "pairs", "acceptanceEvidence", "evidenceLimitations"]);
  if (canonicalJson(safe.ruleResolution) !== canonicalJson(HISTORICAL_RESOLUTION)) throw new Error("Historical clearance rule resolution is invalid");
  boundedNumber(safe.boardMinimumClearanceMm);
  const sources = record(safe.sourceIdentities); exact(sources, ["projectSettings", "customRules", "pcb", "ruleSourceSet"]);
  content(sources.projectSettings); content(sources.pcb); if (sources.customRules !== null) content(sources.customRules);
  identity(sources.ruleSourceSet, "evleda.fresh-clearance-rule-source-set.v1");
  for (const entry of array(safe.netClasses)) {
    const cls = record(entry); exact(cls, ["contractNetClassId", "kicadNetClassName", "traceWidthMm", "configuredClearanceMm", "netNames"]);
    named(cls.contractNetClassId); named(cls.kicadNetClassName); boundedNumber(cls.traceWidthMm); boundedNumber(cls.configuredClearanceMm); array(cls.netNames).forEach(named);
  }
  for (const entry of array(safe.nets)) {
    const net = record(entry); exact(net, ["name", "contractNetClassId", "kicadNetClassName", "configuredClearanceMm", "effectiveClearanceMm"]);
    named(net.name); named(net.contractNetClassId); named(net.kicadNetClassName); boundedNumber(net.configuredClearanceMm); boundedNumber(net.effectiveClearanceMm);
  }
  for (const entry of array(safe.pairs)) {
    const pair = record(entry); exact(pair, ["leftNet", "rightNet", "effectiveClearanceMm", "limitingSources"]);
    named(pair.leftNet); named(pair.rightNet); boundedNumber(pair.effectiveClearanceMm);
    if (array(pair.limitingSources).some((item) => typeof item !== "string" || item.length > 512)) throw new Error("Historical clearance limiting source is invalid");
  }
  const acceptance = record(safe.acceptanceEvidence);
  exact(acceptance, ["origin", "schemaVersion", "source", "pcbSha256", "rulesSourceSha256", "netClasses"]);
  if (acceptance.origin !== "host" || acceptance.schemaVersion !== "evleda.fresh-design-clearance-evidence.v1" || acceptance.source !== "kicad-effective-netclass-rules" || acceptance.pcbSha256 !== record(sources.pcb).digest || acceptance.rulesSourceSha256 !== record(sources.ruleSourceSet).digest) throw new Error("Historical clearance acceptance projection is invalid");
  for (const entry of array(acceptance.netClasses)) { const cls = record(entry); exact(cls, ["id", "configuredClearanceMm", "effectiveClearanceMm"]); named(cls.id); boundedNumber(cls.configuredClearanceMm); boundedNumber(cls.effectiveClearanceMm); }
  const { ruleSourceSet, ...sourcePayload } = sources;
  if (canonicalJson(ruleSourceSet) !== canonicalJson(canonicalIdentity({ schemaVersion: "evleda.fresh-clearance-rule-source-set.v1", ...sourcePayload, kicad: safe.kicad, resolution: safe.ruleResolution }, "evleda.fresh-clearance-rule-source-set.v1"))) throw new Error("Historical rule source set identity is invalid");
  if (array(safe.evidenceLimitations).some((item) => typeof item !== "string" || item.length > 65_536)) throw new Error("Historical clearance limitations are invalid");
  return safe as unknown as FluxLegacyClearanceEvidenceReceipt;
};
