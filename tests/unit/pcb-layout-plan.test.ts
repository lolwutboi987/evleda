import { describe, expect, it } from "vitest";

import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import { parseRequirements } from "../../src/core/requirements.js";
import { STAGE_ORDER, type StageKey } from "../../src/domain/stages.js";
import type { ApprovalRecord } from "../../src/domain/types.js";
import { pcbPlacementRoutingStageExecutor } from "../../src/generators/pcb-generator.js";
import {
  PCB_ELECTRICAL_SIZING_EVIDENCE_LOGICAL_NAME,
  PCB_ELECTRICAL_SIZING_EVIDENCE_SCHEMA,
  PCB_ELECTRICAL_SIZING_REQUIRED_NET_CLASS_IDS,
  PCB_LAYOUT_PRACTICE_RULE_IDS,
  PCB_LAYOUT_QUALITY_POLICY,
  PCB_LAYOUT_SOURCE_IDS,
  PCB_ROUTE_QUALITY_POLICY_CANONICAL_BYTES,
  PCB_ROUTE_QUALITY_RULE_DECK,
  PCB_TRACE_SIZING_PRACTICE_RULE_IDS,
  PCB_TRACE_SIZING_REQUIRED_INPUTS,
  PCB_TRACE_WIDTH_ELECTRICAL_BASIS_MISSING,
  REV_A_PROOF_FIXTURE_POLICY,
  buildPcbLayoutPlan,
  pcbLayoutPlanExactPolicyInputs,
  resolvePcbElectricalSizingEvidence
} from "../../src/generators/pcb-layout-plan.js";
import { PCB_ENGINEERING_PRACTICE_CATALOG } from "../../src/knowledge/pcb-engineering-practices.js";
import {
  ROBOTICS_CONTROLLER_V0,
  type ReferenceControllerProfile
} from "../../src/knowledge/reference-controller-v0.js";
import type {
  CandidateStageContext,
  KicadGenerationBackend,
  StageExecutionResult
} from "../../src/workflow/contracts.js";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const decode = (value: Uint8Array): string => new TextDecoder().decode(value);

const validPrompt = [
  "Build a two-channel brushed motor controller for a 7-16.8 V DC battery.",
  "Each motor is limited to 0.5 A RMS. Provide USB-C, CAN, UART, I2C, SPI,",
  "two quadrature encoders, and SWD programming."
].join(" ");

const successfulStage = (
  stage: StageKey,
  requirements: ReturnType<typeof parseRequirements>["document"]
): StageExecutionResult => ({
  schemaVersion: "evleda.stage-result.v1",
  stage,
  executionStatus: "succeeded",
  artifacts: [],
  evidence: [],
  blockers: [],
  outputIdentity: canonicalIdentity({ stage, fixture: "pcb-layout-plan" }, `test.${stage}.v1`),
  ...(stage === "requirements" ? { requirementsDocument: requirements } : {})
});

const approvalFor = (requirementsDigest: string): ApprovalRecord => ({
  id: "approval_pcb_layout_plan_fixture",
  kind: "requirements",
  projectId: "project_pcb_layout_plan_fixture",
  runId: "run_pcb_layout_plan_fixture",
  subjectDigest: requirementsDigest,
  policyVersion: "evleda-policy-v0",
  actor: {
    type: "human",
    id: "reviewer_pcb_layout_plan_fixture",
    displayName: "PCB layout plan fixture reviewer",
    role: "requirements_reviewer"
  },
  scope: "Approve the exact fixture requirements for a diagnostic PCB stage test.",
  rationale: "Deterministic unit-test fixture.",
  createdAt: "2026-09-05T12:00:00.000Z"
});

