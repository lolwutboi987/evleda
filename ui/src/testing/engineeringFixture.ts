import type {
  CanonicalIdentity,
  ContentIdentity,
  EngineeringDispositionStatus,
  EngineeringFindingProjection,
  EngineeringMachineStatus,
  EngineeringPracticeInspectionResult
} from "../model";

const canonical = (character: string, schemaVersion: string): CanonicalIdentity => ({
  algorithm: "sha256",
  digest: character.repeat(64),
  schemaVersion,
  canonicalizationVersion: "evleda-c14n-json-v1"
});

const content = (character: string, size = 4096): ContentIdentity => ({
  algorithm: "sha256",
  digest: character.repeat(64),
  size
});

export interface EngineeringFixtureOptions {
  readonly projectId?: string;
  readonly runId?: string;
  readonly revisionId?: string | null;
  readonly isHeadRevision?: boolean;
  readonly disposition?: EngineeringDispositionStatus;
  readonly nativeDrcStatus?: EngineeringMachineStatus;
  readonly practiceStatus?: EngineeringMachineStatus;
  readonly reviewRequired?: boolean;
  readonly advisoryCount?: number;
  readonly findings?: readonly EngineeringFindingProjection[];
  readonly ruleFindingIds?: readonly string[];
  readonly findingsTotal?: number;
  readonly nextCursor?: string | null;
  readonly pageIdentityCharacter?: string;
}

export const engineeringFinding = (
  findingId = "finding-route-style-1"
): EngineeringFindingProjection => ({
  findingId,
  ruleIds: ["ROUTE_STYLE"],
  machineStatus: "FAIL",
  severity: "error",
  message: "A routed corner exceeds the bound 45 degree direction-change limit.",
  observed: { directionChangeDeg: 90, layer: "F.Cu", netName: "+5V" },
  required: { maximumDirectionChangeDeg: 45, toleranceDeg: 0.01 },
  assumptions: ["The two segments share the same net, layer, and exact endpoint."],
  sourceIds: ["evleda-route-quality-policy"],
  externalGateIds: [],
  locations: [
    {
      artifactId: "artifact-native-board",
      artifactIdentity: content("b", 81_920),
      sourcePath: "design/robotics-controller.kicad_pcb",
      form: "segment",
      ordinal: 217,
      uuid: "8b2e6402-43e5-4ea7-a24e-8da5f9f02d43",
      startOffset: 120_400,
      endOffset: 120_566,
      line: 1842,
      column: 5,
      geometry: {
        vertex: { x: 42.5, y: 19.25 },
        segmentOrdinals: [216, 217]
      }
    }
  ],
  remediation: {
    authority: "advisory_only",
    requiresNewRevision: true,
    summary: "Create a new routed revision whose adjacent segments comply with the bound route-quality policy.",
    steps: [
      "Replace the 90 degree corner with policy-compliant direction changes.",
      "Preserve clearance, net identity, and current-bound width while rerouting."
    ],
    verification: [
      "Rerun Native DRC on the exact new board bytes.",
      "Rerun the EvlEDA practice analyzer and confirm ROUTE_STYLE is PASS."
    ],
    rerunRuleIds: ["ROUTE_STYLE"],
    rerunStages: ["pcb_placement_routing"]
  }
});

