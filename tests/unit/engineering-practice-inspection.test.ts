import { describe, expect, it } from "vitest";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import {
  ENGINEERING_CONSTRAINT_CONTEXT_SCHEMA,
  compileEngineeringConstraintBinding,
  type EngineeringCheckerResult,
  type EngineeringInputBinding,
  type EngineeringScopeFact
} from "../../src/engineering/constraint-compiler.js";
import { engineeringPracticeInspectionResultSchema } from "../../src/contracts/results.js";
import {
  buildEngineeringPracticeInspection,
  normalizeEngineeringMachineStatus,
  type EngineeringPracticeInspectionBuildInput
} from "../../src/engineering/engineering-practice-inspection.js";
import { buildPcbPracticeAnalysisProfile } from "../../src/generators/pcb-generator.js";
import {
  PCB_LAYOUT_QUALITY_POLICY,
  PCB_ROUTE_QUALITY_RULE_DECK,
  REV_A_PROOF_FIXTURE_POLICY,
  buildPcbLayoutPlan
} from "../../src/generators/pcb-layout-plan.js";
import {
  PCB_ENGINEERING_PRACTICE_CATALOG,
  PCB_ENGINEERING_REQUIRED_INPUTS,
  PCB_ENGINEERING_SCOPE_PREDICATES,
  type PcbEngineeringRequiredInput
} from "../../src/knowledge/pcb-engineering-practices.js";
import { ROBOTICS_CONTROLLER_V0 } from "../../src/knowledge/reference-controller-v0.js";
import { analyzeKicadPcbPractices } from "../../src/integrations/pcb-practice-analyzer.js";
import { REFERENCE_KICAD_ANALYZER_TOOLS } from "../../src/integrations/reference-kicad-backend.js";
import { CLEAN_MINIMAL_KICAD_PCB, TEST_KICAD_TOOL } from "../helpers/kicad-reports.js";

const revisionManifest = canonicalIdentity({ revision: "revision_engineering_1" }, "test.revision.v1");
const evidenceRoot = canonicalIdentity({ evidence: [] }, "evleda.evidence-root.v1");
const requirementsIdentity = canonicalIdentity({ requirements: true }, "evleda.requirements.v1");
const plan = buildPcbLayoutPlan(ROBOTICS_CONTROLLER_V0);
const profile = buildPcbPracticeAnalysisProfile(ROBOTICS_CONTROLLER_V0, plan);
const profileIdentity = canonicalIdentity(profile, profile.schemaVersion);
const analysis = analyzeKicadPcbPractices(CLEAN_MINIMAL_KICAD_PCB, profile, {
  sourcePath: "kicad/robotics-controller-v0/robotics-controller-v0.kicad_pcb"
});
const boardIdentity = contentIdentity(CLEAN_MINIMAL_KICAD_PCB);
const drcIdentity = contentIdentity("native drc report");
const practiceIdentity = contentIdentity("pcb practice report");

const rightAngleBoard = new TextEncoder().encode(
  new TextDecoder().decode(CLEAN_MINIMAL_KICAD_PCB).replace(
    "(segment (start 10 5) (end 15 10)",
    "(segment (start 10 5) (end 10 10)"
  )
);
const rightAngleAnalysis = analyzeKicadPcbPractices(rightAngleBoard, profile, {
  sourcePath: "kicad/robotics-controller-v0/robotics-controller-v0.kicad_pcb"
});

