import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ApplicationService } from "../../src/application/application-service.js";
import { localHumanContext } from "../../src/contracts/capabilities.js";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import type { StageKey } from "../../src/domain/stages.js";
import type { HumanActor } from "../../src/domain/types.js";
import type {
  SubmitExternalEvidenceCurrentInput,
  SubmitExternalEvidenceInput
} from "../../src/contracts/operations.js";
import {
  artifactDraft,
  evidenceDraft,
  expectedSourceRevisionDigest,
  finalizeStageResult,
  sortedIdentities
} from "../../src/generators/draft-utils.js";
import {
  createBringupPackageStageExecutor,
  physicalAcceptanceContract
} from "../../src/generators/bringup-generator.js";
import {
  REFERENCE_KICAD_ANALYZER_TOOLS,
  REFERENCE_KICAD_REQUEST_BINDING_SCHEMA,
  REFERENCE_KICAD_REPORT_SCHEMA
} from "../../src/integrations/reference-kicad-backend.js";
import { ROBOTICS_CONTROLLER_V0 } from "../../src/knowledge/reference-controller-v0.js";
import {
  REFERENCE_PHYSICAL_ACCEPTANCE_POLICY,
  type PhysicalAcceptancePolicy
} from "../../src/knowledge/physical-acceptance-policy.js";
import {
  ENGINEERING_CONSTRAINT_CONTEXT_SCHEMA,
  compileEngineeringConstraintBinding,
  type EngineeringCheckerResult,
  type EngineeringInputBinding,
  type EngineeringScopeFact
} from "../../src/engineering/constraint-compiler.js";
import {
  PCB_ENGINEERING_PRACTICE_CATALOG,
  PCB_ENGINEERING_REQUIRED_INPUTS,
  PCB_ENGINEERING_SCOPE_PREDICATES,
  type PcbEngineeringRequiredInput
} from "../../src/knowledge/pcb-engineering-practices.js";
import { buildPcbPracticeAnalysisProfile } from "../../src/generators/pcb-generator.js";
import {
  PCB_LAYOUT_QUALITY_POLICY,
  PCB_ROUTE_QUALITY_RULE_DECK,
  REV_A_PROOF_FIXTURE_POLICY,
  buildPcbLayoutPlan
} from "../../src/generators/pcb-layout-plan.js";
import { analyzeKicadPcbPractices } from "../../src/integrations/pcb-practice-analyzer.js";
import {
  HashChainAuditLog,
  type HashChainAuditLogOptions
} from "../../src/persistence/audit-log.js";
import { FileContentStore } from "../../src/persistence/content-store.js";
import {
  AtomicStateStore,
  type AtomicStateStoreOptions
} from "../../src/persistence/state-store.js";
import type {
  ArtifactDraft,
  CandidateStageContext,
  EvidenceDraft,
  KicadEvledaCheckReportKind,
  KicadNativeReportKind,
  KicadNativeToolIdentity,
  KicadReportBinding,
  KicadReportInputBinding,
  StageContextByKey,
  StageExecutionResult,
  StageRegistryContract
} from "../../src/workflow/contracts.js";
import {
  FIRMWARE_TARGET_BUILD_CONFIGURATION_SCHEMA,
  KICAD_NATIVE_REPORT_COMMAND_PREFIXES,
  buildKicadPcbEngineeringDecisionSummary
} from "../../src/workflow/contracts.js";
import type {
  AuditLogPort,
  ContentStorePort,
  StageContextProvider,
  StateStorePort
} from "../../src/application/ports.js";
import { CLEAN_MINIMAL_KICAD_PCB } from "../helpers/kicad-reports.js";
import {
  passingFirmwareTargetBuildBackend
} from "../helpers/firmware-compile.js";

export const validPrompt =
  "Build a two-channel brushed motor controller for a 7-16.8 V DC battery. " +
  "Each motor is limited to 0.5 A RMS. Provide USB-C, CAN, UART, I2C, SPI, " +
  "two quadrature encoders, and SWD programming.";

export const reviewer: HumanActor = {
  type: "human",
  id: "reviewer-1",
  displayName: "Requirements Reviewer",
  role: "requirements_reviewer"
};

export const qualifier: HumanActor = {
  type: "human",
  id: "qualifier-1",
  displayName: "Hardware Qualifier",
  role: "hardware_qualifier"
};

const fixturePhysicalAcceptancePolicy: PhysicalAcceptancePolicy = {
  ...structuredClone(REFERENCE_PHYSICAL_ACCEPTANCE_POLICY),
  approvalStatus: "approved",
  unresolvedItems: [],
  cases: REFERENCE_PHYSICAL_ACCEPTANCE_POLICY.cases.map((entry) => ({
    ...structuredClone(entry),
    minimumDurationMs: 1_000
  })),
  tests: REFERENCE_PHYSICAL_ACCEPTANCE_POLICY.tests.map((test) =>
    test.kind === "numeric_range"
      ? {
          ...structuredClone(test),
          minimum: test.minimum ?? (test.unit === "degC" ? -40 : test.unit === "A" ? 0.85 : 1),
          maximum: test.maximum ?? (test.unit === "degC" ? 85 : test.unit === "A" ? 1.15 : 1_000_000)
        }
      : { ...structuredClone(test), expected: test.expected ?? true }
  )
};

const fixtureBringupExecutor = createBringupPackageStageExecutor(
  fixturePhysicalAcceptancePolicy
);

const fixtureEngineeringIdentity = (kind: string, value: unknown) =>
  canonicalIdentity({ kind, value }, `test.application.${kind}.v1`);

export const fixtureEngineeringConstraintBinding = (() => {
  const scopeFacts: readonly EngineeringScopeFact[] = PCB_ENGINEERING_SCOPE_PREDICATES.map(
    (predicate): EngineeringScopeFact => {
      const value =
        predicate === "supported_low_voltage_rigid_pcb" ||
        predicate === "thermal_or_exposed_pad_present";
      return {
        predicate,
        value,
        identity: fixtureEngineeringIdentity("scope-fact", { predicate, value })
      };
    }
  );
  const inputBindings: readonly EngineeringInputBinding[] =
    PCB_ENGINEERING_REQUIRED_INPUTS.map(
      (inputId: PcbEngineeringRequiredInput): EngineeringInputBinding => ({
        inputId,
        identity: fixtureEngineeringIdentity("input", inputId)
      })
    );
  const checkerResults: readonly EngineeringCheckerResult[] =
    PCB_ENGINEERING_PRACTICE_CATALOG.rules.flatMap((rule) =>
      rule.checkerIds.map((checkerId): EngineeringCheckerResult => ({
        ruleId: rule.id,
        checkerId,
        status: "pass",
        resultIdentity: fixtureEngineeringIdentity("checker", { ruleId: rule.id, checkerId }),
        exactInputIdentities: rule.requiredInputs.map(
          (inputId) => inputBindings.find((binding) => binding.inputId === inputId)!.identity
        ),
        sourceIds: rule.sourceIds,
        numericClaimIds: rule.numericClaims.map((claim) => claim.id),
        modelIds: rule.modelIds
      }))
    );
  return compileEngineeringConstraintBinding({
    schemaVersion: ENGINEERING_CONSTRAINT_CONTEXT_SCHEMA,
    scopeFacts,
    inputBindings,
    checkerResults
  });
})();