export const makeEngineeringInspection = (
  options: EngineeringFixtureOptions = {}
): EngineeringPracticeInspectionResult => {
  const disposition = options.disposition ?? "BLOCKED_DIAGNOSTIC";
  const nativeDrcStatus = options.nativeDrcStatus ?? "PASS";
  const practiceStatus = options.practiceStatus ?? (disposition === "PROVISIONAL_POC" ? "PASS" : "FAIL");
  const revisionId = options.revisionId === undefined ? "revision-eng-1" : options.revisionId;
  const defaultFindings = disposition === "PROVISIONAL_POC" ? [] : [engineeringFinding()];
  const findings = options.findings ?? defaultFindings;
  const applicableStatus = disposition === "PROVISIONAL_POC" ? "PASS" : practiceStatus;
  const statusCounts = {
    PASS: applicableStatus === "PASS" ? 1 : 0,
    FAIL: applicableStatus === "FAIL" ? 1 : 0,
    UNKNOWN: applicableStatus === "UNKNOWN" ? 1 : 0,
    NOT_RUN: applicableStatus === "NOT_RUN" ? 1 : 0
  } as const;
  const reviewRequired = options.reviewRequired ?? (disposition === "PROVISIONAL_POC");
  const advisoryCount = options.advisoryCount ?? (reviewRequired ? 1 : 0);
  const currentNative = nativeDrcStatus !== "NOT_RUN" && nativeDrcStatus !== "UNKNOWN";
  const currentPractice = practiceStatus !== "NOT_RUN" && practiceStatus !== "UNKNOWN";

  return {
    schemaVersion: "evleda.engineering-practice-inspection.v1",
    projectId: options.projectId ?? "project-eng-1",
    runId: options.runId ?? "run-eng-1",
    revisionId,
    isHeadRevision: options.isHeadRevision ?? revisionId !== null,
    proofFixture: {
      purpose: "full_stack_engineering_proof_fixture",
      classification: "candidate_only",
      reportEstablishesQualification: false,
      reportAuthorizesManufacturing: false,
      reportAuthorizesRelease: false
    },
    disposition: {
      status: disposition,
      reasonCodes: [disposition === "PROVISIONAL_POC" ? "MACHINE_RULES_PASS" : "MACHINE_RULE_BLOCKED"],
      machineBlockerRuleIds: disposition === "PROVISIONAL_POC" ? [] : ["ROUTE_STYLE"],
      openExternalGateIds: ["gate-fabricator", "gate-human", "gate-physical"]
    },
    bindings: {
      revisionManifest: revisionId === null ? null : canonical("1", "evleda.design-revision.v1"),
      requirementsIdentity: canonical("2", "evleda.requirements.v1"),
      evidenceRootIdentity: canonical("3", "evleda.evidence-root.v1"),
      practiceCatalogIdentity: canonical("4", "evleda.pcb-engineering-practices.v1"),
      routeQualityPolicyIdentity: canonical("5", "evleda.pcb-route-quality.v1"),
      routeQualityPolicyCaptureIdentity: content("6", 6_144),
      routeQualityRuleDeckIdentity: canonical("7", "evleda.pcb-route-quality-rule-deck.v1"),
      proofFixturePolicyIdentity: canonical("8", "evleda.proof-fixture-policy.v1"),
      analyzerProfileIdentity: canonical("9", "evleda.pcb-practice-analysis-profile.v2"),
      constraintBindingIdentity: canonical("a", "evleda.engineering-constraint-binding.v1"),
      nativeBoardIdentity: revisionId === null ? null : content("b", 81_920)
    },
    checks: {
      nativeDrc: {
        evidenceClass: "kicad_native",
        machineStatus: nativeDrcStatus,
        reasonCode: currentNative ? "NATIVE_DRC_CURRENT" : `NATIVE_DRC_${nativeDrcStatus}`,
        message: currentNative ? "KiCad Native DRC executed on the exact board bytes." : "No current native DRC authority is available.",
        current: currentNative,
        artifactId: currentNative ? "artifact-native-drc" : null,
        evidenceId: currentNative ? "evidence-native-drc" : null,
        reportIdentity: currentNative ? content("c", 2_048) : null,
        tool: currentNative ? { name: "kicad-cli", version: "10.0", adapter: "local" } : null,
        evaluatedAt: currentNative ? "2026-09-05T05:30:00.000Z" : null
      },
      evledaPractice: {
        evidenceClass: "evleda_check",
        machineStatus: practiceStatus,
        reasonCode: currentPractice ? "EVLEDA_PRACTICE_CURRENT" : `EVLEDA_PRACTICE_${practiceStatus}`,
        message: currentPractice ? "EvlEDA analyzed route geometry and the bound engineering catalog." : "No current EvlEDA practice report is available.",
        current: currentPractice,
        artifactId: currentPractice ? "artifact-practice-report" : null,
        evidenceId: currentPractice ? "evidence-practice-report" : null,
        reportIdentity: currentPractice ? content("d", 16_384) : null,
        tool: currentPractice ? { name: "evleda-pcb-practice-analyzer", version: "2", adapter: "local" } : null,
        evaluatedAt: currentPractice ? "2026-09-05T05:31:00.000Z" : null,
        analysisOutcome: practiceStatus === "PASS" ? (reviewRequired ? "review" : "pass") : practiceStatus === "FAIL" ? "fail" : null,
        reviewRequired,
        advisoryCount
      }
    },
    coverage: {
      inventoryComplete: true,
      expectedRuleCount: 2,
      evaluatedRuleCount: 2,
      applicableRuleCount: 1,
      notApplicableRuleCount: 1,
      statusCounts,
      missingRuleIds: [],
      unexpectedRuleIds: []
    },
    rules: [
      {
        ruleId: "ROUTE_STYLE",
        title: "Policy-bound routed direction changes",
        applicability: "APPLICABLE",
        machineStatus: applicableStatus,
        blocking: disposition === "BLOCKED_DIAGNOSTIC",
        decisionClasses: ["hard_gate"],
        reasonCode: disposition === "PROVISIONAL_POC" ? "ENGINEERING_CHECK_PASSED" : "ENGINEERING_CHECK_FAILED",
        sourceIds: ["evleda-route-quality-policy"],
        exactInputIdentities: [content("b", 81_920), canonical("5", "evleda.pcb-route-quality.v1")],
        checkerResultIdentities: currentPractice ? [content("d", 16_384)] : [],
        findingIds: options.ruleFindingIds ?? findings.map((finding) => finding.findingId),
        externalGateIds: []
      },
      {
        ruleId: "VIA_ELECTROTHERMAL_FAULT",
        title: "Via electrothermal fault envelope",
        applicability: "NOT_APPLICABLE",
        machineStatus: null,
        blocking: false,
        decisionClasses: ["calculation_gate"],
        reasonCode: "ENGINEERING_GATE_NOT_APPLICABLE",
        sourceIds: ["ti-analog-engineers-pocket-reference-rev-c"],
        exactInputIdentities: [canonical("4", "evleda.pcb-engineering-practices.v1")],
        checkerResultIdentities: [],
        findingIds: [],
        externalGateIds: []
      }
    ],
    advisories: advisoryCount > 0 ? [
      {
        advisoryId: "advisory-return-path-review",
        ruleIds: ["ROUTE_STYLE"],
        severity: "advisory",
        message: "A human should review the return-path context before prototype assembly.",
        sourceIds: ["evleda-route-quality-policy"],
        findingIds: [],
        externalGateIds: ["gate-human"]
      }
    ] : [],
    outstandingExternalGates: [
      {
        gateId: "gate-fabricator",
        ruleId: "ROUTE_STYLE",
        owner: "fabricator",
        status: "OPEN",
        reasonCode: "ENGINEERING_FABRICATOR_CONFIRMATION_REQUIRED",
        message: "The selected fabricator must confirm the exact stackup and service options.",
        subjectIds: ["reference-fabrication-profile"],
        sourceIds: ["jlcpcb-manufacturing-capabilities-2026"],
        exactInputIdentities: [canonical("5", "evleda.pcb-route-quality.v1")],
        evidenceIds: []
      },
      {
        gateId: "gate-human",
        ruleId: "ROUTE_STYLE",
        owner: "human",
        status: "OPEN",
        reasonCode: "ENGINEERING_HUMAN_REVIEW_REQUIRED",
        message: "An authenticated human review remains open.",
        subjectIds: ["return-path-review"],
        sourceIds: ["evleda-route-quality-policy"],
        exactInputIdentities: [],
        evidenceIds: []
      },
      {
        gateId: "gate-physical",
        ruleId: "ROUTE_STYLE",
        owner: "physical",
        status: "UNKNOWN",
        reasonCode: "ENGINEERING_PHYSICAL_VALIDATION_REQUIRED",
        message: "Physical prototype measurements have not been supplied.",
        subjectIds: ["prototype-measurements"],
        sourceIds: [],
        exactInputIdentities: [],
        evidenceIds: []
      }
    ],
    gateSummary: {
      machineBlockers: disposition === "PROVISIONAL_POC" ? 0 : 1,
      fabricatorOpen: 1,
      humanOpen: 1,
      physicalOpen: 1
    },
    findings: {
      total: options.findingsTotal ?? findings.length,
      items: findings,
      nextCursor: options.nextCursor ?? null
    },
    sources: [
      {
        sourceId: "evleda-route-quality-policy",
        title: "EvlEDA PCB Route Quality Policy v1",
        publisher: "EvlEDA",
        revision: "1",
        date: { kind: "revised", value: "2026-09-05" },
        url: null,
        authority: "internal_policy",
        accessScope: "embedded_snapshot",
        normativeStatus: "internal_product_policy",
        captureIdentity: content("6", 6_144),
        locator: { kind: "json_pointer", value: "/" },
        excerptIdentity: content("e", 512),
        captureComplete: true
      },
      {
        sourceId: "jlcpcb-manufacturing-capabilities-2026",
        title: "JLCPCB PCB Manufacturing Capabilities",
        publisher: "JLCPCB",
        revision: "accessed-2026-09-05",
        date: { kind: "accessed", value: "2026-09-05" },
        url: "https://jlcpcb.com/capabilities/Capabilities",
        authority: "fabricator",
        accessScope: "live_capability_page",
        normativeStatus: "fabricator_specific",
        captureIdentity: null,
        locator: null,
        excerptIdentity: null,
        captureComplete: false
      },
      {
        sourceId: "ti-analog-engineers-pocket-reference-rev-c",
        title: "Analog Engineer's Pocket Reference",
        publisher: "Texas Instruments",
        revision: "Rev. C",
        date: { kind: "revised", value: "2019-03-01" },
        url: "https://www.ti.com/lit/ug/slyw038c/slyw038c.pdf",
        authority: "component_manufacturer",
        accessScope: "public_full_text",
        normativeStatus: "manufacturer_guidance",
        captureIdentity: null,
        locator: null,
        excerptIdentity: null,
        captureComplete: false
      }
    ],
    identity: canonical(options.pageIdentityCharacter ?? "f", "evleda.engineering-practice-inspection.v1")
  };
};
