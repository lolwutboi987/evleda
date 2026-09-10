import path from "node:path";

import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import type { ContentIdentity, ToolIdentity, ValidationStatus } from "../domain/types.js";
import type { PinAssignment, ReferenceControllerProfile } from "../knowledge/reference-controller-v0.js";
import {
  FIRMWARE_COMPILE_BACKEND_CONFIGURATION_SCHEMA,
  FIRMWARE_COMPILE_ENVIRONMENT_SCHEMA,
  FIRMWARE_TARGET_BUILD_CONFIGURATION_SCHEMA,
  FIRMWARE_TARGET_BUILD_ENVIRONMENT_SCHEMA,
  type FirmwareCompileBackend,
  type FirmwareCompileBackendConfiguration,
  type FirmwareCompileResult,
  type FirmwareCompileSource,
  type FirmwareTargetBuildBackend,
  type FirmwareTargetBuildBackendConfiguration,
  type FirmwareTargetBuildResult,
  type FirmwareTargetBuildSource,
  type StageExecutor
} from "../workflow/contracts.js";
import {
  FIRMWARE_COMPILE_RESOURCE_LIMITS,
  firmwareCompileArguments
} from "../integrations/firmware-compiler.js";
import {
  firmwareTargetCompileArguments,
  firmwareTargetObjcopyArguments,
  ARM_GNU_ARCHIVE_NAME,
  ARM_GNU_ARCHIVE_SHA256,
  ARM_GNU_GCC_VERSION,
  ARM_GNU_OFFICIAL_URL,
  ARM_GNU_TOOLCHAIN_RELEASE,
  FIRMWARE_TARGET_EMBEDDED_FILES,
  FIRMWARE_TARGET_RESOURCE_LIMITS,
  STM32G0_SUPPORT_FILE_CLOSURE,
  STM32G0_SUPPORT_MANIFEST_SHA256,
  STM32G0_SUPPORT_MANIFEST_SIZE,
} from "../integrations/firmware-target-builder.js";
import {
  stm32g0LinkerScript,
  stm32g0PlatformSource,
  stm32g0StartupSource,
} from "./stm32g0-target.js";
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
  isSha256Identity,
  sortedIdentities,
  stageExactInputs
} from "./draft-utils.js";
import {
  SCHEMATIC_PIN_MAP_LOGICAL_NAME,
  validateFirmwareSchematicParity
} from "./firmware-parity.js";

const cIdentifier = (value: string): string => value.replaceAll(/[^A-Za-z0-9_]/gu, "_").toUpperCase();

const safeLevel = (pin: PinAssignment): 0 | 1 =>
  pin.signal === "SPI_CS" || pin.signal === "CAN_STB" ? 1 : 0;

const safetyControlledPins = (profile: ReferenceControllerProfile): readonly PinAssignment[] =>
  profile.pins.filter((pin) =>
    [
      "MOTOR_A_NSLEEP",
      "MOTOR_B_NSLEEP",
      "MOTOR_A_PWM",
      "MOTOR_B_PWM",
      "MOTOR_A_DIR",
      "MOTOR_B_DIR",
      "SENSOR_PWR_EN",
      "CAN_STB",
      "SPI_CS"
    ].includes(pin.signal)
  );

const firmwareContractValue = (
  profile: ReferenceControllerProfile,
  context: {
    readonly projectId: string;
    readonly runId: string;
    readonly designRevisionId: string;
    readonly requirementsIdentity: { readonly digest: string };
    readonly generatedSchematicPinMapIdentity: {
      readonly algorithm: "sha256";
      readonly digest: string;
      readonly size: number;
    } | null;
  }
) => ({
  schemaVersion: "evleda.firmware-contract.v1",
  profileId: profile.profileId,
  boardRevision: profile.boardRevision,
  requirementsDigest: context.requirementsIdentity.digest,
  revisionBinding: {
    projectId: context.projectId,
    runId: context.runId,
    designRevisionId: context.designRevisionId,
    requirementsDigest: context.requirementsIdentity.digest,
    generatedSchematicPinMapIdentity: context.generatedSchematicPinMapIdentity
  },
  lifecycle: "candidate",
  mcu: { partNumber: "STM32G0B1CET6", package: "LQFP-48", logicRail: "3V3" },
  voltageAndCurrentAssumptions: {
    inputVoltageMv: profile.inputVoltageMv,
    motorRmsCurrentMaPerChannel: profile.motor.rmsCurrentMaPerChannel,
    motorCurrentChopMaPerChannel: profile.motor.currentChopMaPerChannel,
    rails: profile.rails
  },
  pins: profile.pins,
  resetSafeOutputs: safetyControlledPins(profile).map((pin) => ({
    signal: pin.signal,
    level: safeLevel(pin),
    externalBias: pin.externalBias,
    hardwareStateBeforeFirmware: pin.resetState,
    purpose: pin.safetyPurpose
  })),
  timersIrqsAndDma: profile.resources,
  protocols: profile.protocols,
  boardRevisionVerification: {
    expectedSemanticRevision: profile.boardRevision,
    method: "platform-supplied exact semantic revision matcher",
    limitation:
      "The scaffold does not invent a raw strap encoding; target integration must bind a reviewed hardware strap map to this exact semantic revision."
  },
  startupContract: [
    "Force all software-controlled outputs to their hardware-biased safe levels before alternate-function setup.",
    `Validate the ${profile.boardRevision} board identity and the generated contract version.`,
    "Reject startup if bridge/sensor faults are asserted or current-sense ADC calibration fails.",
    "Configure timers, ADC/DMA, fault IRQs, encoders, and communications while bridges remain asleep.",
    "Require an explicit per-channel enable request after all startup checks; never infer enable from communications presence."
  ],
  runtimeFaultContract: [
    "Bridge nFAULT, watchdog, brownout, board-ID mismatch, or current-sense contract failure latches both motor channels off.",
    "Sensor-power nFAULT disables only 5V_SENSOR and records a diagnostic unless another fault policy explicitly escalates.",
    "All fault clear operations require inactive commands, de-energized outputs, revalidation, and an explicit request.",
    "The generated scaffold is not a safety-rated control implementation."
  ],
  validationStubs: [
    "safe-state write-order test",
    "safe-state write failure rejection test",
    "wrong board-revision rejection test",
    "startup fault rejection test",
    "motor enable before initialization rejection test",
    "motor disable and global fault-latch test",
    "generated pin/resource uniqueness check"
  ]
});

const header = (profile: ReferenceControllerProfile): string => {
  const pins = profile.pins
    .map((pin) => `#define EVL_PIN_${cIdentifier(pin.signal)} "${pin.mcuPin}"`)
    .join("\n");
  return [
    "#ifndef EVLEDA_BOARD_CONTRACT_H",
    "#define EVLEDA_BOARD_CONTRACT_H",
    "",
    "#include <stdbool.h>",
    "#include <stddef.h>",
    "#include <stdint.h>",
    "",
    `#define EVL_BOARD_REVISION "${profile.boardRevision}"`,
    `#define EVL_MOTOR_CHANNELS UINT32_C(${profile.motor.channels})`,
    `#define EVL_MOTOR_RMS_LIMIT_MA UINT32_C(${profile.motor.rmsCurrentMaPerChannel})`,
    `#define EVL_MOTOR_CHOP_TARGET_MA UINT32_C(${profile.motor.currentChopMaPerChannel})`,
    `#define EVL_INPUT_MIN_MV UINT32_C(${profile.inputVoltageMv.minimum})`,
    `#define EVL_INPUT_MAX_MV UINT32_C(${profile.inputVoltageMv.maximum})`,
    "",
    pins,
    "",
    "typedef enum {",
    "  EVL_OUTPUT_MOTOR_A_NSLEEP = 0,",
    "  EVL_OUTPUT_MOTOR_B_NSLEEP,",
    "  EVL_OUTPUT_MOTOR_A_PWM,",
    "  EVL_OUTPUT_MOTOR_B_PWM,",
    "  EVL_OUTPUT_MOTOR_A_DIR,",
    "  EVL_OUTPUT_MOTOR_B_DIR,",
    "  EVL_OUTPUT_SENSOR_PWR_EN,",
    "  EVL_OUTPUT_CAN_STB,",
    "  EVL_OUTPUT_SPI_CS,",
    "  EVL_OUTPUT_COUNT",
    "} EvlOutput;",
    "",
    "typedef enum {",
    "  EVL_INIT_OK = 0,",
    "  EVL_INIT_BAD_ARGUMENT,",
    "  EVL_INIT_SAFE_OUTPUT_FAILURE,",
    "  EVL_INIT_WRONG_BOARD_REVISION,",
    "  EVL_INIT_FAULT_ASSERTED,",
    "  EVL_INIT_PERIPHERAL_FAILURE",
    "} EvlInitStatus;",
    "",
    "typedef struct {",
    "  void *context;",
    "  bool (*write_output)(void *context, EvlOutput output, bool level);",
    "  bool (*board_revision_matches)(void *context, const char *expected_revision);",
    "  uint32_t (*read_fault_mask)(void *context);",
    "  bool (*configure_peripherals_disabled)(void *context);",
    "} EvlBoardIo;",
    "",
    "bool evl_board_force_safe(const EvlBoardIo *io);",
    "EvlInitStatus evl_board_init_safe(const EvlBoardIo *io);",
    "bool evl_board_motor_request(const EvlBoardIo *io, uint32_t channel, bool enable);",
    "void evl_board_latch_fault(const EvlBoardIo *io, uint32_t fault_mask);",
    "bool evl_board_is_initialized(void);",
    "uint32_t evl_board_fault_latch(void);",
    "",
    "#endif",
    ""
  ].join("\n");
};

const source = (): string =>
  [
    '#include "board_contract.h"',
    "",
    "static bool g_initialized = false;",
    "static uint32_t g_fault_latch = UINT32_MAX;",
    "",
    "static const bool k_safe_level[EVL_OUTPUT_COUNT] = {",
    "  false, false, false, false, false, false, false, true, true",
    "};",
    "",
    "static bool io_valid(const EvlBoardIo *io) {",
    "  return io != NULL && io->write_output != NULL &&",
    "         io->board_revision_matches != NULL && io->read_fault_mask != NULL &&",
    "         io->configure_peripherals_disabled != NULL;",
    "}",
    "",
    "bool evl_board_force_safe(const EvlBoardIo *io) {",
    "  g_initialized = false;",
    "  if (io == NULL || io->write_output == NULL) { return false; }",
    "  bool success = true;",
    "  for (uint32_t i = 0; i < (uint32_t)EVL_OUTPUT_COUNT; ++i) {",
    "    if (!io->write_output(io->context, (EvlOutput)i, k_safe_level[i])) { success = false; }",
    "  }",
    "  return success;",
    "}",
    "",
    "EvlInitStatus evl_board_init_safe(const EvlBoardIo *io) {",
    "  g_fault_latch = UINT32_MAX;",
    "  if (io == NULL || io->write_output == NULL) { return EVL_INIT_BAD_ARGUMENT; }",
    "  if (!evl_board_force_safe(io)) { return EVL_INIT_SAFE_OUTPUT_FAILURE; }",
    "  if (!io_valid(io)) { return EVL_INIT_BAD_ARGUMENT; }",
    "  if (!io->board_revision_matches(io->context, EVL_BOARD_REVISION)) {",
    "    return EVL_INIT_WRONG_BOARD_REVISION;",
    "  }",
    "  g_fault_latch = io->read_fault_mask(io->context);",
    "  if (g_fault_latch != 0U) { return EVL_INIT_FAULT_ASSERTED; }",
    "  if (!io->configure_peripherals_disabled(io->context)) {",
    "    g_fault_latch = UINT32_MAX;",
    "    if (!evl_board_force_safe(io)) { return EVL_INIT_SAFE_OUTPUT_FAILURE; }",
    "    return EVL_INIT_PERIPHERAL_FAILURE;",
    "  }",
    "  g_initialized = true;",
    "  return EVL_INIT_OK;",
    "}",
    "",
    "bool evl_board_motor_request(const EvlBoardIo *io, uint32_t channel, bool enable) {",
    "  if (!io_valid(io) || !g_initialized || g_fault_latch != 0U || channel >= EVL_MOTOR_CHANNELS) {",
    "    return false;",
    "  }",
    "  const EvlOutput output = channel == 0U ? EVL_OUTPUT_MOTOR_A_NSLEEP : EVL_OUTPUT_MOTOR_B_NSLEEP;",
    "  return io->write_output(io->context, output, enable);",
    "}",
    "",
    "void evl_board_latch_fault(const EvlBoardIo *io, uint32_t fault_mask) {",
    "  g_fault_latch |= fault_mask == 0U ? UINT32_MAX : fault_mask;",
    "  (void)evl_board_force_safe(io);",
    "}",
    "",
    "bool evl_board_is_initialized(void) { return g_initialized; }",
    "uint32_t evl_board_fault_latch(void) { return g_fault_latch; }",
    ""
  ].join("\n");

