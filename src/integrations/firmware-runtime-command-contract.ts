import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import { DomainError } from "../domain/errors.js";
import {
  NATIVE_PROCESS_LOGICAL_COMMAND_SCHEMA_VERSION,
  NATIVE_PROCESS_PLAN_V2_SCHEMA_VERSION,
  acceptedExitCodesForNativeProcessProfile,
  buildNativeProcessPlanV2,
  validateNativeProcessPlanV2,
  type ApprovedNativeProcessContractValidatorV2,
} from "../domain/native-process-plan.js";
import type {
  CanonicalIdentity,
  ContentIdentity,
  NativeProcessCommandArgumentV1,
  NativeProcessEnvironmentV1,
  NativeProcessLogicalCommandV1,
  NativeProcessPathRefV1,
  NativeProcessPlanV2,
  NativeProcessToolV1,
} from "../domain/types.js";
import type { FirmwareTargetBuildBackendConfiguration } from "../workflow/contracts.js";
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
} from "./firmware-target-builder.js";

export const FIRMWARE_RUNTIME_COMMAND_CONTRACT_SCHEMA_VERSION =
  "evleda.firmware-runtime-command-contract.v1" as const;
export const FIRMWARE_RUNTIME_BOUND_INPUT_CLOSURE_SCHEMA_VERSION =
  "evleda.firmware-runtime-bound-input-closure.v1" as const;
export const FIRMWARE_RUNTIME_TOOL_PROBE_MANIFEST_SCHEMA_VERSION =
  "evleda.firmware-runtime-tool-probe-manifest.v1" as const;
export const FIRMWARE_RUNTIME_TIMEOUT_MS = 60_000;
export const FIRMWARE_RUNTIME_STREAM_LIMIT_BYTES = 512 * 1024;

export const FIRMWARE_RUNTIME_COMMAND_IDS = Object.freeze([
  "compile_board_contract",
  "compile_platform",
  "compile_startup",
  "compile_system",
  "compile_runtime",
  "link_candidate",
  "objcopy_candidate",
] as const);

export type FirmwareRuntimeCommandIdV1 = (typeof FIRMWARE_RUNTIME_COMMAND_IDS)[number];
export type FirmwareRuntimeOperationV1 = "compile" | "link" | "objcopy";
export type FirmwareRuntimeToolRoleV1 = "gcc" | "objcopy";

export interface FirmwareRuntimeProbeCaptureV1 {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

export interface FirmwareRuntimeToolEvidenceInputV1 {
  readonly gccVersion: FirmwareRuntimeProbeCaptureV1;
  readonly gccTarget: FirmwareRuntimeProbeCaptureV1;
  readonly gccHelp: FirmwareRuntimeProbeCaptureV1;
  readonly objcopyVersion: FirmwareRuntimeProbeCaptureV1;
  readonly objcopyHelp: FirmwareRuntimeProbeCaptureV1;
}

export interface FirmwareRuntimeObservedToolV1 {
  readonly schemaVersion: "evleda.firmware-runtime-observed-tool.v1";
  readonly name: "arm-none-eabi-gcc" | "arm-none-eabi-objcopy";
  readonly version: "14.2.1" | "2.43.1.20241119";
  readonly capabilitiesIdentity: ContentIdentity;
  readonly helpIdentity: ContentIdentity;
}

export interface FirmwareRuntimeToolEvidenceV1 {
  readonly schemaVersion: "evleda.firmware-runtime-tool-evidence.v1";
  readonly provenance: {
    readonly classification: "observed_non_authenticating";
    readonly source: "caller_supplied_bounded_probe_bytes";
    readonly executableAuthentication: false;
  };
  readonly gcc: FirmwareRuntimeObservedToolV1;
  readonly objcopy: FirmwareRuntimeObservedToolV1;
}

export interface FirmwareRuntimeBoundInputClosureV1 {
  readonly schemaVersion: typeof FIRMWARE_RUNTIME_BOUND_INPUT_CLOSURE_SCHEMA_VERSION;
  readonly target: {
    readonly triple: "arm-none-eabi";
    readonly part: "STM32G0B1CET6";
    readonly cpu: "cortex-m0plus";
    readonly floatAbi: "soft";
  };
  readonly distribution: {
    readonly release: typeof ARM_GNU_TOOLCHAIN_RELEASE;
    readonly gccVersion: typeof ARM_GNU_GCC_VERSION;
    readonly archiveName: typeof ARM_GNU_ARCHIVE_NAME;
    readonly officialUrl: string;
    readonly sha256: string;
  };
  readonly executionPolicy: {
    readonly sourceOrigin: "evleda-deterministic-generator";
    readonly lto: "disabled";
    readonly linkerPlugin: "disabled";
    readonly containmentClaim: "not-contained";
  };
  readonly resourceLimits: typeof FIRMWARE_TARGET_RESOURCE_LIMITS;
  readonly toolchainFiles: readonly {
    readonly role: string;
    readonly relativePath: string;
    readonly identity: ContentIdentity;
  }[];
  readonly supportFiles: readonly {
    readonly role: "support_manifest" | "support_source";
    readonly relativePath: string;
    readonly identity: ContentIdentity;
  }[];
  readonly embeddedFiles: typeof FIRMWARE_TARGET_EMBEDDED_FILES;
  readonly observedProbeEvidence: FirmwareRuntimeToolEvidenceV1;
  readonly tools: {
    readonly gcc: NativeProcessToolV1;
    readonly objcopy: NativeProcessToolV1;
  };
  readonly closureIdentity: CanonicalIdentity & {
    readonly schemaVersion: typeof FIRMWARE_RUNTIME_BOUND_INPUT_CLOSURE_SCHEMA_VERSION;
  };
}

export interface FirmwareRuntimeCommandSpecV1 {
  readonly operation: FirmwareRuntimeOperationV1;
  readonly toolRole: FirmwareRuntimeToolRoleV1;
  readonly logicalCwd: NativeProcessPathRefV1;
  readonly argv: readonly NativeProcessCommandArgumentV1[];
  readonly expectedOutputs: readonly NativeProcessPathRefV1[];
  readonly outputByteLimits: readonly {
    readonly output: NativeProcessPathRefV1;
    readonly maximumBytes: number;
  }[];
}

export interface FirmwareRuntimeCommandContractV1 {
  readonly schemaVersion: typeof FIRMWARE_RUNTIME_COMMAND_CONTRACT_SCHEMA_VERSION;
  readonly boundInputClosure: FirmwareRuntimeBoundInputClosureV1;
  readonly target: FirmwareRuntimeBoundInputClosureV1["target"];
  readonly environment: NativeProcessEnvironmentV1;
  readonly timeoutMs: typeof FIRMWARE_RUNTIME_TIMEOUT_MS;
  readonly maxStdoutBytes: typeof FIRMWARE_RUNTIME_STREAM_LIMIT_BYTES;
  readonly maxStderrBytes: typeof FIRMWARE_RUNTIME_STREAM_LIMIT_BYTES;
  readonly commands: Readonly<Record<FirmwareRuntimeCommandIdV1, FirmwareRuntimeCommandSpecV1>>;
  readonly disposition: {
    readonly lifecycle: "candidate";
    readonly deployment: "compiled-non-flashable-candidate";
    readonly flashable: false;
    readonly releaseAuthorized: false;
    readonly physicalQualification: "not_run";
  };
  readonly contractIdentity: CanonicalIdentity & {
    readonly schemaVersion: typeof FIRMWARE_RUNTIME_COMMAND_CONTRACT_SCHEMA_VERSION;
  };
}

const exactToolchainFiles = Object.freeze({
  gcc: "bin/arm-none-eabi-gcc.exe",
  cc1: "libexec/gcc/arm-none-eabi/14.2.1/cc1.exe",
  assembler: "arm-none-eabi/bin/as.exe",
  collect2: "libexec/gcc/arm-none-eabi/14.2.1/collect2.exe",
  ld: "arm-none-eabi/bin/ld.exe",
  objcopy: "bin/arm-none-eabi-objcopy.exe",
  libgcc: "lib/gcc/arm-none-eabi/14.2.1/thumb/v6-m/nofp/libgcc.a",
} as const);

const deepFreeze = <Value>(value: Value, seen = new WeakSet<object>()): Value => {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
};

const fail = (message: string, details: Readonly<Record<string, unknown>> = {}): never => {
  throw new DomainError("ARTIFACT_INTEGRITY_ERROR", message, details);
};

const hasExactDataKeys = (value: unknown, expectedKeys: readonly string[]): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string") || keys.length !== expectedKeys.length) return false;
    const actual = (keys as string[]).slice().sort();
    const expected = [...expectedKeys].sort();
    if (actual.some((key, index) => key !== expected[index])) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return expected.every((key) => {
      const descriptor = descriptors[key];
      return descriptor !== undefined && descriptor.enumerable === true &&
        descriptor.get === undefined && descriptor.set === undefined && "value" in descriptor;
    });
  } catch {
    return false;
  }
};

