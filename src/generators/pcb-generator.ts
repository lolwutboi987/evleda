import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import {
  ENGINEERING_CONSTRAINT_BINDING_SCHEMA,
  ENGINEERING_CONSTRAINT_SET_SCHEMA,
  validateAndSnapshotEngineeringConstraintBinding,
  type EngineeringConstraintBinding,
} from "../engineering/constraint-compiler.js";
import { PCB_ENGINEERING_PRACTICE_CATALOG } from "../knowledge/pcb-engineering-practices.js";
import type { ReferenceControllerProfile } from "../knowledge/reference-controller-v0.js";
import {
  PCB_PRACTICE_ANALYZER_SUPPORTED_BOARD_VERSIONS,
  PCB_PRACTICE_ANALYSIS_PROFILE_SCHEMA,
  type PcbPracticeAnalysisProfile,
} from "../integrations/pcb-practice-analyzer.js";
import type {
  CandidateStageContext,
  KicadPcbEngineeringRequest,
  StageExecutor,
} from "../workflow/contracts.js";
import { runKicadBackend } from "./backend-runner.js";
import {
  blockerDraft,
  evidenceDraft,
  finalizeStageResult,
  jsonArtifactDraft,
  prerequisiteBlockers,
  profileFor,
  profileIntegrityBlockers,
  referenceEnvelopeBlockers,
  requirementsApprovalBlockers,
  stageExactInputs
} from "./draft-utils.js";
import {
  PCB_LAYOUT_QUALITY_POLICY,
  PCB_ROUTE_QUALITY_RULE_DECK,
  PCB_TRACE_WIDTH_ELECTRICAL_BASIS_MISSING,
  REV_A_PROOF_FIXTURE_POLICY,
  buildPcbLayoutPlan,
  pcbLayoutPlanExactPolicyInputs,
  planValidationStatus,
  resolvePcbElectricalSizingEvidence
} from "./pcb-layout-plan.js";

type PcbLayoutPlan = ReturnType<typeof buildPcbLayoutPlan>;

const internalCopperLayerName = (layer: string): string => {
  const match = /^In(\d+)\./u.exec(layer);
  return match === null ? layer : `In${match[1]}.Cu`;
};

const netClassMinimum = (
  plan: PcbLayoutPlan,
  id: "BatteryInput" | "MotorPower",
): number => {
  const entry = plan.netClasses.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`PCB layout plan is missing net class ${id}.`);
  return Math.max(
    entry.nativeConfiguredMinimum.minimumTrackWidthMm,
    entry.effectiveDesignMinimumTrackWidthMm ?? 0,
  );
};

