import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  STAGE_CONTEXT_ENRICHMENT_SCHEMA,
  STAGE_PROVISION_SCHEMA,
  type StageContextProvider
} from "../../src/application/ports.js";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import type { StageKey } from "../../src/domain/stages.js";
import { PCB_TRACE_WIDTH_ELECTRICAL_BASIS_MISSING } from "../../src/generators/pcb-layout-plan.js";
import { ROBOTICS_CONTROLLER_V0 } from "../../src/knowledge/reference-controller-v0.js";
import { createDefaultStageRegistry } from "../../src/workflow/stage-registry.js";
import type {
  KicadArtifactRole,
  KicadBackendStage,
  KicadBackendRequest,
  KicadReportKind,
  FirmwareTargetBuildBackendConfiguration,
  SimulationRequest,
  SimulationCoverageItem,
  CandidateStageContext,
  StageContextByKey,
  StageExecutionResult,
  StageRegistryContract
} from "../../src/workflow/contracts.js";
import {
  createApprovedRun,
  createCompletedRun,
  disposeApplicationRoots,
  makeApplication
} from "./helpers.js";
import {
  nativeFirmwareParityReport,
  passingFirmwareCompileBackend,
  passingFirmwareTargetBuildBackend
} from "../helpers/firmware-compile.js";
import {
  CLEAN_MINIMAL_KICAD_PCB,
  TEST_KICAD_TOOL,
  testKicadReports,
} from "../helpers/kicad-reports.js";

afterEach(disposeApplicationRoots);

