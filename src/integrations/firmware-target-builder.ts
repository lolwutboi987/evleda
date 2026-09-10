import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import {
  FIRMWARE_TARGET_BUILD_CONFIGURATION_SCHEMA,
  FIRMWARE_TARGET_BUILD_ENVIRONMENT_SCHEMA,
  FIRMWARE_EXECUTION_POLICY_SCHEMA,
  FIRMWARE_TARGET_SOURCE_LOGICAL_NAMES,
  type FirmwareTargetBoundFile,
  type FirmwareTargetEmbeddedFile,
  type FirmwareTargetBuildBackend,
  type FirmwareTargetBuildBackendConfiguration,
  type FirmwareTargetBuildRequest,
  type FirmwareTargetBuildResult,
  type FirmwareTargetBuildSource,
  type FirmwareTargetBuildStep,
  type FirmwareTargetSourceLogicalName,
  type FirmwareTargetToolchainFileRole
} from "../workflow/contracts.js";
import {
  runBoundedProcess,
  type BoundedProcessResult,
  type BoundedProcessRunner
} from "./bounded-process.js";

export const ARM_GNU_TOOLCHAIN_RELEASE = "14.2.Rel1" as const;
export const ARM_GNU_GCC_VERSION = "14.2.1" as const;
export const ARM_GNU_ARCHIVE_NAME =
  "arm-gnu-toolchain-14.2.rel1-mingw-w64-i686-arm-none-eabi.zip" as const;
export const ARM_GNU_ARCHIVE_SHA256 =
  "6facb152ce431ba9a4517e939ea46f057380f8f1e56b62e8712b3f3b87d994e1";
export const ARM_GNU_OFFICIAL_URL =
  `https://developer.arm.com/-/media/Files/downloads/gnu/14.2.rel1/binrel/${ARM_GNU_ARCHIVE_NAME}`;
export const STM32G0_SUPPORT_MANIFEST_SHA256 =
  "64dc34ad0721668a361cd99c017ea8a7590c234306fcde64bbe7f34219bb4f44";
export const STM32G0_SUPPORT_MANIFEST_SIZE = 1937;
export const STM32G0_SUPPORT_FILE_CLOSURE = Object.freeze([
  { relativePath: "CORE-LICENSE.txt", identity: { algorithm: "sha256" as const, digest: "e03ba41d7fab20700769fe4118bab50d800cb74f990353a05d2f5fff1c228363", size: 11558 } },
  { relativePath: "core/include/cmsis_compiler.h", identity: { algorithm: "sha256" as const, digest: "869640702d811c4c63abb52206715c891a93fd03be954df5ad40d378355af3d6", size: 9764 } },
  { relativePath: "core/include/cmsis_gcc.h", identity: { algorithm: "sha256" as const, digest: "0837f98e834d6a529854c8c86336e9d99eb8e379bf1deb964858d7863950f862", size: 64795 } },
  { relativePath: "core/include/cmsis_version.h", identity: { algorithm: "sha256" as const, digest: "dd03af200b23bdd8d091ffa7beb3d1a2c4fc5611557567bd57ec613205f6df1f", size: 1715 } },
  { relativePath: "core/include/core_cm0plus.h", identity: { algorithm: "sha256" as const, digest: "4b79d5bf9f9165ddae727c9f035f82fb0ea85ceee2587b503d5d7bcd172d2df9", size: 50609 } },
  { relativePath: "core/include/mpu_armv7.h", identity: { algorithm: "sha256" as const, digest: "e504a7d47dfdb3d61dfae3cf08d27ba9bc69aa4b2b81ca568efdafd65d6abdcc", size: 11962 } },
  { relativePath: "DEVICE-LICENSE.md", identity: { algorithm: "sha256" as const, digest: "1eb85fc97224598dad1852b5d6483bbcf0aa8608790dcc657a5a2a761ae9c8c6", size: 11558 } },
  { relativePath: "device/include/stm32g0b1xx.h", identity: { algorithm: "sha256" as const, digest: "32bc66b235b282bd03cbf4aa7e94ae79a5505a9c41915db59b011a15b7de5f8e", size: 876558 } },
  { relativePath: "device/include/stm32g0xx.h", identity: { algorithm: "sha256" as const, digest: "bf310501a0feb3cd9abce4c5df723475f205cffc4380d42281c2ab7c95b69f1e", size: 8164 } },
  { relativePath: "device/include/system_stm32g0xx.h", identity: { algorithm: "sha256" as const, digest: "7b7c61c56ee6d594b19fd8a2c8e1c973e8a50197633159c93f2dc238e6d252f7", size: 2330 } },
  { relativePath: "device/templates/system_stm32g0xx.c", identity: { algorithm: "sha256" as const, digest: "275dc0d5b4cb606e9514359e6d685dcb45da45cb6354e1bf6489b4723ff651b5", size: 11559 } },
].map((entry) => Object.freeze({ ...entry, identity: Object.freeze(entry.identity) })));

const BACKEND_ID = "arm-gnu-stm32g0b1-freestanding-v1";
const ELF_NAME = "firmware/build/evleda-stm32g0b1cet6-candidate.elf";
const BIN_NAME = "firmware/build/evleda-stm32g0b1cet6-candidate.bin";
const MAP_NAME = "firmware/build/evleda-stm32g0b1cet6-candidate.map";

export const FIRMWARE_TARGET_RESOURCE_LIMITS = Object.freeze({
  maxSourceBytes: 512 * 1024,
  maxTotalSourceBytes: 2 * 1024 * 1024,
  maxSupportFileBytes: 2 * 1024 * 1024,
  maxSupportTotalBytes: 4 * 1024 * 1024,
  maxToolchainFileBytes: 128 * 1024 * 1024,
  maxToolchainTotalBytes: 512 * 1024 * 1024,
  maxElfBytes: 16 * 1024 * 1024,
  maxBinBytes: 512 * 1024,
  maxMapBytes: 16 * 1024 * 1024,
});