const fixturePcbLayoutPlan = buildPcbLayoutPlan(ROBOTICS_CONTROLLER_V0);
const fixturePcbAnalyzerProfile = buildPcbPracticeAnalysisProfile(
  ROBOTICS_CONTROLLER_V0,
  fixturePcbLayoutPlan
);

const artifactsForStage: Readonly<Record<Exclude<StageKey, "requirements">, readonly [string, string][]>> = {
  system_architecture: [["architecture/system-architecture.json", "application/json"]],
  component_selection: [
    ["components/core-bom.csv", "text/csv"],
    ["components/footprint-map.json", "application/json"]
  ],
  schematic: [
    ["kicad/controller.kicad_pro", "application/json"],
    ["kicad/controller.kicad_sch", "application/x-kicad-schematic"]
  ],
  firmware_contract: [
    ["firmware/board-contract.json", "application/json"],
    ["firmware/include/board_contract.h", "text/x-c"],
    ["firmware/src/board_contract.c", "text/x-c"],
    ["firmware/tests/board_contract_validation.c", "text/x-c"],
    ["firmware/CMakeLists.txt", "text/plain"],
    ["firmware/target/startup_stm32g0b1.s", "text/x-asm"],
    ["firmware/target/platform_stm32g0b1.c", "text/x-c"],
    ["firmware/target/STM32G0B1CET6.ld", "text/plain; charset=utf-8"],
    ["firmware/reports/schematic-pin-map-parity.json", "application/json"],
    ["firmware/reports/compile-validation.json", "application/json"]
  ],
  simulation_checks: [],
  pcb_placement_routing: [
    ["pcb/layout-routing-plan.json", "application/json"],
    ["pcb/engineering/analyzer-profile.json", "application/json"],
    ["pcb/engineering/practice-catalog.json", "application/json"],
    ["pcb/engineering/route-quality-policy.json", "application/json"],
    ["pcb/engineering/route-quality-rule-deck.json", "application/json"],
    ["pcb/engineering/proof-fixture-policy.json", "application/json"],
    ["pcb/engineering/constraint-binding.json", "application/json"],
    ["kicad/controller.kicad_pcb", "application/x-kicad-pcb"],
    ["renders/controller.svg", "image/svg+xml"]
  ],
  manufacturing_package: [
    ["manufacturing/manufacturing-plan.json", "application/json"],
    ["manufacturing/bom.csv", "text/csv; charset=utf-8"],
    ["manufacturing/gerbers/controller-F_Cu.gbr", "application/vnd.gerber"],
    ["manufacturing/drill/controller.drl", "application/x-excellon"],
    ["manufacturing/positions.csv", "text/csv; charset=utf-8"],
    ["manufacturing/cam-manifest.json", "application/json"]
  ],
  bringup_package: [
    ["bringup/bringup-plan.json", "application/json"],
    ["bringup/physical-acceptance.json", "application/json"],
    ["bringup/bringup-plan.md", "text/markdown"]
  ]
};

type KicadFixtureStage = Extract<
  StageKey,
  "schematic" | "pcb_placement_routing" | "manufacturing_package"
>;

const kicadReportKinds: Readonly<
  Record<
    KicadFixtureStage,
    {
      readonly native: readonly KicadNativeReportKind[];
      readonly derived: readonly KicadEvledaCheckReportKind[];
    }
  >
> = {
  schematic: {
    native: ["erc", "schematic_netlist"],
    derived: ["connectivity"]
  },
  pcb_placement_routing: {
    native: ["drc", "schematic_netlist", "board_statistics", "board_netlist"],
    derived: ["schematic_parity", "connectivity", "geometry", "pcb_practices"]
  },
  manufacturing_package: {
    native: ["drc", "schematic_netlist", "board_statistics", "board_netlist"],
    derived: [
      "schematic_parity",
      "bom_parity",
      "bom_export",
      "gerber_export",
      "drill_export",
      "position_export",
      "cam_manifest"
    ]
  }
};

type SimulationReportDefinition = readonly [logicalName: string, claim: string];

const simulationReportDefinitions: readonly SimulationReportDefinition[] = [
  ["simulation/power_tree_operating_points.json", "Modeled power_tree_operating_points coverage"],
  ["simulation/logic_rail_load_budget.json", "Modeled logic_rail_load_budget coverage"],
  ["simulation/motor_current_chop.json", "Modeled motor_current_chop coverage"],
  ["simulation/motor_driver_thermal.json", "Modeled motor_driver_thermal coverage"],
  ["simulation/fault_and_reset.json", "Modeled fault_and_reset coverage"]
];

const KICAD_TOOL: KicadNativeToolIdentity = {
  name: "kicad-cli",
  version: "10.0.3-test",
  adapter: "kicad_cli",
  executablePath: "C:/fixtures/kicad-cli.exe",
  executableDigest: contentIdentity("fixture-kicad-cli-10.0.3").digest,
  capabilityProfile: "application-fixture:kicad-result-v2"
};
const FIRMWARE_TOOL = { name: "clang", version: "99.0.0-test", adapter: "external" as const };
const SIMULATION_TOOL = {
  name: "fixture-analytic-simulator",
  version: "1",
  adapter: "external" as const
};

const kicadStagePath = (stage: KicadFixtureStage): string =>
  stage === "pcb_placement_routing"
    ? "pcb"
    : stage === "manufacturing_package"
      ? "manufacturing"
      : stage;

const nativeReportLogicalName = (
  stage: KicadFixtureStage,
  kind: KicadNativeReportKind
): string => {
  const stagePath = kicadStagePath(stage);
  switch (kind) {
    case "erc":
    case "drc":
      return `reports/kicad/${stagePath}/${kind}.json`;
    case "schematic_netlist":
      return `reports/kicad/${stagePath}/native/schematic-netlist.kicad_net`;
    case "board_statistics":
      return `reports/kicad/${stagePath}/native/board-statistics.json`;
    case "board_netlist":
      return `reports/kicad/${stagePath}/native/board-netlist.d356`;
  }
};

const derivedReportLogicalName = (
  stage: KicadFixtureStage,
  kind: KicadEvledaCheckReportKind
): string =>
  `reports/kicad/${kicadStagePath(stage)}/${kind.replaceAll("_", "-")}.json`;

interface KicadFixtureReports {
  readonly artifacts: readonly ArtifactDraft[];
  readonly evidence: readonly EvidenceDraft[];
}

