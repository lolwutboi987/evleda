import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import { parseRequirements } from "../../src/core/requirements.js";
import { STAGE_ORDER, type StageKey } from "../../src/domain/stages.js";
import type { ApprovalRecord } from "../../src/domain/types.js";
import {
  ENGINEERING_CONSTRAINT_CONTEXT_SCHEMA,
  compileEngineeringConstraintBinding,
  compileEngineeringConstraintSet,
  type EngineeringCheckerResult,
  type EngineeringConstraintBinding,
  type EngineeringInputBinding,
  type EngineeringScopeFact,
} from "../../src/engineering/constraint-compiler.js";
import { runKicadBackend } from "../../src/generators/backend-runner.js";
import {
  buildPcbPracticeAnalysisProfile,
  pcbPlacementRoutingStageExecutor,
} from "../../src/generators/pcb-generator.js";
import { finalizeStageResult, jsonArtifactDraft } from "../../src/generators/draft-utils.js";
import {
  PCB_LAYOUT_QUALITY_POLICY,
  PCB_ROUTE_QUALITY_RULE_DECK,
  REV_A_PROOF_FIXTURE_POLICY,
  buildPcbLayoutPlan,
} from "../../src/generators/pcb-layout-plan.js";
import {
  PCB_ENGINEERING_PRACTICE_CATALOG,
  PCB_ENGINEERING_REQUIRED_INPUTS,
  PCB_ENGINEERING_SCOPE_PREDICATES,
  type PcbEngineeringRequiredInput,
  type PcbEngineeringScopePredicate,
} from "../../src/knowledge/pcb-engineering-practices.js";
import { ROBOTICS_CONTROLLER_V0 } from "../../src/knowledge/reference-controller-v0.js";
import {
  PCB_PRACTICE_ANALYZER_SUPPORTED_BOARD_VERSIONS,
  analyzeKicadPcbPractices,
} from "../../src/integrations/pcb-practice-analyzer.js";
import type {
  CandidateStageContext,
  KicadBackendReport,
  KicadBackendRequest,
  KicadBackendResult,
  KicadGenerationBackend,
  KicadPcbEngineeringRequest,
  StageExecutionResult,
} from "../../src/workflow/contracts.js";
import { buildKicadPcbEngineeringDecisionSummary } from "../../src/workflow/contracts.js";
import {
  CLEAN_MINIMAL_KICAD_PCB,
  TEST_KICAD_TOOL,
  testKicadReports,
} from "../helpers/kicad-reports.js";

const requirements = parseRequirements(
  "Build a two-channel brushed motor controller for a 7-16.8 V supply at 0.5 A RMS per channel with USB, CAN, UART, I2C, SPI, two quadrature encoders, and SWD.",
).document;

const encoder = new TextEncoder();

const boardWith = (...body: readonly string[]): Uint8Array => encoder.encode([
  "(kicad_pcb",
  `  (version ${PCB_PRACTICE_ANALYZER_SUPPORTED_BOARD_VERSIONS[0]})`,
  '  (generator "pcbnew")',
  "  (layers",
  '    (0 "F.Cu" signal)',
  '    (4 "In1.Cu" signal)',
  '    (6 "In2.Cu" power)',
  '    (8 "In3.Cu" power)',
  '    (10 "In4.Cu" signal)',
  '    (2 "B.Cu" signal)',
  '    (25 "Edge.Cuts" user)',
  "  )",
  '  (net 1 "CLEAN_SIGNAL")',
  '  (gr_line (start 0 0) (end 60 0) (stroke (width 0.05) (type default)) (layer "Edge.Cuts") (uuid "edge-1"))',
  '  (gr_line (start 60 0) (end 60 45) (stroke (width 0.05) (type default)) (layer "Edge.Cuts") (uuid "edge-2"))',
  '  (gr_line (start 60 45) (end 0 45) (stroke (width 0.05) (type default)) (layer "Edge.Cuts") (uuid "edge-3"))',
  '  (gr_line (start 0 45) (end 0 0) (stroke (width 0.05) (type default)) (layer "Edge.Cuts") (uuid "edge-4"))',
  ...body,
  ")",
  "",
].join("\n"));

const hardFindingBoard = boardWith(
  '  (segment (start 5 5) (end 10 5) (width 0.1) (layer "F.Cu") (net 1) (uuid "hard-a"))',
  '  (segment (start 10 5) (end 10 10) (width 0.1) (layer "F.Cu") (net 1) (uuid "hard-b"))',
);