const validationSource = (): string =>
  [
    '#include "board_contract.h"',
    "#include <assert.h>",
    "#include <string.h>",
    "",
    "typedef struct {",
    "  bool level[EVL_OUTPUT_COUNT];",
    "  uint32_t writes;",
    "  bool revision_matches;",
    "  uint32_t faults;",
    "  bool peripheral_result;",
    "  int32_t fail_output;",
    "} FakeIo;",
    "",
    "static bool write_output(void *context, EvlOutput output, bool level) {",
    "  FakeIo *fake = (FakeIo *)context;",
    "  fake->level[output] = level; fake->writes += 1U;",
    "  return fake->fail_output < 0 || (int32_t)output != fake->fail_output;",
    "}",
    "static bool board_revision_matches(void *context, const char *expected_revision) {",
    "  FakeIo *fake = (FakeIo *)context;",
    "  return fake->revision_matches && strcmp(expected_revision, EVL_BOARD_REVISION) == 0;",
    "}",
    "static uint32_t read_faults(void *context) { return ((FakeIo *)context)->faults; }",
    "static bool configure(void *context) { return ((FakeIo *)context)->peripheral_result; }",
    "static EvlBoardIo make_io(FakeIo *fake) {",
    "  EvlBoardIo io = { fake, write_output, board_revision_matches, read_faults, configure }; return io;",
    "}",
    "",
    "int main(void) {",
    "  FakeIo fake; memset(&fake, 0, sizeof(fake));",
    "  fake.revision_matches = true; fake.peripheral_result = true; fake.fail_output = -1;",
    "  EvlBoardIo io = make_io(&fake);",
    "  assert(!evl_board_motor_request(&io, 0U, true));",
    "  assert(evl_board_init_safe(&io) == EVL_INIT_OK);",
    "  assert(fake.writes >= (uint32_t)EVL_OUTPUT_COUNT);",
    "  assert(!fake.level[EVL_OUTPUT_MOTOR_A_NSLEEP]);",
    "  assert(fake.level[EVL_OUTPUT_CAN_STB]);",
    "  assert(fake.level[EVL_OUTPUT_SPI_CS]);",
    "  assert(evl_board_motor_request(&io, 0U, true));",
    "  evl_board_latch_fault(&io, 1U);",
    "  assert(!evl_board_is_initialized());",
    "  assert(!fake.level[EVL_OUTPUT_MOTOR_A_NSLEEP]);",
    "  fake.revision_matches = false; fake.faults = 0U;",
    "  assert(evl_board_init_safe(&io) == EVL_INIT_WRONG_BOARD_REVISION);",
    "  memset(&fake, 0, sizeof(fake)); fake.revision_matches = true;",
    "  fake.peripheral_result = true; fake.fail_output = (int32_t)EVL_OUTPUT_MOTOR_A_PWM;",
    "  io = make_io(&fake);",
    "  assert(evl_board_init_safe(&io) == EVL_INIT_SAFE_OUTPUT_FAILURE);",
    "  assert(fake.writes == (uint32_t)EVL_OUTPUT_COUNT);",
    "  assert(!evl_board_is_initialized());",
    "  return 0;",
    "}",
    ""
  ].join("\n");

const cmake = (): string =>
  [
    "cmake_minimum_required(VERSION 3.20)",
    "project(evleda_board_contract C)",
    "set(CMAKE_C_STANDARD 11)",
    "add_library(evleda_board_contract src/board_contract.c)",
    "target_include_directories(evleda_board_contract PUBLIC include)",
    "add_executable(board_contract_validation tests/board_contract_validation.c)",
    "target_link_libraries(board_contract_validation PRIVATE evleda_board_contract)",
    "enable_testing()",
    "add_test(NAME board_contract_validation COMMAND board_contract_validation)",
    ""
  ].join("\n");

const provisionedCompileBackend = (
  context: Parameters<typeof stageExactInputs>[0]
): {
  readonly backend: FirmwareCompileBackend;
  readonly configuration: FirmwareCompileBackendConfiguration;
  readonly configurationIdentity: ReturnType<typeof canonicalIdentity>;
} | undefined => {
  const backend = context.firmwareCompileBackend;
  const configuration = context.firmwareCompileConfiguration;
  if (
    backend === undefined ||
    configuration === undefined ||
    !compileConfigurationIsStrict(configuration) ||
    configuration.schemaVersion !== FIRMWARE_COMPILE_BACKEND_CONFIGURATION_SCHEMA ||
    configuration.backendId !== backend.backendId ||
    canonicalJson(configuration) !== canonicalJson(backend.configuration) ||
    canonicalJson(configuration.compileArguments) !== canonicalJson(firmwareCompileArguments()) ||
    canonicalJson(configuration.resourceLimits) !== canonicalJson(FIRMWARE_COMPILE_RESOURCE_LIMITS) ||
    configuration.executionPolicy?.schemaVersion !== "evleda.firmware-execution-policy.v1" ||
    configuration.executionPolicy?.acceptedSourceOrigin !== "evleda-deterministic-generator" ||
    configuration.executionPolicy?.agentDerivedOrUntrustedSourceExecution !== "deny" ||
    configuration.executionPolicy?.osSandbox !== "none" ||
    configuration.executionPolicy?.containmentClaim !== "not-contained" ||
    configuration.executionPolicy?.executableStrategy !== "identity-checked-shared-path" ||
    configuration.executionPolicy?.lto !== "disabled" ||
    configuration.executionPolicy?.linkerPlugin !== "disabled" ||
    !firmwareEnvironmentIsMinimal(configuration.environment, "host") ||
    !(configuration.requestedCompilerPath === null || path.isAbsolute(configuration.requestedCompilerPath)) ||
    canonicalJson(configuration.environmentIdentity) !==
      canonicalJson(canonicalIdentity(configuration.environment, FIRMWARE_COMPILE_ENVIRONMENT_SCHEMA))
  ) {
    return undefined;
  }
  let snapshot: FirmwareCompileBackendConfiguration;
  try {
    snapshot = structuredClone(configuration);
    if (canonicalJson(snapshot) !== canonicalJson(configuration) ||
      canonicalJson(snapshot) !== canonicalJson(backend.configuration)) return undefined;
  } catch {
    return undefined;
  }
  return {
    backend,
    configuration: snapshot,
    configurationIdentity: canonicalIdentity(
      snapshot,
      FIRMWARE_COMPILE_BACKEND_CONFIGURATION_SCHEMA
    )
  };
};

const provisionedTargetBuildBackend = (
  context: Parameters<typeof stageExactInputs>[0]
): {
  readonly backend: FirmwareTargetBuildBackend;
  readonly configuration: FirmwareTargetBuildBackendConfiguration;
  readonly configurationIdentity: ReturnType<typeof canonicalIdentity>;
} | undefined => {
  const backend = context.firmwareTargetBuildBackend;
  const configuration = context.firmwareTargetBuildConfiguration;
  if (
    backend === undefined ||
    configuration === undefined ||
    configuration.schemaVersion !== FIRMWARE_TARGET_BUILD_CONFIGURATION_SCHEMA ||
    configuration.backendId !== backend.backendId ||
    canonicalJson(configuration) !== canonicalJson(backend.configuration) ||
    canonicalJson(configuration.compileArguments) !== canonicalJson(firmwareTargetCompileArguments()) ||
    canonicalJson(configuration.objcopyArguments) !== canonicalJson(firmwareTargetObjcopyArguments()) ||
    canonicalJson(configuration.resourceLimits) !== canonicalJson(FIRMWARE_TARGET_RESOURCE_LIMITS) ||
    canonicalJson(configuration.embeddedFiles) !== canonicalJson(FIRMWARE_TARGET_EMBEDDED_FILES) ||
    configuration.executionPolicy?.schemaVersion !== "evleda.firmware-execution-policy.v1" ||
    configuration.executionPolicy?.acceptedSourceOrigin !== "evleda-deterministic-generator" ||
    configuration.executionPolicy?.agentDerivedOrUntrustedSourceExecution !== "deny" ||
    configuration.executionPolicy?.osSandbox !== "none" ||
    configuration.executionPolicy?.containmentClaim !== "not-contained" ||
    configuration.executionPolicy?.executableStrategy !== "verified-private-toolchain-closure" ||
    configuration.executionPolicy?.lto !== "disabled" ||
    configuration.executionPolicy?.linkerPlugin !== "disabled" ||
    !firmwareEnvironmentIsMinimal(configuration.environment, "target") ||
    !validateFirmwareTargetBuildConfiguration(configuration) ||
    canonicalJson(configuration.environmentIdentity) !==
      canonicalJson(canonicalIdentity(configuration.environment, FIRMWARE_TARGET_BUILD_ENVIRONMENT_SCHEMA))
  ) return undefined;
  let snapshot: FirmwareTargetBuildBackendConfiguration;
  try {
    snapshot = structuredClone(configuration);
    if (canonicalJson(snapshot) !== canonicalJson(configuration) ||
      canonicalJson(snapshot) !== canonicalJson(backend.configuration)) return undefined;
  } catch {
    return undefined;
  }
  return {
    backend,
    configuration: snapshot,
    configurationIdentity: canonicalIdentity(snapshot, FIRMWARE_TARGET_BUILD_CONFIGURATION_SCHEMA)
  };
};

const skippedCompileResult = (
  backendId: string,
  sourceRevisionDigest: string,
  configurationIdentity: ReturnType<typeof canonicalIdentity>
): FirmwareCompileResult => ({
  schemaVersion: "evleda.firmware-compile-result.v1",
  sourceRevisionDigest,
  configurationIdentity,
  status: "unsupported",
  code: "FIRMWARE_COMPILE_PREREQUISITES_BLOCKED",
  message:
    "Host compilation was not run because an upstream, approval, envelope, or profile-integrity prerequisite is blocked.",
  backendId,
  requestedCompilerPath: null,
  compilerFamily: null,
  targetTriple: null,
  steps: []
});

const invalidCompileResult = (
  backendId: string,
  sourceRevisionDigest: string,
  configurationIdentity: ReturnType<typeof canonicalIdentity>
): FirmwareCompileResult => ({
  schemaVersion: "evleda.firmware-compile-result.v1",
  sourceRevisionDigest,
  configurationIdentity,
  status: "fail",
  code: "FIRMWARE_COMPILE_RESULT_INVALID",
  message:
    "Firmware compile backend failed or returned an incompatible, stale, or unidentifiable result.",
  backendId,
  requestedCompilerPath: null,
  compilerFamily: null,
  targetTriple: null,
  steps: []
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));

const boundedString = (value: unknown, maximum: number, allowEmpty = false): value is string =>
  typeof value === "string" &&
  value.length <= maximum &&
  (allowEmpty || value.length > 0) &&
  !value.includes("\0");

const strictSha256Identity = (value: unknown): value is ContentIdentity =>
  isRecord(value) &&
  hasOnlyKeys(value, ["algorithm", "digest", "size"]) &&
  isSha256Identity(value as unknown as ContentIdentity);

const strictCanonicalIdentity = (value: unknown): value is ReturnType<typeof canonicalIdentity> =>
  isRecord(value) &&
  hasOnlyKeys(value, ["algorithm", "digest", "schemaVersion", "canonicalizationVersion"]) &&
  value.algorithm === "sha256" &&
  typeof value.digest === "string" &&
  /^[0-9a-f]{64}$/u.test(value.digest) &&
  boundedString(value.schemaVersion, 128) &&
  value.canonicalizationVersion === "evleda-c14n-json-v1";

const firmwareEnvironmentIsMinimal = (
  value: unknown,
  kind: "host" | "target",
): value is Readonly<Record<string, string>> => {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "LC_ALL", "LANG", "LANGUAGE", "NO_COLOR", "SOURCE_DATE_EPOCH", "PATH", "TEMP", "TMP",
    "TMPDIR", "SystemRoot", "WINDIR",
  ])) return false;
  const systemPathsValid = [value.SystemRoot, value.WINDIR].every((candidate) =>
    candidate === undefined ||
    (boundedString(candidate, 4096) && path.win32.isAbsolute(candidate)),
  );
  return systemPathsValid && value.LC_ALL === "C" && value.LANG === "C" && value.LANGUAGE === "C" &&
    value.NO_COLOR === "1" && value.SOURCE_DATE_EPOCH === "0" &&
    value.TEMP === "<workspace>" && value.TMP === "<workspace>" &&
    value.TMPDIR === "<workspace>" &&
    (kind === "host"
      ? value.PATH === "<compiler-dir>"
      : value.PATH === "<toolchain>/bin;<toolchain>/arm-none-eabi/bin");
};