const kicadFixtureReports = (
  stage: KicadFixtureStage,
  designRevisionId: string,
  exactInputs: ArtifactDraft["exactInputs"],
  generatedArtifacts: readonly ArtifactDraft[]
): KicadFixtureReports => {
  const sourceRevisionDigest = expectedSourceRevisionDigest(stage, exactInputs);
  const pcbArtifact = generatedArtifacts.find((artifact) =>
    artifact.logicalName.endsWith(".kicad_pcb")
  );
  if (stage === "pcb_placement_routing" && pcbArtifact === undefined) {
    throw new Error("PCB report fixture requires the exact generated KiCad PCB artifact");
  }
  const sourceBindings: readonly KicadReportBinding[] = [
    {
      logicalName: `fixture/${kicadStagePath(stage)}/source.kicad_sch`,
      identity: contentIdentity(`fixture-source:${stage}:${sourceRevisionDigest}`)
    },
    ...(stage === "pcb_placement_routing"
      ? [{
          logicalName: `fixture/${kicadStagePath(stage)}/controller.kicad_pcb`,
          identity: pcbArtifact!.identity
        }]
      : [])
  ];
  const nativeArtifacts = new Map<KicadNativeReportKind, ArtifactDraft>();
  const artifacts: ArtifactDraft[] = [];
  const evidence: EvidenceDraft[] = [];
  for (const kind of kicadReportKinds[stage].native) {
    const logicalName = nativeReportLogicalName(stage, kind);
    const content = Buffer.from(`native:${stage}:${kind}:${sourceRevisionDigest}\n`, "utf8");
    const authority = {
      kind: "kicad_cli_output" as const,
      tool: KICAD_TOOL,
      command: [
        ...KICAD_NATIVE_REPORT_COMMAND_PREFIXES[kind],
        "--output",
        logicalName,
        `fixture-${designRevisionId}`
      ],
      outputIdentity: contentIdentity(content),
      sourceBindings
    };
    const reportInputs = sortedIdentities([
      ...exactInputs,
      ...sourceBindings.map((binding) => binding.identity),
      canonicalIdentity(authority, "evleda.kicad-cli-report-authority.v2")
    ]);
    const artifact = artifactDraft({
      logicalName,
      mediaType: "application/octet-stream",
      content,
      exactInputs: reportInputs,
      tool: KICAD_TOOL,
      validationStatus: "pass"
    });
    nativeArtifacts.set(kind, artifact);
    artifacts.push(artifact);
    evidence.push(
      evidenceDraft({
        evidenceClass: "kicad_native",
        claim: `Direct kicad-cli ${kind} output for source revision ${sourceRevisionDigest}.`,
        subjectDigests: [artifact.identity.digest],
        rawArtifactLogicalName: artifact.logicalName,
        exactInputs: reportInputs,
        tool: KICAD_TOOL,
        validationStatus: "pass"
      })
    );
  }

  const nativeInputsFor = (
    kind: KicadEvledaCheckReportKind
  ): readonly KicadNativeReportKind[] => {
    switch (kind) {
      case "connectivity":
        return nativeArtifacts.has("board_netlist")
          ? ["schematic_netlist", "board_netlist"]
          : ["schematic_netlist"];
      case "geometry":
        return ["board_statistics"];
      case "pcb_practices":
        return ["drc", "board_statistics"];
      case "bom_parity":
        return ["schematic_netlist", "board_netlist"];
      case "cam_manifest":
        return ["drc", "board_statistics"];
      default:
        return ["drc"];
    }
  };
  const artifactInputsFor = (
    kind: KicadEvledaCheckReportKind
  ): readonly ArtifactDraft[] => {
    const matches = (artifact: ArtifactDraft): boolean => {
      switch (kind) {
        case "geometry":
          return artifact.logicalName.endsWith(".kicad_pcb");
        case "pcb_practices":
          return (
            artifact.logicalName.endsWith(".kicad_pcb") ||
            artifact.logicalName === "pcb/layout-routing-plan.json" ||
            artifact.logicalName.startsWith("pcb/engineering/")
          );
        case "bom_parity":
        case "bom_export":
          return artifact.logicalName === "manufacturing/bom.csv";
        case "gerber_export":
          return artifact.logicalName.endsWith(".gbr");
        case "drill_export":
          return artifact.logicalName.endsWith(".drl");
        case "position_export":
          return artifact.logicalName === "manufacturing/positions.csv";
        case "cam_manifest":
          return artifact.logicalName === "manufacturing/cam-manifest.json";
        default:
          return false;
      }
    };
    return generatedArtifacts.filter(matches);
  };
  for (const kind of kicadReportKinds[stage].derived) {
    const nativeInputs = nativeInputsFor(kind).map(
      (nativeKind) => nativeArtifacts.get(nativeKind)!
    );
    const artifactInputs = artifactInputsFor(kind);
    const inputBindings: readonly KicadReportInputBinding[] = [
      ...nativeInputs.map((artifact) => ({
        kind: "native_report" as const,
        logicalName: artifact.logicalName,
        identity: artifact.identity
      })),
      ...artifactInputs.map((artifact) => ({
        kind: "artifact" as const,
        logicalName: artifact.logicalName,
        identity: artifact.identity
      })),
      ...sourceBindings.map((binding) => ({ kind: "source" as const, ...binding }))
    ];
    const tool = REFERENCE_KICAD_ANALYZER_TOOLS[kind];
    const authority = {
      kind: "evleda_analyzer" as const,
      analyzerId: tool.capabilityProfile,
      tool,
      inputBindings
    };
    const artifactFor = (logicalName: string): ArtifactDraft => {
      const artifact = artifactInputs.find((candidate) => candidate.logicalName === logicalName);
      if (artifact === undefined) throw new Error(`Missing PCB engineering fixture ${logicalName}`);
      return artifact;
    };
    const engineeringInputs = kind === "pcb_practices"
      ? {
          layoutPlan: {
            logicalName: "pcb/layout-routing-plan.json",
            contentIdentity: artifactFor("pcb/layout-routing-plan.json").identity
          },
          analyzerProfile: {
            logicalName: "pcb/engineering/analyzer-profile.json",
            contentIdentity: artifactFor("pcb/engineering/analyzer-profile.json").identity,
            canonicalIdentity: canonicalIdentity(
              fixturePcbAnalyzerProfile,
              fixturePcbAnalyzerProfile.schemaVersion
            )
          },
          practiceCatalog: {
            logicalName: "pcb/engineering/practice-catalog.json",
            contentIdentity: artifactFor("pcb/engineering/practice-catalog.json").identity,
            canonicalIdentity: PCB_ENGINEERING_PRACTICE_CATALOG.identity
          },
          routeQualityPolicy: {
            logicalName: "pcb/engineering/route-quality-policy.json",
            contentIdentity: artifactFor("pcb/engineering/route-quality-policy.json").identity,
            canonicalIdentity: PCB_LAYOUT_QUALITY_POLICY.identity,
            captureIdentity: PCB_LAYOUT_QUALITY_POLICY.captureIdentity
          },
          routeQualityRuleDeck: {
            logicalName: "pcb/engineering/route-quality-rule-deck.json",
            contentIdentity: artifactFor("pcb/engineering/route-quality-rule-deck.json").identity,
            canonicalIdentity: PCB_ROUTE_QUALITY_RULE_DECK.identity
          },
          proofFixturePolicy: {
            logicalName: "pcb/engineering/proof-fixture-policy.json",
            contentIdentity: artifactFor("pcb/engineering/proof-fixture-policy.json").identity,
            canonicalIdentity: REV_A_PROOF_FIXTURE_POLICY.identity
          },
          engineeringConstraintBinding: {
            logicalName: "pcb/engineering/constraint-binding.json",
            contentIdentity: artifactFor("pcb/engineering/constraint-binding.json").identity,
            canonicalIdentity: fixtureEngineeringConstraintBinding.identity,
            compiledConstraintSetIdentity:
              fixtureEngineeringConstraintBinding.compiledConstraintSetIdentity
          }
        }
      : null;
    let payload: Readonly<Record<string, unknown>> = { fixture: true };
    let requestBinding: Readonly<Record<string, unknown>> | undefined;
    if (kind === "pcb_practices" && engineeringInputs !== null) {
      const board = artifactFor("kicad/controller.kicad_pcb");
      const analysis = analyzeKicadPcbPractices(
        CLEAN_MINIMAL_KICAD_PCB,
        fixturePcbAnalyzerProfile,
        { sourcePath: board.logicalName }
      );
      const engineeringSummary = buildKicadPcbEngineeringDecisionSummary(
        analysis,
        fixtureEngineeringConstraintBinding
      );
      const requestBindingPreimage = {
        schemaVersion: REFERENCE_KICAD_REQUEST_BINDING_SCHEMA,
        request: {
          schemaVersion: "evleda.kicad-request.v2",
          stage: "pcb_placement_routing",
          expectedSourceRevisionDigest: sourceRevisionDigest,
          requirementsIdentity: exactInputs[0]!,
          upstreamArtifactIdentities: [],
          pcbEngineering: engineeringInputs
        },
        templateInstantiation: { fixture: "application-service-self-contained-report" }
      };
      requestBinding = {
        ...requestBindingPreimage,
        identity: canonicalIdentity(
          requestBindingPreimage,
          REFERENCE_KICAD_REQUEST_BINDING_SCHEMA
        )
      };
      payload = {
        engineeringInputs,
        analysisIdentity: canonicalIdentity(analysis, analysis.schemaVersion),
        analysis,
        engineeringSummary
      };
    }
    const content = Buffer.from(
      `${canonicalJson({
        schemaVersion: REFERENCE_KICAD_REPORT_SCHEMA,
        kind,
        validationStatus: "pass",
        ...(kind === "pcb_practices"
          ? {
              classification: "candidate-validation",
              lifecycle: "candidate",
              releaseAuthorized: false,
              requestBinding
            }
          : {}),
        sourceRevisionDigest,
        authority,
        payload
      })}\n`,
      "utf8"
    );
    const reportInputs = sortedIdentities([
      ...exactInputs,
      ...inputBindings.map((binding) => binding.identity),
      canonicalIdentity(authority, "evleda.kicad-analyzer-report-authority.v2")
    ]);
    const artifact = artifactDraft({
      logicalName: derivedReportLogicalName(stage, kind),
      mediaType: "application/json",
      content,
      exactInputs: reportInputs,
      derivedFrom: [...nativeInputs, ...artifactInputs].map((input) => input.logicalName),
      tool,
      validationStatus: "pass"
    });
    artifacts.push(artifact);
    evidence.push(
      evidenceDraft({
        evidenceClass: "evleda_check",
        claim: `EvlEDA ${tool.capabilityProfile} ${kind} check over exact native inputs for source revision ${sourceRevisionDigest}.`,
        subjectDigests: [artifact.identity.digest],
        parsedArtifactLogicalName: artifact.logicalName,
        exactInputs: reportInputs,
        tool,
        validationStatus: "pass"
      })
    );
  }
  return { artifacts, evidence };
};

