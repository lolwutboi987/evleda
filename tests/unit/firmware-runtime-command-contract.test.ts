import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import {
  NATIVE_PROCESS_LOGICAL_COMMAND_SCHEMA_VERSION,
  NATIVE_PROCESS_PLAN_V2_SCHEMA_VERSION,
  buildNativeProcessPlanV2,
  createApprovedNativeProcessContractRegistryV2,
  validateNativeProcessPlanV2,
} from "../../src/domain/native-process-plan.js";
import type {
  NativeProcessLogicalCommandV1,
  NativeProcessPathRefV1,
  NativeProcessPlanV2,
} from "../../src/domain/types.js";
import { runBoundedProcess } from "../../src/integrations/bounded-process.js";
import {
  FIRMWARE_RUNTIME_BOUND_INPUT_CLOSURE_SCHEMA_VERSION,
  FIRMWARE_RUNTIME_COMMAND_IDS,
  FIRMWARE_RUNTIME_COMMAND_CONTRACT_SCHEMA_VERSION,
  FIRMWARE_RUNTIME_STREAM_LIMIT_BYTES,
  FIRMWARE_RUNTIME_TIMEOUT_MS,
  assertApprovedFirmwareRuntimeCommandPlanV2,
  buildFirmwareRuntimeBoundInputClosureV1,
  buildFirmwareRuntimeCommandContractV1,
  buildFirmwareRuntimeCommandPlanV2,
  buildFirmwareRuntimeToolEvidenceV1,
  createApprovedFirmwareRuntimeContractValidatorV2,
  type FirmwareRuntimeProbeCaptureV1,
} from "../../src/integrations/firmware-runtime-command-contract.js";
import {
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
  createArmGnuFirmwareTargetBuildBackend,
  firmwareTargetEmbeddedFileSnapshots,
} from "../../src/integrations/firmware-target-builder.js";
import type { FirmwareTargetBuildBackendConfiguration } from "../../src/workflow/contracts.js";

const fixtureToolPaths = {
  gcc: "bin/arm-none-eabi-gcc.exe",
  cc1: "libexec/gcc/arm-none-eabi/14.2.1/cc1.exe",
  assembler: "arm-none-eabi/bin/as.exe",
  collect2: "libexec/gcc/arm-none-eabi/14.2.1/collect2.exe",
  ld: "arm-none-eabi/bin/ld.exe",
  objcopy: "bin/arm-none-eabi-objcopy.exe",
  libgcc: "lib/gcc/arm-none-eabi/14.2.1/thumb/v6-m/nofp/libgcc.a",
} as const;

const fixtureConfiguration = (hostMarker = "host-a"): FirmwareTargetBuildBackendConfiguration => {
  const environment = {
    LC_ALL: "C",
    LANG: "C",
    LANGUAGE: "C",
    NO_COLOR: "1",
    SOURCE_DATE_EPOCH: "0",
    TEMP: "<workspace>",
    TMP: "<workspace>",
    TMPDIR: "<workspace>",
    PATH: "<toolchain>/bin;<toolchain>/arm-none-eabi/bin",
    SystemRoot: `C:\\${hostMarker}\\Windows`,
    WINDIR: `C:\\${hostMarker}\\Windows`,
  };
  return {
    schemaVersion: "evleda.firmware-target-build-backend-config.v1",
    backendId: "arm-gnu-stm32g0b1-freestanding-v1",
    requestedToolchainRoot: `C:\\${hostMarker}\\arm-gnu`,
    supportRoot: `C:\\${hostMarker}\\support`,
    targetTriple: "arm-none-eabi",
    targetPart: "STM32G0B1CET6",
    cpu: "cortex-m0plus",
    floatAbi: "soft",
    expectedRelease: ARM_GNU_TOOLCHAIN_RELEASE,
    expectedGccVersion: ARM_GNU_GCC_VERSION,
    distribution: {
      archiveName: ARM_GNU_ARCHIVE_NAME,
      officialUrl: ARM_GNU_OFFICIAL_URL,
      sha256: ARM_GNU_ARCHIVE_SHA256,
    },
    environment,
    environmentIdentity: canonicalIdentity(environment, "evleda.firmware-target-build-environment.v1"),
    executionPolicy: {
      schemaVersion: "evleda.firmware-execution-policy.v1",
      acceptedSourceOrigin: "evleda-deterministic-generator",
      agentDerivedOrUntrustedSourceExecution: "deny",
      osSandbox: "none",
      containmentClaim: "not-contained",
      executableStrategy: "verified-private-toolchain-closure",
      lto: "disabled",
      linkerPlugin: "disabled",
    },
    resourceLimits: FIRMWARE_TARGET_RESOURCE_LIMITS,
    toolchainFiles: Object.entries(fixtureToolPaths).map(([role, relativePath]) => ({
      role: role as keyof typeof fixtureToolPaths,
      path: `C:\\${hostMarker}\\arm-gnu\\${relativePath.replaceAll("/", "\\")}`,
      relativePath,
      identity: contentIdentity(`firmware-tool:${role}`),
    })),
    supportFiles: [
      {
        role: "support_manifest" as const,
        path: `C:\\${hostMarker}\\support\\manifest.json`,
        relativePath: "manifest.json",
        identity: {
          algorithm: "sha256" as const,
          digest: STM32G0_SUPPORT_MANIFEST_SHA256,
          size: STM32G0_SUPPORT_MANIFEST_SIZE,
        },
      },
      ...STM32G0_SUPPORT_FILE_CLOSURE.map((file) => ({
        role: "support_source" as const,
        path: `C:\\${hostMarker}\\support\\${file.relativePath.replaceAll("/", "\\")}`,
        relativePath: file.relativePath,
        identity: file.identity,
      })),
    ],
    embeddedFiles: FIRMWARE_TARGET_EMBEDDED_FILES,
    compileArguments: ["-fno-lto", "-fno-use-linker-plugin"],
    objcopyArguments: ["-O", "binary", "candidate.elf", "candidate.bin"],
    timeoutMs: FIRMWARE_RUNTIME_TIMEOUT_MS,
    maxOutputBytes: FIRMWARE_RUNTIME_STREAM_LIMIT_BYTES,
    processRunner: "evleda.bounded-process.v1",
  };
};

