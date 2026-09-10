import path from "node:path";

import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import type {
  FirmwareCompileBackend,
  FirmwareCompileResult
} from "../../src/integrations/firmware-compiler.js";
import {
  FIRMWARE_COMPILE_RESOURCE_LIMITS,
  firmwareCompileArguments,
} from "../../src/integrations/firmware-compiler.js";
import { REFERENCE_KICAD_REPORT_SCHEMA } from "../../src/integrations/reference-kicad-backend.js";
import {
  ARM_GNU_ARCHIVE_NAME,
  ARM_GNU_ARCHIVE_SHA256,
  ARM_GNU_OFFICIAL_URL,
  firmwareTargetCompileArguments,
  firmwareTargetObjcopyArguments,
  FIRMWARE_TARGET_EMBEDDED_FILES,
  FIRMWARE_TARGET_RESOURCE_LIMITS,
  STM32G0_SUPPORT_FILE_CLOSURE,
  STM32G0_SUPPORT_MANIFEST_SHA256,
  STM32G0_SUPPORT_MANIFEST_SIZE,
} from "../../src/integrations/firmware-target-builder.js";
import {
  FIRMWARE_COMPILE_BACKEND_CONFIGURATION_SCHEMA,
  FIRMWARE_COMPILE_ENVIRONMENT_SCHEMA,
  FIRMWARE_EXECUTION_POLICY_SCHEMA,
  FIRMWARE_TARGET_BUILD_CONFIGURATION_SCHEMA,
  FIRMWARE_TARGET_BUILD_ENVIRONMENT_SCHEMA,
  type FirmwareTargetBuildBackend,
  type FirmwareTargetToolchainFileRole,
} from "../../src/workflow/contracts.js";
import {
  firmwareParityMappingModel,
  firmwareParityMappingModelIdentity
} from "../../src/knowledge/firmware-parity-model.js";
import type { ReferenceControllerProfile } from "../../src/knowledge/reference-controller-v0.js";

const targetTriple = (): string => {
  if (process.platform === "win32") {
    return process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  }
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  return process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
};

export const passingFirmwareCompileBackend = (): FirmwareCompileBackend => {
  const backendId = "isolated-firmware-compiler-test-double";
  const executablePath = path.resolve("fixtures", "isolated-clang-test-double");
  const environment = {
    LC_ALL: "C", LANG: "C", LANGUAGE: "C", NO_COLOR: "1", SOURCE_DATE_EPOCH: "0",
    PATH: "<compiler-dir>", TEMP: "<workspace>", TMP: "<workspace>", TMPDIR: "<workspace>",
  };
  const configuration = {
    schemaVersion: FIRMWARE_COMPILE_BACKEND_CONFIGURATION_SCHEMA,
    backendId,
    requestedCompilerPath: executablePath,
    environment,
    environmentIdentity: canonicalIdentity(environment, FIRMWARE_COMPILE_ENVIRONMENT_SCHEMA),
    executionPolicy: {
      schemaVersion: FIRMWARE_EXECUTION_POLICY_SCHEMA,
      acceptedSourceOrigin: "evleda-deterministic-generator" as const,
      agentDerivedOrUntrustedSourceExecution: "deny" as const,
      osSandbox: "none" as const,
      containmentClaim: "not-contained" as const,
      executableStrategy: "identity-checked-shared-path" as const,
      lto: "disabled" as const,
      linkerPlugin: "disabled" as const,
    },
    resourceLimits: FIRMWARE_COMPILE_RESOURCE_LIMITS,
    platform: process.platform,
    architecture: process.arch,
    compileArguments: firmwareCompileArguments(),
    timeoutMs: 30_000,
    maxOutputBytes: 256 * 1024,
    processRunner: "evleda.bounded-process.v1" as const
  };
  return {
  backendId,
  configuration,
  execute: async (request): Promise<FirmwareCompileResult> => {
    const executableIdentity = contentIdentity("isolated-firmware-compiler-test-double:v1");
    return {
      schemaVersion: "evleda.firmware-compile-result.v1",
      sourceRevisionDigest: request.sourceRevisionDigest,
      configurationIdentity: request.configurationIdentity,
      status: "pass",
      code: "FIRMWARE_HOST_C11_VALIDATION_PASSED",
      message: "Isolated fixture compiled, linked, and ran the exact supplied sources.",
      backendId,
      requestedCompilerPath: executablePath,
      compilerFamily: "clang",
      targetTriple: targetTriple(),
      tool: {
        name: "clang",
        version: "99.0.0-test",
        adapter: "external",
        executablePath,
        executableDigest: executableIdentity.digest,
        capabilityProfile: `native-c11:${targetTriple()}`
      },
      executableIdentity,
      validationExecutableIdentity: contentIdentity("fixture-validation-executable"),
      compiledSources: request.sources.map((source) => ({
        logicalName: source.logicalName,
        identity: source.identity
      })),
      steps: [
        {
          operation: "compiler_version",
          commandRole: "compiler",
          commandIdentity: executableIdentity,
          arguments: ["--version"],
          exitCode: 0,
          stdout: "clang version 99.0.0-test\n",
          stderr: ""
        },
        {
          operation: "target_probe",
          commandRole: "compiler",
          commandIdentity: executableIdentity,
          arguments: ["-dumpmachine"],
          exitCode: 0,
          stdout: `${targetTriple()}\n`,
          stderr: ""
        },
        {
          operation: "compile_and_link",
          commandRole: "compiler",
          commandIdentity: executableIdentity,
          arguments: firmwareCompileArguments(),
          exitCode: 0,
          stdout: "",
          stderr: ""
        },
        {
          operation: "validation_test",
          commandRole: "validation_executable",
          commandIdentity: contentIdentity("fixture-validation-executable"),
          arguments: [],
          exitCode: 0,
          stdout: "",
          stderr: ""
        }
      ]
    };
  }
  };
};

