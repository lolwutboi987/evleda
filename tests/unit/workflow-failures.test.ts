import { describe, expect, it } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { STAGE_ORDER, type StageKey } from "../../src/domain/stages.js";
import type { ApprovalRecord, ValidationStatus } from "../../src/domain/types.js";
import {
  ROBOTICS_CONTROLLER_V0,
  type ReferenceControllerProfile
} from "../../src/knowledge/reference-controller-v0.js";
import { REQUIRED_SIMULATION_COVERAGE } from "../../src/generators/simulation-checks-generator.js";
import type { FirmwareCompileContextExtension } from "../../src/integrations/firmware-compiler.js";
import {
  createDefaultStageRegistry,
  StageRegistry,
  type CandidateStageContext,
  type ComponentLifecycleObservation,
  type KicadArtifactRole,
  type KicadBackendRequest,
  type KicadBackendResult,
  type KicadBackendStage,
  type KicadGenerationBackend,
  type KicadReportKind,
  type PinPadMappingObservation,
  type SimulationBackend,
  type SimulationBackendResult,
  type SimulationCoverageItem,
  type SimulationRequest,
  type SourcingObservation,
  type StageExecutionResult
} from "../../src/workflow/index.js";
import {
  nativeFirmwareParityReport,
  passingFirmwareCompileBackend,
  passingFirmwareTargetBuildBackend
} from "../helpers/firmware-compile.js";
import { fixtureUpstreamSourceRevisionBinding } from "../helpers/upstream-source-revision.js";
import {
  CLEAN_MINIMAL_KICAD_PCB,
  TEST_KICAD_TOOL,
  testKicadReports,
} from "../helpers/kicad-reports.js";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

const artifactRoles: Readonly<Record<KicadBackendStage, readonly KicadArtifactRole[]>> = {
  schematic: ["project", "schematic"],
  pcb_placement_routing: ["pcb", "render"],
  manufacturing_package: ["bom", "gerber", "drill", "position", "cam_manifest"]
};

const reportKinds: Readonly<Record<KicadBackendStage, readonly KicadReportKind[]>> = {
  schematic: ["erc", "connectivity"],
  pcb_placement_routing: [
    "drc",
    "schematic_parity",
    "connectivity",
    "geometry",
    "pcb_practices",
  ],
  manufacturing_package: [
    "drc",
    "schematic_parity",
    "bom_parity",
    "bom_export",
    "gerber_export",
    "drill_export",
    "position_export",
    "cam_manifest"
  ]
};

interface KicadFaults {
  readonly staleStage?: KicadBackendStage;
  readonly failedReport?: {
    readonly stage: KicadBackendStage;
    readonly kind: KicadReportKind;
    readonly status: ValidationStatus;
  };
  readonly omitReport?: { readonly stage: KicadBackendStage; readonly kind: KicadReportKind };
  readonly omitRole?: { readonly stage: KicadBackendStage; readonly role: KicadArtifactRole };
}

class ConfigurableKicadBackend implements KicadGenerationBackend {
  public readonly backendId = "configurable-kicad-test-double";

  public constructor(private readonly faults: KicadFaults = {}) {}

  public async execute(request: KicadBackendRequest): Promise<KicadBackendResult> {
    const sourceRevisionDigest =
      this.faults.staleStage === request.stage
        ? "0".repeat(64)
        : request.expectedSourceRevisionDigest;
    const artifacts = artifactRoles[request.stage]
      .filter(
        (role) =>
          this.faults.omitRole?.stage !== request.stage || this.faults.omitRole.role !== role
      )
      .map((role, index) => ({
        role,
        logicalName: `native/${request.stage}-${index}-${role}.bin`,
        mediaType: "application/octet-stream",
        content:
          role === "pcb"
            ? CLEAN_MINIMAL_KICAD_PCB
            : encode(`${request.stage}:${role}:${sourceRevisionDigest}`)
      }));
    return {
      schemaVersion: "evleda.kicad-result.v2",
      stage: request.stage,
      sourceRevisionDigest,
      tool: TEST_KICAD_TOOL,
      artifacts,
      reports: testKicadReports({
        request,
        sourceRevisionDigest,
        artifacts,
        reportKinds: reportKinds[request.stage],
        ...(this.faults.omitReport?.stage === request.stage
          ? { omitKind: this.faults.omitReport.kind }
          : {}),
        statusFor: (kind) =>
          this.faults.failedReport?.stage === request.stage &&
          this.faults.failedReport.kind === kind
            ? this.faults.failedReport.status
            : "pass",
        contentFor: (kind) =>
          request.stage === "schematic" && kind === "connectivity"
            ? nativeFirmwareParityReport(request.profile, sourceRevisionDigest)
            : encode(`{"kind":"${kind}"}`)
      })
    };
  }
}