const sizingCheck = (
  kind: "ampacity" | "voltageDrop" | "thermal",
  sourceIdentity: ReturnType<typeof canonicalIdentity>
) => ({
  status: "pass" as const,
  methodId:
    kind === "ampacity"
      ? "qualified-current-temperature-model"
      : kind === "voltageDrop"
        ? "evleda-hot-copper-resistance-v1"
        : "qualified-electrothermal-model",
  modelIdentity: sourceIdentity,
  evaluatedValue: kind === "voltageDrop" ? 0.08 : 8,
  limitValue: kind === "voltageDrop" ? 0.2 : 20,
  unit: kind === "voltageDrop" ? "V" : kind === "ampacity" ? "A" : "deg_c"
});

const passingSizingSource = () => {
  const inputIdentity = canonicalIdentity(
    { fixture: "resolved-electrical-sizing-inputs" },
    "test.pcb-sizing-input.v1"
  );
  const resolvedInputs = PCB_TRACE_SIZING_REQUIRED_INPUTS.map((id) => ({
    id,
    value: 1,
    unit: "fixture_unit",
    sourceIdentity: inputIdentity
  }));
  const payload = {
    schemaVersion: PCB_ELECTRICAL_SIZING_EVIDENCE_SCHEMA,
    profileId: ROBOTICS_CONTROLLER_V0.profileId,
    boardRevision: ROBOTICS_CONTROLLER_V0.boardRevision,
    status: "pass",
    practiceCatalogIdentity: PCB_ENGINEERING_PRACTICE_CATALOG.identity,
    qualityPolicyIdentity: PCB_LAYOUT_QUALITY_POLICY.identity,
    mechanicalPolicyIdentity: REV_A_PROOF_FIXTURE_POLICY.identity,
    evaluations: PCB_ELECTRICAL_SIZING_REQUIRED_NET_CLASS_IDS.map((netClassId, index) => ({
      netClassId,
      electricalMinimumTrackWidthMm: index === 0 ? 0.92 : 0.62,
      sourceRuleIds: PCB_TRACE_SIZING_PRACTICE_RULE_IDS,
      resolvedInputs,
      ampacity: sizingCheck("ampacity", inputIdentity),
      voltageDrop: sizingCheck("voltageDrop", inputIdentity),
      thermal: sizingCheck("thermal", inputIdentity)
    }))
  };
  const content = encode(`${canonicalJson(payload)}\n`);
  const identity = contentIdentity(content);
  const exactInputs = pcbLayoutPlanExactPolicyInputs({
    status: "unresolved",
    blockerCode: PCB_TRACE_WIDTH_ELECTRICAL_BASIS_MISSING,
    reason: "missing",
    detail: "fixture",
    acceptedArtifactIdentity: null,
    evaluations: []
  });
  return {
    identity,
    source: {
      artifacts: [
        {
          logicalName: PCB_ELECTRICAL_SIZING_EVIDENCE_LOGICAL_NAME,
          content,
          identity,
          exactInputs,
          validationStatus: "pass" as const
        }
      ],
      evidence: [
        {
          evidenceClass: "evleda_check" as const,
          validationStatus: "pass" as const,
          subjectDigests: [identity.digest],
          parsedArtifactLogicalName: PCB_ELECTRICAL_SIZING_EVIDENCE_LOGICAL_NAME,
          exactInputs
        }
      ]
    }
  };
};