const capture = (stdout: string, stderr = "", exitCode = 0): FirmwareRuntimeProbeCaptureV1 => ({
  exitCode,
  stdout: Buffer.from(stdout, "utf8"),
  stderr: Buffer.from(stderr, "utf8"),
});

const fixtureToolEvidence = () =>
  buildFirmwareRuntimeToolEvidenceV1({
    gccVersion: capture("arm-none-eabi-gcc (Arm GNU Toolchain 14.2.Rel1) 14.2.1 20241119\n"),
    gccTarget: capture("arm-none-eabi\n"),
    gccHelp: capture("Usage: arm-none-eabi-gcc [options] file\n --help\n --version\n"),
    objcopyVersion: capture("GNU objcopy (Arm GNU Toolchain 14.2.Rel1) 2.43.1.20241119\n"),
    objcopyHelp: capture("Usage: arm-none-eabi-objcopy [options]\n --output-target\n"),
  });

const fixtureContract = () => {
  const configuration = fixtureConfiguration();
  const evidence = fixtureToolEvidence();
  return buildFirmwareRuntimeCommandContractV1({
    closure: buildFirmwareRuntimeBoundInputClosureV1(configuration, evidence),
  });
};

const rebindLogicalPlan = (
  plan: NativeProcessPlanV2,
  mutate: (command: Omit<NativeProcessLogicalCommandV1, "commandIdentity">) =>
    Omit<NativeProcessLogicalCommandV1, "commandIdentity">,
  profileOperation?: "compile" | "link" | "objcopy",
): NativeProcessPlanV2 => {
  if (plan.command.kind !== "native_process_logical_command_v1") throw new Error("fixture kind");
  const { commandIdentity: _commandIdentity, ...commandPreimage } = plan.command.value;
  const changedCommandPreimage = mutate(commandPreimage);
  const changedCommand = {
    ...changedCommandPreimage,
    commandIdentity: canonicalIdentity(
      changedCommandPreimage,
      NATIVE_PROCESS_LOGICAL_COMMAND_SCHEMA_VERSION,
    ) as NativeProcessLogicalCommandV1["commandIdentity"],
  };
  const { planIdentity: _planIdentity, ...planDraft } = plan;
  if (planDraft.profile.domain !== "firmware") throw new Error("fixture domain");
  return buildNativeProcessPlanV2({
    ...planDraft,
    profile: profileOperation === undefined
      ? planDraft.profile
      : { ...planDraft.profile, operation: profileOperation },
    command: { kind: "native_process_logical_command_v1", value: changedCommand },
    expectedOutputs: changedCommand.expectedOutputs.map((output, index) => ({
      schemaVersion: "evleda.native-process-expected-output.v1",
      path: output,
      maxBytes: plan.expectedOutputs[index]?.maxBytes ?? 1,
    })),
  });
};

