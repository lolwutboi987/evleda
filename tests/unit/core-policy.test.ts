import { describe, expect, it } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { evidenceRoot } from "../../src/core/evidence.js";
import { approvalRecordSchema } from "../../src/contracts/results.js";
import {
  assertPrototypeExportAllowed,
  assertRequirementsApproval,
  deriveLifecycleDecision,
  deriveLifecycleState
} from "../../src/core/policy.js";
import { parseRequirements } from "../../src/core/requirements.js";
import type {
  ApprovalRecord,
  DesignRevision,
  EvidenceRecord,
  HumanActor
} from "../../src/domain/types.js";

const POLICY_VERSION = "evleda.policy.v1";
const NOW = new Date("2026-09-03T12:00:00.000Z");

const revision: DesignRevision = {
  id: "revision_1",
  projectId: "project_1",
  runId: "run_1",
  ordinal: 1,
  parentRevisionIds: [],
  manifest: canonicalIdentity({ artifact: "one" }, "evleda.revision.v1"),
  artifactIds: [],
  evidenceIds: [],
  lifecycle: "candidate",
  createdAt: "2026-09-03T00:00:00.000Z"
};

const approval = (
  kind: ApprovalRecord["kind"],
  role: HumanActor["role"],
  evidenceRootDigest?: string,
  overrides: Partial<ApprovalRecord> = {}
): ApprovalRecord => {
  return {
    id: `approval_${kind}`,
    kind,
    projectId: revision.projectId,
    runId: revision.runId,
    designRevisionId: revision.id,
    subjectDigest: revision.manifest.digest,
    ...(evidenceRootDigest === undefined ? {} : { evidenceRootDigest }),
    policyVersion: POLICY_VERSION,
    actor: { type: "human", id: "reviewer", displayName: "Reviewer", role },
    scope: "exact revision",
    rationale: "test fixture",
    createdAt: "2026-09-03T00:00:00.000Z",
    ...overrides
  };
};

const physicalEvidence: EvidenceRecord = {
  id: "evidence_physical",
  projectId: revision.projectId,
  runId: revision.runId,
  designRevisionId: revision.id,
  stage: "bringup_package",
  evidenceClass: "human_physical",
  claim: "Exact board passed the bound procedure",
  subjectDigests: [revision.manifest.digest],
  exactInputs: [contentIdentity("raw measurements")],
  tool: { name: "human-review", version: "1", adapter: "human" },
  validationStatus: "pass",
  unresolvedAssumptions: [],
  lifecycle: "candidate",
  createdAt: "2026-09-03T00:00:00.000Z"
};