const kicadRoles: Readonly<Record<KicadBackendStage, readonly KicadArtifactRole[]>> = {
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

const roleName = (stage: KicadBackendStage, role: KicadArtifactRole): string => {
  const names: Record<KicadArtifactRole, string> = {
    project: "kicad/controller.kicad_pro",
    schematic: "kicad/controller.kicad_sch",
    pcb: "kicad/controller.kicad_pcb",
    render: "renders/controller.svg",
    bom: "manufacturing/bom.csv",
    gerber: "manufacturing/controller-F_Cu.gbr",
    drill: "manufacturing/controller.drl",
    position: "manufacturing/position.csv",
    cam_manifest: "manufacturing/cam-manifest.json"
  };
  return `${stage}/${names[role]}`;
};

const enrichedContextFor = (
  mutateTargetConfiguration?: (
    configuration: FirmwareTargetBuildBackendConfiguration,
  ) => FirmwareTargetBuildBackendConfiguration,
): StageContextProvider => ({
  provide: async (request) => {
    const firmwareCompileBackend = passingFirmwareCompileBackend();
    const baseFirmwareTargetBuildBackend = passingFirmwareTargetBuildBackend();
    const targetConfiguration = mutateTargetConfiguration === undefined
      ? baseFirmwareTargetBuildBackend.configuration
      : mutateTargetConfiguration(structuredClone(baseFirmwareTargetBuildBackend.configuration));
    const firmwareTargetBuildBackend = mutateTargetConfiguration === undefined
      ? baseFirmwareTargetBuildBackend
      : { ...baseFirmwareTargetBuildBackend, configuration: targetConfiguration };
    const enrichment = {
    firmwareCompileBackend,
    firmwareCompileConfiguration: firmwareCompileBackend.configuration,
    firmwareTargetBuildBackend,
    firmwareTargetBuildConfiguration: firmwareTargetBuildBackend.configuration,
    profile: ROBOTICS_CONTROLLER_V0,
    curatedDatasheets: ROBOTICS_CONTROLLER_V0.components.map((component) => {
      if (component.datasheet.identity === undefined || component.datasheet.retrievedAt === null) {
        throw new Error(`Fixture requires captured datasheet identity for ${component.key}`);
      }
      return {
        component: component.key,
        url: component.datasheet.url,
        retrievedAt: component.datasheet.retrievedAt,
        identity: component.datasheet.identity
      };
    }),
    sourcing: ROBOTICS_CONTROLLER_V0.components.map((component) => ({
      component: component.key,
      manufacturerPartNumber: component.partNumber,
      supplier: "fixture-authorized-distributor",
      url: `https://supplier.invalid/${component.partNumber}`,
      retrievedAt: "2026-09-03T00:00:00.000Z",
      availability: "in_stock" as const,
      identity: contentIdentity(`supplier:${component.partNumber}`)
    })),
    lifecycleObservations: ROBOTICS_CONTROLLER_V0.components.map((component) => ({
      component: component.key,
      status: "active" as const,
      checkedAt: "2026-09-03T00:00:00.000Z",
      sourceUrl: component.lifecycle.sourceUrl,
      sourceIdentity: contentIdentity(`lifecycle:${component.partNumber}`),
      requiresReview: false
    })),
    pinPadMappingReviews: ROBOTICS_CONTROLLER_V0.components.map((component) => ({
      component: component.key,
      symbol: component.symbol,
      footprint: component.footprint,
      status: "reviewed" as const,
      checkedAt: "2026-09-03T00:00:00.000Z",
      mappingIdentity: contentIdentity(`mapping:${component.partNumber}`),
      reviewIdentity: contentIdentity(`mapping-review:${component.partNumber}`),
      requiresReview: false
    })),
    footprintLibrary: {
      libraryId: "fixture-footprints-v1",
      identity: contentIdentity("fixture-footprints-v1"),
      footprints: ROBOTICS_CONTROLLER_V0.components.map((component) => component.footprint)
    },
    kicadBackend: {
      backendId: "fixture-kicad-10",
      execute: async (request: KicadBackendRequest) => {
        const artifacts = kicadRoles[request.stage].map((role) => ({
          role,
          logicalName: roleName(request.stage, role),
          mediaType: role === "render" ? "image/svg+xml" : "application/octet-stream",
          content:
            role === "pcb"
              ? CLEAN_MINIMAL_KICAD_PCB
              : Buffer.from(`${request.stage}:${role}:${request.expectedSourceRevisionDigest}\n`)
        }));
        return {
          schemaVersion: "evleda.kicad-result.v2" as const,
          stage: request.stage,
          sourceRevisionDigest: request.expectedSourceRevisionDigest,
          tool: TEST_KICAD_TOOL,
          artifacts,
          reports: testKicadReports({
            request,
            artifacts,
            reportKinds: reportKinds[request.stage],
            contentFor: (kind) =>
              request.stage === "schematic" && kind === "connectivity"
                ? nativeFirmwareParityReport(request.profile, request.expectedSourceRevisionDigest)
                : Buffer.from(`${kind}: pass\n`)
          })
        };
      }
    },
    simulationBackend: {
      backendId: "fixture-simulation",
      execute: async (request: SimulationRequest) => {
        const coverage: readonly SimulationCoverageItem[] = [
          "power_tree_operating_points",
          "logic_rail_load_budget",
          "motor_current_chop",
          "motor_driver_thermal",
          "fault_and_reset"
        ];
        return {
          schemaVersion: "evleda.simulation-result.v1" as const,
          sourceRevisionDigest: request.expectedSourceRevisionDigest,
          tool: { name: "fixture-simulator", version: "1", adapter: "external" as const },
          reports: coverage.map((coverageItem) => ({
            coverageItem,
            logicalName: `simulation/${coverageItem}.json`,
            mediaType: "application/json",
            content: Buffer.from(`{"coverage":"${coverageItem}","status":"pass"}\n`),
            sourceRevisionDigest: request.expectedSourceRevisionDigest,
            modelIdentity: contentIdentity(`model:${coverageItem}`),
            validationStatus: "pass" as const
          }))
        };
      }
    }
    };
    const enrichmentIdentity = canonicalIdentity(
      {
        profile: enrichment.profile,
        curatedDatasheets: enrichment.curatedDatasheets,
        sourcing: enrichment.sourcing,
        lifecycleObservations: enrichment.lifecycleObservations,
        pinPadMappingReviews: enrichment.pinPadMappingReviews,
        footprintLibrary: enrichment.footprintLibrary,
        firmwareCompileConfiguration: enrichment.firmwareCompileConfiguration,
        firmwareTargetBuildConfiguration: enrichment.firmwareTargetBuildConfiguration
      },
      STAGE_CONTEXT_ENRICHMENT_SCHEMA
    );
    const provisionManifest = {
      schemaVersion: STAGE_PROVISION_SCHEMA,
      request: {
        projectId: request.project.id,
        projectPolicyVersion: request.project.policyVersion,
        runId: request.run.id,
        workflowVersion: request.run.workflowVersion,
        configuration: request.run.configuration,
        revisionId: request.revision.id,
        revisionManifest: request.revision.manifest,
        stage: request.stage
      },
      enrichmentIdentity,
      backends: {
        kicad: { backendId: enrichment.kicadBackend.backendId },
        simulation: { backendId: enrichment.simulationBackend.backendId },
        firmwareCompile: {
          backendId: firmwareCompileBackend.backendId,
          configurationIdentity: canonicalIdentity(
            firmwareCompileBackend.configuration,
            "evleda.firmware-compile-backend-config.v1"
          )
        },
        firmwareTargetBuild: {
          backendId: firmwareTargetBuildBackend.backendId,
          configurationIdentity: canonicalIdentity(
            firmwareTargetBuildBackend.configuration,
            "evleda.firmware-target-build-backend-config.v1"
          )
        }
      },
      providerEvidence: { fixture: "fully-enriched-default-registry" }
    } as const;
    return {
      ...enrichment,
      provisionManifest,
      provisionIdentity: canonicalIdentity(provisionManifest, STAGE_PROVISION_SCHEMA)
    };
  }
});

const enrichedContext = enrichedContextFor();

describe("default stage registry through the application seam", () => {
  it("fails closed with explicit blockers when enrichment/backends are absent", async () => {
    const service = await makeApplication(createDefaultStageRegistry());
    const approved = await createApprovedRun(service);
    const status = await service.resumeRun({
      runId: approved.run.id,
      expectedRevision: approved.run.revision,
      idempotencyKey: "default-missing-context"
    });
    expect(status.run.state).toBe("blocked");
    expect(status.currentStage).toBe("component_selection");
    expect(status.blockers.map((blocker) => blocker.code)).toContain(
      "SOURCING_EVIDENCE_MISSING"
    );
  });

  it("keeps missing electrical sizing separate while refusing incomplete whole-board practice coverage", async () => {
    const service = await makeApplication(createDefaultStageRegistry(), enrichedContext);
    const status = await createCompletedRun(service);
    expect(status.run.state).toBe("blocked");
    expect(status.currentStage, JSON.stringify(status.blockers, null, 2)).toBe(
      "pcb_placement_routing",
    );
    const blockerCodes = status.blockers.map((blocker) => blocker.code);
    expect(blockerCodes.slice(0, 2)).toEqual([
      "PCB_ENGINEERING_COVERAGE_INCOMPLETE",
      PCB_TRACE_WIDTH_ELECTRICAL_BASIS_MISSING,
    ]);
    expect(blockerCodes.filter((code) => code === "GATE_FAILED")).toHaveLength(6);
    expect(new Set(blockerCodes)).toEqual(new Set([
      "PCB_ENGINEERING_COVERAGE_INCOMPLETE",
      PCB_TRACE_WIDTH_ELECTRICAL_BASIS_MISSING,
      "GATE_FAILED",
    ]));

    const schematicArtifacts = await service.listArtifacts({
      runId: status.run.id,
      stage: "schematic",
      includeStale: false,
    });
    const firmwareArtifacts = await service.listArtifacts({
      runId: status.run.id,
      stage: "firmware_contract",
      includeStale: false,
    });
    const readJson = async (
      artifacts: typeof schematicArtifacts.artifacts,
      logicalName: string,
    ): Promise<Record<string, any>> => {
      const artifact = artifacts.find((entry) => entry.logicalName === logicalName);
      if (artifact === undefined) throw new Error(`Missing ${logicalName}`);
      return JSON.parse(
        Buffer.from((await service.readArtifact(artifact.id)).bytes).toString("utf8"),
      ) as Record<string, any>;
    };
    const intent = await readJson(
      schematicArtifacts.artifacts,
      "schematic/schematic-intent.json",
    );
    const pinMap = await readJson(
      schematicArtifacts.artifacts,
      "schematic/generated-pin-map.json",
    );
    const parity = await readJson(
      firmwareArtifacts.artifacts,
      "firmware/reports/schematic-pin-map-parity.json",
    );
    expect(intent.designRevisionId).toBe(pinMap.designRevisionId);
    expect(parity.status).toBe("pass");
    expect(parity.sourceRevision.schematicInputDesignRevisionId).toBe(
      intent.designRevisionId,
    );
    expect(parity.sourceRevision.designRevisionId).not.toBe(intent.designRevisionId);
  });

  it("rejects mutually agreeing forged schematic-intent and pin-map revision claims", async () => {
    const base = createDefaultStageRegistry();
    const forgedRevisionId = "revision_forged_mutually_agreeing";
    let schematicResult: StageExecutionResult | undefined;
    let firmwareResult: StageExecutionResult | undefined;
    const registry: StageRegistryContract = {
      orderedStages: () => base.orderedStages(),
      has: (stage) => base.has(stage),
      get: (stage) => base.get(stage),
      execute: async <K extends StageKey>(
        stage: K,
        context: StageContextByKey[K]
      ): Promise<StageExecutionResult<K>> => {
        const effectiveContext = stage === "schematic"
          ? {
              ...(context as CandidateStageContext),
              designRevisionId: forgedRevisionId
            } as StageContextByKey[K]
          : context;
        const result = await base.execute(stage, effectiveContext);
        if (stage === "schematic") schematicResult = result;
        if (stage === "firmware_contract") firmwareResult = result;
        return result;
      }
    };
    const service = await makeApplication(registry, enrichedContext);
    const status = await createCompletedRun(service);

    expect(status.run.state).toBe("blocked");
    expect(status.currentStage).toBe("firmware_contract");
    const decodeResultArtifact = (
      result: StageExecutionResult | undefined,
      logicalName: string
    ): Record<string, any> => {
      const artifact = result?.artifacts.find((entry) => entry.logicalName === logicalName);
      if (artifact === undefined) throw new Error(`Missing captured ${logicalName}`);
      return JSON.parse(Buffer.from(artifact.content).toString("utf8")) as Record<string, any>;
    };
    const intent = decodeResultArtifact(
      schematicResult,
      "schematic/schematic-intent.json"
    );
    const pinMap = decodeResultArtifact(
      schematicResult,
      "schematic/generated-pin-map.json"
    );
    const parity = decodeResultArtifact(
      firmwareResult,
      "firmware/reports/schematic-pin-map-parity.json"
    );
    expect(intent.designRevisionId).toBe(forgedRevisionId);
    expect(pinMap.designRevisionId).toBe(forgedRevisionId);
    expect(parity.status).toBe("fail");
    expect(parity.sourceRevision.schematicInputDesignRevisionId).not.toBe(forgedRevisionId);
    expect(parity.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "REVISION_BINDING_MISMATCH",
          path: "schematicPinMap.designRevisionId"
        }),
        expect.objectContaining({
          code: "SCHEMATIC_INTENT_INVALID",
          path: "schematic/schematic-intent.json"
        })
      ])
    );
  });

  it.each([
    ["ambient PATH", (configuration: FirmwareTargetBuildBackendConfiguration) => {
      const environment = { ...configuration.environment, PATH: "C:/ambient-tools" };
      return {
        ...configuration,
        environment,
        environmentIdentity: canonicalIdentity(environment, "evleda.firmware-target-build-environment.v1"),
      };
    }],
    ["colon-delimited Windows PATH", (configuration: FirmwareTargetBuildBackendConfiguration) => {
      const environment = {
        ...configuration.environment,
        PATH: "<toolchain>/bin:<toolchain>/arm-none-eabi/bin",
      };
      return {
        ...configuration,
        environment,
        environmentIdentity: canonicalIdentity(environment, "evleda.firmware-target-build-environment.v1"),
      };
    }],
    ["off-root compiler helper", (configuration: FirmwareTargetBuildBackendConfiguration) => ({
      ...configuration,
      toolchainFiles: configuration.toolchainFiles.map((file) => file.role === "cc1"
        ? { ...file, path: path.resolve("outside-toolchain", "cc1.exe") }
        : file),
    })],
    ["duplicate toolchain role", (configuration: FirmwareTargetBuildBackendConfiguration) => ({
      ...configuration,
      toolchainFiles: configuration.toolchainFiles.map((file, index) => index === 1
        ? { ...file, role: "gcc" as const, relativePath: "bin/arm-none-eabi-gcc.exe",
            path: path.join(configuration.requestedToolchainRoot!, "bin", "arm-none-eabi-gcc.exe") }
        : file),
    })],
    ["wrong CMSIS identity", (configuration: FirmwareTargetBuildBackendConfiguration) => ({
      ...configuration,
      supportFiles: configuration.supportFiles.map((file, index) => index === 1
        ? { ...file, identity: { ...file.identity, digest: "f".repeat(64) } }
        : file),
    })],
    ["wrong embedded identity", (configuration: FirmwareTargetBuildBackendConfiguration) => ({
      ...configuration,
      embeddedFiles: configuration.embeddedFiles.map((file, index) => index === 0
        ? { ...file, identity: { ...file.identity, digest: "f".repeat(64) } }
        : file),
    })],
  ] as const)("rejects %s before dispatching an unrelated candidate stage", async (_case, mutate) => {
    const service = await makeApplication(
      createDefaultStageRegistry(),
      enrichedContextFor(mutate),
    );
    const approved = await createApprovedRun(service);
    const status = await service.resumeRun({
      runId: approved.run.id,
      expectedRevision: approved.run.revision,
      idempotencyKey: `default-invalid-target-${_case.replaceAll(" ", "-")}`,
    });
    expect(status.currentStage).toBe("system_architecture");
    expect(status.blockers).toEqual([
      expect.objectContaining({
        code: "TOOL_RESULT_INCONCLUSIVE",
        message: "Stage context provider returned an invalid firmware target build configuration",
      }),
    ]);
  });
});