describe("PCB layout plan v2", () => {
  it("binds the observed Rev-A outline to the reviewed proof-fixture policy", () => {
    const plan = buildPcbLayoutPlan(ROBOTICS_CONTROLLER_V0);

    expect(plan.schemaVersion).toBe("evleda.pcb-layout-plan.v2");
    expect(plan.purpose).toBe("diagnostic_proof_fixture_plan_not_product_or_manufacturing_release");
    expect(plan.board.mechanicalEnvelope).toMatchObject({
      status: "reviewed_proof_fixture_observation",
      widthMm: 60,
      heightMm: 45,
      fixturePolicyId: REV_A_PROOF_FIXTURE_POLICY.policyId,
      fixturePolicyIdentity: REV_A_PROOF_FIXTURE_POLICY.identity,
      applicability: "exact_profile_and_board_revision_only",
      productMechanicalApproval: false
    });
    expect(REV_A_PROOF_FIXTURE_POLICY.review).toMatchObject({
      status: "reviewed_fixture_policy",
      scope: "Reuse the observed outline only for the exact Rev-A proof fixture."
    });
    expect(buildPcbLayoutPlan(ROBOTICS_CONTROLLER_V0)).toEqual(plan);
  });

  it("keeps native 0.80/0.30 mm rules separate from unresolved electrical adequacy", () => {
    const plan = buildPcbLayoutPlan(ROBOTICS_CONTROLLER_V0);

    expect(plan.electricalSizing).toMatchObject({
      status: "unresolved",
      blockerCode: PCB_TRACE_WIDTH_ELECTRICAL_BASIS_MISSING,
      acceptedArtifactSchema: PCB_ELECTRICAL_SIZING_EVIDENCE_SCHEMA,
      acceptedArtifactLogicalName: PCB_ELECTRICAL_SIZING_EVIDENCE_LOGICAL_NAME
    });
    expect(plan.electricalSizing.requiredInputs).toEqual(
      expect.arrayContaining([
        "maximum_continuous_current_a",
        "rms_current_a",
        "peak_current_a",
        "peak_duration_and_duty_cycle",
        "maximum_ambient_temperature_c",
        "allowable_conductor_temperature_rise_c",
        "estimated_copper_temperature_c",
        "conductor_length_mm",
        "minimum_finished_trace_width_mm",
        "minimum_finished_copper_thickness_mm",
        "conductor_layer_and_thermal_context",
        "fabricator_capability_snapshot_identity",
        "fabricator_service_and_order_options",
        "stackup_identity"
      ])
    );
    expect(
      plan.netClasses.map((netClass) => ({
        id: netClass.id,
        configured: netClass.nativeConfiguredMinimum.minimumTrackWidthMm,
        interpretation: netClass.nativeConfiguredMinimum.interpretation,
        configuredIsElectricalEvidence:
          netClass.nativeConfiguredMinimum.electricalAdequacyEstablished,
        effective: netClass.effectiveDesignMinimumTrackWidthMm
      }))
    ).toEqual([
      {
        id: "BatteryInput",
        configured: 0.8,
        interpretation: "native_drc_minimum_only",
        configuredIsElectricalEvidence: false,
        effective: null
      },
      {
        id: "MotorPower",
        configured: 0.3,
        interpretation: "native_drc_minimum_only",
        configuredIsElectricalEvidence: false,
        effective: null
      }
    ]);
  });

  it("binds every plan section to catalog rules or reviewed quality-policy IDs", () => {
    const plan = buildPcbLayoutPlan(ROBOTICS_CONTROLLER_V0);
    const catalogRuleIds = new Set(
      PCB_ENGINEERING_PRACTICE_CATALOG.rules.map((rule) => rule.id)
    );
    const catalogSourceIds = new Set(
      PCB_ENGINEERING_PRACTICE_CATALOG.sources.map((source) => source.id)
    );

    expect(PCB_LAYOUT_PRACTICE_RULE_IDS.every((ruleId) => catalogRuleIds.has(ruleId))).toBe(true);
    expect(PCB_LAYOUT_SOURCE_IDS.every((sourceId) => catalogSourceIds.has(sourceId))).toBe(true);
    expect(plan.practiceBinding).toMatchObject({
      catalogIdentity: PCB_ENGINEERING_PRACTICE_CATALOG.identity,
      qualityPolicyId: PCB_LAYOUT_QUALITY_POLICY.policyId,
      qualityPolicyIdentity: PCB_LAYOUT_QUALITY_POLICY.identity,
      qualityPolicyCaptureIdentity: PCB_LAYOUT_QUALITY_POLICY.captureIdentity,
      routeQualityRuleDeckId: PCB_ROUTE_QUALITY_RULE_DECK.ruleDeckId,
      routeQualityRuleDeckIdentity: PCB_ROUTE_QUALITY_RULE_DECK.identity
    });
    expect(contentIdentity(PCB_ROUTE_QUALITY_POLICY_CANONICAL_BYTES)).toEqual(
      PCB_LAYOUT_QUALITY_POLICY.captureIdentity
    );
    expect(Object.isFrozen(PCB_LAYOUT_QUALITY_POLICY)).toBe(true);
    expect(Object.isFrozen(PCB_LAYOUT_QUALITY_POLICY.routeStyle)).toBe(true);
    expect(Object.isFrozen(PCB_ROUTE_QUALITY_RULE_DECK.rules)).toBe(true);
    expect(plan.routeQualityPolicy).toMatchObject({
      policyId: "evleda.pcb-route-quality.v1",
      classification: "hard_internal_product_quality_policy_not_universal_si_or_fabrication_law",
      routeStyle: {
        ruleId: "ROUTE_STYLE",
        enforcement: "hard_internal_product_quality_gate",
        maximumUnsignedDirectionChangeDeg: 45,
        angularComparisonToleranceDeg: 0.01,
        lineArcAndArcArcTangentToleranceDeg: 0.01,
        violationDisposition: "block_candidate_stage"
      },
      backtrack: {
        ruleId: "BACKTRACK",
        enforcement: "hard_internal_product_quality_gate",
        violationDisposition: "block_candidate_stage",
        electricalSafetyClaim: false
      },
      proofFixtureExpectation: {
        expectedOutcome: "expected_negative",
        expectedFailingRuleIds: ["ROUTE_STYLE", "BACKTRACK"],
        nativeDrcPassCanCoexist: true
      }
    });
    expect(plan.routeQualityPolicy.exceptionAuthorization).toMatchObject({
      acceptedAuthorities: [
        "pre_authorized_source_bound_policy_rule",
        "separately_authenticated_human_approval_identity"
      ],
      authorityRequirements: {
        preAuthorizedPolicyRule: expect.arrayContaining([
          "canonical exception-rule identity",
          "immutable source identity"
        ]),
        authenticatedHumanApproval: expect.arrayContaining([
          "canonical approval identity",
          "authenticated human actor and capability"
        ])
      },
      rejectedAuthorities: ["agent_annotation", "agent_claim", "open_exception_request"],
      agentAuthority: "none"
    });
    expect(plan.bendSiPolicy).toMatchObject({
      ruleId: "BEND_SI",
      enforcement: "not_applicable_without_profile_rule",
      profileConstraintId: null
    });
    expect(plan.viaPolicy.policyRuleIds).toHaveLength(2);
    expect(plan.returnPathPolicy.requirements.length).toBeGreaterThan(0);
    expect(plan.hotLoopPolicy.definedLoops.map((loop) => loop.id)).toEqual([
      "buck_input_hot_loop",
      "motor_a_bridge_loop",
      "motor_b_bridge_loop"
    ]);
    expect(plan.differentialPairPolicy.pairs.map((pair) => pair.id)).toEqual([
      "usb_connector_to_protection",
      "usb_protection_to_mcu",
      "can_bus_pair"
    ]);
    expect(plan.dfmPolicy).toMatchObject({
      catalogRuleId: "pcb.dfm.parameterized-fab-and-assembly-review",
      status: "fabricator_and_assembler_confirmation_required"
    });
  });

  it("keeps hard ROUTE_STYLE/BACKTRACK independent from profile-scoped BEND_SI", () => {
    const strictProfile: ReferenceControllerProfile = {
      ...ROBOTICS_CONTROLLER_V0,
      layoutConstraints: [
        ...ROBOTICS_CONTROLLER_V0.layoutConstraints,
        {
          id: "layout_bend_si_45",
          appliesTo: ["source-bound critical nets"],
          rule:
            "BEND_SI direction changes must be no greater than 45 degrees under the exact interface profile.",
          verification: "profile-bound SI analysis"
        }
      ]
    };

    const strictPlan = buildPcbLayoutPlan(strictProfile);
    expect(strictPlan.routeQualityPolicy.routeStyle.enforcement).toBe(
      "hard_internal_product_quality_gate"
    );
    expect(strictPlan.routeQualityPolicy.backtrack.enforcement).toBe(
      "hard_internal_product_quality_gate"
    );
    expect(strictPlan.bendSiPolicy).toMatchObject({
      enforcement: "hard_profile_scoped_electrical_gate",
      profileConstraintId: "layout_bend_si_45"
    });
    expect(buildPcbLayoutPlan(ROBOTICS_CONTROLLER_V0).bendSiPolicy.enforcement).toBe(
      "not_applicable_without_profile_rule"
    );
  });

  it("can resolve the blocker only from a complete, exact EvlEDA-check sizing artifact", () => {
    const fixture = passingSizingSource();
    const resolution = resolvePcbElectricalSizingEvidence(
      ROBOTICS_CONTROLLER_V0,
      fixture.source
    );

    expect(resolution).toMatchObject({
      status: "resolved",
      blockerCode: null,
      acceptedArtifactIdentity: fixture.identity
    });
    const plan = buildPcbLayoutPlan(ROBOTICS_CONTROLLER_V0, resolution);
    expect(plan.electricalSizing.status).toBe("resolved");
    expect(plan.netClasses.map((netClass) => netClass.effectiveDesignMinimumTrackWidthMm)).toEqual([
      0.92,
      0.62
    ]);

    const detached = {
      ...fixture.source,
      evidence: fixture.source.evidence.map((entry) => ({
        ...entry,
        evidenceClass: "agent_claim" as const
      }))
    };
    expect(resolvePcbElectricalSizingEvidence(ROBOTICS_CONTROLLER_V0, detached)).toMatchObject({
      status: "unresolved",
      reason: "invalid",
      blockerCode: PCB_TRACE_WIDTH_ELECTRICAL_BASIS_MISSING
    });
  });

  it("runs the bounded backend before returning the missing-sizing blocker", async () => {
    const requirements = parseRequirements(validPrompt).document;
    const upstream = STAGE_ORDER.slice(
      0,
      STAGE_ORDER.indexOf("pcb_placement_routing")
    ).map((stage) => successfulStage(stage, requirements));
    let backendCalls = 0;
    const backend: KicadGenerationBackend = {
      backendId: "pcb-plan-invocation-test-double",
      execute: async () => {
        backendCalls += 1;
        throw new Error("Synthetic diagnostic backend stop after invocation");
      }
    };
    const context: CandidateStageContext = {
      projectId: "project_pcb_layout_plan_fixture",
      runId: "run_pcb_layout_plan_fixture",
      designRevisionId: "revision_pcb_layout_plan_fixture",
      profile: ROBOTICS_CONTROLLER_V0,
      requirements,
      requirementsApproval: approvalFor(requirements.identity.digest),
      upstream,
      upstreamSourceRevisionBindings: [],
      kicadBackend: backend
    };

    const result = await pcbPlacementRoutingStageExecutor.execute(context);

    expect(backendCalls, JSON.stringify(result.blockers)).toBe(1);
    expect(result.executionStatus).toBe("blocked");
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(
      expect.arrayContaining([
        "KICAD_BACKEND_EXECUTION_FAILED",
        PCB_TRACE_WIDTH_ELECTRICAL_BASIS_MISSING
      ])
    );
    const planArtifact = result.artifacts.find(
      (artifact) => artifact.logicalName === "pcb/layout-routing-plan.json"
    );
    expect(planArtifact).toBeDefined();
    expect(planArtifact).toMatchObject({
      validationStatus: "not_run",
      unresolvedAssumptions: [
        expect.objectContaining({
          id: PCB_TRACE_WIDTH_ELECTRICAL_BASIS_MISSING,
          severity: "blocking"
        })
      ]
    });
    expect(JSON.parse(decode(planArtifact!.content))).toMatchObject({
      schemaVersion: "evleda.pcb-layout-plan.v2",
      electricalSizing: {
        status: "unresolved",
        blockerCode: PCB_TRACE_WIDTH_ELECTRICAL_BASIS_MISSING
      }
    });
  });
});