const forgedIdentityConstraintBinding = () => {
  const capabilitySnapshotIdentity = contentIdentity("attacker capability label only");
  const serviceAndOrderOptionsIdentity = canonicalIdentity(
    { attacker: "service label only" },
    "attacker.fabricator-service.v1"
  );
  const stackupIdentity = canonicalIdentity(
    { attacker: "stackup label only" },
    "attacker.fabricator-stackup.v1"
  );
  const scopeFacts: readonly EngineeringScopeFact[] = PCB_ENGINEERING_SCOPE_PREDICATES.map(
    (predicate): EngineeringScopeFact => ({
      predicate,
      value:
        predicate === "supported_low_voltage_rigid_pcb" ||
        predicate === "multilayer_or_controlled_impedance_present",
      identity: canonicalIdentity({ predicate }, "test.scope.v1")
    })
  );
  const inputBindings: readonly EngineeringInputBinding[] =
    PCB_ENGINEERING_REQUIRED_INPUTS.map(
      (inputId: PcbEngineeringRequiredInput): EngineeringInputBinding => ({
        inputId,
        identity:
          inputId === "fabricator_capability_snapshot_identity"
            ? capabilitySnapshotIdentity
            : inputId === "fabricator_service_and_order_options"
              ? serviceAndOrderOptionsIdentity
              : inputId === "stackup_identity"
                ? stackupIdentity
                : canonicalIdentity({ inputId }, "test.input.v1")
      })
    );
  const rule = PCB_ENGINEERING_PRACTICE_CATALOG.rules.find(
    (candidate) => candidate.id === "pcb.stackup.exact-fabricator-capability-binding"
  )!;
  const checkerResults: readonly EngineeringCheckerResult[] = rule.checkerIds.map(
    (checkerId): EngineeringCheckerResult => ({
      ruleId: rule.id,
      checkerId,
      status: "pass",
      resultIdentity: canonicalIdentity(
        { checkerId, claim: "self asserted pass" },
        "attacker.self-claimed-checker.v1"
      ),
      exactInputIdentities: rule.requiredInputs.map(
        (inputId) => inputBindings.find((binding) => binding.inputId === inputId)!.identity
      ),
      sourceIds: rule.sourceIds,
      numericClaimIds: rule.numericClaims.map((claim) => claim.id),
      modelIds: rule.modelIds
    })
  );
  const binding = compileEngineeringConstraintBinding({
    schemaVersion: ENGINEERING_CONSTRAINT_CONTEXT_SCHEMA,
    scopeFacts,
    inputBindings,
    checkerResults
  });
  return {
    binding,
    forgedProfile: {
      profileArtifactIdentity: contentIdentity("attacker profile"),
      capabilitySnapshotIdentity,
      serviceAndOrderOptionsIdentity,
      stackupIdentity,
      evidenceId: "evidence_attacker_profile",
      tool: {
        name: "self-claimed-fabricator-checker",
        version: "1",
        adapter: "evleda" as const,
        capabilityProfile: "fabricator-profile"
      },
      evaluatedAt: "2026-09-05T12:00:00.000Z",
      sourceCaptureIdentity: contentIdentity("attacker source capture"),
      sourceLocator: { kind: "self_claim", value: "attacker" },
      sourceExcerptIdentity: contentIdentity("attacker excerpt")
    }
  };
};

const input = (
  overrides: Partial<EngineeringPracticeInspectionBuildInput> = {}
): EngineeringPracticeInspectionBuildInput => ({
  projectId: "project_engineering_1",
  runId: "run_engineering_1",
  revisionId: "revision_engineering_1",
  isHeadRevision: true,
  revisionManifest,
  requirementsIdentity,
  evidenceRootIdentity: evidenceRoot,
  practiceCatalog: PCB_ENGINEERING_PRACTICE_CATALOG,
  routeQualityPolicy: PCB_LAYOUT_QUALITY_POLICY,
  routeQualityPolicyIdentity: PCB_LAYOUT_QUALITY_POLICY.identity,
  routeQualityPolicyCaptureIdentity: PCB_LAYOUT_QUALITY_POLICY.captureIdentity,
  routeQualityRuleDeck: PCB_ROUTE_QUALITY_RULE_DECK,
  routeQualityRuleDeckIdentity: PCB_ROUTE_QUALITY_RULE_DECK.identity,
  proofFixturePolicyIdentity: REV_A_PROOF_FIXTURE_POLICY.identity,
  analyzerProfileIdentity: profileIdentity,
  constraintBinding: null,
  authoritativeScopeFactIdentities: [],
  authoritativeCheckerResultIdentities: [],
  verifiedReferenceFabricationProfile: null,
  nativeBoard: {
    artifactId: "artifact_board_1",
    identity: boardIdentity
  },
  nativeDrc: {
    validationStatus: "pass",
    current: true,
    artifactId: "artifact_drc_1",
    evidenceId: "evidence_drc_1",
    reportIdentity: drcIdentity,
    tool: TEST_KICAD_TOOL,
    evaluatedAt: "2026-09-05T12:00:00.000Z"
  },
  evledaPractice: {
    validationStatus: "pass",
    current: true,
    artifactId: "artifact_practice_1",
    evidenceId: "evidence_practice_1",
    reportIdentity: practiceIdentity,
    tool: REFERENCE_KICAD_ANALYZER_TOOLS.pcb_practices,
    evaluatedAt: "2026-09-05T12:00:00.000Z",
    analysis
  },
  findingLimit: 3,
  ...overrides
});