const compileConfigurationIsStrict = (
  configuration: FirmwareCompileBackendConfiguration,
): boolean => {
  try {
    return isRecord(configuration) && hasOnlyKeys(configuration, [
      "schemaVersion", "backendId", "requestedCompilerPath", "environment", "environmentIdentity",
      "executionPolicy", "resourceLimits", "platform", "architecture", "compileArguments",
      "timeoutMs", "maxOutputBytes", "processRunner",
    ]) && configuration.schemaVersion === FIRMWARE_COMPILE_BACKEND_CONFIGURATION_SCHEMA &&
      boundedString(configuration.backendId, 128) &&
      (configuration.requestedCompilerPath === null ||
        (boundedString(configuration.requestedCompilerPath, 4096) &&
          path.isAbsolute(configuration.requestedCompilerPath))) &&
      firmwareEnvironmentIsMinimal(configuration.environment, "host") &&
      strictCanonicalIdentity(configuration.environmentIdentity) &&
      canonicalJson(configuration.environmentIdentity) === canonicalJson(canonicalIdentity(
        configuration.environment,
        FIRMWARE_COMPILE_ENVIRONMENT_SCHEMA,
      )) && isRecord(configuration.executionPolicy) &&
      canonicalJson(configuration.executionPolicy) === canonicalJson({
        schemaVersion: "evleda.firmware-execution-policy.v1",
        acceptedSourceOrigin: "evleda-deterministic-generator",
        agentDerivedOrUntrustedSourceExecution: "deny",
        osSandbox: "none",
        containmentClaim: "not-contained",
        executableStrategy: "identity-checked-shared-path",
        lto: "disabled",
        linkerPlugin: "disabled",
      }) && canonicalJson(configuration.resourceLimits) === canonicalJson(FIRMWARE_COMPILE_RESOURCE_LIMITS) &&
      configuration.platform === process.platform && configuration.architecture === process.arch &&
      canonicalJson(configuration.compileArguments) === canonicalJson(firmwareCompileArguments()) &&
      Number.isSafeInteger(configuration.timeoutMs) && configuration.timeoutMs > 0 &&
      configuration.timeoutMs <= 120_000 && Number.isSafeInteger(configuration.maxOutputBytes) &&
      configuration.maxOutputBytes > 0 && configuration.maxOutputBytes <= 1024 * 1024 &&
      configuration.processRunner === "evleda.bounded-process.v1";
  } catch {
    return false;
  }
};

export const validateFirmwareTargetBuildConfiguration = (
  configuration: FirmwareTargetBuildBackendConfiguration,
  options: { readonly requireProvisioned?: boolean } = {},
): boolean => {
  try {
    const requireProvisioned = options.requireProvisioned ?? false;
    if (
    !isRecord(configuration) || !hasOnlyKeys(configuration, [
      "schemaVersion", "backendId", "requestedToolchainRoot", "supportRoot", "targetTriple",
      "targetPart", "cpu", "floatAbi", "expectedRelease", "expectedGccVersion", "distribution",
      "environment", "environmentIdentity", "executionPolicy", "resourceLimits", "toolchainFiles",
      "supportFiles", "embeddedFiles", "compileArguments", "objcopyArguments", "timeoutMs",
      "maxOutputBytes", "processRunner",
    ]) || configuration.schemaVersion !== FIRMWARE_TARGET_BUILD_CONFIGURATION_SCHEMA ||
    configuration.backendId !== "arm-gnu-stm32g0b1-freestanding-v1" ||
    !boundedString(configuration.supportRoot, 4096) || !path.isAbsolute(configuration.supportRoot) ||
    configuration.targetTriple !== "arm-none-eabi" ||
    configuration.targetPart !== "STM32G0B1CET6" || configuration.cpu !== "cortex-m0plus" ||
    configuration.floatAbi !== "soft" || configuration.expectedRelease !== ARM_GNU_TOOLCHAIN_RELEASE ||
    configuration.expectedGccVersion !== ARM_GNU_GCC_VERSION ||
    !isRecord(configuration.distribution) ||
    canonicalJson(configuration.distribution) !== canonicalJson({
      archiveName: ARM_GNU_ARCHIVE_NAME,
      officialUrl: ARM_GNU_OFFICIAL_URL,
      sha256: ARM_GNU_ARCHIVE_SHA256,
    }) || !firmwareEnvironmentIsMinimal(configuration.environment, "target") ||
    !strictCanonicalIdentity(configuration.environmentIdentity) ||
    canonicalJson(configuration.environmentIdentity) !== canonicalJson(canonicalIdentity(
      configuration.environment,
      FIRMWARE_TARGET_BUILD_ENVIRONMENT_SCHEMA,
    )) || !isRecord(configuration.executionPolicy) ||
    canonicalJson(configuration.executionPolicy) !== canonicalJson({
      schemaVersion: "evleda.firmware-execution-policy.v1",
      acceptedSourceOrigin: "evleda-deterministic-generator",
      agentDerivedOrUntrustedSourceExecution: "deny",
      osSandbox: "none",
      containmentClaim: "not-contained",
      executableStrategy: "verified-private-toolchain-closure",
      lto: "disabled",
      linkerPlugin: "disabled",
    }) || canonicalJson(configuration.resourceLimits) !== canonicalJson(FIRMWARE_TARGET_RESOURCE_LIMITS) ||
    canonicalJson(configuration.embeddedFiles) !== canonicalJson(FIRMWARE_TARGET_EMBEDDED_FILES) ||
    canonicalJson(configuration.compileArguments) !== canonicalJson(firmwareTargetCompileArguments()) ||
    canonicalJson(configuration.objcopyArguments) !== canonicalJson(firmwareTargetObjcopyArguments()) ||
    !Number.isSafeInteger(configuration.timeoutMs) || configuration.timeoutMs <= 0 ||
    configuration.timeoutMs > 120_000 || !Number.isSafeInteger(configuration.maxOutputBytes) ||
    configuration.maxOutputBytes <= 0 || configuration.maxOutputBytes > 1024 * 1024 ||
    configuration.processRunner !== "evleda.bounded-process.v1" ||
    !Array.isArray(configuration.toolchainFiles) || !Array.isArray(configuration.supportFiles)
    ) return false;
    const expectedToolchain = new Map<string, string>([
    ["gcc", "bin/arm-none-eabi-gcc.exe"],
    ["cc1", "libexec/gcc/arm-none-eabi/14.2.1/cc1.exe"],
    ["assembler", "arm-none-eabi/bin/as.exe"],
    ["collect2", "libexec/gcc/arm-none-eabi/14.2.1/collect2.exe"],
    ["ld", "arm-none-eabi/bin/ld.exe"],
    ["objcopy", "bin/arm-none-eabi-objcopy.exe"],
    ["libgcc", "lib/gcc/arm-none-eabi/14.2.1/thumb/v6-m/nofp/libgcc.a"],
    ]);
    if (configuration.requestedToolchainRoot === null) {
      if (requireProvisioned || configuration.toolchainFiles.length !== 0) return false;
    } else if (!boundedString(configuration.requestedToolchainRoot, 4096) ||
      !path.isAbsolute(configuration.requestedToolchainRoot) ||
      configuration.toolchainFiles.length !== expectedToolchain.size) return false;
    const roles = new Set<string>();
    let toolchainBytes = 0;
    for (const file of configuration.toolchainFiles) {
      if (configuration.requestedToolchainRoot === null ||
        !isRecord(file) || !hasOnlyKeys(file, ["role", "path", "relativePath", "identity"]) ||
        typeof file.role !== "string" || typeof file.path !== "string" ||
        typeof file.relativePath !== "string" ||
        !boundedString(file.path, 4096) || expectedToolchain.get(file.role) !== file.relativePath ||
        !path.isAbsolute(file.path) ||
        path.resolve(file.path) !== path.resolve(
          configuration.requestedToolchainRoot,
          ...file.relativePath.split("/"),
        ) || !strictSha256Identity(file.identity) || file.identity.size <= 0 ||
        file.identity.size > FIRMWARE_TARGET_RESOURCE_LIMITS.maxToolchainFileBytes) return false;
      toolchainBytes += file.identity.size;
      roles.add(file.role);
    }
    if (roles.size !== configuration.toolchainFiles.length ||
      toolchainBytes > FIRMWARE_TARGET_RESOURCE_LIMITS.maxToolchainTotalBytes) return false;

    if (configuration.supportFiles.length === 0) return !requireProvisioned;
    const expectedSupport = new Map<string, ContentIdentity>([
    ["manifest.json", {
      algorithm: "sha256", digest: STM32G0_SUPPORT_MANIFEST_SHA256,
      size: STM32G0_SUPPORT_MANIFEST_SIZE,
    }],
    ...STM32G0_SUPPORT_FILE_CLOSURE.map((file) => [file.relativePath, file.identity] as const),
    ]);
    if (configuration.supportFiles.length !== expectedSupport.size) return false;
    const supportPaths = new Set<string>();
    let supportBytes = 0;
    for (const file of configuration.supportFiles) {
      if (!isRecord(file) || !hasOnlyKeys(file, ["role", "path", "relativePath", "identity"]) ||
        typeof file.role !== "string" || typeof file.path !== "string" ||
        typeof file.relativePath !== "string") return false;
      const expectedIdentity = expectedSupport.get(file.relativePath);
      if (expectedIdentity === undefined ||
        file.role !== (file.relativePath === "manifest.json" ? "support_manifest" : "support_source") ||
        !boundedString(file.path, 4096) || !path.isAbsolute(file.path) || path.resolve(file.path) !== path.resolve(
          configuration.supportRoot, ...file.relativePath.split("/"),
        ) || !strictSha256Identity(file.identity) ||
        canonicalJson(file.identity) !== canonicalJson(expectedIdentity)) return false;
      supportBytes += file.identity.size;
      supportPaths.add(file.relativePath);
    }
    return supportPaths.size === expectedSupport.size &&
      supportBytes <= FIRMWARE_TARGET_RESOURCE_LIMITS.maxSupportTotalBytes;
  } catch {
    return false;
  }
};

