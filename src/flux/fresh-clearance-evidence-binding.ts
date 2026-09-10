import { canonicalIdentity, canonicalJson } from "../core/canonical.js";
import { hardenPortableValue, validateCanonicalIdentity } from "../core/portable-artifact.js";
import type { CanonicalIdentity } from "../domain/types.js";
import type { FreshClearanceKicadIdentity } from "../harness/fresh-clearance-evidence.js";

export const FLUX_FRESH_CLEARANCE_EVIDENCE_BINDING_LEGACY_SCHEMA_VERSION = "evleda.flux-fresh-clearance-evidence-binding.v1" as const;
export const FLUX_FRESH_CLEARANCE_EVIDENCE_BINDING_SCHEMA_VERSION = "evleda.flux-fresh-clearance-evidence-binding.v2" as const;
const MATERIALIZATION_SCHEMA_VERSION = "evleda.fresh-netclass-materialization.v1";
const RECEIPT_SCHEMA_VERSION = "evleda.fresh-clearance-evidence-receipt.v1";
const SEMANTIC_AUTHORITY_SCHEMA_VERSION = "evleda.fresh-netclass-semantic-authority.v1";
const HEX_64 = /^[0-9a-f]{64}$/u;
const KICAD_COMMIT = /^[0-9a-f]{7,64}$/iu;
const KICAD_VERSION = /^10\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const CAPABILITY = /^[A-Za-z0-9][A-Za-z0-9_.:+ -]{0,255}$/u;
const SECRET_VALUE = /(?:\b(?:bearer|basic)\s+|-----BEGIN|\bsk-(?:proj-)?|\b(?:password|authorization|cookie|api[_ -]?(?:key|token)|secret)\s*[:=])/iu;

export interface FluxFreshClearanceEvidenceBindingV1 {
  readonly schemaVersion: typeof FLUX_FRESH_CLEARANCE_EVIDENCE_BINDING_LEGACY_SCHEMA_VERSION;
  readonly kicad: FreshClearanceKicadIdentity;
  readonly materializationIdentity: CanonicalIdentity;
  readonly receiptIdentity: CanonicalIdentity;
  readonly identity: CanonicalIdentity;
}
export interface FluxFreshClearanceEvidenceBinding extends Omit<FluxFreshClearanceEvidenceBindingV1, "schemaVersion" | "identity"> {
  readonly schemaVersion: typeof FLUX_FRESH_CLEARANCE_EVIDENCE_BINDING_SCHEMA_VERSION;
  readonly semanticAuthorityIdentity: CanonicalIdentity;
  readonly identity: CanonicalIdentity;
}

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
};
const exact = (value: Record<string, unknown>, keys: readonly string[], label: string): void => {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) throw new Error(`${label} has missing or unknown fields`);
};
const parseKicad = (value: unknown): FreshClearanceKicadIdentity => {
  const kicad = record(value, "Fresh clearance KiCad identity");
  exact(kicad, ["kind", "version", "commit", "sha256", "sizeBytes", "capabilityHelpSha256", "confirmedCapabilities"], "Fresh clearance KiCad identity");
  if (kicad.kind !== "kicad-cli" || typeof kicad.version !== "string" || !KICAD_VERSION.test(kicad.version) || typeof kicad.commit !== "string" || !KICAD_COMMIT.test(kicad.commit) ||
    typeof kicad.sha256 !== "string" || !HEX_64.test(kicad.sha256) || typeof kicad.capabilityHelpSha256 !== "string" || !HEX_64.test(kicad.capabilityHelpSha256) ||
    !Number.isSafeInteger(kicad.sizeBytes) || (kicad.sizeBytes as number) <= 0 || !Array.isArray(kicad.confirmedCapabilities) || kicad.confirmedCapabilities.length > 256 ||
    kicad.confirmedCapabilities.some((item) => typeof item !== "string" || !CAPABILITY.test(item) || SECRET_VALUE.test(item)) || new Set(kicad.confirmedCapabilities).size !== kicad.confirmedCapabilities.length) {
    throw new Error("Fresh clearance KiCad identity is invalid");
  }
  return Object.freeze({ kind: "kicad-cli", version: kicad.version, commit: kicad.commit, sha256: kicad.sha256, sizeBytes: kicad.sizeBytes as number,
    capabilityHelpSha256: kicad.capabilityHelpSha256, confirmedCapabilities: Object.freeze([...(kicad.confirmedCapabilities as string[])]) });
};