const TARGET_EXECUTION_POLICY = Object.freeze({
  schemaVersion: FIRMWARE_EXECUTION_POLICY_SCHEMA,
  acceptedSourceOrigin: "evleda-deterministic-generator" as const,
  agentDerivedOrUntrustedSourceExecution: "deny" as const,
  osSandbox: "none" as const,
  containmentClaim: "not-contained" as const,
  executableStrategy: "verified-private-toolchain-closure" as const,
  lto: "disabled" as const,
  linkerPlugin: "disabled" as const,
});

const TOOLCHAIN_FILES: readonly { readonly role: FirmwareTargetToolchainFileRole; readonly relativePath: string }[] = [
  { role: "gcc", relativePath: "bin/arm-none-eabi-gcc.exe" },
  { role: "cc1", relativePath: "libexec/gcc/arm-none-eabi/14.2.1/cc1.exe" },
  // GCC resolves this exact private-driver-relative path, not the top-level alias.
  { role: "assembler", relativePath: "arm-none-eabi/bin/as.exe" },
  { role: "collect2", relativePath: "libexec/gcc/arm-none-eabi/14.2.1/collect2.exe" },
  { role: "ld", relativePath: "arm-none-eabi/bin/ld.exe" },
  { role: "objcopy", relativePath: "bin/arm-none-eabi-objcopy.exe" },
  { role: "libgcc", relativePath: "lib/gcc/arm-none-eabi/14.2.1/thumb/v6-m/nofp/libgcc.a" },
];

const FREESTANDING_HEADERS = Object.freeze([
  {
    logicalPath: "support/freestanding/include/stdbool.h",
    content: [
      "#ifndef EVLEDA_FREESTANDING_STDBOOL_H",
      "#define EVLEDA_FREESTANDING_STDBOOL_H",
      "#define bool _Bool",
      "#define true 1",
      "#define false 0",
      "#define __bool_true_false_are_defined 1",
      "#endif",
      "",
    ].join("\n"),
  },
  {
    logicalPath: "support/freestanding/include/stddef.h",
    content: [
      "#ifndef EVLEDA_FREESTANDING_STDDEF_H",
      "#define EVLEDA_FREESTANDING_STDDEF_H",
      "typedef __SIZE_TYPE__ size_t;",
      "typedef __PTRDIFF_TYPE__ ptrdiff_t;",
      "#define NULL ((void *)0)",
      "#endif",
      "",
    ].join("\n"),
  },
  {
    logicalPath: "support/freestanding/include/stdint.h",
    content: [
      "#ifndef EVLEDA_FREESTANDING_STDINT_H",
      "#define EVLEDA_FREESTANDING_STDINT_H",
      "typedef __INT8_TYPE__ int8_t;",
      "typedef __UINT8_TYPE__ uint8_t;",
      "typedef __INT16_TYPE__ int16_t;",
      "typedef __UINT16_TYPE__ uint16_t;",
      "typedef __INT32_TYPE__ int32_t;",
      "typedef __UINT32_TYPE__ uint32_t;",
      "typedef __INT64_TYPE__ int64_t;",
      "typedef __UINT64_TYPE__ uint64_t;",
      "typedef __INTPTR_TYPE__ intptr_t;",
      "typedef __UINTPTR_TYPE__ uintptr_t;",
      "#define INT32_MAX __INT32_MAX__",
      "#define UINT32_MAX __UINT32_MAX__",
      "#define INT32_C(value) value",
      "#define UINT32_C(value) value##U",
      "#endif",
      "",
    ].join("\n"),
  },
  {
    logicalPath: "support/freestanding/runtime.c",
    content: [
      "typedef void (*EvlInitFunction)(void);",
      "extern EvlInitFunction __preinit_array_start[];",
      "extern EvlInitFunction __preinit_array_end[];",
      "extern EvlInitFunction __init_array_start[];",
      "extern EvlInitFunction __init_array_end[];",
      "void __libc_init_array(void) {",
      "  EvlInitFunction *current;",
      "  for (current = __preinit_array_start; current < __preinit_array_end; ++current) { (*current)(); }",
      "  for (current = __init_array_start; current < __init_array_end; ++current) { (*current)(); }",
      "}",
      "",
    ].join("\n"),
  },
].map((entry) => Object.freeze({ ...entry, bytes: Buffer.from(entry.content, "utf8") })));

export const FIRMWARE_TARGET_EMBEDDED_FILES: readonly FirmwareTargetEmbeddedFile[] = Object.freeze(
  FREESTANDING_HEADERS.map((entry) => Object.freeze({
    logicalPath: entry.logicalPath,
    identity: Object.freeze(contentIdentity(entry.bytes)),
  })),
);

/** Fresh copies for identity-checked isolated build materialization and tests. */
export const firmwareTargetEmbeddedFileSnapshots = (): readonly {
  readonly logicalPath: string;
  readonly content: Uint8Array;
  readonly identity: ContentIdentity;
}[] => Object.freeze(FREESTANDING_HEADERS.map((entry) => Object.freeze({
  logicalPath: entry.logicalPath,
  content: Uint8Array.from(entry.bytes),
  identity: structuredClone(contentIdentity(entry.bytes)),
})));