const compileResultIsUsable = (
  result: unknown,
  backendId: string,
  sourceRevisionDigest: string,
  configurationIdentity: ReturnType<typeof canonicalIdentity>,
  sources: readonly FirmwareCompileSource[],
  configuration: FirmwareCompileBackendConfiguration,
): result is FirmwareCompileResult => {
  if (
    !isRecord(result) ||
    !hasOnlyKeys(result, [
      "schemaVersion", "sourceRevisionDigest", "configurationIdentity", "status", "code",
      "message", "backendId", "requestedCompilerPath", "compilerFamily", "targetTriple", "tool",
      "executableIdentity", "validationExecutableIdentity", "compiledSources", "steps",
    ]) ||
    !boundedString(result.message, 4096) ||
    !Array.isArray(result.steps) || result.steps.length > 4
  ) return false;
  try {
    if (Buffer.byteLength(canonicalJson(result), "utf8") > 1024 * 1024) return false;
  } catch {
    return false;
  }
  if (
    result.schemaVersion !== "evleda.firmware-compile-result.v1" ||
    result.sourceRevisionDigest !== sourceRevisionDigest ||
    !strictCanonicalIdentity(result.configurationIdentity) ||
    canonicalJson(result.configurationIdentity) !== canonicalJson(configurationIdentity) ||
    result.backendId !== backendId ||
    !boundedString(result.backendId, 128) ||
    !["pass", "fail", "unsupported"].includes(String(result.status)) ||
    !boundedString(result.code, 128) ||
    !/^[A-Z0-9_]+$/u.test(result.code) ||
    !(result.requestedCompilerPath === null || boundedString(result.requestedCompilerPath, 4096)) ||
    !(
      result.compilerFamily === null ||
      result.compilerFamily === "clang" ||
      result.compilerFamily === "gcc"
    ) ||
    !(result.targetTriple === null || boundedString(result.targetTriple, 256)) ||
    !result.steps.every(
      (step) =>
        isRecord(step) &&
        hasOnlyKeys(step, ["operation", "commandRole", "commandIdentity", "arguments", "exitCode", "stdout", "stderr"]) &&
        ["compiler_version", "target_probe", "compile_and_link", "validation_test"].includes(
          String(step.operation)
        ) &&
        ["compiler", "validation_executable"].includes(String(step.commandRole)) &&
        strictSha256Identity(step.commandIdentity) &&
        Array.isArray(step.arguments) &&
        step.arguments.length <= 32 &&
        step.arguments.every((argument) => boundedString(argument, 1024, true)) &&
        (step.exitCode === null || Number.isSafeInteger(step.exitCode)) &&
        boundedString(step.stdout, 256 * 1024, true) &&
        boundedString(step.stderr, 256 * 1024, true)
    )
  ) {
    return false;
  }
  if (
    result.executableIdentity !== undefined &&
    !strictSha256Identity(result.executableIdentity)
  ) {
    return false;
  }
  if (
    result.validationExecutableIdentity !== undefined &&
    !strictSha256Identity(result.validationExecutableIdentity)
  ) return false;
  if (
    result.tool !== undefined &&
    (!isRecord(result.tool) ||
      !hasOnlyKeys(result.tool, [
        "name", "version", "adapter", "executablePath", "executableDigest", "capabilityProfile"
      ]) ||
      !boundedString(result.tool.name, 128) ||
      !boundedString(result.tool.version, 128) ||
      result.tool.adapter !== "external" ||
      (result.tool.executablePath !== undefined &&
        !boundedString(result.tool.executablePath, 4096)) ||
      (result.tool.executableDigest !== undefined &&
        (typeof result.tool.executableDigest !== "string" ||
          !/^[0-9a-f]{64}$/u.test(result.tool.executableDigest))) ||
      (result.tool.capabilityProfile !== undefined &&
        !boundedString(result.tool.capabilityProfile, 512)))
  ) {
    return false;
  }
  if (
    result.compiledSources !== undefined &&
    (!Array.isArray(result.compiledSources) ||
      result.compiledSources.length !== sources.length ||
      !result.compiledSources.every(
        (source) =>
          isRecord(source) &&
          hasOnlyKeys(source, ["logicalName", "identity"]) &&
          typeof source.logicalName === "string" &&
          strictSha256Identity(source.identity)
      ))
  ) return false;
  if (result.status !== "pass") {
    return result.code !== "FIRMWARE_HOST_C11_VALIDATION_PASSED";
  }
  if (
    !compileConfigurationIsStrict(configuration) ||
    canonicalJson(configuration.compileArguments) !== canonicalJson(firmwareCompileArguments()) ||
    canonicalJson(configuration.resourceLimits) !== canonicalJson(FIRMWARE_COMPILE_RESOURCE_LIMITS) ||
    configuration.executionPolicy.schemaVersion !== "evleda.firmware-execution-policy.v1" ||
    configuration.executionPolicy.acceptedSourceOrigin !== "evleda-deterministic-generator" ||
    configuration.executionPolicy.agentDerivedOrUntrustedSourceExecution !== "deny" ||
    configuration.executionPolicy.osSandbox !== "none" ||
    configuration.executionPolicy.containmentClaim !== "not-contained" ||
    configuration.executionPolicy.executableStrategy !== "identity-checked-shared-path" ||
    configuration.executionPolicy.lto !== "disabled" ||
    configuration.executionPolicy.linkerPlugin !== "disabled" ||
    !firmwareEnvironmentIsMinimal(configuration.environment, "host")
  ) return false;
  const expectedSteps = [
    ["compiler_version", "compiler", ["--version"]],
    ["target_probe", "compiler", ["-dumpmachine"]],
    ["compile_and_link", "compiler", firmwareCompileArguments()],
    ["validation_test", "validation_executable", []]
  ] as const;
  return (
    result.code === "FIRMWARE_HOST_C11_VALIDATION_PASSED" &&
    result.compilerFamily !== null &&
    result.targetTriple !== null && result.targetTriple.length > 0 &&
    result.tool?.adapter === "external" &&
    result.tool.executablePath !== undefined &&
    result.executableIdentity !== undefined &&
    (result.executableIdentity as unknown as ContentIdentity).size > 0 &&
    result.tool.executableDigest === result.executableIdentity.digest &&
    result.tool.name === result.compilerFamily &&
    (result.tool as unknown as ToolIdentity).version.trim().length > 0 &&
    result.requestedCompilerPath === configuration.requestedCompilerPath &&
    path.isAbsolute(result.requestedCompilerPath ?? "") &&
    result.tool.executablePath === result.requestedCompilerPath &&
    result.tool.capabilityProfile === `native-c11:${result.targetTriple}` &&
    result.validationExecutableIdentity !== undefined &&
    isSha256Identity(result.validationExecutableIdentity as ContentIdentity) &&
    (result.validationExecutableIdentity as ContentIdentity).size > 0 &&
    canonicalJson(result.compiledSources) === canonicalJson(
      sources.map((source) => ({ logicalName: source.logicalName, identity: source.identity })),
    ) &&
    result.steps.length === expectedSteps.length &&
    result.steps.every((step, index) =>
      step.operation === expectedSteps[index]![0] &&
      step.commandRole === expectedSteps[index]![1] &&
      canonicalJson(step.commandIdentity) === canonicalJson(
        step.commandRole === "compiler"
          ? result.executableIdentity
          : result.validationExecutableIdentity,
      ) &&
      JSON.stringify(step.arguments) === JSON.stringify(expectedSteps[index]![2]) &&
      step.exitCode === 0
    )
  );
};

const skippedTargetBuildResult = (
  backendId: string,
  sourceRevisionDigest: string,
  configurationIdentity: ReturnType<typeof canonicalIdentity>,
): FirmwareTargetBuildResult => ({
  schemaVersion: "evleda.firmware-target-build-result.v1",
  sourceRevisionDigest,
  configurationIdentity,
  status: "unsupported",
  code: "FIRMWARE_TARGET_BUILD_PREREQUISITES_BLOCKED",
  message: "Target compilation was not run because immutable workflow prerequisites are blocked.",
  backendId,
  targetTriple: null,
  gccVersion: null,
  toolchainIdentity: null,
  compiledSources: [],
  steps: [],
  outputs: [],
  deploymentDisposition: "not-built",
  flashable: false,
  releaseAuthorized: false,
});

const invalidTargetBuildResult = (
  backendId: string,
  sourceRevisionDigest: string,
  configurationIdentity: ReturnType<typeof canonicalIdentity>,
): FirmwareTargetBuildResult => ({
  ...skippedTargetBuildResult(backendId, sourceRevisionDigest, configurationIdentity),
  status: "fail",
  code: "FIRMWARE_TARGET_BUILD_RESULT_INVALID",
  message: "Target build backend returned an incompatible, stale, or identity-invalid result.",
});

const targetBuildResultIsUsable = (
  result: unknown,
  backendId: string,
  sourceRevisionDigest: string,
  configurationIdentity: ReturnType<typeof canonicalIdentity>,
  sources: readonly FirmwareTargetBuildSource[],
  configuration: FirmwareTargetBuildBackendConfiguration,
): result is FirmwareTargetBuildResult => {
  if (!isRecord(result) || !hasOnlyKeys(result, [
    "schemaVersion", "sourceRevisionDigest", "configurationIdentity", "status", "code", "message",
    "backendId", "targetTriple", "gccVersion", "toolchainIdentity", "compiledSources", "steps",
    "outputs", "deploymentDisposition", "flashable", "releaseAuthorized"
  ])) return false;
  if (
    result.schemaVersion !== "evleda.firmware-target-build-result.v1" ||
    result.sourceRevisionDigest !== sourceRevisionDigest || result.backendId !== backendId ||
    !strictCanonicalIdentity(result.configurationIdentity) ||
    canonicalJson(result.configurationIdentity) !== canonicalJson(configurationIdentity) ||
    !["pass", "fail", "unsupported"].includes(String(result.status)) ||
    !boundedString(result.code, 128) || !/^[A-Z0-9_]+$/u.test(result.code) ||
    !boundedString(result.message, 4096) || result.flashable !== false ||
    result.releaseAuthorized !== false || !Array.isArray(result.compiledSources) ||
    result.compiledSources.length !== sources.length ||
    canonicalJson(result.compiledSources) !== canonicalJson(sources.map((source) => ({ logicalName: source.logicalName, identity: source.identity }))) ||
    !Array.isArray(result.steps) || result.steps.length > 6 || !Array.isArray(result.outputs)
  ) return false;
  if (!result.steps.every((step) => isRecord(step) && hasOnlyKeys(step, [
    "operation", "commandRole", "commandIdentity", "arguments", "exitCode", "stdout", "stderr"
  ]) && ["gcc_version", "target_probe", "ld_version", "objcopy_version", "compile_and_link", "objcopy_binary"].includes(String(step.operation)) &&
    ["gcc", "ld", "objcopy"].includes(String(step.commandRole)) && strictSha256Identity(step.commandIdentity) && Array.isArray(step.arguments) &&
    step.arguments.length <= 64 && step.arguments.every((argument) => boundedString(argument, 2048, true)) &&
    (step.exitCode === null || Number.isSafeInteger(step.exitCode)) &&
    boundedString(step.stdout, 512 * 1024, true) && boundedString(step.stderr, 512 * 1024, true))) return false;
  if (result.status !== "pass") {
    return result.code !== "FIRMWARE_TARGET_CROSS_BUILD_PASSED" &&
      result.outputs.length === 0 && result.deploymentDisposition === "not-built";
  }
  if (
    canonicalJson(configuration.compileArguments) !== canonicalJson(firmwareTargetCompileArguments()) ||
    canonicalJson(configuration.objcopyArguments) !== canonicalJson(firmwareTargetObjcopyArguments()) ||
    canonicalJson(configuration.resourceLimits) !== canonicalJson(FIRMWARE_TARGET_RESOURCE_LIMITS) ||
    canonicalJson(configuration.embeddedFiles) !== canonicalJson(FIRMWARE_TARGET_EMBEDDED_FILES) ||
    configuration.executionPolicy.schemaVersion !== "evleda.firmware-execution-policy.v1" ||
    configuration.executionPolicy.acceptedSourceOrigin !== "evleda-deterministic-generator" ||
    configuration.executionPolicy.agentDerivedOrUntrustedSourceExecution !== "deny" ||
    configuration.executionPolicy.osSandbox !== "none" ||
    configuration.executionPolicy.containmentClaim !== "not-contained" ||
    configuration.executionPolicy.executableStrategy !== "verified-private-toolchain-closure" ||
    configuration.executionPolicy.lto !== "disabled" ||
    configuration.executionPolicy.linkerPlugin !== "disabled" ||
    !firmwareEnvironmentIsMinimal(configuration.environment, "target") ||
    !validateFirmwareTargetBuildConfiguration(configuration, { requireProvisioned: true }) ||
    !Array.isArray(configuration.supportFiles) || configuration.supportFiles.length !== 12
  ) return false;
  const expectedToolchainIdentity = canonicalIdentity({
    distribution: configuration.distribution,
    files: configuration.toolchainFiles,
    embeddedFiles: configuration.embeddedFiles,
    executionPolicy: configuration.executionPolicy,
  }, "evleda.arm-gnu-toolchain-identity.v1");
  const expectedSteps = [
    ["gcc_version", "gcc", ["--version"]],
    ["target_probe", "gcc", ["-dumpmachine"]],
    ["ld_version", "ld", ["--version"]],
    ["objcopy_version", "objcopy", ["--version"]],
    ["compile_and_link", "gcc", firmwareTargetCompileArguments()],
    ["objcopy_binary", "objcopy", firmwareTargetObjcopyArguments()],
  ] as const;
  const expectedOutputs = new Map([
    ["elf", { logicalName: "firmware/build/evleda-stm32g0b1cet6-candidate.elf", mediaType: "application/x-elf", maximumBytes: configuration.resourceLimits.maxElfBytes }],
    ["bin", { logicalName: "firmware/build/evleda-stm32g0b1cet6-candidate.bin", mediaType: "application/octet-stream", maximumBytes: configuration.resourceLimits.maxBinBytes }],
    ["map", { logicalName: "firmware/build/evleda-stm32g0b1cet6-candidate.map", mediaType: "text/plain; charset=utf-8", maximumBytes: configuration.resourceLimits.maxMapBytes }],
  ]);
  const toolIdentityForRole = (role: string): ContentIdentity | undefined =>
    configuration.toolchainFiles.find((file) => file.role === role)?.identity;
  const outputKinds = new Set(result.outputs.map((output) => isRecord(output) ? String(output.kind) : ""));
  return result.code === "FIRMWARE_TARGET_CROSS_BUILD_PASSED" &&
    result.targetTriple === "arm-none-eabi" && result.gccVersion === "14.2.1" &&
    strictCanonicalIdentity(result.toolchainIdentity) && canonicalJson(result.toolchainIdentity) === canonicalJson(expectedToolchainIdentity) &&
    result.deploymentDisposition === "compiled-non-flashable-candidate" &&
    result.steps.length === expectedSteps.length && result.steps.every((step, index) =>
      step.operation === expectedSteps[index]![0] && step.commandRole === expectedSteps[index]![1] &&
      canonicalJson(step.commandIdentity) === canonicalJson(toolIdentityForRole(step.commandRole)) &&
      canonicalJson(step.arguments) === canonicalJson(expectedSteps[index]![2]) && step.exitCode === 0
    ) && result.outputs.length === 3 && outputKinds.size === 3 && result.outputs.every((output) => {
      if (!isRecord(output) || !hasOnlyKeys(output, ["kind", "logicalName", "mediaType", "content", "identity"]) ||
        expectedOutputs.get(String(output.kind))?.logicalName !== output.logicalName ||
        expectedOutputs.get(String(output.kind))?.mediaType !== output.mediaType ||
        !(output.content instanceof Uint8Array) ||
        output.content.byteLength > (expectedOutputs.get(String(output.kind))?.maximumBytes ?? 0) ||
        !strictSha256Identity(output.identity)) return false;
      const actual = contentIdentity(output.content);
      return actual.size > 0 &&
        actual.size <= (expectedOutputs.get(String(output.kind))?.maximumBytes ?? 0) &&
        actual.digest === output.identity.digest && actual.size === output.identity.size;
    });
};