export const buildPcbPracticeAnalysisProfile = (
  profile: ReferenceControllerProfile,
  plan: PcbLayoutPlan,
): PcbPracticeAnalysisProfile => {
  const copperLayerOrder = profile.stackup.layers.map(internalCopperLayerName);
  const interiorAngleDisposition = {
    sourceRuleId: plan.routeQualityPolicy.routeStyle.ruleId,
    severity: "error" as const,
  };
  const traceToBoardEdgeDisposition = {
    sourceRuleId: "evleda.rev-a.native-drc.copper-to-board-edge",
    severity: "error" as const,
  };
  const netClass = (
    id: string,
    minimumTrackWidthMm: number,
    sourceRuleId: string,
  ) => ({
    id,
    sourceRuleId,
    severity: "error" as const,
    minimumTrackWidthMm,
    minimumInteriorAngleDeg:
      180 - plan.routeQualityPolicy.routeStyle.maximumUnsignedDirectionChangeDeg,
    interiorAngleDisposition,
    minimumTraceToBoardEdgeMm: 0.25,
    traceToBoardEdgeDisposition,
  });
  return {
    schemaVersion: PCB_PRACTICE_ANALYSIS_PROFILE_SCHEMA,
    sourceValidation: {
      mode: "production",
      supportedBoardVersions: [...PCB_PRACTICE_ANALYZER_SUPPORTED_BOARD_VERSIONS],
    },
    copperLayerOrder,
    netClasses: [
      netClass("Default", 0.2, "evleda.rev-a.native-drc.minimum-routed-width"),
      netClass(
        "BatteryInput",
        netClassMinimum(plan, "BatteryInput"),
        "evleda.rev-a.native-drc.battery-input-copper",
      ),
      netClass("FiveVolt", 0.4, "evleda.rev-a.native-drc.five-volt-copper"),
      netClass(
        "MotorPower",
        netClassMinimum(plan, "MotorPower"),
        "evleda.rev-a.native-drc.motor-and-vm-copper",
      ),
      netClass("SwitchNode", 0.5, "evleda.rev-a.native-drc.switch-node-copper"),
    ],
    netClassByNet: {
      "+5V": "FiveVolt",
      "+5V_SENSOR": "FiveVolt",
      M1_OUT1: "MotorPower",
      M1_OUT2: "MotorPower",
      M2_OUT1: "MotorPower",
      M2_OUT2: "MotorPower",
      SW_5V: "SwitchNode",
      VBAT_FUSED: "BatteryInput",
      VBAT_RAW: "BatteryInput",
      VM: "MotorPower",
    },
    defaultNetClassId: "Default",
    viaRules: [
      {
        id: "rev-a-through-via",
        sourceRuleId: "evleda.rev-a.native-drc.through-via-geometry",
        severity: "error",
        gates: ["fabricator-confirmation"],
        appliesTo: { viaTypes: ["through"] },
        minimumPadDiameterMm: 0.45,
        minimumDrillDiameterMm: 0.2,
        minimumAnnularRingMm: 0.125,
        allowedLayerTransitions: [
          { startLayer: copperLayerOrder[0]!, endLayer: copperLayerOrder.at(-1)! },
        ],
      },
      {
        id: "rev-a-microvia",
        sourceRuleId: "pcb.interconnect.drill-ring-aspect-and-microvia",
        severity: "error",
        gates: ["fabricator-confirmation", "human-review"],
        appliesTo: { viaTypes: ["micro"] },
        minimumPadDiameterMm: 0.26,
        minimumDrillDiameterMm: 0.1,
        minimumAnnularRingMm: 0.08,
        allowedLayerTransitions: [
          { startLayer: copperLayerOrder[0]!, endLayer: copperLayerOrder[1]! },
          {
            startLayer: copperLayerOrder.at(-2)!,
            endLayer: copperLayerOrder.at(-1)!,
          },
        ],
      },
    ],
    advisories: {
      rightAngle: {
        sourceRuleId: plan.routeQualityPolicy.routeStyle.ruleId,
        toleranceDeg: plan.routeQualityPolicy.routeStyle.angularComparisonToleranceDeg,
      },
      reversal: {
        sourceRuleId: plan.routeQualityPolicy.backtrack.ruleId,
        maximumInteriorAngleDeg:
          plan.routeQualityPolicy.routeStyle.angularComparisonToleranceDeg,
      },
      adjacentHairpin: {
        sourceRuleId: plan.routeQualityPolicy.backtrack.ruleId,
        parallelToleranceDeg:
          plan.routeQualityPolicy.routeStyle.angularComparisonToleranceDeg,
        maximumLegEdgeGapMm: 0.2,
        minimumParallelOverlapMm: 1,
        maximumConnectorPathLengthMm: 0.6,
      },
    },
    diagnostics: {
      invalidGeometrySourceRuleId: "evleda.pcb.phase1.native-geometry-validity",
      unboundNetSourceRuleId: "evleda.pcb.phase1.net-class-binding-required",
      unsupportedOutlineSourceRuleId: "evleda.pcb.phase1.outline-coverage-required",
      unsupportedRoutingSourceRuleId: plan.routeQualityPolicy.routeStyle.ruleId,
      junctionCoverageSourceRuleId: plan.routeQualityPolicy.routeStyle.ruleId,
      containmentSourceRuleId: "evleda.pcb.phase1.board-containment-required",
      duplicateTrackSourceRuleId: plan.routeQualityPolicy.backtrack.ruleId,
    },
    coordinateToleranceMm: 1e-6,
  };
};

interface CompiledConstraintResolution {
  readonly binding: EngineeringConstraintBinding | null;
  readonly error: string | null;
}