export const firmwareTargetCompileArguments = (): readonly string[] => [
  "-mcpu=cortex-m0plus", "-mthumb", "-mfloat-abi=soft",
  "-std=c11", "-ffreestanding", "-fno-common", "-fno-builtin", "-fno-ident",
  "-fno-lto", "-fno-use-linker-plugin", "-nostdinc", "-nostdlib",
  "-save-temps=obj",
  "-ffunction-sections", "-fdata-sections", "-fno-unwind-tables", "-fno-asynchronous-unwind-tables",
  "-frandom-seed=evleda-stm32g0b1cet6-v1", "-Os", "-Wall", "-Wextra", "-Werror",
  "-DSTM32G0B1xx", "-I", "include", "-isystem", "support/freestanding/include",
  "-I", "support/device/include", "-I", "support/core/include",
  "src/board_contract.c", "target/platform_stm32g0b1.c", "target/startup_stm32g0b1.s",
  "support/device/templates/system_stm32g0xx.c", "support/freestanding/runtime.c",
  "-T", "target/STM32G0B1CET6.ld",
  "-Wl,--gc-sections", "-Wl,--build-id=none", "-Wl,--no-warn-execstack", "-Wl,--fatal-warnings",
  "-Wl,-Map=build/evleda-stm32g0b1cet6-candidate.map", "-Wl,--print-memory-usage",
  ".toolchain/lib/gcc/arm-none-eabi/14.2.1/thumb/v6-m/nofp/libgcc.a",
  "-o", "build/evleda-stm32g0b1cet6-candidate.elf"
];

export const firmwareTargetObjcopyArguments = (): readonly string[] => [
  "-O", "binary",
  "build/evleda-stm32g0b1cet6-candidate.elf",
  "build/evleda-stm32g0b1cet6-candidate.bin"
];

export interface ArmGnuFirmwareTargetBuildBackendOptions {
  readonly toolchainRoot?: string;
  readonly supportRoot?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly temporaryRoot?: string;
  readonly runner?: BoundedProcessRunner;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

interface SupportManifest {
  readonly schemaVersion: "evleda.stm32g0-cmsis-snapshot.v1";
  readonly device: { readonly repository: string; readonly tag: string; readonly commit: string };
  readonly core: { readonly repository: string; readonly tag: string; readonly commit: string };
  readonly files: readonly { readonly path: string; readonly size: number; readonly sha256: string }[];
}

const configuredValue = (
  environment: Readonly<Record<string, string | undefined>>,
  name: string
): string | undefined => Object.entries(environment).find(
  ([candidate, value]) => value !== undefined && candidate.toUpperCase() === name.toUpperCase()
)?.[1];

const targetEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> => {
  const result: Record<string, string> = {
    LC_ALL: "C",
    LANG: "C",
    LANGUAGE: "C",
    NO_COLOR: "1",
    SOURCE_DATE_EPOCH: "0",
    TEMP: "<workspace>",
    TMP: "<workspace>",
    TMPDIR: "<workspace>",
    // The pinned distribution is specifically the mingw-w64 Windows archive.
    PATH: "<toolchain>/bin;<toolchain>/arm-none-eabi/bin",
  };
  for (const key of ["SystemRoot", "WINDIR"] as const) {
    const value = configuredValue(environment, key);
    if (value !== undefined) result[key] = value;
  }
  return Object.freeze(result);
};

const stableFile = async (
  filePath: string,
  maximumBytes: number,
): Promise<{ readonly path: string; readonly bytes: Buffer; readonly identity: ContentIdentity }> => {
  const first = await lstat(filePath);
  if (
    first.isSymbolicLink() || !first.isFile() || first.size <= 0 ||
    first.size > maximumBytes
  ) {
    throw new Error(`${filePath} is not a non-empty ordinary file.`);
  }
  const canonicalPath = await realpath(filePath);
  const bytes = await readFile(canonicalPath);
  const second = await lstat(canonicalPath);
  if (
    !second.isFile() || bytes.byteLength !== first.size || second.size !== first.size ||
    second.mtimeMs !== first.mtimeMs || second.dev !== first.dev || second.ino !== first.ino
  ) {
    throw new Error(`${filePath} changed while its identity was captured.`);
  }
  return { path: canonicalPath, bytes, identity: contentIdentity(bytes) };
};

const safeRelativePath = (value: string): boolean =>
  value.length > 0 && value.length <= 1024 && !value.includes("\\") &&
  !value.includes("\0") && !value.startsWith("/") && !path.posix.isAbsolute(value) &&
  value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");

const isWithin = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." && !path.isAbsolute(relative);
};