export interface FirmwareTargetBuildReportExpectation {
  readonly projectId: string;
  readonly runId: string;
  readonly sourceDesignRevisionId?: string;
  readonly targetBuildSourceIdentity?: ReturnType<typeof canonicalIdentity>;
  readonly provisionedConfigurationIdentity?: ReturnType<typeof canonicalIdentity>;
  readonly toolchainIdentity?: ReturnType<typeof canonicalIdentity>;
  readonly outputs?: readonly {
    readonly kind: "elf" | "bin" | "map";
    readonly logicalName: string;
    readonly mediaType: string;
    readonly identity: ContentIdentity;
  }[];
}

/**
 * Strictly validates the candidate-only PASS report before a physical-evidence
 * consumer binds a programmer observation to the committed target BIN. This
 * proves report/configuration consistency only; it does not authorize flashing.
 */
export const validateFirmwareTargetBuildReport = (
  value: unknown,
  expected: FirmwareTargetBuildReportExpectation,
): boolean => {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "schemaVersion", "classification", "lifecycle", "releaseAuthorized",
    "qualificationEstablished", "flashable", "deploymentDisposition", "status", "code",
    "message", "target", "sourceRevision", "toolchain", "invocations", "outputs", "limitations",
  ]) || !boundedString(value.message, 4096) || !Array.isArray(value.invocations) ||
    value.invocations.length > 6 || !Array.isArray(value.outputs) || value.outputs.length > 3 ||
    !Array.isArray(value.limitations) || value.limitations.length > 4) return false;
  try {
    if (Buffer.byteLength(canonicalJson(value), "utf8") > 4 * 1024 * 1024) return false;
  } catch {
    return false;
  }
  if (
    value.schemaVersion !== "evleda.firmware-target-build-report.v1" ||
    value.classification !== "candidate-only" || value.lifecycle !== "candidate" ||
    value.releaseAuthorized !== false || value.qualificationEstablished !== false ||
    value.flashable !== false || value.deploymentDisposition !== "compiled-non-flashable-candidate" ||
    value.status !== "pass" || value.code !== "FIRMWARE_TARGET_CROSS_BUILD_PASSED" ||
    !boundedString(value.message, 4096) ||
    value.limitations.length !== 4 ||
    !value.limitations.every((limitation) => boundedString(limitation, 1024))
  ) return false;
  const target = value.target;
  if (!isRecord(target) || !hasOnlyKeys(target, ["partNumber", "cpu", "targetTriple"]) ||
    target.partNumber !== "STM32G0B1CET6" || target.cpu !== "cortex-m0plus" ||
    target.targetTriple !== "arm-none-eabi") return false;

  const sourceRevision = value.sourceRevision;
  if (!isRecord(sourceRevision) || !hasOnlyKeys(sourceRevision, [
    "projectId", "runId", "designRevisionId", "targetBuildSourceIdentity", "generatedSources",
  ]) || sourceRevision.projectId !== expected.projectId || sourceRevision.runId !== expected.runId ||
    !boundedString(sourceRevision.designRevisionId, 256) ||
    (expected.sourceDesignRevisionId !== undefined && sourceRevision.designRevisionId !== expected.sourceDesignRevisionId) ||
    !strictCanonicalIdentity(sourceRevision.targetBuildSourceIdentity) ||
    sourceRevision.targetBuildSourceIdentity.schemaVersion !== "evleda.firmware-target-build-source.v1" ||
    (expected.targetBuildSourceIdentity !== undefined &&
      canonicalJson(sourceRevision.targetBuildSourceIdentity) !== canonicalJson(expected.targetBuildSourceIdentity)) ||
    !Array.isArray(sourceRevision.generatedSources) ||
    sourceRevision.generatedSources.length !== 5
  ) return false;
  const expectedSourceNames = new Set([
    "firmware/include/board_contract.h", "firmware/src/board_contract.c",
    "firmware/target/startup_stm32g0b1.s", "firmware/target/platform_stm32g0b1.c",
    "firmware/target/STM32G0B1CET6.ld",
  ]);
  const generatedNames = new Set<string>();
  let generatedSourceBytes = 0;
  for (const sourceEntry of sourceRevision.generatedSources) {
    if (!isRecord(sourceEntry) || !hasOnlyKeys(sourceEntry, ["logicalName", "identity"]) ||
      !expectedSourceNames.has(String(sourceEntry.logicalName)) ||
      !strictSha256Identity(sourceEntry.identity) || sourceEntry.identity.size <= 0 ||
      sourceEntry.identity.size > FIRMWARE_TARGET_RESOURCE_LIMITS.maxSourceBytes) return false;
    generatedSourceBytes += sourceEntry.identity.size;
    generatedNames.add(String(sourceEntry.logicalName));
  }
  if (generatedNames.size !== expectedSourceNames.size ||
    generatedSourceBytes > FIRMWARE_TARGET_RESOURCE_LIMITS.maxTotalSourceBytes) return false;

  const toolchain = value.toolchain;
  if (!isRecord(toolchain) || !hasOnlyKeys(toolchain, [
    "provisionedConfiguration", "provisionedConfigurationIdentity", "toolchainIdentity",
  ]) || !isRecord(toolchain.provisionedConfiguration) ||
    !strictCanonicalIdentity(toolchain.provisionedConfigurationIdentity) ||
    toolchain.provisionedConfigurationIdentity.schemaVersion !== FIRMWARE_TARGET_BUILD_CONFIGURATION_SCHEMA ||
    canonicalJson(toolchain.provisionedConfigurationIdentity) !== canonicalJson(canonicalIdentity(
      toolchain.provisionedConfiguration,
      FIRMWARE_TARGET_BUILD_CONFIGURATION_SCHEMA,
    )) || (expected.provisionedConfigurationIdentity !== undefined &&
      canonicalJson(toolchain.provisionedConfigurationIdentity) !== canonicalJson(expected.provisionedConfigurationIdentity)) ||
    !strictCanonicalIdentity(toolchain.toolchainIdentity) ||
    toolchain.toolchainIdentity.schemaVersion !== "evleda.arm-gnu-toolchain-identity.v1"
  ) return false;
  const configuration = toolchain.provisionedConfiguration;
  if (!hasOnlyKeys(configuration, [
    "schemaVersion", "backendId", "requestedToolchainRoot", "supportRoot", "targetTriple",
    "targetPart", "cpu", "floatAbi", "expectedRelease", "expectedGccVersion", "distribution",
    "environment", "environmentIdentity", "executionPolicy", "resourceLimits", "toolchainFiles",
    "supportFiles", "embeddedFiles", "compileArguments", "objcopyArguments", "timeoutMs",
    "maxOutputBytes", "processRunner",
  ]) || !validateFirmwareTargetBuildConfiguration(
    configuration as unknown as FirmwareTargetBuildBackendConfiguration,
    { requireProvisioned: true },
  ) || configuration.schemaVersion !== FIRMWARE_TARGET_BUILD_CONFIGURATION_SCHEMA ||
    configuration.backendId !== "arm-gnu-stm32g0b1-freestanding-v1" ||
    !path.isAbsolute(String(configuration.requestedToolchainRoot ?? "")) ||
    !path.isAbsolute(String(configuration.supportRoot ?? "")) ||
    configuration.targetTriple !== "arm-none-eabi" || configuration.targetPart !== "STM32G0B1CET6" ||
    configuration.cpu !== "cortex-m0plus" || configuration.floatAbi !== "soft" ||
    configuration.expectedRelease !== "14.2.Rel1" || configuration.expectedGccVersion !== "14.2.1" ||
    !isRecord(configuration.distribution) || !hasOnlyKeys(configuration.distribution, [
      "archiveName", "officialUrl", "sha256",
    ]) || configuration.distribution.archiveName !== ARM_GNU_ARCHIVE_NAME ||
    configuration.distribution.officialUrl !== ARM_GNU_OFFICIAL_URL ||
    configuration.distribution.sha256 !== ARM_GNU_ARCHIVE_SHA256 ||
    canonicalJson(configuration.compileArguments) !== canonicalJson(firmwareTargetCompileArguments()) ||
    canonicalJson(configuration.objcopyArguments) !== canonicalJson(firmwareTargetObjcopyArguments()) ||
    canonicalJson(configuration.resourceLimits) !== canonicalJson(FIRMWARE_TARGET_RESOURCE_LIMITS) ||
    configuration.processRunner !== "evleda.bounded-process.v1" ||
    !Number.isSafeInteger(configuration.timeoutMs) || Number(configuration.timeoutMs) <= 0 ||
    Number(configuration.timeoutMs) > 120_000 || !Number.isSafeInteger(configuration.maxOutputBytes) ||
    Number(configuration.maxOutputBytes) <= 0 || Number(configuration.maxOutputBytes) > 1024 * 1024 ||
    !isRecord(configuration.environment) || !hasOnlyKeys(configuration.environment, [
      "LC_ALL", "LANG", "LANGUAGE", "NO_COLOR", "SOURCE_DATE_EPOCH", "TEMP", "TMP",
      "TMPDIR", "PATH", "SystemRoot", "WINDIR",
    ]) || configuration.environment.LC_ALL !== "C" || configuration.environment.LANG !== "C" ||
    configuration.environment.LANGUAGE !== "C" || configuration.environment.NO_COLOR !== "1" ||
    configuration.environment.SOURCE_DATE_EPOCH !== "0" ||
    configuration.environment.TEMP !== "<workspace>" || configuration.environment.TMP !== "<workspace>" ||
    configuration.environment.TMPDIR !== "<workspace>" ||
    !firmwareEnvironmentIsMinimal(configuration.environment, "target") ||
    !strictCanonicalIdentity(configuration.environmentIdentity) ||
    canonicalJson(configuration.environmentIdentity) !== canonicalJson(canonicalIdentity(
      configuration.environment,
      FIRMWARE_TARGET_BUILD_ENVIRONMENT_SCHEMA,
    )) || !isRecord(configuration.executionPolicy) || !hasOnlyKeys(configuration.executionPolicy, [
      "schemaVersion", "acceptedSourceOrigin", "agentDerivedOrUntrustedSourceExecution",
      "osSandbox", "containmentClaim", "executableStrategy", "lto", "linkerPlugin",
    ]) ||
    configuration.executionPolicy.schemaVersion !== "evleda.firmware-execution-policy.v1" ||
    configuration.executionPolicy.acceptedSourceOrigin !== "evleda-deterministic-generator" ||
    configuration.executionPolicy.agentDerivedOrUntrustedSourceExecution !== "deny" ||
    configuration.executionPolicy.osSandbox !== "none" ||
    configuration.executionPolicy.containmentClaim !== "not-contained" ||
    configuration.executionPolicy.executableStrategy !== "verified-private-toolchain-closure" ||
    configuration.executionPolicy.lto !== "disabled" || configuration.executionPolicy.linkerPlugin !== "disabled" ||
    !Array.isArray(configuration.toolchainFiles) || configuration.toolchainFiles.length !== 7 ||
    !Array.isArray(configuration.supportFiles) || configuration.supportFiles.length !== 12 ||
    !Array.isArray(configuration.embeddedFiles) || configuration.embeddedFiles.length !== 4
  ) return false;
  const expectedRolePaths = new Map<string, string>([
    ["gcc", "bin/arm-none-eabi-gcc.exe"],
    ["cc1", "libexec/gcc/arm-none-eabi/14.2.1/cc1.exe"],
    ["assembler", "arm-none-eabi/bin/as.exe"],
    ["collect2", "libexec/gcc/arm-none-eabi/14.2.1/collect2.exe"],
    ["ld", "arm-none-eabi/bin/ld.exe"],
    ["objcopy", "bin/arm-none-eabi-objcopy.exe"],
    ["libgcc", "lib/gcc/arm-none-eabi/14.2.1/thumb/v6-m/nofp/libgcc.a"],
  ]);
  const roles = new Set<string>();
  let toolchainBytes = 0;
  for (const file of configuration.toolchainFiles) {
    if (!isRecord(file) || !hasOnlyKeys(file, ["role", "path", "relativePath", "identity"]) ||
      expectedRolePaths.get(String(file.role)) !== file.relativePath ||
      !path.isAbsolute(String(file.path)) ||
      path.resolve(String(file.path)) !== path.resolve(
        String(configuration.requestedToolchainRoot),
        ...String(file.relativePath).split("/"),
      ) || !strictSha256Identity(file.identity) || file.identity.size <= 0 ||
      file.identity.size > FIRMWARE_TARGET_RESOURCE_LIMITS.maxToolchainFileBytes) return false;
    toolchainBytes += file.identity.size;
    roles.add(String(file.role));
  }
  if (roles.size !== expectedRolePaths.size ||
    toolchainBytes > FIRMWARE_TARGET_RESOURCE_LIMITS.maxToolchainTotalBytes) return false;
  const expectedSupportPaths = new Set([
    "manifest.json", "CORE-LICENSE.txt", "core/include/cmsis_compiler.h",
    "core/include/cmsis_gcc.h", "core/include/cmsis_version.h", "core/include/core_cm0plus.h",
    "core/include/mpu_armv7.h", "DEVICE-LICENSE.md", "device/include/stm32g0b1xx.h",
    "device/include/stm32g0xx.h", "device/include/system_stm32g0xx.h",
    "device/templates/system_stm32g0xx.c",
  ]);
  const supportPaths = new Set<string>();
  let supportBytes = 0;
  for (const file of configuration.supportFiles) {
    if (!isRecord(file) || !hasOnlyKeys(file, ["role", "path", "relativePath", "identity"]) ||
      !expectedSupportPaths.has(String(file.relativePath)) ||
      file.role !== (file.relativePath === "manifest.json" ? "support_manifest" : "support_source") ||
      !path.isAbsolute(String(file.path)) || path.resolve(String(file.path)) !== path.resolve(
        String(configuration.supportRoot), ...String(file.relativePath).split("/"),
      ) || !strictSha256Identity(file.identity) || file.identity.size <= 0 ||
      file.identity.size > FIRMWARE_TARGET_RESOURCE_LIMITS.maxSupportFileBytes) return false;
    if (file.relativePath === "manifest.json" &&
      (file.identity.digest !== STM32G0_SUPPORT_MANIFEST_SHA256 ||
        file.identity.size !== STM32G0_SUPPORT_MANIFEST_SIZE)) return false;
    supportBytes += file.identity.size;
    supportPaths.add(String(file.relativePath));
  }
  if (supportPaths.size !== expectedSupportPaths.size ||
    supportBytes > FIRMWARE_TARGET_RESOURCE_LIMITS.maxSupportTotalBytes ||
    canonicalJson(configuration.embeddedFiles) !== canonicalJson(FIRMWARE_TARGET_EMBEDDED_FILES)) return false;
  const derivedToolchainIdentity = canonicalIdentity({
    distribution: configuration.distribution,
    files: configuration.toolchainFiles,
    embeddedFiles: configuration.embeddedFiles,
    executionPolicy: configuration.executionPolicy,
  }, "evleda.arm-gnu-toolchain-identity.v1");
  if (canonicalJson(toolchain.toolchainIdentity) !== canonicalJson(derivedToolchainIdentity) ||
    (expected.toolchainIdentity !== undefined &&
      canonicalJson(toolchain.toolchainIdentity) !== canonicalJson(expected.toolchainIdentity))) return false;

  if (!Array.isArray(value.invocations) || value.invocations.length !== 6) return false;
  const expectedInvocations = [
    ["gcc_version", "gcc", ["--version"]], ["target_probe", "gcc", ["-dumpmachine"]],
    ["ld_version", "ld", ["--version"]], ["objcopy_version", "objcopy", ["--version"]],
    ["compile_and_link", "gcc", firmwareTargetCompileArguments()],
    ["objcopy_binary", "objcopy", firmwareTargetObjcopyArguments()],
  ] as const;
  for (let index = 0; index < expectedInvocations.length; index += 1) {
    const invocation = value.invocations[index];
    const expectation = expectedInvocations[index]!;
    if (!isRecord(invocation) || !hasOnlyKeys(invocation, [
      "operation", "commandRole", "commandIdentity", "arguments", "exitCode", "stdout", "stderr",
    ]) || invocation.operation !== expectation[0] || invocation.commandRole !== expectation[1] ||
      canonicalJson(invocation.arguments) !== canonicalJson(expectation[2]) || invocation.exitCode !== 0 ||
      !strictSha256Identity(invocation.commandIdentity) ||
      canonicalJson(invocation.commandIdentity) !== canonicalJson(
        configuration.toolchainFiles.find((file) => isRecord(file) && file.role === invocation.commandRole)?.identity,
      ) || !boundedString(invocation.stdout, 512 * 1024, true) ||
      !boundedString(invocation.stderr, 512 * 1024, true)) return false;
  }

  if (!Array.isArray(value.outputs) || value.outputs.length !== 3) return false;
  const outputContract = new Map<string, readonly [string, string, number]>([
    ["elf", ["firmware/build/evleda-stm32g0b1cet6-candidate.elf", "application/x-elf", FIRMWARE_TARGET_RESOURCE_LIMITS.maxElfBytes]],
    ["bin", ["firmware/build/evleda-stm32g0b1cet6-candidate.bin", "application/octet-stream", FIRMWARE_TARGET_RESOURCE_LIMITS.maxBinBytes]],
    ["map", ["firmware/build/evleda-stm32g0b1cet6-candidate.map", "text/plain; charset=utf-8", FIRMWARE_TARGET_RESOURCE_LIMITS.maxMapBytes]],
  ]);
  const kinds = new Set<string>();
  for (const output of value.outputs) {
    if (!isRecord(output) || !hasOnlyKeys(output, ["kind", "logicalName", "mediaType", "identity"]) ||
      !outputContract.has(String(output.kind)) ||
      output.logicalName !== outputContract.get(String(output.kind))?.[0] ||
      output.mediaType !== outputContract.get(String(output.kind))?.[1] ||
      !strictSha256Identity(output.identity) || output.identity.size <= 0 ||
      output.identity.size > (outputContract.get(String(output.kind))?.[2] ?? 0)) return false;
    kinds.add(String(output.kind));
  }
  if (kinds.size !== 3) return false;
  return expected.outputs === undefined || canonicalJson(value.outputs) === canonicalJson(expected.outputs);
};