const parseFluxFreshClearanceEvidenceBindingSnapshot = (value: unknown, legacyChildren = false): FluxFreshClearanceEvidenceBinding => {
  const safe = record(hardenPortableValue(value, { maxBytes: 128 * 1024, maxDepth: 5, maxNodes: 1_024, maxArrayLength: 256, maxOwnKeys: 16, maxKeyBytes: 64, maxStringBytes: 4_096 }), "Fresh clearance evidence binding");
  exact(safe, ["schemaVersion", "kicad", "materializationIdentity", "receiptIdentity", "semanticAuthorityIdentity", "identity"], "Fresh clearance evidence binding");
  if (safe.schemaVersion !== FLUX_FRESH_CLEARANCE_EVIDENCE_BINDING_SCHEMA_VERSION) throw new Error("Fresh clearance evidence binding schema is invalid");
  const materializationIdentity = validateCanonicalIdentity(safe.materializationIdentity, "materializationIdentity"); const receiptIdentity = validateCanonicalIdentity(safe.receiptIdentity, "receiptIdentity"); const semanticAuthorityIdentity = validateCanonicalIdentity(safe.semanticAuthorityIdentity, "semanticAuthorityIdentity");
  if (materializationIdentity.schemaVersion !== (legacyChildren ? MATERIALIZATION_SCHEMA_VERSION : "evleda.fresh-netclass-materialization.v2") || receiptIdentity.schemaVersion !== (legacyChildren ? RECEIPT_SCHEMA_VERSION : "evleda.fresh-clearance-evidence-receipt.v2") || semanticAuthorityIdentity.schemaVersion !== (legacyChildren ? SEMANTIC_AUTHORITY_SCHEMA_VERSION : "evleda.fresh-netclass-semantic-authority.v2")) throw new Error("Fresh clearance evidence child identity schema is invalid");
  const payload = { schemaVersion: FLUX_FRESH_CLEARANCE_EVIDENCE_BINDING_SCHEMA_VERSION, kicad: parseKicad(safe.kicad), materializationIdentity, receiptIdentity, semanticAuthorityIdentity };
  const identity = validateCanonicalIdentity(safe.identity, "freshClearanceEvidenceBindingIdentity");
  if (canonicalJson(identity) !== canonicalJson(canonicalIdentity(payload, FLUX_FRESH_CLEARANCE_EVIDENCE_BINDING_SCHEMA_VERSION))) throw new Error("Fresh clearance evidence binding identity is invalid");
  return Object.freeze({ ...payload, identity });
};

export const parseFluxFreshClearanceEvidenceBinding = (value: unknown): FluxFreshClearanceEvidenceBinding => parseFluxFreshClearanceEvidenceBindingSnapshot(value);

const parseFluxFreshClearanceEvidenceBindingV1 = (value: unknown): FluxFreshClearanceEvidenceBindingV1 => {
  const safe = record(hardenPortableValue(value, { maxBytes: 128 * 1024, maxDepth: 5, maxNodes: 1_024, maxArrayLength: 256, maxOwnKeys: 16, maxKeyBytes: 64, maxStringBytes: 4_096 }), "Legacy fresh clearance evidence binding");
  exact(safe, ["schemaVersion", "kicad", "materializationIdentity", "receiptIdentity", "identity"], "Legacy fresh clearance evidence binding");
  if (safe.schemaVersion !== FLUX_FRESH_CLEARANCE_EVIDENCE_BINDING_LEGACY_SCHEMA_VERSION) throw new Error("Legacy fresh clearance evidence binding schema is invalid");
  const materializationIdentity = validateCanonicalIdentity(safe.materializationIdentity, "materializationIdentity"); const receiptIdentity = validateCanonicalIdentity(safe.receiptIdentity, "receiptIdentity");
  if (materializationIdentity.schemaVersion !== MATERIALIZATION_SCHEMA_VERSION || receiptIdentity.schemaVersion !== RECEIPT_SCHEMA_VERSION) throw new Error("Legacy fresh clearance evidence child identity schema is invalid");
  const payload = { schemaVersion: FLUX_FRESH_CLEARANCE_EVIDENCE_BINDING_LEGACY_SCHEMA_VERSION, kicad: parseKicad(safe.kicad), materializationIdentity, receiptIdentity };
  const identity = validateCanonicalIdentity(safe.identity, "legacyFreshClearanceEvidenceBindingIdentity");
  if (canonicalJson(identity) !== canonicalJson(canonicalIdentity(payload, FLUX_FRESH_CLEARANCE_EVIDENCE_BINDING_LEGACY_SCHEMA_VERSION))) throw new Error("Legacy fresh clearance evidence binding identity is invalid");
  return Object.freeze({ ...payload, identity });
};

export const parseFluxPersistedFreshClearanceEvidenceBinding = (value: unknown): FluxFreshClearanceEvidenceBinding | FluxFreshClearanceEvidenceBindingV1 => {
  const safe = record(hardenPortableValue(value, { maxBytes: 128 * 1024, maxDepth: 5, maxNodes: 1_024, maxArrayLength: 256, maxOwnKeys: 16, maxKeyBytes: 64, maxStringBytes: 4_096 }), "Persisted fresh clearance evidence binding");
  return safe.schemaVersion === FLUX_FRESH_CLEARANCE_EVIDENCE_BINDING_LEGACY_SCHEMA_VERSION ? parseFluxFreshClearanceEvidenceBindingV1(safe) : parseFluxFreshClearanceEvidenceBindingSnapshot(safe, record(safe.materializationIdentity, "materializationIdentity").schemaVersion === MATERIALIZATION_SCHEMA_VERSION);
};

export const createFluxFreshClearanceEvidenceBinding = (payload: Omit<FluxFreshClearanceEvidenceBinding, "schemaVersion" | "identity">): FluxFreshClearanceEvidenceBinding => {
  const value = { schemaVersion: FLUX_FRESH_CLEARANCE_EVIDENCE_BINDING_SCHEMA_VERSION, ...payload };
  return parseFluxFreshClearanceEvidenceBinding({ ...value, identity: canonicalIdentity(value, FLUX_FRESH_CLEARANCE_EVIDENCE_BINDING_SCHEMA_VERSION) });
};