export const fixtureRegistry: StageRegistryContract = {
  orderedStages: () => [
    "requirements",
    "system_architecture",
    "component_selection",
    "schematic",
    "firmware_contract",
    "simulation_checks",
    "pcb_placement_routing",
    "manufacturing_package",
    "bringup_package"
  ],
  has: () => true,
  get: <K extends StageKey>(stage: K) => ({
    stage,
    execute: async (context: StageContextByKey[K]): Promise<StageExecutionResult<K>> => {
      if (stage === "requirements") {
        throw new Error("Requirements are handled by the application service");
      }
      const candidateStage = stage as Exclude<StageKey, "requirements">;
      const candidate = context as CandidateStageContext;
      if (candidateStage === "bringup_package") {
        return fixtureBringupExecutor.execute(
          candidate as StageContextByKey["bringup_package"]
        ) as Promise<StageExecutionResult<K>>;
      }
      const exactInputs = [candidate.requirements.identity];
      const simulationReports = candidateStage === "simulation_checks"
        ? simulationReportDefinitions
        : [];
      const stageTool = ["schematic", "pcb_placement_routing", "manufacturing_package"].includes(
        candidateStage
      )
        ? KICAD_TOOL
        : candidateStage === "simulation_checks"
          ? SIMULATION_TOOL
          : undefined;
      const artifactSpecifications: readonly (readonly [string, string])[] = [
        ...artifactsForStage[candidateStage],
        ...simulationReports.map(([logicalName]) => [logicalName, "application/json"] as const)
      ];
      const contentFor = (logicalName: string): string | Uint8Array => {
        if (logicalName === "kicad/controller.kicad_pcb") {
          return CLEAN_MINIMAL_KICAD_PCB;
        }
        if (logicalName === "pcb/layout-routing-plan.json") {
          return `${canonicalJson(fixturePcbLayoutPlan)}\n`;
        }
        if (logicalName === "pcb/engineering/analyzer-profile.json") {
          return `${canonicalJson(fixturePcbAnalyzerProfile)}\n`;
        }
        if (logicalName === "pcb/engineering/practice-catalog.json") {
          return `${canonicalJson(PCB_ENGINEERING_PRACTICE_CATALOG)}\n`;
        }
        if (logicalName === "pcb/engineering/route-quality-policy.json") {
          return `${canonicalJson(PCB_LAYOUT_QUALITY_POLICY)}\n`;
        }
        if (logicalName === "pcb/engineering/route-quality-rule-deck.json") {
          return `${canonicalJson(PCB_ROUTE_QUALITY_RULE_DECK)}\n`;
        }
        if (logicalName === "pcb/engineering/proof-fixture-policy.json") {
          return `${canonicalJson(REV_A_PROOF_FIXTURE_POLICY)}\n`;
        }
        if (logicalName === "pcb/engineering/constraint-binding.json") {
          return `${canonicalJson(fixtureEngineeringConstraintBinding)}\n`;
        }
        if (logicalName === "bringup/bringup-plan.json") {
          return `${canonicalJson({ schemaVersion: "evleda.bringup-plan.v1", lifecycle: "candidate", steps: [] })}\n`;
        }
        if (logicalName === "bringup/physical-acceptance.json") {
          return `${canonicalJson(physicalAcceptanceContract(ROBOTICS_CONTROLLER_V0, fixturePhysicalAcceptancePolicy))}\n`;
        }
        if (logicalName === "firmware/reports/compile-validation.json") {
          return `${canonicalJson({ schemaVersion: "evleda.firmware-compile-report.v1", status: "pass" })}\n`;
        }
        return `${logicalName}\n${candidate.designRevisionId}\n`;
      };
      let artifacts = artifactSpecifications.map(([logicalName, mediaType]) =>
        artifactDraft({
          logicalName,
          mediaType,
          content: contentFor(logicalName),
          exactInputs,
          ...(logicalName === "firmware/reports/compile-validation.json"
            ? { tool: FIRMWARE_TOOL }
            : stageTool === undefined
              ? {}
              : { tool: stageTool }),
          validationStatus: "pass"
        })
      );
      if (candidateStage === "firmware_contract") {
        const targetBackend = passingFirmwareTargetBuildBackend();
        const targetSourceNames = [
          "firmware/include/board_contract.h",
          "firmware/src/board_contract.c",
          "firmware/target/startup_stm32g0b1.s",
          "firmware/target/platform_stm32g0b1.c",
          "firmware/target/STM32G0B1CET6.ld"
        ] as const;
        const targetSources = targetSourceNames.map((logicalName) => {
          const artifact = artifacts.find((entry) => entry.logicalName === logicalName)!;
          return { logicalName, content: Buffer.from(artifact.content), identity: artifact.identity };
        });
        const targetSourceIdentity = canonicalIdentity({
          projectId: candidate.projectId,
          runId: candidate.runId,
          designRevisionId: candidate.designRevisionId,
          profileIdentity: canonicalIdentity(ROBOTICS_CONTROLLER_V0, "evleda.reference-profile.v1"),
          generatedSources: targetSources.map(({ logicalName, identity }) => ({ logicalName, identity }))
        }, "evleda.firmware-target-build-source.v1");
        const targetConfigurationIdentity = canonicalIdentity(
          targetBackend.configuration,
          FIRMWARE_TARGET_BUILD_CONFIGURATION_SCHEMA
        );
        const targetResult = await targetBackend.execute({
          schemaVersion: "evleda.firmware-target-build-request.v1",
          sourceOrigin: "evleda-deterministic-generator",
          sourceRevisionDigest: targetSourceIdentity.digest,
          configurationIdentity: targetConfigurationIdentity,
          sources: targetSources
        });
        if (targetResult.status !== "pass" || targetResult.toolchainIdentity === null) {
          throw new Error("Fixture target build did not pass");
        }
        const gcc = targetBackend.configuration.toolchainFiles.find((file) => file.role === "gcc")!;
        const targetTool = {
          name: "arm-none-eabi-gcc",
          version: targetResult.gccVersion!,
          adapter: "external" as const,
          executablePath: gcc.path,
          executableDigest: gcc.identity.digest,
          capabilityProfile: "stm32g0b1cet6:cortex-m0plus:freestanding:candidate-only"
        };
        const targetBaseInputs = sortedIdentities([
          ...exactInputs,
          ...targetSources.map((source) => source.identity),
          targetSourceIdentity,
          targetConfigurationIdentity,
          ...targetBackend.configuration.toolchainFiles.map((file) => file.identity),
          ...targetBackend.configuration.supportFiles.map((file) => file.identity),
          ...targetBackend.configuration.embeddedFiles.map((file) => file.identity),
          targetResult.toolchainIdentity
        ]);
        const outputArtifacts = targetResult.outputs.map((output) => artifactDraft({
          logicalName: output.logicalName,
          mediaType: output.mediaType,
          content: output.content,
          exactInputs: targetBaseInputs,
          derivedFrom: targetSourceNames,
          tool: targetTool,
          validationStatus: "pass"
        }));
        const targetReport = {
          schemaVersion: "evleda.firmware-target-build-report.v1",
          classification: "candidate-only",
          lifecycle: "candidate",
          releaseAuthorized: false,
          qualificationEstablished: false,
          flashable: false,
          deploymentDisposition: targetResult.deploymentDisposition,
          status: targetResult.status,
          code: targetResult.code,
          message: targetResult.message,
          target: {
            partNumber: "STM32G0B1CET6",
            cpu: "cortex-m0plus",
            targetTriple: targetResult.targetTriple
          },
          sourceRevision: {
            projectId: candidate.projectId,
            runId: candidate.runId,
            designRevisionId: candidate.designRevisionId,
            targetBuildSourceIdentity: targetSourceIdentity,
            generatedSources: targetSources.map(({ logicalName, identity }) => ({ logicalName, identity }))
          },
          toolchain: {
            provisionedConfiguration: targetBackend.configuration,
            provisionedConfigurationIdentity: targetConfigurationIdentity,
            toolchainIdentity: targetResult.toolchainIdentity
          },
          invocations: targetResult.steps,
          outputs: targetResult.outputs.map(({ kind, logicalName, mediaType, identity }) => ({
            kind,
            logicalName,
            mediaType,
            identity
          })),
          limitations: [
            "Candidate target output is not authorization to flash or deploy.",
            "Hardware behavior remains unverified.",
            "Physical fault paths remain unverified.",
            "No output establishes qualification or release."
          ]
        } as const;
        const reportArtifact = artifactDraft({
          logicalName: "firmware/reports/stm32g0-target-build.json",
          mediaType: "application/json",
          content: `${canonicalJson(targetReport)}\n`,
          exactInputs: sortedIdentities([
            ...targetBaseInputs,
            ...targetResult.outputs.map((output) => output.identity)
          ]),
          derivedFrom: [
            ...targetSourceNames,
            ...targetResult.outputs.map((output) => output.logicalName)
          ],
          tool: targetTool,
          validationStatus: "pass"
        });
        artifacts = [...artifacts, ...outputArtifacts, reportArtifact];
      }
      if (candidateStage === "manufacturing_package") {
        const manifestIndex = artifacts.findIndex(
          (artifact) => artifact.logicalName === "manufacturing/cam-manifest.json"
        );
        const camOutputs = artifacts.filter(
          (artifact) =>
            artifact.logicalName === "manufacturing/bom.csv" ||
            artifact.logicalName === "manufacturing/positions.csv" ||
            artifact.logicalName.startsWith("manufacturing/gerbers/") ||
            artifact.logicalName.startsWith("manufacturing/drill/")
        );
        artifacts = [...artifacts];
        artifacts[manifestIndex] = artifactDraft({
          logicalName: "manufacturing/cam-manifest.json",
          mediaType: "application/json",
          content: `${canonicalJson({
            schemaVersion: "evleda.reference-kicad-cam-manifest.v1",
            artifacts: camOutputs.map((artifact) => ({
              logicalName: artifact.logicalName,
              identity: artifact.identity
            }))
          })}\n`,
          exactInputs,
          tool: KICAD_TOOL,
          validationStatus: "pass"
        });
      }
      let evidence = simulationReports.map(([logicalName, claim]) => {
        const artifact = artifacts.find((entry) => entry.logicalName === logicalName)!;
        return evidenceDraft({
          evidenceClass: "evleda_check",
          claim,
          subjectDigests: [artifact.identity.digest],
          rawArtifactLogicalName: artifact.logicalName,
          exactInputs,
          tool: stageTool!,
          validationStatus: "pass"
        });
      });
      if (
        candidateStage === "schematic" ||
        candidateStage === "pcb_placement_routing" ||
        candidateStage === "manufacturing_package"
      ) {
        const reports = kicadFixtureReports(
          candidateStage,
          candidate.designRevisionId,
          exactInputs,
          artifacts
        );
        artifacts = [...artifacts, ...reports.artifacts];
        evidence = [...evidence, ...reports.evidence];
      }
      return finalizeStageResult(stage, artifacts, evidence, []) as StageExecutionResult<K>;
    }
  }),
  execute: async <K extends StageKey>(
    stage: K,
    context: StageContextByKey[K]
  ): Promise<StageExecutionResult<K>> => fixtureRegistry.get(stage).execute(context)
};