describe("firmware runtime native-process command contract", () => {
  it("approves the exact five compile, link, and objcopy candidate plans", () => {
    const contract = fixtureContract();
    const registry = createApprovedNativeProcessContractRegistryV2([
      createApprovedFirmwareRuntimeContractValidatorV2(contract),
    ]);
    expect(contract.contractIdentity.schemaVersion).toBe(FIRMWARE_RUNTIME_COMMAND_CONTRACT_SCHEMA_VERSION);
    expect(contract.boundInputClosure.closureIdentity.schemaVersion)
      .toBe(FIRMWARE_RUNTIME_BOUND_INPUT_CLOSURE_SCHEMA_VERSION);
    expect(contract.disposition).toEqual({
      lifecycle: "candidate",
      deployment: "compiled-non-flashable-candidate",
      flashable: false,
      releaseAuthorized: false,
      physicalQualification: "not_run",
    });
    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.commands.compile_board_contract.argv)).toBe(true);

    for (const commandId of FIRMWARE_RUNTIME_COMMAND_IDS) {
      const plan = buildFirmwareRuntimeCommandPlanV2({ contract, commandId });
      expect(registry.assertApproved(plan)).toEqual(plan);
      expect(plan.acceptedExitCodes).toEqual([0]);
      expect(plan.timeoutMs).toBe(FIRMWARE_RUNTIME_TIMEOUT_MS);
      expect(plan.maxStdoutBytes).toBe(FIRMWARE_RUNTIME_STREAM_LIMIT_BYTES);
      expect(plan.maxStderrBytes).toBe(FIRMWARE_RUNTIME_STREAM_LIMIT_BYTES);
      expect(plan.inputPolicy).toEqual({
        schemaVersion: "evleda.native-process-input-policy.v1",
        snapshot: "immutable_before_spawn",
        mutation: "immutable",
        evaluatedInput: "command_input",
      });
      expect(plan.profile.operation).toBe(contract.commands[commandId].operation);
      expect(plan.command.value.expectedOutputs).toEqual(contract.commands[commandId].expectedOutputs);
      expect(plan.expectedOutputs).toEqual(
        contract.commands[commandId].outputByteLimits.map((limit) => ({
          schemaVersion: "evleda.native-process-expected-output.v1",
          path: limit.output,
          maxBytes: limit.maximumBytes,
        })),
      );
    }

    expect(FIRMWARE_RUNTIME_COMMAND_IDS.filter((id) => contract.commands[id].operation === "compile"))
      .toHaveLength(5);
    expect(contract.commands.link_candidate.expectedOutputs.map((entry) => entry.relativePath))
      .toEqual([
        "firmware/build/evleda-stm32g0b1cet6-candidate.elf",
        "firmware/build/evleda-stm32g0b1cet6-candidate.map",
      ]);
    expect(contract.commands.objcopy_candidate.expectedOutputs[0]?.relativePath)
      .toBe("firmware/build/evleda-stm32g0b1cet6-candidate.bin");
  });

  it("rejects self-consistent substitutions outside the approved argv and operation matrix", () => {
    const contract = fixtureContract();
    const registry = createApprovedNativeProcessContractRegistryV2([
      createApprovedFirmwareRuntimeContractValidatorV2(contract),
    ]);
    const valid = buildFirmwareRuntimeCommandPlanV2({
      contract,
      commandId: "compile_board_contract",
    });
    const changedOptimization = rebindLogicalPlan(valid, (command) => ({
      ...command,
      argv: command.argv.map((argument) =>
        argument.kind === "literal" && argument.value === "-Os"
          ? { kind: "literal" as const, value: "-O2" }
          : argument
      ),
    }));
    expect(validateNativeProcessPlanV2(changedOptimization)).toEqual(changedOptimization);
    expect(() => registry.assertApproved(changedOptimization)).toThrowError(/exact approved/iu);

    const relabelled = rebindLogicalPlan(valid, (command) => command, "link");
    expect(validateNativeProcessPlanV2(relabelled)).toEqual(relabelled);
    expect(() => registry.assertApproved(relabelled)).toThrowError(/exact approved/iu);

    const outputPath = {
      schemaVersion: "evleda.portable-path-ref.v1" as const,
      root: "run_private" as const,
      relativePath: "firmware/build/objects/substituted.o",
    };
    const changedOutput = rebindLogicalPlan(valid, (command) => ({
      ...command,
      argv: command.argv.map((argument, index) =>
        index === command.argv.length - 1 ? { kind: "path" as const, value: outputPath } : argument
      ),
      expectedOutputs: [outputPath],
    }));
    expect(validateNativeProcessPlanV2(changedOutput)).toEqual(changedOutput);
    expect(() => assertApprovedFirmwareRuntimeCommandPlanV2(contract, changedOutput))
      .toThrowError(/exact approved/iu);

    const { planIdentity: _boundedPlanIdentity, ...boundedPlanDraft } = valid;
    const changedBound = buildNativeProcessPlanV2({
      ...boundedPlanDraft,
      expectedOutputs: boundedPlanDraft.expectedOutputs.map((descriptor, index) => ({
        ...descriptor,
        maxBytes: descriptor.maxBytes + (index === 0 ? 1 : 0),
      })),
    });
    expect(validateNativeProcessPlanV2(changedBound)).toEqual(changedBound);
    expect(() => registry.assertApproved(changedBound)).toThrowError(/exact approved/iu);

    const { contractIdentity: _contractIdentity, ...contractDraft } = contract;
    const changedCommands = {
      ...structuredClone(contract.commands),
      compile_board_contract: {
        ...structuredClone(contract.commands.compile_board_contract),
        outputByteLimits: contract.commands.compile_board_contract.outputByteLimits.map(
          (limit, index) => ({ ...limit, maximumBytes: limit.maximumBytes + (index === 0 ? 1 : 0) }),
        ),
      },
    };
    const changedContractDraft = { ...contractDraft, commands: changedCommands };
    const changedContract = {
      ...changedContractDraft,
      contractIdentity: canonicalIdentity(
        changedContractDraft,
        FIRMWARE_RUNTIME_COMMAND_CONTRACT_SCHEMA_VERSION,
      ),
    } as typeof contract;
    expect(() => createApprovedFirmwareRuntimeContractValidatorV2(changedContract))
      .toThrowError(/invalid or has changed/iu);
  });

  it("snapshots and freezes the approved contract and every published identity", () => {
    const contract = fixtureContract();
    const mutableContract = structuredClone(contract);
    const approvedPlan = buildFirmwareRuntimeCommandPlanV2({
      contract,
      commandId: "compile_board_contract",
    });
    const validator = createApprovedFirmwareRuntimeContractValidatorV2(mutableContract);
    const publishedDigest = validator.contractIdentity.digest;
    (mutableContract.boundInputClosure.tools.gcc.helpIdentity as { digest: string }).digest =
      "f".repeat(64);
    (mutableContract.contractIdentity as { digest: string }).digest = "e".repeat(64);
    expect(validator.contractIdentity.digest).toBe(publishedDigest);
    expect(Object.isFrozen(validator)).toBe(true);
    expect(Object.isFrozen(validator.contractIdentity)).toBe(true);
    expect(validator.assertApproved(approvedPlan)).toEqual(approvedPlan);
  });

  it("keeps host paths out of the bound closure while binding every file identity", () => {
    const observations = fixtureToolEvidence();
    const first = buildFirmwareRuntimeBoundInputClosureV1(
      fixtureConfiguration("host-a"),
      observations,
    );
    const second = buildFirmwareRuntimeBoundInputClosureV1(
      fixtureConfiguration("host-b"),
      observations,
    );
    expect(second).toEqual(first);
    expect(JSON.stringify(first)).not.toContain("host-a");
    expect(first.toolchainFiles).toHaveLength(7);
    expect(first.supportFiles).toHaveLength(12);
    expect(Object.isFrozen(first.toolchainFiles[0])).toBe(true);

    const changed = fixtureConfiguration("host-c");
    const changedFiles = changed.toolchainFiles.map((file) =>
      file.role === "collect2" ? { ...file, identity: contentIdentity("changed-collect2") } : file
    );
    const changedClosure = buildFirmwareRuntimeBoundInputClosureV1({
      ...changed,
      toolchainFiles: changedFiles,
    }, observations);
    expect(changedClosure.closureIdentity.digest).not.toBe(first.closureIdentity.digest);

    const missingSupport = { ...changed, supportFiles: changed.supportFiles.slice(1) };
    expect(() => buildFirmwareRuntimeBoundInputClosureV1(missingSupport, observations))
      .toThrowError(/reviewed Arm GNU closure/iu);

    expect(() => buildFirmwareRuntimeBoundInputClosureV1({
      ...changed,
      environmentIdentity: canonicalIdentity("detached", "evleda.firmware-target-build-environment.v1"),
    }, observations)).toThrowError(/reviewed Arm GNU closure/iu);

    const { closureIdentity: _closureIdentity, ...closureDraft } = changedClosure;
    const unrelatedClosureDraft = {
      ...closureDraft,
      tools: {
        ...closureDraft.tools,
        gcc: {
          ...closureDraft.tools.gcc,
          contentIdentity: contentIdentity("different-gcc"),
        },
      },
    };
    const unrelatedClosure = {
      ...unrelatedClosureDraft,
      closureIdentity: canonicalIdentity(
        unrelatedClosureDraft,
        FIRMWARE_RUNTIME_BOUND_INPUT_CLOSURE_SCHEMA_VERSION,
      ),
    } as typeof changedClosure;
    expect(() => buildFirmwareRuntimeCommandContractV1({
      closure: unrelatedClosure,
    })).toThrowError(/provisioned executable/iu);

    const detachedHelpDraft = {
      ...closureDraft,
      tools: {
        ...closureDraft.tools,
        gcc: {
          ...closureDraft.tools.gcc,
          helpIdentity: contentIdentity("detached-help-observation"),
        },
      },
    };
    const detachedHelpClosure = {
      ...detachedHelpDraft,
      closureIdentity: canonicalIdentity(
        detachedHelpDraft,
        FIRMWARE_RUNTIME_BOUND_INPUT_CLOSURE_SCHEMA_VERSION,
      ),
    } as typeof changedClosure;
    expect(() => buildFirmwareRuntimeCommandContractV1({ closure: detachedHelpClosure }))
      .toThrowError(/observations are detached/iu);
  });

  it("binds exact probe captures and rejects mismatched or mutable evidence", () => {
    const helpBytes = Buffer.from("Usage: arm-none-eabi-gcc [options]\n --version\n", "utf8");
    const evidence = buildFirmwareRuntimeToolEvidenceV1({
      gccVersion: capture("arm-none-eabi-gcc (Arm GNU Toolchain 14.2.Rel1) 14.2.1\n"),
      gccTarget: capture("arm-none-eabi\n"),
      gccHelp: { exitCode: 0, stdout: helpBytes, stderr: Buffer.alloc(0) },
      objcopyVersion: capture("GNU objcopy (Arm GNU Toolchain 14.2.Rel1) 2.43.1.20241119\n"),
      objcopyHelp: capture("objcopy --output-target\n"),
    });
    const storedHelpDigest = evidence.gcc.helpIdentity.digest;
    helpBytes.fill(0x78);
    expect(evidence.gcc.helpIdentity.digest).toBe(storedHelpDigest);
    expect(Object.isFrozen(evidence.gcc)).toBe(true);
    expect(evidence.provenance).toEqual({
      classification: "observed_non_authenticating",
      source: "caller_supplied_bounded_probe_bytes",
      executableAuthentication: false,
    });
    expect(evidence.gcc).not.toHaveProperty("contentIdentity");

    expect(() => buildFirmwareRuntimeToolEvidenceV1({
      gccVersion: capture("arm-none-eabi-gcc 14.2.1\n"),
      gccTarget: capture("arm-none-eabi\n"),
      gccHelp: capture("arm-none-eabi-gcc --version\n"),
      objcopyVersion: capture("GNU objcopy 2.43.1.20241119\n"),
      objcopyHelp: capture("objcopy --output-target\n"),
    })).toThrowError(/14\.2\.Rel1/iu);
    expect(() => buildFirmwareRuntimeToolEvidenceV1({
      ...fixtureToolEvidenceInput(),
      gccTarget: capture("x86_64-w64-mingw32\n"),
    })).toThrowError(/14\.2\.Rel1/iu);
    expect(() => buildFirmwareRuntimeToolEvidenceV1({
      ...fixtureToolEvidenceInput(),
      objcopyHelp: capture("objcopy --output-target\n", "", 1),
    })).toThrowError(/approved exit code/iu);
  });

  it("rejects unexpected fields at every nested identity and contract boundary", () => {
    const observationInput = fixtureToolEvidenceInput();
    expect(() => buildFirmwareRuntimeToolEvidenceV1({
      ...observationInput,
      unexpected: true,
    } as never)).toThrowError(/unrecognized fields/iu);
    expect(() => buildFirmwareRuntimeToolEvidenceV1({
      ...observationInput,
      gccVersion: { ...observationInput.gccVersion, unexpected: true },
    } as never)).toThrowError(/approved exit code/iu);

    const configuration = fixtureConfiguration();
    const observations = fixtureToolEvidence();
    expect(() => buildFirmwareRuntimeBoundInputClosureV1({
      ...configuration,
      releaseAuthorized: false,
    } as unknown as FirmwareTargetBuildBackendConfiguration, observations))
      .toThrowError(/target configuration contains/iu);
    expect(() => buildFirmwareRuntimeBoundInputClosureV1({
      ...configuration,
      executionPolicy: {
        ...configuration.executionPolicy,
        executableAuthentication: true,
      },
    } as unknown as FirmwareTargetBuildBackendConfiguration, observations))
      .toThrowError(/target configuration contains/iu);
    expect(() => buildFirmwareRuntimeBoundInputClosureV1({
      ...configuration,
      toolchainFiles: configuration.toolchainFiles.map((file) => file.role === "gcc"
        ? { ...file, releaseAuthorized: false }
        : file),
    } as unknown as FirmwareTargetBuildBackendConfiguration, observations))
      .toThrowError(/target configuration contains/iu);
    expect(() => buildFirmwareRuntimeBoundInputClosureV1({
      ...configuration,
      distribution: { ...configuration.distribution, unexpected: true },
    } as unknown as FirmwareTargetBuildBackendConfiguration, observations))
      .toThrowError(/target configuration contains/iu);
    expect(() => buildFirmwareRuntimeBoundInputClosureV1({
      ...configuration,
      resourceLimits: { ...configuration.resourceLimits, unexpected: 1 },
    } as unknown as FirmwareTargetBuildBackendConfiguration, observations))
      .toThrowError(/target configuration contains/iu);
    expect(() => buildFirmwareRuntimeBoundInputClosureV1({
      ...configuration,
      environment: { ...configuration.environment, UNDECLARED: "value" },
    } as unknown as FirmwareTargetBuildBackendConfiguration, observations))
      .toThrowError(/target configuration contains/iu);
    expect(() => buildFirmwareRuntimeBoundInputClosureV1({
      ...configuration,
      environmentIdentity: { ...configuration.environmentIdentity, unexpected: true },
    } as unknown as FirmwareTargetBuildBackendConfiguration, observations))
      .toThrowError(/target configuration contains/iu);
    expect(() => buildFirmwareRuntimeBoundInputClosureV1({
      ...configuration,
      supportFiles: configuration.supportFiles.map((file, index) => index === 0
        ? { ...file, unexpected: true }
        : file),
    } as unknown as FirmwareTargetBuildBackendConfiguration, observations))
      .toThrowError(/target configuration contains/iu);
    expect(() => buildFirmwareRuntimeBoundInputClosureV1({
      ...configuration,
      embeddedFiles: configuration.embeddedFiles.map((file, index) => index === 0
        ? { ...file, unexpected: true }
        : file),
    } as unknown as FirmwareTargetBuildBackendConfiguration, observations))
      .toThrowError(/target configuration contains/iu);
    const extendedArguments = [...configuration.compileArguments] as string[] & {
      releaseAuthorized?: false;
    };
    extendedArguments.releaseAuthorized = false;
    expect(() => buildFirmwareRuntimeBoundInputClosureV1({
      ...configuration,
      compileArguments: extendedArguments,
    }, observations)).toThrowError(/target configuration contains/iu);
    expect(() => buildFirmwareRuntimeBoundInputClosureV1(configuration, {
      ...observations,
      unexpected: true,
    } as never)).toThrowError(/malformed|claim executable/iu);
    expect(() => buildFirmwareRuntimeBoundInputClosureV1(configuration, {
      ...observations,
      provenance: {
        ...observations.provenance,
        claimedAuthentication: true,
      },
    } as never)).toThrowError(/malformed|claim executable/iu);
    expect(() => buildFirmwareRuntimeBoundInputClosureV1(configuration, {
      ...observations,
      gcc: { ...observations.gcc, unexpected: "field" },
    } as never)).toThrowError(/malformed|claim executable/iu);

    const configWithExtendedIdentity = {
      ...configuration,
      toolchainFiles: configuration.toolchainFiles.map((file) => file.role === "gcc"
        ? { ...file, identity: { ...file.identity, unexpected: true } }
        : file),
    } as unknown as FirmwareTargetBuildBackendConfiguration;
    expect(() => buildFirmwareRuntimeBoundInputClosureV1(
      configWithExtendedIdentity,
      observations,
    )).toThrowError(/target configuration contains/iu);

    const closure = buildFirmwareRuntimeBoundInputClosureV1(configuration, observations);
    const { closureIdentity: _closureIdentity, ...closureDraft } = closure;
    const extendedClosureDraft = { ...closureDraft, unexpected: true };
    const extendedClosure = {
      ...extendedClosureDraft,
      closureIdentity: canonicalIdentity(
        extendedClosureDraft,
        FIRMWARE_RUNTIME_BOUND_INPUT_CLOSURE_SCHEMA_VERSION,
      ),
    } as unknown as typeof closure;
    expect(() => buildFirmwareRuntimeCommandContractV1({ closure: extendedClosure }))
      .toThrowError(/unrecognized fields/iu);

    const extendedToolDraft = {
      ...closureDraft,
      tools: {
        ...closureDraft.tools,
        gcc: { ...closureDraft.tools.gcc, unexpected: true },
      },
    };
    const extendedToolClosure = {
      ...extendedToolDraft,
      closureIdentity: canonicalIdentity(
        extendedToolDraft,
        FIRMWARE_RUNTIME_BOUND_INPUT_CLOSURE_SCHEMA_VERSION,
      ),
    } as unknown as typeof closure;
    expect(() => buildFirmwareRuntimeCommandContractV1({ closure: extendedToolClosure }))
      .toThrowError(/provisioned executable/iu);

    const contract = buildFirmwareRuntimeCommandContractV1({ closure });
    expect(() => buildFirmwareRuntimeCommandContractV1({
      closure,
      unexpected: true,
    } as never)).toThrowError(/unrecognized fields/iu);
    expect(() => buildFirmwareRuntimeCommandPlanV2({
      contract,
      commandId: "compile_board_contract",
      unexpected: true,
    } as never)).toThrowError(/unrecognized fields/iu);

    const { contractIdentity: _contractIdentity, ...contractDraft } = contract;
    const extendedSpecDraft = {
      ...contractDraft,
      commands: {
        ...contractDraft.commands,
        compile_board_contract: {
          ...contractDraft.commands.compile_board_contract,
          logicalCwd: {
            ...contractDraft.commands.compile_board_contract.logicalCwd,
            unexpected: true,
          },
        },
      },
    };
    const extendedSpecContract = {
      ...extendedSpecDraft,
      contractIdentity: canonicalIdentity(
        extendedSpecDraft,
        FIRMWARE_RUNTIME_COMMAND_CONTRACT_SCHEMA_VERSION,
      ),
    } as unknown as typeof contract;
    expect(() => createApprovedFirmwareRuntimeContractValidatorV2(extendedSpecContract))
      .toThrowError(/unrecognized fields/iu);

    const extendedContractDraft = { ...contractDraft, unexpected: true };
    const extendedContract = {
      ...extendedContractDraft,
      contractIdentity: canonicalIdentity(
        extendedContractDraft,
        FIRMWARE_RUNTIME_COMMAND_CONTRACT_SCHEMA_VERSION,
      ),
    } as unknown as typeof contract;
    expect(() => createApprovedFirmwareRuntimeContractValidatorV2(extendedContract))
      .toThrowError(/unrecognized fields/iu);
  });
});

