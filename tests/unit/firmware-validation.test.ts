import { existsSync } from "node:fs";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import type { ApprovalRecord } from "../../src/domain/types.js";
import {
  firmwareContractStageExecutor,
  validateFirmwareTargetBuildReport,
} from "../../src/generators/firmware-contract-generator.js";
import { schematicStageExecutor } from "../../src/generators/schematic-generator.js";
import {
  CURRENT_SCHEMATIC_PIN_MAP_SCHEMA,
  LEGACY_SCHEMATIC_PIN_MAP_SCHEMA
} from "../../src/generators/firmware-parity.js";
import {
  FIRMWARE_COMPILE_RESOURCE_LIMITS,
  LocalFirmwareCompileBackend,
  type FirmwareCompileBackend,
  type FirmwareCompileContextExtension
} from "../../src/integrations/firmware-compiler.js";
import {
  createArmGnuFirmwareTargetBuildBackend,
  FIRMWARE_TARGET_RESOURCE_LIMITS,
} from "../../src/integrations/firmware-target-builder.js";
import {
  REFERENCE_CONNECTIVITY_ANALYZER_ID,
  REFERENCE_CONNECTIVITY_ANALYZER_TOOL
} from "../../src/integrations/reference-kicad-backend.js";
import { runBoundedProcess } from "../../src/integrations/bounded-process.js";
import type {
  BoundedProcessOptions,
  BoundedProcessResult,
  BoundedProcessRunner
} from "../../src/integrations/bounded-process.js";
import { ROBOTICS_CONTROLLER_V0 } from "../../src/knowledge/reference-controller-v0.js";
import {
  firmwareParityMappingModelIdentity,
  firmwareResourceConflicts
} from "../../src/knowledge/firmware-parity-model.js";
import {
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY,
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_IDENTITY
} from "../../src/knowledge/reference-controller-native-contract.js";
import {
  CURRENT_SCHEMATIC_INTENT_SCHEMA,
  LEGACY_SCHEMATIC_INTENT_SCHEMA
} from "../../src/knowledge/reference-schematic-intent.js";
import type {
  CandidateStageContext,
  FirmwareTargetBuildBackend,
  KicadBackendRequest,
  KicadBackendResult,
  KicadGenerationBackend,
  StageExecutionResult
} from "../../src/workflow/contracts.js";
import { createDefaultStageRegistry } from "../../src/workflow/stage-registry.js";
import { finalizeStageResult } from "../../src/generators/draft-utils.js";
import {
  nativeFirmwareParityReport,
  passingFirmwareCompileBackend,
  passingFirmwareTargetBuildBackend,
} from "../helpers/firmware-compile.js";
import { TEST_KICAD_TOOL, testKicadReports } from "../helpers/kicad-reports.js";
import { fixtureUpstreamSourceRevisionBinding } from "../helpers/upstream-source-revision.js";

const validPrompt =
  "Build two motors for a 7-16.8 V supply at 0.5 A RMS per channel with USB, CAN, UART, I2C, SPI, two quadrature encoders, and SWD.";

const hostTargetTriple = (): string => {
  if (process.platform === "win32") {
    return process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  }
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  return process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
};

const processResult = (
  options: BoundedProcessOptions,
  values: Partial<BoundedProcessResult> = {}
): BoundedProcessResult => ({
  command: options.command,
  args: [...options.args],
  cwd: options.cwd,
  exitCode: 0,
  stdout: "",
  stderr: "",
  durationMs: 1,
  startedAt: "2026-09-04T00:00:00.000Z",
  ...values
});

const approvalFor = (requirementsDigest: string): ApprovalRecord => ({
  id: "approval_firmware_validation",
  kind: "requirements",
  projectId: "project_firmware_validation",
  runId: "run_firmware_validation",
  subjectDigest: requirementsDigest,
  policyVersion: "evleda-policy-v0",
  actor: {
    type: "human",
    id: "reviewer_firmware_validation",
    displayName: "Firmware validation reviewer",
    role: "requirements_reviewer"
  },
  scope: "Exact firmware validation test requirements",
  rationale: "Deterministic fixture",
  createdAt: "2026-09-04T00:00:00.000Z"
});

type ConnectivityPayload = (
  request: KicadBackendRequest
) => Uint8Array;

type BackendResultMutator = (
  result: KicadBackendResult,
  request: KicadBackendRequest
) => KicadBackendResult;

class FirmwareParityKicadBackend implements KicadGenerationBackend {
  public readonly backendId = "firmware-parity-kicad-test-double";

  public constructor(
    private readonly connectivityPayload: ConnectivityPayload,
    private readonly mutateResult?: BackendResultMutator
  ) {}

  public async execute(request: KicadBackendRequest): Promise<KicadBackendResult> {
    const artifacts: KicadBackendResult["artifacts"] = [
      {
        role: "project",
        logicalName: "hardware/controller.kicad_pro",
        mediaType: "application/json",
        content: Buffer.from("{}\n")
      },
      {
        role: "schematic",
        logicalName: "hardware/controller.kicad_sch",
        mediaType: "application/x-kicad-schematic",
        content: Buffer.from(`native-schematic:${request.expectedSourceRevisionDigest}\n`)
      }
    ];
    const result: KicadBackendResult = {
      schemaVersion: "evleda.kicad-result.v2",
      stage: request.stage,
      sourceRevisionDigest: request.expectedSourceRevisionDigest,
      tool: TEST_KICAD_TOOL,
      artifacts,
      reports: testKicadReports({
        request,
        artifacts,
        reportKinds: ["erc", "connectivity"],
        contentFor: (kind) =>
          kind === "connectivity"
            ? this.connectivityPayload(request)
            : Buffer.from(`native:${kind}:${request.expectedSourceRevisionDigest}\n`)
      })
    };
    return this.mutateResult?.(result, request) ?? result;
  }
}

const decodeJson = <T>(result: StageExecutionResult, logicalName: string): T => {
  const artifact = result.artifacts.find((entry) => entry.logicalName === logicalName);
  if (artifact === undefined) throw new Error(`Missing test artifact ${logicalName}`);
  return JSON.parse(Buffer.from(artifact.content).toString("utf8")) as T;
};

const successfulUpstream = (
  requirementsResult: StageExecutionResult
): readonly StageExecutionResult[] => [
  requirementsResult,
  finalizeStageResult("system_architecture", [], [], []),
  finalizeStageResult("component_selection", [], [], [])
];

const executeFirmware = async (options: {
  readonly connectivityPayload?: ConnectivityPayload;
  readonly backendResultMutator?: BackendResultMutator;
  readonly schematicMutator?: (result: StageExecutionResult) => StageExecutionResult;
  readonly compileBackend?: FirmwareCompileBackend;
  readonly targetBuildBackend?: FirmwareTargetBuildBackend | null;
  readonly beforeFirmwareExecute?: (
    context: CandidateStageContext & FirmwareCompileContextExtension,
  ) => void;
} = {}): Promise<{ readonly schematic: StageExecutionResult; readonly firmware: StageExecutionResult }> => {
  const requirementsResult = await createDefaultStageRegistry().execute("requirements", {
    projectId: "project_firmware_validation",
    runId: "run_firmware_validation",
    designRevisionId: "revision_firmware_validation",
    prompt: validPrompt
  });
  const requirements = requirementsResult.requirementsDocument;
  if (requirements === undefined) throw new Error("Requirements fixture did not parse.");
  const upstream = successfulUpstream(requirementsResult);
  const base: Omit<CandidateStageContext, "upstream"> = {
    projectId: "project_firmware_validation",
    runId: "run_firmware_validation",
    designRevisionId: "revision_firmware_validation",
    profile: ROBOTICS_CONTROLLER_V0,
    requirements,
    requirementsApproval: approvalFor(requirements.identity.digest),
    upstreamSourceRevisionBindings: [],
    kicadBackend: new FirmwareParityKicadBackend(
      options.connectivityPayload ??
        ((request) =>
          nativeFirmwareParityReport(request.profile, request.expectedSourceRevisionDigest)),
      options.backendResultMutator
    )
  };
  const generatedSchematic = await schematicStageExecutor.execute({
    ...base,
    designRevisionId: "revision_schematic_source",
    upstream
  });
  const schematic = options.schematicMutator?.(generatedSchematic) ?? generatedSchematic;
  const compileBackend = options.compileBackend ?? passingFirmwareCompileBackend();
  const targetBuildBackend = options.targetBuildBackend === undefined
    ? passingFirmwareTargetBuildBackend()
    : options.targetBuildBackend;
  const firmwareContext: CandidateStageContext & FirmwareCompileContextExtension = {
    ...base,
    upstream: [...upstream, schematic],
    upstreamSourceRevisionBindings: [
      fixtureUpstreamSourceRevisionBinding({
        projectId: base.projectId,
        runId: base.runId,
        result: upstream[1]!,
        sourceRevisionId: "revision_architecture_source",
        committedRevisionId: "revision_architecture_committed"
      }),
      fixtureUpstreamSourceRevisionBinding({
        projectId: base.projectId,
        runId: base.runId,
        result: upstream[2]!,
        sourceRevisionId: "revision_architecture_committed",
        committedRevisionId: "revision_schematic_source"
      }),
      fixtureUpstreamSourceRevisionBinding({
        projectId: base.projectId,
        runId: base.runId,
        result: schematic,
        sourceRevisionId: "revision_schematic_source",
        committedRevisionId: base.designRevisionId
      })
    ],
    firmwareCompileBackend: compileBackend,
    firmwareCompileConfiguration: compileBackend.configuration,
    ...(targetBuildBackend === null ? {} : {
      firmwareTargetBuildBackend: targetBuildBackend,
      firmwareTargetBuildConfiguration: targetBuildBackend.configuration,
    }),
  };
  options.beforeFirmwareExecute?.(firmwareContext);
  const firmware = await firmwareContractStageExecutor.execute(firmwareContext);
  return { schematic, firmware };
};