const provisionSupport = async (supportRoot: string): Promise<readonly FirmwareTargetBoundFile[]> => {
  const rootMetadata = await lstat(supportRoot);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error("STM32G0 support root is not an ordinary directory.");
  }
  const canonicalRoot = await realpath(supportRoot);
  const manifestFile = await stableFile(path.join(canonicalRoot, "manifest.json"), 64 * 1024);
  if (
    manifestFile.identity.digest !== STM32G0_SUPPORT_MANIFEST_SHA256 ||
    manifestFile.identity.size !== STM32G0_SUPPORT_MANIFEST_SIZE
  ) throw new Error("Pinned STM32G0 CMSIS manifest identity mismatch.");
  const manifest = JSON.parse(manifestFile.bytes.toString("utf8")) as SupportManifest;
  if (
    manifest.schemaVersion !== "evleda.stm32g0-cmsis-snapshot.v1" ||
    manifest.device.repository !== "https://github.com/STMicroelectronics/cmsis-device-g0.git" ||
    manifest.device.tag !== "v1.4.5" ||
    manifest.device.commit !== "f576c24e123edf3332988ecd49512c0f35f85186" ||
    manifest.core.repository !== "https://github.com/ARM-software/CMSIS_5.git" ||
    manifest.core.tag !== "5.6.0" ||
    manifest.core.commit !== "b5f0603d6a584d1724d952fd8b0737458b90d62b" ||
    !Array.isArray(manifest.files) || manifest.files.length !== 11 ||
    canonicalJson(manifest.files.map((entry) => ({
      relativePath: entry.path,
      identity: { algorithm: "sha256", digest: entry.sha256, size: entry.size },
    }))) !== canonicalJson(STM32G0_SUPPORT_FILE_CLOSURE)
  ) throw new Error("Pinned STM32G0 CMSIS manifest provenance mismatch.");
  const files: FirmwareTargetBoundFile[] = [{
    role: "support_manifest", path: manifestFile.path, relativePath: "manifest.json",
    identity: manifestFile.identity
  }];
  let totalBytes = manifestFile.identity.size;
  for (const entry of manifest.files) {
    if (
      typeof entry.path !== "string" || !safeRelativePath(entry.path) ||
      !Number.isSafeInteger(entry.size) || entry.size <= 0 ||
      entry.size > FIRMWARE_TARGET_RESOURCE_LIMITS.maxSupportFileBytes ||
      !/^[0-9a-f]{64}$/u.test(entry.sha256)
    ) throw new Error("Pinned STM32G0 CMSIS manifest contains an invalid file entry.");
    const file = await stableFile(
      path.join(canonicalRoot, ...entry.path.split("/")),
      FIRMWARE_TARGET_RESOURCE_LIMITS.maxSupportFileBytes,
    );
    if (!isWithin(canonicalRoot, file.path)) {
      throw new Error(`Pinned STM32G0 CMSIS file escapes its support root: ${entry.path}.`);
    }
    if (file.identity.size !== entry.size || file.identity.digest !== entry.sha256) {
      throw new Error(`Pinned STM32G0 CMSIS file identity mismatch: ${entry.path}.`);
    }
    totalBytes += file.identity.size;
    if (totalBytes > FIRMWARE_TARGET_RESOURCE_LIMITS.maxSupportTotalBytes) {
      throw new Error("Pinned STM32G0 CMSIS closure exceeds its aggregate byte limit.");
    }
    files.push({
      role: "support_source", path: file.path, relativePath: entry.path, identity: file.identity
    });
  }
  return files;
};

const provisionToolchain = async (
  root: string | null,
): Promise<{ readonly root: string | null; readonly files: readonly FirmwareTargetBoundFile[] }> => {
  if (root === null) return { root: null, files: [] };
  const rootMetadata = await lstat(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error("EVLEDA_ARM_GCC_ROOT is not an ordinary directory.");
  }
  const canonicalRoot = await realpath(root);
  const files: FirmwareTargetBoundFile[] = [];
  let totalBytes = 0;
  for (const entry of TOOLCHAIN_FILES) {
    const file = await stableFile(
      path.join(canonicalRoot, ...entry.relativePath.split("/")),
      FIRMWARE_TARGET_RESOURCE_LIMITS.maxToolchainFileBytes,
    );
    if (!isWithin(canonicalRoot, file.path)) {
      throw new Error(`Arm GNU toolchain file escapes its configured root: ${entry.relativePath}.`);
    }
    totalBytes += file.identity.size;
    if (totalBytes > FIRMWARE_TARGET_RESOURCE_LIMITS.maxToolchainTotalBytes) {
      throw new Error("Arm GNU toolchain closure exceeds its aggregate byte limit.");
    }
    files.push({
      role: entry.role, path: file.path, relativePath: entry.relativePath, identity: file.identity
    });
  }
  return { root: canonicalRoot, files };
};

const sourcePath = (logicalName: FirmwareTargetSourceLogicalName): string => ({
  "firmware/include/board_contract.h": "include/board_contract.h",
  "firmware/src/board_contract.c": "src/board_contract.c",
  "firmware/target/startup_stm32g0b1.s": "target/startup_stm32g0b1.s",
  "firmware/target/platform_stm32g0b1.c": "target/platform_stm32g0b1.c",
  "firmware/target/STM32G0B1CET6.ld": "target/STM32G0B1CET6.ld"
} satisfies Record<FirmwareTargetSourceLogicalName, string>)[logicalName];

const resultBase = (
  request: FirmwareTargetBuildRequest,
  configurationIdentity: CanonicalIdentity,
  status: FirmwareTargetBuildResult["status"],
  code: string,
  message: string,
  steps: readonly FirmwareTargetBuildStep[],
  toolchainIdentity: CanonicalIdentity | null = null
): FirmwareTargetBuildResult => ({
  schemaVersion: "evleda.firmware-target-build-result.v1",
  sourceRevisionDigest: request.sourceRevisionDigest,
  configurationIdentity,
  status,
  code,
  message,
  backendId: BACKEND_ID,
  targetTriple: status === "unsupported" ? null : "arm-none-eabi",
  gccVersion: null,
  toolchainIdentity,
  compiledSources: request.sources.map((source) => ({ logicalName: source.logicalName, identity: source.identity })),
  steps,
  outputs: [],
  deploymentDisposition: "not-built",
  flashable: false,
  releaseAuthorized: false
});

const normalizeOutput = (value: string, workspace: string): string => value
  .replaceAll(workspace, "<workspace>")
  .replaceAll(workspace.replaceAll("\\", "/"), "<workspace>")
  .replaceAll("\r\n", "\n")
  .replaceAll("\r", "\n");