describe("engineering practice inspection projection", () => {
  it("normalizes execution vocabulary without treating waiver or unavailable output as pass", () => {
    expect(normalizeEngineeringMachineStatus("pass")).toBe("PASS");
    expect(normalizeEngineeringMachineStatus("fail")).toBe("FAIL");
    expect(normalizeEngineeringMachineStatus("not_run")).toBe("NOT_RUN");
    for (const status of ["error", "unsupported", "stale", "revoked", "waived"] as const) {
      expect(normalizeEngineeringMachineStatus(status), status).toBe("UNKNOWN");
    }
  });

  it("keeps missing constraint execution in the denominator and blocks POC despite passing report labels", () => {
    const result = buildEngineeringPracticeInspection(input());

    expect(engineeringPracticeInspectionResultSchema.safeParse(result).success).toBe(true);
    expect(result.disposition.status).toBe("BLOCKED_DIAGNOSTIC");
    expect(result.disposition.reasonCodes).toContain("REFERENCE_FABRICATION_PROFILE_NOT_FROZEN");
    expect(result.disposition.reasonCodes).toContain(
      "EVLEDA_PRACTICE_GEOMETRY_COVERAGE_INCOMPLETE"
    );
    expect(result.checks.nativeDrc.machineStatus).toBe("PASS");
    expect(result.checks.evledaPractice.machineStatus).toBe("UNKNOWN");
    expect(result.coverage.expectedRuleCount).toBe(result.rules.length);
    expect(result.coverage.missingRuleIds.length).toBe(PCB_ENGINEERING_PRACTICE_CATALOG.rules.length);
    expect(result.coverage.inventoryComplete).toBe(false);
    expect(result.rules.every((rule) => rule.machineStatus !== null)).toBe(true);
    expect(result.proofFixture).toEqual({
      purpose: "full_stack_engineering_proof_fixture",
      classification: "candidate_only",
      reportEstablishesQualification: false,
      reportAuthorizesManufacturing: false,
      reportAuthorizesRelease: false
    });
  });

  it("uses a bounded identity-bound offset cursor and rejects cross-revision reuse", () => {
    const first = buildEngineeringPracticeInspection(input({ findingLimit: 2 }));
    expect(first.findings.total).toBeGreaterThan(2);
    expect(first.findings.items).toHaveLength(2);
    expect(first.findings.nextCursor).not.toBeNull();

    const second = buildEngineeringPracticeInspection(input({
      findingLimit: 2,
      findingCursor: first.findings.nextCursor!
    }));
    expect(second.findings.items).toHaveLength(2);
    expect(second.findings.items.map((finding) => finding.findingId)).not.toEqual(
      first.findings.items.map((finding) => finding.findingId)
    );
    expect(second.findings.total).toBe(first.findings.total);
    expect(second.identity).not.toEqual(first.identity);

    const cursorDocument = JSON.parse(
      Buffer.from(first.findings.nextCursor!, "base64url").toString("utf8")
    ) as Record<string, unknown>;
    cursorDocument.offset = first.findings.total - 1;
    const boundedOffsetCursor = Buffer.from(
      canonicalJson(cursorDocument),
      "utf8"
    ).toString("base64url");
    const bounded = buildEngineeringPracticeInspection(input({
      findingLimit: 100,
      findingCursor: boundedOffsetCursor
    }));
    expect(bounded.findings.items).toHaveLength(1);
    expect(bounded.findings.total).toBe(first.findings.total);
    expect(bounded.disposition).toEqual(first.disposition);

    expect(() => buildEngineeringPracticeInspection(input({
      revisionId: "revision_engineering_foreign",
      revisionManifest: canonicalIdentity(
        { revision: "revision_engineering_foreign" },
        "test.revision.v1"
      ),
      findingCursor: first.findings.nextCursor!
    }))).toThrowError(/bound to a different engineering report/u);
  });

  it("represents a missing revision and both missing executions honestly", () => {
    const result = buildEngineeringPracticeInspection(input({
      revisionId: null,
      isHeadRevision: false,
      revisionManifest: null,
      practiceCatalog: null,
      routeQualityPolicy: null,
      routeQualityPolicyIdentity: null,
      routeQualityPolicyCaptureIdentity: null,
      routeQualityRuleDeck: null,
      routeQualityRuleDeckIdentity: null,
      proofFixturePolicyIdentity: null,
      analyzerProfileIdentity: null,
      nativeBoard: null,
      nativeDrc: null,
      evledaPractice: null
    }));

    expect(engineeringPracticeInspectionResultSchema.safeParse(result).success).toBe(true);
    expect(result.disposition.status).toBe("BLOCKED_DIAGNOSTIC");
    expect(result.checks.nativeDrc.machineStatus).toBe("NOT_RUN");
    expect(result.checks.evledaPractice.machineStatus).toBe("NOT_RUN");
    expect(result.coverage.inventoryComplete).toBe(false);
    expect(result.coverage.expectedRuleCount).toBe(3);
    expect(result.coverage.missingRuleIds).toHaveLength(3);
  });

  it("does not present a not-run record as a completed execution authority", () => {
    const result = buildEngineeringPracticeInspection(input({
      nativeDrc: {
        validationStatus: "not_run",
        current: true,
        artifactId: "artifact_drc_not_run",
        evidenceId: "evidence_drc_not_run",
        reportIdentity: drcIdentity,
        tool: TEST_KICAD_TOOL,
        evaluatedAt: "2026-09-05T12:00:00.000Z"
      }
    }));

    expect(result.checks.nativeDrc).toMatchObject({
      machineStatus: "NOT_RUN",
      current: false,
      artifactId: null,
      evidenceId: null,
      reportIdentity: null,
      tool: null,
      evaluatedAt: null
    });
    expect(engineeringPracticeInspectionResultSchema.safeParse(result).success).toBe(true);
  });

  it("keeps exact historical check results visible but never grants current-head disposition", () => {
    const result = buildEngineeringPracticeInspection(input({ isHeadRevision: false }));

    expect(result.checks.nativeDrc.machineStatus).toBe("PASS");
    expect(result.checks.evledaPractice.machineStatus).toBe("UNKNOWN");
    expect(result.isHeadRevision).toBe(false);
    expect(result.disposition.status).toBe("BLOCKED_DIAGNOSTIC");
    expect(result.disposition.reasonCodes).toContain("HISTORICAL_NON_HEAD_REVISION");
    expect(engineeringPracticeInspectionResultSchema.safeParse(result).success).toBe(true);
  });

  it("rejects identity-only fabrication and self-claimed checker authority", () => {
    const { binding, forgedProfile } = forgedIdentityConstraintBinding();
    const result = buildEngineeringPracticeInspection(input({
      constraintBinding: binding,
      authoritativeScopeFactIdentities: binding.contextSnapshot.scopeFacts.map(
        (fact) => fact.identity
      ),
      authoritativeCheckerResultIdentities: [],
      verifiedReferenceFabricationProfile: forgedProfile
    }));
    const stackup = result.rules.find(
      (rule) => rule.ruleId === "pcb.stackup.exact-fabricator-capability-binding"
    );

    expect(stackup).toMatchObject({
      applicability: "APPLICABLE",
      machineStatus: "UNKNOWN",
      reasonCode: "ENGINEERING_CHECKER_AUTHORITY_UNVERIFIED"
    });
    const notApplicable = result.rules.find(
      (rule) => rule.applicability === "NOT_APPLICABLE"
    );
    expect(notApplicable?.machineStatus).toBeNull();
    expect(result.coverage.notApplicableRuleCount).toBeGreaterThan(0);
    expect(result.disposition.status).toBe("BLOCKED_DIAGNOSTIC");
    expect(result.disposition.reasonCodes).toContain(
      "REFERENCE_FABRICATION_PROFILE_NOT_TRUSTED"
    );
    expect(result.outstandingExternalGates.length).toBeGreaterThan(0);
    expect(
      result.outstandingExternalGates.every((gate) =>
        gate.status === "OPEN" || gate.status === "UNKNOWN"
      )
    ).toBe(true);
    expect(engineeringPracticeInspectionResultSchema.safeParse(result).success).toBe(true);
  });

  it("binds routed rules and findings to the captured internal route policy", () => {
    const result = buildEngineeringPracticeInspection(input({
      nativeBoard: { artifactId: "artifact_board_right_angle", identity: contentIdentity(rightAngleBoard) },
      evledaPractice: {
        validationStatus: "fail",
        current: true,
        artifactId: "artifact_practice_right_angle",
        evidenceId: "evidence_practice_right_angle",
        reportIdentity: practiceIdentity,
        tool: REFERENCE_KICAD_ANALYZER_TOOLS.pcb_practices,
        evaluatedAt: "2026-09-05T12:00:00.000Z",
        analysis: rightAngleAnalysis
      },
      findingLimit: 100
    }));
    const source = result.sources.find(
      (candidate) => candidate.sourceId === "evleda-route-quality-policy"
    );
    const routeRule = result.rules.find((rule) => rule.ruleId === "ROUTE_STYLE");
    const routeFinding = result.findings.items.find((finding) =>
      finding.ruleIds.includes("ROUTE_STYLE")
    );

    expect(source).toMatchObject({
      url: null,
      authority: "internal_policy",
      accessScope: "embedded_snapshot",
      normativeStatus: "internal_product_policy",
      captureComplete: true
    });
    expect(routeRule?.sourceIds).toContain("evleda-route-quality-policy");
    expect(routeFinding?.sourceIds).toContain("evleda-route-quality-policy");
    expect(engineeringPracticeInspectionResultSchema.safeParse(result).success).toBe(true);
  });

  it("does not reuse a stale practice pass for current rule status", () => {
    const result = buildEngineeringPracticeInspection(input({
      evledaPractice: {
        validationStatus: "pass",
        current: false,
        artifactId: "artifact_practice_stale",
        evidenceId: "evidence_practice_stale",
        reportIdentity: practiceIdentity,
        tool: REFERENCE_KICAD_ANALYZER_TOOLS.pcb_practices,
        evaluatedAt: "2026-09-05T12:00:00.000Z",
        analysis
      }
    }));

    expect(result.checks.evledaPractice.machineStatus).toBe("UNKNOWN");
    const applicable = result.rules.filter(
      (rule) => rule.applicability !== "NOT_APPLICABLE"
    );
    expect(applicable.every((rule) => rule.machineStatus !== "PASS")).toBe(true);
    expect(result.disposition.status).toBe("BLOCKED_DIAGNOSTIC");
    expect(engineeringPracticeInspectionResultSchema.safeParse(result).success).toBe(true);
  });
});