interface SimulationFaults {
  readonly omit?: SimulationCoverageItem;
  readonly fail?: SimulationCoverageItem;
  readonly stale?: boolean;
}

class ConfigurableSimulationBackend implements SimulationBackend {
  public readonly backendId = "configurable-simulation-test-double";

  public constructor(private readonly faults: SimulationFaults = {}) {}

  public async execute(request: SimulationRequest): Promise<SimulationBackendResult> {
    const sourceRevisionDigest = this.faults.stale
      ? "f".repeat(64)
      : request.expectedSourceRevisionDigest;
    return {
      schemaVersion: "evleda.simulation-result.v1",
      sourceRevisionDigest,
      tool: {
        name: "simulation-test-double",
        version: "1.0.0-test",
        adapter: "external",
        capabilityProfile: "isolated-test-double"
      },
      reports: REQUIRED_SIMULATION_COVERAGE.filter((item) => item !== this.faults.omit).map(
        (coverageItem) => ({
          coverageItem,
          logicalName: `simulation/${coverageItem}.json`,
          mediaType: "application/json",
          content: encode(`{"coverage":"${coverageItem}"}`),
          sourceRevisionDigest,
          modelIdentity: contentIdentity(`model:${coverageItem}:v1`),
          validationStatus: coverageItem === this.faults.fail ? "fail" : "pass"
        })
      )
    };
  }
}

const validPrompt =
  "Build two motors for a 7-16.8 V supply at 0.5 A RMS per channel with USB, CAN, UART, I2C, SPI, two quadrature encoders, and SWD.";

const approvalFor = (digest: string): ApprovalRecord => ({
  id: "approval_failure_fixture",
  kind: "requirements",
  projectId: "project_failure",
  runId: "run_failure",
  subjectDigest: digest,
  policyVersion: "evleda-policy-v0",
  actor: {
    type: "human",
    id: "reviewer_failure_fixture",
    displayName: "Fixture reviewer",
    role: "requirements_reviewer"
  },
  scope: "Unit-test fixture",
  rationale: "Exercise downstream failure behavior.",
  createdAt: "2026-09-03T12:00:00.000Z"
});

const sourcingFor = (
  profile: ReferenceControllerProfile,
  unavailable?: ReferenceControllerProfile["components"][number]["key"]
): readonly SourcingObservation[] =>
  profile.components.map((component) => ({
    component: component.key,
    manufacturerPartNumber: component.partNumber,
    supplier: "fixture-supplier",
    url: `https://example.invalid/${component.key}`,
    retrievedAt: "2026-09-03",
    availability: component.key === unavailable ? "not_available" : "in_stock",
    identity: contentIdentity(
      `supplier:${component.key}:${component.key === unavailable ? "not_available" : "in_stock"}`
    )
  }));

const lifecycleFor = (
  profile: ReferenceControllerProfile,
  omitted?: ReferenceControllerProfile["components"][number]["key"]
): readonly ComponentLifecycleObservation[] =>
  profile.components
    .filter((component) => component.key !== omitted)
    .map((component) => ({
      component: component.key,
      status: "active",
      checkedAt: "2026-09-03",
      sourceUrl: component.lifecycle.sourceUrl,
      sourceIdentity: contentIdentity(`lifecycle:${component.key}:active`),
      requiresReview: false
    }));

const pinPadMappingsFor = (
  profile: ReferenceControllerProfile,
  wrong?: ReferenceControllerProfile["components"][number]["key"]
): readonly PinPadMappingObservation[] =>
  profile.components.map((component) => ({
    component: component.key,
    symbol: component.symbol,
    footprint:
      component.key === wrong ? `${component.footprint}:WRONG` : component.footprint,
    status: "reviewed",
    checkedAt: "2026-09-03",
    mappingIdentity: contentIdentity(`mapping:${component.key}`),
    reviewIdentity: contentIdentity(`mapping-review:${component.key}`),
    requiresReview: false
  }));