const fixtureToolEvidenceInput = () => ({
    gccVersion: capture("arm-none-eabi-gcc (Arm GNU Toolchain 14.2.Rel1) 14.2.1\n"),
    gccTarget: capture("arm-none-eabi\n"),
    gccHelp: capture("Usage: arm-none-eabi-gcc --version\n"),
    objcopyVersion: capture("GNU objcopy (Arm GNU Toolchain 14.2.Rel1) 2.43.1.20241119\n"),
    objcopyHelp: capture("objcopy --output-target\n"),
  });

const splitCandidateSources = Object.freeze([
  {
    relativePath: "firmware/include/board_contract.h",
    content: [
      "#ifndef EVLEDA_SPLIT_BUILD_BOARD_CONTRACT_H",
      "#define EVLEDA_SPLIT_BUILD_BOARD_CONTRACT_H",
      "void evl_platform_init(void);",
      "void Reset_Handler(void) __attribute__((noreturn));",
      "#endif",
      "",
    ].join("\n"),
  },
  {
    relativePath: "firmware/src/board_contract.c",
    content: [
      "#include \"board_contract.h\"",
      "void Reset_Handler(void) {",
      "  evl_platform_init();",
      "  for (;;) { __asm__ volatile (\"nop\"); }",
      "}",
      "",
    ].join("\n"),
  },
  {
    relativePath: "firmware/target/platform_stm32g0b1.c",
    content: [
      "void evl_platform_init(void);",
      "void evl_platform_init(void) {}",
      "",
    ].join("\n"),
  },
  {
    relativePath: "firmware/target/startup_stm32g0b1.s",
    content: [
      ".syntax unified",
      ".cpu cortex-m0plus",
      ".thumb",
      ".section .isr_vector,\"a\",%progbits",
      ".global g_pfnVectors",
      ".type g_pfnVectors, %object",
      "g_pfnVectors:",
      "  .word _estack",
      "  .word Reset_Handler",
      ".size g_pfnVectors, .-g_pfnVectors",
      "",
    ].join("\n"),
  },
  {
    relativePath: "firmware/target/STM32G0B1CET6.ld",
    content: [
      "ENTRY(Reset_Handler)",
      "MEMORY",
      "{",
      "  FLASH (rx)  : ORIGIN = 0x08000000, LENGTH = 512K",
      "  RAM   (rwx) : ORIGIN = 0x20000000, LENGTH = 144K",
      "}",
      "_estack = ORIGIN(RAM) + LENGTH(RAM);",
      "SECTIONS",
      "{",
      "  .isr_vector : { KEEP(*(.isr_vector)) } > FLASH",
      "  .text : { *(.text*) *(.rodata*) } > FLASH",
      "  .preinit_array : { __preinit_array_start = .; KEEP(*(.preinit_array*)) __preinit_array_end = .; } > FLASH",
      "  .init_array : { __init_array_start = .; KEEP(*(.init_array*)) __init_array_end = .; } > FLASH",
      "  .data : { _sdata = .; *(.data*) _edata = .; } > RAM AT> FLASH",
      "  _sidata = LOADADDR(.data);",
      "  .bss (NOLOAD) : { _sbss = .; *(.bss*) *(COMMON) _ebss = .; } > RAM",
      "  /DISCARD/ : { *(.comment*) *(.note*) }",
      "}",
      "",
    ].join("\n"),
  },
] as const);