const toStep = (
  operation: FirmwareTargetBuildStep["operation"],
  commandRole: FirmwareTargetBuildStep["commandRole"],
  commandIdentity: ContentIdentity,
  args: readonly string[],
  result: BoundedProcessResult,
  workspace: string
): FirmwareTargetBuildStep => ({
  operation, commandRole, commandIdentity, arguments: [...args], exitCode: result.exitCode,
  stdout: normalizeOutput(result.stdout, workspace), stderr: normalizeOutput(result.stderr, workspace)
});

const fileForRole = (
  files: readonly FirmwareTargetBoundFile[],
  role: FirmwareTargetToolchainFileRole
): FirmwareTargetBoundFile | undefined => files.find((file) => file.role === role);

interface CapturedBoundFile extends FirmwareTargetBoundFile {
  readonly bytes: Buffer;
}

const snapshotBoundFiles = async (
  files: readonly FirmwareTargetBoundFile[],
): Promise<readonly CapturedBoundFile[]> => {
  const snapshots: CapturedBoundFile[] = [];
  let toolchainBytes = 0;
  for (const expected of files) {
    const maximum = expected.role === "support_manifest" || expected.role === "support_source"
      ? FIRMWARE_TARGET_RESOURCE_LIMITS.maxSupportFileBytes
      : FIRMWARE_TARGET_RESOURCE_LIMITS.maxToolchainFileBytes;
    const actual = await stableFile(expected.path, maximum);
    if (
      actual.identity.digest !== expected.identity.digest ||
      actual.identity.size !== expected.identity.size
    ) throw new Error(`Bound firmware input changed: ${expected.relativePath}.`);
    if (expected.role !== "support_manifest" && expected.role !== "support_source") {
      toolchainBytes += actual.identity.size;
      if (toolchainBytes > FIRMWARE_TARGET_RESOURCE_LIMITS.maxToolchainTotalBytes) {
        throw new Error("Bound Arm GNU toolchain closure exceeds its aggregate byte limit.");
      }
    }
    snapshots.push({ ...expected, bytes: actual.bytes });
  }
  return snapshots;
};

const validateSources = (sources: readonly FirmwareTargetBuildSource[]): boolean => {
  if (sources.length !== FIRMWARE_TARGET_SOURCE_LOGICAL_NAMES.length) return false;
  const names = new Set(sources.map((source) => source.logicalName));
  if (
    names.size !== FIRMWARE_TARGET_SOURCE_LOGICAL_NAMES.length ||
    !FIRMWARE_TARGET_SOURCE_LOGICAL_NAMES.every((name) => names.has(name))
  ) return false;
  let totalBytes = 0;
  return sources.every((source) => {
    const actual = contentIdentity(source.content);
    totalBytes += actual.size;
    return actual.size > 0 && actual.size <= FIRMWARE_TARGET_RESOURCE_LIMITS.maxSourceBytes &&
      totalBytes <= FIRMWARE_TARGET_RESOURCE_LIMITS.maxTotalSourceBytes &&
      actual.digest === source.identity.digest && actual.size === source.identity.size;
  });
};

const materializedEnvironment = (
  configured: Readonly<Record<string, string>>,
  workspace: string,
  privateToolchainRoot: string,
): Readonly<Record<string, string>> => Object.freeze(Object.fromEntries(
  Object.entries(configured).map(([key, value]) => [
    key,
    value.replaceAll("<workspace>", workspace).replaceAll("<toolchain>", privateToolchainRoot),
  ]),
));

const privateFilePath = (root: string, relativePath: string): string =>
  path.join(root, ...relativePath.split("/"));

const writeVerifiedPrivateFile = async (
  destination: string,
  bytes: Uint8Array,
  expected: ContentIdentity,
  executable: boolean,
): Promise<void> => {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, bytes, { flag: "wx", mode: executable ? 0o500 : 0o400 });
  if (process.platform !== "win32") await chmod(destination, executable ? 0o500 : 0o400);
  const copied = await stableFile(
    destination,
    Math.max(FIRMWARE_TARGET_RESOURCE_LIMITS.maxToolchainFileBytes, expected.size),
  );
  if (copied.identity.digest !== expected.digest || copied.identity.size !== expected.size) {
    throw new Error(`Private firmware input copy failed identity verification: ${destination}.`);
  }
};

const deepFreeze = <Value>(value: Value, seen = new WeakSet<object>()): Value => {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
};

class ArmGnuFirmwareTargetBuildBackend implements FirmwareTargetBuildBackend {
  public readonly backendId = BACKEND_ID;
  public readonly configuration: FirmwareTargetBuildBackendConfiguration;
  readonly #configurationIdentity: CanonicalIdentity;
  readonly #runner: BoundedProcessRunner;
  readonly #temporaryRoot: string;

  public constructor(
    configuration: FirmwareTargetBuildBackendConfiguration,
    runner: BoundedProcessRunner,
    temporaryRoot: string
  ) {
    this.configuration = deepFreeze(structuredClone(configuration));
    this.#configurationIdentity = canonicalIdentity(this.configuration, FIRMWARE_TARGET_BUILD_CONFIGURATION_SCHEMA);
    this.#runner = runner;
    this.#temporaryRoot = temporaryRoot;
  }