const reviewOnlyBoard = boardWith(
  '  (segment (start 5 5) (end 10 5) (width 0.2) (layer "F.Cu") (net 1) (uuid "review-a"))',
  '  (segment (start 10 5) (end 10 10) (width 0.2) (layer "F.Cu") (net 1) (uuid "review-b"))',
);

const incompleteCoverageBoard = boardWith(
  '  (arc (start 5 5) (mid 7.5 4) (end 10 5) (width 0.2) (layer "F.Cu") (net 1) (uuid "unsupported-route-arc"))',
);

const engineeringTestIdentity = (kind: string, value: unknown) =>
  canonicalIdentity({ kind, value }, `test.${kind}.v1`);

const externalOnlyConstraintBinding = (): EngineeringConstraintBinding => {
  const scopeFacts: readonly EngineeringScopeFact[] = PCB_ENGINEERING_SCOPE_PREDICATES.map(
    (predicate): EngineeringScopeFact => {
      const value =
        predicate === "supported_low_voltage_rigid_pcb" ||
        predicate === "thermal_or_exposed_pad_present";
      return {
        predicate,
        value,
        identity: engineeringTestIdentity("scope-fact", { predicate, value }),
      };
    },
  );
  const inputBindings: readonly EngineeringInputBinding[] =
    PCB_ENGINEERING_REQUIRED_INPUTS.map(
      (inputId: PcbEngineeringRequiredInput): EngineeringInputBinding => ({
        inputId,
        identity: engineeringTestIdentity("engineering-input", inputId),
      }),
    );
  const checkerResults: readonly EngineeringCheckerResult[] =
    PCB_ENGINEERING_PRACTICE_CATALOG.rules.flatMap((rule) =>
      rule.checkerIds.map((checkerId): EngineeringCheckerResult => ({
        ruleId: rule.id,
        checkerId,
        status: "pass",
        resultIdentity: engineeringTestIdentity("checker-result", {
          ruleId: rule.id,
          checkerId,
        }),
        exactInputIdentities: rule.requiredInputs.map(
          (inputId) => inputBindings.find((binding) => binding.inputId === inputId)!.identity,
        ),
        sourceIds: rule.sourceIds,
        numericClaimIds: rule.numericClaims.map((claim) => claim.id),
        modelIds: rule.modelIds,
      })),
    );
  return compileEngineeringConstraintBinding({
    schemaVersion: ENGINEERING_CONSTRAINT_CONTEXT_SCHEMA,
    scopeFacts,
    inputBindings,
    checkerResults,
  });
};

const constraintRequestSnapshot = (binding: EngineeringConstraintBinding) => ({
  logicalName: "pcb/engineering/constraint-binding.json",
  document: binding,
  contentIdentity: contentIdentity(`${canonicalJson(binding)}\n`),
  canonicalIdentity: binding.identity,
});

const contextFor = (backend: KicadGenerationBackend): CandidateStageContext => ({
  projectId: "project_pcb_practice_workflow",
  runId: "run_pcb_practice_workflow",
  designRevisionId: "revision_pcb_practice_workflow",
  requirements,
  profile: ROBOTICS_CONTROLLER_V0,
  upstream: [],
  upstreamSourceRevisionBindings: [],
  kicadBackend: backend,
});