interface RunOptions {
  readonly profile?: ReferenceControllerProfile;
  readonly noKicadBackend?: boolean;
  readonly kicadFaults?: KicadFaults;
  readonly noSimulationBackend?: boolean;
  readonly simulationFaults?: SimulationFaults;
  readonly missingFootprint?: string;
  readonly unavailableComponent?: ReferenceControllerProfile["components"][number]["key"];
  readonly missingLifecycle?: ReferenceControllerProfile["components"][number]["key"];
  readonly wrongPinPadMapping?: ReferenceControllerProfile["components"][number]["key"];
  readonly omitApproval?: boolean;
}

const runThrough = async (
  finalStage: Exclude<StageKey, "requirements">,
  options: RunOptions = {}
): Promise<readonly StageExecutionResult[]> => {
  const registry = createDefaultStageRegistry();
  const requirementsResult = await registry.execute("requirements", {
    projectId: "project_failure",
    runId: "run_failure",
    designRevisionId: "revision_failure",
    prompt: validPrompt
  });
  const requirements = requirementsResult.requirementsDocument;
  if (requirements === undefined) {
    throw new Error("missing requirements document");
  }
  const profile = options.profile ?? ROBOTICS_CONTROLLER_V0;
  const firmwareCompileBackend = passingFirmwareCompileBackend();
  const firmwareTargetBuildBackend = passingFirmwareTargetBuildBackend();
  const upstream: StageExecutionResult[] = [requirementsResult];
  const common: Omit<CandidateStageContext, "upstream"> & FirmwareCompileContextExtension = {
    projectId: "project_failure",
    runId: "run_failure",
    designRevisionId: "revision_failure",
    requirements,
    upstreamSourceRevisionBindings: [],
    profile,
    ...(options.omitApproval ? {} : { requirementsApproval: approvalFor(requirements.identity.digest) }),
    sourcing: sourcingFor(profile, options.unavailableComponent),
    lifecycleObservations: lifecycleFor(profile, options.missingLifecycle),
    pinPadMappingReviews: pinPadMappingsFor(profile, options.wrongPinPadMapping),
    footprintLibrary: {
      libraryId: "failure-footprints-v1",
      identity: contentIdentity("failure-footprints-v1"),
      footprints: profile.components
        .map((component) => component.footprint)
        .filter((footprint) => footprint !== options.missingFootprint)
    },
    ...(options.noKicadBackend
      ? {}
      : { kicadBackend: new ConfigurableKicadBackend(options.kicadFaults) }),
    ...(options.noSimulationBackend
      ? {}
      : { simulationBackend: new ConfigurableSimulationBackend(options.simulationFaults) }),
    firmwareCompileBackend,
    firmwareCompileConfiguration: firmwareCompileBackend.configuration,
    firmwareTargetBuildBackend,
    firmwareTargetBuildConfiguration: firmwareTargetBuildBackend.configuration
  };
  const upstreamSourceRevisionBindings: ReturnType<
    typeof fixtureUpstreamSourceRevisionBinding
  >[] = [];
  let sourceRevisionId = common.designRevisionId;
  for (const stage of STAGE_ORDER.slice(1) as readonly Exclude<StageKey, "requirements">[]) {
    const committedRevisionId = `revision_failure_after_${stage}`;
    const result: StageExecutionResult = await registry.execute(stage, {
      ...common,
      designRevisionId: sourceRevisionId,
      upstream,
      upstreamSourceRevisionBindings
    });
    upstream.push(result);
    upstreamSourceRevisionBindings.push(
      fixtureUpstreamSourceRevisionBinding({
        projectId: common.projectId,
        runId: common.runId,
        result,
        sourceRevisionId,
        committedRevisionId
      })
    );
    sourceRevisionId = committedRevisionId;
    if (stage === finalStage) {
      break;
    }
  }
  return upstream;
};

const last = (results: readonly StageExecutionResult[]): StageExecutionResult => {
  const result = results.at(-1);
  if (result === undefined) {
    throw new Error("expected at least one stage result");
  }
  return result;
};

