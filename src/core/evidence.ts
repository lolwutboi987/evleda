import { canonicalIdentity } from "./canonical.js";
import type { CanonicalIdentity, EvidenceRecord } from "../domain/types.js";

const uniqueSorted = (values: readonly string[]): readonly string[] =>
  [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));

export const evidenceRecordProjection = (
  entry: EvidenceRecord
): Readonly<Record<string, unknown>> => ({
  id: entry.id,
  projectId: entry.projectId,
  runId: entry.runId,
  designRevisionId: entry.designRevisionId,
  stage: entry.stage,
  evidenceClass: entry.evidenceClass,
  claim: entry.claim,
  subjectDigests: uniqueSorted(entry.subjectDigests),
  rawArtifactId: entry.rawArtifactId ?? null,
  parsedArtifactId: entry.parsedArtifactId ?? null,
  exactInputs: entry.exactInputs,
  tool: entry.tool,
  validationStatus: entry.validationStatus,
  unresolvedAssumptions: entry.unresolvedAssumptions,
  lifecycle: entry.lifecycle,
  createdAt: entry.createdAt,
  validUntil: entry.validUntil ?? null,
  staleAt: entry.staleAt ?? null
});

export const evidenceRoot = (evidence: readonly EvidenceRecord[]): CanonicalIdentity =>
  canonicalIdentity(
    [...evidence]
      .sort((left, right) => left.id.localeCompare(right.id, "en"))
      .map(evidenceRecordProjection),
    "evleda.evidence-root.v1"
  );

export const evidenceIsCurrent = (entry: EvidenceRecord, now: Date): boolean => {
  if (entry.staleAt !== undefined) {
    return false;
  }
  if (entry.validUntil === undefined) {
    return true;
  }
  const validUntil = Date.parse(entry.validUntil);
  return Number.isFinite(validUntil) && validUntil > now.getTime();
};

export const evidenceSetIsCurrent = (
  evidence: readonly EvidenceRecord[],
  now: Date
): boolean => evidence.every((entry) => evidenceIsCurrent(entry, now));
