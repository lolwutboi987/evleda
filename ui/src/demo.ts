import type {
  ArtifactRecord,
  BenchSnapshot,
  CanonicalIdentity,
  ContentIdentity,
  DesignRun,
  EvidenceRecord,
  Requirement,
  RequirementsDocument,
  StageAttempt,
  StageKey,
  UnresolvedAssumption
} from "./model";
import { STAGE_ORDER } from "./model";

export const DEMO_PROMPT =
  "Design a 7–16.8 V low-voltage robotics controller with 2 motor channels for brushed-DC loads at 0.5 A RMS each, USB-C, CAN, two quadrature encoders, SWD, reverse-polarity protection, and a guarded hardware disable. Keep the PCB under 100 × 80 mm.";

const DIGEST_A = "f4340ed12b69dc6b33aa1f57b76e26fc18d5372aecc8a91e631ca2c749fe4b2a";
const DIGEST_B = "8cb7f8cf0f4c73ae88dc893d76327b80bd1eb9a32dc897ed55de2f95326454df";
const DIGEST_C = "2a31b12239e05de41b49acd2f757a021c9f8e92dd14ad27346a737f24a1fdf70";

const content = (digest: string, size = 4096): ContentIdentity => ({
  algorithm: "sha256",
  digest,
  size
});

const canonical = (digest: string, schemaVersion: string): CanonicalIdentity => ({
  algorithm: "sha256",
  digest,
  schemaVersion,
  canonicalizationVersion: "evleda-c14n-json-v1"
});

const requirement = (
  id: string,
  statement: string,
  category: string,
  hazardClass: string,
  normalizedValue: string,
  verificationMethod: string,
  acceptanceCriteria: string
): Requirement => ({
  id,
  statement,
  category,
  priority: "must",
  hazardClass,
  normalizedValue,
  verificationMethod,
  acceptanceCriteria
});

