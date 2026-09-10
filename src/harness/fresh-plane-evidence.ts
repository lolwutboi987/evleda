import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import { hardenPortableValue } from "../core/portable-artifact.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import { freshBoardSerializationsEqual } from "./fresh-board-serialization.js";
import { isValidatedFreshPlaneStageObservation, type FreshPlaneStageObservation } from "./fresh-plane-stage-observation.js";
import { isAuthenticatedPcbPlaneCompilationBundle, type PcbPlaneCompilationBundle } from "./pcb-design-plane-bundle.js";
import { freezePcbPlaneArtifact } from "./pcb-design-plane-contract.js";

const savedEvidence = new WeakSet<object>();
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
type IdentityRecord = Record<string, unknown>;
function identityRecord(value: unknown, fields: readonly string[], label: string): IdentityRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`Saved plane evidence has an invalid ${label}.`);
  const record = value as IdentityRecord;
  if (Object.keys(record).length !== fields.length || fields.some(field => !Object.hasOwn(record, field))) throw new Error(`Saved plane evidence has unsupported ${label} fields.`);
  if (record.algorithm !== "sha256" || typeof record.digest !== "string" || !/^[0-9a-f]{64}$/u.test(record.digest)) throw new Error(`Saved plane evidence has an invalid ${label} digest.`);
  return record;
}
function canonical(value: unknown, label: string): CanonicalIdentity {
  const record = identityRecord(value, ["algorithm", "digest", "schemaVersion", "canonicalizationVersion"], label);
  if (record.canonicalizationVersion !== "evleda-c14n-json-v1" || typeof record.schemaVersion !== "string" || record.schemaVersion.length === 0
      || record.schemaVersion.length > 256 || !record.schemaVersion.isWellFormed() || record.schemaVersion.includes("\0")) throw new Error(`Saved plane evidence has an invalid ${label} schema.`);
  return record as unknown as CanonicalIdentity;
}
function content(value: unknown, label: string): ContentIdentity {
  const record = identityRecord(value, ["algorithm", "digest", "size"], label);
  if (typeof record.size !== "number" || !Number.isSafeInteger(record.size) || record.size < 0) throw new Error(`Saved plane evidence has an invalid ${label} byte size.`);
  return record as unknown as ContentIdentity;
}
function snapshotIdentities<T>(value: T): T {
  // Snapshot only unbranded host identity data. Stage and bundle provenance must
  // retain their original in-process references; cloning them removes authority.
  return hardenPortableValue(value, { maxBytes: 8192, maxDepth: 4, maxNodes: 128, maxArrayLength: 8,
    maxOwnKeys: 8, maxKeyBytes: 128, maxStringBytes: 256 }) as T;
}
export interface SavedFreshPlaneEvidence {
  readonly schemaVersion: "evleda.saved-fresh-plane-evidence.v1";
  readonly bundleIdentity: CanonicalIdentity;
  readonly contractIdentity: CanonicalIdentity;
  readonly verificationPlanIdentity: CanonicalIdentity;
  readonly projectBindingIdentity: CanonicalIdentity;
  readonly sourceScopeIdentity: CanonicalIdentity;
  readonly savedPcbIdentity: ContentIdentity;
  readonly projectSettingsIdentity: ContentIdentity;
  readonly rulesIdentity: ContentIdentity;
  readonly stage: FreshPlaneStageObservation;
  readonly authority: "host-validated-stage-and-mandatory-save-current-session";
  readonly identity: CanonicalIdentity;
}

/** Issued by the owning harness only after mandatory native save/readback.
 * The owner must pin project/settings/rules/scope before staging, recheck those
 * same pins through save, and keep this object private to that editing session.
 * This pure function performs no native save or filesystem/session observation.
 * Serialized historical copies cannot reestablish a current native fill epoch.
 */