const engineeringFixture = () => {
  const planDocument = buildPcbLayoutPlan(ROBOTICS_CONTROLLER_V0);
  const plan = jsonArtifactDraft({
    logicalName: "pcb/layout-routing-plan.json",
    value: planDocument,
    exactInputs: [requirements.identity],
    validationStatus: "not_run",
  });
  const analyzerProfile = buildPcbPracticeAnalysisProfile(
    ROBOTICS_CONTROLLER_V0,
    planDocument,
  );
  const analyzerProfileIdentity = canonicalIdentity(
    analyzerProfile,
    analyzerProfile.schemaVersion,
  );
  const analyzerProfileArtifact = jsonArtifactDraft({
    logicalName: "pcb/engineering/analyzer-profile.json",
    value: analyzerProfile,
    exactInputs: [analyzerProfileIdentity],
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
  const snapshotArtifacts = [
    analyzerProfileArtifact,
    practiceCatalogArtifact,
    routeQualityPolicyArtifact,
    routeQualityRuleDeckArtifact,
    proofFixturePolicyArtifact,
  ];
  const pcbEngineering: KicadPcbEngineeringRequest = {
    layoutPlan: {
      logicalName: plan.logicalName,
      document: planDocument,
      contentIdentity: plan.identity,
    },
    analyzerProfile: {
      logicalName: analyzerProfileArtifact.logicalName,
      document: analyzerProfile,
      contentIdentity: analyzerProfileArtifact.identity,
      canonicalIdentity: analyzerProfileIdentity,
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
    engineeringConstraintBinding: null,
  };
  return {
    plan,
    snapshotArtifacts,
    analyzerProfile,
    pcbEngineering,
    exactInputs: [
      requirements.identity,
      plan.identity,
      analyzerProfileIdentity,
      PCB_ENGINEERING_PRACTICE_CATALOG.identity,
      ...snapshotArtifacts.map((artifact) => artifact.identity),
      PCB_LAYOUT_QUALITY_POLICY.identity,
      PCB_LAYOUT_QUALITY_POLICY.captureIdentity,
      PCB_ROUTE_QUALITY_RULE_DECK.identity,
      REV_A_PROOF_FIXTURE_POLICY.identity,
    ],
  };
};

const backendFor = (
  board: Uint8Array,
  observe?: (request: KicadBackendRequest) => void,
  mutateReports: (reports: readonly KicadBackendReport[]) => readonly KicadBackendReport[] =
    (reports) => reports,
): KicadGenerationBackend => ({
  backendId: "pcb-practice-workflow-test-backend",
  execute: async (request): Promise<KicadBackendResult> => {
    observe?.(request);
    const artifacts = [
      {
        role: "pcb" as const,
        logicalName: "kicad/controller/controller.kicad_pcb",
        mediaType: "application/x-kicad-pcb",
        content: board,
      },
      {
        role: "render" as const,
        logicalName: "renders/controller.svg",
        mediaType: "image/svg+xml",
        content: encoder.encode("<svg/>")
      },
    ];
    const reports = testKicadReports({
      request,
      artifacts,
      reportKinds: ["drc", "schematic_parity", "connectivity", "geometry", "pcb_practices"],
    });
    return {
      schemaVersion: "evleda.kicad-result.v2",
      stage: request.stage,
      sourceRevisionDigest: request.expectedSourceRevisionDigest,
      tool: TEST_KICAD_TOOL,
      artifacts,
      reports: mutateReports(reports),
    };
  },
});

const runFixture = async (
  board: Uint8Array,
  options: {
    readonly observe?: (request: KicadBackendRequest) => void;
    readonly mutateReports?: (reports: readonly KicadBackendReport[]) => readonly KicadBackendReport[];
    readonly mutateEngineering?: (request: KicadPcbEngineeringRequest) => KicadPcbEngineeringRequest;
  } = {},
) => {
  const fixture = engineeringFixture();
  const backend = backendFor(board, options.observe, options.mutateReports);
  const pcbEngineering =
    options.mutateEngineering?.(fixture.pcbEngineering) ?? fixture.pcbEngineering;
  const constraintInputs = pcbEngineering.engineeringConstraintBinding === null ||
    pcbEngineering.engineeringConstraintBinding === undefined
    ? []
    : [
        pcbEngineering.engineeringConstraintBinding.contentIdentity,
        pcbEngineering.engineeringConstraintBinding.canonicalIdentity,
        pcbEngineering.engineeringConstraintBinding.document.compiledConstraintSetIdentity,
      ];
  const constraintArtifact = pcbEngineering.engineeringConstraintBinding === null ||
    pcbEngineering.engineeringConstraintBinding === undefined
    ? []
    : [jsonArtifactDraft({
        logicalName: pcbEngineering.engineeringConstraintBinding.logicalName,
        value: pcbEngineering.engineeringConstraintBinding.document,
        exactInputs: constraintInputs,
        validationStatus: "pass",
      })];
  return await runKicadBackend({
    stage: "pcb_placement_routing",
    context: contextFor(backend),
    profile: ROBOTICS_CONTROLLER_V0,
    exactInputs: [...fixture.exactInputs, ...constraintInputs],
    initialArtifacts: [fixture.plan, ...fixture.snapshotArtifacts, ...constraintArtifact],
    initialBlockers: [],
    requiredArtifactRoles: ["pcb", "render"],
    requiredReports: ["drc", "schematic_parity", "connectivity", "geometry", "pcb_practices"],
    pcbEngineering,
  });
};

describe("PCB practice workflow boundary", () => {
  it("retains the current Rev-A proof board as an expected negative engineering fixture", () => {
    const plan = buildPcbLayoutPlan(ROBOTICS_CONTROLLER_V0);
    const profile = buildPcbPracticeAnalysisProfile(ROBOTICS_CONTROLLER_V0, plan);
    const board = readFileSync(
      "reference-designs/robotics-controller-v0/robotics-controller-v0.kicad_pcb",
    );
    const analysis = analyzeKicadPcbPractices(board, profile, {
      sourcePath: "reference-designs/robotics-controller-v0/robotics-controller-v0.kicad_pcb",
    });

    expect(analysis).toMatchObject({
      outcome: "fail",
      qualificationEstablished: false,
      releaseAuthorized: false,
      summary: {
        outlineComplete: true,
        findingsBySeverity: { error: expect.any(Number) },
      },
    });
    expect(analysis.summary.findingsBySeverity.error).toBeGreaterThan(0);
    expect(
      analysis.findings.some(
        (finding) =>
          finding.severity === "error" && finding.sourceRuleIds.includes("ROUTE_STYLE"),
      ),
    ).toBe(true);
    expect(
      analysis.findings.some(
        (finding) =>
          finding.severity === "error" && finding.sourceRuleIds.includes("BACKTRACK"),
      ),
    ).toBe(true);
  });

  it("sends a reproducible v2 request but keeps a clean phase-1 board diagnostic", async () => {
    let captured: KicadBackendRequest | undefined;
    const result = await runFixture(CLEAN_MINIMAL_KICAD_PCB, {
      observe: (request) => { captured = structuredClone(request); },
    });

    expect(result.blockers.map((blocker) => blocker.code)).toEqual([
      "PCB_ENGINEERING_COVERAGE_INCOMPLETE",
    ]);
    expect(captured).toMatchObject({
      schemaVersion: "evleda.kicad-request.v2",
      stage: "pcb_placement_routing",
      pcbEngineering: {
        layoutPlan: { logicalName: "pcb/layout-routing-plan.json" },
        practiceCatalog: {
          logicalName: "pcb/engineering/practice-catalog.json",
          canonicalIdentity: PCB_ENGINEERING_PRACTICE_CATALOG.identity,
        },
        engineeringConstraintBinding: null,
      },
    });
    const engineering = captured!.pcbEngineering!;
    expect(engineering.layoutPlan.contentIdentity).toEqual(
      contentIdentity(`${canonicalJson(engineering.layoutPlan.document)}\n`),
    );
    expect(engineering.analyzerProfile.canonicalIdentity).toEqual(
      canonicalIdentity(
        engineering.analyzerProfile.document,
        engineering.analyzerProfile.document.schemaVersion,
      ),
    );
    expect(engineering.analyzerProfile.document.sourceValidation).toEqual({
      mode: "production",
      supportedBoardVersions: PCB_PRACTICE_ANALYZER_SUPPORTED_BOARD_VERSIONS,
    });
    expect(engineering.analyzerProfile.document.netClasses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "Default",
          minimumTrackWidthMm: 0.2,
          minimumInteriorAngleDeg: 135,
          interiorAngleDisposition: {
            sourceRuleId: "ROUTE_STYLE",
            severity: "error",
          },
        }),
        expect.objectContaining({ id: "BatteryInput", minimumTrackWidthMm: 0.8 }),
        expect.objectContaining({ id: "MotorPower", minimumTrackWidthMm: 0.3 }),
      ]),
    );
    expect(result.evidence).toContainEqual(
      expect.objectContaining({
        evidenceClass: "evleda_check",
        parsedArtifactLogicalName: "reports/pcb_placement_routing-pcb_practices.json",
        validationStatus: "fail",
      }),
    );
    const report = result.artifacts.find(
      (artifact) => artifact.logicalName.endsWith("pcb_practices.json"),
    )!;
    const reportDocument = JSON.parse(new TextDecoder().decode(report.content)) as {
      readonly authority: {
        readonly inputBindings: readonly {
          readonly kind: string;
          readonly logicalName: string;
          readonly identity: { readonly digest: string };
        }[];
      };
      readonly payload: {
        readonly engineeringInputs: Readonly<Record<string, {
          readonly logicalName: string;
          readonly contentIdentity: { readonly digest: string };
        } | null>>;
        readonly analysis: unknown;
        readonly analysisIdentity: unknown;
        readonly engineeringSummary: unknown;
      };
    };
    expect(Object.keys(reportDocument.payload.engineeringInputs).sort()).toEqual([
      "analyzerProfile",
      "engineeringConstraintBinding",
      "layoutPlan",
      "practiceCatalog",
      "proofFixturePolicy",
      "routeQualityPolicy",
      "routeQualityRuleDeck",
    ]);
    expect(reportDocument.payload.analysisIdentity).toEqual(
      canonicalIdentity(
        reportDocument.payload.analysis,
        "evleda.pcb-practice-analysis.v2",
      ),
    );
    for (const reference of Object.values(reportDocument.payload.engineeringInputs)) {
      if (reference === null) continue;
      const artifact = result.artifacts.find(
        (candidate) => candidate.logicalName === reference.logicalName,
      );
      expect(artifact?.mediaType).toBe("application/json");
      expect(artifact?.identity.digest).toBe(reference.contentIdentity.digest);
      expect(
        reportDocument.authority.inputBindings.filter(
          (binding) =>
            binding.kind === "artifact" &&
            binding.logicalName === reference.logicalName &&
            binding.identity.digest === reference.contentIdentity.digest,
        ),
      ).toHaveLength(1);
    }
    expect(reportDocument.payload.engineeringSummary).toMatchObject({
      analyzerOutcome: "pass",
      reviewRequired: true,
      analyzer: { completeBoardGeometryCoverage: false },
      machine: { status: "unresolved", gateFailed: false, coverageIncomplete: true },
      external: { status: "none" },
      referenceFabricationProfile: { status: "missing", identities: [] },
      artifactDisposition: "BLOCKED_DIAGNOSTIC",
    });
  });

  it("makes analyzer review explicit while keeping non-blocking advisories provisional", () => {
    const plan = buildPcbLayoutPlan(ROBOTICS_CONTROLLER_V0);
    const strict = buildPcbPracticeAnalysisProfile(ROBOTICS_CONTROLLER_V0, plan);
    const reviewProfile = {
      ...strict,
      netClasses: strict.netClasses.map((netClass) => {
        const {
          minimumInteriorAngleDeg: _minimumInteriorAngleDeg,
          interiorAngleDisposition: _interiorAngleDisposition,
          ...withoutHardBend
        } = netClass;
        return withoutHardBend;
      }),
    };
    const analysis = analyzeKicadPcbPractices(reviewOnlyBoard, reviewProfile, {
      sourcePath: "review-only.kicad_pcb",
    });
    const summary = buildKicadPcbEngineeringDecisionSummary(analysis, null);

    expect(analysis.outcome).toBe("review");
    expect(summary).toMatchObject({
      analyzerOutcome: "review",
      reviewRequired: true,
      analyzer: { outcome: "review", reviewRequired: true },
      machine: { status: "unresolved", gateFailed: false, coverageIncomplete: true },
      external: { status: "none", outstandingGateIds: [] },
      artifactDisposition: "BLOCKED_DIAGNOSTIC",
      manufactureReady: false,
      qualificationAuthorized: false,
      releaseAuthorized: false,
    });
  });

  it("keeps external-only gates visible without relabeling them as machine failures", async () => {
    const binding = externalOnlyConstraintBinding();
    expect(binding.compiledConstraintSet.blockers.length).toBeGreaterThan(0);
    expect(
      binding.compiledConstraintSet.blockers.every((blocker) => blocker.owner !== "machine"),
    ).toBe(true);
    const result = await runFixture(CLEAN_MINIMAL_KICAD_PCB, {
      mutateEngineering: (request) => ({
        ...request,
        engineeringConstraintBinding: constraintRequestSnapshot(binding),
      }),
    });

    expect(result.blockers.map((blocker) => blocker.code)).toEqual([
      "PCB_ENGINEERING_COVERAGE_INCOMPLETE",
    ]);
    const report = result.artifacts.find(
      (artifact) => artifact.logicalName.endsWith("pcb_practices.json"),
    )!;
    const document = JSON.parse(new TextDecoder().decode(report.content)) as {
      readonly payload: { readonly engineeringSummary: Readonly<Record<string, any>> };
    };
    expect(report.validationStatus).toBe("fail");
    expect(document.payload.engineeringSummary).toMatchObject({
      analyzerOutcome: "pass",
      reviewRequired: true,
      machine: {
        status: "unresolved",
        gateFailed: false,
        coverageIncomplete: true,
        failedGateIds: [],
        unresolvedGateIds: [],
      },
      external: {
        status: "outstanding",
        owners: ["fabricator"],
        statuses: ["unresolved"],
      },
      referenceFabricationProfile: {
        status: "unverified",
        identities: expect.any(Array),
      },
      artifactDisposition: "BLOCKED_DIAGNOSTIC",
      provisionalArtifactGenerationAllowed: true,
      manufactureReady: false,
      qualificationAuthorized: false,
      releaseAuthorized: false,
    });
    expect(
      (document.payload.engineeringSummary.external as { outstandingGateIds: unknown[] })
        .outstandingGateIds.length,
    ).toBeGreaterThan(0);
  });

  it("maps unresolved machine applicability/input/checker gates to coverage, not external errors", async () => {
    const binding = compileEngineeringConstraintBinding({
      schemaVersion: ENGINEERING_CONSTRAINT_CONTEXT_SCHEMA,
      scopeFacts: [],
      inputBindings: [],
      checkerResults: [],
    });
    const result = await runFixture(CLEAN_MINIMAL_KICAD_PCB, {
      mutateEngineering: (request) => ({
        ...request,
        engineeringConstraintBinding: constraintRequestSnapshot(binding),
      }),
    });

    expect(result.blockers.map((blocker) => blocker.code)).toEqual([
      "PCB_ENGINEERING_COVERAGE_INCOMPLETE",
    ]);
    const report = result.artifacts.find(
      (artifact) => artifact.logicalName.endsWith("pcb_practices.json"),
    )!;
    const document = JSON.parse(new TextDecoder().decode(report.content)) as {
      readonly payload: { readonly engineeringSummary: Readonly<Record<string, any>> };
    };
    expect(report.validationStatus).toBe("fail");
    expect(document.payload.engineeringSummary).toMatchObject({
      analyzerOutcome: "pass",
      reviewRequired: true,
      machine: {
        status: "unresolved",
        gateFailed: false,
        coverageIncomplete: true,
        failedGateIds: [],
        unresolvedGateIds: expect.any(Array),
      },
      external: { status: "outstanding" },
      artifactDisposition: "BLOCKED_DIAGNOSTIC",
    });
    expect(
      (document.payload.engineeringSummary.machine as { unresolvedGateIds: unknown[] })
        .unresolvedGateIds.length,
    ).toBeGreaterThan(0);
  });

  it("aggregates hard findings without discarding their detailed report", async () => {
    const result = await runFixture(hardFindingBoard);

    expect(result.blockers.map((blocker) => blocker.code)).toContain(
      "PCB_ENGINEERING_GATE_FAILED",
    );
    expect(result.blockers.map((blocker) => blocker.code)).not.toContain(
      "KICAD_REPORT_NOT_PASSING",
    );
    expect(result.blockers.map((blocker) => blocker.code)).toContain(
      "PCB_ENGINEERING_COVERAGE_INCOMPLETE",
    );
    const report = result.artifacts.find(
      (artifact) => artifact.logicalName.endsWith("pcb_practices.json"),
    );
    expect(report?.validationStatus).toBe("fail");
    expect(
      result.evidence.find(
        (entry) =>
          entry.evidenceClass === "kicad_native" &&
          entry.rawArtifactLogicalName?.includes("native-drc") === true,
      )?.validationStatus,
    ).toBe("pass");
    expect(
      result.evidence.find(
        (entry) => entry.parsedArtifactLogicalName?.endsWith("pcb_practices.json") === true,
      )?.validationStatus,
    ).toBe("fail");
    const document = JSON.parse(new TextDecoder().decode(report!.content)) as {
      readonly payload: { readonly analysis: { readonly findings: readonly { readonly severity: string }[] } };
    };
    expect(document.payload.analysis.findings.some((finding) => finding.severity === "error"))
      .toBe(true);
  });

  it("fails closed with a stable coverage blocker for unsupported routed geometry", async () => {
    const result = await runFixture(incompleteCoverageBoard);

    expect(result.blockers.map((blocker) => blocker.code)).toEqual([
      "PCB_ENGINEERING_COVERAGE_INCOMPLETE",
    ]);
  });

  it("rejects a tampered analysis instead of trusting report labels", async () => {
    const result = await runFixture(hardFindingBoard, {
      mutateReports: (reports) => reports.map((report) => {
        if (report.kind !== "pcb_practices" || report.evidenceClass !== "evleda_check") {
          return report;
        }
        const document = JSON.parse(new TextDecoder().decode(report.content)) as Record<string, any>;
        document.payload.analysis = {
          ...document.payload.analysis,
          outcome: "pass",
          findings: [],
        };
        return { ...report, content: encoder.encode(`${canonicalJson(document)}\n`) };
      }),
    });

    expect(result.blockers.map((blocker) => blocker.code)).toEqual(
      expect.arrayContaining(["KICAD_REPORT_BINDING_INVALID", "KICAD_REPORT_MISSING"]),
    );
    expect(result.blockers.map((blocker) => blocker.code)).not.toContain(
      "PCB_ENGINEERING_GATE_FAILED",
    );
    expect(
      result.evidence.some(
        (entry) => entry.parsedArtifactLogicalName?.endsWith("pcb_practices.json") === true,
      ),
    ).toBe(false);
  });

  it("rejects a coherently relabeled native source that is not the analyzed PCB bytes", async () => {
    const wrongIdentity = contentIdentity("different-native-board-source");
    const result = await runFixture(CLEAN_MINIMAL_KICAD_PCB, {
      mutateReports: (reports) => reports.map((report) => {
        if (report.evidenceClass === "kicad_native") {
          return {
            ...report,
            authority: {
              ...report.authority,
              sourceBindings: report.authority.sourceBindings.map((binding) => ({
                ...binding,
                identity: wrongIdentity,
              })),
            },
          };
        }
        const authority = {
          ...report.authority,
          inputBindings: report.authority.inputBindings.map((binding) =>
            binding.kind === "source" ? { ...binding, identity: wrongIdentity } : binding
          ),
        };
        if (report.kind !== "pcb_practices") return { ...report, authority };
        const document = JSON.parse(new TextDecoder().decode(report.content)) as Record<string, any>;
        document.authority = authority;
        return {
          ...report,
          authority,
          content: encoder.encode(`${canonicalJson(document)}\n`),
        };
      }),
    });

    expect(result.blockers.map((blocker) => blocker.code)).toEqual(
      expect.arrayContaining(["KICAD_REPORT_BINDING_INVALID", "KICAD_REPORT_MISSING"]),
    );
    expect(
      result.evidence.some(
        (entry) => entry.parsedArtifactLogicalName?.endsWith("pcb_practices.json") === true,
      ),
    ).toBe(false);
  });

  it("does not call the backend when a request identity cannot be recomputed", async () => {
    let calls = 0;
    const result = await runFixture(CLEAN_MINIMAL_KICAD_PCB, {
      observe: () => { calls += 1; },
      mutateEngineering: (request) => ({
        ...request,
        analyzerProfile: {
          ...request.analyzerProfile,
          canonicalIdentity: canonicalIdentity(
            { forged: true },
            request.analyzerProfile.document.schemaVersion,
          ),
        },
      }),
    });

    expect(calls).toBe(0);
    expect(result.blockers.map((blocker) => blocker.code)).toEqual([
      "PCB_ENGINEERING_REQUEST_INVALID",
    ]);
  });

  it("does not let a request expand the analyzer-owned native board-version set", async () => {
    let calls = 0;
    const result = await runFixture(CLEAN_MINIMAL_KICAD_PCB, {
      observe: () => { calls += 1; },
      mutateEngineering: (request) => {
        const document = {
          ...request.analyzerProfile.document,
          sourceValidation: {
            mode: "production" as const,
            supportedBoardVersions: [
              ...PCB_PRACTICE_ANALYZER_SUPPORTED_BOARD_VERSIONS,
              99999999,
            ],
          },
        };
        return {
          ...request,
          analyzerProfile: {
            ...request.analyzerProfile,
            document,
            contentIdentity: contentIdentity(`${canonicalJson(document)}\n`),
            canonicalIdentity: canonicalIdentity(document, document.schemaVersion),
          },
        };
      },
    });

    expect(calls).toBe(0);
    expect(result.blockers.map((blocker) => blocker.code)).toEqual([
      "PCB_ENGINEERING_REQUEST_INVALID",
    ]);
  });

  it("rejects the former document-plus-identity-only constraint-set request shape", async () => {
    const standaloneSet = compileEngineeringConstraintSet({
      schemaVersion: ENGINEERING_CONSTRAINT_CONTEXT_SCHEMA,
      scopeFacts: [],
      inputBindings: [],
      checkerResults: [],
    });
    let calls = 0;
    const result = await runFixture(CLEAN_MINIMAL_KICAD_PCB, {
      observe: () => { calls += 1; },
      mutateEngineering: (request) => ({
        ...request,
        engineeringConstraintBinding: undefined,
        compiledConstraintSet: {
          document: standaloneSet,
          identity: standaloneSet.identity,
        },
      } as unknown as KicadPcbEngineeringRequest),
    });

    expect(calls).toBe(0);
    expect(result.blockers.map((blocker) => blocker.code)).toEqual([
      "PCB_ENGINEERING_REQUEST_INVALID",
    ]);
  });

  it("carries a full recompiled constraint binding and rejects a standalone self-hashed set", async () => {
    const constraintContext = {
      schemaVersion: ENGINEERING_CONSTRAINT_CONTEXT_SCHEMA,
      scopeFacts: [],
      inputBindings: [],
      checkerResults: [],
    } as const;
    const binding = compileEngineeringConstraintBinding(constraintContext);
    const compiledArtifact = jsonArtifactDraft({
      logicalName: "engineering/constraint-binding.json",
      value: binding,
      exactInputs: [requirements.identity, PCB_ENGINEERING_PRACTICE_CATALOG.identity],
      validationStatus: "pass",
    });
    const prerequisites = STAGE_ORDER.slice(
      0,
      STAGE_ORDER.indexOf("pcb_placement_routing"),
    ).map((stage): StageExecutionResult =>
      finalizeStageResult(
        stage as StageKey,
        stage === "simulation_checks" ? [compiledArtifact] : [],
        [],
        [],
        stage === "requirements" ? requirements : undefined,
      )
    );
    const approval: ApprovalRecord = {
      id: "approval_pcb_practice_constraint_fixture",
      kind: "requirements",
      projectId: "project_pcb_practice_constraint_fixture",
      runId: "run_pcb_practice_constraint_fixture",
      subjectDigest: requirements.identity.digest,
      policyVersion: "evleda-policy-v0",
      actor: {
        type: "human",
        id: "reviewer_pcb_practice_constraint_fixture",
        displayName: "PCB practice fixture reviewer",
        role: "requirements_reviewer",
      },
      scope: "Exact fixture requirements",
      rationale: "Deterministic constraint-set transport test",
      createdAt: "2026-09-05T00:00:00.000Z",
    };
    let captured: KicadBackendRequest | undefined;
    const backend = backendFor(CLEAN_MINIMAL_KICAD_PCB, (request) => {
      captured = structuredClone(request);
    });

    const result = await pcbPlacementRoutingStageExecutor.execute({
      projectId: "project_pcb_practice_constraint_fixture",
      runId: "run_pcb_practice_constraint_fixture",
      designRevisionId: "revision_pcb_practice_constraint_fixture",
      requirements,
      requirementsApproval: approval,
      profile: ROBOTICS_CONTROLLER_V0,
      upstream: prerequisites,
      upstreamSourceRevisionBindings: [],
      kicadBackend: backend,
    });

    expect(
      captured?.pcbEngineering?.engineeringConstraintBinding,
      JSON.stringify(result.blockers, null, 2),
    ).toMatchObject({
      logicalName: "pcb/engineering/constraint-binding.json",
      document: binding,
      canonicalIdentity: binding.identity,
    });
    expect(
      captured?.pcbEngineering?.engineeringConstraintBinding
        ?.document.compiledConstraintSetIdentity,
    ).toEqual(
      binding.compiledConstraintSet.identity,
    );
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(
      expect.arrayContaining([
        "PCB_ENGINEERING_COVERAGE_INCOMPLETE",
        "PCB_TRACE_WIDTH_ELECTRICAL_BASIS_MISSING",
      ]),
    );

    const standaloneSet = compileEngineeringConstraintSet(constraintContext);
    const standaloneArtifact = jsonArtifactDraft({
      logicalName: "engineering/constraint-set.json",
      value: standaloneSet,
      exactInputs: [requirements.identity, PCB_ENGINEERING_PRACTICE_CATALOG.identity],
      validationStatus: "pass",
    });
    const standalonePrerequisites = STAGE_ORDER.slice(
      0,
      STAGE_ORDER.indexOf("pcb_placement_routing"),
    ).map((stage): StageExecutionResult =>
      finalizeStageResult(
        stage as StageKey,
        stage === "simulation_checks" ? [standaloneArtifact] : [],
        [],
        [],
        stage === "requirements" ? requirements : undefined,
      )
    );
    let standaloneBackendCalls = 0;
    const standaloneResult = await pcbPlacementRoutingStageExecutor.execute({
      projectId: "project_pcb_practice_constraint_fixture",
      runId: "run_pcb_practice_constraint_fixture",
      designRevisionId: "revision_pcb_practice_constraint_fixture",
      requirements,
      requirementsApproval: approval,
      profile: ROBOTICS_CONTROLLER_V0,
      upstream: standalonePrerequisites,
      upstreamSourceRevisionBindings: [],
      kicadBackend: backendFor(CLEAN_MINIMAL_KICAD_PCB, () => {
        standaloneBackendCalls += 1;
      }),
    });

    expect(standaloneBackendCalls).toBe(0);
    expect(standaloneResult.blockers.map((blocker) => blocker.code)).toContain(
      "PCB_ENGINEERING_CONSTRAINT_SET_INVALID",
    );
  });
});