const isClosedArray = (value: unknown): value is readonly unknown[] => {
  if (!Array.isArray(value)) return false;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
    const keys = Reflect.ownKeys(value);
    const expected = [...value.keys()].map(String).concat("length");
    if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return expected.every((key) => {
      const descriptor = descriptors[key];
      return descriptor !== undefined && descriptor.get === undefined && descriptor.set === undefined &&
        "value" in descriptor && (key === "length" ? descriptor.enumerable === false : descriptor.enumerable === true);
    });
  } catch {
    return false;
  }
};

const isContentIdentity = (value: unknown): value is ContentIdentity => {
  if (!hasExactDataKeys(value, ["algorithm", "digest", "size"])) return false;
  const identity = value as Partial<ContentIdentity>;
  return identity.algorithm === "sha256" &&
    typeof identity.digest === "string" && /^[0-9a-f]{64}$/u.test(identity.digest) &&
    Number.isSafeInteger(identity.size) && (identity.size ?? -1) >= 0;
};

const isCanonicalIdentity = (value: unknown, schemaVersion?: string): value is CanonicalIdentity => {
  if (!hasExactDataKeys(value, [
    "algorithm", "digest", "schemaVersion", "canonicalizationVersion",
  ])) return false;
  const identity = value as Partial<CanonicalIdentity>;
  return identity.algorithm === "sha256" &&
    typeof identity.digest === "string" && /^[0-9a-f]{64}$/u.test(identity.digest) &&
    typeof identity.schemaVersion === "string" &&
    (schemaVersion === undefined || identity.schemaVersion === schemaVersion) &&
    identity.canonicalizationVersion === "evleda-c14n-json-v1";
};

const safeRelativePath = (value: string): boolean =>
  value.length > 0 && value.length <= 1024 && /^[\x20-\x7e]+$/u.test(value) &&
  !/[\\:?%#<>|"*]/u.test(value) && !value.startsWith("/") &&
  value.split("/").every((part) =>
    part.length > 0 && part.length <= 128 && part !== "." && part !== ".." &&
    !part.endsWith(".") && !part.endsWith(" ") &&
    !/^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9]|LPT[1-9])(?:\..*)?$/iu.test(part)
  );

const capturedBytes = (value: Uint8Array, field: string): Buffer => {
  if (!(value instanceof Uint8Array) || value.byteLength > FIRMWARE_RUNTIME_STREAM_LIMIT_BYTES) {
    fail("Firmware tool probe capture exceeds its byte limit.", { field });
  }
  return Buffer.from(value);
};

const captureRecord = (
  tool: FirmwareRuntimeToolRoleV1,
  argv: readonly string[],
  value: FirmwareRuntimeProbeCaptureV1,
): { readonly record: unknown; readonly text: string } => {
  if (!hasExactDataKeys(value, ["exitCode", "stdout", "stderr"]) || value.exitCode !== 0) {
    fail("Firmware tool capability probes must complete with the approved exit code.", {
      tool,
      argv,
      exitCode: value.exitCode,
    });
  }
  const stdout = capturedBytes(value.stdout, `${tool}:${argv.join(" ")}:stdout`);
  const stderr = capturedBytes(value.stderr, `${tool}:${argv.join(" ")}:stderr`);
  let text = "";
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    text = `${decoder.decode(stdout)}\n${decoder.decode(stderr)}`;
  } catch {
    fail("Firmware tool probe output must be valid UTF-8.", { tool, argv });
  }
  return {
    record: {
      schemaVersion: "evleda.firmware-runtime-tool-probe-capture.v1",
      tool,
      argv: [...argv],
      acceptedExitCodes: [0],
      exitCode: value.exitCode,
      stdoutIdentity: contentIdentity(stdout),
      stderrIdentity: contentIdentity(stderr),
    },
    text,
  };
};

const probeManifestIdentity = (
  tool: FirmwareRuntimeToolRoleV1,
  captures: readonly { readonly record: unknown }[],
): ContentIdentity => contentIdentity(Buffer.from(`${canonicalJson({
  schemaVersion: FIRMWARE_RUNTIME_TOOL_PROBE_MANIFEST_SCHEMA_VERSION,
  tool,
  captures: captures.map((capture) => capture.record),
})}\n`, "utf8"));

const runtimeTool = (
  name: "arm-none-eabi-gcc" | "arm-none-eabi-objcopy",
  version: "14.2.1" | "2.43.1.20241119",
  executableIdentity: ContentIdentity,
  capabilitiesIdentity: ContentIdentity,
  helpIdentity: ContentIdentity,
): NativeProcessToolV1 => deepFreeze({
  schemaVersion: "evleda.tool-content-identity.v1",
  role: "runtime",
  kind: "native_executable",
  name,
  version,
  commit: "not_applicable",
  contentIdentity: structuredClone(executableIdentity),
  capabilitiesIdentity: structuredClone(capabilitiesIdentity),
  helpIdentity: structuredClone(helpIdentity),
});

/**
 * Record bounded tool observations. These caller-supplied bytes describe an
 * observed interface only: executable identity comes independently from the
 * stable-file toolchain closure and is never inferred from probe text.
 */