const stableBytes = async (filePath: string): Promise<Buffer> => {
  const first = await lstat(filePath);
  if (!first.isFile() || first.isSymbolicLink() || first.size <= 0) {
    throw new Error(`Expected an ordinary non-empty file: ${filePath}`);
  }
  const bytes = await readFile(filePath);
  const second = await lstat(filePath);
  if (first.size !== second.size || first.mtimeMs !== second.mtimeMs ||
      first.dev !== second.dev || first.ino !== second.ino || bytes.byteLength !== first.size) {
    throw new Error(`File changed during the split-build check: ${filePath}`);
  }
  return bytes;
};

const writeIsolated = async (destination: string, bytes: Uint8Array): Promise<void> => {
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { flag: "wx" });
};

const within = (root: string, relativePath: string): string => {
  const result = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(root, result);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Logical firmware path escaped its isolated root.");
  }
  return result;
};

const materializeSplitCandidateInputs = async (
  root: string,
  configuration: FirmwareTargetBuildBackendConfiguration,
): Promise<void> => {
  const runInput = path.join(root, "run_input");
  for (const source of splitCandidateSources) {
    await writeIsolated(within(runInput, source.relativePath), Buffer.from(source.content, "utf8"));
  }
  for (const support of configuration.supportFiles) {
    const bytes = await stableBytes(support.path);
    expect(contentIdentity(bytes)).toEqual(support.identity);
    await writeIsolated(within(runInput, `firmware/support/${support.relativePath}`), bytes);
  }
  for (const embedded of firmwareTargetEmbeddedFileSnapshots()) {
    expect(contentIdentity(embedded.content)).toEqual(embedded.identity);
    await writeIsolated(within(runInput, `firmware/${embedded.logicalPath}`), embedded.content);
  }
  const libgcc = configuration.toolchainFiles.find((file) => file.role === "libgcc")!;
  const libgccBytes = await stableBytes(libgcc.path);
  expect(contentIdentity(libgccBytes)).toEqual(libgcc.identity);
  await writeIsolated(
    within(runInput, `firmware/toolchain/${libgcc.relativePath}`),
    libgccBytes,
  );
};