const snapshotFirmwareStageContext = (
  value: Parameters<typeof stageExactInputs>[0],
): Parameters<typeof stageExactInputs>[0] => {
  const firmwareCompileBackend = value.firmwareCompileBackend;
  const firmwareTargetBuildBackend = value.firmwareTargetBuildBackend;
  const snapshot = structuredClone({
    projectId: value.projectId,
    runId: value.runId,
    designRevisionId: value.designRevisionId,
    requirements: value.requirements,
    upstream: value.upstream,
    upstreamSourceRevisionBindings: value.upstreamSourceRevisionBindings,
    ...(value.profile === undefined ? {} : { profile: value.profile }),
    ...(value.requirementsApproval === undefined
      ? {}
      : { requirementsApproval: value.requirementsApproval }),
    ...(value.firmwareCompileConfiguration === undefined
      ? {}
      : { firmwareCompileConfiguration: value.firmwareCompileConfiguration }),
    ...(value.firmwareTargetBuildConfiguration === undefined
      ? {}
      : { firmwareTargetBuildConfiguration: value.firmwareTargetBuildConfiguration }),
  });
  return {
    ...snapshot,
    ...(firmwareCompileBackend === undefined ? {} : { firmwareCompileBackend }),
    ...(firmwareTargetBuildBackend === undefined ? {} : { firmwareTargetBuildBackend }),
  };
};

const backendConfigurationMatchesSnapshot = (
  live: unknown,
  snapshot: unknown,
): boolean => {
  try {
    return canonicalJson(live) === canonicalJson(snapshot);
  } catch {
    return false;
  }
};

const INVALID_BACKEND_SNAPSHOT = Symbol("invalid-firmware-backend-snapshot");

const snapshotUntrustedBackendResult = (value: unknown): unknown | undefined => {
  const budget = { nodes: 0, stringBytes: 0, binaryBytes: 0 };
  const seen = new WeakSet<object>();
  const clone = (input: unknown, depth: number): unknown | typeof INVALID_BACKEND_SNAPSHOT => {
    budget.nodes += 1;
    if (budget.nodes > 20_000 || depth > 24) return INVALID_BACKEND_SNAPSHOT;
    if (input === null || input === undefined || typeof input === "boolean") return input;
    if (typeof input === "string") {
      const bytes = Buffer.byteLength(input, "utf8");
      budget.stringBytes += bytes;
      return bytes <= 1024 * 1024 && budget.stringBytes <= 4 * 1024 * 1024
        ? input
        : INVALID_BACKEND_SNAPSHOT;
    }
    if (typeof input === "number") return Number.isFinite(input) ? input : INVALID_BACKEND_SNAPSHOT;
    if (typeof input !== "object" || seen.has(input)) return INVALID_BACKEND_SNAPSHOT;
    seen.add(input);
    if (input instanceof Uint8Array) {
      budget.binaryBytes += input.byteLength;
      const output = input.byteLength <= FIRMWARE_TARGET_RESOURCE_LIMITS.maxElfBytes &&
        budget.binaryBytes <= 40 * 1024 * 1024
        ? Uint8Array.from(input)
        : INVALID_BACKEND_SNAPSHOT;
      seen.delete(input);
      return output;
    }
    let descriptors: PropertyDescriptorMap;
    let prototype: object | null;
    try {
      descriptors = Object.getOwnPropertyDescriptors(input);
      prototype = Object.getPrototypeOf(input) as object | null;
    } catch {
      return INVALID_BACKEND_SNAPSHOT;
    }
    if (Array.isArray(input)) {
      if (prototype !== Array.prototype || input.length > 256) return INVALID_BACKEND_SNAPSHOT;
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some((key) => typeof key !== "string") || keys.length !== input.length + 1 ||
        descriptors.length?.get !== undefined || descriptors.length?.set !== undefined) {
        return INVALID_BACKEND_SNAPSHOT;
      }
      const output: unknown[] = [];
      for (let index = 0; index < input.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined ||
          descriptor.enumerable !== true || !("value" in descriptor)) return INVALID_BACKEND_SNAPSHOT;
        const child = clone(descriptor.value, depth + 1);
        if (child === INVALID_BACKEND_SNAPSHOT) return child;
        output.push(child);
      }
      seen.delete(input);
      return output;
    }
    if (prototype !== Object.prototype && prototype !== null) return INVALID_BACKEND_SNAPSHOT;
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > 256 || keys.some((key) => typeof key !== "string")) {
      return INVALID_BACKEND_SNAPSHOT;
    }
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined ||
        descriptor.enumerable !== true || !("value" in descriptor)) return INVALID_BACKEND_SNAPSHOT;
      const child = clone(descriptor.value, depth + 1);
      if (child === INVALID_BACKEND_SNAPSHOT) return child;
      output[key] = child;
    }
    seen.delete(input);
    return output;
  };
  const snapshot = clone(value, 0);
  return snapshot === INVALID_BACKEND_SNAPSHOT ? undefined : snapshot;
};