export const buildFirmwareRuntimeToolEvidenceV1 = (
  input: FirmwareRuntimeToolEvidenceInputV1,
): FirmwareRuntimeToolEvidenceV1 => {
  if (!hasExactDataKeys(input, [
    "gccVersion", "gccTarget", "gccHelp", "objcopyVersion", "objcopyHelp",
  ])) {
    fail("Firmware tool observation input contains unrecognized fields.");
  }
  const gccVersion = captureRecord("gcc", ["--version"], input.gccVersion);
  const gccTarget = captureRecord("gcc", ["-dumpmachine"], input.gccTarget);
  const gccHelp = captureRecord("gcc", ["--help"], input.gccHelp);
  const objcopyVersion = captureRecord("objcopy", ["--version"], input.objcopyVersion);
  const objcopyHelp = captureRecord("objcopy", ["--help"], input.objcopyHelp);

  if (!gccVersion.text.includes("Arm GNU Toolchain 14.2.Rel1") ||
      !/\b14\.2\.1\b/u.test(gccVersion.text) || gccTarget.text.trim() !== "arm-none-eabi" ||
      !gccHelp.text.includes("arm-none-eabi-gcc") || !gccHelp.text.includes("--version") ||
      !objcopyVersion.text.includes("Arm GNU Toolchain 14.2.Rel1") ||
      !objcopyVersion.text.includes("2.43.1.20241119") ||
      !objcopyHelp.text.toLowerCase().includes("objcopy") ||
      !objcopyHelp.text.includes("--output-target")) {
    fail("Firmware tool probes do not identify the approved Arm GNU 14.2.Rel1 capabilities.");
  }

  const gccCapabilitiesIdentity = probeManifestIdentity("gcc", [gccVersion, gccTarget]);
  const objcopyCapabilitiesIdentity = probeManifestIdentity("objcopy", [objcopyVersion]);
  const gccHelpIdentity = probeManifestIdentity("gcc", [gccHelp]);
  const objcopyHelpIdentity = probeManifestIdentity("objcopy", [objcopyHelp]);
  return deepFreeze({
    schemaVersion: "evleda.firmware-runtime-tool-evidence.v1",
    provenance: {
      classification: "observed_non_authenticating",
      source: "caller_supplied_bounded_probe_bytes",
      executableAuthentication: false,
    },
    gcc: {
      schemaVersion: "evleda.firmware-runtime-observed-tool.v1",
      name: "arm-none-eabi-gcc",
      version: "14.2.1",
      capabilitiesIdentity: gccCapabilitiesIdentity,
      helpIdentity: gccHelpIdentity,
    },
    objcopy: {
      schemaVersion: "evleda.firmware-runtime-observed-tool.v1",
      name: "arm-none-eabi-objcopy",
      version: "2.43.1.20241119",
      capabilitiesIdentity: objcopyCapabilitiesIdentity,
      helpIdentity: objcopyHelpIdentity,
    },
  });
};