const roots: string[] = [];
const applications: { readonly root: string; readonly service: ApplicationService }[] = [];
let registryTail: Promise<void> = Promise.resolve();

const withRegistryLock = async <Result>(work: () => Promise<Result>): Promise<Result> => {
  const previous = registryTail;
  let release!: () => void;
  registryTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
};

const pathContains = (parent: string, candidate: string): boolean => {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

const rootsOverlap = (left: string, right: string): boolean =>
  pathContains(left, right) || pathContains(right, left);

const rootKey = (root: string): string => {
  const resolved = path.resolve(root);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
};

const disposeTrackedApplicationRoots = async (timeoutMs?: number): Promise<void> =>
  withRegistryLock(async () => {
  const pendingApplications = applications.splice(0);
  const pendingRoots = [...new Map(
    roots.splice(0).map((root) => [rootKey(root), path.resolve(root)] as const)
  ).values()];
  const closeResults = await Promise.allSettled(
    pendingApplications.map(({ service }) => service.close(
      timeoutMs === undefined ? {} : { timeoutMs }
    ))
  );
  const unsafeRoots = new Set<string>();
  const failures: unknown[] = [];
  closeResults.forEach((result, index) => {
    if (result.status === "fulfilled") return;
    const pending = pendingApplications[index]!;
    unsafeRoots.add(pending.root);
    applications.push(pending);
    failures.push(result.reason);
  });
  const retainedRoots = pendingRoots.filter((root) =>
    [...unsafeRoots].some((unsafeRoot) => rootsOverlap(root, unsafeRoot))
  );
  for (const root of retainedRoots) {
    if (!roots.includes(root)) roots.push(root);
  }

  const removableCandidates = pendingRoots.filter((root) => !retainedRoots.includes(root));
  const removableRoots = removableCandidates.filter((root) =>
    !removableCandidates.some((other) => other !== root && pathContains(other, root))
  );
  const removalResults = await Promise.allSettled(
    removableRoots.map((root) => rm(root, { recursive: true, force: true }))
  );
  removalResults.forEach((result, index) => {
    if (result.status === "fulfilled") return;
    const root = removableRoots[index]!;
    if (!roots.includes(root)) roots.push(root);
    failures.push(result.reason);
  });
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "Application test teardown did not settle cleanly; unsafe roots were retained"
    );
  }
  });

