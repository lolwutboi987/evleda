import type { ReferenceControllerProfile } from "../knowledge/reference-controller-v0.js";
import { canonicalIdentity } from "../core/canonical.js";
import {
  bringupPlanSchema,
  physicalAcceptanceContractSchema,
  type PhysicalAcceptanceContract,
  type PhysicalBringupPlan
} from "../contracts/operations.js";
import {
  PHYSICAL_ACCEPTANCE_POLICY_SCHEMA,
  REFERENCE_PHYSICAL_ACCEPTANCE_POLICY,
  physicalAcceptancePolicyMatchesProfile,
  type PhysicalAcceptancePolicy
} from "../knowledge/physical-acceptance-policy.js";
import type { StageExecutor } from "../workflow/contracts.js";
import {
  artifactDraft,
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

interface BringupStep {
  readonly id: string;
  readonly phase: number;
  readonly title: string;
  readonly preconditions: readonly string[];
  readonly procedure: readonly string[];
  readonly acceptance: readonly string[];
  readonly stopConditions: readonly string[];
  readonly evidence: readonly string[];
}

const bringupSteps = (profile: ReferenceControllerProfile): readonly BringupStep[] => [
  {
    id: "BU-01",
    phase: 1,
    title: "Identity, assembly, and unpowered inspection",
    preconditions: ["Board serial and assembly lot assigned", "Exact CAM/BOM/firmware identities available"],
    procedure: [`Verify board marking is ${profile.boardRevision}.`, "Inspect polarity, orientation, bridges, opens, solder, exposed pads, and connector keying.", "Measure resistance from VBAT_PROTECTED, 5V0, 3V3, and 5V_SENSOR to ground with the board unpowered."],
    acceptance: ["Assembly matches the exact BOM and drawings.", "No visible defect or unexplained low-resistance rail is present."],
    stopConditions: ["Wrong revision or substitution", "Visible assembly defect", "Rail resistance inconsistent with the reviewed expectation"],
    evidence: ["annotated photographs", "DMM model/calibration", "raw resistance measurements"]
  },
  {
    id: "BU-02",
    phase: 2,
    title: `Current-limited first power at ${(profile.inputVoltageMv.minimum / 1000).toString()} V`,
    preconditions: ["BU-01 passed", "Motors and external sensors disconnected", "SWD connected", "bench supply current limit set to reviewed low-energy value"],
    procedure: [`Apply ${(profile.inputVoltageMv.minimum / 1000).toString()} V with a current-limited bench supply.`, "Observe input current and thermal anomalies.", "Measure 5V0, 3V3, 5V_SENSOR, both motor outputs, motor nSLEEP, and CAN standby before firmware runs."],
    acceptance: ["5V0 is 4.75-5.25 V.", "3V3 is 3.201-3.399 V.", "5V_SENSOR is off.", "Both bridges are asleep and motor outputs are not energized.", "No unexpected heating or supply current escalation."],
    stopConditions: ["Current-limit entry", "Rail outside band", "Motor/sensor output energized", "odor, smoke, noise, or rapid temperature rise"],
    evidence: ["supply log", "rail measurements", "oscilloscope captures of startup", "thermal observations"]
  },
  {
    id: "BU-03",
    phase: 3,
    title: "SWD recovery, board identity, and safe firmware startup",
    preconditions: ["BU-02 passed", "Exact generated firmware scaffold identity recorded"],
    procedure: ["Connect under reset through SWD.", "Read device identity and program bring-up firmware.", `Verify BOARD_REV0/BOARD_REV1 resolve to ${profile.boardRevision}.`, "Reset repeatedly while monitoring all safe-control nets."],
    acceptance: ["SWD remains recoverable.", "Correct MCU and flash operation are observed.", "Firmware accepts the correct board revision and rejects an injected wrong-revision code.", "Motor/sensor enables remain safe through reset and debugger halt."],
    stopConditions: ["SWD unavailable", "Wrong MCU/revision", "Any enable glitch"],
    evidence: ["programmer log", "firmware digest", "reset waveforms", "board-revision raw ADC/code"]
  },
  {
    id: "BU-04",
    phase: 4,
    title: "Communications interfaces",
    preconditions: ["BU-03 passed", "Motor bridges remain disabled"],
    procedure: ["Enumerate USB device and exercise loopback/diagnostics.", "Exercise UART at 115200 8-N-1.", "Exercise CAN with known termination and analyzer at explicitly selected timing.", "Run I2C bus scan with a known fixture and SPI loopback/fixture test."],
    acceptance: ["USB, UART, CAN, I2C, and SPI tests pass without rail disturbance or unintended enables.", "CAN enters standby on reset and never drives dominant during reset."],
    stopConditions: ["Bus contention", "rail disturbance", "unexpected actuation", "ESD device or transceiver heating"],
    evidence: ["USB descriptors/log", "UART transcript", "CAN analyzer capture", "I2C/SPI traces", "protocol settings"]
  },
  {
    id: "BU-05",
    phase: 5,
    title: "Protected sensor power and encoder inputs",
    preconditions: ["BU-04 passed", "Known resistor loads and quadrature fixture available"],
    procedure: ["Enable 5V_SENSOR into a light known load and measure voltage/current.", "Increase load within the reviewed TPS2553-1 limit and inject a controlled short through a protected fixture.", "Drive both encoder A/B pairs across the intended rate range and verify direction/count/overflow."],
    acceptance: ["5V_SENSOR is off at reset, in band when enabled, and current-limits/faults as designed.", "Both buffered encoders count forward/reverse without unexplained transitions."],
    stopConditions: ["Switch or trace heating", "fault fails to assert", "sensor rail remains energized after fault", "encoder input exceeds 3.3 V domain"],
    evidence: ["load/current traces", "fault timing capture", "encoder fixture settings", "count/error logs"]
  },
  {
    id: "BU-06",
    phase: 6,
    title: "One-channel-at-a-time motor current regulation",
    preconditions: ["BU-05 passed", "Guarded electronic/inductive load", "current probe and oscilloscope", "mechanical motion prevented"],
    procedure: ["Exercise channel A at low duty before channel B.", "Verify direction, PWM, IPROPI scaling, nFAULT, and nSLEEP.", "Measure the 1.0 A chop target with tolerance and transient behavior.", "Repeat independently for channel B."],
    acceptance: ["No channel energizes without explicit request.", "Measured current-regulation behavior matches the approved tolerance model.", "Fault and disable paths de-energize both outputs as specified."],
    stopConditions: ["Current exceeds guarded limit", "current regulation absent", "unexpected cross-channel activation", "fault fails to latch safe"],
    evidence: ["PWM/current/IPROPI/VREF waveforms", "load parameters", "fault captures", "channel logs"]
  },
  {
    id: "BU-07",
    phase: 7,
    title: "Dual-channel RMS and thermal characterization",
    preconditions: ["BU-06 passed", "Reviewed thermal limits and instrument setup", "controlled ambient and airflow"],
    procedure: [`Operate both channels at ${(profile.motor.rmsCurrentMaPerChannel / 1000).toString()} A RMS under the declared duty profile.`, "Record driver, buck, LDO, switch, connector, copper, and ambient temperatures to steady state.", "Repeat at relevant input endpoints without exceeding prior limits."],
    acceptance: ["Temperatures and rails remain within approved derated limits for the full test duration.", "No protection cycling, reset, data corruption, or connector/copper damage occurs."],
    stopConditions: ["Any approved temperature/rail/current limit crossed", "thermal runaway", "protection cycling", "loss of control"],
    evidence: ["raw temperature time series", "thermal images", "ambient/airflow", "load and supply logs", "instrument identities/calibration"]
  },
  {
    id: "BU-08",
    phase: 8,
    title: "Reset, brownout, communications-loss, and injected-fault matrix",
    preconditions: ["BU-07 passed", "Guarded loads and independent cutoff available"],
    procedure: ["Inject bridge faults, sensor-power fault, watchdog reset, brownout, debugger halt, communications loss, and rapid reset.", "Verify safe outputs and latched diagnostics for every case.", "Power-cycle between cases and confirm recovery requires the documented explicit sequence."],
    acceptance: ["Every injected case reaches the hardware-biased safe state without unintended re-enable.", "Evidence records the exact waveform, firmware, board, and case verdict."],
    stopConditions: ["Any output remains or becomes energized unexpectedly", "fault cause lost", "automatic re-enable"],
    evidence: ["fault matrix", "waveforms", "event log", "operator and fixture identity"]
  },
  {
    id: "BU-09",
    phase: 9,
    title: "Maximum input endpoint and evidence closure",
    preconditions: ["BU-08 passed", `${(profile.inputVoltageMv.maximum / 1000).toString()} V source and protection fixture reviewed`],
    procedure: [`Repeat the approved rail, idle, communications, sensor, and guarded motor checks at ${(profile.inputVoltageMv.maximum / 1000).toString()} V.`, "Bind every raw file and verdict to board serial, assembly substitutions/lot, firmware, procedure, instruments, operator, and environment.", "Record open findings without waiver by the autonomous agent."],
    acceptance: ["All approved endpoint limits pass with complete raw evidence.", "Any qualification decision is made by a human hardware qualifier for this exact revision only."],
    stopConditions: ["Any prior limit crossed", "missing traceability field", "attempt to treat generated or modeled evidence as physical evidence"],
    evidence: ["complete evidence manifest", "signed human verdict if provided separately", "unresolved findings"]
  }
];

const bringupMarkdown = (
  profile: ReferenceControllerProfile,
  steps: readonly BringupStep[],
  policy: PhysicalAcceptancePolicy
): string => {
  const sections = steps.flatMap((step) => [
    `## ${step.id} — ${step.title}`,
    "",
    `Preconditions: ${step.preconditions.join("; ")}`,
    "",
    ...step.procedure.map((entry, index) => `${index + 1}. ${entry}`),
    "",
    `Acceptance: ${step.acceptance.join("; ")}`,
    "",
    `STOP: ${step.stopConditions.join("; ")}`,
    "",
    `Capture: ${step.evidence.join("; ")}`,
    ""
  ]);
  return [
    `# ${profile.boardRevision} bring-up plan`,
    "",
    "CANDIDATE — NOT QUALIFIED OR RELEASED",
    "",
    "This procedure is intentionally sequential and fail-closed. A failed or missing observation stops later energized testing. Generated checkboxes are not physical evidence.",
    "",
    `Physical acceptance policy: ${policy.schemaVersion}; ${policy.approvalStatus.toUpperCase()}.`,
    ...(policy.unresolvedItems.length === 0
      ? []
      : ["", `Unresolved policy items: ${policy.unresolvedItems.join("; ")}. No qualification-eligible acceptance contract is emitted until these are approved.`]),
    "",
    ...sections,
    "## Structured case matrix",
    "",
    ...policy.cases.flatMap((entry) => [
      `- ${entry.caseId}: step ${entry.procedureStepId}; endpoint ${entry.endpointId}; minimum duration ${entry.minimumDurationMs === null ? "UNAPPROVED" : `${entry.minimumDurationMs} ms`}; captures ${entry.captureRequirements.map((captureEntry) => captureEntry.captureRequirementId).join(", ")}.`
    ]),
    "",
    "## Qualification boundary",
    "",
    "Only a human hardware qualifier may evaluate the captured physical evidence for this exact board revision, serial, assembly, firmware, procedure, and conditions. Passing one board does not qualify arbitrary generated designs or authorize production.",
    ""
  ].join("\n");
};

const matrixCsv = (
  steps: readonly BringupStep[],
  policy: PhysicalAcceptancePolicy
): string => {
  const quote = (value: string | number): string => `"${String(value).replaceAll('"', '""')}"`;
  const phaseByStep = new Map(steps.map((step) => [step.id, step.phase]));
  return [
    "case_id,procedure_step_id,phase,endpoint_id,title,required_conditions,minimum_duration_ms,capture_requirements,status",
    ...policy.cases.map((entry) =>
      [
        entry.caseId,
        entry.procedureStepId,
        phaseByStep.get(entry.procedureStepId) ?? "UNKNOWN",
        entry.endpointId,
        entry.title,
        entry.requiredConditions.map((condition) => condition.conditionId).join(" | "),
        entry.minimumDurationMs ?? "UNAPPROVED",
        entry.captureRequirements.map((captureEntry) => `${captureEntry.captureRequirementId}:${captureEntry.kind}`).join(" | "),
        "NOT_RUN"
      ]
        .map(quote)
        .join(",")
    ),
    ""
  ].join("\n");
};

const acceptanceContractPayload = (
  profile: ReferenceControllerProfile,
  policy: PhysicalAcceptancePolicy
): unknown => ({
  schemaVersion: "evleda.physical-acceptance.v2",
  procedureSchemaVersion: "evleda.bringup-plan.v2",
  procedureId: policy.procedureId,
  profileId: profile.profileId,
  boardRevision: profile.boardRevision,
  lifecycle: "candidate",
  cases: policy.cases.map(({ title: _title, procedure: _procedure, minimumDurationMs, ...entry }) => ({
    ...entry,
    minimumDurationMs
  })),
  tests: policy.tests
});

export const physicalAcceptanceContract = (
  profile: ReferenceControllerProfile,
  policy: PhysicalAcceptancePolicy = REFERENCE_PHYSICAL_ACCEPTANCE_POLICY
): PhysicalAcceptanceContract => {
  const issues = physicalAcceptancePolicyIssues(profile, policy);
  if (issues.length > 0) {
    throw new Error(`Physical acceptance policy is not executable: ${issues.join("; ")}`);
  }
  return physicalAcceptanceContractSchema.parse(acceptanceContractPayload(profile, policy));
};

export const physicalBringupPlan = (
  profile: ReferenceControllerProfile,
  steps: readonly BringupStep[],
  policy: PhysicalAcceptancePolicy
): PhysicalBringupPlan => {
  const issues = physicalAcceptancePolicyIssues(profile, policy);
  if (issues.length > 0) {
    throw new Error(`Physical acceptance policy is not executable: ${issues.join("; ")}`);
  }
  return bringupPlanSchema.parse({
    schemaVersion: "evleda.bringup-plan.v2",
    procedureId: policy.procedureId,
    profileId: profile.profileId,
    boardRevision: profile.boardRevision,
    lifecycle: "candidate",
    defaultResult: "NOT_RUN",
    steps,
    cases: policy.cases,
    evidenceRequirements: [
      "exact design/CAM/BOM root",
      "exact target-build report and committed target BIN",
      "assembly substitutions, lot, and assembly operator",
      "board serial",
      "procedure and acceptance identities",
      "instruments and calibration",
      "measurement operators and environment",
      "case-bound conditions, durations, captures, observations, and server-derived verdict"
    ]
  });
};

export const physicalAcceptancePolicyIssues = (
  profile: ReferenceControllerProfile,
  policy: PhysicalAcceptancePolicy
): readonly string[] => {
  const issues: string[] = [];
  if (policy.schemaVersion !== PHYSICAL_ACCEPTANCE_POLICY_SCHEMA) issues.push("unsupported policy schema");
  if (!physicalAcceptancePolicyMatchesProfile(policy, profile)) issues.push("policy profile or board revision mismatch");
  if (policy.approvalStatus !== "approved") issues.push("policy approvalStatus is incomplete");
  if (policy.unresolvedItems.length > 0) issues.push(...policy.unresolvedItems.map((item) => `unresolved:${item}`));
  for (const entry of policy.cases) {
    if (entry.minimumDurationMs === null || !Number.isSafeInteger(entry.minimumDurationMs) || entry.minimumDurationMs <= 0) {
      issues.push(`unapproved-duration:${entry.caseId}`);
    }
  }
  for (const test of policy.tests) {
    if (test.kind === "numeric_range" && (test.minimum === null || test.maximum === null)) {
      issues.push(`unapproved-limit:${test.id}`);
    }
    if (test.kind === "expected_value" && test.expected === null) {
      issues.push(`unapproved-expected-value:${test.id}`);
    }
  }
  const hasUnapprovedValue = issues.some((issue) => issue.startsWith("unapproved-"));
  if (policy.approvalStatus === "approved" && policy.unresolvedItems.length === 0 && !hasUnapprovedValue) {
    const parsedContract = physicalAcceptanceContractSchema.safeParse(
      acceptanceContractPayload(profile, policy)
    );
    if (!parsedContract.success) {
      for (const issue of parsedContract.error.issues) {
        issues.push(`invalid-contract:${issue.path.join(".") || "root"}:${issue.message}`);
      }
    }
  }
  return [...new Set(issues)];
};

export const createBringupPackageStageExecutor = (
  acceptancePolicy: PhysicalAcceptancePolicy
): StageExecutor<"bringup_package"> => ({
  stage: "bringup_package",
  async execute(context) {
    const profile = profileFor(context);
    const policyIdentity = canonicalIdentity(acceptancePolicy, PHYSICAL_ACCEPTANCE_POLICY_SCHEMA);
    const exactInputs = stageExactInputs(context, [policyIdentity]);
    const policyIssues = physicalAcceptancePolicyIssues(profile, acceptancePolicy);
    const blockers = [
      ...prerequisiteBlockers("bringup_package", context),
      ...requirementsApprovalBlockers(context),
      ...referenceEnvelopeBlockers(context, profile),
      ...profileIntegrityBlockers(profile, exactInputs),
      ...(policyIssues.length === 0
        ? []
        : [
            blockerDraft(
              "BRINGUP_ACCEPTANCE_MATRIX_INCOMPLETE",
              `The physical acceptance policy is not approved and executable (${policyIssues.length} issue(s)): ${policyIssues.slice(0, 12).join(", ")}${policyIssues.length > 12 ? ", ..." : ""}.`,
              exactInputs,
              "Supply a source-bound, human-reviewed physical acceptance policy with every required case, positive duration, condition, capture, and limit approved."
            )
          ])
    ];
    const status = blockers.length === 0 ? "pass" : "fail";
    const steps = bringupSteps(profile);
    const structuredArtifacts = policyIssues.length === 0
      ? (() => {
          const planValue = physicalBringupPlan(profile, steps, acceptancePolicy);
          const plan = jsonArtifactDraft({
            logicalName: "bringup/bringup-plan.json",
            value: planValue,
            exactInputs,
            validationStatus: status
          });
          return [
            plan,
            jsonArtifactDraft({
              logicalName: "bringup/physical-acceptance.json",
              value: physicalAcceptanceContract(profile, acceptancePolicy),
              exactInputs,
              derivedFrom: [plan.logicalName],
              validationStatus: status
            })
          ];
        })()
      : [];
    const structuredPlan = structuredArtifacts.find((artifact) => artifact.logicalName === "bringup/bringup-plan.json");
    const artifacts = [
      ...structuredArtifacts,
      artifactDraft({
        logicalName: "bringup/bringup-plan.md",
        mediaType: "text/markdown",
        content: bringupMarkdown(profile, steps, acceptancePolicy),
        exactInputs,
        derivedFrom: structuredPlan === undefined ? [] : [structuredPlan.logicalName],
        validationStatus: status
      }),
      artifactDraft({
        logicalName: "bringup/test-matrix.csv",
        mediaType: "text/csv",
        content: matrixCsv(steps, acceptancePolicy),
        exactInputs,
        derivedFrom: structuredPlan === undefined ? [] : [structuredPlan.logicalName],
        validationStatus: status
      })
    ];
    const evidence = [
      evidenceDraft({
        evidenceClass: "evleda_check",
        claim:
          status === "pass"
            ? "The generated bring-up package covers unpowered inspection, rails, programming, communications, sensors, encoders, motors, thermal operation, and fault/reset paths."
            : policyIssues.length > 0
              ? "Bring-up package generation is blocked because the physical acceptance matrix lacks approved limits or durations."
              : "Bring-up package generation is blocked by incomplete upstream design evidence.",
        subjectDigests: artifacts.map((artifact) => artifact.identity.digest),
        ...(structuredPlan === undefined ? {} : { parsedArtifactLogicalName: structuredPlan.logicalName }),
        exactInputs,
        validationStatus: status
      }),
      evidenceDraft({
        evidenceClass: "agent_claim",
        claim: "All physical procedures and measurements are NOT_RUN; this generated plan is not human_physical evidence.",
        subjectDigests: artifacts.map((artifact) => artifact.identity.digest),
        exactInputs,
        validationStatus: "not_run"
      })
    ];
    return finalizeStageResult("bringup_package", artifacts, evidence, blockers);
  }
});

export const bringupPackageStageExecutor = createBringupPackageStageExecutor(
  REFERENCE_PHYSICAL_ACCEPTANCE_POLICY
);