const sortedFileProjection = <Role extends string>(files: readonly {
  readonly role: Role;
  readonly relativePath: string;
  readonly identity: ContentIdentity;
}[]): readonly { readonly role: Role; readonly relativePath: string; readonly identity: ContentIdentity }[] =>
  files.map((file) => ({
    role: file.role,
    relativePath: file.relativePath,
    identity: structuredClone(file.identity),
  })).sort((left, right) => {
    const leftKey = `${left.role}\0${left.relativePath}`;
    const rightKey = `${right.role}\0${right.relativePath}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });

const expectedSupportIdentities = (): ReadonlyMap<string, ContentIdentity> => new Map([
  ["support_manifest\0manifest.json", {
    algorithm: "sha256" as const,
    digest: STM32G0_SUPPORT_MANIFEST_SHA256,
    size: STM32G0_SUPPORT_MANIFEST_SIZE,
  }],
  ...STM32G0_SUPPORT_FILE_CLOSURE.map((file) => [
    `support_source\0${file.relativePath}`,
    file.identity,
  ] as const),
]);

const hasClosedStringArray = (value: unknown): value is readonly string[] =>
  isClosedArray(value) && value.every((entry) => typeof entry === "string");

const hasClosedConfigurationEnvironment = (value: unknown): value is Readonly<Record<string, string>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const required = [
    "LC_ALL", "LANG", "LANGUAGE", "NO_COLOR", "SOURCE_DATE_EPOCH", "TEMP", "TMP",
    "TMPDIR", "PATH",
  ];
  const optional = ["SystemRoot", "WINDIR"];
  let keys: string[];
  try {
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) return false;
    keys = ownKeys as string[];
  } catch {
    return false;
  }
  return required.every((name) => keys.includes(name)) &&
    keys.every((name) => required.includes(name) || optional.includes(name)) &&
    hasExactDataKeys(value, keys) && keys.every((name) => typeof value[name] === "string");
};

const assertClosedFirmwareTargetConfiguration = (
  configuration: FirmwareTargetBuildBackendConfiguration,
): FirmwareTargetBuildBackendConfiguration => {
  if (
    !hasExactDataKeys(configuration, [
      "schemaVersion", "backendId", "requestedToolchainRoot", "supportRoot", "targetTriple",
      "targetPart", "cpu", "floatAbi", "expectedRelease", "expectedGccVersion", "distribution",
      "environment", "environmentIdentity", "executionPolicy", "resourceLimits", "toolchainFiles",
      "supportFiles", "embeddedFiles", "compileArguments", "objcopyArguments", "timeoutMs",
      "maxOutputBytes", "processRunner",
    ]) ||
    !hasExactDataKeys(configuration.distribution, ["archiveName", "officialUrl", "sha256"]) ||
    !hasClosedConfigurationEnvironment(configuration.environment) ||
    !isCanonicalIdentity(
      configuration.environmentIdentity,
      "evleda.firmware-target-build-environment.v1",
    ) ||
    !hasExactDataKeys(configuration.executionPolicy, [
      "schemaVersion", "acceptedSourceOrigin", "agentDerivedOrUntrustedSourceExecution",
      "osSandbox", "containmentClaim", "executableStrategy", "lto", "linkerPlugin",
    ]) ||
    !hasExactDataKeys(configuration.resourceLimits, [
      "maxSourceBytes", "maxTotalSourceBytes", "maxSupportFileBytes", "maxSupportTotalBytes",
      "maxToolchainFileBytes", "maxToolchainTotalBytes", "maxElfBytes", "maxBinBytes",
      "maxMapBytes",
    ]) ||
    !isClosedArray(configuration.toolchainFiles) ||
    configuration.toolchainFiles.some((file) =>
      !hasExactDataKeys(file, ["role", "path", "relativePath", "identity"]) ||
      !isContentIdentity(file.identity)
    ) ||
    !isClosedArray(configuration.supportFiles) ||
    configuration.supportFiles.some((file) =>
      !hasExactDataKeys(file, ["role", "path", "relativePath", "identity"]) ||
      !isContentIdentity(file.identity)
    ) ||
    !isClosedArray(configuration.embeddedFiles) ||
    configuration.embeddedFiles.some((file) =>
      !hasExactDataKeys(file, ["logicalPath", "identity"]) || !isContentIdentity(file.identity)
    ) ||
    !hasClosedStringArray(configuration.compileArguments) ||
    !hasClosedStringArray(configuration.objcopyArguments)
  ) {
    fail("Firmware target configuration contains unrecognized or non-data fields.");
  }
  return configuration;
};

const assertObservedToolEvidence = (
  value: FirmwareRuntimeToolEvidenceV1,
): FirmwareRuntimeToolEvidenceV1 => {
  if (
    !hasExactDataKeys(value, ["schemaVersion", "provenance", "gcc", "objcopy"]) ||
    !hasExactDataKeys(value.provenance, [
      "classification", "source", "executableAuthentication",
    ]) ||
    !hasExactDataKeys(value.gcc, [
      "schemaVersion", "name", "version", "capabilitiesIdentity", "helpIdentity",
    ]) ||
    !hasExactDataKeys(value.objcopy, [
      "schemaVersion", "name", "version", "capabilitiesIdentity", "helpIdentity",
    ]) ||
    value.schemaVersion !== "evleda.firmware-runtime-tool-evidence.v1" ||
    value.provenance.classification !== "observed_non_authenticating" ||
    value.provenance.source !== "caller_supplied_bounded_probe_bytes" ||
    value.provenance.executableAuthentication !== false ||
    value.gcc.schemaVersion !== "evleda.firmware-runtime-observed-tool.v1" ||
    value.gcc.name !== "arm-none-eabi-gcc" || value.gcc.version !== "14.2.1" ||
    value.objcopy.schemaVersion !== "evleda.firmware-runtime-observed-tool.v1" ||
    value.objcopy.name !== "arm-none-eabi-objcopy" ||
    value.objcopy.version !== "2.43.1.20241119" ||
    !isContentIdentity(value.gcc.capabilitiesIdentity) || value.gcc.capabilitiesIdentity.size <= 0 ||
    !isContentIdentity(value.gcc.helpIdentity) || value.gcc.helpIdentity.size <= 0 ||
    !isContentIdentity(value.objcopy.capabilitiesIdentity) ||
      value.objcopy.capabilitiesIdentity.size <= 0 ||
    !isContentIdentity(value.objcopy.helpIdentity) || value.objcopy.helpIdentity.size <= 0
  ) {
    fail("Firmware tool observations are malformed or claim executable authentication.");
  }
  return value;
};

/** Host paths and ambient environment values are deliberately omitted. */
export const buildFirmwareRuntimeBoundInputClosureV1 = (
  configuration: FirmwareTargetBuildBackendConfiguration,
  observedProbeEvidence: FirmwareRuntimeToolEvidenceV1,
): FirmwareRuntimeBoundInputClosureV1 => {
  configuration = assertClosedFirmwareTargetConfiguration(configuration);
  const observations = assertObservedToolEvidence(observedProbeEvidence);
  const expectedToolchainEntries = Object.entries(exactToolchainFiles);
  const actualByRole = new Map(configuration.toolchainFiles.map((file) => [file.role, file]));
  const supportNames = new Set(configuration.supportFiles.map((file) => `${file.role}\0${file.relativePath}`));
  const expectedSupport = expectedSupportIdentities();
  const allowedEnvironmentNames = new Set([
    "LC_ALL", "LANG", "LANGUAGE", "NO_COLOR", "SOURCE_DATE_EPOCH", "TEMP", "TMP",
    "TMPDIR", "PATH", "SystemRoot", "WINDIR",
  ]);
  const deterministicEnvironment = {
    LC_ALL: "C",
    LANG: "C",
    LANGUAGE: "C",
    NO_COLOR: "1",
    SOURCE_DATE_EPOCH: "0",
    TEMP: "<workspace>",
    TMP: "<workspace>",
    TMPDIR: "<workspace>",
    PATH: "<toolchain>/bin;<toolchain>/arm-none-eabi/bin",
  };
  if (
    configuration.schemaVersion !== "evleda.firmware-target-build-backend-config.v1" ||
    configuration.backendId !== "arm-gnu-stm32g0b1-freestanding-v1" ||
    configuration.targetTriple !== "arm-none-eabi" || configuration.targetPart !== "STM32G0B1CET6" ||
    configuration.cpu !== "cortex-m0plus" || configuration.floatAbi !== "soft" ||
    configuration.expectedRelease !== ARM_GNU_TOOLCHAIN_RELEASE ||
    configuration.expectedGccVersion !== ARM_GNU_GCC_VERSION ||
    canonicalJson(configuration.distribution) !== canonicalJson({
      archiveName: ARM_GNU_ARCHIVE_NAME,
      officialUrl: ARM_GNU_OFFICIAL_URL,
      sha256: ARM_GNU_ARCHIVE_SHA256,
    }) ||
    configuration.executionPolicy.acceptedSourceOrigin !== "evleda-deterministic-generator" ||
    configuration.executionPolicy.agentDerivedOrUntrustedSourceExecution !== "deny" ||
    configuration.executionPolicy.osSandbox !== "none" ||
    configuration.executionPolicy.containmentClaim !== "not-contained" ||
    configuration.executionPolicy.executableStrategy !== "verified-private-toolchain-closure" ||
    configuration.executionPolicy.lto !== "disabled" ||
    configuration.executionPolicy.linkerPlugin !== "disabled" ||
    canonicalJson(configuration.resourceLimits) !== canonicalJson(FIRMWARE_TARGET_RESOURCE_LIMITS) ||
    configuration.processRunner !== "evleda.bounded-process.v1" ||
    configuration.toolchainFiles.length !== expectedToolchainEntries.length ||
    expectedToolchainEntries.some(([role, relativePath]) => {
      const file = actualByRole.get(role as keyof typeof exactToolchainFiles);
      return file === undefined || file.relativePath !== relativePath || !isContentIdentity(file.identity) ||
        file.identity.size <= 0;
    }) ||
    configuration.supportFiles.length !== 12 || supportNames.size !== configuration.supportFiles.length ||
    configuration.supportFiles.filter((file) => file.role === "support_manifest").length !== 1 ||
    configuration.supportFiles.filter((file) => file.role === "support_source").length !== 11 ||
    configuration.supportFiles.some((file) =>
      (file.role !== "support_manifest" && file.role !== "support_source") ||
      !safeRelativePath(file.relativePath) || !isContentIdentity(file.identity) || file.identity.size <= 0 ||
      canonicalJson(expectedSupport.get(`${file.role}\0${file.relativePath}`)) !==
        canonicalJson(file.identity)
    ) ||
    canonicalJson(configuration.embeddedFiles) !== canonicalJson(FIRMWARE_TARGET_EMBEDDED_FILES) ||
    Object.entries(deterministicEnvironment).some(([name, value]) => configuration.environment[name] !== value) ||
    Object.keys(configuration.environment).some((name) => !allowedEnvironmentNames.has(name)) ||
    canonicalJson(configuration.environmentIdentity) !== canonicalJson(canonicalIdentity(
      configuration.environment,
      "evleda.firmware-target-build-environment.v1",
    )) ||
    !configuration.compileArguments.includes("-fno-lto") ||
    !configuration.compileArguments.includes("-fno-use-linker-plugin") ||
    configuration.timeoutMs <= 0 || configuration.timeoutMs > 120_000 ||
    configuration.maxOutputBytes <= 0 || configuration.maxOutputBytes > 1024 * 1024
  ) {
    fail("Firmware target configuration does not match the reviewed Arm GNU closure.");
  }

  const gccFile = actualByRole.get("gcc");
  const objcopyFile = actualByRole.get("objcopy");
  if (gccFile === undefined || objcopyFile === undefined) {
    fail("Firmware target closure is missing a required command executable.");
  }
  const tools = {
    gcc: runtimeTool(
      "arm-none-eabi-gcc",
      "14.2.1",
      gccFile!.identity,
      observations.gcc.capabilitiesIdentity,
      observations.gcc.helpIdentity,
    ),
    objcopy: runtimeTool(
      "arm-none-eabi-objcopy",
      "2.43.1.20241119",
      objcopyFile!.identity,
      observations.objcopy.capabilitiesIdentity,
      observations.objcopy.helpIdentity,
    ),
  };

  const preimage: Omit<FirmwareRuntimeBoundInputClosureV1, "closureIdentity"> = {
    schemaVersion: FIRMWARE_RUNTIME_BOUND_INPUT_CLOSURE_SCHEMA_VERSION,
    target: {
      triple: "arm-none-eabi" as const,
      part: "STM32G0B1CET6" as const,
      cpu: "cortex-m0plus" as const,
      floatAbi: "soft" as const,
    },
    distribution: {
      release: ARM_GNU_TOOLCHAIN_RELEASE,
      gccVersion: ARM_GNU_GCC_VERSION,
      archiveName: ARM_GNU_ARCHIVE_NAME,
      officialUrl: ARM_GNU_OFFICIAL_URL,
      sha256: ARM_GNU_ARCHIVE_SHA256,
    },
    executionPolicy: {
      sourceOrigin: "evleda-deterministic-generator" as const,
      lto: "disabled" as const,
      linkerPlugin: "disabled" as const,
      containmentClaim: "not-contained" as const,
    },
    resourceLimits: structuredClone(FIRMWARE_TARGET_RESOURCE_LIMITS),
    toolchainFiles: sortedFileProjection(configuration.toolchainFiles),
    supportFiles: sortedFileProjection(configuration.supportFiles) as FirmwareRuntimeBoundInputClosureV1["supportFiles"],
    embeddedFiles: structuredClone(FIRMWARE_TARGET_EMBEDDED_FILES),
    observedProbeEvidence: structuredClone(observations),
    tools: structuredClone(tools),
  };
  return deepFreeze({
    ...preimage,
    closureIdentity: canonicalIdentity(
      preimage,
      FIRMWARE_RUNTIME_BOUND_INPUT_CLOSURE_SCHEMA_VERSION,
    ) as FirmwareRuntimeBoundInputClosureV1["closureIdentity"],
  });
};

const pathRef = (
  root: NativeProcessPathRefV1["root"],
  relativePath: string,
): NativeProcessPathRefV1 => deepFreeze({
  schemaVersion: "evleda.portable-path-ref.v1",
  root,
  relativePath,
});

const literal = (value: string): NativeProcessCommandArgumentV1 => deepFreeze({ kind: "literal", value });
const pathArgument = (value: NativeProcessPathRefV1): NativeProcessCommandArgumentV1 =>
  deepFreeze({ kind: "path", value });

const input = (relativePath: string): NativeProcessPathRefV1 => pathRef("run_input", relativePath);
const output = (relativePath: string): NativeProcessPathRefV1 => pathRef("run_private", relativePath);

const commonCArguments = Object.freeze([
  "-mcpu=cortex-m0plus", "-mthumb", "-mfloat-abi=soft", "-std=c11", "-ffreestanding",
  "-fno-common", "-fno-builtin", "-fno-ident", "-fno-lto", "-fno-use-linker-plugin",
  "-nostdinc", "-ffunction-sections", "-fdata-sections", "-fno-unwind-tables",
  "-fno-asynchronous-unwind-tables", "-Os", "-Wall", "-Wextra", "-Werror",
  "-DSTM32G0B1xx",
]);

const includeArguments = (): readonly NativeProcessCommandArgumentV1[] => Object.freeze([
  literal("-I"), pathArgument(input("firmware/include")),
  literal("-isystem"), pathArgument(input("firmware/support/freestanding/include")),
  literal("-I"), pathArgument(input("firmware/support/device/include")),
  literal("-I"), pathArgument(input("firmware/support/core/include")),
]);

const compileSpec = (
  source: string,
  objectName: string,
  assembler = false,
): FirmwareRuntimeCommandSpecV1 => {
  const object = output(`firmware/build/objects/${objectName}`);
  const argumentsForSource = assembler
    ? ["-mcpu=cortex-m0plus", "-mthumb", "-mfloat-abi=soft", "-fno-lto", "-fno-use-linker-plugin"]
    : commonCArguments;
  return deepFreeze({
    operation: "compile",
    toolRole: "gcc",
    logicalCwd: pathRef("run_private", "firmware"),
    argv: [
      ...argumentsForSource.map(literal),
      ...(assembler ? [] : includeArguments()),
      ...(assembler ? [] : [literal(`-frandom-seed=${objectName}`)]),
      literal("-c"),
      pathArgument(input(source)),
      literal("-o"),
      pathArgument(object),
    ],
    expectedOutputs: [object],
    outputByteLimits: [{ output: object, maximumBytes: 4 * 1024 * 1024 }],
  });
};

const commandMatrix = (): FirmwareRuntimeCommandContractV1["commands"] => {
  const elf = output("firmware/build/evleda-stm32g0b1cet6-candidate.elf");
  const map = output("firmware/build/evleda-stm32g0b1cet6-candidate.map");
  const binary = output("firmware/build/evleda-stm32g0b1cet6-candidate.bin");
  const objects = [
    "board_contract.o", "platform_stm32g0b1.o", "startup_stm32g0b1.o",
    "system_stm32g0xx.o", "runtime.o",
  ].map((name) => output(`firmware/build/objects/${name}`));
  return deepFreeze({
    compile_board_contract: compileSpec("firmware/src/board_contract.c", "board_contract.o"),
    compile_platform: compileSpec("firmware/target/platform_stm32g0b1.c", "platform_stm32g0b1.o"),
    compile_startup: compileSpec("firmware/target/startup_stm32g0b1.s", "startup_stm32g0b1.o", true),
    compile_system: compileSpec(
      "firmware/support/device/templates/system_stm32g0xx.c",
      "system_stm32g0xx.o",
    ),
    compile_runtime: compileSpec("firmware/support/freestanding/runtime.c", "runtime.o"),
    link_candidate: {
      operation: "link",
      toolRole: "gcc",
      logicalCwd: pathRef("run_private", "firmware"),
      argv: [
        ...["-mcpu=cortex-m0plus", "-mthumb", "-mfloat-abi=soft", "-fno-lto",
          "-fno-use-linker-plugin", "-nostdlib", "-Wl,--gc-sections", "-Wl,--build-id=none",
          "-Wl,--no-warn-execstack", "-Wl,--fatal-warnings", "-Wl,--print-memory-usage"].map(literal),
        ...objects.map(pathArgument),
        literal("-T"), pathArgument(input("firmware/target/STM32G0B1CET6.ld")),
        pathArgument(input("firmware/toolchain/lib/gcc/arm-none-eabi/14.2.1/thumb/v6-m/nofp/libgcc.a")),
        literal("-Xlinker"), literal("-Map"), literal("-Xlinker"), pathArgument(map),
        literal("-o"), pathArgument(elf),
      ],
      expectedOutputs: [elf, map],
      outputByteLimits: [
        { output: elf, maximumBytes: FIRMWARE_TARGET_RESOURCE_LIMITS.maxElfBytes },
        { output: map, maximumBytes: FIRMWARE_TARGET_RESOURCE_LIMITS.maxMapBytes },
      ],
    },
    objcopy_candidate: {
      operation: "objcopy",
      toolRole: "objcopy",
      logicalCwd: pathRef("run_private", "firmware"),
      argv: [literal("-O"), literal("binary"), pathArgument(elf), pathArgument(binary)],
      expectedOutputs: [binary],
      outputByteLimits: [{ output: binary, maximumBytes: FIRMWARE_TARGET_RESOURCE_LIMITS.maxBinBytes }],
    },
  });
};

export const FIRMWARE_RUNTIME_ENVIRONMENT_V1: NativeProcessEnvironmentV1 = deepFreeze({
  schemaVersion: "evleda.native-process-environment.v1",
  inheritance: "none",
  fixed: [
    { name: "LANG", value: "C" },
    { name: "LANGUAGE", value: "C" },
    { name: "LC_ALL", value: "C" },
    { name: "NO_COLOR", value: "1" },
    { name: "PATH", value: "<toolchain>/bin;<toolchain>/arm-none-eabi/bin" },
    { name: "SOURCE_DATE_EPOCH", value: "0" },
    { name: "TZ", value: "UTC" },
  ],
  privateRuntime: [
    { name: "SYSTEMROOT", disposition: "excluded-private" },
    { name: "TEMP", disposition: "excluded-private" },
    { name: "TMP", disposition: "excluded-private" },
    { name: "TMPDIR", disposition: "excluded-private" },
    { name: "WINDIR", disposition: "excluded-private" },
  ],
});

const expectedTool = (
  value: NativeProcessToolV1,
  role: FirmwareRuntimeToolRoleV1,
  content: ContentIdentity,
): void => {
  const name = role === "gcc" ? "arm-none-eabi-gcc" : "arm-none-eabi-objcopy";
  const version = role === "gcc" ? "14.2.1" : "2.43.1.20241119";
  if (!hasExactDataKeys(value, [
        "schemaVersion", "role", "kind", "name", "version", "commit", "contentIdentity",
        "capabilitiesIdentity", "helpIdentity",
      ]) ||
      value.schemaVersion !== "evleda.tool-content-identity.v1" || value.role !== "runtime" ||
      value.kind !== "native_executable" || value.name !== name || value.version !== version ||
      value.commit !== "not_applicable" || !isContentIdentity(value.contentIdentity) ||
      !isContentIdentity(value.capabilitiesIdentity) || !isContentIdentity(value.helpIdentity) ||
      value.contentIdentity.size <= 0 || value.capabilitiesIdentity.size <= 0 ||
      value.helpIdentity.size <= 0 ||
      canonicalJson(value.contentIdentity) !== canonicalJson(content)) {
    fail("Firmware runtime tool identity does not match its exact provisioned executable.", { role });
  }
};

const isClosedPathRef = (value: unknown): value is NativeProcessPathRefV1 =>
  hasExactDataKeys(value, ["schemaVersion", "root", "relativePath"]);

const isClosedCommandArgument = (value: unknown): value is NativeProcessCommandArgumentV1 => {
  if (!hasExactDataKeys(value, ["kind", "value"])) return false;
  return value.kind === "literal" ? typeof value.value === "string" :
    value.kind === "path" && isClosedPathRef(value.value);
};

const hasClosedCommandMatrix = (
  commands: Readonly<Record<FirmwareRuntimeCommandIdV1, FirmwareRuntimeCommandSpecV1>>,
): boolean => {
  if (!hasExactDataKeys(commands, FIRMWARE_RUNTIME_COMMAND_IDS)) return false;
  return FIRMWARE_RUNTIME_COMMAND_IDS.every((commandId) => {
    const spec = commands[commandId];
    return hasExactDataKeys(spec, [
      "operation", "toolRole", "logicalCwd", "argv", "expectedOutputs", "outputByteLimits",
    ]) && isClosedPathRef(spec.logicalCwd) && isClosedArray(spec.argv) &&
      spec.argv.every(isClosedCommandArgument) && isClosedArray(spec.expectedOutputs) &&
      spec.expectedOutputs.every(isClosedPathRef) && isClosedArray(spec.outputByteLimits) &&
      spec.outputByteLimits.every((limit) =>
        hasExactDataKeys(limit, ["output", "maximumBytes"]) && isClosedPathRef(limit.output)
      );
  });
};

const hasClosedEnvironment = (environment: NativeProcessEnvironmentV1): boolean =>
  hasExactDataKeys(environment, ["schemaVersion", "inheritance", "fixed", "privateRuntime"]) &&
  isClosedArray(environment.fixed) && environment.fixed.every((entry) =>
    hasExactDataKeys(entry, ["name", "value"])
  ) && isClosedArray(environment.privateRuntime) && environment.privateRuntime.every((entry) =>
    hasExactDataKeys(entry, ["name", "disposition"])
  );

const assertBoundInputClosure = (
  closure: FirmwareRuntimeBoundInputClosureV1,
): FirmwareRuntimeBoundInputClosureV1 => {
  if (
    !hasExactDataKeys(closure, [
      "schemaVersion", "target", "distribution", "executionPolicy", "resourceLimits",
      "toolchainFiles", "supportFiles", "embeddedFiles", "observedProbeEvidence", "tools",
      "closureIdentity",
    ]) ||
    !hasExactDataKeys(closure.target, ["triple", "part", "cpu", "floatAbi"]) ||
    !hasExactDataKeys(closure.distribution, [
      "release", "gccVersion", "archiveName", "officialUrl", "sha256",
    ]) ||
    !hasExactDataKeys(closure.executionPolicy, [
      "sourceOrigin", "lto", "linkerPlugin", "containmentClaim",
    ]) ||
    !hasExactDataKeys(closure.resourceLimits, [
      "maxSourceBytes", "maxTotalSourceBytes", "maxSupportFileBytes", "maxSupportTotalBytes",
      "maxToolchainFileBytes", "maxToolchainTotalBytes", "maxElfBytes", "maxBinBytes",
      "maxMapBytes",
    ]) ||
    !isClosedArray(closure.toolchainFiles) || !isClosedArray(closure.supportFiles) ||
    !isClosedArray(closure.embeddedFiles) ||
    closure.toolchainFiles.some((file) => !hasExactDataKeys(file, [
      "role", "relativePath", "identity",
    ])) ||
    closure.supportFiles.some((file) => !hasExactDataKeys(file, [
      "role", "relativePath", "identity",
    ])) ||
    closure.embeddedFiles.some((file) =>
      !hasExactDataKeys(file, ["logicalPath", "identity"]) || !isContentIdentity(file.identity)
    ) ||
    !hasExactDataKeys(closure.tools, ["gcc", "objcopy"])
  ) {
    fail("Firmware runtime bound-input closure contains unrecognized fields.");
  }
  const { closureIdentity, ...preimage } = closure;
  const actualToolchain = new Map(closure.toolchainFiles.map((file) => [file.role, file]));
  const expectedSupport = expectedSupportIdentities();
  const actualSupportKeys = closure.supportFiles.map((file) => `${file.role}\0${file.relativePath}`);
  const observations = assertObservedToolEvidence(closure.observedProbeEvidence);
  const gccFile = actualToolchain.get("gcc");
  const objcopyFile = actualToolchain.get("objcopy");
  if (
    closure.schemaVersion !== FIRMWARE_RUNTIME_BOUND_INPUT_CLOSURE_SCHEMA_VERSION ||
    !isCanonicalIdentity(closureIdentity, FIRMWARE_RUNTIME_BOUND_INPUT_CLOSURE_SCHEMA_VERSION) ||
    canonicalJson(closureIdentity) !== canonicalJson(canonicalIdentity(
      preimage,
      FIRMWARE_RUNTIME_BOUND_INPUT_CLOSURE_SCHEMA_VERSION,
    )) ||
    canonicalJson(closure.target) !== canonicalJson({
      triple: "arm-none-eabi",
      part: "STM32G0B1CET6",
      cpu: "cortex-m0plus",
      floatAbi: "soft",
    }) ||
    canonicalJson(closure.distribution) !== canonicalJson({
      release: ARM_GNU_TOOLCHAIN_RELEASE,
      gccVersion: ARM_GNU_GCC_VERSION,
      archiveName: ARM_GNU_ARCHIVE_NAME,
      officialUrl: ARM_GNU_OFFICIAL_URL,
      sha256: ARM_GNU_ARCHIVE_SHA256,
    }) ||
    canonicalJson(closure.executionPolicy) !== canonicalJson({
      sourceOrigin: "evleda-deterministic-generator",
      lto: "disabled",
      linkerPlugin: "disabled",
      containmentClaim: "not-contained",
    }) ||
    canonicalJson(closure.resourceLimits) !== canonicalJson(FIRMWARE_TARGET_RESOURCE_LIMITS) ||
    canonicalJson(closure.toolchainFiles) !==
      canonicalJson(sortedFileProjection(closure.toolchainFiles)) ||
    canonicalJson(closure.supportFiles) !==
      canonicalJson(sortedFileProjection(closure.supportFiles)) ||
    closure.toolchainFiles.length !== Object.keys(exactToolchainFiles).length ||
    Object.entries(exactToolchainFiles).some(([role, relativePath]) => {
      const file = actualToolchain.get(role);
      return file === undefined || file.relativePath !== relativePath ||
        !isContentIdentity(file.identity) || file.identity.size <= 0;
    }) ||
    closure.supportFiles.length !== expectedSupport.size ||
    new Set(actualSupportKeys).size !== actualSupportKeys.length ||
    closure.supportFiles.some((file) =>
      !safeRelativePath(file.relativePath) ||
      canonicalJson(file.identity) !== canonicalJson(expectedSupport.get(`${file.role}\0${file.relativePath}`))
    ) ||
    canonicalJson(closure.embeddedFiles) !== canonicalJson(FIRMWARE_TARGET_EMBEDDED_FILES) ||
    gccFile === undefined || objcopyFile === undefined
  ) {
    fail("Firmware runtime bound-input closure preimage is invalid or incomplete.");
  }
  expectedTool(closure.tools.gcc, "gcc", gccFile!.identity);
  expectedTool(closure.tools.objcopy, "objcopy", objcopyFile!.identity);
  if (
    canonicalJson(closure.tools.gcc.capabilitiesIdentity) !==
      canonicalJson(observations.gcc.capabilitiesIdentity) ||
    canonicalJson(closure.tools.gcc.helpIdentity) !== canonicalJson(observations.gcc.helpIdentity) ||
    canonicalJson(closure.tools.objcopy.capabilitiesIdentity) !==
      canonicalJson(observations.objcopy.capabilitiesIdentity) ||
    canonicalJson(closure.tools.objcopy.helpIdentity) !==
      canonicalJson(observations.objcopy.helpIdentity)
  ) {
    fail("Firmware runtime tool observations are detached from the bound closure.");
  }
  return closure;
};

export const buildFirmwareRuntimeCommandContractV1 = (input: {
  readonly closure: FirmwareRuntimeBoundInputClosureV1;
}): FirmwareRuntimeCommandContractV1 => {
  if (!hasExactDataKeys(input, ["closure"])) {
    fail("Firmware runtime contract input contains unrecognized fields.");
  }
  const closure = assertBoundInputClosure(input.closure);
  const draft: Omit<FirmwareRuntimeCommandContractV1, "contractIdentity"> = {
    schemaVersion: FIRMWARE_RUNTIME_COMMAND_CONTRACT_SCHEMA_VERSION,
    boundInputClosure: deepFreeze(structuredClone(closure)),
    target: structuredClone(closure.target),
    environment: structuredClone(FIRMWARE_RUNTIME_ENVIRONMENT_V1),
    timeoutMs: FIRMWARE_RUNTIME_TIMEOUT_MS,
    maxStdoutBytes: FIRMWARE_RUNTIME_STREAM_LIMIT_BYTES,
    maxStderrBytes: FIRMWARE_RUNTIME_STREAM_LIMIT_BYTES,
    commands: commandMatrix(),
    disposition: {
      lifecycle: "candidate" as const,
      deployment: "compiled-non-flashable-candidate" as const,
      flashable: false as const,
      releaseAuthorized: false as const,
      physicalQualification: "not_run" as const,
    },
  };
  return deepFreeze({
    ...draft,
    contractIdentity: canonicalIdentity(
      draft,
      FIRMWARE_RUNTIME_COMMAND_CONTRACT_SCHEMA_VERSION,
    ) as FirmwareRuntimeCommandContractV1["contractIdentity"],
  });
};

const assertContract = (contract: FirmwareRuntimeCommandContractV1): FirmwareRuntimeCommandContractV1 => {
  if (
    !hasExactDataKeys(contract, [
      "schemaVersion", "boundInputClosure", "target", "environment", "timeoutMs",
      "maxStdoutBytes", "maxStderrBytes", "commands", "disposition", "contractIdentity",
    ]) ||
    !hasExactDataKeys(contract.target, ["triple", "part", "cpu", "floatAbi"]) ||
    !hasClosedEnvironment(contract.environment) || !hasClosedCommandMatrix(contract.commands) ||
    !hasExactDataKeys(contract.disposition, [
      "lifecycle", "deployment", "flashable", "releaseAuthorized", "physicalQualification",
    ])
  ) {
    fail("Firmware runtime command contract contains unrecognized fields.");
  }
  const closure = assertBoundInputClosure(contract.boundInputClosure);
  const { contractIdentity, ...preimage } = contract;
  const exactDisposition = {
    lifecycle: "candidate",
    deployment: "compiled-non-flashable-candidate",
    flashable: false,
    releaseAuthorized: false,
    physicalQualification: "not_run",
  };
  const exactTarget = {
    triple: "arm-none-eabi",
    part: "STM32G0B1CET6",
    cpu: "cortex-m0plus",
    floatAbi: "soft",
  };
  if (!isCanonicalIdentity(contractIdentity, FIRMWARE_RUNTIME_COMMAND_CONTRACT_SCHEMA_VERSION) ||
      canonicalJson(contractIdentity) !== canonicalJson(canonicalIdentity(
        preimage,
        FIRMWARE_RUNTIME_COMMAND_CONTRACT_SCHEMA_VERSION,
      )) || contract.schemaVersion !== FIRMWARE_RUNTIME_COMMAND_CONTRACT_SCHEMA_VERSION ||
      canonicalJson(contract.environment) !== canonicalJson(FIRMWARE_RUNTIME_ENVIRONMENT_V1) ||
      contract.timeoutMs !== FIRMWARE_RUNTIME_TIMEOUT_MS ||
      contract.maxStdoutBytes !== FIRMWARE_RUNTIME_STREAM_LIMIT_BYTES ||
      contract.maxStderrBytes !== FIRMWARE_RUNTIME_STREAM_LIMIT_BYTES ||
      canonicalJson(contract.target) !== canonicalJson(closure.target) ||
      canonicalJson(contract.target) !== canonicalJson(exactTarget) ||
      canonicalJson(contract.disposition) !== canonicalJson(exactDisposition) ||
      canonicalJson(contract.commands) !== canonicalJson(commandMatrix()) ||
      canonicalJson(Object.keys(contract.commands)) !== canonicalJson(FIRMWARE_RUNTIME_COMMAND_IDS) ||
      canonicalJson(contract.boundInputClosure) !== canonicalJson(closure)) {
    fail("Firmware runtime command contract is invalid or has changed after approval.");
  }
  return contract;
};

const logicalCommand = (
  contract: FirmwareRuntimeCommandContractV1,
  commandId: FirmwareRuntimeCommandIdV1,
): NativeProcessLogicalCommandV1 => {
  const spec = contract.commands[commandId];
  const tool = contract.boundInputClosure.tools[spec.toolRole];
  const preimage = {
    schemaVersion: NATIVE_PROCESS_LOGICAL_COMMAND_SCHEMA_VERSION,
    tool,
    logicalCwd: spec.logicalCwd,
    argv: spec.argv,
    environment: contract.environment,
    expectedOutputs: spec.expectedOutputs,
  };
  return deepFreeze({
    ...preimage,
    commandIdentity: canonicalIdentity(
      preimage,
      NATIVE_PROCESS_LOGICAL_COMMAND_SCHEMA_VERSION,
    ) as NativeProcessLogicalCommandV1["commandIdentity"],
  });
};

const exactPlan = (
  contract: FirmwareRuntimeCommandContractV1,
  commandId: FirmwareRuntimeCommandIdV1,
): NativeProcessPlanV2 => {
  const spec = contract.commands[commandId];
  const command = logicalCommand(contract, commandId);
  const profile = {
    schemaVersion: "evleda.native-process-profile.firmware.v1" as const,
    domain: "firmware" as const,
    operation: spec.operation,
    contractIdentity: contract.contractIdentity,
  };
  return buildNativeProcessPlanV2({
    schemaVersion: NATIVE_PROCESS_PLAN_V2_SCHEMA_VERSION,
    transport: "native_process",
    profile,
    tool: command.tool,
    command: { kind: "native_process_logical_command_v1", value: command },
    expectedOutputs: spec.outputByteLimits.map((limit) => ({
      schemaVersion: "evleda.native-process-expected-output.v1" as const,
      path: limit.output,
      maxBytes: limit.maximumBytes,
    })),
    acceptedExitCodes: acceptedExitCodesForNativeProcessProfile(profile),
    timeoutMs: contract.timeoutMs,
    maxStdoutBytes: contract.maxStdoutBytes,
    maxStderrBytes: contract.maxStderrBytes,
    inputPolicy: {
      schemaVersion: "evleda.native-process-input-policy.v1",
      snapshot: "immutable_before_spawn",
      mutation: "immutable",
      evaluatedInput: "command_input",
    },
  });
};

export const buildFirmwareRuntimeCommandPlanV2 = (input: {
  readonly contract: FirmwareRuntimeCommandContractV1;
  readonly commandId: FirmwareRuntimeCommandIdV1;
}): NativeProcessPlanV2 => {
  if (!hasExactDataKeys(input, ["contract", "commandId"])) {
    fail("Firmware runtime command-plan input contains unrecognized fields.");
  }
  const contract = assertContract(input.contract);
  if (!FIRMWARE_RUNTIME_COMMAND_IDS.includes(input.commandId)) {
    fail("Firmware runtime command identifier is not approved.", { commandId: input.commandId });
  }
  return exactPlan(contract, input.commandId);
};

export const assertApprovedFirmwareRuntimeCommandPlanV2 = (
  contract: FirmwareRuntimeCommandContractV1,
  value: unknown,
): NativeProcessPlanV2 => {
  const approvedContract = assertContract(contract);
  const plan = validateNativeProcessPlanV2(value);
  if (plan.profile.domain !== "firmware" ||
      canonicalJson(plan.profile.contractIdentity) !== canonicalJson(approvedContract.contractIdentity)) {
    fail("Firmware runtime plan is outside the approved contract.");
  }
  const candidates = FIRMWARE_RUNTIME_COMMAND_IDS.filter(
    (commandId) => approvedContract.commands[commandId].operation === plan.profile.operation,
  );
  if (!candidates.some((commandId) => canonicalJson(exactPlan(approvedContract, commandId)) === canonicalJson(plan))) {
    fail("Firmware runtime plan does not match an exact approved command and output matrix.", {
      operation: plan.profile.operation,
    });
  }
  return plan;
};

/**
 * Registration object for the neutral W-08 command registry. Registration
 * approves command shape only; it is not a durable invocation writer and does
 * not authorize flashing, physical qualification, or release.
 */
export const createApprovedFirmwareRuntimeContractValidatorV2 = (
  contract: FirmwareRuntimeCommandContractV1,
): ApprovedNativeProcessContractValidatorV2 => {
  const approvedContract = deepFreeze(structuredClone(assertContract(contract)));
  const publishedContractIdentity = deepFreeze(structuredClone(approvedContract.contractIdentity));
  return deepFreeze({
    validatorId: "evleda.firmware-runtime-command-contract.v2",
    profileDomain: "firmware",
    operations: Object.freeze(["compile", "link", "objcopy"] as const),
    contractIdentity: publishedContractIdentity,
    assertApproved: (plan: NativeProcessPlanV2) =>
      assertApprovedFirmwareRuntimeCommandPlanV2(approvedContract, plan),
  });
};