export function createSavedFreshPlaneEvidence(input: {
  compilationBundle: PcbPlaneCompilationBundle; stage: FreshPlaneStageObservation;
  projectBindingIdentity: CanonicalIdentity; sourceScopeIdentity: CanonicalIdentity;
  savedPcbSource: string; projectSettingsIdentity: ContentIdentity; rulesIdentity: ContentIdentity;
}): SavedFreshPlaneEvidence {
  const { compilationBundle: bundle, stage } = input;
  // Reject shape copies before reading their fields or performing comparisons.
  if (!isAuthenticatedPcbPlaneCompilationBundle(bundle) || !isValidatedFreshPlaneStageObservation(stage)) {
    throw new Error("Saved plane evidence requires the authenticated V2 stage and exact accepted saved source.");
  }
  const pins = snapshotIdentities({ projectBindingIdentity: input.projectBindingIdentity, sourceScopeIdentity: input.sourceScopeIdentity,
    projectSettingsIdentity: input.projectSettingsIdentity, rulesIdentity: input.rulesIdentity });
  const projectBindingIdentity = canonical(pins.projectBindingIdentity, "project binding identity"), sourceScopeIdentity = canonical(pins.sourceScopeIdentity, "source scope identity");
  const projectSettingsIdentity = content(pins.projectSettingsIdentity, "project settings identity"), rulesIdentity = content(pins.rulesIdentity, "rules identity");
  const savedPcbSource = input.savedPcbSource;
  const comparison = stage.comparison;
  if (comparison.binding !== "authenticated-v2-mutation-spec" || !comparison.valid
      || !("bundleIdentity" in comparison) || !("contractIdentity" in comparison) || !("rulesIdentity" in comparison)
      || !same(comparison.bundleIdentity, bundle.identity) || !same(comparison.contractIdentity, bundle.contract.identity)
      || !same(comparison.rulesIdentity, rulesIdentity) || !freshBoardSerializationsEqual(savedPcbSource, stage.nativeSourceStaged)) {
    throw new Error("Saved plane evidence requires the authenticated V2 stage and exact accepted saved source.");
  }
  const body = { schemaVersion: "evleda.saved-fresh-plane-evidence.v1" as const,
    bundleIdentity: bundle.identity, contractIdentity: bundle.contract.identity, verificationPlanIdentity: bundle.verificationPlan.identity,
    projectBindingIdentity, sourceScopeIdentity, savedPcbIdentity: contentIdentity(savedPcbSource), projectSettingsIdentity,
    rulesIdentity, stage, authority: "host-validated-stage-and-mandatory-save-current-session" as const };
  const result = freezePcbPlaneArtifact({ ...body, identity: canonicalIdentity(body, body.schemaVersion) });
  savedEvidence.add(result); return result;
}

export function isSavedFreshPlaneEvidence(value: unknown): value is SavedFreshPlaneEvidence {
  return value !== null && typeof value === "object" && savedEvidence.has(value);
}

export interface SavedFreshPlaneCurrentIdentities {
  bundleIdentity: CanonicalIdentity; projectBindingIdentity: CanonicalIdentity; sourceScopeIdentity: CanonicalIdentity;
  savedPcbIdentity: ContentIdentity; projectSettingsIdentity: ContentIdentity; rulesIdentity: ContentIdentity;
}
/** Owner still authenticates the current bundle and owns the same live session. */
export function assertSavedFreshPlaneEvidenceCurrent(evidence: SavedFreshPlaneEvidence, current: SavedFreshPlaneCurrentIdentities): void {
  if (!isSavedFreshPlaneEvidence(evidence)) throw new Error("A historical/serialized record is not current plane-fill authority.");
  const snapshot = snapshotIdentities(current);
  const fields = ["bundleIdentity", "projectBindingIdentity", "sourceScopeIdentity", "savedPcbIdentity", "projectSettingsIdentity", "rulesIdentity"] as const;
  if (Object.keys(snapshot).length !== fields.length || fields.some(field => !Object.hasOwn(snapshot, field))) throw new Error("Current saved plane evidence requires every exact identity field.");
  for (const key of ["bundleIdentity", "projectBindingIdentity", "sourceScopeIdentity"] as const) canonical(snapshot[key], key);
  for (const key of ["savedPcbIdentity", "projectSettingsIdentity", "rulesIdentity"] as const) content(snapshot[key], key);
  for (const key of fields) {
    if (!same(evidence[key], snapshot[key])) throw new Error(`Saved plane evidence is stale: ${key}. Reapply the contract plane before acceptance.`);
  }
}