export const disposeApplicationRoots = async (): Promise<void> =>
  disposeTrackedApplicationRoots();

/** Test-only bounded variant for deterministic teardown-failure coverage. */
export const disposeApplicationRootsWithin = async (timeoutMs: number): Promise<void> =>
  disposeTrackedApplicationRoots(timeoutMs);

export const makeApplication = async (
  registry: StageRegistryContract = fixtureRegistry,
  stageContext?: StageContextProvider,
  options: {
    readonly decorateState?: (state: AtomicStateStore) => StateStorePort;
    readonly decorateContent?: (content: FileContentStore) => ContentStorePort;
    readonly decorateAudit?: (audit: HashChainAuditLog) => AuditLogPort;
    readonly stateStoreOptions?: AtomicStateStoreOptions;
    readonly auditLogOptions?: HashChainAuditLogOptions;
    readonly dataRoot?: string;
    readonly prepareWorkspace?: (workspaceRoot: string) => void | Promise<void>;
    readonly now?: () => Date;
  } = {}
): Promise<ApplicationService> => withRegistryLock(async () => {
  const requestedRoot = options.dataRoot === undefined
    ? await mkdtemp(path.join(tmpdir(), "evleda-application-"))
    : path.resolve(options.dataRoot);
  if (options.dataRoot !== undefined) {
    await mkdir(requestedRoot, { recursive: true });
  }
  const root = await realpath(requestedRoot);
  const temporaryRoot = await realpath(tmpdir());
  if (rootKey(root) === rootKey(temporaryRoot) || !pathContains(temporaryRoot, root)) {
    throw new Error("Application test data roots must be strict descendants of the system temporary directory");
  }
  if (!roots.includes(root)) roots.push(root);
  const baseState = new AtomicStateStore(path.join(root, "state"), options.stateStoreOptions);
  const baseContent = new FileContentStore(path.join(root, "content"));
  const baseAudit = new HashChainAuditLog(path.join(root, "audit"), options.auditLogOptions);
  const workspaceRoot = path.join(root, "workspaces");
  const service = new ApplicationService(
    {
      state: options.decorateState?.(baseState) ?? baseState,
      content: options.decorateContent?.(baseContent) ?? baseContent,
      audit: options.decorateAudit?.(baseAudit) ?? baseAudit,
      stages: registry,
      ...(stageContext === undefined ? {} : { stageContext })
    },
    {
      workspaceRoot,
      ...(options.now === undefined ? {} : { now: options.now })
    }
  );
  applications.push({ root, service });
  await service.initialize();
  await options.prepareWorkspace?.(workspaceRoot);
  return service;
});

export const createApprovedRun = async (service: ApplicationService) => {
  const projectResult = await service.createProject({
    name: "Controller",
    idempotencyKey: "create-project-0001"
  });
  const started = await service.startDesignRun({
    projectId: projectResult.project.id,
    prompt: validPrompt,
    configuration: {},
    expectedRevision: projectResult.project.revision,
    idempotencyKey: "start-design-run-01"
  });
  const requirements = await service.inspectRequirements({ runId: started.run.id });
  const approved = await service.approveRequirements(
    {
      runId: started.run.id,
      requirementsDigest: requirements.requirementsDigest,
      actor: reviewer,
      rationale: "Requirements match the bounded reference test fixture.",
      scope: "exact requirements document",
      expectedRevision: started.run.revision,
      idempotencyKey: "approve-reqs-00001"
    },
    localHumanContext(reviewer, "requirements_approval")
  );
  return approved;
};

export const createCompletedRun = async (service: ApplicationService) => {
  const approved = await createApprovedRun(service);
  return service.resumeRun({
    runId: approved.run.id,
    expectedRevision: approved.run.revision,
    idempotencyKey: "resume-complete-001"
  });
};

