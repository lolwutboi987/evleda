import { DomainError } from "../domain/errors.js";
import type {
  ApprovalRecord,
  CanonicalIdentity,
  DesignRevision,
  EvidenceRecord,
  HumanActor,
  LifecycleState,
  RequirementsDocument
} from "../domain/types.js";
import { evidenceIsCurrent, evidenceRoot, evidenceSetIsCurrent } from "./evidence.js";

const isActive = (approval: ApprovalRecord, now: Date): boolean =>
  approval.revokedAt === undefined &&
  (approval.expiresAt === undefined || new Date(approval.expiresAt).getTime() > now.getTime());

const bindsRevision = (approval: ApprovalRecord, revision: DesignRevision): boolean =>
  approval.designRevisionId === revision.id && approval.subjectDigest === revision.manifest.digest;

const bindsPolicyAndEvidence = (
  approval: ApprovalRecord,
  policyVersion: string,
  currentEvidenceRoot: CanonicalIdentity
): boolean =>
  approval.policyVersion === policyVersion &&
  approval.evidenceRootDigest === currentEvidenceRoot.digest;

export interface LifecycleDecision {
  readonly state: LifecycleState;
  readonly evidenceRoot: CanonicalIdentity;
  readonly activeQualificationIds: readonly string[];
  readonly activeReleaseIds: readonly string[];
}

export const assertRequirementsApproval = (
  document: RequirementsDocument,
  actor: HumanActor,
  subjectDigest: string
): void => {
  if (actor.type !== "human" || actor.role !== "requirements_reviewer") {
    throw new DomainError(
      "CAPABILITY_REQUIRED",
      "Requirements approval requires a human requirements-review capability"
    );
  }
  if (document.identity.digest !== subjectDigest) {
    throw new DomainError("REVISION_CONFLICT", "Approval does not bind the current requirements digest", {
      expected: document.identity.digest,
      actual: subjectDigest
    });
  }
  const blocking = document.unresolvedAssumptions.filter(
    (assumption) => assumption.severity === "blocking"
  );
  if (blocking.length > 0) {
    throw new DomainError("GATE_FAILED", "Requirements contain blocking ambiguity", { blocking });
  }
};

export const deriveLifecycleDecision = (
  revision: DesignRevision,
  approvals: readonly ApprovalRecord[],
  evidence: readonly EvidenceRecord[],
  policyVersion: string,
  now = new Date(),
  verifiedPhysicalEvidenceIds: readonly string[] = []
): LifecycleDecision => {
  const currentEvidenceRoot = evidenceRoot(evidence);
  if (!evidenceSetIsCurrent(evidence, now)) {
    return {
      state: "candidate",
      evidenceRoot: currentEvidenceRoot,
      activeQualificationIds: [],
      activeReleaseIds: []
    };
  }

  const verifiedPhysicalIds = new Set(verifiedPhysicalEvidenceIds);
  const physicalEvidence = evidence.some(
    (entry) =>
      verifiedPhysicalIds.has(entry.id) &&
      entry.designRevisionId === revision.id &&
      entry.evidenceClass === "human_physical" &&
      entry.validationStatus === "pass" &&
      evidenceIsCurrent(entry, now) &&
      entry.subjectDigests.includes(revision.manifest.digest)
  );
  if (!physicalEvidence) {
    return {
      state: "candidate",
      evidenceRoot: currentEvidenceRoot,
      activeQualificationIds: [],
      activeReleaseIds: []
    };
  }

  const qualifications = approvals.filter(
    (approval) =>
      approval.kind === "qualification" &&
      approval.actor.type === "human" &&
      approval.actor.role === "hardware_qualifier" &&
      isActive(approval, now) &&
      bindsRevision(approval, revision) &&
      bindsPolicyAndEvidence(approval, policyVersion, currentEvidenceRoot)
  );
  const activeQualificationIds = qualifications
    .map((approval) => approval.id)
    .sort((left, right) => left.localeCompare(right, "en"));
  if (activeQualificationIds.length === 0) {
    return {
      state: "candidate",
      evidenceRoot: currentEvidenceRoot,
      activeQualificationIds,
      activeReleaseIds: []
    };
  }

  const qualificationIds = new Set(activeQualificationIds);
  const releases = approvals.filter(
    (approval) =>
      approval.kind === "manufacturing_release" &&
      approval.actor.type === "human" &&
      approval.actor.role === "release_authority" &&
      isActive(approval, now) &&
      bindsRevision(approval, revision) &&
      bindsPolicyAndEvidence(approval, policyVersion, currentEvidenceRoot) &&
      approval.qualificationApprovalId !== undefined &&
      qualificationIds.has(approval.qualificationApprovalId)
  );
  const matchingReleaseIds = releases
    .map((approval) => approval.id)
    .sort((left, right) => left.localeCompare(right, "en"));
  const activeReleaseIds = physicalEvidence ? matchingReleaseIds : [];
  return {
    state: activeReleaseIds.length > 0 ? "release_authorized" : "qualified",
    evidenceRoot: currentEvidenceRoot,
    activeQualificationIds,
    activeReleaseIds
  };
};

export const deriveLifecycleState = (
  revision: DesignRevision,
  approvals: readonly ApprovalRecord[],
  evidence: readonly EvidenceRecord[],
  policyVersion: string,
  now = new Date(),
  verifiedPhysicalEvidenceIds: readonly string[] = []
): LifecycleState =>
  deriveLifecycleDecision(
    revision,
    approvals,
    evidence,
    policyVersion,
    now,
    verifiedPhysicalEvidenceIds
  ).state;

export const assertPrototypeExportAllowed = (
  revision: DesignRevision,
  approvals: readonly ApprovalRecord[],
  evidence: readonly EvidenceRecord[],
  policyVersion: string,
  now = new Date(),
  verifiedPhysicalEvidenceIds: readonly string[] = []
): void => {
  if (
    deriveLifecycleState(
      revision,
      approvals,
      evidence,
      policyVersion,
      now,
      verifiedPhysicalEvidenceIds
    ) === "candidate"
  ) {
    throw new DomainError(
      "POLICY_DENIED",
      "Prototype export requires a human qualification attestation for this exact revision"
    );
  }
};

export const assertReleaseOperationActor = (actor: HumanActor): void => {
  if (actor.type !== "human" || actor.role !== "release_authority") {
    throw new DomainError(
      "CAPABILITY_REQUIRED",
      "Manufacturing release requires a separate human release authority"
    );
  }
};