const parseDemoRequirements = (
  prompt: string,
  approved: boolean
): RequirementsDocument => {
  const assumptions: UnresolvedAssumption[] = [];
  const requirements: Requirement[] = [];
  const voltage = /(?<min>\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(?<max>\d+(?:\.\d+)?)\s*v/iu.exec(prompt);
  const channels = /(?<count>\d+)\s*(?:x|×|-)?\s*(?:brushed[- ]dc\s*)?(?:motor\s*)?channels?/iu.exec(
    prompt
  );
  const current = /(?<amps>\d+(?:\.\d+)?)\s*a\s*(?:rms|continuous)/iu.exec(prompt);

  if (voltage?.groups?.min && voltage.groups.max) {
    requirements.push(
      requirement(
        "req-power-envelope",
        `Operate from ${voltage.groups.min}–${voltage.groups.max} V DC input.`,
        "power",
        "electrical",
        `${voltage.groups.min}:${voltage.groups.max}:VDC`,
        "Power-tree review and current-limited rail bring-up",
        "All regulated rails remain within declared tolerance across the input range."
      )
    );
  } else {
    assumptions.push({
      id: "demo-missing-voltage",
      statement: "The demo parser could not find an explicit DC input voltage range.",
      severity: "blocking",
      sourceRequirementIds: []
    });
  }

  if (channels?.groups?.count) {
    requirements.push(
      requirement(
        "req-motor-count",
        `Provide ${channels.groups.count} independently disabled brushed-DC motor channels.`,
        "actuator",
        "thermal",
        `${channels.groups.count}:channels`,
        "Schematic connectivity review and guarded-load bench test",
        "Every channel exposes control, fault, current return, and safe-disable paths."
      )
    );
  } else {
    assumptions.push({
      id: "demo-missing-channel-count",
      statement: "The demo parser could not find an explicit motor-channel count.",
      severity: "blocking",
      sourceRequirementIds: []
    });
  }

  if (current?.groups?.amps) {
    requirements.push(
      requirement(
        "req-motor-current",
        `Support ${current.groups.amps} A RMS per motor channel.`,
        "actuator",
        "thermal",
        `${current.groups.amps}:A:RMS:per_channel`,
        "Electrical-limit calculation, thermal model, and guarded-load measurement",
        "Continuous current and temperature rise remain within the qualified component limits."
      )
    );
  } else {
    assumptions.push({
      id: "demo-missing-motor-current",
      statement: "The demo parser could not find an explicit RMS or continuous motor current.",
      severity: "blocking",
      sourceRequirementIds: []
    });
  }

  const interfaces = ["USB-C", "CAN", "quadrature encoder", "SWD"] as const;
  for (const label of interfaces) {
    if (prompt.toLocaleLowerCase("en-US").includes(label.toLocaleLowerCase("en-US"))) {
      requirements.push(
        requirement(
          `req-${label.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/gu, "-")}`,
          `Provide ${label} connectivity with a declared voltage domain and safe state.`,
          label.includes("encoder") ? "sensor" : "communication",
          "functional",
          label,
          "KiCad connectivity comparison and generated firmware-contract test",
          `${label} ownership, polarity, voltage domain, and reset behavior agree across artifacts.`
        )
      );
    }
  }

  const base = {
    schemaVersion: "evleda.requirements.v1",
    identity: canonical(DIGEST_A, "evleda.requirements.v1"),
    sourcePrompt: content(DIGEST_B, prompt.length),
    requirements,
    constraints: {
      reference_profile: "robotics-controller-v0",
      maximum_input_voltage_mv: "30000",
      maximum_total_current_ma: "5000"
    },
    exclusions: [
      "No mains connection",
      "No battery charging or battery protection",
      "No safety-rated or human-carrying control function",
      "No autonomous manufacturing release"
    ],
    unresolvedAssumptions: assumptions
  } satisfies Omit<RequirementsDocument, "approvalId">;

  return approved ? { ...base, approvalId: "approval_demo_requirements_01" } : base;
};

const pendingAttempt = (stage: StageKey): StageAttempt => ({
  id: `attempt-demo-${stage}-01`,
  stage,
  attemptNumber: 1,
  state: "pending",
  artifactIds: [],
  evidenceIds: [],
  blockers: []
});

const blockedAttempts = (): DesignRun["attempts"] => {
  const attempts: Partial<Record<StageKey, readonly StageAttempt[]>> = {};
  for (const stage of STAGE_ORDER) attempts[stage] = [pendingAttempt(stage)];
  attempts.requirements = [
    {
      ...pendingAttempt("requirements"),
      state: "succeeded",
      artifactIds: ["artifact-demo-requirements"],
      evidenceIds: ["evidence-demo-parse", "evidence-demo-envelope"],
      startedAt: "2026-09-03T16:21:04.000Z",
      completedAt: "2026-09-03T16:21:05.000Z"
    }
  ];
  attempts.system_architecture = [
    {
      ...pendingAttempt("system_architecture"),
      state: "succeeded",
      artifactIds: ["artifact-demo-architecture"],
      evidenceIds: ["evidence-demo-budget"],
      startedAt: "2026-09-03T16:21:07.000Z",
      completedAt: "2026-09-03T16:21:12.000Z"
    }
  ];
  attempts.component_selection = [
    {
      ...pendingAttempt("component_selection"),
      state: "blocked",
      artifactIds: ["artifact-demo-shortlist"],
      evidenceIds: ["evidence-demo-footprint"],
      blockers: [
        {
          code: "PINNED_FOOTPRINT_UNAVAILABLE",
          message: "The selected CAN transceiver has no approved footprint in the pinned library snapshot.",
          stage: "component_selection",
          affectedInputDigests: [DIGEST_A, DIGEST_C],
          requiredAction:
            "Approve a pinned symbol/footprint pair or revise the CAN-transceiver constraint, then rerun this stage.",
          retryable: true,
          createdAt: "2026-09-03T16:21:18.000Z"
        }
      ],
      startedAt: "2026-09-03T16:21:14.000Z",
      completedAt: "2026-09-03T16:21:18.000Z"
    }
  ];
  return attempts;
};

const newAttempts = (): DesignRun["attempts"] => {
  const attempts: Partial<Record<StageKey, readonly StageAttempt[]>> = {};
  for (const stage of STAGE_ORDER) attempts[stage] = [pendingAttempt(stage)];
  attempts.requirements = [
    {
      ...pendingAttempt("requirements"),
      state: "waiting_approval",
      artifactIds: ["artifact-demo-requirements"],
      evidenceIds: ["evidence-demo-parse"],
      startedAt: new Date().toISOString()
    }
  ];
  return attempts;
};

const makeArtifacts = (): readonly ArtifactRecord[] => [
  {
    id: "artifact-demo-requirements",
    projectId: "project_demo_robot_ctrl",
    runId: "run_demo_20260903",
    designRevisionId: "revision_demo_03",
    stage: "requirements",
    logicalName: "requirements.v1.json",
    mediaType: "application/json",
    blob: content(DIGEST_A, 11_842),
    exactInputs: [content(DIGEST_B, 244)],
    derivedFrom: [],
    tool: { name: "evleda-requirements", version: "0.1.0", adapter: "evleda" },
    validationStatus: "pass",
    unresolvedAssumptions: [],
    lifecycle: "candidate",
    createdAt: "2026-09-03T16:21:05.000Z"
  },
  {
    id: "artifact-demo-architecture",
    projectId: "project_demo_robot_ctrl",
    runId: "run_demo_20260903",
    designRevisionId: "revision_demo_03",
    stage: "system_architecture",
    logicalName: "power-and-signal-architecture.json",
    mediaType: "application/json",
    blob: content(DIGEST_B, 19_106),
    exactInputs: [canonical(DIGEST_A, "evleda.requirements.v1")],
    derivedFrom: ["artifact-demo-requirements"],
    tool: { name: "evleda-architect", version: "0.1.0", adapter: "evleda" },
    validationStatus: "pass",
    unresolvedAssumptions: [],
    lifecycle: "candidate",
    createdAt: "2026-09-03T16:21:12.000Z"
  },
  {
    id: "artifact-demo-shortlist",
    projectId: "project_demo_robot_ctrl",
    runId: "run_demo_20260903",
    designRevisionId: "revision_demo_03",
    stage: "component_selection",
    logicalName: "component-shortlist.partial.json",
    mediaType: "application/json",
    blob: content(DIGEST_C, 8_433),
    exactInputs: [canonical(DIGEST_A, "evleda.requirements.v1")],
    derivedFrom: ["artifact-demo-architecture"],
    tool: {
      name: "evleda-component-selector",
      version: "0.1.0",
      adapter: "evleda",
      capabilityProfile: "curated-only"
    },
    validationStatus: "fail",
    unresolvedAssumptions: [
      {
        id: "assumption-demo-footprint",
        statement: "A verified CAN-transceiver footprint is not bound to the candidate.",
        severity: "blocking",
        sourceRequirementIds: ["req-can"]
      }
    ],
    lifecycle: "candidate",
    createdAt: "2026-09-03T16:21:18.000Z"
  }
];

const makeEvidence = (): readonly EvidenceRecord[] => [
  {
    id: "evidence-demo-parse",
    projectId: "project_demo_robot_ctrl",
    runId: "run_demo_20260903",
    designRevisionId: "revision_demo_03",
    stage: "requirements",
    evidenceClass: "evleda_check",
    claim: "The structured requirements bind to the exact source-prompt digest.",
    subjectDigests: [DIGEST_A, DIGEST_B],
    parsedArtifactId: "artifact-demo-requirements",
    exactInputs: [content(DIGEST_B, 244)],
    tool: { name: "evleda-requirements", version: "0.1.0", adapter: "evleda" },
    validationStatus: "pass",
    unresolvedAssumptions: [],
    lifecycle: "candidate",
    createdAt: "2026-09-03T16:21:05.000Z"
  },
  {
    id: "evidence-demo-envelope",
    projectId: "project_demo_robot_ctrl",
    runId: "run_demo_20260903",
    designRevisionId: "revision_demo_03",
    stage: "requirements",
    evidenceClass: "evleda_check",
    claim: "The requested input voltage remains inside the v0 low-voltage envelope.",
    subjectDigests: [DIGEST_A],
    exactInputs: [canonical(DIGEST_A, "evleda.requirements.v1")],
    tool: { name: "evleda-policy", version: "0.1.0", adapter: "evleda" },
    validationStatus: "pass",
    unresolvedAssumptions: [],
    lifecycle: "candidate",
    createdAt: "2026-09-03T16:21:06.000Z"
  },
  {
    id: "evidence-demo-budget",
    projectId: "project_demo_robot_ctrl",
    runId: "run_demo_20260903",
    designRevisionId: "revision_demo_03",
    stage: "system_architecture",
    evidenceClass: "agent_claim",
    claim: "The preliminary current budget has adequate nominal headroom.",
    subjectDigests: [DIGEST_B],
    exactInputs: [canonical(DIGEST_A, "evleda.requirements.v1")],
    tool: { name: "evleda-architect", version: "0.1.0", adapter: "evleda" },
    validationStatus: "not_run",
    unresolvedAssumptions: [
      {
        id: "assumption-demo-thermal",
        statement: "Thermal performance still requires modeled and physical validation.",
        severity: "warning",
        sourceRequirementIds: ["req-motor-current"]
      }
    ],
    lifecycle: "candidate",
    createdAt: "2026-09-03T16:21:12.000Z"
  },
  {
    id: "evidence-demo-footprint",
    projectId: "project_demo_robot_ctrl",
    runId: "run_demo_20260903",
    designRevisionId: "revision_demo_03",
    stage: "component_selection",
    evidenceClass: "evleda_check",
    claim: "Every selected electrical part is bound to a pinned, approved footprint.",
    subjectDigests: [DIGEST_C],
    rawArtifactId: "artifact-demo-shortlist",
    exactInputs: [canonical(DIGEST_A, "evleda.requirements.v1")],
    tool: { name: "evleda-library-check", version: "0.1.0", adapter: "evleda" },
    validationStatus: "fail",
    unresolvedAssumptions: [
      {
        id: "assumption-demo-footprint",
        statement: "The CAN-transceiver footprint is unavailable in the pinned library.",
        severity: "blocking",
        sourceRequirementIds: ["req-can"]
      }
    ],
    lifecycle: "candidate",
    createdAt: "2026-09-03T16:21:18.000Z"
  }
];

export const makeDemoSnapshot = (
  prompt = DEMO_PROMPT,
  name = "RBX-2 Controller",
  scenario: "blocked" | "new" = "blocked"
): BenchSnapshot => {
  const approved = scenario === "blocked";
  const requirements = parseDemoRequirements(prompt, approved);
  const project = {
    id: "project_demo_robot_ctrl",
    name,
    description: prompt,
    root: "LOCAL DEMO — no files are written",
    policyVersion: "evleda-policy-v1",
    headRevisionId: "revision_demo_03",
    runIds: ["run_demo_20260903"],
    createdAt: "2026-09-03T16:21:03.000Z",
    updatedAt: "2026-09-03T16:21:18.000Z",
    revision: 3
  } as const;
  const run: DesignRun = {
    id: "run_demo_20260903",
    projectId: project.id,
    state: approved ? "blocked" : "waiting_requirements_approval",
    lifecycle: "candidate",
    attempts: approved ? blockedAttempts() : newAttempts(),
    headRevisionId: "revision_demo_03",
    requirements,
    workflowVersion: "workflow-v1",
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    revision: 3
  };

  return {
    projects: [project],
    project,
    run,
    requirements,
    artifacts: makeArtifacts(),
    evidence: makeEvidence()
  };
};