describe("generated firmware compile and schematic parity gates", () => {
  it("detects global timer, IRQ, DMA, and resource ownership conflicts", () => {
    const motorPwm = ROBOTICS_CONTROLLER_V0.resources.find(
      (resource) => resource.owner === "motor_pwm"
    )!;
    const conflicted = {
      ...ROBOTICS_CONTROLLER_V0,
      resources: ROBOTICS_CONTROLLER_V0.resources.map((resource) =>
        resource.owner === "encoder_a"
          ? {
              ...resource,
              resource: motorPwm.resource,
              irq: "TIM1_BRK_UP_TRG_COM",
              dma: "DMA1_CH1 via DMAMUX"
            }
          : resource
      )
    };
    const conflicts = firmwareResourceConflicts(conflicted);
    expect(conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "timer", claim: "TIM1" }),
        expect.objectContaining({ kind: "irq", claim: "TIM1_BRK_UP_TRG_COM" }),
        expect.objectContaining({ kind: "dma", claim: "DMA1_CH1" }),
        expect.objectContaining({ kind: "resource", claim: motorPwm.resource.toUpperCase() })
      ])
    );
  });
  it("persists candidate-only passing reports bound to exact revision identities", async () => {
    const { schematic, firmware } = await executeFirmware();

    expect(schematic.executionStatus).toBe("succeeded");
    const intent = decodeJson<{
      schemaVersion: string;
      nativeContractBinding: { semanticIdentity: unknown; contentIdentity: unknown };
    }>(schematic, "schematic/schematic-intent.json");
    expect(intent).toMatchObject({
      schemaVersion: CURRENT_SCHEMATIC_INTENT_SCHEMA,
      nativeContractBinding: {
        semanticIdentity: REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_IDENTITY,
        contentIdentity: REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY
      }
    });
    expect(
      firmware.executionStatus,
      JSON.stringify(
        decodeJson(firmware, "firmware/reports/schematic-pin-map-parity.json"),
        null,
        2
      )
    ).toBe("succeeded");
    const parity = decodeJson<{
      status: string;
      classification: string;
      releaseAuthorized: boolean;
      findingCount: number;
      coverage: Record<string, number>;
      validationBoundaries: {
        nativeMcuPinMapping: { machineStatus: string };
        resetBiasImplementation: { machineStatus: string };
        protocolImplementation: { machineStatus: string };
        resourceImplementation: { machineStatus: string };
      };
      sourceRevision: {
        designRevisionId: string;
        schematicInputDesignRevisionId: string;
        schematicCommittedDesignRevisionId: string;
        schematicSourceRevisionBindingIdentity: { digest: string };
        schematicStageOutputIdentity: { digest: string };
        generatedPinMapIdentity: { digest: string };
      };
    }>(firmware, "firmware/reports/schematic-pin-map-parity.json");
    expect(parity).toMatchObject({
      status: "pass",
      classification: "candidate-only",
      releaseAuthorized: false,
      findingCount: 0,
      coverage: {
        firmwarePinAssignments: ROBOTICS_CONTROLLER_V0.pins.length,
        comparedPinAssignments: ROBOTICS_CONTROLLER_V0.pins.length,
        firmwareResourceAssignments: ROBOTICS_CONTROLLER_V0.resources.length,
        comparedResourceAssignments: 0,
        firmwareProtocolAssignments: ROBOTICS_CONTROLLER_V0.protocols.length,
        comparedProtocolAssignments: 0,
        headerPinMacros: ROBOTICS_CONTROLLER_V0.pins.length
      },
      validationBoundaries: {
        nativeMcuPinMapping: { machineStatus: "PASS" },
        resetBiasImplementation: { machineStatus: "NOT_RUN" },
        protocolImplementation: { machineStatus: "NOT_RUN" },
        resourceImplementation: { machineStatus: "NOT_RUN" }
      },
      sourceRevision: {
        designRevisionId: "revision_firmware_validation",
        schematicInputDesignRevisionId: "revision_schematic_source",
        schematicCommittedDesignRevisionId: "revision_firmware_validation",
        schematicStageOutputIdentity: schematic.outputIdentity
      }
    });
    expect(parity.sourceRevision.schematicSourceRevisionBindingIdentity.digest).toMatch(
      /^[0-9a-f]{64}$/u
    );
    expect(parity.sourceRevision.generatedPinMapIdentity.digest).toMatch(/^[0-9a-f]{64}$/u);
    const passingParityEvidence = firmware.evidence.filter(
      (entry) =>
        entry.evidenceClass === "evleda_check" &&
        entry.parsedArtifactLogicalName === "firmware/reports/schematic-pin-map-parity.json"
    );
    expect(passingParityEvidence).toEqual([
      expect.objectContaining({
        validationStatus: "pass",
        claim:
          "Source-proven MCU signal, reference, physical-pin, pin-function, pin-type, native-net, generated header-pin macro, and authenticated revision mappings agree exactly; reset-bias, protocol, and timer/IRQ/DMA/resource implementation remain NOT_RUN."
      })
    ]);
    expect(passingParityEvidence[0]!.claim).not.toMatch(
      /resource.*protocol.*matches|matches.*resource.*protocol/iu
    );
    const pinMap = decodeJson<{
      schemaVersion: string;
      pinMappings: readonly Record<string, unknown>[];
      validationBoundaries: {
        nativeMcuPinMapping: { machineStatus: string };
        resetBiasImplementation: { machineStatus: string };
        protocolImplementation: { machineStatus: string };
        resourceImplementation: { machineStatus: string };
      };
      normalization: {
        analyzerId: string;
        analyzerTool: unknown;
        sourceReportLogicalName: string;
        sourceReportIdentity: { digest: string; size: number };
        nativeNetlistLogicalName: string;
        nativeNetlistIdentity: { digest: string; size: number };
        derivation: {
          nativeNetlistIdentity: { digest: string; size: number };
          mappingModelIdentity: { digest: string; schemaVersion: string };
        };
      };
    }>(schematic, "schematic/generated-pin-map.json");
    expect(pinMap.schemaVersion).toBe(CURRENT_SCHEMATIC_PIN_MAP_SCHEMA);
    expect(pinMap.pinMappings).toHaveLength(ROBOTICS_CONTROLLER_V0.pins.length);
    expect(pinMap.pinMappings.every((mapping) =>
      canonicalJson(Object.keys(mapping).sort()) ===
      canonicalJson([
        "mcuPin",
        "nativeNetName",
        "physicalPin",
        "pinFunction",
        "pinType",
        "reference",
        "signal"
      ])
    )).toBe(true);
    expect(pinMap).not.toHaveProperty("pins");
    expect(pinMap).not.toHaveProperty("resources");
    expect(pinMap).not.toHaveProperty("protocols");
    const pinMapText = canonicalJson(pinMap);
    expect(pinMapText).not.toMatch(/externalBias|resetState|safetyPurpose/iu);
    expect(pinMapText).not.toMatch(/10\s*k(?:ilo)?ohm|buffer output has pull-down/iu);
    expect(pinMap.validationBoundaries).toMatchObject({
      nativeMcuPinMapping: { machineStatus: "PASS" },
      resetBiasImplementation: { machineStatus: "NOT_RUN" },
      protocolImplementation: { machineStatus: "NOT_RUN" },
      resourceImplementation: { machineStatus: "NOT_RUN" }
    });
    expect(pinMap.normalization).toMatchObject({
      analyzerId: REFERENCE_CONNECTIVITY_ANALYZER_ID,
      analyzerTool: REFERENCE_CONNECTIVITY_ANALYZER_TOOL
    });
    const connectivityArtifact = schematic.artifacts.find(
      (entry) => entry.logicalName === pinMap.normalization.sourceReportLogicalName
    )!;
    const nativeNetlistArtifact = schematic.artifacts.find(
      (entry) => entry.logicalName === pinMap.normalization.nativeNetlistLogicalName
    )!;
    expect(connectivityArtifact.tool).toEqual(REFERENCE_CONNECTIVITY_ANALYZER_TOOL);
    expect(contentIdentity(connectivityArtifact.content)).toEqual(
      pinMap.normalization.sourceReportIdentity
    );
    expect(nativeNetlistArtifact.tool.adapter).toBe("kicad_cli");
    expect(contentIdentity(nativeNetlistArtifact.content)).toEqual(
      pinMap.normalization.nativeNetlistIdentity
    );
    expect(pinMap.normalization.derivation.nativeNetlistIdentity).toEqual(
      pinMap.normalization.nativeNetlistIdentity
    );
    expect(pinMap.normalization.derivation.mappingModelIdentity).toEqual(
      firmwareParityMappingModelIdentity(ROBOTICS_CONTROLLER_V0)
    );
    const pinMapArtifact = schematic.artifacts.find(
      (entry) => entry.logicalName === "schematic/generated-pin-map.json"
    )!;
    expect(pinMapArtifact.exactInputs).toContainEqual(
      canonicalIdentity(ROBOTICS_CONTROLLER_V0, "evleda.reference-profile.v1")
    );
    expect(pinMapArtifact.exactInputs).toContainEqual(
      firmwareParityMappingModelIdentity(ROBOTICS_CONTROLLER_V0)
    );
    expect(
      schematic.evidence.filter(
        (entry) => entry.parsedArtifactLogicalName === connectivityArtifact.logicalName
      )
    ).toEqual([
      expect.objectContaining({
        evidenceClass: "evleda_check",
        tool: REFERENCE_CONNECTIVITY_ANALYZER_TOOL,
        validationStatus: "pass"
      })
    ]);
    expect(
      schematic.evidence.filter(
        (entry) => entry.rawArtifactLogicalName === nativeNetlistArtifact.logicalName
      )
    ).toEqual([
      expect.objectContaining({
        evidenceClass: "kicad_native",
        validationStatus: "pass"
      })
    ]);
    expect(
      schematic.evidence.some(
        (entry) =>
          entry.evidenceClass === "kicad_native" &&
          (entry.rawArtifactLogicalName === connectivityArtifact.logicalName ||
            entry.parsedArtifactLogicalName === connectivityArtifact.logicalName)
      )
    ).toBe(false);

    const compile = decodeJson<{
      status: string;
      classification: string;
      releaseAuthorized: boolean;
      sourceRevision: {
        designRevisionId: string;
        firmwareCompileSourceIdentity: { digest: string };
      };
      toolchain: { tool: { executableDigest: string } };
      limitations: readonly string[];
    }>(firmware, "firmware/reports/compile-validation.json");
    expect(compile).toMatchObject({
      status: "pass",
      classification: "candidate-only",
      releaseAuthorized: false,
      sourceRevision: { designRevisionId: "revision_firmware_validation" }
    });
    expect(compile.sourceRevision.firmwareCompileSourceIdentity.digest).toMatch(
      /^[0-9a-f]{64}$/u
    );
    expect(compile.toolchain.tool.executableDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(compile.limitations.join(" ")).toMatch(/target STM32.*unproven/iu);
    const generatedSource = Buffer.from(
      firmware.artifacts.find(
        (artifact) => artifact.logicalName === "firmware/src/board_contract.c"
      )!.content
    ).toString("utf8");
    const generatedValidation = Buffer.from(
      firmware.artifacts.find(
        (artifact) => artifact.logicalName === "firmware/tests/board_contract_validation.c"
      )!.content
    ).toString("utf8");
    expect(generatedSource).toContain("if (!evl_board_force_safe(io)) { return EVL_INIT_SAFE_OUTPUT_FAILURE; }");
    expect(generatedValidation).toContain("EVL_INIT_SAFE_OUTPUT_FAILURE");
  });

  it.each(["cross-run", "cross-attempt", "relabelled-stage"] as const)(
    "rejects a coherently rehashed %s source-revision binding",
    async (variant) => {
      const { firmware } = await executeFirmware({
        beforeFirmwareExecute: (context) => {
          const schematicIndex = context.upstreamSourceRevisionBindings.findIndex(
            (binding) => binding.stage === "schematic"
          );
          const schematic = context.upstream.find((result) => result.stage === "schematic")!;
          const component = context.upstream.find(
            (result) => result.stage === "component_selection"
          )!;
          const boundResult = variant === "cross-attempt"
            ? {
                ...schematic,
                outputIdentity: canonicalIdentity(
                  { otherAttempt: true },
                  "evleda.stage-result.schematic.v1"
                )
              }
            : variant === "relabelled-stage"
              ? component
              : schematic;
          const replacement = fixtureUpstreamSourceRevisionBinding({
            projectId: context.projectId,
            runId: variant === "cross-run" ? "run_foreign_firmware_binding" : context.runId,
            result: boundResult,
            sourceRevisionId:
              variant === "relabelled-stage"
                ? "revision_component_source"
                : "revision_schematic_source",
            committedRevisionId:
              variant === "relabelled-stage"
                ? "revision_component_committed"
                : context.designRevisionId,
            attemptId: `attempt_coherent_${variant}`
          });
          (context as unknown as {
            upstreamSourceRevisionBindings: typeof context.upstreamSourceRevisionBindings;
          }).upstreamSourceRevisionBindings = context.upstreamSourceRevisionBindings.map(
            (binding, index) => index === schematicIndex ? replacement : binding
          );
        }
      });

      const parity = decodeJson<{
        status: string;
        findings: readonly { code: string }[];
      }>(firmware, "firmware/reports/schematic-pin-map-parity.json");
      expect(firmware.executionStatus).toBe("blocked");
      expect(parity.status).toBe("fail");
      expect(parity.findings.map((finding) => finding.code)).toContain(
        "UPSTREAM_SOURCE_REVISION_BINDINGS_INVALID"
      );
    }
  );

  it("requires an explicit rerun for legacy v1 and rejects a legacy-shaped body relabelled v2", async () => {
    const mutateIntent = (
      schematic: StageExecutionResult,
      mutate: (value: Record<string, unknown>) => Record<string, unknown>
    ): StageExecutionResult => {
      const intentArtifact = schematic.artifacts.find(
        (artifact) => artifact.logicalName === "schematic/schematic-intent.json"
      )!;
      const value = JSON.parse(Buffer.from(intentArtifact.content).toString("utf8")) as Record<
        string,
        unknown
      >;
      const content = Buffer.from(`${canonicalJson(mutate(value))}\n`);
      const replacement = {
        ...intentArtifact,
        content,
        identity: contentIdentity(content)
      };
      return finalizeStageResult(
        "schematic",
        schematic.artifacts.map((artifact) =>
          artifact.logicalName === intentArtifact.logicalName ? replacement : artifact
        ),
        schematic.evidence,
        schematic.blockers
      );
    };

    const legacy = await executeFirmware({
      schematicMutator: (schematic) =>
        mutateIntent(schematic, (value) => ({
          ...value,
          schemaVersion: LEGACY_SCHEMATIC_INTENT_SCHEMA
        }))
    });
    const legacyParity = decodeJson<{
      status: string;
      findings: readonly { code: string }[];
    }>(legacy.firmware, "firmware/reports/schematic-pin-map-parity.json");
    expect(legacy.firmware.executionStatus).toBe("blocked");
    expect(legacyParity.findings.map((finding) => finding.code)).toContain(
      "SCHEMATIC_INTENT_UPGRADE_REQUIRED"
    );

    const relabelled = await executeFirmware({
      schematicMutator: (schematic) =>
        mutateIntent(schematic, (value) => {
          const {
            functionalGroups: _functionalGroups,
            nativeContractBinding: _nativeContractBinding,
            schematicStructure: _schematicStructure,
            ...legacyShape
          } = value;
          return {
            ...legacyShape,
            schemaVersion: CURRENT_SCHEMATIC_INTENT_SCHEMA,
            hierarchicalSheets: [{ name: "root" }]
          };
        })
    });
    const relabelledParity = decodeJson<{
      status: string;
      findings: readonly { code: string }[];
    }>(relabelled.firmware, "firmware/reports/schematic-pin-map-parity.json");
    expect(relabelled.firmware.executionStatus).toBe("blocked");
    expect(relabelledParity.findings.map((finding) => finding.code)).toContain(
      "SCHEMATIC_INTENT_INVALID"
    );
  });

  it("keeps generated pin-map v1 replay-only and requires an explicit schematic rerun", async () => {
    const { firmware } = await executeFirmware({
      schematicMutator: (schematic) => {
        const pinMapArtifact = schematic.artifacts.find(
          (artifact) => artifact.logicalName === "schematic/generated-pin-map.json"
        )!;
        const pinMap = JSON.parse(
          Buffer.from(pinMapArtifact.content).toString("utf8")
        ) as Record<string, unknown>;
        const content = Buffer.from(`${canonicalJson({
          ...pinMap,
          schemaVersion: LEGACY_SCHEMATIC_PIN_MAP_SCHEMA
        })}\n`);
        return finalizeStageResult(
          "schematic",
          schematic.artifacts.map((artifact) =>
            artifact.logicalName === pinMapArtifact.logicalName
              ? { ...pinMapArtifact, content, identity: contentIdentity(content) }
              : artifact
          ),
          schematic.evidence,
          schematic.blockers
        );
      }
    });

    const parity = decodeJson<{
      status: string;
      findings: readonly { code: string; message: string }[];
    }>(firmware, "firmware/reports/schematic-pin-map-parity.json");
    expect(firmware.executionStatus).toBe("blocked");
    expect(parity.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SCHEMATIC_PIN_MAP_UPGRADE_REQUIRED",
          message: expect.stringMatching(/replay-only.*explicitly rerun/iu)
        })
      ])
    );
  });

  it("rejects a structurally valid evleda_check from any analyzer other than the approved connectivity analyzer", async () => {
    const arbitraryAnalyzerId = "evleda.unapproved.connectivity.v2";
    const arbitraryTool = {
      name: "Unapproved connectivity analyzer",
      version: "9.9.9",
      adapter: "evleda" as const,
      capabilityProfile: arbitraryAnalyzerId
    };
    const { schematic, firmware } = await executeFirmware({
      backendResultMutator: (result) => ({
        ...result,
        reports: result.reports.map((report) => {
          if (report.kind !== "connectivity" || report.evidenceClass !== "evleda_check") {
            return report;
          }
          const document = JSON.parse(Buffer.from(report.content).toString("utf8")) as Record<
            string,
            unknown
          >;
          const authority = {
            ...report.authority,
            analyzerId: arbitraryAnalyzerId,
            tool: arbitraryTool
          };
          return {
            ...report,
            authority,
            content: Buffer.from(`${JSON.stringify({ ...document, authority })}\n`)
          };
        })
      })
    });

    const pinMap = decodeJson<{ normalization: { status: string; code: string } }>(
      schematic,
      "schematic/generated-pin-map.json"
    );
    expect(pinMap.normalization).toEqual(
      expect.objectContaining({
        status: "unsupported",
        code: "ANALYZED_PIN_MAP_REPORT_MISSING"
      })
    );
    expect(firmware.executionStatus).toBe("blocked");
  });

  it.each(["agent_claim", "kicad_native"] as const)(
    "does not let %s evidence substitute for the approved analyzer evidence downstream",
    async (evidenceClass) => {
      const { firmware } = await executeFirmware({
        schematicMutator: (schematic) => {
          const pinMap = decodeJson<{
            normalization: { sourceReportLogicalName: string };
          }>(schematic, "schematic/generated-pin-map.json");
          return {
            ...schematic,
            evidence: schematic.evidence.map((entry) => {
              if (
                entry.parsedArtifactLogicalName !==
                pinMap.normalization.sourceReportLogicalName
              ) {
                return entry;
              }
              if (evidenceClass === "kicad_native") {
                const { parsedArtifactLogicalName, ...withoutParsedBinding } = entry;
                return {
                  ...withoutParsedBinding,
                  evidenceClass,
                  rawArtifactLogicalName: parsedArtifactLogicalName
                };
              }
              return { ...entry, evidenceClass };
            })
          };
        }
      });

      const parity = decodeJson<{
        status: string;
        findings: readonly { code: string }[];
      }>(firmware, "firmware/reports/schematic-pin-map-parity.json");
      expect(parity.status).toBe("fail");
      expect(parity.findings.map((finding) => finding.code)).toContain(
        "ANALYZED_CONNECTIVITY_PROVENANCE_INVALID"
      );
    }
  );

  it("rejects a native-netlist artifact whose current bytes no longer match the analyzer binding", async () => {
    const { firmware } = await executeFirmware({
      schematicMutator: (schematic) => {
        const pinMap = decodeJson<{
          normalization: { nativeNetlistLogicalName: string };
        }>(schematic, "schematic/generated-pin-map.json");
        return {
          ...schematic,
          artifacts: schematic.artifacts.map((artifact) =>
            artifact.logicalName === pinMap.normalization.nativeNetlistLogicalName
              ? { ...artifact, content: Buffer.from("tampered-native-netlist") }
              : artifact
          )
        };
      }
    });

    const parity = decodeJson<{
      status: string;
      findings: readonly { code: string }[];
    }>(firmware, "firmware/reports/schematic-pin-map-parity.json");
    expect(parity.status).toBe("fail");
    expect(parity.findings.map((finding) => finding.code)).toContain(
      "NATIVE_NETLIST_PROVENANCE_INVALID"
    );
  });

  it("does not copy or elevate backend-declared reset-bias and safety prose", async () => {
    const { schematic, firmware } = await executeFirmware({
      connectivityPayload: (request) =>
        nativeFirmwareParityReport(request.profile, request.expectedSourceRevisionDigest, {
          pins: request.profile.pins.map((pin) =>
            pin.signal === "MOTOR_A_PWM"
              ? {
                  ...pin,
                  resetState: "invented safe state",
                  externalBias: "10 kohm pull-down",
                  safetyPurpose: "invented safety proof"
                }
              : pin.signal.startsWith("ENC_")
                ? { ...pin, externalBias: "buffer output has pull-down" }
                : pin
          )
        })
    });

    expect(firmware.executionStatus).toBe("succeeded");
    const parity = decodeJson<{
      status: string;
      validationBoundaries: {
        nativeMcuPinMapping: { machineStatus: string };
        resetBiasImplementation: { machineStatus: string };
      };
    }>(firmware, "firmware/reports/schematic-pin-map-parity.json");
    expect(parity).toMatchObject({
      status: "pass",
      validationBoundaries: {
        nativeMcuPinMapping: { machineStatus: "PASS" },
        resetBiasImplementation: { machineStatus: "NOT_RUN" }
      }
    });
    const pinMapText = canonicalJson(
      decodeJson<Record<string, unknown>>(schematic, "schematic/generated-pin-map.json")
    );
    expect(pinMapText).not.toMatch(/invented safe state|invented safety proof/iu);
    expect(pinMapText).not.toMatch(/10\s*k(?:ilo)?ohm|buffer output has pull-down/iu);
  });

  it("rejects a source-proven native MCU pin mapping that differs from its native nodes", async () => {
    const { firmware } = await executeFirmware({
      connectivityPayload: (request) => {
        const report = JSON.parse(
          Buffer.from(
            nativeFirmwareParityReport(request.profile, request.expectedSourceRevisionDigest)
          ).toString("utf8")
        ) as {
          payload: { firmwareParity: { nativeNodes: Record<string, unknown>[] } };
        };
        report.payload.firmwareParity.nativeNodes =
          report.payload.firmwareParity.nativeNodes.map((node) =>
            node.signal === "MOTOR_A_PWM" ? { ...node, mcuPin: "PA10" } : node
          );
        return Buffer.from(`${JSON.stringify(report)}\n`);
      }
    });

    expect(firmware.executionStatus).toBe("blocked");
    const parity = decodeJson<{
      status: string;
      findings: readonly { code: string }[];
    }>(firmware, "firmware/reports/schematic-pin-map-parity.json");
    expect(parity.status).toBe("unsupported");
    expect(parity.findings.map((finding) => finding.code)).toContain(
      "NATIVE_PIN_MAP_NOT_PASSING"
    );
  });

  it("does not copy or elevate backend-declared resource and protocol echoes", async () => {
    const { schematic, firmware } = await executeFirmware({
      connectivityPayload: (request) =>
        nativeFirmwareParityReport(request.profile, request.expectedSourceRevisionDigest, {
          resources: request.profile.resources.map((resource) =>
            resource.owner === "motor_pwm"
              ? { ...resource, irq: "WRONG_IRQ" }
              : resource
          ),
          protocols: request.profile.protocols.map((protocol) =>
            protocol.name === "CAN"
              ? { ...protocol, pins: ["CAN_RX", "CAN_TX"] }
              : protocol
          )
        })
    });

    const parity = decodeJson<{
      status: string;
      coverage: {
        comparedResourceAssignments: number;
        comparedProtocolAssignments: number;
      };
      validationBoundaries: {
        protocolImplementation: { machineStatus: string };
        resourceImplementation: { machineStatus: string };
      };
    }>(firmware, "firmware/reports/schematic-pin-map-parity.json");
    expect(firmware.executionStatus).toBe("succeeded");
    expect(parity).toMatchObject({
      status: "pass",
      coverage: {
        comparedResourceAssignments: 0,
        comparedProtocolAssignments: 0
      },
      validationBoundaries: {
        protocolImplementation: { machineStatus: "NOT_RUN" },
        resourceImplementation: { machineStatus: "NOT_RUN" }
      }
    });
    const pinMap = decodeJson<Record<string, unknown>>(
      schematic,
      "schematic/generated-pin-map.json"
    );
    expect(pinMap).not.toHaveProperty("resources");
    expect(pinMap).not.toHaveProperty("protocols");
    expect(canonicalJson(pinMap)).not.toContain("WRONG_IRQ");
  });

  it("fails closed when native node-level pin-map evidence is absent", async () => {
    const { schematic, firmware } = await executeFirmware({
      connectivityPayload: () => Buffer.from('{"kind":"connectivity","status":"pass"}\n')
    });

    const pinMapArtifact = schematic.artifacts.find(
      (entry) => entry.logicalName === "schematic/generated-pin-map.json"
    );
    expect(pinMapArtifact?.validationStatus).toBe("unsupported");
    expect(firmware.executionStatus).toBe("blocked");
    const parity = decodeJson<{
      status: string;
      findings: readonly { code: string }[];
    }>(firmware, "firmware/reports/schematic-pin-map-parity.json");
    expect(parity.status).toBe("unsupported");
    expect(parity.findings.map((entry) => entry.code)).toContain("NATIVE_PIN_MAP_NOT_PASSING");
  });

  it("does not accept a profile echo that lacks exact native derivation identities", async () => {
    const { schematic, firmware } = await executeFirmware({
      connectivityPayload: (request) =>
        nativeFirmwareParityReport(request.profile, request.expectedSourceRevisionDigest, {
          derivation: null
        })
    });

    expect(
      schematic.artifacts.find(
        (entry) => entry.logicalName === "schematic/generated-pin-map.json"
      )?.validationStatus
    ).toBe("unsupported");
    const parity = decodeJson<{
      status: string;
      findings: readonly { code: string }[];
    }>(firmware, "firmware/reports/schematic-pin-map-parity.json");
    expect(parity.status).toBe("unsupported");
    expect(parity.findings.map((entry) => entry.code)).toContain(
      "NATIVE_PIN_MAP_DERIVATION_INVALID"
    );
  });

  it("rejects native assignments bound to a different schematic source revision", async () => {
    const { schematic, firmware } = await executeFirmware({
      connectivityPayload: (request) =>
        nativeFirmwareParityReport(request.profile, "0".repeat(64))
    });

    expect(
      schematic.artifacts.find(
        (entry) => entry.logicalName === "schematic/generated-pin-map.json"
      )?.validationStatus
    ).toBe("unsupported");
    expect(firmware.executionStatus).toBe("blocked");
    const parity = decodeJson<{ status: string; findingCount: number }>(
      firmware,
      "firmware/reports/schematic-pin-map-parity.json"
    );
    expect(parity.status).toBe("unsupported");
    expect(parity.findingCount).toBeGreaterThan(0);
  });

  it("records unsupported and blocks when no explicit compiler toolchain is configured", async () => {
    const { firmware } = await executeFirmware({
      compileBackend: new LocalFirmwareCompileBackend({ environment: {} })
    });

    expect(firmware.executionStatus).toBe("blocked");
    expect(firmware.blockers.map((entry) => entry.code)).toContain(
      "FIRMWARE_TOOLCHAIN_UNSUPPORTED"
    );
    const compile = decodeJson<{
      status: string;
      code: string;
      classification: string;
      releaseAuthorized: boolean;
      toolchain: { tool: unknown; requestedCompilerPath: unknown };
    }>(firmware, "firmware/reports/compile-validation.json");
    expect(compile).toMatchObject({
      status: "unsupported",
      code: "FIRMWARE_TOOLCHAIN_NOT_CONFIGURED",
      classification: "candidate-only",
      releaseAuthorized: false,
      toolchain: { tool: null, requestedCompilerPath: null }
    });
    expect(
      firmware.evidence.some(
        (entry) => entry.validationStatus === "pass" && entry.claim.includes("host validation")
      )
    ).toBe(false);
  });

  it("persists a deterministic failed compile report when the identified compiler rejects the scaffold", async () => {
    const passing = passingFirmwareCompileBackend();
    const failingBackend: FirmwareCompileBackend = {
      backendId: "failing-firmware-compiler-test-double",
      configuration: {
        ...passing.configuration,
        backendId: "failing-firmware-compiler-test-double"
      },
      execute: async (request) => {
        const result = await passing.execute(request);
        return {
          ...result,
          backendId: "failing-firmware-compiler-test-double",
          status: "fail",
          code: "FIRMWARE_COMPILE_FAILED",
          message: "The identified fixture compiler rejected the exact generated scaffold.",
          steps: result.steps.map((step) =>
            step.operation === "compile_and_link"
              ? { ...step, exitCode: 1, stderr: "fixture compile error\n" }
              : step
          )
        };
      }
    };
    const { firmware } = await executeFirmware({ compileBackend: failingBackend });

    expect(firmware.executionStatus).toBe("blocked");
    expect(firmware.blockers.map((entry) => entry.code)).toContain(
      "FIRMWARE_COMPILE_VALIDATION_FAILED"
    );
    const compile = decodeJson<{
      status: string;
      code: string;
      steps: readonly { operation: string; exitCode: number | null; stderr: string }[];
    }>(firmware, "firmware/reports/compile-validation.json");
    expect(compile).toMatchObject({ status: "fail", code: "FIRMWARE_COMPILE_FAILED" });
    expect(compile.steps).toContainEqual(
      expect.objectContaining({
        operation: "compile_and_link",
        exitCode: 1,
        stderr: "fixture compile error\n"
      })
    );
  });

  it("rejects an injected compile pass with forged steps, sources, or validation binary evidence", async () => {
    const passing = passingFirmwareCompileBackend();
    const forged: FirmwareCompileBackend = {
      backendId: "forged-compile-pass",
      configuration: { ...passing.configuration, backendId: "forged-compile-pass" },
      execute: async (request) => {
        const result = await passing.execute(request);
        return {
          ...result,
          backendId: "forged-compile-pass",
          validationExecutableIdentity: undefined,
          compiledSources: [],
          steps: result.steps.slice(0, 3)
        } as unknown as Awaited<ReturnType<FirmwareCompileBackend["execute"]>>;
      }
    };
    const { firmware } = await executeFirmware({ compileBackend: forged });
    const compile = decodeJson<{ status: string; code: string }>(
      firmware,
      "firmware/reports/compile-validation.json"
    );
    expect(compile).toEqual(expect.objectContaining({
      status: "fail",
      code: "FIRMWARE_COMPILE_RESULT_INVALID"
    }));
  });

  it("rejects pass-labelled compile results with the wrong code, configured path, or command identity", async () => {
    const passing = passingFirmwareCompileBackend();
    const mutations = [
      (result: Awaited<ReturnType<FirmwareCompileBackend["execute"]>>) => ({
        ...result, code: "FIRMWARE_PARTIAL_PASS",
      }),
      (result: Awaited<ReturnType<FirmwareCompileBackend["execute"]>>) => ({
        ...result, requestedCompilerPath: path.resolve("fixtures", "different-compiler"),
        tool: { ...result.tool!, executablePath: path.resolve("fixtures", "different-compiler") },
      }),
      (result: Awaited<ReturnType<FirmwareCompileBackend["execute"]>>) => ({
        ...result,
        steps: result.steps.map((step, index) => index === 0
          ? { ...step, commandIdentity: contentIdentity("different-compiler") }
          : step),
      }),
    ];
    for (const [index, mutate] of mutations.entries()) {
      const backendId = `forged-compile-binding-${index.toString()}`;
      const backend: FirmwareCompileBackend = {
        backendId,
        configuration: { ...passing.configuration, backendId },
        execute: async (request) => mutate({ ...(await passing.execute(request)), backendId }),
      };
      const { firmware } = await executeFirmware({ compileBackend: backend });
      expect(decodeJson<{ status: string; code: string }>(
        firmware,
        "firmware/reports/compile-validation.json",
      )).toEqual(expect.objectContaining({
        status: "fail",
        code: "FIRMWARE_COMPILE_RESULT_INVALID",
      }));
    }
  });

  it("rejects accessor-backed backend results before validation or artifact reuse", async () => {
    const passingCompile = passingFirmwareCompileBackend();
    const accessorCompile: FirmwareCompileBackend = {
      ...passingCompile,
      execute: async (request) => {
        const result = await passingCompile.execute(request);
        const accessor = { ...result } as Record<string, unknown>;
        Object.defineProperty(accessor, "code", {
          enumerable: true,
          get: () => "FIRMWARE_HOST_C11_VALIDATION_PASSED",
        });
        return accessor as unknown as Awaited<ReturnType<FirmwareCompileBackend["execute"]>>;
      },
    };
    const passingTarget = passingFirmwareTargetBuildBackend();
    const accessorTarget: FirmwareTargetBuildBackend = {
      ...passingTarget,
      execute: async (request) => {
        const result = await passingTarget.execute(request);
        const first = result.outputs[0]!;
        const accessorOutput = { ...first } as Record<string, unknown>;
        Object.defineProperty(accessorOutput, "logicalName", {
          enumerable: true,
          get: () => first.logicalName,
        });
        return {
          ...result,
          outputs: [accessorOutput, ...result.outputs.slice(1)],
        } as unknown as Awaited<ReturnType<FirmwareTargetBuildBackend["execute"]>>;
      },
    };
    const { firmware } = await executeFirmware({
      compileBackend: accessorCompile,
      targetBuildBackend: accessorTarget,
    });
    expect(decodeJson<{ code: string }>(
      firmware,
      "firmware/reports/compile-validation.json",
    ).code).toBe("FIRMWARE_COMPILE_RESULT_INVALID");
    expect(decodeJson<{ code: string }>(
      firmware,
      "firmware/reports/stm32g0-target-build.json",
    ).code).toBe("FIRMWARE_TARGET_BUILD_RESULT_INVALID");
    expect(firmware.artifacts.some((artifact) => artifact.logicalName.startsWith("firmware/build/"))).toBe(false);
  });

  it("rejects extra result fields and oversized compiler output", async () => {
    const passing = passingFirmwareCompileBackend();
    const oversized: FirmwareCompileBackend = {
      ...passing,
      execute: async (request) => ({
        ...(await passing.execute(request)),
        unexpectedAttestation: true,
        steps: [
          {
            operation: "compiler_version" as const,
            arguments: ["--version"],
            exitCode: 0,
            stdout: "x".repeat(256 * 1024 + 1),
            stderr: ""
          }
        ]
      } as unknown as Awaited<ReturnType<FirmwareCompileBackend["execute"]>>)
    };
    const { firmware } = await executeFirmware({ compileBackend: oversized });

    expect(decodeJson<{ status: string; code: string }>(
      firmware,
      "firmware/reports/compile-validation.json"
    )).toEqual(expect.objectContaining({
      status: "fail",
      code: "FIRMWARE_COMPILE_RESULT_INVALID"
    }));
  });

  it("clones generated source bytes before dispatching an injected backend", async () => {
    const passing = passingFirmwareCompileBackend();
    const mutating: FirmwareCompileBackend = {
      ...passing,
      execute: async (request) => {
        request.sources[0]!.content.fill(0);
        return passing.execute(request);
      }
    };
    const { firmware } = await executeFirmware({ compileBackend: mutating });
    const header = firmware.artifacts.find(
      (artifact) => artifact.logicalName === "firmware/include/board_contract.h"
    )!;

    expect(firmware.executionStatus).toBe("succeeded");
    expect(Buffer.from(header.content).toString("utf8")).toContain("EVLEDA_BOARD_CONTRACT_H");
    expect(contentIdentity(header.content)).toEqual(header.identity);
  });

  it("passes the exact emitted sources through bounded compile, link, and validation steps", async () => {
    const invocations: BoundedProcessOptions[] = [];
    let compiledSource = "";
    const runner: BoundedProcessRunner = async (options) => {
      invocations.push(options);
      if (options.args.length === 1 && options.args[0] === "--version") {
        return processResult(options, { stdout: "clang version 99.0.0\n" });
      }
      if (options.args.length === 1 && options.args[0] === "-dumpmachine") {
        return processResult(options, { stdout: `${hostTargetTriple()}\n` });
      }
      if (options.args.includes("src/board_contract.c")) {
        compiledSource = await readFile(path.join(options.cwd, "src", "board_contract.c"), "utf8");
        const outputName = options.args.at(-1)!;
        await writeFile(path.join(options.cwd, ...outputName.split("/")), "fixture executable");
        return processResult(options);
      }
      return processResult(options);
    };
    const compileBackend = new LocalFirmwareCompileBackend({
        compilerPath: process.execPath,
        environment: {
          PATH: process.env.PATH,
          LD_LIBRARY_PATH: "must-not-be-inherited",
          EVLEDA_UNRELATED_SECRET: "must-not-be-inherited",
        },
        runner
      });
    const { firmware } = await executeFirmware({
      compileBackend,
    });

    expect(firmware.executionStatus).toBe("succeeded");
    expect(compiledSource).toContain("evl_board_init_safe");
    expect(compiledSource).toContain("board_revision_matches");
    expect(invocations.map((entry) => entry.args)).toEqual(
      expect.arrayContaining([
        ["--version"],
        ["-dumpmachine"],
        expect.arrayContaining([
          "-std=c11",
          "-Werror",
          "src/board_contract.c",
          "tests/board_contract_validation.c"
        ]),
        []
      ])
    );
    expect(compileBackend.configuration.executionPolicy).toMatchObject({
      agentDerivedOrUntrustedSourceExecution: "deny",
      osSandbox: "none",
      containmentClaim: "not-contained",
      executableStrategy: "identity-checked-shared-path",
      lto: "disabled",
      linkerPlugin: "disabled",
    });
    expect(compileBackend.configuration.resourceLimits).toEqual(FIRMWARE_COMPILE_RESOURCE_LIMITS);
    expect(compileBackend.configuration.compileArguments).toEqual(expect.arrayContaining([
      "-fno-lto", "-fno-use-linker-plugin",
    ]));
    expect(invocations[0]!.env).not.toHaveProperty("LD_LIBRARY_PATH");
    expect(invocations[0]!.env).not.toHaveProperty("EVLEDA_UNRELATED_SECRET");
    expect(invocations[0]!.env.PATH).toBe(path.dirname(process.execPath));
    expect(invocations[0]!.env.TEMP).toBe(invocations[0]!.cwd);
    expect(invocations.at(-1)!.command).toBe(path.join(
      invocations.at(-1)!.cwd,
      "run",
      process.platform === "win32" ? "board_contract_validation.exe" : "board_contract_validation",
    ));
  });

  it("fails closed before invoking a compiler for untrusted-origin or oversized source requests", async () => {
    const passing = passingFirmwareCompileBackend();
    let captured: Parameters<FirmwareCompileBackend["execute"]>[0] | undefined;
    const capture: FirmwareCompileBackend = {
      ...passing,
      execute: async (request) => {
        captured = structuredClone(request);
        return passing.execute(request);
      },
    };
    await executeFirmware({ compileBackend: capture });
    expect(captured).toBeDefined();
    let invocations = 0;
    const backend = new LocalFirmwareCompileBackend({
      compilerPath: process.execPath,
      environment: {},
      runner: async (options) => {
        invocations += 1;
        return processResult(options);
      },
    });
    const configurationIdentity = canonicalIdentity(
      backend.configuration,
      "evleda.firmware-compile-backend-config.v1",
    );
    const untrusted = await backend.execute({
      ...captured!,
      configurationIdentity,
      sourceOrigin: "agent-derived" as never,
    });
    expect(untrusted).toEqual(expect.objectContaining({
      status: "unsupported", code: "FIRMWARE_COMPILE_REQUEST_INVALID",
    }));
    const oversizedBytes = Buffer.alloc(FIRMWARE_COMPILE_RESOURCE_LIMITS.maxSourceBytes + 1, 1);
    const oversized = await backend.execute({
      ...captured!,
      configurationIdentity,
      sources: captured!.sources.map((source, index) => index === 0
        ? { ...source, content: oversizedBytes, identity: contentIdentity(oversizedBytes) }
        : source),
    });
    expect(oversized).toEqual(expect.objectContaining({
      status: "fail", code: "FIRMWARE_COMPILE_SOURCE_INVALID",
    }));
    expect(invocations).toBe(0);
  });

  it("rejects detached execution policies and closure declarations before backend dispatch", async () => {
    const compile = passingFirmwareCompileBackend();
    let compileCalls = 0;
    const detachedCompile: FirmwareCompileBackend = {
      ...compile,
      configuration: {
        ...compile.configuration,
        executionPolicy: {
          ...compile.configuration.executionPolicy,
          linkerPlugin: "enabled" as never,
        },
      },
      execute: async (request) => {
        compileCalls += 1;
        return compile.execute(request);
      },
    };
    const target = passingFirmwareTargetBuildBackend();
    let targetCalls = 0;
    const detachedTarget: FirmwareTargetBuildBackend = {
      ...target,
      configuration: {
        ...target.configuration,
        toolchainFiles: target.configuration.toolchainFiles.filter((file) => file.role !== "libgcc"),
      },
      execute: async (request) => {
        targetCalls += 1;
        return target.execute(request);
      },
    };
    const { firmware } = await executeFirmware({
      compileBackend: detachedCompile,
      targetBuildBackend: detachedTarget,
    });
    expect(compileCalls).toBe(0);
    expect(targetCalls).toBe(0);
    expect(firmware.blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
      "FIRMWARE_TOOLCHAIN_UNPROVISIONED", "FIRMWARE_TARGET_TOOLCHAIN_UNPROVISIONED",
    ]));
  });

  it("rejects coherent wrong target, distribution, off-root tool, and CMSIS declarations before dispatch", async () => {
    const target = passingFirmwareTargetBuildBackend();
    const configurations: FirmwareTargetBuildBackend["configuration"][] = [
      { ...target.configuration, targetPart: "STM32G0B1CET6-WRONG" as never },
      {
        ...target.configuration,
        distribution: { ...target.configuration.distribution, sha256: "f".repeat(64) },
      },
      {
        ...target.configuration,
        toolchainFiles: target.configuration.toolchainFiles.map((file) => file.role === "cc1"
          ? { ...file, path: path.resolve("outside-toolchain", "cc1.exe") }
          : file),
      },
      {
        ...target.configuration,
        supportFiles: target.configuration.supportFiles.map((file) => file.role === "support_manifest"
          ? { ...file, identity: { ...file.identity, digest: "f".repeat(64) } }
          : file),
      },
    ];
    for (const configuration of configurations) {
      let calls = 0;
      const detached: FirmwareTargetBuildBackend = {
        ...target,
        configuration,
        execute: async (request) => {
          calls += 1;
          return target.execute(request);
        },
      };
      const { firmware } = await executeFirmware({ targetBuildBackend: detached });
      expect(calls).toBe(0);
      expect(firmware.blockers.map((blocker) => blocker.code)).toContain(
        "FIRMWARE_TARGET_TOOLCHAIN_UNPROVISIONED",
      );
    }
  });

  it("rejects results when a backend mutates its provisioned configuration during dispatch", async () => {
    const passingCompile = passingFirmwareCompileBackend();
    const compileConfiguration = structuredClone(passingCompile.configuration);
    const mutatingCompile: FirmwareCompileBackend = {
      ...passingCompile,
      configuration: compileConfiguration,
      execute: async (request) => {
        (compileConfiguration.environment as Record<string, string>).LANG = "mutated";
        return passingCompile.execute(request);
      },
    };
    const passingTarget = passingFirmwareTargetBuildBackend();
    const targetConfiguration = structuredClone(passingTarget.configuration);
    const mutatingTarget: FirmwareTargetBuildBackend = {
      ...passingTarget,
      configuration: targetConfiguration,
      execute: async (request) => {
        (targetConfiguration as { timeoutMs: number }).timeoutMs += 1;
        return passingTarget.execute(request);
      },
    };
    const { firmware } = await executeFirmware({
      compileBackend: mutatingCompile,
      targetBuildBackend: mutatingTarget,
    });
    expect(decodeJson<{ code: string }>(
      firmware,
      "firmware/reports/compile-validation.json",
    ).code).toBe("FIRMWARE_COMPILE_RESULT_INVALID");
    expect(decodeJson<{ code: string }>(
      firmware,
      "firmware/reports/stm32g0-target-build.json",
    ).code).toBe("FIRMWARE_TARGET_BUILD_RESULT_INVALID");
  });

  it("snapshots revision identity and target provisioning before the first backend await", async () => {
    let retainedContext: (CandidateStageContext & FirmwareCompileContextExtension) | undefined;
    const passingCompile = passingFirmwareCompileBackend();
    const target = passingFirmwareTargetBuildBackend();
    const mutableTargetConfiguration = structuredClone(target.configuration);
    let targetCalls = 0;
    const targetBackend: FirmwareTargetBuildBackend = {
      ...target,
      configuration: mutableTargetConfiguration,
      execute: async (request) => {
        targetCalls += 1;
        return target.execute(request);
      },
    };
    const compileBackend: FirmwareCompileBackend = {
      ...passingCompile,
      execute: async (request) => {
        (retainedContext as unknown as { designRevisionId: string }).designRevisionId = "revision_mutated_during_await";
        (mutableTargetConfiguration as { timeoutMs: number }).timeoutMs += 1;
        return passingCompile.execute(request);
      },
    };
    const { firmware } = await executeFirmware({
      compileBackend,
      targetBuildBackend: targetBackend,
      beforeFirmwareExecute: (context) => { retainedContext = context; },
    });
    expect(targetCalls).toBe(0);
    expect(decodeJson<{ sourceRevision: { designRevisionId: string } }>(
      firmware,
      "firmware/reports/compile-validation.json",
    ).sourceRevision.designRevisionId).toBe("revision_firmware_validation");
    expect(decodeJson<{ code: string; sourceRevision: { designRevisionId: string } }>(
      firmware,
      "firmware/reports/stm32g0-target-build.json",
    )).toEqual(expect.objectContaining({
      code: "FIRMWARE_TARGET_BUILD_RESULT_INVALID",
      sourceRevision: expect.objectContaining({ designRevisionId: "revision_firmware_validation" }),
    }));
  });

  it("fails closed when the separate STM32 target backend is not provisioned", async () => {
    const { firmware } = await executeFirmware({ targetBuildBackend: null });
    expect(firmware.executionStatus).toBe("blocked");
    expect(firmware.blockers.map((blocker) => blocker.code)).toContain(
      "FIRMWARE_TARGET_TOOLCHAIN_UNPROVISIONED"
    );
    const report = decodeJson<{ status: string; flashable: boolean; releaseAuthorized: boolean }>(
      firmware,
      "firmware/reports/stm32g0-target-build.json"
    );
    expect(report).toEqual(expect.objectContaining({
      status: "unsupported",
      flashable: false,
      releaseAuthorized: false,
    }));
  });

  it("rejects untrusted-origin and oversized target sources before any tool invocation", async () => {
    const passing = passingFirmwareTargetBuildBackend();
    let captured: Parameters<FirmwareTargetBuildBackend["execute"]>[0] | undefined;
    const capture: FirmwareTargetBuildBackend = {
      ...passing,
      execute: async (request) => {
        captured = structuredClone(request);
        return passing.execute(request);
      },
    };
    await executeFirmware({ targetBuildBackend: capture });
    expect(captured).toBeDefined();
    let invocations = 0;
    const backend = await createArmGnuFirmwareTargetBuildBackend({
      environment: {},
      runner: async (options) => {
        invocations += 1;
        return processResult(options);
      },
    });
    const configurationIdentity = canonicalIdentity(
      backend.configuration,
      "evleda.firmware-target-build-backend-config.v1",
    );
    expect(await backend.execute({
      ...captured!,
      configurationIdentity,
      sourceOrigin: "agent-derived" as never,
    })).toEqual(expect.objectContaining({
      status: "unsupported", code: "FIRMWARE_TARGET_REQUEST_INVALID",
    }));
    const oversizedBytes = Buffer.alloc(FIRMWARE_TARGET_RESOURCE_LIMITS.maxSourceBytes + 1, 1);
    expect(await backend.execute({
      ...captured!,
      configurationIdentity,
      sources: captured!.sources.map((source, index) => index === 0
        ? { ...source, content: oversizedBytes, identity: contentIdentity(oversizedBytes) }
        : source),
    })).toEqual(expect.objectContaining({
      status: "fail", code: "FIRMWARE_TARGET_SOURCE_INVALID",
    }));
    expect(invocations).toBe(0);
  });

  it("rejects a target backend that upgrades a candidate output to flashable or release-authorized", async () => {
    const passing = passingFirmwareTargetBuildBackend();
    const forged: FirmwareTargetBuildBackend = {
      ...passing,
      execute: async (request) => ({
        ...(await passing.execute(request)),
        flashable: true,
        releaseAuthorized: true,
      } as unknown as Awaited<ReturnType<FirmwareTargetBuildBackend["execute"]>>),
    };
    const { firmware } = await executeFirmware({ targetBuildBackend: forged });
    const report = decodeJson<{ status: string; code: string; flashable: boolean; releaseAuthorized: boolean }>(
      firmware,
      "firmware/reports/stm32g0-target-build.json"
    );
    expect(report).toEqual(expect.objectContaining({
      status: "fail",
      code: "FIRMWARE_TARGET_BUILD_RESULT_INVALID",
      flashable: false,
      releaseAuthorized: false,
    }));
  });

  it("rejects target passes with a wrong pass code, command binding, or duplicate output kind", async () => {
    const passing = passingFirmwareTargetBuildBackend();
    const mutations = [
      (result: Awaited<ReturnType<FirmwareTargetBuildBackend["execute"]>>) => ({
        ...result, code: "FIRMWARE_TARGET_PARTIAL_PASS",
      }),
      (result: Awaited<ReturnType<FirmwareTargetBuildBackend["execute"]>>) => ({
        ...result,
        steps: result.steps.map((step, index) => index === 0
          ? { ...step, commandIdentity: contentIdentity("wrong-target-command") }
          : step),
      }),
      (result: Awaited<ReturnType<FirmwareTargetBuildBackend["execute"]>>) => ({
        ...result,
        outputs: [result.outputs[0]!, result.outputs[0]!, result.outputs[2]!],
      }),
    ];
    for (const mutate of mutations) {
      const forged: FirmwareTargetBuildBackend = {
        ...passing,
        execute: async (request) => mutate(await passing.execute(request)),
      };
      const { firmware } = await executeFirmware({ targetBuildBackend: forged });
      expect(decodeJson<{ status: string; code: string }>(
        firmware,
        "firmware/reports/stm32g0-target-build.json",
      )).toEqual(expect.objectContaining({
        status: "fail", code: "FIRMWARE_TARGET_BUILD_RESULT_INVALID",
      }));
    }
  });

  it("strictly validates a passing target report for downstream physical BIN binding", async () => {
    const { firmware } = await executeFirmware();
    const report = decodeJson<unknown>(firmware, "firmware/reports/stm32g0-target-build.json");
    const expectation = {
      projectId: "project_firmware_validation",
      runId: "run_firmware_validation",
      sourceDesignRevisionId: "revision_firmware_validation",
    };
    expect(validateFirmwareTargetBuildReport(report, expectation)).toBe(true);
    const wrongCode = structuredClone(report) as Record<string, unknown>;
    wrongCode.code = "FIRMWARE_TARGET_PARTIAL_PASS";
    expect(validateFirmwareTargetBuildReport(wrongCode, expectation)).toBe(false);
    const duplicateOutput = structuredClone(report) as { outputs: unknown[] };
    duplicateOutput.outputs[1] = structuredClone(duplicateOutput.outputs[0]);
    expect(validateFirmwareTargetBuildReport(duplicateOutput, expectation)).toBe(false);
    const coherentManifestForgery = structuredClone(report) as {
      toolchain: {
        provisionedConfiguration: { supportFiles: { relativePath: string; identity: { digest: string } }[] };
        provisionedConfigurationIdentity: ReturnType<typeof canonicalIdentity>;
      };
    };
    coherentManifestForgery.toolchain.provisionedConfiguration.supportFiles.find(
      (file) => file.relativePath === "manifest.json",
    )!.identity.digest = "f".repeat(64);
    coherentManifestForgery.toolchain.provisionedConfigurationIdentity = canonicalIdentity(
      coherentManifestForgery.toolchain.provisionedConfiguration,
      "evleda.firmware-target-build-backend-config.v1",
    );
    expect(validateFirmwareTargetBuildReport(coherentManifestForgery, expectation)).toBe(false);
    const ambientEnvironmentForgery = structuredClone(report) as {
      toolchain: {
        provisionedConfiguration: {
          environment: Record<string, string>;
          environmentIdentity: ReturnType<typeof canonicalIdentity>;
        };
        provisionedConfigurationIdentity: ReturnType<typeof canonicalIdentity>;
      };
    };
    ambientEnvironmentForgery.toolchain.provisionedConfiguration.environment.LD_LIBRARY_PATH = "ambient";
    ambientEnvironmentForgery.toolchain.provisionedConfiguration.environmentIdentity = canonicalIdentity(
      ambientEnvironmentForgery.toolchain.provisionedConfiguration.environment,
      "evleda.firmware-target-build-environment.v1",
    );
    ambientEnvironmentForgery.toolchain.provisionedConfigurationIdentity = canonicalIdentity(
      ambientEnvironmentForgery.toolchain.provisionedConfiguration,
      "evleda.firmware-target-build-backend-config.v1",
    );
    expect(validateFirmwareTargetBuildReport(ambientEnvironmentForgery, expectation)).toBe(false);
  });

  it("emits ST-derived linker bounds and forces safe GPIO state before any target validation", async () => {
    const { firmware } = await executeFirmware();
    const linker = Buffer.from(firmware.artifacts.find(
      (artifact) => artifact.logicalName === "firmware/target/STM32G0B1CET6.ld"
    )!.content).toString("utf8");
    expect(linker).toContain("ORIGIN = 0x08000000, LENGTH = 512K");
    expect(linker).toContain("ORIGIN = 0x20000000, LENGTH = 144K");
    expect(linker).toContain("ASSERT(ADDR(.isr_vector) == ORIGIN(FLASH)");
    expect(linker).toContain("ASSERT(_estack == 0x20024000");
    expect(linker).toContain("RAM overflow");
    const platform = Buffer.from(firmware.artifacts.find(
      (artifact) => artifact.logicalName === "firmware/target/platform_stm32g0b1.c"
    )!.content).toString("utf8");
    expect(platform.indexOf("binding.port->BSRR")).toBeLessThan(platform.indexOf("binding.port->MODER"));
    expect(platform).toContain("raw PB14/PB15 strap encoding");
    expect(platform).toContain("return false;");
    expect(platform).not.toContain("evl_board_motor_request(&io");
  });
});

