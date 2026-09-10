import { describe, expect, it } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { STAGE_ORDER, type StageKey } from "../../src/domain/stages.js";
import type { ApprovalRecord } from "../../src/domain/types.js";
import { createReferenceControllerProfile, ROBOTICS_CONTROLLER_V0 } from "../../src/knowledge/reference-controller-v0.js";
import { REQUIRED_SIMULATION_COVERAGE } from "../../src/generators/simulation-checks-generator.js";
import { PCB_TRACE_WIDTH_ELECTRICAL_BASIS_MISSING } from "../../src/generators/pcb-layout-plan.js";
import type { FirmwareCompileContextExtension } from "../../src/integrations/firmware-compiler.js";
import {
  createDefaultStageRegistry,
  type CandidateStageContext,
  type ComponentLifecycleObservation,
  type KicadArtifactRole,
  type KicadBackendRequest,
  type KicadBackendResult,
  type KicadGenerationBackend,
  type KicadReportKind,
  type PinPadMappingObservation,
  type SimulationBackend,
  type SimulationBackendResult,
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
const decode = (value: Uint8Array): string => new TextDecoder().decode(value);

const reportsByStage: Readonly<Record<KicadBackendRequest["stage"], readonly KicadReportKind[]>> = {
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

const artifactsByStage: Readonly<
  Record<KicadBackendRequest["stage"], readonly { readonly role: KicadArtifactRole; readonly name: string }[]>
> = {
  schematic: [
    { role: "project", name: "hardware/controller.kicad_pro" },
    { role: "schematic", name: "hardware/controller.kicad_sch" }
  ],
  pcb_placement_routing: [
    { role: "pcb", name: "hardware/controller.kicad_pcb" },
    { role: "render", name: "renders/controller-top.svg" }
  ],
  manufacturing_package: [
    { role: "bom", name: "manufacturing/bom.csv" },
    { role: "gerber", name: "manufacturing/gerbers.zip" },
    { role: "drill", name: "manufacturing/controller.drl" },
    { role: "position", name: "manufacturing/controller.pos" },
    { role: "cam_manifest", name: "manufacturing/cam-manifest.json" }
  ]
};

class PassingKicadBackend implements KicadGenerationBackend {
  public readonly backendId = "isolated-kicad-test-double";

  public async execute(request: KicadBackendRequest): Promise<KicadBackendResult> {
    const artifacts = artifactsByStage[request.stage].map(({ role, name }) => ({
      role,
      logicalName: name,
      mediaType: name.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream",
      content:
        role === "pcb"
          ? CLEAN_MINIMAL_KICAD_PCB
          : encode(`${request.stage}:${role}:${request.expectedSourceRevisionDigest}\n`)
    }));
    return {
      schemaVersion: "evleda.kicad-result.v2",
      stage: request.stage,
      sourceRevisionDigest: request.expectedSourceRevisionDigest,
      tool: TEST_KICAD_TOOL,
      artifacts,
      reports: testKicadReports({
        request,
        artifacts,
        reportKinds: reportsByStage[request.stage],
        contentFor: (kind) =>
          request.stage === "schematic" && kind === "connectivity"
            ? nativeFirmwareParityReport(request.profile, request.expectedSourceRevisionDigest)
            : encode(`{"kind":"${kind}","status":"pass"}\n`)
      })
    };
  }
}

class PassingSimulationBackend implements SimulationBackend {
  public readonly backendId = "isolated-simulation-test-double";

  public async execute(request: SimulationRequest): Promise<SimulationBackendResult> {
    return {
      schemaVersion: "evleda.simulation-result.v1",
      sourceRevisionDigest: request.expectedSourceRevisionDigest,
      tool: {
        name: "modeled-check-test-double",
        version: "1.0.0-test",
        adapter: "external",
        capabilityProfile: "isolated-test-double"
      },
      reports: REQUIRED_SIMULATION_COVERAGE.map((coverageItem) => ({
        coverageItem,
        logicalName: `simulation/reports/${coverageItem}.json`,
        mediaType: "application/json",
        content: encode(`{"coverage":"${coverageItem}","status":"pass"}\n`),
        sourceRevisionDigest: request.expectedSourceRevisionDigest,
        modelIdentity: contentIdentity(`model:${coverageItem}:v1`),
        validationStatus: "pass"
      }))
    };
  }
}

const validPrompt = [
  "Build a two-channel brushed motor controller for a 7-16.8 V DC battery.",
  "Each motor is limited to 0.5 A RMS. Provide USB-C, CAN, UART, I2C, SPI,",
  "two quadrature encoders, and SWD programming."
].join(" ");

const sourcing = (): readonly SourcingObservation[] =>
  ROBOTICS_CONTROLLER_V0.components.map((component) => ({
    component: component.key,
    manufacturerPartNumber: component.partNumber,
    supplier: "fixture-supplier",
    url: `https://example.invalid/catalog/${component.key}`,
    retrievedAt: "2026-09-03T12:00:00.000Z",
    availability: "in_stock",
    identity: contentIdentity(`fixture-sourcing:${component.key}:in_stock`)
  }));

const lifecycleObservations = (): readonly ComponentLifecycleObservation[] =>
  ROBOTICS_CONTROLLER_V0.components.map((component) => ({
    component: component.key,
    status: "active",
    checkedAt: "2026-09-03T12:00:00.000Z",
    sourceUrl: component.lifecycle.sourceUrl,
    sourceIdentity: contentIdentity(`fixture-lifecycle:${component.key}:active`),
    requiresReview: false
  }));

const pinPadMappingReviews = (): readonly PinPadMappingObservation[] =>
  ROBOTICS_CONTROLLER_V0.components.map((component) => ({
    component: component.key,
    symbol: component.symbol,
    footprint: component.footprint,
    status: "reviewed",
    checkedAt: "2026-09-03T12:00:00.000Z",
    mappingIdentity: contentIdentity(`fixture-pin-pad-map:${component.key}`),
    reviewIdentity: contentIdentity(`fixture-pin-pad-review:${component.key}`),
    requiresReview: false
  }));

const approvalFor = (requirementsDigest: string): ApprovalRecord => ({
  id: "approval_fixture_requirements",
  kind: "requirements",
  projectId: "project_fixture",
  runId: "run_fixture",
  subjectDigest: requirementsDigest,
  policyVersion: "evleda-policy-v0",
  actor: {
    type: "human",
    id: "reviewer_fixture",
    displayName: "Fixture reviewer",
    role: "requirements_reviewer"
  },
  scope: "Approve the exact v0 fixture requirements for candidate generation.",
  rationale: "Deterministic unit-test fixture.",
  createdAt: "2026-09-03T12:00:00.000Z"
});

const runAllStages = async (): Promise<readonly StageExecutionResult[]> => {
  const registry = createDefaultStageRegistry();
  const requirementsResult = await registry.execute("requirements", {
    projectId: "project_fixture",
    runId: "run_fixture",
    designRevisionId: "revision_fixture",
    prompt: validPrompt
  });
  const requirements = requirementsResult.requirementsDocument;
  if (requirements === undefined) {
    throw new Error("requirements executor did not return its typed document");
  }
  const upstream: StageExecutionResult[] = [requirementsResult];
  const firmwareCompileBackend = passingFirmwareCompileBackend();
  const firmwareTargetBuildBackend = passingFirmwareTargetBuildBackend();
  const common: Omit<CandidateStageContext, "upstream"> & FirmwareCompileContextExtension = {
    projectId: "project_fixture",
    runId: "run_fixture",
    designRevisionId: "revision_fixture",
    requirements,
    upstreamSourceRevisionBindings: [],
    requirementsApproval: approvalFor(requirements.identity.digest),
    sourcing: sourcing(),
    lifecycleObservations: lifecycleObservations(),
    pinPadMappingReviews: pinPadMappingReviews(),
    footprintLibrary: {
      libraryId: "fixture-footprints-v1",
      identity: contentIdentity("fixture-footprint-library-v1"),
      footprints: ROBOTICS_CONTROLLER_V0.components.map((component) => component.footprint)
    },
    kicadBackend: new PassingKicadBackend(),
    simulationBackend: new PassingSimulationBackend(),
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
    const committedRevisionId = `revision_fixture_after_${stage}`;
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
  }
  return upstream;
};

describe("deterministic reference workflow", () => {
  it("registers and executes all nine stages in the normative order", async () => {
    const registry = createDefaultStageRegistry();
    expect(registry.orderedStages()).toEqual(STAGE_ORDER);
    expect(registry.orderedStages()).toHaveLength(9);

    const results = await runAllStages();
    expect(results.map((result) => result.stage)).toEqual(STAGE_ORDER);
    const byStage = new Map(results.map((result) => [result.stage, result]));
    for (const stage of STAGE_ORDER.slice(0, STAGE_ORDER.indexOf("pcb_placement_routing"))) {
      expect(byStage.get(stage)?.executionStatus, stage).toBe("succeeded");
    }
    expect(byStage.get("pcb_placement_routing")?.executionStatus).toBe("blocked");
    expect(
      byStage.get("pcb_placement_routing")?.blockers.map((blocker) => blocker.code),
    ).toContain(PCB_TRACE_WIDTH_ELECTRICAL_BASIS_MISSING);
    for (const stage of ["manufacturing_package", "bringup_package"] as const) {
      expect(byStage.get(stage)?.blockers.map((blocker) => blocker.code), stage).toContain(
        "UPSTREAM_STAGE_BLOCKED",
      );
    }
    const blockedBringup = byStage.get("bringup_package")!;
    expect(blockedBringup.blockers.map((blocker) => blocker.code)).toContain(
      "BRINGUP_ACCEPTANCE_MATRIX_INCOMPLETE"
    );
    expect(blockedBringup.artifacts.map((artifact) => artifact.logicalName)).not.toContain(
      "bringup/bringup-plan.json"
    );
    expect(blockedBringup.artifacts.map((artifact) => artifact.logicalName)).not.toContain(
      "bringup/physical-acceptance.json"
    );
  });

  it("pins all component identities to the current reference design without pre-approving evidence", () => {
    expect(
      ROBOTICS_CONTROLLER_V0.components.map((component) => ({
        key: component.key,
        manufacturer: component.manufacturer,
        partNumber: component.partNumber,
        package: component.package,
        symbol: component.symbol,
        footprint: component.footprint,
        lifecycleUrl: component.lifecycle.sourceUrl
      }))
    ).toEqual([
      {
        key: "mcu",
        manufacturer: "STMicroelectronics",
        partNumber: "STM32G0B1CET6",
        package: "LQFP-48",
        symbol: "MCU_ST_STM32G0:STM32G0B1CETx",
        footprint: "Package_QFP:LQFP-48_7x7mm_P0.5mm",
        lifecycleUrl: "https://www.st.com/en/microcontrollers-microprocessors/stm32g0b1ce.html"
      },
      {
        key: "motor_driver",
        manufacturer: "Texas Instruments",
        partNumber: "DRV8874PWPR",
        package: "HTSSOP-16 PowerPAD (PWP)",
        symbol: "robotics_drv8874:DRV8874",
        footprint: "robotics_motor:DRV8874_PWP0016J",
        lifecycleUrl: "https://www.ti.com/product/DRV8874/part-details/DRV8874PWPR"
      },
      {
        key: "buck_5v",
        manufacturer: "Texas Instruments",
        partNumber: "LMR51420XFDDCR",
        package: "SOT-23-6 (DDC)",
        symbol: "robotics_lmr51420:LMR51420",
        footprint: "robotics_power:TI_DDC0006A",
        lifecycleUrl: "https://www.ti.com/product/LMR51420/part-details/LMR51420XFDDCR"
      },
      {
        key: "ldo_3v3",
        manufacturer: "Texas Instruments",
        partNumber: "TLV75533PDBVR",
        package: "SOT-23-5 (DBV)",
        symbol: "Regulator_Linear:TLV75533PDBV",
        footprint: "Package_TO_SOT_SMD:SOT-23-5",
        lifecycleUrl: "https://www.ti.com/product/TLV755P/part-details/TLV75533PDBVR"
      },
      {
        key: "can_transceiver",
        manufacturer: "Texas Instruments",
        partNumber: "TCAN3413DR",
        package: "SOIC-8 (D)",
        symbol: "robotics_tcan3413:TCAN3413",
        footprint: "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm",
        lifecycleUrl: "https://www.ti.com/product/TCAN3413/part-details/TCAN3413DR"
      },
      {
        key: "usb_esd",
        manufacturer: "STMicroelectronics",
        partNumber: "USBLC6-2SC6",
        package: "SOT-23-6L",
        symbol: "robotics_usblc6:USBLC6-2SC6",
        footprint: "Package_TO_SOT_SMD:SOT-23-6",
        lifecycleUrl: "https://www.st.com/en/protections-and-emi-filters/usblc6-2.html"
      },
      {
        key: "encoder_buffer",
        manufacturer: "Texas Instruments",
        partNumber: "SN74LVC2G17DBVR",
        package: "SOT-23-6 (DBV)",
        symbol: "robotics_sn74lvc2g17:SN74LVC2G17",
        footprint: "Package_TO_SOT_SMD:SOT-23-6",
        lifecycleUrl: "https://www.ti.com/quality-reliability-packaging-download/en-us/report?opn=SN74LVC2G17DBVR"
      },
      {
        key: "sensor_power_switch",
        manufacturer: "Texas Instruments",
        partNumber: "TPS2553DBVR-1",
        package: "SOT-23-6 (DBV)",
        symbol: "robotics_tps2553:TPS2553-1",
        footprint: "Package_TO_SOT_SMD:SOT-23-6",
        lifecycleUrl: "https://www.ti.com/product/TPS2553-1/part-details/TPS2553DBVR-1"
      }
    ]);

    expect(
      ROBOTICS_CONTROLLER_V0.components.every(
        (component) =>
          component.lifecycle.status === "unknown" &&
          component.lifecycle.sourceIdentity === undefined &&
          component.lifecycle.requiresReview &&
          component.pinPadMappingReview.status === "unreviewed" &&
          component.pinPadMappingReview.mappingIdentity === undefined &&
          component.pinPadMappingReview.reviewIdentity === undefined &&
          component.pinPadMappingReview.requiresReview
      )
    ).toBe(true);
  });

  it("pins the exact standard STM32G0B1CET6 LQFP48 interface allocation", () => {
    expect(
      ROBOTICS_CONTROLLER_V0.pins.map((pin) => [
        pin.signal,
        pin.mcuPin,
        pin.physicalPin,
        pin.peripheral
      ])
    ).toEqual([
      ["NRST", "PF2", 10, "NRST"],
      ["ENC_A_A", "PA0", 11, "TIM2_CH1"],
      ["ENC_A_B", "PA1", 12, "TIM2_CH2"],
      ["UART_TX", "PA2", 13, "USART2_TX"],
      ["UART_RX", "PA3", 14, "USART2_RX"],
      ["MOTOR_A_ISENSE", "PA4", 15, "ADC1_IN4"],
      ["MOTOR_B_ISENSE", "PA5", 16, "ADC1_IN5"],
      ["MOTOR_A_DIR", "PA6", 17, "GPIO"],
      ["MOTOR_B_DIR", "PA7", 18, "GPIO"],
      ["MOTOR_A_NFAULT", "PB0", 19, "GPIO_EXTI0"],
      ["MOTOR_B_NFAULT", "PB1", 20, "GPIO_EXTI1"],
      ["SENSOR_PWR_EN", "PB2", 21, "GPIO"],
      ["SENSOR_PWR_NFAULT", "PB10", 22, "GPIO_EXTI"],
      ["RUN", "PB11", 23, "GPIO"],
      ["MOTOR_A_NSLEEP", "PB12", 24, "GPIO"],
      ["MOTOR_B_NSLEEP", "PB13", 25, "GPIO"],
      ["BOARD_REV0", "PB14", 26, "GPIO"],
      ["BOARD_REV1", "PB15", 27, "GPIO"],
      ["MOTOR_A_PWM", "PA8", 28, "TIM1_CH1"],
      ["MOTOR_B_PWM", "PA9", 29, "TIM1_CH2"],
      ["ENC_B_A", "PC6", 30, "TIM3_CH1"],
      ["ENC_B_B", "PC7", 31, "TIM3_CH2"],
      ["CAN_STB", "PA10", 32, "GPIO"],
      ["USB_DM", "PA11", 33, "USB_DM"],
      ["USB_DP", "PA12", 34, "USB_DP"],
      ["SWDIO", "PA13", 35, "SWDIO"],
      ["SWCLK", "PA14", 36, "SWCLK"],
      ["SPI_CS", "PA15", 37, "GPIO"],
      ["VBUS_PRESENT", "PD2", 40, "GPIO_EXTI2"],
      ["FAULT_STATUS", "PD3", 41, "GPIO"],
      ["SPI_SCK", "PB3", 42, "SPI1_SCK"],
      ["SPI_MISO", "PB4", 43, "SPI1_MISO"],
      ["SPI_MOSI", "PB5", 44, "SPI1_MOSI"],
      ["I2C_SCL", "PB6", 45, "I2C1_SCL"],
      ["I2C_SDA", "PB7", 46, "I2C1_SDA"],
      ["CAN_RX", "PB8", 47, "FDCAN1_RX"],
      ["CAN_TX", "PB9", 48, "FDCAN1_TX"]
    ]);
    expect(
      ROBOTICS_CONTROLLER_V0.pins.some((pin) =>
        ["PF0", "PF1", "PD0", "PD1"].includes(pin.mcuPin),
      )
    ).toBe(false);

    const resources = Object.fromEntries(
      ROBOTICS_CONTROLLER_V0.resources.map((resource) => [resource.owner, resource.resource])
    );
    expect(resources).toMatchObject({
      motor_pwm: "TIM1 CH1/CH2 at 20 kHz center-aligned",
      motor_current: "ADC1 regular scan PA4/PA5",
      encoder_a: "TIM2 encoder mode PA0/PA1 CH1/CH2",
      encoder_b: "TIM3 encoder mode PC6/PC7 CH1/CH2",
      can: "FDCAN1 PB8/PB9 RX/TX",
      usb: "USB FS PA11/PA12 plus PD2 VBUS-present",
      uart: "USART2 PA2/PA3",
      spi: "SPI1 PA15 CS, PB3/PB4/PB5 SCK/MISO/MOSI",
      i2c: "I2C1 PB6/PB7 SCL/SDA",
      board_revision: "GPIO straps PB14/PB15",
      clock_and_reset: "internal HSI clock and PF2 NRST",
      status: "GPIO PB11 RUN and PD3 FAULT_STATUS"
    });

    const protocols = Object.fromEntries(
      ROBOTICS_CONTROLLER_V0.protocols.map((protocol) => [protocol.name, protocol.pins])
    );
    expect(protocols).toEqual({
      USB: ["USB_DM", "USB_DP", "VBUS_PRESENT"],
      CAN: ["CAN_RX", "CAN_TX", "CAN_STB"],
      UART: ["UART_TX", "UART_RX"],
      I2C: ["I2C_SCL", "I2C_SDA"],
      SPI: ["SPI_CS", "SPI_SCK", "SPI_MISO", "SPI_MOSI"],
      SWD: ["SWDIO", "SWCLK", "NRST"],
      ENCODER: ["ENC_A_A", "ENC_A_B", "ENC_B_A", "ENC_B_B"]
    });
  });

  it("creates deterministic parameterized profiles and blocks unsupported combinations", async () => {
    const narrower = createReferenceControllerProfile({
      inputVoltageMv: { minimum: 9000, maximum: 12000 },
      motor: {
        channels: 2,
        rmsCurrentMaPerChannel: 250,
        currentChopMaPerChannel: 1000
      }
    });
    expect(narrower.parameterValidation).toEqual({
      supportStatus: "supported",
      unsupportedReasons: []
    });
    expect(narrower.inputVoltageMv).toEqual({ minimum: 9000, maximum: 12000 });
    expect(
      canonicalIdentity(narrower, "test.reference-profile.v1").digest
    ).not.toBe(
      canonicalIdentity(ROBOTICS_CONTROLLER_V0, "test.reference-profile.v1").digest
    );
    expect(createReferenceControllerProfile({
      inputVoltageMv: { minimum: 9000, maximum: 12000 },
      motor: {
        channels: 2,
        rmsCurrentMaPerChannel: 250,
        currentChopMaPerChannel: 1000
      }
    })).toEqual(narrower);
    const componentStructure = (profile: typeof narrower) =>
      profile.components.map((component) => ({
        key: component.key,
        manufacturer: component.manufacturer,
        partNumber: component.partNumber,
        quantity: component.quantity,
        package: component.package,
        symbol: component.symbol,
        footprint: component.footprint
      }));
    expect(componentStructure(narrower)).toEqual(
      componentStructure(ROBOTICS_CONTROLLER_V0)
    );
    expect(narrower).toMatchObject({
      schemaVersion: ROBOTICS_CONTROLLER_V0.schemaVersion,
      profileId: ROBOTICS_CONTROLLER_V0.profileId,
      boardRevision: ROBOTICS_CONTROLLER_V0.boardRevision,
      lifecycle: ROBOTICS_CONTROLLER_V0.lifecycle,
      stackup: ROBOTICS_CONTROLLER_V0.stackup,
      interfaceSelections: ROBOTICS_CONTROLLER_V0.interfaceSelections,
      pins: ROBOTICS_CONTROLLER_V0.pins,
      resources: ROBOTICS_CONTROLLER_V0.resources,
      protocols: ROBOTICS_CONTROLLER_V0.protocols,
      layoutConstraints: ROBOTICS_CONTROLLER_V0.layoutConstraints
    });
    expect(
      createReferenceControllerProfile({
        interfaceSelections: ["ENCODER", "SWD", "SPI", "I2C", "UART", "CAN", "USB"]
      }).parameterValidation.supportStatus
    ).toBe("supported");
    expect(
      createReferenceControllerProfile({
        interfaceSelections: ["USB", "CAN", "UART", "I2C", "SWD", "ENCODER"]
      }).parameterValidation
    ).toMatchObject({
      supportStatus: "unsupported",
      unsupportedReasons: ["INTERFACE_SET_CHANGE_REQUIRES_NEW_PIN_AND_CIRCUIT_PROFILE"]
    });

    const executeArchitecture = async (
      profile: typeof narrower,
      prompt: string
    ): Promise<StageExecutionResult> => {
      const registry = createDefaultStageRegistry();
      const requirementsResult = await registry.execute("requirements", {
        projectId: "project_fixture",
        runId: "run_fixture",
        designRevisionId: "revision_fixture",
        prompt
      });
      const requirements = requirementsResult.requirementsDocument;
      if (requirements === undefined) {
        throw new Error("requirements stage did not return a document");
      }
      return registry.execute("system_architecture", {
        projectId: "project_fixture",
        runId: "run_fixture",
        designRevisionId: "revision_fixture",
        profile,
        requirements,
        requirementsApproval: approvalFor(requirements.identity.digest),
        upstream: [requirementsResult],
        upstreamSourceRevisionBindings: []
      });
    };

    const defaultArchitecture = await executeArchitecture(
      ROBOTICS_CONTROLLER_V0,
      validPrompt
    );
    const narrowerArchitecture = await executeArchitecture(
      narrower,
      "Build a two-channel brushed motor controller for a 9-12 V DC battery. Each motor is limited to 0.25 A RMS. Provide USB-C, CAN, UART, I2C, SPI, two quadrature encoders, and SWD programming."
    );
    expect(defaultArchitecture.executionStatus).toBe("succeeded");
    expect(narrowerArchitecture.executionStatus).toBe("succeeded");
    expect(narrowerArchitecture.outputIdentity.digest).not.toBe(
      defaultArchitecture.outputIdentity.digest
    );

    const unsupported = createReferenceControllerProfile({
      motor: {
        channels: 3,
        rmsCurrentMaPerChannel: 500,
        currentChopMaPerChannel: 1000
      }
    });
    expect(unsupported.parameterValidation.supportStatus).toBe("unsupported");
    const blockedArchitecture = await executeArchitecture(
      unsupported,
      "Build three motors for a 7-16.8 V supply at 0.5 A RMS per channel with USB, CAN, UART, I2C, SPI, encoders, and SWD."
    );
    expect(blockedArchitecture.executionStatus).toBe("blocked");
    expect(blockedArchitecture.blockers.map((blocker) => blocker.code)).toContain(
      "REFERENCE_PROFILE_INVALID"
    );

    const outOfVoltageEnvelope = createReferenceControllerProfile({
      inputVoltageMv: { minimum: 6000, maximum: 12000 }
    });
    expect(outOfVoltageEnvelope.parameterValidation.unsupportedReasons).toContain(
      "INPUT_VOLTAGE_OUTSIDE_7000_16800_MV"
    );
    const voltageBlocked = await executeArchitecture(
      outOfVoltageEnvelope,
      "Build two motors for a 6-12 V supply at 0.5 A RMS per channel with USB, CAN, UART, I2C, SPI, encoders, and SWD."
    );
    expect(voltageBlocked.executionStatus).toBe("blocked");
    expect(voltageBlocked.blockers.map((blocker) => blocker.code)).toContain(
      "REFERENCE_PROFILE_INVALID"
    );
  });

  it("emits the requested architecture, evidence, firmware, CAM, and bring-up drafts", async () => {
    expect(
      Object.fromEntries(
        ROBOTICS_CONTROLLER_V0.components.map((component) => [
          component.key,
          {
            retrievedAt: component.datasheet.retrievedAt,
            digest: component.datasheet.identity?.digest,
            size: component.datasheet.identity?.size
          }
        ])
      )
    ).toEqual({
      mcu: { retrievedAt: "2026-09-03", digest: "8433e47bc5da5cac459a1d3d5a6add183655061f5655d3c653248de65ca535c9", size: 3971768 },
      motor_driver: { retrievedAt: "2026-09-03", digest: "e28fdb554c58e0c949a21f825a7c985bafc807e9f190575eb02d531afb715c64", size: 2536495 },
      buck_5v: { retrievedAt: "2026-09-03", digest: "8cc7e8bc4ef9adbaaebf47d6059a847796b004ad3cd82ce99102a0fa590693ea", size: 2117875 },
      ldo_3v3: { retrievedAt: "2026-09-03", digest: "c0fe7be9fea4e4c8d933142f59758f7a951e195a45ca4e7e17684153da018cbb", size: 3072276 },
      can_transceiver: { retrievedAt: "2026-09-03", digest: "2c0e8963e7762bc91edf30a365cc10c31ce88e2ddda3b67a120c4158ae52930b", size: 2080472 },
      usb_esd: { retrievedAt: "2026-09-03", digest: "bc30154f310cd631043214ed52571daefe04270587ec55072d49a23bd18b9068", size: 575521 },
      encoder_buffer: { retrievedAt: "2026-09-03", digest: "624dbe55679d2fed4123b0d7708cd0d295efcc78de395e71a0caf5cd13cbc216", size: 1888823 },
      sensor_power_switch: { retrievedAt: "2026-09-03", digest: "8ab20570d3e126d7a13719135f2b6a8858244de7f6c771d7a4329b23e06afca8", size: 2091685 }
    });
    expect(
      ROBOTICS_CONTROLLER_V0.components.map((component) => ({
        key: component.key,
        circuitCount: component.referenceCircuits.length,
        sourceBound: component.referenceCircuits.every(
          (circuit) =>
            circuit.sourceIdentity.digest === component.datasheet.identity?.digest &&
            circuit.sourceIdentity.size === component.datasheet.identity?.size &&
            circuit.sourceUrl === component.datasheet.url
        ),
        located: component.referenceCircuits.every(
          (circuit) =>
            circuit.sectionLocator.length > 0 &&
            circuit.pageLocator.printedPages.length > 0 &&
            circuit.pageLocator.printedPages.length ===
              circuit.pageLocator.pdfPageIndexes.length &&
            circuit.applicabilityLimits.length > 0
        ),
        reviewRequired: component.referenceCircuits.every(
          (circuit) => circuit.status === "starting_point_only" && circuit.reviewRequired
        )
      }))
    ).toEqual(
      ROBOTICS_CONTROLLER_V0.components.map((component) => ({
        key: component.key,
        circuitCount: 1,
        sourceBound: true,
        located: true,
        reviewRequired: true
      }))
    );
    expect(
      Object.fromEntries(
        ROBOTICS_CONTROLLER_V0.components.map((component) => [
          component.key,
          component.referenceCircuits[0]?.pageLocator
        ])
      )
    ).toEqual({
      mcu: {
        printedPages: [17, 38],
        pdfPageIndexes: [16, 37],
        convention: "printed_page_1_based_and_pdf_index_0_based"
      },
      motor_driver: {
        printedPages: [20, 21, 31],
        pdfPageIndexes: [19, 20, 30],
        convention: "printed_page_1_based_and_pdf_index_0_based"
      },
      buck_5v: {
        printedPages: [16, 23],
        pdfPageIndexes: [15, 22],
        convention: "printed_page_1_based_and_pdf_index_0_based"
      },
      ldo_3v3: {
        printedPages: [15, 21, 22],
        pdfPageIndexes: [14, 20, 21],
        convention: "printed_page_1_based_and_pdf_index_0_based"
      },
      can_transceiver: {
        printedPages: [24, 29],
        pdfPageIndexes: [23, 28],
        convention: "printed_page_1_based_and_pdf_index_0_based"
      },
      usb_esd: {
        printedPages: [4, 5, 9],
        pdfPageIndexes: [3, 4, 8],
        convention: "printed_page_1_based_and_pdf_index_0_based"
      },
      encoder_buffer: {
        printedPages: [9, 10, 11],
        pdfPageIndexes: [8, 9, 10],
        convention: "printed_page_1_based_and_pdf_index_0_based"
      },
      sensor_power_switch: {
        printedPages: [17, 18, 25],
        pdfPageIndexes: [16, 17, 24],
        convention: "printed_page_1_based_and_pdf_index_0_based"
      }
    });
    expect(
      Object.fromEntries(
        ROBOTICS_CONTROLLER_V0.components.map((component) => [
          component.key,
          {
            status: component.lifecycle.status,
            hasIdentity: component.lifecycle.sourceIdentity !== undefined,
            digest: component.lifecycle.sourceIdentity?.digest,
            requiresReview: component.lifecycle.requiresReview
          }
        ])
      )
    ).toEqual(
      Object.fromEntries(
        ROBOTICS_CONTROLLER_V0.components.map((component) => [
          component.key,
          { status: "unknown", hasIdentity: false, digest: undefined, requiresReview: true }
        ])
      )
    );

    const results = await runAllStages();
    const byStage = new Map(results.map((result) => [result.stage, result]));

    const componentSelection = byStage.get("component_selection");
    const componentJson = componentSelection?.artifacts.find(
      (artifact) => artifact.logicalName === "components/selection.json"
    );
    expect(componentJson).toBeDefined();
    const selection = JSON.parse(decode(componentJson!.content)) as {
      components: readonly { datasheet: { url: string; retrievedAt: string; identity: { digest: string } } }[];
    };
    expect(selection.components).toHaveLength(8);
    expect(selection.components.every((entry) => entry.datasheet.url.startsWith("https://"))).toBe(true);
    expect(selection.components.every((entry) => entry.datasheet.retrievedAt === "2026-09-03")).toBe(true);
    expect(selection.components.every((entry) => /^[0-9a-f]{64}$/u.test(entry.datasheet.identity.digest))).toBe(true);
    expect(componentSelection?.artifacts.some((artifact) => artifact.logicalName === "components/core-bom.csv")).toBe(true);
    expect(componentSelection?.artifacts.some((artifact) => artifact.logicalName === "components/footprint-map.json")).toBe(true);
    const sourcingEvidence = JSON.parse(
      decode(
        componentSelection!.artifacts.find(
          (artifact) => artifact.logicalName === "components/sourcing-evidence.json"
        )!.content
      )
    ) as {
      lifecycleObservations: readonly { lifecycle: { status: string; sourceIdentity: { digest: string } } }[];
      referenceCircuitSources: readonly { circuits: readonly { status: string; reviewRequired: boolean }[] }[];
    };
    expect(sourcingEvidence.lifecycleObservations).toHaveLength(8);
    expect(
      sourcingEvidence.lifecycleObservations.every(
        (entry) => entry.lifecycle.status === "active" && /^[0-9a-f]{64}$/u.test(entry.lifecycle.sourceIdentity.digest)
      )
    ).toBe(true);
    expect(
      sourcingEvidence.referenceCircuitSources.every((entry) =>
        entry.circuits.every(
          (circuit) => circuit.status === "starting_point_only" && circuit.reviewRequired
        )
      )
    ).toBe(true);
    const footprintMap = JSON.parse(
      decode(
        componentSelection!.artifacts.find(
          (artifact) => artifact.logicalName === "components/footprint-map.json"
        )!.content
      )
    ) as {
      mappings: readonly {
        layoutConstraintIds: readonly string[];
        pinPadMappingReview: {
          status: string;
          mappingIdentity: { digest: string };
          reviewIdentity: { digest: string };
        };
      }[];
    };
    expect(footprintMap.mappings).toHaveLength(8);
    expect(
      footprintMap.mappings.every(
        (mapping) =>
          mapping.layoutConstraintIds.length > 0 &&
          mapping.pinPadMappingReview.status === "reviewed" &&
          /^[0-9a-f]{64}$/u.test(mapping.pinPadMappingReview.mappingIdentity.digest) &&
          /^[0-9a-f]{64}$/u.test(mapping.pinPadMappingReview.reviewIdentity.digest)
      )
    ).toBe(true);

    const architecture = decode(
      byStage.get("system_architecture")!.artifacts.find(
        (artifact) => artifact.logicalName === "architecture/system-architecture.json"
      )!.content
    );
    expect(architecture).toContain("STM32G0B1CET6");
    expect(architecture).toContain("DRV8874PWP");
    expect(architecture).toContain("LMR51420");
    expect(architecture).toContain("TPS2553-1");

    const firmware = byStage.get("firmware_contract")!;
    const contract = decode(
      firmware.artifacts.find((artifact) => artifact.logicalName === "firmware/board-contract.json")!.content
    );
    expect(contract).toContain("EVL-RC-G0-REV-A");
    expect(contract).toContain("DMA1_CH1");
    expect(contract).toContain("CAN_STB");
    expect(contract).toContain("motorCurrentChopMaPerChannel");
    const firmwareSource = decode(
      firmware.artifacts.find((artifact) => artifact.logicalName === "firmware/src/board_contract.c")!.content
    );
    expect(firmwareSource).toContain("evl_board_force_safe");
    expect(firmwareSource).toContain("evl_board_latch_fault");

    expect(byStage.get("schematic")!.evidence.some((entry) => entry.evidenceClass === "kicad_native" && entry.validationStatus === "pass")).toBe(true);
    expect(byStage.get("simulation_checks")!.artifacts.some((artifact) => artifact.logicalName.includes("motor_current_chop"))).toBe(true);
    const simulationPlan = decode(
      byStage.get("simulation_checks")!.artifacts.find(
        (artifact) => artifact.logicalName === "simulation/coverage-plan.json"
      )!.content
    );
    expect(simulationPlan).toContain("Static comparator/trip-threshold calculation");
    expect(simulationPlan).toContain("Current ripple, PWM transient response");
    expect(simulationPlan).toContain("motor R/L/back-EMF");
    expect(byStage.get("pcb_placement_routing")!.artifacts.some((artifact) => artifact.logicalName.endsWith(".kicad_pcb"))).toBe(true);
    expect(byStage.get("pcb_placement_routing")!.artifacts.some((artifact) => artifact.logicalName.endsWith("pcb_practices.json"))).toBe(true);
    expect(byStage.get("pcb_placement_routing")!.blockers.map((blocker) => blocker.code)).toEqual([
      "PCB_ENGINEERING_COVERAGE_INCOMPLETE",
      PCB_TRACE_WIDTH_ELECTRICAL_BASIS_MISSING
    ]);
    expect(byStage.get("manufacturing_package")!.blockers.map((blocker) => blocker.code)).toContain("UPSTREAM_STAGE_BLOCKED");
    expect(byStage.get("bringup_package")!.blockers.map((blocker) => blocker.code)).toContain("UPSTREAM_STAGE_BLOCKED");
  });

  it("regenerates byte-identical controlled drafts from identical frozen inputs", async () => {
    const first = await runAllStages();
    const second = await runAllStages();

    expect(second.map((result) => result.outputIdentity)).toEqual(
      first.map((result) => result.outputIdentity)
    );
    expect(
      second.map((result) => result.artifacts.map((artifact) => artifact.identity))
    ).toEqual(first.map((result) => result.artifacts.map((artifact) => artifact.identity)));
    expect(second.map((result) => result.blockers)).toEqual(first.map((result) => result.blockers));
  });
});