const resolvePlanPath = (
  root: string,
  value: NativeProcessPathRefV1,
): string => {
  if (value.root !== "run_input" && value.root !== "run_private") {
    throw new Error("Split firmware checks accept only isolated input and private roots.");
  }
  return within(path.join(root, value.root), value.relativePath);
};

const splitProcessEnvironment = (
  plan: NativeProcessPlanV2,
  root: string,
  toolchainRoot: string,
): Readonly<Record<string, string>> => {
  if (plan.command.kind !== "native_process_logical_command_v1") throw new Error("logical command required");
  const environment: Record<string, string> = Object.fromEntries(
    plan.command.value.environment.fixed.map((entry) => [
      entry.name,
      entry.value.replaceAll("<toolchain>", toolchainRoot),
    ]),
  );
  const privateTemp = path.join(root, "temp");
  for (const field of plan.command.value.environment.privateRuntime) {
    const value = field.name === "TEMP" || field.name === "TMP" || field.name === "TMPDIR"
      ? privateTemp
      : field.name === "SYSTEMROOT"
        ? process.env.SystemRoot ?? process.env.WINDIR
        : process.env.WINDIR ?? process.env.SystemRoot;
    if (value !== undefined) environment[field.name] = value;
  }
  return Object.freeze(environment);
};