  public async execute(original: FirmwareTargetBuildRequest): Promise<FirmwareTargetBuildResult> {
    if (
      !Array.isArray(original.sources) ||
      original.sources.length !== FIRMWARE_TARGET_SOURCE_LOGICAL_NAMES.length ||
      original.sources.some((source) =>
        !(source.content instanceof Uint8Array) ||
        source.content.byteLength > FIRMWARE_TARGET_RESOURCE_LIMITS.maxSourceBytes
      ) ||
      original.sources.reduce((total, source) => total + source.content.byteLength, 0) >
        FIRMWARE_TARGET_RESOURCE_LIMITS.maxTotalSourceBytes
    ) {
      return resultBase({
        schemaVersion: "evleda.firmware-target-build-request.v1",
        sourceRevisionDigest: typeof original.sourceRevisionDigest === "string"
          ? original.sourceRevisionDigest
          : "invalid",
        configurationIdentity: this.#configurationIdentity,
        sourceOrigin: "evleda-deterministic-generator",
        sources: [],
      }, this.#configurationIdentity, "fail", "FIRMWARE_TARGET_SOURCE_INVALID", "Target build sources exceed their count or byte limits.", []);
    }
    const request: FirmwareTargetBuildRequest = {
      schemaVersion: original.schemaVersion,
      sourceRevisionDigest: original.sourceRevisionDigest,
      configurationIdentity: structuredClone(original.configurationIdentity),
      sourceOrigin: original.sourceOrigin,
      sources: original.sources.map((source) => ({
        logicalName: source.logicalName,
        identity: structuredClone(source.identity),
        content: Uint8Array.from(source.content)
      }))
    };
    if (
      request.schemaVersion !== "evleda.firmware-target-build-request.v1" ||
      !/^[0-9a-f]{64}$/u.test(request.sourceRevisionDigest) ||
      request.sourceOrigin !== this.configuration.executionPolicy.acceptedSourceOrigin ||
      this.configuration.executionPolicy.agentDerivedOrUntrustedSourceExecution !== "deny" ||
      this.configuration.executionPolicy.osSandbox !== "none" ||
      this.configuration.executionPolicy.containmentClaim !== "not-contained" ||
      this.configuration.executionPolicy.executableStrategy !== "verified-private-toolchain-closure" ||
      this.configuration.executionPolicy.lto !== "disabled" ||
      this.configuration.executionPolicy.linkerPlugin !== "disabled" ||
      canonicalJson(request.configurationIdentity) !== canonicalJson(this.#configurationIdentity)
    ) return resultBase(request, this.#configurationIdentity, "unsupported", "FIRMWARE_TARGET_REQUEST_INVALID", "Target build request is detached from its provisioned configuration or is not classified as deterministic generator output.", []);
    if (!validateSources(request.sources)) {
      return resultBase(request, this.#configurationIdentity, "fail", "FIRMWARE_TARGET_SOURCE_INVALID", "Target build sources are missing, duplicated, empty, or identity-mismatched.", []);
    }
    if (this.configuration.requestedToolchainRoot === null || this.configuration.toolchainFiles.length !== TOOLCHAIN_FILES.length) {
      return resultBase(request, this.#configurationIdentity, "unsupported", "FIRMWARE_TARGET_TOOLCHAIN_NOT_CONFIGURED", "Set EVLEDA_ARM_GCC_ROOT to the absolute portable Arm GNU Toolchain 14.2.Rel1 root.", []);
    }
    if (this.configuration.supportFiles.length !== 12) {
      return resultBase(request, this.#configurationIdentity, "unsupported", "FIRMWARE_TARGET_SUPPORT_UNAVAILABLE", "The exact pinned STM32G0 CMSIS support manifest and all eleven bound files are required.", []);
    }
    if (
      canonicalJson(this.configuration.resourceLimits) !== canonicalJson(FIRMWARE_TARGET_RESOURCE_LIMITS) ||
      canonicalJson(this.configuration.embeddedFiles) !== canonicalJson(FIRMWARE_TARGET_EMBEDDED_FILES) ||
      !this.configuration.compileArguments.includes("-fno-lto") ||
      !this.configuration.compileArguments.includes("-fno-use-linker-plugin") ||
      !this.configuration.compileArguments.includes("-nostdinc") ||
      !this.configuration.compileArguments.includes("-nostdlib")
    ) {
      return resultBase(request, this.#configurationIdentity, "unsupported", "FIRMWARE_TARGET_CLOSURE_POLICY_INVALID", "Target build configuration does not enforce the bounded private toolchain closure and disabled plugin policy.", []);
    }
    const toolchainIdentity = canonicalIdentity({
      distribution: this.configuration.distribution,
      files: this.configuration.toolchainFiles,
      embeddedFiles: this.configuration.embeddedFiles,
      executionPolicy: this.configuration.executionPolicy,
    }, "evleda.arm-gnu-toolchain-identity.v1");
    let capturedToolchain: readonly CapturedBoundFile[];
    let capturedSupport: readonly CapturedBoundFile[];
    try {
      [capturedToolchain, capturedSupport] = await Promise.all([
        snapshotBoundFiles(this.configuration.toolchainFiles),
        snapshotBoundFiles(this.configuration.supportFiles),
      ]);
    } catch {
      return resultBase(request, this.#configurationIdentity, "fail", "FIRMWARE_TARGET_BOUND_INPUT_CHANGED", "A provisioned toolchain or pinned CMSIS file changed, exceeded its byte limit, or became unavailable.", []);
    }
    await mkdir(this.#temporaryRoot, { recursive: true, mode: 0o700 });
    const tempRootMetadata = await lstat(this.#temporaryRoot);
    if (tempRootMetadata.isSymbolicLink() || !tempRootMetadata.isDirectory()) {
      return resultBase(request, this.#configurationIdentity, "unsupported", "FIRMWARE_TARGET_WORK_ROOT_INVALID", "Target build root must be an ordinary private directory.", [], toolchainIdentity);
    }
    const canonicalTemporaryRoot = await realpath(this.#temporaryRoot);
    const workspace = await mkdtemp(path.join(canonicalTemporaryRoot, "evleda-stm32g0-"));
    if (process.platform !== "win32") await chmod(workspace, 0o700);
    const privateToolchainRoot = path.join(workspace, ".toolchain");
    const environment = materializedEnvironment(
      this.configuration.environment,
      workspace,
      privateToolchainRoot,
    );
    const steps: FirmwareTargetBuildStep[] = [];
    const invoke = async (
      operation: FirmwareTargetBuildStep["operation"],
      commandRole: FirmwareTargetBuildStep["commandRole"],
      command: string,
      commandIdentity: ContentIdentity,
      args: readonly string[]
    ): Promise<BoundedProcessResult> => {
      const result = await this.#runner({ command, args, cwd: workspace, env: environment, timeoutMs: this.configuration.timeoutMs, maxOutputBytes: this.configuration.maxOutputBytes });
      steps.push(toStep(operation, commandRole, commandIdentity, args, result, workspace));
      return result;
    };
    try {
      await Promise.all(["include", "src", "target", "build", "support", ".toolchain"].map((name) => mkdir(path.join(workspace, name), { mode: 0o700 })));
      for (const source of request.sources) {
        const destination = path.join(workspace, ...sourcePath(source.logicalName).split("/"));
        await writeVerifiedPrivateFile(destination, source.content, source.identity, false);
      }
      for (const file of capturedSupport.filter((entry) => entry.role === "support_source")) {
        await writeVerifiedPrivateFile(
          privateFilePath(path.join(workspace, "support"), file.relativePath),
          file.bytes,
          file.identity,
          false,
        );
      }
      for (const file of FREESTANDING_HEADERS) {
        await writeVerifiedPrivateFile(
          privateFilePath(workspace, file.logicalPath),
          file.bytes,
          contentIdentity(file.bytes),
          false,
        );
      }
      for (const file of capturedToolchain) {
        await writeVerifiedPrivateFile(
          privateFilePath(privateToolchainRoot, file.relativePath),
          file.bytes,
          file.identity,
          ["gcc", "cc1", "assembler", "collect2", "ld", "objcopy"].includes(file.role),
        );
      }
      const privateTool = (role: FirmwareTargetToolchainFileRole): { readonly path: string; readonly identity: ContentIdentity } => {
        const file = fileForRole(capturedToolchain, role);
        if (file === undefined) throw new Error(`Private toolchain is missing ${role}.`);
        return { path: privateFilePath(privateToolchainRoot, file.relativePath), identity: file.identity };
      };
      const gcc = privateTool("gcc");
      const ld = privateTool("ld");
      const objcopy = privateTool("objcopy");

      const gccVersion = await invoke("gcc_version", "gcc", gcc.path, gcc.identity, ["--version"]);
      const target = await invoke("target_probe", "gcc", gcc.path, gcc.identity, ["-dumpmachine"]);
      const ldVersion = await invoke("ld_version", "ld", ld.path, ld.identity, ["--version"]);
      const objcopyVersion = await invoke("objcopy_version", "objcopy", objcopy.path, objcopy.identity, ["--version"]);
      const versionText = `${gccVersion.stdout}\n${gccVersion.stderr}`;
      if (
        gccVersion.exitCode !== 0 || !versionText.includes("Arm GNU Toolchain 14.2.Rel1") || !/\b14\.2\.1\b/u.test(versionText) ||
        target.exitCode !== 0 || target.stdout.trim() !== "arm-none-eabi" ||
        ldVersion.exitCode !== 0 || !ldVersion.stdout.includes("2.43.1.20241119") ||
        objcopyVersion.exitCode !== 0 || !objcopyVersion.stdout.includes("2.43.1.20241119")
      ) return resultBase(request, this.#configurationIdentity, "unsupported", "FIRMWARE_TARGET_TOOLCHAIN_VERSION_MISMATCH", "Provisioned tools do not identify as the exact supported Arm GNU Toolchain 14.2.Rel1 components.", steps, toolchainIdentity);

      const compile = await invoke("compile_and_link", "gcc", gcc.path, gcc.identity, this.configuration.compileArguments);
      if (compile.exitCode !== 0) return resultBase(request, this.#configurationIdentity, "fail", "FIRMWARE_TARGET_LINK_FAILED", "The exact Cortex-M0+ freestanding compile/link invocation failed.", steps, toolchainIdentity);
      const binary = await invoke("objcopy_binary", "objcopy", objcopy.path, objcopy.identity, this.configuration.objcopyArguments);
      if (binary.exitCode !== 0) return resultBase(request, this.#configurationIdentity, "fail", "FIRMWARE_TARGET_OBJCOPY_FAILED", "The exact linked ELF could not be converted to a candidate binary.", steps, toolchainIdentity);
      const outputs = await Promise.all([
        { kind: "elf" as const, logicalName: ELF_NAME, mediaType: "application/x-elf", path: path.join(workspace, "build", path.basename(ELF_NAME)) },
        { kind: "bin" as const, logicalName: BIN_NAME, mediaType: "application/octet-stream", path: path.join(workspace, "build", path.basename(BIN_NAME)) },
        { kind: "map" as const, logicalName: MAP_NAME, mediaType: "text/plain; charset=utf-8", path: path.join(workspace, "build", path.basename(MAP_NAME)) }
      ].map(async (output) => {
        const maximum = output.kind === "elf"
          ? this.configuration.resourceLimits.maxElfBytes
          : output.kind === "bin"
            ? this.configuration.resourceLimits.maxBinBytes
            : this.configuration.resourceLimits.maxMapBytes;
        const captured = await stableFile(output.path, maximum);
        const bytes = captured.bytes;
        return {
          kind: output.kind,
          logicalName: output.logicalName,
          mediaType: output.mediaType,
          content: Uint8Array.from(bytes),
          identity: contentIdentity(bytes),
        };
      }));
      const privateInputs = [
        ...capturedToolchain.map((file) => ({ path: privateFilePath(privateToolchainRoot, file.relativePath), identity: file.identity })),
        ...capturedSupport.filter((file) => file.role === "support_source").map((file) => ({ path: privateFilePath(path.join(workspace, "support"), file.relativePath), identity: file.identity })),
        ...request.sources.map((source) => ({ path: privateFilePath(workspace, sourcePath(source.logicalName)), identity: source.identity })),
        ...FIRMWARE_TARGET_EMBEDDED_FILES.map((file) => ({ path: privateFilePath(workspace, file.logicalPath), identity: file.identity })),
      ];
      for (const file of privateInputs) {
        const current = await stableFile(file.path, Math.max(FIRMWARE_TARGET_RESOURCE_LIMITS.maxToolchainFileBytes, file.identity.size));
        if (canonicalJson(current.identity) !== canonicalJson(file.identity)) {
          return resultBase(request, this.#configurationIdentity, "fail", "FIRMWARE_TARGET_PRIVATE_INPUT_MUTATED", "A verified private source or toolchain file changed during target compilation.", steps, toolchainIdentity);
        }
      }
      return {
        ...resultBase(request, this.#configurationIdentity, "pass", "FIRMWARE_TARGET_CROSS_BUILD_PASSED", "The exact generated candidate compiled and linked for Cortex-M0+; hardware validation and flash authorization remain absent.", steps, toolchainIdentity),
        gccVersion: ARM_GNU_GCC_VERSION,
        outputs,
        deploymentDisposition: "compiled-non-flashable-candidate"
      };
    } catch (error) {
      return resultBase(request, this.#configurationIdentity, "fail", "FIRMWARE_TARGET_BUILD_INVOCATION_FAILED", error instanceof Error ? error.message : "Target build invocation failed.", steps, toolchainIdentity);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}

export const createArmGnuFirmwareTargetBuildBackend = async (
  options: ArmGnuFirmwareTargetBuildBackendOptions = {}
): Promise<FirmwareTargetBuildBackend> => {
  const rawEnvironment = Object.freeze({ ...(options.environment ?? process.env) });
  const configuredRoot = options.toolchainRoot ?? configuredValue(rawEnvironment, "EVLEDA_ARM_GCC_ROOT");
  const requestedToolchainRoot = configuredRoot === undefined || configuredRoot.trim().length === 0
    ? null
    : path.normalize(configuredRoot);
  const supportRoot = path.resolve(options.supportRoot ?? path.join(process.cwd(), "third_party", "stm32g0-cmsis"));
  const fallbackRoot = requestedToolchainRoot === null ? tmpdir() : path.dirname(requestedToolchainRoot);
  const temporaryRoot = path.resolve(options.temporaryRoot ?? configuredValue(rawEnvironment, "EVLEDA_FIRMWARE_BUILD_ROOT") ?? path.join(fallbackRoot, "evleda-firmware-build"));
  const environment = targetEnvironment(rawEnvironment);
  let toolchainFiles: readonly FirmwareTargetBoundFile[] = [];
  let canonicalToolchainRoot = requestedToolchainRoot;
  let supportFiles: readonly FirmwareTargetBoundFile[] = [];
  if (requestedToolchainRoot !== null && !path.isAbsolute(requestedToolchainRoot)) {
    throw new Error("EVLEDA_ARM_GCC_ROOT must be an absolute path; ambient PATH discovery is unsupported.");
  }
  try { supportFiles = await provisionSupport(supportRoot); } catch { supportFiles = []; }
  try {
    const toolchain = await provisionToolchain(requestedToolchainRoot);
    canonicalToolchainRoot = toolchain.root;
    toolchainFiles = toolchain.files;
  } catch {
    toolchainFiles = [];
  }
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxOutputBytes = options.maxOutputBytes ?? 512 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    throw new Error("Firmware target timeout must be an integer from 1 through 120000 milliseconds.");
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > 1024 * 1024) {
    throw new Error("Firmware target process output limit must be an integer from 1 through 1048576 bytes.");
  }
  const configuration: FirmwareTargetBuildBackendConfiguration = {
    schemaVersion: FIRMWARE_TARGET_BUILD_CONFIGURATION_SCHEMA,
    backendId: BACKEND_ID,
    requestedToolchainRoot: canonicalToolchainRoot,
    supportRoot,
    targetTriple: "arm-none-eabi",
    targetPart: "STM32G0B1CET6",
    cpu: "cortex-m0plus",
    floatAbi: "soft",
    expectedRelease: ARM_GNU_TOOLCHAIN_RELEASE,
    expectedGccVersion: ARM_GNU_GCC_VERSION,
    distribution: { archiveName: ARM_GNU_ARCHIVE_NAME, officialUrl: ARM_GNU_OFFICIAL_URL, sha256: ARM_GNU_ARCHIVE_SHA256 },
    environment,
    environmentIdentity: canonicalIdentity(environment, FIRMWARE_TARGET_BUILD_ENVIRONMENT_SCHEMA),
    executionPolicy: TARGET_EXECUTION_POLICY,
    resourceLimits: FIRMWARE_TARGET_RESOURCE_LIMITS,
    toolchainFiles,
    supportFiles,
    embeddedFiles: FIRMWARE_TARGET_EMBEDDED_FILES,
    compileArguments: firmwareTargetCompileArguments(),
    objcopyArguments: firmwareTargetObjcopyArguments(),
    timeoutMs,
    maxOutputBytes,
    processRunner: "evleda.bounded-process.v1"
  };
  return new ArmGnuFirmwareTargetBuildBackend(configuration, options.runner ?? runBoundedProcess, temporaryRoot);
};