export const passingFirmwareTargetBuildBackend = (): FirmwareTargetBuildBackend => {
  const backendId = "arm-gnu-stm32g0b1-freestanding-v1";
  const root = path.resolve("fixtures", "arm-gnu-14.2.rel1-test-double");
  const environment = {
    LC_ALL: "C", LANG: "C", LANGUAGE: "C", NO_COLOR: "1", SOURCE_DATE_EPOCH: "0",
    TEMP: "<workspace>", TMP: "<workspace>", TMPDIR: "<workspace>",
    PATH: "<toolchain>/bin;<toolchain>/arm-none-eabi/bin",
  };
  const rolePaths: readonly [FirmwareTargetToolchainFileRole, string][] = [
    ["gcc", "bin/arm-none-eabi-gcc.exe"],
    ["cc1", "libexec/gcc/arm-none-eabi/14.2.1/cc1.exe"],
    ["assembler", "arm-none-eabi/bin/as.exe"],
    ["collect2", "libexec/gcc/arm-none-eabi/14.2.1/collect2.exe"],
    ["ld", "arm-none-eabi/bin/ld.exe"],
    ["objcopy", "bin/arm-none-eabi-objcopy.exe"],
    ["libgcc", "lib/gcc/arm-none-eabi/14.2.1/thumb/v6-m/nofp/libgcc.a"],
  ];
  const toolchainFiles = rolePaths.map(([role, relativePath]) => ({
    role,
    path: path.join(root, ...relativePath.split("/")),
    relativePath,
    identity: contentIdentity(`fixture:${role}`),
  }));
  const supportFiles = [{
    role: "support_manifest" as const,
    path: path.resolve("third_party", "stm32g0-cmsis", "manifest.json"),
    relativePath: "manifest.json",
    identity: {
      algorithm: "sha256" as const,
      digest: STM32G0_SUPPORT_MANIFEST_SHA256,
      size: STM32G0_SUPPORT_MANIFEST_SIZE,
    },
  }, ...STM32G0_SUPPORT_FILE_CLOSURE.map(({ relativePath, identity }) => ({
    role: "support_source" as const,
    path: path.resolve("third_party", "stm32g0-cmsis", ...relativePath.split("/")),
    relativePath,
    identity,
  }))];
  const embeddedFiles = FIRMWARE_TARGET_EMBEDDED_FILES;
  const configuration = {
    schemaVersion: FIRMWARE_TARGET_BUILD_CONFIGURATION_SCHEMA,
    backendId,
    requestedToolchainRoot: root,
    supportRoot: path.resolve("third_party", "stm32g0-cmsis"),
    targetTriple: "arm-none-eabi" as const,
    targetPart: "STM32G0B1CET6" as const,
    cpu: "cortex-m0plus" as const,
    floatAbi: "soft" as const,
    expectedRelease: "14.2.Rel1" as const,
    expectedGccVersion: "14.2.1" as const,
    distribution: {
      archiveName: ARM_GNU_ARCHIVE_NAME,
      officialUrl: ARM_GNU_OFFICIAL_URL,
      sha256: ARM_GNU_ARCHIVE_SHA256,
    },
    environment,
    environmentIdentity: canonicalIdentity(environment, FIRMWARE_TARGET_BUILD_ENVIRONMENT_SCHEMA),
    executionPolicy: {
      schemaVersion: FIRMWARE_EXECUTION_POLICY_SCHEMA,
      acceptedSourceOrigin: "evleda-deterministic-generator" as const,
      agentDerivedOrUntrustedSourceExecution: "deny" as const,
      osSandbox: "none" as const,
      containmentClaim: "not-contained" as const,
      executableStrategy: "verified-private-toolchain-closure" as const,
      lto: "disabled" as const,
      linkerPlugin: "disabled" as const,
    },
    resourceLimits: FIRMWARE_TARGET_RESOURCE_LIMITS,
    toolchainFiles,
    supportFiles,
    embeddedFiles,
    compileArguments: firmwareTargetCompileArguments(),
    objcopyArguments: firmwareTargetObjcopyArguments(),
    timeoutMs: 60_000,
    maxOutputBytes: 512 * 1024,
    processRunner: "evleda.bounded-process.v1" as const,
  };
  return {
    backendId,
    configuration,
    execute: async (request) => {
      const outputValues = [
        { kind: "elf" as const, logicalName: "firmware/build/evleda-stm32g0b1cet6-candidate.elf", mediaType: "application/x-elf", content: Buffer.from("fixture-elf") },
        { kind: "bin" as const, logicalName: "firmware/build/evleda-stm32g0b1cet6-candidate.bin", mediaType: "application/octet-stream", content: Buffer.from("fixture-bin") },
        { kind: "map" as const, logicalName: "firmware/build/evleda-stm32g0b1cet6-candidate.map", mediaType: "text/plain; charset=utf-8", content: Buffer.from("fixture-map") },
      ];
      return {
        schemaVersion: "evleda.firmware-target-build-result.v1",
        sourceRevisionDigest: request.sourceRevisionDigest,
        configurationIdentity: request.configurationIdentity,
        status: "pass",
        code: "FIRMWARE_TARGET_CROSS_BUILD_PASSED",
        message: "Fixture target cross-build passed.",
        backendId,
        targetTriple: "arm-none-eabi",
        gccVersion: "14.2.1",
        toolchainIdentity: canonicalIdentity({
          distribution: configuration.distribution,
          files: toolchainFiles,
          embeddedFiles,
          executionPolicy: configuration.executionPolicy,
        }, "evleda.arm-gnu-toolchain-identity.v1"),
        compiledSources: request.sources.map((source) => ({ logicalName: source.logicalName, identity: source.identity })),
        steps: [
          { operation: "gcc_version", commandRole: "gcc", commandIdentity: toolchainFiles.find((file) => file.role === "gcc")!.identity, arguments: ["--version"], exitCode: 0, stdout: "Arm GNU Toolchain 14.2.Rel1 14.2.1\n", stderr: "" },
          { operation: "target_probe", commandRole: "gcc", commandIdentity: toolchainFiles.find((file) => file.role === "gcc")!.identity, arguments: ["-dumpmachine"], exitCode: 0, stdout: "arm-none-eabi\n", stderr: "" },
          { operation: "ld_version", commandRole: "ld", commandIdentity: toolchainFiles.find((file) => file.role === "ld")!.identity, arguments: ["--version"], exitCode: 0, stdout: "2.43.1.20241119\n", stderr: "" },
          { operation: "objcopy_version", commandRole: "objcopy", commandIdentity: toolchainFiles.find((file) => file.role === "objcopy")!.identity, arguments: ["--version"], exitCode: 0, stdout: "2.43.1.20241119\n", stderr: "" },
          { operation: "compile_and_link", commandRole: "gcc", commandIdentity: toolchainFiles.find((file) => file.role === "gcc")!.identity, arguments: firmwareTargetCompileArguments(), exitCode: 0, stdout: "", stderr: "" },
          { operation: "objcopy_binary", commandRole: "objcopy", commandIdentity: toolchainFiles.find((file) => file.role === "objcopy")!.identity, arguments: firmwareTargetObjcopyArguments(), exitCode: 0, stdout: "", stderr: "" },
        ],
        outputs: outputValues.map((output) => ({ ...output, identity: contentIdentity(output.content) })),
        deploymentDisposition: "compiled-non-flashable-candidate",
        flashable: false,
        releaseAuthorized: false,
      };
    },
  };
};