const executeSevenSplitPlans = async (
  contract: ReturnType<typeof fixtureContract>,
  configuration: FirmwareTargetBuildBackendConfiguration,
  root: string,
): Promise<Readonly<Record<"elf" | "map" | "bin", ReturnType<typeof contentIdentity>>>> => {
  await materializeSplitCandidateInputs(root, configuration);
  await mkdir(path.join(root, "temp"), { recursive: true });
  const registry = createApprovedNativeProcessContractRegistryV2([
    createApprovedFirmwareRuntimeContractValidatorV2(contract),
  ]);
  const gcc = configuration.toolchainFiles.find((file) => file.role === "gcc")!;
  const objcopy = configuration.toolchainFiles.find((file) => file.role === "objcopy")!;
  const toolchainRoot = configuration.requestedToolchainRoot;
  if (toolchainRoot === null) throw new Error("Configured toolchain root required");
  let executed = 0;
  for (const commandId of FIRMWARE_RUNTIME_COMMAND_IDS) {
    const plan = registry.assertApproved(buildFirmwareRuntimeCommandPlanV2({ contract, commandId }));
    if (plan.command.kind !== "native_process_logical_command_v1") throw new Error("logical command required");
    const cwd = resolvePlanPath(root, plan.command.value.logicalCwd);
    await mkdir(cwd, { recursive: true });
    for (const expected of plan.expectedOutputs) {
      await mkdir(path.dirname(resolvePlanPath(root, expected.path)), { recursive: true });
    }
    const executable = plan.tool.name === "arm-none-eabi-gcc" ? gcc : objcopy;
    expect(contentIdentity(await stableBytes(executable.path))).toEqual(plan.tool.contentIdentity);
    const args = plan.command.value.argv.map((argument) => argument.kind === "literal"
      ? argument.value
      : path.relative(cwd, resolvePlanPath(root, argument.value))
    );
    const result = await runBoundedProcess({
      command: executable.path,
      args,
      cwd,
      env: splitProcessEnvironment(plan, root, toolchainRoot),
      timeoutMs: plan.timeoutMs,
      maxOutputBytes: Math.max(plan.maxStdoutBytes, plan.maxStderrBytes),
    });
    expect(
      plan.acceptedExitCodes,
      `${commandId} exited ${result.exitCode}: ${result.stderr}\n${result.stdout}`,
    ).toContain(result.exitCode);
    for (const expected of plan.expectedOutputs) {
      const outputBytes = await stableBytes(resolvePlanPath(root, expected.path));
      expect(outputBytes.byteLength).toBeLessThanOrEqual(expected.maxBytes);
    }
    executed += 1;
  }
  expect(executed).toBe(7);
  const artifact = async (name: string) => contentIdentity(await stableBytes(within(
    path.join(root, "run_private"),
    `firmware/build/evleda-stm32g0b1cet6-candidate.${name}`,
  )));
  return Object.freeze({
    elf: await artifact("elf"),
    map: await artifact("map"),
    bin: await artifact("bin"),
  });
};