const configuredCompiler = process.env.EVLEDA_FIRMWARE_CC;

it.skipIf(configuredCompiler === undefined || !existsSync(configuredCompiler))(
  "compiles and runs the emitted scaffold with the explicitly configured real native compiler",
  async () => {
    const { firmware } = await executeFirmware({
      compileBackend: new LocalFirmwareCompileBackend({
        compilerPath: configuredCompiler!,
        environment: process.env
      })
    });
    expect(
      decodeJson<{ status: string }>(firmware, "firmware/reports/compile-validation.json")
        .status
    ).toBe("pass");
  },
  60_000
);

const configuredArmGccRoot = process.env.EVLEDA_ARM_GCC_ROOT;

it.skipIf(configuredArmGccRoot === undefined || !existsSync(configuredArmGccRoot))(
  "cross-compiles deterministic non-flashable STM32G0 candidate outputs with the real pinned toolchain",
  async () => {
    const invocations: BoundedProcessOptions[] = [];
    const backend = await createArmGnuFirmwareTargetBuildBackend({
      toolchainRoot: configuredArmGccRoot!,
      environment: process.env,
      runner: async (options) => {
        invocations.push(options);
        return runBoundedProcess(options);
      },
      ...(process.env.EVLEDA_FIRMWARE_BUILD_ROOT === undefined
        ? {}
        : { temporaryRoot: process.env.EVLEDA_FIRMWARE_BUILD_ROOT }),
    });
    const first = await executeFirmware({ targetBuildBackend: backend });
    const second = await executeFirmware({ targetBuildBackend: backend });
    const report = decodeJson<{
      status: string;
      flashable: boolean;
      releaseAuthorized: boolean;
      deploymentDisposition: string;
      outputs: readonly { kind: string; identity: { digest: string; size: number } }[];
    }>(first.firmware, "firmware/reports/stm32g0-target-build.json");
    expect(report.status, JSON.stringify(report, null, 2)).toBe("pass");
    expect(report).toMatchObject({
      status: "pass",
      flashable: false,
      releaseAuthorized: false,
      deploymentDisposition: "compiled-non-flashable-candidate",
    });
    expect(report.outputs.map((output) => output.kind).sort()).toEqual(["bin", "elf", "map"]);
    expect(backend.configuration.executionPolicy).toMatchObject({
      agentDerivedOrUntrustedSourceExecution: "deny",
      osSandbox: "none",
      containmentClaim: "not-contained",
      executableStrategy: "verified-private-toolchain-closure",
      lto: "disabled",
      linkerPlugin: "disabled",
    });
    expect(backend.configuration.resourceLimits).toEqual(FIRMWARE_TARGET_RESOURCE_LIMITS);
    expect(backend.configuration.compileArguments).toEqual(expect.arrayContaining([
      "-fno-lto", "-fno-use-linker-plugin", "-nostdinc", "-nostdlib",
    ]));
    expect(backend.configuration.toolchainFiles.map((file) => file.role).sort()).toEqual([
      "assembler", "cc1", "collect2", "gcc", "ld", "libgcc", "objcopy",
    ]);
    expect(backend.configuration.toolchainFiles.some((file) =>
      /lto-wrapper|liblto_plugin/iu.test(file.relativePath))).toBe(false);
    expect(invocations).toHaveLength(12);
    for (const invocation of invocations) {
      expect(invocation.command).toContain(`${path.sep}.toolchain${path.sep}`);
      expect((invocation.env.PATH ?? "").replaceAll("/", path.sep)).toContain(`${path.sep}.toolchain${path.sep}`);
      expect(invocation.env.TEMP).toBe(invocation.cwd);
      expect(invocation.env).not.toHaveProperty("LD_LIBRARY_PATH");
      expect(invocation.env).not.toHaveProperty("EVLEDA_UNRELATED_SECRET");
    }
    const identities = (result: StageExecutionResult) => result.artifacts
      .filter((artifact) => artifact.logicalName.startsWith("firmware/build/"))
      .map((artifact) => ({ logicalName: artifact.logicalName, identity: artifact.identity }));
    expect(identities(first.firmware)).toEqual(identities(second.firmware));
    const mapText = Buffer.from(first.firmware.artifacts.find(
      (artifact) => artifact.logicalName.endsWith("candidate.map")
    )!.content).toString("utf8");
    expect(mapText).toContain("0x08000000");
    expect(mapText).toContain("0x00080000");
    expect(mapText).toContain("0x20000000");
    expect(mapText).toContain("0x00024000");
    const platform = Buffer.from(first.firmware.artifacts.find(
      (artifact) => artifact.logicalName === "firmware/target/platform_stm32g0b1.c"
    )!.content).toString("utf8");
    expect(platform.indexOf("binding.port->BSRR")).toBeLessThan(platform.indexOf("binding.port->MODER"));
    expect(platform).toContain("return false;");
    expect(platform).not.toContain("evl_board_motor_request(&io");
  },
  120_000,
);