const availableCompiledConstraintSet = (
  context: CandidateStageContext,
): CompiledConstraintResolution => {
  const candidates: EngineeringConstraintBinding[] = [];
  for (const artifact of context.upstream.flatMap((result) => result.artifacts)) {
    const claimsConstraintBinding =
      /(?:^|\/)(?:engineering[-_])?constraint[-_]binding\.json$/iu.test(
        artifact.logicalName,
      );
    const claimsStandaloneConstraintSet =
      /(?:^|\/)(?:engineering[-_])?constraint[-_]set\.json$/iu.test(
        artifact.logicalName,
      );
    if (artifact.mediaType !== "application/json" || artifact.content.byteLength > 4_194_304) {
      if (claimsConstraintBinding || claimsStandaloneConstraintSet) {
        return {
          binding: null,
          error: "A claimed engineering constraint artifact has the wrong media type or exceeds the bounded parser size.",
        };
      }
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(artifact.content));
    } catch {
      if (claimsConstraintBinding || claimsStandaloneConstraintSet) {
        return {
          binding: null,
          error: "A claimed engineering constraint artifact is not valid UTF-8 JSON.",
        };
      }
      continue;
    }
    const schemaVersion =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Readonly<Record<string, unknown>>).schemaVersion
        : undefined;
    if (schemaVersion === ENGINEERING_CONSTRAINT_SET_SCHEMA || claimsStandaloneConstraintSet) {
      return {
        binding: null,
        error:
          "A standalone self-hashed engineering constraint set is not authoritative; supply its full catalog/context/checker-evidence compilation binding.",
      };
    }
    if (schemaVersion !== ENGINEERING_CONSTRAINT_BINDING_SCHEMA) {
      if (claimsConstraintBinding) {
        return {
          binding: null,
          error: "A claimed engineering constraint binding does not carry the required closed schema.",
        };
      }
      continue;
    }
    try {
      const trusted = validateAndSnapshotEngineeringConstraintBinding(parsed);
      if (
        canonicalJson(trusted.catalogIdentity) !==
          canonicalJson(PCB_ENGINEERING_PRACTICE_CATALOG.identity) ||
        canonicalJson(contentIdentity(artifact.content)) !== canonicalJson(artifact.identity) ||
        !artifact.exactInputs.some(
          (identity) =>
            canonicalJson(identity) === canonicalJson(PCB_ENGINEERING_PRACTICE_CATALOG.identity),
        ) ||
        artifact.validationStatus !== "pass"
      ) {
        return {
          binding: null,
          error: "An upstream engineering constraint binding is stale, non-passing, or detached from its exact artifact and practice catalog.",
        };
      }
      candidates.push(trusted);
    } catch {
      return {
        binding: null,
        error: "An upstream artifact claims the engineering constraint-binding schema but fails strict recompile validation.",
      };
    }
  }
  const byIdentity = new Map(candidates.map((candidate) => [candidate.identity.digest, candidate]));
  if (byIdentity.size > 1) {
    return {
      binding: null,
      error: "Multiple distinct engineering constraint bindings are available for one PCB stage attempt.",
    };
  }
  const document = [...byIdentity.values()][0];
  return document === undefined
    ? { binding: null, error: null }
    : {
        binding: document,
        error: null,
      };
};