const configuredArmRoot = process.env.EVLEDA_ARM_GCC_ROOT;
it.skipIf(configuredArmRoot === undefined)(
  "binds the recovered Arm GNU tool bytes and live capability captures",
  async () => {
    const backend = await createArmGnuFirmwareTargetBuildBackend({
      toolchainRoot: configuredArmRoot!,
      environment: process.env,
      ...(process.env.EVLEDA_FIRMWARE_BUILD_ROOT === undefined
        ? {}
        : { temporaryRoot: process.env.EVLEDA_FIRMWARE_BUILD_ROOT }),
    });
    const configuration = backend.configuration;
    const gcc = configuration.toolchainFiles.find((file) => file.role === "gcc")!;
    const objcopy = configuration.toolchainFiles.find((file) => file.role === "objcopy")!;
    const inheritedEnvironment = Object.freeze(Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ));
    const probe = async (command: string, args: readonly string[]): Promise<FirmwareRuntimeProbeCaptureV1> => {
      const result = await runBoundedProcess({
        command,
        args,
        cwd: path.resolve(configuredArmRoot!),
        env: inheritedEnvironment,
        timeoutMs: 30_000,
        maxOutputBytes: FIRMWARE_RUNTIME_STREAM_LIMIT_BYTES,
      });
      return capture(result.stdout, result.stderr, result.exitCode);
    };
    const evidence = buildFirmwareRuntimeToolEvidenceV1({
      gccVersion: await probe(gcc.path, ["--version"]),
      gccTarget: await probe(gcc.path, ["-dumpmachine"]),
      gccHelp: await probe(gcc.path, ["--help"]),
      objcopyVersion: await probe(objcopy.path, ["--version"]),
      objcopyHelp: await probe(objcopy.path, ["--help"]),
    });
    const closure = buildFirmwareRuntimeBoundInputClosureV1(configuration, evidence);
    const contract = buildFirmwareRuntimeCommandContractV1({
      closure,
    });
    const registry = createApprovedNativeProcessContractRegistryV2([
      createApprovedFirmwareRuntimeContractValidatorV2(contract),
    ]);
    expect(JSON.stringify(contract)).not.toContain(path.resolve(configuredArmRoot!));
    expect(JSON.stringify(contract)).not.toContain(configuration.supportRoot);
    for (const commandId of FIRMWARE_RUNTIME_COMMAND_IDS) {
      expect(registry.assertApproved(
        buildFirmwareRuntimeCommandPlanV2({ contract, commandId }),
      ).planIdentity.schemaVersion).toBe(NATIVE_PROCESS_PLAN_V2_SCHEMA_VERSION);
    }
    expect(closure.tools.gcc.contentIdentity).toEqual(contentIdentity(await readFile(gcc.path)));
    expect(closure.tools.objcopy.contentIdentity).toEqual(contentIdentity(await readFile(objcopy.path)));
    const buildRoot = path.resolve(process.env.EVLEDA_FIRMWARE_BUILD_ROOT ?? path.join(
      tmpdir(),
      "evleda-firmware-command-contract",
    ));
    await mkdir(buildRoot, { recursive: true });
    const firstRoot = await mkdtemp(path.join(buildRoot, "split-run-a-"));
    const secondRoot = await mkdtemp(path.join(buildRoot, "split-run-b-"));
    try {
      const firstOutputs = await executeSevenSplitPlans(contract, configuration, firstRoot);
      const secondOutputs = await executeSevenSplitPlans(contract, configuration, secondRoot);
      expect(secondOutputs).toEqual(firstOutputs);
    } finally {
      await rm(firstRoot, { recursive: true, force: true });
      await rm(secondRoot, { recursive: true, force: true });
    }
  },
  120_000,
);