it.skipIf(configuredArmGccRoot === undefined || !existsSync(configuredArmGccRoot))(
  "rejects wrong target tools, versions, bound digests, and missing helpers",
  async () => {
    const buildRoot = path.resolve(process.env.EVLEDA_FIRMWARE_BUILD_ROOT ?? path.join(path.dirname(configuredArmGccRoot!), "evleda-firmware-build-tests"));
    await mkdir(buildRoot, { recursive: true });
    const real = await createArmGnuFirmwareTargetBuildBackend({
      toolchainRoot: configuredArmGccRoot!, environment: process.env, temporaryRoot: buildRoot,
    });

    const wrongTool = await createArmGnuFirmwareTargetBuildBackend({
      toolchainRoot: process.execPath, environment: process.env, temporaryRoot: buildRoot,
    });
    expect(decodeJson<{ code: string }>(
      (await executeFirmware({ targetBuildBackend: wrongTool })).firmware,
      "firmware/reports/stm32g0-target-build.json"
    ).code).toBe("FIRMWARE_TARGET_BUILD_PREREQUISITES_BLOCKED");

    const wrongVersion = await createArmGnuFirmwareTargetBuildBackend({
      toolchainRoot: configuredArmGccRoot!, environment: process.env, temporaryRoot: buildRoot,
      runner: async (options) => {
        if (options.args[0] === "-dumpmachine") return processResult(options, { stdout: "arm-none-eabi\n" });
        if (options.args[0] === "--version") {
          const name = path.basename(options.command).toLowerCase();
          return processResult(options, { stdout: name.includes("gcc") ? "arm-none-eabi-gcc 13.2.1\n" : "GNU tool 2.43.1.20241119\n" });
        }
        return processResult(options);
      },
    });
    expect(decodeJson<{ code: string }>(
      (await executeFirmware({ targetBuildBackend: wrongVersion })).firmware,
      "firmware/reports/stm32g0-target-build.json"
    ).code).toBe("FIRMWARE_TARGET_TOOLCHAIN_VERSION_MISMATCH");

    const copyRoot = await mkdtemp(path.join(buildRoot, "toolchain-copy-"));
    try {
      for (const file of real.configuration.toolchainFiles) {
        const relative = path.relative(configuredArmGccRoot!, file.path);
        const destination = path.join(copyRoot, relative);
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(file.path, destination);
      }
      const copied = await createArmGnuFirmwareTargetBuildBackend({
        toolchainRoot: copyRoot, environment: process.env, temporaryRoot: buildRoot,
      });
      expect(decodeJson<{ status: string }>(
        (await executeFirmware({ targetBuildBackend: copied })).firmware,
        "firmware/reports/stm32g0-target-build.json",
      ).status).toBe("pass");
      await appendFile(
        path.join(copyRoot, "libexec", "gcc", "arm-none-eabi", "14.2.1", "collect2.exe"),
        "changed after provision",
      );
      expect(decodeJson<{ code: string }>(
        (await executeFirmware({ targetBuildBackend: copied })).firmware,
        "firmware/reports/stm32g0-target-build.json"
      ).code).toBe("FIRMWARE_TARGET_BOUND_INPUT_CHANGED");

      const missingRoot = await mkdtemp(path.join(buildRoot, "toolchain-missing-"));
      for (const file of real.configuration.toolchainFiles.filter((file) => file.role !== "objcopy")) {
        const relative = path.relative(configuredArmGccRoot!, file.path);
        const destination = path.join(missingRoot, relative);
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(file.path, destination);
      }
      try {
        const missing = await createArmGnuFirmwareTargetBuildBackend({
          toolchainRoot: missingRoot, environment: process.env, temporaryRoot: buildRoot,
        });
        expect(decodeJson<{ code: string }>(
          (await executeFirmware({ targetBuildBackend: missing })).firmware,
          "firmware/reports/stm32g0-target-build.json"
        ).code).toBe("FIRMWARE_TARGET_BUILD_PREREQUISITES_BLOCKED");
      } finally {
        await rm(missingRoot, { recursive: true, force: true });
      }
    } finally {
      await rm(copyRoot, { recursive: true, force: true });
    }
  },
  120_000,
);