const blockerCodes = (result: StageExecutionResult): readonly string[] =>
  result.blockers.map((blocker) => blocker.code);

describe("fail-closed workflow stages", () => {
  it("rejects incomplete and duplicate stage registries", () => {
    expect(() => new StageRegistry([])).toThrow(/incomplete/iu);
    const requirementsExecutor = createDefaultStageRegistry().get("requirements");
    expect(() => new StageRegistry([requirementsExecutor, requirementsExecutor])).toThrow(
      /duplicate/iu
    );
  });

  it("blocks ambiguous requirements instead of continuing with a default", async () => {
    const result = await createDefaultStageRegistry().execute("requirements", {
      projectId: "project_failure",
      runId: "run_failure",
      designRevisionId: "revision_failure",
      prompt: "Build two motors at 0.5 A RMS with CAN."
    });

    expect(result.executionStatus).toBe("blocked");
    expect(blockerCodes(result)).toContain("ASSUMPTION_MISSING_SUPPLY_VOLTAGE");
    expect(result.evidence.some((entry) => entry.validationStatus === "pass")).toBe(false);
  });

  it("blocks component selection when exact datasheet source bytes are absent", async () => {
    const brokenProfile: ReferenceControllerProfile = {
      ...ROBOTICS_CONTROLLER_V0,
      components: ROBOTICS_CONTROLLER_V0.components.map((component) =>
        component.key === "mcu"
          ? {
              ...component,
              datasheet: {
                url: component.datasheet.url,
                urlRecordedAt: component.datasheet.urlRecordedAt,
                retrievedAt: null,
                sourcePolicy: "exact_bytes_identity_required"
              }
            }
          : component
      )
    };
    const result = last(await runThrough("component_selection", { profile: brokenProfile }));

    expect(result.executionStatus).toBe("blocked");
    expect(blockerCodes(result)).toContain("DATASHEET_SOURCE_BYTES_MISSING");
    expect(result.blockers.some((blocker) => blocker.message.includes("retrievedAt is explicitly null"))).toBe(true);
  });

  it("blocks missing lifecycle evidence and wrong symbol-to-footprint mapping review", async () => {
    const missingLifecycle = last(
      await runThrough("component_selection", { missingLifecycle: "mcu" })
    );
    expect(missingLifecycle.executionStatus).toBe("blocked");
    expect(blockerCodes(missingLifecycle)).toContain("LIFECYCLE_EVIDENCE_MISSING");

    const wrongMapping = last(
      await runThrough("component_selection", { wrongPinPadMapping: "motor_driver" })
    );
    expect(wrongMapping.executionStatus).toBe("blocked");
    expect(blockerCodes(wrongMapping)).toContain("PIN_PAD_MAPPING_MISMATCH");
  });

  it("blocks a reference-circuit record that does not bind the selected exact datasheet", async () => {
    const staleCircuitProfile: ReferenceControllerProfile = {
      ...ROBOTICS_CONTROLLER_V0,
      components: ROBOTICS_CONTROLLER_V0.components.map((component) =>
        component.key === "mcu"
          ? {
              ...component,
              referenceCircuits: component.referenceCircuits.map((circuit) => ({
                ...circuit,
                sourceIdentity: contentIdentity("wrong-reference-circuit-source")
              }))
            }
          : component
      )
    };
    const result = last(
      await runThrough("component_selection", { profile: staleCircuitProfile })
    );

    expect(result.executionStatus).toBe("blocked");
    expect(blockerCodes(result)).toContain("REFERENCE_CIRCUIT_TRACEABILITY_INVALID");
  });

  it("blocks unavailable parts and unavailable footprints", async () => {
    const unavailable = last(
      await runThrough("component_selection", { unavailableComponent: "motor_driver" })
    );
    expect(blockerCodes(unavailable)).toContain("PART_UNAVAILABLE");

    const missingFootprint = ROBOTICS_CONTROLLER_V0.components.find(
      (component) => component.key === "can_transceiver"
    )!.footprint;
    const footprint = last(
      await runThrough("component_selection", { missingFootprint })
    );
    expect(blockerCodes(footprint)).toContain("FOOTPRINT_UNAVAILABLE");
  });

  it("blocks schematic generation without a backend and never fabricates native pass evidence", async () => {
    const result = last(await runThrough("schematic", { noKicadBackend: true }));

    expect(result.executionStatus).toBe("blocked");
    expect(blockerCodes(result)).toContain("KICAD_BACKEND_MISSING");
    expect(result.evidence.some((entry) => entry.evidenceClass === "kicad_native")).toBe(false);
  });

  it("rejects stale KiCad artifacts and reports", async () => {
    const result = last(
      await runThrough("schematic", { kicadFaults: { staleStage: "schematic" } })
    );

    expect(result.executionStatus).toBe("blocked");
    expect(blockerCodes(result)).toContain("KICAD_SOURCE_REVISION_STALE");
    expect(blockerCodes(result)).toContain("KICAD_REPORT_STALE");
    expect(
      result.artifacts
        .filter((artifact) => artifact.tool.adapter === "kicad_cli")
        .some((artifact) => artifact.validationStatus === "pass")
    ).toBe(false);
  });

  it("blocks unsupported KiCad checks instead of treating tool output as a pass", async () => {
    const result = last(
      await runThrough("schematic", {
        kicadFaults: {
          failedReport: { stage: "schematic", kind: "erc", status: "unsupported" }
        }
      })
    );

    expect(result.executionStatus).toBe("blocked");
    expect(blockerCodes(result)).toContain("KICAD_REPORT_NOT_PASSING");
    expect(
      result.evidence.some(
        (entry) => entry.claim.includes("erc") && entry.validationStatus === "unsupported"
      )
    ).toBe(true);
  });

  it("blocks missing simulation backends, missing coverage, and non-passing modeled evidence", async () => {
    const missingBackend = last(
      await runThrough("simulation_checks", { noSimulationBackend: true })
    );
    expect(blockerCodes(missingBackend)).toContain("SIMULATION_BACKEND_MISSING");

    const missingCoverage = last(
      await runThrough("simulation_checks", {
        simulationFaults: { omit: "motor_driver_thermal" }
      })
    );
    expect(blockerCodes(missingCoverage)).toContain("SIMULATION_REPORT_MISSING");

    const failedCoverage = last(
      await runThrough("simulation_checks", {
        simulationFaults: { fail: "motor_current_chop" }
      })
    );
    expect(blockerCodes(failedCoverage)).toContain("SIMULATION_REPORT_NOT_PASSING");
  });

  it("blocks failed DRC and does not run CAM after a blocked PCB prerequisite", async () => {
    const failedDrc = last(
      await runThrough("pcb_placement_routing", {
        kicadFaults: {
          failedReport: { stage: "pcb_placement_routing", kind: "drc", status: "fail" }
        }
      })
    );
    expect(blockerCodes(failedDrc)).toContain("KICAD_REPORT_NOT_PASSING");
    expect(
      failedDrc.evidence.some(
        (entry) => entry.claim.includes("drc") && entry.validationStatus === "fail"
      )
    ).toBe(true);

    const incompleteCam = last(
      await runThrough("manufacturing_package", {
        kicadFaults: {
          omitRole: { stage: "manufacturing_package", role: "drill" },
          omitReport: { stage: "manufacturing_package", kind: "drill_export" }
        }
      })
    );
    expect(blockerCodes(incompleteCam)).toEqual(["UPSTREAM_STAGE_BLOCKED"]);
  });

  it("blocks conflicting MCU pin assignments and stale approvals", async () => {
    const conflictingProfile: ReferenceControllerProfile = {
      ...ROBOTICS_CONTROLLER_V0,
      pins: ROBOTICS_CONTROLLER_V0.pins.map((pin) =>
        pin.signal === "MOTOR_B_DIR" ? { ...pin, mcuPin: "PA10" } : pin
      )
    };
    const conflict = last(
      await runThrough("system_architecture", { profile: conflictingProfile })
    );
    expect(blockerCodes(conflict)).toContain("CONFLICTING_PIN_ASSIGNMENT");

    const noApproval = last(
      await runThrough("system_architecture", { omitApproval: true })
    );
    expect(blockerCodes(noApproval)).toContain("REQUIREMENTS_APPROVAL_MISSING");
  });
});