export const nativeFirmwareParityReport = (
  profile: ReferenceControllerProfile,
  sourceRevisionDigest: string,
  extra: Readonly<Record<string, unknown>> = {}
): Uint8Array => {
  const model = firmwareParityMappingModel(profile);
  const nativeNetlistIdentity = contentIdentity(`fixture-netlist:${sourceRevisionDigest}`);
  return Buffer.from(
    `${JSON.stringify({
      schemaVersion: REFERENCE_KICAD_REPORT_SCHEMA,
      kind: "connectivity",
      status: "pass",
      payload: {
        schematicNetlist: nativeNetlistIdentity,
        firmwareParity: {
          schemaVersion: "evleda.kicad-firmware-parity-source.v1",
          nativeNodeLevel: true,
          sourceRevisionDigest,
          profileId: profile.profileId,
          boardRevision: profile.boardRevision,
          profileIdentity: canonicalIdentity(profile, "evleda.reference-profile.v1"),
          derivation: {
            method: "kicad-netlist-nodes-plus-pinned-mcu-capabilities",
            nativeNetlistIdentity,
            mappingModelIdentity: firmwareParityMappingModelIdentity(profile)
          },
          nativeNodes: model.pins.map((pin) => ({
            signal: pin.signal,
            reference: pin.reference,
            physicalPin: pin.physicalPin,
            mcuPin: pin.mcuPin,
            pinFunction: pin.expectedPinFunction,
            pinType: "bidirectional",
            nativeNetName: pin.nativeNetName
          })),
          pins: model.pins.map((pin) => pin.assignment),
          resources: model.resources,
          protocols: model.protocols,
          ...extra
        }
      }
    })}\n`,
    "utf8"
  );
};