export const firmwareContractStageExecutor: StageExecutor<"firmware_contract"> = {
  stage: "firmware_contract",
  async execute(context) {
    context = snapshotFirmwareStageContext(context);
    const profile = profileFor(context);
    const exactInputs = stageExactInputs(context);
    const initiallyProvisionedCompiler = provisionedCompileBackend(context);
    const initiallyProvisionedTarget = provisionedTargetBuildBackend(context);
    const blockers = [
      ...prerequisiteBlockers("firmware_contract", context),
      ...requirementsApprovalBlockers(context),
      ...referenceEnvelopeBlockers(context, profile),
      ...profileIntegrityBlockers(profile, exactInputs)
    ];
    const immutablePrerequisitesBlocked = blockers.length > 0;
    const generatedPinMaps = context.upstream
      .filter((result) => result.stage === "schematic")
      .flatMap((result) =>
        result.artifacts.filter(
          (artifact) => artifact.logicalName === SCHEMATIC_PIN_MAP_LOGICAL_NAME
        )
      );
    const contract = jsonArtifactDraft({
      logicalName: "firmware/board-contract.json",
      value: firmwareContractValue(profile, {
        projectId: context.projectId,
        runId: context.runId,
        designRevisionId: context.designRevisionId,
        requirementsIdentity: context.requirements.identity,
        generatedSchematicPinMapIdentity:
          generatedPinMaps.length === 1 ? generatedPinMaps[0]!.identity : null
      }),
      exactInputs,
      validationStatus: "not_run"
    });
    const headerArtifact = artifactDraft({
      logicalName: "firmware/include/board_contract.h",
      mediaType: "text/x-c",
      content: header(profile),
      exactInputs,
      derivedFrom: [contract.logicalName],
      validationStatus: "not_run"
    });
    const sourceArtifact = artifactDraft({
      logicalName: "firmware/src/board_contract.c",
      mediaType: "text/x-c",
      content: source(),
      exactInputs,
      derivedFrom: [contract.logicalName, headerArtifact.logicalName],
      validationStatus: "not_run"
    });
    const validationArtifact = artifactDraft({
      logicalName: "firmware/tests/board_contract_validation.c",
      mediaType: "text/x-c",
      content: validationSource(),
      exactInputs,
      derivedFrom: [contract.logicalName, headerArtifact.logicalName],
      validationStatus: "not_run"
    });
    const cmakeArtifact = artifactDraft({
      logicalName: "firmware/CMakeLists.txt",
      mediaType: "text/plain",
      content: cmake(),
      exactInputs,
      derivedFrom: [contract.logicalName],
      validationStatus: "not_run"
    });
    const targetStartupArtifact = artifactDraft({
      logicalName: "firmware/target/startup_stm32g0b1.s",
      mediaType: "text/x-asm",
      content: stm32g0StartupSource(),
      exactInputs,
      derivedFrom: [contract.logicalName],
      validationStatus: "not_run",
    });
    const targetPlatformArtifact = artifactDraft({
      logicalName: "firmware/target/platform_stm32g0b1.c",
      mediaType: "text/x-c",
      content: stm32g0PlatformSource(profile),
      exactInputs,
      derivedFrom: [contract.logicalName, headerArtifact.logicalName, sourceArtifact.logicalName],
      validationStatus: "not_run",
    });
    const targetLinkerArtifact = artifactDraft({
      logicalName: "firmware/target/STM32G0B1CET6.ld",
      mediaType: "text/plain; charset=utf-8",
      content: stm32g0LinkerScript(),
      exactInputs,
      derivedFrom: [contract.logicalName],
      validationStatus: "not_run",
    });

    const parity = validateFirmwareSchematicParity({
      context,
      profile,
      contractArtifact: contract,
      headerArtifact
    });
    const parityInputs = sortedIdentities([
      ...exactInputs,
      contract.identity,
      headerArtifact.identity,
      parity.sourceRevision.paritySourceIdentity,
      ...(parity.sourceRevision.schematicStageOutputIdentity === null
        ? []
        : [parity.sourceRevision.schematicStageOutputIdentity]),
      ...(parity.sourceRevision.generatedPinMapIdentity === null
        ? []
        : [parity.sourceRevision.generatedPinMapIdentity])
    ]);
    const parityReportArtifact = jsonArtifactDraft({
      logicalName: "firmware/reports/schematic-pin-map-parity.json",
      value: parity,
      exactInputs: parityInputs,
      derivedFrom: [
        contract.logicalName,
        headerArtifact.logicalName,
        SCHEMATIC_PIN_MAP_LOGICAL_NAME
      ],
      validationStatus: parity.status
    });

    const compileSources: readonly FirmwareCompileSource[] = [
      {
        logicalName: "firmware/include/board_contract.h",
        content: headerArtifact.content,
        identity: headerArtifact.identity
      },
      {
        logicalName: "firmware/src/board_contract.c",
        content: sourceArtifact.content,
        identity: sourceArtifact.identity
      },
      {
        logicalName: "firmware/tests/board_contract_validation.c",
        content: validationArtifact.content,
        identity: validationArtifact.identity
      }
    ];
    const compileSourceIdentity = canonicalIdentity(
      {
        projectId: context.projectId,
        runId: context.runId,
        designRevisionId: context.designRevisionId,
        requirementsIdentity: context.requirements.identity,
        profileIdentity: canonicalIdentity(profile, "evleda.reference-profile.v1"),
        schematicStageOutputIdentity: parity.sourceRevision.schematicStageOutputIdentity,
        generatedPinMapIdentity: parity.sourceRevision.generatedPinMapIdentity,
        generatedSources: compileSources.map((entry) => ({
          logicalName: entry.logicalName,
          identity: entry.identity
        }))
      },
      "evleda.firmware-compile-source.v1"
    );
    const provisionedCompiler = initiallyProvisionedCompiler;
    const unprovisionedConfigurationIdentity = canonicalIdentity(
      {
        schemaVersion: FIRMWARE_COMPILE_BACKEND_CONFIGURATION_SCHEMA,
        status: "unprovisioned"
      },
      FIRMWARE_COMPILE_BACKEND_CONFIGURATION_SCHEMA
    );
    if (provisionedCompiler === undefined) {
      blockers.push(
        blockerDraft(
          "FIRMWARE_TOOLCHAIN_UNPROVISIONED",
          "No application-verified firmware compile backend and configuration were provisioned before stage input freeze.",
          [...exactInputs, compileSourceIdentity],
          "Configure an explicit firmware compiler before stage provisioning, then start a new attempt."
        )
      );
    }
    const compileBackendId = provisionedCompiler?.backend.backendId ?? "unprovisioned";
    const provisionedConfigurationIdentity =
      provisionedCompiler?.configurationIdentity ?? unprovisionedConfigurationIdentity;
    let compileResult: FirmwareCompileResult;
    if (blockers.length > 0) {
      compileResult = skippedCompileResult(
        compileBackendId,
        compileSourceIdentity.digest,
        provisionedConfigurationIdentity
      );
    } else {
      try {
        const requestSources = compileSources.map((source) => ({
          logicalName: source.logicalName,
          content: Uint8Array.from(source.content),
          identity: structuredClone(source.identity)
        }));
        const liveCandidate = await provisionedCompiler!.backend.execute({
          schemaVersion: "evleda.firmware-compile-request.v1",
          sourceRevisionDigest: compileSourceIdentity.digest,
          configurationIdentity: provisionedConfigurationIdentity,
          sourceOrigin: "evleda-deterministic-generator",
          sources: requestSources
        });
        const candidate = snapshotUntrustedBackendResult(liveCandidate);
        const backendConfigurationUnchanged = backendConfigurationMatchesSnapshot(
          provisionedCompiler!.backend.configuration,
          provisionedCompiler!.configuration,
        );
        compileResult = candidate !== undefined && backendConfigurationUnchanged && compileResultIsUsable(
          candidate,
          compileBackendId,
          compileSourceIdentity.digest,
          provisionedConfigurationIdentity,
          compileSources,
          provisionedCompiler!.configuration,
        )
          ? candidate
          : invalidCompileResult(
              compileBackendId,
              compileSourceIdentity.digest,
              provisionedConfigurationIdentity
            );
      } catch {
        compileResult = invalidCompileResult(
          compileBackendId,
          compileSourceIdentity.digest,
          provisionedConfigurationIdentity
        );
      }
    }
    const toolchainConfigurationIdentity = canonicalIdentity(
      {
        provisionedConfigurationIdentity,
        backendId: compileResult.backendId,
        requestedCompilerPath: compileResult.requestedCompilerPath,
        compilerFamily: compileResult.compilerFamily,
        targetTriple: compileResult.targetTriple,
        tool: compileResult.tool ?? null,
        executableIdentity: compileResult.executableIdentity ?? null,
        validationExecutableIdentity: compileResult.validationExecutableIdentity ?? null
      },
      "evleda.firmware-toolchain-configuration.v1"
    );
    const compileInputs = sortedIdentities([
      ...exactInputs,
      ...compileSources.map((entry) => entry.identity),
      compileSourceIdentity,
      provisionedConfigurationIdentity,
      toolchainConfigurationIdentity,
      ...(compileResult.executableIdentity === undefined
        ? []
        : [compileResult.executableIdentity]),
      ...(compileResult.validationExecutableIdentity === undefined
        ? []
        : [compileResult.validationExecutableIdentity])
    ]);
    const compileReport = {
      schemaVersion: "evleda.firmware-compile-report.v1",
      classification: "candidate-only",
      lifecycle: "candidate",
      releaseAuthorized: false,
      qualificationEstablished: false,
      status: compileResult.status,
      code: compileResult.code,
      message: compileResult.message,
      sourceRevision: {
        projectId: context.projectId,
        runId: context.runId,
        designRevisionId: context.designRevisionId,
        requirementsIdentity: context.requirements.identity,
        schematicStageOutputIdentity: parity.sourceRevision.schematicStageOutputIdentity,
        generatedPinMapIdentity: parity.sourceRevision.generatedPinMapIdentity,
        firmwareCompileSourceIdentity: compileSourceIdentity,
        generatedSources: compileSources.map((entry) => ({
          logicalName: entry.logicalName,
          identity: entry.identity
        }))
      },
      toolchain: {
        backendId: compileResult.backendId,
        provisionedConfiguration:
          provisionedCompiler?.configuration ?? null,
        provisionedConfigurationIdentity,
        requestedCompilerPath: compileResult.requestedCompilerPath,
        compilerFamily: compileResult.compilerFamily,
        targetTriple: compileResult.targetTriple,
        tool: compileResult.tool ?? null,
        executableIdentity: compileResult.executableIdentity ?? null,
        validationExecutableIdentity: compileResult.validationExecutableIdentity ?? null,
        configurationIdentity: toolchainConfigurationIdentity
      },
      steps: compileResult.steps,
      limitations: [
        "A pass proves host C11 compilation, linking, and execution of the generated invariant test for these exact bytes only; bounded process controls are not an OS sandbox.",
        "The emitted CMake manifest is not executed by this direct bounded compiler gate and remains not-run evidence.",
        "Target STM32 compilation, startup code, linker script, option bytes, peripheral implementation, HIL behavior, and physical fault paths remain unproven.",
        "This candidate-only report is not safety, qualification, fabrication, or manufacturing-release evidence."
      ]
    } as const;
    const compileReportArtifact = jsonArtifactDraft({
      logicalName: "firmware/reports/compile-validation.json",
      value: compileReport,
      exactInputs: compileInputs,
      derivedFrom: [
        contract.logicalName,
        headerArtifact.logicalName,
        sourceArtifact.logicalName,
        validationArtifact.logicalName
      ],
      ...(compileResult.tool === undefined ? {} : { tool: compileResult.tool }),
      validationStatus: compileResult.status
    });

    const targetSources: readonly FirmwareTargetBuildSource[] = [
      { logicalName: "firmware/include/board_contract.h", content: headerArtifact.content, identity: headerArtifact.identity },
      { logicalName: "firmware/src/board_contract.c", content: sourceArtifact.content, identity: sourceArtifact.identity },
      { logicalName: "firmware/target/startup_stm32g0b1.s", content: targetStartupArtifact.content, identity: targetStartupArtifact.identity },
      { logicalName: "firmware/target/platform_stm32g0b1.c", content: targetPlatformArtifact.content, identity: targetPlatformArtifact.identity },
      { logicalName: "firmware/target/STM32G0B1CET6.ld", content: targetLinkerArtifact.content, identity: targetLinkerArtifact.identity },
    ];
    const targetSourceIdentity = canonicalIdentity({
      projectId: context.projectId,
      runId: context.runId,
      designRevisionId: context.designRevisionId,
      profileIdentity: canonicalIdentity(profile, "evleda.reference-profile.v1"),
      generatedSources: targetSources.map((source) => ({ logicalName: source.logicalName, identity: source.identity })),
    }, "evleda.firmware-target-build-source.v1");
    const provisionedTarget = initiallyProvisionedTarget;
    const unprovisionedTargetConfigurationIdentity = canonicalIdentity({
      schemaVersion: FIRMWARE_TARGET_BUILD_CONFIGURATION_SCHEMA,
      status: "unprovisioned",
    }, FIRMWARE_TARGET_BUILD_CONFIGURATION_SCHEMA);
    const targetBackendId = provisionedTarget?.backend.backendId ?? "unprovisioned";
    const targetConfigurationIdentity = provisionedTarget?.configurationIdentity ?? unprovisionedTargetConfigurationIdentity;
    let targetBuildResult: FirmwareTargetBuildResult;
    if (immutablePrerequisitesBlocked) {
      targetBuildResult = skippedTargetBuildResult(targetBackendId, targetSourceIdentity.digest, targetConfigurationIdentity);
    } else if (provisionedTarget === undefined) {
      targetBuildResult = skippedTargetBuildResult(targetBackendId, targetSourceIdentity.digest, targetConfigurationIdentity);
    } else if (!backendConfigurationMatchesSnapshot(
      provisionedTarget.backend.configuration,
      provisionedTarget.configuration,
    )) {
      targetBuildResult = invalidTargetBuildResult(targetBackendId, targetSourceIdentity.digest, targetConfigurationIdentity);
    } else {
      try {
        const liveCandidate = await provisionedTarget.backend.execute({
          schemaVersion: "evleda.firmware-target-build-request.v1",
          sourceRevisionDigest: targetSourceIdentity.digest,
          configurationIdentity: targetConfigurationIdentity,
          sourceOrigin: "evleda-deterministic-generator",
          sources: targetSources.map((source) => ({
            logicalName: source.logicalName,
            identity: structuredClone(source.identity),
            content: Uint8Array.from(source.content),
          })),
        });
        const candidate = snapshotUntrustedBackendResult(liveCandidate);
        const backendConfigurationUnchanged = backendConfigurationMatchesSnapshot(
          provisionedTarget.backend.configuration,
          provisionedTarget.configuration,
        );
        targetBuildResult = candidate !== undefined && backendConfigurationUnchanged && targetBuildResultIsUsable(
          candidate,
          targetBackendId,
          targetSourceIdentity.digest,
          targetConfigurationIdentity,
          targetSources,
          provisionedTarget.configuration,
        ) ? candidate : invalidTargetBuildResult(targetBackendId, targetSourceIdentity.digest, targetConfigurationIdentity);
      } catch {
        targetBuildResult = invalidTargetBuildResult(targetBackendId, targetSourceIdentity.digest, targetConfigurationIdentity);
      }
    }
    const targetToolchainFiles = provisionedTarget?.configuration.toolchainFiles ?? [];
    const targetSupportFiles = provisionedTarget?.configuration.supportFiles ?? [];
    const targetBaseInputs = sortedIdentities([
      ...exactInputs,
      ...targetSources.map((source) => source.identity),
      targetSourceIdentity,
      targetConfigurationIdentity,
      ...targetToolchainFiles.map((file) => file.identity),
      ...targetSupportFiles.map((file) => file.identity),
      ...(provisionedTarget?.configuration.embeddedFiles.map((file) => file.identity) ?? []),
      ...(targetBuildResult.toolchainIdentity === null ? [] : [targetBuildResult.toolchainIdentity]),
    ]);
    const targetTool: ToolIdentity | undefined = targetBuildResult.status === "pass"
      ? (() => {
          const gcc = targetToolchainFiles.find((file) => file.role === "gcc");
          return gcc === undefined ? undefined : {
            name: "arm-none-eabi-gcc",
            version: targetBuildResult.gccVersion!,
            adapter: "external",
            executablePath: gcc.path,
            executableDigest: gcc.identity.digest,
            capabilityProfile: "stm32g0b1cet6:cortex-m0plus:freestanding:candidate-only",
          };
        })()
      : undefined;
    const targetOutputArtifacts = targetBuildResult.outputs.map((output) => artifactDraft({
      logicalName: output.logicalName,
      mediaType: output.mediaType,
      content: output.content,
      exactInputs: targetBaseInputs,
      derivedFrom: targetSources.map((source) => source.logicalName),
      ...(targetTool === undefined ? {} : { tool: targetTool }),
      validationStatus: "pass",
    }));
    const targetReport = {
      schemaVersion: "evleda.firmware-target-build-report.v1",
      classification: "candidate-only",
      lifecycle: "candidate",
      releaseAuthorized: false,
      qualificationEstablished: false,
      flashable: false,
      deploymentDisposition: targetBuildResult.deploymentDisposition,
      status: targetBuildResult.status,
      code: targetBuildResult.code,
      message: targetBuildResult.message,
      target: { partNumber: "STM32G0B1CET6", cpu: "cortex-m0plus", targetTriple: targetBuildResult.targetTriple },
      sourceRevision: {
        projectId: context.projectId,
        runId: context.runId,
        designRevisionId: context.designRevisionId,
        targetBuildSourceIdentity: targetSourceIdentity,
        generatedSources: targetSources.map((source) => ({ logicalName: source.logicalName, identity: source.identity })),
      },
      toolchain: {
        provisionedConfiguration: provisionedTarget?.configuration ?? null,
        provisionedConfigurationIdentity: targetConfigurationIdentity,
        toolchainIdentity: targetBuildResult.toolchainIdentity,
      },
      invocations: targetBuildResult.steps,
      outputs: targetBuildResult.outputs.map((output) => ({
        kind: output.kind, logicalName: output.logicalName, mediaType: output.mediaType, identity: output.identity,
      })),
      limitations: [
        "The ELF, BIN, and map are deterministic compiler outputs from an identity-verified private toolchain closure with LTO and linker plugins disabled; process controls are not an OS sandbox and the outputs are not authorized for flashing or deployment.",
        "The EVL-RC-G0-REV-A raw board-revision strap encoding is not reviewed, so the platform matcher deliberately returns false.",
        "Fault polarity/debounce, ADC calibration, peripheral setup, option bytes, HIL behavior, and physical fault paths remain unvalidated.",
        "No output proves safety, qualification, fabrication readiness, or manufacturing release.",
      ],
    } as const;
    const targetReportArtifact = jsonArtifactDraft({
      logicalName: "firmware/reports/stm32g0-target-build.json",
      value: targetReport,
      exactInputs: sortedIdentities([...targetBaseInputs, ...targetBuildResult.outputs.map((output) => output.identity)]),
      derivedFrom: [...targetSources.map((source) => source.logicalName), ...targetBuildResult.outputs.map((output) => output.logicalName)],
      ...(targetTool === undefined ? {} : { tool: targetTool }),
      validationStatus: targetBuildResult.status,
    });

    const prerequisitesClear = !immutablePrerequisitesBlocked;
    if (prerequisitesClear && parity.status !== "pass") {
      blockers.push(
        blockerDraft(
          "FIRMWARE_SCHEMATIC_PARITY_FAILED",
          `Firmware/schematic parity has ${parity.findingCount.toString()} exact assignment or revision-binding findings.`,
          parityInputs,
          "Provide a passing native node-level MCU pin-map report for the exact authenticated revision, reconcile pin/header/revision mapping, and validate reset-bias, protocol, and resource implementation through separately bound checks."
        )
      );
    }
    if (prerequisitesClear && compileResult.status !== "pass") {
      blockers.push(
        blockerDraft(
          compileResult.status === "unsupported"
            ? "FIRMWARE_TOOLCHAIN_UNSUPPORTED"
            : "FIRMWARE_COMPILE_VALIDATION_FAILED",
          compileResult.message,
          compileInputs,
          compileResult.status === "unsupported"
            ? "Configure EVLEDA_FIRMWARE_CC as an absolute native Clang or GCC executable before provisioning a new stage attempt, then rerun against the frozen generated sources."
            : "Inspect the persisted compile report, correct the generated scaffold or identified toolchain failure, and rerun."
        )
      );
    }
    if (prerequisitesClear && provisionedTarget === undefined) {
      blockers.push(blockerDraft(
        "FIRMWARE_TARGET_TOOLCHAIN_UNPROVISIONED",
        "No application-verified STM32 target build backend and configuration were provisioned before stage input freeze.",
        targetBaseInputs,
        "Set EVLEDA_ARM_GCC_ROOT to the absolute Arm GNU Toolchain 14.2.Rel1 root and start a new stage attempt.",
      ));
    } else if (prerequisitesClear && targetBuildResult.status !== "pass") {
      blockers.push(blockerDraft(
        targetBuildResult.status === "unsupported"
          ? "FIRMWARE_TARGET_TOOLCHAIN_UNSUPPORTED"
          : "FIRMWARE_TARGET_BUILD_FAILED",
        targetBuildResult.message,
        targetBaseInputs,
        targetBuildResult.status === "unsupported"
          ? "Provision the exact official Arm GNU Toolchain 14.2.Rel1 with all bound helpers/runtime files, then start a new attempt."
          : "Inspect the target build report, restore every bound tool/support identity or correct the generated target layer, then rerun.",
      ));
    }

    const prerequisiteFailure = blockers.some(
      (blocker) =>
        blocker.code !== "FIRMWARE_SCHEMATIC_PARITY_FAILED" &&
        blocker.code !== "FIRMWARE_TOOLCHAIN_UNPROVISIONED" &&
        blocker.code !== "FIRMWARE_TOOLCHAIN_UNSUPPORTED" &&
        blocker.code !== "FIRMWARE_COMPILE_VALIDATION_FAILED" &&
        blocker.code !== "FIRMWARE_TARGET_TOOLCHAIN_UNPROVISIONED" &&
        blocker.code !== "FIRMWARE_TARGET_TOOLCHAIN_UNSUPPORTED" &&
        blocker.code !== "FIRMWARE_TARGET_BUILD_FAILED"
    );
    const parityStatus: ValidationStatus = prerequisiteFailure ? "fail" : parity.status;
    const compileStatus: ValidationStatus = prerequisiteFailure
      ? "unsupported"
      : compileResult.status;
    const targetStatus: ValidationStatus = prerequisiteFailure
      ? "unsupported"
      : targetBuildResult.status;
    const headerStatus: ValidationStatus =
      parityStatus !== "pass"
        ? parityStatus
        : compileStatus !== "pass"
          ? compileStatus
          : targetStatus;
    const artifacts = [
      { ...contract, validationStatus: parityStatus },
      {
        ...headerArtifact,
        validationStatus: headerStatus
      },
      { ...sourceArtifact, validationStatus: headerStatus },
      { ...validationArtifact, validationStatus: compileStatus },
      cmakeArtifact,
      { ...targetStartupArtifact, validationStatus: targetStatus },
      { ...targetPlatformArtifact, validationStatus: targetStatus },
      { ...targetLinkerArtifact, validationStatus: targetStatus },
      ...targetOutputArtifacts,
      parityReportArtifact,
      compileReportArtifact,
      targetReportArtifact,
    ];
    const evidence = [
      evidenceDraft({
        evidenceClass: "evleda_check",
        claim:
          parity.status === "pass"
            ? "Source-proven MCU signal, reference, physical-pin, pin-function, pin-type, native-net, generated header-pin macro, and authenticated revision mappings agree exactly; reset-bias, protocol, and timer/IRQ/DMA/resource implementation remain NOT_RUN."
            : "Source-proven MCU pin, generated header-pin macro, and authenticated revision mappings do not have complete exact parity; reset-bias, protocol, and timer/IRQ/DMA/resource implementation remain NOT_RUN.",
        subjectDigests: [
          contract.identity.digest,
          headerArtifact.identity.digest,
          parityReportArtifact.identity.digest
        ],
        parsedArtifactLogicalName: parityReportArtifact.logicalName,
        exactInputs: parityInputs,
        validationStatus: parity.status
      }),
      evidenceDraft({
        evidenceClass: "evleda_check",
        claim:
          compileResult.status === "pass"
            ? "The exact generated C scaffold compiled, linked, and passed its generated host validation executable with the identified native C11 toolchain; target-MCU and physical behavior remain unproven."
            : compileResult.status === "unsupported"
              ? "Generated firmware compilation is unsupported until an explicit native Clang or GCC toolchain is identified."
              : "The identified toolchain did not compile/link the exact generated scaffold or its generated validation executable did not pass.",
        subjectDigests: [
          ...compileSources.map((entry) => entry.identity.digest),
          compileReportArtifact.identity.digest
        ],
        parsedArtifactLogicalName: compileReportArtifact.logicalName,
        exactInputs: compileInputs,
        ...(compileResult.tool === undefined ? {} : { tool: compileResult.tool }),
        validationStatus: compileResult.status
      }),
      evidenceDraft({
        evidenceClass: "evleda_check",
        claim: targetBuildResult.status === "pass"
          ? "The exact generated target layer cross-compiled and linked for Cortex-M0+ with the fully identity-bound Arm GNU toolchain; the outputs remain non-flashable candidates."
          : targetBuildResult.status === "unsupported"
            ? "STM32G0 target compilation is unsupported until the exact provisioned Arm GNU Toolchain and pinned CMSIS inputs are available."
            : "The identity-bound STM32G0 target compile, link, or binary conversion failed.",
        subjectDigests: [
          ...targetSources.map((source) => source.identity.digest),
          ...targetBuildResult.outputs.map((output) => output.identity.digest),
          targetReportArtifact.identity.digest,
        ],
        parsedArtifactLogicalName: targetReportArtifact.logicalName,
        exactInputs: targetReportArtifact.exactInputs,
        ...(targetTool === undefined ? {} : { tool: targetTool }),
        validationStatus: targetBuildResult.status,
      })
    ];
    return finalizeStageResult("firmware_contract", artifacts, evidence, blockers);
  }
};