describe("lifecycle policy", () => {
  it("keeps a revision candidate without an exact human qualification", () => {
    expect(deriveLifecycleState(revision, [], [], POLICY_VERSION, NOW)).toBe("candidate");
    expect(() => assertPrototypeExportAllowed(revision, [], [], POLICY_VERSION, NOW)).toThrowError(
      /human qualification/iu
    );
  });

  it("requires a deeply verified physical record plus current exact root, role, policy, and time for qualification", () => {
    const emptyRoot = evidenceRoot([]).digest;
    const emptyQualification = approval("qualification", "hardware_qualifier", emptyRoot);
    expect(deriveLifecycleState(revision, [emptyQualification], [], POLICY_VERSION, NOW)).toBe("candidate");
    const root = evidenceRoot([physicalEvidence]).digest;
    const exact = approval("qualification", "hardware_qualifier", root);
    const { evidenceRootDigest: _ignoredRoot, ...rootless } = exact;
    expect(
      deriveLifecycleState(
        revision,
        [exact],
        [physicalEvidence],
        POLICY_VERSION,
        NOW,
        [physicalEvidence.id]
      )
    ).toBe("qualified");
    expect(
      deriveLifecycleState(
        revision,
        [rootless],
        [physicalEvidence],
        POLICY_VERSION,
        NOW,
        [physicalEvidence.id]
      )
    ).toBe("candidate");
    expect(
      deriveLifecycleState(
        revision,
        [{ ...exact, evidenceRootDigest: "0".repeat(64) }],
        [physicalEvidence],
        POLICY_VERSION,
        NOW,
        [physicalEvidence.id]
      )
    ).toBe("candidate");
    expect(
      deriveLifecycleState(
        revision,
        [{ ...exact, policyVersion: "old-policy" }],
        [physicalEvidence],
        POLICY_VERSION,
        NOW,
        [physicalEvidence.id]
      )
    ).toBe("candidate");
    expect(
      deriveLifecycleState(
        revision,
        [{ ...exact, expiresAt: NOW.toISOString() }],
        [physicalEvidence],
        POLICY_VERSION,
        NOW,
        [physicalEvidence.id]
      )
    ).toBe("candidate");
  });

  it("requires release to bind the exact active qualification and current evidence root", () => {
    const root = evidenceRoot([physicalEvidence]).digest;
    const qualification = approval("qualification", "hardware_qualifier", root);
    const release = approval("manufacturing_release", "release_authority", root, {
      qualificationApprovalId: qualification.id
    });
    expect(
      deriveLifecycleState(
        revision,
        [qualification, release],
        [physicalEvidence],
        POLICY_VERSION,
        NOW,
        [physicalEvidence.id]
      )
    ).toBe("release_authorized");
    expect(
      deriveLifecycleState(
        revision,
        [qualification, { ...release, evidenceRootDigest: "0".repeat(64) }],
        [physicalEvidence],
        POLICY_VERSION,
        NOW,
        [physicalEvidence.id]
      )
    ).toBe("qualified");
    expect(
      deriveLifecycleState(
        revision,
        [qualification, { ...release, qualificationApprovalId: "approval_replacement" }],
        [physicalEvidence],
        POLICY_VERSION,
        NOW,
        [physicalEvidence.id]
      )
    ).toBe("qualified");
  });

  it("demotes both attestations after any evidence-root change", () => {
    const originalEvidence = [physicalEvidence];
    const originalRoot = evidenceRoot(originalEvidence).digest;
    const qualification = approval("qualification", "hardware_qualifier", originalRoot);
    const release = approval("manufacturing_release", "release_authority", originalRoot, {
      qualificationApprovalId: qualification.id
    });
    const addedEvidence: EvidenceRecord = {
      ...physicalEvidence,
      id: "evidence_added",
      evidenceClass: "evleda_check",
      claim: "New evidence changes the complete root"
    };
    const changedEvidence = [...originalEvidence, addedEvidence];

    expect(
      deriveLifecycleState(
        revision,
        [qualification, release],
        changedEvidence,
        POLICY_VERSION,
        NOW,
        [physicalEvidence.id]
      )
    ).toBe("candidate");

    const replacement = approval(
      "qualification",
      "hardware_qualifier",
      evidenceRoot(changedEvidence).digest,
      { id: "approval_replacement" }
    );
    expect(
      deriveLifecycleState(
        revision,
        [qualification, release, replacement],
        changedEvidence,
        POLICY_VERSION,
        NOW,
        [physicalEvidence.id]
      )
    ).toBe("qualified");
  });

  it("does not revive an old release under a replacement qualification for the same root", () => {
    const root = evidenceRoot([physicalEvidence]).digest;
    const original = approval("qualification", "hardware_qualifier", root, {
      revokedAt: "2026-09-03T11:00:00.000Z"
    });
    const release = approval("manufacturing_release", "release_authority", root, {
      qualificationApprovalId: original.id
    });
    const replacement = approval("qualification", "hardware_qualifier", root, {
      id: "approval_replacement"
    });

    expect(
      deriveLifecycleState(
        revision,
        [original, release, replacement],
        [physicalEvidence],
        POLICY_VERSION,
        NOW,
        [physicalEvidence.id]
      )
    ).toBe("qualified");
  });

  it("treats expired evidence as inactive even when the root still matches", () => {
    const expiringEvidence = { ...physicalEvidence, validUntil: NOW.toISOString() };
    const root = evidenceRoot([expiringEvidence]).digest;
    const qualification = approval("qualification", "hardware_qualifier", root);
    const release = approval("manufacturing_release", "release_authority", root, {
      qualificationApprovalId: qualification.id
    });

    const decision = deriveLifecycleDecision(
      revision,
      [qualification, release],
      [expiringEvidence],
      POLICY_VERSION,
      NOW,
      [expiringEvidence.id]
    );
    expect(decision.state).toBe("candidate");
    expect(decision.activeQualificationIds).toEqual([]);
    expect(decision.activeReleaseIds).toEqual([]);
  });

  it("requires exact root and qualification dependency fields in attestation results", () => {
    const root = evidenceRoot([physicalEvidence]).digest;
    const qualification = approval("qualification", "hardware_qualifier", root);
    const release = approval("manufacturing_release", "release_authority", root, {
      qualificationApprovalId: qualification.id
    });
    const { evidenceRootDigest: _qualificationRoot, ...rootlessQualification } = qualification;
    const { qualificationApprovalId: _qualificationId, ...unboundRelease } = release;

    expect(approvalRecordSchema.safeParse(rootlessQualification).success).toBe(false);
    expect(approvalRecordSchema.safeParse(unboundRelease).success).toBe(false);
    expect(approvalRecordSchema.parse(release).qualificationApprovalId).toBe(qualification.id);
  });

  it("rejects a requirements approval for a stale digest", () => {
    const requirements = parseRequirements(
      "Two motors at 0.5 A RMS from a 7-16.8 V input with CAN and SWD."
    ).document;
    expect(() =>
      assertRequirementsApproval(
        requirements,
        {
          type: "human",
          id: "reviewer",
          displayName: "Reviewer",
          role: "requirements_reviewer"
        },
        "0".repeat(64)
      )
    ).toThrowError(/current requirements digest/iu);
  });
});