export const pcbPlacementRoutingStageExecutor: StageExecutor<"pcb_placement_routing"> = {
  stage: "pcb_placement_routing",
  async execute(context) {
    const profile = profileFor(context);
    const simulationResult = context.upstream.find((result) => result.stage === "simulation_checks");
    const sizing = resolvePcbElectricalSizingEvidence(
      profile,
      simulationResult === undefined
        ? undefined
        : { artifacts: simulationResult.artifacts, evidence: simulationResult.evidence }
    );
    const planValue = buildPcbLayoutPlan(profile, sizing);
    const planInputs = stageExactInputs(context, pcbLayoutPlanExactPolicyInputs(sizing));
    const plan = jsonArtifactDraft({
      logicalName: "pcb/layout-routing-plan.json",
      value: planValue,
      exactInputs: planInputs,
      validationStatus: planValidationStatus(sizing),
      unresolvedAssumptions:
        sizing.status === "unresolved"
          ? [
              {
                id: PCB_TRACE_WIDTH_ELECTRICAL_BASIS_MISSING,
                statement:
                  "Source-bound ampacity, hot voltage-drop, I-squared-R, and temperature-rise evidence is missing for the high-current PCB paths.",
                severity: "blocking",
                sourceRequirementIds: context.requirements.requirements
                  .filter(
                    (requirement) =>
                      requirement.category === "power" || requirement.category === "actuator"
                  )
                  .map((requirement) => requirement.id)
              }
            ]
          : []
    });
    const analysisProfile = buildPcbPracticeAnalysisProfile(profile, planValue);
    const analysisProfileIdentity = canonicalIdentity(
      analysisProfile,
      analysisProfile.schemaVersion,
    );
    const compiledConstraint = availableCompiledConstraintSet(context);
    const analyzerProfileArtifact = jsonArtifactDraft({
      logicalName: "pcb/engineering/analyzer-profile.json",
      value: analysisProfile,
      exactInputs: [analysisProfileIdentity, plan.identity],
      validationStatus: "pass",
    });
    const practiceCatalogArtifact = jsonArtifactDraft({
      logicalName: "pcb/engineering/practice-catalog.json",
      value: PCB_ENGINEERING_PRACTICE_CATALOG,
      exactInputs: [PCB_ENGINEERING_PRACTICE_CATALOG.identity],
      validationStatus: "pass",
    });
    const routeQualityPolicyArtifact = jsonArtifactDraft({
      logicalName: "pcb/engineering/route-quality-policy.json",
      value: PCB_LAYOUT_QUALITY_POLICY,
      exactInputs: [
        PCB_LAYOUT_QUALITY_POLICY.identity,
        PCB_LAYOUT_QUALITY_POLICY.captureIdentity,
      ],
      validationStatus: "pass",
    });
    const routeQualityRuleDeckArtifact = jsonArtifactDraft({
      logicalName: "pcb/engineering/route-quality-rule-deck.json",
      value: PCB_ROUTE_QUALITY_RULE_DECK,
      exactInputs: [PCB_ROUTE_QUALITY_RULE_DECK.identity],
      validationStatus: "pass",
    });
    const proofFixturePolicyArtifact = jsonArtifactDraft({
      logicalName: "pcb/engineering/proof-fixture-policy.json",
      value: REV_A_PROOF_FIXTURE_POLICY,
      exactInputs: [REV_A_PROOF_FIXTURE_POLICY.identity],
      validationStatus: "pass",
    });
    const constraintBindingArtifact = compiledConstraint.binding === null
      ? null
      : jsonArtifactDraft({
          logicalName: "pcb/engineering/constraint-binding.json",
          value: compiledConstraint.binding,
          exactInputs: [
            compiledConstraint.binding.identity,
            compiledConstraint.binding.compiledConstraintSetIdentity,
          ],
          validationStatus: "pass",
        });
    const engineeringSnapshotArtifacts = [
      analyzerProfileArtifact,
      practiceCatalogArtifact,
      routeQualityPolicyArtifact,
      routeQualityRuleDeckArtifact,
      proofFixturePolicyArtifact,
      ...(constraintBindingArtifact === null ? [] : [constraintBindingArtifact]),
    ];
    // The plan identity is part of the backend source digest without creating a
    // circular self-identity in the plan artifact's own exact-input list.
    const exactInputs = stageExactInputs(context, [
      ...pcbLayoutPlanExactPolicyInputs(sizing),
      plan.identity,
      analysisProfileIdentity,
      ...engineeringSnapshotArtifacts.map((artifact) => artifact.identity),
      ...(compiledConstraint.binding === null
        ? []
        : [
            compiledConstraint.binding.identity,
            compiledConstraint.binding.compiledConstraintSetIdentity,
          ]),
    ]);
    const pcbEngineering: KicadPcbEngineeringRequest = {
      layoutPlan: {
        logicalName: plan.logicalName,
        document: planValue,
        contentIdentity: plan.identity,
      },
      analyzerProfile: {
        logicalName: analyzerProfileArtifact.logicalName,
        document: analysisProfile,
        contentIdentity: analyzerProfileArtifact.identity,
        canonicalIdentity: analysisProfileIdentity,
      },
      practiceCatalog: {
        logicalName: practiceCatalogArtifact.logicalName,
        document: PCB_ENGINEERING_PRACTICE_CATALOG,
        contentIdentity: practiceCatalogArtifact.identity,
        canonicalIdentity: PCB_ENGINEERING_PRACTICE_CATALOG.identity,
      },
      routeQualityPolicy: {
        logicalName: routeQualityPolicyArtifact.logicalName,
        document: PCB_LAYOUT_QUALITY_POLICY as unknown as Readonly<Record<string, unknown>>,
        contentIdentity: routeQualityPolicyArtifact.identity,
        canonicalIdentity: PCB_LAYOUT_QUALITY_POLICY.identity,
        captureIdentity: PCB_LAYOUT_QUALITY_POLICY.captureIdentity,
      },
      routeQualityRuleDeck: {
        logicalName: routeQualityRuleDeckArtifact.logicalName,
        document: PCB_ROUTE_QUALITY_RULE_DECK as unknown as Readonly<Record<string, unknown>>,
        contentIdentity: routeQualityRuleDeckArtifact.identity,
        canonicalIdentity: PCB_ROUTE_QUALITY_RULE_DECK.identity,
      },
      proofFixturePolicy: {
        logicalName: proofFixturePolicyArtifact.logicalName,
        document: REV_A_PROOF_FIXTURE_POLICY as unknown as Readonly<Record<string, unknown>>,
        contentIdentity: proofFixturePolicyArtifact.identity,
        canonicalIdentity: REV_A_PROOF_FIXTURE_POLICY.identity,
      },
      engineeringConstraintBinding:
        compiledConstraint.binding === null || constraintBindingArtifact === null
          ? null
          : {
              logicalName: constraintBindingArtifact.logicalName,
              document: compiledConstraint.binding,
              contentIdentity: constraintBindingArtifact.identity,
              canonicalIdentity: compiledConstraint.binding.identity,
            },
    };
    const initialBlockers = [
      ...prerequisiteBlockers("pcb_placement_routing", context),
      ...requirementsApprovalBlockers(context),
      ...referenceEnvelopeBlockers(context, profile),
      ...profileIntegrityBlockers(profile, exactInputs),
      ...(compiledConstraint.error === null
        ? []
        : [
            blockerDraft(
              "PCB_ENGINEERING_CONSTRAINT_SET_INVALID",
              compiledConstraint.error,
              exactInputs,
              "Regenerate exactly one strict engineering constraint binding containing the current catalog snapshot, closed context, checker evidence, and recompiled set, or remove the invalid claim before retrying.",
              false,
            ),
          ]),
    ];
    const initialEvidence = [
      evidenceDraft({
        evidenceClass: "agent_claim",
        claim:
          "The v2 placement/routing plan is diagnostic candidate intent; it is not a KiCad board, electrical sizing result, practice-check pass, or manufacturing release.",
        subjectDigests: [plan.identity.digest],
        parsedArtifactLogicalName: plan.logicalName,
        exactInputs: planInputs,
        validationStatus: "not_run",
        unresolvedAssumptions: plan.unresolvedAssumptions
      })
    ];
    const backend = await runKicadBackend({
      stage: "pcb_placement_routing",
      context,
      profile,
      exactInputs,
      initialArtifacts: [plan, ...engineeringSnapshotArtifacts],
      initialEvidence,
      initialBlockers,
      requiredArtifactRoles: ["pcb", "render"],
      requiredReports: [
        "drc",
        "schematic_parity",
        "connectivity",
        "geometry",
        "pcb_practices",
      ],
      pcbEngineering,
    });
    const blockers = [...backend.blockers];
    // Missing electrical sizing blocks stage success, but it is appended only
    // after bounded native/derived diagnostics have had a chance to run.
    if (sizing.status === "unresolved") {
      blockers.push(
        blockerDraft(
          PCB_TRACE_WIDTH_ELECTRICAL_BASIS_MISSING,
          "High-current trace widths have no accepted source-bound ampacity, voltage-drop, and thermal basis. The observed 0.80 mm battery and 0.30 mm motor KiCad rules are configuration minima only.",
          exactInputs,
          `Produce one passing ${planValue.electricalSizing.acceptedArtifactSchema} artifact at ${planValue.electricalSizing.acceptedArtifactLogicalName}, with all required inputs and exact EvlEDA-check evidence bindings, then rerun this stage.`
        )
      );
    }
    return finalizeStageResult(
      "pcb_placement_routing",
      backend.artifacts,
      backend.evidence,
      blockers
    );
  }
};