export const physicalEvidenceInput = async (
  service: ApplicationService,
  runId: string,
  revisionId: string,
  expectedRevision: number,
  idempotencyKey: string,
  boardSerial: string,
  failingCategory?: "rails" | "programming" | "communications" | "sensors" | "actuators" | "thermal" | "fault_reset"
): Promise<SubmitExternalEvidenceCurrentInput> => {
  const listed = await service.listArtifacts({
    runId,
    revisionId,
    includeStale: false
  });
  const findArtifact = (logicalName: string) => {
    const artifact = listed.artifacts.find((candidate) => candidate.logicalName === logicalName);
    if (artifact === undefined) {
      throw new Error("Missing physical evidence fixture artifact " + logicalName);
    }
    return { artifactId: artifact.id, identity: artifact.blob };
  };
  const readJsonArtifact = async (binding: { readonly artifactId: string }) =>
    JSON.parse((await service.readArtifact(binding.artifactId)).bytes.toString("utf8")) as Record<string, unknown>;

  const inspected = await service.inspectEvidence({ runId, revisionId, includeStale: false });
  const status = await service.getRunStatus({ runId });
  if (status.headRevision?.id !== revisionId) {
    throw new Error("Physical evidence fixture revision " + revisionId + " is not the current head");
  }

  const suffix = idempotencyKey;
  const asBuiltSourceId = "as-built-" + suffix;
  const firmwareBinarySourceId = "firmware-binary-" + suffix;
  const firmwareFlashSourceId = "firmware-flash-" + suffix;
  const calibrationSourceId = "calibration-" + suffix;
  const measurementSourceId = "measurements-" + suffix;
  const instrumentId = "instrument-" + suffix;
  const assemblyOperator = {
    type: "human" as const,
    id: "assembler-" + suffix,
    displayName: "Fixture Assembly Operator",
    role: "assembly_operator" as const
  };
  const measurementOperator = {
    type: "human" as const,
    id: "operator-" + suffix,
    displayName: "Fixture Measurement Operator",
    role: "measurement_operator" as const
  };

  const bom = findArtifact("manufacturing/bom.csv");
  const camManifest = findArtifact("manufacturing/cam-manifest.json");
  const camArtifacts = [
    findArtifact("manufacturing/gerbers/controller-F_Cu.gbr"),
    findArtifact("manufacturing/drill/controller.drl"),
    findArtifact("manufacturing/positions.csv")
  ];
  const targetBuildReportArtifact = findArtifact("firmware/reports/stm32g0-target-build.json");
  const targetBinaryArtifact = findArtifact("firmware/build/evleda-stm32g0b1cet6-candidate.bin");
  const bringupProcedure = findArtifact("bringup/bringup-plan.json");
  const acceptance = findArtifact("bringup/physical-acceptance.json");
  const bringupPlan = await readJsonArtifact(bringupProcedure);
  const acceptanceContract = await readJsonArtifact(acceptance) as {
    readonly cases: readonly {
      readonly caseId: string;
      readonly procedureStepId: string;
      readonly endpointId: string;
      readonly requiredConditions: readonly (
        | { readonly conditionId: string; readonly kind: "exact"; readonly expected: boolean | string }
        | { readonly conditionId: string; readonly kind: "numeric_range"; readonly unit: string; readonly minimum: number; readonly maximum: number }
      )[];
      readonly minimumDurationMs: number;
      readonly captureRequirements: readonly {
        readonly captureRequirementId: string;
        readonly instrumentCapability: string;
        readonly allowedMediaTypes: readonly SubmitExternalEvidenceCurrentInput["sourceBlobs"][number]["mediaType"][];
        readonly minimumSamples?: number;
      }[];
    }[];
    readonly tests: readonly (
      | { readonly id: string; readonly caseId: string; readonly category: string; readonly instrumentCapability: string; readonly kind: "numeric_range"; readonly unit: string; readonly minimum: number; readonly maximum: number }
      | { readonly id: string; readonly caseId: string; readonly category: string; readonly instrumentCapability: string; readonly kind: "expected_value"; readonly expected: boolean | string }
    )[];
  };
  const targetReport = await readJsonArtifact(targetBuildReportArtifact) as {
    readonly sourceRevision: {
      readonly projectId: string;
      readonly runId: string;
      readonly designRevisionId: string;
      readonly targetBuildSourceIdentity: ReturnType<typeof canonicalIdentity>;
      readonly generatedSources: readonly { readonly logicalName: string; readonly identity: ReturnType<typeof contentIdentity> }[];
    };
    readonly toolchain: {
      readonly provisionedConfigurationIdentity: ReturnType<typeof canonicalIdentity>;
      readonly toolchainIdentity: ReturnType<typeof canonicalIdentity>;
    };
  };
  const firmwareBytes = (await service.readArtifact(targetBinaryArtifact.artifactId)).bytes;
  const firmwareIdentity = contentIdentity(firmwareBytes);
  if (
    firmwareIdentity.digest !== targetBinaryArtifact.identity.digest ||
    firmwareIdentity.size !== targetBinaryArtifact.identity.size
  ) {
    throw new Error("Fixture target BIN bytes do not match the committed artifact");
  }
  const targetProvenance = {
    projectId: targetReport.sourceRevision.projectId,
    runId: targetReport.sourceRevision.runId,
    designRevisionId: targetReport.sourceRevision.designRevisionId,
    targetBuildReportArtifact,
    targetBinaryArtifact,
    targetSourceRevisionDigest: targetReport.sourceRevision.targetBuildSourceIdentity.digest,
    targetBuildSourceIdentity: targetReport.sourceRevision.targetBuildSourceIdentity,
    targetConfigurationIdentity: targetReport.toolchain.provisionedConfigurationIdentity,
    targetToolchainIdentity: targetReport.toolchain.toolchainIdentity,
    targetCompiledSources: targetReport.sourceRevision.generatedSources
  };

  const calibrationRecord = {
    schemaVersion: "evleda.instrument-calibration.v1",
    instrumentId,
    manufacturer: "EvlEDA fixture vendor",
    model: "CALIBRATED-COMBO",
    serial: "serial-" + boardSerial,
    calibratedAt: "2026-01-01T00:00:00.000Z",
    validUntil: "2026-12-31T00:00:00.000Z",
    capabilities: [
      { capability: "dc_voltage", units: ["V"] },
      { capability: "dc_current", units: ["A"] },
      { capability: "resistance", units: ["ohm"] },
      { capability: "programmer", units: [] },
      { capability: "protocol_analyzer", units: [] },
      { capability: "logic_analyzer", units: [] },
      { capability: "current_probe", units: ["A"] },
      { capability: "temperature", units: ["degC"] },
      { capability: "oscilloscope", units: [] },
      { capability: "camera", units: [] }
    ]
  } as const;
  const asBuiltRecord = {
    schemaVersion: "evleda.as-built-record.v2",
    boardSerial,
    assemblyLot: "lot-" + boardSerial,
    assemblyOperator,
    completedAt: "2026-09-02T12:00:00.000Z",
    revisionManifestDigest: status.headRevision.manifest.digest,
    bomArtifact: bom,
    camManifestArtifact: camManifest,
    substitutions: []
  } as const;
  const firmwareFlashRecord = {
    schemaVersion: "evleda.firmware-flash-record.v2",
    boardSerial,
    flashedAt: "2026-09-03T09:05:00.000Z",
    ...targetProvenance,
    firmwareBinarySourceId,
    firmwareBinaryIdentity: firmwareIdentity,
    programmerInstrumentId: instrumentId
  } as const;

  const captureSources: SubmitExternalEvidenceCurrentInput["sourceBlobs"] = [];
  let captureIndex = 0;
  let caseCursor = Date.parse("2026-09-03T09:10:00.000Z");
  const caseExecutions = acceptanceContract.cases.map((testCase) => {
    const caseStartedAt = caseCursor;
    const caseCompletedAt = caseStartedAt + Math.max(testCase.minimumDurationMs, 1_000);
    caseCursor = caseCompletedAt;
    const caseObservedAt = new Date(
      caseStartedAt + Math.max(1, Math.floor((caseCompletedAt - caseStartedAt) / 2))
    ).toISOString();
    const captures = testCase.captureRequirements.map((requirement) => {
      const sourceId = "capture-" + suffix + "-" + String(captureIndex).padStart(3, "0");
      captureIndex += 1;
      const bytes = Buffer.from(
        "fixture capture " + testCase.caseId + " " + requirement.captureRequirementId + " " + suffix,
        "utf8"
      );
      captureSources.push({
        id: sourceId,
        role: "required_capture",
        mediaType: requirement.allowedMediaTypes[0]!,
        identity: contentIdentity(bytes),
        bytesBase64: bytes.toString("base64"),
        capturedAt: caseObservedAt
      });
      return {
        captureRequirementId: requirement.captureRequirementId,
        sourceId,
        instrumentId,
        sampleCount: Math.max(1, requirement.minimumSamples ?? 1)
      };
    });
    const tests = acceptanceContract.tests.filter((test) => test.caseId === testCase.caseId);
    const observations = tests.map((test) => {
      const capture = testCase.captureRequirements.find(
        (requirement) => requirement.instrumentCapability === test.instrumentCapability
      );
      if (capture === undefined) {
        throw new Error("No fixture capture capability for acceptance test " + test.id);
      }
      if (test.kind === "numeric_range") {
        return {
          testId: test.id,
          instrumentId,
          captureRequirementId: capture.captureRequirementId,
          observedAt: caseObservedAt,
          kind: "numeric_range" as const,
          value: failingCategory === test.category ? test.maximum + 100 : (test.minimum + test.maximum) / 2,
          unit: test.unit
        };
      }
      return {
        testId: test.id,
        instrumentId,
        captureRequirementId: capture.captureRequirementId,
        observedAt: caseObservedAt,
        kind: "expected_value" as const,
        observed: failingCategory === test.category
          ? (typeof test.expected === "boolean" ? !test.expected : test.expected + "-wrong")
          : test.expected
      };
    });
    return {
      caseId: testCase.caseId,
      procedureStepId: testCase.procedureStepId,
      endpointId: testCase.endpointId,
      operatorId: measurementOperator.id,
      startedAt: new Date(caseStartedAt).toISOString(),
      completedAt: new Date(caseCompletedAt).toISOString(),
      actualConditions: testCase.requiredConditions.map((condition) =>
        condition.kind === "exact"
          ? { conditionId: condition.conditionId, kind: "exact" as const, observed: condition.expected }
          : {
              conditionId: condition.conditionId,
              kind: "numeric" as const,
              unit: condition.unit,
              value: (condition.minimum + condition.maximum) / 2
            }
      ),
      captureBindings: captures,
      observations
    };
  });
  const measurementRecord = {
    schemaVersion: "evleda.physical-measurements.v2",
    boardSerial,
    bringupProcedureArtifact: bringupProcedure,
    acceptanceArtifact: acceptance,
    ...targetProvenance,
    firmwareBinarySourceId,
    firmwareBinaryIdentity: firmwareIdentity,
    environment: {
      location: "EvlEDA guarded bench fixture",
      fixtureId: "fixture-" + suffix,
      supply: "current-limited isolated bench supply",
      ambientTemperatureC: 23.5,
      relativeHumidityPercent: 45
    },
    operators: [measurementOperator],
    startedAt: "2026-09-03T09:00:00.000Z",
    completedAt: "2026-09-03T10:00:00.000Z",
    caseExecutions
  } as const;

  const jsonBytes = (value: unknown): Buffer => Buffer.from(canonicalJson(value) + "\n", "utf8");
  const source = (
    id: string,
    role: SubmitExternalEvidenceCurrentInput["sourceBlobs"][number]["role"],
    mediaType: SubmitExternalEvidenceCurrentInput["sourceBlobs"][number]["mediaType"],
    bytes: Buffer,
    capturedAt: string
  ): SubmitExternalEvidenceCurrentInput["sourceBlobs"][number] => ({
    id,
    role,
    mediaType,
    identity: contentIdentity(bytes),
    bytesBase64: bytes.toString("base64"),
    capturedAt
  });

  return {
    revisionId,
    revisionManifestDigest: status.headRevision.manifest.digest,
    evidenceRootDigest: inspected.evidenceRoot.digest,
    actor: qualifier,
    artifactBindings: {
      bom,
      cam: { manifest: camManifest, artifacts: camArtifacts },
      targetBuildReport: targetBuildReportArtifact,
      targetBinary: targetBinaryArtifact,
      bringupProcedure,
      acceptance
    },
    sourceBlobs: [
      source(asBuiltSourceId, "as_built_record", "application/json", jsonBytes(asBuiltRecord), "2026-09-02T12:00:00.000Z"),
      source(firmwareBinarySourceId, "flashed_firmware_binary", "application/octet-stream", firmwareBytes, "2026-09-03T09:05:00.000Z"),
      source(firmwareFlashSourceId, "firmware_flash_record", "application/json", jsonBytes(firmwareFlashRecord), "2026-09-03T09:05:00.000Z"),
      source(calibrationSourceId, "instrument_calibration", "application/json", jsonBytes(calibrationRecord), "2026-01-01T00:00:00.000Z"),
      ...captureSources,
      source(measurementSourceId, "parsed_measurement_record", "application/json", jsonBytes(measurementRecord), "2026-09-03T10:00:00.000Z")
    ],
    asBuiltRecordSourceId: asBuiltSourceId,
    flashedFirmwareBinarySourceId: firmwareBinarySourceId,
    firmwareFlashRecordSourceId: firmwareFlashSourceId,
    measurementRecordSourceId: measurementSourceId,
    instruments: [{ id: instrumentId, calibrationSourceId }],
    rationale: "Guarded candidate-only physical evidence for " + boardSerial + ".",
    expectedRevision,
    idempotencyKey
  };
};
