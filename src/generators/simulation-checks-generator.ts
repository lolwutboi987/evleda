import type { ReferenceControllerProfile } from "../knowledge/reference-controller-v0.js";
import type { SimulationCoverageItem, StageExecutor } from "../workflow/contracts.js";
import { runSimulationBackend } from "./backend-runner.js";
import {
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

export const REQUIRED_SIMULATION_COVERAGE: readonly SimulationCoverageItem[] = [
  "power_tree_operating_points",
  "logic_rail_load_budget",
  "motor_current_chop",
  "motor_driver_thermal",
  "fault_and_reset"
];

const coveragePlan = (profile: ReferenceControllerProfile) => ({
  schemaVersion: "evleda.simulation-coverage-plan.v1",
  profileId: profile.profileId,
  boardRevision: profile.boardRevision,
  lifecycle: "candidate",
  requiredCoverage: [
    {
      item: "power_tree_operating_points",
      method: `Captured DC/transient model across ${(profile.inputVoltageMv.minimum / 1000).toString()} V and ${(profile.inputVoltageMv.maximum / 1000).toString()} V input plus declared rail loads.`,
      acceptance: "5V0 and 3V3 remain inside the contract bands; no modeled stress exceeds source-bound ratings.",
      physicalGap: "Bench startup, ripple, load-step, hot-plug, and protection behavior remain required."
    },
    {
      item: "logic_rail_load_budget",
      method: "Worst-case arithmetic/model check using explicit MCU, CAN, buffers, and expansion current assumptions.",
      acceptance: "Both 5V0 and 3V3 preserve at least 20% declared current headroom under the modeled case.",
      physicalGap: "Real firmware modes and attached peripherals must be measured."
    },
    {
      item: "motor_current_chop",
      method: "Static comparator/trip-threshold calculation across DRV8874 IPROPI scaling, 5.49 kohm resistor, 2.5 V VREF, and documented device/resistor/VREF tolerance extrema.",
      acceptance: "The static nominal 1 A trip threshold and calculated tolerance extrema are explicitly reported; no dynamic chop-waveform claim is made.",
      unsupported: "Current ripple, PWM transient response, and a real motor current waveform are unsupported without exact motor R/L/back-EMF and supply-impedance models.",
      physicalGap: "Dynamic chop behavior remains physical-only and requires guarded-load oscilloscope/current-probe verification with the actual motor and supply."
    },
    {
      item: "motor_driver_thermal",
      method: `Power-loss and board thermal model at ${(profile.motor.rmsCurrentMaPerChannel / 1000).toString()} A RMS/channel with both bridges operating.`,
      acceptance: "Junction estimate retains documented margin under declared ambient, copper, airflow, and duty assumptions.",
      physicalGap: "Thermocouple/thermal-camera measurements on an assembled board remain mandatory."
    },
    {
      item: "fault_and_reset",
      method: "Modeled/logical transition checks for reset, brownout, bridge fault, sensor fault, watchdog, and communications loss.",
      acceptance: "Motor nSLEEP/PWM and sensor enable never enter an energized state before explicit post-validation enable.",
      physicalGap: "Real power sequencing and injected-fault tests remain mandatory."
    }
  ],
  evidencePolicy: [
    "Every report binds the exact source revision and exact model identity.",
    "Missing, failed, stale, unsupported, warning-only, or not-run coverage blocks PCB work.",
    "A modeled pass is EvlEDA-check evidence, never human/physical qualification."
  ]
});

export const simulationChecksStageExecutor: StageExecutor<"simulation_checks"> = {
  stage: "simulation_checks",
  async execute(context) {
    const profile = profileFor(context);
    const exactInputs = stageExactInputs(context);
    const initialBlockers = [
      ...prerequisiteBlockers("simulation_checks", context),
      ...requirementsApprovalBlockers(context),
      ...referenceEnvelopeBlockers(context, profile),
      ...profileIntegrityBlockers(profile, exactInputs)
    ];
    const plan = jsonArtifactDraft({
      logicalName: "simulation/coverage-plan.json",
      value: coveragePlan(profile),
      exactInputs,
      validationStatus: "not_run"
    });
    const initialEvidence = [
      evidenceDraft({
        evidenceClass: "agent_claim",
        claim: "This artifact defines required model coverage; it is not itself simulation evidence.",
        subjectDigests: [plan.identity.digest],
        parsedArtifactLogicalName: plan.logicalName,
        exactInputs,
        validationStatus: "not_run"
      })
    ];
    const backend = await runSimulationBackend({
      stage: "simulation_checks",
      context,
      profile,
      exactInputs,
      initialArtifacts: [plan],
      initialEvidence,
      initialBlockers,
      requiredCoverage: REQUIRED_SIMULATION_COVERAGE
    });
    return finalizeStageResult(
      "simulation_checks",
      backend.artifacts,
      backend.evidence,
      backend.blockers
    );
  }
};
